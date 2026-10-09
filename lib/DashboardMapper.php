<?php
/**
 * Maps a hydrated SenseTime event (from EventStore) into the shapes the
 * Kian Joo VisionAI consumes:
 *   - incident  {id, mod, sev, camera, zone, title, ts, status, image, conf}
 *   - camera    {id, name, zone, mod, res, fps, scene, boxes[]}
 *
 * `mod` buckets a detection into the dashboard's four detection modules
 * (fire / ppe / intr / face); `sev` maps SenseTime alertLevel to severity.
 */

declare(strict_types=1);

require_once __DIR__ . '/Text.php';

final class DashboardMapper
{
    // Reference frame the SenseTime detect bbox is expressed in (px).
    private const FRAME_W = 2560;
    private const FRAME_H = 1440;

    private const SEV_RANK = ['low' => 0, 'medium' => 1, 'high' => 2, 'critical' => 3];

    public static function incident(array $e): array
    {
        $mod = self::modOf($e);
        $sev = self::sevOf($e, $mod);
        // Operator escalation/de-escalation wins over the computed severity.
        if (!empty($e['severity_override']) && isset(self::SEV_RANK[$e['severity_override']])) {
            $sev = (string) $e['severity_override'];
        }
        $status = in_array($e['status'] ?? '', ['open', 'ack', 'resolved'], true) ? $e['status'] : 'open';
        $tsOf = static fn ($v) => !empty($v) ? ((strtotime((string) $v) ?: 0) * 1000 ?: null) : null;
        return [
            'id'       => $e['uuid'] ?: (string) ($e['id'] ?? ''),
            'mod'      => $mod,
            'sev'      => $sev,
            'camera'   => strtoupper((string) ($e['stream'] ?: ($e['device_serial'] ?? 'CAM'))),
            // SenseStudio may return Chinese names — the dashboard is English-only.
            'zone'     => Text::latin($e['policy_name'] ?: ($e['device_name'] ?: ''), 'Zone'),
            'title'    => self::titleOf($e, $mod),
            'ts'       => self::tsOf($e),
            'status'   => $status,
            'assignee' => $e['assignee'] ?: 'Unassigned',
            'image'    => $e['images']['trigger'] ?? null,
            // Face events carry three frames: the trigger crop, the full scene
            // behind it, and the enrolled profile photo it matched against.
            'imageBk'    => $e['images']['background'] ?? null,
            'imageMatch' => $e['images']['match'] ?? null,
            'person'     => Text::latin($e['person_name'] ?? '', ''),
            'personId'   => (string) ($e['person_id'] ?? ''),
            'similarity' => (string) ($e['similarity'] ?? ''),
            'conf'     => self::personConf($e),
            // full detail for the event modal
            'device'     => Text::latin($e['device_name'] ?? '', ''),
            'serial'     => $e['device_serial'] ?: '',
            'feed'       => (string) ($e['feed_kind'] ?? ''),   // face | body | ''
            'policy'     => Text::latin($e['policy_name'] ?? '', ''),
            'policyDesc' => Text::latin($e['policy_desc'] ?? '', ''),
            'triggerType'=> $e['trigger_image_type'] ?: '',
            'eventType'  => $e['event_type'] ?: '',
            'alertLevel' => (string) ($e['alert_level'] ?? ''),
            'triggerTime'=> $e['trigger_time'] ?: '',
            'received'   => $e['received_at'] ?: '',
            'ackedAt'    => $e['acked_at'] ?? null,
            'decoded'    => self::normalizeDecoded(is_array($e['decoded'] ?? null) ? $e['decoded'] : []),
            // incident-ticket lifecycle (SLA / elapsed / history live off these)
            'ticket'     => $e['ticket_no'] ?? null,
            'ticketedTs' => $tsOf($e['ticketed_at'] ?? null),
            'ackedTs'    => $tsOf($e['acked_at'] ?? null),
            'resolvedTs' => $tsOf($e['resolved_at'] ?? null),
        ];
    }

    /** One camera tile from the latest event of a stream. */
    public static function camera(array $e): array
    {
        $mod = self::modOf($e);
        $sev = self::sevOf($e, $mod);
        $img = $e['images']['trigger'] ?? null;
        $scene = $img
            ? "url('" . $img . "') center/cover no-repeat"
            : 'linear-gradient(160deg,#0e1119,#151824 55%,#0a0d14)';

        $box = self::boxOf($e, $sev);
        return [
            'id'     => strtoupper((string) ($e['stream'] ?: ($e['device_serial'] ?? 'CAM'))),
            'stream' => (string) ($e['stream'] ?: ''),
            'serial' => (string) ($e['device_serial'] ?: ''),
            'name'  => Text::latin($e['device_name'] ?? '', (string) ($e['stream'] ?: 'Camera')),
            'zone'  => Text::latin($e['policy_name'] ?? '', 'Zone'),
            'mod'   => $mod,
            'res'   => '1440p',
            'fps'   => 25,
            'scene' => $scene,
            'img'   => $img,
            'boxes' => $box ? [$box] : [],
        ];
    }

