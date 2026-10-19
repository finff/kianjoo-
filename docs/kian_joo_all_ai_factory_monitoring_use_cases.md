# Kian Joo AI Factory Monitoring Dashboard — All Use Cases

**Prepared for:** Weststar Engineering Sdn. Bhd.  
**Purpose:** Simple requirements prompts for Claude AI  
**Scope:** Requirement analysis and dashboard design, not full implementation  
**Main dashboard module:** Employee Attendance  
**Integration concept:** CCTV Cameras → AI Studio → Backend API → Centralized Database → Dashboard

> **Status:** These are proposed requirements based on the discussions, not confirmed customer specifications. Verify available AI Studio features and customer expectations before development.

---

## Use Case 1: Employee Attendance & Face Recognition

I want to develop an **Employee Attendance Dashboard** for an AI-powered factory monitoring system. It should support multiple factory plants and integrate with an existing AI Studio platform.

### Requirements

1. **Employee Registration**
   - Allow admins to register employees with name, employee ID, department, assigned plant, and face enrollment information.
   - Synchronize employee face references with AI Studio securely.
2. **Face Recognition**
   - CCTV cameras capture employee faces and AI Studio recognizes registered employees.
   - Send recognition events to the dashboard, including employee ID, camera, plant, detection time, and recognition status.
3. **Employee Movement History**
   - Save recognition events across plants under the same employee record.
   - Example: Ijat detected at Plant A at 9:00 AM and Plant B at 9:10 AM; display both events in a report.
   - Treat this as a record of detection points, not continuous tracking.
4. **Attendance Dashboard**
   - Display employee counts and attendance statuses such as present, absent, and late, where supported by attendance rules.
   - Show recent recognitions, employee movement history, filters, and reports.
   - Determine official clock-in and clock-out using designated attendance cameras and shift rules; not every recognition is a clock event.
5. **System Integration**
   - CCTV → AI Studio (Face Recognition) → API → Database → Dashboard.
   - Store employee profiles, attendance records, and detection history with appropriate access controls.

### What I Need from Claude

- Propose dashboard layout and pages for registration, attendance, and movement reports.
- Explain the AI Studio-to-dashboard data flow.
- Show sample attendance and movement reports.
- Distinguish reusable existing features from new development and questions to confirm.

**Focus on requirements and design only. Do not code yet.**

---

## Use Case 2: PPE Compliance Detection

I want to develop a **PPE Compliance Monitoring Module** for an AI-powered factory monitoring dashboard using CCTV cameras and an existing AI Studio platform.

### Requirements

1. **PPE Detection**
   - Detect whether people are wearing required safety helmets, vests, goggles, and gloves, subject to confirmed model capabilities.
   - Monitor anyone entering an area where PPE is required, regardless of the activity being performed.
2. **PPE Violation Alerts**
   - Generate an alert when required PPE is missing within a configured monitored area.
   - Save violation type, date, time, plant, camera, and supporting image if available.
3. **Area-Based PPE Rules**
   - Allow admins to set different PPE requirements by plant and area.
   - Example: a production zone requires a helmet, vest, and goggles.
4. **Dashboard & Reports**
   - Show daily violations, recent alerts, evidence, histories, filters, and exportable compliance reports.
5. **System Integration**
   - CCTV → AI Studio (PPE / Body Attribute Detection) → API → Database → Dashboard.

### What I Need from Claude

- Suggest PPE dashboard pages, violation alerts, zone-rule management, and report examples.
- Explain detection data flow and identify reusable versus new features.
- Identify model capability and accuracy questions requiring confirmation.

**Focus on requirements and design only. Do not code yet.**

---

## Use Case 3: Restricted Area Monitoring

I want to develop a **Restricted Area Monitoring Module** for an AI-powered factory monitoring dashboard using CCTV cameras and AI Studio.

### Requirements

1. **Restricted Area Detection**
   - Detect people entering configured restricted zones or crossing virtual boundaries.
   - Support multiple plants, cameras, and monitored areas.
2. **Unauthorized Entry Alerts**
   - Generate alerts for entry that violates configured authorization and access rules.
   - Record alert type, date, time, camera, plant, and available captured evidence.
   - If authorization cannot be verified, mark the event for review instead of assuming a confirmed violation.
