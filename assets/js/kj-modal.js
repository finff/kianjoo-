/* ==========================================================================
 * KJModal — global typed detail-modal framework (M2)
 *
 *   KJModal.open(type, id, data?)   open (stacks on top of any open modal)
 *   KJModal.close()                 close the top modal
 *   KJModal.closeAll()
 *   KJModal.register(type, def)     add a modal type (see FRONTEND_FOUNDATIONS.md)
 *   KJModal.toast(msg, tone?)       small toast (tone: success|warn|danger)
 *
 * Declarative: any element with data-kj-modal="type:id" opens that modal on
 * click / Enter / Space (delegated — works for React-rendered markup too).
 * Optional data-kj-seed='{"name":"…"}' passes seed data (JSON).
 *
 * Deep links: the top modal is mirrored in the URL hash as a suffix that the
 * SPA router ignores:  #overview&modal=event:abc123   #camera/cam01&modal=person:42
 * Opening such a URL re-opens the modal after the dashboard boots.
 *
 * Data: reads the live dashboard state (window.KJApp, set by app.js) first,
 * then falls back to the existing /api routes. Never writes anything.
 * ========================================================================== */
(function () {
  'use strict';

  /* ── utils ─────────────────────────────────────────────── */
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) { return v == null ? '' : String(v).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; }); }
  function ico(name, cls) { return window.KJIcon ? window.KJIcon.svg(name, cls) : ''; }
  function app() { return window.KJApp || null; }
  function st() { var a = app(); return (a && a.state) || {}; }
  function N(v) { return Number(v) || 0; }
  function fmtN(v) { return N(v).toLocaleString('en-US'); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today() { return ymd(new Date()); }
  function toDate(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return new Date(v);
    var s = String(v);
    if (/^\d{10,13}$/.test(s)) return new Date(s.length === 10 ? N(s) * 1000 : N(s));
    var d = new Date(s.replace(' ', 'T'));
    return isNaN(d) ? null : d;
  }
  function fmtTime(v) {
    var d = toDate(v); if (!d) return v ? String(v) : '—';
    var t = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    return ymd(d) === today() ? 'Today ' + t : ymd(d) + ' ' + t;
  }
  function fmtHM(v) { var d = toDate(v); return d ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : '—'; }
  function fmtDate(s) {
    var d = toDate(String(s).length === 10 ? s + 'T00:00:00' : s); if (!d) return String(s || '—');
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  function ago(v) {
    var d = toDate(v); if (!d) return '';
    var m = Math.round((Date.now() - d.getTime()) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60); if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  }
  function dur(ms) {
    if (ms == null || isNaN(ms) || ms < 0) return '—';
    var m = Math.floor(ms / 60000); if (m < 1) return '<1m'; if (m < 60) return m + 'm';
    var h = Math.floor(m / 60); if (h < 24) return h + 'h ' + pad(m % 60) + 'm';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  }
  function step5(pct) { return Math.max(0, Math.min(100, Math.round(N(pct) / 5) * 5)); }
  function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (p) { return p[0] || ''; }).join('').toUpperCase() || '?';
  }
  function spec(type, id) { return type + ':' + encodeURIComponent(String(id == null ? '' : id)); }
  function attrSeed(obj) { return obj ? " data-kj-seed='" + esc(JSON.stringify(obj)) + "'" : ''; }
  function link(type, id, label, seed) {
    if (id == null || id === '') return esc(label || '—');
    return '<button type="button" class="kj-link" data-kj-modal="' + esc(spec(type, id)) + '"' + attrSeed(seed) + '>' + esc(label || id) + '</button>';
  }
  function chip(text, tone, dot) { return '<span class="kj-chip' + (tone ? ' is-' + tone : '') + (dot ? ' kj-chip-dot' : '') + '">' + esc(text) + '</span>'; }
  function kv(rows) {
    return '<dl class="kj-kv">' + rows.filter(Boolean).map(function (r) {
      return '<div><dt>' + esc(r[0]) + '</dt><dd>' + (r[2] ? r[1] : esc(r[1] == null || r[1] === '' ? '—' : r[1])) + '</dd></div>';
    }).join('') + '</dl>';
  }
  function statTile(icon, val, lbl, tone, modalSpec) {
    var tag = modalSpec ? 'button type="button" data-kj-modal="' + esc(modalSpec) + '"' : 'div';
    return '<' + tag + ' class="kj-stat' + (tone ? ' is-' + tone : '') + '"><span class="kj-stat-ico">' + ico(icon) + '</span>' +
      '<span><span class="kj-stat-val">' + esc(val) + '</span><span class="kj-stat-lbl">' + esc(lbl) + '</span></span></' + (modalSpec ? 'button' : 'div') + '>';
  }
  function empty(icon, title, text, isErr) {
    return '<div class="kj-empty' + (isErr ? ' is-error' : '') + '"><span class="kj-empty-ico">' + ico(icon) + '</span>' +
      '<div class="kj-empty-title">' + esc(title) + '</div>' + (text ? '<div class="kj-empty-text">' + esc(text) + '</div>' : '') + '</div>';
  }
  function section(title, html) { return '<div><div class="kj-section-title">' + esc(title) + '</div>' + html + '</div>'; }
  function media(url, label, tag) {
    if (!url) return '<div class="kj-media kj-media-empty">' + empty('image-off', 'No image', '') + '</div>';
    return '<div class="kj-media kj-media-zoom" data-kj-modal="' + esc(spec('image', url)) + '"' + attrSeed({ label: label || '' }) + '>' +
      '<img src="' + esc(url) + '" alt="' + esc(label || 'Detection image') + '" loading="lazy">' + (tag ? '<span class="kj-media-tag">' + tag + '</span>' : '') + '</div>';
  }
  function avatar(photo, name, cls) {
    return photo ? '<img class="kj-avatar ' + (cls || '') + '" src="' + esc(photo) + '" alt="' + esc(name || '') + '">'
      : '<span class="kj-avatar ' + (cls || '') + '">' + esc(initials(name)) + '</span>';
  }
  function minibars(items, tone) {
    var mx = Math.max(1, Math.max.apply(null, items.map(function (i) { return N(i.v); })));
    return '<div class="kj-minibars">' + items.map(function (i) {
      var tag = i.modal ? 'button type="button" data-kj-modal="' + esc(i.modal) + '"' : 'div';
      return '<' + tag + ' class="kj-minibar" title="' + esc(i.tip || (i.lbl + ': ' + i.v)) + '"><span class="kj-minibar-val">' + esc(fmtN(i.v)) + '</span>' +
        '<span class="kj-minibar-track"><span class="kj-minibar-fill kj-h-' + step5(100 * N(i.v) / mx) + (i.tone || tone ? ' kj-fill-' + (i.tone || tone) : '') + '"></span></span>' +
        '<span class="kj-minibar-lbl">' + esc(i.lbl) + '</span></' + (i.modal ? 'button' : 'div') + '>';
    }).join('') + '</div>';
  }
  function hbars(rows, tone) {
    var mx = Math.max(1, Math.max.apply(null, rows.map(function (r) { return N(r.n); })));
    return '<div class="kj-stack">' + rows.map(function (r) {
      return '<div><div class="kj-row"><span class="kj-truncate kj-text-2">' + esc(r.label) + '</span><span class="kj-spacer"></span><b>' + esc(r.val != null ? r.val : fmtN(r.n)) + '</b></div>' +
        '<div class="kj-progress"><div class="kj-progress-fill kj-w-' + step5(r.pct != null ? r.pct : 100 * N(r.n) / mx) + ' kj-fill-' + (r.tone || tone || 'muted') + '"></div></div></div>';
    }).join('') + '</div>';
  }

  /* ── API ───────────────────────────────────────────────── */
  var T = window.TMNS || {};
  function api(path, params) {
    var base = (window.TMNS && window.TMNS.api) || '/api';
    var tok = (window.TMNS && window.TMNS.token) || '';
    var q = new URLSearchParams(params || {});
    if (tok) q.set('token', tok);
    return fetch(base + path + (q.toString() ? '?' + q : ''), { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return { ok: false, status: r.status }; }).then(function (d) { if (d && typeof d === 'object' && d.status == null) d.status = r.status; return d; }); })
      .then(function (d) { if (!d || d.ok === false) { var e = new Error((d && (d.error || d.msg)) || 'Request failed'); e.status = d && d.status; throw e; } return d; });
  }
  function soft(p) { return p.catch(function () { return null; }); }
  var dayCache = {};
  function daily(date) {
    var c = dayCache[date];
    if (c && Date.now() - c.at < 30000) return c.p;
    var p = api('/attendance/daily', { date: date });
    dayCache[date] = { at: Date.now(), p: p };
    p.catch(function () { delete dayCache[date]; });
    return p;
  }

  /* ── domain normalisers ────────────────────────────────── */
  var MOD = {
    face: ['Face & Body', 'scan-face', 'primary'], ppe: ['PPE', 'hard-hat', 'warn'], intr: ['Restricted / Intrusion', 'shield-alert', 'danger'],
    forklift: ['Forklift', 'forklift', 'orange'], fire: ['Fire & Smoke', 'flame', 'danger'], cleaning: ['Cleaning', 'sparkles', 'success'],
    behaviour: ['Behaviour', 'activity', 'purple']
  };
  var SEV = { critical: ['Critical', 'danger'], high: ['High', 'danger'], medium: ['Medium', 'warn'], low: ['Low', 'primary'] };
  var EST = { open: ['Open', 'danger'], ack: ['Acknowledged', 'warn'], resolved: ['Resolved', 'success'], closed: ['Closed', 'success'] };
  var ATT = { present: ['Present', 'success'], late: ['Late', 'warn'], absent: ['Absent', 'danger'], pending: ['Not yet in', 'primary'], off: ['Off day', ''] };
  var FLAG = { missing_out: 'Missing clock-out', early_out: 'Early clock-out', off_day: 'Worked on off day' };

  // Accepts the feed incident shape (DashboardMapper), the overview row shape,
  // module "recent" rows and the raw /events/{uuid} record.
  function normEvent(e) {
    if (!e) return null;
    var img = e.images || {};
    return {
      id: e.id != null && e.uuid == null ? e.id : (e.uuid || e.id),
      mod: e.mod || e.feed_kind || '', sev: e.sev || e.severity || e.alert_level || '',
      title: e.title || e.verdictLabel || e.type || e.event_type || e.policy_name || 'Detection',
      camera: e.camera || (e.stream ? String(e.stream).toUpperCase() : '') || e.device_serial || '',
      device: e.device || e.device_name || '', zone: e.zone || e.policy || e.policy_name || '',
      location: e.location || '', plant: e.plant || '',
      ts: e.ts || e.received || e.received_at || e.time || e.trigger_time || null,
      status: e.status || '', assignee: e.assignee || '',
      image: e.image || img.trigger || null, imageBk: e.imageBk || img.background || null, imageMatch: e.imageMatch || img.match || null,
      person: e.person || e.person_name || e.who || '', personId: e.personId || e.person_id || '',
      similarity: e.similarity || '', ticket: e.ticket || e.ticket_no || null,
      ticketedTs: e.ticketedTs || null, ackedTs: e.ackedTs || null, resolvedTs: e.resolvedTs || null,
      escLevel: e.escLevel || 0, verdict: e.verdictLabel || e.verdict || '', policyDesc: e.policyDesc || e.policy_desc || '',
      raw: e
    };
  }
  function appEvent(id) {
    var s = String(id);
    return (st().events || []).find(function (e) { return String(e.id) === s || String(e.ticket || '') === s; }) || null;
  }
  function camKey(v) { return String(v || '').trim().toLowerCase(); }
  function findCamera(id) {
    var k = camKey(id), a = app();
    var pool = (st().fleet || []).slice();
    try { if (a && typeof a.livePool === 'function') pool = pool.concat(a.livePool() || []); } catch (e) { /* render-only helper */ }
    pool = pool.concat(a && Array.isArray(a.camPool) ? a.camPool : []);
    return pool.find(function (c) {
      return [c.stream, c.serial, c.did, c.id, c.name].some(function (x) { return x != null && camKey(x) === k; });
    }) || null;
  }
  function profileOf(pid) {
    var s = st(), p = (s.people && s.people.profiles) || {};
    return p[pid] || null;
  }

  /* ── registry ──────────────────────────────────────────── */
  var types = {};
  function register(type, def) { types[type] = def; }

  /* ── layer management ──────────────────────────────────── */
  var stack = [];
  var lastSpec = '';
  var opener = null;

  function theme() {
    var el = document.querySelector('.c1[data-theme]') || document.querySelector('[data-theme]');
    var t = el && el.getAttribute('data-theme');
    return t === 'dark' ? 'dark' : 'light';
  }
  function focusables(root) {
    return Array.prototype.filter.call(root.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'),
      function (el) { return el.offsetParent !== null || el === document.activeElement; });
  }

  function open(type, id, data, opts) {
    var def = types[type];
    if (!def) { console.warn('[KJModal] unknown type', type); return null; }
    opts = opts || {};
    if (!stack.length) opener = document.activeElement;
    // Re-opening the same top modal just refreshes it.
    var top = stack[stack.length - 1];
    if (top && top.type === type && String(top.id) === String(id)) { top.reload(); return top; }

    var depth = Math.min(stack.length, 5);
    var layer = document.createElement('div');
    layer.className = 'kj-modal-layer kj-root kj-layer-' + depth;
    layer.setAttribute('data-theme', theme());
    var titleId = 'kj-mt-' + Date.now().toString(36) + depth;
    layer.innerHTML =
      '<div class="kj-modal-backdrop" data-kj-close></div>' +
      '<div class="kj-modal kj-size-' + (def.size || 'md') + '" role="dialog" aria-modal="true" aria-labelledby="' + titleId + '" tabindex="-1">' +
        '<div class="kj-modal-head"><span class="kj-modal-head-ico">' + ico(def.icon || 'info') + '</span>' +
          '<div class="kj-modal-titles"><div class="kj-modal-kicker">' + esc(def.kicker || type) + '</div>' +
          '<h2 class="kj-modal-title" id="' + titleId + '">' + esc((data && (data.name || data.title)) || 'Loading…') + '</h2></div>' +
          '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon kj-modal-close" data-kj-close aria-label="Close">' + ico('x') + '</button></div>' +
        '<div class="kj-modal-body" aria-live="polite"></div>' +
        '<div class="kj-modal-foot"></div>' +
      '</div>';
    document.body.appendChild(layer);
    stack.forEach(function (l) { l.el.classList.add('is-covered'); });

    var ctx = {
      type: type, id: id, data: data || {}, el: layer, actions: {},
      modal: layer.querySelector('.kj-modal'),
      body: layer.querySelector('.kj-modal-body'), foot: layer.querySelector('.kj-modal-foot'),
      head: layer.querySelector('.kj-modal-head-ico'), title: layer.querySelector('.kj-modal-title'),
      kicker: layer.querySelector('.kj-modal-kicker'),
      seq: 0
    };
    ctx.reload = function () { run(ctx, def); };
    ctx.close = function () { closeLayer(ctx); };
    stack.push(ctx);
    document.documentElement.classList.add('kj-modal-open');
    requestAnimationFrame(function () { layer.classList.add('is-open'); });
    run(ctx, def);
    setTimeout(function () { var f = focusables(ctx.modal); (f[1] || f[0] || ctx.modal).focus(); }, 30);
    if (!opts.noHash) writeHash();
    return ctx;
  }

  function paint(ctx, def, view) {
    if (!view) return;
    if (view.title != null) ctx.title.textContent = view.title;
    if (view.kicker != null) ctx.kicker.textContent = view.kicker;
    var icoEl = ctx.head;
    icoEl.className = 'kj-modal-head-ico' + (view.tone ? ' is-' + view.tone : '');
    if (view.icon) icoEl.innerHTML = ico(view.icon);
    ctx.body.innerHTML = view.body || '';
    ctx.foot.innerHTML = view.foot || '';
    ctx.actions = view.actions || {};
    if (typeof view.mount === 'function') { try { view.mount(ctx); } catch (e) { console.error(e); } }
  }

  function run(ctx, def) {
    var seq = ++ctx.seq;
    ctx.body.innerHTML = skeleton(def.skeleton);
    ctx.foot.innerHTML = '';
    var p;
    try { p = Promise.resolve(def.load ? def.load(ctx) : ctx.data); } catch (e) { p = Promise.reject(e); }
    p.then(function (d) {
      if (seq !== ctx.seq || stack.indexOf(ctx) < 0) return;
      paint(ctx, def, def.render(ctx, d));
    }).catch(function (err) {
      if (seq !== ctx.seq || stack.indexOf(ctx) < 0) return;
      console.warn('[KJModal]', ctx.type, ctx.id, err);
      ctx.title.textContent = ctx.title.textContent === 'Loading…' ? 'Not available' : ctx.title.textContent;
      ctx.body.innerHTML = '<div class="kj-modal-error">' + empty('cloud-off', 'Could not load these details',
        (err && err.message ? err.message + ' — ' : '') + 'Check your connection and try again.', true) + '</div>';
      ctx.foot.innerHTML = '<button type="button" class="kj-btn kj-btn-secondary" data-kj-action="retry">' + ico('refresh-cw') + 'Retry</button>';
      ctx.actions = { retry: ctx.reload };
    });
  }

  function skeleton(kind) {
    var tiles = '<div class="kj-grid-4"><span class="kj-skel kj-skel-tile"></span><span class="kj-skel kj-skel-tile"></span><span class="kj-skel kj-skel-tile"></span><span class="kj-skel kj-skel-tile"></span></div>';
    var lines = '<div><span class="kj-skel kj-skel-title"></span><span class="kj-skel kj-skel-line"></span><span class="kj-skel kj-skel-line is-mid"></span><span class="kj-skel kj-skel-line is-short"></span></div>';
    if (kind === 'media') return '<span class="kj-skel kj-skel-block"></span>' + lines + tiles;
    if (kind === 'table') return tiles + '<span class="kj-skel kj-skel-block"></span>';
    return '<div class="kj-row"><span class="kj-skel kj-skel-circle"></span><div class="kj-spacer">' + lines + '</div></div>' + tiles + '<span class="kj-skel kj-skel-block"></span>';
  }

  function closeLayer(ctx, opts) {
    var i = stack.indexOf(ctx); if (i < 0) return;
    stack.splice(i, 1);
    ctx.seq++;
    var el = ctx.el;
    el.classList.remove('is-open');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    if (stack.length) {
      var top = stack[stack.length - 1];
      top.el.classList.remove('is-covered');
      top.modal.focus();
    } else {
      document.documentElement.classList.remove('kj-modal-open');
      if (opener && document.contains(opener) && opener.focus) { try { opener.focus(); } catch (e) { /* ignore */ } }
      opener = null;
    }
    if (!(opts && opts.noHash)) writeHash();
  }
  function close() { if (stack.length) closeLayer(stack[stack.length - 1]); }
  function closeAll(opts) { while (stack.length) closeLayer(stack[stack.length - 1], { noHash: true }); if (!(opts && opts.noHash)) writeHash(); }

  /* ── hash deep-links ───────────────────────────────────── */
  var MODAL_RE = /(^#?|&)modal=([^&]*)/;
  function baseHash(h) {
    h = h == null ? location.hash : h;
    var out = h.replace(/&modal=[^&]*/, '').replace(/^#modal=[^&]*&?/, '#');
    return out === '#' ? '' : out;
  }
  function hashSpec(h) { var m = MODAL_RE.exec(h == null ? location.hash : h); return m ? decodeURIComponent(m[2]) : ''; }
  function parseSpec(s) {
    var i = String(s || '').indexOf(':'); if (i < 1) return null;
    return { type: s.slice(0, i), id: decodeURIComponent(s.slice(i + 1)) };
  }
  function writeHash() {
    var top = stack[stack.length - 1];
    var base = baseHash();
    var next;
    if (top && types[top.type] && types[top.type].deepLink !== false) {
      lastSpec = top.type + ':' + String(top.id);
      next = (base || '#') + (base ? '&' : '') + 'modal=' + encodeURIComponent(top.type) + ':' + encodeURIComponent(String(top.id));
    } else { lastSpec = ''; next = base; }
    if (next === location.hash || (next === '' && location.hash === '')) return;
    try { history.replaceState(history.state, '', next || (location.pathname + location.search)); } catch (e) { /* ignore */ }
  }
  function syncFromHash() {
    var s = hashSpec();
    if (s === lastSpec) return;
    var p = parseSpec(s);
    if (!p) { if (stack.length) closeAll({ noHash: true }); lastSpec = ''; return; }
    lastSpec = s;
    if (types[p.type]) open(p.type, p.id, null, { noHash: true });
  }

  /* ── global wiring ─────────────────────────────────────── */
  function seedOf(el) {
    var raw = el.getAttribute('data-kj-seed'); if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  function trigger(el, ev) {
    var p = parseSpec(el.getAttribute('data-kj-modal'));
    if (!p || !types[p.type]) return false;
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    open(p.type, p.id, seedOf(el));
    return true;
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!(t instanceof Element)) return;
    // Inside an open modal: close buttons + footer actions.
    var layer = t.closest('.kj-modal-layer');
    if (layer) {
      var ctx = stack.find(function (c) { return c.el === layer; });
      if (t.closest('[data-kj-close]')) { if (ctx) closeLayer(ctx); return; }
      var act = t.closest('[data-kj-action]');
      if (act && ctx && ctx.actions[act.getAttribute('data-kj-action')]) {
        ev.preventDefault(); ctx.actions[act.getAttribute('data-kj-action')](ctx, act); return;
      }
    }
    var el = t.closest('[data-kj-modal]');
    if (el && el.getAttribute('data-kj-modal')) trigger(el, ev);
  });

  // Keyboard: Enter/Space on non-button triggers; ESC + focus trap for the top modal.
  // Capture phase on window so the dashboard's own Escape handler doesn't also fire.
  window.addEventListener('keydown', function (ev) {
    if (stack.length) {
      var top = stack[stack.length - 1];
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); closeLayer(top); return; }
      if (ev.key === 'Tab') {
        var f = focusables(top.modal);
        if (!f.length) { ev.preventDefault(); top.modal.focus(); return; }
        var first = f[0], last = f[f.length - 1];
        if (!top.modal.contains(document.activeElement)) { ev.preventDefault(); first.focus(); }
        else if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
        else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
      }
      if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'k' || ev.key === 'K')) closeAll();
    }
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target instanceof Element) {
      var el = ev.target.closest('[data-kj-modal]');
      if (el && el === ev.target && !/^(BUTTON|A|INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) trigger(el, ev);
    }
  }, true);

  // Make declarative triggers keyboard-reachable (React may re-create nodes).
  var a11yQueued = false;
  function a11ySweep() {
    a11yQueued = false;
    document.querySelectorAll('[data-kj-modal]:not([data-kj-modal=""]):not([data-kj-a11y])').forEach(function (el) {
      el.setAttribute('data-kj-a11y', '1');
      if (!/^(BUTTON|A)$/.test(el.tagName)) {
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
        if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
      }
    });
  }
  function boot() {
    a11ySweep();
    new MutationObserver(function () { if (!a11yQueued) { a11yQueued = true; requestAnimationFrame(a11ySweep); } })
      .observe(document.body, { childList: true, subtree: true });
    window.addEventListener('hashchange', syncFromHash);
    window.addEventListener('popstate', function () { setTimeout(syncFromHash, 0); });
    // Deep link on load: wait (max ~4 s) for the dashboard so state-backed lookups work.
    var s = hashSpec();
    if (s) {
      var tries = 0;
      (function wait() { if (window.KJApp || tries++ > 20) syncFromHash(); else setTimeout(wait, 200); })();
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  /* ── toast ─────────────────────────────────────────────── */
  function toast(msg, tone, ms) {
    var host = document.querySelector('.kj-toasts');
    if (!host) { host = document.createElement('div'); host.className = 'kj-toasts kj-root'; host.setAttribute('role', 'status'); document.body.appendChild(host); }
    host.setAttribute('data-theme', theme());
    var t = document.createElement('div');
    t.className = 'kj-toast' + (tone ? ' is-' + tone : '');
    t.innerHTML = ico(tone === 'danger' ? 'circle-alert' : (tone === 'warn' ? 'triangle-alert' : 'circle-check')) + '<span>' + esc(msg) + '</span>';
    host.appendChild(t);
    setTimeout(function () { t.classList.add('is-leaving'); setTimeout(function () { t.remove(); }, 260); }, ms || 3200);
  }

  // Leave the modal stack, then run a dashboard action (navigation, legacy editor…).
  function viaApp(fn) {
    return function () {
      var a = app();
      if (!a) { toast('Dashboard is still loading — try again in a moment.', 'warn'); return; }
      closeAll();
      try { fn(a); } catch (e) { console.error(e); toast('That action is not available here.', 'danger'); }
    };
  }
  function btn(action, label, icon, kind) {
    return '<button type="button" class="kj-btn ' + (kind || 'kj-btn-secondary') + '" data-kj-action="' + action + '">' + (icon ? ico(icon) : '') + esc(label) + '</button>';
  }
  function eventRow(e) {
    var m = MOD[e.mod] || ['Detection', 'radar', 'primary'];
    var s = SEV[e.sev];
    return '<div class="kj-list-item" data-kj-modal="' + esc(spec('event', e.id)) + '"' + attrSeed(e.raw && e.raw.uuid == null && !appEvent(e.id) ? e.raw : null) + '>' +
      (e.image ? '<img class="kj-thumb" src="' + esc(e.image) + '" alt="" loading="lazy">' : '<span class="kj-thumb kj-stat-ico">' + ico(m[1]) + '</span>') +
      '<div class="kj-list-main"><div class="kj-list-title kj-truncate">' + esc(e.title) + '</div>' +
      '<div class="kj-list-sub kj-truncate">' + esc([m[0], e.camera, e.zone || e.location, fmtTime(e.ts)].filter(Boolean).join(' · ')) + '</div></div>' +
      (s ? chip(s[0], s[1]) : '') + '</div>';
  }

  /* ======================================================================
   * TYPE: person  (id = personId)
   * ==================================================================== */
  register('person', {
    kicker: 'Employee', icon: 'user-round', size: 'lg',
    load: function (ctx) {
      var pid = String(ctx.id);
      return Promise.all([
        soft(api('/attendance/person', { person_id: pid, days: 7 })),
        soft(api('/events', { person_id: pid, limit: 24 })),
        soft(daily(today()))
      ]).then(function (r) {
        var prof = profileOf(pid) || (r[0] && r[0].profile) || null;
        var evs = ((r[1] && r[1].events) || []).map(normEvent);
        var row = r[2] && (r[2].rows || []).find(function (x) { return String(x.personId) === pid; });
        if (!prof && !evs.length && !row && !(r[0] && r[0].journey && r[0].journey.steps && r[0].journey.steps.length)) {
          if (!ctx.data.name) throw new Error('No record found for person #' + pid);
        }
        return { pid: pid, prof: prof || {}, events: evs, journey: (r[0] && r[0].journey) || { steps: [], visits: [] }, today: row || null };
      });
    },
    render: function (ctx, d) {
      var p = d.prof, seed = ctx.data || {};
      var name = p.name || seed.name || d.events.map(function (e) { return e.person; }).filter(Boolean)[0] || ('Unknown person #' + d.pid);
      var photo = p.photo || seed.photo || (d.events[0] && d.events[0].image) || '';
      var known = !!p.name;
      var t = d.today, ts = t ? (ATT[t.status] || [t.status, '']) : null;
      var visits = d.journey.visits || [];
      var lastSeen = d.events[0] ? d.events[0].ts : (visits.length ? visits[visits.length - 1].depart : null);
      var hero = '<div class="kj-hero">' + avatar(photo, name, 'kj-avatar-xl') + '<div class="kj-hero-main">' +
        '<div class="kj-hero-name">' + esc(name) + '</div><div class="kj-row-wrap">' +
        (known ? chip(p.active === false ? 'Inactive' : 'Active', p.active === false ? '' : 'success', true) : chip('Not enrolled', 'warn', true)) +
        (ts ? chip('Today: ' + ts[0], ts[1]) : '') + (p.plant ? chip(p.plant, 'primary') : '') + '</div>' +
        '<div class="kj-section-title">Profile</div>' +
        kv([['Staff ID', p.staffId || seed.staffId || '—'], ['Department', p.department], ['Plant', p.plant], ['Shift', p.shift || (t && t.shift)],
          ['Gender', p.gender], ['Age', p.age], ['Person ID', '#' + d.pid], ['Last seen', lastSeen ? fmtTime(lastSeen) + ' · ' + ago(lastSeen) : '—']]) +
        '</div></div>';
      var tiles = '<div class="kj-grid-4">' +
        statTile('log-in', t && t.clockIn ? fmtHM(t.clockIn) : '—', 'Clock-in today', 'success', spec('attendance-day', today() + '@' + d.pid)) +
        statTile('log-out', t && t.clockOut ? fmtHM(t.clockOut) : '—', 'Clock-out today', '', spec('attendance-day', today() + '@' + d.pid)) +
        statTile('scan-face', fmtN(d.events.length) + (d.events.length >= 24 ? '+' : ''), 'Detections (recent)', 'purple') +
        statTile('map-pin', fmtN(visits.length), 'Location visits · 7 d', 'orange') + '</div>';
      var evHtml = d.events.length ? '<div class="kj-list">' + d.events.slice(0, 8).map(eventRow).join('') + '</div>'
        : empty('scan-face', 'No recent detections', 'This person has not been detected recently.');
      var jHtml = visits.length ? '<ol class="kj-timeline">' + visits.slice(-10).reverse().map(function (v) {
        return '<li><b>' + esc(v.location || '—') + '</b> <span class="kj-muted">· ' + esc(fmtN(v.captures)) + ' capture' + (N(v.captures) === 1 ? '' : 's') + '</span>' +
          '<div class="kj-timeline-time">' + esc(fmtTime(v.arrive)) + (v.depart && v.depart !== v.arrive ? ' → ' + esc(fmtHM(v.depart)) : '') + '</div></li>';
      }).join('') + '</ol>' : empty('route', 'No movement recorded', 'No sightings at mapped camera points in the last 7 days.');
      var shots = d.events.map(function (e) { return e.image; }).filter(Boolean).filter(function (u, i, a) { return a.indexOf(u) === i; }).slice(0, 12);
      var gal = shots.length ? section('Captures', '<div class="kj-gallery">' + shots.map(function (u) {
        return '<img src="' + esc(u) + '" alt="Capture of ' + esc(name) + '" loading="lazy" data-kj-modal="' + esc(spec('image', u)) + '"' + attrSeed({ label: name }) + '>';
      }).join('') + '</div>') : '';
      var a = app();
      return {
        title: name, kicker: known ? 'Employee' : 'Tracked person', icon: 'user-round',
        body: hero + tiles + '<div class="kj-grid-2">' + section('Recent detections', evHtml) + section('Movement · last 7 days', jHtml) + '</div>' + gal,
        foot: (a ? btn('journey', 'Movement journey', 'route') + btn('edit', known ? 'Edit profile' : 'Enrol as employee', 'pencil') : '') +
          btn('day', 'Today’s attendance', 'calendar-check', 'kj-btn-primary'),
        actions: {
          journey: viaApp(function (a) { a.openJourney({ personId: d.pid, name: name, staffId: p.staffId || '', photo: photo }); }),
          edit: viaApp(function (a) { a.openProfile({ personId: d.pid, image: photo }); }),
          day: function () { open('attendance-day', today() + '@' + d.pid); }
        }
      };
    }
  });

  /* ======================================================================
   * TYPE: event  (id = event uuid; numeric module ids render from seed)
   * ==================================================================== */
  register('event', {
    kicker: 'Detection event', icon: 'radar', size: 'lg', skeleton: 'media',
    load: function (ctx) {
      var id = String(ctx.id);
      var hit = appEvent(id);
      var ovRow = !hit && ((st().ov && st().ov.events) || []).find(function (e) { return String(e.id) === id; });
      var base = hit ? normEvent(hit) : null;
      var fetchRaw = (!base && /[a-z]/i.test(id)) ? soft(api('/events/' + encodeURIComponent(id))) : Promise.resolve(null);
      return fetchRaw.then(function (r) {
        var ev = base || (r && r.event ? normEvent(r.event) : null) || (ovRow ? normEvent(ovRow) : null) ||
          (ctx.data && Object.keys(ctx.data).length ? normEvent(Object.assign({ id: id }, ctx.data)) : null);
        if (!ev) throw new Error('Event ' + id + ' was not found (it may have been purged)');
        var uuid = (ev.raw && ev.raw.uuid) || (hit ? hit.id : (/[a-z]/i.test(id) ? id : ''));
        return (uuid ? soft(api('/events/' + encodeURIComponent(uuid) + '/log')) : Promise.resolve(null)).then(function (lg) {
          ev.log = (lg && lg.log) || [];
          ev.uuid = uuid; ev.inApp = !!hit;
          return ev;
        });
      });
    },
    render: function (ctx, e) {
      var m = MOD[e.mod] || ['Detection', 'radar', 'primary'];
      var s = SEV[e.sev], es = EST[e.status];
      var imgs = [[e.image, 'Trigger'], [e.imageBk, 'Scene'], [e.imageMatch, 'Enrolled match']].filter(function (x) { return x[0]; });
      var hero = media(imgs[0] && imgs[0][0], e.title, (s ? chip(s[0], s[1]) : ''));
      var gal = imgs.length > 1 ? '<div class="kj-gallery">' + imgs.map(function (x) {
        return '<img src="' + esc(x[0]) + '" alt="' + esc(x[1]) + '" title="' + esc(x[1]) + '" loading="lazy" data-kj-modal="' + esc(spec('image', x[0])) + '"' + attrSeed({ label: e.title + ' · ' + x[1] }) + '>';
      }).join('') + '</div>' : '';
      var camId = e.camera || e.raw.stream || '';
      var who = e.personId ? link('person', e.personId, e.person || ('#' + e.personId), { name: e.person }) : esc(e.person || '—');
      var details = kv([
        ['Module', m[0]], ['Severity', s ? chip(s[0], s[1]) : '—', true], ['Status', es ? chip(es[0], es[1], true) : (e.verdict || e.status || '—'), !!es],
        ['Camera', camId ? link('camera', camId, e.device ? e.device + ' (' + camId + ')' : camId) : '—', true],
        ['Zone / policy', e.zone], ['Location', [e.location, e.plant].filter(Boolean).join(' · ')],
        ['Person', who, true], ['Similarity', e.similarity],
        ['Detected', fmtTime(e.ts)], ['Assignee', e.assignee],
        ['Ticket', e.ticket ? link('ticket', e.ticket, e.ticket) : '—', true], ['Event ID', String(e.uuid || e.id)]
      ]);
      var log = e.log.length ? '<ol class="kj-timeline">' + e.log.slice(-12).reverse().map(function (l) {
        var txt = l.note ? String(l.note).replace(/<[^>]+>/g, ' ') : ((l.kind || 'update') + (l.to ? ': ' + l.to : ''));
        return '<li>' + esc(txt) + '<div class="kj-timeline-time">' + esc([l.actor, fmtTime(l.at || l.created_at || l.ts)].filter(Boolean).join(' · ')) + '</div></li>';
      }).join('') + '</ol>' : empty('history', 'No activity yet', 'Status changes, comments and escalations will appear here.');
      return {
        title: e.title, kicker: m[0] + ' event', icon: m[1], tone: s ? s[1] : m[2],
        body: hero + gal + section('Details', '<div class="kj-card">' + details + '</div>') + (e.policyDesc ? section('Policy', '<div class="kj-card-flat kj-text-2">' + esc(e.policyDesc) + '</div>') : '') + section('Activity', log),
        foot: (camId ? btn('cam', 'Camera', 'cctv') : '') + (e.personId ? btn('person', 'Person', 'user-round') : '') +
          (e.inApp ? btn('full', e.ticket ? 'Open ticket workspace' : 'Open incident actions', 'external-link', 'kj-btn-primary') : ''),
        actions: {
          cam: function () { open('camera', camId); },
          person: function () { open('person', e.personId, { name: e.person }); },
          full: viaApp(function (a) { var ev = appEvent(e.uuid || e.id); if (!ev) return; if (ev.ticket) a.openTicket(ev); else a.openModal('event', ev); })
        }
      };
    }
  });

  /* ======================================================================
   * TYPE: camera  (id = stream label / serial / device id)
   * ==================================================================== */
  register('camera', {
    kicker: 'Camera', icon: 'cctv', size: 'lg', skeleton: 'media',
    load: function (ctx) {
      var id = String(ctx.id);
      var c = findCamera(id) || ctx.data || {};
      var stream = c.stream || id;
      return soft(api('/events/latest/' + encodeURIComponent(stream))).then(function (r) {
        var latest = r && r.event ? normEvent(r.event) : null;
        if (!findCamera(id) && !latest && !(ctx.data && ctx.data.name)) throw new Error('Camera "' + id + '" is not registered');
        return { c: c, stream: stream, latest: latest };
      });
    },
    render: function (ctx, d) {
      var c = d.c, key = String(d.stream).toUpperCase();
      var evs = (st().events || []).filter(function (e) { return String(e.camera || '').toUpperCase() === key; }).map(normEvent);
      var online = c.online !== false;
      var still = (d.latest && (d.latest.imageBk || d.latest.image)) || c.img || null;
      var name = c.name || c.fleetName || key;
      var count24 = (st().byCam || {})[key];
      var open_ = evs.filter(function (e) { return e.status === 'open'; }).length;
      var a = app();
      return {
        title: name, kicker: 'Camera · ' + key, icon: 'cctv', tone: online ? 'success' : 'danger',
        body: media(still, name, chip(online ? 'Online' : 'Offline', online ? 'success' : 'danger', true)) +
          '<div class="kj-grid-3">' + statTile('radar', count24 != null ? fmtN(count24) : fmtN(evs.length), 'Detections · 24 h', 'purple') +
          statTile('bell-ring', fmtN(open_), 'Open alerts', open_ ? 'danger' : 'success') +
          statTile('clock', d.latest ? ago(d.latest.ts) || '—' : '—', 'Last detection', '') + '</div>' +
          section('Device', '<div class="kj-card">' + kv([['Name', name], ['Stream label', c.stream || d.stream], ['Serial', c.serial], ['Device ID', c.did],
            ['Type', c.type], ['Status', online ? 'Online' : 'Offline'], ['Plant / location', c.plant || c.loc || c.zone]]) + '</div>') +
          section('Recent detections on this camera', evs.length ? '<div class="kj-list">' + evs.slice(0, 8).map(eventRow).join('') + '</div>'
            : (d.latest ? '<div class="kj-list">' + eventRow(d.latest) + '</div>' : empty('radar', 'No recent detections', 'Nothing detected on this camera in the live window.'))),
        foot: a ? btn('page', 'Open camera page', 'external-link', 'kj-btn-primary') : '',
        actions: { page: viaApp(function (a) { a.openCamera(String(c.stream || d.stream).toLowerCase()); }) }
      };
    }
  });

  /* ======================================================================
   * TYPE: ticket  (id = ticket no or event uuid)
   * Tries the M7 ITSM API (/api/tickets/{id}) first; falls back to the
   * current incident-ticket model (an event with ticket_no + log).
   * ==================================================================== */
  register('ticket', {
    kicker: 'Ticket', icon: 'ticket', size: 'lg', skeleton: 'media',
    load: function (ctx) {
      var id = String(ctx.id);
      return soft(api('/tickets/' + encodeURIComponent(id))).then(function (r) {
        if (r && r.ticket) return { itsm: r.ticket };
        var hit = appEvent(id);
        var get = hit ? Promise.resolve(normEvent(hit)) : (/[a-z]/i.test(id) && !/^[A-Z]{2,5}-\d/.test(id)
          ? soft(api('/events/' + encodeURIComponent(id))).then(function (x) { return x && x.event ? normEvent(x.event) : null; }) : Promise.resolve(null));
        return get.then(function (ev) {
          if (!ev) throw new Error('Ticket ' + id + ' was not found');
          var uuid = (ev.raw && ev.raw.uuid) || ev.id;
          return Promise.all([soft(api('/events/' + encodeURIComponent(uuid) + '/log')), soft(api('/events/' + encodeURIComponent(uuid) + '/attachments'))])
            .then(function (x) { ev.uuid = uuid; ev.log = (x[0] && x[0].log) || []; ev.files = (x[1] && x[1].files) || []; ev.inApp = !!appEvent(uuid); return { ev: ev }; });
        });
      });
    },
    render: function (ctx, d) {
      if (d.itsm) {   // M7 shape — generic rendering until the wave-2 ticket UI lands
        var t = d.itsm;
        var rows = Object.keys(t).filter(function (k) { return t[k] == null || typeof t[k] !== 'object'; }).map(function (k) { return [k.replace(/_/g, ' '), t[k]]; });
        return { title: t.title || t.subject || ('Ticket ' + (t.number || t.id)), kicker: 'Ticket ' + (t.number || t.id || ''), icon: 'ticket',
          body: section('Ticket', '<div class="kj-card">' + kv(rows) + '</div>') };
      }
      var e = d.ev, es = EST[e.status], s = SEV[e.sev];
      var now = Date.now(), opened = e.ticketedTs || toDate(e.ts) && toDate(e.ts).getTime();
      var thread = e.log.length ? '<ol class="kj-timeline">' + e.log.slice().reverse().map(function (l) {
        var txt = l.note ? String(l.note).replace(/<[^>]+>/g, ' ') : ((l.kind || 'update') + (l.to ? ': ' + l.to : ''));
        return '<li>' + esc(txt) + '<div class="kj-timeline-time">' + esc([l.kind, l.actor, fmtTime(l.at || l.created_at || l.ts)].filter(Boolean).join(' · ')) + '</div></li>';
      }).join('') + '</ol>' : empty('messages-square', 'No messages yet', 'Comments and remarks on this ticket will show here.');
      var files = e.files.length ? '<div class="kj-list">' + e.files.map(function (f) {
        var nm = f.name || f.file || String(f);
        return '<div class="kj-list-item">' + ico('paperclip') + '<div class="kj-list-main"><div class="kj-list-title kj-truncate">' + esc(nm) + '</div>' +
          (f.size ? '<div class="kj-list-sub">' + esc(Math.round(N(f.size) / 1024) + ' KB') + '</div>' : '') + '</div></div>';
      }).join('') + '</div>' : empty('paperclip', 'No attachments', '');
      return {
        title: e.title, kicker: 'Ticket ' + (e.ticket || '(not raised)'), icon: 'ticket', tone: s ? s[1] : 'primary',
        body: '<div class="kj-grid-4">' +
            statTile('timer', dur((e.ackedTs || now) - opened), e.ackedTs ? 'Response time' : 'Awaiting response', e.ackedTs ? 'success' : 'warn') +
            statTile('hourglass', dur((e.resolvedTs || now) - opened), e.resolvedTs ? 'Resolution time' : 'Open for', e.resolvedTs ? 'success' : 'danger') +
            statTile('signal', e.escLevel ? 'L' + e.escLevel : '—', 'Escalation level', e.escLevel ? 'orange' : '') +
            statTile('message-square', fmtN(e.log.length), 'Updates', 'primary') + '</div>' +
          '<div class="kj-grid-2">' + media(e.image || e.imageBk, e.title) + '<div class="kj-card">' + kv([
            ['Status', es ? chip(es[0], es[1], true) : e.status, !!es], ['Severity', s ? chip(s[0], s[1]) : '—', true],
            ['Detection', link('event', e.uuid, 'View event'), true], ['Camera', e.camera ? link('camera', e.camera, e.camera) : '—', true],
            ['Assignee', e.assignee], ['Raised', e.ticketedTs ? fmtTime(e.ticketedTs) : '—'],
            ['Acknowledged', e.ackedTs ? fmtTime(e.ackedTs) : '—'], ['Resolved', e.resolvedTs ? fmtTime(e.resolvedTs) : '—']]) + '</div></div>' +
          section('Communication', thread) + section('Attachments', files),
        foot: e.inApp ? btn('full', 'Open ticket workspace', 'external-link', 'kj-btn-primary') : '',
        actions: { full: viaApp(function (a) { var ev = appEvent(e.uuid); if (ev) a.openTicket(ev); }) }
      };
    }
  });

  /* ======================================================================
   * TYPE: leave  (id = leave request id) — backed by the M6 API when live.
   * ==================================================================== */
  register('leave', {
    kicker: 'Leave request', icon: 'calendar-days', size: 'md',
    load: function (ctx) {
      return soft(api('/leaves/' + encodeURIComponent(String(ctx.id)))).then(function (r) {
        var lv = (r && (r.leave || r.request)) || (ctx.data && Object.keys(ctx.data).length ? ctx.data : null);
        return { lv: lv };
      });
    },
    render: function (ctx, d) {
      var lv = d.lv;
      if (!lv) return { title: 'Leave request #' + ctx.id, body: empty('calendar-x', 'Leave request not available', 'The leave module is not enabled yet, or this request no longer exists.') };
      var stt = String(lv.status || 'pending').toLowerCase();
      var tone = { approved: 'success', rejected: 'danger', cancelled: '', pending: 'warn' }[stt];
      var pid = lv.person_id || lv.personId;
      var hist = Array.isArray(lv.history) && lv.history.length ? '<ol class="kj-timeline">' + lv.history.map(function (h) {
        return '<li>' + esc(h.action || h.status || 'update') + (h.remarks ? ' — ' + esc(h.remarks) : '') + '<div class="kj-timeline-time">' + esc([h.by || h.actor, fmtTime(h.at || h.created_at)].filter(Boolean).join(' · ')) + '</div></li>';
      }).join('') + '</ol>' : '';
      return {
        title: (lv.type || lv.leave_type || 'Leave') + ' · ' + (lv.name || lv.employee || ''), icon: 'calendar-days', tone: tone,
        body: '<div class="kj-hero"><div class="kj-hero-main"><div class="kj-row-wrap">' + chip(stt[0].toUpperCase() + stt.slice(1), tone, true) + '</div>' +
          kv([['Employee', pid ? link('person', pid, lv.name || lv.employee || '#' + pid) : (lv.name || lv.employee), true],
            ['Type', lv.type || lv.leave_type], ['From', lv.from || lv.start_date ? fmtDate(lv.from || lv.start_date) : '—'],
            ['To', lv.to || lv.end_date ? fmtDate(lv.to || lv.end_date) : '—'], ['Days', lv.days], ['Submitted', lv.created_at ? fmtTime(lv.created_at) : '—'],
            ['Approver', lv.approver || lv.decided_by], ['Remarks', lv.remarks || lv.decision_remarks]]) + '</div></div>' +
          (lv.reason ? section('Reason', '<div class="kj-card-flat">' + esc(lv.reason) + '</div>') : '') + (hist ? section('History', hist) : '')
      };
    }
  });

  /* ======================================================================
   * TYPE: attendance-day  (id = YYYY-MM-DD | today | YYYY-MM-DD@personId)
   * ==================================================================== */
  register('attendance-day', {
    kicker: 'Attendance', icon: 'calendar-check', size: 'lg', skeleton: 'table',
    load: function (ctx) {
      var parts = String(ctx.id).split('@');
      var date = parts[0] === 'today' || !/^\d{4}-\d{2}-\d{2}$/.test(parts[0]) ? today() : parts[0];
      var pid = parts[1] || '';
      return daily(date).then(function (d) {
        if (!pid) return { date: date, d: d };
        var row = (d.rows || []).find(function (r) { return String(r.personId) === pid; });
        var j = date === today() ? soft(api('/attendance/person', { person_id: pid, days: 1 })) : Promise.resolve(null);
        return j.then(function (jr) { return { date: date, d: d, pid: pid, row: row || null, journey: jr && jr.journey }; });
      });
    },
    render: function (ctx, x) {
      var d = x.d, k = d.kpi || {};
      if (x.pid) {
        var r = x.row;
        var prof = profileOf(x.pid) || {};
        var nm = (r && r.name) || prof.name || ('#' + x.pid);
        if (!r) return { title: nm + ' · ' + fmtDate(x.date), body: empty('calendar-x', 'No register entry', 'This person is not an active employee on the register for this day.') +
          '<div>' + link('person', x.pid, 'Open person profile') + '</div>' };
        var s = ATT[r.status] || [r.status, ''];
        var visits = (x.journey && x.journey.visits) || [];
        return {
          title: nm + ' · ' + fmtDate(x.date), kicker: 'Attendance day', icon: 'calendar-check', tone: s[1],
          body: '<div class="kj-hero">' + avatar(r.photo, nm, 'kj-avatar-lg') + '<div class="kj-hero-main"><div class="kj-hero-name">' + link('person', x.pid, nm, { name: nm, photo: r.photo }) + '</div>' +
              '<div class="kj-row-wrap">' + chip(s[0] + (r.status === 'late' ? ' · ' + r.lateMin + ' min' : ''), s[1], true) + (r.flags || []).map(function (f) { return chip(FLAG[f] || f, 'warn'); }).join('') + '</div></div></div>' +
            '<div class="kj-grid-4">' + statTile('log-in', fmtHM(r.clockIn), 'Clock-in' + (r.clockInLoc ? ' · ' + r.clockInLoc : ''), 'success') +
              statTile('log-out', fmtHM(r.clockOut), 'Clock-out' + (r.clockOutLoc ? ' · ' + r.clockOutLoc : ''), '') +
              statTile('timer', r.hours != null ? r.hours + ' h' : '—', 'Hours worked', 'primary') +
              statTile('eye', fmtN(r.sightings), 'Sightings', 'purple') + '</div>' +
            section('Details', '<div class="kj-card">' + kv([['Staff ID', r.staffId], ['Department', r.department], ['Plant', r.plant],
              ['Shift', r.shift + ' ' + r.shiftStart + '–' + r.shiftEnd], ['Clock-in source', r.clockInSrc === 'kiosk' ? 'Face kiosk' : (r.clockIn ? 'CCTV' : '—')],
              ['Plants visited', (r.plants || []).join(' → ')], ['Last seen', r.lastSeen ? fmtTime(r.lastSeen) + (r.lastLoc ? ' · ' + r.lastLoc : '') : '—']]) + '</div>') +
            (visits.length ? section('Movement today', '<ol class="kj-timeline">' + visits.slice().reverse().map(function (v) {
              return '<li><b>' + esc(v.location) + '</b><div class="kj-timeline-time">' + esc(fmtHM(v.arrive)) + (v.depart !== v.arrive ? ' → ' + esc(fmtHM(v.depart)) : '') + '</div></li>'; }).join('') + '</ol>') : ''),
          foot: btn('day', 'Whole day register', 'table-2') + btn('person', 'Person profile', 'user-round', 'kj-btn-primary'),
          actions: { day: function () { open('attendance-day', x.date); }, person: function () { open('person', x.pid, { name: nm }); } }
        };
      }
      // Whole-day register with an in-modal status filter.
      var rows = d.rows || [];
      var filters = [['all', 'All', rows.length], ['present', 'Present', k.present], ['late', 'Late', k.late], ['absent', 'Absent', k.absent], ['pending', 'Not yet in', k.pending]];
      var want = (ctx.data && ctx.data.status) || 'all';
      function table(f) {
        var list = rows.filter(function (r) { return f === 'all' || (f === 'present' ? (r.status === 'present' || r.status === 'late') : r.status === f); });
        if (!list.length) return empty('users', 'Nobody here', 'No employees match this status for the day.');
        return '<div class="kj-table-wrap"><table class="kj-table"><thead><tr><th>Employee</th><th>Department</th><th>Clock-in</th><th>Clock-out</th><th class="kj-num">Hours</th><th>Status</th></tr></thead><tbody>' +
          list.map(function (r) { var s = ATT[r.status] || [r.status, ''];
            return '<tr data-kj-modal="' + esc(spec('attendance-day', x.date + '@' + r.personId)) + '"><td><span class="kj-row">' + avatar(r.photo, r.name) +
              '<span>' + link('person', r.personId, r.name, { name: r.name, photo: r.photo }) + '<br><span class="kj-muted">' + esc(r.staffId || '') + '</span></span></span></td>' +
              '<td>' + esc(r.department || '—') + '</td><td>' + esc(fmtHM(r.clockIn)) + '</td><td>' + esc(fmtHM(r.clockOut)) + '</td>' +
              '<td class="kj-num">' + esc(r.hours != null ? r.hours : '—') + '</td><td>' + chip(s[0], s[1], true) + '</td></tr>'; }).join('') +
          '</tbody></table></div>';
      }
      var recent = (d.recent || []).slice(0, 10);
      return {
        title: 'Attendance · ' + fmtDate(x.date), kicker: 'Attendance register', icon: 'calendar-check',
        body: '<div class="kj-grid-4">' + statTile('users', fmtN(k.total), 'Scheduled', 'primary') + statTile('user-check', fmtN(k.present), 'Present (incl. late)', 'success') +
            statTile('clock-alert', fmtN(k.late), 'Late', 'warn') + statTile('user-x', fmtN(k.absent), 'Absent', 'danger') + '</div>' +
          '<div class="kj-tabs" role="tablist">' + filters.map(function (f) {
            return '<button type="button" class="kj-tab" role="tab" data-kj-action="filter" data-f="' + f[0] + '" aria-selected="' + (f[0] === want) + '">' + esc(f[1]) + ' · ' + fmtN(f[2]) + '</button>'; }).join('') + '</div>' +
          '<div data-kj-slot="table">' + table(want) + '</div>' +
          (recent.length ? section('Recent recognitions', '<div class="kj-list">' + recent.map(function (e) {
            return '<div class="kj-list-item" data-kj-modal="' + esc(spec('person', e.personId)) + '"' + attrSeed({ name: e.name || '' }) + '>' +
              (e.image ? '<img class="kj-thumb" src="' + esc(e.image) + '" alt="" loading="lazy">' : '') +
              '<div class="kj-list-main"><div class="kj-list-title">' + esc(e.known ? e.name : 'Unknown #' + e.personId) + '</div><div class="kj-list-sub">' +
              esc([e.location, e.source === 'kiosk' ? 'kiosk' : 'CCTV', fmtHM(e.time)].filter(Boolean).join(' · ')) + '</div></div></div>'; }).join('') + '</div>') : ''),
        foot: app() ? btn('page', 'Open attendance page', 'external-link', 'kj-btn-primary') : '',
        actions: {
          filter: function (c, el) {
            c.body.querySelectorAll('.kj-tab').forEach(function (t) { t.setAttribute('aria-selected', String(t === el)); });
            c.body.querySelector('[data-kj-slot="table"]').innerHTML = table(el.getAttribute('data-f'));
          },
          page: viaApp(function (a) { a.setPage('attendance'); })
        }
      };
    }
  });

  /* ======================================================================
   * TYPE: stat  (id = widget key [@YYYY-MM-DD]) — overview widget drill-downs
   * keys: emp ppe ra cl fk ev att
   * ==================================================================== */
  var STAT_PAGE = { emp: 'employees', ppe: 'ppe', ra: 'intr', cl: 'cleaning', fk: 'forklift', ev: 'incidents', att: 'attendance' };
  register('stat', {
    kicker: 'Overview', icon: 'chart-column', size: 'lg', skeleton: 'table', deepLink: true,
    load: function (ctx) {
      var a = app();
      var ov = st().ov;
      if (ov) return { ov: ov };
      return api('/overview', { plant: (a && a.state && a.state.plant) || '' }).then(function (d) { return { ov: d }; });
    },
    render: function (ctx, x) {
      var parts = String(ctx.id).split('@'), key = parts[0], day = parts[1] || '';
      var ov = x.ov || {};
      var a = app();
      var foot = a && STAT_PAGE[key] ? btn('page', 'Open full page', 'external-link', 'kj-btn-primary') : '';
      var actions = { page: viaApp(function (a) { a.setPage(STAT_PAGE[key]); }) };
      function daySpec(k, d) { return spec('stat', k + '@' + d); }
      function dailyBars(arr, k, val, tone) {
        arr = Array.isArray(arr) ? arr.slice(-7) : [];
        if (!arr.length) return empty('chart-column', 'No data in the last 7 days', '');
        return minibars(arr.map(function (r) { return { lbl: String(r.date || '').slice(5), v: val(r), modal: daySpec(k, r.date), tone: r.date === day ? 'danger' : tone }; }));
      }
      function dayCard(arr, fields) {
        if (!day) return '';
        var r = (Array.isArray(arr) ? arr : []).find(function (z) { return z.date === day; }) || {};
        return section('Selected day · ' + fmtDate(day), '<div class="kj-card">' + kv(fields.map(function (f) { return [f[0], fmtN(r[f[1]])]; })) + '</div>');
      }
      function recentList(arr) {
        arr = Array.isArray(arr) ? arr : [];
        return arr.length ? '<div class="kj-list">' + arr.map(function (r) { return eventRow(normEvent(r)); }).join('') + '</div>' : empty('inbox', 'Nothing recent', '');
      }
      var e = ov.employees || {}, p = ov.ppe || {}, ra = ov.restricted || {}, cl = ov.cleaning || {}, fk = ov.forklift || {};
      var PPE = { helmet: 'Helmet', vest: 'Safety vest', goggles: 'Goggles', gloves: 'Gloves', boots: 'Safety boots', hairnet: 'Hair net', ear: 'Ear protection' };

      if (key === 'emp' || key === 'att') {
        var rec = (ov.recognized || []).slice(0, 12);
        var wk = (ov.week || []);
        return {
          title: key === 'emp' ? 'Employees' : 'Face recognition today', icon: 'users', tone: 'primary', foot: foot, actions: actions,
          body: '<div class="kj-grid-4">' + statTile('users', fmtN(e.total), 'Active employees', 'primary', spec('attendance-day', today())) +
              statTile('user-plus', fmtN(e.newThisMonth), 'New this month', 'success') +
              statTile('user-check', fmtN(e.present), 'Present today', 'success', spec('attendance-day', today())) +
              statTile('user-x', fmtN(e.absent), 'Absent today', 'danger', spec('attendance-day', today())) + '</div>' +
            section('This week (click a day)', wk.length ? minibars(wk.map(function (w) {
              return { lbl: w.label || String(w.date).slice(5), v: N(w.present) + N(w.late), tip: (w.day || w.date) + ' · present ' + w.present + ' · late ' + w.late + ' · absent ' + w.absent, modal: spec('attendance-day', w.date), tone: 'success' }; })) : empty('chart-column', 'No attendance this week', '')) +
            section('Recently recognised', rec.length ? '<div class="kj-list">' + rec.map(function (r) {
              var s = ATT[r.status] || ['Seen', 'primary'];
              return '<div class="kj-list-item" data-kj-modal="' + esc(spec('person', r.personId)) + '"' + attrSeed({ name: r.name, photo: r.image || '' }) + '>' + avatar(r.image, r.name) +
                '<div class="kj-list-main"><div class="kj-list-title">' + esc(r.name || '#' + r.personId) + '</div><div class="kj-list-sub">' + esc([r.staffId, r.location, r.time].filter(Boolean).join(' · ')) + '</div></div>' + chip(s[0], s[1]) + '</div>';
            }).join('') + '</div>' : empty('scan-face', 'No recognitions yet today', ''))
        };
      }
      if (key === 'ppe') {
        var items = Object.keys(PPE).map(function (k) { return { label: PPE[k], n: N((p.byItem || {})[k]) }; }).filter(function (r) { return r.n > 0; }).sort(function (a, b) { return b.n - a.n; });
        return {
          title: 'PPE compliance', icon: 'hard-hat', tone: 'warn', foot: foot, actions: actions,
          body: '<div class="kj-grid-3">' + statTile('shield-check', p.compliance != null ? p.compliance + '%' : '—', 'Compliance · 7 days', 'success') +
              statTile('triangle-alert', fmtN(p.today), 'Violations today', N(p.today) ? 'danger' : 'success') + statTile('history', fmtN(p.yesterday), 'Yesterday', '') + '</div>' +
            dayCard(p.daily, [['Checks', 'checks'], ['Violations', 'violations']]) +
            section('Violations per day', dailyBars(p.daily, 'ppe', function (r) { return r.violations; }, 'danger')) +
            section('Missing items today', items.length ? hbars(items, 'danger') : empty('shield-check', 'No PPE violations today', ''))
        };
      }
      if (key === 'ra') {
        var by = ra.todayBy || {};
        return {
          title: 'Restricted area alerts', icon: 'shield-alert', tone: 'danger', foot: foot, actions: actions,
          body: '<div class="kj-grid-4">' + statTile('siren', fmtN(ra.today), 'Alerts today', N(ra.today) ? 'danger' : 'success') + statTile('ban', fmtN(by.violation), 'Unauthorized', 'danger') +
              statTile('eye', fmtN(by.review), 'Needs review', 'warn') + statTile('badge-check', fmtN(by.authorized), 'Authorized', 'success') + '</div>' +
            dayCard(ra.daily, [['Unauthorized', 'violation'], ['Needs review', 'review'], ['Authorized', 'authorized']]) +
            section('Alerts per day', dailyBars(ra.daily, 'ra', function (r) { return N(r.violation) + N(r.review) + N(r.authorized); }, 'danger')) +
            '<div class="kj-grid-2">' + section('Busiest zones · 7 days', (ra.zones || []).length ? hbars(ra.zones.map(function (z) { return { label: z.zone, n: z.n }; }), 'danger') : empty('map', 'No zone alerts', '')) +
            section('Latest alerts', recentList(ra.recent)) + '</div>'
        };
      }
      if (key === 'cl') {
        var ci = Object.keys(cl.byItem || {}).map(function (k) { var b = cl.byItem[k] || {}; var req = N(b.required), miss = N(b.missing);
          return req ? { label: PPE[k] || k, pct: Math.round(100 * (req - miss) / req), val: Math.round(100 * (req - miss) / req) + '%', tone: (req - miss) / req >= .95 ? 'success' : ((req - miss) / req >= .8 ? 'warn' : 'danger') } : null; }).filter(Boolean);
        return {
          title: 'Cleaning monitoring', icon: 'sparkles', tone: 'success', foot: foot, actions: actions,
          body: '<div class="kj-grid-4">' + statTile('calendar-clock', fmtN(cl.sessionsToday), 'Sessions today', 'primary') + statTile('circle-check', fmtN(cl.done), 'Done', 'success') +
              statTile('loader', fmtN(cl.pending), 'Pending', 'warn') + statTile('circle-x', fmtN(cl.notDone), 'Not done', 'danger') + '</div>' +
            dayCard(cl.daily, [['PPE checks', 'checks'], ['PPE missing', 'violations']]) +
            section('PPE missing during cleaning · per day', dailyBars(cl.daily, 'cl', function (r) { return r.violations; }, 'danger')) +
            section('PPE compliance by item · 7 days', ci.length ? hbars(ci) : empty('sparkles', 'No cleaning PPE checks yet', ''))
        };
      }
      if (key === 'fk') {
        var w = fk.week || {};
        return {
          title: 'Forklift monitoring', icon: 'forklift', tone: 'orange', foot: foot, actions: actions,
          body: '<div class="kj-grid-4">' + statTile('forklift', fmtN(fk.today), 'Detections today', 'orange') + statTile('triangle-alert', fmtN(fk.violationsToday), 'Violations today', N(fk.violationsToday) ? 'danger' : 'success') +
              statTile('folder-open', fmtN(fk.open), 'Open', 'warn') + statTile('footprints', fmtN(w.pedIntrusions), 'Pedestrian intrusions · 7 d', 'danger') + '</div>' +
            dayCard(fk.daily, [['Detections', 'detections'], ['Violations', 'violations']]) +
            section('Detections per day', dailyBars(fk.daily, 'fk', function (r) { return r.detections; }, 'orange')) +
            '<div class="kj-grid-2">' + section('Zones · 7 days', (fk.zones || []).length ? hbars(fk.zones.map(function (z) { return { label: z.zone, n: z.n, val: fmtN(z.n) + (N(z.v) ? ' · ' + fmtN(z.v) + ' viol.' : '') }; }), 'orange') : empty('map', 'No forklift activity', '')) +
            section('Latest events', recentList(fk.recent)) + (fk.modelNote ? '<div class="kj-help">' + esc(fk.modelNote) + '</div>' : '') + '</div>'
        };
      }
      if (key === 'ev') {
        var t0 = new Date(day ? day + 'T00:00:00' : today() + 'T00:00:00').getTime();
        var list = (st().events || []).filter(function (z) { var t = N(z.ts); return t >= t0 && t < t0 + 86400000; }).map(normEvent);
        var mods = {}; list.forEach(function (z) { mods[z.mod] = (mods[z.mod] || 0) + 1; });
        var hi = list.filter(function (z) { return z.sev === 'critical' || z.sev === 'high'; }).length;
        return {
          title: 'Detections · ' + (day ? fmtDate(day) : 'today'), icon: 'radar', tone: hi ? 'danger' : 'primary', foot: foot, actions: actions,
          body: '<div class="kj-grid-4">' + statTile('radar', fmtN(list.length), 'Detections', 'primary') + statTile('siren', fmtN(hi), 'High / critical', hi ? 'danger' : 'success') +
              statTile('bell-ring', fmtN(list.filter(function (z) { return z.status === 'open'; }).length), 'Open', 'warn') +
              statTile('cctv', fmtN(new Set(list.map(function (z) { return z.camera; })).size), 'Cameras', '') + '</div>' +
            section('By module', Object.keys(mods).length ? hbars(Object.keys(mods).map(function (k) { return { label: (MOD[k] || [k])[0], n: mods[k], tone: { danger: 'danger', warn: 'warn', orange: 'orange', purple: 'purple', success: 'success' }[(MOD[k] || [])[2]] }; }), 'muted') : empty('radar', 'No detections', 'Only the live window (latest feed) is listed here.')) +
            section('Events', list.length ? '<div class="kj-list">' + list.slice(0, 30).map(eventRow).join('') + '</div>' : '')
        };
      }
      return { title: 'Overview', body: empty('chart-column', 'Unknown widget', 'No drill-down is defined for "' + key + '".') };
    }
  });

  /* ======================================================================
   * TYPE: image  (id = image URL) — full-size proof viewer
   * ==================================================================== */
  // Enhance (GET /api/image/enhance, lib/ImageRoutes.php) is USER-INITIATED
  // ONLY: nothing is requested until the "Enhance" button is clicked; after
  // that, slider / upscale changes re-fetch (debounced) and already-rendered
  // settings swap back instantly from the per-modal cache.
  var IV_SELF = (document.currentScript && document.currentScript.src) || '';
  function ivCss() {
    if (document.getElementById('kj-image-viewer-css') || !document.head) return;
    var m = /^(.*\/)js\/kj-modal\.js(\?.*)?$/.exec(IV_SELF);
    var l = document.createElement('link');
    l.id = 'kj-image-viewer-css'; l.rel = 'stylesheet';
    l.href = m ? m[1] + 'css/kj-image-viewer.css' + (m[2] || '') : 'assets/css/kj-image-viewer.css';
    document.head.appendChild(l);
  }
  // Mirrors AiGuard::tierOf — supervisor+ only (the route 404s for staff anyway).
  function ivAllowed() {
    var u = (window.TMNS && window.TMNS.user) || {};
    var r = String(u.role || '').toLowerCase(), p = u.perms || {};
    if (r === 'admin' || r === 'superadmin' || r === 'supervisor') return true;
    if (r === 'operator' || r === 'viewer' || r === 'staff' || !r) return false;
    return !!(p.users || p.settings);
  }
  // Server-side reference for the shown image, or null when the route cannot resolve it.
  function ivRef(url, data) {
    if (data && data.enhanceRef) return String(data.enhanceRef);
    if (!url || /^(data|blob):/i.test(url)) return null;
    var u; try { u = new URL(url, location.href); } catch (e) { return null; }
    var path = u.pathname, m;
    if ((m = /\/api\/tickets\/(\d+)\/attachments\/(\d+)$/.exec(path))) return 'att:' + m[1] + ':' + m[2];
    if ((m = /\/api\/movement\/thumb\/(\d+)$/.exec(path))) return 'event:' + m[1];
    if ((m = /(?:^|\/)storage\/(proofs\/[\w.\/-]+\.(?:webp|jpe?g|png))$/i.exec(path)) && path.indexOf('..') < 0) return m[1];
    if (data && data.eventId != null && /^[\w-]{1,191}$/.test(String(data.eventId))) return 'event:' + data.eventId;
    var hit = null;
    (st().events || []).some(function (raw) {
      var e = normEvent(raw); if (!e) return false;
      var f = e.image === url ? 'trigger' : e.imageBk === url ? 'bk' : e.imageMatch === url ? 'match' : '';
      if (f && /^[\w-]{1,191}$/.test(String(e.id))) { hit = 'event:' + e.id + ':' + f; return true; }
      return false;
    });
    if (hit) return hit;
    if (u.origin === location.origin && /^\/uploads\//.test(path)) return null;   // profile photos etc. — not detection frames
    if (u.origin === location.origin && /^\/api\//.test(path)) return null;       // other API images
    return 'url:' + url;   // server only accepts it if it equals a stored event image
  }
  function ivFmtWH(o) { return o && o.w ? o.w + '×' + o.h : '?'; }

  register('image', {
    kicker: 'Image', icon: 'image', size: 'lg', skeleton: 'media',
    render: function (ctx) {
      var url = String(ctx.id);
      var label = (ctx.data && ctx.data.label) || 'Image';
      var ref = ivAllowed() ? ivRef(url, ctx.data) : null;
      if (ref) ivCss();
      var slider = function (key, name, min, max, val) {
        return '<label class="kj-iv-ctl"><span class="kj-iv-ctl-top"><span>' + esc(name) + '</span><output data-iv-out="' + key + '">' + val + '</output></span>' +
          '<input type="range" data-iv="' + key + '" min="' + min + '" max="' + max + '" step="1" value="' + val + '" aria-label="' + esc(name) + '"></label>';
      };
      var body = '<div class="kj-iv" data-mode="orig">' +
        '<div class="kj-iv-stage kj-media">' +
          '<img class="kj-iv-orig" src="' + esc(url) + '" alt="' + esc(label) + '">' +
          (ref ? '<img class="kj-iv-enh" alt="' + esc(label + ' (enhanced)') + '" hidden>' +
            '<span class="kj-iv-divider" aria-hidden="true"></span>' +
            '<input class="kj-iv-split" type="range" min="0" max="100" value="50" aria-label="Before / after divider" hidden>' +
            '<span class="kj-iv-tag kj-iv-tag-l" aria-hidden="true">Original</span><span class="kj-iv-tag kj-iv-tag-r" aria-hidden="true">Enhanced</span>' +
            '<span class="kj-iv-shimmer" aria-hidden="true"></span>' : '') +
        '</div>' +
        (ref ? '<div class="kj-iv-bar">' +
            '<button type="button" class="kj-btn kj-btn-primary kj-iv-go">' + ico('wand-sparkles') + '<span>Enhance</span></button>' +
            '<div class="kj-iv-seg" role="group" aria-label="View" hidden>' +
              '<button type="button" data-iv-mode="orig" aria-pressed="true">Original</button>' +
              '<button type="button" data-iv-mode="enh" aria-pressed="false">Enhanced</button>' +
              '<button type="button" data-iv-mode="split" aria-pressed="false">' + ico('columns-2') + 'Compare</button>' +
            '</div>' +
            '<span class="kj-iv-cap" aria-live="polite"></span>' +
          '</div>' +
          '<div class="kj-iv-ctls" hidden>' +
            slider('b', 'Brightness', -50, 50, 0) + slider('c', 'Contrast', -50, 50, 0) + slider('s', 'Sharpness', 0, 100, 40) +
            '<label class="kj-iv-check"><input type="checkbox" data-iv="upscale"><span>Upscale 2×</span></label>' +
            '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm kj-iv-reset">' + ico('rotate-ccw') + 'Reset</button>' +
          '</div>' : '') +
        '</div>';
      return {
        title: label, icon: 'image',
        body: body,
        foot: (ref ? '<a class="kj-btn kj-btn-primary kj-iv-dl" href="#" download hidden>' + ico('download') + 'Download enhanced</a>' : '') +
          '<a class="kj-btn kj-btn-secondary" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + ico('external-link') + 'Open original</a>',
        mount: ref ? function (c) { ivMount(c, ref); } : null
      };
    }
  });

  function ivMount(ctx, ref) {
    var root = ctx.body.querySelector('.kj-iv'); if (!root) return;
    var $ = function (s) { return root.querySelector(s); };
    var stage = $('.kj-iv-stage'), enh = $('.kj-iv-enh'), go = $('.kj-iv-go'), seg = $('.kj-iv-seg');
    var cap = $('.kj-iv-cap'), ctls = $('.kj-iv-ctls'), split = $('.kj-iv-split'), dl = ctx.foot.querySelector('.kj-iv-dl');
    var base = (window.TMNS && window.TMNS.api) || '/api';
    var cache = {}, seq = 0, timer = 0, started = false;

    function params() {
      var p = { src: ref };
      root.querySelectorAll('input[type=range][data-iv]').forEach(function (i) { p[i.getAttribute('data-iv')] = i.value; });
      if ($('input[data-iv=upscale]').checked) p.upscale = '1';
      return p;
    }
    function qs(p) { return new URLSearchParams(p).toString(); }
    function setMode(mode) {
      root.setAttribute('data-mode', mode);
      seg.querySelectorAll('[data-iv-mode]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-iv-mode') === mode)); });
      split.hidden = mode !== 'split';
    }
    function busy(on) {
      stage.classList.toggle('is-loading', on);
      go.disabled = on;
      go.querySelector('span').textContent = on ? 'Enhancing…' : (started ? 'Re-enhance' : 'Enhance');
    }
    function show(entry) {
      enh.src = entry.url; enh.hidden = false;
      seg.hidden = false; ctls.hidden = false;
      var m = entry.meta || {};
      cap.textContent = ivFmtWH(m.orig) + ' → ' + ivFmtWH(m.enhanced) + ' · ' + (m.engine || '?');
      if (dl) { dl.href = entry.url + '&download=1'; dl.hidden = false; }
      if (root.getAttribute('data-mode') === 'orig') setMode('enh');
    }
    function fetchEnhanced() {
      var p = params(), key = qs(p);
      started = true;
      if (cache[key]) { show(cache[key]); return; }   // already rendered: instant swap
      var my = ++seq;
      busy(true);
      api('/image/enhance', Object.assign({ meta: '1' }, p)).then(function (meta) {
        if (my !== seq) return;
        var u = base + '/image/enhance?' + key;
        var pre = new Image();
        pre.onload = function () {
          if (my !== seq) return;
          cache[key] = { url: u, meta: meta };
          show(cache[key]); busy(false);
        };
        pre.onerror = function () { if (my === seq) { busy(false); toast('Could not load the enhanced image.', 'danger'); } };
        pre.src = u;
      }).catch(function (err) {
        if (my !== seq) return;
        busy(false);
        if (err && err.status === 404) {   // route cannot resolve this image (or no access): hide the feature
          root.querySelector('.kj-iv-bar').hidden = true; ctls.hidden = true;
          toast('This image cannot be enhanced.', 'warn');
        } else if (err && err.status === 429) {
          toast('Enhance is busy — try again in a moment.', 'warn');
        } else {
          toast((err && err.message) || 'Enhance failed.', 'danger');
        }
      });
    }
    function later() {
      clearTimeout(timer);
      if (!started) return;
      timer = setTimeout(fetchEnhanced, 450);
    }

    go.addEventListener('click', fetchEnhanced);
    seg.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-iv-mode]'); if (b) setMode(b.getAttribute('data-iv-mode'));
    });
    root.querySelectorAll('input[type=range][data-iv]').forEach(function (i) {
      i.addEventListener('input', function () {
        var o = root.querySelector('[data-iv-out="' + i.getAttribute('data-iv') + '"]'); if (o) o.textContent = i.value;
        later();
      });
    });
    $('input[data-iv=upscale]').addEventListener('change', later);
    $('.kj-iv-reset').addEventListener('click', function () {
      root.querySelectorAll('input[type=range][data-iv]').forEach(function (i) {
        i.value = i.getAttribute('data-iv') === 's' ? 40 : 0;
        var o = root.querySelector('[data-iv-out="' + i.getAttribute('data-iv') + '"]'); if (o) o.textContent = i.value;
      });
      $('input[data-iv=upscale]').checked = false;
      later();
    });
    function setSplit() { stage.style.setProperty('--iv-split', split.value + '%'); }
    split.addEventListener('input', setSplit);
    setSplit();
  }

  window.KJModal = {
    open: open, close: close, closeAll: closeAll, register: register, toast: toast,
    types: function () { return Object.keys(types); },
    spec: spec, parseSpec: parseSpec, baseHash: baseHash,
    // helpers for type authors
    h: { esc: esc, ico: ico, chip: chip, kv: kv, statTile: statTile, empty: empty, section: section, media: media, avatar: avatar,
      link: link, btn: btn, minibars: minibars, hbars: hbars, eventRow: eventRow, normEvent: normEvent, api: api, soft: soft,
      fmtTime: fmtTime, fmtHM: fmtHM, fmtDate: fmtDate, fmtN: fmtN, ago: ago, dur: dur, today: today, viaApp: viaApp, app: app }
  };
  void T;
})();
