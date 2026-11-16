<?php
/**
 * M9 — PPE-forklift ticket pipeline worker.
 *
 * Walks new face-detection events (person_id set) after a cursor and, per
 * person, asks Claude (Sonnet vision, use case `vision_review`) whether the
 * environment image shows that person operating a forklift without the
 * required PPE. Confirmed → an ITSM ticket (M7) with a WebP proof image.
 *
 * Dedup / rate rules (all persisted, so cron + web runs share them):
 *   1. Ongoing confirmed event: if an unresolved ppe_forklift ticket exists
 *      for (person_id, location) and this detection is within GAP seconds of
 *      the ticket's last detection, the ticket's span is extended
 *      (event_last_at, detection_count) and NO review is made.
 *   2. Rate gate: at most one Claude review per person_id per RATE seconds
 *      (ai_person_state.last_review_at).
 *   3. Ticket key: dedup_key = fkppe:<sha1(person|location)>:<episode start>,
 *      UNIQUE in the DB — a second worker can never create a duplicate for
 *      the same event. A detection after the gap (or after the ticket was
 *      resolved/closed) starts a new episode → a new ticket.
 *   4. Event span: event_first_at = first detection of the episode (walking
 *      back over that person's detections on the same camera while gaps
 *      ≤ GAP), event_last_at = latest detection.
 *
 * Runs under an exclusive flock, so overlapping cron / web invocations are
 * harmless. Invoke: `php bin/ai_worker.php` (cron) or
 * GET|POST /api/pipeline/run?token=PROVISION_TOKEN.
 */

declare(strict_types=1);

require_once __DIR__ . '/Claude.php';
require_once __DIR__ . '/ImageTool.php';
require_once __DIR__ . '/Tickets.php';
require_once __DIR__ . '/EventStore.php';

final class PpeForkliftPipeline
{
    public const CATEGORY = 'ppe_forklift';

    private array $opt;
    private string $dir;
    private string $appRoot;
    /** @var callable|null Test seam: fn(array $img, string $camera, string $loc, array $needed): array (Claude::json shape). */
    private $reviewer;

    public function __construct(private PDO $pdo, private array $config, ?callable $reviewer = null)
    {
        $this->reviewer = $reviewer;
        $p = (array) ($config['ai']['pipeline'] ?? []);
        $this->opt = [
            'enabled'        => (bool) ($p['enabled'] ?? true),
            'gap_sec'        => max(60, (int) ($p['gap_sec'] ?? 600)),
            'rate_sec'       => max(60, (int) ($p['rate_sec'] ?? 60)),
            'max_reviews'    => max(1, (int) ($p['max_reviews'] ?? 6)),
            'batch'          => max(10, min(1000, (int) ($p['batch'] ?? 300))),
            'max_age_sec'    => max(300, (int) ($p['max_age_sec'] ?? 1800)),
            'min_confidence' => (float) ($p['min_confidence'] ?? 0.6),
            'zone_only'      => $p['zone_only'] ?? null,     // null = auto (only forklift-zone cameras when zones exist)
            'time_budget'    => max(10, (int) ($p['time_budget'] ?? 50)),
        ];
        $this->dir     = (string) ($config['ai']['storage_dir'] ?? dirname(__DIR__) . '/storage');
        $this->appRoot = dirname(__DIR__);
    }

