<?php
/**
 * Normalizes a raw SenseTime HTTP-Push payload, persists it (SQLite + JSONL),
 * decodes attributes, optionally mirrors to a Firebase RTDB feed, and provides
 * read queries for downstream use cases.
 */

declare(strict_types=1);

require_once __DIR__ . '/Attributes.php';
require_once __DIR__ . '/Text.php';

final class EventStore
{
    private PDO $pdo;
    private array $cfg;
    private string $imageBase;

    public function __construct(PDO $pdo, array $cfg)
    {
        $this->pdo = $pdo;
        $this->cfg = $cfg;
        $this->imageBase = rtrim((string) ($cfg['images']['base'] ?? ''), '/');
    }

    /**
     * Turn a relative /images/... path into a viewable absolute URL by
     * prepending SENSE_IMAGE_BASE. Absolute URLs and empty values pass through.
     */
    public function fullUrl(?string $path): ?string
    {
        if ($path === null || $path === '') {
            return $path;
        }
        if (preg_match('#^https?://#i', $path)) {
            return $path;
        }
        if ($this->imageBase === '') {
            return $path;
        }
        return $this->imageBase . '/' . ltrim($path, '/');
    }

    /**
     * Store one event. Returns the normalized record (including new DB id and
     * decoded attributes).
     *
     * @param array<string,mixed> $payload  Decoded JSON body.
     * @param string|null $stream            Camera/stream label (from URL path).
     */
    public function store(array $payload, ?string $stream, ?string $remoteIp, ?string $feedKind = null): array
    {
        $now = date('Y-m-d H:i:s');

        // Derive the stream if the caller did not supply one via the URL. The
        // derived label is normalized the same way the device registry does
        // (serial lower-cased, non-alphanumerics stripped) so a push without a
        // stream segment still lines up with the camera it came from.
        $stream = $stream !== null && $stream !== ''
            ? $stream
            : self::streamLabel($this->str($payload, 'deviceSerial') ?: $this->str($payload, 'deviceName') ?: 'default');

        $attributesRaw = isset($payload['attributes']) && is_array($payload['attributes']) ? $payload['attributes'] : [];
        $this->loadLiveDictionary();
        $decoded       = Attributes::decodeAll($attributesRaw);

        $row = [
            'uuid'               => $this->str($payload, 'uuid'),
            'trigger_event_id'   => $this->str($payload, 'triggerEventId'),
            'stream'             => $stream,
            'msg_source'         => $this->str($payload, 'msgSource'),
            'event_type'         => $this->str($payload, 'eventType'),
            'policy_id'          => $this->str($payload, 'policyId'),
            'policy_name'        => $this->str($payload, 'policyName'),
            'policy_type'        => $this->str($payload, 'policyType'),
            'policy_desc'        => $this->str($payload, 'policyDesc'),
            'trigger_image_type' => $this->str($payload, 'triggerImageType'),
            'device_id'          => $this->str($payload, 'deviceId'),
            'device_serial'      => $this->str($payload, 'deviceSerial'),
            'device_name'        => $this->str($payload, 'deviceName'),
            'device_tag'         => $this->str($payload, 'deviceTag'),
            'alert_level'        => $this->str($payload, 'alertLevel'),
            'person_name'        => $this->str($payload, 'personName'),
            'person_id'          => $this->str($payload, 'personId') ?: $this->str($payload, 'triggerPersonId'),
            'similarity'         => $this->str($payload, 'similarity'),
            'trigger_time'       => $this->str($payload, 'triggerTime'),
            'trigger_img_url'    => $this->str($payload, 'triggerImgUrl'),
            'bk_image_url'       => $this->str($payload, 'bkImageUrl'),
            'match_image_url'    => $this->str($payload, 'matchImageUrl'),
            'detect_json'        => isset($payload['detect']) ? json_encode($payload['detect'], JSON_UNESCAPED_SLASHES) : null,
            'attributes_json'    => $attributesRaw ? json_encode($attributesRaw, JSON_UNESCAPED_SLASHES) : null,
            'decoded_json'       => json_encode($decoded['map'], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            'raw_json'           => json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            'remote_ip'          => $remoteIp,
            'received_at'        => $now,
            'feed_kind'          => self::feedKind($payload, $feedKind),
        ];

        // Durable append-only backup first — survives even if the DB write fails.
        $this->appendRawLog($row['raw_json']);

        $cols = array_keys($row);
        $ph   = array_map(static fn ($c) => ':' . $c, $cols);
        $stmt = $this->pdo->prepare(
            'INSERT INTO events (' . implode(',', $cols) . ') VALUES (' . implode(',', $ph) . ')'
        );
        $stmt->execute($row);
        $eventId = (int) $this->pdo->lastInsertId();

        // Normalized attribute rows for cross-use-case querying.
        if ($decoded['list']) {
            $attStmt = $this->pdo->prepare(
                'INSERT INTO event_attributes (event_id, attr_key, feature_name, category, value, value_name, conf)
                 VALUES (:event_id, :attr_key, :feature_name, :category, :value, :value_name, :conf)'
            );
            foreach ($decoded['list'] as $a) {
                $attStmt->execute([
                    'event_id'     => $eventId,
                    'attr_key'     => $a['key'],
                    'feature_name' => $a['feature'],
                    'category'     => $a['category'],
                    'value'        => $a['value'],
                    'value_name'   => $a['value_name'],
                    'conf'         => $a['conf'],
                ]);
            }
        }

        $this->pruneIfNeeded();
        $this->forwardFirebase($stream, $payload);
        $this->forwardWestarAI($payload);
        $this->notifyIfSevere($row, $decoded['map']);

        $row['id']              = $eventId;
        $row['decoded']         = $decoded['map'];
        $row['decoded_list']    = $decoded['list'];
        $row['images']          = $this->imageSet($row);
        return $row;
    }

    /** List events with filters. */
    public function query(array $f): array
    {
        $where  = [];
        $params = [];

        foreach ([
            'stream'             => 'stream',
            'device_serial'      => 'device_serial',
            'trigger_image_type' => 'trigger_image_type',
            'event_type'         => 'event_type',
            'policy_name'        => 'policy_name',
            'person_id'          => 'person_id',
            'feed_kind'          => 'feed_kind',
            'status'             => 'status',
            'uuid'               => 'uuid',
        ] as $key => $col) {
            if (!empty($f[$key])) {
                $where[]        = "$col = :$key";
                $params[$key]   = $f[$key];
            }
        }
        // e.g. status_not = 'resolved' → everything still needing attention.
        if (!empty($f['status_not'])) {
            $where[]              = '(status IS NULL OR status <> :status_not)';
            $params['status_not'] = $f['status_not'];
        }
        if (!empty($f['from'])) {
            $where[]        = 'received_at >= :from';
            $params['from'] = $f['from'];
        }
        if (!empty($f['to'])) {
            $where[]      = 'received_at <= :to';
            $params['to'] = $f['to'];
        }

        $sql = 'SELECT * FROM events';
        if ($where) {
            $sql .= ' WHERE ' . implode(' AND ', $where);
        }
        $sql .= ' ORDER BY id DESC LIMIT :limit OFFSET :offset';

        $limit  = max(1, min(500, (int) ($f['limit'] ?? 50)));
        $offset = max(0, (int) ($f['offset'] ?? 0));

        $stmt = $this->pdo->prepare($sql);
        foreach ($params as $k => $v) {
            $stmt->bindValue(':' . $k, $v);
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();

        return array_map([$this, 'hydrate'], $stmt->fetchAll());
    }

    /** The most recent event for a stream (Firebase-feed replacement). */
    public function latest(?string $stream): ?array
    {
        if ($stream !== null && $stream !== '') {
            $stmt = $this->pdo->prepare('SELECT * FROM events WHERE stream = :s ORDER BY id DESC LIMIT 1');
            $stmt->execute(['s' => $stream]);
        } else {
            $stmt = $this->pdo->query('SELECT * FROM events ORDER BY id DESC LIMIT 1');
        }
        $row = $stmt->fetch();
        return $row ? $this->hydrate($row) : null;
    }

    public function find(string $uuid): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM events WHERE uuid = :u ORDER BY id DESC LIMIT 1');
        $stmt->execute(['u' => $uuid]);
        $row = $stmt->fetch();
        return $row ? $this->hydrate($row) : null;
    }

    /**
     * Record a triage action. First ack stamps acked_at; resolve stamps
     * resolved_at. Returns true if a row was updated.
     */
    public function setStatus(string $uuid, string $status, ?string $assignee = null): bool
    {
        if (!in_array($status, ['open', 'ack', 'resolved'], true)) {
            return false;
        }
        // Previous status → change-history entry with per-stage timing.
        $old = 'open';
        try {
            $q = $this->pdo->prepare('SELECT status FROM events WHERE uuid = :u LIMIT 1');
            $q->execute(['u' => $uuid]);
            $old = (string) ($q->fetchColumn() ?: 'open');
        } catch (Throwable $e) {
        }
        $now = date('Y-m-d H:i:s');
        $sets = ['status = :status'];
        $params = ['status' => $status, 'uuid' => $uuid];
        if ($status === 'ack' || $status === 'resolved') {
            $sets[] = 'acked_at = COALESCE(acked_at, :now)';
            $params['now'] = $now;
        }
        if ($status === 'resolved') {
            $sets[] = 'resolved_at = :rnow';
            $params['rnow'] = $now;
        }
        if ($assignee !== null && $assignee !== '') {
            $sets[] = 'assignee = :assignee';
            $params['assignee'] = $assignee;
        }
        $stmt = $this->pdo->prepare(
            'UPDATE events SET ' . implode(', ', $sets) . ' WHERE uuid = :uuid'
        );
        $stmt->execute($params);
        $changed = $stmt->rowCount() > 0;
        if ($changed && $old !== $status) {
            $this->addLog($uuid, 'status', $assignee ?: 'Operator', $old, $status, null);
        }
        return $changed;
    }

    // ── Incident tickets & change log ────────────────────────

    /** Append an entry to the incident change log. */
    public function addLog(string $uuid, string $kind, ?string $actor, ?string $from, ?string $to, ?string $note): bool
    {
        try {
            $stmt = $this->pdo->prepare(
                'INSERT INTO incident_log (uuid, kind, actor, from_val, to_val, note, created_at)
                 VALUES (:uuid, :kind, :actor, :f, :t, :note, :now)'
            );
            return $stmt->execute([
                'uuid' => $uuid, 'kind' => $kind, 'actor' => $actor ?: 'Operator',
                'f' => $from, 't' => $to, 'note' => $note, 'now' => date('Y-m-d H:i:s'),
            ]);
        } catch (Throwable $e) {
            error_log('[ilog] ' . $e->getMessage());
            return false;
        }
    }

    /** Full change history for one incident, oldest first. */
    public function getLog(string $uuid): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT kind, actor, from_val, to_val, note, created_at
             FROM incident_log WHERE uuid = :u ORDER BY id ASC'
        );
        $stmt->execute(['u' => $uuid]);
        return $stmt->fetchAll();
    }

    /** Escalate a detection into an incident ticket (idempotent). */
    public function ticket(string $uuid, ?string $actor): ?string
    {
        $row = $this->find($uuid);
        if (!$row) {
            return null;
        }
        if (!empty($row['ticket_no'])) {
            return (string) $row['ticket_no'];
        }
        $no = 'INC-' . date('ymd') . '-' . str_pad((string) ((int) $row['id'] % 10000), 4, '0', STR_PAD_LEFT);
        $stmt = $this->pdo->prepare('UPDATE events SET ticketed_at = :now, ticket_no = :no WHERE uuid = :u');
        $stmt->execute(['now' => date('Y-m-d H:i:s'), 'no' => $no, 'u' => $uuid]);
        $this->addLog($uuid, 'ticketed', $actor, null, $no, 'Detection escalated to incident ticket');
        return $no;
    }

    /** Escalate / de-escalate the incident level (severity override), logged. */
    public function setSeverity(string $uuid, string $sev, ?string $actor, ?string $note = null): bool
    {
        if (!in_array($sev, ['low', 'medium', 'high', 'critical'], true)) {
            return false;
        }
        $row = $this->find($uuid);
        if (!$row) {
            return false;
        }
        $stmt = $this->pdo->prepare('UPDATE events SET severity_override = :s WHERE uuid = :u');
        $stmt->execute(['s' => $sev, 'u' => $uuid]);
        $this->addLog($uuid, 'severity', $actor, (string) ($row['severity_override'] ?? ''), $sev, $note);
        return true;
    }

    /** Average seconds from received_at → acked_at over acknowledged events. */
    public function avgAckSeconds(): ?int
    {
        $sql = Database::driver() === 'sqlite'
            ? "SELECT AVG(strftime('%s', acked_at) - strftime('%s', received_at)) FROM events WHERE acked_at IS NOT NULL"
            : 'SELECT AVG(TIMESTAMPDIFF(SECOND, received_at, acked_at)) FROM events WHERE acked_at IS NOT NULL';
        $v = $this->pdo->query($sql)->fetchColumn();
        return $v !== null && $v !== false ? max(0, (int) round((float) $v)) : null;
    }

    /**
     * Response-time metrics for the Incidents page: overall MTTA/MTTR, resolved
     * in the last 24h, and a per-severity (alertLevel) breakdown matrix.
     */
    public function responseMetrics(): array
    {
        $sqlite = Database::driver() === 'sqlite';
        $ack = $sqlite ? "strftime('%s',acked_at)-strftime('%s',received_at)" : 'TIMESTAMPDIFF(SECOND,received_at,acked_at)';
        $res = $sqlite ? "strftime('%s',resolved_at)-strftime('%s',received_at)" : 'TIMESTAMPDIFF(SECOND,received_at,resolved_at)';

        $overall = $this->pdo->query(
            "SELECT AVG(CASE WHEN acked_at IS NOT NULL THEN {$ack} END) mtta,
                    AVG(CASE WHEN resolved_at IS NOT NULL THEN {$res} END) mttr FROM events"
        )->fetch() ?: [];

        $stmt = $this->pdo->prepare('SELECT COUNT(*) FROM events WHERE resolved_at IS NOT NULL AND resolved_at >= :f');
        $stmt->execute(['f' => date('Y-m-d H:i:s', time() - 86400)]);
        $resolved24h = (int) $stmt->fetchColumn();

        $rows = $this->pdo->query(
            "SELECT alert_level,
                    COUNT(*) cnt,
                    SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) open_cnt,
                    SUM(CASE WHEN status='ack' THEN 1 ELSE 0 END) ack_cnt,
                    SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) resolved_cnt,
                    AVG(CASE WHEN acked_at IS NOT NULL THEN {$ack} END) mtta,
                    AVG(CASE WHEN resolved_at IS NOT NULL THEN {$res} END) mttr
             FROM events GROUP BY alert_level ORDER BY alert_level DESC"
        )->fetchAll();

        $sevName = ['0' => 'Low', '1' => 'Medium', '2' => 'High', '3' => 'Severe'];
        $matrix = [];
        foreach ($rows as $r) {
            $matrix[] = [
                'severity' => $sevName[(string) $r['alert_level']] ?? ('L' . $r['alert_level']),
                'count'    => (int) $r['cnt'],
                'open'     => (int) $r['open_cnt'],
                'ack'      => (int) $r['ack_cnt'],
                'resolved' => (int) $r['resolved_cnt'],
                'mtta'     => $r['mtta'] !== null ? (int) round((float) $r['mtta']) : null,
                'mttr'     => $r['mttr'] !== null ? (int) round((float) $r['mttr']) : null,
            ];
        }
        return [
            'mtta'        => isset($overall['mtta']) && $overall['mtta'] !== null ? (int) round((float) $overall['mtta']) : null,
            'mttr'        => isset($overall['mttr']) && $overall['mttr'] !== null ? (int) round((float) $overall['mttr']) : null,
            'resolved24h' => $resolved24h,
            'matrix'      => $matrix,
        ];
    }

    /**
     * Per-module detection report (24h) for the Fire / PPE / Intrusion pages —
     * hourly trend, by-camera, by-severity, avg confidence, plus a module-
     * specific attribute breakdown. $mod is one of fire|ppe|intr|face.
     */
    public function modReport(string $mod): array
    {
        require_once __DIR__ . '/DashboardMapper.php';
        $from = date('Y-m-d H:i:s', time() - 86400);
        $stmt = $this->pdo->prepare('SELECT * FROM events WHERE received_at >= :f ORDER BY id DESC LIMIT 3000');
        $stmt->execute(['f' => $from]);
        $rows = array_map([$this, 'hydrate'], $stmt->fetchAll());

        $now = time();
        $hourly = array_fill(0, 24, 0);
        $byCam = [];
        $bySev = ['Low' => 0, 'Medium' => 0, 'High' => 0, 'Severe' => 0];
        $sevName = ['low' => 'Low', 'medium' => 'Medium', 'high' => 'High', 'critical' => 'Severe'];
        $attr = [];   // module-specific attribute → value → count
        $confSum = 0.0; $confN = 0; $total = 0; $openCnt = 0;

        // Which decoded attributes matter per module.
        $attrKeys = [
            'fire' => ['Smoking'],
            'ppe'  => ['WithReflectiveVest', 'HatsType', 'WithMask', 'WithGlove'],
            'intr' => ['Gender', 'Age', 'Angle'],
            'face' => ['Gender', 'Age'],
        ][$mod] ?? [];

        foreach ($rows as $e) {
            if (DashboardMapper::modOf($e) !== $mod) {
                continue;
            }
            $total++;
            if (($e['status'] ?? 'open') === 'open') {
                $openCnt++;
            }
            $cam = strtoupper((string) ($e['stream'] ?: ($e['device_serial'] ?: 'CAM')));
            $byCam[$cam] = ($byCam[$cam] ?? 0) + 1;
            $sev = $sevName[DashboardMapper::sevOf($e, $mod)] ?? 'Low';
            $bySev[$sev] = ($bySev[$sev] ?? 0) + 1;
            $ago = (int) floor(($now - (strtotime((string) ($e['received_at'] ?? '')) ?: $now)) / 3600);
            if ($ago >= 0 && $ago <= 23) {
                $hourly[23 - $ago]++;
            }
            foreach (($e['attributes'] ?? []) as $a) {
                if (($a['key'] ?? '') === '-1' && isset($a['conf'])) {
                    $confSum += (float) $a['conf'];
                    $confN++;
                }
            }
            $dec = $e['decoded'] ?? [];
            foreach ($attrKeys as $k) {
                if (isset($dec[$k]) && $dec[$k] !== '') {
                    $attr[$k][$dec[$k]] = ($attr[$k][$dec[$k]] ?? 0) + 1;
                }
            }
        }
        arsort($byCam);

        return [
            'mod'      => $mod,
            'total'    => $total,
            'open'     => $openCnt,
            'avgConf'  => $confN ? round($confSum / $confN, 2) : null,
            'hourly'   => $hourly,
            'byCam'    => $byCam,
            'bySeverity' => $bySev,
            'attr'     => $attr,
        ];
    }

    /**
     * Distinct SenseStudio policies seen per camera (a policy that has fired is
     * an enabled policy on that device). Powers the Settings → Detection Models
     * panel, which counts policies for the cameras shown on Live Monitoring.
     *
     * @return array<int, array{stream:string,serial:string,policy:string,type:string,c:int,last:?string}>
     */
    public function policyMatrix(int $days = 30): array
    {
        $from = date('Y-m-d H:i:s', time() - max(1, $days) * 86400);
        $stmt = $this->pdo->prepare(
            "SELECT stream, device_serial, policy_name, trigger_image_type, event_type,
                    COUNT(*) c, MAX(received_at) last
             FROM events
             WHERE received_at >= :f AND policy_name IS NOT NULL AND policy_name <> ''
             GROUP BY stream, device_serial, policy_name, trigger_image_type, event_type
             ORDER BY c DESC"
        );
        $stmt->execute(['f' => $from]);
        $out = [];
        foreach ($stmt->fetchAll() as $r) {
            $out[] = [
                'stream' => (string) ($r['stream'] ?? ''),
                'serial' => (string) ($r['device_serial'] ?? ''),
                'policy' => (string) ($r['policy_name'] ?? ''),
                'mod'    => DashboardMapper::modOf([
                    'trigger_image_type' => $r['trigger_image_type'] ?? '',
                    'event_type'         => $r['event_type'] ?? '',
                    'policy_name'        => $r['policy_name'] ?? '',
                ]),
                'c'      => (int) ($r['c'] ?? 0),
                'last'   => $r['last'] ?? null,
            ];
        }
        return $out;
    }

    /**
     * PPE (reflective vest) stats + recent detections list for the last 24h,
     * from decoded body attributes.
     */
    public function ppeStats(int $limit = 100): array
    {
        $from = date('Y-m-d H:i:s', time() - 86400);
        $stmt = $this->pdo->prepare(
            "SELECT e.uuid, e.stream, e.device_name, e.trigger_time, e.received_at,
                    e.trigger_img_url, e.decoded_json, a.value_name
             FROM event_attributes a
             JOIN events e ON e.id = a.event_id
             WHERE a.feature_name = 'WithReflectiveVest' AND e.received_at >= :f
             ORDER BY e.id DESC LIMIT " . (int) $limit
        );
        $stmt->execute(['f' => $from]);

        $wearing = 0;
        $missing = 0;
        $list = [];
        foreach ($stmt->fetchAll() as $r) {
            $has = $r['value_name'] === 'ReflectiveVest';
            $has ? $wearing++ : $missing++;
            $dec = $r['decoded_json'] ? (json_decode((string) $r['decoded_json'], true) ?: []) : [];
            $list[] = [
                'uuid'    => $r['uuid'],
                'stream'  => $r['stream'],
                'device'  => Text::latin((string) $r['device_name'], (string) $r['stream']),
                'time'    => $r['trigger_time'] ?: $r['received_at'],
                'vest'    => $has,
                'person'  => trim(($dec['Age'] ?? '') . ' ' . (in_array($dec['Gender'] ?? '', ['Male', 'Female'], true) ? $dec['Gender'] : 'person')),
                'tops'    => $dec['TopsType'] ?? null,
                'image'   => $this->fullUrl($r['trigger_img_url'] ?? null),
            ];
        }
        $total = $wearing + $missing;
        return [
            'wearing' => $wearing,
            'missing' => $missing,
            'total'   => $total,
            'pct'     => $total > 0 ? (int) round($wearing / $total * 100) : 100,
            'list'    => $list,
        ];
    }

    /**
     * Face & Body 24h report: per-attribute value counts (gender, age bands,
     * clothing, mask, vest, hats), hourly person trend and per-camera counts —
     * all from the normalized event_attributes rows.
     */
    public function faceReport(): array
    {
        $from = date('Y-m-d H:i:s', time() - 86400);

        $stmt = $this->pdo->prepare(
            "SELECT a.feature_name f, a.value_name v, COUNT(*) c
             FROM event_attributes a JOIN events e ON e.id = a.event_id
             WHERE e.received_at >= :f AND a.category = 'pedestrian'
             GROUP BY a.feature_name, a.value_name"
        );
        $stmt->execute(['f' => $from]);
        $agg = [];
        foreach ($stmt->fetchAll() as $r) {
            if ($r['v'] !== null && $r['v'] !== '') {
                $agg[$r['f']][$r['v']] = (int) $r['c'];
            }
        }

        // Person-bearing events → hourly trend + per-camera counts.
        $stmt = $this->pdo->prepare(
            'SELECT e.stream, e.device_name, e.received_at FROM events e
             WHERE e.received_at >= :f AND EXISTS (
                 SELECT 1 FROM event_attributes a
                 WHERE a.event_id = e.id AND a.category = \'pedestrian\')
             ORDER BY e.id DESC LIMIT 2000'
        );
        $stmt->execute(['f' => $from]);
        $hourly = array_fill(0, 24, 0);
        $byCam  = [];
        $total  = 0;
        $now    = time();
        foreach ($stmt->fetchAll() as $r) {
            $total++;
            $cam = strtoupper(Text::latin((string) ($r['stream'] ?: $r['device_name'] ?: 'CAM'), 'CAM'));
            $byCam[$cam] = ($byCam[$cam] ?? 0) + 1;
            $ago = (int) floor(($now - (strtotime((string) $r['received_at']) ?: $now)) / 3600);
            if ($ago >= 0 && $ago <= 23) {
                $hourly[23 - $ago]++;
            }
        }
        arsort($byCam);

        return [
            'total'     => $total,
            'hourly'    => $hourly,
            'byCam'     => $byCam,
            'gender'    => $agg['Gender'] ?? [],
            'age'       => $agg['Age'] ?? [],
            'topsColor' => $agg['TopsColor'] ?? [],
            'topsType'  => $agg['TopsType'] ?? [],
            'mask'      => $agg['WithMask'] ?? [],
            'vest'      => $agg['WithReflectiveVest'] ?? [],
            'hats'      => $agg['HatsType'] ?? [],
        ];
    }

    /**
     * "Find people in records": filter events by decoded body attributes
     * (each filter is an EXISTS over the indexed event_attributes rows).
     * $f keys: gender, age, tops_color, tops_type, mask, vest, hat,
     * stream, hours (lookback), limit.
     */
    public function findPeople(array $f): array
    {
        $map = [
            'gender'     => 'Gender',
            'age'        => 'Age',
            'tops_color' => 'TopsColor',
            'tops_type'  => 'TopsType',
            'mask'       => 'WithMask',
            'vest'       => 'WithReflectiveVest',
            'hat'        => 'HatsType',
        ];
        $sql    = 'SELECT e.* FROM events e WHERE 1=1';
        $params = [];
        $i      = 0;
        foreach ($map as $param => $feature) {
            $val = trim((string) ($f[$param] ?? ''));
            if ($val === '' || strtolower($val) === 'any') {
                continue;
            }
            $sql .= " AND EXISTS (SELECT 1 FROM event_attributes a$i
                      WHERE a$i.event_id = e.id AND a$i.feature_name = :f$i AND a$i.value_name = :v$i)";
            $params["f$i"] = $feature;
            $params["v$i"] = $val;
            $i++;
        }
        if (!empty($f['stream'])) {
            $sql .= ' AND e.stream = :stream';
            $params['stream'] = $f['stream'];
        }
        $hours = max(1, min(24 * 30, (int) ($f['hours'] ?? 24)));
        $sql  .= ' AND e.received_at >= :from';
        $params['from'] = date('Y-m-d H:i:s', time() - $hours * 3600);
        // Only person-bearing events qualify as "people records".
        $sql .= " AND EXISTS (SELECT 1 FROM event_attributes ap
                  WHERE ap.event_id = e.id AND ap.category = 'pedestrian')";
        $sql .= ' ORDER BY e.id DESC LIMIT ' . max(1, min(60, (int) ($f['limit'] ?? 24)));

        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        return array_map([$this, 'hydrate'], $stmt->fetchAll());
    }

    /** Aggregate counts, useful for dashboards / health. */
    public function stats(): array
    {
        $total   = (int) $this->pdo->query('SELECT COUNT(*) FROM events')->fetchColumn();
        $streams = $this->pdo->query(
            'SELECT stream, COUNT(*) c, MAX(received_at) last FROM events GROUP BY stream ORDER BY c DESC'
        )->fetchAll();
        $types = $this->pdo->query(
            'SELECT trigger_image_type type, COUNT(*) c FROM events GROUP BY trigger_image_type ORDER BY c DESC'
        )->fetchAll();
        return ['total' => $total, 'streams' => $streams, 'trigger_image_types' => $types];
    }

    /**
     * One row per unique tracked person (SenseStudio personId) seen in face
     * detections, newest first: capture count, first/last seen, cameras and the
     * most recent frames. This is what the People roster lists — the raw event
     * feed repeats the same person once per capture.
     *
     * @return array<int,array<string,mixed>>
     */
    public function personRoster(int $days = 7, int $limit = 200): array
    {
        $from = date('Y-m-d H:i:s', time() - max(1, $days) * 86400);
        $stmt = $this->pdo->prepare(
            "SELECT person_id, COUNT(*) captures,
                    MIN(received_at) first_seen, MAX(received_at) last_seen,
                    MAX(similarity) similarity
             FROM events
             WHERE person_id IS NOT NULL AND person_id <> '' AND received_at >= :f
             GROUP BY person_id
             ORDER BY MAX(received_at) DESC
             LIMIT " . (int) $limit
        );
        $stmt->execute(['f' => $from]);
        $rows = $stmt->fetchAll();
        if (!$rows) {
            return [];
        }

        // Latest frame + the cameras each person was seen on.
        $ids  = array_column($rows, 'person_id');
        $in   = implode(',', array_fill(0, count($ids), '?'));
        $lStmt = $this->pdo->prepare(
            "SELECT person_id, stream, device_name, trigger_img_url, bk_image_url,
                    match_image_url, person_name, received_at
             FROM events
             WHERE person_id IN ($in) AND received_at >= ?
             ORDER BY id DESC"
        );
        $lStmt->execute(array_merge($ids, [$from]));
        $latest = [];
        $cams   = [];
        foreach ($lStmt->fetchAll() as $r) {
            $pid = (string) $r['person_id'];
            if (!isset($latest[$pid]) && !empty($r['trigger_img_url'])) {
                $latest[$pid] = $r;
            }
            $cam = strtoupper(Text::latin((string) ($r['stream'] ?: $r['device_name'] ?: ''), ''));
            if ($cam !== '') {
                $cams[$pid][$cam] = true;
            }
        }

        $profiles = $this->personProfiles();
        $out = [];
        foreach ($rows as $r) {
            $pid = (string) $r['person_id'];
            $l   = $latest[$pid] ?? [];
            $pr  = $profiles[$pid] ?? null;
            $senseName  = Text::latin((string) ($l['person_name'] ?? ''), '');
            $senseMatch = $this->fullUrl($l['match_image_url'] ?? null);
            // "Registered" = SenseStudio holds an identity for this face (a
            // person-group match: it returns the name and/or the enrolled photo)
            // or an operator created a local profile for it here.
            $out[] = [
                'personId'   => $pid,
                'captures'   => (int) $r['captures'],
                'firstSeen'  => (string) $r['first_seen'],
                'lastSeen'   => (string) $r['last_seen'],
                'similarity' => (string) ($r['similarity'] ?? ''),
                'cameras'    => array_keys($cams[$pid] ?? []),
                'image'      => $this->fullUrl($l['trigger_img_url'] ?? null),
                'imageBk'    => $this->fullUrl($l['bk_image_url'] ?? null),
                'senseName'  => $senseName,
                'senseMatch' => $senseMatch,
                'inSense'    => $senseName !== '' || !empty($senseMatch),
                'registered' => $senseName !== '' || !empty($senseMatch) || $pr !== null,
                'profile'    => $pr,
            ];
        }
        return $out;
    }

    /** Operator-created profiles keyed by personId. */
    public function personProfiles(): array
    {
        try {
            $rows = $this->pdo->query('SELECT * FROM person_profiles')->fetchAll();
        } catch (Throwable $e) {
            return [];
        }
        $out = [];
        foreach ($rows as $r) {
            $out[(string) $r['person_id']] = [
                'personId' => (string) $r['person_id'],
                'name'     => (string) $r['name'],
                'staffId'  => (string) ($r['staff_id'] ?? ''),
                'age'      => (string) ($r['age'] ?? ''),
                'gender'   => (string) ($r['gender'] ?? ''),
                'about'    => (string) ($r['notes'] ?? ''),
                'notes'    => (string) ($r['notes'] ?? ''),   // legacy alias
                'photo'    => $this->fullUrl($r['photo_url'] ?? null),
                'since'    => (string) ($r['created_at'] ?? ''),
                'by'       => (string) ($r['created_by'] ?? ''),
            ];
        }
        return $out;
    }

    /**
     * Create or update a profile for a tracked person.
     *
     * @param array{name:string,age?:string,gender?:string,about?:string,photo?:?string} $p
     */
    public function savePersonProfile(string $personId, array $p, ?string $actor): bool
    {
        $now   = date('Y-m-d H:i:s');
        $args  = [
            'p' => $personId,
            'n' => substr(trim($p['name']), 0, 160),
            's' => substr(trim((string) ($p['staff_id'] ?? '')), 0, 64),
            'a' => substr(trim((string) ($p['age'] ?? '')), 0, 8),
            'g' => substr(trim((string) ($p['gender'] ?? '')), 0, 16),
            'd' => substr(trim((string) ($p['about'] ?? '')), 0, 500),
            'i' => $p['photo'] ?? null,
        ];
        $has = $this->pdo->prepare('SELECT COUNT(*) FROM person_profiles WHERE person_id = :p');
        $has->execute(['p' => $personId]);
        if ((int) $has->fetchColumn() > 0) {
            $st = $this->pdo->prepare(
                'UPDATE person_profiles
                    SET name = :n, staff_id = :s, age = :a, gender = :g, notes = :d,
                        photo_url = COALESCE(:i, photo_url), updated_at = :u
                  WHERE person_id = :p'
            );
            return $st->execute($args + ['u' => $now]);
        }
        $st = $this->pdo->prepare(
            'INSERT INTO person_profiles (person_id, name, staff_id, age, gender, notes, photo_url, created_by, created_at, updated_at)
             VALUES (:p, :n, :s, :a, :g, :d, :i, :b, :c, :c)'
        );
        return $st->execute($args + ['b' => $actor, 'c' => $now]);
    }

    public function deletePersonProfile(string $personId): bool
    {
        $st = $this->pdo->prepare('DELETE FROM person_profiles WHERE person_id = :p');
        return $st->execute(['p' => $personId]);
    }

    /**
     * Camera stream → named POC camera point ("Plant 1 Guard Post", …).
     * Unmapped cameras fall back to their stream label so detections at
     * cameras outside the agreed points still show up, just unlabelled.
     */
    private function locOf(?string $stream, ?string $device, array $locMap): string
    {
        $key = self::streamLabel((string) ($stream ?: $device ?: ''));
        if ($key !== '' && isset($locMap[$key]) && $locMap[$key] !== '') {
            return (string) $locMap[$key];
        }
        return strtoupper(Text::latin((string) ($stream ?: $device ?: ''), '')) ?: '—';
    }

    /**
     * POC Use Case 1 — attendance from facial-recognition events.
     * One row per tracked person in the window: first detection (= attendance /
     * entry), latest detection, latest-known location, and the camera points
     * visited in order. The caller merges profiles to split Known vs Unknown
     * Personnel. The last detection is NOT an exit event — per the agreed rule
     * it only marks the latest known location, qualified by $inactivityMin.
     *
     * @param array<string,string> $locMap stream label → location name
     */
    public function attendanceReport(array $locMap, int $days = 1, int $inactivityMin = 45): array
    {
        $from = date('Y-m-d H:i:s', time() - max(1, min(90, $days)) * 86400);
        $stmt = $this->pdo->prepare(
            "SELECT person_id, stream, device_name, received_at, trigger_time, trigger_img_url
             FROM events
             WHERE person_id IS NOT NULL AND person_id <> '' AND received_at >= :f
             ORDER BY id ASC"
        );
        $stmt->execute(['f' => $from]);

        $people = [];
        foreach ($stmt->fetchAll() as $r) {
            $pid = (string) $r['person_id'];
            $loc = $this->locOf($r['stream'] ?? null, $r['device_name'] ?? null, $locMap);
            $ts  = (string) ($r['received_at'] ?? '');
            $img = $this->fullUrl($r['trigger_img_url'] ?? null);
            if (!isset($people[$pid])) {
                $people[$pid] = [
                    'personId' => $pid, 'captures' => 0,
                    'firstSeen' => $ts, 'firstLoc' => $loc, 'firstImage' => $img,
                    'lastSeen' => $ts, 'lastLoc' => $loc, 'lastImage' => $img,
                    'route' => [],
                ];
            }
            $p = &$people[$pid];
            $p['captures']++;
            $p['lastSeen'] = $ts;
            $p['lastLoc']  = $loc;
            if ($img) {
                $p['lastImage'] = $img;
            }
            // Ordered, de-duplicated movement sequence (consecutive repeats collapse).
            if (!$p['route'] || end($p['route']) !== $loc) {
                $p['route'][] = $loc;
            }
            unset($p);
        }

        $now = time();
        foreach ($people as &$p) {
            $lastTs = strtotime($p['lastSeen']) ?: $now;
            $p['minsAgo'] = (int) floor(($now - $lastTs) / 60);
            // "On-site" = detected within the agreed inactivity interval. Past
            // it the person may have left without passing a camera point, so
            // the dashboard only claims a latest-known location.
            $p['onSite'] = $p['minsAgo'] <= max(1, $inactivityMin);
        }
        unset($p);
        return array_values($people);
    }

    /**
     * POC Use Case 1 — chronological movement journey of one person across the
     * predefined camera points, plus per-location "visits" with dwell times
     * (consecutive detections at the same point grouped together). Dwell also
     * feeds the Line 5 loitering rule: chit-chat is represented as measurable
     * dwell time, never as conversation content.
     *
     * @param array<string,string> $locMap stream label → location name
     */
    public function movementJourney(string $personId, array $locMap, int $days = 7, int $limit = 1000): array
    {
        $from = date('Y-m-d H:i:s', time() - max(1, min(90, $days)) * 86400);
        $stmt = $this->pdo->prepare(
            "SELECT stream, device_name, received_at, trigger_time, trigger_img_url, bk_image_url, similarity
             FROM events
             WHERE person_id = :p AND received_at >= :f
             ORDER BY id ASC
             LIMIT " . (int) $limit
        );
        $stmt->execute(['p' => $personId, 'f' => $from]);

        $steps  = [];
        $visits = [];
        foreach ($stmt->fetchAll() as $r) {
            $loc  = $this->locOf($r['stream'] ?? null, $r['device_name'] ?? null, $locMap);
            $ts   = (string) ($r['received_at'] ?? '');
            $img  = $this->fullUrl($r['trigger_img_url'] ?? null);
            $steps[] = [
                'time'       => $ts,
                'location'   => $loc,
                'camera'     => strtoupper(Text::latin((string) ($r['stream'] ?: $r['device_name'] ?: ''), '')),
                'image'      => $img,
                'similarity' => (string) ($r['similarity'] ?? ''),
            ];
            $last = $visits ? count($visits) - 1 : -1;
            if ($last >= 0 && $visits[$last]['location'] === $loc) {
                $visits[$last]['depart']   = $ts;
                $visits[$last]['captures']++;
                if ($img) {
                    $visits[$last]['image'] = $img;
                }
            } else {
                $visits[] = ['location' => $loc, 'arrive' => $ts, 'depart' => $ts,
                             'captures' => 1, 'image' => $img];
            }
        }
        foreach ($visits as &$v) {
            $a = strtotime($v['arrive']) ?: 0;
            $d = strtotime($v['depart']) ?: $a;
            $v['dwellMin'] = max(0, (int) round(($d - $a) / 60));
        }
        unset($v);
        return ['steps' => $steps, 'visits' => $visits];
    }

    /** Device serial → dashboard stream label (lower-case, alphanumeric only). */
    public static function streamLabel(string $serial): string
    {
        $s = strtolower((string) preg_replace('/[^a-z0-9]+/i', '', $serial));
        return $s !== '' ? $s : 'default';
    }

    /**
     * Which SenseStudio push feed an event came from.
     *
     * The ingest URL decides it (/api/ingest/face/{stream} → 'face'); when a
     * policy still posts to the legacy URL we infer it: a face-recognition push
     * carries a match image / person identity, a body-attribution push carries
     * the human attribute list.
     */
    public static function feedKind(array $payload, ?string $explicit = null): string
    {
        $explicit = strtolower(trim((string) $explicit));
        if ($explicit === 'face' || $explicit === 'body') {
            return $explicit;
        }
        $has = static fn (string $k): bool => !empty($payload[$k]);
        if ($has('matchImageUrl') || $has('personName') || $has('personId') || $has('groupName')) {
            return 'face';
        }
        if (!empty($payload['attributes']) && is_array($payload['attributes'])) {
            return 'body';
        }
        $t = strtolower((string) ($payload['triggerImageType'] ?? '') . ' ' . (string) ($payload['eventType'] ?? ''));
        if (str_contains($t, 'face')) {
            return 'face';
        }
        if (str_contains($t, 'human') || str_contains($t, 'body') || str_contains($t, 'pedestrian')) {
            return 'body';
        }
        return '';
    }

    /**
     * Feed the decoder SenseStudio's own feature naming (cached by feed.php from
     * the monitor-policy API) so stored attributes carry the same key/value
     * labels the operator sees in SenseStudio. No API call on the ingest path.
     */
    private function loadLiveDictionary(): void
    {
        static $loaded = false;
        if ($loaded) {
            return;
        }
        $loaded = true;
        $path = ($this->cfg['storage']['raw_log'] ?? '') . '.attrs.json';
        if ($path === '.attrs.json' || !is_file($path)) {
            return;
        }
        $d = json_decode((string) file_get_contents($path), true);
        if (is_array($d) && !empty($d['features'])) {
            Attributes::useLiveDictionary($d['features']);
        }
    }

    // ── internals ────────────────────────────────────────────

    private function hydrate(array $row): array
    {
        foreach (['detect_json' => 'detect', 'attributes_json' => 'attributes', 'decoded_json' => 'decoded', 'raw_json' => 'raw'] as $col => $out) {
            $row[$out] = isset($row[$col]) && $row[$col] !== null ? json_decode((string) $row[$col], true) : null;
            unset($row[$col]);
        }
        $row['images'] = $this->imageSet($row);
        return $row;
    }

    /** Absolute, viewable image URLs for an event row. */
    private function imageSet(array $row): array
    {
        return [
            'trigger'    => $this->fullUrl($row['trigger_img_url'] ?? null),
            'background' => $this->fullUrl($row['bk_image_url'] ?? null),
            'match'      => $this->fullUrl($row['match_image_url'] ?? null),
        ];
    }

    private function appendRawLog(string $json): void
    {
        $path = $this->cfg['storage']['raw_log'] ?? '';
        if ($path === '') {
            return;
        }
        $dir = dirname($path);
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        @file_put_contents($path, $json . "\n", FILE_APPEND | LOCK_EX);
    }

    private function pruneIfNeeded(): void
    {
        $max = (int) ($this->cfg['storage']['max_events'] ?? 0);
        if ($max <= 0) {
            return;
        }
        // Keep only the newest $max rows: delete everything with id at or below
        // (highest id - max). ON DELETE CASCADE removes the attribute rows too.
        $maxId = (int) $this->pdo->query('SELECT MAX(id) FROM events')->fetchColumn();
        $threshold = $maxId - $max;
        if ($threshold > 0) {
            $stmt = $this->pdo->prepare('DELETE FROM events WHERE id <= :t');
            $stmt->execute(['t' => $threshold]);
        }
    }

    /**
     * Mirror the event to the legacy Firebase RTDB feed so existing consumers of
     * {base}/{stream}.json keep working during migration. Best-effort, non-fatal.
     */
    private function forwardFirebase(string $stream, array $payload): void
    {
        $base = $this->cfg['forward']['firebase_base'] ?? '';
        if ($base === '' || !function_exists('curl_init')) {
            return;
        }
        $url = $base . '/' . rawurlencode($stream) . '.json';
        $ch  = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST  => 'PUT',
            CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_SLASHES),
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 4,
            CURLOPT_CONNECTTIMEOUT => 3,
        ]);
        curl_exec($ch);
        curl_close($ch);
    }

    /**
     * Email an alert for severe detections: alertLevel ≥ 2 (High/Severe) or an
     * IsSmoking body attribute. Throttled per stream+type via a cooldown file.
     */
    private function notifyIfSevere(array $row, array $decoded): void
    {
        $mailCfg = $this->cfg['mail'] ?? [];
        if (empty($mailCfg['host']) || empty($mailCfg['to'])) {
            return;
        }
        require_once __DIR__ . '/DashboardMapper.php';
        // Reconstruct the classification inputs from the stored row. policy_name
        // and raw attributes matter: fire policies can match by name, strangers
        // by the Person Group -99 attribute.
        $ev  = ['trigger_image_type' => $row['trigger_image_type'] ?? '', 'event_type' => $row['event_type'] ?? '',
                'policy_name' => $row['policy_name'] ?? '', 'policy_desc' => $row['policy_desc'] ?? '',
                'alert_level' => $row['alert_level'] ?? '', 'decoded' => $decoded,
                'attributes' => isset($row['attributes_json']) && $row['attributes_json'] ? (json_decode((string) $row['attributes_json'], true) ?: []) : []];
        $mod = DashboardMapper::modOf($ev);
        $sev = DashboardMapper::sevOf($ev, $mod);

        $alerts = $this->cfg['alerts'] ?? ['min_severity' => 'high', 'always_mods' => ['fire'], 'intr_armed' => 'always'];
        $rank = ['low' => 0, 'medium' => 1, 'high' => 2, 'critical' => 3];
        $min  = $alerts['min_severity'] ?? 'high';

        if ($min === 'off') {
            return;
        }
        // Dashboard-managed switches (Alert Rules page → storage/alert_settings.json).
        if (($alerts['email_enabled'] ?? true) === false) {
            return;
        }
        $modsEnabled = $alerts['mods_enabled'] ?? null;
        if (is_array($modsEnabled) && array_key_exists($mod, $modsEnabled) && !$modsEnabled[$mod]) {
            return;
        }
        $eligible = ($rank[$sev] ?? 0) >= ($rank[$min] ?? 2)
            || in_array($mod, $alerts['always_mods'] ?? [], true);

        // Intrusion armed-window gate (overnight-aware via DashboardMapper).
        if ($mod === 'intr' && $eligible) {
            $eligible = DashboardMapper::armedNow((string) ($alerts['intr_armed'] ?? 'always'));
        }
        if (!$eligible) {
            return;
        }

        // Cooldown: one email per stream+trigger type per MAIL_COOLDOWN_MIN.
        $key  = preg_replace('/[^a-z0-9]+/i', '_', ($row['stream'] ?? 'x') . '-' . ($row['trigger_image_type'] ?? 'evt'));
        $gate = dirname($this->cfg['storage']['raw_log']) . '/mail_' . $key . '.lock';
        if (is_file($gate) && (time() - (int) filemtime($gate)) < $mailCfg['cooldown'] * 60) {
            return;
        }
        @touch($gate);

        require_once __DIR__ . '/Mailer.php';
        require_once __DIR__ . '/EmailTemplate.php';
        $img      = $this->fullUrl($row['trigger_img_url'] ?? null);
        $sevTag   = strtoupper($sev);
        $modLabel = ['fire' => 'FIRE & SMOKE', 'ppe' => 'PPE', 'intr' => 'INTRUSION', 'face' => 'FACE & BODY'][$mod] ?? strtoupper($mod);
        $what     = DashboardMapper::titleOf($ev, $mod);
        $sevCol   = EmailTemplate::sevColor($sev);

        $attrRows = [];
        foreach (['Gender' => 'Gender', 'Age' => 'Age group', 'TopsType' => 'Tops', 'TopsColor' => 'Tops colour',
                  'HatsType' => 'Head cover', 'WithMask' => 'Mask', 'WithReflectiveVest' => 'Reflective vest',
                  'Smoking' => 'Smoking'] as $k => $label) {
            if (isset($decoded[$k])) {
                $attrRows[] = [$label, (string) $decoded[$k]];
            }
        }
        // POC: name the person where facial recognition matched an enrolled
        // profile (staff ID included); everyone else is Unknown Personnel.
        $pid = (string) ($row['person_id'] ?? '');
        $personRow = null;
        if ($pid !== '') {
            $pr = $this->personProfiles()[$pid] ?? null;
            $personRow = $pr
                ? ['Person', ($pr['name'] ?: 'Enrolled person')
                    . (($pr['staffId'] ?? '') !== '' ? ' · Staff ID ' . $pr['staffId'] : '')]
                : ['Person', 'Unknown personnel · tracked #' . $pid, EmailTemplate::COLORS['high']];
        }
        $loc = $this->locOf($row['stream'] ?? null, $row['device_name'] ?? null,
            $this->cfg['poc']['cam_locations'] ?? []);

        $content = EmailTemplate::heading($what)
            . EmailTemplate::sub($modLabel . ' detection on camera ' . strtoupper((string) ($row['stream'] ?: '')) . ' — action may be required.')
            . '<div style="margin:0 0 16px;">' . EmailTemplate::chip($sevTag . ' SEVERITY', $sevCol) . ' '
            . EmailTemplate::chip('OPEN', EmailTemplate::COLORS['low']) . '</div>'
            . EmailTemplate::image($img, 'Detection frame · ' . (string) ($row['device_name'] ?: $row['stream']))
            . EmailTemplate::rows([
                $personRow,
                ['Camera', strtoupper((string) ($row['stream'] ?: '—'))],
                ['Location', $loc],
                ['Device', (string) ($row['device_name'] ?: '—')],
                ['Zone / Policy', (string) ($row['policy_name'] ?: '—')],
                ['Trigger type', (string) ($row['trigger_image_type'] ?: '—')],
                ['Severity', $sevTag, $sevCol],
                ['Trigger time', (string) ($row['trigger_time'] ?: '—')],
                ['Received', (string) ($row['received_at'] ?: '—')],
            ])
            . ($attrRows ? '<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;letter-spacing:1px;color:#868DA8;margin:0 0 6px;">DETECTED ATTRIBUTES</div>'
                . EmailTemplate::rows($attrRows) : '')
            . EmailTemplate::buttons([
                ['Open dashboard', EmailTemplate::host() . '/', true],
                ['Acknowledge & triage', EmailTemplate::host() . '/', false],
            ]);
        $html = EmailTemplate::shell(
            $sevTag . ' ' . $modLabel . ' — ' . $what,
            $modLabel . ' ALERT · ' . $sevTag,
            $sevCol,
            $content
        );

        // Escalation-matrix routing: severity adds the configured targets
        // (Settings → Notifications) on top of the base recipients.
        $routing = $this->cfg['routing'] ?? [];
        $to = $mailCfg['to'];
        if ($sev === 'critical') {
            $to = array_merge($to, $routing['tmforce'] ?? [], $routing['soc'] ?? [], $routing['admin'] ?? []);
        } elseif ($sev === 'high') {
            $to = array_merge($to, $routing['soc'] ?? []);
        } elseif ($sev === 'medium') {
            $to = array_merge($to, $routing['supervisor'] ?? []);
        }
        $to = array_values(array_unique($to));

        try {
            (new Mailer($mailCfg))->send('[AIVA Dashboard] ' . $sevTag . ' ' . $modLabel . ' — ' . $what . ' @ ' . ($row['device_name'] ?: ($row['stream'] ?? '')), $html, $to);
        } catch (Throwable $e) {
            error_log('[mailer] ' . $e->getMessage());
        }
    }

    /**
     * Forward the raw event to the Weststar AI SenseTime middleware so it can run
     * LLM review + power the dashboard's AI analytics. Best-effort, non-fatal.
     */
    private function forwardWestarAI(array $payload): void
    {
        $base = $this->cfg['ai']['base'] ?? '';
        if ($base === '' || empty($this->cfg['ai']['forward']) || !function_exists('curl_init')) {
            return;
        }
        // Detections can arrive dozens per minute; the middleware is small.
        // Cap the rate and stop entirely for 10 minutes after a failure.
        require_once __DIR__ . '/Upstream.php';
        $dir = dirname((string) ($this->cfg['storage']['raw_log'] ?? (__DIR__ . '/../storage/x')));
        if (!Upstream::allow('westar_forward', $dir, 12)) {
            return;
        }
        $ch = curl_init($base . '/events');
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_SLASHES),
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 5,
            CURLOPT_CONNECTTIMEOUT => 3,
        ]);
        curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err  = curl_error($ch);
        curl_close($ch);
        if ($err !== '' || $code === 0 || $code >= 500) {
            Upstream::failed('westar_forward', $dir);
        } else {
            Upstream::ok('westar_forward', $dir);
        }
    }

    private function str(array $a, string $key): ?string
    {
        if (!array_key_exists($key, $a) || $a[$key] === null) {
            return null;
        }
        return is_scalar($a[$key]) ? (string) $a[$key] : json_encode($a[$key], JSON_UNESCAPED_SLASHES);
    }
}
