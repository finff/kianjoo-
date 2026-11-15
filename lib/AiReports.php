<?php
/**
 * M12 — on-demand AI reports.
 *
 * The data context is built ONLY through AiTools fetchers the caller is allowed
 * to use, so a staff member's report contains only their own attendance /
 * leave / tickets, a supervisor's adds team attendance, approvals and tickets,
 * and only admins get detections / PPE-forklift / camera data.
 *
 * Scopes:  personal       own data (forced for staff tier)
 *          standard       Sonnet over everything the role may read
 *          comprehensive  Opus deep synthesis (supervisor+ with `reports` perm)
 *
 * Output is a structured JSON report (persisted in ai_reports + storage/reports/
 * as .json and .md). pdf() renders the stored JSON through a corporate print
 * template (cover, document control, numbered sections, sign-off) with the
 * vendored dompdf (lib/pdf/dompdf) → storage/reports/{id}.v2.pdf (cached).
 *
 * Provider-neutral: the model call goes through Llm::structured() — no vendor
 * wire format here.
 */

declare(strict_types=1);

require_once __DIR__ . '/Llm.php';
require_once __DIR__ . '/AiTools.php';
require_once __DIR__ . '/pdf/ReportCharts.php';

final class AiReports
{
    public const SCOPES = ['personal', 'standard', 'comprehensive'];
    private const MAX_DAYS = 92;
    private const PDF_TEMPLATE = 'v2';
    private const PER_HOUR = ['staff' => 4, 'supervisor' => 10, 'admin' => 20];

    private const SCHEMA = [
        'type' => 'object',
        'properties' => [
            'title'             => ['type' => 'string'],
            'executive_summary' => ['type' => 'string'],
            'sections' => ['type' => 'array', 'items' => [
                'type' => 'object',
                'properties' => [
                    'key'        => ['type' => 'string'],
                    'title'      => ['type' => 'string'],
                    'summary'    => ['type' => 'string'],
                    'metrics'    => ['type' => 'array', 'items' => ['type' => 'object',
                        'properties' => ['label' => ['type' => 'string'], 'value' => ['type' => 'string']],
                        'required' => ['label', 'value'], 'additionalProperties' => false]],
                    'highlights' => ['type' => 'array', 'items' => ['type' => 'string']],
                    'risks'      => ['type' => 'array', 'items' => ['type' => 'string']],
                ],
                'required' => ['key', 'title', 'summary', 'metrics', 'highlights', 'risks'],
                'additionalProperties' => false,
            ]],
            'recommendations' => ['type' => 'array', 'items' => ['type' => 'string']],
            'data_gaps'       => ['type' => 'array', 'items' => ['type' => 'string']],
        ],
        'required' => ['title', 'executive_summary', 'sections', 'recommendations', 'data_gaps'],
        'additionalProperties' => false,
    ];

    private string $dir;

    public function __construct(private PDO $pdo, private array $config)
    {
        $this->dir = (string) ($config['ai']['storage_dir'] ?? dirname(__DIR__) . '/storage');
    }

