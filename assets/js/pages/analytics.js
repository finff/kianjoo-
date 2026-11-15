/* Analytics hub — page module (assets/js/pages/analytics.js).
 * Owner: wave-2 analytics + M12 reports agent
 * Absorbs legacy pages: analytics (→ trends), forecast (→ forecast) (+ hidden AI-performance methods)
 * Styles: assets/css/pages/analytics.css (injected from this file — no dc.html edit).
 *
 * Subs (all host-mounted, no legacy template):
 *   #analytics            trends   KPI strip · detections by type (annotated, 30 d) · PPE compliance by line ·
 *                                  detections by camera zone · recent reports · AI forecast strip · heatmap
 *   #analytics/forecast   forecast legacy forecast (KPIs, history + prediction, hour profile, momentum)
 *                                  + AI insight panel (the /forecast `ai` field — admin tier only)
 *   #analytics/reports    reports  M12: generate (range + scope) → POST /report/generate (sync, ~30-60 s+)
 *                                  → magazine-style render; recent reports (GET /reports) → view / print / .md / .html
 * Legacy names `analytics` and `forecast` are kept as aliases (redirect table).
 *
 * Data (no new endpoints — the same aggregates the legacy loaders used):
 *   /forecast?days=N            Insights::aggregate + forecast (+ `ai` for admins)
 *   /behaviour/heatmap?days=N   camera × hour / weekday × hour, cam → location (zones), pick → event list
 *   /ppe/summary?from&to        PPE checks by location (= production line), violations
 *   /events?from&to&stream      drill-down event lists
 *   /reports, /reports/{id}, /report/generate   (lib/AiRoutes.php)
 *
 * Modal types registered here: an-events (event list drill-down), report (magazine view), report-new (generator).
 * Charts: Highcharts when loaded (dc.html loads it), otherwise inline SVG (attribute geometry, CSS-class colours).
 */
