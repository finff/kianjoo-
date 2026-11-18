/* ==========================================================================
 * KJPlayback — violation playback player (15 s before → 15 s after a detection)
 *
 * Shared contract: any page may render
 *   <button type="button" class="kj-btn kj-btn-ghost kj-btn-sm" data-kj-playback="EVENT_UUID">…Playback</button>
 * A delegated (capture-phase) click handler opens the player for that event in a
 * KJModal layer ('playback:UUID'). Nothing else is needed from the caller.
 *   KJPlayback.open(uuid)   programmatic open
 *
 * Data: GET /api/playback/info?event=UUID   (window, marker, reason, snapshots)
 *       GET /api/playback/clip?event=UUID   (record stream, same format as
 *       /api/live/relay: u32 len · u32 duration ms · Annex-B H.264, fed to jmuxer/MSE)
 * The whole clip stays in the MSE buffer (clearBuffer:false), so pause, replay
 * and scrubbing work without fetching again.
 *
 * Failure is never a blank or endlessly spinning player: when playback is not
 * configured, the recorder refuses, nothing arrives within 30 s, or the browser
 * lacks Media Source Extensions, the stage shows the detection snapshot and
 * "Recording not available — <reason>" with a Retry button.
 * Styles: assets/css/kj-playback.css (linked from the dc.html).
 * ========================================================================== */
