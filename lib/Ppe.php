<?php
/**
 * PPE compliance by area (POC Use Case 2).
 *
 * Every person detection carrying body attributes is checked against the PPE
 * required at its camera's location (Settings → PPE Area Rules). A check is
 * stored in `ppe_checks` whether it passes or not, so compliance rates are
 * real; a failed check also tags the event's decoded map with `PpeMissing`,
 * which makes it a PPE incident everywhere else on the dashboard (incident
 * list, notification bell, email alerts) without a second alert pipeline.
 *
 * Item → attribute:
 *   helmet  HatsType = Helmet (any other head cover / NoHat = missing)
 *   vest    WithReflectiveVest = ReflectiveVest | NoReflectiveVest
 *   gloves  WithGlove = WithGlove | NoGlove
 *   goggles a goggles attribute if the model sends one, else the glasses
 *           estimate (ExpressionType Glasses / SunGlasses vs NoGlasses) as a proxy
 * An item the model did not report is "unchecked", never a violation.
 */

declare(strict_types=1);

require_once __DIR__ . '/EventStore.php';
require_once __DIR__ . '/Attendance.php';
require_once __DIR__ . '/Cleaning.php';

final class Ppe
{
    public const ITEMS = [
        'helmet'  => 'Safety helmet',
        'vest'    => 'Safety vest',
        'goggles' => 'Safety goggles',
        'gloves'  => 'Safety gloves',
        'boots'   => 'Safety boots',
        'hairnet' => 'Hair net',
        'ear'     => 'Ear protection',
    ];

    /**
     * How each item is detected with SenseStudio V2.13 (shown on the PPE page).
     * level: native | proxy | custom.
     */
    public const FEASIBILITY = [
        'helmet'  => ['level' => 'native', 'label' => 'Native', 'how' => 'Pedestrian attribute HatsType = Helmet'],
        'vest'    => ['level' => 'native', 'label' => 'Native', 'how' => 'Pedestrian attribute WithReflectiveVest'],
        'gloves'  => ['level' => 'native', 'label' => 'Native', 'how' => 'Pedestrian attribute WithGlove'],
        'goggles' => ['level' => 'proxy', 'label' => 'Attribute proxy', 'how' => 'Glasses estimate (ExpressionType Glasses / SunGlasses), or a goggles attribute when the model sends one'],
        'boots'   => ['level' => 'proxy', 'label' => 'Attribute proxy', 'how' => 'Pedestrian attribute ShoesType = Boots (another shoe type = missing); a custom SenseStudio safety-boot algorithm / policy is also accepted'],
        'hairnet' => ['level' => 'proxy', 'label' => 'Attribute proxy / custom model', 'how' => 'HatsType Bonnet (configurable list) counts as hair covered; or a custom SenseStudio algorithm / policy named hairnet, hair net or haircap'],
        'ear'     => ['level' => 'custom', 'label' => 'Custom model required', 'how' => 'No native attribute. Detected only from a custom SenseStudio algorithm / policy named ear, earmuff, ear plug or hearing protection'],
    ];

    /** Custom algorithm / policy names that report an item (applies to items without a reliable native attribute). */
    private const CUSTOM_RE = [
        'boots'   => '/safety\s*(boot|shoe)|\bboots?\b|footwear/i',
        'hairnet' => '/hair\s*-?\s*(net|cap)|haircap|hairnet/i',
        'ear'     => '/\bears?\b|ear\s*-?\s*(muff|plug|defender|protect)|earmuff|earplug|hearing/i',
    ];
    /** Words that make a custom policy name a violation ("No hairnet") or a pass ("Hairnet OK"). */
    private const NEG_RE = '/\b(no|non|without|missing|not|absent|lacking|violation|unprotected)\b/i';
    private const POS_RE = '/\b(ok|compliant|wearing|worn|with|present|pass)\b/i';
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

    // ── Rule evaluation (pure) ───────────────────────────────

