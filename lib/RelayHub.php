<?php

declare(strict_types=1);

require_once __DIR__ . '/RtspRelay.php';

/**
 * One camera RTSP session shared by every viewer.
 *
 * Cameras allow only a few RTSP sessions (and SenseStudio holds one), so each
 * browser tile must not open its own. The first /live/relay request for a
 * stream becomes the PRODUCER: it holds {name}.lock, pulls the camera through
 * RtspRelay and appends frame records to a segment file. Every request —
 * the producer's own included — is a CONSUMER that tails the segment from the
 * latest keyframe. When the producer ends (time limit, crash), a waiting
 * consumer sees the stale state and takes over the lock. The producer stops
 * once no consumer has checked in for a while.
 *
 * Files in storage/live_relay/:
 *   {name}.lock        producer lock (flock)
 *   {name}.json        {"seg":N,"kf":offset,"ts":unix,"err":""}
 *   {name}.{N}.seg     frame records (RtspRelay::record), rotated at keyframes
 *   {name}.c.{id}      consumer heartbeats (mtime)
 */
final class RelayHub
{
    private const SEG_MAX     = 6 * 1024 * 1024;   // rotate after ~15 s of 1080p
    private const IDLE_STOP_S = 15;                // no viewers → producer stops
    private const STALE_S     = 4;                 // producer silent → take over

    private string $dir;
    private string $name;
    private string $src;

    public function __construct(string $storageDir, string $name, string $src)
    {
        $this->dir  = rtrim($storageDir, '/\\') . '/live_relay';
        $this->name = $name;
        $this->src  = $src;
        if (!is_dir($this->dir)) {
            @mkdir($this->dir, 0775, true);
        }
    }

    /**
     * Serve one viewer: write records through $out(string): bool (false when
     * the viewer left) for at most $maxSeconds.
     *
     * @return string '' when frames were served, else the last camera error
     */
    /** Viewers allowed at once across all streams: each one holds a PHP worker. */
    public const MAX_VIEWERS = 4;

    /** True when another viewer may join without starving the site's PHP workers. */
    public function hasCapacity(): bool
    {
        $n = 0;
        $now = time();
        foreach (glob($this->dir . '/*.c.*') ?: [] as $f) {
            $m = @filemtime($f);
            if ($m !== false && $now - $m <= self::IDLE_STOP_S) {
                $n++;
            }
        }
        return $n < self::MAX_VIEWERS;
    }

    public function serve(callable $out, int $maxSeconds = 75): string
    {
        $me    = $this->dir . '/' . $this->name . '.c.' . bin2hex(random_bytes(4));
        $start = time();
        $sent  = 0;
        $err   = '';
        @touch($me);
        try {
            while (time() - $start < $maxSeconds) {
                $state = $this->state();
                $fresh = $state && (microtime(true) - (float) ($state['ts'] ?? 0)) < self::STALE_S;
                if (!$fresh) {
                    // Nobody is producing: try to become the producer.
                    $lock = @fopen($this->dir . '/' . $this->name . '.lock', 'c');
                    if ($lock && flock($lock, LOCK_EX | LOCK_NB)) {
                        $res = $this->produce($out, $me, $start + $maxSeconds, $sent);
                        flock($lock, LOCK_UN);
                        fclose($lock);
                        if ($res === 'viewer-left') {
                            return '';
                        }
                        if ($res !== '' && $sent === 0) {
                            return $res;               // camera refused: report it
                        }
                        $err = $res;
                        continue;
                    }
                    if ($lock) {
                        fclose($lock);
                    }
                    // Someone else holds the lock and is (re)connecting.
                    if ($state && ($state['err'] ?? '') !== '' && $sent === 0
                        && microtime(true) - (float) ($state['ts'] ?? 0) < 10) {
                        return (string) $state['err'];
                    }
                    usleep(200000);
                    @touch($me);
                    continue;
                }
                $r = $this->consume($out, $me, $state, $start + $maxSeconds, $sent);
                if ($r === 'viewer-left') {
                    return '';
                }
            }
            return $sent > 0 ? '' : ($err ?: 'No video from camera');
        } finally {
            @unlink($me);
        }
    }

