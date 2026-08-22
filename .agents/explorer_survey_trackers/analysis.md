# In-Depth Survey & Architectural Analysis: Transit Trackers & Timetable Synthesizer

**Author**: Explorer Subagent (Codebase Trackers & Endpoints Architecture)  
**Date**: 2026-08-22  
**Target Milestone**: Eliminating Synthetic Fixed-Interval Schedules across Mataró Bus & Transit Providers  
**Integrity Mode**: Read-Only Survey  

---

## 1. Executive Summary

This survey conducts an exhaustive architectural investigation across all transit tracker implementations (`src/mataroTracker.js`, `src/maresmeTracker.js`, `src/sagalesTracker.js`, `src/ambTracker.js`, `src/cataloniaTracker.js`, `src/rodaliesTracker.js`, `src/corridorTracker.js`), core transit engines (`src/core/schedule/scheduleSynthesizer.js`, `src/core/schedule/delayEngine.js`, `src/core/time/calendarEngine.js`), and server endpoint harmonizers (`server.js`).

### Core Findings
1. **Primary Source of Synthetic Schedules**: `src/mataroTracker.js` contains a hardcoded `MATARO_LINE_SCHEDULES` dictionary (lines 12–53) specifying uniform headway values (e.g. 15m, 20m, 30m). Lines 775–811 and 821–853 generate theoretical departures using uniform arithmetic steps `depSec += headwaySec`, creating artificial equal-interval grids instead of authentic Mataró Bus (CTSA / Avanza) departure matrices.
2. **Secondary Synthetic Elements**: `src/ambTracker.js` contains a modulo-based headway estimation for real-time delay matching (`closestSlotMin = Math.round(totalMinutes / headway) * headway`, line 701) and a uniform step loop for daily scheduled departures (line 748). `src/sagalesTracker.js` and `src/rodaliesTracker.js` use explicit static departure time arrays (`baseTimes`, `baseHours`) with cumulative travel time offsets rather than arbitrary uniform loops.
3. **Gold Standard Reference Trackers**:
   - `src/corridorTracker.js` (`src/c10StaticData.js`): Uses full GTFS trip matrices with per-stop departure and arrival times across seasonal calendars (`calendarEngine`).
   - `src/cataloniaTracker.js`: Directly parses ATM GTFS `calendar.txt`, `calendar_dates.txt`, and `trips.txt` via SQLite and `cataloniaIndexer.js`, delivering authentic timetables across 1,610 routes.
   - `src/maresmeTracker.js`: Integrates Moventis API real-time SAE ETAs and full stop timetables (`moventisClient.getParadasTimetable`), backed by ATM GTFS stop times.
4. **API Parity & Canonical Schema Compliance**: `server.js` enforces schema uniformity via `harmonizeDeparturesEnvelope`, `harmonizeTargetEta`, and `standardizeVehicle`. All endpoints preserve backward compatibility with legacy routes (`/api/c10/*`, `/api/mataro/*`).
5. **Baseline Test Status**: The existing test suite (`test/verification_test.js`, `test/core_transit_modules_test.js`, `test/m3_smoke_test.js`, `test/challenger_tracker_schedule_test.js`) is 100% operational and passes with zero errors.

---

## 2. Root Cause Audit: Fixed-Interval Arithmetic & Synthetic Schedules

Below is the complete audit of all locations in the codebase where departures or schedules are generated using fixed-interval arithmetic, uniform steps, or fallback approximations:

