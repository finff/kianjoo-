# Kian Joo Vision AI POC — Requirements & Scope

## 1. POC Platform and Architecture

- The POC will use a **temporary externally hosted Vision AI environment**.
- CCTV video streams will be accessed via **RTSP** for analytics processing.
- The Vision AI platform will process the video stream but will **not replace** the customer's existing VMS or NVR.
- Existing video recordings will remain within Kian Joo's existing VMS/NVR environment.
- The POC platform will primarily retain:
  - Event metadata
  - Event snapshots
  - Detection records
  - Analytics results
  - Dashboard records
- The data exchange between the analytics platform and dashboard will be performed through **API or event callbacks**.
- Final storage requirements will be assessed during the POC based on actual event volume and the agreed retention period.

## 2. POC Compute and Analytic Capacity

- The POC environment has **limited GPU resources** compared with the intended production environment.
- The available GPU capacity is suitable for controlled POC validation, but not necessarily for running every requested analytic at all camera locations concurrently.
- Initial planning indicated:
  - Up to **8–10 analytic streams per GPU**, subject to model complexity
  - Approximately **6–8 usable analytic tasks per GPU**, after allowing stability headroom
  - Around **11–12 analytics** may potentially be supported using two available GPU units, subject to benchmark results
- Actual capacity depends on:
  - Selected AI models
  - Video resolution and frame rate
  - Number of concurrent analytic tasks
  - Model complexity
  - GPU specifications
  - Required performance and latency

## 3. Use Case 1: Personnel Identification, Attendance and Movement Monitoring

### 3.1 Employee Enrolment

- Kian Joo initially requested approximately **200 Plant 1 employee profiles**.
- For the controlled POC, the proposed initial sample is **10 selected employees**.
- Other non-enrolled personnel will still be detected but will be classified as **Unknown Personnel**.
- The POC is intended to validate the use case and does not represent the maximum production capacity of the solution.
- Expanding the enrolment database to 200 employees may be considered after the initial validation or during production deployment.

### 3.2 Employee Data Required

Kian Joo will provide the following for the selected employees:

- Employee photograph
- Employee or staff ID

> Employee names, contact details, addresses or other personal information are **not required** for the POC.

### 3.3 Data Privacy

- Kian Joo will coordinate with its HR team and relevant employee representatives regarding the use of facial images for the POC.
- Kian Joo will obtain the necessary notification, authorization or consent before employee data is shared.
- Employee data will be transferred through an approved secure method, potentially using a **controlled SharePoint folder**.
- Access, retention and deletion requirements must be agreed **before** data transfer.

### 3.4 Attendance Events

The POC dashboard will record:

- Employee or staff ID
- Detection location
- Detection date and time
- Entry or attendance event
- Exit event, where applicable
- Facial snapshot
- Unknown-person event

### 3.5 Scope Boundary

- POC attendance records will be generated within the POC platform or dashboard **only**.
- Direct integration with Kian Joo's HRMS or official attendance system is **excluded** from the current POC.
- HRMS integration will be assessed separately as part of the production implementation.

### 3.6 Movement Tracking

Movement tracking will use facial-recognition events captured at predefined camera points.

The proposed movement journey may include:

1. Plant 1 Guard Post
2. Lobby Entrance
3. 8 Color Entrance
4. Conventional Entrance
5. Plant 2 Guard Post

The dashboard will arrange detections chronologically to show the employee's selected movement journey.

**Limitations**

- This is **not** continuous GPS-style tracking.
- Movement is only visible when the employee is detected at an allocated camera point.
- If the employee follows a route without a selected camera, that portion of the journey will not be captured.
- The POC will therefore use predefined routes and selected camera points.
- The final production deployment may have broader coverage subject to camera availability, infrastructure and platform capacity.

### 3.7 Inter-Plant Movement

- Plant 1 and Plant 2 Guard Post cameras will be used to assess inter-plant movement.
- The customer clarified that the **last detected location should not automatically be interpreted as an exit event**.
- An employee may be detected entering Plant 2 and subsequently leave using a vehicle without another facial detection.
- The dashboard may use the last detected location and an agreed inactivity interval to indicate the **latest known location**.

### 3.8 Facial Recognition and Movement Cameras

Kian Joo indicated that new cameras are planned for personnel identification at five locations:

| Location             | Camera Arrangement      |
| -------------------- | ----------------------- |
| Plant 1 Guard Post   | Entry and exit cameras  |
| Plant 2 Guard Post   | Entry and exit cameras  |
| Lobby Entrance       | Entry and exit cameras  |
| 8 Color Entrance     | Entry and exit cameras  |
| Conventional Entrance| Entry and exit cameras  |

## 4. Use Case 2: Restricted-Area Monitoring

### 4.1 Waste Area, Spot 9

The Waste Area was confirmed as the **main restricted-area use case** for the POC.

**Proposed Rule**

- Only forklift traffic is permitted within the defined restricted zone.
- Pedestrians crossing the configured virtual boundary should trigger an alert.
- A person detected as part of, or within, the forklift operator area should be handled according to an agreed rule to prevent incorrect pedestrian alerts.
- The restricted-zone boundary will be drawn within the camera view.

**Expected Results**

| Scenario                                        | Expected Result                     |
| ----------------------------------------------- | ----------------------------------- |
| Forklift enters the permitted zone              | No pedestrian-intrusion alarm       |
| Pedestrian crosses the virtual boundary         | Immediate intrusion event and alert |
| Person remains outside the defined boundary     | No violation alert                  |

### 4.2 Racking Area

- The earlier Racking Area requirement was discussed.
- Based on the workshop discussion, the restricted-area POC may focus on **Waste Area, Spot 9**, instead of the Racking Area.
- The final inclusion or exclusion of the Racking Area must be reflected in the updated requirement matrix.

## 5. Use Case 3: PPE Compliance Monitoring

PPE analytics will be concentrated at:

- **Line 5**
- **Waste Area, Spot 9**

### 5.1 Proposed PPE Items

- Safety vest
- Hard helmet
- Gloves
- Safety goggles
- Safety boots
- Hair net
- Ear protection, subject to camera visibility

### 5.2 Waste Area PPE

The forklift operator may be assessed for:

- Safety vest
- Hard helmet

### 5.3 Line 5 Cleaning PPE

For an approved cleaning activity, the worker is expected to wear:

- Cleaning gloves
- Safety goggles

## 6. Use Case 4: Line 5 Operational and Behavioural Analytics

The workshop discussed the following three primary Line 5 scenarios:

1. Loitering
2. Cleaning activity
3. Fighting or abnormal physical behaviour

### 6.1 Loitering

- Loitering will be configured using a defined zone and dwell-time threshold.
- The system can detect the presence and duration of individuals.
- The solution **cannot** determine the actual content of a conversation.
- "Chit-chat" should therefore be represented as a measurable loitering or dwell-time rule.

### 6.2 Cleaning Activity

Cleaning activity may be assessed using:

- Selected cleaning zone
- Observable cleaning action
- Required gloves and safety goggles

### 6.3 Fighting or Abnormal Behaviour

- The use case will require a supported behaviour model or further customization.
- Only **safe, controlled and non-contact staged tests** should be used.
- Waste Area was mentioned as a potential test location, subject to confirmation.

## 7. Notifications and Escalation

**Agreed Initial POC Approach**

- **Email notification** will be used as the primary notification channel.
- The notification may include:
  - Event type
  - Camera or location
  - Date and time
  - Event snapshot
  - Person or employee ID, where available
  - Violation details

## 8. Dashboard and Reporting

The POC dashboard is expected to provide:

- Facial-recognition events
- Employee or staff ID
- Detection location
- Detection date and time
- Known and Unknown Personnel classification
- Attendance events
- Movement history
- PPE compliance and violation events
- Restricted-area intrusion events
- Event snapshots
- Historical event search
- Basic event summary and analytics

### 8.1 Customer Reporting Expectation

Kian Joo requested the ability to search for a selected employee ID and obtain:

- Earliest detection or entry time
- Latest detection or exit time
- Camera locations
- Movement sequence
- Relevant event records

## 9. Connectivity Requirements

- The Vision AI platform requires access to the selected CCTV streams.
- The proposed setup is expected to require **customer-approved outbound connectivity** from the Kian Joo environment.
- The final connectivity architecture may use:
  - Internet connectivity
  - Fixed public IP, if required
  - VPN
  - Firewall rules
  - Port mapping
  - Approved one-way stream initiation
- The dashboard will display analytics and reports, **not necessarily continuous live video**.
