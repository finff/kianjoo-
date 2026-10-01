<?php
/**
 * Insights: historical aggregation, statistical trend forecasting, and
 * LLM-narrated predictions (weststar-ai middleware or the Anthropic API),
 * plus the scheduled email Reporter (daily/weekly/monthly/yearly).
 *
 * Forecast method: per-day detection counts (by module) drive a least-squares
 * linear trend; an hour-of-day profile shapes the next-24h prediction. The LLM
 * layer narrates the numbers — it never invents them.
 */

declare(strict_types=1);

require_once __DIR__ . '/DashboardMapper.php';

final class Insights
{
    /**
     * Aggregate events for the last $days days: daily counts (total + by
     * module), hour-of-day profile, per-camera counts, severity mix.
     */
    public static function aggregate(PDO $pdo, int $days = 14): array
    {
        $days = max(2, min(365, $days));
        $from = date('Y-m-d H:i:s', time() - $days * 86400);
        $stmt = $pdo->prepare(
            'SELECT stream, trigger_image_type, event_type, policy_name, policy_desc,
                    alert_level, decoded_json, received_at
             FROM events WHERE received_at >= :f ORDER BY id DESC LIMIT 5000'
        );
        $stmt->execute(['f' => $from]);

        $daily   = [];  // 'Y-m-d' => ['total'=>n,'fire'=>n,'ppe'=>n,'intr'=>n,'face'=>n]
        $hours   = array_fill(0, 24, 0);
        $byCam   = [];
        $sev     = ['low' => 0, 'medium' => 0, 'high' => 0, 'critical' => 0];
        $byType  = ['fire' => 0, 'ppe' => 0, 'intr' => 0, 'face' => 0];
        $total   = 0;

        foreach ($stmt->fetchAll() as $r) {
            $e = [
                'trigger_image_type' => $r['trigger_image_type'], 'event_type' => $r['event_type'],
                'policy_name' => $r['policy_name'], 'policy_desc' => $r['policy_desc'],
                'alert_level' => $r['alert_level'],
                'decoded' => $r['decoded_json'] ? (json_decode((string) $r['decoded_json'], true) ?: []) : [],
            ];
            $mod = DashboardMapper::modOf($e);
            $sv  = DashboardMapper::sevOf($e, $mod);
            $ts  = strtotime((string) $r['received_at']) ?: time();
            $day = date('Y-m-d', $ts);
            if (!isset($daily[$day])) {
                $daily[$day] = ['total' => 0, 'fire' => 0, 'ppe' => 0, 'intr' => 0, 'face' => 0];
            }
            $daily[$day]['total']++;
            $daily[$day][$mod]++;
            $hours[(int) date('G', $ts)]++;
            $cam = strtoupper((string) ($r['stream'] ?: 'CAM'));
            $byCam[$cam] = ($byCam[$cam] ?? 0) + 1;
            $sev[$sv] = ($sev[$sv] ?? 0) + 1;
            $byType[$mod]++;
            $total++;
        }

        // Fill missing days with zeros so the series is continuous.
        $series = [];
        for ($i = $days - 1; $i >= 0; $i--) {
            $day = date('Y-m-d', time() - $i * 86400);
            $series[] = ['day' => $day] + ($daily[$day] ?? ['total' => 0, 'fire' => 0, 'ppe' => 0, 'intr' => 0, 'face' => 0]);
        }
        arsort($byCam);
        return [
            'days'   => $days,
            'total'  => $total,
            'daily'  => $series,
            'hours'  => $hours,
            'byCam'  => $byCam,
            'sev'    => $sev,
            'byType' => $byType,
        ];
    }

