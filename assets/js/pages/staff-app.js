/* Staff app - page module (assets/js/pages/staff-app.js).
 * Owner: wave-2 M4 staff mobile app (+ M6 leave UI for #app-leave).
 * Routes: #app-home | #app-attendance | #app-leave | #app-profile (shell: 'staff').
 * Mockups: docs/mockup-ui/generated/staff-mobile-{home,attendance,leave,profile}.png
 * Styles: assets/css/pages/staff-app.css (injected below; .kj-sa-*), shell chrome in kj-shell.css.
 *
 * Data (docs/plan/LEAVE_WORKFLOW.md + api/index.php):
 *   GET  /profile | POST /profile | POST /profile/photo
 *   GET  /attendance/daily?date=&q=          today's status (own row by person_id)
 *   GET  /attendance/month?month=YYYY-MM                 month log (JSON, own linked employee)
 *   GET  /attendance/export?report=range&from=&to=&q=   fallback month log (CSV, own rows by staff id)
 *   GET  /overtime/mine?month=YYYY-MM                    own overtime for the month + approval status + rule
 *   GET  /leaves[?year=&status=&from=&to=]   own requests + balances | POST /leaves | GET /leaves/types
 *   GET  /leaves/{id} | POST /leaves/{id}/cancel|approve|reject | POST /leaves/{id}/attachments
 *   GET  /notifications[?all=1] | GET /notifications/count | POST /notifications/read
 *   GET  /tickets?mine=1                    own tickets (rows open the shared `ticket` modal)
 *
 * KJModal types registered here: leave (override: richer M6 view + cancel/approve/reject + MC upload),
 *   staff-leave-apply, staff-notifs, staff-day, staff-tickets, staff-profile-edit, staff-info, staff-logout.
 * The notification bell is rendered + polled by KJShell (kj-shell.js) in the staff app bar; its
 * click opens this module's 'staff-notifs' modal. Legacy self-injection only without KJShell.bell.
 */
