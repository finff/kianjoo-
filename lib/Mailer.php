<?php
/**
 * Minimal SMTPS mailer (no Composer). Speaks SMTP over an implicit-TLS socket
 * (port 465) with AUTH LOGIN — enough for cPanel mail. Best-effort: failures
 * are logged, never fatal to the ingest path.
 *
 *   canSend()  SMTP host + username set — enough for send() with explicit recipients
 *   enabled()  system email switch (cfg.enabled, Settings › System email); false
 *              turns every send() into a logged no-op
 *   ready()    canSend() AND enabled() AND a non-empty default recipient list
 *              (cfg.to) — for callers that rely on the default list
 *   status()   '' when ready, else why not (disabled / not configured / no recipients configured)
 *   parseList() comma / semicolon / whitespace separated string or array → valid, deduped e-mails
 *
 * Schemes: smtps (implicit TLS, 465), starttls|tls (587), smtp (plain).
 * A rejected RCPT is logged and skipped; the send fails only when no
 * recipient was accepted ($rejected lists the refused ones).
 *
 * Every send() appends one line to storage/mail.log (or cfg.log):
 *   ts \t ok|fail \t subject \t recipients \t reason
 * The password is never logged. The file rotates to mail.log.1 past ~500 KB.
 * deliver() is the SMTP transport — tests subclass Mailer and override it.
 */

declare(strict_types=1);

class Mailer
{
    public const LOG_MAX_BYTES = 512000;

    protected array $cfg;
    /** Reason of the last failed send ('' after a success). */
    public string $lastError = '';
    /** Recipients refused at RCPT TO by the last send (partial delivery). */
    public array $rejected = [];

    public function __construct(array $mailCfg)
    {
        $this->cfg = $mailCfg + ['host' => '', 'username' => '', 'password' => '', 'port' => 465, 'scheme' => 'smtps',
                                 'from' => '', 'from_name' => 'Kian Joo VisionAI', 'to' => [], 'enabled' => true];
        $this->cfg['to'] = self::parseList($this->cfg['to']);
    }

    /**
     * @param string|array|null $v  "a@x.com, b@y.com; c@z.com" or a list (items may hold several)
     * @return string[] valid addresses, case-insensitively deduped, at most $max
     */
    public static function parseList($v, int $max = 50): array
    {
        $out = [];
        foreach (is_array($v) ? $v : [$v] as $item) {
            if (!is_scalar($item)) {
                continue;
            }
            foreach (preg_split('/[\s,;]+/', (string) $item, -1, PREG_SPLIT_NO_EMPTY) ?: [] as $e) {
                $e = trim($e, " \t<>\"'");
                if ($e !== '' && filter_var($e, FILTER_VALIDATE_EMAIL)) {
                    $out[strtolower($e)] ??= $e;
                }
            }
        }
        return array_slice(array_values($out), 0, max(1, $max));
    }

    public function enabled(): bool
    {
        return ($this->cfg['enabled'] ?? true) !== false;
    }

    /** SMTP transport configured (host + username) — explicit-recipient sends work. */
    public function canSend(): bool
    {
        return (string) $this->cfg['host'] !== '' && (string) $this->cfg['username'] !== '';
    }

    /** Fully configured, switched on, incl. the default recipient list. */
    public function ready(): bool
    {
        return $this->status() === '';
    }

    public function status(): string
    {
        if (!$this->enabled()) {
            return 'disabled';
        }
        if (!$this->canSend()) {
            return 'not configured';
        }
        return $this->cfg['to'] === [] ? 'no recipients configured' : '';
    }

    /** @param string[]|null $to explicit recipients; null/[] = the default list (cfg.to) */
    public function send(string $subject, string $html, ?array $to = null): bool
    {
        $rcpt = self::parseList($to ?: $this->cfg['to'], 100);
        $this->rejected = [];
        if (!$this->enabled()) {
            $err = 'disabled (system email setting is off)';
        } elseif (!$this->canSend()) {
            $err = 'not configured (MAIL_HOST / MAIL_USERNAME)';
        } elseif (!$rcpt) {
            $err = 'no recipients';
        } else {
            try {
                $err = $this->deliver($subject, $html, $rcpt);
            } catch (Throwable $e) {
                $err = 'exception: ' . $e->getMessage();
            }
        }
        $this->lastError = (string) $err;
        $this->log($subject, $rcpt, $err ?? ($this->rejected ? 'partial: rejected ' . implode(',', $this->rejected) : null), $err === null);
        if ($err !== null) {
            error_log('[mailer] ' . $err);
        }
        return $err === null;
    }

