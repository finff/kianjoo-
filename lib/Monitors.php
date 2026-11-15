<?php
/**
 * VisionAI camera monitors — catalog, settings, per-camera config, runtime state.
 *
 * Storage:
 *   app_settings.json  monitor_settings  global scan settings (env MONITOR_* defaults underneath)
 *                      cam_monitors      {stream: {enabled, fields[], interval_sec|null, action{}, force_fit}}
 *   storage/monitor_state.json           runtime only, written by MonitorScanner (LOCK_EX)
 *
 * config/config.php exposes the merged result as $config['monitor'] via
 * configFrom(); writers here re-merge so a request sees its own save.
 * Nothing in view() carries a key, an RTSP URL or a credential.
 */

declare(strict_types=1);

require_once __DIR__ . '/LiveBridge.php';

final class Monitors
{
    public const INTERVALS  = [30, 60, 120, 300];
    public const PRIORITIES = ['low', 'medium', 'high', 'critical'];
    public const KINDS      = ['monitor_gate', 'monitor_review', 'monitor_fitness'];
    public const SOURCE     = 'monitor_cascade';
    public const PPE_ITEMS  = ['helmet', 'vest', 'goggles', 'gloves', 'boots', 'hairnet', 'ear'];

    /**
     * Field catalog. gate = the fast model's cheap trigger question; fit = the
     * daily "could this ever happen here" question; category = ticket category.
     */
    public const CATALOG = [
        'forklift_ppe' => [
            'label'    => 'Forklift PPE',
            'icon'     => 'forklift',
            'desc'     => 'Flags a person operating a forklift without the required PPE (helmet + vest unless the forklift zone says otherwise).',
            'gate'     => 'Is a forklift visible AND is a person on it or right next to it?',
            'fit'      => 'Could a forklift plausibly operate in this scene (warehouse floor, loading bay, aisle, yard)? An office, corridor or meeting room does not fit.',
            'category' => 'ppe_forklift',
        ],
        'ppe_zone' => [
            'label'    => 'Area PPE',
            'icon'     => 'vest',
            'desc'     => 'Flags a person in this area missing the PPE the area rules require (vest by default).',
            'gate'     => 'Is at least one person visible in the scene?',
            'fit'      => 'Is this a work area where people could be required to wear PPE (production floor, warehouse, plant area)? A purely office scene does not fit.',
            'category' => 'ppe_zone',
        ],
    ];

    /** Area-rule review verdict (forklift_ppe reuses PpeForkliftPipeline::SCHEMA). */
    public const ZONE_SCHEMA = [
        'type' => 'object',
        'properties' => [
            'person_present' => ['type' => 'boolean'],
            'missing_ppe'    => ['type' => 'array', 'items' => ['type' => 'string']],
            'violation'      => ['type' => 'boolean'],
            'confidence'     => ['type' => 'number'],
            'reason'         => ['type' => 'string'],
        ],
        'required' => ['person_present', 'missing_ppe', 'violation', 'confidence', 'reason'],
        'additionalProperties' => false,
    ];

    // ── settings ─────────────────────────────────────────────

