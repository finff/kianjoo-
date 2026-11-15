<?php
/**
 * Minimal in-app notifications (M6). One row per recipient user.
 *
 * Emitters (Leaves, Tickets) call Notifications::emit(), which never throws:
 * a notification failure must never break the business action that caused it.
 *
 * `link` is a suggested SPA deep link (`#page&modal=type:id`, see
 * FRONTEND_FOUNDATIONS); `ref_type` + `ref_id` are the stable reference the UI
 * should prefer.
 */

declare(strict_types=1);

final class Notifications
{
    public function __construct(private PDO $pdo)
    {
    }

    /** Create one notification per recipient; returns ids. Throws on DB errors. */
    public function create(array $userIds, string $kind, string $title, string $body = '', ?string $link = null,
                           ?string $refType = null, ?int $refId = null): array
    {
        $ids = [];
        $st  = $this->pdo->prepare('INSERT INTO notifications (user_id, kind, title, body, link, ref_type, ref_id, read_at, created_at)
                                    VALUES (:u, :k, :t, :b, :l, :rt, :ri, NULL, :c)');
        foreach (array_unique(array_filter(array_map('intval', $userIds), static fn ($i) => $i > 0)) as $uid) {
            $st->execute([
                'u' => $uid, 'k' => mb_substr($kind, 0, 40), 't' => mb_substr($title, 0, 200), 'b' => mb_substr($body, 0, 1000),
                'l' => $link !== null ? mb_substr($link, 0, 255) : null, 'rt' => $refType, 'ri' => $refId,
                'c' => date('Y-m-d H:i:s'),
            ]);
            $ids[] = (int) $this->pdo->lastInsertId();
        }
        return $ids;
    }

    /** Fire-and-forget variant for emitters. */
    public static function emit(PDO $pdo, array $userIds, string $kind, string $title, string $body = '', ?string $link = null,
                                ?string $refType = null, ?int $refId = null): int
    {
        try {
            return count((new self($pdo))->create($userIds, $kind, $title, $body, $link, $refType, $refId));
        } catch (Throwable $e) {
            error_log('[notifications] ' . $e->getMessage());
            return 0;
        }
    }

    public function unreadCount(int $userId): int
    {
        $st = $this->pdo->prepare('SELECT COUNT(*) FROM notifications WHERE user_id = :u AND read_at IS NULL');
        $st->execute(['u' => $userId]);
        return (int) $st->fetchColumn();
    }

    /** Newest first. $unreadOnly limits to unread. */
    public function list(int $userId, bool $unreadOnly = true, int $limit = 30, int $beforeId = 0): array
    {
        $limit = max(1, min(100, $limit));
        $sql   = 'SELECT * FROM notifications WHERE user_id = :u' . ($unreadOnly ? ' AND read_at IS NULL' : '')
               . ($beforeId > 0 ? ' AND id < :b' : '') . ' ORDER BY id DESC LIMIT ' . $limit;
        $args  = ['u' => $userId] + ($beforeId > 0 ? ['b' => $beforeId] : []);
        $st = $this->pdo->prepare($sql);
        $st->execute($args);
        return array_map(static fn ($n) => [
            'id' => (int) $n['id'], 'kind' => $n['kind'], 'title' => $n['title'], 'body' => $n['body'], 'link' => $n['link'],
            'ref_type' => $n['ref_type'], 'ref_id' => $n['ref_id'] !== null ? (int) $n['ref_id'] : null,
            'read' => $n['read_at'] !== null, 'read_at' => $n['read_at'], 'created_at' => $n['created_at'],
        ], $st->fetchAll());
    }

    /** Mark the given ids (only the user's own) — or all when $ids is null — as read. Returns rows changed. */
    public function markRead(int $userId, ?array $ids = null): int
    {
        $now = date('Y-m-d H:i:s');
        if ($ids === null) {
            $st = $this->pdo->prepare('UPDATE notifications SET read_at = :n WHERE user_id = :u AND read_at IS NULL');
            $st->execute(['n' => $now, 'u' => $userId]);
            return $st->rowCount();
        }
        $ids = array_slice(array_values(array_unique(array_filter(array_map('intval', $ids), static fn ($i) => $i > 0))), 0, 200);
        if (!$ids) {
            return 0;
        }
        $ph   = [];
        $args = ['n' => $now, 'u' => $userId];
        foreach ($ids as $i => $id) {
            $ph[] = ':i' . $i;
            $args['i' . $i] = $id;
        }
        $st = $this->pdo->prepare('UPDATE notifications SET read_at = :n WHERE user_id = :u AND read_at IS NULL AND id IN (' . implode(',', $ph) . ')');
        $st->execute($args);
        return $st->rowCount();
    }
}
