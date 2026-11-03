# Kian Joo Can Factory Berhad — Vision AI CCTV POC Test Plan

**POC period:** Monday 7 September to Saturday 12 September 2026.
**Scope:** Plant 1, plus Plant 2 guard posts for inter-plant tracking.
**Scored against:** the "Vendor Evaluation & POC Scoring Matrix": 54 weighted criteria (total weight 141) and 21 test cases.
**Recorded in:** the dashboard's **POC Scorecard** page. It holds the criteria scores, the test results with live system evidence, a CSV export and a printable final report.

## 1. Methodology

1. **Evidence over claims.**
   - Each criterion is scored 0–5 from what was observed on site:
     - 0: not available / fails requirement
     - 1: very poor / major gaps
     - 2: partially meets / significant limitations
     - 3: meets basic requirement
     - 4: good / exceeds requirement
     - 5: excellent / proven capability
   - Vendor statements go in *Evidence / Remarks*. Observed behaviour goes in *POC Result / Observation*.
2. **Weighted score:** weight × score ÷ 5. The maximum is 141.
   - **Overall %** = Σ weighted ÷ Σ weight of the criteria not marked N/A.
   - **Average score** = Σ(weight × score) ÷ Σ weight of the scored criteria.
   - Interpretation of the average score: 4.0–5.0 strong candidate · 3.0–3.9 acceptable with conditions / improvements · 2.0–2.9 significant gaps · below 2.0 not recommended for wider deployment.
   - Summary groups: Technical (1–28, 43–45) · AI Accuracy (29–31) · Infrastructure (32–37) · Reporting (38–42) · Commercial (49–51).
3. **Accuracy is measured, not quoted** (criteria 29 and 31).
   - Every detection the team reviews becomes ground truth:
     - module review buttons (confirm / clear)
     - ticket closure ("False alarm" vs resolved)
     - the AI Performance sampling queue (Correct / False alarm)
   - Missed events are logged as false negatives (AI Performance → Log missed detection).
   - Precision, recall and F1 are reported per module, per camera and per lighting period (day 07:00–18:59 / night), with 95 % Wilson intervals.
   - **Target: at least 30 reviewed samples per module, and at least 100 for face recognition.**
4. **Scripted and observed tests.**
   - Each test case below is run at least **3 times**, with at least one run at night or in low light where it applies.
   - Each test is also observed passively over the week from normal production traffic.
5. **Status per criterion:** Pass / Partial / Fail / Not Tested / N/A. Each test case gets a result: Pass / Fail / Partial.
6. **Evidence to capture for every run:**
   - the dashboard screenshot or export
   - the incident / event id
   - the time
   - the camera
   - the tester
   - the expected vs the actual result
   - The POC Scorecard's "live system evidence" column fills automatically from the data. Copy it into the actual result with **use ↓**, then add the run notes.

## 2. Roles

| Role | Responsibility |
|---|---|
| Kian Joo POC lead | Approves the test plan, witnesses tests, signs off the scorecard |
| Kian Joo HR / Security | Provides employee list + photos, acts as test subjects, verifies identities |
| Kian Joo EHS | Defines PPE rules per area, cleaning schedules, verifies PPE results |
| Kian Joo IT | Network access, PoE / switch, RTSP accounts, network test witness |
| Vendor engineer | Configuration, runs tests, records evidence, daily report |

## 3. Schedule

| Day | Date | Activities |
|---|---|---|
| D1 | Mon 7 Sep 2026 | Installation check: cameras mapped to camera points / plants, RTSP sources registered and probed, **network test (INF-01, INF-02)**, SenseStudio push verified, employee enrolment and face sync (~200 Plant 1 employees), alert channels configured and tested |
| D2 | Tue 8 Sep 2026 | **Facial recognition and attendance:** FR-01, FR-02, REP-01; start of passive attendance monitoring at the guard posts |
| D3 | Wed 9 Sep 2026 | **Tracking:** TR-01, TR-02, REP-02; **restricted area:** RA-01, RA-02 |
| D4 | Thu 10 Sep 2026 | **PPE:** PPE-01, PPE-02, PPE-03 (during a scheduled cleaning window); **alerting:** ALT-01, ALT-02, ALT-03 |
| D5 | Fri 11 Sep 2026 | **Line 5 behaviour:** BEH-01 to BEH-04; night / low-light re-runs of FR-01, PPE-01, RA-01; REP-03 |
| D6 | Sat 12 Sep 2026 | Re-tests of failed / partial cases, AI-performance review (sample sizes, per-camera / day-night metrics), scorecard completion, **final POC report** (POC Scorecard → Final report → Print / PDF) |

There is a daily 30-minute stand-up at 17:00. It reviews new incidents, sampling-queue progress, open issues, and the next day's plan.

