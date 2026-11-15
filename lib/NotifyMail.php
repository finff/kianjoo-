<?php
/**
 * E-mail mirrors of in-app notifications: ITSM tickets (M7) + leave workflow (M6).
 *
 * Ticket events → recipients
 *   created            assignee (if any) · else active admin/supervisor users with the
 *                      `tickets` permission and an e-mail (max 10, actor excluded) · else
 *                      the alert list (config mail.to = MAIL_TO / Alert Rules mail_to)
 *   assigned           the new assignee — never on self-assignment
 *   resolved           the requester — if they have an e-mail and did not resolve it
 *   SLA breached       assignee + alert list, once per ticket per breach type
 *                      (tickets.response_breach_mailed / resolution_breach_mailed,
 *                      claimed by Tickets::sweepBreaches)
 * Leave events (Leaves.php) mirror the in-app notification to the same users.
 *
 * Rules: toggle escalation.tickets_email (storage/notify_settings.json, default ON)
 * gates everything; the global mail cooldown (mail.cooldown min, per event kind)
 * throttles ONLY the alert-list broadcast — direct assignee/requester/approver
 * mails are never throttled; recipients are de-duplicated case-insensitively.
 * Every public method is fire-and-forget: it never throws into the business action.
 */

declare(strict_types=1);

require_once __DIR__ . '/Mailer.php';
require_once __DIR__ . '/EmailTemplate.php';

final class NotifyMail
{
    public const DEFAULT_HOST = 'https://kianjoo.weststar-dev.com';
    public const MAX_FANOUT   = 10;

    private static ?array $cfg = null;
    /** @var callable|null fn(array $mailCfg): Mailer — test seam */
    private static $factory = null;

    // ── plumbing ─────────────────────────────────────────────

    public static function configure(?array $config): void
    {
        self::$cfg = $config;
    }

    public static function useMailerFactory(?callable $f): void
    {
        self::$factory = $f;
    }

    private static function config(): array
    {
        if (self::$cfg === null) {
            if (isset($GLOBALS['config']) && is_array($GLOBALS['config']) && isset($GLOBALS['config']['mail'])) {
                self::$cfg = $GLOBALS['config'];
            } else {
                if (!defined('APP_ROOT')) {
                    define('APP_ROOT', dirname(__DIR__));
                }
                $c = require dirname(__DIR__) . '/config/config.php';
                self::$cfg = is_array($c) ? $c : [];
            }
        }
        return self::$cfg;
    }

    public static function enabled(): bool
    {
        return (self::config()['escalation']['tickets_email'] ?? true) !== false;
    }

    private static function dir(): string
    {
        return rtrim((string) (self::config()['ai']['storage_dir'] ?? (dirname(__DIR__) . '/storage')), '/');
    }

    private static function host(): string
    {
        $u = rtrim((string) (self::config()['app']['url'] ?? ''), '/');
        return $u !== '' ? $u : self::DEFAULT_HOST;
    }

    private static function mailer(): Mailer
    {
        $mc = (array) (self::config()['mail'] ?? []);
        $mc['log'] ??= self::dir() . '/mail.log';
        return self::$factory ? (self::$factory)($mc) : new Mailer($mc);
    }

    /** Alert broadcast list (MAIL_TO / Alert Rules mail_to overlay). */
    private static function alertList(): array
    {
        return array_values((array) (self::config()['mail']['to'] ?? []));
    }

    /** @return array<int,string> id => e-mail for active users with a valid address */
    private static function emailsOf(PDO $pdo, array $ids): array
    {
        $ids = array_values(array_unique(array_filter(array_map('intval', $ids), static fn ($i) => $i > 0)));
        if (!$ids) {
            return [];
        }
        $st = $pdo->query('SELECT id, email FROM users WHERE active = 1 AND id IN (' . implode(',', $ids) . ')');
        $out = [];
        foreach ($st->fetchAll() as $u) {
            $e = trim((string) ($u['email'] ?? ''));
            if ($e !== '' && filter_var($e, FILTER_VALIDATE_EMAIL)) {
                $out[(int) $u['id']] = $e;
            }
        }
        return $out;
    }

