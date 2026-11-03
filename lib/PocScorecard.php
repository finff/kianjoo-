<?php
/**
 * POC scorecard (scoring-matrix criteria 46 / 48): the Kian Joo "Vendor
 * Evaluation & POC Scoring Matrix" (54 weighted criteria, total weight 141,
 * 21 test cases, POC 7–12 September 2026) kept as a live, editable sheet,
 * with live system evidence attached to each test case and a printable
 * final-report view. Storage: storage/poc_scorecard.json.
 *
 * Weighted score = weight × score / 5 (max 141). Overall % = Σ weighted /
 * Σ weight of the criteria not marked N/A. Average score (0–5) =
 * Σ(weight × score) / Σ weight of scored criteria → interpretation band
 * (4.0–5.0 strong · 3.0–3.9 acceptable with conditions · 2.0–2.9 significant
 * gaps · below 2.0 not recommended).
 */

declare(strict_types=1);

require_once __DIR__ . '/EventStore.php';
require_once __DIR__ . '/WsdSettings.php';

final class PocScorecard
{
    public const STATUSES = ['Not Tested', 'Pass', 'Partial', 'Fail', 'N/A'];
    public const RESULTS  = ['', 'Pass', 'Fail', 'Partial', 'Not Tested'];

    /** [no, category, criterion, weight, dashboard evidence, page] — exact wording + weights from the PDF. */
    public const CRITERIA = [
        [1, 'Personnel Identification', 'Facial recognition accuracy for ~200 Plant 1 employees', 8, 'SenseStudio face library synced from Employees (enrol + sync). Match similarity per detection; AI Performance shows face match rate, similarity distribution and reviewer-verified precision / recall.', 'aiperf'],
        [2, 'Personnel Identification', 'Unknown personnel identification / classification', 3, 'Stranger (person group −99) detections are classified Unknown, raised High, and listed on Face Registration for later enrolment.', 'faces'],
        [3, 'Personnel Identification', 'Employee information display: name, ID, location, date/time', 2, 'Attendance & Movement and incident detail show employee name, staff ID, camera point / location and timestamp for every recognition.', 'attendance'],
        [4, 'Attendance & Tracking', 'Attendance detection and historical attendance records', 5, 'Clock-in / clock-out from facial recognition at the mapped guard-post cameras, shift rules, late / absent flags, date-range register and CSV export.', 'attendance'],
        [5, 'Attendance & Tracking', 'Cross-camera personnel tracking', 5, 'Movement journey links every sighting of a person across all mapped cameras into one timeline.', 'attendance'],
        [6, 'Attendance & Tracking', 'Point-to-point movement tracking', 4, 'Movement report groups sightings into visits (arrive / depart / dwell) per camera point.', 'attendance'],
        [7, 'Attendance & Tracking', 'Inter-plant tracking between Plant 1 and Plant 2', 5, 'Camera points are mapped to plants; attendance rows list the plants visited and the integration API reports plant transitions.', 'attendance'],
        [8, 'Attendance & Tracking', 'Historical movement logs and investigation capability', 3, 'Movement history by person and date range, searchable and exportable (movement CSV, /api/integration/movement).', 'attendance'],
        [9, 'Alerting & Escalation', 'Real-time abnormal movement / predefined condition alerts', 3, 'Alert Rules per module / severity / camera; detections alert in real time on ingest (notification bell, incident list, email).', 'rules'],
        [10, 'Alerting & Escalation', 'Email notification', 1, 'SMTP alert emails with the detection frame on severe detections, plus escalation emails from the incident ticket.', 'rules'],
        [11, 'Alerting & Escalation', 'Telegram notification', 2, 'Telegram bot alerts alongside email (Settings → Notifications).', 'settings'],
        [12, 'Alerting & Escalation', 'Configurable multi-level escalation / 5-minute unattended alert workflow', 2, 'Unattended alerts auto-escalate L1 → L2 → L3 after the configured minutes (default 5), logged on the incident timeline.', 'settings'],
        [13, 'Restricted Area', 'Restricted zone detection and intrusion alerting', 5, 'Restricted zones per camera with hours; every entry is judged, recorded and alerted (Restricted Area page).', 'intr'],
        [14, 'Restricted Area', 'Authorized vs unauthorized personnel differentiation', 3, 'Entries are matched against allowed staff / departments: authorized, violation, or review when the face is not identifiable.', 'intr'],
        [15, 'Restricted Area', 'Forklift / pedestrian differentiation at Waste Area', 3, 'Forklift-only zone mode: forklift detections vs pedestrian intrusions counted separately per zone (Forklift Monitoring).', 'forklift'],
        [16, 'Restricted Area', 'Forklift operator PPE verification', 3, 'Person detections near a forklift detection are checked against the zone operator-PPE list (helmet + vest by default).', 'forklift'],
        [17, 'PPE Compliance', 'Safety vest detection', 2, 'SenseStudio pedestrian attribute WithReflectiveVest, checked against PPE Area Rules.', 'ppe'],
        [18, 'PPE Compliance', 'Hard helmet detection', 2, 'SenseStudio pedestrian attribute HatsType = Helmet, checked against PPE Area Rules.', 'ppe'],
        [19, 'PPE Compliance', 'Safety boots detection', 2, 'Attribute ShoesType = Boots (native pedestrian attribute).', 'ppe'],
        [20, 'PPE Compliance', 'Hair net detection', 1, 'Attribute proxy (HatsType Bonnet) or a custom SenseStudio model — labelled as such on the PPE page.', 'ppe'],
        [21, 'PPE Compliance', 'Gloves detection', 1, 'SenseStudio pedestrian attribute WithGlove.', 'ppe'],
        [22, 'PPE Compliance', 'Ear protection detection / feasibility', 1, 'No native attribute — requires a custom SenseStudio model; events from such a model are processed when present.', 'ppe'],
        [23, 'PPE Compliance', 'Safety goggles detection / feasibility', 1, 'Goggles attribute when sent, else the glasses estimate (ExpressionType) as a proxy.', 'ppe'],
        [24, 'Line 5 Behavioural Analytics', 'Normal production activity recognition', 3, 'Behaviour Analytics: presence at Line 5 with no exception active is classified as normal operation (% of monitored time).', 'behaviour'],
        [25, 'Line 5 Behavioural Analytics', 'Chit-chat / loitering detection', 3, 'Group dwell / loitering beyond the configured threshold, or a SenseStudio loitering policy.', 'behaviour'],
        [26, 'Line 5 Behavioural Analytics', 'Cleaning activity detection', 3, 'Cleaning sessions: scheduled vs observed vs supervisor-confirmed, plus custom cleaning-action policies.', 'cleaning'],
        [27, 'Line 5 Behavioural Analytics', 'Fighting / physical altercation detection', 4, 'Fight / altercation policy events from a SenseStudio behaviour model raise critical alerts with the frame.', 'behaviour'],
        [28, 'Line 5 Behavioural Analytics', 'Cleaning PPE verification: gloves + safety goggles', 2, 'During cleaning windows everyone detected at the area is checked for gloves + goggles (Cleaning Monitoring).', 'cleaning'],
        [29, 'AI Performance', 'Documented detection accuracy / precision / recall / F1 or equivalent metrics', 3, 'AI Performance page: TP / FP / FN per module from reviewer verdicts and logged misses, precision / recall / F1 with 95 % intervals, CSV export.', 'aiperf'],
        [30, 'AI Performance', 'Model training / customization capability', 2, 'Settings → Models: per-module thresholds applied at ingest, and a false-positive / missed-detection dataset export for retraining in SenseStudio.', 'settings'],
        [31, 'AI Performance', 'Performance under actual factory lighting / occlusion / camera angles', 3, 'AI Performance breakdown by camera and by lighting period (day / night), measured on site.', 'aiperf'],
        [32, 'Infrastructure', 'Compatibility with existing CCTV cameras / ONVIF / RTSP', 3, 'Existing cameras connect by RTSP to SenseStudio and the live bridge; Settings → Live Video lists every source with a probe.', 'settings'],
        [33, 'Infrastructure', 'Compatibility with existing PoE network and switches', 2, 'See docs/ARCHITECTURE_AND_INFRASTRUCTURE.md — PoE budget and switch requirements.', 'poc'],
        [34, 'Infrastructure', 'Network bandwidth and latency suitability', 2, 'Settings → Live Video → Network test: TCP latency, loss proxy, TTFB and stream throughput per source with pass / warn thresholds.', 'settings'],
        [35, 'Infrastructure', 'NVR / VMS / AI processing architecture suitability', 3, 'Edge AI box (SenseStudio) pulls RTSP alongside the NVR; dashboard receives pushes — see the architecture document.', 'poc'],
        [36, 'Infrastructure', 'Storage capacity and retention recommendation', 2, 'Settings → Data Retention: configurable retention with daily auto-purge, live storage use and projection.', 'settings'],
        [37, 'Infrastructure', 'Scalability for future multi-plant deployment', 3, 'Plants are first-class (camera → location → plant); one dashboard + per-plant edge boxes — see the architecture document.', 'poc'],
        [38, 'Reporting & Dashboard', 'Attendance and personnel analytics dashboard', 2, 'Attendance & Movement and Employees pages with KPIs and exports.', 'attendance'],
        [39, 'Reporting & Dashboard', 'PPE / safety / restricted-area analytics', 2, 'PPE Compliance, Restricted Area and Forklift pages: KPIs, trends, breakdowns, CSV.', 'ppe'],
        [40, 'Reporting & Dashboard', 'Behavioural trend and exception reporting', 2, 'Behaviour Analytics trend and exception report with CSV export.', 'behaviour'],
        [41, 'Reporting & Dashboard', 'Real-time monitoring / alert management dashboard', 2, 'Overview, Live Feeds and Incidents (acknowledge / resolve / ticket lifecycle).', 'incidents'],
        [42, 'Reporting & Dashboard', 'Heatmap / incident investigation / trend analysis', 2, 'Analytics heatmap (camera × hour, weekday × hour), Forecast and incident search.', 'analytics'],
        [43, 'Integration & Roadmap', 'HRMS integration readiness / API capability', 2, 'Integration API (attendance, persons, movement) with API key + webhooks for clock-in / out — docs/INTEGRATION_API.md.', 'settings'],
        [44, 'Integration & Roadmap', 'MES integration readiness / API capability', 2, 'Integration API (events, PPE) + signed incident webhooks.', 'settings'],
        [45, 'Integration & Roadmap', 'Enterprise multi-plant centralized management', 2, 'Central dashboard with plant filter on every page and every integration endpoint.', 'overview'],
        [46, 'POC Execution', 'POC methodology and test plan quality', 2, 'docs/POC_TEST_PLAN.md: methodology, schedule, 21 test procedures with pass criteria and evidence.', 'poc'],
        [47, 'POC Execution', 'One-week POC implementation readiness', 2, 'Detection simulator, camera-point mapping and settings ready for the 7–12 Sep 2026 window.', 'settings'],
        [48, 'POC Execution', 'Quality of findings, metrics and final POC report', 3, 'This scorecard: live evidence per test, AI metrics, CSV export and the printable final report.', 'poc'],
        [49, 'Commercial', 'Hardware/software cost competitiveness', 2, 'Commercial — to be assessed from the vendor quotation.', ''],
        [50, 'Commercial', 'Licensing model and total cost of ownership', 2, 'Commercial — to be assessed from the vendor quotation.', ''],
        [51, 'Commercial', 'Cost optimization using existing infrastructure', 2, 'Reuses existing CCTV cameras, PoE switches and NVR (RTSP); only the AI box and server are added.', ''],
        [52, 'Vendor Capability', 'Relevant references / proven factory deployments', 2, 'Vendor capability — references to be provided.', ''],
        [53, 'Vendor Capability', 'Technical support and response capability', 2, 'Vendor capability — support SLA to be provided.', ''],
        [54, 'Vendor Capability', 'Overall solution maturity and reliability', 3, 'Observed uptime, ingest stability and the issues log during the POC week.', ''],
    ];

