<?php
/**
 * Violation playback routes, included from api/index.php inside its try {}
 * (shares $route, $seg, $method, $config, $requireToken, $provisionAdmin).
 * Lives in lib/ so it is never directly web-reachable. Logic: lib/Playback.php.
 *
 *   GET  /playback/info?event=UUID[&pre=&post=]
 *        → {ok, available, reason, retry_after, start, end, event_time, marker, duration,
 *           pre, post, camera:{stream,name}, images:{trigger,scene}, title, time_source}
 *        Never contacts the recorder (fast); 'available' = configured + camera + window.
 *   GET  /playback/clip?event=UUID[&pre=&post=]
 *        → application/octet-stream, the same record stream as GET /live/relay
 *          (u32 len · u32 duration ms · Annex-B H.264), covering
 *          [detection − pre, detection + post]; ends when the span is done
 *          (hard cap Playback::MAX_SPAN s of video). Before the first frame,
 *          failures answer JSON {ok:false, error, reason} (502 / 409 / 503).
 *   POST /playback/test {stream, ago?:120, playback?:{draft settings}}   [settings permission]
 *        → {ok, frames, bytes, ms, url (masked), error, reason}; pulls ~2 s of
 *          the recording from `ago` seconds back on that camera.
 *
 * Auth like the live relay: the dashboard read token (or the provision token).
 * A clip bypasses RelayHub (it is per-request and time-bounded, nothing to
 * share) but counts against RelayHub::MAX_VIEWERS through a heartbeat file in
 * storage/live_relay, so live tiles and clips together never starve the PHP
 * workers.
 */

declare(strict_types=1);

if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

if (($seg[0] ?? '') !== 'playback') {
    return;   // not ours — fall through to the rest of api/index.php
}

require_once APP_ROOT . '/lib/LiveBridge.php';
require_once APP_ROOT . '/lib/RtspRelay.php';
require_once APP_ROOT . '/lib/RelayHub.php';
require_once APP_ROOT . '/lib/Playback.php';

if ($provisionAdmin() === null) {
    $requireToken($config['auth']['read_token']);
}
$pbSub = (string) ($seg[1] ?? '');
if (isset($seg[2])) {
    Response::error('Unknown playback route.', 404);
}
$config['playback'] = $config['playback'] ?? Playback::configFrom([]);

/** One event row (by uuid, or numeric id) + its hydrated images, or a 404. */
$pbEvent = static function () use ($config): array {
    $id = trim((string) ($_GET['event'] ?? ''));
    if ($id === '' || strlen($id) > 191 || !preg_match('/^[A-Za-z0-9_.:-]+$/', $id)) {
        Response::error('event is required.', 422);
    }
    $pdo   = Database::connect($config['storage']);
    $store = new EventStore($pdo, $config);
    $rec   = $store->find($id);
    if ($rec === null && ctype_digit($id)) {
        $st = $pdo->prepare('SELECT uuid FROM events WHERE id = :id');
        $st->execute(['id' => (int) $id]);
        $u = (string) ($st->fetchColumn() ?: '');
        $rec = $u !== '' ? $store->find($u) : null;
    }
    if ($rec === null) {
        Response::error('Event not found (it may have been purged).', 404);
    }
    return $rec;
};
$pbSide = static fn (string $k): ?int => isset($_GET[$k]) && is_numeric($_GET[$k]) ? (int) $_GET[$k] : null;

// ── GET /playback/info ───────────────────────────────────────
if ($pbSub === 'info' && $method === 'GET') {
    $rec  = $pbEvent();
    $plan = Playback::plan($config, $rec, $pbSide('pre'), $pbSide('post'));
    require_once APP_ROOT . '/lib/Text.php';
    Response::ok([
        'event'       => (string) ($rec['uuid'] ?? ''),
        'available'   => $plan['available'],
        'reason'      => $plan['reason'],
        'retry_after' => $plan['retry_after'],
        'start'       => $plan['start'],
        'end'         => $plan['end'],
        'event_time'  => $plan['event_time'],
        'time_source' => $plan['time_source'],
        'marker'      => $plan['marker'],
        'duration'    => $plan['duration'],
        'pre'         => $plan['pre'],
        'post'        => $plan['post'],
        'camera'      => $plan['camera'] ?? ['stream' => (string) ($rec['stream'] ?? ''), 'name' => ''],
        'device'      => Text::latin((string) ($rec['device_name'] ?? ''), ''),
        'title'       => Text::latin((string) (($rec['policy_name'] ?? '') ?: ($rec['event_type'] ?? '')), 'Detection'),
        'images'      => [
            'trigger' => $rec['images']['trigger'] ?? null,
            'scene'   => $rec['images']['background'] ?? null,
        ],
    ]);
}

