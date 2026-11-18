<?php
/**
 * Cleaning-button routes, included from api/index.php inside its try {}
 * (shares $route, $seg, $method, $config, $token, $provisionAdmin). Lives in
 * lib/ so it is never directly web-reachable. Logic: lib/CleaningButton.php.
 *
 *   GET|POST /cleaning/button            one press {button_id, action?, employee_id?, ts?, location?}   [ingest token]
 *   GET      /cleaning/button/status     ?button_id=  → idle | cleaning (for the device LED)             [ingest or read token]
 *   GET      /cleaning/button/sessions   ?from=&to=&button_id=&location=&status=&limit=&offset=          [read token]
 *   GET      /cleaning/buttons           registered buttons + current state                              [read token]
 *   POST     /cleaning/buttons           {button_id, name?, location?, enabled?} create / update         [admin + settings]
 *
 * "ingest token" is the same token SenseStudio pushes detections with
 * (Settings → Endpoints & tokens). The provision token works on every route.
 * A press may be sent as GET with query parameters because the simplest
 * button hardware can only fetch a URL.
 */

declare(strict_types=1);

if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

if (($seg[0] ?? '') !== 'cleaning' || !in_array($seg[1] ?? '', ['button', 'buttons'], true)) {
    return;   // not ours — /cleaning/summary|export|confirm stay in api/index.php
}

require_once APP_ROOT . '/lib/CleaningButton.php';

$cbGiven  = $token();
$cbHas    = static function (string ...$accepted) use ($cbGiven): bool {
    foreach ($accepted as $t) {
        if ($t !== '' && $cbGiven !== '' && hash_equals($t, $cbGiven)) {
            return true;
        }
    }
    return false;
};
$cbIngest = (string) ($config['auth']['ingest_token'] ?? '');
$cbRead   = (string) ($config['auth']['read_token'] ?? '');
$cbProv   = (string) ($config['auth']['provision_token'] ?? '');
$cbIn     = static function (): array {
    $j = json_decode(file_get_contents('php://input') ?: '', true);
    return (is_array($j) ? $j : []) + $_POST + $_GET;
};
$cbPdo = Database::connect($config['storage']);
$cb    = new CleaningButton($cbPdo, Database::driver(), (string) ($config['ai']['storage_dir'] ?? (APP_ROOT . '/storage')));
$cbSub = (string) ($seg[2] ?? '');

// ── registered buttons ──────────────────────────────────────
if ($seg[1] === 'buttons') {
    if ($method === 'GET') {
        if (!$cbHas($cbRead, $cbProv)) {
            Response::error('Unauthorized: invalid or missing token.', 401);
        }
        Response::ok(['buttons' => $cb->buttons()]);
    }
    if ($method !== 'POST') {
        Response::error('GET, or POST {button_id, name?, location?, enabled?}.', 405);
    }
    if ($provisionAdmin() === null) {
        require_once APP_ROOT . '/lib/Auth.php';
        if (Auth::user() === null) {
            Response::error('Sign in to manage cleaning buttons.', 401);
        }
        if (!Auth::can('settings')) {
            Response::error('Forbidden: managing cleaning buttons needs the settings permission.', 403);
        }
    }
    $in = $cbIn();
    $id = CleaningButton::cleanId($in['button_id'] ?? '');
    if ($id === '') {
        Response::error('button_id is required (letters, digits and . _ : - only, max 64).', 422);
    }
    Response::ok(['button' => $cb->saveButton($id, $in)]);
}

// ── /cleaning/button/sessions ───────────────────────────────
if ($cbSub === 'sessions') {
    if ($method !== 'GET') {
        Response::error('GET ?from=&to=&button_id=&location=&status=.', 405);
    }
    if (!$cbHas($cbRead, $cbProv)) {
        Response::error('Unauthorized: invalid or missing token.', 401);
    }
    Response::ok($cb->sessions($_GET));
}

// ── /cleaning/button/status ─────────────────────────────────
if ($cbSub === 'status') {
    if ($method !== 'GET') {
        Response::error('GET ?button_id=.', 405);
    }
    if (!$cbHas($cbIngest, $cbRead, $cbProv)) {
        Response::error('Unauthorized: invalid or missing token.', 401);
    }
    $id = CleaningButton::cleanId($_GET['button_id'] ?? ($_GET['id'] ?? ''));
    if ($id === '') {
        Response::error('button_id is required.', 422);
    }
    Response::json($cb->status($id));
}

// ── /cleaning/button — one press ────────────────────────────
if ($cbSub !== '') {
    Response::error('Unknown cleaning-button route.', 404);
}
if ($method !== 'POST' && $method !== 'GET') {
    Response::error('POST (or GET) button_id, action?=toggle|start|end.', 405);
}
if (!$cbHas($cbIngest, $cbProv)) {
    Response::error('Unauthorized: invalid or missing token.', 401);
}
$in = $cbIn();
$id = CleaningButton::cleanId($in['button_id'] ?? ($in['id'] ?? ''));
if ($id === '') {
    Response::error('button_id is required (letters, digits and . _ : - only, max 64).', 422);
}
$action = strtolower(trim((string) ($in['action'] ?? 'toggle')));
if (!in_array($action, CleaningButton::ACTIONS, true)) {
    Response::error('action must be toggle, start or end.', 422);
}
$res = $cb->press($id, ['action' => $action, 'employee_id' => $in['employee_id'] ?? '', 'ts' => $in['ts'] ?? null,
                        'location' => $in['location'] ?? '', 'name' => $in['name'] ?? '']);
// "end" with nothing running is a device-state mismatch, not a server fault.
Response::json($res, $res['ok'] ? 200 : ($res['result'] === 'disabled' ? 403 : 409));
