<?php
/**
 * Schema for stranger movement tracking (Movement › Strangers, lib/Strangers.php).
 * Called from Database::migrate(); works on MySQL and SQLite.
 *
 *   stranger_profiles  operator state per SenseStudio stranger id: label, status
 *                      (new | known | ignored), note, and the alert-episode
 *                      bookkeeping (alert_at / alert_last / alert_reason)
 *   stranger_aliases   "merge with…": alias stranger id → canonical stranger id
 *                      (the same real person got several SenseStudio ids)
 *
 * Nothing here touches `events`: stranger queries ride the existing
 * idx_events_received (date range) and idx_events_person_id (journey) indexes.
 *
 * Skipped when storage/stranger_schema.ver already records this version for
 * this database (Database::migrate runs on every request).
 */

declare(strict_types=1);

final class StrangerSchema
{
    public const VERSION = 1;

    public static function migrate(PDO $pdo, string $driver, ?string $storageDir = null, bool $force = false): void
    {
        $sq     = $driver === 'sqlite';
        $marker = $storageDir ? rtrim($storageDir, '/') . '/stranger_schema.ver' : null;
        $tag    = self::VERSION . ':' . $driver . ':' . md5(self::dbName($pdo, $sq));
        if (!$force && $marker && is_file($marker) && trim((string) @file_get_contents($marker)) === $tag) {
            return;
        }
        try {
            $sq ? self::sqlite($pdo) : self::mysql($pdo);
        } catch (Throwable $e) {
            // Never break the request that happened to run the migration; retried next request.
            error_log('[stranger-schema] ' . $e->getMessage());
            return;
        }
        if ($marker) {
            @file_put_contents($marker, $tag, LOCK_EX);
        }
    }

    private static function dbName(PDO $pdo, bool $sq): string
    {
        try {
            if ($sq) {
                $r = $pdo->query('PRAGMA database_list')->fetch();
                return (string) ($r['file'] ?? 'sqlite');
            }
            return (string) $pdo->query('SELECT DATABASE()')->fetchColumn();
        } catch (Throwable $e) {
            return '';
        }
    }

    private static function sqlite(PDO $pdo): void
    {
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS stranger_profiles (
    stranger_id  TEXT PRIMARY KEY,
    label        TEXT,
    status       TEXT DEFAULT 'new',
    note         TEXT,
    alert_at     TEXT,
    alert_last   TEXT,
    alert_reason TEXT,
    created_at   TEXT,
    updated_at   TEXT,
    updated_by   TEXT
)
SQL);
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_strp_status ON stranger_profiles(status)');
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS stranger_aliases (
    alias_id     TEXT PRIMARY KEY,
    canonical_id TEXT NOT NULL,
    created_by   TEXT,
    created_at   TEXT
)
SQL);
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_stra_canon ON stranger_aliases(canonical_id)');
    }

    private static function mysql(PDO $pdo): void
    {
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS stranger_profiles (
    stranger_id  VARCHAR(64) NOT NULL PRIMARY KEY,
    label        VARCHAR(120) NULL,
    status       VARCHAR(16) NOT NULL DEFAULT 'new',
    note         VARCHAR(500) NULL,
    alert_at     DATETIME NULL,
    alert_last   DATETIME NULL,
    alert_reason VARCHAR(255) NULL,
    created_at   DATETIME NULL,
    updated_at   DATETIME NULL,
    updated_by   VARCHAR(120) NULL,
    KEY idx_strp_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
SQL);
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS stranger_aliases (
    alias_id     VARCHAR(64) NOT NULL PRIMARY KEY,
    canonical_id VARCHAR(64) NOT NULL,
    created_by   VARCHAR(120) NULL,
    created_at   DATETIME NULL,
    KEY idx_stra_canon (canonical_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
SQL);
    }
}
