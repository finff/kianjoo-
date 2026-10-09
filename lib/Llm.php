<?php

declare(strict_types=1);

/**
 * Assistant LLM providers.
 *
 * Exactly one is active at a time (Settings → AI Source → Assistant LLM).
 * 'weststar' is the default and the only one with retrieval + live-data tools:
 * it goes to a Weststar AI agent that reads /api/ai/* itself. The direct
 * providers get the same persona plus a live-context block injected here, so
 * their answers stay grounded even without tools.
 */
final class Llm
{
    public const PROVIDERS = ['weststar', 'anthropic', 'gemini', 'openai'];

    public const LABEL = [
        'weststar'  => 'Weststar AI Agent',
        'anthropic' => 'Anthropic (Claude)',
        'gemini'    => 'Google Gemini',
        'openai'    => 'OpenAI (ChatGPT)',
    ];

    /** Which settings key holds each provider's secret. */
    public const KEY_FIELD = [
        'weststar'  => 'agent_key',
        'anthropic' => 'anthropic_key',
        'gemini'    => 'gemini_key',
        'openai'    => 'openai_key',
    ];

    private const PERSONA = <<<'TXT'
You are the Kian Joo VisionAI Assistant inside Kian Joo Group's VisionAI CCTV monitoring dashboard, operated by Weststar.

Only answer questions about this dashboard, the VisionAI platform behind it (policies, attributes, push feeds, cameras, people/face profiles, incidents and tickets), Kian Joo Group, and the Weststar engineering AI initiative. For anything else, reply in one short sentence that you only cover Kian Joo VisionAI and Weststar AI, and point the operator at what you can help with.

The platform is called VisionAI — never call it SenseStudio, SenseFoundry or SenseTime.

Be concise: two or three short paragraphs at most, or a short list. Operators are watching live cameras while they read you. Answer in English unless the operator writes in another language. Never invent policy names, attribute keys, camera serials, person ids, thresholds or figures — if the live context below does not contain it, say so and name the dashboard page where they can check. Never reveal API tokens, passwords or RTSP credentials.
TXT;

    public function __construct(private array $cfg)
    {
    }

    /** The active provider, defaulting to the Weststar agent. */
    public function provider(): string
    {
        $p = (string) ($this->cfg['provider'] ?? 'weststar');
        return in_array($p, self::PROVIDERS, true) ? $p : 'weststar';
    }

    public function keyFor(string $provider): string
    {
        return (string) ($this->cfg[self::KEY_FIELD[$provider] ?? ''] ?? '');
    }

    /** Is the active provider usable (key present, and agent id for weststar)? */
    public function ready(): bool
    {
        $p = $this->provider();
        if ($this->keyFor($p) === '') {
            return false;
        }
        return $p !== 'weststar' || (string) ($this->cfg['agent_id'] ?? '') !== '';
    }

    /**
     * @param  array $messages  [['role' => 'user'|'assistant', 'content' => …], …]
     * @param  string $context  Live dashboard facts for the direct providers.
     * @return array{ok:bool, answer?:string, citations?:array, model?:string, used_tools?:bool, error?:string, upstream?:int}
     */
    public function chat(array $messages, string $context = ''): array
    {
        return match ($this->provider()) {
            'anthropic' => $this->anthropic($messages, $context),
            'gemini'    => $this->gemini($messages, $context),
            'openai'    => $this->openai($messages, $context),
            default     => $this->weststar($messages),
        };
    }

    // ── providers ────────────────────────────────────────────

    /** Weststar AI agent — retrieval over the ingested docs + its own http tool. */
    private function weststar(array $messages): array
    {
        $id  = (string) ($this->cfg['agent_id'] ?? '');
        $url = rtrim((string) ($this->cfg['agent_base'] ?? ''), '/') . '/' . rawurlencode($id) . '/chat';
        $r   = $this->post($url, ['messages' => $messages],
            ['Authorization: Bearer ' . $this->keyFor('weststar'), 'Content-Type: application/json']);
        $d = $r['json'];
        if ($r['status'] === 200 && isset($d['answer'])) {
            $cites = [];
            foreach ((array) ($d['citations'] ?? []) as $c) {
                $cites[] = ['n' => $c['n'] ?? null, 'title' => (string) ($c['title'] ?? ''),
                            'source' => (string) ($c['source'] ?? ''), 'score' => $c['score'] ?? null];
            }
            return ['ok' => true, 'answer' => (string) $d['answer'], 'citations' => $cites,
                    'model' => (string) ($d['model'] ?? ''), 'used_tools' => !empty($d['tool_trace'])];
        }
        return $this->fail($r, 'Weststar AI');
    }