// ── GET /playback/clip ───────────────────────────────────────
if ($pbSub === 'clip' && $method === 'GET') {
    $rec  = $pbEvent();
    $plan = Playback::plan($config, $rec, $pbSide('pre'), $pbSide('post'));
    if (!$plan['available']) {
        if ($plan['retry_after'] > 0) {
            header('Retry-After: ' . $plan['retry_after']);
        }
        Response::error('Recording not available — ' . $plan['reason'], $plan['retry_after'] > 0 ? 409 : 422,
            ['reason' => $plan['reason'], 'retry_after' => $plan['retry_after']]);
    }
    $dir = LiveBridge::storageDir($config);
    $hub = new RelayHub($dir, 'playback', '');
    if (!$hub->hasCapacity()) {
        Response::error('Video relay busy — too many streams are open. Try again in a minute.', 503,
            ['reason' => 'Too many live / playback streams are open right now. Try again in a minute.']);
    }
    @set_time_limit(0);
    @ini_set('zlib.output_compression', '0');
    @ini_set('output_buffering', '0');
    @ini_set('implicit_flush', '1');
    ignore_user_abort(true);      // notice the viewer leaving ourselves and TEARDOWN the recorder session
    while (ob_get_level() > 0) {
        @ob_end_clean();
    }
    if (function_exists('apache_setenv')) {
        @apache_setenv('no-gzip', '1');
    }
    // Heartbeat in storage/live_relay so RelayHub::hasCapacity() counts this clip.
    $beat = $dir . '/live_relay/playback-' . bin2hex(random_bytes(3)) . '.c.' . bin2hex(random_bytes(4));
    @touch($beat);
    $lastBeat = microtime(true);
    $started  = false;
    try {
        $spanMs = min(Playback::MAX_SPAN, (int) $plan['duration']) * 1000;
        $res = Playback::pull($plan['url'], $spanMs, static function (string $rec) use (&$started, $plan): bool {
            if (connection_aborted()) {
                return false;
            }
            if (!$started) {
                $started = true;
                http_response_code(200);
                header('Content-Type: application/octet-stream');
                header('Cache-Control: no-cache, no-store, no-transform');
                header('X-Accel-Buffering: no');
                header('X-LiteSpeed-Cache-Control: no-cache');
                header('Content-Encoding: identity');
                header('X-Playback-Marker: ' . $plan['marker']);
                header('X-Playback-Duration: ' . $plan['duration']);
            }
            echo $rec;
            @flush();
            return !connection_aborted();
        }, min(Playback::MAX_SPAN, (int) $plan['duration']) + 40, static function () use ($beat, &$lastBeat): void {
            if (microtime(true) - $lastBeat > 2) {
                @touch($beat);
                $lastBeat = microtime(true);
            }
        });
    } finally {
        @unlink($beat);
    }
    if (!$started) {
        $why = Playback::reason($res['error'] ?? '');
        Response::error('Recording not available — ' . $why, 502, ['reason' => $why]);
    }
    exit;
}

// ── POST /playback/test {stream, ago?, playback?} ────────────
if ($pbSub === 'test' && $method === 'POST') {
    if ($provisionAdmin() === null) {
        require_once APP_ROOT . '/lib/Auth.php';
        if (Auth::user() === null) {
            Response::error('Sign in to test playback.', 401);
        }
        if (!Auth::can('settings')) {
            Response::error('Forbidden: testing playback needs the settings permission.', 403);
        }
        session_write_close();    // the test holds the request for up to ~25 s — don't lock the session meanwhile
    }
    $in     = json_decode(file_get_contents('php://input') ?: '', true) ?: [];
    $stream = trim((string) (is_scalar($in['stream'] ?? null) ? $in['stream'] : ''));
    if (!preg_match('/^[a-z0-9_.-]{1,64}$/i', $stream)) {
        Response::error('Choose a camera to test.', 422);
    }
    $ago = max(30, min(7 * 86400, (int) ($in['ago'] ?? 120)));
    // Unsaved settings from the form may be tested before saving.
    $cfg = $config;
    if (isset($in['playback']) && is_array($in['playback'])) {
        $raw = is_file(APP_ROOT . '/storage/app_settings.json')
            ? (json_decode((string) file_get_contents(APP_ROOT . '/storage/app_settings.json'), true) ?: []) : [];
        [$draft, $err] = Playback::sanitize($in['playback'], is_array($raw['playback'] ?? null) ? $raw['playback'] : []);
        if ($err !== null) {
            Response::error($err, 422);
        }
        $cfg['playback'] = $draft;
    }
    $cfg['playback']['enabled'] = true;     // testing is how you find out whether to enable it
    $t    = microtime(true) - $ago;
    $row  = ['stream' => $stream, 'device_serial' => '', 'trigger_time' => date('Y-m-d H:i:s', (int) $t), 'received_at' => date('Y-m-d H:i:s', (int) $t)];
    $plan = Playback::plan($cfg, $row, 2, 4);
    if ($plan['url'] === '') {
        Response::ok(['ok' => false, 'frames' => 0, 'bytes' => 0, 'ms' => 0, 'url' => '', 'error' => $plan['reason'], 'reason' => $plan['reason'],
                      'window' => ['start' => $plan['start'], 'end' => $plan['end']]]);
    }
    $dir = LiveBridge::storageDir($config);
    if (!(new RelayHub($dir, 'playback', ''))->hasCapacity()) {
        Response::error('Video relay busy — too many streams are open. Try again in a minute.', 503);
    }
    @set_time_limit(60);
    $beat = $dir . '/live_relay/playback-test.c.' . bin2hex(random_bytes(4));
    @touch($beat);
    $t0 = microtime(true);
    try {
        $res = Playback::pull($plan['url'], 2000, static fn (string $r): bool => true, 25);
    } finally {
        @unlink($beat);
    }
    $ok = $res['frames'] > 0;
    Response::ok([
        'ok'       => $ok,
        'frames'   => $res['frames'],
        'bytes'    => $res['bytes'],
        'media_ms' => $res['media_ms'],
        'ms'       => (int) round((microtime(true) - $t0) * 1000),
        'url'      => $plan['masked'],
        'window'   => ['start' => $plan['start'], 'end' => $plan['end']],
        'error'    => $ok ? '' : $res['error'],
        'reason'   => $ok ? '' : Playback::reason($res['error']),
    ]);
}

Response::error('Unknown playback route.', 404);
