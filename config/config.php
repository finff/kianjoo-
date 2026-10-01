<?php
/**
 * Central bootstrap: loads .env, defines paths, sets error handling.
 * Returns an associative config array.
 */

declare(strict_types=1);

if (!defined('APP_ROOT')) {
    define('APP_ROOT', dirname(__DIR__));
}

require_once APP_ROOT . '/lib/Env.php';

Env::load(APP_ROOT . '/.env');

$debug = Env::bool('APP_DEBUG', false);

// Never leak errors to the HTTP client in production; always log them.
error_reporting(E_ALL);
ini_set('display_errors', $debug ? '1' : '0');
ini_set('log_errors', '1');

date_default_timezone_set(Env::get('APP_TZ', 'Asia/Kuala_Lumpur'));

// Public base URL — set APP_URL in .env for CLI/cron contexts (no
// $_SERVER['HTTP_HOST'] there); otherwise auto-detected from the request so
// moving domains never needs a code change.
$appUrl = rtrim((string) Env::get('APP_URL', ''), '/');
if ($appUrl === '' && !empty($_SERVER['HTTP_HOST'])) {
    $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    $appUrl = $scheme . '://' . $_SERVER['HTTP_HOST'];
}
if ($appUrl !== '') {
    require_once APP_ROOT . '/lib/EmailTemplate.php';
    EmailTemplate::setHost($appUrl);
}

$config = [
    'app' => [
        'name'  => Env::get('APP_NAME', 'SenseTime Ingest'),
        'env'   => Env::get('APP_ENV', 'production'),
        'debug' => $debug,
        'tz'    => Env::get('APP_TZ', 'Asia/Kuala_Lumpur'),
        'url'   => $appUrl,
    ],
    'auth' => [
        'ingest_token'    => Env::get('INGEST_TOKEN', ''),
        // If READ_TOKEN is blank, reads reuse the ingest token.
        'read_token'      => Env::get('READ_TOKEN', '') !== '' ? Env::get('READ_TOKEN') : Env::get('INGEST_TOKEN', ''),
        'provision_token' => Env::get('PROVISION_TOKEN', ''),
    ],
    'storage' => [
        // DB_CONNECTION is the Laravel-style key; DB_DRIVER kept for back-compat.
        'driver'     => Env::get('DB_CONNECTION', Env::get('DB_DRIVER', 'mysql')),
        'db_path'    => APP_ROOT . '/' . ltrim(Env::get('DB_PATH', 'storage/events.sqlite'), '/'),
        'mysql'      => [
            'host' => Env::get('DB_HOST', 'localhost'),
            'port' => (int) Env::get('DB_PORT', '3306'),
            'name' => Env::get('DB_DATABASE', ''),
            'user' => Env::get('DB_USERNAME', ''),
            'pass' => Env::get('DB_PASSWORD', ''),
        ],
        'raw_log'    => APP_ROOT . '/' . ltrim(Env::get('RAW_LOG', 'storage/events.jsonl'), '/'),
        'max_events' => (int) Env::get('MAX_EVENTS', '0'),
    ],
    'images' => [
        // Prepended to relative /images/... URLs so responses carry viewable links.
        'base' => rtrim(Env::get('SENSE_IMAGE_BASE', ''), '/'),
    ],
    'ai' => [
        // Weststar AI SenseTime middleware (LLM review + analytics).
        'base'    => rtrim(Env::get('WESTAR_AI_BASE', ''), '/'),
        'forward' => Env::bool('FORWARD_WESTAR_AI', false),
    ],
    'sense_api' => [
        // SenseStudio external API account (login at {base}/GUNS/mgr/login).
        'base'     => rtrim(Env::get('SENSE_API_BASE', ''), '/'),
        'account'  => Env::get('SENSE_API_ACCOUNT', ''),
        'password' => Env::get('SENSE_API_PASSWORD', ''),
    ],
    'live' => [
        // Monitored RTSP sources keyed by stream label + optional go2rtc base.
        'rtsp'         => json_decode(Env::get('RTSP_STREAMS', '{}') ?: '{}', true) ?: [],
        'stream_base'  => rtrim(Env::get('LIVE_STREAM_BASE', ''), '/'),
        // Stream keys hidden from the Live Monitoring grid (Cameras page toggle).
        'hidden'       => [],
        // Token for a gated go2rtc bridge (appended to the player URL as ?token=).
        'stream_token' => Env::get('LIVE_STREAM_TOKEN', ''),
    ],
    'alerts' => [
        // Minimum incident severity that triggers an email: low|medium|high|critical|off.
        'min_severity' => strtolower(Env::get('ALERT_MIN_SEVERITY', 'high')),
        // Modules that always email regardless of severity (comma list of fire,ppe,intr,face).
        'always_mods'  => array_filter(array_map('trim', explode(',', strtolower(Env::get('ALERT_ALWAYS_MODS', 'fire'))))),
        // Intrusion armed window, e.g. "22:00-06:00" (emails only inside it), "always", or "off".
        'intr_armed'   => strtolower(trim(Env::get('INTRUSION_ARMED', 'always'))),
    ],
    'mail' => [
        'host'     => Env::get('MAIL_HOST', ''),
        'port'     => (int) Env::get('MAIL_PORT', '465'),
        'scheme'   => Env::get('MAIL_SCHEME', 'smtps'),
        'username' => Env::get('MAIL_USERNAME', ''),
        'password' => Env::get('MAIL_PASSWORD', ''),
        'from'     => Env::get('MAIL_FROM_ADDRESS', ''),
        'from_name'=> Env::get('MAIL_FROM_NAME', 'AIVA Dashboard'),
        'to'       => array_filter(array_map('trim', explode(',', Env::get('MAIL_TO', '')))),
        'cooldown' => max(1, (int) Env::get('MAIL_COOLDOWN_MIN', '5')),
    ],
    'forward' => [
        'firebase_base' => rtrim(Env::get('FORWARD_FIREBASE_BASE', ''), '/'),
    ],
];

