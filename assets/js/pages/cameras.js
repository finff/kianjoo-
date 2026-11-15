/* Cameras hub — page module (assets/js/pages/cameras.js).
 * Owner: wave-2 M11 camera-wall agent.  Styles: assets/css/pages/cameras.css (injected below).
 * Absorbs legacy pages: camdash, live, cameras, camera.
 *
 * Tabs
 *   #cameras            Live wall (default, module-rendered; legacy #live lands here)
 *   #cameras/overview   legacy Camera Dashboard (#camdash)
 *   #cameras/floorplan  camera placement on floor plans (module-rendered; GET /api/floorplans …)
 *   #cameras/manage     legacy Camera Fleet (config / CRUD)
 *   #cameras/view/<s>   legacy single-camera page (#camera/<s>)
 *
 * Live video is NOT re-implemented here. Tiles render <video data-src data-cam [data-mirror]>
 * and app.js's 1 s mountVideos() loop plays them (direct HLS / go2rtc MP4 / RTSP relay,
 * stall watchdog, same-camera mirroring). Elements that leave the DOM are never seen by
 * mountVideos again, so this file tears their HLS / relay connections down itself
 * (killVideo on unmount, on tile media swap, and a sweeper for closed camera modals).
 * The KJModal 'camera' type is re-registered here with a live player + recent detections.
 */
