<?php
/**
 * Behaviour analytics for Line 5 (POC criteria 24, 25, 26, 27, 40, 42).
 *
 * Two sources of behaviour events, both stored in `behaviour_events`:
 *
 *  1. SenseStudio policy / custom-algorithm pushes, matched by name at ingest
 *     (EventStore::store → Behaviour::classify / record):
 *       fight|altercation|brawl|violence|scuffle|conflict  → abnormal · fighting (Critical)
 *       fall / man down                                     → abnormal · person fall (High)
 *       clean|mop|sweep|wipe                                → cleaning activity
 *       loiter|stay|linger|wander|dwell                     → chit-chat / loitering
 *     The event itself is tagged BehKind / BehType so DashboardMapper buckets it
 *     as module "beh" and the normal alert pipeline e-mails it in real time.
 *     SenseStudio V2.13 has no native fighting / cleaning model — these need a
 *     behaviour or custom algorithm on the camera; the dashboard only names
 *     and routes what that algorithm reports.
 *
 *  2. Derived from detections on the behaviour cameras (default: every camera
 *     mapped to the "Line 5" camera point), by scan():
 *       group  ≥ group_min people present together for ≥ dwell_min minutes
 *              while no cleaning session is scheduled          → chit-chat / loitering
 *       idle   one identified person continuously present for ≥ idle_min
 *              minutes                                          → loitering (single person)
 *       ppe    people wearing the cleaning PPE (gloves / goggles by default)
 *              during a scheduled cleaning window               → cleaning activity (proxy)
 *     Headcount is estimated from detections: an identified person is present
 *     between sightings no more than gap_sec apart (+60 s), every anonymous
 *     detection counts as one person for 60 s. It is a presence / dwell measure
 *     — never conversation content.
 *
 * "Normal operation" = minutes with people present and no exception active.
 */

declare(strict_types=1);

require_once __DIR__ . '/EventStore.php';
require_once __DIR__ . '/Attendance.php';
require_once __DIR__ . '/Cleaning.php';
require_once __DIR__ . '/Ppe.php';
require_once __DIR__ . '/DashboardMapper.php';

final class Behaviour
{
    public const KINDS = [
        'normal'   => 'Normal operation',
        'loiter'   => 'Chit-chat / loitering',
        'cleaning' => 'Cleaning activity',
        'abnormal' => 'Abnormal behaviour',
    ];
    public const SUBS = [
        'fight'     => 'Fighting / altercation',
        'fall'      => 'Person fall',
        'policy'    => 'SenseStudio policy',
        'group'     => 'Group dwell (chit-chat)',
        'idle'      => 'Single person lingering',
        'ppe_proxy' => 'Cleaning PPE during scheduled window',
    ];
    public const VERDICTS = [
        'detected'    => 'Detected — not reviewed',
        'confirmed'   => 'Confirmed',
        'false_alarm' => 'False alarm',
    ];
    public const DEFAULTS = [
        'enabled' => true, 'cameras' => [], 'locations' => ['Line 5'], 'group_min' => 2, 'dwell_min' => 3,
        'idle_min' => 10, 'gap_sec' => 120, 'clean_items' => ['gloves', 'goggles'],
    ];
    public const MODEL_NOTE = 'SenseStudio V2.13 has no native fighting, fall or cleaning-action model. Those events come from a '
        . 'SenseStudio behaviour / custom algorithm on the camera whose policy name contains fight / altercation / fall / clean / mop / '
        . 'sweep / wipe / loiter / stay. Chit-chat, idle loitering and PPE-proxy cleaning are derived here from detection dwell and '
        . 'body attributes, with the thresholds in Settings → Behaviour Rules.';

    private const FIGHT_RE = '/fight|altercation|brawl|violen|scuffle|conflict|aggress/i';
    private const FALL_RE  = '/\bfall|fallen|man.?down|person.?down/i';
    private const CLEAN_RE = '/clean|\bmop|sweep|wipe|scrub/i';
    private const PPE_RE   = '/ppe|helmet|hard.?hat|vest|glove|goggle|boot|hair.?net/i';
    private const LOIT_RE  = '/loiter|\bstay|linger|wander|dwell|gather/i';
    private const LOOKBACK  = 7200;   // re-scan the last 2 h so episodes in progress keep growing
    private const CLEAN_GAP = 1200;   // PPE-proxy cleaning detections ≤20 min apart are one session

    private PDO $pdo;
    private array $config;
    private EventStore $store;
    private array $cfg;

    public function __construct(PDO $pdo, array $config, EventStore $store)
    {
        $this->pdo    = $pdo;
        $this->config = $config;
        $this->store  = $store;
        $this->cfg    = ($config['behaviour'] ?? []) + self::DEFAULTS;
    }

    // ── Settings ─────────────────────────────────────────────

    /** Effective settings from app_settings.json values (config.php applies the same rules). */
    public static function configFrom(array $app): array
    {
        $list = static fn ($v, int $len) => array_values(array_unique(array_filter(array_map(
            static fn ($x) => substr(trim((string) $x), 0, $len), is_array($v) ? $v : []), static fn ($x) => $x !== '')));
        $cams = array_values(array_unique(array_filter(array_map(
            static fn ($k) => strtolower((string) preg_replace('/[^a-z0-9_.-]+/i', '', substr((string) $k, 0, 64))),
            is_array($app['beh_cameras'] ?? null) ? $app['beh_cameras'] : []))));
        $locs  = array_key_exists('beh_locations', $app) ? $list($app['beh_locations'], 64) : self::DEFAULTS['locations'];
        $items = array_values(array_filter($list($app['beh_clean_items'] ?? null, 20), static fn ($i) => (bool) preg_match('/^[a-z_]+$/', $i)));
        return [
            'enabled'     => ($app['beh_enabled'] ?? true) !== false,
            'cameras'     => array_slice($cams, 0, 100),
            'locations'   => array_slice($locs, 0, 40),
            'group_min'   => max(2, min(20, (int) ($app['beh_group_min'] ?? 2))),
            'dwell_min'   => max(1, min(120, (int) ($app['beh_dwell_min'] ?? 3))),
            'idle_min'    => max(0, min(480, (int) ($app['beh_idle_min'] ?? 10))),
            'gap_sec'     => max(30, min(900, (int) ($app['beh_gap_sec'] ?? 120))),
            'clean_items' => $items ?: self::DEFAULTS['clean_items'],
        ];
    }

