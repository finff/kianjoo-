<?php
/**
 * go2rtc live-video bridge client.
 *
 * Browsers cannot play RTSP, so a go2rtc bridge converts each camera's RTSP
 * source into fragmented MP4 the dashboard's <video> tiles load from
 * {stream_base}/api/stream.mp4?src={stream}. This class keeps the bridge's
 * stream list in step with the dashboard: the SenseStudio fleet's RTSP URLs
 * (stream label = normalised device serial) plus manual RTSP_STREAMS /
 * Settings › Live Video entries are registered on the bridge via its REST API
 * (PUT /api/streams, persisted by go2rtc into go2rtc.yaml).
 *
 * The last network check / sync is remembered in storage/live_bridge.json so
 * the feed can report bridge readiness without touching the network.
 */

declare(strict_types=1);

final class LiveBridge
{
    /** go2rtc source schemes the dashboard accepts. */
    private const SCHEMES = ['rtsp', 'rtsps', 'rtmp', 'rtmps', 'http', 'https', 'onvif', 'ffmpeg',
                             'isapi', 'dvrip', 'tapo', 'kasa', 'webrtc'];

    /** Schemes whose source is "scheme:<anything>" rather than "scheme://host…". */
    private const OPAQUE = ['ffmpeg', 'webrtc'];

    /** Minimum seconds between automatic syncs. */
    private const AUTO_EVERY = 300;

    private array $live;
    /** @var callable */
    private $transport;
    /** Upper bound applied to every call's timeout (autoSync keeps it at 2 s). */
    private ?int $cap = null;
    /** Unmasked desired sources from the last status() (used by sync()). */
    private array $lastDesired = [];

    public function __construct(array $live, ?callable $transport = null)
    {
        $this->live      = $live;
        $this->transport = $transport ?? [self::class, 'curlTransport'];
    }

    public function configured(): bool
    {
        return (string) ($this->live['stream_base'] ?? '') !== '';
    }

    public function apiBase(): string
    {
        $api = rtrim((string) ($this->live['api_base'] ?? ''), '/');
        return $api !== '' ? $api : rtrim((string) ($this->live['stream_base'] ?? ''), '/');
    }

    public function capTimeout(?int $seconds): void
    {
        $this->cap = $seconds;
    }

    // ── Bridge REST calls ────────────────────────────────────

    /** GET {api}/api → go2rtc build info. */
    public function info(int $timeout = 3): array
    {
        $r = $this->call('GET', '/api', [], $timeout);
        $j = json_decode($r['body'], true);
        $ok = $r['status'] >= 200 && $r['status'] < 300 && is_array($j);
        return [
            'ok'      => $ok,
            'version' => $ok ? (string) ($j['version'] ?? '') : '',
            'ms'      => $r['ms'],
            'error'   => $ok ? '' : self::httpError($r),
        ];
    }

    /** GET {api}/api/streams → [name => [sources, producers, consumers]]. */
    public function streams(int $timeout = 3): array
    {
        $r = $this->call('GET', '/api/streams', [], $timeout);
        $j = json_decode($r['body'], true);
        if ($r['status'] < 200 || $r['status'] >= 300 || !(is_array($j) || trim($r['body']) === 'null')) {
            return ['ok' => false, 'streams' => [], 'error' => self::httpError($r)];
        }
        $out = [];
        foreach (is_array($j) ? $j : [] as $name => $s) {
            $prod = is_array($s['producers'] ?? null) ? $s['producers'] : [];
            $cons = is_array($s['consumers'] ?? null) ? $s['consumers'] : [];
            $src  = [];
            foreach ($prod as $p) {
                $u = is_array($p) ? (string) ($p['url'] ?? $p['source'] ?? '') : '';
                if ($u !== '') {
                    $src[] = $u;
                }
            }
            $out[(string) $name] = ['sources' => $src, 'producers' => count($prod), 'consumers' => count($cons)];
        }
        return ['ok' => true, 'streams' => $out, 'error' => ''];
    }

    /** PUT {api}/api/streams?name=&src= — create / replace a stream (persisted in go2rtc.yaml). */
    public function register(string $name, string $src, int $timeout = 5): array
    {
        $r  = $this->call('PUT', '/api/streams', ['name' => $name, 'src' => $src], $timeout);
        $ok = $r['status'] >= 200 && $r['status'] < 300;
        return ['ok' => $ok, 'error' => $ok ? '' : self::httpError($r)];
    }

