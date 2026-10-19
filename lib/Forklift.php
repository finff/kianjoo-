<?php
/**
 * Forklift monitoring (POC Use Case 5, first stage).
 *
 * SenseStudio V2.13 has no forklift class in its vehicle model, so a
 * "forklift detection" here is a vehicle / non-motor-vehicle detection (or any
 * detection from a SenseStudio policy named "forklift") on a camera configured
 * as a forklift zone (Settings → Forklift Zones). Each one is checked against
 * the zone's rule:
 *
 *   prohibited  forklifts are not allowed in the zone during its hours
 *               ("always" = at any time)                        → violation
 *   restricted  forklifts are only allowed outside the zone's
 *               restricted hours                                 → violation inside them
 *   (outside the hours, or no zone configured)                   → logged, auto-resolved
 *
 * A reviewer can confirm a violation or clear it as a false alarm. The verdict
 * rides on the event's decoded map (FkVerdict / FkZone) so the incident list,
 * bell and email alerts use it without a separate pipeline. Records live in
 * forklift_events.
 */

declare(strict_types=1);

require_once __DIR__ . '/EventStore.php';
require_once __DIR__ . '/Attendance.php';
require_once __DIR__ . '/Restricted.php';

final class Forklift
{
    public const VERDICTS = [
        'violation' => 'Zone violation',
        'logged'    => 'Forklift detected',
        'cleared'   => 'Cleared — false alarm',
    ];
    public const RULES = ['prohibited', 'restricted'];
    public const MODEL_NOTE = "SenseStudio V2.13 has no forklift class in its vehicle model (§5.2.4 lists VehicleCategory: "
        . "GeneralVehicle, Ambulance, FireTruck…). Detections here come from vehicle / non-motor-vehicle attributes on "
        . "forklift-zone cameras, or a SenseStudio policy named 'forklift'. Pedestrian proximity and unsafe operation "
        . "need a trained forklift model — see use case 5.";

    private const TEXT_RE   = '/forklift|fork.?lift|vehicle|non.?motor/i';
    private const VEHICLE_KEYS = ['VehicleType', 'VehicleCategory', 'VehicleColor', 'CarBrand', 'All(Vehicle)',
                                  'NonMotorVehicleType', 'All(Moped)', 'MopedType', 'MopedColor'];
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

    private static function text(array $e): string
    {
        return ($e['trigger_image_type'] ?? '') . ' ' . ($e['event_type'] ?? '') . ' '
            . ($e['policy_name'] ?? '') . ' ' . ($e['policy_desc'] ?? '');
    }

    /** Policy text names a forklift explicitly. */
    public static function namesForklift(array $e): bool
    {
        return (bool) preg_match('/fork.?lift/i', self::text($e));
    }

    /**
     * Is this a vehicle / forklift detection? $e is an event row (or probe)
     * with trigger_image_type / event_type / policy_name / policy_desc and,
     * optionally, 'decoded' (feature name → value name).
     */
    public static function isForkliftEvent(array $e): bool
    {
        if (preg_match(self::TEXT_RE, self::text($e))) {
            return true;
        }
        $dec = is_array($e['decoded'] ?? null) ? $e['decoded'] : [];
        foreach ($dec as $k => $v) {
            $k = (string) $k;
            if (in_array($k, self::VEHICLE_KEYS, true) || str_starts_with($k, 'NonMotor')) {
                // A presence flag of "No" is not a detection.
                if (str_starts_with($k, 'All(') && (string) $v === 'No') {
                    continue;
                }
                return true;
            }
        }
        return false;
    }

    /** Zone config for a stream (null when the camera is not an enabled forklift zone). */
    public function zoneOf(?string $stream, ?string $device): ?array
    {
        $key  = EventStore::streamLabel((string) ($stream ?: $device ?: ''));
        $zone = ($this->config['forklift']['zones'] ?? [])[$key] ?? null;
        return $zone && !empty($zone['enabled']) ? $zone + ['key' => $key] : null;
    }

