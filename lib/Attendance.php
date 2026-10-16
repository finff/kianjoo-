<?php
/**
 * Official attendance (POC Use Case 1).
 *
 * Every face sighting — SenseStudio camera or check-in kiosk — is kept as
 * movement history. Attendance is calculated from those sightings with the
 * rules in $config['attendance']:
 *
 *   clock-in   first sighting at a clock camera inside the shift window
 *              (shift start − 2 h … shift end + 4 h; overnight shifts roll over)
 *   clock-out  last sighting at a clock camera ≥ 30 min after clock-in
 *   late       clock-in after shift start + grace
 *   absent     scheduled, active, no clock-in by shift start + absent_after
 *   missing    clocked in, window over, no clock-out
 *
 * Clock cameras are the ones given a clock_in / clock_out / both role under
 * Settings → Attendance. Until any camera has a role, every sighting counts,
 * so the register works before the cameras are classified.
 *
 * Also syncs employees to the SenseStudio person library (one group per plant).
 */

declare(strict_types=1);

require_once __DIR__ . '/EventStore.php';
require_once __DIR__ . '/SenseApi.php';

final class Attendance
{
    private const WINDOW_BEFORE_S = 7200;    // clock-in accepted from shift start − 2 h
    private const WINDOW_AFTER_S  = 14400;   // clock-out accepted until shift end + 4 h
    private const MIN_SHIFT_S     = 1800;    // a clock-out needs ≥ 30 min after clock-in
    private const VISIT_GAP_S     = 1800;    // movement report: > 30 min apart = separate visits

    private EventStore $store;
    private array $cfg;      // $config['attendance']
    private array $locMap;   // stream key → location name
    private bool $anyRole;

    public function __construct(EventStore $store, array $config)
    {
        $this->store   = $store;
        $this->cfg     = $config['attendance'] ?? [];
        $this->locMap  = $config['poc']['cam_locations'] ?? [];
        $roles         = $this->cfg['cam_roles'] ?? [];
        $this->anyRole = (bool) array_filter($roles, static fn ($r) => $r !== 'movement');
    }

    // ── Lookups ──────────────────────────────────────────────

    /** Location name → plant: the configured mapping, else "Plant N" read from the name. */
    public function plantOf(string $location): string
    {
        $map = $this->cfg['loc_plants'] ?? [];
        if (isset($map[$location])) {
            return (string) $map[$location];
        }
        if (preg_match('/\bplant\s*([a-z0-9]+)/i', $location, $m)) {
            $guess = 'Plant ' . strtoupper($m[1]);
            foreach ($this->cfg['plants'] ?? [] as $p) {
                if (strcasecmp($p, $guess) === 0) {
                    return (string) $p;
                }
            }
            return $guess;
        }
        return '';
    }

    /** Role of the camera a sighting came from: clock_in | clock_out | both | movement. */
    private function roleOf(array $s): string
    {
        if (($s['cam_key'] ?? '') === 'kiosk') {
            return !empty($this->cfg['kiosk_clock']) ? 'both' : 'movement';
        }
        if (!$this->anyRole) {
            return 'both';
        }
        return (string) (($this->cfg['cam_roles'] ?? [])[$s['cam_key'] ?? ''] ?? 'movement');
    }

    private function shiftFor(array $emp): array
    {
        $shifts = $this->cfg['shifts'] ?? [];
        foreach ($shifts as $s) {
            if ($s['id'] === ($emp['shift'] ?? '')) {
                return $s;
            }
        }
        return $shifts[0];
    }

    /** [window start, shift start, shift end, window end] as timestamps for one work date. */
    private function windowOf(array $shift, string $date): array
    {
        $start = strtotime($date . ' ' . $shift['start'] . ':00');
        $end   = strtotime($date . ' ' . $shift['end'] . ':00');
        if ($end <= $start) {
            $end += 86400;   // overnight shift — work date is the start date
        }
        return [$start - self::WINDOW_BEFORE_S, $start, $end, $end + self::WINDOW_AFTER_S];
    }

    /** Collapse repeats of the same person on the same camera within dedupe_s. */
    private function dedupe(array $rows): array
    {
        $gap  = (int) ($this->cfg['dedupe_s'] ?? 60);
        $last = [];
        $out  = [];
        foreach ($rows as $r) {
            $k = $r['person_id'] . '|' . ($r['cam_key'] ?? '');
            $t = strtotime($r['time']) ?: 0;
            if (isset($last[$k]) && $t - $last[$k] < $gap) {
                continue;
            }
            $last[$k] = $t;
            $out[] = $r;
        }
        return $out;
    }