    /**
     * SMTP transport. @param string[] $to validated recipients
     * @return string|null null on success, else the failure reason
     */
    protected function deliver(string $subject, string $html, array $to): ?string
    {
        $host = $this->cfg['host'];
        $port = (int) $this->cfg['port'];
        $scheme = strtolower((string) $this->cfg['scheme']);
        $startTls = in_array($scheme, ['starttls', 'tls'], true);
        $remote = ($scheme === 'smtps' || $scheme === 'ssl' ? 'ssl://' : '') . $host . ':' . $port;

        $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'SNI_enabled' => true]]);
        $fp = @stream_socket_client($remote, $errno, $errstr, 12, STREAM_CLIENT_CONNECT, $ctx);
        if (!$fp) {
            return "connect failed: $errno $errstr";
        }
        stream_set_timeout($fp, 12);

        $read = static function () use ($fp): string {
            $out = '';
            while (($line = fgets($fp, 1024)) !== false) {
                $out .= $line;
                if (strlen($line) < 4 || $line[3] !== '-') {
                    break;
                }
            }
            return $out;
        };
        $fail = null;
        // $label is what gets reported — never the base64 credentials themselves.
        $cmd = static function (string $c, array $okCodes, ?string $label = null) use ($fp, $read, &$fail): bool {
            fwrite($fp, $c . "\r\n");
            $resp = $read();
            $code = (int) substr($resp, 0, 3);
            if (!in_array($code, $okCodes, true)) {
                $fail = "'" . ($label ?? $c) . "' → " . trim(substr($resp, 0, 200));
                return false;
            }
            return true;
        };

        // EHLO/Message-ID identify with the sending domain (from MAIL_FROM_ADDRESS),
        // not a hardcoded site — falls back to the SMTP host if "from" has no @.
        $heloDomain = strstr($this->cfg['from'] ?? '', '@') !== false
            ? ltrim(strstr((string) $this->cfg['from'], '@'), '@') : $host;

        try {
            $read(); // banner
            if (!$cmd('EHLO ' . $heloDomain, [250])) {
                return $fail;
            }
            if ($startTls) {
                if (!$cmd('STARTTLS', [220])) {
                    return $fail;
                }
                if (!@stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                    return 'STARTTLS handshake failed';
                }
                if (!$cmd('EHLO ' . $heloDomain, [250])) {
                    return $fail;
                }
            }
            if (!$cmd('AUTH LOGIN', [334])
                || !$cmd(base64_encode($this->cfg['username']), [334], 'AUTH username')
                || !$cmd(base64_encode($this->cfg['password']), [235], 'AUTH password')) {
                return $fail;
            }
            if (!$cmd('MAIL FROM:<' . $this->cfg['from'] . '>', [250])) {
                return $fail;
            }
            // One bad recipient must not sink the rest: skip it, fail only on zero accepted.
            $accepted = [];
            foreach ($to as $rcpt) {
                if ($cmd('RCPT TO:<' . $rcpt . '>', [250, 251])) {
                    $accepted[] = $rcpt;
                } else {
                    $this->rejected[] = $rcpt;
                    error_log('[mailer] recipient rejected: ' . $fail);
                }
            }
            if (!$accepted) {
                return 'no recipient accepted — last: ' . $fail;
            }
            $to = $accepted;
            if (!$cmd('DATA', [354])) {
                return $fail;
            }

            $headers = [
                'From: ' . mb_encode_mimeheader($this->cfg['from_name']) . ' <' . $this->cfg['from'] . '>',
                'To: ' . implode(', ', $to),
                'Subject: ' . mb_encode_mimeheader(str_replace(["\r", "\n"], ' ', $subject)),
                'MIME-Version: 1.0',
                'Content-Type: text/html; charset=UTF-8',
                'Date: ' . date('r'),
                'Message-ID: <' . bin2hex(random_bytes(10)) . '@' . $heloDomain . '>',
            ];
            // Dot-stuff body lines per RFC 5321.
            $body = preg_replace('/^\./m', '..', $html);
            fwrite($fp, implode("\r\n", $headers) . "\r\n\r\n" . $body . "\r\n.\r\n");
            $resp = $read();
            $ok = (int) substr($resp, 0, 3) === 250;
            $cmd('QUIT', [221]);
            return $ok ? null : 'DATA rejected → ' . trim(substr($resp, 0, 200));
        } finally {
            fclose($fp);
        }
    }

    public function logFile(): string
    {
        return (string) ($this->cfg['log'] ?? (dirname(__DIR__) . '/storage/mail.log'));
    }

    /** Last $n lines of the mail log (diagnostics, e.g. /mailtest). */
    public function logTail(int $n = 3): array
    {
        $lines = @file($this->logFile(), FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
        return array_slice($lines, -$n);
    }

    private function log(string $subject, array $to, ?string $err, ?bool $ok = null): void
    {
        try {
            $f = $this->logFile();
            clearstatcache(true, $f);   // long-lived workers: appends don't refresh PHP's stat cache
            if (is_file($f) && (int) @filesize($f) > self::LOG_MAX_BYTES) {
                @rename($f, $f . '.1');
            }
            $clean = static fn (string $s): string => str_replace(["\t", "\r", "\n"], ' ', $s);
            @file_put_contents($f, implode("\t", [
                date('Y-m-d H:i:s'), ($ok ?? $err === null) ? 'ok' : 'fail', $clean(mb_substr($subject, 0, 160)),
                $clean(implode(',', $to) ?: '-'), $clean($err ?? ''),
            ]) . "\n", FILE_APPEND | LOCK_EX);
        } catch (Throwable $e) {
            // logging must never break a send
        }
    }
}
