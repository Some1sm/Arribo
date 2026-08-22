# In-Depth Survey & Architectural Specification: Schedule Synthesizer & Test Suites

**Explorer Subagent**: Schedule Synthesizer & Test Suite Explorer  
**Working Directory**: `h:/Coding/C10Data/.agents/explorer_survey_synthesizer_tests/`  
**Date**: 2026-08-22  
**Target Milestone**: R1 / R3 / R4 (Timetable Synthesizer Enhancement & Comprehensive Verification)

---

## 1. Executive Summary

This investigation surveys the transit schedule engine (`src/core/schedule/scheduleSynthesizer.js`, `src/core/schedule/delayEngine.js`), core time/calendar engines(`src/core/time/`), all tracker implementations (`src/mataroTracker.js`, `src/maresmeTracker.js`, `src/sagalesTracker.js`, `src/ambTracker.js`, `src/cataloniaTracker.js`, `src/corridorTracker.js`), and all 12 existing test suites in `test/`.

### Key Findings
1. **Root Cause of Synthetic 30-Minute Steps**:
   In `src/mataroTracker.js` (lines 775 and 821) and `src/ambTracker.js` (line 748), departures for the remainder of the operating day and next-morning resumption are generated using fixed-step loops (`depSec += headwaySec`, `m += headway`) based on static `inicio`, `fin`, and `headwayMins` config rather than authoritative trip departure arrays.
2. **Current Capabilities of `scheduleSynthesizer.js`**:
   The module provides robust primitives for calculating cumulative stop travel times (`estimateStopTravelTimes`, `getTravelTimeToStop`+), generating stop departures from base departure arrays (`synthesizeDeparturesFromBaseTimes`), and generating next-morning service (`generateMorningFirstService`). However, it lacks a high-level **Unified Timetable Synthesis Engine** that directly accepts a full line/route timetable matrix across calendar day types (`weekday`, `saturday`, `sunday`, `summer`), performs live SIRI/GPS merging, computes stop-specific offsets, and handles overnight transitions.
3. **Test Harness & Baseline Health**:
   All existing test suites (`test/verification_test.js`, `test/core_transit_modules_test.js`, `test/m3_smoke_test.js`, `test/challenger_tracker_schedule_test.js`, `test/challenger_geo_delay_test.js`, `test/adversarial_audit_test.js`, `test/e2e_multiline_test.js`, `test/e2e_flight_recorder_test.js`, `test/syntax_check.js`) pass 100% (0 syntax errors across 41 files).
4. **Test Suite Requirements Defined**:
   A dedicated timetable verification suite must be constructed to assert non-synthetic (non-uniform) departure intervals across all 8 Mataró lines, enforce official weekend/afternoon boundary constraints (e.g. Line 8 weekend afternoon 14:04 start, Line 6 Sunday afternoon 14:00 start), and verify exact next-morning resumption times.

---

## 2. In-Depth Survey of `src/core/schedule/` Modules

### 2.1 `scheduleSynthesizer.js` Analysis

The module `src/core/schedule/scheduleSynthesizer.js` contains 6 primary functions:

