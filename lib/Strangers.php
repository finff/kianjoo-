<?php
/**
 * Stranger movement tracking (Movement › Strangers).
 *
 * WHO IS A STRANGER — the rule every query here applies to `events`:
 *
 *   person_id   non-empty. SenseStudio gives every face it cannot match to an
 *               enrolled person a stranger ("Passer" library) id and keeps
 *               re-using it when the same face comes back, on any camera.
 *   person_name empty. A Target-library (enrolled-in-SenseStudio) match carries
 *               the person's name; a stranger push carries "" (API doc §6.5.1
 *               sample, lib/Simulator.php face()).
 *   feed_kind   not 'body' (body-attribute pushes are not face identities).
 *   profile     the id — or the stranger it was merged into — is not a
 *               dashboard employee profile (person_profiles.person_id) nor the
 *               SenseStudio uid of one (person_profiles.ss_uid).
 *
 * A face push that arrives with NO person id (only the Person Group −99
 * marker in triggerTargets) cannot be linked to any other sighting: those are
 * listed separately as single "unlinked" sightings (unlinked()), never guessed
 * into a journey.
 *
 * Operator state lives in stranger_profiles (label, status new|known|ignored,
 * alert-episode bookkeeping) and stranger_aliases ("merge with…": alias id →
 * canonical id, the same idea as the ss_uid → profile alias EventStore applies
 * in sightings()). Known / ignored strangers drop out of the default list and
 * never alert. Registering a stranger as an employee creates a profile keyed
 * on the stranger id, so it leaves this list automatically.
 *
 * Every list is date-bounded (≤ 31 days, idx_events_received) and paged;
 * journeys go through idx_events_person_id.
 */

declare(strict_types=1);

final class Strangers
{
    public const DEFAULTS = [
        'alert_enabled'    => false,   // notify on a stranger in a restricted zone / on many cameras
        'alert_zone'       => true,    // … seen at a restricted-zone camera (inside its restricted hours)
        'alert_cams'       => 3,       // … seen on ≥ N different cameras
        'alert_window_min' => 10,      // … within M minutes
        'episode_gap_min'  => 30,      // a stranger unseen this long starts a new episode (one alert per episode)
        'onsite_min'       => 15,      // "currently on site" = seen within this many minutes
    ];
    public const STATUSES   = ['new', 'known', 'ignored'];
    public const MAX_DAYS   = 31;
    public const MAX_PER    = 100;
    private const MAX_STEPS = 1000;
    private const ID_RE     = '/^[A-Za-z0-9_.:\-]{1,64}$/';
    private const NEG99     = '%"targetValue":"-99"%';

    private PDO $pdo;
    private array $config;
    private EventStore $store;
    private array $locMap;
    private ?array $catalog = null;
    private ?array $empIds = null;

    public function __construct(PDO $pdo, array $config, EventStore $store)
    {
        $this->pdo    = $pdo;
        $this->config = $config;
        $this->store  = $store;
        $this->locMap = (array) ($config['poc']['cam_locations'] ?? []);
    }

    // ── Settings (app_settings.json keys stranger_*) ─────────

    /** Effective settings from storage/app_settings.json (safe defaults: alerts off). */
    public static function configFrom(array $app): array
    {
        $d = self::DEFAULTS;
        $int = static fn (string $k, int $lo, int $hi, int $def): int
            => isset($app[$k]) && is_numeric($app[$k]) ? max($lo, min($hi, (int) $app[$k])) : $def;
        return [
            'alert_enabled'    => isset($app['stranger_alert_enabled']) ? (bool) $app['stranger_alert_enabled'] : $d['alert_enabled'],
            'alert_zone'       => isset($app['stranger_alert_zone']) ? (bool) $app['stranger_alert_zone'] : $d['alert_zone'],
            'alert_cams'       => $int('stranger_alert_cams', 0, 20, $d['alert_cams']),
            'alert_window_min' => $int('stranger_alert_window_min', 1, 240, $d['alert_window_min']),
            'episode_gap_min'  => $int('stranger_episode_gap_min', 5, 720, $d['episode_gap_min']),
            'onsite_min'       => $int('stranger_onsite_min', 5, 120, $d['onsite_min']),
        ];
    }

    /** POST /settings whitelist: only stranger_* keys, clamped. */
    public static function sanitize(array $in): array
    {
        $out = [];
        foreach (['stranger_alert_enabled', 'stranger_alert_zone'] as $k) {
            if (array_key_exists($k, $in)) {
                $out[$k] = filter_var($in[$k], FILTER_VALIDATE_BOOLEAN);
            }
        }
        foreach (['stranger_alert_cams' => [0, 20], 'stranger_alert_window_min' => [1, 240],
                  'stranger_episode_gap_min' => [5, 720], 'stranger_onsite_min' => [5, 120]] as $k => [$lo, $hi]) {
            if (array_key_exists($k, $in) && is_numeric($in[$k])) {
                $out[$k] = max($lo, min($hi, (int) $in[$k]));
            }
        }
        return $out;
    }

    private function cfg(): array
    {
        return ($this->config['strangers'] ?? null) ?: self::DEFAULTS;
    }

    // ── Shared helpers ───────────────────────────────────────

    public static function validId(string $id): bool
    {
        return (bool) preg_match(self::ID_RE, $id);
    }

