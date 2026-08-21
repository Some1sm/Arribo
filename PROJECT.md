# Project: Bus Tracker Deduplication, Standardization & Best Practices

## Architecture
The system transitions from siloed, duplicative tracker modules to a layered, modular transit architecture with a shared transit core:

```
[Upstream Transit APIs & Feeds]
  │ (AMB REST, Mataró SIRI SOAP, Mou-te REST/GTFS, Moventis SAE, Sagalés JSON, Rodalies GTFS)
  ▼
[Upstream Clients: src/clients/]
  │ (ambClient, mataroSiriClient, mouteClient, moventisClient, sagalesClient)
  ▼
[Shared Transit Core: src/core/]
  ├── geo/geoEngine.js            (snapping, bearing, haversine, polyline distance, polyline decode)
  ├── time/timeEngine.js          (Europe/Madrid timezone conversion, network time, seconds/ISO utils)
  ├── time/calendarEngine.js      (day-type detection, GTFS calendar & calendar_dates service validation)
  ├── schedule/scheduleSynthesizer.js (timetable generation, stop sequence interpolation, travel times)
  ├── schedule/delayEngine.js     (canonical delay status, badges, formatted comparison strings)
  ├── BaseTracker.js              (abstract tracker: both-directions merge, checkpoints, deduplication)
  └── TrackerRegistry.js          (polymorphic line resolution & operator dispatcher)
  ▼
[Standardized Trackers: src/]
  │ (corridorTracker, mataroTracker, maresmeTracker, sagalesTracker, ambTracker, rodaliesTracker, cataloniaTracker)
  ▼
[Background Services & Telemetry: src/]
  │ (ingestionDaemon, flightRecorder, historyDb, reportCacheService, routeCacheService)
  ▼
[Unified Server APIs: server.js]
  │ (/api/lines, /api/line/:lineId, /api/line/:lineId/vehicles, /api/vehicles, /api/line/:lineId/target-eta,
  │  /api/line/:lineId/stop/:stopId/departures, /api/retards/*, /api/analytics/*)
  ▼
[Frontend Web Client: public/]
  │ (Canvas polyline renderer, inactive tab deep-sleep, vehicle glider with hysteresis, 8-entry LRU cache)
```

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Geometric & Polyline Math Engine | Centralize Haversine, bearing, dot-product point-to-segment projection (`snapPointToPolyline`), cumulative polyline distances, and Google polyline decoding. | M1 | Survey / R1 |
| 2 | Time & Calendar Engine | Standardize `Europe/Madrid` timezone handling, day-type detection (weekday, saturday, sunday, holiday, august), and GTFS calendar/calendar_dates exception validation. | M1 | Survey / R1 |
| 3 | Schedule Interpolation & Delay Engine | Unify synthetic departure generation, stop-to-stop cumulative travel-time interpolation with dwell times, and standardized delay badge/status computation. | M1 | Survey / R1 |
| 4 | BaseTracker Abstract Class | Provide shared implementation for `direction === 'both'` aggregation, bus deduplication, stop checkpoint building, and service status synthesis. | M1 | Survey / R1 |
| 5 | Tracker Registry | Centralize line routing, provider detection, and uniform line dispatching across all 7 operators. | M1 | Survey / R1 |
| 6 | Refactor Corridor (C-10) Tracker | Refactor `src/corridorTracker.js` to consume `src/core/` and eliminate duplicate geometric, time, and schedule routines. | M2 | Survey / R1 |
| 7 | Refactor Mataró Urban Tracker | Refactor `src/mataroTracker.js` to consume `src/core/` and eliminate duplicate snapping, polyline math, and travel time estimation. | M2 | Survey / R1 |
| 8 | Refactor Moventis Maresme Tracker | Refactor `src/maresmeTracker.js` to consume `src/core/` and eliminate duplicate bus interpolation and departure synthesis. | M2 | Survey / R1 |
| 9 | Refactor Sagalés Tracker | Refactor `src/sagalesTracker.js` to consume `src/core/` and eliminate embedded polyline decoding and schedule duplication. | M2 | Survey / R1 |
| 10 | Refactor AMB & Rodalies Trackers | Refactor `src/ambTracker.js` and `src/rodaliesTracker.js` to consume `src/core/` for stop travel time and delay evaluation. | M2 | Survey / R1 |
| 11 | Refactor Catalonia Tracker | Refactor `src/cataloniaTracker.js` to consume `src/core/` for calendar filtering and date components. | M2 | Survey / R1 |
| 12 | Standardized Live Vehicles API | Add `/api/line/:lineId/vehicles` and `/api/vehicles` returning unified vehicle schema with dual-cased compatibility fields. | M3 | Survey / R2 |
| 13 | Standardized Stop Departures API | Ensure `/api/line/:lineId/stop/:stopId/departures` returns uniform schema with `stop` object, `departures` array, and dual-field delays. | M3 | Survey / R2 |
| 14 | Standardized Target ETA API | Ensure `/api/line/:lineId/target-eta` returns uniform schema with flat + nested coords, `nextBus`, `upcomingDepartures`, `calendarInfo`, `serviceStatus`. | M3 | Survey / R2 |
| 15 | Standardized Delays & Analytics API | Provide `/api/retards/*` routes mirroring `/api/analytics/*` with uniform journalism report schemas. | M3 | Survey / R2 |
| 16 | Frontend Performance & Compatibility | Preserve Canvas rendering, Page Visibility deep sleep, LRU cache, audio chimes, and smooth glider with zero breaking changes. | M3 | Survey / R3 |
| 17 | Comprehensive BEST_PRACTICES.md | Author production-grade developer guide with data models, tracker lifecycle, contribution rules, day-type rules, memory rules, and testing specs. | M4 | Survey / R4 |
| 18 | Multi-Tier Automated Verification | Expand `test/verification_test.js` to cover all 7 tracker families, all endpoints, 4 testing tiers, and recursive syntax validation across all 28+ JS files. | M5 | Survey / R3 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Shared Transit Core Modules | Implement `src/core/geo/geoEngine.js`, `src/core/time/timeEngine.js`, `src/core/time/calendarEngine.js`, `src/core/schedule/scheduleSynthesizer.js`, `src/core/schedule/delayEngine.js`, `src/core/BaseTracker.js`, `src/core/TrackerRegistry.js`. Maintain backward compatibility in `src/geoUtils.js` and `src/timeUtils.js`. | none | DONE |
| 2 | Tracker Consolidation & Refactoring | Refactor `src/corridorTracker.js`, `src/mataroTracker.js`, `src/maresmeTracker.js`, `src/sagalesTracker.js`, `src/ambTracker.js`, `src/rodaliesTracker.js`, `src/cataloniaTracker.js` to inherit/use `src/core/`. | M1 | DONE |
| 3 | API Centralization & Route Harmonization | Update `server.js` with canonical endpoints (`/api/line/:lineId/vehicles`, `/api/vehicles`, `/api/retards/*`), uniform JSON response formatting, and verified frontend compatibility. | M2 | IN_PROGRESS |
| 4 | Authoritative BEST_PRACTICES.md | Create production-grade `BEST_PRACTICES.md` at repository root with data structures, lifecycle rules, contribution guide, and testing requirements. | M1, M2, M3 | PLANNED |
| 5 | Comprehensive Verification & Test Pass | Expand `test/verification_test.js` to assert unified contracts across all 7 tracker families, run recursive syntax checks across all 28+ JS files, and verify 100% test pass. | M1, M2, M3, M4 | PLANNED |