    /** Ticket workers (supervisor/admin tier + `tickets` perm) with an e-mail, max 10. */
    public static function workerEmails(PDO $pdo, array $excludeIds = []): array
    {
        require_once __DIR__ . '/AiGuard.php';
        $roles = Auth::roles();
        $ex    = array_map('intval', $excludeIds);
        $out   = [];
        foreach ($pdo->query('SELECT id, role, email FROM users WHERE active = 1 ORDER BY id ASC')->fetchAll() as $u) {
            $e = trim((string) ($u['email'] ?? ''));
            if (in_array((int) $u['id'], $ex, true) || $e === '' || !filter_var($e, FILTER_VALIDATE_EMAIL)) {
                continue;
            }
            $role  = (string) ($u['role'] ?: 'operator');
            $perms = $roles[$role]['perms'] ?? ($role === 'superadmin' ? Auth::DEFAULT_ROLES['admin']['perms'] : Auth::permsFor($role));
            $tier  = AiGuard::tierOf($role, $perms);
            if ((AiGuard::TIER_RANK[$tier] ?? 0) >= AiGuard::TIER_RANK['supervisor'] && !empty($perms['tickets'])) {
                $out[] = $e;
                if (count($out) >= self::MAX_FANOUT) {
                    break;
                }
            }
        }
        return $out;
    }

    /**
     * Send one e-mail to direct + broadcast recipients (deduped). The broadcast
     * part is dropped while the per-kind cooldown gate is active.
     * @return array{sent:bool, to:string[], throttled:bool, reason:string}
     */
    private static function dispatch(string $kind, string $ref, string $subject, string $html, array $direct, array $broadcast = []): array
    {
        $seen = [];
        $norm = static function (array $list) use (&$seen): array {
            $out = [];
            foreach ($list as $e) {
                $e = trim((string) $e);
                $k = strtolower($e);
                if ($e !== '' && !isset($seen[$k]) && filter_var($e, FILTER_VALIDATE_EMAIL)) {
                    $seen[$k] = true;
                    $out[] = $e;
                }
            }
            return $out;
        };
        $direct    = $norm($direct);
        $broadcast = $norm($broadcast);
        $throttled = false;
        if ($broadcast) {
            $gate = self::dir() . '/notifymail_' . preg_replace('/[^a-z0-9_]+/i', '_', $kind) . '.lock';
            $cool = max(1, (int) (self::config()['mail']['cooldown'] ?? 5)) * 60;
            if (is_file($gate) && (time() - (int) @filemtime($gate)) < $cool) {
                $broadcast = [];
                $throttled = true;
            } else {
                @touch($gate);
            }
        }
        $to = array_merge($direct, $broadcast);
        if (!$to) {
            return ['sent' => false, 'to' => [], 'throttled' => $throttled, 'reason' => $throttled ? 'throttled' : 'no recipients'];
        }
        $m  = self::mailer();
        if (!$m->enabled()) {
            return ['sent' => false, 'to' => $to, 'throttled' => $throttled, 'reason' => 'disabled'];
        }
        $ok = $m->send($subject, $html, $to);
        try {
            require_once __DIR__ . '/Alerting.php';
            Alerting::logSend('email', $ok, $kind, $ref, implode(',', $to) . ($ok ? '' : ' · ' . $m->lastError), false, self::dir());
        } catch (Throwable $e) {
        }
        return ['sent' => $ok, 'to' => $to, 'throttled' => $throttled, 'reason' => $ok ? '' : $m->lastError];
    }

    private static function guard(callable $fn): ?array
    {
        try {
            return self::enabled() ? $fn() : null;
        } catch (Throwable $e) {
            error_log('[notifymail] ' . $e->getMessage());
            return null;
        }
    }

    // ── tickets ──────────────────────────────────────────────

    /** @param array|null $actor principal who created it (null = pipeline) */
    public static function ticketCreated(PDO $pdo, array $t, ?array $actor = null): ?array
    {
        return self::guard(static function () use ($pdo, $t, $actor) {
            $actorId = (int) ($actor['id'] ?? 0);
            $direct = $broadcast = [];
            if ((int) ($t['assignee_user_id'] ?? 0) > 0) {
                $direct = (int) $t['assignee_user_id'] === $actorId ? [] : array_values(self::emailsOf($pdo, [(int) $t['assignee_user_id']]));
            } else {
                $direct = self::workerEmails($pdo, $actorId > 0 ? [$actorId] : []);
                if (!$direct) {
                    $broadcast = self::alertList();
                }
            }
            $pc   = EmailTemplate::sevColor((string) $t['priority']);
            $lead = ($actor ? 'Raised by ' . $actor['name'] : 'Opened automatically by the VisionAI pipeline')
                . ((int) ($t['assignee_user_id'] ?? 0) > 0 ? ' and assigned to you.' : ' — not yet assigned. Please acknowledge it within the response SLA.');
            $html = self::ticketHtml($pdo, $t, 'NEW TICKET · ' . strtoupper((string) $t['priority']), $pc, 'New ticket: ' . $t['title'], $lead, true);
            return self::dispatch('ticket_created', (string) $t['ticket_no'],
                '[Kian Joo VisionAI] New ' . $t['priority'] . ' ticket ' . $t['ticket_no'] . ' — ' . $t['title'], $html, $direct, $broadcast);
        });
    }

