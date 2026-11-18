<?php
/**
 * M14 — floor plans, camera pins and movement playback (backend).
 *
 *   plans      uploaded plan images (original + WebP display copy under
 *              uploads/floorplans/, served only through the API)
 *   pins       camera_id (= live stream label, validated against the real
 *              camera config) placed at x/y % of the plan image
 *   path       one person's detections in a time window, collapsed into
 *              ordered waypoints on the pins (see collapse())
 *   occupancy  distinct people / detections per pin over the last N minutes
 *   thumbs     waypoint snapshot → small cached WebP (storage/thumbs/movement/)
 *   live       pin → how the browser plays that camera (same order as app.js videoSrc)
 *
 * Validation problems throw InvalidArgumentException (route → 422); a missing
 * object returns null (route → 404).
 */

declare(strict_types=1);

require_once __DIR__ . '/EventStore.php';
require_once __DIR__ . '/ImageTool.php';
require_once __DIR__ . '/LiveBridge.php';
require_once __DIR__ . '/AiGuard.php';

final class Floorplans
{
    public const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
    public const ALLOWED_MIME     = ['image/png' => 'png', 'image/jpeg' => 'jpg', 'image/webp' => 'webp'];
    public const DEFAULT_GAP_MIN  = 5;
    private const MAX_PATH_ROWS   = 20000;
    private const THUMB_EDGE      = 360;
    private const THUMB_FAIL_TTL  = 600;   // don't re-fetch a broken snapshot for 10 min

    private PDO $pdo;
    private array $config;
    private string $appRoot;
    private ?array $catalog = null;
    private ?array $alias = null;

    public function __construct(PDO $pdo, array $config, string $appRoot)
    {
        $this->pdo     = $pdo;
        $this->config  = $config;
        $this->appRoot = rtrim($appRoot, '/');
    }

    private static function now(): string
    {
        return date('Y-m-d H:i:s');
    }

    // ── Camera catalog (the real camera config) ─────────────

    /**
     * Every camera a pin may link to: live streams (SenseStudio fleet +
     * manual RTSP/HLS sources, LiveBridge::desired) plus the POC camera-point
     * map. Keyed by lower-case stream label.
     *
     * @return array<string, array{id:string, name:string, location:string, origin:string, online:?bool, live:bool}>
     */
    public function cameraCatalog(): array
    {
        if ($this->catalog !== null) {
            return $this->catalog;
        }
        $out = [];
        try {
            $desired = LiveBridge::desired($this->config, LiveBridge::fleetRows($this->config, false));
        } catch (Throwable $e) {
            $desired = [];
        }
        $locs = $this->config['poc']['cam_locations'] ?? [];
        foreach ($desired as $name => $d) {
            $id = strtolower((string) $name);
            $out[$id] = [
                'id'       => $id,
                'name'     => (string) (($d['fleetName'] ?? '') ?: strtoupper($id)),
                'location' => (string) ($locs[$id] ?? ''),
                'origin'   => (string) ($d['origin'] ?? ''),
                'online'   => $d['online'] ?? null,
                'live'     => true,
            ];
        }
        foreach ($locs as $k => $loc) {
            $id = strtolower((string) $k);
            if ($id === '' || isset($out[$id])) {
                continue;
            }
            $out[$id] = ['id' => $id, 'name' => strtoupper($id), 'location' => (string) $loc,
                         'origin' => 'poc', 'online' => null, 'live' => false];
        }
        ksort($out);
        return $this->catalog = $out;
    }

    /** Normalised camera id if it exists in the camera config, else null. */
    public function validCamera(string $id): ?string
    {
        $id = strtolower(trim($id));
        return $id !== '' && isset($this->cameraCatalog()[$id]) ? $id : null;
    }

    // ── Plans ───────────────────────────────────────────────

    public function uploadDir(): string
    {
        $dir = $this->appRoot . '/uploads/floorplans';
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        // Plans are facility layouts: never served directly, only via the API.
        if (is_dir($dir) && !is_file($dir . '/.htaccess')) {
            @file_put_contents($dir . '/.htaccess', "Require all denied\n");
        }
        return $dir;
    }

    /** @return list<array> plans in display order, each with its pins. */
    public function list(bool $includeInactive = true, bool $redact = false): array
    {
        $sql  = 'SELECT * FROM floorplans' . ($includeInactive ? '' : ' WHERE active = 1') . ' ORDER BY sort_order ASC, id ASC';
        $rows = $this->pdo->query($sql)->fetchAll();
        $pins = $this->pinsByPlan();
        return array_map(fn ($r) => $this->shape($r, $pins[(int) $r['id']] ?? [], $redact), $rows);
    }

    public function get(int $id, bool $redact = false): ?array
    {
        $r = $this->row($id);
        if ($r === null) {
            return null;
        }
        return $this->shape($r, $this->pinsByPlan($id)[$id] ?? [], $redact);
    }

    private function row(int $id): ?array
    {
        $st = $this->pdo->prepare('SELECT * FROM floorplans WHERE id = :id');
        $st->execute(['id' => $id]);
        return $st->fetch() ?: null;
    }

