<?php
/**
 * Schema for the AI layer + ITSM tickets (M7 / M8 / M9 / M12).
 * Called from Database::migrate(); works on MySQL and SQLite.
 *
 *   tickets            ITSM ticket (manual or AI pipeline), SLA deadlines + breach flags
 *   ticket_messages    communication thread + status-change / system entries
 *   ticket_attachments file metadata (uploads + WebP proof images)
 *   ai_person_state    PPE-forklift pipeline: last review per person_id (rate gate)
 *   ai_reviews         every Claude vision review (audit trail, verdict JSON)
 *   ai_reports         generated reports (M12)
 *   users.person_id    links a login to its person_profiles row (staff self-scope)
 *   tickets.*_breach_mailed  v2: SLA-breach e-mail sent flags (lib/NotifyMail.php)
 *   events.group_*     v3: incident episodes (lib/IncidentGroups.php) — group_id = id of the
 *                      episode's first event (leader row: group_id = id), group_key = episode
 *                      key hash, group_count / group_last_at kept on the leader row
 *   ai_reviews.human_* v3: reviewer decision on a low-confidence AI review
 *   review_queue       v3: "Needs review" queue (lib/ReviewQueue.php)
 *
 * The CREATE/ALTER pass is skipped when storage/ai_schema.ver already records
 * this version for this database (Database::migrate runs on every request).
 */

declare(strict_types=1);

final class AiSchema
{
    public const VERSION = 3;

    /** True once this request knows the v3 episode columns exist on `events` (IncidentGroups::ready()). */
    public static bool $groupsReady = false;

    public static function migrate(PDO $pdo, string $driver, ?string $storageDir = null, bool $force = false): void
    {
        $sq     = $driver === 'sqlite';
        $marker = $storageDir ? rtrim($storageDir, '/') . '/ai_schema.ver' : null;
        $tag    = self::VERSION . ':' . $driver . ':' . md5((string) self::dbName($pdo, $sq));
        if (!$force && $marker && is_file($marker) && trim((string) @file_get_contents($marker)) === $tag) {
            self::$groupsReady = true;
            return;
        }
        $sq ? self::sqlite($pdo) : self::mysql($pdo);
        $ok = self::migrateV3($pdo, $sq);
        if (!self::columnExists($pdo, $sq, 'users', 'person_id')) {
            $pdo->exec('ALTER TABLE users ADD COLUMN person_id ' . ($sq ? 'TEXT' : 'VARCHAR(64) NULL'));
        }
        // v2: SLA-breach e-mail sent flags (NotifyMail, once per ticket per type).
        // Backfill: tickets already past a deadline count as mailed — no burst on deploy.
        foreach (['response', 'resolution'] as $k) {
            if (!self::columnExists($pdo, $sq, 'tickets', $k . '_breach_mailed')) {
                $pdo->exec('ALTER TABLE tickets ADD COLUMN ' . $k . '_breach_mailed ' . ($sq ? 'INTEGER DEFAULT 0' : 'TINYINT NOT NULL DEFAULT 0'));
                $pdo->prepare('UPDATE tickets SET ' . $k . '_breach_mailed = 1 WHERE ' . $k . '_due_at IS NOT NULL AND ' . $k . '_due_at < :n')
                    ->execute(['n' => date('Y-m-d H:i:s')]);
            }
        }
        // A failed v3 step (e.g. a concurrent request still altering `events`) leaves the
        // marker unwritten so the next request retries; this request runs without episodes.
        self::$groupsReady = $ok;
        if ($marker && $ok) {
            @file_put_contents($marker, $tag, LOCK_EX);
        }
    }

