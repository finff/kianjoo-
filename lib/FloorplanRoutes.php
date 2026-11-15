<?php
/**
 * M14 floor-plan + movement routes, included from api/index.php inside its
 * try {} (shares $route, $seg, $method, $config, $provisionAdmin). Lives in
 * lib/ so it is never directly web-reachable. Caller resolved server-side by
 * AiGuard on every route — the dashboard read token grants nothing here.
 *
 *   GET  /floorplans                              plans (+pins), display order        [signed in; staff: active, redacted]
 *   POST /floorplans                              multipart file (+name) → new plan   [admin + settings]
 *   GET  /floorplans/cameras                      pin-able cameras (real config)      [admin + settings]
 *   POST /floorplans/reorder {ids:[…]}            new display order                   [admin + settings]
 *   GET  /floorplans/{id}                         one plan + pins                     [signed in; staff: active, redacted]
 *   GET  /floorplans/{id}/image[?original=1]      WebP display copy (or original)     [signed in; original: admin + settings]
 *   POST /floorplans/{id}/image                   multipart file → replace image      [admin + settings]
 *   POST /floorplans/{id}/update {name?,active?,sort_order?}                          [admin + settings]
 *   POST /floorplans/{id}/delete                  plan + pins + files                 [admin + settings]
 *   POST /floorplans/{id}/pins {camera_id,x_pct,y_pct,label?}  place / move by camera [admin + settings]
 *   POST /floorplans/{id}/pins/{pin} {x_pct?,y_pct?,label?}    move / relabel pin     [admin + settings]
 *   POST /floorplans/{id}/pins/{pin}/delete       remove pin                          [admin + settings]
 *   GET  /floorplans/pins/{pin}/live              pin → live stream + recent hits     [supervisor+ + view]
 *   GET  /movement/camera/{camera_id}             same, by camera id (camera anywhere) [supervisor+ + view]
 *   GET  /movement/path?person_id=&date=&from=&to=&gap=&floorplan_id=                 [supervisor+ + view: anyone; staff: own only]
 *   GET  /movement/occupancy?minutes=&floorplan_id=                                   [supervisor+ + view]
 *   GET  /movement/people?q=&limit=               person picker                       [supervisor+ + view]
 *   GET  /movement/thumb/{event_id}               small WebP snapshot                 [supervisor+ + view; staff: own events]
 *
 * Hidden objects answer 404 (staff asking for someone else's path / thumb).
 * Every other /movement/* route (e.g. /movement/log) falls through.
 */

declare(strict_types=1);

if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

$fpFirst = $seg[0] ?? '';
$fpMove  = ['path', 'occupancy', 'people', 'thumb', 'camera'];
if (!($fpFirst === 'floorplans' || ($fpFirst === 'movement' && in_array($seg[1] ?? '', $fpMove, true)))) {
    return;   // not ours
}

require_once APP_ROOT . '/lib/AiGuard.php';
require_once APP_ROOT . '/lib/Floorplans.php';

