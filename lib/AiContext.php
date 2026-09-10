<?php

declare(strict_types=1);

/**
 * Agent-facing read API (/api/ai/*).
 *
 * The Weststar AI agent reaches this over its permissioned `http` tool, so the
 * shape is tuned for an LLM rather than for the dashboard: every endpoint
 * returns a short English `summary` it can quote directly plus compact `data`
 * rows with no image URLs, no pixel boxes and no internal ids it cannot use.
 *
 * Numbers are pre-computed here on purpose — an LLM asked to count 500 rows
 * will get it wrong, so it never has to.
 */
final class AiContext
{
    /** Detection modules, in the order the dashboard lists them. */
    private const MOD_LABEL = [
        'fire' => 'Fire & Smoke',
        'ppe'  => 'PPE Compliance',
        'intr' => 'Intrusion',
        'face' => 'Face & Body',
    ];

    /** SLA targets in minutes: [time to acknowledge, time to resolve]. */
    private const SLA = [
        'critical' => [5, 60],
        'high'     => [15, 240],
        'medium'   => [60, 480],
        'low'      => [240, 1440],
    ];

    public function __construct(private EventStore $store, private array $config)
    {
    }

    // ── endpoints ────────────────────────────────────────────

    /** What the agent can call. Lets it discover the API without a fixed prompt. */
    public function help(): array
    {
        return [
            'service'   => 'Kian Joo VisionAI detection API for the assistant',
            'summary'   => 'Live CCTV detection data from the Kian Joo VisionAI dashboard. '
                         . 'Call /summary first for the current picture, then narrow with the other endpoints.',
            'endpoints' => [
                'GET /summary'    => 'Current state: open/acknowledged/resolved counts, per-module and per-camera breakdown, SLA breaches, busiest hour.',
                'GET /detections' => 'Recent detections. Filters: hours (default 24), module (fire|ppe|intr|face), camera, person_id, status (open|ack|resolved), feed (face|body), limit (default 20, max 100).',
                'GET /incidents'  => 'Detections escalated into tickets, with SLA state. Filters: status, limit.',
                'GET /incident'   => 'One detection in full, with its change log. Params: id (ticket number INC-… or event uuid).',
                'GET /people'     => 'Unique people tracked by face recognition, enrolled profiles first. Params: days (default 7), limit.',
                'GET /cameras'    => 'Camera fleet with online state and the VisionAI policies bound to each.',
            ],
        ];
    }

    /** The one call that answers "what is happening right now?". */
    public function summary(int $hours = 24): array
    {
        $hours = max(1, min(720, $hours));
        $rows  = $this->store->query(['from' => $this->since($hours), 'limit' => 500]);
        $incs  = array_map([DashboardMapper::class, 'incident'], $rows);

        $byStatus = ['open' => 0, 'ack' => 0, 'resolved' => 0];
        $bySev    = ['critical' => 0, 'high' => 0, 'medium' => 0, 'low' => 0];
        $byMod    = [];
        $byCam    = [];
        $byHour   = [];
        $breaches = [];
        $now      = time();

        foreach ($incs as $i) {
            $byStatus[$i['status']] = ($byStatus[$i['status']] ?? 0) + 1;
            $bySev[$i['sev']]       = ($bySev[$i['sev']] ?? 0) + 1;
            $byMod[$i['mod']]       = ($byMod[$i['mod']] ?? 0) + 1;
            $byCam[$i['camera']]    = ($byCam[$i['camera']] ?? 0) + 1;
            $when                   = strtotime((string) ($i['triggerTime'] ?: $i['received'])) ?: null;
            if ($when) {
                $byHour[date('H', $when)] = ($byHour[date('H', $when)] ?? 0) + 1;
            }
            if ($i['status'] !== 'resolved' && $when) {
                $limit = (self::SLA[$i['sev']] ?? self::SLA['low'])[1] * 60;
                if (($now - $when) > $limit) {
                    $breaches[] = $this->row($i);
                }
            }
        }
        arsort($byCam);
        arsort($byHour);

        $unresolvedAll = count($this->store->query(['status_not' => 'resolved', 'limit' => 500]));
        $cams          = $this->cameras();
        $modText       = [];
        foreach ($byMod as $m => $n) {
            $modText[] = $n . ' ' . (self::MOD_LABEL[$m] ?? $m);
        }
        $topCam  = $byCam ? array_key_first($byCam) : null;
        $topHour = $byHour ? array_key_first($byHour) : null;

        $summary = sprintf(
            'In the last %d hours the dashboard recorded %d detections (%s). %d are still open, %d acknowledged, %d resolved. %s%s%s',
            $hours,
            count($incs),
            $modText ? implode(', ', $modText) : 'no detections',
            $byStatus['open'],
            $byStatus['ack'],
            $byStatus['resolved'],
            $topCam ? sprintf('Busiest camera %s with %d. ', $topCam, $byCam[$topCam]) : '',
            $topHour !== null ? sprintf('Busiest hour %s:00. ', $topHour) : '',
            $breaches ? sprintf('%d detections are past their SLA resolve target.', count($breaches)) : 'No SLA breaches.'
        );

        return [
            'summary'     => $summary,
            'window'      => $hours . 'h',
            'generated_at'=> date('c'),
            'totals'      => [
                'in_window'           => count($incs),
                'by_status'           => $byStatus,
                'by_severity'         => $bySev,
                'by_module'           => $this->labelKeys($byMod),
                'by_camera'           => $byCam,
                'unresolved_all_time' => $unresolvedAll,
                'stored_all_time'     => (int) ($this->store->stats()['total'] ?? 0),
            ],
            'cameras'     => ['online' => count(array_filter($cams['data'], static fn ($c) => $c['online'])),
                              'total'  => count($cams['data'])],
            'sla_breaches'=> array_slice($breaches, 0, 10),
            'latest'      => $incs ? $this->row($incs[0]) : null,
        ];
    }

