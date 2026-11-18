/* Movement hub — page module (assets/js/pages/movement.js).
 * Owner: wave-2 M14 floor-plan movement agent
 * Absorbs legacy pages: movement (→ #movement/log), poc (→ #movement/poc)
 *
 *   #movement            Floor-plan playback (host-mounted, this file): plan image + camera
 *                        pins, person search, date + time-range, numbered trail (SVG),
 *                        timeline scrubber with WebP thumbs + play, occupancy heat,
 *                        admin plan/pin editor, drill-down log below the canvas.
 *   #movement/strangers  Unregistered faces (stranger ids): list, journey drawer, actions —
 *                        assets/js/pages/movement-strangers.js (window.KJStrangers), mounted below;
 *                        "Show on floor plan" comes back here through showOnPlan().
 *   #movement/log        Legacy movement-log table (dc template section, unchanged).
 *   #movement/poc        Legacy POC scorecard (unchanged).
 *
 * API (docs/plan/FLOORPLAN_MOVEMENT.md §4/§8): /floorplans, /floorplans/{id}/image,
 * /floorplans/cameras, /floorplans/pins/{pin}/live, /movement/{path,people,occupancy,thumb}.
 * Styles: assets/css/pages/movement.css (injected below — no dc.html edit, no inline
 * static styles; pin/waypoint geometry is set as CSS custom properties from JS).
 * Modals registered here: mv-camera (pin → live + recent), mv-stop (waypoint),
 * mv-plan (admin plan settings), mv-pin (admin pin edit).
 */
