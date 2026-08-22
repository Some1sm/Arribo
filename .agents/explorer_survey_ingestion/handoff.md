# Handoff Report: Background Ingestion & Worker Isolation Analysis

## 1. Observation

### 1.1 Current Application Startup & Ingestion Call Chain
In `server.js`, background ingestion and tracker initialization are directly embedded into the main HTTP server startup sequence:

```javascript
// server.js (lines 40-45)
trackerRegistry.initAll().then(() => {
  console.log('[TransitPlatform] All Multi-Provider Trackers Initialized.');
  trackerRegistry.cachedLines = null; // Rebuild catalog with fully initialized providers
  ingestionDaemon.start();
});
```

And in `server.js` route handlers:
- `GET /api/lines` (lines 226-235): Calls `await trackerRegistry.initAll();` on the request thread.
- `GET /api/search/stops` (lines 238-247): Calls `await trackerRegistry.initAll();` on the request thread.

### 1.2 Synchronous File & Heavy Parsing Operations on Module Load
Direct inspection of the source files revealed multiple heavy synchronous I/O and JSON parsing operations executing during `require()` or initial constructor execution:

1. **`src/maresmeTracker.js`** (lines 204, 239-250):
   ```javascript
   constructor() { ... this.loadData(); }
   loadData() {
     const cachePath = path.join(__dirname, '..', 'data', 'cache', 'maresme_cache.json');
     if (fs.existsSync(cachePath)) {
       const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')); // 73,015,821 bytes (73 MB!)
   ```
   **Observed File Size**: `data/cache/maresme_cache.json` is **73.0 MB**. `fs.readFileSync` and `JSON.parse` execute synchronously on the main thread at `require('./src/maresmeTracker')` in `server.js:10`.

2. **`src/corridorTracker.js`** (lines 50, 145, 168-185):
   ```javascript
   constructor() { ... this.loadData(); }
   loadData() { ... this.loadCalendarSync(); }
   loadCalendarSync() {
     const datesFile = path.join(atmDir, 'calendar_dates.txt');
     if (fs.existsSync(datesFile)) {
       const lines = fs.readFileSync(datesFile, 'utf8').split('\n'); // 31,777,880 bytes (31.7 MB!)
   ```
   **Observed File Size**: `data/atm_gtfs/calendar_dates.txt` is **31.8 MB**. Splitting and looping through hundreds of thousands of CSV lines occurs synchronously on `require('./src/corridorTracker')` in `server.js:5`.

3. **`src/cataloniaTracker.js`** (lines 30-52):
   When `cataloniaTracker.init()` runs via `trackerRegistry.initAll()`:
   - `route_details.json` (**26.0 MB**)
   - `calendar_dates.json` (**20.6 MB**)
   - `stops.json` (**3.9 MB**)
   - `calendar.json` (**1.9 MB**)
   - `routes.json` (**0.6 MB**)
   Totaling over **53 MB** of synchronous JSON parsing, building Maps for 1,610 routes and 36,092 stops on the event loop.

4. **`src/reportCacheService.js`** (lines 12-27, 37-56):
   Constructor calls `this.init()` -> `this.loadLatestFromDisk()` which performs synchronous `fs.readdirSync`, `fs.statSync`, and `fs.readFileSync` for 24h, 48h, and 168h report files.

5. **`src/historyDb.js`** (lines 26-105):
   Constructor calls `this.init()` which synchronously initializes `node:sqlite` `DatabaseSync`, sets WAL PRAGMAs, and executes multi-statement table/index creation (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).

### 1.3 Active Timers and Pollers in `src/ingestionDaemon.js`
`src/ingestionDaemon.js` manages 12 active timers concurrently polling external endpoints, parsing data, and executing synchronous SQLite queries on the same event loop:

| Timer | Interval | Target Method | Target Provider / Protocol | DB / Storage Operations |
|---|---|---|---|---|
| `vehiclePollTimer` | 12s | `pollAmbVehicles()` | AMB Mobilitat REST API (`/v2/gtfs/busamb/realtime`) | `flightRecorder.ingestVehicle()`, `historyDb.recordDelayLog()`, `historyDb.recordVehicleSnapshot()` |
| `mataroPollTimer` | 15s | `pollMataroVehicles()` | Avanza Mataro SIRI-Lite SOAP/XML Gateway | `flightRecorder.ingestVehicle()`, `historyDb.recordDelayLog()` |
| `ambLinesPollTimer` | 20s | `pollAmbLines()` | AMB REST API (35 lines/batch) | `historyDb.recordDelayLog()` |
| `corridorPollTimer` | 20s | `pollCorridorDelays()` | Mou-te Nexus NextDepartures API (Dirs 0 & 1) | `flightRecorder.ingestVehicle()`, `historyDb.recordDelayLog()` |
| `maresmePollTimer` | 25s | `pollMaresmeLines()` | Moventis / Casas Mou-te API (4 lines/batch) | `flightRecorder.ingestVehicle()`, `historyDb.recordDelayLog()` |
| `rodaliesPollTimer` | 30s | `pollRodaliesTrains()` | AMB Renfe GTFS-RT API (7 train lines) | `historyDb.recordDelayLog()` |
| `sagalesPollTimer` | 30s | `pollSagalesLines()` | Sagales Direct JSON Telemetry (15 lines/batch) | `historyDb.recordDelayLog()` |
| `cataloniaPollTimer` | 30s | `pollCataloniaLines()` | Mou-te GTFS Schedule departures (100 lines/batch) | `historyDb.recordDelayLog()` |
| `disruptionsTimer` | 180s | `pollDisruptions()` | AMB Incidences API | Updates in-memory disruption cache |
| `journalismReportTimer` | 30m | `generateJournalismReport()` | `reportCacheService.generateAllReports()` | Synchronous SQLite analytics query over 150k+ rows for 24h, 48h, 168h; saves JSON to disk |
| `pruneTimer` | 1h | `historyDb.pruneOldRecords()` | SQLite maintenance | `aggregateHourlyStats()`, `DELETE FROM vehicle_snapshots`, `DELETE FROM delay_logs`, `PRAGMA incremental_vacuum;` |
| `dailySnapshotTimer` | 24h | `routeCacheService.takeDailySnapshot()` | Route topology maintenance | Generates route topology snapshots and prunes snapshots > 3 days |

Startup staggering: Staggered `setTimeout` calls execute at 100ms, 400ms, 700ms, 1000ms, 1300ms, 1600ms, 2000ms, 2400ms, and 3000ms, triggering an avalanche of network requests and synchronous SQLite inserts within seconds of process boot.

### 1.4 Heavy & Blocking SQLite Analytics Queries
`src/historyDb.js` uses `node:sqlite` `DatabaseSync`, where all queries are synchronous and blocking:
- **`getJournalismReport(hoursBack, catalog)`** (lines 269-451):
  Executes 4 SQL prepared statements against the database (currently containing 151,681 delay logs), followed by catalog filtering and JavaScript array sorting.
  *Observed duration*: **380ms to 1,475ms of continuous 100% main thread CPU lockup per timeframe!**
- **`exportDelayLogsCsv(hoursBack)`** (lines 453-484):
  Synchronously queries 50,000 records (`LIMIT 50000`) and formats CSV strings in memory.
- **`pruneOldRecords()` & `aggregateHourlyStats()`** (lines 487-548):
  Synchronously computes hourly rollups with `INSERT INTO hourly_line_stats SELECT ... GROUP BY ...`, deletes expired raw snapshots/logs, and runs `PRAGMA incremental_vacuum;`.

---

## 2. Logic Chain

### 2.1 Root Causes of Startup Latency (>5000ms vs. <100ms Target)
1. **Module Evaluation I/O**: `server.js` requires all trackers directly. Requiring `maresmeTracker.js` synchronously reads and parses a 73MB JSON file; requiring `corridorTracker.js` synchronously reads and parses a 31.7MB text file. This blocks Node.js execution before Express can even call `app.listen()`.
2. **Network Dependency on Boot**: `trackerRegistry.initAll()` waits on `rodaliesTracker.init()`, which performs external network requests to `api.ambmobilitat.cat`. If the network is slow or experiencing packet loss, the server startup hangs for 5,000ms to 10,000ms.
3. **Endpoint Serialization**: The `/api/lines` endpoint awaits `trackerRegistry.initAll()`, which blocks until all provider async `init()` methods complete, instead of returning an instant pre-indexed summary.
4. **Immediate Ingestion Burst**: `ingestionDaemon.start()` begins firing 9 staggered pollers within 3 seconds of startup, flooding the single event loop with HTTP socket callbacks, JSON parsing, and synchronous SQLite write locks just as web clients make their initial requests.

