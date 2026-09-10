<?php
// Local dev router emulating the .htaccess rewrite for `php -S`.
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (strpos($uri, '/api') === 0) {
    require __DIR__ . '/../api/index.php';
    return true;
}
$file = __DIR__ . '/..' . $uri;
if ($uri !== '/' && is_file($file)) {
    return false; // serve static
}
require __DIR__ . '/../index.php';
return true;
