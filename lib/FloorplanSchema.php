<?php
/**
 * Schema for M14 floor plans + camera pins (movement playback).
 * Called from Database::migrate(); works on MySQL and SQLite.
 *
 *   floorplans         one uploaded plan image (per floor / zone), ordered
 *   floorplan_cameras  camera pins on a plan: camera_id = live stream label,
 *                      position as % of the image (0–100, floats)
 *
 * Skipped when storage/floorplan_schema.ver already records this version for
 * this database (Database::migrate runs on every request).
 */

declare(strict_types=1);

final class FloorplanSchema
{
    public const VERSION = 1;

    public static function migrate(PDO $pdo, string $driver, ?string $storageDir = null, bool $force = false): void
    {
        $sq     = $driver === 'sqlite';
        $marker = $storageDir ? rtrim($storageDir, '/') . '/floorplan_schema.ver' : null;
        $tag    = self::VERSION . ':' . $driver . ':' . md5(self::dbName($pdo, $sq));
        if (!$force && $marker && is_file($marker) && trim((string) @file_get_contents($marker)) === $tag) {
            return;
        }
        $sq ? self::sqlite($pdo) : self::mysql($pdo);
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
CREATE TABLE IF NOT EXISTS floorplans (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    sort_order    INTEGER DEFAULT 0,
    image_path    TEXT,
    display_path  TEXT,
    width_px      INTEGER DEFAULT 0,
    height_px     INTEGER DEFAULT 0,
    active        INTEGER DEFAULT 1,
    created_by    TEXT,
    created_at    TEXT,
    updated_at    TEXT
)
SQL);
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS floorplan_cameras (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    floorplan_id  INTEGER NOT NULL,
    camera_id     TEXT NOT NULL,
    x_pct         REAL NOT NULL,
    y_pct         REAL NOT NULL,
    label         TEXT,
    created_at    TEXT,
    updated_at    TEXT,
    UNIQUE (floorplan_id, camera_id)
)
SQL);
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_fpc_camera ON floorplan_cameras(camera_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_fp_sort ON floorplans(sort_order)');
    }

    private static function mysql(PDO $pdo): void
    {
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS floorplans (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name          VARCHAR(120) NOT NULL,
    sort_order    INT NOT NULL DEFAULT 0,
    image_path    VARCHAR(255) NULL,
    display_path  VARCHAR(255) NULL,
    width_px      INT UNSIGNED NOT NULL DEFAULT 0,
    height_px     INT UNSIGNED NOT NULL DEFAULT 0,
    active        TINYINT(1) NOT NULL DEFAULT 1,
    created_by    VARCHAR(120) NULL,
    created_at    DATETIME NULL,
    updated_at    DATETIME NULL,
    KEY idx_fp_sort (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
SQL);
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS floorplan_cameras (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    floorplan_id  BIGINT UNSIGNED NOT NULL,
    camera_id     VARCHAR(64) NOT NULL,
    x_pct         DOUBLE NOT NULL,
    y_pct         DOUBLE NOT NULL,
    label         VARCHAR(120) NULL,
    created_at    DATETIME NULL,
    updated_at    DATETIME NULL,
    UNIQUE KEY uq_fpc_plan_cam (floorplan_id, camera_id),
    KEY idx_fpc_camera (camera_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
SQL);
    }
}
