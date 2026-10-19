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

header('Content-Type: text/html; charset=utf-8');
?><!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Check-in Kiosk — Kian Joo VisionAI</title>
<link rel="icon" type="image/png" href="/uploads/Kian-Joo-Logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>
  :root{--bg:#F3F5F9;--bg2:#FFFFFF;--bg3:#F6F8FB;--line:#E6EAF1;--line2:#D5DBE7;--text:#1E2A44;--text2:#5C6B86;--text3:#8A96AB;
    --brand:#2F6BFF;--accent:#F97316;--ok:#22C55E;--warn:#F59E0B;--crit:#EF4444;
    --shadow:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06)}
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{background:var(--bg);color:var(--text);font-family:'Inter',system-ui,sans-serif;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
  .wrap{min-height:100%;display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:18px;padding:18px;max-width:1500px;margin:0 auto}
  header{grid-column:1/-1;display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:var(--bg2);border:1px solid var(--line);
    border-radius:14px;padding:12px 18px;box-shadow:var(--shadow)}
  header img{height:36px;border-radius:8px;background:#fff;padding:4px 7px;border:1px solid var(--line)}
  .brand b{display:block;font-size:16px;font-weight:700}.brand span{font-size:11px;letter-spacing:.4px;color:var(--text3);font-weight:600}
  .clock{margin-left:auto;text-align:right}
  .clock b{font-size:26px;font-weight:700;display:block;letter-spacing:-.3px}
  .clock span{font-size:12px;color:var(--text3)}
  .stage{position:relative;background:#000;border:1px solid var(--line2);border-radius:18px;overflow:hidden;aspect-ratio:4/3;max-height:calc(100vh - 140px);width:100%;box-shadow:var(--shadow)}
  video,canvas.ov{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1)}
  .hint{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);background:rgba(255,255,255,.94);color:var(--text);border:1px solid var(--line);
    border-radius:999px;padding:10px 20px;font-size:14px;font-weight:600;white-space:nowrap;max-width:92%;overflow:hidden;text-overflow:ellipsis;
    box-shadow:0 8px 24px rgba(0,0,0,.25)}
  .result{position:absolute;inset:auto 18px 18px 18px;display:none;gap:16px;align-items:center;background:rgba(255,255,255,.97);color:var(--text);
    border:2px solid var(--ok);border-radius:16px;padding:16px 18px;box-shadow:0 12px 32px rgba(0,0,0,.3)}
  .result.show{display:flex}.result.unk{border-color:var(--warn)}.result.dup{border-color:var(--line2)}.result.err{border-color:var(--crit)}
  .result img{width:84px;height:84px;object-fit:cover;border-radius:12px;flex-shrink:0;transform:scaleX(-1)}
  .result .t1{font-size:22px;font-weight:700}.result .t2{font-size:13px;color:var(--text2);margin-top:3px}
  .result .t3{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:12px;color:var(--text3);margin-top:6px}
  aside{display:flex;flex-direction:column;gap:14px;min-width:0}
  .card{background:var(--bg2);border:1px solid var(--line);border-radius:14px;padding:15px 16px;display:flex;flex-direction:column;gap:10px;box-shadow:var(--shadow)}
  .lbl{font-size:11px;font-weight:700;letter-spacing:.5px;color:var(--text3)}
  select,input{width:100%;font-size:14px;color:var(--text);background:var(--bg3);border:1px solid var(--line2);border-radius:10px;padding:10px 12px;outline:none;font-family:inherit}
  select:focus,input:focus{border-color:var(--brand);background:#fff;box-shadow:0 0 0 3px rgba(47,107,255,.16)}
  .tabs{display:flex;gap:6px}
  .tabs button,.btn{flex:1;font-family:inherit;font-size:13px;font-weight:700;border-radius:10px;padding:10px 12px;cursor:pointer;border:1px solid var(--line2);background:var(--bg3);color:var(--text2)}
  .tabs button:hover,.btn:hover{border-color:var(--brand);color:var(--text)}
  .tabs button.on{background:var(--brand);border-color:var(--brand);color:#fff}
  .btn.primary{background:var(--brand);border-color:var(--brand);color:#fff}
  .btn.primary:hover{background:#1F55D6;color:#fff}
  .btn:disabled{opacity:.5;cursor:default}
  .tabs button:focus-visible,.btn:focus-visible,a.back:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
  .msg{font-size:12.5px;color:var(--text2);min-height:18px}
  .log{display:flex;flex-direction:column;gap:8px;max-height:46vh;overflow:auto}
  .row{display:flex;gap:10px;align-items:center;border-top:1px solid var(--line);padding-top:8px}
  .row img{width:40px;height:40px;border-radius:9px;object-fit:cover;transform:scaleX(-1);flex-shrink:0}
  .row b{font-size:13px;display:block}.row span{font-size:11px;color:var(--text3)}
  .dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
  a.back{color:var(--brand);font-size:12.5px;font-weight:600;text-decoration:none}
  a.back:hover{text-decoration:underline}
  .hide{display:none!important}
  @media (max-width:900px){.wrap{grid-template-columns:1fr}.stage{max-height:none}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <img src="/uploads/Kian-Joo-Logo.png" alt="Kian Joo Group">
    <div class="brand"><b>Face Check-in</b><span>KIAN JOO VISIONAI · ATTENDANCE KIOSK</span></div>
    <div class="clock"><b id="clock">--:--:--</b><span id="date"></span></div>
  </header>

  <div class="stage">
    <video id="video" autoplay muted playsinline></video>
    <canvas class="ov" id="overlay"></canvas>
    <div class="hint" id="hint">Loading face models…</div>
    <div class="result" id="result">
      <img id="rImg" alt="">
      <div><div class="t1" id="rT1"></div><div class="t2" id="rT2"></div><div class="t3" id="rT3"></div></div>
    </div>
  </div>

  <aside>
    <div class="card">
      <div class="lbl">KIOSK LOCATION</div>
      <select id="loc"></select>
      <div class="tabs" id="modeTabs">
        <button data-mode="checkin" class="on">Check-in</button>
        <button data-mode="enrol" id="enrolTab" class="hide">Register face</button>
      </div>
    </div>

    <div class="card hide" id="enrolCard">
      <div class="lbl">REGISTER AN EMPLOYEE</div>
      <input id="eName" placeholder="Full name" autocomplete="off">
      <input id="eStaff" placeholder="Staff ID, e.g. KJ-01234" autocomplete="off">
      <button class="btn primary" id="eGo">Capture face &amp; register</button>
      <div class="msg" id="eMsg">The employee looks straight at the camera. Three samples are taken.</div>
    </div>

    <div class="card">
      <div class="lbl">RECENT CHECK-INS · THIS KIOSK</div>
      <div class="log" id="log"><div class="msg">No check-ins yet.</div></div>
    </div>
    <div class="msg" id="sys"></div>
    <a class="back" href="/#attendance">← Back to the Attendance tab</a>
  </aside>
</div>

<script src="https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/dist/face-api.js"></script>
<script>
(() => {
  const BOOT = <?= $boot ?>;
  const MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/';
  const $ = (id) => document.getElementById(id);
  const video = $('video'), overlay = $('overlay'), hint = $('hint');
  const store = { get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
                  set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} } };

  // ── clock ──
  const tick = () => { const d = new Date();
    $('clock').textContent = d.toLocaleTimeString('en-GB');
    $('date').textContent = d.toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long', year:'numeric'}); };
  tick(); setInterval(tick, 1000);

  // ── location + mode ──
  const locSel = $('loc');
  BOOT.locations.forEach(l => { const o = document.createElement('option'); o.value = o.textContent = l; locSel.appendChild(o); });
  locSel.value = store.get('kiosk-loc') || BOOT.locations[0] || '';
  locSel.addEventListener('change', () => store.set('kiosk-loc', locSel.value));
  const kioskId = () => (locSel.value || 'kiosk').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  let mode = 'checkin';
  document.querySelectorAll('#modeTabs button').forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    document.querySelectorAll('#modeTabs button').forEach(x => x.classList.toggle('on', x === b));
    $('enrolCard').classList.toggle('hide', mode !== 'enrol');
    hint.textContent = mode === 'enrol' ? 'Register mode — fill in the form, then capture' : 'Look at the camera to check in';
  }));

  const api = (path, opt) => fetch(BOOT.api + path, Object.assign({credentials:'same-origin', cache:'no-store'}, opt || {}))
    .then(r => r.json().catch(() => ({ok:false, error:'HTTP ' + r.status})));

  // ── face helpers ──
  const detOpts = () => new faceapi.TinyFaceDetectorOptions({inputSize: 320, scoreThreshold: 0.6});
  const detect = () => faceapi.detectSingleFace(video, detOpts())
    .withFaceLandmarks().withFaceDescriptor().withAgeAndGender().withFaceExpressions();
  const attrsOf = (r) => { const ex = Object.entries(r.expressions || {}).sort((a, b) => b[1] - a[1])[0] || [];
    return {age: r.age, gender: r.gender, genderProb: r.genderProbability, expression: ex[0], expressionProb: ex[1], score: r.detection.score}; };
  const snapshot = () => { const c = document.createElement('canvas'); const w = 640;
    c.width = w; c.height = Math.round(w * video.videoHeight / video.videoWidth);
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.85); };
  const attrLine = (a) => [a.gender, a.age ? ('~' + Math.round(a.age) + ' yrs') : '', a.expression].filter(Boolean).join(' · ');
  const hhmm = (s) => String(s || '').slice(11, 16) || new Date().toTimeString().slice(0, 5);

  const drawBox = (r) => {
    const ctx = overlay.getContext('2d');
    overlay.width = video.videoWidth; overlay.height = video.videoHeight;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!r) return;
    const b = r.detection.box;
    ctx.lineWidth = Math.max(3, overlay.width / 200);
    ctx.strokeStyle = b.width >= MIN_FACE ? '#22C55E' : '#F5A524';
    ctx.strokeRect(b.x, b.y, b.width, b.height);
  };

  // ── result card + log ──
  let resultT = null;
  const showResult = (cls, img, t1, t2, t3) => {
    const el = $('result'); el.className = 'result show ' + cls;
    $('rImg').src = img || ''; $('rImg').classList.toggle('hide', !img);
    $('rT1').textContent = t1; $('rT2').textContent = t2 || ''; $('rT3').textContent = t3 || '';
    clearTimeout(resultT); resultT = setTimeout(() => { el.className = 'result'; }, 4000);
  };
  const logRow = (img, name, sub, col) => {
    const log = $('log'); if (log.firstChild && log.firstChild.classList && log.firstChild.classList.contains('msg')) log.innerHTML = '';
    const row = document.createElement('div'); row.className = 'row';
    const im = document.createElement('img'); im.src = img; im.alt = '';
    const box = document.createElement('div');
    const b = document.createElement('b'); const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = col;
    b.appendChild(dot); b.appendChild(document.createTextNode(name));
    const s = document.createElement('span'); s.textContent = sub;
    box.appendChild(b); box.appendChild(s); row.appendChild(im); row.appendChild(box);
    log.insertBefore(row, log.firstChild);
    while (log.children.length > 30) log.removeChild(log.lastChild);
  };

  // ── check-in loop ──
  const MIN_FACE = 110;     // face box width in video pixels
  const STABLE = 3;         // consecutive good frames before posting
  let busy = false, stable = 0, lastPost = 0, enrolling = false;

  const checkin = (r) => {
    busy = true; lastPost = Date.now();
    const snap = snapshot(), attrs = attrsOf(r);
    hint.textContent = 'Checking…';
    api('/kiosk/checkin', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({descriptor: Array.from(r.descriptor), kiosk: kioskId(), location: locSel.value, attrs, snapshot: snap})})
      .then(d => {
        if (!d || !d.ok) { showResult('err', snap, 'Check-in failed', (d && d.error) || 'Server error'); return; }
        const when = hhmm(d.time), al = attrLine(attrs);
        if (d.duplicate) {
          showResult('dup', snap, d.known ? ('Already checked in, ' + d.name) : 'Already recorded', 'at ' + when + ' · ' + locSel.value, al);
        } else if (d.known) {
          showResult('', snap, 'Welcome, ' + d.name, (d.staffId ? 'Staff ID ' + d.staffId + ' · ' : '') + 'checked in ' + when + ' · ' + locSel.value,
            al + ' · match ' + Math.round(d.similarity * 100) + '%');
          logRow(snap, d.name, when + ' · ' + (d.staffId || ''), '#22C55E');
        } else {
          showResult('unk', snap, 'Face not registered', 'Recorded as unknown personnel at ' + when + ' — please see HR to register', al);
          logRow(snap, 'Unknown #' + d.person_id, when, '#F5A524');
        }
      })
      .catch(() => showResult('err', snap, 'Network error', 'The check-in was not recorded'))
      .finally(() => { busy = false; });
  };

  const loop = async () => {
    if (!busy && !enrolling && video.readyState >= 2) {
      let r = null;
      try { r = await detect(); } catch (e) { r = null; }
      drawBox(r);
      const good = r && r.detection.score >= 0.75 && r.detection.box.width >= MIN_FACE;
      if (mode === 'checkin') {
        if (!r) { stable = 0; if (!$('result').classList.contains('show')) hint.textContent = 'Look at the camera to check in'; }
        else if (!good) { stable = 0; hint.textContent = 'Step closer to the camera'; }
        else if (++stable >= STABLE && Date.now() - lastPost > 5000) { stable = 0; checkin(r); }
        else if (!busy) hint.textContent = 'Hold still…';
      }
    }
    setTimeout(loop, 350);
  };

  // ── register (enrol) ──
  $('eGo').addEventListener('click', async () => {
    const name = $('eName').value.trim(), staff = $('eStaff').value.trim();
    if (!name || !staff) { $('eMsg').textContent = 'Full name and staff ID are required.'; return; }
    enrolling = true; $('eGo').disabled = true;
    const descs = []; let snap = null, tries = 0;
    $('eMsg').textContent = 'Capturing… look straight at the camera.';
    while (descs.length < 3 && tries < 40) {
      tries++;
      let r = null; try { r = await detect(); } catch (e) {}
      drawBox(r);
      if (r && r.detection.score >= 0.8 && r.detection.box.width >= MIN_FACE) {
        descs.push(Array.from(r.descriptor)); if (!snap) snap = snapshot();
        hint.textContent = 'Sample ' + descs.length + ' of 3'; await new Promise(res => setTimeout(res, 450));
      } else { hint.textContent = 'Face the camera, closer'; await new Promise(res => setTimeout(res, 250)); }
    }
    if (descs.length < 3) { $('eMsg').textContent = 'Could not get a clear face. Try again with better lighting.';
      enrolling = false; $('eGo').disabled = false; return; }
    const d = await api('/kiosk/enrol', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name, staff_id: staff, descriptors: descs, snapshot: snap})});
    if (d && d.ok) {
      $('eMsg').textContent = '✓ ' + d.name + ' (' + d.staffId + ') registered. ' + d.enrolled + ' faces enrolled.';
      showResult('', snap, 'Registered: ' + d.name, 'Staff ID ' + d.staffId, 'They can now check in at any kiosk');
      $('eName').value = ''; $('eStaff').value = '';
    } else {
      $('eMsg').textContent = '✗ ' + ((d && d.error) || 'Registration failed');
    }
    enrolling = false; $('eGo').disabled = false;
  });

  // ── boot ──
  (async () => {
    api('/kiosk/config').then(c => {
      if (!c || !c.ok) { $('sys').textContent = (c && c.error) || 'Kiosk API unavailable'; return; }
      $('enrolTab').classList.toggle('hide', !c.canEnrol);
      $('sys').textContent = c.enrolled + ' faces enrolled · signed in as ' + BOOT.user;
    });
    if (!window.faceapi) { hint.textContent = 'Face library failed to load — check the internet connection'; return; }
    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODELS),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODELS),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODELS),
        faceapi.nets.ageGenderNet.loadFromUri(MODELS),
        faceapi.nets.faceExpressionNet.loadFromUri(MODELS),
      ]);
    } catch (e) { hint.textContent = 'Could not load face models — ' + (e && e.message || 'error'); return; }
    hint.textContent = 'Starting camera…';
    try {
      video.srcObject = await navigator.mediaDevices.getUserMedia({video: {facingMode: 'user', width: {ideal: 1280}, height: {ideal: 720}}, audio: false});
    } catch (e) { hint.textContent = 'Camera unavailable — allow camera access for this site'; return; }
    video.addEventListener('loadeddata', () => { hint.textContent = 'Look at the camera to check in'; loop(); }, {once: true});
  })();
})();
</script>
</body>
</html>