    /** Recent detections, described the way an operator would read them out. */
    public function detections(array $f): array
    {
        $hours = max(1, min(720, (int) ($f['hours'] ?? 24)));
        $limit = max(1, min(100, (int) ($f['limit'] ?? 20)));
        $q = ['from' => $this->since($hours), 'limit' => 500];
        foreach (['person_id' => 'person_id', 'status' => 'status', 'feed' => 'feed_kind'] as $in => $col) {
            if (!empty($f[$in])) {
                $q[$col] = (string) $f[$in];
            }
        }
        if (!empty($f['camera'])) {
            $q['stream'] = strtolower((string) $f['camera']);
        }
        $incs = array_map([DashboardMapper::class, 'incident'], $this->store->query($q));
        if (!empty($f['module'])) {
            $mod  = strtolower((string) $f['module']);
            $incs = array_values(array_filter($incs, static fn ($i) => $i['mod'] === $mod));
        }
        $total = count($incs);
        $rows  = array_map([$this, 'row'], array_slice($incs, 0, $limit));

        $filters = array_filter([
            'module' => $f['module'] ?? null, 'camera' => $f['camera'] ?? null,
            'status' => $f['status'] ?? null, 'person_id' => $f['person_id'] ?? null,
            'feed'   => $f['feed'] ?? null,
        ]);
        $summary = sprintf(
            '%d detection%s in the last %d hours%s. Showing the %d most recent, newest first.',
            $total,
            $total === 1 ? '' : 's',
            $hours,
            $filters ? ' matching ' . http_build_query($filters, '', ', ') : '',
            count($rows)
        );

        return ['summary' => $summary, 'matched' => $total, 'returned' => count($rows),
                'window' => $hours . 'h', 'filters' => $filters, 'data' => $rows];
    }

    /** Escalated tickets with their SLA state. */
    public function incidents(array $f): array
    {
        $limit = max(1, min(100, (int) ($f['limit'] ?? 20)));
        $rows  = $this->store->query(['limit' => 500]);
        $incs  = array_values(array_filter(
            array_map([DashboardMapper::class, 'incident'], $rows),
            static fn ($i) => !empty($i['ticket'])
        ));
        if (!empty($f['status'])) {
            $st   = (string) $f['status'];
            $incs = array_values(array_filter($incs, static fn ($i) => $i['status'] === $st));
        }
        $out = [];
        foreach (array_slice($incs, 0, $limit) as $i) {
            $out[] = $this->row($i) + ['sla' => $this->sla($i)];
        }
        return [
            'summary'  => sprintf('%d escalated incident ticket%s%s. Each row carries its SLA state.',
                count($incs), count($incs) === 1 ? '' : 's',
                !empty($f['status']) ? ' with status ' . $f['status'] : ''),
            'matched'  => count($incs),
            'data'     => $out,
        ];
    }

