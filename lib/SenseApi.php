<?php
/**
 * SenseStudio (SenseFoundry GE) API client.
 *
 * Auth (§1.2.2): POST {base}/GUNS/mgr/login {username, password, accountType:2}
 * → data = token, then every API call sends  Authorization: Basic {token}.
 * The functional APIs (DEVICE, POLICYMONITOR, …) mount at {base} root — the
 * /intersense prefix is only the image/host path, not the API path.
 * Tokens are cached to a storage file and refreshed on 401/expiry.
 */

declare(strict_types=1);

require_once __DIR__ . '/Text.php';

final class SenseApi
{
    private string $base;      // e.g. https://sensestudio.ngrok.io
    private string $account;
    private string $password;
    private string $cacheFile;

    public function __construct(array $cfg, string $storageDir)
    {
        $this->base      = rtrim($cfg['base'] ?? '', '/');
        $this->account   = $cfg['account'] ?? '';
        $this->password  = $cfg['password'] ?? '';
        $this->cacheFile = rtrim($storageDir, '/') . '/sense_token.json';
    }

    public function ready(): bool
    {
        return $this->base !== '' && $this->account !== '' && $this->password !== '';
    }

    /** @return array{ok:bool,code?:string,msg?:string,data?:mixed,error?:string} */
    public function createDevice(array $p): array
    {
        // §3.3.1 Create Device. Sensible defaults for an RTSP video camera.
        $payload = array_merge([
            'deviceCnName'  => $p['name'] ?? 'Camera',
            'deviceEnName'  => $p['name'] ?? 'Camera',
            'deviceSerial'  => $p['serial'] ?? ('CAM-' . substr(md5((string) microtime(true)), 0, 6)),
            'deviceType'    => $p['deviceType'] ?? '22',   // Senseye-X (matches existing TMLab cams)
            'productType'   => $p['productType'] ?? '12',  // SensEye
            'deviceVersion' => '1.0',
            'operatePerson' => $this->account,
            'deviceUri'     => $p['rtsp'] ?? '',
            'desc'          => $p['desc'] ?? 'Onboarded from Kian Joo VisionAI',
            'deviceTag'     => $p['tag'] ?? 'tm-next-series',
            'frameRate'     => $p['fps'] ?? '25',
            'privilege'     => $p['privilege'] ?? '0',
        ], $p['extra'] ?? []);

        return $this->call('POST', '/DEVICE/device/create', $payload);
    }

    /** §3.3.6 List Device (pagination). Returns the raw device array in `data`. */
    public function listDevices(int $current = 1, int $size = 100): array
    {
        return $this->call('POST', '/DEVICE/device/list', [
            'current' => $current,
            'size'    => $size,
        ]);
    }

    /**
     * §3.3.3 Update Device — change name / RTSP URI / tag / description / status.
     * Only `did` is required; other fields are sent when provided.
     */
    public function updateDevice(string $did, array $p): array
    {
        $payload = ['did' => $did, 'operatePerson' => $this->account];
        // The dashboard shows deviceEnName (falling back to Cn), so a rename has
        // to set both or the old name keeps showing.
        if (!empty($p['name'])) {
            $payload['deviceEnName'] = (string) $p['name'];
        }
        $map = [
            'name'   => 'deviceCnName',
            'serial' => 'deviceSerial',
            'rtsp'   => 'deviceUri',
            'tag'    => 'deviceTag',
            'desc'   => 'desc',
            'fps'    => 'frameRate',
            'sts'    => 'sts',
        ];
        foreach ($map as $in => $out) {
            if (array_key_exists($in, $p) && $p[$in] !== null && $p[$in] !== '') {
                $payload[$out] = (string) $p[$in];
            }
        }
        return $this->call('POST', '/DEVICE/device/update', $payload);
    }

    /**
     * §5.5.6 List Monitor Policy (pagination). `policyCategory`: 1 gate,
     * 2 real-time analysis, 3 offline, 4 real-time events.
     */
    public function listPolicies(int $current = 1, int $size = 100, array $filter = []): array
    {
        return $this->call('POST', '/POLICYMONITOR/monitoringPolicy/list', array_merge([
            'current' => $current,
            'size'    => $size,
        ], $filter));
    }

