<?php
/**
 * Minimal SMTPS mailer (no Composer). Speaks SMTP over an implicit-TLS socket
 * (port 465) with AUTH LOGIN — enough for cPanel mail. Best-effort: failures
 * are logged, never fatal to the ingest path.
 */

declare(strict_types=1);

final class Mailer
{
    private array $cfg;

    public function __construct(array $mailCfg)
    {
        $this->cfg = $mailCfg;
    }

    public function ready(): bool
    {
        return $this->cfg['host'] !== '' && $this->cfg['username'] !== '' && $this->cfg['to'] !== [];
    }

    /** @param string[] $to */
    public function send(string $subject, string $html, ?array $to = null): bool
    {
        if (!$this->ready()) {
            return false;
        }
        $to = $to ?: $this->cfg['to'];
        $host = $this->cfg['host'];
        $port = $this->cfg['port'];
        $remote = ($this->cfg['scheme'] === 'smtps' ? 'ssl://' : '') . $host . ':' . $port;

        $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'SNI_enabled' => true]]);
        $fp = @stream_socket_client($remote, $errno, $errstr, 12, STREAM_CLIENT_CONNECT, $ctx);
        if (!$fp) {
            error_log("[mailer] connect failed: $errno $errstr");
            return false;
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
        $cmd = static function (string $c, array $okCodes) use ($fp, $read): bool {
            fwrite($fp, $c . "\r\n");
            $resp = $read();
            $code = (int) substr($resp, 0, 3);
            if (!in_array($code, $okCodes, true)) {
                error_log("[mailer] '$c' → $resp");
                return false;
            }
            return true;
        };

        try {
            $read(); // banner
            if (!$cmd('EHLO tm-next-series.weststar-dev.com', [250])) {
                return false;
            }
            if (!$cmd('AUTH LOGIN', [334])
                || !$cmd(base64_encode($this->cfg['username']), [334])
                || !$cmd(base64_encode($this->cfg['password']), [235])) {
                return false;
            }
            if (!$cmd('MAIL FROM:<' . $this->cfg['from'] . '>', [250])) {
                return false;
            }
            foreach ($to as $rcpt) {
                if (!$cmd('RCPT TO:<' . $rcpt . '>', [250, 251])) {
                    return false;
                }
            }
            if (!$cmd('DATA', [354])) {
                return false;
            }

            $headers = [
                'From: ' . mb_encode_mimeheader($this->cfg['from_name']) . ' <' . $this->cfg['from'] . '>',
                'To: ' . implode(', ', $to),
                'Subject: ' . mb_encode_mimeheader($subject),
                'MIME-Version: 1.0',
                'Content-Type: text/html; charset=UTF-8',
                'Date: ' . date('r'),
                'Message-ID: <' . bin2hex(random_bytes(10)) . '@tm-next-series.weststar-dev.com>',
            ];
            // Dot-stuff body lines per RFC 5321.
            $body = preg_replace('/^\./m', '..', $html);
            fwrite($fp, implode("\r\n", $headers) . "\r\n\r\n" . $body . "\r\n.\r\n");
            $resp = $read();
            $ok = (int) substr($resp, 0, 3) === 250;
            $cmd('QUIT', [221]);
            return $ok;
        } finally {
            fclose($fp);
        }
    }
}
