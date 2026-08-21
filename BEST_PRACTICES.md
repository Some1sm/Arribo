# Arribo! Architecture & Development Best Practices Guide

> **Official standard for developers and AI agents working on the BadAMBBusTracker / Arribo! platform.**

---

## 1. System Architecture Overview

Arribo! uses a layered transit telemetry architecture designed for multi-agency aggregation, real-time vehicle GPS tracking, synthetic dead-reckoning fallback, and high-performance frontend rendering.

```
[ Upstream Feeds & APIs ]
  │ • AMB REST (api.amb.cat)
  │ • Mataró SIRI SOAP (sirimataro.avanzagrupo.com)
  │ • Generalitat Mou-te REST & GTFS (moute.gencat.cat)
  │ • Moventis SAE REST (app.moventis.es)
  │ • Sagalés JSON API (sagales.com)
  │ • Rodalies GTFS Timetables
  ▼
[ Upstream Protocol Clients ] (`src/clients/` & `src/*Client.js`)
  │ Raw network I/O, SOAP/XML extraction, token/header authentication
  ▼
[ Shared Transit Core Engine ] (`src/core/`)
  ├── geo/geoEngine.js            (Snapping, bearing, distance, polyline decode)
  ├── time/timeEngine.js          (Europe/Madrid timezone, UTC conversion, ISO parsing)
  ├── time/calendarEngine.js      (Day-type detection, GTFS calendar & exceptions)
  ├── schedule/scheduleSynthesizer.js (Timetable generation, stop interpolation)
  ├── schedule/delayEngine.js     (Delay evaluation, badge text, countdowns)
  ├── BaseTracker.js              (Abstract class: both directions, deduplication)
  └── TrackerRegistry.js          (Polymorphic line resolver & operator dispatcher)
  ▼
[ Standardized Operator Trackers ] (`src/*Tracker.js`)
  │ • corridorTracker (C-10 Corridor)
  │ • mataroTracker   (Mataró Bus Urbà Lines 1-8)
  │ • maresmeTracker  (Moventis Maresme C lines & urban)
  │ • sagalesTracker  (Sagalés Vallès & Costa lines)
  │ • ambTracker      (AMB Metrobús & NitBus network)
  │ • rodaliesTracker (Rodalies de Catalunya train lines)
  │ • cataloniaTracker(All 1,600+ Generalitat interurban routes)
  ▼
[ Central Telemetry & Persistence ]
  │ • ingestionDaemon   (Periodic multi-agency telemetry fetcher)
  │ • historyDb         (SQLite persistent delay database)
  │ • reportCacheService(Pre-computed 24h, 48h, 7d journalism reports)
  │ • routeCacheService (LRU route geometry & topology cache)
  ▼
[ Unified Server API ] (`server.js`)
  │ • /api/lines, /api/line/:lineId
  │ • /api/line/:lineId/vehicles, /api/vehicles
  │ • /api/line/:lineId/target-eta
  │ • /api/line/:lineId/stop/:stopId/departures
  │ • /api/retards/*, /api/analytics/*
  ▼
[ High-Performance Frontend ] (`public/js/`, `public/css/`)
  │ • Leaflet HTML5 Canvas Renderer (`preferCanvas: true`)
  │ • Page Visibility API Deep Sleep (suspends 60fps loop on hidden tabs)
  │ • 8-entry LRU in-memory route cache
  │ • DOM Event Delegation (no per-card listener closures)
```

---

## 2. Shared Transit Core Rules

All trackers **MUST** use the modules in `src/core/` instead of re-implementing mathematical, geometric, calendar, or delay algorithms.

### 2.1 Geographic Operations (`src/core/geo/geoEngine.js`)
- **Distance**: Always use `calculateDistanceMeters(lat1, lon1, lat2, lon2)` (Haversine formula).
- **Snapping**: Always use `snapPointToPolyline(lat, lon, polyCoords)` to project live GPS coordinates onto the authoritative route line via dot-product segment projection.
- **Progress & Distance along line**: Use `calculatePolylineDistanceBetween(polyCoords, lat1, lon1, lat2, lon2)`.

### 2.2 Time and Calendar Operations (`src/core/time/`)
- **Timezone**: All local Catalan transit operates in `Europe/Madrid`. Never use local machine or UTC hours directly without conversion.
- **Day Types**: Use `getDateComponents(dateObj, 'Europe/Madrid')` to obtain `dayOfWeek` (0 = Sunday, 1 = Monday ... 6 = Saturday) and `dayType` (`'weekday'`, `'saturday'`, `'sunday'`).
- **Midnight Rollover**: Handle passing times between 00:00 and 04:00 (such as NitBus) using circular modulo 24 hours. Never treat `00:00` as epoch timestamp `1970-01-01`.
- **Formatting**: Always format display times through `formatTimeToTimezone(isoOrDate)` to guarantee defensive fallback (`--:--`) against corrupt dates.

### 2.3 Schedule & Delay Synthesis (`src/core/schedule/`)
- **Stop Travel Times**: Use `estimateStopTravelTimes(stops, polyCoords, avgSpeedKmh, dwellSecPerStop)` to calculate cumulative run times for each stop sequence.
- **Delay Badges**: Use `computeDelayStatus(delayMinutes, isRealTime)` to obtain standard delay badge text (`'En temps real'`, `'Horari teòric'`, `'+3 min retard'`, `'🌅 1r Servei'`).

---

## 3. Tracker Module Implementation Standard

Every tracker class in `src/` should extend `BaseTracker` (`src/core/BaseTracker.js`):

```javascript
const BaseTracker = require('./core/BaseTracker');
const geoEngine = require('./core/geo/geoEngine');
const timeEngine = require('./core/time/timeEngine');
const calendarEngine = require('./core/time/calendarEngine');
const scheduleSynthesizer = require('./core/schedule/scheduleSynthesizer');
const delayEngine = require('./core/schedule/delayEngine');

class MyAgencyTracker extends BaseTracker {
  constructor() {
    super('MyAgency', 'Europe/Madrid');
  }

  // 1. Fetch live telemetry from upstream API
  async fetchLiveVehicles(lineId) {
    // Return array of normalized vehicle objects
  }

  // 2. Fetch or compute departures for a stop
  async fetchStopArrivals(stopId, lineId, direction) {
    // Return array of normalized departure objects
  }

  // 3. Return canonical line metadata & stops
  async getRawLineData(lineId, direction) {
    // Return line definition, stops array, and coords polyline
  }
}
```

### Standard Data Schemas

#### Vehicle Object (`normalizeVehicle`)
```json
{
  "vehicleId": "4012",
  "lineId": "8",
  "lineName": "Rodalies - Galícia",
  "direction": "0",
  "destination": "Galícia - Rodalies",
  "lat": 41.53921,
  "lon": 2.44458,
  "latitude": 41.53921,
  "longitude": 2.44458,
  "bearing": 185,
  "speedKmh": 24,
  "delayMins": 2,
  "delayFormatted": "+2 min retard",
  "isEstimated": false,
  "isRealTime": true,
  "recordedAt": "2026-08-21T23:30:00.000Z",
  "timestamp": 1787347800000
}
```

#### Departure Object
```json
{
  "lineId": "8",
  "lineName": "Rodalies - Galícia",
  "destination": "Galícia - Rodalies",
  "departureTime": "14:45",
  "departureDate": "2026-08-22T12:45:00.000Z",
  "expectedIso": "2026-08-22T12:45:00.000Z",
  "aimedIso": "2026-08-22T12:45:00.000Z",
  "minutesAway": 15,
  "isRealTime": true,
  "isEstimated": false,
  "isToday": true,
  "isFirstOfDay": false,
  "delayStatus": "delayed",
  "delayBadgeText": "+2 min retard",
  "comparisonText": "📅 Horari teòric: 14:43",
  "formattedStatus": "15 min"
}
```

---

## 4. Frontend Performance & Memory Guidelines

When modifying `public/js/app.js` or `public/js/map.js`, preserve the following client optimizations:

1. **Page Visibility Deep Sleep**:
   - Keep the `visibilitychange` listener in `public/js/app.js`.
   - Never run `requestAnimationFrame` glider loops or countdown timers while `document.visibilityState === 'hidden'`.
2. **HTML5 Canvas Leaflet Renderer**:
   - Always instantiate maps with `preferCanvas: true`.
   - Keep tile buffer constraints: `keepBuffer: 2`, `updateWhenIdle: true`.
3. **DOM Event Delegation**:
   - Never attach `.addEventListener` inside loops generating lists or grid cards.
   - Use container event delegation with `e.target.closest('[data-line-id]')`.
4. **LRU In-Memory Route Cache**:
   - Maintain the 8-entry LRU route cache limit in `this.lineCache`.
5. **Full Timetable Scrolling**:
   - In `renderDeparturesInto()` and `inspectStop()`, show all departures with `.departures-list` scroll container (`max-height: 480px`). Do not slice to 8 items.

---

## 5. Precomputed Delay Reports & Data Safety

- Never allow clients to trigger on-demand heavy report recalculations (`/api/retards/recalculate`).
- Reports for **24h, 48h, and 7d** are generated automatically by `reportCacheService.js` every 30 minutes in the background.
- Keep maximum 2 historical report files per timeframe in `data/reports/`.

---

## 6. Testing & Quality Assurance

Always run the full test suite before committing changes:

```bash
# 1. Recursive syntax check across all 40+ JavaScript files
node test/syntax_check.js

# 2. Core modules unit & integration test
node test/core_transit_modules_test.js

# 3. Dedicated verification test across all trackers and SQLite DB
node test/verification_test.js

# 4. Hostile adversarial and edge-case stress test
node test/adversarial_audit_test.js
node test/challenger_geo_delay_test.js
node test/challenger_tracker_schedule_test.js
```

All tests must pass with **0 errors and 100% assertions satisfied**.
