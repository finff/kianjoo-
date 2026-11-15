<?php
/**
 * Leave workflow (M6), profile self-service and in-app notification routes,
 * included from api/index.php inside its try {} (shares $route, $seg, $method,
 * $config). Lives in lib/ so it is never directly web-reachable. Same
 * conventions as lib/AiRoutes.php: the caller is resolved server-side via
 * AiGuard on every request; the dashboard read token grants nothing here; an
 * object outside the caller's scope answers 404.
 *
 *   GET  /leaves[?status=&year=&limit=&offset=]  own requests + balances           [signed in]
 *   POST /leaves                                 {leave_type, start_date, end_date, half_day, half_day_period, reason, draft}
 *                                                                                    [signed in]
 *   GET  /leaves/types                           leave type catalogue               [signed in]
 *   GET  /leaves/balances[?year=&user_id=]       balances (user_id: admin only)     [signed in]
 *   POST /leaves/balances                        {user_id, year, leave_type, entitled}  [admin + users]
 *   GET  /leaves/team[?status=pending|approved|…|all&department=&year=&from=&to=&q=]
 *                                                approval queue / team history      [supervisor (own dept) / admin (all)]
 *   GET  /leaves/calendar?month=YYYY-MM[&department=&pending=1]
 *                                                approved leave by department       [signed in; scope by tier]
 *   GET  /leaves/{id|leave_no}                   detail + attachments + balance     [requester or approver in scope]
 *   POST /leaves/{id}/submit                     draft → pending                    [requester]
 *   POST /leaves/{id}/cancel                     {remarks?}                         [requester; approver in scope]
 *   POST /leaves/{id}/approve                    {remarks?}                         [approver in scope, not own]
 *   POST /leaves/{id}/reject                     {remarks} (required)               [approver in scope, not own]
 *   POST /leaves/{id}/attachments                multipart "file" (photo/PDF)       [requester]
 *   GET  /leaves/{id}/attachments/{aid}          stream file                        [requester or approver in scope]
 *   GET  /profile                                own profile                        [signed in]
 *   POST /profile                                {display_name, phone, emergency_name, emergency_phone, emergency_relation}
 *                                                                                    [signed in; email/username/role ignored]
 *   POST /profile/photo                          multipart "file" → WebP            [signed in]
 *   GET  /attendance/month?month=YYYY-MM[&person_id=|&all=1][&plant=&department=&q=]
 *                                                person-month attendance JSON (same data as the range CSV):
 *                                                default/person_id=me → own linked employee {person, days[], summary};
 *                                                person_id=X → that employee; all=1 → {people:[{…, shift, days:{date:{status,in,out,inLoc,hours,lateMin}}, summary}]}
 *                                                                                    [signed in; others/all: supervisor+, else 404]
 *   GET  /notifications[?all=1&limit=&before=]   unread (or all) + unread_count     [signed in]
 *   GET  /notifications/count                    {unread_count}                     [signed in]
 *   POST /notifications/read                     {ids:[…]} or {all:true}            [signed in, own only]
 */

declare(strict_types=1);

if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

$hrFirst = $seg[0] ?? '';
if ($hrFirst === 'attendance' && ($seg[1] ?? '') === 'month' && !isset($seg[2])) {
    $hrFirst = 'attendance-month';
}
if (!in_array($hrFirst, ['leaves', 'profile', 'notifications', 'attendance-month'], true)) {
    return;   // not ours — fall through to the rest of api/index.php
}

require_once APP_ROOT . '/lib/AiGuard.php';
require_once APP_ROOT . '/lib/Notifications.php';

$hrPdo  = Database::connect($config['storage']);
$hrBody = static function (): array {
    $raw = file_get_contents('php://input') ?: '';
    $j   = json_decode($raw, true);
    return is_array($j) ? $j : $_POST;
};
$hrDir = (string) ($config['ai']['storage_dir'] ?? APP_ROOT . '/storage');
// Real signed-in users only: the provision token has no person behind it.
$p = AiGuard::require($hrPdo);

