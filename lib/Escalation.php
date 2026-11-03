<?php
/**
 * Workstream A — configurable multi-level escalation ("5-minute unattended"
 * workflow).
 *
 * An alert is UNATTENDED while its event is still `open` (not acknowledged or
 * resolved). Every run, each eligible open alert (severity ≥ min_severity,
 * received within max_age_h) older than unattended_min × N minutes that has not
 * yet reached level N is escalated to level N (N = 1..3):
 *   - email to that level's addresses + Telegram to that level's chats
 *   - an `escalation` entry in incident_log ("Auto-escalated to L2 · Safety
 *     Officer — unattended 10 min")
 *   - events.esc_level / esc_at / esc_min updated with a conditional UPDATE, so
 *     concurrent runs (cron + feed piggy-back) never notify twice
 * Acknowledging or resolving the alert stops further escalation.
 *
 * Simulated detections (DEMO… cameras from lib/Simulator.php) escalate in
 * dry-run mode: the level and log entry are written, no message is sent.
 *
 * Runs from /api/report/cron and piggy-backed on feed.php (maybeRun, at most
 * once per 60 s). POST /api/escalation/run {dry_run} runs it on demand.
 */

declare(strict_types=1);

require_once __DIR__ . '/NotifySettings.php';
require_once __DIR__ . '/Alerting.php';
require_once __DIR__ . '/Telegram.php';

final class Escalation
{
    private const LOCK = 'escalation.lock';
    private const LAST = 'escalation_last.json';
    private const BATCH = 400;

    private static function dir(array $config): string
    {
        return dirname((string) ($config['storage']['raw_log'] ?? (dirname(__DIR__) . '/storage/x')));
    }

    /** Rate-limited run for the feed piggy-back (once per $every s, silent on failure). */
    public static function maybeRun(array $config, PDO $pdo, int $every = 60): ?array
    {
        $esc = $config['escalation'] ?? null;
        if (!is_array($esc) || empty($esc['enabled'])) {
            return null;
        }
        $lock = self::dir($config) . '/' . self::LOCK;
        if (is_file($lock) && (time() - (int) @filemtime($lock)) < $every) {
            return null;
        }
        @touch($lock);
        try {
            return self::run($pdo, $config, false);
        } catch (Throwable $e) {
            error_log('[escalation] ' . $e->getMessage());
            return null;
        }
    }

    public static function isSimulated(?string $stream): bool
    {
        return str_starts_with(strtolower((string) $stream), 'demo');
    }

