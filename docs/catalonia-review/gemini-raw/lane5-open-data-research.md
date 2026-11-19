# Arribo! Catalonia-Wide Transit Review & Open Data Assessment

> **Scope:** Architectural audit of the Arribo! codebase (`app/`, `public/`) for scaling from Mataró Bus Urbà (L1–L8, 155 stops) to all public transport in Catalonia, with emphasis on delay/punctuality tracking and the *Dades* / *Observatori* analytics tab. Includes verified late-2026 Catalan open transit data research.

---

### Catalonia Public Transport Open Data Landscape (Late 2026)

| Operator / Network | Modes | Static Feed (Schedule) | Real-Time Feed (Type & Format) | Auth / Key | Update Freq. | Coverage & Verified Status | Delay/Punctuality Tracking Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **TMB** | Urban Bus, Metro | GTFS Schedule (`developer.tmb.cat`) | GTFS-RT (`VehiclePositions.pb`, `TripUpdates.pb`), REST (iBus) | `app_id` + `app_key` required | 15–30 s (RT), weekly (static) | Full BCN city bus & metro network | **True GPS & deltas** for bus; metro tracked via station block occupancy. |
| **AMB Mobilitat** | Metro Bus (TUSGSAL, Moventis, Baixbus, etc.) | GTFS (`ambmobilitat.cat/OpenData/google_transit.zip`) | GTFS-RT TripUpdates (`Servei GTFS Real time autobusos`), SIRI API | Reg. required for SIRI/API; open GTFS-RT | 30 s | 36 metropolitan municipalities | **Stop-level ETAs & delay deltas**. True vehicle GPS feeds are restricted. |
| **ATM Àrea de BCN** | Multi-operator integrated | Unified GTFS (`t-mobilitat.atm.cat/opendatafront`) | GTFS-RT TripUpdates & ServiceAlerts (CGIM) | Portal registration | 30–60 s | Broad regional integrated network | **TripUpdates only** (delays, cancellations). No universal GPS stream. |
| **Renfe Rodalies** | Commuter Rail (R1–R8, RG1, RT1–2) | GTFS (`data.renfe.com`) | GTFS-RT (`vehicle_positions.pb`, `trip_updates.pb`) | None for bulk PB; API key for REST | 30 s | All Rodalies de Catalunya lines | **True train GPS & platform updates**. Tunnel blackouts in BCN core. |
| **FGC** | Commuter & Suburban Rail | GTFS (`dadesobertes.fgc.cat`) | GTFS-RT (`VehiclePositions`, `TripUpdates`, `ServiceAlerts`) | None (CC-BY 4.0 open download) | 20–30 s | Barcelona-Vallès & Llobregat-Anoia lines | **True high-precision train GPS & delays**. Zero jitter. |
| **TRAM BCN** | Trambaix & Trambesòs | GTFS (`opendata.tram.cat`) | GTFS-RT / REST dynamic arrival feeds | Dev registration form on portal | ~30 s | T1–T6 light rail | **True tram tracking & stop predictions** upon registration. |
| **Generalitat (Mou-te)** | Interurban Concession Buses | GTFS (`territori.gencat.cat`, >900 lines) | Centralized SAEi in progress; mostly internal to Mou-te app | Open static; RT mostly closed/partner | Daily/weekly (static) | Entire territory outside metropolitan rings | **Schedules only for public feeds**. Delays measurable only where pushed to T-mobilitat. |
| **Regional Cities** *(Sabadell, Terrassa, Girona, Lleida, Tarragona, Reus)* | Municipal Urban Buses | Static GTFS (City open data portals) | Proprietary app backends (Moventis, TUS, EMT); Reus has GBFS | Varies by municipality | Varies | Local city boundaries | **Stop ETAs in local apps; true public GPS feeds absent** (unlike Mataró Avanza SIRI). |
| **Bicing** | Bike share | GBFS v3.0 / v2.3 (`barcelona.publicbikesystem.net`) | GBFS dynamic JSON (`station_status.json`) | None (Public endpoint) | 1–5 min | Barcelona city | **Dock availability only** (micromobility has no timetable delays). |
| **NAP Transporte** | National Intercity & Rail | GTFS & NeTEx (`nap.transportes.gob.es`) | GTFS-RT (National operators: ALSA, Avanza) | Free dev API registration | Varies | State-wide long-distance concessions | **Mixed**. High-quality for rail/ALSA, sparse for small concessions. |
| **Official Holidays** | Calendar Data | ICS / Socrata API (`dadesobertes.gencat.cat`) | Annual DOGC official orders | Open data | Annual | Catalonia-wide + 947 municipalities | **Static calendars**. Regional holidays centralized; municipal holidays in BOPs. |