    /**
     * Statistical forecast from the aggregate: least-squares linear trend on
     * daily totals → next-7-day prediction; per-module first-half vs
     * second-half % change; hour-profile-shaped next-24h expectation.
     */
    public static function forecast(array $agg): array
    {
        $totals = array_map(static fn ($d) => $d['total'], $agg['daily']);
        $n = count($totals);

        // Least-squares y = a + b*x over the daily totals.
        $sumX = $sumY = $sumXY = $sumXX = 0.0;
        foreach ($totals as $x => $y) {
            $sumX += $x; $sumY += $y; $sumXY += $x * $y; $sumXX += $x * $x;
        }
        $den = $n * $sumXX - $sumX * $sumX;
        $b   = $den != 0.0 ? ($n * $sumXY - $sumX * $sumY) / $den : 0.0;
        $a   = $n > 0 ? ($sumY - $b * $sumX) / $n : 0.0;

        $next7 = [];
        for ($i = 0; $i < 7; $i++) {
            $next7[] = ['day' => date('Y-m-d', time() + ($i + 1) * 86400),
                        'predicted' => max(0, round($a + $b * ($n + $i), 1))];
        }

        // Per-module momentum: second half vs first half of the window.
        $half = max(1, intdiv($n, 2));
        $trend = [];
        foreach (['total', 'fire', 'ppe', 'intr', 'face'] as $mod) {
            $first = $second = 0;
            foreach ($agg['daily'] as $i => $d) {
                if ($i < $half) { $first += $d[$mod]; } else { $second += $d[$mod]; }
            }
            $trend[$mod] = [
                'first' => $first, 'second' => $second,
                'pct'   => $first > 0 ? (int) round(($second - $first) / $first * 100)
                          : ($second > 0 ? 100 : 0),
            ];
        }

        // Next-24h expectation: tomorrow's predicted total shaped by the
        // observed hour-of-day profile.
        $hourSum = array_sum($agg['hours']) ?: 1;
        $tomorrow = $next7[0]['predicted'];
        $next24 = [];
        foreach ($agg['hours'] as $h => $c) {
            $next24[$h] = round($tomorrow * $c / $hourSum, 2);
        }
        $peakHour = array_keys($agg['hours'], max($agg['hours']))[0] ?? 0;

        return [
            'slopePerDay' => round($b, 3),
            'avgPerDay'   => $n ? round(array_sum($totals) / $n, 1) : 0,
            'next7'       => $next7,
            'next24'      => $next24,
            'trend'       => $trend,
            'peakHour'    => $peakHour,
            'confidence'  => $agg['total'] >= 100 ? 'moderate' : ($agg['total'] >= 20 ? 'low' : 'very low — limited data'),
        ];
    }

    /**
     * LLM-narrated prediction, cached (slow + costly). Source per settings:
     * 'anthropic' → Claude API directly; 'weststar' → weststar-ai middleware
     * analytics review; 'off' → null.
     */
    public static function llmForecast(array $config, array $agg, array $fc): ?array
    {
        $source = $config['ai']['source'] ?? 'weststar';
        if ($source === 'off' || !function_exists('curl_init')) {
            return null;
        }
        $cacheFile = dirname($config['storage']['raw_log']) . '/forecast_llm.json';
        $ttl = 1800; // 30 min — forecasts don't need 5s freshness
        if (is_file($cacheFile) && (time() - filemtime($cacheFile)) < $ttl) {
            $c = json_decode((string) file_get_contents($cacheFile), true);
            if (is_array($c)) {
                return $c;
            }
        }

        $out = $source === 'anthropic'
            ? self::anthropicForecast($config, $agg, $fc)
            : self::weststarForecast($config);

        if ($out !== null) {
            @file_put_contents($cacheFile, json_encode($out, JSON_UNESCAPED_SLASHES));
            return $out;
        }
        // Serve stale on failure.
        if (is_file($cacheFile)) {
            $c = json_decode((string) file_get_contents($cacheFile), true);
            if (is_array($c)) {
                return $c;
            }
        }
        return null;
    }

