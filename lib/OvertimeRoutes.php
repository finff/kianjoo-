<?php
/**
 * Overtime (OT) routes, included from api/index.php inside its try {} (shares
 * $route, $seg, $method, $config). Same conventions as lib/HrRoutes.php: the
 * caller is resolved server-side via AiGuard on every request; the dashboard
 * read token grants nothing here; a record outside the caller's scope
 * answers 404. RBAC = leave approvals (see lib/Overtime.php).
 *
 *   GET  /overtime[?from=&to=&status=pending|approved|rejected|all&department=&plant=&q=&person_id=&limit=&offset=]
 *                                       records + totals (staff: own only; supervisor: own dept; admin: all).
 *                                       Re-captures the last 3 days of the range first.          [signed in]
 *   GET  /overtime/mine?month=YYYY-MM   own records for the month + totals + the rule           [signed in]
 *   GET  /overtime/export?from=&to=&status=&department=&plant=&q=   CSV of the same list         [signed in; scoped]
 *   POST /overtime/recompute            {from, to} (≤ 62 days, ≤ today) — re-run capture        [supervisor+]
 *   GET  /overtime/{id}                 one record                                               [own / in scope]
 *   POST /overtime/{id}/approve         {note?, minutes?} (a different figure needs a note)      [approver in scope, not own]
 *   POST /overtime/{id}/reject          {note} (required)                                        [approver in scope, not own]
 *   POST /overtime/{id}/reopen          decided → pending                                        [approver in scope, not own]
 */

declare(strict_types=1);

if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

if (($seg[0] ?? '') !== 'overtime') {
    return;   // not ours — fall through to the rest of api/index.php
}

require_once APP_ROOT . '/lib/AiGuard.php';
require_once APP_ROOT . '/lib/Overtime.php';

$otPdo  = Database::connect($config['storage']);
$otBody = static function (): array {
    $raw = file_get_contents('php://input') ?: '';
    $j   = json_decode($raw, true);
    return is_array($j) ? $j : $_POST;
};
$p  = AiGuard::require($otPdo);
$ot = new Overtime($otPdo, $config);

/** Re-run attendance (which captures OT) for each date in [from, to], capped at today and 62 days. */
$otCapture = static function (string $from, string $to) use ($otPdo, $config): int {
    require_once APP_ROOT . '/lib/Attendance.php';
    $att   = (new Attendance(new EventStore($otPdo, $config), $config))->withOvertime(new Overtime($otPdo, $config));
    $today = date('Y-m-d');
    $to    = min($to, $today);
    $d     = strtotime($from) ?: time();
    $end   = min(strtotime($to) ?: 0, $d + 61 * 86400);
    $n     = 0;
    for (; $d <= $end; $d += 86400) {
        $att->daily(date('Y-m-d', $d));
        $n++;
    }
    return $n;
};
$otFilter = static function (): array {
    $f = [];
    foreach (['from', 'to', 'status', 'department', 'plant', 'q', 'person_id', 'limit', 'offset'] as $k) {
        if (isset($_GET[$k]) && $_GET[$k] !== '') {
            $f[$k] = substr(trim((string) $_GET[$k]), 0, 80);
        }
    }
    return $f;
};

