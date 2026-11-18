<?php
/**
 * Three face photos per employee: front (person_profiles.photo_url — the
 * existing `photo`), left side and right side (photo_left / photo_right).
 *
 * SenseStudio (API doc V2.13, §2.2.1 Create Person / §2.2.5 Update Person)
 * holds exactly ONE face image per person (`imageURI`, a single string); there
 * is no endpoint to attach further images to a person. So the FRONT photo is
 * the one enrolled for matching, and each side photo is run through the same
 * enrolment face check (§7.2.1 uploadImageBase64, serviceType "person") so the
 * operator learns whether SenseStudio accepts it — see Attendance::sync().
 * The verdicts are kept in person_profiles.ss_faces.
 *
 * Uploads: same limits as POST /persons/photo (6 MB, JPG/PNG/WEBP/GIF), then
 * re-encoded to JPEG (EXIF rotation applied, long edge ≤ 1280 px) because
 * SenseStudio only takes JPG/PNG under 2 MB. Stored as
 * uploads/profiles/p{personId}-{side}-{stamp}-{rand}.jpg.
 */

declare(strict_types=1);

require_once __DIR__ . '/ImageTool.php';

final class Faces
{
    /** side => person_profiles column */
    public const SIDES = ['front' => 'photo_url', 'left' => 'photo_left', 'right' => 'photo_right'];
    public const LABELS = ['front' => 'Front', 'left' => 'Left side', 'right' => 'Right side'];
    public const MAX_BYTES = 6 * 1024 * 1024;   // same limit as POST /persons/photo
    public const MAX_EDGE  = 1280;
    public const MIN_EDGE  = 240;               // SenseStudio: photo ≥ 320×240, face ≥ 100 px
    /** SenseStudio enrolment images: JPG/PNG, < 2 MB (User Manual §2.2.1 / Product Spec §1.5). */
    public const ENROL_MAX_BYTES = 2 * 1024 * 1024 - 1024;

    public function __construct(private PDO $pdo, private string $appRoot)
    {
    }

    public static function validSide(string $side): bool
    {
        return isset(self::SIDES[$side]);
    }

    /**
     * Validate + re-encode an uploaded face photo and store it under
     * uploads/profiles. Returns the public URL (/uploads/profiles/…).
     */
    public function storeUpload(string $personId, string $side, string $bytes): string
    {
        if (!self::validSide($side)) {
            throw new InvalidArgumentException('side must be front, left or right.');
        }
        if ($bytes === '' || strlen($bytes) > self::MAX_BYTES) {
            throw new InvalidArgumentException('Max image size 6 MB.');
        }
        $mime = ImageTool::mimeOf($bytes);
        if (!in_array($mime, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'], true)) {
            throw new InvalidArgumentException('Only JPG, PNG, WEBP or GIF images are accepted.');
        }
        $info = @getimagesizefromstring($bytes);
        if (is_array($info) && min((int) $info[0], (int) $info[1]) < self::MIN_EDGE) {
            throw new InvalidArgumentException('That photo is too small (' . (int) $info[0] . '×' . (int) $info[1]
                . ' px) — SenseStudio needs at least 320×240 with the face filling most of the picture.');
        }
        [$out, $ext] = self::normalise($bytes, $mime, self::MAX_EDGE, 88);
        $pid  = preg_replace('/[^A-Za-z0-9_\-]/', '', $personId) ?: 'new';
        $dir  = rtrim($this->appRoot, '/') . '/uploads/profiles';
        if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new RuntimeException('Could not create the upload folder.');
        }
        $name = 'p' . $pid . '-' . $side . '-' . date('YmdHis') . '-' . bin2hex(random_bytes(3)) . '.' . $ext;
        if (@file_put_contents($dir . '/' . $name, $out, LOCK_EX) === false) {
            throw new RuntimeException('Upload failed.');
        }
        @chmod($dir . '/' . $name, 0644);
        return '/uploads/profiles/' . $name;
    }

    /** The raw person_profiles row (null when missing). */
    public function row(string $personId): ?array
    {
        $st = $this->pdo->prepare('SELECT * FROM person_profiles WHERE person_id = :p');
        $st->execute(['p' => $personId]);
        $r = $st->fetch();
        return $r ?: null;
    }

    /**
     * Set (or clear with null) one side's photo. The stored SenseStudio verdict
     * for that side is dropped so the next sync re-checks the new picture.
     */
    public function setPhoto(string $personId, string $side, ?string $url): bool
    {
        if (!self::validSide($side)) {
            throw new InvalidArgumentException('side must be front, left or right.');
        }
        $row = $this->row($personId);
        if ($row === null) {
            return false;
        }
        $faces = self::decode($row['ss_faces'] ?? null);
        unset($faces[$side]);
        $col = self::SIDES[$side];
        $st  = $this->pdo->prepare("UPDATE person_profiles SET {$col} = :u, ss_faces = :f, updated_at = :t WHERE person_id = :p");
        return $st->execute(['u' => $url, 'f' => $faces ? json_encode($faces, JSON_UNESCAPED_SLASHES) : null,
                             't' => date('Y-m-d H:i:s'), 'p' => $personId]);
    }

