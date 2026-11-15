<?php
/**
 * The single Claude API client for the whole app (M8).
 *
 * Every AI feature — assistant chat, forecast narration, the PPE-forklift
 * vision review, generated reports — goes through this class. It replaces the
 * old 'weststar' middleware path. Raw curl (no Composer on this host) to
 * POST https://api.anthropic.com/v1/messages; the key comes from .env
 * CLAUDE_API_KEY and is never sent to the browser.
 *
 * Model routing (see ROUTES): the caller names a *use case*, not a model.
 *   haiku  (claude-haiku-5-5)  — cheap classification / short extraction
 *   sonnet (claude-sonnet-5-5) — DEFAULT: chat, vision review, reports
 *   opus   (claude-opus-5-5)   — only the deep "comprehensive" report synthesis
 *
 * Reliability: retries with exponential backoff (honours retry-after) on
 * 408/409/429/5xx/529 and transport errors; a shared rolling-minute cap and a
 * short breaker via lib/Upstream.php; one structured JSON line per call in
 * storage/ai_calls.log (never the key, never prompt/response content).
 */

declare(strict_types=1);

require_once __DIR__ . '/Upstream.php';

final class Claude
{
    public const ENDPOINT = 'https://api.anthropic.com/v1/messages';
    public const API_VERSION = '2023-06-01';

    public const MODELS = [
        'haiku'  => 'claude-haiku-5-5',
        'sonnet' => 'claude-sonnet-5-5',
        'opus'   => 'claude-opus-5-5',
    ];

    /**
     * Use case → [model tier, max_tokens, effort, timeout seconds].
     * Thinking is adaptive by default on all three models (it cannot be turned
     * off on Sonnet/Opus 5.5), so `effort` is the depth/cost lever.
     */
    public const ROUTES = [
        'classify'             => ['haiku',  512,   'low',    30],
        'extract'              => ['haiku',  1500,  'low',    45],
        'monitor_gate'         => ['haiku',  400,   'low',    30],
        'monitor_fitness'      => ['haiku',  600,   'low',    45],
        'chat'                 => ['sonnet', 4096,  'low',    120],
        'insight'              => ['sonnet', 2048,  'low',    90],
        'vision_review'        => ['sonnet', 2048,  'low',    90],
        'report'               => ['sonnet', 16000, 'medium', 240],
        'report_comprehensive' => ['opus',   16000, 'high',   300],
    ];

    /** Models that accept the server-side refusal fallback parameter. */
    private const FALLBACK_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5'];
    private const FALLBACK_BETA   = 'server-side-fallback-2026-07-01';

    private const RETRY_STATUS = [408, 409, 429, 500, 502, 503, 504, 529];
    private const MAX_ATTEMPTS = 3;
    private const PER_MINUTE   = 60;   // app-wide guard against runaway loops

    private string $key;
    private string $storageDir;
    /** Features the API rejected once in this process (fallbacks / output format). */
    private static array $disabled = [];

    public function __construct(string $apiKey, string $storageDir)
    {
        $this->key        = trim($apiKey);
        $this->storageDir = rtrim($storageDir, '/');
    }

    /** Build from the app config (config['ai']['claude_key'] ← .env CLAUDE_API_KEY in config/config.php). */
    public static function fromConfig(array $config): self
    {
        $key = (string) ($config['ai']['claude_key'] ?? '');
        $dir = (string) ($config['ai']['storage_dir'] ?? '');
        if ($dir === '') {
            $dir = dirname((string) ($config['storage']['raw_log'] ?? (dirname(__DIR__) . '/storage/x')));
        }
        return new self($key, $dir);
    }

    public function ready(): bool
    {
        return $this->key !== '' && function_exists('curl_init');
    }

    /** The model a use case runs on. Unknown use cases get the Sonnet default. */
    public static function modelFor(string $useCase): string
    {
        $tier = (self::ROUTES[$useCase] ?? self::ROUTES['chat'])[0];
        return self::MODELS[$tier];
    }

