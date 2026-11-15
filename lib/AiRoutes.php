<?php
/**
 * AI layer + ITSM ticket + report routes, included from api/index.php inside
 * its try {} (shares $route, $seg, $method, $config, $provisionAdmin, $token).
 * Lives in lib/ so it is never directly web-reachable.
 *
 * Every route resolves the caller server-side (AiGuard) — the read token that
 * the dashboard JS holds grants NOTHING here.
 *
 *   POST /assistant                         chat, data via RBAC-scoped tools        [signed in]
 *                                           → {answer, refs[], tools_called[], model, provider}
 *   GET  /ai/models                         Claude routing table + readiness         [admin]
 *   GET  /ai/*                              agent read API (AiContext)               [admin + view, or provision token]
 *   GET|POST /pipeline/run[?dry_run=1]      PPE-forklift worker run                  [provision token, or admin + settings]
 *   GET  /tickets                           list (staff: own only)                   [signed in]
 *        ?status=a,b&open&priority&category&q&mine&breached&from&to&person_id&event_id|event&limit(≤500, def 200)&offset
 *        rows carry message_count, attachment_count, proof_url
 *   POST /tickets                           create                                   [signed in]
 *   GET  /tickets/sla                       SLA policy                               [signed in]
 *   POST /tickets/sla                       update SLA policy                        [admin + settings]
 *   GET  /tickets/assignees                 active users to assign                   [supervisor+ + tickets]
 *   GET  /tickets/table                     tickets + INC incidents, one paged table [signed in; incidents: worker]
 *        ?page&per_page(10–100)&sort=created|updated|priority|status|no|camera|sla&dir&q
 *        &type=all|ticket|incident&status(csv; open = not resolved/closed)&priority(csv)&camera
 *        &quick=breached|due_1h|unassigned (open rows matching the stats tile; count = stats.<quick>)
 *        → {rows[], total, page, per_page, stats{open,tickets_open,incidents_open,breached,due_1h,unassigned,closed_7d}}
 *        (lib/TicketTable.php)
 *   GET  /tickets/{id}                      detail + thread + attachments            [requester or worker]
 *   POST /tickets/{id}/status               {status, remarks, resolution_code}       [worker; requester may close own resolved]
 *   POST /tickets/{id}/update               {priority?, assignee_user_id?, title?}   [worker]
 *   POST /tickets/{id}/messages             {body, internal?}                        [requester or worker]
 *   POST /tickets/{id}/attachments          multipart "file" (+message_id)           [requester or worker]
 *   GET  /tickets/{id}/attachments/{aid}    stream file (proofs + internal-note files: workers only) [requester or worker]
 *   POST /report/generate                   {range, scope}                           [signed in; comprehensive = supervisor+ + reports]
 *   GET  /reports[?all=1]                   own reports (admin: all with all=1)      [signed in]
 *   GET  /reports/{id}                      one report                               [owner or admin]
 *   GET  /reports/{id}/download?format=md|json                                       [owner or admin]
 *   GET  /reports/{id}/pdf                  dompdf render, cached (503 if the engine fails) [owner or admin]
 */

declare(strict_types=1);

if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

$aiFirst = $seg[0] ?? '';
if (!in_array($aiFirst, ['assistant', 'ai', 'pipeline', 'tickets', 'reports'], true) && $route !== '/report/generate') {
    return;   // not ours — fall through to the rest of api/index.php
}

require_once APP_ROOT . '/lib/AiGuard.php';
require_once APP_ROOT . '/lib/Claude.php';

$aiPdo  = Database::connect($config['storage']);
$aiBody = static function (): array {
    $raw = file_get_contents('php://input') ?: '';
    $j   = json_decode($raw, true);
    return is_array($j) ? $j : $_POST;
};
$aiDir = (string) ($config['ai']['storage_dir'] ?? APP_ROOT . '/storage');

// ── /ai/* : admin-only read API (+ routing table) ───────────
if ($aiFirst === 'ai') {
    $p = AiGuard::require($aiPdo, $provisionAdmin());
    AiGuard::demand($p, 'admin', 'view');
    if (($seg[1] ?? '') === 'models') {
        Response::ok(['ready' => Claude::fromConfig($config)->ready(), 'api_version' => Claude::API_VERSION,
                      'routes' => Claude::routingTable()]);
    }
    return;   // authorised: api/index.php's /ai block serves the rest
}

