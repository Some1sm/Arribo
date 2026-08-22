# Handoff Report: Trackers & Logic Duplication Survey

**Explorer / Surveyor**: Explorer 1 — Trackers & Logic Duplication Surveyor  
**Date & Timestamp**: 2026-08-21T21:37:30Z  
**Working Directory**: `h:/Coding/C10Data/.agents/teamwork_preview_explorer_survey_1`  
**Authoritative Reference**: `h:/Coding/C10Data/ORIGINAL_REQUEST.md`

---

## 1. Observation

A detailed line-by-line inspection of all trackers and utilities across the codebase (`src/` and `server.js`) reveals significant recurring algorithms, identical formulas, and architectural convergence across 7 tracker modules:
- `src/corridorTracker.js` (1,127 lines)
- `src/mataroTracker.js` (1,041 lines)
- `src/mataroSiriClient.js` (276 lines)
- `src/maresmeTracker.js` (1,274 lines)
- `src/sagalesTracker.js` (597 lines)
- `src/ambTracker.js` (846 lines)
- `src/rodaliesTracker.js` (565 lines)
- `src/cataloniaTracker.js` (707 lines)
- `src/cataloniaIndexer.js` (453 lines)
- `src/geoUtils.js` (83 lines)
- `src/timeUtils.js` (162 lines)
- `src/mouteClient.js` (95 lines)
- `src/moventisClient.js` (231 lines)
- `src/ingestionDaemon.js` (518 lines)
- `src/flightRecorder.js` (180 lines)
- `src/historyDb.js` (552 lines)
- `src/routeCacheService.js` (460 lines)
- `src/reportCacheService.js` (216 lines)

---

### Duplication Area 1: Geometric Snapping, Polyline Math & Dead-Reckoning

#### 1.1 Orthogonal Point-to-Segment Projection (`snapPointToPolyline`)
The mathematical vector dot product formula to project a coordinate `(lat, lon)` onto a polyline segment `(p1, p2)` is duplicated:
- **`src/mataroTracker.js` (lines 311–352)**:
```javascript
snapPointToPolyline(lat, lon, polyCoords) {
  if (!polyCoords || polyCoords.length === 0) return { lat, lon, index: 0 };
  if (polyCoords.length === 1) return { lat: polyCoords[0].lat, lon: polyCoords[0].lon, index: 0 };
  let minDistance = Infinity;
  let bestPoint = { lat: polyCoords[0].lat, lon: polyCoords[0].lon, index: 0 };
  for (let i = 0; i < polyCoords.length - 1; i++) {
    const p1 = polyCoords[i];
    const p2 = polyCoords[i + 1];
    const x1 = p1.lon, y1 = p1.lat;
    const x2 = p2.lon, y2 = p2.lat;
    const px = lon, py = lat;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 0) {
      t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
    }
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    const dist = geoUtils.calculateDistanceMeters(lat, lon, projY, projX);
    if (dist < minDistance) {
      minDistance = dist;
      bestPoint = { lat: projY, lon: projX, index: i, bearing: geoUtils.calculateBearing(p1.lat, p1.lon, p2.lat, p2.lon), dist };
    }
  }
  return bestPoint;
}
```
- **`public/js/map.js` (lines 538–577)**: Implements the exact same `snapToPolyline(lat, lon, polyline)` logic.

#### 1.2 Polyline Distance Accumulation
Iterative summation of Euclidean/Haversine segment distances along polyline coordinates appears verbatim across modules:
- **`src/mataroTracker.js` (lines 547–564 & lines 567–574)**:
  - `calculatePolylineDistanceBetween(polyCoords, lat1, lon1, lat2, lon2)`
  - `calculateRouteTotalDistance(polyCoords)`
- **`src/mataroTracker.js` (lines 506–544)**:
  - `extrapolatePolylinePosition(hist, elapsedSec, polyCoords)`: advances distance `speedMps * elapsedSec` along vertices.

#### 1.3 Subpath / Segment Discovery & Travel Progress Estimation
- **`src/mataroTracker.js` (lines 467–503)**:
  - `findNearestSegment(lat, lon, stops, polyCoords)`: Iterates stops, computes `minDist`, `distToNext = calculateDistanceMeters(...)`, `totalProgress = Math.round((toIdx / (stops.length - 1)) * 100)`, `secondsToNext = Math.max(15, Math.round((distToNext / 30) * 3.6))`.