try {
    $sub = $seg[1] ?? '';

    if ($sub === '' && $method === 'GET') {
        $f    = $otFilter();
        $to   = Overtime::date((string) ($f['to'] ?? ''), date('Y-m-d'));
        $from = Overtime::date((string) ($f['from'] ?? ''), date('Y-m-01'));
        $recent = max($from, date('Y-m-d', strtotime($to) - 2 * 86400));
        if ($recent <= $to && $recent <= date('Y-m-d')) {
            $otCapture($recent, $to);
        }
        Response::ok($ot->list($p, $f) + [
            'defaults'    => $config['attendance']['ot'] ?? Overtime::DEFAULTS,
            'rule'        => Overtime::ruleText(Overtime::ruleFor([], $config['attendance']['ot'] ?? null)),
            'shifts'      => array_map(static fn ($s) => ['id' => $s['id'], 'name' => $s['name'], 'start' => $s['start'], 'end' => $s['end'],
                                 'rule' => Overtime::ruleText(Overtime::ruleFor($s, $config['attendance']['ot'] ?? null))],
                                 $config['attendance']['shifts'] ?? []),
            'plants'      => $config['attendance']['plants'] ?? [],
            'departments' => $config['attendance']['departments'] ?? [],
        ]);
    }

    if ($sub === 'mine' && $method === 'GET') {
        $ym = (string) ($_GET['month'] ?? date('Y-m'));
        if (!preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $ym)) {
            $ym = date('Y-m');
        }
        $pid = (string) ($p['person_id'] ?? '');
        if ($pid === '') {
            Response::ok(['linked' => false, 'month' => $ym, 'records' => [], 'totals' => null]);
        }
        $from = $ym . '-01';
        $to   = date('Y-m-t', strtotime($from) ?: time());
        // Own view = own records only, whatever the caller's tier.
        $self = ['tier' => 'staff'] + $p;
        $res  = $ot->list($self, ['from' => $from, 'to' => $to, 'limit' => 100]);
        // The rule of the employee's own shift (first shift when unassigned — same as Attendance::shiftFor).
        $shifts = $config['attendance']['shifts'] ?? [];
        $mine   = $shifts[0] ?? [];
        try {
            $st = $otPdo->prepare('SELECT shift FROM person_profiles WHERE person_id = :p LIMIT 1');
            $st->execute(['p' => $pid]);
            $sid = (string) ($st->fetchColumn() ?: '');
            foreach ($shifts as $s) {
                if ($s['id'] === $sid) {
                    $mine = $s;
                }
            }
        } catch (Throwable $e) {
            // keep the first shift
        }
        Response::ok(['linked' => true, 'month' => $ym, 'records' => $res['records'], 'totals' => $res['totals'],
                      'shift' => $mine['name'] ?? '',
                      'rule' => Overtime::ruleText(Overtime::ruleFor($mine, $config['attendance']['ot'] ?? null))]);
    }

    if ($sub === 'export' && $method === 'GET') {
        $f = $otFilter();
        $f['limit'] = 1000;
        $res = $ot->list($p, $f);
        $hm  = static fn (?string $t): string => $t ? substr($t, 11, 5) : '';
        $statusTxt = ['pending' => 'Pending approval', 'approved' => 'Approved', 'rejected' => 'Rejected'];
        $kindTxt   = ['after' => 'After shift', 'early' => 'Early start', 'early+after' => 'Early start + after shift', 'rest' => 'Rest day'];
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="overtime-' . $res['from'] . '-to-' . $res['to'] . '.csv"');
        header('Cache-Control: no-store');
        $out = fopen('php://output', 'w');
        fwrite($out, "\xEF\xBB\xBF");   // BOM so Excel opens UTF-8 names correctly
        fputcsv($out, ['Date', 'Staff ID', 'Employee', 'Department', 'Plant', 'Shift', 'Shift end', 'First sighting (check-in)',
                       'Check-in location', 'Check-in camera', 'Last sighting (check-out)', 'Check-out location', 'Check-out camera',
                       'OT type', 'Captured OT (min)', 'OT (min)', 'OT (h)', 'Status', 'Decided by', 'Decided at', 'Note',
                       'Recalculated since decision', 'How it was derived']);
        foreach ($res['records'] as $r) {
            $row = [$r['date'], $r['staffId'], $r['name'], $r['department'], $r['plant'], $r['shift'], $r['shiftEnd'],
                    $hm($r['inAt']), $r['inLoc'], $r['inCam'], $hm($r['outAt']), $r['outLoc'], $r['outCam'],
                    $kindTxt[$r['kind']] ?? (string) $r['kind'], $r['calcMinutes'], $r['status'] === 'rejected' ? 0 : $r['minutes'],
                    round(($r['status'] === 'rejected' ? 0 : $r['minutes']) / 60, 2), $statusTxt[$r['status']] ?? $r['status'],
                    (string) $r['decidedBy'], (string) $r['decidedAt'], (string) $r['note'], $r['changed'] ? 'Yes' : '',
                    $r['explain'] . ' Rule: ' . $r['rule']];
            // Neutralise spreadsheet formulas in operator-entered text.
            fputcsv($out, array_map(static fn ($c) => is_string($c) && preg_match('/^[=+\-@]/', $c) ? "'" . $c : $c, $row));
        }
        fclose($out);
        exit;
    }

    if ($sub === 'recompute' && $method === 'POST') {
        AiGuard::demand($p, 'supervisor');
        $in   = $otBody();
        $to   = Overtime::date((string) ($in['to'] ?? ''), date('Y-m-d'));
        $from = Overtime::date((string) ($in['from'] ?? ''), $to);
        if ($from > $to) {
            [$from, $to] = [$to, $from];
        }
        Response::ok(['days' => $otCapture($from, $to), 'from' => $from, 'to' => min($to, date('Y-m-d'))]);
    }

    if (!ctype_digit($sub)) {
        Response::error('Unknown overtime action.', 404);
    }
    $r = $ot->find((int) $sub);
    if (!$r || !Overtime::canView($r, $p)) {
        Response::error('Overtime record not found.', 404);   // same answer for "exists but not yours"
    }
    $act = $seg[2] ?? '';
    if ($act === '' && $method === 'GET') {
        Response::ok(['record' => $ot->present($r, $p)]);
    }
    if ($method === 'POST' && in_array($act, ['approve', 'reject', 'reopen'], true)) {
        $in   = $otBody();
        $note = (string) ($in['note'] ?? $in['remarks'] ?? '');
        $min  = isset($in['minutes']) && $in['minutes'] !== '' && $in['minutes'] !== null ? (int) $in['minutes'] : null;
        $r2   = match ($act) {
            'approve' => $ot->approve($r, $p, $note, $min),
            'reject'  => $ot->reject($r, $p, $note),
            'reopen'  => $ot->reopen($r, $p),
        };
        Response::ok(['record' => $ot->present($r2, $p)]);
    }
    Response::error('Unknown overtime action.', 404);
} catch (OvertimeForbiddenException $e) {
    Response::error($e->getMessage(), 403);
} catch (InvalidArgumentException $e) {
    Response::error($e->getMessage(), 422);
} catch (DomainException $e) {
    Response::error($e->getMessage(), 409);
}