// Runtime alert-settings overlay, edited from the dashboard's Alert Rules page
// (POST /api/alerts → storage/alert_settings.json). Overrides the .env defaults.
$overlayFile = APP_ROOT . '/storage/alert_settings.json';
if (is_file($overlayFile)) {
    $o = json_decode((string) file_get_contents($overlayFile), true);
    if (is_array($o)) {
        foreach (['min_severity', 'always_mods', 'intr_armed', 'mods_enabled', 'email_enabled'] as $k) {
            if (array_key_exists($k, $o)) {
                $config['alerts'][$k] = $o[$k];
            }
        }
        if (isset($o['mail_to'])) {
            $to = is_array($o['mail_to']) ? $o['mail_to'] : explode(',', (string) $o['mail_to']);
            $to = array_values(array_filter(array_map('trim', $to)));
            if ($to) {
                $config['mail']['to'] = $to;
            }
        }
        if (isset($o['cooldown_min'])) {
            $config['mail']['cooldown'] = max(1, (int) $o['cooldown_min']);
        }
    }
}

// App-settings overlay, edited from the dashboard's Settings page
// (POST /api/settings → storage/app_settings.json). SenseTime API config,
// AI source (weststar-ai vs Anthropic), rotated tokens, auto-report schedule.
$appFile = APP_ROOT . '/storage/app_settings.json';
$app = is_file($appFile) ? (json_decode((string) file_get_contents($appFile), true) ?: []) : [];
if ($app) {
    if (!empty($app['sense_api_base'])) {
        $config['sense_api']['base'] = rtrim((string) $app['sense_api_base'], '/');
    }
    if (!empty($app['sense_account'])) {
        $config['sense_api']['account'] = (string) $app['sense_account'];
    }
    if (!empty($app['sense_password'])) {
        $config['sense_api']['password'] = (string) $app['sense_password'];
    }
    if (!empty($app['image_base'])) {
        $config['images']['base'] = rtrim((string) $app['image_base'], '/');
    }
    if (isset($app['live_stream_base'])) {
        $config['live']['stream_base'] = rtrim((string) $app['live_stream_base'], '/');
    }
    if (isset($app['live_stream_token'])) {
        $config['live']['stream_token'] = (string) $app['live_stream_token'];
    }
    if (isset($app['live_hidden']) && is_array($app['live_hidden'])) {
        $config['live']['hidden'] = array_values(array_filter(array_map(
            static fn ($s) => strtolower(trim((string) $s)),
            $app['live_hidden']
        )));
    }
    if (!empty($app['ingest_token'])) {
        $config['auth']['ingest_token'] = (string) $app['ingest_token'];
    }
    if (!empty($app['read_token'])) {
        $config['auth']['read_token'] = (string) $app['read_token'];
    }
}
// AI source: 'weststar' (default, api.weststar-ai.com middleware) or 'anthropic'
// (direct Claude API — needs anthropic_key) or 'off'.
$config['ai']['source']          = in_array($app['ai_source'] ?? '', ['weststar', 'anthropic', 'off'], true)
    ? $app['ai_source'] : (Env::get('AI_SOURCE', 'weststar'));
