<?php
/**
 * Overtime (OT) capture from face-recognition attendance.
 *
 * There is no clock-in device: check-in / check-out are the first and last
 * sightings at a clock camera (lib/Attendance.php). OT is therefore an
 * ESTIMATE captured from camera evidence, held as `pending` until a
 * supervisor approves or rejects it.
 *
 * Rule (global defaults in Settings, overridable per shift):
 *   working day  OT = check-out − shift end (only the time after the shift);
 *                with early-start on, also shift start − check-in.
 *                Each part counts only when it is ≥ `min` minutes (checked on
 *                the actual minutes), the total is rounded DOWN to `round`
 *                minutes and capped at `max_h` hours.
 *   rest day     (a day not in the shift's days) the whole first → last
 *                sighting span is OT, ≥ `min`, rounded down, NOT capped.
 *   no OT        OT switched off for the shift; no check-in; no check-out
 *                (flagged `missing_out` once the attendance window closes);
 *                left on time; below the minimum.
 *
 * Persistence (`ot_records`, lib/OvertimeSchema.php) — capture() is
 * idempotent: a pending record follows the latest calculation (and is
 * removed when the day no longer qualifies); a decided record keeps its
 * minutes and status — only `calc_minutes` is refreshed and `changed` set,
 * so a rule change or late sighting never silently rewrites an approval.
 *
 * Approval RBAC = the leave workflow (lib/Leaves.php): supervisor tier decides
 * records of their own department (a supervisor without a department covers
 * everyone), admin tier all; nobody decides their own OT. Staff see only
 * their own records. The employee is told through the in-app bell.
 */

declare(strict_types=1);

/** RBAC denial on a record the caller may see (route maps to 403). */
final class OvertimeForbiddenException extends RuntimeException
{
}

final class Overtime
{
    public const STATUSES = ['pending', 'approved', 'rejected'];
    public const ROUNDS   = [1, 5, 10, 15, 30, 60];
    public const DEFAULTS = ['enabled' => true, 'min' => 30, 'round' => 15, 'max_h' => 6.0, 'early' => false, 'rest' => true];
    /** Sightings stay visible this long after the OT cap is reached (see windowAfterS). */
    private const WINDOW_SLACK_S = 3600;

    private array $defaults;

    public function __construct(private PDO $pdo, array $config = [])
    {
        $this->defaults = $config['attendance']['ot'] ?? self::DEFAULTS;
    }

    // ── Settings ─────────────────────────────────────────────

    /** Global OT defaults from app_settings.json (keys ot_*). */
    public static function configFrom(array $app): array
    {
        $round = (int) ($app['ot_round_minutes'] ?? self::DEFAULTS['round']);
        return [
            'enabled' => ($app['ot_enabled'] ?? true) !== false,
            'min'     => max(0, min(240, (int) ($app['ot_min_minutes'] ?? self::DEFAULTS['min']))),
            'round'   => in_array($round, self::ROUNDS, true) ? $round : self::DEFAULTS['round'],
            'max_h'   => max(0.5, min(16.0, round((float) ($app['ot_max_hours'] ?? self::DEFAULTS['max_h']), 2))),
            'early'   => ($app['ot_early_start'] ?? false) === true,
            'rest'    => ($app['ot_rest_day'] ?? true) !== false,
        ];
    }

    /** POST /settings → the ot_* keys to store (only those supplied). */
    public static function sanitize(array $in): array
    {
        $out = [];
        foreach (['ot_enabled', 'ot_early_start', 'ot_rest_day'] as $k) {
            if (array_key_exists($k, $in)) {
                $out[$k] = filter_var($in[$k], FILTER_VALIDATE_BOOLEAN);
            }
        }
        if (array_key_exists('ot_min_minutes', $in)) {
            $out['ot_min_minutes'] = max(0, min(240, (int) $in['ot_min_minutes']));
        }
        if (array_key_exists('ot_round_minutes', $in)) {
            $r = (int) $in['ot_round_minutes'];
            $out['ot_round_minutes'] = in_array($r, self::ROUNDS, true) ? $r : self::DEFAULTS['round'];
        }
        if (array_key_exists('ot_max_hours', $in)) {
            $out['ot_max_hours'] = max(0.5, min(16.0, round((float) $in['ot_max_hours'], 2)));
        }
        return $out;
    }

