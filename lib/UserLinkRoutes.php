<?php
/**
 * Login ↔ employee link (users.person_id), included from api/index.php inside
 * its try {} (shares $route, $seg, $method, $config). Lives in lib/ so it is
 * never directly web-reachable. Same conventions as lib/HrRoutes.php: the
 * caller is resolved server-side by AiGuard on every request; the dashboard
 * read token and the provision token grant nothing here.
 *
 * Staff self-service data (attendance, leave scope, AI "my_*" fetchers) binds
 * to users.person_id, falling back to a person_profiles row whose staff_id
 * equals the username (AiGuard::principal). Settings → Users edits the link.
 *
 *   GET  /user-links                         users + linked person + linkable employees  [admin + users]
 *   POST /user-links {user_id, person_id}    set the link ('' / null clears it)          [admin + users]
 */

declare(strict_types=1);

if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

if (($seg[0] ?? '') !== 'user-links') {
    return;   // not ours — fall through to the rest of api/index.php
}

require_once APP_ROOT . '/lib/AiGuard.php';

$ulPdo = Database::connect($config['storage']);
$ulP   = AiGuard::require($ulPdo);
AiGuard::demand($ulP, 'admin', 'users');
if (isset($seg[1]) && $seg[1] !== '') {
    Response::error('Unknown user-links action.', 404);
}

if ($method === 'POST') {
    $raw = file_get_contents('php://input') ?: '';
    $in  = json_decode($raw, true);
    $in  = is_array($in) ? $in : $_POST;
    $uid = (int) ($in['user_id'] ?? 0);
    $st  = $ulPdo->prepare('SELECT id FROM users WHERE id = :id');
    $st->execute(['id' => $uid]);
    if (!$st->fetchColumn()) {
        Response::error('User not found.', 404);
    }
    $pid = trim((string) ($in['person_id'] ?? ''));
    if ($pid !== '') {
        $pid = substr($pid, 0, 64);
        $st  = $ulPdo->prepare('SELECT person_id FROM person_profiles WHERE person_id = :p');
        $st->execute(['p' => $pid]);
        if (!$st->fetchColumn()) {
            Response::error('Employee not found.', 422);
        }
        // One login per employee: staff self-scope must be unambiguous.
        $st = $ulPdo->prepare('SELECT username FROM users WHERE person_id = :p AND id <> :id LIMIT 1');
        $st->execute(['p' => $pid, 'id' => $uid]);
        $other = $st->fetchColumn();
        if ($other !== false) {
            Response::error('That employee is already linked to the login "' . $other . '" — unlink it there first.', 409);
        }
    }
    $ulPdo->prepare('UPDATE users SET person_id = :p WHERE id = :id')
        ->execute(['p' => $pid !== '' ? $pid : null, 'id' => $uid]);
}

// GET (and the refresh response after a write)
$people = [];
foreach ($ulPdo->query('SELECT * FROM person_profiles ORDER BY name ASC LIMIT 5000') as $r) {
    $people[] = [
        'person_id'  => (string) $r['person_id'],
        'name'       => (string) ($r['name'] ?? ''),
        'staff_id'   => (string) ($r['staff_id'] ?? ''),
        'department' => (string) ($r['department'] ?? ''),
        'plant'      => (string) ($r['plant'] ?? ''),
        'photo_url'  => (string) ($r['photo_url'] ?? ''),
        'active'     => (string) ($r['active'] ?? '1') !== '0',
    ];
}
$byStaff = [];
foreach ($people as $pp) {
    if ($pp['staff_id'] !== '' && !isset($byStaff[$pp['staff_id']])) {
        $byStaff[$pp['staff_id']] = $pp['person_id'];
    }
}
$users = [];
foreach ($ulPdo->query('SELECT * FROM users ORDER BY id ASC') as $u) {
    $pid = trim((string) ($u['person_id'] ?? ''));
    $users[] = [
        'id'        => (int) $u['id'],
        'username'  => (string) $u['username'],
        'person_id' => $pid !== '' ? $pid : null,
        // Fallback link AiGuard uses when person_id is empty: staff_id = username.
        'implicit_person_id' => $pid === '' ? ($byStaff[(string) $u['username']] ?? null) : null,
    ];
}
Response::ok(['users' => $users, 'people' => $people]);
