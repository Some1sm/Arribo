# Project: Node.js Background Ingestion & SQLite Analytics Worker Isolation

## Architecture
The system isolates all heavy I/O, network polling, GTFS ingestion, and heavy SQLite analytics into a dedicated background worker process/thread, keeping the Express HTTP web server lean, non-blocking, and capable of instant boot (<100ms) and sub-millisecond in-memory cached responses.

```
+-------------------------------------------------------------------------+
|                         EXPRESS HTTP WEB SERVER                         |
|                               (server.js)                               |
|                                                                         |
|  - Instant Startup (<50ms): app.listen() called immediately on boot     |
|  - Serves: /, static assets, /api/lines from warm local snapshots       |
|  - In-Memory Caches: flightRecorder fleet, cached journalism reports,    |
|    instant stop search                                                  |
|  - Zero background pollers, zero heavy batch aggregations               |
+------------------------------------+------------------------------------+
                                     |
                       IPC Channel (process.send / on)
                                     |
+------------------------------------+------------------------------------+
|                   BACKGROUND INGESTION & ANALYTICS                      |
|            WORKER PROCESS (src/workers/ingestionWorker.js)              |
|                                                                         |
|  - Autonomous Ingestion Daemon (12 pollers: AMB, Mataro, Mou-te, Renfe) |
|  - Exclusive SQLite write ownership (historyDb.js writes & pruning)     |
|  - Periodic 30-min Journalism Report Generation (24h, 48h, 168h)        |
|  - Daily 3-Day Route Snapshot Maintenance (routeCacheService.js)        |
|  - Automatic Error Isolation & Supervisor Auto-Restart                  |
+-------------------------------------------------------------------------+
```

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Worker Lifecycle & IPC Bridge (`WorkerBridge.js`) | Supervisor managing child process / worker thread, message dispatching, health checks, auto-restart on crash with exponential backoff, and graceful shutdown. | M1 | ORIGINAL_REQUEST §R1, §R3 |
| F2 | Standalone Ingestion Worker (`ingestionWorker.js`) | Dedicated worker script hosting `ingestionDaemon`, 12 polling timers, periodic batch report generation, and sending typed IPC updates. | M1 | ORIGINAL_REQUEST §R1 |
| F3 | Shared State & Cache IPC Synchronization | Typed events (`FLEET_UPDATE`, `REPORT_CACHE_UPDATE`, `DISRUPTIONS_UPDATE`) hydrating `flightRecorder` and `reportCacheService` in-memory Maps in <0.1ms. | M1 | ORIGINAL_REQUEST §R3 |
| F4 | SQLite Concurrency & Busy Timeout Hardening | `PRAGMA busy_timeout = 5000;`, WAL mode enforcement, and direct timestamp indexing (`idx_delay_timestamp`) for 3x faster time-window queries without lock contention. | M2 | ORIGINAL_REQUEST §R1 |
| F5 | Heavy Analytics Non-Blocking Execution | Offload 24h, 48h, 168h journalism reports to worker; ensure HTTP server never synchronously blocks on SQLite calculations during request cycles. | M2 | ORIGINAL_REQUEST §R1, §R3 |
| F6 | Elimination of Startup Heavy Synchronous File Reads | Defer / lazy-load 73MB `maresme_cache.json` and 31.7MB `calendar_dates.txt` during module import. | M3 | ORIGINAL_REQUEST §R2 |
| F7 | Warm Local Snapshot Catalog & Instant Boot | Serve `GET /api/lines` from warm local snapshots in <50ms without awaiting tracker remote initializations; `app.listen()` immediately on boot (<100ms). | M3 | ORIGINAL_REQUEST §R2 |
| F8 | Automated Startup Benchmark & Regression Test Suite | `test/startup_benchmark.js` verifying <100ms startup, <50ms `/api/lines`, <500ms `/`, concurrent load stability, and 100% pass on all existing test suites. | M4 | ORIGINAL_REQUEST §Acceptance Criteria |
| F9 | Final Milestone: Challenger Stress & Forensic Integrity Audit | Adversarial verification under heavy concurrent load, worker crash recovery tests, and forensic integrity audit. | M5 | ORIGINAL_REQUEST §Acceptance Criteria |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Worker Architecture & IPC Bridge | `src/core/WorkerBridge.js`, `src/workers/ingestionWorker.js`, IPC protocol integration in `ingestionDaemon.js`, `flightRecorder.js`, and `reportCacheService.js` | none | DONE |
| M2 | SQLite Concurrency & Heavy Analytics Isolation | `src/historyDb.js` PRAGMA busy_timeout, timestamp indexes, exclusive worker write ownership, non-blocking HTTP analytics | M1 | DONE |
| M3 | Instant Startup & Warm Snapshot Catalog | Lazy module loading in `maresmeTracker.js` & `corridorTracker.js`, warm snapshot loader for `GET /api/lines`, instant `server.js` boot | M1 | DONE |
| M4 | E2E Testing Suite & Startup Benchmark | Implement `test/startup_benchmark.js`, integrate with `test/verification_test.js`, verify `test/syntax_check.js` & `test/m3_smoke_test.js` | M2, M3 | DONE |
| M5 | Final Milestone: Challenger & Forensic Audit | Stress & adversarial testing under load, crash recovery, forensic integrity audit | M4 | IN_PROGRESS |