## Interface Contracts

### `src/core/geo/geoEngine.js`
- `calculateDistanceMeters(lat1, lon1, lat2, lon2): number`
- `calculateBearing(lat1, lon1, lat2, lon2): number`
- `getCompassDirection(bearing): { code: string, label: string }`
- `snapPointToPolyline(lat, lon, polyCoords): { lat: number, lon: number, index: number, bearing: number, dist: number }`
- `calculatePolylineDistanceBetween(polyCoords, lat1, lon1, lat2, lon2): number`
- `calculateRouteTotalDistance(polyCoords): number`
- `extrapolatePolylinePosition(currentPos, elapsedSec, speedKmh, polyCoords): { lat: number, lon: number, bearing: number, progress: number }`
- `decodePolyline(encodedString): Array<{ lat: number, lon: number }>`

### `src/core/time/timeEngine.js` & `src/core/time/calendarEngine.js`
- `getDateComponents(dateObj, timezone?): { dateStr: string, year: number, month: number, day: number, dayOfWeek: number, hour: number, minute: number, second: number, isWeekend: boolean, isSunday: boolean, isSaturday: boolean, isWeekday: boolean, isAugust: boolean }`
- `formatTimeToTimezone(isoOrDate, timezone?): string` (HH:MM or '--:--')
- `timeStringToMinutes(timeStr): number`
- `minutesToTimeString(minutes): string`
- `isServiceActiveOnDate(calendar, calendarExceptions, dateStr, dayOfWeek): boolean`