    /** Remove a photo file we stored ourselves (never anything outside uploads/profiles/p…). */
    public function deleteFile(?string $url, string $personId): void
    {
        $pid = preg_replace('/[^A-Za-z0-9_\-]/', '', $personId);
        if ($pid !== '' && $url !== null
            && preg_match('#^/?uploads/profiles/(p' . preg_quote($pid, '#') . '-(?:left|right|front)-\d{14}-[0-9a-f]{6}\.(?:jpg|png))$#', $url, $m)) {
            @unlink(rtrim($this->appRoot, '/') . '/uploads/profiles/' . $m[1]);
        }
    }

    /**
     * Per-side summary for the UI:
     *   {front|left|right: {url, label, check:{state,msg,at}|null}} + count.
     */
    public static function summary(array $row): array
    {
        $faces = self::decode($row['ss_faces'] ?? null);
        $out   = ['sides' => [], 'count' => 0];
        foreach (self::SIDES as $side => $col) {
            $url = (string) ($row[$col] ?? '');
            if ($url !== '' && !preg_match('#^https?://#i', $url) && preg_match('#^/?uploads/#i', $url)) {
                $url = '/' . ltrim($url, '/');
            }
            $chk = $faces[$side] ?? null;
            // A verdict about an older picture says nothing about this one.
            if (is_array($chk) && ($chk['src'] ?? '') !== '' && $url !== '' && !self::sameSrc((string) $chk['src'], $url)) {
                $chk = null;
            }
            $out['sides'][$side] = [
                'url'   => $url,
                'label' => self::LABELS[$side],
                'check' => $url !== '' && is_array($chk) ? [
                    'state' => (string) ($chk['state'] ?? ''),
                    'msg'   => (string) ($chk['msg'] ?? ''),
                    'at'    => (string) ($chk['at'] ?? ''),
                ] : null,
            ];
            if ($url !== '') {
                $out['count']++;
            }
        }
        return $out;
    }

    /** Two references to the same stored photo (tolerates a leading slash / absolute host). */
    public static function sameSrc(string $a, string $b): bool
    {
        $n = static fn (string $u): string => ltrim((string) preg_replace('#^https?://[^/]+#i', '', $u), '/');
        return $n($a) === $n($b);
    }

    public static function decode($json): array
    {
        $d = is_string($json) && $json !== '' ? json_decode($json, true) : null;
        if (!is_array($d)) {
            return [];
        }
        return array_intersect_key($d, self::SIDES);
    }

    /**
     * Bytes SenseStudio will take for enrolment: JPG/PNG under 2 MB. Anything
     * else (WEBP / GIF / BMP / oversized) is re-encoded to JPEG; returns the
     * input unchanged if it is already fine or GD is unavailable.
     */
    public static function forEnrol(string $bytes): string
    {
        $mime = ImageTool::mimeOf($bytes);
        if (in_array($mime, ['image/jpeg', 'image/png'], true) && strlen($bytes) <= self::ENROL_MAX_BYTES) {
            return $bytes;
        }
        try {
            [$out] = self::normalise($bytes, (string) $mime, self::MAX_EDGE, 85);
            return $out;
        } catch (Throwable $e) {
            return $bytes;   // let SenseStudio give its own verdict
        }
    }

