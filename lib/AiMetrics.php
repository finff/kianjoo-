<?php
/**
 * AI performance measured during the POC (scoring-matrix criteria 29 / 30 / 31).
 *
 * Nothing here is a vendor claim: every number is computed from what operators
 * recorded against real detections on this dashboard.
 *
 *   TP  a detection a reviewer confirmed as correct
 *         · incident_log "review" entries (forklift / restricted / behaviour
 *           review buttons, AI Performance sampling) whose verdict is
 *           violation / confirmed / correct
 *         · a ticket closed as "Issue resolved", "Fix scheduled" or
 *           "Under monitoring"
 *         · a cleaning session with activity observed and confirmed "Cleaned"
 *   FP  a detection cleared as a false alarm
 *         · review verdict cleared / authorized / false_alarm / wrong
 *         · "Mark as false alarm" / ticket closed as "False alarm"
 *         · activity observed in a cleaning window confirmed "Not done"
 *   FN  a missed detection — logged by hand on the AI Performance page
 *       (module, camera, time, note), plus cleaning sessions confirmed
 *       "Cleaned" where no activity was observed.
 *
 *   precision = TP / (TP + FP)    recall = TP / (TP + FN)    F1 = 2PR / (P + R)
 *
 * with 95 % Wilson intervals, so a small review sample shows as uncertain.
 * Breakdowns by camera and by lighting period (day 07:00–18:59 / night) give
 * "performance under actual factory conditions".
 */

declare(strict_types=1);

require_once __DIR__ . '/EventStore.php';
require_once __DIR__ . '/DashboardMapper.php';
require_once __DIR__ . '/WsdSettings.php';

final class AiMetrics
{
    public const MODULES = [
        'face'       => 'Face recognition',
        'ppe'        => 'PPE compliance',
        'restricted' => 'Restricted area / intrusion',
        'forklift'   => 'Forklift / pedestrian',
        'cleaning'   => 'Cleaning activity',
        'behaviour'  => 'Behaviour (loitering / fighting)',
        'fire'       => 'Fire, smoke & smoking',
    ];

    private const TP_WORDS = ['violation', 'confirmed', 'confirm', 'correct', 'true_positive', 'tp', 'valid', 'true'];
    private const FP_WORDS = ['cleared', 'authorized', 'false_alarm', 'false_positive', 'fp', 'false', 'wrong', 'invalid', 'not_done'];
    private const TP_REMARKS = ['[issue resolved]', '[fix scheduled]', '[under monitoring]'];
    private const FP_REMARKS = ['[false alarm]'];

    private const BEH_RE   = '/fight|altercation|brawl|violence|scuffle|conflict|\bfall|loiter|stay|linger|wander|dwell|chit.?chat|behaviou?r/i';
    private const CLEAN_RE = '/clean|mop|sweep|wipe/i';
    private const MAX_ROWS = 60000;
    private const PPE_FEATURES = ['HatsType', 'WithReflectiveVest', 'WithGlove', 'ExpressionType', 'ShoesType'];

    private PDO $pdo;
    private array $config;
    private EventStore $store;
    private string $dir;

    public function __construct(PDO $pdo, array $config, EventStore $store)
    {
        $this->pdo    = $pdo;
        $this->config = $config;
        $this->store  = $store;
        $this->dir    = WsdSettings::dirOf($config);
    }

    // ── Ingest-time thresholds (criterion 30) ────────────────

    /**
     * Apply the operator-tuned thresholds to one push before it is stored.
     * A face match under face_min_similarity loses its identity (becomes an
     * unknown person, tagged FaceBelowThreshold); a PPE attribute under
     * ppe_min_conf is dropped so PPE rules treat it as "not reported".
     *
     * @return array{0:array,1:array} [payload, decoded]
     */
    public static function applyThresholds(array $payload, array $decoded, array $config): array
    {
        $s = WsdSettings::of($config);
        $faceMin = (float) $s['face_min_similarity'];
        if ($faceMin > 0 && (($payload['personId'] ?? '') !== '' || ($payload['triggerPersonId'] ?? '') !== '')) {
            $sim = self::pct($payload['similarity'] ?? null);
            if ($sim !== null && $sim < $faceMin) {
                $decoded['map']['FaceBelowThreshold'] = $sim . ' < ' . $faceMin;
                $decoded['map']['FaceCandidate'] = (string) ($payload['personName'] ?? $payload['personId'] ?? '');
                $payload['personId'] = '';
                $payload['triggerPersonId'] = '';
                $payload['personName'] = '';
            }
        }
        $ppeMin = (float) $s['ppe_min_conf'];
        if ($ppeMin > 0 && !empty($decoded['list'])) {
            foreach ($decoded['list'] as $a) {
                $feat = (string) ($a['feature'] ?? '');
                $conf = self::pct($a['conf'] ?? null);
                if ($conf !== null && $conf < $ppeMin && (in_array($feat, self::PPE_FEATURES, true) || stripos($feat, 'goggle') !== false)) {
                    unset($decoded['map'][$feat]);
                    $decoded['map']['PpeLowConf'] = trim(($decoded['map']['PpeLowConf'] ?? '') . ' ' . $feat);
                }
            }
        }
        return [$payload, $decoded];
    }