3. **Zone Configuration**
   - Let admins configure camera-specific polygons or boundaries, permitted personnel, and time restrictions.
4. **Dashboard & Reports**
   - Display recent incidents, alert counts, evidence, status, filters, and incident reports.
5. **System Integration**
   - CCTV → AI Studio (Person Detection + Zone Rules) → API → Database → Dashboard.

### What I Need from Claude

- Suggest restricted-area dashboard layout, incident pages, zone configuration, and reports.
- Explain how authorization rules and AI events interact.
- Identify existing features, gaps, and customer decisions required.

**Focus on requirements and design only. Do not code yet.**

---

## Use Case 4: Cleaning Activity Monitoring

I want to develop a **Cleaning Activity Monitoring Module** for an AI-powered factory monitoring dashboard using CCTV, AI Studio, and configured cleaning schedules.

### Requirements

1. **Cleaning Period Monitoring**
   - Monitor PPE compliance in designated cleaning areas during planned cleaning windows.
   - Use existing PPE detection to check required equipment, especially gloves.
   - Do not claim that PPE detection alone proves someone is cleaning.
2. **Cleaning PPE Alerts**
   - Trigger a violation alert when applicable cleaning PPE rules are not met.
   - Store date, time, plant, camera, missing PPE type, and evidence if available.
3. **Cleaning Schedule Management**
   - Let admins configure planned cleaning dates, times, areas, and mandatory PPE.
   - Treat actual activity recognition as a separate optional capability if required.
4. **Dashboard & Reports**
   - Display planned cleaning windows, alerts, histories, filters, and PPE compliance reports.
5. **System Integration**
   - CCTV → AI Studio (PPE Detection) → API → Schedule/Rule Matching → Database → Dashboard.

### What I Need from Claude

- Suggest cleaning schedule and monitoring pages, workflow, and reports.
- Explain how schedules combine with detection events.
- Identify what would be needed to truly recognize cleaning activity, and which elements may be reused.

**Focus on requirements and design only. Do not code yet.**

---

## Use Case 5: Forklift Detection & Monitoring

I want to develop a **Forklift Detection & Monitoring Module** for an AI-powered factory monitoring dashboard using CCTV cameras and AI Studio.

### Requirements

1. **Forklift Detection**
   - Detect forklifts in CCTV video using an AI object detection model.
   - Record detection timestamp, camera, plant, and area.
2. **Forklift Safety Rules**
   - Configure areas where forklift operation is prohibited or restricted.
   - Trigger alerts on configured zone-rule violations.
   - Treat pedestrian proximity and unsafe operation detection as optional advanced functions requiring validation.
3. **Alert Management**
   - Save incident type, date, time, camera, plant, available images, and review status.
4. **Dashboard & Reports**
   - Display forklift detections, incidents, recent activity, plant/camera filters, and reports.
5. **AI Model Training**
   - Check whether AI Studio already supports forklift detection.
   - If training is required, propose an annotated dataset, validation, export, integration, and testing process.
   - Do not assume that object detection identifies driver identity, speed, or unsafe driving without additional technology.
6. **System Integration**
   - CCTV → AI Studio (Forklift Detection) → API → Database → Dashboard.

### What I Need from Claude

- Suggest forklift dashboard layout, alerts, zone settings, and incident reports.
- Describe AI model training and AI Studio integration needs.
- Identify reusable components, new work, and items to confirm with the customer.

**Focus on requirements and design only. Do not code yet.**

---

## Overall Dashboard & Presentation Instructions

After reviewing each use case individually, help me map the requirements into **one centralized AI Factory Monitoring Dashboard** with Employee Attendance as the main module. Use existing AI Studio capabilities whenever verified, and do not assume all five use cases require separately trained models.

For the Weststar internal presentation, provide:

1. Customer requirement summary for each use case.
2. AI model or rule engine required and whether availability is confirmed.
3. CCTV → AI Studio → dashboard data flow.
4. Dashboard data, alerts, and reports for each use case.
5. Existing functionality versus development gaps.
6. Questions requiring clarification with Kian Joo.
7. A phased implementation plan and future commercialization considerations.

Clearly label **Confirmed Requirement**, **Proposed Solution**, and **To Be Confirmed**. Do not start building the full dashboard or writing code until the scope is agreed.
