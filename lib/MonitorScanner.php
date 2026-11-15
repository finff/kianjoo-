<?php
/**
 * VisionAI camera-monitor cascade worker.
 *
 * Per enabled camera whose interval elapsed: one still frame → TIER 1 fast
 * model gate (use case `monitor_gate`, ≤768 px, one call answering every
 * active field's trigger question) → on a hit, TIER 2 advanced model review
 * (`vision_review`) of the SAME frame bytes at ≤1568 px → confirmed
 * violation → ITSM ticket + WebP proof (+ optional one-shot e-mail to an
 * escalation level).
 *
 * Cost gates, in order, per triggered field:
 *   1. Ongoing episode: an unresolved monitor ticket for (field, camera) whose
 *      event_last_at is within gap_sec → extend it, NO review.
 *   2. Rate gate: ≤1 review per (camera, field) per rate_sec.
 *   3. dedup_key mon:<field>:<camera>:<episode start YmdHis> is UNIQUE in the
 *      DB, so parallel runs join instead of duplicating.
 *
 * Daily fitness (fitness()): one fast-model call per enabled camera per
 * 24 h, or sooner when its field set changed; an unfit field is skipped by
 * the scanner unless the camera has force_fit.
 *
 * Scan and fitness each hold their own flock; state writes go through
 * Monitors::updateState (LOCK_EX), so cron + feed piggyback overlap safely.
 */

declare(strict_types=1);

require_once __DIR__ . '/Monitors.php';
require_once __DIR__ . '/Claude.php';
require_once __DIR__ . '/ImageTool.php';
require_once __DIR__ . '/Tickets.php';
require_once __DIR__ . '/PpeForkliftPipeline.php';

final class MonitorScanner
{
    private const ACTOR = ['id' => 0, 'name' => 'VisionAI pipeline', 'tier' => 'admin', 'perms' => []];
    private const GATE_EDGE   = 768;
    private const REVIEW_EDGE = 1568;
    /** A camera whose frame/fitness call failed is not retried for this long. */
    private const FITNESS_RETRY = 900;

    private array $settings;
    private string $dir;
    /** @var callable|null Test seam: fn(string $useCase, $system, array $messages, array $schema): array (Claude::json shape). */
    private $ai;
    /** @var callable|null Test seam: fn(string $stream, array $source): ?array{bytes,mime,source}. */
    private $framer;

    public function __construct(private PDO $pdo, private array $config, ?callable $ai = null, ?callable $framer = null)
    {
        $this->settings = Monitors::settings($config);
        $this->dir      = Monitors::storageDir($config);
        $this->ai       = $ai;
        $this->framer   = $framer;
    }

    // ── schedulers ───────────────────────────────────────────

    /**
     * Throttled scan entry for cron / feed piggyback. The throttle file only
     * stops 5 s feed polls re-entering; per-camera intervals are checked in run().
     * Returns null when skipped.
     */
    public static function maybeRun(PDO $pdo, array $config, int $budgetSec = 20, int $graceSec = 10, string $source = 'feed'): ?array
    {
        $s = Monitors::settings($config);
        if (!$s['enabled'] || !self::anyEnabled($config) || ($config['ai']['source'] ?? 'claude') === 'off') {
            return null;
        }
        $min = $s['interval_sec'];
        foreach ((array) ($config['monitor']['cameras'] ?? []) as $c) {
            if (!empty($c['enabled']) && (int) ($c['interval_sec'] ?? 0) > 0) {
                $min = min($min, (int) $c['interval_sec']);
            }
        }
        $touch = Monitors::storageDir($config) . '/monitor_scan.touch';
        clearstatcache(true, $touch);
        if (is_file($touch) && time() - (int) @filemtime($touch) < max(15, $min - $graceSec)) {
            return null;
        }
        @touch($touch);
        return (new self($pdo, $config))->run(['budget' => $budgetSec, 'source' => $source, 'grace' => $graceSec]);
    }

    /**
     * Throttled fitness entry. `$every` is the per-camera re-check age; the
     * touch file throttles attempts to once a minute so a changed field set is
     * picked up on the next cycle.
     */
    public static function maybeFitness(PDO $pdo, array $config, int $every = 86400, int $budgetSec = 20, int $maxCameras = 0): ?array
    {
        $s = Monitors::settings($config);
        if (!$s['enabled'] || !$s['fitness_enabled'] || !self::anyEnabled($config) || ($config['ai']['source'] ?? 'claude') === 'off') {
            return null;
        }
        $touch = Monitors::storageDir($config) . '/monitor_fitness.touch';
        clearstatcache(true, $touch);
        if (is_file($touch) && time() - (int) @filemtime($touch) < 60) {
            return null;
        }
        @touch($touch);
        return (new self($pdo, $config))->fitness(['every' => $every, 'budget' => $budgetSec, 'max_cameras' => $maxCameras]);
    }