    /** One detection in full, including the operator change log. */
    public function incident(string $id): array
    {
        $id  = trim($id);
        $rec = $this->store->find($id);
        if (!$rec) {
            // Also accept a ticket number (INC-yymmdd-nnnn).
            foreach ($this->store->query(['limit' => 500]) as $r) {
                if (strcasecmp((string) ($r['ticket_no'] ?? ''), $id) === 0) {
                    $rec = $r;
                    break;
                }
            }
        }
        if (!$rec) {
            return ['summary' => 'No detection found for "' . $id . '". Ticket numbers look like INC-260806-0001; event ids are long numeric uuids.',
                    'found' => false, 'data' => null];
        }
        $i   = DashboardMapper::incident($rec);
        $log = [];
        foreach ($this->store->getLog($i['id']) as $l) {
            $log[] = [
                'at'    => $l['created_at'] ?? '',
                'kind'  => $l['kind'] ?? '',
                'actor' => $l['actor'] ?: '—',
                'change'=> trim(((string) ($l['from_val'] ?? '')) . ' → ' . ((string) ($l['to_val'] ?? '')), ' →'),
                'note'  => (string) ($l['note'] ?? ''),
            ];
        }
        return [
            'summary' => $this->sentence($i) . ' ' . ($log ? count($log) . ' log entries.' : 'No operator actions logged yet.'),
            'found'   => true,
            'data'    => $this->row($i) + ['sla' => $this->sla($i), 'attributes' => $i['decoded'], 'log' => $log],
        ];
    }

    /** Tracked people (face recognition), enrolled profiles first. */
    public function people(array $f): array
    {
        $days  = max(1, min(90, (int) ($f['days'] ?? 7)));
        $limit = max(1, min(200, (int) ($f['limit'] ?? 50)));
        $roster   = $this->store->personRoster($days, 200);
        $profiles = $this->store->personProfiles();

        $out = [];
        foreach ($roster as $p) {
            $pr  = $profiles[$p['personId']] ?? null;
            $reg = $pr || !empty($p['inSense']);
            $out[] = [
                'person_id'  => $p['personId'],
                'name'       => $pr['name'] ?? ($p['senseName'] ?: null),
                'registered' => $reg,
                'source'     => $pr ? 'operator profile' : (!empty($p['inSense']) ? 'VisionAI person group' : null),
                'age'        => $pr['age'] ?? null,
                'gender'     => $pr['gender'] ?? null,
                'about'      => $pr['about'] ?? ($pr['notes'] ?? null),
                'captures'   => (int) $p['captures'],
                'cameras'    => $p['cameras'],
                'first_seen' => $p['firstSeen'],
                'last_seen'  => $p['lastSeen'],
                'best_match' => $this->pct($p['similarity'] ?? ''),
            ];
        }
        usort($out, static fn ($a, $b) => ($b['registered'] <=> $a['registered']) ?: strcmp((string) $b['last_seen'], (string) $a['last_seen']));
        $reg = count(array_filter($out, static fn ($p) => $p['registered']));

        return [
            'summary' => sprintf('%d unique people tracked in the last %d days, %d registered (named) and %d unidentified. '
                . 'Unidentified people still have a person id and a capture history — they are strangers to the face engine, not errors.',
                count($out), $days, $reg, count($out) - $reg),
            'matched' => count($out),
            'data'    => array_slice($out, 0, $limit),
        ];
    }

    /** Camera fleet with the policies bound to each. */
    public function cameras(): array
    {
        $seen = [];
        foreach ($this->store->query(['limit' => 500]) as $r) {
            $key = strtolower((string) ($r['stream'] ?: ($r['device_serial'] ?? '')));
            if ($key === '' || isset($seen[$key])) {
                continue;
            }
            $seen[$key] = [
                'camera'     => strtoupper($key),
                'name'       => Text::latin((string) ($r['device_name'] ?? ''), strtoupper($key)),
                'serial'     => (string) ($r['device_serial'] ?? ''),
                'policies'   => [],
                'last_event' => (string) ($r['received_at'] ?? ''),
                'online'     => (strtotime((string) ($r['received_at'] ?? '')) ?: 0) > (time() - 900),
            ];
        }
        foreach ($this->store->policyMatrix(30) as $p) {
            $key = strtolower((string) ($p['stream'] ?? ''));
            if (isset($seen[$key]) && !empty($p['policy'])) {
                $seen[$key]['policies'][] = Text::latin((string) $p['policy'], (string) $p['policy']);
            }
        }
        foreach ($seen as &$c) {
            $c['policies'] = array_values(array_unique($c['policies']));
        }
        unset($c);
        $data   = array_values($seen);
        $online = count(array_filter($data, static fn ($c) => $c['online']));
        return [
            'summary' => sprintf('%d cameras have pushed detections; %d have reported in the last 15 minutes. '
                . '"online" here means recent detections, not an RTSP health check.', count($data), $online),
            'data'    => $data,
        ];
    }

