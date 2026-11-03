<?php
/**
 * Enterprise integration (scoring-matrix criteria 43 HRMS, 44 MES, 45 multi-plant).
 *
 * Inbound: a token-protected, read-only JSON API under /api/integration/*
 * (attendance, events, persons, movement, ppe) — paginated, every row carries
 * its plant and every endpoint accepts ?plant=. Auth is a dedicated
 * integration API key (Settings → Integrations), separate from the dashboard
 * read token so it can be rotated without logging operators out.
 *
 * Outbound: webhooks. New detections are POSTed as JSON to the configured
 * URLs with an HMAC-SHA256 signature of the raw body:
 *   X-VisionAI-Event:     attendance | incident | detection | ppe | test
 *   X-VisionAI-Timestamp: unix seconds
 *   X-VisionAI-Signature: sha256=<hex hmac_sha256(secret, timestamp + "." + body)>
 * Delivery happens at ingest with a hard 2 s budget across all hooks; a
 * failure is logged (storage/webhook_log.json) and never fails the ingest.
 */

declare(strict_types=1);

require_once __DIR__ . '/EventStore.php';
require_once __DIR__ . '/DashboardMapper.php';
require_once __DIR__ . '/Attendance.php';
require_once __DIR__ . '/WsdSettings.php';
require_once __DIR__ . '/AiMetrics.php';

final class Integration
{
    public const VERSION = '1.0';
    private const MAX_PER_PAGE = 500;
    private const LOG_KEEP = 200;

    private PDO $pdo;
    private array $config;
    private EventStore $store;
    private ?Attendance $att = null;

    public function __construct(PDO $pdo, array $config, EventStore $store)
    {
        $this->pdo    = $pdo;
        $this->config = $config;
        $this->store  = $store;
    }

    // ── Auth ─────────────────────────────────────────────────

