/* People hub — page module (assets/js/pages/people.js).
 * Owner: wave-2 people-directory agent
 * Absorbs legacy pages: employees (→ #people, now module-rendered), faces, face
 * Visual spec: docs/mockup-ui/generated/admin-people-hub.png
 *
 * Subs
 *   #people                 directory (mount): profile-card grid, KPI tiles, search + department chips,
 *                           Add Person (legacy newEmployee editor), Sync all (settings perm), pagination.
 *                           Card click → right-side detail drawer with tabs:
 *                             Profile     · person_profiles (app.state.people.profiles) + /attendance/daily today row
 *                             Attendance  · /attendance/month?person_id= (JSON; range-CSV fallback) → month calendar
 *                             Movement    · /attendance/person?person_id&days=7 (journey steps → waypoints)
 *                             Detections  · /events?person_id&limit=30 → KJModal event
 *                             Tickets     · /tickets?person_id= (+ ?q=name for manual tickets) → KJModal ticket
 *                           Deep link: #people/directory/<personId> opens the drawer on load.
 *   #people/faces           legacy face registration (dc template). Roster names → KJModal person.
 *   #people/attributes      legacy face & body search (dc template). Result cards → KJModal person
 *                           (resolved via /events/{uuid}.person_id; falls back to the event modal).
 *
 * Movement preselection (emitted by "Open in Movement"; the movement page may read any of these):
 *   sessionStorage['kj.movement.focus'] = JSON {personId, name, staffId, from:'YYYY-MM-DD', to:'YYYY-MM-DD', at:<ms>}
 *   window.KJMovementFocus             = same object (in-memory copy)
 *   window event 'kj:movement-focus'   CustomEvent, detail = same object (fired before navigating)
 *   app.state.mvQ                      = name || staffId (pre-fills the legacy movement log search)
 *   then KJPages.go('movement').
 *
 * Styles: assets/css/pages/people.css (injected once by ensureCss(); no inline styles).
 */
