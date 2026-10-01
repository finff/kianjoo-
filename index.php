<?php
/**
 * Serves the AIVA Dashboard monitoring dashboard behind a login gate.
 * Authenticated sessions get the dc-runtime app with the live-feed config +
 * logged-in user (name, role, permissions) injected as window.TMNS.
 * The raw .dc.html is not directly web-accessible (see .htaccess).
 */

declare(strict_types=1);

define('APP_ROOT', __DIR__);
$config = require APP_ROOT . '/config/config.php';

require_once APP_ROOT . '/lib/Database.php';
require_once APP_ROOT . '/lib/Auth.php';

Auth::session();

// ── Logout ───────────────────────────────────────────────────
if (isset($_GET['logout'])) {
    Auth::logout();
    header('Location: /');
    exit;
}

// ── Login attempt ────────────────────────────────────────────
$loginError = '';
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST' && isset($_POST['__login'])) {
    try {
        $pdo  = Database::connect($config['storage']);
        $user = Auth::attempt($pdo, (string) ($_POST['username'] ?? ''), (string) ($_POST['password'] ?? ''));
        if ($user) {
            header('Location: /');
            exit;
        }
        $loginError = 'Invalid username or password, or account disabled.';
    } catch (Throwable $e) {
        error_log('[login] ' . $e->getMessage());
        $loginError = 'Login temporarily unavailable — try again.';
    }
}

// ── Not logged in → login page ───────────────────────────────
$user = Auth::user();

// Public homepage for signed-out visitors; the sign-in form lives at /?login
// (and is re-shown after a failed POST so the error is visible).
$isGet = ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET';
if ($user === null && $isGet && !isset($_GET['login']) && is_file(APP_ROOT . '/home.html')) {
    header('Content-Type: text/html; charset=utf-8');
    readfile(APP_ROOT . '/home.html');
    exit;
}

if ($user === null) {
    // Seed the default admin on first run so the first login works.
    try {
        Auth::ensureSeedAdmin(Database::connect($config['storage']));
    } catch (Throwable $e) {
        error_log('[login-seed] ' . $e->getMessage());
    }
    header('Content-Type: text/html; charset=utf-8');
    $err = $loginError !== '' ? '<div class="err">' . htmlspecialchars($loginError) . '</div>' : '';
    echo <<<HTML
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AIVA Dashboard — Sign in</title>
<link rel="icon" type="image/png" href="/uploads/AIVA-Icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0A0D08;
    font-family:'IBM Plex Sans',system-ui,sans-serif;color:#E9EBDF;
    background-image:radial-gradient(60% 50% at 50% 0%, rgba(56,38,242,.14), transparent 60%)}
  .card{width:min(92vw,400px);background:#11160E;border:1px solid #3B4A33;border-radius:18px;
    padding:34px 32px;box-shadow:0 30px 90px rgba(0,0,0,.55)}
  .logo{display:flex;align-items:center;gap:12px;margin-bottom:26px}
  .logo img{height:42px;width:auto;border-radius:10px;background:#fff;padding:5px 8px}
  .logo b{font-size:17px;display:block}
  .logo span{font-size:10px;letter-spacing:1.6px;color:#6E7763;font-weight:600}
  label{display:block;font-size:11px;color:#6E7763;font-weight:700;letter-spacing:.5px;margin:15px 0 6px}
  input{width:100%;font-size:14px;color:#E9EBDF;background:#182015;border:1px solid #2A3524;
    border-radius:10px;padding:12px 14px;outline:none;font-family:inherit}
  input:focus{border-color:#3826F2}
  button{width:100%;margin-top:22px;font-size:14px;font-weight:700;color:#fff;background:#3826F2;
    border:none;border-radius:11px;padding:13px;cursor:pointer;font-family:inherit}
  button:hover{background:#4a3af5}
  .err{margin-top:16px;font-size:12px;color:#FF4D4D;background:rgba(255,77,77,.09);
    border:1px solid rgba(255,77,77,.4);border-radius:9px;padding:10px 12px}
  .foot{margin-top:20px;font-size:10.5px;color:#6E7763;text-align:center;font-family:'IBM Plex Mono'}
</style>
</head>
<body>
  <form class="card" method="post" action="/">
    <div class="logo">
      <img src="/uploads/AIVA-Logo.png" alt="AIVA">
      <div><b>AIVA Dashboard</b><span>AI VIDEO ANALYTICS · MONITORING</span></div>
    </div>
    <label>USERNAME</label>
    <input name="username" autocomplete="username" autofocus required>
    <label>PASSWORD</label>
    <input name="password" type="password" autocomplete="current-password" required>
    <input type="hidden" name="__login" value="1">
    <button type="submit">Sign in</button>
    {$err}
    <div class="foot">Role-based access · sessions expire on logout</div>
    <div class="foot"><a href="/" style="color:#A9B09A;text-decoration:none">← Back to home</a></div>
  </form>
</body>
</html>
HTML;
    exit;
}

// ── Logged in → serve the dashboard with user context ───────
$dash = APP_ROOT . '/AIVA Dashboard.dc.html';
$html = is_file($dash) ? (string) file_get_contents($dash) : '';
if ($html === '') {
    http_response_code(500);
    echo 'Dashboard not found.';
    exit;
}

// The app script lives in app.js (markup / JS / CSS are separate source
// files); the dc-runtime needs it inline, so stitch it in at serve time.
$appJs = (string) @file_get_contents(APP_ROOT . '/app.js');
if ($appJs === '') {
    http_response_code(500);
    echo 'app.js not found.';
    exit;
}
$html = str_replace('/*__APP_JS__*/', $appJs, $html);

$readToken = $config['auth']['read_token'] ?? '';
$feed = '/feed.php' . ($readToken !== '' ? '?token=' . rawurlencode($readToken) : '');
// Build stamp: changes whenever the app files change, so open tabs (which
// compare it against the feed's stamp) can offer a reload after a deploy.
$build = md5(implode('|', [
    @filemtime(APP_ROOT . '/AIVA Dashboard.dc.html'),
    @filemtime(APP_ROOT . '/app.js'),
    @filemtime(APP_ROOT . '/app.css'),
]));
$inject = '<script>window.TMNS=' . json_encode([
    'feed'  => $feed,
    'api'   => '/api',
    'token' => $readToken,
    'build' => $build,
    'user'  => [
        'name'  => $user['name'],
        'username' => $user['username'],
        'role'  => $user['role'],
        'perms' => Auth::permsFor((string) $user['role']),
    ],
], JSON_UNESCAPED_SLASHES) . ';</script>' . "\n";

// Set the live feed config before the runtime boots.
$html = str_replace(
    '<script src="./support.js"></script>',
    $inject . '<script src="./support.js"></script>',
    $html
);

// Cache-bust the stylesheet so CSS deploys take effect without a manual
// browser cache clear.
$cssVer = @filemtime(APP_ROOT . '/app.css') ?: time();
$html = str_replace('href="app.css"', 'href="app.css?v=' . $cssVer . '"', $html);

header('Content-Type: text/html; charset=utf-8');
echo $html;
