# Milestone 3 Changes: Mataró Tracker & Operator Integration

## Summary of Changes

### 1. `src/mataroTracker.js`
- **Authoritative Dataset Ingestion**: Imported `src/data/mataroSchedules.js` to access exact official CTSA / Avanza departure matrices and cumulative stop travel times for lines 1–8 across Weekdays (`Feiners`), Saturdays (`Dissabtes`), and Sundays/Holidays (`Diumenges i Festius`).
- **Eliminated Naive Constant Headway Schedule**: Removed `MATARO_LINE_SCHEDULES` (which contained artificial 15, 18, 20, 25, and 30-minute intervals).
- **Updated `getScheduleForLine`**: Refactored to query `mataroSchedules.getDirectionSchedule(lIdStr, routeId, dayType)` returning exact `inicio`, `fin`, `departures`, and `afternoonOnly` flags.
- **Eliminated Synthetic Headway Loops**: Removed arithmetic headway progression (`depSec += headwaySec`) in `getStopDepartures()` and `getTargetStopETA()`.
- **Integrated `scheduleSynthesizer.compileStopDepartures()`**:
  - Compiles stop passing departures by combining exact base departure arrays (`baseDeparturesToday`, `baseDeparturesTomorrow`), accurate stop travel seconds (`mataroSchedules.getStopTravelTime()` with topography fallback), and live telemetry from SIRI/dead-reckoning.
  - Implements circular $\pm 3$ min duplicate suppression for live buses approaching.
  - Generates authentic next-morning resumption with `🌅 1r Servei del matí` badge when today's service is winding down.
- **Updated `getTargetStopETA()`**:
  - Resolves next authentic bus passing departure from exact timetable schedule.
  - Computes `firstServiceTomorrow` from authoritative opening departures with stop travel time offset.
  - Correctly reflects weekend afternoon-only constraints (e.g. Line 8 weekend starting at 14:04 / 14:45, Line 6 Sunday starting at 14:00 / 14:17).

### 2. Audited Operator Trackers
- **`src/maresmeTracker.js`**: Verified that departures are generated from Moventis official SAE real-time API and official timetable matrices (`moventisClient.getParadasTimetable` & GTFS `stop_times`), with no generic synthetic interval loops.
- **`src/sagalesTracker.js`**: Verified that departures use official GTFS-RT live entities combined with exact base scheduled departure matrices (`baseScheduleMap`) and `scheduleSynthesizer.estimateStopTravelTimes()`.
- **`src/ambTracker.js`**: Verified that real-time AMB GTFS-RT feed and stop travel calculations are used for AMB lines.
- **`src/cataloniaTracker.js`**: Verified that real-time Mou-te API and official GTFS scheduled trips (`getScheduledDeparturesForDate()`) are used.

## Verification Results
- `node test/core_transit_modules_test.js`: Passed 100% (5 test suites)
- `node test/verification_test.js`: Passed 100% (5 verification checks)
- `node test/m3_smoke_test.js`: Passed 100% (all endpoint envelopes & parity checks)
- `node test/challenger_tracker_schedule_test.js`: Passed 100% (48 adversarial tests)
- `node test/mataro_schedules_data_test.js`: Passed 100% (8 lines, 16 paths, exact trip counts)
- `node test/syntax_check.js`: Passed 100% (43 files scanned, 0 errors)
- `node test/adversarial_audit_test.js`: Passed 100%
- `node test/challenger_geo_delay_test.js`: Passed 100% (136 assertions)