    /**
     * Per-shift OT overrides (att_shifts[].ot): only the keys set; a missing
     * key / null / '' means "use the global default".
     */
    public static function shiftOt(mixed $raw): array
    {
        if (!is_array($raw)) {
            return [];
        }
        $out = [];
        foreach (['enabled', 'early', 'rest'] as $k) {
            if (isset($raw[$k]) && $raw[$k] !== '') {
                $out[$k] = filter_var($raw[$k], FILTER_VALIDATE_BOOLEAN);
            }
        }
        if (isset($raw['min']) && $raw['min'] !== '') {
            $out['min'] = max(0, min(240, (int) $raw['min']));
        }
        if (isset($raw['round']) && $raw['round'] !== '' && in_array((int) $raw['round'], self::ROUNDS, true)) {
            $out['round'] = (int) $raw['round'];
        }
        if (isset($raw['max_h']) && $raw['max_h'] !== '') {
            $out['max_h'] = max(0.5, min(16.0, round((float) $raw['max_h'], 2)));
        }
        return $out;
    }

    /** Effective rule for a shift: global defaults overlaid with the shift's overrides. */
    public static function ruleFor(array $shift, ?array $defaults = null): array
    {
        $r = array_merge(self::DEFAULTS, $defaults ?? [], is_array($shift['ot'] ?? null) ? $shift['ot'] : []);
        $r['enabled'] = (bool) $r['enabled'];
        $r['early']   = (bool) $r['early'];
        $r['rest']    = (bool) $r['rest'];
        $r['min']     = max(0, (int) $r['min']);
        $r['round']   = max(1, (int) $r['round']);
        $r['max_h']   = max(0.5, (float) $r['max_h']);
        return $r;
    }

    /** Plain-language statement of the rule HR sees next to every figure. */
    public static function ruleText(array $r): string
    {
        if (empty($r['enabled'])) {
            return 'Overtime capture is off for this shift.';
        }
        $s = 'Time after shift end until check-out' . (!empty($r['early']) ? ' (plus time before shift start)' : '')
           . ' counts from ' . $r['min'] . ' min, rounded down to ' . $r['round'] . ' min, capped at ' . self::fmtMin((int) round($r['max_h'] * 60)) . '.';
        $s .= !empty($r['rest']) ? ' Rest day: first to last sighting counts in full (no cap).' : ' Rest-day work is not counted.';
        return $s;
    }

    /** How long after shift end sightings must stay visible so the cap can be reached. */
    public static function windowAfterS(array $r): int
    {
        return empty($r['enabled']) ? 0 : (int) round($r['max_h'] * 3600) + self::WINDOW_SLACK_S;
    }

    public static function fmtMin(int $m): string
    {
        $m = max(0, $m);
        $h = intdiv($m, 60);
        $r = $m % 60;
        return $h ? ($r ? $h . 'h ' . sprintf('%02d', $r) . 'm' : $h . 'h') : $r . 'm';
    }

    // ── Maths (pure; tested by the scratch suite) ────────────