    private function shape(array $r, array $pins, bool $redact): array
    {
        $id = (int) $r['id'];
        $v  = substr(md5((string) ($r['updated_at'] ?? '') . (string) ($r['display_path'] ?? '')), 0, 8);
        return [
            'id'         => $id,
            'name'       => (string) $r['name'],
            'sort_order' => (int) $r['sort_order'],
            'width_px'   => (int) $r['width_px'],
            'height_px'  => (int) $r['height_px'],
            'active'     => (int) $r['active'] === 1,
            'image_url'  => '/api/floorplans/' . $id . '/image?v=' . $v,
            'updated_at' => (string) ($r['updated_at'] ?? ''),
            'pins'       => array_map(fn ($p) => $this->pinShape($p, $redact), $pins),
        ];
    }

    /**
     * Validate an uploaded image (png / jpg / webp, ≤ 8 MB).
     * @return array{mime:string, ext:string, w:int, h:int}
     */
    public static function inspectUpload(string $bytes): array
    {
        if ($bytes === '') {
            throw new InvalidArgumentException('No image uploaded.');
        }
        if (strlen($bytes) > self::MAX_UPLOAD_BYTES) {
            throw new InvalidArgumentException('Floor plan image must be 8 MB or smaller.');
        }
        $info = @getimagesizefromstring($bytes);
        $mime = is_array($info) ? (string) ($info['mime'] ?? '') : '';
        if (!isset(self::ALLOWED_MIME[$mime])) {
            throw new InvalidArgumentException('Floor plan must be a PNG, JPG or WebP image.');
        }
        $w = (int) $info[0];
        $h = (int) $info[1];
        if ($w < 50 || $h < 50 || $w > 20000 || $h > 20000) {
            throw new InvalidArgumentException('Floor plan image size must be between 50 and 20000 px per side.');
        }
        return ['mime' => $mime, 'ext' => self::ALLOWED_MIME[$mime], 'w' => $w, 'h' => $h];
    }

    private static function cleanName(string $name): string
    {
        $name = trim(preg_replace('/\s+/', ' ', strip_tags($name)) ?? '');
        $name = mb_substr($name, 0, 120);
        if ($name === '') {
            throw new InvalidArgumentException('Floor plan name is required.');
        }
        return $name;
    }

    /** Store original + WebP display copy; returns [image_path, display_path] relative to app root. */
    private function storeImage(int $id, string $bytes, array $meta): array
    {
        $dir  = $this->uploadDir();
        $base = 'fp' . $id . '_' . bin2hex(random_bytes(6));
        $orig = $base . '_orig.' . $meta['ext'];
        if (@file_put_contents($dir . '/' . $orig, $bytes, LOCK_EX) === false) {
            throw new RuntimeException('Could not save the floor plan image.');
        }
        $disp = $base . '.webp';
        $w    = ImageTool::toWebp($bytes, $dir . '/' . $disp, 85, 4096);
        if ($w === null) {
            // No WebP encoder on this host: serve the original (logged).
            error_log('[floorplans] WebP encode unavailable; using original for plan ' . $id);
            $disp = $orig;
        }
        return ['uploads/floorplans/' . $orig, 'uploads/floorplans/' . $disp];
    }

    private function removeFiles(array $r): void
    {
        foreach (['image_path', 'display_path'] as $k) {
            $rel = (string) ($r[$k] ?? '');
            if ($rel !== '' && str_starts_with($rel, 'uploads/floorplans/') && !str_contains($rel, '..')) {
                @unlink($this->appRoot . '/' . $rel);
            }
        }
    }

