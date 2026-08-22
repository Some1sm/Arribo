# Handoff Report — Schedule Synthesizer & Test Suite Survey

**Subagent**: Explorer (Schedule Synthesizer & Test Suite Explorer)  
**Working Directory**: `h:/Coding/C10Data/.agents/explorer_survey_synthesizer_tests/`  
**Handoff Type**: Hard Handoff (Task Complete)  
**Date**: 2026-08-22  

---

## 1. Observation

1. **Schedule Synthesis Codebase (`src/core/schedule/`)**:
   - `src/core/schedule/scheduleSynthesizer.js` (314 lines) defines 6 key functions:
     - `estimateStopTravelTimes(stops, options)` (lines 29–84): Computes segment distance via `geoEngine.calculateDistanceMeters`, adds cumulative dwell (`i * dwellSecPerStop`, default 25s), and calculates monotonic cumulative seconds.
     - `getTravelTimeToStop(stopTravelTimes, stopIdentifier)` (lines 93–102): Fast $O(N)$ lookup of cumulative travel time by `stopId`, `seq`, or `stopIndex`.
     - `synthesizeDeparturesFromBaseTimes(baseDepartureTimes, stopTravelSec, options)` (lines 112–172): Synthesizes passing departures from base origin departures, calculates minutes away against agency network time (`Europe/Madrid`), and emits standardized scheduled departures.
     - `synthesizeHeadwayDepartures(config)` (lines 180–194): Generates uniform fixed-interval departure steps from `startTime` to `endTime` by `headwayMinutes` (`for (let s = startSec; s <= endSec; s += headwaySec)`).
     - `generateMorningFirstService(baseDepartureTimes, stopTravelSec, options)` (lines 204–270): Synthesizes next-morning departures with `isToday: false`, `isFirstOfDay: true`, `isNextService: true`, and badge text `🌅 1r Servei del matí` / `🌅 1r Tren del matí`.
     - `interpolateStopArrivals(baseTripDepartureSec, stopTravelTimes, dateObj, options)` (lines 281–304): Generates stop-by-stop passing timetable for a single origin departure.
   - `src/core/schedule/delayEngine.js` (276 lines):
     - `computeDelayStatus` (lines 24–120): Enforces canonical delay statuses (`'on_time'`, `'delayed'`, `'early'`, `'scheduled'`, `'passed'`, `'estimated'`) and dual compatibility (`delayMinutes` and `delayMins`).
     - `findClosestScheduledTime` (lines 137–194): Circular midnight rollover matching with $\pm 1440$ min modulo wrap-around.
     - `standardizeDeparture` (lines 220–268): Guarantees 100% schema contract compliance across frontend consumers.

2. **Root Cause of Generic 30-Minute Steps in Operators**:
   - In `src/mataroTracker.js` (lines 12–53), `MATARO_LINE_SCHEDULES` hardcodes only `{ inicio, fin, headwayMins }` for lines 1–8 across weekday, saturday, and sunday.
   - In `src/mataroTracker.js` (lines 775 and 821), departures are generated using:
     ```javascript
     for (let depSec = startSecToday; depSec <= endSecToday; depSec += headwaySec)
     ```
     and
     ```javascript
     for (let depSec = startSecTomorrow; depSec <= endSecTomorrow && tripCount < 10; depSec += headwaySecTomorrow)
     ```
   - In `src/ambTracker.js` (line 748), departures fallback to:
     ```javascript
     for (let m = Math.ceil((currentMinOfDay + 5) / headway) * headway; m <= endMinOfDay; m += headway)
     ```

3. **Current Test Suite Execution Results**:
   - `node test/verification_test.js`: Passed 100% (5/5 checks, 0 errors).
   - `node test/core_transit_modules_test.js`: Passed 100% (5/5 modules, 0 errors).
   - `node test/m3_smoke_test.js`: Passed 100% (6 line families, API envelopes, analytics parity).
   - `node test/challenger_tracker_schedule_test.js`: Passed 100% (48/48 adversarial checks).
   - `node test/challenger_geo_delay_test.js`: Passed 100% (136/136 adversarial assertions).
   - `node test/adversarial_audit_test.js`: Passed 100% (4/4 hostile check sections).
   - `node test/e2e_multiline_test.js`: Passed 100% (16/16 endpoints).
   - `node test/e2e_flight_recorder_test.js`: Passed 100% (7/7 tests).
   - `node test/syntax_check.js`: Passed 100% (41 files scanned, 0 syntax errors).

