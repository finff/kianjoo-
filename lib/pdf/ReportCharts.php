<?php
/**
 * Server-side report charts (PHP GD → PNG), for the AI report PDF and its
 * browser print twin. dompdf runs no JavaScript, so charts are rasterised here
 * and embedded as data: URIs.
 *
 * Input is the deterministic chart spec stored on the report (never LLM output):
 *   ['type' => 'bar'|'stacked'|'line'|'donut'|'hbar', 'title' => '…',
 *    'labels' => [...], 'series' => [['name' => '…', 'data' => [...], 'color' => '#hex'?], …],
 *    'unit' => '%'?, 'target' => 98?, 'target_label' => 'Target 98%'?]
 *
 * Drawn 2× supersampled then resampled down (GD has no antialiasing for thick
 * lines / arcs), at ~3 px per PDF point so it prints crisply at full text width.
 */

declare(strict_types=1);

final class ReportCharts
{
    public const PALETTE = ['#1E6BF1', '#0B1F3A', '#F59E0B', '#DC2626', '#10B981', '#8B5CF6', '#64748B', '#0EA5E9'];
    private const SS = 2;                 // supersample factor
    private const INK = '#1F2937';
    private const MUTED = '#6B7280';
    private const GRID = '#E5E9F0';
    private const AXIS = '#9CA3AF';

    /** @var \GdImage */
    private $im;
    private int $w;
    private int $h;
    private string $font;
    private string $bold;
    private array $col = [];

    public static function available(): bool
    {
        return function_exists('imagecreatetruecolor') && function_exists('imagettftext') && is_file(self::fontPath(false));
    }

    private static function fontPath(bool $bold): string
    {
        return __DIR__ . '/dompdf/vendor/dompdf/dompdf/lib/fonts/DejaVuSans' . ($bold ? '-Bold' : '') . '.ttf';
    }

    /** PNG as a data: URI, or null when GD/fonts are missing or the spec is empty. */
    public static function dataUri(array $chart, int $w = 1400, int $h = 500): ?string
    {
        $png = self::png($chart, $w, $h);
        return $png === null ? null : 'data:image/png;base64,' . base64_encode($png);
    }

    public static function png(array $chart, int $w = 1400, int $h = 500): ?string
    {
        if (!self::available() || empty($chart['series']) || !is_array($chart['series'])) {
            return null;
        }
        try {
            $c = new self($w, $h);
            switch ((string) ($chart['type'] ?? 'bar')) {
                case 'line':
                    $c->line($chart);
                    break;
                case 'donut':
                    $c->donut($chart);
                    break;
                case 'hbar':
                    $c->hbar($chart);
                    break;
                case 'stacked':
                    $c->bars($chart, true);
                    break;
                default:
                    $c->bars($chart, false);
            }
            return $c->out();
        } catch (\Throwable $e) {
            error_log('[ReportCharts] ' . $e->getMessage());
            return null;
        }
    }

    private function __construct(int $w, int $h)
    {
        $this->w    = $w;
        $this->h    = $h;
        $this->font = self::fontPath(false);
        $this->bold = self::fontPath(true);
        $this->im   = imagecreatetruecolor($w * self::SS, $h * self::SS);
        imagefill($this->im, 0, 0, $this->c('#FFFFFF'));
    }

    private function out(): string
    {
        $dst = imagecreatetruecolor($this->w, $this->h);
        imagecopyresampled($dst, $this->im, 0, 0, 0, 0, $this->w, $this->h, $this->w * self::SS, $this->h * self::SS);
        ob_start();
        imagepng($dst, null, 9);
        return (string) ob_get_clean();
    }

    // ── primitives (coordinates in final px; scaled here) ─────────

    private function c(string $hex, int $alpha = 0): int
    {
        $k = $hex . '/' . $alpha;
        if (!isset($this->col[$k])) {
            $hex = ltrim($hex, '#');
            $this->col[$k] = imagecolorallocatealpha($this->im, hexdec(substr($hex, 0, 2)), hexdec(substr($hex, 2, 2)), hexdec(substr($hex, 4, 2)), $alpha);
        }
        return $this->col[$k];
    }

