<?php
/**
 * Front controller for the SenseTime ingest API.
 *
 * Routes (all under /api):
 *   GET  /health                         -> liveness (no auth)
 *   GET  /                               -> capability summary (no auth)
 *   POST /ingest[/{stream}]              -> receive a SenseTime HTTP-Push event   [ingest token]
 *   GET  /events                         -> list events (filters via query)        [read token]
 *   GET  /events/latest[/{stream}]       -> most recent event for a stream         [read token]
 *   GET  /events/{uuid}                  -> one event by uuid                       [read token]
 *   GET  /stats                          -> aggregate counts                        [read token]
 *   GET  /provision                      -> create DB / run migrations              [provision token]
 *
 * Auth token may be passed as ?token=, X-Ingest-Token / X-Read-Token header,
 * or Authorization: Bearer <token>.
 */

declare(strict_types=1);

define('APP_ROOT', dirname(__DIR__));

$config = require APP_ROOT . '/config/config.php';

require_once APP_ROOT . '/lib/Response.php';
require_once APP_ROOT . '/lib/Database.php';
require_once APP_ROOT . '/lib/EventStore.php';

Response::cors();

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// ── Resolve the route relative to /api ───────────────────────
$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$uri = rawurldecode($uri);
$pos = strpos($uri, '/api');
$route = $pos !== false ? substr($uri, $pos + 4) : $uri;
$route = preg_replace('#^/index\.php#', '', $route) ?? $route;
$route = '/' . trim($route, '/');
$seg = $route === '/' ? [] : explode('/', trim($route, '/'));

// ── Helpers ──────────────────────────────────────────────────
$token = static function (): string {
    if (!empty($_GET['token'])) {
        return (string) $_GET['token'];
    }
    foreach (['HTTP_X_INGEST_TOKEN', 'HTTP_X_READ_TOKEN'] as $h) {
        if (!empty($_SERVER[$h])) {
            return (string) $_SERVER[$h];
        }
    }
    $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (stripos($auth, 'Bearer ') === 0) {
        return trim(substr($auth, 7));
    }
    return '';
};

$requireToken = static function (string $expected) use ($token): void {
    $given = $token();
    if ($expected === '' || !hash_equals($expected, $given)) {
        Response::error('Unauthorized: invalid or missing token.', 401);
    }
};

