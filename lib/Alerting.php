<?php
/**
 * Workstream A — shared alerting helpers used by EventStore::notifyIfSevere(),
 * the /events/{uuid}/notify escalation route and lib/Escalation.php:
 *
 *   matchCondition()  predefined condition rules (module / camera / severity /
 *                     time window / keyword) that make a detection alert in
 *                     real time even below the global minimum severity
 *   eventText()       Telegram (HTML parse-mode) message for a detection
 *   logSend()         delivery log (storage/notify_log.json, last 400 sends)
 *   sendStats()       counters per channel for the Notifications tab / POC
 */

declare(strict_types=1);

final class Alerting
{
    public const SEV_RANK = ['low' => 0, 'medium' => 1, 'high' => 2, 'critical' => 3];
    private const LOG_MAX = 400;

    public static function modLabel(string $mod): string
    {
        return ['fire' => 'FIRE & SMOKE', 'ppe' => 'PPE', 'intr' => 'INTRUSION', 'face' => 'FACE & BODY',
                'forklift' => 'FORKLIFT', 'behaviour' => 'BEHAVIOUR'][$mod] ?? strtoupper($mod);
    }

    /**
     * First enabled condition rule matching this detection, or null.
     * $text is searched for the rule keyword (policy name, title, trigger type).
     */
    public static function matchCondition(array $conds, string $mod, string $sev, string $stream, string $text): ?array
    {
        require_once __DIR__ . '/DashboardMapper.php';
        $stream = strtolower($stream);
        foreach ($conds as $c) {
            if (!is_array($c) || empty($c['enabled'])) {
                continue;
            }
            if (($c['mod'] ?? 'any') !== 'any' && $c['mod'] !== $mod) {
                continue;
            }
            if (($c['camera'] ?? '') !== '' && $c['camera'] !== $stream) {
                continue;
            }
            if ((self::SEV_RANK[$sev] ?? 0) < (self::SEV_RANK[$c['min_sev'] ?? 'low'] ?? 0)) {
                continue;
            }
            if (!DashboardMapper::armedNow((string) ($c['window'] ?? 'always'))) {
                continue;
            }
            $kw = trim((string) ($c['keyword'] ?? ''));
            if ($kw !== '' && stripos($text, $kw) === false) {
                continue;
            }
            return $c;
        }
        return null;
    }

    /** Telegram message (HTML parse mode) for one detection / escalation. */
    public static function eventText(array $f): string
    {
        require_once __DIR__ . '/Telegram.php';
        $e = static fn ($v) => Telegram::esc((string) $v);
        $icon = ['critical' => '🔴', 'high' => '🟠', 'medium' => '🟡', 'low' => '🔵'][$f['sev'] ?? ''] ?? '⚪';
        $lines = [];
        $lines[] = $icon . ' <b>' . $e($f['banner'] ?? (strtoupper((string) ($f['sev'] ?? '')) . ' ' . self::modLabel((string) ($f['mod'] ?? '')))) . '</b>';
        $lines[] = '<b>' . $e($f['title'] ?? 'Detection') . '</b>';
        if (!empty($f['lead'])) {
            $lines[] = $e($f['lead']);
        }
        $lines[] = '';
        foreach ([
            'Camera'   => $f['camera'] ?? '',
            'Location' => $f['location'] ?? '',
            'Zone'     => $f['zone'] ?? '',
            'Person'   => $f['person'] ?? '',
            'Severity' => isset($f['sev']) ? strtoupper((string) $f['sev']) : '',
            'Rule'     => $f['rule'] ?? '',
            'Ticket'   => $f['ticket'] ?? '',
            'Time'     => $f['time'] ?? '',
        ] as $k => $v) {
            if ((string) $v !== '' && $v !== '—') {
                $lines[] = $k . ': <code>' . $e($v) . '</code>';
            }
        }
        if (!empty($f['note'])) {
            $lines[] = '';
            $lines[] = '📝 ' . $e($f['note']);
        }
        if (!empty($f['url'])) {
            $lines[] = '';
            $lines[] = '<a href="' . $e($f['url']) . '">Open Kian Joo VisionAI dashboard</a>';
        }
        return implode("\n", $lines);
    }

    // ── Delivery log ─────────────────────────────────────────

    public static function logFile(?string $dir = null): string
    {
        return ($dir ?? (dirname(__DIR__) . '/storage')) . '/notify_log.json';
    }

    /**
     * @param string $channel email|telegram
     * @param string $kind    alert|escalation|manual|test
     */
    public static function logSend(string $channel, bool $ok, string $kind, ?string $uuid, string $note = '', bool $simulated = false, ?string $dir = null): void
    {
        try {
            $file = self::logFile($dir);
            $fp = @fopen($file, 'c+');
            if (!$fp) {
                return;
            }
            flock($fp, LOCK_EX);
            $raw  = stream_get_contents($fp);
            $list = json_decode((string) $raw, true);
            $list = is_array($list) ? $list : [];
            $list[] = ['at' => date('Y-m-d H:i:s'), 'channel' => $channel, 'ok' => $ok, 'kind' => $kind,
                       'uuid' => $uuid, 'note' => mb_substr($note, 0, 200), 'sim' => $simulated];
            if (count($list) > self::LOG_MAX) {
                $list = array_slice($list, -self::LOG_MAX);
            }
            ftruncate($fp, 0);
            rewind($fp);
            fwrite($fp, json_encode($list, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
            fflush($fp);
            flock($fp, LOCK_UN);
            fclose($fp);
        } catch (Throwable $e) {
            error_log('[notify-log] ' . $e->getMessage());
        }
    }

    public static function recent(int $n = 20, ?string $dir = null): array
    {
        $list = json_decode((string) @file_get_contents(self::logFile($dir)), true);
        return is_array($list) ? array_reverse(array_slice($list, -$n)) : [];
    }

    /** Counts per channel (all-time within the capped log and last 24 h). */
    public static function sendStats(?string $dir = null): array
    {
        $list = json_decode((string) @file_get_contents(self::logFile($dir)), true);
        $out = [];
        $since = date('Y-m-d H:i:s', time() - 86400);
        foreach (['email', 'telegram'] as $ch) {
            $out[$ch] = ['sent' => 0, 'failed' => 0, 'sent24h' => 0, 'escalations' => 0, 'last_ok' => null, 'last_error' => null];
        }
        foreach (is_array($list) ? $list : [] as $r) {
            $ch = (string) ($r['channel'] ?? '');
            if (!isset($out[$ch]) || !empty($r['sim'])) {
                continue;
            }
            if (!empty($r['ok'])) {
                $out[$ch]['sent']++;
                $out[$ch]['last_ok'] = $r['at'] ?? null;
                if (($r['at'] ?? '') >= $since) {
                    $out[$ch]['sent24h']++;
                }
                if (($r['kind'] ?? '') === 'escalation') {
                    $out[$ch]['escalations']++;
                }
            } else {
                $out[$ch]['failed']++;
                $out[$ch]['last_error'] = trim(($r['at'] ?? '') . ' ' . ($r['note'] ?? ''));
            }
        }
        return $out;
    }
}
