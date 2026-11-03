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
    public const RULES = ['prohibited', 'restricted', 'forklift_only'];
    /** What a forklift_events row is about. */
    public const KINDS = [
        'forklift'   => 'Forklift detection',
        'pedestrian' => 'Pedestrian in forklift-only zone',
        'operator'   => 'Forklift operator PPE violation',
    ];
    /** Default PPE a forklift operator / nearby crew must wear (per zone: op_ppe). */
    public const OPERATOR_PPE = ['helmet', 'vest'];
    public const SAFETY_NOTE = "Pedestrian vs forklift: a forklift is a vehicle / non-motor-vehicle detection (or a policy named "
        . "'forklift'); a pedestrian is any person detection (face, body attributes, or a zone-intrusion policy) on the same "
        . "camera. People seen within ±N s of a forklift detection on that camera are treated as its operator / nearby crew and "
        . "checked against the zone's operator PPE; everyone else in a 'forklift only' zone during its hours is a pedestrian "
        . "intrusion. Correlation is by camera and time, not by tracking — a trained forklift + person model in SenseStudio "
        . "gives tighter results.";
    public const MODEL_NOTE = "SenseStudio V2.13 has no forklift class in its vehicle model (§5.2.4 lists VehicleCategory: "
        . "GeneralVehicle, Ambulance, FireTruck…). Detections here come from vehicle / non-motor-vehicle attributes on "
        . "forklift-zone cameras, or a SenseStudio policy named 'forklift' (custom forklift algorithm). Pedestrians in "
        . "forklift-only zones and operator PPE are judged by camera + time correlation with person detections; precise "
        . "proximity and unsafe-operation analysis need a trained forklift model — see use case 5.";

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
        if ($rule === 'forklift_only') {
            return ['verdict' => 'logged', 'rule' => $rule, 'kind' => 'forklift',
                    'reason' => 'Forklift in ' . $name . ' (forklift-only zone — permitted)'];
        }
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
        if (($j['kind'] ?? 'forklift') !== 'forklift') {
            $map['FkKind'] = $j['kind'];
        }
        if (!empty($j['op']['missing'])) {
            require_once __DIR__ . '/Ppe.php';
            $map['FkOpMissing'] = Ppe::missingText($j['op']['missing']);
        }
        return $map;
    }

    // ── Pedestrians & operator PPE (Workstream B) ────────────

    /** Seconds either side of a forklift detection in which a person counts as its operator / crew. */
    public function operatorWindow(): int
    {
        return max(2, min(120, (int) ($this->config['forklift']['operator_window'] ?? 10)));
    }

    /** PPE the zone requires of forklift operators. */
    public static function operatorPpe(?array $zone): array
    {
        require_once __DIR__ . '/Ppe.php';
        $l = $zone !== null && array_key_exists('op_ppe', $zone) ? (array) $zone['op_ppe'] : self::OPERATOR_PPE;
        return array_values(array_intersect(array_keys(Ppe::ITEMS), $l));
    }

    private const PERSON_KEYS = ['Gender', 'Age', 'HatsType', 'WithReflectiveVest', 'WithGlove', 'ShoesType', 'TopsType',
                                 'TopsColor', 'BottomsType', 'BottomsColor', 'HairStyle', 'ExpressionType', 'Smoking'];

    /** Is this a person detection (face, body attributes, person zone intrusion)? Vehicles are not. */
    public static function isPersonEvent(array $e): bool
    {
        if (self::isForkliftEvent($e)) {
            return false;
        }
        if (preg_match('/face|human|body|pedestrian|person|people/i', self::text($e))) {
            return true;
        }
        if ((string) ($e['person_id'] ?? '') !== '') {
            return true;
        }
        $dec = is_array($e['decoded'] ?? null) ? $e['decoded'] : [];
        foreach (self::PERSON_KEYS as $k) {
            if (isset($dec[$k])) {
                return true;
            }
        }
        require_once __DIR__ . '/DashboardMapper.php';
        return DashboardMapper::isIntrusionPolicy($e) && !preg_match('/fire|smoke|vehicle/i', self::text($e));
    }

    /** Detection time of a stored event row: camera trigger time, else receive time. */
    public static function tsOf(array $r): int
    {
        $t = (string) ($r['trigger_time'] ?? '');
        if ($t !== '') {
            $ts = strtotime(preg_replace('/\.\d+$/', '', $t) ?: $t);
            if ($ts) {
                return $ts;
            }
        }
        return strtotime((string) ($r['received_at'] ?? '')) ?: time();
    }

    /** Event time of an incoming push (its triggerTime when sane, else now). */
    public static function eventTs(?string $triggerTime): int
    {
        $ts = self::tsOf(['trigger_time' => (string) $triggerTime, 'received_at' => '']);
        return abs($ts - time()) <= 30 * 86400 ? $ts : time();
    }

    /** Operator PPE result over a set of person detections: worst state wins. */
    private static function operatorResult(array $maps, array $required, array $config, array $texts): array
    {
        require_once __DIR__ . '/Ppe.php';
        $missing = [];
        $ok = false;
        foreach ($maps as $i => $m) {
            $ev = Ppe::evaluate($m, $required, Ppe::ctx($config, (string) ($texts[$i] ?? '')));
            if ($ev === null) {
                continue;
            }
            if ($ev['missing']) {
                $missing = array_values(array_unique(array_merge($missing, $ev['missing'])));
            } else {
                $ok = true;
            }
        }
        return ['state' => $missing ? 'missing' : ($ok ? 'ok' : 'unknown'), 'missing' => $missing];
    }

    /**
     * Ingest hook (EventStore::store, before the insert). For a forklift
     * detection already judged ($judge) it checks the people seen on the same
     * camera within the operator window; for a person detection on a forklift
     * zone it checks operator PPE against a nearby forklift, or — in a
     * forklift-only zone with no forklift nearby — raises a pedestrian
     * intrusion. Returns [zone, judge, map] when the event becomes / stays a
     * forklift record, null otherwise.
     */
    public function assessIngest(array $probe, ?string $stream, ?string $device, ?array $zone, ?array $judge, array $map, int $ts): ?array
    {
        $win = $this->operatorWindow();
        if ($judge !== null) {
            if ($zone === null) {
                return null;
            }
            $req = self::operatorPpe($zone);
            $maps = $texts = [];
            foreach ($this->recentEvents((string) $stream, $ts, $win) as $r) {
                $dec = json_decode((string) ($r['decoded_json'] ?? ''), true) ?: [];
                $p   = $r + ['decoded' => $dec];
                if (!self::isPersonEvent($p) || (($dec['FkKind'] ?? '') === 'operator')) {
                    continue;
                }
                $maps[] = $dec;
                $texts[] = self::text($r);
                if (($dec['FkKind'] ?? '') === 'pedestrian') {
                    $this->reclassifyAsOperator((int) $r['id'], $dec, $req);
                }
            }
            if (!$maps || !$req) {
                return null;
            }
            $op = self::operatorResult($maps, $req, $this->config, $texts) + ['viol' => 0];
            $judge['op'] = $op;
            if ($op['state'] === 'missing') {
                require_once __DIR__ . '/Ppe.php';
                $op['viol'] = 1;
                $judge['op'] = $op;
                $why = 'Forklift operator PPE violation — no ' . Ppe::missingText($op['missing']);
                $judge['reason'] = $judge['verdict'] === 'violation' ? $judge['reason'] . '; ' . $why : $why;
                $judge['verdict'] = 'violation';
            }
            return [$zone, $judge, self::tag($map, $zone, $judge, (string) $stream)];
        }

        $zone = $this->zoneOf($stream, $device);
        if ($zone === null || !self::isPersonEvent($probe + ['decoded' => $map])) {
            return null;
        }
        // A forklift on this camera within the window → this person is its operator / crew.
        $fk = $this->nearbyForklift((string) $stream, $ts, $win);
        if ($fk !== null) {
            $req = self::operatorPpe($zone);
            if (!$req) {
                return null;
            }
            $op = self::operatorResult([$map], $req, $this->config, [self::text($probe)]);
            $this->noteOperatorOnForklift((int) $fk['id'], $op);
            if ($op['state'] !== 'missing' || (string) ($fk['op_ppe'] ?? '') === 'missing') {
                return null;   // compliant, unknown, or this forklift already carries an operator alert
            }
            require_once __DIR__ . '/Ppe.php';
            $j = ['verdict' => 'violation', 'rule' => (string) ($zone['rule'] ?? ''), 'kind' => 'operator',
                  'op' => $op + ['viol' => 1],
                  'reason' => 'Forklift operator PPE violation — no ' . Ppe::missingText($op['missing'])
                      . ' (person within ' . $win . ' s of a forklift in ' . $zone['name'] . ')'];
            return [$zone, $j, self::tag($map, $zone, $j, (string) $stream)];
        }
        if (($zone['rule'] ?? '') !== 'forklift_only') {
            return null;
        }
        $j = self::judgePedestrian($zone, $ts);
        if ($j['verdict'] !== 'violation') {
            // Outside the forklift-only hours a person is not forklift business —
            // leave the event to the restricted-zone / PPE / attendance checks.
            return null;
        }
        return [$zone, $j, self::tag($map, $zone, $j, (string) $stream)];
    }

    /** Verdict for a person detection in a forklift-only zone. */
    public static function judgePedestrian(array $zone, int $ts): array
    {
        $hours = (string) ($zone['hours'] ?? 'always');
        $name  = (string) ($zone['name'] ?? 'zone');
        $always = in_array(strtolower(trim($hours)), ['', 'always'], true);
        return Restricted::inWindow($hours, $ts)
            ? ['verdict' => 'violation', 'rule' => 'forklift_only', 'kind' => 'pedestrian',
               'reason' => 'Pedestrian in ' . $name . ' — forklift-only zone, pedestrians not allowed' . ($always ? '' : ' ' . $hours)]
            : ['verdict' => 'logged', 'rule' => 'forklift_only', 'kind' => 'pedestrian',
               'reason' => 'Pedestrian in ' . $name . ' outside its forklift-only hours (' . $hours . ')'];
    }

    /** Recent events on a camera whose detection time is within ±$win s of $ts. */
    private function recentEvents(string $stream, int $ts, int $win): array
    {
        $st = $this->pdo->prepare('SELECT id, uuid, stream, person_id, trigger_image_type, event_type, policy_name, policy_desc,
                                          decoded_json, trigger_time, received_at, status
                                     FROM events WHERE stream = :s ORDER BY id DESC LIMIT 80');
        $st->execute(['s' => $stream]);
        return array_values(array_filter($st->fetchAll(), static fn ($r) => abs(self::tsOf($r) - $ts) <= $win));
    }

    /** Most recent forklift detection on a camera within ±$win s of $ts. */
    private function nearbyForklift(string $stream, int $ts, int $win): ?array
    {
        $st = $this->pdo->prepare("SELECT r.id, r.op_ppe, e.trigger_time, e.received_at
                                     FROM forklift_events r JOIN events e ON e.id = r.event_id
                                    WHERE r.stream = :s AND (r.kind IS NULL OR r.kind = 'forklift')
                                    ORDER BY r.id DESC LIMIT 40");
        $st->execute(['s' => $stream]);
        foreach ($st->fetchAll() as $r) {
            if (abs(self::tsOf($r) - $ts) <= $win) {
                return $r;
            }
        }
        return null;
    }

    /** Record what a later-arriving operator detection showed on the forklift row (worst state wins). */
    private function noteOperatorOnForklift(int $fkId, array $op): void
    {
        $rank = ['' => 0, 'unknown' => 1, 'ok' => 2, 'missing' => 3];
        $q = $this->pdo->prepare('SELECT op_ppe, op_missing FROM forklift_events WHERE id = :id');
        $q->execute(['id' => $fkId]);
        $cur = $q->fetch() ?: [];
        if (($rank[$op['state']] ?? 0) <= ($rank[(string) ($cur['op_ppe'] ?? '')] ?? 0) && $op['state'] !== 'missing') {
            return;
        }
        $miss = array_values(array_unique(array_merge(array_filter(explode(',', (string) ($cur['op_missing'] ?? ''))), $op['missing'])));
        $this->pdo->prepare('UPDATE forklift_events SET op_ppe = :p, op_missing = :m WHERE id = :id')
            ->execute(['p' => $op['state'] === 'missing' || ($cur['op_ppe'] ?? '') === 'missing' ? 'missing' : $op['state'],
                       'm' => implode(',', $miss), 'id' => $fkId]);
    }

    /**
     * A person recorded as a pedestrian intrusion turned out to be beside a
     * forklift that arrived seconds later: re-file it as the operator — the
     * alert is withdrawn (event resolved, logged in its timeline) unless it
     * was already reviewed.
     */
    private function reclassifyAsOperator(int $eventId, array $dec, array $req): void
    {
        $q = $this->pdo->prepare("SELECT id, reviewed_by FROM forklift_events WHERE event_id = :e AND kind = 'pedestrian'");
        $q->execute(['e' => $eventId]);
        $r = $q->fetch();
        if (!$r || (string) ($r['reviewed_by'] ?? '') !== '') {
            return;
        }
        $this->pdo->prepare("UPDATE forklift_events SET kind = 'operator', verdict = 'logged',
                                    reason = 'Reclassified: person seen with a forklift — treated as its operator' WHERE id = :id")
            ->execute(['id' => $r['id']]);
        $dec['FkKind'] = 'operator';
        $dec['FkVerdict'] = 'logged';
        $this->pdo->prepare('UPDATE events SET decoded_json = :j WHERE id = :id')
            ->execute(['j' => json_encode($dec, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 'id' => $eventId]);
        $u = $this->pdo->prepare('SELECT uuid FROM events WHERE id = :id');
        $u->execute(['id' => $eventId]);
        $uuid = (string) ($u->fetchColumn() ?: '');
        if ($uuid !== '') {
            $this->store->setStatus($uuid, 'resolved', null);
            $this->store->addLog($uuid, 'review', 'system', 'violation', 'logged',
                'Reclassified as forklift operator — a forklift was detected on this camera within ' . $this->operatorWindow() . ' s');
        }
    }

    // ── Storage ──────────────────────────────────────────────

    public function record(int $eventId, array $row, ?array $zone, array $j): void
    {
        $key   = $zone['key'] ?? EventStore::streamLabel((string) ($row['stream'] ?? ''));
        $loc   = (string) (($this->config['poc']['cam_locations'] ?? [])[$key] ?? '');
        $plant = $loc !== '' ? (new Attendance($this->store, $this->config))->plantOf($loc) : '';
        $st = $this->pdo->prepare(
            'INSERT INTO forklift_events (event_id, detected_at, stream, device_name, location, plant, zone, rule, policy,
                                          verdict, reason, image, kind, op_ppe, op_missing, op_viol, person_id)
             VALUES (:e, :t, :s, :d, :l, :p, :z, :ru, :po, :v, :r, :i, :k, :op, :om, :ov, :pid)'
        );
        $op = is_array($j['op'] ?? null) ? $j['op'] : [];
        $st->execute([
            'e' => $eventId, 't' => (string) ($row['received_at'] ?? date('Y-m-d H:i:s')),
            's' => (string) ($row['stream'] ?? ''), 'd' => (string) ($row['device_name'] ?? ''),
            'l' => $loc, 'p' => $plant, 'z' => (string) ($zone['name'] ?? ''), 'ru' => $j['rule'],
            'po' => (string) ($row['policy_name'] ?? ''), 'v' => $j['verdict'], 'r' => $j['reason'],
            'i' => $row['trigger_img_url'] ?? null,
            'k' => (string) ($j['kind'] ?? 'forklift'), 'op' => (string) ($op['state'] ?? ''),
            'om' => implode(',', (array) ($op['missing'] ?? [])), 'ov' => (int) ($op['viol'] ?? 0),
            'pid' => $row['person_id'] ?? null,
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
                    ($verdict === 'violation'
                        ? ['pedestrian' => 'Confirmed pedestrian in forklift-only zone', 'operator' => 'Confirmed forklift operator PPE violation']
                            [(string) ($r['kind'] ?? '')] ?? 'Confirmed forklift zone violation'
                        : 'Cleared as false alarm') . ($note !== '' ? ' — ' . $note : ''));
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
        if (!empty($f['kind'])) {
            $sql .= $f['kind'] === 'forklift' ? " AND (r.kind IS NULL OR r.kind = 'forklift')" : ' AND r.kind = :kind';
            if ($f['kind'] !== 'forklift') {
                $bind['kind'] = $f['kind'];
            }
        }
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
        $k = ['detections' => 0, 'violations' => 0, 'logged' => 0, 'cleared' => 0, 'today' => 0, 'open' => 0,
              'forklifts' => 0, 'pedestrians' => 0, 'pedIntrusions' => 0, 'opViolations' => 0, 'opChecked' => 0, 'opCompliant' => 0];
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
            $kind = (string) ($r['kind'] ?? '') ?: 'forklift';
            $opv  = (int) ($r['op_viol'] ?? 0) === 1 && $v !== 'cleared';
            $k['forklifts']     += $kind === 'forklift' ? 1 : 0;
            $k['pedestrians']   += $kind === 'pedestrian' ? 1 : 0;
            $k['pedIntrusions'] += $kind === 'pedestrian' && $v === 'violation' ? 1 : 0;
            $k['opViolations']  += $opv ? 1 : 0;
            if ($kind === 'forklift' && in_array((string) ($r['op_ppe'] ?? ''), ['ok', 'missing'], true)) {
                $k['opChecked']++;
                $k['opCompliant'] += $r['op_ppe'] === 'ok' ? 1 : 0;
            }
            $z = $r['zone'] ?: strtoupper((string) $r['stream']);
            $byZone[$z] ??= ['zone' => $z, 'plant' => (string) $r['plant'], 'camera' => strtoupper((string) $r['stream']),
                             'rule' => (string) ($r['rule'] ?? ''), 'detections' => 0, 'violations' => 0,
                             'forklifts' => 0, 'pedestrians' => 0, 'operators' => 0, 'pedViolations' => 0, 'opViolations' => 0];
            $byZone[$z]['detections']++;
            $byZone[$z][$kind === 'pedestrian' ? 'pedestrians' : ($kind === 'operator' ? 'operators' : 'forklifts')]++;
            $byZone[$z]['pedViolations'] += $kind === 'pedestrian' && $v === 'violation' ? 1 : 0;
            $byZone[$z]['opViolations']  += $opv ? 1 : 0;
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
            'kind' => (string) ($r['kind'] ?? '') ?: 'forklift', 'opPpe' => (string) ($r['op_ppe'] ?? ''),
            'opMissing' => array_values(array_filter(explode(',', (string) ($r['op_missing'] ?? '')))),
            'opViolation' => (int) ($r['op_viol'] ?? 0) === 1, 'personId' => (string) ($r['person_id'] ?? ''),
        ];
    }

    /** CSV rows: one per forklift detection. */
    public function exportIncidents(array $f): array
    {
        [$rows] = $this->rows($f);
        require_once __DIR__ . '/Ppe.php';
        $out = [['Date', 'Time', 'Plant', 'Zone', 'Rule', 'Location', 'Camera', 'Detection type', 'Policy', 'Verdict', 'Reason',
                 'Operator PPE', 'Operator PPE missing', 'Incident status', 'Reviewed by', 'Reviewed at', 'Review note', 'Image URL']];
        foreach (array_reverse($rows) as $r) {
            $i = $this->item($r);
            $out[] = [substr($i['time'], 0, 10), substr($i['time'], 11, 8), $i['plant'], $i['zone'], $i['rule'], $i['location'],
                      $i['camera'], self::KINDS[$i['kind']] ?? $i['kind'], $i['policy'], self::VERDICTS[$i['verdict']] ?? $i['verdict'], $i['reason'],
                      $i['opPpe'], implode('; ', array_map(static fn ($x) => Ppe::ITEMS[$x] ?? $x, $i['opMissing'])),
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
                            'detections' => 0, 'violation' => 0, 'logged' => 0, 'cleared' => 0,
                            'forklift' => 0, 'pedestrian' => 0, 'pedViol' => 0, 'opViol' => 0];
            $agg[$key]['detections']++;
            $kind = (string) ($r['kind'] ?? '') ?: 'forklift';
            $agg[$key]['forklift']   += $kind === 'forklift' ? 1 : 0;
            $agg[$key]['pedestrian'] += $kind === 'pedestrian' ? 1 : 0;
            $agg[$key]['pedViol']    += $kind === 'pedestrian' && $r['verdict'] === 'violation' ? 1 : 0;
            $agg[$key]['opViol']     += (int) ($r['op_viol'] ?? 0) === 1 && $r['verdict'] !== 'cleared' ? 1 : 0;
            if (isset($agg[$key][$r['verdict']])) {
                $agg[$key][$r['verdict']]++;
            }
        }
        ksort($agg);
        $out = [['Date', 'Plant', 'Zone', 'Camera', 'Rule', 'Detections', 'Violations', 'Logged', 'Cleared (false alarm)',
                 'Forklift detections', 'Pedestrian detections', 'Pedestrian intrusions', 'Operator PPE violations']];
        foreach ($agg as $a) {
            $out[] = [$a['date'], $a['plant'], $a['zone'], $a['camera'], $a['rule'], $a['detections'], $a['violation'], $a['logged'], $a['cleared'],
                      $a['forklift'], $a['pedestrian'], $a['pedViol'], $a['opViol']];
        }
        return $out;
    }
}