    /** Env defaults (MONITOR_*) overlaid by app_settings monitor_settings / cam_monitors. */
    public static function configFrom(array $app): array
    {
        $env = static fn (string $k, string $d): string => class_exists('Env') ? (string) (Env::get($k, $d) ?? $d) : (string) (getenv($k) ?: $d);
        $base = [
            'enabled'            => !in_array(strtolower($env('MONITOR_ENABLED', '1')), ['0', 'false', 'off', 'no'], true),
            'interval_sec'       => (int) $env('MONITOR_INTERVAL_SEC', '60'),
            'max_frames_per_run' => (int) $env('MONITOR_MAX_FRAMES_PER_RUN', '4'),
            'rate_sec'           => (int) $env('MONITOR_RATE_SEC', '60'),
            'gap_sec'            => (int) $env('MONITOR_GAP_SEC', '600'),
            'min_confidence'     => (float) $env('MONITOR_MIN_CONFIDENCE', '0.6'),
            'fitness_enabled'    => !in_array(strtolower($env('MONITOR_FITNESS_ENABLED', '1')), ['0', 'false', 'off', 'no'], true),
        ];
        $s = self::normalizeSettings(is_array($app['monitor_settings'] ?? null) ? $app['monitor_settings'] : [], self::normalizeSettings($base, null));
        $cams = [];
        foreach ((is_array($app['cam_monitors'] ?? null) ? $app['cam_monitors'] : []) as $k => $c) {
            $k = LiveBridge::label((string) $k);
            if ($k !== '' && is_array($c)) {
                $cams[$k] = self::normalizeCamera($c, null);
            }
        }
        return $s + ['cameras' => $cams];
    }

    /** Validate a (partial) settings patch over $base; $base null = full defaults. */
    public static function normalizeSettings(array $in, ?array $base): array
    {
        $b = $base ?? ['enabled' => true, 'interval_sec' => 60, 'max_frames_per_run' => 4, 'rate_sec' => 60,
                       'gap_sec' => 600, 'min_confidence' => 0.6, 'fitness_enabled' => true];
        $bool = static fn ($v): bool => is_bool($v) ? $v : in_array(strtolower((string) $v), ['1', 'true', 'on', 'yes'], true);
        $out = $b;
        if (array_key_exists('enabled', $in)) {
            $out['enabled'] = $bool($in['enabled']);
        }
        if (array_key_exists('fitness_enabled', $in)) {
            $out['fitness_enabled'] = $bool($in['fitness_enabled']);
        }
        if (array_key_exists('interval_sec', $in)) {
            $out['interval_sec'] = (int) $in['interval_sec'];
        }
        if (array_key_exists('max_frames_per_run', $in)) {
            $out['max_frames_per_run'] = (int) $in['max_frames_per_run'];
        }
        if (array_key_exists('rate_sec', $in)) {
            $out['rate_sec'] = (int) $in['rate_sec'];
        }
        if (array_key_exists('gap_sec', $in)) {
            $out['gap_sec'] = (int) $in['gap_sec'];
        }
        if (array_key_exists('min_confidence', $in) && is_numeric($in['min_confidence'])) {
            $out['min_confidence'] = (float) $in['min_confidence'];
        }
        $out['interval_sec']       = in_array((int) $out['interval_sec'], self::INTERVALS, true) ? (int) $out['interval_sec'] : 60;
        $out['max_frames_per_run'] = max(1, min(20, (int) $out['max_frames_per_run']));
        $out['rate_sec']           = max(30, min(3600, (int) $out['rate_sec']));
        $out['gap_sec']            = max(60, min(86400, (int) $out['gap_sec']));
        $out['min_confidence']     = round(max(0.0, min(1.0, (float) $out['min_confidence'])), 2);
        $out['enabled']            = (bool) $out['enabled'];
        $out['fitness_enabled']    = (bool) $out['fitness_enabled'];
        return $out;
    }