### 2.2 Mechanism of Continuous Operation Event-Loop Starvation
1. **Synchronous SQLite Contention**: Because `DatabaseSync` is synchronous, every vehicle ingest (`recordVehicleSnapshot`) and poller delay log (`recordDelayLog`) executes `stmt.run()` directly on the main event loop. With 500+ vehicles and 8 pollers running every 12-30 seconds, the event loop spends significant time in SQLite C++ bindings.
2. **Batch Journalism Report Spikes**: Every 30 minutes, `generateJournalismReport()` calculates 24h, 48h, and 168h reports sequentially. This blocks the main thread for 2,000ms-4,000ms total, causing all incoming HTTP requests to queue up and experience multi-second latency spikes.

### 2.3 Isolation Architecture Evaluation

| Criterion | Option A: `worker_threads.Worker` | Option B: `child_process.fork` (Recommended) |
|---|---|---|
| **Event-Loop Isolation** | 100% isolated thread with separate V8 event loop | 100% isolated OS process with separate V8 runtime |
| **Error / Crash Isolation** | Partial: Uncaught native exception or V8 crash may terminate process | Complete: Child crash cannot take down the parent HTTP server |
| **Auto-Restart Resilience** | Can terminate and recreate Worker thread | Simple parent-child lifecycle (`exit` event triggers auto-restart) |
| **Memory Footprint Overhead** | Low (~10-15 MB thread overhead) | Modest (~25-35 MB Node process overhead) |
| **SQLite Concurrency** | Supported: Worker opens separate `DatabaseSync` connection with WAL mode | Supported: Worker opens separate `DatabaseSync` connection with WAL mode |
| **IPC Communication** | `MessagePort` / `postMessage` (structured clone) | `process.send()` / `process.on('message')` (JSON IPC) |
| **Debugging & Tooling** | Requires thread-aware inspector | Standard independent Node process with PID |

**Assessment**: `child_process.fork` provides superior resilience for production Docker containers, guaranteeing that unexpected crashes in upstream scraping/GTFS parsing cannot disrupt web clients. A modular `WorkerBridge` interface should abstract the transport so either backend (`child_process.fork` or `worker_threads.Worker`) can be selected cleanly via configuration.

---

## 3. Design Recommendations & Target Architecture

### 3.1 Architecture Overview

```
+-------------------------------------------------------------------------+
|                         EXPRESS HTTP WEB SERVER                         |
|                               (server.js)                               |
|                                                                         |
|  - Instant Startup (<50ms): app.listen() called immediately             |
|  - Serves: /, static assets, /api/lines (warm static catalog)           |
|  - In-Memory Caches: warm flightRecorder fleet, cached journalism       |
|    reports, instant stop search                                         |
|  - Zero background pollers, zero heavy batch aggregations               |
+------------------------------------+------------------------------------+
                                     |
                       IPC Channel (process.send / on)
                                     |
+------------------------------------+------------------------------------+
|                   BACKGROUND INGESTION & ANALYTICS                      |
|                 WORKER PROCESS (src/workers/ingestionWorker.js)         |
|                                                                         |
|  - Autonomous Ingestion Daemon (12 pollers: AMB, Mataro, Mou-te, Renfe) |
|  - Exclusive SQLite write ownership (historyDb.js writes & pruning)     |
|  - Periodic 30-min Journalism Report Generation (24h, 48h, 168h)        |
|  - Daily 3-Day Route Snapshot Maintenance (routeCacheService.js)        |
|  - Automatic Error Isolation & Supervisor Auto-Restart                  |
+-------------------------------------------------------------------------+
```

