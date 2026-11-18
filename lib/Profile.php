<?php
/**
 * Staff profile self-service (M4/M6 backend).
 *
 * A signed-in user may change ONLY: display_name, phone, emergency contact
 * (name / phone / relation) and their profile photo. username, email, role and
 * active stay admin-only (Users & Roles, /api/users) — any such keys in the
 * request body are ignored, never applied.
 *
 * Photos are re-encoded to WebP (lib/ImageTool.php) under uploads/profiles/
 * as u{userId}-{stamp}-{rand}.webp; the previous self-service photo of the
 * same user is deleted.
 */

declare(strict_types=1);

require_once __DIR__ . '/ImageTool.php';
require_once __DIR__ . '/Faces.php';

final class Profile
{
    public const EDITABLE = ['display_name' => 120, 'phone' => 40, 'emergency_name' => 120,
                             'emergency_phone' => 40, 'emergency_relation' => 40];
    private const MAX_PHOTO = 8 * 1024 * 1024;

    public function __construct(private PDO $pdo, private string $appRoot)
    {
    }

    public function get(array $p): array
    {
        $st = $this->pdo->prepare('SELECT * FROM users WHERE id = :id');
        $st->execute(['id' => (int) $p['id']]);
        $u = $st->fetch();
        if (!$u) {
            throw new DomainException('User not found.');
        }
        $emp = null;
        if (!empty($p['person_id'])) {
            $s = $this->pdo->prepare('SELECT * FROM person_profiles WHERE person_id = :p');
            $s->execute(['p' => $p['person_id']]);
            if ($r = $s->fetch()) {
                $emp = ['person_id' => $r['person_id'], 'name' => $r['name'], 'staff_id' => $r['staff_id'] ?? null,
                        'department' => $r['department'] ?? null, 'plant' => $r['plant'] ?? null, 'shift' => $r['shift'] ?? null,
                        'photo_url' => $r['photo_url'] ?? null,
                        // Face photos (front = photo_url) + SenseStudio check per side; left/right are
                        // self-service via POST /faces/me/{left|right} (lib/FaceRoutes.php).
                        'photo_left_url' => ($r['photo_left'] ?? null) ?: null,
                        'photo_right_url' => ($r['photo_right'] ?? null) ?: null,
                        'faces' => Faces::summary($r)];
            }
        }
        return [
            'id' => (int) $u['id'], 'username' => $u['username'], 'email' => $u['email'], 'role' => $u['role'], 'tier' => $p['tier'],
            'display_name' => $u['display_name'], 'phone' => $u['phone'] ?? null,
            'emergency_contact' => ['name' => $u['emergency_name'] ?? null, 'phone' => $u['emergency_phone'] ?? null,
                                    'relation' => $u['emergency_relation'] ?? null],
            'photo_url' => ($u['photo_url'] ?? null) ?: ($emp['photo_url'] ?? null),
            'profile_updated_at' => $u['profile_updated_at'] ?? null, 'last_login_at' => $u['last_login_at'],
            'employee' => $emp,
            'editable' => array_merge(array_keys(self::EDITABLE), ['photo']),
        ];
    }

    /** Apply the self-editable fields. Accepts emergency_contact:{name,phone,relation} too. */
    public function update(array $p, array $in): array
    {
        if (isset($in['emergency_contact']) && is_array($in['emergency_contact'])) {
            foreach (['name', 'phone', 'relation'] as $k) {
                if (array_key_exists($k, $in['emergency_contact'])) {
                    $in['emergency_' . $k] = $in['emergency_contact'][$k];
                }
            }
        }
        $set = [];
        foreach (self::EDITABLE as $k => $max) {
            if (!array_key_exists($k, $in)) {
                continue;
            }
            $v = trim(preg_replace('/[\x00-\x1F\x7F]/u', '', (string) $in[$k]) ?? '');
            if (mb_strlen($v) > $max) {
                throw new InvalidArgumentException($k . ' is too long (max ' . $max . ' characters).');
            }
            if (in_array($k, ['phone', 'emergency_phone'], true) && $v !== '' && !preg_match('/^\+?[0-9 ()\-]{6,20}$/', $v)) {
                throw new InvalidArgumentException(($k === 'phone' ? 'Phone' : 'Emergency phone') . ' must be 6–20 digits (spaces, +, -, () allowed).');
            }
            if ($k === 'display_name' && $v === '') {
                throw new InvalidArgumentException('Display name cannot be empty.');
            }
            $set[$k] = $v !== '' ? $v : null;
        }
        if ($set) {
            $set['profile_updated_at'] = date('Y-m-d H:i:s');
            $this->save((int) $p['id'], $set);
        }
        return $this->get($p);
    }

