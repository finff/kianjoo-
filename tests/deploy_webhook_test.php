<?php
/**
 * Self-contained test for deploy.php — no GitHub, no real git operations,
 * no real DEPLOY_TOKEN. Builds an isolated copy of deploy.php in a temp
 * dir with a throwaway secret and a stub git-deploy.sh, serves it with
 * `php -S`, and asserts the documented behavior.
 *
 * Run:  php tests/deploy_webhook_test.php
 */

declare(strict_types=1);

$root   = dirname(__DIR__);
$tmp    = sys_get_temp_dir() . '/deploy_webhook_test_' . bin2hex(random_bytes(4));
$secret = 'test-secret-' . bin2hex(random_bytes(8));   // throwaway — never the real token
$pass   = 0;
$fail   = 0;

function check(string $label, bool $ok, string $detail = ''): void
{
    global $pass, $fail;
    if ($ok) {
        $pass++;
        echo "  ✓ {$label}\n";
    } else {
        $fail++;
        echo "  ✗ {$label}" . ($detail !== '' ? " — {$detail}" : '') . "\n";
    }
}

function http(string $url, array $headers, string $body = ''): array
{
    $ctx = stream_context_create(['http' => [
        'method'        => 'POST',
        'header'        => implode("\r\n", $headers),
        'content'       => $body,
        'ignore_errors' => true,
        'timeout'       => 10,
    ]]);
    $out  = @file_get_contents($url, false, $ctx);
    $code = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $h, $m)) {
            $code = (int) $m[1];
        }
    }
    return [$code, (string) $out];
}

// ── Build the isolated test fixture ──────────────────────────────────
mkdir($tmp, 0775, true);
mkdir($tmp . '/storage', 0775, true);
file_put_contents($tmp . '/.env', "DEPLOY_TOKEN={$secret}\n");
// Stub — proves deploy.php invoked *something*, without touching real git.
file_put_contents(
    $tmp . '/git-deploy.sh',
    "#!/usr/bin/env bash\necho fake deploy ran\n"
);
chmod($tmp . '/git-deploy.sh', 0755);
copy($root . '/deploy.php', $tmp . '/deploy.php');

// ── Spin up `php -S` in the background (portable via proc_open) ─────
$port = 8000 + random_int(100, 999);
$proc = proc_open(
    [PHP_BINARY, '-S', "127.0.0.1:{$port}", '-t', $tmp],
    [1 => ['file', $tmp . '/server.out.log', 'a'], 2 => ['file', $tmp . '/server.err.log', 'a']],
    $pipes
);
if (!is_resource($proc)) {
    fwrite(STDERR, "could not start php -S\n");
    exit(1);
}
usleep(400000);   // let it bind

$base = "http://127.0.0.1:{$port}/deploy.php";