    /** [id, area, test case, expected result, related criteria] — from the PDF. */
    public const TESTS = [
        ['FR-01', 'Facial Recognition', 'Register and identify Plant 1 employee', 'Correct employee name/ID displayed', [1, 3]],
        ['FR-02', 'Facial Recognition', 'Unknown person detection', 'Person classified as unknown', [2]],
        ['TR-01', 'Tracking', 'Track employee across multiple cameras', 'Continuous / linked movement history', [5, 6]],
        ['TR-02', 'Tracking', 'Track movement Plant 1 → Plant 2', 'Correct cross-plant movement record', [7]],
        ['RA-01', 'Restricted Area', 'Unauthorized person enters restricted zone', 'Real-time alert + event recording', [13, 14]],
        ['RA-02', 'Waste Area', 'Pedestrian enters forklift-only zone', 'Pedestrian intrusion alert', [15]],
        ['PPE-01', 'PPE', 'Hard helmet detection', 'Correct compliance/non-compliance classification', [18]],
        ['PPE-02', 'PPE', 'Safety vest detection', 'Correct compliance/non-compliance classification', [17]],
        ['PPE-03', 'PPE', 'Gloves / goggles during cleaning', 'Correct detection where supported', [21, 23, 28]],
        ['BEH-01', 'Line 5', 'Normal production activity', 'Classified as normal operation', [24]],
        ['BEH-02', 'Line 5', 'Chit-chat / loitering', 'Event detected after configured threshold', [25]],
        ['BEH-03', 'Line 5', 'Cleaning activity', 'Cleaning event detected', [26]],
        ['BEH-04', 'Line 5', 'Fighting / physical altercation', 'Abnormal event detected and alerted', [27]],
        ['ALT-01', 'Alerting', 'Email notification', 'Alert received by designated recipient', [10]],
        ['ALT-02', 'Alerting', 'Telegram notification', 'Alert received by designated recipient', [11]],
        ['ALT-03', 'Alerting', 'Escalation after 5 minutes', 'Escalates to next level when unattended', [12]],
        ['INF-01', 'Infrastructure', 'Connect existing CCTV stream', 'Stable video feed to AI/VMS', [32]],
        ['INF-02', 'Infrastructure', 'Network load test', 'No unacceptable packet loss/latency', [34]],
        ['REP-01', 'Reporting', 'Attendance report', 'Accurate searchable/exportable report', [4, 38]],
        ['REP-02', 'Reporting', 'Movement history', 'Search and trace personnel movement', [8]],
        ['REP-03', 'Reporting', 'PPE / safety dashboard', 'Trends and exceptions visible', [39]],
    ];

