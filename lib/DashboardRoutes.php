<?php
/**
 * M3 widget-dashboard routes, included from api/index.php inside its try {}
 * (shares $route, $seg, $method, $config). Lives in lib/ so it is never directly
 * web-reachable. The caller is resolved server-side by AiGuard on every request
 * (session only — the dashboard read token grants nothing here, and the
 * provision token has no user to own a dashboard).
 *
 * Saved dashboards ("presets"): each login owns 1–12 named dashboards, each with
 * a widget layout + filters; exactly one is the default.
 *
 *   GET  /dashboard/list                               own dashboards (id, name, is_default, position, updated_at, layout, filters)
 *   GET  /dashboard/{id}                               one own dashboard
 *   POST /dashboard/create   {name, copy_from?}        new dashboard (empty, or a copy of own copy_from's layout + filters); cap 12
 *   POST /dashboard/{id}/save {widgets?, filters?, reset?}  save layout and/or filters (reset:true → widgets = role default)
 *   POST /dashboard/{id}/rename {name}
 *   POST /dashboard/{id}/delete                        not the last one; deleting the default promotes the next by position
 *   POST /dashboard/{id}/default                       make it the default
 *
 * Compatibility alias for older clients (operates on the DEFAULT dashboard):
 *   GET  /dashboard/layout                             {layout: {v, widgets} | null = role default}
 *   POST /dashboard/layout {widgets:[{id,size}]}       save the default dashboard's layout
 *   POST /dashboard/layout {reset:true}                default dashboard back to the role default
 *
 * Every {id} is looked up WITH the caller's user_id — someone else's id is a 404.
 * The first request of a login that has no dashboard yet creates "My dashboard"
 * (layout widgets = null → the client renders the role default).
 *
 * Only widget ids + sizes and whitelisted filters are stored. Which widgets a
 * user may actually see is decided by each widget's own data route (every widget
 * reads an RBAC-checked API), so a stored id never grants data access.
 */

declare(strict_types=1);

if (!defined('APP_ROOT')) {
    http_response_code(404);
    exit;
}

if (($seg[0] ?? '') !== 'dashboard') {
    return;   // not ours — fall through to the rest of api/index.php
}

require_once APP_ROOT . '/lib/AiGuard.php';
require_once APP_ROOT . '/lib/DashboardSchema.php';

$dbPdo = Database::connect($config['storage']);
$dbP   = AiGuard::require($dbPdo);
$dbUid = (int) $dbP['id'];
if ($dbUid <= 0) {
    Response::error('Sign in required.', 401);
}

$dbMax  = 12;
$dbA    = (string) ($seg[1] ?? '');
$dbB    = (string) ($seg[2] ?? '');
if (isset($seg[3])) {
    Response::error('Unknown dashboard action.', 404);
}

/* ── sanitisers ─────────────────────────────────────────────────────────── */

// Layout: known shape only, unique ids, allowed sizes, bounded.
$dbClean = static function ($in): array {
    $out  = [];
    $seen = [];
    foreach ((is_array($in) ? $in : []) as $w) {
        if (!is_array($w)) {
            continue;
        }
        $id   = (string) ($w['id'] ?? '');
        $size = (string) ($w['size'] ?? '');
        if (!preg_match('/^[a-z0-9][a-z0-9_-]{0,39}$/', $id) || isset($seen[$id])) {
            continue;
        }
        if (!in_array($size, ['1x1', '1x2', '1x3', '1x4'], true)) {
            $size = '1x1';
        }
        $seen[$id] = true;
        $out[]     = ['id' => $id, 'size' => $size];
        if (count($out) >= 40) {
            break;
        }
    }
    return $out;
};

