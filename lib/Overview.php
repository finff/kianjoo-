<?php
/**
 * Overview page ("AI Factory Monitoring Dashboard") — one payload combining
 * attendance, PPE, restricted area, cleaning and forklift monitoring, per-plant
 * summaries, recent recognitions and the newest events.
 *
 * Every section is built independently: a module that fails (missing table,
 * bad config) yields zeros for its section instead of failing the page. The
 * result is cached per plant filter for 30 s (storage/overview_<md5>.json) and
 * the stale copy is served if a rebuild throws.
 */

declare(strict_types=1);

require_once __DIR__ . '/EventStore.php';
require_once __DIR__ . '/Attendance.php';
require_once __DIR__ . '/DashboardMapper.php';

final class Overview
{
    private const CACHE_S = 30;
    private const ITEMS   = ['helmet', 'vest', 'goggles', 'gloves'];

    private PDO $pdo;
    private array $config;
    private EventStore $store;
    private Attendance $att;

    public function __construct(PDO $pdo, array $config, EventStore $store)
    {
        $this->pdo    = $pdo;
        $this->config = $config;
        $this->store  = $store;
        $this->att    = new Attendance($store, $config);
    }

    /**
     * Cameras online / total per configured plant, from SenseStudio fleet rows
     * ({stream, serial, online}) → cam_locations → plant.
     *
     * @return array<string,array{online:int,total:int}>
     */
    public static function plantCams(array $config, EventStore $store, array $fleet): array
    {
        $att  = new Attendance($store, $config);
        $locs = $config['poc']['cam_locations'] ?? [];
        $out  = [];
        foreach ($config['attendance']['plants'] ?? [] as $p) {
            $out[(string) $p] = ['online' => 0, 'total' => 0];
        }
        foreach ($fleet as $c) {
            $key = EventStore::streamLabel((string) (($c['stream'] ?? '') ?: ($c['serial'] ?? '')));
            $loc = (string) ($locs[$key] ?? '');
            $p   = $loc !== '' ? $att->plantOf($loc) : '';
            if ($p === '' || !isset($out[$p])) {
                continue;
            }
            $out[$p]['total']++;
            if (!empty($c['online'])) {
                $out[$p]['online']++;
            }
        }
        return $out;
    }

    public function build(string $plant): array
    {
        $plant = substr(trim($plant), 0, 80);
        $dir   = dirname((string) ($this->config['storage']['raw_log'] ?? (dirname(__DIR__) . '/storage/x')));
        $file  = $dir . '/overview_' . md5($plant) . '.json';
        if (is_file($file) && time() - (int) filemtime($file) < self::CACHE_S) {
            $c = json_decode((string) file_get_contents($file), true);
            if (is_array($c)) {
                return $c;
            }
        }
        try {
            $out = $this->compute($plant);
            @file_put_contents($file, json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX);
            return $out;
        } catch (Throwable $e) {
            error_log('[overview] ' . $e->getMessage());
            $c = is_file($file) ? json_decode((string) file_get_contents($file), true) : null;
            if (is_array($c)) {
                return $c;
            }
            throw $e;
        }
    }

    /** Run one section; on failure log it and return the fallback. */
    private function safe(string $name, callable $fn, $fallback)
    {
        try {
            return $fn();
        } catch (Throwable $e) {
            error_log('[overview:' . $name . '] ' . $e->getMessage() . ' @ ' . basename($e->getFile()) . ':' . $e->getLine());
            return $fallback;
        }
    }

    private static function pct(int $n, int $d): float
    {
        return $d > 0 ? round(100 * $n / $d, 1) : 0.0;
    }

