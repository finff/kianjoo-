<?php
/**
 * Detection simulator (Settings → Detection simulator).
 *
 * Generates a realistic week of SenseStudio push events and feeds them through
 * the same EventStore::store() path the /api/ingest webhook uses — so every
 * module (attendance register, PPE checks, restricted zones, cleaning windows,
 * forklift zones, incidents, trends, Overview) is exercised exactly as it
 * would be by live cameras. Nothing is mocked downstream of the ingest.
 *
 * Everything the simulator creates is namespaced so it can be removed again:
 *   cameras    DEMOGATE1 / DEMOGATE2 (clock points), DEMOLOBBY, DEMOLINE5,
 *              DEMOWASTE9 (restricted zone), DEMODOCK (forklift zone) — keys are
 *              alphanumeric because EventStore::streamLabel() strips everything else
 *   employees  person ids demo-p1 … demo-p8 (staff IDs KJ-0101 … KJ-0108)
 *   config     cam_locations / att_cam_roles / ra_zones / fk_zones entries for
 *              those cameras, the "Loading Dock" plant mapping and one cleaning
 *              schedule (id demo-clean-line5) around the current time
 *
 * Simulated events never send e-mail alerts or forward to Firebase / Weststar
 * AI (EventStore::$silent). Re-running replaces the previous simulated events.
 */

declare(strict_types=1);

require_once __DIR__ . '/EventStore.php';
require_once __DIR__ . '/Attendance.php';

final class Simulator
{
    public const PREFIX      = 'demo-';
    private const CLEAN_ID   = 'demo-clean-line5';
    private const LOC_DOCK   = 'Loading Dock';
    private const LOC_LINE5  = 'Line 5';
    private const LOC_WASTE  = 'Waste Area — Spot 9';

    /** stream key → [camera point, plant index, attendance role] */
    private const CAMS = [
        'demogate1'  => ['Plant 1 Guard Post', 0, 'both'],
        'demogate2'  => ['Plant 2 Guard Post', 1, 'both'],
        'demolobby'  => ['Lobby Entrance',     0, 'movement'],
        'demoline5'  => [self::LOC_LINE5,      0, 'movement'],
        'demowaste9' => [self::LOC_WASTE,      1, 'movement'],
        'demodock'   => [self::LOC_DOCK,       0, 'movement'],
    ];

    /** [person id, name, staff id, gender, department, plant index] */
    private const PEOPLE = [
        ['demo-p1', 'Ahmad Faizal',   'KJ-0101', 'male',   'Production',  0],
        ['demo-p2', 'Nur Aisyah',     'KJ-0102', 'female', 'Quality',     0],
        ['demo-p3', 'Ravi Kumar',     'KJ-0103', 'male',   'Maintenance', 1],
        ['demo-p4', 'Chen Wei Ling',  'KJ-0104', 'female', 'Warehouse',   0],
        ['demo-p5', 'Siti Rahmah',    'KJ-0105', 'female', 'Production',  1],
        ['demo-p6', 'Muhammad Hafiz', 'KJ-0106', 'male',   'Maintenance', 0],
        ['demo-p7', 'Tan Mei Ling',   'KJ-0107', 'female', 'Admin',       0],
        ['demo-p8', 'Arjun Nair',     'KJ-0108', 'male',   'Warehouse',   1],
    ];

    private PDO $pdo;
    private array $config;
    private string $settingsFile;
    private array $plants;
    private array $counts = [];

    public function __construct(PDO $pdo, array $config, string $settingsFile)
    {
        $this->pdo          = $pdo;
        $this->config       = $config;
        $this->settingsFile = $settingsFile;
        $p = array_values($config['attendance']['plants'] ?? []);
        $this->plants = [(string) ($p[0] ?? 'Plant 1'), (string) ($p[1] ?? ($p[0] ?? 'Plant 2'))];
    }

    // ── Public entry points ──────────────────────────────────