    // ── Daily register ───────────────────────────────────────

    /**
     * One row per active employee for $date, filtered, plus KPI counts and the
     * day's recent recognitions.
     *
     * @param array{plant?:string,department?:string,q?:string,status?:string} $f
     */
    public function daily(string $date, array $f = []): array
    {
        $date     = self::cleanDate($date);
        $profiles = $this->store->personProfiles();
        $shifts   = $this->cfg['shifts'] ?? [];

        // One fetch covering every shift window of the day.
        $from = PHP_INT_MAX;
        $to   = 0;
        foreach ($shifts as $s) {
            [$ws, , , $we] = $this->windowOf($s, $date);
            $from = min($from, $ws);
            $to   = max($to, $we);
        }
        $sightings = $this->dedupe($this->store->sightingsBetween(
            date('Y-m-d H:i:s', $from), date('Y-m-d H:i:s', $to), $this->locMap));
        $byPerson = [];
        foreach ($sightings as $s) {
            $byPerson[$s['person_id']][] = $s;
        }

        $now  = time();
        $rows = [];
        foreach ($profiles as $pid => $emp) {
            if (empty($emp['active'])) {
                continue;
            }
            $rows[] = $this->dayRow($emp, $date, $byPerson[$pid] ?? [], $now);
        }

        // Filters (status filter applies to the table only, not the KPIs).
        $q     = strtolower(trim((string) ($f['q'] ?? '')));
        $rows  = array_values(array_filter($rows, static function ($r) use ($f, $q) {
            return (empty($f['plant']) || $r['plant'] === $f['plant'])
                && (empty($f['department']) || $r['department'] === $f['department'])
                && ($q === '' || str_contains(strtolower($r['name'] . ' ' . $r['staffId']), $q));
        }));
        $kpi = ['total' => 0, 'present' => 0, 'late' => 0, 'absent' => 0, 'pending' => 0, 'off' => 0, 'missingOut' => 0];
        foreach ($rows as $r) {
            if ($r['status'] === 'off') {
                $kpi['off']++;
                continue;
            }
            $kpi['total']++;
            if ($r['status'] === 'present' || $r['status'] === 'late') {
                $kpi['present']++;
            }
            if ($r['status'] === 'late') {
                $kpi['late']++;
            }
            if ($r['status'] === 'absent') {
                $kpi['absent']++;
            }
            if ($r['status'] === 'pending') {
                $kpi['pending']++;
            }
            if (in_array('missing_out', $r['flags'], true)) {
                $kpi['missingOut']++;
            }
        }
        if (!empty($f['status'])) {
            $want = $f['status'];
            $rows = array_values(array_filter($rows, static fn ($r) => $want === 'present'
                ? in_array($r['status'], ['present', 'late'], true)
                : ($want === 'missing_out' ? in_array('missing_out', $r['flags'], true) : $r['status'] === $want)));
        }
        $order = ['absent' => 0, 'late' => 1, 'pending' => 2, 'present' => 3, 'off' => 4];
        usort($rows, static fn ($a, $b) => [$order[$a['status']] ?? 9, $a['name']] <=> [$order[$b['status']] ?? 9, $b['name']]);

        // Recent recognitions on the calendar day (newest first).
        $unknown = [];
        $recent  = [];
        foreach (array_reverse($sightings) as $s) {
            if (substr($s['time'], 0, 10) !== $date) {
                continue;
            }
            $emp   = $profiles[$s['person_id']] ?? null;
            $plant = $this->plantOf($s['location']);
            if ($emp === null) {
                $unknown[$s['person_id']] = true;
            }
            if (!empty($f['plant']) && $plant !== $f['plant']) {
                continue;
            }
            if (count($recent) < 30) {
                $recent[] = [
                    'time' => $s['time'], 'personId' => $s['person_id'],
                    'name' => $emp['name'] ?? '', 'staffId' => $emp['staffId'] ?? '',
                    'known' => $emp !== null, 'location' => $s['location'], 'plant' => $plant,
                    'camera' => $s['camera'], 'source' => $s['source'], 'similarity' => $s['similarity'],
                    'image' => $s['image'], 'role' => $this->roleOf($s),
                ];
            }
        }
        $kpi['unknown'] = count($unknown);

        return ['date' => $date, 'kpi' => $kpi, 'rows' => $rows, 'recent' => $recent,
                'rolesSet' => $this->anyRole];
    }

