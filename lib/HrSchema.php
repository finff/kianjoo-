<?php
/**
 * Schema for the people-side modules (M6 leave workflow, profile
 * self-service, in-app notifications). Called from Database::migrate();
 * works on MySQL and SQLite. Same pattern as lib/AiSchema.php.
 *
 *   leave_types        catalogue (seeded: AL Annual, MC Medical, EL Emergency, UL Unpaid)
 *   leave_balances     per user per year per type: entitled + used (pending is computed live)
 *   leaves             one request: dates, half-day, reason, status, approver, remarks
 *   leave_attachments  files on a request (e.g. MC photo; images re-encoded to WebP)
 *   notifications      in-app inbox per user
 *   users.*            phone, emergency_name/phone/relation, photo_url, profile_updated_at
 *
 * The CREATE/ALTER pass is skipped when storage/hr_schema.ver already records
 * this version for this database (Database::migrate runs on every request).
 */

declare(strict_types=1);

require_once __DIR__ . '/AiSchema.php';

final class HrSchema
{
    public const VERSION = 1;

    /** code => [name, default annual days, unlimited, requires_attachment, color, sort] */
    public const SEED_TYPES = [
        'AL' => ['Annual Leave',    14, 0, 0, '#2563eb', 1],
        'MC' => ['Medical Leave',   14, 0, 1, '#16a34a', 2],
        'EL' => ['Emergency Leave',  3, 0, 0, '#f97316', 3],
        'UL' => ['Unpaid Leave',     0, 1, 0, '#64748b', 4],
    ];

    /** Self-service profile columns added to `users`. */
    private const USER_COLS = [
        'phone'              => ['TEXT', 'VARCHAR(40) NULL'],
        'emergency_name'     => ['TEXT', 'VARCHAR(120) NULL'],
        'emergency_phone'    => ['TEXT', 'VARCHAR(40) NULL'],
        'emergency_relation' => ['TEXT', 'VARCHAR(40) NULL'],
        'photo_url'          => ['TEXT', 'VARCHAR(255) NULL'],
        'profile_updated_at' => ['TEXT', 'DATETIME NULL'],
    ];

