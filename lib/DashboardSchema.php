<?php
/**
 * Schema for M3 (customisable widget dashboard): several named, saved
 * dashboards per login, each with its own widget layout and filters. Called
 * from Database::migrate(); works on MySQL and SQLite. Same pattern as
 * lib/HrSchema.php / lib/FloorplanSchema.php.
 *
 *   user_dashboards   id (PK, auto) · user_id · name (≤60, unique per user, case-insensitive)
 *                     · layout json ({v, widgets:[{id,size}] | null = role default})
 *                     · filters json ({range, from, to, plant, cams[], sev}) · is_default
 *                     · position · updated_at
 *
 * v1 → v2 upgrade (runs once, idempotent, safe to re-run after a crash at any
 * step): the v1 table (user_id PK, layout, updated_at — one layout per login)
 * is renamed to user_dashboards_v1, the v2 table is created, every v1 row is
 * copied in as a dashboard named "My dashboard" (is_default = 1) unless that
 * user already has one there, then the v1 table is dropped. A fresh install
 * creates the v2 shape directly. MySQL serialises concurrent first requests
 * with GET_LOCK; SQLite runs the whole upgrade in one IMMEDIATE transaction
 * (its DDL is transactional).
 *
 * Skipped when storage/dashboard_schema.ver already records this version for
 * this database (Database::migrate runs on every request).
 */

declare(strict_types=1);

final class DashboardSchema
{
    public const VERSION = 2;
    public const LEGACY_NAME = 'My dashboard';

    public static function migrate(PDO $pdo, string $driver, ?string $storageDir = null, bool $force = false): void
    {
        $sq     = $driver === 'sqlite';
        $marker = $storageDir ? rtrim($storageDir, '/') . '/dashboard_schema.ver' : null;
        $tag    = self::VERSION . ':' . $driver . ':' . md5(self::dbName($pdo, $sq));
        if (!$force && $marker && is_file($marker) && trim((string) @file_get_contents($marker)) === $tag) {
            return;
        }
        $sq ? self::upgradeSqlite($pdo) : self::upgradeMysql($pdo);
        if ($marker) {
            @file_put_contents($marker, $tag, LOCK_EX);
        }
    }

    /* ── SQLite ─────────────────────────────────────────────────────────── */

    private static function upgradeSqlite(PDO $pdo): void
    {
        $own = !$pdo->inTransaction();
        if ($own) {
            $pdo->exec('BEGIN IMMEDIATE');
        }
        try {
            if (self::sqliteHas($pdo, 'user_dashboards') && !in_array('id', self::sqliteCols($pdo, 'user_dashboards'), true)) {
                if (self::sqliteHas($pdo, 'user_dashboards_v1')) {
                    // Should not happen (v1 already parked) — keep the parked copy, park this one under a second name.
                    $pdo->exec('ALTER TABLE user_dashboards RENAME TO user_dashboards_v1b');
                    $pdo->exec('INSERT INTO user_dashboards_v1 (user_id, layout, updated_at)
                                SELECT user_id, layout, updated_at FROM user_dashboards_v1b
                                WHERE user_id NOT IN (SELECT user_id FROM user_dashboards_v1)');
                    $pdo->exec('DROP TABLE user_dashboards_v1b');
                } else {
                    $pdo->exec('ALTER TABLE user_dashboards RENAME TO user_dashboards_v1');
                }
            }
            $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS user_dashboards (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    name        TEXT NOT NULL COLLATE NOCASE,
    layout      TEXT NOT NULL,
    filters     TEXT,
    is_default  INTEGER NOT NULL DEFAULT 0,
    position    INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT
)
SQL);
            $pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_user_dash_name ON user_dashboards (user_id, name)');
            $pdo->exec('CREATE INDEX IF NOT EXISTS ix_user_dash_pos ON user_dashboards (user_id, position)');
            if (self::sqliteHas($pdo, 'user_dashboards_v1')) {
                self::copyLegacy($pdo);
                $pdo->exec('DROP TABLE user_dashboards_v1');
            }
            if ($own) {
                $pdo->exec('COMMIT');
            }
        } catch (Throwable $e) {
            if ($own) {
                try { $pdo->exec('ROLLBACK'); } catch (Throwable $e2) { /* already rolled back */ }
            }
            error_log('[migrate] dashboards v2 (sqlite): ' . $e->getMessage());
            throw $e;
        }
    }