    /**
     * v3: incident episodes on `events`, human review columns on ai_reviews, review_queue.
     * Every step is idempotent and individually guarded — on a large MySQL `events`
     * table the ALTERs can race a concurrent first request; the loser re-checks.
     */
    private static function migrateV3(PDO $pdo, bool $sq): bool
    {
        $ok = true;
        $col = static function (string $table, string $name, string $sqlite, string $mysql) use ($pdo, $sq, &$ok): void {
            try {
                if (!self::columnExists($pdo, $sq, $table, $name)) {
                    $pdo->exec("ALTER TABLE {$table} ADD COLUMN {$name} " . ($sq ? $sqlite : $mysql));
                }
            } catch (Throwable $e) {
                if (!self::columnExists($pdo, $sq, $table, $name)) {
                    error_log('[ai_schema v3] ' . $table . '.' . $name . ': ' . $e->getMessage());
                    $ok = false;
                }
            }
        };
        $col('events', 'group_id', 'INTEGER', 'BIGINT UNSIGNED NULL');
        $col('events', 'group_key', 'TEXT', 'CHAR(40) NULL');
        $col('events', 'group_count', 'INTEGER', 'INT NULL');
        $col('events', 'group_last_at', 'TEXT', 'DATETIME NULL');
        foreach (['human_verdict' => ['TEXT', 'VARCHAR(20) NULL'], 'human_user' => ['TEXT', 'VARCHAR(120) NULL'],
                  'human_note' => ['TEXT', 'TEXT NULL'], 'human_at' => ['TEXT', 'DATETIME NULL']] as $name => [$s, $m]) {
            $col('ai_reviews', $name, $s, $m);
        }
        foreach (['idx_events_group' => 'group_id', 'idx_events_gkey' => 'group_key, id'] as $idx => $cols) {
            try {
                if ($sq) {
                    $pdo->exec("CREATE INDEX IF NOT EXISTS {$idx} ON events({$cols})");
                } else {
                    $st = $pdo->prepare("SELECT COUNT(*) FROM information_schema.STATISTICS
                        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND INDEX_NAME = :i");
                    $st->execute(['i' => $idx]);
                    if ((int) $st->fetchColumn() === 0) {
                        $pdo->exec("CREATE INDEX {$idx} ON events ({$cols})");
                    }
                }
            } catch (Throwable $e) {
                error_log('[ai_schema v3] ' . $idx . ': ' . $e->getMessage());
                $ok = false;
            }
        }
        try {
            if ($sq) {
                $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS review_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source        TEXT NOT NULL,
    event_id      INTEGER,
    event_uuid    TEXT,
    review_id     INTEGER,
    dedup_key     TEXT,
    module        TEXT,
    title         TEXT,
    confidence    REAL,
    reason        TEXT,
    camera        TEXT,
    location      TEXT,
    person_id     TEXT,
    person_name   TEXT,
    image_url     TEXT,
    image_path    TEXT,
    hits          INTEGER DEFAULT 1,
    last_seen_at  TEXT,
    meta_json     TEXT,
    status        TEXT DEFAULT 'pending',
    human_user    TEXT,
    human_user_id INTEGER,
    human_note    TEXT,
    human_at      TEXT,
    ticket_ref    TEXT,
    created_at    TEXT
)
SQL);
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_rq_status ON review_queue(status, id)');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_rq_dedup ON review_queue(dedup_key, status)');
                $pdo->exec('CREATE INDEX IF NOT EXISTS idx_rq_event ON review_queue(event_id)');
            } else {
                $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS review_queue (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    source        VARCHAR(10) NOT NULL,
    event_id      BIGINT UNSIGNED NULL,
    event_uuid    VARCHAR(191) NULL,
    review_id     BIGINT UNSIGNED NULL,
    dedup_key     VARCHAR(191) NULL,
    module        VARCHAR(20) NULL,
    title         VARCHAR(255) NULL,
    confidence    DOUBLE NULL,
    reason        TEXT,
    camera        VARCHAR(191) NULL,
    location      VARCHAR(120) NULL,
    person_id     VARCHAR(64) NULL,
    person_name   VARCHAR(160) NULL,
    image_url     TEXT,
    image_path    VARCHAR(500) NULL,
    hits          INT NOT NULL DEFAULT 1,
    last_seen_at  DATETIME NULL,
    meta_json     TEXT,
    status        VARCHAR(20) NOT NULL DEFAULT 'pending',
    human_user    VARCHAR(120) NULL,
    human_user_id BIGINT UNSIGNED NULL,
    human_note    TEXT,
    human_at      DATETIME NULL,
    ticket_ref    VARCHAR(40) NULL,
    created_at    DATETIME,
    KEY idx_rq_status (status, id),
    KEY idx_rq_dedup (dedup_key, status),
    KEY idx_rq_event (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
SQL);
            }
        } catch (Throwable $e) {
            error_log('[ai_schema v3] review_queue: ' . $e->getMessage());
            $ok = false;
        }
        return $ok;
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