    /**
     * OT for one employee-day.
     *
     * @param int  $ss, $se     shift start / end timestamps (overnight: $se is next day)
     * @param ?int $inTs, $outTs check-in / check-out timestamps (null = none)
     * @param bool $closed      the day's attendance window has closed
     * @return array{minutes:int, raw:int, early:int, after:int, kind:?string, capped:bool,
     *               reason:?string, explain:string, rule:string, provisional:bool}
     */
    public static function compute(array $rule, bool $scheduled, int $ss, int $se, ?int $inTs, ?int $outTs, bool $closed): array
    {
        $res = ['minutes' => 0, 'raw' => 0, 'early' => 0, 'after' => 0, 'kind' => null, 'capped' => false,
                'reason' => null, 'explain' => '', 'rule' => self::ruleText($rule), 'provisional' => !$closed];
        $hm = static fn (int $t): string => date('H:i', $t);
        if (empty($rule['enabled'])) {
            return ['reason' => 'disabled', 'explain' => 'Overtime capture is off for this shift.'] + $res;
        }
        if ($inTs === null) {
            return ['reason' => 'no_in', 'explain' => 'No check-in.'] + $res;
        }
        if ($outTs === null || $outTs <= $inTs) {
            return $closed
                ? ['reason' => 'missing_out', 'explain' => 'No check-out sighting — OT cannot be captured. Check the clock-out camera.'] + $res
                : ['reason' => 'open', 'explain' => 'No check-out yet.'] + $res;
        }
        $min = (int) $rule['min'];
        $rnd = max(1, (int) $rule['round']);

        if (!$scheduled) {
            if (empty($rule['rest'])) {
                return ['reason' => 'rest_off', 'explain' => 'Rest-day work is not counted as OT for this shift.'] + $res;
            }
            $raw = intdiv($outTs - $inTs, 60);
            $res['raw'] = $raw;
            if ($raw < $min) {
                return ['reason' => 'below_min', 'explain' => 'Rest day ' . $hm($inTs) . '–' . $hm($outTs) . ' = ' . self::fmtMin($raw)
                        . ', below the ' . $min . ' min minimum.'] + $res;
            }
            $m = intdiv($raw, $rnd) * $rnd;
            return ['minutes' => $m, 'kind' => 'rest',
                    'explain' => 'Rest day: ' . $hm($inTs) . ' → ' . $hm($outTs) . ' = ' . self::fmtMin($raw)
                        . ($m !== $raw ? ', rounded down to ' . self::fmtMin($m) : '') . '.'] + $res;
        }

        $after = $outTs > $se ? intdiv($outTs - max($se, $inTs), 60) : 0;
        $early = (!empty($rule['early']) && $inTs < $ss) ? intdiv(min($ss, $outTs) - $inTs, 60) : 0;
        $res['after'] = $after;
        $res['early'] = $early;
        $res['raw']   = $after + $early;
        $cA = $after >= $min && $after > 0 ? $after : 0;
        $cE = $early >= $min && $early > 0 ? $early : 0;
        $parts = [];
        if ($early > 0) {
            $parts[] = 'checked in ' . $hm($inTs) . ', ' . self::fmtMin($early) . ' before the ' . $hm($ss) . ' start' . ($cE ? '' : ' (below ' . $min . ' min, not counted)');
        }
        if ($after > 0) {
            $parts[] = 'checked out ' . $hm($outTs) . ', ' . self::fmtMin($after) . ' after the ' . $hm($se) . ' shift end' . ($cA ? '' : ' (below ' . $min . ' min, not counted)');
        }
        $sum = $cA + $cE;
        if ($sum === 0) {
            return ['reason' => $res['raw'] > 0 ? 'below_min' : 'none',
                    'explain' => $parts ? ucfirst(implode('; ', $parts)) . '.' : 'Left by the ' . $hm($se) . ' shift end — no OT.'] + $res;
        }
        $m   = intdiv($sum, $rnd) * $rnd;
        $cap = (int) round((float) $rule['max_h'] * 60);
        $txt = ucfirst(implode('; ', $parts));
        if ($cA && $cE) {
            $txt .= ' → ' . self::fmtMin($sum) . ' in total';
        }
        if ($m !== $sum) {
            $txt .= ($cA && $cE ? ',' : ' →') . ' rounded down to ' . self::fmtMin($m);
        }
        if ($m > $cap) {
            $m = $cap;
            $res['capped'] = true;
            $txt .= ', capped at ' . self::fmtMin($cap);
        }
        $res['kind'] = $cE && $cA ? 'early+after' : ($cE ? 'early' : 'after');
        return ['minutes' => $m, 'explain' => $txt . '.'] + $res;
    }

