<?php
/**
 * System e-mail settings (Settings › System email): SMTP account, master
 * switch and default recipients, editable from the app.
 *
 * Overrides live in storage/alert_settings.json — the same overlay the Alert
 * Rules page writes (mail_to, cooldown_min) — under the keys in OVERLAY;
 * .env MAIL_* is the fallback. config.php calls apply() to merge them into
 * $config['mail'] and record where each value came from (mail.source).
 *
 *   apply()  merge the overlay into a mail config (config.php)
 *   save()   validate + persist a POST /mail/settings body
 *   view()   public JSON shape for GET/POST /mail/settings (never the password)
 *   test()   send the test e-mail — shared by /mail/test, /alerts/email-test, /mailtest
 */

declare(strict_types=1);

require_once __DIR__ . '/Mailer.php';

final class MailSettings
{
    /** API field => overlay key. */
    public const OVERLAY = [
        'enabled' => 'mail_enabled', 'host' => 'mail_host', 'port' => 'mail_port', 'scheme' => 'mail_scheme',
        'username' => 'mail_username', 'password' => 'mail_password', 'from_address' => 'mail_from_address',
        'from_name' => 'mail_from_name', 'to' => 'mail_to', 'cooldown_min' => 'cooldown_min',
    ];
    public const SCHEMES    = ['smtps', 'starttls', 'tls', 'smtp'];
    public const MAX_RCPT   = 20;

    public static function file(): string
    {
        return (defined('APP_ROOT') ? APP_ROOT : dirname(__DIR__)) . '/storage/alert_settings.json';
    }

    /** API field => config.mail key. */
    private const CFG = [
        'enabled' => 'enabled', 'host' => 'host', 'port' => 'port', 'scheme' => 'scheme', 'username' => 'username',
        'password' => 'password', 'from_address' => 'from', 'from_name' => 'from_name', 'to' => 'to', 'cooldown_min' => 'cooldown',
    ];

    /** Merge overlay $o into $mail (env defaults); sets $mail['source'][field] = env|override. */
    public static function apply(array $mail, array $o): array
    {
        $src = array_fill_keys(array_keys(self::OVERLAY), 'env');
        foreach (self::OVERLAY as $field => $key) {
            if (!array_key_exists($key, $o)) {
                continue;
            }
            $v = $o[$key];
            switch ($field) {
                case 'enabled':
                    $v = filter_var($v, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE) ?? true;
                    break;
                case 'port':
                    $v = (int) $v;
                    if ($v < 1 || $v > 65535) {
                        continue 2;
                    }
                    break;
                case 'cooldown_min':
                    $v = max(1, min(1440, (int) $v));
                    break;
                case 'to':
                    $v = Mailer::parseList($v, self::MAX_RCPT);
                    if (!$v) {
                        continue 2;   // empty list falls back to .env MAIL_TO
                    }
                    break;
                default:
                    $v = trim((string) $v);
                    if ($v === '') {
                        continue 2;   // blank = use .env
                    }
            }
            $mail[self::CFG[$field]] = $v;
            $src[$field] = 'override';
        }
        $mail['to'] = Mailer::parseList($mail['to'] ?? [], self::MAX_RCPT);
        $mail['source'] = $src;
        return $mail;
    }

