<?php
/**
 * Workstream A — notification channel + escalation-workflow settings.
 *
 * Stored in storage/notify_settings.json (edited from Settings → Notifications
 * via GET/POST /api/notify/settings) and applied by config/config.php as
 *   $config['telegram']             Bot API channel
 *   $config['escalation']           unattended-alert escalation workflow (L1..L3)
 *   $config['alerts']['conditions'] predefined condition rules (Alert Rules page)
 *
 * .env defaults: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (comma list),
 * ESCALATION_ENABLED, ESCALATION_MIN (unattended minutes per level).
 */

declare(strict_types=1);

final class NotifySettings
{
    public const SEVS   = ['low', 'medium', 'high', 'critical'];
    public const MODS   = ['fire', 'ppe', 'intr', 'face', 'forklift', 'behaviour'];
    public const LEVELS = 3;
    private const DEFAULT_LEVEL_NAMES = ['Supervisor', 'Safety Officer', 'Plant Manager'];

    public static function file(): string
    {
        return dirname(__DIR__) . '/storage/notify_settings.json';
    }

    public static function raw(?string $file = null): array
    {
        $file = $file ?? self::file();
        if (!is_file($file)) {
            return [];
        }
        $j = json_decode((string) @file_get_contents($file), true);
        return is_array($j) ? $j : [];
    }

    /**
     * Effective settings (env defaults + stored overlay), normalized.
     * @return array{telegram:array, escalation:array, conditions:array}
     */
    public static function load(?string $file = null): array
    {
        $o   = self::raw($file);
        $env = static fn (string $k, string $d = ''): string => class_exists('Env') ? (string) (Env::get($k, $d) ?? $d) : (string) (getenv($k) ?: $d);

        $tg = is_array($o['telegram'] ?? null) ? $o['telegram'] : [];
        $token = (string) ($tg['bot_token'] ?? '');
        if ($token === '') {
            $token = $env('TELEGRAM_BOT_TOKEN');
        }
        $chats = array_key_exists('chat_ids', $tg) ? self::chatList($tg['chat_ids']) : self::chatList($env('TELEGRAM_CHAT_ID'));
        $telegram = [
            'enabled'    => array_key_exists('enabled', $tg) ? (bool) $tg['enabled'] : ($token !== '' && $chats !== []),
            'bot_token'  => $token,
            'chat_ids'   => $chats,
            'send_photo' => array_key_exists('send_photo', $tg) ? (bool) $tg['send_photo'] : true,
            'api_base'   => rtrim((string) ($tg['api_base'] ?? $env('TELEGRAM_API_BASE', 'https://api.telegram.org')), '/') ?: 'https://api.telegram.org',
        ];

        $es = is_array($o['escalation'] ?? null) ? $o['escalation'] : [];
        $levels = [];
        $inLv = is_array($es['levels'] ?? null) ? array_values($es['levels']) : [];
        for ($i = 0; $i < self::LEVELS; $i++) {
            $l = is_array($inLv[$i] ?? null) ? $inLv[$i] : [];
            $levels[] = [
                'name'    => self::clip((string) ($l['name'] ?? ''), 60) ?: self::DEFAULT_LEVEL_NAMES[$i],
                'emails'  => self::emailList($l['emails'] ?? []),
                'chats'   => self::chatList($l['chats'] ?? []),
                'enabled' => array_key_exists('enabled', $l) ? (bool) $l['enabled'] : true,
            ];
        }
        $escalation = [
            'enabled'        => array_key_exists('enabled', $es) ? (bool) $es['enabled'] : filter_var($env('ESCALATION_ENABLED', '1'), FILTER_VALIDATE_BOOLEAN),
            'unattended_min' => max(1, min(240, (int) ($es['unattended_min'] ?? ((int) $env('ESCALATION_MIN', '5') ?: 5)))),
            'min_severity'   => in_array($es['min_severity'] ?? '', self::SEVS, true) ? (string) $es['min_severity'] : 'high',
            'max_age_h'      => max(1, min(168, (int) ($es['max_age_h'] ?? 24))),
            'levels'         => $levels,
        ];

        $conditions = [];
        foreach (is_array($o['conditions'] ?? null) ? $o['conditions'] : [] as $c) {
            if (is_array($c) && ($n = self::condition($c)) !== null) {
                $conditions[] = $n;
            }
        }
        return ['telegram' => $telegram, 'escalation' => $escalation, 'conditions' => $conditions];
    }