    /**
     * Should this event be recorded, and against which zone? Returns
     * [record:bool, zone:?array].
     */
    public function applies(array $e, ?string $stream, ?string $device): array
    {
        if (!self::isForkliftEvent($e)) {
            return [false, null];
        }
        $zone = $this->zoneOf($stream, $device);
        return [$zone !== null || self::namesForklift($e), $zone];
    }

    /**
     * Verdict for one forklift detection.
     *
     * @return array{verdict:string,reason:string,rule:string}
     */
    public static function judge(?array $zone, int $ts): array
    {
        if ($zone === null) {
            return ['verdict' => 'logged', 'rule' => '',
                    'reason' => 'Forklift policy detection on a camera with no forklift zone configured'];
        }
        $rule  = in_array($zone['rule'] ?? '', self::RULES, true) ? (string) $zone['rule'] : 'prohibited';
        $hours = (string) ($zone['hours'] ?? 'always');
        $name  = (string) ($zone['name'] ?? 'zone');
        $in    = Restricted::inWindow($hours, $ts);
        $always = in_array(strtolower(trim($hours)), ['', 'always'], true);
        if ($rule === 'prohibited') {
            return $in
                ? ['verdict' => 'violation', 'rule' => $rule,
                   'reason' => 'Forklift in ' . $name . ', where forklifts are prohibited' . ($always ? '' : ' ' . $hours)]
                : ['verdict' => 'logged', 'rule' => $rule,
                   'reason' => 'Forklift in ' . $name . ' outside its prohibited hours (' . $hours . ')'];
        }
        return $in
            ? ['verdict' => 'violation', 'rule' => $rule,
               'reason' => 'Forklift in ' . $name . ' during restricted hours' . ($always ? '' : ' (' . $hours . ')')]
            : ['verdict' => 'logged', 'rule' => $rule,
               'reason' => 'Forklift in ' . $name . ' within permitted hours'];
    }

    /** Tag a decoded map with the verdict (FkVerdict / FkZone / FkRule). */
    public static function tag(array $map, ?array $zone, array $j, string $camera): array
    {
        $map['FkVerdict'] = $j['verdict'];
        $map['FkZone']    = $zone !== null ? (string) $zone['name'] : strtoupper($camera);
        if ($j['rule'] !== '') {
            $map['FkRule'] = $j['rule'];
        }
        return $map;
    }

    // ── Storage ──────────────────────────────────────────────

