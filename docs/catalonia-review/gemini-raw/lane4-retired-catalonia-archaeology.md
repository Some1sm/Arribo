# Arribo! Architecture Review: Scaling to Catalonia-Wide Transit

## 1. Key Findings

1. **Hardcoded Mataró Scoping in SQL / HistoryDB** (`app/historydb.go:102-128`)
   - **Severity:** Blocker *(Verified in code)*
   - **Evidence:** `HistoryDB` explicitly defines `mataroScopeSQL = " AND (UPPER(line_code) IN ('L1',...'L8') AND line_id IN ('1',...'8','L1',...'L8'))"`. Functions like `appendMataroScope` inject this constraint into delay analytics, journalism reports, line rankings, and stop visits. Any non-Mataró line ingested into SQLite is silently excluded from Observatori calculations.

2. **Monolithic Single-World Lock (`World.mu`) Under High Concurrency** (`app/tracker.go:37-67`, `app/worker.go:37-56`)
   - **Severity:** Blocker *(Verified in code)*
   - **Evidence:** To emulate Node's single-threaded event loop, each `World` holds a coarse `sync.Mutex` (`w.mu`). Long-running JSON parsing, schedule interpolation, or bulk database serialization in `worker.go` locks the entire worker world. At a scale of 1,600+ lines, this lock contention will starve IPC response handling, causing bridge timeouts (`app/bridge.go:60`) on HTTP requests.

3. **`TrackerRegistry` and Line Resolver Hardcoded to Mataró L1–L8** (`app/registry.go:47-66`)
   - **Severity:** Blocker *(Verified in code)*
   - **Evidence:** `getTrackerForLine` strips `line-`, `linia-`, `mataro_` and validates against `^[1-8]$`. Any other line ID immediately returns `"No transit tracker registered for line"`. There is currently no multi-provider dispatching abstraction in the Go codebase.

4. **In-Memory Full-Fleet IPC Synchronization (`FLEET_UPDATE`)** (`app/ingestion.go:78-92`, `app/worker.go:420-435`, `app/flightrecorder.go:15-30`)
   - **Severity:** Major *(Verified in code)*
   - **Evidence:** Every 500 ms–20 s, `emitFleetUpdate()` serializes the entire active fleet via `jsonClone` and pushes it over IPC. For Mataró (~20 buses), heap impact is negligible (<100 KB). For Catalonia (4,000–8,000 concurrent vehicles across TMB, AMB, FGC, Rodalies, interurbans), cloning full fleet arrays every few seconds will cause massive memory allocation churn, breaching the Compose `GOMEMLIMIT=128MiB` limit (`compose.yaml:21`).

5. **Static In-Repo Schedule Loading vs. Multi-Agency GTFS Scale** (`app/schedules.go:27-45`, `CLAUDE.md:107-110`)
   - **Severity:** Major *(Verified in code)*
   - **Evidence:** Schedules are checked in as Git JSON files (`src/data/mataro_schedules.seasons.json`) and parsed into Go memory on boot. Scaling this model to all Catalonia operators will bloat container images and consume hundreds of megabytes of RAM before serving a single request.

6. **Punctuality & Stop-Visit Tracking Engine is Structurally Sound** (`app/ingestion.go:183-245`, `app/historydb.go:480-500`)
   - **Severity:** Minor / Positive Architecture Asset *(Verified in code)*
   - **Evidence:** The `stop_visits` model correctly measures punctuality per vehicle stop visit (one row per bus per stop, with signed passing-time comparison and operator trip agreement `tripAgrees`), solving raw poll dwell-time sampling bias. This logic is decoupled from Mataró specifics and can be generalized across operators.

---

## 2. Archaeology of the Retired Catalonia-Wide Platform

### 2.1 Upstream Data Sources Inventory