try {
    // ── Person-month attendance (JSON twin of the range CSV export) ──
    // Default = the caller's own linked employee. person_id= another person or
    // all=1 (team summary) needs supervisor+; staff get 404 for anyone else.
    if ($hrFirst === 'attendance-month') {
        if ($method !== 'GET') {
            Response::error('Method not allowed.', 405);
        }
        require_once APP_ROOT . '/lib/Attendance.php';
        $ym   = (string) ($_GET['month'] ?? date('Y-m'));
        $want = trim((string) ($_GET['person_id'] ?? ''));
        $all  = !empty($_GET['all']) && $want === '';
        $sup  = AiGuard::atLeast($p, 'supervisor');
        if ($want === '' || $want === 'me') {
            $want = (string) ($p['person_id'] ?? '');
        }
        if (!$all && $want === '') {
            Response::error('No employee profile is linked to your login.', 404);
        }
        if (!$sup && ($all || $want !== (string) ($p['person_id'] ?? ''))) {
            Response::error('Not found.', 404);   // same answer as "no such person"
        }
        $f = [];
        foreach (['plant', 'department', 'q'] as $k) {
            $f[$k] = substr(trim((string) ($_GET[$k] ?? '')), 0, 80);
        }
        $att = new Attendance(new EventStore($hrPdo, $config), $config);
        $res = $att->month($ym, $all ? null : $want, $f);
        if ($res === null) {
            Response::error('Not found.', 404);
        }
        Response::ok($res + ['self' => !$all && $want === (string) ($p['person_id'] ?? '')]);
    }

    // ── Notifications ───────────────────────────────────────
    if ($hrFirst === 'notifications') {
        $nt  = new Notifications($hrPdo);
        $sub = $seg[1] ?? '';
        if ($sub === '' && $method === 'GET') {
            Response::ok(['unread_count' => $nt->unreadCount($p['id']),
                          'notifications' => $nt->list($p['id'], empty($_GET['all']), (int) ($_GET['limit'] ?? 30), (int) ($_GET['before'] ?? 0))]);
        }
        if ($sub === 'count' && $method === 'GET') {
            Response::ok(['unread_count' => $nt->unreadCount($p['id'])]);
        }
        if ($sub === 'read' && $method === 'POST') {
            $in = $hrBody();
            $n  = $nt->markRead($p['id'], !empty($in['all']) ? null : (is_array($in['ids'] ?? null) ? $in['ids'] : [(int) ($in['id'] ?? 0)]));
            Response::ok(['marked' => $n, 'unread_count' => $nt->unreadCount($p['id'])]);
        }
        Response::error('Unknown notifications action.', 404);
    }

    // ── Profile self-service ────────────────────────────────
    if ($hrFirst === 'profile') {
        require_once APP_ROOT . '/lib/Profile.php';
        $pr  = new Profile($hrPdo, APP_ROOT);
        $sub = $seg[1] ?? '';
        if ($sub === '' && $method === 'GET') {
            Response::ok(['profile' => $pr->get($p)]);
        }
        if ($sub === '' && $method === 'POST') {
            $out = $pr->update($p, $hrBody());
            // Keep the session's display name in step (AiGuard closed the session).
            if (session_status() !== PHP_SESSION_ACTIVE && !headers_sent()) {
                Auth::session();
                if (isset($_SESSION['tmns_user']) && (int) $_SESSION['tmns_user']['id'] === $p['id']) {
                    $_SESSION['tmns_user']['name'] = $out['display_name'] ?: $out['username'];
                }
                session_write_close();
            }
            Response::ok(['profile' => $out]);
        }
        if ($sub === 'photo' && $method === 'POST') {
            $f = $_FILES['file'] ?? [];
            if (($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file((string) ($f['tmp_name'] ?? ''))) {
                Response::error('multipart field "file" required.', 422);
            }
            Response::ok($pr->savePhoto($p, (string) file_get_contents($f['tmp_name'])));
        }
        Response::error('Unknown profile action.', 404);
    }

    // ── Leaves (M6) ─────────────────────────────────────────
    require_once APP_ROOT . '/lib/Leaves.php';
    $lv  = new Leaves($hrPdo, $hrDir);
    $sub = $seg[1] ?? '';
    $q   = static function (array $keys): array {
        $f = [];
        foreach ($keys as $k) {
            if (isset($_GET[$k]) && $_GET[$k] !== '') {
                $f[$k] = substr((string) $_GET[$k], 0, 80);
            }
        }
        return $f;
    };

    if ($sub === '') {
        if ($method === 'POST') {
            $l = $lv->create($hrBody(), $p);
            Response::json(['ok' => true, 'leave' => $lv->detail($l, $p)], 201);
        }
        $f = $q(['status', 'year', 'limit', 'offset', 'from', 'to']);
        Response::ok($lv->listOwn($p, $f) + ['balances' => $lv->balances($p['id'], (int) ($f['year'] ?? 0) ?: null),
                                             'is_approver' => Leaves::isApprover($p)]);
    }
    if ($sub === 'types') {
        Response::ok(['types' => $lv->types(), 'statuses' => Leaves::STATUSES, 'weekend' => Leaves::WEEKEND]);
    }
    if ($sub === 'balances') {
        if ($method === 'POST') {
            AiGuard::demand($p, 'admin', 'users');
            $in = $hrBody();
            $uid = (int) ($in['user_id'] ?? 0);
            $chk = $hrPdo->prepare('SELECT id FROM users WHERE id = :id');
            $chk->execute(['id' => $uid]);
            if (!$chk->fetchColumn()) {
                Response::error('User not found.', 404);
            }
            Response::ok(['balance' => $lv->setEntitlement($uid, (int) ($in['year'] ?? date('Y')), (string) ($in['leave_type'] ?? ''), (float) ($in['entitled'] ?? -1))]);
        }
        $uid = $p['id'];
        if (!empty($_GET['user_id']) && (int) $_GET['user_id'] !== $p['id']) {
            AiGuard::demand($p, 'admin');
            $uid = (int) $_GET['user_id'];
        }
        $year = (int) ($_GET['year'] ?? date('Y'));
        Response::ok(['user_id' => $uid, 'year' => $year, 'balances' => $lv->balances($uid, $year)]);
    }
    if ($sub === 'team') {
        Response::ok($lv->listTeam($p, $q(['status', 'department', 'year', 'from', 'to', 'q', 'limit', 'offset'])));
    }
    if ($sub === 'calendar') {
        Response::ok($lv->calendar($p, (string) ($_GET['month'] ?? date('Y-m')), substr((string) ($_GET['department'] ?? ''), 0, 80), !empty($_GET['pending'])));
    }

    $l = $lv->find($sub);
    if (!$l || !Leaves::canView($l, $p)) {
        Response::error('Leave request not found.', 404);   // same answer for "exists but not yours"
    }
    $act = $seg[2] ?? '';
    if ($act === '' && $method === 'GET') {
        Response::ok(['leave' => $lv->detail($l, $p)]);
    }
    if ($method === 'POST' && in_array($act, ['submit', 'cancel', 'approve', 'reject'], true)) {
        $in = $hrBody();
        $rm = (string) ($in['remarks'] ?? '');
        $l2 = match ($act) {
            'submit'  => $lv->submit($l, $p),
            'cancel'  => $lv->cancel($l, $p, $rm),
            'approve' => $lv->approve($l, $p, $rm),
            'reject'  => $lv->reject($l, $p, $rm),
        };
        Response::ok(['leave' => $lv->detail($l2, $p)]);
    }
    if ($act === 'attachments' && $method === 'POST') {
        Response::json(['ok' => true, 'attachment' => $lv->attachUpload($l, $p, $_FILES['file'] ?? [])], 201);
    }
    if ($act === 'attachments' && $method === 'GET' && isset($seg[3])) {
        $a = $lv->attachment((int) $l['id'], (int) $seg[3]);
        if (!$a) {
            Response::error('Attachment not found.', 404);
        }
        $path = $lv->attachmentPath($a);
        if ($path === null) {
            Response::error('Attachment file is missing.', 410);
        }
        header('Content-Type: ' . $a['mime']);
        header('Content-Length: ' . filesize($path));
        header('X-Content-Type-Options: nosniff');
        header("Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'");
        header('Cache-Control: private, max-age=3600');
        header('Content-Disposition: inline; filename="' . str_replace('"', '', (string) $a['filename']) . '"');
        readfile($path);
        exit;
    }
    Response::error('Unknown leave action.', 404);
} catch (LeaveForbiddenException $e) {
    Response::error($e->getMessage(), 403);
} catch (InvalidArgumentException $e) {
    Response::error($e->getMessage(), 422);
} catch (DomainException $e) {
    Response::error($e->getMessage(), 409);
}
