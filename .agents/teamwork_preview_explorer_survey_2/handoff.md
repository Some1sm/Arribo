# Explorer 2 Handoff Report: APIs & Frontend Contracts Survey

## 1. Observation

### 1.1 Backend Endpoint Catalog (`server.js`)
From direct analysis of `server.js` (lines 1–881), the system exposes the following routes:

| Route | Method | Handler / Logic Source | Response Envelope |
|---|---|---|---|
| `/api/lines` | `GET` | `getAllTransitLines()` across all 7 provider trackers (lines 76–163) | `{ success: true, totalLines: number, lines: TransitLine[] }` |
| `/api/search/stops?q={query}` | `GET` | Universal search across line catalogs and `allStopsMap` across all agencies (lines 166–364) | `{ success: true, query: string, results: SearchResultItem[] }` |
| `/api/line/:lineId?direction={dir}&date={date}` | `GET` | `getTrackerForLine(lineId).tracker.getLineDetails(lineId, dir)` (lines 371–462) | `{ success: true, data: LineDetails }` |
| `/api/line/:lineId/target-eta?direction={dir}&stopId={id}&date={date}` | `GET` | `corridorTracker.getTargetStopETA(dir, stopId, date)` or `tracker.getTargetStopETA(lineId, stopId, direction)` (lines 465–483) | `{ success: true, data: TargetEtaResponse }` |
| `/api/line/:lineId/live` | `GET` | `corridorTracker.getCorridorLiveTracking(dir)` or `tracker.getLineDetails(lineId, dir)` (lines 486–502) | `{ success: true, data: LiveTrackingData }` |
| `/api/line/:lineId/stop/:stopId/departures?direction={dir}&date={date}` | `GET` | `corridorTracker.getStopDepartures(stopId, dir, date)` or `tracker.getStopDepartures(stopId, lineId, dir)` (lines 505–522) | `{ success: true, data: StopDeparturesResponse }` |
| `/api/c10/target-eta` | `GET` | Legacy alias for C-10 target ETA (lines 529–539) | `{ success: true, data: TargetEtaResponse }` |
| `/api/c10/stops` | `GET` | Legacy alias for C-10 stops (lines 542–555) | `{ success: true, direction: string, totalStops: number, stops: Stop[] }` |
| `/api/c10/stop/:stopId/departures` | `GET` | Legacy alias for C-10 departures (lines 558–568) | `{ success: true, data: StopDeparturesResponse }` |
| `/api/c10/live-corridor` | `GET` | Legacy alias for C-10 live corridor (lines 571–579) | `{ success: true, data: LiveTrackingData }` |
| `/api/mataro/lines` | `GET` | Legacy alias for Mataró lines (lines 582–585) | `{ success: true, lines: MataroLine[] }` |
| `/api/mataro/line/:lineId` | `GET` | Legacy alias for Mataró line details (lines 588–597) | `{ success: true, data: LineDetails }` |
| `/api/mataro/target-eta` | `GET` | Legacy alias for Mataró target ETA (lines 600–610) | `{ success: true, data: TargetEtaResponse }` |
| `/api/mataro/stop/:stopId/departures` | `GET` | Legacy alias for Mataró departures (lines 613–623) | `{ success: true, data: StopDeparturesResponse }` |
| `/api/diagnostics/test?lineId={id}` | `GET` | Tests upstream provider latency, status, active vehicles (lines 629–719) | `{ success: boolean, lineId, provider, host, auth, type, latencyMs, status: 'online'\|'slow'\|'offline', statusCode, activeVehicles, message, testedAt }` |
| `/api/disruptions?line={code}` | `GET` | AMB / Operator service alerts (lines 722–734) | `{ success: true, count: number, disruptions: DisruptionItem[] }` |
| `/api/fleet/live` | `GET` | `flightRecorder.getAllVehicles()` (lines 741–749) | `{ success: true, count: number, timestamp: number, vehicles: RecordedVehicle[] }` |
| `/api/vehicle/:vehicleId/trail` | `GET` | `flightRecorder.getVehicleTrail(vehicleId)` (lines 752–761) | `{ success: true, vehicleId, pointsCount, trail: TrailPoint[] }` |
| `/api/line/:lineId/stats` | `GET` | `flightRecorder.getLineStats(cleanCode, lineId)` (lines 764–774) | `{ success: true, lineId, lineCode, stats: DelayStats }` |
| `/api/analytics/journalism?hours={h}` | `GET` | `reportCacheService.getLatestReport(hours, ...)` (lines 777–788) | `{ success: true, report: JournalismReport }` |
| `/api/analytics/export/csv?hours={h}` | `GET` | `flightRecorder.exportCsv(hours)` (lines 791–797) | CSV attachment (`text/csv; charset=utf-8`) |
| `/api/routes/snapshots` | `GET` | Daily snapshot list & 3-day diff (lines 804–817) | `{ success: true, retentionDays: 3, totalSnapshots, snapshots, diff }` |
| `/api/routes/snapshots/:date` | `GET` | Daily snapshot by YYYY-MM-DD (lines 821–832) | `{ success: true, snapshot: Object }` |
| `/api/routes/diff` | `GET` | 3-day topology diff (lines 835–842) | `{ success: true, diff: Object }` |
| `/api/health` | `GET` | Health check (lines 844–852) | `{ status: 'ok', app: 'Arribo!', version: '3.0.0', description, timestamp }` |

