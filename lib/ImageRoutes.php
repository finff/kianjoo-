<?php
/**
 * On-demand image enhancement for the proof viewer, included from
 * api/index.php inside its try {} (shares $route, $seg, $method, $config).
 * Lives in lib/ so it is never directly web-reachable.
 *
 *   GET /image/enhance?src=<ref>[&upscale=1&b=&c=&s=&auto=0][&meta=1][&download=1]   [supervisor+; staff → 404]
 *
 * USER-INITIATED ONLY: the viewer calls this when someone clicks "Enhance"
 * (and again when they move a slider). Nothing else — pipeline, page loads,
 * list rendering — calls it, and it never does background / batch work: one
 * request enhances exactly one image, synchronously, and caches the result.
 *
 * `src` is a REFERENCE, never a filesystem path chosen by the client:
 *   event:<id|uuid>[:bk|trigger|match]   stored image field of that event          [supervisor+ + view]
 *   url:<image url>                      an image URL that equals a stored event image field
 *                                        (looked up in recent events; the URL itself is never fetched) [supervisor+ + view]
 *   att:<ticket_id>:<attachment_id>      ticket image attachment the caller may view
 *   att:<attachment_id>                  (Tickets::canView + attachmentVisible)
 *   proofs/YYYY/MM/<file>.webp           (or storage/proofs/…) — strict charset, no
 *                                        "..", realpath must stay inside storage/proofs [ticket worker]
 * Anything unresolvable, hidden or malformed answers 404 (no existence oracle).
 *
 * Params: upscale (2x, capped at 4000 px wide), b brightness −50…50, c contrast
 * −50…50, s sharpen 0…100, auto (default 1 = auto-contrast). Defaults suit dim
 * CCTV frames. meta=1 → JSON {orig:{w,h,bytes}, enhanced:{w,h,bytes}, engine,
 * cached}; otherwise the image bytes (private, 1-year immutable cache — the URL
 * carries every input). download=1 adds Content-Disposition: attachment.
 */

declare(strict_types=1);

if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

if (($seg[0] ?? '') !== 'image') {
    return;   // not ours — fall through to the rest of api/index.php
}

require_once APP_ROOT . '/lib/AiGuard.php';
require_once APP_ROOT . '/lib/Tickets.php';
require_once APP_ROOT . '/lib/ImageTool.php';
require_once APP_ROOT . '/lib/Upstream.php';

$imPdo = Database::connect($config['storage']);
$imP   = AiGuard::require($imPdo);          // session only — the read token grants nothing here
$im404 = static function (): void {
    Response::error('Not found.', 404);
};
if ((int) $imP['id'] <= 0 || !AiGuard::atLeast($imP, 'supervisor')) {
    $im404();   // staff never learn the route exists
}
if (($seg[1] ?? '') !== 'enhance' || isset($seg[2])) {
    $im404();
}
if ($method !== 'GET') {
    Response::error('Use GET.', 405);
}

$imStore = rtrim((string) ($config['ai']['storage_dir'] ?? APP_ROOT . '/storage'), '/');
$imCache = $imStore . '/thumbs/enhanced';
$imRef   = (string) ($_GET['src'] ?? '');
if ($imRef === '' || strlen($imRef) > 2048 || preg_match('/[\x00-\x20\x7f]/', $imRef)) {   // no control chars / whitespace at all
    $im404();
}

/** Local copy of an event's stored image value (remote frames cached under src/). */
$imEventFile = static function (string $stored) use ($config, $imPdo, $imCache): ?string {
    $stored = trim($stored);
    if ($stored === '') {
        return null;
    }
    $dir = $imCache . '/src';
    $key = sha1($stored);
    foreach (['jpg', 'png', 'webp', 'gif', 'bmp'] as $e) {
        if (is_file($dir . '/' . $key . '.' . $e) && filesize($dir . '/' . $key . '.' . $e) > 0) {
            return $dir . '/' . $key . '.' . $e;
        }
    }
    $img = ImageTool::fetch((new EventStore($imPdo, $config))->fullUrl($stored), APP_ROOT);
    if ($img === null) {
        return null;
    }
    $ext = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp', 'image/gif' => 'gif', 'image/bmp' => 'bmp'][$img['mime']] ?? null;
    if ($ext === null || (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir))) {
        return null;
    }
    $file = $dir . '/' . $key . '.' . $ext;
    $tmp  = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (@file_put_contents($tmp, $img['bytes']) === false || !@rename($tmp, $file)) {
        @unlink($tmp);
        return null;
    }
    return $file;
};

