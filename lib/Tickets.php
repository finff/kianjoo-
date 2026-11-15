<?php
/**
 * ITSM tickets (M7): create / list / get / status workflow / thread /
 * attachments, with SLA deadlines and breach flags.
 *
 * Status flow  new → ack → in_progress → resolved → closed
 *              (ack → resolved allowed; resolved → in_progress = reopen)
 * Resolve requires closing remarks. SLA = response + resolution deadline per
 * priority (storage/sla_policy.json overrides DEFAULT_SLA). Response is met by
 * the first ack or the first reply from a ticket worker.
 *
 * Visibility: workers (supervisor/admin tier + `tickets` perm) see every
 * ticket; everyone else sees only tickets they raised, never internal notes,
 * and never camera/detection internals.
 */

declare(strict_types=1);

require_once __DIR__ . '/AiGuard.php';
require_once __DIR__ . '/ImageTool.php';

final class Tickets
{
    public const STATUSES   = ['new', 'ack', 'in_progress', 'resolved', 'closed'];
    public const PRIORITIES = ['critical', 'high', 'medium', 'low'];
    public const TRANSITIONS = [
        'new'         => ['ack'],
        'ack'         => ['in_progress', 'resolved'],
        'in_progress' => ['resolved'],
        'resolved'    => ['closed', 'in_progress'],
        'closed'      => [],
    ];
    /** Minutes: [response, resolution]. */
    public const DEFAULT_SLA = [
        'critical' => ['response' => 15,  'resolution' => 240],
        'high'     => ['response' => 60,  'resolution' => 480],
        'medium'   => ['response' => 240, 'resolution' => 1440],
        'low'      => ['response' => 480, 'resolution' => 4320],
    ];
    public const CATEGORIES = ['general', 'safety', 'ppe_forklift', 'ppe_zone', 'attendance', 'leave', 'it', 'facility', 'incident'];

    private const MAX_UPLOAD = 10 * 1024 * 1024;
    private const UPLOAD_MIME = [
        'image/jpeg' => 'jpg', 'image/png' => 'png', 'image/gif' => 'gif', 'image/webp' => 'webp',
        'application/pdf' => 'pdf', 'text/plain' => 'txt', 'text/csv' => 'csv',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' => 'docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' => 'xlsx',
        'application/zip' => 'zip',
    ];

    public function __construct(private PDO $pdo, private string $storageDir)
    {
        $this->storageDir = rtrim($storageDir, '/');
    }

    // ── SLA policy ───────────────────────────────────────────

    public function slaPolicy(): array
    {
        $p = self::DEFAULT_SLA;
        $f = $this->storageDir . '/sla_policy.json';
        if (is_file($f)) {
            $o = json_decode((string) file_get_contents($f), true);
            foreach (self::PRIORITIES as $pr) {
                foreach (['response', 'resolution'] as $k) {
                    if (isset($o[$pr][$k]) && (int) $o[$pr][$k] > 0) {
                        $p[$pr][$k] = (int) $o[$pr][$k];
                    }
                }
            }
        }
        return $p;
    }

    public function saveSlaPolicy(array $in): array
    {
        $p = $this->slaPolicy();
        foreach (self::PRIORITIES as $pr) {
            foreach (['response', 'resolution'] as $k) {
                if (isset($in[$pr][$k])) {
                    $p[$pr][$k] = max(1, min(60 * 24 * 60, (int) $in[$pr][$k]));
                }
            }
            if ($p[$pr]['resolution'] < $p[$pr]['response']) {
                $p[$pr]['resolution'] = $p[$pr]['response'];
            }
        }
        @file_put_contents($this->storageDir . '/sla_policy.json', json_encode($p, JSON_PRETTY_PRINT), LOCK_EX);
        return $p;
    }

    // ── Access ───────────────────────────────────────────────

    /** May this principal work tickets (see all, change status, assign)? */
    public static function isWorker(array $p): bool
    {
        return AiGuard::atLeast($p, 'supervisor') && AiGuard::can($p, 'tickets');
    }

    public static function canView(array $t, array $p): bool
    {
        return self::isWorker($p) || ((int) ($t['requester_user_id'] ?? -1) === (int) $p['id'] && (int) $p['id'] > 0);
    }

    // ── Create / read ────────────────────────────────────────