    private function rect(float $x1, float $y1, float $x2, float $y2, string $hex, int $alpha = 0): void
    {
        $s = self::SS;
        imagefilledrectangle($this->im, (int) round(min($x1, $x2) * $s), (int) round(min($y1, $y2) * $s),
            (int) round(max($x1, $x2) * $s) - 1, (int) round(max($y1, $y2) * $s) - 1, $this->c($hex, $alpha));
    }

    private function ln(float $x1, float $y1, float $x2, float $y2, string $hex, float $t = 1, bool $dash = false): void
    {
        $s = self::SS;
        imagesetthickness($this->im, max(1, (int) round($t * $s)));
        if ($dash) {
            $len = hypot($x2 - $x1, $y2 - $y1);
            $n   = max(1, (int) floor($len / 10));
            for ($i = 0; $i < $n; $i += 2) {
                $a = $i / $n;
                $b = min(1, ($i + 1) / $n);
                imageline($this->im, (int) (($x1 + ($x2 - $x1) * $a) * $s), (int) (($y1 + ($y2 - $y1) * $a) * $s),
                    (int) (($x1 + ($x2 - $x1) * $b) * $s), (int) (($y1 + ($y2 - $y1) * $b) * $s), $this->c($hex));
            }
        } else {
            imageline($this->im, (int) ($x1 * $s), (int) ($y1 * $s), (int) ($x2 * $s), (int) ($y2 * $s), $this->c($hex));
        }
        imagesetthickness($this->im, 1);
    }

    /** Text width in final px. */
    private function tw(string $txt, float $px, bool $bold = false): float
    {
        $b = imagettfbbox($px * 0.75 * self::SS, 0, $bold ? $this->bold : $this->font, $txt);
        return (abs($b[2] - $b[0])) / self::SS;
    }

    /** Draw text; $align l|c|r; $y is the baseline in final px. */
    private function tx(string $txt, float $x, float $y, float $px, string $hex, string $align = 'l', bool $bold = false): void
    {
        $w = $this->tw($txt, $px, $bold);
        $x = $align === 'c' ? $x - $w / 2 : ($align === 'r' ? $x - $w : $x);
        imagettftext($this->im, $px * 0.75 * self::SS, 0, (int) round($x * self::SS), (int) round($y * self::SS), $this->c($hex),
            $bold ? $this->bold : $this->font, $txt);
    }

    private static function fmt(float $v, string $unit = ''): string
    {
        $s = abs($v - round($v)) < 0.05 ? number_format($v, 0) : number_format($v, 1);
        return $s . $unit;
    }

    /** "Nice" axis maximum + step. */
    private static function scale(float $max, int $ticks = 4): array
    {
        if ($max <= 0) {
            return [$ticks, 1.0];
        }
        $raw  = $max / $ticks;
        $mag  = 10 ** floor(log10($raw));
        $norm = $raw / $mag;
        $step = ($norm <= 1 ? 1 : ($norm <= 2 ? 2 : ($norm <= 2.5 ? 2.5 : ($norm <= 5 ? 5 : 10)))) * $mag;
        if ($step < 1 && $max >= 1) {
            $step = 1;
        }
        return [$step * (int) ceil($max / $step), $step];
    }

    private function series(array $chart): array
    {
        $out = [];
        foreach (array_values((array) $chart['series']) as $i => $s) {
            if (!is_array($s)) {
                continue;
            }
            $out[] = ['name' => (string) ($s['name'] ?? ''), 'color' => preg_match('/^#[0-9a-f]{6}$/i', (string) ($s['color'] ?? '')) ? $s['color'] : self::PALETTE[$i % count(self::PALETTE)],
                      'data' => array_map(static fn ($v) => is_numeric($v) ? (float) $v : null, array_values((array) ($s['data'] ?? [])))];
        }
        return $out;
    }

    /** Legend row at the top-left; returns its height. */
    private function legend(array $series, float $x, float $y, array $extra = []): void
    {
        foreach ($series as $s) {
            if ($s['name'] === '') {
                continue;
            }
            $this->rect($x, $y - 13, $x + 14, $y + 1, $s['color']);
            $this->tx($s['name'], $x + 21, $y, 21, self::INK);
            $x += 21 + $this->tw($s['name'], 21) + 30;
        }
        foreach ($extra as [$name, $hex]) {
            $this->ln($x, $y - 6, $x + 26, $y - 6, $hex, 2.5, true);
            $this->tx($name, $x + 33, $y, 21, self::INK);
            $x += 33 + $this->tw($name, 21) + 30;
        }
    }