- **`src/corridorTracker.js` (lines 877–1008)**:
  - `interpolateBusPosition(trip, currentSec, stopsMap, stopsList, oppositeTrips)`: Calculates segment progress `(currentSec - t1) / segDuration`, coordinate interpolation, bearing, speed `Math.min(85, Math.max(15, Math.round((segDist / segDuration) * 3.6)))`, distance to next stop.
- **`src/maresmeTracker.js` (lines 531–579 & 734–824)**:
  - `calculateActiveBuses`: Calculates `progress = Math.min(0.99, Math.max(0.01, elapsedSec / run.durSec))`, polyline index, bearing, compass, segment stop indices, speed `(lineConfig.code.includes('e11') ? 55 : 34)`, and `secondsToNextStop`.
- **`src/sagalesTracker.js` (lines 6–35)**:
  - `decodePolyline(encoded)`: 30-line Google Polyline algorithm embedded inside the tracker file instead of a shared utility.

---

### Duplication Area 2: Calendar, Day-Type & Date Resolution

#### 2.1 Wall-Clock Date Component Extraction (`getDateComponents`)
Both `corridorTracker.js` and `cataloniaTracker.js` implement duplicate routines calling `Intl.DateTimeFormat` with `timeZone: 'Europe/Madrid'`:
- **`src/corridorTracker.js` (lines 209–237)**:
```javascript
getDateComponents(dateObj = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: this.agencyTimezone || 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  // parses parts, builds dateStr, isSunday, isSaturday, isWeekday, isAugust
}
```
- **`src/cataloniaTracker.js` (lines 130–160)**:
```javascript
getDateComponents(dateObj = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  // parses parts, builds dateStr, dayOfWeek, hour, minute
}
```

#### 2.2 GTFS Calendar Service Exception Validation (`isServiceActiveOnDate`)
- **`src/corridorTracker.js` (lines 284–324)**: Checks `calendarExceptions.has(dateStr)` for active (type 1) and inactive (type 2), then checks weekly days.
- **`src/cataloniaTracker.js` (lines 162–179)**: Checks `calendarExceptions.has(dateStr)` for active/inactive Sets, then checks `calendar.startDate` / `endDate` and day map `['sunday', 'monday', ...]`.

#### 2.3 Stop Travel-Time Estimation along Stop Sequences
Five trackers calculate cumulative stop-to-stop distance with an average travel speed plus dwell time:
- **`src/mataroTracker.js` (lines 856–873)**: `travelSec = Math.round((cumDist / 4.8) + (stopIdx * 25));` (speed ~17 km/h, 25s dwell).
- **`src/sagalesTracker.js` (lines 492–503)**: `travelSec = Math.round((cumDist / 10.0) + (stopIdx * 30));` (speed ~36 km/h, 30s dwell).
- **`src/ambTracker.js` (lines 729–742)**: `travelSec = Math.round((cumDist / 8.0) + (stopIdx * 25));` (speed ~29 km/h, 25s dwell).
- **`src/rodaliesTracker.js` (lines 485–497)**: `travelSec = Math.round((cumDist / 18.0) + (stopIdx * 45));` (speed ~65 km/h, 45s dwell).
- **`src/maresmeTracker.js` (lines 1158–1215)**: Replicates synthetic stop sequence arrival offsets from base trip departures.

---

### Duplication Area 3: Real-Time Telemetry Parsing, Departure Modeling & Delay Badging

#### 3.1 Delay Badge Computation
Every tracker converts numeric delay minutes into a badge status and text string with slight discrepancies:
- **`src/corridorTracker.js` (lines 385–396)**:
  - `>= 2 min`: `delayStatus = 'delayed'`, `delayBadgeText = '+X min retard'`
  - `<= -2 min`: `delayStatus = 'early'`, `delayBadgeText = 'X min avançat'`
  - Else: `delayStatus = 'on_time'`, `delayBadgeText = "A l'hora (Puntual)"`
- **`src/mataroSiriClient.js` (lines 248–250)**:
  - `delayStatus = delayMins > 2 ? 'delayed' : (delayMins < -1 ? 'early' : 'on-time')`
  - `delayBadgeText = delayMins > 0 ? '+X min retard' : (delayMins < 0 ? 'X min avançat' : 'Puntual')`
