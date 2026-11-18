/* KJShell — app chrome rendered from ONE nav config, outside the dc template.
 *
 *  • Desktop sidebar (#kj-nav): canonical hubs, RBAC-filtered by window.TMNS perms,
 *    with the active hub's sub-pages nested underneath.
 *  • Hub tab strip (#kj-hub-tabs, top bar): the active hub's sub-pages as kj-tabs.
 *  • Staff app shell (#kj-staff, appended to <body>): app bar + bottom tab nav for
 *    the #app-* routes (operator / viewer land here; see kj-pages defaultPath()).
 *  • Phone shell for desktop roles (≤768px, kj-shell.css): bottom tab bar #kj-mtabs (first
 *    4 RBAC hubs + More) and the More sheet #kj-msheet (remaining hubs, My attendance app,
 *    theme, sign out), both body-level; top-bar chevron = "up", search collapses to an icon.
 *  • One delegated click handler: any element with data-kj-nav="<path>" navigates.
 *  • In-app notification bell (KJShell.bell): desktop top bar (#kj-tb-bell slot in the dc
 *    template) + staff app bar. Polls GET /notifications/count every 30 s, badge, desktop
 *    list panel (GET /notifications?all=1) with mark-read and ref deep links (leave / ticket
 *    modals, else the stored #hash link). The staff bar bell opens the staff app's own
 *    'staff-notifs' modal when registered. Muted when localStorage kj.staff.notify = 'off'
 *    (the staff app's Notifications switch). Fires `kj:notif-count` {count, prev} on change.
 *
 * Owned by the SPA architecture; page agents never edit this file — a hub's
 * sub-tabs come from its own module's `subs` (assets/js/pages/<hub>.js).
 */
