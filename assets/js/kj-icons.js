/* KJIcon — inline-SVG Lucide icons from the locally vendored UMD build
 * (assets/vendor/lucide/lucide.min.js, v0.460.0 — no CDN at runtime).
 *
 *   KJIcon.svg('user-round')            → '<svg class="kj-ico">…</svg>' string
 *   KJIcon.svg('camera', 'kj-ico-20')   → extra class
 *   KJIcon.hydrate(rootEl)              → replaces <i data-kj-icon="name"> placeholders
 */
(function () {
  'use strict';
  var cache = {};
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function esc(v) { return String(v).replace(/[&<>"]/g, function (c) { return ESC[c]; }); }
  function pascal(name) {
    return String(name || '').split(/[-_\s]+/).map(function (p) { return p ? p[0].toUpperCase() + p.slice(1) : ''; }).join('');
  }
  function node(n) {
    var tag = n[0], attrs = n[1] || {}, kids = n[2] || [];
    var a = Object.keys(attrs).map(function (k) { return ' ' + k + '="' + esc(attrs[k]) + '"'; }).join('');
    return '<' + tag + a + '>' + kids.map(node).join('') + '</' + tag + '>';
  }
  function lookup(name) {
    var L = window.lucide;
    if (!L) return null;
    var key = pascal(name);
    var def = (L.icons && L.icons[key]) || L[key];
    return Array.isArray(def) ? def : null;
  }
  function svg(name, extraClass) {
    var k = name + '|' + (extraClass || '');
    if (cache[k]) return cache[k];
    var def = lookup(name) || lookup('circle');
    if (!def) return '';
    // UMD icon = ['svg', attrs, children] (or just children in some builds).
    var kids = def[0] === 'svg' ? (def[2] || []) : def;
    var out = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" class="kj-ico' +
      (extraClass ? ' ' + esc(extraClass) : '') + '">' + kids.map(node).join('') + '</svg>';
    cache[k] = out;
    return out;
  }
  function hydrate(root) {
    (root || document).querySelectorAll('i[data-kj-icon]').forEach(function (el) {
      var tmp = document.createElement('span');
      tmp.innerHTML = svg(el.getAttribute('data-kj-icon'), el.className || '');
      if (tmp.firstChild) el.replaceWith(tmp.firstChild);
    });
  }
  window.KJIcon = { svg: svg, hydrate: hydrate };
})();
