<?php
/**
 * Network / stream load test (scoring-matrix criterion 34, tests INF-01, INF-02).
 *
 * From the dashboard server's vantage point, for the SenseStudio API, the
 * live-video bridge and every live source:
 *   · TCP connect latency — N = 5 attempts; failed attempts out of N are the
 *     packet-loss proxy (no raw ICMP from PHP)
 *   · RTSP OPTIONS handshake (rtsp:// sources) — is a media server answering
 *   · HTTP time-to-first-byte (API / bridge / HLS playlist)
 *   · download throughput of one short media sample (≤ 3 s, ≤ 2 MB): an HLS
 *     segment, or a go2rtc MP4 sample of a bridged stream
 * and grades each against pass / warn thresholds.
 */

declare(strict_types=1);

require_once __DIR__ . '/LiveBridge.php';

final class NetTest
{
    public const ATTEMPTS = 5;
    public const SAMPLE_SECONDS = 3;
    public const SAMPLE_BYTES = 2 * 1024 * 1024;
    public const MAX_SOURCES = 16;
    public const MAX_THROUGHPUT = 3;

    /** [pass ≤, warn ≤] in ms; above warn = fail. */
    public const TH = [
        'tcp_ms'   => [100, 300],
        'ttfb_ms'  => [500, 1500],
        'loss_pct' => [0, 20],
        // Mbps: pass ≥ 4 (1080p H.264 main stream), warn ≥ 1.5 (720p / sub-stream)
        'mbps'     => [4.0, 1.5],
    ];

    private array $config;
    private float $deadline;

    public function __construct(array $config, int $budgetSeconds = 45)
    {
        $this->config   = $config;
        $this->deadline = microtime(true) + $budgetSeconds;
    }

    private function timeLeft(): float
    {
        return $this->deadline - microtime(true);
    }

    public static function grade(string $metric, ?float $v): string
    {
        if ($v === null) {
            return 'na';
        }
        [$p, $w] = self::TH[$metric];
        if ($metric === 'mbps') {
            return $v >= $p ? 'pass' : ($v >= $w ? 'warn' : 'fail');
        }
        return $v <= $p ? 'pass' : ($v <= $w ? 'warn' : 'fail');
    }

    private static function worst(array $grades): string
    {
        $rank = ['fail' => 3, 'warn' => 2, 'pass' => 1, 'na' => 0];
        $w = 'na';
        foreach ($grades as $g) {
            if (($rank[$g] ?? 0) > $rank[$w]) {
                $w = $g;
            }
        }
        return $w;
    }

    /** Parse host / port from a URL (rtsp default 554, https 443, http 80). */
    public static function endpoint(string $url): ?array
    {
        $p = parse_url(trim(explode('#', $url, 2)[0]));
        if (!$p || empty($p['host'])) {
            return null;
        }
        $scheme = strtolower((string) ($p['scheme'] ?? 'http'));
        $def = ['rtsp' => 554, 'rtsps' => 322, 'https' => 443, 'http' => 80, 'rtmp' => 1935][$scheme] ?? 80;
        return ['scheme' => $scheme, 'host' => (string) $p['host'], 'port' => (int) ($p['port'] ?? $def)];
    }

    /** N TCP connects. */
    public function tcp(string $host, int $port, int $n = self::ATTEMPTS): array
    {
        $times = [];
        $fail = 0;
        $err = '';
        for ($i = 0; $i < $n; $i++) {
            if ($this->timeLeft() < 1) {
                break;
            }
            $t0 = microtime(true);
            $s = @fsockopen($host, $port, $errno, $errstr, 1.5);
            if ($s) {
                $times[] = (microtime(true) - $t0) * 1000;
                fclose($s);
            } else {
                $fail++;
                $err = $errstr ?: ('error ' . $errno);
            }
        }
        $done = count($times) + $fail;
        $avg = $times ? round(array_sum($times) / count($times), 1) : null;
        $jit = null;
        if (count($times) > 1) {
            $d = [];
            for ($i = 1; $i < count($times); $i++) {
                $d[] = abs($times[$i] - $times[$i - 1]);
            }
            $jit = round(array_sum($d) / count($d), 1);
        }
        return ['attempts' => $done, 'failed' => $fail, 'loss_pct' => $done ? round(100 * $fail / $done, 1) : null,
                'avg_ms' => $avg, 'min_ms' => $times ? round(min($times), 1) : null, 'max_ms' => $times ? round(max($times), 1) : null,
                'jitter_ms' => $jit, 'error' => $fail ? $err : ''];
    }

