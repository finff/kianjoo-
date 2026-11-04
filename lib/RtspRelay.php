<?php

declare(strict_types=1);

/**
 * Live video without a bridge: pull a camera's RTSP feed (RTP over the RTSP
 * TCP connection) and pass its H.264 frames to the browser unchanged.
 *
 * The web host cannot run go2rtc/ffmpeg, but PHP can speak RTSP. No video is
 * decoded or transcoded here: RTP packets are depacketised (RFC 6184: single
 * NAL, STAP-A, FU-A) into Annex-B access units and written as a binary record
 * stream that the dashboard feeds to Media Source Extensions (jmuxer).
 *
 * Record format (little endian), one per access unit / frame:
 *   u32 payload length · u32 duration in ms · payload (Annex-B H.264)
 *
 * Camera credentials stay on the server. Supports Digest and Basic auth.
 */
final class RtspRelay
{
    private const UA = 'KianJooVisionAI-Relay/1.0';

    /** @var resource|null */
    private $sock = null;
    private int $cseq = 0;
    private string $session = '';
    private string $authHeader = '';
    private array $digest = [];
    private string $buf = '';

    private string $url;     // RTSP URL without credentials
    private string $user;
    private string $pass;
    private string $host;
    private int $port;

    public function __construct(string $rtspUrl)
    {
        $p = parse_url(trim($rtspUrl));
        if (!is_array($p) || strtolower((string) ($p['scheme'] ?? '')) !== 'rtsp' || empty($p['host'])) {
            throw new InvalidArgumentException('Not an rtsp:// URL');
        }
        $this->host = (string) $p['host'];
        $this->port = (int) ($p['port'] ?? 554);
        $this->user = rawurldecode((string) ($p['user'] ?? ''));
        $this->pass = rawurldecode((string) ($p['pass'] ?? ''));
        $this->url  = 'rtsp://' . $this->host . ':' . $this->port . ($p['path'] ?? '/')
            . (isset($p['query']) ? '?' . $p['query'] : '');
    }

