# 🚆 Bad AMB Bus Tracker — System Architecture & Developer Guide

> **Notice for AI Models & Developers**: This document contains the complete technical overview, architecture design, API reverse-engineering details, data schemas, and domain algorithms powering **Bad AMB Bus Tracker**. Read this file first to understand the entire system without needing to re-explore the codebase from scratch.

---

## 📌 1. Project Overview & High-Level Philosophy

### Why this project exists
1. **The AMB Perimeter Dead-Zone**: The official *AMB Mobilitat* application abruptly drops telemetry when interurban buses cross out of the 36 metropolitan municipalities (e.g., as soon as line **C-10** crosses from Montgat into the Maresme coastal towns: *El Masnou, Premià de Mar, Vilassar de Mar, Cabrera de Mar, Mataró*).
2. **Cellular Shadow Drops**: Buses in urban areas (such as Mataró Bus) regularly lose cellular connectivity, causing mobile apps to freeze or disappear.
3. **Multi-Operator Fragmentation**: Catalonia's public transit is split across dozens of disjointed systems (AMB, Renfe Rodalies, Sagalés, Moventis/Casas, Avanza, Monbus, Soler i Sauret, Baixbus).

### Current System Scale
- **288+ Transit Lines** across all major operators in Catalonia.
- **7,500+ Bus Stops and Train Stations** indexed with exact GPS coordinates.
- **Multi-Provider Live Feeds**: Unified polymorphic backend with real-time GPS telemetry, dead-reckoning movement interpolation, and accurate night/day timetables.

---

## 🏗️ 2. System Architecture & Component Diagram

```mermaid
graph TD
    Client["Frontend SPA (public/js/app.js & map.js)<br>Leaflet 60fps Glider + URL Hash Router"]
    Server["Polymorphic Backend Server (server.js)<br>Express REST API & Dispatcher"]
    
    Client <-->|REST JSON / Polling Loop (15s)| Server

    subgraph Backend Trackers
        Maresme["src/maresmeTracker.js<br>(Moventis N80, N81, e11.1, e11.2, C-20, C-30)"]
        Corridor["src/corridorTracker.js<br>(Dedicated C-10 Corridor Tracker)"]
        AMB["src/ambTracker.js<br>(243 AMB Lines: TUSGSAL, Avanza, Monbus, etc.)"]
        Rodalies["src/rodaliesTracker.js<br>(20 Rodalies Lines: R1..R8, RG1, Regionals)"]
        Sagales["src/sagalesTracker.js<br>(Sagalés Lines: N82, N83, 603, N70, N71)"]
        Mataro["src/mataroTracker.js<br>(Mataró Bus Lines: L1..L8)"]
    end

    Server --> Maresme
    Server --> Corridor
    Server --> AMB
    Server --> Rodalies
    Server --> Sagales
    Server --> Mataro

    subgraph External & Upstream Providers
        MouteAPI["Generalitat Mou-te REST API<br>(HMAC-MD5 Token Authentication)"]
        AMBv2["AMB Mobilitat API v2<br>(x-api-key: 28EbLJtP...)"]
        RenfeRT["Renfe Rodalies GTFS-RT 2.0<br>(Live Train Telemetry)"]
        SagalesRT["Sagalés Real-Time Web Service<br>(Live Vehicle JSON Feeds)"]
        AvanzaSIRI["Avanza Mataró SIRI SOAP API<br>(Live Urban Bus Monitoring)"]
        ATM_GTFS["ATM Static GTFS Catalog<br>(Shapes, Trips, Stop Sequences)"]
    end

    Maresme --> MouteAPI
    Maresme --> ATM_GTFS
    Corridor --> MouteAPI
    Corridor --> ATM_GTFS
    AMB --> AMBv2
    Rodalies --> AMBv2
    Rodalies --> RenfeRT
    Sagales --> SagalesRT
    Mataro --> AvanzaSIRI
```

---

## 📁 3. File & Directory Structure