    /** Summary groups of the PDF's scoring summary → criteria numbers. */
    public const GROUPS = [
        'technical'      => ['Technical', [1, 28], [43, 45]],
        'ai'             => ['AI Accuracy', [29, 31]],
        'infrastructure' => ['Infrastructure', [32, 37]],
        'reporting'      => ['Reporting', [38, 42]],
        'commercial'     => ['Commercial', [49, 51]],
    ];

    public const BANDS = [
        [4.0, 'Strong candidate'],
        [3.0, 'Acceptable with conditions / improvements'],
        [2.0, 'Significant gaps'],
        [0.0, 'Not recommended for wider deployment'],
    ];

    private string $file;

    public function __construct(string $storageDir)
    {
        $this->file = $storageDir . '/poc_scorecard.json';
    }

    public function load(): array
    {
        $d = is_file($this->file) ? json_decode((string) @file_get_contents($this->file), true) : null;
        $d = is_array($d) ? $d : [];
        return [
            'criteria' => is_array($d['criteria'] ?? null) ? $d['criteria'] : [],
            'tests'    => is_array($d['tests'] ?? null) ? $d['tests'] : [],
            'report'   => is_array($d['report'] ?? null) ? $d['report'] : [],
            'updated_at' => (string) ($d['updated_at'] ?? ''),
            'updated_by' => (string) ($d['updated_by'] ?? ''),
        ];
    }