    /** Claude API (raw HTTP — no Composer on this host). */
    private static function anthropicForecast(array $config, array $agg, array $fc): ?array
    {
        $key = $config['ai']['anthropic_key'] ?? '';
        if ($key === '') {
            return null;
        }
        $model = $config['ai']['anthropic_model'] ?: 'claude-opus-4-8';
        $stats = [
            'window_days'       => $agg['days'],
            'total_detections'  => $agg['total'],
            'daily_series'      => $agg['daily'],
            'hour_of_day_profile' => $agg['hours'],
            'by_module'         => $agg['byType'],
            'by_camera'         => array_slice($agg['byCam'], 0, 8, true),
            'severity_mix'      => $agg['sev'],
            'linear_trend_slope_per_day' => $fc['slopePerDay'],
            'module_momentum_pct'        => $fc['trend'],
            'predicted_next_7_days'      => $fc['next7'],
        ];
        $prompt = "You are the forecasting analyst for a CCTV AI-detection dashboard (fire/smoke, PPE compliance, "
            . "intrusion, face & body analytics) at Kian Joo's plants. Based ONLY on the aggregated detection statistics "
            . "below, produce a short operational forecast. Respond with STRICT JSON, no markdown, shaped exactly as: "
            . '{"summary": "2-3 sentence plain-language forecast of the coming days", '
            . '"risks": ["up to 3 short risk bullets"], "recommendation": "1 sentence operational recommendation", '
            . '"outlook": "rising|stable|falling"}'
            . "\n\nStatistics:\n" . json_encode($stats, JSON_UNESCAPED_SLASHES);

        $body = json_encode([
            'model'      => $model,
            'max_tokens' => 600,
            'messages'   => [['role' => 'user', 'content' => $prompt]],
        ], JSON_UNESCAPED_SLASHES);

        $ch = curl_init('https://api.anthropic.com/v1/messages');
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $body,
            CURLOPT_HTTPHEADER     => [
                'Content-Type: application/json',
                'x-api-key: ' . $key,
                'anthropic-version: 2023-06-01',
            ],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 60,
            CURLOPT_CONNECTTIMEOUT => 6,
        ]);
        $resp = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($code !== 200 || !$resp) {
            error_log('[insights] anthropic HTTP ' . $code . ' ' . substr((string) $resp, 0, 200));
            return null;
        }
        $d = json_decode((string) $resp, true);
        if (($d['stop_reason'] ?? '') === 'refusal') {
            return null;
        }
        $text = '';
        foreach (($d['content'] ?? []) as $blk) {
            if (($blk['type'] ?? '') === 'text') {
                $text .= $blk['text'];
            }
        }
        // The model returns strict JSON; tolerate accidental fences.
        $text = trim(preg_replace('/^```(json)?|```$/m', '', trim($text)) ?? $text);
        $j = json_decode($text, true);
        if (!is_array($j) || empty($j['summary'])) {
            return null;
        }
        return [
            'source'     => 'anthropic · ' . $model,
            'summary'    => (string) $j['summary'],
            'risks'      => array_slice(array_map('strval', (array) ($j['risks'] ?? [])), 0, 3),
            'recommendation' => (string) ($j['recommendation'] ?? ''),
            'outlook'    => in_array($j['outlook'] ?? '', ['rising', 'stable', 'falling'], true) ? $j['outlook'] : 'stable',
            'fetched_at' => date('c'),
        ];
    }

    /** weststar-ai middleware: reuse its 24h analytics LLM review as narrative. */
    private static function weststarForecast(array $config): ?array
    {
        $base = rtrim((string) ($config['ai']['base'] ?? ''), '/');
        if ($base === '') {
            return null;
        }
        $ch = curl_init($base . '/analytics?window=24h');
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20, CURLOPT_CONNECTTIMEOUT => 5]);
        $resp = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($code !== 200 || !$resp) {
            return null;
        }
        $d = json_decode((string) $resp, true);
        $review = is_array($d) ? ($d['llm_review'] ?? null) : null;
        if (!$review) {
            return null;
        }
        return [
            'source'     => 'weststar-ai',
            'summary'    => (string) $review,
            'risks'      => [],
            'recommendation' => '',
            'outlook'    => 'stable',
            'fetched_at' => date('c'),
        ];
    }
}

/**
 * Scheduled email reports. Poor-man's cron: maybeSend() is invoked on feed
 * polls (throttled) and from GET /api/report/cron for a real cron entry.
 */
final class Reporter
{
    /** SLA targets in minutes per severity: time-to-ack / time-to-resolve. */
    public const SLA = [
        'critical' => ['ack' => 5,   'resolve' => 60],
        'high'     => ['ack' => 15,  'resolve' => 240],
        'medium'   => ['ack' => 60,  'resolve' => 480],
        'low'      => ['ack' => 240, 'resolve' => 1440],
    ];

