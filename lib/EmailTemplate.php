<?php
/**
 * Branded, email-client-safe HTML template for all outgoing mail
 * (detection alerts, escalations, reports, tests). Table layout + inline
 * styles only — no flex/grid/webfonts, so it renders correctly in Gmail,
 * Outlook and mobile clients.
 */

declare(strict_types=1);

final class EmailTemplate
{
    // Legacy fallback only — real deployments set this via config.php from
    // APP_URL (or auto-detect off the request host). Never hardcode a domain
    // here again; the next redeploy shouldn't need a code change for it.
    private const HOST_FALLBACK = 'https://tm-next-series.weststar-dev.com';
    private static string $hostOverride = '';
    private const FONT = 'font-family:Arial,Helvetica,sans-serif;';

    public static function setHost(string $url): void
    {
        self::$hostOverride = rtrim(trim($url), '/');
    }

    public static function host(): string
    {
        return self::$hostOverride !== '' ? self::$hostOverride : self::HOST_FALLBACK;
    }

    public const COLORS = [
        'critical' => '#E23434', 'high' => '#E77320', 'medium' => '#D89A16',
        'low' => '#2E7FD6', 'brand' => '#3826F2', 'ok' => '#199468', 'neutral' => '#525A78',
    ];

    /** Full document: header, colored banner, white content card, footer. */
    public static function shell(string $preheader, string $bannerLabel, string $bannerColor, string $content, string $footerNote = ''): string
    {
        $host = self::host();
        $pre  = htmlspecialchars($preheader);
        $date = date('D, d M Y H:i') . ' MYT';
        $foot = $footerNote !== '' ? $footerNote
            : 'You are receiving this because you are an alert recipient. Manage recipients and rules on the dashboard under <b>Alert Rules</b>.';
        return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>'
            . '<body style="margin:0;padding:0;background-color:#EDEFF7;">'
            . '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' . $pre . '</div>'
            . '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#EDEFF7">'
            . '<tr><td align="center" style="padding:28px 12px;">'
            . '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;">'
            // header
            . '<tr><td bgcolor="#11160E" style="border-radius:14px 14px 0 0;padding:20px 28px;">'
            . '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
            . '<td valign="middle"><img src="' . $host . '/uploads/AIVA-Logo.png" width="156" height="34" alt="AIVA" style="display:block;border-radius:9px;background:#ffffff;padding:3px 6px;"></td>'
            . '<td valign="middle" style="padding-left:13px;' . self::FONT . '">'
            . '<div style="font-size:16px;font-weight:bold;color:#ffffff;line-height:1.2;">AIVA Dashboard</div>'
            . '<div style="font-size:10px;letter-spacing:2px;color:#9AA1BD;">AI VIDEO ANALYTICS &middot; MONITORING</div>'
            . '</td></tr></table></td></tr>'
            // banner
            . '<tr><td bgcolor="' . $bannerColor . '" style="padding:10px 28px;' . self::FONT
            . 'font-size:12px;font-weight:bold;letter-spacing:1.5px;color:#ffffff;">' . htmlspecialchars($bannerLabel) . '</td></tr>'
            // content
            . '<tr><td bgcolor="#ffffff" style="padding:26px 28px;' . self::FONT . 'color:#1A2033;">' . $content . '</td></tr>'
            // footer
            . '<tr><td bgcolor="#F3F5FC" style="border-radius:0 0 14px 14px;padding:16px 28px;' . self::FONT
            . 'font-size:11px;color:#868DA8;line-height:1.7;border-top:1px solid #E2E5F1;">'
            . 'Automated notification from <b>AIVA Dashboard Monitoring</b> &middot; ' . $date . '<br>' . $foot
            . '</td></tr>'
            . '</table></td></tr></table></body></html>';
    }

    public static function heading(string $text, string $color = '#1A2033'): string
    {
        return '<div style="' . self::FONT . 'font-size:19px;font-weight:bold;color:' . $color . ';line-height:1.35;margin:0 0 6px;">'
            . htmlspecialchars($text) . '</div>';
    }

    public static function sub(string $text): string
    {
        return '<div style="' . self::FONT . 'font-size:13px;color:#525A78;line-height:1.5;margin:0 0 18px;">'
            . htmlspecialchars($text) . '</div>';
    }

