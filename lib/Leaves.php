<?php
/**
 * M6 leave workflow: types, yearly balances, requests, approvals, attachments.
 *
 * Status flow   draft → pending → approved | rejected
 *               draft | pending | approved → cancelled
 *
 * Balance rules (per user · year of start_date · leave type)
 *   available = entitled − used − pending (other pending requests)
 *   submit   : days ≤ available (unlimited types skip the check), else rejected
 *   approve  : re-checked, then used += days (inside a transaction)
 *   cancel   : of an approved request → used −= days (restored)
 *   reject / cancel of a pending request → nothing was deducted; the hold is released
 * Overlap: a new request may not overlap the user's pending/approved requests
 * (except two half days on the same date with different AM/PM periods).
 *
 * Who decides: supervisor tier → requests in their department (a supervisor
 * without a department covers everyone, same rule as AiTools team scope);
 * admin tier → all. Nobody decides their own request. Requests outside the
 * caller's scope answer 404 at the route (no existence leak).
 *
 * Days = working days (Mon–Fri, see WEEKEND) between start and end inclusive;
 * a half day (single date only) counts 0.5. Public holidays are not modelled.
 */

declare(strict_types=1);

require_once __DIR__ . '/AiGuard.php';
require_once __DIR__ . '/ImageTool.php';
require_once __DIR__ . '/Notifications.php';

/** RBAC denial on an object the caller may see (route maps to 403). */
final class LeaveForbiddenException extends RuntimeException
{
}

final class Leaves
{
    public const STATUSES = ['draft', 'pending', 'approved', 'rejected', 'cancelled'];
    /** PHP date('w') values that are not working days. */
    public const WEEKEND = [0, 6];
    public const MAX_SPAN_DAYS = 60;
    public const MAX_BACKDATE_DAYS = 30;
    public const MAX_ATTACHMENTS = 5;

