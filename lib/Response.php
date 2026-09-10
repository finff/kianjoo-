<?php
/**
 * Tiny JSON response helper + CORS.
 */

declare(strict_types=1);

final class Response
{
    public static function cors(): void
    {
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
        header('Access-Control-Allow-Headers: Content-Type, X-Ingest-Token, X-Read-Token, Authorization');
        header('Access-Control-Max-Age: 86400');
    }

    /** @param mixed $data */
    public static function json($data, int $status = 200): void
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }

    public static function ok(array $extra = []): void
    {
        self::json(array_merge(['ok' => true], $extra), 200);
    }

    public static function error(string $message, int $status = 400, array $extra = []): void
    {
        self::json(array_merge(['ok' => false, 'error' => $message], $extra), $status);
    }
}