// Filters whitelist: {range, from, to, plant, cams[], sev}. Anything else is dropped
// (a transient "historical moment" is session state on the client and never stored).
$dbFilters = static function ($in): array {
    $in    = is_array($in) ? $in : [];
    $range = in_array($in['range'] ?? '', ['auto', 'today', '7d', '30d', 'custom'], true) ? (string) $in['range'] : 'auto';
    $day   = static function ($v): ?string {
        $v = (string) $v;
        if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $v, $m) || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
            return null;
        }
        return $v;
    };
    $from = $to = null;
    if ($range === 'custom') {
        $from = $day($in['from'] ?? '');
        $to   = $day($in['to'] ?? '');
        if ($from === null || $to === null) {
            $range = 'auto';
            $from  = $to = null;
        } else {
            if ($from > $to) {
                [$from, $to] = [$to, $from];
            }
            if ((strtotime($to) - strtotime($from)) / 86400 > 366) {
                $from = date('Y-m-d', strtotime($to) - 366 * 86400);
            }
        }
    }
    $plant = preg_replace('/[\x00-\x1F\x7F<>]+/u', '', (string) ($in['plant'] ?? ''));
    $plant = mb_substr(trim((string) $plant), 0, 80);
    $cams  = [];
    foreach ((is_array($in['cams'] ?? null) ? $in['cams'] : []) as $c) {
        $c = (string) $c;
        if (preg_match('/^[A-Za-z0-9._:-]{1,64}$/', $c) && !in_array($c, $cams, true)) {
            $cams[] = $c;
        }
        if (count($cams) >= 24) {
            break;
        }
    }
    return ['range' => $range, 'from' => $from, 'to' => $to, 'plant' => $plant, 'cams' => $cams,
            'sev' => ($in['sev'] ?? '') === 'high' ? 'high' : 'all'];
};

// Name: printable, no markup, single-spaced, 1–60 chars.
$dbName = static function ($v): string {
    $v = preg_replace('/[\x00-\x1F\x7F<>]+/u', ' ', strip_tags((string) $v));
    $v = trim((string) preg_replace('/\s+/u', ' ', (string) $v));
    return mb_substr($v, 0, 60);
};

/* ── data helpers ───────────────────────────────────────────────────────── */

$dbRow = static function (array $r) use ($dbClean, $dbFilters): array {
    $l = json_decode((string) $r['layout'], true);
    $w = is_array($l) && is_array($l['widgets'] ?? null) ? $dbClean($l['widgets']) : null;
    return [
        'id'         => (int) $r['id'],
        'name'       => (string) $r['name'],
        'is_default' => (int) $r['is_default'] === 1,
        'position'   => (int) $r['position'],
        'updated_at' => $r['updated_at'] ?? null,
        'layout'     => ['v' => 1, 'widgets' => $w],
        'filters'    => $dbFilters(json_decode((string) ($r['filters'] ?? ''), true)),
    ];
};

$dbAll = static function () use ($dbPdo, $dbUid, $dbRow): array {
    $st = $dbPdo->prepare('SELECT * FROM user_dashboards WHERE user_id = :u ORDER BY position, id');
    $st->execute(['u' => $dbUid]);
    return array_map($dbRow, $st->fetchAll(PDO::FETCH_ASSOC));
};