    /** Generate $days of activity (today included). Replaces earlier simulated events. */
    public function run(int $days, string $actor): array
    {
        $days = max(1, min(14, $days));
        $this->counts = ['events' => 0, 'employees' => 0, 'face' => 0, 'ppe' => 0, 'restricted' => 0,
                         'forklift' => 0, 'fire' => 0, 'stranger' => 0, 'cleaning' => 0];
        mt_srand(20261020 + (int) date('z'));

        $this->purgeEvents();
        $cleaning = $this->setupConfig();          // persists + applies everything except the cleaning window
        $store = new EventStore($this->pdo, $this->config);
        $store->silent = true;
        $this->setupEmployees($store, $actor);
        $this->generate($store, $days);

        // The cleaning schedule is applied last: PPE checks are matched against
        // schedules at ingest time (wall clock), so adding it earlier would tag
        // every back-dated Line 5 check as "during cleaning".
        $this->config['cleaning']['schedules'][] = $cleaning;
        $store = new EventStore($this->pdo, $this->config);
        $store->silent = true;
        $this->generateCleaning($store);

        $this->triage();
        $this->clearCaches();
        return ['days' => $days, 'counts' => $this->counts];
    }

    /** Remove every simulated event, the demo employees and the demo configuration. */
    public function reset(): array
    {
        $events = $this->purgeEvents();
        $st = $this->pdo->prepare("DELETE FROM person_profiles WHERE person_id LIKE :p");
        $st->execute(['p' => self::PREFIX . '%']);
        $employees = $st->rowCount();
        try {
            $this->pdo->prepare("DELETE FROM face_templates WHERE person_id LIKE :p")->execute(['p' => self::PREFIX . '%']);
        } catch (Throwable $e) {
            // table may not exist yet
        }

        $app = $this->loadSettings();
        foreach (['cam_locations', 'att_cam_roles', 'ra_zones', 'fk_zones'] as $k) {
            if (is_array($app[$k] ?? null)) {
                $app[$k] = array_filter($app[$k], static fn ($key) => !isset(self::CAMS[(string) $key]), ARRAY_FILTER_USE_KEY);
                if ($k !== 'cam_locations' && $k !== 'att_cam_roles') {
                    $app[$k] = (object) $app[$k];
                }
            }
        }
        if (is_array($app['att_loc_plants'] ?? null)) {
            unset($app['att_loc_plants'][self::LOC_DOCK]);
        }
        if (is_array($app['cleaning_schedules'] ?? null)) {
            $app['cleaning_schedules'] = array_values(array_filter($app['cleaning_schedules'],
                static fn ($s) => !is_array($s) || ($s['id'] ?? '') !== self::CLEAN_ID));
        }
        $this->saveSettings($app);
        $this->clearCaches();
        return ['counts' => ['events' => $events, 'employees' => $employees]];
    }

    // ── Configuration ────────────────────────────────────────

    private function loadSettings(): array
    {
        return is_file($this->settingsFile) ? (json_decode((string) file_get_contents($this->settingsFile), true) ?: []) : [];
    }

