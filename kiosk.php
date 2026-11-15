<?php
/**
 * Face check-in kiosk — open on a tablet / PC with a webcam at an entrance.
 *
 * Face detection, the 128-d face descriptor and the age / gender /
 * expression estimates run in the browser (face-api.js, models from
 * jsDelivr). Each stable face is posted to /api/kiosk/checkin, matched on
 * the server against enrolled faces, and logged with the time, kiosk
 * location, snapshot and attributes → it shows up on the Attendance tab.
 * "Register" mode (settings permission) enrols an employee's face.
 *
 * Requires a signed-in dashboard session (use a dedicated kiosk account).
 *
 * UI: assets/css/kiosk.css + assets/js/kiosk.js (kj-* design system).
 * No inline styles or scripts — the boot config is a JSON data block.
 */

declare(strict_types=1);

define('APP_ROOT', __DIR__);
$config = require APP_ROOT . '/config/config.php';
require_once APP_ROOT . '/lib/Auth.php';

$user = Auth::user();
if ($user === null) {
    header('Location: /?login');
    exit;
}
$boot = json_encode([
    'api'       => '/api',
    'user'      => $user['name'],
    'locations' => $config['poc']['locations'] ?? [],
], JSON_UNESCAPED_SLASHES | JSON_HEX_TAG);

// Cache-bust local assets with their mtime.
$asset = static function (string $path): string {
    $file = APP_ROOT . $path;
    return htmlspecialchars($path . (is_file($file) ? '?v=' . filemtime($file) : ''), ENT_QUOTES);
};