---

### (1) Key Findings

1. **Hardcoded Single-Line Regex and Registry Rejection**  
   - **Evidence:** [app/registry.go#L50-L56](file:///home/some1sm/Coding/arribo/app/registry.go#L50-L56)  
   - **Severity:** **BLOCKER**  
   - **Detail:** `TrackerRegistry.getTrackerForLine` strips prefixes and validates with `reRegDigit18` (`^[1-8]$`). Any line code that is not 1 through 8 (e.g., TMB `V15`, `D20`, Metro `L1` vs Mataró `L1`, Rodalies `R1`, FGC `S1`) throws `"No transit tracker registered for line"`.

2. **Hardcoded Geofence Bounds Drop All Regional Coordinates**  
   - **Evidence:** [app/siri.go#L92-L94](file:///home/some1sm/Coding/arribo/app/siri.go#L92-L94)  
   - **Severity:** **BLOCKER**  
   - **Detail:** `isValidMataroCoord` validates coordinates strictly against `lat 41.45–41.65` and `lon 2.30–2.55`. All fixes outside Mataró (e.g., Barcelona `41.38, 2.17`, Girona `41.98, 2.82`, Lleida `41.61, 0.62`) are discarded as invalid fixes.

3. **Database Scope and Schema Collisions Across Operators**  
   - **Evidence:** [app/historydb.go#L119-L128](file:///home/some1sm/Coding/arribo/app/historydb.go#L119-L128), [app/historydb.go#L480-L500](file:///home/some1sm/Coding/arribo/app/historydb.go#L480-L500), [app/historydb.go#L523](file:///home/some1sm/Coding/arribo/app/historydb.go#L523)  
   - **Severity:** **BLOCKER**  
   - **Detail:** Every analytics query appends `mataroScopeSQL` (`UPPER(line_code) IN ('L1'...'L8') AND line_id IN ('1'...'8')`), dropping all external telemetry. Crucially, table `stop_visits` lacks `operator_id` / `agency_id`, and `hourly_line_visit_stats` has `UNIQUE(line_code, date_hour)`. Because line `L1` exists simultaneously in Mataró, TMB Metro, Lleida, Girona, and Terrassa, metrics will overwrite or abort on unique constraint conflicts.

4. **Global Mutex Serialization on HTTP Request Dispatch**  
   - **Evidence:** [app/server.go#L71-L73](file:///home/some1sm/Coding/arribo/app/server.go#L71-L73), [app/tracker.go#L37-L58](file:///home/some1sm/Coding/arribo/app/tracker.go#L37-L58)  
   - **Severity:** **BLOCKER**  
   - **Detail:** `ServeHTTP` acquires `s.w.mu.Lock()` on the global `World` instance around `s.dispatch(q, res)` to replicate Node’s single-threaded event loop. With thousands of concurrent requests across Catalonia, all incoming HTTP connections serialize on one lock.

5. **Linear $O(N)$ Planner Stop Scans and Missing Graph Engine**  
   - **Evidence:** [app/planner.go#L290-L321](file:///home/some1sm/Coding/arribo/app/planner.go#L290-L321), [app/planner.go#L382-L412](file:///home/some1sm/Coding/arribo/app/planner.go#L382-L412)  
   - **Severity:** **MAJOR**  
   - **Detail:** Candidate generation and nearest-stop lookup linearly iterate over `allStopsMap.Keys()`, executing substring searches and Haversine distance computations (`distM`) on every stop. While viable for 155 stops, Catalonia comprises >30,000 stops; linear scans will cause CPU stalls and severe request latency. Furthermore, candidate generation only handles direct journeys and single transfers.

6. **Single-Threaded Pure-Go SQLite with In-Query Go Functions**  
   - **Evidence:** [app/historydb.go#L358-L381](file:///home/some1sm/Coding/arribo/app/historydb.go#L358-L381), [app/historydb.go#L398-L400](file:///home/some1sm/Coding/arribo/app/historydb.go#L398-L400), [app/historydb_incidents.go#L272](file:///home/some1sm/Coding/arribo/app/historydb_incidents.go#L272)  
   - **Severity:** **MAJOR**  
   - **Detail:** SQLite is opened via `modernc.org/sqlite` with `SetMaxOpenConns(1)`. The analytics queries execute `is_telemetry_anomaly(timestamp, delay_mins, stop_name, line_code)` per row. In pure-Go SQLite, running custom Go callbacks per row across millions of rows causes massive VM-to-Go context switching overhead, blocking the ingestion worker.

7. **Monolithic In-Memory Ingestion Daemon Hardcoded to Avanza SOAP**  
   - **Evidence:** [app/ingestion.go#L299-L310](file:///home/some1sm/Coding/arribo/app/ingestion.go#L299-L310), [app/siri.go#L76-L86](file:///home/some1sm/Coding/arribo/app/siri.go#L76-L86)  
   - **Severity:** **MAJOR**  
   - **Detail:** Ingestion is pinned to a 20 s tick calling `pollLine` on lines 1–8 against `sirimataro.avanzagrupo.com`. There is no pluggable ingestion abstraction for GTFS-RT Protocol Buffers or multi-agency polling.

8. **Rigid Local Holiday Assumptions (Single-Municipality Model)**  
   - **Evidence:** [app/calendar.go#L150-L173](file:///home/some1sm/Coding/arribo/app/calendar.go#L150-L173)  
   - **Severity:** **MINOR**  
   - **Detail:** `holidayYearStatus` verifies coverage using `len(y.Local) == 2` for Mataró's municipal holidays. In Catalonia, each of the 947 municipalities defines its own 2 local holidays; applying Mataró's calendar across Catalonia misclassifies weekday vs Sunday service schedules.

---

### (2) Recommended Changes

#### Phase 1: Storage & Identity Multi-Tenancy (Priority 1)
- **Composite Primary Keys & Agency Partitioning:** Refactor database tables (`delay_logs`, `stop_visits`, `vehicle_snapshots`, `hourly_line_visit_stats`) to include `agency_id` and `operator_id` in composite keys and indexes ([app/historydb.go#L434-L530](file:///home/some1sm/Coding/arribo/app/historydb.go#L434-L530)). Replace `UNIQUE(line_code, date_hour)` with `UNIQUE(agency_id, line_code, date_hour)`.  
  *Effort:* **M**
- **Purge Mataró Hardcoded SQL Filters:** Remove `mataroScopeSQL` and parameterize queries by agency/line ([app/historydb.go#L119-L128](file:///home/some1sm/Coding/arribo/app/historydb.go#L119-L128)).  
  *Effort:* **S**

#### Phase 2: Ingestion Pipeline & Telemetry Normalization (Priority 2)
- **Pluggable Ingestion Adapter Architecture:** Replace the monolithic `pollMataroVehicles` loop ([app/ingestion.go#L299-L310](file:///home/some1sm/Coding/arribo/app/ingestion.go#L299-L310)) with an `IngestionSource` interface. Implement a GTFS-RT adapter (consuming Protocol Buffers for TMB, Renfe, FGC, and AMB) alongside the existing Avanza SIRI client.  
  *Effort:* **L**
- **Dynamic Bounding Box & Geofence Engine:** Parameterize `isValidMataroCoord` ([app/siri.go#L92-L94](file:///home/some1sm/Coding/arribo/app/siri.go#L92-L94)) with per-agency bounding polygons covering all Catalonia (`lat 40.5–42.9`, `lon 0.15–3.35`).  
  *Effort:* **S**

#### Phase 3: High-Performance Routing & Concurrency Decoupling (Priority 3)
- **Eliminate Global Dispatch Mutex:** Remove `s.w.mu.Lock()` from HTTP dispatch ([app/server.go#L71-L73](file:///home/some1sm/Coding/arribo/app/server.go#L71-L73)). Guard shared memory (fleet state, caches) with fine-grained RWMutexes.  
  *Effort:* **M**
- **Spatial Indexing for Planner Candidates:** Replace $O(N)$ linear scans in [app/planner.go#L382-L412](file:///home/some1sm/Coding/arribo/app/planner.go#L382-L412) with a 2D spatial index (R-tree or S2/Geohash grid) for the >30,000 stops in Catalonia. Transition multi-transfer regional routing to Raptor or Connection Scan Algorithm (CSA).  
  *Effort:* **L**

#### Phase 4: Observatori / Dades Multi-Operator Scaling (Priority 4)
- **Hierarchical Frontend Navigation:** Update `public/js/observatori.js` ([public/js/observatori.js#L149-L158](file:///home/some1sm/Coding/arribo/public/js/observatori.js#L149-L158)) and `public/dades.html` to introduce an Agency/Mode hierarchy selector (Metro, Rodalies, FGC, Urban, Interurban) before line filtering.  
  *Effort:* **M**
- **Precomputed Incident & Analytics Rollups:** Eliminate dynamic per-row evaluation of `is_telemetry_anomaly` in full-table scans ([app/historydb_incidents.go#L272](file:///home/some1sm/Coding/arribo/app/historydb_incidents.go#L272)). Tag anomaly flags at ingestion time in `stop_visits` and `delay_logs`.  
  *Effort:* **M**

---

### (3) Quick-Win Optimizations

1. **Native SQL Filters Over Go Callbacks:** Migrate `is_telemetry_anomaly` ([app/historydb.go#L358-L381](file:///home/some1sm/Coding/arribo/app/historydb.go#L358-L381)) into standard SQL expressions or a materialized boolean column (`is_anomaly INTEGER NOT NULL DEFAULT 0`). This avoids thousands of CGO/Go virtual machine context switches per query.
2. **Read-Only SQLite Connection Pool:** Increase `SetMaxOpenConns(1)` in [app/historydb.go#L398](file:///home/some1sm/Coding/arribo/app/historydb.go#L398) to separate read connections from write connections under WAL mode (`PRAGMA query_only = ON` for reads), allowing concurrent analytics queries while the ingestion worker flushes stop visits.
3. **Regex Compilation Caching in Line Registry:** Eliminate runtime regex construction and prefix checks in [app/registry.go#L47-L56](file:///home/some1sm/Coding/arribo/app/registry.go#L47-L56) by indexing lines directly into a normalized `map[string]*lineResolution`.
4. **Relax Docker Memory Bounds for Initial Multi-Agency Proof of Concept:** Increase `GOMEMLIMIT=128MiB` and container limit `400M` in [compose.yaml#L27-L41](file:///home/some1sm/Coding/arribo/compose.yaml#L27-L41) to at least 2 GiB before loading integrated ATM or TMB datasets.

---

### (4) Open Questions & Risks

1. **Telemetry Honesty vs. Data Asymmetry in the Observatori:**  
   As established in [AGENTS.md#L97-L99](file:///home/some1sm/Coding/arribo/AGENTS.md#L97-L99) and [README.md#L26-L30](file:///home/some1sm/Coding/arribo/README.md#L26-L30), Arribo! strictly distinguishes fresh GPS observations from theoretical timetable positions. In Catalonia, while FGC, Rodalies, TMB, and Mataró provide real vehicle coordinates, **AMB and regional interurban buses frequently provide only stop-level TripUpdates or static schedules**. Displaying delay analysis for operators with only synthetic stop predictions risks compromising the platform's core trust contract.
2. **SQLite Capacity at Catalonia Scale:**  
   Mataró logs ~10,000 stop visits/day. Across Catalonia's ~100,000 daily trips, the ingestion daemon will record ~2.5 million stop visits/day (~75 million rows/month). Even with WAL mode and indexing, SQLite file size will exceed 15–20 GB/month. An operational decision must be made whether to retain pure-Go SQLite via aggressive partitioning or adopt a dedicated time-series/relational engine (e.g., PostgreSQL/TimescaleDB) for the worker world.
3. **Municipal Holiday Governance:**  
   Unlike Mataró's single municipal holiday file ([app/calendar.go#L168](file:///home/some1sm/Coding/arribo/app/calendar.go#L168)), Catalonia's 947 municipalities cannot be maintained manually. The ingestion pipeline must integrate with the Generalitat open data portal's holiday dataset (`dadesobertes.gencat.cat`) and automatically associate GTFS `stop_id` locations with municipal calendar codes.
4. **API Rate Limits on Upstream Providers:**  
   TMB developer keys and AMB API agreements enforce fair-use thresholds. Ingesting high-frequency real-time updates for >3,000 active buses across Catalonia every 20 seconds requires formal institutional access or dedicated batch GTFS-RT streaming endpoints rather than uncoordinated scraping.