| File | Line Numbers | Mechanism / Pattern | Root Cause / Purpose | Problem / Artifact |
| :--- | :--- | :--- | :--- | :--- |
| `src/mataroTracker.js` | 12–53 | `MATARO_LINE_SCHEDULES` definition with `headwayMins: 15/20/25/30` | Static configuration of line frequency spans | Assumes uniform headway throughout the day; fails to differentiate peak vs. off-peak frequencies. |
| `src/mataroTracker.js` | 775–811 | `for (let depSec = startSecToday; depSec <= endSecToday; depSec += headwaySec)` | Generates remaining scheduled departures for the current day | Produces uniform 15, 20, 25, or 30-minute departure grids for Mataró lines 1–8 instead of official trip matrices. |
| `src/mataroTracker.js` | 821–853 | `for (let depSec = startSecTomorrow; depSec <= endSecTomorrow && tripCount < 10; depSec += headwaySecTomorrow)` | Generates tomorrow's first morning trips | Produces uniform synthetic morning intervals instead of true official first morning runs. |
| `src/ambTracker.js` | 700–704 | `const headway = (route.code.startsWith('M')) ? 8 : ...; const closestSlotMin = Math.round(totalMinutes / headway) * headway;` | Estimates scheduled slot for delay comparison from live GPS | Modulo slot estimation approximates schedule rather than matching against official GTFS trip times. |
| `src/ambTracker.js` | 748–772 | `for (let m = Math.ceil((currentMinOfDay + 5) / headway) * headway; m <= endMinOfDay; m += headway)` | Generates scheduled daily departures for AMB lines | Generates uniform 10- or 15-minute synthetic departure grids. |
| `src/rodaliesTracker.js` | 455–458 | `const headway = 15; const closestSlotMin = Math.round(totalMinutes / headway) * headway;` | Modulo slot estimation for real-time Rodalies train delay | Modulo 15m approximation instead of exact train schedule slot. |
| `src/core/schedule/scheduleSynthesizer.js` | 180–194 | `synthesizeHeadwayDepartures(config)`: `for (let s = startSec; s <= endSec; s += headwaySec)` | Reusable frequency synthesizer utility | Generates synthetic uniform timetables when given a headway interval. |

---

## 3. Comprehensive Survey of Tracker Implementations

### 3.1 `src/mataroTracker.js` (Mataró Bus L1–L8)
* **Operator**: CTSA / Avanza (Mataró Bus Urbà).
* **Line Resolution**: `resolveLineConfig(lineId)` strips prefixes (`mataro_`, `line-`, `l`) and matches against `linesData` (8 lines: L1 through L8).
* **Directions & Topology**:
  - Routes and shapes stored in `data/cities/mataro/mataro_routes_full.json` (16 route directions: 2 per line).
  - Stops stored in `data/cities/mataro/mataro_paradas.json` (153 unique urban stops).
  - Direction representation: `'0'` (Anada) and `'1'` (Tornada), or `'both'` for map overlay.
* **Real-Time Telemetry**:
  - Protocol: SIRI SOAP 2.0 (`sirimataro.avanzagrupo.com`) via `mataroSiriClient.js`.
  - Methods: `getLiveVehicles(lineRef)` for live vehicle coordinates, `getStopArrivals(stopId, lineRef)` for stop arrivals.
  - Circuit Dead-Reckoning: `processBusesWithDeadReckoning` and `estimateArrivalsForStop` compute physical ETA along polyline with 12-second cache and dead-zone extrapolation.
* **Scheduled Departures**:
  - Currently relies on `MATARO_LINE_SCHEDULES` uniform headway looping (Lines 775–853).
  - Cumulative stop travel times are calculated via `scheduleSynthesizer.estimateStopTravelTimes` (`speedMps: 4.8`, `dwellSecPerStop: 25`, `defaultSegmentMeters: 300`).

---

### 3.2 `src/maresmeTracker.js` (Moventis Interurbà Maresme)
* **Operator**: Empresa Casas / Moventis (Interurbà Maresme lines: e11.1, e11.2, C-20, C-30, N80, N81, 603, 627, 650, etc.).
* **Line Resolution**: `resolveLine(lineId)` matches against internal catalog of 11+ Moventis lines.
* **Directions & Topology**:
  - Routes loaded from `data/cache/maresme_cache.json` or generated from ATM GTFS.
  - Direction mapping: `0` (Anada / Sentit V), `1` (Tornada / Sentit I).
* **Real-Time Telemetry**:
  - Moventis SAE API (`moventisClient.getRealtimeStopETAs`) for real-time stop predictions.
  - Mou-te API (`mouteClient.getNextDepartures`) fallback with strict line code and stop validation.
* **Scheduled Departures**:
  - Ingests official stop timetables from `moventisClient.getParadasTimetable` and ATM GTFS `this.tripsMap` / `this.stopTimesByTrip`.
  - Lines 1155–1225 iterate over authentic GTFS trips to find exact stop departure times (`st.dep`).
  - No uniform headway arithmetic.

