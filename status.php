<?php
/**
 * Public landing page. Shows service status only — never secrets.
 */
declare(strict_types=1);

define('APP_ROOT', __DIR__);
$config = require APP_ROOT . '/config/config.php';

$dbReady = false;
$total = 0;
try {
    require_once APP_ROOT . '/lib/Database.php';
    $pdo = Database::connect($config['storage']);
    $total = (int) $pdo->query('SELECT COUNT(*) FROM events')->fetchColumn();
    $dbReady = true;
} catch (Throwable $e) {
    // DB not reachable / not provisioned yet — landing page still renders.
}
header('Content-Type: text/html; charset=utf-8');
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= htmlspecialchars($config['app']['name']) ?></title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 760px; margin: 6vh auto; padding: 0 20px; }
  h1 { font-size: 1.4rem; margin-bottom: .2rem; }
  .muted { opacity: .65; }
  code { background: rgba(127,127,127,.16); padding: .12em .4em; border-radius: 5px; }
  .card { border: 1px solid rgba(127,127,127,.25); border-radius: 12px; padding: 16px 18px; margin: 18px 0; }
  .dot { display:inline-block; width:.6em; height:.6em; border-radius:50%; background:#22c55e; margin-right:.4em; }
  table { border-collapse: collapse; width: 100%; }
  td { padding: 6px 8px; border-bottom: 1px solid rgba(127,127,127,.18); vertical-align: top; }
  td:first-child { white-space: nowrap; opacity:.8; }
</style>
</head>
<body>
  <h1><?= htmlspecialchars($config['app']['name']) ?></h1>
  <p class="muted"><span class="dot"></span>Online · <?= date('Y-m-d H:i:s T') ?></p>

  <div class="card">
    <strong>SenseTime / MyVisionAI ingest</strong>
    <p class="muted">Captures HTTP-Push events (SenseFoundry API §6.5) and stores them for reuse across use cases.</p>
    <table>
      <tr><td>Storage</td><td><?= $dbReady ? 'ready' : 'not provisioned yet' ?> · <?= (int)$total ?> event(s) captured</td></tr>
      <tr><td>Push URL</td><td><code>POST /api/ingest/{stream}?token=…</code></td></tr>
      <tr><td>Read API</td><td><code>GET /api/events?token=…</code></td></tr>
      <tr><td>Latest</td><td><code>GET /api/events/latest/{stream}?token=…</code></td></tr>
      <tr><td>Health</td><td><a href="api/health">/api/health</a></td></tr>
    </table>
  </div>

  <p class="muted">Tokens live in <code>.env</code> (not web-accessible). See <code>README.md</code> for setup.</p>
</body>
</html>