    // ── Capture (persist + annotate attendance rows) ─────────

    /**
     * Persist the day's computed OT and add `ot.record` to each row. Never
     * throws: a storage failure must not break the attendance register.
     *
     * @param array $rows Attendance::dayRow() rows (each with an `ot` block)
     */
    public function capture(string $date, array &$rows): void
    {
        try {
            $st = $this->pdo->prepare('SELECT * FROM ot_records WHERE work_date = :d');
            $st->execute(['d' => $date]);
            $have = [];
            foreach ($st->fetchAll() as $r) {
                $have[(string) $r['person_id']] = $r;
            }
            $now = date('Y-m-d H:i:s');
            foreach ($rows as &$row) {
                if (!isset($row['ot']) || !is_array($row['ot'])) {
                    continue;
                }
                $pid = (string) $row['personId'];
                $ot  = $row['ot'];
                $ex  = $have[$pid] ?? null;
                $m   = (int) $ot['minutes'];
                if ($ex === null) {
                    if ($m > 0) {
                        $ex = $this->insert($date, $row, $now);
                    }
                } elseif ($ex['status'] === 'pending') {
                    if ($m > 0) {
                        $set = $this->fields($row);
                        $set['minutes'] = $m;
                        $diff = false;
                        foreach ($set as $k => $v) {
                            if ((string) ($ex[$k] ?? '') !== (string) ($v ?? '')) {
                                $diff = true;
                                break;
                            }
                        }
                        if ($diff) {
                            $this->update((int) $ex['id'], $set + ['updated_at' => $now]);
                            $ex = $set + $ex;
                        }
                    } else {
                        $this->pdo->prepare("DELETE FROM ot_records WHERE id = :id AND status = 'pending'")->execute(['id' => $ex['id']]);
                        $ex = null;
                    }
                } elseif ((int) $ex['calc_minutes'] !== $m) {
                    // Decided: keep minutes/status; record that the evidence now says otherwise.
                    $this->update((int) $ex['id'], ['calc_minutes' => $m, 'changed' => 1, 'updated_at' => $now]);
                    $ex['calc_minutes'] = $m;
                    $ex['changed'] = 1;
                }
                $row['ot']['record'] = $ex ? $this->brief($ex) : null;
            }
            unset($row);
        } catch (Throwable $e) {
            error_log('[overtime] capture ' . $date . ': ' . $e->getMessage());
        }
    }

    /** Columns a capture writes (evidence + calculation). */
    private function fields(array $row): array
    {
        $ot = $row['ot'];
        $ev = $ot['evidence'] ?? [];
        return [
            'name' => mb_substr((string) $row['name'], 0, 120), 'staff_id' => mb_substr((string) $row['staffId'], 0, 64),
            'department' => mb_substr((string) $row['department'], 0, 80), 'plant' => mb_substr((string) $row['plant'], 0, 80),
            'shift_id' => mb_substr((string) ($ot['shiftId'] ?? ''), 0, 40), 'shift_name' => mb_substr((string) $row['shift'], 0, 40),
            'shift_start' => $ot['shiftStartAt'] ?? null, 'shift_end' => $ot['shiftEndAt'] ?? null,
            'kind' => $ot['kind'], 'calc_minutes' => (int) $ot['minutes'], 'raw_minutes' => (int) $ot['raw'],
            'rule_text' => mb_substr((string) $ot['explain'], 0, 255),
            'rule_json' => json_encode($ot['ruleCfg'] ?? []),
            'in_at' => $ev['inAt'] ?? null, 'in_loc' => mb_substr((string) ($ev['inLoc'] ?? ''), 0, 80), 'in_cam' => mb_substr((string) ($ev['inCam'] ?? ''), 0, 64),
            'out_at' => $ev['outAt'] ?? null, 'out_loc' => mb_substr((string) ($ev['outLoc'] ?? ''), 0, 80), 'out_cam' => mb_substr((string) ($ev['outCam'] ?? ''), 0, 64),
        ];
    }