    /** Pull the camera, write segments, and serve this viewer from memory. */
    private function produce(callable $out, string $me, int $until, int &$sent): string
    {
        $seg      = (int) (($this->state()['seg'] ?? 0)) + 1;
        $fh       = null;
        $size     = 0;
        $kf       = 0;
        $lastBeat = 0.0;
        $viewerOk = true;
        $open = function () use (&$fh, &$seg, &$size): void {
            if ($fh) {
                fclose($fh);
            }
            $fh   = fopen($this->segFile($seg), 'wb');
            $size = 0;
            // Keep the previous segment for slow readers; drop older ones.
            foreach (glob($this->dir . '/' . $this->name . '.*.seg') ?: [] as $f) {
                if (preg_match('~\.(\d+)\.seg$~', $f, $m) && (int) $m[1] < $seg - 1) {
                    @unlink($f);
                }
            }
        };
        $open();
        $this->writeState(['seg' => $seg, 'kf' => 0, 'ts' => microtime(true), 'err' => '']);

        $relay = new RtspRelay($this->src);
        $res = $relay->run(function (string $au, int $dur, bool $key) use (&$fh, &$seg, &$size, &$kf, &$lastBeat, &$viewerOk, &$sent, $open, $out, $me, $until): bool {
            if ($key && $size >= self::SEG_MAX) {
                $seg++;
                $open();
            }
            $rec = RtspRelay::record($au, $dur);
            if ($key) {
                $kf = $size;
            }
            fwrite($fh, $rec);
            fflush($fh);
            $size += strlen($rec);
            $now = microtime(true);
            if ($key || $now - $lastBeat > 0.5) {
                $this->writeState(['seg' => $seg, 'kf' => $kf, 'ts' => $now, 'err' => '']);
                $lastBeat = $now;
            }
            if ($viewerOk) {
                if ($out($rec)) {
                    $sent++;
                    @touch($me);
                } else {
                    $viewerOk = false;      // keep producing for the others
                    @unlink($me);
                }
            }
            if (time() >= $until && $viewerOk) {
                return false;
            }
            // Stop when nobody (including us) is watching any more.
            return $viewerOk || $this->viewers() > 0;
        }, max(10, $until - time() + 30));

        if ($fh) {
            fclose($fh);
        }
        $err = (string) $res['error'];
        // Mark the state stale so a waiting consumer takes over immediately.
        $this->writeState(['seg' => $seg, 'kf' => $kf, 'ts' => 0, 'err' => $err !== '' ? $err : '']);
        if (!$viewerOk) {
            return 'viewer-left';
        }
        return $err;
    }

    /** Tail the producer's segments from the latest keyframe. */
    private function consume(callable $out, string $me, array $state, int $until, int &$sent): string
    {
        $seg = (int) $state['seg'];
        $fh  = @fopen($this->segFile($seg), 'rb');
        if (!$fh) {
            usleep(100000);
            return '';
        }
        fseek($fh, (int) $state['kf']);
        $buf  = '';
        $beat = 0.0;
        while (time() < $until) {
            $chunk = fread($fh, 262144);
            if ($chunk !== false && $chunk !== '') {
                $buf .= $chunk;
                while (strlen($buf) >= 8) {
                    $len = unpack('V', substr($buf, 0, 4))[1];
                    if (strlen($buf) < 8 + $len) {
                        break;
                    }
                    if (!$out(substr($buf, 0, 8 + $len))) {
                        fclose($fh);
                        return 'viewer-left';
                    }
                    $sent++;
                    $buf = (string) substr($buf, 8 + $len);
                }
                continue;
            }
            // At the end of the file: next segment, or wait for more frames.
            $st = $this->state();
            if (!$st || microtime(true) - (float) ($st['ts'] ?? 0) >= self::STALE_S) {
                fclose($fh);
                return '';                      // producer gone → caller takes over
            }
            if ((int) $st['seg'] > $seg && $buf === '') {
                fclose($fh);
                $seg++;
                $fh = @fopen($this->segFile($seg), 'rb');
                if (!$fh) {
                    return '';
                }
                continue;
            }
            if (microtime(true) - $beat > 1) {
                @touch($me);
                $beat = microtime(true);
                // An empty record lets an idle wait notice a viewer who left.
                if (!$out(pack('VV', 0, 0))) {
                    fclose($fh);
                    return 'viewer-left';
                }
            }
            usleep(15000);
            clearstatcache();
        }
        fclose($fh);
        return '';
    }

    private function viewers(): int
    {
        $n = 0;
        $now = time();
        foreach (glob($this->dir . '/' . $this->name . '.c.*') ?: [] as $f) {
            $m = @filemtime($f);
            if ($m !== false && $now - $m <= self::IDLE_STOP_S) {
                $n++;
            } elseif ($m !== false && $now - $m > 120) {
                @unlink($f);
            }
        }
        return $n;
    }

    private function segFile(int $seg): string
    {
        return $this->dir . '/' . $this->name . '.' . $seg . '.seg';
    }

    private function state(): ?array
    {
        $f = $this->dir . '/' . $this->name . '.json';
        $s = @file_get_contents($f);
        $d = $s ? json_decode($s, true) : null;
        return is_array($d) ? $d : null;
    }

    private function writeState(array $s): void
    {
        $f = $this->dir . '/' . $this->name . '.json';
        @file_put_contents($f . '.tmp', json_encode($s));
        @rename($f . '.tmp', $f);
    }
}
