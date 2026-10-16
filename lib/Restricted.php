<?php
/**
 * Restricted area monitoring (POC Use Case 3).
 *
 * Boundaries and zones are drawn in SenseStudio (ROI / cross-line policies);
 * every detection from those policies is an intrusion event ('intr'). For a
 * camera configured as a restricted zone (Settings → Restricted Zones), each
 * intrusion event is checked against the zone's access rules:
 *
 *   outside_hours  the zone is not restricted at this time    → logged, auto-resolved
 *   authorized     an enrolled, active employee whose staff ID
 *                  or department is on the zone's access list → logged, auto-resolved
 *   violation      an enrolled employee NOT on the access list → High-severity incident + alert
 *   review         nobody identifiable (no face match, or an
 *                  unknown face)                               → open incident for review
 *
 * Unverifiable entries are never auto-confirmed as violations; a reviewer
 * confirms or clears them from the Intrusion page. The verdict rides on the
 * event's decoded map (RaVerdict / RaZone) so the incident list, bell and email
 * alerts use it without a separate pipeline. Records live in restricted_events.
 */

declare(strict_types=1);

require_once __DIR__ . '/EventStore.php';
require_once __DIR__ . '/Attendance.php';
require_once __DIR__ . '/DashboardMapper.php';

final class Restricted
{
    public const VERDICTS = [
        'violation'     => 'Unauthorized entry',
        'review'        => 'Needs review',
        'authorized'    => 'Authorized entry',
        'outside_hours' => 'Outside restricted hours',
    ];
    private const CATCHUP_BATCH = 3000;

    private PDO $pdo;
    private array $config;
    private EventStore $store;

    public function __construct(PDO $pdo, array $config, EventStore $store)
    {
        $this->pdo    = $pdo;
        $this->config = $config;
        $this->store  = $store;
    }

    /** Is $ts inside a "HH:MM-HH:MM" window (overnight-aware)? "always"/"" = yes. */
    public static function inWindow(string $window, int $ts): bool
    {
        $window = strtolower(trim($window));
        if ($window === '' || $window === 'always') {
            return true;
        }
        if (!preg_match('/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/', $window, $m)) {
            return true;   // unparseable → treat as always restricted
        }
        $now   = (int) date('G', $ts) * 60 + (int) date('i', $ts);
        $start = (int) $m[1] * 60 + (int) $m[2];
        $end   = (int) $m[3] * 60 + (int) $m[4];
        return $start <= $end ? ($now >= $start && $now < $end) : ($now >= $start || $now < $end);
    }

    /** Zone config for a stream ('' when the camera is not a restricted zone). */
    public function zoneOf(?string $stream, ?string $device): ?array
    {
        $key  = EventStore::streamLabel((string) ($stream ?: $device ?: ''));
        $zone = ($this->config['restricted']['zones'] ?? [])[$key] ?? null;
        return $zone && !empty($zone['enabled']) ? $zone + ['key' => $key] : null;
    }

    /**
     * Decide the verdict for one intrusion detection in a zone.
     *
     * @param array<string,array> $profiles personProfiles() keyed by person id
     * @param array<string,string> $alias   SenseStudio uid → profile person id
     * @return array{verdict:string,reason:string,personId:string,name:string,staffId:string}
     */
    public static function judge(array $zone, ?string $personId, int $ts, array $profiles, array $alias = []): array
    {
        $pid  = (string) ($personId ?? '');
        $pid  = $alias[$pid] ?? $pid;
        $emp  = $pid !== '' ? ($profiles[$pid] ?? null) : null;
        $base = ['personId' => $pid, 'name' => (string) ($emp['name'] ?? ''), 'staffId' => (string) ($emp['staffId'] ?? '')];

        if (!self::inWindow((string) ($zone['hours'] ?? 'always'), $ts)) {
            return $base + ['verdict' => 'outside_hours', 'reason' => 'Zone is only restricted ' . $zone['hours']];
        }
        if ($emp === null) {
            return $base + ['verdict' => 'review', 'reason' => $pid === ''
                ? 'No face identified — authorization cannot be verified'
                : 'Unknown person #' . $pid . ' (not enrolled) — authorization cannot be verified'];
        }
        $okStaff = in_array(strtolower($emp['staffId']), array_map('strtolower', $zone['staff'] ?? []), true);
        $okDept  = $emp['department'] !== '' && in_array($emp['department'], $zone['depts'] ?? [], true);
        if (empty($emp['active'])) {
            return $base + ['verdict' => 'violation', 'reason' => $emp['name'] . ' is an inactive employee'];
        }
        if ($okStaff || $okDept) {
            return $base + ['verdict' => 'authorized', 'reason' => $okStaff
                ? 'Staff ID on the zone access list' : ($emp['department'] . ' department is authorized')];
        }
        return $base + ['verdict' => 'violation', 'reason' => $emp['name']
            . ($emp['department'] !== '' ? ' (' . $emp['department'] . ')' : '') . ' is not on the access list'];
    }

