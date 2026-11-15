/* Face check-in kiosk — behaviour for kiosk.php (no inline styles/scripts: hard rule).
 *
 * Visual state machine (#kiosk[data-state]):
 *   boot      → loading face models / starting the camera
 *   idle      → camera live, no face in view
 *   detected  → face in view; [data-fit="far"] = too small, otherwise the ring
 *               fills over STABLE frames ([data-prog] 0…3)
 *   matching  → descriptor posted to /api/kiosk/checkin, scanning arc spins
 *   success | duplicate | unknown | error → result panel, auto-resets to idle
 *               after RESULT_MS (tap "Try again" to dismiss early)
 *   enrol     → register mode; ring fills per captured sample
 *   offline | denied | fail → blocking panel with a retry action
 * API calls (/kiosk/config, /kiosk/checkin, /kiosk/enrol) and their payloads
 * are unchanged from the original kiosk.
 */
(() => {
  'use strict';
  // Server config arrives as a JSON data block (not executable) — see kiosk.php.
  const BOOT = JSON.parse((document.getElementById('kj-kiosk-boot') || {}).textContent || '{}');
  BOOT.locations = BOOT.locations || [];
  const MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/';
  const $ = (id) => document.getElementById(id);
  const root = $('kiosk'), video = $('video'), overlay = $('overlay'), hint = $('hint');
  const store = { get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
                  set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} } };

  if (window.KJIcon) KJIcon.hydrate(document);

  // ── state machine ──
  const RESULT_STATES = ['success', 'duplicate', 'unknown', 'error'];
  const BLOCK_STATES = ['offline', 'denied', 'fail'];
  const RESULT_MS = 4000;
  let state = 'boot', ready = false;
  const setState = (s, extra) => {
    state = s;
    root.dataset.state = s;
    root.dataset.prog = String((extra && extra.prog) || 0);
    root.dataset.fit = (extra && extra.fit) || '';
  };
  const showingResult = () => RESULT_STATES.includes(state);
  const blocked = () => BLOCK_STATES.includes(state);
  const say = (t) => { hint.textContent = t; };
  // Live (non-result) state; never overrides a result panel or a blocking panel.
  const live = (s, text, extra) => {
    if (showingResult() || blocked()) return;
    setState(s, extra); if (text) say(text);
  };

  // ── clock ──
  const greetOf = (h) => h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const tick = () => { const d = new Date();
    $('clock').textContent = d.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
    $('secs').textContent = String(d.getSeconds()).padStart(2, '0');
    $('date').textContent = d.toLocaleDateString('en-GB', {weekday:'long', day:'numeric', month:'long', year:'numeric'});
    $('greet').textContent = greetOf(d.getHours()); };
  tick(); setInterval(tick, 1000);

  // ── location + mode ──
  const locSel = $('loc');
  BOOT.locations.forEach(l => { const o = document.createElement('option'); o.value = o.textContent = l; locSel.appendChild(o); });
  locSel.value = store.get('kiosk-loc') || BOOT.locations[0] || '';
  const syncLoc = () => { $('locLabel').textContent = locSel.value || 'Kiosk'; };
  locSel.addEventListener('change', () => { store.set('kiosk-loc', locSel.value); syncLoc(); });
  syncLoc();
  const kioskId = () => (locSel.value || 'kiosk').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  let mode = 'checkin';
  const tabs = document.querySelectorAll('#modeTabs [data-mode]');
  tabs.forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.mode;
    tabs.forEach(x => { const on = x === b; x.classList.toggle('is-active', on); x.setAttribute('aria-selected', on ? 'true' : 'false'); });
    $('enrolCard').classList.toggle('kk-hide', mode !== 'enrol');
    root.classList.toggle('is-enrol', mode === 'enrol');
    if (!ready) return;
    if (mode === 'enrol') live('enrol', 'Register mode — fill in the form, then capture');
    else live('idle', 'Look at the camera to check in');
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

  // Corner brackets around the detected face (canvas pixels, mirrored with the video by CSS).
  const drawBox = (r) => {
    const ctx = overlay.getContext('2d');
    overlay.width = video.videoWidth; overlay.height = video.videoHeight;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!r) return;
    const b = r.detection.box, L = Math.min(b.width, b.height) * 0.22;
    ctx.lineWidth = Math.max(3, overlay.width / 220);
    ctx.lineCap = 'round';
    ctx.strokeStyle = b.width >= MIN_FACE ? '#34D399' : '#FBBF24';
    ctx.beginPath();
    [[b.x, b.y, 1, 1], [b.x + b.width, b.y, -1, 1], [b.x, b.y + b.height, 1, -1], [b.x + b.width, b.y + b.height, -1, -1]]
      .forEach(([x, y, sx, sy]) => { ctx.moveTo(x + sx * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy * L); });
    ctx.stroke();
  };

  // ── success animation (Lottie, with a CSS check fallback) ──
  let lot = null;
  const lottieBox = $('rLottie');
  if (window.lottie) {
    try {
      lot = lottie.loadAnimation({container: lottieBox, renderer: 'svg', loop: false, autoplay: false, path: '/assets/lottie/kiosk-success.json'});
      lot.addEventListener('DOMLoaded', () => root.classList.add('has-lottie'));
      lot.addEventListener('data_failed', () => { lot = null; root.classList.remove('has-lottie'); });
    } catch (e) { lot = null; }
  }
  const playSuccess = () => { if (lot) { try { lot.goToAndPlay(0, true); } catch (e) {} } };

  // ── result panel + log ──
  const KICK = {success: 'Checked in', duplicate: 'Already recorded', unknown: 'Not recognised', error: 'Check-in failed'};
  let resultT = null;
  // tone: 'success' | 'duplicate' | 'unknown' | 'error'
  const showResult = (tone, img, t1, t2, t3, kicker) => {
    if (blocked()) return;                               // offline / camera panels win
    $('rImg').src = img || ''; $('rImg').classList.toggle('kk-hide', !img);
    $('rKick').textContent = kicker || KICK[tone] || '';
    $('rT1').textContent = t1; $('rT2').textContent = t2 || ''; $('rT3').textContent = t3 || '';
    const el = $('result');
    el.classList.remove('is-in'); void el.offsetWidth;   // restart entry + timer animations
    setState(tone);
    el.classList.add('is-in');
    if (tone === 'success') playSuccess();
    clearTimeout(resultT); resultT = setTimeout(resetToLive, RESULT_MS);
  };
  const resetToLive = () => {
    clearTimeout(resultT); $('result').classList.remove('is-in');
    if (!showingResult()) return;
    if (mode === 'enrol') { setState('enrol'); say('Register mode — fill in the form, then capture'); }
    else { setState('idle'); say('Look at the camera to check in'); }
  };
  $('rRetry').addEventListener('click', () => { lastPost = 0; resetToLive(); });

  const logRow = (img, name, sub, tone, replay) => {
    const log = $('log'); const empty = log.querySelector('.kk-log-empty'); if (empty) empty.remove();
    const row = document.createElement('button'); row.type = 'button'; row.className = 'kj-list-item kk-row is-' + tone;
    const im = document.createElement('img'); im.className = 'kj-thumb kk-row-img'; im.src = img; im.alt = '';
    const box = document.createElement('div'); box.className = 'kj-list-main';
    const b = document.createElement('div'); b.className = 'kj-list-title kk-row-name';
    const dot = document.createElement('span'); dot.className = 'kk-dot';
    b.appendChild(dot); b.appendChild(document.createTextNode(name));
    const s = document.createElement('div'); s.className = 'kj-list-sub'; s.textContent = sub;
    box.appendChild(b); box.appendChild(s); row.appendChild(im); row.appendChild(box);
    row.addEventListener('click', () => { if (!blocked()) showResult.apply(null, replay); });
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
    setState('matching'); say('Checking…');
    api('/kiosk/checkin', {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({descriptor: Array.from(r.descriptor), kiosk: kioskId(), location: locSel.value, attrs, snapshot: snap})})
      .then(d => {
        if (!d || !d.ok) { showResult('error', snap, 'Check-in failed', (d && d.error) || 'Server error'); return; }
        const when = hhmm(d.time), al = attrLine(attrs);
        if (d.duplicate) {
          showResult('duplicate', snap, d.known ? ('Already checked in, ' + d.name) : 'Already recorded', 'at ' + when + ' · ' + locSel.value, al);
        } else if (d.known) {
          const args = ['success', snap, 'Welcome, ' + d.name, (d.staffId ? 'Staff ID ' + d.staffId + ' · ' : '') + 'checked in ' + when + ' · ' + locSel.value,
            al + ' · match ' + Math.round(d.similarity * 100) + '%'];
          showResult.apply(null, args);
          logRow(snap, d.name, when + ' · ' + (d.staffId || ''), 'success', args);
        } else {
          const args = ['unknown', snap, 'Face not registered', 'Recorded as unknown personnel at ' + when + ' — please see HR to register', al];
          showResult.apply(null, args);
          logRow(snap, 'Unknown #' + d.person_id, when, 'unknown', args);
        }
      })
      .catch(() => showResult('error', snap, 'Network error', 'The check-in was not recorded'))
      .finally(() => { busy = false; });
  };

  const loop = async () => {
    if (!busy && !enrolling && !blocked() && video.readyState >= 2) {
      let r = null;
      try { r = await detect(); } catch (e) { r = null; }
      drawBox(r);
      const good = r && r.detection.score >= 0.75 && r.detection.box.width >= MIN_FACE;
      if (mode === 'checkin') {
        if (!r) { stable = 0; live('idle', 'Look at the camera to check in'); }
        else if (!good) { stable = 0; live('detected', 'Step closer to the camera', {fit: 'far'}); }
        else if (++stable >= STABLE && Date.now() - lastPost > 5000 && navigator.onLine !== false) { stable = 0; checkin(r); }
        else if (!busy) live('detected', 'Hold still…', {prog: Math.min(stable, STABLE)});
      }
    }
    setTimeout(loop, 350);
  };

  // ── register (enrol) ──
  $('eGo').addEventListener('click', async () => {
    const name = $('eName').value.trim(), staff = $('eStaff').value.trim();
    if (!name || !staff) { $('eMsg').textContent = 'Full name and staff ID are required.'; return; }
    if (!ready || blocked()) { $('eMsg').textContent = 'The camera is not ready yet.'; return; }
    resetToLive();
    enrolling = true; $('eGo').disabled = true;
    const descs = []; let snap = null, tries = 0;
    $('eMsg').textContent = 'Capturing… look straight at the camera.';
    setState('enrol');
    while (descs.length < 3 && tries < 40 && !blocked()) {
      tries++;
      let r = null; try { r = await detect(); } catch (e) {}
      drawBox(r);
      if (r && r.detection.score >= 0.8 && r.detection.box.width >= MIN_FACE) {
        descs.push(Array.from(r.descriptor)); if (!snap) snap = snapshot();
        setState('enrol', {prog: descs.length});
        say('Sample ' + descs.length + ' of 3'); await new Promise(res => setTimeout(res, 450));
      } else { setState('enrol', {prog: descs.length, fit: 'far'}); say('Face the camera, closer'); await new Promise(res => setTimeout(res, 250)); }
    }
    if (blocked()) { $('eMsg').textContent = 'Capture interrupted — try again when the kiosk is ready.'; enrolling = false; $('eGo').disabled = false; return; }
    if (descs.length < 3) { $('eMsg').textContent = 'Could not get a clear face. Try again with better lighting.';
      showResult('error', snap, 'Registration incomplete', 'Could not get a clear face', 'Try again with better lighting', 'Register face');
      enrolling = false; $('eGo').disabled = false; return; }
    setState('matching'); say('Registering…');
    let d = null;
    try {
      d = await api('/kiosk/enrol', {method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({name, staff_id: staff, descriptors: descs, snapshot: snap})});
    } catch (e) { d = {ok: false, error: 'Network error — registration not saved'}; }
    if (d && d.ok) {
      $('eMsg').textContent = '✓ ' + d.name + ' (' + d.staffId + ') registered. ' + d.enrolled + ' faces enrolled.';
      showResult('success', snap, 'Registered: ' + d.name, 'Staff ID ' + d.staffId, 'They can now check in at any kiosk', 'Face registered');
      $('eName').value = ''; $('eStaff').value = '';
    } else {
      $('eMsg').textContent = '✗ ' + ((d && d.error) || 'Registration failed');
      showResult('error', snap, 'Registration failed', (d && d.error) || 'Registration failed', '', 'Register face');
    }
    enrolling = false; $('eGo').disabled = false;
  });

  // ── blocking states: offline / camera denied / library failure ──
  const BLOCK = {
    offline: {title: 'Kiosk offline', text: 'Check-ins are paused and will resume automatically when the connection is back.', btn: 'Retry now'},
    denied:  {title: 'Camera access needed', text: 'Allow camera access for this site in the browser settings, then tap Try again.', btn: 'Try again'},
    fail:    {title: 'Face recognition unavailable', text: '', btn: 'Reload kiosk'},
  };
  let blockRetry = null;
  const block = (kind, text, retry) => {
    const b = BLOCK[kind];
    $('bTitle').textContent = b.title; $('bText').textContent = text || b.text; $('bRetryLbl').textContent = b.btn;
    blockRetry = retry || (() => location.reload());
    clearTimeout(resultT); $('result').classList.remove('is-in');
    drawBox(null);
    setState(kind); say(b.title);
  };
  $('bRetry').addEventListener('click', () => { if (blockRetry) blockRetry(); });

  const setNet = (on) => {
    const n = $('net'); n.textContent = on ? 'Online' : 'Offline';
    n.classList.toggle('is-success', on); n.classList.toggle('is-danger', !on);
  };
  const goOnline = () => {
    setNet(true);
    if (state !== 'offline') return;
    if (ready) { setState(mode === 'enrol' ? 'enrol' : 'idle'); say(mode === 'enrol' ? 'Register mode — fill in the form, then capture' : 'Look at the camera to check in'); }
    else location.reload();   // went offline before the models loaded
  };
  window.addEventListener('offline', () => { setNet(false); if (!blocked()) block('offline', '', () => { if (navigator.onLine) goOnline(); }); });
  window.addEventListener('online', goOnline);

  // ── boot ──
  const startCamera = async () => {
    setState('boot'); say('Starting camera…');
    try {
      video.srcObject = await navigator.mediaDevices.getUserMedia({video: {facingMode: 'user', width: {ideal: 1280}, height: {ideal: 720}}, audio: false});
    } catch (e) {
      const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      block('denied', denied ? '' : 'No usable camera was found (' + ((e && e.name) || 'error') + '). Connect a camera, then tap Try again.', startCamera);
      return;
    }
    const go = () => {
      const first = !ready; ready = true;
      setState(mode === 'enrol' ? 'enrol' : 'idle');
      say(mode === 'enrol' ? 'Register mode — fill in the form, then capture' : 'Look at the camera to check in');
      if (first) loop();
    };
    if (video.readyState >= 2) go(); else video.addEventListener('loadeddata', go, {once: true});
  };

  (async () => {
    setNet(navigator.onLine !== false);
    api('/kiosk/config').then(c => {
      if (!c || !c.ok) { $('sys').textContent = (c && c.error) || 'Kiosk API unavailable'; return; }
      $('enrolTab').classList.toggle('kk-hide', !c.canEnrol);
      $('sys').textContent = c.enrolled + ' faces enrolled · signed in as ' + BOOT.user;
    }).catch(() => { $('sys').textContent = 'Kiosk API unavailable'; });
    if (!window.faceapi) {
      if (navigator.onLine === false) block('offline', 'The face library could not be downloaded. The kiosk will reload when the connection is back.', () => location.reload());
      else block('fail', 'Face library failed to load — check the internet connection.');
      return;
    }
    say('Loading face models…');
    try {
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODELS),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODELS),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODELS),
        faceapi.nets.ageGenderNet.loadFromUri(MODELS),
        faceapi.nets.faceExpressionNet.loadFromUri(MODELS),
      ]);
    } catch (e) { block('fail', 'Could not load face models — ' + (e && e.message || 'error')); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      block('denied', 'This browser cannot open the camera here. Use HTTPS and a current Chrome, Edge or Safari.', startCamera); return;
    }
    await startCamera();
  })();
})();