$imCols = ['bk' => 'bk_image_url', 'trigger' => 'trigger_img_url', 'match' => 'match_image_url'];

/** Resolve the reference to an absolute local image path, or null. */
$imResolve = static function (string $ref) use ($imP, $imPdo, $imStore, $imCols, $imEventFile, $config): ?string {
    // (a) event id / uuid → its stored image fields
    if (preg_match('/^event:([A-Za-z0-9_-]{1,191})(?::(bk|trigger|match))?$/', $ref, $m)) {
        if (!AiGuard::can($imP, 'view')) {
            return null;
        }
        $sql = ctype_digit($m[1])
            ? 'SELECT trigger_img_url, bk_image_url, match_image_url FROM events WHERE id = :v OR uuid = :u ORDER BY id DESC LIMIT 1'
            : 'SELECT trigger_img_url, bk_image_url, match_image_url FROM events WHERE uuid = :u ORDER BY id DESC LIMIT 1';
        $st = $imPdo->prepare($sql);
        $st->execute(ctype_digit($m[1]) ? ['v' => (int) $m[1], 'u' => $m[1]] : ['u' => $m[1]]);
        $row = $st->fetch();
        if (!$row) {
            return null;
        }
        $order = isset($m[2]) ? [$m[2]] : ['bk', 'trigger'];
        foreach ($order as $f) {
            $file = $imEventFile((string) ($row[$imCols[$f]] ?? ''));
            if ($file !== null) {
                return $file;
            }
        }
        return null;
    }

    // (a') an image URL the viewer already shows → must equal a stored event field
    if (str_starts_with($ref, 'url:')) {
        if (!AiGuard::can($imP, 'view')) {
            return null;
        }
        $url  = substr($ref, 4);
        $path = (string) (parse_url($url, PHP_URL_PATH) ?? '');
        $base = rtrim((string) ($config['images']['base'] ?? ''), '/');
        $cand = array_values(array_unique(array_filter([
            $url,
            $base !== '' && str_starts_with($url, $base . '/') ? substr($url, strlen($base)) : '',
            $base !== '' && str_starts_with($url, $base . '/') ? ltrim(substr($url, strlen($base)), '/') : '',
            preg_match('#^/?uploads/#', $path) ? ltrim($path, '/') : '',
            preg_match('#^/?uploads/#', $path) ? '/' . ltrim($path, '/') : '',
        ], static fn ($v) => $v !== '')));
        if (!$cand) {
            return null;
        }
        $maxId = (int) $imPdo->query('SELECT MAX(id) FROM events')->fetchColumn();
        $in    = implode(',', array_fill(0, count($cand), '?'));
        $st    = $imPdo->prepare('SELECT trigger_img_url, bk_image_url, match_image_url FROM events WHERE id > ? AND ('
            . "trigger_img_url IN ($in) OR bk_image_url IN ($in) OR match_image_url IN ($in)) ORDER BY id DESC LIMIT 1");
        $st->execute(array_merge([$maxId - 200000], $cand, $cand, $cand));
        $row = $st->fetch();
        if (!$row) {
            return null;
        }
        foreach ($imCols as $col) {
            if (in_array((string) ($row[$col] ?? ''), $cand, true)) {
                return $imEventFile((string) $row[$col]);   // fetch the STORED value, never the client URL
            }
        }
        return null;
    }

    // (b) ticket attachment the caller may view
    if (preg_match('/^att:(\d{1,12})(?::(\d{1,12}))?$/', $ref, $m)) {
        $tk = new Tickets($imPdo, $imStore);
        if (isset($m[2])) {
            [$tid, $aid] = [(int) $m[1], (int) $m[2]];
        } else {
            $aid = (int) $m[1];
            $st  = $imPdo->prepare('SELECT ticket_id FROM ticket_attachments WHERE id = :a');
            $st->execute(['a' => $aid]);
            $tid = (int) ($st->fetchColumn() ?: 0);
        }
        $t = $tid > 0 ? $tk->find($tid) : null;
        if (!$t || !Tickets::canView($t, $imP)) {
            return null;
        }
        $a = $tk->attachment((int) $t['id'], $aid);
        if (!$a || !$tk->attachmentVisible($a, $imP) || !str_starts_with((string) $a['mime'], 'image/')) {
            return null;
        }
        return $tk->attachmentPath($a);
    }

    // (c) storage/proofs/… relative path (ticket workers only — proofs are worker-only)
    if (preg_match('#^(?:storage/)?(proofs/(?:[A-Za-z0-9_-][A-Za-z0-9._-]{0,120}/){0,6}[A-Za-z0-9_-][A-Za-z0-9._-]{0,160}\.(?:webp|jpe?g|png))$#', $ref, $m)) {
        if (str_contains($m[1], '..') || !Tickets::isWorker($imP)) {
            return null;
        }
        $root = realpath($imStore . '/proofs');
        $path = realpath($imStore . '/' . $m[1]);
        if ($root === false || $path === false || !str_starts_with($path, $root . '/') || !is_file($path)) {
            return null;
        }
        return $path;
    }
    return null;   // absolute paths, traversal, other dirs, schemes …
};