```
├── server.js                   # Express server & universal polymorphic line dispatcher
├── src/
│   ├── ambTracker.js           # Universal AMB Mobilitat Bus Tracker (243 lines, 7,444 stops)
│   ├── rodaliesTracker.js      # Rodalies de Catalunya Train Tracker (20 lines, 205 stations)
│   ├── maresmeTracker.js       # Moventis / Casas Maresme Tracker (N80, N81, e11.1, e11.2, C-20, C-30)
│   ├── corridorTracker.js      # Dedicated C-10 Corridor Tracker with live checkpoint progress
│   ├── sagalesTracker.js       # Sagalés Interurban & NitBus Tracker (N82, N83, 603, N70, N71, N73)
│   ├── mataroTracker.js        # Mataró Bus Urbà Tracker (L1 through L8)
│   ├── mataroSiriClient.js     # SIRI-Lite SOAP / HTTP client for Avanza Mataró fleet
│   ├── mouteClient.js          # Generalitat de Catalunya Mou-te API client (HMAC-MD5 token generator)
│   ├── geoUtils.js             # Haversine distance, bearing calculations, road subpath slicing
│   └── timeUtils.js            # Europe/Madrid timezone converter, network time, time parsing
├── public/
│   ├── index.html              # Single Page Application HTML (Modal explorer, Hero card, Map canvas)
│   ├── css/
│   │   └── style.css           # Modern dark UI theme, Glassmorphism, Responsive CSS tokens
│   └── js/
│       ├── app.js              # Client state machine, polling loop, URL hash router (/#r1, /#n80)
│       └── map.js              # Leaflet map engine, 60fps glider animations, street-snapping
├── data/
│   ├── atm_gtfs/               # ATM Catalonia GTFS static data (shapes, trips, stops, routes)
│   └── mataro_lines.json       # Mataró Bus urban routes & stop definitions
├── test/
│   └── e2e_multiline_test.js   # Automated multi-provider integration test suite
└── package.json                # Project dependencies and test scripts
```

---

## 📡 4. Upstream Data Sources & API Integrations

### 1. AMB Mobilitat API v2 (Direct Integration)
- **Base Host**: `https://api.ambmobilitat.cat/v2`
- **Authentication Header**: `x-api-key: 28EbLJtP0A6CtrWeXp6zE1zy3kp4RzmnaA2sy8JM`
- **Catalog Endpoint**: `GET /gtfs/routes-and-stops` (Fetches all 243 AMB bus routes, stops, directions, and agencies).
- **Bus Real-Time Arrivals**: `GET /bus/stops/:stopCode/realtimes` (Returns minutes away, expected timestamp, aimed timestamp, and vehicle ID).
- **Rodalies Train Real-Time**: `GET /gtfs/renfe/realtime/:stationId` (Returns upcoming trains, delays, platform, destination).
- **Route Shapes**: `GET /gtfs/busamb/shapes/:shapeId` and `GET /gtfs/renfe/shapes/:shapeId`.

### 2. Generalitat de Catalunya Mou-te API (HMAC-MD5 Token Authentication)
- **Base Host**: `https://moute.gencat.cat/nexus/rest/v1`
- **Token Generation** (`src/mouteClient.js`):
  - Uses MD5 hashing over timestamp and private secret key:
  ```javascript
  const timestamp = Date.now();
  const token = crypto.createHash('md5').update(`NEXUS_${timestamp}_NEXUS_PRIVATE_KEY`).digest('hex');
  ```
- **Stop Departures Endpoint**: `GET /infrastructure/nextdeparturesNEW?paradaId=:mouteStopId&useRealTime=true`
- **Line Catalog**: `GET /infrastructure/lines/transports/1`

### 3. Sagalés Live API
- **Endpoint**: `GET https://www.sagales.com/real-time-bus/:routeNumber/:directionId`
- **Headers**: Standard `User-Agent` and `Accept: application/json`.
- **Payload**: JSON with `ruta.stops` (stop sequence), `bus.entities` (live GPS vehicle telemetry: lat, lon, delay, destination), and encoded route polylines.

### 4. Mataró Bus Avanza SIRI SOAP Client
- **Host**: `http://sirimataro.avanzagrupo.com/siri/`
- **Protocol**: SIRI-Lite `VehicleMonitoring` and `StopMonitoring` XML/JSON requests.
- **Matching Algorithm**: Maps raw vehicle telemetry to line routes using destination string cleaning and Euclidean distance projection (`src/mataroTracker.js`).

---

## ⚙️ 5. Polymorphic Line Dispatcher (`server.js`)

All client requests interact with a **unified, polymorphic REST API**:

### Line ID Resolution Hierarchy:
```javascript
function getTrackerForLine(lineId) {
  const cleanId = String(lineId).toLowerCase().trim();
  if (cleanId === 'c10' || cleanId === 'c-10') return { type: 'c10', tracker: corridorTracker };
  if (maresmeTracker.resolveLine(cleanId)) return { type: 'maresme', tracker: maresmeTracker };
  if (rodaliesTracker.resolveLine(cleanId)) return { type: 'rodalies', tracker: rodaliesTracker };
  if (sagalesTracker.resolveLineConfig(cleanId)) return { type: 'sagales', tracker: sagalesTracker };
  if (mataroTracker.resolveLineConfig(cleanId)) return { type: 'mataro', tracker: mataroTracker };
  if (ambTracker.resolveLine(cleanId)) return { type: 'amb', tracker: ambTracker };
  return { type: 'amb', tracker: ambTracker };
}
```

### Standard REST Endpoints:

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/lines` | `GET` | Returns list of all 288+ transit lines grouped by operator. |
| `/api/search/stops?q={query}` | `GET` | Universal search across all 7,500+ bus stops & train stations. |
| `/api/line/:lineId?direction={dir}` | `GET` | Returns full route details: stops, GPS polyline coords, active vehicles, checkpoints. |
| `/api/line/:lineId/target-eta?direction={dir}&stopId={id}` | `GET` | Real-time arrival countdown, hero clock, and upcoming departures for a stop. |
| `/api/line/:lineId/stop/:stopId/departures?direction={dir}` | `GET` | Live departures list for a specific stop modal. |
| `/api/health` | `GET` | System health check and uptime. |

---

## 🧠 6. Critical Domain Logic & Edge-Case Solutions

### 1. Timezone Management (`Europe/Madrid`)
- **Problem**: Vercel and cloud containers execute with system clock set to UTC. Converting dates with standard `.toLocaleTimeString()` caused server clocks to display 2 hours in the past (`22:04` instead of `00:04`).
- **Solution** (`src/timeUtils.js`): All time calculations, date comparisons, and clock strings explicitly use `timeZone: 'Europe/Madrid'`. The client parses UTC ISO strings (`expectedIso`) directly in the user's browser context.

### 2. Night Service Schedule Offsets (`23:00` to `05:00`)
- **Problem**: For night lines like **N80**, **N81**, **N82**, NitBus, departures at `00:30` or `01:30` on Sunday night actually occur on Monday morning in UTC/calendar date. Standard date additions would schedule them 24 hours into the future.
- **Solution** (`src/maresmeTracker.js` & `src/sagalesTracker.js`):
  ```javascript
  let dayOffset = 0;
  if (isNightLine) {
    const origH = Math.floor(initSec / 3600) % 24;
    if (origH === 23 && netNow.hour < 12) {
      dayOffset = -1; // 23:30 belongs to yesterday night
    } else if (origH < 12 && netNow.hour >= 12) {
      dayOffset = 1;  // 00:30 belongs to upcoming midnight
    }
  }
  ```

### 3. Dead-Zone GPS Location Estimator (Dead-Reckoning)
- **Problem**: Buses entering cellular dropouts disappear from official apps.
- **Solution** (`src/geoUtils.js` & `public/js/map.js`):
  - When raw GPS telemetry drops, the system retains the vehicle in a **90-second client-side buffer**.
  - Vehicle coordinates are projected along the exact road polyline using speed and stop progression.
  - The map smoothly transitions the marker pin into an amber Estimated state (`⚡ Estimació`).

### 4. Leaflet Polyline Road-Snapping & Glider Animation (`public/js/map.js`)
- `snapToPolyline(lat, lon, polyline)`: Projects GPS points onto the nearest orthogonal road segment.
- `extractSubpath(polyline, start, end)`: Traces the exact highway curves between two points rather than drawing straight lines across buildings.
- `requestAnimationFrame` Glider: Smooth 60fps linear interpolation without teleportation.

---

## 🎨 7. Frontend State Machine & URL Routing (`public/js/app.js`)

### URL Hash Navigation
Users can directly bookmark or link to any transit line in Catalonia:
- `https://bad-amb-bus-tracker.vercel.app/#r1` ➔ Rodalies Train R1
- `https://bad-amb-bus-tracker.vercel.app/#n80` ➔ NitBus N80 (Moventis Maresme)
- `https://bad-amb-bus-tracker.vercel.app/#b25` ➔ TUSGSAL B25 (Badalona)
- `https://bad-amb-bus-tracker.vercel.app/#l80` ➔ Avanza L80 (Baix Llobregat)
- `https://bad-amb-bus-tracker.vercel.app/#a1` ➔ Monbus Aerobús A1
- `https://bad-amb-bus-tracker.vercel.app/#c10` ➔ Moventis C-10 Corridor