    /**
     * Merge a POSTed patch into the stored file. Secrets (bot token) are only
     * overwritten by a non-empty, unmasked value; '' with clear_bot_token=true
     * removes it. Returns the new raw overlay.
     */
    public static function save(array $in, ?string $file = null): array
    {
        $file = $file ?? self::file();
        $cur  = self::raw($file);

        if (isset($in['telegram']) && is_array($in['telegram'])) {
            $t  = $in['telegram'];
            $tg = is_array($cur['telegram'] ?? null) ? $cur['telegram'] : [];
            if (array_key_exists('enabled', $t)) {
                $tg['enabled'] = filter_var($t['enabled'], FILTER_VALIDATE_BOOLEAN);
            }
            if (array_key_exists('send_photo', $t)) {
                $tg['send_photo'] = filter_var($t['send_photo'], FILTER_VALIDATE_BOOLEAN);
            }
            if (array_key_exists('chat_ids', $t)) {
                $tg['chat_ids'] = self::chatList($t['chat_ids']);
            }
            $tok = trim((string) ($t['bot_token'] ?? ''));
            if ($tok !== '' && !str_contains($tok, '•')) {
                if (!preg_match('/^\d{3,15}:[A-Za-z0-9_-]{20,80}$/', $tok)) {
                    throw new InvalidArgumentException('Bot token looks wrong — expected 123456789:AA… from @BotFather.');
                }
                $tg['bot_token'] = $tok;
            }
            if (!empty($t['clear_bot_token'])) {
                $tg['bot_token'] = '';
            }
            $cur['telegram'] = $tg;
        }

        if (isset($in['escalation']) && is_array($in['escalation'])) {
            $e  = $in['escalation'];
            $es = is_array($cur['escalation'] ?? null) ? $cur['escalation'] : [];
            if (array_key_exists('enabled', $e)) {
                $es['enabled'] = filter_var($e['enabled'], FILTER_VALIDATE_BOOLEAN);
            }
            if (isset($e['unattended_min'])) {
                $es['unattended_min'] = max(1, min(240, (int) $e['unattended_min']));
            }
            if (isset($e['min_severity']) && in_array($e['min_severity'], self::SEVS, true)) {
                $es['min_severity'] = $e['min_severity'];
            }
            if (isset($e['max_age_h'])) {
                $es['max_age_h'] = max(1, min(168, (int) $e['max_age_h']));
            }
            if (isset($e['levels']) && is_array($e['levels'])) {
                $old = is_array($es['levels'] ?? null) ? array_values($es['levels']) : [];
                $lv  = [];
                $inL = array_values($e['levels']);
                for ($i = 0; $i < self::LEVELS; $i++) {
                    $l = is_array($inL[$i] ?? null) ? $inL[$i] : [];
                    $o = is_array($old[$i] ?? null) ? $old[$i] : [];
                    $lv[] = [
                        'name'    => array_key_exists('name', $l) ? (self::clip((string) $l['name'], 60) ?: self::DEFAULT_LEVEL_NAMES[$i]) : ($o['name'] ?? self::DEFAULT_LEVEL_NAMES[$i]),
                        'emails'  => array_key_exists('emails', $l) ? self::emailList($l['emails']) : self::emailList($o['emails'] ?? []),
                        'chats'   => array_key_exists('chats', $l) ? self::chatList($l['chats']) : self::chatList($o['chats'] ?? []),
                        'enabled' => array_key_exists('enabled', $l) ? filter_var($l['enabled'], FILTER_VALIDATE_BOOLEAN) : (bool) ($o['enabled'] ?? true),
                    ];
                }
                $es['levels'] = $lv;
            }
            $cur['escalation'] = $es;
        }

        if (isset($in['conditions']) && is_array($in['conditions'])) {
            $list = [];
            foreach (array_slice($in['conditions'], 0, 50) as $c) {
                if (is_array($c) && ($n = self::condition($c)) !== null) {
                    $list[] = $n;
                }
            }
            $cur['conditions'] = $list;
        }

        if (!is_dir(dirname($file))) {
            @mkdir(dirname($file), 0775, true);
        }
        if (@file_put_contents($file, json_encode($cur, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX) === false) {
            throw new RuntimeException('Could not write ' . basename($file) . ' — check storage/ permissions.');
        }
        return $cur;
    }

    /** Settings for the UI: the bot token is masked, never returned in clear. */
    public static function publicView(array $eff): array
    {
        $tok = (string) ($eff['telegram']['bot_token'] ?? '');
        $tg  = $eff['telegram'];
        $tg['bot_token']     = $tok === '' ? '' : (str_repeat('•', 8) . substr($tok, -4));
        $tg['has_token']     = $tok !== '';
        unset($tg['api_base']);
        return ['telegram' => $tg, 'escalation' => $eff['escalation'], 'conditions' => $eff['conditions']];
    }

    /** One predefined condition rule, sanitized (null = invalid). */
    public static function condition(array $c): ?array
    {
        $name = self::clip((string) ($c['name'] ?? ''), 80);
        if ($name === '') {
            return null;
        }
        $mod = strtolower((string) ($c['mod'] ?? 'any'));
        $win = strtolower(trim((string) ($c['window'] ?? 'always')));
        if ($win !== 'always' && !preg_match('/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/', $win)) {
            $win = 'always';
        }
        $cam = strtolower(preg_replace('/[^a-z0-9_.-]+/i', '', (string) ($c['camera'] ?? '')) ?? '');
        $id  = substr(preg_replace('/[^a-z0-9_-]+/i', '', (string) ($c['id'] ?? '')) ?? '', 0, 40);
        $ch  = is_array($c['channels'] ?? null) ? $c['channels'] : [];
        return [
            'id'       => $id !== '' ? $id : ('c' . substr(md5($name . microtime()), 0, 8)),
            'name'     => $name,
            'enabled'  => array_key_exists('enabled', $c) ? filter_var($c['enabled'], FILTER_VALIDATE_BOOLEAN) : true,
            'mod'      => in_array($mod, self::MODS, true) ? $mod : 'any',
            'camera'   => $cam,                                        // '' = any camera
            'min_sev'  => in_array($c['min_sev'] ?? '', self::SEVS, true) ? (string) $c['min_sev'] : 'low',
            'window'   => $win,                                        // always | HH:MM-HH:MM (overnight ok)
            'keyword'  => self::clip((string) ($c['keyword'] ?? ''), 60),  // optional policy / title match
            'channels' => [
                'email'    => array_key_exists('email', $ch) ? (bool) $ch['email'] : true,
                'telegram' => array_key_exists('telegram', $ch) ? (bool) $ch['telegram'] : true,
            ],
        ];
    }

    /** @return string[] */
    public static function chatList($v): array
    {
        $a = is_array($v) ? $v : preg_split('/[\s,;]+/', (string) $v);
        $out = [];
        foreach ($a ?: [] as $x) {
            $x = trim((string) $x);
            // numeric chat / group / channel id, or a public @channelusername
            if (preg_match('/^-?\d{3,20}$/', $x) || preg_match('/^@[A-Za-z][A-Za-z0-9_]{3,40}$/', $x)) {
                $out[] = $x;
            }
        }
        return array_values(array_unique(array_slice($out, 0, 20)));
    }

    /** @return string[] */
    public static function emailList($v): array
    {
        $a = is_array($v) ? $v : preg_split('/[\s,;]+/', (string) $v);
        $out = [];
        foreach ($a ?: [] as $x) {
            $x = trim((string) $x);
            if ($x !== '' && filter_var($x, FILTER_VALIDATE_EMAIL)) {
                $out[] = $x;
            }
        }
        return array_values(array_unique(array_slice($out, 0, 30)));
    }

    private static function clip(string $s, int $n): string
    {
        return mb_substr(trim(strip_tags($s)), 0, $n);
    }
}