## 4. Test cases

### FR-01 — Register and identify a Plant 1 employee *(criteria 1, 3)*

**Procedure:**

1. Enrol 10 test employees (photo + staff ID) on Employees → sync to SenseStudio.
2. Each employee walks through the Plant 1 Guard Post camera 3 times, at normal pace and without stopping.
3. Repeat once in low light or backlight.
4. Open each detection.

**Pass criteria:**

- The correct name and staff ID are displayed, with camera point, location and time, for ≥ 95 % of passes.
- No passes are identified as the wrong employee.

**Evidence to capture:**

- the Attendance & Movement row and the incident detail
- the face match rate and similarity distribution (AI Performance)

### FR-02 — Unknown person detection *(criterion 2)*

**Procedure:**

1. Three non-enrolled people walk through the Guard Post and Lobby cameras, 3 passes each.

**Pass criteria:**

- Every pass is classified **Unknown** (stranger) and raised as a High alert.
- None is matched to an employee.

**Evidence to capture:**

- the Face Registration "unknown" list
- the incident list filtered on face
- the alert email

### TR-01 — Track an employee across multiple cameras *(criteria 5, 6)*

**Procedure:**

1. A test employee walks the route Guard Post → Lobby → Line 5 → Waste Area Spot 9.

**Pass criteria:**

- The movement journey shows every camera point in order, with arrival and departure times, as one linked history.

**Evidence to capture:**

- the Movement journey view
- the movement CSV export

### TR-02 — Track movement Plant 1 → Plant 2 *(criterion 7)*

**Procedure:**

1. A test employee passes the Plant 1 Guard Post.
2. They travel to Plant 2.
3. They pass the Plant 2 Guard Post.

**Pass criteria:**

- The attendance row lists both plants visited.
- The movement record shows the cross-plant transition with the correct times.

**Evidence to capture:**

- the attendance row ("plants visited")
- `/api/integration/movement?staff_id=` (`plant_transitions` ≥ 1)

### RA-01 — Unauthorized person enters a restricted zone *(criteria 13, 14)*

**Procedure:**

1. An authorised employee enters the restricted zone.
2. An unauthorised employee enters the restricted zone.
3. An unknown person enters the restricted zone.
4. Run each once in hours and once out of hours.

**Pass criteria:**

- The authorised entry is logged as authorised.
- The unauthorised and unknown entries raise a **real-time alert within 10 s** and are recorded with their image.
- The review workflow (confirm / clear) works.

**Evidence to capture:**

- the Restricted Area page entries
- the alert email / Telegram message
- the incident timeline

### RA-02 — Pedestrian enters a forklift-only zone *(criterion 15)*

**Procedure:**

1. A forklift operates in the Waste Area (Spot 9), which is configured as forklift-only.
2. A pedestrian walks in.

**Pass criteria:**

- The forklift is logged as a forklift.
- The pedestrian raises a "Pedestrian in forklift-only zone" alert.
- The Forklift page shows the forklift vs pedestrian counts.

**Evidence to capture:**

- the Forklift Monitoring KPI and table
- the alert

### PPE-01 — Hard helmet detection *(criterion 18)*

**Procedure:**

1. At an area that requires a helmet, 5 people walk past with helmets and 5 without (or wearing a cap).
2. Repeat with partial occlusion.

**Pass criteria:**

- Correct compliant / non-compliant classification for ≥ 90 % of passes.
- The violations are alerted.

**Evidence to capture:**

- the PPE Compliance violations list
- the compliance CSV
- the AI Performance PPE precision / recall

### PPE-02 — Safety vest detection *(criterion 17)*

**Procedure:** As PPE-01, with vest vs no vest.

**Pass criteria:** As PPE-01.

**Evidence to capture:** As PPE-01.

### PPE-03 — Gloves / goggles during cleaning *(criteria 21, 23, 28)*

**Procedure:**

1. During a scheduled Line 5 cleaning window, cleaners wear or omit gloves and goggles.

**Pass criteria:**

- Correct detection **where supported**:
  - gloves are a native attribute
  - goggles use the glasses estimate as a proxy
- Violations are recorded against the cleaning session.

**Evidence to capture:**

- Cleaning Monitoring: session, PPE during cleaning, violations

### BEH-01 — Normal production activity *(criterion 24)*

**Procedure:**

1. Observe Line 5 for 2 hours of normal operation.

**Pass criteria:**

- The time is classified as normal operation, with no false exceptions.
- The normal % of monitored time is reported.

**Evidence to capture:**

- the Behaviour Analytics timeline and KPIs

### BEH-02 — Chit-chat / loitering *(criterion 25)*

**Procedure:**

1. Two or more people stand together at Line 5 beyond the configured threshold (default 3 min).
2. One person idles alone.

**Pass criteria:**