(function () {
  'use strict';

  /* Canonical sidebar (REVAMP_PLAN §4) — grouped into labelled sections (desktop sidebar
     only), order, label, icon. Access comes from each module's `perm`; hubs whose module
     isn't registered are skipped. A section with label '' renders no heading. */
  var NAV_SECTIONS = [
    { label: '', items: [
      { hub: 'dashboard',  label: 'Dashboard',  icon: 'layout-dashboard' }
    ] },
    { label: 'Operations', items: [
      { hub: 'tickets',    label: 'Tickets',    icon: 'ticket' },
      { hub: 'analytics',  label: 'Analytics',  icon: 'chart-line' }
    ] },
    { label: 'Workforce', items: [
      { hub: 'people',     label: 'People',     icon: 'users' },
      { hub: 'attendance', label: 'Attendance', icon: 'calendar-check' }
    ] },
    { label: 'Monitoring', items: [
      { hub: 'cameras',    label: 'Cameras',    icon: 'cctv' },
      { hub: 'detections', label: 'Detections', icon: 'scan-eye', badge: 'openEvents' },
      { hub: 'movement',   label: 'Movement',   icon: 'route' }
    ] },
    { label: 'Administration', items: [
      { hub: 'settings',   label: 'Settings',   icon: 'settings' }
    ] }
  ];
  /* Flat hub list in section order — the mobile tab bar / More sheet and KJShell.NAV
     consumers (settings.js role preview) use this. */
  var NAV = NAV_SECTIONS.reduce(function (all, s) { return all.concat(s.items); }, []);
  /* Below the hubs: link into the staff attendance app (every signed-in user is staff too). */
  var NAV_FOOT = [
    { hub: 'staff-app', path: 'app-home', label: 'My attendance app', icon: 'smartphone' }
  ];
  /* Staff app bottom tabs (approved mockup docs/mockup-ui/generated/staff-mobile-home.png). */
  var STAFF_TABS = [
    { path: 'app-home',       sub: 'home',       label: 'Home',       icon: 'house' },
    { path: 'app-attendance', sub: 'attendance', label: 'Attendance', icon: 'calendar-check' },
    { path: 'app-leave',      sub: 'leave',      label: 'Leave',      icon: 'calendar-plus' },
    { path: 'app-profile',    sub: 'profile',    label: 'Profile',    icon: 'user-round' }
  ];

  var badges = { openEvents: 0 };
  var last = { nav: '', tabs: '', staff: '', mob: '', sheet: '' };
  var current = null;
  var staffEl = null;
  var booted = false;

  function P() { return window.KJPages; }
  function esc(v) { return P().h.esc(v); }
  function ico(n, c) { return P().h.ico(n, c); }
  function initials(name) {
    return String(name || '').trim().split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join('') || '·';
  }

  /* ── sidebar ─────────────────────────────────────────────────────────── */
  function navOk(n) { return P().get(n.hub) && P().allowed(n.hub); }
  function navHtml(r) {
    // Only sections with at least one RBAC-visible hub survive; when just one survives
    // (restricted roles) a lone heading adds noise, so none are drawn.
    var secs = NAV_SECTIONS.map(function (s) { return { label: s.label, items: s.items.filter(navOk) }; })
      .filter(function (s) { return s.items.length; });
    var heads = secs.length > 1;
    var out = secs.map(function (s) {
      return (heads && s.label ? '<div class="kj-nav-sect">' + esc(s.label) + '</div>' : '') + s.items.map(navItem).join('');
    }).join('');
    function navItem(n) {
      var on = !!r && r.hub === n.hub;
      var subs = on ? P().visibleSubs(n.hub) : [];
      var nested = subs.length > 1;
      var b = n.badge ? badges[n.badge] : 0;
      var html = '<button type="button" class="c10 navbtn kj-nav-item' + (on ? (nested ? ' nav-grp-on' : ' nav-on') : '') + '"' +
        ' data-kj-nav="' + esc(n.hub) + '" title="' + esc(n.label) + '"' + (on ? ' aria-current="page"' : '') + '>' +
        ico(n.icon, 'kj-nav-ico') + '<span class="nav-lbl">' + esc(n.label) + '</span>' +
        (b ? '<span class="c12 kj-nav-badge">' + (b > 99 ? '99+' : b) + '</span>' : '') + '</button>';
      if (nested) {
        html += '<div class="nav-subs kj-nav-subs">' + subs.map(function (s) {
          var son = r.sub === s.key;
          return '<button type="button" class="c10 navbtn nav-sub' + (son ? ' nav-on' : '') + '" data-kj-nav="' + esc(s.path) + '" title="' + esc(s.label) + '"' +
            (son ? ' aria-current="page"' : '') + '><span class="nav-dot"></span><span class="nav-lbl">' + esc(s.label) + '</span></button>';
        }).join('') + '</div>';
      }
      return html;
    }
    var foot = NAV_FOOT.filter(navOk).map(function (n) {
      var on = !!r && r.hub === n.hub;
      return '<button type="button" class="c10 navbtn kj-nav-item kj-nav-foot' + (on ? ' nav-on' : '') + '" data-kj-nav="' + esc(n.path) + '" title="' + esc(n.label) + '">' +
        ico(n.icon, 'kj-nav-ico') + '<span class="nav-lbl">' + esc(n.label) + '</span></button>';
    }).join('');
    return out + (foot ? '<div class="kj-nav-sep" role="separator"></div>' + foot : '');
  }
  function renderNav(r) {
    var el = document.getElementById('kj-nav');
    if (!el) return;
    var html = navHtml(r);
    if (html === last.nav && el.innerHTML) return;     // keep focus / hover state between polls
    last.nav = html;
    el.innerHTML = html;
  }

  /* ── hub tab strip (top bar) ─────────────────────────────────────────── */
  function renderTabs(r) {
    var el = document.getElementById('kj-hub-tabs');
    if (!el) return;
    var m = r && P().get(r.hub);
    var subs = (m && m.shell !== 'staff') ? P().visibleSubs(r.hub) : [];
    var html = subs.length > 1 ? '<div class="kj-tabs kj-hubtabs-strip" role="tablist" aria-label="' + esc(m.title) + ' sections">' +
      subs.map(function (s) {
        var on = r.sub === s.key;
        return '<button type="button" class="kj-tab' + (on ? ' is-active' : '') + '" role="tab" aria-selected="' + (on ? 'true' : 'false') + '" data-kj-nav="' + esc(s.path) + '">' +
          (s.icon ? ico(s.icon, 'kj-ico-16') : '') + '<span>' + esc(s.label) + '</span></button>';
      }).join('') + '</div>' : '';
    el.classList.toggle('is-on', !!html);
    if (html === last.tabs) return;
    last.tabs = html;
    el.innerHTML = html;
  }

  /* ── staff app shell ─────────────────────────────────────────────────── */
  function ensureStaff() {
    if (staffEl && document.body.contains(staffEl)) return staffEl;
    var u = P().me() || {};
    staffEl = document.createElement('div');
    staffEl.id = 'kj-staff';
    staffEl.className = 'kj-staff kj-root';
    staffEl.setAttribute('data-theme', 'light');
    staffEl.hidden = true;
    staffEl.innerHTML =
      '<div class="kj-staff-frame">' +
        '<header class="kj-staff-bar">' +
          '<img class="kj-staff-logo" src="/uploads/Kian-Joo-Logo.png" alt="Kian Joo Group">' +
          '<div class="kj-staff-titles"><div class="kj-staff-title" id="kj-staff-title">Home</div>' +
          '<div class="kj-staff-sub">Kian Joo VisionAI</div></div>' +
          bellButtonHtml('staff') +
          '<button type="button" class="kj-staff-avatar" data-kj-nav="app-profile" aria-label="My profile" title="' + esc(u.name || 'Profile') + '">' + esc(initials(u.name)) + '</button>' +
        '</header>' +
        '<main class="kj-staff-main" id="kj-staff-main" tabindex="-1"></main>' +
        '<nav class="kj-staff-tabs" id="kj-staff-tabs" aria-label="Staff app"></nav>' +
      '</div>';
    document.body.appendChild(staffEl);
    bellPaint();
    return staffEl;
  }
  function staffMain() { return ensureStaff().querySelector('#kj-staff-main'); }
  function renderStaff(r) {
    if (!staffEl) return;
    var tabs = STAFF_TABS.map(function (t) {
      var on = !!r && r.hub === 'staff-app' && r.sub === t.sub;
      return '<button type="button" class="kj-staff-tab' + (on ? ' is-active' : '') + '" data-kj-nav="' + t.path + '"' + (on ? ' aria-current="page"' : '') + '>' +
        ico(t.icon) + '<span>' + esc(t.label) + '</span></button>';
    }).join('');
    if (tabs !== last.staff) { last.staff = tabs; staffEl.querySelector('#kj-staff-tabs').innerHTML = tabs; }
    var t = STAFF_TABS.filter(function (x) { return r && x.sub === r.sub; })[0];
    staffEl.querySelector('#kj-staff-title').textContent = t ? t.label : 'Home';
  }

  /* ── phone shell for the desktop roles (≤768px; CSS does the show/hide) ──
     Bottom tab bar (#kj-mtabs) = the first MOBILE_TABS hubs of the SAME RBAC-filtered NAV,
     plus a "More" tab whose slide-up sheet (#kj-msheet) lists the remaining hubs, the
     NAV_FOOT entries (My attendance app) and account actions (theme, sign out).
     The top-bar chevron (.tb-collapse, a sidebar toggle on desktop) becomes an "up" button
     on phones; the search box collapses to an icon that expands over the bar. */
  var MOBILE_TABS = 4;
  var PHONE_MQ = '(max-width: 768px)';
  var mobEl = null, sheetEl = null, sheetOpener = null;
  function isPhone() { try { return !!(window.matchMedia && window.matchMedia(PHONE_MQ).matches); } catch (e) { return false; } }
  function visibleHubs() { return NAV.filter(function (n) { return P().get(n.hub) && P().allowed(n.hub); }); }
  function visibleFoot() { return NAV_FOOT.filter(function (n) { return P().get(n.hub) && P().allowed(n.hub); }); }
  /** {tabs: hubs in the bar, more: hubs + foot entries in the More sheet}. */
  function mobileSplit() {
    var hubs = visibleHubs();
    return { tabs: hubs.slice(0, MOBILE_TABS), more: hubs.slice(MOBILE_TABS).concat(visibleFoot()) };
  }
  function ensureMobile() {
    if (!mobEl || !document.body.contains(mobEl)) {
      mobEl = document.createElement('nav');
      mobEl.id = 'kj-mtabs';
      mobEl.className = 'kj-mtabs';
      mobEl.setAttribute('aria-label', 'Main navigation');
      document.body.appendChild(mobEl);
      last.mob = '';
    }
    if (!sheetEl || !document.body.contains(sheetEl)) {
      sheetEl = document.createElement('div');
      sheetEl.id = 'kj-msheet';
      sheetEl.className = 'kj-msheet';
      sheetEl.hidden = true;
      sheetEl.innerHTML = '<div class="kj-msheet-backdrop" data-kj-msheet-close></div>' +
        '<div class="kj-msheet-panel" role="dialog" aria-modal="true" aria-labelledby="kj-msheet-title" tabindex="-1">' +
        '<div class="kj-msheet-grip" aria-hidden="true"></div><div class="kj-msheet-body"></div></div>';
      document.body.appendChild(sheetEl);
      last.sheet = '';
    }
  }
  function tabBtn(n, on, path) {
    var b = n.badge ? badges[n.badge] : 0;
    return '<button type="button" class="kj-mtab' + (on ? ' is-active' : '') + '" data-kj-nav="' + esc(path || n.hub) + '"' + (on ? ' aria-current="page"' : '') + '>' +
      '<span class="kj-mtab-ico">' + ico(n.icon) + (b ? '<span class="kj-mtab-badge">' + (b > 99 ? '99+' : b) + '</span>' : '') + '</span>' +
      '<span class="kj-mtab-lbl">' + esc(n.label) + '</span></button>';
  }
  function renderMobile(r) {
    if (!booted) return;
    ensureMobile();
    var s = mobileSplit();
    var moreOn = !!r && s.more.some(function (n) { return n.hub === r.hub; });
    var open = !sheetEl.hidden;
    var html = s.tabs.map(function (n) { return tabBtn(n, !!r && r.hub === n.hub); }).join('') +
      (s.more.length || P().me() ? '<button type="button" class="kj-mtab kj-mtab-more' + (moreOn || open ? ' is-active' : '') + '" data-kj-more' +
        ' aria-haspopup="dialog" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="kj-msheet">' +
        '<span class="kj-mtab-ico">' + ico('ellipsis') + '</span><span class="kj-mtab-lbl">More</span></button>' : '');
    mobEl.setAttribute('data-count', String(s.tabs.length + 1));
    syncTheme();
    if (html !== last.mob) { last.mob = html; mobEl.innerHTML = html; }
    if (open) renderSheet(r);
    syncBack(r);
  }
  /** Body-level phone chrome follows the dashboard root's light/dark theme. */
  function syncTheme() {
    var c1 = document.querySelector('.c1'), th = (c1 && c1.getAttribute('data-theme')) || 'light';
    [mobEl, sheetEl].forEach(function (el) { if (el && el.getAttribute('data-theme') !== th) el.setAttribute('data-theme', th); });
  }
  function renderSheet(r) {
    var s = mobileSplit(), u = P().me() || {};
    var item = function (n) {
      var on = !!r && r.hub === n.hub, b = n.badge ? badges[n.badge] : 0;
      return '<button type="button" class="kj-msheet-item' + (on ? ' is-active' : '') + '" data-kj-nav="' + esc(n.path || n.hub) + '"' + (on ? ' aria-current="page"' : '') + '>' +
        '<span class="kj-msheet-ico">' + ico(n.icon) + '</span><span class="kj-msheet-lbl">' + esc(n.label) + '</span>' +
        (b ? '<span class="kj-mtab-badge">' + (b > 99 ? '99+' : b) + '</span>' : '') + ico('chevron-right', 'kj-msheet-chev') + '</button>';
    };
    var role = String(u.role || '').replace(/[_-]+/g, ' ');
    var html = '<div class="kj-msheet-head"><span class="kj-msheet-avatar">' + esc(initials(u.name)) + '</span>' +
        '<span class="kj-msheet-who"><span class="kj-msheet-title" id="kj-msheet-title">' + esc(u.name || 'More') + '</span>' +
        (role ? '<span class="kj-msheet-role">' + esc(role) + '</span>' : '') + '</span>' +
        '<button type="button" class="kj-msheet-x" data-kj-msheet-close aria-label="Close menu">' + ico('x') + '</button></div>' +
      (s.more.length ? '<div class="kj-msheet-list" role="list">' + s.more.map(item).join('') + '</div>' : '') +
      '<div class="kj-msheet-actions">' +
        '<button type="button" class="kj-msheet-act" data-kj-mact="theme">' + ico('sun-moon') + '<span>Switch theme</span></button>' +
        '<a class="kj-msheet-act is-danger" href="/?logout=1">' + ico('log-out') + '<span>Sign out</span></a></div>';
    if (html === last.sheet) return;
    last.sheet = html;
    sheetEl.querySelector('.kj-msheet-body').innerHTML = html;
  }
  function sheetToggle(open, opener) {
    if (!sheetEl) return;
    open = open == null ? sheetEl.hidden : !!open;
    if (open === !sheetEl.hidden) return;
    if (open) {
      sheetOpener = opener || document.activeElement;
      last.sheet = '';
      renderSheet(current);
      sheetEl.hidden = false;
      document.documentElement.classList.add('kj-msheet-open');
      // next frame → .is-open runs the slide-up transition
      setTimeout(function () { if (!sheetEl.hidden) sheetEl.classList.add('is-open'); }, 0);
      var f = sheetEl.querySelector('.kj-msheet-item, .kj-msheet-act');
      if (f) try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); }
    } else {
      sheetEl.classList.remove('is-open');
      sheetEl.hidden = true;
      document.documentElement.classList.remove('kj-msheet-open');
      if (sheetOpener && document.body.contains(sheetOpener) && sheetOpener.focus) sheetOpener.focus();
      sheetOpener = null;
    }
    last.mob = '';
    renderMobile(current);
  }
  function sheetTrap(e) {
    if (e.key !== 'Tab' || !sheetEl || sheetEl.hidden) return;
    var f = Array.prototype.slice.call(sheetEl.querySelectorAll('button, a[href]'));
    if (!f.length) return;
    var a = document.activeElement, i = f.indexOf(a);
    if (e.shiftKey && (i <= 0)) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && (i === f.length - 1 || i < 0)) { e.preventDefault(); f[0].focus(); }
  }
  /** Phone "up" target for the top-bar chevron: hub root, else the role landing; '' = none. */
  function backTarget(r) {
    if (!r || !r.hub) return '';
    var m = P().get(r.hub);
    if ((r.rest && r.rest.length) || (m && r.sub && m.defaultSub && r.sub !== m.defaultSub)) return r.hub;
    // Already on the role landing (hub id, or a top-level alias of this hub like #app-home)?
    var home = String(P().defaultPath() || '');
    if (!home || home.split('/')[0] === r.hub || (m && (m.routes || {})[home])) return '';
    return home;
  }
  function syncBack(r) {
    var phone = isPhone(), t = backTarget(r);
    document.documentElement.classList.toggle('kj-m-noback', !t);
    var b = document.querySelector('.c25 .tb-collapse');
    if (!b) return;
    if (phone) b.setAttribute('aria-label', 'Back');
    else b.removeAttribute('aria-label');
  }
  function searchToggle(open) {
    var root = document.documentElement;
    open = open == null ? !root.classList.contains('kj-msearch-open') : !!open;
    root.classList.toggle('kj-msearch-open', open);
    if (open) { var i = document.getElementById('tmns-search'); if (i) i.focus(); }
  }
  /** Window capture phase: runs before the dc-runtime's React handlers. */
  function phoneCapture(e) {
    if (!isPhone() || document.documentElement.classList.contains('kj-staff-mode')) return;
    var t = e.target; if (!(t instanceof Element)) return;
    if (t.closest('.c25 .tb-collapse')) {          // sidebar toggle is meaningless on phones → "up"
      e.stopPropagation(); e.preventDefault();
      var to = backTarget(current);
      if (to) P().go(to);
      return;
    }
    var root = document.documentElement;
    if (t.closest('.c25 .c32') && !root.classList.contains('kj-msearch-open')) { e.preventDefault(); searchToggle(true); return; }
    if (root.classList.contains('kj-msearch-open') && !t.closest('.c25 .c31')) searchToggle(false);
  }
  function phoneClick(t) {
    if (t.closest('[data-kj-more]')) { sheetToggle(null, t.closest('[data-kj-more]')); return true; }
    if (t.closest('[data-kj-msheet-close]')) { sheetToggle(false); return true; }
    var act = t.closest('[data-kj-mact]');
    if (act) {
      if (act.getAttribute('data-kj-mact') === 'theme') { var th = document.querySelector('.c25 .c51'); if (th) th.click(); setTimeout(syncTheme, 60); }
      sheetToggle(false);
      return true;
    }
    if (isPhone() && t.closest('.c25 .tb-user')) { sheetToggle(true, t.closest('.tb-user')); return true; }
    return false;
  }

  /* ── in-app notification bell ───────────────────────────────────────── */
  var BELL = { n: -1, timer: null, open: false, list: null, err: '', busy: false };
  var NOTIF_KIND = { leave_submitted: ['send', 'warn'], leave_approved: ['circle-check', 'success'], leave_rejected: ['circle-x', 'danger'],
    leave_cancelled: ['ban', 'muted'], ticket_assigned: ['ticket', 'primary'] };
  function bellMuted() { try { return window.localStorage.getItem('kj.staff.notify') === 'off'; } catch (e) { return false; } }
  function apiUrl(path, params) {
    var base = (window.TMNS && window.TMNS.api) || '/api', q = [];
    Object.keys(params || {}).forEach(function (k) { if (params[k] != null && params[k] !== '') q.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k])); });
    return base + path + (q.length ? '?' + q.join('&') : '');
  }
  function api(method, path, params, body) {
    var o = { method: method, credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } };
    if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return Promise.resolve().then(function () { return window.fetch(apiUrl(path, params), o); }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok || !d || d.ok === false) { var e = new Error((d && d.error) || 'Request failed'); e.status = r.status; throw e; }
        return d;
      });
    });
  }
  function bellButtonHtml(where) {
    // Staff bar: reuse the staff app's .kj-sa-bell look; it opens the staff-notifs modal.
    return where === 'staff'
      ? '<button type="button" class="kj-sa-bell kj-bell" data-kj-bell="staff" aria-label="Notifications">' +
          '<span class="kj-sa-bell-ico kj-bell-ico"></span><span class="kj-sa-bell-badge kj-bell-badge" hidden></span></button>'
      : '<button type="button" class="kj-bell kj-tb-bell-btn" data-kj-bell="desk" aria-label="Notifications" aria-haspopup="true" aria-expanded="false" title="Notifications — leave &amp; ticket updates">' +
          '<span class="kj-bell-ico"></span><span class="kj-bell-badge" hidden></span></button>' +
        '<div class="kj-bell-panel" data-kj-bell-panel hidden></div>';
  }
  function deskSlot() {
    var slot = document.getElementById('kj-tb-bell');
    if (slot && !slot.querySelector('[data-kj-bell="desk"]')) slot.innerHTML = bellButtonHtml('desk');
    return slot;
  }
  function bellPaint() {
    var muted = bellMuted(), n = muted ? 0 : Math.max(0, BELL.n);
    deskSlot();
    Array.prototype.forEach.call(document.querySelectorAll('[data-kj-bell]'), function (b) {
      var i = b.querySelector('.kj-bell-ico'), want = muted ? 'bell-off' : 'bell';
      if (i && (i.getAttribute('data-ico') !== want || !i.innerHTML)) { i.innerHTML = ico(want); i.setAttribute('data-ico', want); }
      var badge = b.querySelector('.kj-bell-badge');
      if (badge) { badge.hidden = !n; badge.textContent = n > 9 ? '9+' : String(n); }
      b.setAttribute('aria-label', n ? 'Notifications, ' + n + ' unread' : 'Notifications');
      b.classList.toggle('has-unread', !!n);
    });
  }
  function bellSet(n) {
    n = Math.max(0, n | 0);
    var prev = BELL.n;
    BELL.n = n;
    bellPaint();
    if (prev !== n) {
      try { document.dispatchEvent(new CustomEvent('kj:notif-count', { detail: { count: n, prev: prev, muted: bellMuted() } })); } catch (e) { /* old browser */ }
    }
  }
  function bellPoll() {
    if (!P().me() || document.hidden) return Promise.resolve();
    if (bellMuted()) { bellPaint(); return Promise.resolve(); }
    return api('GET', '/notifications/count').then(function (d) { bellSet(d.unread_count); }).catch(function () { /* offline / signed out: keep last badge */ });
  }
  function bellStart() {
    if (BELL.timer || !P().me()) return;
    bellPoll();
    BELL.timer = setInterval(bellPoll, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) bellPoll(); });
  }
  function agoTxt(ts) {
    var t = Date.parse(String(ts || '').replace(' ', 'T')); if (!t) return '';
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }
  function panelEl() { var slot = deskSlot(); return slot && slot.querySelector('[data-kj-bell-panel]'); }
  function panelPaint() {
    var el = panelEl(); if (!el) return;
    var list = BELL.list || [];
    var rows = BELL.busy && !BELL.list ? '<div class="kj-bell-empty">' + ico('loader') + '<span>Loading…</span></div>'
      : BELL.err ? '<div class="kj-bell-empty is-error">' + ico('triangle-alert') + '<span>' + esc(BELL.err) + '</span></div>'
      : !list.length ? '<div class="kj-bell-empty">' + ico('bell') + '<span>You’re all caught up</span></div>'
      : list.map(function (n, i) {
        var k = NOTIF_KIND[n.kind] || ['bell', 'primary'];
        return '<button type="button" class="kj-bell-row' + (n.read ? '' : ' is-unread') + '" data-kj-bell-row="' + i + '">' +
          '<span class="kj-bell-row-ico is-' + k[1] + '">' + ico(k[0]) + '</span>' +
          '<span class="kj-bell-row-main"><span class="kj-bell-row-title">' + esc(n.title) + '</span>' +
          (n.body ? '<span class="kj-bell-row-body">' + esc(n.body) + '</span>' : '') +
          '<span class="kj-bell-row-time">' + esc(agoTxt(n.created_at)) + '</span></span></button>';
      }).join('');
    var unread = list.filter(function (n) { return !n.read; }).length;
    el.innerHTML = '<div class="kj-bell-head"><span class="kj-bell-title">Notifications</span>' +
      '<span class="kj-bell-count">' + (BELL.n > 0 ? BELL.n + ' unread' : 'Inbox') + '</span>' +
      (unread ? '<button type="button" class="kj-bell-all" data-kj-bell-all>Mark all read</button>' : '') + '</div>' +
      '<div class="kj-bell-list">' + rows + '</div>';
  }
  function panelLoad() {
    BELL.busy = true; BELL.err = ''; panelPaint();
    return api('GET', '/notifications', { all: 1, limit: 20 }).then(function (d) {
      BELL.list = d.notifications || []; if (d.unread_count != null) bellSet(d.unread_count);
    }).catch(function (e) { BELL.err = (e && e.message) || 'Could not load notifications'; }).then(function () { BELL.busy = false; panelPaint(); });
  }
  function panelToggle(open) {
    var el = panelEl(); if (!el) return;
    BELL.open = open == null ? !BELL.open : !!open;
    el.hidden = !BELL.open;
    var b = document.querySelector('[data-kj-bell="desk"]'); if (b) b.setAttribute('aria-expanded', BELL.open ? 'true' : 'false');
    if (BELL.open) panelLoad();
  }
  function markRead(ids) {
    return api('POST', '/notifications/read', null, ids ? { ids: ids } : { all: true }).then(function (r) { bellSet(r.unread_count); }).catch(function () { /* stays unread */ });
  }
  /** Open what a notification points at: leave / ticket modal, else its stored #hash link. */
  function openRef(n) {
    var M = window.KJModal;
    if (n.ref_type === 'leave' && n.ref_id && M) { M.open('leave', n.ref_id); return; }
    if (n.ref_type === 'ticket' && n.ref_id && M) { M.open('ticket', n.ref_id); return; }
    if (n.link && /^#/.test(n.link)) location.hash = n.link;
  }
  function bellClick(e) {
    var t = e.target; if (!(t instanceof Element)) return false;
    var btn = t.closest('[data-kj-bell]');
    if (btn) {
      e.preventDefault();
      if (btn.getAttribute('data-kj-bell') === 'staff') {
        var M = window.KJModal;
        if (M && M.types && M.types().indexOf('staff-notifs') >= 0) M.open('staff-notifs', 'me');
        return true;
      }
      panelToggle();
      return true;
    }
    if (!BELL.open) return false;
    if (t.closest('[data-kj-bell-all]')) {
      (BELL.list || []).forEach(function (n) { n.read = true; }); panelPaint(); markRead(null);
      return true;
    }
    var row = t.closest('[data-kj-bell-row]');
    if (row) {
      var n = (BELL.list || [])[+row.getAttribute('data-kj-bell-row')];
      if (n) {
        if (!n.read) { n.read = true; markRead([n.id]); }
        panelToggle(false);
        openRef(n);
      }
      return true;
    }
    if (!t.closest('[data-kj-bell-panel]')) panelToggle(false);
    return false;
  }
  var bellApi = {
    count: function () { return BELL.n; },
    set: bellSet,
    refresh: function () { bellPaint(); return bellPoll(); },
    open: function () { panelToggle(true); },
    close: function () { panelToggle(false); }
  };

  /** 'staff' → full-screen app shell (dashboard chrome hidden); anything else → desktop. */
  function setMode(mode) {
    var staff = mode === 'staff';
    if (staff) ensureStaff();
    document.documentElement.classList.toggle('kj-staff-mode', staff);
    if (staffEl) staffEl.hidden = !staff;
    if (staff) { sheetToggle(false); document.documentElement.classList.remove('kj-msearch-open'); }
  }

  function render(r) {
    current = r || current;
    if (booted) deskSlot();
    renderNav(current);
    renderTabs(current);
    if (current && current.hub === 'staff-app') renderStaff(current);
    if (r) document.documentElement.classList.remove('kj-msearch-open');
    renderMobile(current);
  }

  function onFeed(data, app) {
    var ev = (app && app.state && app.state.events) || (data && data.events) || [];
    var n = 0;
    // One per incident episode — repeats of the same violation (feed groupMember) don't add to the badge.
    for (var i = 0; i < ev.length; i++) if (ev[i] && ev[i].status === 'open' && !ev[i].groupMember) n++;
    if (n !== badges.openEvents) { badges.openEvents = n; renderNav(current); renderMobile(current); }
  }

  function boot() {
    if (booted) return;
    booted = true;
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!(t instanceof Element)) return;
      if (bellClick(e)) return;
      if (phoneClick(t)) { e.preventDefault(); return; }
      var el = t.closest('[data-kj-nav]');
      if (!el) return;
      var path = el.getAttribute('data-kj-nav');
      if (!path) return;
      e.preventDefault();
      if (el.closest('.kj-modal-layer') && window.KJModal) window.KJModal.closeAll();
      if (el.closest('#kj-msheet')) sheetToggle(false);
      P().go(path);
      if (el.closest('#kj-staff')) { var m = staffMain(); if (m) m.scrollTop = 0; }
    });
    // Icons come from deferred vendor scripts: repaint once they're guaranteed loaded.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && BELL.open) panelToggle(false);
      if (e.key === 'Escape' && sheetEl && !sheetEl.hidden) { sheetToggle(false); return; }
      if (e.key === 'Escape' && document.documentElement.classList.contains('kj-msearch-open')) searchToggle(false);
      sheetTrap(e);
    });
    window.addEventListener('click', phoneCapture, true);
    try {
      var mq = window.matchMedia && window.matchMedia(PHONE_MQ);
      var onMq = function () { if (!mq.matches) { sheetToggle(false); document.documentElement.classList.remove('kj-msearch-open'); } syncBack(current); };
      if (mq && mq.addEventListener) mq.addEventListener('change', onMq); else if (mq && mq.addListener) mq.addListener(onMq);
    } catch (e) { /* no matchMedia (old browser / jsdom) */ }
    bellStart();
    var repaint = function () { last.nav = ''; last.tabs = ''; last.staff = ''; last.mob = ''; last.sheet = ''; render(current); bellPaint(); };
    if (document.readyState === 'complete') setTimeout(repaint, 0);
    else window.addEventListener('load', repaint);
  }

  window.KJShell = {
    NAV: NAV, NAV_SECTIONS: NAV_SECTIONS, NAV_FOOT: NAV_FOOT, STAFF_TABS: STAFF_TABS, MOBILE_TABS: MOBILE_TABS,
    mobile: { split: mobileSplit, open: function () { sheetToggle(true); }, close: function () { sheetToggle(false); }, isPhone: isPhone, back: function () { return backTarget(current); } },
    boot: boot, render: render, setMode: setMode, staffMain: staffMain, onFeed: onFeed, bell: bellApi,
    badges: function () { return Object.assign({}, badges); }
  };
})();
