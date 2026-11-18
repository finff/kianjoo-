# Kian Joo VisionAI — Integration API (HRMS / MES / enterprise)

Scoring-matrix criteria **43** (HRMS integration readiness), **44** (MES integration readiness) and **45** (enterprise multi-plant management).

The dashboard has two integration channels:

- **Inbound (pull):** a read-only JSON API under `/api/integration/*`.
- **Outbound (push):** signed webhooks sent when new detections arrive.

Both are configured in **Settings → Integrations**.

---

## 1. Authentication

The API uses its own **integration API key**. It is separate from the dashboard read token, so you can rotate it without signing operators out.

- Generate, rotate or revoke the key in Settings → Integrations. The full key is shown **once**, when it is generated. After that the UI shows only its last 4 characters.
- Send the key in one of these ways:
  - `X-Api-Key: kjv_…` (preferred)
  - `Authorization: Bearer kjv_…`
  - `?api_key=kjv_…` (avoid this: query strings end up in web-server logs)
- Responses:
  - No key configured → `503` with "Integration API is disabled".
  - Wrong or missing key → `401`.
- The API only accepts `GET`. Any other method → `405`.

The key is stored in `storage/wsd_settings.json`. Web access to `storage/` is denied.

## 2. Conventions

- **Base URL:** `https://<dashboard-host>/api/integration`
- **Response envelope:** `{"ok": true, ...payload}`. Errors look like `{"ok": false, "error": "…"}`.
- **Pagination:** list endpoints take `page` (1-based) and `per_page` (default 100, max 500). They return `page`, `per_page`, `total`, `pages` and `data` (the rows).
- **Multi-plant:** every endpoint accepts `plant=` (for example `plant=Plant 1`) and every row includes a `plant` field. The plant comes from camera → POC camera point → plant (Settings → POC Camera Points and Attendance Rules).
- **Dates:** `YYYY-MM-DD`. Times are server local time (`Y-m-d H:i:s`) or ISO-8601 where noted.
- **Range limits:** attendance ≤ 62 days, movement and PPE ≤ 31 days, events ≤ 31 days.

`GET /api/integration` returns the endpoint catalogue and the configured plants.

## 3. Endpoints

### 3.1 `GET /attendance` — HRMS daily attendance

Parameters:

- `date=` or `from=&to=`
- `plant=`
- `department=`
- `staff_id=`
- `page`, `per_page`

Example row:

```json
{"date":"2026-09-08","person_id":"…","staff_id":"KJ-0101","name":"…","department":"Production",
 "plant":"Plant 1","shift":"Day shift","shift_start":"08:00","shift_end":"17:00",
 "clock_in":"2026-09-08 07:52:10","clock_in_location":"Plant 1 Guard Post",
 "clock_out":"2026-09-08 17:04:55","clock_out_location":"Plant 1 Guard Post",
 "hours":9.2,"status":"present","late_min":0,"exceptions":[],"plants_visited":["Plant 1","Plant 2"]}
```

- `status` is one of: `present`, `late`, `absent`, `pending`, `off`.
- `exceptions` is a list drawn from: `missing_out`, `early_out`, `off_day`.

### 3.2 `GET /events` — MES / SOC detections and incidents

Parameters:

- `since=` — ISO-8601 or unix seconds. Default: the last 24 h.
- `until=`
- `module=` — one of `face`, `ppe`, `restricted`, `forklift`, `cleaning`, `behaviour`, `fire`
- `severity=` — one of `low`, `medium`, `high`, `critical`
- `camera=`
- `plant=`
- `page`, `per_page`

Rows are ordered oldest first, so a poller can store the last `time` and pass it as the next `since`. Example row:

```json
{"id":1234,"uuid":"…","time":"2026-09-08T10:42:11+08:00","module":"ppe","dashboard_module":"ppe",
 "severity":"high","status":"open","ticket":"","camera":"line5cam1","camera_name":"Line 5 camera",
 "location":"Line 5","plant":"Plant 1","policy":"PPE — Line 5","person_id":"","person_name":"",
 "similarity":null,"ppe_missing":["helmet"],"attributes":{"HatsType":"NoHat"},"image":"https://…"}
```

### 3.3 `GET /persons` — enrolled employees

Parameters:

- `plant=`
- `department=`
- `active=1|0`
- `page`, `per_page`

