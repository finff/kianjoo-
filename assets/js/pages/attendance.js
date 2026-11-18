/* Attendance hub — page module (assets/js/pages/attendance.js).
 * Owner: wave-2 M5 attendance-admin agent
 * Absorbs legacy pages: attendance
 *
 * Contract (docs/plan/SPA_ARCHITECTURE.md):
 *   subs[k].legacy  → rendered by the dc template section for that legacy page
 *                     (app.applyPage(legacy) + this.enter(app, legacy) loaders).
 *   subs[k] without legacy → mount(el, route, app) renders into the page host.
 *   onFeed(data, app, route) runs on every 5 s feed.php poll while this hub is active.
 *   methods: class body mixed into the dc Component (this === app) — moved
 *            verbatim from app.js; wave 2 replaces them as the page is redesigned.
 *
 * M5 (REVAMP_PLAN §2 / mockup docs/mockup-ui/generated/admin-attendance.png):
 *   #attendance          new admin page (host-mounted): employee card strip, today's
 *                        stat chips, month records table ⇄ colour-coded month calendar,
 *                        pending leave approvals, team-leave overlay, export.
 *   #attendance/classic  the legacy register / live sightings / reports page (hidden
 *                        tab, linked from the new page) — nothing the old page did is lost.
 *   #attendance/overtime captured overtime (OT) records: rule banner, KPIs, evidence (first/last
 *                        sighting + camera), approve / reject / reopen, recompute, CSV export.
 * Data: GET /attendance/daily (today), GET /attendance/month?all=1 (month JSON; range-CSV export fallback),
 *       GET /leaves/team, GET /leaves/calendar, POST /leaves/{id}/approve|reject,
 *       GET /overtime, POST /overtime/{id}/approve|reject|reopen, POST /overtime/recompute, GET /overtime/export.
 *       Rows carry `ot` (lib/Overtime.php): OT column + "With overtime" filter, OT KPI, month OT per employee.
 * Styles: assets/css/pages/attendance.css (injected by this file, cache-busted with
 *         the same ?v= stamp index.php puts on this script).
 */