    /**
     * One escalation pass.
     * @return array{enabled:bool, dry_run:bool, ran_at:string, checked:int, escalated:array, pending:array}
     */
    public static function run(PDO $pdo, array $config, bool $dryRun = false): array
    {
        require_once __DIR__ . '/EventStore.php';
        require_once __DIR__ . '/DashboardMapper.php';
        $esc   = $config['escalation'] ?? NotifySettings::load()['escalation'];
        $unit  = max(1, (int) ($esc['unattended_min'] ?? 5));
        $min   = Alerting::SEV_RANK[$esc['min_severity'] ?? 'high'] ?? 2;
        $now   = time();
        $out   = ['enabled' => !empty($esc['enabled']), 'dry_run' => $dryRun, 'ran_at' => date('Y-m-d H:i:s', $now),
                  'unattended_min' => $unit, 'checked' => 0, 'escalated' => [], 'pending' => []];
        if (!$out['enabled'] && !$dryRun) {
            return $out;
        }

        $store = new EventStore($pdo, $config);
        $st = $pdo->prepare(
            "SELECT id, uuid, stream, received_at, esc_level FROM events
             WHERE (status IS NULL OR status = 'open') AND received_at >= :f AND received_at <= :t
               AND uuid IS NOT NULL AND uuid <> ''
             ORDER BY received_at ASC LIMIT " . self::BATCH
        );
        $st->execute([
            'f' => date('Y-m-d H:i:s', $now - (int) ($esc['max_age_h'] ?? 24) * 3600),
            't' => date('Y-m-d H:i:s', $now - $unit * 60),
        ]);
        $upd = $pdo->prepare(
            'UPDATE events SET esc_level = :l, esc_at = :at, esc_min = :m
             WHERE id = :id AND COALESCE(esc_level, 0) < :l2 AND (status IS NULL OR status = \'open\')'
        );
        $pendingRows = [];

        foreach ($st->fetchAll() as $r) {
            $out['checked']++;
            $recv = strtotime((string) $r['received_at']) ?: $now;
            $cur  = (int) ($r['esc_level'] ?? 0);
            $due  = min(NotifySettings::LEVELS, intdiv(max(0, $now - $recv), $unit * 60));
            if ($due <= $cur) {
                if ($cur < NotifySettings::LEVELS && count($pendingRows) < 25) {
                    $pendingRows[] = [$r, $cur, $recv];
                }
                continue;
            }
            $rec = $store->find((string) $r['uuid']);
            if (!$rec || !self::eligible($rec, $min)) {
                continue;
            }
            $inc = DashboardMapper::incident($rec);
            $sim = self::isSimulated($r['stream'] ?? '');
            for ($lv = $cur + 1; $lv <= $due; $lv++) {
                $level   = $esc['levels'][$lv - 1] ?? ['name' => 'L' . $lv, 'emails' => [], 'chats' => [], 'enabled' => true];
                $mins    = $lv * $unit;
                $item = ['uuid' => $inc['id'], 'title' => $inc['title'], 'camera' => $inc['camera'], 'sev' => $inc['sev'],
                         'mod' => $inc['mod'], 'from' => $lv - 1, 'level' => $lv, 'level_name' => $level['name'],
                         'unattended_min' => $mins, 'age_min' => intdiv($now - $recv, 60), 'simulated' => $sim,
                         'email' => null, 'telegram' => null];
                if (!$dryRun) {
                    $upd->execute(['l' => $lv, 'l2' => $lv, 'at' => date('Y-m-d H:i:s'), 'm' => $mins, 'id' => $r['id']]);
                    if ($upd->rowCount() === 0) {
                        break;                           // acknowledged meanwhile, or another run got here first
                    }
                    if ($sim) {
                        $item['email'] = $item['telegram'] = 'simulated';
                    } elseif (!empty($level['enabled'])) {
                        [$item['email'], $item['telegram']] = self::notify($config, $inc, $rec, $lv, $level, $mins);
                    } else {
                        $item['email'] = $item['telegram'] = 'level off';
                    }
                    $store->addLog($inc['id'], 'escalation', 'Escalation engine', 'L' . ($lv - 1), 'L' . $lv,
                        'Auto-escalated to L' . $lv . ' · ' . $level['name'] . ' — unattended ' . $mins . ' min'
                        . ' (' . self::chText('Email', $item['email']) . ' · ' . self::chText('Telegram', $item['telegram']) . ')');
                } else {
                    $item['email']    = $sim ? 'simulated' : (self::emailReady($config, $level['emails']) ? 'would send' : 'not configured');
                    $item['telegram'] = $sim ? 'simulated' : (Telegram::ready($config['telegram'] ?? [], $level['chats']) ? 'would send' : 'not configured');
                }
                $out['escalated'][] = $item;
            }
        }

        // Upcoming escalations (for the "Run escalation check" panel).
        foreach ($pendingRows as [$r, $cur, $recv]) {
            $rec = $store->find((string) $r['uuid']);
            if (!$rec || !self::eligible($rec, $min)) {
                continue;
            }
            $inc = DashboardMapper::incident($rec);
            $next = $cur + 1;
            $out['pending'][] = ['uuid' => $inc['id'], 'title' => $inc['title'], 'camera' => $inc['camera'], 'sev' => $inc['sev'],
                'level' => $cur, 'next' => $next, 'next_name' => $esc['levels'][$next - 1]['name'] ?? ('L' . $next),
                'due_in_s' => max(0, $recv + $next * $unit * 60 - $now), 'simulated' => self::isSimulated($r['stream'] ?? '')];
        }

        if (!$dryRun) {
            $summary = ['ran_at' => $out['ran_at'], 'checked' => $out['checked'], 'escalated' => count($out['escalated']),
                        'items' => array_slice($out['escalated'], -20)];
            @file_put_contents(self::dir($config) . '/' . self::LAST, json_encode($summary, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX);
        }
        return $out;
    }

    /** Last non-dry run summary (Notifications tab). */
    public static function lastRun(array $config): ?array
    {
        $j = json_decode((string) @file_get_contents(self::dir($config) . '/' . self::LAST), true);
        return is_array($j) ? $j : null;
    }

    /** Counts of currently escalated, still-open alerts per level. */
    public static function openByLevel(PDO $pdo): array
    {
        $out = [1 => 0, 2 => 0, 3 => 0];
        try {
            $rows = $pdo->query("SELECT esc_level, COUNT(*) n FROM events WHERE esc_level > 0 AND (status IS NULL OR status = 'open') GROUP BY esc_level")->fetchAll();
            foreach ($rows as $r) {
                $out[(int) $r['esc_level']] = (int) $r['n'];
            }
        } catch (Throwable $e) {
        }
        return $out;
    }

    private static function eligible(array $rec, int $minRank): bool
    {
        $dec = is_array($rec['decoded'] ?? null) ? $rec['decoded'] : [];
        if (in_array($dec['RaVerdict'] ?? '', ['authorized', 'outside_hours'], true)) {
            return false;                                  // logged, not alerted
        }
        $inc = DashboardMapper::incident($rec);
        return (Alerting::SEV_RANK[$inc['sev']] ?? 0) >= $minRank;
    }

    private static function emailReady(array $config, array $to): bool
    {
        $m = $config['mail'] ?? [];
        return $to !== [] && (string) ($m['host'] ?? '') !== '' && (string) ($m['username'] ?? '') !== '';
    }

    private static function chText(string $label, ?string $state): string
    {
        return $label . ' ' . ($state === 'sent' ? '✓' : ($state === 'failed' ? '✗' : ($state ?? '—')));
    }

    /** @return array{0:string,1:string} email state, telegram state: sent|failed|not configured */
    private static function notify(array $config, array $inc, array $rec, int $lv, array $level, int $mins): array
    {
        $loc   = (string) ($config['poc']['cam_locations'][strtolower((string) ($rec['stream'] ?? ''))] ?? '');
        $label = 'L' . $lv . ' ESCALATION · ' . strtoupper($level['name']);
        $lead  = 'Unattended for ' . $mins . ' minutes — no one has acknowledged this alert. It has been escalated to '
            . $level['name'] . ' (level ' . $lv . ' of ' . NotifySettings::LEVELS . ').';
        $host  = self::host();

        $email = 'not configured';
        if (self::emailReady($config, $level['emails'])) {
            try {
                require_once __DIR__ . '/Mailer.php';
                require_once __DIR__ . '/EmailTemplate.php';
                $sevCol = EmailTemplate::sevColor($inc['sev']);
                $banCol = $lv >= 3 ? EmailTemplate::COLORS['critical'] : ($lv === 2 ? EmailTemplate::COLORS['high'] : EmailTemplate::COLORS['brand']);
                $content = EmailTemplate::heading($inc['title'], $banCol)
                    . EmailTemplate::sub(Alerting::modLabel($inc['mod']) . ' alert on camera ' . $inc['camera'] . ' is still OPEN.')
                    . '<div style="margin:0 0 16px;">' . EmailTemplate::chip('L' . $lv . ' · ' . strtoupper($level['name']), $banCol) . ' '
                    . EmailTemplate::chip(strtoupper($inc['sev']), $sevCol) . '</div>'
                    . EmailTemplate::p(htmlspecialchars($lead, ENT_QUOTES, 'UTF-8'))
                    . EmailTemplate::image($inc['image'] ?? null, 'Detection frame · ' . $inc['camera'])
                    . EmailTemplate::rows([
                        ['Escalation level', 'L' . $lv . ' — ' . $level['name'], $banCol],
                        ['Unattended', $mins . ' min'],
                        ['Camera', $inc['camera'] . ($inc['device'] ? ' · ' . $inc['device'] : '')],
                        ['Location', $loc ?: '—'],
                        ['Zone / Policy', $inc['zone'] ?: '—'],
                        ['Severity', strtoupper($inc['sev']), $sevCol],
                        ['Detected', $inc['received'] ?: '—'],
                        ['Ticket', (string) ($inc['ticket'] ?: '—')],
                    ])
                    . EmailTemplate::buttons([['Acknowledge in dashboard', EmailTemplate::host() . '/', true, $banCol]]);
                $html = EmailTemplate::shell($label . ' — ' . $inc['title'], $label, $banCol, $content,
                    'Sent automatically by the Kian Joo VisionAI escalation workflow. Acknowledge the alert to stop further escalation.');
                $mc = $config['mail'];
                $mc['to'] = $level['emails'];
                $ok = (new Mailer($mc))->send('[Kian Joo VisionAI] ' . $label . ' — ' . $inc['title'] . ' @ ' . $inc['camera'], $html, $level['emails']);
                $email = $ok ? 'sent' : 'failed';
                Alerting::logSend('email', $ok, 'escalation', $inc['id'], 'L' . $lv . ' ' . implode(',', $level['emails']), false, self::dir($config));
            } catch (Throwable $e) {
                $email = 'failed';
                error_log('[escalation] mail: ' . $e->getMessage());
            }
        }

        $tg = 'not configured';
        $tgCfg = $config['telegram'] ?? [];
        if (Telegram::ready($tgCfg, $level['chats'])) {
            $text = Alerting::eventText([
                'banner' => '⏫ ' . $label, 'title' => $inc['title'], 'lead' => $lead, 'sev' => $inc['sev'], 'mod' => $inc['mod'],
                'camera' => $inc['camera'], 'location' => $loc, 'zone' => $inc['zone'], 'ticket' => (string) ($inc['ticket'] ?? ''),
                'time' => $inc['received'] ?? '', 'url' => $host,
            ]);
            $r  = Telegram::send($tgCfg, $text, $inc['image'] ?? null, $level['chats']);
            $tg = $r['ok'] ? 'sent' : 'failed';
            Alerting::logSend('telegram', $r['ok'], 'escalation', $inc['id'], 'L' . $lv . ($r['errors'] ? ' ' . implode('; ', $r['errors']) : ''), false, self::dir($config));
        }
        return [$email, $tg];
    }

    private static function host(): string
    {
        if (class_exists('EmailTemplate')) {
            return EmailTemplate::host() . '/';
        }
        require_once __DIR__ . '/EmailTemplate.php';
        return EmailTemplate::host() . '/';
    }
}