---

## 2. Logic Chain

1. **Step 1 (Root Cause Confirmation)**:
   Observations in `src/mataroTracker.js:775` and `src/mataroTracker.js:821` directly confirm that Mataró Bus stop departures are synthesized using naive arithmetic addition of a constant `headwaySec` (e.g. 15, 20, 25, or 30 minutes) over a fixed interval `[startSec, endSec]`.
2. **Step 2 (Architectural Gap in Synthesizer)**:
   While `scheduleSynthesizer.js` already has `synthesizeDeparturesFromBaseTimes`, it lacks a unified, high-level helper to:
   - Ingest full calendar-differentiated timetable matrices (`weekday`, `saturday`, `sunday`, `summer`).
   - Merge live SIRI telemetry with timetable departures for the rest of the day while removing duplicate arrivals within $\pm 3$ minutes.
   - Automatically transition to next-morning resumption trips when today's remaining trips drop below a configurable threshold.
3. **Step 3 (Test Coverage Gap)**:
   The existing test suite (`test/verification_test.js`, `test/core_transit_modules_test.js`, etc.) verifies data shapes, absence of phantom `00:00` / epoch dates, and basic module functions, but lacks assertions checking that Mataró Bus lines return exact, non-uniform official timetables (e.g. asserting non-zero standard deviation in inter-departure intervals, checking Line 8 Saturday/Sunday afternoon-only start at 14:04).

---

## 3. Caveats

1. Real-time external APIs (e.g. AMB GTFS endpoint, Renfe RT) can experience network latency or timeouts in non-mocked E2E runs; the test harness should support offline/mocked fallback modes during regression testing.
2. The specific departure times for all 8 Mataró urban lines (Lines 1 to 8) are being mined by peer agent `spec_miner_mataro_timetables`; this survey defines the ingestion interfaces and verification assertions for when those matrices are delivered.

---

## 4. Conclusion

1. **Schedule Synthesizer Enhancement Plan (R3)**:
   - Enhance `src/core/schedule/scheduleSynthesizer.js` with a unified timetable compilation function (`compileStopDepartures`) that supports first-class `scheduledDepartures: string[]` arrays, live SIRI/GPS merging with duplicate suppression, and seamless overnight next-morning resumption.
2. **Mataró Tracker Upgrade (R1 & R2)**:
   - Replace `MATARO_LINE_SCHEDULES` and the naive headway loop in `src/mataroTracker.js` with exact weekday/Saturday/Sunday timetable departure matrices and stop travel time offsets.
3. **Dedicated Test Suite Definition (R4)**:
   - Implement `test/mataro_timetable_accuracy_test.js` (and wire into `test/verification_test.js`) to assert non-synthetic schedule intervals across Lines 1–8, boundary constraints (Line 8 weekend afternoon 14:04, Line 6 Sunday 14:00), and contract invariance.

---

## 5. Verification Method

To independently reproduce and verify this investigation:

1. **Run full automated test verification**:
   ```bash
   node test/verification_test.js
   node test/core_transit_modules_test.js
   node test/syntax_check.js
   node test/challenger_tracker_schedule_test.js
   node test/challenger_geo_delay_test.js
   node test/adversarial_audit_test.js
   ```
   *Expected outcome*: 100% PASS with 0 exit code across all tests.

2. **Inspect Schedule Engine Implementation**:
   - Inspect `src/core/schedule/scheduleSynthesizer.js` lines 112–194 and lines 204–270.
   - Inspect `src/mataroTracker.js` lines 12–53 and lines 755–855 to verify the location of synthetic headway loops.

3. **Inspect Comprehensive Survey Report**:
   - View `h:/Coding/C10Data/.agents/explorer_survey_synthesizer_tests/analysis.md`.