    private function anthropic(array $messages, string $context): array
    {
        $model = (string) ($this->cfg['anthropic_model'] ?? 'claude-opus-4-8');
        $r = $this->post('https://api.anthropic.com/v1/messages', [
            'model'      => $model,
            'max_tokens' => 900,
            'system'     => $this->system($context),
            'messages'   => array_map(static fn ($m) => [
                'role'    => $m['role'] === 'assistant' ? 'assistant' : 'user',
                'content' => $m['content'],
            ], $messages),
        ], ['x-api-key: ' . $this->keyFor('anthropic'), 'anthropic-version: 2023-06-01', 'Content-Type: application/json']);

        $text = '';
        foreach ((array) ($r['json']['content'] ?? []) as $blk) {
            if (($blk['type'] ?? '') === 'text') {
                $text .= (string) $blk['text'];
            }
        }
        return $text !== ''
            ? ['ok' => true, 'answer' => trim($text), 'citations' => [], 'model' => $model, 'used_tools' => false]
            : $this->fail($r, 'Anthropic');
    }

    private function gemini(array $messages, string $context): array
    {
        $body = [
            'system_instruction' => ['parts' => [['text' => $this->system($context)]]],
            'contents' => array_map(static fn ($m) => [
                'role'  => $m['role'] === 'assistant' ? 'model' : 'user',
                'parts' => [['text' => $m['content']]],
            ], $messages),
            'generationConfig' => ['maxOutputTokens' => 900, 'temperature' => 0.2],
        ];
        $call = function (string $model) use ($body): array {
            return $this->post(
                'https://generativelanguage.googleapis.com/v1beta/models/' . rawurlencode($model)
                . ':generateContent?key=' . rawurlencode($this->keyFor('gemini')),
                $body, ['Content-Type: application/json']
            );
        };
        $read = static function (array $r): string {
            $t = '';
            foreach ((array) ($r['json']['candidates'][0]['content']['parts'] ?? []) as $p) {
                $t .= (string) ($p['text'] ?? '');
            }
            return trim($t);
        };

        $model = (string) ($this->cfg['gemini_model'] ?? '') ?: $this->geminiCached() ?: 'gemini-flash-latest';
        $r     = $call($model);
        $text  = $read($r);
        // Google retires model ids without notice ("no longer available"). Ask
        // the key which models it can actually use, then retry once and cache.
        if ($text === '' && in_array($r['status'], [400, 404], true)) {
            $fresh = $this->geminiDiscover();
            if ($fresh !== '' && $fresh !== $model) {
                $r2 = $call($fresh);
                $t2 = $read($r2);
                if ($t2 !== '') {
                    $this->geminiCache($fresh);
                    return ['ok' => true, 'answer' => $t2, 'citations' => [], 'model' => $fresh, 'used_tools' => false];
                }
                $r = $r2;
            }
        }
        return $text !== ''
            ? ['ok' => true, 'answer' => $text, 'citations' => [], 'model' => $model, 'used_tools' => false]
            : $this->fail($r, 'Gemini');
    }