    /** Validate a per-camera config patch over $cur (null = defaults). */
    public static function normalizeCamera(array $in, ?array $cur): array
    {
        $c = $cur ?? ['enabled' => false, 'fields' => [], 'interval_sec' => null,
                      'action' => ['ticket' => true, 'priority' => 'high', 'notify_level' => 0], 'force_fit' => false];
        $bool = static fn ($v): bool => is_bool($v) ? $v : in_array(strtolower((string) $v), ['1', 'true', 'on', 'yes'], true);
        if (array_key_exists('enabled', $in)) {
            $c['enabled'] = $bool($in['enabled']);
        }
        if (array_key_exists('fields', $in)) {
            $c['fields'] = array_values(array_unique(array_filter(array_map('strval', (array) $in['fields']),
                static fn ($f) => isset(self::CATALOG[$f]))));
        }
        if (array_key_exists('interval_sec', $in)) {
            $iv = $in['interval_sec'];
            $c['interval_sec'] = ($iv === null || $iv === '' || !in_array((int) $iv, self::INTERVALS, true)) ? null : (int) $iv;
        }
        if (array_key_exists('force_fit', $in)) {
            $c['force_fit'] = $bool($in['force_fit']);
        }
        $a = is_array($in['action'] ?? null) ? $in['action'] : [];
        $ca = is_array($c['action'] ?? null) ? $c['action'] : [];
        if (array_key_exists('ticket', $a)) {
            $ca['ticket'] = $bool($a['ticket']);
        }
        if (array_key_exists('priority', $a)) {
            $ca['priority'] = (string) $a['priority'];
        }
        if (array_key_exists('notify_level', $a)) {
            $ca['notify_level'] = (int) $a['notify_level'];
        }
        $c['action'] = [
            'ticket'       => (bool) ($ca['ticket'] ?? true),
            'priority'     => in_array($ca['priority'] ?? '', self::PRIORITIES, true) ? (string) $ca['priority'] : 'high',
            'notify_level' => max(0, min(3, (int) ($ca['notify_level'] ?? 0))),
        ];
        $c['enabled']   = (bool) $c['enabled'];
        $c['force_fit'] = (bool) $c['force_fit'];
        $c['fields']    = array_values((array) $c['fields']);
        return $c;
    }

    public static function settings(array $config): array
    {
        $m = (array) ($config['monitor'] ?? []);
        unset($m['cameras']);
        return self::normalizeSettings($m, null);
    }

    /** Per-camera config, or the defaults when the camera has none. */
    public static function cameraConfig(array $config, string $stream): array
    {
        $c = $config['monitor']['cameras'][$stream] ?? null;
        return is_array($c) ? self::normalizeCamera($c, null) : self::normalizeCamera([], null);
    }

    /** Effective scan interval of one camera. */
    public static function intervalOf(array $settings, array $cam): int
    {
        return (int) ($cam['interval_sec'] ?? 0) > 0 ? (int) $cam['interval_sec'] : (int) $settings['interval_sec'];
    }

    public static function fieldsHash(array $fields): string
    {
        $f = array_values(array_map('strval', $fields));
        sort($f);
        return substr(sha1(implode(',', $f)), 0, 12);
    }

    public static function appSettingsFile(): string
    {
        return dirname(__DIR__) . '/storage/app_settings.json';
    }

    /** Save global scan settings; returns the new normalized settings. */
    public static function saveSettings(array $in, array &$config): array
    {
        $new = self::normalizeSettings($in, self::settings($config));
        self::patchApp(static function (array $app) use ($new): array {
            $app['monitor_settings'] = $new;
            return $app;
        });
        $config['monitor'] = $new + ['cameras' => $config['monitor']['cameras'] ?? []];
        return $new;
    }

    /**
     * Save one camera's config. Clearing `enabled` keeps the rest; a changed
     * field set drops that camera's fitness so the next cycle re-checks it.
     */
    public static function saveCamera(string $stream, array $in, array &$config): array
    {
        $stream = LiveBridge::label($stream);
        if ($stream === '') {
            throw new InvalidArgumentException('Unknown camera.');
        }
        $cur = isset($config['monitor']['cameras'][$stream]) ? self::normalizeCamera($config['monitor']['cameras'][$stream], null) : null;
        $new = self::normalizeCamera($in, $cur);
        self::patchApp(static function (array $app) use ($stream, $new): array {
            $m = is_array($app['cam_monitors'] ?? null) ? $app['cam_monitors'] : [];
            $m[$stream] = $new;
            $app['cam_monitors'] = $m;
            return $app;
        });
        $config['monitor']['cameras'][$stream] = $new;
        if (self::fieldsHash($cur['fields'] ?? []) !== self::fieldsHash($new['fields'])) {
            self::updateState(self::storageDir($config), static function (array $s) use ($stream): array {
                if (isset($s['cameras'][$stream]['fitness'])) {
                    $s['cameras'][$stream]['fitness']['stale'] = true;
                }
                return $s;
            });
        }
        return $new;
    }