(function () {
  'use strict';

  var P = window.KJPages;
  var esc = P.h.esc, ico = P.h.ico;
  var CUR = document.currentScript && document.currentScript.src || '';
  var VER = (/[?&]v=([^&#]+)/.exec(CUR) || [])[1] || '';
  var PER_PAGE = 12;
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  // status → [label, tone, icon]
  var ST = {
    present: ['Present', 'success', 'check'], late: ['Late', 'warn', 'clock-alert'], absent: ['Absent', 'danger', 'x'],
    pending: ['Not yet in', 'info', 'hourglass'], off: ['Off day', '', 'moon'], leave: ['On leave', 'purple', 'calendar-days']
  };
  var ORDER = { absent: 0, leave: 1, late: 2, pending: 3, present: 4, off: 5 };
  var CSV_STATUS = { 'present': 'present', 'late': 'late', 'absent': 'absent', 'not yet in': 'pending', 'off day': 'off' };

  var S = null;      // page state while mounted
  var MOD = null;    // registered module (for hooks)

  /* ── small utils ───────────────────────────────────────────────────────── */
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayStr() { return ymd(new Date()); }
  function ymOf(date) { return String(date).slice(0, 7); }
  function monthEnd(ym) { var p = ym.split('-'); return ym + '-' + pad(new Date(+p[0], +p[1], 0).getDate()); }
  function parseD(s) { var p = String(s).split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function fmtDate(s) { var d = parseD(s); return isNaN(d) ? String(s || '—') : d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3) + ' ' + d.getFullYear(); }
  function fmtShort(s) { var d = parseD(s); return isNaN(d) ? String(s || '') : d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3); }
  function hm(t) { return t ? String(t).slice(11, 16) : ''; }
  function fmtHours(h) {
    if (h == null || h === '' || isNaN(+h)) return '—';
    var m = Math.round(+h * 60);
    return Math.floor(m / 60) + 'h ' + pad(m % 60) + 'm';
  }
  function norm(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }
  /* ── overtime helpers (OT = an estimate from camera sightings, pending approval) ── */
  var OTST = { pending: ['Pending', 'warn'], approved: ['Approved', 'success'], rejected: ['Rejected', 'danger'] };
  var OTKIND = { after: 'After shift', early: 'Early start', 'early+after': 'Early start + after shift', rest: 'Rest day' };
  function fmtMin(m) { m = Math.max(0, Math.round(+m || 0)); var h = Math.floor(m / 60), r = m % 60; return h ? (r ? h + 'h ' + pad(r) + 'm' : h + 'h') : r + 'm'; }
  /** /attendance/daily row.ot → {min (counts: decided figure, 0 if rejected), st, calc, explain, rule, reason, id, changed, provisional} */
  function otOf(o) {
    if (!o) return null;
    var rec = o.record || null;
    return { min: rec ? (rec.status === 'rejected' ? 0 : +rec.minutes || 0) : +o.minutes || 0, st: rec ? rec.status : (+o.minutes > 0 ? 'pending' : ''),
      calc: +o.minutes || 0, explain: o.explain || '', rule: o.rule || '', reason: o.reason || '', id: rec ? rec.id : null,
      changed: !!(rec && rec.changed), provisional: !!o.provisional };
  }
  function otCell(ot) {
    if (!ot || (!ot.min && ot.st !== 'rejected')) {
      return ot && ot.reason === 'missing_out' ? '<span class="att-ot-none" title="' + esc(ot.explain) + '">' + ico('circle-help') + 'No check-out</span>' : '<span class="kj-muted">—</span>';
    }
    var s = OTST[ot.st] || OTST.pending;
    var tip = [ot.explain, ot.rule, ot.st === 'pending' ? 'Captured from camera sightings — pending approval.' : ''].filter(Boolean).join('\n');
    return '<span class="att-ot" title="' + esc(tip) + '"><b class="kj-mono">' + esc(ot.st === 'rejected' ? fmtMin(ot.calc) : fmtMin(ot.min)) + '</b>' +
      '<span class="kj-chip kj-chip-dot att-ot-chip is-' + s[1] + '">' + esc(s[0]) + '</span></span>';
  }
  function initials(n) { return String(n || '?').trim().split(/\s+/).slice(0, 2).map(function (p) { return p[0] || ''; }).join('').toUpperCase() || '?'; }
  function spec(type, id) { return type + ':' + encodeURIComponent(String(id == null ? '' : id)); }
  function seed(o) { return " data-kj-seed='" + esc(JSON.stringify(o)) + "'"; }
  function kjm(type, id, s) { return ' data-kj-modal="' + esc(spec(type, id)) + '"' + (s ? seed(s) : ''); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function avatar(photo, name, cls, modal) {
    var m = modal || '';
    return photo ? '<img class="kj-avatar ' + (cls || '') + '" src="' + esc(photo) + '" alt="' + esc(name || '') + '" loading="lazy"' + m + '>'
      : '<span class="kj-avatar ' + (cls || '') + '"' + m + '>' + esc(initials(name)) + '</span>';
  }
  function chip(status, extra) {
    var s = ST[status] || [status || '—', ''];
    return '<span class="kj-chip att-chip' + (s[1] ? ' is-' + s[1] : '') + '"' + (extra || '') + '>' + ico(s[2] || 'circle') + esc(s[0]) + '</span>';
  }
  function toast(msg, tone) { if (window.KJModal && window.KJModal.toast) window.KJModal.toast(msg, tone); }

  /* ── API (own helper: KJModal is deferred and may not exist at first mount) ─ */
  function apiUrl(path, params) {
    var base = (window.TMNS && window.TMNS.api) || '/api';
    var q = new URLSearchParams(params || {});
    var tok = window.TMNS && window.TMNS.token;
    if (tok) q.set('token', tok);
    return base + path + (q.toString() ? '?' + q : '');
  }
  function fail(d, status) { var e = new Error((d && (d.error || d.msg)) || 'Request failed'); e.status = (d && d.status) || status; return e; }
  function getJSON(path, params) {
    return fetch(apiUrl(path, params), { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      return r.json().catch(function () { return { ok: false }; }).then(function (d) {
        if (!d || d.ok === false || (r.status && r.status >= 400)) throw fail(d, r.status);
        return d;
      });
    });
  }
  function postJSON(path, body) {
    return fetch(apiUrl(path), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) {
        return r.json().catch(function () { return { ok: false }; }).then(function (d) {
          if (!d || d.ok === false || (r.status && r.status >= 400)) throw fail(d, r.status);
          return d;
        });
      });
  }
  function getText(path, params) {
    return fetch(apiUrl(path, params), { cache: 'no-store', credentials: 'same-origin' }).then(function (r) {
      return r.text().then(function (t) {
        var s = String(t || '').replace(/^﻿/, '');
        if (/^\s*\{/.test(s)) { var d = null; try { d = JSON.parse(s); } catch (e) { /* not JSON */ } if (d && d.ok === false) throw fail(d, r.status); }
        if (r.status && r.status >= 400) throw fail(null, r.status);
        return s;
      });
    });
  }
  /** RFC-4180 CSV → array of arrays. */
  function parseCSV(text) {
    var rows = [], row = [], f = '', q = false, i, c;
    for (i = 0; i < text.length; i++) {
      c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
      } else if (c === '"') q = true;
      else if (c === ',') { row.push(f); f = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
      else f += c;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows.filter(function (r) { return r.length > 1 || r[0] !== ''; });
  }
  // The export neutralises spreadsheet formulas with a leading apostrophe.
  function unq(s) { return /^'[=+\-@]/.test(s) ? s.slice(1) : s; }

  /* ── stylesheet + Lottie (lazy) ────────────────────────────────────────── */
  function ensureCss() {
    if (document.getElementById('kj-att-css')) return;
    var l = document.createElement('link');
    l.id = 'kj-att-css'; l.rel = 'stylesheet';
    l.href = 'assets/css/pages/attendance.css' + (VER ? '?v=' + VER : '');
    (document.head || document.documentElement).appendChild(l);
  }
  var lottieP = null;
  function lottieLib() {
    if (window.lottie) return Promise.resolve(window.lottie);
    if (lottieP) return lottieP;
    lottieP = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'assets/vendor/lottie/lottie_light.min.js' + (VER ? '?v=' + VER : '');
      s.async = true;
      s.onload = function () { if (window.lottie) res(window.lottie); else rej(new Error('lottie missing')); };
      s.onerror = function () { lottieP = null; rej(new Error('lottie failed')); };
      (document.head || document.documentElement).appendChild(s);
      setTimeout(function () { if (!window.lottie) rej(new Error('lottie timeout')); }, 8000);
    });
    return lottieP;
  }
  var LOTTIE = { empty: ['empty-box.json', true], loading: ['loading-spinner.json', true], error: ['error-alert.json', false], success: ['success-check.json', false] };
  function hydrateLottie(root) {
    if (!S || !root) return;
    S.anims = S.anims.filter(function (a) { if (!document.body.contains(a.el)) { try { a.anim.destroy(); } catch (e) { /* ignore */ } return false; } return true; });
    var els = root.querySelectorAll('[data-att-lottie]:not(.is-on)');
    if (!els.length) return;
    lottieLib().then(function (L) {
      Array.prototype.forEach.call(els, function (el) {
        if (!S || !document.body.contains(el) || el.classList.contains('is-on')) return;
        var def = LOTTIE[el.getAttribute('data-att-lottie')] || LOTTIE.empty;
        el.classList.add('is-on'); el.innerHTML = '';
        try { S.anims.push({ el: el, anim: L.loadAnimation({ container: el, renderer: 'svg', loop: def[1], autoplay: true, path: 'assets/lottie/' + def[0] }) }); } catch (e) { /* icon fallback already cleared */ }
      });
    }).catch(function () { /* keep the static icon */ });
  }
  /** Empty state: Lottie animation (static icon until the player loads) + a way forward. */
  function emptyBox(o) {
    return '<div class="kj-empty att-empty' + (o.err ? ' is-error' : '') + '">' +
      '<div class="kj-lottie att-lottie" data-att-lottie="' + (o.err ? 'error' : (o.anim || 'empty')) + '"><span class="kj-empty-ico">' + ico(o.icon || 'inbox') + '</span></div>' +
      '<div class="kj-empty-title">' + esc(o.title) + '</div>' + (o.text ? '<div class="kj-empty-text">' + esc(o.text) + '</div>' : '') +
      (o.actions ? '<div class="kj-row-wrap kj-empty-actions">' + o.actions + '</div>' : '') + '</div>';
  }
  function actBtn(act, label, icon, cls, attrs) {
    return '<button type="button" class="kj-btn ' + (cls || 'kj-btn-secondary') + '" data-att-act="' + act + '"' + (attrs || '') + '>' + (icon ? ico(icon) : '') + '<span>' + esc(label) + '</span></button>';
  }

  /* ── state ─────────────────────────────────────────────────────────────── */
  function freshState(app) {
    var now = new Date();
    return {
      app: app, el: null, anims: [], tick: 0, timers: {},
      ym: now.getFullYear() + '-' + pad(now.getMonth() + 1),
      view: 'table', overlay: true, page: 1,
      f: { q: '', dept: '', status: '', sel: '' },
      today: null, todayErr: '', depts: [],
      months: {},            // ym → {busy, err, rows[], at}
      leaves: {},            // ym → {busy, err, data, idx{date:[e]}, at}
      appr: null,            // {busy} | {list,total} | {hidden} | {err}
      sig: ''
    };
  }
  function app() { return S && S.app; }

  /* employees = today's register (active profiles) + any profile the dashboard already holds */
  function employees() {
    var out = [], seen = {};
    var rows = (S.today && S.today.rows) || [];
    rows.forEach(function (r) { if (r.personId && !seen[r.personId]) { seen[r.personId] = 1; out.push({ pid: String(r.personId), name: r.name || '', staffId: r.staffId || '', dept: r.department || '', plant: r.plant || '', photo: r.photo || '', shift: r.shift || '', row: r }); } });
    out.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return out;
  }
  function empIndex() {
    if (S._empIdx && S._empIdxOf === S.today) return S._empIdx;
    var byPid = {}, byStaff = {}, byName = {};
    var profs = (app() && app().state && app().state.people && app().state.people.profiles) || {};
    Object.keys(profs).forEach(function (k) {
      var p = profs[k] || {}; var e = { pid: String(p.personId || k), name: p.name || '', staffId: p.staffId || '', dept: p.department || '', plant: p.plant || '', photo: p.photo || '' };
      byPid[e.pid] = e; if (e.staffId) byStaff[norm(e.staffId)] = e; if (e.name) byName[norm(e.name)] = e;
    });
    employees().forEach(function (e) { byPid[e.pid] = e; if (e.staffId) byStaff[norm(e.staffId)] = e; if (e.name) byName[norm(e.name)] = e; });
    S._empIdx = { pid: byPid, staff: byStaff, name: byName }; S._empIdxOf = S.today;
    return S._empIdx;
  }

  /* ── leave lookups ─────────────────────────────────────────────────────── */
  function leaveCal(ym) { return S.leaves[ym] && S.leaves[ym].data ? S.leaves[ym] : null; }
  function leavesOn(date) { var c = leaveCal(ymOf(date)); return (c && c.idx[date]) || []; }
  /** Leave covering this employee on date: matched by person id, then staff id (both from
   *  /leaves/calendar), with the lower-cased name kept as a last-resort fallback. */
  function leaveFor(who, date) {
    if (!who) return null;
    var l = leavesOn(date); if (!l.length) return null;
    var pid = String(who.pid || ''), sid = norm(who.staffId), n = norm(who.name), i;
    if (pid) for (i = 0; i < l.length; i++) if (l[i].pid && l[i].pid === pid) return l[i];
    if (sid) for (i = 0; i < l.length; i++) if (l[i].staffId && norm(l[i].staffId) === sid) return l[i];
    // name only where no id comparison was possible on either side (old API / unmapped rows)
    if (n) for (i = 0; i < l.length; i++) if ((!pid || !l[i].pid) && (!sid || !l[i].staffId) && norm(l[i].name) === n) return l[i];
    return null;
  }
  function indexLeaves(data) {
    var idx = {};
    (data.departments || []).forEach(function (g) {
      (g.leaves || []).forEach(function (l) {
        var e = { id: l.id, name: l.name || '', pid: l.person_id != null ? String(l.person_id) : '', staffId: l.staff_id || '', dept: g.department || '', type: l.leave_type_name || l.leave_type || 'Leave', code: l.leave_type || '',
          from: l.start_date, to: l.end_date, days: l.days, half: l.half_day ? (l.half_day_period || '').toUpperCase() : '', status: l.status || 'approved' };
        for (var d = parseD(l.start_date), end = parseD(l.end_date); d <= end; d.setDate(d.getDate() + 1)) {
          var k = ymd(d); if (d.getDay() === 0 || d.getDay() === 6) continue;
          (idx[k] = idx[k] || []).push(e);
        }
      });
    });
    return idx;
  }

  /* ── month rows ────────────────────────────────────────────────────────── */
  function rowFromDaily(r, date) {
    return { date: date, pid: String(r.personId || ''), name: r.name || '', staffId: r.staffId || '', dept: r.department || '', plant: r.plant || '',
      shift: r.shift || '', inT: hm(r.clockIn), outT: hm(r.clockOut), inLoc: r.clockInLoc || '', hours: r.hours, status: r.status,
      lateMin: r.lateMin || 0, photo: r.photo || '', ot: otOf(r.ot) };
  }
  function rowsFromCSV(text) {
    var t = parseCSV(text); if (!t.length) return [];
    var head = t[0].map(norm), col = function (n) { return head.indexOf(n); };
    var c = { date: col('date'), staff: col('staff id'), name: col('employee'), dept: col('department'), plant: col('plant'), shift: col('shift'),
      inT: col('clock-in'), inLoc: col('clock-in location'), outT: col('clock-out'), hours: col('hours'), status: col('status'), late: col('late (min)') };
    if (c.date < 0 || c.name < 0 || c.status < 0) throw new Error('Unexpected export format');
    var ix = empIndex();
    return t.slice(1).map(function (r) {
      var g = function (k) { return c[k] >= 0 ? unq(String(r[c[k]] || '')) : ''; };
      var staff = g('staff'), name = g('name');
      var e = (staff && ix.staff[norm(staff)]) || ix.name[norm(name)] || null;
      var hrs = g('hours');
      return { date: g('date'), pid: e ? e.pid : '', name: name, staffId: staff, dept: g('dept'), plant: g('plant'), shift: g('shift'),
        inT: g('inT'), outT: g('outT'), inLoc: g('inLoc'), hours: hrs === '' ? null : +hrs, status: CSV_STATUS[norm(g('status'))] || norm(g('status')),
        lateMin: +g('late') || 0, photo: e ? e.photo : '' };
    }).filter(function (r) { return /^\d{4}-\d{2}-\d{2}$/.test(r.date); });
  }
  /** GET /attendance/month?all=1 → the same row shape rowsFromCSV builds. */
  function rowsFromMonth(d) {
    var out = [];
    (d.people || []).forEach(function (p) {
      var days = p.days || {};
      Object.keys(days).forEach(function (date) {
        var x = days[date] || {};
        out.push({ date: date, pid: String(p.personId || ''), name: p.name || '', staffId: p.staffId || '', dept: p.department || '', plant: p.plant || '',
          shift: p.shift || '', inT: x['in'] || '', outT: x.out || '', inLoc: x.inLoc || '', hours: x.hours == null ? null : +x.hours,
          status: x.status, lateMin: +x.lateMin || 0, photo: p.photo || '',
          ot: x.otSt ? { min: +x.ot || 0, st: x.otSt, calc: x.otCalc != null ? +x.otCalc : +x.ot || 0, explain: '', rule: '', reason: '' } : null });
      });
    });
    return out;
  }
  /** Today's live register replaces today's rows in the current month. */
  function monthRows() {
    var m = S.months[S.ym]; var rows = (m && m.rows) || [];
    var t = todayStr();
    if (S.today && ymOf(t) === S.ym) {
      rows = rows.filter(function (r) { return r.date !== t; }).concat((S.today.rows || []).map(function (r) { return rowFromDaily(r, t); }));
    }
    return rows;
  }
  function effStatus(r) { return (r.status === 'absent' || r.status === 'pending') && leaveFor(r, r.date) ? 'leave' : r.status; }
  function matchQ(name, staffId) { var q = norm(S.f.q); return !q || (norm(name) + ' ' + norm(staffId)).indexOf(q) >= 0; }
  function filteredRows() {
    var f = S.f;
    return monthRows().filter(function (r) {
      if (f.sel && r.pid !== f.sel) return false;
      if (f.dept && r.dept !== f.dept) return false;
      if (!matchQ(r.name, r.staffId)) return false;
      if (f.status === 'ot') return !!(r.ot && r.ot.min > 0);
      var s = effStatus(r);
      if (!f.status) return s !== 'off';
      if (f.status === 'present') return s === 'present' || s === 'late';
      return s === f.status;
    }).sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      var oa = ORDER[effStatus(a)], ob = ORDER[effStatus(b)];
      return oa !== ob ? oa - ob : a.name.localeCompare(b.name);
    });
  }

  /* ── loaders ───────────────────────────────────────────────────────────── */
  function loadToday(silent) {
    if (!S) return;
    var my = S;
    if (!silent) { S.todayBusy = true; }
    return getJSON('/attendance/daily', { date: todayStr() }).then(function (d) {
      if (S !== my) return;
      S.today = d; S.todayErr = ''; S.todayBusy = false;
      S.depts = (d.departments || []).slice();
      employees().forEach(function (e) { if (e.dept && S.depts.indexOf(e.dept) < 0) S.depts.push(e.dept); });
      // CSV rows parsed before the register arrived have no person ids yet → remap
      Object.keys(S.months).forEach(function (k) { var m = S.months[k]; if (m.csv) { try { m.rows = rowsFromCSV(m.csv); } catch (e) { /* keep previous rows */ } } });
      var sig = JSON.stringify((d.rows || []).map(function (r) { return [r.personId, r.status, r.clockIn, r.clockOut]; })) + '|' + JSON.stringify(d.kpi || {});
      if (silent && sig === S.sig) return;
      S.sig = sig;
      fillDepts(); paintStrip(); paintStats(); paintBody(); paintSide();
    }).catch(function (e) {
      if (S !== my) return;
      S.todayBusy = false;
      if (!silent || !S.today) { S.todayErr = e.message || 'Could not load today’s register'; paintStrip(); paintStats(); }
    });
  }
  function loadMonth(force) {
    if (!S) return;
    var my = S, ym = S.ym, m = S.months[ym], t = todayStr();
    if (m && !force && (m.busy || (m.rows && (ym !== ymOf(t) || Date.now() - m.at < 300000)))) { paintBody(); return; }
    var from = ym + '-01';
    if (from > t) { S.months[ym] = { rows: [], future: true, at: Date.now() }; paintBody(); return; }
    var to = monthEnd(ym) < t ? monthEnd(ym) : t;
    S.months[ym] = { busy: true, rows: m && m.rows, at: m && m.at };
    paintBody();
    // Primary: GET /attendance/month?all=1 (JSON, person ids included). Silent fallback: the range CSV.
    var viaCsv = function () {
      return getText('/attendance/export', { report: 'range', from: from, to: to, date: to }).then(function (txt) {
        return { rows: rowsFromCSV(txt), csv: txt, at: Date.now() };
      });
    };
    getJSON('/attendance/month', { month: ym, all: 1 }).then(function (d) {
      if (!d || !Array.isArray(d.people)) throw new Error('shape');
      return { rows: rowsFromMonth(d), at: Date.now() };
    }).catch(viaCsv).then(function (m2) {
      if (S !== my) return;
      S.months[ym] = m2;
      if (S.ym === ym) { paintBody(); paintSide(); }
    }).catch(function (e) {
      if (S !== my) return;
      S.months[ym] = { err: e.message || 'Could not load the month', rows: null, at: 0 };
      if (S.ym === ym) paintBody();
    });
  }
  function loadLeaves(ym, force) {
    if (!S) return Promise.resolve();
    var my = S, c = S.leaves[ym];
    if (c && !force && (c.busy || Date.now() - c.at < 120000)) return Promise.resolve();
    S.leaves[ym] = { busy: true, data: c && c.data, idx: (c && c.idx) || {}, at: c ? c.at : 0 };
    return getJSON('/leaves/calendar', { month: ym }).then(function (d) {
      if (S !== my) return;
      S.leaves[ym] = { data: d, idx: indexLeaves(d), at: Date.now() };
      paintStrip(); paintStats(); paintBody(); paintSide();
    }).catch(function (e) {
      if (S !== my) return;
      S.leaves[ym] = { err: e.message, status: e.status, idx: {}, at: Date.now() };
      paintSide();
    });
  }
  function loadApprovals() {
    if (!S) return Promise.resolve();
    var my = S;
    if (!S.appr) S.appr = { busy: true };
    paintSide();
    return getJSON('/leaves/team', { status: 'pending', limit: 50 }).then(function (d) {
      if (S !== my) return;
      S.appr = { list: d.leaves || [], total: d.total != null ? d.total : (d.leaves || []).length };
      paintSide();
    }).catch(function (e) {
      if (S !== my) return;
      S.appr = (e.status === 401 || e.status === 403) ? { hidden: true } : { err: e.message || 'Could not load approvals' };
      paintSide();
    });
  }
  function refreshLeaves() {
    if (!S) return;
    loadApprovals();
    loadLeaves(S.ym, true);
    var cm = ymOf(todayStr()); if (cm !== S.ym) loadLeaves(cm, true);
  }

  /* ── page frame (rendered once per mount) ──────────────────────────────── */
  function frame() {
    var now = new Date(), y = now.getFullYear();
    var years = []; for (var i = y; i >= y - 3; i--) years.push(i);
    var p = S.ym.split('-');
    return '<div class="kj-page att-page">' +
      '<div class="kj-page-head att-head"><div><h2 class="kj-page-title">Attendance</h2>' +
        '<p class="kj-page-sub">Monitor your workforce attendance, working hours and team leave.</p></div>' +
        '<div class="kj-row-wrap att-head-actions">' +
          '<button type="button" class="kj-btn kj-btn-secondary" data-kj-nav="attendance/classic">' + ico('table-2') + '<span>Classic register</span></button>' +
          actBtn('export', 'Export', 'download', 'kj-btn-primary') +
        '</div></div>' +
      '<section class="kj-card att-strip-card" aria-label="Employees">' +
        '<button type="button" class="kj-btn kj-btn-secondary kj-btn-icon att-strip-nav is-prev" data-att-act="scroll-l" aria-label="Scroll employees left">' + ico('chevron-left') + '</button>' +
        '<div class="att-strip" id="att-strip" role="list"></div>' +
        '<button type="button" class="kj-btn kj-btn-secondary kj-btn-icon att-strip-nav is-next" data-att-act="scroll-r" aria-label="Scroll employees right">' + ico('chevron-right') + '</button>' +
      '</section>' +
      '<div class="att-stats" id="att-stats"></div>' +
      '<div class="att-grid">' +
        '<section class="kj-card att-records">' +
          '<div class="att-rec-head"><div><h3 class="att-h3">Attendance records</h3><p class="kj-card-sub" id="att-rec-sub">Daily employee attendance overview</p></div>' +
            '<div class="kj-tabs" role="tablist" aria-label="View">' +
              '<button type="button" class="kj-tab" role="tab" data-att-act="view" data-v="table">' + ico('table-2') + 'Table</button>' +
              '<button type="button" class="kj-tab" role="tab" data-att-act="view" data-v="calendar">' + ico('calendar-days') + 'Calendar</button>' +
            '</div></div>' +
          '<div class="att-toolbar">' +
            '<label class="att-search">' + ico('search') + '<input class="kj-input" type="search" placeholder="Search employee or staff ID…" aria-label="Search employee" data-att-f="q" value="' + esc(S.f.q) + '"></label>' +
            '<select class="kj-select" aria-label="Department" data-att-f="dept"><option value="">All departments</option></select>' +
            '<select class="kj-select" aria-label="Status" data-att-f="status">' +
              [['', 'All statuses'], ['present', 'Present (incl. late)'], ['late', 'Late'], ['absent', 'Absent'], ['leave', 'On leave'], ['pending', 'Not yet in'], ['off', 'Off days'], ['ot', 'With overtime']]
                .map(function (o) { return '<option value="' + o[0] + '"' + (S.f.status === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
            '<select class="kj-select" aria-label="Month" data-att-f="month">' + MONTHS.map(function (m, i) { return '<option value="' + pad(i + 1) + '"' + (+p[1] === i + 1 ? ' selected' : '') + '>' + m + '</option>'; }).join('') + '</select>' +
            '<select class="kj-select" aria-label="Year" data-att-f="year">' + years.map(function (yy) { return '<option value="' + yy + '"' + (+p[0] === yy ? ' selected' : '') + '>' + yy + '</option>'; }).join('') + '</select>' +
          '</div>' +
          '<div class="att-selbar" id="att-selbar"></div>' +
          '<div class="att-body" id="att-body"></div>' +
        '</section>' +
        '<aside class="att-side" id="att-side"></aside>' +
      '</div></div>';
  }
  function $(id) { return S && S.el ? S.el.querySelector('#' + id) : null; }
  function fillDepts() {
    var sel = S.el && S.el.querySelector('[data-att-f="dept"]'); if (!sel) return;
    var list = S.depts.slice().sort();
    sel.innerHTML = '<option value="">All departments</option>' + list.map(function (d) { return '<option value="' + esc(d) + '"' + (S.f.dept === d ? ' selected' : '') + '>' + esc(d) + '</option>'; }).join('');
  }
  function syncToolbar() {
    if (!S.el) return;
    Array.prototype.forEach.call(S.el.querySelectorAll('[data-att-act="view"]'), function (b) {
      var on = b.getAttribute('data-v') === S.view; b.setAttribute('aria-selected', on ? 'true' : 'false'); b.classList.toggle('is-active', on);
    });
    var st = S.el.querySelector('[data-att-f="status"]'); if (st) st.value = S.f.status;
    var sub = $('att-rec-sub'), p = S.ym.split('-');
    if (sub) sub.textContent = (S.view === 'calendar' ? 'Colour-coded month' : 'Daily employee attendance') + ' · ' + MONTHS[+p[1] - 1] + ' ' + p[0];
  }

  /* ── strip ─────────────────────────────────────────────────────────────── */
  function todayStatus(e) { var s = e.row ? e.row.status : ''; return (s === 'absent' || s === 'pending' || s === 'off') && leaveFor(e, todayStr()) ? 'leave' : s; }
  function paintStrip() {
    var el = $('att-strip'); if (!el) return;
    if (!S.today) {
      el.innerHTML = S.todayErr ? '<div class="att-strip-msg">' + emptyBox({ err: true, title: 'Could not load employees', text: S.todayErr, actions: actBtn('retry-today', 'Retry', 'refresh-cw') }) + '</div>'
        : [1, 2, 3, 4, 5, 6].map(function () { return '<div class="att-emp is-skel"><span class="kj-skel kj-skel-circle"></span><div class="att-emp-main"><span class="kj-skel kj-skel-line"></span><span class="kj-skel kj-skel-line is-short"></span></div></div>'; }).join('');
      hydrateLottie(el); return;
    }
    var list = employees().filter(function (e) { return (!S.f.dept || e.dept === S.f.dept) && matchQ(e.name, e.staffId); });
    if (!list.length) {
      el.innerHTML = '<div class="att-strip-msg">' + emptyBox({ title: employees().length ? 'No employees match' : 'No employees on the register yet',
        text: employees().length ? 'Clear the search or department filter.' : 'Enrol employees in People → Directory to start tracking attendance.',
        actions: employees().length ? actBtn('clear-filters', 'Clear filters', 'filter-x') : '<button type="button" class="kj-btn kj-btn-primary" data-kj-nav="people">' + ico('users') + '<span>Open People</span></button>' }) + '</div>';
      hydrateLottie(el); return;
    }
    el.innerHTML = list.map(function (e) {
      var s = todayStatus(e), on = S.f.sel === e.pid;
      var pm = kjm('person', e.pid, { name: e.name, photo: e.photo });
      return '<div class="att-emp' + (on ? ' is-selected' : '') + '" role="listitem"><div class="att-emp-hit" role="button" tabindex="0" aria-pressed="' + on + '" data-att-sel="' + esc(e.pid) + '" title="' + esc(on ? 'Show everyone' : 'Show only ' + e.name) + '">' +
        avatar(e.photo, e.name, 'kj-avatar-xl att-emp-photo') +
        '<div class="att-emp-main"><div class="att-emp-name kj-truncate">' + esc(e.name) + '</div>' +
        '<div class="att-emp-role kj-truncate">' + esc(e.dept || e.plant || 'Employee') + '</div>' +
        (s ? chip(s) : '') + '</div></div>' +
        '<button type="button" class="kj-btn kj-btn-sm att-emp-btn"' + pm + '>' + ico('user-round') + '<span>Profile</span></button></div>';
    }).join('');
  }

  /* ── stat chips (today) ────────────────────────────────────────────────── */
  function paintStats() {
    var el = $('att-stats'); if (!el) return;
    if (!S.today) { el.innerHTML = [1, 2, 3, 4, 5, 6].map(function () { return '<span class="kj-skel kj-skel-tile"></span>'; }).join(''); return; }
    var k = S.today.kpi || {}, t = todayStr();
    var onLeave = leavesOn(t).filter(function (l) { return !S.f.dept || l.dept === S.f.dept; });
    var tile = function (icon, val, lbl, tone, modal, sub) {
      return '<button type="button" class="kj-stat att-stat' + (tone ? ' is-' + tone : '') + '"' + modal + '><span class="kj-stat-ico">' + ico(icon) + '</span>' +
        '<span class="att-stat-txt"><span class="kj-stat-val">' + esc(val) + '</span><span class="kj-stat-lbl">' + esc(lbl) + '</span>' + (sub ? '<span class="att-stat-sub">' + esc(sub) + '</span>' : '') + '</span></button>';
    };
    var day = function (status) { return kjm('attendance-day', t, status ? { status: status } : null); };
    var rate = k.total ? Math.round(100 * (k.present || 0) / k.total) : 0;
    el.innerHTML =
      tile('users', k.total || 0, 'Scheduled today', '', day(''), rate + '% clocked in') +
      tile('circle-check', k.present || 0, 'Present', 'success', day('present'), 'incl. late arrivals') +
      tile('clock-alert', k.late || 0, 'Late', 'warn', day('late'), 'after start + grace') +
      tile('user-x', k.absent || 0, 'Absent', 'danger', day('absent'), (k.pending || 0) + ' not yet in') +
      tile('calendar-days', onLeave.length, 'On leave', 'purple', kjm('att-leave-day', t), leaveCal(ymOf(t)) ? 'approved leave today' : 'leave data unavailable') +
      tile('timer', k.otPeople || 0, 'On overtime today', 'orange', ' data-kj-nav="attendance/overtime"',
        k.otMin ? fmtMin(k.otMin) + ' total' + (k.otPending ? ' · ' + k.otPending + ' pending' : '') : 'none captured yet');
  }

  /* ── records body: table | calendar ────────────────────────────────────── */
  function paintSelbar() {
    var el = $('att-selbar'); if (!el) return;
    var e = S.f.sel && empIndex().pid[S.f.sel];
    var bits = [];
    if (e) bits.push('<span class="kj-chip is-primary att-filter-chip">' + ico('user-round') + esc(e.name) + '<button type="button" class="att-x" data-att-act="clear-sel" aria-label="Show all employees">' + ico('x') + '</button></span>');
    if (S.f.status) bits.push('<span class="kj-chip att-filter-chip">' + esc(S.f.status === 'ot' ? 'With overtime' : (ST[S.f.status] || [S.f.status])[0]) + '<button type="button" class="att-x" data-att-act="clear-status" aria-label="Clear status filter">' + ico('x') + '</button></span>');
    if (S.f.dept) bits.push('<span class="kj-chip att-filter-chip">' + esc(S.f.dept) + '<button type="button" class="att-x" data-att-act="clear-dept" aria-label="Clear department filter">' + ico('x') + '</button></span>');
    el.innerHTML = bits.join('');
    el.hidden = !bits.length;
  }
  function paintBody() {
    if (!S || !S.el) return;
    syncToolbar(); paintSelbar();
    var el = $('att-body'); if (!el) return;
    var m = S.months[S.ym];
    if (!m || (m.busy && !m.rows)) {
      el.innerHTML = S.view === 'calendar' ? '<div class="att-cal-skel">' + Array(35).join('<span class="kj-skel att-cal-skel-cell"></span>') + '</div>'
        : '<div class="att-table-skel">' + [1, 2, 3, 4, 5, 6, 7].map(function () { return '<div class="kj-row"><span class="kj-skel kj-skel-circle"></span><span class="kj-skel kj-skel-line"></span><span class="kj-skel kj-skel-line is-mid"></span><span class="kj-skel kj-skel-line is-short"></span></div>'; }).join('') + '</div>';
      return;
    }
    if (m.err) {
      el.innerHTML = emptyBox({ err: true, title: 'Could not load this month', text: m.err + ' — the classic register still works.',
        actions: actBtn('retry-month', 'Retry', 'refresh-cw', 'kj-btn-primary') + '<button type="button" class="kj-btn kj-btn-secondary" data-kj-nav="attendance/classic">' + ico('table-2') + '<span>Classic register</span></button>' });
      hydrateLottie(el); return;
    }
    if (m.future) {
      el.innerHTML = emptyBox({ icon: 'calendar-clock', title: 'This month has not started yet', text: 'Pick the current or an earlier month to see attendance.', actions: actBtn('this-month', 'Go to this month', 'calendar-check', 'kj-btn-primary') });
      hydrateLottie(el); return;
    }
    el.innerHTML = S.view === 'calendar' ? calendarHtml() : tableHtml();
    hydrateLottie(el);
  }

  function tableHtml() {
    var rows = filteredRows();
    if (!rows.length) {
      var any = monthRows().length;
      return emptyBox({ title: any ? 'No records match these filters' : 'No attendance recorded this month',
        text: any ? 'Try another status, department or employee.' : 'Records appear once employees are seen at a clock camera or the face kiosk.',
        actions: any ? actBtn('clear-filters', 'Clear filters', 'filter-x', 'kj-btn-primary') : '<a class="kj-btn kj-btn-primary" href="/kiosk.php">' + ico('scan-face') + '<span>Open check-in kiosk</span></a>' });
    }
    var pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
    if (S.page > pages) S.page = pages;
    var a = (S.page - 1) * PER_PAGE, list = rows.slice(a, a + PER_PAGE);
    var body = list.map(function (r) {
      var s = effStatus(r), lv = s === 'leave' ? leaveFor(r, r.date) : null;
      var dayId = r.pid ? r.date + '@' + r.pid : r.date;
      var pseed = { name: r.name, photo: r.photo };
      var who = r.pid ? '<button type="button" class="kj-link att-name"' + kjm('person', r.pid, pseed) + '>' + esc(r.name || '—') + '</button>' : '<span class="att-name">' + esc(r.name || '—') + '</span>';
      var stChip = lv ? chip('leave', kjm('leave', lv.id, { name: lv.type + ' · ' + r.name }) + ' role="button" tabindex="0" title="' + esc(lv.type + ' · ' + fmtShort(lv.from) + (lv.to !== lv.from ? '–' + fmtShort(lv.to) : '')) + '"')
        : chip(s) + (s === 'late' && r.lateMin ? '<span class="att-late">+' + r.lateMin + 'm</span>' : '');
      return '<tr' + kjm('attendance-day', dayId) + '>' +
        '<td><span class="att-who">' + avatar(r.photo, r.name, '', r.pid ? kjm('person', r.pid, pseed) : '') + '<span class="att-who-txt">' + who +
          '<span class="kj-muted att-staff">' + esc(r.staffId || '') + '</span></span></span></td>' +
        '<td>' + esc(r.dept || '—') + '</td>' +
        '<td class="att-nowrap">' + esc(fmtDate(r.date)) + '</td>' +
        '<td class="kj-mono">' + esc(r.inT || '—') + '</td>' +
        '<td class="kj-mono">' + esc(r.outT || '—') + '</td>' +
        '<td class="kj-num kj-mono">' + esc(fmtHours(r.hours)) + '</td>' +
        '<td class="att-nowrap">' + otCell(r.ot) + '</td>' +
        '<td class="att-nowrap">' + stChip + '</td>' +
        '<td class="kj-num"><button type="button" class="kj-btn kj-btn-sm kj-btn-secondary att-view"' + kjm('attendance-day', dayId) + '>View</button></td></tr>';
    }).join('');
    return '<div class="kj-table-wrap"><table class="kj-table att-table"><thead><tr><th>Employee</th><th>Department</th><th>Date</th><th>Check-in</th><th>Check-out</th><th class="kj-num">Hours</th><th><abbr title="Overtime captured from the last camera sighting after shift end — an estimate until approved">OT</abbr></th><th>Status</th><th class="kj-num"><span class="kj-sr-only">Details</span></th></tr></thead>' +
      '<tbody>' + body + '</tbody></table></div>' + pager(rows.length, pages);
  }
  function pager(total, pages) {
    var a = (S.page - 1) * PER_PAGE + 1, b = Math.min(total, S.page * PER_PAGE);
    var nums = [], p = S.page;
    for (var i = 1; i <= pages; i++) {
      if (i === 1 || i === pages || Math.abs(i - p) <= 1) nums.push(i);
      else if (nums[nums.length - 1] !== '…') nums.push('…');
    }
    return '<div class="att-pager"><span class="kj-muted">Showing ' + a + '–' + b + ' of ' + plural(total, 'record') + '</span><span class="kj-spacer"></span>' +
      '<button type="button" class="kj-btn kj-btn-secondary kj-btn-icon kj-btn-sm" data-att-act="page" data-p="' + (p - 1) + '"' + (p <= 1 ? ' disabled' : '') + ' aria-label="Previous page">' + ico('chevron-left') + '</button>' +
      nums.map(function (n) {
        return n === '…' ? '<span class="att-pager-gap">…</span>' : '<button type="button" class="kj-btn kj-btn-sm att-pg' + (n === p ? ' kj-btn-primary' : ' kj-btn-secondary') + '" data-att-act="page" data-p="' + n + '"' + (n === p ? ' aria-current="page"' : '') + '>' + n + '</button>';
      }).join('') +
      '<button type="button" class="kj-btn kj-btn-secondary kj-btn-icon kj-btn-sm" data-att-act="page" data-p="' + (p + 1) + '"' + (p >= pages ? ' disabled' : '') + ' aria-label="Next page">' + ico('chevron-right') + '</button></div>';
  }

  function calendarHtml() {
    var p = S.ym.split('-'), y = +p[0], mo = +p[1] - 1, t = todayStr();
    var first = new Date(y, mo, 1), days = new Date(y, mo + 1, 0).getDate();
    var lead = (first.getDay() + 6) % 7;
    var rows = monthRows().filter(function (r) { return (!S.f.dept || r.dept === S.f.dept) && matchQ(r.name, r.staffId) && (!S.f.sel || r.pid === S.f.sel); });
    var byDate = {}; rows.forEach(function (r) { (byDate[r.date] = byDate[r.date] || []).push(r); });
    var sel = S.f.sel && empIndex().pid[S.f.sel];
    var lc = leaveCal(S.ym);
    var cells = [], i;
    for (i = 0; i < lead; i++) cells.push('<div class="att-cal-cell is-blank" aria-hidden="true"></div>');
    for (var d = 1; d <= days; d++) {
      var date = S.ym + '-' + pad(d), list = byDate[date] || [], future = date > t;
      var lv = leavesOn(date).filter(function (l) { return (!S.f.dept || l.dept === S.f.dept) && matchQ(l.name, ''); });
      var cls = 'att-cal-cell', inner = '', modal = kjm('attendance-day', sel ? date + '@' + sel.pid : date);
      if (future) { cls += ' is-future'; modal = ''; }
      else if (sel) {
        var r = list[0], s = r ? effStatus(r) : '';
        cls += ' is-' + (s || 'none');
        inner = r ? '<span class="att-cal-st">' + esc((ST[s] || [s])[0]) + '</span>' + (r.inT ? '<span class="att-cal-t kj-mono">' + esc(r.inT) + (r.outT ? '–' + esc(r.outT) : '') + '</span>' : '') : '<span class="att-cal-t">No record</span>';
      } else {
        var sched = 0, pres = 0, late = 0, abs = 0;
        list.forEach(function (x) { var s2 = effStatus(x); if (s2 === 'off') return; if (s2 !== 'leave') sched++; if (s2 === 'present' || s2 === 'late') pres++; if (s2 === 'late') late++; if (s2 === 'absent') abs++; });
        var rate = sched ? pres / sched : -1;
        cls += rate < 0 ? ' is-off' : rate >= 0.95 ? ' is-h4' : rate >= 0.85 ? ' is-h3' : rate >= 0.7 ? ' is-h2' : rate >= 0.5 ? ' is-h1' : ' is-h0';
        inner = sched ? '<span class="att-cal-big">' + pres + '<small>/' + sched + '</small></span><span class="att-cal-mini">' +
          (late ? '<span class="att-dot is-warn">' + late + ' late</span>' : '') + (abs ? '<span class="att-dot is-danger">' + abs + ' absent</span>' : '') + '</span>'
          : '<span class="att-cal-t">' + (list.length ? 'Off day' : '—') + '</span>';
      }
      if (date === t) cls += ' is-today';
      var mine = sel ? lv.filter(function (l) { return norm(l.name) === norm(sel.name); }) : lv;
      if (S.overlay && mine.length) {
        cls += ' has-leave';
        inner += '<button type="button" class="att-cal-leave"' + (sel ? kjm('leave', mine[0].id, { name: mine[0].type + ' · ' + sel.name }) : kjm('att-leave-day', date)) + ' title="' + esc(mine.map(function (l) { return l.name + ' · ' + l.type; }).join('\n')) + '">' +
          ico('plane') + '<span>' + (sel ? esc(mine[0].type) : mine.length + ' on leave') + '</span></button>' +
          (!sel ? '<span class="att-cal-avs">' + mine.slice(0, 3).map(function (l) { return '<span class="att-cal-av" title="' + esc(l.name) + '">' + esc(initials(l.name)) + '</span>'; }).join('') + (mine.length > 3 ? '<span class="att-cal-av is-more">+' + (mine.length - 3) + '</span>' : '') + '</span>' : '');
      }
      cells.push('<div class="' + cls + '"' + modal + ' aria-label="' + esc(fmtDate(date)) + '"><span class="att-cal-d">' + d + '</span>' + inner + '</div>');
    }
    var head = '';
    if (sel) {
      var mine2 = rows.filter(function (r) { return r.pid === sel.pid; });
      var cnt = { present: 0, late: 0, absent: 0, leave: 0 }, hrs = 0, otm = 0, otp = 0;
      mine2.forEach(function (r) { var s3 = effStatus(r); if (s3 === 'present' || s3 === 'late') cnt.present++; if (s3 === 'late') cnt.late++; if (s3 === 'absent') cnt.absent++; if (s3 === 'leave') cnt.leave++; if (r.hours) hrs += +r.hours;
        if (r.ot && r.ot.min > 0) { otm += r.ot.min; if (r.ot.st === 'pending') otp += r.ot.min; } });
      var st = function (icon, v, l, tone, status) {
        return '<button type="button" class="kj-stat att-mini' + (tone ? ' is-' + tone : '') + '" data-att-act="status" data-s="' + status + '"><span class="kj-stat-ico">' + ico(icon) + '</span><span class="att-stat-txt"><span class="kj-stat-val">' + esc(v) + '</span><span class="kj-stat-lbl">' + esc(l) + '</span></span></button>';
      };
      head = '<div class="att-cal-person">' + avatar(sel.photo, sel.name, 'kj-avatar-lg', kjm('person', sel.pid, { name: sel.name, photo: sel.photo })) +
        '<div class="att-cal-person-main"><button type="button" class="kj-link att-cal-person-name"' + kjm('person', sel.pid, { name: sel.name, photo: sel.photo }) + '>' + esc(sel.name) + '</button>' +
        '<span class="kj-muted">' + esc([sel.staffId, sel.dept].filter(Boolean).join(' · ')) + '</span></div>' +
        '<div class="att-cal-person-stats">' + st('circle-check', cnt.present, 'Days present', 'success', 'present') + st('clock-alert', cnt.late, 'Late', 'warn', 'late') +
        st('user-x', cnt.absent, 'Absent', 'danger', 'absent') + st('calendar-days', cnt.leave, 'On leave', 'purple', 'leave') +
        '<div class="kj-stat att-mini"><span class="kj-stat-ico">' + ico('timer') + '</span><span class="att-stat-txt"><span class="kj-stat-val">' + esc(fmtHours(hrs)) + '</span><span class="kj-stat-lbl">Hours worked</span></span></div>' +
        '<button type="button" class="kj-stat att-mini is-orange" data-att-act="status" data-s="ot" title="Overtime this month — ' + esc(otp ? fmtMin(otp) + ' still pending approval' : 'all decided') + '"><span class="kj-stat-ico">' + ico('timer') + '</span><span class="att-stat-txt"><span class="kj-stat-val">' + esc(fmtMin(otm)) + '</span><span class="kj-stat-lbl">Overtime' + (otp ? ' (' + esc(fmtMin(otp)) + ' pending)' : '') + '</span></span></button></div></div>';
    }
    var legend = sel
      ? [['present', 'Present'], ['late', 'Late'], ['absent', 'Absent'], ['leave', 'On leave'], ['off', 'Off day'], ['pending', 'Not yet in']]
      : [['h4', '≥95% in'], ['h3', '85–94%'], ['h2', '70–84%'], ['h1', '50–69%'], ['h0', '<50%'], ['off', 'Off day']];
    var leaveNote = lc ? '' : (S.leaves[S.ym] && S.leaves[S.ym].err ? ' (leave data unavailable)' : '');
    return head +
      '<div class="att-cal-bar"><div class="att-legend">' + legend.map(function (l) { return '<span class="att-legend-i is-' + l[0] + '"><i></i>' + esc(l[1]) + '</span>'; }).join('') + '</div><span class="kj-spacer"></span>' +
      '<button type="button" class="kj-chip att-toggle' + (S.overlay ? ' is-purple' : '') + '" data-att-act="overlay" aria-pressed="' + S.overlay + '">' + ico(S.overlay ? 'eye' : 'eye-off') + 'Team leave overlay' + esc(leaveNote) + '</button></div>' +
      '<div class="att-cal" role="grid"><div class="att-cal-wd">' + WEEKDAYS.map(function (w) { return '<span>' + w + '</span>'; }).join('') + '</div>' +
      '<div class="att-cal-grid">' + cells.join('') + '</div></div>' +
      (!rows.length ? '<p class="kj-help att-cal-note">' + ico('info') + 'No attendance records match the current filters for this month.</p>' : '');
  }

  /* ── side: month overtime per employee (from the month rows) ───────────── */
  function otMonthCard() {
    var m = S.months[S.ym], p = S.ym.split('-');
    if (!m || !m.rows) return '';
    var by = {}, total = 0, pend = 0;
    monthRows().forEach(function (r) {
      if (!r.ot || !(r.ot.min > 0) || (S.f.dept && r.dept !== S.f.dept)) return;
      var k = r.pid || r.name, e = by[k] || (by[k] = { pid: r.pid, name: r.name, photo: r.photo, dept: r.dept, min: 0, pend: 0, days: 0 });
      e.min += r.ot.min; e.days++; total += r.ot.min;
      if (r.ot.st === 'pending') { e.pend += r.ot.min; pend += r.ot.min; }
    });
    var list = Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.min - a.min; });
    var body = !list.length ? '<p class="kj-help att-ot-empty">' + ico('timer-off') + 'No overtime captured in ' + esc(MONTHS[+p[1] - 1]) + (S.f.dept ? ' for ' + esc(S.f.dept) : '') + '.</p>'
      : '<div class="kj-list att-ot-list">' + list.slice(0, 8).map(function (e) {
        return '<button type="button" class="kj-list-item" data-att-sel="' + esc(e.pid) + '"' + (e.pid ? '' : ' disabled') + '>' + avatar(e.photo, e.name, '') +
          '<span class="kj-list-main"><span class="kj-list-title kj-truncate">' + esc(e.name) + '</span><span class="kj-list-sub kj-truncate">' +
          esc(plural(e.days, 'day') + (e.pend ? ' · ' + fmtMin(e.pend) + ' pending' : ' · all approved')) + '</span></span><b class="kj-mono att-ot-sum">' + esc(fmtMin(e.min)) + '</b></button>';
      }).join('') + '</div>' + (list.length > 8 ? '<p class="kj-help">+' + (list.length - 8) + ' more in the Overtime tab.</p>' : '');
    return '<section class="kj-card att-side-card"><div class="kj-card-head"><div><div class="kj-card-title">' + ico('timer') + 'Overtime · ' + esc(MONTHS[+p[1] - 1]) + '</div>' +
      '<div class="kj-card-sub">' + (total ? esc(fmtMin(total)) + ' total' + (pend ? ' · ' + esc(fmtMin(pend)) + ' pending approval' : '') : 'Captured from camera sightings after shift end') + '</div></div>' +
      '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kj-nav="attendance/overtime">' + ico('list-checks') + '<span>Review</span></button></div>' + body + '</section>';
  }

  /* ── side: approvals + team leave + classic tools ──────────────────────── */
  function paintSide() {
    var el = $('att-side'); if (!el) return;
    var a = S.appr, html = '';
    if (a && !a.hidden) {
      var body;
      if (a.busy && !a.list) body = [1, 2, 3].map(function () { return '<div class="att-appr-skel"><span class="kj-skel kj-skel-circle"></span><div class="kj-spacer"><span class="kj-skel kj-skel-line"></span><span class="kj-skel kj-skel-line is-short"></span></div></div>'; }).join('');
      else if (a.err) body = emptyBox({ err: true, title: 'Approvals unavailable', text: a.err, actions: actBtn('retry-appr', 'Retry', 'refresh-cw') });
      else if (!a.list.length) body = emptyBox({ anim: 'success', icon: 'check-check', title: 'All caught up', text: 'No leave requests are waiting for your decision.' });
      else body = '<div class="att-appr-list">' + a.list.map(function (l) {
        var e = empIndex().name[norm(l.user_name)];
        var who = e ? '<button type="button" class="kj-link"' + kjm('person', e.pid, { name: e.name, photo: e.photo }) + '>' + esc(l.user_name) + '</button>' : '<b>' + esc(l.user_name || '—') + '</b>';
        var range = fmtShort(l.start_date) + (l.end_date && l.end_date !== l.start_date ? ' – ' + fmtShort(l.end_date) : '') + (l.half_day ? ' · ' + String(l.half_day_period || '').toUpperCase() : '');
        return '<div class="att-appr"' + kjm('leave', l.id, { name: (l.leave_type_name || 'Leave') + ' · ' + l.user_name }) + '>' +
          '<div class="att-appr-top">' + avatar(e && e.photo, l.user_name, '') + '<div class="att-appr-main"><div class="att-appr-who">' + who + '</div>' +
          '<div class="kj-muted att-appr-meta">' + esc([l.department, l.leave_no].filter(Boolean).join(' · ')) + '</div></div>' +
          '<span class="kj-chip is-purple">' + esc(l.leave_type_name || l.leave_type || 'Leave') + '</span></div>' +
          '<div class="att-appr-when">' + ico('calendar-range') + '<span>' + esc(range) + '</span><b>' + esc(plural(+l.days || 0, 'day')) + '</b></div>' +
          (l.reason ? '<div class="att-appr-reason kj-truncate" title="' + esc(l.reason) + '">' + esc(l.reason) + '</div>' : '') +
          '<div class="att-appr-acts">' +
            '<button type="button" class="kj-btn kj-btn-sm kj-btn-soft att-approve" data-att-act="decide" data-d="approve" data-id="' + esc(l.id) + '"' + (l.can && l.can.approve === false ? ' disabled' : '') + '>' + ico('check') + '<span>Approve</span></button>' +
            '<button type="button" class="kj-btn kj-btn-sm kj-btn-secondary att-reject" data-att-act="decide" data-d="reject" data-id="' + esc(l.id) + '"' + (l.can && l.can.reject === false ? ' disabled' : '') + '>' + ico('x') + '<span>Reject</span></button>' +
          '</div></div>';
      }).join('') + '</div>';
      var n = a.list ? a.total : 0;
      html += '<section class="kj-card att-side-card"><div class="kj-card-head"><div><div class="kj-card-title">' + ico('inbox') + 'Pending approvals' + (n ? ' <span class="kj-badge">' + n + '</span>' : '') + '</div>' +
        '<div class="kj-card-sub">Leave requests from your team</div></div>' +
        '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon kj-btn-sm" data-att-act="retry-appr" aria-label="Refresh approvals">' + ico('refresh-cw') + '</button></div>' + body + '</section>';
    }
    html += otMonthCard();
    // Team leave this month
    var c = S.leaves[S.ym], p = S.ym.split('-'), lbody;
    if (!c || (c.busy && !c.data)) lbody = '<span class="kj-skel kj-skel-line"></span><span class="kj-skel kj-skel-line is-mid"></span>';
    else if (c.err) lbody = emptyBox({ err: true, title: 'Team leave unavailable', text: c.err, actions: actBtn('retry-leave', 'Retry', 'refresh-cw') });
    else {
      var all = [];
      (c.data.departments || []).forEach(function (g) { (g.leaves || []).forEach(function (l) { if (!S.f.dept || g.department === S.f.dept) all.push({ l: l, dept: g.department }); }); });
      lbody = !all.length ? emptyBox({ icon: 'palmtree', title: 'Nobody on leave', text: 'No approved leave in ' + MONTHS[+p[1] - 1] + '.' })
        : '<div class="kj-list att-leave-list">' + all.slice(0, 12).map(function (x) {
          var l = x.l;
          return '<button type="button" class="kj-list-item"' + kjm('leave', l.id, { name: (l.leave_type_name || 'Leave') + ' · ' + l.name }) + '>' +
            '<span class="kj-avatar att-av-leave">' + esc(initials(l.name)) + '</span><span class="kj-list-main"><span class="kj-list-title kj-truncate">' + esc(l.name) + '</span>' +
            '<span class="kj-list-sub kj-truncate">' + esc((l.leave_type_name || l.leave_type) + ' · ' + fmtShort(l.start_date) + (l.end_date !== l.start_date ? '–' + fmtShort(l.end_date) : '') + ' · ' + x.dept) + '</span></span>' +
            (l.status === 'pending' ? '<span class="kj-chip is-warn">Pending</span>' : '') + ico('chevron-right') + '</button>';
        }).join('') + '</div>' + (all.length > 12 ? '<p class="kj-help">+' + (all.length - 12) + ' more — open the calendar view.</p>' : '');
    }
    html += '<section class="kj-card att-side-card"><div class="kj-card-head"><div><div class="kj-card-title">' + ico('plane') + 'Team leave</div><div class="kj-card-sub">' + MONTHS[+p[1] - 1] + ' ' + p[0] + '</div></div>' +
      '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-att-act="show-overlay">' + ico('calendar-days') + '<span>Calendar</span></button></div>' + lbody + '</section>';
    // Classic tools (legacy features stay one click away)
    html += '<section class="kj-card att-side-card att-tools"><div class="kj-card-title">' + ico('wrench') + 'More attendance tools</div><div class="kj-list">' +
      '<button type="button" class="kj-list-item" data-kj-nav="attendance/classic">' + ico('table-2') + '<span class="kj-list-main"><span class="kj-list-title">Daily register &amp; live sightings</span><span class="kj-list-sub">Shift exceptions, recent recognitions, unknown faces</span></span>' + ico('chevron-right') + '</button>' +
      '<button type="button" class="kj-list-item" data-att-act="export">' + ico('file-spreadsheet') + '<span class="kj-list-main"><span class="kj-list-title">Reports &amp; CSV export</span><span class="kj-list-sub">Daily, date range, movement, this view</span></span>' + ico('chevron-right') + '</button>' +
      '<button type="button" class="kj-list-item" data-kj-nav="people">' + ico('users') + '<span class="kj-list-main"><span class="kj-list-title">Employee directory</span><span class="kj-list-sub">Profiles, shifts, SenseStudio sync</span></span>' + ico('chevron-right') + '</button>' +
      '<button type="button" class="kj-list-item" data-kj-nav="movement">' + ico('route') + '<span class="kj-list-main"><span class="kj-list-title">Movement</span><span class="kj-list-sub">Where people went across camera points</span></span>' + ico('chevron-right') + '</button>' +
      '<a class="kj-list-item" href="/kiosk.php">' + ico('scan-face') + '<span class="kj-list-main"><span class="kj-list-title">Face check-in kiosk</span><span class="kj-list-sub">Clock in / out at the gate</span></span>' + ico('external-link') + '</a>' +
      '</div></section>';
    el.innerHTML = html;
    hydrateLottie(el);
  }

  /* ── interactions ──────────────────────────────────────────────────────── */
  function select(pid) {
    S.f.sel = S.f.sel === pid ? '' : pid; S.page = 1;
    paintStrip(); paintBody();
  }
  function setYm(ym) {
    if (ym === S.ym) return;
    S.ym = ym; S.page = 1;
    loadMonth(); loadLeaves(ym); paintSide();
  }
  function onClick(ev) {
    var t = ev.target; if (!(t instanceof Element)) return;
    var hit = t.closest('[data-att-act],[data-att-sel],[data-kj-modal],[data-kj-nav],a[href]');
    if (!hit || !S || !S.el.contains(hit)) return;
    if (!hit.hasAttribute('data-att-act') && !hit.hasAttribute('data-att-sel')) return;   // KJModal / nav / link handle it
    ev.stopPropagation();
    if (hit.hasAttribute('data-att-sel')) { select(hit.getAttribute('data-att-sel')); return; }
    if (hit.disabled) return;
    var act = hit.getAttribute('data-att-act');
    var strip = $('att-strip');
    switch (act) {
      case 'scroll-l': case 'scroll-r':
        if (strip) { var dx = (act === 'scroll-l' ? -1 : 1) * Math.max(240, strip.clientWidth * 0.8); if (strip.scrollBy) strip.scrollBy({ left: dx, behavior: 'smooth' }); else strip.scrollLeft += dx; }
        break;
      case 'view': S.view = hit.getAttribute('data-v') === 'calendar' ? 'calendar' : 'table'; paintBody(); break;
      case 'page': S.page = Math.max(1, +hit.getAttribute('data-p') || 1); paintBody(); var b = $('att-body'); if (b && b.scrollIntoView) b.scrollIntoView({ block: 'nearest' }); break;
      case 'overlay': S.overlay = !S.overlay; paintBody(); break;
      case 'show-overlay': S.view = 'calendar'; S.overlay = true; paintBody(); break;
      case 'status': S.f.status = hit.getAttribute('data-s') || ''; S.view = 'table'; S.page = 1; paintBody(); break;
      case 'clear-sel': S.f.sel = ''; S.page = 1; paintStrip(); paintBody(); break;
      case 'clear-status': S.f.status = ''; S.page = 1; paintBody(); break;
      case 'clear-dept': S.f.dept = ''; fillDepts(); S.page = 1; paintStrip(); paintStats(); paintBody(); paintSide(); break;
      case 'clear-filters':
        S.f = { q: '', dept: '', status: '', sel: '' }; S.page = 1;
        var q = S.el.querySelector('[data-att-f="q"]'); if (q) q.value = '';
        fillDepts(); paintStrip(); paintStats(); paintBody(); paintSide(); break;
      case 'this-month': var n = new Date(); setYmSelects(n.getFullYear() + '-' + pad(n.getMonth() + 1)); break;
      case 'retry-today': S.todayErr = ''; paintStrip(); paintStats(); loadToday(); break;
      case 'retry-month': loadMonth(true); break;
      case 'retry-appr': S.appr = { busy: true }; loadApprovals(); break;
      case 'retry-leave': loadLeaves(S.ym, true); break;
      case 'export': if (window.KJModal) window.KJModal.open('att-export', S.ym); break;
      case 'decide':
        var id = hit.getAttribute('data-id'), d = hit.getAttribute('data-d');
        var l = ((S.appr && S.appr.list) || []).filter(function (x) { return String(x.id) === String(id); })[0] || {};
        if (window.KJModal) window.KJModal.open('att-leave-decide', d + ':' + id, { name: (d === 'approve' ? 'Approve ' : 'Reject ') + (l.leave_type_name || 'leave') + ' · ' + (l.user_name || ''), leave: l });
        break;
    }
  }
  function setYmSelects(ym) {
    var p = ym.split('-');
    var ms = S.el.querySelector('[data-att-f="month"]'), ys = S.el.querySelector('[data-att-f="year"]');
    if (ms) ms.value = p[1];
    if (ys) { if (!ys.querySelector('option[value="' + p[0] + '"]')) ys.insertAdjacentHTML('afterbegin', '<option value="' + p[0] + '">' + p[0] + '</option>'); ys.value = p[0]; }
    setYm(ym);
  }
  function onKey(ev) {
    var t = ev.target;
    if ((ev.key === 'Enter' || ev.key === ' ') && t instanceof Element && t.hasAttribute('data-att-sel')) { ev.preventDefault(); ev.stopPropagation(); select(t.getAttribute('data-att-sel')); }
  }
  function onInput(ev) {
    var t = ev.target; if (!(t instanceof Element) || !t.hasAttribute('data-att-f')) return;
    var k = t.getAttribute('data-att-f'), v = t.value;
    if (k === 'q') {
      clearTimeout(S.timers.q);
      S.timers.q = setTimeout(function () { if (!S) return; S.f.q = v; S.page = 1; paintStrip(); paintBody(); }, 200);
      return;
    }
    if (ev.type !== 'change') return;
    if (k === 'dept') { S.f.dept = v; S.page = 1; paintStrip(); paintStats(); paintBody(); paintSide(); }
    else if (k === 'status') { S.f.status = v; S.page = 1; paintBody(); }
    else if (k === 'month' || k === 'year') {
      var ms = S.el.querySelector('[data-att-f="month"]'), ys = S.el.querySelector('[data-att-f="year"]');
      setYm(ys.value + '-' + ms.value);
    }
  }

  /* ── export ────────────────────────────────────────────────────────────── */
  function exportUrl(report) {
    var t = todayStr(), from = S.ym + '-01', end = monthEnd(S.ym), to = end < t ? end : t;
    var day = ymOf(t) === S.ym ? t : to;
    var q = { report: report, date: day, from: report === 'daily' ? day : from, to: report === 'daily' ? day : to, department: S.f.dept || '', q: S.f.q || '' };
    if (report === 'daily' && S.f.status && S.f.status !== 'leave') q.status = S.f.status;
    if (report === 'movement') { q.person_id = S.f.sel || ''; q.q = ''; }
    return apiUrl('/attendance/export', q);
  }
  function downloadView() {
    var rows = filteredRows();
    var head = ['Date', 'Staff ID', 'Employee', 'Department', 'Plant', 'Shift', 'Check-in', 'Check-out', 'Hours', 'Status', 'Late (min)', 'OT (min)', 'OT status'];
    var cell = function (v) { var s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var lines = [head.join(',')].concat(rows.map(function (r) {
      return [r.date, r.staffId, r.name, r.dept, r.plant, r.shift, r.inT, r.outT, r.hours == null ? '' : r.hours, (ST[effStatus(r)] || [r.status])[0], r.lateMin || '',
        r.ot && r.ot.st ? r.ot.min : '', r.ot && r.ot.st ? (OTST[r.ot.st] || [r.ot.st])[0] : ''].map(cell).join(',');
    }));
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'attendance-view-' + S.ym + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return rows.length;
  }

  /* ══ Overtime tab (#attendance/overtime) ═══════════════════════════════════
   * GET /overtime (records in scope + totals + rule), POST /overtime/{id}/approve|reject|reopen,
   * POST /overtime/recompute, GET /overtime/export (CSV). RBAC is server-side (leave-approval rules).
   */
  var O = null;
  function otFresh() {
    var t = todayStr();
    return { el: null, busy: false, err: '', data: null, seq: 0, timers: {},
      f: { from: t.slice(0, 8) + '01', to: t, status: 'pending', dept: '', plant: '', q: '' } };
  }
  function otParams() { var f = O.f; return { from: f.from, to: f.to, status: f.status || 'all', department: f.dept, plant: f.plant, q: f.q, limit: 500 }; }
  function otLoad() {
    if (!O) return;
    var my = O, seq = ++O.seq;
    O.busy = true; otPaintBody();
    getJSON('/overtime', otParams()).then(function (d) {
      if (O !== my || seq !== O.seq) return;
      O.data = d; O.err = ''; O.busy = false;
      otFillSelects(); otPaintRule(); otPaintKpis(); otPaintBody();
    }).catch(function (e) {
      if (O !== my || seq !== O.seq) return;
      O.busy = false; O.err = e.message || 'Could not load overtime';
      otPaintKpis(); otPaintBody();
    });
  }
  function otQ(id) { return O && O.el ? O.el.querySelector('#' + id) : null; }
  function otFrame() {
    var f = O.f, sel = function (key, list, cur) {
      return '<select class="kj-select" data-ot-f="' + key + '" aria-label="' + esc(list[0][1]) + '">' + list.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (cur === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
    };
    return '<div class="kj-page att-page att-ot-page">' +
      '<div class="kj-page-head att-head"><div><h2 class="kj-page-title">Overtime</h2>' +
        '<p class="kj-page-sub">Captured automatically from face sightings after shift end. Figures are estimates until a supervisor approves them.</p></div>' +
        '<div class="kj-row-wrap att-head-actions" id="att-ot-acts">' +
          '<button type="button" class="kj-btn kj-btn-secondary" data-ot-act="recompute" hidden>' + ico('refresh-cw') + '<span>Recompute</span></button>' +
          '<button type="button" class="kj-btn kj-btn-primary" data-ot-act="export">' + ico('download') + '<span>Export CSV</span></button>' +
        '</div></div>' +
      '<section class="kj-card att-ot-rule" id="att-ot-rule" aria-label="How overtime is captured"></section>' +
      '<div class="att-stats att-ot-kpis" id="att-ot-kpis"></div>' +
      '<section class="kj-card att-records">' +
        '<div class="att-toolbar att-ot-toolbar">' +
          '<label class="att-search">' + ico('search') + '<input class="kj-input" type="search" placeholder="Search employee or staff ID…" aria-label="Search employee" data-ot-f="q" value="' + esc(f.q) + '"></label>' +
          '<label class="att-ot-date"><span>From</span><input class="kj-input" type="date" data-ot-f="from" value="' + esc(f.from) + '" max="' + esc(todayStr()) + '" aria-label="From date"></label>' +
          '<label class="att-ot-date"><span>To</span><input class="kj-input" type="date" data-ot-f="to" value="' + esc(f.to) + '" max="' + esc(todayStr()) + '" aria-label="To date"></label>' +
          sel('status', [['all', 'All statuses'], ['pending', 'Pending approval'], ['approved', 'Approved'], ['rejected', 'Rejected']], f.status) +
          '<select class="kj-select" data-ot-f="dept" aria-label="Department"><option value="">All departments</option></select>' +
          '<select class="kj-select" data-ot-f="plant" aria-label="Plant"><option value="">All plants</option></select>' +
        '</div>' +
        '<div class="att-body" id="att-ot-body"></div>' +
      '</section></div>';
  }
  function otFillSelects() {
    if (!O || !O.el || !O.data) return;
    var fill = function (key, list, all, cur) {
      var s = O.el.querySelector('[data-ot-f="' + key + '"]'); if (!s) return;
      s.innerHTML = '<option value="">' + esc(all) + '</option>' + (list || []).map(function (v) { return '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join('');
    };
    var scoped = O.data.scope && O.data.scope !== 'all' && O.data.scope !== 'own';
    fill('dept', scoped ? [O.data.scope] : O.data.departments, scoped ? O.data.scope : 'All departments', scoped ? O.data.scope : O.f.dept);
    fill('plant', O.data.plants, 'All plants', O.f.plant);
    var rc = O.el.querySelector('[data-ot-act="recompute"]'); if (rc) rc.hidden = !O.data.is_approver;
  }
  function otPaintRule() {
    var el = otQ('att-ot-rule'); if (!el || !O.data) return;
    var d = O.data, shifts = d.shifts || [];
    var per = shifts.length > 1 ? '<ul class="att-ot-shifts">' + shifts.map(function (s) {
      return '<li><b>' + esc(s.name) + '</b> <span class="kj-mono">' + esc(s.start + '–' + s.end) + '</span> — ' + esc(s.rule) + '</li>'; }).join('') + '</ul>'
      : '<p class="att-ot-rule-txt">' + esc((shifts[0] && shifts[0].rule) || d.rule || '') + '</p>';
    el.innerHTML = '<div class="att-ot-rule-head">' + ico('scale') + '<div><div class="kj-card-title">How overtime is captured</div>' + per +
      '<p class="kj-help">' + ico('info') + 'Check-in and check-out are the first and last time a clock camera recognised the person — not a punch clock. ' +
      'Review the evidence (time and camera) before approving. Rules are set per shift in Settings › Attendance &amp; overtime.</p></div>' +
      (P.can('settings') ? '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kj-nav="settings/attendance">' + ico('settings') + '<span>Rules</span></button>' : '') + '</div>';
  }
  function otPaintKpis() {
    var el = otQ('att-ot-kpis'); if (!el) return;
    if (!O.data) { el.innerHTML = O.err ? '' : [1, 2, 3, 4].map(function () { return '<span class="kj-skel kj-skel-tile"></span>'; }).join(''); return; }
    var t = O.data.totals || {}, pe = t.pending || {}, ap = t.approved || {}, rj = t.rejected || {};
    var tile = function (icon, val, lbl, tone, status, sub) {
      return '<button type="button" class="kj-stat att-stat' + (tone ? ' is-' + tone : '') + (O.f.status === status ? ' is-on' : '') + '" data-ot-act="status" data-s="' + status + '"><span class="kj-stat-ico">' + ico(icon) + '</span>' +
        '<span class="att-stat-txt"><span class="kj-stat-val">' + esc(val) + '</span><span class="kj-stat-lbl">' + esc(lbl) + '</span>' + (sub ? '<span class="att-stat-sub">' + esc(sub) + '</span>' : '') + '</span></button>';
    };
    el.innerHTML = tile('hourglass', pe.n || 0, 'Pending approval', 'warn', 'pending', fmtMin(pe.min) + ' captured') +
      tile('circle-check', fmtMin(ap.min), 'Approved OT', 'success', 'approved', plural(ap.n || 0, 'record')) +
      tile('circle-x', rj.n || 0, 'Rejected', 'danger', 'rejected', fmtMin(rj.min) + ' not paid') +
      tile('users', t.people || 0, 'People with OT', 'orange', 'all', fmtDate(O.data.from) + ' – ' + fmtDate(O.data.to));
  }
  function otPaintBody() {
    var el = otQ('att-ot-body'); if (!el) return;
    if (!O.data && O.busy) { el.innerHTML = '<div class="att-table-skel">' + [1, 2, 3, 4, 5].map(function () { return '<div class="kj-row"><span class="kj-skel kj-skel-circle"></span><span class="kj-skel kj-skel-line"></span><span class="kj-skel kj-skel-line is-mid"></span></div>'; }).join('') + '</div>'; return; }
    if (O.err) { el.innerHTML = emptyBox({ err: true, title: 'Could not load overtime', text: O.err, actions: '<button type="button" class="kj-btn kj-btn-primary" data-ot-act="retry">' + ico('refresh-cw') + '<span>Retry</span></button>' }); hydrateOt(el); return; }
    var d = O.data || {}, recs = d.records || [];
    if (!recs.length) {
      var filtered = O.f.status !== 'all' || O.f.dept || O.f.plant || O.f.q;
      el.innerHTML = emptyBox({ anim: O.f.status === 'pending' ? 'success' : 'empty', icon: O.f.status === 'pending' ? 'check-check' : 'timer-off',
        title: O.f.status === 'pending' ? 'No overtime waiting for approval' : 'No overtime in this period',
        text: 'Overtime appears here when a clock camera sees someone at least the minimum time after their shift ends, or on a rest day.',
        actions: (filtered ? '<button type="button" class="kj-btn kj-btn-secondary" data-ot-act="clear">' + ico('filter-x') + '<span>Show all statuses</span></button>' : '') +
          '<button type="button" class="kj-btn kj-btn-secondary" data-kj-nav="attendance">' + ico('calendar-check') + '<span>Attendance</span></button>' });
      hydrateOt(el); return;
    }
    var dec = !!d.is_approver;
    var body = recs.map(function (r) {
      var s = OTST[r.status] || OTST.pending;
      var sight = function (at, loc, cam) {
        return at ? '<span class="kj-mono">' + esc(hm(at)) + '</span><span class="kj-muted att-ot-cam">' + esc([loc, cam].filter(Boolean).join(' · ')) + '</span>' : '<span class="kj-muted">—</span>';
      };
      var fig = r.status === 'rejected' ? fmtMin(r.calcMinutes) : fmtMin(r.minutes);
      var notes = [];
      if (r.status !== 'pending' && r.minutes !== r.calcMinutes && r.status === 'approved') notes.push('<span class="kj-chip is-info" title="The approver changed the captured figure">Captured ' + esc(fmtMin(r.calcMinutes)) + '</span>');
      if (r.changed) notes.push('<span class="kj-chip is-warn" title="New sightings or a rule change since the decision — the decided figure was kept">' + ico('triangle-alert') + 'Now ' + esc(fmtMin(r.calcMinutes)) + '</span>');
      if (r.provisional) notes.push('<span class="kj-chip is-info" title="The attendance window for this shift is still open — the figure can still grow">' + ico('clock') + 'Still open</span>');
      var acts = !r.canDecide ? '' : (r.status === 'pending'
        ? '<button type="button" class="kj-btn kj-btn-sm kj-btn-soft att-approve" data-ot-act="decide" data-d="approve" data-id="' + esc(r.id) + '">' + ico('check') + '<span>Approve</span></button>' +
          '<button type="button" class="kj-btn kj-btn-sm kj-btn-secondary att-reject" data-ot-act="decide" data-d="reject" data-id="' + esc(r.id) + '">' + ico('x') + '<span>Reject</span></button>'
        : '<button type="button" class="kj-btn kj-btn-sm kj-btn-ghost" data-ot-act="reopen" data-id="' + esc(r.id) + '">' + ico('undo-2') + '<span>Reopen</span></button>');
      return '<tr>' +
        '<td><span class="att-who"><span class="att-who-txt"><button type="button" class="kj-link att-name"' + kjm('person', r.personId, { name: r.name }) + '>' + esc(r.name || '—') + '</button>' +
          '<span class="kj-muted att-staff">' + esc([r.staffId, r.department].filter(Boolean).join(' · ')) + '</span></span></span></td>' +
        '<td class="att-nowrap">' + esc(fmtDate(r.date)) + '<span class="kj-muted att-ot-cam">' + esc(r.shift + (r.shiftEnd ? ' · ends ' + r.shiftEnd : '')) + '</span></td>' +
        '<td>' + sight(r.inAt, r.inLoc, r.inCam) + '</td>' +
        '<td>' + sight(r.outAt, r.outLoc, r.outCam) + '</td>' +
        '<td class="att-ot-fig"><b class="kj-mono">' + esc(fig) + '</b> <span class="kj-muted">' + esc(OTKIND[r.kind] || '') + '</span>' +
          '<span class="att-ot-explain" title="' + esc(r.explain + '\n' + r.rule) + '">' + esc(r.explain) + '</span>' + (notes.length ? '<span class="kj-row-wrap att-ot-notes">' + notes.join('') + '</span>' : '') + '</td>' +
        '<td class="att-nowrap"><span class="kj-chip kj-chip-dot is-' + s[1] + '">' + esc(r.status === 'pending' ? 'Pending' : s[0]) + '</span>' +
          (r.decidedBy ? '<span class="kj-muted att-ot-cam">' + esc(r.decidedBy + (r.decidedAt ? ' · ' + fmtShort(String(r.decidedAt).slice(0, 10)) : '')) + '</span>' : '') +
          (r.note ? '<span class="att-ot-explain" title="' + esc(r.note) + '">“' + esc(r.note) + '”</span>' : '') + '</td>' +
        (dec ? '<td class="kj-num att-nowrap"><span class="att-ot-acts">' + acts + '</span></td>' : '') + '</tr>';
    }).join('');
    el.innerHTML = '<div class="kj-table-wrap"><table class="kj-table att-table att-ot-table"><thead><tr><th>Employee</th><th>Date · shift</th><th>First sighting</th><th>Last sighting</th><th>Overtime · how derived</th><th>Status</th>' +
      (dec ? '<th class="kj-num"><span class="kj-sr-only">Actions</span></th>' : '') + '</tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="att-pager"><span class="kj-muted">' + esc(plural(recs.length, 'record') + (d.total > recs.length ? ' of ' + d.total + ' (narrow the dates to see the rest)' : '')) + '</span></div>';
  }
  function hydrateOt(el) { if (S) hydrateLottie(el); /* else: the static icon fallback stays */ }
  function otRecord(id) { return ((O && O.data && O.data.records) || []).filter(function (x) { return String(x.id) === String(id); })[0] || null; }
  function otClick(ev) {
    var t = ev.target; if (!(t instanceof Element) || !O) return;
    var hit = t.closest('[data-ot-act]'); if (!hit || !O.el.contains(hit) || hit.disabled) return;
    ev.stopPropagation();
    var act = hit.getAttribute('data-ot-act');
    if (act === 'retry') { O.err = ''; otLoad(); }
    else if (act === 'status') { O.f.status = hit.getAttribute('data-s') || 'all'; var s = O.el.querySelector('[data-ot-f="status"]'); if (s) s.value = O.f.status; otLoad(); }
    else if (act === 'clear') { O.f.status = 'all'; O.f.dept = ''; O.f.plant = ''; O.f.q = ''; O.el.innerHTML = otFrame(); otFillSelects(); otPaintRule(); otLoad(); }
    else if (act === 'export') { window.open(apiUrl('/overtime/export', otParams()), '_blank'); }
    else if (act === 'recompute') {
      hit.disabled = true;
      postJSON('/overtime/recompute', { from: O.f.from, to: O.f.to }).then(function (d) {
        toast('Recomputed ' + plural(d.days || 0, 'day') + ' — decided records were not changed', 'success'); hit.disabled = false; otLoad();
      }).catch(function (e) { hit.disabled = false; toast(e.message || 'Recompute failed', 'danger'); });
    } else if (act === 'decide') {
      var r = otRecord(hit.getAttribute('data-id')), d2 = hit.getAttribute('data-d');
      if (r && window.KJModal) { registerModals(); window.KJModal.open('att-ot-decide', d2 + ':' + r.id, { name: (d2 === 'approve' ? 'Approve OT · ' : 'Reject OT · ') + r.name, rec: r }); }
    } else if (act === 'reopen') {
      var r2 = otRecord(hit.getAttribute('data-id')); if (!r2) return;
      hit.disabled = true;
      postJSON('/overtime/' + encodeURIComponent(r2.id) + '/reopen', {}).then(function () { toast('Back to pending · ' + r2.name, 'warn'); otLoad(); })
        .catch(function (e) { hit.disabled = false; toast(e.message || 'Could not reopen', 'danger'); });
    }
  }
  function otInput(ev) {
    var t = ev.target; if (!(t instanceof Element) || !O || !t.hasAttribute('data-ot-f')) return;
    var k = t.getAttribute('data-ot-f'), v = t.value;
    if (k === 'q') { clearTimeout(O.timers.q); O.timers.q = setTimeout(function () { if (O) { O.f.q = v; otLoad(); } }, 300); return; }
    if (ev.type !== 'change') return;
    if (k === 'from' || k === 'to') { if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return; O.f[k] = v; }
    else O.f[k] = v;
    otLoad();
  }
  function otMount(el) {
    O = otFresh(); O.el = el;
    el.classList.add('att-host');
    el.innerHTML = otFrame();
    el.addEventListener('click', otClick);
    el.addEventListener('input', otInput);
    el.addEventListener('change', otInput);
    otPaintKpis(); otLoad();
  }
  function otUnmount(el) {
    if (!O) return;
    el.removeEventListener('click', otClick);
    el.removeEventListener('input', otInput);
    el.removeEventListener('change', otInput);
    el.classList.remove('att-host');
    Object.keys(O.timers).forEach(function (k) { clearTimeout(O.timers[k]); });
    O = null;
  }

  /* ── modal types (KJModal is deferred → register when it appears) ─────── */
  var registered = false;
  function registerModals() {
    var K = window.KJModal;
    if (registered || !K || !K.register) return registered;
    registered = true;
    var h = K.h;

    // Approve / reject a leave request (reject needs remarks ≥ 3 chars).
    K.register('att-leave-decide', {
      kicker: 'Leave approval', icon: 'calendar-check', size: 'sm', deepLink: false,
      load: function (ctx) {
        var id = String(ctx.id).split(':')[1];
        var l = ctx.data && ctx.data.leave;
        return (l && l.id) ? Promise.resolve(l) : getJSON('/leaves/' + encodeURIComponent(id)).then(function (d) { return d.leave; });
      },
      render: function (ctx, l) {
        var act = String(ctx.id).split(':')[0] === 'reject' ? 'reject' : 'approve';
        var range = fmtDate(l.start_date) + (l.end_date && l.end_date !== l.start_date ? ' → ' + fmtDate(l.end_date) : '');
        return {
          title: (act === 'reject' ? 'Reject' : 'Approve') + ' · ' + (l.user_name || 'leave request'), icon: act === 'reject' ? 'circle-x' : 'circle-check', tone: act === 'reject' ? 'danger' : 'success',
          body: '<div class="kj-card">' + h.kv([['Employee', l.user_name], ['Type', l.leave_type_name || l.leave_type], ['Dates', range], ['Days', l.days],
              ['Department', l.department], ['Reason', l.reason || '—']]) + '</div>' +
            '<div class="kj-field att-remarks-field"><label class="kj-label" for="att-remarks">' + (act === 'reject' ? 'Reason for rejection (required)' : 'Remarks (optional)') + '</label>' +
            '<textarea class="kj-textarea" id="att-remarks" rows="3" maxlength="500" placeholder="' + (act === 'reject' ? 'Tell the employee why — they will see this.' : 'Add a note for the employee…') + '"></textarea>' +
            '<div class="kj-help" id="att-remarks-help" aria-live="polite"></div></div>' +
            '<button type="button" class="kj-link" data-kj-modal="' + h.esc(spec('leave', l.id)) + '">Open full request</button>',
          foot: '<button type="button" class="kj-btn kj-btn-secondary" data-kj-close>Cancel</button>' +
            h.btn('go', act === 'reject' ? 'Reject request' : 'Approve request', act === 'reject' ? 'x' : 'check', act === 'reject' ? 'kj-btn-danger' : 'kj-btn-primary'),
          actions: {
            go: function (c, btn) {
              var ta = c.body.querySelector('#att-remarks'), help = c.body.querySelector('#att-remarks-help'), field = c.body.querySelector('.att-remarks-field');
              var rm = ta ? ta.value.trim() : '';
              if (act === 'reject' && rm.length < 3) {
                field.classList.add('is-error'); help.textContent = 'Please give a reason (at least 3 characters).'; if (ta) ta.focus(); return;
              }
              field.classList.remove('is-error'); help.textContent = '';
              btn.disabled = true;
              postJSON('/leaves/' + encodeURIComponent(l.id) + '/' + act, { remarks: rm }).then(function () {
                K.toast((act === 'reject' ? 'Rejected' : 'Approved') + ' · ' + (l.user_name || 'leave request'), act === 'reject' ? 'warn' : 'success');
                c.close();
                if (S && S.appr && S.appr.list) { S.appr.list = S.appr.list.filter(function (x) { return String(x.id) !== String(l.id); }); S.appr.total = Math.max(0, (S.appr.total || 1) - 1); paintSide(); }
                refreshLeaves();
              }).catch(function (e) {
                btn.disabled = false;
                field.classList.add('is-error');
                help.textContent = (e.message || 'Could not save the decision') + (e.status === 409 ? ' — the request may already have been decided.' : '');
                if (e.status === 409 || e.status === 404) refreshLeaves();
              });
            }
          },
          mount: function (c) { var ta = c.body.querySelector('#att-remarks'); if (ta) setTimeout(function () { try { ta.focus(); } catch (e) { /* ignore */ } }, 40); }
        };
      }
    });

    // Approve / reject one overtime record (reject needs a reason; a changed figure needs a note).
    K.register('att-ot-decide', {
      kicker: 'Overtime approval', icon: 'timer', size: 'sm', deepLink: false,
      load: function (ctx) {
        var id = String(ctx.id).split(':')[1];
        var r = ctx.data && ctx.data.rec;
        return (r && r.id) ? Promise.resolve(r) : getJSON('/overtime/' + encodeURIComponent(id)).then(function (d) { return d.record; });
      },
      render: function (ctx, r) {
        var act = String(ctx.id).split(':')[0] === 'reject' ? 'reject' : 'approve';
        var ev = function (at, loc, cam) { return at ? hm(at) + ' · ' + [loc, cam].filter(Boolean).join(' · ') : '—'; };
        return {
          title: (act === 'reject' ? 'Reject overtime' : 'Approve overtime') + ' · ' + (r.name || ''), icon: act === 'reject' ? 'circle-x' : 'circle-check', tone: act === 'reject' ? 'danger' : 'success',
          body: '<div class="kj-card">' + h.kv([['Employee', r.name + (r.staffId ? ' · ' + r.staffId : '')], ['Date', fmtDate(r.date)], ['Shift', r.shift + (r.shiftStart ? ' ' + r.shiftStart + '–' + r.shiftEnd : '')],
              ['First sighting', ev(r.inAt, r.inLoc, r.inCam)], ['Last sighting', ev(r.outAt, r.outLoc, r.outCam)],
              ['Captured OT', fmtMin(r.calcMinutes) + (OTKIND[r.kind] ? ' · ' + OTKIND[r.kind] : '')], ['How derived', r.explain || '—']]) +
              '<p class="kj-help att-ot-modal-rule">' + h.esc(r.rule || '') + ' The last sighting is when a camera last saw the person — confirm it before approving.</p></div>' +
            (act === 'approve' ? '<div class="kj-field att-remarks-field"><label class="kj-label" for="att-ot-min">Approved overtime (minutes)</label>' +
              '<input class="kj-input" id="att-ot-min" type="number" min="1" max="1440" step="1" inputmode="numeric" value="' + h.esc(r.calcMinutes) + '">' +
              '<div class="kj-help">Captured ' + h.esc(fmtMin(r.calcMinutes)) + '. Change it only with a note.</div></div>' : '') +
            '<div class="kj-field att-remarks-field"><label class="kj-label" for="att-ot-note">' + (act === 'reject' ? 'Reason for rejection (required)' : 'Note (optional)') + '</label>' +
            '<textarea class="kj-textarea" id="att-ot-note" rows="3" maxlength="500" placeholder="' + (act === 'reject' ? 'Tell the employee why — they will see this.' : 'Add a note for the employee…') + '"></textarea>' +
            '<div class="kj-help" id="att-ot-help" aria-live="polite"></div></div>',
          foot: '<button type="button" class="kj-btn kj-btn-secondary" data-kj-close>Cancel</button>' +
            h.btn('go', act === 'reject' ? 'Reject overtime' : 'Approve overtime', act === 'reject' ? 'x' : 'check', act === 'reject' ? 'kj-btn-danger' : 'kj-btn-primary'),
          actions: {
            go: function (c, btn) {
              var ta = c.body.querySelector('#att-ot-note'), help = c.body.querySelector('#att-ot-help'), field = ta && ta.closest('.att-remarks-field');
              var mi = c.body.querySelector('#att-ot-min');
              var note = ta ? ta.value.trim() : '', body = { note: note };
              var bad = function (msg, focus) { if (field) field.classList.add('is-error'); help.textContent = msg; if (focus) focus.focus(); };
              if (act === 'reject' && note.length < 3) { bad('Please give a reason (at least 3 characters).', ta); return; }
              if (mi) {
                var m = parseInt(mi.value, 10);
                if (!(m >= 1 && m <= 1440)) { bad('Approved minutes must be between 1 and 1440.', mi); return; }
                if (m !== +r.calcMinutes && note.length < 3) { bad('Add a note explaining why the figure differs from the captured ' + fmtMin(r.calcMinutes) + '.', ta); return; }
                body.minutes = m;
              }
              if (field) field.classList.remove('is-error'); help.textContent = '';
              btn.disabled = true;
              postJSON('/overtime/' + encodeURIComponent(r.id) + '/' + act, body).then(function () {
                K.toast((act === 'reject' ? 'Rejected' : 'Approved') + ' overtime · ' + (r.name || ''), act === 'reject' ? 'warn' : 'success');
                c.close();
                if (O) otLoad();
                if (S) loadToday(true);
              }).catch(function (e) {
                btn.disabled = false;
                bad((e.message || 'Could not save the decision') + (e.status === 409 ? ' — it may already have been decided.' : ''));
                if (e.status === 409 && O) otLoad();
              });
            }
          },
          mount: function (c) { var f = c.body.querySelector(act === 'reject' ? '#att-ot-note' : '#att-ot-min'); if (f) setTimeout(function () { try { f.focus(); } catch (e) { /* ignore */ } }, 40); }
        };
      }
    });

    // Who is on approved leave on one date (team-leave calendar drill-down).
    K.register('att-leave-day', {
      kicker: 'Team leave', icon: 'plane', size: 'md',
      load: function (ctx) {
        var date = /^\d{4}-\d{2}-\d{2}$/.test(String(ctx.id)) ? String(ctx.id) : todayStr();
        var c = S && leaveCal(ymOf(date));
        var p = c ? Promise.resolve(c.data) : getJSON('/leaves/calendar', { month: ymOf(date) });
        return p.then(function (d) { return { date: date, list: indexLeaves(d)[date] || [], scope: d.scope }; });
      },
      render: function (ctx, x) {
        var ix = S ? empIndex() : { name: {} };
        var body = x.list.length ? '<div class="kj-list">' + x.list.map(function (l) {
          var e = ix.name[norm(l.name)];
          return '<div class="kj-list-item"' + kjm('leave', l.id, { name: l.type + ' · ' + l.name }) + '>' + avatar(e && e.photo, l.name, '') +
            '<div class="kj-list-main"><div class="kj-list-title">' + (e ? h.link('person', e.pid, l.name, { name: e.name, photo: e.photo }) : h.esc(l.name)) + '</div>' +
            '<div class="kj-list-sub">' + h.esc([l.type + (l.half ? ' (' + l.half + ')' : ''), fmtShort(l.from) + (l.to !== l.from ? ' – ' + fmtShort(l.to) : ''), plural(+l.days || 0, 'day'), l.dept].filter(Boolean).join(' · ')) + '</div></div>' +
            (l.status === 'pending' ? h.chip('Pending', 'warn') : h.chip('Approved', 'success')) + '</div>';
        }).join('') + '</div>' : h.empty('palmtree', 'Nobody on leave', 'No approved leave covers this day' + (x.scope && x.scope !== 'all' ? ' in ' + x.scope : '') + '.');
        return {
          title: 'On leave · ' + h.fmtDate(x.date), icon: 'plane', tone: 'purple',
          body: '<div class="kj-grid-2">' + h.statTile('plane', x.list.length, 'People on leave', 'purple') +
            h.statTile('users', x.list.reduce(function (a, l) { return a.indexOf(l.dept) < 0 ? a.concat([l.dept]) : a; }, []).length, 'Departments', '') + '</div>' + h.section('Who', body),
          foot: h.btn('day', 'Day register', 'table-2', 'kj-btn-primary'),
          actions: { day: function () { K.open('attendance-day', x.date); } }
        };
      }
    });

    // Export: the legacy server reports (same /attendance/export the classic page used) + this view.
    K.register('att-export', {
      kicker: 'Export', icon: 'download', size: 'md', deepLink: false,
      render: function (ctx) {
        var ym = String(ctx.id), p = ym.split('-'), mn = (MONTHS[+p[1] - 1] || '') + ' ' + p[0];
        var sel = S && S.f.sel && empIndex().pid[S.f.sel];
        var card = function (act, icon, title, desc, scope) {
          return '<button type="button" class="kj-list-item att-exp" data-kj-action="' + act + '"><span class="kj-stat-ico">' + ico(icon) + '</span><span class="kj-list-main"><span class="kj-list-title">' + h.esc(title) + '</span>' +
            '<span class="kj-list-sub">' + h.esc(desc) + '</span><span class="att-exp-scope">' + h.esc(scope) + '</span></span>' + ico('download') + '</button>';
        };
        var flt = S ? [S.f.dept, S.f.q ? '"' + S.f.q + '"' : ''].filter(Boolean).join(' · ') : '';
        return {
          title: 'Export attendance · ' + mn, icon: 'download',
          body: '<div class="kj-list">' +
            card('daily', 'calendar-check', 'Daily register', 'One row per employee: shift, clock-in/out with location, hours, status, late minutes, exceptions, plants visited.', (ymOf(todayStr()) === ym ? 'Today' : 'Last day of ' + mn) + (flt ? ' · ' + flt : '')) +
            card('range', 'calendar-range', 'Month attendance (date range)', 'The daily register for every day of the month — late arrivals and absentee summaries.', mn + (flt ? ' · ' + flt : '')) +
            card('movement', 'route', 'Employee movement', 'Every detection grouped into visits: location, camera, arrive/depart, dwell.', (sel ? sel.name : 'All employees') + ' · ' + mn) +
            card('overtime', 'timer', 'Overtime records', 'Captured OT per employee-day with the evidence (first/last sighting and camera), the rule applied and the approval status.', mn + (S && S.f.dept ? ' · ' + S.f.dept : '')) +
            card('view', 'file-spreadsheet', 'This view (CSV)', 'Exactly the rows shown in the records table with the current filters.', S ? plural(filteredRows().length, 'row') : '—') +
            '</div><p class="kj-help">CSV files open in Excel with names intact (UTF-8).</p>',
          actions: {
            daily: function () { window.open(exportUrl('daily'), '_blank'); },
            range: function () { window.open(exportUrl('range'), '_blank'); },
            movement: function () { window.open(exportUrl('movement'), '_blank'); },
            overtime: function () {
              var t = todayStr(), end = monthEnd(ym);
              window.open(apiUrl('/overtime/export', { from: ym + '-01', to: end < t ? end : t, department: (S && S.f.dept) || '', status: 'all' }), '_blank');
            },
            view: function (c) { if (!S) return; var n = downloadView(); K.toast('Exported ' + plural(n, 'row'), 'success'); c.close(); }
          }
        };
      }
    });
    return true;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', registerModals);
  else setTimeout(registerModals, 0);

  /* ── module ────────────────────────────────────────────────────────────── */
  MOD = {
    title: 'Attendance',
    perm: 'view',
    defaultSub: 'register',
    subs: {
      // New admin page (M5). `aliases` keeps app.setPage('attendance') / goLegacy on it.
      register: { label: 'Attendance', aliases: ['attendance'] },
      // Captured overtime: review the evidence, approve / reject, export (RBAC server-side).
      overtime: { label: 'Overtime', icon: 'timer' },
      // Legacy register · live sightings · reports — linked from the new page.
      classic:  { label: 'Classic register', legacy: 'attendance', hidden: true }
    },

    enter: function (app, page) {
      if (page === 'attendance') { app.loadAttendance(); app.loadPeople(); app.loadRegister(); }
    },

    mount: function (el, route, app) {
      ensureCss();
      registerModals();
      if (!registered) {   // KJModal still loading (deferred) — keep trying briefly
        var tries = 0, iv = setInterval(function () { if (registerModals() || ++tries > 40) clearInterval(iv); }, 100);
      }
      if (route && route.sub === 'overtime') { otMount(el); return; }
      S = freshState(app);
      S.el = el;
      el.classList.add('att-host');
      el.innerHTML = frame();
      S.h = { click: onClick, key: onKey, input: onInput };
      el.addEventListener('click', onClick);
      el.addEventListener('keydown', onKey);
      el.addEventListener('input', onInput);
      el.addEventListener('change', onInput);
      syncToolbar(); paintStrip(); paintStats(); paintBody(); paintSide();
      loadToday();
      loadMonth();
      loadLeaves(S.ym);
      loadApprovals();
      if (app && app.loadPeople && !((app.state.people || {}).profiles && Object.keys(app.state.people.profiles).length)) { try { app.loadPeople(); } catch (e) { /* optional */ } }
    },

    unmount: function (el) {
      otUnmount(el);
      if (!S) return;
      el.removeEventListener('click', onClick);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('input', onInput);
      el.removeEventListener('change', onInput);
      el.classList.remove('att-host');
      Object.keys(S.timers).forEach(function (k) { clearTimeout(S.timers[k]); });
      S.anims.forEach(function (a) { try { a.anim.destroy(); } catch (e) { /* ignore */ } });
      S = null;
    },

    // 5 s feed: refresh today's register every 30 s, approvals every 2 min.
    onFeed: function (data, app, route) {
      if (!S || !route || route.sub !== 'register') return;
      S.tick++;
      if (S.tick % 6 === 0) loadToday(true);
      if (S.tick % 24 === 0) { loadApprovals(); loadLeaves(S.ym, true); }
    },

    // ── Legacy Component methods (verbatim from app.js; `this` is the dc app) ──
    methods: class {
  // ── Attendance & movement (POC Use Case 1 · /api/attendance) ──
  loadAttendance(force){
    if(this.state.attBusy && !force) return;
    this.setState({attBusy:true, attErr:''});
    fetch(`${this.API}/attendance?token=${this.TOK}&days=${this.state.attDays||1}`, {cache:'no-store'})
      .then(r=>r.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error('bad');
        this.setState({att:d, attBusy:false}); })
      .catch(()=>this.setState({attBusy:false, attErr:'Could not load attendance records'}));
  }
  setAttDays(n){ this.setState({attDays:n, attBusy:false}); setTimeout(()=>this.loadAttendance(true), 0); }
  // Chronological movement journey of one person across the predefined camera
  // points (Plant 1 / Plant 2 Guard Posts, Lobby, 8 Color, Conventional …).
  openJourney(p){
    if(!p || !p.personId) return;
    this.setState({modal:{type:'journey', data:null},
      jn:{personId:p.personId, name:p.name||'', staffId:p.staffId||'', photo:p.photo||p.lastImage||'', loading:true, data:null}});
    fetch(`${this.API}/attendance/person?token=${this.TOK}&person_id=${encodeURIComponent(p.personId)}&days=${this.state.attDays||1}`, {cache:'no-store'})
      .then(r=>r.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error('bad');
        this.setState(st=>(st.jn && st.jn.personId===p.personId)
          ? {jn:{...st.jn, loading:false, data:d.journey||{steps:[],visits:[]},
              name:st.jn.name||((d.profile&&d.profile.name)||''), staffId:st.jn.staffId||((d.profile&&d.profile.staffId)||''),
              photo:st.jn.photo||((d.profile&&d.profile.photo)||'')}} : {}); })
      .catch(()=>this.setState(st=>st.jn?{jn:{...st.jn, loading:false, failed:true}}:{}));
  }
  loadRegister(){
    const r=this.state.reg;
    const qs=new URLSearchParams({token:this.TOK, date:r.date||this.todayStr(), plant:r.plant||'', department:r.dept||'', q:r.q||'', status:r.status||''});
    this.setState(st=>({reg:{...st.reg, busy:true, err:''}}));
    fetch(`${this.API}/attendance/daily?${qs}`, {cache:'no-store'})
      .then(x=>x.json())
      .then(d=>{ if(!(d&&d.ok)) throw new Error('bad'); this.setState(st=>({reg:{...st.reg, busy:false, data:d}})); })
      .catch(()=>this.setState(st=>({reg:{...st.reg, busy:false, err:'Could not load the attendance register'}})));
  }
  setReg(patch){
    this.setState(st=>({reg:{...st.reg, ...patch}}));
    if(this._regT) clearTimeout(this._regT);
    this._regT=setTimeout(()=>this.loadRegister(), patch.q!=null?350:0);
  }
  setAttView(v){
    this.setState({attView:v});
    if(v==='register') this.loadRegister();
    if(v==='live') this.loadAttendance(true);
    if(v==='employees'||v==='reports'){ this.loadPeople(); if(!this.state.reg.data) this.loadRegister(); }
  }
  // CSV download: daily register, a date range, or the movement report.
  exportAtt(report){
    const r=this.state.reg, rp=this.state.rep, day=r.date||this.todayStr();
    const from=report==='daily'?day:(rp.from||day), to=report==='daily'?day:(rp.to||from);
    const qs=new URLSearchParams({token:this.TOK, report, date:day, from, to,
      plant:r.plant||'', department:r.dept||'', person_id:report==='movement'?(rp.person||''):''});
    if(report==='daily'){ qs.set('q', r.q||''); qs.set('status', r.status||''); }
    window.open(`${this.API}/attendance/export?${qs}`, '_blank');
  }
    }
  };
  window.KJPages.register('attendance', MOD);
})();