    /** Similarity / confidence as 0-100 (SenseStudio sends 0-1 or 0-100). */
    public static function pct($v): ?float
    {
        if ($v === null || $v === '' || !is_numeric($v)) {
            return null;
        }
        $n = (float) $v;
        if ($n <= 0) {
            return null;
        }
        return round($n <= 1 ? $n * 100 : $n, 1);
    }

    // ── Classification ───────────────────────────────────────

    /** Which AI-performance module a stored event row belongs to. */
    public static function moduleOf(array $r): string
    {
        $dec = is_array($r['decoded'] ?? null) ? $r['decoded'] : (json_decode((string) ($r['decoded_json'] ?? ''), true) ?: []);
        $txt = ($r['trigger_image_type'] ?? '') . ' ' . ($r['event_type'] ?? '') . ' ' . ($r['policy_name'] ?? '') . ' ' . ($r['policy_desc'] ?? '');
        // Cleaning activity (custom cleaning-action policy, or tagged by the
        // behaviour engine as BehKind=cleaning) before the other behaviours.
        if (empty($dec['PpeMissing']) && (($dec['BehKind'] ?? '') === 'cleaning' || preg_match(self::CLEAN_RE, $txt))) {
            return 'cleaning';
        }
        foreach (array_keys($dec) as $k) {
            if (preg_match('/^(Beh|Behaviour|Fight|Loiter)/i', (string) $k)) {
                return 'behaviour';
            }
        }
        if (preg_match(self::BEH_RE, $txt)) {
            return 'behaviour';
        }
        $mod = DashboardMapper::modOf([
            'trigger_image_type' => $r['trigger_image_type'] ?? '', 'event_type' => $r['event_type'] ?? '',
            'policy_name' => $r['policy_name'] ?? '', 'policy_desc' => $r['policy_desc'] ?? '', 'decoded' => $dec,
        ]);
        if (in_array($mod, ['behaviour', 'behavior'], true)) {
            return 'behaviour';
        }
        if ($mod === 'intr') {
            return 'restricted';
        }
        if ($mod === 'face' && ($r['feed_kind'] ?? '') === 'body' && empty($r['person_id'])) {
            // A plain body-attribute push with no identity: counted under PPE
            // (attribute model) rather than face recognition.
            return 'ppe';
        }
        return isset(self::MODULES[$mod]) ? $mod : 'restricted';
    }

    public static function periodOf(string $time): string
    {
        $h = (int) substr($time, 11, 2);
        return ($h >= 7 && $h < 19) ? 'day' : 'night';
    }

    // ── Ground truth ─────────────────────────────────────────