    /** Read-modify-write app_settings.json under an exclusive lock (other keys untouched). */
    private static function patchApp(callable $fn): void
    {
        $file = self::appSettingsFile();
        $fp = @fopen($file, 'c+');
        if (!$fp) {
            throw new RuntimeException('Settings file is not writable.');
        }
        try {
            flock($fp, LOCK_EX);
            $raw = stream_get_contents($fp);
            $app = json_decode((string) $raw, true);
            $app = $fn(is_array($app) ? $app : []);
            ftruncate($fp, 0);
            rewind($fp);
            fwrite($fp, (string) json_encode($app, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
            fflush($fp);
        } finally {
            flock($fp, LOCK_UN);
            fclose($fp);
        }
    }

    // ── state file ───────────────────────────────────────────

    public static function storageDir(array $config): string
    {
        return rtrim((string) ($config['ai']['storage_dir'] ?? (dirname(__DIR__) . '/storage')), '/');
    }

    public static function readState(string $dir): array
    {
        $f = $dir . '/monitor_state.json';
        if (!is_file($f)) {
            return ['cameras' => []];
        }
        $j = json_decode((string) @file_get_contents($f), true);
        return is_array($j) ? $j + ['cameras' => []] : ['cameras' => []];
    }

    /** Atomic patch of monitor_state.json: $fn(array $state): array runs under LOCK_EX. */
    public static function updateState(string $dir, callable $fn): array
    {
        $f = $dir . '/monitor_state.json';
        $fp = @fopen($f, 'c+');
        if (!$fp) {
            return ['cameras' => []];
        }
        try {
            flock($fp, LOCK_EX);
            $s = json_decode((string) stream_get_contents($fp), true);
            $s = $fn(is_array($s) ? $s + ['cameras' => []] : ['cameras' => []]);
            ftruncate($fp, 0);
            rewind($fp);
            fwrite($fp, (string) json_encode($s, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
            fflush($fp);
            return $s;
        } finally {
            flock($fp, LOCK_UN);
            fclose($fp);
        }
    }

    // ── cameras ──────────────────────────────────────────────

    /**
     * Every camera the dashboard knows (same merged map as /live/still), with
     * the private source kept server-side under 'src'. No network.
     *
     * @return array<string, array{stream:string,name:string,location:string,online:?bool,frame_source:?string,src:string}>
     */
    public static function sources(array $config): array
    {
        $out = [];
        $bridge = (string) ($config['live']['stream_base'] ?? '') !== '' || (string) ($config['live']['api_base'] ?? '') !== '';
        foreach (LiveBridge::desired($config, LiveBridge::fleetRows($config, false)) as $name => $d) {
            $name = (string) $name;
            $src  = (string) $d['src'];
            $fs   = null;
            if (empty($d['direct'])) {
                if (LiveBridge::stillUrl($src) !== null) {
                    $fs = 'still';
                } elseif ($bridge) {
                    $fs = 'bridge';
                }
            }
            $out[$name] = [
                'stream'       => $name,
                'name'         => (string) ($d['fleetName'] ?? '') !== '' ? (string) $d['fleetName'] : strtoupper($name),
                'location'     => self::locationOf($config, $name, (string) ($d['fleetName'] ?? '')),
                'online'       => $d['online'] ?? null,
                'frame_source' => $fs,
                'src'          => $src,
            ];
        }
        return $out;
    }

    public static function locationOf(array $config, string $label, string $fallback = ''): string
    {
        $loc = (string) ($config['poc']['cam_locations'][$label] ?? ($config['forklift']['zones'][$label]['name'] ?? ''));
        return mb_substr($loc !== '' ? $loc : ($fallback !== '' ? $fallback : strtoupper($label)), 0, 120);
    }

    /** Fields that may run on a camera now (fitness gate applied), plus why others are paused. */
    public static function activeFields(array $settings, array $cam, array $camState): array
    {
        $fit = is_array($camState['fitness']['fields'] ?? null) ? $camState['fitness']['fields'] : [];
        $on = $paused = [];
        foreach ((array) $cam['fields'] as $f) {
            if (!isset(self::CATALOG[$f])) {
                continue;
            }
            $v = $fit[$f] ?? null;
            if ($settings['fitness_enabled'] && empty($cam['force_fit']) && empty($camState['fitness']['stale'])
                && is_array($v) && ($v['fit'] ?? null) === false) {
                $paused[$f] = (string) ($v['reason'] ?? 'Scene does not fit this monitor');
            } else {
                $on[] = $f;
            }
        }
        return [$on, $paused];
    }

    // ── API view ─────────────────────────────────────────────

    public static function catalogView(): array
    {
        $out = [];
        foreach (self::CATALOG as $k => $c) {
            $out[] = ['key' => $k, 'label' => $c['label'], 'icon' => $c['icon'], 'desc' => $c['desc']];
        }
        return $out;
    }

    /** GET /api/monitors payload. */
    public static function view(PDO $pdo, array $config): array
    {
        $settings = self::settings($config);
        $state    = self::readState(self::storageDir($config));
        $today    = date('Y-m-d');
        $cams     = [];
        foreach (self::sources($config) as $name => $s) {
            $cfg = self::cameraConfig($config, $name);
            $cs  = is_array($state['cameras'][$name] ?? null) ? $state['cameras'][$name] : [];
            [$on, $paused] = self::activeFields($settings, $cfg, $cs);
            $cams[] = [
                'stream'       => $name,
                'name'         => $s['name'],
                'location'     => $s['location'],
                'online'       => $s['online'],
                'frame_source' => $s['frame_source'],
                'configured'   => isset($config['monitor']['cameras'][$name]),
                'config'       => $cfg,
                'state'        => self::camStateView($cs, $cfg, $today) + ['active_fields' => $on, 'paused_fields' => (object) $paused],
            ];
        }
        $levels = [];
        foreach (array_values((array) ($config['escalation']['levels'] ?? [])) as $i => $l) {
            $levels[] = ['level' => $i + 1, 'name' => (string) ($l['name'] ?? ('Level ' . ($i + 1))),
                         'recipients' => count((array) ($l['emails'] ?? [])), 'enabled' => !empty($l['enabled'])];
        }
        require_once __DIR__ . '/Claude.php';
        return [
            'settings'      => $settings,
            'cameras'       => $cams,
            'catalog'       => self::catalogView(),
            'stats_today'   => self::statsToday($pdo),
            'cron'          => [
                'last_run'         => $state['last_run'] ?? null,
                'last_fitness_run' => $state['last_fitness_run'] ?? null,
                'suggested_line'   => self::cronLine($config),
            ],
            'notify_levels' => $levels,
            'ready'         => Claude::fromConfig($config)->ready() && ($config['ai']['source'] ?? 'claude') !== 'off',
            'intervals'     => self::INTERVALS,
            'priorities'    => self::PRIORITIES,
        ];
    }

    private static function camStateView(array $cs, array $cfg, string $today): array
    {
        $fit = is_array($cs['fitness'] ?? null) ? $cs['fitness'] : null;
        if ($fit !== null) {
            $fields = [];
            foreach ((array) ($fit['fields'] ?? []) as $k => $v) {
                $f = isset($v['fit']) ? (bool) $v['fit'] : null;
                // `fits` mirrors `fit` (the model's own key) so either reads the same verdict.
                $fields[$k] = ['fit' => $f, 'fits' => $f, 'reason' => (string) ($v['reason'] ?? '')];
            }
            $fit = [
                'checked_at' => $fit['checked_at'] ?? null,
                'scene'      => (string) ($fit['scene'] ?? ''),
                'fields'     => (object) $fields,
                'stale'      => !empty($fit['stale']) || ($fit['hash'] ?? '') !== self::fieldsHash($cfg['fields']),
            ];
        }
        $reviews = is_array($cs['reviews'] ?? null) ? $cs['reviews'] : [];
        $lastRev = $reviews ? max(array_map('strval', $reviews)) : null;
        return [
            'last_scan_at'    => $cs['last_scan_at'] ?? null,
            'last_gate'       => $cs['last_gate'] ?? null,
            'gate_hits_today' => ($cs['gate_hits_date'] ?? '') === $today ? (int) ($cs['gate_hits_today'] ?? 0) : 0,
            'last_review_at'  => $lastRev,
            'last_violation_at' => $cs['last_violation_at'] ?? null,
            'fitness'         => $fit,
            'errors'          => (int) ($cs['errors'] ?? 0),
            'last_error'      => $cs['last_error'] ?? null,
            'skip_reason'     => $cs['skip_reason'] ?? null,
        ];
    }

    /** Today's monitor spend from ai_reviews. */
    public static function statsToday(PDO $pdo): array
    {
        require_once __DIR__ . '/Claude.php';
        $z = ['gates' => 0, 'gate_hits' => 0, 'reviews' => 0, 'violations' => 0, 'fitness_checks' => 0, 'errors' => 0,
              'tokens_in' => 0, 'tokens_out' => 0];
        $out = $z + ['by_camera' => [], 'models' => ['fast_model' => Claude::modelFor('monitor_gate'),
                                                     'advanced_model' => Claude::modelFor('vision_review')]];
        try {
            $st = $pdo->prepare("SELECT camera, kind, COUNT(*) AS n, SUM(CASE WHEN violation = 1 THEN 1 ELSE 0 END) AS v,
                                        SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS e,
                                        COALESCE(SUM(tokens_in),0) AS ti, COALESCE(SUM(tokens_out),0) AS tout
                                 FROM ai_reviews WHERE created_at >= :f AND kind IN ('monitor_gate','monitor_review','monitor_fitness')
                                 GROUP BY camera, kind");
            $st->execute(['f' => date('Y-m-d 00:00:00')]);
            $rows = $st->fetchAll(PDO::FETCH_ASSOC);
        } catch (Throwable $e) {
            return $out;
        }
        foreach ($rows as $r) {
            $cam = (string) ($r['camera'] ?? '');
            $out['by_camera'][$cam] ??= $z;
            $add = static function (array &$t) use ($r): void {
                $n = (int) $r['n'];
                $v = (int) $r['v'];
                if ($r['kind'] === 'monitor_gate') {
                    $t['gates'] += $n;
                    $t['gate_hits'] += $v;
                } elseif ($r['kind'] === 'monitor_review') {
                    $t['reviews'] += $n;
                    $t['violations'] += $v;
                } else {
                    $t['fitness_checks'] += $n;
                }
                $t['errors']     += (int) $r['e'];
                $t['tokens_in']  += (int) $r['ti'];
                $t['tokens_out'] += (int) $r['tout'];
            };
            $add($out);
            $add($out['by_camera'][$cam]);
        }
        $out['by_camera'] = (object) $out['by_camera'];
        return $out;
    }

    /** cPanel cron line; the token stays a placeholder (never echo the real one). */
    public static function cronLine(array $config): string
    {
        $url = rtrim((string) ($config['app']['url'] ?? ''), '/');
        if ($url === '') {
            $url = 'https://' . ((string) ($_SERVER['HTTP_HOST'] ?? 'YOUR-HOST'));
        }
        return '* * * * * curl -s "' . $url . '/api/monitors/cron?token=PROVISION_TOKEN" >/dev/null 2>&1';
    }
}