    public function create(string $name, string $bytes, string $actor): array
    {
        $name = self::cleanName($name);
        $meta = self::inspectUpload($bytes);
        $sort = (int) $this->pdo->query('SELECT COALESCE(MAX(sort_order), 0) FROM floorplans')->fetchColumn() + 10;
        $now  = self::now();
        $st = $this->pdo->prepare('INSERT INTO floorplans (name, sort_order, width_px, height_px, active, created_by, created_at, updated_at)
                                   VALUES (:n, :s, :w, :h, 1, :by, :c, :u)');
        $st->execute(['n' => $name, 's' => $sort, 'w' => $meta['w'], 'h' => $meta['h'], 'by' => mb_substr($actor, 0, 120), 'c' => $now, 'u' => $now]);
        $id = (int) $this->pdo->lastInsertId();
        try {
            [$img, $disp] = $this->storeImage($id, $bytes, $meta);
        } catch (Throwable $e) {
            $this->pdo->prepare('DELETE FROM floorplans WHERE id = :id')->execute(['id' => $id]);
            throw $e;
        }
        $this->pdo->prepare('UPDATE floorplans SET image_path = :i, display_path = :d WHERE id = :id')
            ->execute(['i' => $img, 'd' => $disp, 'id' => $id]);
        return $this->get($id);
    }

    /** Replace the plan image; pins stay (positions are %). */
    public function replaceImage(int $id, string $bytes): ?array
    {
        $r = $this->row($id);
        if ($r === null) {
            return null;
        }
        $meta = self::inspectUpload($bytes);
        [$img, $disp] = $this->storeImage($id, $bytes, $meta);
        $this->pdo->prepare('UPDATE floorplans SET image_path = :i, display_path = :d, width_px = :w, height_px = :h, updated_at = :u WHERE id = :id')
            ->execute(['i' => $img, 'd' => $disp, 'w' => $meta['w'], 'h' => $meta['h'], 'u' => self::now(), 'id' => $id]);
        $this->removeFiles($r);
        return $this->get($id);
    }

    /** @param array{name?:string, active?:mixed, sort_order?:mixed} $in */
    public function update(int $id, array $in): ?array
    {
        if ($this->row($id) === null) {
            return null;
        }
        $set  = [];
        $bind = ['id' => $id, 'u' => self::now()];
        if (array_key_exists('name', $in)) {
            $set[] = 'name = :n';
            $bind['n'] = self::cleanName((string) (is_scalar($in['name']) ? $in['name'] : ''));
        }
        if (array_key_exists('active', $in)) {
            $set[] = 'active = :a';
            $bind['a'] = filter_var($in['active'], FILTER_VALIDATE_BOOLEAN) ? 1 : 0;
        }
        if (array_key_exists('sort_order', $in) && is_numeric($in['sort_order'])) {
            $set[] = 'sort_order = :s';
            $bind['s'] = (int) $in['sort_order'];
        }
        if (!$set) {
            throw new InvalidArgumentException('Nothing to update (name, active, sort_order).');
        }
        $this->pdo->prepare('UPDATE floorplans SET ' . implode(', ', $set) . ', updated_at = :u WHERE id = :id')->execute($bind);
        return $this->get($id);
    }

    /** @param list<int|string> $ids  plan ids in the new order (others keep theirs, after these). */
    public function reorder(array $ids): array
    {
        $ids = array_values(array_unique(array_filter(array_map('intval', $ids), static fn ($i) => $i > 0)));
        if (!$ids) {
            throw new InvalidArgumentException('ids must list the floor plan ids in order.');
        }
        $known = array_map('intval', $this->pdo->query('SELECT id FROM floorplans ORDER BY sort_order, id')->fetchAll(PDO::FETCH_COLUMN));
        $order = array_merge(array_values(array_intersect($ids, $known)), array_values(array_diff($known, $ids)));
        $st = $this->pdo->prepare('UPDATE floorplans SET sort_order = :s, updated_at = :u WHERE id = :id');
        $now = self::now();
        $this->pdo->beginTransaction();
        foreach ($order as $i => $id) {
            $st->execute(['s' => ($i + 1) * 10, 'u' => $now, 'id' => $id]);
        }
        $this->pdo->commit();
        return $this->list();
    }

    public function delete(int $id): bool
    {
        $r = $this->row($id);
        if ($r === null) {
            return false;
        }
        $this->pdo->prepare('DELETE FROM floorplan_cameras WHERE floorplan_id = :id')->execute(['id' => $id]);
        $this->pdo->prepare('DELETE FROM floorplans WHERE id = :id')->execute(['id' => $id]);
        $this->removeFiles($r);
        return true;
    }

    /** @return array{path:string, mime:string}|null */
    public function imageFile(int $id, bool $original = false): ?array
    {
        $r = $this->row($id);
        if ($r === null) {
            return null;
        }
        $rel = (string) ($original ? $r['image_path'] : ($r['display_path'] ?: $r['image_path']));
        if ($rel === '' || !str_starts_with($rel, 'uploads/floorplans/') || str_contains($rel, '..')) {
            return null;
        }
        $path = $this->appRoot . '/' . $rel;
        if (!is_file($path)) {
            return null;
        }
        $ext  = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        $mime = ['webp' => 'image/webp', 'png' => 'image/png', 'jpg' => 'image/jpeg'][$ext] ?? 'application/octet-stream';
        return ['path' => $path, 'mime' => $mime];
    }

    // ── Pins ────────────────────────────────────────────────

    /** @return array<int, list<array>> plan id → pins */
    private function pinsByPlan(?int $planId = null): array
    {
        $sql = 'SELECT * FROM floorplan_cameras' . ($planId !== null ? ' WHERE floorplan_id = :p' : '') . ' ORDER BY floorplan_id, id';
        $st  = $this->pdo->prepare($sql);
        $st->execute($planId !== null ? ['p' => $planId] : []);
        $out = [];
        foreach ($st->fetchAll() as $p) {
            $out[(int) $p['floorplan_id']][] = $p;
        }
        return $out;
    }

    private function pinShape(array $p, bool $redact = false): array
    {
        $cam = (string) $p['camera_id'];
        $c   = $this->cameraCatalog()[$cam] ?? null;
        $out = [
            'id'           => (int) $p['id'],
            'floorplan_id' => (int) $p['floorplan_id'],
            'camera_id'    => $cam,
            'x_pct'        => round((float) $p['x_pct'], 3),
            'y_pct'        => round((float) $p['y_pct'], 3),
            'label'        => (string) (($p['label'] ?? '') ?: ($c['name'] ?? strtoupper($cam))),
            'location'     => (string) ($c['location'] ?? ''),
            'camera_known' => $c !== null,   // false = camera since removed from config
            'live'         => (bool) ($c['live'] ?? false),
        ];
        if ($redact) {
            unset($out['camera_id'], $out['camera_known'], $out['live']);
        }
        return $out;
    }

    public function pin(int $pinId): ?array
    {
        $st = $this->pdo->prepare('SELECT * FROM floorplan_cameras WHERE id = :id');
        $st->execute(['id' => $pinId]);
        $p = $st->fetch();
        return $p ? $this->pinShape($p) : null;
    }

    private static function pct($v, string $field): float
    {
        if (!is_numeric($v)) {
            throw new InvalidArgumentException($field . ' must be a number (0–100).');
        }
        $f = (float) $v;
        if (!is_finite($f) || $f < 0 || $f > 100) {
            throw new InvalidArgumentException($field . ' must be between 0 and 100.');
        }
        return round($f, 4);
    }

    /**
     * Place or move a camera pin (one pin per camera per plan: re-posting the
     * same camera moves it). Returns null when the plan does not exist.
     */
    public function setPin(int $planId, array $in): ?array
    {
        if ($this->row($planId) === null) {
            return null;
        }
        $cam = $this->validCamera((string) (is_scalar($in['camera_id'] ?? null) ? $in['camera_id'] : ''));
        if ($cam === null) {
            throw new InvalidArgumentException('camera_id is not a configured camera (see GET /api/floorplans/cameras).');
        }
        $x     = self::pct($in['x_pct'] ?? null, 'x_pct');
        $y     = self::pct($in['y_pct'] ?? null, 'y_pct');
        $label = array_key_exists('label', $in) ? mb_substr(trim(strip_tags((string) (is_scalar($in['label']) ? $in['label'] : ''))), 0, 120) : null;
        $now   = self::now();

        $st = $this->pdo->prepare('SELECT * FROM floorplan_cameras WHERE floorplan_id = :p AND camera_id = :c');
        $st->execute(['p' => $planId, 'c' => $cam]);
        $cur = $st->fetch();
        if ($cur) {
            $this->pdo->prepare('UPDATE floorplan_cameras SET x_pct = :x, y_pct = :y, label = :l, updated_at = :u WHERE id = :id')
                ->execute(['x' => $x, 'y' => $y, 'l' => $label ?? $cur['label'], 'u' => $now, 'id' => $cur['id']]);
            $id = (int) $cur['id'];
        } else {
            $this->pdo->prepare('INSERT INTO floorplan_cameras (floorplan_id, camera_id, x_pct, y_pct, label, created_at, updated_at)
                                 VALUES (:p, :c, :x, :y, :l, :n, :n)')
                ->execute(['p' => $planId, 'c' => $cam, 'x' => $x, 'y' => $y, 'l' => $label, 'n' => $now]);
            $id = (int) $this->pdo->lastInsertId();
        }
        $this->touch($planId);
        return $this->pin($id);
    }

    /** Move an existing pin by id (x/y and/or label). */
    public function movePin(int $planId, int $pinId, array $in): ?array
    {
        $p = $this->pin($pinId);
        if ($p === null || $p['floorplan_id'] !== $planId) {
            return null;
        }
        return $this->setPin($planId, ['camera_id' => $p['camera_id'],
            'x_pct' => $in['x_pct'] ?? $p['x_pct'], 'y_pct' => $in['y_pct'] ?? $p['y_pct']]
            + (array_key_exists('label', $in) ? ['label' => $in['label']] : []));
    }

    public function deletePin(int $planId, int $pinId): bool
    {
        $st = $this->pdo->prepare('DELETE FROM floorplan_cameras WHERE id = :id AND floorplan_id = :p');
        $st->execute(['id' => $pinId, 'p' => $planId]);
        if ($st->rowCount() > 0) {
            $this->touch($planId);
            return true;
        }
        return false;
    }

    private function touch(int $planId): void
    {
        $this->pdo->prepare('UPDATE floorplans SET updated_at = :u WHERE id = :id')->execute(['u' => self::now(), 'id' => $planId]);
    }

    /**
     * Stream label → the pin each camera resolves to for movement: the
     * preferred plan's pin when it has one, else the lowest-sorted active plan.
     *
     * @return array<string, array{pin:array, plan_name:string, also_on:list<int>}>
     */
    private function pinIndex(?int $preferPlan): array
    {
        $rows = $this->pdo->query('SELECT c.*, f.name AS plan_name, f.sort_order AS plan_sort
                                   FROM floorplan_cameras c JOIN floorplans f ON f.id = c.floorplan_id
                                   WHERE f.active = 1 ORDER BY f.sort_order, f.id, c.id')->fetchAll();
        $idx = [];
        foreach ($rows as $r) {
            $key = EventStore::streamLabel((string) $r['camera_id']);
            $pid = (int) $r['floorplan_id'];
            if (!isset($idx[$key])) {
                $idx[$key] = ['pin' => $r, 'plan_name' => (string) $r['plan_name'], 'also_on' => []];
            } elseif ($preferPlan !== null && $pid === $preferPlan && (int) $idx[$key]['pin']['floorplan_id'] !== $preferPlan) {
                $idx[$key]['also_on'][] = (int) $idx[$key]['pin']['floorplan_id'];
                $idx[$key]['pin'] = $r;
                $idx[$key]['plan_name'] = (string) $r['plan_name'];
                continue;
            }
            if ((int) $idx[$key]['pin']['floorplan_id'] !== $pid) {
                $idx[$key]['also_on'][] = $pid;
            }
        }
        return $idx;
    }

    // ── People / identity ───────────────────────────────────

    /** SenseStudio uid → profile person_id (an enrolled employee is matched under its SenseStudio uid). */
    private function aliasMap(): array
    {
        if ($this->alias !== null) {
            return $this->alias;
        }
        $a = [];
        try {
            foreach ($this->pdo->query("SELECT person_id, ss_uid FROM person_profiles WHERE ss_uid IS NOT NULL AND ss_uid <> ''")->fetchAll() as $r) {
                if ((string) $r['ss_uid'] !== (string) $r['person_id']) {
                    $a[(string) $r['ss_uid']] = (string) $r['person_id'];
                }
            }
        } catch (Throwable $e) {
            // ss_uid column not migrated
        }
        return $this->alias = $a;
    }

    /** Fold a SenseStudio uid onto its profile person_id. */
    public function canonical(string $pid): string
    {
        $pid = trim($pid);
        return $this->aliasMap()[$pid] ?? $pid;
    }

    /** Every raw id that means this person in `events.person_id`. */
    private function idsFor(string $pid): array
    {
        // + stranger ids merged into this one (Movement › Strangers "merge with…", lib/Strangers.php).
        require_once __DIR__ . '/Strangers.php';
        return array_values(array_unique(array_merge([$pid], array_map('strval', array_keys(array_filter($this->aliasMap(), static fn ($v) => $v === $pid))),
            Strangers::mergedIds($this->pdo, $pid))));
    }

    public function person(string $pid): array
    {
        $st = $this->pdo->prepare('SELECT * FROM person_profiles WHERE person_id = :p LIMIT 1');
        try {
            $st->execute(['p' => $pid]);
            $r = $st->fetch() ?: null;
        } catch (Throwable $e) {
            $r = null;
        }
        $store = new EventStore($this->pdo, $this->config);
        $stranger = '';
        if ($r === null) {   // unregistered face: show the operator's stranger label when there is one
            require_once __DIR__ . '/Strangers.php';
            $stranger = Strangers::labelOf($this->pdo, $pid);
        }
        return [
            'person_id'  => $pid,
            'name'       => (string) ($r['name'] ?? ($stranger !== '' ? $stranger . ' · #' . $pid : 'Unknown #' . $pid)),
            'staff_id'   => (string) ($r['staff_id'] ?? ''),
            'department' => (string) ($r['department'] ?? ''),
            'photo'      => $r ? $store->fullUrl($r['photo_url'] ?? null) : null,
            'known'      => $r !== null,
        ];
    }

    /** Person picker: profiles by name / staff id (+ an exact person_id hit even without a profile). */
    public function searchPeople(string $q, int $limit = 20): array
    {
        $q     = trim($q);
        $limit = max(1, min(50, $limit));
        $bind  = [];
        $where = '';
        if ($q !== '') {
            $where = ' WHERE LOWER(name) LIKE :q OR LOWER(COALESCE(staff_id, \'\')) LIKE :q OR person_id = :exact';
            $bind  = ['q' => '%' . mb_strtolower($q) . '%', 'exact' => $q];
        }
        try {
            $st = $this->pdo->prepare('SELECT person_id FROM person_profiles' . $where . ' ORDER BY name LIMIT ' . $limit);
            $st->execute($bind);
            $ids = $st->fetchAll(PDO::FETCH_COLUMN);
        } catch (Throwable $e) {
            $ids = [];
        }
        $out = array_map(fn ($id) => $this->person((string) $id), $ids);
        if ($q !== '' && !$out && preg_match('/^[A-Za-z0-9_.:-]{1,64}$/', $q)) {
            $st = $this->pdo->prepare('SELECT 1 FROM events WHERE person_id = :p LIMIT 1');
            $st->execute(['p' => $q]);
            if ($st->fetchColumn()) {
                $out[] = $this->person($this->canonical($q));
            }
        }
        return $out;
    }

    // ── Movement path ───────────────────────────────────────

    /**
     * Whose path the caller may see (AiGuard principal). Supervisor/admin
     * tier with `view`: anyone. Staff: only their own linked person_id
     * (requested id may be omitted or be one of their SenseStudio aliases).
     * Null = not visible → route answers 404 (no existence leak).
     */
    public function subjectFor(array $principal, string $requested): ?string
    {
        $requested = trim($requested);
        if (AiGuard::atLeast($principal, 'supervisor') && AiGuard::can($principal, 'view')) {
            return $requested !== '' ? $this->canonical($requested) : null;
        }
        $own = trim((string) ($principal['person_id'] ?? ''));
        if ($own === '') {
            return null;
        }
        $own = $this->canonical($own);
        return ($requested === '' || $this->canonical($requested) === $own) ? $own : null;
    }

    /**
     * date (YYYY-MM-DD, default today) + from / to (HH:MM, default whole
     * day) → inclusive [from, to] datetimes. Swapped when reversed.
     * @return array{0:string, 1:string}
     */
    public static function window(string $date, string $from, string $to): array
    {
        $date = preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) && strtotime($date) ? $date : date('Y-m-d');
        $hm   = static fn (string $v, string $def): string => preg_match('/^([01]\d|2[0-3]):[0-5]\d$/', $v) ? $v : $def;
        $f    = $hm(trim($from), '00:00');
        $t    = $hm(trim($to), '23:59');
        if (strcmp($f, $t) > 0) {
            [$f, $t] = [$t, $f];
        }
        return [$date . ' ' . $f . ':00', $date . ' ' . $t . ':59'];
    }

    /**
     * Face detections of one person in [$from, $to] (inclusive), time order.
     * @return list<array{event_id:int, cam:string, camera:string, ts:int, time:string, has_image:bool}>
     */
    public function detections(string $pid, string $from, string $to): array
    {
        $ids  = $this->idsFor($pid);
        $in   = [];
        $bind = ['f' => $from, 't' => $to];
        foreach ($ids as $i => $id) {
            $in[] = ':p' . $i;
            $bind['p' . $i] = $id;
        }
        $st = $this->pdo->prepare('SELECT id, stream, device_name, received_at, trigger_img_url, bk_image_url FROM events
                                   WHERE person_id IN (' . implode(',', $in) . ') AND received_at >= :f AND received_at <= :t
                                   ORDER BY received_at ASC, id ASC LIMIT ' . self::MAX_PATH_ROWS);
        $st->execute($bind);
        $out = [];
        foreach ($st->fetchAll() as $r) {
            $raw = (string) ($r['stream'] ?: $r['device_name'] ?: '');
            $out[] = [
                'event_id'  => (int) $r['id'],
                'cam'       => EventStore::streamLabel($raw),
                'camera'    => $raw,
                'ts'        => strtotime((string) $r['received_at']) ?: 0,
                'time'      => (string) $r['received_at'],
                'has_image' => trim((string) ($r['bk_image_url'] ?? '')) !== '' || trim((string) ($r['trigger_img_url'] ?? '')) !== '',
            ];
        }
        return $out;
    }

    /**
     * Collapse time-ordered detections into runs: consecutive detections at
     * the same camera, each ≤ $gapSec after the previous one, are one run.
     * A detection at another camera (pinned or not) or a longer gap starts a
     * new run. Thumb = first detection in the run that has a snapshot.
     *
     * @param list<array{event_id:int, cam:string, ts:int, time:string, has_image?:bool}> $dets
     * @return list<array{cam:string, first_ts:int, last_ts:int, first_seen:string, last_seen:string, count:int, thumb_event:?int, event_ids:list<int>}>
     */
    public static function collapse(array $dets, int $gapSec): array
    {
        usort($dets, static fn ($a, $b) => [$a['ts'], $a['event_id']] <=> [$b['ts'], $b['event_id']]);
        $runs = [];
        $n    = -1;
        foreach ($dets as $d) {
            if ($n >= 0 && $runs[$n]['cam'] === $d['cam'] && $d['ts'] - $runs[$n]['last_ts'] <= $gapSec) {
                $runs[$n]['last_ts']   = $d['ts'];
                $runs[$n]['last_seen'] = $d['time'];
                $runs[$n]['count']++;
                $runs[$n]['event_ids'][] = $d['event_id'];
                if ($runs[$n]['thumb_event'] === null && !empty($d['has_image'])) {
                    $runs[$n]['thumb_event'] = $d['event_id'];
                }
                continue;
            }
            $runs[] = [
                'cam' => $d['cam'], 'first_ts' => $d['ts'], 'last_ts' => $d['ts'],
                'first_seen' => $d['time'], 'last_seen' => $d['time'], 'count' => 1,
                'thumb_event' => !empty($d['has_image']) ? $d['event_id'] : null,
                'event_ids' => [$d['event_id']],
            ];
            $n++;
        }
        return $runs;
    }

    /**
     * Ordered waypoints for one person over [$from, $to].
     *
     * @param bool $redact staff view: drop camera_id / event ids
     */
    public function path(string $pid, string $from, string $to, int $gapMin, ?int $preferPlan = null, bool $redact = false): array
    {
        $gapMin = max(1, min(240, $gapMin));
        $dets   = $this->detections($pid, $from, $to);
        $runs   = self::collapse($dets, $gapMin * 60);
        $pins   = $this->pinIndex($preferPlan);
        $cat    = [];
        foreach ($this->cameraCatalog() as $id => $c) {
            $cat[EventStore::streamLabel($id)] = $c;   // events carry the alnum stream label
        }

        $waypoints = [];
        $unplaced  = [];
        $plans     = [];
        foreach ($runs as $r) {
            $catRow = $cat[$r['cam']] ?? null;
            $wp = [
                'seq'        => 0,
                'camera_id'  => $r['cam'],
                'camera_name'=> (string) ($catRow['name'] ?? strtoupper($r['cam'])),
                'location'   => (string) ($catRow['location'] ?? ''),
                'first_seen' => $r['first_seen'],
                'last_seen'  => $r['last_seen'],
                'dwell_s'    => max(0, $r['last_ts'] - $r['first_ts']),
                'count'      => $r['count'],
                'event_id'   => $r['thumb_event'] ?? $r['event_ids'][0],
                'thumb'      => $r['thumb_event'] !== null ? '/api/movement/thumb/' . $r['thumb_event'] : null,
            ];
            $hit = $pins[$r['cam']] ?? null;
            if ($hit === null) {
                unset($wp['seq']);
                $wp += ['floorplan_id' => null, 'x_pct' => null, 'y_pct' => null];
                $unplaced[] = $wp;
                continue;
            }
            $p = $hit['pin'];
            $wp['seq']            = count($waypoints) + 1;
            $wp['pin_id']         = (int) $p['id'];
            $wp['floorplan_id']   = (int) $p['floorplan_id'];
            $wp['floorplan_name'] = $hit['plan_name'];
            $wp['x_pct']          = round((float) $p['x_pct'], 3);
            $wp['y_pct']          = round((float) $p['y_pct'], 3);
            $wp['label']          = (string) (($p['label'] ?? '') ?: $wp['camera_name']);
            $wp['also_on']        = $hit['also_on'];
            $waypoints[] = $wp;
            $fp = $wp['floorplan_id'];
            $plans[$fp] = ['id' => $fp, 'name' => $hit['plan_name'], 'waypoints' => ($plans[$fp]['waypoints'] ?? 0) + 1];
        }
        if ($redact) {
            foreach ([&$waypoints, &$unplaced] as &$list) {
                foreach ($list as &$w) {
                    unset($w['camera_id'], $w['event_id'], $w['pin_id']);
                }
                unset($w);
            }
            unset($list);
        }
        $last = $waypoints ? $waypoints[count($waypoints) - 1] : null;
        $lastDet = $dets ? $dets[count($dets) - 1] : null;
        return [
            'person'     => $this->person($pid),
            'range'      => ['from' => $from, 'to' => $to],
            'gap_min'    => $gapMin,
            'waypoints'  => $waypoints,
            'unplaced'   => $unplaced,
            'floorplans' => array_values($plans),
            'summary'    => [
                'detections'        => count($dets),
                'waypoints'         => count($waypoints),
                'unplaced'          => count($unplaced),
                'first_seen'        => $dets ? $dets[0]['time'] : null,
                'last_seen'         => $lastDet['time'] ?? null,
                'last_location'     => $last['location'] ?? null,
                'last_floorplan_id' => $last['floorplan_id'] ?? null,
                'truncated'         => count($dets) >= self::MAX_PATH_ROWS,
            ],
        ];
    }

    // ── Zone occupancy (heat overlay) ───────────────────────

    /**
     * Distinct people + detections per pin over the last $minutes (ending at $now).
     * intensity = people / max people across pins (0..1) for the heat overlay.
     */
    public function occupancy(int $minutes = 15, ?int $planId = null, ?int $now = null): array
    {
        $minutes = max(1, min(1440, $minutes));
        $now     = $now ?? time();
        $since   = date('Y-m-d H:i:s', $now - $minutes * 60);
        $until   = date('Y-m-d H:i:s', $now);
        $st = $this->pdo->prepare('SELECT stream, device_name, person_id, received_at FROM events
                                   WHERE received_at >= :s AND received_at <= :u ORDER BY id DESC LIMIT 50000');
        $st->execute(['s' => $since, 'u' => $until]);
        $agg = [];
        $everyone = [];
        foreach ($st->fetchAll() as $r) {
            $cam = EventStore::streamLabel((string) ($r['stream'] ?: $r['device_name'] ?: ''));
            $a   = $agg[$cam] ?? ['people' => [], 'detections' => 0, 'last_seen' => null];
            $a['detections']++;
            $pid = trim((string) ($r['person_id'] ?? ''));
            if ($pid !== '') {
                $a['people'][$this->canonical($pid)] = true;
                $everyone[$this->canonical($pid)] = true;
            }
            if ($a['last_seen'] === null || strcmp((string) $r['received_at'], $a['last_seen']) > 0) {
                $a['last_seen'] = (string) $r['received_at'];
            }
            $agg[$cam] = $a;
        }
        $pins = [];
        foreach ($this->list(false) as $plan) {
            if ($planId !== null && $plan['id'] !== $planId) {
                continue;
            }
            foreach ($plan['pins'] as $p) {
                $a = $agg[EventStore::streamLabel($p['camera_id'])] ?? null;
                $pins[] = [
                    'pin_id'       => $p['id'],
                    'floorplan_id' => $plan['id'],
                    'camera_id'    => $p['camera_id'],
                    'label'        => $p['label'],
                    'x_pct'        => $p['x_pct'],
                    'y_pct'        => $p['y_pct'],
                    'people'       => $a ? count($a['people']) : 0,
                    'detections'   => $a['detections'] ?? 0,
                    'last_seen'    => $a['last_seen'] ?? null,
                ];
            }
        }
        $max = max(1, ...array_map(static fn ($p) => $p['people'], $pins ?: [['people' => 0]]));
        foreach ($pins as &$p) {
            $p['intensity'] = round($p['people'] / $max, 3);
        }
        unset($p);
        return ['minutes' => $minutes, 'since' => $since, 'until' => $until,
                'total_people' => count($everyone),   // distinct people anywhere (incl. unpinned cameras)
                'pins' => $pins];
    }

    // ── Camera pin → live view + recent detections ──────────

    /**
     * How the browser plays a camera — same precedence as app.js videoSrc():
     * direct HLS → go2rtc bridge MP4 → server relay → still frames → none.
     * Relay / still / snapshot paths are API paths (the dashboard adds its
     * read token via liveApiUrl()). RTSP credentials never leave the server.
     */
    public function liveFor(string $cam): array
    {
        $cam   = strtolower($cam);
        $fleet = LiveBridge::fleetRows($this->config, false);
        $want  = LiveBridge::desired($this->config, $fleet)[$cam] ?? null;
        $live  = $this->config['live'] ?? [];
        $base  = rtrim((string) ($live['stream_base'] ?? ''), '/');
        $tok   = (string) ($live['stream_token'] ?? '');
        $relay = in_array($cam, LiveBridge::relaySources($this->config, $fleet), true);
        $still = in_array($cam, LiveBridge::stillSources($this->config, $fleet), true);

        $mode = 'none';
        $url  = null;
        if ($want !== null && !empty($want['direct'])) {
            $mode = 'hls';
            $url  = (string) $want['src'];
        } elseif ($want !== null && $base !== '') {
            $mode = 'bridge';
            $url  = $base . '/api/stream.mp4?src=' . rawurlencode($cam) . ($tok !== '' ? '&token=' . rawurlencode($tok) : '');
        } elseif ($relay) {
            $mode = 'relay';
            $url  = '/api/live/relay?stream=' . rawurlencode($cam);
        } elseif ($still) {
            $mode = 'still';
        }
        $cat = $this->cameraCatalog()[$cam] ?? null;
        return [
            'stream'    => $cam,
            'name'      => (string) ($cat['name'] ?? strtoupper($cam)),
            'location'  => (string) ($cat['location'] ?? ''),
            'online'    => $want['online'] ?? null,
            'hidden'    => in_array($cam, $live['hidden'] ?? [], true),
            'mode'      => $mode,                       // hls | bridge | relay | still | none
            'url'       => $url,
            'still_url' => $still ? '/api/live/still?stream=' . rawurlencode($cam) : null,
            'snapshot_url' => ($base !== '' || !empty($live['api_base'])) && $want !== null ? '/api/live/snapshot?stream=' . rawurlencode($cam) : null,
            'source'    => $want !== null ? LiveBridge::mask((string) $want['src']) : null,
        ];
    }

    /** Latest face detections at a camera (for the camera modal). */
    public function recentAtCamera(string $cam, int $limit = 10): array
    {
        $label = EventStore::streamLabel($cam);
        $limit = max(1, min(50, $limit));
        $st = $this->pdo->prepare("SELECT id, stream, device_name, person_id, received_at, trigger_img_url, bk_image_url FROM events
                                   WHERE received_at >= :f AND person_id IS NOT NULL AND person_id <> '' ORDER BY id DESC LIMIT 2000");
        $st->execute(['f' => date('Y-m-d H:i:s', time() - 7 * 86400)]);
        $out = [];
        $names = [];
        foreach ($st->fetchAll() as $r) {
            if (EventStore::streamLabel((string) ($r['stream'] ?: $r['device_name'] ?: '')) !== $label) {
                continue;
            }
            $pid = $this->canonical((string) $r['person_id']);
            $names[$pid] ??= $this->person($pid);
            $img = trim((string) ($r['bk_image_url'] ?? '')) !== '' || trim((string) ($r['trigger_img_url'] ?? '')) !== '';
            $out[] = ['event_id' => (int) $r['id'], 'person_id' => $pid, 'name' => $names[$pid]['name'],
                      'time' => (string) $r['received_at'], 'thumb' => $img ? '/api/movement/thumb/' . (int) $r['id'] : null];
            if (count($out) >= $limit) {
                break;
            }
        }
        return $out;
    }

    // ── Thumbnails ──────────────────────────────────────────

    /** Canonical person of an event (for staff own-thumb checks), null if none / missing. */
    public function eventPerson(int $eventId): ?string
    {
        $st = $this->pdo->prepare('SELECT person_id FROM events WHERE id = :id');
        $st->execute(['id' => $eventId]);
        $p = $st->fetchColumn();
        return ($p !== false && trim((string) $p) !== '') ? $this->canonical((string) $p) : null;
    }

    public function thumbDir(): string
    {
        $dir = (string) ($this->config['ai']['storage_dir'] ?? $this->appRoot . '/storage');
        return rtrim($dir, '/') . '/thumbs/movement';
    }

    /**
     * Cached small WebP of an event's snapshot (scene image, else face crop).
     * Generated on first request; null when the event has no image or it
     * cannot be fetched / encoded (failure cached for 10 min).
     */
    public function thumb(int $eventId): ?string
    {
        $dir  = $this->thumbDir();
        $file = $dir . '/' . $eventId . '.webp';
        if (is_file($file) && filesize($file) > 0) {
            return $file;
        }
        $fail = $dir . '/' . $eventId . '.fail';
        if (is_file($fail) && time() - (int) filemtime($fail) < self::THUMB_FAIL_TTL) {
            return null;
        }
        $st = $this->pdo->prepare('SELECT trigger_img_url, bk_image_url FROM events WHERE id = :id');
        $st->execute(['id' => $eventId]);
        $r = $st->fetch();
        if (!$r) {
            return null;
        }
        $store = new EventStore($this->pdo, $this->config);
        foreach (['bk_image_url', 'trigger_img_url'] as $col) {
            $src = trim((string) ($r[$col] ?? ''));
            if ($src === '') {
                continue;
            }
            $img = ImageTool::fetch($store->fullUrl($src), $this->appRoot);
            if ($img !== null && ImageTool::toWebp($img['bytes'], $file, 70, self::THUMB_EDGE) !== null) {
                @unlink($fail);
                return $file;
            }
        }
        if (is_dir($dir) || @mkdir($dir, 0775, true)) {
            @touch($fail);
        }
        return null;
    }
}
