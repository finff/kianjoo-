<?php
/**
 * The ONLY way AI features read data: a whitelist of named, read-only data
 * fetchers, each tagged with the minimum tier and permission it needs.
 *
 * - The assistant gets tool definitions for exactly the fetchers the caller's
 *   role allows (others are never even described to the model).
 * - Report generation builds its context by calling these same fetchers.
 * - Every call re-checks access; model-supplied arguments are validated and
 *   clamped here. No raw SQL, shell or arbitrary URL ever comes from model
 *   output — the model can only pick a fetcher name + typed arguments.
 *
 * Self-scoped fetchers (my_*) bind to the principal's own user id / person id
 * server-side; there is no argument that selects another person.
 *
 * Provider-neutral: tool definitions are plain {name, description, parameters}
 * (JSON schema); lib/Llm.php adapters translate them to a vendor format.
 *
 * Every result may carry `refs` — entities the UI turns into clickable chips /
 * photo cards (contract in docs/plan/AI_LAYER.md §3b):
 *   {type: ticket|person|event|leave|camera|report, id, label, sub?, thumb?,
 *    photo?, shots?[], staff_id?, match?, report_no?, pdf_url?}
 * Llm strips refs before the result reaches the model.
 */

declare(strict_types=1);

require_once __DIR__ . '/AiGuard.php';
require_once __DIR__ . '/AiSchema.php';
require_once __DIR__ . '/Tickets.php';
require_once __DIR__ . '/EventStore.php';
require_once __DIR__ . '/Text.php';
require_once __DIR__ . '/Attributes.php';
require_once __DIR__ . '/DashboardMapper.php';
require_once __DIR__ . '/Attendance.php';
require_once __DIR__ . '/AiContext.php';