    /** uuid → ['v' => tp|fp, 'src' => …] — latest recorded verdict wins. */
    private function logVerdicts(): array
    {
        $out = [];
        try {
            $q = $this->pdo->query("SELECT uuid, kind, to_val, note, actor, created_at FROM incident_log
                                    WHERE kind LIKE '%review%' OR kind = 'remark' ORDER BY id ASC");
        } catch (Throwable $e) {
            return [];
        }
        foreach ($q as $l) {
            $v = null;
            if ($l['kind'] === 'remark') {
                $n = strtolower(ltrim((string) $l['note']));
                foreach (self::FP_REMARKS as $p) {
                    if (str_starts_with($n, $p)) {
                        $v = 'fp';
                    }
                }
                foreach (self::TP_REMARKS as $p) {
                    if (str_starts_with($n, $p)) {
                        $v = 'tp';
                    }
                }
                $src = 'ticket closure';
            } else {
                $to = strtolower(trim((string) $l['to_val']));
                $v  = in_array($to, self::TP_WORDS, true) ? 'tp' : (in_array($to, self::FP_WORDS, true) ? 'fp' : null);
                $src = str_contains(strtolower((string) $l['note']), 'ai performance') ? 'AI sampling' : 'module review';
            }
            if ($v !== null) {
                $out[(string) $l['uuid']] = ['v' => $v, 'src' => $src, 'by' => (string) ($l['actor'] ?? ''), 'at' => (string) ($l['created_at'] ?? '')];
            }
        }
        return $out;
    }

    /** event id → verdict from reviewed forklift / restricted rows (covers events without uuid). */
    private function tableVerdicts(): array
    {
        $out = [];
        foreach (['forklift_events' => ['violation' => 'tp', 'cleared' => 'fp'],
                  'restricted_events' => ['violation' => 'tp', 'authorized' => 'fp']] as $t => $map) {
            try {
                foreach ($this->pdo->query("SELECT event_id, verdict FROM {$t} WHERE reviewed_by IS NOT NULL AND reviewed_by <> ''") as $r) {
                    if (isset($map[$r['verdict']])) {
                        $out[(int) $r['event_id']] = ['v' => $map[$r['verdict']], 'src' => 'module review'];
                    }
                }
            } catch (Throwable $e) {
                // table not migrated yet
            }
        }
        return $out;
    }

    // ── Missed detections (FN) ───────────────────────────────

    private function missedFile(): string
    {
        return $this->dir . '/ai_missed.json';
    }

    public function missed(): array
    {
        $f = $this->missedFile();
        $d = is_file($f) ? json_decode((string) @file_get_contents($f), true) : [];
        return is_array($d) ? array_values(array_filter($d, 'is_array')) : [];
    }

    private function saveMissed(array $list): void
    {
        @file_put_contents($this->missedFile(), json_encode(array_values($list), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX);
    }

    public function addMissed(array $in, string $actor): array
    {
        $mod = (string) ($in['module'] ?? '');
        if (!isset(self::MODULES[$mod])) {
            throw new InvalidArgumentException('Unknown module.');
        }
        $time = trim((string) ($in['time'] ?? ''));
        $ts   = $time !== '' ? strtotime(str_replace('T', ' ', $time)) : time();
        if ($ts === false) {
            throw new InvalidArgumentException('Invalid time.');
        }
        $cam = strtolower(preg_replace('/[^a-z0-9_.-]+/i', '', substr(trim((string) ($in['camera'] ?? '')), 0, 64)));
        $row = [
            'id'       => bin2hex(random_bytes(6)),
            'module'   => $mod,
            'camera'   => $cam,
            'time'     => date('Y-m-d H:i:s', $ts),
            'note'     => substr(trim((string) ($in['note'] ?? '')), 0, 500),
            'evidence' => substr(trim((string) ($in['evidence'] ?? '')), 0, 500),
            'actor'    => substr($actor, 0, 100),
            'created_at' => date('Y-m-d H:i:s'),
            'sim'      => !empty($in['sim']),
        ];
        $list = $this->missed();
        $list[] = $row;
        $this->saveMissed(array_slice($list, -5000));
        return $row;
    }

    public function deleteMissed(string $id): bool
    {
        $list = $this->missed();
        $new  = array_values(array_filter($list, static fn ($m) => ($m['id'] ?? '') !== $id));
        if (count($new) === count($list)) {
            return false;
        }
        $this->saveMissed($new);
        return true;
    }

    // ── Sampling review (ground truth for any module, incl. face) ──

    public function verify(string $uuid, string $verdict, string $actor, string $note = ''): bool
    {
        if (!in_array($verdict, ['correct', 'wrong'], true) || $uuid === '' || !$this->store->find($uuid)) {
            return false;
        }
        $this->store->addLog($uuid, 'review', $actor, 'ai-sample', $verdict === 'correct' ? 'confirmed' : 'false_alarm',
            'AI performance sampling: ' . ($verdict === 'correct' ? 'detection confirmed correct' : 'marked as false alarm')
            . ($note !== '' ? ' — ' . substr($note, 0, 300) : ''));
        if ($verdict === 'wrong') {
            $this->store->setStatus($uuid, 'resolved', null);
        }
        return true;
    }

    // ── Summary ──────────────────────────────────────────────

    private function range(array $f): array
    {
        $re  = '/^\d{4}-\d{2}-\d{2}$/';
        $to  = preg_match($re, (string) ($f['to'] ?? '')) ? (string) $f['to'] : date('Y-m-d');
        $from = preg_match($re, (string) ($f['from'] ?? '')) ? (string) $f['from'] : date('Y-m-d', strtotime($to) - 29 * 86400);
        if ($to < $from) {
            [$from, $to] = [$to, $from];
        }
        return [$from, $to];
    }

    private function locMap(): array
    {
        return $this->config['poc']['cam_locations'] ?? [];
    }

    private function plantOfCam(string $stream): string
    {
        static $att = null;
        $loc = (string) ($this->locMap()[$stream] ?? '');
        if ($loc === '') {
            return '';
        }
        try {
            require_once __DIR__ . '/Attendance.php';
            $att ??= new Attendance($this->store, $this->config);
            return $att->plantOf($loc);
        } catch (Throwable $e) {
            return '';
        }
    }

    /**
     * Every classified detection in range with its verdict.
     * @return list<array{id:int,uuid:string,mod:string,cam:string,camName:string,time:string,period:string,v:?string,src:?string,sim:?float,pid:string,stranger:bool,image:?string,title:string}>
     */
    private function detections(string $from, string $to, array $f): array
    {
        $st = $this->pdo->prepare('SELECT id, uuid, stream, device_name, received_at, policy_name, policy_desc, trigger_image_type,
                                          event_type, decoded_json, person_id, person_name, similarity, feed_kind, trigger_img_url, raw_json
                                     FROM events WHERE received_at >= :a AND received_at < :b ORDER BY id DESC LIMIT ' . self::MAX_ROWS);
        $st->execute(['a' => $from . ' 00:00:00', 'b' => date('Y-m-d', strtotime($to) + 86400) . ' 00:00:00']);
        $lv = $this->logVerdicts();
        $tv = $this->tableVerdicts();
        $out = [];
        while ($r = $st->fetch()) {
            $cam = (string) ($r['stream'] ?? '');
            if (!empty($f['camera']) && $cam !== $f['camera']) {
                continue;
            }
            $dec = json_decode((string) ($r['decoded_json'] ?? ''), true) ?: [];
            $r['decoded'] = $dec;
            $mod = self::moduleOf($r);
            if (!empty($f['module']) && $mod !== $f['module']) {
                continue;
            }
            if (!empty($f['plant']) && $this->plantOfCam($cam) !== $f['plant']) {
                continue;
            }
            $ver = $lv[(string) $r['uuid']] ?? ($tv[(int) $r['id']] ?? null);
            $raw = null;
            $stranger = false;
            if ($mod === 'face') {
                $raw = json_decode((string) ($r['raw_json'] ?? ''), true) ?: [];
                $stranger = DashboardMapper::isStranger(['event_type' => $r['event_type'], 'policy_name' => $r['policy_name'],
                    'attributes' => $raw['attributes'] ?? [], 'raw' => $raw]);
            }
            $out[] = [
                'id' => (int) $r['id'], 'uuid' => (string) $r['uuid'], 'mod' => $mod, 'cam' => $cam,
                'camName' => (string) ($r['device_name'] ?: $cam), 'time' => (string) $r['received_at'],
                'period' => self::periodOf((string) $r['received_at']),
                'v' => $ver['v'] ?? null, 'src' => $ver['src'] ?? null,
                'sim' => self::pct($r['similarity'] ?? null), 'pid' => (string) ($r['person_id'] ?? ''),
                'stranger' => $stranger, 'image' => $this->store->fullUrl($r['trigger_img_url'] ?? null),
                'title' => trim((string) ($r['policy_name'] ?: $r['event_type'])) . ($r['person_name'] ? ' · ' . $r['person_name'] : ''),
                'below' => isset($dec['FaceBelowThreshold']),
            ];
        }
        return $out;
    }

    /** Cleaning sessions as ground truth: observed activity vs supervisor confirmation. */
    private function cleaningTruth(string $from, string $to, array $f): array
    {
        if (empty($this->config['cleaning']['schedules']) || (!empty($f['module']) && $f['module'] !== 'cleaning')) {
            return [];
        }
        try {
            require_once __DIR__ . '/Attendance.php';
            require_once __DIR__ . '/Cleaning.php';
            [$sessions] = (new Cleaning($this->pdo, $this->config, $this->store))->sessions(['from' => $from, 'to' => $to, 'plant' => $f['plant'] ?? '']);
        } catch (Throwable $e) {
            return [];
        }
        $camOf = [];
        foreach ($this->locMap() as $k => $loc) {
            $camOf[$loc] ??= $k;
        }
        $out = [];
        foreach ($sessions as $s) {
            if (empty($s['confirmed']) || $s['state'] !== 'ended') {
                continue;
            }
            $cam = (string) ($camOf[$s['location']] ?? '');
            if (!empty($f['camera']) && $cam !== $f['camera']) {
                continue;
            }
            $seen = ($s['detections'] ?? 0) > 0;
            $v = $s['confirmed'] === 'done' ? ($seen ? 'tp' : 'fn') : ($seen ? 'fp' : null);
            if ($v !== null) {
                $out[] = ['mod' => 'cleaning', 'cam' => $cam, 'camName' => $s['location'], 'period' => self::periodOf((string) $s['start']), 'v' => $v];
            }
        }
        return $out;
    }

    public static function wilson(int $k, int $n): ?array
    {
        if ($n <= 0) {
            return null;
        }
        $z = 1.96;
        $p = $k / $n;
        $den = 1 + $z * $z / $n;
        $c = ($p + $z * $z / (2 * $n)) / $den;
        $h = $z * sqrt($p * (1 - $p) / $n + $z * $z / (4 * $n * $n)) / $den;
        return [round(max(0, $c - $h) * 100, 1), round(min(1, $c + $h) * 100, 1)];
    }

    /** Metrics block from TP / FP / FN counts. */
    public static function metrics(int $tp, int $fp, int $fn, int $det = 0): array
    {
        $p = ($tp + $fp) > 0 ? $tp / ($tp + $fp) : null;
        $r = ($tp + $fn) > 0 ? $tp / ($tp + $fn) : null;
        $f1 = ($p !== null && $r !== null && ($p + $r) > 0) ? 2 * $p * $r / ($p + $r) : null;
        $n = $tp + $fp;
        return [
            'detections' => $det, 'tp' => $tp, 'fp' => $fp, 'fn' => $fn, 'reviewed' => $n,
            'precision' => $p === null ? null : round($p * 100, 1),
            'recall'    => $r === null ? null : round($r * 100, 1),
            'f1'        => $f1 === null ? null : round($f1 * 100, 1),
            'precisionCi' => self::wilson($tp, $n),
            'recallCi'    => self::wilson($tp, $tp + $fn),
            'coverage'  => $det > 0 ? round(min(100, 100 * $n / $det), 1) : null,
            'confidence' => $n >= 100 ? 'high' : ($n >= 30 ? 'medium' : ($n > 0 ? 'low' : 'none')),
        ];
    }

    public function summary(array $f): array
    {
        [$from, $to] = $this->range($f);
        $f['module'] = isset(self::MODULES[$f['module'] ?? '']) ? $f['module'] : '';
        $dets = $this->detections($from, $to, $f);
        $cl   = $this->cleaningTruth($from, $to, $f);
        $a = strtotime($from . ' 00:00:00');
        $b = strtotime($to . ' 00:00:00') + 86400;
        $missed = array_values(array_filter($this->missed(), function ($m) use ($a, $b, $f) {
            $t = strtotime((string) ($m['time'] ?? '')) ?: 0;
            return $t >= $a && $t < $b
                && (empty($f['module']) || $m['module'] === $f['module'])
                && (empty($f['camera']) || $m['camera'] === $f['camera'])
                && (empty($f['plant']) || $this->plantOfCam((string) $m['camera']) === $f['plant']);
        }));

        $blank = static fn () => ['det' => 0, 'tp' => 0, 'fp' => 0, 'fn' => 0];
        $byMod = $byCam = $byPer = $camNames = [];
        foreach (array_keys(self::MODULES) as $m) {
            $byMod[$m] = $blank();
            $byPer[$m] = ['day' => $blank(), 'night' => $blank()];
        }
        $add = static function (array &$acc, string $k) {
            $acc[$k]++;
        };
        foreach ($dets as $d) {
            $m = $d['mod'];
            $byMod[$m]['det']++;
            $byPer[$m][$d['period']]['det']++;
            $ck = $d['cam'] . '|' . $m;
            $byCam[$ck] ??= $blank();
            $byCam[$ck]['det']++;
            $camNames[$d['cam']] = $d['camName'];
            if ($d['v']) {
                $add($byMod[$m], $d['v']);
                $add($byPer[$m][$d['period']], $d['v']);
                $add($byCam[$ck], $d['v']);
            }
        }
        foreach ($cl as $c) {
            $add($byMod['cleaning'], $c['v']);
            $add($byPer['cleaning'][$c['period']], $c['v']);
            $ck = $c['cam'] . '|cleaning';
            $byCam[$ck] ??= $blank();
            $add($byCam[$ck], $c['v']);
            $camNames[$c['cam']] ??= $c['camName'];
        }
        foreach ($missed as $x) {
            $m = $x['module'];
            $per = self::periodOf((string) $x['time']);
            $byMod[$m]['fn']++;
            $byPer[$m][$per]['fn']++;
            $ck = $x['camera'] . '|' . $m;
            $byCam[$ck] ??= $blank();
            $byCam[$ck]['fn']++;
            $camNames[$x['camera']] ??= $x['camera'];
        }

        $modules = [];
        $tot = $blank();
        foreach (self::MODULES as $m => $label) {
            if ($f['module'] && $m !== $f['module']) {
                continue;
            }
            $c = $byMod[$m];
            foreach ($tot as $k => $_) {
                $tot[$k] += $c[$k];
            }
            $modules[] = ['module' => $m, 'label' => $label] + self::metrics($c['tp'], $c['fp'], $c['fn'], $c['det'])
                + ['day' => self::metrics($byPer[$m]['day']['tp'], $byPer[$m]['day']['fp'], $byPer[$m]['day']['fn'], $byPer[$m]['day']['det']),
                   'night' => self::metrics($byPer[$m]['night']['tp'], $byPer[$m]['night']['fp'], $byPer[$m]['night']['fn'], $byPer[$m]['night']['det'])];
        }
        $cams = [];
        foreach ($byCam as $k => $c) {
            [$cam, $m] = explode('|', $k, 2);
            $cams[] = ['camera' => $cam, 'name' => $camNames[$cam] ?? $cam, 'location' => (string) ($this->locMap()[$cam] ?? ''),
                       'plant' => $this->plantOfCam($cam), 'module' => $m, 'label' => self::MODULES[$m] ?? $m]
                + self::metrics($c['tp'], $c['fp'], $c['fn'], $c['det']);
        }
        usort($cams, static fn ($x, $y) => [$y['reviewed'] + $y['fn'], $y['detections']] <=> [$x['reviewed'] + $x['fn'], $x['detections']]);

        $periods = [];
        foreach (['day' => 'Day (07:00–18:59)', 'night' => 'Night (19:00–06:59)'] as $p => $label) {
            $c = $blank();
            foreach ($byPer as $m => $pp) {
                if ($f['module'] && $m !== $f['module']) {
                    continue;
                }
                foreach ($c as $k => $_) {
                    $c[$k] += $pp[$p][$k];
                }
            }
            $periods[] = ['period' => $p, 'label' => $label] + self::metrics($c['tp'], $c['fp'], $c['fn'], $c['det']);
        }

        // Face recognition: similarity distribution + match rate.
        $face = ['total' => 0, 'matched' => 0, 'strangers' => 0, 'belowThreshold' => 0, 'avgSim' => null, 'bins' => []];
        $bins = ['<70' => 0, '70-80' => 0, '80-85' => 0, '85-90' => 0, '90-95' => 0, '95-100' => 0];
        $simSum = $simN = 0;
        foreach ($dets as $d) {
            if ($d['mod'] !== 'face') {
                continue;
            }
            $face['total']++;
            if ($d['stranger']) {
                $face['strangers']++;
            } elseif ($d['pid'] !== '') {
                $face['matched']++;
            }
            if ($d['below']) {
                $face['belowThreshold']++;
            }
            if ($d['sim'] !== null && $d['pid'] !== '') {
                $s = $d['sim'];
                $simSum += $s;
                $simN++;
                $bins[$s < 70 ? '<70' : ($s < 80 ? '70-80' : ($s < 85 ? '80-85' : ($s < 90 ? '85-90' : ($s < 95 ? '90-95' : '95-100'))))]++;
            }
        }
        $face['avgSim'] = $simN ? round($simSum / $simN, 1) : null;
        $face['matchRate'] = $face['total'] ? round(100 * $face['matched'] / $face['total'], 1) : null;
        $face['bins'] = array_map(static fn ($k, $v) => ['range' => $k, 'count' => $v], array_keys($bins), $bins);

        // Unreviewed sample queue (newest first, spread across modules).
        $queue = [];
        $per = [];
        foreach ($dets as $d) {
            if ($d['v'] !== null || $d['uuid'] === '') {
                continue;
            }
            $per[$d['mod']] = ($per[$d['mod']] ?? 0) + 1;
            if ($per[$d['mod']] > 4) {
                continue;
            }
            $queue[] = ['uuid' => $d['uuid'], 'module' => $d['mod'], 'label' => self::MODULES[$d['mod']], 'camera' => $d['camName'],
                        'time' => $d['time'], 'title' => $d['title'], 'image' => $d['image'], 'sim' => $d['sim']];
            if (count($queue) >= 24) {
                break;
            }
        }
        // Latest recorded verdicts.
        $recent = [];
        foreach ($dets as $d) {
            if ($d['v'] !== null) {
                $recent[] = ['uuid' => $d['uuid'], 'module' => $d['mod'], 'label' => self::MODULES[$d['mod']], 'camera' => $d['camName'],
                             'time' => $d['time'], 'title' => $d['title'], 'verdict' => $d['v'], 'source' => $d['src'], 'image' => $d['image']];
                if (count($recent) >= 30) {
                    break;
                }
            }
        }
        usort($missed, static fn ($x, $y) => strcmp((string) $y['time'], (string) $x['time']));
        $th = WsdSettings::of($this->config);

        return [
            'from' => $from, 'to' => $to, 'filters' => ['module' => $f['module'], 'camera' => $f['camera'] ?? '', 'plant' => $f['plant'] ?? ''],
            'modules' => $modules,
            'overall' => self::metrics($tot['tp'], $tot['fp'], $tot['fn'], $tot['det']),
            'cameras' => array_slice($cams, 0, 200),
            'periods' => $periods,
            'face' => $face,
            'queue' => $queue,
            'recent' => $recent,
            'missed' => array_slice(array_map(fn ($m) => $m + ['label' => self::MODULES[$m['module']] ?? $m['module'],
                'cameraName' => $camNames[$m['camera']] ?? $m['camera']], $missed), 0, 100),
            'moduleList' => array_map(static fn ($k, $v) => ['v' => $k, 'label' => $v], array_keys(self::MODULES), self::MODULES),
            'cameraList' => $this->cameraList(),
            'plants' => array_values($this->config['attendance']['plants'] ?? []),
            'thresholds' => ['face_min_similarity' => $th['face_min_similarity'], 'ppe_min_conf' => $th['ppe_min_conf']],
            'truncated' => count($dets) >= self::MAX_ROWS,
        ];
    }

    /** Cameras seen in the last 30 days + mapped POC points. */
    public function cameraList(): array
    {
        $out = [];
        try {
            $st = $this->pdo->prepare('SELECT stream, MAX(device_name) n FROM events WHERE received_at >= :a GROUP BY stream');
            $st->execute(['a' => date('Y-m-d H:i:s', time() - 30 * 86400)]);
            foreach ($st as $r) {
                if ((string) $r['stream'] !== '') {
                    $out[(string) $r['stream']] = (string) ($r['n'] ?: $r['stream']);
                }
            }
        } catch (Throwable $e) {
        }
        foreach ($this->locMap() as $k => $loc) {
            $out[$k] ??= $loc;
        }
        ksort($out);
        return array_map(static fn ($k, $v) => ['v' => (string) $k, 'label' => $v . ' (' . $k . ')'], array_keys($out), $out);
    }

    // ── Exports ──────────────────────────────────────────────

    public function exportRows(array $f): array
    {
        $s = $this->summary($f);
        $fmt = static fn ($v) => $v === null ? '' : $v;
        $ci = static fn ($c) => $c ? $c[0] . '–' . $c[1] : '';
        $head = ['Scope', 'Module', 'Camera', 'Location', 'Plant', 'Detections', 'Reviewed', 'TP', 'FP', 'FN',
                 'Precision %', 'Precision 95% CI', 'Recall %', 'Recall 95% CI', 'F1 %', 'Review coverage %', 'Confidence'];
        $line = static fn (string $scope, string $mod, string $cam, string $loc, string $plant, array $m) => [
            $scope, $mod, $cam, $loc, $plant, $m['detections'], $m['reviewed'], $m['tp'], $m['fp'], $m['fn'],
            $fmt($m['precision']), $ci($m['precisionCi']), $fmt($m['recall']), $ci($m['recallCi']), $fmt($m['f1']),
            $fmt($m['coverage']), $m['confidence'],
        ];
        $rows = [['POC-measured AI performance', $s['from'] . ' to ' . $s['to'], 'Generated ' . date('Y-m-d H:i')], $head];
        $rows[] = $line('Overall', 'All modules', '', '', '', $s['overall']);
        foreach ($s['modules'] as $m) {
            $rows[] = $line('Module', $m['label'], '', '', '', $m);
            $rows[] = $line('Module · day', $m['label'], '', '', '', $m['day']);
            $rows[] = $line('Module · night', $m['label'], '', '', '', $m['night']);
        }
        foreach ($s['periods'] as $p) {
            $rows[] = $line('Lighting period', $p['label'], '', '', '', $p);
        }
        foreach ($s['cameras'] as $c) {
            $rows[] = $line('Camera', $c['label'], $c['name'], $c['location'], $c['plant'], $c);
        }
        $rows[] = [];
        $rows[] = ['Face recognition', 'Detections', $s['face']['total'], 'Matched', $s['face']['matched'], 'Strangers', $s['face']['strangers'],
                   'Match rate %', $fmt($s['face']['matchRate']), 'Avg similarity %', $fmt($s['face']['avgSim'])];
        foreach ($s['face']['bins'] as $bn) {
            $rows[] = ['Similarity ' . $bn['range'], $bn['count']];
        }
        $rows[] = [];
        $rows[] = ['Missed detections (FN)', 'Module', 'Camera', 'Time', 'Note', 'Logged by'];
        foreach ($s['missed'] as $m) {
            $rows[] = ['', $m['label'], $m['cameraName'], $m['time'], $m['note'], $m['actor']];
        }
        return $rows;
    }

    /** False positives + false negatives with evidence links — a retraining dataset for SenseStudio. */
    public function trainingRows(array $f): array
    {
        [$from, $to] = $this->range($f);
        $rows = [['Type', 'Module', 'Camera', 'Location', 'Time', 'Event UUID', 'Evidence image URL', 'Verdict source / note']];
        foreach ($this->detections($from, $to, $f) as $d) {
            if ($d['v'] === 'fp' || ($d['v'] === 'tp' && !empty($f['include_tp']))) {
                $rows[] = [$d['v'] === 'fp' ? 'False positive' : 'True positive', self::MODULES[$d['mod']], $d['camName'],
                           (string) ($this->locMap()[$d['cam']] ?? ''), $d['time'], $d['uuid'], (string) $d['image'], (string) $d['src']];
            }
        }
        $a = strtotime($from);
        $b = strtotime($to) + 86400;
        foreach ($this->missed() as $m) {
            $t = strtotime((string) $m['time']) ?: 0;
            if ($t >= $a && $t < $b && (empty($f['module']) || $m['module'] === $f['module'])) {
                $rows[] = ['False negative (missed)', self::MODULES[$m['module']] ?? $m['module'], $m['camera'],
                           (string) ($this->locMap()[$m['camera']] ?? ''), $m['time'], '', (string) ($m['evidence'] ?? ''), (string) $m['note']];
            }
        }
        return $rows;
    }

    // ── Simulator support ────────────────────────────────────

    /**
     * Demo ground truth for simulated detections: reviewers confirm or clear a
     * sample of demo events and log a few missed detections, so the AI
     * Performance page has numbers to show. Only touches demo-* uuids / DEMO cameras.
     */
    public static function simulateReviews(PDO $pdo, array $config, array $streams): array
    {
        $store = new EventStore($pdo, $config);
        $store->silent = true;
        $self = new self($pdo, $config, $store);
        $self->removeSimulated($streams);
        if (!$streams) {
            return ['reviews' => 0, 'missed' => 0];
        }
        $in = implode(',', array_fill(0, count($streams), '?'));
        $st = $pdo->prepare("SELECT id, uuid, stream, received_at, policy_name, policy_desc, trigger_image_type, event_type, decoded_json, person_id, feed_kind
                               FROM events WHERE stream IN ({$in}) AND uuid LIKE 'demo-%' ORDER BY id ASC");
        $st->execute($streams);
        $have = [];
        try {
            foreach ($pdo->query("SELECT DISTINCT uuid FROM incident_log WHERE uuid LIKE 'demo-%' AND (kind LIKE '%review%' OR kind = 'remark')") as $r) {
                $have[(string) $r['uuid']] = true;
            }
        } catch (Throwable $e) {
        }
        // Per-module FP rate for the demo (night slightly worse — lighting).
        $fpRate = ['face' => 3, 'ppe' => 9, 'restricted' => 7, 'forklift' => 6, 'cleaning' => 12, 'behaviour' => 15, 'fire' => 10];
        $ins = $pdo->prepare('INSERT INTO incident_log (uuid, kind, actor, from_val, to_val, note, created_at) VALUES (:u, :k, :a, :f, :t, :n, :c)');
        $n = 0;
        $byMod = [];
        while ($r = $st->fetch()) {
            if (isset($have[(string) $r['uuid']]) || mt_rand(1, 100) > 40) {
                continue;
            }
            $mod = self::moduleOf($r);
            $night = self::periodOf((string) $r['received_at']) === 'night';
            $fp = mt_rand(1, 100) <= ($fpRate[$mod] ?? 8) + ($night ? 5 : 0);
            $byMod[$mod][] = (string) $r['stream'];
            $ins->execute(['u' => $r['uuid'], 'k' => 'review', 'a' => 'Simulator (POC reviewer)', 'f' => 'ai-sample',
                           't' => $fp ? 'false_alarm' : 'confirmed',
                           'n' => 'AI performance sampling (simulated): ' . ($fp ? 'marked as false alarm' : 'detection confirmed correct'),
                           'c' => date('Y-m-d H:i:s', (strtotime((string) $r['received_at']) ?: time()) + mt_rand(5, 90) * 60)]);
            $n++;
        }
        $m = 0;
        foreach ($byMod as $mod => $cams) {
            $k = max(1, (int) round(count($cams) * ($mod === 'face' ? 0.03 : 0.08)));
            for ($i = 0; $i < $k; $i++) {
                $cam = $cams[array_rand($cams)];
                $ts  = time() - mt_rand(1, 6 * 86400);
                $self->addMissed(['module' => $mod, 'camera' => $cam, 'time' => date('Y-m-d H:i:s', $ts), 'sim' => true,
                                  'note' => 'Simulated: reviewer saw the situation on the recording but no detection was raised'], 'Simulator (POC reviewer)');
                $m++;
            }
        }
        return ['reviews' => $n, 'missed' => $m];
    }

    /** Drop simulated missed-detection rows (demo cameras). */
    public function removeSimulated(array $streams): int
    {
        $list = $this->missed();
        $keep = array_values(array_filter($list, static fn ($x) => empty($x['sim']) && !in_array((string) ($x['camera'] ?? ''), $streams, true)));
        if (count($keep) !== count($list)) {
            $this->saveMissed($keep);
        }
        return count($list) - count($keep);
    }
}
