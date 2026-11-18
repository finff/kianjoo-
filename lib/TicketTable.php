<?php
/**
 * Unified, server-paginated Tickets table: ITSM tickets (lib/Tickets.php,
 * `tickets` table) and escalated detection incidents (`events` rows with a
 * ticket_no INC-…, lib/EventStore.php) in ONE sorted, filtered, paged list,
 * plus global header KPIs over both stores.
 *
 *   GET /tickets/table  ?page&per_page(10–100)&sort&dir&q&type&status&priority&camera
 *                       &quick=breached|due_1h|unassigned (KPI drill-down: open rows matching
 *                        the same predicate stats() counts with — quickMatch())
 *   → {rows[], total, page, per_page, stats{open, tickets_open, incidents_open,
 *      breached, due_1h, unassigned, closed_7d}, capped}
 *
 * Pagination: each store runs its own query with WHERE / ORDER BY / LIMIT
 * pushed into SQL (top page*per_page rows of that store in the requested
 * order), the two pre-sorted pages are merged in PHP with the SAME
 * comparator (key, created_at, store id) and sliced. Filters or sorts that
 * depend on PHP-derived values (incident severity, title, SLA) fall back to
 * a bounded candidate set (newest CAP rows of that store), filtered and
 * sorted in PHP; `capped` reports when that bound was hit.
 *
 * Incident semantics mirror the incident workspace (app.js slaOf / feed.php):
 *   priority = severity_override ?: DashboardMapper::sevOf (alertLevel + hazards)
 *   status   = events.status: open | ack | resolved (NULL/unknown = open)
 *   SLA      = Reporter::SLA[sev].resolve minutes from the detection time
 *              (trigger_time, else received_at); met/breached at resolved_at.
 *
 * RBAC (same as GET /tickets): ticket workers see every ticket + incidents;
 * everyone else sees only tickets they raised, never incidents or cameras.
 */

declare(strict_types=1);

require_once __DIR__ . '/Tickets.php';
require_once __DIR__ . '/EventStore.php';
require_once __DIR__ . '/DashboardMapper.php';
require_once __DIR__ . '/Insights.php';   // Reporter::SLA — the incident SLA policy (also served by feed.php)
require_once __DIR__ . '/IncidentGroups.php';   // one incident row per episode of repeated detections

final class TicketTable
{
    public const SORTS = ['created', 'updated', 'priority', 'status', 'no', 'camera', 'sla'];
    /** Per-store candidate ceiling (PHP-side filter/sort path and deep pages). */
    public const CAP = 2000;

    private const PRIO_RANK   = ['low' => 0, 'medium' => 1, 'high' => 2, 'critical' => 3];
    private const STATUS_RANK = ['new' => 0, 'open' => 0, 'ack' => 1, 'in_progress' => 2, 'resolved' => 3, 'closed' => 4];
    private const EV_STATUSES = ['open', 'ack', 'resolved'];
    private const STATUS_ALIAS = ['acknowledged' => 'ack'];
    public const QUICK = ['breached', 'due_1h', 'unassigned'];
    /** events columns an incident row needs (DashboardMapper::incident + SLA). */
    private const EV_COLS = 'id, uuid, stream, device_serial, device_name, policy_name, policy_desc, trigger_image_type, event_type,
        alert_level, person_name, person_id, similarity, feed_kind, trigger_time, trigger_img_url, bk_image_url, match_image_url,
        attributes_json, decoded_json, raw_json, received_at, status, assignee, acked_at, resolved_at, severity_override,
        ticketed_at, ticket_no, esc_level, esc_at, esc_min';

    private bool $sq;
    private EventStore $store;
    private array $slaPolicy;

    public function __construct(private PDO $pdo, private array $config, private ?string $storageDir = null, private ?Tickets $tk = null)
    {
        $this->sq    = Database::driver() === 'sqlite';
        $this->store = new EventStore($pdo, $config);
        $this->tk  ??= new Tickets($pdo, $storageDir ?? (APP_ROOT . '/storage'));
        $this->slaPolicy = $this->tk->slaPolicy();   // read once (slaState() re-reads the file per row)
    }

