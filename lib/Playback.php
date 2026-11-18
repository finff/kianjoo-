<?php

declare(strict_types=1);

require_once __DIR__ . '/LiveBridge.php';
require_once __DIR__ . '/RtspRelay.php';

/**
 * Violation playback: the recording around a detection, from the customer's
 * NVR / camera, over RTSP playback.
 *
 * Nothing is recorded on the web host and it cannot run ffmpeg. The NVR (or
 * a camera with an SD card) already records; most brands serve a time range
 * of that recording over RTSP. This class turns a detection into such a
 * time-ranged RTSP URL; lib/PlaybackRoutes.php pulls it through RtspRelay (the
 * same H.264 depacketiser as the live relay) and streams the same record
 * format as GET /live/relay, so the browser plays it with jmuxer / MSE.
 *
 * Settings (storage/app_settings.json key "playback", Settings › Cameras &
 * RTSP › Violation playback):
 *   enabled      bool, default false
 *   preset       hikvision | dahua | custom
 *   template     URL template (custom only; presets use PRESETS)
 *   pre_sec      seconds before the detection (default 15)
 *   post_sec     seconds after it (default 15); pre + post ≤ MAX_SPAN
 *   tz           time zone the recorder expects in the URL: "local" (the
 *                site's APP_TZ, Malaysia time), "UTC" or "+08:00"-style
 *   skew_sec     recorder clock minus true time (NVR clock drift), seconds
 *   host         recorder host[:port]; blank = each camera's own RTSP host
 *   user / pass  recorder login; blank = the camera RTSP source's login
 *   cameras      {stream → {channel, host, template}} per-camera overrides
 *
 * Template placeholders: {host} {user} {pass} {channel} {stream}
 * {start:FMT} {end:FMT} — FMT is a PHP date() format, rendered in `tz`
 * (e.g. {start:Ymd\THis\Z} → 20260706T160126Z). When the rendered URL has no
 * user:pass@ part, the login is inserted, so presets never carry credentials.
 * Credentials never leave the server (only masked URLs are returned).
 */
final class Playback
{
    public const PRESETS = [
        'hikvision' => 'rtsp://{host}/Streaming/tracks/{channel}01?starttime={start:Ymd\THis\Z}&endtime={end:Ymd\THis\Z}',
        'dahua'     => 'rtsp://{host}/cam/playback?channel={channel}&starttime={start:Y_m_d_H_i_s}&endtime={end:Y_m_d_H_i_s}',
    ];
    public const PRE_DEFAULT  = 15;
    public const POST_DEFAULT = 15;
    /** Hard cap of one clip (seconds of video) — a clip holds a PHP worker for its length. */
    public const MAX_SPAN = 90;
    /** Each side at most this long. */
    public const MAX_SIDE = 60;

    private const PLACEHOLDER = '/\{(host|user|pass|channel|stream|start|end)(?::([^{}]{1,40}))?\}/';
    private const DEFAULT_FMT = 'Ymd\THis\Z';

    // ── settings ─────────────────────────────────────────────

    public static function defaults(): array
    {
        return [
            'enabled'  => false,
            'preset'   => 'hikvision',
            'template' => '',
            'pre_sec'  => self::PRE_DEFAULT,
            'post_sec' => self::POST_DEFAULT,
            'tz'       => 'local',
            'skew_sec' => 0,
            'host'     => '',
            'user'     => '',
            'pass'     => '',
            'cameras'  => [],
        ];
    }