    /** X labels thinned to fit; returns the label stride. */
    private function xLabels(array $labels, float $x0, float $slot, float $y): void
    {
        $n      = count($labels);
        $maxW   = 0;
        foreach ($labels as $l) {
            $maxW = max($maxW, $this->tw((string) $l, 20));
        }
        $stride = max(1, (int) ceil(($maxW + 12) / max(1, $slot)));
        foreach ($labels as $i => $l) {
            if ($i % $stride === 0 || ($i === $n - 1 && $n > 2 && ($n - 1) % $stride > $stride / 2)) {
                $this->tx((string) $l, $x0 + $slot * ($i + 0.5), $y, 20, self::MUTED, 'c');
            }
        }
    }

    // ── chart types ──────────────────────────────────────────────

    private function bars(array $chart, bool $stacked): void
    {
        $series = $this->series($chart);
        $labels = array_values(array_map('strval', (array) ($chart['labels'] ?? [])));
        $n      = count($labels);
        if ($n === 0) {
            return;
        }
        $unit = (string) ($chart['unit'] ?? '');
        $max  = 0.0;
        for ($i = 0; $i < $n; $i++) {
            $sum = 0.0;
            foreach ($series as $s) {
                $v   = (float) ($s['data'][$i] ?? 0);
                $sum = $stacked ? $sum + $v : max($sum, $v);
            }
            $max = max($max, $sum);
        }
        [$top, $step] = self::scale($max * 1.05, 5);
        $L = 84; $R = $this->w - 16; $T = 66; $B = $this->h - 52;
        $this->legend($series, $L, 26);
        for ($v = 0.0; $v <= $top + 1e-9; $v += $step) {
            $y = $B - ($B - $T) * $v / $top;
            $this->ln($L, $y, $R, $y, $v == 0.0 ? self::AXIS : self::GRID, $v == 0.0 ? 1.5 : 1);
            $this->tx(self::fmt($v, $unit), $L - 12, $y + 6, 20, self::MUTED, 'r');
        }
        $slot = ($R - $L) / $n;
        $k    = $stacked ? 1 : max(1, count($series));
        $bw   = min($stacked ? 64 : 60 * $k, $slot * ($n > 20 ? 0.72 : 0.66)) / $k;
        $showVals = $n <= 16;
        for ($i = 0; $i < $n; $i++) {
            $cx  = $L + $slot * ($i + 0.5);
            $acc = 0.0;
            foreach ($series as $j => $s) {
                $v = (float) ($s['data'][$i] ?? 0);
                if ($stacked) {
                    $y1 = $B - ($B - $T) * $acc / $top;
                    $acc += $v;
                    $y2 = $B - ($B - $T) * $acc / $top;
                    if ($v > 0) {
                        $this->rect($cx - $bw / 2, $y2, $cx + $bw / 2, $y1, $s['color']);
                    }
                } else {
                    $x = $cx - $bw * $k / 2 + $bw * $j;
                    $y = $B - ($B - $T) * $v / $top;
                    if ($v > 0) {
                        $this->rect($x + 1.5, $y, $x + $bw - 1.5, $B, $s['color']);
                    }
                    if ($showVals && $v > 0) {
                        $this->tx(self::fmt($v, $unit), $x + $bw / 2, $y - 7, 18, self::INK, 'c', true);
                    }
                }
            }
            if ($stacked && $showVals && $acc > 0) {
                $this->tx(self::fmt($acc, $unit), $cx, $B - ($B - $T) * $acc / $top - 7, 18, self::INK, 'c', true);
            }
        }
        $this->xLabels($labels, $L, $slot, $B + 30);
    }

