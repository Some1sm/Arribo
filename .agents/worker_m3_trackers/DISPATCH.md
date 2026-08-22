## 2026-08-22T00:11:52Z
Worker subagent for Milestone 3 (Mataró Tracker & Operator Integration).
Working directory: h:/Coding/C10Data/.agents/worker_m3_trackers/
Project root: h:/Coding/C10Data

MANDATORY: Read the authoritative user request at h:/Coding/C10Data/.agents/ORIGINAL_REQUEST.md before starting.
Also read PROJECT.md at h:/Coding/C10Data/PROJECT.md, M1 handoff at h:/Coding/C10Data/.agents/worker_m1_data/handoff.md, and M2 handoff at h:/Coding/C10Data/.agents/worker_m2_synthesizer/handoff.md.

Scope & Exclusively Owned Files:
- Modify `src/mataroTracker.js`.
- Audit `src/maresmeTracker.js`, `src/sagalesTracker.js`, `src/ambTracker.js`, `src/cataloniaTracker.js`.

Requirements:
1. In `src/mataroTracker.js`:
   - Replace the naive `MATARO_LINE_SCHEDULES` (fixed 15/20/30-minute intervals) by importing and using the authoritative dataset from `src/data/mataroSchedules.js` / `src/data/mataro_schedules.json`.
   - Completely eliminate all synthetic arithmetic loops (`depSec += headwaySec` in `getStopDepartures()` and `getTargetStopETA()`).
   - In `getStopDepartures()`: Call `scheduleSynthesizer.compileStopDepartures()` with the exact authoritative timetable departures for today (based on day type: Feiners, Dissabtes, Diumenges i Festius), tomorrow's opening timetable departures, stop travel seconds (from `mataroSchedules.getStopTravelTime()` or `estimateStopTravelTimes`), and live SIRI arrivals.
   - In `getTargetStopETA()`: Return authentic next scheduled departure and next morning resumption from exact timetable departures (e.g. for Line 8 on weekends, early morning returns next service at 14:04).
2. Audit `src/maresmeTracker.js`, `src/sagalesTracker.js`, `src/ambTracker.js`, and `src/cataloniaTracker.js` to ensure theoretical schedules reflect exact official trips without unhandled synthetic fixed-interval arithmetic.
3. Verify by running:
   - `node test/core_transit_modules_test.js`
   - `node test/verification_test.js`
   - `node test/m3_smoke_test.js`
   - `node test/challenger_tracker_schedule_test.js`
   - `node test/mataro_schedules_data_test.js`
   - `node test/syntax_check.js`