    /** Effective settings from app_settings.json (config.php → $config['playback']). */
    public static function configFrom(array $app): array
    {
        $p = is_array($app['playback'] ?? null) ? $app['playback'] : [];
        $d = self::defaults();
        $cfg = [
            'enabled'  => !empty($p['enabled']),
            'preset'   => in_array($p['preset'] ?? '', ['hikvision', 'dahua', 'custom'], true) ? (string) $p['preset'] : $d['preset'],
            'template' => self::cleanTemplate((string) ($p['template'] ?? '')) ?? '',
            'tz'       => self::validTz((string) ($p['tz'] ?? '')) ? (string) $p['tz'] : 'local',
            'skew_sec' => max(-86400, min(86400, (int) ($p['skew_sec'] ?? 0))),
            'host'     => self::cleanHost((string) ($p['host'] ?? '')),
            'user'     => self::cleanCred((string) ($p['user'] ?? '')),
            'pass'     => self::cleanCred((string) ($p['pass'] ?? '')),
            'cameras'  => self::cleanCameras($p['cameras'] ?? []),
        ];
        [$cfg['pre_sec'], $cfg['post_sec']] = self::clampSpan($p['pre_sec'] ?? $d['pre_sec'], $p['post_sec'] ?? $d['post_sec']);
        return $cfg;
    }

    /**
     * POST /settings {playback:{…}} → value to store, or an error message.
     * A blank or masked ('•') password keeps the stored one; pass_clear:true removes it.
     *
     * @return array{0:array,1:?string}
     */
    public static function sanitize(array $in, array $cur): array
    {
        $base = self::configFrom(['playback' => $cur]);
        $out  = $base;
        if (array_key_exists('enabled', $in)) {
            $out['enabled'] = filter_var($in['enabled'], FILTER_VALIDATE_BOOLEAN);
        }
        if (isset($in['preset'])) {
            if (!in_array($in['preset'], ['hikvision', 'dahua', 'custom'], true)) {
                return [$base, 'Playback preset must be hikvision, dahua or custom.'];
            }
            $out['preset'] = (string) $in['preset'];
        }
        if (array_key_exists('template', $in)) {
            $t = self::cleanTemplate((string) $in['template']);
            if ($t === null) {
                return [$base, 'Playback URL template must start with rtsp://, contain {start:…}, and use only {host} {user} {pass} {channel} {stream} {start:…} {end:…}.'];
            }
            $out['template'] = $t;
        }
        if ($out['preset'] === 'custom' && $out['template'] === '') {
            return [$base, 'The custom preset needs a playback URL template.'];
        }
        if (isset($in['pre_sec']) || isset($in['post_sec'])) {
            [$out['pre_sec'], $out['post_sec']] = self::clampSpan($in['pre_sec'] ?? $out['pre_sec'], $in['post_sec'] ?? $out['post_sec']);
        }
        if (isset($in['tz'])) {
            if (!self::validTz((string) $in['tz'])) {
                return [$base, 'Playback time zone must be local, UTC or an offset like +08:00.'];
            }
            $out['tz'] = (string) $in['tz'];
        }
        if (isset($in['skew_sec'])) {
            $out['skew_sec'] = max(-86400, min(86400, (int) $in['skew_sec']));
        }
        if (array_key_exists('host', $in)) {
            $h = trim((string) $in['host']);
            if ($h !== '' && self::cleanHost($h) === '') {
                return [$base, 'Recorder host must be a host name or IP, optionally with :port.'];
            }
            $out['host'] = self::cleanHost($h);
        }
        if (array_key_exists('user', $in)) {
            $out['user'] = self::cleanCred((string) $in['user']);
        }
        if (!empty($in['pass_clear'])) {
            $out['pass'] = '';
        } elseif (isset($in['pass']) && (string) $in['pass'] !== '' && !str_contains((string) $in['pass'], '•')) {
            $out['pass'] = self::cleanCred((string) $in['pass']);
        }
        if (isset($in['cameras']) && is_array($in['cameras'])) {
            foreach ($in['cameras'] as $k => $c) {
                if (is_array($c) && isset($c['template']) && trim((string) $c['template']) !== '' && self::cleanTemplate((string) $c['template']) === null) {
                    return [$base, 'The playback template for camera "' . substr((string) $k, 0, 64) . '" is not valid.'];
                }
                if (is_array($c) && isset($c['host']) && trim((string) $c['host']) !== '' && self::cleanHost((string) $c['host']) === '') {
                    return [$base, 'The recorder host for camera "' . substr((string) $k, 0, 64) . '" is not valid.'];
                }
            }
            $out['cameras'] = self::cleanCameras($in['cameras']);
        }
        return [$out, null];
    }