header('Content-Type: text/html; charset=utf-8');
?><!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0A1222">
<title>Check-in Kiosk — Kian Joo VisionAI</title>
<link rel="icon" type="image/png" href="/uploads/Kian-Joo-Logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="<?= $asset('/assets/css/kj-tokens.css') ?>">
<link rel="stylesheet" href="<?= $asset('/assets/css/kj-components.css') ?>">
<link rel="stylesheet" href="<?= $asset('/assets/css/kiosk.css') ?>">
</head>
<body class="kj-root kk-body">
<div class="kk" id="kiosk" data-state="boot">

  <!-- ── Top bar ── -->
  <header class="kk-top">
    <div class="kk-brand">
      <img class="kk-logo" src="/uploads/Kian-Joo-Logo.png" alt="Kian Joo Group">
      <div class="kk-brand-txt">
        <b>Kian Joo <span>VisionAI</span></b>
        <small>Face check-in kiosk</small>
      </div>
    </div>
    <div class="kk-top-meta">
      <span class="kj-chip kk-chip-loc"><i data-kj-icon="map-pin"></i><span id="locLabel">—</span></span>
      <span class="kj-chip kj-chip-dot is-success kk-net" id="net">Online</span>
    </div>
  </header>

  <!-- ── Camera stage ── -->
  <main class="kk-stage" id="stage" aria-live="polite">
    <video id="video" autoplay muted playsinline></video>
    <canvas class="kk-ov" id="overlay"></canvas>
    <div class="kk-vignette" aria-hidden="true"></div>

    <!-- Face guide ring: progress arc + scanning arc animate through the states -->
    <div class="kk-guide" aria-hidden="true">
      <svg class="kk-ring" viewBox="0 0 200 200">
        <circle class="kk-ring-track" cx="100" cy="100" r="94"></circle>
        <circle class="kk-ring-prog" id="ringProg" cx="100" cy="100" r="94"></circle>
        <circle class="kk-ring-scan" cx="100" cy="100" r="94"></circle>
      </svg>
      <span class="kk-ring-glow"></span>
      <span class="kk-scanline"></span>
    </div>

    <div class="kk-hint" id="hintWrap">
      <span class="kk-hint-dot"></span>
      <span id="hint">Loading face models…</span>
    </div>

    <!-- Result panel (success / duplicate / unknown / error) -->
    <section class="kk-result" id="result" role="status">
      <div class="kk-result-badge">
        <div class="kk-lottie" id="rLottie"></div>
        <svg class="kk-check" viewBox="0 0 52 52" aria-hidden="true"><path d="M14 27 l8 8 l16 -17"></path></svg>
        <i class="kk-result-ico" data-kj-icon="circle-alert"></i>
      </div>
      <div class="kk-result-main">
        <img id="rImg" class="kk-result-photo" alt="">
        <div class="kk-result-txt">
          <div class="kk-result-kicker" id="rKick"></div>
          <div class="kk-result-t1" id="rT1"></div>
          <div class="kk-result-t2" id="rT2"></div>
          <div class="kk-result-t3" id="rT3"></div>
        </div>
      </div>
      <div class="kk-result-guide" id="rGuide">
        <ul>
          <li>Face the camera straight on, about an arm’s length away</li>
          <li>Remove a mask, cap or dark glasses</li>
          <li>Make sure your face is well lit</li>
        </ul>
        <button type="button" class="kj-btn kj-btn-primary kj-btn-lg" id="rRetry"><i data-kj-icon="rotate-ccw"></i>Try again</button>
      </div>
      <div class="kk-result-timer"><span></span></div>
    </section>

    <!-- Blocking states: offline, camera denied, library/model failure -->
    <section class="kk-block" id="block">
      <div class="kk-block-ico">
        <i class="kk-ico-offline" data-kj-icon="wifi-off"></i>
        <i class="kk-ico-denied" data-kj-icon="camera-off"></i>
        <i class="kk-ico-fail" data-kj-icon="circle-alert"></i>
      </div>
      <h2 id="bTitle">Kiosk offline</h2>
      <p id="bText">Check-ins are paused until the connection comes back.</p>
      <button type="button" class="kj-btn kj-btn-primary kj-btn-lg" id="bRetry"><i data-kj-icon="refresh-cw"></i><span id="bRetryLbl">Try again</span></button>
    </section>
  </main>

  <!-- ── Side panel ── -->
  <aside class="kk-side">
    <section class="kk-clock">
      <div class="kk-greet" id="greet">Welcome</div>
      <div class="kk-time"><b id="clock">--:--</b><span id="secs">--</span></div>
      <div class="kk-date" id="date"></div>
    </section>

    <section class="kj-card kk-card">
      <label class="kj-label kk-lbl" for="loc">Kiosk location</label>
      <select class="kj-select kk-select" id="loc"></select>
      <div class="kj-tabs kk-tabs" id="modeTabs" role="tablist">
        <button type="button" class="kj-tab is-active" role="tab" aria-selected="true" data-mode="checkin"><i data-kj-icon="scan-face"></i>Check-in</button>
        <button type="button" class="kj-tab kk-hide" role="tab" aria-selected="false" data-mode="enrol" id="enrolTab"><i data-kj-icon="user-plus"></i>Register face</button>
      </div>
    </section>

    <section class="kj-card kk-card kk-hide" id="enrolCard">
      <div class="kk-lbl">Register an employee</div>
      <div class="kj-field">
        <label class="kj-label" for="eName">Full name</label>
        <input class="kj-input" id="eName" placeholder="Full name" autocomplete="off">
      </div>
      <div class="kj-field">
        <label class="kj-label" for="eStaff">Staff ID</label>
        <input class="kj-input" id="eStaff" placeholder="e.g. KJ-01234" autocomplete="off">
      </div>
      <button type="button" class="kj-btn kj-btn-primary kj-btn-lg kj-btn-block" id="eGo"><i data-kj-icon="scan-face"></i>Capture face &amp; register</button>
      <div class="kj-help kk-msg" id="eMsg">The employee looks straight at the camera. Three samples are taken.</div>
    </section>

    <section class="kj-card kk-card kk-card-log">
      <div class="kk-lbl kk-lbl-row"><span>Recent check-ins · this kiosk</span><i data-kj-icon="history"></i></div>
      <div class="kk-log" id="log">
        <div class="kk-log-empty"><i data-kj-icon="scan-face"></i><span>No check-ins yet. Faces will appear here.</span></div>
      </div>
    </section>

    <footer class="kk-foot">
      <p class="kk-privacy"><i data-kj-icon="shield-check"></i>Your face is used only to record attendance. A snapshot and the time are saved to your attendance record.</p>
      <div class="kk-foot-row">
        <span class="kk-sys" id="sys"></span>
        <a class="kj-btn kj-btn-ghost kj-btn-sm" href="/#attendance"><i data-kj-icon="arrow-left"></i>Attendance</a>
      </div>
    </footer>
  </aside>
</div>

<script src="<?= $asset('/assets/vendor/lucide/lucide.min.js') ?>"></script>
<script src="<?= $asset('/assets/js/kj-icons.js') ?>"></script>
<script src="<?= $asset('/assets/vendor/lottie/lottie_light.min.js') ?>"></script>
<script src="https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.js"></script>
<script type="application/json" id="kj-kiosk-boot"><?= $boot ?></script>
<script src="<?= $asset('/assets/js/kiosk.js') ?>"></script>
</body>
</html>