    /** DELETE {api}/api/streams?src=name. */
    public function remove(string $name, int $timeout = 5): array
    {
        $r  = $this->call('DELETE', '/api/streams', ['src' => $name], $timeout);
        $ok = ($r['status'] >= 200 && $r['status'] < 300) || $r['status'] === 404;
        return ['ok' => $ok, 'error' => $ok ? '' : self::httpError($r)];
    }

    /** GET {api}/api/frame.jpeg?src=name — proves the source actually produces video. */
    public function probe(string $name, int $timeout = 10): array
    {
        $r  = $this->call('GET', '/api/frame.jpeg', ['src' => $name], $timeout);
        $ok = $r['status'] === 200 && strncmp($r['body'], "\xFF\xD8", 2) === 0;
        return [
            'ok'    => $ok,
            'ms'    => $r['ms'],
            'bytes' => $ok ? strlen($r['body']) : 0,
            'error' => $ok ? '' : ($r['status'] === 200 ? 'Bridge returned no JPEG frame' : self::httpError($r)),
            'image' => $ok ? $r['body'] : null,
        ];
    }

    // ── Helpers ──────────────────────────────────────────────

    /** An HTTP(S) HLS playlist (.m3u8) — played straight in the browser, never put on the bridge. */
    public static function isDirect(string $url): bool
    {
        return (bool) preg_match('~^https?://[^\s]+\.m3u8(?:[?#]|$)~i', trim($url));
    }

    /** Manual direct-play (HLS) sources as [label => url] for the feed. */
    public static function directSources(array $config): array
    {
        $out = [];
        foreach (($config['live']['rtsp'] ?? []) as $name => $src) {
            $src = trim((string) (is_scalar($src) ? $src : ''));
            if ((string) $name !== '' && self::isDirect($src) && self::validSource($src)) {
                $out[(string) $name] = $src;
            }
        }
        return $out;
    }

    public static function label(string $s): string
    {
        return strtolower((string) preg_replace('/[^a-z0-9]+/i', '', $s));
    }

    /** Hide RTSP credentials (and token/password query params) before a URL leaves the server. */
    public static function mask(string $url): string
    {
        $url = (string) preg_replace('~//([^:/@]+):[^@]*@~', '//$1:••••@', $url);
        return (string) preg_replace('~([?&#](?:password|pass|pwd|token)=)[^&#]*~i', '$1••••', $url);
    }

    public static function validSource(string $url): bool
    {
        if ($url === '' || strlen($url) > 512 || preg_match('/[\s\x00-\x1F\x7F]/', $url)) {
            return false;
        }
        if (!preg_match('~^([a-z0-9]+):(.*)$~i', $url, $m)) {
            return false;
        }
        $scheme = strtolower($m[1]);
        if (!in_array($scheme, self::SCHEMES, true)) {
            return false;
        }
        if (in_array($scheme, self::OPAQUE, true)) {
            return $m[2] !== '';
        }
        return (bool) preg_match('~^//[^/?#]+~', $m[2]);
    }

    /** Stream label for a device: a manual RTSP_STREAMS key whose URL matches, else the normalised serial. */
    public static function streamFor(string $serial, string $uri, array $rtspMap): string
    {
        foreach ($rtspMap as $label => $url) {
            if ($uri !== '' && (string) $url === $uri) {
                return (string) $label;
            }
        }
        return $serial !== '' ? self::label($serial) : '';
    }

    /** SenseStudio device list → fleet rows (the shape feed.php caches in *.cams.json). */
    public static function mapDevices(array $devices, array $rtspMap): array
    {
        require_once __DIR__ . '/Text.php';
        $rows = [];
        foreach ($devices as $d) {
            if (!is_array($d)) {
                continue;
            }
            $uri    = (string) ($d['deviceUri'] ?? '');
            $serial = (string) ($d['deviceSerial'] ?? '');
            $rows[] = [
                'did'    => (string) ($d['did'] ?? ''),
                // SenseStudio's *CnName / typeName fields are Chinese — English only here.
                'name'   => Text::latin((string) ($d['deviceEnName'] ?? $d['deviceCnName'] ?? $serial), $serial),
                'serial' => $serial,
                'type'   => Text::latin((string) ($d['deviceTypeName'] ?? $d['deviceType'] ?? ''), 'Camera'),
                'online' => (string) ($d['sts'] ?? '1') === '0',
                'rtsp'   => $uri,
                'stream' => self::streamFor($serial, $uri, $rtspMap),
            ];
        }
        return $rows;
    }