final class AiTools
{
    /**
     * name => [min tier, required perm|null, description, input schema properties, required props]
     */
    public const REGISTRY = [
        // ── staff: own data only ──
        'my_profile' => ['staff', null,
            "The signed-in user's own profile: name, role, staff id, department, plant, shift.", [], []],
        'my_attendance' => ['staff', null,
            "The signed-in user's own attendance (clock-in/out, status, late minutes, hours) per day. Dates YYYY-MM-DD, max 62 days; defaults to the last 14 days.",
            ['from' => ['type' => 'string', 'description' => 'Start date YYYY-MM-DD'],
             'to'   => ['type' => 'string', 'description' => 'End date YYYY-MM-DD']], []],
        'my_leave' => ['staff', null,
            "The signed-in user's own leave requests and their status.",
            ['status' => ['type' => 'string', 'description' => 'Optional status filter, e.g. pending, approved, rejected']], []],
        'my_tickets' => ['staff', null,
            'Tickets the signed-in user raised, with status and SLA state.',
            ['status' => ['type' => 'string', 'description' => 'Optional: new, ack, in_progress, resolved, closed'],
             'limit'  => ['type' => 'integer', 'description' => 'Max rows (default 20, max 50)']], []],

        // ── supervisor: team + approvals + tickets ──
        'team_attendance' => ['supervisor', 'view',
            "Team attendance (the supervisor's department, or everyone if they have none). One date → per-employee rows; a range → daily KPI counts plus who was late/absent most.",
            ['from' => ['type' => 'string', 'description' => 'Start date YYYY-MM-DD (default today)'],
             'to'   => ['type' => 'string', 'description' => 'End date YYYY-MM-DD (default = from, max 31 days)'],
             'status' => ['type' => 'string', 'description' => 'Optional row filter for a single date: present, late, absent, pending, missing_out']], []],
        'leave_approvals' => ['supervisor', 'view',
            'Leave requests awaiting (or past) approval for the team.',
            ['status' => ['type' => 'string', 'description' => 'Default pending']], []],
        'tickets_overview' => ['supervisor', 'tickets',
            'All tickets with SLA state, plus totals by status/priority, breaches, MTTA/MTTR.',
            ['status'   => ['type' => 'string', 'description' => 'Comma list of statuses, or "open" for all unresolved'],
             'priority' => ['type' => 'string', 'description' => 'critical, high, medium or low'],
             'days'     => ['type' => 'integer', 'description' => 'Created in the last N days (default 30)'],
             'limit'    => ['type' => 'integer', 'description' => 'Max rows (default 20, max 50)']], []],
        'ticket_detail' => ['supervisor', 'tickets',
            'One ticket in full (thread, SLA, attachments list) by ticket number like TKT-261110-00012.',
            ['ticket_no' => ['type' => 'string', 'description' => 'Ticket number']], ['ticket_no']],

        // ── admin: cameras / detections / AI pipeline ──
        'detections_summary' => ['admin', 'view',
            'Current detection picture: counts by status, severity, module, camera; SLA breaches; busiest hour.',
            ['hours' => ['type' => 'integer', 'description' => 'Window in hours (default 24, max 720)']], []],
        'detections_list' => ['admin', 'view',
            'Recent detections, newest first.',
            ['hours'  => ['type' => 'integer', 'description' => 'Window in hours (default 24)'],
             'module' => ['type' => 'string', 'description' => 'fire, ppe, intr, face or forklift'],
             'camera' => ['type' => 'string', 'description' => 'Camera / stream label'],
             'status' => ['type' => 'string', 'description' => 'open, ack or resolved'],
             'limit'  => ['type' => 'integer', 'description' => 'Max rows (default 15, max 50)']], []],
        'ppe_forklift_reviews' => ['admin', 'view',
            'Claude vision reviews from the PPE-forklift pipeline: totals, confirmed violations, recent verdicts.',
            ['hours' => ['type' => 'integer', 'description' => 'Window in hours (default 24, max 720)']], []],
        'cameras' => ['admin', 'view',
            'Camera fleet with recent-activity state and bound VisionAI policies.', [], []],
        'people_roster' => ['admin', 'view',
            'People tracked by face recognition (registered first).',
            ['days'  => ['type' => 'integer', 'description' => 'Window in days (default 7)'],
             'limit' => ['type' => 'integer', 'description' => 'Max rows (default 20, max 50)']], []],

        // ── people search (supervisor+ with view: anyone; staff: only themselves) ──
        'find_person' => ['staff', null,
            'Find a person in the records by name, staff id or person id. Returns up to 4 matches with staff id, department, last seen and capture counts; the app shows their profile photo and recent face captures automatically. If "matches" is empty the person was NOT found in the records — say so plainly. Staff roles can only look up themselves.',
            ['query' => ['type' => 'string', 'description' => 'Name (or part of it), staff id or person id']], ['query']],

        // ── the ONLY action tool: generates and stores an AI report ──
        'generate_report' => ['staff', null,
            'ACTION: generate and save an AI management report (takes 30–90 s). Call ONLY when the user explicitly asks to generate / create / produce a report, at most once per message. scope: personal (own records — the only scope for staff), standard (everything the role may see), comprehensive (deep cross-section analysis; needs the reports permission). range: today, 7d, 30d, month, or YYYY-MM-DD..YYYY-MM-DD (max 92 days). Returns the report number and title; the app shows Open and Download PDF buttons.',
            ['scope' => ['type' => 'string', 'enum' => ['personal', 'standard', 'comprehensive'], 'description' => 'Report scope'],
             'range' => ['type' => 'string', 'description' => 'today | 7d | 30d | month | YYYY-MM-DD..YYYY-MM-DD (default 7d)']], []],
    ];

    private const MAX_REFS = 10;

    private ?EventStore $store = null;
    private ?AiContext $ctx = null;
    private int $reportsMade = 0;

    public function __construct(private PDO $pdo, private array $config, private array $principal)
    {
    }

    /** Fetcher names this principal may call. */
    public function allowed(): array
    {
        $out = [];
        foreach (self::REGISTRY as $name => [$tier, $perm]) {
            if (AiGuard::atLeast($this->principal, $tier) && ($perm === null || AiGuard::can($this->principal, $perm))) {
                $out[] = $name;
            }
        }
        return $out;
    }

    public function isAllowed(string $name): bool
    {
        return in_array($name, $this->allowed(), true);
    }

    /**
     * Provider-neutral tool definitions for the allowed fetchers
     * [{name, description, parameters (JSON schema)}], deterministic order → cacheable.
     */
    public function toolDefs(): array
    {
        $defs = [];
        foreach ($this->allowed() as $name) {
            [, , $desc, $props, $req] = self::REGISTRY[$name];
            $defs[] = [
                'name' => $name,
                'description' => $desc,
                'parameters' => ['type' => 'object', 'properties' => (object) $props, 'required' => $req, 'additionalProperties' => false],
            ];
        }
        return $defs;
    }