| Function | Signature | Purpose & Behavior | Complexity |
| :--- | :--- | :--- | :--- |
|**estimateStopTravelTimes** | `(stops = [], options = {})` | Computes cumulative meters and cumulative seconds along ordered stop sequences using Haversine distances + per-stop dwell times (`dwellSecPerStop`, default 25s) and average speed (`speedMps`, default 8.0 m/s = 28.8 km/h). Falls back to `defaultSegmentMeters` (400m) if coordinates are missing/zero. | $ON)$ where $N$ is stop count. Monotonic distance and travel time progression guaranteed. |
|**getTravelTimeToStop** | `(stopTravelTimes = [], stopIdentifier)`| Matches stop by `stopId`, `seq`, or `stopIndex` and returns cumulative `travelSec` from route origin. Returns `0` if unlocated. | $O(N)$ lookup. Safe with null/empty inputs. |
*|**synthesizeDeparturesFromBaseTimes** | `(baseDepartureTimes = [], stopTravelSec = 0, options = {})` | Takes route origin departure times (e.g. `['06:00', '06:22', ...]`), adds `stopTravelSec` to determine passing time at target stop, converts to local network date in agency timezone (`Europe/Madrid`), filters by `minMinutesAway` (default -5) and `maxMinutesAway` (default 240), and returns standardized departure objects. | $O(M)$ where $M$ is departures array length. |
**synthesizeHeadwayDepartures** | `(config = {})` | Generates synthetic fixed-interval departure steps from `startTime` to `endTime` by `headwayMinutes` (default 15m). *This is the legacy synthetic generator that will be phased out in favor of exact departure arrays.* | $O(K)$ where $K = (\text{endTime} - \text{startTime}) / \text{headway}$  |
*|**generateMorningFirstService** | `(baseDepartureTimes = [], stopTravelSec = 0, options = {})` | Generates overnight next-morning departures when today's service has ended. Computes passing times for tomorrow's date (`dayOffset: 1`), flags first departure with `isFirstOfDay: true`, `isNextService: true`, and badge text `🌝 1r Servei del matí` (or �ߌ� 1r Tren del matë` for trains). Sets `isToday: false`. | $O(M)$ where $M = \min(\text{maxCount}, \text{baseDepartureTimes.length})$. |
*|**interpolateStopArrivals**�| `(baseTripDepartureSec, stopTravelTimes = [], dateObj = new Date(), options = {})` | Generates full route stop arrival matrix for a single trip departing origin at `baseTripDepartureSec`. Emits passing times and ISO timestamps for each stop. | $O(N)$ where $N$ is stop count. |

### 2.2 `delayEngine.js` Analysis

The module `src/core/schedule/delayEngine.js` standardizes delay statuses, real-time comparisons, and API contract invariants:

1. **`computeDelayStatus(delayMinutes, isRealTime, options)`**:
   - Categorizes status:
     - `options.isPassed === true` -> `'passed'` (`Passat ✓ `)
     - `!isRealTime && (isFirstOfDay || isNextService)` -> `'scheduled'` (�ߌ� 1r Servei del matí�`)
     - `!isRealTime && isEstimated` -> `'estimated'` (`⚡ En ruta`)
     - `!isRealTime` -> `'scheduled'` (`Horari teòric`)
     - `isRealTime && delay >= 2` -> `'delayed'` (`JX min retard`)
     - `isRealTime && delay <= -2` -> `'early'` (`X min avançat`)
     - `isRealTime` -> `'on_time'` (`Puntual`)
   - Dual-compatibility: always outputs both `delayMinutes` and `delayMins` as identical integers.
2. **`findClosestScheduledTime(realtimeTimeStr, scheduledItems, maxDiffMinutes = 55)`**:
   - Matches a real-time observation time against scheduled timetable trips.
   - Handles **circular midnight rollover** (e.g. `00:04` vs `23:59` -> +5 min delay; `23:57` vs `00:03` -> -6 min delay).
3. **`standardizeDeparture(dep, defaults)`**:
   - Enforces 100% frontend contract conformance:
     - `isRealTime` and `isRealtime` (both boolean)
     - `delayMinutes` and `delayMins` (both integer)
     - `departureTime` (valid HH:MM)
     - `expectedIso` and `aimedIso` (valid ISO strings, never `0001-` or `1970-`)
     - `formattedStatus` (e.g. 'Imminent', '5 min', or 'HH:MM')

---

## 3. Current Timetable Processing Across Transit Operators

| Operator / Tracker | Current Departure Source | Headway / Uniform Step Vulnerability | Transition to Next Morning Resumption |
| :--- | :--- | :--- | :--- |
|**Mataró Bus (Lines 1–8)** (`src/mataroTracker.js`) | SIRR Real-Time Feed + `MATARO_LINE_SCHEDULES` fixed-interval loop (`depSec += headwaySec`). | **HIGH**: All 8 lines generate uniform 15, 18, 20, 25, or 30-min steps rather than exact CTSA/Avanza timetable departures. | Naive loop starting at tomorrow's `inicio` with uniform headway steps. |
|**Corridor C-10** (`src/corridorTracker.js`) | Authoritative GTFS matrices (`C10_TRIPS_DIR1`, `C10_TRIPS_DIR0`) + Mou-te GPS.| **NONE**: Exactly matches official Moventis/Casas timetable (76 trips across weekday/Sat/Sun/August). | Correctly uses `calendarEngine` to select tomorrow's exact first trip. |
|**Moventis Maresme (e11.1, e11.2, C-20, C-30, N80)** (`src/maresmeTracker.js`) | Moventis SAE Real-time API + `moventisClient.getParadasTimetable` official stop timetables. | **NONE**: Uses official Moventis timetable arrays (`stopEntry.hora`). | Official timetable departures queried from API. |
|**Sagalés (N82, N83, 603, 70, N71, N73)** (`src/sagalesTracker.js`) | GTFS-RT protobuf vehicle updates + `baseScheduleMap`departure arrays + `estimateStopTravelTimes`. | **LOW**: Uses exact departure arrays, but lacks full weekday/weekend matrix differentiation for daytime lines. | Synthesizes tomorrow morning departures from base schedule array. |
|**AMB Bus (TUSGSAL, Avanza Baix, Aerobús)** (`src/ambTracker.js`) | AMB Real-time GTFS + `for (let m = ...; m += headway)` naive fallback loop. | **MEDIUM**: Fallback uses synthetic 8/10/12/15 min steps when AMB RT times are unavailable. | Fallback headway steps for overnight. |
|**Catalonia Regional Bus** (`src/cataloniaTracker.js`) | Mou-te Real-time API + GTFS `getScheduledDeparturesForDate(route, dir, date)`. | **NONE**: Queries authoritative ATM GTFS index with full calendar exception resolution. | Scans up to 7 days ahead for official scheduled trips. |
|**Rodalies de Catalunya** (`src/rodaliesTracker.js`) | Renfe GTFS-RT feed + Rodalies timetable catalog + train tracker polyline. | **LOW**: Uses timetable catalog with `scheduleSynthesizer.estimateStopTravelTimes`. | Next morning train service with 🌝 1r Tren del matí. |