    /** The whole routing table, for docs/diagnostics. */
    public static function routingTable(): array
    {
        $out = [];
        foreach (self::ROUTES as $uc => [$tier, $max, $effort, $timeout]) {
            $out[$uc] = ['model' => self::MODELS[$tier], 'max_tokens' => $max, 'effort' => $effort, 'timeout_s' => $timeout];
        }
        return $out;
    }

    // ── High-level helpers ───────────────────────────────────

    /**
     * Plain text completion.
     *
     * @param string|array $system   System prompt (string or text blocks).
     * @param array        $messages [['role'=>'user'|'assistant','content'=>string|blocks], …]
     * @param array        $opts     max_tokens, effort, model (override), tools, timeout
     * @return array{ok:bool, text?:string, model?:string, usage?:array, stop_reason?:string, content?:array, error?:string, status?:int}
     */
    public function text(string $useCase, $system, array $messages, array $opts = []): array
    {
        $res = $this->send($useCase, $this->body($useCase, $system, $messages, $opts), $opts);
        if (!$res['ok']) {
            return $res;
        }
        $res['text'] = self::textOf($res['json']);
        if ($res['text'] === '' && ($res['stop_reason'] ?? '') !== 'tool_use') {
            return ['ok' => false, 'error' => 'Claude returned an empty answer (' . ($res['stop_reason'] ?? '?') . ').',
                    'status' => $res['status'], 'model' => $res['model']];
        }
        return $res;
    }

    /**
     * Strict-JSON completion. Sends a JSON-schema output format (structured
     * outputs); if the API rejects that field, retries once relying on the
     * prompt alone. The reply is parsed tolerantly (fences stripped).
     *
     * @return array{ok:bool, data?:array, text?:string, model?:string, usage?:array, error?:string}
     */
    public function json(string $useCase, $system, array $messages, array $schema, array $opts = []): array
    {
        $body = $this->body($useCase, $system, $messages, $opts);
        if (empty(self::$disabled['format'])) {
            $body['output_config']['format'] = ['type' => 'json_schema', 'schema' => $schema];
        }
        $res = $this->send($useCase, $body, $opts);
        if (!$res['ok']) {
            return $res;
        }
        $text = self::textOf($res['json']);
        $data = self::parseJson($text);
        if (!is_array($data)) {
            return ['ok' => false, 'error' => 'Claude did not return valid JSON.', 'text' => mb_substr($text, 0, 400),
                    'model' => $res['model'], 'usage' => $res['usage'] ?? []];
        }
        return $res + ['data' => $data, 'text' => $text];
    }

