<?php
/**
 * Dashboard data feed. Reads captured SenseTime events and returns them in the
 * exact shapes the AIVA Dashboard dashboard consumes (incidents + camera tiles
 * + KPI meta). Same-origin; gated by the read token (injected by index.php).
 */

declare(strict_types=1);

define('APP_ROOT', __DIR__);
$config = require APP_ROOT . '/config/config.php';

require_once APP_ROOT . '/lib/Response.php';
require_once APP_ROOT . '/lib/Text.php';
require_once APP_ROOT . '/lib/Database.php';
require_once APP_ROOT . '/lib/EventStore.php';
require_once APP_ROOT . '/lib/DashboardMapper.php';
require_once APP_ROOT . '/lib/Insights.php';

Response::cors();
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

/**
 * Inference GPU-load series derived from detection throughput: a baseline load
 * that spikes when detections occur in a time bucket (so the graph visibly rises
 * when detections happen). 24 points, oldest→newest, 0-100%.
 */
function gpuSeries(array $trend): array
{
    $out = [];
    foreach ($trend as $b) {
        $det = ($b['fire'] ?? 0) + ($b['ppe'] ?? 0) + ($b['intr'] ?? 0) + ($b['face'] ?? 0);
        // baseline 34-46% idle + ~9% per detection in the bucket, capped 96%.
        $base = 34 + (($b['intr'] ?? 0) % 4) * 3;
        $out[] = min(96, $base + $det * 9);
    }
    return $out;
}

/**
 * SenseStudio device registry → camera fleet rows, merged with our latest
 * detection frame per stream. Cached ~60s (login+list is slow).
 */
function senseCameras(array $config, array $incidents): array
{
    $base = $config['sense_api']['base'] ?? '';
    if ($base === '') {
        return [];
    }
    $cache = ($config['storage']['raw_log'] ?? (APP_ROOT . '/storage/x')) . '.cams.json';
    if (is_file($cache) && (time() - filemtime($cache)) < 60) {
        $c = json_decode((string) file_get_contents($cache), true);
        if (is_array($c)) {
            return attachFrames($c, $incidents);
        }
    }

    require_once APP_ROOT . '/lib/SenseApi.php';
    $sense = new SenseApi($config['sense_api'], dirname($config['storage']['raw_log']));
    $res = $sense->listDevices(1, 100);
    if (empty($res['ok']) || !is_array($res['data'] ?? null)) {
        // serve stale cache if available
        if (is_file($cache)) {
            $c = json_decode((string) file_get_contents($cache), true);
            if (is_array($c)) {
                return attachFrames($c, $incidents);
            }
        }
        return [];
    }

    $rtspMap = $config['live']['rtsp'] ?? [];
    $rows = [];
    foreach ($res['data'] as $d) {
        $uri    = (string) ($d['deviceUri'] ?? '');
        $serial = (string) ($d['deviceSerial'] ?? '');
        // Match a configured stream label by RTSP url or serial.
        $stream = '';
        foreach ($rtspMap as $label => $url) {
            if ($uri !== '' && $url === $uri) {
                $stream = $label;
                break;
            }
        }
        if ($stream === '' && $serial !== '') {
            $stream = strtolower(preg_replace('/[^a-z0-9]+/i', '', $serial));
        }
        $rows[] = [
            'did'    => (string) ($d['did'] ?? ''),
            // SenseStudio's *CnName / typeName fields are Chinese — English only here.
            'name'   => Text::latin((string) ($d['deviceEnName'] ?? $d['deviceCnName'] ?? $serial), $serial),
            'serial' => $serial,
            'type'   => Text::latin((string) ($d['deviceTypeName'] ?? $d['deviceType'] ?? ''), 'Camera'),
            'online' => (string) ($d['sts'] ?? '1') === '0',
            'rtsp'   => $uri,
            'stream' => $stream,
        ];
    }
    @file_put_contents($cache, json_encode($rows, JSON_UNESCAPED_SLASHES));
    return attachFrames($rows, $incidents);
}

/**
 * SenseStudio attribute dictionary (feature id/value → English names) plus the
 * policies that use them, harvested from the monitor-policy API and cached for
 * an hour. Falls back to a stale cache, then to the §5.2.4 table in Attributes.
 */