// ── PPE-forklift pipeline worker (cron / web) ───────────────
if ($route === '/pipeline/run') {
    $prov = $provisionAdmin();
    if ($prov === null) {
        $p = AiGuard::require($aiPdo);
        AiGuard::demand($p, 'admin', 'settings');
    }
    require_once APP_ROOT . '/lib/PpeForkliftPipeline.php';
    @set_time_limit(120);
    $o = ['dry_run' => !empty($_GET['dry_run'])];
    if (isset($_GET['max'])) {
        $o['max_reviews'] = max(1, min(30, (int) $_GET['max']));
    }
    $stats = (new PpeForkliftPipeline($aiPdo, $config))->run($o);
    Response::ok(['ran_at' => date('c'), 'stats' => $stats]);
}

// ── Assistant chat ──────────────────────────────────────────
if ($route === '/assistant') {
    if ($method !== 'POST') {
        Response::error('POST {messages:[{role,content}]}.', 405);
    }
    $p = AiGuard::require($aiPdo, $provisionAdmin());
    require_once APP_ROOT . '/lib/Llm.php';
    require_once APP_ROOT . '/lib/AiTools.php';
    $llm = Llm::fromConfig($config);   // provider picked by ai.source (Llm::adapterFor)
    if (($config['ai']['source'] ?? 'claude') === 'off' || !$llm->ready()) {
        Response::json(['ok' => false, 'error' => 'The AI assistant is not configured (CLAUDE_API_KEY) or switched off.'], 503);
    }
    $in   = $aiBody();
    $msgs = [];
    foreach (array_slice(is_array($in['messages'] ?? null) ? $in['messages'] : [], -8) as $m) {
        $text = trim((string) ($m['content'] ?? ''));
        if ($text !== '') {
            $msgs[] = ['role' => ($m['role'] ?? '') === 'assistant' ? 'assistant' : 'user', 'content' => mb_substr($text, 0, 2000)];
        }
    }
    // The conversation must start with a user turn.
    while ($msgs && $msgs[0]['role'] !== 'user') {
        array_shift($msgs);
    }
    if (!$msgs) {
        Response::error('At least one message is required.', 422);
    }
    $tools = new AiTools($aiPdo, $config, $p);
    $ctx   = 'SIGNED-IN USER: ' . $p['name'] . ' (role ' . $p['role'] . ', access tier ' . $p['tier'] . ').'
           . ' Current time: ' . date('Y-m-d H:i') . ' (Malaysia time).'
           . ' Data tools available to this user: ' . (implode(', ', $tools->allowed()) ?: 'none') . '.';
    // generate_report runs a full report generation inside the loop (comprehensive ≈ minutes).
    @set_time_limit($tools->isAllowed('generate_report') ? 480 : 180);
    @ignore_user_abort(true);
    $res = $llm->chat($msgs, $ctx, $tools);
    if (!empty($res['ok'])) {
        Response::ok(['answer' => $res['answer'], 'refs' => $res['refs'] ?? [], 'citations' => [], 'model' => $res['model'] ?? '',
                      'provider' => $llm->provider(), 'used_tools' => !empty($res['used_tools']), 'tools_called' => $res['tools_called'] ?? []]);
    }
    Response::json(['ok' => false, 'error' => $res['error'] ?? 'The assistant could not answer.',
                    'provider' => $llm->provider(), 'upstream' => $res['upstream'] ?? 0], 502);
}