    /**
     * §5.4.3 / §5.3.3 Monitor policy detail — the response carries
     * policyTargets[] {targetId, targetEnName, targetEnOption, targetValue},
     * i.e. SenseStudio's own attribute-feature key/value naming, plus
     * policyDevices[] for the cameras the policy runs on.
     */
    public function policyInfo(string $policyId, string $kind = 'face'): array
    {
        $path = $kind === 'gate'
            ? '/POLICYMONITOR/gateMonitoringPolicy/info'
            : '/POLICYMONITOR/faceMonitoringPolicy/info';
        return $this->call('POST', $path, ['policyId' => $policyId], true);
    }

    /**
     * Live attribute dictionary harvested from the configured policies:
     *   ['features' => [featureId => ['name' => …, 'values' => [value => name]]],
     *    'policies' => [ ['id','name','type','sts','targets'=>[…],'devices'=>[…]] ]]
     *
     * SenseStudio exposes no dictionary endpoint (the table lives in §5.2.4 of
     * the API doc, mirrored in Attributes::MAP) — but every policy returns the
     * names for the features it uses, so this keeps the mapping in sync with
     * whatever the operator actually configured.
     */
    public function attributeDictionary(int $maxPolicies = 60): array
    {
        $out = ['features' => [], 'policies' => []];
        $list = $this->listPolicies(1, $maxPolicies);
        if (empty($list['ok']) || !is_array($list['data'] ?? null)) {
            return $out;
        }
        $rows = $list['data']['records'] ?? $list['data'];
        if (!is_array($rows)) {
            return $out;
        }
        foreach (array_slice($rows, 0, $maxPolicies) as $p) {
            $pid = (string) ($p['policyId'] ?? '');
            if ($pid === '') {
                continue;
            }
            $info = $this->policyInfo($pid, 'face');
            $data = is_array($info['data'] ?? null) ? $info['data'] : [];
            if (!$data) {
                $info = $this->policyInfo($pid, 'gate');
                $data = is_array($info['data'] ?? null) ? $info['data'] : [];
            }
            $targets = [];
            foreach ((array) ($data['policyTargets'] ?? []) as $t) {
                $fid  = (string) ($t['targetId'] ?? '');
                $val  = (string) ($t['targetValue'] ?? '');
                $name = Text::latin((string) ($t['targetEnName'] ?? ''), '');
                $opt  = Text::latin((string) ($t['targetEnOption'] ?? ''), '');
                // Fall back to the Chinese fields only after translating them.
                if ($name === '') {
                    $name = Text::latin((string) ($t['targetCnName'] ?? ''), '');
                }
                if ($opt === '') {
                    $opt = Text::latin((string) ($t['targetCnOption'] ?? ''), '');
                }
                if ($fid === '') {
                    continue;
                }
                if (!isset($out['features'][$fid])) {
                    $out['features'][$fid] = ['name' => $name, 'values' => []];
                } elseif ($name !== '' && $out['features'][$fid]['name'] === '') {
                    $out['features'][$fid]['name'] = $name;
                }
                if ($val !== '' && $opt !== '') {
                    $out['features'][$fid]['values'][$val] = $opt;
                }
                $targets[] = ['id' => $fid, 'value' => $val, 'name' => $name, 'option' => $opt];
            }
            $devices = [];
            foreach ((array) ($data['policyDevices'] ?? []) as $d) {
                $devices[] = [
                    'serial' => (string) ($d['deviceSerial'] ?? ''),
                    'name'   => Text::latin((string) ($d['deviceEnName'] ?? $d['deviceCnName'] ?? $d['deviceName'] ?? ''),
                                            (string) ($d['deviceSerial'] ?? '')),
                ];
            }
            $out['policies'][] = [
                'id'      => $pid,
                'name'    => Text::latin((string) ($p['policyName'] ?? ($data['policyName'] ?? '')), $pid),
                'type'    => (string) ($p['policyType'] ?? ($data['policyType'] ?? '')),
                'sts'     => (string) ($p['sts'] ?? ($data['sts'] ?? '')),
                'targets' => $targets,
                'devices' => $devices,
            ];
        }
        return $out;
    }

