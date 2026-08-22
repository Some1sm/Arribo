## 2026-08-21T23:41:28+02:00
You are Worker M1: Core Transit Modules Implementer.
Your working directory is: h:/Coding/C10Data/.agents/teamwork_preview_worker_m1_1/
You MUST first read the authoritative user request at: h:/Coding/C10Data/ORIGINAL_REQUEST.md and the project scope at: h:/Coding/C10Data/PROJECT.md.

Read the detailed blueprints from the M1 Explorers:
- h:/Coding/C10Data/.agents/teamwork_preview_explorer_m1_1/handoff.md
- h:/Coding/C10Data/.agents/teamwork_preview_explorer_m1_2/handoff.md
- h:/Coding/C10Data/.agents/teamwork_preview_explorer_m1_3/handoff.md

DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Your Tasks:
1. Create the `src/core/` module hierarchy:
   - `src/core/geo/geoEngine.js`: Complete Haversine, bearing, compass, vector dot-product point-to-segment snapping (`snapPointToPolyline`), polyline distance accumulation, `calculateRouteTotalDistance`, dead-reckoning extrapolation (`extrapolatePolylinePosition`), and Google polyline decoder (`decodePolyline`).
   - `src/core/time/timeEngine.js`: Timezone math (`Europe/Madrid`), time string / minute / second conversions, `getNetworkTime`, `localTimeToUtcDate`, and defensive `formatTimeToTimezone` (returning '--:--' for invalid dates, null, 1970 epoch, or 0001 dates).
   - `src/core/time/calendarEngine.js`: `getDateComponents` (returning dateStr, year, month, day, dayOfWeek, hour, minute, isWeekend, isSunday, isSaturday, isWeekday, isAugust), `isServiceActiveOnDate` with GTFS calendar & calendar_dates exception handling and legacy C-10 support, `getServiceCalendarInfo`.
   - `src/core/schedule/scheduleSynthesizer.js`: `estimateStopTravelTimes` with configurable speeds & dwell times, `synthesizeDeparturesFromBaseTimes`, `synthesizeHeadwayDepartures`, `generateMorningFirstService` (with `isTrain` distinction), `interpolateStopArrivals`.
   - `src/core/schedule/delayEngine.js`: `computeDelayStatus` with canonical statuses (`on_time`, `delayed`, `early`, `scheduled`, `passed`, `estimated`), badges, comparison strings, `findClosestScheduledTime` with circular midnight wrap-around handling, `standardizeDeparture` guaranteeing dual-compatibility fields (`delayMinutes` + `delayMins`, `isRealTime` + `isRealtime`).
   - `src/core/BaseTracker.js`: Base abstract tracker with template methods, automatic `direction === 'both'` parallel resolution (`handleBothDirections`), GPS-over-estimate bus deduplication (`deduplicateBuses`), checkpoint building, and service status builder.
   - `src/core/TrackerRegistry.js`: Polymorphic registry for all 7 transit operators (AMB, Mataró, Moventis/Maresme, Sagalés, Rodalies, Catalonia Mou-te, C-10), line resolution, catalog aggregation, and search.
2. Update `src/geoUtils.js` and `src/timeUtils.js` to re-export the core utilities so that all 12+ existing callers continue functioning without breaking.
3. Verify your implementation by running:
   - `node test/verification_test.js`
   - `node test/api_test.js`
   - Syntax validation across all JS files.
4. Record progress in `progress.md` and write a detailed handoff report to `handoff.md` in your working directory documenting changes made, files created/modified, and test verification output.
5. Use send_message to report completion.