// ── Tickets (M7) ────────────────────────────────────────────
if ($aiFirst === 'tickets') {
    require_once APP_ROOT . '/lib/Tickets.php';
    $p  = AiGuard::require($aiPdo, $provisionAdmin());
    $tk = new Tickets($aiPdo, $aiDir);
    $sub = $seg[1] ?? '';

    try {
        if ($sub === '') {
            if ($method === 'POST') {
                $t = $tk->create($aiBody(), $p);
                Response::json(['ok' => true, 'ticket' => $tk->detail($t, $p)], 201);
            }
            $f = [];
            foreach (['status', 'priority', 'category', 'q', 'mine', 'open', 'breached', 'limit', 'offset', 'from', 'to', 'person_id', 'event_id', 'event'] as $k) {
                if (isset($_GET[$k]) && $_GET[$k] !== '') {
                    $f[$k] = substr((string) $_GET[$k], 0, 80);
                }
            }
            Response::ok($tk->list($f, $p) + ['is_worker' => Tickets::isWorker($p)]);
        }
        if ($sub === 'sla') {
            if ($method === 'POST') {
                AiGuard::demand($p, 'admin', 'settings');
                Response::ok(['policy' => $tk->saveSlaPolicy($aiBody())]);
            }
            Response::ok(['policy' => $tk->slaPolicy(), 'priorities' => Tickets::PRIORITIES,
                          'statuses' => Tickets::STATUSES, 'transitions' => Tickets::TRANSITIONS, 'categories' => Tickets::CATEGORIES,
                          // read-only echo; set via POST /notify/settings {escalation:{tickets_email}}
                          'tickets_email' => ($config['escalation']['tickets_email'] ?? true) !== false]);
        }
        if ($sub === 'assignees') {
            if (!Tickets::isWorker($p)) {
                Response::error('Forbidden.', 403);
            }
            $rows = $aiPdo->query("SELECT id, username, display_name, role FROM users WHERE active = 1 ORDER BY display_name")->fetchAll();
            Response::ok(['users' => array_map(static fn ($u) => ['id' => (int) $u['id'], 'name' => $u['display_name'] ?: $u['username'], 'role' => $u['role']], $rows)]);
        }
        if ($sub === 'table') {
            // Unified ITSM tickets + INC incidents, server-paginated; RBAC as GET /tickets.
            if ($method !== 'GET') {
                Response::error('GET only.', 405);
            }
            require_once APP_ROOT . '/lib/TicketTable.php';
            Response::ok((new TicketTable($aiPdo, $config, $aiDir, $tk))->table($_GET, $p) + ['is_worker' => Tickets::isWorker($p)]);
        }

        $t = $tk->find($sub);
        if (!$t || !Tickets::canView($t, $p)) {
            Response::error('Ticket not found.', 404);   // same answer for "exists but not yours"
        }
        $act = $seg[2] ?? '';
        if ($act === '' && $method === 'GET') {
            Response::ok(['ticket' => $tk->detail($t, $p)]);
        }
        if ($act === 'status' && $method === 'POST') {
            $in = $aiBody();
            $t2 = $tk->transition($t, (string) ($in['status'] ?? ''), $p, (string) ($in['remarks'] ?? ''), (string) ($in['resolution_code'] ?? ''));
            Response::ok(['ticket' => $tk->detail($t2, $p)]);
        }
        if ($act === 'update' && $method === 'POST') {
            $t2 = $tk->edit($t, $aiBody(), $p);
            Response::ok(['ticket' => $tk->detail($t2, $p)]);
        }
        if ($act === 'messages' && $method === 'POST') {
            $in = $aiBody();
            $m  = $tk->postMessage($t, $p, (string) ($in['body'] ?? ''), !empty($in['internal']));
            Response::json(['ok' => true, 'message' => $m, 'ticket' => $tk->detail($tk->find((int) $t['id']), $p)], 201);
        }
        if ($act === 'attachments' && $method === 'POST') {
            $mid = isset($_POST['message_id']) ? (int) $_POST['message_id'] : null;
            $a   = $tk->attachUpload($t, $p, $_FILES['file'] ?? [], $mid ?: null);
            Response::json(['ok' => true, 'attachment' => $a], 201);
        }
        if ($act === 'attachments' && $method === 'GET' && isset($seg[3])) {
            $a = $tk->attachment((int) $t['id'], (int) $seg[3]);
            if (!$a || !$tk->attachmentVisible($a, $p)) {   // proofs + internal-note files: workers only
                Response::error('Attachment not found.', 404);
            }
            $path = $tk->attachmentPath($a);
            if ($path === null) {
                Response::error('Attachment file is missing.', 410);
            }
            $mime   = (string) $a['mime'];
            $inline = str_starts_with($mime, 'image/') || $mime === 'application/pdf';
            header('Content-Type: ' . $mime);
            header('Content-Length: ' . filesize($path));
            header('X-Content-Type-Options: nosniff');
            header("Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'");
            header('Cache-Control: private, max-age=3600');
            header('Content-Disposition: ' . ($inline ? 'inline' : 'attachment') . '; filename="' . str_replace('"', '', (string) $a['filename']) . '"');
            readfile($path);
            exit;
        }
        Response::error('Unknown ticket action.', 404);
    } catch (InvalidArgumentException $e) {
        Response::error($e->getMessage(), 422);
    } catch (DomainException $e) {
        Response::error($e->getMessage(), 409);
    }
}