    private function line(array $chart): void
    {
        $series = $this->series($chart);
        $labels = array_values(array_map('strval', (array) ($chart['labels'] ?? [])));
        $n      = count($labels);
        if ($n === 0) {
            return;
        }
        $unit   = (string) ($chart['unit'] ?? '');
        $target = isset($chart['target']) && is_numeric($chart['target']) ? (float) $chart['target'] : null;
        $vals   = [];
        foreach ($series as $s) {
            foreach ($s['data'] as $v) {
                if ($v !== null) {
                    $vals[] = $v;
                }
            }
        }
        if ($target !== null) {
            $vals[] = $target;
        }
        $lo = $vals ? min($vals) : 0;
        $hi = $vals ? max($vals) : 1;
        if ($unit === '%') {
            $top = min(100.0, max(10.0, ceil(($hi + 1) / 5) * 5));
            $bot = max(0.0, floor(($lo - 4) / 5) * 5);
            $step = ($top - $bot) / 4;
        } else {
            $bot = 0.0;
            [$top, $step] = self::scale($hi * 1.1);
        }
        if ($top - $bot < 1e-6) {
            $top = $bot + 1;
            $step = 0.25;
        }
        $L = 84; $R = $this->w - 20; $T = 66; $B = $this->h - 52;
        $this->legend($series, $L, 26, $target !== null ? [[(string) ($chart['target_label'] ?? ('Target ' . self::fmt($target, $unit))), '#DC2626']] : []);
        for ($v = $bot; $v <= $top + 1e-9; $v += $step) {
            $y = $B - ($B - $T) * ($v - $bot) / ($top - $bot);
            $this->ln($L, $y, $R, $y, $v == $bot ? self::AXIS : self::GRID, $v == $bot ? 1.5 : 1);
            $this->tx(self::fmt($v, $unit), $L - 12, $y + 6, 20, self::MUTED, 'r');
        }
        $slot = ($R - $L) / $n;
        $py   = fn ($v) => $B - ($B - $T) * (max($bot, min($top, $v)) - $bot) / ($top - $bot);
        if ($target !== null) {
            $this->ln($L, $py($target), $R, $py($target), '#DC2626', 2, true);
        }
        foreach ($series as $j => $s) {
            $pts = [];
            foreach ($s['data'] as $i => $v) {
                if ($v !== null && $i < $n) {
                    $pts[] = [$L + $slot * ($i + 0.5), $py($v), $v];
                }
            }
            if (!$pts) {
                continue;
            }
            if ($j === 0 && count($pts) > 1) {            // soft area under the primary series
                $poly = [];
                foreach ($pts as [$x, $y]) {
                    $poly[] = (int) ($x * self::SS);
                    $poly[] = (int) ($y * self::SS);
                }
                $poly[] = (int) ($pts[count($pts) - 1][0] * self::SS);
                $poly[] = (int) ($B * self::SS);
                $poly[] = (int) ($pts[0][0] * self::SS);
                $poly[] = (int) ($B * self::SS);
                imagefilledpolygon($this->im, $poly, $this->c($s['color'], 112));
            }
            for ($i = 1; $i < count($pts); $i++) {
                $this->ln($pts[$i - 1][0], $pts[$i - 1][1], $pts[$i][0], $pts[$i][1], $s['color'], 3);
            }
            $label = count($pts) <= 14;
            foreach ($pts as $i => [$x, $y, $v]) {
                $r = 5 * self::SS;
                imagefilledellipse($this->im, (int) ($x * self::SS), (int) ($y * self::SS), $r * 2, $r * 2, $this->c($s['color']));
                imagefilledellipse($this->im, (int) ($x * self::SS), (int) ($y * self::SS), (int) ($r * 0.9), (int) ($r * 0.9), $this->c('#FFFFFF'));
                $isMin = $v === min(array_column($pts, 2));
                if ($label || $i === count($pts) - 1 || $isMin) {
                    $this->tx(self::fmt($v, $unit), $x, $y - 13, 18, $target !== null && $v < $target ? '#B42318' : self::INK, 'c', true);
                }
            }
        }
        $this->xLabels($labels, $L, $slot, $B + 30);
    }

