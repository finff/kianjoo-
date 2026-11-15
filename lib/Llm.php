<?php

declare(strict_types=1);

require_once __DIR__ . '/Claude.php';

/**
 * Provider-neutral LLM layer for the in-dashboard assistant and AI reports.
 *
 * ┌──────────────── provider-neutral ────────────────┐   ┌──── provider seam ────┐
 *  AiRoutes / AiReports / AiTools / app.js            │   │ LlmAdapter (interface) │
 *    tools   = [{name, description, parameters}]      │──▶│  ClaudeAdapter ─▶ lib/Claude.php
 *    reply   = {answer, refs, tools_called, model}    │   │  (future) XyzAdapter   │
 *  Llm::chat() — the tool loop, refs, RBAC via AiTools │   └────────────────────────┘
 *
 * Everything vendor-specific (message/content blocks, tool_use/tool_result
 * shapes, model ids, headers) lives in an adapter class at the bottom of this
 * file and in lib/Claude.php. Nothing else in the app may build or parse a
 * provider wire format.
 *
 * Adding a provider = one new class implementing LlmAdapter + one case in
 * Llm::adapterFor() (config ai.source picks it). See docs/plan/AI_LAYER.md
 * "How to add another provider".
 *
 * The assistant reads live data exclusively through the RBAC-filtered AiTools
 * whitelist: the model is only told about the tools the signed-in user may
 * call, every call is re-authorised server-side, and tool input is validated
 * by AiTools. The only write-ish tool is generate_report (AI_LAYER §3).
 */
final class Llm
{
    /** Source ids accepted from settings. Legacy ids (weststar/gemini/openai) still resolve to Claude until they get an adapter. */
    public const PROVIDERS = ['claude', 'weststar', 'anthropic', 'gemini', 'openai'];

    public const LABEL = [
        'claude'    => 'Claude (Anthropic)',
        'weststar'  => 'Claude (Anthropic)',
        'anthropic' => 'Claude (Anthropic)',
        'gemini'    => 'Claude (Anthropic)',
        'openai'    => 'Claude (Anthropic)',
    ];

    public const KEY_FIELD = [
        'claude' => 'claude_key', 'weststar' => 'claude_key', 'anthropic' => 'claude_key',
        'gemini' => 'claude_key', 'openai' => 'claude_key',
    ];

    private const MAX_TOOL_ROUNDS = 5;
    private const MAX_REFS        = 12;
    private const TOOL_JSON_CAP   = 30000;

    private const PERSONA = <<<'TXT'
You are the Kian Joo VisionAI Assistant inside Kian Joo Group's VisionAI factory monitoring and attendance platform, operated by Weststar.

Only answer questions about this platform (attendance, leave, tickets, people on record, reports and — for roles allowed to see them — cameras, detections, PPE and forklift safety), Kian Joo Group, and the Weststar AI initiative. For anything else, reply in one short sentence that you only cover Kian Joo VisionAI.

The platform is called VisionAI — never call it SenseStudio, SenseFoundry or SenseTime.

Data access: you can ONLY see data through the tools provided to you, and those tools are already limited to what the signed-in user's role permits. If a question needs data you have no tool for, say plainly that their role does not have access to that information — do not guess, do not hint at it, and do not describe other people's records. Never invent names, ids, figures, thresholds or camera details. Never reveal API keys, tokens, passwords or RTSP credentials.

Actions: you cannot change records. The one exception is generate_report — call it only when the user explicitly asks you to generate / create / produce a report, and at most once per message. Pick the scope from their words (personal = only their own records; standard = everything their role may see; comprehensive = deep cross-section analysis) and a range like today, 7d, 30d, month or YYYY-MM-DD..YYYY-MM-DD (default 7d). When it succeeds, say the report is ready and give its report number — the app shows Open and Download PDF buttons under your answer. For any other change, explain where in the app the user can do it.

Finding people: when asked to find, look up or show a person, call find_person. If it returns no matches, answer plainly that this person was not found in the records — do not guess or suggest other people. When it returns matches, name each one with their staff id; the app shows their photos and recent face captures under your answer automatically.

Referencing records: refer to records by their ids in plain text exactly as the tools return them — ticket numbers (TKT-…), leave numbers (LV-…), report numbers (RPT-…), camera labels, and people by their full name. The app turns these into clickable links, so never write URLs, image links or HTML yourself.

Formatting: use light Markdown — **bold** for key figures, short "### " headings only when an answer has several parts, "- " bullet lists, and a small table only when comparing a few rows. Be concise: two or three short paragraphs at most, or a short list. Answer in English unless the user writes in another language.
TXT;

