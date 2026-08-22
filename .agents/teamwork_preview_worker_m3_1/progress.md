# Progress - Worker M3: API Centralization & Server Route Harmonization

Last visited: 2026-08-21T22:05:00Z

## Status
- [x] Initialized DISPATCH.md and BRIEFING.md
- [ ] Read required documents (ORIGINAL_REQUEST.md, PROJECT.md, survey handoff, M2 handoff)
- [ ] Inspect `server.js` and existing endpoints/controllers
- [ ] Inspect existing tests and run them to establish baseline
- [ ] Harmonize routes in `server.js`:
  - `/api/line/:lineId/vehicles` and `/api/vehicles` (canonical vehicle payloads, dual-cased compatibility properties)
  - `/api/line/:lineId/stop/:stopId/departures` (standardized envelope: `{ stopId, stopName, stop: { id, code, name, lat, lon, zone }, departures, totalDepartures, calendarInfo, lastUpdated }`)
  - `/api/line/:lineId/target-eta` (standardized `{ targetStop, direction, directionName, nextBus, upcomingDepartures, allDepartures, calendarInfo, serviceStatus, lastUpdated }` with flat coords and `coords: { lat, lon }`)
  - `/api/lines`, `/api/line/:lineId`, `/api/search/stops`
  - `/api/retards/journalism`, `/api/retards/export/csv`, `/api/retards/ranking` (mirroring `/api/analytics/*`)
- [ ] Verify clean integration of `TrackerRegistry` and all line trackers
- [ ] Verify frontend performance safeguards preserved
- [ ] Run all test suites and achieve 100% pass (0 errors)
- [ ] Write handoff.md and send message to parent
