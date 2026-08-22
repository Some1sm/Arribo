## 2026-08-21T22:05:00Z
You are Worker M3: API Centralization & Server Route Harmonization Specialist.
Your working directory is: h:/Coding/C10Data/.agents/teamwork_preview_worker_m3_1/
You MUST read:
- h:/Coding/C10Data/ORIGINAL_REQUEST.md
- h:/Coding/C10Data/PROJECT.md
- h:/Coding/C10Data/.agents/teamwork_preview_explorer_survey_2/handoff.md
- h:/Coding/C10Data/.agents/teamwork_preview_worker_m2_1/handoff.md

DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Tasks:
1. Update `server.js` to ensure all API endpoints conform to canonical JSON schemas and centralized routing via `TrackerRegistry`:
   - Live vehicles: Add `/api/line/:lineId/vehicles` and `/api/vehicles` returning canonical vehicle payloads with dual-cased compatibility properties (`delayMinutes` + `delayMins`, `isRealTime` + `isRealtime`). Maintain existing `/api/line/:lineId/live` and `/api/fleet/live`.
   - Stop departures: `/api/line/:lineId/stop/:stopId/departures` returning standardized envelope with `{ stopId, stopName, stop: { id, code, name, lat, lon, zone }, departures, totalDepartures, calendarInfo, lastUpdated }`.
   - Target ETA: `/api/line/:lineId/target-eta` returning standardized `{ targetStop, direction, directionName, nextBus, upcomingDepartures, allDepartures, calendarInfo, serviceStatus, lastUpdated }` with flat coordinates and `coords: { lat, lon }`.
   - Route catalog & Line details: `/api/lines`, `/api/line/:lineId`, `/api/search/stops`.
   - Delay analytics aliases: Add `/api/retards/journalism`, `/api/retards/export/csv`, `/api/retards/ranking` (mirroring `/api/analytics/*`).
2. Verify that `TrackerRegistry` and all trackers are cleanly integrated in `server.js`.
3. Preserve all frontend performance safeguards (Canvas renderer, Page Visibility deep sleep, 8-entry LRU route cache, glider hysteresis, Web Audio chimes) with zero breaking changes.
4. Execute and verify 100% pass with 0 errors across:
   - `node test/verification_test.js`
   - `node test/api_test.js`
   - `node test/e2e_multiline_test.js`
   - `node test/e2e_flight_recorder_test.js`
   - `node test/core_transit_modules_test.js`
   - `node test/challenger_geo_delay_test.js`
   - `node test/challenger_tracker_schedule_test.js`
   - `node test/syntax_check.js`

Record progress in `progress.md` and write your complete handoff report to `handoff.md` in your working directory. Use send_message to report when done.