    /** Normalise query-string params (unknown values fall back to defaults). */
    public static function params(array $g): array
    {
        $csv = static function ($v, array $allowed): array {
            $out = [];
            foreach (explode(',', strtolower((string) $v)) as $s) {
                $s = self::STATUS_ALIAS[trim($s)] ?? trim($s);
                if ($s !== '' && in_array($s, $allowed, true) && !in_array($s, $out, true)) {
                    $out[] = $s;
                }
            }
            return $out;
        };
        $sort = strtolower((string) ($g['sort'] ?? 'created'));
        $type = strtolower((string) ($g['type'] ?? 'all'));
        return [
            'page'     => max(1, (int) ($g['page'] ?? 1)),
            'per_page' => max(10, min(100, (int) ($g['per_page'] ?? 25))),
            'sort'     => in_array($sort, self::SORTS, true) ? $sort : 'created',
            'dir'      => strtolower((string) ($g['dir'] ?? 'desc')) === 'asc' ? 'asc' : 'desc',
            'q'        => mb_substr(trim((string) ($g['q'] ?? '')), 0, 80),
            'type'     => in_array($type, ['all', 'ticket', 'incident'], true) ? $type : 'all',
            'status'   => $csv($g['status'] ?? '', array_merge(['open'], Tickets::STATUSES, self::EV_STATUSES)),
            'priority' => $csv($g['priority'] ?? '', array_keys(self::PRIO_RANK)),
            'camera'   => mb_substr(trim((string) ($g['camera'] ?? '')), 0, 191),
            // KPI-tile drill-down: open rows only, same predicate as stats() (quickMatch).
            'quick'    => in_array($g['quick'] ?? '', self::QUICK, true) ? (string) $g['quick'] : '',
        ];
    }

    /** One page of the merged table + global KPIs. */
    public function table(array $get, array $p): array
    {
        $this->ensureIndex();
        $f      = self::params($get);
        $worker = Tickets::isWorker($p);
        if (!$worker) {
            // incidents are camera internals: workers only (type=incident → empty, never own tickets)
            $f['type']   = $f['type'] === 'incident' ? 'none' : 'ticket';
            $f['camera'] = '';
            if ($f['sort'] === 'camera') {
                $f['sort'] = 'created';
            }
        }
        $need = min($f['page'] * $f['per_page'], self::CAP);

        $tk = in_array($f['type'], ['all', 'ticket'], true) ? $this->ticketPart($f, $p, $worker, $need) : ['rows' => [], 'total' => 0, 'capped' => false];
        $ev = in_array($f['type'], ['all', 'incident'], true) ? $this->incidentPart($f, $need) : ['rows' => [], 'total' => 0, 'capped' => false];

        $rows = array_merge($tk['rows'], $ev['rows']);
        usort($rows, self::comparator($f['dir']));
        $rows = array_slice($rows, ($f['page'] - 1) * $f['per_page'], $f['per_page']);
        $rows = $this->enrich($rows, $worker);

        return [
            'rows'     => array_map(static fn ($r) => array_diff_key($r, ['_k' => 1, '_c' => 1, '_s' => 1, '_q' => 1, '_ua' => 1]), $rows),
            'total'    => $tk['total'] + $ev['total'],
            'page'     => $f['page'],
            'per_page' => $f['per_page'],
            'sort'     => $f['sort'],
            'dir'      => $f['dir'],
            'stats'    => $this->stats($p),
            'capped'   => $tk['capped'] || $ev['capped'] || $f['page'] * $f['per_page'] > self::CAP,
        ];
    }

    // ── Merge ordering ───────────────────────────────────────

