<?php
/**
 * Schema for the three face sides per employee (front / left / right).
 * Called from Database::migrate(); works on MySQL and SQLite. Same pattern as
 * lib/HrSchema.php (VERSION + storage/face_schema.ver marker).
 *
 *   person_profiles.photo_url    FRONT face (existing column, unchanged — every
 *                                other module keeps reading it as `photo`)
 *   person_profiles.photo_left   left side (~45°), dashboard URL
 *   person_profiles.photo_right  right side (~45°), dashboard URL
 *   person_profiles.ss_faces     JSON: last SenseStudio verdict per side
 *                                {front|left|right: {state, msg, src, uri?, at}}
 *
 * Only ADD COLUMN — never drops or rewrites data. Skipped when the marker
 * already records this version for this database.
 */

declare(strict_types=1);

require_once __DIR__ . '/AiSchema.php';

final class FaceSchema
{
    public const VERSION = 1;

    /** column => [sqlite DDL, mysql DDL] */
    private const COLS = [
        'photo_left'  => ['TEXT', 'VARCHAR(500) NULL'],
        'photo_right' => ['TEXT', 'VARCHAR(500) NULL'],
        'ss_faces'    => ['TEXT', 'TEXT NULL'],
    ];

    public static function migrate(PDO $pdo, string $driver, ?string $storageDir = null, bool $force = false): void
    {
        $sq     = $driver === 'sqlite';
        $marker = $storageDir ? rtrim($storageDir, '/') . '/face_schema.ver' : null;
        $tag    = self::VERSION . ':' . $driver . ':' . md5(self::dbName($pdo, $sq));
        if (!$force && $marker && is_file($marker) && trim((string) @file_get_contents($marker)) === $tag) {
            return;
        }
        foreach (self::COLS as $col => [$sqlite, $mysql]) {
            if (!AiSchema::columnExists($pdo, $sq, 'person_profiles', $col)) {
                $pdo->exec("ALTER TABLE person_profiles ADD COLUMN {$col} " . ($sq ? $sqlite : $mysql));
            }
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
}