try {
    // 1) Correctly signed push to refs/heads/main → 202 + a log line
    $body = json_encode(['ref' => 'refs/heads/main', 'after' => str_repeat('a', 40)]);
    $sig  = 'sha256=' . hash_hmac('sha256', $body, $secret);
    [$code, $out] = http($base, [
        'Content-Type: application/json',
        'X-GitHub-Event: push',
        'X-Hub-Signature-256: ' . $sig,
    ], $body);
    check('signed push to main → 202', $code === 202, "got {$code}: {$out}");
    check('202 body reports the short sha', str_contains($out, substr(str_repeat('a', 40), 0, 12)), $out);
    usleep(300000);   // deploy runs after the response — give it a beat
    $log = @file_get_contents($tmp . '/storage/deploy.log') ?: '';
    check('log line: fake deploy ran', str_contains($log, 'fake deploy ran'), $log);
    check('log line: ✓ deploy … done … UTC', (bool) preg_match('/✓ deploy [0-9a-f]+ done .+UTC/', $log), $log);

    // 2) Wrong signature → 403
    [$code2] = http($base, [
        'Content-Type: application/json',
        'X-GitHub-Event: push',
        'X-Hub-Signature-256: sha256=' . str_repeat('0', 64),
    ], $body);
    check('wrong signature → 403', $code2 === 403, "got {$code2}");

    // 3) Missing auth headers entirely → 403 (never falls back to ?token=)
    [$code3] = http($base . '?token=' . $secret, ['Content-Type: application/json'], $body);
    check('no auth headers (even with ?token=) → 403', $code3 === 403, "got {$code3}");

    // 4) Tag push (not refs/heads/main) → 200 ignored
    $tagBody = json_encode(['ref' => 'refs/tags/v1.0.0', 'after' => str_repeat('b', 40)]);
    $tagSig  = 'sha256=' . hash_hmac('sha256', $tagBody, $secret);
    [$code4, $out4] = http($base, [
        'Content-Type: application/json',
        'X-GitHub-Event: push',
        'X-Hub-Signature-256: ' . $tagSig,
    ], $tagBody);
    check('tag push → 200 ignored', $code4 === 200 && str_contains($out4, 'ignored'), "got {$code4}: {$out4}");

    // 5) Non-main branch push → 200 ignored
    $brBody = json_encode(['ref' => 'refs/heads/feature-x', 'after' => str_repeat('c', 40)]);
    $brSig  = 'sha256=' . hash_hmac('sha256', $brBody, $secret);
    [$code5, $out5] = http($base, [
        'Content-Type: application/json',
        'X-GitHub-Event: push',
        'X-Hub-Signature-256: ' . $brSig,
    ], $brBody);
    check('branch push (not main) → 200 ignored', $code5 === 200 && str_contains($out5, 'ignored'), "got {$code5}: {$out5}");

    // 6) GitHub ping event → 200 pong, no deploy
    $pingBody = json_encode(['zen' => 'hello']);
    $pingSig  = 'sha256=' . hash_hmac('sha256', $pingBody, $secret);
    [$code6, $out6] = http($base, [
        'Content-Type: application/json',
        'X-GitHub-Event: ping',
        'X-Hub-Signature-256: ' . $pingSig,
    ], $pingBody);
    check('ping event → 200 pong', $code6 === 200 && trim($out6) === 'pong', "got {$code6}: {$out6}");

    // 7) Human curl path — X-Deploy-Token, synchronous streamed output
    [$code7, $out7] = http($base, ['X-Deploy-Token: ' . $secret]);
    check('human token path runs synchronously and streams output', $code7 === 200 && str_contains($out7, 'fake deploy ran'), "got {$code7}: {$out7}");

    // 8) Human path with wrong token → 403
    [$code8] = http($base, ['X-Deploy-Token: wrong']);
    check('human path wrong token → 403', $code8 === 403, "got {$code8}");

    // 9) DEPLOY_TOKEN unset → fails closed with 503 (not a 403)
    rename($tmp . '/.env', $tmp . '/.env.bak');
    [$code9] = http($base, ['X-Deploy-Token: ' . $secret]);
    check('unset secret → 503', $code9 === 503, "got {$code9}");
    rename($tmp . '/.env.bak', $tmp . '/.env');

    // 10) Two overlapping deploys → the second gets 409, not a double-run.
    // PHP's built-in dev server handles one request at a time per process
    // (no pcntl-based worker pool on Windows), so true concurrency needs
    // two separate server *processes* sharing the same lock file — which
    // also happens to be a more realistic test, since flock() contention
    // is a real cross-process OS mechanism either way.
    file_put_contents($tmp . '/git-deploy.sh', "#!/usr/bin/env bash\nsleep 1\necho fake slow deploy ran\n");
    $port2 = $port + 1;
    $proc2 = proc_open(
        [PHP_BINARY, '-S', "127.0.0.1:{$port2}", '-t', $tmp],
        [1 => ['file', $tmp . '/server2.out.log', 'a'], 2 => ['file', $tmp . '/server2.err.log', 'a']],
        $pipes2
    );
    usleep(400000);
    $base2 = "http://127.0.0.1:{$port2}/deploy.php";

    $b9   = json_encode(['ref' => 'refs/heads/main', 'after' => str_repeat('d', 40)]);
    $sig9 = 'sha256=' . hash_hmac('sha256', $b9, $secret);
    $mh   = curl_multi_init();
    $handles = [];
    foreach ([$base, $base2] as $url) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $b9,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'X-GitHub-Event: push', 'X-Hub-Signature-256: ' . $sig9],
            CURLOPT_RETURNTRANSFER => true,
        ]);
        curl_multi_add_handle($mh, $ch);
        $handles[] = $ch;
    }
    $running = null;
    do {
        curl_multi_exec($mh, $running);
        curl_multi_select($mh);
    } while ($running > 0);
    $codes = array_map(fn ($ch) => curl_getinfo($ch, CURLINFO_HTTP_CODE), $handles);
    foreach ($handles as $ch) {
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
    }
    curl_multi_close($mh);
    proc_terminate($proc2);
    proc_close($proc2);
    sort($codes);
    check('overlapping deploys (2 processes) → one 202 + one 409', $codes === [202, 409], 'got ' . implode(',', $codes));
} finally {
    proc_terminate($proc);
    proc_close($proc);
    // best-effort cleanup
    foreach (glob($tmp . '/storage/*') ?: [] as $f) {
        @unlink($f);
    }
    @rmdir($tmp . '/storage');
    foreach (glob($tmp . '/*') ?: [] as $f) {
        @unlink($f);
    }
    @rmdir($tmp);
}

echo "\n{$pass} passed, {$fail} failed\n";
exit($fail > 0 ? 1 : 0);