(function () {
  'use strict';

  /* ── stylesheet (own file, injected once) ──────────────────────────────── */
  var SELF = (document.currentScript && document.currentScript.src) || '';
  function cssHref() {
    var m = /^(.*\/)js\/pages\/movement\.js(\?.*)?$/.exec(SELF);
    return m ? m[1] + 'css/pages/movement.css' + (m[2] || '') : 'assets/css/pages/movement.css';
  }
  function ensureCss() {
    if (document.getElementById('kj-movement-css') || !document.head) return;
    var l = document.createElement('link');
    l.id = 'kj-movement-css'; l.rel = 'stylesheet'; l.href = cssHref();
    document.head.appendChild(l);
  }
  ensureCss();

  /* ── small utils ───────────────────────────────────────────────────────── */
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) { return v == null ? '' : String(v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function ico(n, c) { return (window.KJIcon && window.KJIcon.svg) ? window.KJIcon.svg(n, c) : ''; }
  function N(v) { return Number(v) || 0; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayStr() { return ymd(new Date()); }
  function hm(min) { min = Math.max(0, Math.min(1439, Math.round(min))); return pad(Math.floor(min / 60)) + ':' + pad(min % 60); }
  function tHM(s) { return String(s || '').slice(11, 16) || '—'; }
  function minOf(s) { var m = /(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || '')); return m ? N(m[1]) * 60 + N(m[2]) + N(m[3]) / 60 : 0; }
  function dwell(s) {
    s = N(s); if (s < 60) return s ? s + ' s' : '< 1 min';
    var m = Math.round(s / 60); if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + pad(m % 60) + ' min';
  }
  function fmtDay(d) {
    var x = new Date(String(d) + 'T00:00:00');
    return isNaN(x) ? String(d || '') : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function initials(n) { return String(n || '?').trim().split(/\s+/).slice(0, 2).map(function (p) { return p[0] || ''; }).join('').toUpperCase() || '?'; }
  function spec(type, id) { return type + ':' + encodeURIComponent(String(id == null ? '' : id)); }
  function seedAttr(o) { return o ? " data-kj-seed='" + esc(JSON.stringify(o)) + "'" : ''; }
  function setVars(el, vars) { Object.keys(vars).forEach(function (k) { el.style.setProperty(k, vars[k]); }); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function toast(msg, tone) { if (window.KJModal && window.KJModal.toast) window.KJModal.toast(msg, tone); }

  /* ── API ───────────────────────────────────────────────────────────────── */
  function T() { return window.TMNS || {}; }
  function apiBase() { return T().api || '/api'; }
  /** '/api/x?y=1' or '/x' → browser URL with the read token (images, video, still frames). */
  function apiUrl(p) {
    if (!p) return '';
    if (/^https?:\/\//i.test(p)) return p;
    var rel = String(p).replace(/^\/api(?=\/)/, '');
    var tok = T().token || '';
    return apiBase() + rel + (tok ? (rel.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(tok) : '');
  }
  function parse(r) {
    return r.json().catch(function () { return { ok: false }; }).then(function (d) {
      if (!r.ok || !d || d.ok === false) {
        var e = new Error((d && (d.error || d.msg)) || ('Request failed (' + r.status + ')')); e.status = r.status; throw e;
      }
      return d;
    });
  }
  function get(path, params) {
    var q = new URLSearchParams();
    Object.keys(params || {}).forEach(function (k) { if (params[k] != null && params[k] !== '') q.set(k, params[k]); });
    if (T().token) q.set('token', T().token);
    var qs = q.toString();
    return fetch(apiBase() + path + (qs ? '?' + qs : ''), { cache: 'no-store', credentials: 'same-origin' }).then(parse);
  }
  function post(path, body) {
    var tok = T().token ? '?token=' + encodeURIComponent(T().token) : '';
    var o = { method: 'POST', credentials: 'same-origin', cache: 'no-store' };
    if (body instanceof FormData) o.body = body;
    else { o.headers = { 'Content-Type': 'application/json' }; o.body = JSON.stringify(body || {}); }
    return fetch(apiBase() + path + tok, o).then(parse);
  }

  /* ── Lottie (vendored player, loaded on demand; icon fallback stays) ───── */
  var LOT = { loading: false, cbs: [] };
  function lottieBase() { var m = /^(.*\/)js\/pages\/movement\.js/.exec(SELF); return m ? m[1] : 'assets/'; }
  function withLottie(cb) {
    if (window.lottie) { cb(); return; }
    LOT.cbs.push(cb);
    if (LOT.loading) return;
    LOT.loading = true;
    var s = document.createElement('script');
    s.src = lottieBase() + 'vendor/lottie/lottie_light.min.js'; s.async = true;
    s.onload = function () { var q = LOT.cbs; LOT.cbs = []; q.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } }); };
    s.onerror = function () { LOT.cbs = []; };
    (document.head || document.body).appendChild(s);
  }
  function hydrateLottie(root) {
    if (!root || !root.querySelectorAll) return;
    var boxes = root.querySelectorAll('[data-mv-lottie]:not([data-mv-lot-on])');
    if (!boxes.length || /jsdom/i.test((navigator && navigator.userAgent) || '')) return;
    withLottie(function () {
      Array.prototype.forEach.call(boxes, function (b) {
        if (!document.contains(b) || b.hasAttribute('data-mv-lot-on')) return;
        b.setAttribute('data-mv-lot-on', '1');
        try {
          var a = window.lottie.loadAnimation({ container: b.querySelector('.mv-lottie-anim') || b, renderer: 'svg', loop: true, autoplay: true,
            path: lottieBase() + 'lottie/' + b.getAttribute('data-mv-lottie') + '.json' });
          a.addEventListener('DOMLoaded', function () { b.classList.add('has-lottie'); });
        } catch (e) { /* icon fallback stays */ }
      });
    });
  }
  /** Empty state with a Lottie animation (icon until the player loads) + ways forward. */
  function emptyBox(o) {
    return '<div class="kj-empty mv-empty' + (o.cls ? ' ' + o.cls : '') + '">' +
      '<div class="mv-lottie" data-mv-lottie="' + esc(o.lottie || 'empty-box') + '"><span class="kj-empty-ico mv-lottie-ico">' + ico(o.icon || 'footprints') + '</span><span class="mv-lottie-anim"></span></div>' +
      '<div class="kj-empty-title">' + esc(o.title) + '</div>' +
      (o.text ? '<div class="kj-empty-text">' + esc(o.text) + '</div>' : '') +
      (o.actions ? '<div class="kj-row-wrap kj-empty-actions">' + o.actions + '</div>' : '') + '</div>';
  }

  /* ── page state (module-local, never in app.state) ─────────────────────── */
  var S = null;
  function fresh(el, app) {
    var role = String(((T().user || {}).role) || '').toLowerCase();
    var tier = (role === 'admin' || role === 'superadmin') ? 'admin' : (role === 'supervisor' ? 'supervisor' : (role ? 'staff' : 'admin'));
    return {
      el: el, app: app, tier: tier, viewer: tier !== 'staff',
      plans: null, plansErr: '', canManage: false, planId: null,
      zoom: 1, edit: false, cams: null, placing: '',
      person: null, q: '', results: null, date: todayStr(), from: 0, to: 1439,
      path: null, pathBusy: false, pathErr: '', pathSeq: 0,
      heat: false, heatMin: 15, occ: null, heatT: null,
      active: -1, playing: false, playT: null, cursor: null,
      log: null, logBusy: false, logSeq: 0,
      timers: [], lastAuto: Date.now()
    };
  }
  function curPlan() { return S && S.plans ? (S.plans.find(function (p) { return p.id === S.planId; }) || null) : null; }
  function wps() { return (S && S.path && S.path.waypoints) || []; }
  function q(sel) { return S && S.el ? S.el.querySelector(sel) : null; }

  /* ── page skeleton ─────────────────────────────────────────────────────── */
  function renderShell() {
    var el = S.el;
    el.innerHTML =
      '<div class="kj-page kj-root mv-page" data-mv-page>' +
        '<div class="kj-page-head mv-head">' +
          '<div><h2 class="kj-page-title">Movement</h2><p class="kj-page-sub">Track employee movement across your facility — pick a person to replay their path on the floor plan.</p></div>' +
          '<div class="mv-head-actions" data-mv-admin hidden>' +
            '<button type="button" class="kj-btn kj-btn-secondary mv-upload-btn" data-mv-act="upload">' + ico('upload') + '<span>Upload Floor Plan</span></button>' +
            '<input type="file" class="kj-sr-only" accept="image/png,image/jpeg,image/webp" data-mv-file="new" aria-label="Floor plan image">' +
            '<span class="mv-divider"></span>' +
            '<label class="mv-switch"><span>Edit Camera Positions</span><input type="checkbox" data-mv-edit><span class="mv-switch-track"><span class="mv-switch-knob"></span></span></label>' +
          '</div>' +
        '</div>' +
        '<div class="mv-layout">' +
          '<aside class="kj-card mv-side" data-mv-side></aside>' +
          '<section class="kj-card mv-stage" data-mv-stage>' +
            '<div class="mv-stage-bar">' +
              '<div class="mv-floors" data-mv-floors role="tablist" aria-label="Floor plans"></div>' +
              '<span class="kj-spacer"></span>' +
              '<div class="mv-heat-ctl" data-mv-heatctl></div>' +
            '</div>' +
            '<div class="mv-viewport" data-mv-viewport><div class="mv-canvas-wrap" data-mv-wrap></div></div>' +
            '<div class="mv-stage-foot">' +
              '<div class="mv-legend">' +
                '<span class="mv-leg"><i class="mv-leg-line"></i>Movement path</span>' +
                '<span class="mv-leg"><i class="mv-leg-dot is-start"></i>Start</span>' +
                '<span class="mv-leg"><i class="mv-leg-dot"></i>Detection</span>' +
                '<span class="mv-leg"><i class="mv-leg-dot is-end"></i>End</span>' +
                '<span class="mv-leg">' + ico('video') + 'Camera</span>' +
              '</div>' +
              '<span class="kj-spacer"></span>' +
              '<div class="mv-zoom" role="group" aria-label="Zoom">' +
                '<button type="button" class="kj-btn kj-btn-secondary kj-btn-icon kj-btn-sm" data-mv-act="zoom-out" aria-label="Zoom out">' + ico('minus') + '</button>' +
                '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm mv-zoom-val" data-mv-act="zoom-fit" title="Fit to view" data-mv-zoomval>100%</button>' +
                '<button type="button" class="kj-btn kj-btn-secondary kj-btn-icon kj-btn-sm" data-mv-act="zoom-in" aria-label="Zoom in">' + ico('plus') + '</button>' +
                '<button type="button" class="kj-btn kj-btn-secondary kj-btn-icon kj-btn-sm" data-mv-act="fullscreen" aria-label="Full screen">' + ico('maximize') + '</button>' +
              '</div>' +
            '</div>' +
            '<div class="mv-strip" data-mv-strip></div>' +
            '<div class="mv-editor" data-mv-editor hidden></div>' +
          '</section>' +
        '</div>' +
        '<section class="kj-card mv-timeline" data-mv-timeline></section>' +
        '<section class="kj-card mv-log" data-mv-log></section>' +
      '</div>';
  }

  /* ── left panel ────────────────────────────────────────────────────────── */
  function renderSide() {
    var box = q('[data-mv-side]'); if (!box) return;
    var p = S.person, sm = (S.path && S.path.summary) || {};
    var search = S.viewer
      ? '<div class="mv-sec"><div class="mv-sec-title">Find a person</div>' +
          '<div class="mv-search">' + ico('search') +
            '<input type="search" class="kj-input" placeholder="Name or staff ID" autocomplete="off" data-mv-q value="' + esc(S.q) + '" aria-label="Find a person">' +
            (S.q ? '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon kj-btn-sm" data-mv-act="clear-q" aria-label="Clear">' + ico('x') + '</button>' : '') +
          '</div><div class="mv-results" data-mv-results></div>' +
          (p ? personCard(p, true) : '') + '</div>'
      : '<div class="mv-sec"><div class="mv-sec-title">My movement</div>' + (p ? personCard(p, false) : '<div class="kj-help">Your own detections on the factory cameras.</div>') + '</div>';
    box.innerHTML = search +
      '<div class="mv-sec"><label class="mv-sec-title" for="mv-date">Date</label>' +
        '<div class="mv-date">' + ico('calendar') + '<input id="mv-date" type="date" class="kj-input" data-mv-date value="' + esc(S.date) + '" max="' + esc(todayStr()) + '"></div></div>' +
      '<div class="mv-sec"><div class="mv-sec-title kj-row"><span>Time range</span><span class="kj-spacer"></span><b class="mv-range-val" data-mv-rangeval>' + hm(S.from) + ' – ' + hm(S.to) + '</b></div>' +
        '<div class="mv-range" data-mv-range>' +
          '<div class="mv-range-track"><div class="mv-range-fill" data-mv-rangefill></div></div>' +
          '<input type="range" min="0" max="1439" step="5" value="' + S.from + '" data-mv-from aria-label="From time">' +
          '<input type="range" min="0" max="1439" step="5" value="' + S.to + '" data-mv-to aria-label="To time">' +
        '</div>' +
        '<div class="mv-range-ends"><span>00:00</span><span>12:00</span><span>23:59</span></div>' +
        '<div class="mv-quick">' +
          ['all|All day', 'am|Morning', 'pm|Afternoon', 'last2|Last 2 h'].map(function (x) { var a = x.split('|'); return '<button type="button" class="kj-chip" data-mv-act="range" data-mv-range-key="' + a[0] + '">' + a[1] + '</button>'; }).join('') +
        '</div></div>' +
      '<div class="mv-sec"><div class="mv-sec-title">Floor</div><div class="mv-floors mv-floors-side" data-mv-floors2></div></div>' +
      '<div class="mv-sec" data-mv-summary>' + summaryCard(p, sm) + '</div>';
    paintRange();
    paintFloors();
    hydrateLottie(box);
  }
  function avatar(photo, name, cls) {
    return photo ? '<img class="kj-avatar ' + (cls || '') + '" src="' + esc(photo) + '" alt="" loading="lazy">'
      : '<span class="kj-avatar ' + (cls || '') + '">' + esc(initials(name)) + '</span>';
  }
  function personCard(p, viewer) {
    return '<div class="mv-person is-selected">' +
      '<button type="button" class="mv-person-main" data-kj-modal="' + esc(p.person_id ? spec('person', p.person_id) : '') + '"' + seedAttr({ name: p.name }) + '>' +
        avatar(p.photo, p.name, 'kj-avatar-lg') +
        '<span class="mv-person-txt"><b class="kj-truncate">' + esc(p.name || ('#' + p.person_id)) + '</b>' +
        '<span class="kj-truncate">' + esc(p.staff_id || (p.known === false ? 'Unregistered face' : '—')) + '</span>' +
        '<span class="kj-truncate">' + esc(p.department || '') + '</span></span></button>' +
      (viewer ? '<span class="mv-person-check">' + ico('circle-check') + '</span>' : '') + '</div>';
  }
  function summaryCard(p, sm) {
    if (!p && S.viewer) {
      return '<div class="mv-summary is-empty">' + emptyBox({ lottie: 'face-scan', icon: 'scan-face', title: 'Pick a person',
        text: 'Search by name or staff ID to replay where they went today.' }) + '</div>';
    }
    if (S.pathBusy && !S.path) return '<div class="mv-summary"><span class="kj-skel kj-skel-title"></span><span class="kj-skel kj-skel-line"></span><span class="kj-skel kj-skel-line is-mid"></span><span class="kj-skel kj-skel-line is-short"></span></div>';
    var plan = S.plans && S.plans.find(function (x) { return x.id === sm.last_floorplan_id; });
    var lastWp = wps()[wps().length - 1];
    var rows = [
      ['footprints', N(sm.detections) + ' detection' + (N(sm.detections) === 1 ? '' : 's') + (sm.truncated ? ' (capped)' : ''), lastWp ? 'stop:' + lastWp.seq : ''],
      ['clock', 'Last seen: ' + (sm.last_seen ? tHM(sm.last_seen) : '—'), lastWp ? 'stop:' + lastWp.seq : ''],
      ['layers', plan ? plan.name : (sm.last_floorplan_id ? 'Plan #' + sm.last_floorplan_id : 'No plan'), plan ? 'plan:' + plan.id : ''],
      ['map-pin', sm.last_location || '—', lastWp ? 'stop:' + lastWp.seq : '']
    ];
    var who = p || (S.path && S.path.person) || {};
    return '<div class="mv-summary">' +
      '<div class="mv-summary-title">' + esc(who.name || 'Movement') + ' <span class="kj-muted">— Movement summary</span></div>' +
      '<div class="mv-summary-body">' + avatar(who.photo, who.name, 'kj-avatar-lg mv-summary-ava') +
        '<ul class="mv-summary-list">' + rows.map(function (r) {
          var a = r[2] ? r[2].split(':') : null;
          var attr = !a ? '' : (a[0] === 'stop' ? ' data-mv-stop="' + esc(a[1]) + '"' : ' data-mv-act="plan" data-mv-plan="' + esc(a[1]) + '"');
          return '<li><button type="button" class="mv-summary-row"' + attr + (a ? '' : ' disabled') + '>' + ico(r[0]) + '<span class="kj-truncate">' + esc(r[1]) + '</span></button></li>';
        }).join('') + '</ul></div>' +
      (N(sm.unplaced) ? '<button type="button" class="mv-summary-note" data-mv-act="scroll-strip">' + ico('map-pin-off') + N(sm.unplaced) + ' stop' + (N(sm.unplaced) === 1 ? '' : 's') + ' at cameras not on any plan</button>' : '') +
      '</div>';
  }
  function paintSummary() { var b = q('[data-mv-summary]'); if (b) { b.innerHTML = summaryCard(S.person, (S.path && S.path.summary) || {}); hydrateLottie(b); } }
  function paintRange() {
    var f = q('[data-mv-rangefill]'), v = q('[data-mv-rangeval]');
    if (f) setVars(f, { '--mv-a': (100 * S.from / 1439).toFixed(2) + '%', '--mv-b': (100 * S.to / 1439).toFixed(2) + '%' });
    if (v) v.textContent = hm(S.from) + ' – ' + hm(S.to);
  }
  function renderResults(list, label) {
    var box = q('[data-mv-results]'); if (!box) return;
    if (list == null) { box.innerHTML = ''; box.classList.remove('is-open'); return; }
    box.classList.add('is-open');
    box.innerHTML = (label ? '<div class="mv-results-label">' + esc(label) + '</div>' : '') + (list.length
      ? '<div class="kj-list">' + list.map(function (p, i) {
          return '<button type="button" class="kj-list-item mv-result" data-mv-pick="' + i + '">' + avatar(p.photo, p.name) +
            '<span class="kj-list-main"><span class="kj-list-title kj-truncate">' + esc(p.name || ('#' + p.person_id)) + '</span>' +
            '<span class="kj-list-sub kj-truncate">' + esc([p.staff_id, p.department].filter(Boolean).join(' · ') || (p.known === false ? 'Unregistered face' : '')) + '</span></span>' + ico('chevron-right') + '</button>';
        }).join('') + '</div>'
      : '<div class="kj-help mv-results-none">No one matches “' + esc(S.q) + '”.</div>');
  }
  function searchPeople(qs) {
    if (!S.viewer) return;
    var seq = (S.qSeq = (S.qSeq || 0) + 1);
    get('/movement/people', { q: qs, limit: qs ? 12 : 6 }).then(function (d) {
      if (!S || seq !== S.qSeq) return;
      S.results = d.people || [];
      renderResults(S.results, qs ? '' : 'Recently seen');
    }).catch(function (e) {
      if (!S || seq !== S.qSeq) return;
      var box = q('[data-mv-results]'); if (box) { box.classList.add('is-open'); box.innerHTML = '<div class="kj-help mv-results-none">' + esc(e.message || 'Search failed') + '</div>'; }
    });
  }
  function pickPerson(p) {
    S.person = p; S.q = ''; S.results = null;
    stopPlay(); S.active = -1;
    renderSide();
    loadPath();
  }

  /* ── floor chips ───────────────────────────────────────────────────────── */
  function paintFloors() {
    var counts = {};
    ((S.path && S.path.floorplans) || []).forEach(function (f) { counts[f.id] = f.waypoints; });
    var plans = S.plans || [];
    var html = plans.length ? plans.map(function (p) {
      var on = p.id === S.planId;
      return '<button type="button" role="tab" aria-selected="' + on + '" class="mv-floor' + (on ? ' is-active' : '') + (p.active ? '' : ' is-inactive') + '" data-mv-act="plan" data-mv-plan="' + p.id + '">' +
        '<span class="kj-truncate">' + esc(p.name) + '</span>' + (counts[p.id] ? '<span class="mv-floor-n">' + counts[p.id] + '</span>' : '') +
        (p.active ? '' : '<span class="mv-floor-off">hidden</span>') + '</button>';
    }).join('') : (S.plans ? '<span class="kj-help">No floor plans</span>' : '<span class="kj-skel kj-skel-line is-short"></span>');
    [q('[data-mv-floors]'), q('[data-mv-floors2]')].forEach(function (b) { if (b) b.innerHTML = html; });
  }

  /* ── canvas: plan image + pins + heat + trail ──────────────────────────── */
  function renderCanvas() {
    var wrap = q('[data-mv-wrap]'); if (!wrap) return;
    var stage = q('[data-mv-stage]');
    if (stage) stage.classList.toggle('is-editing', !!S.edit);
    if (!S.plans) {
      wrap.innerHTML = '<div class="mv-canvas-skel"><span class="kj-skel kj-skel-block"></span><span class="mv-skel-label">' + ico('map') + 'Loading floor plans…</span></div>';
      return;
    }
    if (S.plansErr) {
      wrap.innerHTML = emptyBox({ lottie: 'error-alert', icon: 'cloud-off', title: 'Could not load floor plans', text: S.plansErr,
        actions: '<button type="button" class="kj-btn kj-btn-secondary" data-mv-act="reload-plans">' + ico('rotate-ccw') + 'Retry</button>' });
      hydrateLottie(wrap); return;
    }
    var plan = curPlan();
    if (!plan) {
      wrap.innerHTML = S.canManage
        ? emptyBox({ lottie: 'empty-box', icon: 'image-up', title: 'No floor plans yet — upload one',
            text: 'Upload a PNG, JPG or WebP drawing of the floor (up to 8 MB), then drag the cameras onto it.',
            actions: '<button type="button" class="kj-btn kj-btn-primary" data-mv-act="upload">' + ico('upload') + 'Upload Floor Plan</button>' +
              '<button type="button" class="kj-btn kj-btn-secondary" data-kj-nav="movement/log">' + ico('list') + 'Movement log</button>' })
        : emptyBox({ lottie: 'empty-box', icon: 'map', title: 'No floor plans yet',
            text: 'An administrator needs to upload the factory floor plan. The camera-to-camera log works meanwhile.',
            actions: '<button type="button" class="kj-btn kj-btn-primary" data-kj-nav="movement/log">' + ico('list') + 'Open movement log</button>' });
      hydrateLottie(wrap); return;
    }
    var w = Math.max(1, N(plan.width_px) || 1600), hgt = Math.max(1, N(plan.height_px) || 900);
    wrap.innerHTML =
      '<div class="mv-canvas' + (S.edit ? ' is-edit' : '') + (S.placing ? ' is-placing' : '') + '" data-mv-canvas>' +
        '<img class="mv-plan-img" src="' + esc(apiUrl(plan.image_url)) + '" alt="' + esc(plan.name) + ' floor plan" draggable="false" data-mv-img>' +
        '<div class="mv-img-skel kj-skel" data-mv-imgskel></div>' +
        '<div class="mv-layer mv-heat-layer" data-mv-heat></div>' +
        '<svg class="mv-trail" viewBox="0 0 ' + w + ' ' + hgt + '" preserveAspectRatio="none" aria-hidden="true" data-mv-svg></svg>' +
        '<div class="mv-layer mv-arrows" data-mv-arrows></div>' +
        '<div class="mv-layer mv-pins" data-mv-pins></div>' +
        '<div class="mv-layer mv-wps" data-mv-wps></div>' +
        (S.pathBusy ? '<div class="mv-busy"><span class="mv-busy-pill">' + ico('route') + 'Loading movement…</span></div>' : '') +
      '</div>';
    var cv = q('[data-mv-canvas]');
    setVars(cv, { '--mv-ar': w + ' / ' + hgt, '--mv-zoom': String(S.zoom) });
    var img = q('[data-mv-img]');
    if (img) {
      var done = function () { var s = q('[data-mv-imgskel]'); if (s) s.remove(); };
      img.addEventListener('load', done); img.addEventListener('error', function () { done(); cv.classList.add('is-img-error'); });
      if (img.complete && img.naturalWidth) done();
    }
    paintPins(); paintHeat(); paintTrail();
    var zv = q('[data-mv-zoomval]'); if (zv) zv.textContent = Math.round(S.zoom * 100) + '%';
  }
  function pinsOf(plan) { return (plan && plan.pins) || []; }
  function paintPins() {
    var box = q('[data-mv-pins]'), plan = curPlan(); if (!box || !plan) return;
    var activeWp = wps()[S.active];
    box.innerHTML = pinsOf(plan).map(function (p) {
      var hot = activeWp && activeWp.floorplan_id === plan.id && ((activeWp.pin_id && activeWp.pin_id === p.id) ||
        (Math.abs(N(activeWp.x_pct) - N(p.x_pct)) < 0.01 && Math.abs(N(activeWp.y_pct) - N(p.y_pct)) < 0.01));
      var cls = 'mv-pin' + (hot ? ' is-active' : '') + (p.camera_known === false ? ' is-unknown' : '') + (p.live ? ' is-live' : '');
      var title = (p.label || p.camera_id || 'Camera') + (p.location ? ' · ' + p.location : '');
      return '<button type="button" class="' + cls + '" data-mv-pin="' + p.id + '" data-x="' + N(p.x_pct) + '" data-y="' + N(p.y_pct) + '" title="' + esc(title) + '"' +
        (S.edit ? '' : ' data-kj-modal="' + esc(spec('mv-camera', p.id)) + '"' + seedAttr({ name: p.label, pin: p, plan: plan.name })) + '>' +
        '<span class="mv-pin-ico">' + ico('video') + '</span><span class="mv-pin-lbl">' + esc(p.label || p.camera_id || 'Camera') + '</span>' +
        (S.edit ? '<span class="mv-pin-grip">' + ico('move') + '</span>' : '') + '</button>';
    }).join('');
    position(box);
  }
  /** Apply data-x/data-y (0–100 %) as CSS custom properties. */
  function position(root) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-x]'), function (n) {
      setVars(n, { '--x': clamp(N(n.getAttribute('data-x')), 0, 100) + '%', '--y': clamp(N(n.getAttribute('data-y')), 0, 100) + '%' });
    });
  }
  function paintHeat() {
    var box = q('[data-mv-heat]'), plan = curPlan(); if (!box || !plan) return;
    box.classList.toggle('is-on', !!S.heat);
    if (!S.heat || !S.occ) { box.innerHTML = ''; return; }
    box.innerHTML = (S.occ.pins || []).filter(function (p) { return p.floorplan_id === plan.id; }).map(function (p) {
      var i = N(p.intensity);
      return '<button type="button" class="mv-heat' + (p.people ? '' : ' is-zero') + '" data-x="' + N(p.x_pct) + '" data-y="' + N(p.y_pct) + '" data-i="' + i + '"' +
        ' data-kj-modal="' + esc(spec('mv-camera', p.pin_id)) + '"' + seedAttr({ name: p.label }) +
        ' title="' + esc((p.label || '') + ': ' + p.people + ' people · ' + p.detections + ' detections in ' + S.occ.minutes + ' min') + '">' +
        '<span class="mv-heat-badge">' + ico('users') + N(p.people) + '</span></button>';
    }).join('');
    position(box);
    Array.prototype.forEach.call(box.querySelectorAll('[data-i]'), function (n) { setVars(n, { '--i': String(clamp(N(n.getAttribute('data-i')), 0, 1)) }); });
  }
  function planName(id) { var p = (S.plans || []).find(function (x) { return x.id === id; }); return p ? p.name : 'another plan'; }
  function paintTrail() {
    var plan = curPlan(), svg = q('[data-mv-svg]'), arrows = q('[data-mv-arrows]'), box = q('[data-mv-wps]');
    if (!plan || !svg || !box) return;
    var W = N(plan.width_px) || 1600, H = N(plan.height_px) || 900;
    var list = wps(), last = list.length ? list[list.length - 1].seq : 0;
    var on = list.map(function (w, i) { return { w: w, i: i }; }).filter(function (o) { return o.w.floorplan_id === plan.id; });
    // connecting path: consecutive waypoints that are both on this plan
    var segs = [], arrowHtml = '';
    for (var i = 0; i < list.length - 1; i++) {
      var a = list[i], b = list[i + 1];
      if (a.floorplan_id !== plan.id || b.floorplan_id !== plan.id) continue;
      var ax = N(a.x_pct) * W / 100, ay = N(a.y_pct) * H / 100, bx = N(b.x_pct) * W / 100, by = N(b.y_pct) * H / 100;
      if (Math.abs(ax - bx) < 0.5 && Math.abs(ay - by) < 0.5) continue;
      var todo = S.active >= 0 && i + 1 > S.active;
      segs.push('<path class="mv-seg' + (todo ? ' is-todo' : '') + '" d="M' + ax.toFixed(1) + ' ' + ay.toFixed(1) + ' L' + bx.toFixed(1) + ' ' + by.toFixed(1) + '" vector-effect="non-scaling-stroke"/>');
      var ang = Math.atan2(by - ay, bx - ax) * 180 / Math.PI;
      arrowHtml += '<span class="mv-arrow" data-x="' + ((N(a.x_pct) + N(b.x_pct)) / 2) + '" data-y="' + ((N(a.y_pct) + N(b.y_pct)) / 2) + '" data-a="' + ang.toFixed(1) + '">' + ico('chevron-right') + '</span>';
    }
    svg.innerHTML = segs.join('');
    arrows.innerHTML = arrowHtml;
    position(arrows);
    Array.prototype.forEach.call(arrows.querySelectorAll('[data-a]'), function (n) { setVars(n, { '--a': n.getAttribute('data-a') + 'deg' }); });
    // stacked waypoints on the same pin get an offset index
    var stackAt = {};
    var html = on.map(function (o) {
      var w = o.w, key = N(w.x_pct).toFixed(2) + ',' + N(w.y_pct).toFixed(2);
      var k = stackAt[key] = (stackAt[key] == null ? 0 : stackAt[key] + 1);
      var cls = 'mv-wp' + (w.seq === 1 ? ' is-start' : '') + (w.seq === last && last > 1 ? ' is-end' : '') + (o.i === S.active ? ' is-active' : '') + (S.active >= 0 && o.i < S.active ? ' is-done' : '');
      var hop = '';
      var nx = list[o.i + 1], pv = list[o.i - 1];
      if (nx && nx.floorplan_id && nx.floorplan_id !== plan.id) hop += '<button type="button" class="mv-hop" data-mv-act="plan" data-mv-plan="' + nx.floorplan_id + '" data-mv-goto="' + (o.i + 1) + '">' + ico('arrow-right') + esc(planName(nx.floorplan_id)) + '</button>';
      if (pv && pv.floorplan_id && pv.floorplan_id !== plan.id) hop += '<button type="button" class="mv-hop is-in" data-mv-act="plan" data-mv-plan="' + pv.floorplan_id + '" data-mv-goto="' + (o.i - 1) + '">from ' + esc(planName(pv.floorplan_id)) + '</button>';
      return '<div class="' + cls + '" data-x="' + N(w.x_pct) + '" data-y="' + N(w.y_pct) + '" data-k="' + k + '">' +
        '<button type="button" class="mv-wp-dot" data-mv-stop="' + w.seq + '" aria-label="Stop ' + w.seq + ' at ' + esc(w.label || w.camera_name || '') + ', ' + tHM(w.first_seen) + '">' + w.seq + '</button>' +
        '<button type="button" class="mv-wp-time" data-mv-stop="' + w.seq + '">' + tHM(w.first_seen) + '</button>' + hop + '</div>';
    }).join('');
    // the travelling playhead dot
    var aw = list[S.active];
    if (aw && aw.floorplan_id === plan.id) html += '<span class="mv-runner" data-mv-runner data-x="' + N(aw.x_pct) + '" data-y="' + N(aw.y_pct) + '"></span>';
    box.innerHTML = html;
    position(box);
    Array.prototype.forEach.call(box.querySelectorAll('[data-k]'), function (n) { setVars(n, { '--k': n.getAttribute('data-k') }); });
  }

  /* ── strip under the plan: other plans + unplaced detections ───────────── */
  function paintStrip() {
    var box = q('[data-mv-strip]'); if (!box) return;
    var plan = curPlan(), list = wps(), un = (S.path && S.path.unplaced) || [];
    if (!S.path || !plan) { box.innerHTML = ''; box.hidden = true; return; }
    var off = {};
    list.forEach(function (w) { if (w.floorplan_id !== plan.id) off[w.floorplan_id] = (off[w.floorplan_id] || 0) + 1; });
    var parts = Object.keys(off).map(function (id) {
      return '<button type="button" class="kj-chip is-primary mv-strip-chip" data-mv-act="plan" data-mv-plan="' + esc(id) + '">' + ico('layers') + off[id] + ' on ' + esc(planName(N(id))) + '</button>';
    });
    var unHtml = un.map(function (u, i) {
      return '<button type="button" class="kj-chip is-warn mv-strip-chip" data-mv-unplaced="' + i + '" title="' + esc((u.camera_name || u.camera_id || 'Camera') + ' · ' + tHM(u.first_seen) + '–' + tHM(u.last_seen)) + '">' +
        ico('map-pin-off') + esc(tHM(u.first_seen)) + ' · ' + esc(u.camera_name || u.camera_id || 'Camera') + '</button>';
    }).join('');
    if (!parts.length && !un.length) { box.innerHTML = ''; box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = (parts.length ? '<div class="mv-strip-row"><span class="mv-strip-label">' + ico('route') + 'Also on</span>' + parts.join('') + '</div>' : '') +
      (un.length ? '<div class="mv-strip-row" data-mv-unplaced-row><span class="mv-strip-label">' + ico('map-pin-off') + 'Not on this plan · ' + un.length + ' stop' + (un.length === 1 ? '' : 's') + ' at cameras without a pin</span>' + unHtml +
        (S.canManage ? '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-mv-act="edit-on">' + ico('crosshair') + 'Place cameras</button>' : '') + '</div>' : '');
  }

  /* ── heat control ──────────────────────────────────────────────────────── */
  function paintHeatCtl() {
    var box = q('[data-mv-heatctl]'); if (!box) return;
    if (!S.viewer || !curPlan()) { box.innerHTML = ''; return; }
    box.innerHTML = '<label class="mv-switch mv-switch-sm"><span>' + ico('flame') + 'Occupancy heat</span><input type="checkbox" data-mv-heat-toggle' + (S.heat ? ' checked' : '') + '>' +
      '<span class="mv-switch-track"><span class="mv-switch-knob"></span></span></label>' +
      (S.heat ? '<div class="mv-heat-mins">' + [15, 60, 240].map(function (m) {
        return '<button type="button" class="kj-chip' + (S.heatMin === m ? ' is-primary' : '') + '" data-mv-act="heat-min" data-mv-min="' + m + '">' + (m < 60 ? m + ' min' : (m / 60) + ' h') + '</button>';
      }).join('') + (S.occ ? '<span class="kj-chip">' + ico('users') + N(S.occ.total_people) + ' on site</span>' : '') + '</div>' : '');
  }
  function loadHeat() {
    if (!S || !S.heat || !curPlan()) return;
    get('/movement/occupancy', { minutes: S.heatMin, floorplan_id: S.planId }).then(function (d) {
      if (!S || !S.heat) return;
      S.occ = d; paintHeat(); paintHeatCtl();
    }).catch(function (e) { if (S) { toast('Occupancy: ' + (e.message || 'unavailable'), 'warn'); } });
  }
  function setHeat(on) {
    S.heat = !!on;
    clearInterval(S.heatT); S.heatT = null;
    if (S.heat) { loadHeat(); S.heatT = setInterval(loadHeat, 45000); }
    else S.occ = null;
    paintHeat(); paintHeatCtl();
  }

  /* ── data loading ──────────────────────────────────────────────────────── */
  function loadPlans(selectId) {
    S.plans = S.plans || null; S.plansErr = '';
    return get('/floorplans').then(function (d) {
      if (!S) return;
      S.plans = (d.floorplans || []).slice().sort(function (a, b) { return N(a.sort_order) - N(b.sort_order) || N(a.id) - N(b.id); });
      S.canManage = !!d.can_manage;
      var keep = selectId || S.planId;
      if (!S.plans.some(function (p) { return p.id === keep; })) {
        var firstActive = S.plans.find(function (p) { return p.active; }) || S.plans[0];
        keep = firstActive ? firstActive.id : null;
      }
      S.planId = keep;
      if (!S.canManage && S.edit) S.edit = false;
      paintAll();
    }).catch(function (e) {
      if (!S) return;
      S.plans = []; S.plansErr = e.message || 'Request failed';
      paintAll();
    });
  }
  function loadPath(quiet) {
    if (!S) return;
    if (S.viewer && !S.person) { S.path = null; paintAll(); return; }
    var seq = ++S.pathSeq;
    S.pathBusy = true; S.pathErr = '';
    if (!quiet) { renderCanvas(); paintSummary(); paintTimeline(); }
    var params = { date: S.date, from: hm(S.from), to: hm(S.to), floorplan_id: S.planId || '' };
    if (S.viewer && S.person) params.person_id = S.person.person_id;
    get('/movement/path', params).then(function (d) {
      if (!S || seq !== S.pathSeq) return;
      S.pathBusy = false; S.path = d;
      if (!S.viewer && d.person && !S.person) S.person = d.person;
      if (S.viewer && d.person && S.person && !S.person.photo && d.person.photo) S.person.photo = d.person.photo;
      // follow the trail: if nothing is on the current plan, jump to the first plan it touches
      var list = d.waypoints || [];
      if (!quiet && list.length && !list.some(function (w) { return w.floorplan_id === S.planId; })) S.planId = list[0].floorplan_id;
      if (S.active >= list.length) S.active = list.length - 1;
      paintAll();
      loadLog();
    }).catch(function (e) {
      if (!S || seq !== S.pathSeq) return;
      S.pathBusy = false; S.path = null;
      S.pathErr = e.status === 404 ? 'No movement record is available for this person.' : (e.message || 'Could not load the movement path');
      paintAll();
    });
  }
  function loadLog() {
    if (!S || !S.viewer) { paintLog(); return; }
    var seq = ++S.logSeq; S.logBusy = true; paintLog();
    var p = S.person;
    get('/movement/log', { from: S.date, to: S.date, q: p ? (p.name || p.staff_id || '') : '' }).then(function (d) {
      if (!S || seq !== S.logSeq) return;
      S.logBusy = false; S.log = d; paintLog();
    }).catch(function () { if (!S || seq !== S.logSeq) return; S.logBusy = false; S.log = { moves: [], err: true }; paintLog(); });
  }
  function paintAll() {
    if (!S) return;
    paintFloors(); renderCanvas(); paintStrip(); paintHeatCtl(); paintSummary(); paintTimeline(); paintEditor(); paintLog(); paintAdmin();
  }
  function paintAdmin() {
    var a = q('[data-mv-admin]'); if (a) a.hidden = !S.canManage;
    var e = q('[data-mv-edit]'); if (e) e.checked = !!S.edit;
  }

  /* ── timeline scrubber ─────────────────────────────────────────────────── */
  function domain() {
    var list = wps();
    var lo = S.from, hi = S.to;
    if (list.length) {
      var a = minOf(list[0].first_seen), b = minOf(list[list.length - 1].last_seen);
      var padM = Math.max(10, (b - a) * 0.06);
      lo = Math.max(S.from, Math.floor((a - padM) / 10) * 10);
      hi = Math.min(S.to + 1, Math.ceil((b + padM) / 10) * 10);
      if (hi - lo < 30) { hi = Math.min(1440, lo + 30); }
    }
    return [lo, Math.max(lo + 1, hi)];
  }
  function pctOf(min, d) { return clamp(100 * (min - d[0]) / (d[1] - d[0]), 0, 100); }
  function ticks(d) {
    var span = d[1] - d[0], steps = [5, 10, 15, 20, 30, 60, 120, 180, 240];
    var st = steps.find(function (s) { return span / s <= 9; }) || 360;
    var out = [], t = Math.ceil(d[0] / st) * st;
    for (; t <= d[1]; t += st) out.push(t);
    return out;
  }
  function paintTimeline() {
    var box = q('[data-mv-timeline]'); if (!box) return;
    var list = wps(), d = domain(), sm = (S.path && S.path.summary) || {};
    var head = '<div class="mv-tl-head"><h3 class="mv-tl-title">Movement timeline</h3>' +
      '<span class="mv-tl-meta">' + ico('calendar') + esc(fmtDay(S.date)) + '</span><span class="mv-tl-sep"></span>' +
      '<span class="mv-tl-meta">' + ico('footprints') + N(sm.detections) + ' detections · ' + list.length + ' stop' + (list.length === 1 ? '' : 's') + '</span>' +
      '<span class="kj-spacer"></span>' +
      (list.length ? '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-mv-act="restart">' + ico('skip-back') + 'Restart</button>' : '') + '</div>';
    if (S.viewer && !S.person) {
      box.innerHTML = head + emptyBox({ lottie: 'face-scan', icon: 'scan-face', cls: 'mv-tl-empty', title: 'Choose someone to replay',
        text: 'Their detections become numbered stops on the plan and thumbnails along this track.' });
      hydrateLottie(box); return;
    }
    if (S.pathBusy && !S.path) {
      box.innerHTML = head + '<div class="mv-tl-skel">' + [0, 1, 2, 3, 4].map(function () { return '<span class="kj-skel kj-skel-tile"></span>'; }).join('') + '</div><span class="kj-skel kj-skel-line"></span>';
      return;
    }
    if (S.pathErr) {
      box.innerHTML = head + emptyBox({ lottie: 'error-alert', icon: 'cloud-off', cls: 'mv-tl-empty', title: 'Movement unavailable', text: S.pathErr,
        actions: '<button type="button" class="kj-btn kj-btn-secondary" data-mv-act="reload-path">' + ico('rotate-ccw') + 'Retry</button>' });
      hydrateLottie(box); return;
    }
    if (!list.length) {
      var un = (S.path && S.path.unplaced) || [];
      box.innerHTML = head + emptyBox({ lottie: 'empty-box', icon: 'footprints', cls: 'mv-tl-empty', title: 'No movement found',
        text: un.length ? un.length + ' stop(s) were seen at cameras that are not placed on a floor plan yet — listed under the plan.'
          : 'No detections for ' + ((S.person && S.person.name) || 'this person') + ' on ' + fmtDay(S.date) + ' between ' + hm(S.from) + ' and ' + hm(S.to) + '.',
        actions: '<button type="button" class="kj-btn kj-btn-secondary" data-mv-act="range" data-mv-range-key="all">' + ico('clock') + 'Whole day</button>' +
          '<button type="button" class="kj-btn kj-btn-secondary" data-mv-act="day-back">' + ico('calendar') + 'Previous day</button>' });
      hydrateLottie(box); return;
    }
    var cur = S.cursor != null ? S.cursor : (S.active >= 0 ? minOf(list[S.active].first_seen) : d[0]);
    var thumbs = list.map(function (w, i) {
      var img = w.thumb ? '<img src="' + esc(apiUrl(w.thumb)) + '" alt="" loading="lazy">' : '<span class="mv-thumb-ph">' + ico('scan-face') + '</span>';
      return '<button type="button" class="mv-thumb' + (i === S.active ? ' is-active' : '') + (w.seq === 1 ? ' is-start' : '') + (i === list.length - 1 && list.length > 1 ? ' is-end' : '') + '" data-mv-stop="' + w.seq + '" data-p="' + pctOf(minOf(w.first_seen), d).toFixed(2) + '">' +
        '<span class="mv-thumb-cap">' + w.seq + ' · ' + esc(w.label || w.camera_name || 'Camera') + '</span>' + img +
        '<span class="mv-thumb-time">' + tHM(w.first_seen) + '</span></button>';
    }).join('');
    var marks = list.map(function (w, i) {
      return '<button type="button" class="mv-mark' + (i === S.active ? ' is-active' : '') + (S.active >= 0 && i < S.active ? ' is-done' : '') + '" data-mv-stop="' + w.seq + '" data-p="' + pctOf(minOf(w.first_seen), d).toFixed(2) + '" aria-label="Stop ' + w.seq + '"></button>';
    }).join('');
    box.innerHTML = head +
      '<div class="mv-tl-body">' +
        '<div class="mv-tl-play"><button type="button" class="mv-play' + (S.playing ? ' is-playing' : '') + '" data-mv-act="play" aria-label="' + (S.playing ? 'Pause' : 'Play') + '">' + ico(S.playing ? 'pause' : 'play') + '</button>' +
          '<span class="mv-tl-clock"><b data-mv-clock>' + hm(cur) + '</b> / ' + hm(Math.min(1439, d[1])) + '</span></div>' +
        '<div class="mv-tl-scroll"><div class="mv-tl-inner" data-mv-tlinner>' +
          '<div class="mv-thumbs" data-mv-thumbs>' + thumbs + '</div>' +
          '<div class="mv-track" data-mv-track role="slider" tabindex="0" aria-label="Timeline" aria-valuemin="' + d[0] + '" aria-valuemax="' + d[1] + '" aria-valuenow="' + Math.round(cur) + '" aria-valuetext="' + hm(cur) + '">' +
            '<div class="mv-track-rail"></div><div class="mv-track-fill" data-mv-fill></div>' + marks +
            '<span class="mv-head-mark" data-mv-headmark><span>' + hm(cur) + '</span></span>' +
          '</div>' +
          '<div class="mv-ticks">' + ticks(d).map(function (t) { return '<span data-p="' + pctOf(t, d).toFixed(2) + '">' + hm(t) + '</span>'; }).join('') + '</div>' +
        '</div></div>' +
      '</div>';
    var inner = q('[data-mv-tlinner]');
    if (inner) setVars(inner, { '--mv-n': String(list.length) });
    Array.prototype.forEach.call(box.querySelectorAll('.mv-mark[data-p], .mv-ticks [data-p]'), function (n) { setVars(n, { '--p': n.getAttribute('data-p') + '%' }); });
    layoutThumbs();
    setCursor(cur);
  }
  /** Thumbs sit above their time; a sweep keeps them from overlapping. */
  function layoutThumbs() {
    var box = q('[data-mv-thumbs]'); if (!box) return;
    var items = Array.prototype.slice.call(box.querySelectorAll('.mv-thumb'));
    if (!items.length) return;
    var width = box.clientWidth || 0;
    var gap = width ? 100 * 132 / width : 100 / items.length;
    var half = gap / 2;
    var pos = items.map(function (n) { return N(n.getAttribute('data-p')); });
    for (var i = 0; i < pos.length; i++) pos[i] = Math.max(pos[i], half, i ? pos[i - 1] + gap : half);
    for (var j = pos.length - 1; j >= 0; j--) pos[j] = Math.min(pos[j], 100 - half, j < pos.length - 1 ? pos[j + 1] - gap : 100 - half);
    items.forEach(function (n, k) { setVars(n, { '--p': clamp(pos[k], 0, 100).toFixed(2) + '%' }); });
  }
  function setCursor(min) {
    var d = domain(), p = pctOf(min, d);
    var hmEl = q('[data-mv-headmark]'), fill = q('[data-mv-fill]'), clock = q('[data-mv-clock]'), tr = q('[data-mv-track]');
    if (hmEl) { setVars(hmEl, { '--p': p.toFixed(2) + '%' }); hmEl.firstChild.textContent = hm(min); }
    if (fill) setVars(fill, { '--p': p.toFixed(2) + '%' });
    if (clock) clock.textContent = hm(min);
    if (tr) { tr.setAttribute('aria-valuenow', String(Math.round(min))); tr.setAttribute('aria-valuetext', hm(min)); }
  }
  /** Make waypoint i the active stop: highlight pin + thumb, follow it across plans. */
  function activate(i, o) {
    o = o || {};
    var list = wps(); if (!list.length) return;
    i = clamp(i, 0, list.length - 1);
    S.active = i;
    var w = list[i];
    if (!o.keepCursor) S.cursor = minOf(w.first_seen);
    if (w.floorplan_id && w.floorplan_id !== S.planId) { S.planId = w.floorplan_id; paintFloors(); renderCanvas(); paintStrip(); paintHeatCtl(); if (S.heat) loadHeat(); }
    else { paintPins(); paintTrail(); }
    Array.prototype.forEach.call((S.el.querySelectorAll('.mv-thumb, .mv-mark')), function (n) {
      var seq = N(n.getAttribute('data-mv-stop')), idx = list.findIndex(function (x) { return x.seq === seq; });
      n.classList.toggle('is-active', idx === i);
      n.classList.toggle('is-done', idx < i && n.classList.contains('mv-mark'));
    });
    setCursor(S.cursor != null ? S.cursor : minOf(w.first_seen));
    var th = q('.mv-thumb.is-active');
    if (th && th.scrollIntoView && o.scroll !== false) { try { th.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); } catch (e) { /* old browsers */ } }
  }
  function stopPlay() {
    if (!S) return;
    S.playing = false; clearInterval(S.playT); S.playT = null;
    var b = q('[data-mv-act="play"]'); if (b) { b.classList.remove('is-playing'); b.innerHTML = ico('play'); b.setAttribute('aria-label', 'Play'); }
  }
  function togglePlay() {
    var list = wps(); if (!list.length) return;
    if (S.playing) { stopPlay(); return; }
    S.playing = true;
    var b = q('[data-mv-act="play"]'); if (b) { b.classList.add('is-playing'); b.innerHTML = ico('pause'); b.setAttribute('aria-label', 'Pause'); }
    var d = domain();
    if (S.active >= list.length - 1 || S.active < 0) { S.cursor = minOf(list[0].first_seen); activate(0, { keepCursor: true }); }
    // continuous clock: whole track in ~1.4 s per stop (min 6 s); stops activate as the clock passes them
    var total = Math.max(6000, list.length * 1400), stepMs = 80, perStep = (d[1] - d[0]) * stepMs / total;
    S.playT = setInterval(function () {
      if (!S) return;
      S.cursor = Math.min(d[1], (S.cursor == null ? d[0] : S.cursor) + perStep);
      var idx = -1;
      for (var k = 0; k < list.length; k++) if (minOf(list[k].first_seen) <= S.cursor + 1e-6) idx = k;
      if (idx !== S.active && idx >= 0) activate(idx, { keepCursor: true });
      else setCursor(S.cursor);
      if (S.cursor >= Math.min(d[1], minOf(list[list.length - 1].last_seen) + 1)) { activate(list.length - 1, { keepCursor: true }); stopPlay(); }
    }, stepMs);
  }
  function scrubAt(clientX) {
    var tr = q('[data-mv-track]'); if (!tr) return;
    var r = tr.getBoundingClientRect(), d = domain();
    var p = r.width ? clamp((clientX - r.left) / r.width, 0, 1) : 0;
    var min = d[0] + p * (d[1] - d[0]);
    var list = wps(), idx = -1;
    for (var k = 0; k < list.length; k++) if (minOf(list[k].first_seen) <= min) idx = k;
    S.cursor = min;
    if (idx >= 0) activate(idx, { keepCursor: true, scroll: false }); else setCursor(min);
  }

  /* ── drill-down list below the canvas ──────────────────────────────────── */
  function paintLog() {
    var box = q('[data-mv-log]'); if (!box) return;
    var list = wps(), un = (S.path && S.path.unplaced) || [];
    var stops = list.map(function (w) { return { w: w, placed: true }; }).concat(un.map(function (u, i) { return { w: u, placed: false, i: i }; }))
      .sort(function (a, b) { return String(a.w.first_seen).localeCompare(String(b.w.first_seen)); });
    var stopRows = stops.length ? '<div class="kj-table-wrap"><table class="kj-table mv-table"><thead><tr><th>#</th><th>Arrived</th><th>Left</th><th>Camera</th><th>Plan</th><th class="kj-num">Dwell</th><th class="kj-num">Detections</th></tr></thead><tbody>' +
      stops.map(function (s) {
        var w = s.w;
        var attr = s.placed ? 'data-mv-stop="' + w.seq + '"' : 'data-mv-unplaced="' + s.i + '"';
        return '<tr ' + attr + ' tabindex="0" class="mv-row' + (s.placed ? '' : ' is-unplaced') + '"><td>' + (s.placed ? '<span class="mv-row-seq">' + w.seq + '</span>' : ico('map-pin-off')) + '</td>' +
          '<td class="kj-mono">' + tHM(w.first_seen) + '</td><td class="kj-mono">' + tHM(w.last_seen) + '</td>' +
          '<td>' + esc(w.label || w.camera_name || w.camera_id || '—') + (w.location ? '<div class="kj-list-sub">' + esc(w.location) + '</div>' : '') + '</td>' +
          '<td>' + (s.placed ? esc(w.floorplan_name || planName(w.floorplan_id)) : '<span class="kj-chip is-warn">No pin</span>') + '</td>' +
          '<td class="kj-num">' + dwell(w.dwell_s) + '</td><td class="kj-num">' + N(w.count) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '';
    var movesHtml = '';
    if (S.viewer) {
      var mv = (S.log && S.log.moves) || [];
      movesHtml = '<div class="mv-log-sub"><div class="kj-section-title">Camera-to-camera moves · ' + esc(fmtDay(S.date)) + (S.person ? ' · ' + esc(S.person.name || '') : ' · everyone') + '</div>' +
        (S.logBusy ? '<span class="kj-skel kj-skel-line"></span><span class="kj-skel kj-skel-line is-mid"></span>'
          : (mv.length ? '<div class="kj-list mv-moves">' + mv.slice(0, 25).map(function (m) {
              return '<button type="button" class="kj-list-item" data-kj-modal="' + esc(m.personId ? spec('person', m.personId) : '') + '"' + seedAttr({ name: m.name }) + '>' +
                '<span class="mv-move-time kj-mono">' + esc(String(m.arrivedAt || '').slice(11, 16)) + '</span>' +
                '<span class="kj-list-main"><span class="kj-list-title kj-truncate">' + esc(m.name || ('#' + m.personId)) + '</span>' +
                '<span class="kj-list-sub kj-truncate">' + esc(m.from || '?') + ' → ' + esc(m.to || '?') + (m.gapMin != null ? ' · ' + esc(m.gapMin < 1 ? '< 1 min' : m.gapMin + ' min') : '') + '</span></span>' + ico('chevron-right') + '</button>';
            }).join('') + '</div>'
            : '<div class="kj-help">' + (S.log && S.log.err ? 'The movement log could not be loaded.' : 'No camera-to-camera moves on this day' + (S.person ? ' for this person' : '') + '.') + '</div>')) + '</div>';
    }
    box.innerHTML = '<div class="kj-card-head mv-log-head"><div><div class="kj-card-title">' + ico('list') + 'Stops &amp; movement log</div>' +
        '<div class="kj-card-sub">Every stop on the trail, including cameras that are not on a plan. Click a row for details.</div></div>' +
        (S.viewer ? '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-kj-nav="movement/log">' + ico('external-link') + 'Full movement log</button>' : '') + '</div>' +
      (stops.length ? stopRows : (S.person || !S.viewer ? '<div class="kj-help mv-log-none">' + (S.pathBusy ? 'Loading stops…' : 'No stops in the selected window.') + '</div>' : '')) + movesHtml;
  }

  /* ── admin editor (can_manage only) ────────────────────────────────────── */
  function paintEditor() {
    var box = q('[data-mv-editor]'); if (!box) return;
    if (!S.canManage || !S.edit) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    var plan = curPlan();
    var placed = {}; pinsOf(plan).forEach(function (p) { placed[p.camera_id] = p; });
    var cams = S.cams;
    var camHtml = cams == null ? '<span class="kj-skel kj-skel-line"></span><span class="kj-skel kj-skel-line is-mid"></span>'
      : (cams.length ? cams.map(function (c) {
          var here = placed[c.id], elsewhere = (c.pins || []).filter(function (x) { return !plan || x.floorplan_id !== plan.id; }).length;
          return '<div class="mv-cam' + (here ? ' is-placed' : '') + (S.placing === c.id ? ' is-placing' : '') + '"' + (here ? '' : ' draggable="true" data-mv-drag="' + esc(c.id) + '"') + '>' +
            '<span class="mv-cam-ico' + (c.online === false ? ' is-off' : '') + '">' + ico('video') + '</span>' +
            '<span class="kj-list-main"><span class="kj-list-title kj-truncate">' + esc(c.name || c.id) + '</span><span class="kj-list-sub kj-truncate">' +
              esc([c.location, c.origin, elsewhere ? 'on ' + elsewhere + ' other plan' + (elsewhere > 1 ? 's' : '') : ''].filter(Boolean).join(' · ') || c.id) + '</span></span>' +
            (here ? '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kj-modal="' + esc(spec('mv-pin', here.id)) + '">' + ico('pencil') + 'Edit</button>'
              : '<button type="button" class="kj-btn kj-btn-soft kj-btn-sm" data-mv-act="place" data-mv-cam="' + esc(c.id) + '">' + ico(S.placing === c.id ? 'x' : 'crosshair') + (S.placing === c.id ? 'Cancel' : 'Place') + '</button>') +
          '</div>';
        }).join('') : '<div class="kj-help">No cameras are configured. Add streams under Settings → Live Video.</div>');
    var plansHtml = (S.plans || []).map(function (p, i, arr) {
      return '<div class="mv-planrow' + (p.id === S.planId ? ' is-current' : '') + '">' +
        '<button type="button" class="mv-planrow-main" data-mv-act="plan" data-mv-plan="' + p.id + '">' + ico('layers') + '<span class="kj-truncate">' + esc(p.name) + '</span>' +
          (p.active ? '' : '<span class="kj-chip">hidden</span>') + '<span class="kj-muted">' + pinsOf(p).length + ' pins</span></button>' +
        '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon kj-btn-sm" data-mv-act="move-plan" data-mv-plan="' + p.id + '" data-mv-dir="-1" aria-label="Move up"' + (i ? '' : ' disabled') + '>' + ico('arrow-up') + '</button>' +
        '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon kj-btn-sm" data-mv-act="move-plan" data-mv-plan="' + p.id + '" data-mv-dir="1" aria-label="Move down"' + (i < arr.length - 1 ? '' : ' disabled') + '>' + ico('arrow-down') + '</button>' +
        '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon kj-btn-sm" data-kj-modal="' + esc(spec('mv-plan', p.id)) + '" aria-label="Plan settings">' + ico('pencil') + '</button></div>';
    }).join('');
    box.innerHTML = '<div class="mv-editor-grid">' +
      '<div class="mv-editor-col"><div class="mv-editor-title">' + ico('cctv') + 'Cameras' + (plan ? ' · ' + esc(plan.name) : '') + '</div>' +
        '<div class="kj-help">' + (S.placing ? 'Click on the plan where this camera is mounted.' : 'Drag a camera onto the plan (or press Place, then click the plan). Drag pins to move them; click a pin to rename or remove it.') + '</div>' +
        '<div class="mv-cams">' + camHtml + '</div></div>' +
      '<div class="mv-editor-col"><div class="mv-editor-title">' + ico('layers') + 'Floor plans</div>' +
        '<div class="mv-planrows">' + (plansHtml || '<div class="kj-help">No plans yet.</div>') + '</div>' +
        '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-mv-act="upload">' + ico('image-plus') + 'Add another plan</button></div>' +
    '</div>';
  }
  function setEdit(on) {
    S.edit = !!on && S.canManage; S.placing = '';
    if (S.edit) {
      stopPlay();
      if (S.cams == null) get('/floorplans/cameras').then(function (d) { if (S) { S.cams = d.cameras || []; paintEditor(); } })
        .catch(function (e) { if (S) { S.cams = []; paintEditor(); toast('Camera list: ' + (e.message || 'unavailable'), 'warn'); } });
    }
    paintAdmin(); renderCanvas(); paintEditor();
  }
  function refreshCams() { if (!S || !S.edit) return; get('/floorplans/cameras').then(function (d) { if (S) { S.cams = d.cameras || []; paintEditor(); } }).catch(function () { /* keep list */ }); }
  function pctFromEvent(ev) {
    var cv = q('[data-mv-canvas]'); if (!cv) return null;
    var r = cv.getBoundingClientRect(); if (!r.width || !r.height) return null;
    return { x: +clamp(100 * (ev.clientX - r.left) / r.width, 0, 100).toFixed(3), y: +clamp(100 * (ev.clientY - r.top) / r.height, 0, 100).toFixed(3) };
  }
  function placeCamera(camId, pt) {
    var plan = curPlan(); if (!plan || !pt) return;
    S.placing = '';
    post('/floorplans/' + plan.id + '/pins', { camera_id: camId, x_pct: pt.x, y_pct: pt.y }).then(function () {
      toast('Camera placed', 'success');
      return loadPlans(plan.id).then(refreshCams);
    }).catch(function (e) { toast(e.message || 'Could not place the camera', 'danger'); paintEditor(); renderCanvas(); });
  }
  function upload(file, planId) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('Floor plan image must be 8 MB or smaller.', 'danger'); return; }
    var fd = new FormData(); fd.append('file', file);
    if (!planId) fd.append('name', String(file.name || 'Floor plan').replace(/\.[a-z0-9]+$/i, '').slice(0, 120));
    toast(planId ? 'Replacing image…' : 'Uploading floor plan…');
    post(planId ? '/floorplans/' + planId + '/image' : '/floorplans', fd).then(function (d) {
      var id = planId || (d.floorplan && d.floorplan.id) || d.id || null;
      toast(planId ? 'Image replaced — pins kept' : 'Floor plan uploaded', 'success');
      return loadPlans(id).then(function () { if (!planId && S && S.canManage && !S.edit) setEdit(true); });
    }).catch(function (e) { toast(e.message || 'Upload failed', 'danger'); });
  }
  function movePlan(id, dir) {
    var ids = (S.plans || []).map(function (p) { return p.id; }), i = ids.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    ids[i] = ids[j]; ids[j] = id;
    post('/floorplans/reorder', { ids: ids }).then(function () { return loadPlans(S.planId); })
      .catch(function (e) { toast(e.message || 'Could not reorder', 'danger'); });
  }

  /* pin drag (edit mode) — pointer events, POST on drop */
  function pinDown(ev, pinEl) {
    if (!S.edit || ev.button > 0) return;
    var plan = curPlan(); if (!plan) return;
    var pid = N(pinEl.getAttribute('data-mv-pin'));
    var start = { x: ev.clientX, y: ev.clientY }, moved = false, last = null;
    ev.preventDefault();
    try { pinEl.setPointerCapture(ev.pointerId); } catch (e) { /* jsdom */ }
    var move = function (e) {
      if (!moved && Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) < 4) return;
      moved = true; pinEl.classList.add('is-dragging');
      last = pctFromEvent(e); if (!last) return;
      setVars(pinEl, { '--x': last.x + '%', '--y': last.y + '%' });
    };
    var up = function () {
      pinEl.removeEventListener('pointermove', move); pinEl.removeEventListener('pointerup', up); pinEl.removeEventListener('pointercancel', up);
      pinEl.classList.remove('is-dragging');
      if (!moved) { if (window.KJModal) window.KJModal.open('mv-pin', pid); return; }
      if (!last) return;
      var p = pinsOf(plan).find(function (x) { return x.id === pid; });
      if (p) { p.x_pct = last.x; p.y_pct = last.y; pinEl.setAttribute('data-x', last.x); pinEl.setAttribute('data-y', last.y); }
      post('/floorplans/' + plan.id + '/pins/' + pid, { x_pct: last.x, y_pct: last.y }).then(function () { toast('Pin moved', 'success'); })
        .catch(function (e) { toast(e.message || 'Could not move the pin', 'danger'); loadPlans(plan.id); });
    };
    pinEl.addEventListener('pointermove', move); pinEl.addEventListener('pointerup', up); pinEl.addEventListener('pointercancel', up);
  }

  /* ── zoom ──────────────────────────────────────────────────────────────── */
  function setZoom(z) {
    S.zoom = clamp(Math.round(z * 100) / 100, 0.4, 4);
    var cv = q('[data-mv-canvas]'); if (cv) setVars(cv, { '--mv-zoom': String(S.zoom) });
    var zv = q('[data-mv-zoomval]'); if (zv) zv.textContent = Math.round(S.zoom * 100) + '%';
  }
  function fitZoom() {
    var vp = q('[data-mv-viewport]'), plan = curPlan();
    if (!vp || !plan || !vp.clientWidth || !vp.clientHeight) { setZoom(1); return; }
    var ar = (N(plan.width_px) || 16) / (N(plan.height_px) || 9);
    setZoom(Math.min(1, (vp.clientHeight * ar) / vp.clientWidth));
  }

  /* ── events (delegated on the page root) ───────────────────────────────── */
  function stopByAttr(t) {
    var seq = N(t.getAttribute('data-mv-stop'));
    var list = wps(), i = list.findIndex(function (w) { return w.seq === seq; });
    return i;
  }
  function openStop(i) {
    var w = wps()[i]; if (!w || !window.KJModal) return;
    window.KJModal.open('mv-stop', 'stop-' + w.seq, { name: (w.label || w.camera_name || 'Stop') + ' · ' + tHM(w.first_seen), wp: w, person: S.person || (S.path && S.path.person), date: S.date, plan: planName(w.floorplan_id) });
  }
  function onClick(ev) {
    var t = ev.target instanceof Element ? ev.target : null; if (!t || !S) return;
    if (t.closest('[data-kj-modal]') && !t.closest('[data-mv-act],[data-mv-stop],[data-mv-pick],[data-mv-unplaced]')) return;   // KJModal handles it
    var stop = t.closest('[data-mv-stop]');
    if (stop) {
      var i = stopByAttr(stop); if (i < 0) return;
      stopPlay();
      // first click on a thumb/marker activates; a click on the active one (or a waypoint on the plan / table row) opens details
      var isPlan = stop.closest('.mv-wp, .mv-summary-row, tr');
      if (isPlan || i === S.active) { activate(i, { scroll: false }); openStop(i); } else activate(i);
      return;
    }
    var pick = t.closest('[data-mv-pick]');
    if (pick) { var p = (S.results || [])[N(pick.getAttribute('data-mv-pick'))]; if (p) pickPerson(p); return; }
    var unp = t.closest('[data-mv-unplaced]');
    if (unp) {
      var u = ((S.path && S.path.unplaced) || [])[N(unp.getAttribute('data-mv-unplaced'))];
      if (u && window.KJModal) window.KJModal.open('mv-stop', 'unplaced-' + N(unp.getAttribute('data-mv-unplaced')), { name: (u.camera_name || u.camera_id || 'Camera') + ' · ' + tHM(u.first_seen), wp: u, person: S.person || (S.path && S.path.person), date: S.date, unplaced: true });
      return;
    }
    var a = t.closest('[data-mv-act]'); if (!a) {
      // click-to-place on the canvas
      if (S.edit && S.placing && t.closest('[data-mv-canvas]') && !t.closest('.mv-pin')) placeCamera(S.placing, pctFromEvent(ev));
      return;
    }
    var act = a.getAttribute('data-mv-act');
    switch (act) {
      case 'plan': {
        var id = N(a.getAttribute('data-mv-plan')); if (!id || id === S.planId && !a.hasAttribute('data-mv-goto')) return;
        S.planId = id; S.placing = '';
        var needRefetch = wps().some(function (w) { return (w.also_on || []).indexOf(id) >= 0; });
        paintFloors(); renderCanvas(); paintStrip(); paintHeatCtl(); paintEditor();
        if (S.heat) loadHeat();
        if (a.hasAttribute('data-mv-goto')) activate(N(a.getAttribute('data-mv-goto')), { scroll: false });
        if (needRefetch && S.path) loadPath(true);
        return;
      }
      case 'zoom-in': setZoom(S.zoom * 1.25); return;
      case 'zoom-out': setZoom(S.zoom / 1.25); return;
      case 'zoom-fit': fitZoom(); return;
      case 'fullscreen': {
        var vp = q('[data-mv-stage]');
        if (document.fullscreenElement) { document.exitFullscreen && document.exitFullscreen(); }
        else if (vp && vp.requestFullscreen) vp.requestFullscreen().catch(function () { /* denied */ });
        return;
      }
      case 'play': togglePlay(); return;
      case 'restart': stopPlay(); S.active = -1; S.cursor = null; paintTrail(); paintPins(); paintTimeline(); return;
      case 'clear-q': S.q = ''; S.results = null; renderSide(); var inp = q('[data-mv-q]'); if (inp) inp.focus(); return;
      case 'range': {
        var k = a.getAttribute('data-mv-range-key'), now = new Date(), nm = now.getHours() * 60 + now.getMinutes();
        var r = { all: [0, 1439], am: [360, 720], pm: [720, 1140], last2: [Math.max(0, nm - 120), Math.min(1439, nm)] }[k] || [0, 1439];
        if (k === 'last2' && S.date !== todayStr()) r = [1319, 1439];
        S.from = r[0]; S.to = r[1];
        var f = q('[data-mv-from]'), tt = q('[data-mv-to]'); if (f) f.value = S.from; if (tt) tt.value = S.to;
        paintRange(); loadPath(); return;
      }
      case 'day-back': {
        var dd = new Date(S.date + 'T00:00:00'); dd.setDate(dd.getDate() - 1); S.date = ymd(dd);
        var di = q('[data-mv-date]'); if (di) di.value = S.date; loadPath(); return;
      }
      case 'heat-min': S.heatMin = N(a.getAttribute('data-mv-min')) || 15; paintHeatCtl(); loadHeat(); return;
      case 'reload-plans': S.plans = null; renderCanvas(); loadPlans(); return;
      case 'reload-path': loadPath(); return;
      case 'scroll-strip': { var s = q('[data-mv-unplaced-row]') || q('[data-mv-strip]'); if (s && s.scrollIntoView) s.scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
      case 'upload': { var fi = q('[data-mv-file="new"]'); if (fi) { fi.value = ''; fi.click(); } return; }
      case 'edit-on': setEdit(true); return;
      case 'place': { var c = a.getAttribute('data-mv-cam'); S.placing = S.placing === c ? '' : c; paintEditor(); renderCanvas(); return; }
      case 'move-plan': movePlan(N(a.getAttribute('data-mv-plan')), N(a.getAttribute('data-mv-dir'))); return;
    }
  }
  function onInput(ev) {
    var t = ev.target; if (!S || !(t instanceof Element)) return;
    if (t.matches('[data-mv-q]')) {
      S.q = t.value;
      clearTimeout(S.qT);
      S.qT = setTimeout(function () { if (S) searchPeople(S.q.trim()); }, 250);
      return;
    }
    if (t.matches('[data-mv-from], [data-mv-to]')) {
      var f = q('[data-mv-from]'), to = q('[data-mv-to]');
      var a = N(f.value), b = N(to.value);
      if (a > b - 15) { if (t === f) { a = Math.max(0, b - 15); f.value = a; } else { b = Math.min(1439, a + 15); to.value = b; } }
      S.from = a; S.to = b; paintRange();
      clearTimeout(S.rT); S.rT = setTimeout(function () { if (S) loadPath(); }, 450);
    }
  }
  function onChange(ev) {
    var t = ev.target; if (!S || !(t instanceof Element)) return;
    if (t.matches('[data-mv-date]')) { if (t.value) { S.date = t.value; stopPlay(); S.active = -1; S.cursor = null; loadPath(); } return; }
    if (t.matches('[data-mv-edit]')) { setEdit(t.checked); return; }
    if (t.matches('[data-mv-heat-toggle]')) { setHeat(t.checked); return; }
    if (t.matches('[data-mv-file="new"]')) { upload(t.files && t.files[0]); return; }
  }
  function onFocusIn(ev) {
    var t = ev.target;
    if (S && t instanceof Element && t.matches('[data-mv-q]') && !S.q && S.results == null) searchPeople('');
  }
  function onKey(ev) {
    var t = ev.target; if (!S || !(t instanceof Element)) return;
    if (t.matches('[data-mv-q]') && ev.key === 'Enter' && S.results && S.results.length) { ev.preventDefault(); pickPerson(S.results[0]); return; }
    if (t.matches('[data-mv-q]') && ev.key === 'Escape') { S.results = null; renderResults(null); return; }
    if (t.matches('[data-mv-track]') && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')) { ev.preventDefault(); stopPlay(); activate((S.active < 0 ? 0 : S.active) + (ev.key === 'ArrowRight' ? 1 : -1), { scroll: false }); return; }
    if (t.matches('tr[data-mv-stop], tr[data-mv-unplaced]') && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); t.click(); }
  }
  function onPointerDown(ev) {
    var t = ev.target; if (!S || !(t instanceof Element)) return;
    var pin = t.closest('.mv-pin');
    if (pin && S.edit) { pinDown(ev, pin); return; }
    var tr = t.closest('[data-mv-track]');
    if (tr && !t.closest('.mv-mark')) {
      stopPlay(); scrubAt(ev.clientX);
      var mv = function (e) { scrubAt(e.clientX); };
      var up = function () { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); };
      document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
    }
  }
  function onDragStart(ev) {
    var t = ev.target; if (!S || !(t instanceof Element)) return;
    var c = t.closest('[data-mv-drag]'); if (!c || !ev.dataTransfer) return;
    ev.dataTransfer.setData('text/plain', 'kj-cam:' + c.getAttribute('data-mv-drag'));
    ev.dataTransfer.effectAllowed = 'copy';
    var cv = q('[data-mv-canvas]'); if (cv) cv.classList.add('is-drop');
  }
  function onDragOver(ev) { if (S && S.edit && ev.target instanceof Element && ev.target.closest('[data-mv-canvas]')) { ev.preventDefault(); if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'; } }
  function onDrop(ev) {
    var cv = q('[data-mv-canvas]'); if (cv) cv.classList.remove('is-drop');
    if (!S || !S.edit || !(ev.target instanceof Element) || !ev.target.closest('[data-mv-canvas]')) return;
    var v = ev.dataTransfer && ev.dataTransfer.getData('text/plain');
    if (!v || v.indexOf('kj-cam:') !== 0) return;
    ev.preventDefault();
    placeCamera(v.slice(7), pctFromEvent(ev));
  }
  function onDragEnd() { var cv = q('[data-mv-canvas]'); if (cv) cv.classList.remove('is-drop'); }
  function onDocClick(ev) {
    if (!S) return;
    var box = q('[data-mv-results]');
    if (box && box.classList.contains('is-open') && ev.target instanceof Element && !ev.target.closest('.mv-search, [data-mv-results]')) renderResults(null);
  }
  function onResize() { if (S) layoutThumbs(); }

  /* ── live player for the camera modal ──────────────────────────────────── */
  // The box always keeps its 16:9 size (movement.css). Video sources (relay / bridge /
  // HLS) get a watchdog; on failure the newest still frame / snapshot / detection thumb
  // is shown underneath a STREAM ERROR tag and a Retry button that starts a fresh
  // attempt (clearing app.js's relay give-up cache).
  var LIVE_WAIT_MS = 20000;            // no first frame within this → error + Retry
  var APP_WAIT_MS = 15000;             // window.KJApp may mount after a cold deep link
  function mseOk() { return !!(window.MediaSource || window.ManagedMediaSource) && typeof fetch === 'function'; }
  function getApp() { var a = window.KJApp || (S && S.app) || null; return a && typeof a.relayStart === 'function' ? a : null; }
  function startPlayer(box, live, fallback, layer) {
    live = live || {};
    var mode = live.mode || 'none', stream = live.stream || '';
    var v = box.querySelector('video'), im = box.querySelector('img');
    var stateEl = box.querySelector('[data-mv-livestate]');
    var retryBtn = box.querySelector('[data-mv-live-retry]');
    var dead = false, failed = false, timers = [], videoStop = null, stillStop = null, hb = null;

    var setState = function (s, text) {
      box.setAttribute('data-state', s);
      if (stateEl) stateEl.textContent = text;
      if (retryBtn) retryBtn.hidden = s !== 'error';
    };
    var later = function (fn, ms) { var t = setTimeout(function () { if (!dead) fn(); }, ms); timers.push(t); return t; };
    var clearTimers = function () { timers.forEach(clearTimeout); timers = []; };
    var play = function () { var p = v && v.play && v.play(); if (p && p.catch) p.catch(function () { /* autoplay */ }); };

    /* still / snapshot layer: live frames → camera snapshot → newest detection thumb */
    function stopStill() { if (stillStop) { stillStop(); stillStop = null; } }
    function showStill(cb) {
      stopStill();
      var srcs = [];
      if (live.still_url) srcs.push({ u: live.still_url, kind: 'frames' });
      if (live.snapshot_url) srcs.push({ u: live.snapshot_url, kind: 'snapshot' });
      if (fallback) srcs.push({ u: fallback, kind: 'thumb', abs: true });
      var i = 0, it = null, alive = true, ok = false, busy = false;
      stillStop = function () { alive = false; clearInterval(it); };
      var load = function () {
        if (!alive || dead || busy) return;
        var s = srcs[i];
        if (!s) { if (im) im.hidden = true; cb(null); return; }
        var url = s.abs ? s.u : apiUrl(s.u + (s.kind === 'frames' ? (s.u.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now() : ''));
        var pre = new Image();
        busy = true;
        pre.onload = function () {
          busy = false;
          if (!alive || dead) return;
          if (im) { im.src = url; im.hidden = false; }
          if (!ok) { ok = true; cb(s.kind); }
          if (s.kind === 'frames' && !it) it = setInterval(load, 1500);
        };
        pre.onerror = function () {
          busy = false;
          if (!alive || dead) return;
          if (ok && s.kind === 'frames') return;          // keep the last frame through a transient miss
          clearInterval(it); it = null; i++; load();
        };
        pre.src = url;
      };
      load();
    }

    /* failure → STREAM ERROR + Retry, newest still underneath */
    function fail(why) {
      if (dead || failed) return;
      failed = true;
      clearTimers();
      if (videoStop) { videoStop(); videoStop = null; }
      setState('error', why || 'STREAM ERROR');
      showStill(function (kind) {
        if (kind && failed) setState('error', (why || 'STREAM ERROR') + ' · ' + (kind === 'frames' ? 'STILL FRAMES' : 'SNAPSHOT'));
      });
    }

    /* video modes */
    var vOn = false;
    if (v && !v._mvBound) {
      v._mvBound = true;
      v.addEventListener('playing', function () { if (box._mvPlaying) box._mvPlaying(); });
      v.addEventListener('waiting', function () { if (box._mvWaiting) box._mvWaiting(); });
      v.addEventListener('error', function () { if (box._mvError) box._mvError(); });
    }
    box._mvPlaying = function () { if (!vOn || dead) return; clearTimers(); stopStill(); if (im) im.hidden = true; setState('live', 'LIVE'); };
    box._mvWaiting = function () { if (vOn && !dead && box.getAttribute('data-state') === 'live') setState('buffering', 'BUFFERING'); };
    box._mvError = function () {
      if (!vOn || dead) return;
      if (mode === 'relay' && !v._relay && !v.srcObject) return;   // relay taken over by another player — the heartbeat handles it
      if (v.getAttribute('src') || v.srcObject) fail('STREAM ERROR');
    };

    function resetVideo() {
      vOn = false;
      if (!v) return;
      if (v._hls) { try { v._hls.destroy(); } catch (e) { /* ignore */ } v._hls = null; }
      try { if (v.srcObject) v.srcObject = null; } catch (e) { /* ignore */ }
      try { v.pause(); } catch (e) { /* ignore */ }
      if (v.getAttribute('src')) { v.removeAttribute('src'); try { v.load(); } catch (e) { /* ignore */ } }
    }
    function startRelay(app) {
      if (app._relayFail) delete app._relayFail[stream];          // the modal always tries live afresh
      try { if (v.srcObject) v.srcObject = null; } catch (e) { /* ignore */ }
      vOn = true;
      app.relayStart(v, stream, function (s) { if (s === 'error') fail('STREAM ERROR'); });
    }
    function startVideo(app) {
      v.hidden = false; v.muted = true; v.playsInline = true; v.autoplay = true;
      later(function () { fail('NO SIGNAL'); }, LIVE_WAIT_MS);
      if (mode === 'relay') {
        startRelay(app);
        // Another player (e.g. the "Camera details" modal) can take over this camera's
        // single relay connection; mirror it while it lives, reconnect once it is gone.
        hb = setInterval(function () {
          if (dead || failed || !vOn || v._relay) return;
          if (layer && layer.classList.contains('is-covered')) return;
          var act = app._relayActive && app._relayActive[stream];
          if (act && !act.stopped && act.v && act.v !== v && document.contains(act.v)) {
            if (v._mvMirror !== act.v && typeof act.v.captureStream === 'function') {
              try { v.srcObject = act.v.captureStream(); v._mvMirror = act.v; play(); } catch (e) { v._mvMirror = null; }
            }
            return;
          }
          v._mvMirror = null;
          setState('connecting', 'RECONNECTING…');
          startRelay(app);
        }, 1000);
        videoStop = function () { clearInterval(hb); hb = null; try { app.relayStop(v); } catch (e) { /* ignore */ } v._mvMirror = null; resetVideo(); };
        return;
      }
      var url = live.url || '';
      if (!url) { fail('NO LIVE SOURCE'); return; }
      url = /^\/api\//.test(url) ? apiUrl(url) : url;
      vOn = true;
      videoStop = resetVideo;
      var isHls = /\.m3u8(?:[?#]|$)/i.test(url);
      if (!isHls || (v.canPlayType && v.canPlayType('application/vnd.apple.mpegurl'))) { v.src = url; play(); return; }
      var go = function () {
        if (dead || failed || !vOn) return;
        var Hc = window.Hls;
        if (!Hc || !Hc.isSupported()) { v.src = url; play(); return; }
        var hh = new Hc({ liveSyncDurationCount: 3 }); v._hls = hh;
        hh.on(Hc.Events.ERROR, function (e, d) { if (d && d.fatal) fail('STREAM ERROR'); });
        hh.loadSource(url); hh.attachMedia(v); play();
      };
      if (window.Hls) go(); else if (app && typeof app.loadHlsJs === 'function') app.loadHlsJs(go); else { v.src = url; play(); }
    }

    function start() {
      if (dead) return;
      failed = false;
      clearTimers(); stopStill();
      if (videoStop) { videoStop(); videoStop = null; }
      if (im) im.hidden = true;
      if (v) v.hidden = true;
      var videoMode = mode === 'relay' || mode === 'hls' || mode === 'bridge';
      // Relay needs Media Source Extensions; without it this browser gets still frames.
      if (videoMode && mode === 'relay' && !mseOk()) videoMode = false;
      if (!videoMode) {
        var wantLive = mode === 'still' || mode === 'relay';
        setState('connecting', wantLive ? 'CONNECTING…' : 'LOADING SNAPSHOT…');
        showStill(function (kind) {
          if (kind === 'frames') setState('live', 'LIVE · FRAMES');
          else if (kind) setState('still', kind === 'thumb' ? 'SNAPSHOT · LAST DETECTION' : 'SNAPSHOT');
          else if (wantLive) setState('error', mode === 'relay' ? 'LIVE NOT SUPPORTED HERE' : 'STREAM ERROR');
          else setState('none', 'NO LIVE SOURCE');
        });
        return;
      }
      if (!v) { fail('STREAM ERROR'); return; }
      setState('connecting', 'CONNECTING…');
      var app = getApp();
      if (app || mode !== 'relay') { startVideo(app); return; }
      // Cold deep link: the dashboard app has not mounted yet — wait for it instead of giving up.
      var waited = 0;
      var poll = function () {
        var a = getApp();
        if (a) { startVideo(a); return; }
        waited += 400;
        if (waited >= APP_WAIT_MS) { fail('PLAYER NOT READY'); return; }
        later(poll, 400);
      };
      later(poll, 400);
    }

    if (retryBtn) retryBtn.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); start(); });
    start();
    return function stop() {
      if (dead) return;
      dead = true;
      clearTimers(); stopStill();
      if (videoStop) { videoStop(); videoStop = null; }
      box._mvPlaying = box._mvWaiting = box._mvError = null;
    };
  }
  /** Stop players once their modal layer is gone (KJModal has no close hook). */
  function watchLayer(ctx, box, stop) {
    var seen = false;
    var t = setInterval(function () {
      var el = ctx.el, open = !!(el && el.classList.contains('is-open'));
      if (open) seen = true;
      // layer removed / closing (is-open dropped after it was set) or body re-rendered by a reload
      if (!el || !document.contains(el) || !ctx.body.contains(box) || (seen && !open)) { clearInterval(t); stop(); }
    }, 500);
  }
  /* ── modal types ───────────────────────────────────────────────────────── */
  /** Stat tile with block-level value/label (stacked). */
  function stat(icon, val, lbl, tone) {
    return '<div class="kj-stat' + (tone ? ' is-' + tone : '') + '"><span class="kj-stat-ico">' + ico(icon) + '</span>' +
      '<div class="mv-stat-txt"><div class="kj-stat-val">' + esc(val) + '</div><div class="kj-stat-lbl">' + esc(lbl) + '</div></div></div>';
  }
  var modalsDone = false;
  function registerModals() {
    if (modalsDone || !window.KJModal || !window.KJModal.register) return;
    modalsDone = true;
    var M = window.KJModal, H = M.h;

    // Camera pin → live view + recent detections (id = pin id)
    M.register('mv-camera', {
      kicker: 'Camera', icon: 'cctv', size: 'lg', skeleton: 'media',
      load: function (ctx) {
        var seed = ctx.data || {};
        return get('/floorplans/pins/' + encodeURIComponent(ctx.id) + '/live', { limit: 10 })
          .then(function (d) { return { live: d.live || null, recent: d.recent || [], pin: seed.pin || null }; })
          .catch(function (e) {
            if (e.status === 403 || e.status === 401) return { denied: true, pin: seed.pin || null, name: seed.name };
            throw e;
          });
      },
      render: function (ctx, d) {
        var live = d.live || {}, pin = d.pin || {};
        var name = live.name || pin.label || (ctx.data && ctx.data.name) || 'Camera';
        if (d.denied) {
          return { title: name, kicker: 'Camera' + (ctx.data && ctx.data.plan ? ' · ' + ctx.data.plan : ''), icon: 'cctv',
            body: H.empty('lock', 'Live view is for supervisors', 'Your movement trail still shows when you passed this camera.') +
              (pin.location ? '<div class="kj-card">' + H.kv([['Camera', name], ['Location', pin.location]]) + '</div>' : '') };
        }
        var online = live.online !== false;
        var cam = live.stream || pin.camera_id || '';
        var recent = d.recent.length ? '<div class="kj-list">' + d.recent.map(function (r) {
          return '<div class="kj-list-item">' +
            (r.thumb ? '<img class="kj-thumb" src="' + esc(apiUrl(r.thumb)) + '" alt="" loading="lazy" data-kj-modal="' + esc(spec('image', apiUrl(r.thumb))) + '"' + seedAttr({ label: (r.name || 'Detection') + ' · ' + r.time }) + '>' : '<span class="kj-thumb kj-stat-ico">' + ico('scan-face') + '</span>') +
            '<div class="kj-list-main"><div class="kj-list-title kj-truncate">' + (r.person_id ? H.link('person', r.person_id, r.name || ('#' + r.person_id), { name: r.name }) : esc(r.name || 'Unknown face')) + '</div>' +
            '<div class="kj-list-sub">' + esc(H.fmtTime(r.time)) + ' · ' + esc(H.ago(r.time)) + '</div></div>' +
            '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kj-modal="' + esc(spec('event', r.event_id)) + '"' + seedAttr({ title: 'Face detection', mod: 'face', camera: String(cam).toUpperCase(), ts: r.time, person: r.name, personId: r.person_id, image: r.thumb ? apiUrl(r.thumb) : null }) + '>' + ico('radar') + 'Event</button></div>';
        }).join('') + '</div>' : H.empty('scan-face', 'No recent faces', 'No face detections at this camera in the last 7 days.');
        var modeLbl = { hls: 'HLS', bridge: 'Live bridge', relay: 'Server relay', still: 'Still frames', none: 'No live source' }[live.mode] || live.mode || '—';
        return {
          title: name, kicker: 'Camera · ' + String(cam || '').toUpperCase(), icon: 'cctv', tone: online ? 'success' : 'danger',
          body: '<div class="mv-live" data-mv-live data-state="connecting">' +
              '<video muted playsinline hidden></video><img alt="' + esc(name) + ' live frame" hidden>' +
              '<span class="mv-live-ph">' + ico('video') + '</span>' +
              '<span class="mv-live-tag"><i></i><span data-mv-livestate>CONNECTING…</span></span>' +
              '<button type="button" class="kj-btn kj-btn-sm mv-live-retry" data-mv-live-retry hidden>' + ico('refresh-cw') + 'Retry</button>' +
              '<span class="mv-live-name">' + esc(name) + (live.location ? ' · ' + esc(live.location) : '') + '</span></div>' +
            '<div class="kj-grid-3">' + stat(online ? 'wifi' : 'wifi-off', online ? 'Online' : 'Offline', 'Camera status', online ? 'success' : 'danger') +
              stat('radio-tower', modeLbl, 'Live source', '') + stat('scan-face', String(d.recent.length), 'Recent faces · 7 d', 'purple') + '</div>' +
            H.section('Recent detections at this camera', recent) +
            H.section('Camera', '<div class="kj-card">' + H.kv([['Stream label', cam], ['Location', live.location || pin.location], ['Source', live.source], ['Pin', pin.label ? pin.label + ' (' + N(pin.x_pct).toFixed(1) + '%, ' + N(pin.y_pct).toFixed(1) + '%)' : null]]) + '</div>'),
          foot: (cam ? H.btn('cam', 'Camera details', 'info', 'kj-btn-secondary') : '') + (cam ? H.btn('page', 'Open camera page', 'external-link', 'kj-btn-primary') : ''),
          actions: {
            cam: function () { M.open('camera', cam); },
            page: H.viaApp(function (a) { a.openCamera(String(cam).toLowerCase()); })
          },
          mount: function (c) {
            var box = c.body.querySelector('[data-mv-live]');
            // newest detection thumb = last-resort still when live is unavailable
            var thumb = null;
            for (var i = 0; i < d.recent.length && !thumb; i++) if (d.recent[i].thumb) thumb = apiUrl(d.recent[i].thumb);
            if (box) watchLayer(c, box, startPlayer(box, live, thumb, c.el));
          }
        };
      }
    });

    // Waypoint / unplaced stop details (seeded; not deep-linkable)
    M.register('mv-stop', {
      kicker: 'Movement stop', icon: 'map-pin', size: 'md', skeleton: 'media', deepLink: false,
      load: function (ctx) { if (!ctx.data || !ctx.data.wp) throw new Error('This stop is no longer on screen'); return ctx.data; },
      render: function (ctx, d) {
        var w = d.wp, p = d.person || {};
        var img = w.thumb ? apiUrl(w.thumb) : null;
        var cam = w.camera_id || '';
        var body = H.media(img, (w.label || w.camera_name || 'Camera') + ' · ' + tHM(w.first_seen), w.seq ? H.chip('Stop ' + w.seq, w.seq === 1 ? 'success' : 'primary') : H.chip('Not on a plan', 'warn')) +
          '<div class="kj-grid-3">' + stat('clock', tHM(w.first_seen) + '–' + tHM(w.last_seen), 'Arrived – left', '') +
            stat('timer', dwell(w.dwell_s), 'Dwell', 'purple') + stat('scan-face', String(N(w.count)), 'Detections', 'success') + '</div>' +
          '<div class="kj-card">' + H.kv([
            ['Person', p.person_id ? H.link('person', p.person_id, p.name || ('#' + p.person_id), { name: p.name }) : esc(p.name || '—'), true],
            ['Camera', w.label || w.camera_name || cam],
            ['Location', w.location],
            ['Floor plan', d.unplaced ? 'Not placed on any plan' : (w.floorplan_name || d.plan)],
            ['Date', fmtDay(d.date)],
            w.also_on && w.also_on.length ? ['Also on', w.also_on.length + ' other plan(s)'] : null
          ]) + '</div>' +
          (d.unplaced ? '<div class="kj-help">' + ico('map-pin-off') + ' This camera has no pin yet, so the stop cannot be drawn on a plan. An administrator can place it with “Edit Camera Positions”.</div>' : '');
        var foot = '';
        var actions = {};
        if (w.event_id) {
          foot += H.btn('ev', 'Open detection', 'radar', 'kj-btn-secondary');
          actions.ev = function () { M.open('event', String(w.event_id), { title: 'Face detection · ' + (w.camera_name || cam), mod: 'face', camera: String(cam).toUpperCase(), ts: w.first_seen, person: p.name, personId: p.person_id, image: img, location: w.location }); };
        }
        if (w.pin_id) { foot += H.btn('live', 'Live camera', 'video', 'kj-btn-primary'); actions.live = function () { M.open('mv-camera', w.pin_id, { name: w.label }); }; }
        else if (cam) { foot += H.btn('cam', 'Camera details', 'cctv', 'kj-btn-primary'); actions.cam = function () { M.open('camera', cam); }; }
        return { title: (w.label || w.camera_name || 'Camera') + ' · ' + tHM(w.first_seen), kicker: w.seq ? 'Stop ' + w.seq + ' · ' + (p.name || '') : 'Unplaced stop', icon: 'map-pin',
          tone: d.unplaced ? 'warn' : (w.seq === 1 ? 'success' : ''), body: body, foot: foot, actions: actions };
      }
    });

    // Admin: plan settings — rename, show/hide, replace image, delete
    M.register('mv-plan', {
      kicker: 'Floor plan', icon: 'layers', size: 'md', deepLink: false,
      load: function (ctx) {
        var p = S && (S.plans || []).find(function (x) { return String(x.id) === String(ctx.id); });
        if (!p) throw new Error('Open the Movement page to manage floor plans');
        if (!S.canManage) throw new Error('Only administrators can change floor plans');
        return p;
      },
      render: function (ctx, p) {
        return {
          title: p.name, kicker: 'Floor plan settings', icon: 'layers',
          body: '<div class="mv-plan-thumb"><img src="' + esc(apiUrl(p.image_url)) + '" alt="' + esc(p.name) + '"></div>' +
            '<div class="kj-field"><label class="kj-label" for="mv-plan-name">Name</label><input id="mv-plan-name" class="kj-input" maxlength="120" value="' + esc(p.name) + '" data-mv-plan-name></div>' +
            '<label class="mv-check"><input type="checkbox" data-mv-plan-active' + (p.active ? ' checked' : '') + '> Visible to everyone (inactive plans are hidden and ignored by movement)</label>' +
            '<div class="kj-card">' + H.kv([['Size', N(p.width_px) + ' × ' + N(p.height_px) + ' px'], ['Camera pins', String(pinsOf(p).length)], ['Updated', p.updated_at]]) + '</div>' +
            '<input type="file" class="kj-sr-only" accept="image/png,image/jpeg,image/webp" data-mv-plan-file aria-label="Replacement image">',
          foot: H.btn('del', 'Delete plan', 'trash-2', 'kj-btn-danger') + H.btn('img', 'Replace image', 'image-up', 'kj-btn-secondary') + H.btn('save', 'Save', 'check', 'kj-btn-primary'),
          actions: {
            save: function (c) {
              var nm = (c.body.querySelector('[data-mv-plan-name]') || {}).value || '';
              var ac = !!(c.body.querySelector('[data-mv-plan-active]') || {}).checked;
              if (!nm.trim()) { toast('Name is required', 'warn'); return; }
              post('/floorplans/' + p.id + '/update', { name: nm.trim(), active: ac ? 1 : 0 }).then(function () {
                toast('Floor plan saved', 'success'); c.close(); if (S) loadPlans(p.id);
              }).catch(function (e) { toast(e.message || 'Could not save', 'danger'); });
            },
            img: function (c) {
              var fi = c.body.querySelector('[data-mv-plan-file]'); if (!fi) return;
              fi.onchange = function () { var f = fi.files && fi.files[0]; if (f) { c.close(); upload(f, p.id); } };
              fi.click();
            },
            del: function (c) {
              if (!window.confirm('Delete “' + p.name + '” and its ' + pinsOf(p).length + ' camera pins? This cannot be undone.')) return;
              post('/floorplans/' + p.id + '/delete', {}).then(function () {
                toast('Floor plan deleted', 'success'); c.close(); if (S) { S.planId = null; loadPlans(); }
              }).catch(function (e) { toast(e.message || 'Could not delete', 'danger'); });
            }
          }
        };
      }
    });

    // Admin: pin edit — rename label, remove
    M.register('mv-pin', {
      kicker: 'Camera pin', icon: 'map-pin', size: 'sm', deepLink: false,
      load: function (ctx) {
        var plan = curPlan(), pin = plan && pinsOf(plan).find(function (x) { return String(x.id) === String(ctx.id); });
        if (!pin) throw new Error('Pin not found on the current plan');
        return { plan: plan, pin: pin };
      },
      render: function (ctx, d) {
        var p = d.pin;
        return {
          title: p.label || p.camera_id, kicker: 'Camera pin · ' + d.plan.name, icon: 'map-pin',
          body: '<div class="kj-field"><label class="kj-label" for="mv-pin-label">Label on the plan</label><input id="mv-pin-label" class="kj-input" maxlength="120" value="' + esc(p.label || '') + '" data-mv-pin-label>' +
              '<div class="kj-help">Leave empty to use the camera name.</div></div>' +
            '<div class="kj-card">' + H.kv([['Camera', p.camera_id], ['Location', p.location], ['Position', N(p.x_pct).toFixed(1) + '%, ' + N(p.y_pct).toFixed(1) + '%'],
              ['Status', p.camera_known === false ? 'Camera removed from config' : (p.live ? 'Live source available' : 'No live source')]]) + '</div>',
          foot: H.btn('del', 'Remove pin', 'trash-2', 'kj-btn-danger') + H.btn('live', 'Live view', 'video', 'kj-btn-secondary') + H.btn('save', 'Save', 'check', 'kj-btn-primary'),
          actions: {
            save: function (c) {
              var lbl = (c.body.querySelector('[data-mv-pin-label]') || {}).value || '';
              post('/floorplans/' + d.plan.id + '/pins/' + p.id, { label: lbl.trim() }).then(function () {
                toast('Pin saved', 'success'); c.close(); if (S) loadPlans(d.plan.id);
              }).catch(function (e) { toast(e.message || 'Could not save', 'danger'); });
            },
            live: function () { M.open('mv-camera', p.id, { name: p.label, pin: p, plan: d.plan.name }); },
            del: function (c) {
              if (!window.confirm('Remove “' + (p.label || p.camera_id) + '” from ' + d.plan.name + '?')) return;
              post('/floorplans/' + d.plan.id + '/pins/' + p.id + '/delete', {}).then(function () {
                toast('Pin removed', 'success'); c.close(); if (S) loadPlans(d.plan.id).then(refreshCams);
              }).catch(function (e) { toast(e.message || 'Could not remove', 'danger'); });
            }
          }
        };
      }
    });
  }
  registerModals();
  if (!modalsDone) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', registerModals);
    else setTimeout(registerModals, 0);
  }

  /** Open the floor-plan playback for a person (optionally on a given day). Used by showPerson and the Strangers tab. */
  function showOnPlan(p, day) {
    if (!p) return;
    window.KJPages.go('movement/playback');
    if (!S || !S.viewer) return;
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) { S.date = day; S.from = 0; S.to = 1439; stopPlay(); S.active = -1; S.cursor = null; }
    pickPerson(typeof p === 'object' ? p : { person_id: String(p), name: '#' + p });
  }

  /* ── mount / unmount ───────────────────────────────────────────────────── */
  var LISTEN = [['click', onClick], ['input', onInput], ['change', onChange], ['focusin', onFocusIn], ['keydown', onKey],
    ['pointerdown', onPointerDown], ['dragstart', onDragStart], ['dragover', onDragOver], ['drop', onDrop], ['dragend', onDragEnd]];
  function mountPlayback(el, app) {
    ensureCss(); registerModals();
    if (S) unmountPlayback();
    S = fresh(el, app);
    renderShell();
    LISTEN.forEach(function (l) { el.addEventListener(l[0], l[1]); });
    document.addEventListener('click', onDocClick);
    window.addEventListener('resize', onResize);
    renderSide(); paintAll();
    loadPlans().then(function () { if (S && !S.viewer) loadPath(); });
  }
  function unmountPlayback() {
    if (!S) return;
    stopPlay();
    clearInterval(S.heatT); clearTimeout(S.qT); clearTimeout(S.rT);
    LISTEN.forEach(function (l) { S.el.removeEventListener(l[0], l[1]); });
    document.removeEventListener('click', onDocClick);
    window.removeEventListener('resize', onResize);
    S = null;
  }

  window.KJPages.register('movement', {
    title: 'Movement',
    perm: 'view',
    defaultSub: 'playback',
    subs: {
      playback: { label: 'Floor plan', icon: 'map' },                     // M14 — host-mounted
      strangers: { label: 'Strangers', icon: 'user-search' },             // unregistered faces — movement-strangers.js
      log:      { label: 'Movement log',  legacy: 'movement' },           // legacy table (also the drill-down target)
      poc:      { label: 'POC scorecard', legacy: 'poc' }
    },

    enter: function (app, page) {
      if (page === 'movement') { app.loadMv(); }
      if (page === 'poc') app.loadPoc();                             // Workstream D: POC scorecard
    },
    mount: function (el, route, app) {
      if (route.sub === 'playback') mountPlayback(el, app);
      if (route.sub === 'strangers') {
        if (window.KJStrangers) window.KJStrangers.mount(el, app, { showOnPlan: showOnPlan });
        else el.innerHTML = '<div class="kj-page">' + window.KJPages.h.emptyState({ icon: 'user-search', title: 'Strangers could not load', text: 'Reload the page to try again.' }) + '</div>';
      }
    },
    unmount: function () { unmountPlayback(); if (window.KJStrangers) window.KJStrangers.unmount(); },
    onFeed: function (data, app, route) {
      if (route && route.sub === 'strangers') { if (window.KJStrangers) window.KJStrangers.onFeed(); return; }
      // today's trail refreshes quietly once a minute while nothing is being replayed
      if (!S || S.playing || S.edit || S.pathBusy || S.date !== todayStr() || (S.viewer && !S.person)) return;
      if (Date.now() - S.lastAuto < 60000) return;
      S.lastAuto = Date.now();
      loadPath(true);
    },
    /** Open the playback for a person from elsewhere: KJPages.get('movement').showPerson({person_id,name}). */
    showPerson: function (p, o) { showOnPlan(p, o && o.date); },

    // ── Legacy Component methods (verbatim from app.js; `this` is the dc app) ──
    methods: class {
  // ── Movement log (camera → camera) ──
  loadMv(patch){
    const st=this.state, today=new Date(), d=(x)=>x.getFullYear()+'-'+String(x.getMonth()+1).padStart(2,'0')+'-'+String(x.getDate()).padStart(2,'0');
    const f={from:st.mvFrom||d(new Date(today.getTime()-6*86400000)), to:st.mvTo||d(today), q:st.mvQ||'', unknown:!!st.mvUnknown, ...(patch||{})};
    this.setState({mvFrom:f.from, mvTo:f.to, mvQ:f.q, mvUnknown:f.unknown, mvBusy:true});
    const qs='from='+f.from+'&to='+f.to+(f.q?'&q='+encodeURIComponent(f.q):'')+(f.unknown?'&unknown=1':'');
    const seq=(this._mvSeq=(this._mvSeq||0)+1);
    fetch(`${this.API}/movement/log?${qs}&token=${this.TOK}`).then(r=>r.json())
      .then(d=>{ if(seq!==this._mvSeq) return; this.setState({mv:(d&&d.ok)?d:null, mvBusy:false, mvErr:(d&&d.ok)?'':((d&&d.error)||'Could not load movements')}); })
      .catch(()=>{ if(seq===this._mvSeq) this.setState({mvBusy:false, mvErr:'Could not load movements'}); });
  }
  mvVals(){
    const st=this.state, d=st.mv||{}, k=d.kpi||{};
    const fmtT=(t)=>String(t||'').slice(11,16), fmtD=(t)=>{ const x=new Date(String(t||'').replace(' ','T'));
      return isNaN(x)?String(t||'').slice(0,10):x.toLocaleDateString('en-GB',{day:'numeric',month:'short'}); };
    const gap=(m)=>m==null?'—':(m<1?'< 1 min':(m<60?m+' min':(Math.floor(m/60)+' h '+(m%60)+' min')));
    const routes=Array.isArray(d.routes)?d.routes:[], rMax=Math.max(1, ...routes.map(r=>r.n||0));
    const rows=(Array.isArray(d.moves)?d.moves:[]).map(m=>({time:fmtT(m.arrivedAt), date:fmtD(m.arrivedAt), kjm:m.personId?('person:'+encodeURIComponent(m.personId)):'',
      name:m.name||('#'+m.personId), staff:[m.staffId, m.department].filter(Boolean).join(' · ')||'—',
      from:m.from, fromSub:(m.fromCamera&&m.fromCamera!==m.from)?m.fromCamera:'left '+fmtT(m.leftAt),
      to:m.to, toSub:(m.toCamera&&m.toCamera!==m.to)?m.toCamera:'arrived '+fmtT(m.arrivedAt), gap:gap(m.gapMin)}));
    const top=routes[0];
    return {
      isMovement:st.page==='movement', mvFrom:st.mvFrom||'', mvTo:st.mvTo||'', mvQ:st.mvQ||'',
      onMvFrom:(e)=>this.loadMv({from:e.target.value}), onMvTo:(e)=>this.loadMv({to:e.target.value}),
      onMvQ:(e)=>{ const v=e.target.value; this.setState({mvQ:v}); clearTimeout(this._mvT); this._mvT=setTimeout(()=>this.loadMv({q:v}), 400); },
      mvUnknownCls:st.mvUnknown?'chip on':'chip', toggleMvUnknown:()=>this.loadMv({unknown:!st.mvUnknown}), reloadMv:()=>this.loadMv(),
      mvStatus:st.mvBusy?'Loading…':(st.mvErr||(d.truncated?'Showing the latest 500 moves':'')),
      mvKpis:[
        {label:'Camera-to-camera moves', value:String(k.moves||0), col:'var(--brand)', sub:(d.from&&d.to)?(d.from+' → '+d.to):'Selected range'},
        {label:'People moving', value:String(k.people||0), col:'var(--text)', sub:'with at least one move'},
        {label:'Cameras involved', value:String(k.cameras||0), col:'var(--text)', sub:(k.visits||0)+' camera visits'},
        {label:'Most common route', value:top?String(top.n):'—', col:'var(--ok)', sub:top?(top.from+' → '+top.to):'No moves yet'},
      ],
      mvHasRoutes:routes.length>0, mvRoutes:routes.map(r=>({label:r.from+' → '+r.to, n:r.n, w:Math.max(4, Math.round(100*r.n/rMax))+'%'})),
      mvRows:rows, mvEmpty:!st.mvBusy && rows.length===0,
      mvEmptyText:'No camera-to-camera movement in this range. Moves appear when the same person is recognised at two different cameras.',
    };
  }
  // ── POC Scorecard (/api/poc/*) ──
  loadPoc(){
    this.setState({pocBusy:true});
    this.wsdGet('/poc/scorecard').then(d=>this.setState({pocD:d, pocBusy:false}))
      .catch(e=>this.setState({pocBusy:false, pocMsg:'✗ Could not load the scorecard — '+e.message}));
  }
  pocSet(kind, key, field, val){
    this.setState(st=>{ const d=st.pocDraft;
      if(kind==='report') return {pocDraft:{...d, report:{...d.report, [field]:val}}, pocMsg:''};
      const grp={...(d[kind]||{})}; grp[key]={...(grp[key]||{}), [field]:val};
      return {pocDraft:{...d, [kind]:grp}, pocMsg:''}; });
  }
  pocDirtyCount(){ const d=this.state.pocDraft; return Object.keys(d.criteria).length+Object.keys(d.tests).length+(Object.keys(d.report).length?1:0); }
  pocSave(){
    if(!this.pocDirtyCount()){ this.setState({pocMsg:'Nothing to save'}); return; }
    this.setState({pocMsg:'Saving scorecard…'});
    this.wsdPost('/poc/scorecard', this.state.pocDraft)
      .then(()=>{ this.setState({pocDraft:{criteria:{}, tests:{}, report:{}}, pocMsg:'Scorecard saved ✓'}); this.loadPoc(); })
      .catch(e=>this.setState({pocMsg:'✗ '+e.message}));
  }
  pocExport(sheet){ window.open(`${this.API}/poc/export?token=${encodeURIComponent(this.TOK)}&sheet=${sheet}`, '_blank'); }
  pocPrint(){
    if(this.pocDirtyCount()) this.setState({pocMsg:'Unsaved changes are included in the printout — save them too'});
    this.setState({pocTab:'report'});
    setTimeout(()=>{ try{ document.body.classList.add('ppx-printing'); window.print(); }catch(e){}
      setTimeout(()=>{ try{ document.body.classList.remove('ppx-printing'); }catch(e){} }, 600); }, 250);
  }
  pocOpenDoc(name){
    if(this.state.pocDoc&&this.state.pocDoc.name===name){ this.setState({pocDoc:null}); return; }
    this.setState({pocDoc:{name, file:'', md:'Loading…'}});
    this.wsdGet('/poc/doc?name='+encodeURIComponent(name)).then(d=>this.setState({pocDoc:{name, file:d.file, md:d.markdown}}))
      .catch(e=>this.setState({pocDoc:{name, file:'', md:'Could not load: '+e.message}}));
  }
    }
  });
})();