    /** Policy / algorithm text of an event row or ingest probe (type, policy name, description). */
    public static function policyText(array $e): string
    {
        return trim(($e['trigger_image_type'] ?? '') . ' ' . ($e['event_type'] ?? '') . ' '
            . ($e['policy_name'] ?? '') . ' ' . ($e['policy_desc'] ?? ''));
    }

    /**
     * What a custom SenseStudio algorithm / policy says about an item:
     * false = it reports the item missing ("No hairnet", or an alarm policy
     * named only after the item — alarm policies fire on the violation),
     * true = it reports the item worn ("Hairnet OK"), null = not about it.
     */
    public static function customState(string $item, string $text): ?bool
    {
        $re = self::CUSTOM_RE[$item] ?? null;
        if ($re === null || $text === '' || !preg_match($re, $text)) {
            return null;
        }
        $t = preg_replace('/([a-z])([A-Z])/', '$1 $2', $text) ?? $text;   // "NoHairnet" → "No Hairnet"
        $t = str_replace(['_', '-'], ' ', $t);
        if (preg_match(self::NEG_RE, $t)) {
            return false;
        }
        return preg_match(self::POS_RE, $t) ? true : false;
    }

    /** Items a custom PPE algorithm / policy names explicitly (they become required for that event). */
    public static function customItems(string $text): array
    {
        $out = [];
        foreach (array_keys(self::CUSTOM_RE) as $item) {
            if (self::customState($item, $text) !== null) {
                $out[] = $item;
            }
        }
        return $out;
    }

    /** A decoded attribute from a custom algorithm whose name matches $re (value "No…" = missing). */
    private static function customAttr(string $re, array $dec): ?bool
    {
        foreach ($dec as $k => $v) {
            if (preg_match($re, (string) $k)) {
                return !preg_match('/^(no|without|none|false|0$)/i', trim((string) $v));
            }
        }
        return null;
    }

    /**
     * true = wearing, false = missing, null = the model did not report it.
     * $ctx: policy => policy text of the event (custom algorithms),
     *       hair_hats => HatsType values that count as hair covered.
     */
    public static function itemState(string $item, array $dec, array $ctx = []): ?bool
    {
        $policy = (string) ($ctx['policy'] ?? '');
        switch ($item) {
            case 'boots':
                $c = self::customState('boots', $policy) ?? self::customAttr('/safety.?(boot|shoe)/i', $dec);
                if ($c !== null) {
                    return $c;
                }
                $v = (string) ($dec['ShoesType'] ?? '');
                return $v === '' ? null : (bool) preg_match('/boot/i', $v);
            case 'hairnet':
                $c = self::customState('hairnet', $policy) ?? self::customAttr('/hair.?(net|cap)/i', $dec);
                if ($c !== null) {
                    return $c;
                }
                $v = (string) ($dec['HatsType'] ?? '');
                if ($v === '') {
                    return null;
                }
                $ok = array_map('strtolower', (array) ($ctx['hair_hats'] ?? ['Bonnet']));
                if (in_array(strtolower($v), $ok, true)) {
                    return true;
                }
                // A helmet hides whatever is under it — can't tell.
                return strcasecmp($v, 'Helmet') === 0 ? null : false;
            case 'ear':
                return self::customState('ear', $policy) ?? self::customAttr('/ear.?(muff|plug|protect|defender)|hearing/i', $dec);
        }
        switch ($item) {
            case 'helmet':
                $v = (string) ($dec['HatsType'] ?? '');
                return $v === '' ? null : strcasecmp($v, 'Helmet') === 0;
            case 'vest':
                $v = (string) ($dec['WithReflectiveVest'] ?? '');
                return $v === '' ? null : ($v === 'ReflectiveVest' ? true : ($v === 'NoReflectiveVest' ? false : null));
            case 'gloves':
                $v = (string) ($dec['WithGlove'] ?? '');
                return $v === '' ? null : ($v === 'WithGlove' ? true : ($v === 'NoGlove' ? false : null));
            case 'goggles':
                foreach ($dec as $k => $v) {
                    if (preg_match('/goggle/i', (string) $k)) {
                        return !preg_match('/^no/i', (string) $v);
                    }
                }
                $v = (string) ($dec['ExpressionType'] ?? '');
                if (in_array($v, ['Glasses', 'OrdinaryGlasses', 'SunGlasses'], true)) {
                    return true;
                }
                return $v === 'NoGlasses' ? false : null;
        }
        return null;
    }