    /**
     * Stream frames to $emit(string $annexB, int $durationMs, bool $keyframe): bool until
     * $maxSeconds pass, the camera stops, or $emit returns false.
     *
     * @return array{frames:int,bytes:int,error:string}
     */
    public function run(callable $emit, int $maxSeconds = 280, int $timeout = 6): array
    {
        $frames = 0;
        $bytes  = 0;
        try {
            $this->connect($timeout);
            $desc = $this->request('DESCRIBE', $this->url, ['Accept' => 'application/sdp']);
            [$control, $sps, $pps] = $this->parseSdp($desc['body'], $desc['headers']['content-base'] ?? $this->url);
            $setup = $this->request('SETUP', $control, ['Transport' => 'RTP/AVP/TCP;unicast;interleaved=0-1']);
            $this->session = trim(explode(';', (string) ($setup['headers']['session'] ?? ''))[0]);
            if ($this->session === '') {
                throw new RuntimeException('Camera returned no RTSP session');
            }
            $this->request('PLAY', $this->baseOf($control), ['Range' => 'npt=0.000-']);

            $start     = microtime(true);
            $keepAlive = $start;
            $au        = '';          // access unit being assembled
            $fu        = '';          // FU-A NAL being assembled
            $lastTs    = null;
            $haveIdr   = false;       // decoders need a keyframe first
            $paramSets = ($sps !== '' ? "\x00\x00\x00\x01" . $sps : '') . ($pps !== '' ? "\x00\x00\x00\x01" . $pps : '');
            $nal = static function (string $n) use (&$au, &$sps, &$pps): void {
                $t = ord($n[0]) & 0x1F;
                if ($t === 7) { $sps = $n; }
                if ($t === 8) { $pps = $n; }
                $au .= "\x00\x00\x00\x01" . $n;
            };

            while (microtime(true) - $start < $maxSeconds) {
                // RTSP sessions expire without traffic on the control channel.
                if (microtime(true) - $keepAlive > 20) {
                    $this->send('GET_PARAMETER', $this->baseOf($control), []);
                    $keepAlive = microtime(true);
                }
                $pkt = $this->readInterleaved($timeout);
                if ($pkt === null) {
                    continue;                     // an RTSP reply (keep-alive) was consumed
                }
                [$channel, $rtp] = $pkt;
                if ($channel !== 0 || strlen($rtp) < 13) {
                    continue;                     // RTCP or junk
                }
                $b0  = ord($rtp[0]);
                $cc  = $b0 & 0x0F;
                $ext = ($b0 & 0x10) !== 0;
                $marker = (ord($rtp[1]) & 0x80) !== 0;
                $ts  = unpack('N', substr($rtp, 4, 4))[1];
                $off = 12 + 4 * $cc;
                if ($ext && strlen($rtp) >= $off + 4) {
                    $off += 4 + 4 * unpack('n', substr($rtp, $off + 2, 2))[1];
                }
                $pl = substr($rtp, $off);
                if (($b0 & 0x20) !== 0 && $pl !== '') {   // padding
                    $pl = substr($pl, 0, -ord($pl[strlen($pl) - 1]));
                }
                if ($pl === '') {
                    continue;
                }
                $type = ord($pl[0]) & 0x1F;
                if ($type >= 1 && $type <= 23) {
                    $nal($pl);
                } elseif ($type === 24) {                  // STAP-A
                    $i = 1;
                    while ($i + 2 <= strlen($pl)) {
                        $len = unpack('n', substr($pl, $i, 2))[1];
                        $i  += 2;
                        if ($len > 0) {
                            $nal(substr($pl, $i, $len));
                        }
                        $i += $len;
                    }
                } elseif ($type === 28 && strlen($pl) > 2) { // FU-A
                    $fh = ord($pl[1]);
                    if ($fh & 0x80) {
                        $fu = chr((ord($pl[0]) & 0xE0) | ($fh & 0x1F)) . substr($pl, 2);
                    } elseif ($fu !== '') {
                        $fu .= substr($pl, 2);
                    }
                    if (($fh & 0x40) && $fu !== '') {
                        $nal($fu);
                        $fu = '';
                    }
                }

                if ($marker && $au !== '') {
                    $dur = 40;
                    if ($lastTs !== null) {
                        $d = ($ts - $lastTs) & 0xFFFFFFFF;
                        $dur = ($d > 0 && $d < 90000 * 2) ? (int) max(1, round($d / 90)) : 40;
                    }
                    $lastTs = $ts;
                    $isIdr = strpos($au, "\x00\x00\x00\x01" . chr(0x65)) !== false
                        || preg_match('/\x00\x00\x00\x01[\x25\x45\x65]/', $au) === 1;
                    if (!$haveIdr && $isIdr) {
                        $haveIdr = true;
                        // Make sure the first keyframe carries SPS/PPS.
                        if (strpos($au, "\x00\x00\x00\x01" . chr(0x67)) === false && strpos($au, "\x00\x00\x00\x01\x27") === false
                            && strpos($au, "\x00\x00\x00\x01\x47") === false) {
                            $ps = ($sps !== '' ? "\x00\x00\x00\x01" . $sps : '') . ($pps !== '' ? "\x00\x00\x00\x01" . $pps : '');
                            $au = ($ps !== '' ? $ps : $paramSets) . $au;
                        }
                    }
                    if ($haveIdr) {
                        if (!$emit($au, $dur, $isIdr)) {
                            break;
                        }
                        $frames++;
                        $bytes += strlen($au);
                    }
                    $au = '';
                }
            }
            $this->send('TEARDOWN', $this->baseOf($control), []);
            return ['frames' => $frames, 'bytes' => $bytes, 'error' => ''];
        } catch (Throwable $e) {
            return ['frames' => $frames, 'bytes' => $bytes, 'error' => $e->getMessage()];
        } finally {
            if (is_resource($this->sock)) {
                @fclose($this->sock);
            }
            $this->sock = null;
        }
    }

    /** Pack one record for the browser. */
    public static function record(string $annexB, int $durationMs): string
    {
        return pack('VV', strlen($annexB), $durationMs) . $annexB;
    }

