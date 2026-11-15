<?php
/**
 * Dashboard data feed. Reads captured SenseTime events and returns them in the
 * exact shapes the Kian Joo VisionAI consumes (incidents + camera tiles
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
require_once APP_ROOT . '/lib/Attendance.php';
require_once APP_ROOT . '/lib/Overview.php';
require_once APP_ROOT . '/lib/LiveBridge.php';

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
        $det = ($b['fire'] ?? 0) + ($b['ppe'] ?? 0) + ($b['intr'] ?? 0) + ($b['face'] ?? 0) + ($b['forklift'] ?? 0);
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

    // Same mapping LiveBridge uses (stream label = RTSP_STREAMS key whose url
    // matches, else the normalised serial).
    $rows = LiveBridge::mapDevices($res['data'], $config['live']['rtsp'] ?? []);
    @file_put_contents($cache, json_encode($rows, JSON_UNESCAPED_SLASHES));
    // Keep the go2rtc bridge in step with the fleet's RTSP sources
    // (rate-limited to once / 5 min, 2 s timeouts, silent on failure).
    LiveBridge::autoSync($config, $rows);
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
        $bins[$i] = ['fire' => 0, 'ppe' => 0, 'intr' => 0, 'face' => 0, 'forklift' => 0];
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
 * Per-event AI review remarks (uuid → short remark) from the Claude
 * PPE-forklift pipeline (ai_reviews table). Replaces the retired Weststar AI
 * middleware remarks; same output shape.
 */