### `src/core/schedule/scheduleSynthesizer.js` & `src/core/schedule/delayEngine.js`
- `estimateStopTravelTimes(stops, polyCoords, avgSpeedKmh, dwellSecPerStop): Array<{ stopId: string, cumulativeMeters: number, travelSec: number }>`
- `interpolateStopArrivals(baseTripDepartureSec, stopTravelTimes, dateObj): Array<Departure>`
- `computeDelayStatus(delayMinutes, isRealTime): { delayStatus: 'on_time' | 'delayed' | 'early' | 'scheduled', delayBadgeText: string, comparisonText: string, formattedStatus: string }`

### `src/core/BaseTracker.js`
- Abstract methods: `fetchLiveVehicles(lineId)`, `fetchStopArrivals(stopId, lineId, direction)`, `getRawLineData(lineId, direction)`
- Standard methods: `getLineDetails(lineId, direction)`, `handleBothDirections(lineId)`, `deduplicateBuses(buses)`, `buildCheckpoints(stops, activeBuses)`, `buildServiceStatus(calendarInfo, departures)`

## Code Layout
```
h:/Coding/C10Data/
├── BEST_PRACTICES.md          # Authoritative developer best practices guide
├── PROJECT.md                 # Project architecture, inventory, milestones & contracts
├── TEST_INFRA.md              # Opaque-box E2E test infra & four-tier coverage matrix
├── package.json               # Scripts & dependencies
├── server.js                  # Express API server & route handlers
├── src/
│   ├── core/
│   │   ├── BaseTracker.js
│   │   ├── TrackerRegistry.js
│   │   ├── geo/
│   │   │   └── geoEngine.js
│   │   ├── time/
│   │   │   ├── timeEngine.js
│   │   │   └── calendarEngine.js
│   │   └── schedule/
│   │       ├── scheduleSynthesizer.js
│   │       └── delayEngine.js
│   ├── clients/
│   │   ├── ambClient.js
│   │   ├── mataroSiriClient.js
│   │   ├── mouteClient.js
│   │   ├── moventisClient.js
│   │   └── sagalesClient.js
│   ├── ambTracker.js
│   ├── cataloniaIndexer.js
│   ├── cataloniaTracker.js
│   ├── corridorTracker.js
│   ├── flightRecorder.js
│   ├── geoUtils.js            # Backward compatibility re-export
│   ├── historyDb.js
│   ├── ingestionDaemon.js
│   ├── maresmeTracker.js
│   ├── mataroTracker.js
│   ├── reportCacheService.js
│   ├── rodaliesTracker.js
│   ├── routeCacheService.js
│   ├── sagalesTracker.js
│   └── timeUtils.js           # Backward compatibility re-export
├── public/
│   ├── index.html
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── app.js
│       └── map.js
└── test/
    ├── verification_test.js
    ├── e2e_multiline_test.js
    ├── e2e_flight_recorder_test.js
    ├── api_test.js
    └── benchmark_lanes.js
```