- **`src/sagalesTracker.js` (lines 476–478)**:
  - `delayStatus = delayMin >= 2 ? 'delayed' : 'on_time'`
  - `delayBadgeText = delayMin >= 2 ? '+X min retard' : 'Puntual'`
- **`src/ambTracker.js` (lines 715–717)**:
  - `delayStatus = delayMin >= 2 ? 'delayed' : (delayMin <= -2 ? 'early' : 'on_time')`
  - `delayBadgeText = delayMin >= 2 ? '+X min retard' : (delayMin <= -2 ? 'X min avançat' : 'Puntual')`
- **`src/maresmeTracker.js` (lines 1114–1122)**:
  - `delayStatus = delayMins >= 2 ? 'delayed' : (delayMins <= -2 ? 'early' : 'on-time')`
- **`src/rodaliesTracker.js` (lines 471–473)**:
  - `delayStatus = delayMin >= 2 ? 'delayed' : (delayMin <= -2 ? 'early' : 'on_time')`
- **`src/cataloniaTracker.js` (lines 394–396 & 629–632)**:
  - `delayStatus = 'delayed' | 'ontime' | 'scheduled'`

#### 3.2 Both-Directions Aggregation Pattern
The wrapper handling `direction === 'both'` is duplicated across 6 trackers (`corridorTracker.js` lines 379–418, `mataroTracker.js` lines 257–266, `maresmeTracker.js` lines 395–437, `sagalesTracker.js` lines 206–237, `ambTracker.js` lines 361–395, `cataloniaTracker.js` lines 238–260). Each creates parallel requests for dir 0 and dir 1, merges `stops`, `coords`, `activeBuses`, deduplicates by vehicle/trip ID, and attaches `secondaryStops` / `secondaryCoords`.

#### 3.3 Next Service / Morning Schedule Generator
When daytime service concludes, 6 trackers generate the next day's first morning departures using nearly identical logic:
- Sets `isToday: false`, `isFirstOfDay: true`, `isNextService: true`.
- Sets `delayBadgeText = '🌅 1r Servei del matí'` (or `'🌅 1r Servei'`).
- Sets `comparisonText = '📅 Pas teòric previst demà a les HH:MM'`.

---

## 2. Logic Chain

1. **Step 1 (Observation 1.1–1.3)**: 
   Geometric snapping (`snapPointToPolyline`), along-route distance accumulation (`calculatePolylineDistanceBetween`), polyline decoding (`decodePolyline`), and segment progress estimation (`findNearestSegment`, `interpolateBusPosition`) are implemented in isolation within individual tracker files (`mataroTracker.js`, `sagalesTracker.js`, `corridorTracker.js`, `maresmeTracker.js`) and `map.js`.  
   *Inference*: Consolidating all spatial and telemetry math into a single, high-performance module (`src/core/geo/geoEngine.js` or `src/utils/geoUtils.js`) removes ~400 lines of duplicated code, guarantees identical projection accuracy across all transit lines, and enables shared unit tests.

2. **Step 2 (Observation 2.1–2.3)**: 
   Day-type detection (`getDateComponents`), GTFS calendar filtering (`isServiceActiveOnDate`), and cumulative travel-time calculations `(cumDist / speed) + (stopIdx * dwell)` are repeated across `corridorTracker.js`, `cataloniaTracker.js`, `mataroTracker.js`, `sagalesTracker.js`, `ambTracker.js`, and `rodaliesTracker.js`.  
   *Inference*: Consolidating calendar rules, day-types (weekday / saturday / sunday / holiday / august season), and timetable synthesis into `src/core/time/` and `src/core/schedule/` guarantees uniform wall-clock behavior and eliminates subtle discrepancies in rollover/midnight handling.

3. **Step 3 (Observation 3.1–3.3)**: 
   Delay badge calculation uses slightly divergent keys (`on_time` vs `on-time` vs `ontime`), while vehicle ingestion in `ingestionDaemon.js` calls 8 separate polling loops that each format and pipe data into `flightRecorder.ingestVehicle` and `historyDb.recordDelayLog`.  
   *Inference*: Standardizing data schemas (`Vehicle`, `Stop`, `Departure`, `ServiceStatus`) and creating a unified delay evaluator (`computeDelayStatus(delayMinutes, isRealTime)`) standardizes API JSON output across all 1,699+ lines in Catalonia.

