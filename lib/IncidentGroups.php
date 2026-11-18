<?php
/**
 * Incident episodes — repeated detections of the same violation collapse into
 * ONE incident (one row, one alert, one triage action).
 *
 * Episode key  = sha1(module | policy | camera | person_id | zone verdict).
 *                person_id empty → camera + type only. The restricted / forklift
 *                verdict is part of the key so a cleared entry never swallows a
 *                violation by the same person.
 * Episode      = consecutive events with the same key whose gaps are
 *                ≤ incidents.merge_gap_min (Settings, 1–120, default 10 min),
 *                as long as the episode is not resolved (a detection after
 *                resolution starts a new episode).
 *
 * Persisted on `events` (lib/AiSchema.php v3):
 *   group_id       id of the episode's first event (the "leader"; leader.group_id = leader.id)
 *   group_key      the episode key (indexed with id → "previous event of this key" is one seek)
 *   group_count    detections in the episode   (leader row only)
 *   group_last_at  latest detection's received_at (leader row only)
 * NULL group_id = not grouped yet (pre-v3 rows until catch-up reaches them):
 * such rows are listed as their own one-detection incident.
 *
 * Computed at ingest (plan() before the INSERT, commit() after) plus a bounded
 * catch-up (catchUp(), piggy-backed on feed.php at most every 30 s) that walks
 * ungrouped rows oldest-first, and an orphan repair after the retention purge
 * removed a leader (the oldest surviving member is promoted).
 *
 * Shared contract (SPEC "Incident group"): rows expose detection_count,
 * event_first_at, event_last_at.
 */

declare(strict_types=1);

require_once __DIR__ . '/AiSchema.php';
require_once __DIR__ . '/DashboardMapper.php';
require_once __DIR__ . '/EventStore.php';

final class IncidentGroups
{
    /** Leader-only predicate for incident lists (unqualified `events` columns). */
    public const LEADER_SQL = '(group_id IS NULL OR group_id = id)';

    private int $gap;

    public function __construct(private PDO $pdo, private array $config)
    {
        $this->gap = self::gapSec($config);
    }

    public static function gapSec(array $config): int
    {
        return max(1, min(120, (int) ($config['incidents']['merge_gap_min'] ?? 10))) * 60;
    }

    /** Do the v3 columns exist (AiSchema migrated in this request)? */
    public static function ready(): bool
    {
        return AiSchema::$groupsReady;
    }

    /** SQL fragment that keeps one row per episode — '' when episodes are not available. */
    public static function leaderWhere(string $alias = ''): string
    {
        if (!self::ready()) {
            return '';
        }
        $a = $alias !== '' ? $alias . '.' : '';
        return '(' . $a . 'group_id IS NULL OR ' . $a . 'group_id = ' . $a . 'id)';
    }

    /**
     * Episode key of an event. $e: trigger_image_type, event_type, policy_name,
     * policy_desc, stream, device_serial, person_id + decoded (array) — the same
     * inputs at ingest and in the catch-up, so both agree.
     */
    public static function keyOf(array $e): string
    {
        $dec = is_array($e['decoded'] ?? null) ? $e['decoded'] : [];
        $mod = DashboardMapper::modOf([
            'trigger_image_type' => (string) ($e['trigger_image_type'] ?? ''), 'event_type' => (string) ($e['event_type'] ?? ''),
            'policy_name' => (string) ($e['policy_name'] ?? ''), 'policy_desc' => (string) ($e['policy_desc'] ?? ''), 'decoded' => $dec,
        ]);
        $cam = EventStore::streamLabel((string) (($e['stream'] ?? '') ?: ($e['device_serial'] ?? '')));
        $verdict = (string) (($dec['RaVerdict'] ?? '') ?: ($dec['FkVerdict'] ?? ''));
        return sha1(implode('|', [$mod, strtolower(trim((string) ($e['policy_name'] ?? ''))), $cam,
            trim((string) ($e['person_id'] ?? '')), $verdict]));
    }

    // ── ingest ───────────────────────────────────────────────