    public static function camsCacheFile(array $config): string
    {
        return (string) ($config['storage']['raw_log'] ?? (self::storageDir($config) . '/x')) . '.cams.json';
    }

    /** Fleet rows from the cams cache; on a miss (and when allowed) list SenseStudio devices and write the cache. */
    public static function fleetRows(array $config, bool $network = true): array
    {
        $cache = self::camsCacheFile($config);
        if (is_file($cache)) {
            $c = json_decode((string) file_get_contents($cache), true);
            if (is_array($c)) {
                return array_values(array_filter($c, 'is_array'));
            }
        }
        $sa = $config['sense_api'] ?? [];
        if (!$network || empty($sa['base']) || empty($sa['account']) || empty($sa['password'])) {
            return [];
        }
        try {
            require_once __DIR__ . '/SenseApi.php';
            $sense = new SenseApi($sa, self::storageDir($config));
            $res   = $sense->listDevices(1, 100);
            if (empty($res['ok']) || !is_array($res['data'] ?? null)) {
                return [];
            }
            $rows = self::mapDevices($res['data'], $config['live']['rtsp'] ?? []);
            @file_put_contents($cache, json_encode($rows, JSON_UNESCAPED_SLASHES));
            return $rows;
        } catch (Throwable $e) {
            return [];
        }
    }

    /**
     * Streams the bridge should carry: fleet RTSP sources first, then the
     * manual map (RTSP_STREAMS + Settings) overriding by name.
     * @return array<string, array{src:string, origin:string, online:?bool, fleetName:string}>
     */
    public static function desired(array $config, array $fleet): array
    {
        $out = [];
        foreach ($fleet as $r) {
            if (!is_array($r)) {
                continue;
            }
            $src  = trim((string) ($r['rtsp'] ?? ''));
            $name = (string) ($r['stream'] ?? '');
            if ($name === '') {
                $name = self::label((string) ($r['serial'] ?? ''));
            }
            if ($name === '' || $src === '' || !self::validSource($src) || isset($out[$name])) {
                continue;
            }
            $out[$name] = [
                'src'       => $src,
                'origin'    => 'fleet',
                'direct'    => self::isDirect($src),
                'online'    => isset($r['online']) ? (bool) $r['online'] : null,
                'fleetName' => (string) ($r['name'] ?? ''),
            ];
        }
        foreach (($config['live']['rtsp'] ?? []) as $name => $src) {
            $name = (string) $name;
            $src  = trim((string) (is_scalar($src) ? $src : ''));
            if ($name === '' || $src === '' || !self::validSource($src)) {
                continue;
            }
            $out[$name] = [
                'src'       => $src,
                'origin'    => 'manual',
                'direct'    => self::isDirect($src),
                'online'    => $out[$name]['online'] ?? null,
                'fleetName' => $out[$name]['fleetName'] ?? '',
            ];
        }
        return $out;
    }

    // ── Bridge-free snapshots ("near-live" tiles) ──
    // Without a go2rtc bridge the browser cannot play RTSP, but most IP cameras
    // also serve a JPEG of the current frame over HTTP. The server fetches it
    // with the RTSP credentials (never sent to the browser) and the tiles
    // refresh it about once a second.

