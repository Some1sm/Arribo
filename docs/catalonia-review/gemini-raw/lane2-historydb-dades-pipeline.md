# Architecture Review: History DB, Ingestion & Observatori at Catalonia Scale

**Scope Evaluated:** Ingestion pipeline, SQLite persistence (`modernc.org/sqlite`), worker IPC, and analytics queries driving the "Dades"/Observatori tab (`app/historydb*.go`, `app/ingestion.go`, `app/worker.go`, `app/bridge.go`, `app/reportcache.go`, `app/incidentrun.go`, `app/anomalies.go`, `app/flightrecorder.go`).

---

## Baseline Telemetry & Catalonia Projections

| Metric | Today (Mataró Bus Urbà) | Projected (All Catalonia Multi-Modal) | Scaling Factor |
| :--- | :--- | :--- | :--- |
| **Active Fleet** | 15–25 buses (L1–L8, 155 stops) | 3,000–5,000 vehicles (TMB, AMB, Rodalies, FGC, TRAM, Interurbans) | **~200×** |
| **Poll Frequency** | 20 s vehicle loop ([app/ingestion.go:160](file:///home/some1sm/Coding/arribo/app/ingestion.go#L160)) | 15–30 s (avg 20 s) | **1×** |
| **`delay_logs` writes** | 1 row / veh / 20 s = ~57.6k rows/day ([app/ingestion.go:563](file:///home/some1sm/Coding/arribo/app/ingestion.go#L563)) | ~11.5M – 19.2M rows/day (at 4,000 peak vehicles, 16h) | **~250×** |
| **`vehicle_snapshots`** | 1 row / veh / 60 s = ~19.2k rows/day ([app/flightrecorder.go:49](file:///home/some1sm/Coding/arribo/app/flightrecorder.go#L49)) | ~3.8M – 6.4M rows/day (retained 6h: ~1.2M live rows) | **~200×** |
| **`stop_visits` writes** | ~25 visits / veh / hr = ~8k visits/day ([app/ingestion.go:183](file:///home/some1sm/Coding/arribo/app/ingestion.go#L183)) | ~1.6M – 2.5M visits/day (~48M–75M / month) | **~250×** |
| **Peak DB Write Rate** | ~1.5 INSERTs / sec | **~300 – 450 INSERTs / sec** | **~250×** |
| **Storage Ingestion** | ~10–15 MB / day | **~2.2 – 3.2 GB / day (~800 GB – 1.1 TB / year)** | **~220×** |
| **30-Day Retention DB Size** | ~350 MB (`transit_history.db`) | **~65 – 95 GB SQLite file** (uncompressed) | **~230×** |

---

## 1. Key Findings

### 1. Single-Worker Mutex & Single-Connection SQLite Bottleneck
* **Evidence:** [app/worker.go:211-224](file:///home/some1sm/Coding/arribo/app/worker.go#L211-L224), [app/historydb.go:398-406](file:///home/some1sm/Coding/arribo/app/historydb.go#L398-L406), [app/bridge.go:376-410](file:///home/some1sm/Coding/arribo/app/bridge.go#L376-L410).
* **Severity:** **BLOCKER**
* **Finding:** The worker runs on an event loop holding `w.mu.Lock()`. The SQLite database pool is hard-pinned to `db.SetMaxOpenConns(1)` with a single dedicated connection (`h.conn`). Every IPC analytical query (`getJournalismReport`, `getMonthlyReport`, `getDelayIncidents`) executes on this single worker while holding `w.mu.Lock()`. At Catalonia scale, a query scanning millions of rows takes 10–60+ seconds, during which **all SIRI vehicle polling, flight-recorder dead reckoning, and writes are completely frozen**, dropping telemetry and causing spurious GPS gap alarms.

### 2. OOM Crashes from Unbounded Heap Buffers under 128 MiB GOMEMLIMIT
* **Evidence:** [OPERATIONS.md:124](file:///home/some1sm/Coding/arribo/OPERATIONS.md#L124), [app/flightrecorder.go:34,258](file:///home/some1sm/Coding/arribo/app/flightrecorder.go#L34), [app/historydb_phantom.go:446](file:///home/some1sm/Coding/arribo/app/historydb_phantom.go#L446), [app/historydb_report.go:457-477](file:///home/some1sm/Coding/arribo/app/historydb_report.go#L457-L477).
* **Severity:** **BLOCKER**
* **Finding:** Production enforces `GOMEMLIMIT=128MiB` with a 400 MB container ceiling.
  * In-memory flight recorder (`f.vehicles`) stores 60 breadcrumbs per bus ([app/flightrecorder.go:57](file:///home/some1sm/Coding/arribo/app/flightrecorder.go#L57)). For 4,000 vehicles, this represents 240,000 heavy `*Obj` instances (~120–180 MB heap), exceeding `GOMEMLIMIT` without running a single query.
  * `findBackwardLegsDB` explicitly queries with `LIMIT 200000` ([app/historydb_phantom.go:446](file:///home/some1sm/Coding/arribo/app/historydb_phantom.go#L446)), instantiating up to 200k `*Obj` rows in Go memory.
  * `getJournalismReport` creates a 24-bucket hourly breakdown for *every stop* ([app/historydb_report.go:457-477](file:///home/some1sm/Coding/arribo/app/historydb_report.go#L457-L477)). Mataró has 155 stops; Catalonia has ~30,000+ stops. Allocating 30,000 × 24 = 720,000 objects in memory per report generation will trigger an instant Out-Of-Memory panic or `SIGKILL`.

### 3. Full-Table Scans on Raw Telemetry for Routine Reports
* **Evidence:** [app/historydb_monthly.go:45-128](file:///home/some1sm/Coding/arribo/app/historydb_monthly.go#L45-L128), [app/historydb_report.go:200-275](file:///home/some1sm/Coding/arribo/app/historydb_report.go#L200-L275), [app/reportcache.go:409-424](file:///home/some1sm/Coding/arribo/app/reportcache.go#L409-L424).
* **Severity:** **BLOCKER**
* **Finding:** `generateAllReports` runs every 30 minutes in the background, computing 24h, 48h, and 168h (7-day) reports sequentially ([app/reportcache.go:416](file:///home/some1sm/Coding/arribo/app/reportcache.go#L416)). None of these use pre-aggregated rollup tables; they issue full aggregate queries with window functions across raw `stop_visits` and `delay_logs` tables. Over a 7-day window at Catalonia scale (~100M rows), running 3 sequential full scans every 30 minutes in pure-Go SQLite will maintain 100% CPU utilization continuously.

### 4. Write Amplification & High-Frequency Unbuffered Single Inserts
* **Evidence:** [app/ingestion.go:346-578](file:///home/some1sm/Coding/arribo/app/ingestion.go#L346-L578), [app/historydb.go:975-994](file:///home/some1sm/Coding/arribo/app/historydb.go#L975-L994).
* **Severity:** **MAJOR**
* **Finding:** Every 20 seconds, `ingestBus` writes a new row to `delay_logs` for every bus with a plausible delay, even if the bus is stationary, delayed by the same amount, or between stops. At 4,000 vehicles, this generates ~300 unbuffered single-row `INSERT` statements per second across `delay_logs`, `vehicle_snapshots`, and `stop_visits`. In `modernc.org/sqlite`, executing 300 non-batched transactions per second will saturate SQLite's WAL coordinator.

### 5. Pure-Go UDFs Defeating Index Scans in Aggregations
* **Evidence:** [app/historydb.go:338-381](file:///home/some1sm/Coding/arribo/app/historydb.go#L338-L381), [app/historydb_monthly.go:155](file:///home/some1sm/Coding/arribo/app/historydb_monthly.go#L155), [app/historydb_phantom.go:536](file:///home/some1sm/Coding/arribo/app/historydb_phantom.go#L536).
* **Severity:** **MAJOR**
* **Finding:** Custom Go scalar functions (`madrid_hour`, `madrid_datetime`, `is_telemetry_anomaly`) are embedded in `WHERE` and `GROUP BY` clauses. SQLite cannot index expressions using non-deterministic Go UDFs without generated columns. Stepping through 50M rows invoking Go reflection callbacks per row via `modernc.org/sqlite` is 10–20× slower than native C SQLite or index-backed scans.

### 6. Hardcoded Single-City Scope and Missing Relational Dimensions
* **Evidence:** [app/historydb.go:102-128](file:///home/some1sm/Coding/arribo/app/historydb.go#L102-L128), [app/historydb.go:434-590](file:///home/some1sm/Coding/arribo/app/historydb.go#L434-L590).
* **Severity:** **MAJOR**
* **Finding:**
  * `mataroLineIDs` (lines 1–8) and `mataroScopeSQL` are hardcoded and appended to all history queries ([app/historydb.go:119,125](file:///home/some1sm/Coding/arribo/app/historydb.go#L119-L125)).
  * Line codes are non-unique across operators (e.g., Metro L1, Mataró Bus L1, TUS Sabadell L1). Tables lack `mode` (bus, metro, commuter rail, tram) and relational `agency_id`/`operator_id` keys.

### 7. O(N²) In-Memory GPS Gap Clustering
* **Evidence:** [app/historydb_gaps.go:108-137](file:///home/some1sm/Coding/arribo/app/historydb_gaps.go#L108-L137).
* **Severity:** **MINOR**
* **Finding:** `getGpsGapHotspots` loads all raw gap points for up to 30 days into memory and performs spatial clustering (`clusterPoints(..., 100)`) in Go. While fast for Mataró (~hundreds of gaps), clustering tens of thousands of gap coordinates across Catalonia in a single HTTP request will cause response timeouts.

---

## 2. Recommended Changes

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Ingestion Daemon (Go)                           │
│  SIRI / GTFS-RT Pollers ──► Vehicle Ingest Channel (Buffer 5s / 1000)  │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Batch Insert
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│               Storage Engine (TimescaleDB / ClickHouse)                │
│                                                                        │
│   Raw Telemetry: vehicle_snapshots (6h TTL), stop_visits (90d TTL)     │
│   Continuous Aggregates / Rollups (Hourly: line, stop, operator)        │
└───────────────────▲────────────────────────────────┬───────────────────┘
                    │ Read Pool                      │
┌───────────────────┴───────────────┐   ┌────────────┴───────────────────┐
│       Analytics Engine (Go)       │   │     HTTP Server / Dades UI     │
│  Fast Materialized Rollup Reads   │   │  Pre-calculated JSON / Stream  │
└───────────────────────────────────┘   └────────────────────────────────┘
```

### Priority 1: Replace Single SQLite Writer with Time-Series Storage (Effort: L)
* **Action:** Migrate away from a single-file SQLite database for Catalonia telemetry.
  * **Option A: PostgreSQL + TimescaleDB (Recommended):** Native hypertables partitioned by time (`1 day`), continuous aggregates (materialized rollups calculated on insert), native `zstd` column compression (90%+ space reduction, shrinking 1 TB/year to ~100 GB), and full concurrent read/write transactions.
  * **Option B: ClickHouse:** Extreme compression and speed for analytics, but requires micro-batching in Go (cannot do single-row inserts) and adds operational complexity.
  * *Trade-off verdict:* **SQLite is unviable at Catalonia scale** (~20M rows/day, 300+ writes/s, concurrent multi-month reporting). Even with cgo enabled and WAL mode, SQLite's single-writer architecture and locks during checkpoints (`PRAGMA wal_checkpoint(TRUNCATE)`, [app/historydb_maint.go:245](file:///home/some1sm/Coding/arribo/app/historydb_maint.go#L245)) make it a fatal bottleneck.

### Priority 2: Pre-Aggregated Incremental Rollups for Dades (Effort: M)
* **Action:** Rewrite the analytics pipeline to query exclusively pre-aggregated rollups:
  * Extend `hourly_line_visit_stats` ([app/historydb.go:509](file:///home/some1sm/Coding/arribo/app/historydb.go#L509)) to include `stop_id`, `agency_id`, and `mode`.
  * Compute rollups incrementally on stop flush ([app/ingestion.go:183](file:///home/some1sm/Coding/arribo/app/ingestion.go#L183)) or in a continuous 5-minute background job, rather than deferring to a monthly full scan.
  * Alter `monthlyReport` ([app/historydb_monthly.go:45](file:///home/some1sm/Coding/arribo/app/historydb_monthly.go#L45)) and `journalismReport` ([app/historydb_report.go:200](file:///home/some1sm/Coding/arribo/app/historydb_report.go#L200)) to sum pre-computed hourly visit buckets. Query cost drops from O(50,000,000) rows to O(720) hourly rows per line.

### Priority 3: Micro-Batch Ingestion & Write Decoupling (Effort: M)
* **Action:** Decouple ingestion pollers from DB writes using an in-memory ring buffer (channel of 10,000 capacity). A dedicated batch writer flushes with `COPY` or multi-value `INSERT INTO ... VALUES (...), (...)` every 2 seconds or 1,000 records.

### Priority 4: Normalized Multi-Modal Schema with Operator Partitioning (Effort: L)
* **Action:** Redesign the schema with composite routing keys:
  * Add `mode` (`bus_urban`, `bus_interurban`, `train_rodalies`, `train_fgc`, `metro`, `tram`).
  * Replace string `line_code` with composite `(agency_id, line_code, direction)`.
  * Partition data by `timestamp` (daily) and sub-partition by `agency_id` or `mode`.

### Priority 5: Eliminate In-Memory JSON Report Blobs (Effort: S)
* **Action:** Deprecate `generateAndSaveReport` pretty-printed JSON files ([app/reportcache.go:392](file:///home/some1sm/Coding/arribo/app/reportcache.go#L392)) and memory maps for network-wide stops. Serve endpoints via streaming HTTP responses (`io.Pipe` / NDJSON or gzip chunked transfers).

---

## 3. Quick-Win Optimizations (Beneficial for Mataró Immediately)

1. **Deduplicate `delay_logs` Ingestion ([app/ingestion.go:563-577](file:///home/some1sm/Coding/arribo/app/ingestion.go#L563-L577)):**
   * *Fix:* Only insert into `delay_logs` if `delay_mins` changed by ≥ 1 minute or the bus arrived at a new stop. Cuts Mataró write IOPS by ~60%.
2. **Materialize Madrid Hour on Write ([app/historydb.go:454,480](file:///home/some1sm/Coding/arribo/app/historydb.go#L454-L480)):**
   * *Fix:* Add an integer column `madrid_hour` populated at insert time (`dt.Hour()`). Replace `GROUP BY madrid_hour(timestamp)` with `GROUP BY madrid_hour`. Eliminates runtime Go UDF evaluations during SQL queries.
3. **Use Existing Rollup Table in `getMonthlyReport` ([app/historydb_monthly.go:71](file:///home/some1sm/Coding/arribo/app/historydb_monthly.go#L71)):**
   * *Fix:* Switch `getMonthlyReport` to aggregate from `hourly_line_visit_stats` ([app/historydb_maint.go:119](file:///home/some1sm/Coding/arribo/app/historydb_maint.go#L119)) instead of scanning raw `stop_visits`. Reduces monthly query execution time from ~400ms to <10ms.
4. **Stream CSV Exports ([app/historydb_monthly.go:353-361](file:///home/some1sm/Coding/arribo/app/historydb_monthly.go#L353-L361)):**
   * *Fix:* Stream CSV rows directly into `http.ResponseWriter` via chunked encoding instead of buffering 100,000 rows into a `strings.Builder`. Avoids 25+ MB heap spikes.

---

## 4. Open Questions & Risks

1. **Upstream Feed Heterogeneity & Ingestion Quotas:** Mataró uses Avanza SIRI-Lite. Catalonia integration requires connecting to Generalitat's iBus/AMB/ATM feeds, TMB OpenData, Renfe/Adif SIRI/GTFS-RT, and FGC APIs. Will ingestion run central polling or distributed workers?
2. **Stop Snap & Visit Detection on Rail/Metro:** `stop_visits` logic assumes road coordinate snapping (`within30` meters, [app/ingestion.go:489](file:///home/some1sm/Coding/arribo/app/ingestion.go#L489)). Rodalies and Metro trains move at 80–120 km/h where 20s polling intervals can miss a 30m station bounding radius entirely.
3. **Ghost Bus Pairing Complexity:** Pairing scheduled trips to real vehicles across thousands of trains/buses with shared identifiers will strain the in-memory route progress matcher (`schedlogic.go`).