(function () {
  'use strict';

  /* -- basics  */
  function P() { return window.KJPages; }
  function esc(v) { return P().h.esc(v); }
  function ico(n, c) { return P().h.ico(n, c); }
  function M() { return window.KJModal || null; }
  function toast(msg, tone) { if (M()) M().toast(msg, tone); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayYmd() { return ymd(new Date()); }
  function parseYmd(s) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
  function isWeekend(d) { var w = d.getDay(); return w === 0 || w === 6; }
  function fmtDay(s) { var d = parseYmd(s); return d ? d.getDate() + ' ' + d.toLocaleDateString('en-GB', { month: 'short' }) + ', ' + d.toLocaleDateString('en-GB', { weekday: 'short' }) : '\u2014'; }
  function fmtDate(s) { var d = parseYmd(s); return d ? pad(d.getDate()) + ' ' + d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '\u2014'; }
  function fmtRange(a, b) {
    var x = parseYmd(a), y = parseYmd(b || a);
    if (!x) return '\u2014';
    if (!y || ymd(x) === ymd(y)) return fmtDate(a);
    var mon = function (d) { return d.toLocaleDateString('en-GB', { month: 'short' }); };
    if (x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth()) return x.getDate() + ' \u2013 ' + y.getDate() + ' ' + mon(y) + ' ' + y.getFullYear();
    if (x.getFullYear() === y.getFullYear()) return x.getDate() + ' ' + mon(x) + ' \u2013 ' + y.getDate() + ' ' + mon(y) + ' ' + y.getFullYear();
    return fmtDate(a) + ' \u2013 ' + fmtDate(b);
  }
  function hm(v) { var m = /(\d{2}):(\d{2})/.exec(String(v || '').slice(10) || ''); if (!m) m = /^(\d{1,2}):(\d{2})/.exec(String(v || '')); return m ? pad(m[1]) + ':' + m[2] : ''; }
  function fmtHours(h) { var n = parseFloat(h); if (!isFinite(n) || n <= 0) return '\u2014'; var mins = Math.round(n * 60); return Math.floor(mins / 60) + 'h ' + pad(mins % 60) + 'm'; }
  function fmtStamp(v) { if (!v) return ''; var d = new Date(String(v).replace(' ', 'T')); if (isNaN(d)) return String(v); return fmtDate(ymd(d)) + ' \u00b7 ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function ago(v) {
    var d = new Date(String(v || '').replace(' ', 'T')); if (isNaN(d)) return '';
    var m = Math.round((Date.now() - d.getTime()) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60); if (h < 24) return h + ' h ago';
    var dd = Math.round(h / 24); return dd < 7 ? dd + ' d ago' : fmtDate(ymd(d));
  }
  function days(n) { n = Number(n) || 0; return (n % 1 ? n.toFixed(1) : n) + (n === 1 ? ' day' : ' days'); }
  function initials(name) { return String(name || '?').trim().split(/\s+/).slice(0, 2).map(function (p) { return p.charAt(0).toUpperCase(); }).join('') || '?'; }
  function workingDays(a, b) {
    var x = parseYmd(a), y = parseYmd(b || a), n = 0;
    if (!x || !y || y < x) return 0;
    for (var d = x; d <= y; d = addDays(d, 1)) if (!isWeekend(d)) n++;
    return n;
  }
  function store(k, v) {
    try { if (v === undefined) return window.localStorage.getItem(k); window.localStorage.setItem(k, v); } catch (e) { /* private mode */ }
    return null;
  }
  function notifyOn() { return store('kj.staff.notify') !== 'off'; }
  function reduced() { try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; } }

  /* -- own stylesheet + asset versioning (index.php stamps ?v= on our <script>) -- */
  function assetVer() {
    var s = document.querySelector('script[src*="pages/staff-app.js"]');
    var m = s && /\?v=([^&"]+)/.exec(s.getAttribute('src') || '');
    return m ? '?v=' + m[1] : '';
  }
  (function ensureCss() {
    if (document.querySelector('link[data-kj-sa-css]')) return;
    var l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'assets/css/pages/staff-app.css' + assetVer();
    l.setAttribute('data-kj-sa-css', '');
    (document.head || document.documentElement).appendChild(l);
  })();

  /* -- API  */
  function apiUrl(path, params) {
    var base = (window.TMNS && window.TMNS.api) || '/api';
    var q = new URLSearchParams();
    Object.keys(params || {}).forEach(function (k) { if (params[k] != null && params[k] !== '') q.set(k, params[k]); });
    var tok = (window.TMNS && window.TMNS.token) || '';
    if (tok) q.set('token', tok);
    var s = q.toString();
    return base + path + (s ? '?' + s : '');
  }
  function req(method, path, params, body, asText) {
    var o = { method: method, credentials: 'same-origin', cache: 'no-store', headers: { Accept: asText ? 'text/csv' : 'application/json' } };
    if (typeof FormData !== 'undefined' && body instanceof FormData) o.body = body;
    else if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return Promise.resolve().then(function () { return fetch(apiUrl(path, params), o); }).then(function (r) {
      var read = r.text ? r.text() : r.json().then(function (j) { return JSON.stringify(j); });
      return read.then(function (t) {
        var d = null;
        if (asText) {
          if (r.ok && !/^\s*\{/.test(t)) return t;
          try { d = JSON.parse(t); } catch (e) { d = null; }
        } else {
          try { d = t ? JSON.parse(t) : null; } catch (e) { d = null; }
        }
        if (!r.ok || !d || d.ok === false || asText) {
          var err = new Error((d && (d.error || d.message)) || ('Request failed (' + (r.status || 'network') + ')'));
          err.status = r.status; err.data = d;
          throw err;
        }
        return d;
      });
    });
  }
  function soft(p) { return p.catch(function () { return null; }); }

  /* -- state + data cache  */
  var S = {
    el: null, sub: '', seq: 0, clock: null, poll: null, unread: -1,
    profile: null, profileP: null,
    todayP: null, todayAt: 0,
    month: '', att: {},
    leaves: {}, leaveYear: new Date().getFullYear(), leaveTab: 'pending',
    logAll: false, attFilter: '', types: null
  };
  function me() {
    var u = P().me() || {}, p = S.profile || {};
    return {
      name: p.display_name || u.name || p.username || 'there', username: p.username || u.username || '', role: p.role || u.role || '',
      email: p.email || '', phone: p.phone || '', photo: p.photo_url || '', ec: p.emergency_contact || {}, emp: p.employee || null
    };
  }
  function firstName() { return String(me().name).trim().split(/\s+/)[0]; }

  function getProfile(force) {
    if (!force && S.profileP) return S.profileP;
    S.profileP = req('GET', '/profile').then(function (d) { S.profile = d.profile || null; syncShellAvatar(); return S.profile; });
    S.profileP.catch(function () { S.profileP = null; });
    return S.profileP;
  }
  function getToday(force) {
    if (!force && S.todayP && Date.now() - S.todayAt < 60000) return S.todayP;
    S.todayAt = Date.now();
    S.todayP = getProfile().then(function (p) {
      var emp = p && p.employee;
      if (!emp) return { linked: false, shifts: [] };
      return req('GET', '/attendance/daily', { date: todayYmd(), q: emp.staff_id || emp.name }).then(function (d) {
        var row = (d.rows || []).filter(function (r) { return String(r.personId) === String(emp.person_id); })[0] || null;
        return { linked: true, emp: emp, row: row, shifts: d.shifts || [] };
      });
    });
    S.todayP.catch(function () { S.todayP = null; });
    return S.todayP;
  }
  function getLeaves(year, force) {
    year = year || new Date().getFullYear();
    var c = S.leaves[year];
    if (!force && c && Date.now() - c.at < 30000) return c.p;
    var p = req('GET', '/leaves', { year: year, limit: 200 });
    S.leaves[year] = { at: Date.now(), p: p };
    p.catch(function () { delete S.leaves[year]; });
    return p;
  }
  function getTypes() {
    if (S.types) return S.types;
    S.types = req('GET', '/leaves/types').then(function (d) { return d.types || []; });
    S.types.catch(function () { S.types = null; });
    return S.types;
  }
  function leavesChanged() {
    S.leaves = {}; S.att = {};
    if (S.el && (S.sub === 'leave' || S.sub === 'attendance' || S.sub === 'home')) paint();
  }

  /* CSV (attendance range export) -> rows */
  function parseCsv(t) {
    t = String(t || '').replace(/^\ufeff/, '');
    var rows = [], row = [], f = '', q = false;
    for (var i = 0; i < t.length; i++) {
      var c = t[i];
      if (q) {
        if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && t[i + 1] === '\n') i++;
        row.push(f); f = ''; rows.push(row); row = [];
      } else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(function (r) { return r.length > 1; });
  }
  var CSV_STATUS = { 'Present': 'present', 'Late': 'late', 'Absent': 'absent', 'Not yet in': 'pending', 'Off day': 'off' };
  var FLAG_TXT = { missing_out: 'Missing clock-out', early_out: 'Early clock-out', off_day: 'Worked on off day' };
  /* GET /attendance/month day -> the same row shape the CSV path produces (HH:MM times, text flags). */
  function monthDayRow(r) {
    var hm = function (t) { return t ? String(t).slice(11, 16) : ''; };
    return { date: r.date, shift: (r.shift || '') + ' ' + (r.shiftStart || '') + '–' + (r.shiftEnd || ''),
      clockIn: hm(r.clockIn), inLoc: r.clockInLoc || '', clockOut: hm(r.clockOut), outLoc: r.clockOutLoc || '',
      hours: r.hours == null ? '' : String(r.hours), status: r.status, lateMin: +r.lateMin || 0,
      flags: (r.flags || []).map(function (f) { return FLAG_TXT[f] || f; }).join('; '), plants: (r.plants || []).join(' → ') };
  }
  function getMonth(ym, force) {
    var now = new Date(), cur = ym === ymd(now).slice(0, 7);
    var c = S.att[ym];
    if (!force && c && (!cur || Date.now() - c.at < 60000)) return c.p;
    var p = getProfile().then(function (pr) {
      var emp = pr && pr.employee;
      var y = +ym.slice(0, 4), m = +ym.slice(5, 7);
      var from = ym + '-01', last = ymd(new Date(y, m, 0));
      var to = last < todayYmd() ? last : todayYmd();
      var lv = soft(req('GET', '/leaves', { status: 'approved', from: from, to: last, limit: 100 }));
      if (!emp || from > todayYmd()) return lv.then(function (l) { return build(emp, [], l); });
      var key = String(emp.staff_id || '').trim();
      // Primary: GET /attendance/month (own linked employee, JSON). Silent fallback: parse the range CSV.
      var viaCsv = function () {
        return req('GET', '/attendance/export', { report: 'range', from: from, to: to, q: key || emp.name }, undefined, true).then(function (t) {
          return parseCsv(t).slice(1).filter(function (r) { return key ? r[1] === key : r[2] === emp.name; }).map(function (r) {
            return { date: r[0], shift: r[5], clockIn: r[6], inLoc: r[7], clockOut: r[8], outLoc: r[9], hours: r[10],
              status: CSV_STATUS[r[11]] || String(r[11] || '').toLowerCase(), lateMin: +r[12] || 0, flags: r[13], plants: r[14] };
          });
        });
      };
      var rowsP = req('GET', '/attendance/month', { month: ym }).then(function (d) {
        if (!d || !Array.isArray(d.days)) throw new Error('shape');
        return d.days.map(monthDayRow);
      }).catch(viaCsv);
      return Promise.all([rowsP, lv]).then(function (x) {
        return build(emp, x[0], x[1]);
      });
      function build(e, rows, l) {
        var byDate = {};
        rows.forEach(function (r) { byDate[r.date] = r; });
        ((l && l.leaves) || []).forEach(function (L) {
          for (var d = parseYmd(L.start_date), end = parseYmd(L.end_date); d && end && d <= end; d = addDays(d, 1)) {
            var k = ymd(d);
            if (k.slice(0, 7) !== ym || isWeekend(d)) continue;
            var r = byDate[k];
            if (r && (r.status === 'present' || r.status === 'late')) continue;
            byDate[k] = Object.assign({ date: k }, r || {}, { status: 'leave', leave: { id: L.id, type: L.leave_type_name || L.leave_type, half: L.half_day } });
          }
        });
        return { linked: !!e, emp: e, byDate: byDate };
      }
    });
    S.att[ym] = { at: Date.now(), p: p };
    p.catch(function () { delete S.att[ym]; });
    return p;
  }

  /* -- Lottie (assets/lottie/manifest.json, lazy player)  */
  var LOT = { player: null, manifest: null };
  function lottiePlayer() {
    if (window.lottie) return Promise.resolve(window.lottie);
    if (LOT.player) return LOT.player;
    LOT.player = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'assets/vendor/lottie/lottie_light.min.js' + assetVer();
      s.async = true;
      s.onload = function () { if (window.lottie) res(window.lottie); else rej(new Error('lottie')); };
      s.onerror = function () { rej(new Error('lottie')); };
      document.head.appendChild(s);
    });
    LOT.player.catch(function () { LOT.player = null; });
    return LOT.player;
  }
  function lottieManifest() {
    if (LOT.manifest) return LOT.manifest;
    LOT.manifest = Promise.resolve().then(function () { return fetch('assets/lottie/manifest.json', { cache: 'force-cache' }); })
      .then(function (r) { return r.json(); }).then(function (m) { if (!m || !m.animations) throw new Error('manifest'); return m; });
    LOT.manifest.catch(function () { LOT.manifest = null; });
    return LOT.manifest;
  }
  /** Fallback icon until the animation is ready (or forever, if Lottie can't load). */
  function lottie(name, icon, cls) {
    return '<span class="kj-sa-lottie ' + (cls || '') + '" data-sa-lottie="' + esc(name) + '" aria-hidden="true"><span class="kj-sa-lottie-fb">' + ico(icon || 'sparkles') + '</span></span>';
  }
  function hydrateLottie(root) {
    if (!root || !root.querySelectorAll) return;
    var els = root.querySelectorAll('[data-sa-lottie]:not([data-sa-lottie-on])');
    if (!els.length) return;
    Array.prototype.forEach.call(els, function (el) { el.setAttribute('data-sa-lottie-on', ''); });
    Promise.all([lottiePlayer(), lottieManifest()]).then(function (x) {
      var L = x[0], man = x[1];
      Array.prototype.forEach.call(els, function (el) {
        var a = man.animations[el.getAttribute('data-sa-lottie')];
        if (!a || !el.isConnected) return;
        try {
          var anim = L.loadAnimation({ container: el, renderer: 'svg', loop: !!a.loop && !reduced(), autoplay: true, path: 'assets/lottie/' + a.file });
          el.__kjAnim = anim;
          anim.addEventListener('DOMLoaded', function () { el.classList.add('is-ready'); });
        } catch (e) { /* keep fallback icon */ }
      });
    }).catch(function () { /* fallback icons stay */ });
  }
  function destroyLottie(root) {
    if (!root || !root.querySelectorAll) return;
    Array.prototype.forEach.call(root.querySelectorAll('[data-sa-lottie]'), function (el) {
      if (el.__kjAnim) { try { el.__kjAnim.destroy(); } catch (e) { /* ignore */ } el.__kjAnim = null; }
    });
  }

  /* -- shared render bits  */
  var STATUS = {
    present: ['Present', 'success', 'circle-check'], late: ['Late', 'warn', 'clock-alert'], absent: ['Absent', 'danger', 'circle-x'],
    leave: ['Leave', 'primary', 'calendar'], off: ['Off day', '', 'moon'], pending: ['Not yet in', 'info', 'hourglass']
  };
  var LSTATUS = {
    draft: ['Draft', ''], pending: ['Pending', 'warn'], approved: ['Approved', 'success'],
    rejected: ['Rejected', 'danger'], cancelled: ['Cancelled', '']
  };
  var LTYPE = {
    AL: { icon: 'calendar', tone: 'primary', short: 'Annual' },
    MC: { icon: 'briefcase-medical', tone: 'success', short: 'Medical' },
    EL: { icon: 'siren', tone: 'purple', short: 'Emergency' },
    UL: { icon: 'wallet', tone: 'orange', short: 'Unpaid' }
  };
  function ltype(code) { return LTYPE[String(code || '').toUpperCase()] || { icon: 'calendar-days', tone: 'info', short: code || 'Leave' }; }
  function chip(text, tone, icon) {
    return '<span class="kj-chip' + (tone ? ' is-' + tone : '') + '">' + (icon ? ico(icon) : '') + '<span>' + esc(text) + '</span></span>';
  }
  function avatar(photo, name, cls) {
    return photo ? '<img class="kj-sa-av ' + (cls || '') + '" src="' + esc(photo) + '" alt="' + esc(name || '') + '">'
      : '<span class="kj-sa-av ' + (cls || '') + '">' + esc(initials(name)) + '</span>';
  }
  function head(title, sub, extra) {
    return '<header class="kj-sa-head' + (extra ? ' ' + extra : '') + '"><h1 class="kj-sa-h1">' + esc(title) + '</h1>' + (sub ? '<p class="kj-sa-lead">' + esc(sub) + '</p>' : '') + '</header>';
  }
  function skelCard(lines) {
    var s = '<div class="kj-card kj-sa-card kj-sa-skel"><span class="kj-skel kj-skel-title"></span>';
    for (var i = 0; i < (lines || 3); i++) s += '<span class="kj-skel kj-skel-line' + (i === lines - 1 ? ' is-mid' : '') + '"></span>';
    return s + '</div>';
  }
  /** Empty/error state: Lottie + text + at least one way forward (rule 5). */
  function emptyBox(o) {
    return '<div class="kj-empty kj-sa-empty' + (o.error ? ' is-error' : '') + '">' +
      lottie(o.error ? 'error' : (o.anim || 'empty'), o.icon || (o.error ? 'cloud-off' : 'inbox'), 'kj-sa-lottie-lg') +
      '<div class="kj-empty-title">' + esc(o.title) + '</div>' + (o.text ? '<div class="kj-empty-text">' + esc(o.text) + '</div>' : '') +
      '<div class="kj-row-wrap kj-sa-empty-actions">' + (o.actions || []).join('') + '</div></div>';
  }
  function navBtn(path, label, icon, primary) {
    return '<button type="button" class="kj-btn ' + (primary ? 'kj-btn-primary' : 'kj-btn-secondary') + ' kj-btn-sm" data-kj-nav="' + esc(path) + '">' + (icon ? ico(icon) : '') + '<span>' + esc(label) + '</span></button>';
  }
  function actBtn(act, label, icon, cls, extra) {
    return '<button type="button" class="kj-btn ' + (cls || 'kj-btn-secondary') + ' kj-btn-sm" data-sa-act="' + esc(act) + '"' + (extra || '') + '>' + (icon ? ico(icon) : '') + '<span>' + esc(label) + '</span></button>';
  }
  function errorBox(err, back) {
    var off = err && err.status === 401;
    return emptyBox({ error: true, title: off ? 'Session expired' : 'Couldn\u2019t load this', text: off ? 'Please sign in again to continue.' : ((err && err.message ? err.message + '. ' : '') + 'Check your connection and try again.'),
      actions: [actBtn('retry', 'Try again', 'refresh-cw', 'kj-btn-primary'), off ? '<a class="kj-btn kj-btn-secondary kj-btn-sm" href="/?logout=1">' + ico('log-in') + '<span>Sign in</span></a>' : navBtn(back || 'app-home', 'Back to home', 'house')] });
  }
  function slot(name, html) {
    if (!S.el) return null;
    var el = S.el.querySelector('[data-sa-slot="' + name + '"]');
    if (!el) return null;
    destroyLottie(el);
    el.innerHTML = html;
    hydrateLottie(el);
    return el;
  }
  function guard(seq, fn) { return function (x) { if (seq === S.seq && S.el) fn(x); }; }

  /* -- notification bell: owned by KJShell (kj-shell.js renders it into the staff app bar,
   *    polls /notifications/count and fires `kj:notif-count`). The legacy self-injected bell
   *    below only runs when an older shell without KJShell.bell is loaded. */
  function shellBell() { return window.KJShell && window.KJShell.bell ? window.KJShell.bell : null; }
  document.addEventListener('kj:notif-count', function (e) {
    var d = e.detail || {};
    if (!document.documentElement.classList.contains('kj-staff-mode') || !notifyOn()) { S.unread = d.count; return; }
    if (S.unread >= 0 && d.count > S.unread) toast(d.count - S.unread === 1 ? 'You have a new notification' : 'You have ' + (d.count - S.unread) + ' new notifications', 'success');
    S.unread = d.count;
  });
  function ensureBell() {
    var bar = document.querySelector('#kj-staff .kj-staff-bar');
    if (!bar) return null;
    var sb = bar.querySelector('[data-kj-bell]');
    if (sb || shellBell()) return sb;   // shell-provided: never double-add
    var b = bar.querySelector('.kj-sa-bell');
    if (!b) {
      b = document.createElement('button');
      b.type = 'button';
      b.className = 'kj-sa-bell';
      b.setAttribute('data-kj-modal', 'staff-notifs:me');
      b.setAttribute('aria-label', 'Notifications');
      b.innerHTML = '<span class="kj-sa-bell-ico"></span><span class="kj-sa-bell-badge" hidden></span>';
      bar.insertBefore(b, bar.querySelector('.kj-staff-avatar'));
    }
    var i = b.querySelector('.kj-sa-bell-ico'), want = notifyOn() ? 'bell' : 'bell-off';
    if (i.getAttribute('data-ico') !== want || !i.innerHTML) { i.innerHTML = ico(want); i.setAttribute('data-ico', want); }
    return b;
  }
  function setBadge(n) {
    if (shellBell()) { S.unread = Math.max(0, n | 0); shellBell().set(n); return; }
    var b = ensureBell();
    n = notifyOn() ? Math.max(0, n | 0) : 0;
    if (S.unread >= 0 && n > S.unread && notifyOn()) toast(n - S.unread === 1 ? 'You have a new notification' : 'You have ' + (n - S.unread) + ' new notifications', 'success');
    S.unread = n;
    if (!b) return;
    var badge = b.querySelector('.kj-sa-bell-badge');
    badge.hidden = !n;
    badge.textContent = n > 9 ? '9+' : String(n);
    b.setAttribute('aria-label', n ? 'Notifications, ' + n + ' unread' : 'Notifications');
    b.classList.toggle('has-unread', !!n);
  }
  function pollTick() {
    if (shellBell()) { shellBell().refresh(); return; }
    if (!document.documentElement.classList.contains('kj-staff-mode')) { stopPoll(); return; }
    ensureBell();
    if (!notifyOn()) { setBadge(0); return; }
    req('GET', '/notifications/count').then(function (d) { setBadge(d.unread_count); }).catch(function () { /* offline: keep last badge */ });
  }
  function startPoll() { if (S.poll) return; pollTick(); if (!shellBell()) S.poll = setInterval(pollTick, 30000); }
  function stopPoll() { if (S.poll) { clearInterval(S.poll); S.poll = null; } }
  function syncShellAvatar() {
    var a = document.querySelector('#kj-staff .kj-staff-avatar'), u = me();
    if (!a) return;
    a.innerHTML = u.photo ? '<img src="' + esc(u.photo) + '" alt="">' : esc(initials(u.name));
    a.classList.toggle('has-photo', !!u.photo);
  }

  /*  HOME  */
  function greeting() { var hr = new Date().getHours(); return hr < 12 ? 'Good morning' : (hr < 18 ? 'Good afternoon' : 'Good evening'); }
  function clockParts() {
    var d = new Date(), h = d.getHours();
    return { t: pad(h % 12 || 12) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()), ap: h < 12 ? 'AM' : 'PM' };
  }
  function longDate() { return new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
  function quick(attrs, icon, label, tone) {
    return '<button type="button" class="kj-sa-quick" ' + attrs + '><span class="kj-sa-quick-ico' + (tone ? ' is-' + tone : '') + '">' + ico(icon) + '</span>' +
      '<span class="kj-sa-quick-lbl">' + esc(label) + '</span></button>';
  }
  function renderHome() {
    var u = me(), c = clockParts();
    return '' +
      '<section class="kj-sa-hello">' +
        '<button type="button" class="kj-sa-hello-av" data-kj-nav="app-profile" aria-label="My profile">' + avatar(u.photo, u.name, 'kj-sa-av-lg') + '</button>' +
        '<div class="kj-sa-hello-txt"><div class="kj-sa-hello-title">' + esc(greeting() + ', ' + firstName()) + '</div>' +
        '<div class="kj-sa-hello-sub">Kian Joo VisionAI</div></div>' +
      '</section>' +
      '<section class="kj-card kj-sa-hero">' +
        '<div class="kj-sa-hero-main">' +
          '<div class="kj-sa-date">' + esc(longDate()) + '</div>' +
          '<div class="kj-sa-clock"><span data-sa-clock>' + c.t + '</span><span class="kj-sa-ampm" data-sa-ampm>' + c.ap + '</span></div>' +
          '<div class="kj-sa-hint" data-sa-slot="hint">Ready for your shift?</div>' +
        '</div>' +
        '<a class="kj-sa-checkin" href="/kiosk.php" data-sa-checkin title="Open the face check-in kiosk">' +
          '<span class="kj-sa-checkin-pulse" aria-hidden="true"></span>' + ico('fingerprint') + '<span data-sa-slot="checkin">Check In</span></a>' +
        '<div class="kj-sa-hero-foot" data-sa-slot="status"><span class="kj-skel kj-sa-skel-chip"></span><span class="kj-skel kj-sa-skel-chip is-short"></span></div>' +
      '</section>' +
      '<section class="kj-sa-quicks" aria-label="Quick actions">' +
        quick('data-kj-modal="staff-leave-apply:new"', 'calendar-plus', 'Apply Leave') +
        quick('data-kj-nav="app-attendance"', 'calendar-check', 'My Attendance') +
        quick('data-kj-modal="staff-info:payslip"', 'receipt-text', 'Payslip') +
        quick('data-kj-nav="app-profile"', 'user-round', 'Profile') +
      '</section>' +
      '<section data-sa-slot="shift">' + skelCard(3) + '</section>' +
      '<section data-sa-slot="leavesum"></section>' +
      '<section class="kj-card kj-sa-card kj-sa-announce kj-sa-tap" data-kj-modal="staff-info:announcement">' +
        '<div class="kj-sa-announce-head">' + ico('megaphone', 'kj-sa-announce-ico') + '<span class="kj-sa-card-title">Announcements</span><span class="kj-sa-new">NEW</span></div>' +
        '<div class="kj-sa-row-chev"><div class="kj-sa-announce-body"><div class="kj-sa-announce-title">' + esc(ANNOUNCE.title) + '</div>' +
        '<div class="kj-sa-announce-text">' + esc(ANNOUNCE.text) + '</div>' +
        '<div class="kj-sa-meta">' + ico('map-pin') + '<span>' + esc(ANNOUNCE.when + ' \u2022 ' + ANNOUNCE.where) + '</span></div></div>' + ico('chevron-right', 'kj-sa-chev') + '</div>' +
      '</section>';
  }
  var ANNOUNCE = {
    title: 'Monthly safety briefing', when: 'Tomorrow', where: 'Training Room',
    text: 'Join your team at 7:45 AM before the morning shift.',
    body: 'All production staff: the monthly safety briefing covers forklift right-of-way, PPE in the can-line bays and the updated fire assembly points. Bring your staff ID card. Attendance is recorded at the kiosk.'
  };
  function shiftOf(t) {
    var list = (t && t.shifts) || [], emp = t && t.emp;
    var s = list.filter(function (x) { return emp && x.id === emp.shift; })[0] || list[0];
    return s || { id: 'day', name: 'Day shift', start: '08:00', end: '17:00', days: [1, 2, 3, 4, 5] };
  }
  function shiftHours(s) {
    var a = String(s.start).split(':'), b = String(s.end).split(':');
    var m = (+b[0] * 60 + +b[1]) - (+a[0] * 60 + +a[1]); if (m <= 0) m += 1440;
    return Math.round(m / 6) / 10;
  }
  function nextShift(s) {
    var now = new Date(), wd = (s.days && s.days.length) ? s.days : [1, 2, 3, 4, 5];
    var e = String(s.end).split(':');
    for (var i = 0; i < 8; i++) {
      var d = addDays(now, i), iso = d.getDay() || 7;
      if (wd.indexOf(iso) < 0) continue;
      if (i === 0 && (now.getHours() * 60 + now.getMinutes()) >= (+e[0] * 60 + +e[1])) continue;
      return { date: d, label: i === 0 ? 'Today' : (i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-GB', { weekday: 'long' })) };
    }
    return { date: addDays(now, 1), label: 'Tomorrow' };
  }
  function paintHomeData(seq) {
    getToday().then(guard(seq, function (t) {
      var s = shiftOf(t), r = t.row, chips = [];
      var hint = 'Ready for your shift?', cta = 'Check In';
      if (!t.linked) {
        chips.push('<button type="button" class="kj-chip is-warn kj-sa-chip-btn" data-kj-modal="staff-info:link">' + ico('user-x') + '<span>Not linked to an employee</span></button>');
        hint = 'Use the kiosk to check in today.';
      } else if (!r) {
        chips.push('<button type="button" class="kj-chip kj-sa-chip-btn" data-kj-modal="staff-day:today">' + ico('calendar-x') + '<span>Not on today\u2019s register</span></button>');
      } else {
        var st = STATUS[r.status] || STATUS.pending;
        if (r.clockIn) {
          chips.push('<button type="button" class="kj-chip is-' + (r.status === 'late' ? 'warn' : 'success') + ' kj-sa-chip-btn kj-sa-chip-lg" data-kj-modal="staff-day:today">' + ico('circle-check') +
            '<span>' + esc((r.status === 'late' ? 'Late \u00b7 in ' : 'Checked in ') + hm(r.clockIn)) + '</span></button>');
          if (r.clockOut) { chips.push('<button type="button" class="kj-chip is-info kj-sa-chip-btn kj-sa-chip-lg" data-kj-modal="staff-day:today">' + ico('log-out') + '<span>Out ' + esc(hm(r.clockOut)) + '</span></button>'); cta = 'Done'; hint = 'Shift complete \u2014 ' + fmtHours(r.hours) + ' logged.'; }
          else { cta = 'Check Out'; hint = 'You\u2019re on shift. Have a safe day!'; }
        } else {
          chips.push('<button type="button" class="kj-chip is-' + (st[1] || 'primary') + ' kj-sa-chip-btn kj-sa-chip-lg" data-kj-modal="staff-day:today">' + ico(st[2]) + '<span>' + esc(r.status === 'pending' ? 'Not checked in yet' : st[0] + ' today') + '</span></button>');
          if (r.status === 'off') hint = 'Enjoy your day off.';
        }
      }
      chips.push('<button type="button" class="kj-chip is-primary kj-sa-chip-btn kj-sa-chip-lg" data-kj-nav="app-attendance">' + ico('calendar-clock') + '<span>Shift ' + esc(shiftHours(s)) + 'h</span></button>');
      slot('status', chips.join(''));
      slot('hint', esc(hint));
      slot('checkin', esc(cta));
      var ns = nextShift(s), emp = t.emp || {};
      slot('shift',
        '<div class="kj-card kj-sa-card kj-sa-shift kj-sa-tap" data-kj-nav="app-attendance">' +
          '<div class="kj-sa-card-title">Upcoming shift</div>' +
          '<div class="kj-sa-shift-body"><div class="kj-sa-shift-info">' +
            '<span class="kj-chip is-primary">' + ico('calendar') + '<span>' + esc(ns.label) + '</span></span>' +
            '<div class="kj-sa-shift-name">' + esc(s.name || 'Shift') + '</div>' +
            '<div class="kj-sa-meta">' + ico('clock') + '<span>' + esc(s.start + ' \u2013 ' + s.end) + '</span></div>' +
            '<div class="kj-sa-meta">' + ico('factory') + '<span>' + esc(emp.plant || emp.department || 'Kian Joo plant') + '</span></div>' +
          '</div><div class="kj-sa-shift-art" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>' + ico('chevron-right', 'kj-sa-chev') + '</div>' +
        '</div>');
    })).catch(guard(seq, function (e) {
      slot('status', '<button type="button" class="kj-chip is-danger kj-sa-chip-btn" data-sa-act="retry">' + ico('refresh-cw') + '<span>Status unavailable \u2014 retry</span></button>' +
        '<button type="button" class="kj-chip is-primary kj-sa-chip-btn" data-kj-nav="app-attendance">' + ico('calendar-check') + '<span>My attendance</span></button>');
      slot('shift', '<div class="kj-card kj-sa-card">' + errorBox(e, 'app-attendance') + '</div>');
    }));
    // Pending leave nudge (only when there is something to say).
    getLeaves().then(guard(seq, function (d) {
      var pend = (d.leaves || []).filter(function (l) { return l.status === 'pending'; });
      if (!pend.length) return;
      var l = pend[0];
      slot('leavesum', '<div class="kj-card kj-sa-card kj-sa-nudge kj-sa-tap" data-kj-modal="leave:' + l.id + '">' +
        '<span class="kj-sa-req-ico is-warn">' + ico('hourglass') + '</span><div class="kj-sa-grow"><div class="kj-sa-strong">' +
        esc(pend.length === 1 ? (l.leave_type_name + ' awaiting approval') : pend.length + ' leave requests awaiting approval') + '</div>' +
        '<div class="kj-sa-muted">' + esc(fmtRange(l.start_date, l.end_date) + ' \u00b7 ' + days(l.days)) + '</div></div>' + ico('chevron-right', 'kj-sa-chev') + '</div>');
    })).catch(function () { /* nudge is optional */ });
  }

  /*  ATTENDANCE  */
  function monthLabel(ym) { var d = parseYmd(ym + '-01'); return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }); }
  function shiftMonth(ym, n) { var d = parseYmd(ym + '-01'); d.setMonth(d.getMonth() + n); return ymd(d).slice(0, 7); }
  function renderAttendance() {
    if (!S.month) S.month = todayYmd().slice(0, 7);
    var cur = S.month >= todayYmd().slice(0, 7);
    return head('My Attendance', 'Your time, at a glance') +
      '<section class="kj-card kj-sa-month">' +
        '<button type="button" class="kj-sa-icon-btn" data-sa-act="month" data-dir="-1" aria-label="Previous month">' + ico('chevron-left') + '</button>' +
        '<div class="kj-sa-month-lbl">' + ico('calendar') + '<span>' + esc(monthLabel(S.month)) + '</span></div>' +
        '<button type="button" class="kj-sa-icon-btn" data-sa-act="month" data-dir="1" aria-label="Next month"' + (cur ? ' disabled' : '') + '>' + ico('chevron-right') + '</button>' +
      '</section>' +
      '<section class="kj-sa-stats" data-sa-slot="stats">' + ['present', 'late', 'absent', 'leave'].map(function () { return '<span class="kj-skel kj-sa-skel-stat"></span>'; }).join('') + '</section>' +
      '<section class="kj-card kj-sa-card kj-sa-calcard" data-sa-slot="cal">' + calendarHtml(S.month, null) + '</section>' +
      '<section class="kj-sa-sec"><div class="kj-sa-sec-head"><h2 class="kj-sa-h2">My overtime</h2></div><div data-sa-slot="ot">' + skelCard(2) + '</div></section>' +
      '<section class="kj-sa-sec"><div class="kj-sa-sec-head"><h2 class="kj-sa-h2">Daily log</h2><span data-sa-slot="logtoggle"></span></div>' +
        '<div data-sa-slot="log">' + skelCard(4) + '</div></section>';
  }
  function calendarHtml(ym, data) {
    var first = parseYmd(ym + '-01'), y = first.getFullYear(), m = first.getMonth();
    var lead = (first.getDay() + 6) % 7, n = new Date(y, m + 1, 0).getDate(), today = todayYmd();
    var cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(function (w) { return '<span class="kj-sa-cal-dow">' + w + '</span>'; }).join('');
    for (var i = lead; i > 0; i--) cells += '<span class="kj-sa-cal-day is-out">' + addDays(first, -i).getDate() + '</span>';
    for (var d = 1; d <= n; d++) {
      var iso = ym + '-' + pad(d), r = data && data.byDate[iso], dt = new Date(y, m, d);
      var st = r ? r.status : (isWeekend(dt) ? 'off' : '');
      if ((st === 'pending' && iso < today) || (iso > today && st !== 'leave')) st = '';
      var cls = 'kj-sa-cal-day' + (st ? ' is-' + st : '') + (iso === today ? ' is-today' : '') + (iso > today ? ' is-future' : '') + (!data ? ' is-loading' : '');
      var lbl = dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) + (st && STATUS[st] ? ': ' + STATUS[st][0] : '');
      cells += (iso > today || !data)
        ? '<span class="' + cls + '">' + d + '</span>'
        : '<button type="button" class="' + cls + '" data-kj-modal="staff-day:' + iso + '" aria-label="' + esc(lbl) + '">' + d + '<i class="kj-sa-cal-dot"></i></button>';
    }
    var tail = (7 - ((lead + n) % 7)) % 7;
    for (var t = 1; t <= tail; t++) cells += '<span class="kj-sa-cal-day is-out">' + t + '</span>';
    return '<div class="kj-sa-cal" role="grid" aria-label="' + esc(monthLabel(ym)) + '">' + cells + '</div>' +
      '<div class="kj-sa-legend">' + ['present', 'late', 'absent', 'leave'].map(function (k) {
        return '<span class="kj-sa-legend-i is-' + k + '"><i></i>' + STATUS[k][0] + '</span>';
      }).join('') + '</div>';
  }
  /* My overtime (GET /overtime/mine): month totals + each record with its approval status and how it was derived. */
  var OT_ST = { pending: ['Pending approval', 'warn'], approved: ['Approved', 'success'], rejected: ['Rejected', 'danger'] };
  function fmtMins(m) { m = Math.max(0, Math.round(+m || 0)); var h = Math.floor(m / 60), r = m % 60; return h ? (r ? h + 'h ' + pad(r) + 'm' : h + 'h') : r + 'm'; }
  function getOt(ym, force) {
    var c = S.ot && S.ot[ym];
    if (!force && c && Date.now() - c.at < 60000) return c.p;
    S.ot = S.ot || {};
    var p = req('GET', '/overtime/mine', { month: ym });
    S.ot[ym] = { at: Date.now(), p: p };
    p.catch(function () { delete S.ot[ym]; });
    return p;
  }
  function paintOtData(seq) {
    var ym = S.month;
    getOt(ym).then(guard(seq, function (d) {
      if (ym !== S.month) return;
      if (!d.linked) { slot('ot', ''); return; }
      var t = d.totals || {}, ap = (t.approved || {}).min || 0, pe = (t.pending || {}).min || 0, recs = d.records || [];
      var sum = '<div class="kj-sa-ot-sum"><span class="kj-sa-ot-tot is-success"><small>Approved</small><b>' + esc(fmtMins(ap)) + '</b></span>' +
        '<span class="kj-sa-ot-tot is-warn"><small>Pending</small><b>' + esc(fmtMins(pe)) + '</b></span>' +
        '<span class="kj-sa-ot-tot"><small>Days</small><b>' + recs.filter(function (r) { return r.status !== 'rejected'; }).length + '</b></span></div>';
      var list = recs.length ? '<div class="kj-sa-ot-list">' + recs.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).map(function (r) {
        var st = OT_ST[r.status] || OT_ST.pending;
        return '<div class="kj-sa-ot-row"><div class="kj-sa-ot-top"><span class="kj-sa-log-day">' + esc(fmtDay(r.date)) + '</span>' +
          '<b class="kj-sa-ot-min">' + esc(fmtMins(r.status === 'rejected' ? r.calcMinutes : r.minutes)) + '</b>' + chip(st[0], st[1]) + '</div>' +
          '<div class="kj-sa-ot-why">' + esc(r.explain || '') + '</div>' +
          (r.note ? '<div class="kj-sa-ot-why">' + ico('message-square') + esc((r.decidedBy ? r.decidedBy + ': ' : '') + r.note) + '</div>' : '') + '</div>';
      }).join('') + '</div>'
        : '<p class="kj-sa-ot-none">' + ico('timer-off') + '<span>No overtime captured this month.</span></p>';
      slot('ot', '<div class="kj-card kj-sa-card kj-sa-ot">' + sum + list +
        '<p class="kj-sa-ot-rule">' + ico('info') + '<span>' + esc((d.rule || '') + ' Overtime is estimated from the last time a camera saw you and is paid only once your supervisor approves it.') + '</span></p></div>');
    })).catch(guard(seq, function (e) {
      slot('ot', e && e.status === 404 ? '' : '<div class="kj-card kj-sa-card"><p class="kj-sa-ot-none">' + ico('cloud-off') + '<span>Overtime is unavailable right now.</span></p></div>');
    }));
  }
  function paintAttendanceData(seq) {
    var ym = S.month;
    paintOtData(seq);
    getMonth(ym).then(guard(seq, function (data) {
      if (ym !== S.month) return;
      var cnt = { present: 0, late: 0, absent: 0, leave: 0 };
      Object.keys(data.byDate).forEach(function (k) { var s = data.byDate[k].status; if (cnt[s] != null) cnt[s]++; });
      slot('stats', ['present', 'late', 'absent', 'leave'].map(function (k) {
        var on = S.attFilter === k;
        return '<button type="button" class="kj-sa-stat is-' + k + (on ? ' is-on' : '') + '" data-sa-act="filter" data-k="' + k + '" aria-pressed="' + on + '">' +
          '<span class="kj-sa-stat-top">' + ico(STATUS[k][2]) + '<span>' + STATUS[k][0] + '</span></span><span class="kj-sa-stat-val">' + cnt[k] + '</span></button>';
      }).join(''));
      slot('cal', calendarHtml(ym, data));
      if (!data.linked) {
        slot('log', '<div class="kj-card kj-sa-card">' + emptyBox({ icon: 'user-x', anim: 'scan', title: 'Your login isn\u2019t linked to an employee yet',
          text: 'Ask HR to link your account to your staff record. Until then, check in at the face kiosk as usual.',
          actions: ['<a class="kj-btn kj-btn-primary kj-btn-sm" href="/kiosk.php">' + ico('scan-face') + '<span>Face check-in</span></a>', navBtn('app-profile', 'My profile', 'user-round')] }) + '</div>');
        slot('logtoggle', '');
        return;
      }
      var list = Object.keys(data.byDate).sort().reverse().map(function (k) { return data.byDate[k]; })
        .filter(function (r) { return r.status !== 'off' || r.clockIn; })
        .filter(function (r) { return !S.attFilter || r.status === S.attFilter; });
      var shown = S.logAll ? list : list.slice(0, 7);
      slot('logtoggle', list.length > 7 ? '<button type="button" class="kj-sa-link" data-sa-act="logall">' + (S.logAll ? 'Show less' : 'View all') + '</button>' : '');
      if (!list.length) {
        slot('log', '<div class="kj-card kj-sa-card">' + emptyBox({ title: S.attFilter ? 'No ' + STATUS[S.attFilter][0].toLowerCase() + ' days this month' : 'No attendance yet this month',
          text: S.attFilter ? 'Tap the chip again to see every day.' : 'Your check-ins appear here as soon as the kiosk or a camera recognises you.',
          actions: S.attFilter ? [actBtn('filter', 'Show all days', 'list', 'kj-btn-primary', ' data-k="' + S.attFilter + '"')] : ['<a class="kj-btn kj-btn-primary kj-btn-sm" href="/kiosk.php">' + ico('scan-face') + '<span>Face check-in</span></a>', navBtn('app-home', 'Home', 'house')] }) + '</div>');
        return;
      }
      slot('log', '<div class="kj-card kj-sa-log">' + shown.map(function (r) {
        var st = STATUS[r.status] || STATUS.pending;
        return '<button type="button" class="kj-sa-log-row" data-kj-modal="staff-day:' + r.date + '">' +
          '<span class="kj-sa-log-day">' + esc(fmtDay(r.date)) + '</span>' +
          '<span class="kj-chip is-' + (st[1] || 'muted') + ' kj-sa-log-chip">' + esc(r.status === 'leave' && r.leave ? (ltype(r.leave.type).short || 'Leave') : st[0]) + '</span>' +
          '<span class="kj-sa-log-t"><small>' + ico('clock') + 'In</small><b>' + esc(hm(r.clockIn) || '\u2014') + '</b></span>' +
          '<span class="kj-sa-log-t"><small>' + ico('clock') + 'Out</small><b>' + esc(hm(r.clockOut) || '\u2014') + '</b></span>' +
          '<span class="kj-sa-log-t kj-sa-log-total"><small>Total</small><b>' + esc(fmtHours(r.hours)) + '</b></span></button>';
      }).join('') + '</div>');
    })).catch(guard(seq, function (e) {
      slot('stats', '');
      slot('cal', calendarHtml(ym, { byDate: {} }));
      slot('log', '<div class="kj-card kj-sa-card">' + errorBox(e) + '</div>');
    }));
  }

  /*  LEAVE  */
  function renderLeave() {
    var y = new Date().getFullYear();
    var years = [y + 1, y, y - 1].map(function (v) { return '<option value="' + v + '"' + (v === S.leaveYear ? ' selected' : '') + '>' + v + '</option>'; }).join('');
    return head('Leave center', 'Manage your time off', 'kj-sa-head-art') +
      '<section class="kj-card kj-sa-card kj-sa-bal">' +
        '<div class="kj-sa-card-head"><span class="kj-sa-card-title">Leave balance</span>' +
        '<label class="kj-sa-year"><span class="kj-sr-only">Year</span><select data-sa-year>' + years + '</select>' + ico('chevron-down') + '</label></div>' +
        '<div class="kj-sa-bal-grid" data-sa-slot="bal">' + [1, 2, 3].map(function () { return '<span class="kj-skel kj-sa-skel-bal"></span>'; }).join('') + '</div>' +
        '<button type="button" class="kj-btn kj-btn-primary kj-btn-lg kj-btn-block kj-sa-apply" data-kj-modal="staff-leave-apply:new">' + ico('plus') + '<span>Apply Leave</span></button>' +
      '</section>' +
      '<section class="kj-sa-sec"><div class="kj-sa-sec-head"><h2 class="kj-sa-h2">Leave requests</h2></div>' +
        '<div class="kj-sa-seg" role="tablist" aria-label="Leave requests" data-sa-slot="tabs">' + tabsHtml(null) + '</div>' +
        '<div class="kj-sa-reqs" data-sa-slot="reqs">' + skelCard(3) + skelCard(3) + '</div>' +
      '</section>';
  }
  var LTABS = [['pending', 'Pending'], ['approved', 'Approved'], ['history', 'History']];
  function tabFilter(tab) {
    return function (l) { return tab === 'pending' ? (l.status === 'pending' || l.status === 'draft') : tab === 'approved' ? l.status === 'approved' : true; };
  }
  function tabsHtml(list) {
    return LTABS.map(function (t) {
      var on = S.leaveTab === t[0], n = list ? list.filter(tabFilter(t[0])).length : null;
      return '<button type="button" role="tab" class="kj-sa-seg-btn' + (on ? ' is-active' : '') + '" aria-selected="' + on + '" data-sa-act="ltab" data-k="' + t[0] + '">' +
        esc(t[1]) + (n ? '<span class="kj-sa-seg-n">' + n + '</span>' : '') + '</button>';
    }).join('');
  }
  function ring(pct, tone) {
    pct = Math.max(0, Math.min(100, Math.round(pct)));
    return '<svg class="kj-sa-ring is-' + tone + '" viewBox="0 0 36 36" aria-hidden="true"><circle class="kj-sa-ring-track" cx="18" cy="18" r="15.9155" pathLength="100"></circle>' +
      '<circle class="kj-sa-ring-fill" cx="18" cy="18" r="15.9155" pathLength="100" stroke-dasharray="' + pct + ' 100"></circle></svg>';
  }
  function balTile(b) {
    var t = ltype(b.code), unl = b.unlimited;
    var avail = unl ? null : Math.max(0, Number(b.available) || 0), ent = Number(b.entitled) || 0;
    var pct = unl ? 100 : (ent ? 100 * avail / ent : 0);
    return '<button type="button" class="kj-sa-bal-tile is-' + t.tone + '" data-kj-modal="staff-leave-apply:' + esc(b.code) + '" aria-label="' + esc(b.name + ': ' + (unl ? 'no limit' : avail + ' of ' + ent + ' days available') + '. Apply') + '">' +
      '<span class="kj-sa-bal-top">' + ico(t.icon) + '<span>' + esc(t.short) + '</span></span>' +
      '<span class="kj-sa-bal-ring">' + ring(pct, t.tone) + '<span class="kj-sa-bal-num"><b>' + (unl ? '\u221e' : esc(avail % 1 ? avail.toFixed(1) : avail)) + '</b>' + (unl ? '' : '<small>/' + esc(ent) + '</small>') + '</span></span>' +
      '<span class="kj-sa-bal-sub">' + (unl ? 'no limit' : 'days available') + (Number(b.pending) ? ' \u00b7 ' + esc(b.pending) + ' pending' : '') + '</span></button>';
  }
  function reqCard(l) {
    var t = ltype(l.leave_type), st = LSTATUS[l.status] || [l.status, ''];
    var remark = l.approver_remarks || (l.status === 'pending' ? 'Awaiting supervisor approval' : l.status === 'draft' ? 'Draft \u2014 not submitted yet'
      : l.status === 'cancelled' ? (l.cancel_remarks || 'Cancelled') : (l.status === 'approved' ? 'Approved' + (l.approver ? ' by ' + l.approver : '') : '\u2014'));
    return '<article class="kj-card kj-sa-req kj-sa-tap" data-kj-modal="leave:' + l.id + '">' +
      '<div class="kj-sa-req-top"><span class="kj-sa-req-ico is-' + t.tone + '">' + ico(t.icon) + '</span>' +
        '<div class="kj-sa-req-main"><div class="kj-sa-req-title">' + esc(l.leave_type_name || l.leave_type) + '</div>' +
        '<div class="kj-sa-req-meta"><span>' + ico('calendar') + esc(fmtRange(l.start_date, l.end_date)) + '</span><span class="kj-sa-sep"></span><span>' + ico('clock') +
          esc(l.half_day ? 'Half day (' + String(l.half_day_period || '').toUpperCase() + ')' : days(l.days)) + '</span></div></div>' +
        '<span class="kj-chip is-' + (st[1] || 'muted') + ' kj-sa-req-chip">' + esc(st[0]) + '</span></div>' +
      '<div class="kj-sa-req-remark">' + avatar('', l.approver || (l.status === 'pending' ? 'Supervisor' : '?'), 'kj-sa-av-sm' + (l.approver ? '' : ' is-ghost')) +
        '<div class="kj-sa-grow"><div class="kj-sa-req-lbl">Approver remark</div><div class="kj-sa-req-txt">' + esc(remark) + '</div></div>' +
        ((l.can && l.can.cancel && (l.status === 'pending' || l.status === 'draft')) ? actBtn('cancel', 'Cancel', 'x', 'kj-btn-ghost kj-sa-req-cancel', ' data-id="' + l.id + '"') : '') +
      '</div></article>';
  }
  function paintLeaveData(seq) {
    getLeaves(S.leaveYear).then(guard(seq, function (d) {
      var bals = (d.balances || []).filter(function (b) { return !b.unlimited || Number(b.used) || Number(b.pending); });
      if (!bals.length) bals = d.balances || [];
      slot('bal', bals.map(balTile).join('') || '<div class="kj-sa-muted">No leave types configured.</div>');
      var list = d.leaves || [];
      slot('tabs', tabsHtml(list));
      var shown = list.filter(tabFilter(S.leaveTab));
      slot('reqs', shown.length ? shown.map(reqCard).join('') : '<div class="kj-card kj-sa-card">' + emptyBox({
        anim: S.leaveTab === 'pending' ? 'success' : 'empty', icon: S.leaveTab === 'pending' ? 'circle-check' : 'inbox',
        title: S.leaveTab === 'pending' ? 'Nothing waiting for approval' : S.leaveTab === 'approved' ? 'No approved leave in ' + S.leaveYear : 'No leave requests in ' + S.leaveYear,
        text: 'Planning time off? Apply in under a minute \u2014 your supervisor is notified straight away.',
        actions: ['<button type="button" class="kj-btn kj-btn-primary kj-btn-sm" data-kj-modal="staff-leave-apply:new">' + ico('plus') + '<span>Apply Leave</span></button>', navBtn('app-attendance', 'My attendance', 'calendar-check')] }) + '</div>');
    })).catch(guard(seq, function (e) {
      slot('bal', '<div class="kj-sa-muted kj-sa-span">Balances unavailable.</div>');
      slot('reqs', '<div class="kj-card kj-sa-card">' + errorBox(e) + '</div>');
    }));
  }

  /*  PROFILE  */
  function renderProfile() {
    return head('Profile', '') + '<div data-sa-slot="pf">' + profileHtml(true) + '</div>';
  }
  function pfRow(icon, label, value, attrs, muted) {
    return '<button type="button" class="kj-sa-pf-row" ' + attrs + '>' + ico(icon, 'kj-sa-pf-ico') + '<span class="kj-sa-pf-lbl">' + esc(label) + '</span>' +
      '<span class="kj-sa-pf-val' + (muted ? ' is-muted' : '') + '">' + esc(value) + '</span>' + ico(muted === 'lock' ? 'lock' : 'pencil', 'kj-sa-pf-edit') + '</button>';
  }
  function profileHtml(loading) {
    var u = me(), emp = u.emp, ec = u.ec || {};
    var staffId = emp && emp.staff_id ? emp.staff_id : (u.username ? '@' + u.username : '');
    var dept = emp ? (emp.department || emp.plant || '') : (u.role ? u.role.charAt(0).toUpperCase() + u.role.slice(1) : '');
    var ecTxt = ec.name ? ec.name + (ec.phone ? ' \u00b7 ' + ec.phone : '') + (ec.relation ? ' (' + ec.relation + ')' : '') : 'Add emergency contact';
    var desk = P().allowed('dashboard');
    return '' +
      '<section class="kj-sa-pf-hero">' +
        '<div class="kj-sa-pf-photo" data-sa-slot="photo">' + avatar(u.photo, u.name, 'kj-sa-av-xl') +
          '<label class="kj-sa-pf-cam" title="Change photo">' + ico('camera') + '<span class="kj-sr-only">Change photo</span>' +
          '<input type="file" accept="image/jpeg,image/png,image/webp" data-sa-photo class="kj-sr-only"></label></div>' +
        '<div class="kj-sa-pf-id"><div class="kj-sa-pf-name">' + esc(u.name) + '</div>' +
          (staffId ? '<span class="kj-chip is-primary kj-sa-pf-staff">' + esc(staffId) + '</span>' : '') +
          (dept ? '<div class="kj-sa-meta">' + ico('factory') + '<span>' + esc(dept) + '</span></div>' : '') +
        '</div>' +
      '</section>' +
      (loading ? skelCard(3) :
      '<section class="kj-card kj-sa-list-card">' +
        '<div class="kj-sa-card-head kj-sa-pad">' + ico('user-round', 'kj-sa-pf-ico') + '<span class="kj-sa-card-title kj-sa-grow">Personal information</span>' +
          '<button type="button" class="kj-sa-icon-btn" data-kj-modal="staff-profile-edit:me" aria-label="Edit personal information">' + ico('pencil') + '</button></div>' +
        pfRow('id-card', 'Display name', u.name, 'data-kj-modal="staff-profile-edit:display_name"') +
        pfRow('phone', 'Phone', u.phone || 'Add phone number', 'data-kj-modal="staff-profile-edit:phone"', !u.phone) +
        pfRow('mail', 'Email', u.email || 'Not set', 'data-sa-act="email"', 'lock') +
        pfRow('users', 'Emergency contact', ecTxt, 'data-kj-modal="staff-profile-edit:emergency_name"', !ec.name) +
      '</section>') +
      '<section class="kj-card kj-sa-card kj-sa-face">' +
        '<div class="kj-sa-card-head">' + ico('scan-face', 'kj-sa-pf-ico') + '<span class="kj-sa-card-title kj-sa-grow">Face enrolment</span></div>' +
        '<div class="kj-sa-face-body">' +
          (emp && emp.photo_url ? '<button type="button" class="kj-sa-face-img" data-kj-modal="image:' + esc(emp.photo_url) + '" aria-label="View enrolment photo"><img src="' + esc(emp.photo_url) + '" alt="Enrolment photo"></button>'
            : '<span class="kj-sa-face-img is-empty">' + ico('scan-face') + '</span>') +
          '<div class="kj-sa-grow">' + (emp ? chip('Enrolled', 'success', 'circle-check') + '<div class="kj-sa-muted kj-sa-mt">Recognised as ' + esc(emp.name) + (emp.staff_id ? ' (' + esc(emp.staff_id) + ')' : '') + '</div>'
            : chip(loading ? 'Checking\u2026' : 'Not linked', loading ? '' : 'warn', loading ? 'hourglass' : 'circle-alert') + '<div class="kj-sa-muted kj-sa-mt">' + (loading ? '' : 'Ask HR to enrol your face and link it to this login.') + '</div>') +
          '<a class="kj-sa-link kj-sa-mt" href="/kiosk.php">' + (emp ? 'Test face check-in' : 'Open face kiosk') + ' ' + ico('chevron-right') + '</a></div>' +
        '</div>' +
      '</section>' +
      '<section class="kj-card kj-sa-list-card">' +
        '<div class="kj-sa-card-head kj-sa-pad">' + ico('settings', 'kj-sa-pf-ico') + '<span class="kj-sa-card-title">Settings</span></div>' +
        '<label class="kj-sa-pf-row kj-sa-switch-row">' + ico('bell', 'kj-sa-pf-ico') + '<span class="kj-sa-pf-lbl kj-sa-grow">Notifications</span>' +
          '<input type="checkbox" class="kj-sa-switch" data-sa-notify role="switch"' + (notifyOn() ? ' checked' : '') + '></label>' +
        (desk ? '<button type="button" class="kj-sa-pf-row" data-kj-nav="dashboard">' + ico('layout-dashboard', 'kj-sa-pf-ico') + '<span class="kj-sa-pf-lbl kj-sa-grow">Monitoring dashboard</span>' + ico('chevron-right', 'kj-sa-chev') + '</button>' : '') +
        '<a class="kj-sa-pf-row" href="/kiosk.php">' + ico('fingerprint', 'kj-sa-pf-ico') + '<span class="kj-sa-pf-lbl kj-sa-grow">Face check-in kiosk</span>' + ico('chevron-right', 'kj-sa-chev') + '</a>' +
      '</section>' +
      '<button type="button" class="kj-card kj-sa-row-card kj-sa-tap" data-kj-modal="staff-tickets:mine">' + ico('ticket', 'kj-sa-row-ico') +
        '<span class="kj-sa-card-title kj-sa-grow">My Tickets</span><span data-sa-slot="tickets"></span>' + ico('chevron-right', 'kj-sa-chev') + '</button>' +
      '<button type="button" class="kj-sa-logout" data-kj-modal="staff-logout:me">' + ico('log-out') + '<span>Log Out</span></button>' +
      '<div class="kj-sa-foot-note">Signed in as ' + esc(u.username ? '@' + u.username : u.name) + (u.role ? ' \u00b7 ' + esc(u.role) : '') + '</div>';
  }
  function paintProfileData(seq) {
    getProfile().then(guard(seq, function () {
      slot('pf', profileHtml(false));
      req('GET', '/tickets', { mine: 1, open: 1, limit: 1 }).then(guard(seq, function (d) {
        slot('tickets', d.total ? '<span class="kj-sa-count">' + esc(d.total) + '</span>' : '');
      })).catch(function () { /* row still opens the list */ });
    })).catch(guard(seq, function (e) {
      slot('pf', profileHtml(false).replace('<section class="kj-card kj-sa-list-card">', '<section class="kj-card kj-sa-card">' + errorBox(e) + '</section><section class="kj-card kj-sa-list-card">'));
    }));
  }
  function uploadPhoto(file) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast('That photo is larger than 10 MB.', 'danger'); return; }
    var box = S.el && S.el.querySelector('.kj-sa-pf-photo');
    if (box) box.classList.add('is-busy');
    var fd = new FormData(); fd.append('file', file);
    req('POST', '/profile/photo', null, fd).then(function (d) {
      if (S.profile) S.profile.photo_url = d.photo_url;
      toast('Profile photo updated', 'success');
      syncShellAvatar();
      if (S.sub === 'profile') paint();
    }).catch(function (e) {
      toast(e.message || 'Photo upload failed', 'danger');
      if (box) box.classList.remove('is-busy');
    });
  }

  /* -- page lifecycle  */
  var RENDER = { home: renderHome, attendance: renderAttendance, leave: renderLeave, profile: renderProfile };
  var DATA = { home: paintHomeData, attendance: paintAttendanceData, leave: paintLeaveData, profile: paintProfileData };
  function paint() {
    if (!S.el) return;
    var seq = ++S.seq;
    destroyLottie(S.el);
    var first = !S.el.firstChild || S.el.getAttribute('data-sa-sub') !== S.sub;
    S.el.setAttribute('data-sa-sub', S.sub);
    S.el.innerHTML = '<div class="kj-app-page kj-sa-page' + (first ? ' is-entering' : '') + '" data-kj-app="' + S.sub + '">' + (RENDER[S.sub] || renderHome)() + '</div>';
    hydrateLottie(S.el);
    (DATA[S.sub] || paintHomeData)(seq);
  }
  function onClick(e) {
    var t = e.target instanceof Element ? e.target.closest('[data-sa-act]') : null;
    if (!t || !S.el || !S.el.contains(t)) return;
    e.preventDefault(); e.stopPropagation();
    var act = t.getAttribute('data-sa-act');
    if (act === 'retry') { S.todayP = null; S.profileP = S.profile ? S.profileP : null; S.leaves = {}; S.att = {}; paint(); }
    else if (act === 'month') {
      var next = shiftMonth(S.month, +t.getAttribute('data-dir'));
      if (next > todayYmd().slice(0, 7)) return;
      S.month = next; S.logAll = false; paint();
    } else if (act === 'filter') { var k = t.getAttribute('data-k'); S.attFilter = S.attFilter === k ? '' : k; S.logAll = false; paintAttendanceData(++S.seq); }
    else if (act === 'logall') { S.logAll = !S.logAll; paintAttendanceData(++S.seq); }
    else if (act === 'ltab') { S.leaveTab = t.getAttribute('data-k'); paintLeaveData(++S.seq); }
    else if (act === 'cancel') { if (M()) M().open('leave', t.getAttribute('data-id'), { intent: 'cancel' }); }
    else if (act === 'email') toast('Email is managed by your administrator.', 'warn');
  }
  function onChange(e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (t.matches('[data-sa-year]')) { S.leaveYear = +t.value || new Date().getFullYear(); paintLeaveData(++S.seq); }
    else if (t.matches('[data-sa-notify]')) {
      store('kj.staff.notify', t.checked ? 'on' : 'off');
      S.unread = -1; ensureBell(); pollTick();
      toast(t.checked ? 'Notifications on' : 'Notifications muted', t.checked ? 'success' : 'warn');
    } else if (t.matches('[data-sa-photo]')) uploadPhoto(t.files && t.files[0]);
  }

  window.KJPages.register('staff-app', {
    title: 'My attendance app',
    perm: '',                     // every signed-in user
    shell: 'staff',
    defaultSub: 'home',
    routes: { 'app-home': 'home', 'app-attendance': 'attendance', 'app-leave': 'leave', 'app-profile': 'profile' },
    subs: {
      home:       { label: 'Home' },
      attendance: { label: 'Attendance' },
      leave:      { label: 'Leave' },
      profile:    { label: 'Profile' }
    },

    mount: function (el, route) {
      registerModals();
      S.el = el; S.sub = route.sub;
      el.addEventListener('click', onClick);
      el.addEventListener('change', onChange);
      paint();
      if (route.sub === 'home') {
        S.clock = setInterval(function () {
          var c = el.querySelector('[data-sa-clock]'), a = el.querySelector('[data-sa-ampm]');
          if (!c || !c.isConnected) return;
          var p = clockParts(); c.textContent = p.t; if (a) a.textContent = p.ap;
        }, 1000);
      }
      ensureBell(); syncShellAvatar(); startPoll();
      // Icons come from a deferred vendor script: repaint once it has loaded.
      if (!window.lucide && document.readyState !== 'complete') {
        window.addEventListener('load', function () { if (S.el === el) { S.el.removeAttribute('data-sa-sub'); paint(); ensureBell(); } }, { once: true });
      }
    },
    unmount: function (el) {
      if (S.clock) { clearInterval(S.clock); S.clock = null; }
      el.removeEventListener('click', onClick);
      el.removeEventListener('change', onChange);
      destroyLottie(el);
      S.el = null; S.seq++;
      el.removeAttribute('data-sa-sub');
      // The poller stops itself once the staff shell is no longer active.
    },
    onFeed: function () {
      if (S.el && S.sub === 'home' && Date.now() - S.todayAt > 60000) paintHomeData(S.seq);
    }
  });

  /*  MODAL TYPES  */
  var registered = false;
  function registerModals() {
    var K = M();
    if (registered || !K) return;
    registered = true;
    var h = K.h;
    function busy(btn, on) { if (!btn) return; btn.disabled = !!on; btn.classList.toggle('is-busy', !!on); }
    function errLine(ctx, msg) {
      var e = ctx.body.querySelector('[data-sa-err]');
      if (!e) return;
      e.hidden = !msg; e.textContent = msg || '';
    }

    /* leave - M6 request detail (overrides the generic kj-modal renderer) */
    K.register('leave', {
      kicker: 'Leave request', icon: 'calendar-days', size: 'md',
      load: function (ctx) {
        return req('GET', '/leaves/' + encodeURIComponent(String(ctx.id))).then(function (d) { return { lv: d.leave }; })
          .catch(function (e) { if (e.status === 404) return { lv: null }; throw e; });
      },
      render: function (ctx, d) {
        var lv = d.lv;
        if (!lv) return { title: 'Leave request', body: emptyBox({ title: 'Leave request not found', text: 'It may have been removed, or it is outside your team.', actions: [navBtn('app-leave', 'My leave', 'calendar-days', true)] }) };
        var t = ltype(lv.leave_type), st = LSTATUS[lv.status] || [lv.status, ''], can = lv.can || {}, bal = lv.balance || {};
        var steps = [['Submitted', lv.submitted_at || lv.created_at, lv.user_name, '', 'send', 'done']];
        if (lv.status === 'approved' || lv.status === 'rejected') steps.push([st[0], lv.decided_at, lv.approver, lv.approver_remarks, lv.status === 'approved' ? 'circle-check' : 'circle-x', lv.status]);
        else if (lv.status === 'pending') steps.push(['Awaiting approval', '', 'Your supervisor', '', 'hourglass', 'wait']);
        if (lv.status === 'cancelled') { if (lv.decided_at) steps.push(['Decided', lv.decided_at, lv.approver, lv.approver_remarks, 'gavel', 'done']); steps.push(['Cancelled', lv.cancelled_at, lv.cancelled_by, lv.cancel_remarks, 'ban', 'cancelled']); }
        var atts = (lv.attachments || []).map(function (a) {
          var img = /^image\//.test(a.mime || '');
          return img ? '<button type="button" class="kj-sa-att" data-kj-modal="image:' + esc(a.url) + '">' + ico('image') + '<span class="kj-sa-grow kj-truncate">' + esc(a.filename) + '</span><small>' + esc(Math.round((a.size || 0) / 1024)) + ' KB</small></button>'
            : '<a class="kj-sa-att" href="' + esc(a.url) + '" target="_blank" rel="noopener">' + ico('file-text') + '<span class="kj-sa-grow kj-truncate">' + esc(a.filename) + '</span><small>' + esc(Math.round((a.size || 0) / 1024)) + ' KB</small></a>';
        }).join('');
        var body =
          '<div class="kj-sa-lv-hero is-' + t.tone + '"><span class="kj-sa-req-ico is-' + t.tone + '">' + ico(t.icon) + '</span><div class="kj-sa-grow">' +
            '<div class="kj-sa-lv-range">' + esc(fmtRange(lv.start_date, lv.end_date)) + '</div>' +
            '<div class="kj-sa-muted">' + esc((lv.half_day ? 'Half day \u00b7 ' + String(lv.half_day_period || '').toUpperCase() : days(lv.days)) + ' \u00b7 ' + (lv.leave_no || '')) + '</div></div>' +
            '<span class="kj-chip is-' + (st[1] || 'muted') + '">' + esc(st[0]) + '</span></div>' +
          (!lv.is_mine ? '<div class="kj-card kj-sa-mt">' + h.kv([['Requester', lv.user_name], ['Department', lv.department]]) + '</div>' : '') +
          (lv.missing_attachment ? '<div class="kj-sa-note is-warn">' + ico('triangle-alert') + '<span>Medical leave needs an MC. ' + (can.attach ? 'Attach a photo of it below.' : 'The requester has not attached one yet.') + '</span></div>' : '') +
          h.section('Progress', '<ol class="kj-sa-steps-v">' + steps.map(function (s) {
            return '<li class="is-' + s[5] + '"><span class="kj-sa-step-dot">' + ico(s[4]) + '</span><div><div class="kj-sa-strong">' + esc(s[0]) + '</div>' +
              '<div class="kj-sa-muted">' + esc([s[2], s[1] ? fmtStamp(s[1]) : ''].filter(Boolean).join(' \u00b7 ')) + '</div>' +
              (s[3] ? '<div class="kj-sa-remark">\u201c' + esc(s[3]) + '\u201d</div>' : '') + '</div></li>';
          }).join('') + '</ol>') +
          (lv.reason ? h.section('Reason', '<div class="kj-card-flat kj-sa-quote">' + esc(lv.reason) + '</div>') : '') +
          (bal.code ? h.section((lv.is_mine ? 'Your ' : '') + (bal.name || 'Leave') + ' balance ' + (bal.year || ''), '<div class="kj-sa-balrow">' +
            '<span><b>' + (bal.unlimited ? '\u221e' : esc(bal.available)) + '</b><small>available</small></span><span><b>' + esc(bal.used) + '</b><small>used</small></span>' +
            '<span><b>' + esc(bal.pending) + '</b><small>pending</small></span><span><b>' + (bal.unlimited ? '\u221e' : esc(bal.entitled)) + '</b><small>entitled</small></span></div>') : '') +
          ((atts || can.attach) ? h.section('Attachments', (atts ? '<div class="kj-sa-atts">' + atts + '</div>' : '') +
            (can.attach ? '<label class="kj-btn kj-btn-secondary kj-btn-sm kj-sa-mt kj-sa-filebtn">' + ico('paperclip') + '<span>Attach MC / document</span>' +
              '<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" data-sa-lvfile class="kj-sr-only"></label>' : '')) : '') +
          '<div class="kj-sa-decide" data-sa-decide hidden><label class="kj-field"><span class="kj-label" data-sa-decide-lbl>Remarks</span>' +
            '<textarea class="kj-textarea kj-sa-textarea" rows="3" maxlength="500" data-sa-remarks></textarea></label>' +
            '<div class="kj-sa-err" data-sa-err role="alert" hidden></div></div>';
        var foot = '', actions = {};
        function showDecide(mode) {
          return function (c) {
            c.mode = mode;
            var box = c.body.querySelector('[data-sa-decide]');
            box.hidden = false;
            c.body.querySelector('[data-sa-decide-lbl]').textContent = mode === 'reject' ? 'Reason for rejecting (required)' : mode === 'cancel' ? 'Reason for cancelling (optional)' : 'Remarks for the requester (optional)';
            c.foot.innerHTML = '<button type="button" class="kj-btn kj-btn-secondary" data-kj-action="back">' + ico('undo-2') + 'Back</button>' +
              '<button type="button" class="kj-btn ' + (mode === 'approve' ? 'kj-btn-primary' : 'kj-btn-danger') + '" data-kj-action="confirm">' + ico(mode === 'approve' ? 'check' : 'x') +
              (mode === 'approve' ? 'Confirm approval' : mode === 'reject' ? 'Confirm rejection' : 'Cancel this request') + '</button>';
            var ta = c.body.querySelector('[data-sa-remarks]'); if (ta) { ta.focus(); box.scrollIntoView && box.scrollIntoView({ block: 'nearest' }); }
          };
        }
        if (can.approve) { foot += h.btn('approve', 'Approve', 'check', 'kj-btn-primary'); actions.approve = showDecide('approve'); }
        if (can.reject) { foot += h.btn('reject', 'Reject', 'x', 'kj-btn-danger'); actions.reject = showDecide('reject'); }
        if (can.cancel) { foot += h.btn('cancel', 'Cancel request', 'ban', 'kj-btn-secondary'); actions.cancel = showDecide('cancel'); }
        if (lv.is_mine && S.sub !== 'leave') foot += '<button type="button" class="kj-btn kj-btn-ghost" data-kj-nav="app-leave">' + ico('calendar-days') + 'All my leave</button>';
        actions.back = function (c) { c.reload(); };
        actions.confirm = function (c, btn) {
          var ta = c.body.querySelector('[data-sa-remarks]'), rm = ta ? ta.value.trim() : '';
          if (c.mode === 'reject' && rm.length < 3) { errLine(c, 'Please give a reason (at least 3 characters).'); if (ta) ta.focus(); return; }
          busy(btn, true); errLine(c, '');
          req('POST', '/leaves/' + lv.id + '/' + c.mode, null, { remarks: rm }).then(function () {
            toast(c.mode === 'approve' ? 'Leave approved' : c.mode === 'reject' ? 'Leave rejected' : 'Leave request cancelled', c.mode === 'approve' ? 'success' : 'warn');
            leavesChanged(); c.reload();
          }).catch(function (e) { busy(btn, false); errLine(c, e.message || 'Could not update this request.'); });
        };
        return {
          title: (lv.leave_type_name || 'Leave') + (lv.is_mine ? '' : ' \u00b7 ' + lv.user_name), kicker: 'Leave request ' + (lv.leave_no || ''),
          icon: t.icon, tone: st[1] === 'muted' ? '' : (st[1] === 'primary' ? '' : st[1]), body: body, foot: foot, actions: actions,
          mount: function (c) {
            var f = c.body.querySelector('[data-sa-lvfile]');
            if (f) f.addEventListener('change', function () {
              var file = f.files && f.files[0]; if (!file) return;
              var lbl = f.closest('label'); if (lbl) lbl.classList.add('is-busy');
              var fd = new FormData(); fd.append('file', file);
              req('POST', '/leaves/' + lv.id + '/attachments', null, fd).then(function () { toast('Attachment uploaded', 'success'); leavesChanged(); c.reload(); })
                .catch(function (e) { if (lbl) lbl.classList.remove('is-busy'); toast(e.message || 'Upload failed', 'danger'); });
            });
            if (c.data && c.data.intent === 'cancel' && can.cancel) { c.data.intent = ''; actions.cancel(c); }
          }
        };
      }
    });

    /* staff-leave-apply - 3-step wizard (type -> dates -> details), id = 'new' | leave type code */
    K.register('staff-leave-apply', {
      kicker: 'Apply leave', icon: 'calendar-plus', size: 'md', deepLink: false,
      load: function () {
        return Promise.all([getLeaves(new Date().getFullYear()), soft(getTypes())]).then(function (x) { return { bal: x[0].balances || [], types: x[1] || [] }; });
      },
      render: function (ctx, d) {
        var W = ctx.wiz = ctx.wiz || { step: 1, type: '', start: '', end: '', half: false, period: 'am', reason: '', file: null };
        var pre = String(ctx.id || '').toUpperCase();
        if (!W.type && d.bal.some(function (b) { return b.code === pre; })) W.type = pre;
        var req1 = {};
        d.types.forEach(function (t) { req1[t.code] = !!Number(t.requires_attachment); });
        var nxt = new Date(); while (isWeekend(nxt)) nxt = addDays(nxt, 1);
        if (!W.start) { W.start = ymd(nxt); W.end = W.start; }
        var min = ymd(addDays(new Date(), -30)), max = ymd(addDays(new Date(), 365));
        var opts = d.bal.map(function (b) {
          var t = ltype(b.code), on = W.type === b.code;
          return '<button type="button" class="kj-sa-opt is-' + t.tone + (on ? ' is-on' : '') + '" data-sa-type="' + esc(b.code) + '" aria-pressed="' + on + '">' +
            '<span class="kj-sa-req-ico is-' + t.tone + '">' + ico(t.icon) + '</span><span class="kj-sa-grow"><span class="kj-sa-strong">' + esc(b.name) + '</span>' +
            '<span class="kj-sa-muted">' + (b.unlimited ? 'No balance limit' : esc(b.available) + ' of ' + esc(b.entitled) + ' days left') + (req1[b.code] ? ' \u00b7 MC required' : '') + '</span></span>' +
            '<span class="kj-sa-opt-check">' + ico('check') + '</span></button>';
        }).join('');
        var body =
          '<div class="kj-sa-wiz" data-step="' + W.step + '">' +
            '<ol class="kj-sa-wsteps"><li data-n="1">Type</li><li data-n="2">Dates</li><li data-n="3">Details</li></ol>' +
            '<div class="kj-sa-pane" data-pane="1"><div class="kj-sa-opts">' + (opts || '<div class="kj-sa-muted">No leave types available.</div>') + '</div></div>' +
            '<div class="kj-sa-pane" data-pane="2">' +
              '<div class="kj-sa-dates"><label class="kj-field"><span class="kj-label">From</span><input type="date" class="kj-input" data-sa-f="start" min="' + min + '" max="' + max + '" value="' + esc(W.start) + '"></label>' +
              '<label class="kj-field"><span class="kj-label">To</span><input type="date" class="kj-input" data-sa-f="end" min="' + min + '" max="' + max + '" value="' + esc(W.end) + '"></label></div>' +
              '<label class="kj-sa-pf-row kj-sa-switch-row kj-sa-half">' + ico('sun', 'kj-sa-pf-ico') + '<span class="kj-sa-grow"><span class="kj-sa-strong">Half day</span><span class="kj-sa-muted" data-sa-halfhint>Single date only</span></span>' +
                '<input type="checkbox" class="kj-sa-switch" role="switch" data-sa-f="half"' + (W.half ? ' checked' : '') + '></label>' +
              '<div class="kj-sa-seg kj-sa-period" data-sa-period' + (W.half ? '' : ' hidden') + '>' +
                '<button type="button" class="kj-sa-seg-btn' + (W.period === 'am' ? ' is-active' : '') + '" data-sa-p="am">' + ico('sunrise') + 'Morning (AM)</button>' +
                '<button type="button" class="kj-sa-seg-btn' + (W.period === 'pm' ? ' is-active' : '') + '" data-sa-p="pm">' + ico('sunset') + 'Afternoon (PM)</button></div>' +
              '<div class="kj-sa-sum" data-sa-sum></div>' +
            '</div>' +
            '<div class="kj-sa-pane" data-pane="3">' +
              '<div class="kj-sa-review" data-sa-review></div>' +
              '<label class="kj-field"><span class="kj-label">Reason <small class="kj-sa-muted">(optional)</small></span>' +
                '<textarea class="kj-textarea kj-sa-textarea" rows="3" maxlength="500" data-sa-f="reason" placeholder="e.g. Family matter, clinic visit">' + esc(W.reason) + '</textarea></label>' +
              '<label class="kj-sa-drop" data-sa-drop><input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" capture="environment" data-sa-f="file" class="kj-sr-only">' +
                ico('camera', 'kj-sa-drop-ico') + '<span class="kj-sa-grow"><span class="kj-sa-strong" data-sa-filename>Attach MC / document</span><span class="kj-sa-muted" data-sa-filehint>Photo or PDF, up to 10 MB</span></span>' + ico('paperclip') + '</label>' +
            '</div>' +
            '<div class="kj-sa-pane kj-sa-done" data-pane="4">' + lottie('sent', 'send', 'kj-sa-lottie-xl') +
              '<div class="kj-sa-done-title">Request sent!</div><div class="kj-sa-muted" data-sa-donetext>Your supervisor has been notified.</div></div>' +
            '<div class="kj-sa-err" data-sa-err role="alert" hidden></div>' +
          '</div>';
        function q(s) { return ctx.body.querySelector(s); }
        function summary() {
          var n = W.half ? 0.5 : workingDays(W.start, W.end), b = d.bal.filter(function (x) { return x.code === W.type; })[0];
          var over = b && !b.unlimited && n > Number(b.available);
          var sum = q('[data-sa-sum]');
          if (sum) sum.innerHTML = '<span class="kj-sa-sum-n' + (over ? ' is-danger' : '') + '">' + esc(n % 1 ? n.toFixed(1) : n) + '</span><span><b>' + (n === 1 ? 'working day' : 'working days') + '</b>' +
            '<span class="kj-sa-muted">' + esc(fmtRange(W.start, W.end) + (b && !b.unlimited ? ' \u00b7 ' + Math.max(0, Number(b.available) - n) + ' left after this' : '')) + '</span></span>';
          var single = W.start && W.start === W.end;
          var half = q('[data-sa-f="half"]');
          if (half) { half.disabled = !single; if (!single && W.half) { W.half = false; half.checked = false; q('[data-sa-period]').hidden = true; } }
          var hh = q('[data-sa-halfhint]'); if (hh) hh.textContent = single ? 'Take only the morning or afternoon off' : 'Single date only';
          return { n: n, over: over, b: b };
        }
        function go(step) {
          W.step = step;
          q('.kj-sa-wiz').setAttribute('data-step', step);
          errLine(ctx, '');
          if (step === 2) summary();
          if (step === 3) {
            var s = summary(), t = ltype(W.type);
            q('[data-sa-review]').innerHTML = '<span class="kj-sa-req-ico is-' + t.tone + '">' + ico(t.icon) + '</span><div class="kj-sa-grow"><div class="kj-sa-strong">' + esc(s.b ? s.b.name : W.type) + '</div>' +
              '<div class="kj-sa-muted">' + esc(fmtRange(W.start, W.end) + ' \u00b7 ' + (W.half ? 'Half day (' + W.period.toUpperCase() + ')' : days(s.n))) + '</div></div>' +
              '<button type="button" class="kj-sa-link" data-kj-action="edit">Edit</button>';
            var hint = q('[data-sa-filehint]');
            if (hint && req1[W.type] && !W.file) hint.textContent = 'Required for ' + (s.b ? s.b.name : 'this leave') + ' \u2014 snap your MC';
            q('[data-sa-drop]').classList.toggle('is-required', !!req1[W.type] && !W.file);
          }
          if (step === 4) hydrateLottie(ctx.body);
          ctx.foot.innerHTML = step === 4
            ? '<button type="button" class="kj-btn kj-btn-secondary" data-kj-action="view">' + ico('eye') + 'View request</button><button type="button" class="kj-btn kj-btn-primary" data-kj-action="done">' + ico('check') + 'Done</button>'
            : (step > 1 ? '<button type="button" class="kj-btn kj-btn-secondary" data-kj-action="back">' + ico('chevron-left') + 'Back</button>' : '<button type="button" class="kj-btn kj-btn-ghost" data-kj-close>Cancel</button>') +
              (step < 3 ? '<button type="button" class="kj-btn kj-btn-primary" data-kj-action="next">Next' + ico('chevron-right') + '</button>'
                : '<button type="button" class="kj-btn kj-btn-primary" data-kj-action="submit">' + ico('send') + 'Submit request</button>');
          var pane = q('[data-pane="' + step + '"]'); if (pane && pane.scrollIntoView) pane.scrollIntoView({ block: 'nearest' });
        }
        function validate() {
          if (W.step === 1 && !W.type) return 'Choose a leave type.';
          if (W.step === 2) {
            if (!W.start || !W.end) return 'Pick your dates.';
            if (W.end < W.start) return 'The end date is before the start date.';
            var s = summary();
            if (!s.n) return 'Those dates fall on a weekend \u2014 no working days to take.';
            if (s.over) return 'Only ' + s.b.available + ' ' + s.b.name + ' days left for ' + W.start.slice(0, 4) + '.';
          }
          return '';
        }
        return {
          title: 'New leave request', kicker: 'Apply leave', icon: 'calendar-plus', body: body,
          actions: {
            next: function () { var e = validate(); if (e) { errLine(ctx, e); return; } go(W.step + 1); },
            back: function () { go(Math.max(1, W.step - 1)); },
            edit: function () { go(2); },
            done: function (c) { c.close(); },
            view: function (c) { var id = W.created; c.close(); if (id) { P().go('app-leave'); setTimeout(function () { K.open('leave', id); }, 0); } },
            submit: function (c, btn) {
              if (req1[W.type] && !W.file) { errLine(c, 'Please attach your MC \u2014 tap the camera box above.'); return; }
              busy(btn, true); errLine(c, '');
              var payload = { leave_type: W.type, start_date: W.start, end_date: W.end, half_day: W.half ? 1 : 0, half_day_period: W.half ? W.period : null, reason: W.reason };
              req('POST', '/leaves', null, payload).then(function (r) {
                var lv = r.leave || {}; W.created = lv.id;
                var up = (W.file && lv.id) ? (function () { var fd = new FormData(); fd.append('file', W.file); return req('POST', '/leaves/' + lv.id + '/attachments', null, fd).then(function () { return true; }, function () { return false; }); })() : Promise.resolve(true);
                return up.then(function (ok) {
                  var dt = q('[data-sa-donetext]');
                  if (dt) dt.textContent = (lv.leave_no ? lv.leave_no + ' \u00b7 ' : '') + 'Your supervisor has been notified.' + (ok ? '' : ' The attachment failed \u2014 add it from the request.');
                  if (!ok) toast('Request sent, but the attachment failed to upload.', 'warn');
                  leavesChanged(); go(4);
                });
              }).catch(function (e) { busy(btn, false); errLine(c, e.message || 'Could not submit the request.'); });
            }
          },
          mount: function (c) {
            go(W.step);
            c.body.addEventListener('click', function (e) {
              var o = e.target.closest('[data-sa-type]');
              if (o) {
                W.type = o.getAttribute('data-sa-type');
                Array.prototype.forEach.call(c.body.querySelectorAll('[data-sa-type]'), function (x) { var on = x === o; x.classList.toggle('is-on', on); x.setAttribute('aria-pressed', on); });
                errLine(c, ''); setTimeout(function () { if (W.step === 1) go(2); }, 160);
                return;
              }
              var p = e.target.closest('[data-sa-p]');
              if (p) { W.period = p.getAttribute('data-sa-p'); Array.prototype.forEach.call(c.body.querySelectorAll('[data-sa-p]'), function (x) { x.classList.toggle('is-active', x === p); }); }
            });
            c.body.addEventListener('input', function (e) {
              var k = e.target.getAttribute && e.target.getAttribute('data-sa-f');
              if (k === 'start') { W.start = e.target.value; if (!W.end || W.end < W.start) { W.end = W.start; q('[data-sa-f="end"]').value = W.end; } summary(); }
              else if (k === 'end') { W.end = e.target.value; summary(); }
              else if (k === 'reason') W.reason = e.target.value;
            });
            c.body.addEventListener('change', function (e) {
              var k = e.target.getAttribute && e.target.getAttribute('data-sa-f');
              if (k === 'half') { W.half = e.target.checked; q('[data-sa-period]').hidden = !W.half; summary(); }
              else if (k === 'file') {
                var f = e.target.files && e.target.files[0];
                if (f && f.size > 10 * 1024 * 1024) { errLine(c, 'That file is larger than 10 MB.'); e.target.value = ''; return; }
                W.file = f || null;
                q('[data-sa-filename]').textContent = f ? f.name : 'Attach MC / document';
                q('[data-sa-filehint]').textContent = f ? Math.round(f.size / 1024) + ' KB \u00b7 tap to change' : 'Photo or PDF, up to 10 MB';
                q('[data-sa-drop]').classList.toggle('is-filled', !!f);
                q('[data-sa-drop]').classList.remove('is-required');
                errLine(c, '');
              }
            });
          }
        };
      }
    });

    /* staff-notifs - in-app notifications; opening marks the shown unread rows read */
    K.register('staff-notifs', {
      kicker: 'Notifications', icon: 'bell', size: 'sm', deepLink: false,
      load: function (ctx) { return req('GET', '/notifications', { all: 1, limit: (ctx.data && ctx.data.limit) || 30 }); },
      render: function (ctx, d) {
        var list = d.notifications || [];
        var KIND = { leave_submitted: ['send', 'warn'], leave_approved: ['circle-check', 'success'], leave_rejected: ['circle-x', 'danger'], leave_cancelled: ['ban', ''], ticket_assigned: ['ticket', 'primary'] };
        var body = list.length ? '<div class="kj-sa-notifs">' + list.map(function (n, i) {
          var k = KIND[n.kind] || ['bell', 'primary'];
          return '<button type="button" class="kj-sa-notif' + (n.read ? '' : ' is-unread') + '" data-sa-n="' + i + '"><span class="kj-sa-req-ico is-' + (k[1] || 'muted') + '">' + ico(k[0]) + '</span>' +
            '<span class="kj-sa-grow"><span class="kj-sa-strong">' + esc(n.title) + '</span>' + (n.body ? '<span class="kj-sa-muted kj-sa-clamp">' + esc(n.body) + '</span>' : '') +
            '<span class="kj-sa-notif-time">' + esc(ago(n.created_at)) + '</span></span>' + ico('chevron-right', 'kj-sa-chev') + '</button>';
        }).join('') + '</div>'
          : emptyBox({ anim: 'success', icon: 'bell', title: 'You\u2019re all caught up', text: 'Leave decisions and ticket updates will show up here.', actions: [navBtn('app-leave', 'My leave', 'calendar-days')] });
        var unread = list.filter(function (n) { return !n.read; }).map(function (n) { return n.id; });
        return {
          title: 'Notifications', kicker: d.unread_count ? d.unread_count + ' unread' : 'Inbox', icon: 'bell', body: body,
          foot: list.length >= ((ctx.data && ctx.data.limit) || 30) ? '<button type="button" class="kj-btn kj-btn-ghost" data-kj-action="all">' + ico('history') + 'Show older</button>' : '',
          actions: { all: function (c) { c.data.limit = 100; c.reload(); } },
          mount: function (c) {
            hydrateLottie(c.body);
            if (unread.length) req('POST', '/notifications/read', null, { ids: unread }).then(function (r) { S.unread = -1; setBadge(r.unread_count); }).catch(function () { /* stays unread */ });
            c.body.addEventListener('click', function (e) {
              var row = e.target.closest('[data-sa-n]'); if (!row) return;
              var n = list[+row.getAttribute('data-sa-n')]; if (!n) return;
              row.classList.remove('is-unread');
              if (n.ref_type === 'leave' && n.ref_id) {
                K.closeAll({ noHash: true });
                var mine = /approved|rejected/.test(n.kind) || (n.kind === 'leave_cancelled' && !P().allowed('attendance'));
                if (mine || !P().allowed('attendance')) P().go('app-leave');
                setTimeout(function () { K.open('leave', n.ref_id); }, 0);
              } else if (n.ref_type === 'ticket' && n.ref_id) K.open('ticket', n.ref_id);
              else if (n.link && /^#/.test(n.link)) { K.closeAll({ noHash: true }); location.hash = n.link; }
            });
          }
        };
      }
    });

    /* staff-day - one of my attendance days (id = YYYY-MM-DD | today) */
    K.register('staff-day', {
      kicker: 'My attendance', icon: 'calendar-check', size: 'sm', deepLink: false,
      load: function (ctx) {
        var date = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.id)) ? String(ctx.id) : todayYmd();
        if (date === todayYmd()) {
          return Promise.all([getToday(true), soft(getMonth(date.slice(0, 7)))]).then(function (x) {
            var t = x[0], r = t.row, m = x[1] && x[1].byDate[date];
            if (m && m.status === 'leave') r = Object.assign({}, r || {}, m);
            return { date: date, linked: t.linked, r: r ? { status: r.status, clockIn: r.clockIn, inLoc: r.clockInLoc || r.inLoc, clockOut: r.clockOut, outLoc: r.clockOutLoc || r.outLoc,
              hours: r.hours, lateMin: r.lateMin, shift: r.shift ? r.shift + (r.shiftStart ? ' ' + r.shiftStart + '\u2013' + r.shiftEnd : '') : '', flags: (r.flags || []).join ? (r.flags || []).join(', ') : r.flags, leave: r.leave } : null };
          });
        }
        return getMonth(date.slice(0, 7)).then(function (m) { return { date: date, linked: m.linked, r: m.byDate[date] || null }; });
      },
      render: function (ctx, d) {
        var r = d.r, dt = parseYmd(d.date), title = dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
        if (!d.linked) return { title: title, body: emptyBox({ icon: 'user-x', title: 'Not linked to an employee', text: 'Ask HR to link your login to your staff record so your attendance shows here.', actions: ['<a class="kj-btn kj-btn-primary kj-btn-sm" href="/kiosk.php">' + ico('scan-face') + '<span>Face check-in</span></a>'] }) };
        if (!r) return { title: title, body: emptyBox({ icon: 'calendar-x', title: isWeekend(dt) ? 'Weekend' : 'No record for this day', text: isWeekend(dt) ? 'No shift was scheduled.' : 'No check-in was recorded.', actions: [navBtn('app-attendance', 'My attendance', 'calendar-check', true)] }) };
        var st = STATUS[r.status] || STATUS.pending;
        var today = d.date === todayYmd();
        return {
          title: title, kicker: 'My attendance', icon: st[2], tone: st[1] === 'primary' || st[1] === 'info' ? '' : st[1],
          body: '<div class="kj-sa-day-hero is-' + r.status + '">' + ico(st[2], 'kj-sa-day-ico') + '<div class="kj-sa-grow"><div class="kj-sa-strong">' + esc(r.status === 'leave' && r.leave ? r.leave.type : st[0]) + '</div>' +
              '<div class="kj-sa-muted">' + esc(r.status === 'late' && r.lateMin ? r.lateMin + ' min after shift start' : (r.shift || '')) + '</div></div></div>' +
            '<div class="kj-sa-day-times"><div><small>' + ico('log-in') + 'Check-in</small><b>' + esc(hm(r.clockIn) || '\u2014') + '</b><span class="kj-sa-muted">' + esc(r.inLoc || '') + '</span></div>' +
              '<div><small>' + ico('log-out') + 'Check-out</small><b>' + esc(hm(r.clockOut) || '\u2014') + '</b><span class="kj-sa-muted">' + esc(r.outLoc || '') + '</span></div>' +
              '<div><small>' + ico('timer') + 'Total</small><b>' + esc(fmtHours(r.hours)) + '</b><span class="kj-sa-muted">' + esc(r.hours ? 'on site' : '') + '</span></div></div>' +
            (r.flags ? '<div class="kj-sa-note is-warn">' + ico('triangle-alert') + '<span>' + esc(String(r.flags).replace(/missing_out/, 'Missing check-out').replace(/early_out/, 'Early check-out').replace(/off_day/, 'Worked on an off day')) + '</span></div>' : ''),
          foot: (r.leave && r.leave.id ? '<button type="button" class="kj-btn kj-btn-secondary" data-kj-modal="leave:' + r.leave.id + '">' + ico('calendar-days') + 'View leave</button>' : '') +
            (today && !r.clockOut && r.status !== 'leave' && r.status !== 'off' ? '<a class="kj-btn kj-btn-primary" href="/kiosk.php">' + ico('fingerprint') + (r.clockIn ? 'Check out' : 'Check in') + '</a>' : '')
        };
      }
    });

    /* staff-tickets - my tickets list (rows open the shared `ticket` modal) */
    K.register('staff-tickets', {
      kicker: 'My tickets', icon: 'ticket', size: 'sm', deepLink: false,
      load: function () { return req('GET', '/tickets', { mine: 1, limit: 50 }); },
      render: function (ctx, d) {
        var TS = { 'new': ['New', 'primary'], ack: ['Acknowledged', 'info'], in_progress: ['In progress', 'warn'], resolved: ['Resolved', 'success'], closed: ['Closed', ''] };
        var list = d.tickets || [];
        return {
          title: 'My tickets', kicker: list.length + ' total', icon: 'ticket',
          body: list.length ? '<div class="kj-sa-notifs">' + list.map(function (t) {
            var s = TS[t.status] || [t.status, ''], br = t.sla && ((t.sla.response && t.sla.response.breached) || (t.sla.resolution && t.sla.resolution.breached));
            return '<button type="button" class="kj-sa-notif" data-kj-modal="ticket:' + t.id + '"><span class="kj-sa-req-ico is-' + (s[1] || 'muted') + '">' + ico('ticket') + '</span>' +
              '<span class="kj-sa-grow"><span class="kj-sa-strong kj-sa-clamp">' + esc(t.title) + '</span><span class="kj-sa-muted">' + esc((t.ticket_no || '#' + t.id) + ' \u00b7 ' + ago(t.created_at)) + '</span>' +
              '<span class="kj-row-wrap kj-sa-mt">' + chip(s[0], s[1]) + (t.priority ? chip(String(t.priority).toUpperCase(), '') : '') + (br ? chip('SLA breached', 'danger') : '') + '</span></span>' + ico('chevron-right', 'kj-sa-chev') + '</button>';
          }).join('') + '</div>'
            : emptyBox({ icon: 'ticket', title: 'No tickets yet', text: 'Tickets you raise, or that are raised about you, appear here.', actions: [navBtn('app-home', 'Back to home', 'house')] }),
          mount: function (c) { hydrateLottie(c.body); }
        };
      }
    });

    /* staff-profile-edit - self-service fields (POST /profile); id = field to focus */
    K.register('staff-profile-edit', {
      kicker: 'Edit profile', icon: 'user-pen', size: 'sm', deepLink: false,
      load: function () { return getProfile(); },
      render: function (ctx, p) {
        var ec = p.emergency_contact || {};
        function f(k, label, val, type, ph, auto) {
          return '<label class="kj-field"><span class="kj-label">' + esc(label) + '</span><input class="kj-input kj-sa-input" name="' + k + '" type="' + (type || 'text') + '" value="' + esc(val || '') + '"' +
            (ph ? ' placeholder="' + esc(ph) + '"' : '') + (auto ? ' autocomplete="' + auto + '"' : '') + ' maxlength="120"></label>';
        }
        var rel = ['', 'Spouse', 'Parent', 'Sibling', 'Child', 'Relative', 'Friend', 'Other'];
        return {
          title: 'Personal information', icon: 'user-pen',
          body: '<form class="kj-sa-form" data-sa-form novalidate>' +
            f('display_name', 'Display name', p.display_name || '', 'text', 'Your name', 'name') +
            f('phone', 'Phone', p.phone, 'tel', '+60 12-345 6789', 'tel') +
            '<div class="kj-sa-form-sec">' + ico('users') + 'Emergency contact</div>' +
            f('emergency_name', 'Name', ec.name, 'text', 'Full name') +
            f('emergency_phone', 'Phone', ec.phone, 'tel', '+60 12-987 6543') +
            '<label class="kj-field"><span class="kj-label">Relationship</span><select class="kj-select kj-sa-input" name="emergency_relation">' +
              rel.concat(ec.relation && rel.indexOf(ec.relation) < 0 ? [ec.relation] : []).map(function (r) { return '<option value="' + esc(r) + '"' + (r === (ec.relation || '') ? ' selected' : '') + '>' + esc(r || 'Choose\u2026') + '</option>'; }).join('') + '</select></label>' +
            '<div class="kj-sa-err" data-sa-err role="alert" hidden></div></form>',
          foot: '<button type="button" class="kj-btn kj-btn-ghost" data-kj-close>Cancel</button>' + h.btn('save', 'Save changes', 'check', 'kj-btn-primary'),
          actions: {
            save: function (c, btn) {
              var form = c.body.querySelector('[data-sa-form]'), out = {};
              Array.prototype.forEach.call(form.elements, function (el) { if (el.name) out[el.name] = el.value.trim(); });
              var bad = ['phone', 'emergency_phone'].filter(function (k) { return out[k] && !/^[+\d][\d\s\-()]{5,}$/.test(out[k]); })[0];
              if (bad) { errLine(c, 'Please enter a valid phone number.'); var el = form.elements[bad]; if (el) el.focus(); return; }
              busy(btn, true); errLine(c, '');
              req('POST', '/profile', null, out).then(function (r) {
                S.profile = Object.assign({}, S.profile || {}, r.profile || {});
                if (window.TMNS && window.TMNS.user && S.profile.display_name) window.TMNS.user.name = S.profile.display_name;
                S.profileP = Promise.resolve(S.profile);
                toast('Profile saved', 'success'); syncShellAvatar(); c.close();
                if (S.el && (S.sub === 'profile' || S.sub === 'home')) paint();
              }).catch(function (e) { busy(btn, false); errLine(c, e.message || 'Could not save.'); });
            }
          },
          mount: function (c) {
            var k = String(ctx.id || ''), el = c.body.querySelector('[name="' + (k === 'me' ? 'display_name' : k) + '"]');
            if (el) setTimeout(function () { el.focus(); }, 60);
            c.body.querySelector('[data-sa-form]').addEventListener('submit', function (e) { e.preventDefault(); c.actions.save(c, c.foot.querySelector('[data-kj-action="save"]')); });
          }
        };
      }
    });

    /* staff-info - static info sheets (payslip placeholder, announcement, link help) */
    var INFO = {
      payslip: { title: 'Payslip', icon: 'receipt-text', anim: 'empty', head: 'Payslips are coming soon',
        text: 'Monthly payslips will appear here once payroll is connected to VisionAI. For now, HR shares them the usual way.',
        actions: function () { return [navBtn('app-attendance', 'View my hours', 'calendar-check', true), navBtn('app-leave', 'My leave', 'calendar-days')]; } },
      announcement: { title: ANNOUNCE.title, icon: 'megaphone', custom: true },
      link: { title: 'Account not linked', icon: 'user-x', anim: 'scan', head: 'Your login isn\u2019t linked to a staff record',
        text: 'Check-ins are matched to your enrolled face. Ask HR or your supervisor to link this login to your employee profile \u2014 then today\u2019s status, your calendar and shift appear automatically.',
        actions: function () { return ['<a class="kj-btn kj-btn-primary kj-btn-sm" href="/kiosk.php">' + ico('scan-face') + '<span>Face check-in</span></a>', navBtn('app-profile', 'My profile', 'user-round')]; } }
    };
    K.register('staff-info', {
      kicker: 'Kian Joo VisionAI', icon: 'info', size: 'sm', deepLink: false,
      render: function (ctx) {
        var x = INFO[ctx.id] || INFO.payslip;
        if (x.custom) {
          return { title: x.title, kicker: 'Announcement', icon: x.icon,
            body: '<div class="kj-sa-ann-hero">' + ico('megaphone', 'kj-sa-ann-ico') + '<div><span class="kj-sa-new">NEW</span><div class="kj-sa-strong kj-sa-mt">' + esc(ANNOUNCE.title) + '</div>' +
              '<div class="kj-sa-meta">' + ico('calendar') + '<span>' + esc(ANNOUNCE.when + ', 7:45 AM') + '</span></div><div class="kj-sa-meta">' + ico('map-pin') + '<span>' + esc(ANNOUNCE.where) + '</span></div></div></div>' +
              '<p class="kj-sa-para">' + esc(ANNOUNCE.body) + '</p>',
            foot: '<button type="button" class="kj-btn kj-btn-primary" data-kj-close>' + ico('check') + 'Got it</button>' };
        }
        return { title: x.title, icon: x.icon, body: emptyBox({ anim: x.anim, icon: x.icon, title: x.head, text: x.text, actions: x.actions() }), mount: function (c) { hydrateLottie(c.body); } };
      }
    });

    /* staff-logout - confirm sheet, then the existing /?logout=1 (index.php -> Auth::logout) */
    K.register('staff-logout', {
      kicker: 'Account', icon: 'log-out', size: 'sm', deepLink: false,
      render: function () {
        var u = me();
        return { title: 'Log out?', icon: 'log-out', tone: 'danger',
          body: '<div class="kj-sa-logout-body">' + avatar(u.photo, u.name, 'kj-sa-av-lg') + '<div><div class="kj-sa-strong">' + esc(u.name) + '</div><div class="kj-sa-muted">You\u2019ll need to sign in again to check your attendance and leave.</div></div></div>',
          foot: '<button type="button" class="kj-btn kj-btn-secondary" data-kj-close>Stay signed in</button><a class="kj-btn kj-btn-danger" href="/?logout=1">' + ico('log-out') + 'Log out</a>' };
      }
    });
  }
  // kj-modal.js loads deferred: register once it exists (mount() also retries).
  if (window.KJModal) registerModals();
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', registerModals);
  else setTimeout(registerModals, 0);
})();