    /** Normalise {range} to [from, to] dates. Accepts "7d", "today", "month", or {from,to}. */
    public static function range($range): array
    {
        $today = date('Y-m-d');
        if (is_array($range)) {
            $from = (string) ($range['from'] ?? '');
            $to   = (string) ($range['to'] ?? $today);
        } else {
            $r = strtolower(trim((string) $range));
            if ($r === 'today' || $r === '1d') {
                return [$today, $today];
            }
            if ($r === 'month') {
                return [date('Y-m-01'), $today];
            }
            $n = preg_match('/^(\d{1,3})d$/', $r, $m) ? (int) $m[1] : 7;
            $from = date('Y-m-d', time() - (max(1, $n) - 1) * 86400);
            $to   = $today;
        }
        $ok = static fn ($d) => preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) && strtotime($d);
        $to   = $ok($to) ? $to : $today;
        $from = $ok($from) ? $from : date('Y-m-d', strtotime($to) - 6 * 86400);
        if ($from > $to) {
            [$from, $to] = [$to, $from];
        }
        if ($to > $today) {
            $to = $today;
        }
        if (strtotime($to) - strtotime($from) > (self::MAX_DAYS - 1) * 86400) {
            $from = date('Y-m-d', strtotime($to) - (self::MAX_DAYS - 1) * 86400);
        }
        return [$from, $to];
    }

    /** Resolve the effective scope for a principal (403-style message on refusal). */
    public static function scopeFor(array $p, string $scope): array
    {
        $scope = in_array($scope, self::SCOPES, true) ? $scope : 'standard';
        if (!AiGuard::atLeast($p, 'supervisor')) {
            return ['personal', null];
        }
        if ($scope === 'comprehensive' && !AiGuard::can($p, 'reports')) {
            return [null, 'Comprehensive reports need the reports permission.'];
        }
        return [$scope, null];
    }

    /** @return array{ok:bool, report?:array, error?:string, status?:int} */
    public function generate(array $p, $range, string $scope): array
    {
        [$scope, $why] = self::scopeFor($p, $scope);
        if ($scope === null) {
            return ['ok' => false, 'error' => $why, 'status' => 403];
        }
        $limit = self::PER_HOUR[$p['tier']] ?? 4;
        $st = $this->pdo->prepare('SELECT COUNT(*) FROM ai_reports WHERE user_id = :u AND created_at >= :f');
        $st->execute(['u' => (int) $p['id'], 'f' => date('Y-m-d H:i:s', time() - 3600)]);
        if (!$p['provision'] && (int) $st->fetchColumn() >= $limit) {
            return ['ok' => false, 'error' => 'Report limit reached (' . $limit . ' per hour). Try again later.', 'status' => 429];
        }
        [$from, $to] = self::range($range);
        $useCase = $scope === 'comprehensive' ? 'report_comprehensive' : 'report';
        $llm     = Llm::fromConfig($this->config);
        $model   = $llm->modelFor($useCase);

        $now = date('Y-m-d H:i:s');
        $this->pdo->prepare('INSERT INTO ai_reports (user_id, user_name, role, tier, scope, range_from, range_to, model, status, created_at)
                             VALUES (:u, :n, :r, :t, :s, :f, :to, :m, :st, :c)')
            ->execute(['u' => (int) $p['id'] ?: null, 'n' => $p['name'], 'r' => $p['role'], 't' => $p['tier'], 's' => $scope,
                       'f' => $from, 'to' => $to, 'm' => $model, 'st' => 'running', 'c' => $now]);
        $id = (int) $this->pdo->lastInsertId();
        $no = 'RPT-' . date('ymd') . '-' . str_pad((string) $id, 5, '0', STR_PAD_LEFT);
        $this->pdo->prepare('UPDATE ai_reports SET report_no = :n WHERE id = :id')->execute(['n' => $no, 'id' => $id]);

        [$context, $sections, $gaps, $blocks] = $this->context($p, $scope, $from, $to);

        $system = 'You are the reporting analyst for Kian Joo VisionAI (factory CCTV safety + attendance platform, operated by Weststar). '
            . 'You write formal management reports for filing by Kian Joo Group management, using ONLY the JSON data provided. '
            . 'Never invent numbers, names or events; if a figure is not in the data, state that it is unavailable. Times are Malaysia time (MYT). '
            . 'Call the platform "VisionAI". '
            . 'REGISTER: neutral British business English; formal third person (e.g. "Attendance averaged 94.2%", "The plant recorded…"); '
            . 'no first person (no "I", "we", "our"), no rhetorical questions, no exclamation marks, no emoji, no marketing language or intensifiers '
            . '("great", "excellent", "alarming"). Quantify every statement where the data allows (counts, percentages, durations, dates, identifiers); '
            . 'prefer precise comparisons ("down from 11 to 6") over adjectives. '
            . 'LENGTH: executive_summary at most 180 words, in one or two paragraphs, leading with the most material finding; '
            . 'each section summary 2 to 4 sentences; each highlight or risk a single factual sentence; '
            . 'each recommendation a single imperative sentence naming the action and, where the data shows it, the owner or area, '
            . 'prefixed with its priority as "High: ", "Medium: " or "Low: ". '
            . 'Charts and record registers (ticket register, notable detections, attendance register) are appended automatically from the same data — '
            . 'do not reproduce tables or long lists of records in prose.';
        $ask = "Report period: {$from} to {$to}. Prepared for: " . $p['name'] . ' (' . $p['role'] . "). Scope: {$scope}.\n"
            . 'Produce one section per data block present (keys: ' . implode(', ', $sections) . '), using exactly those keys and a concise formal title for each. '
            . ($scope === 'comprehensive'
                ? 'This is a COMPREHENSIVE report: correlate across sections (e.g. attendance against safety events against ticket SLA), identify trends and probable root causes, and give prioritised, owner-ready recommendations.'
                : ($scope === 'personal' ? 'This is a personal report on the reader\'s own records only; refer to the reader in the third person as "the employee".'
                    : 'Keep each section tight: key measures, notable observations, risks.'))
            . "\nMetric values are short strings (e.g. \"92%\", \"14\", \"3h 20m\"); labels are short noun phrases in sentence case. "
            . "The report title is a formal descriptive title naming the subject and period (e.g. \"Plant Safety and Attendance Report — October 2026\"). "
            . "List anything that could not be reported in data_gaps, each as one factual sentence.\n\nDATA:\n"
            . $context;

        $res = $llm->structured($useCase, $system, $ask, self::SCHEMA);
        $u   = (array) ($res['usage'] ?? []);
        if (!$res['ok']) {
            $this->pdo->prepare('UPDATE ai_reports SET status = :s, error = :e, tokens_in = :ti, tokens_out = :to WHERE id = :id')
                ->execute(['s' => 'failed', 'e' => mb_substr((string) $res['error'], 0, 250), 'ti' => $u['in'] ?? null,
                           'to' => $u['out'] ?? null, 'id' => $id]);
            return ['ok' => false, 'error' => $res['error'] ?? 'Report generation failed.', 'status' => 502, 'report_no' => $no];
        }
        $rep = $res['data'];
        // Charts + record registers come from the platform data, never from the model.
        [$charts, $records, $egaps] = $this->evidence($p, $from, $to, $blocks);
        $rep = self::attachEvidence($rep, $charts, $records);
        $rep['data_gaps'] = array_values(array_unique(array_merge((array) ($rep['data_gaps'] ?? []), $gaps, $egaps)));
        $rep['meta'] = ['report_no' => $no, 'period' => ['from' => $from, 'to' => $to], 'scope' => $scope,
                        'model' => $res['model'] ?? $model, 'generated_at' => date('c'), 'generated_for' => $p['name'],
                        'role' => $p['role'], 'sections_from' => $sections];

        $dir = $this->dir . '/reports/' . date('Y/m');
        @mkdir($dir, 0775, true);
        $base = $dir . '/' . $no;
        @file_put_contents($base . '.json', json_encode($rep, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX);
        @file_put_contents($base . '.md', self::markdown($rep), LOCK_EX);

        $this->pdo->prepare('UPDATE ai_reports SET status = :s, title = :t, summary = :sm, content_json = :c, file_path = :fp,
                                    model = :m, tokens_in = :ti, tokens_out = :to WHERE id = :id')
            ->execute(['s' => 'done', 't' => mb_substr((string) ($rep['title'] ?? 'Report'), 0, 250),
                       'sm' => (string) ($rep['executive_summary'] ?? ''), 'c' => json_encode($rep, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
                       'fp' => ltrim(substr($base, strlen($this->dir)), '/'), 'm' => $res['model'] ?? $model,
                       'ti' => $u['in'] ?? null, 'to' => $u['out'] ?? null, 'id' => $id]);
        return ['ok' => true, 'report' => $this->get($id, $p)];
    }

    /**
     * Data blocks for the report, each fetched through AiTools for the principal.
     *
     * @return array{0:string, 1:array, 2:array, 3:array}  [json context, section keys, data gaps, raw blocks]
     */
    private function context(array $p, string $scope, string $from, string $to): array
    {
        $tools = new AiTools($this->pdo, $this->config, $p);
        $days  = (int) round((strtotime($to) - strtotime($from)) / 86400) + 1;
        $hours = min(720, $days * 24);
        $plan  = $scope === 'personal'
            ? ['attendance' => ['my_attendance', ['from' => $from, 'to' => $to]],
               'leave'      => ['my_leave', []],
               'tickets'    => ['my_tickets', ['limit' => 50]]]
            : ['attendance' => ['team_attendance', ['from' => max($from, date('Y-m-d', strtotime($to) - 30 * 86400)), 'to' => $to]],
               'leave'      => ['leave_approvals', ['status' => '']],
               'tickets'    => ['tickets_overview', ['days' => $days, 'limit' => 50]],
               'safety_ppe_forklift' => ['ppe_forklift_reviews', ['hours' => $hours]],
               'detections' => ['detections_summary', ['hours' => $hours]],
               'cameras'    => ['cameras', []]];
        $data = [];
        $gaps = [];
        foreach ($plan as $key => [$fn, $args]) {
            if (!$tools->isAllowed($fn)) {
                continue;                       // not permitted for this role: never fetched, never mentioned
            }
            $out = $tools->call($fn, $args);
            if (isset($out['error'])) {
                $gaps[] = $key . ': ' . $out['error'];
                continue;
            }
            $data[$key] = $out;
        }
        if ($days > 31 && isset($data['attendance'])) {
            $gaps[] = 'attendance: team attendance covers the last 31 days of the period only.';
        }
        $json = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) ?: '{}';
        if (strlen($json) > 400000) {
            $json = mb_substr($json, 0, 400000);
            $gaps[] = 'Some detail was truncated to fit the report context.';
        }
        return [$json, array_keys($data), $gaps, $data];
    }

    // ── Deterministic evidence: charts + record registers ─────

    private const MOD_LABEL = ['fire' => 'Fire & Smoke', 'ppe' => 'PPE Compliance', 'intr' => 'Intrusion', 'face' => 'Face & Body', 'forklift' => 'Forklift'];
    private const MOD_COLOR = ['ppe' => '#1E6BF1', 'forklift' => '#F59E0B', 'fire' => '#DC2626', 'intr' => '#0B1F3A', 'face' => '#64748B'];
    private const SEV_RANK  = ['critical' => 0, 'high' => 1, 'medium' => 2, 'low' => 3];
    private const TICKET_STATUS = ['new' => ['New', '#0EA5E9'], 'ack' => ['Acknowledged', '#F59E0B'], 'in_progress' => ['In progress', '#8B5CF6'],
                                   'resolved' => ['Resolved', '#1E6BF1'], 'closed' => ['Closed', '#0B1F3A']];
    private const PPE_TARGET = 98;

    /**
     * Chart series and record tables built from the SAME RBAC-scoped fetcher
     * output the model saw ($blocks — only blocks the principal may read are
     * present), plus period aggregates gated by the same AiTools permissions.
     * Nothing here comes from the model.
     *
     * @return array{0:array<string,array>, 1:array, 2:array}  [charts by section key, records, gaps]
     */
    private function evidence(array $p, string $from, string $to, array $blocks): array
    {
        $charts  = [];
        $records = [];
        $gaps    = [];
        $tools   = new AiTools($this->pdo, $this->config, $p);
        $dayLbl  = static fn ($d) => ($ts = strtotime((string) $d)) ? date('j M', $ts) : (string) $d;
        $pct     = static fn ($a, $b) => $b > 0 ? round(100 * $a / $b, 1) : null;
        $fmtPct  = static fn ($v) => $v === null ? '—' : (abs($v - round($v)) < 0.05 ? (string) (int) round($v) : number_format($v, 1)) . '%';

        // Attendance — team daily KPIs (supervisor+) or own day records (staff).
        $att = $blocks['attendance'] ?? null;
        if (is_array($att) && !empty($att['daily_kpi']) && is_array($att['daily_kpi'])) {
            $d = array_values(array_filter($att['daily_kpi'], 'is_array'));
            $charts['attendance'][] = ['type' => 'stacked', 'title' => 'Daily attendance by status', 'unit' => '',
                'labels' => array_map(static fn ($r) => $dayLbl($r['date'] ?? ''), $d),
                'series' => [['name' => 'On time', 'data' => array_map(static fn ($r) => (int) ($r['present'] ?? 0), $d), 'color' => '#1E6BF1'],
                             ['name' => 'Late', 'data' => array_map(static fn ($r) => (int) ($r['late'] ?? 0), $d), 'color' => '#F59E0B'],
                             ['name' => 'Absent', 'data' => array_map(static fn ($r) => (int) ($r['absent'] ?? 0), $d), 'color' => '#DC2626']]];
            $records[] = ['key' => 'attendance_register', 'section' => 'attendance', 'title' => 'Attendance register — daily summary',
                'columns' => ['Date', 'Rostered', 'On time', 'Late', 'Absent', 'Missing clock-out', 'Attendance'],
                'align'   => ['l', 'r', 'r', 'r', 'r', 'r', 'r'],
                'rows'    => array_map(static fn ($r) => [date('D j M', strtotime((string) $r['date']) ?: 0), (string) (int) ($r['total'] ?? 0),
                    (string) (int) ($r['present'] ?? 0), (string) (int) ($r['late'] ?? 0), (string) (int) ($r['absent'] ?? 0),
                    (string) (int) ($r['missingOut'] ?? 0), $fmtPct($pct((int) ($r['present'] ?? 0) + (int) ($r['late'] ?? 0), (int) ($r['total'] ?? 0)))], $d)];
        } elseif (is_array($att) && isset($att['totals']) && is_array($att['data'] ?? null)) {
            $tot = (array) $att['totals'];
            $charts['attendance'][] = ['type' => 'donut', 'title' => 'Your attendance by status', 'center_label' => 'Days',
                'labels' => ['On time', 'Late', 'Absent', 'Pending'], 'colors' => ['#1E6BF1', '#F59E0B', '#DC2626', '#94A3B8'],
                'series' => [['name' => 'Days', 'data' => [(int) ($tot['present'] ?? 0), (int) ($tot['late'] ?? 0), (int) ($tot['absent'] ?? 0), (int) ($tot['pending'] ?? 0)]]]];
            if ($att['data']) {
                $records[] = ['key' => 'attendance_register', 'section' => 'attendance', 'title' => 'Attendance register — your records',
                    'columns' => ['Date', 'Status', 'Clock in', 'Clock out', 'Hours', 'Late (min)'], 'align' => ['l', 'l', 'l', 'l', 'r', 'r'],
                    'rows' => array_map(static fn ($r) => [date('D j M', strtotime((string) ($r['date'] ?? '')) ?: 0), ucfirst((string) ($r['status'] ?? '')),
                        self::hm($r['clock_in'] ?? null), self::hm($r['clock_out'] ?? null),
                        isset($r['hours']) && is_numeric($r['hours']) ? number_format((float) $r['hours'], 1) : '—',
                        !empty($r['late_min']) ? (string) (int) $r['late_min'] : '—'], array_values(array_filter($att['data'], 'is_array')))];
            }
        }

        // Tickets — status split + register (tickets_overview for supervisor+, my_tickets for staff).
        $tk = $blocks['tickets'] ?? null;
        if (is_array($tk)) {
            $rows = array_values(array_filter((array) ($tk['data'] ?? []), 'is_array'));
            $by   = (array) ($tk['stats']['by_status'] ?? []);
            if (!$by) {
                foreach ($rows as $r) {
                    $by[$r['status'] ?? 'new'] = ($by[$r['status'] ?? 'new'] ?? 0) + 1;
                }
            }
            if (array_sum(array_map('intval', $by)) > 0) {
                $keys = array_keys(self::TICKET_STATUS);
                $charts['tickets'][] = ['type' => 'donut', 'title' => 'Tickets by status', 'center_label' => 'Tickets',
                    'labels' => array_map(static fn ($k) => self::TICKET_STATUS[$k][0], $keys),
                    'colors' => array_map(static fn ($k) => self::TICKET_STATUS[$k][1], $keys),
                    'series' => [['name' => 'Tickets', 'data' => array_map(static fn ($k) => (int) ($by[$k] ?? 0), $keys)]]];
            }
            if ($rows) {
                $sla = static fn ($s) => ['met' => 'Met', 'breached' => 'Breached', 'running' => 'Running'][(string) $s] ?? '—';
                $records[] = ['key' => 'ticket_register', 'section' => 'tickets', 'title' => 'Ticket register',
                    'columns' => ['Ticket', 'Title', 'Priority', 'Status', 'Raised', 'Resolution SLA'], 'align' => ['l', 'l', 'l', 'l', 'l', 'l'],
                    'rows' => array_map(static fn ($r) => [(string) ($r['ticket_no'] ?? ''), mb_strimwidth((string) ($r['title'] ?? ''), 0, 70, '…'),
                        ucfirst((string) ($r['priority'] ?? '')), self::TICKET_STATUS[$r['status'] ?? '']['0'] ?? ucfirst(str_replace('_', ' ', (string) ($r['status'] ?? ''))),
                        ($ts = strtotime((string) ($r['created_at'] ?? ''))) ? date('j M Y', $ts) : '—', $sla($r['resolution_sla'] ?? '')], $rows),
                    'note' => (int) ($tk['matched'] ?? $tk['total'] ?? count($rows)) > count($rows)
                        ? 'Showing the ' . count($rows) . ' most recent of ' . (int) ($tk['matched'] ?? $tk['total']) . ' tickets.' : null];
            }
        }

        // PPE-forklift compliance trend (admin: ai_reviews per day in the period).
        if (isset($blocks['safety_ppe_forklift']) && $tools->isAllowed('ppe_forklift_reviews')) {
            try {
                $st = $this->pdo->prepare('SELECT SUBSTR(created_at, 1, 10) d, COUNT(*) n, SUM(violation) v FROM ai_reviews
                                           WHERE created_at >= :f AND created_at <= :t GROUP BY SUBSTR(created_at, 1, 10) ORDER BY d');
                $st->execute(['f' => $from . ' 00:00:00', 't' => $to . ' 23:59:59']);
                $d = array_values(array_filter($st->fetchAll(), static fn ($r) => (int) $r['n'] > 0));
                if ($d) {
                    $charts['safety_ppe_forklift'][] = ['type' => 'line', 'title' => 'PPE compliance of forklift operators (reviewed sightings)',
                        'unit' => '%', 'target' => self::PPE_TARGET, 'target_label' => 'Target ' . self::PPE_TARGET . '%',
                        'labels' => array_map(static fn ($r) => $dayLbl($r['d']), $d),
                        'series' => [['name' => 'Compliance', 'data' => array_map(static fn ($r) => round(100 * ((int) $r['n'] - (int) $r['v']) / (int) $r['n'], 1), $d), 'color' => '#1E6BF1']]];
                }
            } catch (\Throwable $e) {
                $gaps[] = 'safety_ppe_forklift: compliance trend unavailable.';
            }
            $viol = array_values(array_filter((array) ($blocks['safety_ppe_forklift']['recent'] ?? []), static fn ($r) => is_array($r) && !empty($r['violation'])));
            if ($viol) {
                $records[] = ['key' => 'ppe_violations', 'section' => 'safety_ppe_forklift', 'title' => 'Confirmed forklift-without-PPE reviews (most recent)',
                    'columns' => ['Time', 'Person', 'Location', 'Missing PPE', 'Confidence', 'Ticket'], 'align' => ['l', 'l', 'l', 'l', 'r', 'l'],
                    'rows' => array_map(static fn ($r) => [($ts = strtotime((string) ($r['at'] ?? ''))) ? date('j M H:i', $ts) : '—', (string) ($r['person_id'] ?? '—'),
                        (string) ($r['location'] ?? '—'), is_array($r['missing_ppe'] ?? null) ? implode(', ', $r['missing_ppe']) : (string) ($r['missing_ppe'] ?? '—'),
                        isset($r['confidence']) ? round(100 * (float) $r['confidence']) . '%' : '—', (string) ($r['ticket'] ?? '—')], $viol)];
            }
        }

        // Detections — daily by type, busiest cameras, notable events (admin only).
        if (isset($blocks['detections']) && $tools->isAllowed('detections_summary')) {
            try {
                $store = new EventStore($this->pdo, $this->config);
                $daily = [];
                $byCam = [];
                $all   = [];
                $pages = 0;
                for ($off = 0; $pages < 20; $off += 500, $pages++) {
                    $chunk = $store->query(['from' => $from . ' 00:00:00', 'to' => $to . ' 23:59:59', 'limit' => 500, 'offset' => $off]);
                    foreach ($chunk as $row) {
                        $i   = DashboardMapper::incident($row);
                        $day = substr((string) ($row['received_at'] ?? ''), 0, 10);
                        $daily[$i['mod']][$day] = ($daily[$i['mod']][$day] ?? 0) + 1;
                        $byCam[$i['camera']] = ($byCam[$i['camera']] ?? 0) + 1;
                        $all[] = [self::SEV_RANK[$i['sev']] ?? 9, (string) ($i['triggerTime'] ?: $i['received']), $i];
                    }
                    if (count($chunk) < 500) {
                        break;
                    }
                }
                if ($pages >= 20) {
                    $gaps[] = 'detections: charts cover the most recent 10,000 detections in the period.';
                }
                if ($all) {
                    $days = [];
                    for ($t = strtotime($from); $t <= strtotime($to); $t += 86400) {
                        $days[] = date('Y-m-d', $t);
                    }
                    $series = [];
                    foreach ($daily as $mod => $counts) {
                        $series[] = ['name' => self::MOD_LABEL[$mod] ?? ucfirst((string) $mod), 'color' => self::MOD_COLOR[$mod] ?? null,
                                     'data' => array_map(static fn ($d) => (int) ($counts[$d] ?? 0), $days), '_n' => array_sum($counts)];
                    }
                    usort($series, static fn ($a, $b) => $b['_n'] <=> $a['_n']);
                    $series = array_map(static function ($s) { unset($s['_n']); return array_filter($s, static fn ($v) => $v !== null); }, $series);
                    $charts['detections'][] = ['type' => 'stacked', 'title' => 'Daily detections by type', 'unit' => '',
                        'labels' => array_map($dayLbl, $days), 'series' => $series];
                    arsort($byCam);
                    $top = array_slice($byCam, 0, 8, true);
                    $charts['detections'][] = ['type' => 'hbar', 'title' => 'Detections by camera (top ' . count($top) . ')',
                        'labels' => array_map('strval', array_keys($top)), 'series' => [['name' => 'Detections', 'data' => array_values($top), 'color' => '#1E6BF1']]];
                    usort($all, static fn ($a, $b) => [$a[0], $b[1]] <=> [$b[0], $a[1]]);
                    $records[] = ['key' => 'notable_detections', 'section' => 'detections', 'title' => 'Notable detections (highest severity, most recent first)',
                        'columns' => ['Time', 'Type', 'Camera', 'Severity', 'Status', 'Detail'], 'align' => ['l', 'l', 'l', 'l', 'l', 'l'],
                        'rows' => array_map(static fn ($x) => [($ts = strtotime($x[1])) ? date('j M H:i', $ts) : '—', self::MOD_LABEL[$x[2]['mod']] ?? (string) $x[2]['mod'],
                            (string) $x[2]['camera'], ucfirst((string) $x[2]['sev']), ['open' => 'Open', 'ack' => 'Acknowledged', 'resolved' => 'Resolved'][$x[2]['status']] ?? (string) $x[2]['status'],
                            mb_strimwidth((string) $x[2]['title'], 0, 60, '…')], array_slice($all, 0, 15)),
                        'note' => count($all) > 15 ? '15 of ' . number_format(count($all)) . ' detections in the period.' : null];
                }
            } catch (\Throwable $e) {
                $gaps[] = 'detections: period charts unavailable.';
            }
        }
        return [$charts, $records, $gaps];
    }

    private static function hm($v): string
    {
        $ts = $v ? strtotime((string) $v) : false;
        return $ts ? date('H:i', $ts) : '—';
    }

    /** Attach charts to the matching sections (additive optional keys); unmatched charts go top-level. */
    public static function attachEvidence(array $rep, array $charts, array $records): array
    {
        $alias = static fn ($k) => strtok(strtolower((string) $k), '_');   // safety_ppe_forklift → safety, detections → detections
        foreach ((array) ($rep['sections'] ?? []) as $i => $s) {
            $key = strtolower((string) ($s['key'] ?? ''));
            foreach ($charts as $ck => $list) {
                if ($key === $ck || ($key !== '' && ($alias($key) === $alias($ck) || str_contains($key, $alias($ck))))) {
                    $rep['sections'][$i]['charts'] = array_merge((array) ($rep['sections'][$i]['charts'] ?? []), $list);
                    unset($charts[$ck]);
                }
            }
        }
        if ($charts) {
            $rep['charts'] = array_merge(...array_values($charts));
        }
        if ($records) {
            $rep['records'] = $records;
        }
        return $rep;
    }

    public function list(array $p, array $f = []): array
    {
        $all   = AiGuard::atLeast($p, 'admin') && !empty($f['all']);
        $limit = max(1, min(100, (int) ($f['limit'] ?? 30)));
        $st = $this->pdo->prepare('SELECT id, report_no, user_name, role, scope, range_from, range_to, model, status, title, summary, error, created_at
                                   FROM ai_reports' . ($all ? '' : ' WHERE user_id = :u') . ' ORDER BY id DESC LIMIT ' . $limit);
        $st->execute($all ? [] : ['u' => (int) $p['id']]);
        return array_map(static fn ($r) => $r + ['pdf_url' => $r['status'] === 'done' ? self::pdfUrl((int) $r['id']) : null], $st->fetchAll());
    }

    public static function pdfUrl(int $id): string
    {
        return '/api/reports/' . $id . '/pdf';
    }

    public function find($id): ?array
    {
        $st = is_numeric($id)
            ? $this->pdo->prepare('SELECT * FROM ai_reports WHERE id = :v')
            : $this->pdo->prepare('SELECT * FROM ai_reports WHERE report_no = :v');
        $st->execute(['v' => is_numeric($id) ? (int) $id : strtoupper((string) $id)]);
        return $st->fetch() ?: null;
    }

    public static function canView(array $r, array $p): bool
    {
        return AiGuard::atLeast($p, 'admin') || ((int) $r['user_id'] === (int) $p['id'] && (int) $p['id'] > 0);
    }

    public function get($id, array $p): ?array
    {
        $r = $this->find($id);
        if (!$r || !self::canView($r, $p)) {
            return null;
        }
        return [
            'id' => (int) $r['id'], 'report_no' => $r['report_no'], 'status' => $r['status'], 'scope' => $r['scope'],
            'range' => ['from' => $r['range_from'], 'to' => $r['range_to']], 'model' => $r['model'],
            'title' => $r['title'], 'summary' => $r['summary'], 'error' => $r['error'],
            'generated_by' => $r['user_name'], 'created_at' => $r['created_at'],
            'content' => $r['content_json'] ? json_decode((string) $r['content_json'], true) : null,
            'download' => ['md' => '/api/reports/' . (int) $r['id'] . '/download?format=md',
                           'json' => '/api/reports/' . (int) $r['id'] . '/download?format=json']
                        + ($r['status'] === 'done' ? ['pdf' => self::pdfUrl((int) $r['id'])] : []),
            'pdf_url' => $r['status'] === 'done' ? self::pdfUrl((int) $r['id']) : null,
            'print_url' => $r['status'] === 'done' ? '/api/reports/' . (int) $r['id'] . '/print' : null,
        ];
    }

    /** Absolute path of a stored report file (md|json), guarded to storage/. */
    public function filePath(array $r, string $fmt): ?string
    {
        if (empty($r['file_path']) || !in_array($fmt, ['md', 'json'], true)) {
            return null;
        }
        $path = realpath($this->dir . '/' . $r['file_path'] . '.' . $fmt);
        $root = realpath($this->dir);
        return ($path && $root && str_starts_with($path, $root . '/')) ? $path : null;
    }

    // ── PDF (vendored dompdf) ────────────────────────────────

    /**
     * Render a finished report to PDF (cached at storage/reports/{id}.{template}.pdf).
     *
     * @return array{path:string, cached:bool, bytes:int, filename:string}
     * @throws RuntimeException when the report is not finished or dompdf fails
     */
    public function pdf($id): array
    {
        $r = $this->find($id);
        if (!$r || $r['status'] !== 'done' || empty($r['content_json'])) {
            throw new RuntimeException('Report is not finished.');
        }
        $rep  = json_decode((string) $r['content_json'], true);
        if (!is_array($rep)) {
            throw new RuntimeException('Stored report content is unreadable.');
        }
        $dir  = $this->dir . '/reports';
        $file = $dir . '/' . (int) $r['id'] . '.' . self::PDF_TEMPLATE . '.pdf';   // template version in the name → redesigns re-render
        $name = preg_replace('/[^A-Za-z0-9_\-]/', '', (string) ($r['report_no'] ?: ('report-' . $r['id']))) . '.pdf';
        if (is_file($file) && filesize($file) > 0) {
            return ['path' => $file, 'cached' => true, 'bytes' => (int) filesize($file), 'filename' => $name];
        }
        $auto = __DIR__ . '/pdf/dompdf/autoload.inc.php';
        if (!is_file($auto)) {
            throw new RuntimeException('The PDF engine is not installed (lib/pdf/dompdf).');
        }
        require_once $auto;
        if (!is_dir($dir) && !@mkdir($dir, 0775, true)) {
            throw new RuntimeException('Report storage is not writable.');
        }
        $fontCache = $this->dir . '/pdf_fonts';
        if (!is_dir($fontCache)) {
            @mkdir($fontCache, 0775, true);
        }
        $html = self::printHtml($rep, $r);
        $opts = new \Dompdf\Options();
        $opts->setIsRemoteEnabled(false);          // never fetch URLs from report text
        $opts->setIsPhpEnabled(false);
        $opts->setIsJavascriptEnabled(false);
        $opts->setChroot([__DIR__ . '/pdf']);      // local file access limited to the engine itself
        $opts->setFontCache(is_dir($fontCache) && is_writable($fontCache) ? $fontCache : sys_get_temp_dir());
        $opts->setTempDir(sys_get_temp_dir());
        $opts->setDefaultFont('DejaVu Sans');
        $opts->setDefaultPaperSize('a4');
        $dom = new \Dompdf\Dompdf($opts);
        $dom->loadHtml($html, 'UTF-8');
        $dom->setPaper('A4', 'portrait');
        $dom->render();
        // Running header + footer on every page except the cover. page_script() with a
        // callable needs no isPhpEnabled; it runs once per page after layout, so the
        // page count is final. Drawn inside the @page margins (top 74pt, bottom 66pt).
        $meta   = (array) ($rep['meta'] ?? []);
        $head   = trim(($r['report_no'] ?? '') . '  ·  ' . self::periodLabel((string) ($meta['period']['from'] ?? $r['range_from'] ?? ''),
                                                                        (string) ($meta['period']['to'] ?? $r['range_to'] ?? '')), ' ·');
        $dom->getCanvas()->page_script(static function (int $pg, int $total, $c, $fm) use ($head) {
            if ($pg === 1) {
                return;                                    // cover carries its own branding
            }
            $w    = $c->get_width();
            $hgt  = $c->get_height();
            $x0   = 56;
            $x1   = $w - 56;
            $reg  = $fm->getFont('DejaVu Sans');
            $bold = $fm->getFont('DejaVu Sans', 'bold');
            $ink  = [0.043, 0.122, 0.227];                 // #0B1F3A
            $grey = [0.42, 0.45, 0.50];
            $rule = [0.80, 0.84, 0.89];
            $c->text($x0, 38, 'KIAN JOO VISIONAI', $bold, 6.5, $ink, 0, 1);
            $c->text($x1 - $fm->getTextWidth($head, $reg, 7), 38, $head, $reg, 7, $grey);
            $c->line($x0, 52, $x1, 52, $ink, 0.8);
            $c->line($x0, $hgt - 46, $x1, $hgt - 46, $rule, 0.6);
            $c->text($x0, $hgt - 38, 'Kian Joo VisionAI · Internal use', $reg, 7, $grey);
            $pn = 'Page ' . $pg . ' of ' . $total;
            $c->text($x1 - $fm->getTextWidth($pn, $reg, 7), $hgt - 38, $pn, $reg, 7, $grey);
        });
        $bytes = (string) $dom->output();
        if (!str_starts_with($bytes, '%PDF')) {
            throw new RuntimeException('The PDF engine returned no document.');
        }
        $tmp = $file . '.' . getmypid() . '.tmp';
        if (@file_put_contents($tmp, $bytes, LOCK_EX) === false || !@rename($tmp, $file)) {
            @unlink($tmp);
            throw new RuntimeException('Could not write the PDF to report storage.');
        }
        return ['path' => $file, 'cached' => false, 'bytes' => strlen($bytes), 'filename' => $name];
    }

    /** Report-number / period line used by the cover, the running header and the closing block. */
    private static function periodLabel(string $from, string $to): string
    {
        $a = strtotime($from);
        $b = strtotime($to);
        if (!$a || !$b) {
            return trim($from . ' – ' . $to, ' –');
        }
        if ($from === $to) {
            return date('j M Y', $a);
        }
        return date('Y', $a) === date('Y', $b) ? date('j M', $a) . ' – ' . date('j M Y', $b) : date('j M Y', $a) . ' – ' . date('j M Y', $b);
    }

    /** Split an optional "High: …" / "[Medium] …" / "Low priority – …" prefix off a recommendation. */
    private static function priorityOf(string $s): array
    {
        if (preg_match('/^\s*[\[(]?\s*(high|medium|low|critical)(?:\s+priority)?\s*[\])]?\s*[:\-–—]\s*(.+)$/isu', $s, $m)) {
            return [ucfirst(strtolower($m[1])), trim($m[2])];
        }
        return [null, $s];
    }

    /**
     * Print template for dompdf — corporate report layout.
     *
     * One template, two outputs:
     *   'pdf'   dompdf: cover, document control + contents, numbered body, sign-off,
     *           appendices; running header/footer are drawn by pdf() on pages 2+.
     *   'print' the identical document for the browser print dialog — same markup,
     *           plus CSS @page margin boxes for the running header/footer.
     *   'flow'  the same body under a compact title block (single flowing page).
     * Charts are PNGs rendered from the stored deterministic series (ReportCharts).
     */
    public static function printHtml(array $rep, array $row = [], string $mode = 'pdf'): string
    {
        $paged   = $mode !== 'flow';
        $browser = $mode === 'print';
        $e  = static fn ($v) => htmlspecialchars((string) $v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
        // Inline **bold** from model text, after escaping (no other markup survives).
        $t  = static fn ($v) => preg_replace('/\*\*(.+?)\*\*/s', '<b>$1</b>', $e($v)) ?? $e($v);
        $m  = (array) ($rep['meta'] ?? []);
        $no    = (string) ($m['report_no'] ?? ($row['report_no'] ?? ''));
        $title = (string) ($rep['title'] ?? ($row['title'] ?? 'Management report'));
        $from  = (string) ($m['period']['from'] ?? ($row['range_from'] ?? ''));
        $to    = (string) ($m['period']['to'] ?? ($row['range_to'] ?? ''));
        $per   = self::periodLabel($from, $to);
        $scope = ucfirst((string) ($m['scope'] ?? ($row['scope'] ?? 'standard')));
        $for   = (string) ($m['generated_for'] ?? ($row['user_name'] ?? ''));
        $role  = (string) ($m['role'] ?? ($row['role'] ?? ''));
        $gts   = strtotime((string) ($m['generated_at'] ?? ($row['created_at'] ?? ''))) ?: null;
        $gen   = $gts ? date('j M Y, H:i', $gts) . ' MYT' : '—';
        $genD  = $gts ? date('j M Y', $gts) : '—';
        $model = (string) ($m['model'] ?? ($row['model'] ?? ''));
        $logo  = '';
        $lp    = dirname(__DIR__) . '/uploads/Kian-Joo-Logo.png';
        if (is_file($lp) && filesize($lp) < 300000) {
            $logo = 'data:image/png;base64,' . base64_encode((string) file_get_contents($lp));
        }
        $sections = array_values(array_filter((array) ($rep['sections'] ?? []), 'is_array'));
        $recs     = self::strs($rep['recommendations'] ?? []);
        $gaps     = self::strs($rep['data_gaps'] ?? []);
        $extra    = array_values(array_filter((array) ($rep['charts'] ?? []), 'is_array'));
        $records  = array_values(array_filter((array) ($rep['records'] ?? []), static fn ($r) => is_array($r) && !empty($r['rows']) && !empty($r['columns'])));

        // Numbered contents: executive summary, data sections, recommendations, scope & limitations.
        $toc = [];
        $n   = 0;
        if (!empty($rep['executive_summary'])) {
            $toc[] = [++$n, 'Executive summary'];
        }
        foreach ($sections as $s) {
            $toc[] = [++$n, (string) ($s['title'] ?? ($s['key'] ?? 'Section'))];
        }
        if ($extra) {
            $toc[] = [++$n, 'Supporting figures'];
        }
        if ($recs) {
            $toc[] = [++$n, 'Recommendations'];
        }
        if ($gaps) {
            $toc[] = [++$n, 'Scope and limitations'];
        }
        $toc[] = ['', 'Review and approval'];
        foreach ($records as $i => $r) {
            $toc[] = [chr(65 + $i), 'Appendix ' . chr(65 + $i) . ' — ' . (string) ($r['title'] ?? 'Records')];
        }

        $css = (string) @file_get_contents(__DIR__ . '/pdf/report-print.css');
        if ($browser) {
            // Browser twin of pdf()'s canvas header/footer: CSS paged-media margin boxes (dompdf never sees this).
            $q = static fn ($v) => '"' . addcslashes((string) $v, "\\\"\n") . '"';
            $box = "font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 7pt; color: #6B7280;";
            $css .= "\n@page { size: A4; @top-left { content: \"KIAN JOO VISIONAI\"; $box font-weight: bold; color: #0B1F3A; letter-spacing: 1pt; vertical-align: bottom; padding-bottom: 8pt; border-bottom: 0.8pt solid #0B1F3A; }"
                . " @top-right { content: " . $q($no . '  ·  ' . $per) . "; $box vertical-align: bottom; padding-bottom: 8pt; border-bottom: 0.8pt solid #0B1F3A; }"
                . " @bottom-left { content: \"Kian Joo VisionAI · Internal use\"; $box vertical-align: top; padding-top: 8pt; border-top: 0.6pt solid #CCD6E3; }"
                . " @bottom-right { content: \"Page \" counter(page) \" of \" counter(pages); $box vertical-align: top; padding-top: 8pt; border-top: 0.6pt solid #CCD6E3; } }\n"
                . "@page :first { @top-left { content: none; border: 0; } @top-right { content: none; border: 0; } @bottom-left { content: none; border: 0; } @bottom-right { content: none; border: 0; } }\n";
        }
        $h   = '<!doctype html><html><head><meta charset="utf-8"><title>' . $e($no . ' — ' . $title) . '</title><style>' . $css . '</style></head>'
             . '<body class="' . ($paged ? 'paged' : 'flow') . ($browser ? ' browser' : '') . '">';

        if ($paged) {
            // ── Cover ──
            $h .= '<div class="cover">'
                . '<table class="cover-top"><tr><td class="cover-logo">' . ($logo ? '<img src="' . $logo . '" alt="Kian Joo Group">' : '<b>Kian Joo Group</b>') . '</td>'
                . '<td class="cover-class"><span class="chip">Internal use</span></td></tr></table>'
                . '<div class="cover-band">'
                . '<div class="cover-kicker">Kian Joo Group — VisionAI Factory Monitoring</div>'
                . '<div class="cover-title">' . $e($title) . '</div>'
                . '<div class="cover-rule"></div>'
                . '<div class="cover-sub">Management report &nbsp;·&nbsp; ' . $e($scope) . ' scope &nbsp;·&nbsp; ' . $e($per) . '</div>'
                . '</div>'
                . '<table class="cover-meta">'
                . '<tr><td><span>Report number</span>' . $e($no) . '</td><td><span>Reporting period</span>' . $e($per) . '</td></tr>'
                . '<tr><td><span>Scope</span>' . $e($scope) . '</td><td><span>Prepared for</span>' . $e($for) . ($role !== '' ? ' <i>(' . $e($role) . ')</i>' : '') . '</td></tr>'
                . '<tr><td><span>Generated</span>' . $e($gen) . '</td><td><span>Classification</span>Internal use — Kian Joo Group</td></tr>'
                . '</table>'
                . '<div class="cover-foot">This report was compiled automatically by Kian Joo VisionAI from platform records available at the time of generation. '
                . 'It is intended for Kian Joo Group personnel and should not be distributed externally without approval.</div>'
                . '</div>';

            // ── Document control + contents ──
            $h .= '<div class="control">'
                . '<div class="eyebrow">' . $e($no) . '</div><h1 class="page-title">Document control</h1>'
                . '<table class="dc">'
                . '<tr><th>Document title</th><td>' . $e($title) . '</td></tr>'
                . '<tr><th>Report number</th><td>' . $e($no) . '</td></tr>'
                . '<tr><th>Reporting period</th><td>' . $e($per) . ($from !== '' ? ' <span class="muted">(' . $e($from) . ' to ' . $e($to) . ')</span>' : '') . '</td></tr>'
                . '<tr><th>Scope</th><td>' . $e($scope) . '</td></tr>'
                . '<tr><th>Prepared for</th><td>' . $e($for) . ($role !== '' ? ' <span class="muted">— ' . $e($role) . '</span>' : '') . '</td></tr>'
                . '<tr><th>Prepared by</th><td>Kian Joo VisionAI — automated analytics</td></tr>'
                . '<tr><th>Reviewed by</th><td><span class="blank"></span></td></tr>'
                . '<tr><th>Distribution</th><td>Kian Joo Group management — internal</td></tr>'
                . '<tr><th>Version</th><td>1.0 — issued ' . $e($genD) . '</td></tr>'
                . '<tr><th>Classification</th><td>Internal use</td></tr>'
                . '</table>'
                . '<h2 class="toc-h">Contents</h2><table class="toc">';
            foreach ($toc as [$num, $lbl]) {
                $h .= '<tr><td class="toc-n">' . $e($num) . '</td><td>' . $e($lbl) . '</td></tr>';
            }
            $h .= '</table>'
                . '<div class="note"><b>About this report.</b> Figures are drawn only from VisionAI platform records for the stated period and scope; '
                . 'where a figure was not present in the source data it is reported as unavailable. Section 1 summarises the findings; '
                . 'later sections give the supporting measures, observations and risks, followed by recommendations and the limits of the data.</div>'
                . '</div>';
        } else {
            $h .= '<table class="flow-head"><tr><td>' . ($logo ? '<img src="' . $logo . '" alt="Kian Joo Group">' : '') . '</td>'
                . '<td class="flow-head-r"><span class="chip chip-line">Internal use</span><div>' . $e($no) . ' · ' . $e($per) . '</div></td></tr></table>'
                . '<h1 class="page-title">' . $e($title) . '</h1>'
                . '<div class="flow-meta">' . $e($scope) . ' scope · Prepared for ' . $e($for) . ' · Generated ' . $e($gen) . '</div>';
        }

        // ── Body ──
        $h .= '<div class="body">';
        $n = 0;
        if (!empty($rep['executive_summary'])) {
            $h .= '<div class="sec"><h2><span class="sec-n">' . (++$n) . '</span>Executive summary</h2>'
                . '<div class="exec">' . implode('', array_map(static fn ($para) => '<p>' . nl2br($t(trim($para))) . '</p>',
                    preg_split('/\n\s*\n/', trim((string) $rep['executive_summary'])) ?: [])) . '</div>';
            // Key indicators: the lead metric of up to four sections.
            $lead = [];
            foreach ($sections as $s) {
                $x = array_values(array_filter((array) ($s['metrics'] ?? []), 'is_array'))[0] ?? null;
                if ($x && count($lead) < 4) {
                    $lead[] = ['value' => $x['value'] ?? '', 'label' => $x['label'] ?? '', 'cap' => (string) ($s['title'] ?? '')];
                }
            }
            if (count($lead) >= 2) {
                $h .= '<div class="kicker">Key indicators</div>' . self::tiles($lead, $e);
            }
            $h .= '</div>';
        }
        foreach ($sections as $s) {
            $num = ++$n;
            $h  .= '<div class="sec"><h2><span class="sec-n">' . $num . '</span>' . $e($s['title'] ?? ($s['key'] ?? 'Section')) . '</h2>';
            if (!empty($s['summary'])) {
                $h .= '<p>' . nl2br($t($s['summary'])) . '</p>';
            }
            $metrics = array_values(array_filter((array) ($s['metrics'] ?? []), 'is_array'));
            if ($metrics) {
                $h .= self::tiles(array_slice($metrics, 0, 4), $e);
                if (count($metrics) > 4) {
                    $h .= '<table class="grid"><thead><tr><th class="ref">Ref.</th><th>Measure</th><th class="num">Value</th></tr></thead><tbody>';
                    foreach (array_slice($metrics, 4) as $i => $x) {
                        $h .= '<tr><td class="ref">' . $num . '.' . ($i + 1) . '</td><td>' . $e($x['label'] ?? '') . '</td><td class="num">' . $e($x['value'] ?? '') . '</td></tr>';
                    }
                    $h .= '</tbody></table>';
                }
            }
            $fig = 0;
            foreach (array_values(array_filter((array) ($s['charts'] ?? []), 'is_array')) as $ch) {
                $h .= self::figure($ch, $num . '.' . (++$fig), $e);
            }
            $hl = self::strs($s['highlights'] ?? []);
            if ($hl) {
                $h .= '<div class="obs"><div class="kicker">Key observations</div><ul>'
                    . implode('', array_map(static fn ($x) => '<li>' . $t($x) . '</li>', $hl)) . '</ul></div>';
            }
            $rk = self::strs($s['risks'] ?? []);
            if ($rk) {
                $h .= '<div class="risk"><div class="kicker">Risks and exceptions</div><ul>'
                    . implode('', array_map(static fn ($x) => '<li>' . $t($x) . '</li>', $rk)) . '</ul></div>';
            }
            $h .= '</div>';
        }
        if ($extra) {
            $num = ++$n;
            $h  .= '<div class="sec"><h2><span class="sec-n">' . $num . '</span>Supporting figures</h2>';
            foreach ($extra as $i => $ch) {
                $h .= self::figure($ch, $num . '.' . ($i + 1), $e);
            }
            $h .= '</div>';
        }
        if ($recs) {
            $rows = array_map([self::class, 'priorityOf'], $recs);
            $hasP = (bool) array_filter($rows, static fn ($r) => $r[0] !== null);
            $h .= '<div class="sec"><h2><span class="sec-n">' . (++$n) . '</span>Recommendations</h2>'
                . '<p>The following actions are recommended' . ($hasP ? ', listed with their indicated priority.' : ', listed in order of priority.') . '</p>'
                . '<table class="grid recs"><thead><tr><th class="ref">No.</th><th>Recommended action</th><th class="prio">Priority</th></tr></thead><tbody>';
            foreach ($rows as $i => [$pr, $txt]) {
                $lvl = $pr ?? ($hasP ? '—' : (string) ($i + 1));
                $h .= '<tr><td class="ref">R' . ($i + 1) . '</td><td>' . $t($txt) . '</td><td class="prio"><span class="pr pr-' . $e(strtolower($pr ?? 'seq')) . '">' . $e($lvl) . '</span></td></tr>';
            }
            $h .= '</tbody></table></div>';
        }
        if ($gaps) {
            $h .= '<div class="sec"><h2><span class="sec-n">' . (++$n) . '</span>Scope and limitations</h2>'
                . '<div class="limits"><div class="kicker">Scope &amp; limitations</div><ul>'
                . implode('', array_map(static fn ($x) => '<li>' . $t($x) . '</li>', $gaps)) . '</ul></div></div>';
        }

        // ── Closing block + sign-off ──
        $h .= '<div class="closing">'
            . '<h2 class="plain">Review and approval</h2>'
            . '<div class="prep">Prepared by <b>Kian Joo VisionAI analytics</b> · Generated ' . $e($gen)
            . ($model !== '' ? ' · VisionAI engine' : '') . ' · ' . $e($no) . '<br>'
            . 'Figures reflect platform records available at generation time. This document becomes an approved record once reviewed and signed below.</div>'
            . '<table class="sig"><tr>';
        foreach (['Reviewed by', 'Approved by'] as $who) {
            $h .= '<td><div class="sig-h">' . $who . '</div>'
                . '<div class="sig-line"></div><div class="sig-l">Name &amp; designation</div>'
                . '<div class="sig-line"></div><div class="sig-l">Signature</div>'
                . '<div class="sig-line"></div><div class="sig-l">Date</div></td>';
        }
        $h .= '</tr></table></div>';

        // ── Appendices: deterministic record registers ──
        foreach ($records as $i => $r) {
            $L    = chr(65 + $i);
            $cols = array_values(array_map('strval', (array) $r['columns']));
            $al   = array_values((array) ($r['align'] ?? []));
            $h   .= '<div class="appx' . ($i === 0 ? ' appx-first' : '') . '"><h2>Appendix ' . $L . ' — ' . $e($r['title'] ?? 'Records') . '</h2>'
                . '<table class="grid reg"><thead><tr>';
            foreach ($cols as $j => $c) {
                $h .= '<th' . (($al[$j] ?? 'l') === 'r' ? ' class="num"' : '') . '>' . $e($c) . '</th>';
            }
            $h .= '</tr></thead><tbody>';
            foreach ((array) $r['rows'] as $row) {
                $h .= '<tr>';
                foreach ($cols as $j => $c) {
                    $v   = (string) (is_array($row) ? ($row[$j] ?? '') : '');
                    $cls = ($al[$j] ?? 'l') === 'r' ? 'num' : (in_array($c, ['Title', 'Detail', 'Location', 'Missing PPE'], true) ? 'wrap' : '');
                    $pill = in_array($c, ['Priority', 'Severity', 'Resolution SLA', 'Status'], true) && $v !== '' && $v !== '—';
                    $h  .= '<td' . ($cls ? ' class="' . $cls . '"' : '') . '>'
                         . ($pill ? '<span class="tag tag-' . $e(strtolower(str_replace(' ', '-', $v))) . '">' . $e($v) . '</span>' : $e($v)) . '</td>';
                }
                $h .= '</tr>';
            }
            $h .= '</tbody></table>'
                . '<div class="src">Source: VisionAI platform records, ' . $e($per) . '. ' . (!empty($r['note']) ? $e($r['note']) : '') . '</div></div>';
        }

        return $h . '</div></body></html>';
    }

    /** Non-empty scalar strings from a model-supplied list. */
    private static function strs($v): array
    {
        return array_values(array_filter(array_map(static fn ($x) => is_scalar($x) ? trim((string) $x) : '', (array) $v), static fn ($x) => $x !== ''));
    }

    /** A numbered figure: chart PNG (data: URI) + caption + source line. */
    private static function figure(array $ch, string $no, callable $e): string
    {
        $type = (string) ($ch['type'] ?? 'bar');
        $rows = count((array) ($ch['labels'] ?? []));
        $hpx  = $type === 'donut' ? 400 : ($type === 'hbar' ? max(160, 40 + 56 * $rows) : 480);
        $uri  = ReportCharts::dataUri($ch, 1400, (int) $hpx);
        if ($uri === null) {
            return '';
        }
        return '<div class="fig fig-' . $e($type) . '"><div class="fig-cap"><b>Figure ' . $e($no) . '</b>&nbsp; ' . $e($ch['title'] ?? '') . '</div>'
            . '<img src="' . $uri . '" alt="' . $e($ch['title'] ?? 'Chart') . '">'
            . '<div class="src">Source: VisionAI platform records (computed, not model-generated).</div></div>';
    }

    /** One row of up to four bordered stat tiles (empty cells pad the row). */
    private static function tiles(array $items, callable $e): string
    {
        $h = '<table class="tiles"><tr>';
        foreach ($items as $x) {
            $h .= '<td><div class="tile-v">' . $e($x['value'] ?? '') . '</div><div class="tile-l">' . $e($x['label'] ?? '') . '</div>'
                . (!empty($x['cap']) ? '<div class="tile-c">' . $e($x['cap']) . '</div>' : '') . '</td>';
        }
        return $h . str_repeat('<td class="empty"></td>', max(0, 4 - count($items))) . '</tr></table>';
    }

    public static function markdown(array $r): string
    {
        $m  = $r['meta'] ?? [];
        $md = '# ' . ($r['title'] ?? 'Report') . "\n\n";
        $md .= '_' . ($m['report_no'] ?? '') . ' · ' . ($m['period']['from'] ?? '') . ' → ' . ($m['period']['to'] ?? '')
             . ' · ' . ($m['scope'] ?? '') . ' · ' . (($m['model'] ?? '') !== '' ? 'VisionAI engine' : '') . ' · generated ' . ($m['generated_at'] ?? '') . "_\n\n";
        $md .= "## Executive summary\n\n" . ($r['executive_summary'] ?? '') . "\n\n";
        foreach ((array) ($r['sections'] ?? []) as $s) {
            $md .= '## ' . ($s['title'] ?? $s['key'] ?? '') . "\n\n" . ($s['summary'] ?? '') . "\n\n";
            if (!empty($s['metrics'])) {
                $md .= "| Metric | Value |\n|---|---|\n";
                foreach ($s['metrics'] as $x) {
                    $md .= '| ' . str_replace('|', '/', (string) ($x['label'] ?? '')) . ' | ' . str_replace('|', '/', (string) ($x['value'] ?? '')) . " |\n";
                }
                $md .= "\n";
            }
            foreach (['highlights' => 'Highlights', 'risks' => 'Risks'] as $k => $h) {
                if (!empty($s[$k])) {
                    $md .= "**{$h}**\n\n" . implode("\n", array_map(static fn ($x) => '- ' . $x, $s[$k])) . "\n\n";
                }
            }
        }
        if (!empty($r['recommendations'])) {
            $md .= "## Recommendations\n\n" . implode("\n", array_map(static fn ($x, $i) => ($i + 1) . '. ' . $x,
                $r['recommendations'], array_keys($r['recommendations']))) . "\n\n";
        }
        if (!empty($r['data_gaps'])) {
            $md .= "## Data gaps\n\n" . implode("\n", array_map(static fn ($x) => '- ' . $x, $r['data_gaps'])) . "\n";
        }
        return $md;
    }
}