    /**
     * Row order shared by both stores: sort key (_k), then created_at (_c),
     * then the store's own numeric id (_s) — identical to each store's SQL
     * ORDER BY, so a per-store top-N in SQL equals the per-store top-N here.
     */
    public static function comparator(string $dir): callable
    {
        $m = $dir === 'asc' ? 1 : -1;
        return static function (array $a, array $b) use ($m): int {
            $c = (is_string($a['_k']) || is_string($b['_k']))
                ? strcasecmp((string) $a['_k'], (string) $b['_k'])
                : ($a['_k'] <=> $b['_k']);
            if ($c === 0) {
                $c = strcmp((string) $a['_c'], (string) $b['_c']);
            }
            if ($c === 0) {
                $c = strcmp($a['type'], $b['type']);
            }
            if ($c === 0) {
                $c = $a['_s'] <=> $b['_s'];
            }
            return $c * $m;
        };
    }

    // ── ITSM tickets ─────────────────────────────────────────

    private function ticketPart(array $f, array $p, bool $worker, int $need): array
    {
        $where = [];
        $args  = [];
        if (!$worker) {
            $where[] = 'requester_user_id = :me';
            $args['me'] = (int) $p['id'];
        }
        if ($f['status']) {
            $or = [];
            if (in_array('open', $f['status'], true)) {
                $or[] = "status NOT IN ('resolved','closed')";
            }
            $in = [];
            foreach (array_values(array_intersect($f['status'], Tickets::STATUSES)) as $i => $s) {
                $in[] = ':st' . $i;
                $args['st' . $i] = $s;
            }
            if ($in) {
                $or[] = 'status IN (' . implode(',', $in) . ')';
            }
            if (!$or) {
                return ['rows' => [], 'total' => 0, 'capped' => false];   // only incident statuses asked for
            }
            $where[] = '(' . implode(' OR ', $or) . ')';
        }
        if ($f['priority']) {
            $in = [];
            foreach ($f['priority'] as $i => $s) {
                $in[] = ':pr' . $i;
                $args['pr' . $i] = $s;
            }
            $where[] = 'priority IN (' . implode(',', $in) . ')';
        }
        if ($f['camera'] !== '') {
            $where[] = 'UPPER(camera) = UPPER(:cam)';
            $args['cam'] = $f['camera'];
        }
        if ($f['q'] !== '') {
            $cols = ['ticket_no', 'title', 'location', 'assignee_name', 'person_id', 'requester_name'];
            if ($worker) {
                $cols[] = 'camera';
            }
            $or = [];
            foreach ($cols as $i => $c) {
                $or[] = $c . ' LIKE :q' . $i;
                $args['q' . $i] = '%' . $f['q'] . '%';
            }
            $where[] = '(' . implode(' OR ', $or) . ')';
        }
        if ($f['quick'] !== '') {
            $where[] = "status NOT IN ('resolved','closed')";   // quick tiles count open items only
        }
        $sqlW = $where ? ' WHERE ' . implode(' AND ', $where) : '';

        $keyExpr = [
            'created'  => 'created_at',
            'updated'  => 'updated_at',
            'priority' => "CASE priority WHEN 'critical' THEN 3 WHEN 'high' THEN 2 WHEN 'medium' THEN 1 ELSE 0 END",
            'status'   => "CASE status WHEN 'ack' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'resolved' THEN 3 WHEN 'closed' THEN 4 ELSE 0 END",
            // UPPER(): SQLite orders binary; PHP merge compares case-insensitively (as MySQL _ci does).
            'no'       => "UPPER(COALESCE(ticket_no, ''))",
            'camera'   => "UPPER(COALESCE(camera, ''))",
        ][$f['sort']] ?? null;   // sla: PHP-side
        $now = time();

        if ($keyExpr !== null && $f['quick'] === '') {
            $cnt = $this->pdo->prepare('SELECT COUNT(*) FROM tickets' . $sqlW);
            $cnt->execute($args);
            $total = (int) $cnt->fetchColumn();
            $d  = strtoupper($f['dir']);
            $st = $this->pdo->prepare('SELECT * FROM tickets' . $sqlW
                . " ORDER BY {$keyExpr} {$d}, created_at {$d}, id {$d} LIMIT " . $need);
            $st->execute($args);
            $rows = array_map(fn ($t) => $this->ticketRow($t, $f['sort'], $worker, $now), $st->fetchAll());
            return ['rows' => $rows, 'total' => $total, 'capped' => false];
        }
        $st = $this->pdo->prepare('SELECT * FROM tickets' . $sqlW . ' ORDER BY id DESC LIMIT ' . self::CAP);
        $st->execute($args);
        $raw  = $st->fetchAll();
        $rows = array_map(fn ($t) => $this->ticketRow($t, $f['sort'], $worker, $now), $raw);
        if ($f['quick'] !== '') {
            $rows = array_values(array_filter($rows, static fn ($r) => self::quickMatch($f['quick'], $r['sla'], $r['_ua'])));
        }
        usort($rows, self::comparator($f['dir']));
        return ['rows' => array_slice($rows, 0, $need), 'total' => count($rows), 'capped' => count($raw) >= self::CAP];
    }