    /**
     * On-demand incident report (daily / weekly / monthly): ticket table,
     * status + severity mix, MTTA/MTTR, SLA compliance. Emailed to the report
     * recipients.
     */
    public static function incidents(array $config, PDO $pdo, string $period = 'weekly'): bool
    {
        $days = ['daily' => 1, 'weekly' => 7, 'monthly' => 30][$period] ?? 7;
        $from = date('Y-m-d H:i:s', time() - $days * 86400);
        $stmt = $pdo->prepare('SELECT * FROM events WHERE received_at >= :f ORDER BY id DESC LIMIT 500');
        $stmt->execute(['f' => $from]);

        require_once __DIR__ . '/DashboardMapper.php';
        $rows = [];
        $byStatus = ['open' => 0, 'ack' => 0, 'resolved' => 0];
        $bySev = ['critical' => 0, 'high' => 0, 'medium' => 0, 'low' => 0];
        $ackSecs = [];
        $resSecs = [];
        $slaOk = 0;
        $slaTot = 0;
        $now = time() * 1000;
        foreach ($stmt->fetchAll() as $r) {
            // hydrate minimal fields for the mapper
            foreach (['detect_json' => 'detect', 'attributes_json' => 'attributes', 'decoded_json' => 'decoded'] as $col => $out) {
                $r[$out] = !empty($r[$col]) ? (json_decode((string) $r[$col], true) ?: null) : null;
            }
            $r['images'] = [];
            $i = DashboardMapper::incident($r);
            $byStatus[$i['status']] = ($byStatus[$i['status']] ?? 0) + 1;
            $bySev[$i['sev']] = ($bySev[$i['sev']] ?? 0) + 1;
            if ($i['ackedTs'] && $i['ts']) {
                $ackSecs[] = max(0, ($i['ackedTs'] - $i['ts']) / 1000);
            }
            if ($i['resolvedTs'] && $i['ts']) {
                $resSecs[] = max(0, ($i['resolvedTs'] - $i['ts']) / 1000);
            }
            $sla = self::SLA[$i['sev']] ?? self::SLA['low'];
            $slaTot++;
            $end = $i['resolvedTs'] ?: $now;
            if (($end - $i['ts']) / 60000 <= $sla['resolve']) {
                $slaOk++;
            }
            $elapsedMin = (int) round((($i['resolvedTs'] ?: $now) - $i['ts']) / 60000);
            $rows[] = [$i['ticket'] ?: '—', strtoupper($i['sev']), $i['title'], $i['camera'] . ' · ' . $i['zone'],
                       $i['status'], $i['received'], $elapsedMin . 'm'];
        }
        $fmt = static fn (array $a) => $a ? sprintf('%d:%02d', intdiv((int) (array_sum($a) / count($a)), 60), ((int) (array_sum($a) / count($a))) % 60) : '—';

        $tr = '';
        foreach (array_slice($rows, 0, 60) as $r) {
            $tr .= '<tr>' . implode('', array_map(static fn ($c) => '<td style="padding:4px 8px;border-bottom:1px solid #eee;font-size:12.5px">' . htmlspecialchars((string) $c) . '</td>', $r)) . '</tr>';
        }
        require_once __DIR__ . '/EmailTemplate.php';
        $html = EmailTemplate::heading(ucfirst($period) . ' Incident Report')
            . EmailTemplate::sub('Window: last ' . $days . ' day(s) · generated ' . date('Y-m-d H:i') . ' MYT')
            . '<table style="font-size:13.5px;border-collapse:collapse;margin-bottom:12px">'
            . '<tr><td style="padding:3px 12px 3px 0;color:#666">Detections</td><td><b>' . count($rows) . '</b></td>'
            . '<td style="padding:3px 12px;color:#666">Open</td><td><b>' . $byStatus['open'] . '</b></td>'
            . '<td style="padding:3px 12px;color:#666">Ack</td><td><b>' . $byStatus['ack'] . '</b></td>'
            . '<td style="padding:3px 12px;color:#666">Resolved</td><td><b>' . $byStatus['resolved'] . '</b></td></tr>'
            . '<tr><td style="padding:3px 12px 3px 0;color:#666">MTTA</td><td><b>' . $fmt($ackSecs) . '</b></td>'
            . '<td style="padding:3px 12px;color:#666">MTTR</td><td><b>' . $fmt($resSecs) . '</b></td>'
            . '<td style="padding:3px 12px;color:#666">SLA met</td><td colspan="3"><b>' . ($slaTot ? (int) round($slaOk / $slaTot * 100) : 100) . '%</b></td></tr>'
            . '<tr><td style="padding:3px 12px 3px 0;color:#666">Critical / High</td><td><b>' . $bySev['critical'] . ' / ' . $bySev['high'] . '</b></td>'
            . '<td style="padding:3px 12px;color:#666">Medium / Low</td><td colspan="5"><b>' . $bySev['medium'] . ' / ' . $bySev['low'] . '</b></td></tr></table>'
            . '<table style="border-collapse:collapse;width:100%"><tr>'
            . implode('', array_map(static fn ($h) => '<th style="text-align:left;padding:4px 8px;border-bottom:2px solid #ccc;font-size:11px;color:#666">' . $h . '</th>',
                ['TICKET', 'SEV', 'INCIDENT', 'CAMERA', 'STATUS', 'DETECTED', 'ELAPSED']))
            . '</tr>' . $tr . '</table>'
            . '<div style="margin-top:18px">' . EmailTemplate::buttons([['Open Incidents Board', EmailTemplate::host() . '/', true]]) . '</div>';
        $html = EmailTemplate::shell(
            ucfirst($period) . ' incident report — ' . count($rows) . ' detections, ' . $byStatus['open'] . ' open',
            strtoupper($period) . ' INCIDENT REPORT', EmailTemplate::COLORS['brand'], $html,
            'Scheduled report from <b>AIVA Dashboard Monitoring</b>. Adjust frequency and recipients under <b>Settings &rsaquo; Auto Reports</b>.'
        );

        require_once __DIR__ . '/Mailer.php';
        $to = $config['reports']['recipients'] ?: ($config['mail']['to'] ?? []);
        if (empty($config['mail']['host']) || !$to) {
            return false;
        }
        try {
            return (new Mailer($config['mail']))->send('[AIVA Dashboard] ' . ucfirst($period) . ' incident report — ' . date('Y-m-d'), $html, $to);
        } catch (Throwable $e) {
            error_log('[reporter] ' . $e->getMessage());
            return false;
        }
    }