| Provider / Agency | Endpoint URL / Host | Auth Scheme | Poll Cadence / Strategy | Format | Output Data | Source Reference |
|---|---|---|---|---|---|---|
| **Generalitat Mou-te** | `https://mou-te.gencat.cat/MouteAPI/rest/` | Header `AT`: MD5(`mouteapi` + `Date.now().toString().slice(0,7)`) | On-demand cache (30s fresh / 120s stale); Ingestion polled in batches of 100 lines/30s | JSON | Stop arrival predictions (`sortides.sortida`), scheduled times, delays. **No GPS positions**. | `old-catalonia/src/mouteClient.js:5, 28-32, 176-198` |
| **AMB Mobilitat v2** | `https://api.ambmobilitat.cat/v2` | Header `x-api-key: ${AMB_API_KEY}` (hardcoded fallback `28EbLJt...`) | 10s–30s TTL on real-time; 7-day disk cache for 5,800-stop catalog | JSON | Bus positions (`/bus/vehicles`), stop countdowns (`/bus/stops/:id/realtimes`), Renfe station boards (`/gtfs/renfe/realtime/:id`). | `old-catalonia/src/core/realtime/ambStopRealtime.js:36, 97-125`, `old-catalonia/src/c10TelemetryExtractor.js:127-167` |
| **Moventis SAE** | `https://app.moventis.es/sae/api/posicion/linea/:id` | Header `Authorization: Basic YXBwbW92ZW50aXM6...` (`appmoventis:appmoventis`) | 5s cache TTL; single-flight mutex | JSON | Live GPS telemetry (lat, lon, speed, vehicle calca) for Empresa Casas / Moventis lines (e.g. line 502 = C-10). | `old-catalonia/src/moventisClient.js:279-325` |
| **Moventis Web API** | `https://www.moventis.es/api/json/` | Public web endpoints; standard browser `User-Agent` + `X-Requested-With` | 10s cache TTL on ETAs; 24h disk cache on schedules | JSON | Stop countdowns (`GetTiemposParada`), line trajectories (`GetTrayectos`), stop timetables (`GetParadas`). | `old-catalonia/src/moventisClient.js:15, 170, 203, 231` |
| **Sagalés Live Service** | `https://www.sagales.com/real-time-bus/:route/:dir` | Public AJAX; browser `User-Agent` | 12s cache TTL; permanent route topography cache | JSON | Active bus GPS entities (lat, lon, delay, destination), route stops, and encoded polyline. | `old-catalonia/src/sagalesTracker.js:118, 211-220` |
| **Rodalies (via AMB)** | `https://api.ambmobilitat.cat/v2/gtfs/renfe/` | AMB API Key (see above) | 15s cache TTL | JSON | Train station departure boards, track shape coordinates (`/shapes/:id`). Did **not** ingest direct Renfe GTFS-RT protobuf. | `old-catalonia/src/rodaliesTracker.js:68-98, 265, 286` |
| **ATM Static GTFS** | Local files: `data/atm_gtfs/*.txt` | N/A (Static files) | Indexed into `data/shapes.db` and JSON caches on startup | CSV / SQLite | 1,548 line geometries, stops, calendars, trip shapes. | `old-catalonia/src/cataloniaIndexer.js:84-105` |

### 2.2 What Went Wrong & Why the Scope Was Retired

A forensic analysis of the git commits and history documents reveals four structural failure modes:

1. **Fabricated Telemetry and Downstream Extrapolation**
   - *Problem:* When interurban lines (like C-10) crossed out of the AMB perimeter, AMB telemetry cut off abruptly. The platform attempted to "extrapolate" delays downstream (commit `4d24426`, `3b1774b`) and group consecutive stop arrival times into synthetic "bus chains" (commit `7f51132`, `00d9e23`).
   - *Consequence:* Passengers saw "phantom buses" on maps that were nowhere near physical reality, and vehicles jumped backward/forward across stops (commit `9029fdb`, `8cdc6aa`).
   - *Resolution:* Synthetic traffic modeling was removed in commit `22ba526` (`refactor(delays): remove all synthetic traffic delay modeling, relying 100% on genuine real-time provider data`).

2. **Rate Limits & API Exhaustion**
   - *Problem:* Polling 1,610 Catalonia lines sequentially over Mou-te REST APIs was impossible. An ingestion worker batching 100 lines per 30s cycle took >8 minutes just to complete one sweep (commit `38f3b10`).
   - *Consequence:* Upstream APIs returned 502 Bad Gateway and IP blocks, requiring emergency circuit breakers (commit `503eab5`) and log throttling (commit `d6e9dc9`, `c3981e1`).

3. **Memory/CPU Bloat & Container Crashes**
   - *Problem:* Loading uncompressed GTFS catalogs, 73 MB shape files, and 31.7 MB `calendar_dates.txt` into memory caused 2.1 GB V8 heap spikes (commit `e169ace`, `PROJECT.md:42`).
   - *Consequence:* Repeated OOM container aborts. Emergency fixes offloaded road shapes to SQLite (`shapes.db`, commit `04b0cd2`) and instituted aggressive GC compaction (`server.js:41-46`), but memory remained fragile.

4. **Observatori Data-Trust Breakdown**
   - *Problem:* Analytics treated raw 20-second GPS polls as "arrivals" (169,595 "trips" in 7 days was just sample noise; `DATA_TRUST_IMPLEMENTATION_PLAN.md:147`). Early runs were classified as on-time (`E7`), and provider error codes (like `-15`) were averaged as real delays (`E8`).
   - *Decision:* On 2026-08-31 (commit `d93a01f`), the maintainers radically cut scope to Mataró Bus Urbà to build a rigorous, methodology-first platform (`stop_visits`, strict GPS validation, no synthetic ghost logging) before scaling up again.

### 2.3 Reusable Pieces vs. Ideas to Avoid