    private function ticketRow(array $t, string $sort, bool $worker, int $now): array
    {
        $sla = $this->ticketSla($t, $now);
        $r = [
            'type' => 'ticket', 'id' => (int) $t['id'], 'no' => (string) ($t['ticket_no'] ?? ''), 'title' => (string) $t['title'],
            'status' => (string) $t['status'], 'priority' => (string) $t['priority'],
            'camera' => $worker ? ($t['camera'] ?: null) : null, 'location' => $t['location'] ?: null,
            'assignee' => $t['assignee_name'] ?: null,
            'created_at' => $t['created_at'], 'updated_at' => $t['updated_at'] ?: $t['created_at'],
            'image' => null, 'comments' => 0, 'attachments' => 0, 'sla' => $sla,
        ];
        if ($worker && (int) ($t['detection_count'] ?? 0) > 0) {
            // Pipeline tickets merge their own episode (PpeForkliftPipeline) — same contract fields.
            $r += self::episode((string) ($t['event_first_at'] ?? ''), ['group_count' => $t['detection_count'], 'group_last_at' => $t['event_last_at'] ?? null]);
        }
        return $r + ['_k' => self::sortKey($r, $sort), '_c' => (string) $t['created_at'], '_s' => (int) $t['id'],
                     '_ua' => $t['assignee_user_id'] === null];   // ITSM "unassigned" = no assignee user (as stats())
    }

    /**
     * Unified SLA for an ITSM ticket, same breach rules as Tickets::slaState():
     * the live deadline is the response target while it is still unmet on an
     * open ticket, else the resolution target. breached = either one breached.
     */
    public function ticketSla(array $t, ?int $now = null): ?array
    {
        $now    = $now ?? time();
        $closed = in_array($t['status'], ['resolved', 'closed'], true);
        $ts     = static fn ($v) => $v ? (strtotime((string) $v) ?: null) : null;
        $calc   = static function (?int $due, ?int $met) use ($now): bool {
            return $due !== null && ($met !== null ? $met > $due : $now > $due);
        };
        $respDue = $ts($t['response_due_at'] ?? null);
        $respMet = $ts($t['first_response_at'] ?? null);
        $resDue  = $ts($t['resolution_due_at'] ?? null);
        $resMet  = $ts($t['resolved_at'] ?? null);
        if ($respDue === null && $resDue === null) {
            return null;
        }
        $breached = $calc($respDue, $respMet) || $calc($resDue, $resMet);
        [$due, $met, $dueRaw] = (!$closed && $respMet === null && $respDue !== null)
            ? [$respDue, null, $t['response_due_at']]
            : [$resDue ?? $respDue, $closed ? ($resMet ?? $now) : null, $t['resolution_due_at'] ?? $t['response_due_at']];
        $start = $ts($t['created_at'] ?? null) ?? $due;
        return self::slaShape((string) $dueRaw, $start, $due, $met ?? $now, $breached);
    }

    // ── Incidents (escalated detections) ─────────────────────