(function () {
  'use strict';

  var JMUXER_SRC = 'https://cdn.jsdelivr.net/npm/jmuxer@2.0.7/dist/jmuxer.min.js';
  var FIRST_FRAME_TIMEOUT = 30000;

  function M() { return window.KJModal || null; }
  function H() { var m = M(); return (m && m.h) || null; }
  function esc(v) { return v == null ? '' : String(v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ico(n, cls) { return window.KJIcon ? window.KJIcon.svg(n, cls) : ''; }
  function apiBase() { return (window.TMNS && window.TMNS.api) || '/api'; }
  function token() { return (window.TMNS && window.TMNS.token) || ''; }
  function url(path, params) {
    var q = new URLSearchParams(params || {});
    if (token()) q.set('token', token());
    return apiBase() + path + '?' + q.toString();
  }
  function hms(iso) { var s = String(iso || ''); return s.length >= 19 ? s.slice(11, 19) : '—'; }
  function day(iso) {
    var s = String(iso || ''); if (s.length < 10) return '';
    var d = new Date(s.slice(0, 10) + 'T00:00:00');
    return isNaN(d) ? s.slice(0, 10) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  function rel(sec) {
    if (Math.abs(sec) < 0.05) return '0.0 s';
    return (sec < 0 ? '−' : '+') + Math.abs(sec).toFixed(1) + ' s';
  }
  function mseOk() { return !!(window.MediaSource || window.ManagedMediaSource) && typeof fetch === 'function' && !!(window.ReadableStream || window.Response); }

  /* jmuxer: reuse the dashboard's loader when present (same pinned build) */
  var jmWait = null;
  function loadJmuxer() {
    if (window.JMuxer) return Promise.resolve();
    var app = window.KJApp;
    if (app && typeof app.loadJmuxer === 'function') {
      return new Promise(function (res, rej) { app.loadJmuxer(function (err) { if (err) rej(err); else res(); }); });
    }
    if (jmWait) return jmWait;
    jmWait = new Promise(function (res, rej) {
      var sc = document.createElement('script');
      sc.src = JMUXER_SRC;
      sc.onload = function () { res(); };
      sc.onerror = function () { jmWait = null; rej(new Error('player')); };
      document.head.appendChild(sc);
    });
    return jmWait;
  }

  /* ── markup ─────────────────────────────────────────────── */
  function snapshots(d) {
    var im = d.images || {}, list = [[im.trigger, 'Detection'], [im.scene, 'Scene']].filter(function (x) { return x[0]; });
    if (!list.length) return '';
    return '<div class="kjp-snaps">' + list.map(function (x) {
      return '<button type="button" class="kjp-snap" data-kj-modal="image:' + esc(encodeURIComponent(x[0])) + '" data-kj-seed=\'' + esc(JSON.stringify({ label: (d.title || 'Detection') + ' · ' + x[1] })) + '\'>' +
        '<img src="' + esc(x[0]) + '" alt="' + esc(x[1]) + ' snapshot" loading="lazy"><span>' + esc(x[1]) + '</span></button>';
    }).join('') + '</div>';
  }
  function posterOf(d) { var im = d.images || {}; return im.scene || im.trigger || ''; }
  function unavailable(d, reason, retryIn) {
    var poster = posterOf(d);
    return '<div class="kjp-stage is-unavailable">' +
      (poster ? '<img class="kjp-still" src="' + esc(poster) + '" alt="Detection snapshot">' : '<div class="kjp-still is-empty">' + ico('image-off') + '</div>') +
      '<div class="kjp-msg" role="status">' + ico('video-off') + '<div><b>Recording not available</b><span data-kjp-reason>' + esc(reason || 'No reason given.') + '</span>' +
        (retryIn ? '<span class="kjp-retry-note" data-kjp-countdown>Trying again in ' + esc(retryIn) + ' s…</span>' : '') + '</div></div></div>';
  }
  function cameraLine(d) {
    var c = d.camera || {}, cam = String(c.stream || '').toUpperCase();
    return [cam + (c.name || d.device ? ' · ' + (c.name || d.device) : ''), d.start ? day(d.start) + ' ' + hms(d.start) + ' → ' + hms(d.end) + ' (site time)' : '']
      .filter(Boolean).join(' · ');
  }
  function playerHtml(d) {
    var poster = posterOf(d);
    return '<div class="kjp-stage" data-kjp-state="connecting">' +
        '<video class="kjp-video" muted playsinline' + (poster ? ' poster="' + esc(poster) + '"' : '') + '></video>' +
        '<span class="kjp-badge">' + ico('film') + 'Recording · ' + esc(String((d.camera || {}).stream || '').toUpperCase()) + '</span>' +
        '<div class="kjp-overlay" data-kjp-overlay><span class="kjp-spin" aria-hidden="true"></span><span data-kjp-status>Connecting to the recorder…</span></div>' +
        '<div class="kjp-msg is-hidden" data-kjp-err role="alert">' + ico('video-off') + '<div><b>Recording not available</b><span data-kjp-reason></span>' +
          '<button type="button" class="kj-btn kj-btn-secondary kj-btn-sm" data-kjp-act="retry">' + ico('refresh-cw') + 'Retry</button></div></div>' +
      '</div>' +
      '<div class="kjp-bar">' +
        '<button type="button" class="kj-btn kj-btn-secondary kj-btn-icon kj-btn-sm" data-kjp-act="toggle" aria-label="Pause" title="Play / pause">' + ico('pause') + '</button>' +
        '<button type="button" class="kj-btn kj-btn-ghost kj-btn-icon kj-btn-sm" data-kjp-act="replay" aria-label="Replay from the start" title="Replay">' + ico('rotate-ccw') + '</button>' +
        '<div class="kjp-track"><span class="kjp-buf" data-kjp-buf></span><span class="kjp-prog" data-kjp-prog></span>' +
          '<span class="kjp-marker" data-kjp-marker title="Detection moment"></span>' +
          '<input class="kjp-range" type="range" min="0" max="' + esc(d.duration || 30) + '" step="0.1" value="0" aria-label="Position in the clip" data-kjp-range></div>' +
        '<span class="kjp-time" data-kjp-time>' + esc(rel(-(d.marker || d.pre || 0))) + '</span>' +
      '</div>' +
      '<div class="kjp-scale"><span>−' + esc(d.pre) + ' s</span><span class="kjp-scale-mid" data-kjp-scale-mid>' + ico('crosshair') + 'Detection</span><span>+' + esc(d.post) + ' s</span></div>';
  }

  /* ── player controller ──────────────────────────────────── */
  function Player(ctx, d) {
    this.ctx = ctx; this.d = d; this.stopped = false;
    this.root = ctx.body.querySelector('.kjp');
    this.v = this.root.querySelector('.kjp-video');
    this.frames = 0; this.done = false; this.jm = null; this.ab = null; this.t0 = 0;
    this.dur = Math.max(1, Number(d.duration) || 30);
    this.marker = Number(d.marker != null ? d.marker : d.pre) || 0;
  }
  Player.prototype.$ = function (sel) { return this.root.querySelector(sel); };
  Player.prototype.state = function (s, text) {
    var st = this.$('.kjp-stage'); if (st) st.setAttribute('data-kjp-state', s);
    var o = this.$('[data-kjp-overlay]'); if (o) o.classList.toggle('is-hidden', !(s === 'connecting' || s === 'buffering'));
    if (text != null) { var t = this.$('[data-kjp-status]'); if (t) t.textContent = text; }
    var b = this.$('[data-kjp-act="toggle"]');
    if (b) { var playing = s === 'playing' || s === 'buffering' || s === 'connecting';
      b.innerHTML = ico(playing ? 'pause' : 'play'); b.setAttribute('aria-label', playing ? 'Pause' : 'Play'); }
  };
  Player.prototype.fail = function (reason) {
    if (this.stopped) return;
    this.abort();
    var e = this.$('[data-kjp-err]'), r = this.$('[data-kjp-reason]');
    if (r) r.textContent = reason || 'The recorder sent no video.';
    if (e) e.classList.remove('is-hidden');
    this.state('error');
    var st = this.$('.kjp-stage'); if (st) st.classList.add('is-unavailable');
  };
  Player.prototype.abort = function () {
    clearTimeout(this.ffTimer);
    try { if (this.ab) this.ab.abort(); } catch (x) { /* ignore */ }
    this.ab = null;
  };
  Player.prototype.destroy = function () {
    this.stopped = true; this.abort();
    clearInterval(this.tick);
    try { if (this.jm) this.jm.destroy(); } catch (x) { /* ignore */ }
    this.jm = null;
    try { this.v.removeAttribute('src'); this.v.load(); } catch (x) { /* ignore */ }
  };
  Player.prototype.bufEnd = function () {
    try { var b = this.v.buffered; return b && b.length ? b.end(b.length - 1) : 0; } catch (x) { return 0; }
  };
  Player.prototype.bufStart = function () {
    try { var b = this.v.buffered; return b && b.length ? b.start(0) : 0; } catch (x) { return 0; }
  };
  Player.prototype.pos = function () { return Math.max(0, (this.v.currentTime || 0) - this.bufStart()); };
  Player.prototype.paint = function () {
    if (this.stopped) return;
    var pos = this.pos(), be = Math.max(0, this.bufEnd() - this.bufStart());
    var pct = function (x) { return Math.max(0, Math.min(100, 100 * x / this.dur)) + '%'; }.bind(this);
    var p = this.$('[data-kjp-prog]'), bf = this.$('[data-kjp-buf]'), rg = this.$('[data-kjp-range]'), tm = this.$('[data-kjp-time]');
    if (p) p.style.width = pct(pos);
    if (bf) bf.style.width = pct(this.done ? Math.max(be, this.dur) : be);
    if (rg && document.activeElement !== rg) rg.value = String(Math.min(this.dur, pos).toFixed(1));
    if (tm) tm.textContent = rel(pos - this.marker);
    var mid = this.$('[data-kjp-scale-mid]'); if (mid) mid.classList.toggle('is-now', Math.abs(pos - this.marker) < 0.6);
    // The recorder usually sends in real time: start once ~1 s is buffered so the
    // play head stays ahead of the download instead of stuttering at its edge.
    if (this.frames && !this.begun) {
      if (be >= 1 || this.done) this.begin();
      else this.state('buffering', 'Loading the recording…');
      return;
    }
    if (this.begun && !this.v.paused) {
      var starving = be - pos < 0.15;
      if (starving && this.done) { this.v.pause(); this.state('ended'); }
      else if (starving) this.state('buffering', 'Loading the recording…');
      else this.state('playing');
    }
  };
  Player.prototype.begin = function () {
    this.begun = true;
    var p = this.v.play(); if (p && p.catch) p.catch(function () {});
    this.state('playing');
  };
  Player.prototype.start = function () {
    var self = this;
    this.root.querySelector('.kjp-marker').style.left = Math.max(0, Math.min(100, 100 * this.marker / this.dur)) + '%';
    this.tick = setInterval(function () { self.paint(); }, 200);
    if (!mseOk()) { this.fail('This browser cannot play recorder video (no Media Source Extensions). Try Chrome, Edge or Firefox on a computer.'); return; }
    this.state('connecting', 'Connecting to the recorder…');
    loadJmuxer().then(function () { if (!self.stopped) self.fetch(); },
      function () { self.fail('The video player could not be loaded (no access to cdn.jsdelivr.net?).'); });
  };
  Player.prototype.fetch = function () {
    var self = this, d = this.d;
    this.frames = 0; this.done = false; this.begun = false; this.t0 = Date.now();
    try { if (this.jm) this.jm.destroy(); } catch (x) { /* ignore */ }
    this.v.muted = true; this.v.playsInline = true;
    this.jm = new window.JMuxer({ node: this.v, mode: 'video', flushingTime: 0, fps: 25, clearBuffer: false, debug: false, onError: function () { /* next keyframe recovers */ } });
    this.ab = typeof AbortController !== 'undefined' ? new AbortController() : null;
    this.ffTimer = setTimeout(function () { if (!self.frames) self.fail('The recorder did not send any video within 30 s.'); }, FIRST_FRAME_TIMEOUT);
    var params = { event: d.event };
    if (d.preOverride != null) params.pre = d.preOverride;
    if (d.postOverride != null) params.post = d.postOverride;
    fetch(url('/playback/clip', params), { cache: 'no-store', credentials: 'same-origin', signal: this.ab ? this.ab.signal : undefined })
      .then(function (r) {
        var ct = r.headers.get('content-type') || '';
        if (!r.ok || ct.indexOf('application/json') >= 0) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            throw new Error((j && (j.reason || j.error)) || ('The server answered HTTP ' + r.status + '.'));
          });
        }
        if (!r.body || !r.body.getReader) throw new Error('This browser cannot stream video.');
        self.state('connecting', 'Receiving the recording…');
        var rd = r.body.getReader(), buf = new Uint8Array(0);
        var pump = function () {
          return rd.read().then(function (res) {
            if (self.stopped) return;
            if (res.done) return;
            var value = res.value;
            if (value && value.length) {
              var nb = new Uint8Array(buf.length + value.length); nb.set(buf); nb.set(value, buf.length); buf = nb;
              var off = 0;
              while (buf.length - off >= 8) {
                var dv = new DataView(buf.buffer, buf.byteOffset + off, 8);
                var len = dv.getUint32(0, true), dur = dv.getUint32(4, true);
                if (buf.length - off - 8 < len) break;
                if (len) {
                  self.jm.feed({ video: buf.subarray(off + 8, off + 8 + len), duration: dur || 40 });
                  if (!self.frames++) { clearTimeout(self.ffTimer); self.state('buffering', 'Loading the recording…'); }
                }
                off += 8 + len;
              }
              if (off) buf = buf.slice(off);
            }
            return pump();
          });
        };
        return pump();
      })
      .then(function () {
        if (self.stopped) return;
        clearTimeout(self.ffTimer);
        if (!self.frames) { self.fail('The recorder sent no video for this time span.'); return; }
        self.done = true; self.ab = null;
      })
      .catch(function (err) {
        if (self.stopped) return;
        clearTimeout(self.ffTimer);
        if (self.frames) { self.done = true; self.note('Connection lost — showing the part of the recording that arrived.'); return; }
        var msg = (err && err.name === 'AbortError') ? 'Playback was stopped.' : ((err && err.message) || 'Network error.');
        self.fail(/^Recording not available — /.test(msg) ? msg.replace(/^Recording not available — /, '') : msg);
      });
  };
  Player.prototype.note = function (text) {
    var n = this.root.querySelector('[data-kjp-note]'); if (n) { n.textContent = text; n.classList.remove('is-hidden'); }
  };
  Player.prototype.toggle = function () {
    if (this.$('.kjp-stage').getAttribute('data-kjp-state') === 'error') return;
    if (!this.frames) return;
    if (!this.begun) { this.begin(); return; }
    if (this.v.paused) {
      if (this.done && this.bufEnd() - this.v.currentTime < 0.2) { this.replay(); return; }
      var p = this.v.play(); if (p && p.catch) p.catch(function () {});
      this.state('playing');
    } else { this.v.pause(); this.state('paused'); }
  };
  Player.prototype.replay = function () {
    if (!this.frames) { this.retry(); return; }
    try { this.v.currentTime = this.bufStart(); } catch (x) { /* ignore */ }
    this.begin();
  };
  Player.prototype.seek = function (sec) {
    if (!this.frames) return;
    var target = Math.max(0, Math.min(Number(sec) || 0, Math.max(0, this.bufEnd() - this.bufStart() - 0.05)));
    try { this.v.currentTime = this.bufStart() + target; } catch (x) { /* ignore */ }
    this.paint();
  };
  Player.prototype.retry = function () {
    var e = this.$('[data-kjp-err]'); if (e) e.classList.add('is-hidden');
    var st = this.$('.kjp-stage'); if (st) st.classList.remove('is-unavailable');
    this.abort(); this.fetch();
    this.state('connecting', 'Connecting to the recorder…');
  };

  /* Stop streaming once the modal layer is closed (KJModal has no close hook). */
  function watchClose(ctx, player) {
    var seen = false;
    var iv = setInterval(function () {
      var open = document.body.contains(ctx.el) && ctx.el.classList.contains('is-open');
      if (open) { seen = true; return; }
      if (seen || !document.body.contains(ctx.el)) { clearInterval(iv); player.destroy(); }
    }, 300);
  }

  /* ── modal type ─────────────────────────────────────────── */
  var registered = false;
  function register() {
    var m = M();
    if (registered || !m || !m.register) return registered;
    registered = true;
    m.register('playback', {
      kicker: 'Violation playback', icon: 'film', size: 'lg', skeleton: 'media',
      load: function (ctx) {
        var h = H();
        return h.api('/playback/info', { event: String(ctx.id) });
      },
      render: function (ctx, d) {
        var title = d.title || 'Detection';
        var head = { title: 'Playback · ' + title, kicker: 'Violation playback', icon: 'film', tone: d.available ? 'primary' : 'warn' };
        var meta = '<p class="kjp-meta">' + ico('cctv') + '<span>' + esc(cameraLine(d)) + '</span></p>';
        var snaps = snapshots(d);
        var snapSec = snaps ? '<div class="kj-section-title">Detection snapshots</div>' + snaps : '';
        if (!d.available) {
          var retryIn = d.retry_after > 0 ? d.retry_after : 0;
          return Object.assign(head, {
            body: '<div class="kjp">' + unavailable(d, d.reason, retryIn) + meta + snapSec + '</div>',
            foot: '<button type="button" class="kj-btn kj-btn-secondary" data-kj-action="retry">' + ico('refresh-cw') + 'Check again</button>' +
              '<button type="button" class="kj-btn kj-btn-primary" data-kj-close>Close</button>',
            actions: { retry: function (c) { c.reload(); } },
            mount: function (c) {
              if (!retryIn) return;
              var left = retryIn, el = c.body.querySelector('[data-kjp-countdown]');
              var iv = setInterval(function () {
                if (!document.body.contains(c.el)) { clearInterval(iv); return; }
                left--;
                if (el) el.textContent = 'Trying again in ' + Math.max(0, left) + ' s…';
                if (left <= 0) { clearInterval(iv); c.reload(); }
              }, 1000);
            }
          });
        }
        return Object.assign(head, {
          body: '<div class="kjp">' + playerHtml(d) + '<p class="kjp-note is-hidden" data-kjp-note role="status"></p>' + meta + snapSec + '</div>',
          foot: '<button type="button" class="kj-btn kj-btn-primary" data-kj-close>Close</button>',
          actions: {},
          mount: function (c) {
            if (c._kjp) c._kjp.destroy();
            var pl = new Player(c, d);
            c._kjp = pl;
            var root = c.body.querySelector('.kjp');
            root.addEventListener('click', function (ev) {
              var b = ev.target.closest ? ev.target.closest('[data-kjp-act]') : null; if (!b) return;
              ev.preventDefault();
              var a = b.getAttribute('data-kjp-act');
              if (a === 'toggle') pl.toggle(); else if (a === 'replay') pl.replay(); else if (a === 'retry') pl.retry();
            });
            var rg = root.querySelector('[data-kjp-range]');
            rg.addEventListener('input', function () { pl.seek(rg.value); });
            pl.v.addEventListener('click', function () { pl.toggle(); });
            watchClose(c, pl);
            pl.start();
          }
        });
      }
    });
    return true;
  }

  function open(uuid) {
    uuid = String(uuid || '').trim();
    if (!uuid) return;
    if (!register()) { setTimeout(function () { if (register()) M().open('playback', uuid); }, 300); return; }
    M().open('playback', uuid);
  }

  // Delegated, capture phase: runs before row / card click handlers (and React's root
  // listener), so a Playback button inside a clickable row only opens the player.
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!(t instanceof Element)) return;
    var b = t.closest('[data-kj-playback]');
    if (!b || b.disabled) return;
    ev.preventDefault(); ev.stopPropagation();
    open(b.getAttribute('data-kj-playback'));
  }, true);

  register();
  if (!registered) {
    var tries = 0;
    (function later() { if (!register() && tries++ < 50) setTimeout(later, 100); })();
  }
  window.KJPlayback = { open: open };
})();
