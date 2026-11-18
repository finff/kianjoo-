<?php
/**
 * Cleaning time by physical button.
 *
 * On the factory floor a cleaning session is timed by a button at the area:
 * the employee presses it when cleaning starts and presses it again when
 * cleaning ends. The session's time frame is exactly those two presses — not
 * the schedule (lib/Cleaning.php) and not what the cameras saw.
 *
 * This class is the integration surface for that button (any device that can
 * make an HTTP request: ESP32 / PLC gateway / Android panel). It stores
 *
 *   cleaning_buttons           one row per device (auto-registered on first press)
 *   cleaning_button_sessions   one row per start→end pair
 *
 * Rules:
 *   • "toggle" (the default) starts a session when the button is idle and ends
 *     the open one when it is cleaning. "start" / "end" are explicit and
 *     idempotent, for devices with two buttons or a latching switch.
 *   • Presses within DEBOUNCE seconds of the previous one are ignored (switch
 *     bounce, double tap, device retry) and answer with the current state.
 *   • A session left open longer than MAX_OPEN is closed as "auto_closed"
 *     (someone forgot the second press) so it is never counted as real time.
 *   • A device may send its own press time (`ts`) when it buffers presses
 *     offline; it is accepted only within CLOCK_SKEW of server time.
 *
 * Routes: lib/CleaningButtonRoutes.php. Device guide: docs/INTEGRATION_API.md.
 */

declare(strict_types=1);

final class CleaningButton
{
    public const VERSION    = '1';
    public const DEBOUNCE   = 3;            // s — ignore repeat presses
    public const MAX_OPEN   = 12 * 3600;    // s — forgotten "end" press
    public const CLOCK_SKEW = 24 * 3600;    // s — how far a device ts may be from server time
    public const ACTIONS    = ['toggle', 'start', 'end'];
    public const STATUSES   = ['open', 'closed', 'auto_closed', 'cancelled'];

    private PDO $pdo;
    private bool $sqlite;

    public function __construct(PDO $pdo, string $driver, ?string $storageDir = null)
    {
        $this->pdo    = $pdo;
        $this->sqlite = $driver === 'sqlite';
        self::migrate($pdo, $driver, $storageDir);
    }

    // ── Schema ───────────────────────────────────────────────