---

### 3.3 `src/sagalesTracker.js` (Sagalés Interurbà & Nocturn)
* **Operator**: Sagalés (Costa, Vallès, Nocturns: N82, N83, 603, N70, N71, N73, etc.).
* **Line Resolution**: `resolveLineConfig(lineId)` matches clean line code against `SAGALES_LINES_CONFIG`.
* **Directions & Topology**:
  - Polyline coordinates and stops structured per direction (`0` and `1`).
* **Real-Time Telemetry**:
  - Sagalés GTFS-RT feed (`real-time-bus/:routeId/:dir`) with entity matching on `tripUpdate.stopTimeUpdate`.
* **Scheduled Departures**:
  - When GTFS-RT feed is unavailable (or during off-peak/night hours), uses `baseScheduleMap` (Lines 478–504) containing exact trip departure matrices (e.g. N82: `['23:45', '00:45', '01:45', '02:45', '03:45', '04:45']` for dir 0, `['23:30', '00:30', ...]` for dir 1).
  - Stop travel times are calculated via `scheduleSynthesizer.estimateStopTravelTimes` (`speedMps: 10.0`, `dwellSecPerStop: 30`, `defaultSegmentMeters: 600`).
  - Does NOT generate uniform arithmetic intervals.

---

### 3.4 `src/ambTracker.js` (AMB Mobilitat / Àrea Metropolitana)
* **Operator**: AMB Mobilitat (TUSGSAL, Avanza Baix, Monbus, Moventis, Soler i Sauret - lines: B25, M27, L70, N12, PR1, etc.).
* **Line Resolution**: `resolveLine(lineId)` matches 243 AMB bus lines and 7,467 stops.
* **Directions & Topology**:
  - Routes loaded from `data/cache/amb_routes.json` and shapes from AMB GTFS API.
* **Real-Time Telemetry**:
  - AMB Real-time API (`getStopRealtime(stopCode)`).
* **Scheduled Departures**:
  - Lines 700–704: Uses headway modulo (8m, 12m, 15m) to estimate delays.
  - Lines 748–772: Generates daily scheduled departures using `for (let m = ...; m <= endMinOfDay; m += headway)` (headway = 10m for MetroBus 'M', 15m for others).
  - Lines 780–813: Appends tomorrow morning trips from `baseHours` template.

---

### 3.5 `src/cataloniaTracker.js` (Generalitat Mou-te / ATM Catalunya)
* **Operator**: Interurban buses across Catalonia (1,610 routes, 36,092 stops).
* **Line Resolution**: `resolveLine(lineId)` matches route IDs and codes from ATM GTFS index.
* **Directions & Topology**:
  - Indexed by `cataloniaIndexer.js` from `data/atm_gtfs/*.txt` into JSON cache files (`routes.json`, `route_details.json`, `stops.json`, `calendar.json`, `calendar_dates.json`) and SQLite shapes (`data/shapes.db`).
* **Real-Time Telemetry**:
  - Generalitat Mou-te API (`mouteClient.getNextDepartures`).
* **Scheduled Departures**:
  - Authentic GTFS schedules: `getScheduledDeparturesForDate(route, dirIdx, dateObj)` filters `schedulesByDirection` through `calendarEngine.isServiceActiveOnDate(serviceId, dateObj)`.
  - Matches exact GTFS trips, deduplicating identical departure times without synthetic intervals.

---

### 3.6 `src/rodaliesTracker.js` (Rodalies de Catalunya)
* **Operator**: Rodalies de Catalunya (Renfe / SNCF commuter rail: R1, R2, R3, R4, RG1, RT1, etc. - 20 lines, 205 stations).
* **Directions & Topology**:
  - Stations and rail lines loaded from `data/cache/rodalies_stations.json`.
* **Real-Time Telemetry**:
  - Rodalies API live train departures (`getStationRealtime`).
* **Scheduled Departures**:
  - Off-peak schedule uses `baseHours = ['05:00', '05:30', '06:00', '06:15', '06:30', ...]` with cumulative rail station travel times.

---

