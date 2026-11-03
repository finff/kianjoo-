# Live bridge — RTSP cameras → the dashboard's `<video>` tiles

Browsers cannot play RTSP. This folder is a ready-to-run **go2rtc 1.9.9**
bridge behind **Caddy** (automatic HTTPS + a shared token). go2rtc pulls each
camera's RTSP stream and re-serves it as fragmented MP4 over HTTPS, which the
Kian Joo VisionAI dashboard plays directly:

```
camera (RTSP :554) ──► go2rtc :1984 ──► Caddy :443 (HTTPS + token) ──► dashboard <video>
                       on a host that                                  {base}/api/stream.mp4?src={stream}&token=…
                       can reach the cameras
```

Without a bridge the dashboard still works: live tiles fall back to the latest
detection frame.

| File | Purpose |
|------|---------|
| `docker-compose.yml` | `go2rtc` (`alexxit/go2rtc:1.9.9`) + `caddy` (`caddy:2`) |
| `go2rtc.yaml` | go2rtc config; `streams:` is filled by the dashboard |
| `Caddyfile` | HTTPS, token / cookie gate, CORS, reverse proxy to `go2rtc:1984` |
| `nginx.conf.example` | the same gate for hosts that already run nginx |
| `.env.example` | `LIVE_DOMAIN`, `LIVE_TOKEN` |

---

## Where to run it

The bridge must reach the cameras on port 554 **and** be reachable by the
dashboard users' browsers over HTTPS.

1. **VM / mini-PC inside the plant LAN (recommended).** Put it on the camera
   VLAN (or one routed to it) for Plant 1 and Plant 2 — Guard Posts, Lobby,
   Line 5, Waste Area Spot 9 — and give it a public HTTPS name, either by
   forwarding 80/443 from the plant firewall or via a Cloudflare Tunnel
   (then change the Caddyfile site address to `http://{$LIVE_DOMAIN}`, drop
   Caddy's published ports and point `cloudflared` at `http://caddy:80` —
   Cloudflare terminates TLS, Caddy keeps the token gate).
   Video stays on-site until a viewer opens it.
2. **On a VPS**, with a site-to-site VPN (WireGuard / IPsec) or a tunnel into
   the camera network. Simpler to expose, but every live viewer pulls the
   camera stream across the VPN — use sub-streams.

One bridge can serve both plants as long as it can route to both camera
subnets; otherwise run one per plant and register only that plant's cameras
on it (manual sources, see below).

---

## Setup

```bash
# on the bridge host (Docker + compose plugin installed)
cp -r live-bridge /opt/kj-live && cd /opt/kj-live
cp .env.example .env
#   LIVE_DOMAIN=live.kianjoo.example      (DNS A record → this host)
#   LIVE_TOKEN=$(openssl rand -hex 24)
docker compose up -d
docker compose logs -f caddy      # wait for "certificate obtained successfully"
```

Caddy obtains the Let's Encrypt certificate on first start (ports 80 and 443
must be reachable from the internet for the HTTP challenge, or switch to a DNS
challenge). The go2rtc API is published on `127.0.0.1:1984` only.

Then in the dashboard, **Settings › Live Video**:

| Field | Value |
|-------|-------|
| PUBLIC BASE URL | `https://<LIVE_DOMAIN>` (no trailing slash) — what browsers load |
| TOKEN | the same `LIVE_TOKEN` |
| INTERNAL API URL | optional; `http://127.0.0.1:1984` only when the dashboard runs on the bridge host. Blank = server calls go through the public base with the token |
| API USER / API PASSWORD | optional; only if you enabled go2rtc basic auth (below) |
| AUTO-REGISTER | On (default) |

Save, then **Test bridge** — the status strip should read
`Bridge reachable · go2rtc 1.9.9 · N of M sources registered`. The same values
can be set in the dashboard `.env` as `LIVE_STREAM_BASE`, `LIVE_STREAM_TOKEN`,
`LIVE_BRIDGE_API`, `LIVE_BRIDGE_USER`, `LIVE_BRIDGE_PASS`, `LIVE_AUTO_SYNC`;
Settings values override `.env`.

---

## How sources get onto the bridge

You do not edit `go2rtc.yaml` by hand. The dashboard server registers every
camera that has an RTSP URL with

```
PUT {api}/api/streams?name={stream}&src={rtsp}
```

and go2rtc persists it into `go2rtc.yaml`, so sources survive restarts.
`{stream}` is the camera's stream label: the SenseStudio device serial,
lower-cased with everything except `a-z0-9` removed (`Jetty-BA` → `jettyba`),
or the key you give a manual source.

Registration happens:

- **automatically**, at most every 5 minutes, when the feed refreshes the
  SenseStudio camera fleet (missing sources are added, changed URLs updated);
  turn off with AUTO-REGISTER / `LIVE_AUTO_SYNC=false`;
- when a camera is **added or edited** in the dashboard with an RTSP URL
  (the save message ends with `· live bridge updated` or `· bridge: <error>`);
- on **Register all RTSP sources** in Settings › Live Video;
- for cameras **outside SenseStudio**, via *Add manual RTSP source* (stream
  label + URL) in the same tab, or `RTSP_STREAMS` in the dashboard `.env`.
  Manual entries override a fleet camera with the same label.

The RTSP sources table shows each stream's state: **Registered**, **Missing**
(not yet on the bridge), **Mismatch** (bridge has a different URL — the next
sync updates it) or **Orphan** (on the bridge but not known to the dashboard;
reported only, never deleted). **Probe** fetches one frame through
`/api/frame.jpeg` and shows a thumbnail, proving the camera actually produces
video. The dashboard never deletes fleet streams; removing a manual source
issues `DELETE /api/streams?src={stream}`.