    private LlmAdapter $adapter;

    /**
     * @param array                   $cfg      config['ai'] (claude_key, storage_dir, source …)
     * @param LlmAdapter|Claude|null  $adapter  explicit adapter (tests), a Claude client (legacy), or null = pick from ai.source
     */
    public function __construct(private array $cfg, LlmAdapter|Claude|null $adapter = null)
    {
        if ($adapter instanceof LlmAdapter) {
            $this->adapter = $adapter;
        } elseif ($adapter instanceof Claude) {
            $this->adapter = new ClaudeAdapter($adapter);
        } else {
            $this->adapter = self::adapterFor((string) ($cfg['source'] ?? 'claude'), ['ai' => $cfg]);
        }
    }

    /** Build from the whole app config. */
    public static function fromConfig(array $config): self
    {
        return new self((array) ($config['ai'] ?? []), self::adapterFor((string) ($config['ai']['source'] ?? 'claude'), $config));
    }

    /**
     * THE provider switch. To add a provider: implement LlmAdapter in a new
     * class and add one case here keyed by its ai.source id.
     */
    public static function adapterFor(string $source, array $config): LlmAdapter
    {
        switch (strtolower(trim($source))) {
            // case 'openai': return OpenAiAdapter::fromConfig($config);   ← example of a future provider
            case 'claude':
            case 'anthropic':
            case 'off':          // 'off' is enforced by the routes; keep a valid adapter for diagnostics
            default:
                return new ClaudeAdapter(Claude::fromConfig($config));
        }
    }

    public function provider(): string
    {
        return $this->adapter->id();
    }

    public function keyFor(string $provider): string
    {
        return (string) ($this->cfg['claude_key'] ?? '');
    }

    public function ready(): bool
    {
        return $this->adapter->ready();
    }

    /** Model id a use case runs on (for logging / persistence only — never parse it). */
    public function modelFor(string $useCase): string
    {
        return $this->adapter->modelFor($useCase);
    }

    /**
     * Strict-JSON completion (reports).
     * @return array{ok:bool, data?:array, model?:string, usage:array{in:?int,out:?int}, error?:string, status?:int}
     */
    public function structured(string $useCase, string $system, string $prompt, array $schema): array
    {
        return $this->adapter->structured($useCase, $system, $prompt, $schema);
    }

    /**
     * Assistant chat with the RBAC-scoped tool loop.
     *
     * @param array        $messages  [['role'=>'user'|'assistant','content'=>string], …]
     * @param string       $context   Extra system context (e.g. who the user is).
     * @param AiTools|null $tools     RBAC-scoped fetchers for this user; null = no data access.
     * @return array{ok:bool, answer?:string, refs?:array, citations?:array, model?:string, used_tools?:bool, tools_called?:array, error?:string, upstream?:int}
     */
    public function chat(array $messages, string $context = '', ?object $tools = null): array
    {
        $system = self::PERSONA . ($context !== '' ? "\n\n" . $context : '');
        $thread = $this->adapter->thread(array_map(static fn ($m) => [
            'role'    => ($m['role'] ?? '') === 'assistant' ? 'assistant' : 'user',
            'content' => (string) ($m['content'] ?? ''),
        ], $messages));
        $defs   = $tools ? $tools->toolDefs() : [];
        $called = [];
        $refs   = [];
        $model  = $this->adapter->modelFor('chat');

        for ($round = 0; $round <= self::MAX_TOOL_ROUNDS; $round++) {
            $turn = $this->adapter->turn('chat', $system, $thread, $defs && $round < self::MAX_TOOL_ROUNDS ? $defs : []);
            if (!$turn['ok']) {
                return ['ok' => false, 'error' => $turn['error'] ?? 'The assistant could not answer.', 'upstream' => $turn['status'] ?? 0];
            }
            $model = $turn['model'] ?: $model;
            if (!$turn['calls'] || !$tools) {
                $text = trim((string) $turn['text']);
                if ($text === '') {
                    return ['ok' => false, 'error' => 'The assistant returned an empty answer.', 'upstream' => 200];
                }
                return ['ok' => true, 'answer' => $text, 'refs' => self::finalRefs($refs, $text), 'citations' => [], 'model' => $model,
                        'used_tools' => (bool) $called, 'tools_called' => array_values(array_unique($called))];
            }
            $results = [];
            foreach ($turn['calls'] as $c) {
                $out      = $tools->call((string) $c['name'], (array) $c['args']);
                $called[] = (string) $c['name'];
                foreach ((array) ($out['refs'] ?? []) as $r) {
                    $refs[] = $r;
                }
                // refs are for the UI (photos, urls) — the model already has the ids in the data.
                unset($out['refs']);
                $results[] = ['id' => (string) $c['id'], 'name' => (string) $c['name'],
                              'content' => self::toolJson($out), 'is_error' => isset($out['error'])];
            }
            $thread = $this->adapter->appendToolResults($thread, $turn, $results);
        }
        return ['ok' => false, 'error' => 'The assistant needed too many lookups — try a narrower question.', 'upstream' => 200];
    }