    private function insert(string $date, array $row, string $now): ?array
    {
        $f = $this->fields($row) + ['person_id' => (string) $row['personId'], 'work_date' => $date,
             'minutes' => (int) $row['ot']['minutes'], 'changed' => 0, 'status' => 'pending',
             'created_at' => $now, 'updated_at' => $now];
        $cols = array_keys($f);
        try {
            $this->pdo->prepare('INSERT INTO ot_records (' . implode(', ', $cols) . ') VALUES (:' . implode(', :', $cols) . ')')->execute($f);
        } catch (PDOException $e) {
            // Another request inserted the same person/date first (unique key) — use theirs.
        }
        $st = $this->pdo->prepare('SELECT * FROM ot_records WHERE person_id = :p AND work_date = :d');
        $st->execute(['p' => $f['person_id'], 'd' => $date]);
        return $st->fetch() ?: null;
    }

    private function update(int $id, array $set): void
    {
        $parts = [];
        foreach (array_keys($set) as $k) {
            $parts[] = $k . ' = :' . $k;
        }
        $set['__id'] = $id;
        $this->pdo->prepare('UPDATE ot_records SET ' . implode(', ', $parts) . ' WHERE id = :__id')->execute($set);
    }

    /** The slice of a record the attendance rows carry. */
    private function brief(array $r): array
    {
        return ['id' => (int) $r['id'], 'status' => (string) $r['status'], 'minutes' => (int) $r['minutes'],
                'calcMinutes' => (int) $r['calc_minutes'], 'changed' => (int) ($r['changed'] ?? 0) === 1,
                'decidedBy' => $r['decided_name'] ?? null, 'decidedAt' => $r['decided_at'] ?? null, 'note' => $r['note'] ?? null];
    }

    /** Minutes that count for a row: the decided figure when decided (0 if rejected), else the computed one. */
    public static function effective(array $ot): int
    {
        $rec = $ot['record'] ?? null;
        if (is_array($rec)) {
            return $rec['status'] === 'rejected' ? 0 : (int) $rec['minutes'];
        }
        return (int) ($ot['minutes'] ?? 0);
    }

    // ── Access ───────────────────────────────────────────────

    public static function isApprover(array $p): bool
    {
        require_once __DIR__ . '/AiGuard.php';
        return AiGuard::atLeast($p, 'supervisor');
    }

    public static function isOwn(array $r, array $p): bool
    {
        return ($p['person_id'] ?? null) !== null && (string) $p['person_id'] !== '' && (string) $r['person_id'] === (string) $p['person_id'];
    }

    /** Inside the caller's approval scope (department / all) — same rule as Leaves::inScope. */
    public static function inScope(array $r, array $p): bool
    {
        if (!self::isApprover($p)) {
            return false;
        }
        if ($p['tier'] === 'admin' || (string) ($p['department'] ?? '') === '') {
            return true;
        }
        return (string) ($r['department'] ?? '') === (string) $p['department'];
    }

    public static function canView(array $r, array $p): bool
    {
        return self::isOwn($r, $p) || self::inScope($r, $p);
    }

    public static function canDecide(array $r, array $p): bool
    {
        return (int) $p['id'] > 0 && self::inScope($r, $p) && !self::isOwn($r, $p);
    }

    // ── Queries ──────────────────────────────────────────────

    public function find(int $id): ?array
    {
        $st = $this->pdo->prepare('SELECT * FROM ot_records WHERE id = :id');
        $st->execute(['id' => $id]);
        return $st->fetch() ?: null;
    }