    /**
     * Decode → apply EXIF orientation → shrink (long edge ≤ $maxEdge) → JPEG.
     * Phone cameras store portrait shots rotated with an EXIF flag that a GD
     * re-encode would lose, so the rotation is baked in here.
     *
     * @return array{0:string,1:string}  [bytes, extension]
     */
    public static function normalise(string $bytes, string $mime, int $maxEdge, int $quality): array
    {
        $keepExt = $mime === 'image/png' ? 'png' : 'jpg';
        if (!function_exists('imagecreatefromstring') || !function_exists('imagejpeg')) {
            // No GD: store as-is only when SenseStudio can still read it.
            if (in_array($mime, ['image/jpeg', 'image/png'], true)) {
                return [$bytes, $keepExt];
            }
            throw new RuntimeException('This server cannot convert ' . $mime . ' photos — upload a JPG or PNG.');
        }
        $im = @imagecreatefromstring($bytes);
        if (!$im) {
            throw new InvalidArgumentException('The photo could not be read.');
        }
        if (!imageistruecolor($im)) {
            imagepalettetotruecolor($im);
        }
        $orient = self::exifOrientation($bytes, $mime);
        $rot = [3 => 180, 6 => -90, 8 => 90][$orient] ?? 0;
        if ($rot !== 0) {
            $r = imagerotate($im, $rot, 0);
            if ($r) {
                imagedestroy($im);
                $im = $r;
            }
        }
        $w = imagesx($im);
        $h = imagesy($im);
        if (max($w, $h) > $maxEdge) {
            $s  = $maxEdge / max($w, $h);
            $nw = max(1, (int) round($w * $s));
            $nh = max(1, (int) round($h * $s));
            $dst = imagecreatetruecolor($nw, $nh);
            // Flatten transparency onto white (JPEG has no alpha).
            imagefill($dst, 0, 0, (int) imagecolorallocate($dst, 255, 255, 255));
            imagecopyresampled($dst, $im, 0, 0, 0, 0, $nw, $nh, $w, $h);
            imagedestroy($im);
            $im = $dst;
        } elseif ($mime !== 'image/jpeg') {
            $dst = imagecreatetruecolor($w, $h);
            imagefill($dst, 0, 0, (int) imagecolorallocate($dst, 255, 255, 255));
            imagecopy($dst, $im, 0, 0, 0, 0, $w, $h);
            imagedestroy($im);
            $im = $dst;
        }
        ob_start();
        imagejpeg($im, null, max(60, min(95, $quality)));
        $out = (string) ob_get_clean();
        imagedestroy($im);
        if ($out === '') {
            throw new RuntimeException('The photo could not be converted.');
        }
        return [$out, 'jpg'];
    }

    private static function exifOrientation(string $bytes, string $mime): int
    {
        if ($mime !== 'image/jpeg' || !function_exists('exif_read_data')) {
            return 1;
        }
        $exif = @exif_read_data('data://image/jpeg;base64,' . base64_encode($bytes));
        return is_array($exif) ? (int) ($exif['Orientation'] ?? 1) : 1;
    }

    /**
     * Run one SIDE photo through SenseStudio's enrolment face check
     * (§7.2.1 uploadImageBase64, serviceType "person" — the same check the
     * front photo passes before Create/Update Person). Nothing is attached to
     * the person: SenseStudio holds one image per person.
     *
     * @return array{state:string,msg:string,src:string,uri?:string,at:string}
     *         state: accepted | rejected (SenseStudio's verdict) | error (no verdict — retry later)
     */
    public static function checkSide(SenseApi $api, string $raw, string $staffTag, string $side, string $src): array
    {
        $now = date('Y-m-d H:i:s');
        $up  = $api->uploadPersonImage(self::forEnrol($raw), 'emp-' . $staffTag . '-' . $side . '.jpg');
        if (!empty($up['ok']) && is_string($up['data'] ?? null) && $up['data'] !== '') {
            return ['state' => 'accepted',
                    'msg' => 'passed SenseStudio\'s face check — kept on the dashboard (SenseStudio matches on the front photo)',
                    'src' => $src, 'uri' => (string) $up['data'], 'at' => $now];
        }
        // A reply with a code is SenseStudio's verdict; none = network/auth trouble (retry next time).
        return ['state' => isset($up['code']) ? 'rejected' : 'error',
                'msg' => self::reason((string) ($up['msg'] ?? $up['error'] ?? ''), $side),
                'src' => $src, 'at' => $now];
    }

    /** Store one side's verdict in person_profiles.ss_faces (other sides kept). */
    public function saveCheck(string $personId, string $side, array $verdict): void
    {
        $row = $this->row($personId);
        if ($row === null) {
            return;
        }
        $faces = self::decode($row['ss_faces'] ?? null);
        $faces[$side] = $verdict;
        $this->pdo->prepare('UPDATE person_profiles SET ss_faces = :f WHERE person_id = :p')
            ->execute(['f' => json_encode($faces, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), 'p' => $personId]);
    }

    /**
     * Turn SenseStudio's rejection text into an operator-friendly reason.
     * Known messages: 未发现人脸 = no face found, 图片质量不合法 = image quality too low.
     */
    public static function reason(string $raw, string $side): string
    {
        $front = $side === 'front';
        if (preg_match('/未发现人脸|no face/i', $raw)) {
            return $front ? 'no face found — use a clear, front-facing photo'
                          : 'no face found — SenseStudio could not detect a face at this angle';
        }
        if (preg_match('/图片质量|quality/i', $raw)) {
            return $front ? 'photo quality too low — use a sharper, closer face photo'
                          : 'photo quality too low — SenseStudio\'s enrolment check expects a sharp, near-frontal face; strongly turned faces usually fail (try a smaller turn, about 15–20°)';
        }
        return $raw !== '' ? $raw : 'upload failed';
    }
}