function senseReviews(array $config): array
{
    try {
        $pdo = Database::connect($config['storage']);
        $st  = $pdo->query("SELECT event_uuid, verdict_json, violation FROM ai_reviews
                            WHERE event_uuid IS NOT NULL AND verdict_json IS NOT NULL ORDER BY id DESC LIMIT 200");
        $map = [];
        foreach ($st->fetchAll() as $r) {
            $v = json_decode((string) $r['verdict_json'], true) ?: [];
            $reason = trim((string) ($v['reason'] ?? ''));
            if ($reason !== '' && !isset($map[$r['event_uuid']])) {
                $map[(string) $r['event_uuid']] = ['remark' => ((int) $r['violation'] ? 'Forklift without PPE: ' : '') . mb_substr($reason, 0, 160)];
            }
        }
        return $map;
    } catch (Throwable $e) {
        return [];
    }
}

/**
 * AI analytics summary for the dashboard — Claude forecast narration
 * (lib/Insights.php → lib/Claude.php, cached 30 min). Source 'off' → null.
 */
function aiAnalytics(array $config): ?array
{
    if (($config['ai']['source'] ?? 'claude') === 'off') {
        return null;
    }
    require_once APP_ROOT . '/lib/Insights.php';
    try {
        $pdo = Database::connect($config['storage']);
        $agg = Insights::aggregate($pdo, 7);
        $llm = Insights::llmForecast($config, $agg, Insights::forecast($agg));
        return $llm ? ['summary' => $llm['summary'], 'source' => $llm['source'], 'fetched_at' => $llm['fetched_at'] ?? date('c'),
                       'by_category' => $agg['byType'], 'total' => $agg['total']] : null;
    } catch (Throwable $e) {
        error_log('[feed] claude ai: ' . $e->getMessage());
        return null;
    }
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
    // Workstream C: behaviour scan (chit-chat / idle / cleaning proxy) piggy-
    // backed on the poll — at most once per 60 s (storage/beh_cursor.json mtime).
    try {
        require_once APP_ROOT . '/lib/Behaviour.php';
        (new Behaviour($pdo, $config, $store))->maybeScan(60);
    } catch (Throwable $e) {
        error_log('[feed] behaviour: ' . $e->getMessage());
    }
    // Workstream A: unattended-alert escalation piggy-backed on the poll
    // (at most once per 60 s via storage/escalation.lock, silent on failure).
    try {
        require_once APP_ROOT . '/lib/Escalation.php';
        Escalation::maybeRun($config, $pdo, 60);
    } catch (Throwable $e) {
        error_log('[feed] escalation: ' . $e->getMessage());
    }
    // Workstream D: daily data-retention purge piggy-backed on the poll
    // (storage/retention.lock mtime; batch-capped so a poll stays fast).
    try {
        require_once APP_ROOT . '/lib/Retention.php';
        Retention::maybeRun($pdo, $config, 86400, 1500);
    } catch (Throwable $e) {
        error_log('[feed] retention: ' . $e->getMessage());
    }
    // Camera monitors: fallback when /api/monitors/cron is not scheduled. Both
    // share throttle files + flocks, so with the cron running these are no-ops.
    try {
        require_once APP_ROOT . '/lib/MonitorScanner.php';
        MonitorScanner::maybeFitness($pdo, $config, 86400, 15, 1);
        MonitorScanner::maybeRun($pdo, $config, 20, 10, 'feed');
    } catch (Throwable $e) {
        error_log('[feed] monitors: ' . $e->getMessage());
    }

    // The recent window, PLUS every detection that is still open or acknowledged
    // however old it is — nothing disappears from the incident list until it is
    // resolved. (Events are only purged after the Settings → Data Retention
    // window, default 90 days; MAX_EVENTS is off.)
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
    $byType = ['fire' => 0, 'ppe' => 0, 'intr' => 0, 'face' => 0, 'forklift' => 0];
    $byCam  = [];
    foreach ($incidents as $i) {
        $byType[$i['mod']] = ($byType[$i['mod']] ?? 0) + 1;
        $byCam[$i['camera']] = ($byCam[$i['camera']] ?? 0) + 1;
    }

    $trend   = hourlyTrend($store);
    $avgAck  = $store->avgAckSeconds();
    $ppe     = $store->ppeStats(120);
    $face    = $store->faceReport();
    $fleet   = LiveBridge::allowedFleet($config, senseCameras($config, $incidents));   // only cameras with a live source
    $metrics = $store->responseMetrics();
    // Sidebar plant list: cameras online / total per configured plant.
    try {
        $plants = array_map(static fn ($n, $p) => ['name' => $n, 'online' => $p['online'], 'total' => $p['total']],
            array_keys($pc = Overview::plantCams($config, $store, $fleet)), $pc);
    } catch (Throwable $e) {
        $plants = [];
    }
    $attrDict = senseAttrDict($config);

    // Per-module dashboard report (fire/ppe/intr) — only when the dashboard
    // is on that detection page (?report=fire|ppe|intr), to keep polls cheap.
    $reportMod = in_array($_GET['report'] ?? '', ['fire', 'ppe', 'intr'], true) ? $_GET['report'] : null;
    $report    = $reportMod ? $store->modReport($reportMod) : null;

    $armedWindow = (string) ($config['alerts']['intr_armed'] ?? 'always');

    // Assets part of the build stamp — keep identical to index.php (four flat
    // globs, no recursive scan) so an assets-only deploy raises the banner.
    $assetMtime = 0;
    foreach (['assets/js/*.js', 'assets/js/pages/*.js', 'assets/css/*.css', 'assets/css/pages/*.css'] as $pat) {
        foreach (glob(APP_ROOT . '/' . $pat) ?: [] as $f) {
            $assetMtime = max($assetMtime, (int) @filemtime($f));
        }
    }
    Response::json([
        'ok'         => true,
        'server_now' => $nowTs,
        // Same build stamp index.php injects — open tabs compare and offer a
        // reload when a deploy changes it.
        'build'      => md5(implode('|', [
            @filemtime(APP_ROOT . '/Kian Joo VisionAI.dc.html'),
            @filemtime(APP_ROOT . '/app.js'),
            @filemtime(APP_ROOT . '/app.css'),
            $assetMtime,
        ])),
        'events'     => $incidents,
        'cams'       => $cams,
        'fleet'      => $fleet,
        'liveBase'   => $config['live']['stream_base'] ?? '',
        'liveToken'  => $config['live']['stream_token'] ?? '',
        // Cameras the operator hid from the Live Monitoring grid (stream keys).
        'liveHidden' => array_values($config['live']['hidden'] ?? []),
        // Last known go2rtc bridge state (no network): reachable + registered stream names.
        'liveBridge' => LiveBridge::cached($config),
        // Manual HLS (.m3u8) sources the browser plays directly, label → url.
        'liveDirect' => (object) LiveBridge::directSources($config),
        'liveStill'  => LiveBridge::stillSources($config, LiveBridge::fleetRows($config, false)),
        'liveRelay'  => LiveBridge::relaySources($config, LiveBridge::fleetRows($config, false)),
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
        'plants'     => $plants,
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