    private static function txt($v, int $n): string
    {
        return substr(trim((string) (is_scalar($v) ? $v : '')), 0, $n);
    }

    /** Merge a patch {criteria:{no:{…}}, tests:{id:{…}}, report:{…}} and save. */
    public function save(array $in, string $actor): array
    {
        $cur = $this->load();
        $nos = array_column(self::CRITERIA, 0);
        foreach ((array) ($in['criteria'] ?? []) as $no => $c) {
            $no = (int) $no;
            if (!in_array($no, $nos, true) || !is_array($c)) {
                continue;
            }
            $row = $cur['criteria'][(string) $no] ?? [];
            if (array_key_exists('score', $c)) {
                $row['score'] = ($c['score'] === '' || $c['score'] === null) ? null : max(0, min(5, (int) $c['score']));
            }
            foreach (['evidence' => 1000, 'observation' => 1000] as $k => $n) {
                if (array_key_exists($k, $c)) {
                    $row[$k] = self::txt($c[$k], $n);
                }
            }
            if (isset($c['status']) && in_array($c['status'], self::STATUSES, true)) {
                $row['status'] = $c['status'];
            }
            $cur['criteria'][(string) $no] = $row;
        }
        $ids = array_column(self::TESTS, 0);
        foreach ((array) ($in['tests'] ?? []) as $id => $t) {
            if (!in_array($id, $ids, true) || !is_array($t)) {
                continue;
            }
            $row = $cur['tests'][$id] ?? [];
            if (array_key_exists('score', $t)) {
                $row['score'] = ($t['score'] === '' || $t['score'] === null) ? null : max(0, min(5, (int) $t['score']));
            }
            foreach (['actual' => 1000, 'remarks' => 1000, 'evidence' => 500, 'tested_at' => 20, 'tested_by' => 100] as $k => $n) {
                if (array_key_exists($k, $t)) {
                    $row[$k] = self::txt($t[$k], $n);
                }
            }
            if (isset($t['result']) && in_array($t['result'], self::RESULTS, true)) {
                $row['result'] = $t['result'];
            }
            $cur['tests'][$id] = $row;
        }
        foreach (['vendor' => 120, 'summary' => 4000, 'strengths' => 4000, 'gaps' => 4000, 'recommendation' => 4000,
                  'prepared_by' => 120, 'report_date' => 20] as $k => $n) {
            if (array_key_exists($k, (array) ($in['report'] ?? []))) {
                $cur['report'][$k] = self::txt($in['report'][$k], $n);
            }
        }
        $cur['updated_at'] = date('Y-m-d H:i:s');
        $cur['updated_by'] = substr($actor, 0, 100);
        if (!is_dir(dirname($this->file))) {
            @mkdir(dirname($this->file), 0775, true);
        }
        file_put_contents($this->file, json_encode($cur, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), LOCK_EX);
        return $cur;
    }

    public static function band(?float $avg): string
    {
        if ($avg === null) {
            return 'Not scored yet';
        }
        foreach (self::BANDS as [$min, $label]) {
            if ($avg >= $min) {
                return $label;
            }
        }
        return self::BANDS[3][1];
    }

    private static function inGroup(int $no, array $ranges): bool
    {
        foreach ($ranges as $r) {
            if ($no >= $r[0] && $no <= $r[1]) {
                return true;
            }
        }
        return false;
    }