    /** Period key for the configured frequency — one report per period. */
    private static function periodKey(string $freq): string
    {
        return match ($freq) {
            'daily'   => date('Y-m-d'),
            'weekly'  => date('o-\WW'),
            'monthly' => date('Y-m'),
            'yearly'  => date('Y'),
            default   => '',
        };
    }

    private static function windowDays(string $freq): int
    {
        return match ($freq) {
            'daily' => 1, 'weekly' => 7, 'monthly' => 30, 'yearly' => 365, default => 7,
        };
    }

    /** Send if a report is due (frequency on, past send-hour, not yet sent this period). */
    public static function maybeSend(array $config, PDO $pdo): bool
    {
        $freq = $config['reports']['frequency'] ?? 'off';
        if ($freq === 'off') {
            return false;
        }
        $stateFile = dirname($config['storage']['raw_log']) . '/report_last.json';
        // Throttle the check itself to once per minute (feed polls every 5s).
        $throttle = dirname($config['storage']['raw_log']) . '/report_check.lock';
        if (is_file($throttle) && (time() - (int) filemtime($throttle)) < 60) {
            return false;
        }
        @touch($throttle);

        if ((int) date('G') < ($config['reports']['hour'] ?? 8)) {
            return false;
        }
        $key   = self::periodKey($freq);
        $state = is_file($stateFile) ? (json_decode((string) file_get_contents($stateFile), true) ?: []) : [];
        if (($state['period'] ?? '') === $freq . ':' . $key) {
            return false;
        }
        $ok = self::send($config, $pdo, $freq);
        if ($ok) {
            @file_put_contents($stateFile, json_encode([
                'period' => $freq . ':' . $key, 'sent_at' => date('c'),
            ]));
        }
        return $ok;
    }

