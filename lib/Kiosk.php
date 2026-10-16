<?php
/**
 * Browser check-in kiosk (attendance by face).
 *
 * The kiosk page runs face detection + a 128-d face descriptor in the
 * browser (face-api.js) and posts the descriptor, the estimated attributes
 * and a JPEG snapshot here. Matching happens server-side so the enrolled
 * templates never leave the server:
 *
 *   best euclidean distance < MATCH_DIST  → that person_id
 *   otherwise                             → a recurring "unknown" id (its
 *                                           descriptor is kept so the same
 *                                           face maps to the same id), which
 *                                           HR can later enrol from the
 *                                           Attendance tab
 *
 * A person_id is "known" once it has a person_profiles row — the same rule
 * the SenseStudio-fed attendance already uses.
 */

declare(strict_types=1);

final class Kiosk
{
    /** face-api.js descriptors: same person typically < 0.45, different > 0.6. */
    public const MATCH_DIST = 0.5;
    /** Same person at the same kiosk within this window is not logged again. */
    public const COOLDOWN_S = 120;

    private PDO $pdo;
    private string $dir;
    private string $baseUrl;

    public function __construct(PDO $pdo, string $appRoot, string $baseUrl)
    {
        $this->pdo     = $pdo;
        $this->dir     = rtrim($appRoot, '/') . '/storage/kiosk';
        $this->baseUrl = rtrim($baseUrl, '/');
    }

    /** Validate a posted descriptor → 128 floats, or null. */
    public static function descriptor($v): ?array
    {
        if (!is_array($v) || count($v) !== 128) {
            return null;
        }
        $out = [];
        foreach ($v as $x) {
            if (!is_numeric($x)) {
                return null;
            }
            $out[] = round((float) $x, 6);
        }
        return $out;
    }

    /** Nearest person for a descriptor: ['person_id' => ?, 'dist' => float]. */
    public function nearest(array $desc): array
    {
        $best = ['person_id' => null, 'dist' => INF];
        foreach ($this->pdo->query('SELECT person_id, descriptor FROM face_templates') as $r) {
            $t = json_decode((string) $r['descriptor'], true);
            if (!is_array($t) || count($t) !== 128) {
                continue;
            }
            $s = 0.0;
            for ($i = 0; $i < 128; $i++) {
                $d  = $desc[$i] - (float) $t[$i];
                $s += $d * $d;
            }
            $s = sqrt($s);
            if ($s < $best['dist']) {
                $best = ['person_id' => (string) $r['person_id'], 'dist' => $s];
            }
        }
        return $best;
    }

    public function addTemplate(string $personId, array $desc, string $source): void
    {
        $this->pdo->prepare('INSERT INTO face_templates (person_id, descriptor, source, created_at) VALUES (:p, :d, :s, :c)')
            ->execute(['p' => $personId, 'd' => json_encode($desc), 's' => $source, 'c' => date('Y-m-d H:i:s')]);
    }

    public function templateCount(): int
    {
        return (int) $this->pdo->query('SELECT COUNT(DISTINCT person_id) FROM face_templates')->fetchColumn();
    }

    /**
     * Match + log one check-in.
     *
     * @param array $attrs  browser estimates {age, gender, genderProb, expression, expressionProb, score}
     * @return array{person_id:string, similarity:float, recorded:bool, duplicate:bool, time:string, new_unknown:bool}
     */
    public function checkin(array $desc, string $kiosk, string $location, array $attrs, ?string $snapshot, ?string $ip): array
    {
        $near    = $this->nearest($desc);
        $isMatch = $near['person_id'] !== null && $near['dist'] < self::MATCH_DIST;
        $newUnk  = false;
        if ($isMatch) {
            $pid = $near['person_id'];
        } else {
            $pid    = 'u' . bin2hex(random_bytes(4));
            $newUnk = true;
            $this->addTemplate($pid, $desc, 'unknown');
        }
        $sim = $isMatch ? max(0.0, min(1.0, 1 - $near['dist'])) : 0.0;
        $now = date('Y-m-d H:i:s');

        // Cooldown: someone standing at the kiosk is one check-in, not dozens.
        $last = $this->pdo->prepare('SELECT captured_at FROM kiosk_checkins WHERE person_id = :p AND kiosk = :k ORDER BY id DESC LIMIT 1');
        $last->execute(['p' => $pid, 'k' => $kiosk]);
        $prev = $last->fetchColumn();
        if ($prev && time() - (strtotime((string) $prev) ?: 0) < self::COOLDOWN_S) {
            return ['person_id' => $pid, 'similarity' => $sim, 'recorded' => false, 'duplicate' => true,
                    'time' => (string) $prev, 'new_unknown' => false];
        }

        $file = $snapshot !== null ? $this->saveSnapshot($snapshot) : null;
        $this->pdo->prepare(
            'INSERT INTO kiosk_checkins (person_id, kiosk, location, captured_at, similarity, snapshot, attrs_json, remote_ip)
             VALUES (:p, :k, :l, :t, :s, :f, :a, :ip)'
        )->execute([
            'p' => $pid, 'k' => $kiosk, 'l' => $location, 't' => $now,
            's' => $isMatch ? number_format($sim, 4, '.', '') : '',
            'f' => $file, 'a' => json_encode(self::cleanAttrs($attrs)), 'ip' => $ip,
        ]);
        return ['person_id' => $pid, 'similarity' => $sim, 'recorded' => true, 'duplicate' => false,
                'time' => $now, 'new_unknown' => $newUnk];
    }