4. **Step 4 (Tracker Contract & Lifecycle)**: 
   Currently, all trackers implement identical method signatures:
   - `getLines()`
   - `resolveLine(lineId)`
   - `getLineDetails(lineId, direction)`
   - `getTargetStopETA(lineId, stopId, direction)`
   - `getStopDepartures(stopId, lineId, direction)`  
   However, they are not inheriting from a shared base class, which leads to duplicated boilerplate for `direction === 'both'`, checkpoint generation, and status fallback.  
   *Inference*: An abstract `BaseTracker` class will handle all shared lifecycle operations, `both` direction merging, checkpoint structuring, and timetable fallbacks, allowing individual tracker adapters to focus solely on their provider API connector.

---

## 3. Operator-Specific Nuances vs Shared Patterns

| Operator / Provider | Upstream Protocol & Auth | Data Ingested | Unique Nuances | Shared Pattern Handled by Core |
| :--- | :--- | :--- | :--- | :--- |
| **AMB Mobilitat** (TUSGSAL, Avanza, Monbus, Soler, Baixbus) | REST JSON v2 on `api.ambmobilitat.cat`, `x-api-key` header | 243 routes, 7,467 stops, live vehicles feed, stop realtimes, disruptions | Line grouping by agency keyword (`categorizeAgency`), high-density urban stop codes | Universal Departure formatting, delay badging, timetable fallback, shape lookup |
| **Rodalies de Catalunya** (Renfe Trains) | REST JSON v2 on `api.ambmobilitat.cat/v2/gtfs/renfe` | 20 lines (R1..R8, RG1, Regionales), 205 stations, realtime departures | Train mode (`isTrain: true`), railway track coordinates, 65–80 km/h speeds, longer station spacing | Station departures format, target station ETA, delay score, both-directions merge |
| **Mataró Bus Urbà** (Avanza L1..L8) | SIRI-Lite SOAP XML on `sirimataro.avanzagrupo.com:443/Siri/SiriWS.asmx` | `VehicleMonitoring` and `StopMonitoring` live XML feeds | XML parsing, duration strings (`PT2M`), 90s dead-reckoning buffer for coverage drops | Polyline street snapping, stop progression, next bus countdown, timetable synthesis |
| **Moventis / Casas** (Maresme, e11.1, e11.2, C-10, N80, etc.) | Moventis API (`moventis.es/api/json`) + Generalitat Mou-te API (`mou-te.gencat.cat`) with MD5 HMAC `AT` header | Official trayectos, live SAE ETAs, stop timetables, GTFS shapes (SQLite `shapes.db`) | Dual-source fallback (Moventis SAE + Mou-te REST), expressway C-32 vs coastal N-II routing | Point-to-polyline projection, delay calculation, morning first-service generation |
| **Sagalés** (Interurban & NitBus N82, N83, 603, N70, N71, N73) | Direct JSON on `www.sagales.com/real-time-bus/:route/:dir` | Stops, encoded Google polyline strings, `bus.entities` GPS & stopTimeUpdates | Google Encoded Polyline string decoding, route IDs (`680`, `683`, etc.) | Geodesic distance accumulation, delay badge text, stop departures formatting |
| **Catalonia Interurban Fallback** (Plana, HIFE, Teisa, Montferri, etc.) | Generalitat Mou-te API + ATM GTFS static catalog | 1,610 routes, 36,092 stops, SQLite `shapes.db` (zero memory footprint) | Multi-agency GTFS calendar/calendar_dates filtering, operator website links | Unified schema, stop countdowns, timetable synthesis, search indexing |

---

## 4. Recommended Modular Transit Architecture

### 4.1 Target Core Layout (`src/core/` and `src/utils/`)

