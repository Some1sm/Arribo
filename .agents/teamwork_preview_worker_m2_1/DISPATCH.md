## 2026-08-21T21:54:04Z

Consolidate and refactor all 7 tracker modules in src/ to use the shared core transit modules in src/core/ and eliminate duplicated logic:
1. src/corridorTracker.js (C-10):
   - Replace duplicate 	imeToSec, secToTime, 	imeToMin, getDateComponents, isServiceActiveOnDate, and segment interpolation math with calls to src/core/geo/geoEngine.js, src/core/time/timeEngine.js, src/core/time/calendarEngine.js, and src/core/schedule/delayEngine.js.
2. src/mataroTracker.js (Mataró Urban L1-L8):
   - Remove duplicate snapPointToPolyline, calculatePolylineDistanceBetween, calculateRouteTotalDistance, extrapolatePolylinePosition, and stop travel time accumulation. Use src/core/geo/geoEngine.js and src/core/schedule/scheduleSynthesizer.js.
3. src/maresmeTracker.js (Moventis Maresme):
   - Replace duplicate distance, bearing, and timetable synthesis logic with src/core/geo/geoEngine.js, src/core/schedule/scheduleSynthesizer.js, and src/core/schedule/delayEngine.js.
4. src/sagalesTracker.js (Sagalés):
   - Remove embedded 30-line decodePolyline implementation and manual travel time loops. Use src/core/geo/geoEngine.js and src/core/schedule/scheduleSynthesizer.js.
5. src/ambTracker.js (AMB Mobilitat) & src/rodaliesTracker.js (Rodalies Trains):
   - Replace manual cumulative stop travel time loops with src/core/schedule/scheduleSynthesizer.js (estimateStopTravelTimes) and delay badging with src/core/schedule/delayEngine.js.
6. src/cataloniaTracker.js (Catalonia Mou-te GTFS):
   - Replace duplicate getDateComponents and isServiceActiveOnDate with src/core/time/calendarEngine.js and geometric functions with src/core/geo/geoEngine.js.

Verification Requirements:
After refactoring, execute and verify 100% pass with 0 errors across:
- 
ode test/verification_test.js
- 
ode test/api_test.js
- 
ode test/core_transit_modules_test.js
- 
ode test/e2e_multiline_test.js
- 
ode test/e2e_flight_recorder_test.js
- 
ode test/challenger_geo_delay_test.js
- 
ode test/challenger_tracker_schedule_test.js
- 
ode test/syntax_check.js (Zero syntax errors across all backend & frontend files)
