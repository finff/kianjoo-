/* KJPages — page-module registry, route lifecycle and feed dispatch.
 *
 * One file per hub lives in assets/js/pages/<hub>.js and calls
 *   KJPages.register('<hub>', { title, perm, defaultSub, subs, routes, shell,
 *                               methods, enter, mount, unmount, onFeed })
 * The dc-runtime app (app.js) calls KJPages.install(Component) once, right
 * after the class definition, so each module's legacy `methods` become
 * Component methods (same `this`, same state). componentDidMount calls
 * KJPages.boot(app); fetchFeed calls KJPages.dispatchFeed(data, app) on every
 * 5 s poll. Contract + redirect table: docs/plan/SPA_ARCHITECTURE.md.
 *
 * Load order (blocking <script> tags in the dc.html head, after support.js):
 *   kj-router.js → kj-pages.js → kj-shell.js → pages/*.js
 */
(function () {
  'use strict';

  var mods = {};
  var order = [];
  var methodOwner = {};
  var listeners = { route: [], feed: [] };
  var S = { app: null, active: null, mounted: null, mountedEl: null, listening: false };
  var STAFF_ROLES = ['operator', 'viewer'];

  function warn() { try { console.warn.apply(console, ['[KJPages]'].concat([].slice.call(arguments))); } catch (e) { /* ignore */ } }
  function safe(fn, self, args) {
    if (typeof fn !== 'function') return undefined;
    try { return fn.apply(self, args || []); } catch (e) { try { console.error('[KJPages]', e); } catch (x) { /* ignore */ } return undefined; }
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function ico(name, cls) { return (window.KJIcon && window.KJIcon.svg) ? window.KJIcon.svg(name, cls) : ''; }

  /* ── identity / RBAC (from window.TMNS injected by index.php) ───────────── */
  function me() { return (window.TMNS && window.TMNS.user) || null; }
  function role() { var u = me(); return String((u && u.role) || '').toLowerCase(); }
  function can(perm) {
    if (!perm) return true;
    var u = me();
    if (!u || !u.perms) return true;          // no session context (preview/editor): don't hide anything
    return !!u.perms[perm];
  }
  function isStaff() { return STAFF_ROLES.indexOf(role()) >= 0; }
  /** Landing route per role (REVAMP_PLAN §1). */
  function defaultPath() {
    if (isStaff()) return 'app-home';
    if (role() === 'supervisor') return 'attendance';
    return 'dashboard';
  }
  function allowed(hub, sub) {
    var m = mods[hub];
    if (!m || !can(m.perm)) return false;
    if (sub == null) return true;
    var sd = m.subs[sub];
    return !!sd && can(sd.perm);
  }
  /** Visible tab subs of a hub (hidden subs like cameras/view excluded). */
  function visibleSubs(hub) {
    var m = mods[hub]; if (!m) return [];
    return Object.keys(m.subs).filter(function (k) { return !m.subs[k].hidden && can(m.subs[k].perm); })
      .map(function (k) { return { key: k, label: m.subs[k].label || k, icon: m.subs[k].icon || '', path: window.KJRouter.format(api, hub, k, []).slice(1) }; });
  }

  /* ── registry ──────────────────────────────────────────────────────────── */
  function register(id, def) {
    if (!id || !def) return;
    if (mods[id]) warn('re-registering page "' + id + '"');
    var m = {};
    Object.keys(def).forEach(function (k) { m[k] = def[k]; });
    m.id = id;
    m.subs = def.subs || {};
    m.routes = def.routes || {};
    m.shell = def.shell || 'desktop';
    m.perm = def.perm == null ? 'view' : def.perm;
    m.title = def.title || id;
    if (!m.defaultSub || !m.subs[m.defaultSub]) m.defaultSub = Object.keys(m.subs)[0] || '';
    if (!mods[id]) order.push(id);
    mods[id] = m;
    api._ver++;
  }
  function list() { return order.map(function (id) { return mods[id]; }); }
  function get(id) { return mods[id] || null; }

  /** Mix every module's legacy `methods` class body into the app component. */
  function install(Component) {
    if (!Component || !Component.prototype) return;
    var proto = Component.prototype;
    list().forEach(function (m) {
      if (typeof m.methods !== 'function' || !m.methods.prototype) return;
      var mp = m.methods.prototype;
      Object.getOwnPropertyNames(mp).forEach(function (n) {
        if (n === 'constructor') return;
        if (Object.prototype.hasOwnProperty.call(proto, n) && methodOwner[n] !== m.id) {
          warn('method "' + n + '" from page "' + m.id + '" collides with ' + (methodOwner[n] ? 'page "' + methodOwner[n] + '"' : 'app.js') + ' — skipped');
          return;
        }
        Object.defineProperty(proto, n, Object.getOwnPropertyDescriptor(mp, n));
        methodOwner[n] = m.id;
      });
    });
  }

  /* ── hosts ─────────────────────────────────────────────────────────────── */
  function desktopHost() {
    var el = document.getElementById('kj-page-host');
    if (!el) {
      el = document.createElement('div');
      el.id = 'kj-page-host';
      el.className = 'kj-page-host';
      (document.querySelector('.c73') || document.body).appendChild(el);
    }
    return el;
  }
  function hostFor(m) {
    if (m && m.shell === 'staff' && window.KJShell) return window.KJShell.staffMain();
    return desktopHost();
  }

  /* ── routing ───────────────────────────────────────────────────────────── */
  function resolveAllowed(input, o) {
    o = o || {};
    var R = window.KJRouter;
    var r = R.resolve(api, input, { legacyFirst: !!o.legacyFirst, fallback: defaultPath() });
    if (!r.hub) return r;
    if (!allowed(r.hub)) {
      var denied = mods[r.hub];
      var d = R.resolve(api, defaultPath(), {});
      d.modal = r.modal; d.redirected = true; d.denied = denied ? denied.title : r.hub;
      return d;
    }
    if (!allowed(r.hub, r.sub)) {
      var subs = visibleSubs(r.hub);
      var name = (mods[r.hub].subs[r.sub] || {}).label || r.sub;
      var d2 = subs.length ? R.resolve(api, subs[0].path, {}) : R.resolve(api, defaultPath(), {});
      d2.modal = r.modal; d2.redirected = true; d2.denied = name;
      return d2;
    }
    return r;
  }
  function writeHash(r, push) {
    var target = window.KJRouter.withModal(r);
    if (!target || target === location.hash) return;
    try { history[push ? 'pushState' : 'replaceState']({ kj: r.key }, '', target); } catch (e) { /* ignore */ }
  }
  function toastDenied(r) {
    if (r && r.denied && window.KJModal && window.KJModal.toast) window.KJModal.toast('You don\'t have access to ' + r.denied, 'warn');
  }
  function unmountCurrent() {
    if (!S.mounted) return;
    var m = mods[S.mounted.hub];
    safe(m && m.unmount, m, [S.mountedEl, S.mounted, S.app]);
    if (S.mountedEl) { S.mountedEl.innerHTML = ''; S.mountedEl.classList.remove('is-active'); }
    S.mounted = null; S.mountedEl = null;
  }
  function transition(r, force) {
    if (!r || !r.hub) return;
    if (!force && S.active && S.active.key === r.key) { S.active.modal = r.modal; return; }
    var m = mods[r.hub], sd = m.subs[r.sub] || {}, app = S.app;
    if (S.mounted && S.mounted.key !== r.key) unmountCurrent();
    S.active = r;
    if (window.KJShell) window.KJShell.setMode(m.shell);
    if (sd.legacy) {
      desktopHost().classList.remove('is-active');
      safe(sd.prepare, sd, [r, app]);
      if (app && app.applyPage) app.applyPage(sd.legacy);
    } else {
      var el = hostFor(m);
      el.classList.add('is-active');
      el.setAttribute('data-kj-page', r.hub + '/' + r.sub);
      if (app && app.setState) app.setState({ page: 'kj:' + r.hub + '/' + r.sub, kjTitle: [m.title, sd.label || ''] });
      if (typeof m.mount === 'function') safe(m.mount, m, [el, r, app]);
      else placeholder(el, { title: m.title, text: 'This page is being rebuilt.' });
      S.mounted = r; S.mountedEl = el;
    }
    if (window.KJShell) window.KJShell.render(r);
    emit('route', r);
  }
  function emit(evt, payload) {
    (listeners[evt] || []).slice().forEach(function (fn) { safe(fn, null, [payload, S.app]); });
  }

  /** Navigate by hub path ('detections/fire', 'app-home', '#people'). Pushes history. */
  function go(path, o) {
    o = o || {};
    var r = resolveAllowed(path, o);
    if (!r.hub) return null;
    if (!o.keepModal) r.modal = '';
    writeHash(r, !o.replace);
    toastDenied(r);
    transition(r, false);
    return r;
  }
  /** Navigate by legacy page name (app.setPage('cameras') = Camera Fleet). */
  function goLegacy(page, o) { o = o || {}; o.legacyFirst = true; return go(page, o); }

  function onLocation() {
    var r = resolveAllowed(location.hash, {});
    if (!r.hub) return;
    if (r.redirected) writeHash(r, false);
    toastDenied(r);
    transition(r, false);
  }

  function boot(app) {
    S.app = app;
    if (!S.listening) {
      window.addEventListener('popstate', onLocation);
      window.addEventListener('hashchange', onLocation);
      S.listening = true;
    }
    if (window.KJShell) window.KJShell.boot();
    var r = resolveAllowed(location.hash, {});
    if (!r.hub) return;
    writeHash(r, false);
    toastDenied(r);
    transition(r, true);
  }
  function stop() {
    unmountCurrent();
    window.removeEventListener('popstate', onLocation);
    window.removeEventListener('hashchange', onLocation);
    S.listening = false; S.active = null; S.app = null;
  }

  /** Legacy page activation hook — app.applyPage(p) calls this after setState({page:p}). */
  function enterLegacy(app, page) {
    var owner = window.KJRouter.tables(api).legacy[page];
    var m = owner && mods[owner.hub];
    if (m) safe(m.enter, m, [app, page]);
  }
  function legacyOwner(page) { var o = window.KJRouter.tables(api).legacy[page]; return o ? { hub: o.hub, sub: o.sub } : null; }

  /** Every 5 s feed payload → active page's onFeed + shell badges + 'feed' listeners. */
  function dispatchFeed(data, app) {
    app = app || S.app;
    var r = S.active, m = r && mods[r.hub];
    if (m) safe(m.onFeed, m, [data, app, r]);
    if (window.KJShell) safe(window.KJShell.onFeed, window.KJShell, [data, app]);
    emit('feed', data);
  }

  function on(evt, fn) { if (listeners[evt] && typeof fn === 'function') listeners[evt].push(fn); return function () { off(evt, fn); }; }
  function off(evt, fn) { var l = listeners[evt]; if (!l) return; var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }

  /* ── shared render helpers for host-mounted pages ─────────────────────── */
  /** Action button that navigates: {label, path, icon, primary, href}. */
  function actionBtn(a) {
    var cls = 'kj-btn ' + (a.primary ? 'kj-btn-primary' : 'kj-btn-secondary');
    var inner = (a.icon ? ico(a.icon) : '') + '<span>' + esc(a.label) + '</span>';
    if (a.href) return '<a class="' + cls + '" href="' + esc(a.href) + '">' + inner + '</a>';
    if (a.modal) return '<button type="button" class="' + cls + '" data-kj-modal="' + esc(a.modal) + '">' + inner + '</button>';
    return '<button type="button" class="' + cls + '" data-kj-nav="' + esc(a.path) + '">' + inner + '</button>';
  }
  /** Empty state with at least one way forward — no dead ends. */
  function emptyState(o) {
    return '<div class="kj-empty">' +
      '<div class="kj-empty-ico">' + ico(o.icon || 'sparkles') + '</div>' +
      '<div class="kj-empty-title">' + esc(o.title || '') + '</div>' +
      (o.text ? '<div class="kj-empty-text">' + esc(o.text) + '</div>' : '') +
      ((o.actions && o.actions.length) ? '<div class="kj-row-wrap kj-empty-actions">' + o.actions.map(actionBtn).join('') + '</div>' : '') +
      '</div>';
  }
  function placeholder(el, o) {
    el.innerHTML = '<div class="kj-page">' +
      (o.heading !== false ? '<div class="kj-page-head"><div><h2 class="kj-page-title">' + esc(o.title || '') + '</h2>' +
        (o.sub ? '<p class="kj-page-sub">' + esc(o.sub) + '</p>' : '') + '</div></div>' : '') +
      emptyState(o) + '</div>';
  }

  var api = {
    _ver: 0,
    register: register, get: get, list: list, install: install,
    boot: boot, stop: stop, go: go, goLegacy: goLegacy,
    current: function () { return S.active; },
    mounted: function () { return S.mounted; },
    app: function () { return S.app; },
    enterLegacy: enterLegacy, legacyOwner: legacyOwner, dispatchFeed: dispatchFeed,
    on: on, off: off,
    can: can, role: role, isStaff: isStaff, me: me, defaultPath: defaultPath, allowed: allowed, visibleSubs: visibleSubs,
    methodOwner: function (n) { return n == null ? Object.assign({}, methodOwner) : (methodOwner[n] || null); },
    resolve: function (input, o) { return resolveAllowed(input, o); },
    h: { esc: esc, ico: ico, actionBtn: actionBtn, emptyState: emptyState, placeholder: placeholder }
  };
  window.KJPages = api;
})();