### 3.7 `src/corridorTracker.js` (C-10 Corridor)
* **Operator**: Moventis / Casas (C-10 Barcelona ⇄ Mataró per N-II).
* **Topology & Timetables**:
  - Encoded in `src/c10StaticData.js` with complete stop arrays (Direction 1: 53 stops; Direction 0: 52 stops) and GTFS trip matrices with per-stop passing times across all weekday, Saturday, and Sunday calendars (Summer August & Winter).
* **Real-Time Telemetry**:
  - Mou-te API live arrivals + GTFS matching for delay status calculation.
  - Continuous bus interpolation along corridor with terminal layover tracking.

---

## 4. Architectural Blueprint for Authoritative Mataró Bus Timetables

### 4.1 Route & Direction Structure for Mataró Bus Lines 1–8
From `data/cities/mataro/mataro_routes_full.json`:

| Line | Line Name | Direction 0 (Route ID / Name / Stops) | Direction 1 (Route ID / Name / Stops) |
| :--- | :--- | :--- | :--- |
| **L1** | Circular | Route `12`: Hospital - Rodalies (15 stops) | Route `11`: Rodalies - Hospital (23 stops) |
| **L2** | Circular | Route `11`: Hospital - Rodalies (23 stops) | Route `12`: Rodalies - Hospital (16 stops) |
| **L3** | Camí de la Serra - Vista Alegre - Rocafonda | Route `11`: Rodalies - Hospital Mataró (24 stops) | Route `12`: Hospital - Rodalies (17 stops) |
| **L4** | Cirera - Molins | Route `12`: Hospital - Rodalies (14 stops) | Route `11`: Rodalies - Hospital (17 stops) |
| **L5** | Rodalies - Hospital de Mataró | Route `11`: Rodalies - Hospital (9 stops) | Route `12`: Hospital - Rodalies (11 stops) |
| **L6** | Institut Català Salut - Ctra. de Mata | Route `11`: Ctra. Mata - ICS (11 stops) | Route `12`: ICS - Ctra. Mata (12 stops) |
| **L7** | Pl. Tereses - Cerdanyola | Route `12`: Pl. Tereses - Parc Cerdanyola (6 stops) | Route `11`: Parc Cerdanyola - Pl. Tereses (5 stops) |
| **L8** | Rodalies - Galícia | Route `11`: Galícia - Rodalies (13 stops) | Route `12`: Rodalies - Galícia (25 stops) |

### 4.2 Official CTSA/Avanza Timetable Matrices to Encode
For each line (L1–L8), authoritative timetable matrices must be structured across three service calendars:
1. **`weekday` (Feiners de dilluns a divendres)**:
   - Specific peak, morning, afternoon, and valley frequencies.
   - Non-uniform step departures (e.g. Line 8 weekday runs from 06:45 to 21:45 with authentic irregular departure times).
2. **`saturday` (Dissabtes feiners)**:
   - Saturday morning and afternoon schedules.
   - **Line 8**: Afternoon-only service (Route 11: 14:04, 14:34, 15:04, 15:35, 16:05, 16:35, 17:05, 17:35, 18:05, 18:35, 19:05, 19:35, 20:05, 20:35, 21:05, 21:35; Route 12: 14:45, 15:15, 15:45, 16:15, 16:45, 17:15, 17:45, 18:15, 18:45, 19:15, 19:45, 20:13, 20:43, 21:13).
   - **Line 6**: Saturday service from 07:30 to 22:15.
3. **`sunday` (Diumenges i Festius)**:
   - Sunday service schedules for Lines 1, 2, 3, 4, 5, 7.
   - **Line 6**: Sunday afternoon-only service starting at 14:00 (Route 11) / 14:17 (Route 12).
   - **Line 8**: Sunday afternoon-only service matching Saturday afternoon timetable.

### 4.3 Stop-by-Stop Run Time Model
Rather than naive flat segment estimation, `estimateStopTravelTimes` must calculate cumulative times based on:
- Actual Haversine road polyline distance between sequential stop coordinates.
- Dwell time per stop (calibrated at 22–25 seconds for urban stops).
- Urban operating speed of ~20 km/h (5.55 m/s) with topographic adjustments for steep sections (e.g. Cerdanyola / Camí de la Serra / Cirera).

---

## 5. Required Enhancements to `src/core/schedule/scheduleSynthesizer.js`