    /** Whitelist a /settings POST body → app_settings.json keys. */
    public static function sanitize(array $in): array
    {
        $out = [];
        if (array_key_exists('beh_enabled', $in)) {
            $out['beh_enabled'] = filter_var($in['beh_enabled'], FILTER_VALIDATE_BOOLEAN);
        }
        foreach (['beh_group_min' => [2, 20], 'beh_dwell_min' => [1, 120], 'beh_idle_min' => [0, 480], 'beh_gap_sec' => [30, 900]] as $k => [$lo, $hi]) {
            if (array_key_exists($k, $in) && is_numeric($in[$k])) {
                $out[$k] = max($lo, min($hi, (int) $in[$k]));
            }
        }
        if (isset($in['beh_cameras']) && is_array($in['beh_cameras'])) {
            $out['beh_cameras'] = self::configFrom(['beh_cameras' => $in['beh_cameras']])['cameras'];
        }
        if (isset($in['beh_locations']) && is_array($in['beh_locations'])) {
            $out['beh_locations'] = self::configFrom(['beh_locations' => $in['beh_locations']])['locations'];
        }
        if (isset($in['beh_clean_items']) && is_array($in['beh_clean_items'])) {
            $out['beh_clean_items'] = array_values(array_intersect(array_keys(Ppe::ITEMS), $in['beh_clean_items'])) ?: self::DEFAULTS['clean_items'];
        }
        return $out;
    }

    /** Stream keys monitored for behaviour: the explicit list plus every camera at a behaviour location. */
    public function scopeCameras(): array
    {
        if (empty($this->cfg['enabled'])) {
            return [];
        }
        $out = $this->cfg['cameras'];
        foreach ($this->config['poc']['cam_locations'] ?? [] as $k => $loc) {
            foreach ($this->cfg['locations'] as $l) {
                if (strcasecmp((string) $loc, (string) $l) === 0) {
                    $out[] = (string) $k;
                }
            }
        }
        return array_values(array_unique($out));
    }

    private function locOf(string $stream): string
    {
        return (string) (($this->config['poc']['cam_locations'] ?? [])[EventStore::streamLabel($stream)] ?? '');
    }

    private function plantOf(string $loc): string
    {
        return $loc !== '' ? (new Attendance($this->store, $this->config))->plantOf($loc) : '';
    }

    // ── Ingest: policy-named behaviour algorithms ────────────

    /**
     * Behaviour kind of a pushed event from its policy / algorithm text.
     * $e: trigger_image_type, event_type, policy_name, policy_desc.
     *
     * @return array{0:string,1:string}|null [kind, sub]
     */
    public static function classify(array $e): ?array
    {
        $t = ($e['trigger_image_type'] ?? '') . ' ' . ($e['event_type'] ?? '') . ' '
            . ($e['policy_name'] ?? '') . ' ' . ($e['policy_desc'] ?? '');
        if (preg_match(self::FIGHT_RE, $t)) {
            return ['abnormal', 'fight'];
        }
        if (preg_match(self::FALL_RE, $t) && !preg_match('/waterfall|rainfall|fallback/i', $t)) {
            return ['abnormal', 'fall'];
        }
        if (preg_match(self::CLEAN_RE, $t) && !preg_match(self::PPE_RE, $t)) {
            return ['cleaning', 'policy'];
        }
        if (preg_match(self::LOIT_RE, $t)) {
            return ['loiter', 'policy'];
        }
        return null;
    }

    /** Tag a decoded attribute map (BehKind / BehType) so the event is classified as a behaviour incident. */
    public static function tag(array $map, string $kind, string $sub): array
    {
        $map['BehKind'] = $kind;
        $map['BehType'] = $sub;
        return $map;
    }

    /** Store a policy-sourced behaviour event (called after the events row exists). */
    public function record(int $eventId, array $row, string $kind, string $sub): void
    {
        $stream = (string) ($row['stream'] ?? '');
        $loc    = $this->locOf($stream);
        $pol    = Text::latin((string) ($row['policy_name'] ?? ''), 'behaviour');
        $reason = $kind === 'abnormal'
            ? ($sub === 'fight' ? 'Abnormal: fighting / altercation' : 'Abnormal: person fall') . ' reported by SenseStudio policy "' . $pol . '"'
            : (self::KINDS[$kind] ?? $kind) . ' reported by SenseStudio policy "' . $pol . '"';
        $this->insert([
            'event_id' => $eventId, 'kind' => $kind, 'sub' => $sub, 'source' => 'policy',
            'started_at' => (string) ($row['received_at'] ?? date('Y-m-d H:i:s')), 'ended_at' => null,
            'stream' => $stream, 'location' => $loc, 'plant' => $this->plantOf($loc), 'persons' => 1, 'dwell_sec' => 0,
            'reason' => substr($reason, 0, 255), 'image' => $row['trigger_img_url'] ?? null,
        ]);
        // Cleaning activity is evidence, not an incident to triage.
        if ($kind === 'cleaning') {
            $this->pdo->prepare("UPDATE events SET status = 'resolved', resolved_at = :t WHERE id = :id AND (status IS NULL OR status = 'open')")
                ->execute(['t' => date('Y-m-d H:i:s'), 'id' => $eventId]);
        }
    }