- **Reusable Assets (Port to Go):**
  - **Mou-te HMAC-MD5 Auth:** Clean token generator logic (`old-catalonia/src/mouteClient.js:28-32`).
  - **Moventis SAE GPS Extractor:** Direct real-time telemetry endpoint for interurban corridors (`old-catalonia/src/moventisClient.js:279-325`).
  - **Sagalés Real-time Feeds:** Direct JSON feed parsing (`old-catalonia/src/sagalesTracker.js:200-230`).
  - **SQLite Road Shapes DB Pattern:** Storing heavy GTFS shapes in SQLite instead of memory (`old-catalonia/src/cataloniaIndexer.js:58-65`).
  - **AMB Stop Proximity Cache:** Resolving interurban stops to metropolitan codes (`old-catalonia/src/core/realtime/ambStopRealtime.js:70-94`).

- **Ideas to Avoid (Do Not Port):**
  - **Synthetic Bus Chaining:** Never synthesize vehicle positions by grouping stop ETA countdowns.
  - **Downstream Delay Extrapolation:** If a provider loses vehicle telemetry at municipal borders, mark the vehicle stale/unobserved; never project synthetic progress along roads.
  - **Sequential HTTP Polling of Line Catalogs:** Never loop through 1,500+ lines via request-time REST calls.
  - **In-Memory GTFS Parsing:** Do not parse CSVs/JSON into memory on application startup.

---

## 3. Recommended Changes

| Priority | Recommended Change | Description | Blast Radius | Effort |
|---|---|---|---|---|
| **P1** | **Multi-Provider Polymorphic Registry in Go** | Replace `app/registry.go` with an interface-driven provider registry (`TransitProvider` implementing `GetLineDetails`, `GetLiveVehicles`, `GetStopDepartures`). | `app/registry.go`, `app/server.go` | **M** |
| **P2** | **Decouple Ingestion from World Mutex** | Refactor `app/worker.go` and `app/ingestion.go` so network ingestion workers run concurrently via goroutines and channels, writing batches into SQLite WAL without holding `World.mu`. | `app/worker.go`, `app/ingestion.go`, `app/bridge.go` | **M** |
| **P3** | **Adopt GTFS-RT Protobuf / Push Feeds** | Replace REST stop polling with streaming GTFS-RT (FeedMessage: VehiclePositions & TripUpdates) from Generalitat Mou-te, Renfe, and TMB open data portals. | `app/ingestion.go`, new `app/gtfsrt.go` | **L** |
| **P4** | **SQLite-Backed Timetable Engine** | Migrate from static `mataro_schedules.seasons.json` to an on-disk SQLite database (`schedules.db`) containing indexed GTFS stop times across all Catalan operators. | `app/schedules.go`, `app/schedlogic.go`, `app/planner.go` | **L** |
| **P5** | **Generalize Observatori / Dades Tab** | Remove `mataroScopeSQL` from `app/historydb.go:119-128`. Update `public/js/observatori.js` filters to support operator grouping (Rodalies, TMB, AMB, Moventis, Sagalés). | `app/historydb.go`, `public/js/observatori.js` | **S** |

---

## 4. Quick-Win Optimizations

1. **Remove / Parameterize `mataroScopeSQL`** (`app/historydb.go:119-128`)
   - Change `appendMataroScope` to filter by an optional `operator` or `agency` query param instead of hardcoding `L1–L8`. This immediately allows multi-agency data storage in `stop_visits` without code rejection.
2. **Differential SSE Fleet Streaming** (`app/server.go:100-101`, `app/ingestion.go:78-92`)
   - Instead of broadcasting complete fleet arrays in `FLEET_UPDATE`, send bounding-box or line-filtered updates, or delta diffs (only vehicles whose positions/delays changed).
3. **SQLite Query Optimization for Incident Clustering** (`app/historydb_incidents.go:880-920`)
   - Pre-filter `stop_visits` and `delay_logs` using covering indexes (`(line_code, timestamp, delay_mins)`) to eliminate full table scans during 30-day Observatori queries.

---

## 5. Open Questions & Risks

1. **Upstream Feed Reliability & Authentication Longevity**
   - *Risk:* Mou-te's MD5 algorithm (`old-catalonia/src/mouteClient.js:28-32`) is an undocumented reverse-engineered secret that Generalitat could alter without notice. AMB API keys are public defaults subject to revocation.
   - *Question:* Should Arribo request formal institutional API access to Generalitat's DATEX II / GTFS-RT endpoints rather than relying on legacy client keys?
2. **Observatori Storage Growth under Full Catalonia Load**
   - *Risk:* 155 stops generate ~30,000 stop visits/week. 8,000 stops across Catalonia will generate 1.5M+ stop visits/week (~500 MB/month SQLite growth).
   - *Question:* Can the VPS support automated monthly archiving or partitioned SQLite databases while maintaining sub-second Dades tab queries?
3. **Resource Boundaries under Compose Limit**
   - *Risk:* Docker Compose enforces a 400 MB memory limit (`compose.yaml:20`).
   - *Question:* A full-Catalonia spatial index for stop discovery and journey planning will require disk-backed R*Trees rather than in-memory maps to prevent container OOM kills.
