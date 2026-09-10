<?php
/**
 * Dashboard authentication + role-based access.
 *
 * Users live in the `users` table (migration v4); roles + permissions are
 * built-in defaults overridable from the dashboard via storage/roles.json.
 * Sessions are plain PHP sessions — the SenseStudio ingest/read token APIs
 * are unaffected (machine-to-machine stays token-based).
 */

declare(strict_types=1);

final class Auth
{
    /** Permission keys shown in Role Management. */
    public const PERMS = [
        'view'     => 'View dashboard & detections',
        'triage'   => 'Acknowledge / resolve detections',
        'tickets'  => 'Incident tickets (comment, escalate, close, attach)',
        'reports'  => 'Send reports & exports',
        'settings' => 'Alert Rules & Settings pages',
        'users'    => 'User & role management',
    ];

    /** Built-in roles (overridable via storage/roles.json). */
    public const DEFAULT_ROLES = [
        'admin'      => ['desc' => 'Full access incl. user management',
                         'perms' => ['view' => true, 'triage' => true, 'tickets' => true, 'reports' => true, 'settings' => true, 'users' => true]],
        'supervisor' => ['desc' => 'Operations lead — everything except user management',
                         'perms' => ['view' => true, 'triage' => true, 'tickets' => true, 'reports' => true, 'settings' => true, 'users' => false]],
        'operator'   => ['desc' => 'SOC operator — triage and ticket handling',
                         'perms' => ['view' => true, 'triage' => true, 'tickets' => true, 'reports' => false, 'settings' => false, 'users' => false]],
        'viewer'     => ['desc' => 'Read-only dashboard access',
                         'perms' => ['view' => true, 'triage' => false, 'tickets' => false, 'reports' => false, 'settings' => false, 'users' => false]],
    ];

    private static function rolesFile(): string
    {
        return APP_ROOT . '/storage/roles.json';
    }

    /** Effective roles: defaults merged with the dashboard-managed overlay. */
    public static function roles(): array
    {
        $roles = self::DEFAULT_ROLES;
        $file  = self::rolesFile();
        if (is_file($file)) {
            $o = json_decode((string) file_get_contents($file), true);
            if (is_array($o)) {
                foreach ($o as $name => $def) {
                    if (!is_array($def)) {
                        continue;
                    }
                    $perms = [];
                    foreach (array_keys(self::PERMS) as $p) {
                        $perms[$p] = !empty($def['perms'][$p]);
                    }
                    $roles[$name] = ['desc' => (string) ($def['desc'] ?? ($roles[$name]['desc'] ?? '')), 'perms' => $perms];
                }
            }
        }
        // admin can never lose the users permission (lock-out guard)
        $roles['admin']['perms']['users'] = true;
        $roles['admin']['perms']['view']  = true;
        return $roles;
    }

    public static function saveRoles(array $roles): bool
    {
        return (bool) file_put_contents(self::rolesFile(),
            json_encode($roles, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
    }

    public static function permsFor(string $role): array
    {
        $roles = self::roles();
        return $roles[$role]['perms'] ?? $roles['viewer']['perms'];
    }

    public static function session(): void
    {
        if (session_status() !== PHP_SESSION_ACTIVE) {
            session_name('TMNSSESS');
            session_start();
        }
    }

    /** Currently logged-in user (from session), or null. */
    public static function user(): ?array
    {
        self::session();
        $u = $_SESSION['tmns_user'] ?? null;
        return is_array($u) ? $u : null;
    }

    public static function can(string $perm): bool
    {
        $u = self::user();
        return $u !== null && !empty(self::permsFor((string) $u['role'])[$perm]);
    }

    /** Create the default admin on first run so login is possible. */
    public static function ensureSeedAdmin(PDO $pdo): void
    {
        $n = (int) $pdo->query('SELECT COUNT(*) FROM users')->fetchColumn();
        if ($n > 0) {
            return;
        }
        $stmt = $pdo->prepare(
            'INSERT INTO users (username, display_name, email, password_hash, role, active, created_at)
             VALUES (:u, :d, :e, :p, :r, 1, :now)'
        );
        $stmt->execute([
            'u' => 'admin', 'd' => 'Administrator', 'e' => '',
            'p' => password_hash('tmone2026', PASSWORD_DEFAULT),
            'r' => 'admin', 'now' => date('Y-m-d H:i:s'),
        ]);
    }

    /** Verify credentials; on success populate the session and return the user. */
    public static function attempt(PDO $pdo, string $username, string $password): ?array
    {
        self::ensureSeedAdmin($pdo);
        $stmt = $pdo->prepare('SELECT * FROM users WHERE username = :u LIMIT 1');
        $stmt->execute(['u' => trim($username)]);
        $row = $stmt->fetch();
        if (!$row || (int) $row['active'] !== 1 || !password_verify($password, (string) $row['password_hash'])) {
            return null;
        }
        $pdo->prepare('UPDATE users SET last_login_at = :now WHERE id = :id')
            ->execute(['now' => date('Y-m-d H:i:s'), 'id' => $row['id']]);
        self::session();
        session_regenerate_id(true);
        $_SESSION['tmns_user'] = [
            'id'   => (int) $row['id'],
            'username' => $row['username'],
            'name' => $row['display_name'] ?: $row['username'],
            'role' => $row['role'] ?: 'operator',
        ];
        return $_SESSION['tmns_user'];
    }

    public static function logout(): void
    {
        self::session();
        $_SESSION = [];
        session_destroy();
    }
}