// ── Reports (M12) ───────────────────────────────────────────
if ($route === '/report/generate') {
    if ($method !== 'POST') {
        Response::error('POST {range, scope}.', 405);
    }
    $p = AiGuard::require($aiPdo, $provisionAdmin());
    if (($config['ai']['source'] ?? 'claude') === 'off') {
        Response::error('AI features are switched off.', 503);
    }
    require_once APP_ROOT . '/lib/AiReports.php';
    $in = $aiBody();
    @set_time_limit(330);
    @ignore_user_abort(true);   // keep going (and persist) even if the browser gives up waiting
    $res = (new AiReports($aiPdo, $config))->generate($p, $in['range'] ?? '7d', (string) ($in['scope'] ?? 'standard'));
    if ($res['ok']) {
        Response::json(['ok' => true, 'report' => $res['report']], 201);
    }
    Response::json(['ok' => false, 'error' => $res['error'], 'report_no' => $res['report_no'] ?? null], (int) ($res['status'] ?? 502));
}

if ($aiFirst === 'reports') {
    require_once APP_ROOT . '/lib/AiReports.php';
    $p   = AiGuard::require($aiPdo, $provisionAdmin());
    $rep = new AiReports($aiPdo, $config);
    $id  = $seg[1] ?? '';
    if ($id === '') {
        Response::ok(['reports' => $rep->list($p, $_GET)]);
    }
    $r = $rep->find($id);
    if (!$r || !AiReports::canView($r, $p)) {
        Response::error('Report not found.', 404);
    }
    if (($seg[2] ?? '') === 'pdf') {
        if ($r['status'] !== 'done') {
            Response::error('This report is not finished yet.', 409);
        }
        try {
            $pdf = $rep->pdf((int) $r['id']);
        } catch (Throwable $e) {
            error_log('[reports/pdf] ' . $r['report_no'] . ': ' . $e->getMessage());
            Response::json(['ok' => false, 'error' => 'PDF export is unavailable right now (' . mb_substr($e->getMessage(), 0, 160) . '). Use Print / PDF from the report view instead.',
                            'fallback' => 'print'], 503);
        }
        header('Content-Type: application/pdf');
        header('Content-Length: ' . $pdf['bytes']);
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: private, max-age=300');
        header('X-Report-Cache: ' . ($pdf['cached'] ? 'hit' : 'miss'));
        header('Content-Disposition: attachment; filename="' . $pdf['filename'] . '"');
        readfile($pdf['path']);
        exit;
    }
    if (($seg[2] ?? '') === 'print') {
        // Browser twin of the PDF: the same printHtml() template (cover, control page,
        // charts, appendices, sign-off) with CSS @page margin boxes for header/footer.
        $content = $r['status'] === 'done' ? json_decode((string) $r['content_json'], true) : null;
        if (!is_array($content)) {
            Response::error('This report is not finished yet.', 409);
        }
        header('Content-Type: text/html; charset=utf-8');
        header('X-Content-Type-Options: nosniff');
        header("Content-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:");
        header('Cache-Control: private, no-store');
        echo AiReports::printHtml($content, $r, 'print');
        exit;
    }
    if (($seg[2] ?? '') === 'download') {
        $fmt  = ($_GET['format'] ?? 'md') === 'json' ? 'json' : 'md';
        $path = $rep->filePath($r, $fmt);
        if ($path === null) {
            Response::error('Report file not available.', 404);
        }
        header('Content-Type: ' . ($fmt === 'json' ? 'application/json' : 'text/markdown') . '; charset=utf-8');
        header('X-Content-Type-Options: nosniff');
        header('Content-Disposition: attachment; filename="' . $r['report_no'] . '.' . $fmt . '"');
        readfile($path);
        exit;
    }
    Response::ok(['report' => $rep->get((int) $r['id'], $p)]);
}