    private function insert(array $r): int
    {
        $this->pdo->prepare(
            'INSERT INTO behaviour_events (event_id, kind, sub, source, started_at, ended_at, stream, location, plant,
                                           persons, dwell_sec, reason, image, verdict)
             VALUES (:event_id, :kind, :sub, :source, :started_at, :ended_at, :stream, :location, :plant,
                     :persons, :dwell_sec, :reason, :image, :verdict)'
        )->execute($r + ['verdict' => 'detected']);
        return (int) $this->pdo->lastInsertId();
    }

    // ── Derived detection (dwell / group / PPE proxy) ────────

    private function cursorFile(): string
    {
        return dirname((string) ($this->config['storage']['raw_log'] ?? (dirname(__DIR__) . '/storage/x'))) . '/beh_cursor.json';
    }

    /**
     * Scan detections since the cursor, at most once per $minGap seconds
     * (cursor-file mtime). Never throws.
     */
    public function maybeScan(int $minGap = 60): int
    {
        try {
            $file = $this->cursorFile();
            if ($minGap > 0 && is_file($file) && (time() - (int) filemtime($file)) < $minGap) {
                return 0;
            }
            $cur  = is_file($file) ? (int) ((json_decode((string) file_get_contents($file), true) ?: [])['last'] ?? 0) : 0;
            $now  = time();
            @file_put_contents($file, json_encode(['last' => $cur ?: $now, 'at' => date('c')]), LOCK_EX);   // claim the slot first
            $from = max($now - 7 * 86400, ($cur ?: $now - 86400) - self::LOOKBACK);
            $n    = $this->scan($from, $now);
            @file_put_contents($file, json_encode(['last' => $now, 'at' => date('c')]), LOCK_EX);
            return $n;
        } catch (Throwable $e) {
            error_log('[behaviour] scan: ' . $e->getMessage());
            return 0;
        }
    }

    /**
     * Re-derive the dwell / group / PPE-proxy events over the last $days:
     * unreviewed derived rows are dropped first (reviewed ones are kept).
     */
    public function rescan(int $days): int
    {
        $days = max(1, min(31, $days));
        $from = time() - $days * 86400;
        $this->pdo->prepare("DELETE FROM behaviour_events WHERE source <> 'policy' AND verdict = 'detected' AND started_at >= :f")
            ->execute(['f' => date('Y-m-d H:i:s', $from)]);
        $n = $this->scan($from, time());
        @file_put_contents($this->cursorFile(), json_encode(['last' => time(), 'at' => date('c')]), LOCK_EX);
        return $n;
    }

    /** Derive behaviour events in [$fromTs, $toTs). Returns the number of new rows. */
    public function scan(int $fromTs, int $toTs): int
    {
        $scope = $this->scopeCameras();
        $sched = $this->config['cleaning']['schedules'] ?? [];
        // The cleaning proxy also runs on any camera whose point has a cleaning schedule.
        $cleanCams = [];
        $schedLocs = array_unique(array_column($sched, 'location'));
        foreach ($this->config['poc']['cam_locations'] ?? [] as $k => $loc) {
            if (in_array($loc, $schedLocs, true)) {
                $cleanCams[] = (string) $k;
            }
        }
        $cams = array_values(array_unique(array_merge($scope, $cleanCams)));
        if (!$cams || empty($this->cfg['enabled'])) {
            return 0;
        }
        $det   = $this->detections($cams, $fromTs, $toTs);
        $names = [];
        foreach ($this->store->personProfiles() as $pid => $p) {
            $names[(string) $pid] = $p['name'];
        }
        $gap = (int) $this->cfg['gap_sec'];
        $new = 0;
        foreach ($det as $cam => $rows) {
            $cam   = (string) $cam;
            $loc   = $this->locOf($cam);
            $plant = $this->plantOf($loc);
            $where = $loc ?: strtoupper($cam);
            if (in_array($cam, $scope, true)) {
                [$minutes, $intervals] = self::presence($rows, $gap);
                $groups = $this->groupEpisodes($minutes, $rows, $loc, $sched);
                foreach ($groups as $g) {
                    $who  = [];
                    $anon = false;
                    foreach ($rows as $r) {
                        if ($r['ts'] >= $g['a'] && $r['ts'] < $g['b']) {
                            if ($r['pid'] !== '') {
                                $who[$r['pid']] = $names[$r['pid']] ?? ('#' . $r['pid']);
                            } else {
                                $anon = true;
                            }
                        }
                    }
                    $label = $who ? implode(', ', array_slice(array_values($who), 0, 4)) . ($anon ? ' + unidentified' : '') : 'unidentified people';
                    $new += $this->upsert('loiter', 'group', $cam, $loc, $plant, $g['a'], $g['b'], $g['persons'],
                        $g['persons'] . ' people co-located ' . (int) round(($g['b'] - $g['a']) / 60) . ' min at ' . $where
                        . ' (threshold ' . $this->cfg['group_min'] . '+ people for ' . $this->cfg['dwell_min'] . ' min) — ' . $label,
                        $g['image']);
                }
                $idle = (int) $this->cfg['idle_min'];
                if ($idle > 0) {
                    foreach ($intervals as $iv) {
                        if ($iv['pid'] === '' || ($iv['b'] - $iv['a']) < $idle * 60) {
                            continue;
                        }
                        $overlap = false;
                        foreach ($groups as $g) {
                            $overlap = $overlap || ($iv['a'] < $g['b'] && $iv['b'] > $g['a']);
                        }
                        if ($overlap || Cleaning::activeAt($loc, $iv['a'], $sched)) {
                            continue;
                        }
                        $new += $this->upsert('loiter', 'idle', $cam, $loc, $plant, $iv['a'], $iv['b'], 1,
                            ($names[$iv['pid']] ?? ('Person #' . $iv['pid'])) . ' stayed ' . (int) round(($iv['b'] - $iv['a']) / 60)
                            . ' min at ' . $where . ' (idle threshold ' . $idle . ' min)', $iv['image']);
                    }
                }
            }
            if (in_array($cam, $cleanCams, true)) {
                $new += $this->cleaningProxy($cam, $loc, $plant, $rows, $sched);
            }
        }
        return $new;
    }

    /** Person detections per camera in range (vehicle / forklift detections excluded). */
    private function detections(array $cams, int $fromTs, int $toTs): array
    {
        $alias = [];
        try {
            foreach ($this->pdo->query("SELECT person_id, ss_uid FROM person_profiles WHERE ss_uid IS NOT NULL AND ss_uid <> ''")->fetchAll() as $a) {
                $alias[(string) $a['ss_uid']] = (string) $a['person_id'];
            }
        } catch (Throwable $e) {
            // employee columns not migrated yet
        }
        $in = implode(',', array_fill(0, count($cams), '?'));
        $st = $this->pdo->prepare("SELECT id, stream, person_id, received_at, decoded_json, trigger_img_url FROM events
                                    WHERE stream IN ({$in}) AND received_at >= ? AND received_at < ?
                                    ORDER BY received_at ASC, id ASC LIMIT 200000");
        $st->execute(array_merge($cams, [date('Y-m-d H:i:s', $fromTs), date('Y-m-d H:i:s', $toTs)]));
        $out = [];
        foreach ($st->fetchAll() as $r) {
            $dec = json_decode((string) ($r['decoded_json'] ?? ''), true) ?: [];
            if (!empty($dec['FkVerdict'])) {
                continue;
            }
            $pid = (string) ($r['person_id'] ?? '');
            $out[(string) $r['stream']][] = [
                'id' => (int) $r['id'], 'ts' => strtotime((string) $r['received_at']) ?: 0,
                'pid' => $alias[$pid] ?? $pid, 'dec' => $dec, 'image' => (string) ($r['trigger_img_url'] ?? ''),
            ];
        }
        return $out;
    }

    /**
     * Presence model → [minute index → headcount, intervals]. An identified
     * person's sightings ≤ $gap s apart form one interval [first, last+60);
     * every anonymous detection is one person for 60 s.
     */
    public static function presence(array $rows, int $gap): array
    {
        $iv   = [];
        $open = [];   // pid → index into $iv
        foreach ($rows as $r) {
            if ($r['pid'] === '') {
                $iv[] = ['pid' => '', 'a' => $r['ts'], 'b' => $r['ts'] + 60, 'image' => $r['image']];
                continue;
            }
            $i = $open[$r['pid']] ?? null;
            if ($i !== null && $r['ts'] - ($iv[$i]['b'] - 60) <= $gap) {
                $iv[$i]['b'] = max($iv[$i]['b'], $r['ts'] + 60);
                if ($iv[$i]['image'] === '' && $r['image'] !== '') {
                    $iv[$i]['image'] = $r['image'];
                }
                continue;
            }
            $iv[] = ['pid' => $r['pid'], 'a' => $r['ts'], 'b' => $r['ts'] + 60, 'image' => $r['image']];
            $open[$r['pid']] = count($iv) - 1;
        }
        $min = [];
        foreach ($iv as $x) {
            for ($m = intdiv($x['a'], 60), $e = intdiv($x['b'] - 1, 60); $m <= $e; $m++) {
                $min[$m] = ($min[$m] ?? 0) + 1;
            }
        }
        ksort($min);
        return [$min, $iv];
    }

    /** Runs of minutes with ≥ group_min people (1-minute gaps bridged) lasting ≥ dwell_min, outside cleaning windows. */
    private function groupEpisodes(array $minutes, array $rows, string $loc, array $sched): array
    {
        $need  = (int) $this->cfg['group_min'];
        $dwell = (int) $this->cfg['dwell_min'];
        $runs  = [];
        $cur   = null;
        foreach ($minutes as $m => $n) {
            if ($n < $need) {
                continue;
            }
            if ($cur !== null && $m - $cur['last'] <= 2) {
                $cur['last']    = $m;
                $cur['persons'] = max($cur['persons'], $n);
                continue;
            }
            if ($cur !== null) {
                $runs[] = $cur;
            }
            $cur = ['first' => $m, 'last' => $m, 'persons' => $n];
        }
        if ($cur !== null) {
            $runs[] = $cur;
        }
        $out = [];
        foreach ($runs as $r) {
            $a = $r['first'] * 60;
            $b = ($r['last'] + 1) * 60;
            if (($b - $a) < $dwell * 60 || Cleaning::activeAt($loc, $a, $sched)) {
                continue;
            }
            $img = '';
            foreach ($rows as $x) {
                if ($x['ts'] >= $a && $x['ts'] < $b && $x['image'] !== '') {
                    $img = $x['image'];
                    break;
                }
            }
            $out[] = ['a' => $a, 'b' => $b, 'persons' => $r['persons'], 'image' => $img];
        }
        return $out;
    }

    /** People wearing the cleaning PPE during a scheduled cleaning window → cleaning activity (attribute proxy). */
    private function cleaningProxy(string $cam, string $loc, string $plant, array $rows, array $sched): int
    {
        $hits = [];
        foreach ($rows as $r) {
            $active = Cleaning::activeAt($loc, $r['ts'], $sched);
            if (!$active) {
                continue;
            }
            $worn = [];
            foreach ($this->cfg['clean_items'] as $it) {
                if (Ppe::itemState($it, $r['dec']) === true) {
                    $worn[] = $it;
                }
            }
            if ($worn) {
                $hits[] = $r + ['worn' => $worn, 'session' => (string) $active[0]['name']];
            }
        }
        $new = 0;
        $cl  = null;
        $flush = function (?array $c) use (&$new, $cam, $loc, $plant): void {
            if ($c === null) {
                return;
            }
            $worn = implode(' / ', array_map(static fn ($i) => strtolower(Ppe::ITEMS[$i] ?? $i), array_keys($c['worn'])));
            $new += $this->upsert('cleaning', 'ppe_proxy', $cam, $loc, $plant, $c['a'], $c['b'], count($c['pids']),
                'Cleaning activity detected — ' . $c['n'] . ' detection(s) with ' . $worn . ' at ' . ($loc ?: strtoupper($cam))
                . ' during "' . $c['session'] . '" (attribute proxy)', $c['image']);
        };
        foreach ($hits as $h) {
            $who = $h['pid'] !== '' ? $h['pid'] : ('a' . $h['id']);
            if ($cl !== null && $h['ts'] - $cl['b'] <= self::CLEAN_GAP) {
                $cl['b'] = $h['ts'] + 60;
                $cl['n']++;
                $cl['pids'][$who] = 1;
                $cl['worn'] += array_fill_keys($h['worn'], 1);
                $cl['image'] = $cl['image'] ?: $h['image'];
                continue;
            }
            $flush($cl);
            $cl = ['a' => $h['ts'], 'b' => $h['ts'] + 60, 'n' => 1, 'session' => $h['session'], 'image' => $h['image'],
                   'pids' => [$who => 1], 'worn' => array_fill_keys($h['worn'], 1)];
        }
        $flush($cl);
        return $new;
    }

    /** Insert a derived episode, or grow the overlapping one already stored. Returns 1 when new. */
    private function upsert(string $kind, string $sub, string $cam, string $loc, string $plant, int $a, int $b,
                            int $persons, string $reason, string $image): int
    {
        $gap = (int) $this->cfg['gap_sec'];
        $q = $this->pdo->prepare("SELECT id, started_at, ended_at, persons FROM behaviour_events
                                   WHERE stream = :s AND kind = :k AND sub = :sub AND source <> 'policy'
                                     AND started_at <= :e AND ended_at >= :b ORDER BY id ASC LIMIT 1");
        $q->execute(['s' => $cam, 'k' => $kind, 'sub' => $sub,
                     'e' => date('Y-m-d H:i:s', $b + $gap), 'b' => date('Y-m-d H:i:s', $a - $gap)]);
        $ex = $q->fetch();
        if ($ex) {
            $na = min($a, strtotime((string) $ex['started_at']) ?: $a);
            $nb = max($b, strtotime((string) $ex['ended_at']) ?: $b);
            $this->pdo->prepare("UPDATE behaviour_events SET started_at = :a, ended_at = :b, persons = :p, dwell_sec = :d, reason = :r,
                                        image = CASE WHEN image IS NULL OR image = '' THEN :i ELSE image END WHERE id = :id")
                ->execute(['a' => date('Y-m-d H:i:s', $na), 'b' => date('Y-m-d H:i:s', $nb), 'p' => max($persons, (int) $ex['persons']),
                           'd' => $nb - $na, 'r' => substr($reason, 0, 255), 'i' => $image, 'id' => $ex['id']]);
            return 0;
        }
        $this->insert([
            'event_id' => 0, 'kind' => $kind, 'sub' => $sub, 'source' => $sub === 'ppe_proxy' ? 'ppe' : 'dwell',
            'started_at' => date('Y-m-d H:i:s', $a), 'ended_at' => date('Y-m-d H:i:s', $b),
            'stream' => $cam, 'location' => $loc, 'plant' => $plant, 'persons' => $persons, 'dwell_sec' => $b - $a,
            'reason' => substr($reason, 0, 255), 'image' => $image,
        ]);
        return 1;
    }

    // ── Review ───────────────────────────────────────────────

    /** A reviewer confirms a behaviour event or clears it as a false alarm. */
    public function review(int $id, string $verdict, string $note, string $actor): bool
    {
        if (!in_array($verdict, ['confirmed', 'false_alarm'], true)) {
            return false;
        }
        $q = $this->pdo->prepare('SELECT * FROM behaviour_events WHERE id = :id');
        $q->execute(['id' => $id]);
        $r = $q->fetch();
        if (!$r) {
            return false;
        }
        $this->pdo->prepare('UPDATE behaviour_events SET verdict = :v, reviewed_by = :b, reviewed_at = :t, note = :n WHERE id = :id')
            ->execute(['v' => $verdict, 'b' => substr($actor, 0, 100), 't' => date('Y-m-d H:i:s'), 'n' => substr($note, 0, 500), 'id' => $id]);
        if ((int) $r['event_id'] > 0) {
            $e = $this->pdo->prepare('SELECT uuid FROM events WHERE id = :id');
            $e->execute(['id' => $r['event_id']]);
            $uuid = (string) ($e->fetchColumn() ?: '');
            if ($uuid !== '') {
                if ($verdict === 'false_alarm') {
                    $this->store->setStatus($uuid, 'resolved', null);
                }
                $this->store->addLog($uuid, 'review', $actor, (string) $r['verdict'], $verdict,
                    ($verdict === 'confirmed' ? 'Confirmed behaviour event' : 'Cleared as false alarm') . ($note !== '' ? ' — ' . $note : ''));
            }
        }
        return true;
    }

    // ── Dashboard + reports ──────────────────────────────────

    /** [from, to, fromTs, toTs(exclusive)] — at most 92 days. */
    private function range(array $f): array
    {
        $from = Attendance::cleanDate((string) ($f['from'] ?? ''));
        $to   = Attendance::cleanDate((string) (($f['to'] ?? '') ?: $from));
        if ($to < $from) {
            [$from, $to] = [$to, $from];
        }
        if (strtotime($to) - strtotime($from) > 92 * 86400) {
            $from = date('Y-m-d', strtotime($to) - 92 * 86400);
        }
        return [$from, $to, strtotime($from . ' 00:00:00'), strtotime($to . ' 00:00:00') + 86400];
    }

    private function rows(array $f, int $a, int $b): array
    {
        $sql  = 'SELECT * FROM behaviour_events WHERE started_at >= :a AND started_at < :b';
        $bind = ['a' => date('Y-m-d H:i:s', $a), 'b' => date('Y-m-d H:i:s', $b)];
        foreach (['camera' => 'stream', 'kind' => 'kind', 'verdict' => 'verdict', 'plant' => 'plant'] as $k => $col) {
            if (!empty($f[$k])) {
                $sql .= " AND {$col} = :{$k}";
                $bind[$k] = $f[$k];
            }
        }
        $st = $this->pdo->prepare($sql . ' ORDER BY started_at ASC, id ASC LIMIT 20000');
        $st->execute($bind);
        return $st->fetchAll();
    }

    /** KPIs, per-day trend, per-camera hourly activity timeline for one day, exception list. */
    public function summary(array $f): array
    {
        [$from, $to, $a, $b] = $this->range($f);
        $rows  = $this->rows($f, $a, $b);
        $scope = $this->scopeCameras();
        $cams  = $scope;
        foreach ($rows as $r) {
            $cams[] = (string) $r['stream'];
        }
        $cams = array_values(array_unique(array_filter($cams)));
        if (!empty($f['camera'])) {
            $cams = [$f['camera']];
        }
        $day = Attendance::cleanDate((string) (($f['day'] ?? '') ?: (date('Y-m-d') <= $to ? date('Y-m-d') : $to)));

        // camera → minute → class rank (1 normal · 2 loiter · 3 cleaning · 4 abnormal)
        $det = $cams ? $this->detections($cams, $a, $b) : [];
        $classOf = [];
        foreach ($cams as $cam) {
            [$mins] = self::presence($det[$cam] ?? [], (int) $this->cfg['gap_sec']);
            $classOf[$cam] = array_map(static fn () => 1, $mins);
        }
        $rank = ['loiter' => 2, 'cleaning' => 3, 'abnormal' => 4];
        $k = ['events' => 0, 'loiter' => 0, 'cleaning' => 0, 'abnormal' => 0, 'fight' => 0, 'fall' => 0,
              'unreviewed' => 0, 'confirmed' => 0, 'falseAlarm' => 0, 'today' => 0];
        $zero    = ['normal' => 0, 'loiter' => 0, 'cleaning' => 0, 'abnormal' => 0];
        $dailyEv = [];
        $today   = date('Y-m-d');
        foreach ($rows as $r) {
            $kind = (string) $r['kind'];
            $k['events']++;
            if ($r['verdict'] === 'false_alarm') {
                $k['falseAlarm']++;
                continue;
            }
            $k[$kind] = ($k[$kind] ?? 0) + 1;
            if ($kind === 'abnormal') {
                $k[$r['sub'] === 'fight' ? 'fight' : 'fall']++;
            }
            if ($r['verdict'] === 'confirmed') {
                $k['confirmed']++;
            } elseif ($kind !== 'cleaning') {
                $k['unreviewed']++;
            }
            $d = substr((string) $r['started_at'], 0, 10);
            if ($d === $today && $kind !== 'cleaning') {
                $k['today']++;
            }
            $dailyEv[$d][$kind] = ($dailyEv[$d][$kind] ?? 0) + 1;
            $cam = (string) $r['stream'];
            if (!isset($classOf[$cam])) {
                continue;
            }
            $s = strtotime((string) $r['started_at']) ?: 0;
            $e = max($s + 60, strtotime((string) ($r['ended_at'] ?: $r['started_at'])) ?: $s);
            for ($m = intdiv($s, 60), $me = intdiv($e - 1, 60); $m <= $me; $m++) {
                $classOf[$cam][$m] = max($classOf[$cam][$m] ?? 1, $rank[$kind] ?? 1);
            }
        }
        $names = [1 => 'normal', 2 => 'loiter', 3 => 'cleaning', 4 => 'abnormal'];
        $daily = [];
        for ($d = $a; $d < $b; $d += 86400) {
            $daily[date('Y-m-d', $d)] = ['min' => $zero, 'ev' => $zero];
        }
        $tot      = $zero;
        $timeline = [];
        $dayA     = strtotime($day . ' 00:00:00');
        foreach ($classOf as $cam => $mins) {
            $hours = array_fill(0, 24, $zero);
            foreach ($mins as $m => $c) {
                $ts = $m * 60;
                if ($ts < $a || $ts >= $b) {
                    continue;
                }
                $n = $names[$c];
                $tot[$n]++;
                $dd = date('Y-m-d', $ts);
                if (isset($daily[$dd])) {
                    $daily[$dd]['min'][$n]++;
                }
                if ($ts >= $dayA && $ts < $dayA + 86400) {
                    $hours[(int) date('G', $ts)][$n]++;
                }
            }
            $timeline[] = ['camera' => strtoupper((string) $cam), 'key' => (string) $cam, 'location' => $this->locOf((string) $cam),
                           'inScope' => in_array($cam, $scope, true), 'hours' => $hours,
                           'total' => array_sum(array_map('array_sum', $hours))];
        }
        foreach ($dailyEv as $d => $ev) {
            if (isset($daily[$d])) {
                $daily[$d]['ev'] = $ev + $zero;
            }
        }
        $mon = array_sum($tot);
        $k += ['monitoredMin' => $mon, 'normalMin' => $tot['normal'], 'loiterMin' => $tot['loiter'],
               'cleaningMin' => $tot['cleaning'], 'abnormalMin' => $tot['abnormal'],
               'normalPct' => $mon ? round(100 * $tot['normal'] / $mon, 1) : null];

        $list = [];
        foreach (array_reverse($rows) as $r) {
            if (count($list) >= 300) {
                break;
            }
            $list[] = $this->item($r);
        }
        $camList = [];
        foreach (array_values(array_unique(array_merge($scope, array_map('strval', array_keys($classOf))))) as $c) {
            $camList[] = ['key' => $c, 'label' => strtoupper($c), 'location' => $this->locOf($c), 'inScope' => in_array($c, $scope, true)];
        }
        return [
            'from' => $from, 'to' => $to, 'day' => $day, 'kpi' => $k,
            'daily' => array_map(static fn ($d, $v) => ['date' => $d] + $v, array_keys($daily), $daily),
            'timeline' => $timeline, 'exceptions' => $list, 'cameras' => $camList,
            'settings' => $this->cfg, 'kinds' => self::KINDS, 'subs' => self::SUBS, 'verdicts' => self::VERDICTS,
            'modelNote' => self::MODEL_NOTE,
        ];
    }

    private function item(array $r): array
    {
        $s    = (string) $r['started_at'];
        $e    = (string) ($r['ended_at'] ?: $s);
        $uuid = null;
        if ((int) $r['event_id'] > 0) {
            $q = $this->pdo->prepare('SELECT uuid FROM events WHERE id = :id');
            $q->execute(['id' => $r['event_id']]);
            $uuid = ($q->fetchColumn() ?: null);
        }
        return [
            'id' => (int) $r['id'], 'eventId' => (int) $r['event_id'], 'uuid' => $uuid,
            'kind' => (string) $r['kind'], 'sub' => (string) $r['sub'], 'source' => (string) $r['source'],
            'start' => $s, 'end' => $e, 'durMin' => max(0, (int) round(((strtotime($e) ?: 0) - (strtotime($s) ?: 0)) / 60)),
            'camera' => strtoupper((string) $r['stream']), 'location' => (string) $r['location'], 'plant' => (string) $r['plant'],
            'persons' => (int) $r['persons'], 'reason' => (string) $r['reason'], 'verdict' => (string) $r['verdict'],
            'reviewedBy' => (string) ($r['reviewed_by'] ?? ''), 'reviewedAt' => (string) ($r['reviewed_at'] ?? ''),
            'note' => (string) ($r['note'] ?? ''), 'image' => $this->store->fullUrl(((string) ($r['image'] ?? '')) ?: null),
        ];
    }

    /** CSV rows: report = exceptions | trend. */
    public function export(array $f, string $report): array
    {
        if ($report === 'trend') {
            $s   = $this->summary($f);
            $out = [['Date', 'Monitored minutes', 'Normal minutes', 'Normal %', 'Chit-chat / loitering minutes', 'Cleaning minutes',
                     'Abnormal minutes', 'Loitering events', 'Cleaning events', 'Abnormal events']];
            foreach ($s['daily'] as $d) {
                $mon   = array_sum($d['min']);
                $out[] = [$d['date'], $mon, $d['min']['normal'], $mon ? round(100 * $d['min']['normal'] / $mon, 1) : '',
                          $d['min']['loiter'], $d['min']['cleaning'], $d['min']['abnormal'],
                          $d['ev']['loiter'], $d['ev']['cleaning'], $d['ev']['abnormal']];
            }
            return $out;
        }
        [, , $a, $b] = $this->range($f);
        $src = ['policy' => 'SenseStudio policy', 'dwell' => 'Derived — dwell', 'ppe' => 'Derived — PPE attribute proxy'];
        $out = [['Start', 'End', 'Duration (min)', 'Plant', 'Location', 'Camera', 'Behaviour', 'Type', 'Source', 'People',
                 'Reason', 'Review', 'Reviewed by', 'Reviewed at', 'Note', 'Image URL']];
        foreach (array_reverse($this->rows($f, $a, $b)) as $r) {
            $i     = $this->item($r);
            $out[] = [$i['start'], $i['end'], $i['durMin'], $i['plant'], $i['location'], $i['camera'],
                      self::KINDS[$i['kind']] ?? $i['kind'], self::SUBS[$i['sub']] ?? $i['sub'], $src[$i['source']] ?? $i['source'],
                      $i['persons'], $i['reason'], self::VERDICTS[$i['verdict']] ?? $i['verdict'], $i['reviewedBy'], $i['reviewedAt'],
                      $i['note'], (string) $i['image']];
        }
        return $out;
    }

    /** Cleaning activity detected at $location in [a, b) — feeds the Cleaning page "observed" column. */
    public static function cleaningCount(PDO $pdo, string $location, string $a, string $b): int
    {
        try {
            $q = $pdo->prepare("SELECT COUNT(*) FROM behaviour_events WHERE kind = 'cleaning' AND verdict <> 'false_alarm'
                                 AND location = :l AND started_at >= :a AND started_at < :b");
            $q->execute(['l' => $location, 'a' => $a, 'b' => $b]);
            return (int) $q->fetchColumn();
        } catch (Throwable $e) {
            return 0;
        }
    }

    /** Remove behaviour rows for the given cameras (simulator re-run / reset). */
    public function purgeStreams(array $streams): void
    {
        if (!$streams) {
            return;
        }
        $this->pdo->prepare('DELETE FROM behaviour_events WHERE stream IN (' . implode(',', array_fill(0, count($streams), '?')) . ')')
            ->execute(array_values($streams));
    }

    // ── Incident / detection heatmap (Analytics) ─────────────

    /**
     * Camera × hour-of-day and day-of-week × hour-of-day counts over the last
     * $days, optionally for one module / severity. $pick = {type: cam|dow,
     * row, hour} also returns that cell's detections.
     */
    public function heatmap(int $days, string $mod, string $sev, ?array $pick = null): array
    {
        $days = in_array($days, [1, 7, 30, 90], true) ? $days : 7;
        $st = $this->pdo->prepare("SELECT id, uuid, stream, received_at, trigger_image_type, event_type, policy_name, policy_desc,
                                          alert_level, severity_override, decoded_json, attributes_json, trigger_img_url, person_name, status,
                                          CASE WHEN raw_json LIKE :strg THEN 1 ELSE 0 END AS strg
                                     FROM events WHERE received_at >= :f ORDER BY id DESC LIMIT 60000");
        $st->execute(['f' => date('Y-m-d H:i:s', time() - $days * 86400), 'strg' => '%"targetValue":"-99"%']);
        $cam = $dow = $camTot = $byMod = $items = [];
        $total = 0;
        $locs  = $this->config['poc']['cam_locations'] ?? [];
        $rank  = ['low' => 0, 'medium' => 1, 'high' => 2, 'critical' => 3];
        foreach ($st->fetchAll() as $r) {
            $e = $r;
            $e['decoded']    = json_decode((string) ($r['decoded_json'] ?? ''), true) ?: [];
            $e['attributes'] = json_decode((string) ($r['attributes_json'] ?? ''), true) ?: [];
            $e['raw']        = (int) $r['strg'] ? ['triggerTargets' => [['targetValue' => '-99']]] : [];
            $m = DashboardMapper::modOf($e);
            $byMod[$m] = ($byMod[$m] ?? 0) + 1;
            if ($mod !== '' && $m !== $mod) {
                continue;
            }
            $s = DashboardMapper::sevOf($e, $m);
            if (!empty($r['severity_override']) && isset($rank[$r['severity_override']])) {
                $s = (string) $r['severity_override'];
            }
            if ($sev !== '' && ($rank[$s] ?? 0) < ($rank[$sev] ?? 0)) {
                continue;   // severity filter = "this level and above"
            }
            $ts = strtotime((string) $r['received_at']) ?: 0;
            $h  = (int) date('G', $ts);
            $d  = (int) date('N', $ts);
            $c  = strtolower((string) ($r['stream'] ?: 'unknown'));
            $cam[$c][$h] = ($cam[$c][$h] ?? 0) + 1;
            $camTot[$c]  = ($camTot[$c] ?? 0) + 1;
            $dow[$d][$h] = ($dow[$d][$h] ?? 0) + 1;
            $total++;
            if ($pick && count($items) < 60 && (int) $pick['hour'] === $h
                && (($pick['type'] === 'cam' && (string) $pick['row'] === $c) || ($pick['type'] === 'dow' && (int) $pick['row'] === $d))) {
                $items[] = ['uuid' => (string) ($r['uuid'] ?: $r['id']), 'time' => (string) $r['received_at'], 'mod' => $m, 'sev' => $s,
                            'camera' => strtoupper($c), 'location' => (string) ($locs[$c] ?? ''), 'title' => DashboardMapper::titleOf($e, $m),
                            'status' => (string) ($r['status'] ?: 'open'), 'image' => $this->store->fullUrl(((string) ($r['trigger_img_url'] ?? '')) ?: null)];
            }
        }
        arsort($camTot);
        $rowsCam = [];
        foreach (array_slice($camTot, 0, 16, true) as $c => $n) {
            $cells = [];
            for ($h = 0; $h < 24; $h++) {
                $cells[] = (int) ($cam[$c][$h] ?? 0);
            }
            $rowsCam[] = ['key' => (string) $c, 'label' => strtoupper((string) $c), 'location' => (string) ($locs[$c] ?? ''), 'total' => $n, 'cells' => $cells];
        }
        $rowsDow = [];
        foreach ([1 => 'Mon', 2 => 'Tue', 3 => 'Wed', 4 => 'Thu', 5 => 'Fri', 6 => 'Sat', 7 => 'Sun'] as $d => $label) {
            $cells = [];
            for ($h = 0; $h < 24; $h++) {
                $cells[] = (int) ($dow[$d][$h] ?? 0);
            }
            $rowsDow[] = ['key' => (string) $d, 'label' => $label, 'total' => array_sum($cells), 'cells' => $cells];
        }
        return ['days' => $days, 'mod' => $mod, 'sev' => $sev, 'total' => $total, 'byMod' => $byMod,
                'cam' => $rowsCam, 'dow' => $rowsDow, 'pick' => $pick, 'items' => $items];
    }
}