    private const MAX_UPLOAD = 10 * 1024 * 1024;
    private const UPLOAD_MIME = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp',
                                'application/pdf' => 'pdf'];

    public function __construct(private PDO $pdo, private string $storageDir)
    {
        $this->storageDir = rtrim($storageDir, '/');
    }

    // ── Types & balances ─────────────────────────────────────

    public function types(bool $activeOnly = true): array
    {
        $rows = $this->pdo->query('SELECT * FROM leave_types' . ($activeOnly ? ' WHERE active = 1' : '') . ' ORDER BY sort_order, id')->fetchAll();
        return array_map(static fn ($t) => [
            'code' => $t['code'], 'name' => $t['name'], 'default_days' => (float) $t['default_days'],
            'unlimited' => (int) $t['unlimited'] === 1, 'requires_attachment' => (int) $t['requires_attachment'] === 1,
            'color' => $t['color'],
        ], $rows);
    }

    public function type(string $code): ?array
    {
        foreach ($this->types() as $t) {
            if ($t['code'] === strtoupper(trim($code))) {
                return $t;
            }
        }
        return null;
    }

    /** The balance row, created from the type's default entitlement on first use. */
    private function balanceRow(int $userId, int $year, string $code): array
    {
        $get = function () use ($userId, $year, $code) {
            $st = $this->pdo->prepare('SELECT * FROM leave_balances WHERE user_id = :u AND year = :y AND leave_type = :t');
            $st->execute(['u' => $userId, 'y' => $year, 't' => $code]);
            return $st->fetch() ?: null;
        };
        $row = $get();
        if ($row) {
            return $row;
        }
        $type = $this->type($code);
        $sq   = Database::driver() === 'sqlite';
        $this->pdo->prepare(($sq ? 'INSERT OR IGNORE' : 'INSERT IGNORE')
            . ' INTO leave_balances (user_id, year, leave_type, entitled, used, updated_at) VALUES (:u, :y, :t, :e, 0, :n)')
            ->execute(['u' => $userId, 'y' => $year, 't' => $code, 'e' => $type['default_days'] ?? 0, 'n' => date('Y-m-d H:i:s')]);
        return $get();
    }

    private function pendingDays(int $userId, int $year, string $code, int $excludeId = 0): float
    {
        $st = $this->pdo->prepare("SELECT COALESCE(SUM(days), 0) FROM leaves WHERE user_id = :u AND leave_type = :t AND status = 'pending'
                                   AND start_date >= :a AND start_date <= :b AND id <> :x");
        $st->execute(['u' => $userId, 't' => $code, 'a' => $year . '-01-01', 'b' => $year . '-12-31', 'x' => $excludeId]);
        return (float) $st->fetchColumn();
    }

    /** One type's balance: entitled, used, pending, available (null = unlimited). */
    public function balance(int $userId, int $year, string $code, int $excludeId = 0): array
    {
        $type = $this->type($code);
        $row  = $this->balanceRow($userId, $year, $code);
        $ent  = (float) $row['entitled'];
        $used = (float) $row['used'];
        $pend = $this->pendingDays($userId, $year, $code, $excludeId);
        $unl  = (bool) ($type['unlimited'] ?? false);
        return [
            'code' => $code, 'name' => $type['name'] ?? $code, 'color' => $type['color'] ?? null, 'unlimited' => $unl,
            'year' => $year, 'entitled' => $ent, 'used' => $used, 'pending' => $pend,
            'available' => $unl ? null : round($ent - $used - $pend, 1),
        ];
    }

    public function balances(int $userId, ?int $year = null): array
    {
        $year = $year ?: (int) date('Y');
        return array_map(fn ($t) => $this->balance($userId, $year, $t['code']), $this->types());
    }

    /** Admin: set a user's entitlement for a year/type. */
    public function setEntitlement(int $userId, int $year, string $code, float $entitled): array
    {
        if (!$this->type($code)) {
            throw new InvalidArgumentException('Unknown leave type.');
        }
        if ($entitled < 0 || $entitled > 365) {
            throw new InvalidArgumentException('Entitlement must be 0–365 days.');
        }
        $this->balanceRow($userId, $year, strtoupper($code));
        $this->pdo->prepare('UPDATE leave_balances SET entitled = :e, updated_at = :n WHERE user_id = :u AND year = :y AND leave_type = :t')
            ->execute(['e' => round($entitled * 2) / 2, 'n' => date('Y-m-d H:i:s'), 'u' => $userId, 'y' => $year, 't' => strtoupper($code)]);
        return $this->balance($userId, $year, strtoupper($code));
    }

    // ── Day maths ────────────────────────────────────────────

    public static function workingDays(string $start, string $end): int
    {
        $d = new DateTimeImmutable($start);
        $e = new DateTimeImmutable($end);
        $n = 0;
        for (; $d <= $e; $d = $d->modify('+1 day')) {
            if (!in_array((int) $d->format('w'), self::WEEKEND, true)) {
                $n++;
            }
        }
        return $n;
    }

    private static function date(mixed $v, string $label): string
    {
        $s = trim((string) $v);
        $d = DateTimeImmutable::createFromFormat('!Y-m-d', $s);
        if (!$d || $d->format('Y-m-d') !== $s) {
            throw new InvalidArgumentException($label . ' must be a date YYYY-MM-DD.');
        }
        return $s;
    }

    // ── Access ───────────────────────────────────────────────

    public static function isApprover(array $p): bool
    {
        return AiGuard::atLeast($p, 'supervisor');
    }

    /** Is the leave inside the caller's approval scope (department / all)? */
    public static function inScope(array $l, array $p): bool
    {
        if (!self::isApprover($p)) {
            return false;
        }
        if ($p['tier'] === 'admin' || (string) $p['department'] === '') {
            return true;
        }
        return (string) ($l['department'] ?? '') === (string) $p['department'];
    }

    public static function isOwner(array $l, array $p): bool
    {
        return (int) $p['id'] > 0 && (int) $l['user_id'] === (int) $p['id'];
    }

    public static function canView(array $l, array $p): bool
    {
        return self::isOwner($l, $p) || (self::inScope($l, $p) && $l['status'] !== 'draft');
    }

    public static function canDecide(array $l, array $p): bool
    {
        return (int) $p['id'] > 0 && self::inScope($l, $p) && !self::isOwner($l, $p);
    }

    // ── Create / submit ──────────────────────────────────────

    /**
     * @param array $in leave_type, start_date, end_date, half_day, half_day_period (am|pm), reason, draft
     */
    public function create(array $in, array $p): array
    {
        if ((int) $p['id'] <= 0) {
            throw new LeaveForbiddenException('Leave requests need a signed-in user.');
        }
        $type = $this->type((string) ($in['leave_type'] ?? $in['type'] ?? ''));
        if (!$type) {
            throw new InvalidArgumentException('Choose a valid leave type (' . implode(', ', array_column($this->types(), 'code')) . ').');
        }
        $start = self::date($in['start_date'] ?? '', 'start_date');
        $end   = self::date(($in['end_date'] ?? '') !== '' ? $in['end_date'] : $start, 'end_date');
        if ($end < $start) {
            throw new InvalidArgumentException('end_date is before start_date.');
        }
        if (substr($start, 0, 4) !== substr($end, 0, 4)) {
            throw new InvalidArgumentException('A request cannot cross into a new year — split it into two requests.');
        }
        $span = (int) (new DateTimeImmutable($start))->diff(new DateTimeImmutable($end))->days + 1;
        if ($span > self::MAX_SPAN_DAYS) {
            throw new InvalidArgumentException('A single request may span at most ' . self::MAX_SPAN_DAYS . ' days.');
        }
        if ($start < date('Y-m-d', strtotime('-' . self::MAX_BACKDATE_DAYS . ' days'))) {
            throw new InvalidArgumentException('Leave can be back-dated by at most ' . self::MAX_BACKDATE_DAYS . ' days.');
        }
        if ($start > date('Y-m-d', strtotime('+366 days'))) {
            throw new InvalidArgumentException('Leave can be requested at most one year ahead.');
        }
        $half = !empty($in['half_day']) && $in['half_day'] !== 'false';
        $period = null;
        if ($half) {
            if ($start !== $end) {
                throw new InvalidArgumentException('A half day must start and end on the same date.');
            }
            $period = strtolower((string) ($in['half_day_period'] ?? 'am')) === 'pm' ? 'pm' : 'am';
        }
        $wd   = self::workingDays($start, $end);
        $days = $half ? ($wd > 0 ? 0.5 : 0) : (float) $wd;
        if ($days <= 0) {
            throw new InvalidArgumentException('The selected dates contain no working days.');
        }
        $reason = mb_substr(trim((string) ($in['reason'] ?? '')), 0, 1000);

        $now = date('Y-m-d H:i:s');
        $row = [
            'user_id' => (int) $p['id'], 'user_name' => $p['name'], 'person_id' => $p['person_id'] ?? null,
            'department' => ((string) ($p['department'] ?? '')) ?: null, 'leave_type' => $type['code'],
            'start_date' => $start, 'end_date' => $end, 'half_day' => $half ? 1 : 0, 'half_day_period' => $period,
            'days' => $days, 'reason' => $reason, 'status' => 'draft', 'created_at' => $now, 'updated_at' => $now,
        ];
        $draft = !empty($in['draft']) && $in['draft'] !== 'false';
        if (!$draft) {
            $this->assertSubmittable($row, 0);   // fail before inserting anything
        }
        $cols = array_keys($row);
        $this->pdo->prepare('INSERT INTO leaves (' . implode(',', $cols) . ') VALUES (:' . implode(',:', $cols) . ')')->execute($row);
        $id = (int) $this->pdo->lastInsertId();
        $this->update($id, ['leave_no' => 'LV-' . date('ymd') . '-' . str_pad((string) $id, 5, '0', STR_PAD_LEFT)]);
        $l = $this->find($id);
        return $draft ? $l : $this->submit($l, $p);
    }

    /** draft → pending: overlap + balance checks, then notify approvers. */
    public function submit(array $l, array $p): array
    {
        if (!self::isOwner($l, $p)) {
            throw new LeaveForbiddenException('Only the requester can submit this leave.');
        }
        if ($l['status'] !== 'draft') {
            throw new DomainException('Only a draft can be submitted (this one is ' . $l['status'] . ').');
        }
        $this->assertSubmittable($l, (int) $l['id']);
        $now = date('Y-m-d H:i:s');
        $st  = $this->pdo->prepare("UPDATE leaves SET status = 'pending', submitted_at = :n, updated_at = :n2 WHERE id = :id AND status = 'draft'");
        $st->execute(['n' => $now, 'n2' => $now, 'id' => $l['id']]);
        if ($st->rowCount() !== 1) {
            throw new DomainException('This request changed meanwhile — reload it.');
        }
        $l = $this->find((int) $l['id']);
        $this->notify($this->approverIds($l), 'leave_submitted',
            $l['user_name'] . ' requested ' . self::fmtDays((float) $l['days']) . ' ' . $this->typeName($l['leave_type']),
            self::fmtRange($l) . ($l['reason'] ? ' — ' . mb_substr((string) $l['reason'], 0, 140) : ''),
            '#leave&modal=leave:' . $l['id'], 'leave', (int) $l['id']);
        return $l;
    }

    /** Overlap + balance gate shared by create(submit) and submit(). */
    private function assertSubmittable(array $l, int $selfId): void
    {
        $c = $this->overlapping((int) $l['user_id'], $l['start_date'], $l['end_date'], (int) $l['half_day'] === 1, $l['half_day_period'], $selfId);
        if ($c) {
            throw new DomainException('These dates overlap your ' . $c['status'] . ' request ' . $c['leave_no']
                . ' (' . self::fmtRange($c) . ').');
        }
        $b = $this->balance((int) $l['user_id'], (int) substr($l['start_date'], 0, 4), $l['leave_type'], $selfId);
        if (!$b['unlimited'] && (float) $l['days'] > (float) $b['available'] + 1e-9) {
            throw new DomainException('Insufficient ' . $b['name'] . ' balance: ' . self::fmtDays((float) $l['days']) . ' requested, '
                . self::fmtDays(max(0, (float) $b['available'])) . ' available (' . self::fmtDays($b['pending']) . ' pending).');
        }
    }

    /** First pending/approved request of the user overlapping [start, end], or null. */
    public function overlapping(int $userId, string $start, string $end, bool $half, ?string $period, int $excludeId = 0): ?array
    {
        $st = $this->pdo->prepare("SELECT * FROM leaves WHERE user_id = :u AND status IN ('pending','approved') AND id <> :x
                                   AND start_date <= :e AND end_date >= :s ORDER BY start_date");
        $st->execute(['u' => $userId, 'x' => $excludeId, 'e' => $end, 's' => $start]);
        foreach ($st->fetchAll() as $o) {
            $bothHalfSameDay = $half && (int) $o['half_day'] === 1 && $o['start_date'] === $start;
            if ($bothHalfSameDay && $o['half_day_period'] !== $period) {
                continue;   // AM + PM on the same date is fine
            }
            return $o;
        }
        return null;
    }

    // ── Decisions ────────────────────────────────────────────

    public function approve(array $l, array $p, string $remarks = ''): array
    {
        $this->assertDecider($l, $p);
        $remarks = mb_substr(trim($remarks), 0, 1000);
        $this->pdo->beginTransaction();
        try {
            $b = $this->balance((int) $l['user_id'], (int) substr((string) $l['start_date'], 0, 4), $l['leave_type'], (int) $l['id']);
            if (!$b['unlimited'] && (float) $l['days'] > (float) $b['available'] + 1e-9) {
                throw new DomainException('Cannot approve: the requester now has only ' . self::fmtDays(max(0, (float) $b['available']))
                    . ' of ' . $b['name'] . ' available. Reject it with a remark instead.');
            }
            $now = date('Y-m-d H:i:s');
            $st  = $this->pdo->prepare("UPDATE leaves SET status = 'approved', approver_user_id = :a, approver_name = :an,
                                        approver_remarks = :r, decided_at = :n, updated_at = :n2 WHERE id = :id AND status = 'pending'");
            $st->execute(['a' => (int) $p['id'], 'an' => $p['name'], 'r' => $remarks !== '' ? $remarks : null, 'n' => $now, 'n2' => $now, 'id' => $l['id']]);
            if ($st->rowCount() !== 1) {
                throw new DomainException('This request is no longer pending.');
            }
            $this->pdo->prepare('UPDATE leave_balances SET used = used + :d, updated_at = :n WHERE user_id = :u AND year = :y AND leave_type = :t')
                ->execute(['d' => (float) $l['days'], 'n' => $now, 'u' => (int) $l['user_id'], 'y' => (int) substr((string) $l['start_date'], 0, 4), 't' => $l['leave_type']]);
            $this->pdo->commit();
        } catch (Throwable $e) {
            $this->pdo->rollBack();
            throw $e;
        }
        $l = $this->find((int) $l['id']);
        $this->notify([(int) $l['user_id']], 'leave_approved',
            'Your ' . $this->typeName($l['leave_type']) . ' was approved',
            self::fmtRange($l) . ' · by ' . $p['name'] . ($remarks !== '' ? ' — ' . mb_substr($remarks, 0, 140) : ''),
            '#leave&modal=leave:' . $l['id'], 'leave', (int) $l['id']);
        return $l;
    }

    public function reject(array $l, array $p, string $remarks): array
    {
        $this->assertDecider($l, $p);
        $remarks = mb_substr(trim($remarks), 0, 1000);
        if (mb_strlen($remarks) < 3) {
            throw new InvalidArgumentException('Remarks (at least 3 characters) are required to reject a request.');
        }
        $now = date('Y-m-d H:i:s');
        $st  = $this->pdo->prepare("UPDATE leaves SET status = 'rejected', approver_user_id = :a, approver_name = :an,
                                    approver_remarks = :r, decided_at = :n, updated_at = :n2 WHERE id = :id AND status = 'pending'");
        $st->execute(['a' => (int) $p['id'], 'an' => $p['name'], 'r' => $remarks, 'n' => $now, 'n2' => $now, 'id' => $l['id']]);
        if ($st->rowCount() !== 1) {
            throw new DomainException('This request is no longer pending.');
        }
        $l = $this->find((int) $l['id']);
        $this->notify([(int) $l['user_id']], 'leave_rejected',
            'Your ' . $this->typeName($l['leave_type']) . ' was rejected',
            self::fmtRange($l) . ' · by ' . $p['name'] . ' — ' . mb_substr($remarks, 0, 160),
            '#leave&modal=leave:' . $l['id'], 'leave', (int) $l['id']);
        return $l;
    }

    private function assertDecider(array $l, array $p): void
    {
        if (self::isOwner($l, $p)) {
            throw new LeaveForbiddenException('You cannot approve or reject your own leave request.');
        }
        if (!self::canDecide($l, $p)) {
            throw new LeaveForbiddenException('Only a supervisor of this department or an admin can decide this request.');
        }
        if ($l['status'] !== 'pending') {
            throw new DomainException('This request is ' . $l['status'] . ', not pending.');
        }
    }

    /** Which statuses the caller may cancel from. */
    public function canCancel(array $l, array $p): bool
    {
        if (self::isOwner($l, $p)) {
            return in_array($l['status'], ['draft', 'pending'], true)
                || ($l['status'] === 'approved' && (string) $l['start_date'] > date('Y-m-d'));
        }
        return self::canDecide($l, $p) && in_array($l['status'], ['pending', 'approved'], true);
    }

    /**
     * Cancel. Requester: draft/pending any time, approved only before it starts.
     * Approver in scope: pending/approved. Approved → balance restored.
     */
    public function cancel(array $l, array $p, string $remarks = ''): array
    {
        if (!self::isOwner($l, $p) && !self::canDecide($l, $p)) {
            throw new LeaveForbiddenException('You cannot cancel this request.');
        }
        if (!$this->canCancel($l, $p)) {
            throw new DomainException($l['status'] === 'approved'
                ? 'Approved leave that has already started can only be cancelled by an approver.'
                : 'A ' . $l['status'] . ' request cannot be cancelled.');
        }
        $remarks = mb_substr(trim($remarks), 0, 1000);
        $was = (string) $l['status'];
        $now = date('Y-m-d H:i:s');
        $this->pdo->beginTransaction();
        try {
            $st = $this->pdo->prepare("UPDATE leaves SET status = 'cancelled', cancelled_at = :n, cancelled_by = :b, cancel_remarks = :r,
                                       updated_at = :n2 WHERE id = :id AND status = :was");
            $st->execute(['n' => $now, 'b' => $p['name'], 'r' => $remarks !== '' ? $remarks : null, 'n2' => $now, 'id' => $l['id'], 'was' => $was]);
            if ($st->rowCount() !== 1) {
                throw new DomainException('This request changed meanwhile — reload it.');
            }
            if ($was === 'approved') {
                $sq = Database::driver() === 'sqlite';
                $this->pdo->prepare('UPDATE leave_balances SET used = ' . ($sq ? 'MAX(0, used - :d)' : 'GREATEST(0, used - :d)')
                    . ', updated_at = :n WHERE user_id = :u AND year = :y AND leave_type = :t')
                    ->execute(['d' => (float) $l['days'], 'n' => $now, 'u' => (int) $l['user_id'], 'y' => (int) substr((string) $l['start_date'], 0, 4), 't' => $l['leave_type']]);
            }
            $this->pdo->commit();
        } catch (Throwable $e) {
            $this->pdo->rollBack();
            throw $e;
        }
        $l = $this->find((int) $l['id']);
        if (!self::isOwner($l, $p)) {
            $to = [(int) $l['user_id']];
            $title = 'Your ' . $this->typeName($l['leave_type']) . ' was cancelled by ' . $p['name'];
        } elseif ($was === 'approved') {
            $to = [(int) $l['approver_user_id']];
            $title = $l['user_name'] . ' cancelled approved ' . $this->typeName($l['leave_type']);
        } elseif ($was === 'pending') {
            $to = $this->approverIds($l);
            $title = $l['user_name'] . ' withdrew a ' . $this->typeName($l['leave_type']) . ' request';
        } else {
            $to = [];
            $title = '';
        }
        if ($to) {
            Notifications::emit($this->pdo, $to, 'leave_cancelled', $title,
                self::fmtRange($l) . ($remarks !== '' ? ' — ' . mb_substr($remarks, 0, 140) : ''),
                '#leave&modal=leave:' . $l['id'], 'leave', (int) $l['id']);
        }
        return $l;
    }

    // ── Read ─────────────────────────────────────────────────

    public function find($id): ?array
    {
        $st = is_numeric($id)
            ? $this->pdo->prepare('SELECT * FROM leaves WHERE id = :v LIMIT 1')
            : $this->pdo->prepare('SELECT * FROM leaves WHERE leave_no = :v LIMIT 1');
        $st->execute(['v' => is_numeric($id) ? (int) $id : strtoupper(trim((string) $id))]);
        return $st->fetch() ?: null;
    }

    /** The caller's own requests. Filters: status (comma list), year, limit, offset. */
    public function listOwn(array $p, array $f = []): array
    {
        return $this->query(['user_id = :me'], ['me' => (int) $p['id']], $f, $p);
    }

    /**
     * Approval queue / team history for an approver. Filters: status (default
     * pending; "all" for every non-draft), department (admin / dept-less
     * supervisor only), year, from, to, q, limit, offset. Own requests excluded.
     */
    public function listTeam(array $p, array $f = []): array
    {
        if (!self::isApprover($p)) {
            throw new LeaveForbiddenException('Only supervisors and admins can see team leave.');
        }
        $where = ["status <> 'draft'", 'user_id <> :me'];
        $args  = ['me' => (int) $p['id']];
        $dept  = ($p['tier'] === 'admin' || (string) $p['department'] === '') ? trim((string) ($f['department'] ?? '')) : (string) $p['department'];
        if ($dept !== '') {
            $where[] = 'department = :dept';
            $args['dept'] = $dept;
        }
        if (!isset($f['status']) || $f['status'] === '') {
            $f['status'] = 'pending';
        }
        if ($f['status'] === 'all') {
            unset($f['status']);
        }
        if (!empty($f['q'])) {
            $where[] = '(user_name LIKE :q OR leave_no LIKE :q2)';
            $args['q']  = '%' . mb_substr((string) $f['q'], 0, 60) . '%';
            $args['q2'] = $args['q'];
        }
        return $this->query($where, $args, $f, $p);
    }

    private function query(array $where, array $args, array $f, array $p): array
    {
        if (!empty($f['status'])) {
            $sts = array_values(array_intersect(self::STATUSES, explode(',', (string) $f['status'])));
            if ($sts) {
                $ph = [];
                foreach ($sts as $i => $s) {
                    $ph[] = ':st' . $i;
                    $args['st' . $i] = $s;
                }
                $where[] = 'status IN (' . implode(',', $ph) . ')';
            }
        }
        if (!empty($f['year']) && (int) $f['year'] > 2000) {
            $where[] = 'start_date >= :ya AND start_date <= :yb';
            $args['ya'] = (int) $f['year'] . '-01-01';
            $args['yb'] = (int) $f['year'] . '-12-31';
        }
        if (!empty($f['from'])) {
            $where[] = 'end_date >= :from';
            $args['from'] = self::date($f['from'], 'from');
        }
        if (!empty($f['to'])) {
            $where[] = 'start_date <= :to';
            $args['to'] = self::date($f['to'], 'to');
        }
        $limit  = max(1, min(200, (int) ($f['limit'] ?? 50)));
        $offset = max(0, (int) ($f['offset'] ?? 0));
        $w = ' WHERE ' . implode(' AND ', $where);
        $c = $this->pdo->prepare('SELECT COUNT(*) FROM leaves' . $w);
        $c->execute($args);
        $st = $this->pdo->prepare('SELECT * FROM leaves' . $w . ' ORDER BY start_date DESC, id DESC LIMIT ' . $limit . ' OFFSET ' . $offset);
        $st->execute($args);
        return ['total' => (int) $c->fetchColumn(), 'limit' => $limit, 'offset' => $offset,
                'leaves' => array_map(fn ($l) => $this->present($l, $p), $st->fetchAll())];
    }

    public function present(array $l, array $p): array
    {
        $type = $this->type((string) $l['leave_type']);
        $emp  = $this->employeeOf((int) $l['user_id'], isset($l['person_id']) ? (string) $l['person_id'] : null);
        return [
            'id' => (int) $l['id'], 'leave_no' => $l['leave_no'], 'user_id' => (int) $l['user_id'], 'user_name' => $l['user_name'],
            'person_id' => $emp['person_id'], 'staff_id' => $emp['staff_id'],
            'department' => $l['department'], 'leave_type' => $l['leave_type'], 'leave_type_name' => $type['name'] ?? $l['leave_type'],
            'color' => $type['color'] ?? null, 'start_date' => $l['start_date'], 'end_date' => $l['end_date'],
            'half_day' => (int) $l['half_day'] === 1, 'half_day_period' => $l['half_day_period'], 'days' => (float) $l['days'],
            'reason' => $l['reason'], 'status' => $l['status'], 'submitted_at' => $l['submitted_at'],
            'approver' => $l['approver_name'], 'approver_user_id' => $l['approver_user_id'] !== null ? (int) $l['approver_user_id'] : null,
            'approver_remarks' => $l['approver_remarks'], 'decided_at' => $l['decided_at'],
            'cancelled_at' => $l['cancelled_at'], 'cancelled_by' => $l['cancelled_by'], 'cancel_remarks' => $l['cancel_remarks'],
            'created_at' => $l['created_at'], 'updated_at' => $l['updated_at'],
            'is_mine' => self::isOwner($l, $p),
            'can' => [
                'submit'  => self::isOwner($l, $p) && $l['status'] === 'draft',
                'cancel'  => $this->canCancel($l, $p),
                'approve' => self::canDecide($l, $p) && $l['status'] === 'pending',
                'reject'  => self::canDecide($l, $p) && $l['status'] === 'pending',
                'attach'  => self::isOwner($l, $p) && in_array($l['status'], ['draft', 'pending', 'approved'], true),
            ],
        ];
    }

    /** Full request: row + attachments + the requester's balance for that type/year. */
    public function detail(array $l, array $p): array
    {
        $st = $this->pdo->prepare('SELECT * FROM leave_attachments WHERE leave_id = :id ORDER BY id');
        $st->execute(['id' => $l['id']]);
        $atts = array_map(static fn ($a) => [
            'id' => (int) $a['id'], 'filename' => $a['filename'], 'mime' => $a['mime'], 'size' => (int) $a['size_bytes'],
            'created_at' => $a['created_at'], 'url' => '/api/leaves/' . (int) $l['id'] . '/attachments/' . (int) $a['id'],
        ], $st->fetchAll());
        $type = $this->type((string) $l['leave_type']);
        return $this->present($l, $p) + [
            'attachments' => $atts,
            'missing_attachment' => !empty($type['requires_attachment']) && !$atts,
            'balance' => $this->balance((int) $l['user_id'], (int) substr((string) $l['start_date'], 0, 4), (string) $l['leave_type']),
        ];
    }

    /**
     * Approved leave overlapping a month, grouped by department (team-leave
     * calendar). Staff: own department only (or just themselves without one);
     * supervisor: own department (dept-less: any / ?department); admin: any.
     * Approvers may add pending with $includePending. No reasons are exposed.
     */
    public function calendar(array $p, string $month, string $department = '', bool $includePending = false): array
    {
        if (!preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $month)) {
            throw new InvalidArgumentException('month must be YYYY-MM.');
        }
        $from = $month . '-01';
        $to   = date('Y-m-t', strtotime($from));
        $where = ['start_date <= :to', 'end_date >= :from'];
        $args  = ['from' => $from, 'to' => $to];
        $statuses = ($includePending && self::isApprover($p)) ? ['approved', 'pending'] : ['approved'];
        $where[] = "status IN ('" . implode("','", $statuses) . "')";

        $own = (string) ($p['department'] ?? '');
        if (!self::isApprover($p)) {
            if ($own !== '') {
                $where[] = 'department = :d';
                $args['d'] = $own;
            } else {
                $where[] = 'user_id = :me';
                $args['me'] = (int) $p['id'];
            }
            $scope = $own !== '' ? $own : 'self';
        } elseif ($p['tier'] === 'admin' || $own === '') {
            $department = trim($department);
            if ($department !== '') {
                $where[] = 'department = :d';
                $args['d'] = $department;
            }
            $scope = $department !== '' ? $department : 'all';
        } else {
            $where[] = 'department = :d';
            $args['d'] = $own;
            $scope = $own;
        }
        $st = $this->pdo->prepare('SELECT * FROM leaves WHERE ' . implode(' AND ', $where) . ' ORDER BY start_date, user_name');
        $st->execute($args);

        $groups = [];
        $perDay = [];
        foreach ($st->fetchAll() as $l) {
            $type = $this->type((string) $l['leave_type']);
            $dept = (string) ($l['department'] ?: 'Unassigned');
            $emp  = $this->employeeOf((int) $l['user_id'], isset($l['person_id']) ? (string) $l['person_id'] : null);
            $groups[$dept][] = [
                'id' => (int) $l['id'], 'user_id' => (int) $l['user_id'], 'name' => $l['user_name'],
                'person_id' => $emp['person_id'], 'staff_id' => $emp['staff_id'], 'leave_type' => $l['leave_type'],
                'leave_type_name' => $type['name'] ?? $l['leave_type'], 'color' => $type['color'] ?? null, 'status' => $l['status'],
                'start_date' => $l['start_date'], 'end_date' => $l['end_date'], 'half_day' => (int) $l['half_day'] === 1,
                'half_day_period' => $l['half_day_period'], 'days' => (float) $l['days'],
            ];
            $d = new DateTimeImmutable(max($from, (string) $l['start_date']));
            $e = new DateTimeImmutable(min($to, (string) $l['end_date']));
            for (; $d <= $e; $d = $d->modify('+1 day')) {
                if (!in_array((int) $d->format('w'), self::WEEKEND, true)) {
                    $k = $d->format('Y-m-d');
                    $perDay[$k] = ($perDay[$k] ?? 0) + 1;
                }
            }
        }
        ksort($groups);
        ksort($perDay);
        $out = [];
        foreach ($groups as $dept => $rows) {
            $out[] = ['department' => $dept, 'leaves' => $rows];
        }
        return ['month' => $month, 'from' => $from, 'to' => $to, 'scope' => $scope, 'statuses' => $statuses,
                'departments' => $out, 'per_day' => $perDay];
    }

    // ── Attachments ──────────────────────────────────────────

    /** Store a $_FILES entry (multipart field "file"). */
    public function attachUpload(array $l, array $p, array $file): array
    {
        if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file((string) ($file['tmp_name'] ?? ''))) {
            throw new InvalidArgumentException('Upload failed or no file was sent (field name "file").');
        }
        return $this->attachBytes($l, $p, (string) file_get_contents($file['tmp_name']), (string) ($file['name'] ?? 'file'));
    }

    /** Store attachment bytes (images → WebP under storage/leaves/{id}/; PDFs as-is). */
    public function attachBytes(array $l, array $p, string $bytes, string $name): array
    {
        if (!self::isOwner($l, $p)) {
            throw new LeaveForbiddenException('Only the requester can attach files to this request.');
        }
        if (!in_array($l['status'], ['draft', 'pending', 'approved'], true)) {
            throw new DomainException('Files cannot be added to a ' . $l['status'] . ' request.');
        }
        $size = strlen($bytes);
        if ($size <= 0 || $size > self::MAX_UPLOAD) {
            throw new InvalidArgumentException('Files must be between 1 byte and 10 MB.');
        }
        $n = $this->pdo->prepare('SELECT COUNT(*) FROM leave_attachments WHERE leave_id = :id');
        $n->execute(['id' => $l['id']]);
        if ((int) $n->fetchColumn() >= self::MAX_ATTACHMENTS) {
            throw new DomainException('A request can carry at most ' . self::MAX_ATTACHMENTS . ' files.');
        }
        $mime = (string) (new finfo(FILEINFO_MIME_TYPE))->buffer($bytes);
        if (!isset(self::UPLOAD_MIME[$mime])) {
            throw new InvalidArgumentException('Only photos (JPG, PNG, WEBP) or PDF documents are accepted.');
        }
        $name = mb_substr(preg_replace('/[^\w.\- ]+/u', '_', basename($name)) ?: 'file', 0, 120);
        $dir  = $this->storageDir . '/leaves/' . (int) $l['id'];
        $rand = bin2hex(random_bytes(8));
        if (str_starts_with($mime, 'image/')) {
            $res = ImageTool::toWebp($bytes, $dir . '/' . $rand . '.webp', 82, 2400);
            if (!$res) {
                throw new InvalidArgumentException('The image could not be read.');
            }
            $path = $res['path'];
            $mime = 'image/webp';
            $name = preg_replace('/\.[a-z0-9]+$/i', '', $name) . '.webp';
        } else {
            if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
                throw new RuntimeException('Could not create the attachment folder.');
            }
            $path = $dir . '/' . $rand . '.' . self::UPLOAD_MIME[$mime];
            if (file_put_contents($path, $bytes, LOCK_EX) === false) {
                throw new RuntimeException('Could not store the file.');
            }
        }
        $row = [
            'leave_id' => (int) $l['id'], 'filename' => $name, 'stored_path' => ltrim(substr($path, strlen($this->storageDir)), '/'),
            'mime' => $mime, 'size_bytes' => (int) filesize($path), 'sha256' => hash_file('sha256', $path),
            'uploaded_by' => (int) $p['id'], 'created_at' => date('Y-m-d H:i:s'),
        ];
        $cols = array_keys($row);
        $this->pdo->prepare('INSERT INTO leave_attachments (' . implode(',', $cols) . ') VALUES (:' . implode(',:', $cols) . ')')->execute($row);
        $aid = (int) $this->pdo->lastInsertId();
        $this->update((int) $l['id'], ['updated_at' => $row['created_at']]);
        return ['id' => $aid, 'filename' => $name, 'mime' => $mime, 'size' => $row['size_bytes'],
                'url' => '/api/leaves/' . (int) $l['id'] . '/attachments/' . $aid];
    }

    public function attachment(int $leaveId, int $attId): ?array
    {
        $st = $this->pdo->prepare('SELECT * FROM leave_attachments WHERE id = :a AND leave_id = :l');
        $st->execute(['a' => $attId, 'l' => $leaveId]);
        return $st->fetch() ?: null;
    }

    /** Absolute path of an attachment (guarded to stay inside storage/). */
    public function attachmentPath(array $a): ?string
    {
        $path = realpath($this->storageDir . '/' . ltrim((string) $a['stored_path'], '/'));
        $root = realpath($this->storageDir);
        return ($path && $root && str_starts_with($path, $root . '/') && is_file($path)) ? $path : null;
    }

    // ── Helpers ──────────────────────────────────────────────

    /** In-app notification + its optional e-mail mirror to the same users (NotifyMail never throws). */
    private function notify(array $userIds, string $kind, string $title, string $body = '', ?string $link = null,
                            ?string $refType = null, ?int $refId = null): void
    {
        Notifications::emit($this->pdo, $userIds, $kind, $title, $body, $link, $refType, $refId);
        require_once __DIR__ . '/NotifyMail.php';
        NotifyMail::mirror($this->pdo, $userIds, $kind, $title, $body, $link);
    }

    /** Active users who may decide $l (supervisors in scope + admins), minus the requester. */
    public function approverIds(array $l): array
    {
        $roles = Auth::roles();
        $ids   = [];
        foreach ($this->pdo->query('SELECT * FROM users WHERE active = 1')->fetchAll() as $u) {
            if ((int) $u['id'] === (int) $l['user_id']) {
                continue;
            }
            $role  = (string) ($u['role'] ?: 'operator');
            $perms = $roles[$role]['perms'] ?? ($role === 'superadmin' ? Auth::DEFAULT_ROLES['admin']['perms'] : Auth::permsFor($role));
            $tier  = AiGuard::tierOf($role, $perms);
            if ($tier === 'admin') {
                $ids[] = (int) $u['id'];
            } elseif ($tier === 'supervisor') {
                $dept = $this->departmentOf($u);
                if ($dept === '' || $dept === (string) ($l['department'] ?? '')) {
                    $ids[] = (int) $u['id'];
                }
            }
        }
        return $ids;
    }

    /** @var array<int, array{person_id:?string, staff_id:?string}> */
    private array $empLinks = [];

    /**
     * Employee link of a leave's requester, resolved live with the AiGuard rule:
     * users.person_id, else the profile whose staff_id equals the login name;
     * the person_id stamped on the leave at create time is the last fallback.
     * @return array{person_id:?string, staff_id:?string}
     */
    public function employeeOf(int $userId, ?string $stored = null): array
    {
        if (!isset($this->empLinks[$userId])) {
            $link = ['person_id' => null, 'staff_id' => null];
            try {
                $st = $this->pdo->prepare('SELECT username, person_id FROM users WHERE id = :id LIMIT 1');
                $st->execute(['id' => $userId]);
                $u = $st->fetch();
                if ($u) {
                    $pid = trim((string) ($u['person_id'] ?? ''));
                    $st  = $pid !== ''
                        ? $this->pdo->prepare('SELECT person_id, staff_id FROM person_profiles WHERE person_id = :v LIMIT 1')
                        : $this->pdo->prepare('SELECT person_id, staff_id FROM person_profiles WHERE staff_id = :v LIMIT 1');
                    $st->execute(['v' => $pid !== '' ? $pid : (string) $u['username']]);
                    $prof = $st->fetch();
                    $link['person_id'] = $prof ? (string) $prof['person_id'] : ($pid !== '' ? $pid : null);
                    $link['staff_id']  = $prof && (string) ($prof['staff_id'] ?? '') !== '' ? (string) $prof['staff_id'] : null;
                }
            } catch (Throwable $e) {
                // keep the empty link
            }
            $this->empLinks[$userId] = $link;
        }
        $out = $this->empLinks[$userId];
        if ($out['person_id'] === null && $stored !== null && trim($stored) !== '') {
            $out['person_id'] = trim($stored);
        }
        return $out;
    }

    /** Department of a users row via its linked person profile (same link rule as AiGuard). */
    private function departmentOf(array $u): string
    {
        try {
            $pid = trim((string) ($u['person_id'] ?? ''));
            $st  = $pid !== ''
                ? $this->pdo->prepare('SELECT department FROM person_profiles WHERE person_id = :v LIMIT 1')
                : $this->pdo->prepare('SELECT department FROM person_profiles WHERE staff_id = :v LIMIT 1');
            $st->execute(['v' => $pid !== '' ? $pid : (string) $u['username']]);
            return (string) ($st->fetchColumn() ?: '');
        } catch (Throwable $e) {
            return '';
        }
    }

    private function typeName(string $code): string
    {
        return $this->type($code)['name'] ?? $code;
    }

    private static function fmtDays(float $d): string
    {
        $s = rtrim(rtrim(number_format($d, 1, '.', ''), '0'), '.');
        return $s . ' day' . ($d == 1.0 ? '' : 's');
    }

    private static function fmtRange(array $l): string
    {
        $s = date('j M Y', strtotime((string) $l['start_date']));
        if ((int) $l['half_day'] === 1) {
            return $s . ' (' . strtoupper((string) $l['half_day_period']) . ')';
        }
        return $l['start_date'] === $l['end_date'] ? $s : $s . ' – ' . date('j M Y', strtotime((string) $l['end_date']));
    }

    private function update(int $id, array $set): void
    {
        $parts = [];
        foreach (array_keys($set) as $k) {
            $parts[] = $k . ' = :' . $k;
        }
        $set['__id'] = $id;
        $this->pdo->prepare('UPDATE leaves SET ' . implode(', ', $parts) . ' WHERE id = :__id')->execute($set);
    }
}