    /** The API key from X-Api-Key, Authorization: Bearer, or ?api_key=. */
    public static function givenKey(): string
    {
        if (!empty($_SERVER['HTTP_X_API_KEY'])) {
            return trim((string) $_SERVER['HTTP_X_API_KEY']);
        }
        $auth = (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
        if (stripos($auth, 'Bearer ') === 0) {
            return trim(substr($auth, 7));
        }
        return trim((string) ($_GET['api_key'] ?? ''));
    }

    /** null = ok, else [message, http code]. */
    public static function authError(array $config): ?array
    {
        $key = (string) (WsdSettings::of($config)['integration_key'] ?? '');
        if ($key === '') {
            return ['Integration API is disabled — generate an API key in Settings → Integrations.', 503];
        }
        $given = self::givenKey();
        if ($given === '' || !hash_equals($key, $given)) {
            return ['Unauthorized: invalid or missing integration API key.', 401];
        }
        return null;
    }

    // ── Helpers ──────────────────────────────────────────────

    private function att(): Attendance
    {
        return $this->att ??= new Attendance($this->store, $this->config);
    }

    private function locOf(string $stream): string
    {
        return (string) (($this->config['poc']['cam_locations'] ?? [])[$stream] ?? '');
    }

    private function plantOfStream(string $stream): string
    {
        $loc = $this->locOf($stream);
        return $loc !== '' ? $this->att()->plantOf($loc) : '';
    }

    private static function date(string $s, string $def): string
    {
        return preg_match('/^\d{4}-\d{2}-\d{2}$/', $s) ? $s : $def;
    }

    /** Page a list: ?page= (1-based) & ?per_page= (≤500). */
    public static function paginate(array $rows, array $q): array
    {
        $per  = max(1, min(self::MAX_PER_PAGE, (int) ($q['per_page'] ?? 100)));
        $page = max(1, (int) ($q['page'] ?? 1));
        $total = count($rows);
        return [
            'page' => $page, 'per_page' => $per, 'total' => $total,
            'pages' => (int) max(1, ceil($total / $per)),
            'data' => array_values(array_slice($rows, ($page - 1) * $per, $per)),
        ];
    }

    private function range(array $q, int $maxDays): array
    {
        $today = date('Y-m-d');
        if (!empty($q['date'])) {
            $d = self::date((string) $q['date'], $today);
            return [$d, $d];
        }
        $to   = self::date((string) ($q['to'] ?? ''), $today);
        $from = self::date((string) ($q['from'] ?? ''), $to);
        if ($to < $from) {
            [$from, $to] = [$to, $from];
        }
        if ((strtotime($to) - strtotime($from)) / 86400 > $maxDays) {
            $from = date('Y-m-d', strtotime($to) - $maxDays * 86400);
        }
        return [$from, $to];
    }

    // ── Endpoints ────────────────────────────────────────────

    /** HRMS: daily attendance per employee. ?date= | ?from=&to= (≤62 days), ?plant=, ?department=, ?staff_id= */
    public function attendance(array $q): array
    {
        [$from, $to] = $this->range($q, 62);
        $f = ['plant' => substr((string) ($q['plant'] ?? ''), 0, 80), 'department' => substr((string) ($q['department'] ?? ''), 0, 80)];
        $sid = trim((string) ($q['staff_id'] ?? ''));
        $rows = [];
        foreach ($this->att()->range($from, $to, $f) as $r) {
            if ($sid !== '' && (string) ($r['staffId'] ?? '') !== $sid) {
                continue;
            }
            $rows[] = [
                'date' => $r['date'], 'person_id' => (string) ($r['personId'] ?? ''), 'staff_id' => (string) ($r['staffId'] ?? ''),
                'name' => (string) ($r['name'] ?? ''), 'department' => (string) ($r['department'] ?? ''), 'plant' => (string) ($r['plant'] ?? ''),
                'shift' => (string) ($r['shift'] ?? ''), 'shift_start' => (string) ($r['shiftStart'] ?? ''), 'shift_end' => (string) ($r['shiftEnd'] ?? ''),
                'clock_in' => $r['clockIn'] ?? null, 'clock_in_location' => $r['clockInLoc'] ?? null,
                'clock_out' => $r['clockOut'] ?? null, 'clock_out_location' => $r['clockOutLoc'] ?? null,
                'hours' => $r['hours'] ?? null, 'status' => (string) ($r['status'] ?? ''), 'late_min' => (int) ($r['lateMin'] ?? 0),
                'exceptions' => array_values((array) ($r['flags'] ?? [])), 'plants_visited' => array_values((array) ($r['plants'] ?? [])),
            ];
        }
        return ['from' => $from, 'to' => $to] + self::paginate($rows, $q);
    }

    /** MES / SOC: detections since a time. ?since=ISO|unix, ?until=, ?module=, ?severity=, ?camera=, ?plant= */
    public function events(array $q): array
    {
        $since = (string) ($q['since'] ?? '');
        $sinceTs = $since === '' ? time() - 86400 : (ctype_digit($since) ? (int) $since : (strtotime($since) ?: time() - 86400));
        $until = (string) ($q['until'] ?? '');
        $untilTs = $until === '' ? time() + 60 : (ctype_digit($until) ? (int) $until : (strtotime($until) ?: time() + 60));
        $sinceTs = max($sinceTs, $untilTs - 31 * 86400);
        $mod  = (string) ($q['module'] ?? '');
        $sev  = strtolower((string) ($q['severity'] ?? ''));
        $cam  = strtolower((string) ($q['camera'] ?? ''));
        $plant = (string) ($q['plant'] ?? '');
        $st = $this->pdo->prepare('SELECT * FROM events WHERE received_at > :a AND received_at <= :b ORDER BY received_at ASC, id ASC LIMIT 20000');
        $st->execute(['a' => date('Y-m-d H:i:s', $sinceTs), 'b' => date('Y-m-d H:i:s', $untilTs)]);
        $rows = [];
        while ($r = $st->fetch()) {
            if ($cam !== '' && strtolower((string) $r['stream']) !== $cam) {
                continue;
            }
            $row = $this->eventRow($r);
            if (($mod !== '' && $row['module'] !== $mod) || ($sev !== '' && $row['severity'] !== $sev) || ($plant !== '' && $row['plant'] !== $plant)) {
                continue;
            }
            $rows[] = $row;
        }
        return ['since' => date('c', $sinceTs), 'until' => date('c', $untilTs),
                'modules' => array_keys(AiMetrics::MODULES)] + self::paginate($rows, $q);
    }

    /** One stored event as an integration row. */
    public function eventRow(array $r): array
    {
        $dec = json_decode((string) ($r['decoded_json'] ?? ''), true) ?: [];
        $e = $r + ['decoded' => $dec];
        $dm = DashboardMapper::modOf($e);
        $stream = (string) ($r['stream'] ?? '');
        $sev = (string) ($r['severity_override'] ?? '') ?: DashboardMapper::sevOf($e, $dm);
        return [
            'id' => (int) $r['id'], 'uuid' => (string) ($r['uuid'] ?? ''), 'time' => date('c', strtotime((string) $r['received_at']) ?: time()),
            'module' => AiMetrics::moduleOf($e), 'dashboard_module' => $dm, 'severity' => $sev,
            'status' => (string) ($r['status'] ?? 'open'), 'ticket' => (string) ($r['ticket_no'] ?? ''),
            'camera' => $stream, 'camera_name' => (string) ($r['device_name'] ?? ''), 'location' => $this->locOf($stream),
            'plant' => $this->plantOfStream($stream), 'policy' => (string) ($r['policy_name'] ?? ''),
            'person_id' => (string) ($r['person_id'] ?? ''), 'person_name' => (string) ($r['person_name'] ?? ''),
            'similarity' => AiMetrics::pct($r['similarity'] ?? null),
            'ppe_missing' => isset($dec['PpeMissing']) ? array_map('trim', explode(',', (string) $dec['PpeMissing'])) : [],
            'attributes' => array_diff_key($dec, array_flip(['PpeMissing'])),
            'image' => $this->store->fullUrl($r['trigger_img_url'] ?? null),
        ];
    }

    /** HRMS: enrolled employees. ?plant=, ?department=, ?active=1|0 */
    public function persons(array $q): array
    {
        $rows = [];
        foreach ($this->store->personProfiles() as $p) {
            if ((!empty($q['plant']) && $p['plant'] !== $q['plant']) || (!empty($q['department']) && $p['department'] !== $q['department'])
                || (isset($q['active']) && $q['active'] !== '' && (bool) (int) $q['active'] !== $p['active'])) {
                continue;
            }
            $rows[] = ['person_id' => $p['personId'], 'staff_id' => $p['staffId'], 'name' => $p['name'], 'department' => $p['department'],
                       'plant' => $p['plant'], 'shift' => $p['shift'], 'active' => $p['active'], 'enrolled_at' => $p['since'],
                       'face_sync' => $p['ssSync'] ?: null];
        }
        usort($rows, static fn ($a, $b) => strcmp($a['name'], $b['name']));
        return self::paginate($rows, $q);
    }

    /** Movement trail: visits per location. ?person_id= (or staff_id=), ?from=&to= (≤31 days), ?plant= */
    public function movement(array $q): array
    {
        $pid = trim((string) ($q['person_id'] ?? ''));
        $sid = trim((string) ($q['staff_id'] ?? ''));
        if ($pid === '' && $sid !== '') {
            foreach ($this->store->personProfiles() as $p) {
                if ($p['staffId'] === $sid) {
                    $pid = $p['personId'];
                    break;
                }
            }
            if ($pid === '') {
                throw new InvalidArgumentException('Unknown staff_id.');
            }
        }
        [$from, $to] = $this->range($q, 31);
        $rows = [];
        foreach ($this->att()->movement($from, $to, $pid ?: null, ['plant' => (string) ($q['plant'] ?? ''), 'unknown' => $pid !== '']) as $v) {
            $rows[] = ['person_id' => (string) ($v['personId'] ?? $pid), 'staff_id' => (string) ($v['staffId'] ?? ''), 'name' => (string) ($v['name'] ?? ''),
                       'plant' => (string) ($v['plant'] ?? ''), 'location' => (string) ($v['location'] ?? ''), 'camera' => (string) ($v['camera'] ?? ''),
                       'arrive' => $v['arrive'] ?? null, 'depart' => $v['depart'] ?? null, 'dwell_min' => $v['dwellMin'] ?? null,
                       'detections' => $v['captures'] ?? null, 'source' => (string) ($v['source'] ?? ''), 'counts_for' => (string) ($v['role'] ?? '')];
        }
        $plantsSeen = [];
        foreach ($rows as $r) {
            if ($r['plant'] !== '' && end($plantsSeen) !== $r['plant']) {
                $plantsSeen[] = $r['plant'];
            }
        }
        return ['from' => $from, 'to' => $to, 'person_id' => $pid ?: null, 'plant_transitions' => max(0, count($plantsSeen) - 1)]
            + self::paginate($rows, $q);
    }

    /** PPE checks (compliant + violations). ?from=&to= (≤31 days), ?plant=, ?location=, ?violations_only=1 */
    public function ppe(array $q): array
    {
        [$from, $to] = $this->range($q, 31);
        $sql = 'SELECT * FROM ppe_checks WHERE checked_at >= :a AND checked_at < :b';
        $p = ['a' => $from . ' 00:00:00', 'b' => date('Y-m-d', strtotime($to) + 86400) . ' 00:00:00'];
        foreach (['plant' => 'plant', 'location' => 'location'] as $k => $col) {
            if (!empty($q[$k])) {
                $sql .= " AND {$col} = :{$k}";
                $p[$k] = (string) $q[$k];
            }
        }
        if (!empty($q['violations_only'])) {
            $sql .= " AND missing <> ''";
        }
        $st = $this->pdo->prepare($sql . ' ORDER BY checked_at ASC LIMIT 50000');
        $st->execute($p);
        $rows = [];
        $viol = 0;
        foreach ($st as $r) {
            $miss = array_values(array_filter(array_map('trim', explode(',', (string) $r['missing']))));
            $viol += $miss ? 1 : 0;
            $rows[] = ['id' => (int) $r['id'], 'event_id' => (int) $r['event_id'], 'time' => (string) $r['checked_at'],
                       'plant' => (string) $r['plant'], 'location' => (string) $r['location'], 'camera' => (string) $r['stream'],
                       'required' => array_values(array_filter(array_map('trim', explode(',', (string) $r['required'])))),
                       'missing' => $miss, 'unknown' => array_values(array_filter(array_map('trim', explode(',', (string) $r['unknown'])))),
                       'compliant' => !$miss, 'person_id' => (string) ($r['person_id'] ?? ''),
                       'cleaning_session' => (string) ($r['schedule_name'] ?? ''), 'image' => $this->store->fullUrl($r['image'] ?? null)];
        }
        $n = count($rows);
        return ['from' => $from, 'to' => $to, 'checks' => $n, 'violations' => $viol,
                'compliance_pct' => $n ? round(100 * ($n - $viol) / $n, 1) : null] + self::paginate($rows, $q);
    }

    /** Endpoint catalogue (GET /api/integration). */
    public static function catalogue(string $host): array
    {
        $b = rtrim($host, '/') . '/api/integration';
        return [
            ['GET', $b . '/attendance', 'date= | from=&to= (≤62 d), plant=, department=, staff_id=', 'HRMS — daily attendance per employee'],
            ['GET', $b . '/events', 'since= (ISO or unix), until=, module=, severity=, camera=, plant=', 'MES / SOC — detections and incidents'],
            ['GET', $b . '/persons', 'plant=, department=, active=1|0', 'HRMS — enrolled employees'],
            ['GET', $b . '/movement', 'person_id= | staff_id=, from=&to= (≤31 d), plant=', 'Movement trail, location visits, plant transitions'],
            ['GET', $b . '/ppe', 'from=&to= (≤31 d), plant=, location=, violations_only=1', 'MES / EHS — PPE checks and compliance'],
        ];
    }

    // ── Outbound webhooks ────────────────────────────────────

    /** Which webhook event types one stored event belongs to. */
    public static function typesOf(array $row, array $decoded, array $config): array
    {
        $types = ['detection'];
        $stream = (string) ($row['stream'] ?? '');
        $role = (string) (($config['attendance']['cam_roles'] ?? [])[$stream] ?? '');
        if (!empty($row['person_id']) && in_array($role, ['clock_in', 'clock_out', 'both'], true)) {
            $types[] = 'attendance';
        }
        if (!empty($decoded['PpeMissing'])) {
            $types[] = 'ppe';
        }
        $e = $row + ['decoded' => $decoded];
        $sev = DashboardMapper::sevOf($e, DashboardMapper::modOf($e));
        if (in_array($sev, ['high', 'critical'], true)) {
            $types[] = 'incident';
        }
        return $types;
    }

    /**
     * Called from EventStore after a (non-simulated) event is stored.
     * Hard 2 s budget for all hooks together; never throws.
     */
    public static function dispatch(PDO $pdo, array $config, EventStore $store, array $row, array $decoded): void
    {
        try {
            $s = WsdSettings::of($config);
            $hooks = array_values(array_filter($s['webhooks'], static fn ($h) => $h['enabled'] && $h['events']));
            if (!$hooks || !function_exists('curl_init')) {
                return;
            }
            $types = self::typesOf($row, $decoded, $config);
            $self = new self($pdo, $config, $store);
            $payload = null;
            $deadline = microtime(true) + 2.0;
            foreach ($hooks as $h) {
                $match = array_values(array_intersect($h['events'], $types));
                if (!$match) {
                    continue;
                }
                $left = $deadline - microtime(true);
                if ($left < 0.2) {
                    self::log($config, $h, $match[0], 0, 'skipped — ingest time budget (2 s) used up', 0);
                    continue;
                }
                $payload ??= $self->eventRow($row + ['id' => (int) ($row['id'] ?? 0)]);
                // Most specific type first: attendance / ppe / incident before detection.
                usort($match, static fn ($a, $b) => ($a === 'detection') <=> ($b === 'detection'));
                self::send($config, $h, $match[0], ['type' => $match[0], 'types' => $types, 'event' => $payload], $left);
            }
        } catch (Throwable $e) {
            error_log('[webhook] ' . $e->getMessage());
        }
    }

    /** POST one signed delivery. Returns [ok, http code, error, ms]. */
    public static function send(array $config, array $hook, string $type, array $body, float $timeout = 2.0): array
    {
        $json = json_encode(['source' => 'kianjoo-visionai', 'version' => self::VERSION, 'sent_at' => date('c')] + $body,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?: '{}';
        $ts  = (string) time();
        $sig = 'sha256=' . hash_hmac('sha256', $ts . '.' . $json, (string) $hook['secret']);
        $t0 = microtime(true);
        $ch = curl_init((string) $hook['url']);
        curl_setopt_array($ch, [
            CURLOPT_POST => true, CURLOPT_POSTFIELDS => $json, CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'User-Agent: KianJoo-VisionAI-Webhook/' . self::VERSION,
                                   'X-VisionAI-Event: ' . $type, 'X-VisionAI-Timestamp: ' . $ts, 'X-VisionAI-Signature: ' . $sig],
            CURLOPT_TIMEOUT_MS => (int) max(200, $timeout * 1000), CURLOPT_CONNECTTIMEOUT_MS => (int) max(200, min(1500, $timeout * 1000)),
            CURLOPT_FOLLOWLOCATION => false, CURLOPT_NOSIGNAL => true,
        ]);
        curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err  = curl_error($ch);
        curl_close($ch);
        $ms = (int) round((microtime(true) - $t0) * 1000);
        $ok = $err === '' && $code >= 200 && $code < 300;
        self::log($config, $hook, $type, $code, $ok ? '' : ($err !== '' ? $err : 'HTTP ' . $code), $ms);
        return ['ok' => $ok, 'code' => $code, 'error' => $ok ? '' : ($err !== '' ? $err : 'HTTP ' . $code), 'ms' => $ms];
    }

    private static function logFile(array $config): string
    {
        return WsdSettings::dirOf($config) . '/webhook_log.json';
    }

    private static function log(array $config, array $hook, string $type, int $code, string $error, int $ms): void
    {
        $f = self::logFile($config);
        $list = is_file($f) ? (json_decode((string) @file_get_contents($f), true) ?: []) : [];
        $list[] = ['at' => date('Y-m-d H:i:s'), 'hook' => $hook['id'], 'url' => (string) preg_replace('~^(https?://[^/]+).*$~i', '$1/…', (string) $hook['url']),
                   'type' => $type, 'code' => $code, 'ok' => $error === '', 'error' => substr($error, 0, 200), 'ms' => $ms];
        @file_put_contents($f, json_encode(array_slice($list, -self::LOG_KEEP), JSON_UNESCAPED_SLASHES), LOCK_EX);
    }

    public static function readLog(array $config, int $n = 50): array
    {
        $f = self::logFile($config);
        $list = is_file($f) ? (json_decode((string) @file_get_contents($f), true) ?: []) : [];
        return array_reverse(array_slice(is_array($list) ? $list : [], -$n));
    }
}
