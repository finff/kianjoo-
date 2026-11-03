<?php
/**
 * Data retention (scoring-matrix criterion 36).
 *
 * Events (and everything hanging off them: attributes, PPE checks,
 * restricted / forklift rows, incident log, ticket attachments) older than
 * the configured retention (Settings → Data Retention, default 90 days) are
 * purged by a daily job — /api/report/cron, and piggy-backed on feed.php so it
 * runs even when no cron is configured. Detection frames themselves live on
 * the SenseStudio box (its own retention); the dashboard keeps their URLs.
 *
 * storage() reports the live footprint and a projection at the retention
 * horizon so the infrastructure recommendation is grounded in measured data.
 */

declare(strict_types=1);

require_once __DIR__ . '/Database.php';
require_once __DIR__ . '/WsdSettings.php';

final class Retention
{
    private const BATCH = 500;
    private const MAX_PER_RUN = 20000;

    private PDO $pdo;
    private array $config;
    private string $dir;

    public function __construct(PDO $pdo, array $config)
    {
        $this->pdo    = $pdo;
        $this->config = $config;
        $this->dir    = WsdSettings::dirOf($config);
    }

    public function days(): int
    {
        return (int) WsdSettings::of($this->config)['retention_days'];
    }

    private function stateFile(): string
    {
        return $this->dir . '/retention_state.json';
    }

    public function state(): array
    {
        $f = $this->stateFile();
        $s = is_file($f) ? json_decode((string) @file_get_contents($f), true) : null;
        return is_array($s) ? $s : [];
    }

    /**
     * Purge everything older than the retention window.
     * $dry = count only. Returns ['cutoff', 'events', 'attachments', 'done'].
     */
    public function purge(bool $dry = false, string $actor = 'system', int $max = self::MAX_PER_RUN): array
    {
        $days = $this->days();
        if ($days <= 0) {
            return ['cutoff' => null, 'events' => 0, 'attachments' => 0, 'done' => true, 'disabled' => true];
        }
        $cutoff = date('Y-m-d H:i:s', time() - $days * 86400);
        $cnt = $this->pdo->prepare('SELECT COUNT(*) FROM events WHERE received_at < :c');
        $cnt->execute(['c' => $cutoff]);
        $total = (int) $cnt->fetchColumn();
        if ($dry || $total === 0) {
            return ['cutoff' => $cutoff, 'events' => $total, 'attachments' => 0, 'done' => true, 'dry' => $dry];
        }
        $sel = $this->pdo->prepare('SELECT id, uuid FROM events WHERE received_at < :c ORDER BY id ASC LIMIT ' . self::BATCH);
        $gone = $files = 0;
        while ($gone < $max) {
            $sel->execute(['c' => $cutoff]);
            $rows = $sel->fetchAll();
            if (!$rows) {
                break;
            }
            $ids   = array_map(static fn ($r) => (int) $r['id'], $rows);
            $uuids = array_values(array_filter(array_map(static fn ($r) => (string) ($r['uuid'] ?? ''), $rows)));
            $in    = implode(',', array_fill(0, count($ids), '?'));
            $this->pdo->beginTransaction();
            try {
                foreach (['event_attributes', 'ppe_checks', 'restricted_events', 'forklift_events'] as $t) {
                    try {
                        $this->pdo->prepare("DELETE FROM {$t} WHERE event_id IN ({$in})")->execute($ids);
                    } catch (Throwable $e) {
                        // table not migrated yet
                    }
                }
                if ($uuids) {
                    $this->pdo->prepare('DELETE FROM incident_log WHERE uuid IN (' . implode(',', array_fill(0, count($uuids), '?')) . ')')->execute($uuids);
                }
                $this->pdo->prepare("DELETE FROM events WHERE id IN ({$in})")->execute($ids);
                $this->pdo->commit();
            } catch (Throwable $e) {
                $this->pdo->rollBack();
                throw $e;
            }
            foreach ($uuids as $u) {
                $files += $this->dropAttachments($u);
            }
            $gone += count($ids);
        }
        try {
            $this->pdo->prepare('DELETE FROM cleaning_log WHERE session_date < :d')->execute(['d' => substr($cutoff, 0, 10)]);
        } catch (Throwable $e) {
        }
        $state = ['last_run' => date('c'), 'cutoff' => $cutoff, 'purged' => $gone, 'attachments' => $files, 'by' => $actor,
                  'done' => $gone >= $total,
                  'total_purged' => (int) ($this->state()['total_purged'] ?? 0) + $gone];
        @file_put_contents($this->stateFile(), json_encode($state, JSON_UNESCAPED_SLASHES), LOCK_EX);
        return ['cutoff' => $cutoff, 'events' => $gone, 'attachments' => $files, 'done' => $gone >= $total];
    }