    public static function ticketAssigned(PDO $pdo, array $t, int $assigneeId, array $actor): ?array
    {
        if ($assigneeId <= 0 || $assigneeId === (int) ($actor['id'] ?? 0)) {
            return null;                                         // self-assignment: no mail
        }
        return self::guard(static function () use ($pdo, $t, $assigneeId, $actor) {
            $html = self::ticketHtml($pdo, $t, 'TICKET ASSIGNED TO YOU', EmailTemplate::COLORS['brand'],
                'Ticket ' . $t['ticket_no'] . ' is now yours', $actor['name'] . ' assigned this ticket to you.', true);
            return self::dispatch('ticket_assigned', (string) $t['ticket_no'],
                '[Kian Joo VisionAI] Ticket ' . $t['ticket_no'] . ' assigned to you — ' . $t['title'], $html,
                array_values(self::emailsOf($pdo, [$assigneeId])));
        });
    }

    public static function ticketResolved(PDO $pdo, array $t, array $actor): ?array
    {
        $rid = (int) ($t['requester_user_id'] ?? 0);
        if ($rid <= 0 || $rid === (int) ($actor['id'] ?? 0)) {
            return null;                                         // no requester, or they resolved it themselves
        }
        return self::guard(static function () use ($pdo, $t, $actor, $rid) {
            $html = self::ticketHtml($pdo, $t, 'TICKET RESOLVED', EmailTemplate::COLORS['ok'],
                'Your ticket ' . $t['ticket_no'] . ' was resolved', 'Resolved by ' . $actor['name']
                . '. If the issue is fixed, confirm-close it from the ticket; otherwise reply to reopen the conversation.', false);
            return self::dispatch('ticket_resolved', (string) $t['ticket_no'],
                '[Kian Joo VisionAI] Resolved: ' . $t['ticket_no'] . ' — ' . $t['title'], $html,
                array_values(self::emailsOf($pdo, [$rid])));
        });
    }

    /** @param string $type response|resolution */
    public static function ticketBreach(PDO $pdo, array $t, string $type): ?array
    {
        return self::guard(static function () use ($pdo, $t, $type) {
            $label = $type === 'response' ? 'First-response' : 'Resolution';
            $due   = (string) ($type === 'response' ? $t['response_due_at'] : $t['resolution_due_at']);
            $html  = self::ticketHtml($pdo, $t, 'SLA BREACHED · ' . strtoupper($label), EmailTemplate::COLORS['critical'],
                $label . ' SLA breached: ' . $t['ticket_no'],
                'The ' . strtolower($label) . ' target (' . $due . ') has passed and the ticket is still '
                . str_replace('_', ' ', (string) $t['status']) . '. Please act on it now.', true);
            $direct = (int) ($t['assignee_user_id'] ?? 0) > 0 ? array_values(self::emailsOf($pdo, [(int) $t['assignee_user_id']])) : [];
            $list   = self::alertList();
            if (!$direct && !$list) {
                $direct = self::workerEmails($pdo);              // unassigned + no alert list: the ticket desk still hears
            }
            return self::dispatch('ticket_breach', (string) $t['ticket_no'],
                '[Kian Joo VisionAI] SLA breached (' . strtolower($label) . ') — ' . $t['ticket_no'] . ' · ' . $t['title'], $html,
                $direct, $list);
        });
    }