(function () {
  'use strict';
  var P = window.KJPages;

  /* ── stylesheet (own file, injected once, cache-busted with this script's ?v=) ── */
  var SELF = document.currentScript && document.currentScript.src || '';
  var VER = (/[?&]v=([^&]+)/.exec(SELF) || [])[1] || '';
  function ensureCss() {
    if (document.getElementById('kj-an-css')) return;
    var l = document.createElement('link');
    l.id = 'kj-an-css'; l.rel = 'stylesheet';
    l.href = 'assets/css/pages/analytics.css' + (VER ? '?v=' + VER : '');
    (document.head || document.documentElement).appendChild(l);
  }
  ensureCss();

  /* ── utils ───────────────────────────────────────────────────────────── */
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) { return v == null ? '' : String(v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function ico(n, c) { return window.KJIcon ? window.KJIcon.svg(n, c) : ''; }
  function N(v) { return Number(v) || 0; }
  function fmtN(v) { return N(v).toLocaleString('en-US'); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function daysAgo(n) { return ymd(new Date(Date.now() - n * 86400000)); }
  function shortDay(s) {
    var d = new Date(String(s).slice(0, 10) + 'T00:00:00'); if (isNaN(d)) return String(s || '');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function longDay(s) {
    var d = new Date(String(s).slice(0, 10) + 'T00:00:00'); if (isNaN(d)) return String(s || '—');
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }
  function when(s) {
    var d = new Date(String(s || '').replace(' ', 'T')); if (isNaN(d)) return String(s || '—');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function sum(a, f) { return a.reduce(function (s, x) { return s + N(f ? f(x) : x); }, 0); }
  function pct(a, b) { return b ? Math.round(1000 * a / b) / 10 : null; }
  function step5(p) { return Math.max(0, Math.min(100, Math.round(N(p) / 5) * 5)); }
  function spec(type, id) { return type + ':' + encodeURIComponent(String(id)); }
  function qs(o) {
    var q = new URLSearchParams();
    Object.keys(o).forEach(function (k) { if (o[k] != null && o[k] !== '') q.set(k, String(o[k])); });
    return q.toString();
  }
  function openSpec(s) { var i = s.indexOf(':'); if (window.KJModal && i > 0) window.KJModal.open(s.slice(0, i), decodeURIComponent(s.slice(i + 1))); }
  function toast(m, t, ms) { if (window.KJModal) window.KJModal.toast(m, t, ms); }

  /* ── API (token for read-token routes; session cookie for AI routes) ── */
  function apiUrl(path, params) {
    var T = window.TMNS || {};
    var q = new URLSearchParams(params || {});
    if (T.token) q.set('token', T.token);
    var s = q.toString();
    return (T.api || '/api') + path + (s ? '?' + s : '');
  }
  function api(path, params, opt) {
    opt = opt || {};
    var init = { method: opt.method || 'GET', cache: 'no-store', credentials: 'same-origin' };
    if (opt.body) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(opt.body); }
    return fetch(apiUrl(path, params), init).then(function (r) {
      return Promise.resolve(r.json()).catch(function () { return { ok: false, error: 'HTTP ' + r.status, _nojson: true }; })
        .then(function (d) { if (d && typeof d === 'object') d._status = r.status; return d; });
    }).then(function (d) {
      if (!d || d.ok === false) {
        var e = new Error((d && (d.error || d.msg)) || 'Request failed');
        e.status = d && d._status; e.nojson = !!(d && d._nojson); throw e;
      }
      return d;
    });
  }
  function soft(p) { return p.catch(function () { return null; }); }

  /* ── RBAC helpers (UX only; the API enforces) ──────────────────────────── */
  function tier() {
    var r = P.role();
    if (r === 'admin' || r === 'superadmin') return 'admin';
    if (r === 'supervisor') return 'supervisor';
    if (r === 'operator' || r === 'viewer') return 'staff';
    return P.can('users') ? 'admin' : (P.can('settings') ? 'supervisor' : 'staff');
  }
  function isAdmin() { return tier() === 'admin'; }
  function scopesFor() {
    var t = tier();
    return {
      personal: true,
      standard: t !== 'staff',
      comprehensive: t !== 'staff' && P.can('reports')
    };
  }

  /* ── detection modules: fixed colour slot per entity (never by rank) ──── */
  var MODS = [
    { key: 'ppe', name: 'PPE violations', icon: 'hard-hat', nav: 'detections/ppe', c: 1 },
    { key: 'intr', name: 'Restricted access', icon: 'shield-alert', nav: 'detections/restricted', c: 2 },
    { key: 'forklift', name: 'Forklift / unsafe movement', icon: 'forklift', nav: 'detections/forklift', c: 3 },
    { key: 'face', name: 'Face & body', icon: 'scan-face', nav: 'detections', c: 4 },
    { key: 'fire', name: 'Fire & smoke', icon: 'flame', nav: 'detections/fire', c: 5 }
  ];
  var MODK = {}; MODS.forEach(function (m) { MODK[m.key] = m; });
  MODK.behaviour = { key: 'behaviour', name: 'Behaviour', icon: 'activity', nav: 'detections/behaviour', c: 6 };
  var INTR_RE = /roi|intrusion|intrude|crossline|cross|tripwire|perimeter|region|area|breach|loiter|tailgat/;
  // Client mirror of DashboardMapper::modOf for raw /events records.
  function modOf(r) {
    if (r.mod) return r.mod;
    var t = [r.trigger_image_type, r.event_type, r.policy_name, r.policy_desc].join(' ').toLowerCase();
    var d = (r.decoded && typeof r.decoded === 'object') ? r.decoded : {};
    if (/fire|smoke|flame|thermal/.test(t) || d.Smoking === 'IsSmoking') return 'fire';
    if (d.BehKind) return 'behaviour';
    if (d.FkVerdict || /forklift|fork.?lift/.test(t)) return 'forklift';
    if (d.PpeMissing || /ppe|helmet|hardhat|hard.?hat|vest|glove|mask.?policy|safety/.test(t)) return 'ppe';
    if (INTR_RE.test(t)) return 'intr';
    if (/face|stranger/.test(t)) return 'face';
    return Object.keys(d).length ? 'face' : 'intr';
  }

  /* ── chart colours: CSS custom properties on .kj-an (light + dark) ────── */
  function cssv(el, name, fb) {
    try { var v = getComputedStyle(el).getPropertyValue(name); return (v && v.trim()) || fb; } catch (e) { return fb; }
  }
  var CFB = ['#1E6BF1', '#0D9488', '#EA580C', '#7C3AED', '#CA8A04', '#64748B'];
  function col(el, c) { return cssv(el, '--kj-an-c' + c, CFB[(c - 1) % CFB.length]); }
  function hasHC() { return !!(window.Highcharts && typeof window.Highcharts.chart === 'function'); }
  function hcBase(el) {
    var text2 = cssv(el, '--kj-text-2', '#4A5672'), muted = cssv(el, '--kj-text-3', '#8691A8'),
      line = cssv(el, '--kj-border', '#E3E8F0'), surf = cssv(el, '--kj-surface', '#fff'), text = cssv(el, '--kj-text', '#0F1B33');
    return {
      chart: { backgroundColor: 'transparent', style: { fontFamily: "Inter, system-ui, sans-serif" }, spacing: [8, 6, 6, 4] },
      title: { text: undefined }, credits: { enabled: false }, exporting: { enabled: false }, accessibility: { enabled: false },
      legend: { enabled: false },
      xAxis: { labels: { style: { color: muted, fontSize: '10.5px' } }, lineColor: line, tickColor: line },
      yAxis: { title: { text: null }, labels: { style: { color: muted, fontSize: '10.5px' } }, gridLineColor: line, gridLineDashStyle: 'Dot', allowDecimals: false, min: 0 },
      tooltip: { backgroundColor: surf, borderColor: line, borderRadius: 10, style: { color: text, fontSize: '12px' }, shared: true },
      plotOptions: { series: { animation: { duration: 400 }, states: { inactive: { opacity: 0.35 } } } },
      _text2: text2
    };
  }
  function destroyCharts(list) { (list || []).forEach(function (c) { try { c.destroy(); } catch (e) { /* gone */ } }); }

  /* ── inline-SVG charts (fallback + small charts) ──────────────────────── */
  function niceMax(v) {
    if (v <= 4) return 4;
    var p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
  }
  /** o: {cats[], series[{key,name,c,data[],dash,col}], height, band{lo[],hi[]}, split, anno[{s,i,label}], hit(sKey,i)->spec|null, tip(i)->str, aria} */
  function svgChart(o) {
    var W = 760, H = o.height || 260, L = 40, R = 14, T = 22, B = 26, pw = W - L - R, ph = H - T - B, n = o.cats.length;
    var all = [];
    o.series.forEach(function (s) { s.data.forEach(function (v) { if (v != null) all.push(N(v)); }); });
    if (o.band) o.band.hi.forEach(function (v) { if (v != null) all.push(N(v)); });
    var max = niceMax(Math.max(1, Math.max.apply(null, all.concat([0]))));
    var hasCol = o.series.some(function (s) { return s.col; });
    var slot = pw / Math.max(1, n);
    function x(i) { return hasCol ? L + slot * (i + 0.5) : L + (n <= 1 ? pw / 2 : i * pw / (n - 1)); }
    function y(v) { return T + ph - (N(v) / max) * ph; }
    var out = '<svg class="kj-an-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.aria || 'Chart') + '">';
    for (var g = 0; g <= 4; g++) {
      var gv = max * g / 4, gy = y(gv).toFixed(1);
      out += '<line class="kj-an-gl" x1="' + L + '" x2="' + (W - R) + '" y1="' + gy + '" y2="' + gy + '"/>' +
        '<text class="kj-an-axis" x="' + (L - 6) + '" y="' + (N(gy) + 3.5) + '" text-anchor="end">' + esc(fmtN(Math.round(gv))) + '</text>';
    }
    var every = Math.max(1, Math.ceil(n / 9));
    o.cats.forEach(function (c, i) {
      if (i % every === 0 || i === n - 1) out += '<text class="kj-an-axis" x="' + x(i).toFixed(1) + '" y="' + (H - 7) + '" text-anchor="middle">' + esc(c) + '</text>';
    });
    if (o.split != null && o.split < n) {
      var sx = (x(o.split) - (hasCol ? slot / 2 : 0)).toFixed(1);
      out += '<rect class="kj-an-fczone" x="' + sx + '" y="' + T + '" width="' + (W - R - N(sx)).toFixed(1) + '" height="' + ph + '"/>' +
        '<line class="kj-an-split" x1="' + sx + '" x2="' + sx + '" y1="' + (T - 6) + '" y2="' + (T + ph) + '"/>' +
        '<text class="kj-an-axis kj-an-axis-b" x="' + (N(sx) + 6) + '" y="' + (T + 4) + '">FORECAST</text>';
    }
    if (o.band) {
      var top = [], bot = [];
      o.band.hi.forEach(function (v, i) { if (v != null) top.push(x(i).toFixed(1) + ',' + y(v).toFixed(1)); });
      for (var b = o.band.lo.length - 1; b >= 0; b--) { if (o.band.lo[b] != null) bot.push(x(b).toFixed(1) + ',' + y(o.band.lo[b]).toFixed(1)); }
      if (top.length > 1) out += '<polygon class="kj-an-band" points="' + top.concat(bot).join(' ') + '"/>';
    }
    o.series.forEach(function (s, si) {
      if (!s.col) return;
      var cols = o.series.filter(function (z) { return z.col; }), k = cols.indexOf(s), bw = Math.max(2, Math.min(18, slot * 0.7 / cols.length));
      s.data.forEach(function (v, i) {
        if (v == null) return;
        var bx = x(i) - (bw * cols.length) / 2 + k * bw, by = y(v), hgt = Math.max(0, T + ph - by);
        out += '<rect class="kj-an-bar kj-an-f' + s.c + '" x="' + bx.toFixed(1) + '" y="' + by.toFixed(1) + '" width="' + (bw - 1).toFixed(1) + '" height="' + hgt.toFixed(1) + '" rx="2"/>';
      });
      void si;
    });
    o.series.forEach(function (s) {
      if (s.col) return;
      var d = '', pen = false;
      s.data.forEach(function (v, i) {
        if (v == null) { pen = false; return; }
        d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); pen = true;
      });
      if (d) out += '<path class="kj-an-line kj-an-s' + s.c + (s.dash ? ' is-dash' : '') + '" d="' + d + '"/>';
    });
    (o.anno || []).forEach(function (a) {
      var s = o.series.filter(function (z) { return z.key === a.s; })[0]; if (!s || s.data[a.i] == null) return;
      var ax = x(a.i), ay = y(s.data[a.i]), tw = 10 + a.label.length * 6.2, lx = Math.min(W - R - tw, Math.max(L, ax - tw / 2)), ly = Math.max(2, ay - 30);
      out += '<line class="kj-an-anno-line" x1="' + ax.toFixed(1) + '" x2="' + ax.toFixed(1) + '" y1="' + (ly + 18) + '" y2="' + (T + ph) + '"/>' +
        '<rect class="kj-an-anno-box" x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" width="' + tw.toFixed(1) + '" height="18" rx="5"/>' +
        '<text class="kj-an-anno-txt" x="' + (lx + tw / 2).toFixed(1) + '" y="' + (ly + 12.5).toFixed(1) + '" text-anchor="middle">' + esc(a.label) + '</text>' +
        '<circle class="kj-an-anno-pt kj-an-s' + s.c + '" cx="' + ax.toFixed(1) + '" cy="' + ay.toFixed(1) + '" r="5"/>';
    });
    // Hit targets bigger than the marks: one per series point, each opens a drill-down.
    o.series.forEach(function (s) {
      s.data.forEach(function (v, i) {
        if (v == null) return;
        var sp = o.hit ? o.hit(s.key, i) : null;
        var tip = (o.tip ? o.tip(i) + ' · ' : '') + s.name + ': ' + fmtN(v);
        out += '<circle class="kj-an-hit' + (sp ? '' : ' is-static') + '" cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="' + (s.col ? 10 : 8) + '"' +
          (sp ? ' data-kj-modal="' + esc(sp) + '"' : '') + '><title>' + esc(tip) + '</title></circle>';
      });
    });
    return out + '</svg>';
  }
  function hcChart(host, o) {
    var H = window.Highcharts, base = hcBase(host), text2 = base._text2;
    delete base._text2;
    var n = o.cats.length, series = [];
    if (o.band) {
      series.push({ type: 'area', name: 'band-lo', data: o.band.lo, stack: 'band', fillOpacity: 0, lineWidth: 0, enableMouseTracking: false, showInLegend: false, color: 'transparent', marker: { enabled: false } });
      series.push({ type: 'area', name: 'Confidence band (95%)', data: o.band.hi.map(function (v, i) { return v == null ? null : Math.max(0, N(v) - N(o.band.lo[i])); }), stack: 'band', fillOpacity: 0.18, lineWidth: 0, enableMouseTracking: false, color: col(host, 1), marker: { enabled: false } });
    }
    o.series.forEach(function (s) {
      var data = s.data.map(function (v, i) {
        var a = (o.anno || []).filter(function (z) { return z.s === s.key && z.i === i; })[0];
        return a ? { y: v, marker: { enabled: true, radius: 5 }, dataLabels: { enabled: true, format: a.label, y: -10, style: { fontSize: '11px', fontWeight: '600', color: text2, textOutline: 'none' } } } : v;
      });
      series.push({ id: s.key, type: s.col ? 'column' : 'spline', name: s.name, data: data, color: col(host, s.c), dashStyle: s.dash ? 'ShortDash' : 'Solid', lineWidth: 2, borderRadius: 3, borderWidth: 0 });
    });
    var cfg = {
      chart: { height: o.height || 280 },
      xAxis: { categories: o.cats, tickInterval: Math.max(1, Math.ceil(n / 9)),
        plotBands: o.split != null ? [{ from: o.split - 0.5, to: n, color: cssv(host, '--kj-an-fczone', 'rgba(30,107,241,.06)'), label: { text: 'FORECAST', style: { color: text2, fontSize: '9.5px', fontWeight: '700' } } }] : [] },
      plotOptions: {
        area: { stacking: 'normal' },
        series: { cursor: 'pointer', marker: { enabled: false, radius: 4, symbol: 'circle' },
          point: { events: { click: function () { var sp = o.hit && o.hit(this.series.userOptions.id, this.index); if (sp) openSpec(sp); } } } }
      },
      series: series
    };
    return H.chart(host, H.merge({}, base, cfg));
  }
  /** Renders into host: Highcharts when present, else inline SVG. Returns a chart instance or null. */
  function drawChart(host, o) {
    if (!host) return null;
    if (hasHC()) { try { host.innerHTML = ''; return hcChart(host, o); } catch (e) { /* fall through to SVG */ } }
    host.innerHTML = svgChart(o);
    return null;
  }
  function spark(data, c) {
    var W = 120, H = 36, n = data.length; if (n < 2) return '';
    var mx = Math.max(1, Math.max.apply(null, data.map(N)));
    var pts = data.map(function (v, i) { return (i * W / (n - 1)).toFixed(1) + ',' + (H - 3 - N(v) / mx * (H - 6)).toFixed(1); });
    return '<svg class="kj-an-spark" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true" preserveAspectRatio="none">' +
      '<polygon class="kj-an-spark-area kj-an-f' + c + '" points="0,' + H + ' ' + pts.join(' ') + ' ' + W + ',' + H + '"/>' +
      '<polyline class="kj-an-spark-line kj-an-s' + c + '" points="' + pts.join(' ') + '"/></svg>';
  }
  function donut(rows, total, centerSpec, label) {
    var R = 70, C = 2 * Math.PI * R, off = 0, out = '<svg class="kj-an-donut" viewBox="0 0 200 200" role="img" aria-label="' + esc(label) + '">' +
      '<circle class="kj-an-donut-track" cx="100" cy="100" r="' + R + '"/>';
    rows.forEach(function (r) {
      var len = total ? C * r.n / total : 0, gap = rows.length > 1 ? Math.min(3, len / 3) : 0;
      out += '<circle class="kj-an-donut-seg kj-an-s' + r.c + '" cx="100" cy="100" r="' + R + '" stroke-dasharray="' + Math.max(0, len - gap).toFixed(2) + ' ' + C.toFixed(2) + '"' +
        ' stroke-dashoffset="' + (-off).toFixed(2) + '" transform="rotate(-90 100 100)" data-kj-modal="' + esc(r.spec) + '"><title>' + esc(r.label + ': ' + fmtN(r.n) + ' (' + (pct(r.n, total) || 0) + '%)') + '</title></circle>';
      off += len;
    });
    return out + '<text class="kj-an-donut-val" x="100" y="100" text-anchor="middle" data-kj-modal="' + esc(centerSpec) + '">' + esc(fmtN(total)) + '</text>' +
      '<text class="kj-an-donut-lbl" x="100" y="120" text-anchor="middle">Total detections</text></svg>';
  }

  /* ── skeleton / empty / error blocks ───────────────────────────────────── */
  function skel(kind) {
    if (kind === 'chart') return '<div class="kj-an-skel-chart"><span class="kj-skel kj-skel-block"></span></div>';
    if (kind === 'list') return '<div><span class="kj-skel kj-skel-line"></span><span class="kj-skel kj-skel-line is-mid"></span><span class="kj-skel kj-skel-line"></span><span class="kj-skel kj-skel-line is-short"></span></div>';
    return '<span class="kj-skel kj-skel-tile"></span>';
  }
  function empty(o) { return P.h.emptyState(o); }
  function errBox(text, retryAttr) {
    return '<div class="kj-empty is-error"><div class="kj-empty-ico">' + ico('cloud-off') + '</div><div class="kj-empty-title">Could not load this</div>' +
      '<div class="kj-empty-text">' + esc(text || 'Check your connection and try again.') + '</div>' +
      '<div class="kj-row-wrap kj-empty-actions"><button type="button" class="kj-btn kj-btn-secondary" data-an-act="' + esc(retryAttr || 'reload') + '">' + ico('refresh-cw') + '<span>Retry</span></button></div></div>';
  }

  /* ── module state ─────────────────────────────────────────────────────── */
  var S = { el: null, sub: '', range: 30, fcDays: 14, hmView: 'cam', hmMod: '', charts: [], seq: 0, data: {}, gen: null, repAll: false };
  function alive(seq) { return S.el && seq === S.seq; }
  function $(sel) { return S.el ? S.el.querySelector(sel) : null; }
  function setHtml(sel, html) { var x = $(sel); if (x) x.innerHTML = html; return x; }

  /* ======================================================================
   * TRENDS (#analytics)
   * ==================================================================== */
  function renderTrends(el) {
    var R = S.range;
    el.innerHTML = '<div class="kj-page kj-an" data-an="trends">' +
      '<div class="kj-page-head kj-an-head"><div><h2 class="kj-page-title">Analytics</h2><p class="kj-page-sub">Actionable intelligence for a safer, smarter plant</p></div>' +
      '<div class="kj-an-controls">' +
        '<label class="kj-an-select">' + ico('calendar') + '<span class="kj-sr-only">Time range</span><select class="kj-select" data-an-range>' +
          [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days']].map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === R ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
        '</select></label>' +
        '<button type="button" class="kj-btn kj-btn-primary" data-kj-modal="' + esc(spec('report-new', R + 'd')) + '">' + ico('file-chart-column') + '<span>Generate comprehensive report</span></button>' +
      '</div></div>' +
      '<div class="kj-an-kpis" data-an-slot="kpis">' + [1, 2, 3, 4].map(function () { return '<div class="kj-card kj-an-kpi">' + skel() + '</div>'; }).join('') + '</div>' +
      '<div class="kj-an-grid">' +
        '<section class="kj-card kj-an-main"><div class="kj-card-head"><h3 class="kj-card-title">Detections by type over ' + R + ' days</h3><span class="kj-spacer"></span>' +
          '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kj-nav="detections">' + ico('scan-eye') + '<span>Detections log</span></button></div>' +
          '<div class="kj-an-chart" data-an-slot="types">' + skel('chart') + '</div><div class="kj-an-legend" data-an-slot="types-legend"></div></section>' +
        '<aside class="kj-card kj-an-side"><div class="kj-card-head">' + ico('file-text', 'kj-ico-20') + '<h3 class="kj-card-title">Recent reports</h3><span class="kj-spacer"></span><span data-an-slot="rep-chip"></span></div>' +
          '<div data-an-slot="reports">' + skel('list') + '</div>' +
          '<button type="button" class="kj-btn kj-btn-soft kj-btn-block kj-an-side-more" data-kj-nav="analytics/reports"><span>View all reports</span>' + ico('arrow-right') + '</button></aside>' +
        '<section class="kj-card kj-an-ppe"><div class="kj-card-head"><h3 class="kj-card-title">PPE compliance by line</h3><span class="kj-spacer"></span>' +
          '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kj-nav="detections/ppe">' + ico('hard-hat') + '<span>PPE page</span></button></div>' +
          '<div data-an-slot="ppe">' + skel('list') + '</div></section>' +
        '<section class="kj-card kj-an-zones"><div class="kj-card-head"><h3 class="kj-card-title">Detections by camera zone</h3><span class="kj-spacer"></span>' +
          '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kj-nav="cameras">' + ico('cctv') + '<span>Cameras</span></button></div>' +
          '<div data-an-slot="zones">' + skel('chart') + '</div></section>' +
        '<section class="kj-card kj-an-fc"><div class="kj-card-head">' + ico('sparkles', 'kj-ico-20 kj-an-spark-ico') + '<h3 class="kj-card-title">AI Forecast</h3><span class="kj-spacer"></span>' +
          '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kj-nav="analytics/forecast"><span>Full forecast</span>' + ico('arrow-right') + '</button></div>' +
          '<div data-an-slot="fc">' + skel('chart') + '</div></section>' +
        '<section class="kj-card kj-an-heat"><div class="kj-card-head"><h3 class="kj-card-title">Incident heatmap</h3><span class="kj-card-sub" data-an-slot="hm-sub"></span><span class="kj-spacer"></span>' +
          '<div class="kj-tabs kj-an-tabs" role="tablist">' + [['cam', 'Camera × hour'], ['dow', 'Weekday × hour']].map(function (v) {
            return '<button type="button" role="tab" class="kj-tab' + (S.hmView === v[0] ? ' is-active' : '') + '" aria-selected="' + (S.hmView === v[0]) + '" data-an-hm="' + v[0] + '">' + v[1] + '</button>'; }).join('') + '</div>' +
          '<label class="kj-an-select kj-an-select-sm"><span class="kj-sr-only">Module</span><select class="kj-select" data-an-hmmod>' +
            [['', 'All modules']].concat(MODS.map(function (m) { return [m.key, m.name]; })).concat([['behaviour', 'Behaviour']]).map(function (o) { return '<option value="' + o[0] + '"' + (S.hmMod === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') +
          '</select></label></div>' +
          '<div data-an-slot="heat">' + skel('chart') + '</div></section>' +
      '</div></div>';
    loadTrends();
  }

  function loadTrends() {
    var seq = ++S.seq, R = S.range, fcDays = Math.min(90, R * 2);
    destroyCharts(S.charts); S.charts = [];
    var pFc = api('/forecast', { days: fcDays }), pHm = api('/behaviour/heatmap', { days: R, module: S.hmMod });
    var pPpe = api('/ppe/summary', { from: daysAgo(R - 1), to: daysAgo(0) });
    var pPrev = R <= 45 ? soft(api('/ppe/summary', { from: daysAgo(2 * R - 1), to: daysAgo(R) })) : Promise.resolve(null);
    pFc.then(function (fc) { if (!alive(seq)) return; S.data.fc = fc; paintTypes(fc); paintFcStrip(fc); paintKpis(); })
      .catch(function (e) { if (!alive(seq)) return; S.data.fc = null; setHtml('[data-an-slot="types"]', errBox(e.message)); setHtml('[data-an-slot="fc"]', errBox(e.message)); paintKpis(); });
    Promise.all([pPpe, pPrev]).then(function (r) { if (!alive(seq)) return; S.data.ppe = r[0]; S.data.ppePrev = r[1]; paintPpe(r[0]); paintKpis(); })
      .catch(function (e) { if (!alive(seq)) return; S.data.ppe = null; setHtml('[data-an-slot="ppe"]', errBox(e.message)); paintKpis(); });
    pHm.then(function (hm) { if (!alive(seq)) return; S.data.hm = hm; paintZones(hm); paintHeat(hm); })
      .catch(function (e) { if (!alive(seq)) return; setHtml('[data-an-slot="zones"]', errBox(e.message)); setHtml('[data-an-slot="heat"]', errBox(e.message)); });
    loadReportsInto('[data-an-slot="reports"]', 5, seq, true);
  }

  function windowOf(fc) {
    var R = S.range, d = (fc && fc.agg && fc.agg.daily) || [];
    var cur = d.slice(-R), prev = d.length >= 2 * R ? d.slice(-2 * R, -R) : null;
    return { cur: cur, prev: prev };
  }
  function delta(curV, prevV, unit, goodWhenUp) {
    if (curV == null || prevV == null) return '<span class="kj-an-delta is-flat">' + esc(unit === 'pp' ? 'no earlier data' : 'no earlier period') + '</span>';
    var dv = unit === 'pp' ? Math.round((curV - prevV) * 10) / 10 : (prevV ? Math.round(1000 * (curV - prevV) / prevV) / 10 : (curV ? 100 : 0));
    var up = dv > 0, good = dv === 0 ? null : (up === goodWhenUp);
    return '<span class="kj-an-delta ' + (good == null ? 'is-flat' : (good ? 'is-good' : 'is-bad')) + '">' + ico(dv === 0 ? 'minus' : (up ? 'trending-up' : 'trending-down')) +
      '<b>' + (dv > 0 ? '+' : '') + dv + (unit === 'pp' ? ' pp' : '%') + '</b> vs previous ' + S.range + ' days</span>';
  }

  function paintKpis() {
    var box = $('[data-an-slot="kpis"]'); if (!box) return;
    var app = P.app(), st = (app && app.state) || {};
    var fc = S.data.fc, w = windowOf(fc), R = S.range;
    // 1. total detections
    var tot = fc ? sum(w.cur, function (d) { return d.total; }) : null, totPrev = w.prev ? sum(w.prev, function (d) { return d.total; }) : null;
    // 2. PPE compliance
    var ppe = S.data.ppe, comp = ppe && ppe.kpi ? ppe.kpi.compliance : null, compPrev = S.data.ppePrev && S.data.ppePrev.kpi ? S.data.ppePrev.kpi.compliance : null;
    var ppeSpark = ppe && ppe.daily ? ppe.daily.map(function (d) { return d.checks ? 100 * (d.checks - d.violations) / d.checks : null; }).filter(function (v) { return v != null; }) : [];
    // 3. cameras (live fleet)
    var fleet = st.fleet || [], on = fleet.filter(function (c) { return c && (c.online === true || c.online === 1 || c.status === 'online'); }).length;
    // 4. incidents resolved (live feed window)
    var ev = st.events || [], res = ev.filter(function (e) { return e && (e.status === 'resolved' || e.status === 'closed'); }).length;
    var resPct = ev.length ? pct(res, ev.length) : null;
    var kpi = function (o) {
      return '<button type="button" class="kj-card kj-an-kpi"' + (o.modal ? ' data-kj-modal="' + esc(o.modal) + '"' : ' data-kj-nav="' + esc(o.nav) + '"') + '>' +
        '<span class="kj-an-kpi-ico is-' + o.tone + '">' + ico(o.icon, 'kj-ico-24') + '</span>' +
        '<span class="kj-an-kpi-main"><span class="kj-an-kpi-lbl">' + esc(o.label) + '</span><span class="kj-an-kpi-val">' + esc(o.val) + '</span>' + o.sub + '</span>' +
        '<span class="kj-an-kpi-spark">' + (o.spark || '') + '</span></button>';
    };
    box.innerHTML =
      kpi({ label: 'Total detections', icon: 'scan-eye', tone: 'primary', val: tot == null ? '—' : fmtN(tot),
        sub: fc ? delta(tot, totPrev, '%', false) : '<span class="kj-an-delta is-flat">unavailable</span>',
        spark: fc ? spark(w.cur.map(function (d) { return d.total; }), 1) : '',
        modal: spec('an-events', qs({ from: daysAgo(R - 1), to: daysAgo(0), label: 'All detections · last ' + R + ' days' })) }) +
      kpi({ label: 'PPE compliance', icon: 'hard-hat', tone: 'success', val: comp == null ? '—' : comp + '%',
        sub: comp == null ? '<span class="kj-an-delta is-flat">' + (ppe ? 'no PPE checks in range' : 'unavailable') + '</span>' : delta(comp, compPrev, 'pp', true),
        spark: ppeSpark.length > 1 ? spark(ppeSpark, 2) : '', modal: 'stat:ppe' }) +
      kpi({ label: 'Active cameras', icon: 'cctv', tone: 'info', val: fleet.length ? on + ' / ' + fleet.length : '—',
        sub: '<span class="kj-an-delta ' + (fleet.length && on === fleet.length ? 'is-good' : 'is-flat') + '">' + ico(fleet.length && on === fleet.length ? 'circle-check' : 'wifi') +
          '<b>' + (fleet.length ? (pct(on, fleet.length) || 0) + '% online' : 'waiting for the live feed') + '</b></span>',
        nav: 'cameras' }) +
      kpi({ label: 'Incidents resolved', icon: 'shield-check', tone: 'purple', val: resPct == null ? '—' : resPct + '%',
        sub: '<span class="kj-an-delta is-flat">' + (ev.length ? fmtN(res) + ' of ' + fmtN(ev.length) + ' in the live window' : 'no incidents in the live window') + '</span>',
        nav: 'detections' });
    S._kpiSig = kpiSig();
  }
  function kpiSig() {
    var app = P.app(), st = (app && app.state) || {};
    return (st.fleet || []).map(function (c) { return c && c.online ? 1 : 0; }).join('') + '|' + (st.events || []).map(function (e) { return e && e.status; }).join(',');
  }

  function paintTypes(fc) {
    var w = windowOf(fc), host = $('[data-an-slot="types"]'), leg = $('[data-an-slot="types-legend"]');
    if (!host) return;
    var mods = MODS.filter(function (m) { return w.cur.some(function (d) { return N(d[m.key]) > 0; }); });
    if (!w.cur.length || !mods.length) {
      host.innerHTML = empty({ icon: 'chart-line', title: 'No detections in this period', text: 'Detections from the camera fleet will chart here by type.', actions: [{ label: 'Open live cameras', path: 'cameras/wall', icon: 'cctv', primary: true }] });
      if (leg) leg.innerHTML = '';
      return;
    }
    var series = mods.map(function (m) { return { key: m.key, name: m.name, c: m.c, data: w.cur.map(function (d) { return N(d[m.key]); }) }; });
    // Annotations: the busiest day of the leading series, and today's running count.
    var lead = series.slice().sort(function (a, b) { return sum(b.data) - sum(a.data); })[0];
    var pk = lead.data.indexOf(Math.max.apply(null, lead.data)), anno = [];
    if (lead.data[pk] > 0) anno.push({ s: lead.key, i: pk, label: 'Peak · ' + fmtN(lead.data[pk]) });
    var days = w.cur.map(function (d) { return d.day; });
    var o = { cats: days.map(shortDay), series: series, height: 290, anno: anno, aria: 'Detections by type per day',
      tip: function (i) { return longDay(days[i]); },
      hit: function (k, i) { return spec('an-events', qs({ day: days[i], mod: k })); } };
    var c = drawChart(host, o); if (c) S.charts.push(c);
    if (leg) leg.innerHTML = series.map(function (s) {
      return '<button type="button" class="kj-an-leg" data-kj-modal="' + esc(spec('an-events', qs({ from: days[0], to: days[days.length - 1], mod: s.key }))) + '">' +
        '<span class="kj-an-dot kj-an-f' + s.c + '"></span>' + esc(s.name) + ' <b>' + fmtN(sum(s.data)) + '</b></button>';
    }).join('');
  }

  function paintPpe(ppe) {
    var box = $('[data-an-slot="ppe"]'); if (!box) return;
    var rows = ((ppe && ppe.byLocation) || []).filter(function (l) { return N(l.checks) > 0; })
      .sort(function (a, b) { return String(a.location).localeCompare(String(b.location), undefined, { numeric: true }); }).slice(0, 8);
    if (!rows.length) {
      box.innerHTML = empty({ icon: 'hard-hat', title: 'No PPE checks yet', text: 'Set PPE area rules so each production line is checked for required gear.', actions: [{ label: 'PPE area rules', path: 'settings/rules', icon: 'settings', primary: true }] });
      return;
    }
    var from = (ppe && ppe.from) || daysAgo(S.range - 1), to = (ppe && ppe.to) || daysAgo(0);
    box.innerHTML = '<div class="kj-an-ppe-rows">' + rows.map(function (l) {
      var ok = pct(N(l.checks) - N(l.violations), N(l.checks)) || 0, bad = Math.round((100 - ok) * 10) / 10;
      return '<button type="button" class="kj-an-ppe-row" data-kj-modal="' + esc(spec('an-events', qs({ ppeloc: l.location, from: from, to: to }))) + '" title="' + esc(l.location + ': ' + fmtN(l.checks) + ' checks, ' + fmtN(l.violations) + ' violations') + '">' +
        '<span class="kj-an-ppe-name kj-truncate">' + esc(l.location === '—' ? 'Unassigned' : l.location) + '</span>' +
        '<svg class="kj-an-ppe-bar" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">' +
          '<rect class="kj-an-ok" x="0" y="0" width="' + Math.max(0, ok - (bad > 0 ? 0.4 : 0)).toFixed(1) + '" height="10" rx="1.5"/>' +
          (bad > 0 ? '<rect class="kj-an-bad" x="' + (ok + 0.4).toFixed(1) + '" y="0" width="' + Math.max(0.6, bad - 0.4).toFixed(1) + '" height="10" rx="1.5"/>' : '') + '</svg>' +
        '<span class="kj-an-ppe-val"><b>' + ok + '%</b><span class="' + (bad > 5 ? 'is-bad' : 'kj-muted') + '">' + bad + '%</span></span></button>';
    }).join('') + '</div>' +
      '<div class="kj-an-legend"><span class="kj-an-leg is-static"><span class="kj-an-dot kj-an-ok-dot"></span>Compliant (wearing required PPE)</span>' +
      '<span class="kj-an-leg is-static"><span class="kj-an-dot kj-an-bad-dot"></span>Non-compliant (missing or incorrect PPE)</span></div>';
  }

  function zonesOf(hm) {
    var z = {};
    ((hm && hm.cam) || []).forEach(function (r) {
      var k = r.location || 'Unassigned zone';
      z[k] = z[k] || { label: k, n: 0, cams: [] };
      z[k].n += N(r.total); z[k].cams.push(r.key);
    });
    var rows = Object.keys(z).map(function (k) { return z[k]; }).sort(function (a, b) { return b.n - a.n; });
    if (rows.length > 5) {
      var rest = rows.slice(4);
      rows = rows.slice(0, 4).concat([{ label: 'Other zones', n: sum(rest, function (r) { return r.n; }), cams: [].concat.apply([], rest.map(function (r) { return r.cams; })) }]);
    }
    // colour follows the zone name (stable across ranges), not its rank
    var names = rows.map(function (r) { return r.label; }).slice().sort();
    rows.forEach(function (r) { r.c = r.label === 'Other zones' ? 6 : (names.indexOf(r.label) % 5) + 1; });
    return rows;
  }
  function paintZones(hm) {
    var box = $('[data-an-slot="zones"]'); if (!box) return;
    var rows = zonesOf(hm).filter(function (r) { return r.n > 0; }), total = sum(rows, function (r) { return r.n; });
    if (!total) {
      box.innerHTML = empty({ icon: 'chart-pie', title: 'No zone activity', text: 'Map cameras to zones (POC camera points) to group detections by area.', actions: [{ label: 'Camera fleet', path: 'cameras/manage', icon: 'cctv', primary: true }] });
      return;
    }
    var R = S.range;
    rows.forEach(function (r) { r.spec = spec('an-events', qs({ cams: r.cams.join(','), days: R, label: r.label })); });
    box.innerHTML = '<div class="kj-an-zone-wrap">' + donut(rows, total, spec('an-events', qs({ from: daysAgo(R - 1), to: daysAgo(0), label: 'All detections · last ' + R + ' days' })), 'Detections by camera zone') +
      '<div class="kj-an-zone-legend">' + rows.map(function (r) {
        return '<button type="button" class="kj-an-zone-row" data-kj-modal="' + esc(r.spec) + '"><span class="kj-an-dot kj-an-f' + r.c + '"></span>' +
          '<span class="kj-truncate">' + esc(r.label) + '</span><span class="kj-spacer"></span><b>' + fmtN(r.n) + '</b><span class="kj-muted">(' + (pct(r.n, total) || 0) + '%)</span></button>';
      }).join('') + '</div></div>';
  }

  // Least-squares fit over daily totals (same model as Insights::forecast) → 95% band from residuals.
  function fitBand(daily, next7) {
    var y = daily.map(function (d) { return N(d.total); }), n = y.length;
    var sx = 0, sy = 0, sxy = 0, sxx = 0;
    y.forEach(function (v, i) { sx += i; sy += v; sxy += i * v; sxx += i * i; });
    var den = n * sxx - sx * sx, b = den ? (n * sxy - sx * sy) / den : 0, a = n ? (sy - b * sx) / n : 0;
    var sd = Math.sqrt(y.reduce(function (s, v, i) { var r = v - (a + b * i); return s + r * r; }, 0) / Math.max(1, n - 2));
    return (next7 || []).map(function (p) { return { lo: Math.max(0, N(p.predicted) - 1.96 * sd), hi: N(p.predicted) + 1.96 * sd }; });
  }
  function fcSeries(fc, histN) {
    var f = fc.forecast, d = fc.agg.daily.slice(-histN), n = d.length;
    var hist = d.map(function (x) { return N(x.total); }).concat(f.next7.map(function () { return null; }));
    var pred = new Array(Math.max(0, n - 1)).fill(null).concat([n ? N(d[n - 1].total) : 0]).concat(f.next7.map(function (p) { return N(p.predicted); }));
    var band = fitBand(fc.agg.daily, f.next7);
    var lo = new Array(Math.max(0, n - 1)).fill(null).concat([n ? N(d[n - 1].total) : 0]).concat(band.map(function (x) { return Math.round(x.lo * 10) / 10; }));
    var hi = new Array(Math.max(0, n - 1)).fill(null).concat([n ? N(d[n - 1].total) : 0]).concat(band.map(function (x) { return Math.round(x.hi * 10) / 10; }));
    var days = d.map(function (x) { return x.day; }).concat(f.next7.map(function (p) { return p.day; }));
    return { days: days, n: n, hist: hist, pred: pred, band: { lo: lo, hi: hi } };
  }
  function outlookOf(fc) {
    var f = fc.forecast, d = fc.agg.daily, last7 = sum(d.slice(-7), function (x) { return x.total; }), next7 = sum(f.next7, function (p) { return p.predicted; });
    var ch = last7 ? Math.round(100 * (next7 - last7) / last7) : 0;
    return { ch: ch, last7: last7, next7: Math.round(next7) };
  }
  function aiPanel(ai, compact) {
    if (!isAdmin()) return '';            // AI narrative is admin-only (server returns null otherwise)
    if (!ai || !ai.summary) {
      return '<div class="kj-an-ai is-off">' + '<div class="kj-an-ai-head">' + ico('sparkles') + '<b>AI Insight</b></div>' +
        '<p>The AI narrative is not available right now (switched off, warming up or rate-limited). The statistical forecast above is unaffected.</p></div>';
    }
    var tone = ai.outlook === 'rising' ? 'warn' : (ai.outlook === 'falling' ? 'success' : 'primary');
    return '<div class="kj-an-ai' + (compact ? ' is-compact' : '') + '"><div class="kj-an-ai-head">' + ico('sparkles') + '<b>AI Insight</b>' +
      '<span class="kj-chip is-' + tone + '">Outlook: ' + esc(ai.outlook || 'stable') + '</span></div>' +
      '<p class="kj-an-ai-sum">' + esc(ai.summary) + '</p>' +
      (!compact && ai.risks && ai.risks.length ? '<ul class="kj-an-ai-risks">' + ai.risks.map(function (r) { return '<li>' + ico('triangle-alert') + '<span>' + esc(r) + '</span></li>'; }).join('') + '</ul>' : '') +
      (ai.recommendation ? '<p class="kj-an-ai-rec">' + ico('lightbulb') + '<span><b>Recommendation:</b> ' + esc(ai.recommendation) + '</span></p>' : '') +
      '<div class="kj-an-ai-src">' + esc(ai.source || 'AI') + (ai.fetched_at ? ' · ' + esc(when(ai.fetched_at)) : '') + '</div></div>';
  }
  function paintFcStrip(fc) {
    var box = $('[data-an-slot="fc"]'); if (!box) return;
    if (!fc || !fc.forecast || !fc.agg || !fc.agg.total) {
      box.innerHTML = empty({ icon: 'sparkles', title: 'Not enough history to forecast', text: 'The forecast needs a few days of detections.', actions: [{ label: 'Open forecast', path: 'analytics/forecast', icon: 'chart-line', primary: true }] });
      return;
    }
    var s = fcSeries(fc, Math.min(30, fc.agg.daily.length)), ol = outlookOf(fc);
    var o = { cats: s.days.map(shortDay), height: 200, split: s.n, band: s.band, aria: 'Historical incidents and AI forecast',
      series: [{ key: 'hist', name: 'Historical incidents', c: 1, data: s.hist }, { key: 'pred', name: 'Forecast', c: 1, dash: true, data: s.pred }],
      tip: function (i) { return longDay(s.days[i]); },
      hit: function (k, i) { return k === 'hist' && i < s.n ? spec('an-events', qs({ day: s.days[i] })) : null; } };
    box.innerHTML = '<div class="kj-an-fc-grid"><div class="kj-an-chart kj-an-fc-chart" data-an-slot="fc-chart"></div>' +
      '<button type="button" class="kj-an-fc-hero" data-kj-nav="analytics/forecast"><span class="kj-an-fc-big ' + (ol.ch > 0 ? 'is-bad' : 'is-good') + '">' + Math.abs(ol.ch) + '%</span>' +
        '<span class="kj-an-fc-txt">' + (ol.ch > 0 ? 'more' : 'fewer') + ' incidents expected</span>' +
        '<span class="kj-chip ' + (ol.ch > 0 ? 'is-warn' : 'is-success') + '">' + ico(ol.ch > 0 ? 'trending-up' : 'trending-down') + 'next 7 days vs last 7 (' + fmtN(ol.next7) + ' vs ' + fmtN(ol.last7) + ')</span></button>' +
      (isAdmin() ? aiPanel(fc.ai, true) : '') + '</div>' +
      '<div class="kj-an-legend"><span class="kj-an-leg is-static"><span class="kj-an-dot kj-an-f1"></span>Historical incidents</span><span class="kj-an-leg is-static"><span class="kj-an-dash"></span>Forecast</span>' +
      '<span class="kj-an-leg is-static"><span class="kj-an-dot kj-an-band-dot"></span>Confidence band (95%)</span></div>';
    var c = drawChart($('[data-an-slot="fc-chart"]'), o); if (c) S.charts.push(c);
  }

  function heatLevel(n, mx) { return n ? Math.max(1, Math.min(9, Math.ceil(9 * Math.pow(n / mx, 0.6)))) : 0; }
  function paintHeat(hm) {
    var box = $('[data-an-slot="heat"]'); if (!box) return;
    var rows = (hm && hm[S.hmView]) || [];
    setHtml('[data-an-slot="hm-sub"]', hm ? esc(fmtN(hm.total) + ' detections · click a cell to investigate') : '');
    if (!hm || !hm.total) {
      box.innerHTML = empty({ icon: 'grid-3x3', title: 'No detections for these filters', text: 'Try a longer range or another module.', actions: [{ label: 'Detections log', path: 'detections', icon: 'scan-eye' }] });
      return;
    }
    var mx = Math.max(1, Math.max.apply(null, rows.map(function (r) { return Math.max.apply(null, (r.cells || [0]).concat([0])); })));
    var R = S.range;
    box.innerHTML = '<div class="kj-an-hm"><div class="kj-an-hm-row is-head"><span class="kj-an-hm-lab"></span>' +
      Array.from({ length: 24 }, function (_, h) { return '<span class="kj-an-hm-hr">' + (h % 3 === 0 ? pad(h) : '') + '</span>'; }).join('') + '<span class="kj-an-hm-tot">Σ</span></div>' +
      rows.map(function (r) {
        return '<div class="kj-an-hm-row"><span class="kj-an-hm-lab" title="' + esc(r.location || r.label) + '"><b>' + esc(r.label) + '</b>' + (r.location ? '<small>' + esc(r.location) + '</small>' : '') + '</span>' +
          (r.cells || []).map(function (n, h) {
            var t = r.label + (r.location ? ' · ' + r.location : '') + ' · ' + pad(h) + ':00–' + pad((h + 1) % 24) + ':00 · ' + n + ' detection' + (n === 1 ? '' : 's');
            return n ? '<button type="button" class="kj-an-hm-cell kj-an-hm-' + heatLevel(n, mx) + '" title="' + esc(t) + '" data-kj-modal="' +
              esc(spec('an-events', qs({ pick: S.hmView, row: r.key, hour: h, days: R, module: S.hmMod, label: r.label + ' · ' + pad(h) + ':00–' + pad((h + 1) % 24) + ':00' }))) + '">' + n + '</button>'
              : '<span class="kj-an-hm-cell kj-an-hm-0" title="' + esc(t) + '"></span>';
          }).join('') + '<span class="kj-an-hm-tot">' + fmtN(r.total) + '</span></div>';
      }).join('') + '</div>';
  }

  /* ======================================================================
   * FORECAST (#analytics/forecast)
   * ==================================================================== */
  function renderForecast(el) {
    el.innerHTML = '<div class="kj-page kj-an" data-an="forecast">' +
      '<div class="kj-page-head kj-an-head"><div><h2 class="kj-page-title">Trend forecast</h2><p class="kj-page-sub">History, a 7-day statistical prediction and the expected next 24 hours' + (isAdmin() ? ' — narrated by AI' : '') + '</p></div>' +
      '<div class="kj-an-controls"><div class="kj-tabs kj-an-tabs" role="tablist">' + [7, 14, 30, 90].map(function (d) {
        return '<button type="button" role="tab" class="kj-tab' + (S.fcDays === d ? ' is-active' : '') + '" aria-selected="' + (S.fcDays === d) + '" data-an-fcdays="' + d + '">' + d + ' days</button>'; }).join('') + '</div>' +
      '<button type="button" class="kj-btn kj-btn-secondary" data-kj-modal="' + esc(spec('report-new', '30d')) + '">' + ico('file-chart-column') + '<span>Generate report</span></button></div></div>' +
      '<div data-an-slot="fc-body">' +
        '<div class="kj-an-kpis is-5">' + [1, 2, 3, 4, 5].map(function () { return '<div class="kj-card kj-an-kpi">' + skel() + '</div>'; }).join('') + '</div>' +
        '<div class="kj-an-grid2"><div class="kj-card">' + skel('chart') + '</div><div class="kj-card">' + skel('chart') + '</div></div>' +
      '</div></div>';
    loadForecast();
  }
  function loadForecast() {
    var seq = ++S.seq;
    destroyCharts(S.charts); S.charts = [];
    api('/forecast', { days: S.fcDays }).then(function (fc) { if (alive(seq)) paintForecast(fc); })
      .catch(function (e) { if (alive(seq)) setHtml('[data-an-slot="fc-body"]', errBox(e.message)); });
  }
  function paintForecast(fc) {
    var box = $('[data-an-slot="fc-body"]'); if (!box) return;
    if (!fc || !fc.forecast || !fc.agg) { box.innerHTML = errBox('The forecast service returned no data.'); return; }
    var f = fc.forecast, ag = fc.agg, tp = f.trend.total.pct, days = ag.daily.map(function (d) { return d.day; }), D = ag.days;
    var tile = function (o) {
      return '<button type="button" class="kj-card kj-an-kpi is-sm"' + (o.modal ? ' data-kj-modal="' + esc(o.modal) + '"' : ' data-kj-nav="' + esc(o.nav) + '"') + '>' +
        '<span class="kj-an-kpi-ico is-' + o.tone + '">' + ico(o.icon, 'kj-ico-20') + '</span><span class="kj-an-kpi-main"><span class="kj-an-kpi-lbl">' + esc(o.label) + '</span>' +
        '<span class="kj-an-kpi-val">' + esc(o.val) + '</span>' + (o.sub ? '<span class="kj-an-delta is-flat">' + esc(o.sub) + '</span>' : '') + '</span></button>';
    };
    var all = spec('an-events', qs({ from: days[0], to: days[days.length - 1], label: 'All detections · last ' + D + ' days' }));
    var s = fcSeries(fc, days.length);
    var outlook = outlookOf(fc);
    box.innerHTML =
      '<div class="kj-an-kpis is-5">' +
        tile({ label: 'Detections · ' + D + 'd', icon: 'scan-eye', tone: 'primary', val: fmtN(ag.total), sub: 'confidence: ' + f.confidence, modal: all }) +
        tile({ label: 'Avg / day', icon: 'activity', tone: 'info', val: String(f.avgPerDay), modal: all }) +
        tile({ label: 'Momentum', icon: tp > 0 ? 'trending-up' : 'trending-down', tone: tp > 0 ? 'warn' : 'success', val: (tp >= 0 ? '+' : '') + tp + '%', sub: f.trend.total.first + ' → ' + f.trend.total.second, modal: all }) +
        tile({ label: 'Predicted tomorrow', icon: 'calendar', tone: 'orange', val: String(f.next7[0] ? f.next7[0].predicted : '—'), sub: 'next 7 days ≈ ' + fmtN(outlook.next7), nav: 'detections' }) +
        tile({ label: 'Peak hour', icon: 'clock', tone: 'purple', val: pad(f.peakHour) + ':00', sub: 'busiest hour of day', modal: spec('an-events', qs({ from: days[Math.max(0, days.length - 7)], to: days[days.length - 1], hour: f.peakHour, label: 'Peak hour ' + pad(f.peakHour) + ':00 · last 7 days' })) }) +
      '</div>' +
      (isAdmin() ? aiPanel(fc.ai, false) : '') +
      '<div class="kj-an-grid2">' +
        '<section class="kj-card"><div class="kj-card-head"><h3 class="kj-card-title">Daily detections — history &amp; 7-day prediction</h3></div><div class="kj-an-chart" data-an-slot="fc-trend"></div>' +
          '<div class="kj-an-legend"><span class="kj-an-leg is-static"><span class="kj-an-dot kj-an-f1"></span>Detections / day</span><span class="kj-an-leg is-static"><span class="kj-an-dash"></span>Predicted</span><span class="kj-an-leg is-static"><span class="kj-an-dot kj-an-band-dot"></span>Confidence band (95%)</span></div></section>' +
        '<section class="kj-card"><div class="kj-card-head"><h3 class="kj-card-title">Hour-of-day profile &amp; expected next 24 h</h3></div><div class="kj-an-chart" data-an-slot="fc-hours"></div>' +
          '<div class="kj-an-legend"><span class="kj-an-leg is-static"><span class="kj-an-dot kj-an-f1"></span>Observed (window)</span><span class="kj-an-leg is-static"><span class="kj-an-dash is-c3"></span>Expected next 24 h</span></div></section>' +
      '</div>' +
      '<div class="kj-section-title">Momentum by module <span class="kj-muted">— second half of the window vs the first half</span></div>' +
      '<div class="kj-an-mom">' + MODS.map(function (m) {
        var t = f.trend[m.key] || { pct: 0, first: 0, second: 0 }, p = t.pct;
        return '<button type="button" class="kj-card kj-an-mom-card kj-an-b' + m.c + '" data-kj-modal="' + esc(spec('an-events', qs({ from: days[0], to: days[days.length - 1], mod: m.key }))) + '">' +
          '<span class="kj-an-mom-head">' + ico(m.icon) + '<span>' + esc(m.name) + '</span></span>' +
          '<span class="kj-an-mom-val ' + (p > 0 ? 'is-bad' : (p < 0 ? 'is-good' : '')) + '">' + ico(p > 0 ? 'trending-up' : (p < 0 ? 'trending-down' : 'minus')) + (p > 0 ? '+' : '') + p + '%</span>' +
          '<span class="kj-muted">' + fmtN(t.first) + ' → ' + fmtN(t.second) + '</span></button>';
      }).join('') + '</div>';
    var c1 = drawChart($('[data-an-slot="fc-trend"]'), { cats: s.days.map(shortDay), height: 260, split: s.n, band: s.band, aria: 'Daily detections with 7-day prediction',
      series: [{ key: 'hist', name: 'Detections / day', c: 1, data: s.hist }, { key: 'pred', name: 'Predicted', c: 3, dash: true, data: s.pred }],
      tip: function (i) { return longDay(s.days[i]); },
      hit: function (k, i) { return k === 'hist' && i < s.n ? spec('an-events', qs({ day: s.days[i] })) : null; } });
    var hrs = Array.from({ length: 24 }, function (_, i) { return pad(i); });
    var c2 = drawChart($('[data-an-slot="fc-hours"]'), { cats: hrs, height: 260, aria: 'Hour-of-day profile',
      series: [{ key: 'obs', name: 'Observed', c: 1, col: true, data: ag.hours.map(N) }, { key: 'exp', name: 'Expected next 24 h', c: 3, dash: true, data: f.next24.map(N) }],
      tip: function (i) { return hrs[i] + ':00'; },
      hit: function (k, i) { return k === 'obs' ? spec('an-events', qs({ from: days[Math.max(0, days.length - 7)], to: days[days.length - 1], hour: i, label: hrs[i] + ':00–' + pad((i + 1) % 24) + ':00 · last 7 days' })) : null; } });
    if (c1) S.charts.push(c1); if (c2) S.charts.push(c2);
  }

  /* ======================================================================
   * REPORTS (#analytics/reports) — M12 UI
   * ==================================================================== */
  var SCOPE = {
    personal: { label: 'Personal', icon: 'user', text: 'Your own attendance, leave and tickets.', tone: 'primary' },
    standard: { label: 'Standard', icon: 'file-text', text: 'Everything your role can read — attendance, tickets, safety, detections, cameras.', tone: 'info' },
    comprehensive: { label: 'Comprehensive', icon: 'sparkles', text: 'Deep synthesis across all sections: trends, root causes and prioritised recommendations.', tone: 'purple' }
  };
  function renderReports(el) {
    var adm = isAdmin();
    el.innerHTML = '<div class="kj-page kj-an" data-an="reports">' +
      '<div class="kj-page-head kj-an-head"><div><h2 class="kj-page-title">Reports</h2><p class="kj-page-sub">AI-written management reports from your plant data — magazine-style, printable and downloadable</p></div>' +
      '<div class="kj-an-controls">' + (adm ? '<label class="kj-an-check"><input type="checkbox" data-an-repall' + (S.repAll ? ' checked' : '') + '><span>All users\' reports</span></label>' : '') +
        '<button type="button" class="kj-btn kj-btn-secondary" data-an-act="reports-refresh">' + ico('refresh-cw') + '<span>Refresh</span></button></div></div>' +
      '<section class="kj-card kj-an-gen-hero"><div class="kj-an-gen-art">' + ico('file-chart-column', 'kj-an-gen-ico') + '</div>' +
        '<div class="kj-an-gen-copy"><h3>Generate a comprehensive report</h3><p>Pick a period and a scope. VisionAI gathers the data your role may see and writes a structured report with key numbers, highlights, risks and recommendations. It takes about a minute.</p>' +
        '<div class="kj-row-wrap">' + Object.keys(SCOPE).filter(function (k) { return scopesFor()[k]; }).map(function (k) {
          return '<span class="kj-chip is-' + SCOPE[k].tone + '">' + ico(SCOPE[k].icon) + esc(SCOPE[k].label) + '</span>'; }).join('') + '</div></div>' +
        '<button type="button" class="kj-btn kj-btn-primary kj-btn-lg" data-kj-modal="' + esc(spec('report-new', '30d')) + '">' + ico('sparkles') + '<span>Generate comprehensive report</span></button></section>' +
      '<div data-an-slot="gen-status"></div>' +
      '<section class="kj-card"><div class="kj-card-head">' + ico('history', 'kj-ico-20') + '<h3 class="kj-card-title">Recent reports</h3></div>' +
        '<div data-an-slot="replist">' + skel('list') + skel('list') + '</div></section></div>';
    var seq = ++S.seq;
    loadReportsInto('[data-an-slot="replist"]', 30, seq, false);
    paintGenStatus();
  }
  function paintGenStatus() {
    var box = $('[data-an-slot="gen-status"]'); if (!box) return;
    var g = S.gen;
    box.innerHTML = g && g.state === 'running' ? '<div class="kj-card kj-an-gen-run">' + lottieSlot('sm') + '<div><b>Generating ' + esc(SCOPE[g.scope].label.toLowerCase()) + ' report…</b>' +
      '<div class="kj-muted">Started ' + esc(when(new Date(g.t0).toISOString())) + ' — it will appear in the list below when ready.</div></div></div>' : '';
    if (g && g.state === 'running') playLottie(box);
  }
  function scopeChip(sc) { var s = SCOPE[sc] || SCOPE.standard; return '<span class="kj-chip is-' + s.tone + '">' + esc(s.label) + '</span>'; }
  function statusChip(st) {
    return st === 'done' ? '<span class="kj-chip is-success kj-chip-dot">Ready</span>' : (st === 'running' ? '<span class="kj-chip is-warn kj-chip-dot">Generating</span>' : '<span class="kj-chip is-danger kj-chip-dot">Failed</span>');
  }
  function loadReportsInto(sel, limit, seq, compact) {
    var params = { limit: limit }; if (!compact && S.repAll && isAdmin()) params.all = 1;
    api('/reports', params).then(function (d) {
      if (!alive(seq)) return;
      var list = d.reports || [];
      S.data.reports = list;
      if (compact) {
        var ready = list.filter(function (r) { return r.status === 'done'; }).length;
        setHtml('[data-an-slot="rep-chip"]', ready ? '<span class="kj-chip is-success">' + ico('circle-check') + 'Ready to download</span>' : '');
      }
      setHtml(sel, list.length ? '<div class="kj-list kj-an-replist' + (compact ? ' is-compact' : '') + '">' + list.map(function (r) { return repRow(r, compact); }).join('') + '</div>'
        : empty({ icon: 'file-text', title: 'No reports yet', text: 'Generate your first AI report — it takes about a minute.', actions: [{ label: 'Generate report', modal: spec('report-new', '30d'), icon: 'sparkles', primary: true }] }));
    }).catch(function (e) {
      if (!alive(seq)) return;
      setHtml(sel, e.status === 401 || e.status === 403
        ? empty({ icon: 'lock', title: 'Reports need a signed-in session', text: 'Sign in again to see and generate reports.' })
        : errBox(e.message, 'reports-refresh'));
    });
  }
  function repRow(r, compact) {
    var id = r.id != null ? r.id : r.report_no, ready = r.status === 'done';
    var meta = [r.report_no, (r.range_from || '') + ' → ' + (r.range_to || ''), when(r.created_at)].concat(!compact && r.user_name ? [r.user_name] : []).filter(Boolean).join(' · ');
    return '<div class="kj-list-item kj-an-rep"' + (ready ? ' data-kj-modal="' + esc(spec('report', id)) + '"' : '') + '>' +
      '<span class="kj-an-rep-ico' + (ready ? '' : ' is-' + (r.status === 'running' ? 'warn' : 'danger')) + '">' + ico(ready ? 'file-chart-column' : (r.status === 'running' ? 'loader' : 'file-x')) + '</span>' +
      '<span class="kj-list-main"><span class="kj-list-title kj-truncate">' + esc(r.title || (r.status === 'failed' ? 'Report failed' : 'Report in progress')) + '</span>' +
      '<span class="kj-list-sub kj-truncate">' + esc(meta) + '</span>' + (!compact && r.status === 'failed' && r.error ? '<span class="kj-list-sub is-bad">' + esc(r.error) + '</span>' : '') + '</span>' +
      (compact ? '' : scopeChip(r.scope) + statusChip(r.status)) +
      (ready ? '<span class="kj-an-rep-acts">' +
        '<button type="button" class="kj-btn kj-btn-soft kj-btn-icon kj-btn-sm" data-an-dl="md" data-an-id="' + esc(id) + '" title="Download .md" aria-label="Download markdown">' + ico('download') + '</button>' +
        (compact ? '' : '<button type="button" class="kj-btn kj-btn-soft kj-btn-icon kj-btn-sm" data-an-dl="html" data-an-id="' + esc(id) + '" title="Download .html" aria-label="Download HTML">' + ico('file-down') + '</button>' +
        '<button type="button" class="kj-btn kj-btn-soft kj-btn-icon kj-btn-sm" data-an-dl="print" data-an-id="' + esc(id) + '" title="Print / save as PDF" aria-label="Print">' + ico('printer') + '</button>') +
        '<button type="button" class="kj-btn kj-btn-soft kj-btn-icon kj-btn-sm" data-an-dl="pdf" data-an-id="' + esc(id) + '" title="Download PDF" aria-label="Download PDF">' + ico('file-text') + '</button>' +
        '</span>' : '') + '</div>';
  }

  /* ── report fetching / magazine rendering ──────────────────────────────── */
  var repCache = {};
  function getReport(id) {
    var k = String(id);
    if (repCache[k] && repCache[k].content) return Promise.resolve(repCache[k]);
    return api('/reports/' + encodeURIComponent(k)).then(function (d) { var r = d.report; if (r) { repCache[k] = r; if (r.id != null) repCache[String(r.id)] = r; if (r.report_no) repCache[r.report_no] = r; } return r; });
  }
  var SEC_ICON = { attendance: 'calendar-check', leave: 'plane', tickets: 'ticket', safety_ppe_forklift: 'hard-hat', detections: 'scan-eye', cameras: 'cctv' };
  function parseMetric(v) {
    var s = String(v == null ? '' : v), m = /-?\d[\d,]*(\.\d+)?/.exec(s);
    if (!m) return null;
    return { n: Number(m[0].replace(/,/g, '')), pct: /%/.test(s) };
  }
  function metricBars(metrics) {
    // Chart from the section's own numbers: percentages → progress meters; ≥3 plain counts → bars.
    var parsed = metrics.map(function (m) { return { m: m, p: parseMetric(m.value) }; }).filter(function (x) { return x.p; });
    var pcts = parsed.filter(function (x) { return x.p.pct && x.p.n >= 0 && x.p.n <= 100; });
    var counts = parsed.filter(function (x) { return !x.p.pct && x.p.n >= 0 && !/[:h]\s*\d|\dh|\dm\b|min|hour|day/i.test(String(x.m.value)); });
    var out = '';
    if (pcts.length) {
      out += '<div class="kj-an-mag-meters">' + pcts.map(function (x) {
        return '<div class="kj-an-mag-meter"><div class="kj-row"><span class="kj-truncate">' + esc(x.m.label) + '</span><span class="kj-spacer"></span><b>' + esc(x.m.value) + '</b></div>' +
          '<div class="kj-progress"><div class="kj-progress-fill kj-w-' + step5(x.p.n) + ' kj-fill-' + (x.p.n >= 90 ? 'success' : (x.p.n >= 70 ? 'warn' : 'danger')) + '"></div></div></div>';
      }).join('') + '</div>';
    }
    if (counts.length >= 3) {
      var mx = Math.max(1, Math.max.apply(null, counts.map(function (x) { return x.p.n; })));
      out += '<svg class="kj-an-mag-bars" viewBox="0 0 400 ' + (counts.length * 26) + '" role="img" aria-label="Section figures">' + counts.map(function (x, i) {
        var w = Math.max(2, 230 * x.p.n / mx);
        return '<text class="kj-an-axis" x="0" y="' + (i * 26 + 15) + '">' + esc(String(x.m.label).slice(0, 26)) + '</text>' +
          '<rect class="kj-an-bar kj-an-f1" x="160" y="' + (i * 26 + 4) + '" width="' + w.toFixed(1) + '" height="14" rx="3"/>' +
          '<text class="kj-an-axis kj-an-axis-b" x="' + (166 + w).toFixed(1) + '" y="' + (i * 26 + 15) + '">' + esc(x.m.value) + '</text>';
      }).join('') + '</svg>';
    }
    return out;
  }
  /** Magazine-style report body. Shared by the modal, print view and .html export. */
  function magazine(rep) {
    var c = rep.content || {}, m = c.meta || {}, per = m.period || rep.range || {};
    var secs = c.sections || [];
    var glance = [];
    secs.forEach(function (s) { (s.metrics || []).slice(0, 1).forEach(function (x) { glance.push({ sec: s, x: x }); }); });
    glance = glance.slice(0, 6);
    return '<article class="kj-an-mag">' +
      '<header class="kj-an-mag-cover"><div class="kj-an-mag-kicker">' + ico('sparkles') + 'VisionAI report · ' + esc(m.report_no || rep.report_no || '') + '</div>' +
        '<h1 class="kj-an-mag-title">' + esc(c.title || rep.title || 'Report') + '</h1>' +
        '<div class="kj-an-mag-meta">' + scopeChip(m.scope || rep.scope) +
          '<span>' + ico('calendar') + esc(longDay(per.from)) + ' → ' + esc(longDay(per.to)) + '</span>' +
          (m.generated_for || rep.generated_by ? '<span>' + ico('user') + esc(m.generated_for || rep.generated_by) + '</span>' : '') +
          '<span>' + ico('clock') + esc(when(m.generated_at || rep.created_at)) + '</span>' +
          (m.model || rep.model ? '<span class="kj-muted">VisionAI engine</span>' : '') + '</div></header>' +
      '<section class="kj-an-mag-lead"><div class="kj-an-mag-label">Executive summary</div><p>' + esc(c.executive_summary || rep.summary || '') + '</p></section>' +
      (glance.length ? '<section class="kj-an-mag-glance"><div class="kj-an-mag-label">At a glance</div><div class="kj-an-mag-stats">' + glance.map(function (g, i) {
        return '<a class="kj-an-mag-stat kj-an-b' + ((i % 5) + 1) + '" href="#an-sec-' + esc(g.sec.key || i) + '"><span class="kj-an-mag-stat-val">' + esc(g.x.value) + '</span>' +
          '<span class="kj-an-mag-stat-lbl">' + esc(g.x.label) + '</span><span class="kj-an-mag-stat-sec">' + esc(g.sec.title || g.sec.key) + '</span></a>';
      }).join('') + '</div></section>' : '') +
      secs.map(function (s, si) {
        var met = s.metrics || [];
        return '<section class="kj-an-mag-sec" id="an-sec-' + esc(s.key || si) + '"><div class="kj-an-mag-sec-head"><span class="kj-an-mag-sec-ico kj-an-b' + ((si % 5) + 1) + '">' + ico(SEC_ICON[s.key] || 'layers') + '</span>' +
          '<div><div class="kj-an-mag-label">Section ' + (si + 1) + '</div><h2>' + esc(s.title || s.key) + '</h2></div></div>' +
          '<div class="kj-an-mag-sec-body"><div class="kj-an-mag-sec-text"><p>' + esc(s.summary || '') + '</p>' +
            ((s.highlights || []).length || (s.risks || []).length ? '<div class="kj-an-mag-hr">' +
              ((s.highlights || []).length ? '<div class="kj-an-mag-col is-good"><div class="kj-an-mag-col-h">' + ico('circle-check') + 'Highlights</div><ul>' + s.highlights.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' : '') +
              ((s.risks || []).length ? '<div class="kj-an-mag-col is-bad"><div class="kj-an-mag-col-h">' + ico('triangle-alert') + 'Risks</div><ul>' + s.risks.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' : '') +
            '</div>' : '') + '</div>' +
          (met.length ? '<aside class="kj-an-mag-figs"><div class="kj-an-mag-callouts">' + met.map(function (x) {
            return '<div class="kj-an-mag-callout"><span class="kj-an-mag-callout-val">' + esc(x.value) + '</span><span class="kj-an-mag-callout-lbl">' + esc(x.label) + '</span></div>'; }).join('') + '</div>' +
            metricBars(met) + '</aside>' : '') +
          '</div></section>';
      }).join('') +
      ((c.recommendations || []).length ? '<section class="kj-an-mag-recs"><div class="kj-an-mag-label">Recommendations</div><ol>' + c.recommendations.map(function (x, i) {
        return '<li><span class="kj-an-mag-num">' + (i + 1) + '</span><span>' + esc(x) + '</span></li>'; }).join('') + '</ol></section>' : '') +
      ((c.data_gaps || []).length ? '<section class="kj-an-mag-gaps"><div class="kj-an-mag-col-h">' + ico('info') + 'Data gaps</div><ul>' + c.data_gaps.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section>' : '') +
      '<footer class="kj-an-mag-foot">Generated by VisionAI from plant data only. Figures not present in the source data are reported as unavailable.</footer>' +
      '</article>';
  }
  function markdown(rep) {
    var c = rep.content || {}, m = c.meta || {}, per = m.period || rep.range || {};
    var md = '# ' + (c.title || rep.title || 'Report') + '\n\n_' + [m.report_no || rep.report_no, (per.from || '') + ' → ' + (per.to || ''), m.scope || rep.scope, (m.model || rep.model) ? 'VisionAI engine' : '', 'generated ' + (m.generated_at || rep.created_at || '')].filter(Boolean).join(' · ') + '_\n\n';
    md += '## Executive summary\n\n' + (c.executive_summary || rep.summary || '') + '\n\n';
    (c.sections || []).forEach(function (s) {
      md += '## ' + (s.title || s.key || '') + '\n\n' + (s.summary || '') + '\n\n';
      if ((s.metrics || []).length) md += '| Metric | Value |\n|---|---|\n' + s.metrics.map(function (x) { return '| ' + String(x.label || '').replace(/\|/g, '/') + ' | ' + String(x.value || '').replace(/\|/g, '/') + ' |'; }).join('\n') + '\n\n';
      [['highlights', 'Highlights'], ['risks', 'Risks']].forEach(function (k) { if ((s[k[0]] || []).length) md += '**' + k[1] + '**\n\n' + s[k[0]].map(function (x) { return '- ' + x; }).join('\n') + '\n\n'; });
    });
    if ((c.recommendations || []).length) md += '## Recommendations\n\n' + c.recommendations.map(function (x, i) { return (i + 1) + '. ' + x; }).join('\n') + '\n\n';
    if ((c.data_gaps || []).length) md += '## Data gaps\n\n' + c.data_gaps.map(function (x) { return '- ' + x; }).join('\n') + '\n';
    return md;
  }
  function saveFile(name, text, type) {
    try {
      var url = URL.createObjectURL(new Blob([text], { type: type }));
      var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 500);
      return true;
    } catch (e) { toast('Download is not available in this browser.', 'warn'); return false; }
  }
  // Standalone .html: the same magazine markup + the app's own stylesheets (fetched, not hand-copied).
  function htmlDoc(rep) {
    var hrefs = ['kj-tokens.css', 'kj-components.css', 'pages/analytics.css'].map(function (f) {
      var l = document.querySelector('link[href*="' + f + '"]'); return l ? l.getAttribute('href') : 'assets/css/' + f;
    });
    return Promise.all(hrefs.map(function (u) { return fetch(u, { cache: 'force-cache' }).then(function (r) { return r.ok ? r.text() : ''; }).catch(function () { return ''; }); }))
      .then(function (css) {
        var title = (rep.content && rep.content.title) || rep.title || 'Report';
        return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<title>' + esc(title) + '</title><style>' + css.join('\n') + '</style></head>' +
          '<body class="kj-root kj-an-export" data-theme="light">' + magazine(rep) + '</body></html>';
      });
  }
  function fileBase(rep) { return (rep.report_no || ('report-' + (rep.id || ''))).replace(/[^\w.-]+/g, '_'); }
  function download(rep, kind) {
    if (kind === 'md') { saveFile(fileBase(rep) + '.md', markdown(rep), 'text/markdown;charset=utf-8'); return Promise.resolve(); }
    if (kind === 'html') return htmlDoc(rep).then(function (h) { saveFile(fileBase(rep) + '.html', h, 'text/html;charset=utf-8'); });
    if (kind === 'print') { printReport(rep); return Promise.resolve(); }
    if (kind === 'pdf') return downloadPdf(rep);
    return Promise.resolve();
  }
  /** Server PDF (GET pdf_url, session cookie); 503 / non-PDF → browser print fallback. */
  function downloadPdf(rep) {
    var url = rep.pdf_url || (rep.download && rep.download.pdf) || ('/api/reports/' + encodeURIComponent(rep.id) + '/pdf');
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      var ct = (r.headers && r.headers.get && r.headers.get('content-type')) || '';
      if (r.ok && ct.indexOf('pdf') >= 0) return r.blob().then(function (b) { saveFile(fileBase(rep) + '.pdf', b, 'application/pdf'); });
      return Promise.resolve(r.json()).catch(function () { return {}; }).then(function (d) {
        if (r.status === 503 || (d && d.fallback === 'print')) { toast('PDF export is unavailable — opening the print view instead.', 'warn'); printReport(rep); return; }
        throw new Error((d && d.error) || 'The PDF could not be downloaded.');
      });
    });
  }
  /**
   * Print = PDF parity: print the server's official template (GET /reports/{id}/print —
   * the same printHtml() that renders the PDF: cover, control page, charts, appendices,
   * sign-off) from a hidden iframe. Falls back to the magazine print when unavailable.
   */
  function printReport(rep) {
    var T = window.TMNS || {};
    var url = rep.print_url || ((T.api || '/api') + '/reports/' + encodeURIComponent(rep.id != null ? rep.id : rep.report_no) + '/print');
    var fallback = function () { printMagazine(rep); };
    if (typeof fetch !== 'function') { fallback(); return; }
    fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
      var ct = (r.headers && r.headers.get && r.headers.get('content-type')) || '';
      if (!r.ok || ct.indexOf('html') < 0) throw new Error('print view unavailable');
      return r.text();
    }).then(function (html) {
      var old = document.getElementById('kj-an-print-frame'); if (old) old.remove();
      var f = document.createElement('iframe');
      f.id = 'kj-an-print-frame'; f.className = 'kj-an-print-frame'; f.setAttribute('aria-hidden', 'true'); f.setAttribute('tabindex', '-1');
      f.onload = function () {
        try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { fallback(); }
        setTimeout(function () { f.remove(); }, 60000);
      };
      document.body.appendChild(f);
      f.srcdoc = html;
    }).catch(fallback);
  }
  function printMagazine(rep) {
    var box = document.getElementById('kj-an-print');
    if (!box) { box = document.createElement('div'); box.id = 'kj-an-print'; box.className = 'kj-root kj-an-print'; document.body.appendChild(box); }
    box.setAttribute('data-theme', 'light');
    box.innerHTML = magazine(rep);
    var root = document.documentElement;
    root.classList.add('kj-an-printing');
    var done = function () { root.classList.remove('kj-an-printing'); box.innerHTML = ''; window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    try { window.print(); } catch (e) { /* not supported (tests) */ }
    setTimeout(function () { if (root.classList.contains('kj-an-printing') && !window.matchMedia) done(); }, 1500);
  }

  /* ── Lottie loading animation (vendored player, lazy-loaded) ───────────── */
  var lottieP = null;
  function loadLottie() {
    if (window.lottie) return Promise.resolve(window.lottie);
    if (lottieP) return lottieP;
    lottieP = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'assets/vendor/lottie/lottie_light.min.js' + (VER ? '?v=' + VER : '');
      s.onload = function () { window.lottie ? res(window.lottie) : rej(new Error('no player')); };
      s.onerror = function () { lottieP = null; rej(new Error('player failed')); };
      document.head.appendChild(s);
    });
    return lottieP;
  }
  function lottieSlot(size) { return '<div class="kj-an-lottie' + (size ? ' is-' + size : '') + '" data-an-lottie><span class="kj-an-spinner"></span></div>'; }
  function playLottie(root) {
    var slot = root && root.querySelector('[data-an-lottie]'); if (!slot) return;
    loadLottie().then(function (L) {
      if (!slot.isConnected || slot._anim) return;
      slot.innerHTML = '';
      slot._anim = L.loadAnimation({ container: slot, renderer: 'svg', loop: true, autoplay: true, path: 'assets/lottie/loading-spinner.json' });
    }).catch(function () { /* keep the CSS spinner */ });
  }

  /* ── report generation (POST /report/generate is synchronous) ──────────── */
  var STAGES = ['Collecting attendance and leave records…', 'Reading ticket SLA performance…', 'Summarising safety detections and PPE reviews…',
    'Checking camera fleet health…', 'Writing the executive summary…', 'Drafting sections and recommendations…', 'Laying out the report…'];
  function generate(range, scope) {
    if (S.gen && S.gen.state === 'running') return S.gen.p;
    var g = { state: 'running', scope: scope, range: range, t0: Date.now(), listeners: [] };
    S.gen = g;
    // Snapshot the newest report id so a timed-out request can be recovered by polling the list.
    var before = soft(api('/reports', { limit: 1 })).then(function (d) { return d && d.reports && d.reports[0] ? N(d.reports[0].id) : 0; });
    g.p = before.then(function (maxId) {
      g.maxId = maxId;
      return api('/report/generate', null, { method: 'POST', body: { range: range, scope: scope } })
        .then(function (d) { return d.report; })
        .catch(function (e) {
          // Gateway timeout / dropped connection: the server keeps going (ignore_user_abort) → poll for it.
          if (e.nojson || !e.status || e.status === 504 || e.status === 524 || e.status === 502 && /HTTP/.test(e.message)) return pollFor(g);
          throw e;
        });
    }).then(function (rep) {
      if (!rep || rep.status === 'failed') throw new Error((rep && rep.error) || 'Report generation failed.');
      if (rep.id != null) repCache[String(rep.id)] = rep;
      g.state = 'done'; g.report = rep; finishGen(g);
      return rep;
    }, function (e) { g.state = 'failed'; g.error = e; finishGen(g); throw e; });
    paintGenStatus();
    return g.p;
  }
  function pollFor(g) {
    return new Promise(function (res, rej) {
      var tries = 0;
      (function tick() {
        if (++tries > 60) { rej(new Error('The report is taking longer than expected. Check Recent reports in a few minutes.')); return; }
        soft(api('/reports', { limit: 5 })).then(function (d) {
          var r = ((d && d.reports) || []).filter(function (x) { return N(x.id) > g.maxId && x.scope === g.scope; })[0];
          if (r && r.status === 'done') { getReport(r.id).then(res, rej); return; }
          if (r && r.status === 'failed') { rej(new Error(r.error || 'Report generation failed.')); return; }
          setTimeout(tick, 6000);
        });
      })();
    });
  }
  function finishGen(g) {
    var shown = false;
    g.listeners.forEach(function (f) { try { shown = f(g) || shown; } catch (e) { /* listener gone */ } });
    g.listeners = [];
    // Nobody is watching the progress modal any more → one toast with the outcome.
    if (!shown) toast(g.state === 'done' ? 'Your report is ready — open it from Analytics → Reports.' : 'Report generation failed: ' + ((g.error && g.error.message) || 'unknown error'), g.state === 'done' ? 'success' : 'danger', 6000);
    if (S.el && (S.sub === 'reports' || S.sub === 'trends')) {
      var seq = S.seq;
      if (S.sub === 'reports') { paintGenStatus(); loadReportsInto('[data-an-slot="replist"]', 30, seq, false); }
      else loadReportsInto('[data-an-slot="reports"]', 5, seq, true);
    }
  }

  /* ── KJModal types ─────────────────────────────────────────────────────── */
  function registerModals() {
    var M = window.KJModal;
    if (!M || M._anReg) return;
    M._anReg = true;

    // Event-list drill-down for any chart element.
    M.register('an-events', {
      kicker: 'Detections', icon: 'list-checks', size: 'lg', skeleton: 'table',
      load: function (ctx) {
        var q = new URLSearchParams(String(ctx.id)), o = {}; q.forEach(function (v, k) { o[k] = v; });
        if (o.pick) {
          return api('/behaviour/heatmap', { days: o.days || 30, module: o.module || '', pick: o.pick, row: o.row, hour: o.hour })
            .then(function (d) { return { o: o, rows: (d.items || []).map(function (i) { return Object.assign({}, i, { ts: i.time }); }), capped: (d.items || []).length >= 60 }; });
        }
        if (o.ppeloc) {
          return api('/ppe/summary', { location: o.ppeloc === '—' ? '' : o.ppeloc, from: o.from || '', to: o.to || '' }).then(function (d) {
            var k = d.kpi || {};
            return { o: o, kpi: k, rows: (d.violations || []).filter(function (v) { return o.ppeloc === '—' || v.location === o.ppeloc; }).map(function (v) {
              var miss = (v.missing || []).map(function (i) { return (d.items && d.items[i]) || i; });
              return { uuid: v.uuid || null, id: v.id, mod: 'ppe', sev: 'high', title: miss.length ? 'Missing ' + miss.join(', ') : 'PPE violation', camera: v.camera, device: v.device, location: v.location, time: v.time, image: v.image, personId: v.personId };
            }) };
          });
        }
        var from, to, days = N(o.days) || 30;
        if (o.day) { from = o.day + ' 00:00:00'; to = o.day + ' 23:59:59'; }
        else { from = (o.from || daysAgo(days - 1)) + ' 00:00:00'; to = (o.to || daysAgo(0)) + ' 23:59:59'; }
        var cams = o.cams ? o.cams.split(',').filter(Boolean).slice(0, 8) : [''];
        return Promise.all(cams.map(function (c) { return api('/events', { stream: c, from: from, to: to, limit: o.cams ? 120 : 500 }); })).then(function (rs) {
          var rows = [].concat.apply([], rs.map(function (d) { return d.events || []; }));
          rows.forEach(function (r) { r.mod = modOf(r); });
          if (o.mod) rows = rows.filter(function (r) { return r.mod === o.mod; });
          if (o.hour != null && o.hour !== '') rows = rows.filter(function (r) { var d = new Date(String(r.received_at || '').replace(' ', 'T')); return !isNaN(d) && d.getHours() === N(o.hour); });
          rows.sort(function (a, b) { return String(b.received_at || '').localeCompare(String(a.received_at || '')); });
          return { o: o, rows: rows, capped: rs.some(function (d) { return (d.events || []).length >= (o.cams ? 120 : 500); }) };
        });
      },
      render: function (ctx, d) {
        var H = M.h, o = d.o, m = MODK[o.mod];
        var title = o.label || (o.ppeloc ? 'PPE · ' + (o.ppeloc === '—' ? 'Unassigned' : o.ppeloc) : ((m ? m.name : 'All detections') + (o.day ? ' · ' + longDay(o.day) : '')));
        var counts = {};
        d.rows.forEach(function (r) { counts[r.mod] = (counts[r.mod] || 0) + 1; });
        var list = d.rows.slice(0, 80).map(function (r) { return H.eventRow(H.normEvent(r)); }).join('');
        var nav = o.ppeloc ? 'detections/ppe' : (m ? m.nav : 'detections');
        var mix = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
        var body = '<div class="kj-row-wrap">' + H.chip(fmtN(d.rows.length) + (d.capped ? '+' : '') + ' detection' + (d.rows.length === 1 ? '' : 's'), 'primary') +
            (o.day ? H.chip(longDay(o.day)) : (o.from ? H.chip(shortDay(o.from) + ' → ' + shortDay(o.to || daysAgo(0))) : '')) +
            (o.ppeloc && d.kpi && d.kpi.compliance != null ? H.chip(d.kpi.compliance + '% compliant', d.kpi.compliance >= 95 ? 'success' : 'warn') : '') + '</div>' +
          (mix.length > 1 ? H.section('By type', H.hbars(mix.map(function (k) { return { label: (MODK[k] || { name: k }).name, n: counts[k], tone: 'muted' }; }))) : '') +
          (list ? H.section('Detections' + (d.rows.length > 80 ? ' (latest 80)' : ''), '<div class="kj-list">' + list + '</div>')
            : H.empty('scan-eye', 'No detections found', 'Nothing matched this slice — the chart may count events from a wider window.'));
        return { title: title, kicker: 'Detections drill-down', icon: m ? m.icon : 'list-checks',
          body: body, foot: '<button type="button" class="kj-btn kj-btn-primary" data-kj-nav="' + esc(nav) + '">' + ico('external-link') + 'Open in Detections</button>' };
      }
    });

    // Magazine-style report view.
    M.register('report', {
      kicker: 'AI report', icon: 'file-chart-column', size: 'lg', skeleton: 'media',
      load: function (ctx) {
        var seed = ctx.data && ctx.data.content ? ctx.data : null;
        return seed ? Promise.resolve(seed) : getReport(ctx.id);
      },
      render: function (ctx, rep) {
        if (!rep) throw new Error('Report not found');
        if (rep.status !== 'done' || !rep.content) {
          return { title: rep.title || rep.report_no || 'Report', kicker: 'AI report', icon: 'file-x', tone: 'warn',
            body: M.h.empty('loader', rep.status === 'running' ? 'Still generating' : 'This report failed', rep.error || 'Try again from the Reports tab.') ,
            foot: '<button type="button" class="kj-btn kj-btn-primary" data-kj-nav="analytics/reports">' + ico('arrow-right') + 'Reports</button>' };
        }
        return {
          title: (rep.content && rep.content.title) || rep.title, kicker: (rep.report_no || 'AI report') + ' · ' + ((SCOPE[rep.scope] || {}).label || ''), icon: 'file-chart-column', tone: 'purple',
          body: magazine(rep),
          foot: M.h.btn('print', 'Print', 'printer') + M.h.btn('pdf', 'Download PDF', 'file-text') + M.h.btn('md', 'Download .md', 'download') + M.h.btn('html', 'Download .html', 'file-down', 'kj-btn-primary'),
          actions: {
            print: function () { printReport(rep); },
            pdf: function () { return downloadPdf(rep).catch(function (e) { toast(e.message || 'Download failed', 'danger'); }); },
            md: function () { download(rep, 'md'); },
            html: function () { download(rep, 'html'); }
          },
          mount: function (c) { c.modal.classList.add('kj-an-repmodal'); }
        };
      }
    });

    // Generator: range + scope → patient progress state → report.
    M.register('report-new', {
      kicker: 'New AI report', icon: 'sparkles', size: 'md', deepLink: false,
      render: function (ctx) {
        var g = S.gen;
        if (g && g.state === 'running') return progressView(ctx, g);
        var allowed = scopesFor(), def = allowed.comprehensive ? 'comprehensive' : (allowed.standard ? 'standard' : 'personal');
        var r0 = /^(today|7d|30d|month)$/.test(String(ctx.id)) ? String(ctx.id) : '30d';
        var ranges = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['month', 'This month'], ['custom', 'Custom']];
        var body = '<form class="kj-an-genform" data-an-genform>' +
          '<div class="kj-an-mag-label">Period</div><div class="kj-an-seg" role="radiogroup" aria-label="Period">' + ranges.map(function (x) {
            return '<label class="kj-an-seg-opt"><input type="radio" name="range" value="' + x[0] + '"' + (x[0] === r0 ? ' checked' : '') + '><span>' + x[1] + '</span></label>'; }).join('') + '</div>' +
          '<div class="kj-grid-2 kj-an-custom" data-an-custom hidden><label class="kj-field"><span class="kj-label">From</span><input class="kj-input" type="date" name="from" max="' + daysAgo(0) + '" value="' + daysAgo(29) + '"></label>' +
            '<label class="kj-field"><span class="kj-label">To</span><input class="kj-input" type="date" name="to" max="' + daysAgo(0) + '" value="' + daysAgo(0) + '"></label>' +
            '<span class="kj-help">Up to 92 days, not in the future.</span></div>' +
          '<div class="kj-an-mag-label">Scope</div><div class="kj-an-scopes">' + Object.keys(SCOPE).map(function (k) {
            var s = SCOPE[k], ok = allowed[k];
            var why = ok ? '' : (k === 'comprehensive' && tier() !== 'staff' ? 'Needs the reports permission' : 'Supervisors and admins');
            return '<label class="kj-an-scope' + (ok ? '' : ' is-disabled') + '"><input type="radio" name="scope" value="' + k + '"' + (k === def ? ' checked' : '') + (ok ? '' : ' disabled') + '>' +
              '<span class="kj-an-scope-ico is-' + s.tone + '">' + ico(s.icon) + '</span><span class="kj-an-scope-txt"><b>' + esc(s.label) + '</b><span>' + esc(s.text) + '</span>' +
              (why ? '<span class="kj-an-scope-why">' + ico('lock') + esc(why) + '</span>' : '') + '</span></label>';
          }).join('') + '</div>' +
          '<p class="kj-help kj-an-genhelp">' + ico('clock') + 'Generation usually takes 30–60 seconds (comprehensive can take a few minutes). You can close this window — the report keeps generating and lands in Recent reports.</p></form>';
        return {
          title: 'Generate comprehensive report', kicker: 'New AI report', icon: 'sparkles', tone: 'purple', body: body,
          foot: '<button type="button" class="kj-btn kj-btn-secondary" data-kj-close>Cancel</button>' + M.h.btn('go', 'Generate report', 'sparkles', 'kj-btn-primary'),
          actions: {
            go: function (c) {
              var f = c.body.querySelector('[data-an-genform]'); if (!f) return;
              var rv = (f.querySelector('input[name="range"]:checked') || {}).value || '30d', sc = (f.querySelector('input[name="scope"]:checked') || {}).value || def;
              var range = rv;
              if (rv === 'custom') {
                var fr = f.querySelector('input[name="from"]').value, to = f.querySelector('input[name="to"]').value;
                if (!fr || !to) { toast('Pick both dates for a custom period.', 'warn'); return; }
                if (fr > to) { var t = fr; fr = to; to = t; }
                if ((new Date(to) - new Date(fr)) / 86400000 > 91) { toast('Custom periods are limited to 92 days.', 'warn'); return; }
                range = { from: fr, to: to };
              }
              generate(range, sc).catch(function () { /* shown by the progress view / toast */ });
              c.reload();
            }
          },
          mount: function (c) {
            var f = c.body.querySelector('[data-an-genform]'); if (!f) return;
            var sync = function () { var cu = f.querySelector('[data-an-custom]'), v = (f.querySelector('input[name="range"]:checked') || {}).value; if (cu) cu.hidden = v !== 'custom'; };
            f.addEventListener('change', sync); f.addEventListener('submit', function (e) { e.preventDefault(); }); sync();
          }
        };
      }
    });
    function progressView(ctx, g) {
      var expect = g.scope === 'comprehensive' ? 150 : 50;
      var body = '<div class="kj-an-progress">' + lottieSlot() + '<h3>Writing your ' + esc(SCOPE[g.scope].label.toLowerCase()) + ' report</h3>' +
        '<p class="kj-an-stage" data-an-stage>' + esc(STAGES[0]) + '</p>' +
        '<div class="kj-progress kj-an-progress-bar"><div class="kj-progress-fill kj-w-5" data-an-bar></div></div>' +
        '<div class="kj-muted"><span data-an-elapsed>0:00</span> elapsed · usually ' + (g.scope === 'comprehensive' ? '1–3 minutes' : '30–60 seconds') + '</div>' +
        '<p class="kj-help">You can close this window — the report keeps generating and appears in Recent reports.</p></div>';
      return {
        title: 'Generating report…', kicker: 'New AI report', icon: 'sparkles', tone: 'purple', body: body,
        foot: '<button type="button" class="kj-btn kj-btn-secondary" data-kj-close>Close — keep generating</button>',
        mount: function (c) {
          playLottie(c.body);
          var tick = setInterval(function () {
            if (!c.body.isConnected) { clearInterval(tick); return; }
            var s = Math.round((Date.now() - g.t0) / 1000);
            var el = c.body.querySelector('[data-an-elapsed]'); if (el) el.textContent = Math.floor(s / 60) + ':' + pad(s % 60);
            var bar = c.body.querySelector('[data-an-bar]'); if (bar) bar.className = 'kj-progress-fill kj-w-' + step5(95 * (1 - Math.exp(-s / (expect * 0.6))));
            var st = c.body.querySelector('[data-an-stage]'); if (st) st.textContent = STAGES[Math.min(STAGES.length - 1, Math.floor(s / Math.max(4, expect / STAGES.length)))];
          }, 1000);
          g.listeners.push(function (gg) {
            clearInterval(tick);
            if (!c.body.isConnected || !c.el.classList.contains('is-open')) return false;
            if (gg.state === 'done') { c.close(); M.open('report', gg.report.id != null ? gg.report.id : gg.report.report_no, gg.report); }
            else failView(c, gg);
            return true;
          });
        }
      };
    }
    function failView(c, g) {
      var e = g.error || {}, msg = e.message || 'Report generation failed.';
      c.title.textContent = 'Report not generated';
      c.body.innerHTML = '<div class="kj-an-progress"><div class="kj-empty is-error"><div class="kj-empty-ico">' + ico(e.status === 429 ? 'timer' : 'circle-alert') + '</div>' +
        '<div class="kj-empty-title">' + esc(e.status === 429 ? 'Hourly report limit reached' : (e.status === 403 ? 'Not allowed for your role' : (e.status === 503 ? 'AI features are switched off' : 'Something went wrong'))) + '</div>' +
        '<div class="kj-empty-text">' + esc(msg) + '</div></div></div>';
      c.foot.innerHTML = '<button type="button" class="kj-btn kj-btn-secondary" data-kj-close>Close</button>' + M.h.btn('again', 'Try again', 'refresh-cw', 'kj-btn-primary');
      c.actions = { again: function (cc) { S.gen = null; cc.reload(); } };
    }
  }
  if (window.KJModal) registerModals();
  else document.addEventListener('DOMContentLoaded', registerModals);

  /* ── page-host event delegation (controls; navigation/modals are global) ── */
  function onClick(ev) {
    var t = ev.target instanceof Element ? ev.target : null; if (!t || !S.el) return;
    var b = t.closest('[data-an-hm]');
    if (b) { S.hmView = b.getAttribute('data-an-hm'); S.el.querySelectorAll('[data-an-hm]').forEach(function (x) { var on = x === b; x.classList.toggle('is-active', on); x.setAttribute('aria-selected', String(on)); }); paintHeat(S.data.hm); return; }
    b = t.closest('[data-an-fcdays]');
    if (b) { S.fcDays = N(b.getAttribute('data-an-fcdays')) || 14; renderForecast(S.el); return; }
    b = t.closest('[data-an-dl]');
    if (b) {
      ev.preventDefault(); ev.stopPropagation();
      var kind = b.getAttribute('data-an-dl');
      b.disabled = true;
      getReport(b.getAttribute('data-an-id')).then(function (rep) { if (!rep || !rep.content) throw new Error('Report content is not available.'); return download(rep, kind); })
        .catch(function (e) { toast(e.message || 'Download failed', 'danger'); })
        .then(function () { b.disabled = false; });
      return;
    }
    b = t.closest('[data-an-act]');
    if (b) {
      var a = b.getAttribute('data-an-act');
      if (a === 'reports-refresh') { if (S.sub === 'reports') renderReports(S.el); else loadReportsInto('[data-an-slot="reports"]', 5, S.seq, true); }
      else if (a === 'reload') { mountSub(S.el, S.sub); }
    }
  }
  function onChange(ev) {
    var t = ev.target; if (!t || !S.el) return;
    if (t.matches('[data-an-range]')) { S.range = N(t.value) || 30; renderTrends(S.el); }
    else if (t.matches('[data-an-hmmod]')) {
      S.hmMod = t.value; var seq = S.seq;
      setHtml('[data-an-slot="heat"]', skel('chart'));
      api('/behaviour/heatmap', { days: S.range, module: S.hmMod }).then(function (hm) { if (alive(seq)) { S.data.hm = hm; paintHeat(hm); } })
        .catch(function (e) { if (alive(seq)) setHtml('[data-an-slot="heat"]', errBox(e.message)); });
    } else if (t.matches('[data-an-repall]')) { S.repAll = !!t.checked; renderReports(S.el); }
  }
  function mountSub(el, sub) {
    destroyCharts(S.charts); S.charts = []; S.data = {};
    if (sub === 'forecast') renderForecast(el);
    else if (sub === 'reports') renderReports(el);
    else renderTrends(el);
  }

  window.KJPages.register('analytics', {
    title: 'Analytics',
    perm: 'view',
    defaultSub: 'trends',
    subs: {
      trends:   { label: 'Trends', icon: 'chart-line', aliases: ['analytics'] },
      forecast: { label: 'Forecast', icon: 'sparkles', aliases: ['forecast'] },
      reports:  { label: 'Reports', icon: 'file-chart-column', aliases: ['reports'] }
    },

    mount: function (el, route) {
      ensureCss(); registerModals();
      S.el = el; S.sub = route.sub;
      if (!el._anWired) { el._anWired = true; el.addEventListener('click', onClick); el.addEventListener('change', onChange); }
      mountSub(el, route.sub);
    },
    unmount: function (el) {
      S.seq++; destroyCharts(S.charts); S.charts = []; S.el = null; S.sub = ''; S.data = {};
      if (el && el._anWired) { el.removeEventListener('click', onClick); el.removeEventListener('change', onChange); el._anWired = false; }
    },
    onFeed: function () {
      if (!S.el || S.sub !== 'trends') return;
      var sig = kpiSig();
      if (sig !== S._kpiSig) paintKpis();
    },
    // Test/automation hooks (not app methods).
    _anState: function () { return S; },
    _anMagazine: function (rep) { return magazine(rep); },
    _anMarkdown: function (rep) { return markdown(rep); },

    // ── Legacy Component methods (verbatim from app.js; `this` is the dc app) ──
    // Kept: the legacy analytics/forecast template sections (until the cleanup PR)
    // and the hidden AI-performance page still bind to them.
    methods: class {
  setRange(r){
    this.setState({aRange:r});
    const days={'7d':7,'30d':30}[r];
    if(!days){ this.setState({aRangeD:null, aRangeBusy:false}); return; }
    this.setState({aRangeBusy:true});
    const seq=(this._arSeq=(this._arSeq||0)+1);
    const one=(mod)=>fetch(`${this.API}/behaviour/heatmap?days=${days}&module=${mod}&token=${this.TOK}`, {cache:'no-store'})
      .then(x=>x.json()).then(d=>{ const hours=Array(24).fill(0);
        ((d&&d.cam)||[]).forEach(c=>(c.cells||[]).forEach((n,h)=>{ if(h<24) hours[h]+=Number(n)||0; }));
        return {mod, total:Number(d&&d.total)||0, hours}; });
    Promise.all(['fire','ppe','intr','face'].map(one))
      .then(rs=>{ if(seq!==this._arSeq) return; const byMod={}, hourly=Array.from({length:24},()=>({fire:0,ppe:0,intr:0,face:0}));
        rs.forEach(r=>{ byMod[r.mod]=r.total; r.hours.forEach((n,h)=>{ hourly[h][r.mod]=n; }); });
        this.setState({aRangeD:{days, byMod, hourly}, aRangeBusy:false}); })
      .catch(()=>{ if(seq===this._arSeq) this.setState({aRangeD:null, aRangeBusy:false}); });
  }
  // Analytics → incident heatmap (/api/behaviour/heatmap)
  loadHm(pick){
    const f=this.state.hmF, seq=(this._hmSeq=(this._hmSeq||0)+1);
    const qs=new URLSearchParams({token:this.TOK, days:String(f.days||7), module:f.module||'', sev:f.sev||''});
    if(pick){ qs.set('pick', pick.type); qs.set('row', pick.row); qs.set('hour', String(pick.hour)); }
    this.setState(st=>({hmF:{...st.hmF, busy:true, err:''}}));
    fetch(`${this.API}/behaviour/heatmap?${qs}`, {cache:'no-store'})
      .then(x=>x.json())
      .then(d=>{ if(seq!==this._hmSeq) return; if(!(d&&d.ok)) throw new Error('bad');
        this.setState(st=>({hmD:d, hmItems:pick?(d.items||[]):null, hmPick:pick||null, hmF:{...st.hmF, busy:false}})); })
      .catch(()=>{ if(seq===this._hmSeq) this.setState(st=>({hmF:{...st.hmF, busy:false, err:'Could not load the heatmap'}})); });
  }
  setHmF(patch){ this.setState(st=>({hmF:{...st.hmF, ...patch}, hmPick:null, hmItems:null})); setTimeout(()=>this.loadHm(), 0); }
  pickHm(type, row, hour, label){ const p=this.state.hmPick;
    if(p && p.type===type && p.row===row && p.hour===hour){ this.setState({hmPick:null, hmItems:null}); return; }
    this.loadHm({type, row, hour, label}); }
  // ── Forecast page (via /api/forecast) ─────────────────────
  loadForecast(){
    if(this.state.fcBusy) return;
    this.setState({fcBusy:true});
    fetch(`${this.API}/forecast?token=${this.TOK}&days=${this.state.fcDays||14}`, {cache:'no-store'})
      .then(r=>r.json()).then(d=>{ this.setState({fcBusy:false, fcData:(d&&d.ok)?d:null}); this.scheduleFcCharts(); })
      .catch(()=>this.setState({fcBusy:false})); }
  setFcDays(n){ this.setState({fcDays:n, fcData:null}); setTimeout(()=>this.loadForecast(), 0); }
  scheduleFcCharts(){ if(this._fcT) clearTimeout(this._fcT); this._fcT=setTimeout(()=>this.drawFcCharts(), 90); }
  drawFcCharts(){
    if(this.state.page!=='forecast' || !window.Highcharts) return;
    const fd=this.state.fcData; if(!fd||!fd.forecast) return;
    const f=fd.forecast, ag=fd.agg;
    const dark=this.state.theme==='dark';
    const BLUE=dark?'#3987e5':'#2a78d6', ORANGE=dark?'#d95926':'#eb6834';
    const host=document.querySelector('[data-theme]')||document.documentElement;
    const css=getComputedStyle(host);
    const cv=(n,fb)=>((css.getPropertyValue(n)||'').trim()||fb);
    const text=cv('--text','#E9ECF6'), text2=cv('--text2','#9AA1BD'), muted=cv('--text3','#616989'), line=cv('--line','#232847');
    const base={
      chart:{backgroundColor:'transparent', style:{fontFamily:"'IBM Plex Sans',system-ui,sans-serif"}, spacing:[8,4,4,4]},
      title:{text:undefined}, credits:{enabled:false}, exporting:{enabled:false},
      legend:{itemStyle:{color:text2, fontSize:'10.5px'}, itemHoverStyle:{color:text}},
      xAxis:{labels:{style:{color:muted, fontSize:'10px'}}, lineColor:line, tickColor:line},
      yAxis:{title:{text:null}, labels:{style:{color:muted, fontSize:'10px'}}, gridLineColor:line, allowDecimals:false},
      tooltip:{backgroundColor:dark?'#1A1F3D':'#ffffff', borderColor:line, style:{color:text}, shared:true},
    };
    this._hc=this._hc||{};
    const mk=(id,cfg)=>{ const el=document.getElementById(id); if(!el) return;
      if(this._hc[id]){ try{ this._hc[id].destroy(); }catch(e){} }
      this._hc[id]=Highcharts.chart(el, Highcharts.merge({}, base, cfg)); };
    // Daily history + dashed 7-day prediction (forecast band shaded).
    const histDays=ag.daily.map(d=>d.day.slice(5));
    const predDays=f.next7.map(d=>d.day.slice(5));
    const histData=ag.daily.map(d=>d.total);
    const n=histData.length;
    const histSeries=histData.concat(new Array(predDays.length).fill(null));
    const predSeries=new Array(Math.max(0,n-1)).fill(null).concat([histData[n-1]]).concat(f.next7.map(d=>d.predicted));
    mk('fcTrend',{chart:{type:'spline', height:250},
      xAxis:{categories:histDays.concat(predDays), tickInterval:Math.max(1, Math.floor((n+7)/10)),
        plotBands:[{from:n-0.5, to:n+6.5, color:dark?'rgba(217,89,38,.07)':'rgba(235,104,52,.07)',
          label:{text:'FORECAST', style:{color:muted, fontSize:'9px', fontWeight:'700'}}}]},
      plotOptions:{spline:{marker:{enabled:false}, lineWidth:2}},
      series:[{name:'Detections / day', data:histSeries, color:BLUE},
              {name:'Predicted', data:predSeries, color:ORANGE, dashStyle:'Dash'}]});
    // Hour-of-day profile + expected next 24h.
    const hrs=[...Array(24)].map((_,i)=>String(i).padStart(2,'0'));
    mk('fcHours',{chart:{height:250}, xAxis:{categories:hrs, tickInterval:3},
      plotOptions:{column:{borderWidth:0, borderRadius:3}},
      series:[{type:'column', name:'Observed (window)', data:ag.hours, color:BLUE},
              {type:'spline', name:'Expected next 24h', data:f.next24, color:ORANGE, dashStyle:'Dash', marker:{enabled:false}, lineWidth:2}]});
  }
  // ── AI Performance page (/api/aiperf/*) ──
  aipQs(extra){ const f=this.state.aipF;
    return new URLSearchParams({token:this.TOK, from:f.from||'', to:f.to||'', module:f.module||'', camera:f.camera||'', plant:f.plant||'', ...(extra||{})}); }
  loadAip(){
    this.setState(st=>({aipF:{...st.aipF, busy:true, err:''}}));
    fetch(`${this.API}/aiperf/summary?${this.aipQs()}`, {cache:'no-store'}).then(r=>r.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error((d&&d.error)||'bad'); this.setState(st=>({aipD:d, aipF:{...st.aipF, busy:false}})); })
      .catch(e=>this.setState(st=>({aipF:{...st.aipF, busy:false, err:'Could not load AI performance data'+(e&&e.message&&e.message!=='bad'?' — '+e.message:'')}})));
  }
  setAipF(patch){ this.setState(st=>({aipF:{...st.aipF, ...patch}})); if(this._aipT) clearTimeout(this._aipT); this._aipT=setTimeout(()=>this.loadAip(), 0); }
  exportAip(kind){ window.open(`${this.API}/aiperf/${kind}?${this.aipQs()}`, '_blank'); }
  aipVerify(item, verdict){
    this.setState({aipMsg:'Saving…'});
    this.wsdPost('/aiperf/verify', {uuid:item.uuid, verdict})
      .then(()=>{ this.setState({aipMsg:verdict==='correct'?'Recorded as correct (TP) ✓':'Recorded as false alarm (FP) ✓'}); this.loadAip(); })
      .catch(e=>this.setState({aipMsg:'✗ '+e.message}));
  }
  aipSetMiss(patch){ this.setState(st=>({aipMiss:{...st.aipMiss, ...patch}})); }
  aipLogMiss(){
    const m=this.state.aipMiss;
    if(!m.camera){ this.setState({aipMsg:'✗ Pick the camera where the detection was missed'}); return; }
    this.setState({aipMsg:'Logging missed detection…'});
    this.wsdPost('/aiperf/missed', {module:m.module, camera:m.camera, time:m.time||'', note:m.note||''})
      .then(()=>{ this.setState(st=>({aipMsg:'Missed detection logged (FN) ✓', aipMiss:{...st.aipMiss, note:'', time:''}})); this.loadAip(); })
      .catch(e=>this.setState({aipMsg:'✗ '+e.message}));
  }
  aipDelMiss(m){
    if(!window.confirm('Remove this missed-detection record?\n\n'+(m.label||'')+' · '+(m.cameraName||'')+' · '+(m.time||''))) return;
    this.wsdPost('/aiperf/missed', {delete:m.id}).then(()=>{ this.setState({aipMsg:'Removed ✓'}); this.loadAip(); })
      .catch(e=>this.setState({aipMsg:'✗ '+e.message}));
  }
    }
  });
})();
