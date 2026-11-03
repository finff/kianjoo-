<?php
/**
 * Workstream A — Telegram Bot API channel (sendMessage / sendPhoto).
 *
 * Best-effort: curl with a 5 s timeout, never throws to the caller. Every
 * delivery attempt is appended to storage/notify_log.json (via Alerting::logSend)
 * so the Notifications tab / POC scorecard can show live channel evidence.
 *
 * Config ($config['telegram'], see NotifySettings):
 *   enabled, bot_token, chat_ids[], send_photo, api_base
 */

declare(strict_types=1);

final class Telegram
{
    private const TIMEOUT = 5;

    /** Channel is usable: switched on, a token and at least one target chat. */
    public static function ready(array $tg, ?array $chats = null): bool
    {
        return !empty($tg['enabled']) && (string) ($tg['bot_token'] ?? '') !== ''
            && ($chats ?? ($tg['chat_ids'] ?? [])) !== [];
    }

    /**
     * Send one alert to every chat. Uses sendPhoto (caption) when an image URL is
     * publicly reachable over http(s) and send_photo is on, falling back to a
     * text message if Telegram cannot fetch the photo.
     *
     * @param string[]|null $chats override target chats (escalation levels)
     * @return array{ok:bool, sent:int, failed:int, errors:string[]}
     */
    public static function send(array $tg, string $html, ?string $imageUrl = null, ?array $chats = null): array
    {
        $chats = $chats ?? ($tg['chat_ids'] ?? []);
        $res = ['ok' => false, 'sent' => 0, 'failed' => 0, 'errors' => []];
        $token = (string) ($tg['bot_token'] ?? '');
        if ($token === '' || $chats === [] || !function_exists('curl_init')) {
            $res['errors'][] = $token === '' ? 'no bot token' : ($chats === [] ? 'no chat id' : 'php-curl missing');
            return $res;
        }
        $base  = rtrim((string) ($tg['api_base'] ?? 'https://api.telegram.org'), '/') . '/bot' . $token;
        $photo = !empty($tg['send_photo']) && self::publicImage($imageUrl);
        foreach ($chats as $chat) {
            $r = null;
            if ($photo) {
                $r = self::call($base . '/sendPhoto', [
                    'chat_id' => $chat, 'photo' => $imageUrl,
                    'caption' => self::cut($html, 1000), 'parse_mode' => 'HTML',
                ]);
            }
            // Fall back to text only when Telegram answered (e.g. it could not
            // fetch the photo) — not after a network failure, to bound latency.
            if ($r === null || (!$r['ok'] && empty($r['net']))) {
                $r = self::call($base . '/sendMessage', [
                    'chat_id' => $chat, 'text' => self::cut($html, 4000), 'parse_mode' => 'HTML',
                    'disable_web_page_preview' => $imageUrl === null || $imageUrl === '' ? 'true' : 'false',
                ]);
            }
            if ($r['ok']) {
                $res['sent']++;
            } else {
                $res['failed']++;
                $res['errors'][] = $chat . ': ' . $r['error'];
            }
        }
        $res['ok'] = $res['sent'] > 0;
        return $res;
    }

    /** getMe — validates the token (used by the test button). */
    public static function whoami(array $tg): array
    {
        $token = (string) ($tg['bot_token'] ?? '');
        if ($token === '') {
            return ['ok' => false, 'error' => 'no bot token'];
        }
        $r = self::call(rtrim((string) ($tg['api_base'] ?? 'https://api.telegram.org'), '/') . '/bot' . $token . '/getMe', []);
        return $r['ok'] ? ['ok' => true, 'username' => (string) ($r['result']['username'] ?? '')] : ['ok' => false, 'error' => $r['error']];
    }

    /** Escape user/content text for Telegram's HTML parse mode. */
    public static function esc(string $s): string
    {
        return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }

    private static function publicImage(?string $url): bool
    {
        if ($url === null || !preg_match('#^https?://([^/:]+)#i', $url, $m)) {
            return false;
        }
        $h = strtolower($m[1]);
        if ($h === 'localhost' || str_ends_with($h, '.local')) {
            return false;
        }
        // Private / loopback IPs are not fetchable by Telegram's servers.
        if (filter_var($h, FILTER_VALIDATE_IP)) {
            return (bool) filter_var($h, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE);
        }
        return true;
    }

    /** Trim to $n chars without leaving a dangling HTML tag / entity. */
    private static function cut(string $s, int $n): string
    {
        if (mb_strlen($s) <= $n) {
            return $s;
        }
        $s = mb_substr(strip_tags($s), 0, $n - 1);
        return htmlspecialchars(html_entity_decode($s, ENT_QUOTES, 'UTF-8'), ENT_NOQUOTES, 'UTF-8') . '…';
    }

    /** @return array{ok:bool, error:string, result:mixed} */
    private static function call(string $url, array $fields): array
    {
        try {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_POST           => true,
                CURLOPT_POSTFIELDS     => http_build_query($fields),
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT        => self::TIMEOUT,
                CURLOPT_CONNECTTIMEOUT => 3,
            ]);
            $body = curl_exec($ch);
            $err  = curl_error($ch);
            $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);
            if ($body === false || $err !== '') {
                return ['ok' => false, 'error' => $err ?: 'request failed', 'result' => null, 'net' => true];
            }
            $j = json_decode((string) $body, true);
            if (!is_array($j) || empty($j['ok'])) {
                // Never echo the token: descriptions come from Telegram, the URL isn't included.
                return ['ok' => false, 'error' => 'HTTP ' . $code . ' ' . (is_array($j) ? (string) ($j['description'] ?? '') : 'bad response'), 'result' => null];
            }
            return ['ok' => true, 'error' => '', 'result' => $j['result'] ?? null];
        } catch (Throwable $e) {
            return ['ok' => false, 'error' => $e->getMessage(), 'result' => null, 'net' => true];
        }
    }
}
