/* Settings hub — page module (assets/js/pages/settings.js).
 * Owner: wave-2 Settings agent (M13 partial). Approved mockup: docs/mockup-ui/generated/admin-settings.png
 * Styles: assets/css/pages/settings.css (injected below — the dc.html is not edited).
 *
 * Vertical section rail (one sub per section, host-mounted):
 *   general · cameras · floorplans · ai · tickets · rules · roles · users · integrations
 * Legacy hashes: #settings → General, #users → Users, #rules → Alert rules (native section since the
 * rules rebuild — same POST /alerts + /notify/settings {conditions} contract as the old dc page).
 *
 * Re-housed from the legacy Settings / Users & Roles pages (same API routes, now kj-* UI):
 *   SenseStudio API, live bridge + RTSP sources + probe + network test, endpoints & tokens, purge,
 *   demo/simulator, auto reports, retention, model thresholds, integration key + webhooks,
 *   Telegram / escalation workflow, users CRUD, roles.json editor.
 * New: AI source Claude|Off + pipeline + cron notice, SLA policy editor (GET/POST /tickets/sla),
 *   login ↔ employee link (GET/POST /user-links → users.person_id), leave allowances (POST /leaves/balances),
 *   per-role nav/widget access preview.
 *
 * Contract (docs/plan/SPA_ARCHITECTURE.md): host-mounted subs use mount/unmount; the legacy
 * `methods` class below is kept verbatim because app.js renderVals() and the dc template
 * still bind to it until the planner's cleanup PR removes the old template sections.
 */