    /**
     * HTTP snapshot endpoint for an RTSP camera URL, or null when the vendor
     * path is not recognised. Hikvision: /Streaming/Channels/101 →
     * /ISAPI/Streaming/channels/101/picture. Dahua: /cam/realmonitor?channel=N
     * → /cgi-bin/snapshot.cgi?channel=N.
     *
     * @return array{url:string,user:string,pass:string}|null
     */
    public static function stillUrl(string $src): ?array
    {
        $p = parse_url(trim($src));
        if (!is_array($p) || !in_array(strtolower((string) ($p['scheme'] ?? '')), ['rtsp', 'rtsps'], true) || empty($p['host'])) {
            return null;
        }
        $path  = (string) ($p['path'] ?? '');
        $query = (string) ($p['query'] ?? '');
        if (preg_match('~/Streaming/Channels/(\d+)~i', $path, $m)) {
            $tail = '/ISAPI/Streaming/channels/' . $m[1] . '/picture';
        } elseif (stripos($path, '/cam/realmonitor') === 0) {
            parse_str($query, $q);
            $tail = '/cgi-bin/snapshot.cgi?channel=' . max(1, (int) ($q['channel'] ?? 1));
        } else {
            return null;
        }
        $host = (string) $p['host'];
        if (strpos($host, ':') !== false && $host[0] !== '[') {
            $host = '[' . $host . ']';
        }
        return [
            'url'  => 'http://' . $host . $tail,
            'user' => rawurldecode((string) ($p['user'] ?? '')),
            'pass' => rawurldecode((string) ($p['pass'] ?? '')),
        ];
    }

    /** Stream labels whose source supports an HTTP snapshot (direct HLS excluded). */
    public static function stillSources(array $config, array $fleet = []): array
    {
        $out = [];
        foreach (self::desired($config, $fleet) as $name => $d) {
            if (empty($d['direct']) && self::stillUrl((string) $d['src']) !== null) {
                $out[] = (string) $name;
            }
        }
        return $out;
    }