    public static function migrate(PDO $pdo, string $driver, ?string $storageDir = null, bool $force = false): void
    {
        $sq     = $driver === 'sqlite';
        $marker = $storageDir ? rtrim($storageDir, '/\\') . '/cleaning_button_schema.ver' : null;
        $tag    = self::VERSION . ':' . $driver;
        if (!$force && $marker && is_file($marker) && trim((string) @file_get_contents($marker)) === $tag) {
            return;
        }
        if ($sq) {
            $pdo->exec('CREATE TABLE IF NOT EXISTS cleaning_buttons (
                button_id     TEXT PRIMARY KEY,
                name          TEXT,
                location      TEXT,
                enabled       INTEGER DEFAULT 1,
                last_press_at TEXT,
                created_at    TEXT,
                updated_at    TEXT
            )');
            $pdo->exec('CREATE TABLE IF NOT EXISTS cleaning_button_sessions (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                button_id    TEXT NOT NULL,
                location     TEXT,
                started_at   TEXT NOT NULL,
                ended_at     TEXT,
                duration_s   INTEGER,
                status       TEXT DEFAULT \'open\',
                started_by   TEXT,
                ended_by     TEXT,
                note         TEXT,
                created_at   TEXT,
                updated_at   TEXT
            )');
            $pdo->exec('CREATE INDEX IF NOT EXISTS idx_cbs_button ON cleaning_button_sessions(button_id, status)');
            $pdo->exec('CREATE INDEX IF NOT EXISTS idx_cbs_start  ON cleaning_button_sessions(started_at)');
        } else {
            $pdo->exec('CREATE TABLE IF NOT EXISTS cleaning_buttons (
                button_id     VARCHAR(64) NOT NULL PRIMARY KEY,
                name          VARCHAR(120) NULL,
                location      VARCHAR(120) NULL,
                enabled       TINYINT(1) DEFAULT 1,
                last_press_at DATETIME NULL,
                created_at    DATETIME NULL,
                updated_at    DATETIME NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
            $pdo->exec('CREATE TABLE IF NOT EXISTS cleaning_button_sessions (
                id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                button_id    VARCHAR(64) NOT NULL,
                location     VARCHAR(120) NULL,
                started_at   DATETIME NOT NULL,
                ended_at     DATETIME NULL,
                duration_s   INT NULL,
                status       VARCHAR(20) DEFAULT \'open\',
                started_by   VARCHAR(64) NULL,
                ended_by     VARCHAR(64) NULL,
                note         VARCHAR(255) NULL,
                created_at   DATETIME NULL,
                updated_at   DATETIME NULL,
                KEY idx_cbs_button (button_id, status),
                KEY idx_cbs_start (started_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
        }
        if ($marker) {
            @file_put_contents($marker, $tag, LOCK_EX);
        }
    }

    // ── Input cleaning ───────────────────────────────────────

    /** Device id: letters, digits and . _ : - (max 64). '' when unusable. */
    public static function cleanId($v): string
    {
        $v = trim((string) $v);
        return preg_match('/^[A-Za-z0-9._:\-]{1,64}$/', $v) ? $v : '';
    }

    private static function text($v, int $max): string
    {
        $v = trim(preg_replace('/[\x00-\x1F\x7F]+/', ' ', (string) $v) ?? '');
        return function_exists('mb_substr') ? mb_substr($v, 0, $max) : substr($v, 0, $max);
    }

    /**
     * Press time: the device's `ts` (unix seconds / milliseconds, or a date
     * string) when it is plausible, otherwise server time.
     */
    public static function pressTime($ts, int $now): int
    {
        if ($ts === null || $ts === '') {
            return $now;
        }
        if (is_numeric($ts)) {
            $t = (float) $ts;
            $t = (int) ($t > 20000000000 ? $t / 1000 : $t);   // milliseconds → seconds
        } else {
            $t = strtotime((string) $ts) ?: 0;
        }
        return ($t > 0 && abs($t - $now) <= self::CLOCK_SKEW && $t <= $now + 300) ? $t : $now;
    }

    // ── Press ────────────────────────────────────────────────

    /**
     * Handle one button press.
     *
     * @param array $o action (toggle|start|end), employee_id, ts, location, name
     * @return array{ok:bool, result:string, state:string, button:array, session:?array, message:string}
     *         result: started | ended | ignored | already_started | not_started | disabled
     */
    public function press(string $buttonId, array $o = [], ?int $now = null): array
    {
        $now    = $now ?? time();
        $action = in_array($o['action'] ?? 'toggle', self::ACTIONS, true) ? (string) ($o['action'] ?? 'toggle') : 'toggle';
        $who    = self::text($o['employee_id'] ?? '', 64);
        $at     = self::pressTime($o['ts'] ?? null, $now);
        $stamp  = date('Y-m-d H:i:s', $now);

        $this->pdo->beginTransaction();
        try {
            $btn = $this->button($buttonId, true);
            if ($btn === null) {
                $this->pdo->prepare('INSERT INTO cleaning_buttons (button_id, name, location, enabled, created_at, updated_at)
                                     VALUES (:id, :n, :l, 1, :t, :t2)')
                    ->execute(['id' => $buttonId, 'n' => self::text($o['name'] ?? '', 120) ?: null,
                               'l' => self::text($o['location'] ?? '', 120) ?: null, 't' => $stamp, 't2' => $stamp]);
                $btn = $this->button($buttonId, true);
            } elseif (($btn['location'] ?? '') === '' && self::text($o['location'] ?? '', 120) !== '') {
                // First time the device tells us where it is: remember it.
                $this->pdo->prepare('UPDATE cleaning_buttons SET location = :l, updated_at = :t WHERE button_id = :id')
                    ->execute(['l' => self::text($o['location'], 120), 't' => $stamp, 'id' => $buttonId]);
                $btn['location'] = self::text($o['location'], 120);
            }

            if (empty($btn['enabled'])) {
                $this->pdo->commit();
                return $this->answer(false, 'disabled', $btn, $this->openSession($buttonId), 'This button is switched off.');
            }

            $open = $this->expire($this->openSession($buttonId), $now);

            // Bounce / double tap / device retry: answer with the current state, change nothing.
            $last = $btn['last_press_at'] ? (strtotime((string) $btn['last_press_at']) ?: 0) : 0;
            if ($last > 0 && abs($at - $last) < self::DEBOUNCE) {
                $this->pdo->commit();
                return $this->answer(true, 'ignored', $btn, $open, 'Repeat press ignored.');
            }

            if ($action === 'toggle') {
                $action = $open ? 'end' : 'start';
            }
            if ($action === 'start' && $open) {
                $this->pdo->commit();
                return $this->answer(true, 'already_started', $btn, $open, 'Cleaning is already in progress.');
            }
            if ($action === 'end' && !$open) {
                $this->pdo->commit();
                return $this->answer(false, 'not_started', $btn, null, 'No cleaning session is in progress for this button.');
            }

            $this->pdo->prepare('UPDATE cleaning_buttons SET last_press_at = :p, updated_at = :t WHERE button_id = :id')
                ->execute(['p' => date('Y-m-d H:i:s', $at), 't' => $stamp, 'id' => $buttonId]);
            $btn['last_press_at'] = date('Y-m-d H:i:s', $at);

            if ($action === 'start') {
                $this->pdo->prepare('INSERT INTO cleaning_button_sessions
                        (button_id, location, started_at, status, started_by, created_at, updated_at)
                     VALUES (:b, :l, :s, \'open\', :w, :t, :t2)')
                    ->execute(['b' => $buttonId, 'l' => ($btn['location'] ?? '') !== '' ? $btn['location'] : null,
                               's' => date('Y-m-d H:i:s', $at), 'w' => $who !== '' ? $who : null, 't' => $stamp, 't2' => $stamp]);
                $session = $this->session((int) $this->pdo->lastInsertId());
                $this->pdo->commit();
                return $this->answer(true, 'started', $btn, $session, 'Cleaning started.');
            }

            // end
            $start = strtotime((string) $open['started_at']) ?: $at;
            $end   = max($at, $start);                       // a late-arriving buffered press never runs backwards
            $this->pdo->prepare('UPDATE cleaning_button_sessions
                                    SET ended_at = :e, duration_s = :d, status = \'closed\', ended_by = :w, updated_at = :t
                                  WHERE id = :id AND status = \'open\'')
                ->execute(['e' => date('Y-m-d H:i:s', $end), 'd' => $end - $start, 'w' => $who !== '' ? $who : null,
                           't' => $stamp, 'id' => $open['id']]);
            $session = $this->session((int) $open['id']);
            $this->pdo->commit();
            return $this->answer(true, 'ended', $btn, $session, 'Cleaning ended.');
        } catch (Throwable $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw $e;
        }
    }

    /** Current state of one button (for the device's LED / display). */
    public function status(string $buttonId, ?int $now = null): array
    {
        $btn = $this->button($buttonId);
        if ($btn === null) {
            return ['ok' => true, 'result' => 'unknown', 'state' => 'idle', 'button' => null, 'session' => null,
                    'message' => 'This button has not been pressed yet.'];
        }
        return $this->answer(true, 'status', $btn, $this->expire($this->openSession($buttonId), $now ?? time()), '');
    }

    // ── Buttons ──────────────────────────────────────────────

    /** @return array<int, array> every registered button with its current state */
    public function buttons(?int $now = null): array
    {
        $now  = $now ?? time();
        $rows = $this->pdo->query('SELECT * FROM cleaning_buttons ORDER BY location, button_id')->fetchAll(PDO::FETCH_ASSOC);
        return array_map(function (array $b) use ($now): array {
            $open = $this->expire($this->openSession((string) $b['button_id']), $now);
            return self::buttonView($b) + ['state' => $open ? 'cleaning' : 'idle', 'session' => $open ? self::sessionView($open, $now) : null];
        }, $rows);
    }

    /** Create or update a button's name / location / enabled flag. */
    public function saveButton(string $buttonId, array $in): array
    {
        $stamp = date('Y-m-d H:i:s');
        $cur   = $this->button($buttonId);
        $name  = array_key_exists('name', $in) ? self::text($in['name'], 120) : (string) ($cur['name'] ?? '');
        $loc   = array_key_exists('location', $in) ? self::text($in['location'], 120) : (string) ($cur['location'] ?? '');
        $on    = array_key_exists('enabled', $in)
            ? (int) !in_array($in['enabled'], [0, '0', false, 'false', 'off', ''], true)
            : (int) ($cur['enabled'] ?? 1);
        if ($cur === null) {
            $this->pdo->prepare('INSERT INTO cleaning_buttons (button_id, name, location, enabled, created_at, updated_at)
                                 VALUES (:id, :n, :l, :e, :t, :t2)')
                ->execute(['id' => $buttonId, 'n' => $name ?: null, 'l' => $loc ?: null, 'e' => $on, 't' => $stamp, 't2' => $stamp]);
        } else {
            $this->pdo->prepare('UPDATE cleaning_buttons SET name = :n, location = :l, enabled = :e, updated_at = :t WHERE button_id = :id')
                ->execute(['n' => $name ?: null, 'l' => $loc ?: null, 'e' => $on, 't' => $stamp, 'id' => $buttonId]);
        }
        return self::buttonView((array) $this->button($buttonId));
    }

    // ── Sessions ─────────────────────────────────────────────

    /**
     * Sessions that started in [from, to] (Y-m-d), newest first.
     *
     * @param array $f from, to, button_id, location, status, limit, offset
     * @return array{sessions: array, total: int, totals: array}
     */
    public function sessions(array $f, ?int $now = null): array
    {
        $now  = $now ?? time();
        $from = self::day($f['from'] ?? '', date('Y-m-d', $now - 6 * 86400));
        $to   = self::day($f['to'] ?? '', date('Y-m-d', $now));
        if ($to < $from) {
            [$from, $to] = [$to, $from];
        }
        $where = ['started_at >= :f', 'started_at <= :t'];
        $args  = ['f' => $from . ' 00:00:00', 't' => $to . ' 23:59:59'];
        if (($b = self::cleanId($f['button_id'] ?? '')) !== '') {
            $where[] = 'button_id = :b';
            $args['b'] = $b;
        }
        if (($l = self::text($f['location'] ?? '', 120)) !== '') {
            $where[] = 'location = :l';
            $args['l'] = $l;
        }
        if (in_array($f['status'] ?? '', self::STATUSES, true)) {
            $where[] = 'status = :s';
            $args['s'] = $f['status'];
        }
        $w     = implode(' AND ', $where);
        $limit = max(1, min(500, (int) ($f['limit'] ?? 100)));
        $off   = max(0, (int) ($f['offset'] ?? 0));

        $st = $this->pdo->prepare("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN status = 'closed' THEN duration_s ELSE 0 END), 0) secs,
                                          SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) closed,
                                          SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) open_n,
                                          SUM(CASE WHEN status = 'auto_closed' THEN 1 ELSE 0 END) auto_n
                                     FROM cleaning_button_sessions WHERE $w");
        $st->execute($args);
        $tot = $st->fetch(PDO::FETCH_ASSOC) ?: [];

        $st = $this->pdo->prepare("SELECT * FROM cleaning_button_sessions WHERE $w ORDER BY started_at DESC, id DESC LIMIT $limit OFFSET $off");
        $st->execute($args);
        $rows = array_map(static fn (array $r): array => self::sessionView($r, $now), $st->fetchAll(PDO::FETCH_ASSOC));

        $closed = (int) ($tot['closed'] ?? 0);
        $secs   = (int) ($tot['secs'] ?? 0);
        return [
            'from' => $from, 'to' => $to, 'total' => (int) ($tot['n'] ?? 0), 'sessions' => $rows,
            'totals' => ['completed' => $closed, 'in_progress' => (int) ($tot['open_n'] ?? 0),
                         'auto_closed' => (int) ($tot['auto_n'] ?? 0), 'cleaning_seconds' => $secs,
                         'average_seconds' => $closed ? (int) round($secs / $closed) : 0],
        ];
    }

    // ── Internals ────────────────────────────────────────────

    private static function day($v, string $fallback): string
    {
        $v = (string) $v;
        return preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) && strtotime($v) ? $v : $fallback;
    }

    private function button(string $id, bool $lock = false): ?array
    {
        $st = $this->pdo->prepare('SELECT * FROM cleaning_buttons WHERE button_id = :id' . ($lock && !$this->sqlite ? ' FOR UPDATE' : ''));
        $st->execute(['id' => $id]);
        $r = $st->fetch(PDO::FETCH_ASSOC);
        return $r ?: null;
    }

    private function session(int $id): ?array
    {
        $st = $this->pdo->prepare('SELECT * FROM cleaning_button_sessions WHERE id = :id');
        $st->execute(['id' => $id]);
        $r = $st->fetch(PDO::FETCH_ASSOC);
        return $r ?: null;
    }

    private function openSession(string $buttonId): ?array
    {
        $st = $this->pdo->prepare("SELECT * FROM cleaning_button_sessions WHERE button_id = :b AND status = 'open' ORDER BY id DESC LIMIT 1");
        $st->execute(['b' => $buttonId]);
        $r = $st->fetch(PDO::FETCH_ASSOC);
        return $r ?: null;
    }

    /** Close a session nobody ended; returns the still-open session or null. */
    private function expire(?array $open, int $now): ?array
    {
        if ($open === null) {
            return null;
        }
        $start = strtotime((string) $open['started_at']) ?: $now;
        if ($now - $start <= self::MAX_OPEN) {
            return $open;
        }
        $this->pdo->prepare("UPDATE cleaning_button_sessions
                                SET status = 'auto_closed', note = :n, updated_at = :t
                              WHERE id = :id AND status = 'open'")
            ->execute(['n' => 'No end press within ' . (int) (self::MAX_OPEN / 3600) . ' h — end time unknown',
                       't' => date('Y-m-d H:i:s', $now), 'id' => $open['id']]);
        return null;
    }

    private function answer(bool $ok, string $result, array $btn, ?array $session, string $message): array
    {
        $cleaning = $session !== null && ($session['status'] ?? '') === 'open';
        return ['ok' => $ok, 'result' => $result, 'state' => $cleaning ? 'cleaning' : 'idle',
                'button' => self::buttonView($btn), 'session' => $session ? self::sessionView($session, time()) : null,
                'message' => $message];
    }

    private static function buttonView(array $b): array
    {
        return ['button_id' => (string) $b['button_id'], 'name' => (string) ($b['name'] ?? ''),
                'location' => (string) ($b['location'] ?? ''), 'enabled' => !empty($b['enabled']),
                'last_press_at' => $b['last_press_at'] ?? null];
    }

    private static function sessionView(array $s, int $now): array
    {
        $open  = ($s['status'] ?? '') === 'open';
        $start = strtotime((string) $s['started_at']) ?: $now;
        return ['id' => (int) $s['id'], 'button_id' => (string) $s['button_id'], 'location' => (string) ($s['location'] ?? ''),
                'started_at' => (string) $s['started_at'], 'ended_at' => $s['ended_at'] ?? null,
                'duration_s' => $s['duration_s'] !== null ? (int) $s['duration_s'] : null,
                'elapsed_s' => $open ? max(0, $now - $start) : null,
                'status' => (string) ($s['status'] ?? 'open'),
                'started_by' => (string) ($s['started_by'] ?? ''), 'ended_by' => (string) ($s['ended_by'] ?? ''),
                'note' => (string) ($s['note'] ?? '')];
    }
}