    private function incidentPart(array $f, int $need): array
    {
        $where = ["ticket_no IS NOT NULL AND ticket_no <> ''"];
        if (($lw = IncidentGroups::leaderWhere()) !== '') {
            $where[] = $lw;   // one row per incident episode
        }
        $args  = [];
        $stCol = "COALESCE(NULLIF(status, ''), 'open')";
        if ($f['status']) {
            $or = [];
            if (in_array('open', $f['status'], true)) {
                $or[] = "{$stCol} <> 'resolved'";
            }
            $in = [];
            foreach (array_values(array_intersect($f['status'], self::EV_STATUSES)) as $i => $s) {
                $in[] = ':st' . $i;
                $args['st' . $i] = $s;
            }
            if ($in) {
                $or[] = "{$stCol} IN (" . implode(',', $in) . ')';
            }
            if (!$or) {
                return ['rows' => [], 'total' => 0, 'capped' => false];   // only ITSM-only statuses asked for
            }
            $where[] = '(' . implode(' OR ', $or) . ')';
        }
        $camExpr = "UPPER(CASE WHEN stream IS NULL OR stream = '' THEN COALESCE(device_serial, 'CAM') ELSE stream END)";
        if ($f['camera'] !== '') {
            $where[] = "{$camExpr} = UPPER(:cam)";
            $args['cam'] = $f['camera'];
        }
        if ($f['quick'] !== '') {
            $where[] = "{$stCol} <> 'resolved'";   // quick tiles count open items only
        }
        $sqlW = ' WHERE ' . implode(' AND ', $where);
        $d    = strtoupper($f['dir']);
        $now  = time();

        $keyExpr = [
            'created' => 'received_at',
            'updated' => $this->evUpdatedExpr(),
            'status'  => "CASE {$stCol} WHEN 'ack' THEN 1 WHEN 'resolved' THEN 3 ELSE 0 END",
            'no'      => 'UPPER(ticket_no)',
            'camera'  => $camExpr,
        ][$f['sort']] ?? null;   // priority / sla: PHP-side (severity is derived)
        // q also matches the derived title; priority filters the derived severity.
        // quick predicates use the PHP-derived SLA.
        $pushable = $keyExpr !== null && $f['q'] === '' && !$f['priority'] && $f['quick'] === '';

        if ($pushable) {
            $cnt = $this->pdo->prepare('SELECT COUNT(*) FROM events' . $sqlW);
            $cnt->execute($args);
            $total = (int) $cnt->fetchColumn();
            $st = $this->pdo->prepare('SELECT ' . $this->evCols() . ', ' . $this->evUpdatedExpr() . ' AS upd_at FROM events' . $sqlW
                . " ORDER BY {$keyExpr} {$d}, received_at {$d}, id {$d} LIMIT " . $need);
            $st->execute($args);
            $rows = array_map(fn ($e) => $this->incidentRow($e, $f['sort'], $now), $st->fetchAll());
            return ['rows' => $rows, 'total' => $total, 'capped' => false];
        }
        $st = $this->pdo->prepare('SELECT ' . $this->evCols() . ', ' . $this->evUpdatedExpr() . ' AS upd_at FROM events' . $sqlW
            . ' ORDER BY id DESC LIMIT ' . self::CAP);
        $st->execute($args);
        $raw  = $st->fetchAll();
        $rows = [];
        foreach ($raw as $e) {
            $r = $this->incidentRow($e, $f['sort'], $now);
            if ($f['priority'] && !in_array($r['priority'], $f['priority'], true)) {
                continue;
            }
            if ($f['q'] !== '' && mb_stripos($r['_q'], $f['q']) === false) {
                continue;
            }
            if ($f['quick'] !== '' && !self::quickMatch($f['quick'], $r['sla'], $r['_ua'])) {
                continue;
            }
            $rows[] = $r;
        }
        usort($rows, self::comparator($f['dir']));
        return ['rows' => array_slice($rows, 0, $need), 'total' => count($rows), 'capped' => count($raw) >= self::CAP];
    }

    /** Columns an incident row needs (+ the episode columns once they exist). */
    private function evCols(): string
    {
        return self::EV_COLS . (IncidentGroups::ready() ? ', group_id, group_count, group_last_at' : '');
    }