    /** Settings for the browser: password masked, presets included. */
    public static function publicSettings(array $cfg): array
    {
        $p = (string) ($cfg['pass'] ?? '');
        return [
            'enabled'  => (bool) ($cfg['enabled'] ?? false),
            'preset'   => (string) ($cfg['preset'] ?? 'hikvision'),
            'template' => (string) ($cfg['template'] ?? ''),
            'pre_sec'  => (int) ($cfg['pre_sec'] ?? self::PRE_DEFAULT),
            'post_sec' => (int) ($cfg['post_sec'] ?? self::POST_DEFAULT),
            'tz'       => (string) ($cfg['tz'] ?? 'local'),
            'skew_sec' => (int) ($cfg['skew_sec'] ?? 0),
            'host'     => (string) ($cfg['host'] ?? ''),
            'user'     => (string) ($cfg['user'] ?? ''),
            'pass'     => $p === '' ? '' : str_repeat('•', 8),
            'cameras'  => (object) ($cfg['cameras'] ?? []),
            'presets'  => self::PRESETS,
            'max_span' => self::MAX_SPAN,
        ];
    }

    /** The template in force for a camera (per-camera override, else custom / preset). */
    public static function templateFor(array $cfg, string $stream = ''): string
    {
        $cam = $cfg['cameras'][$stream] ?? [];
        if (!empty($cam['template'])) {
            return (string) $cam['template'];
        }
        $preset = (string) ($cfg['preset'] ?? 'hikvision');
        return $preset === 'custom' ? (string) ($cfg['template'] ?? '') : (self::PRESETS[$preset] ?? '');
    }

    /** @return array{0:int,1:int} pre, post — each 0…MAX_SIDE, sum ≤ MAX_SPAN, sum ≥ 1 */
    public static function clampSpan($pre, $post): array
    {
        $pre  = max(0, min(self::MAX_SIDE, (int) (is_numeric($pre) ? $pre : self::PRE_DEFAULT)));
        $post = max(0, min(self::MAX_SIDE, (int) (is_numeric($post) ? $post : self::POST_DEFAULT)));
        if ($pre + $post > self::MAX_SPAN) {
            $post = self::MAX_SPAN - $pre;
        }
        if ($pre + $post < 1) {
            $post = 1;
        }
        return [$pre, $post];
    }

    // ── time ─────────────────────────────────────────────────

    /**
     * Detection moment of an event row as a Unix timestamp (float, ms kept).
     *
     * trigger_time is SenseStudio's camera-side time ("2026-07-06 16:01:41.372",
     * wall clock without zone = the site's APP_TZ, MYT); received_at is this
     * server's wall clock in APP_TZ. The trigger time wins unless it is
     * implausible against the receive time (later than receipt by > 5 min or
     * earlier by > 6 h — e.g. a SenseStudio clock / zone mismatch), then the
     * receive time is used.
     *
     * @return array{t:float,source:string}|null
     */
    public static function eventTime(array $row, ?string $appTz = null): ?array
    {
        $tz   = new DateTimeZone($appTz ?: date_default_timezone_get());
        $trig = self::parseTime((string) ($row['trigger_time'] ?? ''), $tz);
        $recv = self::parseTime((string) ($row['received_at'] ?? ''), $tz);
        if ($trig !== null && ($recv === null || ($recv - $trig >= -300 && $recv - $trig <= 6 * 3600))) {
            return ['t' => $trig, 'source' => 'trigger'];
        }
        if ($recv !== null) {
            return ['t' => $recv, 'source' => 'received'];
        }
        return null;
    }

    public static function parseTime(string $v, DateTimeZone $tz): ?float
    {
        $v = trim($v);
        if ($v === '' || strlen($v) > 40) {
            return null;
        }
        if (preg_match('/^\d{13}$/', $v)) {
            return (int) $v / 1000;
        }
        if (preg_match('/^\d{10}$/', $v)) {
            return (float) (int) $v;
        }
        if (!preg_match('/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/i', $v)) {
            return null;
        }
        try {
            $d = new DateTimeImmutable($v, $tz);   // an explicit Z / offset in $v wins over $tz
        } catch (Throwable $e) {
            return null;
        }
        return (float) $d->format('U.u');
    }