    /**
     * Records in the caller's scope.
     * @param array $f from, to, status (pending|approved|rejected|all), department, plant, q, person_id, limit, offset
     * @return array{records:array, total:int, totals:array, scope:string, can_decide:bool}
     */
    public function list(array $p, array $f = []): array
    {
        $where = [];
        $args  = [];
        $from  = self::date((string) ($f['from'] ?? ''), date('Y-m-01'));
        $to    = self::date((string) ($f['to'] ?? ''), date('Y-m-d'));
        if ($from > $to) {
            [$from, $to] = [$to, $from];
        }
        $where[] = 'work_date >= :f';
        $where[] = 'work_date <= :t';
        $args += ['f' => $from, 't' => $to];

        $scope = 'all';
        if (!self::isApprover($p)) {
            $own = (string) ($p['person_id'] ?? '');
            $where[] = 'person_id = :me';
            $args['me'] = $own !== '' ? $own : "\0none";
            $scope = 'own';
        } else {
            $dept = ($p['tier'] === 'admin' || (string) ($p['department'] ?? '') === '') ? trim((string) ($f['department'] ?? '')) : (string) $p['department'];
            if ($dept !== '') {
                $where[] = 'department = :dept';
                $args['dept'] = $dept;
                $scope = $dept;
            }
            if (!empty($f['person_id'])) {
                $where[] = 'person_id = :pid';
                $args['pid'] = (string) $f['person_id'];
            }
        }
        if (!empty($f['plant'])) {
            $where[] = 'plant = :plant';
            $args['plant'] = (string) $f['plant'];
        }
        if (!empty($f['q'])) {
            $where[] = '(LOWER(name) LIKE :q OR LOWER(staff_id) LIKE :q2)';
            $args['q']  = '%' . mb_strtolower((string) $f['q']) . '%';
            $args['q2'] = $args['q'];
        }
        $sqlWhere = ' WHERE ' . implode(' AND ', $where);

        // Totals across every status (the status filter only narrows the list).
        $tot = ['pending' => ['n' => 0, 'min' => 0], 'approved' => ['n' => 0, 'min' => 0], 'rejected' => ['n' => 0, 'min' => 0]];
        $st  = $this->pdo->prepare('SELECT status, COUNT(*) AS n, SUM(minutes) AS m, COUNT(DISTINCT person_id) AS people FROM ot_records' . $sqlWhere . ' GROUP BY status');
        $st->execute($args);
        foreach ($st->fetchAll() as $r) {
            if (isset($tot[$r['status']])) {
                $tot[$r['status']] = ['n' => (int) $r['n'], 'min' => (int) $r['m']];
            }
        }
        $st = $this->pdo->prepare('SELECT COUNT(DISTINCT person_id) FROM ot_records' . $sqlWhere . " AND status <> 'rejected'");
        $st->execute($args);
        $tot['people'] = (int) $st->fetchColumn();

        $status = (string) ($f['status'] ?? 'all');
        if (in_array($status, self::STATUSES, true)) {
            $sqlWhere .= ' AND status = :st';
            $args['st'] = $status;
        }
        $st = $this->pdo->prepare('SELECT COUNT(*) FROM ot_records' . $sqlWhere);
        $st->execute($args);
        $total = (int) $st->fetchColumn();

        $limit  = max(1, min(1000, (int) ($f['limit'] ?? 200)));
        $offset = max(0, (int) ($f['offset'] ?? 0));
        $st = $this->pdo->prepare('SELECT * FROM ot_records' . $sqlWhere
            . " ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, work_date DESC, name ASC LIMIT " . $limit . ' OFFSET ' . $offset);
        $st->execute($args);
        $rows = array_map(fn ($r) => $this->present($r, $p), $st->fetchAll());

        return ['from' => $from, 'to' => $to, 'records' => $rows, 'total' => $total, 'totals' => $tot,
                'scope' => $scope, 'is_approver' => self::isApprover($p)];
    }