(function () {
  'use strict';
  var P = window.KJPages;
  var esc = P.h.esc, ico = P.h.ico;

  /* ── stylesheet: assets/css/pages/settings.css, cache-busted like this script ── */
  (function injectCss() {
    if (document.getElementById('kjs-css')) return;
    var me = document.querySelector('script[src*="pages/settings.js"]');
    var ref = document.querySelector('link[href*="kj-components.css"]');
    var href = ref ? String(ref.getAttribute('href')).replace(/kj-components\.css.*$/, 'pages/settings.css') : 'assets/css/pages/settings.css';
    var v = me ? /[?&]v=([^&]+)/.exec(me.getAttribute('src') || '') : null;
    var l = document.createElement('link');
    l.id = 'kjs-css'; l.rel = 'stylesheet'; l.href = href + (v ? '?v=' + v[1] : '');
    (document.head || document.documentElement).appendChild(l);
  })();

  /* ── sections (rail order = mockup) ─────────────────────────────────── */
  var SECTIONS = [
    { key: 'general', label: 'General', icon: 'settings', aliases: ['settings'],
      title: 'General', sub: 'Workspace data source, reports, retention, endpoints and tokens.' },
    { key: 'cameras', label: 'Cameras & RTSP', icon: 'cctv',
      title: 'Cameras & RTSP', sub: 'SenseStudio connection, live video bridge, RTSP sources and network health.' },
    { key: 'floorplans', label: 'Floor Plans', icon: 'layers',
      title: 'Floor Plans', sub: 'Factory floor plans with camera pins for movement playback.' },
    { key: 'ai', label: 'AI Engine', icon: 'sparkles',
      title: 'AI Engine', sub: 'The AI engine powers the assistant, reports, forecasts and the PPE-forklift review pipeline.' },
    { key: 'tickets', label: 'Tickets & SLA', icon: 'ticket',
      title: 'Tickets & SLA', sub: 'Set response targets and automate ticket handling.' },
    { key: 'rules', label: 'Alert rules', icon: 'bell-ring', aliases: ['rules'],
      title: 'Alert rules', sub: 'Which detections e-mail or Telegram whom, how often, and when.' },
    { key: 'roles', label: 'Roles & Permissions', icon: 'shield-check', perm: 'users',
      title: 'Roles & Permissions', sub: 'What each role may do — and which pages and widgets it gets.' },
    { key: 'users', label: 'Users', icon: 'user-round', perm: 'users', aliases: ['users'],
      title: 'Users', sub: 'Sign-in accounts, roles, the employee each login belongs to, and leave allowances.' },
    { key: 'integrations', label: 'Integrations', icon: 'puzzle',
      title: 'Integrations', sub: 'Enterprise API key, outbound webhooks, alert channels and the system e-mail server.' }
  ];
  var META = {};
  SECTIONS.forEach(function (s) { META[s.key] = s; });
  /* data each section needs (loader keys below) and its draft namespaces (save bar) */
  var NEEDS = {
    general: ['settings', 'retention', 'users?'], cameras: ['settings', 'live'], floorplans: ['plans'],
    ai: ['settings', 'mon', 'notify', 'models', 'th'], tickets: ['sla', 'notify', 'alerts'], rules: ['alerts', 'notify'], roles: ['roles'],
    users: ['users', 'links', 'roles', 'types'], integrations: ['int', 'notify', 'mail']
  };
  var SECTION_NS = { general: ['reports'], cameras: ['sense', 'live'], ai: ['th'], tickets: ['sla', 'esc'], integrations: ['hooks', 'tg', 'mail'], roles: ['roles'] };

  var CRON_LINE = '* * * * * curl -s "https://kianjoo.weststar-dev.com/api/pipeline/run?token=PROVISION_TOKEN" > /dev/null 2>&1';
  var CRON_PHP = '* * * * * php ~/public_html/kianjoo.weststar-dev.com/bin/ai_worker.php > /dev/null 2>&1';
  var PRIOS = [
    ['critical', 'Critical', 'circle-alert', 'danger'], ['high', 'High', 'triangle-alert', 'orange'],
    ['medium', 'Medium', 'info', 'info'], ['low', 'Low', 'circle-minus', '']
  ];
  var UNITS = [['m', 'minutes', 1], ['h', 'hours', 60], ['d', 'days', 1440]];
  var UNIT_MIN = { m: 1, h: 60, d: 1440 };

  /* ── module state (page-only; never in app.state) ───────────────────── */
  var S = {
    el: null, app: null, sec: 'general', data: {}, err: {}, at: {}, drafts: {}, hookDraft: null,
    msg: {}, probe: {}, arMail: null, net: null, netBusy: false, pipe: null, escRes: null, newKey: '',
    monBusy: {}, confirms: {}, seq: 0, uFilter: 'all', uQuery: '', leaveYear: new Date().getFullYear(), handlers: null
  };

  /* ── API ─────────────────────────────────────────────────────────────── */
  function api(method, path, body) {
    var base = (window.TMNS && window.TMNS.api) || '/api';
    var tok = (window.TMNS && window.TMNS.token) || '';
    var url = base + path + (tok ? (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(tok) : '');
    var o = { method: method, credentials: 'same-origin', cache: 'no-store' };
    if (method === 'POST') { o.headers = { 'Content-Type': 'application/json' }; o.body = JSON.stringify(body || {}); }
    return fetch(url, o).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; }).then(function (d) {
        if (!d || d.ok === false) { var e = new Error((d && (d.error || d.msg)) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return d;
      });
    });
  }
  function get(p) { return api('GET', p); }
  function post(p, b) { return api('POST', p, b); }

  var LOADERS = {
    settings: function () { return get('/settings').then(function (d) { return d.settings || {}; }); },
    live: function () { return get('/live/status'); },
    retention: function () { return get('/retention'); },
    models: function () { return get('/ai/models'); },
    th: function () { return get('/aiperf/thresholds'); },
    sla: function () { return get('/tickets/sla'); },
    notify: function () { return get('/notify/settings'); },
    alerts: function () { return get('/alerts').then(function (d) { return d.settings || {}; }); },
    users: function () { return get('/users').then(function (d) { return d.users || []; }); },
    links: function () { return get('/user-links'); },
    roles: function () { return get('/roles'); },
    types: function () { return get('/leaves/types').then(function (d) { return d.types || []; }); },
    int: function () { return get('/integration/config'); },
    plans: function () { return get('/floorplans'); },
    mail: function () { return get('/mail/settings').then(function (d) { return d.settings || {}; }); },
    mon: function () { return get('/monitors'); }
  };
  function load(key) {
    return LOADERS[key]().then(function (d) { S.data[key] = d; delete S.err[key]; S.at[key] = Date.now(); return d; },
      function (e) { S.err[key] = (e && e.message) || 'Request failed'; return null; });
  }

  /* ── helpers ─────────────────────────────────────────────────────────── */
  function A() { return S.app || window.KJApp || null; }
  function toast(msg, tone) { if (window.KJModal && window.KJModal.toast) window.KJModal.toast(msg, tone || 'success'); }
  function canUsers() { return P.can('users'); }
  function isAdminTier() { var r = P.role(); return r === 'admin' || r === 'superadmin' || P.can('users'); }
  function n0(x) { return Number(x) || 0; }
  function bytes(n) { n = +n || 0; var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(n < 10 ? 2 : 1) : n) + ' ' + u[i]; }
  function initials(s) { return String(s || '?').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join('') || '?'; }
  function fmtMin(m) { m = n0(m); return m % 1440 === 0 ? (m / 1440) + ' d' : (m % 60 === 0 ? (m / 60) + ' h' : m + ' min'); }
  function bestUnit(m) { m = n0(m); return m >= 7 * 1440 && m % 1440 === 0 ? 'd' : (m >= 60 && m % 60 === 0 ? 'h' : 'm'); }   // mockup: 4 h · 24 h · 72 h
  function w5(pct) { return 'kj-w-' + Math.max(0, Math.min(100, Math.round(pct / 5) * 5)); }
  function attr(name, v) { return v == null ? '' : ' ' + name + '="' + esc(v) + '"'; }
  function skel(n) { var o = ''; for (var i = 0; i < (n || 3); i++) o += '<span class="kj-skel kj-skel-line' + (i % 3 === 2 ? ' is-short' : (i % 3 === 1 ? ' is-mid' : '')) + '"></span>'; return '<div>' + o + '</div>'; }
  function errBox(key, what) {
    return P.h.emptyState({ icon: 'cloud-off', title: 'Could not load ' + what, text: S.err[key] || 'The server did not answer.',
      actions: [{ label: 'Open the dashboard', path: 'dashboard', icon: 'layout-dashboard' }] }).replace('<div class="kj-empty">',
      '<div class="kj-empty is-error">') + '<div class="kjs-btns">' + btn('reload', 'Retry', 'refresh-cw') + '</div>';
  }
  function msgLine(k) { var m = S.msg[k]; if (!m) return '<div class="kjs-msg" data-kjs-msg="' + k + '"></div>';
    return '<div class="kjs-msg' + (m.tone === 'err' ? ' is-err' : (m.tone === 'ok' ? ' is-ok' : '')) + '" data-kjs-msg="' + k + '">' + esc(m.text) + '</div>'; }
  function setMsg(k, text, tone) {
    S.msg[k] = text ? { text: text, tone: tone || '' } : null;
    var el = S.el && S.el.querySelector('[data-kjs-msg="' + k + '"]');
    if (el) { el.textContent = text || ''; el.className = 'kjs-msg' + (tone === 'err' ? ' is-err' : (tone === 'ok' ? ' is-ok' : '')); }
  }

  /* markup builders */
  function btn(act, label, icon, kind, arg, extra) {
    return '<button type="button" class="kj-btn ' + (kind || 'kj-btn-secondary') + '" data-kjs-act="' + act + '"' + attr('data-arg', arg) + (extra || '') + '>' +
      (icon ? ico(icon) : '') + '<span>' + esc(label) + '</span></button>';
  }
  function navBtn(path, label, icon, kind) {
    return '<button type="button" class="kj-btn ' + (kind || 'kj-btn-secondary') + '" data-kj-nav="' + esc(path) + '">' + (icon ? ico(icon) : '') + '<span>' + esc(label) + '</span></button>';
  }
  function sw(act, on, arg, label, disabled, extra) {
    return '<button type="button" role="switch" aria-checked="' + (!!on) + '" aria-label="' + esc(label) + '" title="' + esc(label) + '" class="kjs-switch' + (on ? ' is-on' : '') + '" data-kjs-act="' + act + '"' +
      attr('data-arg', arg) + (extra || '') + (disabled ? ' disabled' : '') + '></button>';
  }
  function opts(act, list, cur, disabled, extra) {
    return '<div class="kjs-opts" role="group">' + list.map(function (o) {
      var on = String(o[0]) === String(cur);
      return '<button type="button" class="kjs-opt' + (on ? ' is-on' : '') + '" aria-pressed="' + on + '" data-kjs-act="' + act + '" data-arg="' + esc(o[0]) + '"' + (extra || '') + (disabled ? ' disabled' : '') + '>' + esc(o[1]) + '</button>';
    }).join('') + '</div>';
  }
  function field(label, control, help, cls) {
    return '<label class="kj-field' + (cls ? ' ' + cls : '') + '"><span class="kj-label">' + esc(label) + '</span>' + control + (help ? '<span class="kj-help">' + esc(help) + '</span>' : '') + '</label>';
  }
  /* field() for chip groups / button rows — a <div>, so clicking the caption never "clicks" the first chip */
  function group(label, control, help, cls) {
    return '<div class="kj-field' + (cls ? ' ' + cls : '') + '"><span class="kj-label">' + esc(label) + '</span>' + control + (help ? '<span class="kj-help">' + esc(help) + '</span>' : '') + '</div>';
  }
  function emailSplit(v) { return (Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map(function (x) { return String(x).trim(); }).filter(Boolean); }
  function emailOk(e) { return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(e); }
  function dv(ns, key, saved) { var d = S.drafts[ns]; return d && Object.prototype.hasOwnProperty.call(d, key) ? d[key] : saved; }
  function inp(ns, key, saved, o) {
    o = o || {};
    var sv = o.secret ? '' : (saved == null ? '' : String(saved));
    var v = dv(ns, key, sv);
    return '<input class="kj-input' + (o.mono ? ' kjs-mono' : '') + '" type="' + (o.type || 'text') + '" data-kjs-ns="' + ns + '" data-kjs-key="' + esc(key) + '" data-kjs-saved="' + esc(sv) + '" value="' + esc(v) + '"' +
      attr('placeholder', o.ph) + attr('min', o.min) + attr('max', o.max) + attr('step', o.step) + (o.disabled ? ' disabled' : '') + ' autocomplete="off" spellcheck="false">';
  }
  function draftOpts(ns, key, list, saved, disabled) {
    return opts('draft-opt', list, dv(ns, key, String(saved)), disabled, ' data-ns="' + ns + '" data-key="' + esc(key) + '" data-saved="' + esc(saved) + '"');
  }
  function draftSw(ns, key, saved, label, disabled) {
    var cur = dv(ns, key, saved ? '1' : '0') === '1';
    return sw('draft-toggle', cur, null, label, disabled, ' data-ns="' + ns + '" data-key="' + esc(key) + '" data-saved="' + (saved ? '1' : '0') + '"');
  }
  function card(o) {
    return '<div class="kjs-card' + (o.cls ? ' ' + o.cls : '') + '"><div class="kjs-card-head"><span class="kjs-card-ico' + (o.tone ? ' is-' + o.tone : '') + '">' + ico(o.icon || 'settings') + '</span>' +
      '<div class="kjs-card-titles"><h4 class="kjs-card-title">' + esc(o.title) + '</h4>' + (o.sub ? '<p class="kjs-card-sub">' + esc(o.sub) + '</p>' : '') + '</div>' +
      (o.actions ? '<div class="kjs-card-actions">' + o.actions + '</div>' : '') + '</div>' + (o.body || '') + '</div>';
  }
  function tile(icon, val, lbl, tone, nav, act, arg, sub) {
    if (!nav && act === 'noop') {   // informational KPI (no destination) — not a fake button
      return '<div class="kj-stat' + (tone ? ' is-' + tone : '') + '"><span class="kj-stat-ico">' + ico(icon) + '</span>' +
        '<span><span class="kj-stat-val">' + esc(val) + '</span><span class="kj-stat-lbl">' + esc(lbl) + '</span>' + (sub ? '<span class="kjs-stat-sub">' + esc(sub) + '</span>' : '') + '</span></div>';
    }
    var t = nav ? ' data-kj-nav="' + esc(nav) + '"' : ' data-kjs-act="' + act + '"' + attr('data-arg', arg);
    return '<button type="button" class="kj-stat' + (tone ? ' is-' + tone : '') + '"' + t + '><span class="kj-stat-ico">' + ico(icon) + '</span>' +
      '<span><span class="kj-stat-val">' + esc(val) + '</span><span class="kj-stat-lbl">' + esc(lbl) + '</span>' + (sub ? '<span class="kjs-stat-sub">' + esc(sub) + '</span>' : '') + '</span></button>';
  }
  function row(icon, title, sub, control, extra) {
    return '<div class="kjs-row">' + ico(icon) + '<div class="kjs-row-text"><div class="kjs-row-title">' + esc(title) + '</div>' +
      (sub ? '<div class="kjs-row-sub">' + esc(sub) + '</div>' : '') + (extra ? '<div class="kjs-row-extra">' + extra + '</div>' : '') + '</div>' + (control || '') + '</div>';
  }
  function copyLine(label, text) {
    return '<div class="kjs-copyline"><span class="kj-label">' + esc(label) + '</span><div class="kjs-code"><code>' + esc(text || '—') + '</code>' +
      (text ? '<button type="button" class="kj-btn kj-btn-sm" data-kjs-act="copy" data-arg="' + esc(text) + '" aria-label="Copy ' + esc(label) + '">' + ico('copy') + '<span>Copy</span></button>' : '') + '</div></div>';
  }
  function chip(text, tone, dot) { return '<span class="kj-chip' + (tone ? ' is-' + tone : '') + (dot ? ' kj-chip-dot' : '') + '">' + esc(text) + '</span>'; }
  function savebar(sec) {
    return '<div class="kjs-savebar" data-kjs-savebar="' + sec + '"><span class="kjs-savebar-info">' + ico('info') +
      '<span class="kjs-when-dirty">Unsaved changes</span><span class="kjs-when-clean">All changes saved</span></span>' +
      '<button type="button" class="kj-btn kj-btn-secondary kjs-when-dirty" data-kjs-act="discard">Cancel</button>' +
      '<button type="button" class="kj-btn kj-btn-primary" data-kjs-act="save">' + ico('check') + '<span>Save changes</span></button></div>';
  }

  /* ── drafts + save bar ───────────────────────────────────────────────── */
  function setDraft(ns, key, val, saved) {
    var d = S.drafts[ns] || (S.drafts[ns] = {});
    if (String(val) === String(saved == null ? '' : saved)) delete d[key]; else d[key] = String(val);
    updateSavebar();
  }
  function dirtyNs(ns) { return ns === 'hooks' ? S.hookDraft != null : Object.keys(S.drafts[ns] || {}).length > 0; }
  function secDirty(sec) { return (SECTION_NS[sec] || []).some(dirtyNs); }
  function updateSavebar() {
    if (!S.el) return;
    var dirty = secDirty(S.sec);
    Array.prototype.forEach.call(S.el.querySelectorAll('[data-kjs-savebar]'), function (b) {
      b.classList.toggle('is-dirty', dirty);
      var s = b.querySelector('[data-kjs-act="save"]'); if (s) s.disabled = !dirty;
    });
  }
  function clearNs(ns) { if (ns === 'hooks') S.hookDraft = null; else delete S.drafts[ns]; }

  var SAVE = {
    sense: function (d) {
      var o = {};
      ['sense_api_base', 'sense_account', 'image_base'].forEach(function (k) { if (k in d) o[k] = d[k].trim(); });
      if (d.sense_password) o.sense_password = d.sense_password;
      return post('/settings', o);
    },
    live: function (d) {
      var o = {};
      ['live_stream_base', 'live_bridge_api', 'live_api_user'].forEach(function (k) { if (k in d) o[k] = d[k].trim(); });
      ['live_stream_token', 'live_api_pass'].forEach(function (k) { if (d[k]) o[k] = d[k]; });
      if ('live_auto_sync' in d) o.live_auto_sync = d.live_auto_sync === '1';
      return post('/settings', o).then(function (r) {
        var a = A(); if (a) { a.loadLive(true, true); a.loadApp(); a.fetchFeed(); }
        return r;
      });
    },
    reports: function (d) {
      var o = {};
      if ('report_frequency' in d) o.report_frequency = d.report_frequency;
      if ('report_hour' in d) o.report_hour = +d.report_hour;
      if ('report_recipients' in d) o.report_recipients = d.report_recipients;
      return post('/settings', o);
    },
    th: function (d) {
      var t = S.data.th || {};
      var f = parseFloat(dv('th', 'face', String(t.face_min_similarity))), p = parseFloat(dv('th', 'ppe', String(t.ppe_min_conf)));
      if (!(f >= 0 && f <= 100) || !(p >= 0 && p <= 100)) return Promise.reject(new Error('Thresholds are percentages 0–100 (0 = off)'));
      return post('/aiperf/thresholds', { face_min_similarity: f, ppe_min_conf: p });
    },
    sla: function () {
      var pol = slaDraftMinutes(), bad = PRIOS.filter(function (p) { return !(pol[p[0]].response > 0 && pol[p[0]].resolution > 0); });
      if (bad.length) return Promise.reject(new Error('Every target needs a positive number (' + bad.map(function (b) { return b[1]; }).join(', ') + ')'));
      var inv = PRIOS.filter(function (p) { return pol[p[0]].resolution < pol[p[0]].response; });
      if (inv.length) return Promise.reject(new Error('Resolution must be at least the first-response target (' + inv.map(function (b) { return b[1]; }).join(', ') + ')'));
      return post('/tickets/sla', pol).then(function (r) { if (r.policy && S.data.sla) S.data.sla.policy = r.policy; return r; });
    },
    esc: function () {
      var es = notifyS().escalation || {}, lv = es.levels || [{}, {}, {}];
      var levels = [0, 1, 2].map(function (i) {
        var l = lv[i] || {};
        return { name: dv('esc', i + '.name', l.name || ''), emails: emailSplit(dv('esc', i + '.emails', (l.emails || []).join(', '))), chats: dv('esc', i + '.chats', (l.chats || []).join(', ')) };
      });
      var bad = [];
      levels.forEach(function (l, i) { l.emails.forEach(function (e) { if (!emailOk(e)) bad.push('L' + (i + 1) + ': ' + e); }); });
      if (bad.length) return Promise.reject(new Error('Not a valid e-mail address — ' + bad.join(', ')));
      return post('/notify/settings', { escalation: { levels: levels } }).then(function (d) { S.data.notify = d; return d; });
    },
    tg: function (d) {
      var tg = notifyS().telegram || {}, t = { chat_ids: dv('tg', 'chat_ids', (tg.chat_ids || []).join(', ')) };
      if (d.bot_token && d.bot_token.indexOf('•') < 0) t.bot_token = d.bot_token.trim();
      return post('/notify/settings', { telegram: t }).then(function (r) { S.data.notify = r; return r; });
    },
    mail: function (d) {
      var o = {};
      ['host', 'username', 'from_address', 'from_name'].forEach(function (k) { if (k in d) o[k] = d[k].trim(); });
      if ('enabled' in d) o.enabled = d.enabled === '1';
      if ('scheme' in d) o.scheme = d.scheme;
      if ('port' in d) {
        var port = parseInt(d.port, 10);
        if (!(port >= 1 && port <= 65535)) return Promise.reject(new Error('SMTP port must be 1–65535'));
        o.port = port;
      }
      if (d.password && d.password.indexOf('•') < 0) o.password = d.password;
      if ('to' in d) {
        var bad = emailSplit(d.to).filter(function (e) { return !emailOk(e); });
        if (bad.length) return Promise.reject(new Error('Not a valid e-mail address — ' + bad.join(', ')));
        o.to = emailSplit(d.to).join(', ');
      }
      if ('from_address' in o && o.from_address && !emailOk(o.from_address)) return Promise.reject(new Error('The from address is not a valid e-mail address'));
      return post('/mail/settings', o).then(function (r) { if (r.settings) S.data.mail = r.settings; return r; });
    },
    hooks: function () {
      var l = S.hookDraft || [], bad = l.filter(function (h) { return !/^https?:\/\/\S+$/i.test(String(h.url || '').trim()); });
      if (bad.length) return Promise.reject(new Error('Every webhook needs an http(s) URL'));
      return post('/integration/config', { webhooks: l }).then(function (d) { if (S.data.int) S.data.int.settings = d.settings; return d; });
    },
    roles: function (d) {
      var roles = (S.data.roles && S.data.roles.roles) || [], changed = {};
      Object.keys(d).forEach(function (k) { changed[k.split('|')[0]] = 1; });
      return Object.keys(changed).reduce(function (p, name) {
        return p.then(function () {
          var r = roles.filter(function (x) { return x.name === name; })[0]; if (!r) return null;
          var perms = {}; Object.keys(r.perms || {}).forEach(function (k) { perms[k] = !!r.perms[k]; });
          Object.keys(d).forEach(function (k) { var s = k.split('|'); if (s[0] === name) perms[s[1]] = d[k] === '1'; });
          return post('/roles', { name: name, desc: r.desc, perms: perms }).then(function (x) { if (x.roles) S.data.roles.roles = x.roles; });
        });
      }, Promise.resolve());
    }
  };
  function saveSection() {
    var list = (SECTION_NS[S.sec] || []).filter(dirtyNs);
    if (!list.length) return;
    var sec = S.sec, b = S.el && S.el.querySelector('[data-kjs-savebar] [data-kjs-act="save"]');
    if (b) b.disabled = true;
    list.reduce(function (p, ns) { return p.then(function () { return SAVE[ns](S.drafts[ns] || {}).then(function () { clearNs(ns); }); }); }, Promise.resolve())
      .then(function () { toast('Changes saved'); if (S.sec === sec) refresh(true); })
      .catch(function (e) { toast((e && e.message) || 'Save failed', 'danger'); updateSavebar(); });
  }
  function discardSection() { (SECTION_NS[S.sec] || []).forEach(clearNs); paintSection(); toast('Changes discarded', 'warn'); }

  /* ── confirmation (danger actions) ──────────────────────────────────── */
  function confirmDo(o, fn) {
    if (!window.KJModal) { if (window.confirm(o.text || o.title)) fn(); return; }
    ensureModals();
    var id = 'c' + (++S.seq);
    S.confirms[id] = fn;
    window.KJModal.open('kjs-confirm', id, o, { noHash: true });
  }

  /* ── frame + section render ─────────────────────────────────────────── */
  function railHtml() {
    var vis = P.visibleSubs('settings').map(function (s) { return s.key; });
    return '<nav class="kj-card kjs-rail" aria-label="Settings sections">' + SECTIONS.filter(function (s) { return vis.indexOf(s.key) >= 0; }).map(function (s) {
      var on = s.key === S.sec;
      return '<button type="button" class="kjs-rail-item' + (on ? ' is-active' : '') + '" data-kj-nav="settings/' + s.key + '"' + (on ? ' aria-current="page"' : '') + '>' +
        ico(s.icon) + '<span>' + esc(s.label) + '</span>' + (s.legacy ? '<span class="kjs-rail-tag">classic</span>' : '') + '</button>';
    }).join('') + '</nav>';
  }
  function paintFrame() {
    if (!S.el) return;
    S.el.innerHTML = '<div class="kj-page kjs"><div class="kj-page-head"><div><h2 class="kj-page-title">Settings</h2>' +
      '<p class="kj-page-sub">Configure your workspace, intelligence and operations.</p></div></div>' +
      '<div class="kjs-layout">' + railHtml() + '<div class="kjs-main" data-kjs-main></div></div></div>';
    paintSection();
  }
  function paintSection() {
    if (!S.el) return;
    var main = S.el.querySelector('[data-kjs-main]'); if (!main) return;
    var m = META[S.sec] || META.general, r = RENDER[S.sec] || RENDER.general;
    var html;
    try { html = r(m); } catch (e) { html = '<div class="kjs-sec">' + P.h.emptyState({ icon: 'bug', title: 'This section failed to render', text: String(e && e.message || e) }) + '</div>'; }
    main.innerHTML = html + (SECTION_NS[S.sec] ? savebar(S.sec) : '');
    updateSavebar();
  }
  function refresh(force) {
    var sec = S.sec;
    var keys = (NEEDS[sec] || []).filter(function (k) { return k.slice(-1) !== '?' || canUsers(); }).map(function (k) { return k.replace('?', ''); });
    if (!force) keys = keys.filter(function (k) { return !S.at[k] || Date.now() - S.at[k] > 5000; });
    if (!keys.length) return;
    Promise.all(keys.map(load)).then(function () { if (S.el && S.sec === sec) paintSection(); });
  }
  function secHead(m, right) {
    return '<div class="kjs-sec-head"><div><h3 class="kjs-sec-title">' + esc(m.title) + '</h3><p class="kjs-sec-sub">' + esc(m.sub) + '</p></div>' + (right || '') + '</div>';
  }
  function sec(m, right, body) { return '<section class="kjs-sec" aria-label="' + esc(m.title) + '">' + secHead(m, right) + body + '</section>'; }

  var RENDER = {};

  /* ── General ─────────────────────────────────────────────────────────── */
  RENDER.general = function (m) {
    var st = S.data.settings, a = A(), ast = (a && a.state) || {};
    var fleet = ast.fleet || [], on = fleet.filter(function (f) { return f && f.online; }).length;
    var users = S.data.users;
    var tiles = '<div class="kjs-kpis">' +
      tile('cctv', fleet.length ? on + ' / ' + fleet.length : '—', 'Cameras online', fleet.length && on === fleet.length ? 'success' : 'warn', 'settings/cameras') +
      (canUsers() ? tile('users', users ? users.filter(function (u) { return u.active; }).length + ' / ' + users.length : '…', 'Active users', '', 'settings/users') : '') +
      tile('sparkles', st ? (st.ai_source === 'off' ? 'Off' : 'On') : '…', 'AI source', st && st.ai_source === 'off' ? 'danger' : 'purple', 'settings/ai') +
      tile('ticket', '4 tiers', 'SLA policy', 'orange', 'settings/tickets') + '</div>';
    if (!st && S.err.settings) return sec(m, '', tiles + errBox('settings', 'settings'));
    var demo = !!ast.demo;
    var data = card({ icon: 'database', tone: demo ? 'warn' : 'success', title: 'Data source', sub: demo ? 'Showing dummy sample data in this browser' : 'Live SenseStudio detections',
      body: '<div class="kjs-rows">' + row('flask-conical', 'Demo data', 'Dummy data for presentations — only this browser switches; the server keeps recording live detections.', sw('demo', demo, null, 'Demo data')) +
        row('play', 'Detection simulator', 'Generates a week of realistic detections through the real ingest pipeline (DEMO… cameras, KJ-01xx employees). Simulated events send no e-mail.', '',
          btn('sim', 'Generate demo detections', 'sparkles', 'kj-btn-primary kj-btn-sm', 'run') + btn('sim', 'Remove demo data', 'trash-2', 'kj-btn-ghost kj-btn-sm', 'reset')) +
        '</div>' + msgLine('sim') });
    var rep = st ? card({ icon: 'mail', tone: 'primary', title: 'Auto reports', sub: 'E-mailed summary + forecast', actions: btn('report-now', 'Send report now', 'send', 'kj-btn-secondary kj-btn-sm'),
      body: '<div class="kj-stack">' + field('Frequency', draftOpts('reports', 'report_frequency', [['off', 'Off'], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']], st.report_frequency || 'off')) +
        field('Send at', draftOpts('reports', 'report_hour', [[7, '07:00'], [8, '08:00'], [12, '12:00'], [18, '18:00'], [20, '20:00']], st.report_hour == null ? 8 : st.report_hour)) +
        field('Recipients', inp('reports', 'report_recipients', (st.report_recipients || []).join(', '), { ph: 'Blank = the alert recipients' }), 'Comma-separated e-mail addresses.') + '</div>' + msgLine('report') })
      : card({ icon: 'mail', title: 'Auto reports', body: skel(3) });
    var rd = S.data.retention, rs = (rd && rd.storage) || {}, due = (rd && rd.due) || {}, lr = rs.last_run || {};
    var curDays = rs.retention_days != null ? rs.retention_days : 90;
    var ret = card({ icon: 'archive', title: 'Data retention', sub: 'Detections older than the window are purged automatically once a day.',
      actions: btn('ret-purge', 'Purge now', 'trash-2', 'kj-btn-ghost kj-btn-sm', null, rd ? '' : ' disabled'),
      body: rd ? '<div class="kjs-kpis is-2col">' +
          tile('hard-drive', bytes(rs.total_bytes), 'Stored now', '', null, 'noop', null, 'DB ' + bytes(rs.db_bytes) + ' · files ' + bytes(rs.attachments_bytes)) +
          tile('list', String(rs.events || 0), 'Events stored', '', null, 'noop', null, rs.oldest ? 'oldest ' + String(rs.oldest).slice(0, 10) : '—') +
          tile('activity', String(rs.events_per_day || 0), 'Events / day', '', null, 'noop', null, '~' + bytes(rs.bytes_per_event) + ' each') +
          tile('trending-up', bytes(rs.projected_bytes), 'Projected', 'purple', null, 'noop', null, 'at ' + (rs.projection_days || '—') + ' days') + '</div>' +
          field('Keep events & evidence for', opts('ret', [[30, '30 days'], [60, '60 days'], [90, '90 days'], [180, '180 days'], [365, '1 year'], [0, 'Keep forever']], curDays)) +
          '<div class="kjs-muted">' + esc(due.disabled ? 'Retention is off — events are kept forever' : ((due.events || 0) + ' events older than ' + (due.cutoff || '—') + ' are due for purge')) +
          ' · ' + esc(lr.last_run ? ('last purge ' + String(lr.last_run).replace('T', ' ').slice(0, 16) + ' · ' + (lr.purged || 0) + ' events') : 'no purge has run yet') + '</div>'
        : (S.err.retention ? '<div class="kjs-msg is-err">' + esc(S.err.retention) + '</div>' : skel(2)) });
    var ep = (st && st.endpoints) || {};
    var tokens = card({ icon: 'key-round', tone: 'purple', title: 'Endpoints & tokens', sub: 'Paste each push URL into its SenseStudio policy exactly as shown — the camera comes from the payload.',
      body: st ? '<div class="kj-stack">' + copyLine('① Face-recognition feed', ep.push_face) + copyLine('② Body-attribution feed', ep.push_body) +
          copyLine('Legacy / untagged push URL', ep.push) + copyLine('Events API (read)', ep.events) + '</div>' +
          '<div class="kjs-btns">' + btn('regen', 'Regenerate ingest token', 'refresh-cw', 'kj-btn-secondary', 'ingest') + btn('regen', 'Regenerate read token', 'refresh-cw', 'kj-btn-secondary', 'read') + '</div>'
        : skel(4) });
    var danger = card({ icon: 'triangle-alert', tone: 'danger', cls: 'is-danger', title: 'Danger zone',
      sub: 'Deletes every stored detection, its attributes, incident tickets and comment history. Cameras, users, tokens and settings are kept.',
      actions: btn('purge-all', 'Delete all detections', 'trash-2', 'kj-btn-danger') });
    return sec(m, '', tiles + data + '<div class="kjs-grid-2">' + rep + ret + '</div>' + tokens + danger);
  };

  /* ── Cameras & RTSP ─────────────────────────────────────────────────── */
  function bridgeState() {
    var st = S.data.settings || {}, lb = S.data.live, b = (lb && lb.bridge) || {}, c = (lb && lb.counts) || {};
    var cfg = (lb && lb.ok) ? !!lb.configured : !!st.live_stream_base;
    var regLine = n0(c.registered) + ' of ' + Math.max(0, n0(c.desired) - n0(c.direct)) + ' sources registered' + (n0(c.direct) ? ' · ' + n0(c.direct) + ' direct HLS' : '');
    if (!cfg) return { cfg: false, text: 'Not configured — tiles show detection frames', tone: '' };
    if (!lb) return { cfg: true, text: S.err.live ? 'Bridge status unavailable: ' + S.err.live : 'Checking the bridge…', tone: S.err.live ? 'danger' : '' };
    if (b.reachable) return { cfg: true, text: 'Bridge reachable · go2rtc ' + (b.version || '?') + ' · ' + regLine, tone: (n0(c.missing) || n0(c.mismatch)) ? 'warn' : 'success' };
    if (b.reachable === false) return { cfg: true, text: 'Bridge unreachable: ' + (b.error || 'no response'), tone: 'danger' };
    return { cfg: true, text: 'Bridge not checked yet — press Test bridge', tone: '' };
  }
  var PILL = { direct: ['Direct HLS', 'primary'], registered: ['Registered', 'success'], missing: ['Missing', 'orange'], mismatch: ['Mismatch', 'warn'], orphan: ['Orphan', ''] };
  RENDER.cameras = function (m) {
    var st = S.data.settings, lb = S.data.live, a = A(), fleet = ((a && a.state) || {}).fleet || [];
    if (!st) return sec(m, '', S.err.settings ? errBox('settings', 'camera settings') : '<div class="kjs-card">' + skel(6) + '</div>');
    var bs = bridgeState(), c = (lb && lb.counts) || {};
    var kpis = '<div class="kjs-kpis">' +
      tile('cctv', fleet.length ? fleet.filter(function (f) { return f.online; }).length + ' / ' + fleet.length : '—', 'Devices online', '', 'cameras/manage') +
      tile('radio', String(n0(c.registered)), 'Registered on bridge', 'success', null, 'live-test') +
      tile('circle-alert', String(n0(c.missing) + n0(c.mismatch)), 'Missing / mismatch', (n0(c.missing) + n0(c.mismatch)) ? 'orange' : '', null, 'live-sync') +
      tile('video', String(n0(c.direct)), 'Direct HLS', 'purple', 'cameras/wall') + '</div>';
    var sense = card({ icon: 'server', tone: 'primary', title: 'SenseStudio API', sub: (fleet.length ? fleet.filter(function (f) { return f.online; }).length + '/' + fleet.length + ' devices online' : 'No devices reported yet'),
      body: '<div class="kjs-form">' + field('SenseStudio base URL', inp('sense', 'sense_api_base', st.sense_api_base, { ph: 'https://senseStudio.local' }), '', 'is-wide') +
        field('API account', inp('sense', 'sense_account', st.sense_account)) +
        field('API password', inp('sense', 'sense_password', '', { secret: true, type: 'password', ph: st.sense_password || 'not set' }), 'Leave blank to keep the stored password.') +
        field('Image host base (trigger frames)', inp('sense', 'image_base', st.image_base, { ph: 'https://…' }), '', 'is-wide') + '</div>' });
    var auto = st.live_auto_sync != null ? !!st.live_auto_sync : ((lb && lb.autoSync != null) ? !!lb.autoSync : true);
    var live = card({ icon: 'radio-tower', tone: bs.tone === 'danger' ? 'danger' : 'success', title: 'Live video bridge (go2rtc)', sub: bs.text,
      actions: btn('live-test', 'Test bridge', 'activity', 'kj-btn-secondary kj-btn-sm') + btn('live-sync', 'Register all sources', 'refresh-cw', 'kj-btn-secondary kj-btn-sm', null, bs.cfg ? '' : ' disabled'),
      body: '<div class="kjs-form">' + field('Public base URL', inp('live', 'live_stream_base', st.live_stream_base, { ph: 'https://live.example.com' })) +
        field('Token (if gated)', inp('live', 'live_stream_token', '', { secret: true, type: 'password', ph: st.live_stream_token || 'not set' })) +
        field('Internal API URL (server → bridge, optional)', inp('live', 'live_bridge_api', st.live_bridge_api, { ph: 'http://127.0.0.1:1984' })) +
        field('API user (optional)', inp('live', 'live_api_user', st.live_api_user)) +
        field('API password (optional)', inp('live', 'live_api_pass', '', { secret: true, type: 'password', ph: st.live_api_pass || 'not set' })) + '</div>' +
        '<div class="kjs-rows">' + row('workflow', 'Auto-register fleet RTSP sources', 'Every camera RTSP URL known to VisionAI is registered on the bridge automatically (fleet refresh, at most every 5 minutes, and on camera edits).',
          draftSw('live', 'live_auto_sync', auto, 'Auto-register fleet RTSP sources')) + '</div>' + msgLine('live') });
    var src = (lb && lb.ok && Array.isArray(lb.streams)) ? lb.streams
      : Object.keys(st.live_rtsp || {}).map(function (k) { return { name: k, source: st.live_rtsp[k], origin: 'manual', state: '' }; });
    var mask = function (u) { return String(u || '').replace(/\/\/([^:/@]+):[^@]+@/, '//$1:••••@'); };
    var rows = src.filter(function (r) { return r && r.name; }).map(function (r) {
      var name = String(r.name), pill = PILL[r.state] || ['Unknown', ''], pr = S.probe[name] || null;
      var probe = !pr ? '' : (pr.busy ? '<span class="kjs-muted">Probing…</span>' : (pr.ready ? chip('✓ frame' + (pr.ms != null && pr.ms !== '' ? ' ' + (n0(pr.ms) / 1000).toFixed(1) + ' s' : ''), 'success') : chip('✗ ' + (pr.error || 'no frame'), 'danger')));
      var snap = pr && pr.snap ? '<img class="kjs-snap" src="' + esc(pr.snap) + '" alt="Bridge snapshot of ' + esc(name) + '" data-kj-modal="image:' + esc(encodeURIComponent(pr.snap)) + '">' : '';
      return '<tr><td><button type="button" class="kjs-click" data-kj-modal="camera:' + esc(encodeURIComponent(name)) + '"><span class="kjs-cell-name">' + esc(name) + '</span><div class="kjs-cell-sub">' + esc(r.fleetName || '—') + '</div></button></td>' +
        '<td class="kjs-mono">' + esc(mask(r.source) || '— (source unknown)') + '</td>' +
        '<td>' + chip(r.origin === 'fleet' ? 'VisionAI' : (r.origin === 'manual' ? 'Manual' : 'Bridge only'), r.origin === 'manual' ? 'purple' : '') + '</td>' +
        '<td>' + chip(pill[0], pill[1], true) + '</td>' +
        '<td><div class="kjs-btns">' + (r.state !== 'direct' ? btn('probe', pr && pr.busy ? 'Probing…' : 'Probe', 'scan-eye', 'kj-btn-ghost kj-btn-sm', name, pr && pr.busy ? ' disabled' : '') : '') +
          probe + snap + (r.origin === 'manual' ? btn('src-remove', 'Remove', 'trash-2', 'kj-btn-ghost kj-btn-sm', name) : '') + '</div></td></tr>';
    });
    var table = rows.length ? '<div class="kj-table-wrap"><table class="kj-table kjs-table"><thead><tr><th>Stream</th><th>Source</th><th>Origin</th><th>State</th><th>Probe</th></tr></thead><tbody>' + rows.join('') + '</tbody></table></div>'
      : P.h.emptyState({ icon: 'video-off', title: lb ? 'No RTSP sources yet' : 'Loading sources…', text: bs.cfg ? 'Cameras with an RTSP URL in VisionAI appear here automatically, or add a manual source below.' : 'Set the public base URL above, save, then test the bridge.',
        actions: [{ label: 'Camera fleet', path: 'cameras/manage', icon: 'cctv' }] });
    var sources = card({ icon: 'list-video', title: 'RTSP sources', sub: (lb && lb.lastSync && lb.lastSync.at) ? 'Last sync ' + String(lb.lastSync.at).replace('T', ' ').slice(0, 16) : 'Not synced yet',
      body: table + '<div class="kjs-form">' + field('Stream label', '<input class="kj-input" data-kjs-local="src-name" placeholder="cam01 (serial, lower-case)" autocomplete="off">') +
        field('Source URL', '<input class="kj-input kjs-mono" data-kjs-local="src-url" placeholder="rtsp://user:pass@IP:554/Streaming/Channels/102" autocomplete="off">', 'Hikvision …/101 main · …/102 sub-stream. Dahua …/cam/realmonitor?channel=1&subtype=1. An https://…/index.m3u8 link plays directly.') +
        '</div><div class="kjs-btns">' + btn('src-add', 'Add manual source', 'plus', 'kj-btn-primary') + '</div>' });
    var nd = S.net, ns = (nd && nd.summary) || {};
    var GR = { pass: ['PASS', 'success'], warn: ['WARN', 'warn'], fail: ['FAIL', 'danger'], na: ['N/A', ''] };
    var netRows = ((nd && nd.rows) || []).map(function (r) {
      var g = GR[r.overall] || GR.na;
      return '<tr><td><span class="kjs-cell-name">' + esc(r.name) + '</span><div class="kjs-cell-sub">' + esc([r.kind, r.host].filter(Boolean).join(' · ')) + '</div></td>' +
        '<td class="kj-num">' + esc(r.tcp_ms == null ? '—' : r.tcp_ms + ' ms') + '</td><td class="kj-num">' + esc(r.loss_pct == null ? '—' : r.loss_pct + '%') + '</td>' +
        '<td class="kj-num">' + esc(r.ttfb_ms == null ? '—' : r.ttfb_ms + ' ms') + '</td><td class="kj-num">' + esc(r.mbps == null ? '—' : r.mbps + ' Mbps') + '</td>' +
        '<td>' + chip(g[0], g[1]) + '</td><td>' + ((r.kind === 'camera' || r.kind === 'hls' || r.kind === 'skipped') ? btn('net-run', 'Re-test', 'refresh-cw', 'kj-btn-ghost kj-btn-sm', r.name, S.netBusy ? ' disabled' : '') : '') + '</td></tr>';
    });
    var net = card({ icon: 'network', title: 'Network test', sub: nd && nd.at ? String(nd.at).replace('T', ' ').slice(0, 19) + ' · ' + (ns.pass || 0) + ' pass · ' + (ns.warn || 0) + ' warn · ' + (ns.fail || 0) + ' fail' : 'TCP latency, loss, RTSP handshake, TTFB and throughput from the server to every source (up to ~50 s).',
      actions: btn('net-run', S.netBusy ? 'Testing…' : 'Run network test', 'gauge', 'kj-btn-secondary kj-btn-sm', '', S.netBusy ? ' disabled' : ''),
      body: (netRows.length ? '<div class="kj-table-wrap"><table class="kj-table"><thead><tr><th>Target</th><th class="kj-num">TCP</th><th class="kj-num">Loss</th><th class="kj-num">TTFB</th><th class="kj-num">Throughput</th><th>Result</th><th></th></tr></thead><tbody>' + netRows.join('') + '</tbody></table></div>' : '') + msgLine('net') });
    return sec(m, chip(bs.text.split(' · ')[0], bs.tone, true), kpis + '<div class="kjs-grid-2">' + sense + live + '</div>' + sources + net);
  };

  /* ── Floor plans (summary only — the editor lives at #cameras/floorplan) ── */
  RENDER.floorplans = function (m) {
    var d = S.data.plans, plans = d ? (d.plans || d.floorplans || d.items || []) : null;
    var pins = plans ? plans.reduce(function (n, p) { return n + (Array.isArray(p.pins) ? p.pins.length : n0(p.pin_count || p.pins)); }, 0) : 0;
    var body;
    if (!plans && !S.err.plans) body = skel(3);
    else if (!plans || !plans.length) body = P.h.emptyState({ icon: 'map', title: S.err.plans ? 'Floor plans unavailable' : 'No floor plans yet', text: S.err.plans || 'Upload a plan and pin your cameras on it — movement playback uses it.',
      actions: [{ label: 'Open the floor-plan editor', path: 'cameras/floorplan', icon: 'layers', primary: true }] });
    else body = '<div class="kjs-kpis">' + tile('map', String(plans.length), 'Floor plans', 'primary', 'cameras/floorplan') + tile('map-pin', String(pins), 'Camera pins', 'success', 'cameras/floorplan') +
      tile('eye', String(plans.filter(function (p) { return p.active !== false && p.active !== 0 && p.active !== '0'; }).length), 'Active', '', 'cameras/floorplan') + tile('route', 'Playback', 'Movement', 'purple', 'movement') + '</div>' +
      '<div class="kj-list">' + plans.map(function (p) {
        var n = Array.isArray(p.pins) ? p.pins.length : n0(p.pin_count || p.pins);
        return '<button type="button" class="kj-list-item" data-kj-nav="cameras/floorplan"><span class="kj-stat-ico">' + ico('map') + '</span><span class="kj-list-main"><span class="kj-list-title">' + esc(p.name || ('Plan ' + p.id)) + '</span>' +
          '<span class="kj-list-sub">' + n + ' camera pin' + (n === 1 ? '' : 's') + (p.active === false || p.active === 0 || p.active === '0' ? ' · hidden' : '') + '</span></span>' + ico('chevron-right') + '</button>';
      }).join('') + '</div>';
    return sec(m, navBtn('cameras/floorplan', 'Open floor-plan editor', 'layers', 'kj-btn-primary'),
      card({ icon: 'layers', tone: 'primary', title: 'Floor plans & camera pins', sub: 'Plans are edited in Cameras → Floor plan; this is a read-only summary.', body: body }));
  };

  /* ── Camera monitors (GET /api/monitors — fast-model screening + advanced-model review) ── */
  var MON_IV = [[30, '30 s'], [60, '1 m'], [120, '2 m'], [300, '5 m']];
  var MON_CATALOG = [
    { key: 'forklift_ppe', label: 'Forklift PPE', icon: 'forklift', desc: 'A person operating a forklift without the required PPE.' },
    { key: 'ppe_zone', label: 'Area PPE', icon: 'hard-hat', desc: 'A person in this area missing the location\'s required PPE.' }
  ];
  var MON_SRC = { still: ['Snapshot', 'info'], bridge: ['Bridge', 'primary'] };
  function monD() { var d = S.data.mon; return d && typeof d === 'object' ? d : null; }
  function monSet() {
    var s = (monD() || {}).settings || {}, iv = n0(s.interval_sec);
    return { raw: s, enabled: s.enabled !== false && s.enabled !== 0, interval_sec: iv > 0 ? iv : 60, fitness_enabled: s.fitness_enabled !== false && s.fitness_enabled !== 0 };
  }
  function monCatalog() {
    var c = (monD() || {}).catalog;
    c = Array.isArray(c) ? c.filter(function (x) { return x && x.key; }) : [];
    return c.length ? c : MON_CATALOG;
  }
  function monLabel(k) { var c = monCatalog().filter(function (x) { return x.key === k; })[0]; return c ? (c.label || k) : String(k); }
  function monCam(raw) {
    raw = raw || {};
    var cfg = raw.config || {}, act = cfg.action || {}, stt = raw.state || {};
    return {
      stream: String(raw.stream || ''), name: raw.name || raw.stream || '—', location: raw.location || '', online: raw.online !== false && raw.online !== 0,
      frame: raw.frame_source || null, state: stt, fit: stt.fitness || null,
      cfg: { enabled: !!cfg.enabled, fields: Array.isArray(cfg.fields) ? cfg.fields.slice() : [], interval_sec: cfg.interval_sec == null || cfg.interval_sec === '' ? null : n0(cfg.interval_sec),
        action: { ticket: act.ticket !== false, priority: act.priority || 'high', notify_level: n0(act.notify_level) }, force_fit: !!cfg.force_fit }
    };
  }
  function monCams() { var c = (monD() || {}).cameras; return Array.isArray(c) ? c.filter(function (x) { return x && x.stream; }).map(monCam) : []; }
  function monFind(stream) { return monCams().filter(function (c) { return c.stream === stream; })[0] || null; }
  /* backend may report a verdict as {fit} (state file) or {fits} (fitness run result) */
  function monVerdict(c, k) {
    var f = c.fit && c.fit.fields && c.fit.fields[k];
    if (!f || typeof f !== 'object') return { fit: null, reason: '' };
    var v = f.fit != null ? f.fit : f.fits;
    return { fit: v == null ? null : !!v, reason: f.reason || '' };
  }
  function monChecked(c) { return !!(c.fit && (c.fit.checked_at || c.fit.fields)); }
  function monWhen(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'object') v = v.at;
    if (typeof v === 'number') { try { v = new Date(v < 1e12 ? v * 1000 : v).toISOString(); } catch (e) { return ''; } }
    return String(v || '').replace('T', ' ').slice(0, 16);
  }
  function monIvLabel(sec) { var o = MON_IV.filter(function (x) { return x[0] === n0(sec); })[0]; return o ? o[1] : (n0(sec) ? n0(sec) + ' s' : '—'); }
  function monChip(text, tone, title) { return '<span class="kj-chip' + (tone ? ' is-' + tone : '') + '"' + attr('title', title) + '>' + esc(text) + '</span>'; }
  function monSrcChip(c) { var s = MON_SRC[c.frame]; return s ? chip(s[0], s[1]) : monChip('No frame source', '', 'No camera snapshot or live-bridge frame — this camera cannot be monitored yet.'); }
  /* camera-level badge across the chosen fields */
  function monBadge(c) {
    var f = c.cfg.fields;
    if (!f.length) return '<span class="kjs-muted">—</span>';
    if (!monChecked(c)) return monChip('Unchecked', '', 'The daily fitness check has not run on this camera yet.');
    var unfit = f.filter(function (k) { return monVerdict(c, k).fit === false; });
    if (unfit.length) {
      return monChip('✕ Unfit' + (c.cfg.force_fit ? ' · forced' : ''), 'warn', unfit.map(function (k) { return monLabel(k) + ': ' + (monVerdict(c, k).reason || 'scene does not fit'); }).join(' · '));
    }
    if (f.every(function (k) { return monVerdict(c, k).fit === true; })) return monChip('✓ Fit', 'success', (c.fit && (c.fit.scene || c.fit.scene_summary)) || '');
    return monChip('Unchecked', '', 'Some fields have not been checked yet.');
  }
  function monStatsLine() {
    var d = monD() || {}, t = d.stats_today || {}, cr = d.cron || {}, lr = cr.last_run || d.last_run || null;
    var tok = n0(t.tokens_in) + n0(t.tokens_out);
    return (lr ? 'Last run ' + (monWhen(lr) || '—') : 'No scan has run yet') + ' · today ' + n0(t.gates) + ' screened · ' + n0(t.gate_hits) + ' flagged · ' +
      n0(t.reviews) + ' reviewed · ' + n0(t.violations) + ' violations · ' + (tok >= 10000 ? Math.round(tok / 1000) + 'k' : tok) + ' tokens';
  }
  function monCard() {
    var d = monD();
    var head = { icon: 'radar', tone: 'primary', title: 'Camera monitors', sub: 'Fast model screens 1 frame per interval; the advanced model reviews only flagged frames.' };
    if (!d) {
      head.body = S.err.mon ? '<div class="kjs-msg is-err">Camera monitors are unavailable — ' + esc(S.err.mon) + '</div><div class="kjs-btns">' + btn('reload', 'Retry', 'refresh-cw', 'kj-btn-secondary kj-btn-sm') + '</div>' : skel(4);
      return card(head);
    }
    var ms = monSet(), busy = S.monBusy, cams = monCams();
    head.actions = ms.enabled ? chip('Screening every ' + monIvLabel(ms.interval_sec), 'success', true) : chip('Paused', 'warn', true);
    var settingsRows = '<div class="kjs-rows">' +
      row('power', 'Camera monitoring', 'Master switch. Cameras with no monitored field never cost anything.', sw('mon-set', ms.enabled, 'enabled', 'Camera monitoring')) +
      row('timer', 'Scan interval', 'How often the fast model screens one frame per camera. A camera can override this.', opts('mon-iv', MON_IV, ms.interval_sec)) +
      row('scan-search', 'Daily fitness check', 'Once a day the fast model checks each camera\'s scene still fits its fields — unfit fields are paused automatically.', sw('mon-set', ms.fitness_enabled, 'fitness_enabled', 'Daily fitness check')) +
      '</div>';
    var actions = '<div class="kjs-btns">' + btn('mon-scan', busy.scan ? 'Scanning…' : 'Scan now', 'play', 'kj-btn-primary kj-btn-sm', null, busy.scan ? ' disabled' : '') +
      btn('mon-fit', busy.fit ? 'Checking…' : 'Check fitness now', 'scan-search', 'kj-btn-secondary kj-btn-sm', '', busy.fit ? ' disabled' : '') +
      '<button type="button" class="kjs-mon-stats" data-kjs-act="mon-stats" title="Today\'s monitor activity">' + ico('activity') + '<span>' + esc(monStatsLine()) + '</span>' + ico('chevron-right') + '</button></div>';
    var table;
    if (!cams.length) {
      table = P.h.emptyState({ icon: 'cctv', title: 'No cameras to monitor', text: 'Cameras appear here once VisionAI knows them — add one in the camera fleet.',
        actions: [{ label: 'Camera fleet', path: 'cameras/manage', icon: 'cctv' }] });
    } else {
      table = '<div class="kj-table-wrap"><table class="kj-table kjs-table kjs-mon-table"><thead><tr><th>Camera</th><th>Frame source</th><th>Monitoring</th><th>Fitness</th><th>Enabled</th></tr></thead><tbody>' +
        cams.map(function (c) {
          var fields = c.cfg.fields.length ? c.cfg.fields.map(function (k) { return chip(monLabel(k), 'purple'); }).join('') : '<span class="kjs-muted">Not monitored</span>';
          return '<tr class="kjs-mon-row' + (c.cfg.enabled ? '' : ' is-off') + '" data-kjs-act="mon-edit" data-arg="' + esc(c.stream) + '">' +
            '<td><button type="button" class="kjs-click" data-kjs-act="mon-edit" data-arg="' + esc(c.stream) + '"><span class="kjs-dot ' + (c.online ? 'is-success' : 'is-muted') + '"></span><span class="kjs-cell-name">' + esc(c.name) + '</span>' +
              '<div class="kjs-cell-sub">' + esc([c.location, c.stream].filter(Boolean).join(' · ')) + '</div></button></td>' +
            '<td>' + monSrcChip(c) + '</td><td><div class="kjs-mon-chips">' + fields + (c.cfg.interval_sec ? chip('every ' + monIvLabel(c.cfg.interval_sec)) : '') + '</div></td>' +
            '<td>' + monBadge(c) + '</td><td>' + sw('mon-cam-toggle', c.cfg.enabled, c.stream, (c.cfg.enabled ? 'Stop monitoring ' : 'Monitor ') + c.name) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    head.body = settingsRows + actions + msgLine('mon') + table +
      '<div class="kjs-muted">Click a camera to choose what it monitors, what happens on a violation, and to see its daily fitness verdict.</div>';
    return card(head);
  }
  function monPostCam(stream, cfg) {
    return post('/monitors/camera/' + encodeURIComponent(stream), cfg).then(function (r) { return load('mon').then(function () { if (S.el && S.sec === 'ai') paintSection(); return r; }); });
  }
  function monPostSettings(patch) {
    var ms = monSet(), o = {};
    Object.keys(ms.raw).forEach(function (k) { o[k] = ms.raw[k]; });
    o.enabled = ms.enabled; o.interval_sec = ms.interval_sec; o.fitness_enabled = ms.fitness_enabled;
    Object.keys(patch).forEach(function (k) { o[k] = patch[k]; });
    return post('/monitors/settings', o).then(function (r) {
      var d = monD(); if (d) d.settings = (r && r.settings) || o;
      paintSection(); load('mon').then(function () { if (S.el && S.sec === 'ai') paintSection(); });
      return r;
    });
  }
  function monStatsText(st) {
    st = st || {};
    var pick = function (keys) { for (var i = 0; i < keys.length; i++) if (st[keys[i]] != null) return n0(st[keys[i]]); return 0; };
    return pick(['frames', 'scanned', 'gates']) + ' frames screened · ' + pick(['gate_hits', 'hits']) + ' flagged · ' + pick(['reviews', 'reviewed']) + ' reviewed · ' +
      pick(['violations']) + ' violations' + (pick(['errors']) ? ' · ' + pick(['errors']) + ' errors' : '') + (st.locked ? ' · another scan is in progress' : '') + (st.disabled ? ' · monitoring is switched off' : '');
  }

  /* ── AI & Claude ─────────────────────────────────────────────────────── */
  RENDER.ai = function (m) {
    var st = S.data.settings, md = S.data.models, th = S.data.th;
    if (!st) return sec(m, '', S.err.settings ? errBox('settings', 'AI settings') : '<div class="kjs-card">' + skel(5) + '</div>');
    var src = st.ai_source === 'off' ? 'off' : 'claude';
    var ready = md ? !!md.ready : null;
    var status = ready === null ? chip(S.err.models ? 'Status unavailable' : 'Checking…', '', true) : (ready ? chip('API key configured', 'success', true) : chip('CLAUDE_API_KEY missing', 'danger', true));
    var srcCard = card({ icon: 'sparkles', tone: 'purple', title: 'AI source', sub: 'Shift review remarks, forecasts, reports and the assistant.',
      actions: status,
      body: '<div class="kjs-seg" role="radiogroup" aria-label="AI source">' +
        '<button type="button" role="radio" aria-checked="' + (src === 'claude') + '" class="kjs-seg-btn' + (src === 'claude' ? ' is-on' : '') + '" data-kjs-act="ai-src" data-arg="claude">' + ico('sparkles') + '<span>On</span></button>' +
        '<button type="button" role="radio" aria-checked="' + (src === 'off') + '" class="kjs-seg-btn' + (src === 'off' ? ' is-on is-off-on' : '') + '" data-kjs-act="ai-src" data-arg="off">' + ico('power') + '<span>Off</span></button></div>' +
        '<div class="kjs-muted">The API key lives only in the server <span class="kjs-mono">.env</span> as <span class="kjs-mono">CLAUDE_API_KEY</span> — it is never sent to the browser or stored from this page.</div>' });
    var routes = md && md.routes ? Object.keys(md.routes).map(function (k) { var r = md.routes[k] || {};
      return '<tr><td><span class="kjs-cell-name">' + esc(k) + '</span></td><td class="kjs-mono">' + esc(r.model || '—') + '</td><td class="kj-num">' + esc(r.max_tokens || '—') + '</td><td>' + chip(r.effort || '—', r.effort === 'high' ? 'purple' : (r.effort === 'medium' ? 'info' : '')) + '</td><td class="kj-num">' + esc(r.timeout_s ? r.timeout_s + ' s' : '—') + '</td></tr>'; }).join('') : '';
    var routing = card({ icon: 'cpu', title: 'Model routing', sub: 'Callers name a use case, never a model.',
      body: routes ? '<div class="kj-table-wrap"><table class="kj-table"><thead><tr><th>Use case</th><th>Model</th><th class="kj-num">Max tokens</th><th>Effort</th><th class="kj-num">Timeout</th></tr></thead><tbody>' + routes + '</tbody></table></div>'
        : (S.err.models ? '<div class="kjs-msg is-err">' + esc(S.err.models) + '</div>' : skel(3)) });
    var pr = S.pipe, stats = pr && pr.stats;
    var pipe = card({ icon: 'scan-eye', tone: 'primary', title: 'PPE-forklift review pipeline', sub: 'Face detections → environment frame → AI vision review → ticket when a person operates a forklift without PPE.',
      actions: btn('pipe', 'Dry run', 'flask-conical', 'kj-btn-secondary kj-btn-sm', 'dry') + btn('pipe', 'Run now', 'play', 'kj-btn-primary kj-btn-sm', 'run'),
      body: '<dl class="kj-kv">' + [['Rate limit', '1 review / person / 60 s'], ['Ongoing-event gap', '600 s (same ticket extended)'], ['Max reviews per run', '6'], ['Max detection age', '1800 s'],
        ['Min confidence', '0.6'], ['Dedup key', 'person + location + episode start']].map(function (r) { return '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>'; }).join('') + '</dl>' +
        '<div class="kjs-muted">Defaults shown — override with <span class="kjs-mono">AI_PIPELINE_ENABLED · _RATE_SEC · _GAP_SEC · _MAX_REVIEWS · _MAX_AGE_SEC · _MIN_CONFIDENCE</span> in <span class="kjs-mono">.env</span>.</div>' +
        (stats ? '<div class="kjs-btns">' + (stats.disabled ? chip('Pipeline disabled in .env', 'danger', true) : chip(pr.dry ? 'Dry run' : 'Run', 'info')) +
          [['scanned', 'scanned'], ['reviewed', 'reviewed'], ['violations', 'violations'], ['tickets_opened', 'tickets opened'], ['tickets_extended', 'extended'], ['rate_limited', 'rate-limited'], ['errors', 'errors']]
            .map(function (k) { return chip(n0(stats[k[0]]) + ' ' + k[1], k[0] === 'errors' && n0(stats.errors) ? 'danger' : (k[0] === 'violations' && n0(stats.violations) ? 'orange' : '')); }).join('') +
          (stats.locked ? chip('another run is in progress', 'warn') : '') + '</div>' : '') + msgLine('pipe') });
    var cron = card({ icon: 'timer', tone: 'warn', cls: 'is-notice', title: 'Cron required', sub: 'The pipeline (and ticket SLA breach sweep) only runs when called. Add this cPanel cron job — every minute — replacing PROVISION_TOKEN with the provision token from the server .env.',
      body: copyLine('cPanel → Cron Jobs → Once per minute', CRON_LINE) + copyLine('Alternative (PHP CLI)', CRON_PHP) +
        '<div class="kjs-muted">Both are safe together — a run holds a lock and the per-person rate gate is shared.</div>' });
    var t = th || {};
    var thCard = card({ icon: 'sliders-horizontal', title: 'Detection thresholds', sub: 'Applied when a SenseStudio push arrives; training itself happens in SenseStudio.',
      body: th ? '<div class="kjs-form">' + field('Face match — minimum similarity %', inp('th', 'face', String(t.face_min_similarity), { type: 'number', min: 0, max: 100, step: 0.5 }), 'Below this the match is stored as an unknown person. 0 = SenseStudio decides.') +
          field('PPE attribute — minimum confidence %', inp('th', 'ppe', String(t.ppe_min_conf), { type: 'number', min: 0, max: 100, step: 0.5 }), 'Lower-confidence helmet / vest / glove attributes count as "not reported". 0 = off.') + '</div>'
        : (S.err.th ? '<div class="kjs-msg is-err">' + esc(S.err.th) + '</div>' : skel(2)) });
    return sec(m, src === 'off' ? chip('AI off', 'danger', true) : chip('AI active', 'success', true), monCard() + srcCard + cron + pipe + '<div class="kjs-grid-2">' + routing + thCard + '</div>');
  };

  /* ── Tickets & SLA ───────────────────────────────────────────────────── */
  function slaSaved(pr, k) { var p = (S.data.sla && S.data.sla.policy) || {}; return n0((p[pr] || {})[k]); }
  function slaPart(pr, k) {
    var mins = slaSaved(pr, k), u = bestUnit(mins);
    return { n: dv('sla', pr + '.' + k + '.n', String(mins / UNIT_MIN[u])), u: dv('sla', pr + '.' + k + '.u', u), savedN: String(mins / UNIT_MIN[u]), savedU: u };
  }
  function slaDraftMinutes() {
    var out = {};
    PRIOS.forEach(function (p) {
      out[p[0]] = {};
      ['response', 'resolution'].forEach(function (k) { var s = slaPart(p[0], k); out[p[0]][k] = Math.round(parseFloat(s.n) * (UNIT_MIN[s.u] || 1)) || 0; });
    });
    return out;
  }
  function durInput(pr, k, disabled) {
    var s = slaPart(pr, k), label = (k === 'response' ? 'First response' : 'Resolution') + ' — ' + pr;
    return '<div class="kjs-dur"><input class="kj-input" type="number" min="1" step="1" aria-label="' + esc(label) + '" data-kjs-ns="sla" data-kjs-key="' + pr + '.' + k + '.n" data-kjs-saved="' + esc(s.savedN) + '" value="' + esc(s.n) + '"' + (disabled ? ' disabled' : '') + '>' +
      '<select class="kj-select" aria-label="' + esc(label) + ' unit" data-kjs-ns="sla" data-kjs-key="' + pr + '.' + k + '.u" data-kjs-saved="' + s.savedU + '"' + (disabled ? ' disabled' : '') + '>' +
      UNITS.map(function (u) { return '<option value="' + u[0] + '"' + (u[0] === s.u ? ' selected' : '') + '>' + u[1] + '</option>'; }).join('') + '</select></div>';
  }
  function slaBars() {
    var pol = slaDraftMinutes(), max = 1;
    PRIOS.forEach(function (p) { max = Math.max(max, pol[p[0]].response, pol[p[0]].resolution); });
    var lg = function (v) { return v > 0 ? Math.max(4, Math.log(v + 1) / Math.log(max + 1) * 100) : 0; };
    var out = {};
    PRIOS.forEach(function (p) { var x = pol[p[0]]; out[p[0]] = { r: w5(lg(x.response)), s: w5(lg(x.resolution)), bad: !(x.response > 0 && x.resolution > 0) ? 'Enter a positive number for both targets.' : (x.resolution < x.response ? 'Resolution must be at least the first-response target.' : '') }; });
    return out;
  }
  function updateSlaBars() {
    if (!S.el) return;
    var b = slaBars();
    Object.keys(b).forEach(function (pr) {
      var r = S.el.querySelector('[data-kjs-bar="' + pr + '.r"]'), s = S.el.querySelector('[data-kjs-bar="' + pr + '.s"]'), e = S.el.querySelector('[data-kjs-slaerr="' + pr + '"]');
      if (r) r.className = 'kj-progress-fill kjs-fill-response ' + b[pr].r;
      if (s) s.className = 'kj-progress-fill kjs-fill-resolution ' + b[pr].s;
      if (e) e.textContent = b[pr].bad;
    });
  }
  function notifyS() { return (S.data.notify && S.data.notify.settings) || {}; }
  RENDER.tickets = function (m) {
    var sla = S.data.sla, admin = isAdminTier();
    var editor;
    if (!sla) editor = S.err.sla ? errBox('sla', 'the SLA policy') : skel(4);
    else {
      var bars = slaBars();
      editor = '<div class="kjs-sla" role="table" aria-label="SLA policy"><div class="kjs-sla-row is-head" role="row"><span role="columnheader">Priority</span><span role="columnheader">' + ico('clock') + 'First response</span><span role="columnheader">' + ico('clock') + 'Resolution target</span></div>' +
        PRIOS.map(function (p) {
          return '<div class="kjs-sla-row" role="row"><span role="cell"><button type="button" class="kj-chip kjs-prio' + (p[3] ? ' is-' + p[3] : '') + '" data-kj-nav="tickets" title="Open the ticket board">' + ico(p[2]) + esc(p[1]) + '</button></span>' +
            '<span role="cell">' + durInput(p[0], 'response', !admin) + '</span><span role="cell">' + durInput(p[0], 'resolution', !admin) + '</span>' +
            '<div class="kjs-sla-bar"><div class="kj-progress"><div class="kj-progress-fill kjs-fill-response ' + bars[p[0]].r + '" data-kjs-bar="' + p[0] + '.r"></div></div>' +
            '<div class="kj-progress"><div class="kj-progress-fill kjs-fill-resolution ' + bars[p[0]].s + '" data-kjs-bar="' + p[0] + '.s"></div></div></div>' +
            '<div class="kjs-sla-err" data-kjs-slaerr="' + p[0] + '">' + esc(bars[p[0]].bad) + '</div></div>';
        }).join('') + '</div>' +
        '<div class="kjs-sla-legend"><span><i class="kjs-fill-response"></i>First response</span><span><i class="kjs-fill-resolution"></i>Resolution</span><span>Log scale · deadlines are stamped when a ticket is created</span></div>' +
        (admin ? '' : '<div class="kjs-muted">Read-only — changing the SLA policy needs an admin role with the settings permission.</div>');
    }
    var slaCard = card({ icon: 'clock', title: 'SLA policies', sub: 'Define response and resolution targets for each priority.', body: editor });
    var nd = S.data.notify, ns = notifyS(), es = ns.escalation || {}, tg = ns.telegram || {}, ch = (nd && nd.channels) || {}, al = S.data.alerts;
    var auto;
    if (!nd && !S.err.notify) auto = skel(4);
    else if (!nd) auto = '<div class="kjs-msg is-err">' + esc(S.err.notify) + '</div>';
    else {
      var unit = es.unattended_min || 5;
      auto = '<div class="kjs-rows">' +
        row('ticket-plus', 'Auto-create tickets', 'Confirmed PPE-forklift violations open a High ticket with WebP proof (one per person, location and episode).',
          navBtn('settings/ai', 'Pipeline', 'sparkles', 'kj-btn-ghost kj-btn-sm')) +
        row('trending-up', 'Escalate unattended alerts', 'Open alerts that nobody acknowledges climb L1 → L2 → L3 every ' + unit + ' min. Acknowledging or resolving stops the chain.',
          sw('esc-toggle', !!es.enabled, null, 'Escalate unattended alerts'),
          opts('esc-min', [[1, '1 min'], [5, '5 min'], [10, '10 min'], [15, '15 min']], unit) + opts('esc-sev', [['medium', 'Medium +'], ['high', 'High +'], ['critical', 'Critical only']], es.min_severity || 'high')) +
        row('mail', 'E-mail alerts', ch.email && ch.email.ready ? 'Ready · ' + (ch.email.recipients || 0) + ' base recipient(s)' : (ch.email && !ch.email.configured ? 'SMTP not configured — Settings → Integrations → System e-mail' : 'Not ready'),
          al ? sw('mail-toggle', al.email_enabled !== false, null, 'E-mail alerts') : '') +
        row('send', 'Telegram alerts', tg.has_token ? ((tg.chat_ids || []).length + ' chat(s) · ' + (ch.telegram && ch.telegram.ready ? 'ready' : 'not ready')) : 'No bot token yet — set it under Integrations',
          sw('tg-toggle', !!tg.enabled, null, 'Telegram alerts')) +
        '</div><div class="kjs-btns">' + btn('esc-run', 'Preview escalations', 'eye', 'kj-btn-secondary kj-btn-sm', 'dry') + btn('esc-run', 'Run escalation now', 'play', 'kj-btn-secondary kj-btn-sm', 'run') +
        navBtn('settings/rules', 'Alert rules', 'bell-ring', 'kj-btn-ghost kj-btn-sm') + '</div>' + escResHtml() + msgLine('esc');
    }
    var autoCard = card({ icon: 'bell', title: 'Automation & notifications', body: auto });
    var levels = '';
    if (nd) {
      var lvCol = ['warn', 'orange', 'danger'], lv = es.levels || [{}, {}, {}], u2 = es.unattended_min || 5;
      levels = card({ icon: 'workflow', title: 'Escalation levels', sub: 'Who hears about an unattended alert, and when.',
        body: [0, 1, 2].map(function (i) { var l = lv[i] || {};
          return '<div class="kjs-card"><div class="kjs-btns">' + chip('L' + (i + 1), lvCol[i], true) + '<span class="kjs-muted">after ' + (u2 * (i + 1)) + ' min unattended</span></div><div class="kjs-form">' +
            field('Name', inp('esc', i + '.name', l.name || '', { ph: ['Shift supervisor', 'Safety officer', 'Plant manager'][i] })) +
            field('E-mails', inp('esc', i + '.emails', (l.emails || []).join(', '), { ph: 'a@x.com, b@x.com' }), 'Comma-separated — every address is notified.') +
            field('Telegram chat IDs', inp('esc', i + '.chats', (l.chats || []).join(', '), { ph: '-100…' }), (!(l.emails || []).length && !(l.chats || []).length) ? 'No recipients — this level is logged only.' : '', 'is-wide') + '</div></div>';
        }).join('') });
    }
    return sec(m, sla ? chip('Policy active', 'success', true) : '', slaCard + autoCard + levels);
  };
  function escResHtml() {
    var er = S.escRes; if (!er) return '';
    var rows = (er.escalated || []).slice(0, 20).map(function (x) {
      return '<div class="kj-list-item"' + (x.id || x.event_id ? ' data-kj-modal="event:' + esc(encodeURIComponent(x.id || x.event_id)) + '"' : '') + '><span class="kj-list-main"><span class="kj-list-title">L' + esc(x.level) + ' · ' + esc(x.title || '') + '</span><span class="kj-list-sub">' +
        esc([x.camera, x.level_name, 'unattended ' + x.unattended_min + ' min'].filter(Boolean).join(' · ')) + '</span></span></div>';
    }).join('');
    return '<div class="kjs-card"><div class="kjs-btns">' + chip(er.dry_run ? 'Preview' : 'Run', 'info') + '<span class="kjs-muted">' + esc((er.ran_at || '') + ' · ' + (er.checked || 0) + ' open alerts checked · ' + (er.escalated || []).length + ' due · ' + (er.pending || []).length + ' upcoming') + '</span></div>' +
      (rows ? '<div class="kj-list">' + rows + '</div>' : '<div class="kjs-muted">Nothing to escalate right now.</div>') + '</div>';
  }

  /* ── Alert rules (native; was the classic dc page) ───────────────────────
   * Instant-save like the legacy saveAlerts(): every click POSTs a patch to /alerts
   * (storage/alert_settings.json overlay) and toasts. Condition rules POST the whole
   * list to /notify/settings {conditions}, exactly the shape the legacy page sent. */
  var AR_MODS = [   // [key, tag, icon, name, condition, default severity]
    ['fire', 'FIRE', 'flame', 'Fire & smoke', 'Any smoke / flame push from VisionAI', 'critical'],
    ['ppe', 'PPE', 'hard-hat', 'PPE violation', 'Missing vest / helmet body attribute', 'medium'],
    ['intr', 'INTR', 'shield-alert', 'Intrusion detection', 'Person in a monitored zone · the armed window applies', 'high'],
    ['face', 'FACE', 'scan-face', 'Face & body / stranger', 'Stranger (Person Group −99) escalates to HIGH', 'high'],
    ['forklift', 'FORK', 'forklift', 'Forklift zone violation', 'Vehicle / forklift in a prohibited or time-restricted zone', 'high']
  ];
  var SEV_TONE = { critical: 'danger', high: 'orange', medium: 'info', low: '' };
  var AR_SEV = [['low', 'Every detection'], ['medium', 'Medium +'], ['high', 'High +'], ['critical', 'Critical only'], ['off', 'Off']];
  var AR_COOL = [[1, '1 min'], [5, '5 min'], [15, '15 min'], [30, '30 min'], [60, '60 min']];
  var AR_ARMED = [['always', 'Always armed'], ['22:00-06:00', 'After hours 22:00–06:00'], ['06:00-22:00', 'Working hours 06:00–22:00'], ['off', 'Disarmed']];
  var COND_MODS = [['any', 'Any module'], ['fire', 'Fire & Smoke'], ['ppe', 'PPE'], ['intr', 'Intrusion'], ['face', 'Face & Body'], ['forklift', 'Forklift'], ['behaviour', 'Behaviour']];
  var COND_SEV = [['low', 'Any severity'], ['medium', 'Medium +'], ['high', 'High +'], ['critical', 'Critical']];
  var COND_WIN = [['always', '24 h'], ['22:00-06:00', 'After hours 22:00–06:00'], ['06:00-22:00', 'Working hours 06:00–22:00'], ['19:00-07:00', 'Night shift 19:00–07:00'], ['07:00-19:00', 'Day shift 07:00–19:00']];
  function lbl(list, v) { var x = list.filter(function (o) { return String(o[0]) === String(v); })[0]; return x ? x[1] : String(v == null ? '' : v); }
  function alertMailList(al) { return emailSplit((al && al.mail_to) || []); }
  function modsEnabled(al) { var cur = (al && al.mods_enabled) || {}, me = {}; AR_MODS.forEach(function (x) { me[x[0]] = cur[x[0]] !== false; }); return me; }
  function conditions() { var c = notifyS().conditions; return Array.isArray(c) ? c : []; }
  function condDesc(c) {
    return [lbl(COND_MODS, c.mod || 'any'), c.camera ? String(c.camera).toUpperCase() : 'any camera', 'severity ≥ ' + (c.min_sev || 'low'),
      (c.window || 'always') === 'always' ? '24 h' : c.window].join(' · ') + (c.keyword ? ' · matches "' + c.keyword + '"' : '');
  }
  function camOptions() {
    var nd = S.data.notify, a = A(), fleet = ((a && a.state) || {}).fleet || [], seen = {};
    return ((nd && nd.cameras) || []).concat(fleet.map(function (f) { return f && f.stream; })).map(function (c) { return String(c || '').toLowerCase(); })
      .filter(function (c) { if (!c || seen[c]) return false; seen[c] = 1; return true; }).slice(0, 80);
  }
  RENDER.rules = function (m) {
    var al = S.data.alerts;
    if (!al) return sec(m, '', S.err.alerts ? errBox('alerts', 'the alert rules') : '<div class="kjs-card">' + skel(6) + '</div>');
    var me = modsEnabled(al), am = al.always_mods || [], emailOn = al.email_enabled !== false;
    var active = AR_MODS.filter(function (x) { return me[x[0]]; }).length;
    var mods = card({ icon: 'bell-ring', tone: 'primary', title: 'Detection rules', sub: '"Always e-mail" sends every detection of that module; "Severity-based" follows the minimum severity below. Changes save instantly.',
      actions: chip(active + ' of ' + AR_MODS.length + ' modules alerting', active ? 'success' : 'warn', true),
      body: '<div class="kjs-rows">' + AR_MODS.map(function (x) {
        var on = me[x[0]], always = am.indexOf(x[0]) >= 0;
        return row(x[2], x[3], x[4], sw('ar-mod', on, x[0], x[3] + ' alerts'),
          chip(x[1], 'primary') + chip(x[5], SEV_TONE[x[5]], true) +
          opts('ar-always', [['1', 'Always e-mail'], ['0', 'Severity-based']], always ? '1' : '0', !on, ' data-mod="' + x[0] + '"'));
      }).join('') + '</div>' });
    var to = alertMailList(al), mailVal = S.arMail != null ? S.arMail : to.join(', ');
    var mailCard = card({ icon: 'mail', tone: !emailOn ? 'warn' : (al.mail_ready ? 'success' : 'warn'), title: 'E-mail channel',
      sub: !emailOn ? 'Switched off — nobody is e-mailed until this is back on' : (al.mail_ready ? 'Ready · ' + to.length + ' recipient' + (to.length === 1 ? '' : 's') : 'Not ready — set the SMTP server (Integrations) and at least one recipient'),
      actions: sw('mail-toggle', emailOn, null, 'E-mail alerts'),
      body: '<div class="kjs-inline">' + field('Recipients', '<input class="kj-input" type="text" data-kjs-local="ar-mail" value="' + esc(mailVal) + '" placeholder="ops@company.com, soc@company.com" autocomplete="off" spellcheck="false">',
          'Comma-separated — every address gets the alert') + btn('ar-mail', 'Apply', 'check', 'kj-btn-secondary') + '</div>' +
        group('Interval', opts('ar-cool', AR_COOL, al.cooldown_min), 'Minimum gap between e-mails per camera + module.') +
        group('Minimum severity that e-mails', opts('ar-sev', AR_SEV, al.min_severity || 'high')) +
        '<div class="kjs-btns">' + btn('alerts-test', 'Send test e-mail', 'send', 'kj-btn-secondary kj-btn-sm') + navBtn('settings/integrations', 'SMTP server', 'server', 'kj-btn-ghost kj-btn-sm') + '</div>' + msgLine('ar') });
    var armed = al.intr_armed || 'always', live = al.armed_now !== false;
    var armChip = armed === 'off' ? chip('DISARMED', '', true) : (live ? chip('ARMED', 'danger', true) : chip('STANDBY · outside window', 'warn', true));
    var custom = AR_ARMED.some(function (o) { return o[0] === armed; }) ? [] : [[armed, armed]];
    var intrCard = card({ icon: 'shield-alert', tone: armed === 'off' ? '' : 'danger', title: 'Intrusion armed window', sub: 'Intrusion detections alert only inside this window.', actions: armChip,
      body: opts('ar-armed', AR_ARMED.concat(custom), armed) +
        '<div class="kjs-muted">Detections are always recorded and shown on the dashboard regardless of the window.</div>' +
        '<div class="kjs-flow"><span class="kjs-access-lbl">How alerts flow</span><ol class="kjs-flow-steps">' +
          '<li>VisionAI push → ingest API</li><li>Detection rules + condition rules on this page</li><li>E-mail and Telegram, throttled by the interval</li>' +
          '<li>Unattended alerts auto-escalate L1 → L2 → L3</li></ol>' +
          '<div class="kjs-muted">The bell and the dashboard always show every detection.</div>' +
          '<div class="kjs-btns">' + navBtn('settings/tickets', 'Escalation levels', 'workflow', 'kj-btn-ghost kj-btn-sm') + navBtn('settings/integrations', 'Telegram', 'send', 'kj-btn-ghost kj-btn-sm') + '</div></div>' });
    var nd = S.data.notify, conds = conditions(), condBody;
    if (!nd) condBody = S.err.notify ? '<div class="kjs-msg is-err">' + esc(S.err.notify) + '</div>' : skel(3);
    else if (!conds.length) condBody = P.h.emptyState({ icon: 'filter', title: 'No condition rules yet', text: 'Add one to alert in real time when a detection matches a module, camera, severity, time window or keyword.' });
    else condBody = '<div class="kjs-rows">' + conds.map(function (c, i) {
      var ch = c.channels || {}, on = c.enabled !== false;
      var chans = (ch.email ? chip('E-mail', 'info') : '') + (ch.telegram ? chip('Telegram', 'primary') : '') + (!ch.email && !ch.telegram ? chip('No channel', 'warn') : '');
      return row('filter', c.name || 'Untitled rule', condDesc(c),
        '<div class="kjs-btns">' + btn('cond-edit', 'Edit', 'pencil', 'kj-btn-ghost kj-btn-sm', i) +
          '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon kj-btn-sm" data-kjs-act="cond-del" data-arg="' + i + '" aria-label="Delete ' + esc(c.name || 'rule') + '">' + ico('trash-2') + '</button>' +
          sw('cond-toggle', on, i, (c.name || 'Rule') + ' enabled') + '</div>', chans);
    }).join('') + '</div>';
    var condCard = card({ icon: 'filter', title: 'Predefined condition rules', sub: 'Alert in real time when a detection matches · module · camera · severity · time window · keyword.',
      actions: btn('cond-add', 'Add rule', 'plus', 'kj-btn-primary kj-btn-sm', null, nd && conds.length < 50 ? '' : ' disabled'), body: condBody });
    var right = '<div class="kjs-btns">' + chip(emailOn ? 'E-mail on' : 'E-mail off', emailOn ? 'success' : 'warn', true) + chip(active + ' / ' + AR_MODS.length + ' modules', active ? 'primary' : 'warn') + '</div>';
    return sec(m, right, mods + '<div class="kjs-grid-2">' + mailCard + intrCard + '</div>' + condCard);
  };
  function alertsPost(patch, ok) {
    var prev = S.data.alerts || {}, opt = {};
    Object.keys(prev).forEach(function (k) { opt[k] = prev[k]; });
    Object.keys(patch).forEach(function (k) { opt[k] = patch[k]; });
    S.data.alerts = opt; paintSection();
    return post('/alerts', patch).then(function (d) {
      var cur = S.data.alerts || {}, s = d.settings || {};
      Object.keys(s).forEach(function (k) { cur[k] = s[k]; });   // server-sanitized values (arrays normalized there)
      S.data.alerts = cur; toast(ok || 'Saved'); paintSection();
      return load('alerts').then(function () { if (S.el) paintSection(); });   // effective values: armed_now, mail_ready, .env fallbacks
    }, function (e) { S.data.alerts = prev; toast('Save failed — ' + e.message, 'danger'); paintSection(); });
  }
  function saveConditions(list, ok) {
    return post('/notify/settings', { conditions: list }).then(function (d) { S.data.notify = d; toast(ok || 'Condition rules saved'); if (S.el) paintSection(); return d; },
      function (e) { toast('Save failed — ' + e.message, 'danger'); throw e; });
  }

  /* ── Roles & Permissions ─────────────────────────────────────────────── */
  var WIDGETS_BY_PERM = {
    view: 'KPI tiles, live cameras, detections timeline, attendance today, movement',
    triage: 'Open-alerts queue with acknowledge / resolve',
    tickets: 'Ticket board, SLA rings, my tickets',
    reports: 'AI reports, exports, comprehensive report',
    settings: 'Alert rules, settings, floor-plan editor',
    users: 'User & role administration'
  };
  function accessFor(name, perms) {
    var nav = ((window.KJShell && window.KJShell.NAV) || []).filter(function (n) { var mod = P.get(n.hub); return mod && (!mod.perm || perms[mod.perm]); }).map(function (n) { return n.label; });
    var land = (name === 'operator' || name === 'viewer') ? 'My attendance app' : (name === 'supervisor' ? 'Attendance' : 'Dashboard');
    var W = window.KJWidgets, cat = null;
    try { cat = W ? (typeof W.catalog === 'function' ? W.catalog() : (W.catalog || (typeof W.list === 'function' ? W.list() : null))) : null; } catch (e) { cat = null; }
    var widgets = Array.isArray(cat) && cat.length
      ? cat.filter(function (w) { return !w.perm || perms[w.perm]; }).map(function (w) { return w.title || w.label || w.name || w.id; })
      : Object.keys(WIDGETS_BY_PERM).filter(function (p) { return perms[p]; }).map(function (p) { return WIDGETS_BY_PERM[p]; });
    return '<div class="kjs-access"><span class="kjs-access-lbl">Lands on</span><div class="kjs-btns">' + chip(land, 'primary', true) + '</div>' +
      '<span class="kjs-access-lbl">Sidebar</span><div class="kjs-btns">' + (nav.length ? nav.map(function (n) { return chip(n); }).join('') : '<span class="kjs-muted">Staff app only</span>') + '</div>' +
      '<span class="kjs-access-lbl">Dashboard widgets</span><div class="kjs-btns">' + (widgets.length ? widgets.map(function (w) { return chip(w, 'info'); }).join('') : '<span class="kjs-muted">None</span>') + '</div></div>';
  }
  RENDER.roles = function (m) {
    var d = S.data.roles;
    if (!d) return sec(m, '', S.err.roles ? errBox('roles', 'roles') : '<div class="kjs-card">' + skel(6) + '</div>');
    var labels = d.permLabels || {}, keys = Object.keys(labels);
    var cards = (d.roles || []).map(function (r) {
      var eff = {};
      keys.forEach(function (p) { eff[p] = dv('roles', r.name + '|' + p, (r.perms || {})[p] ? '1' : '0') === '1'; });
      var perms = keys.map(function (p) {
        var locked = r.name === 'admin' && (p === 'users' || p === 'view');
        return '<div class="kjs-perm"><div class="kjs-perm-text"><div class="kjs-perm-key">' + esc(p) + (locked ? ' ' + chip('locked', '') : '') + '</div><div class="kjs-perm-desc">' + esc(labels[p]) + '</div></div>' +
          sw('perm', eff[p], r.name + '|' + p, r.name + ': ' + p, locked) + '</div>';
      }).join('');
      return card({ icon: r.builtin ? 'shield' : 'shield-plus', tone: r.name === 'admin' ? 'purple' : 'primary', title: r.name, sub: r.desc || '—',
        actions: '<button type="button" class="kj-chip" data-kjs-act="u-filter" data-arg="role:' + esc(r.name) + '">' + ico('users') + esc(r.users + ' user' + (r.users === 1 ? '' : 's')) + '</button>' + (r.builtin ? chip('built-in') : '') +
          (!r.builtin ? btn('role-del', 'Delete', 'trash-2', 'kj-btn-ghost kj-btn-sm', r.name, r.users ? ' disabled title="Reassign its users first"' : '') : ''),
        body: '<div>' + perms + '</div>' + accessFor(r.name, eff) });
    }).join('');
    var create = card({ icon: 'plus', title: 'Create role', sub: 'New roles start with view-only access — toggle permissions after creating.',
      body: '<div class="kjs-form">' + field('Role name', '<input class="kj-input" data-kjs-local="nr-name" placeholder="e.g. safety-officer" autocomplete="off">', 'a-z, 0-9, - and _') +
        field('Description', '<input class="kj-input" data-kjs-local="nr-desc" placeholder="What this role is for" autocomplete="off">') + '</div><div class="kjs-btns">' + btn('role-new', 'Create role', 'plus', 'kj-btn-primary') + '</div>' });
    return sec(m, chip((d.roles || []).length + ' roles', 'primary'), '<div class="kjs-roles">' + cards + '</div>' + create +
      '<div class="kjs-muted">Permissions are enforced by the server on every request; the sidebar and widgets simply follow them. The admin role always keeps view + users (lock-out guard).</div>');
  };

  /* ── Users ───────────────────────────────────────────────────────────── */
  function personMap() { var o = {}; ((S.data.links && S.data.links.people) || []).forEach(function (p) { o[p.person_id] = p; }); return o; }
  function linkOf(uid) { return ((S.data.links && S.data.links.users) || []).filter(function (x) { return x.id === uid; })[0] || null; }
  function linkBtn(u) {
    var L = linkOf(u.id), pm = personMap();
    if (!S.data.links) return S.err.links ? '<span class="kjs-muted">' + esc(S.err.links) + '</span>' : '<span class="kjs-muted">…</span>';
    var pid = L && (L.person_id || L.implicit_person_id), p = pid ? pm[pid] : null;
    var cls = L && L.person_id ? ' is-linked' : (pid ? ' is-auto' : '');
    var label = p ? (p.name + (p.staff_id ? ' · ' + p.staff_id : '')) : (pid ? pid : 'Link employee');
    return '<div class="kjs-btns"><button type="button" class="kjs-link-btn' + cls + '" data-kjs-act="u-link" data-arg="' + u.id + '" title="' + esc(L && L.person_id ? 'Linked employee — click to change' : (pid ? 'Matched automatically (staff ID = username) — click to link explicitly' : 'Link this login to an employee record')) + '">' +
      ico(pid ? 'link' : 'link-2-off') + '<span>' + esc((pid && !(L && L.person_id) ? 'auto: ' : '') + label) + '</span></button>' +
      (pid ? '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon kj-btn-sm" data-kj-modal="person:' + esc(encodeURIComponent(pid)) + '" aria-label="Open employee">' + ico('eye') + '</button>' : '') + '</div>';
  }
  function userMatches(u) {
    var f = S.uFilter, L = linkOf(u.id);
    if (f === 'active' && !u.active) return false;
    if (f === 'inactive' && u.active) return false;
    if (f === 'unlinked' && L && (L.person_id || L.implicit_person_id)) return false;
    if (f === 'linked' && !(L && (L.person_id || L.implicit_person_id))) return false;
    if (f.indexOf('role:') === 0 && u.role !== f.slice(5)) return false;
    var q = S.uQuery.trim().toLowerCase();
    return !q || [u.name, u.username, u.email, u.role].join(' ').toLowerCase().indexOf(q) >= 0;
  }
  RENDER.users = function (m) {
    var users = S.data.users;
    if (!users) return sec(m, '', S.err.users ? errBox('users', 'users') : '<div class="kjs-card">' + skel(6) + '</div>');
    var roles = ((S.data.roles && S.data.roles.roles) || []).map(function (r) { return r.name; });
    if (!roles.length) roles = ['admin', 'supervisor', 'operator', 'viewer'];
    var linked = users.filter(function (u) { var L = linkOf(u.id); return L && (L.person_id || L.implicit_person_id); }).length;
    var kpis = '<div class="kjs-kpis">' + tile('users', String(users.length), 'All users', S.uFilter === 'all' ? 'success' : '', null, 'u-filter', 'all') +
      tile('user-check', String(users.filter(function (u) { return u.active; }).length), 'Active', S.uFilter === 'active' ? 'success' : '', null, 'u-filter', 'active') +
      tile('link', S.data.links ? linked + ' / ' + users.length : '…', 'Linked to an employee', S.uFilter === 'linked' ? 'success' : 'purple', null, 'u-filter', 'linked') +
      tile('link-2-off', S.data.links ? String(users.length - linked) : '…', 'Not linked', S.uFilter === 'unlinked' ? 'warn' : (users.length - linked ? 'orange' : ''), null, 'u-filter', 'unlinked') + '</div>';
    var filt = S.uFilter;
    var toolbar = '<div class="kjs-toolbar"><input class="kj-input" type="search" data-kjs-local="u-q" placeholder="Search name, username, e-mail…" value="' + esc(S.uQuery) + '" aria-label="Search users">' +
      opts('u-filter', [['all', 'All'], ['active', 'Active'], ['inactive', 'Inactive'], ['linked', 'Linked'], ['unlinked', 'Not linked']].concat(filt.indexOf('role:') === 0 ? [[filt, 'Role: ' + filt.slice(5)]] : []), filt) +
      '<span class="kj-spacer"></span>' + btn('u-add', 'Add user', 'user-plus', 'kj-btn-primary') + '</div>';
    var rows = users.map(function (u) {
      var hidden = userMatches(u) ? '' : ' hidden';
      return '<tr data-kjs-urow="' + u.id + '"' + hidden + '><td><button type="button" class="kjs-click kjs-cell-main" data-kj-modal="kjs-user:' + u.id + '"><span class="kj-avatar kjs-avatar">' + esc(initials(u.name || u.username)) + '</span>' +
        '<span><span class="kjs-cell-name">' + esc(u.name) + '</span> ' + (u.isMe ? chip('you', 'primary') : '') + '<div class="kjs-cell-sub">@' + esc(u.username) + (u.email ? ' · ' + esc(u.email) : '') + '</div></span></button></td>' +
        '<td><select class="kj-select kjs-role-select" data-kjs-act="u-role" data-arg="' + u.id + '" aria-label="Role of ' + esc(u.username) + '">' +
          roles.concat(roles.indexOf(u.role) < 0 ? [u.role] : []).map(function (r) { return '<option value="' + esc(r) + '"' + (r === u.role ? ' selected' : '') + '>' + esc(r) + '</option>'; }).join('') + '</select></td>' +
        '<td>' + sw('u-active', !!u.active, u.id, (u.active ? 'Deactivate ' : 'Activate ') + u.username, u.isMe) + '</td>' +
        '<td>' + linkBtn(u) + '</td>' +
        '<td>' + btn('u-leave', 'Allowance', 'calendar-days', 'kj-btn-ghost kj-btn-sm', u.id) + '</td>' +
        '<td class="kjs-cell-sub">' + esc(u.lastLogin || '—') + '</td>' +
        '<td><div class="kjs-btns">' + btn('u-pw', 'Reset', 'key-round', 'kj-btn-ghost kj-btn-sm', u.id) +
          (u.isMe ? '' : '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon kj-btn-sm" data-kjs-act="u-del" data-arg="' + u.id + '" aria-label="Delete ' + esc(u.username) + '">' + ico('trash-2') + '</button>') + '</div></td></tr>';
    }).join('');
    var table = '<div class="kj-table-wrap"><table class="kj-table kjs-table"><thead><tr><th>User</th><th>Role</th><th>Active</th><th>Employee record</th><th>Leave</th><th>Last login</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="kjs-muted" data-kjs-unone' + (users.some(userMatches) ? ' hidden' : '') + '>No users match this filter.</div>';
    var note = '<div class="kjs-muted">' + ico('info') + ' Staff self-service (my attendance, my leave, the assistant\'s "my …" answers) uses the linked employee. Without a link the login falls back to the employee whose staff ID equals the username — shown as <b>auto</b>.</div>';
    return sec(m, '', kpis + card({ icon: 'user-round', tone: 'primary', title: 'Accounts', sub: users.length + ' sign-in account' + (users.length === 1 ? '' : 's'), body: toolbar + table + note }));
  };
  function applyUserFilter() {
    if (!S.el || !S.data.users) return;
    var any = false;
    S.data.users.forEach(function (u) { var tr = S.el.querySelector('[data-kjs-urow="' + u.id + '"]'); if (!tr) return; var ok = userMatches(u); tr.hidden = !ok; if (ok) any = true; });
    var none = S.el.querySelector('[data-kjs-unone]'); if (none) none.hidden = any;
  }
  function reloadUsers() { return Promise.all([load('users'), load('links')]).then(function () { if (S.el && S.sec === 'users') paintSection(); }); }
  function userById(id) { return (S.data.users || []).filter(function (u) { return String(u.id) === String(id); })[0] || null; }
  function umPost(path, body, ok) {
    return post(path, body).then(function (d) {
      if (d.users) S.data.users = d.users;
      toast(ok || 'Saved'); return reloadUsers().then(function () { if (d.roles && S.data.roles) S.data.roles.roles = d.roles; });
    }, function (e) { toast((e && e.message) || 'Failed', 'danger'); throw e; });
  }

  /* ── Integrations ────────────────────────────────────────────────────── */
  function hookList() { var s = (S.data.int && S.data.int.settings) || {}; return S.hookDraft || (s.webhooks || []).map(function (h) { var o = {}; Object.keys(h).forEach(function (k) { o[k] = h[k]; }); o.events = (h.events || []).slice(); return o; }); }
  function hookEdit(fn) { var l = hookList().map(function (h) { var o = {}; Object.keys(h).forEach(function (k) { o[k] = h[k]; }); o.events = (h.events || []).slice(); return o; }); fn(l); S.hookDraft = l; updateSavebar(); }
  RENDER.integrations = function (m) {
    var d = S.data.int, s = (d && d.settings) || {};
    var keyCard = card({ icon: 'key-round', tone: 'purple', title: 'Integration API key', sub: 'Read-only JSON API for HRMS / MES — send as X-Api-Key or Authorization: Bearer. Reference: docs/INTEGRATION_API.md.',
      actions: d ? btn('int-regen', s.has_key ? 'Rotate key' : 'Generate API key', 'refresh-cw', s.has_key ? 'kj-btn-secondary kj-btn-sm' : 'kj-btn-primary kj-btn-sm') + (s.has_key ? btn('int-revoke', 'Revoke', 'ban', 'kj-btn-ghost kj-btn-sm') : '') : '',
      body: !d ? (S.err.int ? '<div class="kjs-msg is-err">' + esc(S.err.int) + '</div>' : skel(3))
        : (S.newKey ? copyLine('New key — copy it now, it is not shown again', S.newKey) : '<div class="kjs-btns">' + chip(s.has_key ? 'Key active' : 'Disabled — no key', s.has_key ? 'success' : '', true) + '<span class="kjs-mono">' + esc(s.has_key ? s.integration_key : '') + '</span></div>') +
          ((d.catalogue || []).length ? '<div class="kj-table-wrap"><table class="kj-table"><thead><tr><th>Method</th><th>Endpoint</th><th>Parameters</th><th>Purpose</th></tr></thead><tbody>' +
            d.catalogue.map(function (c) { return '<tr><td>' + chip(c[0], 'primary') + '</td><td class="kjs-mono">' + esc(c[1]) + '</td><td class="kjs-cell-sub">' + esc(c[2]) + '</td><td>' + esc(c[3]) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '') });
    var evs = (d && d.events) || {};
    var hooks = d ? hookList().map(function (hk, i) {
      return '<div class="kjs-card"><div class="kjs-btns">' + chip(hk.id ? '#' + hk.id : 'new — not saved', hk.id ? 'primary' : 'warn') + '<span class="kj-spacer"></span>' +
        '<span class="kjs-muted">' + (hk.enabled !== false ? 'Enabled' : 'Paused') + '</span>' + sw('hook-enabled', hk.enabled !== false, i, 'Webhook enabled') + '</div>' +
        '<div class="kjs-form">' + field('URL', '<input class="kj-input kjs-mono" data-kjs-hook="' + i + '" data-kjs-hf="url" value="' + esc(hk.url || '') + '" placeholder="https://erp.example.com/hooks/visionai" autocomplete="off">') +
        field('Signing secret', '<input class="kj-input kjs-mono" data-kjs-hook="' + i + '" data-kjs-hf="secret" value="' + esc(hk.secret || '') + '" placeholder="blank = generate" autocomplete="off">') + '</div>' +
        field('Event types', '<div class="kjs-opts">' + Object.keys(evs).map(function (k) { var on = (hk.events || []).indexOf(k) >= 0;
          return '<button type="button" class="kjs-opt' + (on ? ' is-on' : '') + '" aria-pressed="' + on + '" title="' + esc(evs[k]) + '" data-kjs-act="hook-event" data-arg="' + i + '|' + esc(k) + '">' + esc(k) + '</button>'; }).join('') + '</div>') +
        '<div class="kjs-btns">' + btn('hook-test', 'Send test', 'send', 'kj-btn-secondary kj-btn-sm', i) + btn('hook-remove', 'Remove', 'trash-2', 'kj-btn-ghost kj-btn-sm', i) + '</div></div>';
    }).join('') : '';
    var log = ((d && d.log) || []).slice(0, 25).map(function (l) {
      return '<tr><td class="kjs-cell-sub">' + esc(l.at) + '</td><td>' + esc(l.type) + '</td><td class="kjs-mono">' + esc(l.url) + '</td><td>' + esc(l.code ? 'HTTP ' + l.code : '—') + '</td><td class="kj-num">' + esc(l.ms + ' ms') + '</td><td>' + chip(l.ok ? 'Delivered' : 'Failed', l.ok ? 'success' : 'danger') + (l.error ? '<div class="kjs-cell-sub">' + esc(l.error) + '</div>' : '') + '</td></tr>';
    }).join('');
    var hookCard = card({ icon: 'webhook', title: 'Outbound webhooks', sub: 'New detections are POSTed as JSON, signed with X-VisionAI-Signature: sha256=HMAC(secret, timestamp + "." + body).',
      actions: d ? btn('hook-add', 'Add webhook', 'plus', 'kj-btn-secondary kj-btn-sm', null, hookList().length >= 10 ? ' disabled' : '') : '',
      body: !d ? skel(3) : ((hooks || '<div class="kjs-muted">No webhooks configured.</div>') + msgLine('hooks') +
        (log ? '<div class="kj-section-title">Delivery log (latest 25)</div><div class="kj-table-wrap"><table class="kj-table"><thead><tr><th>At</th><th>Type</th><th>URL</th><th>Code</th><th class="kj-num">Time</th><th>State</th></tr></thead><tbody>' + log + '</tbody></table></div>' : '')) });
    var nd = S.data.notify, ns = notifyS(), tg = ns.telegram || {}, ch = (nd && nd.channels) || {}, stt = (nd && nd.stats) || {};
    var chanChip = function (c, s) { return chip((c && c.ready ? 'Ready' : (c && c.configured ? 'Configured · off' : 'Not configured')) + ' · ' + n0(s && s.sent24h) + ' sent 24 h', c && c.ready ? 'success' : '', true); };
    var tgCard = card({ icon: 'send', tone: 'primary', title: 'Alert channels', sub: 'E-mail and Telegram are gated independently and share the alert rules, minimum severity and per-camera interval.',
      actions: btn('tg-test', 'Test Telegram', 'send', 'kj-btn-secondary kj-btn-sm') + btn('mail-test', 'Test e-mail', 'mail', 'kj-btn-secondary kj-btn-sm'),
      body: !nd ? (S.err.notify ? '<div class="kjs-msg is-err">' + esc(S.err.notify) + '</div>' : skel(3))
        : '<div class="kjs-rows">' + row('mail', 'E-mail', ch.email && ch.email.ready ? (ch.email.recipients || 0) + ' base recipient(s)' : 'Configure the System e-mail (SMTP) card below', chanChip(ch.email, stt.email)) +
          row('send', 'Telegram', tg.has_token ? 'Bot token set' : 'No bot token yet', sw('tg-toggle', !!tg.enabled, null, 'Telegram alerts'), chanChip(ch.telegram, stt.telegram)) +
          row('image', 'Send the detection photo with Telegram alerts', '', sw('tg-photo', tg.send_photo !== false, null, 'Send photo')) + '</div>' +
          '<div class="kjs-form">' + field('Bot token', inp('tg', 'bot_token', '', { secret: true, type: 'password', ph: tg.has_token ? 'stored — type to replace' : '123456:ABC…' })) +
          field('Default chat IDs', inp('tg', 'chat_ids', (tg.chat_ids || []).join(', '), { ph: '-1001234567890, …' })) + '</div>' + msgLine('tg') });
    var mailCard = smtpCard();
    return sec(m, '', keyCard + hookCard + tgCard + mailCard);
  };
  /* System e-mail (SMTP) — GET/POST /mail/settings, POST /mail/test. Draft + save bar (namespace 'mail'). */
  function smtpCard() {
    var ms = S.data.mail;
    var head = { icon: 'server', tone: 'primary', title: 'System e-mail (SMTP)', sub: 'The mail server every alert, escalation, report and test e-mail is sent through.' };
    if (!ms) { head.body = S.err.mail ? '<div class="kjs-msg is-err">' + esc('Could not load the mail settings — ' + S.err.mail) + '</div><div class="kjs-btns">' + btn('reload', 'Retry', 'refresh-cw') + '</div>' : skel(4); return card(head); }
    var on = ms.enabled !== false, st = !on ? ['Disabled', ''] : (ms.ready ? ['Ready', 'success'] : ['Not configured', 'warn']);
    head.tone = !on ? '' : (ms.ready ? 'success' : 'warn');
    head.actions = chip(st[0], st[1], true) + btn('smtp-test', 'Send test e-mail', 'send', 'kj-btn-secondary kj-btn-sm', null, on ? '' : ' disabled');
    head.body = '<div class="kjs-rows">' + row('mail', 'System e-mail', on ? 'On — the app sends e-mail through this server.' : 'Off — no e-mail leaves the app (alerts still show on the dashboard).', draftSw('mail', 'enabled', on, 'System e-mail')) + '</div>' +
      '<div class="kjs-form">' + field('SMTP host', inp('mail', 'host', ms.host, { ph: 'smtp.office365.com' })) +
        field('Port', inp('mail', 'port', ms.port == null ? '' : String(ms.port), { type: 'number', min: 1, max: 65535, step: 1, ph: '465' })) +
        group('Security', draftOpts('mail', 'scheme', [['smtps', 'SMTPS (implicit TLS)'], ['smtp', 'SMTP (STARTTLS)']], ms.scheme || 'smtps'), 'SMTPS usually uses port 465; SMTP uses 587 or 25.') +
        field('Username', inp('mail', 'username', ms.username, { ph: 'alerts@company.com' })) +
        field('Password', inp('mail', 'password', '', { secret: true, type: 'password', ph: ms.password_set ? '••••••••' : 'not set' }), 'Write-only — leave blank to keep the stored password.') +
        field('From name', inp('mail', 'from_name', ms.from_name, { ph: 'Kian Joo VisionAI' })) +
        field('From address', inp('mail', 'from_address', ms.from_address, { type: 'email', ph: 'alerts@company.com' })) +
        field('Default recipients', inp('mail', 'to', emailSplit(ms.to).join(', '), { ph: 'ops@company.com, soc@company.com' }), 'Comma-separated — every address gets system e-mail.', 'is-wide') + '</div>' +
      msgLine('mail');
    return card(head);
  }

  /* ── actions ─────────────────────────────────────────────────────────── */
  function notifyPost(patch, ok) {
    return post('/notify/settings', patch).then(function (d) { S.data.notify = d; toast(ok || 'Saved'); paintSection(); }, function (e) { toast('Save failed — ' + e.message, 'danger'); });
  }
  function runNet(stream) {
    if (S.netBusy) return;
    S.netBusy = true; setMsg('net', stream ? 'Testing ' + stream + '…' : 'Running network test — up to ~50 s…'); paintSection();
    post('/live/nettest', stream ? { stream: stream } : {}).then(function (d) {
      if (stream && S.net) S.net.rows = (S.net.rows || []).map(function (r) { return r.name === stream ? ((d.rows || [])[0] || r) : r; }); else S.net = d;
      S.netBusy = false; setMsg('net', stream ? 'Re-tested ' + stream : 'Network test finished', 'ok'); paintSection();
    }, function (e) { S.netBusy = false; setMsg('net', e.message, 'err'); paintSection(); });
  }
  function liveSourcePost(body, okMsg) {
    setMsg('live', body.remove ? 'Removing source…' : 'Saving source and registering it on the bridge…');
    return post('/live/source', body).then(function (d) {
      var b = d.bridge, note = b ? (b.ok ? (body.remove ? ' · removed from the bridge' : (b.direct ? ' · plays directly (HLS)' : ' · registered on the bridge')) : ' · bridge: ' + (b.error || 'failed')) : ' · saved (bridge not configured)';
      toast(okMsg + ' (' + (d.stream || body.stream) + ')'); setMsg('live', okMsg + note, 'ok');
      var a = A(); if (a) { a.loadLive(true, true); a.loadApp(); }
      return Promise.all([load('live'), load('settings')]).then(paintSection);
    }, function (e) { setMsg('live', e.message, 'err'); toast(e.message, 'danger'); });
  }
  function copyText(t) {
    var done = function () { toast('Copied to clipboard'); };
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).then(done, function () { fallback(); }); return; } } catch (e) { /* fall back */ }
    fallback();
    function fallback() {
      var ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.className = 'kj-sr-only'; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed — select the text manually', 'warn'); }
      ta.remove();
    }
  }
  function local(name) { var el = S.el && S.el.querySelector('[data-kjs-local="' + name + '"]'); return el ? String(el.value || '') : ''; }

  function removeCond(i) {
    var c = conditions()[i]; if (!c) return;
    confirmDo({ title: 'Delete condition rule "' + c.name + '"?', text: 'Matching detections stop alerting through this rule. The module rules above are not affected.', confirm: 'Delete rule', icon: 'trash-2' }, function () {
      saveConditions(conditions().filter(function (x, j) { return j !== i; }), 'Condition rule deleted').catch(function () {});
    });
  }

  var ACT = {
    noop: function () {},
    reload: function () { refresh(true); },
    save: saveSection,
    discard: discardSection,
    'draft-opt': function (el) { setDraft(el.getAttribute('data-ns'), el.getAttribute('data-key'), el.getAttribute('data-arg'), el.getAttribute('data-saved')); paintSection(); },
    'draft-toggle': function (el) {
      var ns = el.getAttribute('data-ns'), key = el.getAttribute('data-key'), saved = el.getAttribute('data-saved');
      var cur = dv(ns, key, saved) === '1'; setDraft(ns, key, cur ? '0' : '1', saved);
      el.classList.toggle('is-on', !cur); el.setAttribute('aria-checked', String(!cur));
    },
    copy: function (el) { copyText(el.getAttribute('data-arg') || ''); },
    demo: function () { var a = A(); if (!a) return; a.toggleDemo(); setTimeout(function () { paintSection(); toast(a.state.demo ? 'Demo data on (this browser)' : 'Live data on'); }, 30); },
    sim: function (el) {
      var action = el.getAttribute('data-arg');
      var go = function () {
        setMsg('sim', action === 'reset' ? 'Removing demo data…' : 'Generating a week of detections through the ingest pipeline… this takes a few seconds');
        post('/simulate', { action: action, days: 7 }).then(function (d) {
          var c = d.counts || {};
          var t = action === 'reset' ? 'Removed ' + (c.events || 0) + ' simulated events and ' + (c.employees || 0) + ' demo employees'
            : 'Generated ' + (c.events || 0) + ' detections over ' + (d.days || 7) + ' days — ' + (c.face || 0) + ' face, ' + (c.ppe || 0) + ' PPE, ' + (c.restricted || 0) + ' restricted-zone, ' + (c.forklift || 0) + ' forklift';
          setMsg('sim', t, 'ok'); toast(action === 'reset' ? 'Demo data removed' : 'Demo detections generated');
          var a = A(); if (a) { a.setState({ ov: null }); a.fetchFeed(); a.loadPeople(); a.loadApp(); }
        }, function (e) { setMsg('sim', e.message, 'err'); toast(e.message, 'danger'); });
      };
      if (action === 'reset') confirmDo({ title: 'Remove demo data?', text: 'Removes every simulated detection (DEMO… cameras), the demo employees and the demo zones.', confirm: 'Remove demo data', icon: 'trash-2' }, go); else go();
    },
    'report-now': function () {
      setMsg('report', 'Sending report…');
      get('/report/run').then(function () { setMsg('report', 'Report sent — check the inbox', 'ok'); toast('Report sent'); }, function (e) { setMsg('report', 'Report failed — check SMTP / recipients (' + e.message + ')', 'err'); toast('Report failed', 'danger'); });
    },
    ret: function (el) {
      var days = +el.getAttribute('data-arg'), rs = (S.data.retention && S.data.retention.storage) || {}, cur = rs.retention_days != null ? rs.retention_days : 90;
      var go = function () { post('/retention', { retention_days: days }).then(function (d) { if (S.data.retention) S.data.retention.storage = d.storage || S.data.retention.storage; toast('Retention set to ' + (days ? days + ' days' : 'keep forever')); load('retention').then(paintSection); }, function (e) { toast(e.message, 'danger'); }); };
      if (days && (!cur || days < cur)) confirmDo({ title: 'Shorten retention to ' + days + ' days?', text: 'Detections, PPE / zone rows, incident logs and ticket attachments older than ' + days + ' days are deleted at the next daily purge.', confirm: 'Set ' + days + ' days', tone: 'warn', icon: 'archive' }, go); else go();
    },
    'ret-purge': function () {
      var due = (S.data.retention && S.data.retention.due) || {};
      confirmDo({ title: 'Purge now?', text: (due.events || 0) + ' events older than the retention window (and their PPE / zone rows, incident log and ticket attachments) are deleted permanently.', confirm: 'Purge now', icon: 'trash-2' }, function () {
        post('/retention', { purge_now: true }).then(function (d) { toast('Purged ' + ((d.purge && d.purge.events) || 0) + ' events'); load('retention').then(paintSection); }, function (e) { toast(e.message, 'danger'); });
      });
    },
    regen: function (el) {
      var kind = el.getAttribute('data-arg');
      confirmDo(kind === 'ingest'
        ? { title: 'Regenerate the ingest token?', text: 'Every SenseStudio policy push URL must be updated afterwards, or pushes will be rejected.', confirm: 'Regenerate', icon: 'refresh-cw' }
        : { title: 'Regenerate the read token?', text: 'The dashboard reloads with the new token. Other systems using the old read token stop working.', confirm: 'Regenerate & reload', icon: 'refresh-cw' }, function () {
        post('/settings', kind === 'ingest' ? { regen_ingest: true } : { regen_read: true }).then(function (d) {
          if (d.rotated && d.rotated.read_token) { toast('Read token rotated — reloading…'); setTimeout(function () { location.reload(); }, 1200); return; }
          toast('Ingest token rotated — update the SenseStudio push URLs'); load('settings').then(paintSection);
        }, function (e) { toast(e.message, 'danger'); });
      });
    },
    'purge-all': function () {
      confirmDo({ title: 'Delete all detections?', text: 'Every stored detection, its attributes, incident tickets and comment history are deleted. Cameras, users, tokens and settings are kept. This cannot be undone.', confirm: 'Delete everything', typed: 'PURGE', icon: 'trash-2' }, function () {
        post('/events/purge', { confirm: 'PURGE' }).then(function (d) {
          toast((d.purged || 0) + ' event(s) deleted');
          var a = A(); if (a) { a._over = {}; a.camPool = []; a.setState({ events: [], trend: [], byType: {}, byCam: {}, ai: null, ppe: null, policies: [] }); a.fetchFeed(); }
        }, function (e) { toast(e.message, 'danger'); });
      });
    },
    'live-test': function () {
      setMsg('live', 'Contacting the bridge…');
      load('live').then(function (lb) {
        var b = (lb && lb.bridge) || {}, t;
        if (lb && !lb.configured) t = ['Not configured — set the public base URL and save first', 'err'];
        else if (lb && b.reachable) t = ['Bridge reachable · go2rtc ' + (b.version || '?') + (b.ms != null && b.ms !== '' ? ' · ' + b.ms + ' ms' : ''), 'ok'];
        else t = ['Unreachable: ' + ((lb && b.error) || S.err.live || 'no response'), 'err'];
        S.msg.live = { text: t[0], tone: t[1] }; paintSection(); toast(t[0], t[1] === 'ok' ? 'success' : 'danger');
      });
    },
    'live-sync': function () {
      setMsg('live', 'Registering RTSP sources on the bridge…');
      post('/live/sync', {}).then(function (d) {
        var n = function (k) { return n0(d[k]); }, errs = Array.isArray(d.errors) ? d.errors : [];
        var t = n('registered') + ' registered · ' + n('updated') + ' updated · ' + n('unchanged') + ' unchanged' + (n('failed') ? ' · ' + n('failed') + ' failed' : '') +
          (errs.length ? ' — ' + errs.slice(0, 3).map(function (e) { return ((e && e.name) || '?') + ': ' + ((e && e.error) || 'error'); }).join('; ') : '');
        S.msg.live = { text: t, tone: n('failed') ? 'err' : 'ok' }; toast('Bridge sync finished');
        if (d.status) { S.data.live = d.status; paintSection(); } else load('live').then(paintSection);
        var a = A(); if (a) a.fetchFeed();
      }, function (e) { setMsg('live', e.message, 'err'); toast(e.message, 'danger'); });
    },
    probe: function (el) {
      var name = el.getAttribute('data-arg'); if (!name || (S.probe[name] && S.probe[name].busy)) return;
      S.probe[name] = { busy: true }; paintSection();
      post('/live/probe', { stream: name }).then(function (d) {
        var a = A(); S.probe[name] = { ready: !!d.ready, ms: d.ms, error: d.error || '', snap: d.ready && d.snapshot && a ? a.liveApiUrl(d.snapshot) : '' }; paintSection();
      }, function (e) { S.probe[name] = { ready: false, error: e.message }; paintSection(); });
    },
    'src-remove': function (el) {
      var name = el.getAttribute('data-arg');
      confirmDo({ title: 'Remove "' + name + '"?', text: 'The manual RTSP source is deleted here and removed from the bridge.', confirm: 'Remove source', icon: 'trash-2' }, function () { liveSourcePost({ stream: name, remove: true }, 'Source removed'); });
    },
    'src-add': function () {
      var stream = local('src-name').trim(), rtsp = local('src-url').trim();
      if (!stream || !rtsp) { toast('Stream label and source URL are required', 'warn'); return; }
      if (/\s/.test(rtsp) || !/^(rtsps?|rtmps?|https?|onvif|ffmpeg|isapi|dvrip|tapo|kasa|webrtc):/i.test(rtsp)) { toast('Not a supported source URL (rtsp://user:pass@host:554/…)', 'warn'); return; }
      liveSourcePost({ stream: stream, rtsp: rtsp }, 'Source saved');
    },
    'net-run': function (el) { runNet(el.getAttribute('data-arg') || ''); },
    'ai-src': function (el) {
      var v = el.getAttribute('data-arg'), cur = S.data.settings && S.data.settings.ai_source === 'off' ? 'off' : 'claude';
      if (v === cur) return;
      var go = function () { post('/settings', { ai_source: v }).then(function () { toast(v === 'off' ? 'AI switched off' : 'AI switched on'); if (S.data.settings) S.data.settings.ai_source = v; paintSection(); var a = A(); if (a) a.loadApp(); }, function (e) { toast(e.message, 'danger'); }); };
      if (v === 'off') confirmDo({ title: 'Switch AI off?', text: 'The assistant, AI reports, forecast narration and review remarks stop. The PPE-forklift pipeline keeps its own .env switch.', confirm: 'Switch off', tone: 'warn', icon: 'power' }, go); else go();
    },
    pipe: function (el) {
      var dry = el.getAttribute('data-arg') === 'dry';
      setMsg('pipe', dry ? 'Checking which detections would be reviewed…' : 'Running the review pipeline (up to ~50 s)…');
      (dry ? get('/pipeline/run?dry_run=1') : post('/pipeline/run', {})).then(function (d) {
        S.pipe = { dry: dry, stats: d.stats || {} }; S.msg.pipe = { text: (dry ? 'Dry run' : 'Run') + ' finished ' + String(d.ran_at || '').replace('T', ' ').slice(0, 19), tone: 'ok' }; paintSection();
      }, function (e) { setMsg('pipe', e.message, 'err'); toast(e.message, 'danger'); });
    },
    'mon-set': function (el) {
      var k = el.getAttribute('data-arg'), ms = monSet(), p = {}; if (!monD()) return;
      p[k] = !ms[k];
      var label = k === 'enabled' ? 'Camera monitoring' : 'Daily fitness check';
      var go = function () { monPostSettings(p).then(function () { toast(label + (p[k] ? ' on' : ' off')); }, function (e) { toast(e.message, 'danger'); }); };
      if (k === 'enabled' && !p[k]) confirmDo({ title: 'Pause camera monitoring?', text: 'No camera is screened and no monitor tickets are created until you switch this back on. Per-camera settings are kept.', confirm: 'Pause', tone: 'warn', icon: 'power' }, go); else go();
    },
    'mon-iv': function (el) {
      var v = +el.getAttribute('data-arg'); if (!monD() || v === monSet().interval_sec) return;
      monPostSettings({ interval_sec: v }).then(function () { toast('Scan interval ' + monIvLabel(v)); }, function (e) { toast(e.message, 'danger'); });
    },
    'mon-scan': function () {
      if (S.monBusy.scan) return;
      S.monBusy.scan = true; S.msg.mon = { text: 'Screening one frame per due camera (up to ~50 s)…', tone: '' }; paintSection();
      post('/monitors/scan/run', {}).then(function (d) {
        S.monBusy.scan = false; S.msg.mon = { text: 'Scan finished — ' + monStatsText((d && d.stats) || d), tone: 'ok' };
        return load('mon').then(paintSection);
      }, function (e) { S.monBusy.scan = false; S.msg.mon = { text: 'Scan failed — ' + e.message, tone: 'err' }; paintSection(); toast(e.message, 'danger'); });
    },
    'mon-fit': function (el) {
      var stream = el.getAttribute('data-arg') || '';
      if (S.monBusy.fit) return;
      S.monBusy.fit = true; S.msg.mon = { text: 'Checking each camera\'s scene with the fast model…', tone: '' }; paintSection();
      post('/monitors/fitness/run' + (stream ? '?stream=' + encodeURIComponent(stream) : ''), {}).then(function (d) {
        var n = d && (Array.isArray(d.results) ? d.results.length : (d.results && typeof d.results === 'object' ? Object.keys(d.results).length : n0(d.checked)));
        S.monBusy.fit = false; S.msg.mon = { text: 'Fitness check finished' + (n ? ' — ' + n + ' camera' + (n === 1 ? '' : 's') + ' checked' : ''), tone: 'ok' };
        return load('mon').then(paintSection);
      }, function (e) { S.monBusy.fit = false; S.msg.mon = { text: 'Fitness check failed — ' + e.message, tone: 'err' }; paintSection(); toast(e.message, 'danger'); });
    },
    'mon-stats': function () { if (monD()) openModal('kjs-mon-stats', 'today'); },
    'mon-edit': function (el) { var s = el.getAttribute('data-arg'); if (s && monFind(s)) openModal('kjs-mon', s, { name: monFind(s).name }); },
    'mon-cam-toggle': function (el) {
      var c = monFind(el.getAttribute('data-arg')); if (!c) return;
      if (!c.cfg.enabled && !c.cfg.fields.length) { toast('Choose what this camera monitors first', 'warn'); openModal('kjs-mon', c.stream, { name: c.name }); return; }
      var cfg = c.cfg; cfg.enabled = !cfg.enabled;
      monPostCam(c.stream, cfg).then(function () { toast(c.name + (cfg.enabled ? ' monitored' : ' no longer monitored')); }, function (e) { toast(e.message, 'danger'); paintSection(); });
    },
    'esc-toggle': function () { var es = notifyS().escalation || {}; notifyPost({ escalation: { enabled: !es.enabled } }, !es.enabled ? 'Escalation workflow on' : 'Escalation workflow off'); },
    'esc-min': function (el) { var v = +el.getAttribute('data-arg'); notifyPost({ escalation: { unattended_min: v } }, 'Unattended threshold ' + v + ' min'); },
    'esc-sev': function (el) { notifyPost({ escalation: { min_severity: el.getAttribute('data-arg') } }, 'Escalation severity saved'); },
    'tg-toggle': function () { var tg = notifyS().telegram || {}; notifyPost({ telegram: { enabled: !tg.enabled } }, !tg.enabled ? 'Telegram on' : 'Telegram off'); },
    'tg-photo': function () { var tg = notifyS().telegram || {}; notifyPost({ telegram: { send_photo: tg.send_photo === false } }, 'Saved'); },
    'mail-toggle': function () {
      var al = S.data.alerts || {}, on = al.email_enabled !== false;
      var go = function () { alertsPost({ email_enabled: !on }, on ? 'E-mail alerts off' : 'E-mail alerts on'); };
      if (on) confirmDo({ title: 'Turn e-mail alerts off?', text: 'Detections keep showing on the dashboard, but nobody is e-mailed until you switch this back on.', confirm: 'Turn off', tone: 'warn', icon: 'mail' }, go); else go();
    },
    'esc-run': function (el) {
      var dry = el.getAttribute('data-arg') === 'dry';
      var go = function () {
        setMsg('esc', dry ? 'Checking open alerts…' : 'Running escalation…');
        post('/escalation/run', { dry_run: dry }).then(function (d) {
          S.escRes = d; var n = (d.escalated || []).length;
          S.msg.esc = { text: dry ? n + ' escalation(s) due now · ' + (d.pending || []).length + ' upcoming' : n + ' escalation(s) performed', tone: 'ok' };
          if (!dry) { load('notify'); var a = A(); if (a) a.fetchFeed(); }
          paintSection();
        }, function (e) { setMsg('esc', 'Escalation check failed — ' + e.message, 'err'); });
      };
      if (dry) go(); else confirmDo({ title: 'Run escalation now?', text: 'Overdue unattended alerts are escalated immediately and their recipients are notified by e-mail / Telegram.', confirm: 'Run now', tone: 'warn', icon: 'play' }, go);
    },
    'tg-test': function () {
      setMsg('tg', 'Sending Telegram test…');
      post('/alerts/telegram-test', {}).then(function (d) { setMsg('tg', 'Telegram test sent via @' + (d.bot || 'bot') + ' to ' + d.sent + ' chat(s)' + (d.failed ? ' · ' + d.failed + ' failed' : ''), 'ok'); toast('Telegram test sent'); load('notify'); },
        function (e) { setMsg('tg', 'Telegram test failed — ' + e.message, 'err'); toast('Telegram test failed', 'danger'); });
    },
    'mail-test': function () {
      setMsg('tg', 'Sending test e-mail…');
      post('/alerts/email-test', {}).then(function (d) { setMsg('tg', 'Test e-mail sent to ' + (d.to || []).join(', '), 'ok'); toast('Test e-mail sent'); load('notify'); },
        function (e) { setMsg('tg', 'Test e-mail failed — ' + e.message, 'err'); toast('Test e-mail failed', 'danger'); });
    },
    'smtp-test': function () {
      if (dirtyNs('mail')) { toast('Save the e-mail settings first — the test uses the saved server', 'warn'); return; }
      setMsg('mail', 'Sending test e-mail…');
      post('/mail/test', {}).then(function (d) {
        if (d.sent === false) { setMsg('mail', 'Test e-mail not sent — ' + (d.error || 'the server refused it'), 'err'); toast('Test e-mail failed', 'danger'); return; }
        setMsg('mail', 'Test e-mail sent to ' + ((d.to || []).join(', ') || 'the default recipients'), 'ok'); toast('Test e-mail sent');
      }, function (e) { setMsg('mail', 'Test e-mail failed — ' + e.message, 'err'); toast('Test e-mail failed', 'danger'); });
    },
    'ar-mod': function (el) {
      var k = el.getAttribute('data-arg'), me = modsEnabled(S.data.alerts), x = AR_MODS.filter(function (r) { return r[0] === k; })[0];
      me[k] = !me[k];
      alertsPost({ mods_enabled: me }, (x ? x[3] : k) + (me[k] ? ' alerts on' : ' alerts off'));
    },
    'ar-always': function (el) {
      var k = el.getAttribute('data-mod'), want = el.getAttribute('data-arg') === '1', am = ((S.data.alerts || {}).always_mods || []).slice(), i = am.indexOf(k);
      if (want === (i >= 0)) return;
      if (want) am.push(k); else am.splice(i, 1);
      alertsPost({ always_mods: am }, want ? 'Always e-mail' : 'Severity-based');
    },
    'ar-sev': function (el) { var v = el.getAttribute('data-arg'); alertsPost({ min_severity: v }, 'Minimum severity: ' + lbl(AR_SEV, v)); },
    'ar-cool': function (el) { var v = +el.getAttribute('data-arg'); alertsPost({ cooldown_min: v }, 'Interval ' + v + ' min'); },
    'ar-armed': function (el) {
      var v = el.getAttribute('data-arg');
      var go = function () { alertsPost({ intr_armed: v }, 'Intrusion: ' + lbl(AR_ARMED, v)); };
      if (v === 'off') confirmDo({ title: 'Disarm intrusion alerts?', text: 'Intrusion detections are still recorded, but nobody is e-mailed about them until you arm the window again.', confirm: 'Disarm', tone: 'warn', icon: 'shield-alert' }, go); else go();
    },
    'ar-mail': function () {
      var raw = local('ar-mail'), list = emailSplit(raw), bad = list.filter(function (e) { return !emailOk(e); });
      if (bad.length) { toast('Not a valid e-mail address — ' + bad.join(', '), 'warn'); return; }
      S.arMail = null;
      alertsPost({ mail_to: list }, list.length ? 'Recipients saved (' + list.length + ')' : 'Recipients cleared — the .env default list applies');
    },
    'alerts-test': function () {
      setMsg('ar', 'Sending test e-mail…');
      post('/alerts/email-test', {}).then(function (d) { setMsg('ar', 'Test e-mail sent to ' + (d.to || []).join(', '), 'ok'); toast('Test e-mail sent'); },
        function (e) { setMsg('ar', 'Test e-mail failed — ' + e.message, 'err'); toast('Test e-mail failed', 'danger'); });
    },
    'cond-add': function () { if (!S.data.notify) return; openModal('kjs-cond', 'new'); },
    'cond-edit': function (el) { openModal('kjs-cond', el.getAttribute('data-arg')); },
    'cond-toggle': function (el) {
      var i = +el.getAttribute('data-arg'), c = conditions()[i]; if (!c) return;
      var on = c.enabled !== false;
      saveConditions(conditions().map(function (x, j) { if (j !== i) return x; var o = {}; Object.keys(x).forEach(function (k) { o[k] = x[k]; }); o.enabled = !on; return o; }),
        '"' + c.name + '" ' + (on ? 'paused' : 'enabled')).catch(function () { paintSection(); });
    },
    'cond-del': function (el) { removeCond(+el.getAttribute('data-arg')); },
    'int-regen': function () {
      var has = !!(S.data.int && S.data.int.settings && S.data.int.settings.has_key);
      var go = function () { post('/integration/config', { regen_key: true }).then(function (d) { S.newKey = d.new_key || ''; if (S.data.int) S.data.int.settings = d.settings; toast('New key generated — copy it now'); paintSection(); }, function (e) { toast(e.message, 'danger'); }); };
      if (has) confirmDo({ title: 'Rotate the integration API key?', text: 'HRMS / MES systems using the current key stop working until they are given the new one.', confirm: 'Rotate key', tone: 'warn', icon: 'refresh-cw' }, go); else go();
    },
    'int-revoke': function () {
      confirmDo({ title: 'Revoke the integration API key?', text: 'The integration API is disabled until a new key is generated.', confirm: 'Revoke key', icon: 'ban' }, function () {
        post('/integration/config', { revoke_key: true }).then(function (d) { S.newKey = ''; if (S.data.int) S.data.int.settings = d.settings; toast('Key revoked'); paintSection(); }, function (e) { toast(e.message, 'danger'); });
      });
    },
    'hook-add': function () { if (hookList().length >= 10) return; hookEdit(function (l) { l.push({ id: '', url: '', secret: '', events: ['incident', 'attendance'], enabled: true }); }); paintSection(); },
    'hook-remove': function (el) {
      var i = +el.getAttribute('data-arg'), hk = hookList()[i] || {};
      confirmDo({ title: 'Remove this webhook?', text: (hk.url || 'This webhook') + ' stops receiving events once you save.', confirm: 'Remove', icon: 'trash-2' }, function () { hookEdit(function (l) { l.splice(i, 1); }); paintSection(); });
    },
    'hook-event': function (el) { var p = el.getAttribute('data-arg').split('|'), i = +p[0]; hookEdit(function (l) { var e = l[i].events, k = e.indexOf(p[1]); if (k >= 0) e.splice(k, 1); else e.push(p[1]); }); paintSection(); },
    'hook-enabled': function (el) { var i = +el.getAttribute('data-arg'); hookEdit(function (l) { l[i].enabled = l[i].enabled === false; }); paintSection(); },
    'hook-test': function (el) {
      var hk = hookList()[+el.getAttribute('data-arg')] || {};
      if (!hk.id || S.hookDraft) { toast('Save the webhooks first, then send a test', 'warn'); return; }
      setMsg('hooks', 'Sending test webhook…');
      post('/integration/test', { id: hk.id }).then(function (d) { setMsg('hooks', 'Test delivered — HTTP ' + d.code + ' in ' + d.ms + ' ms', 'ok'); toast('Test delivered'); load('int').then(paintSection); },
        function (e) { setMsg('hooks', 'Test failed — ' + e.message, 'err'); load('int').then(paintSection); });
    },
    perm: function (el) {
      var k = el.getAttribute('data-arg'), s = k.split('|'), r = ((S.data.roles && S.data.roles.roles) || []).filter(function (x) { return x.name === s[0]; })[0];
      if (!r) return;
      var saved = (r.perms || {})[s[1]] ? '1' : '0', cur = dv('roles', k, saved) === '1';
      setDraft('roles', k, cur ? '0' : '1', saved); paintSection();
    },
    'role-del': function (el) {
      var name = el.getAttribute('data-arg');
      confirmDo({ title: 'Delete role "' + name + '"?', text: 'The role is removed from roles.json. It has no users assigned.', confirm: 'Delete role', icon: 'trash-2' }, function () {
        post('/roles', { action: 'delete', name: name }).then(function (d) { S.data.roles = d; toast('Role deleted'); paintSection(); var a = A(); if (a) a.loadRoles(); }, function (e) { toast(e.message, 'danger'); });
      });
    },
    'role-new': function () {
      var n = local('nr-name').trim(); if (!n) { toast('Role name required', 'warn'); return; }
      post('/roles', { name: n, desc: local('nr-desc').trim(), perms: { view: true } }).then(function (d) { S.data.roles = d; toast('Role created'); paintSection(); var a = A(); if (a) a.loadRoles(); }, function (e) { toast(e.message, 'danger'); });
    },
    'u-filter': function (el) {
      var v = el.getAttribute('data-arg');
      S.uFilter = v;
      if (S.sec !== 'users') { P.go('settings/users'); return; }
      paintSection();
    },
    'u-add': function () { openModal('kjs-user-new', 'new'); },
    'u-active': function (el) {
      var u = userById(el.getAttribute('data-arg')); if (!u) return;
      var go = function () { umPost('/users/' + u.id, { active: !u.active }, u.active ? 'User deactivated' : 'User activated').catch(function () { paintSection(); }); };
      if (u.active) confirmDo({ title: 'Deactivate ' + u.username + '?', text: 'They are signed out on their next request and cannot sign in until re-activated.', confirm: 'Deactivate', tone: 'warn', icon: 'user-x' }, go); else go();
    },
    'u-pw': function (el) { openModal('kjs-pw', el.getAttribute('data-arg')); },
    'u-del': function (el) {
      var u = userById(el.getAttribute('data-arg')); if (!u) return;
      confirmDo({ title: 'Delete user "' + u.username + '"?', text: 'The account is removed permanently. Their tickets and leave history keep their name.', confirm: 'Delete user', typed: u.username, icon: 'trash-2' },
        function () { umPost('/users/' + u.id, { action: 'delete' }, 'User deleted'); });
    },
    'u-link': function (el) { openModal('kjs-link', el.getAttribute('data-arg')); },
    'u-leave': function (el) { openModal('kjs-leave', el.getAttribute('data-arg')); }
  };

  function onClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-kjs-act]') : null;
    if (!t || !S.el || !S.el.contains(t) || t.tagName === 'SELECT' || t.disabled) return;
    var fn = ACT[t.getAttribute('data-kjs-act')];
    if (fn) { ev.preventDefault(); fn(t, ev); }
  }
  function onInput(ev) {
    var t = ev.target; if (!t || !t.getAttribute) return;
    if (t.hasAttribute('data-kjs-ns')) {
      setDraft(t.getAttribute('data-kjs-ns'), t.getAttribute('data-kjs-key'), t.value, t.getAttribute('data-kjs-saved'));
      if (t.getAttribute('data-kjs-ns') === 'sla') updateSlaBars();
      return;
    }
    if (t.hasAttribute('data-kjs-hook')) { var i = +t.getAttribute('data-kjs-hook'), f = t.getAttribute('data-kjs-hf'), v = t.value; hookEdit(function (l) { if (l[i]) l[i][f] = v; }); return; }
    if (t.getAttribute('data-kjs-local') === 'u-q') { S.uQuery = t.value; applyUserFilter(); }
    if (t.getAttribute('data-kjs-local') === 'ar-mail') S.arMail = t.value;
  }
  function onChange(ev) {
    var t = ev.target; if (!t || !t.getAttribute) return;
    if (t.tagName === 'SELECT' && t.hasAttribute('data-kjs-ns')) { onInput(ev); return; }
    if (t.getAttribute('data-kjs-act') === 'u-role') {
      var u = userById(t.getAttribute('data-arg')), v = t.value; if (!u || u.role === v) return;
      umPost('/users/' + u.id, { role: v }, 'Role updated — ' + u.username + ' is now ' + v).catch(function () { paintSection(); });
    }
  }

  /* ── modals (KJModal types owned by this page) ──────────────────────── */
  function openModal(type, id, data) { ensureModals(); if (window.KJModal) window.KJModal.open(type, String(id), data || {}, { noHash: true }); }
  var modalsReady = false;
  function ensureModals() {
    var M = window.KJModal; if (modalsReady || !M || !M.register) return;
    modalsReady = true;
    var mh = M.h;
    M.register('kjs-confirm', { kicker: 'Please confirm', icon: 'triangle-alert', size: 'sm', deepLink: false,
      render: function (ctx, d) {
        return { title: d.title || 'Are you sure?', icon: d.icon || 'triangle-alert', tone: d.tone || 'danger',
          body: '<div class="kjs-modal-form"><p>' + esc(d.text || '') + '</p>' + (d.typed ? field('Type ' + d.typed + ' to confirm', '<input class="kj-input" data-kjs-typed autocomplete="off" spellcheck="false">') : '') + '</div>',
          foot: '<button type="button" class="kj-btn kj-btn-secondary" data-kj-close>Cancel</button>' + mh.btn('ok', d.confirm || 'Confirm', d.icon || 'check', (d.tone || 'danger') === 'danger' ? 'kj-btn-danger' : 'kj-btn-primary'),
          actions: { ok: function (c) {
            if (d.typed) { var i = c.body.querySelector('[data-kjs-typed]'); if (!i || i.value.trim() !== d.typed) { toast('Type ' + d.typed + ' exactly to confirm', 'warn'); if (i) i.focus(); return; } }
            var fn = S.confirms[c.id]; delete S.confirms[c.id]; c.close(); if (fn) fn();
          } } };
      } });
    M.register('kjs-user', { kicker: 'User', icon: 'user-round', size: 'md',
      load: function (ctx) { var u = userById(ctx.id); if (u) return Promise.resolve(u);
        return Promise.all([load('users'), load('links')]).then(function () { var x = userById(ctx.id); if (!x) throw new Error('User not found'); return x; }); },
      render: function (ctx, u) {
        var L = linkOf(u.id), pid = L && (L.person_id || L.implicit_person_id), p = pid ? personMap()[pid] : null;
        return { title: u.name, icon: 'user-round', tone: u.active ? 'success' : 'warn',
          body: '<div class="kj-row"><span class="kj-avatar kj-avatar-lg">' + esc(initials(u.name)) + '</span><div><div class="kjs-cell-name">' + esc(u.name) + '</div><div class="kjs-cell-sub">@' + esc(u.username) + '</div></div></div>' +
            mh.section('Account', '<div class="kj-card">' + mh.kv([['Username', u.username], ['E-mail', u.email || '—'], ['Role', u.role], ['Status', u.active ? 'Active' : 'Deactivated'], ['Last login', u.lastLogin || '—'], ['Created', u.created || '—']]) + '</div>') +
            mh.section('Employee record', '<div class="kj-card">' + (pid ? mh.kv([['Employee', p ? p.name : pid], ['Staff ID', p && p.staff_id], ['Department', p && p.department], ['Plant', p && p.plant], ['Link', L.person_id ? 'Explicit (users.person_id)' : 'Automatic — staff ID equals the username']]) +
              '<div class="kjs-btns">' + mh.link('person', pid, 'Open employee profile') + '</div>' : '<p class="kjs-muted">Not linked — staff self-service has no employee data for this login.</p>') + '</div>'),
          foot: mh.btn('link', pid ? 'Change employee' : 'Link employee', 'link') + mh.btn('leave', 'Leave allowance', 'calendar-days') + mh.btn('pw', 'Reset password', 'key-round'),
          actions: { link: function () { openModal('kjs-link', u.id); }, leave: function () { openModal('kjs-leave', u.id); }, pw: function () { openModal('kjs-pw', u.id); } } };
      } });
    M.register('kjs-cond', { kicker: 'Condition rule', icon: 'filter', size: 'md', deepLink: false,
      render: function (ctx) {
        var list = conditions(), isNew = ctx.id === 'new', idx = isNew ? -1 : +ctx.id, c = isNew ? {} : (list[idx] || {}), ch = c.channels || {};
        var sel = function (f, options, cur, label) {
          return '<select class="kj-select" data-f="' + f + '" aria-label="' + esc(label) + '">' + options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
        };
        var cams = camOptions(); if (c.camera && cams.indexOf(c.camera) < 0) cams.unshift(c.camera);
        var win = c.window || 'always', wins = COND_WIN.some(function (o) { return o[0] === win; }) ? COND_WIN : COND_WIN.concat([[win, win]]);
        var chBtn = function (k, label, on) { return '<button type="button" class="kjs-opt' + (on ? ' is-on' : '') + '" aria-pressed="' + on + '" data-kj-action="ch" data-ch="' + k + '">' + esc(label) + '</button>'; };
        return { title: isNew ? 'New condition rule' : (c.name || 'Condition rule'), icon: 'filter',
          body: '<div class="kjs-modal-form">' + field('Rule name', '<input class="kj-input" data-f="name" maxlength="80" value="' + esc(c.name || '') + '" placeholder="e.g. Night-shift PPE at Line 5" autocomplete="off">') +
            '<div class="kjs-form">' + field('Module', sel('mod', COND_MODS, c.mod || 'any', 'Module')) +
              field('Camera', sel('camera', [['', 'Any camera']].concat(cams.map(function (x) { return [x, x.toUpperCase()]; })), c.camera || '', 'Camera')) +
              field('Severity', sel('min_sev', COND_SEV, c.min_sev || 'low', 'Severity')) +
              field('When', sel('window', wins, win, 'Time window')) + '</div>' +
            field('Keyword (optional)', '<input class="kj-input" data-f="keyword" maxlength="60" value="' + esc(c.keyword || '') + '" placeholder="Matches the policy name or alert title" autocomplete="off">') +
            group('Send by', '<div class="kjs-opts" role="group">' + chBtn('email', 'E-mail', ch.email !== false) + chBtn('telegram', 'Telegram', ch.telegram !== false) + '</div>') + '</div>',
          foot: '<button type="button" class="kj-btn kj-btn-secondary" data-kj-close>Cancel</button>' + (isNew ? '' : mh.btn('del', 'Delete', 'trash-2', 'kj-btn-ghost')) +
            mh.btn('ok', isNew ? 'Add rule' : 'Save rule', 'check', 'kj-btn-primary'),
          actions: {
            ch: function (cx, el) { var on = !el.classList.contains('is-on'); el.classList.toggle('is-on', on); el.setAttribute('aria-pressed', String(on)); },
            del: function (cx) { cx.close(); removeCond(idx); },
            ok: function (cx) {
              var v = function (k) { var el = cx.body.querySelector('[data-f="' + k + '"]'); return el ? String(el.value || '').trim() : ''; };
              var chOn = function (k) { var el = cx.body.querySelector('[data-ch="' + k + '"]'); return !!(el && el.classList.contains('is-on')); };
              var name = v('name'); if (!name) { toast('Give the condition rule a name', 'warn'); return; }
              var o = {}; Object.keys(c).forEach(function (k) { o[k] = c[k]; });
              o.name = name; o.mod = v('mod') || 'any'; o.camera = v('camera'); o.min_sev = v('min_sev') || 'low'; o.window = v('window') || 'always'; o.keyword = v('keyword');
              o.enabled = c.enabled !== false; o.channels = { email: chOn('email'), telegram: chOn('telegram') };
              var next = conditions().slice();
              if (isNew) next.push(o); else next[idx] = o;
              saveConditions(next, isNew ? 'Condition rule added' : 'Condition rule saved').then(function () { cx.close(); }, function () {});
            } } };
      } });
    M.register('kjs-user-new', { kicker: 'Users', icon: 'user-plus', size: 'md', deepLink: false,
      render: function () {
        var roles = ((S.data.roles && S.data.roles.roles) || []).map(function (r) { return r.name; }); if (!roles.length) roles = ['admin', 'supervisor', 'operator', 'viewer'];
        return { title: 'Add user', icon: 'user-plus',
          body: '<div class="kjs-modal-form">' + field('Username', '<input class="kj-input" data-f="username" autocomplete="off" placeholder="staff number or name">', 'Use the staff ID to auto-link the employee record.') +
            field('Display name', '<input class="kj-input" data-f="display_name" autocomplete="off">') + field('E-mail', '<input class="kj-input" type="email" data-f="email" autocomplete="off">') +
            field('Password', '<input class="kj-input" type="password" data-f="password" autocomplete="new-password">', 'At least 8 characters.') +
            field('Role', '<select class="kj-select" data-f="role">' + roles.map(function (r) { return '<option value="' + esc(r) + '"' + (r === 'operator' ? ' selected' : '') + '>' + esc(r) + '</option>'; }).join('') + '</select>') + '</div>',
          foot: '<button type="button" class="kj-btn kj-btn-secondary" data-kj-close>Cancel</button>' + mh.btn('ok', 'Create user', 'user-plus', 'kj-btn-primary'),
          actions: { ok: function (c) {
            var v = function (k) { var el = c.body.querySelector('[data-f="' + k + '"]'); return el ? String(el.value || '').trim() : ''; };
            if (!v('username') || v('password').length < 8) { toast('Username and a password of 8+ characters are required', 'warn'); return; }
            umPost('/users', { username: v('username'), display_name: v('display_name'), email: v('email'), role: v('role') || 'operator', password: v('password') }, 'User created').then(function () { c.close(); }, function () {});
          } } };
      } });
    M.register('kjs-pw', { kicker: 'Reset password', icon: 'key-round', size: 'sm', deepLink: false,
      render: function (ctx) {
        var u = userById(ctx.id) || { username: '#' + ctx.id };
        return { title: 'New password for ' + u.username, icon: 'key-round',
          body: '<div class="kjs-modal-form">' + field('New password', '<input class="kj-input" type="password" data-f="p1" autocomplete="new-password">', 'At least 8 characters.') +
            field('Repeat password', '<input class="kj-input" type="password" data-f="p2" autocomplete="new-password">') + '</div>',
          foot: '<button type="button" class="kj-btn kj-btn-secondary" data-kj-close>Cancel</button>' + mh.btn('ok', 'Reset password', 'check', 'kj-btn-primary'),
          actions: { ok: function (c) {
            var a = c.body.querySelector('[data-f="p1"]').value, b = c.body.querySelector('[data-f="p2"]').value;
            if (String(a).length < 8) { toast('Password too short (min 8)', 'warn'); return; }
            if (a !== b) { toast('The passwords do not match', 'warn'); return; }
            umPost('/users/' + ctx.id, { password: a }, 'Password reset').then(function () { c.close(); }, function () {});
          } } };
      } });
    M.register('kjs-link', { kicker: 'Link login ↔ employee', icon: 'link', size: 'md', deepLink: false,
      load: function () { return S.data.links ? Promise.resolve(S.data.links) : load('links').then(function (d) { if (!d) throw new Error(S.err.links || 'Could not load employees'); return d; }); },
      render: function (ctx, d) {
        var u = userById(ctx.id) || { id: +ctx.id, username: '#' + ctx.id, name: '#' + ctx.id }, L = linkOf(u.id), cur = L && L.person_id;
        var taken = {}; (d.users || []).forEach(function (x) { if (x.person_id && x.id !== u.id) taken[x.person_id] = x.username; });
        var list = (d.people || []).map(function (p) {
          var by = taken[p.person_id];
          return '<button type="button" class="kjs-pick' + (p.person_id === cur ? ' is-current' : '') + '" data-kj-action="pick" data-pid="' + esc(p.person_id) + '" data-q="' + esc([p.name, p.staff_id, p.department, p.plant, p.person_id].join(' ').toLowerCase()) + '"' + (by ? ' disabled title="Linked to ' + esc(by) + '"' : '') + '>' +
            '<span class="kj-avatar kjs-avatar">' + esc(initials(p.name)) + '</span><span class="kj-list-main"><span class="kj-list-title">' + esc(p.name || p.person_id) + '</span>' +
            '<span class="kj-list-sub">' + esc([p.staff_id, p.department, p.plant].filter(Boolean).join(' · ') || p.person_id) + (by ? ' · linked to @' + esc(by) : '') + '</span></span>' + (p.person_id === cur ? ico('check') : '') + '</button>';
        }).join('');
        return { title: 'Employee for @' + u.username, icon: 'link',
          body: '<div class="kjs-modal-form"><input class="kj-input" type="search" data-kjs-pickq placeholder="Search name, staff ID, department…" aria-label="Search employees">' +
            (list ? '<div class="kjs-pick-list" role="listbox">' + list + '</div>' : mh.empty('users', 'No employee records', 'Enrol employees under People first.')) +
            '<p class="kjs-muted">One login per employee. Staff self-service (attendance, leave, the assistant) uses this link.</p></div>',
          foot: '<button type="button" class="kj-btn kj-btn-secondary" data-kj-close>Cancel</button>' + (cur ? mh.btn('unlink', 'Unlink', 'link-2-off', 'kj-btn-ghost') : '') +
            '<button type="button" class="kj-btn kj-btn-secondary" data-kj-nav="people">' + ico('users') + 'Employee directory</button>',
          actions: {
            pick: function (c, el) {
              var pid = el.getAttribute('data-pid');
              post('/user-links', { user_id: u.id, person_id: pid }).then(function (r) { S.data.links = r; toast('Linked @' + u.username + ' to ' + (el.querySelector('.kj-list-title') || {}).textContent); c.close(); if (S.el && S.sec === 'users') paintSection(); },
                function (e) { toast(e.message, 'danger'); });
            },
            unlink: function (c) {
              post('/user-links', { user_id: u.id, person_id: '' }).then(function (r) { S.data.links = r; toast('Unlinked @' + u.username); c.close(); if (S.el && S.sec === 'users') paintSection(); }, function (e) { toast(e.message, 'danger'); });
            } },
          mount: function (c) {
            var q = c.body.querySelector('[data-kjs-pickq]'); if (!q) return;
            q.addEventListener('input', function () {
              var s = q.value.trim().toLowerCase();
              Array.prototype.forEach.call(c.body.querySelectorAll('.kjs-pick'), function (b) { b.hidden = !!s && b.getAttribute('data-q').indexOf(s) < 0; });
            });
          } };
      } });
    M.register('kjs-leave', { kicker: 'Leave allowance', icon: 'calendar-days', size: 'md', deepLink: false,
      load: function (ctx) { return get('/leaves/balances?user_id=' + encodeURIComponent(ctx.id) + '&year=' + S.leaveYear); },
      render: function (ctx, d) {
        var u = userById(ctx.id) || { username: '#' + ctx.id }, y = S.leaveYear, now = new Date().getFullYear();
        var rows = (d.balances || []).map(function (b) {
          return '<tr><td><span class="kjs-dot' + (b.unlimited ? ' is-muted' : '') + '"></span>' + esc(b.name) + ' <span class="kjs-cell-sub">' + esc(b.code) + '</span></td>' +
            '<td>' + (b.unlimited ? chip('Unlimited') : '<input class="kj-input" type="number" min="0" max="365" step="0.5" data-code="' + esc(b.code) + '" data-saved="' + esc(b.entitled) + '" value="' + esc(b.entitled) + '" aria-label="' + esc(b.name) + ' entitlement">') + '</td>' +
            '<td class="kj-num">' + esc(b.used) + '</td><td class="kj-num">' + esc(b.pending) + '</td><td class="kj-num">' + esc(b.available == null ? '∞' : b.available) + '</td></tr>';
        }).join('');
        return { title: 'Leave allowance · @' + u.username, icon: 'calendar-days',
          body: '<div class="kjs-modal-form"><div class="kj-tabs" role="tablist">' + [now - 1, now, now + 1].map(function (yr) { return '<button type="button" class="kj-tab" role="tab" aria-selected="' + (yr === y) + '" data-kj-action="year" data-y="' + yr + '">' + yr + '</button>'; }).join('') + '</div>' +
            (rows ? '<div class="kj-table-wrap"><table class="kj-table kjs-bal"><thead><tr><th>Type</th><th>Entitled (days)</th><th class="kj-num">Used</th><th class="kj-num">Pending</th><th class="kj-num">Available</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
              : mh.empty('calendar-x', 'No leave types', 'The leave module has no active leave types.')) +
            '<p class="kjs-muted">Used days are deducted on approval and restored on cancellation. Entitlement is per calendar year, 0–365 in half days.</p></div>',
          foot: '<button type="button" class="kj-btn kj-btn-secondary" data-kj-close>Close</button>' + (rows ? mh.btn('ok', 'Save allowance', 'check', 'kj-btn-primary') : ''),
          actions: {
            year: function (c, el) { S.leaveYear = +el.getAttribute('data-y'); c.reload(); },
            ok: function (c) {
              var ch = Array.prototype.filter.call(c.body.querySelectorAll('input[data-code]'), function (i) { return String(parseFloat(i.value)) !== String(parseFloat(i.getAttribute('data-saved'))); });
              if (!ch.length) { toast('No changes', 'warn'); return; }
              var bad = ch.filter(function (i) { var v = parseFloat(i.value); return !(v >= 0 && v <= 365); });
              if (bad.length) { toast('Entitlement must be 0–365 days', 'warn'); return; }
              ch.reduce(function (p, i) { return p.then(function () { return post('/leaves/balances', { user_id: +ctx.id, year: y, leave_type: i.getAttribute('data-code'), entitled: parseFloat(i.value) }); }); }, Promise.resolve())
                .then(function () { toast('Leave allowance saved for @' + u.username + ' (' + y + ')'); c.reload(); }, function (e) { toast(e.message, 'danger'); });
            } } };
      } });
    M.register('kjs-mon', { kicker: 'Camera monitor', icon: 'radar', size: 'md', deepLink: false,
      load: function (ctx) {
        var c = monFind(String(ctx.id)); if (c) return Promise.resolve(c);
        return load('mon').then(function () { var x = monFind(String(ctx.id)); if (!x) throw new Error(S.err.mon || 'Camera not found'); return x; });
      },
      render: function (ctx, c) {
        var cat = monCatalog(), cfg = c.cfg, ms = monSet(), fit = c.fit || {}, scene = fit.scene || fit.scene_summary || '';
        var swb = function (f, on, label) { return '<button type="button" role="switch" aria-checked="' + on + '" aria-label="' + esc(label) + '" class="kjs-switch' + (on ? ' is-on' : '') + '" data-kj-action="tog" data-f="' + f + '"></button>'; };
        var sel = function (f, list, cur, label) {
          return '<select class="kj-select" data-f="' + f + '" aria-label="' + esc(label) + '">' + list.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
        };
        var verdictChip = function (v) {
          return v.fit === true ? chip('✓ Fits', 'success') : (v.fit === false ? chip('✕ Does not fit', 'warn') : chip(monChecked(c) ? 'Not checked' : 'Unchecked'));
        };
        var fields = cat.map(function (f) {
          var v = monVerdict(c, f.key), on = cfg.fields.indexOf(f.key) >= 0;
          return '<label class="kjs-mon-field' + (v.fit === false ? ' is-unfit' : '') + '"><input type="checkbox" data-mon-field="' + esc(f.key) + '" data-unfit="' + (v.fit === false ? '1' : '0') + '"' + (on ? ' checked' : '') + '>' +
            '<span class="kjs-mon-field-main"><span class="kjs-mon-field-title">' + (f.icon ? ico(f.icon) : '') + esc(f.label || f.key) + '</span>' +
            (f.desc ? '<span class="kjs-cell-sub">' + esc(f.desc) + '</span>' : '') +
            '<span class="kjs-mon-verdict">' + verdictChip(v) + (v.reason ? '<span class="kjs-cell-sub">' + esc(v.reason) + '</span>' : '') + '</span></span></label>';
        }).join('');
        var lv = (notifyS().escalation || {}).levels || [];
        var notifyOpts = [[0, 'None']].concat([1, 2, 3].map(function (i) { var l = lv[i - 1] || {}; return [i, 'Level ' + i + (l.name ? ' — ' + l.name : '')]; }));
        var showForce = cfg.fields.some(function (k) { return monVerdict(c, k).fit === false; });
        var noSrc = !MON_SRC[c.frame];
        var fitPanel = '<div class="kjs-mon-fitpanel"><div class="kjs-mon-fit-head"><span class="kjs-row-title">Daily fitness check</span>' +
          '<span class="kjs-cell-sub">' + esc(fit.checked_at ? 'Checked ' + monWhen(fit.checked_at) : 'Not checked yet') + '</span></div>' +
          '<p class="kjs-mon-scene">' + esc(scene || (monChecked(c) ? 'No scene summary returned.' : 'VisionAI has not looked at this camera yet. Re-check to see what the scene contains and which fields fit.')) + '</p>' +
          (monChecked(c) ? '<div class="kjs-mon-chips">' + cat.map(function (f) { var v = monVerdict(c, f.key); return monChip((v.fit === true ? '✓ ' : (v.fit === false ? '✕ ' : '')) + (f.label || f.key), v.fit === true ? 'success' : (v.fit === false ? 'warn' : ''), v.reason); }).join('') + '</div>' : '') +
          '<div class="kjs-btns">' + '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-kj-action="recheck"' + (noSrc ? ' disabled' : '') + '>' + ico('refresh-cw') + '<span>Re-check now</span></button>' +
          (ms.fitness_enabled ? '' : chip('Daily check is off', 'warn')) + '</div></div>';
        return { title: c.name, icon: 'radar', tone: cfg.enabled ? 'success' : '', kicker: 'Camera monitor · ' + c.stream + (c.location ? ' · ' + c.location : ''),
          body: '<div class="kjs-modal-form">' +
            '<div class="kjs-btns">' + monSrcChip(c) + chip(c.online ? 'Online' : 'Offline', c.online ? 'success' : 'danger', true) + monBadge(c) + '</div>' +
            (noSrc ? '<div class="kjs-msg is-err">This camera has no snapshot or live-bridge frame, so it cannot be screened. Add a live source under Cameras &amp; RTSP first.</div>' : '') +
            '<div class="kjs-row">' + ico('power') + '<div class="kjs-row-text"><div class="kjs-row-title">Monitor this camera</div><div class="kjs-row-sub">Off keeps the settings below but stops all screening.</div></div>' + swb('enabled', cfg.enabled, 'Monitor this camera') + '</div>' +
            group('What to watch for', '<div class="kjs-mon-fields">' + fields + '</div>', 'The fast model screens for the trigger; only flagged frames go to the advanced model.') +
            '<div class="kjs-mon-force"' + (showForce ? '' : ' hidden') + ' data-mon-force><div class="kjs-row">' + ico('triangle-alert') + '<div class="kjs-row-text"><div class="kjs-row-title">Monitor anyway</div>' +
              '<div class="kjs-row-sub">The daily check says a chosen field does not fit this scene, so it is paused. Forcing it screens every interval regardless — expect extra cost and false alarms.</div></div>' + swb('force_fit', cfg.force_fit, 'Monitor anyway') + '</div></div>' +
            '<div class="kjs-form">' + field('Scan interval', sel('interval_sec', [['', 'Global (' + monIvLabel(ms.interval_sec) + ')']].concat(MON_IV), cfg.interval_sec == null ? '' : cfg.interval_sec, 'Scan interval')) +
              field('Ticket priority', sel('priority', PRIOS.map(function (p) { return [p[0], p[1]]; }), cfg.action.priority, 'Ticket priority')) +
              field('Notify on ticket', sel('notify_level', notifyOpts, cfg.action.notify_level, 'Notify escalation level'), 'E-mails that escalation level\'s recipients when a ticket opens.') + '</div>' +
            '<div class="kjs-row">' + ico('ticket') + '<div class="kjs-row-text"><div class="kjs-row-title">Create a ticket on a confirmed violation</div><div class="kjs-row-sub">Ongoing violations extend the same ticket instead of opening new ones.</div></div>' + swb('ticket', cfg.action.ticket, 'Create a ticket') + '</div>' +
            fitPanel + '</div>',
          foot: '<button type="button" class="kj-btn kj-btn-secondary" data-kj-close>Cancel</button>' + mh.btn('save', 'Save monitor', 'check', 'kj-btn-primary'),
          actions: {
            tog: function (cx, el) { var on = !el.classList.contains('is-on'); el.classList.toggle('is-on', on); el.setAttribute('aria-checked', String(on)); },
            recheck: function (cx, el) {
              el.disabled = true; el.lastChild.textContent = 'Checking…';
              post('/monitors/fitness/run?stream=' + encodeURIComponent(c.stream), {}).then(function () { return load('mon'); }).then(function () {
                toast('Fitness re-checked'); if (S.el && S.sec === 'ai') paintSection(); cx.reload();
              }, function (e) { toast(e.message, 'danger'); el.disabled = false; el.lastChild.textContent = 'Re-check now'; });
            },
            save: function (cx) {
              var q = function (s) { return cx.body.querySelector(s); };
              var on = function (f) { var el = q('[data-kj-action="tog"][data-f="' + f + '"]'); return !!(el && el.classList.contains('is-on')); };
              var val = function (f) { var el = q('[data-f="' + f + '"]'); return el ? String(el.value) : ''; };
              var chosen = Array.prototype.filter.call(cx.body.querySelectorAll('[data-mon-field]'), function (i) { return i.checked; }).map(function (i) { return i.getAttribute('data-mon-field'); });
              var en = on('enabled');
              if (en && !chosen.length) { toast('Choose at least one thing to watch for, or switch monitoring off', 'warn'); return; }
              var iv = val('interval_sec');
              var body = { enabled: en, fields: chosen, interval_sec: iv === '' ? null : +iv,
                action: { ticket: on('ticket'), priority: val('priority') || 'high', notify_level: +val('notify_level') || 0 }, force_fit: on('force_fit') };
              var b = q('[data-kj-action="save"]'); if (b) b.disabled = true;
              monPostCam(c.stream, body).then(function () { toast('Monitor saved for ' + c.name); cx.close(); }, function (e) { toast(e.message, 'danger'); if (b) b.disabled = false; });
            } },
          mount: function (cx) {
            var box = cx.body.querySelector('[data-mon-force]'); if (!box) return;
            cx.body.addEventListener('change', function (ev) {
              if (!ev.target || !ev.target.hasAttribute || !ev.target.hasAttribute('data-mon-field')) return;
              box.hidden = !Array.prototype.some.call(cx.body.querySelectorAll('[data-mon-field]'), function (i) { return i.checked && i.getAttribute('data-unfit') === '1'; });
            });
          } };
      } });
    M.register('kjs-mon-stats', { kicker: 'Camera monitors', icon: 'activity', size: 'md', deepLink: false,
      load: function () { return monD() ? Promise.resolve(monD()) : load('mon').then(function (d) { if (!d) throw new Error(S.err.mon || 'Camera monitors are unavailable'); return d; }); },
      render: function (ctx, d) {
        var t = d.stats_today || {}, by = t.by_camera && typeof t.by_camera === 'object' ? t.by_camera : {}, cr = d.cron || {};
        var names = {}; monCams().forEach(function (c) { names[c.stream] = c.name; });
        var rows = Object.keys(by).map(function (k) { var r = by[k] || {};
          return '<tr><td><button type="button" class="kjs-click" data-kj-action="cam" data-s="' + esc(k) + '"><span class="kjs-cell-name">' + esc(names[k] || k) + '</span></button></td><td class="kj-num">' + n0(r.gates) + '</td><td class="kj-num">' + n0(r.gate_hits) + '</td><td class="kj-num">' + n0(r.reviews) + '</td><td class="kj-num">' + n0(r.violations) + '</td><td class="kj-num">' + (n0(r.tokens_in) + n0(r.tokens_out)) + '</td></tr>';
        }).join('');
        var lr = cr.last_run || d.last_run;
        return { title: 'Today\'s monitor activity', icon: 'activity',
          body: '<div class="kjs-modal-form"><div class="kj-grid-4">' + mh.statTile('scan-search', n0(t.gates), 'Frames screened', '') + mh.statTile('flag', n0(t.gate_hits), 'Flagged', 'warn') +
              mh.statTile('scan-eye', n0(t.reviews), 'Reviewed', 'purple') + mh.statTile('triangle-alert', n0(t.violations), 'Violations', n0(t.violations) ? 'danger' : 'success') + '</div>' +
            '<div class="kjs-muted">' + esc((lr ? 'Last scan ' + (monWhen(lr) || '—') : 'No scan has run yet') + ' · tokens today ' + n0(t.tokens_in) + ' in · ' + n0(t.tokens_out) + ' out') + '</div>' +
            (rows ? '<div class="kj-table-wrap"><table class="kj-table"><thead><tr><th>Camera</th><th class="kj-num">Screened</th><th class="kj-num">Flagged</th><th class="kj-num">Reviewed</th><th class="kj-num">Violations</th><th class="kj-num">Tokens</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
              : mh.empty('radar', 'Nothing screened today', 'Per-camera activity appears once the scanner has run.')) +
            (cr.suggested_line ? '<div class="kjs-copyline"><span class="kj-label">Scanner cron (once per minute)</span><div class="kjs-code"><code>' + esc(cr.suggested_line) + '</code>' + mh.btn('copy', 'Copy', 'copy', 'kj-btn-sm') + '</div></div>' : '') + '</div>',
          foot: '<button type="button" class="kj-btn kj-btn-secondary" data-kj-close>Close</button>' + '<button type="button" class="kj-btn kj-btn-secondary" data-kj-nav="tickets">' + ico('ticket') + 'Open tickets</button>',
          actions: {
            copy: function () { copyText(cr.suggested_line || ''); },
            cam: function (cx, el) { var s = el.getAttribute('data-s'); if (monFind(s)) openModal('kjs-mon', s, { name: monFind(s).name }); }
          } };
      } });
  }

  /* ── lifecycle ───────────────────────────────────────────────────────── */
  function mount(el, route, app) {
    ensureModals();
    S.el = el; S.app = app; S.sec = META[route.sub] ? route.sub : 'general';
    // Legacy callers do setState({spTab:'live'|'ai'}) + setPage('settings') → land on the matching section.
    var tab = app && app.state && app.state.spTab;
    if (S.sec === 'general' && (tab === 'live' || tab === 'ai')) {
      app.setState({ spTab: 'sense' });
      setTimeout(function () { P.go('settings/' + (tab === 'live' ? 'cameras' : 'ai'), { replace: true }); }, 0);
    }
    if (!S.handlers) S.handlers = { click: onClick, input: onInput, change: onChange };
    el.addEventListener('click', S.handlers.click);
    el.addEventListener('input', S.handlers.input);
    el.addEventListener('change', S.handlers.change);
    paintFrame();
    refresh(false);
  }
  function unmount(el) {
    if (S.handlers && el) {
      el.removeEventListener('click', S.handlers.click);
      el.removeEventListener('input', S.handlers.input);
      el.removeEventListener('change', S.handlers.change);
    }
    S.el = null;
  }
  function onFeed() {
    // Cheap: the General tiles show the live fleet count — repaint only when it changed.
    if (!S.el || S.sec !== 'general' || secDirty('general')) return;
    var a = A(), f = ((a && a.state) || {}).fleet || [], sig = f.length + ':' + f.filter(function (x) { return x && x.online; }).length;
    if (sig !== S.fleetSig) { S.fleetSig = sig; paintSection(); }
  }

  // Register the page's KJModal types as soon as KJModal (a deferred script) exists, so a cold
  // deep link such as #settings/users&modal=kjs-user:3 finds its type.
  if (window.KJModal) ensureModals(); else document.addEventListener('DOMContentLoaded', ensureModals);

  var SUBS = {};
  SECTIONS.forEach(function (s) {
    var d = { label: s.label, icon: s.icon };
    if (s.perm) d.perm = s.perm;
    if (s.legacy) d.legacy = s.legacy;
    if (s.aliases) d.aliases = s.aliases;
    SUBS[s.key] = d;
  });

  // ── Legacy Component methods (verbatim from app.js; `this` is the dc app) ──
  // Still bound by app.js renderVals() / the old dc template sections (settings, rules, users)
  // (the dc #rules template is no longer routed to — #rules now lands on the native section). Remove with those template sections.
  var LegacyMethods = class {
  // ── Detection simulator (Settings) — POST /api/simulate, signed in + settings permission ──
  simPost(action){
    if(this.state.simBusy) return;
    if(action==='reset' && !window.confirm('Remove every simulated detection (DEMO… cameras), the demo employees and the demo zones?')) return;
    this.setState({simBusy:true, simMsg:action==='reset'?'Removing demo data…':'Generating a week of detections through the ingest pipeline… this takes a few seconds'});
    fetch(`${this.API}/simulate`, {method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin',
      body:JSON.stringify({action, days:7})})
      .then(r=>r.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error((d&&d.error)||'Simulation failed');
        const c=d.counts||{};
        this.setState({simBusy:false, ov:null, simMsg: action==='reset'
          ? ('Removed '+(c.events||0)+' simulated events and '+(c.employees||0)+' demo employees ✓')
          : ('Generated '+(c.events||0)+' detections over '+(d.days||7)+' days — '+(c.face||0)+' face, '+(c.ppe||0)+' PPE, '+(c.restricted||0)+' restricted-zone, '+(c.forklift||0)+' forklift ✓ Open the Overview.')});
        this.fetchFeed(); this.loadPeople(); this.loadApp(); if(this.state.reg.data) this.loadRegister(); })
      .catch(e=>this.setState({simBusy:false, simMsg:'✗ '+((e&&e.message)||'Simulation failed')}));
  }
  testLive(){
    if(this.state.lbBusy) return;
    this.setState({lbBusy:true, lbMsg:'Contacting the bridge…'});
    this.loadLive(true, true).then(lb=>{ const b=(lb&&lb.bridge)||{};
      let msg;
      if(lb && lb.ok && !lb.configured) msg='✗ Not configured — set the public base URL and save first';
      else if(lb && lb.ok && b.reachable) msg='✓ Bridge reachable · go2rtc '+(b.version||'?')+(b.ms!=null&&b.ms!==''?(' · '+b.ms+' ms'):'');
      else msg='✗ Unreachable: '+((lb&&(lb.ok?b.error:lb.error))||'no response');
      this.setState({lbBusy:false, lbMsg:msg}); });
  }
  syncLive(){
    if(this.state.lbBusy) return;
    this.setState({lbBusy:true, lbMsg:'Registering RTSP sources on the bridge…'});
    fetch(`${this.API}/live/sync?token=${this.TOK}`, {method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin', body:'{}'})
      .then(r=>r.json())
      .then(d=>{ if(!d || (!d.ok && !d.status)) throw new Error((d&&(d.error||d.msg))||'Sync failed');
        const n=(k)=>Number(d[k])||0, errs=Array.isArray(d.errors)?d.errors:[];
        let msg=(d.ok?'✓ ':'✗ ')+n('registered')+' registered · '+n('updated')+' updated · '+n('unchanged')+' unchanged'+(n('failed')?(' · '+n('failed')+' failed'):'');
        if(errs.length) msg+=' — '+errs.slice(0,3).map(e=>((e&&e.name)||'?')+': '+((e&&e.error)||'error')).join('; ');
        if(d.status){ this._lbAt=Date.now(); this.setState({lbBusy:false, lbMsg:msg, lb:d.status}); }
        else { this.setState({lbBusy:false, lbMsg:msg}); this.loadLive(true, true); }
        this.fetchFeed(); })
      .catch(e=>this.setState({lbBusy:false, lbMsg:'✗ '+((e&&e.message)||'Sync failed')}));
  }
  probeLive(stream){
    if(!stream) return; const cur=(this.state.lbProbe||{})[stream];
    if(cur && cur.busy) return;
    const put=(v)=>this.setState(s=>({lbProbe:{...s.lbProbe, [stream]:v}}));
    put({busy:true});
    fetch(`${this.API}/live/probe?token=${this.TOK}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({stream})})
      .then(r=>r.json())
      .then(d=>{ if(!d || !d.ok) throw new Error((d&&(d.error||d.msg))||'Probe failed');
        put({busy:false, ready:!!d.ready, ms:d.ms, error:d.error||'', snapshot:(d.ready&&d.snapshot)?this.liveApiUrl(d.snapshot):''}); })
      .catch(e=>put({busy:false, ready:false, error:(e&&e.message)||'Network error', snapshot:''}));
  }
  // Probe state → {busy, text, col, snap} for a table row / the camera page.
  probeView(p){
    if(!p) return {busy:false, text:'', col:'var(--text3)', snap:''};
    if(p.busy) return {busy:true, text:'', col:'var(--text3)', snap:''};
    if(p.ready) return {busy:false, text:'✓ frame'+((p.ms!=null&&p.ms!=='')?(' '+(Number(p.ms)/1000).toFixed(1)+' s'):''), col:'var(--ok)', snap:p.snapshot||''};
    return {busy:false, text:'✗ '+(p.error||'no frame'), col:'var(--crit)', snap:''};
  }
  saveLiveSource(stream, rtsp){
    stream=String(stream||'').trim(); rtsp=String(rtsp||'').trim();
    if(!stream || !rtsp){ this.setState({lbMsg:'✗ Stream label and RTSP URL are required.'}); return; }
    if(/\s/.test(rtsp) || !/^(rtsps?|rtmps?|https?|onvif|ffmpeg|isapi|dvrip|tapo|kasa|webrtc):/i.test(rtsp)){
      this.setState({lbMsg:'✗ Not a supported source URL (rtsp://user:pass@host:554/…).'}); return; }
    this.liveSourcePost({stream, rtsp}, 'Source saved', true);
  }
  removeLiveSource(stream){
    if(!stream || !window.confirm('Remove the manual RTSP source "'+stream+'"? It is also removed from the bridge.')) return;
    this.liveSourcePost({stream, remove:true}, 'Source removed', false);
  }
  liveSourcePost(body, okMsg, clear){
    if(this.state.lbBusy) return;
    this.setState({lbBusy:true, lbMsg: body.remove?'Removing source…':'Saving source and registering it on the bridge…'});
    fetch(`${this.API}/live/source?token=${this.TOK}`, {method:'POST', headers:{'Content-Type':'application/json'}, credentials:'same-origin', body:JSON.stringify(body)})
      .then(r=>r.json())
      .then(d=>{ if(!d || !d.ok) throw new Error((d&&(d.error||d.msg))||'Save failed');
        const b=d.bridge;
        const note = b ? (b.ok ? (body.remove?' · removed from the bridge':(b.direct?' · plays directly in the browser (HLS)':' · registered on the bridge')) : (' · bridge: '+(b.error||'failed'))) : ' · saved (bridge not configured)';
        this.setState({lbBusy:false, lbMsg:'✓ '+okMsg+' ('+(d.stream||body.stream)+')'+note, ...(clear?{lbNewName:'', lbNewUrl:''}:{})});
        this.loadLive(true, true); this.loadApp(); })
      .catch(e=>this.setState({lbBusy:false, lbMsg:'✗ '+((e&&e.message)||'Network error')}));
  }
  // Settings → Live Video "Save": the browser base/token plus the server→bridge connection.
  saveLive(){
    const ad=this.state.appDraft||{}, ap=this.state.appCfg||{};
    const v=(k)=>String(ad[k]!=null?ad[k]:(ap[k]!=null?ap[k]:'')).trim();
    const secret=(k)=>(ad[k] && !String(ad[k]).includes('•')) ? String(ad[k]) : '';
    const auto = ad.live_auto_sync!=null ? !!ad.live_auto_sync : (ap.live_auto_sync!=null ? !!ap.live_auto_sync : true);
    const p=this.saveApp({live_stream_base:v('live_stream_base'), live_stream_token:secret('live_stream_token'),
      live_bridge_api:v('live_bridge_api'), live_api_user:v('live_api_user'), live_api_pass:secret('live_api_pass'),
      live_auto_sync:auto}, 'Live video config saved ✓');
    if(p && p.then) p.then(()=>{ this.loadLive(true, true); this.fetchFeed(); });
  }
  // ── User & role management (session-gated /api/users, /api/roles) ──
  loadUsers(){ fetch(`${this.API}/users`, {cache:'no-store'}).then(r=>r.json())
      .then(d=>{ if(d&&d.ok) this.setState({umUsers:d.users||[]}); }).catch(()=>{}); }
  loadRoles(){ fetch(`${this.API}/roles`, {cache:'no-store'}).then(r=>r.json())
      .then(d=>{ if(d&&d.ok) this.setState({umRoles:d.roles||[], umPerms:d.permLabels||{}}); }).catch(()=>{}); }
  umPost(path, body, okMsg){
    this.setState({umMsg:'Working…'});
    fetch(`${this.API}/${path}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body||{})})
      .then(r=>r.json()).then(d=>{
        if(d&&d.ok){
          this.setState({umMsg:okMsg||'Saved ✓'});
          if(d.users) this.setState({umUsers:d.users});
          if(d.roles) this.setState({umRoles:d.roles});
          if(!d.users) this.loadUsers();
          if(!d.roles) this.loadRoles();
        } else this.setState({umMsg:'✗ '+((d&&d.error)||'Failed')});
        if(this._umT) clearTimeout(this._umT); this._umT=setTimeout(()=>this.setState({umMsg:''}), 3500);
      }).catch(()=>this.setState({umMsg:'✗ Network error'}));
  }
  umSet(k,v){ this.setState(s=>({umDraft:{...s.umDraft, [k]:v}})); }
  umAddUser(){
    const d=this.state.umDraft||{};
    if(!d.username||!d.password||String(d.password).length<8){ this.setState({umMsg:'✗ Username + password (8+ chars) required'}); return; }
    this.umPost('users', {username:d.username, display_name:d.display_name||'', email:d.email||'',
      role:d.role||'operator', password:d.password}, 'User created ✓');
    this.setState({umDraft:{}});
  }
  umResetPw(u){
    const p=window.prompt('New password for '+u.username+' (min 8 characters):');
    if(p===null) return;
    if(String(p).length<8){ this.setState({umMsg:'✗ Password too short'}); return; }
    this.umPost('users/'+u.id, {password:p}, 'Password reset ✓');
  }
  umDelUser(u){
    if(window.confirm('Delete user "'+u.username+'" permanently?')) this.umPost('users/'+u.id, {action:'delete'}, 'User deleted ✓');
  }
  umDelRole(name){
    if(window.confirm('Delete role "'+name+'"?')) this.umPost('roles', {action:'delete', name}, 'Role deleted ✓');
  }
  // ── Alert Rules (live settings via /api/alerts) ───────────
  loadAlerts(){ fetch(`${this.API}/alerts?token=${this.TOK}`, {cache:'no-store'}).then(r=>r.json())
      .then(d=>{ if(d&&d.ok) this.setState({alertCfg:d.settings}); }).catch(()=>{}); }
  saveAlerts(patch, opts){
    const cfg={...(this.state.alertCfg||{}), ...patch};
    this.setState({alertCfg:cfg, alertMsg:'Saving…'});
    const body={...patch}; if(opts&&opts.test) body.send_test=true;
    fetch(`${this.API}/alerts?token=${this.TOK}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)})
      .then(r=>r.json()).then(d=>{
        const ok=d&&d.ok;
        // Resync with the server-sanitized values (arrays normalized there).
        if(ok && d.settings) this.setState(s=>({alertCfg:{...(s.alertCfg||{}), ...d.settings}}));
        this.setState({alertMsg: ok?((opts&&opts.test)?(d.test_sent?'Saved ✓ · test email sent':'Saved ✓ · test email FAILED'):'Saved ✓'):'Save failed'});
        if(this._amT) clearTimeout(this._amT); this._amT=setTimeout(()=>this.setState({alertMsg:''}), 3000);
      }).catch(()=>this.setState({alertMsg:'Save failed'})); }
  // ── Workstream A: Telegram · escalation workflow · condition rules (/api/notify/settings) ──
  escChip(e){
    const lv=(e&&e.escLevel)|0;
    if(!lv) return {escOn:false, escLabel:'', escCol:'var(--text3)', escTitle:''};
    const lvl=((((this.state.ntCfg||{}).settings||{}).escalation||{}).levels||[])[lv-1]||{};
    const mins=e.escMin!=null?e.escMin:((e.escTs&&e.ts)?Math.max(0, Math.round((e.escTs-e.ts)/60000)):null);
    const col=lv>=3?'var(--crit)':(lv===2?'var(--high)':'var(--gold)');
    return {escOn:true, escCol:col, escLabel:'L'+lv+' · auto-escalated'+(mins!=null?(' '+mins+'m'):''),
      escTitle:'Unattended alert auto-escalated to L'+lv+(lvl.name?(' — '+lvl.name):'')+(mins!=null?(' after '+mins+' min'):'')};
  }
  ntFetch(path, body){
    const opt=body ? {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}
                   : {cache:'no-store', credentials:'same-origin'};
    return fetch(`${this.API}/${path}?token=${this.TOK}`, opt).then(r=>r.json().catch(()=>({ok:false, error:'HTTP '+r.status})));
  }
  ntFlash(msg){ this.setState({ntMsg:msg}); if(this._ntT) clearTimeout(this._ntT); this._ntT=setTimeout(()=>this.setState({ntMsg:''}), 6000); }
  ntSetDraft(k, v){ this.setState(s=>({ntDraft:{...(s.ntDraft||{}), [k]:v}})); }
  loadNotify(){ this.ntFetch('notify/settings').then(d=>{ if(d&&d.ok) this.setState({ntCfg:d}); }).catch(()=>{}); }
  saveNotify(patch, okMsg, clearKeys){
    this.setState({ntMsg:'Saving…'});
    this.ntFetch('notify/settings', patch).then(d=>{
      if(d&&d.ok){
        this.setState(s=>{ const dr={...(s.ntDraft||{})}; (clearKeys||[]).forEach(k=>{ delete dr[k]; }); return {ntCfg:d, ntDraft:dr}; });
        this.ntFlash(okMsg||'Saved ✓');
      } else this.ntFlash('Save failed — '+((d&&d.error)||'unknown error'));
    }).catch(()=>this.ntFlash('Save failed'));
  }
  testTelegram(){
    this.setState({ntMsg:'Sending Telegram test…'});
    this.ntFetch('alerts/telegram-test', {}).then(d=>{
      this.ntFlash(d&&d.ok
        ? ('Telegram test sent ✓ via @'+(d.bot||'bot')+' to '+d.sent+' chat'+(d.sent===1?'':'s')+(d.failed?(' · '+d.failed+' failed'):''))
        : ('Telegram test failed — '+((d&&(d.error||(d.errors||[]).join('; ')))||'unknown error')));
      this.loadNotify();
    }).catch(()=>this.ntFlash('Telegram test failed'));
  }
  testEmailChannel(){
    this.setState({ntMsg:'Sending test email…'});
    this.ntFetch('alerts/email-test', {}).then(d=>{
      this.ntFlash(d&&d.ok ? ('Test email sent ✓ to '+(d.to||[]).join(', ')) : ('Test email failed — '+((d&&d.error)||'unknown error')));
      this.loadNotify();
    }).catch(()=>this.ntFlash('Test email failed'));
  }
  runEscalation(dry){
    this.setState({escBusy:true, ntMsg:dry?'Checking open alerts…':'Running escalation…'});
    this.ntFetch('escalation/run', {dry_run:!!dry}).then(d=>{
      this.setState({escBusy:false, escRes:(d&&d.ok)?d:null});
      if(d&&d.ok){
        const n=(d.escalated||[]).length;
        this.ntFlash(dry ? (n+' escalation'+(n===1?'':'s')+' due now · '+(d.pending||[]).length+' upcoming')
                         : (n+' escalation'+(n===1?'':'s')+' performed ✓'));
        if(!dry){ this.loadNotify(); this.fetchFeed(); }
      } else this.ntFlash('Escalation check failed — '+((d&&d.error)||'unknown error'));
    }).catch(()=>{ this.setState({escBusy:false}); this.ntFlash('Escalation check failed'); });
  }
  saveConditions(list, msg){ this.saveNotify({conditions:list}, msg||'Condition rules saved ✓'); }

  /** Bindings for the Notifications tab (Telegram / escalation) and the Alert Rules condition rules. */
  wsAVals(st){
    const nc=st.ntCfg||null, S=(nc&&nc.settings)||{}, tg=S.telegram||{}, es=S.escalation||{}, ch=(nc&&nc.channels)||{};
    const stats=(nc&&nc.stats)||{}, dr=st.ntDraft||{};
    const dv=(k, f)=> dr[k]!=null ? dr[k] : f;
    const tog=(on)=>({bg:on?'var(--ok)':'var(--line2)', knob:on?'18px':'2px'});
    const inp=(k)=>(e)=>this.ntSetDraft(k, e&&e.target?e.target.value:'');
    const chips=(opts, cur, cb)=>opts.map(([v,label])=>({label, cls:String(cur)===String(v)?'chip on':'chip', onClick:()=>cb(v)}));
    const em=ch.email||{}, tc=ch.telegram||{}, se=stats.email||{}, stg=stats.telegram||{};
    const chanRow=(label, c, s, okLine, offLine)=>{
      const ready=!!c.ready;
      return {label, ready, mark:ready?'✓':'✗', col:ready?'var(--ok)':(c.configured?'var(--gold)':'var(--text3)'),
        line: ready?okLine:offLine,
        stat:(s.sent24h||0)+' sent 24h · '+(s.escalations||0)+' escalations'+(s.failed?(' · '+s.failed+' failed'):''),
        err:s.last_error?('Last error: '+s.last_error):''};
    };
    const chEmail=chanRow('Email', em, se, 'Ready · '+(em.recipients||0)+' base recipient'+(em.recipients===1?'':'s'),
      !em.configured?'Not configured — set MAIL_HOST / MAIL_USERNAME in .env':(!em.enabled?'Switched off on the Alert Rules page':'No recipients'));
    const chTg=chanRow('Telegram', tc, stg, 'Ready · '+(tc.chats||0)+' default chat'+(tc.chats===1?'':'s'),
      !tc.configured?'No bot token yet':(!tc.enabled?'Switched off':'No chat ID'));
    const tgOn=dv('tg_enabled', !!tg.enabled), tgPhoto=tg.send_photo!==false;
    const escOn=!!es.enabled;
    const unit=es.unattended_min||5;
    const lvlCol=['var(--gold)','var(--high)','var(--crit)'];
    const levels=(es.levels||[{},{},{}]).map((l,i)=>{
      const k='esc_l'+i+'_';
      return {tag:'L'+(i+1), col:lvlCol[i], after:'after '+(unit*(i+1))+' min unattended',
        name:dv(k+'name', l.name||''), onName:inp(k+'name'),
        emails:dv(k+'emails', (l.emails||[]).join(', ')), onEmails:inp(k+'emails'),
        chats:dv(k+'chats', (l.chats||[]).join(', ')), onChats:inp(k+'chats'),
        warn:(!(l.emails||[]).length && !(l.chats||[]).length)?'No recipients — this level is logged only':''};
    });
    const levelKeys=[0,1,2].reduce((a,i)=>a.concat(['esc_l'+i+'_name','esc_l'+i+'_emails','esc_l'+i+'_chats']), []);
    const er=st.escRes, sevCol=this.SEV||{};
    const stateTxt=(v)=> v==null?'—':v;
    const escResRows=er?(er.escalated||[]).slice(0,40).map(x=>({
      lv:'L'+x.level, col:lvlCol[(x.level||1)-1], title:x.title, camera:x.camera, sev:x.sev, sevCol:sevCol[x.sev]||'var(--text2)',
      sub:x.level_name+' · unattended '+x.unattended_min+' min (age '+x.age_min+' min)'+(x.simulated?' · simulated':''),
      chan:'Email '+stateTxt(x.email)+' · Telegram '+stateTxt(x.telegram)})):[];
    const escPendRows=er?(er.pending||[]).slice(0,15).map(x=>({
      lv:x.level?('L'+x.level):'—', title:x.title, camera:x.camera,
      sub:'→ L'+x.next+' '+x.next_name+' in '+Math.ceil((x.due_in_s||0)/60)+' min'+(x.simulated?' · simulated':'')})):[];
    const last=(nc&&nc.escalation&&nc.escalation.last)||null, obl=(nc&&nc.escalation&&nc.escalation.open_by_level)||{};
    const recent=((nc&&nc.recent)||[]).slice(0,10).map(r=>({at:r.at, ch:r.channel==='telegram'?'Telegram':'Email',
      kind:r.kind, ok:r.ok?'✓':'✗', col:r.ok?'var(--ok)':'var(--crit)', note:(r.note||'')+(r.sim?' · simulated':'')}));

    // ── condition rules (Alert Rules page) ──
    const conds=Array.isArray(S.conditions)?S.conditions:[];
    const modName={any:'Any module', fire:'Fire & Smoke', ppe:'PPE', intr:'Intrusion', face:'Face & Body', forklift:'Forklift', behaviour:'Behaviour'};
    const condRows=conds.map((c,i)=>{ const t=tog(c.enabled!==false);
      return {name:c.name, desc:(modName[c.mod]||c.mod)+' · '+(c.camera?c.camera.toUpperCase():'any camera')+' · severity ≥ '+c.min_sev
          +' · '+(c.window==='always'?'24 h':c.window)+(c.keyword?(' · matches "'+c.keyword+'"'):''),
        chans:[c.channels&&c.channels.email?'Email':'', c.channels&&c.channels.telegram?'Telegram':''].filter(Boolean).join(' + ')||'No channel',
        toggleBg:t.bg, knobX:t.knob,
        onToggle:()=>this.saveConditions(conds.map((x,j)=>j===i?{...x, enabled:!(x.enabled!==false)}:x)),
        onDelete:()=>{ if(window.confirm('Delete condition rule "'+c.name+'"?')) this.saveConditions(conds.filter((x,j)=>j!==i), 'Condition rule deleted'); }}; });
    const cf=st.condForm||{};
    const cfSet=(k)=>(e)=>{ const v=e&&e.target?e.target.value:''; this.setState(s=>({condForm:{...(s.condForm||{}), [k]:v}})); };
    const sel=(opts, cur, k)=>({value:String(cur), onChange:cfSet(k), options:opts.map(([v,label])=>({v:String(v), label}))});
    const camOpts=[['','Any camera']].concat(((nc&&nc.cameras)||[]).concat((st.fleet||[]).map(f=>f.stream))
      .filter((v,i,a)=>v&&a.indexOf(v)===i).slice(0,80).map(c=>[c, String(c).toUpperCase()]));
    const cfEmail=cf.email!==false, cfTg=cf.telegram!==false;
    return {
      ntMsg:st.ntMsg||'', loaded:!!nc,
      chEmail, chTg, chanLine:'Channels: Email '+chEmail.mark+' · Telegram '+chTg.mark,
      tgToggleBg:tog(tgOn).bg, tgKnob:tog(tgOn).knob,
      onTgToggle:()=>{ this.ntSetDraft('tg_enabled', !tgOn); this.saveNotify({telegram:{enabled:!tgOn}}, !tgOn?'Telegram on ✓':'Telegram off', ['tg_enabled']); },
      tgPhotoBg:tog(tgPhoto).bg, tgPhotoKnob:tog(tgPhoto).knob,
      onTgPhoto:()=>this.saveNotify({telegram:{send_photo:!tgPhoto}}, 'Saved ✓'),
      tgToken:dv('tg_token', tg.bot_token||''), onTgToken:inp('tg_token'),
      tgTokenState:tg.has_token?'TOKEN SET':'NO TOKEN', tgTokenCol:tg.has_token?'var(--ok)':'var(--text3)',
      tgChats:dv('tg_chats', (tg.chat_ids||[]).join(', ')), onTgChats:inp('tg_chats'),
      saveTg:()=>{ const t={chat_ids:dv('tg_chats', (tg.chat_ids||[]).join(', '))};
        const tok=dr.tg_token; if(tok && tok.indexOf('•')<0) t.bot_token=tok.trim();
        this.saveNotify({telegram:t}, 'Telegram settings saved ✓', ['tg_token','tg_chats']); },
      testTg:()=>this.testTelegram(), testEmail:()=>this.testEmailChannel(),
      escToggleBg:tog(escOn).bg, escKnob:tog(escOn).knob,
      onEscToggle:()=>this.saveNotify({escalation:{enabled:!escOn}}, !escOn?'Escalation workflow on ✓':'Escalation workflow off'),
      escMinChips:chips([[1,'1 min'],[5,'5 min'],[10,'10 min'],[15,'15 min']], unit, v=>this.saveNotify({escalation:{unattended_min:v}}, 'Unattended threshold '+v+' min ✓')),
      escSevChips:chips([['medium','Medium +'],['high','High +'],['critical','Critical only']], es.min_severity||'high', v=>this.saveNotify({escalation:{min_severity:v}}, 'Saved ✓')),
      escLevels:levels,
      saveLevels:()=>this.saveNotify({escalation:{levels:levels.map(l=>({name:l.name, emails:l.emails, chats:l.chats}))}}, 'Escalation levels saved ✓', levelKeys),
      escFlow:'Open alert (severity ≥ '+(es.min_severity||'high')+') → not acknowledged for '+unit+' min → L1 '+((levels[0]||{}).name||'')
        +' → '+(unit*2)+' min → L2 '+((levels[1]||{}).name||'')+' → '+(unit*3)+' min → L3 '+((levels[2]||{}).name||'')
        +'. Acknowledging or resolving the alert stops the chain.',
      escOpenLine:'Open & escalated now: L1 '+(obl[1]||0)+' · L2 '+(obl[2]||0)+' · L3 '+(obl[3]||0),
      escLastLine:last?('Last automatic run '+last.ran_at+' · checked '+last.checked+' open alerts · '+last.escalated+' escalated'):'No automatic run yet — runs from the dashboard poll (at most once a minute) and /api/report/cron',
      escBusy:!!st.escBusy, runDry:()=>this.runEscalation(true), runNow:()=>this.runEscalation(false),
      escResHas:!!er, escResTitle:er?((er.dry_run?'Preview (dry run) · ':'Run · ')+er.ran_at+' · '+er.checked+' open alerts checked'+(er.enabled?'':' · workflow is OFF')):'',
      escResRows, escResHasRows:escResRows.length>0, escResNone:!!er && escResRows.length===0,
      escPendRows, escPendHas:escPendRows.length>0,
      recent, recentHas:recent.length>0, recentNone:recent.length===0,
      // condition rules
      condRows, condHas:condRows.length>0, condNone:condRows.length===0,
      cfName:cf.name||'', onCfName:cfSet('name'), cfKeyword:cf.keyword||'', onCfKeyword:cfSet('keyword'),
      cfMod:sel(Object.entries(modName), cf.mod||'any', 'mod'),
      cfCam:sel(camOpts, cf.camera||'', 'camera'),
      cfSev:sel([['low','Any severity'],['medium','Medium +'],['high','High +'],['critical','Critical']], cf.min_sev||'low', 'min_sev'),
      cfWin:sel([['always','24 h'],['22:00-06:00','After hours 22:00–06:00'],['06:00-22:00','Working hours 06:00–22:00'],['19:00-07:00','Night shift 19:00–07:00'],['07:00-19:00','Day shift 07:00–19:00']], cf.window||'always', 'window'),
      cfEmailCls:cfEmail?'chip on':'chip', cfTgCls:cfTg?'chip on':'chip',
      cfToggleEmail:()=>this.setState(s=>({condForm:{...(s.condForm||{}), email:!cfEmail}})),
      cfToggleTg:()=>this.setState(s=>({condForm:{...(s.condForm||{}), telegram:!cfTg}})),
      addCond:()=>{ const name=String(cf.name||'').trim();
        if(!name){ this.ntFlash('Give the condition rule a name'); return; }
        this.saveConditions(conds.concat([{name, mod:cf.mod||'any', camera:cf.camera||'', min_sev:cf.min_sev||'low', window:cf.window||'always',
          keyword:String(cf.keyword||'').trim(), enabled:true, channels:{email:cfEmail, telegram:cfTg}}]), 'Condition rule added ✓');
        this.setState({condForm:{}}); },
    };
  }
  // ── Danger zone: wipe every stored detection ──────────────
  // Two-step: the first click arms the button, the second one purges.
  purgeEvents(){
    if(!this.state.purgeArmed){
      this.setState({purgeArmed:true, purgeMsg:'Click again to permanently delete all event data.'});
      if(this._pgT) clearTimeout(this._pgT);
      this._pgT=setTimeout(()=>this.setState({purgeArmed:false, purgeMsg:''}), 8000);
      return;
    }
    if(this._pgT) clearTimeout(this._pgT);
    this.setState({purgeArmed:false, purgeBusy:true, purgeMsg:'Purging…'});
    fetch(`${this.API}/events/purge?token=${this.TOK}`, {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({confirm:'PURGE'})})
      .then(r=>r.json()).then(d=>{
        if(d&&d.ok){
          this._over={};                              // local triage overrides are moot now
          this.setState({purgeBusy:false, purgeMsg:(d.purged||0)+' event(s) deleted ✓',
            events:[], trend:[], byType:{}, byCam:{}, ai:null, ppe:null, policies:[]});
          this.camPool=[];
          this.fetchFeed();
        } else this.setState({purgeBusy:false, purgeMsg:(d&&d.error)||'Purge failed'});
      })
      .catch(()=>this.setState({purgeBusy:false, purgeMsg:'Purge failed'}));
  }
  purgeCancel(ev){ if(ev&&ev.stopPropagation) ev.stopPropagation();
    if(this._pgT) clearTimeout(this._pgT);
    this.setState({purgeArmed:false, purgeMsg:''}); }
  // ── Settings page (via /api/settings) ─────────────────────
  loadApp(){ fetch(`${this.API}/settings?token=${this.TOK}`, {cache:'no-store'}).then(r=>r.json())
      .then(d=>{ if(d&&d.ok) this.setState({appCfg:d.settings, appDraft:{}}); }).catch(()=>{}); }
  setDraft(k,v){ this.setState(s=>({appDraft:{...s.appDraft, [k]:v}})); }
  saveApp(patch, okMsg){
    this.setState({appMsg:'Saving…'});
    return fetch(`${this.API}/settings?token=${this.TOK}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(patch)})
      .then(r=>r.json()).then(d=>{
        if(d&&d.ok){
          if(d.rotated&&d.rotated.read_token){ this.setState({appMsg:'Read token rotated — reloading…'}); setTimeout(()=>location.reload(), 1200); return; }
          this.setState({appMsg: okMsg||'Saved ✓'}); this.loadApp();
        } else this.setState({appMsg:'Save failed'});
        if(this._apT) clearTimeout(this._apT); this._apT=setTimeout(()=>this.setState({appMsg:''}), 3000);
      }).catch(()=>this.setState({appMsg:'Save failed'})); }
  regenToken(kind){
    const warn = kind==='ingest'
      ? 'Regenerate the INGEST token?\n\nEvery VisionAI policy Push URL must be updated afterwards or pushes will be rejected.'
      : 'Regenerate the READ token?\n\nThe dashboard will reload with the new token.';
    if(!window.confirm(warn)) return;
    this.saveApp(kind==='ingest'?{regen_ingest:true}:{regen_read:true}, 'Token rotated ✓ — update VisionAI push URLs'); }
  sendReportNow(){ this.setState({appMsg:'Sending report…'});
    fetch(`${this.API}/report/run?token=${this.TOK}`, {cache:'no-store'}).then(r=>r.json())
      .then(d=>this.setState({appMsg:(d&&d.ok)?'Report sent ✓ — check inbox':'Report failed — check SMTP / recipients'}))
      .catch(()=>this.setState({appMsg:'Report failed'})); }
  // ── Settings: integrations, retention, model thresholds, network test ──
  wsdLoadSettings(){ this.loadInt(); this.loadRet(); this.loadTh(); }
  loadInt(){ this.wsdGet('/integration/config').then(d=>this.setState({intD:d, intHooks:null})).catch(e=>this.setState({intMsg:'✗ '+e.message})); }
  intRegen(){
    const has=!!(this.state.intD&&this.state.intD.settings&&this.state.intD.settings.has_key);
    if(has && !window.confirm('Rotate the integration API key?\n\nHRMS / MES systems using the current key stop working until they are given the new one.')) return;
    this.setState({intMsg:'Generating key…'});
    this.wsdPost('/integration/config', {regen_key:true})
      .then(d=>this.setState(st=>({intNewKey:d.new_key||'', intD:{...(st.intD||{}), settings:d.settings}, intMsg:'New key generated — copy it now, it is shown only once ✓'})))
      .catch(e=>this.setState({intMsg:'✗ '+e.message}));
  }
  intRevoke(){
    if(!window.confirm('Revoke the integration API key? The integration API is disabled until a new key is generated.')) return;
    this.wsdPost('/integration/config', {revoke_key:true})
      .then(d=>this.setState(st=>({intNewKey:'', intD:{...(st.intD||{}), settings:d.settings}, intMsg:'Key revoked ✓'})))
      .catch(e=>this.setState({intMsg:'✗ '+e.message}));
  }
  intHookList(){ const st=this.state; if(st.intHooks) return st.intHooks;
    return ((st.intD&&st.intD.settings&&st.intD.settings.webhooks)||[]).map(h=>({...h, events:[...(h.events||[])]})); }
  intHookSet(i, patch){ const l=this.intHookList().map(h=>({...h})); l[i]={...l[i], ...patch}; this.setState({intHooks:l, intMsg:''}); }
  intHookAdd(){ const l=this.intHookList(); if(l.length>=10) return;
    this.setState({intHooks:[...l, {id:'', url:'', secret:'', events:['incident','attendance'], enabled:true}], intMsg:''}); }
  intHookRemove(i){ this.setState({intHooks:this.intHookList().filter((_,j)=>j!==i), intMsg:'Removed — save to apply'}); }
  intHookEvent(i, ev){ const h=this.intHookList()[i]; const e=h.events.indexOf(ev)>=0?h.events.filter(x=>x!==ev):[...h.events, ev]; this.intHookSet(i, {events:e}); }
  intSaveHooks(){
    const l=this.intHookList(), bad=l.find(h=>!/^https?:\/\/\S+$/i.test(String(h.url||'').trim()));
    if(bad){ this.setState({intMsg:'✗ Every webhook needs an http(s) URL'}); return; }
    this.setState({intMsg:'Saving webhooks…'});
    this.wsdPost('/integration/config', {webhooks:l})
      .then(d=>this.setState(st=>({intD:{...(st.intD||{}), settings:d.settings}, intHooks:null, intMsg:'Webhooks saved ✓'})))
      .catch(e=>this.setState({intMsg:'✗ '+e.message}));
  }
  intTest(h){
    if(!h.id){ this.setState({intMsg:'✗ Save the webhook first, then send a test'}); return; }
    this.setState({intMsg:'Sending test webhook…'});
    this.wsdPost('/integration/test', {id:h.id})
      .then(d=>{ this.setState({intMsg:'Test delivered ✓ HTTP '+d.code+' in '+d.ms+' ms'}); this.loadInt(); })
      .catch(e=>{ this.setState({intMsg:'✗ Test failed — '+e.message}); this.loadInt(); });
  }
  loadRet(){ this.wsdGet('/retention').then(d=>this.setState({retD:d})).catch(e=>this.setState({retMsg:'✗ '+e.message})); }
  retSave(days){
    this.setState({retMsg:'Saving…', retDays:days});
    this.wsdPost('/retention', {retention_days:days})
      .then(d=>this.setState(st=>({retD:{...(st.retD||{}), storage:d.storage}, retDays:null, retMsg:'Retention set to '+(days?days+' days':'keep forever')+' ✓'})))
      .catch(e=>this.setState({retDays:null, retMsg:'✗ '+e.message}));
  }
  retPurge(){
    const due=this.state.retD&&this.state.retD.due;
    if(!window.confirm('Purge now?\n\n'+((due&&due.events)||0)+' events older than the retention window (and their PPE / zone rows, incident log and ticket attachments) are deleted permanently.')) return;
    this.setState({retMsg:'Purging…'});
    this.wsdPost('/retention', {purge_now:true})
      .then(d=>{ this.setState({retMsg:'Purged '+((d.purge&&d.purge.events)||0)+' events ✓'}); this.loadRet(); })
      .catch(e=>this.setState({retMsg:'✗ '+e.message}));
  }
  runNetTest(stream){
    this.setState({netBusy:true, netMsg:stream?('Testing '+stream+'…'):'Running network test — up to ~50 s…'});
    this.wsdPost('/live/nettest', stream?{stream}:{})
      .then(d=>{ if(stream && this.state.netD){
          const rows=(this.state.netD.rows||[]).map(r=>r.name===stream?(d.rows[0]||r):r);
          this.setState(st=>({netD:{...st.netD, rows}, netBusy:false, netMsg:'Re-tested '+stream+' ✓'})); }
        else this.setState({netD:d, netBusy:false, netMsg:'Network test finished ✓'}); })
      .catch(e=>this.setState({netBusy:false, netMsg:'✗ '+e.message}));
  }
  loadTh(){ this.wsdGet('/aiperf/thresholds').then(d=>this.setState({aiTh:{face:String(d.face_min_similarity), ppe:String(d.ppe_min_conf)}})).catch(()=>{}); }
  aiThSave(){
    const t=this.state.aiTh||{}, f=parseFloat(t.face), p=parseFloat(t.ppe);
    if(!(f>=0&&f<=100) || !(p>=0&&p<=100)){ this.setState({aiThMsg:'✗ Thresholds are percentages 0–100 (0 = off)'}); return; }
    this.setState({aiThMsg:'Saving…'});
    this.wsdPost('/aiperf/thresholds', {face_min_similarity:f, ppe_min_conf:p})
      .then(d=>this.setState({aiTh:{face:String(d.face_min_similarity), ppe:String(d.ppe_min_conf)}, aiThMsg:'Thresholds saved — applied to new detections ✓'}))
      .catch(e=>this.setState({aiThMsg:'✗ '+e.message}));
  }
  };

  P.register('settings', {
    title: 'Settings',
    perm: 'settings',
    defaultSub: 'general',
    subs: SUBS,
    // Every section is host-mounted now (Alert rules went native); the loaders stay so an explicit
    // app.applyPage('settings'|'users'|'rules') on the old dc template still works.
    enter: function (app, page) {
      if (page === 'rules') { app.loadAlerts(); app.loadNotify(); }
      if (page === 'settings') { app.loadApp(); app.loadAlerts(); app.loadLive(true); app.loadNotify(); app.wsdLoadSettings(); }
      if (page === 'users') { app.loadUsers(); app.loadRoles(); }
    },
    mount: mount,
    unmount: unmount,
    onFeed: onFeed,
    methods: LegacyMethods
  });
})();