    /**
     * YYYY-MM-DD range → [fromDT, toDT) + the clean dates. Defaults to today;
     * swapped when reversed; capped at MAX_DAYS days.
     * @return array{0:string,1:string,2:string,3:string}
     */
    public static function window(string $from, string $to): array
    {
        $ok = static fn (string $d): bool => (bool) preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) && strtotime($d) !== false;
        $t  = $ok($to) ? $to : date('Y-m-d');
        $f  = $ok($from) ? $from : $t;
        if ($f > $t) {
            [$f, $t] = [$t, $f];
        }
        $min = date('Y-m-d', (int) strtotime($t) - (self::MAX_DAYS - 1) * 86400);
        if ($f < $min) {
            $f = $min;
        }
        return [$f . ' 00:00:00', date('Y-m-d', (int) strtotime($t) + 86400) . ' 00:00:00', $f, $t];
    }

    /** Camera catalog (stream id → name / location), cache-file only — never a network call. */
    private function catalog(): array
    {
        if ($this->catalog !== null) {
            return $this->catalog;
        }
        $out = [];
        try {
            require_once __DIR__ . '/Floorplans.php';
            foreach ((new Floorplans($this->pdo, $this->config, dirname(__DIR__)))->cameraCatalog() as $id => $c) {
                $out[EventStore::streamLabel((string) $id)] = ['name' => (string) $c['name'], 'location' => (string) $c['location']];
            }
        } catch (Throwable $e) {
            // floor-plan module unavailable: fall back to the POC camera-point map
        }
        foreach ($this->locMap as $k => $loc) {
            $key = EventStore::streamLabel((string) $k);
            $out[$key] ??= ['name' => strtoupper((string) $k), 'location' => (string) $loc];
            if ($out[$key]['location'] === '') {
                $out[$key]['location'] = (string) $loc;
            }
        }
        return $this->catalog = $out;
    }

    private function plantOf(string $location): string
    {
        if ($location === '') {
            return '';
        }
        require_once __DIR__ . '/Attendance.php';
        static $att = null;
        $att ??= new Attendance($this->store, $this->config);
        return $att->plantOf($location);
    }

    /** One camera as the browser sees it. */
    private function camInfo(string $stream, string $device = ''): array
    {
        $key = EventStore::streamLabel($stream !== '' ? $stream : $device);
        $c   = $this->catalog()[$key] ?? null;
        $loc = (string) ($c['location'] ?? ($this->locMap[$key] ?? ''));
        return [
            'id'       => $key,
            'name'     => (string) ($c['name'] ?? strtoupper($stream !== '' ? $stream : ($device !== '' ? $device : 'camera'))),
            'location' => $loc,
            'plant'    => $this->plantOf($loc),
        ];
    }

    /** Stream labels that belong to a plant (via the camera-point → plant mapping). */
    private function plantStreams(string $plant): array
    {
        $out = [];
        foreach ($this->catalog() as $id => $c) {
            if ($c['location'] !== '' && $this->plantOf($c['location']) === $plant) {
                $out[] = (string) $id;
            }
        }
        return array_values(array_unique($out));
    }

    /** Filter options for the UI: plants + cameras. */
    public function filterOptions(): array
    {
        $cams = [];
        foreach ($this->catalog() as $id => $c) {
            $cams[] = ['id' => (string) $id, 'name' => $c['name'], 'location' => $c['location']];
        }
        return ['plants' => array_values((array) ($this->config['attendance']['plants'] ?? [])), 'cameras' => $cams];
    }

    /** id → canonical id (an alias resolves to the stranger it was merged into). */
    public function canonicalOf(string $id): string
    {
        $st = $this->pdo->prepare('SELECT canonical_id FROM stranger_aliases WHERE alias_id = :a LIMIT 1');
        $st->execute(['a' => $id]);
        $c = $st->fetchColumn();
        return $c !== false && (string) $c !== '' ? (string) $c : $id;
    }

    /** Every raw events.person_id that means this canonical stranger. */
    public function idsFor(string $canonical): array
    {
        $st = $this->pdo->prepare('SELECT alias_id FROM stranger_aliases WHERE canonical_id = :c');
        $st->execute(['c' => $canonical]);
        return array_values(array_unique(array_merge([$canonical], array_map('strval', $st->fetchAll(PDO::FETCH_COLUMN)))));
    }

    /**
     * Raw person ids that should be read together with $pid in a movement
     * path (used by Floorplans::idsFor): the canonical stranger + its aliases.
     * Never throws (tables may not exist yet).
     */
    public static function mergedIds(PDO $pdo, string $pid): array
    {
        try {
            $st = $pdo->prepare('SELECT alias_id FROM stranger_aliases WHERE canonical_id = :c LIMIT 200');
            $st->execute(['c' => $pid]);
            return array_map('strval', $st->fetchAll(PDO::FETCH_COLUMN));
        } catch (Throwable $e) {
            return [];
        }
    }

    /** Operator label for a stranger id (for the floor-plan person card), '' when none. */
    public static function labelOf(PDO $pdo, string $pid): string
    {
        try {
            $st = $pdo->prepare('SELECT label FROM stranger_profiles WHERE stranger_id = :s LIMIT 1');
            $st->execute(['s' => $pid]);
            return trim((string) ($st->fetchColumn() ?: ''));
        } catch (Throwable $e) {
            return '';
        }
    }

    /** Every id that identifies an employee: profile person_id + SenseStudio uid. */
    private function employeeIds(): array
    {
        if ($this->empIds !== null) {
            return $this->empIds;
        }
        $ids = [];
        try {
            foreach ($this->pdo->query('SELECT person_id, ss_uid FROM person_profiles')->fetchAll() as $r) {
                foreach ([$r['person_id'] ?? '', $r['ss_uid'] ?? ''] as $v) {
                    if ((string) $v !== '') {
                        $ids[(string) $v] = true;
                    }
                }
            }
        } catch (Throwable $e) {
            // employee columns not migrated yet
        }
        return $this->empIds = array_keys($ids);
    }

    /** Employee profile that owns this id (directly, via ss_uid, or via a merge), else null. */
    public function profileOf(string $id): ?array
    {
        $canon = $this->canonicalOf($id);
        try {
            $st = $this->pdo->prepare('SELECT person_id, name, staff_id FROM person_profiles
                                       WHERE person_id = :a OR person_id = :c OR ss_uid = :a2 OR ss_uid = :c2 LIMIT 1');
            $st->execute(['a' => $id, 'c' => $canon, 'a2' => $id, 'c2' => $canon]);
            $r = $st->fetch();
        } catch (Throwable $e) {
            $r = null;
        }
        return $r ? ['personId' => (string) $r['person_id'], 'name' => (string) $r['name'], 'staffId' => (string) ($r['staff_id'] ?? '')] : null;
    }

    /**
     * FROM + WHERE for stranger sightings in [$from, $to). `sid` is the
     * canonical stranger id expression. Filters: status (active|new|known|
     * ignored|labelled|all), camera, plant, q (id prefix / label).
     * Returns null when a filter can never match (e.g. a plant with no cameras).
     */
    private function base(string $from, string $to, array $f, array &$bind): ?string
    {
        $bind = ['f' => $from, 't' => $to];
        $sql = " FROM events e
                 LEFT JOIN stranger_aliases sa ON sa.alias_id = e.person_id
                 LEFT JOIN stranger_profiles sp ON sp.stranger_id = COALESCE(sa.canonical_id, e.person_id)
                WHERE e.received_at >= :f AND e.received_at < :t
                  AND e.person_id IS NOT NULL AND e.person_id <> ''
                  AND (e.person_name IS NULL OR e.person_name = '')
                  AND (e.feed_kind IS NULL OR e.feed_kind <> 'body')";
        // Employee ids (profile person_id + SenseStudio uid) as a constant list:
        // MySQL evaluates NOT IN (consts) with a binary search per row, far
        // cheaper than a correlated subquery over ~200k rows of a 31-day range.
        $emp = $this->employeeIds();
        if ($emp) {
            [$l1, $b1] = self::inList($emp, 'xe');
            [$l2, $b2] = self::inList($emp, 'xc');
            $bind += $b1 + $b2;
            $sql .= " AND e.person_id NOT IN ({$l1}) AND (sa.canonical_id IS NULL OR sa.canonical_id NOT IN ({$l2}))";
        }
        $status = (string) ($f['status'] ?? 'active');
        if ($status === 'active' || $status === '') {
            $sql .= " AND (sp.status IS NULL OR sp.status = 'new' OR sp.status = '')";
        } elseif (in_array($status, ['known', 'ignored'], true)) {
            $sql .= ' AND sp.status = :st';
            $bind['st'] = $status;
        } elseif ($status === 'new') {
            $sql .= " AND (sp.status IS NULL OR sp.status = 'new' OR sp.status = '') AND (sp.label IS NULL OR sp.label = '')";
        } elseif ($status === 'labelled') {
            $sql .= " AND sp.label IS NOT NULL AND sp.label <> ''";
        }
        $cam = EventStore::streamLabel((string) ($f['camera'] ?? ''));
        if (trim((string) ($f['camera'] ?? '')) !== '' && $cam !== 'default') {
            $sql .= ' AND e.stream = :cam';
            $bind['cam'] = $cam;
        }
        $plant = trim((string) ($f['plant'] ?? ''));
        if ($plant !== '') {
            $streams = $this->plantStreams($plant);
            if (!$streams) {
                return null;
            }
            $in = [];
            foreach (array_slice($streams, 0, 200) as $i => $s) {
                $in[] = ':ps' . $i;
                $bind['ps' . $i] = $s;
            }
            $sql .= ' AND e.stream IN (' . implode(',', $in) . ')';
        }
        $q = trim((string) ($f['q'] ?? ''));
        if ($q !== '') {
            $sql .= ' AND (e.person_id LIKE :qid OR sa.canonical_id LIKE :qid2 OR LOWER(sp.label) LIKE :ql)';
            $bind['qid']  = $q . '%';
            $bind['qid2'] = $q . '%';
            $bind['ql']   = '%' . mb_strtolower(mb_substr($q, 0, 60)) . '%';
        }
        return $sql;
    }

    private const SID = 'COALESCE(sa.canonical_id, e.person_id)';

    // ── List + KPIs ──────────────────────────────────────────

    /**
     * One row per stranger seen in the range, newest (or busiest) first, paged.
     * @param array{from?:string,to?:string,plant?:string,camera?:string,status?:string,q?:string,sort?:string,page?:int,per?:int} $f
     */
    public function list(array $f): array
    {
        [$from, $to, $fd, $td] = self::window((string) ($f['from'] ?? ''), (string) ($f['to'] ?? ''));
        $per  = max(1, min(self::MAX_PER, (int) ($f['per'] ?? 24)));
        $page = max(1, (int) ($f['page'] ?? 1));
        $sort = ($f['sort'] ?? '') === 'sightings' ? 'n DESC, last_seen DESC' : 'last_seen DESC, n DESC';
        $out  = ['from' => $fd, 'to' => $td, 'page' => $page, 'per' => $per, 'total' => 0, 'items' => []];

        $bind = [];
        $base = $this->base($from, $to, $f, $bind);
        if ($base === null) {
            return $out;
        }
        $st = $this->pdo->prepare('SELECT COUNT(DISTINCT ' . self::SID . ')' . $base);
        $st->execute($bind);
        $out['total'] = (int) $st->fetchColumn();
        if ($out['total'] === 0) {
            return $out;
        }
        $st = $this->pdo->prepare('SELECT ' . self::SID . ' AS sid, COUNT(*) AS n, MIN(e.received_at) AS first_seen,
                                          MAX(e.received_at) AS last_seen, COUNT(DISTINCT e.stream) AS cams'
            . $base . ' GROUP BY ' . self::SID . ' ORDER BY ' . $sort
            . ' LIMIT ' . $per . ' OFFSET ' . (($page - 1) * $per));
        $st->execute($bind);
        $rows = $st->fetchAll();
        $out['items'] = $this->enrich($rows, $from, $to);
        return $out;
    }

    /**
     * Page rows → full cards: label/status, aliases, cameras + zones visited,
     * latest face crop (absolute URL via EventStore::fullUrl), on-site flag.
     */
    private function enrich(array $rows, string $from, string $to): array
    {
        if (!$rows) {
            return [];
        }
        $sids = array_map(static fn ($r) => (string) $r['sid'], $rows);
        $prof = $this->profilesFor($sids);
        $alias = $this->aliasesFor($sids);       // canonical → [alias…]
        $raw  = [];                              // raw id → canonical
        foreach ($sids as $s) {
            $raw[$s] = $s;
            foreach ($alias[$s] ?? [] as $a) {
                $raw[$a] = $s;
            }
        }
        [$in, $bind] = self::inList(array_keys($raw), 'r');
        $bind += ['f' => $from, 't' => $to];

        $cams = [];
        $st = $this->pdo->prepare("SELECT person_id, stream, device_name, COUNT(*) AS n, MAX(received_at) AS last
                                     FROM events WHERE person_id IN ({$in}) AND received_at >= :f AND received_at < :t
                                      AND (person_name IS NULL OR person_name = '')
                                    GROUP BY person_id, stream, device_name");
        $st->execute($bind);
        foreach ($st->fetchAll() as $r) {
            $sid = $raw[(string) $r['person_id']] ?? null;
            if ($sid === null) {
                continue;
            }
            $ci = $this->camInfo((string) ($r['stream'] ?? ''), (string) ($r['device_name'] ?? ''));
            $k  = $ci['id'];
            if (!isset($cams[$sid][$k])) {
                $cams[$sid][$k] = $ci + ['n' => 0, 'last' => ''];
            }
            $cams[$sid][$k]['n'] += (int) $r['n'];
            if (strcmp((string) $r['last'], $cams[$sid][$k]['last']) > 0) {
                $cams[$sid][$k]['last'] = (string) $r['last'];
            }
        }

        // Latest capture with a face crop per raw id (one row each via MAX(id)).
        $img = [];
        $st = $this->pdo->prepare("SELECT e.id, e.uuid, e.person_id, e.stream, e.device_name, e.trigger_img_url, e.bk_image_url, e.received_at
                                     FROM events e JOIN (
                                          SELECT person_id, MAX(id) AS mid FROM events
                                           WHERE person_id IN ({$in}) AND received_at >= :f AND received_at < :t
                                             AND (person_name IS NULL OR person_name = '')
                                           GROUP BY person_id) m ON m.mid = e.id");
        $st->execute($bind);
        foreach ($st->fetchAll() as $r) {
            $sid = $raw[(string) $r['person_id']] ?? null;
            if ($sid !== null && (!isset($img[$sid]) || (int) $r['id'] > (int) $img[$sid]['id'])) {
                $img[$sid] = $r;
            }
        }

        $onsite = time() - (int) $this->cfg()['onsite_min'] * 60;
        $out = [];
        foreach ($rows as $r) {
            $sid = (string) $r['sid'];
            $p   = $prof[$sid] ?? [];
            $cl  = array_values($cams[$sid] ?? []);
            usort($cl, static fn ($a, $b) => strcmp($b['last'], $a['last']));
            $li  = $img[$sid] ?? null;
            $zones = array_values(array_unique(array_filter(array_map(static fn ($c) => $c['location'], $cl))));
            $plants = array_values(array_unique(array_filter(array_map(static fn ($c) => $c['plant'], $cl))));
            $out[] = [
                'id'         => $sid,
                'label'      => (string) ($p['label'] ?? ''),
                'status'     => (string) (($p['status'] ?? '') ?: 'new'),
                'note'       => (string) ($p['note'] ?? ''),
                'aliases'    => $alias[$sid] ?? [],
                'sightings'  => (int) $r['n'],
                'first_seen' => (string) $r['first_seen'],
                'last_seen'  => (string) $r['last_seen'],
                'camera_count' => (int) $r['cams'],
                'cameras'    => array_map(static fn ($c) => ['id' => $c['id'], 'name' => $c['name'], 'location' => $c['location'], 'n' => $c['n']], $cl),
                'zones'      => $zones,
                'plants'     => $plants,
                'last_camera'=> $cl[0]['name'] ?? '',
                'last_zone'  => $cl[0]['location'] ?? '',
                'face'       => $li ? $this->store->fullUrl(((string) ($li['trigger_img_url'] ?? '')) ?: null) : null,
                'scene'      => $li ? $this->store->fullUrl(((string) ($li['bk_image_url'] ?? '')) ?: null) : null,
                'event_uuid' => $li ? (string) ($li['uuid'] ?? '') : '',
                'on_site'    => (strtotime((string) $r['last_seen']) ?: 0) >= $onsite,
            ];
        }
        return $out;
    }

    /** KPI tiles: strangers today, currently on site, repeat visitors (seen today and on an earlier day in the last 30 days). */
    public function kpis(array $f = []): array
    {
        $flt  = ['plant' => $f['plant'] ?? '', 'camera' => $f['camera'] ?? '', 'status' => 'active'];
        $today = date('Y-m-d');
        $out  = ['today' => 0, 'on_site' => 0, 'repeat' => 0, 'onsite_min' => (int) $this->cfg()['onsite_min']];
        $bind = [];
        $base = $this->base($today . ' 00:00:00', date('Y-m-d', time() + 86400) . ' 00:00:00', $flt, $bind);
        if ($base === null) {
            return $out;
        }
        $st = $this->pdo->prepare('SELECT DISTINCT ' . self::SID . ' AS sid' . $base . ' LIMIT 5000');
        $st->execute($bind);
        $todayIds = array_map('strval', $st->fetchAll(PDO::FETCH_COLUMN));
        $out['today'] = count($todayIds);
        if (!$todayIds) {
            return $out;
        }
        $base = $this->base(date('Y-m-d H:i:s', time() - $out['onsite_min'] * 60), date('Y-m-d H:i:s', time() + 60), $flt, $bind);
        $st = $this->pdo->prepare('SELECT COUNT(DISTINCT ' . self::SID . ')' . $base);
        $st->execute($bind);
        $out['on_site'] = (int) $st->fetchColumn();

        // Repeat visitors: any of today's strangers (or their aliases) seen in the 30 days before today.
        $raw = [];
        foreach ($this->aliasesFor($todayIds) as $c => $as) {
            foreach ($as as $a) {
                $raw[$a] = $c;
            }
        }
        foreach ($todayIds as $s) {
            $raw[$s] = $s;
        }
        $seen = [];
        foreach (array_chunk(array_keys($raw), 400) as $chunk) {
            [$in, $b] = self::inList($chunk, 'r');
            $st = $this->pdo->prepare("SELECT DISTINCT person_id FROM events WHERE person_id IN ({$in}) AND received_at >= :p AND received_at < :t");
            $st->execute($b + ['p' => date('Y-m-d', time() - 30 * 86400) . ' 00:00:00', 't' => $today . ' 00:00:00']);
            foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $pid) {
                $seen[$raw[(string) $pid] ?? (string) $pid] = true;
            }
        }
        $out['repeat'] = count($seen);
        return $out;
    }

    /**
     * Face pushes with NO person id but the stranger marker (Person Group −99).
     * They can't be linked to any other sighting, so they are single sightings.
     */
    public function unlinked(array $f): array
    {
        [$from, $to, $fd, $td] = self::window((string) ($f['from'] ?? ''), (string) ($f['to'] ?? ''));
        $per  = max(1, min(60, (int) ($f['per'] ?? 24)));
        $page = max(1, (int) ($f['page'] ?? 1));
        $bind = ['f' => $from, 't' => $to, 'neg' => self::NEG99];
        $where = "received_at >= :f AND received_at < :t AND (person_id IS NULL OR person_id = '')
                  AND (feed_kind IS NULL OR feed_kind <> 'body') AND raw_json LIKE :neg";
        $cam = trim((string) ($f['camera'] ?? ''));
        if ($cam !== '') {
            $where .= ' AND stream = :cam';
            $bind['cam'] = EventStore::streamLabel($cam);
        }
        $plant = trim((string) ($f['plant'] ?? ''));
        if ($plant !== '') {
            $streams = $this->plantStreams($plant);
            if (!$streams) {
                return ['from' => $fd, 'to' => $td, 'page' => $page, 'per' => $per, 'total' => 0, 'capped' => false, 'items' => []];
            }
            [$in, $b] = self::inList($streams, 'ps');
            $where .= " AND stream IN ({$in})";
            $bind += $b;
        }
        $st = $this->pdo->prepare("SELECT COUNT(*) FROM (SELECT id FROM events WHERE {$where} LIMIT 1000) x");
        $st->execute($bind);
        $total = (int) $st->fetchColumn();
        $st = $this->pdo->prepare("SELECT id, uuid, stream, device_name, received_at, trigger_img_url, bk_image_url
                                     FROM events WHERE {$where} ORDER BY id DESC LIMIT {$per} OFFSET " . (($page - 1) * $per));
        $st->execute($bind);
        $items = [];
        foreach ($st->fetchAll() as $r) {
            $ci = $this->camInfo((string) ($r['stream'] ?? ''), (string) ($r['device_name'] ?? ''));
            $items[] = [
                'event_id' => (int) $r['id'], 'uuid' => (string) ($r['uuid'] ?? ''), 'time' => (string) $r['received_at'],
                'camera' => $ci['name'], 'camera_id' => $ci['id'], 'location' => $ci['location'], 'plant' => $ci['plant'],
                'face' => $this->store->fullUrl(((string) ($r['trigger_img_url'] ?? '')) ?: null),
                'scene' => $this->store->fullUrl(((string) ($r['bk_image_url'] ?? '')) ?: null),
            ];
        }
        return ['from' => $fd, 'to' => $td, 'page' => $page, 'per' => $per, 'total' => $total, 'capped' => $total >= 1000, 'items' => $items];
    }

    // ── Journey ──────────────────────────────────────────────

    /**
     * Ordered sightings (with images) + camera visits with dwell times for one
     * stranger (aliases folded in). Visits use Floorplans::collapse — the same
     * run rule as the floor-plan path, so the two views agree.
     */
    public function journey(string $id, string $fromD, string $toD): ?array
    {
        if (!self::validId($id)) {
            return null;
        }
        [$from, $to, $fd, $td] = self::window($fromD, $toD);
        $sid = $this->canonicalOf($id);
        $ids = $this->idsFor($sid);
        [$in, $bind] = self::inList($ids, 'p');
        $st = $this->pdo->prepare("SELECT id, uuid, person_id, stream, device_name, received_at, trigger_img_url, bk_image_url, similarity
                                     FROM events WHERE person_id IN ({$in}) AND received_at >= :f AND received_at < :t
                                    ORDER BY received_at ASC, id ASC LIMIT " . (self::MAX_STEPS + 1));
        $st->execute($bind + ['f' => $from, 't' => $to]);
        $rows = $st->fetchAll();
        $truncated = count($rows) > self::MAX_STEPS;
        $rows = array_slice($rows, 0, self::MAX_STEPS);

        $steps = [];
        $dets  = [];
        $byId  = [];
        $days  = [];
        foreach ($rows as $r) {
            $ci   = $this->camInfo((string) ($r['stream'] ?? ''), (string) ($r['device_name'] ?? ''));
            $face = $this->store->fullUrl(((string) ($r['trigger_img_url'] ?? '')) ?: null);
            $step = [
                'event_id' => (int) $r['id'], 'uuid' => (string) ($r['uuid'] ?? ''), 'raw_id' => (string) $r['person_id'],
                'time' => (string) $r['received_at'], 'camera' => $ci['name'], 'camera_id' => $ci['id'],
                'location' => $ci['location'], 'plant' => $ci['plant'],
                'face' => $face, 'scene' => $this->store->fullUrl(((string) ($r['bk_image_url'] ?? '')) ?: null),
                'similarity' => (string) ($r['similarity'] ?? ''),
            ];
            $steps[] = $step;
            $byId[(int) $r['id']] = $step;
            $days[substr((string) $r['received_at'], 0, 10)] = true;
            $dets[] = ['event_id' => (int) $r['id'], 'cam' => $ci['id'], 'ts' => strtotime((string) $r['received_at']) ?: 0,
                       'time' => (string) $r['received_at'], 'has_image' => $face !== null && $face !== ''];
        }
        require_once __DIR__ . '/Floorplans.php';
        $gap = (int) (($this->config['movement']['gap_min'] ?? null) ?: Floorplans::DEFAULT_GAP_MIN);
        $visits = [];
        foreach (Floorplans::collapse($dets, max(1, $gap) * 60) as $run) {
            $first = $byId[$run['thumb_event'] ?? $run['event_ids'][0]] ?? $byId[$run['event_ids'][0]];
            $visits[] = [
                'camera' => $first['camera'], 'camera_id' => $first['camera_id'], 'location' => $first['location'], 'plant' => $first['plant'],
                'arrive' => $run['first_seen'], 'depart' => $run['last_seen'], 'dwell_s' => max(0, $run['last_ts'] - $run['first_ts']),
                'count' => $run['count'], 'face' => $first['face'], 'scene' => $first['scene'],
                'uuid' => $first['uuid'], 'event_id' => $first['event_id'],
            ];
        }
        $p = $this->profilesFor([$sid])[$sid] ?? [];
        $cams = array_values(array_unique(array_column($steps, 'camera')));
        return [
            'id'        => $sid,
            'requested' => $id,
            'label'     => (string) ($p['label'] ?? ''),
            'status'    => (string) (($p['status'] ?? '') ?: 'new'),
            'note'      => (string) ($p['note'] ?? ''),
            'aliases'   => array_values(array_diff($ids, [$sid])),
            'registered'=> $this->profileOf($sid),
            'range'     => ['from' => $fd, 'to' => $td],
            'gap_min'   => $gap,
            'days'      => array_keys($days),
            'steps'     => $steps,
            'visits'    => $visits,
            'summary'   => [
                'sightings'  => count($steps),
                'visits'     => count($visits),
                'cameras'    => count($cams),
                'first_seen' => $steps ? $steps[0]['time'] : null,
                'last_seen'  => $steps ? $steps[count($steps) - 1]['time'] : null,
                'dwell_s'    => array_sum(array_column($visits, 'dwell_s')),
                'truncated'  => $truncated,
            ],
            'face'      => self::lastFace($steps),
        ];
    }

    private static function lastFace(array $steps): ?string
    {
        for ($i = count($steps) - 1; $i >= 0; $i--) {
            if (!empty($steps[$i]['face'])) {
                return $steps[$i]['face'];
            }
        }
        return null;
    }

    // ── Operator actions ─────────────────────────────────────

    /** Upsert the operator fields of a canonical stranger. */
    private function upsert(string $sid, array $set, string $actor): void
    {
        $now = date('Y-m-d H:i:s');
        $st  = $this->pdo->prepare('SELECT COUNT(*) FROM stranger_profiles WHERE stranger_id = :s');
        $st->execute(['s' => $sid]);
        $bind = ['s' => $sid, 'u' => $now, 'by' => mb_substr($actor, 0, 120)];
        $cols = [];
        foreach ($set as $k => $v) {
            $cols[$k] = $v;
            $bind['v_' . $k] = $v;
        }
        if ((int) $st->fetchColumn() > 0) {
            $sql = 'UPDATE stranger_profiles SET ' . implode(', ', array_map(static fn ($k) => "{$k} = :v_{$k}", array_keys($cols)))
                 . ', updated_at = :u, updated_by = :by WHERE stranger_id = :s';
        } else {
            $sql = 'INSERT INTO stranger_profiles (stranger_id, ' . implode(', ', array_keys($cols)) . ', created_at, updated_at, updated_by)
                    VALUES (:s, ' . implode(', ', array_map(static fn ($k) => ':v_' . $k, array_keys($cols))) . ', :u, :u2, :by)';
            $bind['u2'] = $now;
        }
        $this->pdo->prepare($sql)->execute($bind);
    }

    /** @throws InvalidArgumentException */
    private function requireStranger(string $id): string
    {
        if (!self::validId($id)) {
            throw new InvalidArgumentException('Not a valid stranger id.');
        }
        $sid = $this->canonicalOf($id);
        if ($this->profileOf($sid) !== null) {
            throw new InvalidArgumentException('This person is already registered as an employee.');
        }
        return $sid;
    }

    public function setLabel(string $id, string $label, ?string $note, string $actor): array
    {
        $sid = $this->requireStranger($id);
        $set = ['label' => mb_substr(trim(strip_tags($label)), 0, 120)];
        if ($note !== null) {
            $set['note'] = mb_substr(trim(strip_tags($note)), 0, 500);
        }
        $this->upsert($sid, $set, $actor);
        return $this->state($sid);
    }

    public function setStatus(string $id, string $status, string $actor): array
    {
        if (!in_array($status, self::STATUSES, true)) {
            throw new InvalidArgumentException('Status must be new, known or ignored.');
        }
        $sid = $this->requireStranger($id);
        $this->upsert($sid, ['status' => $status], $actor);
        return $this->state($sid);
    }

    /**
     * "Merge with…": $id (and everything already merged into it) becomes an
     * alias of $into's canonical stranger. Label / status carry over when the
     * target has none.
     */
    public function merge(string $id, string $into, string $actor): array
    {
        $a = $this->requireStranger($id);
        $b = $this->requireStranger($into);
        if ($a === $b) {
            throw new InvalidArgumentException('These ids are already the same stranger.');
        }
        $now = date('Y-m-d H:i:s');
        $this->pdo->beginTransaction();
        try {
            $this->pdo->prepare('UPDATE stranger_aliases SET canonical_id = :b WHERE canonical_id = :a')->execute(['a' => $a, 'b' => $b]);
            $this->pdo->prepare('DELETE FROM stranger_aliases WHERE alias_id = :a')->execute(['a' => $a]);
            $this->pdo->prepare('INSERT INTO stranger_aliases (alias_id, canonical_id, created_by, created_at) VALUES (:a, :b, :by, :t)')
                ->execute(['a' => $a, 'b' => $b, 'by' => mb_substr($actor, 0, 120), 't' => $now]);
            $pa = $this->profilesFor([$a])[$a] ?? null;
            $pb = $this->profilesFor([$b])[$b] ?? null;
            if ($pa) {
                $carry = [];
                if (($pb['label'] ?? '') === '' && ($pa['label'] ?? '') !== '') {
                    $carry['label'] = $pa['label'];
                }
                if ((($pb['status'] ?? '') === '' || ($pb['status'] ?? '') === 'new') && in_array($pa['status'] ?? '', ['known', 'ignored'], true)) {
                    $carry['status'] = $pa['status'];
                }
                if (($pb['note'] ?? '') === '' && ($pa['note'] ?? '') !== '') {
                    $carry['note'] = $pa['note'];
                }
                if ($carry) {
                    $this->upsert($b, $carry, $actor);
                }
                $this->pdo->prepare('DELETE FROM stranger_profiles WHERE stranger_id = :a')->execute(['a' => $a]);
            }
            $this->pdo->commit();
        } catch (Throwable $e) {
            $this->pdo->rollBack();
            throw $e;
        }
        return $this->state($b);
    }

    /** Undo a merge: the alias id becomes its own stranger again. */
    public function unmerge(string $aliasId): array
    {
        if (!self::validId($aliasId)) {
            throw new InvalidArgumentException('Not a valid stranger id.');
        }
        $canon = $this->canonicalOf($aliasId);
        if ($canon === $aliasId) {
            throw new InvalidArgumentException('#' . $aliasId . ' is not merged into another stranger.');
        }
        $this->pdo->prepare('DELETE FROM stranger_aliases WHERE alias_id = :a')->execute(['a' => $aliasId]);
        return ['unmerged' => $aliasId, 'from' => $this->state($canon)];
    }

    /** Current operator state of a canonical stranger. */
    public function state(string $sid): array
    {
        $p = $this->profilesFor([$sid])[$sid] ?? [];
        return ['id' => $sid, 'label' => (string) ($p['label'] ?? ''), 'status' => (string) (($p['status'] ?? '') ?: 'new'),
                'note' => (string) ($p['note'] ?? ''), 'aliases' => array_values(array_diff($this->idsFor($sid), [$sid]))];
    }

    // ── Find by photo ────────────────────────────────────────

    public function senseReady(): bool
    {
        $sa = $this->config['sense_api'] ?? [];
        return !empty($sa['base']) && !empty($sa['account']) && !empty($sa['password']);
    }

    /**
     * 1:N search of an uploaded face against SenseStudio's stranger library
     * (SenseApi::searchFaceByImage 'Passer'), enriched with what we know of
     * each match over the last 30 days. Degrades to a clear error, never throws.
     */
    public function searchByPhoto(string $file, float $threshold = 0.35): array
    {
        if (!$this->senseReady()) {
            return ['ok' => false, 'error' => 'SenseStudio is not configured (Settings › Cameras & RTSP).', 'matches' => []];
        }
        require_once __DIR__ . '/SenseApi.php';
        try {
            $api = new SenseApi($this->config['sense_api'], dirname(__DIR__) . '/storage');
            $r   = $api->searchFaceByImage($file, 'Passer', 10, max(0.05, min(0.95, $threshold)));
        } catch (Throwable $e) {
            return ['ok' => false, 'error' => 'SenseStudio face search failed — ' . $e->getMessage(), 'matches' => []];
        }
        if (empty($r['ok'])) {
            return ['ok' => false, 'error' => 'SenseStudio face search failed — ' . (string) ($r['error'] ?? $r['msg'] ?? 'no answer'), 'matches' => []];
        }
        $hits = [];
        foreach ((array) ($r['data'] ?? []) as $m) {
            if (!is_array($m)) {
                continue;
            }
            $pid = trim((string) ($m['personID'] ?? $m['personId'] ?? ''));
            if (!self::validId($pid)) {
                continue;
            }
            $score = (float) ($m['score'] ?? 0);
            $sid   = $this->canonicalOf($pid);
            if (!isset($hits[$sid]) || $score > $hits[$sid]['score']) {
                $hits[$sid] = ['id' => $sid, 'matched_id' => $pid, 'score' => $score, 'avatar' => (string) ($m['avatar'] ?? '')];
            }
        }
        usort($hits, static fn ($a, $b) => $b['score'] <=> $a['score']);
        $from = date('Y-m-d H:i:s', time() - 30 * 86400);
        $out  = [];
        foreach (array_slice($hits, 0, 10) as $h) {
            [$in, $bind] = self::inList($this->idsFor($h['id']), 'p');
            $st = $this->pdo->prepare("SELECT COUNT(*) AS n, MAX(received_at) AS last, MAX(id) AS mid FROM events WHERE person_id IN ({$in}) AND received_at >= :f");
            $st->execute($bind + ['f' => $from]);
            $agg  = $st->fetch() ?: [];
            $face = null;
            if (!empty($agg['mid'])) {
                $q = $this->pdo->prepare('SELECT trigger_img_url FROM events WHERE id = :i');
                $q->execute(['i' => (int) $agg['mid']]);
                $face = $this->store->fullUrl(((string) ($q->fetchColumn() ?: '')) ?: null);
            }
            $p   = $this->profilesFor([$h['id']])[$h['id']] ?? [];
            $pct = $h['score'] <= 1 ? $h['score'] * 100 : $h['score'];
            $out[] = [
                'id' => $h['id'], 'matched_id' => $h['matched_id'], 'score' => round($pct, 1), 'confident' => $pct >= 75,
                'label' => (string) ($p['label'] ?? ''), 'status' => (string) (($p['status'] ?? '') ?: 'new'),
                'registered' => $this->profileOf($h['id']),
                'sightings_30d' => (int) ($agg['n'] ?? 0), 'last_seen' => $agg['last'] ?? null,
                'face' => $face ?? ($h['avatar'] !== '' ? $this->store->fullUrl($h['avatar']) : null),
            ];
        }
        return ['ok' => true, 'matches' => $out, 'note' => $out ? null : 'No stranger in the SenseStudio library matched this photo.'];
    }

    // ── Alert (ingest hook) ──────────────────────────────────

    /**
     * Called by EventStore::store() for every stored event when
     * strangers.alert_enabled is on. Alerts once per stranger per episode when
     * a stranger not marked known/ignored is seen at a restricted-zone camera
     * (inside the zone's restricted hours) or on ≥ N cameras within M minutes.
     * Reuses the alert plumbing: Telegram + alert e-mail list + in-app bell.
     * Never throws.
     */
    public static function onIngest(PDO $pdo, array $config, EventStore $store, array $row): void
    {
        try {
            $cfg = ($config['strangers'] ?? null) ?: self::DEFAULTS;
            if (empty($cfg['alert_enabled'])) {
                return;
            }
            $pid = trim((string) ($row['person_id'] ?? ''));
            if ($pid === '' || trim((string) ($row['person_name'] ?? '')) !== '' || ($row['feed_kind'] ?? '') === 'body' || !self::validId($pid)) {
                return;
            }
            $s   = new self($pdo, $config, $store);
            $sid = $s->canonicalOf($pid);
            if ($s->profileOf($sid) !== null) {
                return;
            }
            $p    = $s->profilesFor([$sid])[$sid] ?? [];
            if (in_array($p['status'] ?? '', ['known', 'ignored'], true)) {
                return;
            }
            $now  = time();
            $seen = (string) ($row['received_at'] ?? date('Y-m-d H:i:s', $now));
            $last = strtotime((string) ($p['alert_last'] ?? '')) ?: 0;
            if ($last > 0 && $now - $last <= (int) $cfg['episode_gap_min'] * 60) {
                // Same episode, already alerted: keep the episode open while they are seen.
                $s->upsert($sid, ['alert_last' => $seen], 'system');
                return;
            }
            $reason = $s->alertReason($sid, $row, $cfg, $now);
            if ($reason === null) {
                return;
            }
            $s->upsert($sid, ['alert_at' => $seen, 'alert_last' => $seen, 'alert_reason' => mb_substr($reason, 0, 255)], 'system');
            $s->deliver($sid, (string) ($p['label'] ?? ''), $reason, $row);
        } catch (Throwable $e) {
            error_log('[strangers] ' . $e->getMessage());
        }
    }

    /** Why this sighting alerts, or null. */
    private function alertReason(string $sid, array $row, array $cfg, int $now): ?string
    {
        $stream = (string) ($row['stream'] ?? '');
        if (!empty($cfg['alert_zone']) && !empty($this->config['restricted']['zones'])) {
            require_once __DIR__ . '/Restricted.php';
            $zone = (new Restricted($this->pdo, $this->config, $this->store))->zoneOf($stream, (string) ($row['device_name'] ?? ''));
            if ($zone !== null && Restricted::inWindow((string) ($zone['hours'] ?? 'always'), $now)) {
                return 'Seen in restricted zone "' . ((string) ($zone['name'] ?? '') ?: strtoupper($stream)) . '"';
            }
        }
        $n = (int) $cfg['alert_cams'];
        if ($n >= 2) {
            [$in, $bind] = self::inList($this->idsFor($sid), 'p');
            $st = $this->pdo->prepare("SELECT COUNT(DISTINCT stream) FROM events WHERE person_id IN ({$in}) AND received_at >= :f");
            $st->execute($bind + ['f' => date('Y-m-d H:i:s', $now - (int) $cfg['alert_window_min'] * 60)]);
            $c = (int) $st->fetchColumn();
            if ($c >= $n) {
                return 'Seen on ' . $c . ' cameras within ' . (int) $cfg['alert_window_min'] . ' min';
            }
        }
        return null;
    }

    /** Telegram + alert e-mail list + in-app bell (supervisor/admin tier with `view`). */
    private function deliver(string $sid, string $label, string $reason, array $row): void
    {
        require_once __DIR__ . '/Alerting.php';
        require_once __DIR__ . '/Telegram.php';
        $who   = $label !== '' ? $label . ' (stranger #' . $sid . ')' : 'Unknown person · stranger #' . $sid;
        $cam   = $this->camInfo((string) ($row['stream'] ?? ''), (string) ($row['device_name'] ?? ''));
        $img   = $this->store->fullUrl(((string) ($row['trigger_img_url'] ?? '')) ?: null);
        $time  = (string) (($row['trigger_time'] ?? '') ?: ($row['received_at'] ?? ''));
        $title = 'Stranger alert — ' . $reason;
        $logDir = dirname((string) ($this->config['storage']['raw_log'] ?? (dirname(__DIR__) . '/storage/x')));
        $host  = rtrim((string) ($this->config['app']['url'] ?? ''), '/');

        $tg = $this->config['telegram'] ?? [];
        if (Telegram::ready($tg)) {
            $text = Alerting::eventText(['sev' => 'high', 'mod' => 'face', 'banner' => 'STRANGER ALERT', 'title' => $title,
                'camera' => $cam['name'], 'location' => $cam['location'], 'person' => $who, 'time' => $time,
                'url' => $host !== '' ? $host . '/#movement/strangers' : '']);
            $r = Telegram::send($tg, $text, $img);
            Alerting::logSend('telegram', (bool) ($r['ok'] ?? false), 'stranger', (string) ($row['uuid'] ?? ''), $title, false, $logDir);
        }

        $mail = $this->config['mail'] ?? [];
        if (!empty($mail['host']) && !empty($mail['username']) && ($mail['enabled'] ?? true) !== false
            && (($this->config['alerts']['email_enabled'] ?? true) !== false) && !empty($mail['to'])) {
            try {
                require_once __DIR__ . '/Mailer.php';
                require_once __DIR__ . '/EmailTemplate.php';
                $to = Mailer::parseList((array) $mail['to'], 100);
                if ($to) {
                    $html = EmailTemplate::shell('Stranger alert — ' . $who, 'STRANGER ALERT', EmailTemplate::COLORS['high'],
                        EmailTemplate::heading($title)
                        . EmailTemplate::sub('A face with no employee profile was tracked by the cameras.')
                        . EmailTemplate::image($img, 'Face capture · ' . $cam['name'])
                        . EmailTemplate::rows([['Person', $who, EmailTemplate::COLORS['high']], ['Camera', $cam['name']],
                            ['Location', $cam['location'] ?: '—'], ['Reason', $reason], ['Time', $time ?: '—']])
                        . EmailTemplate::buttons([['Open stranger movement', EmailTemplate::host() . '/#movement/strangers', true]]));
                    $ok = (new Mailer($mail))->send('[Kian Joo VisionAI] Stranger alert — ' . $reason, $html, $to);
                    Alerting::logSend('email', $ok, 'stranger', (string) ($row['uuid'] ?? ''), $title, false, $logDir);
                }
            } catch (Throwable $e) {
                error_log('[strangers-mail] ' . $e->getMessage());
            }
        }

        require_once __DIR__ . '/Notifications.php';
        Notifications::emit($this->pdo, $this->viewerIds(), 'stranger_alert', $title,
            $who . ' · ' . $cam['name'] . ($cam['location'] !== '' ? ' (' . $cam['location'] . ')' : '') . ' · ' . $time,
            '#movement/strangers', 'stranger', null);
    }

    /** Active users at supervisor/admin tier with the `view` permission. */
    private function viewerIds(): array
    {
        require_once __DIR__ . '/Auth.php';
        require_once __DIR__ . '/AiGuard.php';
        $roles = Auth::roles();
        $ids = [];
        foreach ($this->pdo->query('SELECT id, role FROM users WHERE active = 1')->fetchAll() as $u) {
            $role  = (string) ($u['role'] ?: 'operator');
            $perms = $roles[$role]['perms'] ?? ($role === 'superadmin' ? Auth::DEFAULT_ROLES['admin']['perms'] : Auth::permsFor($role));
            if ((AiGuard::TIER_RANK[AiGuard::tierOf($role, $perms)] ?? 0) >= AiGuard::TIER_RANK['supervisor'] && !empty($perms['view'])) {
                $ids[] = (int) $u['id'];
            }
        }
        return array_slice($ids, 0, 50);
    }

    // ── small SQL helpers ────────────────────────────────────

    /** @return array<string, array{label:string,status:string,note:string,alert_last:?string}> */
    private function profilesFor(array $sids): array
    {
        $sids = array_values(array_unique(array_filter(array_map('strval', $sids), static fn ($s) => $s !== '')));
        if (!$sids) {
            return [];
        }
        [$in, $bind] = self::inList($sids, 's');
        $st = $this->pdo->prepare("SELECT stranger_id, label, status, note, alert_last FROM stranger_profiles WHERE stranger_id IN ({$in})");
        $st->execute($bind);
        $out = [];
        foreach ($st->fetchAll() as $r) {
            $out[(string) $r['stranger_id']] = ['label' => (string) ($r['label'] ?? ''), 'status' => (string) ($r['status'] ?? ''),
                                                'note' => (string) ($r['note'] ?? ''), 'alert_last' => $r['alert_last'] ?? null];
        }
        return $out;
    }

    /** @return array<string, list<string>> canonical → alias ids */
    private function aliasesFor(array $sids): array
    {
        $sids = array_values(array_unique(array_map('strval', $sids)));
        if (!$sids) {
            return [];
        }
        $out = [];
        foreach (array_chunk($sids, 400) as $chunk) {
            [$in, $bind] = self::inList($chunk, 'c');
            $st = $this->pdo->prepare("SELECT alias_id, canonical_id FROM stranger_aliases WHERE canonical_id IN ({$in})");
            $st->execute($bind);
            foreach ($st->fetchAll() as $r) {
                $out[(string) $r['canonical_id']][] = (string) $r['alias_id'];
            }
        }
        return $out;
    }

    /** @return array{0:string,1:array<string,string>} "(:x0,:x1…)" body + binds */
    private static function inList(array $vals, string $prefix): array
    {
        $ph = [];
        $bind = [];
        foreach (array_values($vals) as $i => $v) {
            $ph[] = ':' . $prefix . $i;
            $bind[$prefix . $i] = (string) $v;
        }
        return [$ph ? implode(',', $ph) : "''", $bind];
    }
}