    /** SenseStudio uid → profile person id (employees synced to SenseStudio). */
    public function aliases(): array
    {
        $out = [];
        foreach ($this->store->personProfiles() as $pid => $p) {
            if (($p['ssUid'] ?? '') !== '' && $p['ssUid'] !== $pid) {
                $out[$p['ssUid']] = $pid;
            }
        }
        return $out;
    }

    // ── Storage ──────────────────────────────────────────────

    public function record(int $eventId, array $row, array $zone, array $j): void
    {
        $loc   = (string) (($this->config['poc']['cam_locations'] ?? [])[$zone['key']] ?? '');
        $plant = $loc !== '' ? (new Attendance($this->store, $this->config))->plantOf($loc) : '';
        $st = $this->pdo->prepare(
            'INSERT INTO restricted_events (event_id, detected_at, stream, device_name, location, plant, zone, policy,
                                            verdict, reason, person_id, person_name, staff_id, image)
             VALUES (:e, :t, :s, :d, :l, :p, :z, :po, :v, :r, :pid, :pn, :sid, :i)'
        );
        $st->execute([
            'e' => $eventId, 't' => (string) ($row['received_at'] ?? date('Y-m-d H:i:s')),
            's' => (string) ($row['stream'] ?? ''), 'd' => (string) ($row['device_name'] ?? ''),
            'l' => $loc, 'p' => $plant, 'z' => (string) ($zone['name'] ?? ''), 'po' => (string) ($row['policy_name'] ?? ''),
            'v' => $j['verdict'], 'r' => $j['reason'], 'pid' => $j['personId'] ?: null,
            'pn' => $j['name'] ?: null, 'sid' => $j['staffId'] ?: null, 'i' => $row['trigger_img_url'] ?? null,
        ]);
        // Cleared entries don't sit in the open-incident queue.
        if (in_array($j['verdict'], ['authorized', 'outside_hours'], true)) {
            $this->pdo->prepare("UPDATE events SET status = 'resolved', resolved_at = :t WHERE id = :id AND (status IS NULL OR status = 'open')")
                ->execute(['t' => date('Y-m-d H:i:s'), 'id' => $eventId]);
        }
    }

    /** Check intrusion events that arrived before the zone was configured (once each, last 30 days). */
    public function catchUp(): int
    {
        $zones = $this->config['restricted']['zones'] ?? [];
        $file  = dirname(__DIR__) . '/storage/ra_cursor.json';
        $cur   = is_file($file) ? (int) ((json_decode((string) file_get_contents($file), true) ?: [])['last'] ?? 0) : 0;
        if ($cur === 0) {
            $q = $this->pdo->prepare('SELECT MIN(id) FROM events WHERE received_at >= :f');
            $q->execute(['f' => date('Y-m-d H:i:s', time() - 30 * 86400)]);
            $cur = max(0, (int) $q->fetchColumn() - 1);
        }
        $st = $this->pdo->prepare('SELECT * FROM events WHERE id > :c ORDER BY id ASC LIMIT ' . self::CATCHUP_BATCH);
        $st->execute(['c' => $cur]);
        $rows = $st->fetchAll();
        $done = 0;
        if ($rows && $zones) {
            $profiles = $this->store->personProfiles();
            $alias    = $this->aliases();
            $seen = $this->pdo->prepare('SELECT COUNT(*) FROM restricted_events WHERE event_id = :id');
            $upd  = $this->pdo->prepare('UPDATE events SET decoded_json = :j WHERE id = :id');
            foreach ($rows as $r) {
                $zone = $this->zoneOf($r['stream'] ?? null, $r['device_name'] ?? null);
                if ($zone === null) {
                    continue;
                }
                $dec = json_decode((string) ($r['decoded_json'] ?? ''), true) ?: [];
                if (!DashboardMapper::isIntrusionPolicy($r) || !empty($dec['RaVerdict'])) {
                    continue;
                }
                $seen->execute(['id' => $r['id']]);
                if ((int) $seen->fetchColumn() > 0) {
                    continue;
                }
                $j = self::judge($zone, $r['person_id'] ?? null, strtotime((string) $r['received_at']) ?: time(), $profiles, $alias);
                $this->record((int) $r['id'], $r, $zone, $j);
                $dec['RaVerdict'] = $j['verdict'];
                $dec['RaZone']    = (string) $zone['name'];
                $upd->execute(['j' => json_encode($dec, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 'id' => $r['id']]);
                $done++;
            }
        }
        if ($rows) {
            $cur = (int) end($rows)['id'];
        }
        @file_put_contents($file, json_encode(['last' => $cur, 'at' => date('c')]), LOCK_EX);
        return $done;
    }

    /**
     * A reviewer confirms or clears an entry. Confirming re-opens nothing that
     * was already handled; clearing resolves the incident.
     */
    public function review(int $id, string $verdict, string $note, string $actor): bool
    {
        if (!in_array($verdict, ['violation', 'authorized'], true)) {
            return false;
        }
        $q = $this->pdo->prepare('SELECT * FROM restricted_events WHERE id = :id');
        $q->execute(['id' => $id]);
        $r = $q->fetch();
        if (!$r) {
            return false;
        }
        $now = date('Y-m-d H:i:s');
        $this->pdo->prepare('UPDATE restricted_events SET verdict = :v, reviewed_by = :b, reviewed_at = :t, note = :n WHERE id = :id')
            ->execute(['v' => $verdict, 'b' => substr($actor, 0, 100), 't' => $now, 'n' => substr($note, 0, 500), 'id' => $id]);

        $e = $this->pdo->prepare('SELECT decoded_json, uuid FROM events WHERE id = :id');
        $e->execute(['id' => $r['event_id']]);
        $ev = $e->fetch();
        if ($ev) {
            $dec = json_decode((string) ($ev['decoded_json'] ?? ''), true) ?: [];
            $dec['RaVerdict'] = $verdict;
            $this->pdo->prepare('UPDATE events SET decoded_json = :j WHERE id = :id')
                ->execute(['j' => json_encode($dec, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 'id' => $r['event_id']]);
            if ($verdict === 'authorized' && !empty($ev['uuid'])) {
                $this->store->setStatus((string) $ev['uuid'], 'resolved', null);
            }
            if (!empty($ev['uuid'])) {
                $this->store->addLog((string) $ev['uuid'], 'review', $actor, $r['verdict'], $verdict,
                    ($verdict === 'violation' ? 'Confirmed unauthorized entry' : 'Cleared as authorized') . ($note !== '' ? ' — ' . $note : ''));
            }
        }
        return true;
    }

    // ── Dashboard + reports ──────────────────────────────────

    private function rows(array $f): array
    {
        $from = Attendance::cleanDate((string) ($f['from'] ?? ''));
        $to   = Attendance::cleanDate((string) ($f['to'] ?? $from));
        if ($to < $from) {
            [$from, $to] = [$to, $from];
        }
        $sql  = 'SELECT r.*, e.uuid, e.status FROM restricted_events r LEFT JOIN events e ON e.id = r.event_id
                  WHERE r.detected_at >= :f AND r.detected_at < :t';
        $bind = ['f' => $from . ' 00:00:00', 't' => date('Y-m-d', strtotime($to) + 86400) . ' 00:00:00'];
        foreach (['plant' => 'r.plant', 'camera' => 'r.stream', 'zone' => 'r.zone', 'verdict' => 'r.verdict'] as $k => $col) {
            if (!empty($f[$k])) {
                $sql .= " AND {$col} = :{$k}";
                $bind[$k] = $f[$k];
            }
        }
        if (!empty($f['status'])) {
            $sql .= $f['status'] === 'open' ? " AND (e.status IS NULL OR e.status = 'open')" : ' AND e.status = :st';
            if ($f['status'] !== 'open') {
                $bind['st'] = $f['status'];
            }
        }
        $st = $this->pdo->prepare($sql . ' ORDER BY r.id ASC LIMIT 50000');
        $st->execute($bind);
        return [$st->fetchAll(), $from, $to];
    }

    public function summary(array $f): array
    {
        [$rows, $from, $to] = $this->rows($f);
        $today = date('Y-m-d');
        $k = ['entries' => 0, 'violation' => 0, 'review' => 0, 'authorized' => 0, 'outside_hours' => 0, 'today' => 0, 'open' => 0];
        $daily = $byZone = [];
        for ($d = strtotime($from); $d <= strtotime($to) && count($daily) < 92; $d += 86400) {
            $daily[date('Y-m-d', $d)] = ['violation' => 0, 'review' => 0, 'authorized' => 0, 'outside_hours' => 0];
        }
        foreach ($rows as $r) {
            $v   = (string) $r['verdict'];
            $day = substr((string) $r['detected_at'], 0, 10);
            $k['entries']++;
            $k[$v] = ($k[$v] ?? 0) + 1;
            if ($day === $today && in_array($v, ['violation', 'review'], true)) {
                $k['today']++;
            }
            if (in_array($v, ['violation', 'review'], true) && in_array($r['status'] ?? 'open', [null, '', 'open'], true)) {
                $k['open']++;
            }
            $daily[$day][$v] = ($daily[$day][$v] ?? 0) + 1;
            $z = $r['zone'] ?: strtoupper((string) $r['stream']);
            $byZone[$z] ??= ['zone' => $z, 'plant' => $r['plant'], 'camera' => strtoupper((string) $r['stream']),
                             'violation' => 0, 'review' => 0, 'authorized' => 0, 'outside_hours' => 0];
            $byZone[$z][$v]++;
        }
        $list = [];
        foreach (array_reverse($rows) as $r) {
            if (count($list) >= 200) {
                break;
            }
            $list[] = $this->item($r);
        }
        return [
            'from' => $from, 'to' => $to, 'kpi' => $k,
            'daily' => array_map(static fn ($d, $v) => ['date' => $d] + $v, array_keys($daily), $daily),
            'byZone' => array_values($byZone), 'incidents' => $list,
        ];
    }

    private function item(array $r): array
    {
        return [
            'id' => (int) $r['id'], 'eventId' => (int) $r['event_id'], 'uuid' => $r['uuid'] ?? null,
            'time' => (string) $r['detected_at'], 'camera' => strtoupper((string) $r['stream']),
            'device' => (string) $r['device_name'], 'location' => (string) $r['location'], 'plant' => (string) $r['plant'],
            'zone' => (string) $r['zone'], 'policy' => (string) $r['policy'],
            'verdict' => (string) $r['verdict'], 'reason' => (string) $r['reason'],
            'personId' => (string) ($r['person_id'] ?? ''), 'name' => (string) ($r['person_name'] ?? ''),
            'staffId' => (string) ($r['staff_id'] ?? ''), 'status' => (string) ($r['status'] ?? 'open') ?: 'open',
            'reviewedBy' => (string) ($r['reviewed_by'] ?? ''), 'reviewedAt' => (string) ($r['reviewed_at'] ?? ''),
            'note' => (string) ($r['note'] ?? ''), 'image' => $this->store->fullUrl($r['image'] ?? null),
        ];
    }

    /** CSV rows: one per restricted-area entry. */
    public function exportIncidents(array $f): array
    {
        [$rows] = $this->rows($f);
        $out = [['Date', 'Time', 'Plant', 'Zone', 'Location', 'Camera', 'Boundary / policy', 'Verdict', 'Reason',
                 'Employee', 'Staff ID', 'Person ID', 'Incident status', 'Reviewed by', 'Reviewed at', 'Review note', 'Image URL']];
        foreach (array_reverse($rows) as $r) {
            $i = $this->item($r);
            $out[] = [substr($i['time'], 0, 10), substr($i['time'], 11, 8), $i['plant'], $i['zone'], $i['location'], $i['camera'],
                      $i['policy'], self::VERDICTS[$i['verdict']] ?? $i['verdict'], $i['reason'], $i['name'], $i['staffId'],
                      $i['personId'], $i['status'], $i['reviewedBy'], $i['reviewedAt'], $i['note'], (string) $i['image']];
        }
        return $out;
    }

    /** CSV rows: per day and zone, counts by verdict. */
    public function exportSummary(array $f): array
    {
        [$rows] = $this->rows($f);
        $agg = [];
        foreach ($rows as $r) {
            $key = substr((string) $r['detected_at'], 0, 10) . '|' . $r['zone'];
            $agg[$key] ??= ['date' => substr((string) $r['detected_at'], 0, 10), 'plant' => $r['plant'], 'zone' => $r['zone'],
                            'camera' => strtoupper((string) $r['stream']), 'entries' => 0,
                            'violation' => 0, 'review' => 0, 'authorized' => 0, 'outside_hours' => 0];
            $agg[$key]['entries']++;
            $agg[$key][$r['verdict']]++;
        }
        ksort($agg);
        $out = [['Date', 'Plant', 'Zone', 'Camera', 'Entries', 'Unauthorized', 'Needs review', 'Authorized', 'Outside restricted hours']];
        foreach ($agg as $a) {
            $out[] = [$a['date'], $a['plant'], $a['zone'], $a['camera'], $a['entries'], $a['violation'], $a['review'], $a['authorized'], $a['outside_hours']];
        }
        return $out;
    }
}