    /**
     * Clip window around a detection.
     * @return array{start:int,end:int,marker:float,duration:int}  start/end = Unix seconds; marker = detection offset into the clip
     */
    public static function window(float $t, int $pre, int $post): array
    {
        $start = (int) floor($t - $pre);
        $end   = (int) ceil($t + $post);
        return ['start' => $start, 'end' => $end, 'marker' => round($t - $start, 3), 'duration' => $end - $start];
    }

    public static function zoneFor(string $tz, ?string $appTz = null): DateTimeZone
    {
        if ($tz === '' || strtolower($tz) === 'local') {
            return new DateTimeZone($appTz ?: date_default_timezone_get());
        }
        if (strtoupper($tz) === 'UTC') {
            return new DateTimeZone('UTC');
        }
        return new DateTimeZone($tz);
    }

    // ── URL templating ───────────────────────────────────────

    /**
     * Render a template. $vars: host, user, pass, channel, stream. Times are
     * Unix seconds, formatted in $tz. Credentials are URL-encoded; if the
     * result has no userinfo and a user is known, "user:pass@" is inserted.
     */
    public static function render(string $tpl, array $vars, int $start, int $end, DateTimeZone $tz): string
    {
        $url = (string) preg_replace_callback(self::PLACEHOLDER, static function (array $m) use ($vars, $start, $end, $tz): string {
            $k = $m[1];
            if ($k === 'start' || $k === 'end') {
                $fmt = isset($m[2]) && $m[2] !== '' ? $m[2] : self::DEFAULT_FMT;
                return (new DateTimeImmutable('@' . ($k === 'start' ? $start : $end)))->setTimezone($tz)->format($fmt);
            }
            $v = (string) ($vars[$k] ?? '');
            return in_array($k, ['user', 'pass', 'stream'], true) ? rawurlencode($v) : $v;
        }, $tpl);
        $user = (string) ($vars['user'] ?? '');
        if ($user !== '' && !preg_match('~^rtsp://[^/@?#]+@~i', $url)) {
            $url = (string) preg_replace('~^rtsp://~i', 'rtsp://' . rawurlencode($user) . ':' . rawurlencode((string) ($vars['pass'] ?? '')) . '@', $url, 1);
        }
        return $url;
    }

    /** Recorder channel implied by a camera's live RTSP URL (Hikvision …/Channels/101 → 1, Dahua channel=3 → 3). */
    public static function channelOf(string $src): string
    {
        $p = parse_url(trim($src));
        if (!is_array($p)) {
            return '1';
        }
        if (preg_match('~/Streaming/Channels/(\d{1,5})~i', (string) ($p['path'] ?? ''), $m)) {
            $n = (int) $m[1];
            return (string) max(1, $n >= 100 ? intdiv($n, 100) : $n);
        }
        parse_str((string) ($p['query'] ?? ''), $q);
        if (isset($q['channel']) && ctype_digit((string) $q['channel'])) {
            return (string) max(1, (int) $q['channel']);
        }
        return '1';
    }

    /** host[:port] of an RTSP URL ('' when unparsable). */
    public static function hostOf(string $src): string
    {
        $p = parse_url(trim($src));
        if (!is_array($p) || empty($p['host'])) {
            return '';
        }
        $h = (string) $p['host'];
        return $h . (isset($p['port']) ? ':' . (int) $p['port'] : '');
    }

    // ── camera + clip resolution ─────────────────────────────