    /** Criteria rows + computed scores. */
    public function compute(array $saved): array
    {
        $rows = [];
        $acc = ['overall' => ['w' => 0, 'ws' => 0.0, 'sw' => 0, 'ss' => 0]];
        $cats = [];
        foreach (self::GROUPS as $g => $_) {
            $acc[$g] = ['w' => 0, 'ws' => 0.0, 'sw' => 0, 'ss' => 0];
        }
        $statusCount = array_fill_keys(self::STATUSES, 0);
        foreach (self::CRITERIA as [$no, $cat, $crit, $w, $ev, $page]) {
            $s = $saved['criteria'][(string) $no] ?? [];
            $score = isset($s['score']) && $s['score'] !== null ? (int) $s['score'] : null;
            $status = in_array($s['status'] ?? '', self::STATUSES, true) ? $s['status'] : 'Not Tested';
            $statusCount[$status]++;
            $weighted = $score === null ? 0.0 : round($w * $score / 5, 2);
            $row = ['no' => $no, 'category' => $cat, 'criterion' => $crit, 'weight' => $w, 'score' => $score,
                    'weighted' => $weighted, 'evidence' => (string) ($s['evidence'] ?? $ev), 'defaultEvidence' => $ev,
                    'observation' => (string) ($s['observation'] ?? ''), 'status' => $status, 'page' => $page];
            $rows[] = $row;
            if ($status === 'N/A') {
                continue;
            }
            $keys = ['overall'];
            foreach (self::GROUPS as $g => $def) {
                if (self::inGroup($no, array_slice($def, 1))) {
                    $keys[] = $g;
                }
            }
            $cats[$cat] ??= ['w' => 0, 'ws' => 0.0, 'sw' => 0, 'ss' => 0];
            foreach ($keys as $k) {
                $acc[$k]['w'] += $w;
                $acc[$k]['ws'] += $weighted;
                if ($score !== null) {
                    $acc[$k]['sw'] += $w;
                    $acc[$k]['ss'] += $w * $score;
                }
            }
            $cats[$cat]['w'] += $w;
            $cats[$cat]['ws'] += $weighted;
            if ($score !== null) {
                $cats[$cat]['sw'] += $w;
                $cats[$cat]['ss'] += $w * $score;
            }
        }
        $fmt = static fn (array $a, string $label) => [
            'label' => $label, 'weight' => $a['w'], 'weighted' => round($a['ws'], 2),
            'pct' => $a['w'] > 0 ? round(100 * $a['ws'] / $a['w'], 1) : null,
            'scoredWeight' => $a['sw'],
            'avg' => $a['sw'] > 0 ? round($a['ss'] / $a['sw'], 2) : null,
        ];
        $groups = [];
        foreach (self::GROUPS as $g => $def) {
            $groups[] = ['key' => $g] + $fmt($acc[$g], $def[0]);
        }
        $catOut = [];
        foreach ($cats as $c => $a) {
            $catOut[] = $fmt($a, $c);
        }
        $overall = $fmt($acc['overall'], 'Overall');
        $overall['band'] = self::band($overall['avg']);
        $overall['totalWeight'] = array_sum(array_column(self::CRITERIA, 3));
        $overall['maxWeighted'] = $overall['totalWeight'];
        return ['rows' => $rows, 'overall' => $overall, 'groups' => $groups, 'categories' => $catOut, 'statusCount' => $statusCount];
    }

    // ── Live evidence per test case ──────────────────────────