    private function dayRow(array $emp, string $date, array $sight, int $now): array
    {
        $shift = $this->shiftFor($emp);
        [$ws, $ss, $se, $we] = $this->windowOf($shift, $date);
        $scheduled = in_array((int) date('N', strtotime($date)), $shift['days'], true);

        $in = $out = null;
        $plants = [];
        $last = null;
        foreach ($sight as $s) {
            $t = strtotime($s['time']) ?: 0;
            if ($t < $ws || $t >= $we) {
                continue;
            }
            $last = $s;
            $p = $this->plantOf($s['location']);
            if ($p !== '' && !in_array($p, $plants, true)) {
                $plants[] = $p;
            }
            $role = $this->roleOf($s);
            if ($in === null && ($role === 'clock_in' || $role === 'both') && $t <= $se) {
                $in = $s;
            } elseif ($in !== null && ($role === 'clock_out' || $role === 'both')
                && $t - (strtotime($in['time']) ?: 0) >= self::MIN_SHIFT_S) {
                $out = $s;
            }
        }

        $flags   = [];
        $lateMin = 0;
        $inTs    = $in ? (strtotime($in['time']) ?: 0) : 0;
        if ($in) {
            $lateMin = max(0, (int) floor(($inTs - $ss) / 60));
            $status  = $scheduled && $inTs > $ss + $shift['grace'] * 60 ? 'late' : 'present';
            if (!$scheduled) {
                $flags[] = 'off_day';
                $lateMin = 0;
            }
            if (!$out && $now >= $we) {
                $flags[] = 'missing_out';
            }
            if ($out && (strtotime($out['time']) ?: 0) < $se - $shift['grace'] * 60 && $now >= $se) {
                $flags[] = 'early_out';
            }
        } elseif (!$scheduled) {
            $status = 'off';
        } elseif ($now >= $ss + $shift['absent_after'] * 60) {
            $status = 'absent';
        } else {
            $status = 'pending';   // shift not started, or still inside the absent threshold
        }
        $hours = ($in && $out) ? round(((strtotime($out['time']) ?: 0) - $inTs) / 3600, 1) : null;

        return [
            'personId'   => $emp['personId'], 'name' => $emp['name'], 'staffId' => $emp['staffId'],
            'department' => $emp['department'], 'plant' => $emp['plant'], 'photo' => $emp['photo'],
            'shift'      => $shift['name'], 'shiftStart' => $shift['start'], 'shiftEnd' => $shift['end'],
            'clockIn'    => $in['time'] ?? null, 'clockInLoc' => $in['location'] ?? null,
            'clockInSrc' => $in['source'] ?? null,
            'clockOut'   => $out['time'] ?? null, 'clockOutLoc' => $out['location'] ?? null,
            'status'     => $status, 'lateMin' => $status === 'late' ? $lateMin : 0,
            'hours'      => $hours, 'flags' => $flags, 'plants' => $plants,
            'lastSeen'   => $last['time'] ?? null, 'lastLoc' => $last['location'] ?? null,
            'sightings'  => count($sight),
        ];
    }

    /** Daily rows for every date in [$from, $to] (max 62 days) — the range report. */
    public function range(string $from, string $to, array $f = []): array
    {
        $d   = strtotime(self::cleanDate($from));
        $end = min(strtotime(self::cleanDate($to)), $d + 61 * 86400);
        $out = [];
        for (; $d <= $end; $d += 86400) {
            $day = $this->daily(date('Y-m-d', $d), $f);
            foreach ($day['rows'] as $r) {
                $out[] = ['date' => $day['date']] + $r;
            }
        }
        return $out;
    }