    private static function anyEnabled(array $config): bool
    {
        foreach ((array) ($config['monitor']['cameras'] ?? []) as $c) {
            if (!empty($c['enabled']) && !empty($c['fields'])) {
                return true;
            }
        }
        return false;
    }

    // ── scan ─────────────────────────────────────────────────

    /**
     * One scan cycle.
     *
     * @param array $o budget (s), dry_run (no frame fetch / AI / writes), force (ignore intervals),
     *                 stream (only this camera), source (cron|feed|cli|admin), grace (s)
     */
    public function run(array $o = []): array
    {
        $stats = ['cameras' => 0, 'eligible' => 0, 'scanned' => 0, 'gates' => 0, 'gate_hits' => 0, 'reviews' => 0,
                  'violations' => 0, 'tickets_opened' => 0, 'tickets_extended' => 0, 'skipped_interval' => 0,
                  'skipped_unfit' => 0, 'rate_limited' => 0, 'no_frame' => 0, 'mails' => 0, 'errors' => 0,
                  'locked' => false, 'dry_run' => !empty($o['dry_run'])];
        if (!$this->settings['enabled']) {
            return $stats + ['disabled' => true];
        }
        $lock = @fopen($this->dir . '/monitor_scan.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
            $stats['locked'] = true;
            return $stats;
        }
        try {
            $stats = $this->scan($o, $stats);
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        if (!$stats['dry_run']) {
            $src = (string) ($o['source'] ?? 'cron');
            Monitors::updateState($this->dir, static function (array $s) use ($stats, $src): array {
                $s['last_run'] = ['at' => date('c'), 'source' => $src, 'stats' => $stats];
                return $s;
            });
        }
        return $stats;
    }

    private function scan(array $o, array $stats): array
    {
        $t0     = time();
        $budget = max(5, (int) ($o['budget'] ?? 50));
        $dry    = !empty($o['dry_run']);
        $grace  = max(0, (int) ($o['grace'] ?? 10));
        $only   = isset($o['stream']) ? LiveBridge::label((string) $o['stream']) : '';
        $state  = Monitors::readState($this->dir);
        $srcs   = Monitors::sources($this->config);

        $queue = [];
        foreach ((array) ($this->config['monitor']['cameras'] ?? []) as $name => $cfg) {
            $name = (string) $name;
            $cfg  = Monitors::normalizeCamera((array) $cfg, null);
            if (!$cfg['enabled'] || !$cfg['fields'] || ($only !== '' && $name !== $only)) {
                continue;
            }
            $stats['cameras']++;
            $src = $srcs[$name] ?? null;
            if ($src === null || $src['frame_source'] === null) {
                $stats['no_frame']++;
                if (!$dry) {
                    $this->patchCam($name, ['skip_reason' => 'no_frame_source']);
                }
                continue;
            }
            $cs = is_array($state['cameras'][$name] ?? null) ? $state['cameras'][$name] : [];
            $last = strtotime((string) ($cs['last_scan_at'] ?? '')) ?: 0;
            if (empty($o['force']) && $last > 0 && time() - $last < Monitors::intervalOf($this->settings, $cfg) - $grace) {
                $stats['skipped_interval']++;
                continue;
            }
            [$on, $paused] = Monitors::activeFields($this->settings, $cfg, $cs);
            if (!$on) {
                $stats['skipped_unfit']++;
                if (!$dry) {
                    $this->patchCam($name, ['skip_reason' => 'all_fields_unfit', 'paused_fields' => $paused]);
                }
                continue;
            }
            $queue[] = ['name' => $name, 'cfg' => $cfg, 'src' => $src, 'cs' => $cs, 'fields' => $on, 'last' => $last];
        }
        // Fair stagger: least recently scanned first.
        usort($queue, static fn ($a, $b) => $a['last'] <=> $b['last']);
        $stats['eligible'] = count($queue);
        if ($dry || !$queue) {
            $stats['scanned'] = $dry ? min(count($queue), $this->settings['max_frames_per_run']) : 0;
            return $stats;
        }
        $claude = Claude::fromConfig($this->config);
        if ($this->ai === null && !$claude->ready()) {
            return $stats + ['error' => 'AI is not configured.'];
        }
        $tickets = new Tickets($this->pdo, $this->dir);

        foreach ($queue as $q) {
            if ($stats['scanned'] >= $this->settings['max_frames_per_run'] || time() - $t0 >= $budget) {
                break;
            }
            $name = $q['name'];
            $frame = $this->frame($name, $q['src']);
            $stats['scanned']++;
            if ($frame === null) {
                $stats['no_frame']++;
                $stats['errors']++;
                $this->patchCam($name, ['last_scan_at' => date('Y-m-d H:i:s'), 'skip_reason' => 'frame_unavailable',
                                        'last_error' => 'Camera frame unavailable'], true);
                continue;
            }
            $stop = $this->scanCamera($claude, $tickets, $q, $frame, $stats);
            if ($stop) {
                break;   // key / quota / outage: stop the run, retry next cycle
            }
        }
        return $stats;
    }

    /** Gate + reviews for one camera frame. Returns true when the run should stop. */
    private function scanCamera(Claude $claude, Tickets $tickets, array $q, array $frame, array &$stats): bool
    {
        $name   = $q['name'];
        $cfg    = $q['cfg'];
        $loc    = $q['src']['location'];
        $fields = $q['fields'];
        $now    = date('Y-m-d H:i:s');

        $res = $this->gate($claude, $frame, $name, $loc, $fields);
        $stats['gates']++;
        $hits = [];
        $maxConf = null;
        if ($res['ok']) {
            foreach ($fields as $f) {
                $g = (array) ($res['data'][$f] ?? []);
                $c = isset($g['confidence']) ? (float) $g['confidence'] : null;
                $maxConf = $c !== null ? max($maxConf ?? 0.0, $c) : $maxConf;
                if (!empty($g['triggered'])) {
                    $hits[$f] = $g;
                }
            }
        }
        $this->log('monitor_gate', $name, $loc, $res, (bool) $hits, $maxConf);
        if (!$res['ok']) {
            $stats['errors']++;
            $this->patchCam($name, ['last_scan_at' => $now, 'last_error' => mb_substr((string) ($res['error'] ?? 'gate failed'), 0, 200),
                                    'skip_reason' => null], true);
            return self::fatal($res);
        }
        $today = date('Y-m-d');
        $reasons = [];
        foreach ($fields as $f) {
            $reasons[$f] = ['triggered' => isset($hits[$f]), 'confidence' => $res['data'][$f]['confidence'] ?? null,
                            'reason' => mb_substr((string) ($res['data'][$f]['reason'] ?? ''), 0, 200)];
        }
        $this->patchCam($name, [
            'last_scan_at' => $now, 'skip_reason' => null, 'last_error' => null,
            'last_gate' => ['triggered' => (bool) $hits, 'confidence' => $maxConf, 'at' => $now,
                            'reason' => $hits ? (string) ($reasons[array_key_first($hits)]['reason']) : (string) ($reasons[$fields[0]]['reason'] ?? ''),
                            'fields' => $reasons],
        ], false, static function (array $c) use ($hits, $today): array {
            if (($c['gate_hits_date'] ?? '') !== $today) {
                $c['gate_hits_date'] = $today;
                $c['gate_hits_today'] = 0;
            }
            $c['gate_hits_today'] = (int) ($c['gate_hits_today'] ?? 0) + ($hits ? 1 : 0);
            return $c;
        });
        if (!$hits) {
            return false;
        }
        $stats['gate_hits']++;

        foreach (array_keys($hits) as $f) {
            $cat = Monitors::CATALOG[$f]['category'];
            // 1) Ongoing episode → extend, skip the advanced model.
            $open = $this->openTicket($f, $name);
            if ($open && time() - (strtotime((string) $open['event_last_at']) ?: 0) <= $this->settings['gap_sec']) {
                $this->extend($open, $now);
                $this->episodeTouch($name, $f, $now);
                $stats['tickets_extended']++;
                continue;
            }
            // 2) Rate gate.
            $cs = Monitors::readState($this->dir)['cameras'][$name] ?? [];
            $lastRev = strtotime((string) ($cs['reviews'][$f] ?? '')) ?: 0;
            if ($lastRev > 0 && time() - $lastRev < $this->settings['rate_sec']) {
                $stats['rate_limited']++;
                continue;
            }
            // 3) Advanced model on the same frame bytes.
            [$rv, $needed] = $this->review($claude, $frame, $name, $loc, $f);
            $stats['reviews']++;
            $v = $rv['ok'] ? (array) $rv['data'] : [];
            $conf = isset($v['confidence']) ? (float) $v['confidence'] : null;
            $present = $f === 'forklift_ppe' ? !empty($v['person_operating_forklift']) : !empty($v['person_present']);
            $violation = $rv['ok'] && !empty($v['violation']) && $present
                && ($conf === null || $conf >= $this->settings['min_confidence']);
            $reviewId = $this->log('monitor_review', $name, $loc, $rv, $violation, $conf, $f);
            $this->patchCam($name, [], false, static function (array $c) use ($f, $now, $violation): array {
                $c['reviews'][$f] = $now;
                if ($violation) {
                    $c['last_violation_at'] = $now;
                }
                return $c;
            });
            if (!$rv['ok']) {
                $stats['errors']++;
                if (self::fatal($rv)) {
                    return true;
                }
                continue;
            }
            if (!$violation) {
                continue;
            }
            $stats['violations']++;
            $start = $this->episodeTouch($name, $f, $now);
            if (!$cfg['action']['ticket']) {
                continue;
            }
            $t = $this->openOrJoin($tickets, $f, $cat, $name, $loc, $start, $now, $v, $rv, $reviewId, $needed, $cfg, isset($hits[$f]['confidence']) ? (float) $hits[$f]['confidence'] : null);
            if ($t['created']) {
                $stats['tickets_opened']++;
                $proof = $tickets->attachProof($t['ticket'], $frame['bytes'], null);
                $tickets->message((int) $t['ticket']['id'], [], 'ai',
                    'VisionAI camera monitor (' . Monitors::CATALOG[$f]['label'] . '): ' . ($v['reason'] ?? 'violation confirmed')
                    . ($proof ? '' : ' — proof image could not be encoded to WebP.'), false, null, null, true);
                $tickets->notifyCreated($t['ticket']);
                if ($cfg['action']['notify_level'] > 0 && $this->notifyLevel($t['ticket'], $cfg['action']['notify_level'], $f, $v)) {
                    $stats['mails']++;
                }
            } else {
                $stats['tickets_extended']++;
            }
            $this->pdo->prepare('UPDATE ai_reviews SET ticket_id = :t WHERE id = :id')
                ->execute(['t' => $t['ticket']['id'], 'id' => $reviewId]);
        }
        return false;
    }

    private static function fatal(array $res): bool
    {
        $s = (int) ($res['status'] ?? 0);
        return in_array($s, [401, 403, 429], true) || $s >= 500;
    }

    // ── frames ───────────────────────────────────────────────

    /** Camera HTTP snapshot, else the bridge's frame.jpeg. @return array{bytes:string,mime:string,source:string}|null */
    private function frame(string $stream, array $src): ?array
    {
        if ($this->framer !== null) {
            return ($this->framer)($stream, $src);
        }
        $bytes = null;
        $how = null;
        if ($src['frame_source'] === 'still') {
            $bytes = LiveBridge::fetchStill((string) $src['src'], 6);
            $how = 'still';
        }
        $live = (array) ($this->config['live'] ?? []);
        if ($bytes === null && ((string) ($live['stream_base'] ?? '') !== '' || (string) ($live['api_base'] ?? '') !== '')) {
            try {
                $p = (new LiveBridge($live))->probe($stream, 10);
                $bytes = $p['ok'] ? (string) $p['image'] : null;
                $how = 'bridge';
            } catch (Throwable $e) {
                $bytes = null;
            }
        }
        if ($bytes === null || $bytes === '') {
            return null;
        }
        $mime = ImageTool::mimeOf($bytes);
        return $mime ? ['bytes' => $bytes, 'mime' => $mime, 'source' => (string) $how] : null;
    }

    // ── model calls ──────────────────────────────────────────

    private function call(Claude $claude, string $useCase, string $system, string $prompt, array $img, array $schema): array
    {
        $msgs = [['role' => 'user', 'content' => [Claude::imageBlock($img['bytes'], $img['mime']), ['type' => 'text', 'text' => $prompt]]]];
        if ($this->ai !== null) {
            return ($this->ai)($useCase, $system, $msgs, $schema);
        }
        return $claude->json($useCase, $system, $msgs, $schema);
    }

    private function gate(Claude $claude, array $frame, string $camera, string $loc, array $fields): array
    {
        $props = [];
        $lines = [];
        foreach ($fields as $f) {
            $props[$f] = [
                'type' => 'object',
                'properties' => ['triggered' => ['type' => 'boolean'], 'confidence' => ['type' => 'number'], 'reason' => ['type' => 'string']],
                'required' => ['triggered', 'confidence', 'reason'],
                'additionalProperties' => false,
            ];
            $lines[] = '- "' . $f . '": ' . Monitors::CATALOG[$f]['gate'];
        }
        $schema = ['type' => 'object', 'properties' => $props, 'required' => $fields, 'additionalProperties' => false];
        $system = 'You screen factory CCTV frames for a safety system. Answer only the trigger questions, from what is visible. '
            . 'Prefer triggered = true when unsure (a second reviewer checks every hit). Respond with the JSON object only.';
        $prompt = "Camera {$camera}, location \"{$loc}\". For each key, answer its question about this frame:\n" . implode("\n", $lines)
            . "\n\nFor each key return triggered (bool), confidence 0.0–1.0, and reason (a few words).";
        $img = ImageTool::forVision($frame['bytes'], $frame['mime'], self::GATE_EDGE);
        return $this->call($claude, 'monitor_gate', $system, $prompt, $img, $schema);
    }

    /** @return array{0:array,1:string[]} [Claude::json result, required PPE] */
    private function review(Claude $claude, array $frame, string $camera, string $loc, string $field): array
    {
        $img = ImageTool::forVision($frame['bytes'], $frame['mime'], self::REVIEW_EDGE);
        $txt = static fn (array $items): string => implode(' and ', array_map(static fn ($x) => match ($x) {
            'helmet' => 'a safety helmet / hard hat', 'vest' => 'a high-visibility safety vest', 'goggles' => 'safety goggles',
            'gloves' => 'safety gloves', 'boots' => 'safety boots', 'hairnet' => 'a hair net', 'ear' => 'ear protection', default => $x,
        }, $items));
        $system = 'You are a workplace-safety vision reviewer for Kian Joo factory CCTV. You judge only what is visible in the image. '
            . 'Be conservative: report a violation only when it is clearly visible. Respond with the JSON object only.';
        if ($field === 'forklift_ppe') {
            $needed = $this->config['forklift']['zones'][$camera]['op_ppe'] ?? null;
            $needed = is_array($needed) && $needed ? array_values($needed) : ['helmet', 'vest'];
            $needTxt = $txt($needed);
            $prompt = "Camera {$camera}, location \"{$loc}\". A screening model flagged a forklift with a person on or near it.\n\n"
                . "Question: is any person in this image OPERATING a forklift (driving it, seated at its controls, or standing on it and controlling it) "
                . "while NOT wearing the required PPE — {$needTxt}?\n\n"
                . "Rules:\n- violation = true only if (1) a forklift is visible, (2) a person is operating it, and (3) at least one required PPE item is clearly missing on that operator.\n"
                . "- Pedestrians near a forklift are not operators.\n- If the operator's head/torso is occluded or the image is too poor to judge, mark that item \"unclear\" and violation = false.\n"
                . "- missing_ppe lists only clearly missing items (\"helmet\", \"vest\", …).\n- confidence is 0.0–1.0 for your violation decision.\n- reason: one short sentence describing what you see.";
            return [$this->call($claude, 'vision_review', $system, $prompt, $img, PpeForkliftPipeline::SCHEMA), $needed];
        }
        $rules  = (array) ($this->config['ppe']['rules'] ?? []);
        $needed = isset($rules[$loc]) && is_array($rules[$loc]) && $rules[$loc] ? array_values($rules[$loc]) : ['vest'];
        $needTxt = $txt($needed);
        $prompt = "Camera {$camera}, location \"{$loc}\". People in this area must wear {$needTxt}.\n\n"
            . "Question: is any person in this image clearly missing one of the required PPE items?\n\n"
            . "Rules:\n- person_present = true if at least one person is visible.\n"
            . "- violation = true only if a visible person is clearly NOT wearing a required item; occluded / too small / too dark to judge → violation = false.\n"
            . "- missing_ppe lists only clearly missing required items (" . implode(', ', array_map(static fn ($x) => '"' . $x . '"', $needed)) . ").\n"
            . "- confidence is 0.0–1.0 for your violation decision.\n- reason: one short sentence describing what you see.";
        return [$this->call($claude, 'vision_review', $system, $prompt, $img, Monitors::ZONE_SCHEMA), $needed];
    }

    // ── tickets ──────────────────────────────────────────────

    private function openTicket(string $field, string $camera): ?array
    {
        $st = $this->pdo->prepare("SELECT * FROM tickets WHERE source = :s AND camera = :c AND dedup_key LIKE :k
                                   AND status NOT IN ('resolved','closed') ORDER BY id DESC LIMIT 1");
        $st->execute(['s' => Monitors::SOURCE, 'c' => $camera, 'k' => 'mon:' . $field . ':' . $camera . ':%']);
        return $st->fetch() ?: null;
    }

    private function extend(array $t, string $at): void
    {
        $this->pdo->prepare('UPDATE tickets SET event_last_at = CASE WHEN event_last_at IS NULL OR event_last_at < :a THEN :a2 ELSE event_last_at END,
                                    detection_count = detection_count + 1, updated_at = :u WHERE id = :id')
            ->execute(['a' => $at, 'a2' => $at, 'u' => date('Y-m-d H:i:s'), 'id' => $t['id']]);
    }

    /** Record a confirmation in the (camera, field) episode; returns the episode start. */
    private function episodeTouch(string $camera, string $field, string $now): string
    {
        $gap = $this->settings['gap_sec'];
        $start = $now;
        $this->patchCam($camera, [], false, static function (array $c) use ($field, $now, $gap, &$start): array {
            $e = is_array($c['episodes'][$field] ?? null) ? $c['episodes'][$field] : null;
            $last = $e ? (strtotime((string) ($e['last'] ?? '')) ?: 0) : 0;
            $start = ($e && strtotime($now) - $last <= $gap) ? (string) $e['start'] : $now;
            $c['episodes'][$field] = ['start' => $start, 'last' => $now];
            return $c;
        });
        return $start;
    }

    private function openOrJoin(Tickets $tickets, string $field, string $cat, string $camera, string $loc, string $start, string $now,
                                array $v, array $res, int $reviewId, array $needed, array $cfg, ?float $gateConf): array
    {
        $base  = 'mon:' . $field . ':' . $camera . ':' . date('YmdHis', strtotime($start) ?: time());
        $dedup = $base;
        $st = $this->pdo->prepare('SELECT * FROM tickets WHERE dedup_key = :k');
        $st->execute(['k' => $base]);
        $existing = $st->fetch() ?: null;
        if ($existing) {
            if (!in_array($existing['status'], ['resolved', 'closed'], true)) {
                $this->extend($existing, $now);
                return ['created' => false, 'ticket' => $existing];
            }
            $dedup = $base . ':' . date('His');   // same episode re-offends after closure → new ticket
        }
        $missing = array_values(array_filter(array_map('strval', (array) ($v['missing_ppe'] ?? []))));
        $what = $field === 'forklift_ppe' ? 'Forklift operated without PPE' : 'PPE missing in area';
        $title = $what . ($missing ? ' (' . implode(', ', $missing) . ')' : '') . ' — ' . $loc . ' (camera monitor)';
        try {
            $t = $tickets->create([
                'title' => mb_substr($title, 0, 200),
                'description' => (string) ($v['reason'] ?? 'VisionAI camera monitor confirmed a PPE violation.'),
                'priority' => $cfg['action']['priority'], 'category' => $cat, 'source' => Monitors::SOURCE,
                'person_id' => null, 'location' => $loc, 'camera' => $camera, 'event_id' => null,
                'dedup_key' => $dedup, 'event_first_at' => $start, 'event_last_at' => $now,
                'detection_count' => 1, 'defer_notify' => true,
                'meta' => ['review_id' => $reviewId, 'monitor_field' => $field, 'model' => $res['model'] ?? null,
                           'confidence' => $v['confidence'] ?? null, 'gate_confidence' => $gateConf, 'missing_ppe' => $missing,
                           'required_ppe' => $needed, 'helmet' => $v['helmet'] ?? null, 'vest' => $v['vest'] ?? null],
            ], self::ACTOR, true);
            return ['created' => true, 'ticket' => $t];
        } catch (PDOException $e) {
            $st->execute(['k' => $dedup]);
            $t = $st->fetch();
            if (!$t) {
                throw $e;
            }
            $this->extend($t, $now);
            return ['created' => false, 'ticket' => $t];
        }
    }

    /** One-shot mail to an escalation level's recipients (Escalation.php untouched). */
    private function notifyLevel(array $t, int $level, string $field, array $v): bool
    {
        $lv = $this->config['escalation']['levels'][$level - 1] ?? null;
        if (!is_array($lv) || empty($lv['enabled'])) {
            return false;
        }
        require_once __DIR__ . '/Mailer.php';
        $to = Mailer::parseList($lv['emails'] ?? [], 30);
        if (!$to) {
            return false;
        }
        try {
            require_once __DIR__ . '/EmailTemplate.php';
            $col = EmailTemplate::sevColor((string) $t['priority']);
            $label = 'CAMERA MONITOR · ' . strtoupper((string) $t['priority']);
            $content = EmailTemplate::heading((string) $t['title'])
                . EmailTemplate::sub('Opened automatically by a VisionAI camera monitor (' . Monitors::CATALOG[$field]['label'] . ').')
                . EmailTemplate::note((string) ($v['reason'] ?? ''), 'WHAT VISIONAI SAW')
                . EmailTemplate::rows([
                    ['Ticket', (string) $t['ticket_no']],
                    ['Priority', strtoupper((string) $t['priority']), $col],
                    ['Camera', (string) $t['camera']],
                    ['Location', (string) ($t['location'] ?? '—')],
                    ['Missing PPE', implode(', ', array_map('strval', (array) ($v['missing_ppe'] ?? []))) ?: '—'],
                    ['Notified level', 'L' . $level . ' — ' . (string) ($lv['name'] ?? '')],
                ])
                . EmailTemplate::buttons([['Open the ticket desk', EmailTemplate::host() . '/', true, $col]]);
            $html = EmailTemplate::shell((string) $t['title'], $label, $col, $content,
                'Sent by a VisionAI camera monitor to escalation level L' . $level . '. Change this under Settings → AI Engine → Camera monitors.');
            $mc = (array) ($this->config['mail'] ?? []);
            $mc['to'] = $to;
            return (new Mailer($mc))->send('[VisionAI monitor] New ' . $t['priority'] . ' ticket ' . $t['ticket_no'] . ' — ' . $t['title'], $html, $to);
        } catch (Throwable $e) {
            error_log('[monitor] notify mail: ' . $e->getMessage());
            return false;
        }
    }

    // ── fitness ──────────────────────────────────────────────

    /**
     * Fitness check for every enabled camera that is due (never checked, older
     * than `every`, or its field set changed). `stream` + `force` = that camera now.
     *
     * @param array $o every, budget, max_cameras (0 = no cap), stream, force, dry_run
     */
    public function fitness(array $o = []): array
    {
        $stats = ['due' => 0, 'checked' => 0, 'errors' => 0, 'no_frame' => 0, 'locked' => false,
                  'dry_run' => !empty($o['dry_run']), 'results' => []];
        $lock = @fopen($this->dir . '/monitor_fitness.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
            $stats['locked'] = true;
            return $stats;
        }
        try {
            $stats = $this->fitnessRun($o, $stats);
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
        if (!$stats['dry_run'] && $stats['due'] > 0) {
            $sum = array_diff_key($stats, ['results' => 1]);
            Monitors::updateState($this->dir, static function (array $s) use ($sum): array {
                $s['last_fitness_run'] = ['at' => date('c'), 'stats' => $sum];
                return $s;
            });
        }
        return $stats;
    }

    private function fitnessRun(array $o, array $stats): array
    {
        $t0     = time();
        $every  = max(3600, (int) ($o['every'] ?? 86400));
        $budget = max(5, (int) ($o['budget'] ?? 50));
        $cap    = max(0, (int) ($o['max_cameras'] ?? 0));
        $only   = isset($o['stream']) ? LiveBridge::label((string) $o['stream']) : '';
        $force  = !empty($o['force']);
        $dry    = !empty($o['dry_run']);
        $state  = Monitors::readState($this->dir);
        $srcs   = Monitors::sources($this->config);
        $claude = Claude::fromConfig($this->config);
        if (!$dry && $this->ai === null && !$claude->ready()) {
            return $stats + ['error' => 'AI is not configured.'];
        }

        $cams = $only !== '' ? [$only => $this->config['monitor']['cameras'][$only] ?? []] : (array) ($this->config['monitor']['cameras'] ?? []);
        foreach ($cams as $name => $cfg) {
            $name = (string) $name;
            $cfg  = Monitors::normalizeCamera((array) $cfg, null);
            if ($only === '' && (!$cfg['enabled'] || !$cfg['fields'])) {
                continue;
            }
            $cs  = is_array($state['cameras'][$name] ?? null) ? $state['cameras'][$name] : [];
            $fit = is_array($cs['fitness'] ?? null) ? $cs['fitness'] : null;
            $age = $fit ? time() - (strtotime((string) ($fit['checked_at'] ?? '')) ?: 0) : PHP_INT_MAX;
            $changed = $fit && (!empty($fit['stale']) || ($fit['hash'] ?? '') !== Monitors::fieldsHash($cfg['fields']));
            $retry = time() - (strtotime((string) ($cs['fitness_attempt_at'] ?? '')) ?: 0) < self::FITNESS_RETRY;
            if (!$force && ($retry || (!$changed && $age < $every))) {
                continue;
            }
            $stats['due']++;
            if ($dry) {
                continue;
            }
            if (($cap > 0 && $stats['checked'] + $stats['errors'] >= $cap) || time() - $t0 >= $budget) {
                break;
            }
            $src = $srcs[$name] ?? null;
            $frame = ($src && $src['frame_source'] !== null) ? $this->frame($name, $src) : null;
            if ($frame === null) {
                $stats['no_frame']++;
                $stats['errors']++;
                $this->patchCam($name, ['fitness_attempt_at' => date('Y-m-d H:i:s'), 'last_error' => 'Camera frame unavailable for the fitness check']);
                $stats['results'][$name] = ['ok' => false, 'error' => 'Camera frame unavailable'];
                continue;
            }
            $loc = $src['location'];
            $res = $this->fitCall($claude, $frame, $name, $loc);
            $this->log('monitor_fitness', $name, $loc, $res, false, null);
            if (!$res['ok']) {
                $stats['errors']++;
                $this->patchCam($name, ['fitness_attempt_at' => date('Y-m-d H:i:s'), 'last_error' => mb_substr((string) ($res['error'] ?? 'fitness failed'), 0, 200)]);
                $stats['results'][$name] = ['ok' => false, 'error' => (string) ($res['error'] ?? 'fitness failed')];
                if (self::fatal($res)) {
                    break;
                }
                continue;
            }
            $fields = [];
            foreach (array_keys(Monitors::CATALOG) as $k) {
                $r = (array) ($res['data']['fields'][$k] ?? []);
                $fields[$k] = ['fit' => array_key_exists('fits', $r) ? (bool) $r['fits'] : null,
                               'reason' => mb_substr((string) ($r['reason'] ?? ''), 0, 200)];
            }
            $verdict = ['checked_at' => date('Y-m-d H:i:s'), 'hash' => Monitors::fieldsHash($cfg['fields']),
                        'scene' => mb_substr((string) ($res['data']['scene_summary'] ?? ''), 0, 300), 'fields' => $fields,
                        'model' => (string) ($res['model'] ?? '')];
            $this->patchCam($name, ['fitness' => $verdict, 'fitness_attempt_at' => date('Y-m-d H:i:s')]);
            $stats['checked']++;
            $stats['results'][$name] = ['ok' => true, 'scene' => $verdict['scene'], 'fields' => $fields];
        }
        $stats['results'] = (object) $stats['results'];
        return $stats;
    }

    private function fitCall(Claude $claude, array $frame, string $camera, string $loc): array
    {
        $props = [];
        $lines = [];
        foreach (Monitors::CATALOG as $k => $c) {
            $props[$k] = ['type' => 'object', 'properties' => ['fits' => ['type' => 'boolean'], 'reason' => ['type' => 'string']],
                          'required' => ['fits', 'reason'], 'additionalProperties' => false];
            $lines[] = '- "' . $k . '" (' . $c['label'] . '): ' . $c['fit'];
        }
        $schema = ['type' => 'object', 'properties' => [
            'scene_summary' => ['type' => 'string'],
            'fields' => ['type' => 'object', 'properties' => $props, 'required' => array_keys(Monitors::CATALOG), 'additionalProperties' => false],
        ], 'required' => ['scene_summary', 'fields'], 'additionalProperties' => false];
        $system = 'You classify what kind of place a fixed factory CCTV camera looks at, to decide which safety monitors make sense for it. '
            . 'Judge the scene type, not the current moment (an empty warehouse aisle still fits forklift monitoring). Respond with the JSON object only.';
        $prompt = "Camera {$camera}, location \"{$loc}\".\nscene_summary: one short sentence describing the scene.\n"
            . "For each monitor key, fits = could the monitored situation plausibly happen in this scene; reason = a few words.\n" . implode("\n", $lines);
        $img = ImageTool::forVision($frame['bytes'], $frame['mime'], self::GATE_EDGE);
        return $this->call($claude, 'monitor_fitness', $system, $prompt, $img, $schema);
    }

    // ── persistence ──────────────────────────────────────────

    /**
     * Merge $kv into cameras[$camera] (null values delete), optionally bump the
     * error counter and run $fn on the camera node, all under one LOCK_EX write.
     */
    private function patchCam(string $camera, array $kv, bool $error = false, ?callable $fn = null): void
    {
        Monitors::updateState($this->dir, static function (array $s) use ($camera, $kv, $error, $fn): array {
            $c = is_array($s['cameras'][$camera] ?? null) ? $s['cameras'][$camera] : [];
            foreach ($kv as $k => $v) {
                if ($v === null) {
                    unset($c[$k]);
                } else {
                    $c[$k] = $v;
                }
            }
            if ($error) {
                $c['errors'] = min(9999, (int) ($c['errors'] ?? 0) + 1);
            } elseif (array_key_exists('last_error', $kv) && $kv['last_error'] === null) {
                $c['errors'] = 0;   // rolling count: reset on the next clean scan
            }
            if ($fn !== null) {
                $c = $fn($c);
            }
            $s['cameras'][$camera] = $c;
            return $s;
        });
    }

    private function log(string $kind, string $camera, string $loc, array $res, bool $flag, ?float $conf, ?string $field = null): int
    {
        $u = (array) ($res['usage'] ?? []);
        $data = $res['ok'] ? (array) ($res['data'] ?? []) : null;
        if ($data !== null && $field !== null) {
            $data = ['field' => $field] + $data;
        }
        try {
            $this->pdo->prepare('INSERT INTO ai_reviews (event_id, event_uuid, person_id, location, camera, kind, model, violation, confidence,
                                                         verdict_json, tokens_in, tokens_out, error, created_at)
                                 VALUES (NULL, NULL, NULL, :l, :c, :k, :m, :v, :cf, :j, :ti, :to, :er, :at)')
                ->execute([
                    'l' => mb_substr($loc, 0, 120), 'c' => $camera, 'k' => $kind,
                    'm' => mb_substr((string) ($res['model'] ?? Claude::modelFor($kind === 'monitor_review' ? 'vision_review' : $kind)), 0, 60),
                    'v' => $flag ? 1 : 0, 'cf' => $conf,
                    'j' => $data !== null ? json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : null,
                    'ti' => $u['input_tokens'] ?? null, 'to' => $u['output_tokens'] ?? null,
                    'er' => $res['ok'] ? null : mb_substr((string) ($res['error'] ?? 'error'), 0, 250),
                    'at' => date('Y-m-d H:i:s'),
                ]);
            return (int) $this->pdo->lastInsertId();
        } catch (Throwable $e) {
            error_log('[monitor] ai_reviews log: ' . $e->getMessage());
            return 0;
        }
    }
}
