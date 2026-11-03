# Kian Joo VisionAI — Architecture & Infrastructure

This document covers scoring-matrix criteria 32 to 37:

- 32 Camera compatibility
- 33 PoE network
- 34 Bandwidth / latency
- 35 NVR / VMS / AI architecture
- 36 Storage & retention
- 37 Multi-plant scalability

It describes how the components fit together. The bandwidth and storage figures are planning values to check against the POC network test (Settings → Live Video → Network test) and the live storage figures (Settings → Data Retention).

## 1. End-to-end data path

```
 IP cameras (existing CCTV, ONVIF / RTSP, H.264 / H.265)
    │  PoE access switch  (802.3af/at)
    ▼
 Plant LAN / CCTV VLAN ─────────────┬──────────────────────────────┐
    │ RTSP main stream (record)     │ RTSP sub / main (analyse)     │ RTSP sub (live view, optional)
    ▼                               ▼                               ▼
 Existing NVR / VMS          SenseStudio edge AI box          go2rtc live bridge
 (continuous recording,      (face library, PPE / body        (RTSP → MP4 / HLS for
  unchanged)                  attributes, ROI intrusion,        the browser wall)
                              custom algorithms)
                                    │ HTTP push (JSON event + frame URL), §6.5
                                    ▼
                          Kian Joo VisionAI dashboard (PHP 8 + MySQL)
                          ingest → classify → PPE / zone / forklift / behaviour rules
                          → incidents, escalation (email / Telegram), reports,
                            AI-performance metrics, integration API + webhooks
                                    │
               Browsers (SOC, supervisors) · HRMS / MES (API + webhooks)
```

Key points:

- **Cameras are not replaced.** Any camera that serves RTSP works, and that is normally every ONVIF Profile S camera. SenseStudio pulls the stream itself.
- **The NVR keeps recording as it does today.** The AI box is a second RTSP client on the same camera. The AI path never touches the recording.
- **Evidence frames stay on the SenseStudio box.** The dashboard stores the event JSON and the frame URL, not the video.
- **The live wall is optional.** It goes through a go2rtc bridge, or plays an HLS URL directly. It uses the cameras' sub-stream so live viewing never competes with the analysis stream.

## 2. Camera compatibility (criterion 32)

| Requirement | Recommendation |
|---|---|
| Protocol | RTSP over TCP (ONVIF Profile S for discovery / PTZ). RTSP URLs: Hikvision `…/Streaming/Channels/101` main, `102` sub · Dahua `…/cam/realmonitor?channel=1&subtype=0/1` |
| Codec | H.264 preferred for browser live view. H.265 is fine for SenseStudio analysis; the bridge transcodes (`ffmpeg:` source) for the browser |
| Resolution for face recognition | ≥ 1080p, face ≥ 80–100 px between the ears, camera ≤ 15° vertical angle at the door, WDR on for backlit entrances |
| Resolution for PPE / body attributes | 1080p, person ≥ 150 px tall in frame, camera height 2.5–4 m, ≤ 30° down-angle |
| Frame rate | 15–25 fps for analysis. 8–12 fps is enough for the sub-stream used by the live wall |
| Accounts | A dedicated read-only RTSP user per camera for the AI box and the bridge (never the admin account) |

**POC check (test INF-01):** register the stream in SenseStudio, then confirm it on the Live Video tab ("Probe" grabs one frame through the bridge). Run the network test.

## 3. PoE network and switches (criterion 33)

**Power:**

- Fixed bullet / dome cameras draw 4–7 W (802.3af, class 0–2).
- IR-heavy or heated outdoor cameras draw 12–25 W (802.3at).
- PTZ cameras draw up to 60 W (802.3bt).
- **Budget the switch at ≥ 1.3 × the sum of the cameras' maximum class power.**
- Leave about 20 % of ports free.

**Uplink:**

- A 24-port access switch with 1080p cameras carries about 24 × (4 + 1) Mbps ≈ 120 Mbps. That needs a 1 Gbps uplink.
- Plan for 2 × 1 Gbps (LACP), or 10 Gbps, from the access switch to the core / NVR switch when the NVR and the AI box sit in the server room.

**Segmentation:**

- Put cameras on a CCTV VLAN.
- The AI box and the NVR need L3 access to it. The dashboard server only needs to receive the HTTP pushes from the AI box (outbound 443 from the AI box), plus optional bridge access.
- Do not route camera RTSP to the internet. If the dashboard is hosted off-site, the live bridge goes out through an authenticated HTTPS tunnel.

**Distance and cabling:** Cat6 within 100 m. Use fibre plus a media converter, or a PoE extender, beyond that.

**Multicast:** not required. Each consumer opens its own unicast RTSP session.

## 4. Bandwidth and latency (criterion 34, test INF-02)

Per-stream planning bitrates (constant bitrate, typical factory scene):

| Stream | H.264 | H.265 |
|---|---|---|
| 1080p main @ 25 fps | 4 Mbps | 2 Mbps |
| 1080p main @ 15 fps | 3 Mbps | 1.5 Mbps |
| 720p @ 15 fps | 1.5 Mbps | 0.8 Mbps |
| Sub-stream D1 / 640×360 @ 10 fps | 0.5 Mbps | 0.3 Mbps |
| 4 MP main @ 20 fps | 6 Mbps | 3 Mbps |

Per camera, the load on the network is the sum of its consumers:

- NVR record (main)
- AI box analysis (main or sub, as configured per policy)
- Optional live wall (sub)

