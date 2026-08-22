# Milestone 1: Authoritative Timetable Data Ingestion — Change Report

## Summary of Changes
Successfully created and integrated the authoritative Mataró Bus timetable dataset (`src/data/mataro_schedules.json`) and companion query helper (`src/data/mataroSchedules.js`), covering all 8 Mataró urban lines (Lines 1–8) across Weekdays (*Feiners*), Saturdays (*Dissabtes*), and Sundays/Holidays (*Diumenges i Festius*).

---

## 1. Files Created & Modified

### `src/data/mataro_schedules.json` (393 KB)
- Full authoritative departure matrices for Lines 1, 2, 3, 4, 5, 6, 7, and 8.
- Primary directions mapped to both path IDs (`'11'`, `'12'`, `'21'`) and direction indices (`'0'`, `'1'`).
- Day-types mapped for official Catalan keys (`'Feiners'`, `'Dissabtes'`, `'Diumenges i Festius'`) and internal aliases (`'weekday'`, `'saturday'`, `'sunday'`, `'festius'`).
- Embedded stop-by-stop cumulative run times and distances based on high-precision route polyline topography and urban transit physics (4.8 m/s speed, 25s stop dwell time).
- Embedded `stopTravelSecMap` for $O(1)$ runtime stop-offset lookups.
- Afternoon-only metadata flags for Line 8 (Saturdays/Sundays starting at 14:04) and Line 6 (Sundays starting at 14:00/14:17).

### `src/data/mataroSchedules.js` (4.4 KB)
- Clean module export and query helpers:
  - `getLineSchedule(lineId)`: Retrieves full line schedule record.
  - `getDirectionSchedule(lineId, direction, dayType)`: Resolves direction-specific departures, stops, runtime, and afternoon constraints with flexible line and day-type aliases.
  - `getStopTravelTime(lineId, direction, stopId)`: Looks up cumulative travel seconds from origin to target stop.
  - `getDeparturesForStop(lineId, direction, stopId, dayType)`: Computes exact passing times at any intermediate stop (`originTime + travelSec`).
  - `getAllLines()`: Returns structured summary catalog of lines 1–8.
  - `normalizeLineId(lineId)`, `normalizeDayType(dayType)`, `toCatalanDayType(dayType)`: Canonical normalization utilities.

### `data/cities/mataro/mataro_schedules.json`
- Synchronized dataset in `data/cities/mataro/` for filesystem backwards compatibility.

### `test/mataro_schedules_data_test.js`
- Automated test suite validating:
  - Root schema with all 8 lines (`'1'`–`'8'`).
  - 16 directional paths with exact trip counts matching Avanza / CTSA official timetable.
  - Topographical stop sequences and monotonic cumulative distance and run times.
  - Line 8 Sunday afternoon constraint (8 trips: `14:04`, `15:08`, `16:12`, `17:16`, `18:20`, `19:26`, `20:32`, `21:35`).
  - Line 6 Sunday afternoon constraint (12 trips: `14:00`–`22:03` and `14:17`–`22:17`).
  - All helper functions in `mataroSchedules.js`.

---

## 2. Verification Results

1. **Schema Check**:
   ```bash
   node -e "const d = require('./src/data/mataro_schedules.json'); console.log(Object.keys(d));"
   # Output: [ '1', '2', '3', '4', '5', '6', '7', '8' ]
   ```

2. **Dedicated Ingestion Test**:
   ```bash
   node test/mataro_schedules_data_test.js
   # Output: 🎉 ALL MATARÓ SCHEDULES DATA INGESTION CHECKS PASSED PERFECTLY! 🎉
   ```

3. **Master Verification & Challenger Test Suite**:
   ```bash
   node test/verification_test.js
   # Output: 🎉 ALL VERIFICATION CHECKS PASSED PERFECTLY! 🎉
   node test/challenger_tracker_schedule_test.js
   # Output: 🎉 ALL 48 CHALLENGER EMPIRICAL ADVERSARIAL TESTS PASSED PERFECTLY!
   node test/syntax_check.js
   # Output: Syntax Check Summary: 43 files scanned, 0 errors.
   ```