    // ── RTSP plumbing ────────────────────────────────────────

    private function connect(int $timeout): void
    {
        $errno = 0;
        $err   = '';
        $s = @stream_socket_client('tcp://' . $this->host . ':' . $this->port, $errno, $err, $timeout);
        if (!$s) {
            throw new RuntimeException('Cannot reach camera RTSP port: ' . $err);
        }
        stream_set_timeout($s, $timeout);
        $this->sock = $s;
    }

    private function baseOf(string $control): string
    {
        // PLAY/keep-alive/TEARDOWN go to the presentation URL (track suffix dropped).
        return (string) preg_replace('~/trackID=\d+$|/track\d+$~i', '', $control) ?: $this->url;
    }

    private function send(string $method, string $uri, array $headers): void
    {
        $this->cseq++;
        $h = $method . ' ' . $uri . " RTSP/1.0\r\nCSeq: " . $this->cseq . "\r\nUser-Agent: " . self::UA . "\r\n";
        if ($this->session !== '') {
            $h .= 'Session: ' . $this->session . "\r\n";
        }
        $auth = $this->authFor($method, $uri);
        if ($auth !== '') {
            $h .= 'Authorization: ' . $auth . "\r\n";
        }
        foreach ($headers as $k => $v) {
            $h .= $k . ': ' . $v . "\r\n";
        }
        $this->write($h . "\r\n");
    }

    /** Send a request and read its reply, answering one auth challenge. */
    private function request(string $method, string $uri, array $headers): array
    {
        for ($try = 0; $try < 2; $try++) {
            $this->send($method, $uri, $headers);
            $r = $this->readResponse();
            if ($r['status'] === 401 && $try === 0 && ($this->user !== '' || $this->pass !== '')) {
                $this->challenge((string) ($r['headers']['www-authenticate'] ?? ''));
                continue;
            }
            if ($r['status'] < 200 || $r['status'] >= 300) {
                throw new RuntimeException($method . ' failed: RTSP ' . $r['status']);
            }
            return $r;
        }
        throw new RuntimeException($method . ' failed: camera rejected the credentials');
    }

    private function challenge(string $www): void
    {
        if (stripos($www, 'digest') === 0) {
            preg_match_all('/(\w+)="?([^",]*)"?/', substr($www, 6), $m, PREG_SET_ORDER);
            $d = [];
            foreach ($m as $kv) {
                $d[strtolower($kv[1])] = $kv[2];
            }
            $this->digest = $d;
            $this->authHeader = '';
        } else {
            $this->digest = [];
            $this->authHeader = 'Basic ' . base64_encode($this->user . ':' . $this->pass);
        }
    }

    private function authFor(string $method, string $uri): string
    {
        if ($this->digest) {
            $realm = $this->digest['realm'] ?? '';
            $nonce = $this->digest['nonce'] ?? '';
            $ha1 = md5($this->user . ':' . $realm . ':' . $this->pass);
            $ha2 = md5($method . ':' . $uri);
            return 'Digest username="' . $this->user . '", realm="' . $realm . '", nonce="' . $nonce
                . '", uri="' . $uri . '", response="' . md5($ha1 . ':' . $nonce . ':' . $ha2) . '"';
        }
        return $this->authHeader;
    }

    private function write(string $data): void
    {
        $n = 0;
        $len = strlen($data);
        while ($n < $len) {
            $w = @fwrite($this->sock, substr($data, $n));
            if ($w === false || $w === 0) {
                throw new RuntimeException('Camera connection closed');
            }
            $n += $w;
        }
    }

    private function fill(int $need): void
    {
        while (strlen($this->buf) < $need) {
            $chunk = @fread($this->sock, max(8192, $need - strlen($this->buf)));
            if ($chunk === false || $chunk === '') {
                $meta = stream_get_meta_data($this->sock);
                throw new RuntimeException(!empty($meta['timed_out']) ? 'Camera stopped sending video' : 'Camera connection closed');
            }
            $this->buf .= $chunk;
        }
    }

