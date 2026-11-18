# Violation playback: 15 s before to 15 s after a detection

Requirement: for any violation, an operator can play the video from 15 seconds
before the detection to 15 seconds after it.

## How it works

The web host is shared hosting. It records nothing and cannot run ffmpeg or
go2rtc. The customer's **NVR, or a camera with an SD card, already records**,
and Hikvision, Dahua and most other brands can replay a time range of that
recording over **RTSP playback**.

When someone presses **Playback** on a detection:

1. `GET /api/playback/info?event=UUID` works out the detection time, the camera,
   and the window [time − 15 s, time + 15 s]. It does not contact the recorder.
2. `GET /api/playback/clip?event=UUID` builds a time-ranged RTSP URL from the
   brand template and pulls it from the recorder through the same PHP RTSP
   relay as live video (`lib/RtspRelay.php`). It streams the H.264 frames to
   the browser in the `/live/relay` record format, and stops once the 30 s span
   is done (90 s at most).
3. The browser plays the clip with jmuxer / Media Source Extensions. Pause,
   replay and scrubbing work, and a red marker shows the moment of the
   detection.

If playback is not set up, or the recorder refuses, the player shows the
detection snapshots with "Recording not available" and the reason (for
example "the recorder refused the login" or "no recording for this time"). It
never shows a blank or endlessly spinning player.

Credentials stay on the server. The browser only ever sees masked URLs.

## What the customer (NVR / camera team) must provide

| # | Item | Why |
|---|------|-----|
| 1 | **Recorder brand and model** (Hikvision / Dahua / other) and firmware | Picks the URL preset. Other brands need their RTSP playback URL format. |
| 2 | **Continuous recording enabled** for every AI camera, kept at least as long as violations need reviewing (for example 7 to 30 days) | Playback can only return what was recorded. Motion-only recording may leave gaps. |
| 3 | **Recording codec H.264** (not H.265 / H.265+ / Smart Codec) | Browsers cannot play H.265 through Media Source Extensions. If the main stream must stay H.265, use **dual-stream recording** with an H.264 sub-stream and a custom template that points at the sub-stream (Hikvision: `…/tracks/{channel}02…`). |
| 4 | **RTSP (TCP 554 or the port they choose) reachable from the web server's public IP**, either by port forwarding / NAT to the NVR or through a VPN or tunnel, with an allow-list for the web host's IP | The web host connects out to the recorder. Without this, every clip fails with "cannot be reached". |
| 5 | **A dedicated recorder user with playback rights only**, plus its password | Stored on the server and used for RTSP Digest / Basic login. |
| 6 | **Channel number of each AI camera on the NVR** (for example camera "CAM03" = NVR channel D3 / 3; on some older Hikvision NVRs IP channels start at 33) | The URL addresses recordings by channel. The site guesses the channel from the camera's own RTSP path. Fill in the table when the NVR numbering differs. |
| 7 | **NTP time sync** on the NVR and the cameras (same NTP as SenseStudio if possible), and the NVR's **time zone** (normally Malaysia, UTC+8) | The clip is cut by clock time. A clock that is off by N seconds shifts the clip by N seconds. |
| 8 | Enough **playback bandwidth / concurrent playback sessions** on the NVR and uplink (around 2 to 8 Mbit/s per clip) | Each open player pulls one stream in real time. |

## What the site owner configures

**Settings › Cameras & RTSP › Violation playback (recorder)**

1. **Recorder brand**: Hikvision or Dahua preset, or a custom template.
2. **Recorder host**: the NVR address and port as seen from the web server,
   for example `203.0.113.10:554`. Leave it blank only when each camera's own
   RTSP host (with an SD card) is the recorder.
3. **Recorder user and password**: the playback user from item 5. Leave them
   blank to use each camera's RTSP login.
4. **Per-camera recorder channel**: from item 6. Leave it blank to use the
   channel guessed from the camera's RTSP path (Hikvision `/Channels/301` → 3,
   Dahua `channel=3` → 3).
5. **Seconds before / after**: 15 / 15 by default (90 s total at most).
6. **Time zone in the URL**:
   - **Site time (MYT)**: the default. Most Hikvision and Dahua recorders read
     the URL time as their local clock, even with a trailing `Z`.
   - **UTC**: choose this if a test clip is exactly 8 hours off.
7. **Recorder clock offset**: only if the NVR clock is known to drift.
8. Press **Test playback** with a camera selected. It pulls about 2 s of
   recording from 2 minutes ago using the values on screen and reports frames
   received, or a plain reason. Then switch **Play violations from the
   recorder** on and **Save**.

### URL templates

| Preset | Template |
|---|---|
| Hikvision | `rtsp://{host}/Streaming/tracks/{channel}01?starttime={start:Ymd\THis\Z}&endtime={end:Ymd\THis\Z}` |
| Dahua | `rtsp://{host}/cam/playback?channel={channel}&starttime={start:Y_m_d_H_i_s}&endtime={end:Y_m_d_H_i_s}` |

Placeholders: `{host}`, `{user}`, `{pass}`, `{channel}`, `{stream}`,
`{start:FORMAT}` and `{end:FORMAT}`. FORMAT is a PHP `date()` format rendered
in the chosen time zone; `U` gives Unix seconds. When the URL has no
`user:pass@` part, the recorder login is inserted automatically.

## Time handling

- `events.trigger_time` is SenseStudio's detection time, for example
  `2026-07-06 16:01:41.372`. It is wall-clock time with no zone, which means
  site time (`APP_TZ`, Asia/Kuala_Lumpur, UTC+8). `received_at` is this
  server's wall clock in the same zone.
- The trigger time is used unless it is implausible against `received_at`
  (later than receipt by more than 5 minutes, or earlier by more than 6 hours).
  That happens, for example, when SenseStudio sends UTC without a zone. In that
  case `received_at` is used, and `time_source` in `/playback/info` says so.
- The window is [floor(t − 15), ceil(t + 15)] seconds. The marker is the
  detection's offset into the clip, with milliseconds kept.
- A detection less than about 20 s old is "still being written". The player
  says so and retries automatically when the "after" part exists.

## Limits

- Each open clip holds one PHP worker for up to about 30 to 40 s. Clips count
  against the same limit as live tiles (`RelayHub::MAX_VIEWERS`, 4 at once).
  Beyond that the player says the relay is busy.
- The recorder usually starts a clip at the keyframe nearest the requested
  start. The marker can therefore be off by up to one GOP (typically 1 to 2 s).
  Setting the camera's I-frame interval to 1 to 2 s keeps this small.
- Video only; audio is not relayed.
- iPhone Safari before iOS 17.1 has no Media Source Extensions and shows the
  snapshots with an explanation.