    /** Fetch one JPEG from the camera (digest or basic auth); null on any failure. */
    public static function fetchStill(string $src, int $timeout = 5): ?string
    {
        $s = self::stillUrl($src);
        if ($s === null || !function_exists('curl_init')) {
            return null;
        }
        $ch = curl_init($s['url']);
        $opt = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => min(3, $timeout),
            CURLOPT_TIMEOUT        => $timeout,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_HTTPHEADER     => ['Accept: image/jpeg'],
        ];
        if ($s['user'] !== '') {
            $opt[CURLOPT_HTTPAUTH] = CURLAUTH_DIGEST | CURLAUTH_BASIC;
            $opt[CURLOPT_USERPWD]  = $s['user'] . ':' . $s['pass'];
        }
        curl_setopt_array($ch, $opt);
        $body = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $type = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        curl_close($ch);
        if (!is_string($body) || $code !== 200 || strlen($body) < 100) {
            return null;
        }
        // JPEG magic bytes, whatever the camera claims in Content-Type.
        if (substr($body, 0, 2) !== "\xFF\xD8" && stripos($type, 'image/') !== 0) {
            return null;
        }
        return $body;
    }

    // ── Manual source map (RTSP_STREAMS env + app_settings live_rtsp) ──

    /** RTSP_STREAMS from .env as [label => url] (string keys, non-empty values). */
    public static function envSources(?string $json = null): array
    {
        if ($json === null) {
            $json = class_exists('Env') ? (string) (Env::get('RTSP_STREAMS', '{}') ?? '{}') : '{}';
        }
        $map = json_decode($json ?: '{}', true);
        $out = [];
        foreach (is_array($map) ? $map : [] as $k => $v) {
            $k = trim((string) $k);
            $v = is_scalar($v) ? trim((string) $v) : '';
            if ($k !== '' && $v !== '') {
                $out[$k] = $v;
            }
        }
        return $out;
    }

    /**
     * Effective manual map: env entries, then app_settings `live_rtsp` (keys
     * normalised with label()) merged over them. An app value of '' is a
     * tombstone that hides an env entry; empty urls never survive.
     */
    public static function mergeSources(array $env, array $app): array
    {
        $out = [];
        foreach ($env as $k => $v) {
            $k = (string) $k;
            $v = is_scalar($v) ? trim((string) $v) : '';
            if ($k !== '' && $v !== '') {
                $out[$k] = $v;
            }
        }
        foreach ($app as $k => $v) {
            $k = self::label((string) $k);
            if ($k === '') {
                continue;
            }
            $v = is_scalar($v) ? trim((string) $v) : '';
            if ($v === '') {
                unset($out[$k]);
            } else {
                $out[$k] = $v;
            }
        }
        return $out;
    }

    /**
     * Apply one change to the stored `live_rtsp` map. $url '' removes the entry;
     * when the name comes from .env, a '' tombstone is stored so it stays hidden.
     */
    public static function patchSources(array $stored, string $name, string $url, array $env): array
    {
        $name = self::label($name);
        if ($name === '') {
            return $stored;
        }
        if ($url === '') {
            if (array_key_exists($name, $env)) {
                $stored[$name] = '';
            } else {
                unset($stored[$name]);
            }
        } else {
            $stored[$name] = $url;
        }
        return $stored;
    }

    // ── Status / sync ────────────────────────────────────────

    /**
     * Desired streams compared with the bridge. $network=false answers from
     * storage/live_bridge.json only. Never throws.
     */
    public function status(array $config, bool $network = true, ?array $fleet = null): array
    {
        try {
            $fleet   = $fleet ?? self::fleetRows($config, $network);
            $desired = self::desired($config, $fleet);
        } catch (Throwable $e) {
            $desired = [];
        }
        $this->lastDesired = $desired;
        $state  = self::readState($config);
        $bridge = ['reachable' => false, 'version' => '', 'ms' => null, 'error' => '', 'checkedAt' => null];
        $remote = null;   // [name => [sources, producers, consumers]] when known

        if (!$this->configured()) {
            $bridge['error'] = 'Live bridge not configured';
        } elseif ($network) {
            try {
                $info = $this->info();
                $bridge['ms'] = $info['ms'];
                if ($info['ok']) {
                    $bridge['version'] = $info['version'];
                    $st = $this->streams();
                    if ($st['ok']) {
                        $bridge['reachable'] = true;
                        $remote = $st['streams'];
                    } else {
                        $bridge['error'] = $st['error'];
                    }
                } else {
                    $bridge['error'] = $info['error'];
                }
            } catch (Throwable $e) {
                $bridge['error'] = $e->getMessage();
            }
            $bridge['checkedAt'] = date('c');
            self::writeState($config, [
                'checked_at' => $bridge['checkedAt'],
                'reachable'  => $bridge['reachable'],
                'version'    => $bridge['version'],
                'error'      => $bridge['error'],
                'streams'    => $remote !== null ? array_keys($remote) : ($state['streams'] ?? []),
            ]);
        } else {
            $bridge['reachable'] = !empty($state['reachable']);
            $bridge['version']   = (string) ($state['version'] ?? '');
            $bridge['error']     = (string) ($state['error'] ?? '');
            $bridge['checkedAt'] = $state['checked_at'] ?? null;
            if ($bridge['reachable'] && is_array($state['streams'] ?? null)) {
                $remote = [];
                foreach ($state['streams'] as $n) {
                    $remote[(string) $n] = ['sources' => [], 'producers' => null, 'consumers' => null];
                }
            }
        }

        $streams = [];
        $counts  = ['desired' => count($desired), 'registered' => 0, 'missing' => 0, 'mismatch' => 0, 'orphan' => 0, 'unknown' => 0, 'direct' => 0];
        foreach ($desired as $name => $d) {
            $name = (string) $name;
            $r    = $remote[$name] ?? null;
            if (!empty($d['direct'])) {
                $st = 'direct';          // browser plays it directly
            } elseif ($remote === null) {
                $st = 'unknown';
            } elseif ($r === null) {
                $st = 'missing';
            } elseif (!$r['sources'] || self::sameSource($d['src'], $r['sources'])) {
                $st = 'registered';
            } else {
                $st = 'mismatch';
            }
            $counts[$st]++;
            $streams[] = [
                'name'      => $name,
                'source'    => self::mask($d['src']),
                'origin'    => $d['origin'],
                'state'     => $st,
                'online'    => $d['online'],
                'fleetName' => $d['fleetName'],
                'producers' => $r['producers'] ?? null,
                'consumers' => $r['consumers'] ?? null,
            ];
        }
        foreach ($remote ?? [] as $name => $r) {
            $name = (string) $name;
            if (isset($desired[$name])) {
                continue;
            }
            $counts['orphan']++;
            $streams[] = [
                'name'      => $name,
                'source'    => self::mask((string) ($r['sources'][0] ?? '')),
                'origin'    => null,
                'state'     => 'orphan',
                'online'    => null,
                'fleetName' => '',
                'producers' => $r['producers'],
                'consumers' => $r['consumers'],
            ];
        }

        return [
            'ok'         => true,
            'configured' => $this->configured(),
            'base'       => (string) ($this->live['stream_base'] ?? ''),
            'apiBase'    => self::mask($this->apiBase()),
            'autoSync'   => (bool) ($this->live['auto_sync'] ?? true),
            'bridge'     => $bridge,
            'streams'    => $streams,
            'counts'     => $counts,
            'lastSync'   => !empty($state['synced_at'])
                ? ['at' => $state['synced_at'], 'result' => $state['sync_result'] ?? null] : null,
        ];
    }

    /** Register every missing / mismatched desired stream on the bridge. */
    public function sync(array $config, string $actor = 'system', ?array $fleet = null): array
    {
        $res = ['ok' => false, 'registered' => 0, 'updated' => 0, 'unchanged' => 0, 'failed' => 0, 'errors' => []];
        try {
            if (!$this->configured()) {
                $res['errors'][] = ['name' => '', 'error' => 'Live bridge not configured'];
                return $res;
            }
            $st = $this->status($config, true, $fleet);
            if (!$st['bridge']['reachable']) {
                $res['errors'][] = ['name' => '', 'error' => 'Bridge unreachable: ' . $st['bridge']['error']];
            } else {
                foreach ($st['streams'] as $s) {
                    if ($s['state'] === 'registered') {
                        $res['unchanged']++;
                        continue;
                    }
                    if ($s['state'] !== 'missing' && $s['state'] !== 'mismatch') {
                        continue;
                    }
                    $r = $this->register($s['name'], $this->lastDesired[$s['name']]['src']);
                    if ($r['ok']) {
                        $res[$s['state'] === 'missing' ? 'registered' : 'updated']++;
                    } else {
                        $res['failed']++;
                        $res['errors'][] = ['name' => $s['name'], 'error' => $r['error']];
                    }
                }
                $res['ok'] = $res['failed'] === 0;
            }
        } catch (Throwable $e) {
            $res['errors'][] = ['name' => '', 'error' => $e->getMessage()];
        }
        self::writeState($config, [
            'synced_at'   => date('c'),
            'sync_result' => $res + ['actor' => $actor],
        ]);
        return $res;
    }

    /** Best-effort fleet → bridge registration, at most once per 5 min. Never throws. */
    public static function autoSync(array $config, array $fleet, ?callable $transport = null): void
    {
        try {
            $live = $config['live'] ?? [];
            $lb   = new self($live, $transport);
            if (!$lb->configured() || empty($live['auto_sync'] ?? true)) {
                return;
            }
            if (!self::desired($config, $fleet)) {
                return;
            }
            $state = self::readState($config);
            $last  = max((int) strtotime((string) ($state['synced_at'] ?? '')), (int) strtotime((string) ($state['auto_at'] ?? '')));
            if ($last > 0 && time() - $last < self::AUTO_EVERY) {
                return;
            }
            self::writeState($config, ['auto_at' => date('c')]);   // claim the slot before the network
            $lb->capTimeout(2);
            $lb->sync($config, 'auto', $fleet);
        } catch (Throwable $e) {
            // silent by design
        }
    }

    /** Last known bridge summary (no network) for the feed payload. */
    public static function cached(array $config): array
    {
        $s = self::readState($config);
        return [
            'configured' => (string) ($config['live']['stream_base'] ?? '') !== '',
            'reachable'  => isset($s['reachable']) ? (bool) $s['reachable'] : null,
            'version'    => (string) ($s['version'] ?? ''),
            'streams'    => array_values(array_map('strval', is_array($s['streams'] ?? null) ? $s['streams'] : [])),
            'checkedAt'  => $s['checked_at'] ?? null,
            'syncedAt'   => $s['synced_at'] ?? null,
        ];
    }

    // ── State file ───────────────────────────────────────────

    public static function storageDir(array $config): string
    {
        $raw = (string) ($config['storage']['raw_log'] ?? '');
        if ($raw !== '') {
            return dirname($raw);
        }
        return (defined('APP_ROOT') ? APP_ROOT : dirname(__DIR__)) . '/storage';
    }

    public static function stateFile(array $config): string
    {
        return self::storageDir($config) . '/live_bridge.json';
    }

    public static function snapDir(array $config): string
    {
        return self::storageDir($config) . '/live_snap';
    }

    public static function readState(array $config): array
    {
        $f = self::stateFile($config);
        if (!is_file($f)) {
            return [];
        }
        $j = json_decode((string) @file_get_contents($f), true);
        return is_array($j) ? $j : [];
    }

    public static function writeState(array $config, array $kv): void
    {
        $f = self::stateFile($config);
        if (!is_dir(dirname($f))) {
            @mkdir(dirname($f), 0775, true);
        }
        $cur = self::readState($config);
        @file_put_contents($f, json_encode(array_merge($cur, $kv), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX);
    }

    // ── Transport ────────────────────────────────────────────

    private function call(string $method, string $path, array $query, int $timeout): array
    {
        $base = $this->apiBase();
        if ($base === '') {
            return ['status' => 0, 'body' => '', 'ms' => 0, 'error' => 'Live bridge not configured', 'ctype' => ''];
        }
        $token = (string) ($this->live['stream_token'] ?? '');
        if ($token !== '') {
            $query['token'] = $token;
        }
        $url = $base . $path . ($query ? '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986) : '');
        if ($this->cap !== null) {
            $timeout = min($timeout, $this->cap);
        }
        $opts = [
            'timeout' => max(1, $timeout),
            'user'    => (string) ($this->live['api_user'] ?? ''),
            'pass'    => (string) ($this->live['api_pass'] ?? ''),
        ];
        try {
            $r = ($this->transport)($method, $url, $opts);
        } catch (Throwable $e) {
            $r = ['status' => 0, 'error' => $e->getMessage()];
        }
        return [
            'status' => (int) ($r['status'] ?? 0),
            'body'   => (string) ($r['body'] ?? ''),
            'ms'     => (int) ($r['ms'] ?? 0),
            'error'  => (string) ($r['error'] ?? ''),
            'ctype'  => (string) ($r['ctype'] ?? ''),
        ];
    }

    /** Default transport (curl). */
    public static function curlTransport(string $method, string $url, array $opts = []): array
    {
        if (!function_exists('curl_init')) {
            return ['status' => 0, 'body' => '', 'ms' => 0, 'error' => 'PHP curl extension missing', 'ctype' => ''];
        }
        $t0 = microtime(true);
        $timeout = max(1, (int) ($opts['timeout'] ?? 5));
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => min(3, $timeout),
            CURLOPT_TIMEOUT        => $timeout,
            CURLOPT_HTTPHEADER     => ['Accept: application/json, image/jpeg, */*'],
            CURLOPT_USERAGENT      => 'KianJoo-VisionAI-LiveBridge/1.0',
        ]);
        if (in_array($method, ['PUT', 'POST'], true)) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, '');
        }
        if (($opts['user'] ?? '') !== '') {
            curl_setopt($ch, CURLOPT_HTTPAUTH, CURLAUTH_BASIC);
            curl_setopt($ch, CURLOPT_USERPWD, $opts['user'] . ':' . ($opts['pass'] ?? ''));
        }
        $body   = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $ctype  = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        $err    = $body === false ? curl_error($ch) : '';
        return [
            'status' => $status,
            'body'   => is_string($body) ? $body : '',
            'ms'     => (int) round((microtime(true) - $t0) * 1000),
            'error'  => $err,
            'ctype'  => $ctype,
        ];
    }

    private static function httpError(array $r): string
    {
        if ($r['status'] === 0) {
            return $r['error'] !== '' ? $r['error'] : 'Bridge unreachable';
        }
        $msg = trim(substr(strip_tags($r['body']), 0, 160));
        return 'HTTP ' . $r['status'] . ($msg !== '' ? ': ' . $msg : '');
    }

    /** Same source, ignoring a trailing #fragment (go2rtc options) difference. */
    private static function sameSource(string $want, array $have): bool
    {
        $strip = static fn (string $u): string => explode('#', trim($u), 2)[0];
        foreach ($have as $h) {
            if ($h === $want || $strip((string) $h) === $strip($want)) {
                return true;
            }
        }
        return false;
    }
}