    /** Latest activity on an incident: detection (latest of the episode), ticketing, ack, resolve, last log entry. */
    private function evUpdatedExpr(): string
    {
        $b = "COALESCE(received_at, '1970-01-01 00:00:00')";
        $parts = [$b, "COALESCE(ticketed_at, {$b})", "COALESCE(acked_at, {$b})", "COALESCE(resolved_at, {$b})",
                  "COALESCE((SELECT MAX(l.created_at) FROM incident_log l WHERE l.uuid = events.uuid), {$b})"];
        if (IncidentGroups::ready()) {
            $parts[] = "COALESCE(group_last_at, {$b})";
        }
        return ($this->sq ? 'MAX(' : 'GREATEST(') . implode(', ', $parts) . ')';
    }

    /** Hydrate an events row the way EventStore::hydrate() does. */
    private function hydrate(array $row): array
    {
        foreach (['attributes_json' => 'attributes', 'decoded_json' => 'decoded', 'raw_json' => 'raw'] as $col => $out) {
            $row[$out] = isset($row[$col]) && $row[$col] !== null ? json_decode((string) $row[$col], true) : null;
            unset($row[$col]);
        }
        $row['images'] = [
            'trigger'    => $this->store->fullUrl($row['trigger_img_url'] ?? null),
            'background' => $this->store->fullUrl($row['bk_image_url'] ?? null),
            'match'      => $this->store->fullUrl($row['match_image_url'] ?? null),
        ];
        return $row;
    }

    private function incidentRow(array $e, string $sort, int $now): array
    {
        $upd = (string) ($e['upd_at'] ?? '');
        $inc = DashboardMapper::incident($this->hydrate($e));
        $sla = self::incidentSla($inc, $now);
        $r = [
            'type' => 'incident', 'id' => (string) $inc['id'], 'no' => (string) $e['ticket_no'], 'title' => (string) $inc['title'],
            'status' => $inc['status'], 'priority' => $inc['sev'],
            'camera' => $inc['camera'] ?: null, 'location' => $inc['zone'] ?: null,
            'assignee' => ($e['assignee'] ?? '') !== '' ? (string) $e['assignee'] : null,
            'created_at' => $e['received_at'],
            'updated_at' => ($upd !== '' && $upd !== '1970-01-01 00:00:00') ? $upd : $e['received_at'],
            'image' => $inc['image'] ?: ($inc['imageBk'] ?: null), 'comments' => 0, 'attachments' => 0, 'sla' => $sla,
        ] + self::episode((string) $e['received_at'], $e);
        $q = implode(' ', [$r['no'], $r['title'], $r['camera'], $r['location'], $r['assignee'], $inc['person'], $inc['personId'], $e['device_name'] ?? '']);
        return $r + ['_k' => self::sortKey($r, $sort), '_c' => (string) $e['received_at'], '_s' => (int) $e['id'], '_q' => $q,
                     '_ua' => (string) ($e['assignee'] ?? '') === ''];
    }

    /**
     * Shared contract "Incident group": detection_count, event_first_at, event_last_at
     * (+ duration_s) for an incident row; an ungrouped row is a one-detection episode.
     */
    private static function episode(string $first, array $e): array
    {
        $last = (string) (($e['group_last_at'] ?? '') ?: $first);
        if ($last < $first) {
            $last = $first;
        }
        return [
            'detection_count' => max(1, (int) ($e['group_count'] ?? 1)),
            'event_first_at'  => $first ?: null,
            'event_last_at'   => $last ?: null,
            'duration_s'      => max(0, (strtotime($last) ?: 0) - (strtotime($first) ?: 0)),
        ];
    }

    /**
     * Incident SLA, exactly as the incident workspace computes it (app.js
     * slaOf; feed.php serves Reporter::SLA as st.sla): resolve target by
     * severity, counted from the detection time; a resolved incident is
     * measured at resolved_at.
     */
    public static function incidentSla(array $inc, ?int $now = null): array
    {
        $now   = $now ?? time();
        $cfg   = Reporter::SLA[$inc['sev']] ?? Reporter::SLA['low'];
        $start = (int) floor(((int) $inc['ts']) / 1000);
        $due   = $start + (int) $cfg['resolve'] * 60;
        $ref   = ($inc['status'] === 'resolved') ? (int) floor(((int) ($inc['resolvedTs'] ?: $now * 1000)) / 1000) : $now;
        return self::slaShape(date('Y-m-d H:i:s', $due), $start, $due, $ref, $ref > $due);
    }

