<?php
/**
 * Driver-aware DB connection + schema migration.
 * Supports MySQL (production) and SQLite (local dev / fallback).
 * Tables are created on first use, so no manual migration step is required
 * beyond creating the MySQL database itself (done in cPanel).
 */

declare(strict_types=1);

final class Database
{
    private static ?PDO $pdo = null;
    private static string $driver = 'mysql';

    /**
     * @param array $storage The config['storage'] block:
     *   ['driver'=>'mysql'|'sqlite', 'db_path'=>..., 'mysql'=>[host,port,name,user,pass]]
     */
    public static function connect(array $storage): PDO
    {
        if (self::$pdo instanceof PDO) {
            return self::$pdo;
        }

        $driver = strtolower((string) ($storage['driver'] ?? 'mysql'));
        self::$driver = $driver === 'sqlite' ? 'sqlite' : 'mysql';

        $pdo = self::$driver === 'sqlite'
            ? self::connectSqlite((string) $storage['db_path'])
            : self::connectMysql($storage['mysql'] ?? []);

        self::$pdo = $pdo;
        self::migrate($pdo);
        return $pdo;
    }

    public static function driver(): string
    {
        return self::$driver;
    }

    private static function connectMysql(array $m): PDO
    {
        if (!extension_loaded('pdo_mysql')) {
            throw new RuntimeException('pdo_mysql extension is not available on this server.');
        }
        $host = $m['host'] ?? 'localhost';
        $port = (int) ($m['port'] ?? 3306);
        $name = $m['name'] ?? '';
        if ($name === '') {
            throw new RuntimeException('DB_DATABASE is not set.');
        }
        $dsn = "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4";

        return new PDO($dsn, $m['user'] ?? '', $m['pass'] ?? '', [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            // Emulated prepares so `LIMIT :n` bound as PARAM_INT works everywhere.
            PDO::ATTR_EMULATE_PREPARES   => true,
        ]);
    }

    private static function connectSqlite(string $path): PDO
    {
        if (!extension_loaded('pdo_sqlite')) {
            throw new RuntimeException('pdo_sqlite extension is not available on this server.');
        }
        $dir = dirname($path);
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        $pdo = new PDO('sqlite:' . $path, null, null, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        $pdo->exec('PRAGMA journal_mode = WAL;');
        $pdo->exec('PRAGMA busy_timeout = 5000;');
        $pdo->exec('PRAGMA foreign_keys = ON;');
        return $pdo;
    }

    public static function migrate(PDO $pdo): void
    {
        self::$driver === 'sqlite' ? self::migrateSqlite($pdo) : self::migrateMysql($pdo);
        self::migrateTriage($pdo);
        self::migrateIncidentOps($pdo);
        self::migrateUsers($pdo);
        self::migrateFeedKind($pdo);
        self::migratePersonId($pdo);
        self::migratePersonProfiles($pdo);
    }

    /**
     * v7: operator-created person profiles. A face detection only carries
     * SenseStudio's personId; enrolling one here gives it a name and a profile
     * photo, and every later detection of that personId renders with it.
     */
    private static function migratePersonProfiles(PDO $pdo): void
    {
        if (self::$driver === 'sqlite') {
            $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS person_profiles (
    person_id  TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    notes      TEXT,
    photo_url  TEXT,
    created_by TEXT,
    created_at TEXT,
    updated_at TEXT
)
SQL);
        } else {
            $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS person_profiles (
    person_id  VARCHAR(64) NOT NULL PRIMARY KEY,
    name       VARCHAR(160) NOT NULL,
    notes      VARCHAR(500),
    photo_url  VARCHAR(500),
    created_by VARCHAR(64),
    created_at DATETIME,
    updated_at DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
SQL);
        }
        // Profile detail fields (added after the table shipped).
        // staff_id: the employee/staff number enrolment records for the POC —
        // attendance rows and reports key on it, not on the internal personId.
        $cols = [
            'age'      => self::$driver === 'sqlite' ? 'TEXT' : 'VARCHAR(8) NULL',
            'gender'   => self::$driver === 'sqlite' ? 'TEXT' : 'VARCHAR(16) NULL',
            'staff_id' => self::$driver === 'sqlite' ? 'TEXT' : 'VARCHAR(64) NULL',
        ];
        foreach ($cols as $c => $ddl) {
            if (!self::columnExists($pdo, 'person_profiles', $c)) {
                $pdo->exec("ALTER TABLE person_profiles ADD COLUMN {$c} {$ddl}");
            }
        }
    }