    /**
     * Enrol a face under an employee. Reuses the person_id of a matching
     * staff ID or of a matching earlier (unknown) face, so check-ins logged
     * before enrolment join the employee's attendance history.
     *
     * @param array<int,array> $descs 1..5 descriptors of the same face
     */
    public function enrolPersonId(array $descs, string $staffId, array $profiles): string
    {
        if ($staffId !== '') {
            foreach ($profiles as $pid => $p) {
                if (strcasecmp((string) ($p['staffId'] ?? ''), $staffId) === 0) {
                    return (string) $pid;
                }
            }
        }
        $near = $this->nearest($descs[0]);
        if ($near['person_id'] !== null && $near['dist'] < 0.45 && !isset($profiles[$near['person_id']])) {
            return $near['person_id'];
        }
        return 'k' . bin2hex(random_bytes(4));
    }

    /** Store a data-URL / base64 JPEG under storage/kiosk/Ymd/ → relative name. */
    public function saveSnapshot(string $data): ?string
    {
        $b64 = preg_replace('#^data:image/[a-z]+;base64,#i', '', $data) ?? '';
        $raw = base64_decode($b64, true);
        if ($raw === false || strlen($raw) < 500 || strlen($raw) > 2 * 1024 * 1024) {
            return null;
        }
        $info = @getimagesizefromstring($raw);
        if (!$info || ($info['mime'] ?? '') !== 'image/jpeg') {
            return null;
        }
        $day = date('Ymd');
        if (!is_dir($this->dir . '/' . $day) && !@mkdir($this->dir . '/' . $day, 0775, true)) {
            return null;
        }
        $name = $day . '/' . bin2hex(random_bytes(8)) . '.jpg';
        return @file_put_contents($this->dir . '/' . $name, $raw) !== false ? $name : null;
    }

    /** Absolute, session-gated URL for a stored snapshot. */
    public function snapUrl(?string $name): ?string
    {
        return $name ? $this->baseUrl . '/api/kiosk/snap?f=' . rawurlencode($name) : null;
    }

    /** Snapshot file path for a name from snapUrl(), or null when invalid. */
    public function snapPath(string $name): ?string
    {
        if (!preg_match('#^\d{8}/[a-f0-9]{16}\.jpg$#', $name)) {
            return null;
        }
        $p = $this->dir . '/' . $name;
        return is_file($p) ? $p : null;
    }

    private static function cleanAttrs(array $a): array
    {
        $g = strtolower((string) ($a['gender'] ?? ''));
        return [
            'age'            => isset($a['age']) && is_numeric($a['age']) ? (int) round((float) $a['age']) : null,
            'gender'         => in_array($g, ['male', 'female'], true) ? ucfirst($g) : null,
            'genderProb'     => isset($a['genderProb']) && is_numeric($a['genderProb']) ? round((float) $a['genderProb'], 2) : null,
            'expression'     => preg_match('/^[a-z]{3,12}$/', (string) ($a['expression'] ?? '')) ? (string) $a['expression'] : null,
            'expressionProb' => isset($a['expressionProb']) && is_numeric($a['expressionProb']) ? round((float) $a['expressionProb'], 2) : null,
            'faceScore'      => isset($a['score']) && is_numeric($a['score']) ? round((float) $a['score'], 2) : null,
        ];
    }
}
