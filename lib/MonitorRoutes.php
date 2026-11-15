<?php
/**
 * VisionAI camera-monitor routes, included from api/index.php inside its
 * try {} (shares $route, $seg, $method, $config, $provisionAdmin, $requireToken).
 * Lives in lib/ so it is never directly web-reachable.
 *
 *   GET  /monitors                      settings, cameras (config + state), catalog, stats_today, cron   [admin]
 *   POST /monitors/settings             global scan settings {enabled, interval_sec(30|60|120|300), max_frames_per_run,
 *                                       rate_sec, gap_sec, min_confidence, fitness_enabled}            [admin + settings]
 *   POST /monitors/camera/{stream}      per-camera config {enabled, fields[], interval_sec|null,
 *                                       action{ticket, priority, notify_level 0–3}, force_fit}         [admin + settings]
 *   POST /monitors/fitness/run[?stream] fitness check now (forced)                                     [admin + settings]
 *   POST /monitors/scan/run[?stream&dry_run=1]  one scan cycle now, intervals ignored                  [admin + settings]
 *   GET|POST /monitors/cron?token=PROVISION_TOKEN  maybeFitness(24 h) then maybeRun, 50 s budget        [provision token]
 *
 * The read token grants nothing here; the provision token works on every
 * route (scripted maintenance), same as lib/AiRoutes.php.
 */

declare(strict_types=1);

if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

if (($seg[0] ?? '') !== 'monitors') {
    return;   // not ours — fall through to the rest of api/index.php
}

require_once APP_ROOT . '/lib/AiGuard.php';
require_once APP_ROOT . '/lib/Monitors.php';
require_once APP_ROOT . '/lib/MonitorScanner.php';

$monPdo  = Database::connect($config['storage']);
$monA    = (string) ($seg[1] ?? '');
$monB    = (string) ($seg[2] ?? '');
$monBody = static function (): array {
    $j = json_decode(file_get_contents('php://input') ?: '', true);
    return is_array($j) ? $j : $_POST;
};
$monStream = static function ($v): string {
    return LiveBridge::label(substr((string) $v, 0, 64));
};

// ── cron (token-gated, no session) ──────────────────────────
if ($monA === 'cron') {
    $requireToken((string) ($config['auth']['provision_token'] ?? ''));
    @set_time_limit(90);
    @ignore_user_abort(true);
    $t0  = time();
    $fit = null;
    $scan = null;
    try {
        $fit = MonitorScanner::maybeFitness($monPdo, $config, 86400, 20);
    } catch (Throwable $e) {
        error_log('[monitor] cron fitness: ' . $e->getMessage());
    }
    try {
        $scan = MonitorScanner::maybeRun($monPdo, $config, max(10, 50 - (time() - $t0)), 10, 'cron');
    } catch (Throwable $e) {
        error_log('[monitor] cron scan: ' . $e->getMessage());
    }
    Response::ok(['ran_at' => date('c'), 'fitness' => $fit, 'scan' => $scan]);
}

$monP = AiGuard::require($monPdo, $provisionAdmin());
AiGuard::demand($monP, 'admin');

$monCamera = static function (string $stream) use ($monPdo, &$config): ?array {
    foreach (Monitors::view($monPdo, $config)['cameras'] as $c) {
        if ($c['stream'] === $stream) {
            return $c;
        }
    }
    return null;
};

if ($monA === '' && $method === 'GET') {
    Response::ok(Monitors::view($monPdo, $config));
}

if ($method !== 'POST') {
    Response::error('Unknown monitors route.', 404);
}
AiGuard::demand($monP, 'admin', 'settings');

try {
    if ($monA === 'settings' && $monB === '') {
        $s = Monitors::saveSettings($monBody(), $config);
        Response::ok(['settings' => $s]);
    }

    if ($monA === 'camera' && $monB !== '' && !isset($seg[3])) {
        $stream = $monStream($monB);
        if ($stream === '' || !isset(Monitors::sources($config)[$stream])) {
            Response::error('Unknown camera.', 404);
        }
        $cfg = Monitors::saveCamera($stream, $monBody(), $config);
        Response::ok(['stream' => $stream, 'config' => $cfg, 'camera' => $monCamera($stream)]);
    }

    if ($monA === 'fitness' && $monB === 'run') {
        @set_time_limit(180);
        @ignore_user_abort(true);
        $in = $monBody();
        $stream = $monStream($_GET['stream'] ?? ($in['stream'] ?? ''));
        $o = ['force' => true, 'budget' => 120, 'every' => 86400];
        if ($stream !== '') {
            if (!isset(Monitors::sources($config)[$stream])) {
                Response::error('Unknown camera.', 404);
            }
            $o['stream'] = $stream;
        }
        $stats = (new MonitorScanner($monPdo, $config))->fitness($o);
        Response::ok(['ran_at' => date('c'), 'stats' => $stats,
                      'camera' => $stream !== '' ? $monCamera($stream) : null]);
    }

    if ($monA === 'scan' && $monB === 'run') {
        @set_time_limit(120);
        @ignore_user_abort(true);
        $in = $monBody();
        $stream = $monStream($_GET['stream'] ?? ($in['stream'] ?? ''));
        $o = ['force' => true, 'budget' => 50, 'source' => 'admin', 'dry_run' => !empty($_GET['dry_run']) || !empty($in['dry_run'])];
        if ($stream !== '') {
            $o['stream'] = $stream;
        }
        $stats = (new MonitorScanner($monPdo, $config))->run($o);
        Response::ok(['ran_at' => date('c'), 'stats' => $stats]);
    }
} catch (InvalidArgumentException $e) {
    Response::error($e->getMessage(), 422);
}

Response::error('Unknown monitors route.', 404);