    /**
     * v6: SenseStudio's tracked person identity. Every face push carries a
     * personId — including strangers (person group -99) — so all captures of
     * the same individual can be pulled together. `similarity` is the match
     * score against the enrolled photo when there is one.
     */
    private static function migratePersonId(PDO $pdo): void
    {
        if (!self::columnExists($pdo, 'events', 'person_id')) {
            $ddl = self::$driver === 'sqlite' ? 'TEXT' : 'VARCHAR(64) NULL';
            $pdo->exec("ALTER TABLE events ADD COLUMN person_id {$ddl}");
            try {
                $pdo->exec('CREATE INDEX ' . (self::$driver === 'sqlite' ? 'IF NOT EXISTS ' : '')
                    . 'idx_events_person_id ON events(person_id)');
            } catch (Throwable $e) {
                error_log('[migrate] person_id index: ' . $e->getMessage());
            }
        }
        if (!self::columnExists($pdo, 'events', 'similarity')) {
            $ddl = self::$driver === 'sqlite' ? 'TEXT' : 'VARCHAR(24) NULL';
            $pdo->exec("ALTER TABLE events ADD COLUMN similarity {$ddl}");
        }
    }

    /**
     * v5: which SenseStudio push feed delivered the event — 'face'
     * (face-recognition) or 'body' (body-attribution). Set from the ingest URL
     * (/api/ingest/face/{stream}), or inferred from the payload when absent.
     */
    private static function migrateFeedKind(PDO $pdo): void
    {
        if (!self::columnExists($pdo, 'events', 'feed_kind')) {
            $ddl = self::$driver === 'sqlite' ? 'TEXT' : 'VARCHAR(16) NULL';
            $pdo->exec("ALTER TABLE events ADD COLUMN feed_kind {$ddl}");
            $idx = 'CREATE INDEX ' . (self::$driver === 'sqlite' ? 'IF NOT EXISTS ' : '')
                 . 'idx_events_feed_kind ON events(feed_kind)';
            try {
                $pdo->exec($idx);
            } catch (Throwable $e) {
                error_log('[migrate] feed_kind index: ' . $e->getMessage());
            }
        }
    }