    /**
     * The live RTSP source of an event's camera (stream label / serial).
     * @return array{name:string,src:string,label:string}|null
     */
    public static function cameraFor(array $config, array $row, ?array $fleet = null): ?array
    {
        $fleet = $fleet ?? LiveBridge::fleetRows($config, false);
        $stream = trim((string) ($row['stream'] ?? ''));
        $serial = trim((string) ($row['device_serial'] ?? ''));
        $cands = array_values(array_unique(array_filter([
            $stream, strtolower($stream), LiveBridge::label($stream), LiveBridge::label($serial),
        ], static fn ($v) => $v !== '')));
        $desired = LiveBridge::desired($config, $fleet);
        $ok = static fn ($d): bool => is_array($d) && empty($d['direct']) && preg_match('~^rtsp://~i', (string) ($d['src'] ?? '')) === 1;
        foreach ($cands as $c) {
            if (isset($desired[$c]) && $ok($desired[$c])) {
                return ['name' => $c, 'src' => (string) $desired[$c]['src'], 'label' => (string) ($desired[$c]['fleetName'] ?? '')];
            }
        }
        // Fleet row matched by serial (stream label may differ from the push's).
        if ($serial !== '') {
            foreach ($fleet as $r) {
                if (is_array($r) && strcasecmp((string) ($r['serial'] ?? ''), $serial) === 0) {
                    $name = (string) ($r['stream'] ?? '') ?: LiveBridge::label($serial);
                    if (isset($desired[$name]) && $ok($desired[$name])) {
                        return ['name' => $name, 'src' => (string) $desired[$name]['src'], 'label' => (string) ($r['name'] ?? '')];
                    }
                }
            }
        }
        // No live source, but a per-camera recorder mapping exists.
        $pb = $config['playback'] ?? [];
        foreach ($cands as $c) {
            if (isset($pb['cameras'][$c])) {
                return ['name' => $c, 'src' => '', 'label' => ''];
            }
        }
        return null;
    }