    private static function slaShape(string $dueAt, int $start, int $due, int $ref, bool $breached): array
    {
        $span = max(1, $due - $start);
        return ['due_at' => $dueAt, 'left_s' => $due - $ref, 'breached' => $breached,
                'pct' => (int) max(0, min(100, round(($ref - $start) * 100 / $span)))];
    }

    private static function sortKey(array $r, string $sort)
    {
        switch ($sort) {
            case 'updated':  return (string) $r['updated_at'];
            case 'priority': return self::PRIO_RANK[$r['priority']] ?? 0;
            case 'status':   return self::STATUS_RANK[$r['status']] ?? 0;
            case 'no':       return (string) $r['no'];
            case 'camera':   return (string) ($r['camera'] ?? '');
            case 'sla':      return $r['sla'] !== null ? (int) $r['sla']['left_s'] : PHP_INT_MAX;
            default:         return (string) $r['created_at'];
        }
    }

    // ── Page enrichment (only the rows actually returned) ────

    private function enrich(array $rows, bool $worker): array
    {
        $tids = [];
        $uids = [];
        foreach ($rows as $r) {
            if ($r['type'] === 'ticket') {
                $tids[] = (int) $r['id'];
            } else {
                $uids[] = (string) $r['id'];
            }
        }
        $tx = $tids ? $this->tk->listExtras($tids, $worker) : [];
        $ix = [];
        if ($uids) {
            $in = [];
            $args = [];
            foreach ($uids as $i => $u) {
                $in[] = ':u' . $i;
                $args['u' . $i] = $u;
            }
            $st = $this->pdo->prepare("SELECT uuid,
                    SUM(CASE WHEN kind IN ('comment','remark') THEN 1 ELSE 0 END) AS c,
                    SUM(CASE WHEN kind = 'attachment' THEN 1 ELSE 0 END) AS a
                FROM incident_log WHERE uuid IN (" . implode(',', $in) . ') GROUP BY uuid');
            $st->execute($args);
            foreach ($st->fetchAll() as $l) {
                $ix[(string) $l['uuid']] = [(int) $l['c'], (int) $l['a']];
            }
        }
        foreach ($rows as &$r) {
            if ($r['type'] === 'ticket') {
                $x = $tx[(int) $r['id']] ?? null;
                $r['comments']    = (int) ($x['message_count'] ?? 0);
                $r['attachments'] = (int) ($x['attachment_count'] ?? 0);
                $r['image']       = $x['proof_url'] ?? null;
            } else {
                [$r['comments'], $r['attachments']] = $ix[(string) $r['id']] ?? [0, 0];
            }
        }
        unset($r);
        return $rows;
    }

    // ── Header KPIs (global; RBAC-scoped, never filtered) ────

    /**
     * KPI predicate for one OPEN row — shared by stats() and the ?quick=
     * filter so a tile's count always equals its drill-down total.
     *   breached   SLA breached
     *   due_1h     SLA running, not breached, 0 ≤ left_s ≤ 3600
     *   unassigned no assignee (ITSM: assignee_user_id NULL; incident: assignee empty)
     */
    public static function quickMatch(string $quick, ?array $sla, bool $unassigned): bool
    {
        switch ($quick) {
            case 'breached':   return $sla !== null && $sla['breached'];
            case 'due_1h':     return $sla !== null && !$sla['breached'] && $sla['left_s'] >= 0 && $sla['left_s'] <= 3600;
            case 'unassigned': return $unassigned;
            default:           return true;
        }
    }

    public function stats(array $p): array
    {
        $worker = Tickets::isWorker($p);
        $now    = time();
        $since  = date('Y-m-d H:i:s', $now - 7 * 86400);
        $out    = ['open' => 0, 'tickets_open' => 0, 'incidents_open' => 0, 'breached' => 0, 'due_1h' => 0, 'unassigned' => 0, 'closed_7d' => 0];
        $tally  = static function (?array $sla, bool $unassigned) use (&$out): void {
            foreach (self::QUICK as $k) {
                $out[$k] += self::quickMatch($k, $sla, $unassigned) ? 1 : 0;
            }
        };

        $own  = $worker ? '' : ' AND requester_user_id = :me';
        $args = $worker ? [] : ['me' => (int) $p['id']];
        $st = $this->pdo->prepare("SELECT COUNT(*) FROM tickets WHERE status NOT IN ('resolved','closed')" . $own);
        $st->execute($args);
        $out['tickets_open'] = (int) $st->fetchColumn();
        $st = $this->pdo->prepare("SELECT id, status, priority, created_at, response_due_at, first_response_at, resolution_due_at,
                resolved_at, assignee_user_id FROM tickets WHERE status NOT IN ('resolved','closed')" . $own . ' ORDER BY id DESC LIMIT ' . self::CAP);
        $st->execute($args);
        foreach ($st->fetchAll() as $t) {
            $tally($this->ticketSla($t, $now), $t['assignee_user_id'] === null);
        }
        $st = $this->pdo->prepare("SELECT COUNT(*) FROM tickets WHERE status IN ('resolved','closed')
                AND COALESCE(closed_at, resolved_at, updated_at) >= :since" . $own);
        $st->execute($args + ['since' => $since]);
        $out['closed_7d'] = (int) $st->fetchColumn();

        if ($worker) {
            $lw   = IncidentGroups::leaderWhere();
            $lw   = $lw !== '' ? ' AND ' . $lw : '';   // one row per incident episode
            $open = "ticket_no IS NOT NULL AND ticket_no <> '' AND COALESCE(NULLIF(status, ''), 'open') <> 'resolved'" . $lw;
            $out['incidents_open'] = (int) $this->pdo->query('SELECT COUNT(*) FROM events WHERE ' . $open)->fetchColumn();
            foreach ($this->pdo->query('SELECT ' . $this->evCols() . ' FROM events WHERE ' . $open . ' ORDER BY id DESC LIMIT ' . self::CAP)->fetchAll() as $e) {
                $inc = DashboardMapper::incident($this->hydrate($e));
                $tally(self::incidentSla($inc, $now), (string) ($e['assignee'] ?? '') === '');
            }
            $st = $this->pdo->prepare("SELECT COUNT(*) FROM events WHERE ticket_no IS NOT NULL AND ticket_no <> ''
                    AND status = 'resolved' AND resolved_at >= :since" . $lw);
            $st->execute(['since' => $since]);
            $out['closed_7d'] += (int) $st->fetchColumn();
        }
        $out['open'] = $out['tickets_open'] + $out['incidents_open'];
        return $out;
    }

    // ── Index on events.ticket_no (lazy, off the ingest path) ──

    /**
     * Incidents are `events` rows with a ticket_no; without an index every
     * table/stats query scans the whole detections table. Created once, from
     * this (read) route only — never from Database::migrate(), so ingest is
     * untouched. Failure is logged and retried on a later call.
     */
    private function ensureIndex(): void
    {
        $marker = $this->storageDir ? rtrim($this->storageDir, '/') . '/tickets_table.ver' : null;
        if ($marker && is_file($marker)) {
            return;
        }
        try {
            if ($this->sq) {
                $this->pdo->exec('CREATE INDEX IF NOT EXISTS idx_events_ticket_no ON events(ticket_no)');
            } else {
                $st = $this->pdo->query("SELECT COUNT(*) FROM information_schema.STATISTICS
                    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'events' AND INDEX_NAME = 'idx_events_ticket_no'");
                if ((int) $st->fetchColumn() === 0) {
                    $this->pdo->exec('CREATE INDEX idx_events_ticket_no ON events (ticket_no)');
                }
            }
            if ($marker) {
                @file_put_contents($marker, '1', LOCK_EX);
            }
        } catch (Throwable $e) {
            error_log('[tickets/table] index: ' . $e->getMessage());
        }
    }
}
