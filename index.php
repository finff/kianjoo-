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
  body{font-family:'Inter',system-ui,sans-serif;color:#1E2A44;-webkit-font-smoothing:antialiased;background:#F4F6FB}
  .wrap{min-height:100vh;display:grid;grid-template-columns:minmax(0,1.12fr) minmax(0,1fr)}

  /* ── brand panel ───────────────────────────── */
  .brand{position:relative;overflow:hidden;color:#E6ECF8;padding:40px 56px;display:flex;flex-direction:column;gap:28px;
    background:#070C1A;
    background-image:radial-gradient(1000px 600px at 115% -15%,rgba(79,130,255,.42),transparent 60%),
      radial-gradient(820px 640px at -20% 115%,rgba(139,92,246,.36),transparent 60%),
      radial-gradient(560px 380px at 55% 120%,rgba(14,165,233,.24),transparent 65%)}
  .brand::before{content:"";position:absolute;inset:0;pointer-events:none;
    background-image:linear-gradient(rgba(148,163,184,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(148,163,184,.07) 1px,transparent 1px);
    background-size:44px 44px;-webkit-mask-image:radial-gradient(ellipse at 40% 45%,#000 20%,transparent 75%);mask-image:radial-gradient(ellipse at 40% 45%,#000 20%,transparent 75%)}
  .brand>*{position:relative}
  .b-top{display:flex;align-items:center;gap:14px}
  .b-top img{height:42px;width:auto;background:#fff;border-radius:11px;padding:5px 8px;box-shadow:0 6px 18px rgba(0,0,0,.25)}
  .b-top b{display:block;font-size:16px;font-weight:800;color:#fff}
  .b-top span{display:block;font-size:11.5px;color:#93A3C2;margin-top:2px;letter-spacing:.2px}
  .pill{display:inline-flex;align-items:center;gap:8px;font-size:11.5px;font-weight:600;color:#C6D5FF;
    background:rgba(79,130,255,.14);border:1px solid rgba(79,130,255,.34);border-radius:999px;padding:6px 12px;backdrop-filter:blur(6px)}
  .pill i{width:7px;height:7px;border-radius:50%;background:#34D399;box-shadow:0 0 0 4px rgba(52,211,153,.18);animation:pulse 2s infinite}
  @keyframes pulse{50%{box-shadow:0 0 0 8px rgba(52,211,153,0)}}
  h1{font-size:40px;line-height:1.1;font-weight:800;letter-spacing:-1px;color:#fff;margin:18px 0 12px}
  h1 em{font-style:normal;background:linear-gradient(90deg,#7DA2FF,#C29BFF 60%,#7DD3FC);-webkit-background-clip:text;background-clip:text;color:transparent}
  .lead{font-size:15px;line-height:1.6;color:#A9B6CF;max-width:460px}

  /* product preview */
  .stage{position:relative;flex:1;min-height:300px;max-width:560px;width:100%}
  .win{position:absolute;inset:6% 10% 4% 0;border-radius:18px;overflow:hidden;
    background:linear-gradient(160deg,#121B33,#0B1226);border:1px solid rgba(255,255,255,.1);
    box-shadow:0 30px 70px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.06);animation:rise .9s ease-out both}
  .win-bar{height:34px;display:flex;align-items:center;gap:7px;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.07);font-size:11px;color:#8FA0C0}
  .win-bar i{width:9px;height:9px;border-radius:50%;background:#2A3553}
  .win-bar i:nth-child(1){background:#F87171}.win-bar i:nth-child(2){background:#FBBF24}.win-bar i:nth-child(3){background:#34D399}
  .win-bar span{margin-left:8px}
  .live{margin-left:auto;display:flex;align-items:center;gap:6px;color:#FCA5A5;font-weight:700;font-size:10px;letter-spacing:.6px}
  .live::before{content:"";width:7px;height:7px;border-radius:50%;background:#EF4444;animation:blink 1.4s infinite}
  @keyframes blink{50%{opacity:.25}}
  .scene{position:absolute;inset:34px 0 0 0;overflow:hidden;
    background:radial-gradient(120% 90% at 70% 15%,rgba(125,162,255,.18),transparent 55%),
      linear-gradient(180deg,#1A2440 0%,#141C33 55%,#10172B 100%)}
  .scene::before{content:"";position:absolute;left:0;right:0;bottom:0;height:42%;
    background:repeating-linear-gradient(90deg,rgba(255,255,255,.035) 0 2px,transparent 2px 60px),linear-gradient(180deg,#18213C,#0E152A);
    transform:perspective(300px) rotateX(48deg);transform-origin:bottom}
  .desk{position:absolute;bottom:22%;height:16%;border-radius:6px;background:linear-gradient(180deg,#25304F,#1A233F);box-shadow:0 8px 14px rgba(0,0,0,.35)}
  .person{position:absolute;bottom:20%;width:9%;height:44%;border-radius:40% 40% 12% 12%/22% 22% 12% 12%;
    background:linear-gradient(180deg,#5B6B92 0 18%,#3B4A73 18% 100%)}
  .person::before{content:"";position:absolute;left:50%;top:-22%;width:62%;aspect-ratio:1;transform:translateX(-50%);border-radius:50%;background:#6E7EA6}
  .box{position:absolute;border:2px solid #34D399;border-radius:6px;box-shadow:0 0 0 1px rgba(52,211,153,.25),0 0 18px rgba(52,211,153,.25)}
  .box b{position:absolute;left:-2px;top:-21px;font-size:9.5px;font-weight:700;letter-spacing:.3px;color:#052E1C;background:#34D399;border-radius:4px 4px 4px 0;padding:2px 6px;white-space:nowrap}
  .box.warn{border-color:#F97316;box-shadow:0 0 0 1px rgba(249,115,22,.25),0 0 18px rgba(249,115,22,.25)}
  .box.warn b{background:#F97316;color:#fff}
  .scan{position:absolute;left:0;right:0;height:70px;top:-70px;background:linear-gradient(180deg,transparent,rgba(125,162,255,.16),transparent);animation:scan 3.6s linear infinite}
  @keyframes scan{to{top:100%}}
  .chip{position:absolute;display:flex;align-items:center;gap:11px;padding:11px 14px;border-radius:14px;min-width:200px;
    background:rgba(16,24,48,.72);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
    box-shadow:0 18px 40px rgba(0,0,0,.4)}
  .chip .dot{flex-shrink:0;width:34px;height:34px;border-radius:10px;display:grid;place-items:center}
  .chip b{display:block;font-size:12.5px;color:#fff}
  .chip span{display:block;font-size:11px;color:#94A3C0;margin-top:2px}
  .c1{right:-2%;top:16%;animation:rise .9s .25s ease-out both, float 6s 1.2s ease-in-out infinite}
  .c2{left:-4%;bottom:10%;animation:rise .9s .45s ease-out both, float 7s 1.4s ease-in-out infinite reverse}
  .c3{right:2%;bottom:-2%;min-width:0;animation:rise .9s .65s ease-out both, float 6.5s 1.6s ease-in-out infinite}
  .bars{display:flex;align-items:flex-end;gap:4px;height:30px}
  .bars i{width:6px;border-radius:2px;background:linear-gradient(180deg,#7DA2FF,#5B5BF7)}
  @keyframes float{50%{transform:translateY(-8px)}}
  @keyframes rise{from{opacity:0;transform:translateY(16px)}}
  .b-foot{font-size:11.5px;color:#6F7E9C}

  /* ── form side ─────────────────────────────── */
  .side{position:relative;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px;gap:18px;
    background:#F4F6FB}
  .side::before,.side::after{content:"";position:absolute;border-radius:50%;filter:blur(60px);pointer-events:none}
  .side::before{width:360px;height:360px;right:-120px;top:-100px;background:rgba(47,107,255,.16)}
  .side::after{width:300px;height:300px;left:-110px;bottom:-110px;background:rgba(139,92,246,.13)}
  .card{position:relative;z-index:1;width:min(100%,410px);border-radius:22px;padding:36px 34px 28px;
    background:linear-gradient(#fff,#fff) padding-box,linear-gradient(140deg,rgba(47,107,255,.55),rgba(226,232,240,.9) 35%,rgba(226,232,240,.9) 65%,rgba(139,92,246,.5)) border-box;
    border:1px solid transparent;box-shadow:0 2px 4px rgba(16,24,40,.04),0 24px 60px rgba(30,42,90,.13);animation:rise .7s .1s ease-out both}
  .card .logo-sm{display:none;height:36px;width:auto;margin-bottom:16px}
  .card h2{font-size:24px;font-weight:800;letter-spacing:-.4px}
  .card .sub{font-size:13.5px;color:#5C6B86;margin-top:6px}
  label{display:block;font-size:12.5px;font-weight:600;margin:20px 0 7px;color:#334155}
  .field{position:relative}
  .field>svg{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:#94A3B8;pointer-events:none;transition:color .15s}
  .field input{width:100%;height:48px;font-size:14px;color:#1E2A44;background:#F7F9FC;border:1px solid #DCE2EC;border-radius:12px;
    padding:0 46px 0 42px;outline:none;font-family:inherit;transition:border-color .15s,box-shadow .15s,background .15s}
  .field input::placeholder{color:#A0AEC0}
  .field input:hover{border-color:#C7D0DE}
  .field input:focus{border-color:#2F6BFF;background:#fff;box-shadow:0 0 0 4px rgba(47,107,255,.13)}
  .field:focus-within>svg{color:#2F6BFF}
  .eye{position:absolute;right:8px;top:50%;transform:translateY(-50%);width:34px;height:34px;border:none;background:none;
    border-radius:9px;cursor:pointer;color:#94A3B8;display:grid;place-items:center;transition:color .15s,background .15s}
  .eye:hover{color:#2F6BFF;background:#EEF3FF}
  .eye .off{display:none}.eye.on .on{display:none}.eye.on .off{display:block}
  .go{position:relative;overflow:hidden;width:100%;height:50px;margin-top:26px;font-size:14.5px;font-weight:700;color:#fff;border:none;border-radius:13px;cursor:pointer;
    font-family:inherit;background:linear-gradient(135deg,#2F6BFF,#5B5BF7 55%,#8B5CF6);box-shadow:0 10px 24px rgba(47,107,255,.3);
    display:flex;align-items:center;justify-content:center;gap:10px;transition:transform .12s,box-shadow .2s,filter .2s}
  .go::after{content:"";position:absolute;top:0;bottom:0;width:40%;left:-60%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.28),transparent);transform:skewX(-20deg);transition:left .6s}
  .go:hover{box-shadow:0 14px 30px rgba(47,107,255,.38)}
  .go:hover::after{left:120%}
  .go:active{transform:translateY(1px)}
  .go:focus-visible{outline:2px solid #2F6BFF;outline-offset:3px}
  .go .arrow{transition:transform .2s}.go:hover .arrow{transform:translateX(3px)}
  .go .spin{display:none;width:16px;height:16px;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;border-radius:50%;animation:rot .7s linear infinite}
  .go.busy .spin{display:block}.go.busy .arrow{display:none}
  @keyframes rot{to{transform:rotate(360deg)}}
  .err{display:flex;gap:10px;align-items:flex-start;margin-top:18px;font-size:12.5px;color:#B42318;background:#FEF3F2;
    border:1px solid #FECDCA;border-radius:12px;padding:11px 13px;animation:shake .35s}
  @keyframes shake{25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
  .note{display:flex;align-items:center;justify-content:center;gap:7px;margin-top:22px;padding-top:18px;border-top:1px solid #EEF1F6;font-size:11.5px;color:#8A96AB}
  .foot{position:relative;z-index:1;font-size:12px;color:#8A96AB;text-align:center}
  .foot a{color:#2F6BFF;text-decoration:none;font-weight:600}
  .foot a:hover{text-decoration:underline}

  @media (max-width:1180px){.chip.c3{display:none}}
  @media (max-width:980px){
    .wrap{grid-template-columns:1fr}
    .brand{padding:22px 20px 24px;gap:0}
    .stage,.lead,.b-foot{display:none}
    h1{font-size:24px;margin:14px 0 0}
    .side{padding:26px 16px 36px}
  }
  @media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
</style>
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
          <div class="desk" style="left:8%;width:34%"></div>
          <div class="desk" style="left:58%;width:30%"></div>
          <div class="person" style="left:28%"></div>
          <div class="person" style="left:66%;height:38%;bottom:22%"></div>
          <div class="box" style="left:25.5%;bottom:18%;width:14%;height:56%"><b>FACE MATCH · 0.97</b></div>
          <div class="box warn" style="left:63.5%;bottom:20%;width:14%;height:50%"><b>NO VEST</b></div>
          <div class="scan"></div>
        </div>
      </div>
      <div class="chip c1">
        <span class="dot" style="background:rgba(52,211,153,.16);color:#34D399"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></span>
        <div><b>Clock-in recorded</b><span>Face recognised · on time</span></div>
      </div>
      <div class="chip c2">
        <span class="dot" style="background:rgba(249,115,22,.16);color:#FB923C"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 10V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v5"/><path d="M14 6a6 6 0 0 1 6 6v3"/><path d="M4 15v-3a6 6 0 0 1 6-6"/><rect x="2" y="15" width="20" height="4" rx="1"/></svg></span>
        <div><b>PPE alert</b><span>Safety vest missing · alert sent</span></div>
      </div>
      <div class="chip c3">
        <div class="bars"><i style="height:30%"></i><i style="height:55%"></i><i style="height:40%"></i><i style="height:75%"></i><i style="height:60%"></i><i style="height:90%"></i><i style="height:70%"></i></div>
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
<script>
  (function(){
    var eye=document.getElementById('lg-eye'), pass=document.getElementById('lg-pass');
    eye.addEventListener('click',function(){ var show=pass.type==='password'; pass.type=show?'text':'password';
      eye.classList.toggle('on',show); eye.setAttribute('aria-label',show?'Hide password':'Show password'); eye.title=show?'Hide password':'Show password'; pass.focus(); });
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
