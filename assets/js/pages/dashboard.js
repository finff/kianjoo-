/* Dashboard hub — page module (assets/js/pages/dashboard.js).
 * Owner: wave-2 M3 widget-dashboard agent.  Spec: docs/plan/REVAMP_PLAN.md M3,
 * mockup docs/mockup-ui/generated/admin-dashboard-widgets.png.
 *
 * #dashboard (sub "overview", also the target of the legacy #overview / #aiperf
 * hashes) is a customisable widget grid rendered into the page host:
 *   • CSS grid, 4 columns; widget size "1xN" = N columns (1x1…1x4); charts and
 *     lists are two row-units tall. Stacks to 2 columns ≤1100px, 1 column on phones.
 *   • Widget registry (WIDGETS below): {id, title, perm, tier, sizes[], needs[],
 *     sig(ctx), render(el, ctx), onFeed?}. The catalog is RBAC-filtered (TMNS perms
 *     + the same role→tier map as lib/AiGuard.php); every widget's data comes from
 *     an API that re-checks access server-side.
 *   • Customise mode: add (catalog modal / "+ Add widget" ghost tile), remove,
 *     drag-reorder (HTML5 DnD; keyboard: arrow keys on the grip), resize among the
 *     widget's allowed sizes.
 *   • Saved dashboards (presets): up to 12 named dashboards per user, each with its
 *     own layout + filters, one default (★); switcher next to "Edit dashboard";
 *     /api/dashboard/list|create|{id}/save|rename|delete|default (lib/DashboardRoutes.php,
 *     table user_dashboards v2). No /dashboard/list (older server / offline) = compat
 *     mode on the legacy /api/dashboard/layout alias. Layout null = role default.
 *   • Filter bar (date range, plant, cameras, severity — saved per dashboard) and
 *     session-only time travel (window.KJDash.openTimeTravel). Per-widget semantics:
 *     FILT below + docs/plan/WIDGETS.md "Filters".
 *   • Every datum opens a KJModal (stat / event / camera / ticket / leave /
 *     attendance-day / image + the dash-* types registered here) or data-kj-nav.
 * The previous dc-template overview stays reachable at #dashboard/classic (hidden
 * tab) so nothing that existed is lost (REVAMP_PLAN §2c).
 * Styles: assets/css/pages/dashboard.css + dashboard-widgets.css (wave-4 widget pack), injected on first mount.
 * window.KJWidgets = public catalog [{id,title,desc,perm,tier,sizes,icon}] (settings role preview).
 */