    /** A base64 image content block for vision requests. */
    public static function imageBlock(string $bytes, string $mime = 'image/jpeg'): array
    {
        $mime = in_array($mime, ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], true) ? $mime : 'image/jpeg';
        return ['type' => 'image', 'source' => ['type' => 'base64', 'media_type' => $mime, 'data' => base64_encode($bytes)]];
    }

    // ── Low level ────────────────────────────────────────────

    /** Request body for a use case (model, max_tokens, effort, system, tools). */
    public function body(string $useCase, $system, array $messages, array $opts = []): array
    {
        [$tier, $max, $effort] = self::ROUTES[$useCase] ?? self::ROUTES['chat'];
        $model = (string) ($opts['model'] ?? self::MODELS[$tier]);
        $body  = [
            'model'      => $model,
            'max_tokens' => (int) ($opts['max_tokens'] ?? $max),
            'messages'   => $messages,
            'output_config' => ['effort' => (string) ($opts['effort'] ?? $effort)],
        ];
        if (is_string($system) && $system !== '') {
            $body['system'] = [['type' => 'text', 'text' => $system, 'cache_control' => ['type' => 'ephemeral']]];
        } elseif (is_array($system) && $system) {
            $body['system'] = $system;
        }
        if (!empty($opts['tools'])) {
            $body['tools']       = $opts['tools'];
            $body['tool_choice'] = ['type' => 'auto'];
        }
        return $body;
    }

    /**
     * POST one request with retries. Returns the decoded JSON plus a normalised
     * envelope. Never throws.
     *
     * @return array{ok:bool, status:int, json?:array, model?:string, usage?:array, stop_reason?:string, content?:array, error?:string}
     */
    public function send(string $useCase, array $body, array $opts = []): array
    {
        if (!$this->ready()) {
            return ['ok' => false, 'status' => 0, 'error' => 'Claude is not configured (CLAUDE_API_KEY missing in .env).'];
        }
        if (!Upstream::allow('claude', $this->storageDir, self::PER_MINUTE)) {
            $cool = Upstream::cooldown('claude', $this->storageDir);
            return ['ok' => false, 'status' => 429,
                    'error' => 'The AI service is busy' . ($cool ? ' (cooling down ' . $cool . 's)' : '') . ' — try again shortly.'];
        }
        $timeout = (int) ($opts['timeout'] ?? (self::ROUTES[$useCase] ?? self::ROUTES['chat'])[3]);
        $model   = (string) $body['model'];

        if (in_array($model, self::FALLBACK_MODELS, true) && empty(self::$disabled['fallbacks']) && !isset($body['fallbacks'])) {
            $body['fallbacks'] = 'default';
        }

        $attempt = 0;
        $r       = [];
        while (true) {
            $attempt++;
            $t0 = microtime(true);
            $r  = $this->post($body, $timeout);
            $ms = (int) round((microtime(true) - $t0) * 1000);

            // Optional request features the API refuses: drop and resend once.
            if ($r['status'] === 400) {
                $msg = strtolower((string) ($r['json']['error']['message'] ?? ''));
                if (isset($body['fallbacks']) && str_contains($msg, 'fallback')) {
                    self::$disabled['fallbacks'] = true;
                    unset($body['fallbacks']);
                    $this->log($useCase, $model, $r, $ms, $attempt, 'retry_without_fallbacks');
                    $attempt--;
                    continue;
                }
                if (isset($body['output_config']['format']) && (str_contains($msg, 'output_config') || str_contains($msg, 'format') || str_contains($msg, 'schema'))) {
                    self::$disabled['format'] = true;
                    unset($body['output_config']['format']);
                    $this->log($useCase, $model, $r, $ms, $attempt, 'retry_without_format');
                    $attempt--;
                    continue;
                }
            }

            $retryable = $r['err'] !== '' || in_array($r['status'], self::RETRY_STATUS, true);
            $this->log($useCase, $model, $r, $ms, $attempt, $retryable && $attempt < self::MAX_ATTEMPTS ? 'retry' : '');
            if (!$retryable || $attempt >= self::MAX_ATTEMPTS) {
                break;
            }
            $wait = $r['retry_after'] > 0 ? min(20.0, (float) $r['retry_after']) : min(8.0, 2 ** ($attempt - 1));
            usleep((int) (($wait + mt_rand(0, 400) / 1000) * 1_000_000));
        }

        if ($r['status'] === 200 && is_array($r['json'])) {
            Upstream::ok('claude', $this->storageDir);
            $j    = $r['json'];
            $stop = (string) ($j['stop_reason'] ?? '');
            if ($stop === 'refusal') {
                return ['ok' => false, 'status' => 200, 'model' => (string) ($j['model'] ?? $model), 'stop_reason' => $stop,
                        'error' => 'Claude declined this request.'];
            }
            return ['ok' => true, 'status' => 200, 'json' => $j, 'model' => (string) ($j['model'] ?? $model),
                    'usage' => (array) ($j['usage'] ?? []), 'stop_reason' => $stop, 'content' => (array) ($j['content'] ?? [])];
        }
        if ($r['err'] !== '' || $r['status'] >= 500 || $r['status'] === 0) {
            Upstream::failed('claude', $this->storageDir, 60);
        }
        return ['ok' => false, 'status' => $r['status'], 'model' => $model, 'error' => self::explain($r)];
    }

    /** Concatenated text blocks of a response (thinking / tool blocks ignored). */
    public static function textOf(array $json): string
    {
        $t = '';
        foreach ((array) ($json['content'] ?? []) as $b) {
            if (($b['type'] ?? '') === 'text') {
                $t .= (string) ($b['text'] ?? '');
            }
        }
        return trim($t);
    }

    /** Parse a JSON object out of model text, tolerating ``` fences / prose. */
    public static function parseJson(string $text): ?array
    {
        $t = trim($text);
        $t = preg_replace('/^```(?:json)?\s*|\s*```$/i', '', $t) ?? $t;
        $d = json_decode($t, true);
        if (is_array($d)) {
            return $d;
        }
        $a = strpos($t, '{');
        $b = strrpos($t, '}');
        if ($a !== false && $b !== false && $b > $a) {
            $d = json_decode(substr($t, $a, $b - $a + 1), true);
            return is_array($d) ? $d : null;
        }
        return null;
    }

    // ── internals ────────────────────────────────────────────

    private function post(array $body, int $timeout): array
    {
        $headers = [
            'content-type: application/json',
            'x-api-key: ' . $this->key,
            'anthropic-version: ' . self::API_VERSION,
        ];
        if (isset($body['fallbacks'])) {
            $headers[] = 'anthropic-beta: ' . self::FALLBACK_BETA;
        }
        $retryAfter = 0;
        $requestId  = '';
        $ch = curl_init(self::ENDPOINT);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT        => max(10, $timeout),
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_POSTFIELDS     => json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
            CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$retryAfter, &$requestId): int {
                $l = strtolower($line);
                if (str_starts_with($l, 'retry-after:')) {
                    $retryAfter = (int) trim(substr($line, 12));
                } elseif (str_starts_with($l, 'request-id:')) {
                    $requestId = trim(substr($line, 11));
                }
                return strlen($line);
            },
        ]);
        $raw    = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err    = curl_error($ch);
        curl_close($ch);
        return ['status' => $status, 'err' => $err, 'retry_after' => $retryAfter, 'request_id' => $requestId,
                'json' => is_string($raw) ? (json_decode($raw, true) ?: []) : []];
    }

    /** One structured line per attempt. No key, no prompt/response content. */
    private function log(string $useCase, string $model, array $r, int $ms, int $attempt, string $note): void
    {
        $u    = (array) ($r['json']['usage'] ?? []);
        $line = [
            'ts' => date('c'), 'use_case' => $useCase, 'model' => $model, 'status' => $r['status'],
            'ms' => $ms, 'attempt' => $attempt, 'request_id' => $r['request_id'] ?? '',
            'in' => $u['input_tokens'] ?? null, 'out' => $u['output_tokens'] ?? null,
            'cache_read' => $u['cache_read_input_tokens'] ?? null,
            'stop' => $r['json']['stop_reason'] ?? null,
        ];
        if ($r['status'] !== 200) {
            $line['error_type'] = $r['json']['error']['type'] ?? ($r['err'] !== '' ? 'transport' : 'http');
            $line['error']      = mb_substr((string) ($r['json']['error']['message'] ?? $r['err']), 0, 200);
            error_log('[claude] ' . $useCase . ' ' . $model . ' HTTP ' . $r['status'] . ' ' . $line['error_type'] . ': ' . $line['error']);
        }
        if ($note !== '') {
            $line['note'] = $note;
        }
        $file = $this->storageDir . '/ai_calls.log';
        if (is_file($file) && filesize($file) > 5 * 1024 * 1024) {
            @rename($file, $file . '.1');
        }
        @file_put_contents($file, json_encode($line, JSON_UNESCAPED_SLASHES) . "\n", FILE_APPEND | LOCK_EX);
    }

    /** Operator-readable failure reason (never echoes the key). */
    private static function explain(array $r): string
    {
        $msg = (string) ($r['json']['error']['message'] ?? '');
        if ($r['err'] !== '') {
            return 'Claude did not respond in time — try again in a moment.';
        }
        return match (true) {
            $r['status'] === 401, $r['status'] === 403 => 'The Claude API key was rejected (HTTP ' . $r['status'] . '). Check CLAUDE_API_KEY in .env.',
            $r['status'] === 429 => 'Claude is rate-limiting this key — try again shortly.',
            $r['status'] === 529, $r['status'] >= 500 => 'Claude is temporarily unavailable (HTTP ' . $r['status'] . '). Try again shortly.',
            default => 'Claude returned HTTP ' . $r['status'] . ($msg !== '' ? ': ' . mb_substr($msg, 0, 160) : '.'),
        };
    }
}