    /**
     * Validate + persist a subset of {enabled, host, port, scheme, username, password,
     * from_address, from_name, to, cooldown_min}. Blank host/username/from/name
     * reverts to .env; password absent or '' keeps the stored one.
     * @return string[] `to` entries that were not valid e-mails (dropped)
     * @throws InvalidArgumentException on an invalid host / port / scheme / from address
     */
    public static function save(array $in, ?string $file = null): array
    {
        $file ??= self::file();
        $cur = is_file($file) ? (json_decode((string) file_get_contents($file), true) ?: []) : [];
        $set = [];
        $del = [];
        $ignored = [];
        $str = static fn ($v, int $n): string => mb_substr(trim(str_replace(["\r", "\n"], ' ', (string) $v)), 0, $n);

        if (array_key_exists('enabled', $in)) {
            $set['mail_enabled'] = filter_var($in['enabled'], FILTER_VALIDATE_BOOLEAN);
        }
        if (array_key_exists('host', $in)) {
            $h = strtolower($str($in['host'], 253));
            if ($h !== '' && !preg_match('/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/', $h)) {
                throw new InvalidArgumentException('Invalid SMTP host.');
            }
            if ($h === '') {
                $del[] = 'mail_host';
            } else {
                $set['mail_host'] = $h;
            }
        }
        if (array_key_exists('port', $in) && $in['port'] !== '' && $in['port'] !== null) {
            $p = filter_var($in['port'], FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 65535]]);
            if ($p === false) {
                throw new InvalidArgumentException('SMTP port must be 1–65535.');
            }
            $set['mail_port'] = $p;
        }
        if (array_key_exists('scheme', $in) && $in['scheme'] !== '' && $in['scheme'] !== null) {
            $s = strtolower($str($in['scheme'], 16));
            if (!in_array($s, self::SCHEMES, true)) {
                throw new InvalidArgumentException('SMTP scheme must be one of: ' . implode(', ', self::SCHEMES) . '.');
            }
            $set['mail_scheme'] = $s === 'tls' ? 'starttls' : $s;
        }
        if (array_key_exists('username', $in)) {
            $u = $str($in['username'], 190);
            if ($u === '') {
                $del[] = 'mail_username';
            } else {
                $set['mail_username'] = $u;
            }
        }
        if (isset($in['password']) && (string) $in['password'] !== '') {
            $set['mail_password'] = mb_substr((string) $in['password'], 0, 256);
        }
        if (array_key_exists('from_address', $in)) {
            $f = $str($in['from_address'], 190);
            if ($f !== '' && !filter_var($f, FILTER_VALIDATE_EMAIL)) {
                throw new InvalidArgumentException('Invalid from address.');
            }
            if ($f === '') {
                $del[] = 'mail_from_address';
            } else {
                $set['mail_from_address'] = $f;
            }
        }
        if (array_key_exists('from_name', $in)) {
            $n = $str($in['from_name'], 120);
            if ($n === '') {
                $del[] = 'mail_from_name';
            } else {
                $set['mail_from_name'] = $n;
            }
        }
        if (array_key_exists('to', $in)) {
            $raw = is_array($in['to']) ? $in['to'] : [(string) $in['to']];
            $tokens = [];
            foreach ($raw as $item) {
                foreach (preg_split('/[\s,;]+/', is_scalar($item) ? (string) $item : '', -1, PREG_SPLIT_NO_EMPTY) ?: [] as $t) {
                    $tokens[] = $t;
                }
            }
            $set['mail_to'] = Mailer::parseList($tokens, self::MAX_RCPT);
            $ok = array_map('strtolower', Mailer::parseList($tokens, 1000));
            foreach ($tokens as $t) {
                if (!in_array(strtolower(trim($t, " \t<>\"'")), $ok, true)) {
                    $ignored[] = $t;
                }
            }
        }
        if (array_key_exists('cooldown_min', $in) && $in['cooldown_min'] !== '' && $in['cooldown_min'] !== null) {
            $set['cooldown_min'] = max(1, min(1440, (int) $in['cooldown_min']));
        }

        $merged = array_merge(array_diff_key($cur, array_flip($del)), $set);
        if (!is_dir(dirname($file))) {
            @mkdir(dirname($file), 0775, true);
        }
        if (file_put_contents($file, json_encode($merged, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX) === false) {
            throw new RuntimeException('Could not write ' . basename($file) . '.');
        }
        @chmod($file, 0640);
        return array_values(array_unique($ignored));
    }

    /** GET/POST /mail/settings `settings` object (password never included). */
    public static function view(array $config): array
    {
        $m  = $config['mail'] ?? [];
        $mailer = new Mailer($m);
        $status = $mailer->status();
        return [
            'enabled'      => $mailer->enabled(),
            'host'         => (string) ($m['host'] ?? ''),
            'port'         => (int) ($m['port'] ?? 465),
            'scheme'       => (string) ($m['scheme'] ?? 'smtps'),
            'username'     => (string) ($m['username'] ?? ''),
            'from_address' => (string) ($m['from'] ?? ''),
            'from_name'    => (string) ($m['from_name'] ?? ''),
            'to'           => array_values((array) ($m['to'] ?? [])),
            'cooldown_min' => (int) ($m['cooldown'] ?? 5),
            'password_set' => (string) ($m['password'] ?? '') !== '',
            'ready'        => $status === '',
            'status'       => $status === '' ? 'ready' : $status,
            'alerts_email_enabled' => ($config['alerts']['email_enabled'] ?? true) !== false,
            'source'       => ($m['source'] ?? null) ?: array_fill_keys(array_keys(self::OVERLAY), 'env'),
        ];
    }

    /**
     * Send the test e-mail with the effective config. Bypasses the system
     * switch (so the account can be verified before it is turned on).
     * @param mixed $to explicit recipients (string or list); empty = configured list
     * @return array{ok:bool, sent:bool, to:string[], error?:string, code:int}
     */
    public static function test(array $config, $to = null, string $origin = 'Settings › System email'): array
    {
        require_once __DIR__ . '/EmailTemplate.php';
        $mc = $config['mail'] ?? [];
        $to = Mailer::parseList($to ?? [], self::MAX_RCPT) ?: Mailer::parseList($mc['to'] ?? [], self::MAX_RCPT);
        $mc['to'] = $to;
        $mc['enabled'] = true;
        $mailer = new Mailer($mc);
        if (!$mailer->canSend()) {
            return ['ok' => false, 'sent' => false, 'to' => $to, 'code' => 422,
                    'error' => 'Email not configured — set the SMTP host and username.'];
        }
        if (!$to) {
            return ['ok' => false, 'sent' => false, 'to' => [], 'code' => 422, 'error' => 'No recipients configured.'];
        }
        $esc = $config['escalation'] ?? [];
        $content = EmailTemplate::heading('Email channel is working')
            . EmailTemplate::sub('Test notification from Kian Joo VisionAI (' . $origin . ') — no action is required.')
            . EmailTemplate::rows([
                ['SMTP account', (string) ($mc['username'] ?? '') . ' @ ' . (string) ($mc['host'] ?? '') . ':' . (int) ($mc['port'] ?? 465)],
                ['System email', ($config['mail']['enabled'] ?? true) !== false ? 'on' : 'OFF — alerts will not send until enabled'],
                ['Minimum severity', (string) ($config['alerts']['min_severity'] ?? 'high')],
                ['Escalation workflow', !empty($esc['enabled'])
                    ? ('on · every ' . (int) ($esc['unattended_min'] ?? 5) . ' min unattended') : 'off'],
                ['Email interval', (int) ($mc['cooldown'] ?? 5) . ' min per camera + module'],
                ['Recipients', implode(', ', $to)],
            ])
            . EmailTemplate::buttons([['Open dashboard', EmailTemplate::host() . '/', true]]);
        $ok = $mailer->send('[Kian Joo VisionAI] Test alert — email channel OK',
            EmailTemplate::shell('Email channel test', 'EMAIL CHANNEL TEST', EmailTemplate::COLORS['ok'], $content), $to);
        try {
            require_once __DIR__ . '/Alerting.php';
            Alerting::logSend('email', $ok, 'test', null, implode(',', $to) . ($ok ? '' : ' · ' . $mailer->lastError));
        } catch (Throwable $e) {
        }
        $res = ['ok' => $ok, 'sent' => $ok, 'to' => $to, 'code' => $ok ? 200 : 502];
        if (!$ok) {
            $res['error'] = 'SMTP send failed: ' . ($mailer->lastError ?: 'unknown error');
        } elseif ($mailer->rejected) {
            $res['rejected'] = $mailer->rejected;
        }
        return $res;
    }
}