    private function donut(array $chart): void
    {
        $s      = $this->series($chart)[0] ?? null;
        $labels = array_values(array_map('strval', (array) ($chart['labels'] ?? [])));
        if (!$s) {
            return;
        }
        $colors = array_values((array) ($chart['colors'] ?? []));
        $items  = [];
        foreach ($labels as $i => $l) {
            $v = (float) ($s['data'][$i] ?? 0);
            if ($v > 0) {
                $items[] = [$l, $v, preg_match('/^#[0-9a-f]{6}$/i', (string) ($colors[$i] ?? '')) ? $colors[$i] : self::PALETTE[$i % count(self::PALETTE)]];
            }
        }
        $total = array_sum(array_column($items, 1));
        $cx = $this->h * 0.52 + 10; $cy = $this->h / 2; $r = $this->h * 0.42;
        $S  = self::SS;
        if ($total <= 0) {
            imagefilledellipse($this->im, (int) ($cx * $S), (int) ($cy * $S), (int) (2 * $r * $S), (int) (2 * $r * $S), $this->c(self::GRID));
        } else {
            $a = -90.0;
            foreach ($items as [$l, $v, $hex]) {
                $sweep = 360 * $v / $total;
                $e = $a + $sweep;
                if ($sweep >= 0.5) {
                    imagefilledarc($this->im, (int) ($cx * $S), (int) ($cy * $S), (int) (2 * $r * $S), (int) (2 * $r * $S),
                        (int) round($a), (int) round($e), $this->c($hex), IMG_ARC_PIE);
                }
                $a = $e;
            }
            if (count($items) > 1) {                        // thin white separators
                $a = -90.0;
                foreach ($items as [$l, $v]) {
                    $rad = deg2rad($a);
                    $this->ln($cx, $cy, $cx + cos($rad) * ($r + 2), $cy + sin($rad) * ($r + 2), '#FFFFFF', 3);
                    $a += 360 * $v / $total;
                }
            }
        }
        $ri = $r * 0.6;
        imagefilledellipse($this->im, (int) ($cx * $S), (int) ($cy * $S), (int) (2 * $ri * $S), (int) (2 * $ri * $S), $this->c('#FFFFFF'));
        $this->tx(self::fmt($total), $cx, $cy + 8, 40, '#0B1F3A', 'c', true);
        $this->tx((string) ($chart['center_label'] ?? 'Total'), $cx, $cy + 38, 16, self::MUTED, 'c');
        // Legend table on the right.
        $x  = $cx + $r + 70;
        $rowH = min(44, ($this->h - 40) / max(1, count($items)));
        $y  = $cy - $rowH * count($items) / 2 + $rowH * 0.7;
        $xr = $this->w - 30;
        foreach ($items as [$l, $v, $hex]) {
            $this->rect($x, $y - 15, $x + 16, $y + 1, $hex);
            $this->tx($l, $x + 28, $y, 21, self::INK);
            $this->tx(self::fmt($v), $xr - 110, $y, 21, self::INK, 'r', true);
            $this->tx(self::fmt(100 * $v / max(1, $total)) . '%', $xr, $y, 21, self::MUTED, 'r');
            $this->ln($x, $y + $rowH * 0.32, $xr, $y + $rowH * 0.32, self::GRID, 1);
            $y += $rowH;
        }
    }

    private function hbar(array $chart): void
    {
        $s      = $this->series($chart)[0] ?? null;
        $labels = array_values(array_map('strval', (array) ($chart['labels'] ?? [])));
        $n      = count($labels);
        if (!$s || $n === 0) {
            return;
        }
        $max = max(1.0, max(array_map(static fn ($v) => (float) $v, $s['data'] ?: [0])));
        $lw  = 0;
        foreach ($labels as $l) {
            $lw = max($lw, $this->tw($l, 20));
        }
        $L = min(420, $lw + 30); $R = $this->w - 90; $T = 18; $B = $this->h - 14;
        $rowH = ($B - $T) / $n;
        $bh   = min(30, $rowH * 0.62);
        foreach ($labels as $i => $l) {
            $v  = (float) ($s['data'][$i] ?? 0);
            $cy = $T + $rowH * ($i + 0.5);
            $this->tx($l, $L - 16, $cy + 7, 20, self::INK, 'r');
            $this->rect($L, $cy - $bh / 2, $R, $cy + $bh / 2, '#F1F4F8');
            $this->rect($L, $cy - $bh / 2, $L + ($R - $L) * $v / $max, $cy + $bh / 2, $i === 0 ? '#0B1F3A' : $s['color']);
            $this->tx(self::fmt($v, (string) ($chart['unit'] ?? '')), $R + 14, $cy + 7, 20, self::INK, 'l', true);
        }
    }
}
