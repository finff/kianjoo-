<?php
/**
 * Cron entry for the AI layer (M9 PPE-forklift pipeline + SLA breach sweep).
 *
 *   * * * * *  /usr/local/bin/php /home3/weststar/public_html/kianjoo.weststar-dev.com/bin/ai_worker.php
 *
 * Options: --dry-run   scan + count only (no Claude calls, no writes)
 *          --max=N     max Claude reviews this run (default config ai.pipeline.max_reviews)
 *
 * No SSH on the shared host? Use the token-guarded web route instead:
 *   GET https://<host>/api/pipeline/run?token=PROVISION_TOKEN
 * (cPanel cron: curl -s "<that url>" >/dev/null). Both share one flock, the
 * cursor and the per-person rate gate, so running both is safe.
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
require_once APP_ROOT . '/lib/PpeForkliftPipeline.php';

$opts = getopt('', ['dry-run', 'max:']);
$o    = ['dry_run' => isset($opts['dry-run'])];
if (isset($opts['max'])) {
    $o['max_reviews'] = max(1, min(30, (int) $opts['max']));
}
try {
    $pdo   = Database::connect($config['storage']);
    $stats = (new PpeForkliftPipeline($pdo, $config))->run($o);
    echo json_encode(['ok' => true, 'ran_at' => date('c'), 'stats' => $stats], JSON_UNESCAPED_SLASHES), "\n";
    exit(0);
} catch (Throwable $e) {
    fwrite(STDERR, '[ai_worker] ' . $e->getMessage() . "\n");
    exit(1);
}
