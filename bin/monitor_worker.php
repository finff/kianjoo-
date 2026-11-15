<?php
/**
 * Cron entry for the VisionAI camera-monitor cascade (lib/MonitorScanner.php).
 *
 *   * * * * *  /usr/local/bin/php /home3/weststar/public_html/kianjoo.weststar-dev.com/bin/monitor_worker.php
 *
 * Options: --dry-run       list what would be screened / fitness-checked (no frame fetch, no AI calls, no writes)
 *          --fitness       run the daily fitness check only (forced for --stream, else cameras that are due)
 *          --stream=NAME   limit to one camera
 *          --force         ignore per-camera intervals (scan) / the 24 h window (fitness)
 *
 * No SSH on the shared host? Use the token-guarded web route instead:
 *   GET https://<host>/api/monitors/cron?token=PROVISION_TOKEN
 * Both share the flocks, throttle files and storage/monitor_state.json, so running both is safe.
 */

declare(strict_types=1);

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

define('APP_ROOT', dirname(__DIR__));
$config = require APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/lib/Response.php';
require_once APP_ROOT . '/lib/Database.php';
require_once APP_ROOT . '/lib/MonitorScanner.php';

$opts = getopt('', ['dry-run', 'fitness', 'stream:', 'force']);
$dry  = isset($opts['dry-run']);
$base = ['dry_run' => $dry, 'force' => isset($opts['force'])];
if (isset($opts['stream']) && $opts['stream'] !== '') {
    $base['stream'] = (string) $opts['stream'];
}
try {
    $pdo = Database::connect($config['storage']);
    $sc  = new MonitorScanner($pdo, $config);
    $out = ['ok' => true, 'ran_at' => date('c'), 'settings' => Monitors::settings($config)];
    $s = $out['settings'];
    $out['fitness'] = isset($opts['fitness']) || ($s['enabled'] && $s['fitness_enabled'])
        ? $sc->fitness($base + ['every' => 86400, 'budget' => 50]) : ['skipped' => 'fitness check disabled'];
    if (!isset($opts['fitness'])) {
        $out['scan'] = $sc->run($base + ['budget' => 50, 'source' => 'cli']);
    }
    echo json_encode($out, JSON_UNESCAPED_SLASHES), "\n";
    exit(0);
} catch (Throwable $e) {
    fwrite(STDERR, '[monitor_worker] ' . $e->getMessage() . "\n");
    exit(1);
}