Each row contains: `person_id`, `staff_id`, `name`, `department`, `plant`, `shift`, `active`, `enrolled_at`, `face_sync`.

### 3.4 `GET /movement` — movement trail / investigation

Parameters:

- `person_id=` or `staff_id=`. Omit both to get everyone.
- `from=&to=`
- `plant=`
- `page`, `per_page`

Each row is one **visit**: consecutive sightings at one location. Fields: `location`, `camera`, `plant`, `arrive`, `depart`, `dwell_min`, `detections`, `source` (`cctv` or `kiosk`) and `counts_for`.

The response also includes `plant_transitions`: the number of Plant 1 ↔ Plant 2 moves in the range. This covers inter-plant tracking (criterion 7, test TR-02).

### 3.5 `GET /ppe` — PPE checks and compliance (EHS / MES)

Parameters:

- `from=&to=`
- `plant=`
- `location=`
- `violations_only=1`
- `page`, `per_page`

Each row is one PPE check with these fields:

- `required`: PPE items required
- `missing`: required items that were missing
- `unknown`: items the model did not report
- `compliant`
- `cleaning_session`
- `image`

The response also includes totals: `checks`, `violations` and `compliance_pct`.

## 4. Outbound webhooks

Settings → Integrations → Outbound webhooks. You can configure up to 10 URLs, each with its own signing secret and event types:

| Type | Sent when |
|---|---|
| `attendance` | an identified person is recognised at a clock-in / clock-out camera |
| `incident` | a detection classified **high** or **critical** |
| `ppe` | a PPE violation (required item missing) |
| `detection` | every detection (high volume) |

One delivery is sent per detection per hook. If a detection matches several of a hook's types, the most specific type is used for `X-VisionAI-Event`, and the body lists all of them in `types`.

### Request

```
POST <your URL>
Content-Type: application/json
User-Agent: KianJoo-VisionAI-Webhook/1.0
X-VisionAI-Event: incident
X-VisionAI-Timestamp: 1757300531
X-VisionAI-Signature: sha256=<hex>

{"source":"kianjoo-visionai","version":"1.0","sent_at":"2026-09-08T10:42:12+08:00",
 "type":"incident","types":["detection","incident"],"event":{ …same shape as /events rows… }}
```

### Verifying the signature

```
expected = "sha256=" + hex(HMAC_SHA256(secret, X-VisionAI-Timestamp + "." + raw_body))
```

Compare `expected` with the header using a constant-time comparison. Reject requests where the timestamp is more than 5 minutes old.

PHP example:

```php
$raw = file_get_contents('php://input');
$sig = 'sha256=' . hash_hmac('sha256', $_SERVER['HTTP_X_VISIONAI_TIMESTAMP'] . '.' . $raw, $secret);
if (!hash_equals($sig, $_SERVER['HTTP_X_VISIONAI_SIGNATURE'] ?? '')) { http_response_code(401); exit; }
```

### Delivery guarantees

- Delivery runs inside the SenseStudio push. All hooks together get a **2-second budget**, so the dashboard never delays ingest by more than that.
- A delivery succeeds when the receiver returns a `2xx` status.
- There is no automatic retry. Receivers that need completeness should also poll `/events?since=` as a reconciliation step.
- Every delivery and failure is logged in `storage/webhook_log.json` (last 200 entries). The Integrations tab shows the latest 25.
- Simulated detections (Settings → Simulator) are never sent.
- "Send test webhook" sends a signed `type: "test"` delivery with `event: null`.

## 5. Typical integrations

- **HRMS (attendance / payroll):**
  - Pull `/attendance?date=<yesterday>` nightly.
  - Or subscribe to `attendance` webhooks for real-time clock events.
  - Map `staff_id` to the HRMS employee number.
- **MES / production:**
  - Subscribe to `incident` and `ppe` webhooks for line stoppage or andon signals.
  - Pull `/ppe?from=&to=` for the shift EHS KPI.
- **Security / investigation:**
  - Use `/movement?staff_id=` for a person's trail across cameras and plants.
- **Enterprise multi-plant:**
  - Run one dashboard per company, or per region.
  - Each plant's cameras are mapped to that plant.
  - Every endpoint filters by `plant=`, so a central system can consume all plants from one API.

---