    /** Official ticket e-mail body. $worker=false hides camera/detection internals. */
    private static function ticketHtml(PDO $pdo, array $t, string $banner, string $color, string $heading, string $lead, bool $worker): string
    {
        if ((string) (self::config()['app']['url'] ?? '') === '') {
            EmailTemplate::setHost(self::DEFAULT_HOST);         // logo + links never point at a legacy host
        }
        $host = self::host();
        $link = $host . '/#tickets&modal=ticket:' . rawurlencode((string) $t['ticket_no']);
        $pc   = EmailTemplate::sevColor((string) $t['priority']);
        $st   = strtoupper(str_replace('_', ' ', (string) $t['status']));
        $proof = null;
        if ($worker) {
            $q = $pdo->prepare("SELECT id FROM ticket_attachments WHERE ticket_id = :t AND kind = 'proof' ORDER BY id ASC LIMIT 1");
            $q->execute(['t' => (int) $t['id']]);
            $aid = (int) ($q->fetchColumn() ?: 0);
            $proof = $aid > 0 ? $host . '/api/tickets/' . (int) $t['id'] . '/attachments/' . $aid : null;
        }
        $content = EmailTemplate::heading($heading, $color)
            . EmailTemplate::sub((string) $t['title'])
            . '<div style="margin:0 0 16px;">' . EmailTemplate::chip((string) $t['priority'], $pc) . ' '
            . EmailTemplate::chip($st, EmailTemplate::COLORS['neutral']) . '</div>'
            . EmailTemplate::p(htmlspecialchars($lead, ENT_QUOTES, 'UTF-8'))
            . EmailTemplate::rows([
                ['Ticket no.', (string) $t['ticket_no']],
                ['Priority', strtoupper((string) $t['priority']), $pc],
                ['Status', $st],
                ['Category', str_replace('_', ' ', (string) ($t['category'] ?? 'general'))],
                $worker && !empty($t['camera']) ? ['Camera', (string) $t['camera']] : null,
                ['Location', (string) ($t['location'] ?: '—')],
                ['Response due', (string) ($t['response_due_at'] ?: '—'), !empty($t['response_breached']) ? EmailTemplate::COLORS['critical'] : '#1A2033'],
                ['Resolution due', (string) ($t['resolution_due_at'] ?: '—'), !empty($t['resolution_breached']) ? EmailTemplate::COLORS['critical'] : '#1A2033'],
                ['Requester', (string) ($t['requester_name'] ?: '—')],
                ['Assignee', (string) ($t['assignee_name'] ?: 'Unassigned')],
            ])
            . (!empty($t['closing_remarks']) && in_array($t['status'], ['resolved', 'closed'], true)
                ? EmailTemplate::note((string) $t['closing_remarks'], 'CLOSING REMARKS') : '')
            . EmailTemplate::buttons(array_values(array_filter([
                ['Open ticket ' . $t['ticket_no'], $link, true, $color],
                $proof ? ['View detection proof', $proof, false, $color] : null,
            ])));
        return EmailTemplate::shell($heading . ' — ' . $t['title'], $banner, $color, $content,
            'Sent by the Kian Joo VisionAI ticket desk. Sign in to view the full thread, attachments and SLA timers. '
            . 'Ticket e-mails can be switched off under <b>Settings &rsaquo; Tickets &amp; SLA</b>.');
    }

    // ── generic mirror (leave workflow) ──────────────────────

    private const MIRROR_STYLE = [
        'leave_submitted' => ['LEAVE REQUEST · ACTION NEEDED', 'high', 'Review request'],
        'leave_approved'  => ['LEAVE APPROVED', 'ok', 'View leave'],
        'leave_rejected'  => ['LEAVE REJECTED', 'critical', 'View leave'],
    ];

    /**
     * E-mail copy of an in-app notification to the same users (max 10, direct,
     * never throttled). $link is the SPA hash link the notification carries.
     */
    public static function mirror(PDO $pdo, array $userIds, string $kind, string $title, string $body = '', ?string $link = null): ?array
    {
        return self::guard(static function () use ($pdo, $userIds, $kind, $title, $body, $link) {
            [$banner, $col, $cta] = self::MIRROR_STYLE[$kind] ?? [strtoupper(str_replace('_', ' ', $kind)), 'brand', 'Open in VisionAI'];
            $color = EmailTemplate::COLORS[$col] ?? EmailTemplate::COLORS['brand'];
            if ((string) (self::config()['app']['url'] ?? '') === '') {
                EmailTemplate::setHost(self::DEFAULT_HOST);
            }
            $url = self::host() . '/' . ltrim((string) ($link ?? ''), '/');
            $content = EmailTemplate::heading($title, $color)
                . ($body !== '' ? EmailTemplate::p(htmlspecialchars($body, ENT_QUOTES, 'UTF-8')) : '')
                . EmailTemplate::buttons([[$cta, $url, true, $color]]);
            $html = EmailTemplate::shell($title, $banner, $color, $content,
                'Copy of your in-app notification from Kian Joo VisionAI. Sign in to see the full details.');
            $to = array_slice(array_values(self::emailsOf($pdo, $userIds)), 0, self::MAX_FANOUT);
            return self::dispatch($kind, '', '[Kian Joo VisionAI] ' . $title, $html, $to);
        });
    }
}