    private function compute(string $plant): array
    {
        $today     = date('Y-m-d');
        $yesterday = date('Y-m-d', strtotime($today) - 86400);
        $weekFrom  = date('Y-m-d', strtotime($today) - 6 * 86400);
        $profiles  = $this->safe('profiles', fn () => $this->store->personProfiles(), []);
        $active    = array_filter($profiles, static fn ($p) => !empty($p['active']));
        $f7        = ['from' => $weekFrom, 'to' => $today, 'plant' => $plant];

        // ── Attendance: 7 daily registers (oldest → today) ──
        $days = [];
        for ($i = 6; $i >= 0; $i--) {
            $d = date('Y-m-d', strtotime($today) - $i * 86400);
            $days[$d] = $this->safe('attendance', fn () => $this->att->daily($d, ['plant' => $plant]), null);
        }
        $week = [];
        foreach ($days as $d => $reg) {
            $k = $reg['kpi'] ?? [];
            $week[] = [
                'date' => $d, 'label' => date('D', strtotime($d)), 'day' => date('j M', strtotime($d)),
                'present' => max(0, (int) ($k['present'] ?? 0) - (int) ($k['late'] ?? 0)),
                'late' => (int) ($k['late'] ?? 0), 'absent' => (int) ($k['absent'] ?? 0), 'pending' => (int) ($k['pending'] ?? 0),
            ];
        }
        $todayReg = $days[$today] ?? null;
        $allReg   = $plant === '' ? $todayReg
            : $this->safe('attendance', fn () => $this->att->daily($today), null);
        $tk       = $todayReg['kpi'] ?? [];
        $headcount = count(array_filter($active, static fn ($p) => $plant === '' || ($p['plant'] ?? '') === $plant));
        $monthStart = date('Y-m-01');
        $newMonth = count(array_filter($active, static fn ($p) => ($plant === '' || ($p['plant'] ?? '') === $plant)
            && substr((string) ($p['since'] ?? ''), 0, 10) >= $monthStart));
        $scheduled = (int) ($tk['total'] ?? 0);
        $employees = [
            'total'        => $headcount,
            'present'      => (int) ($tk['present'] ?? 0),       // incl. late
            'onTime'       => max(0, (int) ($tk['present'] ?? 0) - (int) ($tk['late'] ?? 0)),
            'late'         => (int) ($tk['late'] ?? 0),
            'absent'       => (int) ($tk['absent'] ?? 0),
            'pending'      => (int) ($tk['pending'] ?? 0),
            'off'          => (int) ($tk['off'] ?? 0),
            'scheduled'    => $scheduled,
            'presentPct'   => self::pct((int) ($tk['present'] ?? 0), $scheduled),
            'newThisMonth' => $newMonth,
        ];

        // Recognitions today: newest known faces, filtered by employee plant.
        $statusOf = [];
        foreach (($allReg['rows'] ?? []) as $r) {
            $statusOf[$r['personId']] = $r['status'];
        }
        $recognized = [];
        $seenPid    = [];
        foreach (($allReg['recent'] ?? []) as $s) {
            if (empty($s['known']) || isset($seenPid[$s['personId']])) {
                continue;
            }
            $emp = $profiles[$s['personId']] ?? [];
            if ($plant !== '' && ($emp['plant'] ?? '') !== $plant) {
                continue;
            }
            $seenPid[$s['personId']] = true;
            $recognized[] = [
                'personId' => (string) $s['personId'], 'name' => (string) $s['name'], 'staffId' => (string) $s['staffId'],
                'time' => substr((string) $s['time'], 11, 8), 'plant' => (string) (($emp['plant'] ?? '') ?: $s['plant']),
                'location' => (string) $s['location'], 'image' => $s['image'] ?: ($emp['photo'] ?? null),
                'status' => $statusOf[$s['personId']] ?? 'present',
            ];
            if (count($recognized) >= 6) {
                break;
            }
        }

        // ── PPE ──
        $ppe = $this->safe('ppe', function () use ($f7, $today, $yesterday, $plant) {
            require_once __DIR__ . '/Ppe.php';
            $p = new Ppe($this->pdo, $this->config, $this->store);
            $w = $p->summary($f7);
            $t = $p->summary(['from' => $today, 'to' => $today, 'plant' => $plant]);
            $byDay = array_column($w['daily'], 'violations', 'date');
            $items = [];
            foreach (self::ITEMS as $it) {
                $items[$it] = (int) ($t['byItem'][$it]['missing'] ?? 0);
            }
            return ['today' => (int) ($byDay[$today] ?? 0), 'yesterday' => (int) ($byDay[$yesterday] ?? 0),
                    'compliance' => $w['kpi']['compliance'], 'byItem' => $items];
        }, ['today' => 0, 'yesterday' => 0, 'compliance' => null, 'byItem' => array_fill_keys(self::ITEMS, 0)]);

        // ── Restricted area ──
        $restricted = $this->safe('restricted', function () use ($f7, $today, $yesterday) {
            require_once __DIR__ . '/Restricted.php';
            $r = (new Restricted($this->pdo, $this->config, $this->store))->summary($f7);
            $byDay = [];
            foreach ($r['daily'] as $d) {
                $byDay[$d['date']] = (int) ($d['violation'] ?? 0) + (int) ($d['review'] ?? 0);
            }
            $recent = [];
            foreach ($r['incidents'] as $i) {
                if (!in_array($i['verdict'], ['violation', 'review'], true)) {
                    continue;
                }
                $recent[] = [
                    'id' => $i['id'], 'time' => $i['time'], 'zone' => $i['zone'], 'plant' => $i['plant'],
                    'location' => $i['location'], 'camera' => $i['camera'], 'verdict' => $i['verdict'],
                    'verdictLabel' => Restricted::VERDICTS[$i['verdict']] ?? $i['verdict'],
                    'severity' => $i['verdict'] === 'violation' ? 'high' : 'medium', 'image' => $i['image'],
                ];
                if (count($recent) >= 3) {
                    break;
                }
            }
            return ['today' => (int) ($byDay[$today] ?? 0), 'yesterday' => (int) ($byDay[$yesterday] ?? 0),
                    'open' => (int) $r['kpi']['open'], 'recent' => $recent];
        }, ['today' => 0, 'yesterday' => 0, 'open' => 0, 'recent' => []]);

        // ── Cleaning ──
        $cleaning = $this->safe('cleaning', function () use ($f7, $today, $plant) {
            require_once __DIR__ . '/Ppe.php';
            require_once __DIR__ . '/Cleaning.php';
            [$sess] = (new Cleaning($this->pdo, $this->config, $this->store))
                ->sessions(['from' => $today, 'to' => $today, 'plant' => $plant]);
            $done = $notDone = 0;
            foreach ($sess as $s) {
                if ($s['confirmed'] === 'done') {
                    $done++;
                } elseif ($s['confirmed'] === 'not_done') {
                    $notDone++;
                }
            }
            $p = (new Ppe($this->pdo, $this->config, $this->store))->summary($f7 + ['cleaning' => 1]);
            $items = [];
            foreach (self::ITEMS as $it) {
                $items[$it] = ['required' => (int) ($p['byItem'][$it]['required'] ?? 0), 'missing' => (int) ($p['byItem'][$it]['missing'] ?? 0)];
            }
            return ['sessionsToday' => count($sess), 'done' => $done, 'pending' => count($sess) - $done - $notDone,
                    'notDone' => $notDone, 'compliance' => $p['kpi']['compliance'], 'byItem' => $items];
        }, ['sessionsToday' => 0, 'done' => 0, 'pending' => 0, 'notDone' => 0, 'compliance' => null,
            'byItem' => array_fill_keys(self::ITEMS, ['required' => 0, 'missing' => 0])]);

        // ── Forklift ──
        $forklift = $this->safe('forklift', function () use ($f7, $today, $yesterday) {
            require_once __DIR__ . '/Forklift.php';
            $fk = new Forklift($this->pdo, $this->config, $this->store);
            $r  = $fk->summary($f7);
            $byDay = [];
            foreach ($r['daily'] as $d) {
                $byDay[$d['date']] = $d;
            }
            $recent = [];
            foreach (array_slice($r['incidents'], 0, 3) as $i) {
                $recent[] = [
                    'id' => $i['id'], 'time' => $i['time'], 'zone' => $i['zone'] ?: $i['camera'], 'plant' => $i['plant'],
                    'location' => $i['location'], 'camera' => $i['camera'], 'verdict' => $i['verdict'],
                    'verdictLabel' => Forklift::VERDICTS[$i['verdict']] ?? $i['verdict'],
                    'severity' => $i['verdict'] === 'violation' ? 'high' : ($i['verdict'] === 'logged' ? 'medium' : 'low'),
                    'image' => $i['image'],
                ];
            }
            return ['today' => (int) ($byDay[$today]['detections'] ?? 0),
                    'violationsToday' => (int) ($byDay[$today]['violations'] ?? 0),
                    'yesterday' => (int) ($byDay[$yesterday]['detections'] ?? 0),
                    'violationsYesterday' => (int) ($byDay[$yesterday]['violations'] ?? 0),
                    'open' => (int) $r['kpi']['open'], 'recent' => $recent, 'modelNote' => Forklift::MODEL_NOTE];
        }, ['today' => 0, 'violationsToday' => 0, 'yesterday' => 0, 'violationsYesterday' => 0, 'open' => 0,
            'recent' => [], 'modelNote' => '']);

        // ── Plants (always every configured plant) ──
        $plants = $this->safe('plants', fn () => $this->plants($active, $allReg, $today), []);

        $events = $this->safe('events', fn () => $this->events($plant, $profiles), []);

        return [
            'generated_at' => date('Y-m-d H:i:s'), 'plant' => $plant,
            'employees' => $employees, 'week' => $week, 'ppe' => $ppe, 'restricted' => $restricted,
            'cleaning' => $cleaning, 'forklift' => $forklift, 'plants' => $plants,
            'recognized' => $recognized, 'events' => $events,
        ];
    }

