<?php
/**
 * Settings for AI performance thresholds, the integration API / webhooks and
 * data retention. Stored in storage/wsd_settings.json (web access to storage/
 * is denied) and applied into $config['wsd'] by config/config.php.
 *
 * Keys:
 *   retention_days        int     events + evidence older than this are purged (default 90, 0 = keep forever)
 *   face_min_similarity   float   0-100; a face match below it is treated as unknown (0 = SenseStudio decides)
 *   ppe_min_conf          float   0-100; a PPE attribute below it counts as "not reported" (0 = off)
 *   integration_key       string  API key for /api/integration/* (secret)
 *   webhooks              list    [{id, url, secret, events[], enabled}]
 */

declare(strict_types=1);

final class WsdSettings
{
    public const WEBHOOK_EVENTS = [
        'attendance' => 'Attendance clock-in / clock-out (face recognition at a clock camera)',
        'incident'   => 'Incidents (high / critical detections)',
        'detection'  => 'Every detection (high volume)',
        'ppe'        => 'PPE violations',
    ];

    public const DEFAULTS = [
        'retention_days'      => 90,
        'face_min_similarity' => 0,
        'ppe_min_conf'        => 0,
        'integration_key'     => '',
        'webhooks'            => [],
    ];

    public static function file(?string $dir = null): string
    {
        return ($dir ?? dirname(__DIR__) . '/storage') . '/wsd_settings.json';
    }

    /** Raw stored settings merged over defaults. */
    public static function load(?string $dir = null): array
    {
        $f = self::file($dir);
        $d = is_file($f) ? (json_decode((string) @file_get_contents($f), true) ?: []) : [];
        return self::normalize(array_merge(self::DEFAULTS, is_array($d) ? $d : []));
    }

    /** Effective settings from a loaded $config (falls back to the file). */
    public static function of(array $config): array
    {
        if (isset($config['wsd']) && is_array($config['wsd'])) {
            return self::normalize(array_merge(self::DEFAULTS, $config['wsd']));
        }
        return self::load(self::dirOf($config));
    }

    public static function dirOf(array $config): string
    {
        $raw = (string) ($config['storage']['raw_log'] ?? '');
        return $raw !== '' ? dirname($raw) : dirname(__DIR__) . '/storage';
    }

    public static function save(array $patch, ?string $dir = null): array
    {
        $f   = self::file($dir);
        $cur = self::load($dir);
        $new = self::normalize(array_merge($cur, $patch));
        if (!is_dir(dirname($f))) {
            @mkdir(dirname($f), 0775, true);
        }
        file_put_contents($f, json_encode($new, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
        return $new;
    }

    public static function normalize(array $s): array
    {
        $s['retention_days']      = max(0, min(3650, (int) ($s['retention_days'] ?? 90)));
        $s['face_min_similarity'] = max(0.0, min(100.0, (float) ($s['face_min_similarity'] ?? 0)));
        $s['ppe_min_conf']        = max(0.0, min(100.0, (float) ($s['ppe_min_conf'] ?? 0)));
        $s['integration_key']     = (string) ($s['integration_key'] ?? '');
        $hooks = [];
        foreach (array_slice(is_array($s['webhooks'] ?? null) ? $s['webhooks'] : [], 0, 10) as $h) {
            if (!is_array($h)) {
                continue;
            }
            $url = trim((string) ($h['url'] ?? ''));
            if ($url === '' || !preg_match('~^https?://~i', $url)) {
                continue;
            }
            $hooks[] = [
                'id'      => preg_replace('/[^a-z0-9]/i', '', (string) ($h['id'] ?? '')) ?: substr(md5($url), 0, 10),
                'url'     => substr($url, 0, 500),
                'secret'  => substr((string) ($h['secret'] ?? ''), 0, 200),
                'events'  => array_values(array_intersect(array_keys(self::WEBHOOK_EVENTS), (array) ($h['events'] ?? []))),
                'enabled' => ($h['enabled'] ?? true) !== false,
            ];
        }
        $s['webhooks'] = $hooks;
        return $s;
    }

    public static function mask(string $s): string
    {
        return $s === '' ? '' : (strlen($s) > 4 ? str_repeat('•', 8) . substr($s, -4) : '••••');
    }

    /** Settings safe for the browser: secrets masked. */
    public static function forUi(array $s): array
    {
        $s['integration_key'] = self::mask($s['integration_key']);
        $s['has_key'] = $s['integration_key'] !== '';
        foreach ($s['webhooks'] as &$h) {
            $h['secret'] = self::mask($h['secret']);
            $h['url']    = (string) preg_replace('~//([^:/@]+):[^@]*@~', '//$1:••••@', $h['url']);
        }
        unset($h);
        return $s;
    }
}