    /**
     * Resolve everything needed to play a detection: the window and the
     * recorder URL. Never throws; 'available' false carries a plain reason.
     *
     * @param array $row  events row (stream, device_serial, trigger_time, received_at, …)
     */
    public static function plan(array $config, array $row, ?int $pre = null, ?int $post = null, ?float $now = null): array
    {
        $pb    = $config['playback'] ?? self::configFrom([]);
        $appTz = (string) ($config['app']['tz'] ?? date_default_timezone_get());
        [$pre, $post] = self::clampSpan($pre ?? $pb['pre_sec'], $post ?? $pb['post_sec']);
        $out = ['available' => false, 'reason' => '', 'pre' => $pre, 'post' => $post, 'camera' => null,
                'start' => null, 'end' => null, 'marker' => null, 'duration' => null, 'event_time' => null,
                'time_source' => null, 'retry_after' => 0, 'url' => '', 'masked' => ''];

        $et = self::eventTime($row, $appTz);
        if ($et !== null) {
            $w = self::window($et['t'], $pre, $post);
            $z = new DateTimeZone($appTz);
            $fmt = static fn (float $ts): string => (new DateTimeImmutable('@' . sprintf('%.3F', $ts)))->setTimezone($z)->format('Y-m-d\TH:i:s.vP');
            $out = array_merge($out, ['start' => $fmt($w['start']), 'end' => $fmt($w['end']), 'marker' => $w['marker'],
                'duration' => $w['duration'], 'event_time' => $fmt($et['t']), 'time_source' => $et['source']]);
        }

        $cam = self::cameraFor($config, $row);
        if ($cam !== null) {
            $out['camera'] = ['stream' => $cam['name'], 'name' => $cam['label']];
        }
        if (empty($pb['enabled'])) {
            $out['reason'] = 'Video playback is not set up. An administrator can turn it on under Settings › Cameras & RTSP › Violation playback.';
            return $out;
        }
        if ($et === null) {
            $out['reason'] = 'This detection has no usable time stamp.';
            return $out;
        }
        if ($cam === null) {
            $label = (string) (($row['stream'] ?? '') ?: ($row['device_serial'] ?? '') ?: 'unknown');
            $out['reason'] = 'Camera ' . strtoupper($label) . ' has no RTSP source or recorder mapping on this site.';
            return $out;
        }
        $tpl = self::templateFor($pb, $cam['name']);
        if ($tpl === '') {
            $out['reason'] = 'No playback URL template is configured.';
            return $out;
        }
        $over = $pb['cameras'][$cam['name']] ?? [];
        $host = (string) (($over['host'] ?? '') ?: ($pb['host'] ?? '') ?: self::hostOf($cam['src']));
        if ($host === '') {
            $out['reason'] = 'No recorder address is known for this camera — set the recorder host in Settings.';
            return $out;
        }
        $srcP = $cam['src'] !== '' ? (parse_url($cam['src']) ?: []) : [];
        $user = (string) ($pb['user'] ?? '') !== '' ? (string) $pb['user'] : rawurldecode((string) ($srcP['user'] ?? ''));
        $pass = (string) ($pb['user'] ?? '') !== '' ? (string) ($pb['pass'] ?? '') : rawurldecode((string) ($srcP['pass'] ?? ''));
        $chan = (string) (($over['channel'] ?? '') ?: ($cam['src'] !== '' ? self::channelOf($cam['src']) : '1'));

        $skew = (int) ($pb['skew_sec'] ?? 0);
        $w    = self::window($et['t'], $pre, $post);
        try {
            $url = self::render($tpl, ['host' => $host, 'user' => $user, 'pass' => $pass, 'channel' => $chan, 'stream' => $cam['name']],
                $w['start'] + $skew, $w['end'] + $skew, self::zoneFor((string) ($pb['tz'] ?? 'local'), $appTz));
        } catch (Throwable $e) {
            $out['reason'] = 'The playback URL template could not be rendered.';
            return $out;
        }
        $p = parse_url($url);
        if (!is_array($p) || strtolower((string) ($p['scheme'] ?? '')) !== 'rtsp' || empty($p['host'])) {
            $out['reason'] = 'The playback URL template does not produce an rtsp:// URL.';
            return $out;
        }
        $out['url']    = $url;
        $out['masked'] = LiveBridge::mask($url);
        // The recorder has not written the "after" part yet: tell the client when to come back.
        $now = $now ?? microtime(true);
        if ($w['end'] > $now - 5) {
            $out['retry_after'] = (int) ceil($w['end'] - $now + 5);
            $out['reason'] = 'The recording after the detection is still being written — ready in about ' . $out['retry_after'] . ' s.';
            return $out;
        }
        $out['available'] = true;
        return $out;
    }

    /** Recorder / relay error → a sentence an operator understands. */
    public static function reason(string $err): string
    {
        $e = trim($err);
        $map = [
            '~Cannot reach camera RTSP port~i'          => 'The recorder cannot be reached from the web server on its RTSP port (firewall / port forwarding / wrong address).',
            '~rejected the credentials|RTSP 401|RTSP 403~i' => 'The recorder refused the login — check the recorder user and password.',
            '~DESCRIBE failed: RTSP 404|RTSP 454~i'      => 'The recorder has no recording for this time (recording off, overwritten, or a wrong channel / playback path).',
            '~RTSP 400|RTSP 451|RTSP 457|RTSP 459~i'     => 'The recorder did not accept the playback request (check the preset / URL template and time zone).',
            '~RTSP 453|RTSP 503|RTSP 5\d\d~i'            => 'The recorder is busy or out of playback bandwidth — try again in a minute.',
            '~H\.265~i'                                  => 'This recording is H.265 — browsers need H.264. Set the camera / recorder to record in H.264.',
            '~No H\.264 video track~i'                   => 'The recording has no H.264 video track the browser can play.',
            '~stopped sending video|connection closed~i' => 'The recorder sent no video for this time span (nothing recorded, or the clip has expired).',
            '~Not an rtsp~i'                             => 'The playback URL is not a valid rtsp:// address.',
            '~Bad RTSP reply|no RTSP session~i'          => 'The recorder answered with something that is not RTSP playback.',
        ];
        foreach ($map as $re => $msg) {
            if (preg_match($re, $e)) {
                return $msg;
            }
        }
        return $e !== '' ? 'Recorder error: ' . $e : 'The recorder sent no video.';
    }