    /**
     * Which episode a new event (not inserted yet) belongs to.
     * @return array{key:string, leader:?int, status:?string}
     */
    public function plan(string $key, string $receivedAt): array
    {
        $out = ['key' => $key, 'leader' => null, 'status' => null];
        $st = $this->pdo->prepare('SELECT p.id, p.group_id, p.received_at, l.status AS lstatus, l.id AS lid
            FROM events p LEFT JOIN events l ON l.id = p.group_id
            WHERE p.group_key = :k ORDER BY p.id DESC LIMIT 1');
        $st->execute(['k' => $key]);
        $p = $st->fetch();
        if (!$p || empty($p['lid']) || !$this->joinable((string) $p['received_at'], $receivedAt, (string) ($p['lstatus'] ?? ''))) {
            return $out;
        }
        $out['leader'] = (int) $p['lid'];
        $out['status'] = (string) ($p['lstatus'] ?: 'open');
        return $out;
    }

    /** Columns to add to the INSERT row for a planned event. */
    public static function insertCols(array $plan, string $receivedAt): array
    {
        if ($plan['leader'] !== null) {
            $c = ['group_key' => $plan['key'], 'group_id' => $plan['leader']];
            if ($plan['status'] === 'ack') {
                $c['status'] = 'ack';     // joins an acknowledged episode as acknowledged
            }
            return $c;
        }
        return ['group_key' => $plan['key'], 'group_count' => 1, 'group_last_at' => $receivedAt];
    }

    /** After the INSERT: a new leader points at itself; a member bumps its leader's count / last seen. */
    public function commit(int $eventId, array $plan, string $receivedAt): void
    {
        if ($plan['leader'] === null) {
            $this->pdo->prepare('UPDATE events SET group_id = :id WHERE id = :id2')->execute(['id' => $eventId, 'id2' => $eventId]);
            return;
        }
        $this->bumpLeader((int) $plan['leader'], 1, $receivedAt);
    }

    private function bumpLeader(int $leader, int $n, string $lastAt): void
    {
        $this->pdo->prepare('UPDATE events SET group_count = COALESCE(group_count, 1) + :n,
                group_last_at = CASE WHEN group_last_at IS NULL OR group_last_at < :t THEN :t2 ELSE group_last_at END
             WHERE id = :g')->execute(['n' => $n, 't' => $lastAt, 't2' => $lastAt, 'g' => $leader]);
    }

    private function joinable(string $prevAt, string $at, string $leaderStatus): bool
    {
        if ($leaderStatus === 'resolved') {
            return false;
        }
        $a = strtotime($prevAt) ?: 0;
        $b = strtotime($at) ?: 0;
        return $a > 0 && $b > 0 && abs($b - $a) <= $this->gap;
    }

    // ── catch-up (existing rows) ─────────────────────────────

    /**
     * Throttled catch-up for the feed piggy-back: at most once per $every s,
     * one run at a time (flock), silent on failure.
     */
    public static function maybeCatchUp(PDO $pdo, array $config, int $every = 30, int $limit = 2000): ?array
    {
        if (!self::ready()) {
            return null;
        }
        $dir  = dirname((string) ($config['storage']['raw_log'] ?? (dirname(__DIR__) . '/storage/x')));
        $mark = $dir . '/incident_groups.last';
        if (is_file($mark) && time() - (int) @filemtime($mark) < $every) {
            return null;
        }
        @touch($mark);
        $lock = @fopen($dir . '/incident_groups.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
            return null;
        }
        try {
            return (new self($pdo, $config))->catchUp($limit);
        } catch (Throwable $e) {
            error_log('[incident-groups] ' . $e->getMessage());
            return null;
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    /**
     * Group up to $limit ungrouped rows (oldest first) within $budget seconds.
     * A row that already carries an incident ticket (INC) always starts its own
     * episode, so every existing incident stays listed.
     *
     * @return array{grouped:int, joined:int, leaders:int, repaired:int, remaining:bool}
     */
    public function catchUp(int $limit = 2000, float $budget = 4.0): array
    {
        $out = ['grouped' => 0, 'joined' => 0, 'leaders' => 0, 'repaired' => 0, 'remaining' => false];
        if (!self::ready()) {
            return $out;
        }
        $t0 = microtime(true);
        $out['repaired'] = $this->repairOrphans();

        $st = $this->pdo->prepare('SELECT id, stream, device_serial, policy_name, policy_desc, trigger_image_type, event_type,
                person_id, decoded_json, received_at, status, ticket_no
            FROM events WHERE group_id IS NULL ORDER BY id ASC LIMIT ' . max(1, min(5000, $limit)));
        $st->execute();
        $rows = $st->fetchAll();
        if (!$rows) {
            return $out;
        }
        $prevQ = $this->pdo->prepare('SELECT p.id, p.group_id, p.received_at, l.status AS lstatus, l.id AS lid
            FROM events p LEFT JOIN events l ON l.id = p.group_id
            WHERE p.group_key = :k AND p.id < :id AND p.group_id IS NOT NULL ORDER BY p.id DESC LIMIT 1');
        $asMember = $this->pdo->prepare('UPDATE events SET group_key = :k, group_id = :g WHERE id = :id AND group_id IS NULL');
        $asLeader = $this->pdo->prepare('UPDATE events SET group_key = :k, group_id = :id, group_count = 1, group_last_at = :t
            WHERE id = :id2 AND group_id IS NULL');

        $mem  = [];   // key → [received_at, leader id, leader status]
        $bump = [];   // leader id → [n, last received_at]
        $this->pdo->beginTransaction();
        try {
            foreach ($rows as $r) {
                if (microtime(true) - $t0 > $budget) {
                    $out['remaining'] = true;
                    break;
                }
                $id  = (int) $r['id'];
                $at  = (string) ($r['received_at'] ?? '');
                $key = self::keyOf($r + ['decoded' => json_decode((string) ($r['decoded_json'] ?? ''), true) ?: []]);
                if (!isset($mem[$key])) {
                    $prevQ->execute(['k' => $key, 'id' => $id]);
                    $p = $prevQ->fetch();
                    $mem[$key] = ($p && !empty($p['lid'])) ? [(string) $p['received_at'], (int) $p['lid'], (string) ($p['lstatus'] ?: 'open')] : null;
                }
                $prev = $mem[$key];
                $ticketed = trim((string) ($r['ticket_no'] ?? '')) !== '';
                if ($prev !== null && !$ticketed && $this->joinable($prev[0], $at, $prev[2])) {
                    $asMember->execute(['k' => $key, 'g' => $prev[1], 'id' => $id]);
                    $b = $bump[$prev[1]] ?? [0, ''];
                    $bump[$prev[1]] = [$b[0] + 1, max($b[1], $at)];
                    $mem[$key] = [$at, $prev[1], $prev[2]];
                    $out['joined']++;
                } else {
                    $asLeader->execute(['k' => $key, 'id' => $id, 't' => $at, 'id2' => $id]);
                    $mem[$key] = [$at, $id, (string) ($r['status'] ?: 'open')];
                    $out['leaders']++;
                }
                $out['grouped']++;
            }
            foreach ($bump as $leader => [$n, $last]) {
                $this->bumpLeader((int) $leader, (int) $n, (string) $last);
            }
            $this->pdo->commit();
        } catch (Throwable $e) {
            $this->pdo->rollBack();
            throw $e;
        }
        if (!$out['remaining'] && count($rows) >= $limit) {
            $out['remaining'] = true;
        }
        return $out;
    }

    /**
     * Retention deletes the oldest events first, so a purged leader leaves its
     * surviving members pointing below MIN(id). Promote each orphan episode's
     * oldest survivor to leader (bounded per run).
     */
    public function repairOrphans(int $max = 50): int
    {
        $min = (int) $this->pdo->query('SELECT COALESCE(MIN(id), 0) FROM events')->fetchColumn();
        if ($min <= 1) {
            return 0;
        }
        $st = $this->pdo->prepare('SELECT DISTINCT group_id FROM events WHERE group_id IS NOT NULL AND group_id < :m LIMIT ' . $max);
        $st->execute(['m' => $min]);
        $n = 0;
        foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $gid) {
            $q = $this->pdo->prepare('SELECT MIN(id) AS lead, COUNT(*) AS c, MAX(received_at) AS last FROM events WHERE group_id = :g');
            $q->execute(['g' => (int) $gid]);
            $r = $q->fetch();
            if (!$r || empty($r['lead'])) {
                continue;
            }
            $this->pdo->prepare('UPDATE events SET group_id = :new WHERE group_id = :g')->execute(['new' => (int) $r['lead'], 'g' => (int) $gid]);
            $this->pdo->prepare('UPDATE events SET group_count = :c, group_last_at = :l WHERE id = :id')
                ->execute(['c' => (int) $r['c'], 'l' => $r['last'], 'id' => (int) $r['lead']]);
            $n++;
        }
        return $n;
    }

    // ── read side ────────────────────────────────────────────

    /** Leader row id of an event row (the row itself when ungrouped / episodes unavailable). */
    public static function leaderIdOf(array $row): int
    {
        $gid = (int) ($row['group_id'] ?? 0);
        return $gid > 0 ? $gid : (int) ($row['id'] ?? 0);
    }

    /**
     * Episode detail for the incident / ticket detail views.
     * @return array{leader:array, group:array, members:array}|null
     */
    public function detail(EventStore $store, string $ref, int $limit = 60, int $offset = 0): ?array
    {
        $ev = $store->find($ref) ?? (ctype_digit($ref) ? $store->findById((int) $ref) : null);
        if (!$ev) {
            return null;
        }
        $gid  = self::ready() ? self::leaderIdOf($ev) : (int) $ev['id'];
        $lead = $gid === (int) $ev['id'] ? $ev : ($store->findById($gid) ?? $ev);
        $limit  = max(1, min(200, $limit));
        $offset = max(0, $offset);
        $members = [];
        $total = 1;
        if (self::ready() && (int) ($lead['group_id'] ?? 0) > 0) {
            $c = $this->pdo->prepare('SELECT COUNT(*) FROM events WHERE group_id = :g');
            $c->execute(['g' => $gid]);
            $total = max(1, (int) $c->fetchColumn());
            $st = $this->pdo->prepare('SELECT id, uuid, stream, device_serial, device_name, person_id, person_name, similarity,
                    trigger_time, received_at, trigger_img_url, bk_image_url, match_image_url, status
                FROM events WHERE group_id = :g ORDER BY id DESC LIMIT ' . $limit . ' OFFSET ' . $offset);
            $st->execute(['g' => $gid]);
            $members = $st->fetchAll();
        } else {
            $members = [$lead];
        }
        $inc = DashboardMapper::incident($lead);
        $first = (string) ($lead['received_at'] ?? '');
        $last  = (string) (($lead['group_last_at'] ?? '') ?: $first);
        if ($total > 1 && $members) {
            $last = max($last, (string) ($members[0]['received_at'] ?? ''));
        }
        return [
            'leader'  => $inc + ['eventId' => (int) $lead['id']],
            'group'   => [
                'id' => $gid, 'leader_uuid' => (string) ($lead['uuid'] ?: $lead['id']),
                'detection_count' => $total, 'event_first_at' => $first, 'event_last_at' => $last,
                'duration_s' => max(0, (strtotime($last) ?: 0) - (strtotime($first) ?: 0)),
                'status' => $inc['status'], 'ticket' => $inc['ticket'], 'gap_min' => intdiv($this->gap, 60),
                'person_known' => trim((string) ($lead['person_id'] ?? '')) !== '',
            ],
            'members' => array_map(static function (array $m) use ($store): array {
                return [
                    'id' => (string) ($m['uuid'] ?: $m['id']), 'eventId' => (int) $m['id'],
                    'time' => (string) (($m['trigger_time'] ?? '') ?: ($m['received_at'] ?? '')),
                    'received' => (string) ($m['received_at'] ?? ''),
                    'image' => $store->fullUrl($m['trigger_img_url'] ?? null),
                    'imageBk' => $store->fullUrl($m['bk_image_url'] ?? null),
                    'person' => Text::latin((string) ($m['person_name'] ?? ''), ''), 'personId' => (string) ($m['person_id'] ?? ''),
                    'similarity' => (string) ($m['similarity'] ?? ''), 'status' => (string) ($m['status'] ?: 'open'),
                ];
            }, $members),
            'total' => $total, 'limit' => $limit, 'offset' => $offset,
        ];
    }

    /**
     * feed.php: annotate the live incident list with its episodes. Members whose
     * leader is outside the poll window get that leader appended (≤ 200), so the
     * client can always collapse an episode onto its leader row. Adds
     *   groupId, groupLead, groupMember, groupCount, groupFirst, groupLast (ms), groupLeadId,
     *   groupTicket, groupStatus.
     */
    public function decorateFeed(EventStore $store, array $incidents): array
    {
        if (!self::ready() || !$incidents) {
            return $incidents;
        }
        $have = [];
        foreach ($incidents as $i => $inc) {
            if (!empty($inc['eventId'])) {
                $have[(int) $inc['eventId']] = $i;
            }
        }
        $missing = [];
        foreach ($incidents as $inc) {
            $g = (int) ($inc['groupId'] ?? 0);
            if ($g > 0 && !isset($have[$g])) {
                $missing[$g] = true;
            }
        }
        if ($missing) {
            foreach ($store->findByIds(array_slice(array_keys($missing), 0, 200)) as $row) {
                $incidents[] = DashboardMapper::incident($row);
                $have[(int) $row['id']] = count($incidents) - 1;
            }
        }
        foreach ($incidents as $i => $inc) {
            $g = (int) ($inc['groupId'] ?? 0);
            $L = $g > 0 && isset($have[$g]) ? $incidents[$have[$g]] : null;
            if ($L === null) {
                continue;
            }
            $lead  = (int) ($inc['eventId'] ?? 0) === $g;
            $first = (strtotime((string) ($L['received'] ?? '')) ?: 0) * 1000 ?: (int) $L['ts'];
            $incidents[$i]['groupLead']   = $lead;
            $incidents[$i]['groupMember'] = !$lead;
            $incidents[$i]['groupCount']  = max(1, (int) ($L['groupCount'] ?? 1));
            $incidents[$i]['groupFirst']  = $first;
            $incidents[$i]['groupLast']   = max($first, (int) ($L['groupLastTs'] ?? 0));
            $incidents[$i]['groupLeadId'] = (string) $L['id'];
            $incidents[$i]['groupTicket'] = $L['ticket'] ?? null;   // the episode's INC ticket lives on the leader
            $incidents[$i]['groupStatus'] = (string) $L['status'];
        }
        return $incidents;
    }
}