For example: 1080p H.264 recorded and analysed on main, plus live on sub = 4 + 4 + 0.5 = **8.5 Mbps** at the camera port and on the access uplink.

Event pushes from the AI box to the dashboard are small: about 5–20 KB of JSON per event. Frames are fetched on demand.

**Acceptance thresholds used by the dashboard network test.** It runs from the server, with N = 5 attempts per target:

| Metric | Pass | Warn | Fail |
|---|---|---|---|
| TCP connect latency | ≤ 100 ms | ≤ 300 ms | > 300 ms / unreachable |
| Loss proxy (failed connects / 5) | 0 % | ≤ 20 % | > 20 % |
| HTTP time-to-first-byte | ≤ 500 ms | ≤ 1.5 s | > 1.5 s |
| Stream sample throughput (≤ 3 s, ≤ 2 MB) | ≥ 4 Mbps | ≥ 1.5 Mbps | < 1.5 Mbps |

Inside a plant LAN, the expected results are well under 10 ms TCP latency with 0 % loss. Alert latency from the event to the dashboard and the alert email or Telegram message should be under 5 s. Most of that is SenseStudio inference time.

## 5. NVR / VMS / AI processing architecture (criterion 35)

| Option | Description | When |
|---|---|---|
| **A. AI box beside the NVR (recommended for the POC and rollout)** | SenseStudio edge box pulls RTSP from cameras directly; NVR untouched | Existing NVR has no AI; zero change to recording |
| B. AI box pulls from the NVR / VMS re-stream | Cameras → NVR → RTSP re-stream → AI box | Camera RTSP sessions are limited (many cameras allow 2–3 sessions) |
| C. Server GPU (central) | One GPU server per site runs SenseStudio for all plants' cameras | Many cameras per site, central IT room, ≥ 1 Gbps between plants |

**Sizing guidance.** Confirm these against the SenseStudio datasheet for the chosen box:

- A typical edge box analyses 8–16 1080p streams for face plus body attributes at 8–10 fps of analysis per stream.
- Face recognition at guard posts needs the full frame rate on the entry cameras only.
- PPE, intrusion and behaviour policies can sample at 2–5 fps.

**Separation of duties:**

- The NVR / VMS remains the system of record for video.
- The AI box produces events.
- The dashboard is the system of record for incidents, reviews, attendance, metrics and reports.

## 6. Storage capacity and retention (criterion 36)

**Recording on the NVR (unchanged):**

```
storage_per_camera_per_day (GB) = bitrate (Mbps) × 86 400 s ÷ 8 ÷ 1000 ≈ bitrate × 10.8
total (TB) = Σ cameras (bitrate × 10.8 × days) ÷ 1000 × 1.2 (RAID / overhead)
```

Example: 40 cameras × 4 Mbps × 30 days ≈ 40 × 43.2 × 30 ÷ 1000 × 1.2 ≈ **62 TB**. The same 40 cameras on H.265 at 2 Mbps ≈ **31 TB**.

**Dashboard (this application):**

- About 6–20 KB per event in the database, including attributes and incident log. Ticket attachments are extra.
- Settings → Data Retention shows the live figures:
  - database size
  - attachments size
  - events per day (7-day average)
  - average size per event
  - the projected size at the configured retention
- **Default retention is 90 days.** A daily job purges older events with their attributes, PPE / zone rows, incident log and attachments. It runs from cron (`/api/report/cron`) and is piggy-backed on the dashboard poll.
- Event frames live on the SenseStudio box. Set its picture retention to at least the dashboard retention so evidence links stay valid.

**Recommendation:**

- 30 days of continuous video on the NVR (90 days for restricted areas if policy requires it).
- 90 days of events and evidence in the dashboard.
- 1 year of aggregated reports (CSV / PDF exports archived).

## 7. Scalability for multi-plant deployment (criterion 37)

- **Data model:** camera → POC camera point / location → plant. Every page, report and integration endpoint filters by plant. Attendance tracks plant transitions.
- **Topology:**
  - One SenseStudio edge box per plant, or per 16 cameras.
  - All boxes push to one central dashboard over HTTPS.
  - No camera video crosses the WAN. Only events cross it, plus optional sub-streams for live view.
- **Scale points:**
  - Ingest is a single HTTP POST per event and is stateless, so PHP-FPM scales horizontally behind a load balancer.
  - MySQL holds the data. Indexes cover time, stream and uuid.
  - Retention bounds the database size.
- **Rough capacity:** 200 cameras × 300 events/day ≈ 60 000 events/day. At about 15 KB each that is roughly 0.9 GB/day, or 81 GB at 90 days. That fits a standard MySQL instance.
- **Enterprise integration:** HRMS / MES consume the integration API and signed webhooks (`docs/INTEGRATION_API.md`) centrally for all plants.
- **Operations:** one face library per company, synced from the Employees page. Plant-specific zones, PPE rules and shifts are configured per camera point.

## 8. POC deployment checklist

1. Map every POC camera to its camera point and plant (Settings → POC Camera Points / Attendance Rules).
2. Register the RTSP sources (Settings → Live Video), probe each one, and run the network test. Attach the result to INF-01 / INF-02.
3. Confirm the SenseStudio push URLs (Settings → Endpoints & Tokens) and check the ingest log.
4. Enrol the Plant 1 employees (Employees → sync to SenseStudio).
5. Configure the PPE area rules, restricted zones, forklift zones, cleaning schedules and behaviour rules.
6. Configure the notification channels and escalation, then send test messages.
7. Set the data retention, and confirm the SenseStudio picture retention is at least as long.