$fpPdo = Database::connect($config['storage']);
$fp    = new Floorplans($fpPdo, $config, APP_ROOT);
$fpP   = AiGuard::require($fpPdo, $provisionAdmin());
$fpBody = static function (): array {
    $j = json_decode(file_get_contents('php://input') ?: '', true);
    return is_array($j) ? $j : $_POST;
};
$fpManager = AiGuard::atLeast($fpP, 'admin') && AiGuard::can($fpP, 'settings');
$fpViewer  = AiGuard::atLeast($fpP, 'supervisor') && AiGuard::can($fpP, 'view');
$fpManage  = static function () use ($fpP): void {
    AiGuard::demand($fpP, 'admin', 'settings');
};
$fpPost = static function () use ($method): void {
    if ($method !== 'POST') {
        Response::error('Use POST.', 405);
    }
};
// Uploaded image bytes from multipart "file" (or "image"); 422 on any problem.
$fpUpload = static function (): string {
    $f = $_FILES['file'] ?? $_FILES['image'] ?? null;
    if (!is_array($f) || ($f['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_NO_FILE) {
        Response::error('Upload the floor plan as multipart field "file".', 422);
    }
    if (in_array($f['error'], [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true) || (int) ($f['size'] ?? 0) > Floorplans::MAX_UPLOAD_BYTES) {
        Response::error('Floor plan image must be 8 MB or smaller.', 422);
    }
    if ($f['error'] !== UPLOAD_ERR_OK || !is_uploaded_file((string) $f['tmp_name'])) {
        Response::error('Upload failed.', 422);
    }
    return (string) file_get_contents((string) $f['tmp_name']);
};
$fpServeFile = static function (string $path, string $mime): void {
    $etag = '"' . md5($path . '|' . filemtime($path) . '|' . filesize($path)) . '"';
    header('Cache-Control: private, max-age=300');
    header('ETag: ' . $etag);
    if (trim((string) ($_SERVER['HTTP_IF_NONE_MATCH'] ?? '')) === $etag) {
        http_response_code(304);
        exit;
    }
    http_response_code(200);
    header('Content-Type: ' . $mime);
    header('Content-Length: ' . filesize($path));
    header('X-Content-Type-Options: nosniff');
    readfile($path);
    exit;
};
$fpLive = static function (string $cam) use ($fp): void {
    Response::ok(['live' => $fp->liveFor($cam), 'recent' => $fp->recentAtCamera($cam, max(1, min(50, (int) ($_GET['limit'] ?? 10))))]);
};

try {
    // ── /movement/* ─────────────────────────────────────────
    if ($fpFirst === 'movement') {
        $sub = (string) $seg[1];
        if ($method !== 'GET') {
            Response::error('Use GET.', 405);
        }

        if ($sub === 'path') {
            $pid = $fp->subjectFor($fpP, (string) ($_GET['person_id'] ?? ''));
            if ($pid === null) {
                if ($fpViewer && trim((string) ($_GET['person_id'] ?? '')) === '') {
                    Response::error('person_id is required.', 422);
                }
                Response::error('Not found.', 404);
            }
            [$from, $to] = Floorplans::window((string) ($_GET['date'] ?? ''), (string) ($_GET['from'] ?? ''), (string) ($_GET['to'] ?? ''));
            $gapDef = (int) (($config['movement']['gap_min'] ?? null) ?: Env::get('MOVEMENT_GAP_MIN', '') ?: Floorplans::DEFAULT_GAP_MIN);
            $gap    = isset($_GET['gap']) && is_numeric($_GET['gap']) ? (int) $_GET['gap'] : $gapDef;
            $plan   = isset($_GET['floorplan_id']) && (int) $_GET['floorplan_id'] > 0 ? (int) $_GET['floorplan_id'] : null;
            Response::ok($fp->path($pid, $from, $to, $gap, $plan, !$fpViewer));
        }

        if ($sub === 'thumb') {
            $eid = (int) ($seg[2] ?? 0);
            $own = $eid > 0 ? $fp->eventPerson($eid) : null;
            $ok  = $eid > 0 && ($fpViewer || ($own !== null && $fp->subjectFor($fpP, $own) === $own));
            $file = $ok ? $fp->thumb($eid) : null;
            if ($file === null) {
                Response::error('Not found.', 404);
            }
            $fpServeFile($file, 'image/webp');
        }

        AiGuard::demand($fpP, 'supervisor', 'view');

        if ($sub === 'occupancy') {
            $plan = isset($_GET['floorplan_id']) && (int) $_GET['floorplan_id'] > 0 ? (int) $_GET['floorplan_id'] : null;
            Response::ok($fp->occupancy((int) ($_GET['minutes'] ?? 15), $plan));
        }
        if ($sub === 'people') {
            Response::ok(['people' => $fp->searchPeople((string) ($_GET['q'] ?? ''), (int) ($_GET['limit'] ?? 20))]);
        }
        if ($sub === 'camera') {
            $cam = $fp->validCamera((string) ($seg[2] ?? ''));
            if ($cam === null) {
                Response::error('Not found.', 404);
            }
            $fpLive($cam);
        }
        Response::error('Not found: ' . $route, 404);
    }

    // ── /floorplans/* ───────────────────────────────────────
    $a = (string) ($seg[1] ?? '');

    if ($a === '') {
        if ($method === 'POST') {
            $fpManage();
            $bytes = $fpUpload();
            $name  = trim((string) ($_POST['name'] ?? ''));
            if ($name === '') {
                $name = pathinfo((string) ($_FILES['file']['name'] ?? $_FILES['image']['name'] ?? 'Floor plan'), PATHINFO_FILENAME) ?: 'Floor plan';
            }
            Response::ok(['floorplan' => $fp->create($name, $bytes, (string) ($fpP['name'] ?? 'admin'))]);
        }
        Response::ok(['floorplans' => $fp->list($fpManager, !$fpViewer), 'can_manage' => $fpManager]);
    }

    if ($a === 'cameras') {
        $fpManage();
        $used = [];
        foreach ($fp->list(true) as $plan) {
            foreach ($plan['pins'] as $pin) {
                $used[$pin['camera_id']][] = ['floorplan_id' => $plan['id'], 'pin_id' => $pin['id']];
            }
        }
        $cams = [];
        foreach ($fp->cameraCatalog() as $id => $c) {
            $cams[] = $c + ['pins' => $used[$id] ?? []];
        }
        Response::ok(['cameras' => $cams]);
    }

    if ($a === 'reorder') {
        $fpPost();
        $fpManage();
        $in = $fpBody();
        Response::ok(['floorplans' => $fp->reorder(is_array($in['ids'] ?? null) ? $in['ids'] : [])]);
    }

    if ($a === 'pins') {
        AiGuard::demand($fpP, 'supervisor', 'view');
        $pin = $fp->pin((int) ($seg[2] ?? 0));
        if ($pin === null || ($seg[3] ?? '') !== 'live') {
            Response::error('Not found.', 404);
        }
        $fpLive($pin['camera_id']);
    }

    if (!ctype_digit($a)) {
        Response::error('Not found: ' . $route, 404);
    }
    $id  = (int) $a;
    $act = (string) ($seg[2] ?? '');

    if ($act === '' && $method === 'GET') {
        $plan = $fp->get($id, !$fpViewer);
        if ($plan === null || (!$plan['active'] && !$fpManager)) {
            Response::error('Not found.', 404);
        }
        Response::ok(['floorplan' => $plan]);
    }

    if ($act === 'image') {
        if ($method === 'POST') {
            $fpManage();
            $plan = $fp->replaceImage($id, $fpUpload());
            $plan === null ? Response::error('Not found.', 404) : Response::ok(['floorplan' => $plan]);
        }
        $plan = $fp->get($id);
        $orig = !empty($_GET['original']);
        if ($plan === null || (!$plan['active'] && !$fpManager) || ($orig && !$fpManager)) {
            Response::error('Not found.', 404);
        }
        $f = $fp->imageFile($id, $orig);
        if ($f === null) {
            Response::error('Not found.', 404);
        }
        $fpServeFile($f['path'], $f['mime']);
    }

    $fpPost();
    $fpManage();

    if ($act === 'update') {
        $plan = $fp->update($id, $fpBody());
        $plan === null ? Response::error('Not found.', 404) : Response::ok(['floorplan' => $plan]);
    }
    if ($act === 'delete') {
        $fp->delete($id) ? Response::ok(['deleted' => $id]) : Response::error('Not found.', 404);
    }
    if ($act === 'pins') {
        $pinId = (string) ($seg[3] ?? '');
        if ($pinId === '') {
            $pin = $fp->setPin($id, $fpBody());
            $pin === null ? Response::error('Not found.', 404) : Response::ok(['pin' => $pin]);
        }
        if (ctype_digit($pinId) && ($seg[4] ?? '') === 'delete') {
            $fp->deletePin($id, (int) $pinId) ? Response::ok(['deleted' => (int) $pinId]) : Response::error('Not found.', 404);
        }
        if (ctype_digit($pinId) && ($seg[4] ?? '') === '') {
            $pin = $fp->movePin($id, (int) $pinId, $fpBody());
            $pin === null ? Response::error('Not found.', 404) : Response::ok(['pin' => $pin]);
        }
    }
    Response::error('Not found: ' . $route, 404);
} catch (InvalidArgumentException $e) {
    Response::error($e->getMessage(), 422);
}