    /** Build and email the report now (also used by the "Send now" button). */
    public static function send(array $config, PDO $pdo, ?string $freq = null): bool
    {
        $freq  = $freq ?: (($config['reports']['frequency'] ?? 'off') !== 'off' ? $config['reports']['frequency'] : 'weekly');
        $days  = self::windowDays($freq);
        $agg   = Insights::aggregate($pdo, max(2, $days));
        $fc    = Insights::forecast($agg);
        $llm   = Insights::llmForecast($config, $agg, $fc);
        $label = ucfirst($freq);

        require_once __DIR__ . '/EmailTemplate.php';
        $rows = static function (array $kv): string {
            return EmailTemplate::rows(array_map(
                static fn ($k, $v) => [(string) $k, (string) $v],
                array_keys($kv), array_values($kv)
            ));
        };
        $section = static fn (string $t) => '<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;'
            . 'font-weight:bold;letter-spacing:1.5px;color:#868DA8;margin:16px 0 4px;">' . strtoupper($t) . '</div>';
        $modLabels = ['fire' => 'Fire & Smoke', 'ppe' => 'PPE', 'intr' => 'Intrusion', 'face' => 'Face & Body'];
        $byType = [];
        foreach ($modLabels as $k => $lbl) {
            $byType[$lbl] = $agg['byType'][$k] ?? 0;
        }
        $trendRows = [];
        foreach ($modLabels as $k => $lbl) {
            $p = $fc['trend'][$k]['pct'] ?? 0;
            $trendRows[$lbl] = ($p > 0 ? '▲ +' : ($p < 0 ? '▼ ' : '— ')) . $p . '%';
        }
        $cams = [];
        foreach (array_slice($agg['byCam'], 0, 5, true) as $cam => $c) {
            $cams[$cam] = $c;
        }

        $html = EmailTemplate::heading($label . ' Detection Report')
            . EmailTemplate::sub('Window: last ' . $days . ' day(s) · generated ' . date('Y-m-d H:i') . ' MYT')
            . $section('Detections')
            . $rows(['Total detections' => $agg['total'], 'Avg / day' => $fc['avgPerDay'], 'Peak hour' => sprintf('%02d:00', $fc['peakHour'])] + $byType)
            . $section('Severity mix')
            . $rows($agg['sev'])
            . $section('Top cameras')
            . $rows($cams)
            . $section('Trend & forecast')
            . $rows(['Momentum (2nd half vs 1st)' => ($fc['trend']['total']['pct'] >= 0 ? '+' : '') . $fc['trend']['total']['pct'] . '%',
                     'Predicted tomorrow' => $fc['next7'][0]['predicted'] . ' detections',
                     'Confidence' => $fc['confidence']] + $trendRows)
            . ($llm ? ($section('AI outlook · ' . $llm['source'])
                . EmailTemplate::p(htmlspecialchars($llm['summary']))
                . ($llm['risks'] ? '<ul style="font-family:Arial,Helvetica,sans-serif;font-size:12.5px;color:#33394F;line-height:1.7;margin:0 0 12px;padding-left:20px">'
                    . implode('', array_map(static fn ($r) => '<li>' . htmlspecialchars($r) . '</li>', $llm['risks'])) . '</ul>' : '')
                . ($llm['recommendation'] ? EmailTemplate::note($llm['recommendation'], 'RECOMMENDATION') : '')) : '')
            . '<div style="margin-top:18px">' . EmailTemplate::buttons([
                ['Open Dashboard', EmailTemplate::host() . '/', true],
                ['Forecasting', EmailTemplate::host() . '/', false],
            ]) . '</div>';
        $html = EmailTemplate::shell(
            $label . ' detection report — ' . $agg['total'] . ' detections in the last ' . $days . ' day(s)',
            strtoupper($label) . ' DETECTION REPORT', EmailTemplate::COLORS['brand'], $html,
            'Scheduled report from <b>AIVA Dashboard Monitoring</b>. Adjust frequency and recipients under <b>Settings &rsaquo; Auto Reports</b>.'
        );

        require_once __DIR__ . '/Mailer.php';
        $mailCfg = $config['mail'];
        $to = $config['reports']['recipients'] ?: ($mailCfg['to'] ?? []);
        if (empty($mailCfg['host']) || !$to) {
            return false;
        }
        try {
            return (new Mailer($mailCfg))->send('[AIVA Dashboard] ' . $label . ' detection report — ' . date('Y-m-d'), $html, $to);
        } catch (Throwable $e) {
            error_log('[reporter] ' . $e->getMessage());
            return false;
        }
    }
}
