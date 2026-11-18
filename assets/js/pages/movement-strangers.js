/* Movement hub › Strangers (assets/js/pages/movement-strangers.js).
 * Mounted by assets/js/pages/movement.js for #movement/strangers via
 *   window.KJStrangers.mount(el, app, { showOnPlan: fn(person, date) })  /  .unmount()
 *
 * Unknown people (a face SenseStudio tracks under a stranger id, with no employee
 * profile) seen in a date range: KPIs, filters, paged card list, a journey drawer
 * (visits with dwell + every sighting with images + Playback buttons) that hands the
 * floor-plan path to the existing Movement playback, and operator actions (label,
 * known visitor / ignore, merge with…, register as employee). "Find by photo" asks
 * SenseStudio's stranger library and is hidden when SenseStudio is not configured.
 *
 * API (lib/StrangerRoutes.php): GET /strangers, GET /strangers/unlinked, GET /strangers/{id},
 * POST /strangers/{id}/{label|status|merge|unmerge}, POST /strangers/search.
 * Styles: assets/css/pages/strangers.css (injected below, like movement.css).
 */
(function () {
  'use strict';

  var SELF = (document.currentScript && document.currentScript.src) || '';
  function ensureCss() {
    if (document.getElementById('kj-strangers-css') || !document.head) return;
    var m = /^(.*\/)js\/pages\/movement-strangers\.js(\?.*)?$/.exec(SELF);
    var l = document.createElement('link');
    l.id = 'kj-strangers-css'; l.rel = 'stylesheet';
    l.href = m ? m[1] + 'css/pages/strangers.css' + (m[2] || '') : 'assets/css/pages/strangers.css';
    document.head.appendChild(l);
  }
  ensureCss();

  /* ── utils ─────────────────────────────────────────────────────────────── */
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) { return v == null ? '' : String(v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function ico(n, c) { return (window.KJIcon && window.KJIcon.svg) ? window.KJIcon.svg(n, c) : ''; }
  function N(v) { return Number(v) || 0; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today() { return ymd(new Date()); }
  function daysAgo(n) { return ymd(new Date(Date.now() - n * 86400000)); }
  function tHM(s) { return String(s || '').slice(11, 16) || '—'; }
  function fmtDay(s) {
    var x = new Date(String(s || '').slice(0, 10) + 'T00:00:00');
    return isNaN(x) ? String(s || '') : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function fmtWhen(s) { if (!s) return '—'; return (String(s).slice(0, 10) === today() ? 'Today' : fmtDay(s)) + ' ' + tHM(s); }
  function dwell(s) {
    s = N(s); if (s < 60) return s ? s + ' s' : '< 1 min';
    var m = Math.round(s / 60); if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + pad(m % 60) + ' min';
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function spec(type, id) { return type + ':' + encodeURIComponent(String(id == null ? '' : id)); }
  function toast(msg, tone) { if (window.KJModal && window.KJModal.toast) window.KJModal.toast(msg, tone); }
  function theme() {
    var el = document.querySelector('.c1[data-theme]') || document.querySelector('[data-theme]');
    return (el && el.getAttribute('data-theme')) === 'dark' ? 'dark' : 'light';
  }
  function nameOf(s) { return (s && s.label) ? s.label : 'Stranger #' + (s ? s.id : ''); }

  /* ── API (same conventions as movement.js) ─────────────────────────────── */
  function T() { return window.TMNS || {}; }
  function apiBase() { return T().api || '/api'; }
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
  function sidPath(id) { return '/strangers/' + encodeURIComponent(id); }

  /* ── state ─────────────────────────────────────────────────────────────── */
  var S = null;
  var STATUS = [['active', 'Active (not known / ignored)'], ['new', 'Unlabelled'], ['labelled', 'Labelled'], ['known', 'Known visitors'], ['ignored', 'Ignored'], ['all', 'All']];
  var STATUS_CHIP = { known: ['Known visitor', 'success'], ignored: ['Ignored', ''], new: ['', ''] };

  function fresh(el, app, hooks) {
    return {
      el: el, app: app, hooks: hooks || {},
      f: { from: today(), to: today(), plant: '', camera: '', status: 'active', sort: 'last', q: '' },
      page: 1, per: 24, data: null, busy: false, err: '', denied: false, seq: 0, qT: null,
      unl: null, unlOpen: false, unlBusy: false, unlPage: 1,
      find: null, findBusy: false, findOpen: false,
      drawer: null, lastAuto: Date.now()
    };
  }
  function q(sel) { return S && S.el ? S.el.querySelector(sel) : null; }

  /* ── page ──────────────────────────────────────────────────────────────── */
  function render() {
    S.el.innerHTML =
      '<div class="kj-page kj-root sg-page">' +
        '<div class="kj-page-head sg-head">' +
          '<div><h2 class="kj-page-title">Strangers</h2><p class="kj-page-sub">Faces the cameras keep tracking that have no employee profile — where they went, when, and for how long.</p></div>' +
          '<div class="sg-head-actions" data-sg-headact></div>' +
        '</div>' +
        '<div class="sg-find" data-sg-find hidden></div>' +
        '<div class="kj-grid-3 sg-kpis" data-sg-kpis></div>' +
        '<section class="kj-card sg-filters" data-sg-filters aria-label="Filters"></section>' +
        '<section class="sg-list" data-sg-list aria-live="polite"></section>' +
        '<section class="kj-card sg-unlinked" data-sg-unlinked></section>' +
      '</div>';
    paintFilters(); paintAll();
  }
  function paintAll() { paintHeadActions(); paintKpis(); paintList(); paintUnlinked(); paintFind(); }

  function paintHeadActions() {
    var b = q('[data-sg-headact]'); if (!b) return;
    var ready = S.data && S.data.sense_ready;
    b.innerHTML = (ready ? '<button type="button" class="kj-btn kj-btn-secondary" data-sg-act="find-toggle" aria-expanded="' + !!S.findOpen + '">' + ico('scan-search') + '<span>Find by photo</span></button>' : '') +
      '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon" data-sg-act="reload" aria-label="Refresh">' + ico('refresh-cw') + '</button>';
  }

  function stat(icon, val, lbl, tone, act, sub) {
    return '<button type="button" class="kj-stat sg-stat' + (tone ? ' is-' + tone : '') + '" data-sg-act="' + act + '">' +
      '<span class="kj-stat-ico">' + ico(icon) + '</span><span><span class="kj-stat-val">' + esc(val) + '</span>' +
      '<span class="kj-stat-lbl">' + esc(lbl) + '</span>' + (sub ? '<span class="sg-stat-sub">' + esc(sub) + '</span>' : '') + '</span></button>';
  }
  function paintKpis() {
    var b = q('[data-sg-kpis]'); if (!b) return;
    if (S.denied) { b.innerHTML = ''; return; }
    var k = (S.data && S.data.kpi) || null, v = function (x) { return k ? String(N(x)) : '…'; };
    b.innerHTML = stat('user-search', v(k && k.today), 'Strangers today', 'orange', 'kpi-today', 'not marked known / ignored') +
      stat('radio-tower', v(k && k.on_site), 'On site now', 'danger', 'kpi-today', 'seen in the last ' + ((k && k.onsite_min) || 15) + ' min') +
      stat('repeat', v(k && k.repeat), 'Repeat visitors', 'purple', 'kpi-repeat', 'seen today and before (30 days)');
  }

  function opt(list, cur) {
    return list.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('');
  }
  function paintFilters() {
    var b = q('[data-sg-filters]'); if (!b) return;
    var fo = (S.data && S.data.filters) || { plants: [], cameras: [] };
    var f = S.f;
    b.innerHTML =
      '<div class="sg-frow">' +
        '<label class="kj-field sg-f-date"><span class="kj-label">From</span><input type="date" class="kj-input" data-sg-f="from" value="' + esc(f.from) + '" max="' + esc(today()) + '"></label>' +
        '<label class="kj-field sg-f-date"><span class="kj-label">To</span><input type="date" class="kj-input" data-sg-f="to" value="' + esc(f.to) + '" max="' + esc(today()) + '"></label>' +
        '<label class="kj-field"><span class="kj-label">Plant</span><select class="kj-select" data-sg-f="plant"><option value="">All plants</option>' + opt((fo.plants || []).map(function (p) { return [p, p]; }), f.plant) + '</select></label>' +
        '<label class="kj-field"><span class="kj-label">Camera</span><select class="kj-select" data-sg-f="camera"><option value="">All cameras</option>' +
          opt((fo.cameras || []).map(function (c) { return [c.id, c.name + (c.location ? ' · ' + c.location : '')]; }), f.camera) + '</select></label>' +
        '<label class="kj-field"><span class="kj-label">Show</span><select class="kj-select" data-sg-f="status">' + opt(STATUS, f.status) + '</select></label>' +
        '<label class="kj-field"><span class="kj-label">Sort by</span><select class="kj-select" data-sg-f="sort">' + opt([['last', 'Last seen'], ['sightings', 'Most sightings']], f.sort) + '</select></label>' +
        '<label class="kj-field sg-f-q"><span class="kj-label">Search</span><input type="search" class="kj-input" data-sg-f="q" value="' + esc(f.q) + '" placeholder="Stranger id or label" autocomplete="off"></label>' +
      '</div>' +
      '<div class="sg-quick">' + [['today', 'Today'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']].map(function (x) {
        return '<button type="button" class="kj-chip" data-sg-act="range" data-sg-arg="' + x[0] + '">' + x[1] + '</button>';
      }).join('') + '</div>';
  }

  function emptyBox(icon, title, text, actions) {
    return '<div class="kj-empty sg-empty"><div class="kj-empty-ico">' + ico(icon) + '</div><div class="kj-empty-title">' + esc(title) + '</div>' +
      (text ? '<div class="kj-empty-text">' + esc(text) + '</div>' : '') + (actions ? '<div class="kj-row-wrap kj-empty-actions">' + actions + '</div>' : '') + '</div>';
  }
  function face(url, cls, alt) {
    return '<span class="sg-face ' + (cls || '') + '">' + ico('user-round') +
      (url ? '<img src="' + esc(url) + '" alt="' + esc(alt || '') + '" loading="lazy" referrerpolicy="no-referrer">' : '') + '</span>';
  }
  function statusChip(st) {
    var c = STATUS_CHIP[st] || ['', ''];
    return c[0] ? '<span class="kj-chip is-' + (c[1] || 'muted') + '">' + esc(c[0]) + '</span>' : '';
  }
  function card(s) {
    var zones = s.zones || [], more = zones.length > 3 ? zones.length - 3 : 0;
    return '<button type="button" class="kj-card sg-card' + (S.drawer && S.drawer.id === s.id ? ' is-selected' : '') + '" data-sg-open="' + esc(s.id) + '">' +
      '<span class="sg-card-top">' + face(s.face, 'sg-face-lg', nameOf(s)) +
        '<span class="sg-card-who"><b class="kj-truncate">' + esc(nameOf(s)) + '</b>' +
          '<span class="sg-card-id kj-truncate">' + esc(s.label ? '#' + s.id : (s.last_zone || s.last_camera || '')) + (s.aliases && s.aliases.length ? ' · +' + s.aliases.length + ' merged' : '') + '</span>' +
          '<span class="sg-card-chips">' + (s.on_site ? '<span class="kj-chip kj-chip-dot is-danger">On site</span>' : '') + statusChip(s.status) + '</span>' +
        '</span></span>' +
      '<span class="sg-card-stats">' +
        '<span><b>' + N(s.sightings) + '</b>' + (N(s.sightings) === 1 ? 'sighting' : 'sightings') + '</span>' +
        '<span><b>' + N(s.camera_count) + '</b>' + (N(s.camera_count) === 1 ? 'camera' : 'cameras') + '</span>' +
        '<span><b>' + esc(tHM(s.first_seen)) + '</b>first seen' + (String(s.first_seen).slice(0, 10) !== String(s.last_seen).slice(0, 10) ? ' ' + esc(fmtDay(s.first_seen)) : '') + '</span>' +
        '<span><b>' + esc(tHM(s.last_seen)) + '</b>last seen' + (String(s.last_seen).slice(0, 10) !== today() ? ' ' + esc(fmtDay(s.last_seen)) : '') + '</span>' +
      '</span>' +
      '<span class="sg-card-zones">' + (zones.length ? zones.slice(0, 3).map(function (z) { return '<span class="kj-chip">' + ico('map-pin') + esc(z) + '</span>'; }).join('') + (more ? '<span class="kj-chip">+' + more + '</span>' : '')
        : (s.cameras || []).slice(0, 3).map(function (c) { return '<span class="kj-chip">' + ico('cctv') + esc(c.name) + '</span>'; }).join('')) + '</span>' +
    '</button>';
  }
  function paintList() {
    var b = q('[data-sg-list]'); if (!b) return;
    if (S.denied) { b.innerHTML = '<div class="kj-card">' + emptyBox('shield-check', 'Supervisor access needed', 'Stranger tracking is available to supervisors and admins.') + '</div>'; return; }
    if (S.err && !S.data) {
      b.innerHTML = '<div class="kj-card">' + emptyBox('cloud-off', 'Could not load strangers', S.err, '<button type="button" class="kj-btn kj-btn-secondary" data-sg-act="reload">' + ico('refresh-cw') + '<span>Retry</span></button>') + '</div>';
      return;
    }
    if (!S.data) {
      var sk = ''; for (var i = 0; i < 6; i++) sk += '<div class="kj-card sg-card is-skel"><span class="kj-skel kj-skel-circle"></span><span class="kj-skel kj-skel-line"></span><span class="kj-skel kj-skel-line is-short"></span></div>';
      b.innerHTML = '<div class="sg-grid">' + sk + '</div>'; return;
    }
    var d = S.data, items = d.items || [];
    if (!items.length) {
      var filtered = S.f.plant || S.f.camera || S.f.q || S.f.status !== 'active';
      b.innerHTML = '<div class="kj-card">' + emptyBox('user-check', filtered ? 'No strangers match these filters' : (S.f.from === S.f.to && S.f.to === today() ? 'No strangers today' : 'No strangers in this range'),
        'Every face recognised in the range belongs to an employee, a known visitor or an ignored id.',
        (filtered ? '<button type="button" class="kj-btn kj-btn-secondary" data-sg-act="clear">' + ico('filter-x') + '<span>Clear filters</span></button>' : '') +
        '<button type="button" class="kj-btn kj-btn-secondary" data-sg-act="range" data-sg-arg="7d">' + ico('calendar') + '<span>Last 7 days</span></button>') + '</div>';
      return;
    }
    var from = (d.page - 1) * d.per + 1, to = from + items.length - 1, last = from + d.per - 1 >= d.total;
    b.innerHTML = '<div class="sg-list-head"><span class="kj-muted">' + esc(from + '–' + to + ' of ' + plural(N(d.total), 'stranger')) + (S.busy ? ' · refreshing…' : '') + '</span></div>' +
      '<div class="sg-grid">' + items.map(card).join('') + '</div>' +
      (d.total > d.per ? '<div class="sg-pager"><button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-sg-act="page" data-sg-arg="-1"' + (d.page <= 1 ? ' disabled' : '') + '>' + ico('chevron-left') + '<span>Previous</span></button>' +
        '<span class="kj-muted">Page ' + d.page + ' of ' + Math.max(1, Math.ceil(d.total / d.per)) + '</span>' +
        '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-sg-act="page" data-sg-arg="1"' + (last ? ' disabled' : '') + '><span>Next</span>' + ico('chevron-right') + '</button></div>' : '');
  }

  function paintUnlinked() {
    var b = q('[data-sg-unlinked]'); if (!b) return;
    if (S.denied) { b.hidden = true; return; }
    b.hidden = false;
    var u = S.unl;
    var head = '<button type="button" class="sg-unl-head" data-sg-act="unl-toggle" aria-expanded="' + !!S.unlOpen + '">' + ico('scan-face') +
      '<span class="sg-unl-title"><b>Unlinked sightings</b><span class="kj-muted">Stranger faces pushed without a stranger id — they can’t be joined into a journey, so each is shown on its own.</span></span>' +
      (u ? '<span class="kj-chip">' + esc(u.capped ? '1000+' : String(N(u.total))) + '</span>' : '') + ico(S.unlOpen ? 'chevron-up' : 'chevron-down') + '</button>';
    var body = '';
    if (S.unlOpen) {
      if (S.unlBusy && !u) body = '<div class="sg-unl-grid"><span class="kj-skel kj-skel-tile"></span><span class="kj-skel kj-skel-tile"></span><span class="kj-skel kj-skel-tile"></span></div>';
      else if (u && u.err) body = '<div class="kj-help">' + esc(u.err) + '</div>';
      else if (u && !(u.items || []).length) body = '<div class="kj-help sg-unl-none">None in this range — every stranger face carried an id.</div>';
      else if (u) {
        body = '<div class="sg-unl-grid">' + u.items.map(function (x) {
          return '<div class="sg-unl-item">' +
            '<button type="button" class="sg-unl-img" ' + (x.scene || x.face ? 'data-kj-modal="' + esc(spec('image', x.scene || x.face)) + '"' : 'disabled') + ' aria-label="Open image">' + face(x.face, 'sg-face-md', 'Face capture') + '</button>' +
            '<span class="sg-unl-meta"><b>' + esc(fmtWhen(x.time)) + '</b><span class="kj-truncate">' + esc(x.camera + (x.location ? ' · ' + x.location : '')) + '</span>' +
            (x.uuid ? '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kj-playback="' + esc(x.uuid) + '">' + ico('play') + '<span>Playback</span></button>' : '') + '</span></div>';
        }).join('') + '</div>' +
        (u.total > u.per ? '<div class="sg-pager"><button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-sg-act="unl-page" data-sg-arg="-1"' + (u.page <= 1 ? ' disabled' : '') + '>' + ico('chevron-left') + '<span>Newer</span></button>' +
          '<span class="kj-muted">Page ' + u.page + '</span><button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-sg-act="unl-page" data-sg-arg="1"' + (u.page * u.per >= u.total ? ' disabled' : '') + '><span>Older</span>' + ico('chevron-right') + '</button></div>' : '');
      }
    }
    b.innerHTML = head + (S.unlOpen ? '<div class="sg-unl-body">' + body + '</div>' : '');
  }

  /* ── Find by photo ─────────────────────────────────────────────────────── */
  function paintFind() {
    var b = q('[data-sg-find]'); if (!b) return;
    var ready = S.data && S.data.sense_ready;
    b.hidden = !(ready && S.findOpen);
    if (b.hidden) { b.innerHTML = ''; return; }
    var r = S.find, res = '';
    if (S.findBusy) res = '<div class="kj-help">' + ico('loader') + ' Searching the SenseStudio stranger library…</div>';
    else if (r && r.err) res = '<div class="sg-msg is-err">' + esc(r.err) + '</div>';
    else if (r) {
      res = (r.matches || []).length ? '<div class="kj-list sg-find-list">' + r.matches.map(function (m, i) {
        var reg = m.registered;
        return '<button type="button" class="kj-list-item sg-find-item" data-sg-findpick="' + i + '"' + (reg ? ' disabled' : '') + '>' + face(m.face, 'sg-face-md', '') +
          '<span class="kj-list-main"><span class="kj-list-title kj-truncate">' + esc(reg ? (reg.name + ' (employee)') : nameOf(m)) + '</span>' +
          '<span class="kj-list-sub kj-truncate">' + esc((m.label ? '#' + m.id + ' · ' : '') + plural(N(m.sightings_30d), 'sighting') + ' in 30 days' + (m.last_seen ? ' · last ' + fmtWhen(m.last_seen) : '')) + '</span></span>' +
          '<span class="kj-chip ' + (m.confident ? 'is-success' : 'is-warn') + '">' + esc(N(m.score).toFixed(1)) + '%</span></button>';
      }).join('') + '</div>' : '<div class="kj-help">' + esc(r.note || 'No stranger matched this photo.') + '</div>';
    }
    b.innerHTML = '<div class="kj-card sg-find-card">' +
      '<div class="sg-find-row">' + ico('image-up') +
        '<div class="sg-find-txt"><b>Find a stranger by photo</b><span class="kj-muted">Upload a clear, front-facing face photo (JPG, PNG or WebP, max 6 MB). SenseStudio compares it with its stranger library.</span></div>' +
        '<label class="kj-btn kj-btn-primary sg-find-btn">' + ico('upload') + '<span>Choose photo</span><input type="file" class="kj-sr-only" accept="image/jpeg,image/png,image/webp" data-sg-findfile></label>' +
        '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon" data-sg-act="find-toggle" aria-label="Close">' + ico('x') + '</button>' +
      '</div>' + res + '</div>';
  }
  function runFind(file) {
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) { S.find = { err: 'That photo is larger than 6 MB.' }; paintFind(); return; }
    var fd = new FormData(); fd.append('file', file);
    S.findBusy = true; S.find = null; paintFind();
    post('/strangers/search', fd).then(function (d) {
      if (!S) return; S.findBusy = false; S.find = { matches: d.matches || [], note: d.note }; paintFind();
    }).catch(function (e) {
      if (!S) return; S.findBusy = false; S.find = { err: e.message || 'Search failed' }; paintFind();
    });
  }

  /* ── loading ───────────────────────────────────────────────────────────── */
  function params() {
    var f = S.f;
    return { from: f.from, to: f.to, plant: f.plant, camera: f.camera, status: f.status, q: f.q, sort: f.sort === 'sightings' ? 'sightings' : '', page: S.page, per: S.per };
  }
  function load(quiet) {
    if (!S) return;
    var seq = ++S.seq; S.busy = true; S.err = '';
    if (!quiet) paintList();
    get('/strangers', params()).then(function (d) {
      if (!S || seq !== S.seq) return;
      var hadFilters = !!S.data;
      S.busy = false; S.data = d; S.denied = false;
      if (!hadFilters) paintFilters();
      paintAll();
      if (S.unlOpen) loadUnlinked();
    }).catch(function (e) {
      if (!S || seq !== S.seq) return;
      S.busy = false; S.err = e.message || 'Request failed'; S.denied = e.status === 403;
      if (e.status === 403) S.data = null;
      paintAll();
    });
  }
  function loadUnlinked() {
    if (!S) return;
    var seq = (S.unlSeq = (S.unlSeq || 0) + 1);
    S.unlBusy = true; paintUnlinked();
    get('/strangers/unlinked', { from: S.f.from, to: S.f.to, plant: S.f.plant, camera: S.f.camera, page: S.unlPage }).then(function (d) {
      if (!S || seq !== S.unlSeq) return; S.unlBusy = false; S.unl = d; paintUnlinked();
    }).catch(function (e) {
      if (!S || seq !== S.unlSeq) return; S.unlBusy = false; S.unl = { err: e.message || 'Could not load', items: [] }; paintUnlinked();
    });
  }
  function setFilter(k, v) {
    S.f[k] = v; S.page = 1; S.unlPage = 1;
    if (S.f.from > S.f.to) { var t = S.f.from; S.f.from = S.f.to; S.f.to = t; paintFilters(); }
    load();
  }

  /* ── journey drawer ────────────────────────────────────────────────────── */
  function canEdit() { return !!(S.data && S.data.can_edit); }
  function openDrawer(id, range) {
    if (!id) return;
    var d = S.drawer;
    if (!d || d.id !== id) {
      S.drawer = d = { id: String(id), data: null, err: '', busy: false, from: (range && range.from) || S.f.from, to: (range && range.to) || S.f.to,
        edit: false, merge: false, all: false, el: d && d.el, bd: d && d.bd, seq: d ? d.seq : 0, day: '' };
    }
    if (!d.el) {
      var bd = document.createElement('div'); bd.className = 'kj-drawer-backdrop sg-drawer-bd';
      var el = document.createElement('aside'); el.className = 'kj-drawer kj-root sg-drawer';
      el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Stranger journey'); el.tabIndex = -1;
      document.body.appendChild(bd); document.body.appendChild(el);
      d.el = el; d.bd = bd;
      bd.addEventListener('click', closeDrawer);
      el.addEventListener('click', onDrawerClick);
      el.addEventListener('keydown', onDrawerKey);
      el.addEventListener('error', onImgError, true);
      requestAnimationFrame(function () { bd.classList.add('is-open'); el.classList.add('is-open'); });
      setTimeout(function () { try { el.focus(); } catch (e) { /* ignore */ } }, 40);
    }
    d.el.setAttribute('data-theme', theme()); d.bd.setAttribute('data-theme', theme());
    paintDrawer(); markSelected();
    loadJourney();
  }
  function closeDrawer() {
    var d = S && S.drawer; if (!d) return;
    S.drawer = null;
    if (d.el) {
      d.el.classList.remove('is-open'); d.bd.classList.remove('is-open');
      setTimeout(function () { if (d.el.parentNode) d.el.parentNode.removeChild(d.el); if (d.bd.parentNode) d.bd.parentNode.removeChild(d.bd); }, 260);
    }
    markSelected();
  }
  function markSelected() {
    if (!S || !S.el) return;
    Array.prototype.forEach.call(S.el.querySelectorAll('[data-sg-open]'), function (c) {
      c.classList.toggle('is-selected', !!(S.drawer && c.getAttribute('data-sg-open') === S.drawer.id));
    });
  }
  function loadJourney() {
    var d = S.drawer; if (!d) return;
    var seq = ++d.seq; d.busy = true; d.err = '';
    get(sidPath(d.id), { from: d.from, to: d.to }).then(function (r) {
      if (!S || S.drawer !== d || seq !== d.seq) return;
      d.busy = false; d.data = r.stranger;
      if (d.data && d.data.id !== d.id) d.id = d.data.id;   // an alias opens its canonical stranger
      var days = (d.data && d.data.days) || [];
      if (!d.day || days.indexOf(d.day) < 0) d.day = days.length ? days[days.length - 1] : d.to;
      paintDrawer(); markSelected();
    }).catch(function (e) {
      if (!S || S.drawer !== d || seq !== d.seq) return;
      d.busy = false; d.err = e.message || 'Could not load the journey'; paintDrawer();
    });
  }
  function paintDrawer() {
    var d = S.drawer; if (!d || !d.el) return;
    var j = d.data;
    var title = j ? nameOf(j) : 'Stranger #' + d.id;
    var head = '<div class="kj-drawer-head sg-dhead"><h2 class="sg-dtitle kj-truncate">' + esc(title) + '</h2><span class="kj-spacer"></span>' +
      '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon" data-sg-d="close" aria-label="Close">' + ico('x') + '</button></div>';
    var body;
    if (!j && d.busy) body = '<div class="sg-dskel"><span class="kj-skel kj-skel-circle"></span><span class="kj-skel kj-skel-title"></span><span class="kj-skel kj-skel-line"></span><span class="kj-skel kj-skel-block"></span></div>';
    else if (!j) body = emptyBox('cloud-off', 'Could not load this stranger', d.err, '<button type="button" class="kj-btn kj-btn-secondary" data-sg-d="retry">' + ico('refresh-cw') + '<span>Retry</span></button>');
    else body = hero(j, d) + actions(j, d) + summary(j) + visits(j) + sightings(j, d);
    d.el.innerHTML = head + '<div class="kj-drawer-body sg-dbody">' + body + '</div>';
  }
  function hero(j, d) {
    return '<div class="sg-hero">' +
      '<button type="button" class="sg-hero-face"' + (j.face ? ' data-kj-modal="' + esc(spec('image', j.face)) + '"' : ' disabled') + ' aria-label="Open face capture">' + face(j.face, 'sg-face-xl', 'Face capture') + '</button>' +
      '<div class="sg-hero-txt"><b>' + esc(nameOf(j)) + '</b>' +
        '<span class="kj-muted">Stranger id <code class="kj-mono">' + esc(j.id) + '</code></span>' +
        '<span class="sg-card-chips">' + statusChip(j.status) + (j.registered ? '<span class="kj-chip is-success">Registered as ' + esc(j.registered.name) + '</span>' : '') + '</span>' +
        (j.note ? '<span class="sg-note">' + esc(j.note) + '</span>' : '') +
        ((j.aliases || []).length ? '<span class="sg-aliases"><span class="kj-muted">Merged ids:</span>' + j.aliases.map(function (a) {
          return '<span class="kj-chip">#' + esc(a) + (canEdit() && !j.registered ? '<button type="button" class="sg-chip-x" data-sg-d="unmerge" data-sg-arg="' + esc(a) + '" aria-label="Split #' + esc(a) + ' off again" title="Split off again">' + ico('x') + '</button>' : '') + '</span>';
        }).join('') + '</span>' : '') +
      '</div></div>' +
      '<div class="sg-drange"><label class="kj-field"><span class="kj-label">From</span><input type="date" class="kj-input" data-sg-dr="from" value="' + esc(d.from) + '" max="' + esc(today()) + '"></label>' +
        '<label class="kj-field"><span class="kj-label">To</span><input type="date" class="kj-input" data-sg-dr="to" value="' + esc(d.to) + '" max="' + esc(today()) + '"></label></div>';
  }
  function actions(j, d) {
    var days = j.days || [];
    var plan = '<div class="sg-plan"><span class="kj-label">Path on the floor plan</span><div class="sg-plan-row">' +
      (days.length > 1 ? '<select class="kj-select" data-sg-dday aria-label="Day">' + days.slice().reverse().map(function (x) { return '<option value="' + esc(x) + '"' + (x === d.day ? ' selected' : '') + '>' + esc(fmtDay(x)) + '</option>'; }).join('') + '</select>' : '') +
      '<button type="button" class="kj-btn kj-btn-primary kj-btn-sm" data-sg-d="plan"' + (days.length ? '' : ' disabled') + '>' + ico('map') + '<span>Show on floor plan' + (days.length === 1 ? ' · ' + esc(fmtDay(days[0])) : '') + '</span></button></div></div>';
    if (j.registered || !canEdit()) return '<div class="sg-dsec">' + plan + '</div>';
    var st = j.status || 'new';
    var btns = '<div class="kj-row-wrap sg-acts">' +
      '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-sg-d="edit">' + ico('tag') + '<span>' + (j.label ? 'Edit label' : 'Label') + '</span></button>' +
      (st === 'known' ? '' : '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-sg-d="status" data-sg-arg="known">' + ico('user-check') + '<span>Known visitor</span></button>') +
      (st === 'ignored' ? '' : '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-sg-d="status" data-sg-arg="ignored">' + ico('eye-off') + '<span>Ignore</span></button>') +
      (st !== 'new' ? '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-sg-d="status" data-sg-arg="new">' + ico('rotate-ccw') + '<span>Back to active</span></button>' : '') +
      '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-sg-d="merge">' + ico('merge') + '<span>Merge with…</span></button>' +
      '<button type="button" class="kj-btn kj-btn-soft kj-btn-sm" data-sg-d="register">' + ico('user-plus') + '<span>Register as employee</span></button>' +
      '</div>';
    var form = '';
    if (d.edit) {
      form = '<form class="sg-form" data-sg-form="label"><label class="kj-field"><span class="kj-label">Label</span><input class="kj-input" name="label" maxlength="120" value="' + esc(j.label) + '" placeholder="e.g. Contractor – ABC" autocomplete="off"></label>' +
        '<label class="kj-field"><span class="kj-label">Note</span><textarea class="kj-textarea" name="note" maxlength="500" rows="2" placeholder="Optional">' + esc(j.note) + '</textarea></label>' +
        '<div class="kj-row-wrap"><button type="submit" class="kj-btn kj-btn-primary kj-btn-sm">' + ico('check') + '<span>Save</span></button><button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-sg-d="edit">Cancel</button></div></form>';
    } else if (d.merge) {
      var others = ((S.data && S.data.items) || []).filter(function (s) { return s.id !== j.id; });
      form = '<form class="sg-form" data-sg-form="merge"><label class="kj-field"><span class="kj-label">Same person as stranger…</span>' +
        '<input class="kj-input" name="into" list="sg-merge-ids" placeholder="Stranger id" autocomplete="off" required pattern="[A-Za-z0-9_.:\\-]{1,64}"></label>' +
        '<datalist id="sg-merge-ids">' + others.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(nameOf(s) + ' · ' + plural(N(s.sightings), 'sighting')) + '</option>'; }).join('') + '</datalist>' +
        '<span class="kj-help">#' + esc(j.id) + ' and its sightings join that stranger’s journey. You can split it off again later.</span>' +
        '<div class="kj-row-wrap"><button type="submit" class="kj-btn kj-btn-primary kj-btn-sm">' + ico('merge') + '<span>Merge</span></button><button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-sg-d="merge">Cancel</button></div></form>';
    }
    return '<div class="sg-dsec">' + btns + form + plan + '</div>';
  }
  function summary(j) {
    var s = j.summary || {};
    var cell = function (v, l) { return '<div class="sg-sum-cell"><b>' + esc(v) + '</b><span>' + esc(l) + '</span></div>'; };
    return '<div class="sg-summary">' + cell(String(N(s.sightings)) + (s.truncated ? '+' : ''), 'sightings') + cell(String(N(s.cameras)), 'cameras') +
      cell(fmtWhen(s.first_seen), 'first seen') + cell(fmtWhen(s.last_seen), 'last seen') + cell(dwell(s.dwell_s), 'total dwell') + '</div>';
  }
  function playBtn(uuid) {
    return uuid ? '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kj-playback="' + esc(uuid) + '">' + ico('play') + '<span>Playback</span></button>' : '';
  }
  function visits(j) {
    var v = j.visits || [];
    if (!v.length) return '<div class="sg-dsec">' + emptyBox('footprints', 'No sightings in this range', 'Widen the dates above to see older visits.') + '</div>';
    var lastDay = '';
    return '<div class="sg-dsec"><div class="sg-dsec-title">Journey · ' + plural(v.length, 'stop') + '</div><ol class="sg-tl">' + v.map(function (x, i) {
      var day = String(x.arrive).slice(0, 10), sep = day !== lastDay ? '<li class="sg-tl-day">' + esc(fmtDay(day)) + '</li>' : '';
      lastDay = day;
      return sep + '<li class="sg-tl-item' + (i === v.length - 1 ? ' is-last' : '') + '">' +
        '<span class="sg-tl-dot">' + (i + 1) + '</span>' +
        '<button type="button" class="sg-tl-img"' + (x.scene || x.face ? ' data-kj-modal="' + esc(spec('image', x.scene || x.face)) + '"' : ' disabled') + ' aria-label="Open image">' + face(x.face, 'sg-face-md', '') + '</button>' +
        '<span class="sg-tl-main"><b class="kj-truncate">' + esc(x.location || x.camera) + '</b>' +
          '<span class="kj-muted kj-truncate">' + esc((x.location ? x.camera + ' · ' : '') + tHM(x.arrive) + (x.depart !== x.arrive ? '–' + tHM(x.depart) : '')) + '</span>' +
          '<span class="sg-tl-meta"><span class="kj-chip is-purple">' + ico('timer') + esc(dwell(x.dwell_s)) + '</span><span class="kj-chip">' + esc(plural(N(x.count), 'sighting')) + '</span>' + playBtn(x.uuid) + '</span>' +
        '</span></li>';
    }).join('') + '</ol></div>';
  }
  function sightings(j, d) {
    var st = j.steps || [];
    if (!st.length) return '';
    var list = d.all ? st : st.slice(-12);
    return '<div class="sg-dsec"><div class="sg-dsec-title kj-row"><span>Every sighting' + (d.all ? '' : ' · latest ' + list.length) + '</span><span class="kj-spacer"></span>' +
      (st.length > 12 ? '<button type="button" class="kj-link" data-sg-d="all">' + (d.all ? 'Show latest only' : 'Show all ' + st.length) + '</button>' : '') + '</div>' +
      '<div class="sg-shots">' + list.slice().reverse().map(function (x) {
        return '<figure class="sg-shot"><button type="button" class="sg-shot-img"' + (x.scene || x.face ? ' data-kj-modal="' + esc(spec('image', x.scene || x.face)) + '"' : ' disabled') + ' aria-label="Open scene image">' +
          face(x.face, 'sg-face-shot', '') + '</button><figcaption><b>' + esc(fmtWhen(x.time)) + '</b><span class="kj-truncate">' + esc(x.camera + (x.location ? ' · ' + x.location : '')) + '</span>' + playBtn(x.uuid) + '</figcaption></figure>';
      }).join('') + '</div>' + (j.summary && j.summary.truncated ? '<div class="kj-help">Showing the first 1000 sightings — narrow the dates for the rest.</div>' : '') + '</div>';
  }

  function act(path, body, ok) {
    var d = S.drawer;
    return post(sidPath(d.id) + path, body).then(function (r) {
      toast(ok, 'success');
      if (!S) return r;
      if (S.drawer === d) { d.edit = false; d.merge = false; loadJourney(); }
      load(true);
      return r;
    }).catch(function (e) { toast(e.message || 'Could not save', 'danger'); });
  }
  function onDrawerClick(ev) {
    var t = ev.target instanceof Element ? ev.target : null; if (!t || !S || !S.drawer) return;
    if (t.closest('[data-kj-modal],[data-kj-playback]')) return;   // KJModal / playback handle these
    var b = t.closest('[data-sg-d]'); if (!b) return;
    var d = S.drawer, j = d.data, a = b.getAttribute('data-sg-d'), arg = b.getAttribute('data-sg-arg');
    if (a === 'close') { closeDrawer(); return; }
    if (a === 'retry') { loadJourney(); return; }
    if (a === 'all') { d.all = !d.all; paintDrawer(); return; }
    if (a === 'edit') { d.edit = !d.edit; d.merge = false; paintDrawer(); var i = d.edit && d.el.querySelector('input[name="label"]'); if (i) i.focus(); return; }
    if (a === 'merge') { d.merge = !d.merge; d.edit = false; paintDrawer(); var m = d.merge && d.el.querySelector('input[name="into"]'); if (m) m.focus(); return; }
    if (!j) return;
    if (a === 'status') {
      var label = { known: 'Marked as a known visitor', ignored: 'Ignored — hidden from the list and from alerts', new: 'Back in the active list' }[arg] || 'Saved';
      act('/status', { status: arg }, label); return;
    }
    if (a === 'unmerge') {
      if (!window.confirm('Split #' + arg + ' off into its own stranger again?')) return;
      post(sidPath(arg) + '/unmerge', {}).then(function () { toast('#' + arg + ' split off', 'success'); if (S && S.drawer === d) loadJourney(); load(true); })
        .catch(function (e) { toast(e.message || 'Could not split', 'danger'); });
      return;
    }
    if (a === 'plan') {
      var sel = d.el.querySelector('[data-sg-dday]'), day = sel ? sel.value : (j.days || [])[0];
      var who = { person_id: j.id, name: nameOf(j), known: false, photo: j.face || null };
      closeDrawer();
      if (S.hooks.showOnPlan) S.hooks.showOnPlan(who, day);
      return;
    }
    if (a === 'register') {
      // Existing People enrol flow: app.openProfile({personId, image}) opens the employee form keyed on this
      // stranger id, prefilled with the face crop and every capture of it (people.js / app.js).
      var app = (window.KJPages && window.KJPages.app && window.KJPages.app()) || S.app || window.KJApp;
      if (!app || typeof app.openProfile !== 'function') { toast('The employee form is still loading — try again in a moment.', 'warn'); return; }
      closeDrawer();
      app.openProfile({ personId: j.id, image: j.face || '' });
      return;
    }
  }
  function onDrawerKey(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); closeDrawer(); } }
  function onDrawerSubmit(ev) {
    var f = ev.target; if (!S || !S.drawer || !(f instanceof HTMLFormElement)) return;
    var kind = f.getAttribute('data-sg-form'); if (!kind) return;
    ev.preventDefault();
    if (kind === 'label') { act('/label', { label: f.elements.label.value, note: f.elements.note.value }, 'Label saved'); return; }
    if (kind === 'merge') {
      var into = String(f.elements.into.value || '').trim(); if (!into) return;
      if (!window.confirm('Merge #' + S.drawer.id + ' into stranger #' + into + '? Their sightings become one journey.')) return;
      var d = S.drawer;
      post(sidPath(d.id) + '/merge', { into: into }).then(function (r) {
        toast('Merged into #' + ((r.stranger && r.stranger.id) || into), 'success');
        if (!S) return;
        if (S.drawer === d) { d.merge = false; d.id = (r.stranger && r.stranger.id) || into; d.data = null; paintDrawer(); loadJourney(); }
        load(true);
      }).catch(function (e) { toast(e.message || 'Could not merge', 'danger'); });
    }
  }
  function onDrawerChange(ev) {
    var t = ev.target; if (!S || !S.drawer || !(t instanceof Element)) return;
    var d = S.drawer;
    if (t.matches('[data-sg-dr]')) {
      if (!t.value) return;
      d[t.getAttribute('data-sg-dr')] = t.value;
      if (d.from > d.to) { var x = d.from; d.from = d.to; d.to = x; }
      loadJourney(); return;
    }
    if (t.matches('[data-sg-dday]')) { d.day = t.value; }
  }

  /* ── page events ───────────────────────────────────────────────────────── */
  function onClick(ev) {
    var t = ev.target instanceof Element ? ev.target : null; if (!t || !S) return;
    if (t.closest('[data-kj-modal],[data-kj-playback]')) return;
    var open = t.closest('[data-sg-open]');
    if (open) { openDrawer(open.getAttribute('data-sg-open')); return; }
    var fp = t.closest('[data-sg-findpick]');
    if (fp) { var m = ((S.find && S.find.matches) || [])[N(fp.getAttribute('data-sg-findpick'))]; if (m) openDrawer(m.id, { from: daysAgo(29), to: today() }); return; }
    var a = t.closest('[data-sg-act]'); if (!a) return;
    var act = a.getAttribute('data-sg-act'), arg = a.getAttribute('data-sg-arg');
    switch (act) {
      case 'reload': load(); return;
      case 'range': {
        S.f.to = today(); S.f.from = arg === '30d' ? daysAgo(29) : (arg === '7d' ? daysAgo(6) : today());
        S.page = 1; paintFilters(); load(); return;
      }
      case 'kpi-today': S.f.from = today(); S.f.to = today(); S.f.status = 'active'; S.f.sort = 'last'; S.page = 1; paintFilters(); load(); return;
      case 'kpi-repeat': S.f.from = daysAgo(29); S.f.to = today(); S.f.status = 'active'; S.f.sort = 'sightings'; S.page = 1; paintFilters(); load(); return;
      case 'clear': S.f.plant = ''; S.f.camera = ''; S.f.q = ''; S.f.status = 'active'; S.page = 1; paintFilters(); load(); return;
      case 'page': S.page = Math.max(1, S.page + N(arg)); load(); var top = q('[data-sg-list]'); if (top && top.scrollIntoView) top.scrollIntoView({ block: 'start', behavior: 'smooth' }); return;
      case 'unl-toggle': S.unlOpen = !S.unlOpen; paintUnlinked(); if (S.unlOpen && !S.unl) loadUnlinked(); return;
      case 'unl-page': S.unlPage = Math.max(1, S.unlPage + N(arg)); loadUnlinked(); return;
      case 'find-toggle': S.findOpen = !S.findOpen; paintHeadActions(); paintFind(); return;
    }
  }
  function onChange(ev) {
    var t = ev.target; if (!S || !(t instanceof Element)) return;
    if (t.matches('[data-sg-findfile]')) { runFind(t.files && t.files[0]); t.value = ''; return; }
    if (t.matches('[data-sg-f]')) {
      var k = t.getAttribute('data-sg-f');
      if (k === 'q') return;   // typed search is debounced in onInput
      if ((k === 'from' || k === 'to') && !t.value) return;
      setFilter(k, t.value);
    }
  }
  function onInput(ev) {
    var t = ev.target; if (!S || !(t instanceof Element) || !t.matches('[data-sg-f="q"]')) return;
    clearTimeout(S.qT);
    var v = t.value;
    S.qT = setTimeout(function () { if (S) setFilter('q', v.trim()); }, 350);
  }
  /** Broken / blocked capture URL → keep the silhouette placeholder. */
  function onImgError(ev) {
    var t = ev.target;
    if (t && t.tagName === 'IMG' && t.parentNode && t.parentNode.classList && t.parentNode.classList.contains('sg-face')) t.parentNode.removeChild(t);
  }

  /* ── mount / unmount ───────────────────────────────────────────────────── */
  var LISTEN = [['click', onClick, false], ['change', onChange, false], ['input', onInput, false], ['error', onImgError, true]];
  function mount(el, app, hooks) {
    ensureCss();
    if (S) unmount();
    S = fresh(el, app, hooks);
    LISTEN.forEach(function (l) { el.addEventListener(l[0], l[1], l[2]); });
    document.addEventListener('submit', onDrawerSubmit, true);
    document.addEventListener('change', onDrawerChange, true);
    render();
    load();
  }
  function unmount() {
    if (!S) return;
    closeDrawer();
    clearTimeout(S.qT);
    var el = S.el;
    LISTEN.forEach(function (l) { el.removeEventListener(l[0], l[1], l[2]); });
    document.removeEventListener('submit', onDrawerSubmit, true);
    document.removeEventListener('change', onDrawerChange, true);
    S = null;
  }
  /** Quiet refresh from the 5 s feed poll (at most once a minute, today's range only, drawer closed). */
  function onFeed() {
    if (!S || S.busy || S.drawer || S.f.to !== today()) return;
    var now = Date.now(); if (S.lastAuto && now - S.lastAuto < 60000) return;
    S.lastAuto = now; load(true);
  }

  window.KJStrangers = { mount: mount, unmount: unmount, onFeed: onFeed, open: function (id) { if (S) openDrawer(String(id)); } };
})();