try {
    // ── Public routes ────────────────────────────────────────
    if ($method === 'GET' && ($route === '/' || $route === '/health')) {
        if ($route === '/health') {
            Response::ok(['service' => $config['app']['name'], 'time' => date('c')]);
        }
        Response::json([
            'ok'      => true,
            'service' => $config['app']['name'],
            'purpose' => 'Capture SenseTime / MyVisionAI HTTP-Push events (SenseFoundry §6.5) for reuse.',
            'endpoints' => [
                'POST /api/ingest/face/{stream}?token=INGEST_TOKEN' => 'Face-recognition feed push',
                'POST /api/ingest/body/{stream}?token=INGEST_TOKEN' => 'Body-attribution feed push',
                'POST /api/ingest/{stream}?token=INGEST_TOKEN' => 'Receive an event push (feed auto-detected)',
                'GET  /api/events?token=READ_TOKEN'            => 'List events (filters: stream, trigger_image_type, event_type, device_serial, policy_name, uuid, from, to, limit, offset)',
                'GET  /api/events/latest/{stream}?token=READ_TOKEN' => 'Latest event for a stream',
                'GET  /api/events/{uuid}?token=READ_TOKEN'     => 'One event by uuid',
                'GET  /api/stats?token=READ_TOKEN'             => 'Aggregate counts',
            ],
        ]);
    }

    // ── Provision (idempotent; connect() auto-migrates) ──────
    if ($route === '/provision') {
        $requireToken($config['auth']['provision_token']);
        $pdo    = Database::connect($config['storage']);
        $driver = Database::driver();
        $db     = $driver === 'mysql' ? $config['storage']['mysql']['name'] : basename($config['storage']['db_path']);
        Response::ok(['migrated' => true, 'driver' => $driver, 'db' => $db]);
    }

    // ── Ingest attempt log (debugging pushes) ────────────────
    // GET /ingest/log?token=READ_TOKEN → the last N attempts, including ones
    // rejected before storage (bad token, bad body). Answers "is SenseStudio
    // even reaching us?" without digging through web-server logs.
    if ($route === '/ingest/log' && $method === 'GET') {
        $requireToken($config['auth']['read_token']);
        $file  = dirname((string) ($config['storage']['raw_log'] ?? '')) . '/ingest_attempts.log';
        $lines = is_file($file) ? (file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: []) : [];
        $n     = max(1, min(500, (int) ($_GET['limit'] ?? 50)));
        Response::ok([
            'file'     => basename($file),
            'attempts' => array_slice($lines, -$n),
            'total'    => count($lines),
        ]);
    }

    // ── Ingest (webhook receiver) ────────────────────────────
    if (($seg[0] ?? '') === 'ingest') {
        // Record every attempt (even rejected ones) before anything can fail.
        $logAttempt = static function (string $note) use ($config, $route, $method): void {
            $dir = dirname((string) ($config['storage']['raw_log'] ?? ''));
            if ($dir === '' || $dir === '.') {
                return;
            }
            $file = $dir . '/ingest_attempts.log';
            if (is_file($file) && filesize($file) > 262144) {   // keep the tail only
                $keep = array_slice(file($file) ?: [], -300);
                @file_put_contents($file, implode('', $keep));
            }
            @file_put_contents($file, sprintf(
                "%s %s %s %s ua=%s ct=%s %s\n",
                date('Y-m-d H:i:s'),
                $_SERVER['REMOTE_ADDR'] ?? '-',
                $method,
                $route . ($_SERVER['QUERY_STRING'] ?? '' ? '?' . preg_replace('/token=[^&]+/', 'token=***', (string) $_SERVER['QUERY_STRING']) : ''),
                substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? '-'), 0, 60),
                substr((string) ($_SERVER['CONTENT_TYPE'] ?? '-'), 0, 40),
                $note
            ), FILE_APPEND);
        };
        $logAttempt('received');

        // SenseStudio HTTP Push is POST (§6.5.1); accept PUT too for safety.
        if ($method !== 'POST' && $method !== 'PUT') {
            Response::error('Ingest requires POST.', 405);
        }

        // Two separate push feeds, one URL each, so SenseStudio policies can be
        // wired independently and the dashboard knows which pipeline fired:
        //   /api/ingest/face/{stream}   face-recognition policies
        //   /api/ingest/body/{stream}   body-attribution policies
        //   /api/ingest/{stream}        legacy/untagged — kind is inferred
        // A trailing segment still works as the token when the push URL field
        // strips query strings: /api/ingest/face/{stream}/{token}.
        $feedKind = null;
        $path     = array_slice($seg, 1);
        if (isset($path[0]) && in_array(strtolower($path[0]), ['face', 'body'], true)) {
            $feedKind = strtolower(array_shift($path));
        } elseif (!empty($_GET['feed']) && in_array(strtolower((string) $_GET['feed']), ['face', 'body'], true)) {
            $feedKind = strtolower((string) $_GET['feed']);
        }
        $stream = $path[0] ?? ($_GET['stream'] ?? $_GET['source'] ?? null);
        if (empty($_GET['token']) && isset($path[1]) && $path[1] !== '') {
            $_GET['token'] = $path[1];
        }
        // A push URL saved with the literal placeholder — /api/ingest/face/{stream}
        // — means "no stream given": fall back to the payload's deviceSerial.
        if (is_string($stream) && preg_match('/^[\{\<%]|[\}\>]$/', trim($stream))) {
            $stream = null;
        }

        $requireToken($config['auth']['ingest_token']);

        $raw = file_get_contents('php://input') ?: '';
        $payload = json_decode($raw, true);
        if (!is_array($payload)) {
            // Fall back to form-encoded bodies just in case.
            if (!empty($_POST)) {
                $payload = $_POST;
            } else {
                $logAttempt('REJECTED body-not-json len=' . strlen($raw) . ' head=' . substr(str_replace("\n", ' ', $raw), 0, 120));
                Response::error('Body must be valid JSON.', 400);
            }
        }

        $pdo   = Database::connect($config['storage']);
        $store = new EventStore($pdo, $config);
        $rec   = $store->store($payload, $stream !== null ? (string) $stream : null, $_SERVER['REMOTE_ADDR'] ?? null, $feedKind);
        $logAttempt('STORED id=' . $rec['id'] . ' stream=' . $rec['stream'] . ' feed=' . ($rec['feed_kind'] ?? '-')
            . ' policy=' . (string) ($payload['policyName'] ?? '-'));

        // SenseTime treats any 200 as success.
        Response::ok([
            'id'      => $rec['id'],
            'uuid'    => $rec['uuid'],
            'stream'  => $rec['stream'],
            'feed'    => $rec['feed_kind'] ?? '',
            'images'  => $rec['images'],
            'decoded' => $rec['decoded'],
        ]);
    }

    // ── Purge every stored detection (Settings → Danger zone) ─
    // POST /events/purge {confirm:"PURGE"} → wipes events, attributes and the
    // incident log. Cameras, users, tokens and settings are untouched.
    // Declared before the /events reader so "purge" isn't read as a uuid.
    if ($route === '/events/purge' && $method === 'POST') {
        $requireToken($config['auth']['read_token']);
        $in = json_decode(file_get_contents('php://input') ?: '', true) ?: [];
        if (($in['confirm'] ?? '') !== 'PURGE') {
            Response::error('Send {"confirm":"PURGE"} to wipe all event data.', 400);
        }
        $pdo    = Database::connect($config['storage']);
        $before = (int) $pdo->query('SELECT COUNT(*) FROM events')->fetchColumn();
        // Children first — event_attributes/incident_log reference events.
        foreach (['event_attributes', 'incident_log', 'events'] as $t) {
            try {
                $pdo->exec("DELETE FROM {$t}");
            } catch (Throwable $e) {
                error_log('[purge] ' . $t . ': ' . $e->getMessage());
            }
        }
        // Drop derived caches so the dashboard doesn't serve stale summaries.
        $raw = (string) ($config['storage']['raw_log'] ?? '');
        if ($raw !== '') {
            foreach (['', '.ai.json', '.reviews.json'] as $suffix) {
                @unlink($raw . $suffix);
            }
        }
        Response::ok(['purged' => $before]);
    }

    // ── Reads ────────────────────────────────────────────────
    if (($seg[0] ?? '') === 'events') {
        $requireToken($config['auth']['read_token']);
        $pdo   = Database::connect($config['storage']);
        $store = new EventStore($pdo, $config);

        // /events/latest[/{stream}]
        if (($seg[1] ?? '') === 'latest') {
            $stream = $seg[2] ?? ($_GET['stream'] ?? null);
            $rec = $store->latest($stream !== null ? (string) $stream : null);
            Response::ok(['event' => $rec]);
        }

        // POST /events/{uuid}/status  {status: ack|resolved|open, assignee?}
        if (isset($seg[1], $seg[2]) && $seg[2] === 'status') {
            if ($method !== 'POST') {
                Response::error('Status update requires POST.', 405);
            }
            $in = json_decode(file_get_contents('php://input') ?: '', true) ?: $_POST;
            $ok = $store->setStatus((string) $seg[1], (string) ($in['status'] ?? ''), $in['assignee'] ?? null);
            if (!$ok) {
                Response::error('Event not found or invalid status.', 404);
            }
            Response::ok(['uuid' => $seg[1], 'status' => $in['status'] ?? null]);
        }

        // ── Incident-ticket operations on one event ──────────
        $uuid = (string) ($seg[1] ?? '');
        $act  = (string) ($seg[2] ?? '');
        $body = static fn (): array => json_decode(file_get_contents('php://input') ?: '', true) ?: $_POST;
        $attDir = APP_ROOT . '/storage/attachments/' . preg_replace('/[^a-zA-Z0-9_\-]/', '_', $uuid);

        // POST /events/{uuid}/ticket — escalate a detection into a ticket
        if ($uuid !== '' && $act === 'ticket' && $method === 'POST') {
            $in = $body();
            $no = $store->ticket($uuid, $in['actor'] ?? null);
            $no === null ? Response::error('Event not found.', 404) : Response::ok(['uuid' => $uuid, 'ticket' => $no]);
        }
        // GET/POST /events/{uuid}/log — change history & communications
        if ($uuid !== '' && $act === 'log') {
            if ($method === 'POST') {
                $in   = $body();
                $kind = in_array($in['kind'] ?? '', ['comment', 'remark', 'system'], true) ? $in['kind'] : 'comment';
                $note = trim((string) ($in['note'] ?? ''));
                // The dashboard editor submits rich text — keep a safe HTML
                // subset, strip event handlers and javascript: URLs.
                $note = strip_tags($note, '<b><strong><i><em><u><s><ul><ol><li><br><p><a><blockquote>');
                $note = preg_replace('/\son\w+\s*=\s*("[^"]*"|\'[^\']*\'|[^\s>]+)/i', '', $note) ?? $note;
                $note = preg_replace('/(href\s*=\s*["\']?)\s*javascript:[^"\'>\s]*/i', '$1#', $note) ?? $note;
                if (trim(strip_tags($note)) === '') {
                    Response::error('note is required.', 422);
                }
                $store->addLog($uuid, $kind, $in['actor'] ?? null, null, null, mb_substr($note, 0, 8000));
                if ($kind === 'remark') {
                    $store->setStatus($uuid, 'resolved', $in['actor'] ?? null);
                }
            }
            Response::ok(['uuid' => $uuid, 'log' => $store->getLog($uuid)]);
        }
        // POST /events/{uuid}/severity — incident level escalation / de-escalation
        if ($uuid !== '' && $act === 'severity' && $method === 'POST') {
            $in = $body();
            $ok = $store->setSeverity($uuid, (string) ($in['severity'] ?? ''), $in['actor'] ?? null, $in['note'] ?? null);
            $ok ? Response::ok(['uuid' => $uuid, 'severity' => $in['severity']]) : Response::error('Invalid severity or event.', 422);
        }
        // POST /events/{uuid}/notify — escalation matrix: email / Emergency Response Team
        if ($uuid !== '' && $act === 'notify' && $method === 'POST') {
            $in  = $body();
            $ch  = ($in['channel'] ?? '') === 'tmforce' ? 'tmforce' : 'email';
            $rec = $store->find($uuid);
            if (!$rec) {
                Response::error('Event not found.', 404);
            }
            require_once APP_ROOT . '/lib/DashboardMapper.php';
            require_once APP_ROOT . '/lib/Mailer.php';
            require_once APP_ROOT . '/lib/EmailTemplate.php';
            $inc    = DashboardMapper::incident($rec);
            $tag    = $ch === 'tmforce' ? 'ERT ESCALATION' : 'INCIDENT ESCALATION';
            $note   = trim((string) ($in['note'] ?? ''));
            $ticket = (string) ($inc['ticket'] ?: $inc['id']);
            $sevCol = EmailTemplate::sevColor($inc['sev']);
            $banCol = $ch === 'tmforce' ? EmailTemplate::COLORS['critical'] : EmailTemplate::COLORS['brand'];
            $lead   = $ch === 'tmforce'
                ? 'This incident has been escalated to the Emergency Response Team (ERT) for on-site response.'
                : 'This incident has been escalated by ' . ($in['actor'] ?? 'an operator') . ' and requires attention.';
            $content = EmailTemplate::heading($ticket, $banCol)
                . EmailTemplate::sub($inc['title'])
                . '<div style="margin:0 0 16px;">' . EmailTemplate::chip(strtoupper($inc['sev']), $sevCol) . ' '
                . EmailTemplate::chip(strtoupper($inc['status']), EmailTemplate::COLORS['low']) . '</div>'
                . EmailTemplate::p($lead)
                . ($note !== '' ? EmailTemplate::note($note, 'ESCALATION NOTE · ' . strtoupper((string) ($in['actor'] ?? 'OPERATOR'))) : '')
                . EmailTemplate::image($inc['image'] ?? null, 'Detection frame · ' . $inc['camera'] . ' (' . $inc['device'] . ')')
                . EmailTemplate::rows([
                    ['Ticket', $ticket, $banCol],
                    ['Camera', $inc['camera'] . ($inc['device'] ? ' · ' . $inc['device'] : '')],
                    ['Zone / Policy', $inc['zone']],
                    ['Severity', strtoupper($inc['sev']), $sevCol],
                    ['Status', strtoupper($inc['status'])],
                    ['Detected', $inc['received'] ?: '—'],
                ])
                . EmailTemplate::buttons([
                    ['Open incident ticket', EmailTemplate::host() . '/', true, $banCol],
                    ['Open dashboard', EmailTemplate::host() . '/', false],
                ]);
            $html = EmailTemplate::shell($tag . ' — ' . $inc['title'], $tag, $banCol, $content,
                $ch === 'tmforce' ? 'Routed via the Kian Joo VisionAI escalation matrix (critical/ERT channel).' : '');
            // Escalation-matrix routing (Settings → Notifications), base list fallback.
            $routing = $config['routing'] ?? [];
            $to = $ch === 'tmforce'
                ? array_merge($routing['tmforce'] ?? [], $routing['admin'] ?? [])
                : array_merge($routing['soc'] ?? [], $routing['supervisor'] ?? []);
            $to = array_values(array_unique($to ?: ($config['mail']['to'] ?? [])));
            $mailer = new Mailer($config['mail']);
            $sent   = $mailer->ready() && $mailer->send('[Kian Joo VisionAI] ' . $tag . ' — ' . $ticket, $html, $to);
            $store->addLog($uuid, $ch === 'tmforce' ? 'tmforce' : 'notify', $in['actor'] ?? null, null, null,
                ($ch === 'tmforce' ? 'Informed Emergency Response Team' : 'Escalation email sent')
                . ($sent ? '' : ' (email FAILED)') . ($note !== '' ? ' — ' . mb_substr($note, 0, 500) : ''));
            Response::json(['ok' => $sent, 'channel' => $ch], $sent ? 200 : 502);
        }
        // POST /events/{uuid}/attach — multipart file upload; GET …/attachments — list
        if ($uuid !== '' && $act === 'attach' && $method === 'POST') {
            if (empty($_FILES['file']) || !is_uploaded_file($_FILES['file']['tmp_name'])) {
                Response::error('multipart field "file" required.', 422);
            }
            if ((int) $_FILES['file']['size'] > 10 * 1024 * 1024) {
                Response::error('Max attachment size 10 MB.', 413);
            }
            $name = preg_replace('/[^a-zA-Z0-9._\-]/', '_', basename((string) $_FILES['file']['name']));
            if ($name === '' || preg_match('/\.(php\d?|phtml|phar|cgi|pl|sh)$/i', $name)) {
                Response::error('File type not allowed.', 422);
            }
            if (!is_dir($attDir)) {
                @mkdir($attDir, 0775, true);
            }
            if (!move_uploaded_file($_FILES['file']['tmp_name'], $attDir . '/' . $name)) {
                Response::error('Upload failed.', 500);
            }
            $store->addLog($uuid, 'attachment', $_POST['actor'] ?? null, null, $name, 'Attachment added');
            Response::ok(['uuid' => $uuid, 'file' => $name]);
        }
        if ($uuid !== '' && $act === 'attachments') {
            // Uploader + upload time come from the incident log (kind=attachment).
            $meta = [];
            foreach ($store->getLog($uuid) as $l) {
                if (($l['kind'] ?? '') === 'attachment' && !empty($l['to_val'])) {
                    $meta[$l['to_val']] = ['by' => $l['actor'] ?: '—', 'at' => $l['created_at'] ?: ''];
                }
            }
            $files = [];
            if (is_dir($attDir)) {
                foreach (scandir($attDir) ?: [] as $f) {
                    if ($f !== '.' && $f !== '..' && is_file($attDir . '/' . $f)) {
                        $files[] = ['name' => $f, 'size' => filesize($attDir . '/' . $f),
                                    'by'   => $meta[$f]['by'] ?? '—',
                                    'at'   => $meta[$f]['at'] ?? date('Y-m-d H:i:s', filemtime($attDir . '/' . $f) ?: time()),
                                    'url'  => '/api/events/' . rawurlencode($uuid) . '/attachment?f=' . rawurlencode($f) . '&token=' . rawurlencode($config['auth']['read_token'])];
                    }
                }
            }
            Response::ok(['uuid' => $uuid, 'files' => $files]);
        }
        if ($uuid !== '' && $act === 'attachment') {
            $f = basename((string) ($_GET['f'] ?? ''));
            $path = $attDir . '/' . $f;
            if ($f === '' || !is_file($path)) {
                Response::error('Attachment not found.', 404);
            }
            $mime = function_exists('mime_content_type') ? (mime_content_type($path) ?: 'application/octet-stream') : 'application/octet-stream';
            header('Content-Type: ' . $mime);
            header('Content-Length: ' . filesize($path));
            header('Content-Disposition: inline; filename="' . $f . '"');
            readfile($path);
            exit;
        }

        // /events/{uuid}
        if (isset($seg[1]) && $seg[1] !== '') {
            $rec = $store->find($seg[1]);
            if ($rec === null) {
                Response::error('Event not found.', 404);
            }
            Response::ok(['event' => $rec]);
        }

        // /events (list)
        $events = $store->query([
            'stream'             => $_GET['stream'] ?? null,
            'device_serial'      => $_GET['device_serial'] ?? null,
            'trigger_image_type' => $_GET['trigger_image_type'] ?? null,
            'event_type'         => $_GET['event_type'] ?? null,
            'policy_name'        => $_GET['policy_name'] ?? null,
            'person_id'          => $_GET['person_id'] ?? null,
            'feed_kind'          => $_GET['feed_kind'] ?? null,
            'uuid'               => $_GET['uuid'] ?? null,
            'from'               => $_GET['from'] ?? null,
            'to'                 => $_GET['to'] ?? null,
            'limit'              => $_GET['limit'] ?? 50,
            'offset'             => $_GET['offset'] ?? 0,
        ]);
        Response::ok(['count' => count($events), 'events' => $events]);
    }

    // ── Assistant / agent read API (/api/ai/*) ───────────────
    // The Weststar AI agent calls these through its permissioned http tool
    // (Authorization: Bearer <read token>). Everything here is read-only and
    // pre-summarised — see lib/AiContext.php.
    if (($seg[0] ?? '') === 'ai') {
        $requireToken($config['auth']['read_token']);
        require_once APP_ROOT . '/lib/Text.php';
        require_once APP_ROOT . '/lib/Attributes.php';
        require_once APP_ROOT . '/lib/DashboardMapper.php';
        require_once APP_ROOT . '/lib/AiContext.php';

        $ctx = new AiContext(new EventStore(Database::connect($config['storage']), $config), $config);
        $act = $seg[1] ?? '';
        $out = match ($act) {
            '', 'help'   => $ctx->help(),
            'summary'    => $ctx->summary((int) ($_GET['hours'] ?? 24)),
            'detections' => $ctx->detections($_GET),
            'incidents'  => $ctx->incidents($_GET),
            'incident'   => $ctx->incident((string) ($_GET['id'] ?? '')),
            'people'     => $ctx->people($_GET),
            'cameras'    => $ctx->cameras(),
            default      => null,
        };
        if ($out === null) {
            Response::error('Unknown endpoint "/ai/' . $act . '". Call /api/ai/help for the list.', 404);
        }
        Response::ok(['endpoint' => '/ai/' . ($act ?: 'help')] + $out);
    }

    // ── Face search by image (POST /api/face/search) ─────────
    // Drop a photo into the assistant → 1:N search against the VisionAI
    // libraries (§6.4.1) → the matched personIds, each enriched with what this
    // dashboard knows about them so the chat can show an openable profile card.
    if ($route === '/face/search') {
        $requireToken($config['auth']['read_token']);
        if ($method !== 'POST') {
            Response::error('POST a multipart form with field "file".', 405);
        }
        if (empty($_FILES['file']) || !is_uploaded_file($_FILES['file']['tmp_name'])) {
            Response::error('multipart field "file" required.', 422);
        }
        if ((int) $_FILES['file']['size'] > 6 * 1024 * 1024) {
            Response::error('Max image size 6 MB.', 413);
        }
        $info = @getimagesize($_FILES['file']['tmp_name']);
        if (!$info || !in_array($info['mime'] ?? '', ['image/jpeg', 'image/png', 'image/webp'], true)) {
            Response::error('Only JPG, PNG or WEBP images can be searched.', 422);
        }

        require_once APP_ROOT . '/lib/Text.php';
        require_once APP_ROOT . '/lib/SenseApi.php';
        $api = new SenseApi($config['sense_api'], APP_ROOT . '/storage');

        // Search both libraries: strangers first (that is where detection
        // personIds live), then the enrolled person list. The engine's default
        // threshold rejects everything below a near-certain match, so pass one
        // explicitly — the UI colour-codes weak scores rather than hiding them.
        $minScore = (float) ($_GET['threshold'] ?? 0.35);
        $minScore = max(0.05, min(0.95, $minScore));
        $hits = [];
        $errs = [];
        foreach (['Passer', 'Target'] as $type) {
            $r = $api->searchFaceByImage($_FILES['file']['tmp_name'], $type, 5, $minScore);
            if (!$r['ok']) {
                $errs[] = $type . ': ' . ($r['error'] ?? $r['msg'] ?? 'search failed');
                continue;
            }
            foreach ((array) ($r['data'] ?? []) as $m) {
                $pid = (string) ($m['personID'] ?? $m['personId'] ?? '');
                if ($pid === '') {
                    continue;
                }
                $score = (float) ($m['score'] ?? 0);
                if (!isset($hits[$pid]) || $score > $hits[$pid]['score']) {
                    // `avatar` is undocumented but returned: the library's own
                    // face image for this person — the best thumbnail we can show.
                    $hits[$pid] = ['personId' => $pid, 'score' => $score,
                                   'avatar'  => (string) ($m['avatar'] ?? ''),
                                   'library' => (string) ($m['targetType'] ?? $type)];
                }
            }
        }
        if (!$hits && $errs) {
            Response::json(['ok' => false, 'error' => 'VisionAI face search failed — ' . implode('; ', $errs)], 502);
        }
        usort($hits, static fn ($a, $b) => $b['score'] <=> $a['score']);
        $hits = array_slice(array_values($hits), 0, 5);

        // Enrich each match from our own record: captures, cameras, photo, profile.
        $store    = new EventStore(Database::connect($config['storage']), $config);
        $profiles = $store->personProfiles();
        $out      = [];
        foreach ($hits as $h) {
            $rows = $store->query(['person_id' => $h['personId'], 'limit' => 200]);
            $pr   = $profiles[$h['personId']] ?? null;
            $cams = [];
            foreach ($rows as $r) {
                $c = strtoupper((string) ($r['stream'] ?: ($r['device_serial'] ?? '')));
                if ($c !== '') {
                    $cams[$c] = true;
                }
            }
            $newest = $rows[0] ?? null;
            $oldest = $rows ? $rows[count($rows) - 1] : null;
            $pct    = $h['score'] <= 1 ? $h['score'] * 100 : $h['score'];
            $out[]  = [
                'personId'   => $h['personId'],
                'score'      => round($pct, 1),
                'library'    => $h['library'] === 'Target' ? 'person list' : 'stranger list',
                'name'       => $pr['name'] ?? null,
                'registered' => (bool) $pr,
                'about'      => $pr['about'] ?? ($pr['notes'] ?? null),
                'photo'      => $pr['photo']
                    ?? ($newest['images']['trigger'] ?? null)
                    ?? ($h['avatar'] !== '' ? $store->fullUrl($h['avatar']) : null),
                'confident'  => $pct >= 75,
                'captures'   => count($rows),
                'cameras'    => array_keys($cams),
                'firstSeen'  => $oldest['received_at'] ?? null,
                'lastSeen'   => $newest['received_at'] ?? null,
                'eventUuid'  => $newest['uuid'] ?? null,
            ];
        }
        Response::ok(['matches' => $out, 'searched' => count($hits),
                      'note' => $out ? null : 'No face in the VisionAI libraries matched this image.',
                      'warnings' => $errs ?: null]);
    }

    // ── Assistant chat proxy (POST /api/assistant) ───────────
    // The browser never sees the Weststar AI key: it posts the conversation
    // here and this forwards it to the agent, which answers from its documents
    // and — through its own http tool — from /api/ai/* above.
    if ($route === '/assistant') {
        $requireToken($config['auth']['read_token']);
        if ($method !== 'POST') {
            Response::error('POST {messages:[{role,content}]}.', 405);
        }
        require_once APP_ROOT . '/lib/Llm.php';
        $llm = new Llm($config['ai']);
        if (!$llm->ready()) {
            Response::json(['ok' => false, 'error' => 'No API key set for ' . (Llm::LABEL[$llm->provider()] ?? 'the selected provider')
                . '. Add one in Settings → AI Source.'], 503);
        }

        $in   = json_decode(file_get_contents('php://input') ?: '', true) ?: [];
        $msgs = [];
        foreach (array_slice(is_array($in['messages'] ?? null) ? $in['messages'] : [], -8) as $m) {
            $role = ($m['role'] ?? '') === 'assistant' ? 'assistant' : 'user';
            $text = trim((string) ($m['content'] ?? ''));
            if ($text !== '') {
                $msgs[] = ['role' => $role, 'content' => mb_substr($text, 0, 2000)];
            }
        }
        if (!$msgs) {
            Response::error('At least one message is required.', 422);
        }

        // The Weststar agent pulls live data itself through its http tool; the
        // direct providers have no tools, so hand them a snapshot up front.
        $context = '';
        if ($llm->provider() !== 'weststar') {
            require_once APP_ROOT . '/lib/Text.php';
            require_once APP_ROOT . '/lib/Attributes.php';
            require_once APP_ROOT . '/lib/DashboardMapper.php';
            require_once APP_ROOT . '/lib/AiContext.php';
            $ctx  = new AiContext(new EventStore(Database::connect($config['storage']), $config), $config);
            $sum  = $ctx->summary(24);
            $cams = $ctx->cameras();
            $ppl  = $ctx->people(['days' => 7, 'limit' => 10]);
            $recent = [];
            foreach ($ctx->detections(['hours' => 24, 'limit' => 15])['data'] as $d) {
                $recent[] = '- ' . implode(' · ', array_filter([
                    $d['when'] ?? '', $d['camera'] ?? '', $d['module'] ?? '',
                    $d['what'] ?? '', ($d['severity'] ?? '') . '/' . ($d['status'] ?? ''),
                ]));
            }
            $context = $sum['summary'] . "\n\n" . $cams['summary'] . "\n" . $ppl['summary']
                . ($recent ? "\n\nMost recent detections:\n" . implode("\n", $recent) : '');
        }

        @set_time_limit(180);
        $res = $llm->chat($msgs, $context);
        if (!empty($res['ok'])) {
            Response::ok(['answer' => $res['answer'], 'citations' => $res['citations'] ?? [],
                          'model' => $res['model'] ?? '', 'provider' => $llm->provider(),
                          'used_tools' => !empty($res['used_tools'])]);
        }
        Response::json(['ok' => false, 'error' => $res['error'] ?? 'The assistant could not answer.',
                        'provider' => $llm->provider(), 'upstream' => $res['upstream'] ?? 0], 502);
    }

    // ── Attendance & movement (POC Use Case 1) ───────────────
    // GET /attendance?days=          → per-person entry / latest detection /
    //                                  latest-known location, split Known vs
    //                                  Unknown Personnel
    // GET /attendance/person?person_id=&days= → chronological movement journey
    //                                  across the predefined camera points
    if ($route === '/attendance' || $route === '/attendance/person') {
        $requireToken($config['auth']['read_token']);
        $pdo    = Database::connect($config['storage']);
        $store  = new EventStore($pdo, $config);
        $locMap = $config['poc']['cam_locations'] ?? [];
        $days   = max(1, min(90, (int) ($_GET['days'] ?? 1)));

        if ($route === '/attendance/person') {
            $pid = trim((string) ($_GET['person_id'] ?? ''));
            if ($pid === '') {
                Response::error('person_id is required.', 400);
            }
            Response::ok([
                'person_id' => $pid,
                'days'      => $days,
                'journey'   => $store->movementJourney($pid, $locMap, $days),
                'profile'   => $store->personProfiles()[$pid] ?? null,
                'locations' => $config['poc']['locations'] ?? [],
            ]);
        }

        $rows     = $store->attendanceReport($locMap, $days, (int) ($config['poc']['inactivity_min'] ?? 45));
        $profiles = $store->personProfiles();
        $known    = [];
        $unknown  = [];
        foreach ($rows as $r) {
            $pr = $profiles[$r['personId']] ?? null;
            if ($pr !== null) {
                $r['name']    = $pr['name'];
                $r['staffId'] = $pr['staffId'] ?? '';
                $r['photo']   = $pr['photo'] ?? '';
                $known[] = $r;
            } else {
                $unknown[] = $r;   // Unknown Personnel — detected, not enrolled
            }
        }
        Response::ok([
            'days'           => $days,
            'inactivity_min' => (int) ($config['poc']['inactivity_min'] ?? 45),
            'known'          => $known,
            'unknown'        => $unknown,
            'locations'      => $config['poc']['locations'] ?? [],
            'mapped_cams'    => count($locMap),
            'enrolled'       => count($profiles),
        ]);
    }

    // ── People roster + profiles ─────────────────────────────
    // GET  /persons            → unique tracked people (grouped by personId)
    // POST /persons            → create/update a profile {person_id, name, notes, photo_url}
    // POST /persons/delete     → remove a profile {person_id}
    // POST /persons/photo      → multipart {person_id, file} → stored profile picture URL
    if ($route === '/persons' || $route === '/persons/delete' || $route === '/persons/photo') {
        $requireToken($config['auth']['read_token']);

        // Operator-supplied profile picture (attached file or phone camera shot).
        // Stored under /uploads/profiles so it is served straight off the web
        // root — SenseStudio capture URLs expire, an enrolled photo must not.
        if ($route === '/persons/photo') {
            if ($method !== 'POST') {
                Response::error('POST a multipart form with person_id + file.', 405);
            }
            $pid = preg_replace('/[^A-Za-z0-9_\-]/', '', (string) ($_POST['person_id'] ?? ''));
            if ($pid === '') {
                Response::error('person_id is required.', 400);
            }
            if (empty($_FILES['file']) || !is_uploaded_file($_FILES['file']['tmp_name'])) {
                Response::error('multipart field "file" required.', 422);
            }
            if ((int) $_FILES['file']['size'] > 6 * 1024 * 1024) {
                Response::error('Max image size 6 MB.', 413);
            }
            $info = @getimagesize($_FILES['file']['tmp_name']);
            $exts = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp', 'image/gif' => 'gif'];
            $ext  = $exts[$info['mime'] ?? ''] ?? '';
            if (!$info || $ext === '') {
                Response::error('Only JPG, PNG, WEBP or GIF images are accepted.', 422);
            }
            $dir = APP_ROOT . '/uploads/profiles';
            if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
                Response::error('Could not create the upload folder.', 500);
            }
            $name = 'p' . $pid . '-' . date('YmdHis') . '-' . bin2hex(random_bytes(3)) . '.' . $ext;
            if (!move_uploaded_file($_FILES['file']['tmp_name'], $dir . '/' . $name)) {
                Response::error('Upload failed.', 500);
            }
            @chmod($dir . '/' . $name, 0644);
            Response::ok(['person_id' => $pid, 'file' => $name, 'url' => '/uploads/profiles/' . $name]);
        }

        $pdo   = Database::connect($config['storage']);
        $store = new EventStore($pdo, $config);

        if ($method === 'POST') {
            $in = json_decode(file_get_contents('php://input') ?: '', true) ?: [];
            $pid = trim((string) ($in['person_id'] ?? ''));
            if ($pid === '') {
                Response::error('person_id is required.', 400);
            }
            if ($route === '/persons/delete') {
                $store->deletePersonProfile($pid);
                Response::ok(['deleted' => $pid]);
            }
            $name = trim((string) ($in['name'] ?? ''));
            if ($name === '') {
                Response::error('name is required.', 400);
            }
            $gender = strtolower(trim((string) ($in['gender'] ?? '')));
            $gender = in_array($gender, ['male', 'female', 'other', ''], true) ? $gender : '';
            $ok = $store->savePersonProfile($pid, [
                'name'     => $name,
                'staff_id' => preg_replace('/[^A-Za-z0-9_\-\/]/', '', (string) ($in['staff_id'] ?? '')),
                'age'      => preg_replace('/[^0-9\-]/', '', (string) ($in['age'] ?? '')),
                'gender'   => $gender,
                'about'    => (string) ($in['about'] ?? $in['notes'] ?? ''),
                'photo'    => !empty($in['photo_url']) ? substr((string) $in['photo_url'], 0, 500) : null,
            ], substr((string) ($in['actor'] ?? ''), 0, 64) ?: null);
            Response::ok(['saved' => $ok, 'person_id' => $pid, 'profiles' => $store->personProfiles()]);
        }

        $days = max(1, min(90, (int) ($_GET['days'] ?? 7)));
        Response::ok([
            'people'   => $store->personRoster($days, max(1, min(500, (int) ($_GET['limit'] ?? 200)))),
            'profiles' => $store->personProfiles(),
        ]);
    }

    if (($seg[0] ?? '') === 'stats') {
        $requireToken($config['auth']['read_token']);
        $pdo   = Database::connect($config['storage']);
        $store = new EventStore($pdo, $config);
        Response::ok(['stats' => $store->stats()]);
    }

    // ── Alert settings (dashboard Alert Rules page) ──────────
    // GET  /alerts → effective settings; POST /alerts → persist overrides
    // to storage/alert_settings.json (merged over .env by config.php).
    if ($route === '/alerts') {
        $requireToken($config['auth']['read_token']);
        require_once APP_ROOT . '/lib/DashboardMapper.php';
        $file = APP_ROOT . '/storage/alert_settings.json';

        if ($method === 'POST') {
            $in  = json_decode(file_get_contents('php://input') ?: '', true) ?: [];
            $out = [];

            $sev = strtolower((string) ($in['min_severity'] ?? ''));
            if (in_array($sev, ['low', 'medium', 'high', 'critical', 'off'], true)) {
                $out['min_severity'] = $sev;
            }
            if (isset($in['always_mods']) && is_array($in['always_mods'])) {
                $out['always_mods'] = array_values(array_intersect(
                    array_map('strtolower', array_map('strval', $in['always_mods'])),
                    ['fire', 'ppe', 'intr', 'face']
                ));
            }
            if (isset($in['intr_armed'])) {
                $armed = strtolower(trim((string) $in['intr_armed']));
                if ($armed === 'always' || $armed === 'off'
                    || preg_match('/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/', $armed)) {
                    $out['intr_armed'] = $armed;
                }
            }
            if (isset($in['mods_enabled']) && is_array($in['mods_enabled'])) {
                $me = [];
                foreach (['fire', 'ppe', 'intr', 'face'] as $m) {
                    $me[$m] = array_key_exists($m, $in['mods_enabled']) ? !empty($in['mods_enabled'][$m]) : true;
                }
                $out['mods_enabled'] = $me;
            }
            if (isset($in['mail_to'])) {
                $to = is_array($in['mail_to']) ? $in['mail_to'] : explode(',', (string) $in['mail_to']);
                $to = array_values(array_filter(array_map('trim', $to),
                    static fn ($e) => (bool) filter_var($e, FILTER_VALIDATE_EMAIL)));
                $out['mail_to'] = $to;   // empty list falls back to .env MAIL_TO
            }
            if (isset($in['cooldown_min'])) {
                $out['cooldown_min'] = max(1, min(1440, (int) $in['cooldown_min']));
            }
            if (isset($in['email_enabled'])) {
                $out['email_enabled'] = !empty($in['email_enabled']);
            }

            $cur = is_file($file) ? (json_decode((string) file_get_contents($file), true) ?: []) : [];
            $merged = array_merge($cur, $out);
            if (!is_dir(dirname($file))) {
                @mkdir(dirname($file), 0775, true);
            }
            file_put_contents($file, json_encode($merged, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);

            // Optional: fire a test email with the freshly saved settings.
            $tested = null;
            if (!empty($in['send_test'])) {
                // Re-load config so the test uses the just-saved overlay.
                $fresh = require APP_ROOT . '/config/config.php';
                require_once APP_ROOT . '/lib/Mailer.php';
                require_once APP_ROOT . '/lib/EmailTemplate.php';
                $mailer  = new Mailer($fresh['mail']);
                $content = EmailTemplate::heading('Alert settings saved')
                    . EmailTemplate::sub('Your alert configuration was updated from the dashboard — this message confirms the email channel is delivering.')
                    . EmailTemplate::rows([
                        ['Minimum severity', (string) ($fresh['alerts']['min_severity'] ?? 'high')],
                        ['Always-alert modules', implode(', ', $fresh['alerts']['always_mods'] ?? []) ?: '—'],
                        ['Intrusion armed window', (string) ($fresh['alerts']['intr_armed'] ?? 'always')],
                        ['Email interval', (int) ($fresh['mail']['cooldown'] ?? 5) . ' min per camera + module'],
                        ['Recipients', implode(', ', $fresh['mail']['to'] ?? [])],
                    ])
                    . EmailTemplate::buttons([['Review Alert Rules', EmailTemplate::host() . '/', true]]);
                $tested = $mailer->ready() && $mailer->send(
                    '[Kian Joo VisionAI] Test alert — settings saved',
                    EmailTemplate::shell('Alert settings saved — email channel confirmed', 'SETTINGS SAVED',
                        EmailTemplate::COLORS['ok'], $content)
                );
            }
            Response::ok(['saved' => true, 'settings' => $merged, 'test_sent' => $tested]);
        }

        // GET → effective (env + overlay) settings for the settings UI.
        Response::ok(['settings' => [
            'email_enabled' => (bool) ($config['alerts']['email_enabled'] ?? true),
            'min_severity'  => $config['alerts']['min_severity'] ?? 'high',
            'always_mods'   => array_values($config['alerts']['always_mods'] ?? []),
            'intr_armed'    => $config['alerts']['intr_armed'] ?? 'always',
            'mods_enabled'  => $config['alerts']['mods_enabled'] ?? ['fire' => true, 'ppe' => true, 'intr' => true, 'face' => true],
            'mail_to'       => $config['mail']['to'] ?? [],
            'cooldown_min'  => (int) ($config['mail']['cooldown'] ?? 5),
            'mail_ready'    => !empty($config['mail']['host']) && !empty($config['mail']['to']),
            'armed_now'     => DashboardMapper::armedNow((string) ($config['alerts']['intr_armed'] ?? 'always')),
        ]]);
    }

    // ── App settings (dashboard Settings page) ───────────────
    // GET /settings → effective config for the UI (secrets masked).
    // POST /settings → persist overrides to storage/app_settings.json;
    // actions: regen_ingest / regen_read (token rotation).
    if ($route === '/settings') {
        $requireToken($config['auth']['read_token']);
        $file = APP_ROOT . '/storage/app_settings.json';
        $mask = static fn (string $s): string => $s === '' ? '' : (strlen($s) > 4 ? str_repeat('•', 8) . substr($s, -4) : '••••');

        if ($method === 'POST') {
            $in  = json_decode(file_get_contents('php://input') ?: '', true) ?: [];
            $cur = is_file($file) ? (json_decode((string) file_get_contents($file), true) ?: []) : [];
            $out = [];

            foreach (['sense_api_base' => 512, 'sense_account' => 128, 'image_base' => 512, 'live_stream_base' => 512, 'anthropic_model' => 128, 'gemini_model' => 128, 'openai_model' => 128,
                      'email_tmforce' => 400, 'email_soc' => 400, 'email_supervisor' => 400, 'email_admin' => 400] as $k => $len) {
                if (array_key_exists($k, $in)) {
                    $out[$k] = substr(trim((string) $in[$k]), 0, $len);
                }
            }
            // Assistant LLM: exactly one provider active at a time.
            if (isset($in['llm_provider']) && in_array($in['llm_provider'], ['weststar', 'anthropic', 'gemini', 'openai'], true)) {
                $out['llm_provider'] = $in['llm_provider'];
            }
            // Secrets: only overwrite when a non-empty value is supplied.
            foreach (['sense_password', 'anthropic_key', 'live_stream_token',
                      'agent_key', 'gemini_key', 'openai_key'] as $k) {
                if (!empty($in[$k]) && !str_contains((string) $in[$k], '•')) {
                    $out[$k] = trim((string) $in[$k]);
                }
            }
            // Cameras hidden from the Live Monitoring grid — list of stream keys.
            if (isset($in['live_hidden'])) {
                $keys = is_array($in['live_hidden']) ? $in['live_hidden'] : explode(',', (string) $in['live_hidden']);
                $keys = array_map(
                    static fn ($s) => strtolower(preg_replace('/[^a-z0-9_.-]+/i', '', substr(trim((string) $s), 0, 64))),
                    $keys
                );
                $out['live_hidden'] = array_values(array_slice(array_unique(array_filter($keys)), 0, 200));
            }
            // POC camera points: {stream key → location name}. Empty values
            // clear the mapping for that camera.
            if (isset($in['cam_locations']) && is_array($in['cam_locations'])) {
                $map = [];
                foreach (array_slice($in['cam_locations'], 0, 200, true) as $k => $v) {
                    $k = strtolower(preg_replace('/[^a-z0-9_.-]+/i', '', substr(trim((string) $k), 0, 64)));
                    $v = substr(trim((string) $v), 0, 64);
                    if ($k !== '' && $v !== '') {
                        $map[$k] = $v;
                    }
                }
                $out['cam_locations'] = $map;
            }
            if (isset($in['poc_inactivity_min'])) {
                $out['poc_inactivity_min'] = max(5, min(720, (int) $in['poc_inactivity_min']));
            }
            if (isset($in['ai_source']) && in_array($in['ai_source'], ['weststar', 'anthropic', 'off'], true)) {
                $out['ai_source'] = $in['ai_source'];
            }
            if (isset($in['report_frequency']) && in_array($in['report_frequency'], ['off', 'daily', 'weekly', 'monthly', 'yearly'], true)) {
                $out['report_frequency'] = $in['report_frequency'];
            }
            if (isset($in['report_hour'])) {
                $out['report_hour'] = max(0, min(23, (int) $in['report_hour']));
            }
            if (isset($in['report_recipients'])) {
                $to = is_array($in['report_recipients']) ? $in['report_recipients'] : explode(',', (string) $in['report_recipients']);
                $out['report_recipients'] = array_values(array_filter(array_map('trim', $to),
                    static fn ($e) => (bool) filter_var($e, FILTER_VALIDATE_EMAIL)));
            }
            // Token rotation. New read token = current page token dies → the UI
            // must reload (index.php injects the fresh one).
            $rotated = [];
            if (!empty($in['regen_ingest'])) {
                $out['ingest_token'] = bin2hex(random_bytes(24));
                $rotated['ingest_token'] = $out['ingest_token'];
            }
            if (!empty($in['regen_read'])) {
                $out['read_token'] = bin2hex(random_bytes(24));
                $rotated['read_token'] = $out['read_token'];
            }

            $merged = array_merge($cur, $out);
            if (!is_dir(dirname($file))) {
                @mkdir(dirname($file), 0775, true);
            }
            file_put_contents($file, json_encode($merged, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
            Response::ok(['saved' => true, 'rotated' => $rotated ?: null]);
        }

        // GET → effective settings + live endpoint URLs for the UI.
        $host = $config['app']['url'] ?: ('https://' . ($_SERVER['HTTP_HOST'] ?? 'localhost'));
        Response::ok(['settings' => [
            'sense_api_base'  => $config['sense_api']['base'] ?? '',
            'sense_account'   => $config['sense_api']['account'] ?? '',
            'sense_password'  => $mask((string) ($config['sense_api']['password'] ?? '')),
            'image_base'      => $config['images']['base'] ?? '',
            'live_stream_base'=> $config['live']['stream_base'] ?? '',
            'live_stream_token'=> $mask((string) ($config['live']['stream_token'] ?? '')),
            'live_hidden'     => array_values($config['live']['hidden'] ?? []),
            'ai_source'       => $config['ai']['source'] ?? 'weststar',
            'ai_base'         => $config['ai']['base'] ?? '',
            'anthropic_key'   => $mask((string) ($config['ai']['anthropic_key'] ?? '')),
            'anthropic_model' => $config['ai']['anthropic_model'] ?? 'claude-opus-4-8',
            // Assistant LLM — one active provider, keys masked on read.
            'llm_provider'    => $config['ai']['provider'] ?? 'weststar',
            'agent_key'       => $mask((string) ($config['ai']['agent_key'] ?? '')),
            'gemini_key'      => $mask((string) ($config['ai']['gemini_key'] ?? '')),
            'gemini_model'    => $config['ai']['gemini_model'] ?? '',
            'openai_key'      => $mask((string) ($config['ai']['openai_key'] ?? '')),
            'openai_model'    => $config['ai']['openai_model'] ?? 'gpt-4o-mini',
            'email_tmforce'    => implode(', ', $config['routing']['tmforce'] ?? []),
            'email_soc'        => implode(', ', $config['routing']['soc'] ?? []),
            'email_supervisor' => implode(', ', $config['routing']['supervisor'] ?? []),
            'email_admin'      => implode(', ', $config['routing']['admin'] ?? []),
            'report_frequency'  => $config['reports']['frequency'] ?? 'off',
            'report_hour'       => $config['reports']['hour'] ?? 8,
            'report_recipients' => $config['reports']['recipients'] ?? [],
            // POC camera points (Use Case 1: attendance + movement tracking)
            'cam_locations'      => (object) ($config['poc']['cam_locations'] ?? []),
            'poc_inactivity_min' => $config['poc']['inactivity_min'] ?? 45,
            'poc_locations'      => $config['poc']['locations'] ?? [],
            'endpoints' => [
                // One push URL per SenseStudio feed. No {stream} placeholder —
                // SenseStudio posts the URL verbatim, so the camera is taken
                // from the payload's deviceSerial instead.
                'push_face' => $host . '/api/ingest/face?token=' . ($config['auth']['ingest_token'] ?? ''),
                'push_body' => $host . '/api/ingest/body?token=' . ($config['auth']['ingest_token'] ?? ''),
                'push'   => $host . '/api/ingest?token=' . ($config['auth']['ingest_token'] ?? ''),
                'events' => $host . '/api/events?token=' . ($config['auth']['read_token'] ?? ''),
                'feed'   => $host . '/feed.php?token=' . ($config['auth']['read_token'] ?? ''),
                'health' => $host . '/api/health',
            ],
        ]]);
    }

    // ── Forecast (prediction dashboard data) ─────────────────
    if ($route === '/forecast') {
        $requireToken($config['auth']['read_token']);
        require_once APP_ROOT . '/lib/Insights.php';
        $pdo  = Database::connect($config['storage']);
        $days = max(2, min(90, (int) ($_GET['days'] ?? 14)));
        $agg  = Insights::aggregate($pdo, $days);
        $fc   = Insights::forecast($agg);
        $llm  = Insights::llmForecast($config, $agg, $fc);
        Response::ok(['agg' => $agg, 'forecast' => $fc, 'ai' => $llm]);
    }

    // ── Reports: manual run + cron entrypoint ────────────────
    if ($route === '/report/run') {
        $requireToken($config['auth']['read_token']);
        require_once APP_ROOT . '/lib/Insights.php';
        $pdo  = Database::connect($config['storage']);
        $sent = Reporter::send($config, $pdo);
        Response::json(['ok' => $sent, 'to' => $config['reports']['recipients'] ?? [],
                        'error' => $sent ? null : 'Send failed — check SMTP config / error_log'], $sent ? 200 : 502);
    }
    if ($route === '/report/incidents') {
        $requireToken($config['auth']['read_token']);
        require_once APP_ROOT . '/lib/Insights.php';
        $pdo    = Database::connect($config['storage']);
        $period = in_array($_GET['period'] ?? '', ['daily', 'weekly', 'monthly'], true) ? $_GET['period'] : 'weekly';
        $sent   = Reporter::incidents($config, $pdo, $period);
        Response::json(['ok' => $sent, 'period' => $period,
                        'error' => $sent ? null : 'Send failed — check SMTP / recipients'], $sent ? 200 : 502);
    }
    if ($route === '/report/cron') {
        $requireToken($config['auth']['provision_token']);
        require_once APP_ROOT . '/lib/Insights.php';
        $pdo  = Database::connect($config['storage']);
        Response::ok(['sent' => Reporter::maybeSend($config, $pdo)]);
    }

    // ── User & role management (session + `users` permission) ──
    if ($route === '/users' || strpos($route, '/users/') === 0 || $route === '/roles') {
        require_once APP_ROOT . '/lib/Auth.php';
        if (!Auth::can('users')) {
            Response::error('Forbidden: user-management permission required.', 403);
        }
        $pdo = Database::connect($config['storage']);
        Auth::ensureSeedAdmin($pdo);
        $me  = Auth::user();
        $in  = json_decode(file_get_contents('php://input') ?: '', true) ?: $_POST;

        if ($route === '/roles') {
            if ($method === 'POST') {
                // {action: save|delete, name, desc?, perms?{}}
                $name = strtolower(preg_replace('/[^a-z0-9_\-]/i', '', (string) ($in['name'] ?? '')));
                if ($name === '') {
                    Response::error('Role name required (a-z, 0-9, - _).', 422);
                }
                $roles = Auth::roles();
                if (($in['action'] ?? 'save') === 'delete') {
                    if ($name === 'admin') {
                        Response::error('The admin role cannot be deleted.', 422);
                    }
                    $c = $pdo->prepare('SELECT COUNT(*) FROM users WHERE role = :r');
                    $c->execute(['r' => $name]);
                    if ((int) $c->fetchColumn() > 0) {
                        Response::error('Role is assigned to users — reassign them first.', 422);
                    }
                    unset($roles[$name]);
                } else {
                    $perms = [];
                    foreach (array_keys(Auth::PERMS) as $p) {
                        $perms[$p] = !empty(($in['perms'] ?? [])[$p]);
                    }
                    $roles[$name] = ['desc' => mb_substr((string) ($in['desc'] ?? ''), 0, 160), 'perms' => $perms];
                }
                Auth::saveRoles($roles);
            }
            // GET (and post-write refresh): roles + per-role user counts
            $counts = [];
            foreach ($pdo->query('SELECT role, COUNT(*) c FROM users GROUP BY role') as $r) {
                $counts[$r['role']] = (int) $r['c'];
            }
            $out = [];
            foreach (Auth::roles() as $name => $def) {
                $out[] = ['name' => $name, 'desc' => $def['desc'], 'perms' => $def['perms'],
                          'users' => $counts[$name] ?? 0,
                          'builtin' => isset(Auth::DEFAULT_ROLES[$name])];
            }
            Response::ok(['roles' => $out, 'permLabels' => Auth::PERMS]);
        }

        // POST /users/{id} — update / delete / reset password / toggle active
        if (isset($seg[1]) && $seg[1] !== '' && $method === 'POST') {
            $uid = (int) $seg[1];
            $cur = $pdo->prepare('SELECT * FROM users WHERE id = :id');
            $cur->execute(['id' => $uid]);
            $u = $cur->fetch();
            if (!$u) {
                Response::error('User not found.', 404);
            }
            if (($in['action'] ?? 'update') === 'delete') {
                if ((int) $u['id'] === (int) $me['id']) {
                    Response::error('You cannot delete your own account.', 422);
                }
                $pdo->prepare('DELETE FROM users WHERE id = :id')->execute(['id' => $uid]);
                Response::ok(['deleted' => $uid]);
            }
            $sets = [];
            $p = ['id' => $uid];
            foreach (['display_name', 'email'] as $k) {
                if (array_key_exists($k, $in)) {
                    $sets[] = "$k = :$k";
                    $p[$k] = mb_substr(trim((string) $in[$k]), 0, 150);
                }
            }
            if (!empty($in['role']) && isset(Auth::roles()[$in['role']])) {
                if ((int) $u['id'] === (int) $me['id'] && $u['role'] === 'admin' && $in['role'] !== 'admin') {
                    Response::error('You cannot remove your own admin role.', 422);
                }
                $sets[] = 'role = :role';
                $p['role'] = $in['role'];
            }
            if (array_key_exists('active', $in)) {
                if ((int) $u['id'] === (int) $me['id'] && empty($in['active'])) {
                    Response::error('You cannot deactivate your own account.', 422);
                }
                $sets[] = 'active = :active';
                $p['active'] = !empty($in['active']) ? 1 : 0;
            }
            if (!empty($in['password'])) {
                if (strlen((string) $in['password']) < 8) {
                    Response::error('Password must be at least 8 characters.', 422);
                }
                $sets[] = 'password_hash = :ph';
                $p['ph'] = password_hash((string) $in['password'], PASSWORD_DEFAULT);
            }
            if ($sets) {
                $pdo->prepare('UPDATE users SET ' . implode(', ', $sets) . ' WHERE id = :id')->execute($p);
            }
        }

        // POST /users — create
        if ($route === '/users' && $method === 'POST') {
            $username = strtolower(preg_replace('/[^a-z0-9._\-]/i', '', (string) ($in['username'] ?? '')));
            $password = (string) ($in['password'] ?? '');
            if ($username === '' || strlen($password) < 8) {
                Response::error('Username and a password of 8+ characters are required.', 422);
            }
            $role = isset(Auth::roles()[$in['role'] ?? '']) ? $in['role'] : 'operator';
            try {
                $pdo->prepare('INSERT INTO users (username, display_name, email, password_hash, role, active, created_at)
                               VALUES (:u, :d, :e, :p, :r, 1, :now)')
                    ->execute(['u' => $username,
                               'd' => mb_substr(trim((string) ($in['display_name'] ?? $username)), 0, 120),
                               'e' => mb_substr(trim((string) ($in['email'] ?? '')), 0, 190),
                               'p' => password_hash($password, PASSWORD_DEFAULT), 'r' => $role,
                               'now' => date('Y-m-d H:i:s')]);
            } catch (Throwable $e) {
                Response::error('Username already exists.', 422);
            }
        }

        // GET /users (also the refresh response after any write above)
        $rows = $pdo->query('SELECT id, username, display_name, email, role, active, last_login_at, created_at
                             FROM users ORDER BY id ASC')->fetchAll();
        Response::ok(['users' => array_map(static fn ($r) => [
            'id' => (int) $r['id'], 'username' => $r['username'], 'name' => $r['display_name'] ?: $r['username'],
            'email' => $r['email'] ?: '', 'role' => $r['role'], 'active' => (int) $r['active'] === 1,
            'lastLogin' => $r['last_login_at'] ?: '—', 'created' => $r['created_at'] ?: '',
            'isMe' => (int) $r['id'] === (int) $me['id'],
        ], $rows)]);
    }

    // ── Mail test (provision token): verify SMTP alerts end-to-end ──
    if ($route === '/mailtest') {
        $requireToken($config['auth']['provision_token']);
        require_once APP_ROOT . '/lib/Mailer.php';
        $mailer = new Mailer($config['mail']);
        if (!$mailer->ready()) {
            Response::error('Mailer not configured (MAIL_HOST / MAIL_USERNAME / MAIL_TO).', 422);
        }
        require_once APP_ROOT . '/lib/EmailTemplate.php';
        $content = EmailTemplate::heading('Email channel is working')
            . EmailTemplate::sub('This is a test notification from the Kian Joo VisionAI dashboard — no action is required.')
            . EmailTemplate::p('Detection alerts are currently configured as follows:')
            . EmailTemplate::rows([
                ['Minimum severity', (string) ($config['alerts']['min_severity'] ?? 'high')],
                ['Always-alert modules', implode(', ', $config['alerts']['always_mods'] ?? []) ?: '—'],
                ['Intrusion armed window', (string) ($config['alerts']['intr_armed'] ?? 'always')],
                ['Email interval', (int) ($config['mail']['cooldown'] ?? 5) . ' min per camera + module'],
                ['Recipients', implode(', ', $config['mail']['to'] ?? [])],
            ])
            . EmailTemplate::buttons([['Open dashboard', EmailTemplate::host() . '/', true]]);
        $sent = $mailer->send('[Kian Joo VisionAI] Test alert — email channel OK',
            EmailTemplate::shell('Email channel test — configuration summary', 'EMAIL CHANNEL TEST',
                EmailTemplate::COLORS['ok'], $content));
        Response::json(['ok' => $sent, 'to' => $config['mail']['to'] ?? [],
                        'error' => $sent ? null : 'SMTP send failed — check error_log'], $sent ? 200 : 502);
    }

    // ── Cameras (SenseStudio device registry) ────────────────
    if (($seg[0] ?? '') === 'cameras') {
        require_once APP_ROOT . '/lib/SenseApi.php';
        $sense = new SenseApi($config['sense_api'], dirname($config['storage']['raw_log']));
        $did = (string) ($seg[1] ?? '');

        // POST /cameras/{did} — update a device's config via SenseStudio (§3.3.3)
        if ($did !== '' && $method === 'POST') {
            $requireToken($config['auth']['read_token']);
            $in = json_decode(file_get_contents('php://input') ?: '', true) ?: $_POST;
            $res = $sense->updateDevice($did, [
                'name'   => $in['name']   ?? null,
                'rtsp'   => $in['rtsp']   ?? null,
                'tag'    => $in['tag']    ?? null,
                'desc'   => $in['desc']   ?? null,
                'fps'    => $in['fps']    ?? null,
                'sts'    => $in['sts']    ?? null,
                'serial' => $in['serial'] ?? null,
            ]);
            Response::json($res, $res['ok'] ? 200 : 502);
        }

        // POST /cameras — onboard a camera to SenseStudio (§3.3.1)
        if ($method === 'POST') {
            $requireToken($config['auth']['read_token']);
            $in = json_decode(file_get_contents('php://input') ?: '', true) ?: $_POST;
            if (empty($in['rtsp']) || empty($in['name'])) {
                Response::error('name and rtsp are required.', 422);
            }
            $res = $sense->createDevice([
                'name'   => $in['name'],
                'serial' => $in['serial'] ?? null,
                'rtsp'   => $in['rtsp'],
                'fps'    => $in['fps'] ?? '25',
                'tag'    => $in['tag'] ?? 'tm-next-series',
                'desc'   => $in['desc'] ?? null,
            ]);
            Response::json($res, $res['ok'] ? 200 : 502);
        }

        // GET /cameras — list SenseStudio devices
        $requireToken($config['auth']['read_token']);
        $res = $sense->listDevices(1, 100);
        Response::json($res, $res['ok'] ? 200 : 502);
    }

    Response::error('Not found: ' . $route, 404);
} catch (Throwable $e) {
    error_log('[ingest-api] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    $msg = $config['app']['debug'] ? $e->getMessage() : 'Internal error.';
    Response::error($msg, 500);
}