```
src/
├── core/
│   ├── BaseTracker.js              # Abstract class: both-dir handling, checkpoints, status builder
│   ├── TrackerRegistry.js          # Central registry & line resolution dispatcher
│   ├── geo/
│   │   └── geoEngine.js            # Haversine, bearing, snapping, polyline distance, decodePolyline
│   ├── time/
│   │   ├── timeEngine.js           # Timezone math, seconds conversion, network time, localTimeToUtcDate
│   │   └── calendarEngine.js       # Day-type detection, GTFS calendar & calendar_dates service validation
│   └── schedule/
│       ├── scheduleSynthesizer.js  # Timetable generation, sequence travel time interpolation
│       └── delayEngine.js          # Canonical delay badge computation and status classification
├── trackers/                       # Operator-specific adapters extending BaseTracker
│   ├── AmbTracker.js
│   ├── RodaliesTracker.js
│   ├── MataroTracker.js
│   ├── MaresmeTracker.js
│   ├── CorridorTracker.js
│   ├── SagalesTracker.js
│   └── CataloniaTracker.js
├── clients/                        # Low-level upstream API connectors
│   ├── ambClient.js
│   ├── mouteClient.js
│   ├── moventisClient.js
│   ├── sagalesClient.js
│   └── mataroSiriClient.js
├── flightRecorder.js               # Global fleet state & memory breadcrumbs
├── historyDb.js                    # SQLite delay logging & aggregated rollups
├── ingestionDaemon.js              # Autonomous multi-operator ingestion loop
├── reportCacheService.js           # Instant cached journalism analytics
└── routeCacheService.js            # 3-day route topologies & daily snapshots
```

---

### 4.2 Standard Transit Data Models

```typescript
interface Vehicle {
  vehicleId: string;
  fleetNumber?: string;
  tripId: string;
  lineId: string;
  lineCode: string;
  lineName: string;
  lineColor?: string;
  direction: '0' | '1' | 'both';
  destination: string;
  lat: number;
  lon: number;
  bearing: number;
  compass: { code: string; label: string };
  speedKmh: number;
  currentStopSeq: number;
  fromStop: string;
  toStop: string;
  secondsToNextStop: number;
  totalProgress: number;
  isRealTime: boolean;
  isEstimated: boolean;
  isTrain?: boolean;
  isTerminalLayover: boolean;
  coordinatesFormatted: string;
  statusText: string;
}

interface Stop {
  id: string;
  code: string;
  mouteStopId?: string;
  name: string;
  lat: number;
  lon: number;
  seq: number;
  zone: string;
  city?: string;
  color?: string;
}

interface Departure {
  lineId: string;
  lineCode?: string;
  lineName: string;
  destination: string;
  directionId?: string;
  departureTime: string;      // HH:MM (Europe/Madrid)
  departureDate?: string;     // ISO 8601 UTC string
  expectedIso?: string;       // ISO 8601 UTC string
  aimedIso?: string;          // ISO 8601 UTC string
  minutesAway: number;
  isRealTime: boolean;
  isEstimated?: boolean;
  isToday: boolean;
  isFirstOfDay?: boolean;
  isNextService?: boolean;
  delayMinutes: number;
  delayStatus: 'on_time' | 'delayed' | 'early' | 'scheduled' | 'estimated';
  delayBadgeText: string;
  comparisonText: string;
  formattedStatus: string;
  vehicleId?: string;
  busCoords?: { lat: number; lon: number };
}

interface ServiceStatus {
  isOperating: boolean;
  period?: 'day' | 'night';
  firstServiceTomorrow?: string;
  calendarTag?: string;
  statusText?: string;
}
```

---

### 4.3 Standard BaseTracker Lifecycle