To support authentic timetable integration cleanly across all trackers, `scheduleSynthesizer.js` must be expanded with the following capabilities:

1. **`synthesizeDeparturesFromTimetable(scheduledMatrix, stopTravelSec, options)`**:
   - Accepts an array of authoritative origin departure times (`string[]` e.g. `['06:30', '06:45', '07:00', '07:12', ...]`).
   - Applies the stop travel offset `passSec = originSec + stopTravelSec`.
   - Filters past vs. upcoming trips relative to target network time in `Europe/Madrid`.
   - Populates standardized departure objects (`departureTime`, `minutesAway`, `expectedIso`, `aimedIso`, `delayStatus: 'scheduled'`, `delayBadgeText: 'Horari teòric'`).
2. **`mergeLiveAndScheduledDepartures(liveDepartures, scheduledDepartures, options)`**:
   - Priority merging: Real-time GPS arrivals (SIRI / GTFS-RT) strictly take precedence.
   - Proximity deduplication: Suppresses scheduled departures that fall within ±3 minutes of an active real-time vehicle on the same line and destination.
   - Continuous transition: Automatically chains live arrivals with remaining scheduled departures for the day, and appends next morning's resumption when fewer than `minDepartures` (e.g. 5) remain.
3. **`generateMorningFirstService(firstServiceTimes, stopTravelSec, options)`**:
   - Extrapolates exact next-morning first trip passing time.
   - Sets `isToday: false`, `isFirstOfDay: true`, `isNextService: true`, `delayBadgeText: '🌅 1r Servei del matí'`.

---

## 6. Actionable Implementation Specifications

### Target Changes in `src/mataroTracker.js`:
1. **Replace `MATARO_LINE_SCHEDULES`**:
   - Replace the `{ inicio, fin, headwayMins }` structure with comprehensive departure arrays:
     ```javascript
     const MATARO_OFFICIAL_TIMETABLES = {
       '1': {
         '0': { weekday: [...], saturday: [...], sunday: [...] },
         '1': { weekday: [...], saturday: [...], sunday: [...] }
       },
       // ... Lines 2 through 8
     };
     ```
2. **Refactor `getScheduleForLine` / `getTimetableForLine`**:
   - Return the exact departure array for the requested line ID, route ID (or direction index), and day type (`weekday`, `saturday`, `sunday`).
3. **Refactor `getStopDepartures`**:
   - Remove the `for (let depSec = ...; depSec += headwaySec)` loops.
   - Use `scheduleSynthesizer.synthesizeDeparturesFromBaseTimes` (or the new `synthesizeDeparturesFromTimetable`) passing the exact departure array and cumulative stop travel time `travelSec`.
   - For tomorrow morning, pass tomorrow's exact departure array to `generateMorningFirstService`.
4. **Refactor `getTargetStopETA`**:
   - Set `firstServiceTomorrow` using the exact first departure from tomorrow's timetable matrix at the target stop.

### Target Changes in `src/core/schedule/scheduleSynthesizer.js`:
1. Enhance `synthesizeDeparturesFromBaseTimes` to support rich departure objects, exact timetable matrices, and clean transition chaining.
2. Ensure full backward compatibility with existing tests in `test/core_transit_modules_test.js` and `test/challenger_tracker_schedule_test.js`.

---

## 7. Verification & Regression Strategy

To ensure zero regressions and 100% compliance with requirements:

1. **Automated Verification Commands**:
   - `node test/verification_test.js` (Must pass all 5 checks).
   - `node test/core_transit_modules_test.js` (Must pass all 5 module test suites).
   - `node test/m3_smoke_test.js` (Must pass all API envelope checks).
   - `node test/challenger_tracker_schedule_test.js` (Must pass all stress tests).
   - `node test/challenger_geo_delay_test.js` (Must pass geo & delay calculations).
2. **Dedicated Timetable Authenticity Test (`test/mataro_timetable_test.js`)**:
   - Assert that no Mataró line (1–8) yields uniform 30-minute steps.
   - Verify that Line 8 on Saturday/Sunday returns empty departures in the morning and exact afternoon departures starting at 14:04 / 14:45.
   - Verify that next morning resumption displays exact official first trip times across all 8 lines.
