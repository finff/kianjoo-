# Kian Joo VisionAI — SenseTime / MyVisionAI Ingest API

A small, reusable **plain-PHP + MySQL** service that captures SenseTime
(SenseFoundry / SenseStudio) **HTTP-Push** events and stores them for reuse
across many use cases — body-attribute analytics, PPE/vest checks, smoking
detection, crowd counting, vehicle/plate capture, and more.

It replaces the current setup where MyVisionAI pushes each camera's event to a
Firebase RTDB feed (`…/tmlab1/camera1.json`). Point the camera policy at this
API instead and every event is validated, decoded, stored, and queryable — with
an **optional forward** that keeps the Firebase feed alive during migration.

Reference: *SenseStudio V2.13.0 API Documentation* — **§6.5 HTTP Push** (payload)
and **§5.2.4 Attribute Feature Definition** (the numeric attribute codes). Both
PDFs are in `sensetimedocumentation/`.

---

## How SenseTime pushes events

When a monitor policy has an HTTP action, SenseFoundry `POST`s a JSON body to
your endpoint and treats **any HTTP 200** as success (§6.5.1). The body's
`attributes` array is `{key, value, conf}` triples where `key`/`value` are the
numeric codes from §5.2.4. This service decodes them, e.g.:

| key | feature | value | meaning |
|----:|---------|------:|---------|
| 5  | Gender | 0 | Male |
| 63 | Smoking | 1 | NoSmoking |
| 62 | WithReflectiveVest | 1 | NoReflectiveVest |
| 22 | TopsType | 3 | T-Shirt |
| 73 | AgeLowerLimit | 1 | 18 |
| 72 | AgeUpperLimit | 1 | 59 |

The full dictionary lives in [`lib/Attributes.php`](lib/Attributes.php).

---

## Endpoints

Base URL: `https://tm-next-series.weststar-dev.com/api`

Auth token can be passed as `?token=…`, an `X-Ingest-Token` / `X-Read-Token`
header, or `Authorization: Bearer …`.

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET`  | `/health` | — | Liveness check |
| `GET`  | `/` | — | Capability summary |
| `POST` | `/ingest/{stream}` | **ingest** | Receive one event (webhook) |
| `GET`  | `/events` | **read** | List events (filterable) |
| `GET`  | `/events/latest/{stream}` | **read** | Most recent event for a stream |
| `GET`  | `/events/{uuid}` | **read** | One event by uuid |
| `GET`  | `/stats` | **read** | Aggregate counts |
| `GET`  | `/provision` | **provision** | Create DB / run migrations (idempotent) |

`{stream}` is any label you choose (`camera1`, `camera2`, `lobby`, …). If
omitted, it is derived from `deviceSerial`.

**`/events` filters** (query string): `stream`, `device_serial`,
`trigger_image_type`, `event_type`, `policy_name`, `uuid`, `from`, `to`
(server timestamps `YYYY-MM-DD HH:MM:SS`), `limit` (≤500), `offset`.

Every event response includes `decoded` — a compact `{FeatureName: ValueName}`
map — plus the full `raw` payload, `detect` bbox, and image URLs.

---

## Point SenseStudio at it

In SenseStudio → **Manage Policy** → edit the policy (e.g. `TMLab1`,
`TMLabEntrance`) → the notification block has a **Push** checkbox with a URL
field (currently the Firebase URL) and a content field (`tm-one`). Replace the
**URL** with:

```
https://tm-next-series.weststar-dev.com/api/ingest/tmlab1?token=<INGEST_TOKEN>
```

Pick a distinct stream label per policy (`tmlab1`, `entrance`, `camera1`, …).
That's the only change — the same JSON body that lands in Firebase now lands
here. The content field can stay `tm-one` (it arrives as `actionContent`).

If the URL field rejects the `?token=` query string, use the path form instead:

```
https://tm-next-series.weststar-dev.com/api/ingest/tmlab1/<INGEST_TOKEN>
```

Both `POST` and `PUT` are accepted; any HTTP 200 counts as success (§6.5.1).

**Image host.** Event image URLs are relative (`/images/...`). Set
`SENSE_IMAGE_BASE=https://sensestudio.ngrok.io/intersense` in `.env` and every
event response gains an `images` object with absolute, viewable URLs, e.g.
`https://sensestudio.ngrok.io/intersense/images/cognitivesvc/roiIntrusion/…jpg`.
(Verified live — that base serves the actual trigger frames.)

**Keep the Firebase feed working too (optional):** set `FORWARD_FIREBASE_BASE`
in `.env` to `https://weststar-c5290-default-rtdb.asia-southeast1.firebasedatabase.app/tmlab1`.
Each event is then also `PUT` to `{base}/{stream}.json`, mirroring the old feed.

---

## Reuse for multiple use cases

Two storage shapes back every use case:

1. **`events`** — one row per push (headers + decoded map + full raw JSON).
2. **`event_attributes`** — one row per decoded attribute
   (`feature_name`, `value_name`, `conf`), indexed for cross-event queries.

So a new use case is just a query (MySQL syntax), e.g.:

```sql
-- PPE: people with no reflective vest, last 24h
SELECT e.stream, e.trigger_time, a.conf
FROM event_attributes a JOIN events e ON e.id = a.event_id
WHERE a.feature_name = 'WithReflectiveVest' AND a.value_name = 'NoReflectiveVest'
  AND e.received_at >= NOW() - INTERVAL 1 DAY;

-- Smoking alarms
SELECT * FROM event_attributes
WHERE feature_name = 'Smoking' AND value_name = 'IsSmoking';
```