    /**
     * Movement report: every sighting in [$from, $to] grouped into visits
     * (consecutive sightings at one location), per person.
     */
    public function movement(string $from, string $to, ?string $personId, array $f = []): array
    {
        $fromTs   = strtotime(self::cleanDate($from));
        $toTs     = min(strtotime(self::cleanDate($to)), $fromTs + 30 * 86400) + 86400;
        $profiles = $this->store->personProfiles();
        $rows     = $this->dedupe($this->store->sightingsBetween(date('Y-m-d H:i:s', $fromTs),
            date('Y-m-d H:i:s', $toTs), $this->locMap, $personId ?: null));

        $q      = strtolower(trim((string) ($f['q'] ?? '')));
        $visits = [];
        $open   = [];   // person → index of their current visit
        foreach ($rows as $s) {
            $emp = $profiles[$s['person_id']] ?? null;
            if ($emp === null && empty($f['unknown'])) {
                continue;
            }
            if ((!empty($f['department']) && ($emp['department'] ?? '') !== $f['department'])
                || ($q !== '' && !str_contains(strtolower(($emp['name'] ?? '') . ' ' . ($emp['staffId'] ?? '')), $q))) {
                continue;
            }
            $plant = $this->plantOf($s['location']);
            if (!empty($f['plant']) && $plant !== $f['plant']) {
                continue;
            }
            $pid = $s['person_id'];
            $i   = $open[$pid] ?? null;
            // Same location again within VISIT_GAP_S = still the same visit;
            // a later return (e.g. back through the gate after lunch) is a new one.
            if ($i !== null && $visits[$i]['location'] === $s['location']
                && (strtotime($s['time']) ?: 0) - (strtotime($visits[$i]['depart']) ?: 0) <= self::VISIT_GAP_S) {
                $visits[$i]['depart'] = $s['time'];
                $visits[$i]['captures']++;
                continue;
            }
            $open[$pid] = count($visits);
            $visits[] = [
                'personId' => $pid, 'name' => $emp['name'] ?? ('Unknown #' . $pid),
                'staffId' => $emp['staffId'] ?? '', 'department' => $emp['department'] ?? '',
                'plant' => $plant, 'location' => $s['location'], 'camera' => $s['camera'],
                'source' => $s['source'], 'similarity' => $s['similarity'], 'role' => $this->roleOf($s),
                'arrive' => $s['time'], 'depart' => $s['time'], 'captures' => 1,
            ];
        }
        foreach ($visits as &$v) {
            $v['dwellMin'] = max(0, (int) round(((strtotime($v['depart']) ?: 0) - (strtotime($v['arrive']) ?: 0)) / 60));
        }
        unset($v);
        usort($visits, static fn ($a, $b) => [$a['name'], $a['arrive']] <=> [$b['name'], $b['arrive']]);
        return $visits;
    }