    public static function p(string $html): string
    {
        return '<div style="' . self::FONT . 'font-size:13.5px;color:#33394F;line-height:1.65;margin:0 0 14px;">' . $html . '</div>';
    }

    /** Severity / status chip. */
    public static function chip(string $label, string $color): string
    {
        return '<span style="display:inline-block;' . self::FONT . 'font-size:11px;font-weight:bold;color:' . $color
            . ';border:2px solid ' . $color . ';border-radius:14px;padding:3px 12px;text-transform:uppercase;">'
            . htmlspecialchars($label) . '</span>';
    }

    /** Key/value details table. Rows: [label, value, optional hex color]. */
    public static function rows(array $kv): string
    {
        $out = '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" '
             . 'style="margin:6px 0 18px;border:1px solid #E7EAF4;border-radius:10px;">';
        $i = 0;
        foreach ($kv as $r) {
            if ($r === null) {
                continue;
            }
            [$k, $v] = $r;
            $col = $r[2] ?? '#1A2033';
            $bg  = $i++ % 2 === 0 ? '#FAFBFE' : '#ffffff';
            $out .= '<tr><td bgcolor="' . $bg . '" style="' . self::FONT . 'font-size:12px;color:#868DA8;padding:9px 14px;width:170px;border-bottom:1px solid #EEF1F8;">'
                . htmlspecialchars($k) . '</td>'
                . '<td bgcolor="' . $bg . '" style="' . self::FONT . 'font-size:12.5px;font-weight:bold;color:' . $col
                . ';padding:9px 14px;border-bottom:1px solid #EEF1F8;">' . htmlspecialchars($v) . '</td></tr>';
        }
        return $out . '</table>';
    }

    /** Operator note / quoted message. */
    public static function note(string $text, string $label = 'NOTE'): string
    {
        return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;"><tr>'
            . '<td style="background:#F4F5FB;border-left:4px solid #3826F2;border-radius:0 9px 9px 0;padding:12px 16px;">'
            . '<div style="' . self::FONT . 'font-size:10px;font-weight:bold;letter-spacing:1px;color:#868DA8;margin-bottom:4px;">' . htmlspecialchars($label) . '</div>'
            . '<div style="' . self::FONT . 'font-size:13px;color:#33394F;line-height:1.6;">' . htmlspecialchars($text) . '</div>'
            . '</td></tr></table>';
    }

    /** Inline evidence frame (degrades to a bordered placeholder note if blocked). */
    public static function image(?string $url, string $caption = 'Detection frame'): string
    {
        if (!$url) {
            return '';
        }
        return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 18px;"><tr><td>'
            . '<a href="' . htmlspecialchars($url) . '" style="text-decoration:none;">'
            . '<img src="' . htmlspecialchars($url) . '" width="544" alt="' . htmlspecialchars($caption) . '" '
            . 'style="display:block;width:100%;max-width:544px;border-radius:10px;border:1px solid #E2E5F1;"></a>'
            . '<div style="' . self::FONT . 'font-size:10.5px;color:#868DA8;padding-top:6px;">' . htmlspecialchars($caption)
            . ' &middot; click to open full size</div>'
            . '</td></tr></table>';
    }

    /** Bulletproof CTA buttons row. $buttons: [label, url, solid?, color?]. */
    public static function buttons(array $buttons): string
    {
        $cells = '';
        foreach ($buttons as $b) {
            [$label, $url] = $b;
            $solid = $b[2] ?? true;
            $color = $b[3] ?? self::COLORS['brand'];
            $style = $solid
                ? 'background:' . $color . ';color:#ffffff;border:2px solid ' . $color . ';'
                : 'background:#ffffff;color:' . $color . ';border:2px solid ' . $color . ';';
            $cells .= '<td style="padding:0 10px 0 0;"><a href="' . htmlspecialchars($url) . '" '
                . 'style="display:inline-block;' . self::FONT . 'font-size:12.5px;font-weight:bold;text-decoration:none;'
                . 'border-radius:9px;padding:11px 20px;' . $style . '">' . htmlspecialchars($label) . '</a></td>';
        }
        return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 6px;"><tr>' . $cells . '</tr></table>';
    }

    public static function sevColor(string $sev): string
    {
        return self::COLORS[strtolower($sev)] ?? self::COLORS['neutral'];
    }
}