    public static function live(PDO $pdo, array $config, EventStore $store, int $days = 7): array
    {
        $since = date('Y-m-d H:i:s', time() - $days * 86400);
        $one = static function (string $sql, array $p = []) use ($pdo) {
            try {
                $st = $pdo->prepare($sql);
                $st->execute($p);
                return $st->fetchColumn();
            } catch (Throwable $e) {
                return null;
            }
        };
        $n = static fn ($v) => (int) ($v ?? 0);
        $profiles = $store->personProfiles();
        $locMap = $config['poc']['cam_locations'] ?? [];
        $out = [];

        // Face recognition.
        $recog = $avg = 0;
        $people = [];
        $plantDays = [];
        $camsPer = [];
        try {
            require_once __DIR__ . '/Attendance.php';
            $att = new Attendance($store, $config);
            $plantOf = [];
            $st = $pdo->prepare("SELECT person_id, stream, similarity, received_at FROM events WHERE received_at >= :a AND person_id IS NOT NULL AND person_id <> '' LIMIT 50000");
            $st->execute(['a' => $since]);
            $simS = $simN = 0;
            foreach ($st as $r) {
                $pid = (string) $r['person_id'];
                if (!isset($profiles[$pid])) {
                    continue;
                }
                $recog++;
                $people[$pid] = true;
                $sim = is_numeric($r['similarity']) ? (float) $r['similarity'] : 0;
                if ($sim > 0) {
                    $simS += $sim <= 1 ? $sim * 100 : $sim;
                    $simN++;
                }
                $cam = (string) $r['stream'];
                $camsPer[$pid][$cam] = true;
                $loc = (string) ($locMap[$cam] ?? '');
                if ($loc !== '') {
                    $plantOf[$loc] ??= $att->plantOf($loc);
                    if ($plantOf[$loc] !== '') {
                        $plantDays[$pid . '|' . substr((string) $r['received_at'], 0, 10)][$plantOf[$loc]] = true;
                    }
                }
            }
            $avg = $simN ? round($simS / $simN, 1) : null;
        } catch (Throwable $e) {
        }
        $multiCam = count(array_filter($camsPer, static fn ($c) => count($c) >= 2));
        $cross = count(array_filter($plantDays, static fn ($p) => count($p) >= 2));
        $strangers = $n($one("SELECT COUNT(*) FROM events WHERE received_at >= :a AND (raw_json LIKE '%\"-99\"%' OR LOWER(policy_name) LIKE '%stranger%' OR LOWER(event_type) LIKE '%stranger%')", ['a' => $since]));

        $out['FR-01'] = ['text' => $recog . ' recognitions of ' . count($people) . ' enrolled employees (' . count($profiles) . ' enrolled)'
            . ($avg ? ' · avg similarity ' . $avg . '%' : ''), 'ok' => $recog > 0, 'page' => 'attendance'];
        $out['FR-02'] = ['text' => $strangers . ' unknown-person (stranger) detections', 'ok' => $strangers > 0, 'page' => 'faces'];
        $out['TR-01'] = ['text' => $multiCam . ' employees tracked across ≥ 2 cameras', 'ok' => $multiCam > 0, 'page' => 'attendance'];
        $out['TR-02'] = ['text' => $cross . ' person-days with movement across plants', 'ok' => $cross > 0, 'page' => 'attendance'];

        $raV = $n($one("SELECT COUNT(*) FROM restricted_events WHERE detected_at >= :a AND verdict = 'violation'", ['a' => $since]));
        $raAll = $n($one('SELECT COUNT(*) FROM restricted_events WHERE detected_at >= :a', ['a' => $since]));
        $out['RA-01'] = ['text' => $raV . ' unauthorized entries of ' . $raAll . ' restricted-zone entries recorded', 'ok' => $raV > 0, 'page' => 'intr'];
        $ped = $n($one("SELECT COUNT(*) FROM forklift_events WHERE detected_at >= :a AND LOWER(reason) LIKE 'pedestrian%'", ['a' => $since]));
        $fkOnly = $n($one("SELECT COUNT(*) FROM forklift_events WHERE detected_at >= :a AND LOWER(reason) NOT LIKE 'pedestrian%' AND LOWER(reason) NOT LIKE '%operator%'", ['a' => $since]));
        $out['RA-02'] = ['text' => $ped . ' pedestrian intrusions in forklift-only zones · ' . $fkOnly . ' forklift detections (differentiated)', 'ok' => $ped > 0, 'page' => 'forklift'];

        foreach (['PPE-01' => 'helmet', 'PPE-02' => 'vest'] as $id => $item) {
            $c = $n($one('SELECT COUNT(*) FROM ppe_checks WHERE checked_at >= :a AND required LIKE :i', ['a' => $since, 'i' => '%' . $item . '%']));
            $v = $n($one('SELECT COUNT(*) FROM ppe_checks WHERE checked_at >= :a AND missing LIKE :i', ['a' => $since, 'i' => '%' . $item . '%']));
            $out[$id] = ['text' => $c . ' ' . $item . ' checks · ' . $v . ' non-compliant · ' . ($c ? round(100 * ($c - $v) / $c, 1) : 0) . '% compliant',
                         'ok' => $c > 0, 'page' => 'ppe'];
        }
        $cc = $n($one("SELECT COUNT(*) FROM ppe_checks WHERE checked_at >= :a AND schedule_id IS NOT NULL AND schedule_id <> ''", ['a' => $since]));
        $cv = $n($one("SELECT COUNT(*) FROM ppe_checks WHERE checked_at >= :a AND schedule_id IS NOT NULL AND schedule_id <> '' AND missing <> ''", ['a' => $since]));
        $out['PPE-03'] = ['text' => $cc . ' PPE checks during cleaning windows · ' . $cv . ' missing gloves / goggles', 'ok' => $cc > 0, 'page' => 'cleaning'];

        $pol = static fn (string $re) => $n($one("SELECT COUNT(*) FROM events WHERE received_at >= :a AND ({$re})", ['a' => $since]));
        $like = static function (array $words, string $col = "LOWER(COALESCE(policy_name,'') || ' ' || COALESCE(policy_desc,'') || ' ' || COALESCE(event_type,''))") {
            return implode(' OR ', array_map(static fn ($w) => "{$col} LIKE '%{$w}%'", $words));
        };
        $concat = Database::driver() === 'mysql'
            ? "LOWER(CONCAT(COALESCE(policy_name,''),' ',COALESCE(policy_desc,''),' ',COALESCE(event_type,'')))"
            : "LOWER(COALESCE(policy_name,'') || ' ' || COALESCE(policy_desc,'') || ' ' || COALESCE(event_type,''))";
        $line5 = array_keys(array_filter($locMap, static fn ($l) => stripos((string) $l, 'line 5') !== false || stripos((string) $l, 'line5') !== false));
        $presence = 0;
        if ($line5) {
            $presence = $n($one('SELECT COUNT(*) FROM events WHERE received_at >= ? AND stream IN (' . implode(',', array_fill(0, count($line5), '?')) . ')',
                array_merge([$since], $line5)));
        }
        $loiter = $pol($like(['loiter', 'linger', 'wander', 'dwell', 'stay', 'chit'], $concat));
        $clean  = $pol($like(['clean', 'mop', 'sweep', 'wipe'], $concat));
        $fight  = $pol($like(['fight', 'altercation', 'brawl', 'violence', 'scuffle', 'conflict'], $concat));
        $out['BEH-01'] = ['text' => $presence . ' person detections at Line 5 cameras — classified on Behaviour Analytics', 'ok' => $presence > 0, 'page' => 'behaviour'];
        $out['BEH-02'] = ['text' => $loiter . ' loitering / dwell events', 'ok' => $loiter > 0, 'page' => 'behaviour'];
        $out['BEH-03'] = ['text' => $clean . ' cleaning-activity events', 'ok' => $clean > 0, 'page' => 'behaviour'];
        $out['BEH-04'] = ['text' => $fight . ' fighting / altercation events', 'ok' => $fight > 0, 'page' => 'behaviour'];

        $email = $n($one("SELECT COUNT(*) FROM incident_log WHERE created_at >= :a AND (kind IN ('notify','email','mail') OR LOWER(note) LIKE '%email sent%') AND LOWER(COALESCE(note,'')) NOT LIKE '%failed%'", ['a' => $since]));
        $locks = count(glob(WsdSettings::dirOf($config) . '/mail_*.lock') ?: []);
        $tg = $n($one("SELECT COUNT(*) FROM incident_log WHERE created_at >= :a AND (LOWER(kind) LIKE '%telegram%' OR LOWER(note) LIKE '%telegram%') AND LOWER(COALESCE(note,'')) NOT LIKE '%fail%'", ['a' => $since]));
        $esc = $n($one("SELECT COUNT(*) FROM incident_log WHERE created_at >= :a AND (LOWER(kind) LIKE '%escalat%' OR LOWER(note) LIKE 'auto-escalated%')", ['a' => $since]));
        // Delivery log of the notification channels (storage/notify_log.json), real sends only.
        $sent = ['email' => [0, 0], 'telegram' => [0, 0]];
        $nl = json_decode((string) @file_get_contents(WsdSettings::dirOf($config) . '/notify_log.json'), true);
        foreach (is_array($nl) ? $nl : [] as $x) {
            $ch = (string) ($x['channel'] ?? '');
            if (isset($sent[$ch]) && empty($x['sim']) && (string) ($x['at'] ?? '') >= $since) {
                $sent[$ch][!empty($x['ok']) ? 0 : 1]++;
            }
        }
        $out['ALT-01'] = ['text' => $sent['email'][0] . ' alert emails delivered (' . $sent['email'][1] . ' failed) · ' . $email . ' escalation emails on incident logs · '
            . $locks . ' alert streams in cooldown', 'ok' => ($sent['email'][0] + $email) > 0, 'page' => 'rules'];
        $out['ALT-02'] = ['text' => $sent['telegram'][0] . ' Telegram messages delivered (' . $sent['telegram'][1] . ' failed) · ' . $tg . ' on incident logs',
            'ok' => ($sent['telegram'][0] + $tg) > 0, 'page' => 'settings'];
        $out['ALT-03'] = ['text' => $esc . ' escalations logged on incident timelines', 'ok' => $esc > 0, 'page' => 'incidents'];

        require_once __DIR__ . '/LiveBridge.php';
        $lb = LiveBridge::cached($config);
        $srcs = count($config['live']['rtsp'] ?? []);
        $out['INF-01'] = ['text' => ($lb['configured'] ? ('bridge ' . ($lb['reachable'] === null ? 'not checked' : ($lb['reachable'] ? 'reachable' : 'unreachable'))
            . ' · ' . count($lb['streams']) . ' streams registered') : 'live bridge not configured') . ' · ' . $srcs . ' manual sources',
            'ok' => (bool) $lb['reachable'] && count($lb['streams']) > 0, 'page' => 'settings'];
        $nt = is_file(WsdSettings::dirOf($config) . '/nettest_last.json') ? json_decode((string) file_get_contents(WsdSettings::dirOf($config) . '/nettest_last.json'), true) : null;
        $out['INF-02'] = is_array($nt)
            ? ['text' => 'Last network test ' . substr((string) $nt['at'], 0, 16) . ': ' . $nt['summary']['pass'] . ' pass · ' . $nt['summary']['warn'] . ' warn · ' . $nt['summary']['fail'] . ' fail',
               'ok' => ($nt['summary']['fail'] ?? 1) === 0 && ($nt['summary']['pass'] ?? 0) > 0, 'page' => 'settings']
            : ['text' => 'No network test run yet — Settings → Live Video → Run network test', 'ok' => false, 'page' => 'settings'];

        $sight = $n($one("SELECT COUNT(*) FROM events WHERE received_at >= :a AND person_id IS NOT NULL AND person_id <> ''", ['a' => $since]));
        $out['REP-01'] = ['text' => count($people) . ' employees with attendance evidence in ' . $days . ' days — Attendance register + CSV', 'ok' => count($people) > 0, 'page' => 'attendance'];
        $out['REP-02'] = ['text' => $sight . ' identified sightings searchable by person / date (movement CSV)', 'ok' => $sight > 0, 'page' => 'attendance'];
        $pc = $n($one('SELECT COUNT(*) FROM ppe_checks WHERE checked_at >= :a', ['a' => $since]));
        $pv = $n($one("SELECT COUNT(*) FROM ppe_checks WHERE checked_at >= :a AND missing <> ''", ['a' => $since]));
        $out['REP-03'] = ['text' => $pc . ' PPE checks · ' . $pv . ' exceptions · ' . ($pc ? round(100 * ($pc - $pv) / $pc, 1) : 0) . '% compliance', 'ok' => $pc > 0, 'page' => 'ppe'];
        return $out;
    }