    /**
     * @param array $in   title, description, priority, category (+ system-only:
     *                    source, person_id, location, camera, event_id, dedup_key,
     *                    event_first_at, event_last_at, detection_count, meta)
     * @param bool  $system  true for pipeline-created tickets (trusted fields allowed)
     */
    public function create(array $in, array $p, bool $system = false): array
    {
        $title = trim((string) ($in['title'] ?? ''));
        if ($title === '' || mb_strlen($title) > 200) {
            throw new InvalidArgumentException('A title (1–200 characters) is required.');
        }
        $prio = in_array($in['priority'] ?? '', self::PRIORITIES, true) ? (string) $in['priority'] : 'medium';
        if (!$system && !self::isWorker($p) && $prio === 'critical') {
            $prio = 'high';   // staff can't self-declare critical; a worker can raise it
        }
        $cat = in_array($in['category'] ?? '', self::CATEGORIES, true) ? (string) $in['category'] : 'general';
        if (!$system && in_array($cat, ['ppe_forklift', 'ppe_zone'], true)) {
            $cat = 'safety';
        }
        $now = date('Y-m-d H:i:s');
        $sla = $this->slaPolicy()[$prio];
        $row = [
            'title' => $title,
            'description' => mb_substr(trim((string) ($in['description'] ?? '')), 0, 8000),
            'category' => $cat,
            'source' => $system ? (string) ($in['source'] ?? 'ai_pipeline') : 'manual',
            'priority' => $prio,
            'status' => 'new',
            'requester_user_id' => $system ? null : ((int) $p['id'] ?: null),
            'requester_name' => $system ? (string) ($in['requester_name'] ?? 'VisionAI pipeline') : $p['name'],
            'person_id' => $system ? ($in['person_id'] ?? null) : null,
            'location' => $system ? ($in['location'] ?? null) : (mb_substr(trim((string) ($in['location'] ?? '')), 0, 120) ?: null),
            'camera' => $system ? ($in['camera'] ?? null) : null,
            'event_id' => $system ? ($in['event_id'] ?? null) : null,
            'dedup_key' => $system ? ($in['dedup_key'] ?? null) : null,
            'event_first_at' => $system ? ($in['event_first_at'] ?? null) : null,
            'event_last_at' => $system ? ($in['event_last_at'] ?? null) : null,
            'detection_count' => $system ? (int) ($in['detection_count'] ?? 0) : 0,
            'response_due_at' => date('Y-m-d H:i:s', time() + $sla['response'] * 60),
            'resolution_due_at' => date('Y-m-d H:i:s', time() + $sla['resolution'] * 60),
            'meta_json' => $system && !empty($in['meta']) ? json_encode($in['meta'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : null,
            'created_at' => $now,
            'updated_at' => $now,
        ];
        $cols = array_keys($row);
        $st = $this->pdo->prepare('INSERT INTO tickets (' . implode(',', $cols) . ') VALUES (:' . implode(',:', $cols) . ')');
        $st->execute($row);
        $id = (int) $this->pdo->lastInsertId();
        $no = 'TKT-' . date('ymd') . '-' . str_pad((string) $id, 5, '0', STR_PAD_LEFT);
        $this->pdo->prepare('UPDATE tickets SET ticket_no = :n WHERE id = :id')->execute(['n' => $no, 'id' => $id]);
        $this->message($id, $p, 'system', 'Ticket created' . ($system ? ' by the VisionAI pipeline' : ' by ' . $p['name'])
            . ' — priority ' . $prio . '.', false, null, 'new', $system);
        $t = $this->find($id);
        // E-mail the ticket desk. Pipeline tickets defer this until their proof is attached.
        if (!($system && !empty($in['defer_notify']))) {
            $this->notifyCreated($t, $system ? null : $p);
        }
        return $t;
    }

    /** "New ticket" e-mail (NotifyMail never throws). $actor null = pipeline. */
    public function notifyCreated(array $t, ?array $actor = null): void
    {
        require_once __DIR__ . '/NotifyMail.php';
        NotifyMail::ticketCreated($this->pdo, $t, $actor);
    }

    /** Raw row by numeric id or ticket number. */
    public function find($id): ?array
    {
        $st = is_numeric($id)
            ? $this->pdo->prepare('SELECT * FROM tickets WHERE id = :v LIMIT 1')
            : $this->pdo->prepare('SELECT * FROM tickets WHERE ticket_no = :v LIMIT 1');
        $st->execute(['v' => is_numeric($id) ? (int) $id : strtoupper(trim((string) $id))]);
        return $st->fetch() ?: null;
    }

    /**
     * Ticket list for the principal.
     * Filters: status (csv), open, priority, category, q, mine, breached, from, to,
     * person_id, event_id (alias `event`), limit (default 200, max 500), offset.
     * RBAC scoping is applied first (non-workers: own tickets only), so the
     * person/event filters only ever narrow what the caller could already see.
     * Each row carries message_count (visible comments), attachment_count
     * (visible user files) and proof_url (first proof image for workers, else
     * the first visible image attachment) so boards need no per-ticket detail call.
     */
    public function list(array $f, array $p): array
    {
        $where = [];
        $args  = [];
        if (!self::isWorker($p) || !empty($f['mine'])) {
            if (self::isWorker($p) && !empty($f['mine'])) {
                $where[] = '(requester_user_id = :me OR assignee_user_id = :me2)';
                $args['me2'] = (int) $p['id'];
            } else {
                $where[] = 'requester_user_id = :me';
            }
            $args['me'] = (int) $p['id'];
        }
        if (!empty($f['status'])) {
            $sts = array_values(array_intersect(self::STATUSES, explode(',', (string) $f['status'])));
            if ($sts) {
                $in = [];
                foreach ($sts as $i => $s) {
                    $in[] = ':st' . $i;
                    $args['st' . $i] = $s;
                }
                $where[] = 'status IN (' . implode(',', $in) . ')';
            }
        } elseif (!empty($f['open'])) {
            $where[] = "status NOT IN ('resolved','closed')";
        }
        if (in_array($f['priority'] ?? '', self::PRIORITIES, true)) {
            $where[] = 'priority = :pr';
            $args['pr'] = $f['priority'];
        }
        if (in_array($f['category'] ?? '', self::CATEGORIES, true)) {
            $where[] = 'category = :cat';
            $args['cat'] = $f['category'];
        }
        if (!empty($f['from'])) {
            $where[] = 'created_at >= :from';
            $args['from'] = (string) $f['from'];
        }
        if (!empty($f['to'])) {
            $where[] = 'created_at <= :to';
            $args['to'] = (string) $f['to'];
        }
        $pid = trim((string) ($f['person_id'] ?? ''));
        if ($pid !== '') {
            $where[] = 'person_id = :pid';
            $args['pid'] = mb_substr($pid, 0, 64);
        }
        $ev = $f['event_id'] ?? ($f['event'] ?? null);
        if ($ev !== null && $ev !== '' && ctype_digit((string) $ev)) {
            $where[] = 'event_id = :ev';
            $args['ev'] = (int) $ev;
        }
        $q = trim((string) ($f['q'] ?? ''));
        if ($q !== '') {
            $where[] = '(title LIKE :q OR ticket_no LIKE :q2)';
            $args['q']  = '%' . mb_substr($q, 0, 80) . '%';
            $args['q2'] = '%' . mb_substr($q, 0, 80) . '%';
        }
        $limit  = max(1, min(500, (int) ($f['limit'] ?? 200)));
        $offset = max(0, (int) ($f['offset'] ?? 0));
        $sqlW   = $where ? ' WHERE ' . implode(' AND ', $where) : '';

        $cnt = $this->pdo->prepare('SELECT COUNT(*) FROM tickets' . $sqlW);
        $cnt->execute($args);
        $total = (int) $cnt->fetchColumn();

        $st = $this->pdo->prepare('SELECT * FROM tickets' . $sqlW . ' ORDER BY id DESC LIMIT ' . $limit . ' OFFSET ' . $offset);
        $st->execute($args);
        $raw   = $st->fetchAll();
        $extra = $this->listExtras(array_map(static fn ($t) => (int) $t['id'], $raw), self::isWorker($p));
        $rows  = array_map(fn ($t) => $this->present($t, $p) + ($extra[(int) $t['id']] ?? ['message_count' => 0, 'attachment_count' => 0, 'proof_url' => null]), $raw);
        if (!empty($f['breached'])) {
            $rows = array_values(array_filter($rows, static fn ($t) => $t['sla']['response']['breached'] || $t['sla']['resolution']['breached']));
        }
        return ['total' => $total, 'limit' => $limit, 'offset' => $offset, 'tickets' => $rows];
    }

    /**
     * Batched per-row counts for list(): 2 queries for the whole page.
     * Mirrors detail() visibility — non-workers never count internal notes,
     * proofs, or files attached to internal notes.
     * Also used by TicketTable (GET /tickets/table) for its page rows.
     * @return array<int, array{message_count:int, attachment_count:int, proof_url:?string}>
     */
    public function listExtras(array $ids, bool $worker): array
    {
        $out = [];
        if (!$ids) {
            return $out;
        }
        foreach ($ids as $id) {
            $out[$id] = ['message_count' => 0, 'attachment_count' => 0, 'proof_url' => null];
        }
        $in = implode(',', array_map('intval', $ids));
        $st = $this->pdo->query("SELECT ticket_id, COUNT(*) AS n FROM ticket_messages WHERE ticket_id IN ($in) AND kind = 'comment'"
            . ($worker ? '' : ' AND internal = 0') . ' GROUP BY ticket_id');
        foreach ($st->fetchAll() as $r) {
            $out[(int) $r['ticket_id']]['message_count'] = (int) $r['n'];
        }
        $st = $this->pdo->query("SELECT a.id, a.ticket_id, a.kind, a.mime, a.message_id, m.internal AS msg_internal
            FROM ticket_attachments a LEFT JOIN ticket_messages m ON m.id = a.message_id
            WHERE a.ticket_id IN ($in) ORDER BY a.id ASC");
        $firstImg = [];
        foreach ($st->fetchAll() as $a) {
            $tid = (int) $a['ticket_id'];
            if (!$worker && ($a['kind'] === 'proof' || (int) ($a['msg_internal'] ?? 0) === 1)) {
                continue;
            }
            $url = '/api/tickets/' . $tid . '/attachments/' . (int) $a['id'];
            if ($a['kind'] === 'proof') {
                $out[$tid]['proof_url'] ??= $url;
            } else {
                $out[$tid]['attachment_count']++;
                if (!isset($firstImg[$tid]) && str_starts_with((string) $a['mime'], 'image/')) {
                    $firstImg[$tid] = $url;
                }
            }
        }
        foreach ($firstImg as $tid => $url) {
            $out[$tid]['proof_url'] ??= $url;
        }
        return $out;
    }

    /** May the principal see this attachment row? (proofs + files on internal notes are worker-only) */
    public function attachmentVisible(array $a, array $p): bool
    {
        if (self::isWorker($p)) {
            return true;
        }
        if ($a['kind'] === 'proof') {
            return false;
        }
        if ($a['message_id'] !== null) {
            $st = $this->pdo->prepare('SELECT internal FROM ticket_messages WHERE id = :m AND ticket_id = :t');
            $st->execute(['m' => (int) $a['message_id'], 't' => (int) $a['ticket_id']]);
            $r = $st->fetch();
            if (!$r || (int) $r['internal'] === 1) {
                return false;
            }
        }
        return true;
    }

    /** Full ticket: row + thread + attachments, shaped for the principal. */
    public function detail(array $t, array $p): array
    {
        $worker = self::isWorker($p);
        $st = $this->pdo->prepare('SELECT * FROM ticket_messages WHERE ticket_id = :id'
            . ($worker ? '' : ' AND internal = 0') . ' ORDER BY id ASC');
        $st->execute(['id' => $t['id']]);
        $msgRows = $st->fetchAll();
        $visibleMsg = [];
        foreach ($msgRows as $m) {
            $visibleMsg[(int) $m['id']] = true;
        }
        $msgs = array_map(static fn ($m) => [
            'id' => (int) $m['id'], 'kind' => $m['kind'], 'author' => $m['author_name'], 'author_user_id' => $m['author_user_id'] !== null ? (int) $m['author_user_id'] : null,
            'body' => $m['body'], 'from_status' => $m['from_status'], 'to_status' => $m['to_status'],
            'internal' => (int) $m['internal'] === 1, 'created_at' => $m['created_at'],
        ], $msgRows);

        $st = $this->pdo->prepare('SELECT * FROM ticket_attachments WHERE ticket_id = :id ORDER BY id ASC');
        $st->execute(['id' => $t['id']]);
        $atts = [];
        foreach ($st->fetchAll() as $a) {
            if (!$worker && $a['kind'] === 'proof') {
                continue;
            }
            // Files posted on an internal note are as private as the note itself.
            if (!$worker && $a['message_id'] !== null && !isset($visibleMsg[(int) $a['message_id']])) {
                continue;
            }
            $atts[] = [
                'id' => (int) $a['id'], 'kind' => $a['kind'], 'filename' => $a['filename'], 'mime' => $a['mime'],
                'size' => (int) $a['size_bytes'], 'message_id' => $a['message_id'] !== null ? (int) $a['message_id'] : null,
                'event_id' => $worker && $a['event_id'] !== null ? (int) $a['event_id'] : null,
                'uploaded_by' => $a['uploaded_by'], 'created_at' => $a['created_at'],
                'url' => '/api/tickets/' . (int) $t['id'] . '/attachments/' . (int) $a['id'],
            ];
        }
        return $this->present($t, $p) + ['messages' => $msgs, 'attachments' => $atts,
            'allowed_transitions' => $this->allowedTransitions($t, $p)];
    }

    /** API shape of one ticket row, with live SLA state. */
    public function present(array $t, array $p): array
    {
        $sla = $this->slaState($t);
        $this->persistBreach($t, $sla);
        $out = [
            'id' => (int) $t['id'], 'ticket_no' => $t['ticket_no'], 'title' => $t['title'], 'description' => $t['description'],
            'category' => $t['category'], 'source' => $t['source'], 'priority' => $t['priority'], 'status' => $t['status'],
            'requester' => $t['requester_name'], 'requester_user_id' => $t['requester_user_id'] !== null ? (int) $t['requester_user_id'] : null,
            'assignee' => $t['assignee_name'], 'assignee_user_id' => $t['assignee_user_id'] !== null ? (int) $t['assignee_user_id'] : null,
            'location' => $t['location'],
            'created_at' => $t['created_at'], 'updated_at' => $t['updated_at'],
            'acked_at' => $t['acked_at'], 'resolved_at' => $t['resolved_at'], 'closed_at' => $t['closed_at'],
            'closing_remarks' => $t['closing_remarks'], 'resolution_code' => $t['resolution_code'],
            'sla' => $sla,
        ];
        if (self::isWorker($p)) {
            $out += [
                'person_id' => $t['person_id'], 'camera' => $t['camera'],
                'event_id' => $t['event_id'] !== null ? (int) $t['event_id'] : null,
                'event_first_at' => $t['event_first_at'], 'event_last_at' => $t['event_last_at'],
                'event_duration_s' => ($t['event_first_at'] && $t['event_last_at'])
                    ? max(0, (strtotime((string) $t['event_last_at']) ?: 0) - (strtotime((string) $t['event_first_at']) ?: 0)) : null,
                'detection_count' => (int) $t['detection_count'],
                'meta' => $t['meta_json'] ? (json_decode((string) $t['meta_json'], true) ?: null) : null,
            ];
        }
        return $out;
    }

    /** Live SLA timers + breach flags. */
    public function slaState(array $t): array
    {
        $now  = time();
        $pol  = $this->slaPolicy()[$t['priority']] ?? self::DEFAULT_SLA['medium'];
        $calc = static function (?string $due, ?string $metAt) use ($now): array {
            $d = $due ? (strtotime($due) ?: null) : null;
            $m = $metAt ? (strtotime($metAt) ?: null) : null;
            $breached = $d !== null && ($m !== null ? $m > $d : $now > $d);
            return ['due_at' => $due, 'met_at' => $metAt, 'breached' => $breached,
                    'remaining_s' => ($d !== null && $m === null) ? $d - $now : null,
                    'state' => $m !== null ? ($breached ? 'breached' : 'met') : ($breached ? 'breached' : 'running')];
        };
        $resp = $calc($t['response_due_at'], $t['first_response_at']);
        $res  = $calc($t['resolution_due_at'], $t['resolved_at']);
        return ['policy_min' => $pol, 'response' => $resp, 'resolution' => $res];
    }

    private function persistBreach(array $t, array $sla): void
    {
        $rb = $sla['response']['breached'] ? 1 : 0;
        $sb = $sla['resolution']['breached'] ? 1 : 0;
        if ($rb !== (int) $t['response_breached'] || $sb !== (int) $t['resolution_breached']) {
            $this->pdo->prepare('UPDATE tickets SET response_breached = :r, resolution_breached = :s WHERE id = :id')
                ->execute(['r' => $rb, 's' => $sb, 'id' => $t['id']]);
        }
    }

    /**
     * Persist breach flags for every open ticket (worker / cron) and e-mail each
     * NEW breach once per ticket per type (response / resolution). The
     * *_breach_mailed column is claimed with a conditional UPDATE, so parallel
     * sweeps never double-send; breaches already met (late) or on resolved
     * tickets are claimed silently.
     */
    public function sweepBreaches(): int
    {
        $n = 0;
        $mails = 0;
        foreach ($this->pdo->query("SELECT * FROM tickets WHERE status NOT IN ('closed')")->fetchAll() as $t) {
            $sla = $this->slaState($t);
            if (($sla['response']['breached'] ? 1 : 0) !== (int) $t['response_breached']
                || ($sla['resolution']['breached'] ? 1 : 0) !== (int) $t['resolution_breached']) {
                $this->persistBreach($t, $sla);
                $n++;
            }
            foreach (['response', 'resolution'] as $type) {
                if (!$sla[$type]['breached'] || (int) ($t[$type . '_breach_mailed'] ?? 1) === 1) {
                    continue;
                }
                $claim = $this->pdo->prepare('UPDATE tickets SET ' . $type . '_breach_mailed = 1 WHERE id = :id AND ' . $type . '_breach_mailed = 0');
                $claim->execute(['id' => $t['id']]);
                if ($claim->rowCount() !== 1 || $sla[$type]['met_at'] !== null || in_array($t['status'], ['resolved', 'closed'], true)) {
                    continue;
                }
                if ($mails++ >= 25) {
                    continue;   // burst cap per sweep (still claimed: no backlog flood next run)
                }
                require_once __DIR__ . '/NotifyMail.php';
                $t[$type . '_breached'] = 1;
                NotifyMail::ticketBreach($this->pdo, $t, $type);
            }
        }
        return $n;
    }

    // ── Workflow ─────────────────────────────────────────────

    public function allowedTransitions(array $t, array $p): array
    {
        $next = self::TRANSITIONS[$t['status']] ?? [];
        if (self::isWorker($p)) {
            return $next;
        }
        // The requester may confirm-close their own resolved ticket.
        return (self::canView($t, $p) && $t['status'] === 'resolved') ? ['closed'] : [];
    }

    /** Move a ticket to $to. Resolve needs closing remarks. Returns the updated row. */
    public function transition(array $t, string $to, array $p, string $remarks = '', string $code = ''): array
    {
        if (!in_array($to, $this->allowedTransitions($t, $p), true)) {
            throw new DomainException('Cannot move a ' . $t['status'] . ' ticket to ' . $to . ' with your role.');
        }
        $remarks = trim($remarks);
        $now = date('Y-m-d H:i:s');
        $set = ['status' => $to, 'updated_at' => $now];
        if ($to === 'ack') {
            $set['acked_at'] = $now;
            if (empty($t['first_response_at'])) {
                $set['first_response_at'] = $now;
            }
            if (empty($t['assignee_user_id']) && (int) $p['id'] > 0) {
                $set['assignee_user_id'] = (int) $p['id'];
                $set['assignee_name']    = $p['name'];
            }
        } elseif ($to === 'in_progress') {
            $set['in_progress_at'] = $now;
            if ($t['status'] === 'resolved') {          // reopen
                $set['resolved_at'] = null;
                $set['closing_remarks'] = null;
                $set['resolution_code'] = null;
            }
        } elseif ($to === 'resolved') {
            if (mb_strlen($remarks) < 5) {
                throw new InvalidArgumentException('Closing remarks (at least 5 characters) are required to resolve a ticket.');
            }
            $set['resolved_at'] = $now;
            $set['closing_remarks'] = mb_substr($remarks, 0, 4000);
            $set['resolution_code'] = preg_replace('/[^a-z0-9_\-]/i', '', mb_substr($code, 0, 40)) ?: 'resolved';
            if (empty($t['first_response_at'])) {
                $set['first_response_at'] = $now;
            }
            if (empty($t['acked_at'])) {
                $set['acked_at'] = $now;
            }
        } elseif ($to === 'closed') {
            $set['closed_at'] = $now;
        }
        $this->update((int) $t['id'], $set);
        $this->message((int) $t['id'], $p, 'status', $remarks !== '' ? $remarks : null, false, $t['status'], $to);
        $t2 = $this->find((int) $t['id']);
        if ($to === 'resolved') {
            require_once __DIR__ . '/NotifyMail.php';
            NotifyMail::ticketResolved($this->pdo, $t2, $p);   // requester only, not when they resolved it
        }
        return $t2;
    }

    /** Worker edits: priority (recomputes SLA deadlines), assignee, title. */
    public function edit(array $t, array $in, array $p): array
    {
        if (!self::isWorker($p)) {
            throw new DomainException('Only supervisors and admins can edit tickets.');
        }
        $set  = [];
        $note = [];
        if (isset($in['priority']) && in_array($in['priority'], self::PRIORITIES, true) && $in['priority'] !== $t['priority']) {
            $pol = $this->slaPolicy()[$in['priority']];
            $c   = strtotime((string) $t['created_at']) ?: time();
            $set['priority'] = $in['priority'];
            $set['response_due_at']   = date('Y-m-d H:i:s', $c + $pol['response'] * 60);
            $set['resolution_due_at'] = date('Y-m-d H:i:s', $c + $pol['resolution'] * 60);
            $note[] = 'priority ' . $t['priority'] . ' → ' . $in['priority'];
        }
        if (array_key_exists('assignee_user_id', $in)) {
            $uid = (int) $in['assignee_user_id'];
            if ($uid > 0) {
                $st = $this->pdo->prepare('SELECT id, username, display_name FROM users WHERE id = :id AND active = 1');
                $st->execute(['id' => $uid]);
                $u = $st->fetch();
                if (!$u) {
                    throw new InvalidArgumentException('Assignee not found or inactive.');
                }
                $set['assignee_user_id'] = (int) $u['id'];
                $set['assignee_name']    = (string) ($u['display_name'] ?: $u['username']);
                $note[] = 'assigned to ' . $set['assignee_name'];
            } else {
                $set['assignee_user_id'] = null;
                $set['assignee_name']    = null;
                $note[] = 'unassigned';
            }
        }
        if (isset($in['title']) && trim((string) $in['title']) !== '') {
            $set['title'] = mb_substr(trim((string) $in['title']), 0, 200);
        }
        if (!$set) {
            return $t;
        }
        $set['updated_at'] = date('Y-m-d H:i:s');
        $this->update((int) $t['id'], $set);
        if ($note) {
            $this->message((int) $t['id'], $p, 'system', ucfirst(implode('; ', $note)) . ' by ' . $p['name'] . '.');
        }
        // M6 in-app notification: tell a newly assigned user (not self-assignment).
        $newAssignee = (int) ($set['assignee_user_id'] ?? 0);
        if ($newAssignee > 0 && $newAssignee !== (int) ($t['assignee_user_id'] ?? 0) && $newAssignee !== (int) $p['id']) {
            require_once __DIR__ . '/Notifications.php';
            Notifications::emit($this->pdo, [$newAssignee], 'ticket_assigned',
                'Ticket ' . $t['ticket_no'] . ' assigned to you', mb_substr((string) $t['title'], 0, 160) . ' · ' . $t['priority'] . ' · by ' . $p['name'],
                '#tickets&modal=ticket:' . (int) $t['id'], 'ticket', (int) $t['id']);
        }
        $t2 = $this->find((int) $t['id']);
        if ($newAssignee > 0 && $newAssignee !== (int) ($t['assignee_user_id'] ?? 0) && $newAssignee !== (int) $p['id']) {
            require_once __DIR__ . '/NotifyMail.php';
            NotifyMail::ticketAssigned($this->pdo, $t2, $newAssignee, $p);
        }
        return $t2;
    }

    /** Post to the thread. Staff can't post internal notes; closed tickets are read-only. */
    public function postMessage(array $t, array $p, string $body, bool $internal = false): array
    {
        $body = trim($body);
        if ($body === '' || mb_strlen($body) > 8000) {
            throw new InvalidArgumentException('Message must be 1–8000 characters.');
        }
        if ($t['status'] === 'closed') {
            throw new DomainException('This ticket is closed.');
        }
        $worker   = self::isWorker($p);
        $internal = $internal && $worker;
        $id = $this->message((int) $t['id'], $p, 'comment', $body, $internal);
        $set = ['updated_at' => date('Y-m-d H:i:s')];
        if ($worker && !$internal && empty($t['first_response_at']) && (int) $t['requester_user_id'] !== (int) $p['id']) {
            $set['first_response_at'] = $set['updated_at'];
        }
        $this->update((int) $t['id'], $set);
        return ['id' => $id, 'internal' => $internal];
    }

    /** Append a thread entry; returns its id. */
    public function message(int $ticketId, array $p, string $kind, ?string $body, bool $internal = false,
                            ?string $from = null, ?string $to = null, bool $system = false): int
    {
        $st = $this->pdo->prepare('INSERT INTO ticket_messages (ticket_id, author_user_id, author_name, kind, body, from_status, to_status, internal, created_at)
                                   VALUES (:t, :u, :n, :k, :b, :f, :to, :i, :c)');
        $st->execute([
            't' => $ticketId, 'u' => $system ? null : ((int) $p['id'] ?: null),
            'n' => $system ? 'VisionAI' : $p['name'], 'k' => $kind, 'b' => $body,
            'f' => $from, 'to' => $to, 'i' => $internal ? 1 : 0, 'c' => date('Y-m-d H:i:s'),
        ]);
        return (int) $this->pdo->lastInsertId();
    }

    // ── Attachments ──────────────────────────────────────────

    /** Store an uploaded file ($_FILES entry). Images are re-encoded to WebP. */
    public function attachUpload(array $t, array $p, array $file, ?int $messageId = null): array
    {
        if ($t['status'] === 'closed') {
            throw new DomainException('This ticket is closed.');
        }
        if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file((string) ($file['tmp_name'] ?? ''))) {
            throw new InvalidArgumentException('Upload failed or no file was sent (field name "file").');
        }
        $size = (int) filesize($file['tmp_name']);
        if ($size <= 0 || $size > self::MAX_UPLOAD) {
            throw new InvalidArgumentException('Files must be between 1 byte and 10 MB.');
        }
        $mime = (string) (new finfo(FILEINFO_MIME_TYPE))->file($file['tmp_name']);
        if (!isset(self::UPLOAD_MIME[$mime])) {
            throw new InvalidArgumentException('File type ' . $mime . ' is not allowed.');
        }
        if ($messageId !== null) {
            $st = $this->pdo->prepare('SELECT internal FROM ticket_messages WHERE id = :m AND ticket_id = :t');
            $st->execute(['m' => $messageId, 't' => (int) $t['id']]);
            $m = $st->fetch();
            if (!$m || ((int) $m['internal'] === 1 && !self::isWorker($p))) {
                throw new InvalidArgumentException('message_id does not belong to this ticket.');
            }
        }
        $name = preg_replace('/[^\w.\- ]+/u', '_', basename((string) ($file['name'] ?? 'file'))) ?: 'file';
        $name = mb_substr($name, 0, 120);
        $dir  = $this->storageDir . '/tickets/' . (int) $t['id'];
        $rand = bin2hex(random_bytes(8));
        $bytes = (string) file_get_contents($file['tmp_name']);

        if (str_starts_with($mime, 'image/') && $mime !== 'image/gif') {
            $res = ImageTool::toWebp($bytes, $dir . '/' . $rand . '.webp', 82, 2400);
            if ($res) {
                $name = preg_replace('/\.[a-z0-9]+$/i', '', $name) . '.webp';
                return $this->attachRow((int) $t['id'], $messageId, 'file', $name, $res['path'], 'image/webp', $p['name'], null);
            }
        }
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException('Could not create the attachment folder.');
        }
        $dest = $dir . '/' . $rand . '.' . self::UPLOAD_MIME[$mime];
        if (!move_uploaded_file($file['tmp_name'], $dest)) {
            throw new RuntimeException('Could not store the file.');
        }
        return $this->attachRow((int) $t['id'], $messageId, 'file', $name, $dest, $mime, $p['name'], null);
    }

    /** Store a WebP proof image for a pipeline ticket. */
    public function attachProof(array $t, string $bytes, ?int $eventId): ?array
    {
        $dest = $this->storageDir . '/proofs/' . date('Y/m') . '/' . $t['ticket_no'] . '-' . ($eventId ?? 0) . '-' . substr(bin2hex(random_bytes(4)), 0, 8) . '.webp';
        $res  = ImageTool::toWebp($bytes, $dest, 80, 1920);
        if (!$res) {
            return null;
        }
        return $this->attachRow((int) $t['id'], null, 'proof', basename($dest), $res['path'], 'image/webp', 'VisionAI', $eventId);
    }

    public function attachment(int $ticketId, int $attId): ?array
    {
        $st = $this->pdo->prepare('SELECT * FROM ticket_attachments WHERE id = :a AND ticket_id = :t');
        $st->execute(['a' => $attId, 't' => $ticketId]);
        return $st->fetch() ?: null;
    }

    private function attachRow(int $ticketId, ?int $messageId, string $kind, string $name, string $path, string $mime, string $by, ?int $eventId): array
    {
        $rel = ltrim(substr($path, strlen($this->storageDir)), '/');   // stored relative to storage/
        $row = [
            'ticket_id' => $ticketId, 'message_id' => $messageId, 'kind' => $kind, 'filename' => $name,
            'stored_path' => $rel, 'mime' => $mime, 'size_bytes' => (int) filesize($path),
            'sha256' => hash_file('sha256', $path), 'event_id' => $eventId, 'uploaded_by' => $by,
            'created_at' => date('Y-m-d H:i:s'),
        ];
        $cols = array_keys($row);
        $this->pdo->prepare('INSERT INTO ticket_attachments (' . implode(',', $cols) . ') VALUES (:' . implode(',:', $cols) . ')')
            ->execute($row);
        $row['id'] = (int) $this->pdo->lastInsertId();
        $this->update($ticketId, ['updated_at' => $row['created_at']]);
        return ['id' => $row['id'], 'kind' => $kind, 'filename' => $name, 'mime' => $mime, 'size' => $row['size_bytes'],
                'url' => '/api/tickets/' . $ticketId . '/attachments/' . $row['id']];
    }

    /** Absolute path of an attachment row (guarded to stay inside storage/). */
    public function attachmentPath(array $a): ?string
    {
        $path = realpath($this->storageDir . '/' . ltrim((string) $a['stored_path'], '/'));
        $root = realpath($this->storageDir);
        return ($path && $root && str_starts_with($path, $root . '/') && is_file($path)) ? $path : null;
    }

    public function update(int $id, array $set): void
    {
        if (!$set) {
            return;
        }
        $parts = [];
        foreach (array_keys($set) as $k) {
            $parts[] = $k . ' = :' . $k;
        }
        $set['__id'] = $id;
        $this->pdo->prepare('UPDATE tickets SET ' . implode(', ', $parts) . ' WHERE id = :__id')->execute($set);
    }

    /** Aggregate counts for dashboards / reports over [from, to]. */
    public function stats(?string $from = null, ?string $to = null, ?int $requesterId = null): array
    {
        $where = [];
        $args  = [];
        if ($from) {
            $where[] = 'created_at >= :f';
            $args['f'] = $from;
        }
        if ($to) {
            $where[] = 'created_at <= :t';
            $args['t'] = $to;
        }
        if ($requesterId !== null) {
            $where[] = 'requester_user_id = :r';
            $args['r'] = $requesterId;
        }
        $st = $this->pdo->prepare('SELECT * FROM tickets' . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . ' ORDER BY id DESC LIMIT 2000');
        $st->execute($args);
        $out = ['total' => 0, 'by_status' => array_fill_keys(self::STATUSES, 0), 'by_priority' => array_fill_keys(self::PRIORITIES, 0),
                'by_category' => [], 'response_breached' => 0, 'resolution_breached' => 0, 'mtta_min' => null, 'mttr_min' => null];
        $ack = [];
        $res = [];
        foreach ($st->fetchAll() as $t) {
            $out['total']++;
            $out['by_status'][$t['status']] = ($out['by_status'][$t['status']] ?? 0) + 1;
            $out['by_priority'][$t['priority']] = ($out['by_priority'][$t['priority']] ?? 0) + 1;
            $out['by_category'][$t['category']] = ($out['by_category'][$t['category']] ?? 0) + 1;
            $sla = $this->slaState($t);
            $out['response_breached']   += $sla['response']['breached'] ? 1 : 0;
            $out['resolution_breached'] += $sla['resolution']['breached'] ? 1 : 0;
            $c = strtotime((string) $t['created_at']) ?: 0;
            if ($t['first_response_at']) {
                $ack[] = ((strtotime((string) $t['first_response_at']) ?: $c) - $c) / 60;
            }
            if ($t['resolved_at']) {
                $res[] = ((strtotime((string) $t['resolved_at']) ?: $c) - $c) / 60;
            }
        }
        $out['mtta_min'] = $ack ? round(array_sum($ack) / count($ack), 1) : null;
        $out['mttr_min'] = $res ? round(array_sum($res) / count($res), 1) : null;
        return $out;
    }
}
