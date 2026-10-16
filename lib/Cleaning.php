<?php
/**
 * Cleaning activity monitoring (POC Use Case 4).
 *
 * A cleaning schedule says WHEN cleaning is expected at an area and WHICH
 * PPE is required while it runs (gloves by default). During a scheduled
 * window, every person detected at the area is PPE-checked against the
 * area rule plus the schedule's items (see Ppe::requirement), and those
 * checks carry the schedule — a miss becomes a "PPE violation during
 * cleaning" incident and alert.
 *
 * A schedule is NOT evidence that cleaning happened, and the PPE model
 * cannot recognise cleaning. Each session therefore reports three things
 * separately:
 *   scheduled  the window from the schedule (upcoming / in progress / ended)
 *   observed   people actually detected at the area's cameras in the window
 *   confirmed  a supervisor's "cleaning done" / "not performed" record
 * Recognising cleaning itself would need an action-recognition capability
 * (cleaning-tool detection or pose/action classification) — not in SenseStudio
 * today.
 */

declare(strict_types=1);

require_once __DIR__ . '/EventStore.php';
require_once __DIR__ . '/Attendance.php';

final class Cleaning
{
    private PDO $pdo;
    private array $config;
    private EventStore $store;

    public function __construct(PDO $pdo, array $config, EventStore $store)
    {
        $this->pdo    = $pdo;
        $this->config = $config;
        $this->store  = $store;
    }

    // ── Schedule maths (pure) ────────────────────────────────

    /** Does the schedule have a session starting on $date (Y-m-d)? */
    public static function occursOn(array $s, string $date): bool
    {
        if (empty($s['enabled'])) {
            return false;
        }
        if (!empty($s['dates'])) {
            return in_array($date, $s['dates'], true);
        }
        return in_array((int) date('N', strtotime($date)), $s['days'] ?? [], true);
    }

    /** [start, end] timestamps of the session starting on $date (overnight-aware). */
    public static function window(array $s, string $date): array
    {
        $a = strtotime($date . ' ' . $s['start'] . ':00');
        $b = strtotime($date . ' ' . $s['end'] . ':00');
        return [$a, $b <= $a ? $b + 86400 : $b];
    }

    /** Schedules at $location whose session covers $ts (yesterday's overnight session included). */
    public static function activeAt(string $location, int $ts, array $schedules): array
    {
        $out = [];
        foreach ($schedules as $s) {
            if ($s['location'] !== $location) {
                continue;
            }
            foreach ([date('Y-m-d', $ts), date('Y-m-d', $ts - 86400)] as $d) {
                if (self::occursOn($s, $d)) {
                    [$a, $b] = self::window($s, $d);
                    if ($ts >= $a && $ts < $b) {
                        $out[] = $s + ['session_date' => $d];
                        break;
                    }
                }
            }
        }
        return $out;
    }

    // ── Sessions ─────────────────────────────────────────────

