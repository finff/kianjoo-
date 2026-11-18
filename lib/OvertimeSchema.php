<?php
/**
 * Schema for overtime (OT) capture. Called from Database::migrate(); works on
 * MySQL and SQLite. Same pattern as lib/HrSchema.php.
 *
 *   ot_records   one row per employee per work date that captured OT:
 *                person + date + shift, the minutes HR acts on (`minutes`),
 *                the latest recomputed figure (`calc_minutes`), the rule text
 *                that produced it, the evidence (first / last sighting time,
 *                location and camera), and the approval state
 *                (pending | approved | rejected, decided_by / name / at, note).
 *
 * Recompute never overwrites a decided record's `minutes`: it only refreshes
 * `calc_minutes` and sets `changed` when the two differ (lib/Overtime.php).
 *
 * The CREATE pass is skipped when storage/ot_schema.ver already records this
 * version for this database (Database::migrate runs on every request).
 */

declare(strict_types=1);

final class OvertimeSchema
{
    public const VERSION = 1;

    public static function migrate(PDO $pdo, string $driver, ?string $storageDir = null, bool $force = false): void
    {
        $sq     = $driver === 'sqlite';
        $marker = $storageDir ? rtrim($storageDir, '/') . '/ot_schema.ver' : null;
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
CREATE TABLE IF NOT EXISTS ot_records (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id     TEXT NOT NULL,
    work_date     TEXT NOT NULL,
    name          TEXT,
    staff_id      TEXT,
    department    TEXT,
    plant         TEXT,
    shift_id      TEXT,
    shift_name    TEXT,
    shift_start   TEXT,
    shift_end     TEXT,
    kind          TEXT,
    minutes       INTEGER NOT NULL DEFAULT 0,
    calc_minutes  INTEGER NOT NULL DEFAULT 0,
    raw_minutes   INTEGER NOT NULL DEFAULT 0,
    changed       INTEGER NOT NULL DEFAULT 0,
    rule_text     TEXT,
    rule_json     TEXT,
    in_at         TEXT,
    in_loc        TEXT,
    in_cam        TEXT,
    out_at        TEXT,
    out_loc       TEXT,
    out_cam       TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    decided_by    INTEGER,
    decided_name  TEXT,
    decided_at    TEXT,
    note          TEXT,
    created_at    TEXT,
    updated_at    TEXT,
    UNIQUE (person_id, work_date)
)
SQL);
        foreach ([
            'CREATE INDEX IF NOT EXISTS idx_ot_date   ON ot_records(work_date, status)',
            'CREATE INDEX IF NOT EXISTS idx_ot_dept   ON ot_records(department, work_date)',
        ] as $sql) {
            $pdo->exec($sql);
        }
    }

    private static function mysql(PDO $pdo): void
    {
        $pdo->exec(<<<SQL
CREATE TABLE IF NOT EXISTS ot_records (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    person_id     VARCHAR(64) NOT NULL,
    work_date     DATE NOT NULL,
    name          VARCHAR(120) NULL,
    staff_id      VARCHAR(64) NULL,
    department    VARCHAR(80) NULL,
    plant         VARCHAR(80) NULL,
    shift_id      VARCHAR(40) NULL,
    shift_name    VARCHAR(40) NULL,
    shift_start   DATETIME NULL,
    shift_end     DATETIME NULL,
    kind          VARCHAR(20) NULL,
    minutes       INT NOT NULL DEFAULT 0,
    calc_minutes  INT NOT NULL DEFAULT 0,
    raw_minutes   INT NOT NULL DEFAULT 0,
    changed       TINYINT NOT NULL DEFAULT 0,
    rule_text     VARCHAR(255) NULL,
    rule_json     VARCHAR(500) NULL,
    in_at         DATETIME NULL,
    in_loc        VARCHAR(80) NULL,
    in_cam        VARCHAR(64) NULL,
    out_at        DATETIME NULL,
    out_loc       VARCHAR(80) NULL,
    out_cam       VARCHAR(64) NULL,
    status        VARCHAR(12) NOT NULL DEFAULT 'pending',
    decided_by    BIGINT UNSIGNED NULL,
    decided_name  VARCHAR(120) NULL,
    decided_at    DATETIME NULL,
    note          VARCHAR(1000) NULL,
    created_at    DATETIME,
    updated_at    DATETIME,
    UNIQUE KEY uq_ot_person_date (person_id, work_date),
    KEY idx_ot_date (work_date, status),
    KEY idx_ot_dept (department, work_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
SQL);
    }
}