    /** RTSP OPTIONS — any "RTSP/1.0 nnn" reply (incl. 401) proves a media server answers. */
    public function rtspOptions(string $host, int $port, string $url): array
    {
        $s = @fsockopen($host, $port, $errno, $errstr, 2.0);
        if (!$s) {
            return ['ok' => false, 'status' => '', 'error' => $errstr ?: 'connect failed'];
        }
        stream_set_timeout($s, 2);
        $clean = (string) preg_replace('~//[^/@]+@~', '//', explode('#', $url, 2)[0]);
        $t0 = microtime(true);
        fwrite($s, "OPTIONS {$clean} RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: KianJoo-VisionAI-NetTest\r\n\r\n");
        $line = (string) fgets($s, 256);
        fclose($s);
        $ok = (bool) preg_match('~^RTSP/1\.\d\s+(\d{3})~', $line, $m);
        return ['ok' => $ok, 'status' => $ok ? $m[1] : '', 'ms' => round((microtime(true) - $t0) * 1000, 1),
                'error' => $ok ? '' : 'no RTSP reply'];
    }

    /** HTTP GET timing (TTFB) with an optional byte/time-capped body read. */
    public function http(string $url, array $opt = []): array
    {
        if (!function_exists('curl_init')) {
            return ['ok' => false, 'error' => 'PHP curl missing'];
        }
        $maxBytes = (int) ($opt['max_bytes'] ?? 65536);
        $timeout  = (float) ($opt['timeout'] ?? 5);
        $timeout  = max(1.0, min($timeout, $this->timeLeft()));
        $buf = '';
        $bytes = 0;
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => false, CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 3,
            CURLOPT_CONNECTTIMEOUT_MS => (int) (min(3, $timeout) * 1000), CURLOPT_TIMEOUT_MS => (int) ($timeout * 1000),
            CURLOPT_USERAGENT => 'KianJoo-VisionAI-NetTest/1.0', CURLOPT_NOSIGNAL => true,
            CURLOPT_SSL_VERIFYPEER => !empty($opt['verify']),
            CURLOPT_WRITEFUNCTION => static function ($ch, $chunk) use (&$buf, &$bytes, $maxBytes, $opt) {
                $bytes += strlen($chunk);
                if (!empty($opt['keep']) && strlen($buf) < 262144) {
                    $buf .= $chunk;
                }
                return $bytes > $maxBytes ? 0 : strlen($chunk);   // 0 aborts once the cap is hit
            },
        ]);
        if (($opt['user'] ?? '') !== '') {
            curl_setopt($ch, CURLOPT_HTTPAUTH, CURLAUTH_BASIC);
            curl_setopt($ch, CURLOPT_USERPWD, $opt['user'] . ':' . ($opt['pass'] ?? ''));
        }
        curl_exec($ch);
        $errno = curl_errno($ch);
        $err   = curl_error($ch);
        $code  = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $ttfb  = (float) curl_getinfo($ch, CURLINFO_STARTTRANSFER_TIME);
        $conn  = (float) curl_getinfo($ch, CURLINFO_CONNECT_TIME);
        $total = (float) curl_getinfo($ch, CURLINFO_TOTAL_TIME);
        curl_close($ch);
        // 23 = write aborted (byte cap), 28 = timeout (time cap) — both fine once data flowed.
        $capped = in_array($errno, [23, 28], true) && $bytes > 0;
        $ok = ($errno === 0 || $capped) && $code > 0 && $code < 400;
        $xfer = max(0.001, $total - $ttfb);
        return [
            'ok' => $ok, 'code' => $code, 'ttfb_ms' => $code ? round($ttfb * 1000, 1) : null, 'connect_ms' => $conn ? round($conn * 1000, 1) : null,
            'bytes' => $bytes, 'seconds' => round($total, 2),
            'mbps' => ($bytes > 32768 && $ok) ? round($bytes * 8 / $xfer / 1e6, 2) : null,
            'error' => $ok ? '' : ($err !== '' ? $err : ($code ? 'HTTP ' . $code : 'no response')),
            'body' => $buf,
        ];
    }

    /** First media segment URL of an HLS playlist (follows one master → variant hop). */
    private function hlsSegment(string $url, int $depth = 0): ?string
    {
        $r = $this->http($url, ['keep' => true, 'max_bytes' => 262144, 'timeout' => 4]);
        if (!$r['ok'] || $r['body'] === '') {
            return null;
        }
        foreach (preg_split('/\r?\n/', $r['body']) ?: [] as $line) {
            $line = trim($line);
            if ($line === '' || $line[0] === '#') {
                continue;
            }
            $abs = preg_match('~^https?://~i', $line) ? $line : self::resolve($url, $line);
            if ($depth === 0 && preg_match('/\.m3u8(\?|$)/i', $line)) {
                return $this->hlsSegment($abs, 1);
            }
            return $abs;
        }
        return null;
    }

    private static function resolve(string $base, string $rel): string
    {
        if (str_starts_with($rel, '/')) {
            $p = parse_url($base);
            return $p['scheme'] . '://' . $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '') . $rel;
        }
        $q = explode('?', $base, 2)[0];
        return substr($q, 0, (int) strrpos($q, '/') + 1) . $rel;
    }

    // ── Runner ───────────────────────────────────────────────

    /** Run everything (or one stream). Returns rows for the table. */
    public function run(?string $only = null): array
    {
        $rows = [];
        $live = $this->config['live'] ?? [];

        if ($only === null) {
            // SenseStudio API (AI box / platform).
            $base = (string) ($this->config['sense_api']['base'] ?? '');
            if ($base !== '') {
                $rows[] = $this->target('SenseStudio API', 'api', $base, ['http' => $base]);
            }
            // Live bridge API.
            $lb = new LiveBridge($live);
            if ($lb->apiBase() !== '') {
                $u = $lb->apiBase() . '/api' . (($live['stream_token'] ?? '') !== '' ? '?token=' . rawurlencode((string) $live['stream_token']) : '');
                $rows[] = $this->target('Live video bridge (go2rtc)', 'bridge', $lb->apiBase(),
                    ['http' => $u, 'user' => (string) ($live['api_user'] ?? ''), 'pass' => (string) ($live['api_pass'] ?? '')]);
            }
        }

        // Live sources: RTSP map + fleet RTSP (cached, no network).
        $sources = [];
        try {
            foreach (LiveBridge::desired($this->config, LiveBridge::fleetRows($this->config, false)) as $name => $d) {
                $sources[(string) $name] = (string) ($d['src'] ?? '');
            }
        } catch (Throwable $e) {
            foreach (($live['rtsp'] ?? []) as $name => $src) {
                $sources[(string) $name] = (string) $src;
            }
        }
        $registered = array_flip((array) (LiveBridge::cached($this->config)['streams'] ?? []));
        $tp = 0;
        foreach ($sources as $name => $src) {
            if ($only !== null && $name !== $only) {
                continue;
            }
            if (count($rows) >= self::MAX_SOURCES + 2 || $this->timeLeft() < 3) {
                $rows[] = ['name' => $name, 'kind' => 'skipped', 'target' => LiveBridge::mask($src), 'overall' => 'na',
                           'note' => 'Skipped — test time budget used up; run it for this stream alone.'];
                continue;
            }
            $want = ['rtsp' => $src];
            $isDirect = LiveBridge::isDirect($src);
            if ($isDirect) {
                $want = ['hls' => $src];
            } elseif (($tp < self::MAX_THROUGHPUT || $only !== null) && (isset($registered[$name]) || $only !== null) && (new LiveBridge($live))->apiBase() !== '') {
                $want['bridge_sample'] = $name;
                $tp++;
            }
            $rows[] = $this->target($name, $isDirect ? 'hls' : 'camera', $src, $want);
        }
        $summary = ['pass' => 0, 'warn' => 0, 'fail' => 0, 'na' => 0];
        foreach ($rows as $r) {
            $summary[$r['overall']]++;
        }
        return ['at' => date('c'), 'rows' => $rows, 'summary' => $summary, 'thresholds' => self::TH,
                'attempts' => self::ATTEMPTS, 'sample' => ['seconds' => self::SAMPLE_SECONDS, 'bytes' => self::SAMPLE_BYTES]];
    }

    private function target(string $name, string $kind, string $url, array $what): array
    {
        $ep  = self::endpoint($url);
        $row = ['name' => $name, 'kind' => $kind, 'target' => LiveBridge::mask($url), 'host' => $ep ? $ep['host'] . ':' . $ep['port'] : '',
                'tcp_ms' => null, 'loss_pct' => null, 'jitter_ms' => null, 'ttfb_ms' => null, 'mbps' => null, 'rtsp' => '', 'note' => ''];
        $grades = [];
        if (!$ep) {
            $row['note'] = 'Not a network URL (e.g. ffmpeg:/exec: source) — not testable from here.';
            $row['overall'] = 'na';
            return $row + ['grades' => []];
        }
        $t = $this->tcp($ep['host'], $ep['port']);
        $row['tcp_ms'] = $t['avg_ms'];
        $row['loss_pct'] = $t['loss_pct'];
        $row['jitter_ms'] = $t['jitter_ms'];
        $grades['tcp_ms'] = $t['avg_ms'] === null ? 'fail' : self::grade('tcp_ms', $t['avg_ms']);
        $grades['loss_pct'] = self::grade('loss_pct', $t['loss_pct']);
        $notes = [];
        if ($t['error'] !== '') {
            $notes[] = $t['failed'] . '/' . $t['attempts'] . ' connects failed: ' . $t['error'];
        }
        if (isset($what['rtsp']) && in_array($ep['scheme'], ['rtsp', 'rtsps'], true) && $t['avg_ms'] !== null && $this->timeLeft() > 3) {
            $o = $this->rtspOptions($ep['host'], $ep['port'], $what['rtsp']);
            $row['rtsp'] = $o['ok'] ? ('RTSP ' . $o['status']) : 'no RTSP reply';
            if (!$o['ok']) {
                $grades['rtsp'] = 'warn';
            }
        }
        if (isset($what['http'])) {
            $h = $this->http($what['http'], ['user' => $what['user'] ?? '', 'pass' => $what['pass'] ?? '', 'timeout' => 5]);
            $row['ttfb_ms'] = $h['ttfb_ms'];
            $grades['ttfb_ms'] = $h['ttfb_ms'] === null ? 'fail' : self::grade('ttfb_ms', $h['ttfb_ms']);
            if ($h['code'] >= 400 || $h['error'] !== '') {
                $notes[] = $h['error'];
            }
        }
        if (isset($what['hls']) && $this->timeLeft() > 5) {
            $h = $this->http($what['hls'], ['timeout' => 4]);
            $row['ttfb_ms'] = $h['ttfb_ms'];
            $grades['ttfb_ms'] = $h['ttfb_ms'] === null ? 'fail' : self::grade('ttfb_ms', $h['ttfb_ms']);
            $seg = $h['ok'] ? $this->hlsSegment($what['hls']) : null;
            if ($seg) {
                $s = $this->http($seg, ['max_bytes' => self::SAMPLE_BYTES, 'timeout' => self::SAMPLE_SECONDS]);
                $row['mbps'] = $s['mbps'];
                $grades['mbps'] = self::grade('mbps', $s['mbps']);
                $notes[] = 'segment ' . round($s['bytes'] / 1024) . ' KB in ' . $s['seconds'] . ' s';
            } else {
                $notes[] = 'HLS playlist unreadable' . ($h['error'] ? ': ' . $h['error'] : '');
                $grades['mbps'] = 'fail';
            }
        }
        if (isset($what['bridge_sample']) && $this->timeLeft() > self::SAMPLE_SECONDS + 1) {
            $live = $this->config['live'] ?? [];
            $lb = new LiveBridge($live);
            $q = ['src' => $what['bridge_sample']];
            if (($live['stream_token'] ?? '') !== '') {
                $q['token'] = (string) $live['stream_token'];
            }
            $s = $this->http($lb->apiBase() . '/api/stream.mp4?' . http_build_query($q),
                ['max_bytes' => self::SAMPLE_BYTES, 'timeout' => self::SAMPLE_SECONDS, 'user' => (string) ($live['api_user'] ?? ''), 'pass' => (string) ($live['api_pass'] ?? '')]);
            $row['mbps'] = $s['mbps'];
            $row['ttfb_ms'] = $s['ttfb_ms'];
            $grades['ttfb_ms'] = $s['ttfb_ms'] === null ? 'fail' : self::grade('ttfb_ms', $s['ttfb_ms']);
            $grades['mbps'] = $s['ok'] ? self::grade('mbps', $s['mbps']) : 'fail';
            $notes[] = $s['ok'] ? ('bridge MP4 sample ' . round($s['bytes'] / 1024) . ' KB in ' . $s['seconds'] . ' s (TTFB includes the camera handshake)')
                                : ('bridge sample failed: ' . $s['error']);
        }
        $row['note'] = implode(' · ', array_filter($notes));
        $row['grades'] = $grades;
        $row['overall'] = self::worst($grades);
        return $row;
    }
}
