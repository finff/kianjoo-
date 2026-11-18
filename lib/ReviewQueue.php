<?php
/**
 * "Needs review" queue — human intervention for low-confidence detections.
 *
 * Two sources:
 *   ai     the Claude PPE-forklift review (lib/PpeForkliftPipeline.php) said
 *          "violation" with confidence in [review.floor, ai.pipeline.min_confidence)
 *          — previously such a verdict was dropped silently. One item per
 *          person + location while it keeps re-occurring within the pipeline gap
 *          (`hits` counts the repeats).
 *   score  a NEW incident episode (lib/IncidentGroups.php) whose own detection
 *          score — SenseStudio target confidence (attribute key -1) or the face
 *          similarity — is below review.score_below (0 = off, the default).
 *          Plain face sightings below high severity never queue.
 *
 * A reviewer (supervisor+ with the `tickets` permission) decides each item:
 *   confirm  ai    → the pipeline opens / joins the episode ticket exactly like an
 *                    auto-confirmed violation, with the stored WebP proof image
 *            score → the detection's incident episode is escalated to an INC ticket
 *   reject   ai    → closed, no ticket (ai_reviews.human_verdict = rejected)
 *            score → the incident episode is resolved as a false alarm
 * The decision (who, when, note) is stored on the item and, for AI items, on
 * ai_reviews.human_*. A claim UPDATE (status = 'pending') makes double decisions
 * impossible. New items notify reviewers through the in-app bell (at most one
 * bell entry per reviewer per 10 minutes).
 */

declare(strict_types=1);

require_once __DIR__ . '/AiSchema.php';
require_once __DIR__ . '/AiGuard.php';
require_once __DIR__ . '/ImageTool.php';
require_once __DIR__ . '/DashboardMapper.php';
require_once __DIR__ . '/EventStore.php';
require_once __DIR__ . '/Notifications.php';

final class ReviewQueue
{
    public const STATUSES = ['pending', 'confirmed', 'rejected', 'superseded'];
    private const NOTIFY_EVERY = 600;

    private string $dir;

    public function __construct(private PDO $pdo, private array $config)
    {
        $this->dir = (string) ($config['ai']['storage_dir'] ?? dirname(__DIR__) . '/storage');
    }

    public function enabled(): bool
    {
        return AiSchema::$groupsReady && ($this->config['review']['enabled'] ?? true) !== false;
    }

    public function floor(): float
    {
        return max(0.0, min(1.0, (float) ($this->config['review']['floor'] ?? 0.35)));
    }

    public function minConfidence(): float
    {
        return (float) ($this->config['ai']['pipeline']['min_confidence'] ?? 0.6);
    }

    public function scoreBelow(): float
    {
        return max(0.0, min(1.0, (float) ($this->config['review']['score_below'] ?? 0)));
    }

    /** Does a Claude violation verdict with this confidence belong in the queue? */
    public function wantsAi(?float $conf): bool
    {
        return $this->enabled() && $conf !== null && $conf >= $this->floor() && $conf < $this->minConfidence();
    }

    // ── enqueue ──────────────────────────────────────────────