---

## Verify by hand

```bash
T=<LIVE_TOKEN>; D=https://<LIVE_DOMAIN>
curl -s "$D/api?token=$T"                         # {"version":"1.9.9",...}
curl -s "$D/api/streams?token=$T"                 # registered streams
curl -s -o f.jpg "$D/api/frame.jpeg?src=jettyba&token=$T"   # one JPEG frame
curl -s -o /dev/null -w '%{http_code}\n' "$D/api/streams"   # 403 (no token)

# on the bridge host, bypassing Caddy:
curl -s http://127.0.0.1:1984/api/streams
curl -X PUT "http://127.0.0.1:1984/api/streams?name=test&src=rtsp://user:pass@192.168.1.10:554/Streaming/Channels/102"
```

In a browser, `https://<LIVE_DOMAIN>/stream.html?src=jettyba&token=<LIVE_TOKEN>`
opens go2rtc's own player (the dashboard's pop-out link).

---

## RTSP URL cheat-sheet

| Camera | Main stream | Sub-stream |
|--------|-------------|------------|
| Hikvision | `rtsp://user:pass@192.168.1.10:554/Streaming/Channels/101` | `…/Streaming/Channels/102` |
| Dahua / Imou | `rtsp://user:pass@192.168.1.10:554/cam/realmonitor?channel=1&subtype=0` | `…&subtype=1` |
| Uniview | `rtsp://user:pass@192.168.1.10:554/unicast/c1/s0/live` | `…/unicast/c1/s1/live` |
| NVR channel N (Hikvision) | `…/Streaming/Channels/N01` | `…/Streaming/Channels/N02` |
| Any ONVIF camera | `onvif://user:pass@192.168.1.10` (go2rtc discovers the RTSP URL) | |

URL-encode special characters in passwords (`@` → `%40`, `#` → `%23`).

**Bandwidth.** A wall of tiles opens one stream per tile. Use the camera's
**sub-stream** (typically 640×360–720p, 512 kbps–1 Mbps) for the Overview and
Camera Dashboard walls; a 4 MP main stream is 4–8 Mbps per viewer. go2rtc pulls
each camera once and fans out to all viewers, so the camera link is not the
bottleneck — the bridge's uplink is.

### go2rtc source options

- `#transport=tcp` — force RTSP over TCP (fixes grey/smeared frames over VPN or
  lossy Wi-Fi): `rtsp://user:pass@192.168.1.10:554/Streaming/Channels/102#transport=tcp`
- **H.265 cameras.** The dashboard's MP4 path needs **H.264** (Chrome/Edge/Firefox
  do not decode H.265 in `<video>`). Either set the camera's sub-stream encoding
  to H.264 in its web UI (best — no CPU cost), or let go2rtc transcode:
  `ffmpeg:rtsp://user:pass@192.168.1.10:554/Streaming/Channels/101#video=h264`
  (one CPU core or more per stream; the bundled image includes ffmpeg).
- `onvif://user:pass@host` — auto-discover the stream URL.

---

## Security

- Every request needs `?token=<LIVE_TOKEN>` or the `lt` cookie Caddy sets after
  the first token request (`Secure; HttpOnly; SameSite=None; Path=/`). The
  cookie exists because go2rtc's `stream.html` page opens `/api/ws?src=…`
  without the query token.
- Rotate the token by changing `LIVE_TOKEN` in `.env`, `docker compose up -d`,
  and updating Settings › Live Video › TOKEN.
- **Alternative: go2rtc basic auth.** Add `username` / `password` under `api:`
  in `go2rtc.yaml`; the dashboard server supports it for its own calls via
  API USER / API PASSWORD (`LIVE_BRIDGE_USER` / `LIVE_BRIDGE_PASS`). Browsers
  cannot attach basic-auth credentials to a cross-origin `<video src>`, though,
  so tiles would not play — keep the token proxy for anything browser-facing
  and use basic auth only on an internal API URL.
- `go2rtc.yaml` on the bridge holds camera passwords once sources are
  registered. Keep it there; the dashboard only ever shows masked URLs
  (`rtsp://user:••••@…`).
- Do not publish 1984 publicly; 8554 (RTSP restream) and 8555 (WebRTC) are
  optional and can be removed from `docker-compose.yml` or firewalled.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `401` / `403` on tiles or *Test bridge* | Token in Settings › Live Video differs from `LIVE_TOKEN`, or `.env` changed without `docker compose up -d` |
| Tiles blank, console shows *Mixed Content* | The dashboard is HTTPS, so the public base must be `https://` — never `http://IP:1984` |
| *Bridge unreachable* | DNS / firewall to 443, or Caddy has no certificate yet (`docker compose logs caddy`) |
| Stream **Registered** but probe says timeout | Bridge cannot reach the camera: check routing / firewall to TCP 554, credentials, path; try `#transport=tcp` |
| Probe OK, tile stays *BUFFERING* / black | Camera sends H.265 — switch it to H.264 or use the `ffmpeg:…#video=h264` source |
| `CORS` error in the console | `api.origin: "*"` missing from `go2rtc.yaml`, or a proxy other than the bundled Caddyfile strips `Access-Control-Allow-Origin` |
| Pop-out page loads but never plays | `/api/ws` was blocked: the `lt` cookie was not set (open the pop-out from the dashboard so the URL carries `&token=`), or a proxy without WebSocket upgrade (nginx: see `Upgrade` headers in `nginx.conf.example`) |
| Tile says `NOT ON LIVE BRIDGE` | Stream not registered yet — Settings › Live Video › *Register all RTSP sources*, or the camera has no RTSP URL in SenseStudio |
| Sources vanish after restart | `go2rtc.yaml` mounted read-only or not mounted; the volume must be writable |