### Line Explorer Modal Filtering
Lines are organized into 9 network tabs:
1. **🚆 Rodalies**: Renfe train lines (R1..R8, RG1, Regionals).
2. **🟡 TUSGSAL**: Barcelonès Nord (B1..B84, M1..M30, NitBus N0..N28).
3. **🔵 Avanza**: Baix Llobregat (L80..L99, Exprés X80..X97, Urbans CF/GA/VB, NitBus N12..N21).
4. **🟠 Monbus**: Aerobús A1/A2, Baix Llobregat (L46, L52, L70..L78, M5, X43..X79).
5. **🌊 Moventis**: Maresme (C-10, N80, N81, e11.1, e11.2, C-20, C-30), L'Hospitalet/El Prat (L16..L22, PR1..PR5, LH1/LH2, M12/M14, X30), Cerdanyola (CV1..CV5).
6. **🦉 Sagalés**: NitBus & Interurbans (N82, N83, 603, N70, N71, N73).
7. **🟢 Soler i Sauret**: EP1/EP2, JM, JT, SF1..SF3, MB1..MB3, SV1..SV4.
8. **📍 Mataró Bus**: Urbans L1 through L8.
9. **🟣 Baixbus / TGO**: CS1, CS2, CS3, CS4.

---

## 🧪 8. Automated Testing & Verification

Run the comprehensive E2E test suite:
```bash
npm test
```

The test runner (`test/e2e_multiline_test.js`) verifies 14 test suites covering:
- ✅ **Test 1**: Health check endpoint.
- ✅ **Test 2**: `/api/lines` catalog integrity (288+ lines loaded).
- ✅ **Test 3**: Universal stop search across bus stops and train stations.
- ✅ **Test 4**: Mataró Bus Line 8 route & polyline.
- ✅ **Test 5**: Mataró Bus Line 8 target stop ETA.
- ✅ **Test 6**: C-10 Corridor target stop countdown.
- ✅ **Test 7**: C-10 Corridor live checkpoints and GPS telemetry.
- ✅ **Test 8**: Universal polymorphic API endpoint resolution.
- ✅ **Test 9**: Sagalés N82 Night Bus integration.
- ✅ **Test 10**: Rodalies de Catalunya train tracking (R1 line, 27 stations, track shape).
- ✅ **Test 11**: DIREXIS TUSGSAL bus integration (B25 line).
- ✅ **Test 12**: Avanza Baix Llobregat bus integration (L80 line).
- ✅ **Test 13**: Monbus Aerobús integration (A1 line).
- ✅ **Test 14**: Moventis / Casas NitBus N80 (37 stops, 1,451 shape coordinates).

---

## 🚀 9. Instructions for Future AI Models & Developers

When making future modifications to this codebase:
1. **Adding a New Bus/Train Line**:
   - If it belongs to AMB Mobilitat, it is already automatically indexed by `src/ambTracker.js`.
   - If it belongs to Rodalies, it is indexed by `src/rodaliesTracker.js`.
   - If it is a Moventis / Casas Maresme route, add its entry to `MARESME_LINES_CONFIG` in `src/maresmeTracker.js`.
   - If it is Sagalés, add its entry to `SAGALES_LINES_CONFIG` in `src/sagalesTracker.js`.
2. **Preserve Timezone Handling**:
   - Never use raw `.toLocaleTimeString()` without passing `{ timeZone: 'Europe/Madrid' }` on the backend.
   - Always return ISO 8601 strings (`expectedIso`, `aimedIso`) in UTC so the frontend can format them according to the client browser.
3. **Map Coordinate Order**:
   - Leaflet expects coordinates in `[latitude, longitude]` order (array of pairs).
   - GeoJSON uses `[longitude, latitude]` (reversed). Ensure you convert GeoJSON coordinates using `.map(p => [p[1], p[0]])` before handing them to `renderPolyline` or `renderStops`.
4. **Always Run Tests**:
   - Execute `npm test` before committing any changes. All 14 tests must pass cleanly.
