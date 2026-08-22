## 2026-08-21T21:38:56Z
You are Explorer M1-1 for Milestone 1: Geo, Time & Calendar Core Modules.
Your working directory is: h:/Coding/C10Data/.agents/teamwork_preview_explorer_m1_1/
You MUST first read the authoritative user request at: h:/Coding/C10Data/ORIGINAL_REQUEST.md and the project scope at: h:/Coding/C10Data/PROJECT.md.

Task:
1. Examine existing geo and time utilities in `src/geoUtils.js`, `src/timeUtils.js`, and existing trackers (`src/mataroTracker.js`, `src/sagalesTracker.js`, `src/corridorTracker.js`, `src/cataloniaTracker.js`).
2. Design the exact implementation specifications for:
   - `src/core/geo/geoEngine.js`: Haversine `calculateDistanceMeters`, bearing `calculateBearing`, compass conversion `getCompassDirection`, `snapPointToPolyline` (with vector projection), along-polyline distance accumulation `calculatePolylineDistanceBetween`, `calculateRouteTotalDistance`, `extrapolatePolylinePosition`, and Google polyline decoder `decodePolyline`.
   - `src/core/time/timeEngine.js`: `Europe/Madrid` timezone handling, `formatTimeToTimezone` (with strict null/invalid/epoch/0001 protection returning '--:--'), `timeStringToMinutes`, `minutesToTimeString`, `secondsToTimeString`, `getNetworkTime`, `localTimeToUtcDate`.
   - `src/core/time/calendarEngine.js`: `getDateComponents` (returning `{ dateStr, year, month, day, dayOfWeek, hour, minute, second, isWeekend, isSunday, isSaturday, isWeekday, isAugust }`), GTFS calendar & `calendar_dates` exception validation (`isServiceActiveOnDate`).
   - Backward compatibility bridge in `src/geoUtils.js` and `src/timeUtils.js` re-exporting the new core functions.
3. Recommend clear implementation code structures, exports, and test cases.
4. Record progress in `progress.md` and write your complete design and findings to `handoff.md` in your working directory.
5. Use send_message to report when done.