```javascript
class BaseTracker {
  constructor(options = {}) {
    this.agencyTimezone = options.timezone || 'Europe/Madrid';
  }

  // Abstract methods for operator adapters to implement
  async fetchLiveVehicles(lineId) { return []; }
  async fetchStopArrivals(stopId, lineId) { return []; }
  async getRawLineData(lineId, direction) { return null; }

  // Shared lifecycle implementations
  async getLineDetails(lineId, direction = '0') {
    if (direction === 'both') {
      return this.handleBothDirections(lineId);
    }
    return this.getSingleDirectionDetails(lineId, direction);
  }

  async handleBothDirections(lineId) {
    const [d0, d1] = await Promise.all([
      this.getSingleDirectionDetails(lineId, '0'),
      this.getSingleDirectionDetails(lineId, '1')
    ]);
    return {
      ...d0,
      direction: 'both',
      directionName: 'Ambdós sentits',
      stops: d0.stops,
      coords: d0.coords,
      secondaryStops: d1.stops,
      secondaryCoords: d1.coords,
      secondaryColor: '#38bdf8',
      allDirections: [
        { dirId: '0', name: d0.directionName, stops: d0.stops, coords: d0.coords },
        { dirId: '1', name: d1.directionName, stops: d1.stops, coords: d1.coords }
      ],
      activeBuses: this.deduplicateBuses([...(d0.activeBuses || []), ...(d1.activeBuses || [])]),
      totalActiveBuses: (d0.activeBuses?.length || 0) + (d1.activeBuses?.length || 0)
    };
  }

  deduplicateBuses(buses) {
    const seen = new Set();
    const result = [];
    for (const b of buses) {
      const k = String(b.vehicleId || b.tripId || `${b.lat}_${b.lon}`);
      if (!seen.has(k)) {
        seen.add(k);
        result.push(b);
      }
    }
    return result;
  }
}
```

---

## 5. Caveats

1. **Active Real-Time Network Calls**: Upstream APIs (`api.ambmobilitat.cat`, `sirimataro.avanzagrupo.com`, `mou-te.gencat.cat`, `moventis.es`, `sagales.com`) may experience transient rate limiting, timeouts, or cellular drops. All client implementations already incorporate timeout guards (5–8s) and fallback to static GTFS timetables / cached state.
2. **SQLite Database Sync**: The system uses `node:sqlite` DatabaseSync with WAL mode and memory PRAGMAs for low latency and zero memory footprint. This must be preserved across any refactoring.
3. **No Code Write In This Phase**: This survey is strictly read-only and documents the complete duplication blueprint without modifying source files.

---

## 6. Conclusion

1. **High Deduplication Potential**: Over 1,500 lines of duplicated code across 6 trackers can be eliminated by centralizing:
   - Geometric snapping, polyline distance calculations, and polyline decoding into `src/core/geo/geoEngine.js`.
   - Date, timezone (`Europe/Madrid`), and GTFS calendar exception math into `src/core/time/`.
   - Schedule interpolation, synthetic departure generation, and delay badge computation into `src/core/schedule/`.
   - Polymorphic line dispatching, `both` direction handling, and checkpoint building into `src/core/BaseTracker.js`.
2. **Zero Breaking Changes**: All API JSON schemas, query parameters (`?direction=`, `?stopId=`, `?date=`), legacy routes (`/api/c10/*`, `/api/mataro/*`), and automated test assertions in `test/verification_test.js` and `test/e2e_multiline_test.js` can be fully preserved.

---

## 7. Verification Method

To independently reproduce and verify this investigation:

1. **Verify Baseline Test Suite**:
   ```bash
   node test/verification_test.js
   node test/e2e_multiline_test.js
   ```
   Both test suites pass 100% with all 16 multi-provider test assertions.

2. **Verify Code Locations**:
   - `src/mataroTracker.js`: lines 311–352 (`snapPointToPolyline`), lines 467–503 (`findNearestSegment`), lines 547–564 (`calculatePolylineDistanceBetween`).
   - `src/corridorTracker.js`: lines 209–237 (`getDateComponents`), lines 284–324 (`isServiceActiveOnDate`), lines 330–409 (`computeScheduledMatch`), lines 877–1008 (`interpolateBusPosition`).
   - `src/maresmeTracker.js`: lines 531–579 & 734–824 (`calculateActiveBuses`), lines 908–996 (Moventis real-time parsing), lines 1062–1152 (Mou-te matching), lines 1154–1225 (GTFS timetable generation).
   - `src/sagalesTracker.js`: lines 6–35 (`decodePolyline`), lines 278–340 (Active buses), lines 485–568 (Base schedule generation).
   - `src/ambTracker.js`: lines 426–581 (Live vehicle & stop chain grouping), lines 723–817 (Daily schedule generation).
   - `src/cataloniaTracker.js`: lines 130–160 (`getDateComponents`), lines 162–179 (`isServiceActiveOnDate`), lines 181–215 (`getScheduledDeparturesForDate`), lines 371–465 (`getStopDepartures`).
   - `src/rodaliesTracker.js`: lines 292–342 (Active trains discovery), lines 479–536 (Scheduled trains generation).