$config['ai']['anthropic_key']   = (string) ($app['anthropic_key'] ?? Env::get('ANTHROPIC_API_KEY', ''));
$config['ai']['anthropic_model'] = (string) ($app['anthropic_model'] ?? Env::get('ANTHROPIC_MODEL', 'claude-opus-4-8'));
// In-dashboard assistant: a Weststar AI agent (RAG over the SenseStudio /
// Kian Joo docs, plus live detections through its http tool → /api/ai/*).
$config['ai']['agent_base'] = rtrim((string) ($app['agent_base'] ?? Env::get('WESTAR_AI_AGENT_BASE', 'https://api.weststar-ai.com/v1/agents')), '/');
$config['ai']['agent_id']   = (string) ($app['agent_id'] ?? Env::get('WESTAR_AI_AGENT_ID', ''));
$config['ai']['agent_key']  = (string) ($app['agent_key'] ?? Env::get('WESTAR_AI_KEY', ''));
// Which LLM answers the in-dashboard assistant. Exactly one is active;
// 'weststar' (the agent, with retrieval + live-data tools) is the default.
$config['ai']['provider']     = in_array($app['llm_provider'] ?? '', ['weststar', 'anthropic', 'gemini', 'openai'], true)
    ? (string) $app['llm_provider'] : Env::get('LLM_PROVIDER', 'weststar');
$config['ai']['storage_dir'] = APP_ROOT . '/storage';
$config['ai']['gemini_key']   = (string) ($app['gemini_key'] ?? Env::get('GEMINI_API_KEY', ''));
$config['ai']['gemini_model'] = (string) ($app['gemini_model'] ?? Env::get('GEMINI_MODEL', ''));
$config['ai']['openai_key']   = (string) ($app['openai_key'] ?? Env::get('OPENAI_API_KEY', ''));
$config['ai']['openai_model'] = (string) ($app['openai_model'] ?? Env::get('OPENAI_MODEL', 'gpt-4o-mini'));
// Notification routing (escalation-matrix targets), Settings-page managed.
// Each accepts a comma list; empty falls back to the base MAIL_TO recipients.
$emails = static function ($v): array {
    $to = is_array($v) ? $v : explode(',', (string) $v);
    return array_values(array_filter(array_map('trim', $to),
        static fn ($e) => (bool) filter_var($e, FILTER_VALIDATE_EMAIL)));
};
$config['routing'] = [
    'tmforce'    => $emails($app['email_tmforce'] ?? Env::get('EMAIL_TMFORCE', '')),
    'soc'        => $emails($app['email_soc'] ?? Env::get('EMAIL_SOC', '')),
    'supervisor' => $emails($app['email_supervisor'] ?? Env::get('EMAIL_SUPERVISOR', '')),
    'admin'      => $emails($app['email_admin'] ?? Env::get('EMAIL_ADMIN', '')),
];

// POC (Kian Joo Vision AI): camera stream → named camera point, the agreed
// location list, and the inactivity interval after which a person's last
// detection is shown as "latest known location" instead of on-site. Managed
// from Settings → POC Camera Points (stored in app_settings.json).
$camLoc = [];
foreach ((is_array($app['cam_locations'] ?? null) ? $app['cam_locations'] : []) as $k => $v) {
    $k = strtolower(preg_replace('/[^a-z0-9_.-]+/i', '', substr(trim((string) $k), 0, 64)));
    $v = substr(trim((string) $v), 0, 64);
    if ($k !== '' && $v !== '') {
        $camLoc[$k] = $v;
    }
}
$config['poc'] = [
    'cam_locations'  => $camLoc,
    'inactivity_min' => max(5, min(720, (int) ($app['poc_inactivity_min'] ?? 45))),
    'locations'      => [
        'Plant 1 Guard Post', 'Plant 2 Guard Post', 'Lobby Entrance',
        '8 Color Entrance', 'Conventional Entrance', 'Line 5', 'Waste Area — Spot 9',
    ],
];

// Auto reports: off | daily | weekly | monthly | yearly, sent at `hour` (0-23).
$config['reports'] = [
    'frequency'  => in_array($app['report_frequency'] ?? '', ['off', 'daily', 'weekly', 'monthly', 'yearly'], true)
        ? $app['report_frequency'] : 'off',
    'hour'       => max(0, min(23, (int) ($app['report_hour'] ?? 8))),
    'recipients' => array_values(array_filter(array_map('trim',
        is_array($app['report_recipients'] ?? null) ? $app['report_recipients'] : []),
        static fn ($e) => (bool) filter_var($e, FILTER_VALIDATE_EMAIL))) ?: ($config['mail']['to'] ?? []),
];

return $config;
