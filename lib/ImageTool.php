<?php
/**
 * Image helpers for the AI layer: fetch a detection frame, shrink it for a
 * vision request, and store proof images as WebP (hard rule: detection proof
 * is WebP).
 *
 * WebP encoder order: GD imagewebp() → `cwebp` binary (if present and exec is
 * allowed) → Imagick. Returns null when none can encode.
 */

declare(strict_types=1);

final class ImageTool
{
    private const MAX_FETCH_BYTES = 12 * 1024 * 1024;

    /**
     * Fetch image bytes from an http(s) URL or a local path inside the app
     * (uploads/ or storage/). Any other scheme is refused.
     *
     * @return array{bytes:string, mime:string}|null
     */
    public static function fetch(?string $src, string $appRoot): ?array
    {
        $src = trim((string) $src);
        if ($src === '') {
            return null;
        }
        if (preg_match('#^https?://#i', $src)) {
            if (!function_exists('curl_init')) {
                return null;
            }
            $buf = '';
            $ch  = curl_init($src);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => false,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_MAXREDIRS      => 3,
                CURLOPT_PROTOCOLS      => CURLPROTO_HTTP | CURLPROTO_HTTPS,
                CURLOPT_REDIR_PROTOCOLS=> CURLPROTO_HTTP | CURLPROTO_HTTPS,
                CURLOPT_CONNECTTIMEOUT => 6,
                CURLOPT_TIMEOUT        => 20,
                CURLOPT_SSL_VERIFYPEER => false,   // SenseStudio boxes commonly use self-signed certs
                CURLOPT_WRITEFUNCTION  => static function ($ch, string $chunk) use (&$buf): int {
                    $buf .= $chunk;
                    return strlen($buf) > self::MAX_FETCH_BYTES ? 0 : strlen($chunk);
                },
            ]);
            curl_exec($ch);
            $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
            curl_close($ch);
            if ($code !== 200 || $buf === '') {
                return null;
            }
            $mime = self::mimeOf($buf);
            return $mime ? ['bytes' => $buf, 'mime' => $mime] : null;
        }
        // Local file: only inside uploads/ or storage/ of this app.
        $rel  = ltrim(preg_replace('#^\./#', '', $src) ?? $src, '/');
        $path = realpath(rtrim($appRoot, '/') . '/' . $rel);
        $root = realpath($appRoot);
        if ($path === false || $root === false || !is_file($path)
            || !(str_starts_with($path, $root . '/uploads/') || str_starts_with($path, $root . '/storage/'))
            || filesize($path) > self::MAX_FETCH_BYTES) {
            return null;
        }
        $bytes = (string) file_get_contents($path);
        $mime  = self::mimeOf($bytes);
        return $mime ? ['bytes' => $bytes, 'mime' => $mime] : null;
    }

    /** Sniff an image MIME type from bytes; null if it is not an image we handle. */
    public static function mimeOf(string $bytes): ?string
    {
        $info = @getimagesizefromstring($bytes);
        $mime = is_array($info) ? (string) ($info['mime'] ?? '') : '';
        return in_array($mime, ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'], true) ? $mime : null;
    }

    /**
     * Downscale (long edge ≤ $maxEdge) and re-encode as JPEG for a vision
     * request — keeps the base64 payload small. Returns the input unchanged if
     * GD is unavailable.
     *
     * @return array{bytes:string, mime:string}
     */
    public static function forVision(string $bytes, string $mime, int $maxEdge = 1568): array
    {
        if (!function_exists('imagecreatefromstring')) {
            return ['bytes' => $bytes, 'mime' => $mime];
        }
        $im = @imagecreatefromstring($bytes);
        if (!$im) {
            return ['bytes' => $bytes, 'mime' => $mime];
        }
        $im = self::fit($im, $maxEdge);
        ob_start();
        imagejpeg($im, null, 82);
        $out = (string) ob_get_clean();
        imagedestroy($im);
        return $out !== '' ? ['bytes' => $out, 'mime' => 'image/jpeg'] : ['bytes' => $bytes, 'mime' => $mime];
    }

    /**
     * Encode image bytes to a WebP file at $dest (directories created).
     *
     * @return array{path:string, bytes:int, width:int, height:int, method:string}|null
     */
    public static function toWebp(string $bytes, string $dest, int $quality = 80, int $maxEdge = 1920): ?array
    {
        $dir = dirname($dest);
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            return null;
        }
        $quality = max(30, min(100, $quality));

        // 1) GD
        if (function_exists('imagewebp') && function_exists('imagecreatefromstring')) {
            $im = @imagecreatefromstring($bytes);
            if ($im) {
                if (!imageistruecolor($im)) {
                    imagepalettetotruecolor($im);
                }
                $im = self::fit($im, $maxEdge);
                $ok = @imagewebp($im, $dest, $quality);
                $w  = imagesx($im);
                $h  = imagesy($im);
                imagedestroy($im);
                if ($ok && is_file($dest) && filesize($dest) > 0) {
                    return ['path' => $dest, 'bytes' => (int) filesize($dest), 'width' => $w, 'height' => $h, 'method' => 'gd'];
                }
            }
        }

        // 2) cwebp binary
        $bin = self::cwebpBinary();
        if ($bin !== null) {
            $tmp = tempnam(sys_get_temp_dir(), 'kjimg');
            if ($tmp !== false && file_put_contents($tmp, $bytes) !== false) {
                $cmd = escapeshellarg($bin) . ' -quiet -q ' . (int) $quality . ' '
                     . escapeshellarg($tmp) . ' -o ' . escapeshellarg($dest) . ' 2>&1';
                $out = [];
                $rc  = 1;
                @exec($cmd, $out, $rc);
                @unlink($tmp);
                if ($rc === 0 && is_file($dest) && filesize($dest) > 0) {
                    $info = @getimagesize($dest) ?: [0, 0];
                    return ['path' => $dest, 'bytes' => (int) filesize($dest), 'width' => (int) $info[0], 'height' => (int) $info[1], 'method' => 'cwebp'];
                }
            }
        }

        // 3) Imagick
        if (class_exists('Imagick')) {
            try {
                $im = new Imagick();
                $im->readImageBlob($bytes);
                if (max($im->getImageWidth(), $im->getImageHeight()) > $maxEdge) {
                    $im->thumbnailImage($maxEdge, $maxEdge, true);
                }
                $im->setImageFormat('webp');
                $im->setImageCompressionQuality($quality);
                $im->writeImage($dest);
                $res = ['path' => $dest, 'bytes' => (int) filesize($dest), 'width' => $im->getImageWidth(),
                        'height' => $im->getImageHeight(), 'method' => 'imagick'];
                $im->clear();
                return $res;
            } catch (Throwable $e) {
                error_log('[imagetool] imagick: ' . $e->getMessage());
            }
        }
        return null;
    }

    // ── On-demand enhancement (proof viewer "Enhance" button) ────────────
    // Called ONLY from GET /api/image/enhance, which the viewer hits when the
    // user clicks Enhance. Nothing in the pipeline / page loads calls this.

    /** Output never wider than this (upscale is clamped, never forced). */
    public const ENHANCE_MAX_W = 4000;
    /** Refuse sources above this many pixels (memory guard). */
    public const ENHANCE_MAX_SRC_PX = 40_000_000;
    /** Bump to invalidate every cached enhanced file after an algorithm change. */
    private const ENHANCE_VER = 1;

    /** Engine + cache-hit flag of the last enhance() call (for the route's meta). */
    public static ?string $lastEngine = null;
    public static bool $lastCacheHit = false;

    /**
     * Normalise enhance options. Defaults are tuned for dim CCTV frames:
     * auto-contrast (percentile stretch + midtone lift) and moderate sharpening,
     * no upscale.
     *
     * @return array{auto:bool, upscale:bool, brightness:int, contrast:int, sharpen:int}
     */
    public static function enhanceOpts(array $in): array
    {
        $int = static fn ($v, int $def, int $lo, int $hi): int =>
            is_numeric($v) ? max($lo, min($hi, (int) round((float) $v))) : $def;
        $bool = static fn ($v, bool $def): bool =>
            $v === null ? $def : in_array(strtolower((string) $v), ['1', 'true', 'yes', 'on'], true) || $v === true;
        return [
            'auto'       => $bool($in['auto'] ?? null, true),
            'upscale'    => $bool($in['upscale'] ?? null, false),
            'brightness' => $int($in['brightness'] ?? null, 0, -50, 50),
            'contrast'   => $int($in['contrast'] ?? null, 0, -50, 50),
            'sharpen'    => $int($in['sharpen'] ?? null, 40, 0, 100),
        ];
    }

    /** Which engine enhance() would use: 'imagick' | 'gd' | null (none). */
    public static function enhanceEngine(?string $force = null): ?string
    {
        $im = class_exists('Imagick');
        $gd = function_exists('imagecreatefromstring') && function_exists('imageconvolution');
        if ($force === 'imagick') {
            return $im ? 'imagick' : null;
        }
        if ($force === 'gd') {
            return $gd ? 'gd' : null;
        }
        return $im ? 'imagick' : ($gd ? 'gd' : null);
    }

    /**
     * Produce (or reuse) an enhanced copy of a local image file.
     *
     * Cached under <cache_dir>/<hash>.webp (.jpg when no WebP encoder), with a
     * <hash>.json sidecar {engine, orig, enhanced}. The hash covers the source
     * (realpath + size + mtime), the normalised options, the engine and the
     * algorithm version — the same request is a cache hit.
     *
     * $opts: upscale, brightness, contrast, sharpen, auto (see enhanceOpts) plus
     *        cache_dir (default <app>/storage/thumbs/enhanced) and engine
     *        ('imagick'|'gd', default auto-detect; Imagick preferred).
     *
     * @return string absolute path of the enhanced file
     * @throws RuntimeException when the source is unusable or no engine works
     */
    public static function enhance(string $srcPath, array $opts): string
    {
        self::$lastEngine   = null;
        self::$lastCacheHit = false;
        $src = realpath($srcPath);
        if ($src === false || !is_file($src) || !is_readable($src)) {
            throw new RuntimeException('Source image not found.');
        }
        $info = @getimagesize($src);
        if (!is_array($info) || empty($info[0]) || empty($info[1])
            || !in_array((string) ($info['mime'] ?? ''), ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'], true)) {
            throw new RuntimeException('Source is not a supported image.');
        }
        [$w, $h] = [(int) $info[0], (int) $info[1]];
        if ($w * $h > self::ENHANCE_MAX_SRC_PX) {
            throw new RuntimeException('Source image is too large to enhance.');
        }
        $o      = self::enhanceOpts($opts);
        $engine = self::enhanceEngine(isset($opts['engine']) ? (string) $opts['engine'] : null);
        if ($engine === null) {
            throw new RuntimeException('No image engine (Imagick / GD) is available.');
        }
        $webp = $engine === 'imagick'
            ? in_array('WEBP', array_map('strtoupper', (array) Imagick::queryFormats('WEBP')), true)
            : function_exists('imagewebp');
        $ext  = $webp ? 'webp' : 'jpg';
        $dir  = rtrim((string) ($opts['cache_dir'] ?? (dirname(__DIR__) . '/storage/thumbs/enhanced')), '/');
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException('Enhance cache directory is not writable.');
        }
        $hash = sha1(implode('|', [self::ENHANCE_VER, $src, filesize($src), filemtime($src), json_encode($o), $engine, $ext]));
        $dest = $dir . '/' . $hash . '.' . $ext;
        $side = $dir . '/' . $hash . '.json';
        if (is_file($dest) && filesize($dest) > 0 && is_file($side)) {
            self::$lastEngine   = $engine;
            self::$lastCacheHit = true;
            @touch($dest);   // LRU hint for retention sweeps
            return $dest;
        }

        // Output size: upscale 2x, but never wider than ENHANCE_MAX_W (and never shrink).
        $f = $o['upscale'] ? min(2.0, self::ENHANCE_MAX_W / max(1, $w)) : 1.0;
        $f = max(1.0, $f);
        $nw = (int) round($w * $f);
        $nh = (int) round($h * $f);

        $tmp = $dest . '.' . bin2hex(random_bytes(4)) . '.tmp';
        if ($engine === 'imagick') {
            self::enhanceImagick($src, $tmp, $o, $nw, $nh, $ext);
        } else {
            self::enhanceGd($src, $tmp, $o, $w, $h, $nw, $nh, $ext);
        }
        if (!is_file($tmp) || filesize($tmp) <= 0) {
            @unlink($tmp);
            throw new RuntimeException('Enhancement produced no output.');
        }
        if (!@rename($tmp, $dest)) {
            @unlink($tmp);
            throw new RuntimeException('Could not store the enhanced image.');
        }
        $out = @getimagesize($dest) ?: [$nw, $nh];
        @file_put_contents($side, json_encode([
            'engine'   => $engine,
            'orig'     => ['w' => $w, 'h' => $h, 'bytes' => (int) filesize($src)],
            'enhanced' => ['w' => (int) $out[0], 'h' => (int) $out[1], 'bytes' => (int) filesize($dest)],
            'opts'     => $o,
        ], JSON_UNESCAPED_SLASHES), LOCK_EX);
        self::$lastEngine = $engine;
        return $dest;
    }

    /** Sidecar metadata of an enhanced file (or null). */
    public static function enhanceInfo(string $enhancedPath): ?array
    {
        $side = preg_replace('/\.(webp|jpg)$/', '.json', $enhancedPath);
        $j    = is_string($side) && is_file($side) ? json_decode((string) file_get_contents($side), true) : null;
        return is_array($j) ? $j : null;
    }

    /**
     * Imagick: percentile contrast stretch (0.4 % black / 0.6 % white points,
     * measured on a thumbnail, applied with levelImage whose gamma doubles as
     * the dim-frame midtone lift; autoLevel fallback) → sigmoidal
     * contrast / modulate brightness from the sliders → LANCZOS 2x → adaptive
     * sharpen (last, so it acts on the output resolution).
     */
    private static function enhanceImagick(string $src, string $dest, array $o, int $nw, int $nh, string $ext): void
    {
        try {
            // Cap ImageMagick's own pixel cache (bytes); larger work spills to disk.
            Imagick::setResourceLimit(Imagick::RESOURCETYPE_MEMORY, 256 * 1024 * 1024);
            Imagick::setResourceLimit(Imagick::RESOURCETYPE_MAP, 512 * 1024 * 1024);
            $im = new Imagick($src);
            if ($im->getNumberImages() > 1) {   // animated GIF etc.: first frame only
                $im->setIteratorIndex(0);
                $im = $im->getImage();
            }
            if (method_exists($im, 'autoOrient')) {
                $im->autoOrient();
            }
            $im->stripImage();
            if ($im->getImageColorspace() !== Imagick::COLORSPACE_SRGB) {
                $im->transformImageColorspace(Imagick::COLORSPACE_SRGB);
            }
            $q = (float) $im->getQuantumRange()['quantumRangeLong'];

            if ($o['auto']) {
                // Percentile stretch: Imagick's contrastStretchImage() point units differ
                // between IM6 / IM7 builds (a no-op on some), so measure the 0.4 % / 99.4 %
                // luminance points on a small thumbnail and apply them with levelImage(),
                // folding the dim-frame midtone lift in as its gamma.
                $lv = null;
                try {
                    $th = clone $im;
                    $th->thumbnailImage(256, 256, true);
                    $px = $th->exportImagePixels(0, 0, $th->getImageWidth(), $th->getImageHeight(), 'I', Imagick::PIXEL_CHAR);
                    $th->clear();
                    $lv = self::percentiles($px, 0.004, 0.006);
                } catch (Throwable $e) {
                    $lv = null;
                }
                if ($lv !== null && $lv[1] - $lv[0] >= 8) {
                    [$lo, $hi, $mean] = $lv;
                    $k = min(4.0, 255 / ($hi - $lo));
                    $lo = max(0, (int) round((($lo + $hi) / 2) - 127.5 / $k));   // cap the stretch at 4x
                    $hi = min(255, (int) round($lo + 255 / $k));
                    $g  = self::liftGamma(max(0.0, min(1.0, ($mean - $lo) / max(1, $hi - $lo))));
                    $im->levelImage($lo / 255 * $q, $g, $hi / 255 * $q);
                } elseif ($lv === null) {
                    $im->autoLevelImage();
                }
            }
            if ($o['contrast'] !== 0) {
                // ±50 → strength 0…5 around mid-grey.
                $im->sigmoidalContrastImage($o['contrast'] > 0, abs($o['contrast']) / 10, $q / 2);
            }
            if ($o['brightness'] !== 0) {
                $im->modulateImage(100 + $o['brightness'], 100, 100);
            }
            if ($nw !== $im->getImageWidth()) {
                $im->resizeImage($nw, $nh, Imagick::FILTER_LANCZOS, 1);
            }
            if ($o['sharpen'] > 0) {
                $im->adaptiveSharpenImage(0, 0.4 + $o['sharpen'] / 100 * 1.6);
            }
            $im->setImageFormat($ext === 'webp' ? 'webp' : 'jpeg');
            $im->setImageCompressionQuality($ext === 'webp' ? 88 : 90);
            $im->writeImage($dest);
            $im->clear();
        } catch (Throwable $e) {
            error_log('[imagetool] enhance imagick: ' . $e->getMessage());
            throw new RuntimeException('Imagick enhancement failed.');
        }
    }

    /**
     * GD: sampled-histogram percentile stretch expressed as BRIGHTNESS (centre
     * the range) + CONTRAST (scale it) filters → gamma lift → slider
     * brightness / contrast → 2x bicubic imagescale → unsharp mask as one 3x3
     * convolution ((1+a)·I − a·Gaussian).
     */
    private static function enhanceGd(string $src, string $dest, array $o, int $w, int $h, int $nw, int $nh, string $ext): void
    {
        // Working set ≈ source + scaled copy + convolution scratch, 4–5 B/px each.
        $need = (int) (($w * $h + 2 * $nw * $nh) * 5 + 32 * 1024 * 1024);
        self::ensureMemory($need);

        $im = @imagecreatefromstring((string) file_get_contents($src));
        if (!$im) {
            throw new RuntimeException('GD could not decode the source.');
        }
        if (!imageistruecolor($im)) {
            imagepalettetotruecolor($im);
        }

        if ($o['auto']) {
            [$lo, $hi] = self::gdPercentiles($im, 0.004, 0.006);
            if ($hi - $lo >= 8 && ($lo > 2 || $hi < 253)) {
                // Centre the [lo,hi] range on 127.5, then scale it to 0…255.
                // GD contrast: v' = ((v/255 − .5)·k + .5)·255 with k = ((100 − c)/100)².
                $shift = (int) round(127.5 - ($lo + $hi) / 2);
                if ($shift !== 0) {
                    imagefilter($im, IMG_FILTER_BRIGHTNESS, max(-255, min(255, $shift)));
                }
                $k = min(4.0, 255 / ($hi - $lo));
                imagefilter($im, IMG_FILTER_CONTRAST, (int) round(100 - 100 * sqrt($k)));
            }
            $mean = (float) self::gdPercentiles($im, 0.004, 0.006)[2];
            $g = self::liftGamma($mean / 255);
            if ($g > 1.01) {
                imagegammacorrect($im, 1.0, $g);
            }
        }
        if ($o['contrast'] !== 0) {
            imagefilter($im, IMG_FILTER_CONTRAST, (int) round(-$o['contrast'] * 0.6));
        }
        if ($o['brightness'] !== 0) {
            imagefilter($im, IMG_FILTER_BRIGHTNESS, (int) round($o['brightness'] * 1.5));
        }
        if ($nw !== $w) {
            $up = imagescale($im, $nw, $nh, IMG_BICUBIC);
            if ($up) {
                imagedestroy($im);
                $im = $up;
            }
        }
        if ($o['sharpen'] > 0) {
            $a = $o['sharpen'] / 100 * 1.5;
            // 16·[(1+a)·δ − a·G/16], G = [[1,2,1],[2,4,2],[1,2,1]]; divisor 16.
            $c = 16 * (1 + $a) - 4 * $a;
            imageconvolution($im, [[-$a, -2 * $a, -$a], [-2 * $a, $c, -2 * $a], [-$a, -2 * $a, -$a]], 16, 0);
        }
        $ok = $ext === 'webp' ? @imagewebp($im, $dest, 88) : @imagejpeg($im, $dest, 90);
        imagedestroy($im);
        if (!$ok) {
            throw new RuntimeException('GD could not encode the enhanced image.');
        }
    }

    /** Midtone gamma for a mean luminance (0…1): lifts dim frames, leaves normal ones. */
    private static function liftGamma(float $mean): float
    {
        return $mean >= 0.42 ? 1.0 : min(1.6, 1.0 + (0.42 - $mean) * 2.2);
    }

    /**
     * Luminance percentiles of a GD image from a ≤ ~40k-pixel grid sample.
     *
     * @return array{0:int,1:int,2:float} [lo, hi, mean]
     */
    private static function gdPercentiles($im, float $loFrac, float $hiFrac): array
    {
        $w = imagesx($im);
        $h = imagesy($im);
        $step = max(1, (int) floor(sqrt(($w * $h) / 40000)));
        $vals = [];
        for ($y = 0; $y < $h; $y += $step) {
            for ($x = 0; $x < $w; $x += $step) {
                $rgb = imagecolorat($im, $x, $y);
                $vals[] = (int) round(0.299 * (($rgb >> 16) & 0xFF) + 0.587 * (($rgb >> 8) & 0xFF) + 0.114 * ($rgb & 0xFF));
            }
        }
        return self::percentiles($vals, $loFrac, $hiFrac);
    }

    /**
     * Low / high percentile + mean of 0…255 luminance samples.
     *
     * @param int[] $vals
     * @return array{0:int,1:int,2:float} [lo, hi, mean]
     */
    private static function percentiles(array $vals, float $loFrac, float $hiFrac): array
    {
        $n = count($vals);
        if ($n === 0) {
            return [0, 255, 128.0];
        }
        $hist = array_fill(0, 256, 0);
        foreach ($vals as $v) {
            $hist[max(0, min(255, (int) $v))]++;
        }
        $lo = 0;
        $hi = 255;
        $acc = 0;
        for ($i = 0; $i < 256; $i++) {
            $acc += $hist[$i];
            if ($acc > $n * $loFrac) { $lo = $i; break; }
        }
        $acc = 0;
        for ($i = 255; $i >= 0; $i--) {
            $acc += $hist[$i];
            if ($acc > $n * $hiFrac) { $hi = $i; break; }
        }
        return [$lo, $hi, array_sum($vals) / $n];
    }

    /** Raise memory_limit (never lower it, never above 512 MB) for a GD job. */
    private static function ensureMemory(int $need): void
    {
        $cur = self::iniBytes((string) ini_get('memory_limit'));
        if ($cur < 0) {
            return;   // unlimited
        }
        $want = memory_get_usage(true) + $need;
        if ($want <= $cur) {
            return;
        }
        if ($want > 512 * 1024 * 1024) {
            throw new RuntimeException('Image too large to enhance within the memory cap.');
        }
        @ini_set('memory_limit', (string) $want);
        if (self::iniBytes((string) ini_get('memory_limit')) < $want) {
            throw new RuntimeException('Not enough memory to enhance this image.');
        }
    }

    private static function iniBytes(string $v): int
    {
        $v = trim($v);
        if ($v === '' || $v === '-1') {
            return -1;
        }
        $n = (int) $v;
        switch (strtolower(substr($v, -1))) {
            case 'g': $n *= 1024;   // fallthrough
            case 'm': $n *= 1024;   // fallthrough
            case 'k': $n *= 1024;
        }
        return $n;
    }

    /** Path to a usable cwebp binary, or null. */
    private static function cwebpBinary(): ?string
    {
        if (!function_exists('exec')) {
            return null;
        }
        $disabled = array_map('trim', explode(',', (string) ini_get('disable_functions')));
        if (in_array('exec', $disabled, true)) {
            return null;
        }
        foreach (['/usr/bin/cwebp', '/usr/local/bin/cwebp', '/opt/homebrew/bin/cwebp'] as $p) {
            if (@is_executable($p)) {
                return $p;
            }
        }
        return null;
    }

    /** Scale a GD image down so its long edge is ≤ $maxEdge. */
    private static function fit($im, int $maxEdge)
    {
        $w = imagesx($im);
        $h = imagesy($im);
        $long = max($w, $h);
        if ($long <= $maxEdge || $long === 0) {
            return $im;
        }
        $s  = $maxEdge / $long;
        $nw = max(1, (int) round($w * $s));
        $nh = max(1, (int) round($h * $s));
        $dst = imagecreatetruecolor($nw, $nh);
        imagecopyresampled($dst, $im, 0, 0, 0, 0, $nw, $nh, $w, $h);
        imagedestroy($im);
        return $dst;
    }
}
