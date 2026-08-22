# AGENTS.md — Arribo! Transit Platform

> **Authoritative reference for AI coding agents.** Read this file first before exploring
> the codebase. It describes everything you need: architecture, file map, data flow,
> APIs, domain invariants, known gotchas, and required testing workflows.

---

## 1. What This Project Is

**Arribo!** is a real-time bus and train tracking platform for Catalonia, Spain.
It aggregates live GPS telemetry, timetables, and delay analytics from **7 independent
transit operators** into a single polymorphic REST API and SPA frontend.

| Metric | Value |
|--------|-------|
| Transit lines | ~1,900 (243 AMB + 8 Mataró + 11 Maresme + 6 Sagalés + 20 Rodalies + 1,610 Catalonia) |
| Bus stops & stations | ~7,500 indexed with GPS coordinates |
| Runtime | Node.js ≥ 22.5 (required for `node:sqlite`) |
| Dependencies | 3 production deps: `express`, `cors`, `compression` |
| Database | SQLite via `node:sqlite` (WAL mode, zero external DB deps) |
| Frontend | Vanilla JS SPA, no build step, Leaflet maps |
| Deployment | Docker (primary), Vercel (secondary/legacy) |

---

## 2. Process Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     Main Process (server.js)                     │
│                                                                  │
│  Express HTTP server (:3000)                                     │
│  ├── Static assets (public/)                                     │
│  ├── REST API routes (/api/*)                                    │
│  ├── TrackerRegistry (line resolution)                           │
│  ├── FlightRecorder (in-memory vehicle state, read-only)         │
│  └── ReportCacheService (in-memory report cache, read-only)      │
│                                                                  │
│  WorkerBridge (src/core/WorkerBridge.js)                         │
│  ├── Heartbeat ping/pong every 15s                               │
│  ├── Auto-restart with exponential backoff (1s → 15s)            │
│  └── IPC message dispatch                                        │
└───────────────────────────┬──────────────────────────────────────┘
                            │ IPC (child_process.fork)
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│              Background Worker (src/workers/ingestionWorker.js)   │
│                                                                  │
│  IngestionDaemon (src/ingestionDaemon.js)                        │
│  ├── Vehicle telemetry polling (per-operator timers)              │
│  ├── GTFS catalog sync (AMB, Catalonia)                          │
│  ├── Delay log recording → SQLite                                │
│  ├── Route/topology caching                                      │
│  └── Report generation (24h/48h/7d every 30 min)                 │
│                                                                  │
│  HistoryDb (src/historyDb.js) — SQLite writer                    │
│  FlightRecorder — vehicle state owner + dead-reckoning           │
│  TrackerRegistry — all 7 provider trackers initialized here      │
└──────────────────────────────────────────────────────────────────┘
```

### IPC Message Types (WorkerBridge ↔ IngestionWorker)

| Direction | Type | Payload | Purpose |
|-----------|------|---------|---------|
| Worker → Main | `WORKER_READY` | `{pid, version}` | Worker initialized |
| Worker → Main | `FLEET_UPDATE` | `{vehicles: [...]}` | Sync live vehicle positions |
| Worker → Main | `REPORT_CACHE_UPDATE` | `{timeframeHours, report}` | Push fresh report |
| Worker → Main | `DISRUPTIONS_UPDATE` | `{disruptions: [...]}` | Push AMB service alerts |
| Main → Worker | `PING` | — | Liveness check |
| Worker → Main | `PONG` | `{memory, uptime, activeVehicles}` | Health response |
| Main → Worker | `SHUTDOWN` | — | Graceful termination |

> **Critical rule**: The main process never writes to SQLite or polls upstream APIs.
> All heavy I/O happens in the worker. The main process only reads from in-memory caches
> synced via IPC.

---

## 3. File Map

```
.
├── server.js                         # Express HTTP server, API routes, line dispatcher
├── src/
│   ├── core/
│   │   ├── BaseTracker.js            # Abstract base class for all trackers
│   │   ├── TrackerRegistry.js        # Polymorphic line resolver, warm snapshot loader
│   │   ├── WorkerBridge.js           # IPC supervisor for background worker process
│   │   ├── geo/
│   │   │   └── geoEngine.js          # Haversine, polyline snapping, bearing, distance
│   │   ├── time/
│   │   │   ├── timeEngine.js         # Europe/Madrid timezone, UTC conversion, formatting
│   │   │   └── calendarEngine.js     # Day-type (weekday/saturday/sunday), GTFS calendar
│   │   └── schedule/
│   │       ├── scheduleSynthesizer.js # Timetable generation, stop interpolation
│   │       └── delayEngine.js        # Delay evaluation, badge text, countdown formatting
│   │
│   ├── workers/
│   │   └── ingestionWorker.js        # Background worker entry point (forked process)
│   │
│   ├── corridorTracker.js            # C-10 Corridor (Barcelona–Mataró dedicated tracker)
│   ├── mataroTracker.js              # Mataró Bus Urbà L1–L8 (SIRI + official timetables)
│   ├── maresmeTracker.js             # Moventis Maresme (N80, N81, e11.1, e11.2, C-20, C-30)
│   ├── sagalesTracker.js             # Sagalés (N82, N83, 603, N70, N71, N73)
│   ├── ambTracker.js                 # AMB Mobilitat (243 lines: TUSGSAL, Avanza, Monbus)
│   ├── rodaliesTracker.js            # Rodalies de Catalunya trains (R1–R8, RG1, regionals)
│   ├── cataloniaTracker.js           # Generalitat Mou-te (1,610 interurban routes, fallback)
│   │
│   ├── mataroSiriClient.js           # SIRI SOAP client for Avanza Mataró fleet
│   ├── mouteClient.js                # Generalitat Mou-te REST client (HMAC-MD5 auth)
│   ├── moventisClient.js             # Moventis SAE REST client
│   │
│   ├── ingestionDaemon.js            # Autonomous multi-agency telemetry polling engine
│   ├── flightRecorder.js             # In-memory vehicle state + dead-reckoning extrapolator
│   ├── historyDb.js                  # SQLite persistence (WAL, vehicle snapshots, delay logs)
│   ├── reportCacheService.js         # Pre-computed 24h/48h/7d journalism delay reports
│   ├── routeCacheService.js          # LRU route geometry cache + daily topology snapshots
│   │
│   ├── c10StaticData.js              # C-10 authoritative stop/timetable reference data
│   ├── cataloniaIndexer.js           # Full Catalonia GTFS stop/route indexer
│   └── data/
│       └── mataroSchedules.js        # Official Mataró Bus timetables (L1–L8, all day types)
│
├── public/
│   ├── index.html                    # SPA shell (single HTML file, no framework)
│   ├── css/style.css                 # Dark/light theme, glassmorphism, responsive tokens
│   └── js/
│       ├── app.js                    # Client state machine, polling, URL router (~3,577 lines)
│       └── map.js                    # Leaflet map engine, glider animations, trail rendering
│
├── data/
│   ├── cities/mataro/                # Mataró static route/stop/schedule JSON
│   ├── cache/                        # Runtime caches (gitignored)
│   ├── reports/                      # Generated journalism reports (gitignored)
│   ├── snapshots/                    # Daily route topology snapshots (gitignored)
│   ├── shapes.db                     # Pre-built GTFS route shapes SQLite database
│   └── transit_history.db            # Runtime delay/vehicle history (gitignored)
│
├── test/                             # Test suites (see §9)
├── Dockerfile                        # Node 22 Alpine production image
├── docker-compose.yml                # Docker deployment with memory limits & healthcheck
└── vercel.json                       # Vercel serverless deployment config
```

---

## 4. Tracker Resolution Priority

When a client requests `/api/line/:lineId`, the `TrackerRegistry.getTrackerForLine(lineId)`
resolves the line ID to the correct operator tracker in strict priority order:

| Priority | Provider Key | Tracker | Lines Handled |
|----------|-------------|---------|---------------|
| 100 | `c10` | `corridorTracker` | `c10`, `c-10`, `gen_0498`, `02498` |
| 90 | `mataro` | `mataroTracker` | `1`–`8`, `l1`–`l8`, `mataro_1`–`mataro_8` |
| 80 | `maresme` | `maresmeTracker` | `n80`, `n81`, `e11.1`, `e11.2`, `c-20`, `c-30` |
| 70 | `rodalies` | `rodaliesTracker` | `r1`–`r8`, `rg1`, `rt1`, `rt2`, `r11`–`r15` |
| 60 | `amb` | `ambTracker` | 243 AMB metro bus lines (B25, L80, A1, etc.) |
| 50 | `sagales` | `sagalesTracker` | `n82`, `n83`, `603`, `n70`, `n71`, `n73` |
| 10 | `catalonia` | `cataloniaTracker` | 1,610 Generalitat interurban (fallback) |

> **Important**: Mataró lines `1`–`8` are checked **before** AMB to prevent numeric
> ID collision. The `catalonia` tracker is always the last-resort fallback.

---

## 5. REST API Reference

All endpoints are **GET-only** (enforced by middleware — POST/PUT/DELETE return 405).

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Health check with uptime |
| `GET /api/lines` | Full catalog of all ~1,900 lines grouped by operator |
| `GET /api/search/stops?q={query}` | Universal stop search across all 7,500+ stops |
| `GET /api/line/:lineId?direction={dir}` | Route details: stops, polyline coords, active buses |
| `GET /api/line/:lineId/vehicles` | Live vehicle positions for a line |
| `GET /api/line/:lineId/target-eta?direction={dir}&stopId={id}` | Arrival countdown for target stop |
| `GET /api/line/:lineId/stop/:stopId/departures?direction={dir}` | Departure board for a stop |
| `GET /api/vehicles` | All tracked vehicles across all operators |
| `GET /api/retards/ranking` | Delay ranking (pre-computed from journalism reports) |
| `GET /api/analytics/journalism?hours={24\|48\|168}` | Full journalism delay report |
| `GET /api/line/:lineId/trail?vehicleId={id}` | GPS breadcrumb trail for a vehicle |

---

## 6. Upstream API Credentials & Authentication

| Provider | Host | Auth Method |
|----------|------|-------------|
| **AMB Mobilitat** | `api.ambmobilitat.cat/v2` | Header: `x-api-key: 28EbLJtP0A6CtrWeXp6zE1zy3kp4RzmnaA2sy8JM` |
| **Mataró SIRI** | `sirimataro.avanzagrupo.com:443` | SOAP body: `AccountId=Mataro`, `AccountKey=Mataro*WS` |
| **Generalitat Mou-te** | `moute.gencat.cat/nexus/rest/v1` | HMAC-MD5: `MD5("NEXUS_{timestamp}_NEXUS_PRIVATE_KEY")` |
| **Moventis SAE** | `app.moventis.es/sae/api` | Header: `Authorization: Basic {base64}` |
| **Sagalés** | `sagales.com/real-time-bus/:route/:dir` | Public JSON (User-Agent header) |
| **Rodalies GTFS-RT** | Via AMB v2 API | Same AMB key |

> **Never hardcode new credentials in tracker files.** Use environment variables or
> the existing client modules in `src/`.

---

## 7. Domain Invariants — Rules You Must Never Break

### 7.1 Timezone: Always `Europe/Madrid`

All Catalan transit operates in `Europe/Madrid` (CET/CEST). Docker containers and
cloud VMs run in UTC. **Never use raw `new Date().getHours()`** on the backend.

```javascript
// ✅ CORRECT — use core engine
const { getDateComponents } = require('./core/time/calendarEngine');
const dc = getDateComponents(new Date(), 'Europe/Madrid');
// dc.hour, dc.dayType ('weekday'|'saturday'|'sunday'), dc.dateStr

// ✅ CORRECT — format display time
const { formatTimeToTimezone } = require('./core/time/timeEngine');
const display = formatTimeToTimezone(isoString); // "14:32" or "--:--" on error

// ❌ WRONG — machine-local time on UTC server
const hour = new Date().getHours(); // Returns UTC hour, 2h behind Catalonia
```

### 7.2 Night Service (23:00–05:00) Day Boundary

Night lines (N80, N81, N82, NitBus) have departures at `00:30`, `01:30`, etc. that
calendar-wise belong to the **previous day's service**. A departure at `Sunday 00:30`
is part of Saturday night service. Use the night-offset logic in `maresmeTracker.js`
and `sagalesTracker.js` — never naively add 24h.

### 7.3 Coordinate Order

| Context | Order | Example |
|---------|-------|---------|
| Leaflet JS | `[latitude, longitude]` | `[41.539, 2.444]` |
| GeoJSON | `[longitude, latitude]` | `[2.444, 41.539]` |
| Internal polylines | `[[lat, lon], ...]` | Leaflet order |

**Convert GeoJSON** before passing to map: `.map(p => [p[1], p[0]])`.

### 7.4 Use Core Engines — Never Reimplement

All trackers **must** use `src/core/` modules:

| Need | Use | Don't |
|------|-----|-------|
| Distance between points | `geoEngine.calculateDistanceMeters()` | Roll your own Haversine |
| Snap GPS to route | `geoEngine.snapPointToPolyline()` | Nearest-point approximation |
| Day type detection | `calendarEngine.getDateComponents()` | `getDay() === 0` |
| Delay badge text | `delayEngine.computeDelayStatus()` | Custom string formatting |
| Travel time estimation | `scheduleSynthesizer.estimateStopTravelTimes()` | Fixed speed assumptions |
| Time formatting | `timeEngine.formatTimeToTimezone()` | `.toLocaleTimeString()` |

### 7.5 Data Schemas

Vehicle objects must include these fields:
```
vehicleId, lineId, lineName, direction, destination, lat, lon,
latitude, longitude, bearing, speedKmh, delayMins, delayFormatted,
isEstimated, isRealTime, recordedAt, timestamp
```

Departure objects must include:
```
lineId, lineName, destination, departureTime, departureDate,
expectedIso, aimedIso, minutesAway, isRealTime, isEstimated,
isToday, delayStatus, delayBadgeText, formattedStatus
```

> Both `lat`/`lon` AND `latitude`/`longitude` must be present (dual-compat schema).

### 7.6 Dead-Reckoning Window

When live GPS telemetry drops, vehicles are retained in a **90-second extrapolation
buffer** (`flightRecorder.maxExtrapolationMs = 90000`). After 90s without a fresh
GPS fix, the vehicle is marked stale. Never extend this beyond 90s.

---

## 8. Frontend Architecture

### Key Files
- **`public/js/app.js`** (~3,577 lines): Full SPA state machine
- **`public/js/map.js`** (~1,022 lines): Leaflet map controller
- **`public/index.html`**: Single HTML shell with inline CSS tokens

### Client State Machine (`TransitApp` class)
```
constructor() → init() → fetchLines() → parseUrlHash()
                                           │
                              ┌─────────────┴────────────┐
                              │                          │
                        Landing View               Active Line View
                      showLandingView()          showActiveLineView()
                      renderLandingLines()       refreshAllData(true)
                              │                          │
                              └────── switchLine() ──────┘
                                          │
                                   refreshAllData()
                                   ├── fetch /api/line/:id
                                   ├── fetch /api/line/:id/target-eta
                                   ├── render map, stops, buses
                                   └── 15s polling timer restart
```

### Performance Rules (Do Not Violate)

| Rule | Why |
|------|-----|
| **Page Visibility Deep Sleep** | `visibilitychange` listener suspends polling and `rAF` when tab is hidden |
| **Leaflet Canvas Renderer** | `preferCanvas: true` — saves ~40MB DOM/GPU RAM vs SVG |
| **DOM Event Delegation** | Never attach `.addEventListener` inside loops. Use `e.target.closest('[data-*]')` |
| **8-entry LRU Route Cache** | `this.lineCache` is bounded. Uses `setLineCache()` with eviction |
| **Client SWR Stop Cache** | `this.stopDeparturesCache` serves stop modals instantly from stale cache while revalidating |
| **No slicing departure lists** | `renderDeparturesInto()` shows ALL departures in a scrollable container. Never slice to 8 |

### URL Hash Routing
```
#c10      → C-10 Corridor
#l1       → Mataró Bus Line 1
#r1       → Rodalies R1
#n80      → NitBus N80
#b25      → TUSGSAL B25
#l80      → Avanza L80
```

### Cache Busting
Script tags in `index.html` use `?v=X.Y.Z` query params:
```html
<script src="/js/app.js?v=3.2.42"></script>
```
**Always bump the version** when modifying `app.js` or `map.js`.

---

## 9. Testing

### Required Test Commands
Run **all of these** before committing:

```bash
# 1. Syntax validation across all 50+ JavaScript files
node test/syntax_check.js

# 2. Core module unit tests (time, geo, schedule, delay engines)
node test/core_transit_modules_test.js

# 3. Full verification test (SIRI, timetables, reports, all trackers)
node test/verification_test.js

# 4. Adversarial edge-case tests
node test/adversarial_audit_test.js
node test/challenger_geo_delay_test.js
node test/challenger_tracker_schedule_test.js

# 5. Mataró timetable accuracy (483 assertions, 4-tier suite)
node test/mataro_timetable_accuracy_test.js

# 6. Startup benchmark (boot latency, concurrent load)
node test/startup_benchmark.js
```

### Test Suite Inventory

| File | Tests | What it verifies |
|------|-------|------------------|
| `syntax_check.js` | All `.js` files | AST parsing with no syntax errors |
| `core_transit_modules_test.js` | Core engines | geoEngine, timeEngine, calendarEngine, scheduleSynthesizer, delayEngine |
| `verification_test.js` | End-to-end | SIRI arrivals, Mataró stops, target ETA, journalism reports |
| `mataro_timetable_accuracy_test.js` | 483 assertions | 4-tier suite: feature coverage, boundary cases, SIRI merge, real-world hubs |
| `adversarial_audit_test.js` | Edge cases | Hostile inputs, malformed data, timezone boundaries |
| `challenger_geo_delay_test.js` | Geo + delay | Polyline snapping precision, delay computation edge cases |
| `challenger_tracker_schedule_test.js` | Schedules | Cross-tracker schedule consistency |
| `startup_benchmark.js` | Performance | Boot latency <200ms, cold /api/lines <50ms, 80-req concurrent load |
| `e2e_multiline_test.js` | 14 suites | Multi-provider API integration (all 7 trackers) |
| `m3_smoke_test.js` | Smoke | Quick endpoint health check |
| `stop_cache_benchmark_test.js` | Cache perf | In-memory stop departures cache latency |
| `worker_bridge_test.js` | IPC | WorkerBridge message contracts |
| `history_db_concurrency_test.js` | SQLite | WAL concurrency under parallel writes |

> **All tests must pass with 0 errors.** The exit code 1 from `verification_test.js`
> is a PowerShell stderr artifact (the ExperimentalWarning) — the test itself prints
> `ALL VERIFICATION CHECKS PASSED PERFECTLY`.

---

## 10. SQLite Schema (`src/historyDb.js`)

```sql
-- WAL mode with 5s busy timeout for concurrent reader/writer
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;

-- Raw GPS snapshots (pruned to SNAPSHOT_RETENTION_HOURS, default 2h)
CREATE TABLE vehicle_snapshots (
  vehicle_id TEXT, line_id TEXT, line_code TEXT, agency TEXT,
  lat REAL, lon REAL, speed_kmh REAL, bearing REAL,
  delay_mins INTEGER, is_realtime INTEGER, status TEXT,
  timestamp INTEGER
);

-- Delay event log (pruned to DELAY_RETENTION_DAYS, default 30d)
CREATE TABLE delay_logs (
  line_id TEXT, line_code TEXT, agency TEXT, stop_id TEXT, stop_name TEXT,
  delay_mins INTEGER, scheduled_time TEXT, actual_time TEXT,
  is_realtime INTEGER, is_delayed INTEGER, timestamp INTEGER
);

-- Hourly rollup (kept indefinitely, <1 MB/day)
CREATE TABLE hourly_line_stats (
  line_code TEXT, agency TEXT, date_hour TEXT,
  sample_count INTEGER, avg_delay_mins REAL, max_delay_mins INTEGER,
  on_time_count INTEGER, late_count INTEGER, timestamp INTEGER,
  UNIQUE(line_code, date_hour)
);
```

Environment variables controlling retention:
- `SNAPSHOT_RETENTION_HOURS` (default: `2`)
- `DELAY_RETENTION_DAYS` (default: `30`)
- `VEHICLE_SNAPSHOT_INTERVAL_MS` (default: `60000`)

---

## 11. Docker Deployment

```bash
# Build and run
docker compose up -d --build

# View logs
docker logs -f bad-amb-bus-tracker

# Health check
curl http://localhost:3000/api/health
```

**Resource limits** (docker-compose.yml):
- Memory: 350MB limit, 80MB reservation
- `NODE_OPTIONS=--max-old-space-size=256`
- `TZ=Europe/Madrid`
- Volume mount: `./data:/app/data` (persists SQLite, caches, reports)

**Startup sequence**: Express listens in <200ms. The WorkerBridge forks the
background ingestion worker which initializes all trackers, starts polling,
and begins syncing data back to the main process via IPC.

---

## 12. Adding a New Transit Operator

1. **Create `src/myOperatorTracker.js`** extending `BaseTracker`:
   ```javascript
   const BaseTracker = require('./core/BaseTracker');
   class MyOperatorTracker extends BaseTracker {
     constructor() { super({ agencyTimezone: 'Europe/Madrid' }); }
     async init() { /* load routes, stops */ }
     resolveLine(lineId) { /* return config or null */ }
     async fetchLiveVehicles(lineId) { /* return normalized vehicles */ }
     async fetchStopArrivals(stopId, lineId, direction) { /* return departures */ }
   }
   module.exports = new MyOperatorTracker();
   ```

2. **Register in `TrackerRegistry._ensureDefaultProviders()`** (line ~76):
   ```javascript
   const myTracker = require('../myOperatorTracker');
   this.registerTracker('myop', myTracker, { agency: 'My Operator', priority: 55 });
   ```

3. **Add to `ingestionDaemon.js`**: Create a polling timer for the new operator.

4. **Add to `server.js` imports** (line ~1): Import the tracker singleton.

5. **Run all tests** before committing.

---

## 13. Common Gotchas & Pitfalls

### Race Conditions on Line Switching
The frontend uses `activeLineId` + `activeDirection` guards in `refreshAllData()` to
discard stale network responses when the user switches lines. If you add new async
fetches, always check `this.activeLineId === lId && this.activeDirection === dir`
before applying the response to the DOM.

### Script Version Cache Busting
After modifying `public/js/app.js` or `public/js/map.js`, **always bump** the `?v=`
query parameter in `public/index.html` or browsers will serve stale cached scripts.

### SQLite in Main Process
The main HTTP server process does **not** open or write to SQLite. All database I/O
happens in the background worker. The main process reads from in-memory caches
(`flightRecorder`, `reportCacheService`) that are synced via IPC. If you need
historical data in an API route, use the existing `flightRecorder.getDelayStats()`
or `reportCacheService.getReport()` methods.

### Dual Coordinate Fields
Vehicle objects must have **both** `lat`/`lon` AND `latitude`/`longitude` fields.
The frontend and different trackers reference both conventions. Missing one causes
silent map rendering failures.

### Night Line Day Boundaries
A Sunday 00:30 departure belongs to Saturday night service. Never assume
`new Date().getDay()` matches the service day for departures between midnight and 5am.

### AMB Catalog Size
The AMB tracker loads 243 lines with 7,400+ stops. Its full catalog JSON is ~26MB.
The `routeCacheService` maintains warm snapshots so this doesn't block startup.

### SIRI SOAP Timeouts
The Mataró SIRI server (`sirimataro.avanzagrupo.com`) has a 5-second timeout and
frequently returns `ECONNRESET`. The client (`mataroSiriClient.js`) handles this
gracefully with a 12-second live cache and falls back to cached data. Never remove
the timeout/retry logic.

---

## 14. Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP server port |
| `NODE_ENV` | — | Set to `production` in Docker |
| `TZ` | — | Set to `Europe/Madrid` in Docker |
| `NODE_OPTIONS` | — | `--max-old-space-size=256` in Docker |
| `DATA_DIR` | `./data` | Base directory for all data files |
| `DB_PATH` | `./data/transit_history.db` | SQLite database path |
| `SNAPSHOT_RETENTION_HOURS` | `2` | How long to keep raw vehicle GPS snapshots |
| `DELAY_RETENTION_DAYS` | `30` | How long to keep delay event logs |
| `VEHICLE_SNAPSHOT_INTERVAL_MS` | `60000` | How often to record vehicle snapshots to SQLite |

---

## 15. Quick Reference — Key Line Numbers

| File | Lines | What's There |
|------|-------|-------------|
| `server.js:62` | `getTrackerForLine()` | Polymorphic line dispatcher |
| `server.js:49` | `workerBridge.start()` | Background worker launch |
| `app.js:4–46` | `constructor()` | Client state initialization |
| `app.js:141` | `parseUrlHash()` | URL hash → line ID resolution |
| `app.js:314` | `switchLine()` | Line switching with cache + optimistic render |
| `app.js:777` | `refreshAllData()` | Core data refresh engine |
| `app.js:2262` | `inspectStop()` | Stop modal with SWR cache |
| `app.js:3468` | `startAutoRefresh()` | 15-second polling timer |
| `map.js:280` | `renderStops()` | Map stop markers + polyline rendering |
| `map.js:617` | `updateBusMarkers()` | Live bus marker updates + glider animation |
| `map.js:865` | `stepBusAnimation()` | 60fps glider interpolation |
| `TrackerRegistry.js:154` | `getTrackerForLine()` | Priority-ordered resolution chain |
| `WorkerBridge.js:59` | `spawnWorker()` | Worker process forking |
| `WorkerBridge.js:96` | `handleWorkerMessage()` | IPC dispatch switch |
| `ingestionDaemon.js:13` | `constructor()` | All polling timer handles |
| `historyDb.js:41` | `init()` | SQLite schema + PRAGMA setup |
| `flightRecorder.js:50` | `ingestVehicle()` | Vehicle state ingestion |

---

## 16. Git Workflow

### What's gitignored
```
.agents/           # AI agent scaffolding
data/cache/        # Runtime JSON caches (regenerated)
data/reports/      # Journalism reports (regenerated every 30min)
data/snapshots/    # Daily route topology (regenerated)
data/test_scratch/ # Temp test databases
data/*.db*         # SQLite databases
```

### Commit checklist
1. `node test/syntax_check.js` → 0 errors
2. `node test/verification_test.js` → all passed
3. `node test/core_transit_modules_test.js` → all passed
4. Bump `?v=X.Y.Z` in `index.html` if you touched `app.js` or `map.js`
5. `git add` relevant files (never `git add -A` without checking)
6. `git commit -m "type(scope): description"`
7. `git push`