    private function take(int $n): string
    {
        $this->fill($n);
        $out = substr($this->buf, 0, $n);
        $this->buf = (string) substr($this->buf, $n);
        return $out;
    }

    /** @return array{status:int,headers:array<string,string>,body:string} */
    private function readResponse(): array
    {
        // Skip any interleaved data that arrives before the reply.
        while (true) {
            $this->fill(1);
            if ($this->buf[0] === '$') {
                $this->fill(4);
                $len = unpack('n', substr($this->buf, 2, 2))[1];
                $this->take(4 + $len);
                continue;
            }
            break;
        }
        while (($p = strpos($this->buf, "\r\n\r\n")) === false) {
            $this->fill(strlen($this->buf) + 1);
            if (strlen($this->buf) > 65536) {
                throw new RuntimeException('Bad RTSP reply');
            }
        }
        $head = substr($this->buf, 0, $p);
        $this->buf = (string) substr($this->buf, $p + 4);
        $lines = explode("\r\n", $head);
        if (!preg_match('~^RTSP/1\.\d\s+(\d{3})~', (string) array_shift($lines), $m)) {
            throw new RuntimeException('Bad RTSP reply');
        }
        $headers = [];
        foreach ($lines as $l) {
            $i = strpos($l, ':');
            if ($i !== false) {
                $k = strtolower(trim(substr($l, 0, $i)));
                $v = trim(substr($l, $i + 1));
                // Prefer the Digest challenge when several are offered.
                if ($k === 'www-authenticate' && isset($headers[$k]) && stripos($headers[$k], 'digest') === 0) {
                    continue;
                }
                $headers[$k] = $v;
            }
        }
        $body = '';
        $len = (int) ($headers['content-length'] ?? 0);
        if ($len > 0) {
            $body = $this->take($len);
        }
        return ['status' => (int) $m[1], 'headers' => $headers, 'body' => $body];
    }

    /** @return array{0:int,1:string}|null  [channel, payload], or null after consuming an RTSP reply */
    private function readInterleaved(int $timeout): ?array
    {
        $this->fill(1);
        if ($this->buf[0] !== '$') {
            $this->readResponse();
            return null;
        }
        $this->fill(4);
        $ch  = ord($this->buf[1]);
        $len = unpack('n', substr($this->buf, 2, 2))[1];
        $all = $this->take(4 + $len);
        return [$ch, substr($all, 4)];
    }

    /** @return array{0:string,1:string,2:string} [control URL, SPS, PPS] */
    private function parseSdp(string $sdp, string $base): array
    {
        $video = false;
        $control = '';
        $sps = '';
        $pps = '';
        $codecOk = false;
        foreach (preg_split('/\r?\n/', $sdp) as $l) {
            if (strpos($l, 'm=') === 0) {
                $video = strpos($l, 'm=video') === 0;
                continue;
            }
            if (!$video) {
                continue;
            }
            if (stripos($l, 'a=rtpmap:') === 0 && stripos($l, 'H264') !== false) {
                $codecOk = true;
            }
            if (stripos($l, 'a=rtpmap:') === 0 && preg_match('/H265|HEVC/i', $l)) {
                throw new RuntimeException('Camera sends H.265 — set the stream to H.264 for browser playback');
            }
            if (stripos($l, 'a=control:') === 0 && $control === '') {
                $control = trim(substr($l, 10));
            }
            if (preg_match('/sprop-parameter-sets=([^;\s]+)/', $l, $m)) {
                $ps  = explode(',', $m[1]);
                $sps = (string) base64_decode($ps[0] ?? '', true);
                $pps = (string) base64_decode($ps[1] ?? '', true);
            }
        }
        if (!$codecOk) {
            throw new RuntimeException('No H.264 video track in the camera stream');
        }
        if ($control === '' || $control === '*') {
            $control = $base;
        } elseif (!preg_match('~^rtsp://~i', $control)) {
            $control = rtrim($base, '/') . '/' . ltrim($control, '/');
        }
        // Never send credentials inside URLs.
        $control = (string) preg_replace('~^(rtsp://)[^@/]+@~i', '$1', $control);
        return [$control, $sps, $pps];
    }
}