## Interface Contracts

### IPC Message Protocol (`src/core/WorkerBridge.js` ↔ `src/workers/ingestionWorker.js`)
- **`WORKER_READY`** (`Worker -> Master`):
  - Payload: `{ timestamp: number, pid: number, version: string }`
- **`FLEET_UPDATE`** (`Worker -> Master`):
  - Payload: `{ timestamp: number, vehicles: Array<StandardizedVehicle> }`
  - Master Handler: `flightRecorder.syncFleetFromWorker(vehicles)` (in-memory Map update, <0.05ms)
- **`REPORT_CACHE_UPDATE`** (`Worker -> Master`):
  - Payload: `{ timeframeHours: number, report: Object, generatedAt: number }`
  - Master Handler: `reportCacheService.updateMemoryCache(timeframeHours, report)` (in-memory Map update, <0.05ms)
- **`DISRUPTIONS_UPDATE`** (`Worker -> Master`):
  - Payload: `{ timestamp: number, disruptions: Array<Object> }`
- **`PING` / `PONG`** (Heartbeat):
  - Master sends `PING` every 15s; Worker responds `PONG`. If no response in 30s, supervisor restarts worker.
- **`SHUTDOWN`** (`Master -> Worker`):
  - Worker flushes WAL checkpoint (`PRAGMA wal_checkpoint(TRUNCATE)`), stops timers, closes DB, and exits with code 0.

### Web Server Endpoints Performance Contract
- `GET /`: Responds in `< 500ms` on cold container start (target `< 100ms`).
- `GET /api/lines`: Responds in `< 50ms` on cold container start from warm snapshot (target `< 10ms`).
- `GET /api/vehicles` & `GET /api/fleet/live`: Responds in `< 10ms` from in-memory `flightRecorder` Map.
- `GET /api/analytics/journalism` & `GET /api/retards/ranking`: Responds in `< 10ms` from in-memory `reportCacheService` Map.
- Background worker CPU/IO spikes must cause `0ms` event-loop starvation on the HTTP server.

## Code Layout
- `server.js`: Web server entrypoint, Express routes, static serving, `WorkerBridge` initialization.
- `src/core/WorkerBridge.js`: Worker process/thread supervisor, IPC management, health check, auto-restart.
- `src/workers/ingestionWorker.js`: Dedicated background worker entrypoint.
- `src/ingestionDaemon.js`: Background polling timers and scheduled jobs.
- `src/flightRecorder.js`: In-memory vehicle telemetry cache and dead-reckoning.
- `src/reportCacheService.js`: Pre-computed journalism reports and in-memory cache.
- `src/historyDb.js`: SQLite database, WAL pragmas, busy timeout, analytics queries.
- `src/maresmeTracker.js`: Moventis tracker (with non-blocking / lazy data loading).
- `src/corridorTracker.js`: C-10 tracker (with non-blocking / lazy calendar loading).
- `test/startup_benchmark.js`: Automated startup latency and concurrent load benchmark.
- `test/syntax_check.js`: Syntax verification across all project files.
- `test/verification_test.js`: Core domain verification suite.
- `test/m3_smoke_test.js`: Multi-provider end-to-end API test suite.