    public static function migrate(PDO $pdo, string $driver, ?string $storageDir = null, bool $force = false): void
    {
        $sq     = $driver === 'sqlite';
        $marker = $storageDir ? rtrim($storageDir, '/') . '/hr_schema.ver' : null;
        $tag    = self::VERSION . ':' . $driver . ':' . md5(self::dbName($pdo, $sq));
        if (!$force && $marker && is_file($marker) && trim((string) @file_get_contents($marker)) === $tag) {
            return;
        }
        $sq ? self::sqlite($pdo) : self::mysql($pdo);
        foreach (self::USER_COLS as $col => [$sqlite, $mysql]) {
            if (!AiSchema::columnExists($pdo, $sq, 'users', $col)) {
                $pdo->exec("ALTER TABLE users ADD COLUMN {$col} " . ($sq ? $sqlite : $mysql));
            }
        }
        $ins = $pdo->prepare(($sq ? 'INSERT OR IGNORE' : 'INSERT IGNORE')
            . ' INTO leave_types (code, name, default_days, unlimited, requires_attachment, color, active, sort_order, created_at)
                VALUES (:c, :n, :d, :u, :a, :col, 1, :s, :t)');
        foreach (self::SEED_TYPES as $code => [$name, $days, $unl, $att, $color, $sort]) {
            $ins->execute(['c' => $code, 'n' => $name, 'd' => $days, 'u' => $unl, 'a' => $att, 'col' => $color,
                           's' => $sort, 't' => date('Y-m-d H:i:s')]);
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
CREATE TABLE IF NOT EXISTS leave_types (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    code                TEXT UNIQUE NOT NULL,
    name                TEXT NOT NULL,
    default_days        REAL DEFAULT 0,
    unlimited           INTEGER DEFAULT 0,
    requires_attachment INTEGER DEFAULT 0,
    color               TEXT,
    active              INTEGER DEFAULT 1,
    sort_order          INTEGER DEFAULT 0,
    created_at          TEXT
)
SQL);
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS leave_balances (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    year       INTEGER NOT NULL,
    leave_type TEXT NOT NULL,
    entitled   REAL DEFAULT 0,
    used       REAL DEFAULT 0,
    updated_at TEXT,
    UNIQUE (user_id, year, leave_type)
)
SQL);
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS leaves (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    leave_no         TEXT UNIQUE,
    user_id          INTEGER NOT NULL,
    user_name        TEXT,
    person_id        TEXT,
    department       TEXT,
    leave_type       TEXT NOT NULL,
    start_date       TEXT NOT NULL,
    end_date         TEXT NOT NULL,
    half_day         INTEGER DEFAULT 0,
    half_day_period  TEXT,
    days             REAL DEFAULT 0,
    reason           TEXT,
    status           TEXT DEFAULT 'draft',
    submitted_at     TEXT,
    approver_user_id INTEGER,
    approver_name    TEXT,
    approver_remarks TEXT,
    decided_at       TEXT,
    cancelled_at     TEXT,
    cancelled_by     TEXT,
    cancel_remarks   TEXT,
    created_at       TEXT,
    updated_at       TEXT
)
SQL);
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS leave_attachments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    leave_id    INTEGER NOT NULL,
    filename    TEXT,
    stored_path TEXT,
    mime        TEXT,
    size_bytes  INTEGER,
    sha256      TEXT,
    uploaded_by INTEGER,
    created_at  TEXT
)
SQL);
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    kind       TEXT,
    title      TEXT,
    body       TEXT,
    link       TEXT,
    ref_type   TEXT,
    ref_id     INTEGER,
    read_at    TEXT,
    created_at TEXT
)
SQL);
        foreach ([
            'CREATE INDEX IF NOT EXISTS idx_lv_user    ON leaves(user_id, status)',
            'CREATE INDEX IF NOT EXISTS idx_lv_dept    ON leaves(department, status)',
            'CREATE INDEX IF NOT EXISTS idx_lv_dates   ON leaves(start_date, end_date)',
            'CREATE INDEX IF NOT EXISTS idx_la_leave   ON leave_attachments(leave_id)',
            'CREATE INDEX IF NOT EXISTS idx_nt_user    ON notifications(user_id, read_at)',
        ] as $sql) {
            $pdo->exec($sql);
        }
    }

    private static function mysql(PDO $pdo): void
    {
        $tail = ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
        $pdo->exec(<<<SQL
CREATE TABLE IF NOT EXISTS leave_types (
    id                  INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    code                VARCHAR(10) NOT NULL,
    name                VARCHAR(80) NOT NULL,
    default_days        DECIMAL(5,1) NOT NULL DEFAULT 0,
    unlimited           TINYINT NOT NULL DEFAULT 0,
    requires_attachment TINYINT NOT NULL DEFAULT 0,
    color               VARCHAR(16) NULL,
    active              TINYINT NOT NULL DEFAULT 1,
    sort_order          INT NOT NULL DEFAULT 0,
    created_at          DATETIME,
    UNIQUE KEY uq_lt_code (code)
{$tail}
SQL);
        $pdo->exec(<<<SQL
CREATE TABLE IF NOT EXISTS leave_balances (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT UNSIGNED NOT NULL,
    year       SMALLINT UNSIGNED NOT NULL,
    leave_type VARCHAR(10) NOT NULL,
    entitled   DECIMAL(5,1) NOT NULL DEFAULT 0,
    used       DECIMAL(5,1) NOT NULL DEFAULT 0,
    updated_at DATETIME,
    UNIQUE KEY uq_lb (user_id, year, leave_type)
{$tail}
SQL);
        $pdo->exec(<<<SQL
CREATE TABLE IF NOT EXISTS leaves (
    id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    leave_no         VARCHAR(30) NULL,
    user_id          BIGINT UNSIGNED NOT NULL,
    user_name        VARCHAR(120),
    person_id        VARCHAR(64) NULL,
    department       VARCHAR(80) NULL,
    leave_type       VARCHAR(10) NOT NULL,
    start_date       DATE NOT NULL,
    end_date         DATE NOT NULL,
    half_day         TINYINT NOT NULL DEFAULT 0,
    half_day_period  VARCHAR(2) NULL,
    days             DECIMAL(5,1) NOT NULL DEFAULT 0,
    reason           TEXT,
    status           VARCHAR(12) NOT NULL DEFAULT 'draft',
    submitted_at     DATETIME NULL,
    approver_user_id BIGINT UNSIGNED NULL,
    approver_name    VARCHAR(120) NULL,
    approver_remarks TEXT,
    decided_at       DATETIME NULL,
    cancelled_at     DATETIME NULL,
    cancelled_by     VARCHAR(120) NULL,
    cancel_remarks   TEXT,
    created_at       DATETIME,
    updated_at       DATETIME,
    UNIQUE KEY uq_lv_no (leave_no),
    KEY idx_lv_user (user_id, status),
    KEY idx_lv_dept (department, status),
    KEY idx_lv_dates (start_date, end_date)
{$tail}
SQL);
        $pdo->exec(<<<SQL
CREATE TABLE IF NOT EXISTS leave_attachments (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    leave_id    BIGINT UNSIGNED NOT NULL,
    filename    VARCHAR(255),
    stored_path VARCHAR(500),
    mime        VARCHAR(100),
    size_bytes  INT UNSIGNED,
    sha256      CHAR(64),
    uploaded_by BIGINT UNSIGNED NULL,
    created_at  DATETIME,
    KEY idx_la_leave (leave_id)
{$tail}
SQL);
        $pdo->exec(<<<SQL
CREATE TABLE IF NOT EXISTS notifications (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT UNSIGNED NOT NULL,
    kind       VARCHAR(40),
    title      VARCHAR(200),
    body       VARCHAR(1000),
    link       VARCHAR(255),
    ref_type   VARCHAR(20),
    ref_id     BIGINT UNSIGNED NULL,
    read_at    DATETIME NULL,
    created_at DATETIME,
    KEY idx_nt_user (user_id, read_at)
{$tail}
SQL);
    }
}