    public function record(int $eventId, array $row, ?array $zone, array $j): void
    {
        $key   = $zone['key'] ?? EventStore::streamLabel((string) ($row['stream'] ?? ''));
        $loc   = (string) (($this->config['poc']['cam_locations'] ?? [])[$key] ?? '');
        $plant = $loc !== '' ? (new Attendance($this->store, $this->config))->plantOf($loc) : '';
        $st = $this->pdo->prepare(
            'INSERT INTO forklift_events (event_id, detected_at, stream, device_name, location, plant, zone, rule, policy,
                                          verdict, reason, image)
             VALUES (:e, :t, :s, :d, :l, :p, :z, :ru, :po, :v, :r, :i)'
        );
        $st->execute([
            'e' => $eventId, 't' => (string) ($row['received_at'] ?? date('Y-m-d H:i:s')),
            's' => (string) ($row['stream'] ?? ''), 'd' => (string) ($row['device_name'] ?? ''),
            'l' => $loc, 'p' => $plant, 'z' => (string) ($zone['name'] ?? ''), 'ru' => $j['rule'],
            'po' => (string) ($row['policy_name'] ?? ''), 'v' => $j['verdict'], 'r' => $j['reason'],
            'i' => $row['trigger_img_url'] ?? null,
        ]);
        // Logged (permitted) detections don't sit in the open-incident queue.
        if ($j['verdict'] === 'logged') {
            $this->pdo->prepare("UPDATE events SET status = 'resolved', resolved_at = :t WHERE id = :id AND (status IS NULL OR status = 'open')")
                ->execute(['t' => date('Y-m-d H:i:s'), 'id' => $eventId]);
        }
    }

    /** Check vehicle events that arrived before the zone was configured (once each, last 30 days). */
    public function catchUp(): int
    {
        $zones = $this->config['forklift']['zones'] ?? [];
        $file  = dirname((string) ($this->config['storage']['raw_log'] ?? (dirname(__DIR__) . '/storage/x'))) . '/fk_cursor.json';
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
        if ($rows) {
            $seen = $this->pdo->prepare('SELECT COUNT(*) FROM forklift_events WHERE event_id = :id');
            $upd  = $this->pdo->prepare('UPDATE events SET decoded_json = :j WHERE id = :id');
            foreach ($rows as $r) {
                $dec = json_decode((string) ($r['decoded_json'] ?? ''), true) ?: [];
                if (!empty($dec['FkVerdict'])) {
                    continue;
                }
                $probe = $r;
                $probe['decoded'] = $dec;
                if (!$zones && !self::namesForklift($probe)) {
                    continue;
                }
                [$ok, $zone] = $this->applies($probe, $r['stream'] ?? null, $r['device_name'] ?? null);
                if (!$ok) {
                    continue;
                }
                $seen->execute(['id' => $r['id']]);
                if ((int) $seen->fetchColumn() > 0) {
                    continue;
                }
                $j = self::judge($zone, strtotime((string) $r['received_at']) ?: time());
                $this->record((int) $r['id'], $r, $zone, $j);
                $dec = self::tag($dec, $zone, $j, (string) ($r['stream'] ?? ''));
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

    /** A reviewer confirms a violation or clears a detection as a false alarm. */
    public function review(int $id, string $verdict, string $note, string $actor): bool
    {
        if (!in_array($verdict, ['violation', 'cleared'], true)) {
            return false;
        }
        $q = $this->pdo->prepare('SELECT * FROM forklift_events WHERE id = :id');
        $q->execute(['id' => $id]);
        $r = $q->fetch();
        if (!$r) {
            return false;
        }
        $now = date('Y-m-d H:i:s');
        $this->pdo->prepare('UPDATE forklift_events SET verdict = :v, reviewed_by = :b, reviewed_at = :t, note = :n WHERE id = :id')
            ->execute(['v' => $verdict, 'b' => substr($actor, 0, 100), 't' => $now, 'n' => substr($note, 0, 500), 'id' => $id]);

        $e = $this->pdo->prepare('SELECT decoded_json, uuid FROM events WHERE id = :id');
        $e->execute(['id' => $r['event_id']]);
        $ev = $e->fetch();
        if ($ev) {
            $dec = json_decode((string) ($ev['decoded_json'] ?? ''), true) ?: [];
            $dec['FkVerdict'] = $verdict;
            $this->pdo->prepare('UPDATE events SET decoded_json = :j WHERE id = :id')
                ->execute(['j' => json_encode($dec, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 'id' => $r['event_id']]);
            if ($verdict === 'cleared' && !empty($ev['uuid'])) {
                $this->store->setStatus((string) $ev['uuid'], 'resolved', null);
            }
            if (!empty($ev['uuid'])) {
                $this->store->addLog((string) $ev['uuid'], 'review', $actor, $r['verdict'], $verdict,
                    ($verdict === 'violation' ? 'Confirmed forklift zone violation' : 'Cleared as false alarm') . ($note !== '' ? ' — ' . $note : ''));
            }
        }
        return true;
    }

    // ── Dashboard + reports ──────────────────────────────────

    private function rows(array $f): array
    {
        $from = Attendance::cleanDate((string) ($f['from'] ?? ''));
        $to   = Attendance::cleanDate((string) (($f['to'] ?? '') ?: $from));
        if ($to < $from) {
            [$from, $to] = [$to, $from];
        }
        $sql  = 'SELECT r.*, e.uuid, e.status FROM forklift_events r LEFT JOIN events e ON e.id = r.event_id
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
        $k = ['detections' => 0, 'violations' => 0, 'logged' => 0, 'cleared' => 0, 'today' => 0, 'open' => 0];
        $daily = $byZone = [];
        for ($d = strtotime($from); $d <= strtotime($to) && count($daily) < 92; $d += 86400) {
            $daily[date('Y-m-d', $d)] = ['detections' => 0, 'violations' => 0, 'logged' => 0, 'cleared' => 0];
        }
        foreach ($rows as $r) {
            $v   = (string) $r['verdict'];
            $day = substr((string) $r['detected_at'], 0, 10);
            $vk  = $v === 'violation' ? 'violations' : $v;
            $k['detections']++;
            if (isset($k[$vk])) {
                $k[$vk]++;
            }
            if ($day === $today) {
                $k['today']++;
            }
            if ($v === 'violation' && in_array($r['status'] ?? 'open', [null, '', 'open'], true)) {
                $k['open']++;
            }
            $daily[$day] ??= ['detections' => 0, 'violations' => 0, 'logged' => 0, 'cleared' => 0];
            $daily[$day]['detections']++;
            if (isset($daily[$day][$vk])) {
                $daily[$day][$vk]++;
            }
            $z = $r['zone'] ?: strtoupper((string) $r['stream']);
            $byZone[$z] ??= ['zone' => $z, 'plant' => (string) $r['plant'], 'camera' => strtoupper((string) $r['stream']),
                             'rule' => (string) ($r['rule'] ?? ''), 'detections' => 0, 'violations' => 0];
            $byZone[$z]['detections']++;
            if ($v === 'violation') {
                $byZone[$z]['violations']++;
            }
        }
        ksort($daily);
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
            'zone' => (string) $r['zone'], 'rule' => (string) ($r['rule'] ?? ''), 'policy' => (string) $r['policy'],
            'verdict' => (string) $r['verdict'], 'reason' => (string) $r['reason'],
            'status' => (string) ($r['status'] ?? 'open') ?: 'open',
            'reviewedBy' => (string) ($r['reviewed_by'] ?? ''), 'reviewedAt' => (string) ($r['reviewed_at'] ?? ''),
            'note' => (string) ($r['note'] ?? ''), 'image' => $this->store->fullUrl($r['image'] ?? null),
        ];
    }

    /** CSV rows: one per forklift detection. */
    public function exportIncidents(array $f): array
    {
        [$rows] = $this->rows($f);
        $out = [['Date', 'Time', 'Plant', 'Zone', 'Rule', 'Location', 'Camera', 'Policy', 'Verdict', 'Reason',
                 'Incident status', 'Reviewed by', 'Reviewed at', 'Review note', 'Image URL']];
        foreach (array_reverse($rows) as $r) {
            $i = $this->item($r);
            $out[] = [substr($i['time'], 0, 10), substr($i['time'], 11, 8), $i['plant'], $i['zone'], $i['rule'], $i['location'],
                      $i['camera'], $i['policy'], self::VERDICTS[$i['verdict']] ?? $i['verdict'], $i['reason'],
                      $i['status'], $i['reviewedBy'], $i['reviewedAt'], $i['note'], (string) $i['image']];
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
                            'camera' => strtoupper((string) $r['stream']), 'rule' => (string) ($r['rule'] ?? ''),
                            'detections' => 0, 'violation' => 0, 'logged' => 0, 'cleared' => 0];
            $agg[$key]['detections']++;
            if (isset($agg[$key][$r['verdict']])) {
                $agg[$key][$r['verdict']]++;
            }
        }
        ksort($agg);
        $out = [['Date', 'Plant', 'Zone', 'Camera', 'Rule', 'Detections', 'Zone violations', 'Logged', 'Cleared (false alarm)']];
        foreach ($agg as $a) {
            $out[] = [$a['date'], $a['plant'], $a['zone'], $a['camera'], $a['rule'], $a['detections'], $a['violation'], $a['logged'], $a['cleared']];
        }
        return $out;
    }
}