    /**
     * Process pending events. Returns run stats.
     *
     * @param array $o  max_reviews, dry_run (no Claude call / no writes except stats)
     */
    public function run(array $o = []): array
    {
        $stats = ['scanned' => 0, 'reviewed' => 0, 'violations' => 0, 'tickets_opened' => 0, 'tickets_extended' => 0,
                  'skipped_confirmed' => 0, 'rate_limited' => 0, 'skipped_zone' => 0, 'skipped_stale' => 0,
                  'no_image' => 0, 'errors' => 0, 'cursor' => null, 'locked' => false, 'breaches_updated' => 0];
        if (!$this->opt['enabled']) {
            // The SLA breach sweep (+ breach e-mails) still runs from this cron path.
            if (empty($o['dry_run'])) {
                try {
                    $stats['breaches_updated'] = (new Tickets($this->pdo, $this->dir))->sweepBreaches();
                } catch (Throwable $e) {
                    error_log('[ppefk] breach sweep: ' . $e->getMessage());
                }
            }
            return $stats + ['disabled' => true];
        }
        $lock = @fopen($this->dir . '/ppefk_pipeline.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
            $stats['locked'] = true;
            return $stats;
        }
        try {
            return $this->process($o, $stats);
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    private function process(array $o, array $stats): array
    {
        $t0      = time();
        $max     = max(1, (int) ($o['max_reviews'] ?? $this->opt['max_reviews']));
        $dry     = !empty($o['dry_run']);
        $claude  = Claude::fromConfig($this->config);
        $tickets = new Tickets($this->pdo, $this->dir);
        $zones   = $this->zones();
        $cursorF = $this->dir . '/ppefk_cursor.json';
        $cur     = is_file($cursorF) ? (int) ((json_decode((string) file_get_contents($cursorF), true) ?: [])['last'] ?? 0) : 0;
        if ($cur === 0) {
            // First run: start from the last max_age window, never backfill all history.
            $q = $this->pdo->prepare('SELECT MIN(id) FROM events WHERE received_at >= :f');
            $q->execute(['f' => date('Y-m-d H:i:s', time() - $this->opt['max_age_sec'])]);
            $min = (int) $q->fetchColumn();
            $cur = $min > 0 ? $min - 1 : (int) $this->pdo->query('SELECT COALESCE(MAX(id),0) FROM events')->fetchColumn();
        }

        $st = $this->pdo->prepare("SELECT id, uuid, stream, device_serial, device_name, person_id, person_name, feed_kind,
                                          trigger_time, received_at, bk_image_url, trigger_img_url, detect_json
                                   FROM events
                                   WHERE id > :c AND person_id IS NOT NULL AND person_id <> ''
                                   ORDER BY id ASC LIMIT " . $this->opt['batch']);
        $st->execute(['c' => $cur]);
        $rows = $st->fetchAll();
        $lastDone = $cur;

        foreach ($rows as $r) {
            if (time() - $t0 > $this->opt['time_budget']) {
                break;
            }
            $stats['scanned']++;
            $feed = (string) ($r['feed_kind'] ?? '');
            if ($feed !== '' && $feed !== 'face') {
                $lastDone = (int) $r['id'];
                continue;
            }
            $pid   = (string) $r['person_id'];
            $label = EventStore::streamLabel((string) ($r['stream'] ?: ($r['device_serial'] ?? '')));
            if ($zones !== null && !isset($zones[$label])) {
                $stats['skipped_zone']++;
                $lastDone = (int) $r['id'];
                continue;
            }
            $loc = $this->locationOf($label, $r);
            $ts  = strtotime((string) $r['received_at']) ?: time();

            // 1) Ongoing confirmed event → extend the ticket, skip review.
            $open = $this->openTicket($pid, $loc);
            if ($open && $ts - (strtotime((string) $open['event_last_at']) ?: 0) <= $this->opt['gap_sec']) {
                if (!$dry) {
                    $this->extend($open, $r['received_at']);
                }
                $stats['skipped_confirmed']++;
                $stats['tickets_extended']++;
                $lastDone = (int) $r['id'];
                continue;
            }
            if (time() - $ts > $this->opt['max_age_sec']) {
                $stats['skipped_stale']++;
                $lastDone = (int) $r['id'];
                continue;
            }

            // 2) Rate gate: one review per person per rate_sec.
            $state = $this->personState($pid);
            if ($state && $state['last_review_at'] && time() - (strtotime((string) $state['last_review_at']) ?: 0) < $this->opt['rate_sec']) {
                $stats['rate_limited']++;
                $lastDone = (int) $r['id'];
                continue;
            }
            if ($stats['reviewed'] >= $max) {
                break;                                  // budget spent: resume from this event next run
            }

            // 3) Environment image (background frame; trigger crop as fallback).
            $img = ImageTool::fetch($this->imageUrl((string) ($r['bk_image_url'] ?: $r['trigger_img_url'])), $this->appRoot);
            $imgIsScene = $img !== null && (string) $r['bk_image_url'] !== '';
            if ($img === null && $r['bk_image_url'] && $r['trigger_img_url']) {
                $img = ImageTool::fetch($this->imageUrl((string) $r['trigger_img_url']), $this->appRoot);
                $imgIsScene = false;
            }
            if ($img === null) {
                $stats['no_image']++;
                $lastDone = (int) $r['id'];
                continue;
            }
            if ($dry) {
                $stats['reviewed']++;
                $lastDone = (int) $r['id'];
                continue;
            }

            // 4) Claude vision review.
            $zone   = $zones[$label] ?? null;
            $needed = $zone['op_ppe'] ?? ['helmet', 'vest'];
            $res    = $this->reviewer ? ($this->reviewer)($img, $label, $loc, $needed) : $this->review($claude, $img, $label, $loc, $needed);
            $this->touchPerson($pid, (int) $r['id'], $res);
            $stats['reviewed']++;
            $v = $res['ok'] ? $res['data'] : [];
            $conf = isset($v['confidence']) ? (float) $v['confidence'] : null;
            $violation = $res['ok'] && !empty($v['violation']) && !empty($v['person_operating_forklift'])
                && ($conf === null || $conf >= $this->opt['min_confidence']);
            $reviewId = $this->logReview($r, $pid, $loc, $label, $res, $violation, $conf);
            if (!$res['ok']) {
                $stats['errors']++;
                if (in_array((int) ($res['status'] ?? 0), [401, 403, 429], true) || ($res['status'] ?? 0) >= 500) {
                    break;                              // key / quota / outage: stop, retry this event next run
                }
                $lastDone = (int) $r['id'];
                continue;
            }

            // 5) Confirmed → upsert ticket for this episode + WebP proof.
            if ($violation) {
                $stats['violations']++;
                $bbox = $imgIsScene ? self::bboxOf($r['detect_json'] ?? null, $img['bytes']) : null;
                $t = $this->openOrJoin($tickets, $r, $pid, $loc, $label, $v, $res, $reviewId, $bbox);
                if ($t['created']) {
                    $stats['tickets_opened']++;
                    $proof = $tickets->attachProof($t['ticket'], $img['bytes'], (int) $r['id']);
                    $tickets->message((int) $t['ticket']['id'], [], 'ai',
                        'AI vision review: ' . ($v['reason'] ?? 'violation confirmed')
                        . ($proof ? '' : ' — proof image could not be encoded to WebP.'), false, null, null, true);
                    $tickets->notifyCreated($t['ticket']);     // deferred "new ticket" e-mail, now with its proof link
                } else {
                    $stats['tickets_extended']++;
                }
                $this->pdo->prepare('UPDATE ai_reviews SET ticket_id = :t WHERE id = :id')
                    ->execute(['t' => $t['ticket']['id'], 'id' => $reviewId]);
            }
            $lastDone = (int) $r['id'];
        }

        if (!$dry && $lastDone !== $cur) {
            @file_put_contents($cursorF, json_encode(['last' => $lastDone, 'at' => date('c')]), LOCK_EX);
        }
        if (!$dry) {
            $stats['breaches_updated'] = $tickets->sweepBreaches();
        }
        $stats['cursor'] = $lastDone;
        return $stats;
    }

    /**
     * SenseStudio stores image paths relative ("/images/cognitivesvc/…"); resolve them
     * against the configured image host the same way EventStore does for the UI.
     * Absolute URLs and this site's own uploads/ paths pass through unchanged.
     */
    private function imageUrl(string $path): string
    {
        $path = trim($path);
        if ($path === '' || preg_match('#^https?://#i', $path) || preg_match('#^/?(uploads|storage)/#i', $path)) {
            return $path;
        }
        $base = rtrim((string) ($this->config['images']['base'] ?? ''), '/');
        return $base === '' ? $path : $base . '/' . ltrim($path, '/');
    }

    // ── review ───────────────────────────────────────────────

    /** Public: the camera-monitor cascade (lib/MonitorScanner.php) reviews with the same verdict keys. */
    public const SCHEMA = [
        'type' => 'object',
        'properties' => [
            'forklift_present'          => ['type' => 'boolean'],
            'person_operating_forklift' => ['type' => 'boolean'],
            'helmet'                    => ['type' => 'string', 'enum' => ['worn', 'missing', 'unclear', 'not_applicable']],
            'vest'                      => ['type' => 'string', 'enum' => ['worn', 'missing', 'unclear', 'not_applicable']],
            'missing_ppe'               => ['type' => 'array', 'items' => ['type' => 'string']],
            'violation'                 => ['type' => 'boolean'],
            'confidence'                => ['type' => 'number'],
            'reason'                    => ['type' => 'string'],
        ],
        'required' => ['forklift_present', 'person_operating_forklift', 'helmet', 'vest', 'missing_ppe', 'violation', 'confidence', 'reason'],
        'additionalProperties' => false,
    ];

    private function review(Claude $claude, array $img, string $camera, string $loc, array $needed): array
    {
        $v = ImageTool::forVision($img['bytes'], $img['mime']);
        $needTxt = implode(' and ', array_map(static fn ($x) => match ($x) {
            'helmet' => 'a safety helmet / hard hat', 'vest' => 'a high-visibility safety vest', default => $x,
        }, $needed ?: ['helmet', 'vest']));
        $system = 'You are a workplace-safety vision reviewer for Kian Joo factory CCTV. You judge only what is visible in the image. '
            . 'Be conservative: report a violation only when it is clearly visible. Respond with the JSON object only.';
        $prompt = "Camera {$camera}, location \"{$loc}\". A face-recognition camera just detected a person here.\n\n"
            . "Question: is any person in this image OPERATING a forklift (driving it, seated at its controls, or standing on it and controlling it) "
            . "while NOT wearing the required PPE — {$needTxt}?\n\n"
            . "Rules:\n- violation = true only if (1) a forklift is visible, (2) a person is operating it, and (3) at least one required PPE item is clearly missing on that operator.\n"
            . "- Pedestrians near a forklift are not operators.\n- If the operator's head/torso is occluded or the image is too poor to judge, mark that item \"unclear\" and violation = false.\n"
            . "- missing_ppe lists only clearly missing items (\"helmet\", \"vest\").\n- confidence is 0.0–1.0 for your violation decision.\n- reason: one short sentence describing what you see.";
        return $claude->json('vision_review', $system, [[
            'role' => 'user',
            'content' => [Claude::imageBlock($v['bytes'], $v['mime']), ['type' => 'text', 'text' => $prompt]],
        ]], self::SCHEMA);
    }

    // ── persistence helpers ──────────────────────────────────

    /** Enabled forklift zones keyed by stream label, or null = review every camera. */
    private function zones(): ?array
    {
        $zones = array_filter((array) ($this->config['forklift']['zones'] ?? []), static fn ($z) => !empty($z['enabled']));
        $only  = $this->opt['zone_only'];
        if ($only === false || ($only === null && !$zones)) {
            return null;
        }
        return $zones;
    }

    private function locationOf(string $label, array $r): string
    {
        $map = (array) ($this->config['poc']['cam_locations'] ?? []);
        $loc = $map[$label] ?? ($this->config['forklift']['zones'][$label]['name'] ?? '');
        return mb_substr((string) ($loc ?: ($r['device_name'] ?: strtoupper($label))), 0, 120);
    }

    private function openTicket(string $pid, string $loc): ?array
    {
        $st = $this->pdo->prepare("SELECT * FROM tickets WHERE category = :c AND person_id = :p AND location = :l
                                   AND status NOT IN ('resolved','closed') ORDER BY id DESC LIMIT 1");
        $st->execute(['c' => self::CATEGORY, 'p' => $pid, 'l' => $loc]);
        return $st->fetch() ?: null;
    }

    private function extend(array $t, string $at): void
    {
        $this->pdo->prepare('UPDATE tickets SET event_last_at = CASE WHEN event_last_at IS NULL OR event_last_at < :a THEN :a2 ELSE event_last_at END,
                                    detection_count = detection_count + 1, updated_at = :u WHERE id = :id')
            ->execute(['a' => $at, 'a2' => $at, 'u' => date('Y-m-d H:i:s'), 'id' => $t['id']]);
    }

    private function personState(string $pid): ?array
    {
        $st = $this->pdo->prepare('SELECT * FROM ai_person_state WHERE person_id = :p');
        $st->execute(['p' => $pid]);
        return $st->fetch() ?: null;
    }

    private function touchPerson(string $pid, int $eventId, array $res): void
    {
        $now = date('Y-m-d H:i:s');
        $verdict = $res['ok'] ? (!empty($res['data']['violation']) ? 'violation' : 'clear') : 'error';
        $upd = $this->pdo->prepare('UPDATE ai_person_state SET last_review_at = :n, last_event_id = :e, last_verdict = :v,
                                           reviews = reviews + 1, updated_at = :n2 WHERE person_id = :p');
        $upd->execute(['n' => $now, 'e' => $eventId, 'v' => $verdict, 'n2' => $now, 'p' => $pid]);
        if ($upd->rowCount() === 0) {
            try {
                $this->pdo->prepare('INSERT INTO ai_person_state (person_id, last_review_at, last_event_id, last_verdict, reviews, updated_at)
                                     VALUES (:p, :n, :e, :v, 1, :n2)')
                    ->execute(['p' => $pid, 'n' => $now, 'e' => $eventId, 'v' => $verdict, 'n2' => $now]);
            } catch (PDOException $e) {
                // Inserted concurrently — the UPDATE path will win next time.
            }
        }
    }

    private function logReview(array $r, string $pid, string $loc, string $label, array $res, bool $violation, ?float $conf): int
    {
        $u = (array) ($res['usage'] ?? []);
        $this->pdo->prepare('INSERT INTO ai_reviews (event_id, event_uuid, person_id, location, camera, kind, model, violation, confidence,
                                                     verdict_json, tokens_in, tokens_out, error, created_at)
                             VALUES (:e, :u, :p, :l, :c, :k, :m, :v, :cf, :j, :ti, :to, :er, :at)')
            ->execute([
                'e' => (int) $r['id'], 'u' => $r['uuid'], 'p' => $pid, 'l' => $loc, 'c' => $label, 'k' => self::CATEGORY,
                'm' => $res['model'] ?? Claude::modelFor('vision_review'), 'v' => $violation ? 1 : 0, 'cf' => $conf,
                'j' => $res['ok'] ? json_encode($res['data'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : null,
                'ti' => $u['input_tokens'] ?? null, 'to' => $u['output_tokens'] ?? null,
                'er' => $res['ok'] ? null : mb_substr((string) ($res['error'] ?? 'error'), 0, 250),
                'at' => date('Y-m-d H:i:s'),
            ]);
        return (int) $this->pdo->lastInsertId();
    }

    /** First detection of this person's continuous episode on this camera, and how many detections it holds. */
    private function episode(string $pid, string $stream, string $at): array
    {
        $st = $this->pdo->prepare('SELECT received_at FROM events WHERE person_id = :p AND stream = :s
                                   AND received_at <= :t AND received_at >= :f ORDER BY id DESC LIMIT 500');
        $st->execute(['p' => $pid, 's' => $stream, 't' => $at, 'f' => date('Y-m-d H:i:s', (strtotime($at) ?: time()) - 4 * 3600)]);
        $first = strtotime($at) ?: time();
        $n = 0;
        $prev = $first;
        foreach ($st->fetchAll(PDO::FETCH_COLUMN) as $ra) {
            $ts = strtotime((string) $ra) ?: 0;
            if ($prev - $ts > $this->opt['gap_sec']) {
                break;
            }
            $first = min($first, $ts);
            $prev  = $ts;
            $n++;
        }
        return [date('Y-m-d H:i:s', $first), max(1, $n)];
    }

    /** Create the episode ticket, or join the one another run created (UNIQUE dedup_key). */
    /** SenseStudio detect frame used by DashboardMapper when the image size can't vouch for the box. */
    private const DETECT_FRAME_W = 2560;
    private const DETECT_FRAME_H = 1440;

    /**
     * Person bounding box for the proof overlay, from the SenseStudio event's
     * `detect` {left, top, right, bottom} (px, stored as events.detect_json).
     * Only meaningful on the background/scene frame — the trigger crop has its
     * own coordinates — so the caller passes null-producing input for crops.
     * `pct` (0–100 of width/height) survives the WebP proof's resize, so the
     * overlay should draw from it. Frame = the scene image's real size when the
     * box fits inside it, else the 2560×1440 reference frame.
     *
     * @return array{left:float,top:float,right:float,bottom:float,frame_w:int,frame_h:int,
     *               pct:array{x:float,y:float,w:float,h:float},source:string,image:string}|null
     */
    public static function bboxOf(?string $detectJson, ?string $sceneBytes): ?array
    {
        $d = $detectJson ? json_decode($detectJson, true) : null;
        if (!is_array($d)) {
            return null;
        }
        $l = (float) ($d['left'] ?? 0);
        $t = (float) ($d['top'] ?? 0);
        $r = (float) ($d['right'] ?? 0);
        $b = (float) ($d['bottom'] ?? 0);
        if ($r <= $l || $b <= $t || $l < 0 || $t < 0) {
            return null;
        }
        $fw = self::DETECT_FRAME_W;
        $fh = self::DETECT_FRAME_H;
        $sz = $sceneBytes !== null && $sceneBytes !== '' ? @getimagesizefromstring($sceneBytes) : false;
        if ($sz && $sz[0] > 0 && $sz[1] > 0 && $r <= $sz[0] && $b <= $sz[1]) {
            $fw = (int) $sz[0];
            $fh = (int) $sz[1];
        }
        if ($r > $fw || $b > $fh) {
            return null;   // box outside every known frame: don't draw a wrong rectangle
        }
        return [
            'left' => $l, 'top' => $t, 'right' => $r, 'bottom' => $b, 'frame_w' => $fw, 'frame_h' => $fh,
            'pct' => ['x' => round($l / $fw * 100, 2), 'y' => round($t / $fh * 100, 2),
                      'w' => round(($r - $l) / $fw * 100, 2), 'h' => round(($b - $t) / $fh * 100, 2)],
            'source' => 'sensestudio_detect', 'image' => 'scene',
        ];
    }

    private function openOrJoin(Tickets $tickets, array $r, string $pid, string $loc, string $label, array $v, array $res, int $reviewId, ?array $bbox = null): array
    {
        [$first, $count] = $this->episode($pid, (string) $r['stream'], (string) $r['received_at']);
        $base = 'fkppe:' . sha1($pid . '|' . $loc) . ':' . date('YmdHis', strtotime($first) ?: time());
        $dedup = $base;
        $st =$this->pdo->prepare('SELECT * FROM tickets WHERE dedup_key = :k');
        $st->execute(['k' => $base]);
        $existing = $st->fetch() ?: null;
        if ($existing) {
            if (!in_array($existing['status'], ['resolved', 'closed'], true)) {
                $this->extend($existing, (string) $r['received_at']);
                return ['created' => false, 'ticket' => $existing];
            }
            $dedup = $base . ':' . (int) $r['id'];   // same episode re-offends after closure → new ticket
        }
        $name = $this->personName($pid, (string) ($r['person_name'] ?? ''));
        $missing = array_values(array_filter(array_map('strval', (array) ($v['missing_ppe'] ?? []))));
        try {
            $t = $tickets->create([
                'title' => 'Forklift operated without PPE' . ($missing ? ' (' . implode(', ', $missing) . ')' : '') . ' — ' . $name . ' @ ' . $loc,
                'description' => (string) ($v['reason'] ?? 'AI vision review confirmed a forklift operator without required PPE.'),
                'priority' => 'high', 'category' => self::CATEGORY, 'source' => 'ai_pipeline',
                'person_id' => $pid, 'location' => $loc, 'camera' => $label, 'event_id' => (int) $r['id'],
                'dedup_key' => $dedup, 'event_first_at' => $first, 'event_last_at' => (string) $r['received_at'],
                'detection_count' => $count, 'defer_notify' => true,
                'meta' => ['review_id' => $reviewId, 'event_uuid' => $r['uuid'], 'model' => $res['model'] ?? null,
                           'confidence' => $v['confidence'] ?? null, 'missing_ppe' => $missing, 'person_name' => $name,
                           'helmet' => $v['helmet'] ?? null, 'vest' => $v['vest'] ?? null]
                          + ($bbox ? ['bbox' => $bbox] : []),
            ], ['id' => 0, 'name' => 'VisionAI pipeline', 'tier' => 'admin', 'perms' => []], true);
            return ['created' => true, 'ticket' => $t];
        } catch (PDOException $e) {
            // Unique dedup_key race with a parallel run: join that ticket.
            $st->execute(['k' => $dedup]);
            $t = $st->fetch();
            if (!$t) {
                throw $e;
            }
            $this->extend($t, (string) $r['received_at']);
            return ['created' => false, 'ticket' => $t];
        }
    }

    private function personName(string $pid, string $fallback): string
    {
        $st = $this->pdo->prepare('SELECT name FROM person_profiles WHERE person_id = :p');
        $st->execute(['p' => $pid]);
        $n = (string) ($st->fetchColumn() ?: '');
        return $n !== '' ? $n : ($fallback !== '' ? $fallback : 'person ' . $pid);
    }
}