- An event is detected **after the configured threshold**, and not before it.

**Evidence to capture:**

- the Behaviour Analytics exceptions, with image
- the threshold setting (Behaviour Rules)

### BEH-03 — Cleaning activity *(criterion 26)*

**Procedure:**

1. Run a cleaning task at Line 5, both inside and outside a scheduled window.

**Pass criteria:**

- A cleaning event is detected: by a custom cleaning policy, or by presence plus PPE during the window.
- The session is marked observed.

**Evidence to capture:**

- the Behaviour Analytics cleaning events
- Cleaning Monitoring "observed"

### BEH-04 — Fighting / physical altercation *(criterion 27)*

**Procedure:**

1. Run a staged, safe altercation simulation at Line 5, 3 times.
2. **Requires a SenseStudio behaviour / custom algorithm on the camera.**

**Pass criteria:**

- An abnormal event is detected and alerted (critical) with an image.

**Evidence to capture:**

- the incident, alert email / Telegram message and image

### ALT-01 — Email notification *(criterion 10)*

**Procedure:**

1. Trigger a High detection (for example RA-01).
2. Use "Send test email".

**Pass criteria:**

- The alert is **received by the designated recipient** within 1 minute, with the frame and details.

**Evidence to capture:**

- a screenshot of the mailbox
- the incident log entry

### ALT-02 — Telegram notification *(criterion 11)*

**Procedure:**

1. Trigger a High detection.
2. Use "Send test message".

**Pass criteria:**

- The alert is **received by the designated Telegram chat** within 1 minute, with the image where public.

**Evidence to capture:**

- a Telegram screenshot
- the incident log entry

### ALT-03 — Escalation after 5 minutes *(criterion 12)*

**Procedure:**

1. Trigger a High alert and leave it unacknowledged.
2. Check at 5, 10 and 15 minutes.

**Pass criteria:**

- It **escalates to the next level** (L1 → L2 → L3) at each interval.
- Escalation stops as soon as the alert is acknowledged.

**Evidence to capture:**

- the incident timeline entries ("Auto-escalated to L2 …")
- the recipient messages

### INF-01 — Connect an existing CCTV stream *(criterion 32)*

**Procedure:**

1. Register the existing cameras' RTSP streams on SenseStudio and the live bridge.
2. Probe each one.
3. Leave the live wall open for 1 hour.

**Pass criteria:**

- A **stable video feed to AI and VMS**: no drop longer than 10 s, and detections arriving throughout.

**Evidence to capture:**

- the Live Video tab (state, probe)
- the Live Feeds wall
- the ingest log

### INF-02 — Network load test *(criterion 34)*

**Procedure:**

1. Run Settings → Live Video → **Run network test** during peak shift with the live wall open.
2. Repeat it 3 times over the day.

**Pass criteria:**

- **No unacceptable packet loss or latency:**
  - every target PASS or WARN (no FAIL)
  - loss proxy 0 %
  - stream throughput ≥ the camera bitrate

**Evidence to capture:**

- the network-test table (the latest result is attached to INF-02 automatically)

### REP-01 — Attendance report *(criteria 4, 38)*

**Procedure:**

1. Generate the daily and date-range attendance reports.
2. Search by name and staff ID.
3. Export to CSV.

**Pass criteria:**

- An **accurate, searchable and exportable report**: clock-in / out matches the FR-01 runs, and late / absent flags are correct.

**Evidence to capture:**

- the attendance CSV
- `/api/integration/attendance` output

### REP-02 — Movement history *(criterion 8)*

**Procedure:**

1. Search a person's movement for a day.
2. Export it.

**Pass criteria:**

- The person's movement can be **searched and traced** across cameras and plants.

**Evidence to capture:**

- the movement CSV
- the journey view

### REP-03 — PPE / safety dashboard *(criterion 39)*

**Procedure:**

1. Review the PPE, Restricted Area, Forklift and Analytics pages (heatmap) after D4.

**Pass criteria:**

- **Trends and exceptions are visible** per area, camera and day, and exportable.

**Evidence to capture:**

- screenshots and the CSV exports

## 5. Exit criteria and final report

The POC is complete when:

- all 21 test cases have a result
- every criterion has a score and a status
- AI Performance shows the target sample sizes, or the shortfall is explained

The final report is produced from POC Scorecard → Final report. It includes:

- vendor, executive summary, key strengths, key gaps and recommendation
- overall, group and category scores with the interpretation band
- criteria with gaps
- test-case results

Print or save it as PDF, and attach:

- the full workbook CSV
- the AI-performance CSV
- the network-test result

Infrastructure recommendations are in `docs/ARCHITECTURE_AND_INFRASTRUCTURE.md`. The HRMS / MES API reference is in `docs/INTEGRATION_API.md`.