    /** Store a new profile photo from raw bytes → uploads/profiles/u{id}-….webp. */
    public function savePhoto(array $p, string $bytes): array
    {
        if ($bytes === '' || strlen($bytes) > self::MAX_PHOTO) {
            throw new InvalidArgumentException('Photos must be between 1 byte and 8 MB.');
        }
        $mime = ImageTool::mimeOf($bytes);
        if (!in_array($mime, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], true)) {
            throw new InvalidArgumentException('Only JPG, PNG, WEBP or GIF images are accepted.');
        }
        $uid  = (int) $p['id'];
        $name = 'u' . $uid . '-' . date('YmdHis') . '-' . bin2hex(random_bytes(3)) . '.webp';
        $res  = ImageTool::toWebp($bytes, $this->appRoot . '/uploads/profiles/' . $name, 82, 800);
        if (!$res) {
            throw new RuntimeException('The photo could not be converted.');
        }
        @chmod($res['path'], 0644);
        $old = $this->pdo->prepare('SELECT photo_url FROM users WHERE id = :id');
        $old->execute(['id' => $uid]);
        $prev = (string) ($old->fetchColumn() ?: '');
        $url  = '/uploads/profiles/' . $name;
        $this->save($uid, ['photo_url' => $url, 'profile_updated_at' => date('Y-m-d H:i:s')]);
        // Remove the user's previous self-service photo (only our own naming pattern).
        if (preg_match('#^/uploads/profiles/(u' . $uid . '-\d{14}-[0-9a-f]{6}\.webp)$#', $prev, $m)) {
            @unlink($this->appRoot . '/uploads/profiles/' . $m[1]);
        }
        return ['photo_url' => $url, 'width' => $res['width'], 'height' => $res['height'], 'bytes' => $res['bytes']];
    }

    /**
     * Self-service side face photo for the caller's own linked employee.
     * Only left/right — the FRONT photo is the one SenseStudio matches on, so
     * it stays with HR (People page). $bytes null = remove.
     */
    public function saveFacePhoto(array $p, string $side, ?string $bytes): array
    {
        if (!in_array($side, ['left', 'right'], true)) {
            throw new InvalidArgumentException('You can add your left and right side photos here; the front photo is managed by HR.');
        }
        $pid = (string) ($p['person_id'] ?? '');
        if ($pid === '') {
            throw new DomainException('No employee profile is linked to your login — ask HR to link it first.');
        }
        $faces = new Faces($this->pdo, $this->appRoot);
        $row   = $faces->row($pid);
        if ($row === null) {
            throw new DomainException('Your employee profile was not found — ask HR to check the link.');
        }
        $old = (string) ($row[Faces::SIDES[$side]] ?? '');
        $url = $bytes === null ? null : $faces->storeUpload($pid, $side, $bytes);
        $faces->setPhoto($pid, $side, $url);
        $faces->deleteFile($old !== '' ? $old : null, $pid);
        return $this->get($p);
    }

    private function save(int $id, array $set): void
    {
        $parts = [];
        foreach (array_keys($set) as $k) {
            $parts[] = $k . ' = :' . $k;
        }
        $set['__id'] = $id;
        $this->pdo->prepare('UPDATE users SET ' . implode(', ', $parts) . ' WHERE id = :__id')->execute($set);
    }
}