    private static function toolJson(array $out): string
    {
        $json = json_encode($out, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) ?: '{}';
        if (strlen($json) > self::TOOL_JSON_CAP) {
            $json = mb_strcut($json, 0, self::TOOL_JSON_CAP) . '…(truncated)';
        }
        return $json;
    }

    /**
     * Dedupe refs (type+id), then order: reports, people with photos, records
     * the answer actually mentions, the rest. Capped.
     */
    public static function finalRefs(array $refs, string $answer = ''): array
    {
        $seen = [];
        $out  = [];
        foreach ($refs as $i => $r) {
            if (!is_array($r) || empty($r['type']) || !isset($r['id']) || (string) $r['id'] === '') {
                continue;
            }
            $k = $r['type'] . ':' . $r['id'];
            if (isset($seen[$k])) {
                // keep the richer one (e.g. find_person's photo card over a roster chip)
                if (count($r) > count($out[$seen[$k]][1])) {
                    $out[$seen[$k]][1] = $r;
                }
                continue;
            }
            $seen[$k] = count($out);
            $out[]    = [$i, $r];
        }
        $lc   = mb_strtolower($answer);
        $rank = static function (array $r) use ($lc): int {
            if ($r['type'] === 'report') {
                return 0;
            }
            if ($r['type'] === 'person' && (!empty($r['shots']) || !empty($r['photo'])) && !empty($r['match'])) {
                return 1;
            }
            $id = mb_strtolower((string) $r['id']);
            $lb = mb_strtolower((string) ($r['label'] ?? ''));
            if ($lc !== '' && ((mb_strlen($id) >= 3 && str_contains($lc, $id)) || (mb_strlen($lb) >= 4 && str_contains($lc, $lb)))) {
                return 2;
            }
            return 3;
        };
        usort($out, static fn ($a, $b) => ($rank($a[1]) <=> $rank($b[1])) ?: ($a[0] <=> $b[0]));
        return array_slice(array_map(static fn ($x) => $x[1], $out), 0, self::MAX_REFS);
    }
}

/**
 * The provider seam. Neutral in, neutral out:
 *   tools    [{name, description, parameters (JSON schema object)}]
 *   messages [{role: user|assistant, content: string}]
 *   turn     {ok, text, calls:[{id, name, args}], model, usage:{in, out}, error?, status?, native?}
 * A "thread" is the adapter's own opaque transcript; callers only pass it back.
 */
interface LlmAdapter
{
    public function id(): string;

    public function ready(): bool;

    public function modelFor(string $useCase): string;

    /** Provider-native transcript from neutral messages. */
    public function thread(array $messages): array;

    /** One model turn over the transcript, optionally offering tools. */
    public function turn(string $useCase, string $system, array $thread, array $tools): array;