    /**
     * Run a fetcher for the principal. Never throws; returns ['error'=>…] on
     * denial or failure.
     */
    public function call(string $name, array $args = []): array
    {
        if (!isset(self::REGISTRY[$name])) {
            return ['error' => 'Unknown tool "' . mb_substr($name, 0, 40) . '".'];
        }
        if (!$this->isAllowed($name)) {
            return ['error' => 'Access denied: the ' . $this->principal['role'] . ' role cannot read ' . $name . '.'];
        }
        // Drop anything not declared in the schema.
        $args = array_intersect_key($args, self::REGISTRY[$name][3]);
        try {
            $out = $this->{'f_' . $name}($args);
            if (!isset($out['error']) && !isset($out['refs'])) {
                $refs = $this->refsFor($name, $out);
                if ($refs) {
                    $out['refs'] = $refs;
                }
            }
            return $out;
        } catch (Throwable $e) {
            error_log('[aitools] ' . $name . ': ' . $e->getMessage());
            return ['error' => 'The ' . $name . ' data could not be read right now.'];
        }
    }

    // ── argument helpers ─────────────────────────────────────

    private static function int(array $a, string $k, int $def, int $min, int $max): int
    {
        return isset($a[$k]) && is_numeric($a[$k]) ? max($min, min($max, (int) $a[$k])) : $def;
    }