    /**
     * Low-confidence Claude verdict → queue item (or +1 hit on the open one for the
     * same person + location). Returns the item id.
     *
     * @param array      $r    events row (id, uuid, stream, received_at, bk_image_url, trigger_img_url, …)
     * @param array      $v    Claude verdict (violation, confidence, reason, missing_ppe, …)
     * @param array|null $img  {bytes, mime} of the image Claude judged; $scene = it is the background frame
     */
    public function fromAiReview(array $r, int $reviewId, array $v, ?float $conf, string $pid, string $loc, string $label,
                                 string $personName, ?array $img, bool $scene, int $gapSec): ?int
    {
        if (!$this->wantsAi($conf)) {
            return null;
        }
        $key = 'ai:' . sha1($pid . '|' . $loc);
        $now = (string) ($r['received_at'] ?? date('Y-m-d H:i:s'));
        $st = $this->pdo->prepare("SELECT id, last_seen_at, confidence FROM review_queue WHERE dedup_key = :k AND status = 'pending' ORDER BY id DESC LIMIT 1");
        $st->execute(['k' => $key]);
        $open = $st->fetch();
        if ($open && abs((strtotime($now) ?: 0) - (strtotime((string) $open['last_seen_at']) ?: 0)) <= max(60, $gapSec)) {
            $this->pdo->prepare('UPDATE review_queue SET hits = hits + 1, last_seen_at = :t,
                    confidence = CASE WHEN confidence IS NULL OR confidence < :c THEN :c2 ELSE confidence END WHERE id = :id')
                ->execute(['t' => $now, 'c' => $conf, 'c2' => $conf, 'id' => (int) $open['id']]);
            return (int) $open['id'];
        }
        $missing = array_values(array_filter(array_map('strval', (array) ($v['missing_ppe'] ?? []))));
        $id = $this->insert([
            'source' => 'ai', 'event_id' => (int) $r['id'], 'event_uuid' => (string) ($r['uuid'] ?? ''), 'review_id' => $reviewId,
            'dedup_key' => $key, 'module' => 'forklift',
            'title' => mb_substr('Forklift operated without PPE?' . ($missing ? ' (' . implode(', ', $missing) . ')' : '') . ' — ' . $personName . ' @ ' . $loc, 0, 250),
            'confidence' => $conf, 'reason' => mb_substr((string) ($v['reason'] ?? ''), 0, 2000),
            'camera' => $label, 'location' => $loc, 'person_id' => $pid, 'person_name' => mb_substr($personName, 0, 160),
            'image_url' => $this->fullUrl((string) (($r['bk_image_url'] ?? '') ?: ($r['trigger_img_url'] ?? ''))),
            'meta_json' => json_encode(['verdict' => $v, 'scene' => $scene, 'threshold' => $this->minConfidence()], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            'last_seen_at' => $now,
        ], $img);
        $this->notifyReviewers();
        return $id;
    }

    /**
     * Ingest: a new incident episode whose own detection score is below the
     * configured threshold (review.score_below; 0 = off) → queue item.
     */
    public function fromEvent(array $row, array $decoded, array $attributes): ?int
    {
        $thr = $this->scoreBelow();
        if (!$this->enabled() || $thr <= 0) {
            return null;
        }
        $score = self::scoreOf($attributes, (string) ($row['similarity'] ?? ''));
        if ($score === null || $score >= $thr) {
            return null;
        }
        $ev  = ['trigger_image_type' => $row['trigger_image_type'] ?? '', 'event_type' => $row['event_type'] ?? '',
                'policy_name' => $row['policy_name'] ?? '', 'policy_desc' => $row['policy_desc'] ?? '',
                'alert_level' => $row['alert_level'] ?? '', 'person_name' => $row['person_name'] ?? '',
                'decoded' => $decoded, 'attributes' => $attributes];
        $mod = DashboardMapper::modOf($ev);
        $sev = DashboardMapper::sevOf($ev, $mod);
        if ($mod === 'face' && !in_array($sev, ['high', 'critical'], true)) {
            return null;          // a plain face sighting is not a violation to confirm
        }
        if (in_array($decoded['RaVerdict'] ?? '', ['authorized', 'outside_hours'], true)) {
            return null;          // cleared by the access rules — nothing to confirm
        }
        $cam = strtoupper((string) (($row['stream'] ?? '') ?: ($row['device_serial'] ?? '')));
        $loc = (string) (($this->config['poc']['cam_locations'] ?? [])[EventStore::streamLabel((string) (($row['stream'] ?? '') ?: ''))] ?? '');
        $id = $this->insert([
            'source' => 'score', 'event_id' => (int) $row['id'], 'event_uuid' => (string) ($row['uuid'] ?? ''), 'review_id' => null,
            'dedup_key' => 'ev:' . (int) ($row['group_id'] ?? $row['id']), 'module' => $mod,
            'title' => mb_substr(DashboardMapper::titleOf($ev, $mod), 0, 250), 'confidence' => $score,
            'reason' => sprintf('Detection score %.2f is below the review threshold %.2f.', $score, $thr),
            'camera' => $cam, 'location' => mb_substr($loc !== '' ? $loc : Text::latin((string) ($row['policy_name'] ?? ''), ''), 0, 120),
            'person_id' => (string) ($row['person_id'] ?? ''), 'person_name' => mb_substr(Text::latin((string) ($row['person_name'] ?? ''), ''), 0, 160),
            'image_url' => $this->fullUrl((string) (($row['trigger_img_url'] ?? '') ?: ($row['bk_image_url'] ?? ''))),
            'meta_json' => json_encode(['sev' => $sev, 'threshold' => $thr], JSON_UNESCAPED_SLASHES),
            'last_seen_at' => (string) ($row['received_at'] ?? date('Y-m-d H:i:s')),
        ], null);
        $this->notifyReviewers();
        return $id;
    }

    /** The detection's own score 0–1: SenseStudio target confidence (key -1), else face similarity. */
    public static function scoreOf(array $attributes, string $similarity): ?float
    {
        foreach ($attributes as $a) {
            if ((string) ($a['key'] ?? '') === '-1' && isset($a['conf']) && is_numeric($a['conf'])) {
                return max(0.0, min(1.0, (float) $a['conf']));
            }
        }
        $s = trim($similarity);
        if ($s !== '' && is_numeric($s)) {
            $f = (float) $s;
            return max(0.0, min(1.0, $f > 1 ? $f / 100 : $f));
        }
        return null;
    }

    private function insert(array $row, ?array $img): int
    {
        $row += ['status' => 'pending', 'hits' => 1, 'created_at' => date('Y-m-d H:i:s'), 'image_path' => null];
        $cols = array_keys($row);
        $this->pdo->prepare('INSERT INTO review_queue (' . implode(',', $cols) . ') VALUES (:' . implode(',:', $cols) . ')')->execute($row);
        $id = (int) $this->pdo->lastInsertId();
        if ($img !== null && !empty($img['bytes'])) {
            // Keep our own copy: SenseStudio frames expire, the proof must outlive the queue wait.
            $dest = $this->dir . '/review/' . date('Y/m') . '/rq-' . $id . '-' . bin2hex(random_bytes(4)) . '.webp';
            $res = ImageTool::toWebp((string) $img['bytes'], $dest, 82, 1920);
            if ($res) {
                $this->pdo->prepare('UPDATE review_queue SET image_path = :p WHERE id = :id')
                    ->execute(['p' => ltrim(substr($res['path'], strlen(rtrim($this->dir, '/'))), '/'), 'id' => $id]);
            }
        }
        return $id;
    }

    private function fullUrl(string $path): ?string
    {
        if ($path === '') {
            return null;
        }
        if (preg_match('#^https?://#i', $path) || preg_match('#^/?uploads/#i', $path)) {
            return preg_match('#^https?://#i', $path) ? $path : '/' . ltrim($path, '/');
        }
        $base = rtrim((string) ($this->config['images']['base'] ?? ''), '/');
        return $base === '' ? $path : $base . '/' . ltrim($path, '/');
    }

    /** An auto-confirmed ticket for the same person + location supersedes their pending AI items. */
    public function supersede(string $pid, string $loc, string $ticketNo): int
    {
        if (!AiSchema::$groupsReady) {
            return 0;
        }
        $st = $this->pdo->prepare("UPDATE review_queue SET status = 'superseded', human_user = 'VisionAI', human_at = :t,
                human_note = :n, ticket_ref = :tk WHERE dedup_key = :k AND status = 'pending'");
        $st->execute(['t' => date('Y-m-d H:i:s'), 'n' => 'A later review confirmed the violation automatically.', 'tk' => $ticketNo,
                      'k' => 'ai:' . sha1($pid . '|' . $loc)]);
        return $st->rowCount();
    }

    // ── bell ─────────────────────────────────────────────────

    /** Active users who may decide queue items (supervisor+ with `tickets`). */
    public function reviewerIds(): array
    {
        $out = [];
        $roles = Auth::roles();
        foreach ($this->pdo->query('SELECT id, role FROM users WHERE active = 1')->fetchAll() as $u) {
            $role  = (string) ($u['role'] ?: 'operator');
            $perms = $roles[$role]['perms'] ?? ($role === 'superadmin' ? Auth::DEFAULT_ROLES['admin']['perms'] : Auth::permsFor($role));
            $p = ['tier' => AiGuard::tierOf($role, $perms), 'perms' => $perms];
            if (AiGuard::atLeast($p, 'supervisor') && AiGuard::can($p, 'tickets')) {
                $out[] = (int) $u['id'];
            }
        }
        return $out;
    }

    private function notifyReviewers(): void
    {
        try {
            $mark = $this->dir . '/review_notify.last';
            if (is_file($mark) && time() - (int) @filemtime($mark) < self::NOTIFY_EVERY) {
                return;
            }
            @touch($mark);
            $n = $this->pendingCount();
            Notifications::emit($this->pdo, $this->reviewerIds(), 'review_needed',
                $n === 1 ? '1 detection needs your review' : $n . ' detections need your review',
                'Low-confidence detections are waiting in Tickets → Needs review: confirm the violation or reject it as a false alarm.',
                '#tickets/review', 'review', null);
        } catch (Throwable $e) {
            error_log('[review-queue] notify: ' . $e->getMessage());
        }
    }

    // ── read ─────────────────────────────────────────────────

    public function pendingCount(): int
    {
        return (int) $this->pdo->query("SELECT COUNT(*) FROM review_queue WHERE status = 'pending'")->fetchColumn();
    }

    public function find(int $id): ?array
    {
        $st = $this->pdo->prepare('SELECT * FROM review_queue WHERE id = :id');
        $st->execute(['id' => $id]);
        return $st->fetch() ?: null;
    }

    /** @return array{items:array, total:int, counts:array} */
    public function list(string $status, int $limit = 50, int $offset = 0): array
    {
        $limit  = max(1, min(200, $limit));
        $offset = max(0, $offset);
        $where  = $status === 'decided' ? "status <> 'pending'" : "status = 'pending'";
        $order  = $status === 'decided' ? 'COALESCE(human_at, created_at) DESC, id DESC' : 'id ASC';
        $total  = (int) $this->pdo->query('SELECT COUNT(*) FROM review_queue WHERE ' . $where)->fetchColumn();
        $rows   = $this->pdo->query('SELECT * FROM review_queue WHERE ' . $where . ' ORDER BY ' . $order . ' LIMIT ' . $limit . ' OFFSET ' . $offset)->fetchAll();
        $counts = ['pending' => 0, 'confirmed' => 0, 'rejected' => 0, 'superseded' => 0];
        foreach ($this->pdo->query('SELECT status, COUNT(*) n FROM review_queue GROUP BY status')->fetchAll() as $c) {
            $counts[(string) $c['status']] = (int) $c['n'];
        }
        return ['items' => array_map([$this, 'present'], $rows), 'total' => $total, 'counts' => $counts,
                'limit' => $limit, 'offset' => $offset,
                'thresholds' => ['floor' => $this->floor(), 'min_confidence' => $this->minConfidence(), 'score_below' => $this->scoreBelow(),
                                 'enabled' => $this->enabled()]];
    }

    public function present(array $r): array
    {
        $meta = json_decode((string) ($r['meta_json'] ?? ''), true) ?: [];
        $v = (array) ($meta['verdict'] ?? []);
        return [
            'id' => (int) $r['id'], 'source' => (string) $r['source'], 'status' => (string) $r['status'],
            'event_id' => $r['event_id'] !== null ? (int) $r['event_id'] : null, 'event_uuid' => (string) ($r['event_uuid'] ?? ''),
            'module' => (string) ($r['module'] ?? ''), 'title' => (string) ($r['title'] ?? ''),
            'confidence' => $r['confidence'] !== null ? round((float) $r['confidence'], 3) : null,
            'threshold' => isset($meta['threshold']) ? (float) $meta['threshold'] : null,
            'reason' => (string) ($r['reason'] ?? ''), 'camera' => (string) ($r['camera'] ?? ''), 'location' => (string) ($r['location'] ?? ''),
            'person_id' => (string) ($r['person_id'] ?? ''), 'person_name' => (string) ($r['person_name'] ?? ''),
            'missing' => array_values(array_map('strval', (array) ($v['missing_ppe'] ?? []))),
            'helmet' => $v['helmet'] ?? null, 'vest' => $v['vest'] ?? null,
            'image' => !empty($r['image_path']) ? '/api/review/' . (int) $r['id'] . '/image' : ($r['image_url'] ?: null),
            'image_source' => !empty($r['image_url']) ? (string) $r['image_url'] : null,
            'hits' => (int) ($r['hits'] ?? 1), 'created_at' => (string) $r['created_at'], 'last_seen_at' => (string) ($r['last_seen_at'] ?? ''),
            'human_user' => $r['human_user'], 'human_note' => $r['human_note'], 'human_at' => $r['human_at'], 'ticket' => $r['ticket_ref'],
        ];
    }

    /** Absolute path of the stored WebP (guarded to stay inside storage/), or null. */
    public function imagePath(array $r): ?string
    {
        if (empty($r['image_path'])) {
            return null;
        }
        $path = realpath(rtrim($this->dir, '/') . '/' . ltrim((string) $r['image_path'], '/'));
        $root = realpath($this->dir);
        return ($path && $root && str_starts_with(str_replace('\\', '/', $path), str_replace('\\', '/', $root) . '/') && is_file($path)) ? $path : null;
    }

    // ── decide ───────────────────────────────────────────────

    /**
     * Record a reviewer decision. $verdict: confirm | reject.
     * @return array{item:array, ticket:?string}
     * @throws DomainException already decided, InvalidArgumentException bad input, RuntimeException action failed
     */
    public function decide(int $id, string $verdict, string $note, array $p): array
    {
        if (!in_array($verdict, ['confirm', 'reject'], true)) {
            throw new InvalidArgumentException('verdict must be confirm or reject.');
        }
        $note = mb_substr(trim($note), 0, 1000);
        $item = $this->find($id);
        if (!$item) {
            throw new InvalidArgumentException('Review item not found.');
        }
        $now  = date('Y-m-d H:i:s');
        $to   = $verdict === 'confirm' ? 'confirmed' : 'rejected';
        $name = (string) ($p['name'] ?? 'Reviewer');
        // Claim: only one reviewer can decide an item.
        $claim = $this->pdo->prepare("UPDATE review_queue SET status = :s, human_user = :u, human_user_id = :uid, human_note = :n, human_at = :t
                                      WHERE id = :id AND status = 'pending'");
        $claim->execute(['s' => $to, 'u' => mb_substr($name, 0, 120), 'uid' => (int) ($p['id'] ?? 0) ?: null,
                         'n' => $note !== '' ? $note : null, 't' => $now, 'id' => $id]);
        if ($claim->rowCount() !== 1) {
            $cur = $this->find($id);
            throw new DomainException('This item was already decided' . ($cur && $cur['human_user'] ? ' by ' . $cur['human_user'] : '') . '.');
        }
        try {
            $ticket = $item['source'] === 'ai' ? $this->decideAi($item, $verdict, $note, $p) : $this->decideScore($item, $verdict, $note, $name);
        } catch (Throwable $e) {
            // Put it back so the decision can be retried.
            $this->pdo->prepare("UPDATE review_queue SET status = 'pending', human_user = NULL, human_user_id = NULL, human_note = NULL, human_at = NULL WHERE id = :id")
                ->execute(['id' => $id]);
            throw $e instanceof RuntimeException || $e instanceof DomainException ? $e : new RuntimeException($e->getMessage(), 0, $e);
        }
        if ($ticket !== null) {
            $this->pdo->prepare('UPDATE review_queue SET ticket_ref = :t WHERE id = :id')->execute(['t' => $ticket, 'id' => $id]);
        }
        return ['item' => $this->present($this->find($id) ?? $item), 'ticket' => $ticket];
    }

    private function decideAi(array $item, string $verdict, string $note, array $p): ?string
    {
        $ticket = null;
        if ($verdict === 'confirm') {
            require_once __DIR__ . '/PpeForkliftPipeline.php';
            $t = (new PpeForkliftPipeline($this->pdo, $this->config))->confirmFromReview($item, $this->imagePath($item), $p, $note);
            $ticket = (string) ($t['ticket_no'] ?? '');
        }
        if (!empty($item['review_id'])) {
            $this->pdo->prepare('UPDATE ai_reviews SET human_verdict = :v, human_user = :u, human_note = :n, human_at = :t WHERE id = :id')
                ->execute(['v' => $verdict === 'confirm' ? 'confirmed' : 'rejected', 'u' => mb_substr((string) ($p['name'] ?? ''), 0, 120),
                           'n' => $note !== '' ? $note : null, 't' => date('Y-m-d H:i:s'), 'id' => (int) $item['review_id']]);
        }
        return $ticket ?: null;
    }

    private function decideScore(array $item, string $verdict, string $note, string $name): ?string
    {
        require_once __DIR__ . '/EventStore.php';
        $store = new EventStore($this->pdo, $this->config);
        $ref = (string) ($item['event_uuid'] ?: $item['event_id']);
        if ($ref === '' || !($store->find($ref) ?? (ctype_digit($ref) ? $store->findById((int) $ref) : null))) {
            if ($verdict === 'reject') {
                return null;     // nothing left to close
            }
            throw new RuntimeException('The detection behind this item no longer exists.');
        }
        if ($verdict === 'confirm') {
            $no = $store->ticket($ref, $name);
            $store->addLog($ref, 'review', $name, 'needs_review', 'confirmed',
                'Confirmed as a violation after human review' . ($note !== '' ? ' — ' . $note : ''));
            return $no;
        }
        $store->addLog($ref, 'review', $name, 'needs_review', 'false_alarm',
            'Rejected as a false alarm after human review' . ($note !== '' ? ' — ' . $note : ''));
        $store->setStatus($ref, 'resolved', $name);
        return null;
    }
}