(function () {
  'use strict';

  /* ── small helpers ───────────────────────────────────────────────────── */
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function ico(n, cls) { return window.KJIcon ? window.KJIcon.svg(n, cls) : ''; }
  function enc(v) { return encodeURIComponent(String(v == null ? '' : v)); }
  function spec(type, id) { return type + ':' + enc(id); }
  function up(v) { return String(v || '').toUpperCase(); }
  function low(v) { return String(v || '').trim().toLowerCase(); }
  function N(v) { return Number(v) || 0; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function clamp(v) { return Math.max(0, Math.min(100, Math.round(v * 100) / 100)); }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function toast(msg, tone) { if (window.KJModal && window.KJModal.toast) window.KJModal.toast(msg, tone); }
  function app() { return window.KJApp || (window.KJPages && window.KJPages.app && window.KJPages.app()) || null; }
  function tsOf(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    var t = Date.parse(String(v).replace(' ', 'T'));
    return isNaN(t) ? 0 : t;
  }
  function ago(v) {
    var t = tsOf(v); if (!t) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }

  // Same-origin API with the dashboard read token; session cookies carry the RBAC identity.
  function req(path, o) {
    o = o || {};
    var T = window.TMNS || {};
    var url = (T.api || '/api') + path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + enc(T.token || '');
    var init = { method: o.method || 'GET', cache: 'no-store', credentials: 'same-origin' };
    if (o.form) { init.method = 'POST'; init.body = o.form; }
    else if (o.json) { init.method = 'POST'; init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(o.json); }
    return fetch(url, init).then(function (r) {
      return Promise.resolve(r.json()).catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) {
        if (!d || d.ok === false) { var e = new Error((d && (d.error || d.msg)) || 'Request failed'); e.status = r.status; throw e; }
        return d;
      });
    });
  }

  /* ── stylesheet (cache-busted with the same ?v= index.php gave this script) ── */
  (function injectCss() {
    if (typeof document === 'undefined' || document.querySelector('link[data-kjc-css]')) return;
    var s = document.querySelector('script[src*="pages/cameras.js"]');
    var q = s ? (String(s.getAttribute('src')).split('?')[1] || '') : '';
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'assets/css/pages/cameras.css' + (q ? '?' + q : '');
    l.setAttribute('data-kjc-css', '');
    (document.head || document.documentElement).appendChild(l);
  })();

  /* ── Lottie empty states (vendored lottie_light, loaded on first use) ── */
  var lottieWait = null;
  function lottieLib() {
    if (window.lottie) return Promise.resolve(window.lottie);
    if (lottieWait) return lottieWait;
    lottieWait = new Promise(function (res) {
      var sc = document.createElement('script');
      sc.src = 'assets/vendor/lottie/lottie_light.min.js';
      sc.async = true;
      sc.onload = function () { res(window.lottie || null); };
      sc.onerror = function () { res(null); };
      document.head.appendChild(sc);
    });
    return lottieWait;
  }
  function lottieEmpty(o) {
    // o: {anim, icon, title, text, actions(html), error}
    return '<div class="kj-empty kjc-empty' + (o.error ? ' is-error' : '') + '">' +
      '<div class="kjc-lot" data-kjc-lottie="' + esc(o.anim || 'empty-box') + '"><span class="kjc-lot-fb kj-empty-ico">' + ico(o.icon || 'sparkles') + '</span><span class="kjc-lot-anim"></span></div>' +
      '<div class="kj-empty-title">' + esc(o.title || '') + '</div>' +
      (o.text ? '<div class="kj-empty-text">' + esc(o.text) + '</div>' : '') +
      (o.actions ? '<div class="kj-row-wrap kj-empty-actions">' + o.actions + '</div>' : '') + '</div>';
  }
  function hydrateLottie(root) {
    var boxes = root ? root.querySelectorAll('[data-kjc-lottie]') : [];
    if (!boxes.length) return;
    lottieLib().then(function (L) {
      if (!L) return;
      Array.prototype.forEach.call(boxes, function (b) {
        if (b._kjcAnim || !document.contains(b)) return;
        var file = b.getAttribute('data-kjc-lottie');
        try {
          var a = L.loadAnimation({ container: b.querySelector('.kjc-lot-anim'), renderer: 'svg', loop: file !== 'error-alert', autoplay: true,
            path: 'assets/lottie/' + file + '.json' });
          b._kjcAnim = a;
          a.addEventListener('DOMLoaded', function () { b.classList.add('has-lottie'); });
          a.addEventListener('data_failed', function () { b.classList.remove('has-lottie'); });
        } catch (e) { /* icon fallback stays */ }
      });
    });
  }
  function destroyLottie(root) {
    if (!root) return;
    Array.prototype.forEach.call(root.querySelectorAll('[data-kjc-lottie]'), function (b) {
      if (b._kjcAnim) { try { b._kjcAnim.destroy(); } catch (e) { /* ignore */ } b._kjcAnim = null; }
    });
  }

  /* ======================================================================
   * Video lifecycle — app.mountVideos() starts/plays <video data-src>; we stop them.
   * ==================================================================== */
  var TRACK = [];
  function killVideo(v) {
    var a = app();
    try { if (v._hls) { v._hls.destroy(); v._hls = null; } } catch (e) { /* ignore */ }
    try { if (v._relay && a && a.relayStop) a.relayStop(v); } catch (e) { /* ignore */ }
    try { if (v.srcObject) v.srcObject = null; } catch (e) { /* ignore */ }
    v._src = ''; v._mirror = '';
    if (v.getAttribute('src')) {
      v.removeAttribute('src');
      try { v.load(); } catch (e) { /* jsdom */ }
    }
  }
  function killIn(root) {
    if (!root) return;
    Array.prototype.forEach.call(root.querySelectorAll('video'), killVideo);
    destroyLottie(root);
  }
  function trackIn(root) {
    if (!root) return;
    Array.prototype.forEach.call(root.querySelectorAll('video[data-src]'), function (v) { if (TRACK.indexOf(v) < 0) TRACK.push(v); });
    startTicker();
  }
  function sweep() {
    TRACK = TRACK.filter(function (v) {
      if (document.contains(v)) return true;
      killVideo(v);
      return false;
    });
  }
  // Retry a stream (or an offline camera): forget the relay give-up, force a fresh
  // load on the next mountVideos pass, re-check the bridge, poll the feed now.
  function retryStream(stream) {
    var a = app();
    if (!a) return;
    if (stream && a._relayFail) delete a._relayFail[stream];
    Array.prototype.forEach.call(document.querySelectorAll('.kjc-vwrap video'), function (v) {
      var k = v.getAttribute('data-cam') || '';
      if (k === stream || k === 'kjm:' + stream) { killVideo(v); v.dataset.state = 'connecting'; }
    });
    Array.prototype.forEach.call(document.querySelectorAll('.kjc-tile[data-key="' + cssEsc(stream) + '"]'), function (t) {
      t.classList.add('is-retrying');
      setTimeout(function () { t.classList.remove('is-retrying'); }, 6000);
    });
    try { if (a.loadLive) a.loadLive(true, true); } catch (e) { /* ignore */ }
    try { if (a.fetchFeed) a.fetchFeed(); } catch (e) { /* ignore */ }
    try { if (a.mountVideos) a.mountVideos(); } catch (e) { /* ignore */ }
    toast('Reconnecting ' + (stream ? up(stream) : 'camera') + '…', 'success');
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  // Near-live JPEG frames for still-only cameras (the app's tickStills only runs on legacy pages).
  var STILL = {};
  function refreshStills() {
    var a = app();
    if (!a || (typeof document !== 'undefined' && document.hidden)) return;
    var imgs = document.querySelectorAll('img[data-kjc-still]');
    if (!imgs.length) return;
    var now = Date.now(), seen = {};
    Array.prototype.forEach.call(imgs, function (im) {
      var name = im.getAttribute('data-kjc-still');
      if (!name || seen[name]) return;
      seen[name] = 1;
      var s = STILL[name] || (STILL[name] = { busy: false, next: 0, fail: 0 });
      if (s.busy || now < s.next) return;
      s.busy = true; s.next = now + 2000;
      var url = a.liveApiUrl('/live/still?stream=' + enc(name) + '&t=' + now);
      var pre = new Image();
      pre.onload = function () {
        s.busy = false; s.fail = 0;
        Array.prototype.forEach.call(document.querySelectorAll('img[data-kjc-still="' + cssEsc(name) + '"]'), function (x) { x.src = url; });
      };
      pre.onerror = function () { s.busy = false; s.fail++; s.next = Date.now() + Math.min(30000, 2000 * s.fail); };
      pre.src = url;
    });
  }

  // One 1 s ticker: sweep orphaned videos, mirror <video data-state> into tile overlays, refresh stills.
  var tickT = null;
  function startTicker() { if (!tickT) tickT = setInterval(tick, 1000); }
  function tick() {
    sweep();
    Array.prototype.forEach.call(document.querySelectorAll('.kjc-vwrap'), function (w) {
      var v = w.querySelector('video');
      var s = (v && v.dataset.state) || 'connecting';
      if (v && w.parentNode && w.parentNode.classList && w.parentNode.classList.contains('kjc-mlive')) s = modalWatch(w, v, s);
      if (w.getAttribute('data-state') !== s) {
        w.setAttribute('data-state', s);
        var t = w.querySelector('.kjc-vover-txt');
        if (t) t.textContent = s === 'buffering' ? 'Buffering…' : 'Connecting…';
        if (w.parentNode && w.parentNode.classList && w.parentNode.classList.contains('kjc-mlive')) modalChip(w, s);
      }
      if (s === 'error') modalFallback(w);
    });
    refreshStills();
    if (S.sub === 'wall' && S.el) paintSync();
    if (!TRACK.length && !S.el && !document.querySelector('img[data-kjc-still]')) { clearInterval(tickT); tickT = null; }
  }

  // Camera modal player: no first frame within 20 s → stop the hung relay and show the
  // error overlay (Retry + snapshot). mountVideos' stall watchdog keeps re-trying by itself.
  var MODAL_WAIT_MS = 20000;
  function modalWatch(w, v, s) {
    if (s === 'live') { w._kjcSince = 0; return s; }
    if (s !== 'connecting') return s;
    if (!w._kjcSince) w._kjcSince = Date.now();
    if (Date.now() - w._kjcSince < MODAL_WAIT_MS) return s;
    w._kjcSince = 0;
    var a = app();
    try { if (v._relay && a && a.relayStop) a.relayStop(v); } catch (e) { /* ignore */ }
    v.dataset.state = 'error';
    return 'error';
  }
  function modalChip(w, s) {
    var chip = w.parentNode.querySelector('.kj-media-tag .kj-chip');
    if (!chip) return;
    var map = { live: ['Live', 'success'], buffering: ['Buffering', 'warn'], error: ['Stream error', 'danger'], connecting: ['Connecting…', 'warn'] };
    var x = map[s] || map.connecting;
    chip.className = 'kj-chip kj-chip-dot is-' + x[1];
    chip.textContent = x[0];
    if (s !== 'error') { var im = w.querySelector('img.kjc-mfall'); if (im) im.hidden = true; }
  }
  // Error state: newest still frame (camera snapshot) or the last detection image, tagged.
  function modalFallback(w) {
    var im = w.querySelector('img.kjc-mfall'), a = app();
    if (!im || !a) return;
    var name = im.getAttribute('data-kjc-fall') || '', now = Date.now();
    if (im._kjcNext && now < im._kjcNext) return;
    im._kjcNext = now + 3000;
    var setTag = function (txt) {
      var chip = w.parentNode && w.parentNode.querySelector('.kj-media-tag .kj-chip');
      if (chip) chip.textContent = txt;
    };
    var useLast = function () {
      var f = im.getAttribute('data-kjc-fallsrc');
      if (f) { if (im.getAttribute('src') !== f) im.src = f; im.hidden = false; setTag('Stream error · last detection'); }
    };
    var hasStill = false;
    try { hasStill = !!name && a.hasStill(name); } catch (e) { hasStill = false; }
    if (!hasStill) { useLast(); return; }
    var url = a.liveApiUrl('/live/still?stream=' + enc(name) + '&t=' + now);
    var pre = new Image();
    pre.onload = function () { if (w.getAttribute('data-state') !== 'error') return; im.src = url; im.hidden = false; setTag('Stream error · snapshot'); };
    pre.onerror = function () { if (w.getAttribute('data-state') === 'error' && im.hidden) useLast(); };
    pre.src = url;
  }

  // Global capture-phase click for retry buttons (works inside tiles that open modals, and inside modals).
  if (typeof document !== 'undefined') {
    document.addEventListener('click', function (ev) {
      var t = ev.target instanceof Element ? ev.target.closest('[data-kjc-retry]') : null;
      if (!t) return;
      ev.preventDefault(); ev.stopPropagation();
      retryStream(t.getAttribute('data-kjc-retry'));
    }, true);
  }

  /* ======================================================================
   * Camera model (shared by the wall, the floor plan pins and the modal)
   * ==================================================================== */
  function camPool(a) {
    var pool = [];
    try { pool = (a && a.livePool && a.livePool()) || []; } catch (e) { pool = []; }
    if (a && a.state && !a.state.demo) pool = pool.filter(function (c) { return c.stream || c.serial; });
    return pool;
  }
  function camModel(a, c) {
    var st = (a && a.state) || {};
    var stream = c.stream || '';
    var key = stream || low(c.id);
    var u = up(stream || c.id);
    var evs = (st.events || []).filter(function (e) { return up(e.camera) === u || (c.serial && up(e.camera) === up(c.serial)); });
    var locs = (st.appCfg && st.appCfg.cam_locations) || {};
    var zone = locs[low(stream)] || locs[stream] || (c.zone && c.zone !== '—' ? c.zone : '') || 'Unassigned';
    var online = c.online !== false;
    var vsrc = '', still = false;
    try { vsrc = (stream && online) ? a.videoSrc(stream) : ''; } catch (e) { vsrc = ''; }
    try { still = !vsrc && !!stream && online && a.hasStill(stream); } catch (e) { still = false; }
    var byCam = st.byCam || {};
    var count = byCam[u] != null ? N(byCam[u]) : evs.length;
    var last = evs.reduce(function (m, e) { var t = tsOf(e.ts); return t > m ? t : m; }, 0);
    var nob = false;
    try { nob = online && !!stream && a.notOnBridge(stream); } catch (e) { nob = false; }
    return {
      key: key, stream: stream, id: c.id || u, name: c.name || u, zone: zone, online: online, vsrc: vsrc, still: still,
      img: c.still ? null : (c.img || null), rtsp: low(c.rtsp), count: count, open: evs.filter(function (e) { return e.status === 'open'; }).length,
      last: last, notOnBridge: nob, serial: c.serial || '', direct: !!c.direct
    };
  }
  function findCam(a, id) {
    var k = low(id);
    if (!k) return null;
    var pool = camPool(a).concat(((a && a.state && a.state.fleet) || []));
    return pool.find(function (c) {
      return [c.stream, c.serial, c.did, c.id, c.name].some(function (x) { return x != null && low(x) === k; });
    }) || null;
  }

  /* ── page state (module-level; the host element is shared by wall + floor plan) ── */
  var S = {
    el: null, sub: '', app: null, fedAt: 0, handlers: null,
    // wall
    layout: lsGet('kjc.wall.layout', '3'), zone: lsGet('kjc.wall.zone', ''), health: 'all', page: 0,
    tiles: {}, gridMode: '', barSig: '', pagerSig: '', syncSig: '',
    // floor plan
    fp: null
  };
  if (window.KJPages && window.KJPages.on) window.KJPages.on('feed', function () { S.fedAt = Date.now(); });

  /* ======================================================================
   * LIVE WALL
   * ==================================================================== */
  var LAYOUTS = [['2', '2×2', 'grid-2x2', 4], ['3', '3×3', 'grid-3x3', 9], ['auto', 'Auto', 'layout-grid', 24]];
  function perPage() { var l = LAYOUTS.find(function (x) { return x[0] === S.layout; }) || LAYOUTS[1]; return l[3]; }

  function wallData(a) {
    var all = camPool(a).map(function (c) { return camModel(a, c); });
    var zones = {};
    all.forEach(function (t) { zones[t.zone] = (zones[t.zone] || 0) + 1; });
    if (S.zone && !zones[S.zone]) S.zone = '';
    var inZone = all.filter(function (t) { return !S.zone || t.zone === S.zone; });
    var on = inZone.filter(function (t) { return t.online; }).length;
    var shown = inZone.filter(function (t) { return S.health === 'all' || (S.health === 'online' ? t.online : !t.online); });
    var pp = perPage(), pages = Math.max(1, Math.ceil(shown.length / pp));
    if (S.page >= pages) S.page = pages - 1;
    var pageTiles = shown.slice(S.page * pp, S.page * pp + pp);
    // Same physical camera (RTSP) on two devices: the first tile pulls the stream, the rest mirror it.
    var primary = {};
    pageTiles.forEach(function (t) {
      t.mirror = '';
      if (!t.rtsp || !t.vsrc) return;
      if (primary[t.rtsp] && primary[t.rtsp] !== t.key) t.mirror = primary[t.rtsp];
      else primary[t.rtsp] = t.key;
    });
    return { all: all, zones: zones, inZone: inZone, online: on, offline: inZone.length - on, shown: shown, pages: pages, tiles: pageTiles };
  }

  function wallShell() {
    return '<div class="kj-page kjc-page kjc-wall">' +
      '<div class="kjc-bar"></div>' +
      '<div class="kjc-grid" data-layout="' + esc(S.layout) + '" aria-live="polite"></div>' +
      '<div class="kjc-pager"></div>' +
      '<div class="kjc-sync"></div>' +
      '</div>';
  }

  function barHtml(d) {
    var segs = LAYOUTS.map(function (l) {
      var on = S.layout === l[0];
      return '<button type="button" class="kjc-seg-btn' + (on ? ' is-active' : '') + '" data-kjc-act="layout" data-v="' + l[0] + '" aria-pressed="' + on + '">' + ico(l[2]) + '<span>' + l[1] + '</span></button>';
    }).join('');
    var hOn = S.health === 'online', hOff = S.health === 'offline';
    var zoneKeys = Object.keys(d.zones).sort(function (x, y) { return (x === 'Unassigned') - (y === 'Unassigned') || x.localeCompare(y); });
    var zones = (zoneKeys.length > 1 || S.zone) ? '<div class="kjc-zones" role="group" aria-label="Filter by zone"><span class="kjc-tool-lbl">' + ico('map-pin') + 'Zone</span>' +
      '<button type="button" class="kjc-zchip' + (!S.zone ? ' is-active' : '') + '" data-kjc-act="zone" data-v="">All zones<b>' + d.all.length + '</b></button>' +
      zoneKeys.map(function (z) {
        return '<button type="button" class="kjc-zchip' + (S.zone === z ? ' is-active' : '') + '" data-kjc-act="zone" data-v="' + esc(z) + '">' + esc(z) + '<b>' + d.zones[z] + '</b></button>';
      }).join('') + '</div>' : '';
    return '<div class="kj-page-head kjc-head">' +
        '<div class="kjc-title"><span class="kjc-title-ico">' + ico('cctv') + '</span><div><h2 class="kj-page-title">Camera wall</h2>' +
        '<p class="kj-page-sub">Live visibility across your factory · ' + plural(d.all.length, 'camera') + '</p></div></div>' +
        '<div class="kjc-tools">' +
          '<span class="kjc-tool-lbl">Layout</span><div class="kjc-seg" role="group" aria-label="Grid layout">' + segs + '</div>' +
          '<span class="kjc-divider" aria-hidden="true"></span>' +
          '<button type="button" class="kjc-hchip is-ok' + (hOn ? ' is-on' : '') + '" data-kjc-act="health" data-v="online" aria-pressed="' + hOn + '" title="Show online cameras only">' + ico('video') + '<span>' + d.online + ' online</span></button>' +
          '<button type="button" class="kjc-hchip ' + (d.offline ? 'is-bad' : 'is-zero') + (hOff ? ' is-on' : '') + '" data-kjc-act="health" data-v="offline" aria-pressed="' + hOff + '" title="Show offline cameras only">' + ico('video-off') + '<span>' + d.offline + ' offline</span></button>' +
          '<span class="kjc-divider" aria-hidden="true"></span>' +
          '<button type="button" class="kj-btn kj-btn-secondary kj-btn-icon" data-kjc-act="fullscreen" aria-label="Full screen" title="Full screen">' + ico('maximize') + '</button>' +
        '</div>' +
      '</div>' + zones;
  }

  function tileHead(t) {
    var evTone = t.open ? 'is-danger' : (t.count ? 'is-primary' : '');
    return '<button type="button" class="kjc-tile-name" data-kj-modal="' + esc(spec('camera', t.stream || t.key)) + '" title="' + esc(t.name) + '"><span class="kj-truncate">' + esc(t.name) + '</span></button>' +
      '<span class="kjc-live ' + (t.online ? 'is-on' : 'is-off') + '">' + (t.online ? 'Live' : 'Offline') + '</span>' +
      '<button type="button" class="kj-chip kjc-evchip ' + evTone + '" data-kj-modal="' + esc(spec('camera', t.stream || t.key)) + '" title="Detections in the last 24 h">' + esc(plural(t.count, 'event')) + '</button>' +
      (t.stream ? '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon kj-btn-sm kjc-tile-more" data-kj-nav="cameras/view/' + esc(enc(t.stream)) + '" aria-label="Camera settings for ' + esc(t.name) + '" title="Camera page & settings">' + ico('settings-2') + '</button>' : '');
  }

  function tileMedia(a, t) {
    if (!t.online) {
      return { sig: 'off', html: '<div class="kjc-off">' + ico('video-off', 'kjc-off-ico') +
        '<div class="kjc-off-title">Camera offline</div><div class="kjc-off-sub"><span class="kjc-spin"></span>Reconnecting…</div>' +
        '<button type="button" class="kjc-retry" data-kjc-retry="' + esc(t.stream || t.key) + '">' + ico('refresh-cw') + 'Retry connection</button></div>' };
    }
    if (t.vsrc) {
      return { sig: 'v|' + t.vsrc + '|' + t.mirror, html: '<div class="kjc-vwrap" data-state="connecting">' +
        '<video class="kjc-video" data-src="' + esc(t.vsrc) + '" data-cam="' + esc(t.key) + '"' + (t.mirror ? ' data-mirror="' + esc(t.mirror) + '"' : '') +
        (t.img ? ' poster="' + esc(t.img) + '"' : '') + ' muted playsinline autoplay></video>' +
        '<div class="kjc-vover kjc-vover-wait"><span class="kjc-spin"></span><span class="kjc-vover-txt">Connecting…</span></div>' +
        '<div class="kjc-vover kjc-vover-err">' + ico('wifi-off') + '<b>Stream interrupted</b>' +
        '<button type="button" class="kjc-retry" data-kjc-retry="' + esc(t.stream) + '">' + ico('refresh-cw') + 'Retry</button></div>' +
        (t.notOnBridge ? '<span class="kjc-mtag is-warn">Not on live bridge</span>' : '') + '</div>' };
    }
    if (t.still) {
      return { sig: 's|' + t.stream, html: '<img class="kjc-frame" data-kjc-still="' + esc(t.stream) + '" src="' + esc(a.liveApiUrl('/live/still?stream=' + enc(t.stream) + '&t=' + Date.now())) + '" alt="' + esc(t.name) + ' snapshot">' +
        '<span class="kjc-mtag">' + ico('image') + 'Snapshot · 2 s</span>' };
    }
    if (t.img) {
      return { sig: 'i|' + t.img, html: '<img class="kjc-frame" src="' + esc(t.img) + '" alt="' + esc(t.name) + ' last detection" loading="lazy">' +
        '<span class="kjc-mtag">' + ico('radar') + 'Last detection frame · no live source</span>' };
    }
    return { sig: 'none', html: '<div class="kjc-nosrc">' + ico('cctv', 'kjc-off-ico') + '<div class="kjc-off-title">No live source</div>' +
      '<div class="kjc-off-sub">Connect a live bridge or HLS source in Settings › Live Video.</div></div>' };
  }

  function tileFoot(t) {
    return '<span class="kjc-foot-item">' + ico('video') + '<span class="kj-truncate">' + esc(t.id) + '</span></span>' +
      '<span class="kjc-foot-item">' + ico('map-pin') + '<span class="kj-truncate">' + esc(t.zone) + '</span></span>' +
      '<span class="kjc-foot-item kjc-foot-time">' + ico('clock') + '<span class="kj-truncate">' + esc(t.last ? ago(t.last) : 'No detections') + '</span></span>';
  }

  function makeTile(t) {
    var el = document.createElement('article');
    el.className = 'kjc-tile';
    el.setAttribute('data-key', t.key);
    el.innerHTML = '<header class="kjc-tile-head"></header><div class="kjc-tile-media"></div><footer class="kjc-tile-foot"></footer>';
    return { el: el, head: el.children[0], media: el.children[1], foot: el.children[2], hs: '', ms: '', fs: '' };
  }
  function updateTile(a, rec, t) {
    rec.el.classList.toggle('is-offline', !t.online);
    rec.el.classList.toggle('has-alert', !!t.open);
    var hs = tileHead(t);
    if (hs !== rec.hs) { rec.head.innerHTML = hs; rec.hs = hs; }
    var m = tileMedia(a, t);
    if (m.sig !== rec.ms) {
      killIn(rec.media);
      rec.media.innerHTML = m.html;
      rec.ms = m.sig;
      rec.media.setAttribute('data-kj-modal', spec('camera', t.stream || t.key));
      rec.media.setAttribute('aria-label', 'Open ' + t.name);
      trackIn(rec.media);
    }
    var fs = tileFoot(t);
    if (fs !== rec.fs) { rec.foot.innerHTML = fs; rec.fs = fs; }
  }

  function setGridMode(grid, mode) {
    if (S.gridMode === mode) return false;
    killIn(grid);
    grid.innerHTML = '';
    S.tiles = {};
    S.gridMode = mode;
    return true;
  }

  function paintWall() {
    var el = S.el, a = S.app;
    if (!el || S.sub !== 'wall' || !a) return;
    var bar = el.querySelector('.kjc-bar'), grid = el.querySelector('.kjc-grid'), pager = el.querySelector('.kjc-pager');
    if (!bar || !grid) return;
    var st = a.state || {};
    var waiting = !st.demo && !S.fedAt && !(st.fleet || []).length;
    var d = wallData(a);
    var bs = barHtml(d);
    if (bs !== S.barSig) { bar.innerHTML = bs; S.barSig = bs; }
    grid.setAttribute('data-layout', S.layout);

    if (waiting && !d.all.length) {
      if (setGridMode(grid, 'skel')) {
        var sk = '';
        for (var i = 0; i < Math.min(perPage(), 8); i++) {
          sk += '<div class="kjc-tile kjc-tile-skel" aria-hidden="true"><div class="kjc-tile-head"><span class="kj-skel kj-skel-line is-mid"></span></div>' +
            '<div class="kjc-tile-media"><span class="kj-skel kj-skel-block"></span></div><div class="kjc-tile-foot"><span class="kj-skel kj-skel-line is-short"></span></div></div>';
        }
        grid.innerHTML = sk;
      }
    } else if (!d.tiles.length) {
      var filtered = d.all.length > 0;
      var mode = 'empty:' + (filtered ? 'f' : 'n');
      if (setGridMode(grid, mode)) {
        grid.innerHTML = filtered
          ? lottieEmpty({ anim: 'empty-box', icon: 'filter-x', title: 'No cameras match this filter',
              text: 'Try another zone or clear the health filter.',
              actions: '<button type="button" class="kj-btn kj-btn-primary" data-kjc-act="clear">' + ico('rotate-ccw') + '<span>Show all cameras</span></button>' })
          : lottieEmpty({ anim: 'empty-box', icon: 'cctv', title: 'No cameras on the wall yet',
              text: 'Register a camera with a live source, or un-hide cameras from Manage, and it appears here.',
              actions: window.KJPages.h.actionBtn({ label: 'Manage cameras', path: 'cameras/manage', icon: 'settings-2', primary: true }) +
                (window.KJPages.can('settings') ? window.KJPages.h.actionBtn({ label: 'Live video settings', path: 'settings', icon: 'radio' }) : '') });
        hydrateLottie(grid);
      }
    } else {
      setGridMode(grid, 'tiles');
      var keep = {};
      d.tiles.forEach(function (t, i) {
        var rec = S.tiles[t.key];
        if (!rec) { rec = makeTile(t); S.tiles[t.key] = rec; }
        updateTile(a, rec, t);
        keep[t.key] = 1;
        if (grid.children[i] !== rec.el) {
          grid.insertBefore(rec.el, grid.children[i] || null);
          // A moved <video> is paused by the browser; nudge it (mountVideos keeps its source).
          Array.prototype.forEach.call(rec.el.querySelectorAll('video'), function (v) { try { var p = v.play && v.play(); if (p && p.catch) p.catch(function () {}); } catch (e) { /* ignore */ } });
        }
      });
      Object.keys(S.tiles).forEach(function (k) {
        if (keep[k]) return;
        var r = S.tiles[k];
        killIn(r.el);
        if (r.el.parentNode) r.el.parentNode.removeChild(r.el);
        delete S.tiles[k];
      });
    }

    var from = d.shown.length ? S.page * perPage() + 1 : 0, to = Math.min(d.shown.length, (S.page + 1) * perPage());
    var ps = d.pages > 1 ? '<span class="kjc-pager-txt">Showing ' + from + '–' + to + ' of ' + d.shown.length + ' cameras</span>' +
      '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-kjc-act="page" data-v="-1"' + (S.page <= 0 ? ' disabled' : '') + '>' + ico('chevron-left') + '<span>Previous</span></button>' +
      '<span class="kjc-pager-num">' + (S.page + 1) + ' / ' + d.pages + '</span>' +
      '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-kjc-act="page" data-v="1"' + (S.page >= d.pages - 1 ? ' disabled' : '') + '><span>Next</span>' + ico('chevron-right') + '</button>' : '';
    if (ps !== S.pagerSig) { pager.innerHTML = ps; pager.classList.toggle('is-on', !!ps); S.pagerSig = ps; }
    paintSync();
    try { a.mountVideos(); } catch (e) { /* ignore */ }
  }

  // Status strip under the wall (secured / last synced / bridge) — refreshed by the 1 s ticker.
  function paintSync() {
    var el = S.el, a = S.app;
    var box = el && el.querySelector('.kjc-sync');
    if (!box || !a) return;
    var st = a.state || {}, lb = st.liveBridge;
    var bridge = st.demo ? ['flask-conical', 'Demo data', 'is-warn']
      : (Object.keys(st.liveDirect || {}).length || st.liveBase) ? (lb && lb.reachable === false ? ['radio', 'Live bridge unreachable', 'is-bad'] : ['radio', 'Live bridge connected', 'is-ok'])
      : ((st.liveRelay || []).length || (st.liveStill || []).length) ? ['radio', 'Server relay / snapshots', 'is-ok'] : ['radio', 'No live bridge configured', 'is-warn'];
    var synced = S.fedAt ? 'Last synced ' + ago(S.fedAt) : (st.demo ? 'Showing demo cameras' : 'Waiting for the first sync…');
    var html = '<span class="kjc-sync-item">' + ico('lock') + 'RTSP streams secured</span>' +
      '<span class="kjc-sync-item is-ok">' + ico('circle-check') + esc(synced) + '</span>' +
      '<span class="kjc-sync-item ' + bridge[2] + '">' + ico(bridge[0]) + esc(bridge[1]) + '</span>' +
      '<span class="kj-spacer"></span>' +
      '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kj-nav="cameras/floorplan">' + ico('map-pinned') + '<span>Floor plan</span></button>' +
      '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kj-nav="cameras/manage">' + ico('settings-2') + '<span>Manage cameras</span></button>';
    if (html !== S.syncSig) { box.innerHTML = html; S.syncSig = html; }
  }

  function mountWall(el, a) {
    S.tiles = {}; S.gridMode = ''; S.barSig = ''; S.pagerSig = ''; S.syncSig = '';
    el.innerHTML = wallShell();
    paintWall();
    try { if (a.loadLive) a.loadLive(false); } catch (e) { /* ignore */ }
    try { if (!(a.state && a.state.appCfg) && a.loadApp) a.loadApp(); } catch (e) { /* zones fall back to device type */ }
    if (!S.fedAt && a.state && !a.state.demo && a.fetchFeed) { try { a.fetchFeed(); } catch (e) { /* poll catches up */ } }
  }

  function wallAction(act, v, btn) {
    if (act === 'layout') { S.layout = v; S.page = 0; lsSet('kjc.wall.layout', v); paintWall(); }
    else if (act === 'zone') { S.zone = v; S.page = 0; lsSet('kjc.wall.zone', v); paintWall(); }
    else if (act === 'health') { S.health = S.health === v ? 'all' : v; S.page = 0; paintWall(); }
    else if (act === 'clear') { S.health = 'all'; S.zone = ''; S.page = 0; lsSet('kjc.wall.zone', ''); paintWall(); }
    else if (act === 'page') { S.page = Math.max(0, S.page + N(v)); paintWall(); }
    else if (act === 'fullscreen') {
      var w = S.el && S.el.querySelector('.kjc-wall');
      if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) { /* ignore */ } }
      else if (w && w.requestFullscreen) { try { var p = w.requestFullscreen(); if (p && p.catch) p.catch(function () {}); } catch (e) { /* ignore */ } }
      else toast('Full screen is not available in this browser', 'warn');
    }
  }

  /* ======================================================================
   * FLOOR PLAN — camera placement (management view; trails live in #movement)
   * ==================================================================== */
  function fpState() {
    if (!S.fp) S.fp = { plans: null, can: false, sel: N(lsGet('kjc.fp.sel', '0')), edit: false, cams: null, err: '', busy: false, placing: '', drag: null };
    return S.fp;
  }
  function curPlan() {
    var f = fpState();
    return (f.plans || []).find(function (p) { return p.id === f.sel; }) || (f.plans || [])[0] || null;
  }
  function loadPlans(keepSel) {
    var f = fpState();
    f.err = '';
    return req('/floorplans').then(function (d) {
      f.plans = (d.floorplans || []).slice().sort(function (x, y) { return N(x.sort_order) - N(y.sort_order) || N(x.id) - N(y.id); });
      f.can = !!d.can_manage;
      if (!f.can) f.edit = false;
      if (!f.plans.some(function (p) { return p.id === f.sel; })) f.sel = f.plans.length ? f.plans[0].id : 0;
      if (keepSel != null && f.plans.some(function (p) { return p.id === keepSel; })) f.sel = keepSel;
      if (f.can && !f.cams) loadCatalog();
      paintFp();
    }).catch(function (e) {
      f.err = (e && e.message) || 'Could not load floor plans';
      if (f.plans == null) f.plans = [];
      paintFp();
    });
  }
  function loadCatalog() {
    var f = fpState();
    return req('/floorplans/cameras').then(function (d) { f.cams = d.cameras || []; paintFp(); })
      .catch(function () { f.cams = f.cams || []; });
  }

  // Camera status for pins: the live wall model first, then the catalog's own flag.
  function statusIndex() {
    var a = S.app, idx = {};
    camPool(a).forEach(function (c) { var m = camModel(a, c); if (m.stream) idx[low(m.stream)] = m; if (m.serial) idx[low(m.serial)] = idx[low(m.serial)] || m; });
    return idx;
  }
  function pinTone(p, idx, cat) {
    if (p.camera_known === false) return 'is-missing';
    var m = idx[low(p.camera_id)];
    if (m) return m.online ? (m.open ? 'is-alert' : 'is-on') : 'is-off';
    var c = (cat || []).find(function (x) { return low(x.id) === low(p.camera_id); });
    if (c && c.online === false) return 'is-off';
    if (c && c.online) return 'is-on';
    return 'is-unknown';
  }

  function fpHead(f) {
    var plan = curPlan();
    var tools = '<button type="button" class="kj-btn kj-btn-secondary" data-kj-nav="cameras/wall">' + ico('cctv') + '<span>Live wall</span></button>' +
      '<button type="button" class="kj-btn kj-btn-secondary" data-kj-nav="movement">' + ico('route') + '<span>Movement playback</span></button>';
    if (f.can) {
      tools += '<button type="button" class="kj-btn kj-btn-secondary" data-kjc-act="upload"' + (f.busy ? ' disabled' : '') + '>' + ico('upload') + '<span>Upload floor plan</span></button>';
      if (plan) tools += '<button type="button" class="kj-btn ' + (f.edit ? 'kj-btn-primary' : 'kj-btn-soft') + '" data-kjc-act="edit" aria-pressed="' + f.edit + '">' + ico(f.edit ? 'check' : 'move') + '<span>' + (f.edit ? 'Done editing' : 'Edit camera positions') + '</span></button>';
    }
    return '<div class="kj-page-head kjc-head"><div class="kjc-title"><span class="kjc-title-ico">' + ico('map-pinned') + '</span><div>' +
      '<h2 class="kj-page-title">Floor plan</h2><p class="kj-page-sub">Camera placement on factory floor plans' + (f.can ? '' : ' · view only') + '</p></div></div>' +
      '<div class="kjc-tools">' + tools + '</div></div>';
  }

  function fpTabs(f) {
    if (!f.plans || f.plans.length < 1) return '';
    return '<div class="kjc-fp-tabs" role="tablist" aria-label="Floor plans">' + f.plans.map(function (p) {
      var on = p.id === (curPlan() || {}).id;
      return '<button type="button" role="tab" aria-selected="' + on + '" class="kjc-fp-tab' + (on ? ' is-active' : '') + '" data-kjc-act="plan" data-v="' + p.id + '">' +
        ico('layers') + '<span>' + esc(p.name) + '</span><b>' + (p.pins || []).length + '</b>' + (p.active ? '' : '<span class="kj-chip is-warn">Hidden</span>') + '</button>';
    }).join('') + '</div>';
  }

  function pinHtml(p, tone, edit) {
    var cam = p.camera_id;
    var open = !edit && cam ? ' data-kj-modal="' + esc(spec('camera', cam)) + '"' : '';
    return '<div class="kjc-pin ' + tone + (edit ? ' is-edit' : '') + '" data-pin="' + p.id + '" data-x="' + N(p.x_pct) + '" data-y="' + N(p.y_pct) + '">' +
      '<button type="button" class="kjc-pin-dot"' + open + ' aria-label="' + esc(p.label + (p.location ? ' · ' + p.location : '')) + '" title="' + esc(p.label + (p.location ? ' · ' + p.location : '')) + '">' + ico('cctv') + '</button>' +
      '<span class="kjc-pin-lbl">' + esc(p.label) + '</span>' +
      (edit ? '<button type="button" class="kjc-pin-x" data-kjc-act="unpin" data-v="' + p.id + '" aria-label="Remove ' + esc(p.label) + ' from this plan" title="Remove from plan">' + ico('x') + '</button>' : '') +
      '</div>';
  }

  function fpSide(f, plan, idx) {
    var pins = (plan && plan.pins) || [];
    if (!f.edit) {
      var on = 0, off = 0;
      var rows = pins.map(function (p) {
        var tone = pinTone(p, idx, f.cams);
        if (tone === 'is-on' || tone === 'is-alert') on++; else if (tone === 'is-off') off++;
        var tag = p.camera_id ? 'button type="button" data-kj-modal="' + esc(spec('camera', p.camera_id)) + '"' : 'div';
        return '<' + tag + ' class="kj-list-item kjc-fp-row"><span class="kjc-dot ' + tone + '"></span><div class="kj-list-main">' +
          '<div class="kj-list-title kj-truncate">' + esc(p.label) + '</div><div class="kj-list-sub kj-truncate">' + esc(p.location || (p.camera_id ? up(p.camera_id) : '')) + '</div></div>' +
          ico('chevron-right') + '</' + (p.camera_id ? 'button' : 'div') + '>';
      }).join('');
      var unplaced = (f.cams || []).filter(function (c) { return !(c.pins || []).length; }).length;
      return '<div class="kj-card-head"><div class="kj-card-title">Cameras on this plan</div><span class="kj-chip">' + pins.length + '</span></div>' +
        '<div class="kjc-fp-stats"><span class="kjc-hchip is-ok">' + ico('video') + on + ' online</span><span class="kjc-hchip ' + (off ? 'is-bad' : 'is-zero') + '">' + ico('video-off') + off + ' offline</span></div>' +
        (rows ? '<div class="kj-list kjc-fp-list">' + rows + '</div>'
          : '<div class="kjc-fp-none">' + ico('map-pin-off') + '<span>No cameras placed on this plan yet.</span>' +
            (f.can ? '<button type="button" class="kj-btn kj-btn-primary kj-btn-sm" data-kjc-act="edit">' + ico('move') + '<span>Place cameras</span></button>' : '') + '</div>') +
        (f.can && unplaced ? '<button type="button" class="kjc-fp-note" data-kjc-act="edit">' + ico('info') + '<span>' + plural(unplaced, 'camera') + ' not placed on any floor plan</span>' + ico('chevron-right') + '</button>' : '');
    }
    // edit mode: camera palette + plan settings
    var onPlan = {};
    pins.forEach(function (p) { onPlan[low(p.camera_id)] = p; });
    var cams = f.cams;
    var pal = cams == null ? '<div class="kjc-fp-pal-skel"><span class="kj-skel kj-skel-line"></span><span class="kj-skel kj-skel-line is-mid"></span><span class="kj-skel kj-skel-line"></span></div>'
      : !cams.length ? '<div class="kjc-fp-none">' + ico('cctv') + '<span>No cameras in the catalog. Add cameras in Manage or Settings › Live Video.</span></div>'
      : '<div class="kj-list kjc-fp-pal">' + cams.map(function (c) {
          var p = onPlan[low(c.id)], placing = f.placing === c.id;
          var tone = c.online === false ? 'is-off' : (c.online ? 'is-on' : 'is-unknown');
          return '<div class="kj-list-item kjc-fp-cam' + (placing ? ' is-placing' : '') + (p ? ' is-placed' : '') + '" draggable="true" data-cam="' + esc(c.id) + '">' +
            '<span class="kjc-grip" aria-hidden="true">' + ico('grip-vertical') + '</span><span class="kjc-dot ' + tone + '"></span>' +
            '<div class="kj-list-main"><div class="kj-list-title kj-truncate">' + esc(c.name || up(c.id)) + '</div>' +
            '<div class="kj-list-sub kj-truncate">' + esc([c.location, (c.pins || []).length ? 'on ' + plural((c.pins || []).length, 'plan') : 'not placed'].filter(Boolean).join(' · ')) + '</div></div>' +
            (p ? '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kjc-act="unpin" data-v="' + p.id + '" title="Remove from this plan">' + ico('trash-2') + '</button>'
               : '<button type="button" class="kj-btn ' + (placing ? 'kj-btn-primary' : 'kj-btn-secondary') + ' kj-btn-sm" data-kjc-act="place" data-v="' + esc(c.id) + '">' + ico(placing ? 'crosshair' : 'plus') + '<span>' + (placing ? 'Click plan' : 'Place') + '</span></button>') +
            '</div>';
        }).join('') + '</div>';
    return '<div class="kj-card-head"><div class="kj-card-title">Place cameras</div><span class="kj-chip is-primary">Editing</span></div>' +
      '<p class="kjc-fp-hint">' + ico('mouse-pointer-click') + '<span>Drag a camera onto the plan, or press <b>Place</b> then click the spot. Drag pins to move them.</span></p>' + pal +
      '<div class="kjc-fp-settings"><div class="kj-section-title">Plan settings</div>' +
        '<div class="kj-field"><label class="kj-label" for="kjc-fp-name">Name</label><div class="kj-row"><input id="kjc-fp-name" class="kj-input" maxlength="120" value="' + esc(plan ? plan.name : '') + '">' +
        '<button type="button" class="kj-btn kj-btn-secondary" data-kjc-act="rename">' + ico('save') + '<span>Save</span></button></div></div>' +
        '<label class="kjc-check"><input type="checkbox" data-kjc-act="active"' + (plan && plan.active ? ' checked' : '') + '><span>Visible to everyone (active)</span></label>' +
        '<div class="kj-row-wrap"><button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-kjc-act="replace">' + ico('image-plus') + '<span>Replace image</span></button>' +
        '<button type="button" class="kj-btn kj-btn-danger kj-btn-sm" data-kjc-act="delplan">' + ico('trash-2') + '<span>Delete plan</span></button></div>' +
      '</div>';
  }

  function paintFp() {
    var el = S.el;
    if (!el || S.sub !== 'floorplan') return;
    var f = fpState();
    if (f.drag) return;                 // never repaint under a pointer drag
    destroyLottie(el);
    var plan = curPlan();
    var body;
    if (f.plans == null) {
      body = '<div class="kjc-fp-body"><div class="kj-card kjc-fp-stagecard"><span class="kj-skel kj-skel-block kjc-fp-skel"></span></div>' +
        '<aside class="kj-card kjc-fp-side"><span class="kj-skel kj-skel-title"></span><span class="kj-skel kj-skel-line"></span><span class="kj-skel kj-skel-line is-mid"></span><span class="kj-skel kj-skel-line is-short"></span></aside></div>';
    } else if (f.err && !f.plans.length) {
      body = lottieEmpty({ anim: 'error-alert', icon: 'cloud-off', error: true, title: 'Floor plans could not be loaded', text: f.err + ' — check your connection and try again.',
        actions: '<button type="button" class="kj-btn kj-btn-primary" data-kjc-act="reload">' + ico('refresh-cw') + '<span>Retry</span></button>' +
          window.KJPages.h.actionBtn({ label: 'Open live wall', path: 'cameras/wall', icon: 'cctv' }) });
    } else if (!plan) {
      body = lottieEmpty({ anim: 'empty-box', icon: 'map', title: 'No floor plans yet',
        text: f.can ? 'Upload a floor plan image (PNG, JPG or WebP, up to 8 MB) and drag your cameras onto it.' : 'An administrator has not uploaded a floor plan yet.',
        actions: (f.can ? '<button type="button" class="kj-btn kj-btn-primary" data-kjc-act="upload">' + ico('upload') + '<span>Upload floor plan</span></button>' : '') +
          window.KJPages.h.actionBtn({ label: 'Open live wall', path: 'cameras/wall', icon: 'cctv', primary: !f.can }) });
    } else {
      var idx = statusIndex();
      var pins = (plan.pins || []).map(function (p) { return pinHtml(p, pinTone(p, idx, f.cams), f.edit); }).join('');
      body = fpTabs(f) +
        '<div class="kjc-fp-body' + (f.edit ? ' is-edit' : '') + '">' +
          '<div class="kj-card kjc-fp-stagecard">' +
            (f.placing ? '<div class="kjc-fp-banner">' + ico('crosshair') + '<span>Click on the plan to place <b>' + esc(up(f.placing)) + '</b></span><button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kjc-act="cancel">Cancel</button></div>' : '') +
            '<div class="kjc-fp-scroll"><div class="kjc-fp-stage' + (f.edit ? ' is-edit' : '') + (f.placing ? ' is-placing' : '') + (f.busy ? ' is-busy' : '') + '" data-plan="' + plan.id + '">' +
              '<img class="kjc-fp-img" src="' + esc(plan.image_url) + '" alt="' + esc(plan.name) + ' floor plan" draggable="false">' + pins +
            '</div></div>' +
            '<div class="kjc-fp-legend"><span><i class="kjc-dot is-on"></i>Online</span><span><i class="kjc-dot is-alert"></i>Open alert</span><span><i class="kjc-dot is-off"></i>Offline</span><span><i class="kjc-dot is-unknown"></i>Status unknown</span>' +
            (f.err ? '<span class="kjc-fp-err">' + ico('triangle-alert') + esc(f.err) + '</span>' : '') + '</div>' +
          '</div>' +
          '<aside class="kj-card kjc-fp-side">' + fpSide(f, plan, idx) + '</aside>' +
        '</div>';
    }
    el.innerHTML = '<div class="kj-page kjc-page kjc-fp">' + fpHead(f) + body +
      '<input type="file" class="kj-sr-only" accept="image/png,image/jpeg,image/webp" data-kjc-file="new" tabindex="-1" aria-hidden="true">' +
      '<input type="file" class="kj-sr-only" accept="image/png,image/jpeg,image/webp" data-kjc-file="replace" tabindex="-1" aria-hidden="true"></div>';
    var stage = el.querySelector('.kjc-fp-stage');
    if (stage && plan) {
      var w = N(plan.width_px) || 16, h = N(plan.height_px) || 9;
      stage.style.setProperty('--kjc-ar', w + ' / ' + h);
      Array.prototype.forEach.call(stage.querySelectorAll('.kjc-pin'), placePin);
    }
    hydrateLottie(el);
  }
  function placePin(pin) {
    pin.style.setProperty('--x', N(pin.getAttribute('data-x')) + '%');
    pin.style.setProperty('--y', N(pin.getAttribute('data-y')) + '%');
  }
  // Feed tick on the floor plan: recolour pins only (no full repaint, no image reload).
  function paintPinStatus() {
    var el = S.el, f = fpState(), plan = curPlan();
    if (!el || !plan || f.drag) return;
    var idx = statusIndex();
    (plan.pins || []).forEach(function (p) {
      var tone = pinTone(p, idx, f.cams);
      var pinEl = el.querySelector('.kjc-pin[data-pin="' + p.id + '"]');
      if (pinEl && !pinEl.classList.contains(tone)) {
        ['is-on', 'is-off', 'is-alert', 'is-unknown', 'is-missing'].forEach(function (c) { pinEl.classList.remove(c); });
        pinEl.classList.add(tone);
      }
    });
  }

  function pctAt(stage, ev) {
    var r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: clamp((ev.clientX - r.left) / r.width * 100), y: clamp((ev.clientY - r.top) / r.height * 100) };
  }
  function busy(on) { var f = fpState(); f.busy = on; var s = S.el && S.el.querySelector('.kjc-fp-stage'); if (s) s.classList.toggle('is-busy', on); }
  function fail(e, what) { toast((what || 'Action failed') + ': ' + ((e && e.message) || 'error'), 'danger'); }

  function addPin(camId, pt) {
    var plan = curPlan(), f = fpState();
    if (!plan || !pt) return;
    busy(true);
    req('/floorplans/' + plan.id + '/pins', { json: { camera_id: camId, x_pct: pt.x, y_pct: pt.y } })
      .then(function () { f.placing = ''; toast('Camera placed on ' + plan.name, 'success'); f.cams = null; loadCatalog(); return loadPlans(plan.id); })
      .catch(function (e) { fail(e, 'Could not place camera'); })
      .then(function () { busy(false); });
  }
  function movePin(pinId, pt) {
    var plan = curPlan();
    if (!plan) return;
    var p = (plan.pins || []).find(function (x) { return x.id === pinId; });
    if (p) { p.x_pct = pt.x; p.y_pct = pt.y; }
    req('/floorplans/' + plan.id + '/pins/' + pinId, { json: { x_pct: pt.x, y_pct: pt.y } })
      .then(function () { toast('Pin moved', 'success'); })
      .catch(function (e) { fail(e, 'Could not move pin'); loadPlans(plan.id); });
  }
  function removePin(pinId) {
    var plan = curPlan(), f = fpState();
    if (!plan) return;
    busy(true);
    req('/floorplans/' + plan.id + '/pins/' + pinId + '/delete', { json: {} })
      .then(function () { toast('Camera removed from ' + plan.name, 'success'); f.cams = null; loadCatalog(); return loadPlans(plan.id); })
      .catch(function (e) { fail(e, 'Could not remove pin'); })
      .then(function () { busy(false); });
  }
  function uploadPlan(file, mode) {
    var f = fpState(), plan = curPlan();
    if (!file) return;
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.type || '')) { toast('Use a PNG, JPG or WebP image', 'warn'); return; }
    if (file.size > 8 * 1024 * 1024) { toast('Floor plan image must be 8 MB or smaller', 'warn'); return; }
    var fd = new FormData();
    fd.append('file', file);
    var path = '/floorplans';
    if (mode === 'replace' && plan) path = '/floorplans/' + plan.id + '/image';
    else fd.append('name', String(file.name || 'Floor plan').replace(/\.[a-z0-9]+$/i, '').slice(0, 120));
    f.busy = true; paintFp();
    toast(mode === 'replace' ? 'Replacing image…' : 'Uploading floor plan…', 'success');
    req(path, { form: fd }).then(function (d) {
      var id = d.floorplan && d.floorplan.id;
      toast(mode === 'replace' ? 'Image replaced — pins kept' : 'Floor plan uploaded', 'success');
      if (id && mode !== 'replace') { f.sel = id; lsSet('kjc.fp.sel', String(id)); f.edit = true; }
      return loadPlans(id || (plan && plan.id));
    }).catch(function (e) { fail(e, 'Upload failed'); })
      .then(function () { f.busy = false; paintFp(); });
  }
  function updatePlan(patch, msg) {
    var plan = curPlan();
    if (!plan) return;
    req('/floorplans/' + plan.id + '/update', { json: patch })
      .then(function () { toast(msg, 'success'); return loadPlans(plan.id); })
      .catch(function (e) { fail(e, 'Could not save'); loadPlans(plan.id); });
  }

  function fpAction(act, v, btn) {
    var f = fpState(), plan = curPlan();
    if (act === 'plan') { f.sel = N(v); f.placing = ''; lsSet('kjc.fp.sel', String(f.sel)); paintFp(); }
    else if (act === 'edit') { if (!f.can) return; f.edit = !f.edit; f.placing = ''; if (f.edit && !f.cams) loadCatalog(); paintFp(); }
    else if (act === 'upload' || act === 'replace') {
      var inp = S.el.querySelector('input[data-kjc-file="' + (act === 'upload' ? 'new' : 'replace') + '"]');
      if (inp) { inp.value = ''; inp.click(); }
    }
    else if (act === 'place') { f.placing = f.placing === v ? '' : v; paintFp(); }
    else if (act === 'cancel') { f.placing = ''; paintFp(); }
    else if (act === 'unpin') { removePin(N(v)); }
    else if (act === 'reload') { f.plans = null; paintFp(); loadPlans(); }
    else if (act === 'rename') {
      var inpN = S.el.querySelector('#kjc-fp-name'), name = inpN ? inpN.value.trim() : '';
      if (!name) { toast('Give the plan a name', 'warn'); return; }
      updatePlan({ name: name }, 'Plan renamed');
    }
    else if (act === 'delplan' && plan) {
      if (!window.confirm('Delete the floor plan "' + plan.name + '" and its ' + plural((plan.pins || []).length, 'camera pin') + '? This cannot be undone.')) return;
      req('/floorplans/' + plan.id + '/delete', { json: {} })
        .then(function () { toast('Floor plan deleted', 'success'); f.sel = 0; f.edit = false; f.cams = null; loadCatalog(); return loadPlans(); })
        .catch(function (e) { fail(e, 'Could not delete'); });
    }
  }

  // Pointer drag of an existing pin (edit mode).
  function onPointerDown(ev) {
    var f = fpState();
    if (S.sub !== 'floorplan' || !f.edit) return;
    var pin = ev.target instanceof Element ? ev.target.closest('.kjc-pin') : null;
    if (!pin || (ev.target.closest && ev.target.closest('.kjc-pin-x'))) return;
    var stage = pin.closest('.kjc-fp-stage');
    if (!stage) return;
    ev.preventDefault();
    f.drag = { pin: pin, stage: stage, id: N(pin.getAttribute('data-pin')), moved: false, x0: ev.clientX, y0: ev.clientY, pt: null };
    pin.classList.add('is-dragging');
    try { pin.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
  }
  function onPointerMove(ev) {
    var d = fpState().drag;
    if (!d) return;
    if (!d.moved && Math.abs(ev.clientX - d.x0) + Math.abs(ev.clientY - d.y0) < 3) return;
    var pt = pctAt(d.stage, ev);
    if (!pt) return;
    d.moved = true; d.pt = pt;
    d.pin.setAttribute('data-x', pt.x); d.pin.setAttribute('data-y', pt.y);
    placePin(d.pin);
  }
  function onPointerUp() {
    var f = fpState(), d = f.drag;
    if (!d) return;
    f.drag = null;
    d.pin.classList.remove('is-dragging');
    if (d.moved && d.pt) movePin(d.id, d.pt);
  }
  // Click on the stage while a camera is armed → drop it there.
  function onStageClick(ev) {
    var f = fpState();
    if (!f.edit || !f.placing) return false;
    var stage = ev.target instanceof Element ? ev.target.closest('.kjc-fp-stage') : null;
    if (!stage || ev.target.closest('.kjc-pin')) return false;
    addPin(f.placing, pctAt(stage, ev));
    return true;
  }

  function mountFloorplan(el) {
    var f = fpState();
    f.placing = ''; f.drag = null;
    paintFp();
    loadPlans();
  }

  /* ======================================================================
   * Shared host listeners (installed on mount, removed on unmount)
   * ==================================================================== */
  function bind(el) {
    var H = {
      click: function (ev) {
        var t = ev.target instanceof Element ? ev.target : null;
        if (!t) return;
        if (S.sub === 'floorplan' && onStageClick(ev)) return;
        var b = t.closest('[data-kjc-act]');
        if (!b || !el.contains(b) || b.tagName === 'INPUT') return;
        ev.preventDefault();
        ev.stopPropagation();
        var act = b.getAttribute('data-kjc-act'), v = b.getAttribute('data-v') || '';
        if (S.sub === 'wall') wallAction(act, v, b); else fpAction(act, v, b);
      },
      change: function (ev) {
        var t = ev.target;
        if (!(t instanceof Element)) return;
        if (t.matches('input[data-kjc-file]')) { uploadPlan(t.files && t.files[0], t.getAttribute('data-kjc-file')); return; }
        if (t.matches('input[data-kjc-act="active"]')) updatePlan({ active: t.checked ? 1 : 0 }, t.checked ? 'Plan is visible to everyone' : 'Plan hidden from non-admins');
      },
      keydown: function (ev) {
        if (ev.key === 'Escape' && S.sub === 'floorplan' && fpState().placing) { fpState().placing = ''; paintFp(); ev.stopPropagation(); }
      },
      pointerdown: onPointerDown, pointermove: onPointerMove, pointerup: onPointerUp, pointercancel: onPointerUp,
      dragstart: function (ev) {
        var row = ev.target instanceof Element ? ev.target.closest('.kjc-fp-cam[data-cam]') : null;
        if (!row || !ev.dataTransfer) return;
        ev.dataTransfer.setData('text/plain', 'kjc-cam:' + row.getAttribute('data-cam'));
        ev.dataTransfer.effectAllowed = 'copy';
      },
      dragover: function (ev) {
        var stage = ev.target instanceof Element ? ev.target.closest('.kjc-fp-stage.is-edit') : null;
        if (!stage) return;
        ev.preventDefault();
        stage.classList.add('is-drop');
      },
      dragleave: function (ev) {
        var stage = ev.target instanceof Element ? ev.target.closest('.kjc-fp-stage') : null;
        if (stage) stage.classList.remove('is-drop');
      },
      drop: function (ev) {
        var stage = ev.target instanceof Element ? ev.target.closest('.kjc-fp-stage.is-edit') : null;
        if (!stage || !ev.dataTransfer) return;
        ev.preventDefault();
        stage.classList.remove('is-drop');
        var data = ev.dataTransfer.getData('text/plain') || '';
        if (data.indexOf('kjc-cam:') === 0) addPin(data.slice(8), pctAt(stage, ev));
      }
    };
    Object.keys(H).forEach(function (k) { el.addEventListener(k, H[k]); });
    S.handlers = H;
  }
  function unbind(el) {
    var H = S.handlers;
    if (H && el) Object.keys(H).forEach(function (k) { el.removeEventListener(k, H[k]); });
    S.handlers = null;
  }

  /* ======================================================================
   * KJModal 'camera' — live player + recent detections (overrides the generic one)
   * ==================================================================== */
  function liveBlock(a, c, stream, still, live) {
    var m = camModel(a, c || { stream: stream, online: true });
    // Cold deep link / feed not polled yet: the pin endpoint already knows how this camera plays.
    if (!m.vsrc && m.online && live && live.stream) {
      if (live.mode === 'relay' && (window.MediaSource || window.ManagedMediaSource)) m.vsrc = 'relay:' + live.stream;
      else if ((live.mode === 'hls' || live.mode === 'bridge') && live.url) m.vsrc = live.url;
      else if (live.mode === 'still' || live.still_url) m.still = true;
      if (!m.stream) m.stream = live.stream;
    }
    var tag = function (txt, tone) { return '<span class="kj-media-tag"><span class="kj-chip kj-chip-dot is-' + tone + '">' + esc(txt) + '</span></span>'; };
    if (!m.online) {
      return '<div class="kj-media kjc-mlive"><div class="kjc-off">' + ico('video-off', 'kjc-off-ico') + '<div class="kjc-off-title">Camera offline</div>' +
        '<div class="kjc-off-sub"><span class="kjc-spin"></span>Reconnecting…</div><button type="button" class="kjc-retry" data-kjc-retry="' + esc(stream) + '">' + ico('refresh-cw') + 'Retry connection</button></div>' +
        tag('Offline', 'danger') + '</div>';
    }
    if (m.vsrc) {
      var src = document.querySelector('.kjc-wall video[data-cam="' + cssEsc(m.key) + '"]');
      return '<div class="kj-media kjc-mlive"><div class="kjc-vwrap" data-state="connecting">' +
        '<video class="kjc-video" data-src="' + esc(m.vsrc) + '" data-cam="kjm:' + esc(m.key) + '"' + (src ? ' data-mirror="' + esc(m.key) + '"' : '') +
        (still ? ' poster="' + esc(still) + '"' : '') + ' muted playsinline autoplay></video>' +
        // shown only in the error state: near-live still frame (if the camera has one) or the last detection
        '<img class="kjc-frame kjc-mfall" alt="Snapshot" data-kjc-fall="' + esc(m.stream) + '"' + (still ? ' data-kjc-fallsrc="' + esc(still) + '"' : '') + ' hidden>' +
        '<div class="kjc-vover kjc-vover-wait"><span class="kjc-spin"></span><span class="kjc-vover-txt">Connecting…</span></div>' +
        '<div class="kjc-vover kjc-vover-err">' + ico('wifi-off') + '<b>Stream interrupted</b><button type="button" class="kjc-retry" data-kjc-retry="' + esc(m.stream) + '">' + ico('refresh-cw') + 'Retry</button></div>' +
        '</div>' + tag('Connecting…', 'warn') + '</div>';
    }
    if (m.still) {
      return '<div class="kj-media kjc-mlive"><img class="kjc-frame" data-kjc-still="' + esc(m.stream) + '" src="' + esc(a.liveApiUrl('/live/still?stream=' + enc(m.stream) + '&t=' + Date.now())) + '" alt="Live snapshot">' +
        tag('Live snapshot', 'success') + '</div>';
    }
    var h = window.KJModal.h;
    return h.media(still, 'Last detection', '<span class="kj-chip kj-chip-dot is-warn">No live source · last detection</span>');
  }

  // "Monitoring" line in the camera modal — read-only summary; the editor lives in Settings → AI Engine.
  function canMonitors() { var P = window.KJPages; return !P || !P.can || P.can('settings'); }
  function monitorLine(mon, stream) {
    if (!mon || mon.ok === false || !Array.isArray(mon.cameras)) return '';
    var key = low(stream), cam = null;
    mon.cameras.forEach(function (x) { if (x && low(x.stream) === key) cam = x; });
    var labels = {};
    (Array.isArray(mon.catalog) ? mon.catalog : []).forEach(function (f) { if (f && f.key) labels[f.key] = f.label || f.key; });
    var cfg = (cam && cam.config) || {}, fields = Array.isArray(cfg.fields) ? cfg.fields : [];
    var chips;
    if (!cam || !cfg.enabled || !fields.length) {
      chips = '<span class="kj-chip">' + esc(cam && fields.length ? 'Monitoring paused' : 'Not monitored') + '</span>';
    } else {
      var fit = (cam.state && cam.state.fitness) || null;
      var verdict = function (k) { var f = fit && fit.fields && fit.fields[k]; if (!f || typeof f !== 'object') return null; var v = f.fit != null ? f.fit : f.fits; return v == null ? null : !!v; };
      var unfit = fields.filter(function (k) { return verdict(k) === false; });
      var badge = !fit ? '<span class="kj-chip" title="The daily fitness check has not run on this camera yet.">Unchecked</span>'
        : (unfit.length ? '<span class="kj-chip is-warn" title="' + esc(unfit.map(function (k) { var f = fit.fields[k] || {}; return (labels[k] || k) + ': ' + (f.reason || 'scene does not fit'); }).join(' · ')) + '">✕ Unfit' + (cfg.force_fit ? ' · forced' : '') + '</span>'
          : (fields.every(function (k) { return verdict(k) === true; }) ? '<span class="kj-chip is-success">✓ Fit</span>' : '<span class="kj-chip">Unchecked</span>'));
      chips = fields.map(function (k) { return '<span class="kj-chip is-purple">' + esc(labels[k] || k) + '</span>'; }).join('') + badge;
    }
    return window.KJModal.h.section('Monitoring',
      '<button type="button" class="kjc-mon" data-kj-nav="settings/ai" title="Edit camera monitors in Settings → AI Engine">' + ico('radar') +
      '<span class="kjc-mon-text">VisionAI monitoring</span><span class="kjc-mon-chips">' + chips + '</span>' + ico('chevron-right') + '</button>');
  }

  function registerCameraModal() {
    var M = window.KJModal;
    if (!M || registerCameraModal.done) return;
    registerCameraModal.done = true;
    var h = M.h;
    M.register('camera', {
      kicker: 'Camera', icon: 'cctv', size: 'lg', skeleton: 'media',
      load: function (ctx) {
        var a = app(), id = String(ctx.id);
        var c = findCam(a, id) || null;
        var stream = (c && c.stream) || id;
        // app.js parks a failed relay on snapshots for 60 s (videoSrc() returns '');
        // opening the modal is an explicit request for live, so always try afresh.
        if (a && a._relayFail) { delete a._relayFail[stream]; delete a._relayFail[low(stream)]; }
        var supervisor = ['admin', 'superadmin', 'supervisor'].indexOf(window.KJPages ? window.KJPages.role() : '') >= 0 || !(window.TMNS && window.TMNS.user);
        return Promise.all([
          h.soft(h.api('/events/latest/' + enc(stream))),
          supervisor ? h.soft(h.api('/movement/camera/' + enc(low(stream)), { limit: 8 })) : Promise.resolve(null),
          canMonitors() ? h.soft(h.api('/monitors')) : Promise.resolve(null)
        ]).then(function (r) {
          a = app();
          c = findCam(a, id) || c;          // the feed may have landed meanwhile (cold deep links)
          if (c && c.stream) stream = c.stream;
          var latest = r[0] && r[0].event ? h.normEvent(r[0].event) : null;
          var mv = r[1] || null;
          var vs = '';
          try { vs = a ? a.videoSrc(stream) : ''; } catch (e) { vs = ''; }
          if (!c && !latest && !vs && !(mv && mv.live && mv.live.mode !== 'none') && !(ctx.data && ctx.data.name)) throw new Error('Camera "' + id + '" is not registered');
          return { c: c || Object.assign({ stream: stream, online: !(mv && mv.live && mv.live.online === false) }, ctx.data || {}), stream: stream, latest: latest, mv: mv, mon: r[2] || null };
        });
      },
      render: function (ctx, d) {
        var a = app(), st = (a && a.state) || {};
        var c = d.c, key = up(d.stream);
        var m = camModel(a || { state: {} , videoSrc: function () { return ''; }, hasStill: function () { return false; }, notOnBridge: function () { return false; } }, c);
        var evs = (st.events || []).filter(function (e) { return up(e.camera) === key; }).map(h.normEvent)
          .sort(function (x, y) { return tsOf(y.ts) - tsOf(x.ts); });
        var still = (d.latest && (d.latest.imageBk || d.latest.image)) || c.img || null;
        var name = c.name || (d.mv && d.mv.live && d.mv.live.name) || key;
        var live = d.mv && d.mv.live;
        var loc = (live && live.location) || (m.zone !== 'Unassigned' ? m.zone : '') || c.plant || c.loc || '';
        var recent = (d.mv && d.mv.recent) || [];
        var faces = recent.length ? '<div class="kj-list">' + recent.map(function (r) {
          var thumb = r.thumb ? '<img class="kj-thumb" src="' + esc(r.thumb) + '" alt="" loading="lazy">' : '<span class="kj-thumb kj-stat-ico">' + ico('scan-face') + '</span>';
          return '<button type="button" class="kj-list-item" data-kj-modal="' + esc(spec('person', r.person_id)) + '">' + thumb +
            '<div class="kj-list-main"><div class="kj-list-title kj-truncate">' + esc(r.name || r.person_id) + '</div><div class="kj-list-sub">' + esc(h.fmtTime(r.time) + ' · ' + ago(r.time)) + '</div></div>' + ico('chevron-right') + '</button>';
        }).join('') + '</div>' : '';
        var dets = evs.length ? '<div class="kj-list">' + evs.slice(0, 8).map(h.eventRow).join('') + '</div>'
          : (d.latest ? '<div class="kj-list">' + h.eventRow(d.latest) + '</div>' : h.empty('radar', 'No recent detections', 'Nothing detected on this camera in the live window.'));
        var nav = 'cameras/view/' + enc(low(c.stream || d.stream));
        return {
          title: name, kicker: 'Camera · ' + key + (loc ? ' · ' + loc : ''), icon: 'cctv', tone: m.online ? 'success' : 'danger',
          body: liveBlock(a, c, c.stream || d.stream, still, live) +
            '<div class="kj-grid-3">' + h.statTile('radar', h.fmtN(m.count || evs.length), 'Detections · 24 h', 'purple') +
            h.statTile('bell-ring', h.fmtN(m.open), 'Open alerts', m.open ? 'danger' : 'success') +
            h.statTile('clock', d.latest ? (ago(d.latest.ts) || '—') : (m.last ? ago(m.last) : '—'), 'Last detection', '') + '</div>' +
            h.section('Recent detections on this camera', dets) +
            (faces ? h.section('People seen here · last 7 days', faces) : '') +
            monitorLine(d.mon, c.stream || d.stream) +
            h.section('Device', '<div class="kj-card">' + h.kv([['Name', name], ['Stream label', c.stream || d.stream], ['Serial', c.serial], ['Device ID', c.did],
              ['Location / zone', loc], ['Status', m.online ? 'Online' : 'Offline'],
              ['Live source', m.vsrc ? (/\.m3u8/i.test(m.vsrc) ? 'HLS' : (m.vsrc.indexOf('relay:') === 0 ? 'Server RTSP relay' : 'Live bridge (MP4)')) : (m.still ? 'Snapshots' : 'None')]]) + '</div>'),
          foot: '<button type="button" class="kj-btn kj-btn-secondary" data-kj-nav="cameras/floorplan">' + ico('map-pinned') + 'Floor plan</button>' +
            '<button type="button" class="kj-btn kj-btn-primary" data-kj-nav="' + esc(nav) + '">' + ico('external-link') + 'Open camera page</button>',
          actions: {},
          mount: function (cx) {
            trackIn(cx.body);
            try { if (a && a.mountVideos) a.mountVideos(); } catch (e) { /* the 1 s loop starts it */ }
          }
        };
      }
    });
  }
  registerCameraModal();
  if (typeof document !== 'undefined' && !registerCameraModal.done) {
    // kj-modal.js is a deferred script; it has run by DOMContentLoaded.
    document.addEventListener('DOMContentLoaded', registerCameraModal);
    window.addEventListener('load', registerCameraModal);
  }

  /* ======================================================================
   * Module registration
   * ==================================================================== */
  window.KJPages.register('cameras', {
    title: 'Cameras',
    perm: 'view',
    defaultSub: 'wall',
    subs: {
      // #cameras — the M11 live wall (module-rendered). The old Live Feeds page name redirects here.
      wall:      { label: 'Live wall',  icon: 'cctv', aliases: ['live'] },
      overview:  { label: 'Overview',   legacy: 'camdash', icon: 'gauge' },
      floorplan: { label: 'Floor plan', icon: 'map-pinned' },
      manage:    { label: 'Manage',     legacy: 'cameras', icon: 'settings-2' },
      // #cameras/view/<stream> — one camera's live stream + VisionAI config (was #camera/<stream>).
      view: {
        label: 'Camera', legacy: 'camera', rest: true, hidden: true,
        prepare: function (route, app) {
          var stream = '';
          try { stream = decodeURIComponent(route.rest[0] || ''); } catch (e) { stream = route.rest[0] || ''; }
          if (!app || stream === app.state.camSel) return;
          var f = (app.state.fleet || []).find(function (x) { return x.stream === stream; }) || {};
          app.setState({ camSel: stream, camMsg: '', lbMsg: '', camEdit: { name: f.name || '', rtsp: f.rtsp || '', tag: '', desc: '' } });
        }
      }
    },

    enter: function (app, page) {
      if (page === 'camdash') app.loadApp();                // camera-point / plant mappings for the camera dashboard
      if (page === 'camera') app.loadLive(true);            // live-bridge readiness on the camera page
    },

    mount: function (el, route, app) {
      registerCameraModal();
      if (S.el && S.el !== el) unbind(S.el);
      S.el = el; S.app = app; S.sub = route.sub;
      el.classList.add('kjc-host');
      bind(el);
      startTicker();
      if (route.sub === 'wall') mountWall(el, app);
      else if (route.sub === 'floorplan') mountFloorplan(el);
    },

    unmount: function (el) {
      // Stop every stream this page opened before the host is emptied (mountVideos never
      // sees removed elements, so HLS instances / relay fetches would otherwise linger).
      killIn(el);
      unbind(el);
      el.classList.remove('kjc-host');
      if (S.fp) { S.fp.drag = null; S.fp.placing = ''; }
      S.el = null; S.sub = ''; S.tiles = {}; S.gridMode = '';
      el.innerHTML = '';
      sweep();
    },

    onFeed: function (data, app, route) {
      S.fedAt = Date.now();
      if (!S.el || !route) return;
      if (route.sub === 'wall') paintWall();
      else if (route.sub === 'floorplan') paintPinStatus();
    },

    // ── Legacy Component methods (verbatim from app.js; `this` is the dc app) ──
    methods: class {
  setCamEdit(patch){ this.setState(s=>({camEdit:{...s.camEdit, ...patch}})); }
  saveCamera(){ const stream=this.state.camSel;
    const f=(this.state.fleet||[]).find(x=>x.stream===stream);
    if(!f || !f.did){ this.setState({camMsg:'✗ No VisionAI device id for this camera — cannot update.'}); return; }
    const e=this.state.camEdit||{}; this.setState({camMsg:'Saving to VisionAI…'});
    fetch(`${this.API}/cameras/${encodeURIComponent(f.did)}?token=${this.TOK}`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:e.name, rtsp:e.rtsp, tag:e.tag, desc:e.desc})})
      .then(r=>r.json()).then(d=>{ this.setState({camMsg: d&&d.ok?('✓ Updated in VisionAI'+this.bridgeNote(d)):'✗ '+((d&&(d.msg||d.error))||'Update failed')});
        if(d&&d.ok){ this.fetchFeed(); if(d.bridge) this.loadLive(true, true); } })
      .catch(()=>this.setState({camMsg:'✗ Network error'})); }
  setCamFilter(f){ this.setState({camFilter:f}); }
  // Onboard a camera to VisionAI via our API (§3.3.1 device/create).
  submitCamera(){
    const a=this.state.addCam;
    if(!a.name || !a.rtsp){ this.setState({addCam:{...a,msg:'Name and RTSP URL are required.'}}); return; }
    this.setState({addCam:{...a,busy:true,msg:'Onboarding to VisionAI…'}});
    fetch(`${this.API}/cameras?token=${this.TOK}`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({name:a.name, rtsp:a.rtsp})})
      .then(r=>r.json()).then(d=>{
        if(d && d.ok){ this.setState({addCam:{name:'',rtsp:'',busy:false,msg:'✓ Camera onboarded (device '+(d.data||'created')+')'+this.bridgeNote(d)+'. It will appear once VisionAI activates it.'}}); if(d.bridge) this.loadLive(true, true); }
        else { this.setState(s=>({addCam:{...s.addCam,busy:false,msg:'✗ '+((d&&(d.msg||d.error))||'Failed')}})); }
      }).catch(()=>this.setState(s=>({addCam:{...s.addCam,busy:false,msg:'✗ Network error'}})));
  }
  updAddCam(patch){ this.setState(s=>({addCam:{...s.addCam,...patch}})); }
    }
  });
})();