    /**
     * PPE required at a location at a moment: the area's standing rule plus
     * the items of any cleaning schedule running there then. `schedule` is
     * the active cleaning session (null outside cleaning periods).
     *
     * @return array{items:list<string>,schedule:?array}
     */
    public static function requirement(string $location, int $ts, array $config): array
    {
        $items = $config['ppe']['rules'][$location] ?? [];
        $sched = null;
        foreach (Cleaning::activeAt($location, $ts, $config['cleaning']['schedules'] ?? []) as $s) {
            $sched ??= $s;
            $items = array_merge($items, $s['items']);
        }
        return ['items' => array_values(array_unique($items)), 'schedule' => $sched];
    }

    /**
     * Check one detection against the required items.
     * Null when nothing is required or the model reported none of the items.
     *
     * @return array{required:list<string>,missing:list<string>,unknown:list<string>}|null
     */
    public static function evaluate(array $dec, array $required, array $ctx = []): ?array
    {
        if (!$required) {
            return null;
        }
        $missing = $unknown = [];
        foreach ($required as $item) {
            $s = self::itemState($item, $dec, $ctx);
            if ($s === null) {
                $unknown[] = $item;
            } elseif ($s === false) {
                $missing[] = $item;
            }
        }
        if (count($unknown) === count($required)) {
            return null;   // nothing PPE-related in this detection
        }
        return ['required' => $required, 'missing' => $missing, 'unknown' => $unknown];
    }

    /** Short text for the PpeMissing tag ("helmet, ear protection"). */
    public static function missingText(array $missing): string
    {
        $short = ['boots' => 'safety boots', 'hairnet' => 'hair net', 'ear' => 'ear protection'];
        return implode(', ', array_map(static fn ($i) => $short[$i] ?? $i, $missing));
    }

    /** Evaluation context (custom-policy text + configured hair-cover hats) for an event. */
    public static function ctx(array $config, string $policyText): array
    {
        return ['policy' => $policyText, 'hair_hats' => $config['ppe']['hair_hats'] ?? ['Bonnet']];
    }

    /**
     * Full PPE check of one detection at a location: the area rule plus any
     * cleaning-session items, plus items a custom SenseStudio PPE algorithm
     * names on this event (e.g. a "No ear protection" policy is checked even
     * where no area rule asks for ear protection).
     *
     * @return array{eval:?array,req:?array}
     */
    public static function check(array $dec, string $location, int $ts, array $config, string $policyText): array
    {
        $req = $location !== '' ? self::requirement($location, $ts, $config) : ['items' => [], 'schedule' => null];
        $req['items'] = array_values(array_unique(array_merge($req['items'], self::customItems($policyText))));
        if (!$req['items']) {
            return ['eval' => null, 'req' => null];
        }
        return ['eval' => self::evaluate($dec, $req['items'], self::ctx($config, $policyText)), 'req' => $req];
    }

    /** Camera point name for a stream / device ('' when the camera is not mapped). */
    public function locationOf(?string $stream, ?string $device): string
    {
        $key = EventStore::streamLabel((string) ($stream ?: $device ?: ''));
        return (string) (($this->config['poc']['cam_locations'] ?? [])[$key] ?? '');
    }

    // ── Storage ──────────────────────────────────────────────