    /** API shape of one record. */
    public function present(array $r, ?array $p = null): array
    {
        $rule = json_decode((string) ($r['rule_json'] ?? ''), true);
        $rule = is_array($rule) ? $rule : [];
        $open = false;
        if ($r['status'] === 'pending' && !empty($r['shift_end'])) {
            $end  = strtotime((string) $r['shift_end']) ?: 0;
            $open = time() < $end + max(14400, self::windowAfterS(self::ruleFor(['ot' => $rule], $this->defaults)));
        }
        return [
            'id' => (int) $r['id'], 'personId' => (string) $r['person_id'], 'date' => substr((string) $r['work_date'], 0, 10),
            'name' => (string) $r['name'], 'staffId' => (string) $r['staff_id'], 'department' => (string) $r['department'],
            'plant' => (string) $r['plant'], 'shift' => (string) $r['shift_name'],
            'shiftStart' => $r['shift_start'] ? substr((string) $r['shift_start'], 11, 5) : '',
            'shiftEnd' => $r['shift_end'] ? substr((string) $r['shift_end'], 11, 5) : '',
            'kind' => $r['kind'], 'minutes' => (int) $r['minutes'], 'calcMinutes' => (int) $r['calc_minutes'],
            'rawMinutes' => (int) $r['raw_minutes'], 'changed' => (int) $r['changed'] === 1,
            'explain' => (string) $r['rule_text'], 'rule' => self::ruleText(self::ruleFor(['ot' => $rule], $this->defaults)),
            'inAt' => $r['in_at'], 'inLoc' => (string) $r['in_loc'], 'inCam' => (string) $r['in_cam'],
            'outAt' => $r['out_at'], 'outLoc' => (string) $r['out_loc'], 'outCam' => (string) $r['out_cam'],
            'status' => (string) $r['status'], 'decidedBy' => $r['decided_name'], 'decidedAt' => $r['decided_at'],
            'note' => $r['note'], 'provisional' => $open,
            'canDecide' => $p !== null && self::canDecide($r, $p),
        ];
    }

    // ── Decisions ────────────────────────────────────────────

    public function approve(array $r, array $p, string $note = '', ?int $minutes = null): array
    {
        $this->assertDecider($r, $p, ['pending']);
        $note = mb_substr(trim($note), 0, 1000);
        $m = $minutes ?? (int) $r['calc_minutes'];
        if ($m < 1 || $m > 24 * 60) {
            throw new InvalidArgumentException('Approved minutes must be between 1 and 1440.');
        }
        if ($m !== (int) $r['calc_minutes'] && mb_strlen($note) < 3) {
            throw new InvalidArgumentException('Add a note (at least 3 characters) when approving a different figure than captured.');
        }
        $this->decide($r, $p, 'approved', $note, $m);
        $r = $this->find((int) $r['id']);
        $this->notifyEmployee($r, 'ot_approved', 'Your overtime on ' . self::fmtDate((string) $r['work_date']) . ' was approved',
            self::fmtMin((int) $r['minutes']) . ' · by ' . $p['name'] . ($note !== '' ? ' — ' . mb_substr($note, 0, 140) : ''));
        return $r;
    }

    public function reject(array $r, array $p, string $note): array
    {
        $this->assertDecider($r, $p, ['pending']);
        $note = mb_substr(trim($note), 0, 1000);
        if (mb_strlen($note) < 3) {
            throw new InvalidArgumentException('A reason (at least 3 characters) is required to reject overtime.');
        }
        $this->decide($r, $p, 'rejected', $note, (int) $r['minutes']);
        $r = $this->find((int) $r['id']);
        $this->notifyEmployee($r, 'ot_rejected', 'Your overtime on ' . self::fmtDate((string) $r['work_date']) . ' was rejected',
            self::fmtMin((int) $r['calc_minutes']) . ' captured · by ' . $p['name'] . ' — ' . mb_substr($note, 0, 160));
        return $r;
    }