    private static function date(array $a, string $k, string $def): string
    {
        $v = (string) ($a[$k] ?? '');
        return preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) && strtotime($v) ? $v : $def;
    }

    private static function word(array $a, string $k, int $max = 40): string
    {
        return mb_substr(preg_replace('/[^\w ,\-]/u', '', (string) ($a[$k] ?? '')) ?? '', 0, $max);
    }

    private function store(): EventStore
    {
        return $this->store ??= new EventStore($this->pdo, $this->config);
    }

    private function ctx(): AiContext
    {
        return $this->ctx ??= new AiContext($this->store(), $this->config);
    }

    private function tickets(): Tickets
    {
        return new Tickets($this->pdo, (string) ($this->config['ai']['storage_dir'] ?? dirname(__DIR__) . '/storage'));
    }

    // ── staff fetchers ───────────────────────────────────────

    private function f_my_profile(array $a): array
    {
        $p   = $this->principal;
        $emp = $p['person_id'] ? ($this->store()->personProfiles()[$p['person_id']] ?? null) : null;
        return ['data' => [
            'name' => $p['name'], 'username' => $p['username'], 'role' => $p['role'],
            'staff_id' => $emp['staffId'] ?? null, 'department' => $emp['department'] ?? null,
            'plant' => $emp['plant'] ?? null, 'shift' => $emp['shift'] ?? null,
            'linked_employee_record' => $emp !== null,
        ], 'summary' => $emp ? 'Profile linked to employee record.' : 'No employee record is linked to this login yet — attendance cannot be shown until an admin links it.'];
    }

    private function f_my_attendance(array $a): array
    {
        $pid = $this->principal['person_id'];
        if (!$pid) {
            return ['data' => [], 'summary' => 'No employee record is linked to this login, so there is no attendance to show.'];
        }
        $to   = self::date($a, 'to', date('Y-m-d'));
        $from = self::date($a, 'from', date('Y-m-d', strtotime($to) - 13 * 86400));
        if ($from > $to) {
            [$from, $to] = [$to, $from];
        }
        if (strtotime($to) - strtotime($from) > 61 * 86400) {
            $from = date('Y-m-d', strtotime($to) - 61 * 86400);
        }
        $att  = new Attendance($this->store(), $this->config);
        $rows = [];
        $cnt  = ['present' => 0, 'late' => 0, 'absent' => 0, 'off' => 0, 'pending' => 0];
        for ($d = strtotime($from); $d <= strtotime($to); $d += 86400) {
            $day = $att->daily(date('Y-m-d', $d), []);
            foreach ($day['rows'] ?? [] as $r) {
                if ($r['personId'] !== $pid) {
                    continue;
                }
                $cnt[$r['status']] = ($cnt[$r['status']] ?? 0) + 1;
                $rows[] = ['date' => date('Y-m-d', $d), 'status' => $r['status'], 'clock_in' => $r['clockIn'], 'clock_out' => $r['clockOut'],
                           'late_min' => $r['lateMin'], 'hours' => $r['hours'], 'flags' => $r['flags'], 'shift' => $r['shift']];
            }
        }
        return ['range' => [$from, $to], 'totals' => $cnt, 'data' => $rows,
                'summary' => sprintf('%d day(s) from %s to %s: %d present, %d late, %d absent.', count($rows), $from, $to,
                    $cnt['present'] + $cnt['late'], $cnt['late'], $cnt['absent'])];
    }

    private function f_my_leave(array $a): array
    {
        return $this->leaveRows(['self' => true, 'status' => self::word($a, 'status', 20)]);
    }

    private function f_my_tickets(array $a): array
    {
        $p = $this->principal;
        $f = ['limit' => self::int($a, 'limit', 20, 1, 50), 'status' => self::word($a, 'status', 60)];
        // Force self-scope even for workers: this is "MY" tickets.
        $self = $p;
        $self['tier'] = 'staff';
        $res  = $this->tickets()->list($f, $self);
        return ['total' => $res['total'], 'data' => array_map(static fn ($t) => self::ticketBrief($t), $res['tickets']),
                'summary' => $res['total'] . ' ticket(s) raised by you.'];
    }

    // ── supervisor fetchers ──────────────────────────────────

    private function f_team_attendance(array $a): array
    {
        $dept = $this->principal['tier'] === 'admin' ? '' : $this->principal['department'];
        $from = self::date($a, 'from', date('Y-m-d'));
        $to   = self::date($a, 'to', $from);
        if ($from > $to) {
            [$from, $to] = [$to, $from];
        }
        if (strtotime($to) - strtotime($from) > 30 * 86400) {
            $from = date('Y-m-d', strtotime($to) - 30 * 86400);
        }
        $att = new Attendance($this->store(), $this->config);
        $f   = $dept !== '' ? ['department' => $dept] : [];
        if ($from === $to) {
            $st = self::word($a, 'status', 20);
            $day = $att->daily($from, $f + ($st !== '' ? ['status' => $st] : []));
            $rows = array_map(static fn ($r) => [
                'person_id' => $r['personId'] ?? null, 'name' => $r['name'], 'staff_id' => $r['staffId'], 'department' => $r['department'], 'status' => $r['status'],
                'clock_in' => $r['clockIn'], 'clock_out' => $r['clockOut'], 'late_min' => $r['lateMin'], 'flags' => $r['flags'],
            ], array_slice($day['rows'] ?? [], 0, 150));
            return ['date' => $from, 'scope' => $dept !== '' ? 'department ' . $dept : 'all employees', 'kpi' => $day['kpi'] ?? [],
                    'data' => $rows, 'summary' => 'Attendance for ' . $from . ' (' . ($dept !== '' ? 'department ' . $dept : 'all employees') . ').'];
        }
        $days  = [];
        $late  = [];
        $absent = [];
        for ($d = strtotime($from); $d <= strtotime($to); $d += 86400) {
            $day = $att->daily(date('Y-m-d', $d), $f);
            $days[] = ['date' => date('Y-m-d', $d)] + ($day['kpi'] ?? []);
            foreach ($day['rows'] ?? [] as $r) {
                if ($r['status'] === 'late') {
                    $late[$r['name']] = ($late[$r['name']] ?? 0) + 1;
                } elseif ($r['status'] === 'absent') {
                    $absent[$r['name']] = ($absent[$r['name']] ?? 0) + 1;
                }
            }
        }
        arsort($late);
        arsort($absent);
        return ['range' => [$from, $to], 'scope' => $dept !== '' ? 'department ' . $dept : 'all employees', 'daily_kpi' => $days,
                'most_late' => array_slice($late, 0, 10, true), 'most_absent' => array_slice($absent, 0, 10, true),
                'summary' => 'Attendance KPIs per day from ' . $from . ' to ' . $to . '.'];
    }

    private function f_leave_approvals(array $a): array
    {
        return $this->leaveRows(['self' => false, 'status' => self::word($a, 'status', 20) ?: 'pending']);
    }

    private function f_tickets_overview(array $a): array
    {
        $days = self::int($a, 'days', 30, 1, 365);
        $from = date('Y-m-d H:i:s', time() - $days * 86400);
        $st   = self::word($a, 'status', 60);
        $f    = ['limit' => self::int($a, 'limit', 20, 1, 50), 'priority' => self::word($a, 'priority', 10), 'from' => $from];
        if ($st === 'open') {
            $f['open'] = 1;
        } else {
            $f['status'] = $st;
        }
        $t   = $this->tickets();
        $res = $t->list($f, $this->principal);
        return ['window_days' => $days, 'stats' => $t->stats($from), 'matched' => $res['total'],
                'data' => array_map(static fn ($x) => self::ticketBrief($x), $res['tickets']),
                'summary' => $res['total'] . ' ticket(s) match in the last ' . $days . ' days.'];
    }

    private function f_ticket_detail(array $a): array
    {
        $no = strtoupper(preg_replace('/[^A-Z0-9\-]/i', '', (string) ($a['ticket_no'] ?? '')) ?? '');
        $t  = $no !== '' ? $this->tickets()->find($no) : null;
        if (!$t || !Tickets::canView($t, $this->principal)) {
            return ['error' => 'Ticket ' . $no . ' not found.'];
        }
        $d = $this->tickets()->detail($t, $this->principal);
        unset($d['meta']);
        $d['attachments'] = array_map(static fn ($x) => ['kind' => $x['kind'], 'filename' => $x['filename']], $d['attachments']);
        return ['data' => $d];
    }

    // ── admin fetchers ───────────────────────────────────────

    private function f_detections_summary(array $a): array
    {
        return $this->ctx()->summary(self::int($a, 'hours', 24, 1, 720));
    }

    private function f_detections_list(array $a): array
    {
        $f = ['hours' => self::int($a, 'hours', 24, 1, 720), 'limit' => self::int($a, 'limit', 15, 1, 50)];
        foreach (['module', 'camera', 'status'] as $k) {
            $v = self::word($a, $k, 40);
            if ($v !== '') {
                $f[$k] = $v;
            }
        }
        return $this->ctx()->detections($f);
    }

    private function f_ppe_forklift_reviews(array $a): array
    {
        $hours = self::int($a, 'hours', 24, 1, 720);
        $from  = date('Y-m-d H:i:s', time() - $hours * 3600);
        $st = $this->pdo->prepare('SELECT COUNT(*) n, SUM(violation) v, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) e,
                                          SUM(tokens_in) ti, SUM(tokens_out) tout
                                   FROM ai_reviews WHERE created_at >= :f');
        $st->execute(['f' => $from]);
        $tot = $st->fetch() ?: [];
        $st = $this->pdo->prepare('SELECT r.created_at, r.person_id, r.location, r.violation, r.confidence, r.verdict_json, t.ticket_no
                                   FROM ai_reviews r LEFT JOIN tickets t ON t.id = r.ticket_id
                                   WHERE r.created_at >= :f ORDER BY r.id DESC LIMIT 15');
        $st->execute(['f' => $from]);
        $recent = [];
        foreach ($st->fetchAll() as $r) {
            $v = json_decode((string) $r['verdict_json'], true) ?: [];
            $recent[] = ['at' => $r['created_at'], 'person_id' => $r['person_id'], 'location' => $r['location'],
                         'violation' => (bool) $r['violation'], 'confidence' => $r['confidence'] !== null ? (float) $r['confidence'] : null,
                         'missing_ppe' => $v['missing_ppe'] ?? null, 'reason' => $v['reason'] ?? null, 'ticket' => $r['ticket_no']];
        }
        $open = (int) $this->pdo->query("SELECT COUNT(*) FROM tickets WHERE category = 'ppe_forklift' AND status NOT IN ('resolved','closed')")->fetchColumn();
        return ['window' => $hours . 'h', 'reviews' => (int) ($tot['n'] ?? 0), 'violations' => (int) ($tot['v'] ?? 0),
                'errors' => (int) ($tot['e'] ?? 0), 'open_ppe_forklift_tickets' => $open, 'recent' => $recent,
                'summary' => sprintf('%d vision review(s) in the last %dh, %d confirmed forklift-without-PPE; %d PPE-forklift ticket(s) open.',
                    (int) ($tot['n'] ?? 0), $hours, (int) ($tot['v'] ?? 0), $open)];
    }

    private function f_cameras(array $a): array
    {
        return $this->ctx()->cameras();
    }

    private function f_people_roster(array $a): array
    {
        return $this->ctx()->people(['days' => self::int($a, 'days', 7, 1, 90), 'limit' => self::int($a, 'limit', 20, 1, 50)]);
    }

    // ── people search ────────────────────────────────────────

    /**
     * Up to 4 people matching a name / staff id / person id, each with the
     * profile photo and up to 3 recent face-capture thumbnails (the cached
     * /api/movement/thumb WebP — same endpoint + RBAC the movement page uses).
     * Supervisor+ with `view`: anyone. Everyone else: only their own record.
     */
    private function f_find_person(array $a): array
    {
        require_once __DIR__ . '/Floorplans.php';
        $q = trim(mb_substr(preg_replace('/[^\p{L}\p{N} .\'_:\-]/u', '', (string) ($a['query'] ?? '')) ?? '', 0, 60));
        if ($q === '') {
            return ['error' => 'Give a name, staff id or person id to search for.'];
        }
        $fp  = new Floorplans($this->pdo, $this->config, dirname(__DIR__));
        $all = AiGuard::atLeast($this->principal, 'supervisor') && AiGuard::can($this->principal, 'view');
        $hits = $fp->searchPeople($q, $all ? 4 : 20);
        if (!$all) {
            $own  = trim((string) ($this->principal['person_id'] ?? ''));
            $own  = $own !== '' ? $fp->canonical($own) : '';
            $hits = array_values(array_filter($hits, static fn ($h) => $own !== '' && (string) $h['person_id'] === $own));
            if (!$hits) {
                return ['query' => $q, 'matches' => [],
                        'summary' => 'No match you can see: this role can only look up its own record. Tell the user the person was not found in the records available to them.'];
            }
        }
        $matches = [];
        $refs    = [];
        foreach (array_slice($hits, 0, 4) as $h) {
            $pid  = (string) $h['person_id'];
            $ids  = [$pid];
            try {
                $st = $this->pdo->prepare("SELECT ss_uid FROM person_profiles WHERE person_id = :p AND ss_uid IS NOT NULL AND ss_uid <> ''");
                $st->execute(['p' => $pid]);
                foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $u) {
                    $ids[] = (string) $u;
                }
            } catch (Throwable $e) {
                // ss_uid column not migrated
            }
            $ids = array_values(array_unique($ids));
            $in  = implode(',', array_fill(0, count($ids), '?'));
            $st  = $this->pdo->prepare("SELECT COUNT(*) n, MAX(received_at) last FROM events WHERE person_id IN ($in)");
            $st->execute($ids);
            $agg = $st->fetch() ?: [];
            $st  = $this->pdo->prepare("SELECT id, received_at, stream, device_name FROM events WHERE person_id IN ($in)
                                        AND ((trigger_img_url IS NOT NULL AND trigger_img_url <> '') OR (bk_image_url IS NOT NULL AND bk_image_url <> ''))
                                        ORDER BY id DESC LIMIT 3");
            $st->execute($ids);
            $shots = [];
            foreach ($st->fetchAll() as $e) {
                $shots[] = ['thumb' => '/api/movement/thumb/' . (int) $e['id'], 'at' => (string) $e['received_at'],
                            'camera' => strtoupper((string) ($e['stream'] ?: $e['device_name'] ?: ''))];
            }
            $name = (string) $h['name'];
            $matches[] = array_filter([
                'person_id' => $pid, 'name' => $name, 'staff_id' => $h['staff_id'] ?: null, 'department' => $h['department'] ?: null,
                'enrolled' => (bool) $h['known'], 'captures' => (int) ($agg['n'] ?? 0), 'last_seen' => $agg['last'] ?? null,
                'recent_capture_cameras' => array_values(array_unique(array_filter(array_column($shots, 'camera')))) ?: null,
            ], static fn ($v) => $v !== null && $v !== '');
            $refs[] = array_filter([
                'type' => 'person', 'id' => $pid, 'label' => $name, 'staff_id' => $h['staff_id'] ?: null,
                'sub' => implode(' · ', array_filter([$h['staff_id'] ?? '', $h['department'] ?? ''])) ?: null,
                'photo' => $h['photo'] ?: null, 'shots' => array_column($shots, 'thumb') ?: null, 'match' => true,
            ], static fn ($v) => $v !== null && $v !== '');
        }
        return ['query' => $q, 'matches' => $matches, 'refs' => $refs,
                'summary' => $matches ? count($matches) . ' match(es) for "' . $q . '".'
                    : 'No person matching "' . $q . '" was found in the records. Tell the user plainly that they were not found.'];
    }

    // ── the action tool ──────────────────────────────────────

    /** Generate + persist a report through AiReports (same RBAC, scope forcing and hourly limit as POST /report/generate). */
    private function f_generate_report(array $a): array
    {
        if ($this->reportsMade >= 1) {
            return ['error' => 'Only one report can be generated per message.'];
        }
        require_once __DIR__ . '/AiReports.php';
        $scope = (string) ($a['scope'] ?? '');
        if (!in_array($scope, AiReports::SCOPES, true)) {
            $scope = AiGuard::atLeast($this->principal, 'supervisor') ? 'standard' : 'personal';
        }
        [$eff, $why] = AiReports::scopeFor($this->principal, $scope);
        if ($eff === null) {
            return ['error' => (string) $why];
        }
        $r = strtolower(trim((string) ($a['range'] ?? '7d')));
        $range = preg_match('/^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|to|–|-{1,2}>?)\s*(\d{4}-\d{2}-\d{2})$/', $r, $m)
            ? ['from' => $m[1], 'to' => $m[2]]
            : (preg_match('/^(today|month|\d{1,2}d)$/', $r) ? $r : '7d');
        $this->reportsMade++;
        $res = (new AiReports($this->pdo, $this->config))->generate($this->principal, $range, $eff);
        if (!$res['ok']) {
            return ['error' => 'The report could not be generated: ' . ($res['error'] ?? 'unknown error')];
        }
        $rep = $res['report'];
        $title = (string) (($rep['content']['title'] ?? '') ?: ($rep['title'] ?? 'Report'));
        return [
            'report_id' => $rep['id'], 'report_no' => $rep['report_no'], 'title' => $title, 'scope' => $rep['scope'],
            'range' => $rep['range'], 'executive_summary' => mb_substr((string) ($rep['summary'] ?? ''), 0, 700),
            'scope_note' => $eff !== $scope ? 'Scope was set to ' . $eff . ' for this role.' : null,
            'refs' => [array_filter([
                'type' => 'report', 'id' => (string) $rep['id'], 'label' => $title, 'report_no' => $rep['report_no'],
                'sub' => ucfirst((string) $rep['scope']) . ' · ' . $rep['range']['from'] . ' → ' . $rep['range']['to'],
                'pdf_url' => $rep['pdf_url'] ?? null,
            ], static fn ($v) => $v !== null && $v !== '')],
        ];
    }

    // ── refs: entities the UI links to ───────────────────────

    private static function ref(string $type, $id, string $label, array $extra = []): ?array
    {
        $id = trim((string) $id);
        if ($id === '') {
            return null;
        }
        return ['type' => $type, 'id' => $id, 'label' => mb_substr($label !== '' ? $label : $id, 0, 80)]
             + array_filter($extra, static fn ($v) => $v !== null && $v !== '');
    }

    /** Entities a fetcher returned, deduped and capped (server-side; never from model text). */
    private function refsFor(string $name, array $out): array
    {
        $rows = is_array($out['data'] ?? null) ? $out['data'] : [];
        $list = [];
        switch ($name) {
            case 'my_tickets':
            case 'tickets_overview':
                foreach ($rows as $t) {
                    $list[] = self::ref('ticket', $t['ticket_no'] ?? '', (string) ($t['title'] ?? ''), ['sub' => trim(($t['priority'] ?? '') . ' · ' . ($t['status'] ?? ''), ' ·')]);
                }
                break;
            case 'ticket_detail':
                $list[] = self::ref('ticket', $rows['ticket_no'] ?? '', (string) ($rows['title'] ?? ''));
                if (!empty($rows['person_id'])) {
                    $list[] = self::ref('person', $rows['person_id'], (string) ($rows['meta']['person_name'] ?? ('Person #' . $rows['person_id'])));
                }
                if (!empty($rows['camera'])) {
                    $list[] = self::ref('camera', strtoupper((string) $rows['camera']), strtoupper((string) $rows['camera']));
                }
                break;
            case 'my_leave':
            case 'leave_approvals':
                foreach ($rows as $l) {
                    $list[] = self::ref('leave', $l['id'] ?? '', (string) ($l['leave_no'] ?? ('Leave #' . ($l['id'] ?? ''))),
                        ['sub' => trim(($l['user_name'] ?? '') . ' · ' . ($l['leave_type'] ?? '') . ' ' . ($l['start_date'] ?? '') . ' · ' . ($l['status'] ?? ''), ' ·'),
                         'leave_no' => $l['leave_no'] ?? null]);
                }
                break;
            case 'team_attendance':
                usort($rows, static fn ($a, $b) => (int) !in_array($a['status'] ?? '', ['late', 'absent'], true) <=> (int) !in_array($b['status'] ?? '', ['late', 'absent'], true));
                foreach ($rows as $r) {
                    $list[] = self::ref('person', $r['person_id'] ?? '', (string) ($r['name'] ?? ''), ['sub' => $r['status'] ?? null, 'staff_id' => $r['staff_id'] ?? null]);
                }
                break;
            case 'detections_list':
            case 'detections_summary':
                $evs = $name === 'detections_list' ? $rows : array_merge(isset($out['latest']) && is_array($out['latest']) ? [$out['latest']] : [], (array) ($out['sla_breaches'] ?? []));
                foreach ($evs as $e) {
                    $list[] = self::ref('event', $e['event_id'] ?? '', trim(($e['what'] ?? 'Detection') . ' · ' . ($e['camera'] ?? ''), ' ·'), ['sub' => $e['when'] ?? null]);
                }
                foreach ($evs as $e) {
                    if (!empty($e['person_id'])) {
                        $list[] = self::ref('person', $e['person_id'], (string) ($e['person'] ?? ('Person #' . $e['person_id'])));
                    }
                }
                break;
            case 'ppe_forklift_reviews':
                foreach ((array) ($out['recent'] ?? []) as $r) {
                    if (!empty($r['ticket'])) {
                        $list[] = self::ref('ticket', $r['ticket'], 'PPE-forklift · ' . ($r['location'] ?? ''));
                    }
                }
                foreach ((array) ($out['recent'] ?? []) as $r) {
                    if (!empty($r['person_id'])) {
                        $list[] = self::ref('person', $r['person_id'], 'Person #' . $r['person_id']);
                    }
                }
                break;
            case 'cameras':
                foreach ($rows as $c) {
                    $list[] = self::ref('camera', $c['camera'] ?? '', (string) ($c['name'] ?? ''), ['sub' => !empty($c['online']) ? 'active' : 'quiet']);
                }
                break;
            case 'people_roster':
                foreach ($rows as $p) {
                    $list[] = self::ref('person', $p['person_id'] ?? '', (string) ($p['name'] ?? ('Person #' . ($p['person_id'] ?? ''))));
                }
                break;
        }
        $seen = [];
        $res  = [];
        foreach ($list as $r) {
            if ($r === null || isset($seen[$r['type'] . ':' . $r['id']])) {
                continue;
            }
            $seen[$r['type'] . ':' . $r['id']] = true;
            $res[] = $r;
            if (count($res) >= self::MAX_REFS) {
                break;
            }
        }
        return $res;
    }

    // ── shared ───────────────────────────────────────────────

    /**
     * Leave rows from the M6 `leaves` table (if it exists yet). Self-scope binds
     * to the principal's user id / person id; team scope applies the
     * supervisor's department when the table carries one.
     */
    private function leaveRows(array $o): array
    {
        if (!AiSchema::tableExists($this->pdo, 'leaves')) {
            return ['data' => [], 'summary' => 'Leave records are not available yet (the leave module is not installed).'];
        }
        $cols = array_keys($this->pdo->query('SELECT * FROM leaves LIMIT 1')->fetch() ?: []);
        if (!$cols) {
            // Empty table: fall back to column introspection through a zero-row select.
            $st = $this->pdo->query('SELECT * FROM leaves WHERE 1 = 0');
            for ($i = 0; $i < $st->columnCount(); $i++) {
                $cols[] = (string) ($st->getColumnMeta($i)['name'] ?? '');
            }
        }
        $where = [];
        $args  = [];
        if ($o['self']) {
            if (in_array('user_id', $cols, true)) {
                $where[] = 'user_id = :u';
                $args['u'] = (int) $this->principal['id'];
            } elseif (in_array('person_id', $cols, true) && $this->principal['person_id']) {
                $where[] = 'person_id = :p';
                $args['p'] = $this->principal['person_id'];
            } else {
                return ['data' => [], 'summary' => 'Your leave records could not be matched to this login.'];
            }
        } elseif ($this->principal['tier'] !== 'admin' && $this->principal['department'] !== '' && in_array('department', $cols, true)) {
            $where[] = 'department = :d';
            $args['d'] = $this->principal['department'];
        }
        if ($o['status'] !== '' && in_array('status', $cols, true)) {
            $where[] = 'status = :s';
            $args['s'] = $o['status'];
        }
        $st = $this->pdo->prepare('SELECT * FROM leaves' . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY id DESC LIMIT 50');
        $st->execute($args);
        $rows = array_map(static function ($r) {
            unset($r['attachment'], $r['attachment_path'], $r['password_hash']);
            return $r;
        }, $st->fetchAll());
        return ['data' => $rows, 'summary' => count($rows) . ' leave record(s).'];
    }

    private static function ticketBrief(array $t): array
    {
        return array_filter([
            'ticket_no' => $t['ticket_no'], 'title' => $t['title'], 'priority' => $t['priority'], 'status' => $t['status'],
            'category' => $t['category'], 'created_at' => $t['created_at'], 'assignee' => $t['assignee'] ?? null,
            'location' => $t['location'] ?? null,
            'response_sla' => $t['sla']['response']['state'] ?? null, 'resolution_sla' => $t['sla']['resolution']['state'] ?? null,
            'event_duration_s' => $t['event_duration_s'] ?? null,
        ], static fn ($v) => $v !== null && $v !== '');
    }
}