### 1.2 Frontend Consumers & Property Dependencies

#### `public/js/app.js` Dependencies:
- **`fetchLines()`** (`app.js:283`): Fetches `/api/lines`. Consumes:
  - `l.id`, `l.code`, `l.name`, `l.color`, `l.agency`, `l.group`, `l.directions` (`[{ dirId, name }]`), `l.isTrain`, `l.operatorWebsite`.
- **`refreshAllData()`** (`app.js:701-702`): Fetches in parallel:
  - `GET /api/line/${lId}?direction=${dir}`:
    - `lData.code`, `lData.id`, `lData.name`, `lData.color`, `lData.secondaryColor`, `lData.agency`, `lData.operatorWebsite`, `lData.direction`, `lData.directionName`, `lData.directions`.
    - `lData.stops` (`[{ id, code, mouteStopId, name, lat, lon, seq, zone, color }]`).
    - `lData.secondaryStops`, `lData.coords` or `lData.polyline` (`[[lat, lon], ...]`), `lData.secondaryCoords`.
    - `lData.allDirections` (`[{ dirId, name, stops, coords }]`).
    - `lData.activeBuses` (`[{ tripId, vehicleId, lat, lon, bearing, speedKmh, fromStop, toStop, fromCoords, toCoords, totalProgress, delayFormatted, delayStatus, delayBadgeText, isTerminalLayover, isEstimated, direction }]`).
    - `lData.checkpoints` (`[{ id, gtfsStopId, name, zone, seq, nextBus }]`).
    - `lData.delayStats` (`{ latePct, avgDelayMins, totalSamples }`).
    - `lData.disruptions` (`[{ title, description, affectedLines, affectedCities, affectedStops }]`).
    - `lData.calendarInfo` (`{ serviceId, name, frequency, frequencyMinutes, isWeekend, calendarTag, dateFormatted }`).
    - `lData.serviceStatus` (`{ isOperating, firstServiceTomorrow, calendarTag, statusText }`).
  - `GET /api/line/${lId}/target-eta?direction=${dir}&stopId=${savedStopId}`:
    - `targetStop` (`{ id, code, mouteStopId, name, lat, lon, seq, zone, coords: { lat, lon } }`).
    - `nextBus` (`{ departureTime, expectedIso, aimedIso, minutesAway, formattedStatus, destination, isRealTime / isRealtime, isEstimated, isToday, isFirstOfDay, isNextService, delayStatus, delayBadgeText, delayMinutes / delayMins, vehicleId, busCoords: { lat, lon } }`).
    - `upcomingDepartures` (Array of departures identical to `nextBus` schema).
    - `calendarInfo`, `serviceStatus`.