    // ── shaping helpers ──────────────────────────────────────

    /** One detection as compact, self-describing fields. */
    private function row(array $i): array
    {
        $when = (string) ($i['triggerTime'] ?: $i['received']);
        $attr = [];
        foreach ($i['decoded'] as $k => $v) {
            if (is_scalar($v) && (string) $v !== '') {
                $attr[] = $k . ': ' . $v;
            }
        }
        return array_filter([
            'event_id'   => $i['id'],
            'when'       => preg_replace('/\.\d+$/', '', $when),
            'ago'        => $this->ago($when),
            'camera'     => $i['camera'],
            'module'     => self::MOD_LABEL[$i['mod']] ?? $i['mod'],
            'feed'       => $i['feed'] ?: null,
            'severity'   => $i['sev'],
            'status'     => $i['status'],
            'what'       => $i['title'],
            'policy'     => $i['zone'] ?: null,
            'person_id'  => $i['personId'] ?: null,
            'person'     => $i['person'] ?: null,
            'match'      => $this->pct($i['similarity']),
            'attributes' => $attr ? implode(' · ', array_slice($attr, 0, 8)) : null,
            'ticket'     => $i['ticket'] ?: null,
            'assignee'   => $i['assignee'] !== 'Unassigned' ? $i['assignee'] : null,
        ], static fn ($v) => $v !== null && $v !== '');
    }

    /** A detection as one readable sentence — handy for single-record answers. */
    private function sentence(array $i): string
    {
        return sprintf('%s on %s at %s, severity %s, currently %s%s.',
            $i['title'], $i['camera'], preg_replace('/\.\d+$/', '', (string) ($i['triggerTime'] ?: $i['received'])),
            $i['sev'], $i['status'], $i['ticket'] ? ' as ticket ' . $i['ticket'] : '');
    }

    /** SLA position for a detection, in plain words. */
    private function sla(array $i): array
    {
        [$ackMin, $resMin] = self::SLA[$i['sev']] ?? self::SLA['low'];
        $start = strtotime((string) ($i['triggerTime'] ?: $i['received'])) ?: time();
        $end   = $i['status'] === 'resolved' && $i['resolvedTs'] ? (int) ($i['resolvedTs'] / 1000) : time();
        $mins  = (int) round(($end - $start) / 60);
        return [
            'target_ack_min'     => $ackMin,
            'target_resolve_min' => $resMin,
            'elapsed_min'        => $mins,
            'state'              => $i['status'] === 'resolved'
                ? ($mins <= $resMin ? 'met' : 'breached')
                : ($mins > $resMin ? 'breached' : ($mins > $resMin * 0.8 ? 'at risk' : 'within target')),
        ];
    }

    private function labelKeys(array $byMod): array
    {
        $out = [];
        foreach ($byMod as $m => $n) {
            $out[self::MOD_LABEL[$m] ?? $m] = $n;
        }
        return $out;
    }

    /** VisionAI sends similarity as a 0–1 float; report it as a percentage. */
    private function pct(string $v): ?string
    {
        $n = (float) $v;
        if ($n <= 0) {
            return null;
        }
        return round($n <= 1 ? $n * 100 : $n, 1) . '%';
    }

    private function ago(string $when): string
    {
        $t = strtotime($when) ?: 0;
        if (!$t) {
            return '';
        }
        $s = max(0, time() - $t);
        if ($s < 60) {
            return $s . 's ago';
        }
        if ($s < 3600) {
            return (int) ($s / 60) . 'm ago';
        }
        if ($s < 86400) {
            return (int) ($s / 3600) . 'h ago';
        }
        return (int) ($s / 86400) . 'd ago';
    }

    private function since(int $hours): string
    {
        return date('Y-m-d H:i:s', time() - $hours * 3600);
    }
}