    public function record(int $eventId, array $row, array $eval, string $location, ?array $schedule = null): void
    {
        $plant = (new Attendance($this->store, $this->config))->plantOf($location);
        $st = $this->pdo->prepare(
            'INSERT INTO ppe_checks (event_id, checked_at, stream, device_name, location, plant,
                                     required, missing, unknown, image, person_id, schedule_id, schedule_name)
             VALUES (:e, :t, :s, :d, :l, :p, :r, :m, :u, :i, :pid, :sid, :sn)'
        );
        $st->execute([
            'e' => $eventId, 't' => (string) ($row['received_at'] ?? date('Y-m-d H:i:s')),
            's' => (string) ($row['stream'] ?? ''), 'd' => (string) ($row['device_name'] ?? ''),
            'l' => $location, 'p' => $plant,
            'r' => implode(',', $eval['required']), 'm' => implode(',', $eval['missing']),
            'u' => implode(',', $eval['unknown']),
            'i' => $row['trigger_img_url'] ?? null, 'pid' => $row['person_id'] ?? null,
            'sid' => $schedule['id'] ?? null, 'sn' => $schedule['name'] ?? null,
        ]);
    }

    /**
     * Check detections that arrived before the rules existed (or before this
     * code shipped). A cursor in storage/ppe_cursor.json remembers the last
     * event id scanned, so each event is checked once.
     */
    public function catchUp(): int
    {
        $rules = ($this->config['ppe']['rules'] ?? []) || ($this->config['cleaning']['schedules'] ?? []);
        $file  = dirname(__DIR__) . '/storage/ppe_cursor.json';
        $cur   = is_file($file) ? (int) ((json_decode((string) file_get_contents($file), true) ?: [])['last'] ?? 0) : 0;
        if ($cur === 0) {
            // First run: start 30 days back rather than at the beginning of time.
            $q = $this->pdo->prepare('SELECT MIN(id) FROM events WHERE received_at >= :f');
            $q->execute(['f' => date('Y-m-d H:i:s', time() - 30 * 86400)]);
            $cur = max(0, (int) $q->fetchColumn() - 1);
        }
        $st = $this->pdo->prepare('SELECT id, stream, device_name, received_at, trigger_img_url, person_id, decoded_json,
                                          trigger_image_type, event_type, policy_name, policy_desc
                                     FROM events WHERE id > :c ORDER BY id ASC LIMIT ' . self::CATCHUP_BATCH);
        $st->execute(['c' => $cur]);
        $done = 0;
        $upd  = $this->pdo->prepare('UPDATE events SET decoded_json = :j WHERE id = :id');
        $seen = $this->pdo->prepare('SELECT COUNT(*) FROM ppe_checks WHERE event_id = :id');
        foreach ($st->fetchAll() as $r) {
            $cur = (int) $r['id'];
            if (!$rules) {
                continue;
            }
            $dec = json_decode((string) ($r['decoded_json'] ?? ''), true) ?: [];
            $loc = $this->locationOf($r['stream'] ?? null, $r['device_name'] ?? null);
            $chk = self::check($dec, $loc, strtotime((string) $r['received_at']) ?: time(), $this->config, self::policyText($r));
            $req = $chk['req'];
            $ev  = $chk['eval'];
            if ($ev === null) {
                continue;
            }
            $seen->execute(['id' => $cur]);
            if ((int) $seen->fetchColumn() > 0) {
                continue;   // already checked at ingest
            }
            $this->record($cur, $r, $ev, $loc, $req['schedule']);
            if ($ev['missing'] && empty($dec['PpeMissing'])) {
                $dec['PpeMissing'] = self::missingText($ev['missing']);
                if ($req['schedule']) {
                    $dec['PpeCleaning'] = $req['schedule']['name'];
                }
                $upd->execute(['j' => json_encode($dec, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 'id' => $cur]);
            }
            $done++;
        }
        @file_put_contents($file, json_encode(['last' => $cur, 'at' => date('c')]), LOCK_EX);
        return $done;
    }

    // ── Dashboard + reports ──────────────────────────────────

    /** Checks in the filtered window, oldest first. */
    private function checks(array $f): array
    {
        $from = Attendance::cleanDate((string) ($f['from'] ?? ''));
        $to   = Attendance::cleanDate((string) ($f['to'] ?? $from));
        if ($to < $from) {
            [$from, $to] = [$to, $from];
        }
        $sql  = 'SELECT * FROM ppe_checks WHERE checked_at >= :f AND checked_at < :t';
        $bind = ['f' => $from . ' 00:00:00', 't' => date('Y-m-d', strtotime($to) + 86400) . ' 00:00:00'];
        foreach (['plant' => 'plant', 'location' => 'location', 'camera' => 'stream', 'schedule' => 'schedule_id'] as $k => $col) {
            if (!empty($f[$k])) {
                $sql .= " AND {$col} = :{$k}";
                $bind[$k] = $f[$k];
            }
        }
        if (!empty($f['cleaning'])) {
            $sql .= " AND schedule_id IS NOT NULL AND schedule_id <> ''";   // checks made during cleaning sessions
        }
        $st = $this->pdo->prepare($sql . ' ORDER BY id ASC LIMIT 50000');
        $st->execute($bind);
        $item = (string) ($f['item'] ?? '');
        $out  = [];
        foreach ($st->fetchAll() as $r) {
            $req = array_values(array_filter(explode(',', (string) $r['required'])));
            $mis = array_values(array_filter(explode(',', (string) $r['missing'])));
            if ($item !== '' && !in_array($item, $req, true)) {
                continue;   // PPE-type filter: only checks where that item was required
            }
            $r['req']  = $req;
            $r['mis']  = $mis;
            $r['unk']  = array_values(array_filter(explode(',', (string) $r['unknown'])));
            $r['fail'] = $item !== '' ? in_array($item, $mis, true) : (bool) $mis;
            $out[] = $r;
        }
        return [$out, $from, $to];
    }

    public function summary(array $f): array
    {
        [$rows, $from, $to] = $this->checks($f);
        $today = date('Y-m-d');
        $k = ['checks' => 0, 'violations' => 0, 'today' => 0, 'compliance' => null];
        $byItem = array_fill_keys(array_keys(self::ITEMS), ['required' => 0, 'missing' => 0]);
        $daily = $byLoc = $byCam = [];
        for ($d = strtotime($from); $d <= strtotime($to) && count($daily) < 92; $d += 86400) {
            $daily[date('Y-m-d', $d)] = ['checks' => 0, 'violations' => 0];
        }
        foreach ($rows as $r) {
            $day = substr((string) $r['checked_at'], 0, 10);
            $k['checks']++;
            $daily[$day]['checks'] = ($daily[$day]['checks'] ?? 0) + 1;
            $loc = $r['location'] ?: '—';
            $byLoc[$loc] ??= ['location' => $loc, 'plant' => $r['plant'], 'checks' => 0, 'violations' => 0, 'required' => $r['req']];
            $byLoc[$loc]['checks']++;
            foreach ($r['req'] as $it) {
                if (isset($byItem[$it])) {
                    $byItem[$it]['required']++;
                }
            }
            foreach ($r['mis'] as $it) {
                if (isset($byItem[$it])) {
                    $byItem[$it]['missing']++;
                }
            }
            if ($r['fail']) {
                $k['violations']++;
                $daily[$day]['violations'] = ($daily[$day]['violations'] ?? 0) + 1;
                $byLoc[$loc]['violations']++;
                $cam = strtoupper((string) $r['stream']);
                $byCam[$cam] = ($byCam[$cam] ?? 0) + 1;
                if ($day === $today) {
                    $k['today']++;
                }
            }
        }
        $k['compliance'] = $k['checks'] ? round(100 * ($k['checks'] - $k['violations']) / $k['checks'], 1) : null;
        arsort($byCam);

        $list = [];
        foreach (array_reverse($rows) as $r) {
            if (!$r['fail']) {
                continue;
            }
            if (count($list) >= 200) {
                break;
            }
            $list[] = $this->violationRow($r);
        }
        return [
            'from' => $from, 'to' => $to, 'kpi' => $k,
            'daily' => array_map(static fn ($d, $v) => ['date' => $d] + $v, array_keys($daily), $daily),
            'byItem' => $byItem, 'byLocation' => array_values($byLoc), 'byCamera' => $byCam,
            'violations' => $list,
        ];
    }

    private function violationRow(array $r): array
    {
        $ev = null;
        $q  = $this->pdo->prepare('SELECT uuid FROM events WHERE id = :id');
        $q->execute(['id' => $r['event_id']]);
        $ev = $q->fetchColumn() ?: null;
        return [
            'id' => (int) $r['id'], 'eventId' => (int) $r['event_id'], 'uuid' => $ev,
            'time' => (string) $r['checked_at'], 'camera' => strtoupper((string) $r['stream']),
            'device' => (string) $r['device_name'], 'location' => (string) $r['location'],
            'plant' => (string) $r['plant'], 'required' => $r['req'], 'missing' => $r['mis'],
            'unchecked' => $r['unk'], 'personId' => (string) ($r['person_id'] ?? ''),
            'schedule' => (string) ($r['schedule_name'] ?? ''),
            'image' => $this->store->fullUrl($r['image'] ?? null),
        ];
    }

    /** CSV rows: every violation in the window. */
    public function exportViolations(array $f): array
    {
        [$rows] = $this->checks($f);
        $label  = static fn (array $l) => implode('; ', array_map(static fn ($i) => self::ITEMS[$i] ?? $i, $l));
        $out = [['Date', 'Time', 'Plant', 'Location', 'Camera', 'Device', 'Missing PPE', 'Required PPE',
                 'Not checked by model', 'Cleaning session', 'Person ID', 'Image URL']];
        foreach (array_reverse($rows) as $r) {
            if (!$r['fail']) {
                continue;
            }
            $v = $this->violationRow($r);
            $out[] = [substr($v['time'], 0, 10), substr($v['time'], 11, 8), $v['plant'], $v['location'], $v['camera'],
                      $v['device'], $label($v['missing']), $label($v['required']), $label($v['unchecked']),
                      $v['schedule'], $v['personId'], (string) $v['image']];
        }
        return $out;
    }

    /** CSV rows: compliance per day and location, with misses per PPE item. */
    public function exportCompliance(array $f): array
    {
        [$rows] = $this->checks($f);
        $agg = [];
        foreach ($rows as $r) {
            $key = substr((string) $r['checked_at'], 0, 10) . '|' . $r['location'];
            $agg[$key] ??= ['date' => substr((string) $r['checked_at'], 0, 10), 'plant' => $r['plant'],
                            'location' => $r['location'], 'required' => $r['req'], 'checks' => 0, 'violations' => 0,
                            'miss' => array_fill_keys(array_keys(self::ITEMS), 0)];
            $agg[$key]['checks']++;
            if ($r['fail']) {
                $agg[$key]['violations']++;
            }
            foreach ($r['mis'] as $it) {
                if (isset($agg[$key]['miss'][$it])) {
                    $agg[$key]['miss'][$it]++;
                }
            }
        }
        ksort($agg);
        $out = [array_merge(['Date', 'Plant', 'Location', 'Required PPE', 'People checked', 'Compliant', 'Violations', 'Compliance %'],
            array_map(static fn ($l) => 'No ' . strtolower(str_replace('Safety ', '', $l)), array_values(self::ITEMS)))];
        foreach ($agg as $a) {
            $out[] = array_merge([$a['date'], $a['plant'], $a['location'],
                implode('; ', array_map(static fn ($i) => self::ITEMS[$i] ?? $i, $a['required'])),
                $a['checks'], $a['checks'] - $a['violations'], $a['violations'],
                $a['checks'] ? round(100 * ($a['checks'] - $a['violations']) / $a['checks'], 1) : ''],
                array_values($a['miss']));
        }
        return $out;
    }
}

