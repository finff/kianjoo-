<?php
/**
 * Incident episodes + the human "Needs review" queue, included from
 * api/index.php inside its try {} (shares $route, $seg, $method, $config,
 * $provisionAdmin). Lives in lib/ so it is never directly web-reachable.
 *
 *   GET  /incidents/{uuid|id}/group?limit=60&offset=0   episode of a detection: leader incident,
 *        → {leader, group{id, leader_uuid, detection_count, event_first_at, event_last_at,
 *           duration_s, status, ticket, gap_min, person_known}, members[], total}     [signed in + view]
 *   POST /incidents/catchup?limit=                       group existing rows now (normally the
 *        feed poll does this, ≤ 2000 rows / 30 s)                                  [admin + settings, or provision token]
 *   GET  /review/count                                   {pending}                         [worker]
 *   GET  /review/queue?status=pending|decided&limit&offset → {items[], total, counts, thresholds} [worker]
 *   GET  /review/{id}/image                              stored WebP evidence              [worker]
 *   POST /review/{id}/decide {verdict: confirm|reject, note?} → {item, ticket}             [worker]
 *
 * worker = supervisor+ with the `tickets` permission (Tickets::isWorker) — the
 * same people who work INC incidents in the Tickets hub.
 */

declare(strict_types=1);

if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

$irFirst = $seg[0] ?? '';
if ($irFirst !== 'incidents' && $irFirst !== 'review') {
    return;   // not ours — fall through to the rest of api/index.php
}

require_once APP_ROOT . '/lib/AiGuard.php';
require_once APP_ROOT . '/lib/Tickets.php';
require_once APP_ROOT . '/lib/EventStore.php';
require_once APP_ROOT . '/lib/IncidentGroups.php';
require_once APP_ROOT . '/lib/ReviewQueue.php';

$irPdo = Database::connect($config['storage']);
$irP   = AiGuard::require($irPdo, $provisionAdmin());
$irBody = static function (): array {
    $j = json_decode(file_get_contents('php://input') ?: '', true);
    return is_array($j) ? $j : $_POST;
};

if ($irFirst === 'incidents') {
    $ref = (string) ($seg[1] ?? '');
    if ($ref === 'catchup') {
        if ($method !== 'POST') {
            Response::error('POST only.', 405);
        }
        AiGuard::demand($irP, 'admin', 'settings');
        @set_time_limit(120);
        $res = (new IncidentGroups($irPdo, $config))->catchUp(max(1, min(5000, (int) ($_GET['limit'] ?? 5000))), 60.0);
        Response::ok(['ready' => IncidentGroups::ready(), 'result' => $res]);
    }
    if ($ref === '' || ($seg[2] ?? '') !== 'group' || $method !== 'GET') {
        Response::error('Unknown incident route.', 404);
    }
    if (!AiGuard::can($irP, 'view')) {
        Response::error('Forbidden.', 403);
    }
    $d = (new IncidentGroups($irPdo, $config))->detail(new EventStore($irPdo, $config), mb_substr($ref, 0, 191),
        (int) ($_GET['limit'] ?? 60), (int) ($_GET['offset'] ?? 0));
    if ($d === null) {
        Response::error('Detection not found (it may have been purged).', 404);
    }
    Response::ok($d);
}

// ── /review/* — Needs review queue ──────────────────────────
if (!Tickets::isWorker($irP)) {
    Response::error('Forbidden: reviewing detections needs a supervisor role with the tickets permission.', 403);
}
$rq = new ReviewQueue($irPdo, $config);
if (!AiSchema::$groupsReady) {
    Response::ok(['pending' => 0, 'items' => [], 'total' => 0, 'counts' => [], 'unavailable' => true]);
}
$sub = (string) ($seg[1] ?? '');
if ($sub === 'count') {
    Response::ok(['pending' => $rq->pendingCount(), 'enabled' => $rq->enabled()]);
}
if ($sub === 'queue') {
    $status = ($_GET['status'] ?? 'pending') === 'decided' ? 'decided' : 'pending';
    Response::ok($rq->list($status, (int) ($_GET['limit'] ?? 50), (int) ($_GET['offset'] ?? 0)));
}
if (ctype_digit($sub)) {
    $item = $rq->find((int) $sub);
    if (!$item) {
        Response::error('Review item not found.', 404);
    }
    $act = (string) ($seg[2] ?? '');
    if ($act === 'image' && $method === 'GET') {
        $path = $rq->imagePath($item);
        if ($path === null) {
            Response::error('No stored image for this item.', 404);
        }
        header('Content-Type: image/webp');
        header('Content-Length: ' . filesize($path));
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: private, max-age=86400');
        readfile($path);
        exit;
    }
    if ($act === 'decide' && $method === 'POST') {
        $in = $irBody();
        try {
            Response::ok($rq->decide((int) $item['id'], strtolower((string) ($in['verdict'] ?? '')), (string) ($in['note'] ?? ''), $irP)
                + ['pending' => $rq->pendingCount()]);
        } catch (InvalidArgumentException $e) {
            Response::error($e->getMessage(), 422);
        } catch (DomainException $e) {
            Response::error($e->getMessage(), 409);
        } catch (RuntimeException $e) {
            error_log('[review/decide] ' . $e->getMessage());
            Response::error($e->getMessage(), 502);
        }
    }
}
Response::error('Unknown review route.', 404);