    // ── classification ───────────────────────────────────────

    public static function modOf(array $e): string
    {
        // policy_name included so a SenseStudio policy named e.g. "TMLabFire"
        // buckets correctly even when the model's type string is opaque.
        $t = strtolower(
            ($e['trigger_image_type'] ?? '') . ' ' .
            ($e['event_type'] ?? '') . ' ' .
            ($e['policy_name'] ?? '') . ' ' .
            ($e['policy_desc'] ?? '')
        );
        $dec = $e['decoded'] ?? [];

        // Module is driven by the policy / trigger type (what SenseStudio was
        // configured to detect), not by incidental body attributes — otherwise
        // every person without a vest would look like a PPE violation.
        if (preg_match('/fire|smoke|flame|thermal/', $t)) {
            return 'fire';
        }
        // Smoking is a specific detected behaviour → surface on Fire & Smoke.
        if (($dec['Smoking'] ?? '') === 'IsSmoking') {
            return 'fire';
        }
        if (preg_match('/ppe|helmet|hardhat|hard.?hat|vest|glove|mask.?policy|safety/', $t)) {
            return 'ppe';
        }
        if (preg_match('/roi|intrusion|intrude|crossline|cross|tripwire|perimeter|region|area|breach|loiter|tailgat/', $t)) {
            return 'intr';
        }
        if (preg_match('/face|stranger/', $t) || self::isStranger($e)) {
            return 'face';
        }
        // Structural/body-attribute event with no intrusion context.
        return $dec ? 'face' : 'intr';
    }

    /**
     * SenseStudio face-monitor pushes tag strangers with Person Group -99
     * (§5.2.4.1). Also honour an explicit "stranger" event/policy type.
     */
    public static function isStranger(array $e): bool
    {
        foreach (($e['attributes'] ?? []) as $a) {
            if ((string) ($a['key'] ?? '') === '0' && (string) ($a['value'] ?? '') === '-99') {
                return true;
            }
        }
        // Live pushes carry the marker in triggerTargets (person group -99 =
        // stranger library), not in the decoded attribute list.
        $raw = is_array($e['raw'] ?? null) ? $e['raw'] : [];
        foreach (($raw['triggerTargets'] ?? []) as $t) {
            if ((string) ($t['targetValue'] ?? '') === '-99') {
                return true;
            }
        }
        return stripos(($e['event_type'] ?? '') . ($e['policy_name'] ?? ''), 'stranger') !== false;
    }

    /**
     * Is a module "armed" right now for a window spec like "22:00-06:00"?
     * "always"/'' → true, "off" → false. Overnight spans wrap midnight.
     */
    public static function armedNow(string $window): bool
    {
        $window = strtolower(trim($window));
        if ($window === '' || $window === 'always') {
            return true;
        }
        if ($window === 'off') {
            return false;
        }
        if (!preg_match('/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/', $window, $m)) {
            return true; // unparseable → fail open
        }
        $now   = (int) date('G') * 60 + (int) date('i');
        $start = (int) $m[1] * 60 + (int) $m[2];
        $end   = (int) $m[3] * 60 + (int) $m[4];
        return $start <= $end
            ? ($now >= $start && $now < $end)
            : ($now >= $start || $now < $end);   // overnight window, e.g. 22:00-06:00
    }

    public static function sevOf(array $e, string $mod): string
    {
        // Base severity is the policy's configured alertLevel (0 Low … 3 Severe).
        $map = ['0' => 'low', '1' => 'medium', '2' => 'high', '3' => 'critical'];
        $sev = $map[(string) ($e['alert_level'] ?? '')] ?? 'low';

        // Only a specific detected hazard escalates beyond the configured level.
        $dec = $e['decoded'] ?? [];
        if (($dec['Smoking'] ?? '') === 'IsSmoking') {
            $sev = self::maxSev($sev, 'high');
        }
        // Real smoke/flame from the fire X-model is never a "low" event.
        if ($mod === 'fire' && ($dec['Smoking'] ?? '') !== 'IsSmoking') {
            $sev = self::maxSev($sev, 'high');
        }
        if (self::isStranger($e)) {
            $sev = self::maxSev($sev, 'high');
        }
        return $sev;
    }