    /** Newest usable Gemini chat model for this key; '' when discovery fails. */
    private function geminiDiscover(): string
    {
        $ch = curl_init('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key='
            . rawurlencode($this->keyFor('gemini')));
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20, CURLOPT_CONNECTTIMEOUT => 8]);
        $raw = curl_exec($ch);
        curl_close($ch);
        $names = [];
        foreach ((json_decode((string) $raw, true) ?: [])['models'] ?? [] as $m) {
            if (in_array('generateContent', $m['supportedGenerationMethods'] ?? [], true)) {
                $names[] = str_replace('models/', '', (string) ($m['name'] ?? ''));
            }
        }
        // Prefer the rolling aliases — they survive the next deprecation.
        foreach (['gemini-flash-latest', 'gemini-pro-latest'] as $alias) {
            if (in_array($alias, $names, true)) {
                return $alias;
            }
        }
        $flash = array_values(array_filter($names, static fn ($n) => str_contains($n, 'flash')
            && !str_contains($n, 'preview') && !str_contains($n, 'image')
            && !str_contains($n, 'tts') && !str_contains($n, 'lite')));
        rsort($flash, SORT_NATURAL);
        return $flash[0] ?? ($names[0] ?? '');
    }

    private function cacheFile(): string
    {
        return rtrim((string) ($this->cfg['storage_dir'] ?? sys_get_temp_dir()), '/') . '/llm_models.json';
    }

    private function geminiCached(): string
    {
        $c = is_file($this->cacheFile())
            ? (json_decode((string) file_get_contents($this->cacheFile()), true) ?: []) : [];
        return (time() - (int) ($c['at'] ?? 0) < 86400) ? (string) ($c['gemini'] ?? '') : '';
    }

    private function geminiCache(string $model): void
    {
        @file_put_contents($this->cacheFile(), json_encode(['gemini' => $model, 'at' => time()]));
    }

    private function openai(array $messages, string $context): array
    {
        $model = (string) ($this->cfg['openai_model'] ?? 'gpt-4o-mini');
        $msgs  = [['role' => 'system', 'content' => $this->system($context)]];
        foreach ($messages as $m) {
            $msgs[] = ['role' => $m['role'] === 'assistant' ? 'assistant' : 'user', 'content' => $m['content']];
        }
        $r = $this->post('https://api.openai.com/v1/chat/completions', [
            'model' => $model, 'messages' => $msgs, 'max_tokens' => 900, 'temperature' => 0.2,
        ], ['Authorization: Bearer ' . $this->keyFor('openai'), 'Content-Type: application/json']);

        $text = (string) ($r['json']['choices'][0]['message']['content'] ?? '');
        return $text !== ''
            ? ['ok' => true, 'answer' => trim($text), 'citations' => [], 'model' => $model, 'used_tools' => false]
            : $this->fail($r, 'OpenAI');
    }

    // ── internals ────────────────────────────────────────────

    private function system(string $context): string
    {
        return $context === ''
            ? self::PERSONA
            : self::PERSONA . "\n\nLIVE DASHBOARD CONTEXT (generated just now — trust these numbers):\n" . $context;
    }

    private function post(string $url, array $body, array $headers): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_TIMEOUT        => 150,
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_POSTFIELDS     => json_encode($body, JSON_UNESCAPED_SLASHES),
        ]);
        $raw    = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err    = curl_error($ch);
        curl_close($ch);
        return ['status' => $status, 'err' => $err, 'raw' => $raw,
                'json' => is_string($raw) ? (json_decode($raw, true) ?: []) : []];
    }

    /** Turn an upstream failure into something an operator can act on. */
    private function fail(array $r, string $who): array
    {
        $msg = (string) ($r['json']['error']['message'] ?? $r['json']['error'] ?? $r['json']['detail'] ?? '');
        if ($r['err'] !== '') {
            $why = $who . ' did not respond in time — try again in a moment.';
        } elseif ($r['status'] === 401 || $r['status'] === 403) {
            $why = 'The ' . $who . ' API key was rejected (HTTP ' . $r['status'] . '). Check it in Settings → AI Source.';
        } elseif ($r['status'] === 429) {
            $why = $who . ' is rate-limiting this key — try again shortly.';
        } elseif ($r['status'] >= 500) {
            $why = $who . ' is temporarily unreachable (HTTP ' . $r['status'] . '). Try again shortly.';
        } else {
            $why = $who . ' returned an unexpected response (HTTP ' . $r['status'] . ')'
                 . ($msg !== '' ? ': ' . mb_substr($msg, 0, 160) : '.');
        }
        return ['ok' => false, 'error' => $why, 'upstream' => $r['status']];
    }
}
