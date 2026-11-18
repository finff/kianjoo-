<?php
/**
 * Stranger movement routes (Movement › Strangers), included from
 * api/index.php inside its try {} (shares $route, $seg, $method, $config,
 * $provisionAdmin). Lives in lib/ so it is never directly web-reachable.
 * Caller resolved server-side by AiGuard on every route — the dashboard read
 * token grants nothing here.
 *
 *   GET  /strangers?from=&to=&plant=&camera=&status=&q=&sort=&page=&per=
 *        → paged stranger list + KPIs + filter options          [supervisor+ + view]
 *        status: active (default: not known/ignored) | new | known | ignored | labelled | all
 *        sort:   last (default) | sightings
 *   GET  /strangers/unlinked?from=&to=&plant=&camera=&page=    face pushes with no person id
 *                                                               (single sightings)    [supervisor+ + view]
 *   GET  /strangers/{id}?from=&to=                              journey: sightings + visits/dwell [supervisor+ + view]
 *   POST /strangers/{id}/label   {label, note?}                                       [supervisor+ + triage]
 *   POST /strangers/{id}/status  {status: new|known|ignored}                          [supervisor+ + triage]
 *   POST /strangers/{id}/merge   {into}   this id becomes an alias of `into`          [supervisor+ + triage]
 *   POST /strangers/{id}/unmerge          split a merged alias off again              [supervisor+ + triage]
 *   POST /strangers/search       multipart "file" (≤ 6 MB jpg/png/webp)
 *        → SenseStudio stranger-library matches                [supervisor+ + view]
 *
 * Validation problems answer 422, unknown ids 404.
 */

declare(strict_types=1);

if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

if (($seg[0] ?? '') !== 'strangers') {
    return;   // not ours
}

require_once APP_ROOT . '/lib/AiGuard.php';
require_once APP_ROOT . '/lib/EventStore.php';
require_once APP_ROOT . '/lib/Strangers.php';

$sgPdo = Database::connect($config['storage']);
$sgP   = AiGuard::require($sgPdo, $provisionAdmin());
AiGuard::demand($sgP, 'supervisor', 'view');
$sg     = new Strangers($sgPdo, $config, new EventStore($sgPdo, $config));
$sgBody = static function (): array {
    $j = json_decode(file_get_contents('php://input') ?: '', true);
    return is_array($j) ? $j : $_POST;
};
$sgActor  = (string) (($sgP['name'] ?? '') ?: ($sgP['username'] ?? 'operator'));
$sgFilter = static function (): array {
    $f = [];
    foreach (['from' => 10, 'to' => 10, 'plant' => 80, 'camera' => 64, 'status' => 16, 'q' => 64, 'sort' => 16] as $k => $n) {
        $f[$k] = substr(trim((string) (is_scalar($_GET[$k] ?? null) ? $_GET[$k] : '')), 0, $n);
    }
    $f['page'] = max(1, (int) ($_GET['page'] ?? 1));
    $f['per']  = max(1, min(Strangers::MAX_PER, (int) ($_GET['per'] ?? 24)));
    return $f;
};

try {
    $a = (string) ($seg[1] ?? '');

    if ($a === '' && $method === 'GET') {
        $f = $sgFilter();
        Response::ok($sg->list($f) + [
            'kpi'         => $sg->kpis($f),
            'filters'     => $sg->filterOptions(),
            'sense_ready' => $sg->senseReady(),
            'can_edit'    => AiGuard::can($sgP, 'triage'),
        ]);
    }

    if ($a === 'unlinked' && $method === 'GET') {
        Response::ok($sg->unlinked($sgFilter()));
    }

    if ($a === 'search') {
        if ($method !== 'POST') {
            Response::error('POST a multipart form with field "file".', 405);
        }
        $file = $_FILES['file'] ?? $_FILES['image'] ?? null;
        if (!is_array($file) || ($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file((string) $file['tmp_name'])) {
            Response::error('Upload a face photo as multipart field "file".', 422);
        }
        if ((int) $file['size'] > 6 * 1024 * 1024) {
            Response::error('Max image size 6 MB.', 413);
        }
        $info = @getimagesize((string) $file['tmp_name']);
        if (!$info || !in_array($info['mime'] ?? '', ['image/jpeg', 'image/png', 'image/webp'], true)) {
            Response::error('Only JPG, PNG or WEBP images can be searched.', 422);
        }
        $th  = isset($_POST['threshold']) && is_numeric($_POST['threshold']) ? (float) $_POST['threshold'] : 0.35;
        $res = $sg->searchByPhoto((string) $file['tmp_name'], $th);
        if (empty($res['ok'])) {
            Response::json(['ok' => false, 'error' => $res['error'] ?? 'Search failed', 'matches' => []], $sg->senseReady() ? 502 : 409);
        }
        Response::ok(['matches' => $res['matches'], 'note' => $res['note'] ?? null]);
    }

    if (!Strangers::validId($a)) {
        Response::error('Not found: ' . $route, 404);
    }
    $act = (string) ($seg[2] ?? '');

    if ($act === '' && $method === 'GET') {
        $j = $sg->journey($a, substr((string) ($_GET['from'] ?? ''), 0, 10), substr((string) ($_GET['to'] ?? ''), 0, 10));
        $j === null ? Response::error('Not found.', 404) : Response::ok(['stranger' => $j]);
    }

    if ($method !== 'POST') {
        Response::error('Use POST.', 405);
    }
    AiGuard::demand($sgP, 'supervisor', 'triage');
    $in = $sgBody();
    $str = static fn (string $k): string => is_scalar($in[$k] ?? null) ? (string) $in[$k] : '';

    if ($act === 'label') {
        Response::ok(['stranger' => $sg->setLabel($a, $str('label'), array_key_exists('note', $in) ? $str('note') : null, $sgActor)]);
    }
    if ($act === 'status') {
        Response::ok(['stranger' => $sg->setStatus($a, $str('status'), $sgActor)]);
    }
    if ($act === 'merge') {
        Response::ok(['stranger' => $sg->merge($a, trim($str('into')), $sgActor)]);
    }
    if ($act === 'unmerge') {
        Response::ok($sg->unmerge($a));
    }
    Response::error('Not found: ' . $route, 404);
} catch (InvalidArgumentException $e) {
    Response::error($e->getMessage(), 422);
}