(function () {
  'use strict';

  /* ── tiny helpers ─────────────────────────────────────────────────────── */
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) { return v == null ? '' : String(v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function ico(name, cls) { return (window.KJIcon && window.KJIcon.svg) ? window.KJIcon.svg(name, cls) : ''; }
  function N(v) { return Number(v) || 0; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today() { return ymd(new Date()); }
  function toDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return new Date(v);
    var d = new Date(String(v).replace(' ', 'T'));
    return isNaN(d) ? null : d;
  }
  function fmtHM(v) { var d = toDate(v); return d ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : '—'; }
  function fmtDay(v) { var d = toDate(v); return d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''; }
  function fmtWhen(v) { var d = toDate(v); if (!d) return '—'; return (ymd(d) === today() ? 'Today' : fmtDay(d)) + ' · ' + fmtHM(d); }
  function ago(v) {
    var d = toDate(v); if (!d) return '';
    var m = Math.round((Date.now() - d.getTime()) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60); if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  }
  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (p) { return p[0] || ''; }).join('').toUpperCase() || '?';
  }
  function spec(type, id) { return type + ':' + encodeURIComponent(String(id == null ? '' : id)); }
  function can(p) { return window.KJPages ? window.KJPages.can(p) : true; }
  function toast(msg, tone) { if (window.KJModal && window.KJModal.toast) window.KJModal.toast(msg, tone); }
  function apiBase() { return (window.TMNS && window.TMNS.api) || '/api'; }
  function apiUrl(path, params) {
    var q = new URLSearchParams(params || {});
    var tok = (window.TMNS && window.TMNS.token) || '';
    if (tok) q.set('token', tok);
    return apiBase() + path + (q.toString() ? '?' + q : '');
  }
  function api(path, params) {
    return fetch(apiUrl(path, params), { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return { ok: false, status: r.status }; }).then(function (d) { if (d && typeof d === 'object' && d.status == null) d.status = r.status; return d; }); })
      .then(function (d) { if (!d || d.ok === false) { var e = new Error((d && (d.error || d.msg)) || 'Request failed'); e.status = d && d.status; throw e; } return d; });
  }
  function theme() {
    var el = document.querySelector('.c1[data-theme]') || document.querySelector('[data-theme]');
    return (el && el.getAttribute('data-theme')) === 'dark' ? 'dark' : 'light';
  }

  /* ── stylesheet + Lottie (external files only) ────────────────────────── */
  function ensureCss() {
    if (document.getElementById('kj-css-people')) return;
    var me = document.querySelector('script[src*="pages/people.js"]');
    var v = (me && /[?&]v=([^&]+)/.exec(me.getAttribute('src') || '')) || null;
    var l = document.createElement('link');
    l.id = 'kj-css-people'; l.rel = 'stylesheet';
    l.href = 'assets/css/pages/people.css' + '?v=' + encodeURIComponent((v ? v[1] : '') + '-' + ((window.TMNS && window.TMNS.build) || '1'));
    document.head.appendChild(l);
  }
  var LOT = { loading: false, q: [], anims: [] };
  var LOT_FILES = { empty: 'empty-box.json', scan: 'face-scan.json', error: 'error-alert.json', loading: 'loading-spinner.json' };
  function lottieReady(cb) {
    if (window.lottie && window.lottie.loadAnimation) { cb(); return; }
    LOT.q.push(cb);
    if (LOT.loading) return;
    LOT.loading = true;
    var s = document.createElement('script');
    s.src = 'assets/vendor/lottie/lottie_light.min.js'; s.async = true;
    s.onload = function () { var q = LOT.q; LOT.q = []; q.forEach(function (f) { try { f(); } catch (e) { /* ignore */ } }); };
    s.onerror = function () { LOT.q = []; };
    document.head.appendChild(s);
  }
  function hydrateLottie(root) {
    if (!root) return;
    LOT.anims = LOT.anims.filter(function (a) {
      if (a.el && document.contains(a.el)) return true;
      try { a.anim.destroy(); } catch (e) { /* ignore */ } return false;
    });
    root.querySelectorAll('[data-kjp-lottie]:not([data-kjp-lot])').forEach(function (el) {
      el.setAttribute('data-kjp-lot', '1');
      var file = LOT_FILES[el.getAttribute('data-kjp-lottie')] || LOT_FILES.empty;
      lottieReady(function () {
        if (!document.contains(el)) return;
        var stage = el.querySelector('.kjp-lottie-stage'); if (!stage) return;
        try {
          var anim = window.lottie.loadAnimation({ container: stage, renderer: 'svg', loop: true, autoplay: true, path: 'assets/lottie/' + file });
          anim.addEventListener('DOMLoaded', function () { el.classList.add('has-lottie'); });
          LOT.anims.push({ el: el, anim: anim });
        } catch (e) { /* static icon fallback stays */ }
      });
    });
  }
  /** Empty state with a Lottie animation (static Lucide icon until/unless it loads) + ways forward. */
  function emptyBox(o) {
    return '<div class="kj-empty kjp-empty' + (o.error ? ' is-error' : '') + '">' +
      '<div class="kj-lottie kjp-lottie" data-kjp-lottie="' + esc(o.anim || (o.error ? 'error' : 'empty')) + '">' +
        '<span class="kjp-lottie-stage"></span><span class="kj-empty-ico kjp-lottie-fallback">' + ico(o.icon || 'users') + '</span></div>' +
      '<div class="kj-empty-title">' + esc(o.title || '') + '</div>' +
      (o.text ? '<div class="kj-empty-text">' + esc(o.text) + '</div>' : '') +
      (o.actions ? '<div class="kj-row-wrap kj-empty-actions">' + o.actions + '</div>' : '') + '</div>';
  }

  /* ── domain ───────────────────────────────────────────────────────────── */
  var ATT = {
    present: ['Present', 'success', 'circle-check'], late: ['Late', 'warn', 'clock'], absent: ['Absent', 'danger', 'circle-x'],
    pending: ['Not yet in', 'info', 'hourglass'], off: ['Off day', '', 'calendar-off']
  };
  var ATT_TXT = { 'present': 'present', 'late': 'late', 'absent': 'absent', 'not yet in': 'pending', 'off day': 'off' };
  var PAGE_SIZE = 12;

  /** Face-enrolment state of a profile (SenseStudio person library sync). */
  function enrolOf(p) {
    if (!p) return { key: 'none', label: 'Not enrolled', tone: 'warn' };
    if (p.ssUid && (p.ssSync === 'synced' || p.ssSync === 'partial')) return { key: 'enrolled', label: p.ssSync === 'partial' ? 'Enrolled · partial' : 'Enrolled', tone: p.ssSync === 'partial' ? 'warn' : 'success' };
    if (p.ssSync === 'inactive') return { key: 'inactive', label: 'Deactivated', tone: '' };
    if (p.ssSync === 'failed') return { key: 'pending', label: 'Sync failed', tone: 'danger' };
    return { key: 'pending', label: p.photo ? 'Pending' : 'No photo', tone: 'orange' };
  }
  function shiftName(id) {
    var s = (S.shifts || []).find(function (x) { return String(x.id) === String(id); });
    return s ? (s.name || s.id) : (id || '');
  }
  /** No designation column exists yet — use a short "about" line, else shift / plant. */
  function designation(p) {
    var a = String(p.about || p.notes || '').trim();
    if (a && a.length <= 48 && a.indexOf('\n') < 0) return a;
    return [shiftName(p.shift) ? shiftName(p.shift) + ' shift' : '', p.plant].filter(Boolean).join(' · ') || (p.staffId ? 'Staff ' + p.staffId : 'Employee');
  }

  /* ── page state (module-local; not app.state) ─────────────────────────── */
  var S = {
    el: null, app: null, route: null, loading: true, err: '', todayErr: '',
    profiles: {}, roster: {}, todayRows: {}, depts: [], plants: [], shifts: [], kpi: null,
    q: '', dept: '', plant: '', enrol: '', status: '', showFilters: false, page: 1,
    feedN: 0, sig: '',
    drawer: null   // {pid, tab, month:'YYYY-MM', cache:{}, el, bd}
  };

  function profilesList() {
    return Object.keys(S.profiles).map(function (k) { return S.profiles[k]; });
  }
  function filtered() {
    var q = S.q.trim().toLowerCase();
    return profilesList().filter(function (p) {
      if (S.dept && (p.department || '') !== S.dept) return false;
      if (S.plant && (p.plant || '') !== S.plant) return false;
      if (S.enrol && enrolOf(p).key !== S.enrol) return false;
      if (S.status === 'active' && p.active === false) return false;
      if (S.status === 'inactive' && p.active !== false) return false;
      if (S.status && ATT[S.status]) { var r = S.todayRows[p.personId]; if (!r || r.status !== S.status) return false; }
      if (q && (p.name + ' ' + (p.staffId || '') + ' ' + (p.department || '') + ' ' + (p.plant || '')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  }

  /* ── data ─────────────────────────────────────────────────────────────── */
  function syncFromApp() {
    var a = S.app, ppl = (a && a.state && a.state.people) || {};
    S.profiles = ppl.profiles || {};
    S.roster = {};
    (ppl.rows || []).forEach(function (r) { S.roster[r.personId] = r; });
  }
  /** Called by the (owned) loadPeople method after /persons resolves or fails. */
  function peopleLoaded(err) {
    S.loading = false;
    S.err = err ? 'Could not load people' : '';
    syncFromApp();
    if (S.el) { paint(); if (S.drawer) paintDrawer(); }
  }
  /** After a save / sync / delete by the (owned) legacy methods: re-read app state, refresh today's rows. */
  function peopleChanged() {
    if (!S.el) return;
    setTimeout(function () { syncFromApp(); paint(); if (S.drawer) paintDrawer(); }, 60);
    loadToday();
  }
  /** Surface legacy empMsg results (the old employees page showed them inline) as toasts. */
  function peopleNotice(msg, tone, deletedPid) {
    if (msg) toast(String(msg).replace(/^[✗⚠]\s*/, ''), tone);
    if (deletedPid && S.drawer && S.drawer.pid === String(deletedPid)) closeDrawer();
    if (S.el) setTimeout(function () { syncFromApp(); paint(); if (S.drawer) paintDrawer(); }, 60);
  }
  function loadToday() {
    return api('/attendance/daily', { date: today() }).then(function (d) {
      S.todayRows = {};
      (d.rows || []).forEach(function (r) { S.todayRows[r.personId] = r; });
      S.depts = d.departments || []; S.plants = d.plants || []; S.shifts = d.shifts || [];
      S.kpi = d.kpi || null; S.todayErr = '';
      if (S.el) paint();
    }).catch(function () { S.todayErr = 'Today’s attendance is unavailable'; if (S.el) paint(); });
  }
  function refresh() {
    S.loading = !profilesList().length;
    if (S.el) paint();
    if (S.app && S.app.loadPeople) S.app.loadPeople(); else peopleLoaded(true);
    loadToday();
  }

  /* ── directory render ─────────────────────────────────────────────────── */
  function statTile(icon, val, lbl, tone, attrs) {
    return '<button type="button" class="kj-stat kjp-kpi' + (tone ? ' is-' + tone : '') + '" ' + attrs + '>' +
      '<span class="kj-stat-ico">' + ico(icon) + '</span><span><span class="kj-stat-val">' + esc(val) + '</span>' +
      '<span class="kj-stat-lbl">' + esc(lbl) + '</span></span></button>';
  }
  function photoHtml(p, cls) {
    var name = p.name || '';
    return p.photo
      ? '<img class="kjp-photo-img ' + (cls || '') + '" src="' + esc(p.photo) + '" alt="' + esc(name) + '" loading="lazy">'
      : '<span class="kjp-photo-img kjp-initials ' + (cls || '') + '">' + esc(initials(name)) + '</span>';
  }
  function dotTone(p) {
    if (p.active === false) return 'off';
    var r = S.todayRows[p.personId];
    if (!r) return 'idle';
    return r.status === 'present' || r.status === 'late' ? 'on' : (r.status === 'absent' ? 'bad' : 'idle');
  }
  function todayChip(p) {
    if (p.active === false) return '<span class="kj-chip kjp-att">' + ico('user-x') + 'Inactive</span>';
    var r = S.todayRows[p.personId];
    if (!r) return '<span class="kj-chip kjp-att">' + ico('calendar') + '—</span>';
    var a = ATT[r.status] || [r.status, '', 'calendar'];
    return '<button type="button" class="kj-chip kjp-att' + (a[1] ? ' is-' + a[1] : '') + '" data-kj-modal="' + esc(spec('attendance-day', today() + '@' + p.personId)) + '"' +
      ' title="' + esc('Today: ' + a[0] + (r.clockIn ? ' · in ' + fmtHM(r.clockIn) : '')) + '">' + ico(a[2]) + esc(a[0]) + '</button>';
  }
  function enrolChip(p, extra) {
    var e = enrolOf(p);
    return '<button type="button" class="kj-chip kjp-enrol' + (e.tone ? ' is-' + e.tone : '') + (extra ? ' ' + extra : '') + '" data-kj-nav="people/faces" title="' +
      esc('Face enrolment: ' + e.label + (p.ssError ? ' — ' + p.ssError : '') + ' · open Face registration') + '">' + ico('scan-face') + esc(e.label) + '</button>';
  }
  function card(p) {
    var sel = S.drawer && S.drawer.pid === p.personId;
    return '<article class="kjp-card' + (sel ? ' is-selected' : '') + (p.active === false ? ' is-inactive' : '') + '" data-kjp-open="' + esc(p.personId) + '" tabindex="0" role="button" aria-label="' + esc('Open ' + p.name) + '">' +
      '<div class="kjp-card-top">' +
        '<span class="kjp-photo">' + photoHtml(p) + '<span class="kjp-dot is-' + dotTone(p) + '"></span></span>' +
        '<div class="kjp-card-id">' +
          '<div class="kjp-name kj-truncate">' + esc(p.name) + '</div>' +
          '<div class="kjp-desig kj-truncate">' + esc(designation(p)) + '</div>' +
          (p.department ? '<button type="button" class="kj-chip is-primary kjp-dept" data-kjp-act="dept" data-kjp-val="' + esc(p.department) + '" title="Show only ' + esc(p.department) + '">' + esc(p.department) + '</button>'
            : '<span class="kj-chip kjp-dept">No department</span>') +
        '</div></div>' +
      '<div class="kjp-card-foot">' + todayChip(p) + '<span class="kjp-sep"></span>' + enrolChip(p) + '</div>' +
      '</article>';
  }
  function skeletonCards(n) {
    var out = '';
    for (var i = 0; i < n; i++) {
      out += '<div class="kjp-card kjp-card-skel" aria-hidden="true"><div class="kjp-card-top"><span class="kj-skel kj-skel-circle kjp-skel-photo"></span>' +
        '<div class="kjp-card-id"><span class="kj-skel kj-skel-title"></span><span class="kj-skel kj-skel-line is-mid"></span><span class="kj-skel kj-skel-line is-short"></span></div></div>' +
        '<div class="kjp-card-foot"><span class="kj-skel kj-skel-line is-short"></span><span class="kj-skel kj-skel-line is-short"></span></div></div>';
    }
    return out;
  }
  function deptList() {
    var seen = {}, out = [];
    S.depts.concat(profilesList().map(function (p) { return p.department; })).forEach(function (d) { if (d && !seen[d]) { seen[d] = 1; out.push(d); } });
    return out;
  }
  function plantList() {
    var seen = {}, out = [];
    S.plants.concat(profilesList().map(function (p) { return p.plant; })).forEach(function (d) { if (d && !seen[d]) { seen[d] = 1; out.push(d); } });
    return out;
  }
  function options(list, cur, anyLabel) {
    return '<option value="">' + esc(anyLabel) + '</option>' + list.map(function (o) {
      var v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o;
      return '<option value="' + esc(v) + '"' + (String(cur) === String(v) ? ' selected' : '') + '>' + esc(l) + '</option>';
    }).join('');
  }

  /** Section head + card grid (or skeleton / empty state) + pager — repainted alone while typing. */
  function resultsHtml(nTotal, busy) {
    var list = filtered();
    var pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    if (S.page > pages) S.page = pages;
    var slice = list.slice((S.page - 1) * PAGE_SIZE, S.page * PAGE_SIZE);
    var body;
    if (busy) body = '<div class="kjp-grid" aria-busy="true">' + skeletonCards(9) + '</div>';
    else if (S.err && !nTotal) body = emptyBox({ error: true, icon: 'cloud-off', title: 'Could not load people', text: 'Check your connection and try again.',
      actions: '<button type="button" class="kj-btn kj-btn-secondary" data-kjp-act="refresh">' + ico('refresh-cw') + '<span>Retry</span></button>' });
    else if (!nTotal) body = emptyBox({ anim: 'scan', icon: 'user-plus', title: 'No employees yet',
      text: 'Register your first employee, or enrol people detected by the face cameras.',
      actions: '<button type="button" class="kj-btn kj-btn-primary" data-kjp-act="add">' + ico('user-plus') + '<span>Add Person</span></button>' +
        '<button type="button" class="kj-btn kj-btn-secondary" data-kj-nav="people/faces">' + ico('scan-face') + '<span>Face registration</span></button>' });
    else if (!list.length) body = emptyBox({ icon: 'search-x', title: 'No one matches these filters', text: 'Try another name, department or status.',
      actions: '<button type="button" class="kj-btn kj-btn-secondary" data-kjp-act="clear">' + ico('x') + '<span>Clear filters</span></button>' });
    else body = '<div class="kjp-grid">' + slice.map(card).join('') + '</div>';

    var pager = '';
    if (list.length > PAGE_SIZE) {
      var b = [];
      b.push('<button type="button" class="kj-btn kj-btn-secondary kj-btn-icon kj-btn-sm" data-kjp-act="page" data-kjp-val="' + (S.page - 1) + '"' + (S.page <= 1 ? ' disabled' : '') + ' aria-label="Previous page">' + ico('chevron-left') + '</button>');
      for (var i = 1; i <= pages; i++) {
        if (pages > 7 && i > 2 && i < pages - 1 && Math.abs(i - S.page) > 1) { if (b[b.length - 1] !== '…') b.push('…'); continue; }
        b.push('<button type="button" class="kj-btn kj-btn-sm kjp-pg' + (i === S.page ? ' kj-btn-primary' : ' kj-btn-secondary') + '" data-kjp-act="page" data-kjp-val="' + i + '"' + (i === S.page ? ' aria-current="page"' : '') + '>' + i + '</button>');
      }
      b.push('<button type="button" class="kj-btn kj-btn-secondary kj-btn-icon kj-btn-sm" data-kjp-act="page" data-kjp-val="' + (S.page + 1) + '"' + (S.page >= pages ? ' disabled' : '') + ' aria-label="Next page">' + ico('chevron-right') + '</button>');
      pager = '<div class="kjp-pager"><span class="kj-muted">' + ((S.page - 1) * PAGE_SIZE + 1) + '–' + Math.min(list.length, S.page * PAGE_SIZE) + ' of ' + list.length + '</span><span class="kj-row">' +
        b.map(function (x) { return x === '…' ? '<span class="kj-muted kjp-ellipsis">…</span>' : x; }).join('') + '</span></div>';
    }

    var sec = '<div class="kjp-sec-head"><div><h3 class="kjp-sec-title">People directory</h3>' +
      '<div class="kj-muted kjp-sec-sub">' + (busy ? 'Loading…' : 'Showing ' + slice.length + ' of ' + list.length + (list.length !== nTotal ? ' (filtered from ' + nTotal + ')' : '') + ' people') +
      (S.todayErr && nTotal ? ' · ' + esc(S.todayErr) : '') + '</div></div></div>';

    return sec + body + pager;
  }
  function paintResults() {
    var box = S.el && S.el.querySelector('.kjp-results');
    if (!box) { paint(); return; }
    var nTotal = profilesList().length;
    box.innerHTML = resultsHtml(nTotal, S.loading && !nTotal);
    hydrateLottie(box);
  }

  function paint() {
    var el = S.el; if (!el) return;
    var all = profilesList();
    var focusId = document.activeElement && el.contains(document.activeElement) ? document.activeElement.id : '';
    var selStart = focusId === 'kjp-search' ? document.activeElement.selectionStart : null;

    var nTotal = all.length;
    var nPresent = all.filter(function (p) { var r = S.todayRows[p.personId]; return r && (r.status === 'present' || r.status === 'late'); }).length;
    var nEnrolled = all.filter(function (p) { return enrolOf(p).key === 'enrolled'; }).length;
    var nPending = all.filter(function (p) { return enrolOf(p).key === 'pending'; }).length;
    var busy = S.loading && !nTotal;

    var head = '<div class="kj-page-head kjp-head"><div><h2 class="kj-page-title">People</h2>' +
      '<p class="kj-page-sub">Manage your workforce and face enrolment</p></div>' +
      '<div class="kj-row-wrap">' +
        '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon" data-kjp-act="refresh" title="Refresh" aria-label="Refresh">' + ico('refresh-cw') + '</button>' +
        (can('settings') ? '<button type="button" class="kj-btn kj-btn-secondary" data-kjp-act="sync-all" title="Push every employee with a staff ID and photo to the SenseStudio face library">' + ico('cloud-upload') + '<span>Sync to SenseStudio</span></button>' : '') +
        '<a class="kj-btn kj-btn-secondary" href="/kiosk.php" target="_blank" rel="noopener">' + ico('scan-face') + '<span>Check-in kiosk</span></a>' +
        '<button type="button" class="kj-btn kj-btn-primary kj-btn-lg kjp-add" data-kjp-act="add">' + ico('user-plus') + '<span>Add Person</span></button>' +
      '</div></div>';

    var kpis = '<div class="kj-grid-4 kjp-kpis">' +
      statTile('users', busy ? '…' : nTotal, 'Total people', '', 'data-kj-modal="stat:emp"') +
      statTile('circle-check', busy || !S.kpi && !S.todayErr ? '…' : (S.todayErr ? '—' : nPresent), 'Present today', 'success', 'data-kj-modal="' + esc(spec('attendance-day', today())) + '"') +
      statTile('scan-face', busy ? '…' : nEnrolled, 'Enrolled', 'purple', 'data-kjp-act="enrol" data-kjp-val="enrolled" aria-pressed="' + (S.enrol === 'enrolled') + '"') +
      statTile('hourglass', busy ? '…' : nPending, 'Pending enrolment', 'orange', 'data-kjp-act="enrol" data-kjp-val="pending" aria-pressed="' + (S.enrol === 'pending') + '"') +
      '</div>';

    var nFilters = (S.plant ? 1 : 0) + (S.enrol ? 1 : 0) + (S.status ? 1 : 0);
    var tools = '<div class="kjp-toolbar">' +
      '<label class="kjp-search">' + ico('search') + '<span class="kj-sr-only">Search people</span>' +
        '<input id="kjp-search" class="kj-input" type="search" placeholder="Search name, ID or department" value="' + esc(S.q) + '" autocomplete="off"></label>' +
      '<button type="button" class="kj-btn kj-btn-secondary kj-btn-icon kjp-filter-btn' + (S.showFilters || nFilters ? ' is-on' : '') + '" data-kjp-act="filters" aria-expanded="' + S.showFilters + '" title="More filters" aria-label="More filters">' +
        ico('sliders-horizontal') + (nFilters ? '<span class="kj-badge kjp-filter-n">' + nFilters + '</span>' : '') + '</button></div>' +
      (S.showFilters ? '<div class="kj-card-flat kjp-filters">' +
        '<label class="kj-field"><span class="kj-label">Plant</span><select class="kj-select" data-kjp-sel="plant">' + options(plantList(), S.plant, 'All plants') + '</select></label>' +
        '<label class="kj-field"><span class="kj-label">Face enrolment</span><select class="kj-select" data-kjp-sel="enrol">' + options([['enrolled', 'Enrolled'], ['pending', 'Pending / failed'], ['inactive', 'Deactivated']], S.enrol, 'Any') + '</select></label>' +
        '<label class="kj-field"><span class="kj-label">Status today</span><select class="kj-select" data-kjp-sel="status">' +
          options([['present', 'Present'], ['late', 'Late'], ['absent', 'Absent'], ['pending', 'Not yet in'], ['off', 'Off day'], ['active', 'Active employees'], ['inactive', 'Inactive employees']], S.status, 'Any') + '</select></label>' +
        '<button type="button" class="kj-btn kj-btn-ghost kjp-clear" data-kjp-act="clear">' + ico('x') + '<span>Clear filters</span></button>' +
      '</div>' : '') +
      '<div class="kjp-chips" role="toolbar" aria-label="Department filter">' +
        '<button type="button" class="kj-chip kjp-fchip' + (!S.dept ? ' is-on' : '') + '" data-kjp-act="dept" data-kjp-val="">All departments</button>' +
        deptList().map(function (d) { return '<button type="button" class="kj-chip kjp-fchip' + (S.dept === d ? ' is-on' : '') + '" data-kjp-act="dept" data-kjp-val="' + esc(d) + '">' + esc(d) + '</button>'; }).join('') +
      '</div>';

    el.innerHTML = '<div class="kj-page kjp-page">' + head + kpis + tools + '<div class="kjp-results">' + resultsHtml(nTotal, busy) + '</div></div>';
    hydrateLottie(el);
    if (focusId) {
      var f = document.getElementById(focusId);
      if (f) { f.focus(); if (selStart != null && f.setSelectionRange) try { f.setSelectionRange(selStart, selStart); } catch (e) { /* ignore */ } }
    }
  }

  /* ── directory events ─────────────────────────────────────────────────── */
  var searchT = null;
  function onClick(ev) {
    var t = ev.target; if (!(t instanceof Element)) return;
    var act = t.closest('[data-kjp-act]');
    if (act && S.el.contains(act)) {
      var a = act.getAttribute('data-kjp-act'), v = act.getAttribute('data-kjp-val');
      ev.preventDefault();
      if (a === 'dept') { S.dept = (S.dept === v && v) ? '' : (v || ''); S.page = 1; paint(); return; }
      if (a === 'enrol') { S.enrol = S.enrol === v ? '' : v; S.page = 1; paint(); return; }
      if (a === 'filters') { S.showFilters = !S.showFilters; paint(); return; }
      if (a === 'clear') { S.q = ''; S.dept = ''; S.plant = ''; S.enrol = ''; S.status = ''; S.page = 1; paint(); return; }
      if (a === 'page') { S.page = Math.max(1, N(v)); paint(); var top = S.el.querySelector('.kjp-sec-head'); if (top && top.scrollIntoView) top.scrollIntoView({ block: 'start' }); return; }
      if (a === 'refresh') { refresh(); return; }
      if (a === 'add') { closeDrawer(); if (S.app && S.app.newEmployee) S.app.newEmployee(); return; }
      if (a === 'sync-all') { if (S.app && S.app.syncEmployee) { toast('Syncing all employees to SenseStudio…'); S.app.syncEmployee(); } return; }
      return;
    }
    if (t.closest('[data-kj-modal],[data-kj-nav],a[href],button,select,input')) return;   // inner links win
    var c = t.closest('[data-kjp-open]');
    if (c) openDrawer(c.getAttribute('data-kjp-open'));
  }
  function onKey(ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var t = ev.target;
    if (t instanceof Element && t.hasAttribute('data-kjp-open')) { ev.preventDefault(); openDrawer(t.getAttribute('data-kjp-open')); }
  }
  function onInput(ev) {
    var t = ev.target;
    if (t.id === 'kjp-search') {
      S.q = t.value; S.page = 1;
      clearTimeout(searchT); searchT = setTimeout(paintResults, 180);
    }
  }
  function onChange(ev) {
    var k = ev.target.getAttribute && ev.target.getAttribute('data-kjp-sel');
    if (k) { S[k] = ev.target.value; S.page = 1; paint(); }
  }

  /* ── detail drawer ────────────────────────────────────────────────────── */
  var TABS = [['profile', 'Profile'], ['attendance', 'Attendance'], ['movement', 'Movement'], ['detections', 'Detections'], ['tickets', 'Tickets']];

  function personOf(pid) {
    var p = S.profiles[pid];
    if (p) return p;
    var r = S.roster[pid];
    return { personId: pid, name: (r && r.senseName) || ('Person #' + pid), photo: (r && (r.senseMatch || r.image)) || '', staffId: '', unknown: true };
  }
  function openDrawer(pid, tab) {
    if (!pid) return;
    var now = new Date();
    if (!S.drawer || S.drawer.pid !== pid) S.drawer = { pid: String(pid), tab: tab || 'profile', month: now.getFullYear() + '-' + pad(now.getMonth() + 1), cache: {} };
    else if (tab) S.drawer.tab = tab;
    var d = S.drawer;
    if (!d.el) {
      var bd = document.createElement('div');
      bd.className = 'kj-drawer-backdrop kjp-drawer-bd';
      bd.setAttribute('data-kjp-dclose', '1');
      var el = document.createElement('aside');
      el.className = 'kj-drawer kj-root kjp-drawer';
      el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Person details'); el.tabIndex = -1;
      document.body.appendChild(bd); document.body.appendChild(el);
      d.el = el; d.bd = bd;
      bd.addEventListener('click', closeDrawer);
      el.addEventListener('click', onDrawerClick);
      requestAnimationFrame(function () { bd.classList.add('is-open'); el.classList.add('is-open'); });
      setTimeout(function () { try { el.focus(); } catch (e) { /* ignore */ } }, 40);
    }
    d.bd.setAttribute('data-theme', theme()); d.el.setAttribute('data-theme', theme());
    paintDrawer();
    S.el && S.el.querySelectorAll('.kjp-card.is-selected').forEach(function (c) { c.classList.remove('is-selected'); });
    var sel = S.el && S.el.querySelector('[data-kjp-open="' + (window.CSS && CSS.escape ? CSS.escape(String(pid)) : String(pid)) + '"]');
    if (sel) sel.classList.add('is-selected');
  }
  function closeDrawer() {
    var d = S.drawer; if (!d) return;
    S.drawer = null;
    if (d.el) {
      d.el.classList.remove('is-open'); d.bd.classList.remove('is-open');
      var e1 = d.el, e2 = d.bd;
      setTimeout(function () { if (e1.parentNode) e1.parentNode.removeChild(e1); if (e2.parentNode) e2.parentNode.removeChild(e2); }, 260);
    }
    if (S.el) S.el.querySelectorAll('.kjp-card.is-selected').forEach(function (c) { c.classList.remove('is-selected'); });
  }
  function onDocKey(ev) {
    if (ev.key === 'Escape' && S.drawer && !document.querySelector('.kj-modal-layer')) { closeDrawer(); }
  }

  function paintDrawer() {
    var d = S.drawer; if (!d || !d.el) return;
    var p = personOf(d.pid);
    var r = S.todayRows[d.pid];
    var att = r ? (ATT[r.status] || [r.status, '']) : null;
    var desig = p.unknown ? 'Tracked person · not enrolled' : [designation(p), p.department].filter(Boolean).join(' · ');
    var hero = '<div class="kjp-dhero">' +
      '<button type="button" class="kjp-dphoto" ' + (p.photo ? 'data-kj-modal="' + esc(spec('image', p.photo)) + '" data-kj-seed=\'' + esc(JSON.stringify({ label: p.name })) + '\'' : 'data-kj-modal="' + esc(spec('person', d.pid)) + '"') + ' aria-label="' + esc('Photo of ' + p.name) + '">' +
        photoHtml(p, 'kjp-photo-xl') + '<span class="kjp-dot is-' + (p.unknown ? 'idle' : dotTone(p)) + '"></span></button>' +
      '<div class="kjp-dhero-main">' +
        '<button type="button" class="kjp-dname" data-kj-modal="' + esc(spec('person', d.pid)) + '">' + esc(p.name) + '</button>' +
        '<div class="kjp-ddesig">' + esc(desig) + '</div>' +
        '<div class="kj-row-wrap">' +
          (p.staffId ? '<span class="kj-chip kjp-staff">' + ico('id-card') + esc(p.staffId) + '</span>' : '') +
          (p.unknown ? '' : enrolChip(p, 'kjp-enrol-lg')) +
          (att ? '<button type="button" class="kj-chip' + (att[1] ? ' is-' + att[1] : '') + '" data-kj-modal="' + esc(spec('attendance-day', today() + '@' + d.pid)) + '">Today: ' + esc(att[0]) + '</button>' : '') +
        '</div></div></div>';
    var tabs = '<div class="kj-tabs kjp-dtabs" role="tablist">' + TABS.map(function (t) {
      return '<button type="button" class="kj-tab' + (d.tab === t[0] ? ' is-active' : '') + '" role="tab" aria-selected="' + (d.tab === t[0]) + '" data-kjp-tab="' + t[0] + '">' + t[1] + '</button>';
    }).join('') + '</div>';
    d.el.innerHTML =
      '<div class="kj-drawer-head kjp-dhead"><h2 class="kjp-dtitle">Person details</h2><span class="kj-spacer"></span>' +
        '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon" data-kjp-dclose="1" aria-label="Close">' + ico('x') + '</button></div>' +
      '<div class="kj-drawer-body kjp-dbody">' + hero + tabs + '<div class="kj-tabpanel kjp-dpanel" role="tabpanel">' + panel(d, p) + '</div></div>' +
      '<div class="kjp-dfoot"><button type="button" class="kj-btn kj-btn-primary kj-btn-lg kj-btn-block" data-kj-modal="' + esc(spec('person', d.pid)) + '">' + ico('user-round') + '<span>View full profile</span></button></div>';
    hydrateLottie(d.el);
  }
  function onDrawerClick(ev) {
    var t = ev.target; if (!(t instanceof Element)) return;
    var d = S.drawer; if (!d) return;
    if (t.closest('[data-kjp-dclose]')) { closeDrawer(); return; }
    var tab = t.closest('[data-kjp-tab]');
    if (tab) { d.tab = tab.getAttribute('data-kjp-tab'); paintDrawer(); return; }
    // A data-kj-nav link leaves the page: drop the drawer first.
    if (t.closest('[data-kj-nav]')) { closeDrawer(); return; }
    var act = t.closest('[data-kjp-dact]');
    if (!act) return;
    ev.preventDefault();
    var a = act.getAttribute('data-kjp-dact'), app = S.app, p = personOf(d.pid);
    if (a === 'retry') { delete d.cache[act.getAttribute('data-kjp-val')]; paintDrawer(); return; }
    if (a === 'month') {
      var m = act.getAttribute('data-kjp-val'); d.month = m; paintDrawer(); return;
    }
    if (a === 'tab') { d.tab = act.getAttribute('data-kjp-val'); paintDrawer(); return; }
    if (a === 'dept') { S.dept = act.getAttribute('data-kjp-val') || ''; S.page = 1; closeDrawer(); paint(); return; }
    if (a === 'movement') { focusMovement(p); return; }
    if (!app) { toast('Dashboard is still loading — try again in a moment.', 'warn'); return; }
    if (a === 'edit') { closeDrawer(); app.openProfile({ personId: d.pid, image: p.photo }); return; }
    if (a === 'journey') { closeDrawer(); app.openJourney({ personId: d.pid, name: p.name, staffId: p.staffId, photo: p.photo }); return; }
    if (a === 'sync') { toast('Syncing ' + p.name + ' to SenseStudio…'); app.syncEmployee(d.pid); return; }
    if (a === 'delete') { app.removeProfile(p); return; }
  }

  /** Emit the movement preselection (see header) and navigate to #movement. */
  function focusMovement(p) {
    var now = new Date();
    var payload = { personId: String(p.personId), name: p.unknown ? '' : (p.name || ''), staffId: p.staffId || '',
      from: ymd(new Date(now.getTime() - 6 * 86400000)), to: ymd(now), at: Date.now() };
    try { sessionStorage.setItem('kj.movement.focus', JSON.stringify(payload)); } catch (e) { /* private mode */ }
    window.KJMovementFocus = payload;
    try { window.dispatchEvent(new CustomEvent('kj:movement-focus', { detail: payload })); } catch (e) { /* old browser */ }
    var q = payload.name || payload.staffId;
    if (q && S.app && S.app.setState) S.app.setState({ mvQ: q, mvFrom: payload.from, mvTo: payload.to });
    closeDrawer();
    if (window.KJPages) window.KJPages.go('movement');
  }

  /* ── drawer panels ────────────────────────────────────────────────────── */
  function panelLoading(kind) {
    if (kind === 'cal') return '<div class="kjp-pskel"><span class="kj-skel kj-skel-tile"></span><span class="kj-skel kj-skel-tile"></span><span class="kj-skel kj-skel-tile"></span></div><span class="kj-skel kj-skel-block"></span>';
    return '<div class="kj-stack"><span class="kj-skel kj-skel-line"></span><span class="kj-skel kj-skel-line is-mid"></span><span class="kj-skel kj-skel-block"></span><span class="kj-skel kj-skel-line is-short"></span></div>';
  }
  function panelError(key, msg) {
    return emptyBox({ error: true, icon: 'cloud-off', title: 'Could not load this tab', text: msg || 'Check your connection and try again.',
      actions: '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-kjp-dact="retry" data-kjp-val="' + esc(key) + '">' + ico('refresh-cw') + '<span>Retry</span></button>' });
  }
  /** Cache-or-load: returns {state:'loading'|'ok'|'err', data, msg}; repaints when it settles. */
  function want(d, key, loader) {
    var c = d.cache[key];
    if (c) return c;
    c = d.cache[key] = { state: 'loading' };
    var pid = d.pid;
    Promise.resolve().then(loader).then(function (data) { c.state = 'ok'; c.data = data; })
      .catch(function (e) { c.state = 'err'; c.msg = (e && e.message) || ''; c.status = e && e.status; })
      .then(function () { if (S.drawer && S.drawer.pid === pid && S.drawer.cache[key] === c) paintDrawer(); });
    return c;
  }
  function journey(d) {
    return want(d, 'journey', function () { return api('/attendance/person', { person_id: d.pid, days: 7 }); });
  }

  function panel(d, p) {
    if (d.tab === 'attendance') return panelAttendance(d, p);
    if (d.tab === 'movement') return panelMovement(d, p);
    if (d.tab === 'detections') return panelDetections(d, p);
    if (d.tab === 'tickets') return panelTickets(d, p);
    return panelProfile(d, p);
  }

  function kvRow(label, val, html) { return '<div><dt>' + esc(label) + '</dt><dd>' + (html ? val : esc(val == null || val === '' ? '—' : val)) + '</dd></div>'; }
  function panelProfile(d, p) {
    if (p.unknown) {
      return emptyBox({ anim: 'scan', icon: 'scan-face', title: 'Not enrolled yet', text: 'This person was detected by the cameras but has no employee profile.',
        actions: '<button type="button" class="kj-btn kj-btn-primary kj-btn-sm" data-kjp-dact="edit">' + ico('user-plus') + '<span>Enrol as employee</span></button>' });
    }
    var r = S.todayRows[d.pid], ro = S.roster[d.pid];
    var e = enrolOf(p);
    var details = '<dl class="kj-kv kjp-kv">' +
      kvRow('Staff ID', p.staffId) +
      kvRow('Department', p.department ? '<button type="button" class="kj-link" data-kjp-dact="dept" data-kjp-val="' + esc(p.department) + '" title="Show everyone in ' + esc(p.department) + '">' + esc(p.department) + '</button>' : '—', true) +
      kvRow('Plant', p.plant) +
      kvRow('Shift', shiftName(p.shift) || (r && r.shift)) +
      kvRow('Gender', p.gender ? p.gender[0].toUpperCase() + p.gender.slice(1) : '') +
      kvRow('Age', p.age) +
      kvRow('Status', p.active === false ? 'Inactive' : 'Active') +
      kvRow('Person ID', '#' + d.pid) +
      kvRow('Last seen', ro && ro.lastSeen ? '<button type="button" class="kj-link" data-kjp-dact="tab" data-kjp-val="movement">' + esc(fmtWhen(ro.lastSeen)) + '</button>' : '—', true) +
      kvRow('Enrolled since', p.since ? fmtDay(p.since) + (p.by ? ' · by ' + p.by : '') : '') +
      '</dl>';
    var about = p.about ? '<div class="kj-card-flat kjp-about">' + esc(p.about) + '</div>' : '';
    var face = '<div class="kj-card-flat kjp-facebox"><div class="kj-row"><span class="kj-stat-ico kjp-ico-' + (e.tone || 'muted') + '">' + ico('scan-face') + '</span>' +
      '<div class="kj-list-main"><div class="kj-list-title">Face enrolment: ' + esc(e.label) + '</div>' +
      '<div class="kj-list-sub">' + esc(p.ssError || (p.ssUid ? 'SenseStudio uid ' + p.ssUid + (p.ssSynced ? ' · synced ' + fmtWhen(p.ssSynced) : '') : (p.photo ? 'Photo on file — not yet pushed to the camera face library' : 'Add a front-facing photo to enrol'))) + '</div></div>' +
      '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kj-nav="people/faces">Open</button></div></div>';
    var login = '<div class="kj-card-flat kjp-login"><div class="kj-row"><span class="kj-stat-ico kjp-ico-muted">' + ico('link-2') + '</span>' +
      '<div class="kj-list-main"><div class="kj-list-title">Sign-in account</div>' +
      '<div class="kj-list-sub">Link or review this employee’s sign-in account under Settings → Users' +
      (p.staffId ? ' (staff ID “' + esc(p.staffId) + '”)' : '') + '.</div></div>' +
      (can('users') ? '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kj-nav="settings/users">Users</button>' : '') + '</div></div>';
    var acts = '<div class="kj-row-wrap kjp-dacts">' +
      '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-kjp-dact="edit">' + ico('pencil') + '<span>Edit profile</span></button>' +
      '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-kjp-dact="journey">' + ico('route') + '<span>Movement journey</span></button>' +
      (can('settings') ? '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-kjp-dact="sync"' + (p.staffId && p.photo || p.ssUid ? '' : ' disabled title="Needs a staff ID and a photo"') + '>' + ico('cloud-upload') + '<span>Sync face</span></button>' +
        '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm kjp-danger" data-kjp-dact="delete">' + ico('trash-2') + '<span>Delete</span></button>' : '') +
      '</div>';
    return '<div class="kjp-section-title">Profile</div>' + details + about + '<div class="kjp-section-title">Enrolment & access</div>' + face + login + acts;
  }

  /* Attendance: month calendar from GET /attendance/month (CSV export fallback; shift rules server-side). */
  function parseCsv(text) {
    var rows = [], row = [], cur = '', q = false, s = String(text || '').replace(/^﻿/, '');
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += ch;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  function monthBounds(m) {
    var y = N(m.slice(0, 4)), mo = N(m.slice(5, 7)) - 1;
    return { first: new Date(y, mo, 1), last: new Date(y, mo + 1, 0) };
  }
  function loadMonth(d, p) {
    var b = monthBounds(d.month), t = new Date();
    var to = b.last > t ? t : b.last;
    if (b.first > t) return Promise.resolve({});
    var q = p.staffId || p.name || '';
    // Primary: GET /attendance/month?person_id= (JSON). Silent fallback: the range CSV export.
    var hm = function (x) { return x ? String(x).slice(11, 16) : ''; };
    return api('/attendance/month', { month: d.month, person_id: d.pid }).then(function (r) {
      if (!r || !Array.isArray(r.days)) throw new Error('shape');
      var out = {};
      r.days.forEach(function (x) {
        out[x.date] = { status: x.status || 'pending', clockIn: hm(x.clockIn), clockOut: hm(x.clockOut),
          hours: x.hours == null ? '' : String(x.hours), lateMin: x.lateMin ? String(x.lateMin) : '' };
      });
      return out;
    }).catch(function () { return loadMonthCsv(b, to, q, p); });
  }
  function loadMonthCsv(b, to, q, p) {
    return fetch(apiUrl('/attendance/export', { report: 'range', from: ymd(b.first), to: ymd(to), q: q }), { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) { var e = new Error('Attendance export failed (' + r.status + ')'); e.status = r.status; throw e; }
        return r.text();
      })
      .then(function (txt) {
        var rows = parseCsv(txt), out = {};
        rows.slice(1).forEach(function (c) {
          if (c.length < 12) return;
          var mine = p.staffId ? c[1] === p.staffId : c[2] === p.name;
          if (!mine) return;
          out[c[0]] = { status: ATT_TXT[String(c[11]).toLowerCase()] || 'pending', clockIn: c[6], clockOut: c[8], hours: c[10], lateMin: c[12] };
        });
        return out;
      });
  }
  function panelAttendance(d, p) {
    if (p.unknown) return emptyBox({ icon: 'calendar-check', title: 'No attendance for unenrolled people', text: 'Attendance is kept for registered employees only.',
      actions: '<button type="button" class="kj-btn kj-btn-primary kj-btn-sm" data-kjp-dact="edit">' + ico('user-plus') + '<span>Enrol as employee</span></button>' });
    var key = 'month:' + d.month;
    var c = want(d, key, function () { return loadMonth(d, p); });
    var b = monthBounds(d.month);
    var prev = new Date(b.first.getFullYear(), b.first.getMonth() - 1, 1), next = new Date(b.first.getFullYear(), b.first.getMonth() + 1, 1);
    var mKey = function (x) { return x.getFullYear() + '-' + pad(x.getMonth() + 1); };
    var isFutureNext = next > new Date();
    if (c.state === 'loading') return '<div class="kjp-section-title">Attendance overview</div>' + panelLoading('cal');
    if (c.state === 'err') return '<div class="kjp-section-title">Attendance overview</div>' + panelError(key, c.msg);
    var days = c.data || {};
    var cnt = { present: 0, late: 0, absent: 0 }, lastOf = {};
    Object.keys(days).sort().forEach(function (k) {
      var s = days[k].status;
      if (s === 'present' || s === 'late') cnt.present++;
      if (s === 'late') cnt.late++;
      if (s === 'absent') cnt.absent++;
      lastOf[s] = k; if (s === 'late') lastOf.present = k;
    });
    function tile(icon, n, lbl, tone, st) {
      var target = lastOf[st];
      return target
        ? '<button type="button" class="kj-stat kjp-mini is-' + tone + '" data-kj-modal="' + esc(spec('attendance-day', target + '@' + d.pid)) + '" title="Open the latest ' + esc(lbl.toLowerCase()) + ' day">'
          + '<span class="kj-stat-ico">' + ico(icon) + '</span><span><span class="kj-stat-val">' + n + '</span><span class="kj-stat-lbl">' + esc(lbl) + '</span></span></button>'
        : '<div class="kj-stat kjp-mini is-' + tone + '"><span class="kj-stat-ico">' + ico(icon) + '</span><span><span class="kj-stat-val">' + n + '</span><span class="kj-stat-lbl">' + esc(lbl) + '</span></span></div>';
    }
    var tiles = '<div class="kjp-minis">' + tile('circle-check', cnt.present, 'Present', 'success', 'present') + tile('clock', cnt.late, 'Late', 'warn', 'late') + tile('circle-x', cnt.absent, 'Absent', 'danger', 'absent') + '</div>';
    var tdy = today();
    var lead = (b.first.getDay() + 6) % 7;   // Monday-first
    var cells = '';
    for (var i = 0; i < lead; i++) cells += '<span class="kjp-cal-cell is-pad"></span>';
    for (var dd = 1; dd <= b.last.getDate(); dd++) {
      var ds = d.month + '-' + pad(dd), info = days[ds];
      var cls = 'kjp-cal-cell' + (ds === tdy ? ' is-today' : '') + (info ? ' is-' + info.status : '');
      if (ds > tdy) cells += '<span class="' + cls + ' is-future">' + dd + '</span>';
      else cells += '<button type="button" class="' + cls + '" data-kj-modal="' + esc(spec('attendance-day', ds + '@' + d.pid)) + '" title="' +
        esc(ds + (info ? ' · ' + (ATT[info.status] || [info.status])[0] + (info.clockIn ? ' · in ' + info.clockIn : '') + (info.clockOut ? ' · out ' + info.clockOut : '') : ' · no record')) + '">' + dd + '<i class="kjp-cal-dot"></i></button>';
    }
    var cal = '<div class="kj-card kjp-cal">' +
      '<div class="kjp-cal-head"><button type="button" class="kj-btn kj-btn-ghost kj-btn-icon kj-btn-sm" data-kjp-dact="month" data-kjp-val="' + mKey(prev) + '" aria-label="Previous month">' + ico('chevron-left') + '</button>' +
        '<b>' + esc(b.first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })) + '</b>' +
        '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon kj-btn-sm" data-kjp-dact="month" data-kjp-val="' + mKey(next) + '"' + (isFutureNext ? ' disabled' : '') + ' aria-label="Next month">' + ico('chevron-right') + '</button></div>' +
      '<div class="kjp-cal-grid">' + ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(function (w) { return '<span class="kjp-cal-wd">' + w + '</span>'; }).join('') + cells + '</div>' +
      '<div class="kjp-cal-legend"><span class="is-present">Present</span><span class="is-late">Late</span><span class="is-absent">Absent</span><span class="is-off">Off day</span></div></div>';
    // Recent sightings (mockup "Recent events") from the 7-day journey.
    var j = journey(d), recent;
    if (j.state === 'loading') recent = panelLoading();
    else if (j.state === 'err') recent = panelError('journey', j.msg);
    else {
      var steps = ((j.data.journey || {}).steps || []).slice(-3).reverse();
      recent = steps.length ? '<div class="kj-list">' + steps.map(stepRow).join('') + '</div>'
        : '<div class="kj-muted kjp-note">No sightings at mapped camera points in the last 7 days.</div>';
    }
    return '<div class="kjp-section-title">Attendance overview</div>' + tiles + cal +
      '<div class="kjp-subhead"><span class="kjp-section-title">Recent events</span><button type="button" class="kj-link" data-kjp-dact="tab" data-kjp-val="movement">View all</button></div>' + recent;
  }

  function stepRow(s) {
    var thumb = s.image
      ? '<img class="kj-thumb kjp-thumb" src="' + esc(s.image) + '" alt="" loading="lazy" data-kj-modal="' + esc(spec('image', s.image)) + '">'
      : '<span class="kj-thumb kj-stat-ico">' + ico('map-pin') + '</span>';
    return '<div class="kj-list-item kjp-step">' + thumb +
      '<div class="kj-list-main"><div class="kj-list-title kj-truncate">' + esc(s.location || 'Unmapped camera') + (s.source === 'kiosk' ? ' · kiosk check-in' : '') + '</div>' +
      '<div class="kj-list-sub kj-truncate">' + ico('map-pin') + ' ' + (s.camera ? '<button type="button" class="kj-link" data-kj-modal="' + esc(spec('camera', s.camera)) + '">' + esc(s.camera) + '</button>' : '—') + '</div></div>' +
      '<span class="kj-muted kjp-time">' + esc(fmtWhen(s.time)) + '</span></div>';
  }
  function panelMovement(d, p) {
    var j = journey(d), body;
    var cta = '<button type="button" class="kj-btn kj-btn-soft kj-btn-sm" data-kjp-dact="movement">' + ico('footprints') + '<span>Open in Movement</span></button>';
    if (j.state === 'loading') body = panelLoading();
    else if (j.state === 'err') body = panelError('journey', j.msg);
    else {
      var steps = (j.data.journey || {}).steps || [];
      var wps = [];
      steps.forEach(function (s) {
        var last = wps[wps.length - 1];
        if (last && last.location === s.location) { last.depart = s.time; last.n++; if (!last.image && s.image) last.image = s.image; if (s.camera && last.cams.indexOf(s.camera) < 0) last.cams.push(s.camera); return; }
        wps.push({ location: s.location, arrive: s.time, depart: s.time, n: 1, image: s.image, cams: s.camera ? [s.camera] : [], source: s.source });
      });
      wps = wps.reverse().slice(0, 15);
      body = wps.length ? '<ol class="kjp-route">' + wps.map(function (w) {
        return '<li class="kjp-wp">' +
          (w.image ? '<img class="kj-thumb kjp-thumb" src="' + esc(w.image) + '" alt="" loading="lazy" data-kj-modal="' + esc(spec('image', w.image)) + '">' : '<span class="kj-thumb kj-stat-ico">' + ico('map-pin') + '</span>') +
          '<div class="kj-list-main"><div class="kj-list-title kj-truncate">' + esc(w.location || 'Unmapped camera') + '</div>' +
          '<div class="kj-list-sub">' + w.cams.map(function (c) { return '<button type="button" class="kj-link" data-kj-modal="' + esc(spec('camera', c)) + '">' + esc(c) + '</button>'; }).join(' · ') +
          (w.n > 1 ? ' · ' + w.n + ' sightings' : '') + '</div></div>' +
          '<button type="button" class="kj-link kjp-time" data-kj-modal="' + esc(spec('attendance-day', String(w.arrive).slice(0, 10) + '@' + d.pid)) + '">' +
            esc(fmtDay(w.arrive)) + '<br>' + esc(fmtHM(w.arrive)) + (w.depart !== w.arrive ? '–' + esc(fmtHM(w.depart)) : '') + '</button></li>';
      }).join('') + '</ol>'
        : emptyBox({ icon: 'route', title: 'No movement recorded', text: 'No sightings at mapped camera points in the last 7 days.', actions: cta });
    }
    return '<div class="kjp-subhead"><span class="kjp-section-title">Recent waypoints · 7 days</span>' + cta + '</div>' + body;
  }

  function panelDetections(d, p) {
    var c = want(d, 'events', function () { return api('/events', { person_id: d.pid, limit: 30 }); });
    if (c.state === 'loading') return '<div class="kjp-section-title">Recent detections</div>' + panelLoading();
    if (c.state === 'err') return '<div class="kjp-section-title">Recent detections</div>' + panelError('events', c.msg);
    var H = window.KJModal && window.KJModal.h;
    var evs = (c.data.events || []).map(function (e) { return H && H.normEvent ? H.normEvent(e) : e; });
    if (!evs.length) return '<div class="kjp-section-title">Recent detections</div>' + emptyBox({ icon: 'radar', title: 'No recent detections', text: p.name + ' has not been detected recently.',
      actions: '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-kj-nav="detections">' + ico('radar') + '<span>All detections</span></button>' });
    var rows = evs.map(function (e) {
      if (H && H.eventRow) return H.eventRow(e);
      var id = e.uuid || e.id;
      return '<div class="kj-list-item" data-kj-modal="' + esc(spec('event', id)) + '">' +
        (e.images && e.images.trigger ? '<img class="kj-thumb" src="' + esc(e.images.trigger) + '" alt="" loading="lazy">' : '<span class="kj-thumb kj-stat-ico">' + ico('radar') + '</span>') +
        '<div class="kj-list-main"><div class="kj-list-title kj-truncate">' + esc(e.event_type || e.policy_name || 'Detection') + '</div>' +
        '<div class="kj-list-sub kj-truncate">' + esc([String(e.stream || '').toUpperCase(), fmtWhen(e.trigger_time || e.received_at)].filter(Boolean).join(' · ')) + '</div></div></div>';
    }).join('');
    return '<div class="kjp-subhead"><span class="kjp-section-title">Recent detections · ' + evs.length + (evs.length >= 30 ? '+' : '') + '</span>' +
      '<button type="button" class="kj-link" data-kj-modal="' + esc(spec('person', d.pid)) + '">Captures</button></div><div class="kj-list kjp-evlist">' + rows + '</div>';
  }

  var TK_ST = { 'new': ['New', 'info'], ack: ['Acknowledged', 'warn'], in_progress: ['In progress', 'purple'], resolved: ['Resolved', 'success'], closed: ['Closed', ''] };
  var TK_PR = { critical: 'danger', high: 'orange', medium: 'warn', low: 'primary' };
  function panelTickets(d, p) {
    // Server-side person filter (+ a title search for manual tickets that name the person);
    // the client-side match below stays as a guard for older APIs that ignore person_id.
    var c = want(d, 'tickets', function () {
      var nm = p.unknown ? '' : String(p.name || '').trim();
      return Promise.all([
        api('/tickets', { person_id: d.pid, limit: 100 }),
        nm.length > 2 ? api('/tickets', { q: nm, limit: 50 }).catch(function () { return { tickets: [] }; }) : { tickets: [] }
      ]).then(function (rs) {
        var seen = {}, out = [];
        rs.forEach(function (r) { (r.tickets || []).forEach(function (t) { if (!seen[t.id]) { seen[t.id] = 1; out.push(t); } }); });
        out.sort(function (a, b) { return b.id - a.id; });
        return { tickets: out };
      });
    });
    var head = '<div class="kjp-subhead"><span class="kjp-section-title">Tickets</span><button type="button" class="kj-link" data-kj-nav="tickets">Open board</button></div>';
    if (c.state === 'loading') return head + panelLoading();
    if (c.state === 'err') {
      if (c.status === 401 || c.status === 403) return head + emptyBox({ icon: 'lock', title: 'Tickets are not available to you', text: 'Your role cannot view ITSM tickets.' });
      return head + panelError('tickets', c.msg);
    }
    var name = String(p.unknown ? '' : p.name || '').toLowerCase(), sid = String(p.staffId || '').toLowerCase();
    var mine = (c.data.tickets || []).filter(function (t) {
      if (t.person_id != null && String(t.person_id) === d.pid) return true;
      var hay = (String(t.title || '') + ' ' + String(t.description || '')).toLowerCase();
      return (name && name.length > 2 && hay.indexOf(name) >= 0) || (sid && sid.length > 2 && hay.indexOf(sid) >= 0);
    });
    if (!mine.length) return head + emptyBox({ icon: 'ticket', title: 'No tickets for ' + (p.unknown ? 'this person' : p.name), text: 'Safety tickets raised for this person (e.g. forklift without PPE) appear here.',
      actions: '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-kj-nav="tickets">' + ico('ticket') + '<span>Tickets board</span></button>' });
    return head + '<div class="kj-list">' + mine.slice(0, 30).map(function (t) {
      var st = TK_ST[t.status] || [t.status, ''];
      var br = t.sla && ((t.sla.response && t.sla.response.breached) || (t.sla.resolution && t.sla.resolution.breached));
      return '<button type="button" class="kj-list-item" data-kj-modal="' + esc(spec('ticket', t.ticket_no || t.id)) + '">' +
        '<span class="kj-thumb kj-stat-ico kjp-ico-' + (TK_PR[t.priority] || 'muted') + '">' + ico('ticket') + '</span>' +
        '<span class="kj-list-main"><span class="kj-list-title kj-truncate">' + esc(t.ticket_no) + ' · ' + esc(t.title) + '</span>' +
        '<span class="kj-list-sub kj-truncate">' + esc([t.priority, t.location, fmtWhen(t.created_at)].filter(Boolean).join(' · ')) + '</span></span>' +
        (br ? '<span class="kj-chip is-danger">SLA breached</span>' : '') +
        '<span class="kj-chip' + (st[1] ? ' is-' + st[1] : '') + '">' + esc(st[0]) + '</span></button>';
    }).join('') + '</div>' + (mine.length > 30 ? '<div class="kj-muted kjp-note">Showing 30 of ' + mine.length + '.</div>' : '');
  }

  /* ── legacy-section enhancements (faces + attributes stay on the dc template) ── */
  function routeIs(sub) { var r = window.KJPages && window.KJPages.current(); return !!(r && r.hub === 'people' && r.sub === sub); }
  function onLegacyClick(ev) {
    var t = ev.target; if (!(t instanceof Element)) return;
    var app = window.KJApp || S.app;
    if (!app || !app.state || !window.KJModal) return;
    // Face & body search: results were dead data (lightbox only) → person modal.
    if (routeIs('attributes')) {
      var cardEl = t.closest('.c289 > .c290');
      if (!cardEl) return;
      var idx = Array.prototype.indexOf.call(cardEl.parentNode.children, cardEl);
      var res = ((app.state.find || {}).results || [])[idx];
      if (!res || !res.uuid) return;
      ev.preventDefault(); ev.stopPropagation();
      api('/events/' + encodeURIComponent(res.uuid)).then(function (d) {
        var e = d.event || {}, pid = e.person_id || e.personId;
        if (pid) window.KJModal.open('person', String(pid), { name: e.person_name || '', photo: (e.images && e.images.trigger) || res.image || '' });
        else window.KJModal.open('event', res.uuid);
      }).catch(function () { window.KJModal.open('event', res.uuid); });
      return;
    }
    // Face registration roster: names / ids → person modal.
    if (routeIs('faces')) {
      var nm = t.closest('.pp-grid > .pp-card .pp-name, .pp-grid > .pp-card .pp-id');
      if (!nm) return;
      var c2 = nm.closest('.pp-card');
      var i2 = Array.prototype.indexOf.call(c2.parentNode.children, c2);
      var st = app.state, ppl = st.people || {}, prof = ppl.profiles || {};
      var reg = st.pplTab === 'registered';
      var rows = (ppl.rows || []).filter(function (p) { var isReg = !!p.inSense || !!prof[p.personId]; return reg ? isReg : !isReg; });
      var row = rows[i2];
      if (!row) return;
      ev.preventDefault(); ev.stopPropagation();
      window.KJModal.open('person', String(row.personId), { name: (prof[row.personId] && prof[row.personId].name) || row.senseName || '', photo: row.image || '' });
    }
  }
  var hooked = false;
  function installGlobalHooks() {
    if (hooked) return; hooked = true;
    window.addEventListener('click', onLegacyClick, true);   // capture: beats the React lightbox handler
    document.addEventListener('keydown', onDocKey);
  }

  /* ── module ───────────────────────────────────────────────────────────── */
  var MOD = {
    title: 'People',
    perm: 'view',
    defaultSub: 'directory',
    subs: {
      directory:  { label: 'Directory', icon: 'users', aliases: ['employees'], rest: true },   // #people/directory/<pid> opens the drawer
      faces:      { label: 'Face registration', legacy: 'faces', icon: 'scan-face' },
      attributes: { label: 'Face & body', legacy: 'face', icon: 'person-standing' }
    },

    enter: function (app, page) {
      ensureCss();
      if (page === 'face') { app.scheduleCharts(); app.loadPeople(); }
      if (page === 'faces') app.loadPeople();                        // unknown / registered people roster
    },

    mount: function (el, route, app) {
      ensureCss();
      S.el = el; S.app = app; S.route = route; S.feedN = 0;
      el.addEventListener('click', onClick);
      el.addEventListener('keydown', onKey);
      el.addEventListener('input', onInput);
      el.addEventListener('change', onChange);
      syncFromApp();
      refresh();
      var pid = route && route.rest && route.rest[0];
      if (pid) openDrawer(decodeURIComponent(pid));
    },

    unmount: function (el) {
      el.removeEventListener('click', onClick);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('input', onInput);
      el.removeEventListener('change', onChange);
      clearTimeout(searchT);
      closeDrawer();
      S.el = null;
    },

    onFeed: function (data, app) {
      if (!S.el) return;
      // Today's statuses drift during the day — refresh every 12th poll (~1 min).
      if (++S.feedN % 12 === 0) loadToday();
    },


    // ── Legacy Component methods (from app.js; `this` is the dc app). Wave-2 tweaks: loadPeople notifies the
    //    directory (peopleLoaded); pfSave/removeProfile/syncEmployee toast results (peopleNotice) since the old
    //    employees page that showed empMsg inline is gone. Names kept — the dc template and other hubs call them. ──
    methods: class {
  // Unique tracked people (grouped by personId) for the People roster.
  loadPeople(){
    this.setState(st=>({people:{...st.people, loading:true}}));
    fetch(`${this.API}/persons?token=${this.TOK}&days=7&limit=200`, {cache:'no-store'})
      .then(r=>r.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error('bad');
        this.setState({people:{rows:d.people||[], profiles:d.profiles||{}, loading:false, msg:''}}); peopleLoaded(false); })
      .catch(()=>{ this.setState(st=>({people:{...st.people, loading:false, msg:'Could not load people'}})); peopleLoaded(true); });
  }
  // Open the profile editor for a tracked person, pre-filled when one exists.
  // Capture thumbnails are pulled so the operator can pick the profile picture.
  openProfile(person){
    const existing=(this.state.people.profiles||{})[person.personId]||null;
    this.setState({modal:{type:'profile', data:null}, pf:{
      personId:person.personId,
      name: existing?existing.name:'',
      staff: existing?(existing.staffId||''):'',
      age: existing?(existing.age||''):'',
      gender: existing?(existing.gender||''):'',
      about: existing?(existing.about||existing.notes||''):'',
      photo: (existing&&existing.photo)||person.image||'',
      shots: person.image?[person.image]:[],
      department: existing?(existing.department||''):'',
      plant: existing?(existing.plant||''):'',
      shift: existing?(existing.shift||''):'',
      active: existing?existing.active!==false:true,
      isEdit: !!existing, msg:'', saving:false,
    }});
    if(!this.state.reg.data) this.loadRegister();   // plant / department / shift options
    fetch(`${this.API}/events?token=${this.TOK}&person_id=${encodeURIComponent(person.personId)}&limit=60`, {cache:'no-store'})
      .then(r=>r.json())
      .then(d=>{ if(!(d&&d.ok)) return;
        const shots=[...new Set((d.events||[]).map(e=>(e.images&&e.images.trigger)||null).filter(Boolean))];
        this.setState(st=>(st.pf && st.pf.personId===person.personId)
          ? {pf:{...st.pf, shots:shots.length?shots:st.pf.shots, photo:st.pf.photo||shots[0]||''}} : {});
      }).catch(()=>{});
  }
  pfSet(k,v){ this.setState(st=>({pf:{...st.pf, [k]:v, msg:''}})); }
  // Attach (or phone-camera capture) a profile picture. VisionAI capture URLs
  // expire, so an operator-supplied photo is uploaded to /uploads/profiles and
  // the stored URL points at our own host.
  pfBrowse(){
    const inp=document.getElementById('pf-file'); if(!inp) return;
    if(!inp._tmns){ inp._tmns=1;
      inp.addEventListener('change', ()=>{ const f=inp.files&&inp.files[0]; if(f) this.pfUploadPhoto(f); });
    }
    inp.click();
  }
  pfUploadPhoto(file){
    const f=this.state.pf; if(!f||!file) return;
    if(!/^image\//.test(file.type||'')){ this.setState(st=>({pf:{...st.pf, msg:'Pick an image file (JPG/PNG/WEBP)'}})); return; }
    if(file.size>6*1024*1024){ this.setState(st=>({pf:{...st.pf, msg:'Image is larger than 6 MB'}})); return; }
    this.setState(st=>({pf:{...st.pf, uploading:true, msg:'Uploading photo…'}}));
    const fd=new FormData(); fd.append('file', file); fd.append('person_id', f.personId||'new');
    fetch(`${this.API}/persons/photo?token=${this.TOK}`, {method:'POST', body:fd})
      .then(r=>r.json())
      .then(d=>{ if(!(d&&d.ok&&d.url)) throw new Error((d&&(d.error||d.msg))||'upload failed');
        this.setState(st=>{ if(!st.pf) return {};
          const shots=[d.url, ...(st.pf.shots||[]).filter(u=>u!==d.url)];
          return {pf:{...st.pf, photo:d.url, shots, uploading:false, msg:'Photo attached ✓ — save to apply'}}; });
        const inp=document.getElementById('pf-file'); if(inp) inp.value=''; })
      .catch(e=>this.setState(st=>({pf:{...st.pf, uploading:false, msg:'Upload failed — '+(e&&e.message||'error')}})));
  }
  pfSave(){
    const f=this.state.pf; if(!f) return;
    const name=String(f.name||'').trim();
    if(!name){ this.setState(st=>({pf:{...st.pf, msg:'Full name is required'}})); return; }
    if(f.isNew && !String(f.staff||'').trim()){ this.setState(st=>({pf:{...st.pf, msg:'Staff / employee ID is required'}})); return; }
    this.setState(st=>({pf:{...st.pf, saving:true, msg:'Saving…'}}));
    fetch(`${this.API}/persons?token=${this.TOK}`, {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({person_id:f.personId, new_employee:!!f.isNew, name, staff_id:f.staff||'', age:f.age, gender:f.gender, about:f.about,
        department:f.department||'', plant:f.plant||'', shift:f.shift||'', active:f.active!==false,
        photo_url:f.photo||'', actor:this.UNAME})})
      .then(r=>r.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error((d&&(d.error||d.msg))||'Save failed');
        this.setState(st=>({people:{...st.people, profiles:d.profiles||st.people.profiles, msg:'Profile saved ✓'}, modal:null, pf:null}));
        this.loadPeople(); this.fetchFeed();
        if(this.state.page==='attendance') this.loadRegister();
        peopleChanged();
        // Push the employee to SenseStudio person group 88 when there is a staff
        // ID and a photo (or when deactivating an already-pushed person).
        const prof=(d.profiles||{})[d.person_id]||{};
        if(this.PERMS.settings && (prof.ssUid || (prof.staffId && prof.photo))) this.syncEmployee(d.person_id); })
      .catch(e=>this.setState(st=>({pf:{...st.pf, saving:false, msg:(e&&e.message&&e.message!=='bad')?e.message:'Save failed'}})));
  }
  // Enrol (or rename) a tracked person. The latest capture becomes the profile
  // photo, so every later detection of this personId renders with it.
  saveProfile(person){
    const existing=(this.state.people.profiles||{})[person.personId];
    const name=window.prompt(
      existing ? ('Rename person #'+person.personId) : ('Create a profile for person #'+person.personId+'\n\nThis name and photo will be shown on every future detection of this person.'),
      existing ? existing.name : '');
    if(name===null) return;                       // cancelled
    const clean=String(name).trim();
    if(!clean){ this.setState(st=>({people:{...st.people, msg:'Name cannot be empty'}})); return; }
    const notes=window.prompt('Optional note (role, department, watchlist reason…)', existing?existing.notes:'')||'';
    this.setState(st=>({people:{...st.people, msg:'Saving…'}}));
    fetch(`${this.API}/persons?token=${this.TOK}`, {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({person_id:person.personId, name:clean, notes, photo_url:person.image||'', actor:this.UNAME})})
      .then(r=>r.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error('bad');
        this.setState(st=>({people:{...st.people, profiles:d.profiles||st.people.profiles, msg:'Profile saved ✓'}}));
        this.loadPeople(); this.fetchFeed();
        if(this._pfT) clearTimeout(this._pfT);
        this._pfT=setTimeout(()=>this.setState(st=>({people:{...st.people, msg:''}})), 2500); })
      .catch(()=>this.setState(st=>({people:{...st.people, msg:'Save failed'}})));
  }
  removeProfile(person){
    const who=person.name||('#'+person.personId);
    const inSs=!!person.ssUid;
    if(!window.confirm('Delete employee '+who+(person.staffId?(' ('+person.staffId+')'):'')+'?\n\n'
      +(inSs?'They will also be deactivated in SenseStudio, so the cameras stop recognising them.\n':'')
      +'Past detections stay; they just show as an unidentified person.')) return;
    this.setState({empMsg:'Deleting '+who+'…'});
    fetch(`${this.API}/persons/delete?token=${this.TOK}`, {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({person_id:person.personId})})
      .then(r=>r.json())
      .then(d=>{
        if(!(d&&d.ok)) throw new Error((d&&d.error)||'Delete failed');
        const ss=d.sensestudio||{};
        const dm='Deleted '+who+' ✓'+(ss.uid?(ss.deactivated?' · removed from SenseStudio':' · ⚠ SenseStudio: '+(ss.error||'not removed')):'');
        this.setState({empMsg:dm}); peopleNotice(dm, (ss.uid&&!ss.deactivated)?'warn':'success', person.personId);
        this.loadPeople(); this.fetchFeed(); if(this.state.page==='attendance') this.loadRegister(); peopleChanged(); })
      .catch(e=>{ const em='✗ '+((e&&e.message)||'Delete failed'); this.setState({empMsg:em}); peopleNotice(em, 'danger'); });
  }
  // Every stored capture of one tracked person (VisionAI personId — set even
  // for strangers). The dashboard feed only holds the recent window, so the
  // face gallery reads the full record straight from the events API.
  loadPersonCaptures(personId){
    if(!personId) return;
    if(this.state.evPerson && this.state.evPerson.id===personId) return;   // already loaded/loading
    this.setState({evPerson:{id:personId, loading:true, rows:[]}});
    fetch(`${this.API}/events?token=${this.TOK}&person_id=${encodeURIComponent(personId)}&limit=300`, {cache:'no-store'})
      .then(r=>r.json())
      .then(d=>{
        if(!(d&&d.ok)) throw new Error('bad response');
        if(!this.state.evPerson || this.state.evPerson.id!==personId) return;  // modal moved on
        const rows=(Array.isArray(d.events)?d.events:[]).map(e=>({
          id:e.uuid||String(e.id), trig:(e.images&&e.images.trigger)||null, bk:(e.images&&e.images.background)||null,
          camera:String(e.stream||e.device_serial||'').toUpperCase(),
          sim:e.similarity||'', match:e.match_image_url||(e.images&&e.images.match)||null,
          time:e.trigger_time||e.received_at||'', ts:Date.parse((e.trigger_time||e.received_at||'').replace(' ','T'))||0,
        })).filter(r=>r.trig||r.bk);
        this.setState({evPerson:{id:personId, loading:false, rows}});
      })
      .catch(()=>{ if(this.state.evPerson && this.state.evPerson.id===personId)
        this.setState({evPerson:{id:personId, loading:false, rows:[], failed:true}}); });
  }
  // ── Find people in records (attribute search on the feed) ─
  setFind(k,v){ this.setState(s=>({find:{...s.find, [k]:v}})); }
  runFind(){
    const f=this.state.find;
    const base=(window.TMNS && window.TMNS.feed) || '/feed.php';
    const sep=base.includes('?')?'&':'?';
    const qs=['find=1','hours='+(f.hours||24),'limit=24'];
    [['gender',f.gender],['age',f.age],['tops_color',f.tops_color],['mask',f.mask],['vest',f.vest]]
      .forEach(([k,v])=>{ if(v) qs.push(k+'='+encodeURIComponent(v)); });
    this.setState(s=>({find:{...s.find, busy:true}}));
    fetch(base+sep+qs.join('&'), {cache:'no-store'}).then(r=>r.json())
      .then(d=>this.setState(s=>({find:{...s.find, busy:false, ran:true, results:(d&&d.ok&&Array.isArray(d.results))?d.results:[]}})))
      .catch(()=>this.setState(s=>({find:{...s.find, busy:false, ran:true, results:[]}})));
  }
  // ── Face & Body report charts (Highcharts, official demo configs) ─
  scheduleFaceCharts(){ if(this._hcT) clearTimeout(this._hcT); this._hcT=setTimeout(()=>this.drawFaceCharts(), 90); }
  drawFaceCharts(){
    if(this.state.page!=='face' || !window.Highcharts) return;
    const f=this.state.faceR; if(!f) return;
    const dark=this.state.theme==='dark';
    // Dark/light categorical steps validated against the dashboard surfaces.
    const BLUE=dark?'#3987e5':'#2a78d6', ORANGE=dark?'#d95926':'#eb6834', VIOLET=dark?'#9085e9':'#4a3aa7';
    const host=document.querySelector('[data-theme]')||document.documentElement;
    const css=getComputedStyle(host);
    const cv=(n,fb)=>((css.getPropertyValue(n)||'').trim()||fb);
    const text=cv('--text','#E9ECF6'), text2=cv('--text2','#9AA1BD'), muted=cv('--text3','#616989'), line=cv('--line','#232847');
    const base={
      chart:{backgroundColor:'transparent', style:{fontFamily:"'IBM Plex Sans',system-ui,sans-serif"}, spacing:[8,4,4,4]},
      title:{text:undefined}, credits:{enabled:false}, exporting:{enabled:false}, legend:{enabled:false},
      xAxis:{labels:{style:{color:muted, fontSize:'10px'}}, lineColor:line, tickColor:line},
      yAxis:{title:{text:null}, labels:{style:{color:muted, fontSize:'10px'}}, gridLineColor:line, allowDecimals:false},
      tooltip:{backgroundColor:dark?'#1A1F3D':'#ffffff', borderColor:line, style:{color:text}},
    };
    this._hc=this._hc||{};
    const mk=(id,cfg)=>{ const el=document.getElementById(id); if(!el) return;
      if(this._hc[id]){ try{ this._hc[id].destroy(); }catch(e){} }
      this._hc[id]=Highcharts.chart(el, Highcharts.merge({}, base, cfg)); };
    const hrs=[...Array(24)].map((_,i)=>{ const h=new Date(Date.now()-(23-i)*3600e3).getHours(); return String(h).padStart(2,'0')+':00'; });
    mk('fbTrend',{chart:{type:'areaspline', height:215}, xAxis:{categories:hrs, tickInterval:3},
      plotOptions:{areaspline:{marker:{enabled:false}, lineWidth:2, fillOpacity:0.18}},
      series:[{name:'Person detections', data:f.hourly||[], color:BLUE}]});
    const gData=Object.entries(f.gender||{}).map(([name,y],i)=>({name, y, color:[BLUE,ORANGE,VIOLET][i%3]}));
    mk('fbGender',{chart:{type:'pie', height:215},
      tooltip:{pointFormat:'<b>{point.y}</b> ({point.percentage:.0f}%)'},
      plotOptions:{pie:{innerSize:'58%', borderColor:dark?'#0E1122':'#ffffff', borderWidth:2,
        dataLabels:{enabled:true, format:'{point.name}: {point.y}', style:{color:text2, textOutline:'none', fontSize:'11px', fontWeight:'500'}}}},
      series:[{name:'Gender', data:gData}]});
    mk('fbAge',{chart:{type:'column', height:215}, xAxis:{categories:Object.keys(f.age||{})},
      plotOptions:{column:{borderWidth:0, borderRadius:4, color:BLUE, pointPadding:0.12, groupPadding:0.12,
        dataLabels:{enabled:true, style:{color:text2, textOutline:'none'}}}},
      series:[{name:'Age band', data:Object.values(f.age||{})}]});
    const tc=Object.entries(f.topsColor||{}).sort((a,b)=>b[1]-a[1]).slice(0,8);
    mk('fbTops',{chart:{type:'bar', height:215}, xAxis:{categories:tc.map(x=>x[0])},
      plotOptions:{bar:{borderWidth:0, borderRadius:4, color:BLUE, dataLabels:{enabled:true, style:{color:text2, textOutline:'none'}}}},
      series:[{name:'Tops colour', data:tc.map(x=>x[1])}]});
    const bc=Object.entries(f.byCam||{}).sort((a,b)=>b[1]-a[1]).slice(0,8);
    mk('fbCams',{chart:{type:'bar', height:215}, xAxis:{categories:bc.map(x=>x[0])},
      plotOptions:{bar:{borderWidth:0, borderRadius:4, color:BLUE, dataLabels:{enabled:true, style:{color:text2, textOutline:'none'}}}},
      series:[{name:'Detections', data:bc.map(x=>x[1])}]});
  }
  // Register a new employee (no tracked face yet — keyed on the staff ID).
  newEmployee(){
    if(!this.state.reg.data) this.loadRegister();
    this.setState({modal:{type:'profile', data:null}, pf:{personId:'', isNew:true, name:'', staff:'', age:'', gender:'', about:'',
      department:'', plant:this.state.reg.plant||'', shift:'', active:true, photo:'', shots:[], isEdit:false, msg:'', saving:false}});
  }
  // Push employees to the SenseStudio person library (one group per plant).
  syncEmployee(pid, quiet){
    if(!this.PERMS.settings){ if(!quiet){ this.setState({empMsg:'Syncing needs the settings permission'}); peopleNotice('Syncing needs the settings permission', 'warn'); } return; }
    this.setState({empMsg:pid?'Syncing to SenseStudio…':'Syncing all employees to SenseStudio…', empBusy:true});
    fetch(`${this.API}/employees/sync`, {method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin',
      body:JSON.stringify(pid?{person_id:pid}:{all:true})})
      .then(x=>x.json())
      .then(d=>{
        const msg=!(d&&d.ok) ? ('✗ '+((d&&(d.error||d.msg))||'Sync failed'))
          : (pid ? (d.error?('✗ '+d.error):(d.warning?('⚠ '+d.warning):'Synced to SenseStudio ✓'))
                 : ('Synced '+(d.synced||0)+' · failed '+(d.failed||0)+((d.errors&&d.errors.length)?(' — '+d.errors.slice(0,3).join(' | ')):'')));
        peopleNotice(msg, /^✗/.test(msg)?'danger':(/^⚠/.test(msg)?'warn':'success'));
        this.setState(st=>({empBusy:false, empMsg:msg,
          people:{...st.people, profiles:(d&&d.profiles)||st.people.profiles}}));
      })
      .catch(()=>{ this.setState({empBusy:false, empMsg:'✗ Sync failed — network error'}); peopleNotice('✗ Sync failed — network error', 'danger'); });
  }
    }
  };

  window.KJPages.register('people', MOD);
  installGlobalHooks();
})();