    private function plants(array $active, ?array $reg, string $today): array
    {
        $count = function (string $table, string $where, string $col = 'detected_at') use ($today): array {
            $out = [];
            try {
                $st = $this->pdo->prepare("SELECT plant, COUNT(*) c FROM {$table} WHERE {$col} >= :f AND {$where} GROUP BY plant");
                $st->execute(['f' => $today . ' 00:00:00']);
                foreach ($st->fetchAll() as $r) {
                    $out[(string) $r['plant']] = (int) $r['c'];
                }
            } catch (Throwable $e) {
                // table missing → zeros
            }
            return $out;
        };
        $ra = $count('restricted_events', "verdict IN ('violation','review')");
        $fk = $count('forklift_events', "verdict = 'violation'");
        $pp = $count('ppe_checks', "missing <> ''", 'checked_at');

        $fleetFile = (string) ($this->config['storage']['raw_log'] ?? '') . '.cams.json';
        $fleet = is_file($fleetFile) ? (json_decode((string) file_get_contents($fleetFile), true) ?: []) : [];
        $cams  = self::plantCams($this->config, $this->store, is_array($fleet) ? $fleet : []);

        $present = $sched = [];
        foreach (($reg['rows'] ?? []) as $r) {
            $p = (string) $r['plant'];
            if ($r['status'] !== 'off') {
                $sched[$p] = ($sched[$p] ?? 0) + 1;
            }
            if (in_array($r['status'], ['present', 'late'], true)) {
                $present[$p] = ($present[$p] ?? 0) + 1;
            }
        }
        $out = [];
        foreach ($this->config['attendance']['plants'] ?? [] as $p) {
            $p = (string) $p;
            $out[] = [
                'name' => $p,
                'employees' => count(array_filter($active, static fn ($e) => ($e['plant'] ?? '') === $p)),
                'present' => $present[$p] ?? 0, 'presentPct' => self::pct($present[$p] ?? 0, $sched[$p] ?? 0),
                'ppe' => $pp[$p] ?? 0, 'restricted' => $ra[$p] ?? 0, 'forklift' => $fk[$p] ?? 0,
                'camsOnline' => $cams[$p]['online'] ?? 0, 'camsTotal' => $cams[$p]['total'] ?? 0,
            ];
        }
        return $out;
    }