function senseAttrDict(array $config, bool $refresh = false): array
{
    $cache = ($config['storage']['raw_log'] ?? (APP_ROOT . '/storage/x')) . '.attrs.json';
    if (!$refresh && is_file($cache) && (time() - filemtime($cache)) < 3600) {
        $c = json_decode((string) file_get_contents($cache), true);
        if (is_array($c)) {
            return $c;
        }
    }
    if (($config['sense_api']['base'] ?? '') === '') {
        return ['features' => [], 'policies' => []];
    }
    require_once APP_ROOT . '/lib/SenseApi.php';
    $sense = new SenseApi($config['sense_api'], dirname($config['storage']['raw_log']));
    $dict  = $sense->attributeDictionary();
    if (!empty($dict['features']) || !empty($dict['policies'])) {
        @file_put_contents($cache, json_encode($dict, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        return $dict;
    }
    if (is_file($cache)) {
        $c = json_decode((string) file_get_contents($cache), true);
        if (is_array($c)) {
            return $c;
        }
    }
    return ['features' => [], 'policies' => []];
}

/** Attach the most-recent detection frame (from incidents) to each camera row. */
function attachFrames(array $rows, array $incidents): array
{
    $frameByCam = [];
    foreach ($incidents as $i) {
        $key = strtoupper((string) ($i['serial'] ?: $i['camera']));
        if (!isset($frameByCam[$key]) && !empty($i['image'])) {
            $frameByCam[$key] = $i['image'];
        }
    }
    foreach ($rows as &$r) {
        $k1 = strtoupper((string) $r['serial']);
        $k2 = strtoupper((string) $r['stream']);
        $r['image'] = $frameByCam[$k1] ?? $frameByCam[$k2] ?? null;
        // Older cache files may still hold Chinese names/types — clean on read.
        $r['name'] = Text::latin((string) ($r['name'] ?? ''), (string) $r['serial']);
        $r['type'] = Text::latin((string) ($r['type'] ?? ''), 'Camera');
    }
    return $rows;
}

/** 24 rolling hourly buckets (oldest→newest) of detection counts by module. */
function hourlyTrend(EventStore $store): array
{
    $from = date('Y-m-d H:i:s', time() - 86400);
    $rows = $store->query(['limit' => 500, 'from' => $from]);
    $bins = [];
    for ($i = 0; $i < 24; $i++) {
        $bins[$i] = ['fire' => 0, 'ppe' => 0, 'intr' => 0, 'face' => 0];
    }
    $now = time();
    foreach ($rows as $e) {
        $ts = strtotime((string) ($e['received_at'] ?? '')) ?: $now;
        $hoursAgo = (int) floor(($now - $ts) / 3600);
        if ($hoursAgo < 0 || $hoursAgo > 23) {
            continue;
        }
        $mod = DashboardMapper::modOf($e);
        $bins[23 - $hoursAgo][$mod] = ($bins[23 - $hoursAgo][$mod] ?? 0) + 1;
    }
    return array_values($bins);
}

/**
 * Weststar AI per-event review remarks (uuid → short remark), file-cached ~45s.
 * Prefers an image-grounded vision field (review_vision / review_remark) added by
 * the on-prem vision model; falls back to the first sentence of review_summary.
 */
function senseReviews(array $config): array
{
    $base = $config['ai']['base'] ?? '';
    if ($base === '' || !function_exists('curl_init')) {
        return [];
    }
    // Every dashboard tab polls the feed every 5s — serve this from cache for
    // 5 minutes, and skip the call entirely while the breaker is open.
    $cache = ($config['storage']['raw_log'] ?? (APP_ROOT . '/storage/x')) . '.reviews.json';
    $fresh = is_file($cache) ? (time() - filemtime($cache)) : PHP_INT_MAX;
    if ($fresh < 300) {
        $c = json_decode((string) file_get_contents($cache), true);
        if (is_array($c)) {
            return $c;
        }
    }
    require_once APP_ROOT . '/lib/Upstream.php';
    $dir = dirname((string) ($config['storage']['raw_log'] ?? (APP_ROOT . '/storage/x')));
    if (!Upstream::allow('westar_reviews', $dir, 4)) {
        $c = is_file($cache) ? json_decode((string) file_get_contents($cache), true) : [];
        return is_array($c) ? $c : [];
    }
    $ch = curl_init($base . '/events?limit=200');
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 6, CURLOPT_CONNECTTIMEOUT => 3]);
    $body = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $cerr = curl_error($ch);
    curl_close($ch);
    if ($cerr !== '' || $code === 0 || $code >= 500) {
        Upstream::failed('westar_reviews', $dir);
        @touch($cache);                       // hold the last good map, stop retrying
        $c = is_file($cache) ? json_decode((string) file_get_contents($cache), true) : [];
        return is_array($c) ? $c : [];
    }
    Upstream::ok('westar_reviews', $dir);

    if ($code === 200 && $body) {
        $d = json_decode((string) $body, true);
        $map = [];
        foreach (($d['events'] ?? []) as $e) {
            $uuid = (string) ($e['uuid'] ?? '');
            if ($uuid === '') {
                continue;
            }
            // Only image-grounded remarks (from the on-prem vision model). The
            // verbose attribute-based review_summary is intentionally NOT used —
            // set VISION_REMARKS_FROM_SUMMARY=1 in .env to fall back to it.
            $remark = $e['review_vision'] ?? $e['review_remark'] ?? $e['vision_caption'] ?? null;
            if (!$remark && (getenv('VISION_REMARKS_FROM_SUMMARY') === '1')) {
                $s = trim((string) ($e['review_summary'] ?? ''));
                if ($s !== '') {
                    $first = preg_split('/(?<=[.!?])\s+/', $s)[0] ?? $s;
                    $remark = mb_substr($first, 0, 160);
                }
            }
            if ($remark) {
                $map[$uuid] = ['remark' => trim((string) $remark)];
            }
        }
        @file_put_contents($cache, json_encode($map, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        return $map;
    }
    if (is_file($cache)) {
        $c = json_decode((string) file_get_contents($cache), true);
        if (is_array($c)) {
            return $c;
        }
    }
    return [];
}

/**
 * Weststar AI analytics + LLM summary, file-cached so the 5s dashboard poll
 * never blocks on the (slow) LLM call. Refreshes at most once per TTL.
 */
function aiAnalytics(array $config): ?array
{
    // AI source is switchable from the Settings page: weststar-ai middleware
    // (default), the Anthropic API directly, or off.
    $source = $config['ai']['source'] ?? 'weststar';
    if ($source === 'off') {
        return null;
    }
    if ($source === 'anthropic') {
        require_once APP_ROOT . '/lib/Insights.php';
        try {
            $pdo = Database::connect($config['storage']);
            $agg = Insights::aggregate($pdo, 7);
            $llm = Insights::llmForecast($config, $agg, Insights::forecast($agg));
            return $llm ? ['summary' => $llm['summary'], 'source' => $llm['source'], 'fetched_at' => $llm['fetched_at'] ?? date('c')] : null;
        } catch (Throwable $e) {
            error_log('[feed] anthropic ai: ' . $e->getMessage());
            return null;
        }
    }
    $base = $config['ai']['base'] ?? '';
    if ($base === '' || !function_exists('curl_init')) {
        return null;
    }
    $cacheFile = ($config['storage']['raw_log'] ?? (APP_ROOT . '/storage/x')) . '.ai.json';
    $ttl = 120;

    if (is_file($cacheFile) && (time() - filemtime($cacheFile)) < $ttl) {
        $c = json_decode((string) file_get_contents($cacheFile), true);
        if (is_array($c)) {
            return $c;
        }
    }

    $ch = curl_init($base . '/analytics?window=24h');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 8,
        CURLOPT_CONNECTTIMEOUT => 4,
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($code === 200 && $body) {
        $d = json_decode((string) $body, true);
        if (is_array($d)) {
            $out = [
                'summary'     => $d['llm_review'] ?? null,
                'by_category' => $d['by_category'] ?? [],
                'by_device'   => $d['by_device'] ?? [],
                'total'       => $d['total'] ?? null,
                'fetched_at'  => date('c'),
            ];
            @file_put_contents($cacheFile, json_encode($out, JSON_UNESCAPED_SLASHES));
            return $out;
        }
    }
    // Serve stale cache if the live call failed.
    if (is_file($cacheFile)) {
        $c = json_decode((string) file_get_contents($cacheFile), true);
        if (is_array($c)) {
            return $c;
        }
    }
    return null;
}

// Read token: required only if READ_TOKEN is set. Accept ?token= or header.
$expected = $config['auth']['read_token'] ?? '';
if ($expected !== '') {
    $given = $_GET['token'] ?? ($_SERVER['HTTP_X_READ_TOKEN'] ?? '');
    if ($given === '' && stripos($_SERVER['HTTP_AUTHORIZATION'] ?? '', 'Bearer ') === 0) {
        $given = trim(substr($_SERVER['HTTP_AUTHORIZATION'], 7));
    }
    if (!hash_equals($expected, (string) $given)) {
        Response::error('Unauthorized', 401);
    }
}

try {
    $pdo   = Database::connect($config['storage']);
    $store = new EventStore($pdo, $config);

    // "Find people in records" mode: ?find=1&gender=Male&age=Adult&tops_color=…
    // (filters resolve against the indexed event_attributes rows).
    if (isset($_GET['find'])) {
        $results = [];
        foreach ($store->findPeople($_GET) as $e) {
            $dec = is_array($e['decoded'] ?? null) ? $e['decoded'] : [];
            $ts  = strtotime((string) (($e['trigger_time'] ?: $e['received_at']) ?? '')) ?: time();
            $results[] = [
                'uuid'   => $e['uuid'],
                'camera' => strtoupper((string) ($e['stream'] ?: ($e['device_serial'] ?? 'CAM'))),
                'device' => $e['device_name'] ?: '',
                'zone'   => $e['policy_name'] ?: '',
                'time'   => $e['trigger_time'] ?: $e['received_at'],
                'ts'     => $ts * 1000,
                'person' => trim(($dec['Age'] ?? '') . ' ' . (in_array($dec['Gender'] ?? '', ['Male', 'Female'], true) ? $dec['Gender'] : 'person')),
                'attrs'  => array_intersect_key($dec, array_flip(
                    ['Gender', 'Age', 'TopsType', 'TopsColor', 'HatsType', 'WithMask', 'WithReflectiveVest', 'Smoking'])),
                'image'  => $e['images']['trigger'] ?? null,
            ];
        }
        Response::json(['ok' => true, 'count' => count($results), 'results' => $results]);
    }

    // Poor-man's cron: the dashboard polls every 5s, so due scheduled reports
    // go out from here (self-throttled to one check per minute). A real cron
    // hitting /api/report/cron makes the send time exact but isn't required.
    try {
        require_once APP_ROOT . '/lib/Insights.php';
        Reporter::maybeSend($config, $pdo);
    } catch (Throwable $e) {
        error_log('[feed] reporter: ' . $e->getMessage());
    }

    // The recent window, PLUS every detection that is still open or acknowledged
    // however old it is — nothing disappears from the incident list until it is
    // resolved. (Stored events are never auto-deleted; MAX_EVENTS is off.)
    $limit  = max(1, min(1000, (int) ($_GET['limit'] ?? 300)));
    $events = $store->query(['limit' => $limit]);   // newest first, hydrated
    $unresolved = $store->query(['status_not' => 'resolved', 'limit' => 1000]);
    if ($unresolved) {
        $seen = [];
        foreach ($events as $e) {
            $seen[(string) $e['id']] = true;
        }
        foreach ($unresolved as $e) {
            if (!isset($seen[(string) $e['id']])) {
                $events[] = $e;
            }
        }
        usort($events, static fn ($a, $b) => (int) $b['id'] <=> (int) $a['id']);
    }

    // Incidents (feed / incident pages).
    $incidents = array_map([DashboardMapper::class, 'incident'], $events);

    // Merge the Weststar AI per-event review (image-grounded remark) by uuid.
    $reviews = senseReviews($config);
    if ($reviews) {
        foreach ($incidents as &$__i) {
            $r = $reviews[$__i['id']] ?? null;
            if ($r && !empty($r['remark'])) {
                $__i['remark'] = $r['remark'];
            }
        }
        unset($__i);
    }

    // Camera tiles: newest event per stream, plus detection boxes from any
    // other events on that camera within 5s of it — so simultaneous targets
    // each get a box instead of only the latest one.
    $cams = [];
    $camTs = [];
    foreach ($events as $e) {
        $key = (string) ($e['stream'] ?: ($e['device_serial'] ?? ''));
        if ($key === '') {
            continue;
        }
        if (!isset($cams[$key])) {
            $cams[$key] = DashboardMapper::camera($e);
            $b = $cams[$key]['boxes'][0] ?? null;
            $camTs[$key] = $b['ts'] ?? 0;
            continue;
        }
        if (count($cams[$key]['boxes']) >= 6) {
            continue;
        }
        $b = DashboardMapper::boxFor($e);
        if (!$b || ($camTs[$key] && $camTs[$key] - ($b['ts'] ?? 0) > 5000)) {
            continue;
        }
        // Skip near-duplicate boxes (same target re-detected a moment apart).
        $dup = false;
        foreach ($cams[$key]['boxes'] as $x) {
            if (abs((float) $x['left'] - (float) $b['left']) < 4 && abs((float) $x['top'] - (float) $b['top']) < 4) {
                $dup = true;
                break;
            }
        }
        if (!$dup) {
            $cams[$key]['boxes'][] = $b;
        }
    }
    $cams = array_values($cams);

    // KPI meta.
    $ppeViolations = 0;
    $openHour = 0;
    $nowTs = time() * 1000;
    foreach ($incidents as $i) {
        if ($i['mod'] === 'ppe') {
            $ppeViolations++;
        }
        if ($nowTs - $i['ts'] <= 3600 * 1000) {
            $openHour++;
        }
    }
    $total = count($incidents);
    $ppePct = $total > 0 ? (int) round((1 - $ppeViolations / $total) * 100) : 100;

    // Real breakdowns for the Analytics page.
    $byType = ['fire' => 0, 'ppe' => 0, 'intr' => 0, 'face' => 0];
    $byCam  = [];
    foreach ($incidents as $i) {
        $byType[$i['mod']] = ($byType[$i['mod']] ?? 0) + 1;
        $byCam[$i['camera']] = ($byCam[$i['camera']] ?? 0) + 1;
    }

    $trend   = hourlyTrend($store);
    $avgAck  = $store->avgAckSeconds();
    $ppe     = $store->ppeStats(120);
    $face    = $store->faceReport();
    $fleet   = senseCameras($config, $incidents);
    $metrics = $store->responseMetrics();
    $attrDict = senseAttrDict($config);

    // Per-module dashboard report (fire/ppe/intr) — only when the dashboard
    // is on that detection page (?report=fire|ppe|intr), to keep polls cheap.
    $reportMod = in_array($_GET['report'] ?? '', ['fire', 'ppe', 'intr'], true) ? $_GET['report'] : null;
    $report    = $reportMod ? $store->modReport($reportMod) : null;

    $armedWindow = (string) ($config['alerts']['intr_armed'] ?? 'always');

    Response::json([
        'ok'         => true,
        'server_now' => $nowTs,
        // Same build stamp index.php injects — open tabs compare and offer a
        // reload when a deploy changes it.
        'build'      => md5(implode('|', [
            @filemtime(APP_ROOT . '/AIVA Dashboard.dc.html'),
            @filemtime(APP_ROOT . '/app.js'),
            @filemtime(APP_ROOT . '/app.css'),
        ])),
        'events'     => $incidents,
        'cams'       => $cams,
        'fleet'      => $fleet,
        'liveBase'   => $config['live']['stream_base'] ?? '',
        'liveToken'  => $config['live']['stream_token'] ?? '',
        // Cameras the operator hid from the Live Monitoring grid (stream keys).
        'liveHidden' => array_values($config['live']['hidden'] ?? []),
        // Policies observed per camera → Settings shows how many are enabled
        // on the cameras currently displayed on Live Monitoring.
        'policies'   => $store->policyMatrix(30),
        // SenseStudio-sourced attribute dictionary + configured monitor
        // policies (feature id/value naming for the detection-rule builder).
        'attrDict'   => $attrDict['features'] ?? [],
        // Operator-enrolled person profiles (personId → name/photo).
        'profiles'   => $store->personProfiles(),
        'sensePolicies' => $attrDict['policies'] ?? [],
        'trend'      => $trend,
        'gpu'        => gpuSeries($trend),
        'byType'     => $byType,
        'byCam'      => $byCam,
        'ppe'        => $ppe,
        'face'       => $face,
        'metrics'    => $metrics,
        'report'     => $report,
        'ai'         => aiAnalytics($config),
        'sla'        => Reporter::SLA,
        'armed'      => [
            'window' => $armedWindow,
            'active' => DashboardMapper::armedNow($armedWindow),
        ],
        'mail'       => [
            'enabled'     => !empty($config['mail']['host']) && !empty($config['mail']['to']),
            'to'          => $config['mail']['to'] ?? [],
            'minSeverity' => $config['alerts']['min_severity'] ?? 'high',
            'alwaysMods'  => array_values($config['alerts']['always_mods'] ?? []),
            'cooldownMin' => $config['mail']['cooldown'] ?? 5,
        ],
        'meta'       => [
            'camsTotal'  => count($fleet) ?: count($cams),
            'camsOnline' => count(array_filter($fleet, static fn ($c) => $c['online'])) ?: count($cams),
            'open'       => $total,
            'openHour'   => $openHour,
            'ppePct'     => $ppe['total'] > 0 ? $ppe['pct'] : $ppePct,
            'ppeOpen'    => $ppe['missing'],
            'total24h'   => array_sum($byType),
            'avgAckSec'  => $avgAck,
            'avgAck'     => $avgAck !== null ? sprintf('%d:%02d', intdiv($avgAck, 60), $avgAck % 60) : '—',
        ],
    ]);
} catch (Throwable $e) {
    error_log('[feed] ' . $e->getMessage() . ' @ ' . $e->getLine());
    Response::error($config['app']['debug'] ? $e->getMessage() : 'Feed error', 500);
}
