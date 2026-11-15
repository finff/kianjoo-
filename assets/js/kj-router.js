/* KJRouter — pure hash parsing / formatting for the Kian Joo VisionAI SPA.
 *
 * Scheme:  #<hub>[/<sub>[/<rest>…]][&modal=<type>:<id>]
 *          e.g. #detections/fire · #cameras/view/cam01 · #app-home · #people&modal=person:P1
 *
 * The router holds no page knowledge of its own: hubs, subs, top-level aliases
 * (#app-home) and legacy page names (#fire, #camdash …) all come from the page
 * modules registered on KJPages (assets/js/pages/*.js). It never touches the DOM
 * or history — kj-pages.js does that. See docs/plan/SPA_ARCHITECTURE.md.
 */
(function () {
  'use strict';

  var MODAL_RE = /(^|&)modal=[^&]*/;

  /** '#/fire&modal=event:1' → {path:'fire', modal:'event:1'} (modal value kept URI-encoded). */
  function split(input) {
    var s = String(input == null ? '' : input).replace(/^#/, '').replace(/^\/+/, '');
    var modal = '';
    var m = /(?:^|&)modal=([^&]*)/.exec(s);
    if (m) modal = m[1];
    var path = s.replace(MODAL_RE, '').replace(/^&+|&+$/g, '').replace(/\/+$/, '');
    return { path: path, modal: modal };
  }

  /** Lookup tables derived from the registry; rebuilt lazily when modules change. */
  function tables(reg) {
    if (reg._tables && reg._tables.ver === reg._ver) return reg._tables;
    var hubs = {}, alias = {}, aliasOf = {}, legacy = {};
    reg.list().forEach(function (mod) {
      hubs[mod.id] = mod;
      Object.keys(mod.routes || {}).forEach(function (a) {
        alias[a] = { hub: mod.id, sub: mod.routes[a] };
        aliasOf[mod.id + '/' + mod.routes[a]] = a;
      });
      Object.keys(mod.subs || {}).forEach(function (k) {
        var sd = mod.subs[k];
        var names = [].concat(sd.legacy ? [sd.legacy] : [], sd.aliases || []);
        names.forEach(function (n) { if (!legacy[n]) legacy[n] = { hub: mod.id, sub: k }; });
      });
    });
    reg._tables = { ver: reg._ver, hubs: hubs, alias: alias, aliasOf: aliasOf, legacy: legacy };
    return reg._tables;
  }

  /** Canonical hash (no modal suffix) for hub/sub/rest. */
  function format(reg, hub, sub, rest) {
    var t = tables(reg), mod = t.hubs[hub];
    rest = rest || [];
    if (!mod) return '#' + hub;
    var a = t.aliasOf[hub + '/' + sub];
    if (a && !rest.length) return '#' + a;
    var out = '#' + hub;
    if (sub && (sub !== mod.defaultSub || rest.length)) out += '/' + sub;
    if (rest.length) out += '/' + rest.join('/');
    return out;
  }

  /**
   * Resolve any hash / path / legacy page name into a route.
   *   opts.legacyFirst  treat the head as a legacy page name before a hub id
   *                     (app.setPage('cameras') = old Camera Fleet page)
   *   opts.fallback     path used when the hash is empty or unknown (role default)
   * Returns {hub, sub, rest[], legacy, modal, hash, key, redirected, from}
   */
  function resolve(reg, input, opts) {
    opts = opts || {};
    var t = tables(reg);
    var sp = split(input);
    var segs = sp.path ? sp.path.split('/') : [];
    var head = segs[0] || '';
    var hub = null, sub = null, rest = [], from = '';
    if (head) {
      if (opts.legacyFirst && t.legacy[head]) { hub = t.legacy[head].hub; sub = t.legacy[head].sub; rest = segs.slice(1); from = 'legacy'; }
      else if (t.alias[head]) { hub = t.alias[head].hub; sub = t.alias[head].sub; rest = segs.slice(1); from = 'alias'; }
      else if (t.hubs[head]) { hub = head; sub = segs[1] || ''; rest = segs.slice(2); from = 'hub'; }
      else if (t.legacy[head]) { hub = t.legacy[head].hub; sub = t.legacy[head].sub; rest = segs.slice(1); from = 'legacy'; }
    }
    if (!hub) {
      var fb = opts.fallback && opts.fallback !== sp.path ? resolve(reg, opts.fallback, {}) : null;
      if (fb && fb.hub) { fb.modal = sp.modal; fb.redirected = true; fb.from = head ? 'unknown' : 'empty'; return fb; }
      return { hub: null, sub: null, rest: [], legacy: null, modal: sp.modal, hash: '', key: '', redirected: true, from: 'none' };
    }
    var mod = t.hubs[hub];
    var sd = (mod.subs || {})[sub];
    // Unknown sub, or a sub that needs a trailing id (cameras/view/<stream>) without one → hub default.
    if (!sd || (sd.rest && !rest.length)) { sub = mod.defaultSub; sd = (mod.subs || {})[sub]; rest = []; }
    if (sd && !sd.rest) rest = [];
    var hash = format(reg, hub, sub, rest);
    return {
      hub: hub, sub: sub, rest: rest,
      legacy: (sd && sd.legacy) || null,
      modal: sp.modal,
      hash: hash,
      key: hash,
      redirected: ('#' + sp.path) !== hash,
      from: from
    };
  }

  /** Full hash incl. the KJModal deep-link suffix. */
  function withModal(route) {
    if (!route || !route.hash) return '';
    return route.hash + (route.modal ? '&modal=' + route.modal : '');
  }

  /** {legacyPage: '#canonical'} — the redirect table, for docs and tests. */
  function redirectTable(reg) {
    var t = tables(reg), out = {};
    Object.keys(t.legacy).forEach(function (n) { out[n] = resolve(reg, n, { legacyFirst: true }).hash; });
    return out;
  }

  window.KJRouter = { split: split, resolve: resolve, format: format, withModal: withModal, redirectTable: redirectTable, tables: tables };
})();