$imSrc = $imResolve($imRef);
if ($imSrc === null) {
    $im404();
}

// Light global cap (cache hits included) — protects the shared host's CPU.
if (!Upstream::allow('image_enhance', $imStore, 120)) {
    header('Retry-After: 30');
    Response::error('Too many enhance requests — try again shortly.', 429);
}

$imOpts = ImageTool::enhanceOpts([
    'upscale'    => $_GET['upscale'] ?? null,
    'brightness' => $_GET['b'] ?? null,
    'contrast'   => $_GET['c'] ?? null,
    'sharpen'    => $_GET['s'] ?? null,
    'auto'       => $_GET['auto'] ?? null,
]) + ['cache_dir' => $imCache];
if (!empty($config['images']['enhance_engine'])) {
    $imOpts['engine'] = (string) $config['images']['enhance_engine'];   // 'imagick' | 'gd' (ops override)
}

@set_time_limit(60);
// One render at a time per host (renders are CPU/memory heavy; hits are instant).
if (!is_dir($imCache)) {
    @mkdir($imCache, 0775, true);
}
$imLock = @fopen($imCache . '/.render.lock', 'c');
if ($imLock) {
    flock($imLock, LOCK_EX);
}
try {
    $imOut = ImageTool::enhance($imSrc, $imOpts);
} catch (RuntimeException $e) {
    Response::error($e->getMessage(), 422);
} finally {
    if ($imLock) {
        flock($imLock, LOCK_UN);
        fclose($imLock);
    }
}

$imInfo = ImageTool::enhanceInfo($imOut) ?? [];
if (!empty($_GET['meta'])) {
    header('Cache-Control: private, no-store');
    Response::ok([
        'orig'     => $imInfo['orig'] ?? null,
        'enhanced' => $imInfo['enhanced'] ?? null,
        'engine'   => ImageTool::$lastEngine ?? ($imInfo['engine'] ?? null),
        'cached'   => ImageTool::$lastCacheHit,
        'opts'     => $imInfo['opts'] ?? null,
    ]);
}

$imMime = str_ends_with($imOut, '.webp') ? 'image/webp' : 'image/jpeg';
$imEtag = '"' . basename($imOut, str_ends_with($imOut, '.webp') ? '.webp' : '.jpg') . '"';
header('Cache-Control: private, max-age=31536000, immutable');
header('ETag: ' . $imEtag);
header('X-Content-Type-Options: nosniff');
if (trim((string) ($_SERVER['HTTP_IF_NONE_MATCH'] ?? '')) === $imEtag) {
    http_response_code(304);
    exit;
}
if (!empty($_GET['download'])) {
    $name = 'enhanced-' . substr(preg_replace('/[^A-Za-z0-9_-]+/', '-', $imRef) ?? 'image', 0, 60) . '.' . ($imMime === 'image/webp' ? 'webp' : 'jpg');
    header('Content-Disposition: attachment; filename="' . $name . '"');
} else {
    header('Content-Disposition: inline');
}
http_response_code(200);
header('Content-Type: ' . $imMime);
header('Content-Length: ' . filesize($imOut));
readfile($imOut);
exit;
