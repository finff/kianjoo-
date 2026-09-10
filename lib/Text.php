<?php
/**
 * Text sanitiser for strings coming out of SenseStudio.
 *
 * SenseStudio returns several fields in Chinese (deviceTypeName, deviceCnName,
 * targetCnName/targetCnOption, some policy names). The dashboard is English-
 * only, so every SenseStudio-sourced string is passed through Text::latin():
 * known terms are translated, anything else CJK is stripped, and an empty
 * result falls back to whatever the caller supplies.
 */

declare(strict_types=1);

final class Text
{
    /** Common SenseStudio terms → English. Longest keys first when replacing. */
    private const TERMS = [
        '网络摄像机'   => 'IP Camera',
        '半球摄像机'   => 'Dome Camera',
        '枪型摄像机'   => 'Bullet Camera',
        '球型摄像机'   => 'PTZ Camera',
        '人脸抓拍机'   => 'Face Capture Camera',
        '摄像机'      => 'Camera',
        '球机'        => 'PTZ Camera',
        '枪机'        => 'Bullet Camera',
        '门禁'        => 'Access Control',
        '闸机'        => 'Gate',
        '人脸'        => 'Face',
        '人体'        => 'Body',
        '车辆'        => 'Vehicle',
        '非机动车'    => 'Non-motor Vehicle',
        '陌生人'      => 'Stranger',
        '未知'        => 'Unknown',
        '是'          => 'Yes',
        '否'          => 'No',
        '男'          => 'Male',
        '女'          => 'Female',
    ];

    /** CJK ideographs, kana, CJK punctuation and full-width forms. */
    private const CJK = '/[\x{2E80}-\x{9FFF}\x{3000}-\x{303F}\x{FF00}-\x{FFEF}]+/u';

    /** True when the string contains any CJK/full-width character. */
    public static function hasCjk(?string $s): bool
    {
        return $s !== null && $s !== '' && preg_match(self::CJK, $s) === 1;
    }

    /**
     * Translate what we know, strip the rest, tidy the leftovers.
     * Returns $fallback when nothing printable survives.
     */
    public static function latin(?string $s, string $fallback = ''): string
    {
        $s = trim((string) $s);
        if ($s === '') {
            return $fallback;
        }
        if (!self::hasCjk($s)) {
            return $s;
        }
        $s = strtr($s, self::TERMS);
        $s = (string) preg_replace(self::CJK, ' ', $s);
        // Tidy separators left behind by the removal (" · ", "--", double spaces).
        $s = (string) preg_replace('/\s+/', ' ', $s);
        $s = trim($s, " \t\n\r\0\x0B-_·,;:/|");
        return $s !== '' ? $s : $fallback;
    }

    /** Apply latin() to every string in an array, recursively. */
    public static function latinDeep(array $rows): array
    {
        foreach ($rows as $k => $v) {
            if (is_string($v)) {
                $rows[$k] = self::latin($v);
            } elseif (is_array($v)) {
                $rows[$k] = self::latinDeep($v);
            }
        }
        return $rows;
    }
}