    /** Backfill display fixes for maps decoded before dictionary updates (e.g. Gender 99/2 → Unknown). */
    private static function normalizeDecoded(array $dec): array
    {
        if (isset($dec['Gender']) && !in_array($dec['Gender'], ['Male', 'Female'], true)) {
            $dec['Gender'] = 'Unknown';
        }
        // Attribute names/values can arrive Chinese from a Cn-only policy.
        $out = [];
        foreach ($dec as $k => $v) {
            $key = Text::latin((string) $k, (string) $k);
            $out[$key] = is_string($v) ? Text::latin($v, $v) : $v;
        }
        return $out;
    }

    public static function titleOf(array $e, string $mod): string
    {
        // A SenseStudio person-group match names the person — lead with that.
        $matched = Text::latin((string) ($e['person_name'] ?? ''), '');
        if ($matched !== '' && $mod === 'face') {
            return 'Face match — ' . $matched;
        }

        $dec = $e['decoded'] ?? [];
        $gender = $dec['Gender'] ?? null;
        $age    = $dec['Age'] ?? null;
        // Only Male/Female are identifying; 99/2/"Unknown"/blank read as a plain "person".
        $genderLabel = in_array($gender, ['Male', 'Female'], true) ? $gender : 'person';
        $person = trim(($age ? $age . ' ' : '') . $genderLabel);

        if ($mod === 'fire') {
            return ($dec['Smoking'] ?? '') === 'IsSmoking'
                ? 'Smoking detected — ' . $person
                : 'Smoke / flame detected';
        }
        if ($mod === 'face' && self::isStranger($e)) {
            return 'Stranger detected — ' . $person . ' (no watchlist match)';
        }
        if ($mod === 'ppe') {
            $missing = [];
            if (($dec['WithReflectiveVest'] ?? '') === 'NoReflectiveVest') {
                $missing[] = 'vest';
            }
            if (($dec['HatsType'] ?? '') === 'NoHat') {
                $missing[] = 'helmet';
            }
            return 'PPE violation' . ($missing ? ' — no ' . implode(', ', $missing) : '') . ' (' . $person . ')';
        }

        $base = $mod === 'intr'
            ? 'Intrusion — ' . $person . ' in monitored zone'
            : 'Body attribute — ' . $person;

        $bits = [];
        if (($dec['TopsType'] ?? '')) {
            $bits[] = strtolower((string) $dec['TopsType']);
        }
        if (($dec['WithMask'] ?? '') === 'WithMask') {
            $bits[] = 'masked';
        }
        return $bits ? $base . ' · ' . implode(' · ', $bits) : $base;
    }

    private static function tsOf(array $e): int
    {
        $t = (string) ($e['trigger_time'] ?? '');
        if ($t !== '') {
            $ts = strtotime(preg_replace('/\.\d+$/', '', $t) ?: $t);
            if ($ts) {
                return $ts * 1000;
            }
        }
        $ts = strtotime((string) ($e['received_at'] ?? '')) ?: time();
        return $ts * 1000;
    }

    private static function personConf(array $e): ?float
    {
        foreach (($e['attributes'] ?? []) as $a) {
            if (($a['key'] ?? '') === '-1' && isset($a['conf'])) {
                return round((float) $a['conf'], 2);
            }
        }
        return null;
    }

    private static function boxOf(array $e, string $sev): ?array
    {
        $d = $e['detect'] ?? null;
        if (!is_array($d)) {
            return null;
        }
        $l = (float) ($d['left'] ?? 0);
        $t = (float) ($d['top'] ?? 0);
        $r = (float) ($d['right'] ?? 0);
        $b = (float) ($d['bottom'] ?? 0);
        if ($r <= $l || $b <= $t) {
            return null;
        }
        $left = max(0, min(100, $l / self::FRAME_W * 100));
        $top  = max(0, min(100, $t / self::FRAME_H * 100));
        $w    = max(1, min(100 - $left, ($r - $l) / self::FRAME_W * 100));
        $h    = max(1, min(100 - $top, ($b - $t) / self::FRAME_H * 100));

        $conf  = self::personConf($e);
        $label = 'PERSON' . ($conf !== null ? ' ' . number_format($conf, 2) : '');

        return [
            'top'   => round($top, 1) . '%',
            'left'  => round($left, 1) . '%',
            'w'     => round($w, 1) . '%',
            'h'     => round($h, 1) . '%',
            'sev'   => $sev,
            'label' => $label,
            // Event time (ms) so the client can expire boxes that no longer
            // reflect where the target is.
            'ts'    => self::tsOf($e),
        ];
    }

    /** Public box accessor so the feed can add boxes from additional events. */
    public static function boxFor(array $e): ?array
    {
        $mod = self::modOf($e);
        return self::boxOf($e, self::sevOf($e, $mod));
    }

    private static function maxSev(string $a, string $b): string
    {
        return (self::SEV_RANK[$a] ?? 0) >= (self::SEV_RANK[$b] ?? 0) ? $a : $b;
    }
}
