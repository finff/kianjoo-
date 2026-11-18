<?php
/**
 * Employee face photos — front / left side / right side (lib/Faces.php).
 * Included from api/index.php inside its try {} (shares $route, $seg, $method,
 * $config, $provisionAdmin). Lives in lib/ so it is never directly
 * web-reachable. The caller is resolved server-side (AiGuard); the dashboard
 * read token grants nothing here.
 *
 *   GET  /faces/me                            own linked employee's three slots + check verdicts   [signed in]
 *   POST /faces/me/{left|right}               multipart "file" → own side photo, then SenseStudio
 *                                             face check of that photo when the API is configured  [signed in, linked employee]
 *   POST /faces/me/{left|right}/remove        clear own side photo                                 [signed in, linked employee]
 *   GET  /faces/{personId}                    three slots + SenseStudio verdict per side           [signed in, view]
 *   POST /faces/{personId}/{front|left|right} multipart "file" → stored, re-encoded JPEG           [supervisor+ / provision]
 *   POST /faces/{personId}/{side}/remove      clear that photo                                     [supervisor+ / provision]
 *
 * Writes answer {person_id, side, url, faces:{sides, count}, profile}. Pushing
 * the faces to SenseStudio stays POST /employees/sync (it reports a verdict for
 * every side — Attendance::sync()).
 */

declare(strict_types=1);

if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

if (($seg[0] ?? '') !== 'faces') {
    return;   // not ours — fall through to the rest of api/index.php
}

require_once APP_ROOT . '/lib/AiGuard.php';
require_once APP_ROOT . '/lib/Faces.php';
require_once APP_ROOT . '/lib/Profile.php';

$fcPdo   = Database::connect($config['storage']);
$fcP     = AiGuard::require($fcPdo, isset($provisionAdmin) ? $provisionAdmin() : null);
$fcFaces = new Faces($fcPdo, APP_ROOT);
$fcWho   = (string) ($seg[1] ?? '');
$fcSide  = (string) ($seg[2] ?? '');
$fcAct   = (string) ($seg[3] ?? '');
$fcFile  = static function (): string {
    $f = $_FILES['file'] ?? [];
    $err = (int) ($f['error'] ?? UPLOAD_ERR_NO_FILE);
    if ($err === UPLOAD_ERR_INI_SIZE || $err === UPLOAD_ERR_FORM_SIZE) {
        Response::error('Max image size 6 MB.', 413);
    }
    if ($err !== UPLOAD_ERR_OK || !is_uploaded_file((string) ($f['tmp_name'] ?? ''))) {
        Response::error('multipart field "file" required.', 422);
    }
    if ((int) ($f['size'] ?? 0) > Faces::MAX_BYTES) {
        Response::error('Max image size 6 MB.', 413);
    }
    return (string) file_get_contents((string) $f['tmp_name']);
};

try {
    if ($fcWho === '') {
        Response::error('Unknown faces action.', 404);
    }

    // ── Self-service (staff app): own left / right photo ────
    if ($fcWho === 'me') {
        if (!empty($fcP['provision'])) {
            Response::error('Sign in required.', 401);
        }
        $pr = new Profile($fcPdo, APP_ROOT);
        if ($fcSide === '' && $method === 'GET') {
            $prof = $pr->get($fcP);
            Response::ok(['employee' => $prof['employee'], 'faces' => $prof['employee']['faces'] ?? null]);
        }
        if ($method !== 'POST' || !in_array($fcSide, ['left', 'right'], true) || !in_array($fcAct, ['', 'remove'], true)) {
            Response::error('Unknown faces action.', 404);
        }
        $prof = $pr->saveFacePhoto($fcP, $fcSide, $fcAct === 'remove' ? null : $fcFile());
        // Staff cannot run /employees/sync, so check the new side photo with
        // SenseStudio right away (face check only — the enrolment is untouched).
        $emp  = $prof['employee'] ?? [];
        $url  = (string) ($emp['photo_' . $fcSide . '_url'] ?? '');
        $file = $url !== '' ? APP_ROOT . '/' . ltrim($url, '/') : '';
        if ($fcAct !== 'remove' && $file !== '' && is_file($file) && trim((string) ($emp['staff_id'] ?? '')) !== '') {
            require_once APP_ROOT . '/lib/SenseApi.php';
            $api = new SenseApi($config['sense_api'] ?? [], APP_ROOT . '/storage');
            if ($api->ready()) {
                $tag = (string) preg_replace('/[^A-Za-z0-9_-]/', '', (string) $emp['staff_id']);
                $fcFaces->saveCheck((string) $emp['person_id'], $fcSide,
                    Faces::checkSide($api, (string) file_get_contents($file), $tag, $fcSide, $url));
                $prof = $pr->get($fcP);
            }
        }
        Response::ok(['side' => $fcSide, 'profile' => $prof, 'faces' => $prof['employee']['faces'] ?? null]);
    }

    // ── Operator: any employee ──────────────────────────────
    $pid = substr(trim($fcWho), 0, 64);
    $row = $fcFaces->row($pid);
    if ($row === null) {
        Response::error('Unknown employee.', 404);
    }
    if ($fcSide === '' && $method === 'GET') {
        AiGuard::demand($fcP, 'staff', 'view');
        Response::ok(['person_id' => $pid, 'faces' => Faces::summary($row)]);
    }
    if ($method !== 'POST' || !Faces::validSide($fcSide) || !in_array($fcAct, ['', 'remove'], true)) {
        Response::error('Unknown faces action.', 404);
    }
    AiGuard::demand($fcP, 'supervisor');
    $old = (string) ($row[Faces::SIDES[$fcSide]] ?? '');
    $url = $fcAct === 'remove' ? null : $fcFaces->storeUpload($pid, $fcSide, $fcFile());
    $fcFaces->setPhoto($pid, $fcSide, $url);
    $fcFaces->deleteFile($old !== '' ? $old : null, $pid);   // only our own p{pid}-{side}-… files

    $store = new EventStore($fcPdo, $config);
    Response::ok([
        'person_id' => $pid,
        'side'      => $fcSide,
        'url'       => $url,
        'faces'     => Faces::summary($fcFaces->row($pid) ?? []),
        'profile'   => $store->personProfiles()[$pid] ?? null,
    ]);
} catch (InvalidArgumentException $e) {
    Response::error($e->getMessage(), 422);
} catch (DomainException $e) {
    Response::error($e->getMessage(), 409);
} catch (RuntimeException $e) {
    Response::error($e->getMessage(), 500);
}
