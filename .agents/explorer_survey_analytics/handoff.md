# Handoff Report — SQLite Analytics, Database Architecture & Concurrency Investigation

## 1. Observation

### 1.1 Database Files & Storage Overview
The application utilizes two native SQLite databases via Node.js built-in `node:sqlite` (`DatabaseSync`):

| Database File | File Size | WAL / SHM Files | Primary Tables | Usage Scope | Read/Write Pattern |
|---|---|---|---|---|---|
| `data/transit_history.db` | ~24.4 MB | `transit_history.db-wal` (~1.0 MB)<br>`transit_history.db-shm` (32 KB) | `vehicle_snapshots`<br>`delay_logs`<br>`hourly_line_stats` | Delay logging, GPS breadcrumbs, aggregated journalism analytics | **High-frequency write stream + periodic heavy batch read/aggregation** |
| `data/shapes.db` | ~70.8 MB | None (direct read) | `shapes` | GTFS road geometry polylines across all Catalonia transit routes | **Static read-only** (written only during GTFS catalog re-indexing in `cataloniaIndexer.js`) |

---

### 1.2 Table Schemas, Indexes & Configuration

#### A. Database Connection & Pragmas (`src/historyDb.js`, lines 37–45)
```javascript
this.db = new DatabaseSync(this.dbPath);
this.db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA cache_size = -2048;
  PRAGMA wal_autocheckpoint = 200;
  PRAGMA temp_store = MEMORY;
  PRAGMA auto_vacuum = INCREMENTAL;
`);
```
* **Observation**: `PRAGMA busy_timeout` is **NOT set** (defaults to 0ms).
* **Observation**: `node:sqlite`'s `DatabaseSync` executes all queries synchronously in C++ bindings on the executing thread.

#### B. Tables in `data/transit_history.db` (`src/historyDb.js`, lines 46–99)
1. **`vehicle_snapshots`** (~4,541 rows in test database):
   - Columns: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `vehicle_id TEXT NOT NULL`, `line_id TEXT NOT NULL`, `line_code TEXT NOT NULL`, `agency TEXT`, `lat REAL NOT NULL`, `lon REAL NOT NULL`, `speed_kmh REAL DEFAULT 0`, `bearing REAL DEFAULT 0`, `delay_mins INTEGER DEFAULT 0`, `is_realtime INTEGER DEFAULT 1`, `status TEXT DEFAULT 'active'`, `timestamp INTEGER NOT NULL`
   - Indexes:
     * `idx_veh_time` on `vehicle_snapshots(vehicle_id, timestamp)`
     * `idx_line_time` on `vehicle_snapshots(line_code, timestamp)`
2. **`delay_logs`** (~158,148 rows in test database):
   - Columns: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `line_id TEXT NOT NULL`, `line_code TEXT NOT NULL`, `agency TEXT`, `stop_id TEXT`, `stop_name TEXT`, `delay_mins INTEGER DEFAULT 0`, `scheduled_time TEXT`, `actual_time TEXT`, `is_realtime INTEGER DEFAULT 1`, `is_delayed INTEGER DEFAULT 0`, `timestamp INTEGER NOT NULL`
   - Indexes:
     * `idx_delay_line` on `delay_logs(line_code, timestamp)`
     * `idx_delay_stop` on `delay_logs(stop_id, timestamp)`
     * *(Missing: Direct index on `delay_logs(timestamp)`)*
3. **`hourly_line_stats`**:
   - Columns: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `line_code TEXT NOT NULL`, `agency TEXT`, `date_hour TEXT NOT NULL`, `sample_count INTEGER DEFAULT 0`, `avg_delay_mins REAL DEFAULT 0`, `max_delay_mins INTEGER DEFAULT 0`, `on_time_count INTEGER DEFAULT 0`, `late_count INTEGER DEFAULT 0`, `timestamp INTEGER NOT NULL`, `UNIQUE(line_code, date_hour)`
   - Indexes:
     * `idx_hourly_stats` on `hourly_line_stats(line_code, date_hour)`
4. **`shapes.db` Table**:
   - `shapes (shape_id TEXT PRIMARY KEY, coords TEXT)` (`src/cataloniaIndexer.js:309`)

---

### 1.3 Heavy Analytical Queries & Execution Trace

| Query / Operation | Source File & Function | Invocation Trigger & Frequency | SQLite Execution Plan & Query Characteristics | Measured Execution Time (158k rows) |
|---|---|---|---|---|
| **Batch Journalism Generation (24h, 48h, 168h)** | `src/reportCacheService.js`<br>`generateAllReports()` | Called every 30m by `ingestionDaemon.js:95`<br>Called at startup (3s delay) by `ingestionDaemon.js:94` | Runs 4 heavy aggregation queries across 158k+ rows for 3 distinct timeframes (24h, 48h, 168h/7d) sequentially, plus string filtering, JSON serialization, and disk write. | **3,901.29 ms (~3.9s)** (100% synchronous thread block) |
| **Journalism Report (24h)** | `src/historyDb.js`<br>`getJournalismReport(24)` | Called by `reportCacheService.js:147` | 1) `summaryStmt` (42.6ms)<br>2) `delayedStmt` (196.2ms, group by `line_code`, 1,201 groups)<br>3) `agencyStmt` (62.3ms, group by `agency`)<br>4) `worstStopsStmt` (84.7ms, group by 3 columns, 500 rows) | **1,125.29 ms** (unindexed)<br>**375.92 ms** (with timestamp index) |
| **Journalism Report (48h)** | `src/historyDb.js`<br>`getJournalismReport(48)` | Called by `reportCacheService.js:147` | Scans 48h window across 146,896 arrival logs | **917.53 ms** |
| **Journalism Report (168h / 7d)** | `src/historyDb.js`<br>`getJournalismReport(168)` | Called by `reportCacheService.js:147` | Scans entire weekly history table (157,736 rows) | **983.45 ms** |
| **Hourly Rollup Aggregation** | `src/historyDb.js`<br>`aggregateHourlyStats(48)` | Called hourly & at startup by `pruneOldRecords()` | `INSERT INTO hourly_line_stats ... SELECT ... GROUP BY line_code, agency, strftime(...) ON CONFLICT DO UPDATE` | **380.94 ms** |
| **CSV History Export (48h)** | `src/historyDb.js`<br>`exportDelayLogsCsv(48)` | Called on-demand via `GET /api/analytics/export/csv` | `SELECT datetime(...), line_code, ... FROM delay_logs WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT 50000` | **382.52 ms** (4.2 MB CSV) |
| **Line Delay Stats (24h)** | `src/historyDb.js`<br>`getLineDelayStats('C-10', 24)` | Called on-demand via `GET /api/line/:lineId/stats` | `SELECT COUNT(*), AVG(delay_mins) ... FROM delay_logs WHERE (UPPER(line_code) = ? OR ...) AND timestamp >= ?` | **233.10 ms** (unindexed) |
| **Disk Report Cache Load** | `src/reportCacheService.js`<br>`loadLatestFromDisk()` | Called on module `require()` / server boot (`init()`) | Reads newest `journalism_report_{24,48,168}h_*.json` from `data/reports/` into memory Map. | **10.83 ms** for all 3 timeframes |
| **Memory Cache Query** | `src/reportCacheService.js`<br>`getLatestReport(hours)` | Called on HTTP `GET /api/analytics/journalism` and `GET /api/retards/ranking` | Pure in-memory Map lookup (`cachedReports.get(String(h))`) | **<0.1 ms** (instant) |

---

## 2. Logic Chain

### 2.1 The Event-Loop Starvation Mechanism
1. In `src/ingestionDaemon.js` (lines 94–95), `generateJournalismReport()` is invoked 3 seconds after startup and on a recurring 30-minute interval (`setInterval`).
2. `generateJournalismReport()` calls `reportCacheService.generateAllReports()`, which sequentially computes reports for 24h, 48h, and 168h.
3. Because `node:sqlite` `DatabaseSync` is purely synchronous, executing all 3 reports takes **3,901 ms (3.9 seconds)** of uninterrupted, blocking CPU and disk I/O time on the executing thread.
4. When executed on the main Express HTTP process:
   - The Node.js single-threaded event loop is completely starved.
   - Incoming TCP connections are queued in the OS socket backlog.
   - HTTP requests for static assets, `/`, or `/api/lines` hang for up to 4,000ms until the batch queries complete.
5. In addition, when `ingestionDaemon.js` starts, it triggers `historyDb.pruneOldRecords()` at 1,000ms and `generateJournalismReport()` at 3,000ms. If the server is booting up, the main thread experiences severe stuttering and fails the `<50ms` startup latency requirement.

### 2.2 Cold-Start HTTP Fallback Hazard
1. In `src/reportCacheService.js` (lines 200–212), `getLatestReport(hours)` checks `this.cachedReports.get(String(canonicalHours))`.
2. If the cache is empty (e.g. cold container boot before the background worker creates reports or on an empty deployment), line 211 falls back to `await this.generateAndSaveReport(canonicalHours, catalog)`.
3. This triggers a synchronous 1.1-second SQLite calculation on the HTTP request handler thread, delaying the client response and blocking all concurrent web requests.

### 2.3 SQLite Concurrency & Lock Contention in Multi-Process / Worker Architecture
1. In SQLite Write-Ahead Logging (WAL) mode:
   - Multiple readers can read concurrently with writers without blocking.
   - However, SQLite strictly permits **only one writer at a time**.
   - When the worker performs writes (`recordVehicleSnapshot`, `recordDelayLog`, `aggregateHourlyStats`, or `pruneOldRecords`), SQLite acquires write locks (`RESERVED`/`EXCLUSIVE`).
2. Currently, `historyDb.js` does NOT configure `PRAGMA busy_timeout`.
3. In `node:sqlite`, if another thread/process attempts to write, checkpoint, or execute a DDL operation while a write lock is held, SQLite immediately throws `SQLITE_BUSY: database is locked` with 0 retry delay.
4. By configuring `PRAGMA busy_timeout = 5000;`, SQLite will automatically wait and retry for up to 5,000ms, completely resolving lock contention between concurrent worker tasks.

### 2.4 Sub-Millisecond Shared State via Pre-Computed Reports
1. Benchmarks prove that reading all 3 pre-generated report files (24h, 48h, 168h) from disk takes only **10.83 ms** during process boot.
2. Once loaded in `reportCacheService.cachedReports` (JavaScript Map), serving requests via `/api/analytics/journalism` or `/api/retards/ranking` executes in **<0.1 ms** with zero database access.
3. Therefore, offloading batch generation to the background worker and having the web server read pre-computed JSON snapshots/reports from disk (or via worker IPC updates) provides instant startup (<50ms) and sub-millisecond API responses under full load.

---

## 3. Caveats

1. **Memory Growth of Pre-generated Reports**: Each journalism report JSON file is ~744 KB on disk and in memory. Maintaining 3 timeframes in memory requires ~2.2 MB RAM, which is completely negligible in Node.js. Retention pruning (keeping max 2 files per timeframe) keeps disk usage strictly under 5 MB.
2. **First Boot Without Historical Data**: On a completely new installation where no files exist in `data/reports/`, `reportCacheService` must provide an immediate fallback default envelope rather than blocking on SQLite.
3. **OS-Level WAL File Locking**: On Windows and Linux containers, WAL shared-memory (`.db-shm`) requires shared filesystem access if multiple OS processes open the same database file. Using `worker_threads` (same process, separate V8 isolate) avoids cross-process OS locking issues entirely.

---

## 4. Conclusion & Architectural Recommendations

### Recommendation 1: Isolate All Database Writes & Heavy Analytics into Background Worker
* **Move to Background Worker**:
  - `ingestionDaemon.js` (all 8 API polling loops).
  - All write operations: `historyDb.recordVehicleSnapshot`, `historyDb.recordDelayLog`.
  - Batch analytics: `reportCacheService.generateAllReports()` (every 30m).
  - Periodic maintenance: `historyDb.pruneOldRecords()` & `historyDb.aggregateHourlyStats()` (every 1h).
  - Daily route snapshots: `routeCacheService.takeDailySnapshot()` (every 24h).
* **Main Express HTTP Process**:
  - Operates strictly in **read-only / cache-serving mode**.
  - Starts listening immediately on boot (<50ms).
  - Initializes `reportCacheService.loadLatestFromDisk()` synchronously at boot (~10ms).
  - Serves `/api/analytics/journalism` and `/api/retards/ranking` from in-memory Map in `<0.1ms`.
  - Never executes blocking batch aggregations during HTTP request cycles.

### Recommendation 2: Set Concurrency Pragmas and Timestamp Indexes
Update `src/historyDb.js` initialization with:
```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -2048;
PRAGMA wal_autocheckpoint = 200;
PRAGMA temp_store = MEMORY;
PRAGMA auto_vacuum = INCREMENTAL;

