/* Tickets hub — page module (assets/js/pages/tickets.js).
 * Owner: wave-2 M7 ticket-UI agent. Styles: assets/css/pages/tickets.css (injected below).
 *
 * #tickets            Table (default) — server-side datatable over GET /api/tickets/table:
 *                     ITSM tickets (TKT) + detection incidents (INC) merged, sortable headers,
 *                     debounced search, Type/Status/Priority/Camera filters, pagination,
 *                     live SLA countdown; KPI tiles use its merged `stats`.
 *                     Board — kanban of ITSM tickets only (New · Acknowledged · In Progress ·
 *                     Resolved · Closed) with SLA rings, proof thumbnails, drag-to-move
 *                     (POST /api/tickets/{id}/status; resolve asks for closing remarks).
 *                     Table | Board toggle (persisted), filters, New Ticket modal.
 * KJModal 'ticket'    full ITSM detail (overrides the generic kj-modal.js renderer):
 *                     SLA rings, detection evidence, person card, thread with internal
 *                     notes, reply + attachments, assignee/priority, resolve → close.
 * KJModal 'ticket-new' / 'ticket-resolve'   helper dialogs (not deep-linked).
 *
 * RBAC (docs/plan/AI_LAYER.md §3): workers (supervisor/admin + `tickets` perm) see every
 * ticket and may drag/assign/resolve; everyone else sees only their own tickets, can reply
 * and confirm-close their own resolved ticket. The API is the authority — 403/404/409/422
 * answers are surfaced as toasts and the matching controls are hidden.
 *
 * Legacy incident-ticket workspace methods (openTicket …) stay in `methods` because
 * app.js and the legacy event modal still call them.
 */
