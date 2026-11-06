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
        ? '<div class="err" role="alert"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg><span>' . htmlspecialchars($loginError) . '</span></div>'
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
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{font-family:'Inter',system-ui,sans-serif;color:#1E2A44;-webkit-font-smoothing:antialiased;background:#F3F5F9}
  .wrap{min-height:100vh;display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr)}

  /* ── brand panel ── */
  .brand{position:relative;overflow:hidden;color:#E6ECF8;padding:44px 56px;display:flex;flex-direction:column;
    background:#0B1120;
    background-image:radial-gradient(900px 560px at 110% -10%,rgba(79,130,255,.38),transparent 60%),
      radial-gradient(760px 620px at -15% 110%,rgba(139,92,246,.32),transparent 60%),
      radial-gradient(520px 360px at 60% 115%,rgba(14,165,233,.22),transparent 65%)}
  .brand::before{content:"";position:absolute;inset:0;pointer-events:none;
    background-image:radial-gradient(circle at 1px 1px,rgba(148,163,184,.16) 1px,transparent 1.4px);background-size:26px 26px;
    -webkit-mask-image:linear-gradient(160deg,#000 10%,transparent 85%);mask-image:linear-gradient(160deg,#000 10%,transparent 85%)}
  .brand>*{position:relative}
  .b-top{display:flex;align-items:center;gap:14px}
  .b-top img{height:42px;width:auto;background:#fff;border-radius:10px;padding:5px 8px}
  .b-top b{display:block;font-size:16px;font-weight:800;letter-spacing:-.1px;color:#fff}
  .b-top span{display:block;font-size:11.5px;color:#9AA8C3;margin-top:2px}
  .b-mid{margin:auto 0;max-width:470px;padding:40px 0}
  .pill{display:inline-flex;align-items:center;gap:8px;font-size:11.5px;font-weight:600;color:#BFD0FF;
    background:rgba(79,130,255,.14);border:1px solid rgba(79,130,255,.32);border-radius:999px;padding:6px 12px}
  .pill i{width:7px;height:7px;border-radius:50%;background:#34D399;box-shadow:0 0 0 4px rgba(52,211,153,.18);animation:pulse 2s infinite}
  @keyframes pulse{50%{box-shadow:0 0 0 7px rgba(52,211,153,0)}}
  h1{font-size:38px;line-height:1.12;font-weight:800;letter-spacing:-.9px;color:#fff;margin:20px 0 14px}
  h1 em{font-style:normal;background:linear-gradient(90deg,#7DA2FF,#B794FF);-webkit-background-clip:text;background-clip:text;color:transparent}
  .lead{font-size:15px;line-height:1.6;color:#A9B6CF}
  .feats{list-style:none;margin-top:30px;display:flex;flex-direction:column;gap:14px}
  .feats li{display:flex;gap:14px;align-items:flex-start}
  .ic{flex-shrink:0;width:38px;height:38px;border-radius:11px;display:grid;place-items:center;
    background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#9CB6FF}
  .feats b{display:block;font-size:13.5px;color:#fff;font-weight:700}
  .feats span{display:block;font-size:12.5px;color:#93A1BC;margin-top:2px;line-height:1.45}
  .b-foot{font-size:11.5px;color:#7C8AA6}

  /* ── form side ── */
  .side{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px;gap:18px;
    background:#F3F5F9;background-image:radial-gradient(700px 420px at 100% 0%,rgba(47,107,255,.07),transparent 60%)}
  .card{width:min(100%,400px);background:#fff;border:1px solid #E6EAF1;border-radius:18px;padding:34px 32px 28px;
    box-shadow:0 1px 2px rgba(16,24,40,.04),0 18px 44px rgba(16,24,40,.09)}
  .card h2{font-size:22px;font-weight:800;letter-spacing:-.3px}
  .card .sub{font-size:13px;color:#5C6B86;margin-top:6px}
  label{display:block;font-size:12.5px;font-weight:600;margin:20px 0 7px}
  .field{position:relative}
  .field svg{position:absolute;left:13px;top:50%;transform:translateY(-50%);color:#8A96AB;pointer-events:none}
  .field input{width:100%;height:46px;font-size:14px;color:#1E2A44;background:#F6F8FB;border:1px solid #D5DBE7;border-radius:11px;
    padding:0 44px 0 40px;outline:none;font-family:inherit;transition:border-color .15s,box-shadow .15s,background .15s}
  .field input:focus{border-color:#2F6BFF;background:#fff;box-shadow:0 0 0 4px rgba(47,107,255,.14)}
  .eye{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:32px;height:32px;border:none;background:none;
    border-radius:8px;cursor:pointer;color:#8A96AB;display:grid;place-items:center}
  .eye:hover{color:#2F6BFF;background:#EEF3FF}
  .go{width:100%;height:48px;margin-top:26px;font-size:14.5px;font-weight:700;color:#fff;border:none;border-radius:12px;cursor:pointer;
    font-family:inherit;background:linear-gradient(135deg,#2F6BFF,#5B5BF7);box-shadow:0 8px 20px rgba(47,107,255,.28);
    display:flex;align-items:center;justify-content:center;gap:10px;transition:transform .12s,box-shadow .15s,filter .15s}
  .go:hover{filter:brightness(1.06);box-shadow:0 10px 24px rgba(47,107,255,.34)}
  .go:active{transform:translateY(1px)}
  .go:focus-visible{outline:2px solid #2F6BFF;outline-offset:3px}
  .go .spin{display:none;width:16px;height:16px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;animation:rot .7s linear infinite}
  .go.busy .spin{display:block}
  @keyframes rot{to{transform:rotate(360deg)}}
  .err{display:flex;gap:10px;align-items:flex-start;margin-top:18px;font-size:12.5px;color:#B42318;background:#FEF3F2;
    border:1px solid #FECDCA;border-radius:11px;padding:11px 13px}
  .note{display:flex;align-items:center;justify-content:center;gap:7px;margin-top:20px;font-size:11.5px;color:#8A96AB}
  .foot{font-size:12px;color:#8A96AB;text-align:center}
  .foot a{color:#2F6BFF;text-decoration:none;font-weight:600}
  .foot a:hover{text-decoration:underline}

  @media (max-width:900px){
    .wrap{grid-template-columns:1fr}
    .brand{padding:24px 22px 26px}
    .b-mid{padding:22px 0 0;margin:0}
    h1{font-size:26px;margin:14px 0 8px}
    .lead,.feats,.b-foot{display:none}
    .side{padding:28px 16px 36px}
  }
  @media (prefers-reduced-motion:reduce){.pill i,.go .spin{animation:none}}
</style>
</head>
<body>
<div class="wrap">
  <aside class="brand">
    <div class="b-top">
      <img src="/uploads/Kian-Joo-Logo.png" alt="Kian Joo Group">
      <div><b>Kian Joo VisionAI</b><span>Smart Factory · Safer People</span></div>
    </div>
    <div class="b-mid">
      <span class="pill"><i></i>AI Factory Monitoring</span>
      <h1>See your factory floor <em>in real time.</em></h1>
      <p class="lead">Attendance, safety and operations from your CCTV cameras, powered by SenseTime vision AI.</p>
      <ul class="feats">
        <li><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="10" r="3"/><path d="M7 18a5 5 0 0 1 10 0"/></svg></span>
          <div><b>Face-recognition attendance</b><span>Clock-in, clock-out and movement between cameras, automatically.</span></div></li>
        <li><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5"/><path d="M14 6a6 6 0 0 1 6 6v3"/><path d="M4 15v-3a6 6 0 0 1 6-6"/><rect x="2" y="15" width="20" height="4" rx="1"/></svg></span>
          <div><b>PPE &amp; safety monitoring</b><span>Helmet and vest checks, restricted areas, forklifts and cleaning.</span></div></li>
        <li><span class="ic"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 10 4.5-2.6a1 1 0 0 1 1.5.9v7.4a1 1 0 0 1-1.5.9L16 14"/><rect x="2" y="6" width="14" height="12" rx="2"/></svg></span>
          <div><b>Live camera monitoring</b><span>Live video, instant alerts and incident tracking in one place.</span></div></li>
      </ul>
    </div>
    <div class="b-foot">© Kian Joo Group · Powered by Weststar</div>
  </aside>

  <main class="side">
    <form class="card" method="post" action="/" id="lg-form">
      <h2>Welcome back</h2>
      <p class="sub">Sign in to the monitoring dashboard.</p>
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
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
      </div>
      <input type="hidden" name="__login" value="1">
      <button type="submit" class="go" id="lg-go"><span class="spin"></span><span class="lbl">Sign in</span></button>
      {ERR}
      <div class="note"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Role-based access · your session ends when you sign out</div>
    </form>
    <div class="foot"><a href="/">← Back to home</a></div>
  </main>
</div>
<script>
  (function(){
    var eye=document.getElementById('lg-eye'), pass=document.getElementById('lg-pass');
    eye.addEventListener('click',function(){ var show=pass.type==='password'; pass.type=show?'text':'password';
      eye.setAttribute('aria-label',show?'Hide password':'Show password'); eye.title=show?'Hide password':'Show password'; pass.focus(); });
    document.getElementById('lg-form').addEventListener('submit',function(){ var b=document.getElementById('lg-go');
      b.classList.add('busy'); b.querySelector('.lbl').textContent='Signing in…'; });
  })();
</script>
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