    /** v4: dashboard users (login + role-based access). */
    private static function migrateUsers(PDO $pdo): void
    {
        if (self::$driver === 'sqlite') {
            $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    display_name  TEXT,
    email         TEXT,
    password_hash TEXT NOT NULL,
    role          TEXT DEFAULT 'operator',
    active        INTEGER DEFAULT 1,
    last_login_at TEXT,
    created_at    TEXT
)
SQL);
        } else {
            $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS users (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username      VARCHAR(64) NOT NULL UNIQUE,
    display_name  VARCHAR(120),
    email         VARCHAR(190),
    password_hash VARCHAR(255) NOT NULL,
    role          VARCHAR(40) DEFAULT 'operator',
    active        TINYINT DEFAULT 1,
    last_login_at DATETIME NULL,
    created_at    DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
SQL);
        }
    }

    /**
     * v3: incident operations — severity escalation override on events, plus an
     * append-only incident_log (comments, status/severity changes, escalations,
     * attachments, closing remarks) powering the incident modal + change history.
     */
    private static function migrateIncidentOps(PDO $pdo): void
    {
        if (!self::columnExists($pdo, 'events', 'severity_override')) {
            $ddl = self::$driver === 'sqlite' ? 'TEXT' : 'VARCHAR(20) NULL';
            $pdo->exec("ALTER TABLE events ADD COLUMN severity_override {$ddl}");
        }
        // A detection becomes an incident TICKET only when escalated by an
        // operator (or auto-ticketed by severity) — ticketed_at + ticket_no.
        if (!self::columnExists($pdo, 'events', 'ticketed_at')) {
            $ddl = self::$driver === 'sqlite' ? 'TEXT' : 'DATETIME NULL';
            $pdo->exec("ALTER TABLE events ADD COLUMN ticketed_at {$ddl}");
        }
        if (!self::columnExists($pdo, 'events', 'ticket_no')) {
            $ddl = self::$driver === 'sqlite' ? 'TEXT' : 'VARCHAR(30) NULL';
            $pdo->exec("ALTER TABLE events ADD COLUMN ticket_no {$ddl}");
        }
        if (self::$driver === 'sqlite') {
            $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS incident_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid       TEXT NOT NULL,
    kind       TEXT NOT NULL,
    actor      TEXT,
    from_val   TEXT,
    to_val     TEXT,
    note       TEXT,
    created_at TEXT
)
SQL);
            $pdo->exec('CREATE INDEX IF NOT EXISTS idx_ilog_uuid ON incident_log(uuid)');
        } else {
            $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS incident_log (
    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    uuid       VARCHAR(191) NOT NULL,
    kind       VARCHAR(30) NOT NULL,
    actor      VARCHAR(100),
    from_val   VARCHAR(100),
    to_val     VARCHAR(100),
    note       TEXT,
    created_at DATETIME,
    KEY idx_ilog_uuid (uuid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
SQL);
        }
    }

    /**
     * v2: incident triage columns (server-side ack/resolve tracking so
     * "avg time to acknowledge" is computed from real recorded response times).
     */
    private static function migrateTriage(PDO $pdo): void
    {
        $cols = [
            'status'      => self::$driver === 'sqlite' ? "TEXT DEFAULT 'open'" : "VARCHAR(20) DEFAULT 'open'",
            'assignee'    => self::$driver === 'sqlite' ? 'TEXT' : 'VARCHAR(100)',
            'acked_at'    => self::$driver === 'sqlite' ? 'TEXT' : 'DATETIME NULL',
            'resolved_at' => self::$driver === 'sqlite' ? 'TEXT' : 'DATETIME NULL',
        ];
        foreach ($cols as $name => $ddl) {
            if (!self::columnExists($pdo, 'events', $name)) {
                $pdo->exec("ALTER TABLE events ADD COLUMN {$name} {$ddl}");
            }
        }
    }

    private static function columnExists(PDO $pdo, string $table, string $column): bool
    {
        if (self::$driver === 'sqlite') {
            foreach ($pdo->query("PRAGMA table_info({$table})") as $row) {
                if (strcasecmp((string) $row['name'], $column) === 0) {
                    return true;
                }
            }
            return false;
        }
        $stmt = $pdo->prepare(
            'SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c'
        );
        $stmt->execute(['t' => $table, 'c' => $column]);
        return (int) $stmt->fetchColumn() > 0;
    }

    private static function migrateMysql(PDO $pdo): void
    {
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS events (
    id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    uuid               VARCHAR(191),
    trigger_event_id   VARCHAR(191),
    stream             VARCHAR(191),
    msg_source         VARCHAR(100),
    event_type         VARCHAR(100),
    policy_id          VARCHAR(191),
    policy_name        VARCHAR(191),
    policy_type        VARCHAR(50),
    policy_desc        VARCHAR(255),
    trigger_image_type VARCHAR(100),
    device_id          VARCHAR(191),
    device_serial      VARCHAR(191),
    device_name        VARCHAR(191),
    device_tag         VARCHAR(191),
    alert_level        VARCHAR(20),
    person_name        VARCHAR(191),
    trigger_time       VARCHAR(40),
    trigger_img_url    TEXT,
    bk_image_url       TEXT,
    match_image_url    TEXT,
    detect_json        TEXT,
    attributes_json    MEDIUMTEXT,
    decoded_json       MEDIUMTEXT,
    raw_json           LONGTEXT,
    remote_ip          VARCHAR(64),
    received_at        DATETIME,
    KEY idx_events_stream        (stream),
    KEY idx_events_received      (received_at),
    KEY idx_events_trigger_time  (trigger_time),
    KEY idx_events_uuid          (uuid),
    KEY idx_events_img_type      (trigger_image_type),
    KEY idx_events_device_serial (device_serial)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
SQL);

        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS event_attributes (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    event_id     BIGINT UNSIGNED NOT NULL,
    attr_key     VARCHAR(20),
    feature_name VARCHAR(100),
    category     VARCHAR(50),
    value        VARCHAR(100),
    value_name   VARCHAR(100),
    conf         DOUBLE,
    KEY idx_attr_event   (event_id),
    KEY idx_attr_feature (feature_name, value_name),
    CONSTRAINT fk_attr_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
SQL);
    }

    private static function migrateSqlite(PDO $pdo): void
    {
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS events (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid               TEXT,
    trigger_event_id   TEXT,
    stream             TEXT,
    msg_source         TEXT,
    event_type         TEXT,
    policy_id          TEXT,
    policy_name        TEXT,
    policy_type        TEXT,
    policy_desc        TEXT,
    trigger_image_type TEXT,
    device_id          TEXT,
    device_serial      TEXT,
    device_name        TEXT,
    device_tag         TEXT,
    alert_level        TEXT,
    person_name        TEXT,
    trigger_time       TEXT,
    trigger_img_url    TEXT,
    bk_image_url       TEXT,
    match_image_url    TEXT,
    detect_json        TEXT,
    attributes_json    TEXT,
    decoded_json       TEXT,
    raw_json           TEXT,
    remote_ip          TEXT,
    received_at        TEXT
)
SQL);

        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS event_attributes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     INTEGER NOT NULL,
    attr_key     TEXT,
    feature_name TEXT,
    category     TEXT,
    value        TEXT,
    value_name   TEXT,
    conf         REAL,
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
)
SQL);

        foreach ([
            'CREATE INDEX IF NOT EXISTS idx_events_stream        ON events(stream)',
            'CREATE INDEX IF NOT EXISTS idx_events_received      ON events(received_at)',
            'CREATE INDEX IF NOT EXISTS idx_events_trigger_time  ON events(trigger_time)',
            'CREATE INDEX IF NOT EXISTS idx_events_uuid          ON events(uuid)',
            'CREATE INDEX IF NOT EXISTS idx_events_img_type      ON events(trigger_image_type)',
            'CREATE INDEX IF NOT EXISTS idx_events_device_serial ON events(device_serial)',
            'CREATE INDEX IF NOT EXISTS idx_attr_event           ON event_attributes(event_id)',
            'CREATE INDEX IF NOT EXISTS idx_attr_feature         ON event_attributes(feature_name, value_name)',
        ] as $sql) {
            $pdo->exec($sql);
        }
    }
}