(function () {
  'use strict';

  var CSS_HREF = 'assets/css/pages/dashboard.css';
  var CSS_WIDGETS_HREF = 'assets/css/pages/dashboard-widgets.css';   // wave-4 widget pack
  var LOTTIE_JS = 'assets/vendor/lottie/lottie_light.min.js';
  var LOTTIE_DIR = 'assets/lottie/';
  var SIZES = ['1x1', '1x2', '1x3', '1x4'];
  var PPE_TARGET = 98;               // % — dashed target line on the PPE trend
  var TIER_RANK = { staff: 1, supervisor: 2, admin: 3 };

  /* ── tiny helpers ─────────────────────────────────────────────────────── */
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ico(name, cls) { return (window.KJIcon && window.KJIcon.svg) ? window.KJIcon.svg(name, cls) : ''; }
  function N(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function fmtN(v) { return N(v).toLocaleString('en-US'); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today() { return ymd(new Date()); }
  function daysAgo(n) { var d = new Date(); d.setDate(d.getDate() - n); return ymd(d); }
  function spec(type, id) { return type + ':' + encodeURIComponent(String(id == null ? '' : id)); }
  function modalAttr(type, id, seed) {
    return ' data-kj-modal="' + esc(spec(type, id)) + '"' + (seed ? " data-kj-seed='" + esc(JSON.stringify(seed)) + "'" : '');
  }
  function navAttr(path) { return ' data-kj-nav="' + esc(path) + '"'; }
  function w5(pct) { return 'kj-w-' + Math.max(0, Math.min(100, Math.round(N(pct) / 5) * 5)); }
  function toMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    var t = Date.parse(String(v).replace(' ', 'T'));
    return isNaN(t) ? null : t;
  }
  function fmtWhen(v) {
    var ms = toMs(v); if (ms == null) return '';
    var d = new Date(ms), same = ymd(d) === today();
    return (same ? '' : d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] + ', ') +
      pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function hms(sec) {
    sec = Math.abs(Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h > 99 ? Math.floor(h / 24) + 'd ' + pad(h % 24) : pad(h)) + ':' + pad(m) + ':' + pad(s);
  }
  function initials(name) {
    var p = String(name || '').trim().split(/\s+/).filter(Boolean);
    return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' '); }
  function tsOfEvent(e) { return toMs(e && (e.ts || e.received || e.time)) || 0; }

  /* ── identity / RBAC (mirrors lib/AiGuard.php tierOf) ─────────────────── */
  function me() { return (window.TMNS && window.TMNS.user) || {}; }
  function can(perm) { return window.KJPages ? window.KJPages.can(perm) : true; }
  function tier() {
    var u = me(), r = String(u.role || '').toLowerCase(), p = u.perms || null;
    if (!p) return 'admin';                                   // preview / editor: show everything
    if (r === 'admin' || r === 'superadmin') return 'admin';
    if (r === 'supervisor') return 'supervisor';
    if (r === 'operator' || r === 'viewer') return 'staff';
    return p.users ? 'admin' : (p.settings ? 'supervisor' : 'staff');
  }
  function allowedWidget(w) { return !!w && can(w.perm || '') && TIER_RANK[tier()] >= TIER_RANK[w.tier || 'staff']; }

  /* ── API ──────────────────────────────────────────────────────────────── */
  function apiUrl(path, params, withToken) {
    var base = (window.TMNS && window.TMNS.api) || '/api';
    var q = new URLSearchParams(params || {});
    if (withToken && window.TMNS && window.TMNS.token) q.set('token', window.TMNS.token);
    var qs = q.toString();
    return base + path + (qs ? '?' + qs : '');
  }
  /** '/x?y=1' → API URL with the read token appended (images served behind RBAC). */
  function tokUrl(rel) {
    var base = (window.TMNS && window.TMNS.api) || '/api', tok = window.TMNS && window.TMNS.token;
    return base + rel + (tok ? (rel.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(tok) : '');
  }
  function apiGet(path, params, withToken) {
    return fetch(apiUrl(path, params, withToken), { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (!d || d.ok === false) throw new Error((d && d.error) || 'Request failed'); return d; });
  }
  function apiPost(path, body) {
    return fetch(apiUrl(path), { method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (!d || d.ok === false) throw new Error((d && d.error) || 'Request failed'); return d; });
  }
  function toast(msg, tone) { if (window.KJModal && window.KJModal.toast) window.KJModal.toast(msg, tone); }

  /* ── stylesheet + Lottie (lazy) ───────────────────────────────────────── */
  function ensureCss() {
    [['dashboard', CSS_HREF], ['dashboard-widgets', CSS_WIDGETS_HREF]].forEach(function (x) {
      if (document.querySelector('link[data-kj-css="' + x[0] + '"]')) return;
      var l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = x[1] + '?v=' + encodeURIComponent((window.TMNS && window.TMNS.build) || '1');
      l.setAttribute('data-kj-css', x[0]);
      document.head.appendChild(l);
    });
  }
  var lottieP = null, manifestP = null;
  function lottieReady() {
    if (window.lottie) return Promise.resolve(window.lottie);
    if (!lottieP) {
      lottieP = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = LOTTIE_JS; s.async = true;
        s.onload = function () { if (window.lottie) res(window.lottie); else rej(new Error('lottie')); };
        s.onerror = function () { rej(new Error('lottie')); };
        document.head.appendChild(s);
      });
      lottieP.catch(function () { /* icon fallback stays */ });
    }
    return lottieP;
  }
  function manifest() {
    if (!manifestP) {
      manifestP = fetch(LOTTIE_DIR + 'manifest.json', { cache: 'force-cache' }).then(function (r) { return r.json(); })
        .then(function (m) { return (m && m.animations) || {}; }).catch(function () { return {}; });
    }
    return manifestP;
  }
  function hydrateLottie(root) {
    var slots = root ? root.querySelectorAll('[data-kj-lottie]:not(.is-on)') : [];
    if (!slots.length) return;
    Promise.all([lottieReady(), manifest()]).then(function (x) {
      var L = x[0], anims = x[1];
      Array.prototype.forEach.call(slots, function (slot) {
        var a = anims[slot.getAttribute('data-kj-lottie')];
        if (!a || !slot.isConnected || slot.classList.contains('is-on')) return;
        try {
          var inst = L.loadAnimation({ container: slot, renderer: 'svg', loop: !!a.loop, autoplay: true, path: LOTTIE_DIR + a.file });
          slot.classList.add('is-on');
          S.anims.push(inst);
        } catch (e) { /* keep the icon */ }
      });
    }).catch(function () { /* keep the icon */ });
  }

  /* ── shared render snippets ───────────────────────────────────────────── */
  /** Empty state: Lottie animation (icon fallback) + way forward. */
  function emptyBox(o) {
    var act = o.nav ? '<button type="button" class="kj-btn kj-btn-soft kj-btn-sm"' + navAttr(o.nav.path) + '>' + ico(o.nav.icon || 'arrow-right') + esc(o.nav.label) + '</button>'
      : (o.modal ? '<button type="button" class="kj-btn kj-btn-soft kj-btn-sm"' + modalAttr(o.modal[0], o.modal[1]) + '>' + ico('eye') + esc(o.modal[2] || 'Details') + '</button>' : '');
    return '<div class="kj-empty kj-dash-empty' + (o.error ? ' is-error' : '') + '">' +
      '<div class="kj-dash-lottie" data-kj-lottie="' + esc(o.lottie || (o.error ? 'error' : 'empty')) + '">' + ico(o.icon || 'inbox') + '</div>' +
      '<div class="kj-empty-title">' + esc(o.title) + '</div>' +
      (o.text ? '<div class="kj-empty-text">' + esc(o.text) + '</div>' : '') +
      (act ? '<div class="kj-row-wrap kj-empty-actions">' + act + '</div>' : '') + '</div>';
  }
  function skel(kind) {
    if (kind === 'chart') return '<div class="kj-dash-skel"><div class="kj-skel kj-skel-line is-mid"></div><div class="kj-skel kj-skel-block"></div></div>';
    if (kind === 'list') {
      var r = '<div class="kj-dash-skel-row"><div class="kj-skel kj-skel-thumb"></div><div><div class="kj-skel kj-skel-line is-mid"></div><div class="kj-skel kj-skel-line is-short"></div></div></div>';
      return '<div class="kj-dash-skel">' + r + r + r + '</div>';
    }
    if (kind === 'kpis') {
      var k = '<div class="kj-dash-kpi"><div><div class="kj-skel kj-skel-line is-short"></div><div class="kj-skel kj-dash-skel-big"></div><div class="kj-skel kj-skel-line is-mid"></div></div></div>';
      return '<div class="kj-dash-kpis">' + k + k + k + k + '</div>';
    }
    return '<div class="kj-dash-skel"><div class="kj-skel kj-dash-skel-big"></div><div class="kj-skel kj-skel-line is-mid"></div></div>';
  }
  function delta(txt, good, dir) {
    if (txt == null || txt === '') return '';
    return '<span class="kj-dash-delta ' + (good == null ? '' : good ? 'is-good' : 'is-bad') + '">' +
      ico(dir === 'up' ? 'arrow-up' : dir === 'down' ? 'arrow-down' : 'minus') + esc(txt) + '</span>';
  }
  function chev() { return '<span class="kj-dash-chev">' + ico('chevron-right') + '</span>'; }
  function sevTone(s) { s = String(s || '').toLowerCase(); return /crit|sev|high|3|2/.test(s) ? 'danger' : /med|1/.test(s) ? 'warn' : 'info'; }
  var MOD_ICON = { ppe: 'hard-hat', intr: 'ban', forklift: 'forklift', fire: 'flame', face: 'scan-face', cleaning: 'sparkles', behaviour: 'activity' };
  var MOD_HUB = { ppe: 'detections/ppe', intr: 'detections/restricted', forklift: 'detections/forklift', fire: 'detections/fire', cleaning: 'detections/cleaning', behaviour: 'detections/behaviour' };

  /** Data a widget renders from. */
  function ctxFor(item) {
    var app = S.app, st = S.hist && S.histSt ? S.histSt : ((app && app.state) || {});   // time travel: frozen snapshot, no live bleed
    return { app: app, st: st, ov: st.ov || null, ovBusy: !!st.ovBusy || (!st.ov && !st.ovErr), ovErr: st.ovErr || '',
      D: D, size: item.size, cols: parseInt(String(item.size).split('x')[1], 10) || 1,
      win: win((WIDX[item.id] || {}).autoDays), f: S.filters };
  }
  function ovGate(c, kind) {
    if (c.ov) return '';
    if (c.ovErr) return emptyBox({ error: true, icon: 'cloud-off', title: 'Could not load', text: c.ovErr, nav: { label: 'Classic overview', path: 'dashboard/classic', icon: 'layout-grid' } });
    return skel(kind);
  }
  function remoteGate(r, kind, o) {
    if (!r || r.st === 'idle' || r.st === 'loading') return skel(kind);
    if (r.st === 'err') return emptyBox({ error: true, icon: 'cloud-off', title: o.errTitle || 'Not available', text: r.err || '', nav: o.nav });
    return '';
  }

  /* ── filters (saved per dashboard) + historical mode (session only) ───── */
  // S.filters = {range: auto|today|7d|30d|custom, from, to (YYYY-MM-DD, custom only), plant, cams[], sev: all|high}
  // — mirrors the server whitelist in lib/DashboardRoutes.php. S.hist = {at: ms} | null is the
  // "time travel" moment: never saved, it caps every date window at that instant and freezes live data.
  var RANGES = [['auto', 'Auto', 'Each widget uses its own period'], ['today', 'Today', ''], ['7d', '7 days', ''], ['30d', '30 days', ''], ['custom', 'Custom', 'Pick a from / to date']];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function blankFilters() { return { range: 'auto', from: null, to: null, plant: '', cams: [], sev: 'all' }; }
  function isDay(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && ymd(new Date(v + 'T12:00:00')) === v; }
  function normFilters(f) {
    f = f && typeof f === 'object' ? f : {};
    var o = blankFilters();
    if (['auto', 'today', '7d', '30d', 'custom'].indexOf(f.range) >= 0) o.range = f.range;
    if (o.range === 'custom') {
      if (isDay(f.from) && isDay(f.to)) { o.from = f.from <= f.to ? f.from : f.to; o.to = f.from <= f.to ? f.to : f.from; }
      else o.range = 'auto';
    }
    o.plant = typeof f.plant === 'string' ? f.plant.replace(/[\u0000-\u001F\u007F<>]+/g, '').trim().slice(0, 80) : '';
    var seen = {};
    o.cams = (Array.isArray(f.cams) ? f.cams : []).map(String).filter(function (c) {
      if (!/^[A-Za-z0-9._:-]{1,64}$/.test(c) || seen[c]) return false; seen[c] = 1; return true;
    }).slice(0, 24);
    o.sev = f.sev === 'high' ? 'high' : 'all';
    return o;
  }
  function filtersActive() { var f = S.filters; return f.range !== 'auto' || f.cams.length > 0 || f.sev !== 'all' || !!S.hist; }
  function dstart(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function dayMs(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]).getTime(); }
  function dayShort(s) { var p = String(s).split('-'); return N(p[2]) + ' ' + MON[N(p[1]) - 1]; }
  function momentLbl(ms) { var d = new Date(ms); return d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear() + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  /** Effective date window {from, to (ms), fromD, toD, days, label, hist} — null = live + Auto (each widget's own period). */
  function win(autoDays) {
    var f = S.filters, at = S.hist ? S.hist.at : null, end = at != null ? at : Date.now(), from, to = end, label;
    if (f.range === 'auto' && at == null) return null;
    autoDays = f.range === 'auto' ? Math.max(1, N(autoDays) || 1) : 1;
    if (f.range === 'custom') {
      from = dayMs(f.from); to = Math.min(dayMs(f.to) + 86399999, end);
      if (to < from) from = dstart(to);
      label = f.from === f.to ? dayShort(f.from) : dayShort(f.from) + ' – ' + dayShort(f.to);
    } else if (f.range === '7d') { from = dstart(end) - 6 * 86400000; label = '7 days'; }
    else if (f.range === '30d') { from = dstart(end) - 29 * 86400000; label = '30 days'; }
    else if (autoDays > 1) { from = dstart(end) - (autoDays - 1) * 86400000; label = autoDays + ' days'; }   // Auto while time-travelling: the widget's own span, ending at the moment
    else { from = dstart(end); label = at != null ? dayShort(ymd(new Date(at))) : 'Today'; }
    if (at != null) label += ' → ' + pad(new Date(at).getHours()) + ':' + pad(new Date(at).getMinutes());
    return { from: from, to: to, fromD: ymd(new Date(from)), toD: ymd(new Date(to)), days: Math.round((dstart(to) - dstart(from)) / 86400000) + 1, label: label, hist: at != null };
  }
  function isHigh(e) { return sevTone(e && e.sev) === 'danger'; }
  /** Feed events narrowed by the dashboard filters. o.def = 'today' → that is the period when no window is set; o.cam / o.sev opt in. */
  function fEvents(c, o) {
    var w = c.win || (o.def === 'today' ? { from: dayStart(), to: Infinity } : null);
    var cs = null, hi = o.sev && S.filters.sev === 'high';
    if (o.cam && S.filters.cams.length) { cs = {}; S.filters.cams.forEach(function (x) { cs[x.toLowerCase()] = 1; }); }
    return feedEvents(c.st).filter(function (e) {
      var t = tsOfEvent(e);
      if (w && (t < w.from || t > w.to)) return false;
      if (cs && !cs[String(e.camera || '').toLowerCase()]) return false;
      return !(hi && !isHigh(e));
    });
  }
  /** Header tag for a widget: what it is filtered by, or that it shows a fixed / live period. */
  function tagFor(w, c) {
    if (!filtersActive()) return null;
    var fl = w.filt || '', parts = [], f = S.filters;
    var dateOk = fl.indexOf('d') >= 0 && !(w.dateOk && !w.dateOk(c));
    if (c.win && !dateOk) {
      if (!w.fixed && !S.hist) return null;
      var per = w.fixed || 'Live';
      return { fixed: true, text: (S.hist ? 'Live only' : 'Fixed') + ' · ' + per,
        title: 'This widget always shows ' + per.toLowerCase() + (S.hist ? ' — it cannot rewind to a past moment, so it is frozen at the time you started time travel.' : ' — the date filter does not apply to it.') };
    }
    if (c.win && dateOk) parts.push(c.win.label);
    if (f.cams.length && fl.indexOf('c') >= 0) parts.push(f.cams.length + ' camera' + (f.cams.length === 1 ? '' : 's'));
    if (f.sev === 'high' && fl.indexOf('s') >= 0) parts.push('High+');
    if (!parts.length) return null;
    var title = 'Filtered: ' + parts.join(', '), partial = false;
    if (w.feed && c.win) {
      var ev = feedEvents(c.st), oldest = Infinity;
      ev.forEach(function (e) { var t = tsOfEvent(e); if (t < oldest) oldest = t; });
      if (ev.length >= 300 && oldest > c.win.from) { partial = true; title += ' — the live feed only reaches back to ' + momentLbl(oldest) + '; older detections are in the detection log.'; }
    }
    return { fixed: false, text: parts.join(' · ') + (partial ? ' · partial' : ''), title: title };
  }

  /* ── remote data (beyond app.state) ───────────────────────────────────── */
  var D = { tickets: { st: 'idle' }, leaves: { st: 'idle' }, aip: { st: 'idle' }, occupancy: { st: 'idle' }, floorplans: { st: 'idle' },
    checkins: { st: 'idle' }, onleave: { st: 'idle' }, slaperf: { st: 'idle' }, reports: { st: 'idle' }, notifs: { st: 'idle' }, ppetrend: { st: 'idle' } };
  /** Stores refreshed every 60th poll (5 min) instead of every 6th (30 s). */
  var SLOW = { aip: 1, floorplans: 1, onleave: 1, reports: 1, slaperf: 1, ppetrend: 1 };
  /** Stores whose request depends on the date filter / historical moment — reloaded (skeleton first) when either changes. */
  var DATE_STORES = ['ppetrend', 'aip', 'slaperf', 'reports', 'checkins'];
  function sqlTs(ms) { var d = new Date(ms); return ymd(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  var LOADERS = {
    // GET /ppe/summary?from=&to=&plant= — only when a date window is set (Auto keeps the overview's 7-day series).
    ppetrend: function () {
      var w = win(7); if (!w) return Promise.resolve(null);
      var q = { from: w.fromD, to: w.toD }; if (S.filters.plant) q.plant = S.filters.plant;
      return apiGet('/ppe/summary', q, true).then(function (d) {
        return { days: (Array.isArray(d.daily) ? d.daily : []).map(function (r) {
          var c = N(r.checks), v = N(r.violations);
          return { date: r.date, checks: c, violations: v, pct: c ? Math.round(1000 * (c - v) / c) / 10 : null };
        }) };
      });
    },
    tickets: function () {
      return apiGet('/tickets', { open: '1', limit: '50' }).then(function (d) {
        var now = Date.now();
        var rows = (d.tickets || []).map(function (t) {
          var res = (t.sla && t.sla.resolution) || {};
          return { t: t, due: res.remaining_s != null ? now + res.remaining_s * 1000 : null, breached: !!res.breached,
            total: N(t.sla && t.sla.policy_min && t.sla.policy_min.resolution) * 60 };
        });
        rows.sort(function (a, b) { return (a.due == null ? Infinity : a.due) - (b.due == null ? Infinity : b.due); });
        return { total: N(d.total), rows: rows, breached: rows.filter(function (r) { return r.breached; }).length };
      });
    },
    leaves: function () {
      return apiGet('/leaves/team', { status: 'pending', limit: '20' }).then(function (d) { return { total: N(d.total), rows: d.leaves || [] }; });
    },
    aip: function () {
      var w = win(7), q = { from: w ? w.fromD : daysAgo(6), to: w ? w.toD : today() };
      if (S.filters.plant) q.plant = S.filters.plant;
      return apiGet('/aiperf/summary', q, true);
    },
    // GET /movement/occupancy (supervisor+ & view) — per-pin distinct people, last 15 min.
    occupancy: function () { return apiGet('/movement/occupancy', { minutes: '15' }, true); },
    // GET /floorplans (signed in) — active plans first by sort order, each with its pins.
    floorplans: function () {
      return apiGet('/floorplans', {}, true).then(function (d) {
        var plans = (d.floorplans || []).filter(function (p) { return p.active == null || p.active === true || N(p.active) === 1; })
          .sort(function (a, b) { return N(a.sort_order) - N(b.sort_order) || N(a.id) - N(b.id); });
        return { plans: plans };
      });
    },
    // GET /attendance/daily?date=today (read token) — register rows with clockIn, newest first.
    checkins: function () {
      var w = win();   // the register is per day: a single-day window (or a historical moment) picks that day
      return apiGet('/attendance/daily', { date: w && w.days === 1 ? w.toD : today() }, true).then(function (d) {
        var rows = (d.rows || []).filter(function (r) { return r.clockIn; })
          .sort(function (a, b) { return (toMs(b.clockIn) || 0) - (toMs(a.clockIn) || 0); });
        return { kpi: d.kpi || {}, rows: rows };
      });
    },
    // GET /leaves/calendar?month= (one or two months when the week straddles) → approved leave overlapping Mon–Fri.
    onleave: function () {
      var days = weekDays(), months = {};
      days.forEach(function (x) { months[x.slice(0, 7)] = 1; });
      return Promise.all(Object.keys(months).map(function (m) { return apiGet('/leaves/calendar', { month: m }); })).then(function (res) {
        var seen = {}, rows = [];
        res.forEach(function (d) {
          (d.departments || []).forEach(function (g) {
            (g.leaves || []).forEach(function (l) {
              if (seen[l.id] || l.end_date < days[0] || l.start_date > days[days.length - 1]) return;
              seen[l.id] = 1;
              rows.push(Object.assign({ department: g.department }, l));
            });
          });
        });
        return { days: days, rows: rows };
      });
    },
    // GET /tickets?status=resolved,closed&from=7d → response / resolution SLA met-rates.
    slaperf: function () {
      var w = win(7), q = { status: 'resolved,closed', from: (w ? w.fromD : daysAgo(6)) + ' 00:00:00', limit: '200' };
      if (w) q.to = sqlTs(w.to);
      return apiGet('/tickets', q).then(function (d) {
        var rows = d.tickets || [], o = { n: rows.length, rd: 0, rm: 0, sd: 0, sm: 0, breached: 0 };
        rows.forEach(function (t) {
          var s = t.sla || {}, r = s.response || {}, z = s.resolution || {};
          if (r.state === 'met' || r.state === 'breached' || r.met_at) { o.rd++; if (!r.breached) o.rm++; }
          if (z.state === 'met' || z.state === 'breached' || z.met_at) { o.sd++; if (!z.breached) o.sm++; }
          if (r.breached || z.breached) o.breached++;
        });
        o.resp = o.rd ? Math.round(1000 * o.rm / o.rd) / 10 : null;
        o.res = o.sd ? Math.round(1000 * o.sm / o.sd) / 10 : null;
        return o;
      });
    },
    // GET /reports (own; admin: all) — newest 3.
    // /reports has no date filter: with a window, fetch the newest 30 and keep those created inside it.
    reports: function () {
      var w = win(), q = { limit: w ? '30' : '3' }; if (tier() === 'admin') q.all = '1';
      return apiGet('/reports', q).then(function (d) {
        var rows = d.reports || [];
        if (w) rows = rows.filter(function (r) { var t = toMs(r.created_at); return t != null && t >= w.from && t <= w.to; });
        return { rows: rows.slice(0, 3) };
      });
    },
    // GET /notifications?all=1 — the widget sorts unread first.
    notifs: function () {
      return apiGet('/notifications', { all: '1', limit: '12' }).then(function (d) { return { unread: N(d.unread_count), rows: d.notifications || [] }; });
    }
  };
  var LSEQ = {};   // per-store request sequence: a slower, older response never overwrites a newer one
  function load(key, force) {
    var r = D[key];
    if (!force && (r.st === 'loading' || r.st === 'ok')) return;
    if (r.st !== 'ok') D[key] = { st: 'loading' };
    var my = LSEQ[key] = (LSEQ[key] || 0) + 1, p;
    try { p = LOADERS[key](); } catch (e) { p = Promise.reject(e); }
    p.then(function (x) { if (LSEQ[key] !== my) return; D[key] = { st: 'ok', v: x, at: Date.now() }; paint(); })
      .catch(function (e) { if (LSEQ[key] !== my) return; D[key] = r.st === 'ok' && force ? r : { st: 'err', err: (e && e.message) || 'Request failed' }; paint(); });
  }
  /** Date filter / historical moment changed: date-aware stores go back to a skeleton and reload. */
  function reloadDateStores() {
    var want = {}; needs().forEach(function (k) { want[k] = 1; });
    DATE_STORES.forEach(function (k) { LSEQ[k] = (LSEQ[k] || 0) + 1; D[k] = { st: 'idle' }; if (want[k]) load(k, true); });
  }
  function needs() {
    var set = {};
    S.layout.forEach(function (it) { var w = WIDX[it.id]; (w && w.needs || []).forEach(function (k) { set[k] = 1; }); });
    return Object.keys(set);
  }
  function loadNeeds(force) { needs().forEach(function (k) { if (LOADERS[k]) load(k, force); }); }

  /* ── widget registry ──────────────────────────────────────────────────── */
  function kpiTile(o) {
    return '<button type="button" class="kj-dash-kpi kj-dd"' + o.attr + '>' +
      '<span class="kj-dash-kpi-ico' + (o.tone ? ' is-' + o.tone : '') + '">' + ico(o.icon) + '</span>' +
      '<span><span class="kj-dash-kpi-lbl">' + esc(o.lbl) + '</span>' +
      '<span class="kj-dash-kpi-val"><span class="kj-dash-big">' + o.val + '</span>' + (o.delta || '') + '</span>' +
      '<span class="kj-dash-cmp">' + esc(o.cmp || '') + '</span></span></button>';
  }
  function ppeDaily(ov) {
    var arr = (ov && ov.ppe && Array.isArray(ov.ppe.daily)) ? ov.ppe.daily.slice(-7) : [];
    return arr.map(function (r) {
      var c = N(r.checks), v = N(r.violations);
      return { date: r.date, checks: c, violations: v, pct: c ? Math.round(1000 * (c - v) / c) / 10 : null };
    });
  }
  function feedEvents(st) { return Array.isArray(st.events) ? st.events : []; }
  function detCounts(st) {
    var ev = feedEvents(st).filter(function (e) { return e.mod !== 'face'; });
    var t0 = new Date(); t0.setHours(0, 0, 0, 0); var a = t0.getTime(), b = a - 86400000;
    var td = 0, yd = 0, oldest = Infinity;
    ev.forEach(function (e) { var t = tsOfEvent(e); if (t < oldest) oldest = t; if (t >= a) td++; else if (t >= b) yd++; });
    var covered = oldest <= b || ev.length < 300;                 // feed returns the newest 300 + all unresolved
    return { today: td, yesterday: covered ? yd : null, open: ev.filter(function (e) { return e.status !== 'resolved'; }).length };
  }
  function alertRows(c) {
    return fEvents(c, { cam: 1, sev: 1 }).filter(function (e) { return e.status !== 'resolved' && e.mod !== 'face'; })
      .sort(function (a, b) { return tsOfEvent(b) - tsOfEvent(a); }).slice(0, c.cols >= 3 ? 5 : 4);
  }
  function camStats(st) {
    var fleet = Array.isArray(st.fleet) ? st.fleet : [];
    var live = st.live || {};
    var total = fleet.length || N(live.camsTotal), on = fleet.length ? fleet.filter(function (c) { return c.online; }).length : N(live.camsOnline);
    return { total: total, online: on, pct: total ? Math.round(1000 * on / total) / 10 : null, fleet: fleet };
  }

  var WIDGETS = [
    /* KPI strip ---------------------------------------------------------- */
    { id: 'kpis', title: 'Key indicators', sub: 'PPE, detections, tickets, cameras', icon: 'gauge', perm: 'view',
      sizes: ['1x4', '1x2'], desc: 'Four headline KPIs with day-over-day change.', needs: ['tickets'],
      sig: function (c) {
        return JSON.stringify([c.ov && c.ov.ppe, c.ovErr, detCounts(c.st), camStats(c.st).online, camStats(c.st).total,
          D.tickets.st, D.tickets.v && D.tickets.v.total, D.tickets.v && D.tickets.v.breached]);
      },
      render: function (el, c) {
        if (!c.ov && !c.ovErr) { el.innerHTML = skel('kpis'); return; }
        var tiles = [];
        // 1. PPE compliance (7-day) vs today
        var ppe = c.ov && c.ov.ppe, comp = ppe && ppe.compliance != null ? N(ppe.compliance) : null;
        var days = ppeDaily(c.ov), td = days.length ? days[days.length - 1] : null;
        var dd = (comp != null && td && td.pct != null) ? Math.round((td.pct - comp) * 10) / 10 : null;
        tiles.push(kpiTile({ icon: 'shield-check', lbl: 'PPE compliance', attr: modalAttr('stat', 'ppe'),
          val: comp != null ? comp.toFixed(1) + '<small>%</small>' : '—',
          delta: dd != null ? delta((dd >= 0 ? '+' : '') + dd + ' pp', dd >= 0, dd >= 0 ? 'up' : 'down') : '',
          cmp: td && td.pct != null ? 'Today ' + td.pct + '% · 7-day average' : '7-day average' }));
        // 2. Detections today vs yesterday
        var dc = detCounts(c.st);
        var dp = dc.yesterday ? Math.round(1000 * (dc.today - dc.yesterday) / dc.yesterday) / 10 : null;
        tiles.push(kpiTile({ icon: 'triangle-alert', tone: 'warn', lbl: 'Detections today', attr: modalAttr('stat', 'ev'),
          val: fmtN(dc.today), delta: dp != null ? delta((dp > 0 ? '+' : '') + dp + '%', dp <= 0, dp > 0 ? 'up' : 'down') : '',
          cmp: dc.yesterday != null ? 'vs yesterday (' + fmtN(dc.yesterday) + ')' : fmtN(dc.open) + ' still open' }));
        // 3. Open tickets (ITSM) — or open alerts for roles without the tickets perm
        if (can('tickets')) {
          var tk = D.tickets;
          tiles.push(kpiTile({ icon: 'ticket', tone: 'purple', lbl: 'Open tickets', attr: navAttr('tickets'),
            val: tk.st === 'ok' ? fmtN(tk.v.total) : (tk.st === 'err' ? '—' : '…'),
            delta: tk.st === 'ok' && tk.v.breached ? delta(tk.v.breached + ' breached', false, 'up') : (tk.st === 'ok' ? delta('SLA on track', true, 'none') : ''),
            cmp: tk.st === 'err' ? 'Ticket service unavailable' : 'Resolution SLA tracked live' }));
        } else {
          tiles.push(kpiTile({ icon: 'bell-ring', tone: 'purple', lbl: 'Open alerts', attr: navAttr('detections'),
            val: fmtN(dc.open), cmp: 'Unresolved detections' }));
        }
        // 4. Camera availability
        var cs = camStats(c.st);
        tiles.push(kpiTile({ icon: 'clock', tone: 'success', lbl: 'Camera uptime', attr: modalAttr('dash-cameras', 'all'),
          val: cs.pct != null ? cs.pct.toFixed(1) + '<small>%</small>' : '—',
          delta: cs.total ? delta(cs.online + '/' + cs.total, cs.online === cs.total, cs.online === cs.total ? 'up' : 'down') : '',
          cmp: cs.total ? 'Cameras online right now' : 'No cameras reporting' }));
        el.innerHTML = '<div class="kj-dash-kpis">' + tiles.join('') + '</div>';
      } },

    /* PPE compliance trend --------------------------------------------- */
    { id: 'ppe-trend', title: 'PPE compliance trend', sub: 'Daily compliance rate (helmet, vest, safety shoes)', icon: 'trending-up', perm: 'view',
      sizes: ['1x3', '1x2', '1x4'], rows: 2, desc: '7-day compliance line with target; click a day for its breakdown.',
      nav: { label: 'PPE detections', path: 'detections/ppe' },
      needs: ['ppetrend'],
      sig: function (c) { var p = D.ppetrend; return JSON.stringify(c.win ? [p.st, p.v, p.err] : [ppeDaily(c.ov), c.ovErr, !!c.ov]); },
      render: function (el, c) {
        var g = c.win ? remoteGate(D.ppetrend, 'chart', { errTitle: 'PPE trend unavailable', nav: { label: 'Open PPE', path: 'detections/ppe' } }) : ovGate(c, 'chart');
        if (g) { el.innerHTML = g; return; }
        var days = (c.win ? (D.ppetrend.v && D.ppetrend.v.days) || [] : ppeDaily(c.ov)).filter(function (d) { return d.pct != null; });
        if (days.length < 1) {
          el.innerHTML = emptyBox({ icon: 'hard-hat', title: 'No PPE checks ' + (c.win ? 'in ' + c.win.label : 'in the last 7 days'), text: 'Compliance appears once PPE detections arrive.', nav: { label: 'Open PPE', path: 'detections/ppe' } });
          return;
        }
        el.innerHTML = '<div class="kj-dash-chart"></div><div class="kj-dash-legend"><span><i></i>Compliance rate</span><span><i class="is-target"></i>Target (' + PPE_TARGET + '%)</span></div>';
        var box = el.querySelector('.kj-dash-chart');
        if (window.Highcharts && window.Highcharts.chart) hcTrend(box, days, c);
        else box.innerHTML = svgTrend(days);
      } },

    /* Cameras online ---------------------------------------------------- */
    { id: 'cameras', title: 'Cameras online', sub: 'Live RTSP sources', icon: 'cctv', perm: 'view', sizes: ['1x1', '1x2'],
      desc: 'Online/total cameras; offline ones listed at 1x2.', nav: { label: 'Camera wall', path: 'cameras/wall' },
      sig: function (c) { var s = camStats(c.st); return JSON.stringify([s.online, s.total, c.cols > 1 ? s.fleet.map(function (f) { return f.stream + (f.online ? 1 : 0); }) : 0]); },
      render: function (el, c) {
        var s = camStats(c.st);
        if (!s.total) { el.innerHTML = emptyBox({ icon: 'cctv', title: 'No cameras yet', text: 'Add a camera to see it here.', nav: { label: 'Manage cameras', path: 'cameras/manage' } }); return; }
        var tone = s.online === s.total ? '' : (s.online / s.total >= 0.8 ? 'is-warn' : 'is-danger');
        var circ = 2 * Math.PI * 26, fill = circ * (s.online / s.total);
        var ring = '<svg class="kj-dash-ring ' + tone + '" viewBox="0 0 64 64" aria-hidden="true"><circle class="kj-ring-bg" cx="32" cy="32" r="26"/>' +
          '<circle class="kj-ring-fg" cx="32" cy="32" r="26" stroke-dasharray="' + fill.toFixed(1) + ' ' + circ.toFixed(1) + '" transform="rotate(-90 32 32)"/></svg>';
        var main = '<button type="button" class="kj-dd kj-dash-fig"' + modalAttr('dash-cameras', 'all') + '>' + ring +
          '<span class="kj-dash-fig-main"><span class="kj-dash-status"><span class="kj-dash-dot ' + tone + '"></span>' + (s.online === s.total ? 'All online' : (s.total - s.online) + ' offline') + '</span>' +
          '<span class="kj-dash-big">' + s.online + '<small>/' + s.total + '</small></span></span>' + chev() + '</button>';
        if (c.cols < 2) { el.innerHTML = main; return; }
        var off = s.fleet.filter(function (f) { return !f.online; }).slice(0, 4);
        var list = off.length ? off.map(function (f) {
          return '<div class="kj-dash-item"' + modalAttr('camera', f.stream || f.serial || f.name) + '><span class="kj-dash-modico is-warn">' + ico('video-off') + '</span>' +
            '<span class="kj-dash-item-main"><span class="kj-dash-item-title">' + esc(f.name || f.stream) + '</span><span class="kj-dash-item-sub">' + esc(f.stream || f.serial || '') + ' · offline</span></span>' + chev() + '</div>';
        }).join('') : '<div class="kj-dash-item"' + navAttr('cameras/wall') + '><span class="kj-dash-modico is-info">' + ico('circle-check') + '</span><span class="kj-dash-item-main"><span class="kj-dash-item-title">Every camera is streaming</span><span class="kj-dash-item-sub">Open the camera wall</span></span>' + chev() + '</div>';
        el.innerHTML = '<div class="kj-dash-split">' + main + '<div class="kj-dash-list">' + list + '</div></div>';
      } },

    /* Headcount --------------------------------------------------------- */
    { id: 'headcount', title: 'Headcount', sub: 'Present today', icon: 'users-round', perm: 'view', sizes: ['1x1', '1x2'],
      desc: 'Present today vs workforce; 1x2 adds the on-time / late / absent split.', nav: { label: 'Attendance', path: 'attendance' },
      sig: function (c) { return JSON.stringify([c.ov && c.ov.employees, c.ovErr, !!c.ov]); },
      render: function (el, c) {
        var g = ovGate(c, 'fig'); if (g) { el.innerHTML = g; return; }
        var e = c.ov.employees || {};
        if (!N(e.total)) { el.innerHTML = emptyBox({ icon: 'users-round', title: 'No employees enrolled', text: 'Enrol faces to track headcount.', nav: { label: 'People', path: 'people' } }); return; }
        var main = '<button type="button" class="kj-dd kj-dash-fig"' + modalAttr('attendance-day', today()) + '><span class="kj-dash-fig-main">' +
          '<span class="kj-dash-big">' + fmtN(e.present) + '<small> / ' + fmtN(e.total) + '</small></span>' +
          '<span class="kj-dash-cmp">' + (e.presentPct != null ? N(e.presentPct) + '% of scheduled staff in' : 'checked in today') + '</span></span>' + chev() + '</button>';
        if (c.cols < 2) { el.innerHTML = main; return; }
        var sched = Math.max(1, N(e.scheduled) || N(e.total));
        var seg = [['present', 'On time', N(e.onTime)], ['late', 'Late', N(e.late)], ['absent', 'Absent', N(e.absent)]];
        el.innerHTML = main + '<div class="kj-dash-seg">' + seg.map(function (s) {
          return s[2] ? '<button type="button" class="is-' + s[0] + ' ' + w5(100 * s[2] / sched) + '" aria-label="' + esc(s[1] + ': ' + s[2]) + '"' + modalAttr('attendance-day', today()) + '></button>' : '';
        }).join('') + '</div><div class="kj-dash-segkey">' + seg.map(function (s) {
          return '<button type="button"' + modalAttr('attendance-day', today()) + '><span class="kj-dash-dot ' + (s[0] === 'late' ? 'is-warn' : s[0] === 'absent' ? 'is-danger' : '') + '"></span>' + s[1] + ' <b>' + fmtN(s[2]) + '</b></button>';
        }).join('') + '<button type="button"' + modalAttr('stat', 'emp') + '>' + ico('user-plus') + ' New this month <b>' + fmtN(e.newThisMonth) + '</b></button></div>';
      } },

    /* Live alerts ------------------------------------------------------- */
    { id: 'alerts', title: 'Live alerts', sub: 'Real-time AI detections from your plant', icon: 'bell-ring', tone: 'danger', perm: 'view',
      sizes: ['1x2', '1x3', '1x4'], rows: 2, desc: 'Newest open detections with proof thumbnails.', nav: { label: 'View all alerts', path: 'detections' },
      sig: function (c) { return JSON.stringify(alertRows(c).map(function (e) { return [e.id, e.status, e.sev, e.image]; })) + c.cols + (Array.isArray(c.st.events) ? 1 : 0); },
      render: function (el, c) {
        if (!Array.isArray(c.st.events)) { el.innerHTML = skel('list'); return; }
        var rows = alertRows(c);
        if (!rows.length) { el.innerHTML = emptyBox({ lottie: 'success', icon: 'shield-check', title: 'All clear', text: 'No open detections right now.', nav: { label: 'Detection log', path: 'detections' } }); return; }
        el.innerHTML = '<div class="kj-dash-list">' + rows.map(function (e) {
          var tone = sevTone(e.sev);
          var proof = e.image
            ? '<button type="button" class="kj-dash-proof"' + modalAttr('image', e.image) + ' aria-label="Proof image"><img src="' + esc(e.image) + '" alt="" loading="lazy"><span class="kj-dash-proof-tag">' + esc(e.camera || '') + '</span></button>'
            : '<button type="button" class="kj-dash-proof is-empty"' + modalAttr('camera', e.camera) + ' aria-label="Camera ' + esc(e.camera) + '">' + ico('cctv') + '<span class="kj-dash-proof-tag">' + esc(e.camera || '') + '</span></button>';
          return '<div class="kj-dash-item"' + modalAttr('event', e.id) + '>' + proof +
            '<span class="kj-dash-modico is-' + tone + '">' + ico(MOD_ICON[e.mod] || 'triangle-alert') + '</span>' +
            '<span class="kj-dash-item-main"><span class="kj-dash-item-title">' + esc(e.title || 'Detection') + '</span>' +
            '<span class="kj-dash-item-sub">' + esc([e.zone, e.device].filter(Boolean).join(' – ') || e.camera) + '</span></span>' +
            '<span class="kj-dash-item-time">' + esc(fmtWhen(e.ts)) + '</span>' +
            '<span class="kj-chip is-' + tone + '">' + esc(cap(e.sev || 'info')) + '</span>' + chev() + '</div>';
        }).join('') + '</div>';
      } },

    /* Open tickets by SLA ----------------------------------------------- */
    { id: 'tickets', title: 'Open tickets by SLA', sub: 'Active tickets requiring action', icon: 'ticket', tone: 'purple', perm: 'tickets',
      sizes: ['1x2', '1x3', '1x4'], rows: 2, needs: ['tickets'], desc: 'Most urgent open tickets with live resolution-SLA countdowns.',
      nav: { label: 'View all tickets', path: 'tickets' },
      sig: function (c) { var t = D.tickets; return t.st + c.cols + JSON.stringify(t.v ? t.v.rows.slice(0, 5).map(function (r) { return [r.t.ticket_no, r.t.status, r.t.assignee, r.breached]; }) : t.err || ''); },
      render: function (el, c) {
        var g = remoteGate(D.tickets, 'list', { errTitle: 'Tickets unavailable', nav: { label: 'Open tickets', path: 'tickets' } }); if (g) { el.innerHTML = g; return; }
        var rows = D.tickets.v.rows.slice(0, c.cols >= 3 ? 5 : 4);
        if (!rows.length) { el.innerHTML = emptyBox({ lottie: 'success', icon: 'circle-check', title: 'No open tickets', text: 'Every ticket is resolved — nice work.', nav: { label: 'Ticket board', path: 'tickets' } }); return; }
        el.innerHTML = '<div class="kj-dash-list">' + rows.map(function (r) {
          var t = r.t, who = t.assignee || 'Unassigned';
          return '<div class="kj-dash-item"' + modalAttr('ticket', t.ticket_no || t.id) + '>' +
            '<span class="kj-dash-tkt">' + esc(t.ticket_no || ('#' + t.id)) + '</span>' +
            '<span class="kj-dash-item-main"><span class="kj-dash-item-title">' + esc(t.title) + '</span><span class="kj-dash-item-sub">' + esc([t.location, cap(t.priority)].filter(Boolean).join(' · ')) + '</span></span>' +
            '<span class="kj-dash-who"><span class="kj-avatar">' + esc(initials(who)) + '</span><span class="kj-dash-item-main"><span class="kj-dash-who-name">' + esc(who) + '</span><span class="kj-dash-who-sub">' + esc(cap(t.status)) + '</span></span></span>' +
            timerChip(r) + chev() + '</div>';
        }).join('') + '</div>';
      } },

    /* AI daily summary (admin) ------------------------------------------ */
    { id: 'ai-summary', title: 'AI daily summary', sub: 'AI narrative over the last 7 days', icon: 'sparkles', tone: 'purple', perm: 'view', tier: 'admin',
      sizes: ['1x4', '1x2', '1x3'], desc: 'AI-written summary of detections and trends (admin).', nav: { label: 'Forecast', path: 'analytics/forecast' },
      sig: function (c) { var a = c.st.ai; return JSON.stringify(a ? [a.summary, a.fetched_at, a.by_category] : null) + (c.st.events ? 1 : 0); },
      render: function (el, c) {
        var a = c.st.ai;
        if (!a || !a.summary) {
          el.innerHTML = Array.isArray(c.st.events) ? emptyBox({ lottie: 'scan', icon: 'sparkles', title: 'AI summary not ready', text: 'The AI summarises once there is enough activity (or AI is switched off in Settings).', nav: { label: 'Analytics', path: 'analytics' } }) : skel('fig');
          return;
        }
        var cats = a.by_category && typeof a.by_category === 'object' ? Object.keys(a.by_category).filter(function (k) { return N(a.by_category[k]); }) : [];
        el.innerHTML = '<button type="button" class="kj-dd"' + modalAttr('dash-ai', 'summary') + '><span class="kj-dash-ai">' + esc(a.summary) + '</span></button>' +
          (cats.length ? '<div class="kj-dash-ai-chips">' + cats.slice(0, 6).map(function (k) {
            return '<button type="button" class="kj-chip is-primary"' + (STAT_OF[k] ? modalAttr('stat', STAT_OF[k]) : navAttr('detections')) + '>' + esc(cap(LABEL_OF[k] || k)) + ' · ' + fmtN(a.by_category[k]) + '</button>';
          }).join('') + '</div>' : '');
      } },

    /* Forklift events --------------------------------------------------- */
    { id: 'forklift', title: 'Forklift events', sub: 'Proximity / unsafe forklift activity', icon: 'forklift', tone: 'orange', perm: 'view', sizes: ['1x1', '1x2'],
      desc: 'Forklift detections today vs yesterday; 1x2 lists the latest.', nav: { label: 'Forklift detections', path: 'detections/forklift' },
      sig: function (c) { var f = c.ov && c.ov.forklift; return JSON.stringify(f ? [f.today, f.yesterday, f.violationsToday, c.cols > 1 ? (f.recent || []).slice(0, 3).map(function (r) { return r.id; }) : 0] : c.ovErr); },
      render: function (el, c) {
        var g = ovGate(c, 'fig'); if (g) { el.innerHTML = g; return; }
        var f = c.ov.forklift || {};
        var t = N(f.today), y = N(f.yesterday), dp = y ? Math.round(1000 * (t - y) / y) / 10 : null;
        var main = '<button type="button" class="kj-dd kj-dash-fig"' + modalAttr('stat', 'fk') + '><span class="kj-dash-fig-main">' +
          '<span class="kj-dash-kpi-val"><span class="kj-dash-big">' + fmtN(t) + '</span>' + (dp != null ? delta((dp > 0 ? '+' : '') + dp + '%', dp <= 0, dp > 0 ? 'up' : 'down') : '') + '</span>' +
          '<span class="kj-dash-cmp">' + fmtN(f.violationsToday) + ' unsafe · vs yesterday (' + fmtN(y) + ')</span></span>' + chev() + '</button>';
        if (c.cols < 2) { el.innerHTML = main; return; }
        var rec = (f.recent || []).slice(0, 3);
        el.innerHTML = '<div class="kj-dash-split">' + main + '<div class="kj-dash-list">' + (rec.length ? rec.map(function (r) {
          return '<div class="kj-dash-item"' + modalAttr('event', r.id, { mod: 'forklift', title: r.verdictLabel, camera: r.camera, zone: r.zone, location: r.location, time: r.time, image: r.image, sev: r.severity }) + '>' +
            '<span class="kj-dash-modico is-' + sevTone(r.severity) + '">' + ico('forklift') + '</span><span class="kj-dash-item-main"><span class="kj-dash-item-title">' + esc(r.verdictLabel || 'Forklift event') + '</span>' +
            '<span class="kj-dash-item-sub">' + esc([r.zone, fmtWhen(r.time)].filter(Boolean).join(' · ')) + '</span></span>' + chev() + '</div>';
        }).join('') : '<div class="kj-dash-item"' + navAttr('detections/forklift') + '><span class="kj-dash-modico is-info">' + ico('circle-check') + '</span><span class="kj-dash-item-main"><span class="kj-dash-item-title">No forklift events this week</span><span class="kj-dash-item-sub">Open forklift safety</span></span>' + chev() + '</div>') + '</div></div>';
      } },

    /* Leave approvals (supervisor+) ------------------------------------- */
    { id: 'leave', title: 'Leave approvals', sub: 'Pending leave requests', icon: 'calendar-check', tone: 'success', perm: 'view', tier: 'supervisor',
      sizes: ['1x1', '1x2'], needs: ['leaves'], desc: 'Requests waiting for your decision.', nav: { label: 'Approval queue', path: 'attendance' },
      sig: function (c) { var l = D.leaves; return l.st + c.cols + JSON.stringify(l.v ? [l.v.total, l.v.rows.slice(0, 3).map(function (r) { return r.id + r.status; })] : l.err || ''); },
      render: function (el, c) {
        var g = remoteGate(D.leaves, 'fig', { errTitle: 'Leave queue unavailable', nav: { label: 'Attendance', path: 'attendance' } }); if (g) { el.innerHTML = g; return; }
        var v = D.leaves.v;
        var main = '<button type="button" class="kj-dd kj-dash-fig"' + modalAttr('dash-leaves', 'pending') + '><span class="kj-dash-fig-main">' +
          '<span class="kj-dash-big">' + fmtN(v.total) + '</span><span class="kj-dash-cmp">' + (v.total ? 'waiting for a decision' : 'Nothing to approve') + '</span></span>' + chev() + '</button>';
        if (c.cols < 2) { el.innerHTML = main; return; }
        el.innerHTML = '<div class="kj-dash-split">' + main + '<div class="kj-dash-list">' + (v.rows.length ? v.rows.slice(0, 3).map(function (l) {
          return '<div class="kj-dash-item"' + modalAttr('leave', l.id, l) + '><span class="kj-avatar">' + esc(initials(l.user_name)) + '</span>' +
            '<span class="kj-dash-item-main"><span class="kj-dash-item-title">' + esc(l.user_name) + '</span><span class="kj-dash-item-sub">' + esc((l.leave_type_name || l.leave_type) + ' · ' + N(l.days) + 'd from ' + l.start_date) + '</span></span>' + chev() + '</div>';
        }).join('') : emptyBox({ lottie: 'success', icon: 'circle-check', title: 'Queue is empty' })) + '</div></div>';
      } },

    /* Detection accuracy ------------------------------------------------ */
    { id: 'accuracy', title: 'Detection accuracy', sub: 'AI model precision (7-day)', icon: 'crosshair', perm: 'view', tier: 'supervisor',
      sizes: ['1x1', '1x2'], needs: ['aip'], desc: 'Reviewed precision / recall per module (AI performance).', nav: { label: 'Analytics', path: 'analytics' },
      sig: function (c) { var a = D.aip; return a.st + c.cols + JSON.stringify(a.v ? [a.v.overall, (a.v.modules || []).map(function (m) { return [m.module, m.precision]; })] : a.err || ''); },
      render: function (el, c) {
        var g = remoteGate(D.aip, 'fig', { errTitle: 'Accuracy unavailable', nav: { label: 'Analytics', path: 'analytics' } }); if (g) { el.innerHTML = g; return; }
        var v = D.aip.v, o = v.overall || {};
        var mods = (v.modules || []).filter(function (m) { return m.precision != null; });
        if (o.precision == null) {
          el.innerHTML = emptyBox({ icon: 'crosshair', title: 'No reviewed detections yet', text: 'Mark detections correct / wrong to measure precision.', modal: ['dash-accuracy', '7d', 'Review queue'] });
          return;
        }
        var spark = mods.length > 1 ? sparkSvg(mods.map(function (m) { return N(m.precision); })) : '';
        var main = '<button type="button" class="kj-dd kj-dash-fig"' + modalAttr('dash-accuracy', '7d') + '><span class="kj-dash-fig-main">' +
          '<span class="kj-dash-big">' + N(o.precision).toFixed(1) + '<small>%</small></span>' +
          '<span class="kj-dash-cmp">' + (o.recall != null ? 'Recall ' + N(o.recall).toFixed(1) + '% · ' : '') + fmtN(o.det || o.detections || 0) + ' detections</span></span>' +
          (c.cols < 2 ? '' : spark) + chev() + '</button>';
        if (c.cols < 2) { el.innerHTML = main; return; }
        el.innerHTML = '<div class="kj-dash-split">' + main + '<div class="kj-dash-bars">' + mods.slice(0, 4).map(function (m) {
          return '<button type="button" class="kj-dash-bar"' + modalAttr('dash-accuracy', '7d') + '><span>' + esc(m.label || m.module) + '</span>' +
            '<span class="kj-progress"><span class="kj-progress-fill kj-fill-' + (N(m.precision) >= 90 ? 'success' : N(m.precision) >= 75 ? 'warn' : 'danger') + ' ' + w5(m.precision) + '"></span></span><b>' + N(m.precision).toFixed(0) + '%</b></button>';
        }).join('') + '</div></div>';
      } }
  ];
  /* ── wave-4 widget pack (styles: assets/css/pages/dashboard-widgets.css) ── */
  function dayStart() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function hhmm(v) { var ms = toMs(v); if (ms == null) return ''; var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  /** Dynamic values → CSS custom props (--dw-<k>), applied through CSSOM by applyVars(); no inline style attributes in markup. */
  function dvars(o) { return ' data-dwv="' + esc(Object.keys(o).map(function (k) { return k + '=' + o[k]; }).join(';')) + '"'; }
  function applyVars(root) {
    if (!root || !root.querySelectorAll) return;
    Array.prototype.forEach.call(root.querySelectorAll('[data-dwv]'), function (el) {
      String(el.getAttribute('data-dwv')).split(';').forEach(function (kv) {
        var i = kv.indexOf('='), k = kv.slice(0, i), v = kv.slice(i + 1);
        if (i < 1 || !/^[a-z][a-z0-9-]*$/.test(k) || !/^(-?\d+(\.\d+)?(%|px)?|#[0-9a-fA-F]{3,8})$/.test(v)) return;
        try { el.style.setProperty('--dw-' + k, v); } catch (e) { /* old engine */ }
      });
    });
  }
  function ringSvg(pct, tone, txt) {
    var circ = 2 * Math.PI * 26, fill = circ * Math.max(0, Math.min(100, N(pct))) / 100;
    return '<svg class="kj-dash-ring kj-dwx-ring' + (tone ? ' is-' + tone : '') + '" viewBox="0 0 64 64" aria-hidden="true"><circle class="kj-ring-bg" cx="32" cy="32" r="26"/>' +
      '<circle class="kj-ring-fg" cx="32" cy="32" r="26" stroke-dasharray="' + fill.toFixed(1) + ' ' + circ.toFixed(1) + '" transform="rotate(-90 32 32)"/>' +
      (txt != null ? '<text class="kj-dwx-ring-txt" x="32" y="36.5" text-anchor="middle">' + esc(txt) + '</text>' : '') + '</svg>';
  }
  function pctTone(p) { return p == null ? 'muted' : p >= 90 ? '' : p >= 75 ? 'warn' : 'danger'; }
  function avatar(name, photo, cls) {
    return photo ? '<img class="kj-avatar kj-dwx-av' + (cls ? ' ' + cls : '') + '" src="' + esc(photo) + '" alt="" loading="lazy">'
      : '<span class="kj-avatar kj-dwx-av' + (cls ? ' ' + cls : '') + '">' + esc(initials(name)) + '</span>';
  }
  function sparkBars(vals) {
    var W = 60, H = 18, max = Math.max.apply(null, [1].concat(vals)), bw = W / vals.length;
    return '<svg class="kj-dwx-sparkbars" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' + vals.map(function (v, i) {
      var h = v ? Math.max(2, H * v / max) : 0.8;
      return '<rect' + (v ? '' : ' class="is-zero"') + ' x="' + (i * bw + 0.4).toFixed(1) + '" y="' + (H - h).toFixed(1) + '" width="' + Math.max(0.6, bw - 0.8).toFixed(1) + '" height="' + h.toFixed(1) + '"/>';
    }).join('') + '</svg>';
  }
  function weekDays() {
    var d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    var out = []; for (var i = 0; i < 5; i++) { out.push(ymd(d)); d.setDate(d.getDate() + 1); }
    return out;
  }
  var WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function occZones(v) {
    var by = {};
    (v && v.pins || []).forEach(function (p) {
      var k = String(p.label || p.camera_id || 'Zone');
      var z = by[k] || (by[k] = { label: k, people: 0, detections: 0, last: null, plan: p.floorplan_id });
      z.people += N(p.people); z.detections += N(p.detections);
      if (p.last_seen && (!z.last || p.last_seen > z.last)) z.last = p.last_seen;
    });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.people - a.people || b.detections - a.detections || (a.label < b.label ? -1 : 1); });
  }
  var HEAT_MODS = [['ppe', 'PPE'], ['intr', 'Restricted'], ['forklift', 'Forklift'], ['fire', 'Fire'], ['cleaning', 'Cleaning'], ['behaviour', 'Behaviour'], ['face', 'Face']];
  function heatMatrix(c) {
    var m = {};
    fEvents(c, { def: 'today', cam: 1, sev: 1 }).forEach(function (e) {
      var k = e.mod || 'other', h = new Date(tsOfEvent(e)).getHours();
      (m[k] || (m[k] = new Array(24).fill(0)))[h]++;
    });
    return m;
  }
  function camRank(c) {
    var by = {}, names = {};
    camStats(c.st).fleet.forEach(function (f) { names[String(f.stream || '').toUpperCase()] = f.name; });
    fEvents(c, { def: 'today', cam: 1, sev: 1 }).filter(function (e) { return e.mod !== 'face'; }).forEach(function (e) {
      var k = String(e.camera || 'CAM').toUpperCase(), r = by[k] || (by[k] = { cam: k, name: names[k] || e.device || k, n: 0, hours: new Array(12).fill(0), mods: {} });
      r.n++; r.hours[Math.floor(new Date(tsOfEvent(e)).getHours() / 2)]++; r.mods[e.mod] = (r.mods[e.mod] || 0) + 1;
    });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.n - a.n; });
  }
  function unknownFaces(c) { return fEvents(c, { def: 'today', cam: 1 }).filter(function (e) { return e.mod === 'face' && !e.person; }).sort(function (a, b) { return tsOfEvent(b) - tsOfEvent(a); }); }
  var REP_SCOPE = { personal: ['Personal', 'primary', 'user'], standard: ['Standard', 'info', 'file-text'], comprehensive: ['Comprehensive', 'purple', 'sparkles'] };
  function notifTarget(n) {
    if (n.ref_type === 'leave' && n.ref_id) return modalAttr('leave', n.ref_id);
    if (n.ref_type === 'ticket' && n.ref_id) return modalAttr('ticket', n.ref_id);
    if (n.link && /^#[a-z]/i.test(n.link)) return navAttr(n.link.slice(1));
    return '';
  }
  function markNotifs(ids) {
    var v = D.notifs.v;
    if (v) {
      var flipped = 0;
      v.rows.forEach(function (n) { if ((!ids || ids.indexOf(n.id) >= 0) && !n.read) { n.read = true; flipped++; } });
      v.unread = ids ? Math.max(0, v.unread - flipped) : 0;
    }
    paint();
    apiPost('/notifications/read', ids ? { ids: ids } : { all: true })
      .then(function (r) { if (D.notifs.v && r && r.unread_count != null) { D.notifs.v.unread = N(r.unread_count); paint(); } })
      .catch(function () { /* stays unread server-side; next poll corrects */ })
      .then(function () { try { if (window.KJShell && window.KJShell.bell && window.KJShell.bell.refresh) window.KJShell.bell.refresh(); } catch (e) { /* bell optional */ } });
  }

  WIDGETS = WIDGETS.concat([
    /* Zone occupancy (supervisor+) ------------------------------------- */
    { id: 'occupancy', title: 'Zone occupancy', sub: 'People per zone · last 15 min', icon: 'map-pinned', tone: 'success', perm: 'view', tier: 'supervisor',
      sizes: ['1x1', '1x2'], needs: ['occupancy'], desc: 'Current headcount per floor-plan zone (distinct people seen in the last 15 minutes).',
      nav: { label: 'Movement', path: 'movement' },
      sig: function (c) { var o = D.occupancy; return o.st + c.cols + JSON.stringify(o.v ? [o.v.total_people, occZones(o.v).slice(0, 6)] : o.err || ''); },
      render: function (el, c) {
        var g = remoteGate(D.occupancy, 'list', { errTitle: 'Occupancy unavailable', nav: { label: 'Movement', path: 'movement' } }); if (g) { el.innerHTML = g; return; }
        var v = D.occupancy.v, zs = occZones(v);
        if (!zs.length) { el.innerHTML = emptyBox({ icon: 'map-pinned', title: 'No zones mapped yet', text: 'Pin cameras on a floor plan to see who is where.', nav: { label: 'Floor plans', path: 'movement' } }); return; }
        var max = Math.max(1, zs[0].people), top = zs.slice(0, c.cols > 1 ? 5 : 3);
        el.innerHTML = '<button type="button" class="kj-dd kj-dwx-headline"' + navAttr('movement') + '><span class="kj-dash-big">' + fmtN(v.total_people) + '</span>' +
            '<span class="kj-dash-cmp">people on the floor · ' + fmtN(zs.length) + ' zone' + (zs.length === 1 ? '' : 's') + '</span>' + chev() + '</button>' +
          '<div class="kj-dash-bars kj-dwx-bars">' + top.map(function (z) {
            return '<button type="button" class="kj-dash-bar"' + navAttr('movement') + ' aria-label="' + esc(z.label + ': ' + z.people + ' people') + '"><span class="kj-dwx-ell">' + esc(z.label) + '</span>' +
              '<span class="kj-progress"><span class="kj-progress-fill ' + (z.people ? 'kj-fill-success ' : 'kj-fill-muted ') + w5(100 * z.people / max) + '"></span></span><b>' + fmtN(z.people) + '</b></button>';
          }).join('') + '</div>';
      } },

    /* Floor plan live (supervisor+) ------------------------------------ */
    { id: 'floorplan-live', title: 'Floor plan live', sub: 'Camera pins, live status and headcount', icon: 'map', perm: 'view', tier: 'supervisor',
      sizes: ['1x2', '1x3'], rows: 2, needs: ['floorplans', 'occupancy'], desc: 'First active floor plan with live camera pins; click a pin for its camera.',
      nav: { label: 'Open movement', path: 'movement' },
      sig: function (c) {
        var f = D.floorplans, o = D.occupancy, s = camStats(c.st);
        return f.st + c.cols + JSON.stringify(f.v ? f.v.plans.map(function (p) { return [p.id, p.image_url, (p.pins || []).length]; }) : f.err || '') +
          JSON.stringify(s.fleet.map(function (x) { return (x.stream || '') + (x.online ? 1 : 0); })) + (o.v ? JSON.stringify((o.v.pins || []).map(function (p) { return p.pin_id + ':' + p.people; })) : '');
      },
      render: function (el, c) {
        var g = remoteGate(D.floorplans, 'chart', { errTitle: 'Floor plans unavailable', nav: { label: 'Movement', path: 'movement' } }); if (g) { el.innerHTML = g; return; }
        var plans = D.floorplans.v.plans;
        if (!plans.length) { el.innerHTML = emptyBox({ icon: 'map', title: 'No floor plan yet', text: 'Upload a floor plan and pin your cameras on it.', nav: { label: 'Set up floor plans', path: 'movement' } }); return; }
        var plan = plans[0], pins = plan.pins || [], on = {}, ppl = {};
        camStats(c.st).fleet.forEach(function (f) { on[String(f.stream || '').toLowerCase()] = !!f.online; });
        if (D.occupancy.st === 'ok') (D.occupancy.v.pins || []).forEach(function (p) { ppl[p.pin_id] = N(p.people); });
        var nOn = 0, nOff = 0;
        var dots = pins.map(function (p) {
          var cam = String(p.camera_id || '').toLowerCase(), state = cam in on ? (on[cam] ? 'on' : 'off') : 'unk';
          if (state === 'on') nOn++; else if (state === 'off') nOff++;
          var n = ppl[p.id] || 0, x = Math.max(0, Math.min(100, N(p.x_pct))), y = Math.max(0, Math.min(100, N(p.y_pct)));
          var lbl = (p.label || cam) + ' · ' + (state === 'on' ? 'online' : state === 'off' ? 'offline' : 'no live status') + (n ? ' · ' + n + ' people' : '');
          return '<button type="button" class="kj-dwfp-pin is-' + state + '"' + dvars({ x: x.toFixed(2) + '%', y: y.toFixed(2) + '%' }) +
            (p.camera_id ? modalAttr('camera', p.camera_id, { name: p.label, location: p.location }) : navAttr('movement')) + ' aria-label="' + esc(lbl) + '" title="' + esc(lbl) + '">' +
            (n ? '<span class="kj-dwfp-n">' + n + '</span>' : '') + '</button>';
        }).join('');
        var ar = N(plan.width_px) && N(plan.height_px) ? (N(plan.width_px) / N(plan.height_px)).toFixed(4) : '1.7778';
        var src = String(plan.image_url || '').replace(/^\/api(?=\/)/, '');
        el.innerHTML = '<div class="kj-dwfp">' +
          '<div class="kj-dwfp-bar"><button type="button" class="kj-dwfp-name"' + navAttr('movement') + '>' + ico('map') + '<span class="kj-dwx-ell">' + esc(plan.name || 'Floor plan') + '</span>' + ico('chevron-right') + '</button>' +
            '<span class="kj-spacer"></span><button type="button" class="kj-dwfp-key"' + modalAttr('dash-cameras', 'all') + '><span class="kj-dash-dot"></span>' + nOn + ' live<span class="kj-dash-dot is-danger"></span>' + nOff + ' offline</button></div>' +
          '<div class="kj-dwfp-wrap"><div class="kj-dwfp-stage"' + dvars({ ar: ar }) + '>' +
            (src ? '<img class="kj-dwfp-img" src="' + esc(tokUrl(src)) + '" alt="' + esc((plan.name || 'Floor') + ' plan') + '" draggable="false">' : '') + dots + '</div></div>' +
          (plans.length > 1 ? '<div class="kj-dwfp-more">' + plans.slice(1, 4).map(function (p) {
            return '<button type="button" class="kj-chip"' + navAttr('movement') + '>' + ico('layers') + esc(p.name) + ' · ' + (p.pins || []).length + '</button>';
          }).join('') + '</div>' : '') +
          (!pins.length ? '<div class="kj-dwfp-hint"><button type="button" class="kj-btn kj-btn-soft kj-btn-sm"' + navAttr('movement') + '>' + ico('map-pin') + 'Pin cameras on this plan</button></div>' : '') + '</div>';
      } },

    /* Recent check-ins (supervisor+) ----------------------------------- */
    { id: 'checkins', title: 'Recent check-ins', sub: 'Latest clock-ins today', icon: 'log-in', tone: 'success', perm: 'view', tier: 'supervisor',
      sizes: ['1x2', '1x1', '1x3'], rows: 2, needs: ['checkins'], desc: 'Live stream of today’s clock-ins with photo, time and location.',
      nav: { label: 'Attendance', path: 'attendance' },
      sig: function (c) { var r = D.checkins; return r.st + c.cols + JSON.stringify(r.v ? [r.v.kpi, r.v.rows.slice(0, 6).map(function (x) { return [x.personId, x.clockIn, x.status]; })] : r.err || ''); },
      render: function (el, c) {
        var g = remoteGate(D.checkins, 'list', { errTitle: 'Attendance unavailable', nav: { label: 'Attendance', path: 'attendance' } }); if (g) { el.innerHTML = g; return; }
        var v = D.checkins.v, k = v.kpi || {}, tot = Math.max(1, N(k.total)), pres = N(k.present);
        if (!v.rows.length) { el.innerHTML = emptyBox({ lottie: 'scan', icon: 'scan-face', title: 'No check-ins yet today', text: 'Clock-ins appear here as people arrive.', nav: { label: 'Attendance', path: 'attendance' } }); return; }
        el.innerHTML = '<button type="button" class="kj-dd kj-dwx-progress"' + modalAttr('attendance-day', today()) + '><span class="kj-dwx-progress-lbl"><b>' + fmtN(pres) + '</b> of ' + fmtN(k.total) + ' checked in' +
            (N(k.late) ? ' · <span class="kj-dwx-warn">' + fmtN(k.late) + ' late</span>' : '') + '</span><span class="kj-progress"><span class="kj-progress-fill kj-fill-success ' + w5(100 * pres / tot) + '"></span></span></button>' +
          '<div class="kj-dash-list">' + v.rows.slice(0, c.cols >= 2 ? 6 : 5).map(function (r) {
            var late = r.status === 'late';
            return '<div class="kj-dash-item"' + modalAttr('person', r.personId, { name: r.name, photo: r.photo, staffId: r.staffId }) + '>' + avatar(r.name, r.photo) +
              '<span class="kj-dash-item-main"><span class="kj-dash-item-title">' + esc(r.name || r.staffId || r.personId) + '</span><span class="kj-dash-item-sub">' + esc([r.clockInLoc, r.department].filter(Boolean).join(' · ') || 'Checked in') + '</span></span>' +
              '<span class="kj-chip ' + (late ? 'is-warn' : 'is-success') + '">' + esc(hhmm(r.clockIn)) + '</span>' + chev() + '</div>';
          }).join('') + '</div>';
      } },

    /* On leave this week (supervisor+) --------------------------------- */
    { id: 'onleave', title: 'On leave this week', sub: 'Approved leave, Monday – Friday', icon: 'calendar-off', tone: 'orange', perm: 'view', tier: 'supervisor',
      sizes: ['1x2', '1x3', '1x4'], needs: ['onleave'], desc: 'Who is out each working day this week; click a face for the leave request.',
      nav: { label: 'Leave calendar', path: 'attendance' },
      sig: function (c) { var r = D.onleave; return r.st + c.cols + JSON.stringify(r.v ? [r.v.days, r.v.rows.map(function (l) { return [l.id, l.start_date, l.end_date]; })] : r.err || ''); },
      render: function (el, c) {
        var g = remoteGate(D.onleave, 'chart', { errTitle: 'Leave calendar unavailable', nav: { label: 'Attendance', path: 'attendance' } }); if (g) { el.innerHTML = g; return; }
        var v = D.onleave.v, td = today(), lim = c.cols >= 3 ? 4 : 3;
        if (!v.rows.length) { el.innerHTML = emptyBox({ lottie: 'success', icon: 'calendar-check', title: 'Everyone is in this week', text: 'No approved leave Monday to Friday.', nav: { label: 'Leave calendar', path: 'attendance' } }); return; }
        var people = {}; v.rows.forEach(function (l) { people[l.person_id || l.user_id || l.name] = 1; });
        el.innerHTML = '<button type="button" class="kj-dd kj-dwol-sum"' + navAttr('attendance') + '><b>' + Object.keys(people).length + '</b> ' + (Object.keys(people).length === 1 ? 'person' : 'people') + ' out this week' + chev() + '</button>' +
          '<div class="kj-dwol">' + v.days.map(function (d) {
            var out = v.rows.filter(function (l) { return l.start_date <= d && l.end_date >= d; });
            var dt = new Date(d + 'T12:00:00');
            return '<div class="kj-dwol-day' + (d === td ? ' is-today' : '') + (d < td ? ' is-past' : '') + '">' +
              '<button type="button" class="kj-dwol-lbl"' + navAttr('attendance') + '>' + WD[dt.getDay()] + ' <b>' + dt.getDate() + '</b></button>' +
              '<div class="kj-dwol-faces">' + (out.length ? out.slice(0, lim).map(function (l) {
                var col = /^#[0-9a-fA-F]{3,8}$/.test(String(l.color || '')) ? l.color : '';
                return '<button type="button" class="kj-avatar kj-dwol-av' + (col ? ' is-typed' : '') + '"' + (col ? dvars({ c: col }) : '') +
                  modalAttr('leave', l.id, Object.assign({}, l, { user_name: l.name })) + ' title="' + esc(l.name + ' · ' + (l.leave_type_name || l.leave_type) + (l.half_day ? ' (half day)' : '')) + '" aria-label="' + esc(l.name + ' on leave') + '">' + esc(initials(l.name)) + '</button>';
              }).join('') + (out.length > lim ? '<button type="button" class="kj-avatar kj-dwol-av is-more"' + navAttr('attendance') + '>+' + (out.length - lim) + '</button>' : '')
                : '<button type="button" class="kj-dwol-none"' + navAttr('attendance') + ' aria-label="Nobody out">' + ico('check') + '</button>') + '</div>' +
              '<span class="kj-dwol-n">' + (out.length ? out.length + ' out' : 'all in') + '</span></div>';
          }).join('') + '</div>';
      } },

    /* Detections heatmap ------------------------------------------------ */
    { id: 'heatmap', title: 'Detections heatmap', sub: 'Hour of day × module · today', icon: 'grid-3x3', tone: 'danger', perm: 'view',
      sizes: ['1x2', '1x3', '1x4'], rows: 2, desc: 'When each AI module fires during the day; click a cell to open that module.',
      nav: { label: 'Detections', path: 'detections' },
      sig: function (c) { return JSON.stringify(heatMatrix(c)) + (Array.isArray(c.st.events) ? 1 : 0); },
      render: function (el, c) {
        if (!Array.isArray(c.st.events)) { el.innerHTML = skel('chart'); return; }
        var m = heatMatrix(c), mods = HEAT_MODS.filter(function (x) { return m[x[0]]; });
        Object.keys(m).forEach(function (k) { if (!HEAT_MODS.some(function (x) { return x[0] === k; })) mods.push([k, cap(k)]); });
        if (!mods.length) { el.innerHTML = emptyBox({ lottie: 'success', icon: 'grid-3x3', title: c.win ? 'No detections in ' + c.win.label : 'No detections yet today', text: 'The heatmap fills in as detections arrive.', nav: { label: 'Detection log', path: 'detections' } }); return; }
        var max = 1, total = 0;
        mods.forEach(function (x) { m[x[0]].forEach(function (n) { if (n > max) max = n; total += n; }); });
        // "future" shading only for a single-day view that ends now (live today) or at the time-travel moment
        var nowH = !c.win ? new Date().getHours() : (c.win.days === 1 && (c.win.hist || c.win.toD === today()) ? new Date(c.win.to).getHours() : 24);
        var rowsH = mods.map(function (x) {
          var hub = MOD_HUB[x[0]] || 'detections';
          return '<button type="button" class="kj-dwhm-mod"' + navAttr(hub) + '>' + ico(MOD_ICON[x[0]] || 'scan-eye') + '<span class="kj-dwx-ell">' + esc(x[1]) + '</span></button>' +
            m[x[0]].map(function (n, h) {
              var lv = n ? Math.max(1, Math.min(4, Math.ceil(4 * n / max))) : 0;
              var t = x[1] + ' · ' + pad(h) + ':00–' + pad((h + 1) % 24) + ':00 · ' + n + ' detection' + (n === 1 ? '' : 's');
              return '<button type="button" class="kj-dwhm-cell is-l' + lv + (h > nowH ? ' is-future' : '') + '"' + navAttr(hub) + ' title="' + esc(t) + '" aria-label="' + esc(t) + '"></button>';
            }).join('');
        }).join('');
        var axis = '<span></span>' + Array.apply(null, Array(24)).map(function (_, h) { return '<span class="kj-dwhm-ax">' + (h % 6 === 0 ? pad(h) : '') + '</span>'; }).join('');
        el.innerHTML = '<div class="kj-dwhm"><div class="kj-dwhm-grid">' + rowsH + axis + '</div>' +
          '<div class="kj-dwhm-foot"><button type="button" class="kj-dwhm-total"' + navAttr('detections') + '><b>' + fmtN(total) + '</b> detections ' + (c.win ? '· ' + esc(c.win.label) : 'today') + '</button><span class="kj-spacer"></span>' +
          '<span class="kj-dwhm-key">Less<i class="is-l0"></i><i class="is-l1"></i><i class="is-l2"></i><i class="is-l3"></i><i class="is-l4"></i>More</span></div></div>';
      } },

    /* Top cameras ------------------------------------------------------- */
    { id: 'top-cameras', title: 'Top cameras', sub: 'Most detections today', icon: 'cctv', tone: 'warn', perm: 'view',
      sizes: ['1x1', '1x2'], rows: 2, desc: 'Cameras ranked by today’s detections with an hourly spark bar.',
      nav: { label: 'Camera wall', path: 'cameras/wall' },
      sig: function (c) { return JSON.stringify(camRank(c).slice(0, 6).map(function (r) { return [r.cam, r.n, r.hours]; })) + c.cols + (Array.isArray(c.st.events) ? 1 : 0); },
      render: function (el, c) {
        if (!Array.isArray(c.st.events)) { el.innerHTML = skel('list'); return; }
        var rows = camRank(c).slice(0, 5);
        if (!rows.length) { el.innerHTML = emptyBox({ lottie: 'success', icon: 'cctv', title: 'Quiet cameras', text: c.win ? 'No detections in ' + c.win.label + '.' : 'No detections on any camera today.', nav: { label: 'Camera wall', path: 'cameras/wall' } }); return; }
        var max = Math.max(1, rows[0].n);
        el.innerHTML = '<div class="kj-dwtc">' + rows.map(function (r, i) {
          var top = Object.keys(r.mods).sort(function (a, b) { return r.mods[b] - r.mods[a]; })[0];
          return '<button type="button" class="kj-dwtc-row"' + modalAttr('camera', r.cam) + ' aria-label="' + esc(r.name + ': ' + r.n + ' detections ' + (c.win ? c.win.label : 'today')) + '">' +
            '<span class="kj-dwtc-rank' + (i === 0 ? ' is-first' : '') + '">' + (i + 1) + '</span>' +
            '<span class="kj-dwtc-main"><span class="kj-dwtc-name"><span class="kj-dwx-ell">' + esc(r.name) + '</span>' + ico(MOD_ICON[top] || 'scan-eye') + '</span>' +
              '<span class="kj-progress"><span class="kj-progress-fill kj-fill-warn ' + w5(100 * r.n / max) + '"></span></span></span>' +
            sparkBars(r.hours) + '<b class="kj-dwtc-n">' + fmtN(r.n) + '</b></button>';
        }).join('') + '</div>';
      } },

    /* Unknown faces today (supervisor+) -------------------------------- */
    { id: 'unknown-faces', title: 'Unknown faces today', sub: 'Faces with no employee match', icon: 'scan-face', tone: 'purple', perm: 'view', tier: 'supervisor',
      sizes: ['1x1', '1x2'], desc: 'Strangers seen today with their latest captures.', nav: { label: 'Face detections', path: 'detections' },
      sig: function (c) { var u = unknownFaces(c); return JSON.stringify([c.ov && c.ov.employees && c.ov.employees.unknownToday, u.length, u.slice(0, 6).map(function (e) { return e.id + (e.image || ''); })]) + c.cols + (Array.isArray(c.st.events) ? 1 : 0); },
      render: function (el, c) {
        if (!Array.isArray(c.st.events) && !c.ov) { el.innerHTML = skel('fig'); return; }
        var faces = unknownFaces(c), e = (c.ov && c.ov.employees) || {};
        var ids = {}; faces.forEach(function (f) { ids[f.personId || f.id] = 1; });
        var n = e.unknownToday != null && !c.win && !S.filters.cams.length ? N(e.unknownToday) : Object.keys(ids).length;
        if (!n && !faces.length) { el.innerHTML = emptyBox({ lottie: 'success', icon: 'user-check', title: c.win ? 'No strangers in ' + c.win.label : 'No strangers today', text: 'Every face seen matched an employee.', nav: { label: 'People', path: 'people' } }); return; }
        var main = '<button type="button" class="kj-dd kj-dash-fig"' + navAttr('detections') + '><span class="kj-dwx-well is-purple">' + ico('user-round-x') + '</span><span class="kj-dash-fig-main">' +
          '<span class="kj-dash-big">' + fmtN(n) + '</span><span class="kj-dash-cmp">unknown ' + (n === 1 ? 'face' : 'faces') + ' · ' + fmtN(faces.length) + ' sighting' + (faces.length === 1 ? '' : 's') + '</span></span>' + chev() + '</button>';
        var th = faces.slice(0, c.cols > 1 ? 6 : 3).map(function (f) {
          return '<button type="button" class="kj-dwuf-th"' + modalAttr('event', f.id) + ' aria-label="Unknown face at ' + esc(f.camera + ' ' + fmtWhen(f.ts)) + '">' +
            (f.image ? '<img src="' + esc(f.image) + '" alt="" loading="lazy">' : ico('user-round')) + '<span class="kj-dwuf-t">' + esc(hhmm(f.ts)) + '</span></button>';
        }).join('');
        el.innerHTML = main + (th ? '<div class="kj-dwuf">' + th + '</div>' : '');
      } },

    /* SLA performance (tickets) ---------------------------------------- */
    { id: 'sla-perf', title: 'SLA performance', sub: 'Closed tickets · last 7 days', icon: 'timer', tone: 'purple', perm: 'tickets',
      sizes: ['1x1', '1x2'], needs: ['slaperf'], desc: 'Response and resolution SLA met-rate rings plus breaches (7 days).', nav: { label: 'Tickets', path: 'tickets' },
      sig: function (c) { var s = D.slaperf; return s.st + c.cols + JSON.stringify(s.v ? [s.v.resp, s.v.res, s.v.breached, s.v.n] : s.err || ''); },
      render: function (el, c) {
        var g = remoteGate(D.slaperf, 'fig', { errTitle: 'SLA data unavailable', nav: { label: 'Tickets', path: 'tickets' } }); if (g) { el.innerHTML = g; return; }
        var v = D.slaperf.v;
        if (!v.rd && !v.sd) { el.innerHTML = emptyBox({ icon: 'timer', title: c.win ? 'No closed tickets in ' + c.win.label : 'No closed tickets this week', text: 'SLA rates appear once tickets are resolved.', nav: { label: 'Ticket board', path: 'tickets' } }); return; }
        var ring = function (p, lbl, met, of) {
          return '<button type="button" class="kj-dwsla-ring"' + navAttr('tickets') + ' aria-label="' + esc(lbl + ' SLA met ' + (p == null ? 'n/a' : p + '%')) + '">' + ringSvg(p, pctTone(p), p == null ? '—' : Math.round(p) + '%') +
            '<span class="kj-dwsla-lbl">' + esc(lbl) + '</span><span class="kj-dwsla-sub">' + fmtN(met) + '/' + fmtN(of) + ' met</span></button>';
        };
        el.innerHTML = '<div class="kj-dwsla">' + ring(v.resp, 'Response', v.rm, v.rd) + ring(v.res, 'Resolution', v.sm, v.sd) +
          (c.cols > 1 ? '<div class="kj-dwsla-side"><button type="button" class="kj-dd kj-dwsla-n"' + navAttr('tickets') + '><span class="kj-dash-big">' + fmtN(v.n) + '</span><span class="kj-dash-cmp">tickets closed · ' + esc(c.win ? c.win.label : '7 days') + '</span></button></div>' : '') + '</div>' +
          '<button type="button" class="kj-chip kj-dwsla-chip ' + (v.breached ? 'is-danger' : 'is-success') + '"' + navAttr('tickets') + '>' + ico(v.breached ? 'alarm-clock-off' : 'circle-check') + (v.breached ? fmtN(v.breached) + ' breached' : 'No SLA breaches') + '</button>';
      } },

    /* Recent reports (reports perm) ------------------------------------ */
    { id: 'reports', title: 'Recent reports', sub: 'AI-written management reports', icon: 'file-chart-column', tone: 'purple', perm: 'reports',
      sizes: ['1x2', '1x1', '1x3'], rows: 2, needs: ['reports'], desc: 'Your latest three AI reports with scope and date.', nav: { label: 'All reports', path: 'analytics/reports' },
      sig: function (c) { var r = D.reports; return r.st + c.cols + JSON.stringify(r.v ? r.v.rows.map(function (x) { return [x.id, x.status, x.title]; }) : r.err || ''); },
      render: function (el, c) {
        var g = remoteGate(D.reports, 'list', { errTitle: 'Reports unavailable', nav: { label: 'Reports', path: 'analytics/reports' } }); if (g) { el.innerHTML = g; return; }
        var rows = D.reports.v.rows.slice(0, 3);
        if (!rows.length) { el.innerHTML = emptyBox({ lottie: 'empty', icon: 'file-chart-column', title: c.win ? 'No reports in ' + c.win.label : 'No reports yet', text: 'Generate an AI report from Analytics.', nav: { label: 'Generate a report', path: 'analytics/reports', icon: 'sparkles' } }); return; }
        var hasModal = !!(window.KJModal && window.KJModal.types && window.KJModal.types().indexOf('report') >= 0);
        el.innerHTML = '<div class="kj-dash-list">' + rows.map(function (r) {
          var sc = REP_SCOPE[r.scope] || [cap(r.scope || 'Report'), 'info', 'file-text'], done = r.status === 'done';
          return '<div class="kj-dash-item"' + (hasModal ? modalAttr('report', r.id) : navAttr('analytics/reports')) + '><span class="kj-dwx-well is-' + sc[1] + '">' + ico(sc[2]) + '</span>' +
            '<span class="kj-dash-item-main"><span class="kj-dash-item-title">' + esc(r.title || r.report_no || 'Report') + '</span>' +
            '<span class="kj-dash-item-sub">' + esc([r.report_no, r.range_from && r.range_to ? r.range_from + ' → ' + r.range_to : '', fmtWhen(r.created_at)].filter(Boolean).join(' · ')) + '</span></span>' +
            '<span class="kj-chip is-' + (done ? sc[1] : r.status === 'failed' ? 'danger' : 'warn') + '">' + esc(done ? sc[0] : cap(r.status)) + '</span>' + chev() + '</div>';
        }).join('') + '</div>';
      } },

    /* Fire & safety status --------------------------------------------- */
    { id: 'fire', title: 'Fire & safety', sub: 'Fire and smoke detection', icon: 'flame', tone: 'danger', perm: 'view',
      sizes: ['1x1', '1x2'], desc: 'Today’s fire/smoke detections and an all-clear state.', nav: { label: 'Fire & smoke', path: 'detections/fire' },
      sig: function (c) { var f = fEvents(c, { cam: 1 }).filter(function (e) { return e.mod === 'fire'; }); return JSON.stringify(f.slice(0, 4).map(function (e) { return [e.id, e.status]; })) + f.length + c.cols + (Array.isArray(c.st.events) ? 1 : 0); },
      render: function (el, c) {
        if (!Array.isArray(c.st.events)) { el.innerHTML = skel('fig'); return; }
        var all = fEvents(c, { cam: 1 }).filter(function (e) { return e.mod === 'fire'; }).sort(function (a, b) { return tsOfEvent(b) - tsOfEvent(a); });
        var td = fEvents(c, { def: 'today', cam: 1 }).filter(function (e) { return e.mod === 'fire'; }), open = all.filter(function (e) { return e.status !== 'resolved'; });
        var clear = !td.length && !open.length, last = all[0];
        var main = '<button type="button" class="kj-dd kj-dash-fig"' + navAttr('detections/fire') + '><span class="kj-dwx-well kj-dwfs-shield is-' + (clear ? 'success' : 'danger') + '">' + ico(clear ? 'shield-check' : 'flame') + '</span>' +
          '<span class="kj-dash-fig-main"><span class="kj-dash-status"><span class="kj-dash-dot' + (clear ? '' : ' is-danger') + '"></span>' + (clear ? 'All clear' : (open.length ? fmtN(open.length) + ' open' : 'Resolved')) + '</span>' +
          '<span class="kj-dash-big">' + fmtN(td.length) + '</span><span class="kj-dash-cmp">fire / smoke ' + esc(c.win ? '· ' + c.win.label : 'today') + '</span></span>' + chev() + '</button>';
        var lastBtn = last ? '<button type="button" class="kj-dwfs-last"' + modalAttr('event', last.id) + '>' + ico('history') + 'Last event ' + esc(fmtWhen(last.ts)) + ' · ' + esc(last.camera || '') + '</button>'
          : '<button type="button" class="kj-dwfs-last"' + navAttr('detections/fire') + '>' + ico('history') + 'No fire events in the live feed</button>';
        if (c.cols < 2) { el.innerHTML = main + lastBtn; return; }
        var rec = all.slice(0, 3);
        el.innerHTML = '<div class="kj-dash-split"><div class="kj-dwx-col">' + main + lastBtn + '</div><div class="kj-dash-list">' + (rec.length ? rec.map(function (e) {
          return '<div class="kj-dash-item"' + modalAttr('event', e.id) + '><span class="kj-dash-modico' + (e.status === 'resolved' ? ' is-info' : '') + '">' + ico('flame') + '</span>' +
            '<span class="kj-dash-item-main"><span class="kj-dash-item-title">' + esc(e.title || 'Fire / smoke') + '</span><span class="kj-dash-item-sub">' + esc([e.zone || e.camera, fmtWhen(e.ts)].filter(Boolean).join(' · ')) + '</span></span>' + chev() + '</div>';
        }).join('') : '<div class="kj-dash-item"' + navAttr('detections/fire') + '><span class="kj-dash-modico is-info">' + ico('circle-check') + '</span><span class="kj-dash-item-main"><span class="kj-dash-item-title">No fire or smoke detected</span><span class="kj-dash-item-sub">Open fire & smoke</span></span>' + chev() + '</div>') + '</div></div>';
      } },

    /* Cleaning compliance ---------------------------------------------- */
    { id: 'cleaning', title: 'Cleaning compliance', sub: 'Cleaning sessions & PPE', icon: 'sparkles', tone: 'success', perm: 'view',
      sizes: ['1x1', '1x2'], desc: '7-day cleaning PPE compliance ring and today’s session split.', nav: { label: 'Cleaning', path: 'detections/cleaning' },
      sig: function (c) { var cl = c.ov && c.ov.cleaning; return JSON.stringify(cl ? [cl.compliance, cl.sessionsToday, cl.done, cl.pending, cl.notDone] : c.ovErr) + fEvents(c, { def: 'today' }).filter(function (e) { return e.mod === 'cleaning'; }).length + c.cols; },
      render: function (el, c) {
        var g = ovGate(c, 'fig'); if (g) { el.innerHTML = g; return; }
        var cl = c.ov.cleaning || {}, comp = cl.compliance != null ? N(cl.compliance) : null, ses = N(cl.sessionsToday);
        var viol = fEvents(c, { def: 'today' }).filter(function (e) { return e.mod === 'cleaning'; }).length;
        if (comp == null && !ses && !viol) { el.innerHTML = emptyBox({ icon: 'sparkles', title: 'No cleaning checks yet', text: 'Compliance appears once cleaning sessions are detected.', nav: { label: 'Cleaning', path: 'detections/cleaning' } }); return; }
        var main = '<button type="button" class="kj-dd kj-dash-fig"' + modalAttr('stat', 'cl') + '>' + ringSvg(comp, pctTone(comp), comp == null ? '—' : Math.round(comp) + '%') +
          '<span class="kj-dash-fig-main"><span class="kj-dash-status">7-day compliance</span><span class="kj-dash-big">' + fmtN(cl.done) + '<small>/' + fmtN(ses) + '</small></span>' +
          '<span class="kj-dash-cmp">sessions done · ' + fmtN(viol) + ' violation' + (viol === 1 ? '' : 's') + ' ' + esc(c.win ? '· ' + c.win.label : 'today') + '</span></span>' + chev() + '</button>';
        if (c.cols < 2) { el.innerHTML = main; return; }
        var tot = Math.max(1, ses), seg = [['present', 'Done', N(cl.done)], ['late', 'Pending', N(cl.pending)], ['absent', 'Not done', N(cl.notDone)]];
        el.innerHTML = main + '<div class="kj-dash-seg">' + seg.map(function (s) {
          return s[2] ? '<button type="button" class="is-' + s[0] + ' ' + w5(100 * s[2] / tot) + '" aria-label="' + esc(s[1] + ': ' + s[2]) + '"' + navAttr('detections/cleaning') + '></button>' : '';
        }).join('') + '</div><div class="kj-dash-segkey">' + seg.map(function (s) {
          return '<button type="button"' + navAttr('detections/cleaning') + '><span class="kj-dash-dot ' + (s[0] === 'late' ? 'is-warn' : s[0] === 'absent' ? 'is-danger' : '') + '"></span>' + s[1] + ' <b>' + fmtN(s[2]) + '</b></button>';
        }).join('') + '</div>';
      } },

    /* My notifications (every signed-in role) -------------------------- */
    { id: 'notifications', title: 'My notifications', sub: 'Leave and ticket updates for you', icon: 'bell', perm: '',
      sizes: ['1x2', '1x1', '1x3'], rows: 2, needs: ['notifs'], desc: 'Your latest notifications, unread first; opening one marks it read.',
      sig: function (c) { var r = D.notifs; return r.st + c.cols + JSON.stringify(r.v ? [r.v.unread, r.v.rows.map(function (n) { return n.id + (n.read ? 'r' : 'u'); })] : r.err || ''); },
      render: function (el, c) {
        var g = remoteGate(D.notifs, 'list', { errTitle: 'Notifications unavailable' }); if (g) { el.innerHTML = g; return; }
        var v = D.notifs.v, rows = v.rows.slice().sort(function (a, b) { return (a.read ? 1 : 0) - (b.read ? 1 : 0) || b.id - a.id; }).slice(0, 5);
        if (!rows.length) { el.innerHTML = emptyBox({ lottie: 'success', icon: 'bell', title: 'You are all caught up', text: 'Leave decisions and ticket assignments land here.' }); return; }
        el.innerHTML = '<div class="kj-dwnt-head"><span class="kj-chip kj-chip-dot ' + (v.unread ? 'is-danger' : 'is-success') + '">' + (v.unread ? fmtN(v.unread) + ' unread' : 'All read') + '</span><span class="kj-spacer"></span>' +
            (v.unread ? '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-dash-act="notif-all">' + ico('check-check') + 'Mark all read</button>' : '') + '</div>' +
          '<div class="kj-dash-list">' + rows.map(function (n) {
            var t = notifTarget(n), icn = n.ref_type === 'ticket' ? 'ticket' : n.ref_type === 'leave' ? 'calendar-days' : 'bell';
            return '<div class="kj-dash-item kj-dwnt-item' + (n.read ? '' : ' is-unread') + '" data-dash-notif="' + N(n.id) + '"' + (t || ' role="button" tabindex="0"') + '>' +
              '<span class="kj-dwx-well is-' + (n.ref_type === 'ticket' ? 'purple' : n.ref_type === 'leave' ? 'success' : 'primary') + '">' + ico(icn) + '</span>' +
              '<span class="kj-dash-item-main"><span class="kj-dash-item-title">' + esc(n.title || cap(n.kind)) + '</span><span class="kj-dash-item-sub">' + esc(n.body || '') + '</span></span>' +
              '<span class="kj-dash-item-time">' + esc(fmtWhen(n.created_at)) + '</span>' + chev() + '</div>';
          }).join('') + '</div>';
      } }
  ]);

  // Filter semantics per widget (docs/plan/WIDGETS.md "Filters"): filt = which dashboard filters it honours
  // (d = date window / time travel, c = cameras, s = severity); fixed = its own period when it cannot honour
  // the date (shown as a "Fixed · …" tag); autoDays = its own span in days for Auto while time-travelling;
  // feed = reads the live feed (newest 300 + unresolved) so a long window may be partial.
  var FILT = {
    kpis: { fixed: 'Today' }, headcount: { fixed: 'Today' }, forklift: { fixed: 'Today' }, 'ai-summary': { fixed: 'Last 7 days' },
    occupancy: { fixed: 'Last 15 min' }, onleave: { fixed: 'This week' },
    'ppe-trend': { filt: 'd', autoDays: 7 }, accuracy: { filt: 'd', autoDays: 7 }, 'sla-perf': { filt: 'd', autoDays: 7 }, reports: { filt: 'd' },
    checkins: { filt: 'd', fixed: 'One day', dateOk: function (c) { return !c.win || c.win.days === 1; } },
    alerts: { filt: 'dcs', feed: 1 }, heatmap: { filt: 'dcs', feed: 1 }, 'top-cameras': { filt: 'dcs', feed: 1 },
    'unknown-faces': { filt: 'dc', feed: 1 }, fire: { filt: 'dc', feed: 1 }, cleaning: { filt: 'd', feed: 1 }
  };
  var WIDX = {};
  WIDGETS.forEach(function (w) { WIDX[w.id] = w; Object.assign(w, FILT[w.id] || {}); });
  /** Public catalog (settings → role preview reads it when present). */
  window.KJWidgets = WIDGETS.map(function (w) {
    return { id: w.id, title: w.title, desc: w.desc || w.sub || '', perm: w.perm || '', tier: w.tier || 'staff', sizes: w.sizes.slice(), icon: w.icon };
  });
  var STAT_OF = { ppe: 'ppe', intr: 'ra', forklift: 'fk', fire: 'ev', face: 'emp', cleaning: 'cl' };
  var LABEL_OF = { intr: 'restricted area', face: 'face & body' };

  function timerChip(r) {
    if (r.due == null) return '<span class="kj-dash-timer is-met">' + ico('circle-check') + 'Met</span>';
    return '<span class="kj-dash-timer" data-kj-due="' + r.due + '" data-kj-total="' + (r.total || 0) + '">' + ico('timer') + '<span>--:--:--</span></span>';
  }
  function tickTimers() {
    if (!S.el) return;
    var now = Date.now();
    Array.prototype.forEach.call(S.el.querySelectorAll('[data-kj-due]'), function (t) {
      var due = N(t.getAttribute('data-kj-due')), total = N(t.getAttribute('data-kj-total')), left = (due - now) / 1000;
      var txt = t.lastElementChild;
      if (txt) txt.textContent = (left < 0 ? '+' : '') + hms(left);
      t.classList.toggle('is-danger', left < 0 || (total > 0 && left / total < 0.25));
      t.classList.toggle('is-warn', left >= 0 && total > 0 && left / total >= 0.25 && left / total < 0.5);
      t.setAttribute('title', left < 0 ? 'Resolution SLA breached' : 'Time left to resolution SLA');
    });
  }

  /* ── charts ───────────────────────────────────────────────────────────── */
  function dayLbl(dt) { var p = String(dt).split('-'); return p.length === 3 ? N(p[2]) + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][N(p[1]) - 1] : dt; }
  function yRange(vals) {
    var lo = Math.min.apply(null, vals.concat([PPE_TARGET])), hi = Math.max.apply(null, vals.concat([PPE_TARGET]));
    lo = Math.max(0, Math.floor((lo - 2) / 2) * 2); hi = Math.min(100, Math.ceil((hi + 1) / 2) * 2);
    if (hi - lo < 4) lo = Math.max(0, hi - 4);
    return [lo, hi];
  }
  function svgTrend(days) {
    var W = 640, H = 230, L = 44, R = 16, T = 24, B = 28;
    var vals = days.map(function (d) { return d.pct; }), yr = yRange(vals);
    var x = function (i) { return days.length === 1 ? (L + W - R) / 2 : L + i * (W - L - R) / (days.length - 1); };
    var y = function (v) { return T + (yr[1] - v) * (H - T - B) / (yr[1] - yr[0]); };
    var out = '<svg class="kj-dash-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="PPE compliance per day">';
    for (var k = 0; k <= 4; k++) {
      var v = yr[0] + k * (yr[1] - yr[0]) / 4, yy = y(v).toFixed(1);
      out += '<line class="kj-ax" x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '"/><text class="kj-ax-lbl" x="' + (L - 8) + '" y="' + (N(yy) + 4) + '" text-anchor="end">' + Math.round(v) + '%</text>';
    }
    var ty = y(PPE_TARGET).toFixed(1);
    out += '<line class="kj-tgt" x1="' + L + '" x2="' + (W - R) + '" y1="' + ty + '" y2="' + ty + '"/>';
    var pts = days.map(function (d, i) { return x(i).toFixed(1) + ',' + y(d.pct).toFixed(1); });
    out += '<path class="kj-area" d="M' + x(0).toFixed(1) + ',' + (H - B) + ' L' + pts.join(' L') + ' L' + x(days.length - 1).toFixed(1) + ',' + (H - B) + ' Z"/>';
    out += '<polyline class="kj-ln" points="' + pts.join(' ') + '"/>';
    var step = Math.max(1, Math.ceil(days.length / 8)), dense = days.length > 10;   // long windows: thin the labels
    days.forEach(function (d, i) {
      var cx = x(i).toFixed(1), cy = y(d.pct).toFixed(1), last = i === days.length - 1;
      out += '<g' + modalAttr('stat', 'ppe@' + d.date) + ' aria-label="' + esc(dayLbl(d.date) + ': ' + d.pct + '% compliant, ' + d.violations + ' violations') + '">' +
        '<circle class="kj-pt-hit" cx="' + cx + '" cy="' + cy + '" r="' + (dense ? 8 : 16) + '"/><circle class="kj-pt" cx="' + cx + '" cy="' + cy + '" r="' + (dense ? 3 : 4.5) + '"/>' +
        (!dense || last ? '<text class="kj-pt-lbl' + (last ? ' is-last' : '') + '" x="' + cx + '" y="' + (N(cy) - 11) + '">' + d.pct + '%</text>' : '') + '</g>' +
        ((days.length - 1 - i) % step === 0 ? '<text class="kj-ax-lbl" x="' + cx + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(dayLbl(d.date)) + '</text>' : '');
    });
    return out + '</svg>';
  }
  function cssVar(el, n, fb) { try { return (getComputedStyle(el).getPropertyValue(n) || '').trim() || fb; } catch (e) { return fb; } }
  function hcTrend(box, days, c) {
    box.classList.add('kj-dash-chart-hc');
    var prim = cssVar(box, '--kj-primary', '#1E6BF1'), ok = cssVar(box, '--kj-success', '#16A34A'), muted = cssVar(box, '--kj-text-3', '#8691A8'),
      line = cssVar(box, '--kj-border', '#E3E8F0'), text = cssVar(box, '--kj-text', '#0F1B33'), surf = cssVar(box, '--kj-surface', '#fff');
    var yr = yRange(days.map(function (d) { return d.pct; }));
    try {
      S.charts[c.wid] = window.Highcharts.chart(box, {
        chart: { type: 'areaspline', backgroundColor: 'transparent', spacing: [12, 6, 4, 0], style: { fontFamily: 'Inter, system-ui, sans-serif' } },
        title: { text: undefined }, credits: { enabled: false }, exporting: { enabled: false }, legend: { enabled: false },
        xAxis: { categories: days.map(function (d) { return dayLbl(d.date); }), lineColor: line, tickColor: line, labels: { style: { color: muted, fontSize: '11px' } } },
        yAxis: { title: { text: null }, min: yr[0], max: yr[1], gridLineColor: line, labels: { format: '{value}%', style: { color: muted, fontSize: '11px' } },
          plotLines: [{ value: PPE_TARGET, color: ok, dashStyle: 'Dash', width: 1.5, zIndex: 3 }] },
        tooltip: { backgroundColor: surf, borderColor: line, style: { color: text }, valueSuffix: '%',
          pointFormatter: function () { var d = days[this.index] || {}; return '<b>' + this.y + '%</b> compliant<br>' + N(d.violations) + ' violations of ' + N(d.checks) + ' checks<br><i>Click for the day breakdown</i>'; } },
        plotOptions: { series: { cursor: 'pointer', animation: false, color: prim, fillOpacity: 0.1, lineWidth: 2.5,
          marker: { enabled: true, radius: days.length > 10 ? 3 : 4.5, fillColor: surf, lineWidth: 2.5, lineColor: prim, symbol: 'circle' },
          dataLabels: { enabled: days.length <= 10, format: '{y}%', style: { color: text, fontSize: '11px', fontWeight: '700', textOutline: 'none' } },
          point: { events: { click: function () { var d = days[this.index]; if (d && window.KJModal) window.KJModal.open('stat', 'ppe@' + d.date); } } } } },
        series: [{ name: 'Compliance', data: days.map(function (d) { return d.pct; }) }]
      });
    } catch (e) { box.classList.remove('kj-dash-chart-hc'); box.innerHTML = svgTrend(days); }
  }
  function sparkSvg(vals) {
    var W = 110, H = 40, lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi - lo < 1) { lo -= 1; hi += 1; }
    var pts = vals.map(function (v, i) { return (i * W / (vals.length - 1)).toFixed(1) + ',' + (H - 4 - (v - lo) * (H - 8) / (hi - lo)).toFixed(1); });
    return '<svg class="kj-dash-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true"><path class="kj-area" d="M0,' + H + ' L' + pts.join(' L') + ' L' + W + ',' + H + ' Z"/><polyline class="kj-ln" points="' + pts.join(' ') + '"/></svg>';
  }

  /* ── layout model ─────────────────────────────────────────────────────── */
  var DEFAULTS = {
    admin: [['kpis', '1x4'], ['ppe-trend', '1x3'], ['cameras', '1x1'], ['headcount', '1x1'], ['alerts', '1x2'], ['tickets', '1x2'],
      ['floorplan-live', '1x2'], ['heatmap', '1x2'], ['ai-summary', '1x4'], ['forklift', '1x1'], ['leave', '1x1'], ['accuracy', '1x1'], ['sla-perf', '1x1']],
    supervisor: [['headcount', '1x2'], ['leave', '1x1'], ['cameras', '1x1'], ['alerts', '1x2'], ['tickets', '1x2'],
      ['checkins', '1x2'], ['onleave', '1x2'], ['occupancy', '1x1'], ['ppe-trend', '1x3'], ['forklift', '1x1'], ['accuracy', '1x1']],
    staff: [['kpis', '1x4'], ['alerts', '1x2'], ['cameras', '1x1'], ['headcount', '1x1'], ['ppe-trend', '1x4']]
  };
  function defaultLayout() {
    return normalise((DEFAULTS[tier()] || DEFAULTS.staff).map(function (p) { return { id: p[0], size: p[1] }; }));
  }
  /** Drop unknown / not-permitted / duplicate widgets; coerce sizes to allowed ones. */
  function normalise(list) {
    var seen = {};
    return (Array.isArray(list) ? list : []).filter(function (it) {
      var w = it && WIDX[it.id];
      if (!w || seen[it.id] || !allowedWidget(w)) return false;
      seen[it.id] = 1; return true;
    }).map(function (it) { var w = WIDX[it.id]; return { id: it.id, size: w.sizes.indexOf(it.size) >= 0 ? it.size : w.sizes[0] }; });
  }
  /* Persistence. Multi-dashboard mode (server has /dashboard/list): S.dashes = [{id, name, is_default,
   * position, updated_at, widgets (null = role default), filters}], S.cur = open dashboard id; every
   * layout / filter change marks it dirty and a 700 ms debounce POSTs /dashboard/{id}/save. Compat mode
   * (list endpoint unreachable — older server or offline): one local dashboard saved through the legacy
   * /dashboard/layout alias, exactly like before. localStorage keeps a device copy of everything
   * (kj.dash.list.<user>) plus the last-open dashboard (kj.dash.cur.<user>). */
  var MAX_DASH = 12;
  function uKey(k) { return 'kj.dash.' + k + '.' + (me().username || 'anon'); }
  function lsKey() { return uKey('layout'); }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }
  function readCache() { var v = lsGet(lsKey()); return v && Array.isArray(v.widgets) ? normalise(v.widgets) : null; }
  function writeCache(list) { lsSet(lsKey(), { v: 1, widgets: list }); }
  function clearCache() { try { localStorage.removeItem(lsKey()); } catch (e) { /* ignore */ } }
  function readList() { var v = lsGet(uKey('list')); return v && Array.isArray(v.dashes) && v.dashes.length ? v : null; }
  function writeList() { if (!S.compat && S.dashes.length) lsSet(uKey('list'), { dashes: S.dashes }); }
  function readLast() { var v = lsGet(uKey('cur')); return v == null ? null : v; }
  function writeLast(id) { lsSet(uKey('cur'), id); }
  function sameLayout(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function fromServer(x) {
    return { id: N(x.id), name: String(x.name || 'Dashboard'), is_default: !!x.is_default, position: N(x.position), updated_at: x.updated_at || null,
      widgets: x.layout && Array.isArray(x.layout.widgets) ? x.layout.widgets : null, filters: normFilters(x.filters) };
  }
  function curDash() { for (var i = 0; i < S.dashes.length; i++) if (S.dashes[i].id === S.cur) return S.dashes[i]; return null; }
  function dashById(id) { for (var i = 0; i < S.dashes.length; i++) if (String(S.dashes[i].id) === String(id)) return S.dashes[i]; return null; }
  function defaultDash() { return S.dashes.filter(function (d) { return d.is_default; })[0] || S.dashes[0] || null; }
  /** Server listing → S.dashes, keeping in-memory edits of dashboards that still have unsaved changes. */
  function adoptList(rows) {
    var mem = {}; S.dashes.forEach(function (d) { mem[d.id] = d; });
    S.dashes = (rows || []).map(fromServer).map(function (d) {
      var m = mem[d.id]; if (m && S.dirty[d.id]) { d.widgets = m.widgets; d.filters = m.filters; }
      return d;
    });
    writeList();
  }

  function markDirty(kind) {
    var d = curDash(); if (!d) return;
    var x = S.dirty[d.id] || (S.dirty[d.id] = {});
    x[kind] = 1;
    writeList();
    scheduleSave();
  }
  function scheduleSave() {
    clearTimeout(S.saveT);
    S.saveT = setTimeout(function () { S.saveT = null; flushSaves(); }, 700);
  }
  /** POST every dirty dashboard now; resolves when the server has them (or failed — the device copy stays). */
  function flushSaves() {
    if (S.saveT) { clearTimeout(S.saveT); S.saveT = null; }
    var jobs = Object.keys(S.dirty).map(function (id) {
      var d = dashById(id), kinds = S.dirty[id];
      delete S.dirty[id];
      if (!d) return Promise.resolve();
      var p;
      if (S.compat) {
        if (!kinds.w) return Promise.resolve();   // filters live on this device only in compat mode
        p = apiPost('/dashboard/layout', d.widgets === null ? { reset: true } : { widgets: d.widgets });
      } else {
        var body = { filters: d.filters };
        if (d.widgets === null) body.reset = true; else body.widgets = d.widgets;
        p = apiPost('/dashboard/' + d.id + '/save', body).then(function (r) { if (r && r.dashboard) d.updated_at = r.dashboard.updated_at; });
      }
      return p.catch(function () {
        if (!S.warned) { S.warned = true; toast('Dashboard saved on this device only — the server could not be reached.', 'warn'); }
      });
    });
    return Promise.all(jobs);
  }
  function setLayout(list, opts) {
    opts = opts || {};
    var next = normalise(list);
    if (sameLayout(next, S.layout) && !opts.force) return;
    S.layout = next;
    var d = curDash();
    if (d && opts.save !== false) d.widgets = next.slice();
    if (S.compat || !d) writeCache(next);
    buildGrid();
    loadNeeds(false);
    if (opts.save !== false) markDirty('w');
  }
  function addWidget(id) {
    var w = WIDX[id]; if (!allowedWidget(w) || S.layout.some(function (x) { return x.id === id; })) return;
    setLayout(S.layout.concat([{ id: id, size: w.sizes[0] }]));
    toast(w.title + ' added', 'success');
    var el = S.grid && S.grid.querySelector('[data-wid="' + id + '"]');
    if (el && el.scrollIntoView) { try { el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) { /* jsdom */ } }
  }
  function removeWidget(id) {
    var w = WIDX[id];
    setLayout(S.layout.filter(function (x) { return x.id !== id; }));
    if (w) toast(w.title + ' removed', 'success');
  }
  function resizeWidget(id, size) {
    setLayout(S.layout.map(function (x) { return x.id === id ? { id: id, size: size } : x; }));
  }
  function moveWidget(id, to) {
    var from = S.layout.findIndex(function (x) { return x.id === id; });
    if (from < 0) return;
    to = Math.max(0, Math.min(S.layout.length - 1, to));
    if (to === from) return;
    var l = S.layout.slice(), it = l.splice(from, 1)[0];
    l.splice(to, 0, it);
    setLayout(l);
    var h = S.grid && S.grid.querySelector('[data-wid="' + id + '"] .kj-dw-handle');
    if (h) h.focus();
  }
  function resetLayout() {
    var d = curDash();
    if (S.compat || !d) clearCache();
    setLayout(defaultLayout(), { save: false, force: true });
    if (d) { d.widgets = null; markDirty('w'); flushSaves(); }
    toast('Dashboard reset to the default for your role', 'success');
  }

  /* ── dashboards: open / switch / create / rename / duplicate / delete / default ── */
  /** Show dashboard `d` (layout + filters) without saving anything. */
  function applyDash(d) {
    if (!d) return;
    S.cur = d.id;
    if (!S.compat) writeLast(d.id);
    S.filters = normFilters(d.filters);
    syncPlantToApp();
    setLayout(d.widgets ? d.widgets : defaultLayout(), { save: false, force: true });
    renderChrome();
    reloadDateStores();
  }
  function switchTo(id) {
    var d = dashById(id);
    if (!d || d.id === S.cur) return;
    closePops();
    flushSaves();
    applyDash(d);
    var t = S.root && S.root.querySelector('.kj-dsw-tab[aria-selected="true"]');
    if (t && t.focus && document.activeElement && document.activeElement.closest && document.activeElement.closest('.kj-dsw')) t.focus();
  }
  function uniqueName(base) {
    var taken = {}; S.dashes.forEach(function (d) { taken[d.name.toLowerCase()] = 1; });
    var n = String(base).slice(0, 60), i = 2;
    while (taken[n.toLowerCase()]) { var suf = ' ' + i++; n = String(base).slice(0, 60 - suf.length) + suf; }
    return n;
  }
  function cleanName(v) { return String(v || '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001F\u007F<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60); }
  /** create / rename via the API; resolves the affected dashboard, rejects with a user-facing message. */
  function createDash(name, copyFrom) {
    return flushSaves().then(function () {
      return apiPost('/dashboard/create', copyFrom != null ? { name: name, copy_from: copyFrom } : { name: name });
    }).then(function (r) {
      adoptList(r.dashboards);
      var d = dashById(r.dashboard.id);
      applyDash(d);
      if (d.widgets && !d.widgets.length) setEditing(true);   // started empty: straight into customise mode
      toast('“' + d.name + '” created', 'success');
      return d;
    });
  }
  function renameDash(id, name) {
    return flushSaves().then(function () { return apiPost('/dashboard/' + id + '/rename', { name: name }); }).then(function (r) {
      adoptList(r.dashboards); renderChrome(); toast('Renamed to “' + r.dashboard.name + '”', 'success'); return r.dashboard;
    });
  }
  function deleteDash(id) {
    var wasCur = String(id) === String(S.cur), name = (dashById(id) || {}).name || 'Dashboard';
    return flushSaves().then(function () { return apiPost('/dashboard/' + id + '/delete', {}); }).then(function (r) {
      adoptList(r.dashboards);
      if (wasCur) applyDash(defaultDash()); else renderChrome();
      toast('“' + name + '” deleted', 'success');
    });
  }
  function makeDefault(id) {
    return flushSaves().then(function () { return apiPost('/dashboard/' + id + '/default', {}); }).then(function (r) {
      adoptList(r.dashboards); renderChrome(); toast('“' + r.dashboard.name + '” is now your default dashboard', 'success');
    }).catch(function (e) { toast((e && e.message) || 'Could not change the default', 'danger'); });
  }

  /* ── filters + plant + time travel ─────────────────────────────────────── */
  function setFilters(patch, opts) {
    opts = opts || {};
    var before = S.filters, next = normFilters(Object.assign({}, before, patch));
    if (JSON.stringify(next) === JSON.stringify(before)) { renderFilterBar(); return; }
    S.filters = next;
    var d = curDash(); if (d) d.filters = JSON.parse(JSON.stringify(next));
    if (!opts.fromApp) syncPlantToApp();
    renderFilterBar();
    if (before.range !== next.range || before.from !== next.from || before.to !== next.to || before.plant !== next.plant) reloadDateStores();
    paint();
    if (opts.save !== false) markDirty('f');
  }
  /** The dashboard's plant drives the global plant (app.setPlant reloads the overview). */
  function syncPlantToApp() {
    var app = S.app, p = S.filters.plant || '';
    if (app && app.state && typeof app.setPlant === 'function' && (app.state.plant || '') !== p) app.setPlant(p);
  }
  /** Someone changed the topbar / sidebar plant while this dashboard is open → adopt it as the dashboard's plant. */
  function syncPlantFromApp() {
    var app = S.app; if (!S.ready || S.hist || !app || !app.state) return;
    var p = app.state.plant || '';
    if (p !== S.filters.plant) setFilters({ plant: p }, { fromApp: true });
  }
  function plantNames() {
    var st = (S.app && S.app.state) || {}, out = [];
    var add = function (n) { n = String(n || '').trim(); if (n && out.indexOf(n) < 0) out.push(n); };
    (st.plants || []).forEach(function (p) { add(p && p.name); });
    if (!out.length) ((st.ov && st.ov.plants) || []).forEach(function (p) { add(p && p.name); });
    if (!out.length) ((st.reg && st.reg.data && st.reg.data.plants) || []).forEach(add);
    if (!out.length && st.appCfg && Array.isArray(st.appCfg.att_plants)) st.appCfg.att_plants.forEach(add);
    if (S.filters.plant) add(S.filters.plant);
    return out;
  }
  function camOptions() {
    var out = [], seen = {};
    camStats((S.app && S.app.state) || {}).fleet.forEach(function (f) {
      var id = String(f.stream || f.serial || ''); if (!id || seen[id.toLowerCase()] || !/^[A-Za-z0-9._:-]{1,64}$/.test(id)) return;
      seen[id.toLowerCase()] = 1; out.push({ id: id, name: f.name || id, online: !!f.online });
    });
    S.filters.cams.forEach(function (c) { if (!seen[c.toLowerCase()]) out.push({ id: c, name: c, online: false, gone: true }); });
    return out;
  }
  function setHist(ms) {
    var st = (S.app && S.app.state) || {};
    if (ms == null || ms >= Date.now() - 60000) { backToLive(); return; }
    if (!S.hist) S.histSt = { events: st.events, fleet: st.fleet, live: st.live, ov: st.ov, ai: st.ai, ovErr: st.ovErr, ovBusy: false, plant: st.plant };   // frozen: live polls never repaint into it
    S.hist = { at: Math.floor(ms / 60000) * 60000 };
    S.sigs = {};
    renderChrome(); reloadDateStores(); paint();
  }
  function backToLive() {
    var was = !!S.hist;
    S.hist = null; S.histSt = null; S.sigs = {};
    renderChrome();
    if (was) {
      reloadDateStores(); loadNeeds(true);
      if (S.app && S.app.loadOverview) S.app.loadOverview();
      toast('Back to live data', 'success');
    }
    paint();
  }
  function openTimeTravel() { ensureModals(); if (window.KJModal) window.KJModal.open('dash-time', 'pick'); }

  /* ── state + DOM ──────────────────────────────────────────────────────── */
  var S = { el: null, root: null, grid: null, app: null, layout: [], editing: false, sigs: {}, charts: {}, anims: [], timer: null, saveT: null,
    polls: 0, warned: false, drag: null, docClick: null, docKey: null,
    dashes: [], cur: null, compat: false, ready: false, dirty: {}, filters: blankFilters(), hist: null, histSt: null, pendingTT: false };

  function widgetShell(it) {
    var w = WIDX[it.id], cols = parseInt(it.size.split('x')[1], 10) || 1, tall = (w.rows || 1) > 1;
    var sizes = w.sizes.slice().sort();
    var sizeBtns = function (cls) {
      return sizes.length > 1 ? sizes.map(function (s) {
        return '<button type="button" class="kj-dw-size' + (s === it.size ? ' is-on' : '') + (cls ? ' ' + cls : '') + '" data-dash-act="size" data-size="' + s + '" aria-pressed="' + (s === it.size) + '">' + s + '</button>';
      }).join('') : '';
    };
    return '<section class="kj-card kj-dw kj-dw-' + esc(w.id) + ' kj-dw-c' + cols + (tall ? ' kj-dw-r2' : '') + '" data-wid="' + esc(w.id) + '" role="listitem" aria-label="' + esc(w.title) + '">' +
      '<header class="kj-dw-head">' +
        '<button type="button" class="kj-dw-handle" data-dash-act="handle" aria-label="Move ' + esc(w.title) + ' (drag, or use arrow keys)" title="Drag to reorder">' + ico('grip-vertical') + '</button>' +
        '<span class="kj-dw-ico' + (w.tone ? ' is-' + w.tone : '') + '">' + ico(w.icon) + '</span>' +
        '<div class="kj-dw-titles"><h3 class="kj-dw-title">' + esc(w.title) + '<span class="kj-dw-tag" data-dw-tag hidden></span></h3>' + (w.sub ? '<p class="kj-dw-sub">' + esc(w.sub) + '</p>' : '') + '</div>' +
        (w.nav && cols > 1 ? '<button type="button" class="kj-dw-link"' + navAttr(w.nav.path) + '>' + esc(w.nav.label) + ico('arrow-right') + '</button>' : '') +
        '<button type="button" class="kj-dw-more" data-dash-act="menu" aria-haspopup="true" aria-expanded="false" aria-label="' + esc(w.title) + ' options">' + ico('ellipsis') + '</button>' +
        '<div class="kj-dw-menu" role="menu">' +
          (w.nav ? '<button type="button" class="kj-dw-menu-item" role="menuitem"' + navAttr(w.nav.path) + '>' + ico('external-link') + esc(w.nav.label) + '</button>' : '') +
          (sizes.length > 1 ? '<div class="kj-dw-menu-lbl">Size</div><div class="kj-dw-menu-sizes">' + sizeBtns() + '</div>' : '') +
          '<button type="button" class="kj-dw-menu-item" role="menuitem" data-dash-act="edit">' + ico('layout-dashboard') + 'Customise dashboard</button>' +
          '<button type="button" class="kj-dw-menu-item is-danger" role="menuitem" data-dash-act="remove">' + ico('trash-2') + 'Remove widget</button>' +
        '</div>' +
      '</header>' +
      '<div class="kj-dw-edit">' + sizeBtns() + '<span class="kj-spacer"></span><button type="button" class="kj-dw-remove" data-dash-act="remove">' + ico('x') + 'Remove</button></div>' +
      '<div class="kj-dw-body"></div></section>';
  }
  function ghostTile() {
    var left = WIDGETS.filter(function (w) { return allowedWidget(w) && !S.layout.some(function (x) { return x.id === w.id; }); }).length;
    return '<button type="button" class="kj-dash-ghost" data-dash-act="add" aria-label="Add widget">' + ico('plus') +
      '<span class="kj-dash-ghost-title">Add widget</span><span class="kj-dash-ghost-sub">' +
      (left ? left + ' more available — charts, KPIs and lists' : 'Every widget for your role is on the board') + '</span></button>';
  }
  function destroyCharts(id) {
    Object.keys(S.charts).forEach(function (k) {
      if (id && k !== id) return;
      try { S.charts[k].destroy(); } catch (e) { /* gone */ }
      delete S.charts[k];
    });
  }
  function destroyAnims() { S.anims.forEach(function (a) { try { a.destroy(); } catch (e) { /* gone */ } }); S.anims = []; }

  function buildGrid() {
    if (!S.grid) return;
    destroyCharts(); destroyAnims();
    S.sigs = {};
    S.grid.innerHTML = S.layout.map(widgetShell).join('') + ghostTile();
    if (!S.layout.length) {
      S.grid.insertAdjacentHTML('afterbegin', '<div class="kj-card kj-dw kj-dw-c3">' + emptyBox({ icon: 'layout-dashboard', title: 'Your dashboard is empty',
        text: 'Add widgets from the catalog, or reset to the default layout.', modal: ['dash-catalog', 'add', 'Browse widgets'] }) + '</div>');
      hydrateLottie(S.grid);
    }
    syncEditing();
    paint();
  }
  function paint() {
    if (!S.grid) return;
    var minute = S.hist ? 0 : Math.floor(Date.now() / 60000), fkey = JSON.stringify([S.filters, S.hist && S.hist.at]);
    S.layout.forEach(function (it) {
      var w = WIDX[it.id], host = S.grid.querySelector('[data-wid="' + it.id + '"] .kj-dw-body');
      if (!w || !host) return;
      var c = ctxFor(it); c.wid = it.id;
      var tagEl = host.parentNode && host.parentNode.querySelector('[data-dw-tag]'), tag = tagFor(w, c);
      if (tagEl) {
        tagEl.hidden = !tag;
        tagEl.className = 'kj-dw-tag' + (tag && tag.fixed ? ' is-fixed' : '');
        tagEl.textContent = tag ? tag.text : '';
        if (tag) tagEl.setAttribute('title', tag.title); else tagEl.removeAttribute('title');
      }
      var sig;
      try { sig = it.size + '|' + minute + '|' + fkey + '|' + w.sig(c); } catch (e) { sig = it.size + '|' + Math.random(); }
      if (S.sigs[it.id] === sig) return;
      S.sigs[it.id] = sig;
      destroyCharts(it.id);
      try { w.render(host, c); }
      catch (e) { host.innerHTML = emptyBox({ error: true, icon: 'cloud-off', title: 'This widget hit a problem', text: String(e && e.message || e), nav: w.nav }); }
      applyVars(host);
      hydrateLottie(host);
    });
    tickTimers();
    var up = S.root && S.root.querySelector('[data-dash-updated]');
    var st = (S.app && S.app.state) || {};
    if (up) up.textContent = S.hist ? 'Paused' : (st.ov && st.ov.generated_at ? 'Updated ' + String(st.ov.generated_at).slice(11, 16) : (st.ovBusy ? 'Loading…' : 'Live'));
  }
  function syncEditing() {
    if (!S.root) return;
    S.root.classList.toggle('is-editing', S.editing);
    Array.prototype.forEach.call(S.root.querySelectorAll('.kj-dw'), function (el) { el.setAttribute('draggable', S.editing ? 'true' : 'false'); });
    var b = S.root.querySelector('[data-dash-act="toggle-edit"]');
    if (b) b.setAttribute('aria-pressed', String(S.editing));
  }
  function setEditing(on) { S.editing = !!on; closeMenus(); syncEditing(); }
  function closeMenus(except) {
    if (!S.root) return;
    Array.prototype.forEach.call(S.root.querySelectorAll('.kj-dw.is-menu'), function (el) {
      if (el === except) return;
      el.classList.remove('is-menu');
      var b = el.querySelector('.kj-dw-more'); if (b) b.setAttribute('aria-expanded', 'false');
    });
  }

  function pageShell() {
    var plant = S.app && S.app.state && S.app.state.plant;
    return '<div class="kj-page kj-dash">' +
      '<div class="kj-page-head kj-dash-head"><div><h2 class="kj-page-title kj-dash-title">Dashboard</h2>' +
        '<p class="kj-page-sub">Real-time visibility across ' + (plant ? esc(plant) : 'your plant') + '</p></div>' +
        '<div class="kj-dash-actions">' +
          '<div class="kj-dsw" data-dsw hidden></div>' +
          '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm kj-dash-updated" data-dash-act="refresh" title="Refresh now"><span class="kj-dash-live"></span><span data-dash-updated>Loading…</span>' + ico('refresh-cw') + '</button>' +
          '<button type="button" class="kj-btn kj-btn-secondary"' + navAttr('dashboard/classic') + '>' + ico('layout-grid') + '<span>Classic view</span></button>' +
          '<button type="button" class="kj-btn kj-btn-primary kj-dash-edit-btn" data-dash-act="toggle-edit" aria-pressed="false">' + ico('pencil') + '<span>Edit dashboard</span></button>' +
        '</div></div>' +
      '<div class="kj-dash-hist" data-dash-hist role="status" hidden></div>' +
      '<div class="kj-dfb" data-dfb role="toolbar" aria-label="Dashboard filters"></div>' +
      '<div class="kj-dash-editbar" role="status">' + ico('move') + '<span>Customising — drag the grip to reorder, pick a size, remove or add widgets. Changes save automatically.</span>' +
        '<span class="kj-spacer"></span>' +
        '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-dash-act="add">' + ico('plus') + 'Add widget</button>' +
        '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-dash-act="reset">' + ico('rotate-ccw') + 'Reset to default</button>' +
        '<button type="button" class="kj-btn kj-btn-primary kj-btn-sm" data-dash-act="done">' + ico('check') + 'Done</button></div>' +
      '<div class="kj-dash-grid" role="list" aria-label="Dashboard widgets"></div></div>';
  }
  function renderChrome() { renderSwitcher(); renderFilterBar(); renderHist(); }

  /** Saved-dashboard switcher: tabs (≤4 on desktop; always horizontal-scroll chips ≤768px) or a dropdown beyond 4. */
  function renderSwitcher() {
    var box = S.root && S.root.querySelector('[data-dsw]');
    if (!box) return;
    if (S.compat || !S.dashes.length) { box.hidden = true; box.innerHTML = ''; return; }
    var cur = curDash() || {}, many = S.dashes.length > 4, full = S.dashes.length >= MAX_DASH;
    var star = function (d) { return d.is_default ? '<span class="kj-dsw-star" aria-label="Default">' + ico('star') + '</span>' : ''; };
    box.hidden = false;
    box.className = 'kj-dsw' + (many ? ' is-many' : '');
    box.innerHTML =
      '<div class="kj-dsw-tabs" role="tablist" aria-label="Saved dashboards">' + S.dashes.map(function (d) {
        var on = d.id === S.cur;
        return '<button type="button" class="kj-dsw-tab' + (on ? ' is-on' : '') + '" role="tab" aria-selected="' + on + '" tabindex="' + (on ? '0' : '-1') + '" data-dash-act="switch" data-did="' + d.id + '"' +
          ' title="' + esc(d.name + (d.is_default ? ' (default)' : '')) + '">' + star(d) + '<span class="kj-dsw-name">' + esc(d.name) + '</span></button>';
      }).join('') + '</div>' +
      '<div class="kj-dsw-wrap kj-dsw-drop">' +
        '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm kj-dsw-cur" data-dash-act="dsw-list" aria-haspopup="listbox" aria-expanded="false" aria-label="Switch dashboard (current: ' + esc(cur.name || '') + ')">' +
          star(cur) + '<span class="kj-dsw-name">' + esc(cur.name || 'Dashboard') + '</span>' + ico('chevron-down') + '</button>' +
        '<div class="kj-dsw-pop" data-pop="list" role="listbox" aria-label="Saved dashboards" hidden>' + S.dashes.map(function (d) {
          return '<button type="button" class="kj-dsw-opt' + (d.id === S.cur ? ' is-on' : '') + '" role="option" aria-selected="' + (d.id === S.cur) + '" data-dash-act="switch" data-did="' + d.id + '">' +
            '<span class="kj-dsw-check">' + (d.id === S.cur ? ico('check') : '') + '</span><span class="kj-dsw-name">' + esc(d.name) + '</span>' + star(d) + '</button>';
        }).join('') +
          '<button type="button" class="kj-dsw-opt is-new" role="option" aria-selected="false" data-dash-act="dsw-new"' + (full ? ' disabled' : '') + '>' + ico('plus') + '<span>New dashboard</span></button></div></div>' +
      '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm kj-btn-icon kj-dsw-add" data-dash-act="dsw-new" aria-label="New dashboard"' +
        (full ? ' disabled title="You have ' + MAX_DASH + ' dashboards — delete one to add another"' : ' title="New dashboard"') + '>' + ico('plus') + '</button>' +
      '<div class="kj-dsw-wrap">' +
        '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm kj-btn-icon kj-dsw-more" data-dash-act="dsw-menu" aria-haspopup="menu" aria-expanded="false" aria-label="Manage “' + esc(cur.name || '') + '”" title="Rename, duplicate, set default, delete">' + ico('ellipsis') + '</button>' +
        '<div class="kj-dsw-pop is-right" data-pop="menu" role="menu" aria-label="Manage dashboard" hidden>' +
          '<button type="button" class="kj-dw-menu-item" role="menuitem" data-dash-act="dsw-rename">' + ico('pencil') + 'Rename</button>' +
          '<button type="button" class="kj-dw-menu-item" role="menuitem" data-dash-act="dsw-dup"' + (full ? ' disabled' : '') + '>' + ico('copy') + 'Duplicate</button>' +
          '<button type="button" class="kj-dw-menu-item" role="menuitem" data-dash-act="dsw-default"' + (cur.is_default ? ' disabled' : '') + '>' + ico('star') + (cur.is_default ? 'Default dashboard' : 'Set as default') + '</button>' +
          '<button type="button" class="kj-dw-menu-item is-danger" role="menuitem" data-dash-act="dsw-delete"' + (S.dashes.length < 2 ? ' disabled title="Your only dashboard cannot be deleted"' : '') + '>' + ico('trash-2') + 'Delete</button>' +
        '</div></div>';
  }

  /** Filter bar: date range (+ custom dates, + date & time travel), plant, cameras, severity. */
  function renderFilterBar() {
    var bar = S.root && S.root.querySelector('[data-dfb]');
    if (!bar) return;
    var f = S.filters, plants = plantNames(), nCam = f.cams.length;
    var seg = function (act, key, opts, val) {
      return opts.map(function (o) {
        return '<button type="button" class="kj-tab" data-dash-act="' + act + '" data-' + key + '="' + o[0] + '" aria-pressed="' + (o[0] === val) + '"' + (o[2] ? ' title="' + esc(o[2]) + '"' : '') + '>' + esc(o[1]) + '</button>';
      }).join('');
    };
    bar.innerHTML =
      '<div class="kj-dfb-grp" role="group" aria-label="Date range"><span class="kj-dfb-ico">' + ico('calendar-range') + '</span>' +
        '<div class="kj-tabs kj-dfb-seg">' + seg('range', 'range', RANGES, f.range) + '</div>' +
        (f.range === 'custom' ? '<span class="kj-dfb-custom"><input type="date" class="kj-input kj-dfb-date" data-dash-f="from" aria-label="From date" value="' + esc(f.from || '') + '" max="' + today() + '">' +
          '<span class="kj-dfb-dash">–</span><input type="date" class="kj-input kj-dfb-date" data-dash-f="to" aria-label="To date" value="' + esc(f.to || '') + '" max="' + today() + '"></span>' : '') +
        '<button type="button" class="kj-btn kj-btn-sm ' + (S.hist ? 'kj-btn-primary' : 'kj-btn-secondary') + ' kj-dfb-tt" data-dash-act="time" title="Browse the dashboard as it was at a past date and time">' + ico('history') +
          '<span>' + (S.hist ? esc(momentLbl(S.hist.at)) : 'Date & time') + '</span></button></div>' +
      '<label class="kj-dfb-grp kj-dfb-plant"><span class="kj-dfb-ico">' + ico('factory') + '</span><span class="kj-sr-only">Plant</span>' +
        '<select class="kj-select kj-dfb-sel" data-dash-f="plant" aria-label="Plant"><option value="">All plants</option>' +
        plants.map(function (p) { return '<option value="' + esc(p) + '"' + (p === f.plant ? ' selected' : '') + '>' + esc(p) + '</option>'; }).join('') + '</select></label>' +
      '<div class="kj-dfb-grp kj-dsw-wrap kj-dfb-cams">' +
        '<button type="button" class="kj-btn kj-btn-sm ' + (nCam ? 'kj-btn-soft' : 'kj-btn-secondary') + '" data-dash-act="cams" aria-haspopup="true" aria-expanded="false">' + ico('cctv') +
          '<span>' + (nCam ? nCam + ' camera' + (nCam === 1 ? '' : 's') : 'All cameras') + '</span>' + ico('chevron-down') + '</button>' +
        '<div class="kj-dsw-pop kj-dfb-pop" data-pop="cams" role="group" aria-label="Filter cameras" hidden></div></div>' +
      '<div class="kj-dfb-grp" role="group" aria-label="Severity"><div class="kj-tabs kj-dfb-seg">' +
        seg('sev', 'sev', [['all', 'All severities', ''], ['high', 'High + critical', 'Only high and critical detections']], f.sev) + '</div></div>' +
      (f.range !== 'auto' || nCam || f.sev !== 'all' ? '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm kj-dfb-clear" data-dash-act="clear-filters">' + ico('x') + 'Clear filters</button>' : '');
  }
  function renderCamPop(pop) {
    var opts = camOptions(), sel = {};
    S.filters.cams.forEach(function (c) { sel[c.toLowerCase()] = 1; });
    pop.innerHTML = '<div class="kj-dfb-pophead"><b>Cameras</b><span class="kj-spacer"></span>' +
        '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-dash-act="cams-clear">All cameras</button></div>' +
      (opts.length ? '<div class="kj-dfb-camlist">' + opts.map(function (o) {
        return '<label class="kj-dfb-cam"><input type="checkbox" data-dash-cam="' + esc(o.id) + '"' + (sel[o.id.toLowerCase()] ? ' checked' : '') + '>' +
          '<span class="kj-dash-dot' + (o.online ? '' : ' is-danger') + '"></span><span class="kj-dwx-ell">' + esc(o.name) + '</span><small>' + esc(o.gone ? 'not reporting' : o.id) + '</small></label>';
      }).join('') + '</div>' : '<p class="kj-dfb-none">No cameras are reporting yet.</p>') +
      '<p class="kj-dfb-hint">Applies to Live alerts, Heatmap, Top cameras, Unknown faces and Fire &amp; safety.</p>';
  }
  function renderHist() {
    var el = S.root && S.root.querySelector('[data-dash-hist]');
    if (S.root) S.root.classList.toggle('is-hist', !!S.hist);
    if (!el) return;
    el.hidden = !S.hist;
    el.innerHTML = S.hist ? '<span class="kj-dash-hist-ico">' + ico('history') + '</span><span class="kj-dash-hist-txt">Viewing <b>' + esc(momentLbl(S.hist.at)) + '</b>' +
        '<small>Historical mode — live updates are paused; widgets that only show live data are marked “Live only”.</small></span><span class="kj-spacer"></span>' +
      '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-dash-act="time">' + ico('calendar-clock') + 'Change</button>' +
      '<button type="button" class="kj-btn kj-btn-primary kj-btn-sm" data-dash-act="live">' + ico('radio') + 'Back to live</button>' : '';
  }
  function closePops(except) {
    if (!S.root) return;
    Array.prototype.forEach.call(S.root.querySelectorAll('[data-pop]:not([hidden])'), function (p) {
      if (p === except) return;
      p.hidden = true;
      var b = p.parentNode && p.parentNode.querySelector('[aria-expanded]'); if (b) b.setAttribute('aria-expanded', 'false');
    });
  }
  function togglePop(btn, name) {
    var pop = btn.parentNode && btn.parentNode.querySelector('[data-pop="' + name + '"]');
    if (!pop) return;
    var open = pop.hidden;
    closePops(pop); closeMenus();
    if (open && name === 'cams') renderCamPop(pop);
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) { var f = pop.querySelector('.is-on, input, button:not([disabled])'); if (f && f.focus) f.focus(); }
  }

  /* ── events ───────────────────────────────────────────────────────────── */
  function widOf(el) { var w = el && el.closest('[data-wid]'); return w ? w.getAttribute('data-wid') : ''; }
  function onClick(ev) {
    var nt = ev.target.closest('[data-dash-notif]');
    if (nt && S.root.contains(nt) && nt.classList.contains('is-unread')) markNotifs([N(nt.getAttribute('data-dash-notif'))]);
    var a = ev.target.closest('[data-dash-act]');
    if (!ev.target.closest('[data-pop]') && !(a && /^(dsw-list|dsw-menu|cams)$/.test(a.getAttribute('data-dash-act')))) closePops();
    if (!a || !S.root.contains(a)) { if (!ev.target.closest('.kj-dw-menu')) closeMenus(); return; }
    var act = a.getAttribute('data-dash-act'), id = widOf(a), card = a.closest('.kj-dw');
    if (a.disabled) return;
    ev.preventDefault();
    var cur = curDash();
    switch (act) {
      case 'switch': switchTo(a.getAttribute('data-did')); break;
      case 'dsw-list': togglePop(a, 'list'); break;
      case 'dsw-menu': togglePop(a, 'menu'); break;
      case 'dsw-new': closePops(); openNameDialog('new'); break;
      case 'dsw-rename': closePops(); openNameDialog('rename'); break;
      case 'dsw-dup': closePops(); openNameDialog('dup'); break;
      case 'dsw-default': closePops(); if (cur) makeDefault(cur.id); break;
      case 'dsw-delete': closePops(); if (cur && window.KJModal) { ensureModals(); window.KJModal.open('dash-delete', String(cur.id), { name: cur.name }); } break;
      case 'range': setFilters(a.getAttribute('data-range') === 'custom' && S.filters.range !== 'custom'
        ? { range: 'custom', from: S.filters.from || daysAgo(6), to: S.filters.to || today() } : { range: a.getAttribute('data-range') }); break;
      case 'sev': setFilters({ sev: a.getAttribute('data-sev') }); break;
      case 'cams': togglePop(a, 'cams'); break;
      case 'cams-clear': setFilters({ cams: [] }); break;
      case 'clear-filters': setFilters({ range: 'auto', from: null, to: null, cams: [], sev: 'all' }); break;
      case 'time': openTimeTravel(); break;
      case 'live': backToLive(); break;
      case 'toggle-edit': setEditing(!S.editing); break;
      case 'done': setEditing(false); toast('Dashboard saved', 'success'); break;
      case 'edit': setEditing(true); break;
      case 'reset': resetLayout(); break;
      case 'refresh': refreshAll(); break;
      case 'notif-all': markNotifs(null); break;
      case 'add': ensureModals(); if (window.KJModal) window.KJModal.open('dash-catalog', 'add'); break;
      case 'remove': removeWidget(id); break;
      case 'size': resizeWidget(id, a.getAttribute('data-size')); break;
      case 'menu': {
        var open = !card.classList.contains('is-menu');
        closeMenus(card);
        card.classList.toggle('is-menu', open);
        a.setAttribute('aria-expanded', String(open));
        if (open) { var f = card.querySelector('.kj-dw-menu .kj-dw-menu-item, .kj-dw-menu .kj-dw-size'); if (f) f.focus(); }
        break;
      }
      case 'handle': if (!S.editing) setEditing(true); break;
    }
  }
  function onChange(ev) {
    var t = ev.target, k = t.getAttribute && t.getAttribute('data-dash-f');
    if (k === 'plant') setFilters({ plant: t.value });
    else if (k === 'from' || k === 'to') {
      if (!isDay(t.value)) return;
      var p = { range: 'custom', from: S.filters.from || t.value, to: S.filters.to || t.value }; p[k] = t.value;
      setFilters(p);
    } else if (t.hasAttribute && t.hasAttribute('data-dash-cam')) {
      var id = t.getAttribute('data-dash-cam'), cams = S.filters.cams.filter(function (c) { return c.toLowerCase() !== id.toLowerCase(); });
      if (t.checked) cams.push(id);
      var pop = t.closest('[data-pop]');
      setFilters({ cams: cams });   // re-renders the bar; keep the picker open with focus on this camera
      var btn = S.root.querySelector('[data-dash-act="cams"]');
      if (pop && btn) { togglePop(btn, 'cams'); var again = S.root.querySelector('[data-dash-cam="' + id.replace(/"/g, '') + '"]'); if (again) again.focus(); }
    }
  }
  /** Arrow keys inside the switcher tabs (roving focus) and inside open pop-up menus / lists. */
  function moveFocus(list, cur, key) {
    var i = list.indexOf(cur), n = list.length; if (!n) return;
    var j = key === 'Home' ? 0 : key === 'End' ? n - 1 : (key === 'ArrowLeft' || key === 'ArrowUp') ? (i - 1 + n) % n : (i + 1) % n;
    list[j].focus();
  }
  function onKey(ev) {
    var openPop = S.root.querySelector('[data-pop]:not([hidden])');
    if (ev.key === 'Escape' && openPop) {
      var trig = openPop.parentNode && openPop.parentNode.querySelector('[aria-expanded]');
      closePops(); if (trig) trig.focus(); ev.stopPropagation(); return;
    }
    if (/^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End)$/.test(ev.key)) {
      var tab = ev.target.closest && ev.target.closest('.kj-dsw-tab');
      if (tab) { ev.preventDefault(); moveFocus(Array.prototype.slice.call(S.root.querySelectorAll('.kj-dsw-tab')), tab, ev.key); return; }
      var inPop = ev.target.closest && ev.target.closest('[data-pop]');
      if (inPop && ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') {
        ev.preventDefault();
        moveFocus(Array.prototype.slice.call(inPop.querySelectorAll('button:not([disabled]), input')), ev.target, ev.key); return;
      }
    }
    if (ev.key === 'Escape') { if (S.root.querySelector('.kj-dw.is-menu')) { closeMenus(); ev.stopPropagation(); } return; }
    var h = ev.target.closest && ev.target.closest('.kj-dw-handle');
    if (!h) return;
    var id = widOf(h), i = S.layout.findIndex(function (x) { return x.id === id; });
    var k = ev.key;
    if (k === 'ArrowLeft' || k === 'ArrowUp') { ev.preventDefault(); moveWidget(id, i - 1); }
    else if (k === 'ArrowRight' || k === 'ArrowDown') { ev.preventDefault(); moveWidget(id, i + 1); }
    else if (k === 'Home') { ev.preventDefault(); moveWidget(id, 0); }
    else if (k === 'End') { ev.preventDefault(); moveWidget(id, S.layout.length - 1); }
  }
  // HTML5 drag-and-drop (customise mode; whole card draggable, grip is the affordance)
  function clearDropMarks() { Array.prototype.forEach.call(S.grid.querySelectorAll('.is-drop-before, .is-drop-after'), function (el) { el.classList.remove('is-drop-before', 'is-drop-after'); }); }
  function dropSide(card, ev) { var r = card.getBoundingClientRect(); return (ev.clientX - r.left) > r.width / 2 ? 'after' : 'before'; }
  function onDragStart(ev) {
    var card = ev.target.closest && ev.target.closest('.kj-dw');
    if (!S.editing || !card) { return; }
    S.drag = card.getAttribute('data-wid');
    card.classList.add('is-dragging');
    try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', S.drag); } catch (e) { /* old browsers */ }
  }
  function onDragOver(ev) {
    if (!S.drag) return;
    var card = ev.target.closest && ev.target.closest('.kj-dw');
    var ghost = ev.target.closest && ev.target.closest('.kj-dash-ghost');
    if (!card && !ghost) return;
    ev.preventDefault();
    try { ev.dataTransfer.dropEffect = 'move'; } catch (e) { /* ignore */ }
    clearDropMarks();
    if (card && card.getAttribute('data-wid') !== S.drag) card.classList.add(dropSide(card, ev) === 'after' ? 'is-drop-after' : 'is-drop-before');
  }
  function onDrop(ev) {
    if (!S.drag) return;
    ev.preventDefault();
    var card = ev.target.closest && ev.target.closest('.kj-dw'), id = S.drag;
    var order = S.layout.map(function (x) { return x.id; }).filter(function (x) { return x !== id; });
    var to = order.length;
    if (card && card.getAttribute('data-wid') && card.getAttribute('data-wid') !== id) {
      to = order.indexOf(card.getAttribute('data-wid')) + (dropSide(card, ev) === 'after' ? 1 : 0);
    } else if (card) { onDragEnd(); return; }
    order.splice(to, 0, id);
    onDragEnd();
    setLayout(order.map(function (x) { return S.layout.find(function (y) { return y.id === x; }); }));
  }
  function onDragEnd() {
    S.drag = null;
    if (!S.grid) return;
    clearDropMarks();
    Array.prototype.forEach.call(S.grid.querySelectorAll('.is-dragging'), function (el) { el.classList.remove('is-dragging'); });
  }

  function refreshAll() {
    if (S.app && S.app.loadOverview) S.app.loadOverview();
    loadNeeds(true);
  }

  /* ── KJModal types owned by this page ─────────────────────────────────── */
  var modalsDone = false;
  function ensureModals() {
    if (modalsDone || !window.KJModal || !window.KJModal.register) return;
    modalsDone = true;
    var M = window.KJModal, h = M.h;
    function appState() { var a = window.KJApp || S.app; return (a && a.state) || {}; }
    function navBtn(path, label, icon, primary) { return '<button type="button" class="kj-btn ' + (primary ? 'kj-btn-primary' : 'kj-btn-secondary') + '"' + navAttr(path) + '>' + ico(icon || 'external-link') + esc(label) + '</button>'; }

    // Widget catalog: RBAC-filtered, add from here.
    M.register('dash-catalog', {
      kicker: 'Dashboard', icon: 'layout-dashboard', size: 'lg', deepLink: false,
      load: function () { return Promise.resolve({}); },
      render: function () {
        var list = WIDGETS.filter(allowedWidget);
        return {
          title: 'Add a widget', kicker: 'Widget catalog', icon: 'layout-dashboard',
          body: '<p class="kj-text-2">Widgets are filtered by your role. Each one can be resized and dragged once it is on the board.</p>' +
            '<div class="kj-dash-cat">' + list.map(function (w) {
              var on = S.layout.some(function (x) { return x.id === w.id; });
              return '<div class="kj-dash-cat-item' + (on ? ' is-on' : '') + '"><span class="kj-dw-ico' + (w.tone ? ' is-' + w.tone : '') + '">' + ico(w.icon) + '</span>' +
                '<div class="kj-dash-cat-main"><div class="kj-dash-cat-title">' + esc(w.title) + '</div><div class="kj-dash-cat-sub">' + esc(w.desc || w.sub || '') + '</div>' +
                '<div class="kj-dash-cat-sizes">' + w.sizes.slice().sort().map(function (s) { return '<span>' + s + '</span>'; }).join('') + '</div></div>' +
                (on ? '<span class="kj-chip is-success kj-chip-dot">On board</span>'
                  : '<button type="button" class="kj-btn kj-btn-primary kj-btn-sm" data-kj-action="add" data-wid="' + esc(w.id) + '">' + ico('plus') + 'Add</button>') + '</div>';
            }).join('') + '</div>',
          foot: '<button type="button" class="kj-btn kj-btn-ghost" data-kj-action="reset">' + ico('rotate-ccw') + 'Reset to default</button>' +
            '<button type="button" class="kj-btn kj-btn-secondary" data-kj-action="custom">' + ico('move') + 'Arrange widgets</button>',
          actions: {
            add: function (ctx, el) { addWidget(el.getAttribute('data-wid')); ctx.reload(); },
            reset: function (ctx) { resetLayout(); ctx.close(); },
            custom: function (ctx) { ctx.close(); setEditing(true); }
          }
        };
      }
    });

    // Saved dashboards: new / duplicate / rename (one name dialog).
    M.register('dash-name', {
      kicker: 'Dashboards', icon: 'layout-dashboard', size: 'sm', deepLink: false,
      load: function (ctx) { return Promise.resolve(ctx.data || {}); },
      render: function (ctx, d) {
        var mode = d.mode || 'new', cur = curDash() || { name: 'Dashboard' };
        var val = mode === 'rename' ? cur.name : mode === 'dup' ? uniqueName(cur.name + ' copy') : uniqueName('New dashboard');
        var title = mode === 'rename' ? 'Rename dashboard' : mode === 'dup' ? 'Duplicate “' + cur.name + '”' : 'New dashboard';
        return {
          title: title, kicker: 'Saved dashboards', icon: mode === 'rename' ? 'pencil' : mode === 'dup' ? 'copy' : 'layout-dashboard',
          body: '<div class="kj-dnd"><label class="kj-field" data-dash-field><span class="kj-label">Name</span>' +
              '<input type="text" class="kj-input" data-dash-name maxlength="60" autocomplete="off" value="' + esc(val) + '">' +
              '<span class="kj-help" data-dash-err hidden></span></label>' +
            (mode === 'new' ? '<fieldset class="kj-dnd-start"><legend class="kj-label">Start with</legend>' +
              '<label class="kj-dnd-opt"><input type="radio" name="kj-dash-start" value="empty" checked><span class="kj-dwx-well is-info">' + ico('square-dashed') + '</span><span><b>An empty board</b><small>Add widgets from the catalog</small></span></label>' +
              '<label class="kj-dnd-opt"><input type="radio" name="kj-dash-start" value="copy"><span class="kj-dwx-well">' + ico('copy') + '</span><span><b>A copy of “' + esc(cur.name) + '”</b><small>Same widgets and filters</small></span></label></fieldset>'
              : (mode === 'dup' ? '<p class="kj-text-2">Copies the widgets, sizes and filters of “' + esc(cur.name) + '”.</p>' : '')) + '</div>',
          foot: '<button type="button" class="kj-btn kj-btn-ghost" data-kj-close>Cancel</button>' +
            '<button type="button" class="kj-btn kj-btn-primary" data-kj-action="go">' + ico(mode === 'rename' ? 'check' : 'plus') + (mode === 'rename' ? 'Save name' : 'Create dashboard') + '</button>',
          mount: function (c) {
            var inp = c.body.querySelector('[data-dash-name]');
            if (inp) {
              setTimeout(function () { try { inp.focus(); inp.select(); } catch (e) { /* jsdom */ } }, 40);
              inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); c.actions.go(c); } });
            }
          },
          actions: {
            go: function (c) {
              var inp = c.body.querySelector('[data-dash-name]'), err = c.body.querySelector('[data-dash-err]'), field = c.body.querySelector('[data-dash-field]');
              var btn = c.foot.querySelector('[data-kj-action="go"]'), name = cleanName(inp && inp.value);
              var fail = function (m) { field.classList.add('is-error'); err.textContent = m; err.hidden = false; if (btn) btn.disabled = false; if (inp) inp.focus(); };
              if (!name) return fail('Give the dashboard a name.');
              if (S.dashes.some(function (x) { return x.name.toLowerCase() === name.toLowerCase() && !(mode === 'rename' && x.id === cur.id); })) return fail('You already have a dashboard called “' + name + '”.');
              if (mode === 'rename' && name === cur.name) { c.close(); return; }
              if (btn) btn.disabled = true;
              var copy = mode === 'dup' || (mode === 'new' && !!c.body.querySelector('input[name="kj-dash-start"][value="copy"]:checked'));
              (mode === 'rename' ? renameDash(cur.id, name) : createDash(name, copy ? cur.id : null))
                .then(function () { c.close(); })
                .catch(function (e) { fail((e && e.message) || 'Could not save — try again.'); });
            }
          }
        };
      }
    });

    // Delete a saved dashboard (never the last one — the menu item is disabled and the server refuses).
    M.register('dash-delete', {
      kicker: 'Dashboards', icon: 'trash-2', size: 'sm', deepLink: false,
      load: function (ctx) { return Promise.resolve(dashById(ctx.id) || ctx.data || {}); },
      render: function (ctx, d) {
        return {
          title: 'Delete “' + (d.name || 'dashboard') + '”?', kicker: 'Saved dashboards', icon: 'trash-2', tone: 'danger',
          body: '<p>Its widgets, sizes and filters are removed for good. Your other dashboards are not affected.</p>' +
            (d.is_default ? '<p class="kj-text-2">This is your default dashboard — the next one in your list becomes the default.</p>' : '') +
            '<p class="kj-help kj-dnd-err" data-dash-err hidden></p>',
          foot: '<button type="button" class="kj-btn kj-btn-ghost" data-kj-close>Keep it</button>' +
            '<button type="button" class="kj-btn kj-btn-danger" data-kj-action="go">' + ico('trash-2') + 'Delete dashboard</button>',
          actions: {
            go: function (c) {
              var btn = c.foot.querySelector('[data-kj-action="go"]'), err = c.body.querySelector('[data-dash-err]');
              if (btn) btn.disabled = true;
              deleteDash(ctx.id).then(function () { c.close(); }).catch(function (e) {
                if (btn) btn.disabled = false; err.textContent = (e && e.message) || 'Could not delete — try again.'; err.hidden = false;
              });
            }
          }
        };
      }
    });

    // Time travel: browse the dashboard as it was at a past date + time (session only, never saved).
    M.register('dash-time', {
      kicker: 'Dashboard', icon: 'history', size: 'sm', deepLink: false,
      load: function () { return Promise.resolve({}); },
      render: function () {
        var at = S.hist ? S.hist.at : Date.now() - 3600000, d0 = new Date(at);
        var t0 = new Date(); t0.setHours(8, 0, 0, 0);
        var quick = [['1 hour ago', Date.now() - 3600000], ['Today 08:00', t0.getTime() < Date.now() ? t0.getTime() : t0.getTime() - 86400000],
          ['Yesterday, this time', Date.now() - 86400000], ['7 days ago', Date.now() - 7 * 86400000]];
        var setInputs = function (c, ms) {
          var x = new Date(ms);
          c.body.querySelector('[data-tt="date"]').value = ymd(x);
          c.body.querySelector('[data-tt="time"]').value = pad(x.getHours()) + ':' + pad(x.getMinutes());
        };
        return {
          title: 'View a past moment', kicker: 'Date & time', icon: 'history',
          body: '<div class="kj-dtt"><div class="kj-dtt-row">' +
              '<label class="kj-field" data-tt-field><span class="kj-label">Date</span><input type="date" class="kj-input" data-tt="date" max="' + today() + '" value="' + ymd(d0) + '"></label>' +
              '<label class="kj-field"><span class="kj-label">Time</span><input type="time" class="kj-input" data-tt="time" step="60" value="' + pad(d0.getHours()) + ':' + pad(d0.getMinutes()) + '"></label></div>' +
            '<div class="kj-dtt-quick" role="group" aria-label="Quick picks">' + quick.map(function (q) {
              return '<button type="button" class="kj-chip" data-kj-action="quick" data-ms="' + q[1] + '">' + ico('clock') + esc(q[0]) + '</button>';
            }).join('') + '</div>' +
            '<p class="kj-help" data-tt-err hidden></p>' +
            '<p class="kj-text-2 kj-dtt-note">' + ico('info') + 'Date-aware widgets show data up to this moment and live updates pause. Time travel lasts for this session only — it is not saved with the dashboard.</p></div>',
          foot: (S.hist ? '<button type="button" class="kj-btn kj-btn-ghost" data-kj-action="live">' + ico('radio') + 'Back to live</button>' : '') +
            '<button type="button" class="kj-btn kj-btn-ghost" data-kj-close>Cancel</button>' +
            '<button type="button" class="kj-btn kj-btn-primary" data-kj-action="go">' + ico('history') + 'View this moment</button>',
          mount: function (c) { var i = c.body.querySelector('[data-tt="date"]'); setTimeout(function () { try { i.focus(); } catch (e) { /* jsdom */ } }, 40); },
          actions: {
            quick: function (c, el) { setInputs(c, N(el.getAttribute('data-ms'))); },
            live: function (c) { backToLive(); c.close(); },
            go: function (c) {
              var dv = c.body.querySelector('[data-tt="date"]').value, tv = c.body.querySelector('[data-tt="time"]').value || '00:00';
              var err = c.body.querySelector('[data-tt-err]'), m = /^(\d{1,2}):(\d{2})/.exec(tv);
              var fail = function (msg) { err.textContent = msg; err.hidden = false; c.body.querySelector('[data-tt-field]').classList.add('is-error'); };
              if (!isDay(dv) || !m) return fail('Pick a valid date and time.');
              var ms = dayMs(dv) + (N(m[1]) * 60 + N(m[2])) * 60000;
              if (ms > Date.now()) return fail('That moment is in the future — pick a past date and time.');
              setHist(ms);
              c.close();
            }
          }
        };
      }
    });

    // Camera availability: every camera → camera modal.
    M.register('dash-cameras', {
      kicker: 'Cameras', icon: 'cctv', size: 'md', deepLink: true,
      load: function () { return Promise.resolve(camStats(appState())); },
      render: function (ctx, s) {
        var rows = s.fleet.slice().sort(function (a, b) { return (a.online ? 1 : 0) - (b.online ? 1 : 0); });
        return {
          title: s.online + ' of ' + s.total + ' cameras online', kicker: 'Camera uptime', icon: 'cctv', tone: s.online === s.total ? 'success' : 'warn',
          body: rows.length ? '<div class="kj-card"><div class="kj-list">' + rows.map(function (f) {
            var id = f.stream || f.serial || f.name;
            return '<button type="button" class="kj-list-item"' + modalAttr('camera', id) + '><span class="kj-dash-modico ' + (f.online ? 'is-info' : 'is-warn') + '">' + ico(f.online ? 'video' : 'video-off') + '</span>' +
              '<span class="kj-list-main"><span class="kj-list-title">' + esc(f.name || id) + '</span><span class="kj-list-sub">' + esc([f.stream, f.serial].filter(Boolean).join(' · ')) + '</span></span>' +
              h.chip(f.online ? 'Online' : 'Offline', f.online ? 'success' : 'danger', true) + '</button>';
          }).join('') + '</div></div>' : h.empty('cctv', 'No cameras reporting', 'Cameras with a live source appear here.'),
          foot: navBtn('cameras/manage', 'Manage cameras', 'settings-2') + navBtn('cameras/wall', 'Open camera wall', 'monitor-play', true)
        };
      }
    });

    // Pending leave approvals → leave modal per request.
    M.register('dash-leaves', {
      kicker: 'Leave', icon: 'calendar-check', size: 'md', deepLink: true,
      load: function () { return LOADERS.leaves(); },
      render: function (ctx, v) {
        return {
          title: v.total + ' pending leave request' + (v.total === 1 ? '' : 's'), kicker: 'Leave approvals', icon: 'calendar-check',
          body: v.rows.length ? '<div class="kj-card"><div class="kj-list">' + v.rows.map(function (l) {
            return '<button type="button" class="kj-list-item"' + modalAttr('leave', l.id, l) + '><span class="kj-avatar">' + esc(initials(l.user_name)) + '</span>' +
              '<span class="kj-list-main"><span class="kj-list-title">' + esc(l.user_name) + ' · ' + esc(l.leave_type_name || l.leave_type) + '</span>' +
              '<span class="kj-list-sub">' + esc(l.start_date + (l.end_date && l.end_date !== l.start_date ? ' → ' + l.end_date : '') + ' · ' + N(l.days) + ' day' + (N(l.days) === 1 ? '' : 's') + (l.department ? ' · ' + l.department : '')) + '</span></span>' +
              h.chip('Pending', 'warn', true) + '</button>';
          }).join('') + '</div></div>' : h.empty('circle-check', 'Nothing waiting', 'New requests from your team appear here.'),
          foot: navBtn('attendance', 'Open attendance', 'calendar-days', true)
        };
      }
    });

    // Claude AI summary (full text + category drill-downs).
    M.register('dash-ai', {
      kicker: 'AI summary', icon: 'sparkles', size: 'md', deepLink: true,
      load: function () { var a = appState().ai; if (!a || !a.summary) throw new Error('The AI summary is not available yet'); return Promise.resolve(a); },
      render: function (ctx, a) {
        var cats = a.by_category && typeof a.by_category === 'object' ? Object.keys(a.by_category) : [];
        return {
          title: 'AI daily summary', kicker: 'AI summary · ' + (a.fetched_at ? h.fmtTime ? h.fmtTime(a.fetched_at) : a.fetched_at : 'latest'), icon: 'sparkles', tone: 'purple',
          body: '<div class="kj-card"><div class="kj-dash-ai-text">' + esc(a.summary) + '</div></div>' +
            (cats.length ? h.section('Detections by category (7 days)', '<div class="kj-card"><div class="kj-list">' + cats.map(function (k) {
              return '<button type="button" class="kj-list-item"' + (STAT_OF[k] ? modalAttr('stat', STAT_OF[k]) : navAttr(MOD_HUB[k] || 'detections')) + '><span class="kj-dash-modico is-info">' + ico(MOD_ICON[k] || 'scan-eye') + '</span>' +
                '<span class="kj-list-main"><span class="kj-list-title">' + esc(cap(LABEL_OF[k] || k)) + '</span></span><b>' + fmtN(a.by_category[k]) + '</b></button>';
            }).join('') + '</div></div>') : ''),
          foot: navBtn('analytics', 'Analytics', 'chart-line') + navBtn('analytics/forecast', 'Open forecast', 'sparkles', true)
        };
      }
    });

    // AI performance: per-module precision / recall, recent verdicts → event.
    M.register('dash-accuracy', {
      kicker: 'AI performance', icon: 'crosshair', size: 'lg', skeleton: 'table', deepLink: true,
      load: function () { return LOADERS.aip(); },
      render: function (ctx, v) {
        var o = v.overall || {}, mods = v.modules || [], rec = (v.recent || []).slice(0, 10), q = (v.queue || []).slice(0, 8);
        var pct = function (x) { return x == null ? '—' : N(x).toFixed(1) + '%'; };
        var evRow = function (r, tag) {
          return '<button type="button" class="kj-list-item"' + modalAttr('event', r.uuid, { title: r.title, camera: r.camera, time: r.time, image: r.image, mod: r.module }) + '>' +
            (r.image ? '<img class="kj-thumb" src="' + esc(r.image) + '" alt="" loading="lazy">' : '<span class="kj-dash-modico is-info">' + ico(MOD_ICON[r.module] || 'scan-eye') + '</span>') +
            '<span class="kj-list-main"><span class="kj-list-title">' + esc(r.title || r.label) + '</span><span class="kj-list-sub">' + esc([r.label, r.camera, r.time].filter(Boolean).join(' · ')) + '</span></span>' + tag + '</button>';
        };
        return {
          title: 'Detection accuracy · ' + pct(o.precision), kicker: 'AI performance · ' + esc(v.from || '') + ' → ' + esc(v.to || ''), icon: 'crosshair',
          body: '<div class="kj-grid-3">' + h.statTile('crosshair', pct(o.precision), 'Precision') + h.statTile('radar', pct(o.recall), 'Recall') + h.statTile('sigma', pct(o.f1), 'F1 score') + '</div>' +
            h.section('By module', mods.length ? '<div class="kj-card"><div class="kj-list">' + mods.map(function (m) {
              return '<button type="button" class="kj-list-item"' + navAttr(MOD_HUB[m.module] || 'detections') + '><span class="kj-dash-modico is-info">' + ico(MOD_ICON[m.module] || 'scan-eye') + '</span>' +
                '<span class="kj-list-main"><span class="kj-list-title">' + esc(m.label || m.module) + '</span><span class="kj-list-sub">Precision ' + pct(m.precision) + ' · Recall ' + pct(m.recall) + ' · ' + fmtN(m.det || 0) + ' detections</span></span>' + ico('chevron-right') + '</button>';
            }).join('') + '</div></div>' : h.empty('crosshair', 'No module data', '')) +
            (q.length ? h.section('Needs review', '<div class="kj-card"><div class="kj-list">' + q.map(function (r) { return evRow(r, h.chip('Unreviewed', 'warn')); }).join('') + '</div></div>') : '') +
            (rec.length ? h.section('Latest verdicts', '<div class="kj-card"><div class="kj-list">' + rec.map(function (r) { return evRow(r, h.chip(r.verdict === 'correct' || r.verdict === 'tp' ? 'Correct' : 'Wrong', r.verdict === 'correct' || r.verdict === 'tp' ? 'success' : 'danger')); }).join('') + '</div></div>') : ''),
          foot: navBtn('analytics', 'Open analytics', 'chart-line', true)
        };
      }
    });
  }
  function openNameDialog(mode) {
    if (!curDash()) return;
    if (mode !== 'rename' && S.dashes.length >= MAX_DASH) { toast('You can keep up to ' + MAX_DASH + ' dashboards — delete one first.', 'warn'); return; }
    ensureModals();
    if (window.KJModal) window.KJModal.open('dash-name', mode, { mode: mode });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureModals);
  else setTimeout(ensureModals, 0);

  /* ── public hook: the top-bar date box opens time travel (window.KJDash) ── */
  window.KJDash = {
    /** Open the date & time picker; from another page, go to the dashboard first. */
    openTimeTravel: function () {
      if (S.root) { openTimeTravel(); return; }
      S.pendingTT = true;
      try { location.hash = '#dashboard'; } catch (e) { /* ignore */ }
    },
    backToLive: function () { if (S.hist) backToLive(); },
    isHistorical: function () { return !!S.hist; },
    moment: function () { return S.hist ? S.hist.at : null; }
  };

  /* ── page module ──────────────────────────────────────────────────────── */
  window.KJPages.register('dashboard', {
    title: 'Dashboard',
    perm: 'view',
    defaultSub: 'overview',
    subs: {
      // Widget grid (host-mounted). Owns the legacy #overview / #aiperf hashes and setPage('overview').
      overview: { label: 'Dashboard', aliases: ['overview', 'aiperf'] },
      // The previous dc-template overview, kept reachable (Classic view button) — nothing lost.
      classic: { label: 'Classic overview', legacy: 'overview', hidden: true }
    },

    // Legacy applyPage side effects (classic sub renders the dc template's overview).
    enter: function (app, page) {
      if (page === 'overview') app.loadOverview();
    },

    mount: function (el, route, app) {
      ensureCss();
      ensureModals();
      S.el = el; S.app = app; S.editing = false; S.warned = false; S.sigs = {}; S.ready = false;
      // Paint instantly from the device copy (last-open dashboard), then let the server listing win.
      var lc = readList(), last = readLast();
      if (lc) {
        S.compat = false;
        S.dashes = lc.dashes.map(function (d) { return Object.assign({}, d, { filters: normFilters(d.filters) }); });
        var d0 = dashById(last) || defaultDash();
        S.cur = d0.id; S.filters = normFilters(d0.filters);
        S.layout = d0.widgets ? normalise(d0.widgets) : defaultLayout();
      } else {
        S.dashes = []; S.cur = null; S.filters = blankFilters();
        S.layout = readCache() || defaultLayout();
      }
      el.innerHTML = pageShell();
      S.root = el.querySelector('.kj-dash');
      S.grid = el.querySelector('.kj-dash-grid');
      renderChrome();
      S.root.addEventListener('click', onClick);
      S.root.addEventListener('keydown', onKey);
      S.root.addEventListener('change', onChange);
      S.grid.addEventListener('dragstart', onDragStart);
      S.grid.addEventListener('dragover', onDragOver);
      S.grid.addEventListener('drop', onDrop);
      S.grid.addEventListener('dragend', onDragEnd);
      S.docClick = function (ev) { if (S.root && !S.root.contains(ev.target)) closeMenus(); };
      document.addEventListener('click', S.docClick);
      buildGrid();
      // Server copy wins over the device cache. Multi-dashboard server: open the last-open
      // dashboard (else the default). A pre-presets device layout that never reached the
      // server is pushed into a default dashboard that still has the role default. Older
      // server / offline (no /dashboard/list): compat mode on the legacy /dashboard/layout alias.
      var cached = readCache();
      apiGet('/dashboard/list').then(function (d) {
        if (S.el !== el) return;
        if (!Array.isArray(d.dashboards) || !d.dashboards.length) throw new Error('no dashboards');
        S.compat = false;
        adoptList(d.dashboards);
        var pick = dashById(readLast()) || defaultDash();
        if (pick.is_default && pick.widgets === null && cached && !lc) { pick.widgets = cached; S.cur = pick.id; S.dirty[pick.id] = { w: 1 }; scheduleSave(); }
        applyDash(pick);
        S.ready = true;
        writeList();
        if (S.pendingTT) { S.pendingTT = false; openTimeTravel(); }
      }).catch(function () {
        if (S.el !== el) return;
        S.compat = true;
        S.dashes = [{ id: 'local', name: 'My dashboard', is_default: true, position: 0, widgets: cached, filters: S.filters }];
        S.cur = 'local';
        renderChrome();
        apiGet('/dashboard/layout').then(function (d) {
          if (S.el !== el) return;
          var list = d.layout && Array.isArray(d.layout.widgets) ? d.layout.widgets : null;
          if (list) setLayout(list, { save: false });
          else if (cached) { setLayout(cached, { save: false }); S.dashes[0].widgets = cached; markDirty('w'); }
          else setLayout(defaultLayout(), { save: false });
        }).catch(function () { /* offline / no session: keep the cached or default layout */ })
          .then(function () { S.ready = true; if (S.pendingTT) { S.pendingTT = false; openTimeTravel(); } });
      });
      if (app && app.loadOverview && !(app.state && app.state.ovBusy)) app.loadOverview();
      loadNeeds(true);
      clearInterval(S.timer);
      S.timer = setInterval(tickTimers, 1000);
    },

    unmount: function () {
      clearInterval(S.timer); S.timer = null;
      flushSaves();
      if (S.docClick) document.removeEventListener('click', S.docClick);
      destroyCharts(); destroyAnims();
      S.el = S.root = S.grid = null; S.docClick = null; S.drag = null; S.ready = false;
    },

    /** Called by loadOverview when /api/overview lands (and by anything that changes shared state).
     *  Historical mode: no repaint — the view stays frozen at the chosen moment. */
    refresh: function () {
      if (!S.grid || S.hist) return;
      syncPlantFromApp();
      paint();
    },

    // Overview KPIs refresh every 6th poll (30 s); ticket / leave queues with them; accuracy every 5 min.
    onFeed: function (data, app, route) {
      S.polls++;
      if (S.hist) return;   // time travel: live polls neither reload stores nor repaint
      var sub = route && route.sub;
      if (S.polls % 6 === 0 && (sub === 'overview' || sub === 'classic') && !(app && app.state && app.state.paused)) {
        app.loadOverview();
        if (S.grid) {
          needs().forEach(function (k) { if (!SLOW[k] || S.polls % 60 === 0) load(k, true); });
        }
      }
      if (S.grid) paint();
    },

    // ── Legacy Component methods (`this` is the dc app) ──
    methods: class {
  // ── Overview dashboard (/api/overview) ─────────────────────
  // Stale responses (an older plant filter) are dropped via a sequence number.
  // The widget grid repaints through the dashboard module's refresh() hook.
  loadOverview(){
    const seq=(this._ovSeq=(this._ovSeq||0)+1);
    const kick=()=>{ const dm=window.KJPages&&window.KJPages.get('dashboard'); if(dm&&dm.refresh) dm.refresh(); };
    this.setState({ovBusy:true, ovErr:''});
    const qs=new URLSearchParams({token:this.TOK, plant:this.state.plant||''});
    fetch(`${this.API}/overview?${qs}`, {cache:'no-store'})
      .then(x=>x.json())
      .then(d=>{ if(seq!==this._ovSeq) return; if(!(d&&d.ok)) throw new Error('bad'); this.setState({ov:d, ovBusy:false, ovErr:''}); kick(); })
      .catch(()=>{ if(seq===this._ovSeq){ this.setState({ovBusy:false, ovErr:'Could not load the overview'}); kick(); } });
  }
  // Global plant filter (topbar select + sidebar PLANTS rows) — mirrored into
  // every use-case page's own filter, then the current page reloads.
  setPlant(p){
    const plant=p||'';
    this.setState(st=>({plant, reg:{...st.reg, plant}, ppeF:{...st.ppeF, plant}, raF:{...st.raF, plant},
      clF:{...st.clF, plant}, fkF:{...st.fkF, plant}}));
    setTimeout(()=>{ const pg=this.state.page;
      if(pg==='overview'||pg==='kj:dashboard/overview') this.loadOverview();
      if(pg==='attendance'||pg==='employees') this.loadRegister();
      if(pg==='ppe') this.loadPpe();
      if(pg==='intr') this.loadRa();
      if(pg==='cleaning') this.loadCl();
      if(pg==='forklift') this.loadFk();
    }, 0);
  }
    }
  });
})();