---

## 4. Architectural Enhancement Specification for `scheduleSynthesizer.js`

To fulfill **Requirement R3**, `src/core/schedule/scheduleSynthesizer.js` should natively support:

1. **First-Class `scheduledDepartures: string[]` Support**:
   If explicit stop departures are provided (e.g. `['06:30', '06:48', ...]`), they take immediate precedence over origin-calculated times (`baseDepartureTimes + stopTravelSec`).
2. **Calendar-Aware Matrix Selection**:
   Integration with `calendarEngine.getDateComponents(targetDate)` to select the active timetable array for the given day (`weekday`, `saturday`, `sunday`).
3. **Real-Time Overlap Elimination**:
   When a live vehicle (SIRI/GPS) has arrived or is imminent at time T_live, scheduled timetable trips within +-3 minutes are deduplicated to avoid showing duplicate phantom entries.
4. **Seamless Today -> Next-Morning Transition**:
   - If upcoming departures for today are < 5 (or today's service has ended), the engine appends tomorrow morning's trips from tomorrow's active day-type schedule.
   - The first trip of tomorrow is flagged with `isToday: false`, `isFirstOfDay: true`, `isNextService: true`, `delayBadgeText: '1r Servei del mati'`, and user-friendly comparison text `Pas teoric previst dema a les HH:MM`.
   - Subsequent tomorrow trips are flagged with `isToday: false`, `isFirstOfDay: false`, `delayBadgeText: 'Programat'`.

---

## 5. Survey of Existing Test Suites & Harness Capabilities

| Test Suite | File Path | Scope & Assertions | Status | Harness Capabilities | Failure Modes / Vulnerabilities |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Verification Test** | `test/verification_test.js` | TimeUtils formatting guards, Mataro SIRI arrival parser, Mataro Stop 1001 departures, Target ETA Stop 1001, Journalism Report coverage. | PASS (100%) | Direct module invocation. Fast (<1s). | Only checks Stop 1001 (Line 1). Does not assert non-synthetic schedule sequences across Lines 1-8. |
| **Core Transit Modules** | `test/core_transit_modules_test.js` | Unit & integration tests for `geoEngine`, `timeEngine`, `calendarEngine`, `scheduleSynthesizer`, `delayEngine`, `BaseTracker`, `TrackerRegistry`. | PASS (100%) | Full mock tracker execution, coordinate interpolation, timetable synthesis, canonical status verification. | Does not verify multi-line Mataro timetable matrices. |
| **M3 Smoke Test** | `test/m3_smoke_test.js` | E2E HTTP requests against Express server on port 3477. Tests vehicles, stop departures, target ETA, analytics, retards parity across 6 line families. | PASS (100%) | Spawns in-process HTTP server, tests real endpoints. | Can fail with `EADDRINUSE` if previous process didn't close port. Network timeouts if external APIs stall. |
| **Challenger Tracker & Schedule** | `test/challenger_tracker_schedule_test.js` | 48 adversarial stress tests: 500-stop sequences, 5,000 line resolutions, BaseTracker parallel direction resolution, GPS vs dead-reckoning deduplication. | PASS (100%) | Micro-benchmarking, memory and latency profiling, error injection. | None, suite is self-contained. |
| **Challenger Geo & Delay** | `test/challenger_geo_delay_test.js` | 136 adversarial assertions: 10,000-point polyline performance, circular midnight rollover, DST transitions, ancient date guards. | PASS (100%) | Pure algorithmic stress suite. Extremely fast (<150ms). | None. |
| **Adversarial Audit** | `test/adversarial_audit_test.js` | Antipodal coordinates, anti-meridian crossing, >24:00 overnight times, high-load fleet deduplication (100 vehicles). | PASS (100%) | Hostile property-based testing. | None. |
| **E2E Multi-Line Test** | `test/e2e_multiline_test.js` | 16 comprehensive E2E tests for C-10, Mataro L8, Sagales N82, Rodalies R1, TUSGSAL B25, Avanza L80, Monbus A1, Moventis N80. | PASS (100%) | Full Express server integration test on port 3456. | Ingestion daemon must be stopped in `finally` block. |
| **E2E Flight Recorder** | `test/e2e_flight_recorder_test.js` | Ingestion daemon, SQLite history DB delay logs, dead-reckoning extrapolator, CSV export. | PASS (100%) | Local SQLite DB and in-memory flight recorder. | None. |
| **Syntax Check** | `test/syntax_check.js` | Scans all JS files across codebase using `vm.Script` for AST parse validity. | PASS (100% - 41 files) | AST compilation check without execution. | Fast (<500ms). |

---

## 6. Test Requirements for Non-Synthetic Timetables (R4)

To prevent regressions and verify authoritative timetables across Mataro Bus Lines 1-8 and all operators, the following test requirements must be implemented in a dedicated test suite (e.g. `test/mataro_timetable_accuracy_test.js`) and integrated into `test/verification_test.js`:

### Requirement T1: Non-Synthetic Interval Assertion
- For each line L in {1, 2, 3, 4, 5, 6, 7, 8}, fetch the full daily schedule at its origin terminal and intermediate stops for:
  - Weekdays (Feiners)
  - Saturdays (Dissabtes)
  - Sundays/Holidays (Diumenges i Festius)
- Calculate the sequence of consecutive departure headways: delta_t_i = t_{i+1} - t_i.
- **Assertion**: stdDev(delta_t) > 0 or the set of headways matches official non-uniform time matrices (e.g. peak headway 12 min, off-peak headway 15 min, lunch transition 20 min). Uniform fixed-interval sequences (e.g. exactly 30.00 min across all trips) MUST FAIL.

### Requirement T2: Specific Timetable Matrix Assertions
- **Line 8 Weekday**: Starts at official time (e.g. `06:45`), terminates at official time (e.g. `21:45`).
- **Line 8 Saturday & Sunday**: Afternoon-only schedule. Departures must start strictly at official afternoon time (e.g. `14:04`, `14:35`, ...), with zero morning departures before 14:00.
- **Line 6 Sunday**: Afternoon-only schedule starting at official afternoon time (`14:00` / `14:17`).

### Requirement T3: Next-Morning Resumption Accuracy
- When simulating an off-peak query time at `23:30`:
  - Output must contain next morning's trips with `isToday: false`.
  - `departures[0].isFirstOfDay === true` and `departures[0].isNextService === true`.
  - `departures[0].departureTime` must equal the **true official first departure time** of tomorrow's day type (e.g. Line 1 weekday `06:30`, Line 8 Saturday `14:04`), not an arbitrary placeholder.

### Requirement T4: Schema Contract & Dual-Compatibility Invariants
- For every departure item:
  - `typeof d.delayMinutes === 'number'` && `typeof d.delayMins === 'number'` && `d.delayMinutes === d.delayMins`
  - `typeof d.isRealTime === 'boolean'` && `typeof d.isRealtime === 'boolean'` && `d.isRealTime === d.isRealtime`
  - `d.departureTime` matches `/^([01]\d|2[0-3]):[0-5]\d$/` (never `--:--` for scheduled trips)
  - `d.expectedIso` matches ISO 8601 regex and year >= 2026 (never starts with `0001-` or `1970-`)
  - `typeof d.formattedStatus === 'string'` and is non-empty.

### Requirement T5: 100% Automated Test Pass
- `node test/verification_test.js` -> Exit code 0
- `node test/core_transit_modules_test.js` -> Exit code 0
- `node test/m3_smoke_test.js` -> Exit code 0
- `node test/syntax_check.js` -> Exit code 0