-- Add direct timestamp index for fast time-window analytics
CREATE INDEX IF NOT EXISTS idx_delay_timestamp ON delay_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_delay_time_line ON delay_logs(timestamp, line_code);
```

### Recommendation 3: Inter-Process / Worker Synchronization Protocol
* When the background worker generates fresh reports (`journalism_report_*.json`), it writes them atomically to `data/reports/`.
* The worker sends a lightweight IPC message (`{ type: 'REPORTS_UPDATED', timestamp: Date.now() }`) to the main HTTP thread.
* The main HTTP thread calls `reportCacheService.loadLatestFromDisk()` to refresh its in-memory Map in 10ms without restarting the server or dropping active user connections.

---

## 5. Verification Method

To independently verify these findings, run the following commands in `h:\Coding\C10Data`:

### 5.1 Verification Test Suite
```powershell
node test/syntax_check.js
node test/verification_test.js
node test/e2e_flight_recorder_test.js
node test/m3_smoke_test.js
```

### 5.2 SQLite Query Benchmark Script
```powershell
node -e "
const historyDb = require('./src/historyDb');
const reportCacheService = require('./src/reportCacheService');

console.log('Testing Query Performance...');
let t0 = performance.now();
const stats = historyDb.getLineDelayStats('C-10', 24);
console.log('getLineDelayStats:', (performance.now() - t0).toFixed(2), 'ms');

t0 = performance.now();
const rep = historyDb.getJournalismReport(24);
console.log('getJournalismReport(24):', (performance.now() - t0).toFixed(2), 'ms');

t0 = performance.now();
reportCacheService.loadLatestFromDisk();
console.log('reportCacheService.loadLatestFromDisk:', (performance.now() - t0).toFixed(2), 'ms');
"
```

### 5.3 Invalidation Conditions
- If `reportCacheService.generateAllReports()` executes in `<10ms` in-thread (invalidated: it takes ~3.9s).
- If SQLite in WAL mode without `busy_timeout` handles concurrent multi-thread writes under stress without throwing `SQLITE_BUSY` (invalidated: default timeout is 0ms).