    private function dropAttachments(string $uuid): int
    {
        $d = dirname(__DIR__) . '/storage/attachments/' . preg_replace('/[^a-zA-Z0-9_\-]/', '_', $uuid);
        if (!is_dir($d)) {
            return 0;
        }
        $n = 0;
        foreach (scandir($d) ?: [] as $f) {
            if ($f !== '.' && $f !== '..' && is_file($d . '/' . $f) && @unlink($d . '/' . $f)) {
                $n++;
            }
        }
        @rmdir($d);
        return $n;
    }

    /** Daily job (rate-limited by a lock file mtime). Silent on failure. */
    public static function maybeRun(PDO $pdo, array $config, int $minInterval = 86400, int $max = self::MAX_PER_RUN): ?array
    {
        $lock = WsdSettings::dirOf($config) . '/retention.lock';
        $self = new self($pdo, $config);
        // A backlog left by the previous (batch-capped) run continues a minute later.
        $interval = ($self->state()['done'] ?? true) === false ? 60 : $minInterval;
        if (is_file($lock) && time() - (int) @filemtime($lock) < $interval) {
            return null;
        }
        @touch($lock);
        try {
            return $self->purge(false, 'scheduled', $max);
        } catch (Throwable $e) {
            error_log('[retention] ' . $e->getMessage());
            return null;
        }
    }

    private static function dirSize(string $dir): int
    {
        if (!is_dir($dir)) {
            return 0;
        }
        $n = 0;
        try {
            $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
            foreach ($it as $f) {
                if ($f->isFile()) {
                    $n += $f->getSize();
                }
            }
        } catch (Throwable $e) {
        }
        return $n;
    }

    /** Live storage footprint + projection at the retention horizon. */
    public function storage(): array
    {
        $root = dirname(__DIR__);
        $db = 0;
        if (Database::driver() === 'sqlite') {
            $p = (string) ($this->config['storage']['db_path'] ?? '');
            foreach (['', '-wal', '-shm'] as $sfx) {
                $db += is_file($p . $sfx) ? (int) filesize($p . $sfx) : 0;
            }
        } else {
            try {
                $db = (int) $this->pdo->query('SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.TABLES WHERE table_schema = DATABASE()')->fetchColumn();
            } catch (Throwable $e) {
                $db = 0;
            }
        }
        $raw = (string) ($this->config['storage']['raw_log'] ?? '');
        $rawSize = $raw !== '' && is_file($raw) ? (int) filesize($raw) : 0;
        $att = self::dirSize($root . '/storage/attachments');
        $up  = self::dirSize($root . '/uploads');
        $events = (int) $this->pdo->query('SELECT COUNT(*) FROM events')->fetchColumn();
        $oldest = (string) ($this->pdo->query('SELECT MIN(received_at) FROM events')->fetchColumn() ?: '');
        $st = $this->pdo->prepare('SELECT COUNT(*) FROM events WHERE received_at >= :a');
        $st->execute(['a' => date('Y-m-d H:i:s', time() - 7 * 86400)]);
        $perDay = round(((int) $st->fetchColumn()) / 7, 1);
        $days = $this->days();
        $perEvent = $events > 0 ? ($db + $rawSize) / $events : 6000;   // ~6 KB/event before data exists
        $attPerEvent = $events > 0 ? $att / $events : 0;
        $horizon = $days > 0 ? $days : 365;
        $projected = (int) round($perDay * $horizon * ($perEvent + $attPerEvent) + $up);
        return [
            'retention_days' => $days, 'db_bytes' => $db, 'raw_log_bytes' => $rawSize, 'attachments_bytes' => $att,
            'uploads_bytes' => $up, 'total_bytes' => $db + $rawSize + $att + $up, 'events' => $events, 'oldest' => $oldest,
            'events_per_day' => $perDay, 'bytes_per_event' => (int) round($perEvent + $attPerEvent),
            'projected_bytes' => $projected, 'projection_days' => $horizon, 'driver' => Database::driver(),
            'last_run' => $this->state(),
        ];
    }
}
