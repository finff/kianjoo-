<?php
/**
 * Auto-deploy endpoint — GitHub webhook (push) + manual curl trigger.
 *
 * Framework-free, single file, zero includes from lib/ or config/ on
 * purpose: this must keep working even if something else in the app is
 * broken, since "pull the fix and deploy it" is exactly the job here.
 * Reads DEPLOY_TOKEN straight out of the project .env by hand.
 *
 * Two ways in, same secret:
 *   - GitHub webhook: header X-Hub-Signature-256: sha256=<hmac of raw body>
 *   - Human curl:     header X-Deploy-Token: <the secret, verbatim>
 * No ?token= in the query string on purpose — it lands in access logs,
 * referrers and browser history.
 *
 * Fails closed: 503 if DEPLOY_TOKEN is unset, 403 on any signature/token
 * mismatch or missing header. Never reads ?token=.
 */

declare(strict_types=1);

const DEPLOY_BRANCH_REF = 'refs/heads/main';   // this repo's default branch
const DEPLOY_SCRIPT     = __DIR__ . '/git-deploy.sh';
const DEPLOY_LOCK       = __DIR__ . '/storage/deploy.lock';
const DEPLOY_LOG        = __DIR__ . '/storage/deploy.log';

header('Content-Type: text/plain; charset=utf-8');

// ── Read DEPLOY_TOKEN from .env by hand — no app bootstrap ──────────
function deploy_read_env_token(string $path): string
{
    if (!is_file($path) || !is_readable($path)) {
        return '';
    }
    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        $line = trim($line);
        if ($line === '' || $line[0] === '#' || strpos($line, '=') === false) {
            continue;
        }
        [$k, $v] = explode('=', $line, 2);
        if (trim($k) !== 'DEPLOY_TOKEN') {
            continue;
        }
        $v = trim($v);
        if (strlen($v) >= 2 && ($v[0] === '"' || $v[0] === "'") && $v[strlen($v) - 1] === $v[0]) {
            $v = substr($v, 1, -1);
        }
        return $v;
    }
    return '';
}

$secret = deploy_read_env_token(__DIR__ . '/.env');
if ($secret === '') {
    http_response_code(503);
    echo "deploy disabled — DEPLOY_TOKEN is not set in .env\n";
    exit;
}

// ── Authenticate: GitHub HMAC, or a human's bearer-style token ──────
$rawBody   = file_get_contents('php://input') ?: '';
$sigHeader = $_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? '';
$tokHeader = $_SERVER['HTTP_X_DEPLOY_TOKEN'] ?? '';

$isWebhook = false;
if ($sigHeader !== '') {
    $isWebhook = true;
    $expected  = 'sha256=' . hash_hmac('sha256', $rawBody, $secret);
    if (!hash_equals($expected, $sigHeader)) {
        http_response_code(403);
        echo "signature mismatch\n";
        exit;
    }
} elseif ($tokHeader !== '') {
    if (!hash_equals($secret, $tokHeader)) {
        http_response_code(403);
        echo "token mismatch\n";
        exit;
    }
} else {
    http_response_code(403);
    echo "missing X-Hub-Signature-256 or X-Deploy-Token\n";
    exit;
}

// ── Refuse politely if the host has shell_exec disabled ─────────────
$disabled = array_map('trim', explode(',', (string) ini_get('disable_functions')));
if (!function_exists('shell_exec') || in_array('shell_exec', $disabled, true)) {
    http_response_code(500);
    echo "shell_exec is disabled on this host — cannot run the deploy script\n";
    exit;
}

// ── GitHub event handling: ping / non-push / non-main branch ────────
// Only the webhook path carries these headers/payload shape; a human curl
// has no ref to filter on and always means "deploy now".
$sha = 'unknown';
if ($isWebhook) {
    $event = $_SERVER['HTTP_X_GITHUB_EVENT'] ?? '';
    if ($event === 'ping') {
        http_response_code(200);
        echo "pong\n";
        exit;
    }
    $payload = json_decode($rawBody, true);
    $ref     = is_array($payload) ? (string) ($payload['ref'] ?? '') : '';
    if ($event !== 'push' || $ref === '') {
        http_response_code(200);
        echo 'ignored event ' . ($event ?: 'unknown') . "\n";
        exit;
    }
    if ($ref !== DEPLOY_BRANCH_REF) {
        http_response_code(200);
        echo 'ignored ' . $ref . "\n";
        exit;
    }
    $sha = substr((string) ($payload['after'] ?? 'unknown'), 0, 12);
}

// ── Concurrency: one deploy at a time ────────────────────────────────
// A plain PHP flock() on an open handle held for the rest of the request
// — simpler and more portable here than shelling out to `flock`/`mkdir`,
// and it stays held across fastcgi_finish_request() below since the
// worker process keeps running until the script actually exits.
if (!is_dir(dirname(DEPLOY_LOCK))) {
    @mkdir(dirname(DEPLOY_LOCK), 0775, true);
}
$lockFp = @fopen(DEPLOY_LOCK, 'c');
if (!$lockFp || !flock($lockFp, LOCK_EX | LOCK_NB)) {
    http_response_code(409);
    echo "deploy already running\n";
    exit;
}

function deploy_run_and_log(string $sha): string
{
    set_time_limit(900);
    $cmd    = 'cd ' . escapeshellarg(__DIR__) . ' && bash ' . escapeshellarg(DEPLOY_SCRIPT) . ' 2>&1';
    $output = (string) shell_exec($cmd);
    $stamp  = gmdate('Y-m-d\TH:i:s\Z');   // always UTC — host/DB/team clocks all differ
    $entry  = "\n=== deploy {$sha} started {$stamp} ===\n" . $output
        . "\n\xE2\x9C\x93 deploy {$sha} done " . gmdate('Y-m-d\TH:i:s\Z') . " UTC\n";
    @file_put_contents(DEPLOY_LOG, $entry, FILE_APPEND | LOCK_EX);
    return $output;
}

if ($isWebhook) {
    // GitHub times out a delivery after 10s; our deploy takes 20-90s.
    // Respond first, deploy after — LiteSpeed's finish-request call, the
    // generic FPM one, or a manual flush as the last-resort fallback.
    http_response_code(202);
    echo "accepted {$sha}\n";
    if (function_exists('litespeed_finish_request')) {
        litespeed_finish_request();
    } elseif (function_exists('fastcgi_finish_request')) {
        fastcgi_finish_request();
    } else {
        ignore_user_abort(true);
        if (ob_get_level() > 0) {
            ob_end_flush();
        }
        flush();
    }
    deploy_run_and_log($sha);
} else {
    // Human curl keeps the original streaming text response.
    echo deploy_run_and_log($sha);
}

flock($lockFp, LOCK_UN);
fclose($lockFp);