    // ── Exports ──────────────────────────────────────────────

    public function csvRows(array $saved, array $live, string $sheet): array
    {
        $c = $this->compute($saved);
        $rows = [];
        if ($sheet !== 'tests') {
            $rows[] = ['Kian Joo Can Factory Berhad — Vision AI CCTV POC · Vendor Evaluation & POC Scoring Matrix · POC 7–12 September 2026'];
            $rows[] = ['No.', 'Category', 'Evaluation Criteria', 'Weight (%)', 'Vendor Score (0-5)', 'Weighted Score', 'Evidence / Remarks', 'POC Result / Observation', 'Status'];
            foreach ($c['rows'] as $r) {
                $rows[] = [$r['no'], $r['category'], $r['criterion'], $r['weight'], $r['score'] ?? '', $r['weighted'], $r['evidence'], $r['observation'], $r['status']];
            }
            $rows[] = [];
            $rows[] = ['SCORING SUMMARY'];
            $rows[] = ['Total weight', $c['overall']['totalWeight']];
            $rows[] = ['Weighted score', $c['overall']['weighted']];
            $rows[] = ['Maximum weighted score', $c['overall']['maxWeighted']];
            $rows[] = ['Overall score (%)', $c['overall']['pct'] ?? ''];
            $rows[] = ['Average score (0-5)', $c['overall']['avg'] ?? '', $c['overall']['band']];
            foreach ($c['groups'] as $g) {
                $rows[] = [$g['label'] . ' score (%)', $g['pct'] ?? ''];
            }
            foreach ($c['categories'] as $g) {
                $rows[] = ['Category · ' . $g['label'] . ' (%)', $g['pct'] ?? ''];
            }
        }
        if ($sheet !== 'criteria') {
            if ($rows) {
                $rows[] = [];
            }
            $rows[] = ['Test ID', 'Area', 'Test Case', 'Expected Result', 'Actual Result / Evidence', 'Score (0-5)', 'Pass/Fail', 'Remarks', 'Evidence link', 'Live system evidence'];
            foreach (self::TESTS as [$id, $area, $case, $exp]) {
                $t = $saved['tests'][$id] ?? [];
                $rows[] = [$id, $area, $case, $exp, (string) ($t['actual'] ?? ''), $t['score'] ?? '', (string) ($t['result'] ?? ''),
                           (string) ($t['remarks'] ?? ''), (string) ($t['evidence'] ?? ''), (string) ($live[$id]['text'] ?? '')];
            }
        }
        if ($sheet === 'all') {
            $r = $saved['report'];
            $rows[] = [];
            foreach (['vendor' => 'Vendor', 'summary' => 'Executive summary', 'strengths' => 'Key strengths', 'gaps' => 'Key gaps',
                      'recommendation' => 'Recommendation', 'prepared_by' => 'Prepared by', 'report_date' => 'Report date'] as $k => $label) {
                $rows[] = [$label, (string) ($r[$k] ?? '')];
            }
        }
        return $rows;
    }
}
