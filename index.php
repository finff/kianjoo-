<?php
/**
 * Serves the Kian Joo VisionAI monitoring dashboard behind a login gate.
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
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kian Joo VisionAI — Sign in</title>
<link rel="icon" type="image/png" href="/uploads/Kian-Joo-Logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;
    padding:24px 16px;background:#F3F5F9;font-family:'Inter',system-ui,sans-serif;color:#1E2A44;
    -webkit-font-smoothing:antialiased}
  .card{width:min(100%,420px);background:#fff;border:1px solid #E6EAF1;border-radius:16px;
    padding:32px 32px 26px;box-shadow:0 1px 2px rgba(16,24,40,.04),0 12px 32px rgba(16,24,40,.08)}
  .logo{display:flex;flex-direction:column;align-items:center;text-align:center;gap:14px;margin-bottom:24px}
  .logo img{height:46px;width:auto;border-radius:10px;background:#fff;padding:5px 8px;border:1px solid #E6EAF1}
  .logo b{font-size:19px;font-weight:800;display:block;letter-spacing:-.2px}
  .logo span{display:block;font-size:12.5px;color:#5C6B86;margin-top:3px}
  label{display:block;font-size:12.5px;color:#1E2A44;font-weight:600;margin:16px 0 6px}
  input{width:100%;height:44px;font-size:14px;color:#1E2A44;background:#F6F8FB;border:1px solid #D5DBE7;
    border-radius:10px;padding:0 14px;outline:none;font-family:inherit;transition:border-color .15s,box-shadow .15s}
  input:focus{border-color:#2F6BFF;background:#fff;box-shadow:0 0 0 3px rgba(47,107,255,.16)}
  button{width:100%;height:46px;margin-top:22px;font-size:14px;font-weight:700;color:#fff;background:#2F6BFF;
    border:none;border-radius:10px;cursor:pointer;font-family:inherit;transition:background .15s}
  button:hover{background:#1F55D6}
  button:focus-visible{outline:2px solid #2F6BFF;outline-offset:2px}
  .err{margin-top:16px;font-size:12.5px;color:#B91C1C;background:#FDEAEA;
    border:1px solid #F7C4C4;border-radius:10px;padding:10px 12px}
  .note{margin-top:18px;font-size:11.5px;color:#8A96AB;text-align:center}
  .foot{font-size:12px;color:#8A96AB;text-align:center}
  .foot a{color:#2F6BFF;text-decoration:none;font-weight:600}
  .foot a:hover{text-decoration:underline}
</style>
</head>
<body>
  <form class="card" method="post" action="/">
    <div class="logo">
      <img src="/uploads/Kian-Joo-Logo.png" alt="Kian Joo Group">
      <div><b>Kian Joo VisionAI</b><span>AI Factory Monitoring Dashboard</span></div>
    </div>
    <label for="lg-user">Username</label>
    <input id="lg-user" name="username" autocomplete="username" autofocus required>
    <label for="lg-pass">Password</label>
    <input id="lg-pass" name="password" type="password" autocomplete="current-password" required>
    <input type="hidden" name="__login" value="1">
    <button type="submit">Sign in</button>
    {$err}
    <div class="note">Access is role-based. Your session ends when you sign out.</div>
  </form>
  <div class="foot"><a href="/">Back to home</a> &nbsp;·&nbsp; Kian Joo Group</div>
</body>
</html>
HTML;
    exit;
}

// ── Logged in → serve the dashboard with user context ───────
$dash = APP_ROOT . '/Kian Joo VisionAI.dc.html';
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
    @filemtime(APP_ROOT . '/Kian Joo VisionAI.dc.html'),
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