    private static function sqliteHas(PDO $pdo, string $table): bool
    {
        $st = $pdo->prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = :n");
        $st->execute(['n' => $table]);
        return (bool) $st->fetchColumn();
    }

    /** @return string[] */
    private static function sqliteCols(PDO $pdo, string $table): array
    {
        return array_map(static fn ($r) => (string) $r['name'], $pdo->query('PRAGMA table_info(' . $table . ')')->fetchAll(PDO::FETCH_ASSOC));
    }

    /* ── MySQL ──────────────────────────────────────────────────────────── */

    private static function upgradeMysql(PDO $pdo): void
    {
        // DDL auto-commits on MySQL, so instead of a transaction every step is
        // re-entrant and concurrent first requests queue on a named lock.
        $locked = false;
        try {
            $locked = (int) $pdo->query("SELECT GET_LOCK('kj_dashboard_schema', 15)")->fetchColumn() === 1;
        } catch (Throwable $e) {
            $locked = false;
        }
        try {
            if (self::mysqlHas($pdo, 'user_dashboards') && !in_array('id', self::mysqlCols($pdo, 'user_dashboards'), true)) {
                if (self::mysqlHas($pdo, 'user_dashboards_v1')) {
                    $pdo->exec('RENAME TABLE user_dashboards TO user_dashboards_v1b');
                    $pdo->exec('INSERT INTO user_dashboards_v1 (user_id, layout, updated_at)
                                SELECT user_id, layout, updated_at FROM user_dashboards_v1b b
                                WHERE NOT EXISTS (SELECT 1 FROM user_dashboards_v1 a WHERE a.user_id = b.user_id)');
                    $pdo->exec('DROP TABLE user_dashboards_v1b');
                } else {
                    $pdo->exec('RENAME TABLE user_dashboards TO user_dashboards_v1');
                }
            }
            $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS user_dashboards (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    name        VARCHAR(60) NOT NULL,
    layout      MEDIUMTEXT NOT NULL,
    filters     TEXT NULL,
    is_default  TINYINT(1) NOT NULL DEFAULT 0,
    position    INT NOT NULL DEFAULT 0,
    updated_at  DATETIME NULL,
    UNIQUE KEY uq_user_dash_name (user_id, name),
    KEY ix_user_dash_pos (user_id, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
SQL);
            if (self::mysqlHas($pdo, 'user_dashboards_v1')) {
                $pdo->beginTransaction();
                try {
                    self::copyLegacy($pdo);
                    $pdo->commit();
                } catch (Throwable $e) {
                    $pdo->rollBack();
                    throw $e;
                }
                $pdo->exec('DROP TABLE user_dashboards_v1');
            }
        } catch (Throwable $e) {
            error_log('[migrate] dashboards v2 (mysql): ' . $e->getMessage());
            throw $e;
        } finally {
            if ($locked) {
                try { $pdo->query("SELECT RELEASE_LOCK('kj_dashboard_schema')"); } catch (Throwable $e) { /* connection gone */ }
            }
        }
    }

    private static function mysqlHas(PDO $pdo, string $table): bool
    {
        $st = $pdo->prepare('SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :n');
        $st->execute(['n' => $table]);
        return (bool) $st->fetchColumn();
    }

    /** @return string[] */
    private static function mysqlCols(PDO $pdo, string $table): array
    {
        $st = $pdo->prepare('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :n');
        $st->execute(['n' => $table]);
        return array_map('strval', $st->fetchAll(PDO::FETCH_COLUMN));
    }

    /* ── shared ─────────────────────────────────────────────────────────── */

    /** v1 rows → "My dashboard" (default) for every user that has no v2 dashboard yet. */
    private static function copyLegacy(PDO $pdo): void
    {
        $st = $pdo->prepare('INSERT INTO user_dashboards (user_id, name, layout, filters, is_default, position, updated_at)
                             SELECT v.user_id, :name, v.layout, :f, 1, 0, v.updated_at FROM user_dashboards_v1 v
                             WHERE NOT EXISTS (SELECT 1 FROM user_dashboards d WHERE d.user_id = v.user_id)');
        $st->execute(['name' => self::LEGACY_NAME, 'f' => '{}']);
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
}