## 6. Cleaning button (physical start / end button)

On the factory floor a cleaning session is timed by a **physical button at the area**: the employee presses it when cleaning starts and presses it again when cleaning ends. The recorded cleaning time is exactly the time between those two presses.

Any device that can make an HTTP request can be the button (ESP32 / Arduino with Wi-Fi, a PLC gateway, an Android panel). These routes are under `/api/cleaning/…`, **not** `/api/integration/…`, and use the dashboard's own tokens.

### Authentication

| Route | Token |
|---|---|
| Send a press, read a button's state | **Ingest token** — the same one SenseStudio uses to push detections (Settings → Endpoints & tokens) |
| List sessions, list buttons | **Read token** |

Send the token as `?token=…`, `X-Ingest-Token: …` / `X-Read-Token: …`, or `Authorization: Bearer …`.

### 6.1 Send a press — `POST /api/cleaning/button`

`GET` with query parameters also works, for hardware that can only fetch a URL.

| Field | Required | Meaning |
|---|---|---|
| `button_id` | yes | Your device's fixed id. Letters, digits and `. _ : -`, max 64 (e.g. `LINE1-WASH`, a MAC address). |
| `action` | no | `toggle` (default): start if idle, end if cleaning. `start` / `end`: explicit, for two-button or latching devices. |
| `employee_id` | no | Who pressed (staff ID from a badge reader, if the device has one). |
| `location` | no | Area name. Remembered the first time; change it later with `POST /api/cleaning/buttons`. |
| `ts` | no | When the button was actually pressed (unix seconds, unix milliseconds or ISO 8601), for devices that buffer presses while offline. Accepted within 24 h of server time, otherwise server time is used. |

```
curl -X POST "https://<site>/api/cleaning/button?token=<INGEST_TOKEN>" \
     -H "Content-Type: application/json" \
     -d '{"button_id":"LINE1-WASH","location":"Line 1"}'
```

Response (`200`):

```json
{ "ok": true, "result": "started", "state": "cleaning",
  "button":  { "button_id": "LINE1-WASH", "name": "", "location": "Line 1", "enabled": true, "last_press_at": "2026-11-18 09:00:00" },
  "session": { "id": 12, "started_at": "2026-11-18 09:00:00", "ended_at": null, "duration_s": null, "elapsed_s": 0, "status": "open" },
  "message": "Cleaning started." }
```

`result` is one of:

| `result` | HTTP | Meaning |
|---|---|---|
| `started` | 200 | A cleaning session began. `state` is `cleaning`. |
| `ended` | 200 | The session ended; `session.duration_s` is the cleaning time in seconds. `state` is `idle`. |
| `ignored` | 200 | Repeat press within 3 seconds (switch bounce, double tap, retry). Nothing changed. |
| `already_started` | 200 | `action=start` while a session is running. Nothing changed. |
| `not_started` | 409 | `action=end` with no session running. |
| `disabled` | 403 | The button was switched off on the dashboard. |

Drive the device's indicator from `state`: light on for `cleaning`, off for `idle`.

Rules worth knowing:

- A button is **registered automatically** on its first press; no setup is needed first.
- Each `button_id` has at most one running session. Different buttons are independent.
- If nobody presses "end", the session is closed as `auto_closed` after **12 hours** with no duration, so a forgotten press is never counted as cleaning time. The next press starts a new session.
- It is safe to retry a failed request with the same `ts`.

### 6.2 Button state — `GET /api/cleaning/button/status?button_id=`

Returns the same shape as a press with `result: "status"` (or `"unknown"` for a button that has never been pressed). Use it when the device boots, to restore its indicator.

### 6.3 Sessions — `GET /api/cleaning/button/sessions`

Filters: `from`, `to` (`YYYY-MM-DD`, default last 7 days), `button_id`, `location`, `status` (`open`, `closed`, `auto_closed`), `limit` (max 500), `offset`.

Returns `sessions` (newest first), `total`, and `totals` with `completed`, `in_progress`, `auto_closed`, `cleaning_seconds` and `average_seconds`.

### 6.4 Buttons — `GET|POST /api/cleaning/buttons`

- `GET` lists every registered button with its current state.
- `POST {button_id, name?, location?, enabled?}` names a button, moves it to another area, or switches it off. Needs an administrator signed in with the settings permission.
