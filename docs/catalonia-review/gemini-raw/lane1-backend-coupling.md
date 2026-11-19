# Architectural Review: Scaling "Arribo!" to All Public Transport in Catalonia

**Lane:** Backend Multi-Provider Coupling & Concurrency Architecture  
**Scope:** Verified against Go backend source (`app/*.go`), data schemas, and documentation (`AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE_NEXT.md`).

---

## 1. Key Findings

### 1. Hardcoded Line ID Normalization and Validation Restricts Fleet to L1–L8
* **Severity:** **BLOCKER**
* **Evidence:**
  * [`app/registry.go:38-56`](file:///home/some1sm/Coding/arribo/app/registry.go#L38-L56): `getTrackerForLine` tests line IDs strictly against `reRegL18` (`^l[1-8]$`) and `reRegDigit18` (`^[1-8]$`), throwing `"No transit tracker registered for line..."` for any non-digit 1–8. Returns hardcoded `CleanCode: "L" + mataroID`, `Agency: "Mataró Bus"`, `IsTrain: false`, and `Type: "mataro"`.
  * [`app/schedules.go:432-478`](file:///home/some1sm/Coding/arribo/app/schedules.go#L432-L478): `normalizeLineId` strips `mataro_`, `line-`, `linia-`, `L` and checks `reLineID18.MatchString(clean)`. Returns `nil` for any line outside `1`..`8`.
  * [`app/ingestion.go:300`](file:///home/some1sm/Coding/arribo/app/ingestion.go#L300): `pollMataroVehicles()` hardcodes polling to `lines := []string{"1", "2", "3", "4", "5", "6", "7", "8"}`.
  * [`app/schedlogic.go:698, 767-809`](file:///home/some1sm/Coding/arribo/app/schedlogic.go#L698-L809): `lineIDs` is fixed to `1`..`8`. `lineIdOf` returns `""` for anything else. In `isOutsideRevenueService`, an unknown line causes `ids` to default to checking whether *any* Mataró bus line is running to determine revenue service!
  * [`app/anomalies.go:780-782`](file:///home/some1sm/Coding/arribo/app/anomalies.go#L780-L782): `lineIDFromCode` blindly applies `reLeadingL.ReplaceAllString`, breaking Rodalies (`R1`), FGC (`S1`, `L6`), TMB Bus (`H12`, `V15`), and TRAM (`T4`).
* **Impact:** Every transit mode and route in Catalonia outside Mataró's 8 city lines is rejected at registration, schedule resolution, revenue validation, and polling.

---

### 2. Global "World" Mutex Serializes All HTTP Requests and Ingestion Pollers
* **Severity:** **BLOCKER**
* **Evidence:**
  * [`app/tracker.go:37-66`](file:///home/some1sm/Coding/arribo/app/tracker.go#L37-L66): `World` manages concurrency via a single `mu sync.Mutex` ported to emulate Node’s single-threaded event loop.
  * [`app/server.go:71-73`](file:///home/some1sm/Coding/arribo/app/server.go#L71-L73): `ServeHTTP` locks `s.w.mu.Lock()` on *every incoming HTTP request* before entering `s.dispatch(q, res)`.
  * [`app/ingestion.go:105-114`](file:///home/some1sm/Coding/arribo/app/ingestion.go#L105-L114): Ingestion tasks take `d.w.mu.Lock()`.
* **Impact:** Designed for a single town (1 poller, 8 lines), this serializes all processing. Across Catalonia (~50 operators, hundreds of concurrent requests), any heavy request (such as path generation or delay aggregation) locks `s.w.mu`, stalling all HTTP responses—including `/api/health` and `/api/ready`—risking Docker health-check timeouts and thread starvation.

---

### 3. Journey Planner $O(|O| \cdot |D| \cdot |R|^2 \cdot S^2)$ Brute-Force Transfer Algorithm
* **Severity:** **BLOCKER**
* **Evidence:**
  * [`app/planner.go:33-38`](file:///home/some1sm/Coding/arribo/app/planner.go#L33-L38): `TransitRouter` is coupled to a single `*MataroTracker`.
  * [`app/planner.go:722-793`](file:///home/some1sm/Coding/arribo/app/planner.go#L722-L793): `buildCandidates` executes 5 nested loops: `origin candidates` $\times$ `dest candidates` $\times$ `route1` $\times$ `stops(route1)` $\times$ `route2` $\times$ `stops(route2)`, evaluating Haversine distances (`distM`) at the innermost step.
  * [`app/planner.go:41, 106, 296`](file:///home/some1sm/Coding/arribo/app/planner.go#L41-L296): Hardcodes stop ID normalization (`"1" + padStart(qStr, 3, "0")`) assuming stop 5 is stop 1005.
* **Impact:** Mataró has 16 directional routes and 155 stops (~$2.5 \times 10^4$ inner iterations, <10 ms). Catalonia has >1,000 lines, >2,000 route directions, and ~30,000 stops. A single query would execute $>3.6 \times 10^9$ inner iterations, deadlocking Go routines under `World.mu`. Furthermore, the algorithm is hardcoded to direct and 1-transfer journeys only; multi-modal itineraries (e.g. Bus $\rightarrow$ Rodalies $\rightarrow$ Metro) cannot be computed.

---

### 4. Real-time Telemetry Engine Coupled to Avanza SIRI SOAP and Mataró Coordinates
* **Severity:** **BLOCKER**
* **Evidence:**
  * [`app/siri.go:65-85`](file:///home/some1sm/Coding/arribo/app/siri.go#L65-L85): `newSiriClient` hardcodes endpoint `sirimataro.avanzagrupo.com/Siri/SiriWS.asmx` and default credentials (`Mataro` / `Mataro*WS`).
  * [`app/siri.go:92-94`](file:///home/some1sm/Coding/arribo/app/siri.go#L92-L94): `isValidMataroCoord(lat, lon)` restricts valid coordinates strictly to `lat [41.45, 41.65]` and `lon [2.30, 2.55]`.
  * [`app/siri.go:604-607, 651-653`](file:///home/some1sm/Coding/arribo/app/siri.go#L604-L653): Telemetry outside this bounding box is discarded and counted as `c.rejectedFixes++`.
  * [`app/siri.go:693-703`](file:///home/some1sm/Coding/arribo/app/siri.go#L693-L703): `normalizeStopId` adds 1000 to any numeric ID $< 1000$ (`1000 + n`), corrupting IDs for any other agency.
  * [`app/siri.go:608-688`](file:///home/some1sm/Coding/arribo/app/siri.go#L608-L688): Uses substring parsing (`extractTag`) against SIRI XML; contains zero support for GTFS-RT Protobuf (`VehiclePositions`, `TripUpdates`, `Alerts`).
* **Impact:** Drops 100% of telemetry outside Mataró (Barcelona, Girona, Tarragona, Lleida). Cannot ingest GTFS-RT feeds from ATM or Generalitat.

---

### 5. Timetable Data Layer Hardcoded to Seasonal Maresme Grids and Catalan Day Names
* **Severity:** **MAJOR**
* **Evidence:**
  * [`app/schedules.go:83-89, 93-127`](file:///home/some1sm/Coding/arribo/app/schedules.go#L83-L127): Loads static files `mataro_schedules.seasons.json` and `mataro_schedules.json` into package-level global singletons (`seasonGrids`, `legacyGrid`).
  * [`app/schedules.go:134-142, 459-467`](file:///home/some1sm/Coding/arribo/app/schedules.go#L134-L467): `dayAliasOrder` couples scheduling to `"Feiners"`, `"Dissabtes"`, `"Diumenges i Festius"`.
  * [`app/schedules.go:317-341`](file:///home/some1sm/Coding/arribo/app/schedules.go#L317-L341): `dayTrips` requires a uniform 2D matrix per direction where row index = trip index.
  * [`app/synth.go:40-57`](file:///home/some1sm/Coding/arribo/app/synth.go#L40-L57): Synthetic travel times hardcode bus kinematics (8 m/s speed, 25s dwell).
* **Impact:** Incompatible with standard GTFS static data. GTFS calendar exceptions (`calendar_dates.txt`), flexible service windows, and `frequencies.txt` (essential for Metro/TRAM headways) cannot be represented.

---

### 6. History DB Schema and Observatori Analytics Lack Agency Namespacing
* **Severity:** **MAJOR**
* **Evidence:**
  * [`app/historydb.go:440-500`](file:///home/some1sm/Coding/arribo/app/historydb.go#L440-L500): `stop_visits` schema keys by `(line_code, stop_name)`. It lacks `agency_id`, `route_id`, `trip_id`, and `stop_id`.
  * [`app/historydb.go:119-128`](file:///home/some1sm/Coding/arribo/app/historydb.go#L119-L128): `appendMataroScope` injects `mataroScopeSQL` (`UPPER(line_code) IN ('L1'..'L8')`) into Observatori analytics queries whenever "all lines" are requested.
  * [`app/historydb.go:398`](file:///home/some1sm/Coding/arribo/app/historydb.go#L398): Database connection is pool-locked to `db.SetMaxOpenConns(1)`.
* **Impact:** Across Catalonia, line codes collide ("L1" is shared by Mataró Bus, Barcelona Metro, Lleida Bus, and Girona Bus). Stop names like "Estació" or "Plaça Major" exist in hundreds of towns, creating severe cross-agency data corruption in punctuality aggregation. Single-connection pure-Go SQLite will choke under tens of millions of monthly records.

---

### 7. Geocoder and Spatial Queries Bounded to Mataró
* **Severity:** **MAJOR**
* **Evidence:**
  * [`app/walkgeo.go:274, 347, 397`](file:///home/some1sm/Coding/arribo/app/walkgeo.go#L274-L397): Photon geocoding query hardcodes `bbox=2.30,41.48,2.58,41.62` and filters out results with `distM(mataroLat, mataroLon, lat, lon) > 12000` (12 km radius).
  * [`app/walkgeo.go:57`](file:///home/some1sm/Coding/arribo/app/walkgeo.go#L57): Pedestrian router cache is capped at 256 entries (`maxEntry: 256`).
* **Impact:** Address and street lookups fail for any location across Catalonia outside Mataró.

---

### 8. Holiday Calendar Hardcoded to Mataró Local Holidays
* **Severity:** **MAJOR**
* **Evidence:**
  * [`app/calendar.go:154-156`](file:///home/some1sm/Coding/arribo/app/calendar.go#L154-L156): Asserts `len(y.Local) == 2` (Mataró's 2 municipal holidays).
  * [`app/calendar.go:168`](file:///home/some1sm/Coding/arribo/app/calendar.go#L168): Emits warning `"Festius locals de Mataró <year> no configurats"`.
  * [`app/calendar.go:179-183`](file:///home/some1sm/Coding/arribo/app/calendar.go#L179-L183): Global `isHoliday(ms)` evaluates whether a date is a holiday using Mataró's calendar.
* **Impact:** Catalonia contains 947 municipalities, each with distinct local holidays. Applying Mataró's holidays globally causes normal working days in Barcelona or Girona to be misclassified as Sunday schedules, distorting punctuality baselines.

---

### 9. Server Routes and Singletons Hard-Bound to Mataró
* **Severity:** **MINOR**
* **Evidence:**
  * [`app/server.go:1031-1040`](file:///home/some1sm/Coding/arribo/app/server.go#L1031-L1040): Exposes `/api/mataro/*` endpoint aliases.
  * [`app/server.go:1118`](file:///home/some1sm/Coding/arribo/app/server.go#L1118): `hHealth` outputs hardcoded `"agency": "Mataró Bus Urbà"`.
  * [`app/server.go:1298`](file:///home/some1sm/Coding/arribo/app/server.go#L1298): Stop search outputs hardcoded `"zone": "Mataró Urbà"`.

---

## Evaluation of `ARCHITECTURE_NEXT.md`'s `TimetableProvider` Proposal

The proposal in [`ARCHITECTURE_NEXT.md §2`](file:///home/some1sm/Coding/arribo/ARCHITECTURE_NEXT.md#L18-L103) correctly identifies the need to decouple from `maresme.net`, but has critical gaps when measured against the Go codebase and real Catalonia-wide GTFS:

1. **Flawed Day-Type & Calendar Model:** The interface specifies `dayType: 'weekday' | 'saturday' | 'sunday'` and `season?: 'winter' | 'summer'`. GTFS does not use static 3-day partitions or seasonal labels; it uses `calendar.txt` (service dates bitmask) and `calendar_dates.txt` (exception dates: additions/removals). Catalonia transit involves school variants, eve-of-holiday services (*vigílies de festius*), and Friday night adjustments that cannot map to a 3-value enum.
2. **Dense Matrix Assumption:** `getTripStopTime` requires a numeric `tripIndex`. GTFS trips have arbitrary alphanumeric `trip_id`s, branching, and short-turns—they are not uniform matrix columns.
3. **Missing High-Frequency Modes (`frequencies.txt`):** Metro (TMB L1–L5) and Tram operate on headways (every 2–3 minutes), not fixed departure boards. The interface lacks frequency-based schedules.
4. **Scale & RAM Infeasibility ($10^7$ `stop_times` rows):** Catalonia GTFS feeds contain 15M–25M stop times. Representing them as in-memory Go/JS `*Obj` instances will consume gigabytes of heap, immediately violating the container limit (`GOMEMLIMIT=128MiB`). A memory-mapped columnar store or embedded SQLite index is mandatory.
5. **Real-time Disconnect:** The proposal mentions GTFS-RT, but the Go implementation lacks Protobuf decoders, `TripUpdate` delay reconcilers, or GTFS-RT vehicle position matchers.

---

## 2. Recommended Changes

```
               ┌──────────────────────────────────────────────────┐
               │          Multi-Agency Ingestion Layer            │
               │  GTFS-RT / SIRI-VM / SIRI-Lite / REST Push-Pull  │
               └───────────┬──────────────────────────┬───────────┘
                           │                          │
                           ▼                          ▼
               ┌───────────────────────┐  ┌───────────────────────┐
               │    AgencyTracker      │  │    AgencyTracker      │
               │     (TMB Metro)       │  │    (Rodalies/Renfe)   │
               │ sync.RWMutex Isolation│  │ sync.RWMutex Isolation│
               └───────────┬───────────┘  └───────────┬───────────┘
                           │                          │
                           ▼                          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                      Unified Namespaced Transit Graph                           │
│     IDs: agency:route_id (TMB:L1) | agency:stop_id | Mode: Bus/Rail/Metro      │
├────────────────────────────────────────┬────────────────────────────────────────┤
│           RAPTOR / CSA Router          │        Observatori Analytics           │
│   O(K * |E|) Multi-Modal Routing       │  Compound Keys (agency, route, stop)   │
│   Decoupled from World Mutex           │  Partitioned / Aggregated History DB   │
└────────────────────────────────────────┴────────────────────────────────────────┘
```

### Phase 1: Unified GTFS-Aligned Namespaced Data Model
* **Priority:** 1 | **Effort:** **L**
* **Action:**
  1. Replace naked string line IDs with compound identifiers: `agency_id:route_id` (e.g. `mataro:L1`, `tmb:L1`, `rodalies:R1`, `fgc:S1`).
  2. Add GTFS `route_type` (0=Tram, 1=Metro, 2=Rail, 3=Bus) across routes, stops, and vehicles.
  3. Migrate SQLite schemas in [`app/historydb.go`](file:///home/some1sm/Coding/arribo/app/historydb.go#L434-L500): update `stop_visits` and `delay_logs` to compound primary keys `(agency_id, route_id, trip_id, stop_id)`.
  4. Strip Mataró line regexes (`reRegL18`, `reLineID18`, `reLeadingL`) from [`app/registry.go`](file:///home/some1sm/Coding/arribo/app/registry.go#L38-L56), [`app/schedules.go`](file:///home/some1sm/Coding/arribo/app/schedules.go#L432-L478), and [`app/anomalies.go`](file:///home/some1sm/Coding/arribo/app/anomalies.go#L780-L782).

### Phase 2: Eliminate Global "World" Mutex Concurrency Bottleneck
* **Priority:** 2 | **Effort:** **M**
* **Action:**
  1. Remove `s.w.mu.Lock()` from [`app/server.go:71-73`](file:///home/some1sm/Coding/arribo/app/server.go#L71-L73) to allow Go HTTP workers to handle queries concurrently.
  2. Replace `World.mu` in [`app/tracker.go:37-66`](file:///home/some1sm/Coding/arribo/app/tracker.go#L37-L66) with fine-grained per-agency read/write locks (`sync.RWMutex`).
  3. Use atomic pointer swaps (`atomic.Pointer[FleetSnapshot]`) for `/api/fleet/events` broadcasting.

### Phase 3: GTFS Static + GTFS-RT Telemetry Ingestion Engine
* **Priority:** 3 | **Effort:** **L**
* **Action:**
  1. Replace `loadSchedules` with an embedded SQLite or memory-mapped storage engine for GTFS `stop_times.txt` to keep RAM usage within VPS limits (<128 MB).
  2. Implement `service_id` calendar evaluation honoring `calendar_dates.txt`.
  3. Build a GTFS-RT Protobuf ingestion engine (`FeedMessage`) updating positions and delay offsets by `(trip_id, stop_sequence)`.
  4. Abstract provider polling so each agency runs an isolated background worker poller.

### Phase 4: Replace Journey Planner with RAPTOR / CSA
* **Priority:** 4 | **Effort:** **L**
* **Action:**
  1. Replace the $O(|O| \cdot |D| \cdot |R|^2 \cdot S^2)$ brute-force transfer loop in [`app/planner.go:682-793`](file:///home/some1sm/Coding/arribo/app/planner.go#L682-L793) with RAPTOR (Round-Based Public Transit Routing) or CSA (Connection Scan Algorithm).
  2. Support $N$ transfers and multi-modal transfers (walking footpaths between Metro and Rodalies stations).

### Phase 5: REST API Harmonization & Observatori Analytics Scaling
* **Priority:** 5 | **Effort:** **M**
* **Action:**
  1. Transition `/api/line/:lineId` to namespaced routes: `/api/:agency/line/:lineId`.
  2. Partition `stop_visits` tables by month/year in SQLite.
  3. Update anomaly and relink detection in [`app/anomalies.go`](file:///home/some1sm/Coding/arribo/app/anomalies.go) to use mode-specific speed and dwell parameters.

---

## 3. Quick-Win Optimizations

1. **Uncap Bounding Box in Geocoder:**
   * In [`app/walkgeo.go:347, 397`](file:///home/some1sm/Coding/arribo/app/walkgeo.go#L347-L397), remove the hardcoded Mataró coordinate box (`bbox=2.30,41.48,2.58,41.62`) and 12 km radius check. Replace with the Catalonia bounding box (`bbox=0.15,40.50,3.35,42.85`). (*Effort: S*)
2. **Bypass World Mutex for Health Checks:**
   * In [`app/server.go:71-73`](file:///home/some1sm/Coding/arribo/app/server.go#L71-L73), move `/api/health` and `/api/ready` handling above `s.w.mu.Lock()` so server probes never fail under high ingestion or routing load. (*Effort: S*)
3. **Remove Hardcoded Mataró Scope from SQL:**
   * In [`app/historydb.go:119-128`](file:///home/some1sm/Coding/arribo/app/historydb.go#L119-L128), eliminate `mataroScopeSQL` and make agency filtering optional via query parameter (`?agency=`). (*Effort: S*)
4. **Generalize Line ID Extraction:**
   * Replace `reLeadingL.ReplaceAllString` in [`app/anomalies.go:780-782`](file:///home/some1sm/Coding/arribo/app/anomalies.go#L780-L782) with transparent alphanumeric string passing so non-`L` lines (`R1`, `S2`, `H12`, `T4`) do not crash lookups. (*Effort: S*)

---

## 4. Open Questions & Risks

1. **Upstream Telemetry Feeds:** Does the team have confirmed access to real-time telemetry for all targets? While ATM provides open GTFS-RT for metropolitan bus and metro, Renfe/Rodalies frequently requires dedicated institutional agreements or custom SIRI-VM access.
2. **Memory Footprint Under 128 MB `GOMEMLIMIT`:** Storing full Catalonia static schedules in RAM using Go structs will cause out-of-memory container terminations. An on-disk indexed representation (such as SQLite WAL or FlatBuffers) is essential.
3. **Punctuality Semantics by Mode:** The Observatori's current contract (early $< -1$ min, on-time $-1$..$+3$ min, late $> 3$ min; [`app/anomalies.go:18-28`](file:///home/some1sm/Coding/arribo/app/anomalies.go#L18-L28)) matches urban buses. For high-frequency Metro (where riders track headway rather than timetables) and long-distance rail (where standard European punctuality allows $\le 5$ min), the platform must adopt mode-specific punctuality metrics.