    /**
     * Pull one recording through RtspRelay and pass each frame record to
     * $out(string): bool (false = viewer left). Stops after $spanMs of video
     * (by RTP time), when the recorder ends, or after $wallMax seconds.
     *
     * @param callable|null $relayFactory fn(string $url): object with run() — tests inject a fake
     * @return array{frames:int,bytes:int,media_ms:int,error:string,ended:string}
     */
    public static function pull(string $url, int $spanMs, callable $out, int $wallMax, ?callable $tick = null, ?callable $relayFactory = null): array
    {
        $relay  = $relayFactory ? $relayFactory($url) : new RtspRelay($url, ['playback' => true]);
        $frames = 0;
        $bytes  = 0;
        $media  = 0;
        $left   = false;
        $res = $relay->run(static function (string $au, int $dur, bool $key) use (&$frames, &$bytes, &$media, &$left, $out, $spanMs, $tick): bool {
            $rec = RtspRelay::record($au, $dur);
            if (!$out($rec)) {
                $left = true;
                return false;
            }
            $frames++;
            $bytes += strlen($rec);
            $media += $dur;
            if ($tick) {
                $tick();
            }
            return $media < $spanMs;
        }, max(5, $wallMax), 8);
        $err = (string) ($res['error'] ?? '');
        return [
            'frames'   => $frames,
            'bytes'    => $bytes,
            'media_ms' => $media,
            // After frames, a closed / silent connection is the recorder ending the clip.
            'error'    => $frames > 0 ? '' : $err,
            'ended'    => $left ? 'viewer-left' : ($media >= $spanMs ? 'span-done' : ($frames > 0 ? 'recorder-ended' : 'failed')),
        ];
    }

    // ── validation helpers ───────────────────────────────────

    /** Normalised template, '' for empty, null when invalid. */
    public static function cleanTemplate(string $t): ?string
    {
        $t = trim($t);
        if ($t === '') {
            return '';
        }
        if (strlen($t) > 600 || preg_match('/[\s\x00-\x1F\x7F]/', $t) || !preg_match('~^rtsp://~i', $t)
            || strpos($t, '{start') === false) {
            return null;
        }
        // Every {…} must be a known placeholder.
        $rest = (string) preg_replace(self::PLACEHOLDER, '', $t);
        if (strpos($rest, '{') !== false || strpos($rest, '}') !== false) {
            return null;
        }
        return $t;
    }

    public static function validTz(string $tz): bool
    {
        return $tz === 'local' || strtoupper($tz) === 'UTC' || (bool) preg_match('/^[+-](0\d|1[0-4]):[0-5]\d$/', $tz);
    }

    private static function cleanHost(string $h): string
    {
        $h = trim($h);
        return ($h !== '' && strlen($h) <= 255 && preg_match('/^(\[[0-9a-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/i', $h)) ? $h : '';
    }

    private static function cleanCred(string $s): string
    {
        return substr((string) preg_replace('/[\x00-\x1F\x7F]/', '', trim($s)), 0, 128);
    }

    private static function cleanCameras($in): array
    {
        $out = [];
        if (!is_array($in)) {
            return $out;
        }
        foreach (array_slice($in, 0, 200, true) as $k => $c) {
            $k = strtolower((string) preg_replace('/[^a-z0-9_.-]+/i', '', substr(trim((string) $k), 0, 64)));
            if ($k === '' || !is_array($c)) {
                continue;
            }
            $ch = trim((string) ($c['channel'] ?? ''));
            $row = [
                'channel'  => preg_match('/^\d{1,4}$/', $ch) ? $ch : '',
                'host'     => self::cleanHost((string) ($c['host'] ?? '')),
                'template' => self::cleanTemplate((string) ($c['template'] ?? '')) ?? '',
            ];
            if ($row['channel'] !== '' || $row['host'] !== '' || $row['template'] !== '') {
                $out[$k] = $row;
            }
        }
        return $out;
    }
}