    private function events(string $plant, array $profiles): array
    {
        $locs = $this->config['poc']['cam_locations'] ?? [];
        $rows = $this->store->query(['limit' => $plant === '' ? 8 : 300]);
        $out  = [];
        foreach ($rows as $e) {
            $loc = (string) ($locs[EventStore::streamLabel((string) ($e['stream'] ?? ''))] ?? '');
            if ($plant !== '' && ($loc === '' || $this->att->plantOf($loc) !== $plant)) {
                continue;
            }
            $i   = DashboardMapper::incident($e);
            $dec = is_array($e['decoded'] ?? null) ? $e['decoded'] : [];
            $mod = $i['mod'];
            $pid = $i['personId'];
            $emp = $pid !== '' ? ($profiles[$pid] ?? null) : null;
            if ($mod === 'ppe' && !empty($dec['PpeCleaning'])) {
                [$mod, $type] = ['cleaning', 'Cleaning'];
            } else {
                $type = [
                    'face'     => $emp !== null ? 'Attendance' : 'Face & Body',
                    'ppe'      => 'PPE Violation',
                    'intr'     => !empty($dec['RaVerdict']) ? 'Restricted Area' : 'Intrusion',
                    'forklift' => 'Forklift Alert',
                    'fire'     => 'Fire & Smoke',
                ][$mod] ?? ucfirst($mod);
            }
            $out[] = [
                'id' => $i['id'], 'mod' => $mod, 'type' => $type,
                'who' => $emp['name'] ?? ($i['person'] !== '' ? $i['person'] : $i['title']),
                'location' => $loc !== '' ? $loc : ($i['device'] ?: $i['camera']),
                'time' => (string) ($e['received_at'] ?? date('Y-m-d H:i:s', intdiv($i['ts'], 1000))),
                'status' => $i['status'], 'sev' => $i['sev'], 'image' => $i['image'],
            ];
            if (count($out) >= 8) {
                break;
            }
        }
        return $out;
    }
}
