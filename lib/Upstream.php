<?php

declare(strict_types=1);

/**
 * Rate limit + circuit breaker for outbound calls to third-party services.
 *
 * The Weststar AI box is small and has fallen over under load, so nothing here
 * may hammer it: detections can arrive dozens per minute per camera, and every
 * dashboard tab polls the feed. Both paths now go through this.
 *
 * State lives in one small JSON file — no DB, safe to lose.
 */
final class Upstream
{
    private const FILE = 'upstream_state.json';

    /**
     * May we call `$name` right now?
     *
     * @param int $maxPerMin  Hard cap on calls per rolling minute.
     */
    public static function allow(string $name, string $storageDir, int $maxPerMin = 20): bool
    {
        $s   = self::read($storageDir);
        $now = time();
        $e   = $s[$name] ?? [];

        // Breaker open after a failure — leave the service alone to recover.
        if (($e['down_until'] ?? 0) > $now) {
            return false;
        }
        // Rolling-minute cap.
        $win = (int) ($e['win'] ?? 0);
        $cnt = (int) ($e['count'] ?? 0);
        if ($now - $win >= 60) {
            $win = $now;
            $cnt = 0;
        }
        if ($cnt >= $maxPerMin) {
            return false;
        }
        $s[$name] = ['win' => $win, 'count' => $cnt + 1, 'down_until' => 0, 'last' => $now];
        self::write($storageDir, $s);
        return true;
    }

    /** Record a failure: back off for `$cooldown` seconds (default 10 min). */
    public static function failed(string $name, string $storageDir, int $cooldown = 600): void
    {
        $s = self::read($storageDir);
        $e = $s[$name] ?? [];
        $s[$name] = ['win' => (int) ($e['win'] ?? time()), 'count' => (int) ($e['count'] ?? 0),
                     'down_until' => time() + max(30, $cooldown), 'last' => time()];
        self::write($storageDir, $s);
    }

    /** Clear the breaker after a success. */
    public static function ok(string $name, string $storageDir): void
    {
        $s = self::read($storageDir);
        if (!empty($s[$name]['down_until'])) {
            $s[$name]['down_until'] = 0;
            self::write($storageDir, $s);
        }
    }

    /** Seconds until `$name` may be called again (0 when it is callable now). */
    public static function cooldown(string $name, string $storageDir): int
    {
        $s = self::read($storageDir);
        return max(0, (int) ($s[$name]['down_until'] ?? 0) - time());
    }

    private static function path(string $dir): string
    {
        return rtrim($dir, '/') . '/' . self::FILE;
    }

    private static function read(string $dir): array
    {
        $f = self::path($dir);
        return is_file($f) ? (json_decode((string) file_get_contents($f), true) ?: []) : [];
    }

    private static function write(string $dir, array $s): void
    {
        @file_put_contents(self::path($dir), json_encode($s), LOCK_EX);
    }
}
