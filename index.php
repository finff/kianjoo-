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
    $err = $loginError !== ''
        ? '<div class="err" role="alert"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg><span>' . htmlspecialchars($loginError) . '</span></div>'
        : '';
    $page = <<<'LOGIN_HTML'
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
<link rel="stylesheet" href="/assets/css/login.css">
</head>
<body>
<div class="wrap">
  <aside class="brand">
    <div class="b-top">
      <img src="/uploads/Kian-Joo-Logo.png" alt="Kian Joo Group">
      <div><b>Kian Joo VisionAI</b><span>Smart Factory · Safer People</span></div>
    </div>

    <div>
      <span class="pill"><i></i>AI Factory Monitoring</span>
      <h1>See your factory floor<br><em>in real time.</em></h1>
      <p class="lead">Attendance, PPE safety and live cameras in one dashboard, powered by SenseTime vision AI.</p>
    </div>

    <div class="stage" aria-hidden="true">
      <div class="win">
        <div class="win-bar"><i></i><i></i><i></i><span>Live monitoring · Camera 01</span><em class="live">LIVE</em></div>
        <div class="scene">
          <div class="desk d1"></div>
          <div class="desk d2"></div>
          <div class="person p1"></div>
          <div class="person p2"></div>
          <div class="box b1"><b>FACE MATCH · 0.97</b></div>
          <div class="box warn b2"><b>NO VEST</b></div>
          <div class="scan"></div>
        </div>
      </div>
      <div class="chip c1">
        <span class="dot dot-ok"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>
        <div><b>Clock-in recorded</b><span>Face recognised · on time</span></div>
      </div>
      <div class="chip c2">
        <span class="dot dot-warn"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5"/><path d="M14 6a6 6 0 0 1 6 6v3"/><path d="M4 15v-3a6 6 0 0 1 6-6"/><rect x="2" y="15" width="20" height="4" rx="1"/></svg></span>
        <div><b>PPE alert</b><span>Safety vest missing · alert sent</span></div>
      </div>
      <div class="chip c3">
        <div class="bars"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
        <div><b>Activity</b><span>Today</span></div>
      </div>
    </div>

    <div class="b-foot">© Kian Joo Group · Powered by Weststar</div>
  </aside>

  <main class="side">
    <form class="card" method="post" action="/" id="lg-form">
      <img class="logo-sm" src="/uploads/Kian-Joo-Logo.png" alt="">
      <h2>Welcome back</h2>
      <p class="sub">Sign in to continue to your dashboard.</p>
      <label for="lg-user">Username</label>
      <div class="field">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>
        <input id="lg-user" name="username" autocomplete="username" placeholder="Enter your username" autofocus required>
      </div>
      <label for="lg-pass">Password</label>
      <div class="field">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
        <input id="lg-pass" name="password" type="password" autocomplete="current-password" placeholder="Enter your password" required>
        <button type="button" class="eye" id="lg-eye" aria-label="Show password" title="Show password">
          <svg class="on" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
          <svg class="off" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-6.5 0-10-7-10-7a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19"/><path d="m1 1 22 22"/></svg>
        </button>
      </div>
      <input type="hidden" name="__login" value="1">
      <button type="submit" class="go" id="lg-go"><span class="spin"></span><span class="lbl">Sign in</span>
        <svg class="arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg></button>
      {ERR}
      <div class="note"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Secure, role-based access</div>
    </form>
    <div class="foot"><a href="/">← Back to home</a></div>
  </main>
</div>
<script src="/assets/js/login.js"></script>
</body>
</html>
LOGIN_HTML;
    echo str_replace('{ERR}', $err, $page);
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
// The SPA's assets/js + assets/css (+ pages/) count too, so an assets-only
// deploy also raises the banner. Four flat globs (~40 stats), no recursive scan;
// keep this list identical to feed.php's.
$assetMtime = 0;
foreach (['assets/js/*.js', 'assets/js/pages/*.js', 'assets/css/*.css', 'assets/css/pages/*.css'] as $pat) {
    foreach (glob(APP_ROOT . '/' . $pat) ?: [] as $f) {
        $assetMtime = max($assetMtime, (int) @filemtime($f));
    }
}
$build = md5(implode('|', [
    @filemtime(APP_ROOT . '/Kian Joo VisionAI.dc.html'),
    @filemtime(APP_ROOT . '/app.js'),
    @filemtime(APP_ROOT . '/app.css'),
    $assetMtime,
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
// Same for the design-system / KJModal assets (assets/css, assets/js, vendor).
$html = (string) preg_replace_callback('#(href|src)="(assets/[^"?]+)"#', static function (array $m): string {
    $v = @filemtime(APP_ROOT . '/' . $m[2]) ?: time();
    return $m[1] . '="' . $m[2] . '?v=' . $v . '"';
}, $html);

header('Content-Type: text/html; charset=utf-8');
echo $html;