    private function saveSettings(array $app): void
    {
        $dir = dirname($this->settingsFile);
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        file_put_contents($this->settingsFile, json_encode($app, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX);
    }

    /** A department name that exists in the configured list ('' when none matches). */
    private function dept(string $want): string
    {
        $list = $this->config['attendance']['departments'] ?? [];
        foreach ($list as $d) {
            if (strcasecmp((string) $d, $want) === 0) {
                return (string) $d;
            }
        }
        return '';
    }

    /**
     * Persist the demo cameras, zones, rules and cleaning schedule to
     * app_settings.json and apply the same (already-sanitised) shapes to the
     * in-memory config. Returns the cleaning schedule, which the caller applies
     * only for the cleaning-window events.
     */
    private function setupConfig(): array
    {
        $app   = $this->loadSettings();
        $arr   = static fn ($v) => is_array($v) ? $v : (is_object($v) ? (array) $v : []);
        $loc   = $arr($app['cam_locations'] ?? null);
        $roles = $arr($app['att_cam_roles'] ?? null);
        $lp    = $arr($app['att_loc_plants'] ?? null);
        $ra    = $arr($app['ra_zones'] ?? null);
        $fk    = $arr($app['fk_zones'] ?? null);
        $pr    = array_key_exists('ppe_rules', $app) ? $arr($app['ppe_rules']) : ($this->config['ppe']['rules'] ?? []);
        $cl    = array_values(array_filter($arr($app['cleaning_schedules'] ?? null), 'is_array'));

        foreach (self::CAMS as $key => [$location, $pi, $role]) {
            $loc[$key]   = $location;
            $roles[$key] = $role;
            $lp[$location] = $lp[$location] ?? $this->plants[$pi];
        }
        $pr[self::LOC_LINE5] = $pr[self::LOC_LINE5] ?? ['gloves', 'goggles'];
        $pr[self::LOC_WASTE] = $pr[self::LOC_WASTE] ?? ['helmet', 'vest'];
        $maint = $this->dept('Maintenance') ?: (string) (($this->config['attendance']['departments'] ?? [])[0] ?? '');
        $ra['demowaste9'] = ['enabled' => true, 'name' => self::LOC_WASTE, 'hours' => 'always', 'staff' => [],
                              'depts' => array_values(array_filter([$maint]))];
        $fk['demodock']   = ['enabled' => true, 'name' => self::LOC_DOCK, 'rule' => 'prohibited', 'hours' => 'always',
                              'note' => 'Demo zone — simulated forklift traffic'];
        $now = time();
        $cleaning = ['id' => self::CLEAN_ID, 'name' => 'Line 5 shift-change clean', 'location' => self::LOC_LINE5,
                     'start' => date('H:i', $now - 80 * 60), 'end' => date('H:i', $now + 40 * 60),
                     'days' => [], 'dates' => [date('Y-m-d')], 'items' => ['gloves', 'goggles'], 'enabled' => true];
        $cl = array_values(array_filter($cl, static fn ($s) => ($s['id'] ?? '') !== self::CLEAN_ID));
        $cl[] = $cleaning;

        $app['cam_locations']      = $loc;
        $app['att_cam_roles']      = $roles;
        $app['att_loc_plants']     = $lp;
        $app['ppe_rules']          = (object) $pr;
        $app['ra_zones']           = (object) $ra;
        $app['fk_zones']           = (object) $fk;
        $app['cleaning_schedules'] = $cl;
        $this->saveSettings($app);

        // Mirror into the running config (same shapes config.php produces).
        $c = &$this->config;
        foreach (self::CAMS as $key => [$location, $pi, $role]) {
            $c['poc']['cam_locations'][$key]     = $location;
            $c['attendance']['cam_roles'][$key]  = $role;
            $c['attendance']['loc_plants'][$location] = $lp[$location];
        }
        $c['ppe']['rules'] = $pr;
        $c['restricted']['zones']['demowaste9'] = $ra['demowaste9'];
        $c['forklift']['zones']['demodock']     = $fk['demodock'];
        $c['cleaning']['schedules'] = array_values(array_filter($c['cleaning']['schedules'] ?? [],
            static fn ($s) => ($s['id'] ?? '') !== self::CLEAN_ID));
        unset($c);
        return $cleaning;
    }

    private function setupEmployees(EventStore $store, string $actor): void
    {
        $shift = (string) (($this->config['attendance']['shifts'][0]['id'] ?? ''));
        foreach (self::PEOPLE as [$pid, $name, $staff, $gender, $dept, $pi]) {
            $store->savePersonProfile($pid, [
                'name' => $name, 'staff_id' => $staff, 'gender' => $gender, 'age' => '',
                'about' => 'Demo employee — generated by the detection simulator',
                'department' => $this->dept($dept), 'plant' => $this->plants[$pi], 'shift' => $shift, 'active' => true,
            ], $actor);
            $this->counts['employees']++;
        }
    }

    // ── Generation ───────────────────────────────────────────

    private function generate(EventStore $store, int $days): void
    {
        $now   = time();
        $shift = $this->config['attendance']['shifts'][0] ?? ['start' => '08:00', 'end' => '17:00', 'days' => [1, 2, 3, 4, 5], 'grace' => 10];
        [$sh, $sm] = array_map('intval', explode(':', (string) $shift['start']));
        [$eh, $em] = array_map('intval', explode(':', (string) $shift['end']));
        $maint = array_values(array_filter(self::PEOPLE, static fn ($p) => $p[4] === 'Maintenance'));
        $others = array_values(array_filter(self::PEOPLE, static fn ($p) => $p[4] !== 'Maintenance'));

        for ($d = $days - 1; $d >= 0; $d--) {
            $base  = strtotime(date('Y-m-d', $now - $d * 86400) . ' 00:00:00');
            $start = $base + $sh * 3600 + $sm * 60;
            $end   = $base + $eh * 3600 + $em * 60;
            if ($end <= $start) {
                $end += 86400;
            }
            $scheduled = in_array((int) date('N', $base), (array) ($shift['days'] ?? [1, 2, 3, 4, 5]), true);

            // ── Attendance: clock-in / movement / clock-out per employee ──
            if ($scheduled) {
                foreach (self::PEOPLE as [$pid, $name, $staff, $gender, $dept, $pi]) {
                    if (mt_rand(1, 100) <= 8) {
                        continue;                                   // absent today
                    }
                    $in = $start + mt_rand(-25, 35) * 60;
                    if ($in > $now) {
                        continue;                                   // shift not started yet
                    }
                    $gate = $pi === 0 ? 'demogate1' : 'demogate2';
                    $this->face($store, $gate, $pid, $name, $gender, $in);
                    $moves = mt_rand(0, 2);
                    for ($i = 0; $i < $moves; $i++) {
                        $t = $in + 3600 + mt_rand(0, max(600, $end - $in - 7200));
                        if ($t < $now) {
                            $cam = $pi === 0 ? (mt_rand(0, 1) ? 'demolobby' : 'demoline5') : 'demowaste9';
                            $this->face($store, $cam, $pid, $name, $gender, $t);
                        }
                    }
                    $out = $end + mt_rand(-20, 45) * 60;
                    if ($out < $now && mt_rand(1, 100) > 10) {       // 10 % forget to clock out
                        $this->face($store, $gate, $pid, $name, $gender, $out);
                    }
                }
            }

            // ── PPE checks at Line 5 (gloves + goggles) ──
            $n = mt_rand(10, 16);
            for ($i = 0; $i < $n; $i++) {
                $t = $base + 8 * 3600 + 1800 + mt_rand(0, 8 * 3600);
                if ($t > $now) {
                    continue;
                }
                $viol = mt_rand(1, 100) <= 18;
                $this->body($store, 'demoline5', 'Body Attributes — Line 5', $t, [
                    'gloves'  => !($viol && mt_rand(0, 1) === 0),
                    'goggles' => !($viol && mt_rand(0, 1) === 0) || !$viol,
                ]);
            }

            // ── PPE checks at Spot 9 (helmet + vest) ──
            $n = mt_rand(4, 8);
            for ($i = 0; $i < $n; $i++) {
                $t = $base + 9 * 3600 + mt_rand(0, 7 * 3600);
                if ($t > $now) {
                    continue;
                }
                $viol = mt_rand(1, 100) <= 20;
                $this->body($store, 'demowaste9', 'Body Attributes — Spot 9', $t, [
                    'helmet' => !($viol && mt_rand(0, 1) === 0),
                    'vest'   => !$viol || mt_rand(0, 1) === 0,
                ]);
            }

            // ── Restricted zone entries at Spot 9 ──
            $n = mt_rand(2, 4);
            for ($i = 0; $i < $n; $i++) {
                $t = $base + 7 * 3600 + mt_rand(0, 11 * 3600);
                if ($t > $now) {
                    continue;
                }
                $r = mt_rand(1, 100);
                $who = $r <= 40 ? $maint[array_rand($maint)] : ($r <= 70 ? $others[array_rand($others)] : null);
                $this->intrusion($store, $t, $who);
            }

            // ── Forklift movements on the loading dock ──
            $n = mt_rand(2, 4);
            for ($i = 0; $i < $n; $i++) {
                $t = $base + 8 * 3600 + mt_rand(0, 9 * 3600);
                if ($t <= $now) {
                    $this->vehicle($store, $t);
                }
            }

            // ── Smoking (every other day) and one stranger at the gate ──
            if ($d % 2 === 0) {
                $t = $base + 10 * 3600 + mt_rand(0, 6 * 3600);
                if ($t <= $now) {
                    $this->body($store, 'demoline5', 'Smoking Detection — Line 5', $t, ['smoking' => true]);
                    $this->counts['fire']++;
                }
            }
            $t = $base + 7 * 3600 + mt_rand(0, 10 * 3600);
            if ($t <= $now) {
                $this->face($store, 'demogate1', null, '', mt_rand(0, 1) ? 'male' : 'female', $t);
                $this->counts['stranger']++;
            }
        }
    }

    /** PPE checks inside today's cleaning window (last ~80 min), one missing gloves. */
    private function generateCleaning(EventStore $store): void
    {
        $now = time();
        for ($i = 0; $i < 4; $i++) {
            $t = $now - mt_rand(5, 75) * 60;
            $this->body($store, 'demoline5', 'Body Attributes — Line 5', $t, ['gloves' => $i !== 1, 'goggles' => true]);
            $this->counts['cleaning']++;
        }
    }

    // ── Payload builders (SenseStudio §6.5 push shape) ───────

    private function common(string $stream, string $policy, string $desc, string $trigger, int $ts, string $alert): array
    {
        [$location] = self::CAMS[$stream];
        return [
            'uuid'             => 'demo-' . bin2hex(random_bytes(8)),
            'triggerEventId'   => (string) mt_rand(100000000, 999999999),
            'msgSource'        => 'bizTrigger',
            'eventType'        => $trigger === 'faceCapture' ? 'faceMonitorTriggerEvent' : 'imageMonitorTriggerEvent',
            'policyId'         => (string) crc32($policy),
            'policyName'       => $policy,
            'policyType'       => '10',
            'policyDesc'       => $desc,
            'triggerImageType' => $trigger,
            'deviceId'         => (string) crc32($stream),
            'deviceSerial'     => strtoupper($stream),
            'deviceName'       => $location . ' camera',
            'deviceTag'        => 'demo',
            'alertLevel'       => $alert,
            'triggerTime'      => date('Y-m-d H:i:s', $ts) . '.000',
            'triggerImgUrl'    => '',
            'bkImageUrl'       => '',
            'matchImageUrl'    => '',
            'detect'           => ['left' => (string) mt_rand(200, 1400), 'top' => (string) mt_rand(150, 700),
                                   'right' => (string) mt_rand(1500, 2300), 'bottom' => (string) mt_rand(800, 1350)],
            'actionContent'    => 'simulator',
        ];
    }

    private static function attr(string $key, string $value): array
    {
        return ['key' => $key, 'value' => $value, 'conf' => sprintf('%.4f', mt_rand(82, 99) / 100)];
    }

    private function personAttrs(string $gender): array
    {
        return [
            self::attr('5', $gender === 'female' ? '1' : '0'),      // Gender
            self::attr('4', '0'),                                    // Age: Adult
            self::attr('11', (string) mt_rand(0, 9)),                // TopsColor
            self::attr('22', (string) [3, 4, 6][mt_rand(0, 2)]),     // TopsType
            self::attr('-1', '1'),                                   // person presence
        ];
    }

    /** Face recognition at a camera; $pid null = stranger (person group −99). */
    private function face(EventStore $store, string $stream, ?string $pid, string $name, string $gender, int $ts): void
    {
        [$location] = self::CAMS[$stream];
        $p = $this->common($stream, 'Face Recognition — ' . $location, 'Employee face recognition', 'faceCapture', $ts, $pid ? '0' : '2');
        $p['attributes'] = $this->personAttrs($gender);
        if ($pid !== null) {
            $p['personId']   = $pid;
            $p['personName'] = $name;
            $p['similarity'] = sprintf('0.%d', mt_rand(88, 98));
            $p['groupName']  = 'Kian Joo ' . $this->plants[0];
        } else {
            $p['personName']     = '';
            $p['triggerTargets'] = [['classId' => '0', 'targetId' => '0', 'targetValue' => '-99', 'operator' => '2']];
        }
        $this->emit($store, $p, $stream, 'face', $ts);
        $this->counts['face']++;
    }

    /**
     * Body-attribute detection. $wear: helmet / vest / gloves / goggles → true
     * (worn) | false (missing); smoking → true adds an IsSmoking attribute.
     */
    private function body(EventStore $store, string $stream, string $policy, int $ts, array $wear): void
    {
        $p = $this->common($stream, $policy, 'Detect Body Attribute', 'humanAttribute', $ts, '0');
        $a = $this->personAttrs(mt_rand(0, 1) ? 'male' : 'female');
        if (array_key_exists('helmet', $wear)) {
            $a[] = self::attr('16', $wear['helmet'] ? '9' : '0');          // HatsType: Helmet / NoHat
        }
        if (array_key_exists('vest', $wear)) {
            $a[] = self::attr('62', $wear['vest'] ? '0' : '1');            // WithReflectiveVest
        }
        if (array_key_exists('gloves', $wear)) {
            $a[] = self::attr('60', $wear['gloves'] ? '0' : '1');          // WithGlove
        }
        if (array_key_exists('goggles', $wear)) {
            $a[] = self::attr('56', $wear['goggles'] ? '2' : '10');        // ExpressionType: glasses estimate
        }
        if (!empty($wear['smoking'])) {
            $a[] = self::attr('63', '0');                                  // Smoking: IsSmoking
            $p['alertLevel'] = '2';
        }
        $p['attributes'] = $a;
        $this->emit($store, $p, $stream, 'body', $ts);
        $this->counts['ppe']++;
    }

    /** Boundary-crossing at the restricted Spot 9 zone; $who = PEOPLE row or null (unidentified). */
    private function intrusion(EventStore $store, int $ts, ?array $who): void
    {
        $p = $this->common('demowaste9', 'Restricted Zone — Spot 9', 'Zone intrusion (virtual boundary)', 'roiIntrusion', $ts, '1');
        $p['attributes'] = $this->personAttrs($who ? $who[3] : (mt_rand(0, 1) ? 'male' : 'female'));
        if ($who) {
            $p['personId']   = $who[0];
            $p['personName'] = $who[1];
            $p['similarity'] = sprintf('0.%d', mt_rand(86, 97));
        }
        $this->emit($store, $p, 'demowaste9', null, $ts);
        $this->counts['restricted']++;
    }

    /** Vehicle detection on the (prohibited) loading-dock forklift zone. */
    private function vehicle(EventStore $store, int $ts): void
    {
        $p = $this->common('demodock', 'Vehicle Detection — Loading Dock', 'Detect vehicle attributes', 'vehicleCapture', $ts, '1');
        $p['attributes'] = [
            self::attr('-3', '1'),                                 // All(Vehicle): Yes
            self::attr('2', (string) mt_rand(1, 3)),               // VehicleType: Van / SmallTruck / BigTruck
            self::attr('1', (string) mt_rand(0, 7)),               // VehicleColor
        ];
        $this->emit($store, $p, 'demodock', 'body', $ts);
        $this->counts['forklift']++;
    }

    // ── Storage helpers ──────────────────────────────────────

    private function emit(EventStore $store, array $payload, string $stream, ?string $feed, int $ts): void
    {
        $row = $store->store($payload, $stream, '127.0.0.1', $feed);
        $this->backdate((int) $row['id'], $ts);
        $this->counts['events']++;
    }

    /** Move a stored event (and its module rows) to the simulated time. */
    private function backdate(int $id, int $ts): void
    {
        $t = date('Y-m-d H:i:s', $ts);
        $this->pdo->prepare('UPDATE events SET received_at = :t WHERE id = :id')->execute(['t' => $t, 'id' => $id]);
        foreach (['ppe_checks' => 'checked_at', 'restricted_events' => 'detected_at', 'forklift_events' => 'detected_at'] as $table => $col) {
            try {
                $this->pdo->prepare("UPDATE {$table} SET {$col} = :t WHERE event_id = :id")->execute(['t' => $t, 'id' => $id]);
            } catch (Throwable $e) {
                // table not migrated yet
            }
        }
    }

    /** Older simulated incidents get handled like a real shift would: most resolved, some acknowledged. */
    private function triage(): void
    {
        [$in, $vals] = $this->streamsIn();
        $st = $this->pdo->prepare("SELECT id, received_at FROM events WHERE stream IN ({$in}) AND received_at < ? AND (status IS NULL OR status = 'open')");
        $st->execute(array_merge($vals, [date('Y-m-d H:i:s', time() - 6 * 3600)]));
        $res = $this->pdo->prepare("UPDATE events SET status = 'resolved', assignee = 'Supervisor', acked_at = :a, resolved_at = :r WHERE id = :id");
        $ack = $this->pdo->prepare("UPDATE events SET status = 'ack', assignee = 'Supervisor', acked_at = :a WHERE id = :id");
        foreach ($st->fetchAll() as $r) {
            $base = strtotime((string) $r['received_at']) ?: time();
            $roll = mt_rand(1, 100);
            if ($roll <= 75) {
                $res->execute(['a' => date('Y-m-d H:i:s', $base + mt_rand(2, 15) * 60),
                               'r' => date('Y-m-d H:i:s', $base + mt_rand(20, 180) * 60), 'id' => $r['id']]);
            } elseif ($roll <= 85) {
                $ack->execute(['a' => date('Y-m-d H:i:s', $base + mt_rand(2, 30) * 60), 'id' => $r['id']]);
            }
        }
    }

    /** Delete every simulated event and its dependent rows. Returns the number of events removed. */
    private function purgeEvents(): int
    {
        [$in, $vals] = $this->streamsIn();
        $st = $this->pdo->prepare("SELECT id, uuid FROM events WHERE stream IN ({$in})");
        $st->execute($vals);
        $rows = $st->fetchAll();
        foreach (array_chunk($rows, 300) as $chunk) {
            $ids   = array_map(static fn ($r) => (int) $r['id'], $chunk);
            $uuids = array_values(array_filter(array_map(static fn ($r) => (string) ($r['uuid'] ?? ''), $chunk)));
            $inIds = implode(',', array_fill(0, count($ids), '?'));
            foreach (['event_attributes', 'ppe_checks', 'restricted_events', 'forklift_events'] as $table) {
                try {
                    $this->pdo->prepare("DELETE FROM {$table} WHERE event_id IN ({$inIds})")->execute($ids);
                } catch (Throwable $e) {
                    // table not migrated yet
                }
            }
            if ($uuids) {
                try {
                    $this->pdo->prepare('DELETE FROM incident_log WHERE uuid IN (' . implode(',', array_fill(0, count($uuids), '?')) . ')')->execute($uuids);
                } catch (Throwable $e) {
                }
            }
            $this->pdo->prepare("DELETE FROM events WHERE id IN ({$inIds})")->execute($ids);
        }
        return count($rows);
    }

    /** [placeholders, values] for a `stream IN (…)` clause over the demo cameras. */
    private function streamsIn(): array
    {
        $keys = array_keys(self::CAMS);
        return [implode(',', array_fill(0, count($keys), '?')), $keys];
    }

    private function clearCaches(): void
    {
        $dir = dirname((string) ($this->config['storage']['raw_log'] ?? (dirname(__DIR__) . '/storage/x')));
        foreach (glob($dir . '/overview_*.json') ?: [] as $f) {
            @unlink($f);
        }
    }
}