(function () {
  'use strict';

  /* ── constants ─────────────────────────────────────────── */
  var STATUSES = ['new', 'ack', 'in_progress', 'resolved', 'closed'];
  var ST = {
    new:         { label: 'New',          tone: 'primary', icon: 'circle-dot' },
    ack:         { label: 'Acknowledged', tone: 'warn',    icon: 'eye' },
    in_progress: { label: 'In Progress',  tone: 'info',    icon: 'loader' },
    resolved:    { label: 'Resolved',     tone: 'success', icon: 'circle-check' },
    closed:      { label: 'Closed',       tone: '',        icon: 'archive' }
  };
  var PRIO = {
    critical: { label: 'Critical', tone: 'danger', icon: 'siren' },
    high:     { label: 'High',     tone: 'orange', icon: 'arrow-up-right' },
    medium:   { label: 'Medium',   tone: 'warn',   icon: 'minus' },
    low:      { label: 'Low',      tone: 'primary', icon: 'arrow-down-right' }
  };
  var PRIOS = ['critical', 'high', 'medium', 'low'];
  var CATS = {
    general: 'General', safety: 'Safety', ppe_forklift: 'PPE · Forklift', attendance: 'Attendance',
    leave: 'Leave', it: 'IT', facility: 'Facility', incident: 'Incident'
  };
  var TRANSITIONS = {
    new: ['ack'], ack: ['in_progress', 'resolved'], in_progress: ['resolved'], resolved: ['closed', 'in_progress'], closed: []
  };
  var RES_CODES = [['fixed', 'Fixed'], ['corrective_action', 'Corrective action taken'], ['workaround', 'Workaround'],
    ['no_action', 'No action needed'], ['false_positive', 'False positive'], ['duplicate', 'Duplicate']];
  var RING_C = 2 * Math.PI * 19;     // ring radius 19 in a 44×44 viewBox
  var LIST_LIMIT = 200;

  /* ── tiny utils ────────────────────────────────────────── */
  function esc(v) { return v == null ? '' : String(v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ico(n, c) { return (window.KJIcon && window.KJIcon.svg) ? window.KJIcon.svg(n, c) : ''; }
  function pad(n) { return String(n).padStart(2, '0'); }
  function toMs(s) {
    if (s == null || s === '') return null;
    if (typeof s === 'number') return s;
    var d = new Date(String(s).replace(' ', 'T'));
    return isNaN(d) ? null : d.getTime();
  }
  function fmtStamp(s) {
    var t = toMs(s); if (t == null) return '—';
    var d = new Date(t);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fmtHM(s) { var t = toMs(s); if (t == null) return '—'; var d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fmtLeft(sec, long) {
    var neg = sec < 0, s = Math.abs(Math.round(sec));
    var m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24), out;
    if (s < 60) out = s + 's';
    else if (m < 60) out = m + 'm';
    else if (h < 24) out = long ? h + 'h ' + pad(m % 60) + 'm' : h + 'h' + (h < 10 && m % 60 ? ' ' + (m % 60) + 'm' : '');
    else out = d + 'd' + (long ? ' ' + (h % 24) + 'h' : '');
    return (neg ? '-' : '') + out;
  }
  function fmtDur(sec) { if (sec == null || isNaN(sec)) return '—'; return sec < 60 ? Math.max(0, Math.round(sec)) + 's' : fmtLeft(sec, true); }
  function initials(n) { return String(n || '?').trim().split(/\s+/).slice(0, 2).map(function (p) { return p[0] || ''; }).join('').toUpperCase() || '?'; }
  function chip(text, tone, extra) { return '<span class="kj-chip' + (tone ? ' is-' + tone : '') + (extra ? ' ' + extra : '') + '">' + esc(text) + '</span>'; }
  function prioChip(p) { var x = PRIO[p] || { label: p || '—', tone: '' }; return '<span class="kj-chip kj-tk-prio is-' + esc(x.tone || 'muted') + '">' + esc(x.label) + '</span>'; }
  // Detection-incident (INC) statuses that are not ITSM workflow states.
  var STX = {
    open: { label: 'Open', tone: 'primary' }, acknowledged: { label: 'Acknowledged', tone: 'warn' }, acked: { label: 'Acknowledged', tone: 'warn' },
    investigating: { label: 'Investigating', tone: 'info' }, escalated: { label: 'Escalated', tone: 'danger' },
    dismissed: { label: 'Dismissed', tone: '' }, false_positive: { label: 'False positive', tone: '' }
  };
  function humanize(s) { s = String(s || '').replace(/_/g, ' '); return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—'; }
  function statusChip(s) { var x = ST[s] || STX[s] || { label: humanize(s), tone: '' }; return '<span class="kj-chip kj-chip-dot kj-tk-st is-' + esc(x.tone || 'muted') + '">' + esc(x.label) + '</span>'; }
  function spec(type, id) { return type + ':' + encodeURIComponent(String(id)); }
  function avatar(name, photo, cls) {
    return photo ? '<img class="kj-avatar ' + (cls || '') + '" src="' + esc(photo) + '" alt="' + esc(name || '') + '" loading="lazy">'
      : '<span class="kj-avatar ' + (cls || '') + '" aria-hidden="true">' + esc(initials(name)) + '</span>';
  }
  function toast(msg, tone) { if (window.KJModal) window.KJModal.toast(msg, tone); }
  function bytes(n) { n = Number(n) || 0; return n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  function profileOf(pid) {
    var a = window.KJApp, p = a && a.state && a.state.people && a.state.people.profiles;
    return (p && pid != null && p[pid]) || null;
  }
  function store(k, v) { try { if (v === undefined) return window.localStorage.getItem(k); window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } return null; }

  /* ── API (session cookie; read token added like KJModal.h.api) ── */
  function url(path, params) {
    var base = (window.TMNS && window.TMNS.api) || '/api';
    var q = new URLSearchParams(params || {});
    var tok = window.TMNS && window.TMNS.token; if (tok) q.set('token', tok);
    var qs = q.toString();
    return base + path + (qs ? '?' + qs : '');
  }
  function req(method, path, body, params) {
    var o = { method: method, cache: 'no-store', credentials: 'same-origin' };
    if (body instanceof FormData) o.body = body;
    else if (body) { o.headers = { 'Content-Type': 'application/json' }; o.body = JSON.stringify(body); }
    return fetch(url(path, params), o).then(function (r) {
      return Promise.resolve(r.json ? r.json() : null).catch(function () { return null; }).then(function (d) {
        var status = r.status || 200;
        if (!d || d.ok === false || status >= 400) {
          var e = new Error((d && (d.error || d.msg)) || ('Request failed (' + status + ')'));
          e.status = (d && d.status) || status; throw e;
        }
        return d;
      });
    });
  }
  var get = function (p, q) { return req('GET', p, null, q); };
  var post = function (p, b) { return req('POST', p, b); };
  function errMsg(e) {
    if (!e) return 'Something went wrong.';
    if (e.status === 403) return 'You do not have permission for that action.';
    if (e.status === 404) return 'Ticket not found or no longer visible to you.';
    return e.message || 'Something went wrong.';
  }

  /* ── stylesheet + Lottie (external files, injected once) ── */
  function verOf() {
    var s = document.querySelector('script[src*="pages/tickets.js"]');
    var m = s && /\?(.*)$/.exec(s.getAttribute('src') || '');
    return m ? '?' + m[1] : '';
  }
  function ensureCss() {
    if (document.getElementById('kj-tickets-css')) return;
    var l = document.createElement('link');
    l.id = 'kj-tickets-css'; l.rel = 'stylesheet'; l.href = 'assets/css/pages/tickets.css' + verOf();
    (document.head || document.documentElement).appendChild(l);
  }
  var lottieP = null;
  function loadLottie() {
    if (window.lottie) return Promise.resolve(window.lottie);
    if (lottieP) return lottieP;
    lottieP = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'assets/vendor/lottie/lottie_light.min.js'; s.async = true;
      s.onload = function () { window.lottie ? res(window.lottie) : rej(new Error('lottie')); };
      s.onerror = function () { lottieP = null; rej(new Error('lottie')); };
      document.head.appendChild(s);
    });
    return lottieP;
  }
  function playLottie(el, file, loop) {
    if (!el) return null;
    var holder = { anim: null, dead: false };
    loadLottie().then(function (L) {
      if (holder.dead || !document.contains(el)) return;
      el.classList.add('is-playing');
      holder.anim = L.loadAnimation({ container: el, renderer: 'svg', loop: !!loop, autoplay: true, path: 'assets/lottie/' + file });
    }).catch(function () { /* the static Lucide icon stays */ });
    return { destroy: function () { holder.dead = true; if (holder.anim) { try { holder.anim.destroy(); } catch (e) { /* ignore */ } } } };
  }

  /* ── SLA model ─────────────────────────────────────────── */
  // Deadlines are tracked against the client clock: due = fetchedAt + remaining_s
  // (server and browser time zones may differ; durations never do).
  function slaClock(t, which) {
    var s = t && t.sla && t.sla[which];
    if (!s) return null;
    var span = (toMs(s.due_at) || 0) - (toMs(t.created_at) || 0);
    return {
      which: which, state: s.state, breached: !!s.breached, met_at: s.met_at,
      dueMs: s.remaining_s != null ? (t._at || Date.now()) + s.remaining_s * 1000 : null,
      span: span > 0 ? span : null, policyMin: t.sla.policy_min && t.sla.policy_min[which]
    };
  }
  /** Which clock a card shows: response until it is met, then resolution. */
  function cardClock(t) {
    var r = slaClock(t, 'response');
    if (r && r.state === 'running') return r;
    return slaClock(t, 'resolution') || r;
  }
  /** {tone, frac, text, sub} for a clock right now. */
  function clockView(c, long) {
    if (!c) return { tone: 'idle', frac: 0, text: '—', sub: 'SLA' };
    if (c.state === 'met') return { tone: 'met', frac: 1, text: long ? 'Met' : '✓', sub: c.which === 'response' ? 'RESP' : 'SLA', met: true };
    if (c.state === 'breached' && c.dueMs == null) return { tone: 'bad', frac: 1, text: long ? 'Breached' : '!', sub: 'LATE' };
    var left = (c.dueMs - Date.now()) / 1000;
    var frac = c.span ? Math.max(0, Math.min(1, left * 1000 / c.span)) : (left > 0 ? 1 : 0);
    var tone = left <= 0 ? 'bad' : frac <= 0.25 ? 'bad' : frac <= 0.5 ? 'warn' : 'ok';
    return { tone: tone, frac: left <= 0 ? 1 : frac, text: fmtLeft(left, long), sub: left <= 0 ? 'OVERDUE' : (c.which === 'response' ? 'RESP' : 'SLA'), left: left };
  }
  function ringSvg(cls) {
    return '<svg class="kj-tk-ring-svg ' + (cls || '') + '" viewBox="0 0 44 44" aria-hidden="true">' +
      '<circle class="kj-tk-ring-track" cx="22" cy="22" r="19"></circle>' +
      '<circle class="kj-tk-ring-bar" cx="22" cy="22" r="19" transform="rotate(-90 22 22)" stroke-dasharray="' + RING_C.toFixed(2) + '" stroke-dashoffset="' + RING_C.toFixed(2) + '"></circle></svg>';
  }
  /** Ring markup; JS (tickRing) sets the arc + text so it animates and ticks live. */
  function ringHtml(key, which, size) {
    return '<span class="kj-tk-ring kj-tk-ring-' + (size || 'sm') + '" data-tk-ring="' + esc(key) + '" data-tk-which="' + esc(which || 'card') + '">' +
      ringSvg() + '<span class="kj-tk-ring-txt"><b></b><small></small></span></span>';
  }
  function tickRing(el, clock, long) {
    var v = clockView(clock, long);
    el.className = el.className.replace(/\bis-(ok|warn|bad|met|idle)\b/g, '').trim() + ' is-' + v.tone;
    var bar = el.querySelector('.kj-tk-ring-bar');
    if (bar) bar.style.strokeDashoffset = (RING_C * (1 - v.frac)).toFixed(2);
    var b = el.querySelector('.kj-tk-ring-txt b'), sm = el.querySelector('.kj-tk-ring-txt small');
    if (b && b.textContent !== v.text) b.textContent = v.text;
    if (sm && sm.textContent !== v.sub) sm.textContent = v.sub;
    el.setAttribute('title', clock ? (clock.which === 'response' ? 'Response SLA' : 'Resolution SLA') + ' · ' + (v.met ? 'met' : v.left != null ? (v.left < 0 ? 'overdue by ' + fmtLeft(-v.left, true) : fmtLeft(v.left, true) + ' left') : 'breached') : 'No SLA');
    return v;
  }

  /* ── workflow helpers ──────────────────────────────────── */
  /** Shortest chain of allowed transitions from → to (e.g. new → ack → resolved). */
  function pathTo(from, to) {
    if (from === to) return [];
    var seen = {}, q = [[from, []]]; seen[from] = 1;
    while (q.length) {
      var cur = q.shift();
      var nx = TRANSITIONS[cur[0]] || [];
      for (var i = 0; i < nx.length; i++) {
        if (seen[nx[i]]) continue;
        var p = cur[1].concat(nx[i]);
        if (nx[i] === to) return p;
        seen[nx[i]] = 1; q.push([nx[i], p]);
      }
    }
    return null;
  }
  /** Run a chain of status POSTs; remarks go with the resolve step. Resolves to the final ticket. */
  function runPath(t, steps, remarks, code) {
    var id = t.id, last = null;
    return steps.reduce(function (p, s) {
      return p.then(function () {
        var body = { status: s };
        if (s === 'resolved') { body.remarks = remarks || ''; body.resolution_code = code || 'fixed'; }
        return post('/tickets/' + encodeURIComponent(id) + '/status', body).then(function (r) { last = r.ticket; });
      });
    }, Promise.resolve()).then(function () { return last; });
  }

  /* ── datatable helpers (GET /api/tickets/table: TKT + INC merged, server-side paging) ── */
  var PER_PAGES = [25, 50, 100];
  // [cell key, header label, server sort key | null]
  var COLS = [['thumb', '', null], ['no', 'No', 'no'], ['type', 'Type', null], ['title', 'Title', null], ['priority', 'Priority', 'priority'],
    ['status', 'Status', 'status'], ['camera', 'Camera', 'camera'], ['assignee', 'Assignee', null], ['sla', 'SLA', 'sla'], ['created', 'Created', 'created']];
  var CLOSED_ST = ['resolved', 'closed', 'dismissed', 'false_positive'];
  function freshFilters() { return { q: '', priority: '', category: '', camera: '', quick: '', type: '', status: '' }; }
  function isOpenSt(s) { return CLOSED_ST.indexOf(String(s || '')) < 0; }
  function ago(v) {
    var t = toMs(v); if (t == null) return '—';
    var m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60); if (h < 24) return h + ' h ago';
    var d = Math.round(h / 24); return d < 14 ? d + ' d ago' : fmtStamp(v);
  }
  function fullStamp(v) {
    var t = toMs(v); if (t == null) return '';
    return new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  /** Both TKT-* and INC-* open through the 'ticket' modal (INC falls back to the incident view). */
  function rowSpec(r) { return spec('ticket', r.no || r.id); }
  /** Live SLA view of a table row: left_s ticks down from the fetch time; pct = % of the window used. */
  function slaView(r, at) {
    var s = r && r.sla; if (!s) return null;
    var left = s.left_s != null ? Number(s.left_s) - (Date.now() - (at || Date.now())) / 1000 : null;
    var pct = s.pct != null && !isNaN(Number(s.pct)) ? Number(s.pct) : null;
    var span = left != null && pct != null && pct < 100 && Number(s.left_s) > 0 ? Number(s.left_s) / (1 - pct / 100) : null;
    var breached = !!s.breached || (left != null && left <= 0);
    var frac = breached ? 1 : span ? Math.max(0, Math.min(1, left / span)) : (pct != null ? Math.max(0, Math.min(1, 1 - pct / 100)) : 1);
    var tone = breached ? 'bad' : frac <= 0.25 ? 'bad' : frac <= 0.5 ? 'warn' : 'ok';
    var text = left == null ? (breached ? 'Breached' : '—') : left > 0 ? fmtLeft(left, true) + ' left' : 'Overdue ' + fmtLeft(-left, true);
    var due = s.due_at ? ' · due ' + fmtStamp(s.due_at) : '';
    return { tone: tone, frac: frac, text: text, breached: breached, title: (breached ? 'SLA breached' : 'SLA running') + due };
  }
  function pageList(p, n) {
    if (n <= 7) { var all = []; for (var i = 1; i <= n; i++) all.push(i); return all; }
    var out = [1], a = Math.max(2, p - 1), b = Math.min(n - 1, p + 1);
    if (p <= 3) { a = 2; b = 4; } else if (p >= n - 2) { a = n - 3; b = n - 1; }
    if (a > 2) out.push('…');
    for (var k = a; k <= b; k++) out.push(k);
    if (b < n - 1) out.push('…');
    out.push(n);
    return out;
  }
  /** Empty / error box with a Lottie (static Lucide icon until the player loads). */
  function emptyBox(o) {
    return '<div class="kj-empty kjt-empty' + (o.err ? ' is-error' : '') + '">' +
      '<span class="kj-tk-lottie kj-tk-lottie-lg" data-tk-lottie-play="' + (o.err ? 'error-alert.json' : 'empty-box.json') + '">' + ico(o.icon || 'inbox') + '</span>' +
      '<div class="kj-empty-title">' + esc(o.title) + '</div>' + (o.text ? '<div class="kj-empty-text">' + esc(o.text) + '</div>' : '') +
      (o.actions ? '<div class="kj-row-wrap kj-tk-center">' + o.actions + '</div>' : '') + '</div>';
  }
  function actBtn(act, label, icon, cls) {
    return '<button type="button" class="kj-btn ' + (cls || 'kj-btn-secondary') + '" data-tk-act="' + act + '">' + ico(icon) + '<span>' + esc(label) + '</span></button>';
  }

  /* ======================================================================
   * Page module
   * ==================================================================== */
  var M = {
    title: 'Tickets',
    perm: 'tickets',
    defaultSub: 'board',
    subs: {
      board: { label: 'Board' }
    },

    _el: null, _tickets: null, _worker: null, _err: null, _loading: false, _fetchedAt: 0,
    _filters: null, _view: 'table', _enrich: {}, _timer: null, _lotties: [], _celLottie: null, _sig: '',
    // datatable state
    _tbl: null, _rows: null, _total: 0, _stats: null, _tErr: null, _tBusy: false, _tLoading: false,
    _tAt: 0, _capped: false, _tFetchedAt: 0, _tSeq: 0, _tSig: '', _viewRows: [], _camSeen: null, _qT: null, _tTop: false,

    mount: function (el, route, app) {
      ensureCss();
      this._el = el; this._app = app;
      this._filters = this._filters || freshFilters();
      if (!this._tbl) {
        var per = Number(store('kj.tickets.per'));
        this._tbl = { page: 1, per: PER_PAGES.indexOf(per) >= 0 ? per : 25, sort: 'created', dir: 'desc' };
      }
      this._camSeen = this._camSeen || {};
      this._view = store('kj.tickets.view') === 'board' ? 'board' : 'table';
      this._sig = ''; this._tSig = '';
      el.innerHTML = this.shellHtml();
      this.syncControls();
      this.bind(el);
      this.paint();
      this.load();
      this.loadTable();
      var self = this;
      this._timer = setInterval(function () { self.tick(); }, 1000);
    },
    unmount: function (el) {
      if (this._timer) clearInterval(this._timer);
      if (this._qT) clearTimeout(this._qT);
      this._timer = null; this._qT = null;
      this._tSeq++; this._tLoading = false; this._tBusy = false;   // drop in-flight table answers
      this.killLotties(); this.killCelebrate();
      this._el = null;
      if (el) el.innerHTML = '';
    },
    onFeed: function (data, app) {
      if (!this._el) return;
      this._app = app;
      var now = Date.now();
      if (!document.hidden) {
        // ITSM list (board) every 20 s; merged table + KPI stats every 10 s — both ride the 5 s feed.
        if (!this._loading && now - this._fetchedAt > 20000) this.load(true);
        if (!this._tLoading && now - this._tFetchedAt > 10000) this.loadTable(true);
      }
      // Without the table API the KPIs + table fall back to the live feed — repaint from it.
      if (!this._stats) { this.paintKpis(); this.paintCelebrate(); }
      if (this._view === 'table' && this._rows == null && this._tErr) this.paintTable();
    },

    /* ── data ── */
    load: function (quiet) {
      var self = this;
      if (this._loading) return this._loading;
      if (!quiet && !this._tickets) this.paint();
      this._loading = get('/tickets', { limit: LIST_LIMIT }).then(function (d) {
        var at = Date.now();
        self._tickets = (d.tickets || []).map(function (t) {
          t._at = at;
          // GET /tickets rows carry message_count / attachment_count / proof_url — no detail fetch needed.
          if (t.message_count != null) self._enrich[t.id] = { v: t.updated_at, comments: t.message_count, files: t.attachment_count, proof: t.proof_url || null };
          return t;
        });
        self._worker = !!d.is_worker; self._err = null; self._fetchedAt = at;
      }).catch(function (e) {
        self._err = e; self._fetchedAt = Date.now();
      }).then(function () {
        self._loading = false;
        self._tSig = '';                     // worker flag may have changed the table columns
        self.paint();
        self.enrich();
      });
      return this._loading;
    },
    /** GET /tickets/table for the current page/sort/filters. quiet = background refresh (no skeleton). */
    loadTable: function (quiet) {
      var self = this, seq = ++this._tSeq;
      this._tLoading = true; this._tFetchedAt = Date.now();
      if (!quiet) { this._tBusy = true; if (this._view === 'table') this.paintTable(); }
      return get('/tickets/table', this.tableParams()).then(function (d) {
        if (seq !== self._tSeq) return;
        self._rows = d.rows || []; self._total = Number(d.total) || 0; self._stats = d.stats || null;
        self._tAt = Date.now(); self._tErr = null; self._capped = !!d.capped;
        if (typeof d.is_worker === 'boolean' && d.is_worker !== self._worker) { self._worker = d.is_worker; self._tSig = ''; }
        if (d.per_page && PER_PAGES.indexOf(Number(d.per_page)) >= 0) self._tbl.per = Number(d.per_page);
        if (d.page) self._tbl.page = Number(d.page) || self._tbl.page;
        self._rows.forEach(function (r) { if (r.camera) self._camSeen[r.camera] = 1; });
        // The page fell off the end (rows closed / filters narrowed) → step back to the last page.
        var pages = Math.max(1, Math.ceil(self._total / self._tbl.per));
        if (self._total > 0 && self._tbl.page > pages) { self._tbl.page = pages; return self.loadTable(true); }
      }).catch(function (e) {
        if (seq !== self._tSeq) return;
        if (self._rows == null) self._tErr = e;         // nothing to show yet → error state (+ feed fallback)
        else if (!quiet) toast(errMsg(e), 'danger');    // keep the last good page on screen
      }).then(function () {
        if (seq !== self._tSeq) return;
        self._tLoading = false; self._tBusy = false;
        if (!self._el) return;
        self.paintKpis(); self.paintCelebrate(); self.paintCameraOptions();
        if (self._view === 'table') self.paintTable();
      });
    },
    tableParams: function () {
      var f = this._filters, t = this._tbl;
      var p = { page: t.page, per_page: t.per, sort: t.sort, dir: t.dir };
      if (f.q.trim()) p.q = f.q.trim();
      p.type = f.type || 'all';
      if (f.status) p.status = f.status;
      if (f.priority) p.priority = f.priority;
      if (f.camera) p.camera = f.camera;
      if (f.quick) p.quick = f.quick;          // KPI tile hint (breached / soon / unassigned) — ignored if unsupported
      return p;
    },
    /** Rows synthesised from the live feed — only used while /tickets/table is unavailable. */
    feedRows: function () {
      var app = this._app || window.KJApp;
      return ((app && app.state && app.state.events) || []).filter(function (e) { return e && e.ticket; }).slice(0, 50).map(function (e) {
        var no = String(e.ticket), sev = String(e.sev || e.severity || '').toLowerCase();
        return { type: /^TKT/i.test(no) ? 'ticket' : 'incident', id: e.id, no: no, title: e.title || e.type || 'Detection',
          status: e.status || 'open', priority: PRIO[sev] ? sev : (sev === 'crit' ? 'critical' : 'medium'),
          camera: e.camera || '', location: e.zone || e.location || '', assignee: e.assignee || '',
          created_at: e.ts || e.received || null, updated_at: e.ts || null, image: e.image || null, sla: null };
      });
    },
    /** Fallback only: counts + proof thumbnail normally ride on the list rows (see load()); an older
     *  API without those fields falls back to the per-ticket detail route (cached per updated_at). */
    enrich: function () {
      var self = this, list = (this._tickets || []).slice();
      var closedLeft = 12;
      var todo = list.filter(function (t) {
        if (t.message_count != null) return false;
        if (t.status === 'closed' && closedLeft-- <= 0) return false;
        var c = self._enrich[t.id];
        return !c || c.v !== t.updated_at;
      }).slice(0, 60);
      var run = function () {
        var t = todo.shift(); if (!t || !self._el) return Promise.resolve();
        return get('/tickets/' + t.id).then(function (r) {
          var d = r.ticket || {}, att = d.attachments || [], msgs = d.messages || [];
          var proof = att.filter(function (a) { return a.kind === 'proof'; })[0] || att.filter(function (a) { return /^image\//.test(a.mime || ''); })[0];
          self._enrich[t.id] = {
            v: t.updated_at, comments: msgs.filter(function (m) { return m.kind === 'comment'; }).length,
            files: att.filter(function (a) { return a.kind === 'file'; }).length, proof: proof ? proof.url : null
          };
          self.paintCardExtras(t.id);
        }).catch(function () { self._enrich[t.id] = { v: t.updated_at, comments: null, files: null, proof: null }; }).then(run);
      };
      return Promise.all([run(), run(), run()]);
    },
    byId: function (id) { return (this._tickets || []).filter(function (t) { return String(t.id) === String(id) || t.ticket_no === String(id); })[0] || null; },
    /** Apply a fresh ticket from an action response to the local list (+repaint). */
    upsert: function (t) {
      if (!t || !this._tickets) return;
      t._at = Date.now();
      var i = -1;
      this._tickets.forEach(function (x, k) { if (x.id === t.id) i = k; });
      var lite = {}; Object.keys(t).forEach(function (k) { if (k !== 'messages' && k !== 'attachments') lite[k] = t[k]; });
      if (i >= 0) this._tickets[i] = lite; else this._tickets.unshift(lite);
      if (t.messages || t.attachments) {
        var att = t.attachments || [];
        var proof = att.filter(function (a) { return a.kind === 'proof'; })[0] || att.filter(function (a) { return /^image\//.test(a.mime || ''); })[0];
        this._enrich[t.id] = { v: t.updated_at, comments: (t.messages || []).filter(function (m) { return m.kind === 'comment'; }).length,
          files: att.filter(function (a) { return a.kind === 'file'; }).length, proof: proof ? proof.url : null };
      }
      this._sig = '';
      this.paint();
      if (this._el) this.loadTable(true);      // table row + KPI stats follow immediately
    },
    filtered: function () {
      var f = this._filters, q = f.q.trim().toLowerCase(), now = Date.now();
      return (this._tickets || []).filter(function (t) {
        if (f.priority && t.priority !== f.priority) return false;
        if (f.category && t.category !== f.category) return false;
        if (f.camera && String(t.camera || '') !== f.camera) return false;
        if (q && [t.ticket_no, t.title, t.location, t.camera, t.assignee, t.requester].join(' ').toLowerCase().indexOf(q) < 0) return false;
        if (f.quick) {
          var open = t.status !== 'resolved' && t.status !== 'closed';
          if (f.quick === 'open' && !open) return false;
          if (f.quick === 'breached' && !(t.sla && (t.sla.response.breached || t.sla.resolution.breached))) return false;
          if (f.quick === 'soon') { var c = cardClock(t); if (!open || !c || c.dueMs == null || c.dueMs - now > 3600000 || c.dueMs < now) return false; }
          if (f.quick === 'unassigned' && (!open || t.assignee_user_id)) return false;
        }
        return true;
      });
    },
    filtersActive: function () {
      var f = this._filters;
      return !!(f.q.trim() || f.priority || f.category || f.camera || f.quick || f.type || f.status);
    },

    /* ── render ── */
    shellHtml: function () {
      var worker = this._worker !== false;
      return '<div class="kj-page kj-tk-page">' +
        '<div class="kj-page-head"><div><h2 class="kj-page-title">Tickets</h2>' +
          '<p class="kj-page-sub" data-tk="sub">Manage incidents from detection to resolution, with response and resolution SLAs.</p></div>' +
          '<div class="kj-row-wrap kj-tk-head-actions">' +
            '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon" data-tk-act="refresh" aria-label="Refresh tickets" title="Refresh">' + ico('refresh-cw') + '</button>' +
            '<button type="button" class="kj-btn kj-btn-primary" data-tk-act="new">' + ico('plus') + '<span>New Ticket</span></button></div></div>' +
        '<div class="kj-tk-kpis" data-tk="kpis"></div>' +
        '<div class="kj-tk-toolbar">' +
          '<label class="kj-tk-search">' + ico('search') + '<input type="search" class="kj-input" data-tk-f="q" placeholder="Search tickets, incidents, locations, people…" aria-label="Search tickets and incidents" value="' + esc(this._filters.q) + '"></label>' +
          '<label class="kj-tk-filter" data-tk-only="table" data-tk="typewrap">' + ico('layers') + '<select class="kj-select" data-tk-f="type" aria-label="Type"><option value="">All types</option>' +
            '<option value="ticket">Tickets (TKT)</option><option value="incident">Incidents (INC)</option></select></label>' +
          '<label class="kj-tk-filter" data-tk-only="table">' + ico('circle-dot') + '<select class="kj-select" data-tk-f="status" aria-label="Status"><option value="">Status</option>' +
            '<option value="open">Open (any)</option>' + STATUSES.map(function (s) { return '<option value="' + s + '">' + ST[s].label + '</option>'; }).join('') + '</select></label>' +
          '<label class="kj-tk-filter">' + ico('flag') + '<select class="kj-select" data-tk-f="priority" aria-label="Priority"><option value="">Priority</option>' +
            PRIOS.map(function (p) { return '<option value="' + p + '">' + PRIO[p].label + '</option>'; }).join('') + '</select></label>' +
          '<label class="kj-tk-filter" data-tk-only="board">' + ico('tag') + '<select class="kj-select" data-tk-f="category" aria-label="Category"><option value="">Category</option>' +
            Object.keys(CATS).map(function (c) { return '<option value="' + c + '">' + CATS[c] + '</option>'; }).join('') + '</select></label>' +
          '<label class="kj-tk-filter' + (worker ? '' : ' is-hidden') + '" data-tk="camwrap">' + ico('cctv') + '<select class="kj-select" data-tk-f="camera" aria-label="Camera"><option value="">Camera</option></select></label>' +
          '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm kj-tk-clear is-hidden" data-tk-act="clear">' + ico('x') + '<span>Clear</span></button>' +
          '<span class="kj-spacer"></span>' +
          '<div class="kj-tabs kj-tk-view" role="tablist" aria-label="View">' +
            '<button type="button" class="kj-tab" role="tab" data-tk-view="table">' + ico('table') + '<span>Table</span></button>' +
            '<button type="button" class="kj-tab" role="tab" data-tk-view="board">' + ico('columns-3') + '<span>Board</span></button></div>' +
        '</div>' +
        '<div class="kjt-viewnote is-hidden" data-tk-only="board"><button type="button" class="kj-chip kjt-note" data-tk-view="table" title="Switch to the table">' +
          ico('info') + '<span>Board shows ITSM tickets — incidents live in the table</span></button></div>' +
        '<div class="kj-tk-celebrate is-hidden" data-tk="celebrate"></div>' +
        '<div data-tk="main"></div>' +
      '</div>';
    },
    /** Selects keep their values across remounts (filters live on the registered module). */
    syncControls: function () {
      var f = this._filters;
      if (!this._el) return;
      this._el.querySelectorAll('select[data-tk-f]').forEach(function (s) { s.value = f[s.getAttribute('data-tk-f')] || ''; });
    },
    bind: function (el) {
      var self = this;
      el.addEventListener('input', function (ev) {
        var f = ev.target.getAttribute && ev.target.getAttribute('data-tk-f');
        if (f !== 'q') return;
        self._filters.q = ev.target.value; self._sig = ''; self.paint();
        // board filters instantly; the server-side table search is debounced
        if (self._qT) clearTimeout(self._qT);
        self._qT = setTimeout(function () { self._qT = null; self._tbl.page = 1; self.loadTable(); }, 300);
      });
      el.addEventListener('change', function (ev) {
        var tg = ev.target;
        var f = tg.getAttribute && tg.getAttribute('data-tk-f');
        if (f && f !== 'q') {
          self._filters[f] = tg.value;
          if (f === 'status' && self._filters.quick && tg.value !== 'open') self._filters.quick = '';
          self._sig = ''; self.paint();
          if (f !== 'category') { self._tbl.page = 1; self.loadTable(); }
          return;
        }
        if (tg.hasAttribute && tg.hasAttribute('data-tkt-per')) {
          self._tbl.per = PER_PAGES.indexOf(Number(tg.value)) >= 0 ? Number(tg.value) : 25;
          store('kj.tickets.per', String(self._tbl.per));
          self._tbl.page = 1; self.loadTable();
        }
      });
      el.addEventListener('keydown', function (ev) {
        // table rows are focusable: Enter / Space opens the detail modal like a click
        if ((ev.key === 'Enter' || ev.key === ' ') && ev.target instanceof Element && ev.target.hasAttribute('data-tkt-row')) {
          ev.preventDefault(); ev.target.click();
        }
      });
      el.addEventListener('click', function (ev) {
        var t = ev.target instanceof Element ? ev.target : null; if (!t) return;
        var v = t.closest('[data-tk-view]');
        if (v) {
          self._view = v.getAttribute('data-tk-view') === 'board' ? 'board' : 'table';
          store('kj.tickets.view', self._view); self._sig = ''; self._tSig = ''; self.paint(); return;
        }
        var q = t.closest('[data-tk-quick]');
        if (q) { self.setQuick(q.getAttribute('data-tk-quick')); return; }
        var so = t.closest('[data-tkt-sort]');
        if (so) { self.sortBy(so.getAttribute('data-tkt-sort')); return; }
        var pg = t.closest('[data-tkt-page]');
        if (pg) {
          var n = Number(pg.getAttribute('data-tkt-page'));
          if (!pg.disabled && n >= 1 && n !== self._tbl.page) { self._tbl.page = n; self._tTop = true; self.loadTable(); }
          return;
        }
        var a = t.closest('[data-tk-act]');
        if (!a) return;
        var act = a.getAttribute('data-tk-act');
        if (act === 'new') self.openNew();
        else if (act === 'refresh') { self._fetchedAt = 0; self.load(); self.loadTable(); }
        else if (act === 'retry') { self._err = null; self._tickets = null; self.paint(); self.load(); }
        else if (act === 'tretry') { self._tErr = null; self._rows = null; self.loadTable(); }
        else if (act === 'clear') {
          self._filters = freshFilters();
          el.querySelectorAll('[data-tk-f]').forEach(function (i) { i.value = ''; });
          self._sig = ''; self._tbl.page = 1; self.paint(); self.loadTable();
        }
      });
      // Drag & drop between columns (workers only; cards are draggable only for them).
      el.addEventListener('dragstart', function (ev) {
        var card = ev.target instanceof Element && ev.target.closest('[data-tk-card]'); if (!card) return;
        var t = self.byId(card.getAttribute('data-tk-card')); if (!t) return;
        self._drag = t;
        card.classList.add('is-dragging');
        if (ev.dataTransfer) { try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', String(t.id)); } catch (e) { /* ignore */ } }
        el.querySelectorAll('[data-tk-col]').forEach(function (c) {
          var s = c.getAttribute('data-tk-col');
          c.classList.add(s === t.status ? 'is-origin' : (pathTo(t.status, s) ? 'is-drop-ok' : 'is-drop-no'));
        });
      });
      el.addEventListener('dragend', function () { self.clearDrag(); });
      el.addEventListener('dragover', function (ev) {
        var col = ev.target instanceof Element && ev.target.closest('[data-tk-col]');
        if (!col || !self._drag || !col.classList.contains('is-drop-ok')) return;
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
        el.querySelectorAll('.is-drop-over').forEach(function (c) { if (c !== col) c.classList.remove('is-drop-over'); });
        col.classList.add('is-drop-over');
      });
      el.addEventListener('dragleave', function (ev) {
        var col = ev.target instanceof Element && ev.target.closest('[data-tk-col]');
        if (col && !col.contains(ev.relatedTarget)) col.classList.remove('is-drop-over');
      });
      el.addEventListener('drop', function (ev) {
        var col = ev.target instanceof Element && ev.target.closest('[data-tk-col]');
        var t = self._drag;
        self.clearDrag();
        if (!col || !t) return;
        ev.preventDefault();
        self.moveTo(t, col.getAttribute('data-tk-col'));
      });
    },
    clearDrag: function () {
      this._drag = null;
      if (!this._el) return;
      this._el.querySelectorAll('.is-dragging').forEach(function (c) { c.classList.remove('is-dragging'); });
      this._el.querySelectorAll('[data-tk-col]').forEach(function (c) { c.classList.remove('is-drop-ok', 'is-drop-no', 'is-drop-over', 'is-origin'); });
    },
    /** KPI tile → quick filter. Open/breached/soon/unassigned all narrow the table to open items. */
    setQuick: function (k) {
      var f = this._filters, on = f.quick !== k;
      f.quick = on ? k : '';
      if (on) {
        f.status = 'open';
        if (k === 'breached' || k === 'soon') { this._tbl.sort = 'sla'; this._tbl.dir = 'asc'; }
      } else if (f.status === 'open') f.status = '';
      this.syncControls();
      this._sig = ''; this._tbl.page = 1;
      this.paint(); this.loadTable();
    },
    /** 3-state header sort: asc → desc → back to the default (newest first). */
    sortBy: function (col) {
      var t = this._tbl;
      if (col === 'created') t.dir = t.sort === 'created' && t.dir === 'desc' ? 'asc' : 'desc';
      else if (t.sort !== col) t.dir = 'asc';
      else if (t.dir === 'asc') t.dir = 'desc';
      else { col = 'created'; t.dir = 'desc'; }
      t.sort = col; t.page = 1;
      this.loadTable();
    },

    paint: function () {
      var el = this._el; if (!el) return;
      var main = el.querySelector('[data-tk="main"]'); if (!main) return;
      var worker = !!this._worker, view = this._view;
      // header bits that depend on the role / view
      el.querySelectorAll('.kj-tk-view [data-tk-view]').forEach(function (b) {
        var on = b.getAttribute('data-tk-view') === view;
        b.classList.toggle('is-active', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      el.querySelectorAll('[data-tk-only]').forEach(function (x) { x.classList.toggle('is-hidden', x.getAttribute('data-tk-only') !== view); });
      var sub = el.querySelector('[data-tk="sub"]');
      if (sub && this._tickets) sub.textContent = worker ? 'Manage tickets and detection incidents from detection to resolution, with response and resolution SLAs.'
        : 'Tickets you raised — follow progress, reply, and confirm once resolved.';
      var cw = el.querySelector('[data-tk="camwrap"]'); if (cw) cw.classList.toggle('is-hidden', this._tickets != null && !worker);
      // staff see only their own ITSM tickets (no incidents) → the Type filter is moot
      var tw = el.querySelector('[data-tk="typewrap"]'); if (tw && this._worker === false) tw.classList.add('is-hidden');
      var clr = el.querySelector('[data-tk-act="clear"]');
      if (clr) clr.classList.toggle('is-hidden', !this.filtersActive());
      this.paintCameraOptions();
      this.paintKpis();
      this.paintCelebrate();

      if (view === 'table') { this._sig = ''; this.paintTable(); return; }
      this._tSig = '';
      if (this._err && !this._tickets) {
        this._sig = 'err';
        this.killLotties();
        main.innerHTML = '<div class="kj-card kj-tk-errcard">' + KJPagesEmpty({ icon: 'cloud-off', title: 'Tickets are not available right now',
          text: errMsg(this._err) + ' — detection incidents are still listed in the table view.' }) +
          '<div class="kj-row-wrap kj-tk-center"><button type="button" class="kj-btn kj-btn-secondary" data-tk-act="retry">' + ico('refresh-cw') + '<span>Retry</span></button></div></div>';
        return;
      }
      if (!this._tickets) { if (this._sig !== 'skel') { this._sig = 'skel'; this.killLotties(); main.innerHTML = this.skeletonHtml(); } return; }

      var list = this.filtered(), f = this._filters;
      var sig = [view, worker, JSON.stringify(f), list.map(function (t) { return t.id + ':' + t.status + ':' + t.updated_at + ':' + t.priority; }).join('|')].join('#');
      if (sig !== this._sig) {
        this._sig = sig;
        this.killLotties();
        main.innerHTML = this.boardHtml(list);
        var self = this;
        // rings animate in from empty on the next frame
        requestAnimationFrame(function () { self.tick(); });
      }
    },
    skeletonHtml: function () {
      var col = '<div class="kj-tk-col"><div class="kj-tk-col-head"><span class="kj-skel kj-skel-line is-mid"></span></div>' +
        [0, 1, 2].map(function () {
          return '<div class="kj-tk-card is-skel"><span class="kj-skel kj-skel-line is-short"></span><span class="kj-skel kj-skel-line"></span>' +
            '<span class="kj-skel kj-skel-line is-mid"></span><span class="kj-skel kj-skel-block kj-tk-skel-thumb"></span></div>';
        }).join('') + '</div>';
      return '<div class="kj-tk-board" aria-busy="true">' + col + col + col + col + col + '</div>';
    },
    /** Merged KPI numbers: server stats from /tickets/table (TKT + INC); local fallback while it is unavailable. */
    statsNow: function () {
      if (this._stats) return this._stats;
      if (!this._tickets) return null;
      var all = this._tickets, now = Date.now();
      var open = all.filter(function (t) { return t.status !== 'resolved' && t.status !== 'closed'; });
      var inc = this.feedRows().filter(function (r) { return r.type === 'incident' && isOpenSt(r.status); }).length;
      return {
        open: open.length + inc, tickets_open: open.length, incidents_open: inc,
        breached: all.filter(function (t) { return t.sla && (t.sla.response.breached || t.sla.resolution.breached) && t.status !== 'closed'; }).length,
        due_1h: open.filter(function (t) { var c = cardClock(t); return c && c.dueMs != null && c.dueMs > now && c.dueMs - now <= 3600000; }).length,
        unassigned: open.filter(function (t) { return !t.assignee_user_id; }).length
      };
    },
    paintKpis: function () {
      var box = this._el && this._el.querySelector('[data-tk="kpis"]'); if (!box) return;
      var s = this.statsNow(), q = this._filters.quick;
      if (!s) { if (box.innerHTML) box.innerHTML = ''; return; }
      var n = function (v) { return Number(v) || 0; };
      var tile = function (key, icon, val, lbl, tone, sub) {
        return '<button type="button" class="kj-stat kj-tk-kpi' + (tone ? ' is-' + tone : '') + (q === key ? ' is-selected' : '') + '" data-tk-quick="' + key + '" aria-pressed="' + (q === key) + '">' +
          '<span class="kj-stat-ico">' + ico(icon) + '</span><span><span class="kj-stat-val">' + val + '</span><span class="kj-stat-lbl">' + esc(lbl) + '</span>' +
          (sub ? '<span class="kjt-kpi-sub">' + esc(sub) + '</span>' : '') + '</span></button>';
      };
      var to = n(s.tickets_open), io = n(s.incidents_open);
      var sub = to && io ? to + ' ticket' + (to === 1 ? '' : 's') + ' · ' + io + ' incident' + (io === 1 ? '' : 's') : '';
      var html = tile('open', 'inbox', n(s.open), 'Open', '', sub) +
        tile('breached', 'alarm-clock-off', n(s.breached), 'SLA breached', n(s.breached) ? 'danger' : 'success') +
        tile('soon', 'hourglass', n(s.due_1h), 'Due within 1 h', n(s.due_1h) ? 'warn' : '') +
        (this._worker ? tile('unassigned', 'user-round-x', n(s.unassigned), 'Unassigned', n(s.unassigned) ? 'orange' : '') : '');
      if (box.innerHTML !== html) box.innerHTML = html;
    },
    paintCameraOptions: function () {
      var sel = this._el && this._el.querySelector('[data-tk-f="camera"]'); if (!sel) return;
      var cams = {};
      Object.keys(this._camSeen || {}).forEach(function (c) { cams[c] = 1; });
      (this._tickets || []).forEach(function (t) { if (t.camera) cams[t.camera] = 1; });
      if (this._filters.camera) cams[this._filters.camera] = 1;
      var keys = Object.keys(cams).sort();
      var sig = keys.join('|');
      if (sel.getAttribute('data-sig') === sig) return;
      sel.setAttribute('data-sig', sig);
      sel.innerHTML = '<option value="">Camera</option>' + keys.map(function (c) { return '<option value="' + esc(c) + '">' + esc(c) + '</option>'; }).join('');
      sel.value = this._filters.camera;
    },
    /** "All clear" banner — only when the merged open count (tickets + incidents) is exactly 0. */
    paintCelebrate: function () {
      var box = this._el && this._el.querySelector('[data-tk="celebrate"]'); if (!box) return;
      var s = this.statsNow();
      var show = !!s && Number(s.open) === 0;
      var was = !box.classList.contains('is-hidden');
      box.classList.toggle('is-hidden', !show);
      if (!show && was) this.killCelebrate();
      if (show && !was) {
        this.killCelebrate();
        box.innerHTML = '<span class="kj-tk-lottie" data-tk-lottie>' + ico('party-popper') + '</span>' +
          '<div><div class="kj-tk-celebrate-title">No open tickets — all clear!</div>' +
          '<div class="kj-tk-celebrate-text">Every ticket and detection incident is resolved or closed. New detections that need attention will land here.</div></div>';
        this._celLottie = playLottie(box.querySelector('[data-tk-lottie]'), 'success-check.json', false);
      }
    },
    killLotties: function () { (this._lotties || []).forEach(function (l) { if (l) l.destroy(); }); this._lotties = []; },
    killCelebrate: function () { if (this._celLottie) this._celLottie.destroy(); this._celLottie = null; },

    /* ── datatable ── */
    theadHtml: function (worker) {
      var t = this._tbl;
      return '<thead><tr>' + COLS.filter(function (c) { return worker || c[0] !== 'camera'; }).map(function (c) {
        var cls = 'kjt-c-' + c[0];
        if (!c[2]) return '<th scope="col" class="' + cls + '">' + (c[1] ? esc(c[1]) : '<span class="kj-sr-only">Image</span>') + '</th>';
        var on = t.sort === c[2], dir = on ? (t.dir === 'asc' ? 'ascending' : 'descending') : 'none';
        return '<th scope="col" class="' + cls + ' is-sortable' + (on ? ' is-sorted' : '') + '" aria-sort="' + dir + '">' +
          '<button type="button" class="kjt-sort" data-tkt-sort="' + c[2] + '" title="Sort by ' + esc(c[1].toLowerCase()) + '">' + esc(c[1]) +
          ico(on ? (t.dir === 'asc' ? 'arrow-up' : 'arrow-down') : 'chevrons-up-down') + '</button></th>';
      }).join('') + '</tr></thead>';
    },
    rowHtml: function (r, i, worker) {
      var inc = r.type === 'incident';
      var sp = esc(rowSpec(r));
      // INC rows carry a seed so the ticket modal can show the incident even outside the live-feed window.
      var seed = inc ? ' data-kj-seed=\'' + esc(JSON.stringify({ incident: { id: r.id, ticket: r.no, title: r.title, camera: r.camera, zone: r.location,
        status: r.status, image: r.image, assignee: r.assignee, ts: r.created_at, sev: r.priority } })) + '\'' : '';
      var thumb = r.image
        ? '<button type="button" class="kjt-thumb" data-kj-modal="' + esc(spec('image', r.image)) + '" data-kj-seed=\'' + esc(JSON.stringify({ label: (r.no || '') + ' · ' + (r.title || '') })) + '\' aria-label="View image for ' + esc(r.no || '') + '">' +
            '<img src="' + esc(r.image) + '" alt="" loading="lazy"></button>'
        : '<span class="kjt-thumb is-none" aria-hidden="true">' + ico(inc ? 'scan-eye' : 'ticket') + '</span>';
      var sv = slaView(r, this._tAt);
      var sla = sv ? '<span class="kjt-sla is-' + sv.tone + (sv.breached ? ' is-breached' : '') + '" data-tkt-sla="' + i + '" title="' + esc(sv.title) + '">' +
          '<span class="kj-tk-ring kjt-ring is-' + sv.tone + '">' + ringSvg() + '</span><span class="kjt-sla-txt">' + esc(sv.text) + '</span></span>'
        : '<span class="kj-muted">—</span>';
      var asg = r.assignee
        ? '<span class="kj-tk-assignee">' + avatar(r.assignee, null, 'kj-tk-av') + '<span class="kj-truncate">' + esc(r.assignee) + '</span></span>'
        : '<span class="kj-tk-assignee is-none">' + avatar('?', null, 'kj-tk-av is-empty') + '<span class="kj-truncate">Unassigned</span></span>';
      var counts = (Number(r.comments) || Number(r.attachments)) ? '<span class="kjt-counts">' +
          (Number(r.comments) ? '<span title="Comments">' + ico('message-square') + Number(r.comments) + '</span>' : '') +
          (Number(r.attachments) ? '<span title="Attachments">' + ico('paperclip') + Number(r.attachments) + '</span>' : '') + '</span>' : '';
      return '<tr class="kjt-row is-' + (inc ? 'inc' : 'tkt') + (sv && sv.breached ? ' is-breached' : '') + '" data-kj-modal="' + sp + '"' + seed +
          ' data-tkt-row tabindex="0" aria-label="' + esc((r.no || '') + ' ' + (r.title || '')) + '">' +
        '<td class="kjt-c-thumb">' + thumb + '</td>' +
        '<td class="kjt-c-no"><button type="button" class="kjt-no" data-kj-modal="' + sp + '"' + seed + '>' + esc(r.no || ('#' + r.id)) + '</button></td>' +
        '<td class="kjt-c-type">' + (inc ? chip('INC', 'orange', 'kjt-type') : chip('TKT', 'primary', 'kjt-type')) + '</td>' +
        '<td class="kjt-c-title"><span class="kjt-title" title="' + esc(r.title || '') + '">' + esc(r.title || '—') + '</span>' +
          ((r.location || counts) ? '<span class="kjt-sub">' + (r.location ? '<span class="kj-truncate">' + esc(r.location) + '</span>' : '') + counts + '</span>' : '') + '</td>' +
        '<td class="kjt-c-priority">' + prioChip(r.priority) + '</td>' +
        '<td class="kjt-c-status">' + statusChip(r.status) + '</td>' +
        (worker ? '<td class="kjt-c-camera">' + (r.camera ? '<span class="kjt-cam">' + ico('cctv') + '<span class="kj-truncate">' + esc(r.camera) + '</span></span>' : '<span class="kj-muted">—</span>') + '</td>' : '') +
        '<td class="kjt-c-assignee">' + asg + '</td>' +
        '<td class="kjt-c-sla">' + sla + '</td>' +
        '<td class="kjt-c-created"><time title="' + esc(fullStamp(r.created_at)) + '">' + esc(ago(r.created_at)) + '</time></td></tr>';
    },
    skelRowsHtml: function (ncol, n) {
      var row = '<tr class="kjt-row is-skel"><td class="kjt-c-thumb"><span class="kj-skel kjt-thumb"></span></td>';
      for (var c = 1; c < ncol; c++) row += '<td><span class="kj-skel kj-skel-line' + (c % 3 ? ' is-mid' : '') + '"></span></td>';
      row += '</tr>';
      var out = ''; for (var i = 0; i < n; i++) out += row;
      return out;
    },
    pagerHtml: function () {
      var t = this._tbl, total = this._total, pages = Math.max(1, Math.ceil(total / t.per)), p = Math.min(t.page, pages);
      var from = total ? (p - 1) * t.per + 1 : 0, to = Math.min(total, p * t.per);
      var nums = pageList(p, pages).map(function (n) {
        return n === '…' ? '<span class="kjt-gap" aria-hidden="true">…</span>'
          : '<button type="button" class="kjt-pg' + (n === p ? ' is-active' : '') + '" data-tkt-page="' + n + '"' + (n === p ? ' aria-current="page"' : '') + ' aria-label="Page ' + n + '">' + n + '</button>';
      }).join('');
      return '<div class="kjt-foot">' +
        '<span class="kjt-range">' + (total ? '<b>' + from + '–' + to + '</b> of <b>' + total + '</b>' : 'No results') + '</span>' +
        (this._capped ? '<span class="kjt-capped" title="The merged result hit the server cap">' + ico('info') + 'Large result set — refine filters</span>' : '') +
        '<label class="kjt-per"><span>Rows</span><select class="kj-select" data-tkt-per aria-label="Rows per page">' +
          PER_PAGES.map(function (n) { return '<option value="' + n + '"' + (n === t.per ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label>' +
        '<span class="kj-spacer"></span>' +
        '<nav class="kjt-pager" aria-label="Pagination">' +
          '<button type="button" class="kjt-pg is-nav" data-tkt-page="' + (p - 1) + '"' + (p <= 1 ? ' disabled' : '') + ' aria-label="Previous page">' + ico('chevron-left') + '<span>Prev</span></button>' +
          nums +
          '<button type="button" class="kjt-pg is-nav" data-tkt-page="' + (p + 1) + '"' + (p >= pages ? ' disabled' : '') + ' aria-label="Next page"><span>Next</span>' + ico('chevron-right') + '</button>' +
        '</nav></div>';
    },
    paintTable: function () {
      var main = this._el && this._el.querySelector('[data-tk="main"]'); if (!main) return;
      var self = this, worker = this._worker !== false;
      var ncol = worker ? COLS.length : COLS.length - 1;
      var state, rows = [];
      if (this._tBusy || (this._rows == null && !this._tErr)) state = 'skel';
      else if (this._rows == null) { state = 'err'; rows = this.feedRows(); }
      else { state = this._rows.length ? 'rows' : 'empty'; rows = this._rows; }
      this._viewRows = rows;
      var sig = [state, worker, JSON.stringify(this._tbl), this._total, this._capped ? 'cap' : '', state === 'empty' || state === 'err' ? this.filtersActive() : '',
        rows.map(function (r) { return r.type + r.id + ':' + r.status + ':' + r.updated_at + ':' + r.priority + ':' + (r.assignee || '') + ':' + (r.sla ? r.sla.breached : '') + ':' + (r.comments || 0) + ':' + (r.attachments || 0); }).join('|')].join('#');
      if (sig === this._tSig) return;
      this._tSig = sig;

      var top = '';
      if (state === 'err') {
        top = emptyBox({ err: true, icon: 'cloud-off', title: 'The ticket table is not available right now',
          text: errMsg(this._tErr) + (rows.length ? ' — incident tickets from the live feed are listed below.' : ''), actions: actBtn('tretry', 'Retry', 'refresh-cw') });
      } else if (state === 'empty') {
        top = this.filtersActive()
          ? emptyBox({ icon: 'filter-x', title: 'Nothing matches these filters', text: 'Try another search, or clear the filters to see every ticket and incident.', actions: actBtn('clear', 'Clear filters', 'x') })
          : emptyBox({ icon: 'ticket-check', title: 'No tickets or incidents yet', text: worker
              ? 'Tickets raised by staff and incidents from the VisionAI pipeline appear here with live SLA timers.'
              : 'Need help with something? Raise a ticket and follow its progress here.', actions: actBtn('new', 'New Ticket', 'plus', 'kj-btn-primary') });
      }
      var body = state === 'skel' ? this.skelRowsHtml(ncol, Math.min(this._tbl.per, 8))
        : rows.map(function (r, i) { return self.rowHtml(r, i, worker); }).join('');
      var table = state === 'skel' || rows.length
        ? '<div class="kjt-wrap" data-tkt="wrap"><table class="kj-table kjt-table' + (worker ? '' : ' is-staff') + '"' + (state === 'skel' ? ' aria-busy="true"' : '') + '>' +
            '<caption class="kj-sr-only">Tickets and detection incidents</caption>' + this.theadHtml(worker) + '<tbody>' + body + '</tbody></table></div>'
        : '';
      var foot = state === 'rows' || (state === 'skel' && this._rows && this._rows.length) ? this.pagerHtml()
        : state === 'err' && rows.length ? '<div class="kjt-foot"><span class="kjt-range">' + rows.length + ' from the live feed</span></div>' : '';

      // keep the reader's place across background refreshes; page changes jump to the top
      var wrap = main.querySelector('[data-tkt="wrap"]');
      var sl = wrap ? wrap.scrollLeft : 0, st = wrap ? wrap.scrollTop : 0;
      if (this._tTop) { st = 0; if (state !== 'skel') this._tTop = false; }
      this.killLotties();
      main.innerHTML = '<div class="kj-card kjt-card' + (state === 'skel' ? ' is-loading' : '') + '" data-tkt="card">' + top + table + foot + '</div>';
      var nw = main.querySelector('[data-tkt="wrap"]');
      if (nw) { nw.scrollLeft = sl; nw.scrollTop = st; }
      main.querySelectorAll('[data-tk-lottie-play]').forEach(function (l) {
        self._lotties.push(playLottie(l, l.getAttribute('data-tk-lottie-play'), false));
      });
      requestAnimationFrame(function () { self.tick(); });
    },
    tickSla: function (c, r) {
      var v = slaView(r, this._tAt); if (!v) return;
      var cls = 'kjt-sla is-' + v.tone + (v.breached ? ' is-breached' : '');
      if (c.className !== cls) c.className = cls;
      var ring = c.querySelector('.kjt-ring');
      if (ring) {
        var rc = 'kj-tk-ring kjt-ring is-' + v.tone;
        if (ring.className !== rc) ring.className = rc;
        var bar = ring.querySelector('.kj-tk-ring-bar');
        if (bar) bar.style.strokeDashoffset = (RING_C * (1 - v.frac)).toFixed(2);
      }
      var tx = c.querySelector('.kjt-sla-txt'); if (tx && tx.textContent !== v.text) tx.textContent = v.text;
      if (c.getAttribute('title') !== v.title) c.setAttribute('title', v.title);
      var tr = c.closest('tr'); if (tr) tr.classList.toggle('is-breached', v.breached);
    },

    boardHtml: function (list) {
      var self = this, worker = !!this._worker;
      if (!(this._tickets || []).length) {
        return '<div class="kj-card kj-tk-empty-all"><span class="kj-tk-lottie kj-tk-lottie-lg" data-tk-lottie-empty>' + ico('ticket-check') + '</span>' +
          '<div class="kj-empty-title">No tickets yet</div><div class="kj-empty-text">' + (worker
            ? 'Tickets raised by the VisionAI pipeline and by staff appear here with live SLA timers.'
            : 'Need help with something? Raise a ticket and follow its progress here.') + '</div>' +
          '<div class="kj-row-wrap kj-tk-center"><button type="button" class="kj-btn kj-btn-primary" data-tk-act="new">' + ico('plus') + '<span>New Ticket</span></button>' +
          '<button type="button" class="kj-btn kj-btn-secondary" data-kj-nav="detections">' + ico('scan-eye') + '<span>Detections log</span></button></div></div>';
      }
      return '<div class="kj-tk-board" role="list">' + STATUSES.map(function (s) {
        var items = list.filter(function (t) { return t.status === s; });
        var shown = s === 'closed' ? items.slice(0, 25) : items;
        return '<section class="kj-tk-col is-' + s + '" data-tk-col="' + s + '" role="listitem" aria-label="' + esc(ST[s].label) + '">' +
          '<header class="kj-tk-col-head"><span class="kj-tk-col-dot"></span><span class="kj-tk-col-title">' + esc(ST[s].label) + '</span>' +
            '<span class="kj-badge kj-tk-col-count">' + items.length + '</span><span class="kj-spacer"></span>' +
            (s === 'new' ? '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon kj-btn-sm" data-tk-act="new" aria-label="New ticket" title="New ticket">' + ico('plus') + '</button>' : '') +
          '</header>' +
          '<div class="kj-tk-col-body">' + (shown.length ? shown.map(function (t) { return self.cardHtml(t, worker); }).join('') +
            (items.length > shown.length ? '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm kj-btn-block" data-tk-view="table">' + ico('table') + '<span>' + (items.length - shown.length) + ' more in table view</span></button>' : '')
            : '<div class="kj-tk-col-empty">' + ico(s === 'new' ? 'inbox' : ST[s].icon) + '<span>' + (worker && s !== 'new' && s !== 'closed' ? 'Drop a ticket here' : 'Nothing here') + '</span></div>') +
          '</div></section>';
      }).join('') + '</div>';
    },
    cardHtml: function (t, worker) {
      var ex = this._enrich[t.id] || {};
      var canDrag = worker && (TRANSITIONS[t.status] || []).length > 0;
      var where = [t.camera, t.location].filter(Boolean).join(' · ') || CATS[t.category] || '';
      return '<article class="kj-tk-card is-p-' + esc(t.priority) + (canDrag ? ' is-draggable' : '') + '" data-tk-card="' + t.id + '" data-kj-modal="' + esc(spec('ticket', t.id)) + '"' +
          (canDrag ? ' draggable="true"' : '') + ' aria-label="' + esc(t.ticket_no + ' ' + t.title) + '">' +
        '<div class="kj-tk-card-top"><span class="kj-tk-no">' + esc(t.ticket_no || ('#' + t.id)) + '</span>' +
          (t.source === 'ai_pipeline' ? '<span class="kj-tk-ai" title="Raised by the VisionAI pipeline">' + ico('sparkles') + '</span>' : '') +
          '<span class="kj-spacer"></span><time class="kj-tk-date">' + esc(fmtStamp(t.created_at)) + '</time></div>' +
        '<h3 class="kj-tk-title">' + esc(t.title) + '</h3>' +
        '<div class="kj-tk-meta">' + prioChip(t.priority) + '<span class="kj-tk-where kj-truncate">' + esc(where) + '</span></div>' +
        '<div class="kj-tk-card-mid"><span class="kj-tk-assignee kj-truncate">' + avatar(t.assignee || '?', null, 'kj-tk-av' + (t.assignee ? '' : ' is-empty')) +
          '<span class="kj-truncate">' + esc(t.assignee || 'Unassigned') + '</span></span>' + ringHtml(t.id, 'card', 'sm') + '</div>' +
        '<div class="kj-tk-card-foot"><span class="kj-tk-thumb" data-tk-thumb="' + t.id + '">' + this.thumbHtml(ex) + '</span>' +
          '<span class="kj-tk-counts" data-tk-counts="' + t.id + '">' + this.countsHtml(ex) + '</span></div>' +
      '</article>';
    },
    thumbHtml: function (ex) {
      if (ex && ex.proof) return '<img src="' + esc(ex.proof) + '" alt="Proof image" loading="lazy">';
      if (ex && ex.v) return '';
      return '<span class="kj-skel kj-tk-thumb-skel"></span>';
    },
    countsHtml: function (ex) {
      var c = ex && ex.comments != null ? ex.comments : '·', f = ex && ex.files != null ? ex.files : '·';
      return '<span title="Comments">' + ico('message-square') + c + '</span><span title="Attachments">' + ico('paperclip') + f + '</span>';
    },
    paintCardExtras: function (id) {
      if (!this._el) return;
      var ex = this._enrich[id];
      var th = this._el.querySelector('[data-tk-thumb="' + id + '"]'); if (th) th.innerHTML = this.thumbHtml(ex);
      var ct = this._el.querySelector('[data-tk-counts="' + id + '"]'); if (ct) ct.innerHTML = this.countsHtml(ex);
    },
    /** Live SLA ticking (1 s) — updates board rings / table SLA cells in place, never repaints. */
    tick: function () {
      if (!this._el) return;
      var self = this;
      if (this._view === 'board') {
        this._el.querySelectorAll('[data-tk-ring]').forEach(function (r) {
          var t = self.byId(r.getAttribute('data-tk-ring'));
          tickRing(r, t ? cardClock(t) : null, false);
        });
      } else {
        var rows = this._viewRows || [];
        this._el.querySelectorAll('[data-tkt-sla]').forEach(function (c) { self.tickSla(c, rows[Number(c.getAttribute('data-tkt-sla'))]); });
      }
      var s = Math.floor(Date.now() / 1000);
      if (s % 30 === 0) this.paintKpis();
    },

    /* ── actions ── */
    moveTo: function (t, to) {
      var self = this;
      if (!t || t.status === to) return Promise.resolve(null);
      var steps = pathTo(t.status, to);
      if (!steps) { toast('A ' + ST[t.status].label + ' ticket cannot move to ' + (ST[to] ? ST[to].label : to) + '.', 'warn'); return Promise.resolve(null); }
      var go = function (remarks, code) {
        var card = self._el && self._el.querySelector('[data-tk-card="' + t.id + '"]');
        var col = self._el && self._el.querySelector('[data-tk-col="' + to + '"] .kj-tk-col-body');
        if (card && col) { card.classList.add('is-pending'); col.insertBefore(card, col.firstChild); }
        return runPath(t, steps, remarks, code).then(function (nt) {
          toast(t.ticket_no + ' → ' + ST[to].label, 'success');
          self.upsert(nt);
          return nt;
        }).catch(function (e) {
          toast(errMsg(e), 'danger');
          self._sig = ''; self._fetchedAt = 0; self.load(true);
          throw e;
        });
      };
      if (steps.indexOf('resolved') >= 0) {
        return new Promise(function (res) {
          window.KJModal.open('ticket-resolve', t.id, {
            ticket: t, steps: steps, to: to,
            submit: function (remarks, code) { return go(remarks, code).then(res, function (e) { res(null); throw e; }); },
            cancel: function () { res(null); }
          });
        });
      }
      return go().catch(function () { return null; });
    },
    openNew: function () {
      var self = this;
      window.KJModal.open('ticket-new', 'new', { worker: !!this._worker, onCreated: function (t) { self.changed(t); } });
    },
    /** Called by the detail modal after any change: sync the board + refresh the table page now. */
    changed: function (t) {
      if (t && this._tickets) this.upsert(t);          // upsert() also refreshes the table
      else if (this._el) this.loadTable(true);
    }
  };
  function KJPagesEmpty(o) { return window.KJPages.h.emptyState(o); }
  /** The registered (copied) module object — KJPages.register clones the def, so state lives there. */
  function page() { return (window.KJPages.get && window.KJPages.get('tickets')) || M; }

  /* ======================================================================
   * KJModal types — registered once KJModal exists (kj-modal.js is deferred,
   * this file is a blocking script, so registration waits for it).
   * ==================================================================== */
  function registerModals() {
    var K = window.KJModal;
    if (!K || registerModals.done) return !!registerModals.done;
    registerModals.done = true;
    ensureCss();

    /* ── 'ticket' — full ITSM detail (overrides kj-modal.js) ── */
    K.register('ticket', {
      kicker: 'Ticket', icon: 'ticket', size: 'lg', skeleton: 'media',
      load: function (ctx) {
        if (ctx._fresh) { var f = ctx._fresh; ctx._fresh = null; return Promise.resolve({ t: f, assignees: ctx._assignees || null }); }
        var id = String(ctx.id);
        return get('/tickets/' + encodeURIComponent(id)).then(function (r) {
          var t = r.ticket; t._at = Date.now();
          var worker = 'detection_count' in t;
          if (!worker || ctx._assignees !== undefined) return { t: t, assignees: ctx._assignees || null };
          return get('/tickets/assignees').then(function (a) { ctx._assignees = a.users || []; }, function () { ctx._assignees = null; })
            .then(function () { return { t: t, assignees: ctx._assignees }; });
        }, function (e) {
          // Not an ITSM ticket: fall back to the legacy incident-ticket (live feed event).
          var a = window.KJApp, ev = ((a && a.state && a.state.events) || []).filter(function (x) { return String(x.id) === id || String(x.ticket || '') === id; })[0];
          // Datatable INC rows seed the incident, so ones older than the live-feed window still open.
          if (!ev && ctx.data && ctx.data.incident) ev = ctx.data.incident;
          if (ev) return { legacy: ev };
          throw e;
        });
      },
      render: function (ctx, d) {
        if (d.legacy) return renderLegacy(ctx, d.legacy);
        return renderDetail(ctx, d.t, d.assignees);
      }
    });

    /* ── 'ticket-new' — manual ticket ── */
    K.register('ticket-new', {
      kicker: 'New ticket', icon: 'ticket-plus', size: 'md', deepLink: false,
      render: function (ctx) {
        var worker = !!(ctx.data && ctx.data.worker) || (page()._worker === true);
        return {
          title: 'Raise a ticket', icon: 'ticket-plus',
          body: '<form class="kj-stack kj-tk-form" data-tk-form novalidate>' +
            '<div class="kj-field"><label class="kj-label" for="tkn-title">Title <span class="kj-tk-req">*</span></label>' +
              '<input id="tkn-title" class="kj-input" name="title" maxlength="200" required placeholder="e.g. Pallet blocking emergency exit — Bay 3"></div>' +
            '<div class="kj-grid-2">' +
              '<div class="kj-field"><label class="kj-label" for="tkn-prio">Priority</label><select id="tkn-prio" class="kj-select" name="priority">' +
                PRIOS.map(function (p) { return '<option value="' + p + '"' + (p === 'medium' ? ' selected' : '') + (p === 'critical' && !worker ? ' disabled' : '') + '>' + PRIO[p].label + (p === 'critical' && !worker ? ' (supervisors only)' : '') + '</option>'; }).join('') +
              '</select>' + (worker ? '' : '<div class="kj-help">Critical priority is set by a supervisor after review.</div>') + '</div>' +
              '<div class="kj-field"><label class="kj-label" for="tkn-cat">Type</label><select id="tkn-cat" class="kj-select" name="category">' +
                Object.keys(CATS).filter(function (c) { return c !== 'ppe_forklift'; }).map(function (c) { return '<option value="' + c + '">' + CATS[c] + '</option>'; }).join('') +
              '</select></div></div>' +
            '<div class="kj-field"><label class="kj-label" for="tkn-loc">Location</label><input id="tkn-loc" class="kj-input" name="location" maxlength="120" placeholder="Line, bay or area"></div>' +
            '<div class="kj-field"><label class="kj-label" for="tkn-desc">Description</label><textarea id="tkn-desc" class="kj-textarea" name="description" rows="5" maxlength="8000" placeholder="What happened, who is affected, anything already done…"></textarea></div>' +
            '<div class="kj-help kj-tk-slahint" data-tk-slahint></div>' +
          '</form>',
          foot: '<button type="button" class="kj-btn kj-btn-ghost" data-kj-close>Cancel</button>' +
            '<button type="button" class="kj-btn kj-btn-primary" data-kj-action="create">' + ico('send') + 'Create ticket</button>',
          actions: {
            create: function (c, btn) {
              var form = c.body.querySelector('[data-tk-form]');
              var title = form.elements.namedItem('title').value.trim();
              var fld = form.elements.namedItem('title').closest('.kj-field');
              if (!title) { fld.classList.add('is-error'); form.elements.namedItem('title').focus(); return; }
              fld.classList.remove('is-error');
              btn.disabled = true;
              post('/tickets', { title: title, priority: form.elements.namedItem('priority').value, category: form.elements.namedItem('category').value,
                location: form.elements.namedItem('location').value.trim(), description: form.elements.namedItem('description').value.trim() }).then(function (r) {
                var t = r.ticket;
                toast('Ticket ' + t.ticket_no + ' created', 'success');
                if (c.data && typeof c.data.onCreated === 'function') c.data.onCreated(t); else page().changed(t);
                c.close();
                setTimeout(function () { window.KJModal.open('ticket', t.id); }, 240);
              }).catch(function (e) { btn.disabled = false; toast(errMsg(e), 'danger'); });
            }
          },
          mount: function (c) {
            var form = c.body.querySelector('[data-tk-form]'), hint = c.body.querySelector('[data-tk-slahint]');
            form.addEventListener('submit', function (ev) { ev.preventDefault(); c.actions.create(c, c.foot.querySelector('[data-kj-action="create"]')); });
            var sla = null;
            var show = function () {
              var p = sla && sla[form.elements.namedItem('priority').value];
              hint.innerHTML = p ? ico('timer') + ' SLA: first response within <b>' + fmtLeft(p.response * 60, true) + '</b>, resolution within <b>' + fmtLeft(p.resolution * 60, true) + '</b>.' : '';
            };
            form.elements.namedItem('priority').addEventListener('change', show);
            get('/tickets/sla').then(function (r) { sla = r.policy; show(); }).catch(function () { /* hint stays empty */ });
            setTimeout(function () { form.elements.namedItem('title').focus(); }, 60);
          }
        };
      }
    });

    /* ── 'ticket-resolve' — closing remarks (drag to Resolved/Closed) ── */
    K.register('ticket-resolve', {
      kicker: 'Resolve ticket', icon: 'circle-check', size: 'sm', deepLink: false,
      render: function (ctx) {
        var d = ctx.data || {}, t = d.ticket || {};
        var done = false;
        var finish = function () { if (!done) { done = true; if (d.cancel) d.cancel(); } };
        return {
          title: 'Resolve ' + (t.ticket_no || ''), icon: 'circle-check', tone: 'success',
          body: '<div class="kj-stack"><div class="kj-tk-resolve-tk"><b>' + esc(t.title || '') + '</b>' +
              '<span class="kj-muted">' + esc(d.steps ? d.steps.map(function (s) { return ST[s].label; }).join(' → ') : '') + '</span></div>' +
            resolveFields('tkr') + '</div>',
          foot: '<button type="button" class="kj-btn kj-btn-ghost" data-kj-close>Cancel</button>' +
            '<button type="button" class="kj-btn kj-btn-primary" data-kj-action="ok">' + ico('check') + (d.to === 'closed' ? 'Resolve &amp; close' : 'Resolve ticket') + '</button>',
          actions: {
            ok: function (c, btn) {
              var v = readResolve(c.body, 'tkr'); if (!v) return;
              btn.disabled = true; done = true;
              d.submit(v.remarks, v.code).then(function () { c.close(); }, function () { btn.disabled = false; done = false; });
            }
          },
          mount: function (c) {
            // Closing without submitting reverts the drag.
            var obs = new MutationObserver(function () { if (!document.contains(c.el)) { obs.disconnect(); finish(); } });
            obs.observe(document.body, { childList: true });
            setTimeout(function () { var ta = c.body.querySelector('textarea'); if (ta) ta.focus(); }, 60);
          }
        };
      }
    });
    return true;
  }

  function resolveFields(pfx) {
    return '<div class="kj-field"><label class="kj-label" for="' + pfx + '-rem">Closing remarks <span class="kj-tk-req">*</span></label>' +
      '<textarea id="' + pfx + '-rem" class="kj-textarea" data-tk-remarks rows="4" maxlength="4000" placeholder="Describe the corrective action and final outcome…"></textarea>' +
      '<div class="kj-help">Required — at least 5 characters. Shared with the requester.</div></div>' +
      '<div class="kj-field"><label class="kj-label" for="' + pfx + '-code">Resolution</label><select id="' + pfx + '-code" class="kj-select" data-tk-code>' +
      RES_CODES.map(function (r) { return '<option value="' + r[0] + '">' + esc(r[1]) + '</option>'; }).join('') + '</select></div>';
  }
  function readResolve(root, pfx) {
    var ta = root.querySelector('[data-tk-remarks]'), code = root.querySelector('[data-tk-code]');
    var v = ta ? ta.value.trim() : '';
    var fld = ta && ta.closest('.kj-field');
    if (v.length < 5) { if (fld) fld.classList.add('is-error'); if (ta) ta.focus(); toast('Closing remarks are required (at least 5 characters).', 'warn'); return null; }
    if (fld) fld.classList.remove('is-error');
    return { remarks: v, code: code ? code.value : 'fixed' };
  }

  /* ── detail renderer ───────────────────────────────────── */
  function renderDetail(ctx, t, assignees) {
    var H = window.KJModal.h;
    var worker = 'detection_count' in t;
    var allowed = t.allowed_transitions || [];
    var closed = t.status === 'closed';
    var meta = t.meta || {};
    var att = t.attachments || [];
    var proofs = att.filter(function (a) { return a.kind === 'proof'; });
    var byMsg = {};
    att.forEach(function (a) { if (a.message_id) (byMsg[a.message_id] = byMsg[a.message_id] || []).push(a); });
    var loose = att.filter(function (a) { return a.kind === 'file' && !a.message_id; });
    var msgs = t.messages || [];
    var nComments = msgs.filter(function (m) { return m.kind === 'comment' && !m.internal; }).length;
    var nNotes = msgs.filter(function (m) { return m.internal; }).length;

    // ── header ──
    var head = '<div class="kj-tk-dhead">' +
      '<div class="kj-row-wrap kj-tk-dhead-chips"><span class="kj-tk-no is-lg">' + ico('ticket') + esc(t.ticket_no) + '</span>' +
        prioChip(t.priority) + statusChip(t.status) +
        (t.source === 'ai_pipeline' ? chip('VisionAI', 'purple', 'kj-tk-chip-ai') : chip('Manual', '')) + '</div>' +
      '<div class="kj-tk-dmeta">' +
        '<span>' + ico('tag') + esc(CATS[t.category] || t.category) + '</span>' +
        (t.location ? '<span>' + ico('map-pin') + esc(t.location) + '</span>' : '') +
        '<span>' + ico('user-round-pen') + 'Raised by ' + esc(t.requester || '—') + ' · ' + esc(fmtStamp(t.created_at)) + '</span>' +
        (!worker ? '<span>' + ico('user-round') + (t.assignee ? 'Assigned to ' + esc(t.assignee) : 'Not yet assigned') + '</span>' : '') +
      '</div></div>';

    // ── worker controls: assignee + priority ──
    var controls = '';
    if (worker && !closed) {
      var opts = '<option value="0">Unassigned</option>' + (assignees || []).map(function (a) {
        return '<option value="' + a.id + '"' + (a.id === t.assignee_user_id ? ' selected' : '') + '>' + esc(a.name) + ' · ' + esc(a.role) + '</option>';
      }).join('');
      if (t.assignee_user_id && !(assignees || []).some(function (a) { return a.id === t.assignee_user_id; })) {
        opts += '<option value="' + t.assignee_user_id + '" selected>' + esc(t.assignee) + '</option>';
      }
      controls = '<div class="kj-card kj-tk-ctrls">' +
        '<div class="kj-field"><label class="kj-label" for="tkd-asg">' + ico('user-round-check') + ' Assignee</label>' +
          (assignees ? '<div class="kj-tk-asg">' + avatar(t.assignee || '?', null, 'kj-tk-av' + (t.assignee ? '' : ' is-empty')) +
            '<select id="tkd-asg" class="kj-select" data-tkd="assignee">' + opts + '</select></div>'
            : '<div class="kj-tk-asg">' + avatar(t.assignee || '?', null, 'kj-tk-av') + '<span>' + esc(t.assignee || 'Unassigned') + '</span></div>') + '</div>' +
        '<div class="kj-field"><label class="kj-label" for="tkd-prio">' + ico('flag') + ' Priority</label><select id="tkd-prio" class="kj-select" data-tkd="priority">' +
          PRIOS.map(function (p) { return '<option value="' + p + '"' + (p === t.priority ? ' selected' : '') + '>' + PRIO[p].label + '</option>'; }).join('') + '</select>' +
          '<div class="kj-help">Changing priority recalculates both SLA deadlines.</div></div>' +
      '</div>';
    }

    // ── SLA panel ──
    var slaBox = '<div class="kj-card kj-tk-sla"><div class="kj-card-head"><div class="kj-card-title">' + ico('timer') + ' SLA overview</div>' +
      (t.sla && t.sla.policy_min ? '<span class="kj-muted kj-tk-pol">' + esc(PRIO[t.priority] ? PRIO[t.priority].label : t.priority) + ' policy · ' +
        fmtLeft(t.sla.policy_min.response * 60, true) + ' / ' + fmtLeft(t.sla.policy_min.resolution * 60, true) + '</span>' : '') + '</div>' +
      '<div class="kj-tk-sla-grid">' + slaCell(t, 'response', 'Response SLA') + slaCell(t, 'resolution', 'Resolution SLA') + '</div></div>';

    // ── detection evidence (workers only; staff never see camera/proof) ──
    var evidence = '';
    if (worker && (t.camera || proofs.length || t.event_first_at || t.event_id)) {
      var img = proofs[0];
      var tag = (meta.missing_ppe && meta.missing_ppe.length ? 'Missing ' + meta.missing_ppe.join(' + ') : '') +
        (meta.confidence != null ? (meta.missing_ppe && meta.missing_ppe.length ? ' · ' : '') + Math.round(Number(meta.confidence) * 100) + '%' : '');
      var media = img
        ? '<div class="kj-tk-proof" data-kj-modal="' + esc(spec('image', img.url)) + '" data-kj-seed=\'' + esc(JSON.stringify({ label: t.ticket_no + ' proof' })) + '\'>' +
            '<img src="' + esc(img.url) + '" alt="Detection proof" loading="lazy">' +
            (t.camera ? '<span class="kj-tk-proof-tag is-tl">' + esc(t.camera + (t.location ? ' · ' + t.location : '')) + '</span>' : '') +
            '<span class="kj-tk-proof-tag is-tr">' + esc(fmtHM(t.event_last_at || img.created_at)) + '</span>' +
            (tag ? '<span class="kj-tk-proof-tag is-bl is-warn">' + ico('hard-hat') + esc(tag) + '</span>' : '') +
            '<span class="kj-tk-proof-zoom">' + ico('maximize-2') + '</span></div>'
        : '<div class="kj-tk-proof is-empty">' + ico('image-off') + '<span>No proof image attached</span></div>';
      var more = proofs.length > 1 ? '<div class="kj-tk-proofs">' + proofs.slice(1, 7).map(function (p) {
        return '<button type="button" class="kj-tk-proofs-item" data-kj-modal="' + esc(spec('image', p.url)) + '"><img src="' + esc(p.url) + '" alt="Proof" loading="lazy"></button>';
      }).join('') + '</div>' : '';
      var tl = '<ol class="kj-tk-evtl">' +
        (t.event_first_at ? '<li><span class="kj-tk-evtl-t">' + esc(fmtHM(t.event_first_at)) + '</span><span>First detection</span></li>' : '') +
        (t.event_last_at ? '<li><span class="kj-tk-evtl-t">' + esc(fmtHM(t.event_last_at)) + '</span><span>Last detection</span></li>' : '') +
        '</ol>';
      evidence = '<div class="kj-card kj-tk-evidence"><div class="kj-card-head"><div class="kj-card-title">' + ico('cctv') + ' Detection evidence</div>' +
          (t.camera ? '<button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kj-modal="' + esc(spec('camera', t.camera)) + '">' + ico('video') + 'Live camera</button>' : '') + '</div>' +
        media + more +
        '<div class="kj-tk-evrow"><div><div class="kj-section-title">' + ico('git-commit-vertical') + ' Event timeline</div>' + tl + '</div>' +
          H.kv([
            ['Camera', t.camera ? H.link('camera', t.camera, t.camera) : '—', true],
            ['Duration', fmtDur(t.event_duration_s)],
            ['Detections', t.detection_count != null ? String(t.detection_count) : '—'],
            meta.event_uuid ? ['Event', H.link('event', meta.event_uuid, 'Open detection'), true] : null,
            meta.model ? ['Reviewed by', 'VisionAI engine'] : null
          ]) + '</div></div>';
    }

    // ── person card ──
    var person = '';
    if (worker && t.person_id) {
      var pr = profileOf(t.person_id) || {};
      var pname = pr.name || meta.person_name || ('Person #' + t.person_id);
      person = '<button type="button" class="kj-card kj-tk-person" data-kj-modal="' + esc(spec('person', t.person_id)) + '"' +
          ' data-kj-seed=\'' + esc(JSON.stringify({ name: pname })) + '\'>' +
        avatar(pname, pr.photo || null, 'kj-avatar-lg') +
        '<span class="kj-tk-person-main"><b>' + esc(pname) + '</b><span class="kj-muted">' + esc([pr.department, pr.staffId ? 'Staff ' + pr.staffId : null].filter(Boolean).join(' · ') || 'Detected person') + '</span>' +
        '<span class="kj-tk-person-link">' + ico('id-card') + 'View profile, attendance &amp; movement</span></span>' + ico('chevron-right') + '</button>';
    }

    var desc = t.description ? '<div class="kj-card kj-tk-desc"><div class="kj-card-title">' + ico('align-left') + ' Description</div><p>' + esc(t.description).replace(/\n/g, '<br>') + '</p></div>' : '';

    // ── communication ──
    var thread = msgs.length ? msgs.map(function (m) { return msgHtml(m, byMsg[m.id] || []); }).join('')
      : '<div class="kj-tk-thread-empty">' + ico('messages-square') + '<span>No messages yet — start the conversation below.</span></div>';
    var comm = '<div class="kj-card kj-tk-comm"><div class="kj-card-head"><div class="kj-card-title">' + ico('messages-square') + ' Communication ' +
        '<span class="kj-badge">' + msgs.length + ' update' + (msgs.length === 1 ? '' : 's') + '</span></div></div>' +
      '<div class="kj-tabs kj-tk-ttabs" role="tablist">' +
        '<button type="button" class="kj-tab is-active" role="tab" aria-selected="true" data-tkd-tab="all">All activity</button>' +
        '<button type="button" class="kj-tab" role="tab" aria-selected="false" data-tkd-tab="msg">Messages <span class="kj-tk-tabn">' + nComments + '</span></button>' +
        (worker ? '<button type="button" class="kj-tab" role="tab" aria-selected="false" data-tkd-tab="note">Internal notes <span class="kj-tk-tabn">' + nNotes + '</span></button>' : '') +
      '</div>' +
      '<div class="kj-tk-thread" data-tkd="thread" data-show="all">' + thread + '</div>' +
      (loose.length ? '<div class="kj-tk-files"><div class="kj-section-title">' + ico('paperclip') + ' Attachments</div><div class="kj-row-wrap">' + loose.map(fileChip).join('') + '</div></div>' : '') +
      (closed ? '<div class="kj-tk-closednote">' + ico('lock') + '<span>This ticket is closed — the thread is read-only.</span></div>' :
        '<div class="kj-tk-composer" data-tkd="composer" data-mode="reply">' +
          '<div class="kj-tabs kj-tk-cmode" role="tablist">' +
            '<button type="button" class="kj-tab is-active" data-tkd-mode="reply">' + ico('reply') + 'Reply</button>' +
            (worker ? '<button type="button" class="kj-tab" data-tkd-mode="note">' + ico('notebook-pen') + 'Internal note</button>' : '') + '</div>' +
          '<textarea class="kj-textarea" data-tkd="body" rows="3" maxlength="8000" placeholder="Write a reply…" aria-label="Message"></textarea>' +
          '<div class="kj-tk-pending" data-tkd="pending"></div>' +
          '<div class="kj-row kj-tk-composer-foot"><label class="kj-btn kj-btn-secondary kj-btn-sm kj-tk-attach">' + ico('paperclip') + '<span>Attach</span>' +
            '<input type="file" multiple data-tkd="files" class="kj-sr-only" accept="image/*,.pdf,.txt,.csv,.docx,.xlsx,.zip"></label>' +
            '<span class="kj-help kj-tk-note-hint">' + ico('lock') + 'Only supervisors and admins see internal notes.</span>' +
            '<span class="kj-spacer"></span>' +
            '<button type="button" class="kj-btn kj-btn-primary kj-btn-sm" data-kj-action="send">' + ico('send') + '<span data-tkd="sendlbl">Send reply</span></button></div>' +
        '</div>') +
      '</div>';

    // ── workflow / resolve ──
    var flow = workflowHtml(t, allowed, worker);

    var body = head + '<div class="kj-tk-dgrid"><div class="kj-tk-dcol">' + slaBox + evidence + person + controls + desc + '</div>' +
      '<div class="kj-tk-dcol">' + comm + flow + '</div></div>';

    var pr0 = PRIO[t.priority] || {};
    return {
      title: t.title, kicker: 'Ticket ' + t.ticket_no, icon: 'ticket', tone: pr0.tone === 'primary' ? '' : pr0.tone,
      body: body,
      foot: '<button type="button" class="kj-btn kj-btn-ghost" data-kj-action="copy">' + ico('link') + 'Copy link</button><span class="kj-spacer"></span>' +
        '<button type="button" class="kj-btn kj-btn-secondary" data-kj-close>Close</button>',
      actions: {
        copy: function () {
          var link = location.origin + location.pathname + '#tickets&modal=ticket:' + t.id;
          try { navigator.clipboard.writeText(link).then(function () { toast('Link copied', 'success'); }, function () { toast(link); }); } catch (e) { toast(link); }
        },
        send: function (c, btn) { sendMessage(c, t, btn); },
        ack: function (c, btn) { doStatus(c, t, 'ack', btn); },
        start: function (c, btn) { doStatus(c, t, 'in_progress', btn); },
        reopen: function (c, btn) { doStatus(c, t, 'in_progress', btn); },
        close: function (c, btn) { doStatus(c, t, 'closed', btn); },
        resolve: function (c, btn) {
          var v = readResolve(c.body, 'tkd'); if (!v) return;
          doStatus(c, t, 'resolved', btn, v.remarks, v.code);
        }
      },
      mount: function (c) {
        c.modal.classList.add('kj-tk-modal');
        // live SLA rings
        var tickAll = function () {
          c.body.querySelectorAll('[data-tkd-ring]').forEach(function (r) { tickRing(r, slaClock(t, r.getAttribute('data-tkd-ring')), true); });
        };
        requestAnimationFrame(tickAll);
        if (c._iv) clearInterval(c._iv);
        c._iv = setInterval(function () { if (!document.contains(c.el)) { clearInterval(c._iv); return; } tickAll(); }, 1000);
        // thread tabs
        var thr = c.body.querySelector('[data-tkd="thread"]');
        c.body.querySelectorAll('[data-tkd-tab]').forEach(function (b) {
          b.addEventListener('click', function () {
            c.body.querySelectorAll('[data-tkd-tab]').forEach(function (x) { x.classList.toggle('is-active', x === b); x.setAttribute('aria-selected', x === b ? 'true' : 'false'); });
            thr.setAttribute('data-show', b.getAttribute('data-tkd-tab'));
          });
        });
        if (thr) thr.scrollTop = thr.scrollHeight;
        // composer
        var comp = c.body.querySelector('[data-tkd="composer"]');
        if (comp) {
          c._files = [];
          comp.querySelectorAll('[data-tkd-mode]').forEach(function (b) {
            b.addEventListener('click', function () {
              var mode = b.getAttribute('data-tkd-mode');
              comp.setAttribute('data-mode', mode);
              comp.querySelectorAll('[data-tkd-mode]').forEach(function (x) { x.classList.toggle('is-active', x === b); });
              comp.querySelector('[data-tkd="body"]').setAttribute('placeholder', mode === 'note' ? 'Write an internal note (not visible to the requester)…' : 'Write a reply…');
              comp.querySelector('[data-tkd="sendlbl"]').textContent = mode === 'note' ? 'Add note' : 'Send reply';
            });
          });
          var inp = comp.querySelector('[data-tkd="files"]'), pend = comp.querySelector('[data-tkd="pending"]');
          var showPending = function () {
            pend.innerHTML = c._files.map(function (f, i) {
              return '<span class="kj-chip kj-tk-pchip">' + ico(/^image\//.test(f.type) ? 'image' : 'file') + esc(f.name) + ' <small>' + bytes(f.size) + '</small>' +
                '<button type="button" class="kj-tk-pchip-x" data-tkd-unfile="' + i + '" aria-label="Remove ' + esc(f.name) + '">' + ico('x') + '</button></span>';
            }).join('');
          };
          inp.addEventListener('change', function () {
            Array.prototype.forEach.call(inp.files || [], function (f) {
              if (f.size > 10 * 1024 * 1024) toast(f.name + ' is larger than 10 MB', 'warn'); else c._files.push(f);
            });
            inp.value = ''; showPending();
          });
          pend.addEventListener('click', function (ev) {
            var x = ev.target instanceof Element && ev.target.closest('[data-tkd-unfile]'); if (!x) return;
            c._files.splice(Number(x.getAttribute('data-tkd-unfile')), 1); showPending();
          });
          comp.querySelector('[data-tkd="body"]').addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); sendMessage(c, t, comp.querySelector('[data-kj-action="send"]')); }
          });
        }
        // worker edits
        var asg = c.body.querySelector('[data-tkd="assignee"]');
        if (asg) asg.addEventListener('change', function () { doUpdate(c, t, { assignee_user_id: Number(asg.value) || 0 }, asg); });
        var pri = c.body.querySelector('[data-tkd="priority"]');
        if (pri) pri.addEventListener('change', function () { doUpdate(c, t, { priority: pri.value }, pri); });
      }
    };
  }

  function slaCell(t, which, label) {
    var s = t.sla && t.sla[which];
    var sub = '';
    if (s) {
      if (s.state === 'met') {
        var took = (toMs(s.met_at) || 0) - (toMs(t.created_at) || 0);
        sub = (which === 'response' ? 'Responded in ' : 'Resolved in ') + fmtDur(took / 1000);
      } else if (s.state === 'breached') {
        sub = s.met_at ? 'Met late at ' + fmtStamp(s.met_at) : 'Was due ' + fmtStamp(s.due_at);
      } else sub = 'Due ' + fmtStamp(s.due_at);
    }
    var state = s ? (s.state === 'met' ? 'Met' : s.state === 'breached' ? 'Breached' : 'Remaining') : '—';
    return '<div class="kj-tk-sla-cell is-' + esc(s ? s.state : 'none') + '">' +
      '<span class="kj-tk-ring kj-tk-ring-lg" data-tkd-ring="' + which + '">' + ringSvg() +
        '<span class="kj-tk-ring-txt"><b></b><small></small></span>' +
        (s && s.state === 'met' ? '<span class="kj-tk-ring-ico">' + ico('check') + '</span>' : '') + '</span>' +
      '<div class="kj-tk-sla-txt"><span class="kj-tk-sla-lbl">' + esc(label) + '</span>' +
        '<span class="kj-tk-sla-state">' + esc(state) + '</span><span class="kj-muted">' + esc(sub) + '</span></div></div>';
  }

  function fileChip(a) {
    var img = /^image\//.test(a.mime || '');
    var inner = ico(img ? 'image' : (/pdf/.test(a.mime || '') ? 'file-text' : 'file')) + '<span class="kj-truncate">' + esc(a.filename) + '</span><small>' + bytes(a.size) + '</small>';
    return img
      ? '<button type="button" class="kj-tk-file" data-kj-modal="' + esc(spec('image', a.url)) + '" data-kj-seed=\'' + esc(JSON.stringify({ label: a.filename })) + '\'>' + inner + '</button>'
      : '<a class="kj-tk-file" href="' + esc(a.url) + '" target="_blank" rel="noopener noreferrer">' + inner + '</a>';
  }

  function msgHtml(m, files) {
    var sys = m.kind !== 'comment';
    var k = m.internal ? 'note' : (sys ? 'sys' : 'msg');
    var who = m.kind === 'ai' || (sys && m.author === 'VisionAI') ? 'VisionAI System' : (m.author || 'System');
    var body = '';
    if (m.kind === 'status') {
      body = '<div class="kj-tk-msg-status">' + ico('arrow-right-left') + 'Moved ' + (m.from_status ? statusChip(m.from_status) + ' → ' : 'to ') + statusChip(m.to_status) + '</div>' +
        (m.body ? '<div class="kj-tk-msg-body' + (m.to_status === 'resolved' ? ' is-remarks' : '') + '">' + (m.to_status === 'resolved' ? '<b>Closing remarks</b>' : '') + esc(m.body).replace(/\n/g, '<br>') + '</div>' : '');
    } else {
      body = '<div class="kj-tk-msg-body">' + (m.internal ? '<b class="kj-tk-msg-notehd">' + ico('lock') + 'Internal note</b>' : '') + esc(m.body || '').replace(/\n/g, '<br>') + '</div>';
    }
    var av = (m.kind === 'ai' || who === 'VisionAI System') ? '<span class="kj-avatar kj-tk-bot">' + ico('bot') + '</span>'
      : sys && m.kind === 'system' ? '<span class="kj-avatar kj-tk-sysav">' + ico('info') + '</span>' : avatar(who, null, '');
    return '<div class="kj-tk-msg is-' + esc(m.kind) + (m.internal ? ' is-internal' : '') + '" data-k="' + k + '">' + av +
      '<div class="kj-tk-msg-main"><div class="kj-tk-msg-head"><b>' + esc(who) + '</b><time title="' + esc(m.created_at) + '">' + esc(fmtStamp(m.created_at)) + '</time></div>' +
      body + (files.length ? '<div class="kj-row-wrap kj-tk-msg-files">' + files.map(fileChip).join('') + '</div>' : '') + '</div></div>';
  }

  function workflowHtml(t, allowed, worker) {
    var has = function (s) { return allowed.indexOf(s) >= 0; };
    var btns = [];
    if (has('ack')) btns.push('<button type="button" class="kj-btn kj-btn-primary" data-kj-action="ack">' + ico('eye') + 'Acknowledge</button>');
    if (has('in_progress')) btns.push(t.status === 'resolved'
      ? '<button type="button" class="kj-btn kj-btn-secondary" data-kj-action="reopen">' + ico('rotate-ccw') + 'Reopen</button>'
      : '<button type="button" class="kj-btn kj-btn-secondary" data-kj-action="start">' + ico('play') + 'Start work</button>');
    if (has('closed')) btns.push('<button type="button" class="kj-btn kj-btn-primary" data-kj-action="close">' + ico('archive') + (worker ? 'Close ticket' : 'Confirm &amp; close') + '</button>');

    var remarks = (t.status === 'resolved' || t.status === 'closed') && t.closing_remarks
      ? '<div class="kj-tk-remarks"><div class="kj-section-title">' + ico('clipboard-check') + ' Closing remarks' +
          (t.resolution_code ? ' ' + chip(String(t.resolution_code).replace(/_/g, ' '), 'success') : '') + '</div>' +
          '<p>' + esc(t.closing_remarks).replace(/\n/g, '<br>') + '</p>' +
          '<div class="kj-muted">Resolved ' + esc(fmtStamp(t.resolved_at)) + (t.closed_at ? ' · closed ' + esc(fmtStamp(t.closed_at)) : '') + '</div></div>' : '';

    var resolve = has('resolved')
      ? '<div class="kj-tk-resolve"><div class="kj-card-title">' + ico('circle-check') + ' Resolve ticket</div>' +
          '<p class="kj-muted">Closing remarks are required to resolve this ticket.</p>' + resolveFields('tkd') +
          '<div class="kj-row"><span class="kj-spacer"></span><button type="button" class="kj-btn kj-btn-primary" data-kj-action="resolve">' + ico('check') + 'Resolve ticket</button></div></div>'
      : '';

    var hint = '';
    if (!btns.length && !resolve) {
      hint = t.status === 'closed' ? '<div class="kj-tk-flowhint is-done">' + ico('badge-check') + '<span>Closed ' + esc(fmtStamp(t.closed_at)) + '. No further action needed.</span></div>'
        : '<div class="kj-tk-flowhint">' + ico('hourglass') + '<span>' + (worker ? 'No status changes available.' : 'Our team is working on it — you can confirm and close once it is resolved.') + '</span></div>';
    }
    var steps = '<ol class="kj-tk-steps">' + STATUSES.map(function (s) {
      var i = STATUSES.indexOf(s), cur = STATUSES.indexOf(t.status);
      return '<li class="' + (i < cur ? 'is-done' : i === cur ? 'is-current' : '') + '"><span class="kj-tk-step-dot">' + (i < cur ? ico('check') : '') + '</span><span>' + esc(ST[s].label) + '</span></li>';
    }).join('') + '</ol>';
    return '<div class="kj-card kj-tk-flow"><div class="kj-card-head"><div class="kj-card-title">' + ico('workflow') + ' Workflow</div></div>' + steps +
      remarks + (btns.length ? '<div class="kj-row-wrap kj-tk-flowbtns">' + btns.join('') + '</div>' : '') + resolve + hint + '</div>';
  }

  /** Re-render the open modal with a fresh ticket (no refetch) + sync the board. */
  function refreshWith(c, t) {
    if (!t) { c.reload(); return; }
    c._fresh = t;
    page().changed(t);
    c.reload();
  }
  function busy(btn, on) { if (btn) { btn.disabled = !!on; btn.classList.toggle('is-busy', !!on); } }
  function doStatus(c, t, to, btn, remarks, code) {
    busy(btn, true);
    var body = { status: to };
    if (to === 'resolved') { body.remarks = remarks; body.resolution_code = code; }
    post('/tickets/' + t.id + '/status', body).then(function (r) {
      toast(t.ticket_no + ' → ' + ST[to].label, 'success');
      refreshWith(c, r.ticket);
    }).catch(function (e) { busy(btn, false); toast(errMsg(e), 'danger'); if (e.status === 403 || e.status === 409) c.reload(); });
  }
  function doUpdate(c, t, payload, ctl) {
    ctl.disabled = true;
    post('/tickets/' + t.id + '/update', payload).then(function (r) {
      toast(payload.priority ? 'Priority updated — SLA recalculated' : 'Assignee updated', 'success');
      refreshWith(c, r.ticket);
    }).catch(function (e) { ctl.disabled = false; toast(errMsg(e), 'danger'); c.reload(); });
  }
  function sendMessage(c, t, btn) {
    var comp = c.body.querySelector('[data-tkd="composer"]'); if (!comp) return;
    var ta = comp.querySelector('[data-tkd="body"]');
    var text = ta.value.trim(), files = (c._files || []).slice();
    var internal = comp.getAttribute('data-mode') === 'note';
    if (!text && !files.length) { ta.focus(); toast('Write a message or attach a file first.', 'warn'); return; }
    busy(btn, true);
    var latest = null;
    var first = text
      ? post('/tickets/' + t.id + '/messages', { body: text, internal: internal }).then(function (r) { latest = r.ticket; return r.message && r.message.id; })
      : Promise.resolve(null);
    first.then(function (mid) {
      var failed = 0;
      return files.reduce(function (p, f) {
        return p.then(function () {
          var fd = new FormData(); fd.append('file', f, f.name);
          if (mid) fd.append('message_id', String(mid));
          return req('POST', '/tickets/' + t.id + '/attachments', fd).catch(function (e) { failed++; toast(f.name + ': ' + errMsg(e), 'danger'); });
        });
      }, Promise.resolve()).then(function () { return failed; });
    }).then(function (failed) {
      toast(internal ? 'Internal note added' : (text ? 'Reply sent' : 'Files uploaded') + (failed ? ' (' + failed + ' file' + (failed > 1 ? 's' : '') + ' failed)' : ''), failed ? 'warn' : 'success');
      c._files = [];
      if (files.length || !latest) { if (latest) page().changed(latest); c.reload(); } else refreshWith(c, latest);
    }).catch(function (e) { busy(btn, false); toast(errMsg(e), 'danger'); });
  }

  /* ── legacy incident ticket (live-feed event) ──────────── */
  function renderLegacy(ctx, e) {
    var H = window.KJModal.h;
    var n = H.normEvent(e);
    return {
      title: n.title, kicker: 'Incident ticket ' + (n.ticket || ''), icon: 'ticket', tone: n.sev === 'critical' || n.sev === 'high' ? 'danger' : 'warn',
      body: '<div class="kj-grid-2">' + H.media(n.image || n.imageBk, n.title) + '<div class="kj-card">' + H.kv([
          ['Ticket', n.ticket || '—'], ['Status', n.status || '—'],
          ['Camera', n.camera ? H.link('camera', n.camera, n.camera) : '—', true],
          ['Zone', n.zone || n.location || '—'], ['Detected', H.fmtTime(n.ts)],
          ['Person', n.personId ? H.link('person', n.personId, n.person || ('#' + n.personId)) : (n.person || '—'), true],
          ['Assignee', n.assignee || '—'], ['Detection', H.link('event', n.id, 'View event'), true]]) + '</div></div>' +
        '<div class="kj-help">This incident ticket lives in the detection workspace (communication, attachments and escalation).</div>',
      foot: H.btn('full', 'Open ticket workspace', 'external-link', 'kj-btn-primary'),
      actions: { full: H.viaApp(function (a) { a.openTicket(e); }) }
    };
  }

  /* ── registration ──────────────────────────────────────── */
  window.KJPages.register('tickets', Object.assign(M, {
    // ── Legacy Component methods (verbatim from app.js; `this` is the dc app) ──
    methods: class {
  openTicket(e){ this.setState({modal:{type:'ticket', data:e}, tktTab:'comm', tktLog:null, tktFiles:null, tktNear:null,
    tktNote:'', tktRemark:'', tktMsg:'', tktCommPage:0, tktHistPage:0}); this.loadTicket(e.id); this.fetchNear(e); this.scheduleComm(); }
  // Same-camera detections in the minute leading up to this one (context tab).
  fetchNear(tk){
    const stream=String(tk.camera||'').toLowerCase();
    const base=String(tk.received||tk.triggerTime||'').replace(' ','T');
    const t=Date.parse(base)||tk.ts||Date.now();
    const p=(n)=>String(n).padStart(2,'0');
    const fmt=(ms)=>{ const d=new Date(ms);
      return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); };
    fetch(`${this.API}/events?token=${this.TOK}&stream=${encodeURIComponent(stream)}&from=${encodeURIComponent(fmt(t-60000))}&to=${encodeURIComponent(fmt(t+1000))}&limit=60`, {cache:'no-store'})
      .then(r=>r.json()).then(d=>{ this.setState({tktNear:(d&&d.ok&&d.events)||[]}); })
      .catch(()=>this.setState({tktNear:[]}));
  }
  loadTicket(id){
    fetch(`${this.API}/events/${encodeURIComponent(id)}/log?token=${this.TOK}`, {cache:'no-store'})
      .then(r=>r.json()).then(d=>{ if(d&&d.ok){ this.setState({tktLog:d.log||[]}); this.scheduleComm(); } }).catch(()=>{});
    fetch(`${this.API}/events/${encodeURIComponent(id)}/attachments?token=${this.TOK}`, {cache:'no-store'})
      .then(r=>r.json()).then(d=>{ if(d&&d.ok) this.setState({tktFiles:d.files||[]}); }).catch(()=>{});
  }
  // Communication tab: rich-text toolbar + imperatively rendered, paginated
  // comment list (comments are a sanitized HTML subset from the editor).
  scheduleComm(){ if(this._cmT) clearTimeout(this._cmT); this._cmT=setTimeout(()=>{ this.bindComm(); this.renderComments(); }, 90); }
  bindComm(){
    const tb=document.getElementById('tkt-toolbar'), ed=document.getElementById('tkt-editor');
    if(tb && !tb._tmns){ tb._tmns=1;
      tb.querySelectorAll('button[data-cmd]').forEach(b=>{
        b.addEventListener('mousedown', e=>{ e.preventDefault();
          const c=b.getAttribute('data-cmd');
          if(c==='createLink'){ const u=window.prompt('Link URL (https://…)'); if(u) document.execCommand('createLink', false, u); }
          else document.execCommand(c, false, null);
          if(ed) ed.focus();
        });
      });
    }
  }
  renderComments(){
    if(this.state.tktTab!=='comm') return;
    const box=document.getElementById('tkt-comm-list'); if(!box) return;
    const esc=(s)=>String(s==null?'':s).replace(/[&<>"']/g, ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const kindCol={comment:'var(--low)', notify:'var(--brand)', tmforce:'var(--crit)', remark:'var(--ok)', escalation:'var(--high)'};
    const isHtml=(s)=>/<([a-z]+)(\s|\/?>)/i.test(s||'');
    const all=(this.state.tktLog||[]).filter(l=>['comment','notify','tmforce','remark','escalation'].indexOf(l.kind)>=0);
    const PS=8, pages=Math.max(1, Math.ceil(all.length/PS));
    const p=Math.min(this.state.tktCommPage||0, pages-1);
    const slice=all.slice(p*PS, p*PS+PS);
    let h='';
    if(!all.length) h='<div class="tkt-c-empty">No communications yet — add the first note below.</div>';
    slice.forEach(l=>{ const col=kindCol[l.kind]||'var(--low)';
      const body=isHtml(l.note)? l.note : esc(l.note||'').replace(/\n/g,'<br>');
      const initial=esc(String(l.actor||'—').charAt(0).toUpperCase());
      h+='<div class="tkt-c-row">'
        +'<span class="tkt-c-dot" style="background:'+col+';box-shadow:0 0 9px '+col+'"></span>'
        +'<div class="tkt-c-card">'
        +'<div class="tkt-c-head">'
        +'<span class="tkt-c-avatar">'+initial+'</span>'
        +'<b class="tkt-c-actor">'+esc(l.actor||'—')+'</b>'
        +'<span class="tkt-c-time">'+esc(l.created_at||'')+'</span>'
        +'<span class="tkt-c-kind" style="color:'+col+'">'+esc(l.kind)+'</span></div>'
        +'<div class="tkt-note tkt-c-body">'+body+'</div></div></div>';
    });
    if(pages>1){
      h+='<div class="tkt-c-pager">'
        +'<button id="tkt-cprev" class="tkt-c-btn"'+(p===0?' disabled':'')+'>‹ Prev</button>'
        +'<span class="tkt-c-time">Page '+(p+1)+' / '+pages+'</span>'
        +'<button id="tkt-cnext" class="tkt-c-btn"'+(p>=pages-1?' disabled':'')+'>Next ›</button></div>';
    }
    box.innerHTML=h;
    const pv=document.getElementById('tkt-cprev'), nx=document.getElementById('tkt-cnext');
    if(pv) pv.addEventListener('click', ()=>{ this.setState({tktCommPage:Math.max(0, p-1)}); this.scheduleComm(); });
    if(nx) nx.addEventListener('click', ()=>{ this.setState({tktCommPage:Math.min(pages-1, p+1)}); this.scheduleComm(); });
  }
  tktPost(id, path, payload, msg){
    this.setState({tktMsg:'Working…'});
    fetch(`${this.API}/events/${encodeURIComponent(id)}/${path}?token=${this.TOK}`,
      {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload||{})})
      .then(r=>r.json()).then(d=>{
        this.setState({tktMsg:(d&&d.ok)?(msg||'Done ✓'):'Failed'});
        this.loadTicket(id); this.fetchFeed();
        if(this._tkT) clearTimeout(this._tkT); this._tkT=setTimeout(()=>this.setState({tktMsg:''}), 2500);
      }).catch(()=>this.setState({tktMsg:'Failed'}));
  }
  makeTicket(id, ev){ if(ev&&ev.stopPropagation) ev.stopPropagation(); this.tktPost(id, 'ticket', {actor:this.UNAME}, 'Ticket created'); }
  // Drag-and-drop multi-file upload for the ticket Attachments tab.
  // Native listeners bind once per DOM node (dc-runtime keeps nodes across
  // re-renders, same as the Highcharts containers).
  bindDrop(){
    const dz=document.getElementById('tkt-drop'), inp=document.getElementById('tkt-file');
    if(!dz||!inp) return;
    const idOf=()=> (this.state.modal&&this.state.modal.data)?this.state.modal.data.id:null;
    if(!inp._tmns){ inp._tmns=1;
      inp.addEventListener('change', ()=>{ if(inp.files&&inp.files.length) this.tktUploadFiles(idOf(), inp.files); });
    }
    if(!dz._tmns){ dz._tmns=1;
      ['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation();
        dz.style.borderColor='var(--brand)'; dz.style.background='var(--bg4)'; }));
      ['dragleave','drop'].forEach(ev=>dz.addEventListener(ev, e=>{ e.preventDefault(); e.stopPropagation();
        dz.style.borderColor=''; dz.style.background=''; }));
      dz.addEventListener('drop', e=>{ const fs=e.dataTransfer&&e.dataTransfer.files; if(fs&&fs.length) this.tktUploadFiles(idOf(), fs); });
    }
  }
  tktUploadFiles(id, fileList){
    if(!id||!fileList||!fileList.length) return;
    const files=[...fileList]; const total=files.length;
    let done=0, fail=0;
    const next=()=>{
      if(!files.length){
        this.setState({tktMsg: fail? (done+' uploaded · '+fail+' failed') : (done+' file'+(done===1?'':'s')+' uploaded ✓')});
        const inp=document.getElementById('tkt-file'); if(inp) inp.value='';
        this.loadTicket(id);
        if(this._tkT) clearTimeout(this._tkT); this._tkT=setTimeout(()=>this.setState({tktMsg:''}), 3000);
        return;
      }
      const f=files.shift();
      if(f.size>10*1024*1024){ fail++; next(); return; }
      this.setState({tktMsg:'Uploading '+f.name+' ('+(done+fail+1)+'/'+total+')…'});
      const fd=new FormData(); fd.append('file', f); fd.append('actor', this.UNAME);
      fetch(`${this.API}/events/${encodeURIComponent(id)}/attach?token=${this.TOK}`, {method:'POST', body:fd})
        .then(r=>r.json()).then(d=>{ (d&&d.ok)?done++:fail++; next(); })
        .catch(()=>{ fail++; next(); });
    };
    next();
  }
    }
  }));

  // KJModal is a deferred script; this file is blocking. Register as soon as it exists.
  if (!registerModals()) {
    document.addEventListener('DOMContentLoaded', registerModals);
    var tries = 0;
    (function poll() { if (!registerModals() && tries++ < 100) setTimeout(poll, 50); })();
  }
})();
