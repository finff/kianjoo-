<?php
/**
 * Server-side principal + RBAC tier for every AI / ticket / report route.
 *
 * The session user is resolved on EVERY request (never trusted from the
 * request body) and re-checked against the `users` row, so a deactivated
 * account loses access immediately. Permissions come from the existing role
 * system (Auth::permsFor + storage/roles.json overrides); on top of that each
 * role maps to a data tier:
 *
 *   staff       operator, viewer (and custom roles without settings/users perms)
 *               → own profile / attendance / leave / tickets only
 *   supervisor  supervisor (or custom role with `settings`)
 *               → + team attendance, leave approvals, all tickets
 *   admin       admin, superadmin (or custom role with `users`)
 *               → everything, incl. camera / detection data
 */

declare(strict_types=1);

require_once __DIR__ . '/Auth.php';

final class AiGuard
{
    public const TIER_RANK = ['staff' => 1, 'supervisor' => 2, 'admin' => 3];

    public static function tierOf(string $role, array $perms): string
    {
        $r = strtolower(trim($role));
        if (in_array($r, ['superadmin', 'admin'], true)) {
            return 'admin';
        }
        if ($r === 'supervisor') {
            return 'supervisor';
        }
        if (in_array($r, ['operator', 'viewer', 'staff'], true)) {
            return 'staff';
        }
        if (!empty($perms['users'])) {
            return 'admin';
        }
        if (!empty($perms['settings'])) {
            return 'supervisor';
        }
        return 'staff';
    }

    /**
     * The caller, or null when nobody is signed in.
     *
     * @param array|null $provision  Synthetic admin from the provision token (scripts/cron).
     * @return array{id:int, username:string, name:string, role:string, tier:string, perms:array,
     *               person_id:?string, department:string, plant:string, provision:bool}|null
     */
    public static function principal(PDO $pdo, ?array $provision = null): ?array
    {
        $u = Auth::user();
        // Release the session lock: AI calls can take minutes and must not
        // block the same user's 5 s feed polls. (We only read the session.)
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_write_close();
        }
        if ($u === null) {
            if ($provision === null) {
                return null;
            }
            return ['id' => 0, 'username' => 'provision', 'name' => 'System (provision token)', 'role' => 'admin',
                    'tier' => 'admin', 'perms' => Auth::DEFAULT_ROLES['admin']['perms'], 'person_id' => null,
                    'department' => '', 'plant' => '', 'provision' => true];
        }

        // Re-validate against the DB: deactivated / deleted users lose access now.
        $row = null;
        try {
            $st = $pdo->prepare('SELECT * FROM users WHERE id = :id LIMIT 1');
            $st->execute(['id' => (int) $u['id']]);
            $row = $st->fetch() ?: null;
        } catch (Throwable $e) {
            error_log('[aiguard] ' . $e->getMessage());
        }
        if (!$row || (int) ($row['active'] ?? 0) !== 1) {
            return null;
        }
        $role  = (string) ($row['role'] ?: 'operator');
        $roles = Auth::roles();
        $perms = isset($roles[$role]) ? $roles[$role]['perms']
               : ($role === 'superadmin' ? Auth::DEFAULT_ROLES['admin']['perms'] : Auth::permsFor($role));

        // Link to a person profile: explicit users.person_id, else a profile
        // whose staff_id equals the login name (staff-number logins).
        $pid  = trim((string) ($row['person_id'] ?? ''));
        $prof = null;
        try {
            if ($pid !== '') {
                $st = $pdo->prepare('SELECT * FROM person_profiles WHERE person_id = :p LIMIT 1');
                $st->execute(['p' => $pid]);
            } else {
                $st = $pdo->prepare('SELECT * FROM person_profiles WHERE staff_id = :s LIMIT 1');
                $st->execute(['s' => (string) $row['username']]);
            }
            $prof = $st->fetch() ?: null;
        } catch (Throwable $e) {
            $prof = null;
        }
        if ($pid === '' && $prof) {
            $pid = (string) $prof['person_id'];
        }

        return [
            'id'         => (int) $row['id'],
            'username'   => (string) $row['username'],
            'name'       => (string) ($row['display_name'] ?: $row['username']),
            'role'       => $role,
            'tier'       => self::tierOf($role, $perms),
            'perms'      => $perms,
            'person_id'  => $pid !== '' ? $pid : null,
            'department' => (string) ($prof['department'] ?? ''),
            'plant'      => (string) ($prof['plant'] ?? ''),
            'provision'  => false,
        ];
    }

    /** principal() or a 401 response. */
    public static function require(PDO $pdo, ?array $provision = null): array
    {
        $p = self::principal($pdo, $provision);
        if ($p === null) {
            Response::error('Sign in required.', 401);
        }
        return $p;
    }

    public static function atLeast(array $p, string $tier): bool
    {
        return (self::TIER_RANK[$p['tier']] ?? 0) >= (self::TIER_RANK[$tier] ?? 99);
    }

    public static function can(array $p, string $perm): bool
    {
        return !empty($p['perms'][$perm]);
    }

    /** 403 unless the principal has the tier (and perm, when given). */
    public static function demand(array $p, string $tier, ?string $perm = null): void
    {
        if (!self::atLeast($p, $tier) || ($perm !== null && !self::can($p, $perm))) {
            Response::error('Forbidden: your role (' . $p['role'] . ') cannot do this.', 403);
        }
    }
}