- **`inspectStop()`** (`app.js:2192`): Fetches `/api/line/${this.activeLineId}/stop/${stopId}/departures?direction=${this.activeDirection}`:
  - Consumes `res.data.departures` (array of items with `expectedIso`, `aimedIso`, `departureTime`, `minutesAway`, `destination`, `isRealTime`/`isRealtime`, `isEstimated`, `isToday`, `isFirstOfDay`, `delayMins`/`delayMinutes`, `delayStatus`, `delayBadgeText`, `vehicleId`, `busCoords`).
  - Consumes `res.data.stop` (`{ id, name, code, lat, lon, zone }`).
- **`openJournalismModal()`** (`app.js:1018-1019`): Fetches `/api/analytics/journalism?hours=${hours}` and `/api/routes/snapshots`:
  - Consumes `report.summary` (`totalRecordedArrivals`, `monitoredLinesCount`, `networkPunctualityPct`, `networkAvgDelay`, `networkMaxDelay`).
  - Consumes `report.rankingMostDelayed` (`[{ lineCode, lineId, name, agency, color, avgDelay, maxDelay, latePercentage, sampleCount }]`).
  - Consumes `report.rankingWorstStops` (`[{ stopName, lineCode, agency, avgDelay, maxDelay, severeLatePct, arrivalCount }]`).
  - Consumes `report.agencyStats` (`[{ agency, linesCount, totalSamples, avgDelay, onTimePct }]`).
  - Consumes `report.meta.generatedAt`.
  - Consumes `report.snapshotInfo` (`snapshots: [{ date, sizeBytes, summary: { totalRoutes, totalStops } }]`, `diff: { status }`).
- **`openDisruptionsModal()`** (`app.js:948`): Fetches `/api/disruptions`:
  - Consumes `disruptions: [{ title, description, affectedLines, affectedCities, affectedStops }]`.
- **`testApiConnection()`** (`app.js:3040`): Fetches `/api/diagnostics/test?lineId=${this.activeLineId}`:
  - Consumes `testedAt`, `latencyMs`, `status`, `message`, `error`.
- **`focusBusOnMap()`** (`app.js:654`): Fetches `/api/vehicle/${vehicleId}/trail`:
  - Consumes `trail: [{ lat, lon, timestamp, speed, bearing }]`.

#### `public/js/map.js` Expectations:
- **`renderStops()`** (`map.js:266`): Expects `stops: [{ id, mouteStopId, code, name, lat, lon, seq, zone }]`, `customPolyline: [[lat, lon], ...]`, `secondaryStops`, `secondaryPolyline`.
- **`updateBusMarkers()`** (`map.js:590`): Expects `activeBuses: [{ tripId, vehicleId, lat, lon, bearing, compass: { code, label }, speedKmh, fromStop, toStop, fromCoords: { lat, lon }, toCoords: { lat, lon }, totalProgress, delayFormatted, isTerminalLayover, isEstimated, direction }]`.
- **`renderVehicleTrail()`** (`map.js:905`): Expects `trailPoints: [{ lat, lon }]`.

---

## 2. Logic Chain & Analysis

### 2.1 Operator Tracking Discrepancies Catalog

By analyzing all 7 tracker modules (`src/corridorTracker.js`, `src/mataroTracker.js`, `src/maresmeTracker.js`, `src/sagalesTracker.js`, `src/ambTracker.js`, `src/rodaliesTracker.js`, `src/cataloniaTracker.js`), we observed the following differences:

```
[Observation] corridorTracker returns nextBus with `isRealtime` (lowercase 't'), whereas mataroTracker, sagalesTracker, ambTracker, and rodaliesTracker return `isRealTime` (capital 'T'), and cataloniaTracker returns both or `isRealtime`.
--> Logic: Frontend checks both `dep.isRealTime` and `dep.isRealtime`. To eliminate subtle bugs, backend must unify both flags (or provide getter/setter aliases).

[Observation] corridorTracker returns `delayMinutes`, whereas mataroTracker, sagalesTracker, ambTracker, rodaliesTracker, and maresmeTracker return `delayMins` (or both).
--> Logic: Frontend checks `dep.delayMins !== undefined ? dep.delayMins : dep.delayMinutes`. Unification must guarantee both fields are populated.

[Observation] In `getTargetStopETA`, corridorTracker nests coordinates under `targetStop.coords.lat`/`lon` as well as flat `targetStop.lat`/`lon`, whereas other trackers only provide flat `targetStop.lat`/`lon`.
--> Logic: Frontend maps link expects `stop.lat` or `stop.coords.lat`. All trackers must populate BOTH `lat`, `lon` and `coords: { lat, lon }`.

[Observation] In `getStopDepartures`, corridorTracker returns `{ stopId, stopName, departures, calendarInfo, lastUpdated }`, whereas other trackers return `{ stop: { id, name, lat, lon, zone }, departures, totalDepartures }`.
--> Logic: Frontend `app.js:2195-2204` checks `res.data.departures` and `res.data.stop` (or `res.data.stopId`). Unifying to `{ stopId, stopName, stop: { id, name, lat, lon, zone }, departures, totalDepartures, calendarInfo, lastUpdated }` satisfies all legacy and modern consumers with 100% fidelity.

[Observation] User requirement R2 explicitly mandates `/api/line/:lineId/vehicles` and `/api/vehicles`, and Acceptance Criteria mentions `/api/retards/*`. Currently `server.js` defines `/api/line/:lineId/live` and `/api/fleet/live`, as well as `/api/analytics/journalism` and `/api/line/:lineId/stats`, but lacks the direct `/api/line/:lineId/vehicles`, `/api/vehicles`, and `/api/retards/*` routes.
--> Logic: Implementing explicit routes and aliases for `/api/line/:lineId/vehicles`, `/api/vehicles`, and `/api/retards/*` guarantees compliance with R2 and the test suite without altering existing endpoints.
```

### 2.2 Detailed Operator Discrepancy Matrix

| Feature / Field | C-10 (`corridorTracker`) | Mataró (`mataroTracker`) | Moventis (`maresmeTracker`) | Sagalés (`sagalesTracker`) | AMB (`ambTracker`) | Rodalies (`rodaliesTracker`) | Catalonia (`cataloniaTracker`) |
|---|---|---|---|---|---|---|---|
| **Realtime boolean in Departure** | `isRealtime` | `isRealTime` | `isRealTime` | `isRealTime` | `isRealTime` | `isRealTime` | `isRealtime` & `isRealTime` |
| **Delay number in Departure** | `delayMinutes` | `delayMins` | `delayMins` & `delayMinutes` | `delayMinutes` & `delayMin` | `delayMins` & `delayMinutes` | `delayMins` & `delayMinutes` | `delayMins` & `delayMinutes` |
| **Target Stop Coords Structure** | Flat + `coords: {lat, lon}` | Flat only | Flat only | Flat only | Flat only | Flat only | Flat only |
| **Target ETA Service Status** | Full `{ isOperating, period, firstServiceTomorrow, statusText }` | Full `{ isOperating, period, firstServiceTomorrow, statusText }` | In `getLineDetails` only | In `getLineDetails` only | In `getLineDetails` only | In `getLineDetails` only | In `getLineDetails` + custom `eta` |
| **Target ETA Calendar Tag** | Full `calendarInfo` | Computed `dayType` | Local `calendarTag` | GTFS Calendar | GTFS Calendar | Rodalies schedule | Fallback day detector |
| **`getStopDepartures` Envelope** | `{ stopId, stopName, departures, calendarInfo }` | `{ stop: { id, name, lat, lon }, departures, totalDepartures }` | `{ stop: { id, name, lat, lon }, departures, totalDepartures }` | `{ stop: { id, name, lat, lon }, departures, totalDepartures }` | `{ stop: { id, name, lat, lon }, departures, totalDepartures }` | `{ station: { id, name, lat, lon }, departures, totalDepartures }` | `{ stop: { id, name, lat, lon }, departures, totalDepartures }` |
| **Telemetry Bearing / Compass** | Yes (`bearing`, `compass: {code, label}`) | Yes (computed via line geometry) | Yes (computed via shape vertices) | Yes (from GPS entity) | Yes (from AMB GTFS-RT) | Yes (from train trajectory) | Yes (from shape vertices) |
| **Dead-Reckoning Hold Buffer** | 5-min terminal layover + schedule interpolation | 90-second client hold + speed estimation | 90-second client hold | Direct REST polling | Direct GTFS-RT matching | Fixed headway estimation | GTFS timetable interpolation |

---

## 3. Frontend Data Contracts & Performance Safeguards

The survey identified 7 critical frontend features and optimizations that must be preserved with ZERO breaking changes:

1. **Inactive Tab Deep Sleep (Page Visibility API)** (`app.js:3181–3235`):
   - Automatically halts the 60fps `requestAnimationFrame` glider loop and pauses the 15-second `setInterval` polling whenever `document.hidden === true` or when the user is browsing the landing page view.
   - On tab regain (`visibilitychange`), immediately resumes animation and triggers an immediate background data refresh.
   - **Constraint**: Server must handle bursts of resumed polls gracefully without rate-limit lockout.

2. **HTML5 Canvas Polyline & Vector Renderer** (`map.js:31`, `map.js:975–988`):
   - Leaflet map initialized with `preferCanvas: true`. Polylines, multi-direction arrows, and vectors render to an HTML5 `<canvas>` layer rather than generating thousands of SVG DOM nodes.
   - Saves ~40MB DOM/GPU RAM and prevents mobile browser tab crashes.

3. **LRU Bounded In-Memory Route Cache** (`app.js:48–57`):
   - `this.lineCache` Map is strictly capped to 8 entries. When switching lines, older topology payloads are evicted.
   - **Constraint**: `GET /api/line/:lineId` response must be cacheable and self-contained (all stops, directions, shapes).

4. **Event Delegation on Large Catalogs** (`app.js:412–432`, `app.js:2440–2451`):
   - Landing view and line picker modal attach single delegated click listeners to `#landing-lines-container` and `#line-picker-container`, preventing thousands of closure allocations for 288+ transit routes.

5. **Smooth Continuous Vehicle Glider with Anti-Flicker Hysteresis** (`map.js:838–903`):
   - Position LERP: `smoothLat = currentPos.lat + dLat * 0.08` (smooth forward motion without rollback).
   - Rotation interpolation: shortest angular distance with `0.12` easing factor.
   - Facing hysteresis: deadband zone between 160°–200° and 340°–20° prevents flip-flopping of the bus icon emoji when negotiating gentle curves.

6. **Precomputed 30-Minute Journalism & Delay Analytics Cache** (`reportCacheService.js`, `app.js:1016–1140`):
   - Delay reports across all 288+ lines and 7,500+ stops are compiled in the background every 30 minutes.
   - `/api/analytics/journalism` serves precomputed snapshots in sub-millisecond time.

7. **Sound Alert & Arrival Chime** (`app.js:3298–3329`):
   - Uses Web Audio API oscillator (`AudioContext`) to synthesize a two-tone chime (587.33 Hz → 880 Hz) when a tracked bus approaches within 180 seconds (3 minutes) of the user's target stop.

---

## 4. Conclusion & Recommended Unified JSON Schemas

To ensure 100% backward and forward compatibility, all tracker modules and server endpoints should standardize on the following canonical data contracts:

### 4.1 Unified Live Vehicles Schema (`/api/line/:lineId/vehicles` and `/api/vehicles`)
```json
{
  "success": true,
  "lineId": "c10",
  "lineCode": "C-10",
  "count": 2,
  "timestamp": 1724280000000,
  "vehicles": [
    {
      "tripId": "GEN_0498_101",
      "vehicleId": "342",
      "lineId": "c10",
      "lineCode": "C-10",
      "lat": 41.5382,
      "lon": 2.4412,
      "bearing": 45,
      "compass": { "code": "NE", "label": "Nord-est" },
      "speedKmh": 34,
      "direction": "1",
      "headsign": "Hospital de Mataró",
      "fromStop": "Premià de Mar - Estació",
      "toStop": "Vilassar de Mar - Estació",
      "fromSeq": 21,
      "toSeq": 26,
      "fromCoords": { "lat": 41.4912, "lon": 2.3614 },
      "toCoords": { "lat": 41.5035, "lon": 2.3921 },
      "totalProgress": 62,
      "secondsToNextStop": 140,
      "delayMinutes": 2,
      "delayMins": 2,
      "delayFormatted": "+2 min retard",
      "delayStatus": "delayed",
      "delayBadgeText": "+2 min retard",
      "isTerminalLayover": false,
      "isEstimated": false,
      "isRealTime": true,
      "isRealtime": true,
      "statusText": "🟢 Senyal GPS Actiu",
      "lastUpdated": "2026-08-21T21:30:00.000Z"
    }
  ]
}
```

### 4.2 Unified Stop Departures Schema (`/api/line/:lineId/stop/:stopId/departures`)
```json
{
  "success": true,
  "stopId": "10037202",
  "stopName": "pl. Itàlia (A)",
  "stop": {
    "id": "10037202",
    "code": "121",
    "mouteStopId": "10037202",
    "gtfsStopId": "GEN_PF08121075",
    "name": "pl. Itàlia (A)",
    "lat": 41.5468674,
    "lon": 2.4321194,
    "zone": "Zona Maresme",
    "seq": 39
  },
  "totalDepartures": 8,
  "departures": [
    {
      "lineId": "c10",
      "lineCode": "C-10",
      "lineName": "C-10",
      "destination": "Hospital de Mataró",
      "directionId": "1",
      "departureTime": "21:45",
      "expectedIso": "2026-08-21T19:45:00.000Z",
      "aimedIso": "2026-08-21T19:43:00.000Z",
      "minutesAway": 7,
      "formattedStatus": "7 min",
      "isRealTime": true,
      "isRealtime": true,
      "isEstimated": false,
      "isToday": true,
      "isFirstOfDay": false,
      "isNextService": false,
      "delayMinutes": 2,
      "delayMins": 2,
      "delayStatus": "delayed",
      "delayBadgeText": "+2 min retard",
      "comparisonText": "Oficial: 21:43 (+2 min retard)",
      "vehicleId": "342",
      "busCoords": { "lat": 41.5382, "lon": 2.4412 }
    }
  ],
  "calendarInfo": {
    "serviceId": "GEN_184910",
    "name": "Feiners de dilluns a divendres",
    "frequency": "Cada 45 minuts",
    "frequencyMinutes": 45,
    "isWeekend": false,
    "calendarTag": "Feiners habituals (cada 45 min)",
    "dateFormatted": "21/08/2026"
  },
  "lastUpdated": "2026-08-21T21:30:00.000Z"
}
```

### 4.3 Unified Target Stop ETA Schema (`/api/line/:lineId/target-eta`)
```json
{
  "success": true,
  "data": {
    "line": {
      "id": "c10",
      "code": "C-10",
      "name": "Barcelona ⇄ Mataró (per N-II)",
      "color": "#009485"
    },
    "targetStop": {
      "id": "10037202",
      "stopId": "10037202",
      "code": "121",
      "mouteStopId": "10037202",
      "gtfsStopId": "GEN_PF08121075",
      "name": "pl. Itàlia (A)",
      "stopName": "pl. Itàlia (A)",
      "lat": 41.5468674,
      "lon": 2.4321194,
      "coords": { "lat": 41.5468674, "lon": 2.4321194 },
      "seq": 39,
      "zone": "Zona Maresme",
      "direction": "1",
      "directionName": "Cap a Mataró (Hospital / Pl. d'Itàlia)",
      "googleMapsUrl": "https://www.google.com/maps/search/?api=1&query=41.5468674,2.4321194"
    },
    "direction": "1",
    "directionName": "Cap a Mataró (Hospital / Pl. d'Itàlia)",
    "nextBus": {
      "lineId": "c10",
      "lineCode": "C-10",
      "lineName": "C-10",
      "destination": "Hospital de Mataró",
      "directionId": "1",
      "departureTime": "21:45",
      "expectedIso": "2026-08-21T19:45:00.000Z",
      "aimedIso": "2026-08-21T19:43:00.000Z",
      "minutesAway": 7,
      "formattedStatus": "7 min",
      "isRealTime": true,
      "isRealtime": true,
      "isEstimated": false,
      "isToday": true,
      "isFirstOfDay": false,
      "isNextService": false,
      "delayMinutes": 2,
      "delayMins": 2,
      "delayStatus": "delayed",
      "delayBadgeText": "+2 min retard",
      "comparisonText": "Oficial: 21:43 (+2 min retard)",
      "vehicleId": "342",
      "busCoords": { "lat": 41.5382, "lon": 2.4412 }
    },
    "upcomingDepartures": [ /* array of departure objects */ ],
    "allDepartures": [ /* full daily schedule */ ],
    "calendarInfo": {
      "serviceId": "GEN_184910",
      "name": "Feiners de dilluns a divendres",
      "frequency": "Cada 45 minuts",
      "frequencyMinutes": 45,
      "isWeekend": false,
      "calendarTag": "Feiners habituals (cada 45 min)",
      "dateFormatted": "21/08/2026"
    },
    "serviceStatus": {
      "isOperating": true,
      "period": "day",
      "firstServiceTomorrow": "06:45",
      "calendarTag": "Feiners habituals (cada 45 min)",
      "statusText": "Servei en funcionament • Feiners habituals (cada 45 min)"
    },
    "lastUpdated": "2026-08-21T21:30:00.000Z"
  }
}
```

### 4.4 Unified Delays & Analytics Schema (`/api/retards/*` and `/api/analytics/*`)
```json
{
  "success": true,
  "report": {
    "summary": {
      "totalRecordedArrivals": 14205,
      "monitoredLinesCount": 288,
      "networkPunctualityPct": 88,
      "networkAvgDelay": 1.8,
      "networkMaxDelay": 19
    },
    "rankingMostDelayed": [
      {
        "lineCode": "C-10",
        "lineId": "c10",
        "name": "Barcelona ⇄ Mataró",
        "agency": "Moventis / Casas",
        "color": "#009485",
        "avgDelay": 3.4,
        "maxDelay": 14,
        "latePercentage": 22,
        "sampleCount": 840
      }
    ],
    "rankingWorstStops": [
      {
        "stopName": "Badalona - Pompeu Fabra",
        "lineCode": "C-10",
        "agency": "Moventis / Casas",
        "avgDelay": 4.1,
        "maxDelay": 14,
        "severeLatePct": 28,
        "arrivalCount": 310
      }
    ],
    "agencyStats": [
      {
        "agency": "Moventis / Casas",
        "linesCount": 18,
        "totalSamples": 4210,
        "avgDelay": 2.1,
        "onTimePct": 86
      }
    ],
    "meta": {
      "timeframeHours": 24,
      "generatedAt": "2026-08-21T21:30:00.000Z",
      "engineVersion": "3.0.0"
    }
  }
}
```

---

## 5. Verification Method

To independently verify the contracts, API routes, and frontend stability:

1. **Automated Verification Suite**:
   ```bash
   node test/verification_test.js
   node test/e2e_multiline_test.js
   node test/api_test.js
   ```

2. **Endpoint Schema Validation Checklist**:
   - Query `GET /api/lines` → verify `lines` contains 288+ lines with `id`, `code`, `name`, `color`, `agency`, `directions`.
   - Query `GET /api/line/c10?direction=1` → verify `coords`, `stops`, `activeBuses`, `checkpoints`, `delayStats`.
   - Query `GET /api/line/c10/target-eta?direction=1` → verify `targetStop` has `lat`, `lon`, and `coords: {lat, lon}`, `nextBus` has `minutesAway`, `expectedIso`, `departureTime`, `isRealTime` / `isRealtime`.
   - Query `GET /api/line/8/target-eta?direction=0` → verify Mataró Line 8 target stop ETA returns valid non-phantom timestamps.
   - Query `GET /api/mataro/stop/1001/departures` → verify departures contains zero `00:00` phantom times for imminent arrivals.
   - Query `GET /api/analytics/journalism?hours=24` and `/api/retards/journalism` → verify JSON structure contains `summary`, `rankingMostDelayed`, `rankingWorstStops`, `agencyStats`.
   - Query `GET /api/line/c10/vehicles` and `/api/vehicles` → verify live vehicle telemetry matches unified schema.

3. **Frontend Zero-Error Visual Check**:
   - Inspect `public/js/app.js` and `public/js/map.js` in browser devtools / syntax checker: zero syntax errors, zero console exceptions.

---
**Survey Complete**: All backend API endpoints and frontend consumer contracts have been mapped, discrepancies analyzed, and unified JSON schemas defined for the implementation team.