    public static function cleanDate(string $d): string
    {
        return preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) && strtotime($d) ? $d : date('Y-m-d');
    }

    // ── SenseStudio person-library sync ──────────────────────

    /**
     * Push one employee to SenseStudio: upload the profile photo, create or
     * update the person, add it to the plant's person group. An inactive
     * employee is deactivated there instead.
     *
     * @return array{ok:bool,uid?:string,group?:string,error?:string}
     */
    public function sync(array $emp, SenseApi $api, string $appRoot, ?Kiosk $kiosk): array
    {
        $pid = (string) $emp['personId'];
        $fail = function (string $why) use ($pid): array {
            $this->store->setSyncState($pid, null, 'failed', $why);
            return ['ok' => false, 'error' => $why];
        };
        if (!$api->ready()) {
            return $fail('SenseStudio API account is not configured (Settings → SenseTime API).');
        }
        if (empty($emp['active'])) {
            if ($emp['ssUid'] === '') {
                $this->store->setSyncState($pid, null, 'inactive', null);
                return ['ok' => true];
            }
            $r = $api->deactivatePerson($emp['ssUid']);
            if (!$r['ok']) {
                return $fail('Deactivate failed: ' . ($r['msg'] ?? $r['error'] ?? 'error'));
            }
            $this->store->setSyncState($pid, null, 'inactive', null);
            return ['ok' => true, 'uid' => $emp['ssUid']];
        }
        if (trim((string) $emp['staffId']) === '') {
            return $fail('Add a staff / employee ID before syncing.');
        }

        $raw = $this->photoBytes((string) $emp['photo'], $appRoot, $kiosk);
        if ($raw === null) {
            return $fail('No usable profile photo — attach a clear face photo first.');
        }
        $up = $api->uploadPersonImage($raw, 'emp-' . preg_replace('/[^A-Za-z0-9_-]/', '', (string) $emp['staffId']) . '.jpg');
        if (!$up['ok'] || !is_string($up['data'] ?? null)) {
            return $fail('Photo rejected by SenseStudio: ' . ($up['msg'] ?? $up['error'] ?? 'upload failed'));
        }
        $img  = (string) $up['data'];
        $desc = trim(($emp['department'] ?? '') . ' · ' . ($emp['plant'] ?? ''), ' ·');

        $uid = (string) $emp['ssUid'];
        if ($uid !== '') {
            $r = $api->updatePerson($uid, (string) $emp['name'], (string) $emp['staffId'], $img, $desc);
            if (!$r['ok']) {
                $uid = '';   // removed on the SenseStudio side → create it again
            }
        }
        if ($uid === '') {
            $r = $api->createPerson($img, (string) $emp['name'], (string) $emp['staffId'], $desc);
            if (!$r['ok'] || ($r['data'] ?? '') === '') {
                return $fail('Create person failed: ' . ($r['msg'] ?? $r['error'] ?? 'error'));
            }
            $uid = (string) $r['data'];
        }

        $group = null;
        $warn  = null;
        $plant = trim((string) ($emp['plant'] ?? ''));
        if ($plant !== '') {
            $group = $this->groupId($api, ($this->cfg['ss_group_prefix'] ?? 'Kian Joo') . ' ' . $plant, $appRoot);
            if ($group === null) {
                $warn = 'Person saved, but the plant group could not be created.';
            } else {
                $r = $api->addGroupMembers($group, [$uid]);
                if (!$r['ok'] && !preg_match('/exist|already/i', (string) ($r['msg'] ?? ''))) {
                    $warn = 'Person saved, but adding to the plant group failed: ' . ($r['msg'] ?? $r['error'] ?? 'error');
                }
            }
        }
        $this->store->setSyncState($pid, $uid, $warn ? 'partial' : 'synced', $warn);
        return ['ok' => true, 'uid' => $uid, 'group' => $group, 'warning' => $warn];
    }

    /** Find or create a person group by name; ids are cached in storage/sense_groups.json. */
    private function groupId(SenseApi $api, string $name, string $appRoot): ?string
    {
        $file  = $appRoot . '/storage/sense_groups.json';
        $cache = is_file($file) ? (json_decode((string) file_get_contents($file), true) ?: []) : [];
        if (!empty($cache[$name])) {
            return (string) $cache[$name];
        }
        $id = null;
        $r  = $api->listPersonGroups($name);
        foreach ((is_array($r['data'] ?? null) ? $r['data'] : []) as $g) {
            if (($g['cnName'] ?? '') === $name && (string) ($g['sts'] ?? '0') === '0') {
                $id = (string) $g['groupId'];
                break;
            }
        }
        if ($id === null) {
            $c = $api->createPersonGroup($name, 'Employees enrolled from the Kian Joo VisionAI dashboard');
            $id = $c['ok'] && ($c['data'] ?? '') !== '' ? (string) $c['data'] : null;
        }
        if ($id !== null) {
            $cache[$name] = $id;
            @file_put_contents($file, json_encode($cache, JSON_PRETTY_PRINT), LOCK_EX);
        }
        return $id;
    }

    /** Bytes of the profile photo: an uploaded file, a kiosk snapshot, or a remote capture URL. */
    private function photoBytes(string $url, string $appRoot, ?Kiosk $kiosk): ?string
    {
        if ($url === '') {
            return null;
        }
        if (preg_match('#/uploads/profiles/([A-Za-z0-9_.\-]+)$#', $url, $m)) {
            $p = $appRoot . '/uploads/profiles/' . $m[1];
            return is_file($p) ? ((string) file_get_contents($p) ?: null) : null;
        }
        if ($kiosk !== null && preg_match('#/api/kiosk/snap\?f=([^&]+)#', $url, $m)) {
            $p = $kiosk->snapPath(rawurldecode($m[1]));
            return $p !== null ? ((string) file_get_contents($p) ?: null) : null;
        }
        if (preg_match('#^https?://#i', $url)) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10,
                                    CURLOPT_CONNECTTIMEOUT => 5, CURLOPT_FOLLOWLOCATION => true]);
            $b = curl_exec($ch);
            $ok = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE) === 200;
            curl_close($ch);
            return $ok && is_string($b) && $b !== '' ? $b : null;
        }
        return null;
    }
}