    /** Transcript + this turn's tool requests + neutral results [{id, name, content:string, is_error:bool}]. */
    public function appendToolResults(array $thread, array $turn, array $results): array;

    /** Strict-JSON output: {ok, data?, model?, usage:{in, out}, error?, status?}. */
    public function structured(string $useCase, string $system, string $prompt, array $schema): array;
}

/** Anthropic Messages API adapter — the ONLY place outside lib/Claude.php that knows Claude's wire format. */
final class ClaudeAdapter implements LlmAdapter
{
    public function __construct(private Claude $claude)
    {
    }

    public function id(): string
    {
        return 'claude';
    }

    public function ready(): bool
    {
        return $this->claude->ready();
    }

    public function modelFor(string $useCase): string
    {
        return Claude::modelFor($useCase);
    }

    public function thread(array $messages): array
    {
        return array_map(static fn ($m) => ['role' => $m['role'], 'content' => (string) $m['content']], $messages);
    }

    public function turn(string $useCase, string $system, array $thread, array $tools): array
    {
        $opts = $tools ? ['tools' => array_map(static fn ($t) => [
            'name' => $t['name'], 'description' => $t['description'], 'input_schema' => $t['parameters'],
        ], $tools)] : [];
        $res = $this->claude->send($useCase, $this->claude->body($useCase, $system, $thread, $opts));
        if (!$res['ok']) {
            return ['ok' => false, 'text' => '', 'calls' => [], 'model' => (string) ($res['model'] ?? ''), 'usage' => self::usage($res),
                    'error' => $res['error'] ?? 'The assistant could not answer.', 'status' => $res['status'] ?? 0];
        }
        $calls = [];
        if (($res['stop_reason'] ?? '') === 'tool_use') {
            foreach ((array) $res['content'] as $b) {
                if (($b['type'] ?? '') === 'tool_use') {
                    $calls[] = ['id' => (string) ($b['id'] ?? ''), 'name' => (string) ($b['name'] ?? ''),
                                'args' => is_array($b['input'] ?? null) ? $b['input'] : []];
                }
            }
        }
        return ['ok' => true, 'text' => Claude::textOf($res['json']), 'calls' => $calls, 'model' => (string) ($res['model'] ?? ''),
                'usage' => self::usage($res), 'native' => (array) $res['content']];
    }

    public function appendToolResults(array $thread, array $turn, array $results): array
    {
        // Echo the assistant turn unchanged (incl. thinking blocks), then answer
        // every tool_use in ONE user message. A tool_use with empty input decodes
        // to PHP [] which re-encodes as a JSON array — the API requires an
        // object, so cast empty inputs back to {}.
        $echo = (array) ($turn['native'] ?? []);
        foreach ($echo as $i => $blk) {
            if (($blk['type'] ?? '') === 'tool_use' && is_array($blk['input'] ?? null) && $blk['input'] === []) {
                $echo[$i]['input'] = new \stdClass();
            }
        }
        $thread[] = ['role' => 'assistant', 'content' => $echo];
        $thread[] = ['role' => 'user', 'content' => array_map(static fn ($r) => [
            'type' => 'tool_result', 'tool_use_id' => (string) $r['id'], 'content' => (string) $r['content'],
        ] + (!empty($r['is_error']) ? ['is_error' => true] : []), $results)];
        return $thread;
    }

    public function structured(string $useCase, string $system, string $prompt, array $schema): array
    {
        $res = $this->claude->json($useCase, $system, [['role' => 'user', 'content' => $prompt]], $schema);
        $out = ['ok' => (bool) $res['ok'], 'model' => (string) ($res['model'] ?? ''), 'usage' => self::usage($res)];
        if (!$res['ok']) {
            return $out + ['error' => (string) ($res['error'] ?? 'The AI service failed.'), 'status' => (int) ($res['status'] ?? 0)];
        }
        return $out + ['data' => $res['data']];
    }

    private static function usage(array $res): array
    {
        $u = (array) ($res['usage'] ?? []);
        return ['in' => isset($u['input_tokens']) ? (int) $u['input_tokens'] : null,
                'out' => isset($u['output_tokens']) ? (int) $u['output_tokens'] : null];
    }
}