// Exactly one default; a login with no dashboard gets "My dashboard" (role default layout).
$dbEnsure = static function () use ($dbPdo, $dbUid, $dbAll): array {
    $all = $dbAll();
    if (!$all) {
        try {
            $dbPdo->prepare('INSERT INTO user_dashboards (user_id, name, layout, filters, is_default, position, updated_at)
                             VALUES (:u, :n, :l, :f, 1, 0, :t)')
                  ->execute(['u' => $dbUid, 'n' => DashboardSchema::LEGACY_NAME, 'l' => '{"v":1,"widgets":null}', 'f' => '{}', 't' => date('Y-m-d H:i:s')]);
        } catch (Throwable $e) {
            // a parallel first request won the unique (user_id, name) race — fine
        }
        $all = $dbAll();
    }
    $defs = array_values(array_filter($all, static fn ($d) => $d['is_default']));
    if (count($defs) !== 1 && $all) {
        $keep = $defs ? $defs[0]['id'] : $all[0]['id'];
        $dbPdo->prepare('UPDATE user_dashboards SET is_default = CASE WHEN id = :i THEN 1 ELSE 0 END WHERE user_id = :u')
              ->execute(['i' => $keep, 'u' => $dbUid]);
        $all = $dbAll();
    }
    return $all;
};

$dbFind = static function (int $id) use ($dbPdo, $dbUid, $dbRow): array {
    $st = $dbPdo->prepare('SELECT * FROM user_dashboards WHERE id = :i AND user_id = :u LIMIT 1');
    $st->execute(['i' => $id, 'u' => $dbUid]);
    $r = $st->fetch(PDO::FETCH_ASSOC);
    if (!$r) {
        Response::error('Dashboard not found.', 404);
    }
    return $dbRow($r);
};

$dbDefault = static function () use ($dbEnsure): array {
    foreach ($dbEnsure() as $d) {
        if ($d['is_default']) {
            return $d;
        }
    }
    Response::error('No dashboard.', 500);
    return [];
};

$dbNameTaken = static function (string $name, int $exceptId = 0) use ($dbAll): bool {
    $k = mb_strtolower($name);
    foreach ($dbAll() as $d) {
        if ($d['id'] !== $exceptId && mb_strtolower($d['name']) === $k) {
            return true;
        }
    }
    return false;
};

$dbWrite = static function (int $id, array $set) use ($dbPdo, $dbUid): string {
    $now  = date('Y-m-d H:i:s');
    $cols = [];
    $args = ['i' => $id, 'u' => $dbUid, 't' => $now];
    foreach ($set as $k => $v) {
        $cols[]   = $k . ' = :' . $k;
        $args[$k] = $v;
    }
    $dbPdo->prepare('UPDATE user_dashboards SET ' . implode(', ', $cols) . ', updated_at = :t WHERE id = :i AND user_id = :u')->execute($args);
    return $now;
};

$dbBody = static function (): array {
    $in = json_decode(file_get_contents('php://input') ?: '', true);
    return is_array($in) ? $in : (is_array($_POST) ? $_POST : []);
};

/* ── compatibility alias: /dashboard/layout → the default dashboard ─────── */

if ($dbA === 'layout') {
    if ($dbB !== '') {
        Response::error('Unknown dashboard action.', 404);
    }
    $def = $dbDefault();
    if ($method === 'GET') {
        Response::ok([
            'layout'       => $def['layout']['widgets'] === null ? null : $def['layout'],
            'updated_at'   => $def['updated_at'],
            'dashboard_id' => $def['id'],
            'role'         => $dbP['role'],
            'tier'         => $dbP['tier'],
        ]);
    }
    if ($method !== 'POST') {
        Response::error('Use GET or POST.', 405);
    }
    $in = $dbBody();
    if (!empty($in['reset'])) {
        $dbWrite($def['id'], ['layout' => '{"v":1,"widgets":null}']);
        Response::ok(['layout' => null, 'updated_at' => null, 'dashboard_id' => $def['id']]);
    }
    if (!isset($in['widgets']) || !is_array($in['widgets'])) {
        Response::error('Send {widgets:[{id,size}]} or {reset:true}.', 422);
    }
    $w   = $dbClean($in['widgets']);
    $now = $dbWrite($def['id'], ['layout' => json_encode(['v' => 1, 'widgets' => $w], JSON_UNESCAPED_SLASHES)]);
    Response::ok(['layout' => ['v' => 1, 'widgets' => $w], 'updated_at' => $now, 'dashboard_id' => $def['id']]);
}

/* ── GET /dashboard/list ───────────────────────────────────────────────── */

if ($dbA === 'list') {
    if ($dbB !== '') {
        Response::error('Unknown dashboard action.', 404);
    }
    if ($method !== 'GET') {
        Response::error('Use GET.', 405);
    }
    Response::ok(['dashboards' => $dbEnsure(), 'max' => $dbMax, 'role' => $dbP['role'], 'tier' => $dbP['tier']]);
}

/* ── POST /dashboard/create ────────────────────────────────────────────── */

if ($dbA === 'create') {
    if ($dbB !== '') {
        Response::error('Unknown dashboard action.', 404);
    }
    if ($method !== 'POST') {
        Response::error('Use POST.', 405);
    }
    $in   = $dbBody();
    $all  = $dbEnsure();
    $name = $dbName($in['name'] ?? '');
    if ($name === '') {
        Response::error('Give the dashboard a name.', 422);
    }
    if (count($all) >= $dbMax) {
        Response::error('You can keep up to ' . $dbMax . ' dashboards — delete one first.', 409);
    }
    if ($dbNameTaken($name)) {
        Response::error('You already have a dashboard called "' . $name . '".', 409);
    }
    $layout  = '{"v":1,"widgets":[]}';
    $filters = '{}';
    if (isset($in['copy_from']) && $in['copy_from'] !== null && $in['copy_from'] !== '') {
        if (!ctype_digit((string) $in['copy_from'])) {
            Response::error('Dashboard not found.', 404);
        }
        $src     = $dbFind((int) $in['copy_from']);
        $layout  = json_encode($src['layout'], JSON_UNESCAPED_SLASHES);
        $filters = json_encode($src['filters'], JSON_UNESCAPED_SLASHES);
    }
    $pos = 0;
    foreach ($all as $d) {
        $pos = max($pos, $d['position'] + 1);
    }
    try {
        $dbPdo->prepare('INSERT INTO user_dashboards (user_id, name, layout, filters, is_default, position, updated_at)
                         VALUES (:u, :n, :l, :f, 0, :p, :t)')
              ->execute(['u' => $dbUid, 'n' => $name, 'l' => $layout, 'f' => $filters, 'p' => $pos, 't' => date('Y-m-d H:i:s')]);
    } catch (Throwable $e) {
        error_log('[dashboard] create: ' . $e->getMessage());
        Response::error('You already have a dashboard called "' . $name . '".', 409);
    }
    $newId = (int) $dbPdo->lastInsertId();
    Response::ok(['dashboard' => $dbFind($newId), 'dashboards' => $dbAll()]);
}

/* ── /dashboard/{id}[/action] ─────────────────────────────────────────── */

if (!ctype_digit($dbA) || (int) $dbA <= 0) {
    Response::error('Unknown dashboard action.', 404);
}
$dbId = (int) $dbA;
$dbEnsure();
$dbCur = $dbFind($dbId);   // 404 unless it is the caller's own

if ($dbB === '') {
    if ($method !== 'GET') {
        Response::error('Use GET.', 405);
    }
    Response::ok(['dashboard' => $dbCur]);
}
if ($method !== 'POST') {
    Response::error('Use POST.', 405);
}
$dbIn = $dbBody();

switch ($dbB) {
    case 'save':
        $set = [];
        if (!empty($dbIn['reset'])) {
            $set['layout'] = '{"v":1,"widgets":null}';
        } elseif (array_key_exists('widgets', $dbIn)) {
            if (!is_array($dbIn['widgets'])) {
                Response::error('widgets must be a list of {id,size}.', 422);
            }
            $set['layout'] = json_encode(['v' => 1, 'widgets' => $dbClean($dbIn['widgets'])], JSON_UNESCAPED_SLASHES);
        }
        if (array_key_exists('filters', $dbIn)) {
            if (!is_array($dbIn['filters'])) {
                Response::error('filters must be an object.', 422);
            }
            $set['filters'] = json_encode($dbFilters($dbIn['filters']), JSON_UNESCAPED_SLASHES);
        }
        if (!$set) {
            Response::error('Send {widgets}, {filters} or {reset:true}.', 422);
        }
        $dbWrite($dbId, $set);
        Response::ok(['dashboard' => $dbFind($dbId)]);

    case 'rename':
        $name = $dbName($dbIn['name'] ?? '');
        if ($name === '') {
            Response::error('Give the dashboard a name.', 422);
        }
        if ($dbNameTaken($name, $dbId)) {
            Response::error('You already have a dashboard called "' . $name . '".', 409);
        }
        try {
            $dbWrite($dbId, ['name' => $name]);
        } catch (Throwable $e) {
            Response::error('You already have a dashboard called "' . $name . '".', 409);
        }
        Response::ok(['dashboard' => $dbFind($dbId), 'dashboards' => $dbAll()]);

    case 'delete':
        $all = $dbAll();
        if (count($all) <= 1) {
            Response::error('This is your only dashboard — create another before deleting it.', 409);
        }
        $dbPdo->beginTransaction();
        try {
            $dbPdo->prepare('DELETE FROM user_dashboards WHERE id = :i AND user_id = :u')->execute(['i' => $dbId, 'u' => $dbUid]);
            if ($dbCur['is_default']) {
                foreach ($all as $d) {
                    if ($d['id'] !== $dbId) {
                        $dbPdo->prepare('UPDATE user_dashboards SET is_default = 1 WHERE id = :i AND user_id = :u')->execute(['i' => $d['id'], 'u' => $dbUid]);
                        break;
                    }
                }
            }
            $dbPdo->commit();
        } catch (Throwable $e) {
            $dbPdo->rollBack();
            error_log('[dashboard] delete: ' . $e->getMessage());
            Response::error('Could not delete the dashboard.', 500);
        }
        Response::ok(['deleted' => $dbId, 'dashboards' => $dbAll()]);

    case 'default':
        $dbPdo->prepare('UPDATE user_dashboards SET is_default = CASE WHEN id = :i THEN 1 ELSE 0 END WHERE user_id = :u')
              ->execute(['i' => $dbId, 'u' => $dbUid]);
        Response::ok(['dashboard' => $dbFind($dbId), 'dashboards' => $dbAll()]);
}

Response::error('Unknown dashboard action.', 404);