    public static function columnExists(PDO $pdo, bool $sq, string $table, string $column): bool
    {
        if ($sq) {
            foreach ($pdo->query("PRAGMA table_info({$table})") as $row) {
                if (strcasecmp((string) $row['name'], $column) === 0) {
                    return true;
                }
            }
            return false;
        }
        $st = $pdo->prepare('SELECT COUNT(*) FROM information_schema.COLUMNS
                             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t AND COLUMN_NAME = :c');
        $st->execute(['t' => $table, 'c' => $column]);
        return (int) $st->fetchColumn() > 0;
    }

    public static function tableExists(PDO $pdo, string $table): bool
    {
        try {
            $pdo->query('SELECT 1 FROM ' . preg_replace('/[^a-z0-9_]/i', '', $table) . ' LIMIT 1');
            return true;
        } catch (Throwable $e) {
            return false;
        }
    }

    private static function sqlite(PDO $pdo): void
    {
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS tickets (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_no           TEXT UNIQUE,
    title               TEXT NOT NULL,
    description         TEXT,
    category            TEXT DEFAULT 'general',
    source              TEXT DEFAULT 'manual',
    priority            TEXT DEFAULT 'medium',
    status              TEXT DEFAULT 'new',
    requester_user_id   INTEGER,
    requester_name      TEXT,
    assignee_user_id    INTEGER,
    assignee_name       TEXT,
    person_id           TEXT,
    location            TEXT,
    camera              TEXT,
    event_id            INTEGER,
    dedup_key           TEXT UNIQUE,
    event_first_at      TEXT,
    event_last_at       TEXT,
    detection_count     INTEGER DEFAULT 0,
    response_due_at     TEXT,
    resolution_due_at   TEXT,
    first_response_at   TEXT,
    acked_at            TEXT,
    in_progress_at      TEXT,
    resolved_at         TEXT,
    closed_at           TEXT,
    closing_remarks     TEXT,
    resolution_code     TEXT,
    response_breached   INTEGER DEFAULT 0,
    resolution_breached INTEGER DEFAULT 0,
    meta_json           TEXT,
    created_at          TEXT,
    updated_at          TEXT
)
SQL);
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS ticket_messages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id      INTEGER NOT NULL,
    author_user_id INTEGER,
    author_name    TEXT,
    kind           TEXT DEFAULT 'comment',
    body           TEXT,
    from_status    TEXT,
    to_status      TEXT,
    internal       INTEGER DEFAULT 0,
    created_at     TEXT
)
SQL);
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS ticket_attachments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id   INTEGER NOT NULL,
    message_id  INTEGER,
    kind        TEXT DEFAULT 'file',
    filename    TEXT,
    stored_path TEXT,
    mime        TEXT,
    size_bytes  INTEGER,
    sha256      TEXT,
    event_id    INTEGER,
    uploaded_by TEXT,
    created_at  TEXT
)
SQL);
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS ai_person_state (
    person_id         TEXT PRIMARY KEY,
    last_review_at    TEXT,
    last_event_id     INTEGER,
    last_verdict      TEXT,
    reviews           INTEGER DEFAULT 0,
    updated_at        TEXT
)
SQL);
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS ai_reviews (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     INTEGER,
    event_uuid   TEXT,
    person_id    TEXT,
    location     TEXT,
    camera       TEXT,
    kind         TEXT DEFAULT 'ppe_forklift',
    model        TEXT,
    violation    INTEGER DEFAULT 0,
    confidence   REAL,
    verdict_json TEXT,
    ticket_id    INTEGER,
    tokens_in    INTEGER,
    tokens_out   INTEGER,
    error        TEXT,
    created_at   TEXT
)
SQL);
        $pdo->exec(<<<'SQL'
CREATE TABLE IF NOT EXISTS ai_reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    report_no    TEXT UNIQUE,
    user_id      INTEGER,
    user_name    TEXT,
    role         TEXT,
    tier         TEXT,
    scope        TEXT,
    range_from   TEXT,
    range_to     TEXT,
    model        TEXT,
    status       TEXT,
    title        TEXT,
    summary      TEXT,
    content_json TEXT,
    file_path    TEXT,
    tokens_in    INTEGER,
    tokens_out   INTEGER,
    error        TEXT,
    created_at   TEXT
)
SQL);
        foreach ([
            'CREATE INDEX IF NOT EXISTS idx_tk_status   ON tickets(status, priority)',
            'CREATE INDEX IF NOT EXISTS idx_tk_req      ON tickets(requester_user_id)',
            'CREATE INDEX IF NOT EXISTS idx_tk_person   ON tickets(person_id, location, category)',
            'CREATE INDEX IF NOT EXISTS idx_tk_created  ON tickets(created_at)',
            'CREATE INDEX IF NOT EXISTS idx_tm_ticket   ON ticket_messages(ticket_id)',
            'CREATE INDEX IF NOT EXISTS idx_ta_ticket   ON ticket_attachments(ticket_id)',
            'CREATE INDEX IF NOT EXISTS idx_air_person  ON ai_reviews(person_id, created_at)',
            'CREATE INDEX IF NOT EXISTS idx_air_event   ON ai_reviews(event_id)',
            'CREATE INDEX IF NOT EXISTS idx_airep_user  ON ai_reports(user_id, created_at)',
        ] as $sql) {
            $pdo->exec($sql);
        }
    }

    private static function mysql(PDO $pdo): void
    {
        $tail = ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';
        $pdo->exec(<<<SQL
CREATE TABLE IF NOT EXISTS tickets (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    ticket_no           VARCHAR(30) NULL,
    title               VARCHAR(255) NOT NULL,
    description         TEXT,
    category            VARCHAR(40) DEFAULT 'general',
    source              VARCHAR(20) DEFAULT 'manual',
    priority            VARCHAR(10) DEFAULT 'medium',
    status              VARCHAR(20) DEFAULT 'new',
    requester_user_id   BIGINT UNSIGNED NULL,
    requester_name      VARCHAR(120),
    assignee_user_id    BIGINT UNSIGNED NULL,
    assignee_name       VARCHAR(120),
    person_id           VARCHAR(64) NULL,
    location            VARCHAR(120) NULL,
    camera              VARCHAR(191) NULL,
    event_id            BIGINT UNSIGNED NULL,
    dedup_key           VARCHAR(191) NULL,
    event_first_at      DATETIME NULL,
    event_last_at       DATETIME NULL,
    detection_count     INT DEFAULT 0,
    response_due_at     DATETIME NULL,
    resolution_due_at   DATETIME NULL,
    first_response_at   DATETIME NULL,
    acked_at            DATETIME NULL,
    in_progress_at      DATETIME NULL,
    resolved_at         DATETIME NULL,
    closed_at           DATETIME NULL,
    closing_remarks     TEXT,
    resolution_code     VARCHAR(40) NULL,
    response_breached   TINYINT NOT NULL DEFAULT 0,
    resolution_breached TINYINT NOT NULL DEFAULT 0,
    meta_json           TEXT,
    created_at          DATETIME,
    updated_at          DATETIME,
    UNIQUE KEY uq_tk_no (ticket_no),
    UNIQUE KEY uq_tk_dedup (dedup_key),
    KEY idx_tk_status (status, priority),
    KEY idx_tk_req (requester_user_id),
    KEY idx_tk_person (person_id, location, category),
    KEY idx_tk_created (created_at)
{$tail}
SQL);
        $pdo->exec(<<<SQL
CREATE TABLE IF NOT EXISTS ticket_messages (
    id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    ticket_id      BIGINT UNSIGNED NOT NULL,
    author_user_id BIGINT UNSIGNED NULL,
    author_name    VARCHAR(120),
    kind           VARCHAR(20) DEFAULT 'comment',
    body           TEXT,
    from_status    VARCHAR(20) NULL,
    to_status      VARCHAR(20) NULL,
    internal       TINYINT NOT NULL DEFAULT 0,
    created_at     DATETIME,
    KEY idx_tm_ticket (ticket_id)
{$tail}
SQL);
        $pdo->exec(<<<SQL
CREATE TABLE IF NOT EXISTS ticket_attachments (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    ticket_id   BIGINT UNSIGNED NOT NULL,
    message_id  BIGINT UNSIGNED NULL,
    kind        VARCHAR(20) DEFAULT 'file',
    filename    VARCHAR(255),
    stored_path VARCHAR(500),
    mime        VARCHAR(100),
    size_bytes  INT UNSIGNED,
    sha256      CHAR(64),
    event_id    BIGINT UNSIGNED NULL,
    uploaded_by VARCHAR(120),
    created_at  DATETIME,
    KEY idx_ta_ticket (ticket_id)
{$tail}
SQL);
        $pdo->exec(<<<SQL
CREATE TABLE IF NOT EXISTS ai_person_state (
    person_id      VARCHAR(64) NOT NULL PRIMARY KEY,
    last_review_at DATETIME NULL,
    last_event_id  BIGINT UNSIGNED NULL,
    last_verdict   VARCHAR(20) NULL,
    reviews        INT DEFAULT 0,
    updated_at     DATETIME
{$tail}
SQL);
        $pdo->exec(<<<SQL
CREATE TABLE IF NOT EXISTS ai_reviews (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    event_id     BIGINT UNSIGNED NULL,
    event_uuid   VARCHAR(191) NULL,
    person_id    VARCHAR(64) NULL,
    location     VARCHAR(120) NULL,
    camera       VARCHAR(191) NULL,
    kind         VARCHAR(30) DEFAULT 'ppe_forklift',
    model        VARCHAR(60),
    violation    TINYINT NOT NULL DEFAULT 0,
    confidence   DOUBLE NULL,
    verdict_json TEXT,
    ticket_id    BIGINT UNSIGNED NULL,
    tokens_in    INT NULL,
    tokens_out   INT NULL,
    error        VARCHAR(255) NULL,
    created_at   DATETIME,
    KEY idx_air_person (person_id, created_at),
    KEY idx_air_event (event_id)
{$tail}
SQL);
        $pdo->exec(<<<SQL
CREATE TABLE IF NOT EXISTS ai_reports (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    report_no    VARCHAR(30) NULL,
    user_id      BIGINT UNSIGNED NULL,
    user_name    VARCHAR(120),
    role         VARCHAR(40),
    tier         VARCHAR(20),
    scope        VARCHAR(30),
    range_from   DATE NULL,
    range_to     DATE NULL,
    model        VARCHAR(60),
    status       VARCHAR(20),
    title        VARCHAR(255),
    summary      TEXT,
    content_json MEDIUMTEXT,
    file_path    VARCHAR(500),
    tokens_in    INT NULL,
    tokens_out   INT NULL,
    error        VARCHAR(255) NULL,
    created_at   DATETIME,
    UNIQUE KEY uq_airep_no (report_no),
    KEY idx_airep_user (user_id, created_at)
{$tail}
SQL);
    }
}