    /** Decided → pending again, minutes back to the latest captured figure. */
    public function reopen(array $r, array $p): array
    {
        $this->assertDecider($r, $p, ['approved', 'rejected']);
        $st = $this->pdo->prepare("UPDATE ot_records SET status = 'pending', minutes = calc_minutes, changed = 0, decided_by = NULL,
                                   decided_name = NULL, decided_at = NULL, note = NULL, updated_at = :n WHERE id = :id AND status = :s");
        $st->execute(['n' => date('Y-m-d H:i:s'), 'id' => $r['id'], 's' => $r['status']]);
        if ($st->rowCount() !== 1) {
            throw new DomainException('This record changed meanwhile — reload and try again.');
        }
        return $this->find((int) $r['id']);
    }

    private function decide(array $r, array $p, string $status, string $note, int $minutes): void
    {
        $now = date('Y-m-d H:i:s');
        $st  = $this->pdo->prepare("UPDATE ot_records SET status = :s, minutes = :m, changed = 0, decided_by = :u, decided_name = :un,
                                    decided_at = :n, note = :note, updated_at = :n2 WHERE id = :id AND status = 'pending'");
        $st->execute(['s' => $status, 'm' => $minutes, 'u' => (int) $p['id'], 'un' => $p['name'], 'n' => $now,
                      'note' => $note !== '' ? $note : null, 'n2' => $now, 'id' => $r['id']]);
        if ($st->rowCount() !== 1) {
            throw new DomainException('This overtime record is no longer pending.');
        }
    }

    private function assertDecider(array $r, array $p, array $from): void
    {
        if (self::isOwn($r, $p)) {
            throw new OvertimeForbiddenException('You cannot approve or reject your own overtime.');
        }
        if (!self::canDecide($r, $p)) {
            throw new OvertimeForbiddenException('Only a supervisor of this department or an admin can decide this overtime.');
        }
        if (!in_array($r['status'], $from, true)) {
            throw new DomainException('This overtime record is ' . $r['status'] . '.');
        }
    }

    /** Active logins linked to the record's employee (users.person_id, else username = staff ID). */
    public function userIdsFor(array $r): array
    {
        try {
            $st = $this->pdo->prepare("SELECT id FROM users WHERE active = 1 AND (person_id = :p
                                        OR ((person_id IS NULL OR person_id = '') AND username = :s AND :s2 <> ''))");
            $st->execute(['p' => (string) $r['person_id'], 's' => (string) $r['staff_id'], 's2' => (string) $r['staff_id']]);
            return array_map('intval', $st->fetchAll(PDO::FETCH_COLUMN));
        } catch (Throwable $e) {
            return [];
        }
    }

    private function notifyEmployee(array $r, string $kind, string $title, string $body): void
    {
        $ids = $this->userIdsFor($r);
        if (!$ids) {
            return;
        }
        require_once __DIR__ . '/Notifications.php';
        Notifications::emit($this->pdo, $ids, $kind, $title, $body, '#app-attendance', 'ot', (int) $r['id']);
        try {
            require_once __DIR__ . '/NotifyMail.php';
            NotifyMail::mirror($this->pdo, $ids, $kind, $title, $body, '#app-attendance');
        } catch (Throwable $e) {
            error_log('[overtime] mail mirror: ' . $e->getMessage());
        }
    }

    // ── Helpers ──────────────────────────────────────────────

    public static function date(string $v, string $fallback): string
    {
        $d = DateTimeImmutable::createFromFormat('!Y-m-d', $v);
        return $d && $d->format('Y-m-d') === $v ? $v : $fallback;
    }

    private static function fmtDate(string $d): string
    {
        $t = strtotime(substr($d, 0, 10));
        return $t ? date('j M Y', $t) : $d;
    }
}