Or over HTTP: `GET /api/events?trigger_image_type=roiIntrusion&stream=camera1`.

A durable append-only backup of every raw payload is also written to
`storage/events.jsonl` (newline-delimited JSON) in case you want to stream or
reprocess later.

---

## Monitoring dashboard (Kian Joo VisionAI)

Visiting `/` serves the **Kian Joo VisionAI** monitoring dashboard — a rebranded
(Kian Joo Group; palette inherited from the earlier TM ONE build, blue `#1800E0`
/ orange `#F85800`) build of the CP Monitoring
System (a dc-runtime single-file app). It shows **live SenseTime detections**,
not mock data:

- **Live feeds** — one tile per stream showing the real trigger frame with the
  detection bounding box drawn from `detect`. **Click any frame to expand it.**
- **Live events / Incidents** — real detections mapped to incidents (module,
  severity, decoded attributes). Acknowledge / Assign persist across refreshes.
- **AI Shift Review** — an LLM narrative from the Weststar AI middleware.
- **Analytics** — real by-type, by-camera and severity breakdowns + 24h trend.
- **Detection pages** (Fire / PPE / Intrusion / Face) — filtered live detections.

Data flow: `index.php` serves the dashboard and injects the feed URL + read
token → the app polls **`/feed.php`** every 5s → `feed.php` reads the DB via
`EventStore`, maps events with `DashboardMapper`, and enriches with the Weststar
AI analytics summary (`/sensetime/analytics`, file-cached ~2 min).

### Weststar AI integration

Each captured event is also forwarded to the Weststar AI SenseTime middleware
(`WESTAR_AI_BASE`, default `https://api.weststar-ai.com/sensetime`) so it can run
LLM review and power the dashboard's **AI Shift Review**. Set `FORWARD_WESTAR_AI=false`
to disable. The middleware exposes `POST /sensetime/events`, `GET /sensetime/events[/{uuid}]`,
`GET /sensetime/analytics?window=24h`, `GET /sensetime/stats|health` (no auth).

## Layout

```
index.php               Serves the dashboard (injects feed config)
status.php              Plain status/health page (former landing)
Kian Joo VisionAI.dc.html  Dashboard app (dc-runtime; not directly web-accessible)
support.js              dc-runtime
uploads/Kian-Joo-Logo.png Kian Joo Group brand logo (uploads/TM-One-Logo.png kept as the old TM ONE logo)
feed.php                Dashboard data feed (incidents/cameras/trend/AI)
api/index.php           Ingest + read API front controller / router
api/.htaccess           Routes /api/* → index.php
config/config.php       Loads .env, returns config
lib/Env.php             Tiny .env loader
lib/Response.php        JSON + CORS helpers
lib/Attributes.php      SenseTime §5.2.4 attribute dictionary + decoder
lib/Database.php        MySQL/SQLite connection + migrations
lib/EventStore.php      Normalize, store, resolve images, forward, query
lib/DashboardMapper.php SenseTime event → dashboard incident / camera tile
storage/                raw JSONL backup + AI cache (+ SQLite if used) — deny-all
tests/                  sample_payload.json + local dev router
deploy.sh               Local, FTP-based deploy tool (LFTP) for the FTP-hosted site
deploy.php              Auto-deploy webhook receiver (GitHub push → cPanel) — see docs/deploy.md
git-deploy.sh           Server-side `git fetch && reset --hard`, invoked by deploy.php
.env                    Secrets (NOT web-accessible, NOT committed)
```

---

## Deploy

Two independent deploy paths exist, for two different hosting setups:

- **FTP-hosted site** (no server-side git): `deploy.sh` mirrors files from
  a dev machine over LFTP. See below.
- **cPanel Git Version Control site**: push to `main` on GitHub and it
  deploys itself. See **[docs/deploy.md](docs/deploy.md)** for the full
  runbook — registering the webhook, rotating the token, the manual curl
  trigger, and the (bold, load-bearing) rule that database migrations are
  always run by hand, never from the deploy script.

### FTP path

1. In **cPanel → MySQL Databases**, create the database `weststar_tm_new_series`
   and user `weststar_admin`, and grant ALL privileges. (Tables are created
   automatically on provision.)
2. Upload and provision:

```bash
./deploy.sh --all     # first time: upload app files + .env
./deploy.sh           # subsequent: app files only (server .env untouched)

# then provision (creates the tables; idempotent):
curl "https://tm-next-series.weststar-dev.com/api/provision?token=<PROVISION_TOKEN>"
```

Requirements on the host: PHP 8.x with `pdo_mysql` (standard on cPanel EA-PHP).
`.env`, `storage/`, `config/`, `lib/`, and `tests/` are blocked from web access
via `.htaccess`. For local dev without MySQL, set `DB_CONNECTION=sqlite`.

## Local testing

```bash
php -S 127.0.0.1:8799 tests/router.php
curl "http://127.0.0.1:8799/api/provision?token=<PROVISION_TOKEN>"
curl -X POST "http://127.0.0.1:8799/api/ingest/camera1?token=<INGEST_TOKEN>" \
     -H 'Content-Type: application/json' --data @tests/sample_payload.json
curl "http://127.0.0.1:8799/api/events/latest/camera1?token=<READ_TOKEN>"
```