### 3.2 State Synchronization & IPC Protocol
The communication between the HTTP Server and Ingestion Worker will use typed IPC messages:

1. **`WORKER_READY`** (`Worker -> Master`):
   Sent when the worker has booted, connected to SQLite, and initialized pollers.
   *Payload*: `{ timestamp, pid, version }`
2. **`FLEET_SNAPSHOT` / `FLEET_UPDATE`** (`Worker -> Master`):
   Sent after vehicle polling runs (throttled at 1-2s intervals) containing active standardized vehicles.
   *Payload*: `{ timestamp, vehicles: [...] }`
   *Master Action*: `flightRecorder.syncFleetFromWorker(vehicles)` updates the HTTP process Map in <0.05ms without database reads.
3. **`REPORT_CACHE_UPDATE`** (`Worker -> Master`):
   Sent whenever the worker finishes generating a 24h, 48h, or 168h report.
   *Payload*: `{ timeframeHours, report, generatedAt }`
   *Master Action*: `reportCacheService.updateMemoryCache(timeframeHours, report)` updates the in-memory cache instantly.
4. **`DISRUPTIONS_UPDATE`** (`Worker -> Master`):
   Sent when service alerts or disruptions change.
   *Payload*: `{ disruptions: [...] }`
5. **`PING` / `PONG`** (Heartbeat, bidirectional):
   Master pings worker every 15s; if no response within 30s, master treats worker as hung and triggers a graceful restart.
6. **`GENERATE_REPORT_CMD`** (`Master -> Worker`):
   Allows on-demand report recalculation triggered by admin or cold-cache fallback without blocking the HTTP server.
7. **`SHUTDOWN`** (`Master -> Worker`):
   Instructs worker to stop timers, flush SQLite WAL checkpoints, close connections, and exit cleanly.

### 3.3 Instant Startup (<50ms) Optimization Strategy
1. **Lazy / Non-Blocking Module Loading in HTTP Process**:
   - Refactor `src/maresmeTracker.js` and `src/corridorTracker.js` so that huge JSON (`maresme_cache.json`) and text files (`calendar_dates.txt`) are not loaded synchronously in constructors during `require()`.
   - Implement a lightweight, pre-compiled static summary file (`data/cache/lines_summary.json`, ~40 KB) that `TrackerRegistry.getAllLines()` reads immediately on boot. This allows `GET /api/lines` to respond in <10ms on a cold container start.
2. **Immediate `app.listen()`**:
   - `server.js` starts listening on `PORT` immediately upon launch.
   - `WorkerBridge.start()` is spawned asynchronously in the background. The HTTP server is ready to accept traffic while the worker completes its catalog warm-up.

### 3.4 Error Isolation, Auto-Restart & Graceful Shutdown
- **Worker Crash Handling**:
  `WorkerBridge` in `server.js` listens to child `exit` and `error` events. If the worker exits unexpectedly (code != 0), `WorkerBridge` logs the event, uses exponential backoff (1s, 2s, 4s, capped at 15s), and forks a new worker process.
- **Graceful Shutdown**:
  When `SIGINT` / `SIGTERM` is received by the main process:
  1. Master sends `SHUTDOWN` IPC message to worker.
  2. Worker clears all 12 `setInterval` timers, runs `PRAGMA wal_checkpoint(TRUNCATE)`, closes SQLite handle, and calls `process.exit(0)`.
  3. Master closes Express HTTP listener, waits for child exit (with a 3-second fallback `kill`), and exits cleanly.

---

## 4. Affected Files & Interfaces