    /**
     * §8.3.1 Search Person by Image (1:N) — the base64 form of the face search.
     * The gateway rejects real multipart bodies ("Content-Type … not supported"),
     * but this endpoint's fields are plain strings, so urlencoded works.
     *
     * `$personType` is 'Target' (enrolled groups) or 'Passer' (stranger library,
     * which is where our detections' personIds come from).
     * Returns data = [{score: 0.99, personID: "65762", targetType: "Passer"}].
     */
    public function searchFaceByImage(string $filePath, string $personType = 'Passer',
                                      int $count = 5, float $threshold = 0.0): array
    {
        if (!is_file($filePath)) {
            return ['ok' => false, 'error' => 'Image file missing'];
        }
        $raw = @file_get_contents($filePath);
        if ($raw === false || $raw === '') {
            return ['ok' => false, 'error' => 'Could not read the image'];
        }
        $body = [
            'figureImageBase64' => base64_encode($raw),
            'personType'        => $personType,
            'count'             => (string) max(1, min(20, $count)),
        ];
        if ($threshold > 0) {
            $body['threshold'] = (string) $threshold;
        }
        return $this->call('POST', '/COGNITIVESVC/cognitive/face/compareFaceImage', $body, true);
    }

    // ── internals ────────────────────────────────────────────

    private function token(bool $force = false): ?string
    {
        if (!$force && is_file($this->cacheFile)) {
            $c = json_decode((string) file_get_contents($this->cacheFile), true);
            // SenseStudio tokens are long-lived; refresh after 20 min regardless.
            if (is_array($c) && !empty($c['token']) && time() - (int) ($c['at'] ?? 0) < 1200) {
                return $c['token'];
            }
        }
        $res = $this->http('POST', $this->base . '/GUNS/mgr/login', [
            'username'    => $this->account,
            'password'    => $this->password,
            'accountType' => '2',
        ], null);
        $tok = is_array($res['json'] ?? null) && ($res['json']['code'] ?? '') === '0000'
            ? (string) $res['json']['data']
            : null;
        if ($tok) {
            @file_put_contents($this->cacheFile, json_encode(['token' => $tok, 'at' => time()]));
        }
        return $tok;
    }

    private function call(string $method, string $path, array $body, bool $form = false): array
    {
        if (!$this->ready()) {
            return ['ok' => false, 'error' => 'VisionAI API account not configured'];
        }
        $tok = $this->token();
        if (!$tok) {
            return ['ok' => false, 'error' => 'VisionAI login failed'];
        }
        $res = $this->http($method, $this->base . $path, $body, $tok, $form);

        // Retry once with a fresh token on auth-ish failures.
        $code = $res['json']['code'] ?? null;
        if (($res['status'] === 401) || in_array($code, ['401', '01000001', '9998'], true)) {
            $tok = $this->token(true);
            if ($tok) {
                $res = $this->http($method, $this->base . $path, $body, $tok, $form);
            }
        }

        $j = $res['json'];
        if (!is_array($j)) {
            return ['ok' => false, 'error' => 'Bad response (HTTP ' . $res['status'] . ')', 'raw' => substr((string) $res['body'], 0, 300)];
        }
        return [
            'ok'   => ($j['code'] ?? '') === '0000',
            'code' => $j['code'] ?? null,
            'msg'  => $j['msg'] ?? null,
            'data' => $j['data'] ?? null,
        ];
    }

    private function http(string $method, string $url, ?array $body, ?string $token, bool $form = false): array
    {
        $ch = curl_init($url);
        // Most endpoints take JSON; a few (policy `info`) are declared form-data.
        $headers = [$form ? 'Content-Type: application/x-www-form-urlencoded' : 'Content-Type: application/json'];
        if ($token !== null) {
            $headers[] = 'Authorization: Basic ' . $token;
        }
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_POSTFIELDS     => $body === null ? null
                : ($form ? http_build_query($body) : json_encode($body, JSON_UNESCAPED_SLASHES)),
            CURLOPT_HTTPHEADER     => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 15,
            CURLOPT_CONNECTTIMEOUT => 6,
        ]);
        $bodyOut = curl_exec($ch);
        $status  = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return [
            'status' => $status,
            'body'   => $bodyOut,
            'json'   => is_string($bodyOut) ? json_decode($bodyOut, true) : null,
        ];
    }
}