    /**
     * Every scheduled session in [from, to] with its observed activity, PPE
     * results and confirmation.
     */
    public function sessions(array $f): array
    {
        $from = Attendance::cleanDate((string) ($f['from'] ?? ''));
        $to   = Attendance::cleanDate((string) ($f['to'] ?? $from));
        if ($to < $from) {
            [$from, $to] = [$to, $from];
        }
        $att  = new Attendance($this->store, $this->config);
        $cams = [];   // location → stream keys mapped to it
        foreach ($this->config['poc']['cam_locations'] ?? [] as $k => $loc) {
            $cams[$loc][] = $k;
        }
        $conf = [];
        foreach ($this->pdo->query('SELECT * FROM cleaning_log ORDER BY id ASC')->fetchAll() as $c) {
            $conf[$c['schedule_id'] . '|' . substr((string) $c['session_date'], 0, 10)] = $c;   // latest wins
        }
        $obs = $this->pdo->prepare('SELECT COUNT(*) FROM events WHERE stream = :s AND received_at >= :a AND received_at < :b');
        $chk = $this->pdo->prepare("SELECT COUNT(*) c, SUM(CASE WHEN missing <> '' THEN 1 ELSE 0 END) v
                                      FROM ppe_checks WHERE schedule_id = :id AND checked_at >= :a AND checked_at < :b");

        $now = time();
        $out = [];
        for ($d = strtotime($from); $d <= strtotime($to) && count($out) < 2000; $d += 86400) {
            $date = date('Y-m-d', $d);
            foreach ($this->config['cleaning']['schedules'] ?? [] as $s) {
                if (!self::occursOn($s, $date)) {
                    continue;
                }
                $plant = $att->plantOf($s['location']);
                if ((!empty($f['plant']) && $plant !== $f['plant']) || (!empty($f['location']) && $s['location'] !== $f['location'])) {
                    continue;
                }
                [$a, $b] = self::window($s, $date);
                $ta = date('Y-m-d H:i:s', $a);
                $tb = date('Y-m-d H:i:s', $b);
                $seen = 0;
                foreach ($cams[$s['location']] ?? [] as $k) {
                    $obs->execute(['s' => $k, 'a' => $ta, 'b' => $tb]);
                    $seen += (int) $obs->fetchColumn();
                }
                $chk->execute(['id' => $s['id'], 'a' => $ta, 'b' => $tb]);
                $c = $chk->fetch() ?: ['c' => 0, 'v' => 0];
                $cf = $conf[$s['id'] . '|' . $date] ?? null;
                $out[] = [
                    'scheduleId' => $s['id'], 'name' => $s['name'], 'date' => $date,
                    'start' => $ta, 'end' => $tb, 'location' => $s['location'], 'plant' => $plant,
                    'items' => $s['items'], 'cameras' => count($cams[$s['location']] ?? []),
                    'state' => $now < $a ? 'upcoming' : ($now < $b ? 'in_progress' : 'ended'),
                    'detections' => $seen, 'checks' => (int) $c['c'], 'violations' => (int) $c['v'],
                    'confirmed' => $cf['status'] ?? null, 'confirmedBy' => $cf['actor'] ?? null,
                    'confirmedAt' => $cf['created_at'] ?? null, 'note' => $cf['note'] ?? null,
                ];
            }
        }
        return [$out, $from, $to];
    }

    /** Supervisor record that a session was (or was not) actually performed. */
    public function confirm(string $scheduleId, string $date, string $status, string $note, string $actor): bool
    {
        $ids = array_column($this->config['cleaning']['schedules'] ?? [], 'id');
        if (!in_array($scheduleId, $ids, true) || !in_array($status, ['done', 'not_done'], true)
            || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
            return false;
        }
        return $this->pdo->prepare('INSERT INTO cleaning_log (schedule_id, session_date, status, note, actor, created_at)
                                    VALUES (:s, :d, :st, :n, :a, :t)')
            ->execute(['s' => $scheduleId, 'd' => $date, 'st' => $status, 'n' => substr($note, 0, 500),
                       'a' => substr($actor, 0, 100), 't' => date('Y-m-d H:i:s')]);
    }

    public function summary(array $f, Ppe $ppe): array
    {
        [$sess, $from, $to] = $this->sessions($f);
        $p = $ppe->summary(['from' => $from, 'to' => $to, 'cleaning' => 1] + array_intersect_key($f, array_flip(['plant', 'location', 'item'])));
        $k = ['sessions' => count($sess), 'inProgress' => 0, 'ended' => 0, 'noActivity' => 0, 'confirmedDone' => 0,
              'notPerformed' => 0, 'unconfirmed' => 0] + $p['kpi'];
        foreach ($sess as $s) {
            if ($s['state'] === 'in_progress') {
                $k['inProgress']++;
            }
            if ($s['state'] === 'ended') {
                $k['ended']++;
                if ($s['detections'] === 0) {
                    $k['noActivity']++;
                }
                if ($s['confirmed'] === null) {
                    $k['unconfirmed']++;
                }
            }
            if ($s['confirmed'] === 'done') {
                $k['confirmedDone']++;
            } elseif ($s['confirmed'] === 'not_done') {
                $k['notPerformed']++;
            }
        }
        return ['from' => $from, 'to' => $to, 'kpi' => $k, 'sessions' => array_reverse($sess),
                'violations' => $p['violations'], 'byItem' => $p['byItem']];
    }

    /** CSV rows: one per scheduled session. */
    public function exportSessions(array $f): array
    {
        [$sess] = $this->sessions($f);
        $state = ['upcoming' => 'Upcoming', 'in_progress' => 'In progress', 'ended' => 'Ended'];
        $out = [['Date', 'Session', 'Plant', 'Cleaning area', 'Scheduled start', 'Scheduled end', 'Required PPE', 'Schedule state',
                 'People detected in window', 'PPE checks', 'PPE violations', 'Compliance %', 'Supervisor confirmation', 'Confirmed by', 'Note']];
        foreach ($sess as $s) {
            $out[] = [$s['date'], $s['name'], $s['plant'], $s['location'], substr($s['start'], 11, 5), substr($s['end'], 11, 5),
                implode('; ', array_map(static fn ($i) => Ppe::ITEMS[$i] ?? $i, $s['items'])), $state[$s['state']],
                $s['detections'], $s['checks'], $s['violations'],
                $s['checks'] ? round(100 * ($s['checks'] - $s['violations']) / $s['checks'], 1) : '',
                ['done' => 'Cleaning done', 'not_done' => 'Not performed'][$s['confirmed']] ?? 'Not confirmed',
                (string) $s['confirmedBy'], (string) $s['note']];
        }
        return $out;
    }
}