| File Path | Role | Required Modifications |
|---|---|---|
| `server.js` | Main HTTP Server Entry Point | Remove direct `ingestionDaemon.start()` and blocking tracker initializations. Integrate `WorkerBridge` for IPC communication and auto-restart. Call `app.listen()` immediately. |
| `src/workers/ingestionWorker.js` | Standalone Worker Entry Point (New) | New dedicated background worker script. Initializes `ingestionDaemon`, `historyDb`, `reportCacheService`, and handles IPC message dispatching. |
| `src/core/WorkerBridge.js` | Worker Lifecycle & IPC Manager (New) | Manages `child_process.fork` / `worker_threads.Worker`, auto-restart on crash, message passing, fleet synchronization, and graceful shutdown. |
| `src/ingestionDaemon.js` | Polling & Ingestion Scheduler | Update to execute within the worker context. Send IPC events (`FLEET_UPDATE`, `REPORT_CACHE_UPDATE`) instead of relying on main-thread shared memory. |
| `src/flightRecorder.js` | Telemetry State & Dead-Reckoning | Add `syncFleetFromWorker(vehicles)` method for instant zero-copy in-memory cache hydration in the HTTP server process. |
| `src/reportCacheService.js` | Analytics Report Cache | In HTTP process: read exclusively from in-memory cache and pre-generated disk files without blocking SQLite queries. In Worker: generate reports and notify master via IPC. |
| `src/historyDb.js` | SQLite Storage & Analytics | Configure SQLite connection mode per process. Main process performs read-only queries if needed; Worker process performs all writes, pruning, and heavy aggregations. |
| `src/maresmeTracker.js` | Moventis Provider Tracker | Defer heavy 73MB JSON file reading from constructor to asynchronous / on-demand load. |
| `src/corridorTracker.js` | C-10 Provider Tracker | Defer heavy 31.7MB `calendar_dates.txt` file reading from constructor to asynchronous / on-demand load. |
| `src/core/TrackerRegistry.js` | Provider Catalog & Resolution | Provide fast warm-path catalog loading via static summary index so `/api/lines` responds in <10ms on cold start. |

---

## 5. Caveats
- **SQLite Concurrency with `node:sqlite`**: `node:sqlite` `DatabaseSync` in WAL mode supports multiple read connections across processes while a single process holds write locks. The worker process should be designated as the sole writer to prevent `SQLITE_BUSY` database lock contention.
- **External Upstream APIs**: Upstream providers (AMB Mobilitat, Mou-te, Avanza SIRI) are subject to external network latency and rate limits. All poller requests must maintain existing timeout guards (5000ms) and retry protections.
- **Test Compatibility**: Existing test suites (`test/verification_test.js`, `test/m3_smoke_test.js`, `test/e2e_flight_recorder_test.js`) import modules directly; module refactoring must preserve backwards-compatible synchronous/asynchronous exports.

---

## 6. Conclusion
The current architecture tightly couples heavy background ingestion, 50+ MB synchronous file parsing, and CPU-intensive SQLite aggregations to the main Express HTTP thread, causing severe startup latency and periodic request starvation.

Isolating `ingestionDaemon.js`, SQLite batch aggregations (`reportCacheService.js`), and periodic syncs into a dedicated background worker via `child_process.fork` (abstracted by a `WorkerBridge`), coupled with eliminating synchronous 73MB/31.7MB file reads on `require()`, directly satisfies all project requirements:
1. **Instant Startup (<100ms)**: Express starts listening immediately on boot and serves `/api/lines` in <10ms from local snapshots.
2. **Zero Event-Loop Starvation**: All 12 polling timers and heavy 24h/48h/168h delay reports execute strictly in the isolated background worker.
3. **Sub-Millisecond Shared State**: Telemetry and journalism reports are synchronized to the HTTP process via lightweight IPC message passing and warm in-memory Maps.
4. **Resilient Error Isolation & Auto-Restart**: Worker crashes are automatically caught and restarted by the parent supervisor without dropping HTTP connections.

---

## 7. Verification Method

To independently verify these findings and validate future implementations:

1. **Syntax Check**:
   ```powershell
   node test/syntax_check.js
   ```
   *Expected Result*: 0 syntax errors across all JavaScript files.

2. **Core Verification Suite**:
   ```powershell
   node test/verification_test.js
   ```
   *Expected Result*: All 6 verification checks and 483 Mataro timetable assertions pass 100%.

3. **Multi-Provider & M3 Smoke Test**:
   ```powershell
   node test/m3_smoke_test.js
   ```
   *Expected Result*: All endpoint tests pass (vehicles, departures, target-eta, journalism, rankings, CSV export).

4. **Startup Responsiveness Benchmark**:
   ```powershell
   node test/verification_test.js
   ```