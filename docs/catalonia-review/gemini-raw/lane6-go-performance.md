# Performance and Optimization Review: Scaling Arribo to All Catalonia

This review evaluates the performance characteristics, architectural bottlenecks, and Node-compatibility overhead of the Arribo Go server (`app/`) in the context of scaling from Mataró (8 lines, 155 stops, ~20 concurrent vehicles) to the whole of Catalonia (TMB, Rodalies/Renfe, FGC, interurban buses; ~1,500+ lines, 25,000+ stops, 3,000–6,000+ active vehicles, representing a **50–500× scale increase**).

---

## 1. Key Findings

### Architectural & Scaling Blockers

1. **Global World Mutex Serializes HTTP Request Handling**
   * **Evidence:** [app/server.go#L71-L73](file:///home/some1sm/Coding/arribo/app/server.go#L71-L73), [app/tracker.go#L37-L66](file:///home/some1sm/Coding/arribo/app/tracker.go#L37-L66)
   * **Verified in code:** `Server.ServeHTTP` wraps `s.dispatch(q, res)` entirely within `s.w.mu.Lock()` and `s.w.mu.Unlock()`. Every incoming HTTP request acquires the server `World` mutex.
   * **Impact / Severity:** **BLOCKER**. All route matching, in-memory timetable lookups, JSON tree building, and static file checks run single-threaded. Although `w.await` temporarily yields during database RPC and ORS walking calls ([app/tracker.go#L62-L65](file:///home/some1sm/Coding/arribo/app/tracker.go#L62-L65)), CPU-intensive endpoint processing blocks all other HTTP clients. At 50–500× scale and concurrent user loads, request queuing will lead to catastrophic latency spikes and request timeouts.

2. **$O(N^2)$ and $O(N^6)$ Combinatorial Explosion in Journey Planner**
   * **Evidence:** [app/planner.go#L682-L750](file:///home/some1sm/Coding/arribo/app/planner.go#L682-L750)
   * **Verified in code:** Candidate itinerary generation evaluates transfer connections using deeply nested loops: `orig` candidates $\times$ `dest` candidates $\times$ all `r1` routes $\times$ all stops on `r1` $\times$ all `r2` routes $\times$ all stops on `r2`.
   * **Impact / Severity:** **BLOCKER**. For Mataró (16 route directions, 155 stops), loop iterations are bounded. At Catalonia scale (~3,000 route directions, 25,000 stops), an unindexed route-stop cross-product requires hundreds of millions of iterations per search query. Furthermore, [app/planner.go#L589](file:///home/some1sm/Coding/arribo/app/planner.go#L589) serializes candidate cache keys via `string(toJSON([]any{origin, destination}))`.

3. **SSE Fleet Broadcaster Connection Caps and Unbounded Client Queues**
   * **Evidence:** [app/server.go#L677-L678](file:///home/some1sm/Coding/arribo/app/server.go#L677-L678), [app/server.go#L714-L720](file:///home/some1sm/Coding/arribo/app/server.go#L714-L720), [app/worker.go#L59-L97](file:///home/some1sm/Coding/arribo/app/worker.go#L59-L97)
   * **Verified in code:** `sseMaxClients` is hardcoded to 200 (`app/server.go:677`), returning HTTP 503 when full. Each connection gets an unbounded `msgQueue[[]byte]` (`app/server.go:744`, `app/worker.go:59`). While broadcasting, a single encoded JSON slice is pushed to all client queues (`app/server.go:715-719`).
   * **Impact / Severity:** **BLOCKER**. A hard cap of 200 concurrent SSE listeners cannot support regional scale. Simultaneously, because `msgQueue.items` is unbounded with no drop policy or ring buffer, slow mobile clients accumulate pushed frame byte slices, leaking heap memory until the process terminates.

4. **GC Throttling and Destructive `FreeOSMemory` under Regional Heap Loads**
   * **Evidence:** [compose.yaml#L26-L27](file:///home/some1sm/Coding/arribo/compose.yaml#L26-L27), [compose.yaml#L39](file:///home/some1sm/Coding/arribo/compose.yaml#L39), [app/memtrim.go#L17-L30](file:///home/some1sm/Coding/arribo/app/memtrim.go#L17-L30)
   * **Verified in code:** `compose.yaml` enforces `GOGC=50` and `GOMEMLIMIT=128MiB` inside a 400 MB container limit. Concurrently, `memtrim.go` polls heap metrics every 30s and calls `debug.FreeOSMemory()` whenever free heap exceeds 8 MiB.
   * **Impact / Severity:** **BLOCKER**. At regional scale, the live dataset alone (GTFS/Schedules, graph, active vehicles, trip indices) will exceed 200–500 MB. Setting `GOMEMLIMIT=128MiB` will force the Go runtime into a continuous GC thrashing loop ("GC starvation"). Repeatedly invoking `debug.FreeOSMemory()` forces Stop-The-World collections and returns pages to the kernel, creating severe latency jitters.

---

### Major Performance Inefficiencies

5. **Inter-World Deep Cloning Overhead on Live Ingestion**
   * **Evidence:** [app/bridge.go#L181](file:///home/some1sm/Coding/arribo/app/bridge.go#L181), [app/bridge.go#L388](file:///home/some1sm/Coding/arribo/app/bridge.go#L388), [app/worker.go#L109-L120](file:///home/some1sm/Coding/arribo/app/worker.go#L109-L120), [app/jsmap.go#L118-L198](file:///home/some1sm/Coding/arribo/app/jsmap.go#L118-L198)
   * **Verified in code:** Messages crossing between the worker and server worlds pass through `passJSON`, which runs `jsonClone`. For every vehicle update poll batch, `jsonClone` recursively duplicates every `*Obj`, slice, and string to emulate Node child-process IPC.
   * **Impact / Severity:** **MAJOR**. Both worlds reside in the same Go process address space. Ingesting 5,000 vehicles every 20 seconds would clone ~100,000 structs per poll cycle, creating huge heap allocation churn and CPU overhead.

6. **Unbounded In-Memory Vehicle History and Weak Cache Pruning**
   * **Evidence:** [app/tracker.go#L549](file:///home/some1sm/Coding/arribo/app/tracker.go#L549), [app/tracker.go#L980-L981](file:///home/some1sm/Coding/arribo/app/tracker.go#L980-L981), [app/tracker_stops.go#L1056-L1065](file:///home/some1sm/Coding/arribo/app/tracker_stops.go#L1056-L1065)
   * **Verified in code:** `t.vehicleHistory.Set(vID, ...)` stores vehicle state keyed by `vehicleId`. It only explicitly deletes `"Bus"` and `"bus"`. Stale physical vehicle IDs are never evicted. In `stopDeparturesMemoryCache` ([app/tracker_stops.go#L1057-L1064](file:///home/some1sm/Coding/arribo/app/tracker_stops.go#L1057-L1064)), eviction only triggers when `Len() > 200`, and only deletes entries $> 60\text{s}$ old; sustained high-cardinality requests bypass eviction.
   * **Impact / Severity:** **MAJOR**. A fleet of thousands of buses and trains rotating through service across Catalonia will cause `vehicleHistory` to grow monotonically without bound.

7. **Static Assets Served Uncompressed**
   * **Evidence:** [app/server.go#L123](file:///home/some1sm/Coding/arribo/app/server.go#L123), [app/server.go#L187](file:///home/some1sm/Coding/arribo/app/server.go#L187), [app/express.go#L188](file:///home/some1sm/Coding/arribo/app/express.go#L188), [app/express.go#L1002](file:///home/some1sm/Coding/arribo/app/express.go#L1002)
   * **Verified in code:** `res.compress = true` is only assigned in `runRoutes` ([app/server.go#L187](file:///home/some1sm/Coding/arribo/app/server.go#L187)). Static file delivery in `serveStatic` ([app/server.go#L123](file:///home/some1sm/Coding/arribo/app/server.go#L123)) executes before `runRoutes`. As `res.compress` defaults to `false`, `res.flush()` bypasses gzip and brotli pools.
   * **Impact / Severity:** **MAJOR**. All client bundles (`public/js/*.js`, `public/css/*.css`, HTML files) are sent uncompressed over HTTP, wasting bandwidth and increasing initial paint latency on mobile networks.

8. **Synchronous Disk I/O (`os.Stat`) Under Global Lock on Every Request**
   * **Evidence:** [app/server.go#L123](file:///home/some1sm/Coding/arribo/app/server.go#L123), [app/express.go#L537](file:///home/some1sm/Coding/arribo/app/express.go#L537)
   * **Verified in code:** `s.dispatch` calls `s.serveStatic` before evaluating API routes. For every single `/api/*` call, the server performs an `os.Stat(filepath.Join(s.publicDir, p))` filesystem lookup *while holding `s.w.mu.Lock()`*, before falling through to `runRoutes`.
   * **Impact / Severity:** **MAJOR**. Unnecessary filesystem I/O on every API hit introduces kernel context switches and disk latency into the critical path of the server lock.

9. **Mandatory SHA-1 ETag Generation on Dynamic Responses**
   * **Evidence:** [app/express.go#L227](file:///home/some1sm/Coding/arribo/app/express.go#L227), [app/express.go#L337-L344](file:///home/some1sm/Coding/arribo/app/express.go#L337-L344)
   * **Verified in code:** `res.send(chunk)` executes `res.h.Set("ETag", bodyETag(chunk))`, computing `sha1.Sum` over the entire serialized byte slice unconditionally, even when caching is disabled or client sent no conditional headers (`If-None-Match`).
   * **Impact / Severity:** **MAJOR**. Serializing and SHA-1 hashing multi-megabyte analytics reports ([app/reportcache.go#L5](file:///home/some1sm/Coding/arribo/app/reportcache.go#L5), ~1.4 MB) burns CPU on every response.

---

### Minor / Node-Compatibility Friction

10. **Software IEEE 754 Math Emulation (`fdlibm.go`)**
    * **Evidence:** [app/fdlibm.go#L1-L470](file:///home/some1sm/Coding/arribo/app/fdlibm.go#L1-L470), [app/mathjs.go#L15-L18](file:///home/some1sm/Coding/arribo/app/mathjs.go#L15-L18)
    * **Verified in code:** `jsSin`, `jsCos`, `jsAtan2`, and `jsExp` route to pure-Go software bit-twiddling ported from FreeBSD msun to guarantee exact bit-level parity with V8.
    * **Impact / Severity:** **MINOR**. Go's standard library `math` routines utilize native CPU SIMD/FPU assembly instructions. In hot distance/bearing calculations ([app/geo.go#L71-L91](file:///home/some1sm/Coding/arribo/app/geo.go#L71-L91)), `fdlibm` is 3–5× slower than native math.

11. **Heavyweight Query String Parser (`qs.go`) on Flat Routes**
    * **Evidence:** [app/qs.go#L528-L544](file:///home/some1sm/Coding/arribo/app/qs.go#L528-L544), [app/server.go#L67](file:///home/some1sm/Coding/arribo/app/server.go#L67)
    * **Verified in code:** `parseQuery` implements the full specification of npm's `qs` library (5-level depth, bracket arrays, prototype protection, map side channels).
    * **Impact / Severity:** **MINOR**. Transit API endpoints use simple key-value parameters (`line`, `stop`, `direction`). Instantiating `qsParser` with multiple temporary maps on every request produces needless garbage.

12. **Defensive Deep Cloning on Cache Hits**
    * **Evidence:** [app/tracker.go#L1020](file:///home/some1sm/Coding/arribo/app/tracker.go#L1020), [app/tracker.go#L1041](file:///home/some1sm/Coding/arribo/app/tracker.go#L1041), [app/tracker.go#L1045](file:///home/some1sm/Coding/arribo/app/tracker.go#L1045)
    * **Verified in code:** Cache hits in `getLineDetails` run `deepClone(c.result).(*Obj)` before returning to prevent caller mutations.
    * **Impact / Severity:** **MINOR**. Defeats the primary allocation benefit of an in-memory cache.

13. **Redundant Coordinate Re-Parsing in Route Matching**
    * **Evidence:** [app/tracker.go#L784-L802](file:///home/some1sm/Coding/arribo/app/tracker.go#L784-L802)
    * **Verified in code:** `matchVehicleToRouteIndex` re-parses latitude and longitude strings from `r.Get("coords")` via `parseFloatJS` on every candidate match, ignoring the existing pre-parsed route coordinate cache in `t.routeCoords(r)` ([app/tracker.go#L145-L156](file:///home/some1sm/Coding/arribo/app/tracker.go#L145-L156)).

14. **Compiled RegExps Evaluated in Hot Request Guard Paths**
    * **Evidence:** [app/httpguard.go#L186-L190](file:///home/some1sm/Coding/arribo/app/httpguard.go#L186-L190), [app/httpguard.go#L226-L227](file:///home/some1sm/Coding/arribo/app/httpguard.go#L226-L227)
    * **Verified in code:** `apiLimiter.allow` executes regular expressions (`reHealthPath`, `reMapPath`, `reAnalyticsPath`) inside the limiter mutex on every single request.

---

## 2. Recommended Changes

| Priority | Optimization / Change | Rationale | Scale Requirement | Effort |
| :--- | :--- | :--- | :--- | :---: |
| **P1** | **Eliminate Global World Lock on Read Handlers** | Replace coarse `s.w.mu` in [app/server.go#L71](file:///home/some1sm/Coding/arribo/app/server.go#L71) with fine-grained read-write locks (`sync.RWMutex`) or lock-free atomic pointer swaps (`atomic.Pointer`) for tracker and report snapshots. Run static file serving and read-only routes fully concurrently. | **Mandatory at 10×+** | **L** |
| **P2** | **Spatial/Graph Indexing for Journey Planner** | Replace $O(N^6)$ loops in [app/planner.go#L678-L770](file:///home/some1sm/Coding/arribo/app/planner.go#L678-L770) with a transfer adjacency index (precomputing intersecting lines at interchange hubs) and spatial KD-Tree/R-Tree for stop clustering. | **Mandatory at 5×+** | **L** |
| **P3** | **Bounded SSE Broadcaster & Connection Architecture** | Refactor [app/server.go#L663-L819](file:///home/some1sm/Coding/arribo/app/server.go#L663-L819) to use ring buffers with frame-dropping for slow consumers. Parameterize connection caps or decouple SSE into an edge push layer. | **Mandatory at 20×+** | **M** |
| **P4** | **Re-tune Runtime GC & Remove Destructive Trimming** | In [compose.yaml#L26-L27](file:///home/some1sm/Coding/arribo/compose.yaml#L26-L27), increase `GOMEMLIMIT` to match container resources (e.g. 2–4 GiB for Catalonia) and reset `GOGC=100`. Delete or disable [app/memtrim.go#L21-L30](file:///home/some1sm/Coding/arribo/app/memtrim.go#L21-L30) to avoid premature STW scavenger pauses. | **Mandatory at 10×+** | **S** |
| **P5** | **Zero-Copy Cross-World Message Passing** | Replace `passJSON` / `jsonClone` in [app/bridge.go#L181](file:///home/some1sm/Coding/arribo/app/bridge.go#L181) with immutable pointer swaps. Since worker and server share memory, pass ownership of read-only snapshot structs directly. | **Mandatory at 50×+** | **M** |
| **P6** | **Enforce Strict Bounds on LRU Caches** | Add explicit capacity limits and LRU eviction to `t.vehicleHistory` ([app/tracker.go#L549](file:///home/some1sm/Coding/arribo/app/tracker.go#L549)) and `stopDeparturesMemoryCache` ([app/tracker_stops.go#L1057](file:///home/some1sm/Coding/arribo/app/tracker_stops.go#L1057)). | **Mandatory at 10×+** | **S** |
| **P7** | **Replace `fdlibm` and `jscase` with Go Stdlib** | Revert `fdSin`/`fdCos`/`fdAtan2` in [app/mathjs.go#L15-L18](file:///home/some1sm/Coding/arribo/app/mathjs.go#L15-L18) to Go's standard `math` package. Replace `jscase.go` with `strings.ToUpper`/`ToLower`. | Recommended | **S** |
| **P8** | **Transition from `*Obj` to Strongly Typed Structs** | Progressively replace dynamic `*Obj` / `O()` maps ([app/jsobj.go#L36](file:///home/some1sm/Coding/arribo/app/jsobj.go#L36)) with native Go structs in ingestion and tracker domains. Key ordering is not required by frontend `JSON.parse`. | Recommended | **L** |

---

## 3. Quick-Win Optimizations (Low Risk / Immediate Gain)

1. **Enable Compression on Static Files**
   * Move `res.compress = true` from [app/server.go#L187](file:///home/some1sm/Coding/arribo/app/server.go#L187) to [app/server.go#L103](file:///home/some1sm/Coding/arribo/app/server.go#L103) before `s.serveStatic`. Static files will immediately benefit from brotli and gzip compression.
2. **Bypass `serveStatic` for API Requests**
   * In [app/server.go#L123](file:///home/some1sm/Coding/arribo/app/server.go#L123), guard static serving with `if !isAPI`:
     ```go
     if !isAPI {
         if handled, err := s.serveStatic(q, res); handled { ... }
     }
     ```
     Instantly eliminates disk `os.Stat` calls under the lock on all `/api/*` endpoints.
3. **Conditional ETag Hashing**
   * In [app/express.go#L226-L228](file:///home/some1sm/Coding/arribo/app/express.go#L226-L228), only compute `bodyETag` if `res.req.header("If-None-Match") != ""` and `!strings.Contains(res.h.Get("Cache-Control"), "no-store")`. Avoids hashing MBs of JSON needlessly.
4. **Fast-Path String Prefixes in Rate Limiter**
   * Replace regex matching in [app/httpguard.go#L226-L227](file:///home/some1sm/Coding/arribo/app/httpguard.go#L226-L227) with direct `strings.HasPrefix(pathname, "/api/analytics")` and `strings.HasPrefix(pathname, "/api/health")`.
5. **Reuse Pre-parsed Route Coordinates in Vehicle Snapping**
   * In [app/tracker.go#L785-L800](file:///home/some1sm/Coding/arribo/app/tracker.go#L785-L800), replace manual coordinate float parsing with `t.routeCoords(r)`.
6. **Eliminate Deep Cloning on Line Cache Hits**
   * In [app/tracker.go#L1020](file:///home/some1sm/Coding/arribo/app/tracker.go#L1020), return `c.result.(*Obj)` directly if callers treat it as read-only, avoiding deep object recursion.

---

## 4. Assessment of Node-Compatibility Layers

| Layer | Files | Original Purpose | Current Status | Can Relax Safely? | What Would Break? |
| :--- | :--- | :--- | :--- | :---: | :--- |
| **`fdlibm`** | [app/fdlibm.go](file:///home/some1sm/Coding/arribo/app/fdlibm.go) | Bit-for-bit V8 float math | **Pure Overhead** | **YES** | None. Only older diff-tests checked this. Browser map rendering is unaffected by $10^{-15}$ float variances. |
| **`jscase`** | [app/jscase.go](file:///home/some1sm/Coding/arribo/app/jscase.go) | Multi-rune Turkish/Greek casing | **Pure Overhead** | **YES** | None in Catalonia transit data (Catalan/Spanish stop names). |
| **`qs.go`** | [app/qs.go](file:///home/some1sm/Coding/arribo/app/qs.go) | Express `qs` query parser | **High Overhead** | **Partial** | Must keep compatibility for array queries like `?ids=1,2,3`. Flat queries can use `net/url`. |
| **`passJSON` / `jsonClone`** | [app/jsmap.go](file:///home/some1sm/Coding/arribo/app/jsmap.go) | IPC message serialization | **High Overhead** | **YES** | None. Go goroutines can share immutable pointers safely. |
| **`Obj` / Ordered Keys** | [app/jsobj.go](file:///home/some1sm/Coding/arribo/app/jsobj.go) | Preserving ECMAScript key order | **Moderate Overhead** | **Careful** | Frontend `JSON.parse` does not care about key order. However, regression tests relying on exact raw JSON string comparisons would need updating. |

---

## 5. Open Questions & Risks

1. **SQLite Concurrency in the Worker World (`HistoryDB`)**
   * The worker world is the sole owner of SQLite in WAL mode ([app/worker.go#L189-L195](file:///home/some1sm/Coding/arribo/app/worker.go#L189-L195)). At 50–500× scale, inserting vehicle positions and stop visits for thousands of vehicles will create heavy SQLite WAL write contention. Can single-writer pure-Go SQLite sustain ~10,000 writes/minute while serving analytical queries for the Dades tab?
2. **Provider Polling vs. Streaming Ingestion**
   * Currently, Mataró is polled every 20s via SIRI SOAP ([app/siri.go](file:///home/some1sm/Coding/arribo/app/siri.go)). Catalonia-wide feeds (e.g. AMB, TMB, Rodalies GTFS-RT / SIRI) involve disparate APIs. Polling thousands of lines synchronously in a single worker will encounter upstream rate limits and socket starvation. A distributed or multi-worker worker pool is necessary.
3. **Database Snapshot Backups & Maintenance**
   * The CLI backup uses SQLite `VACUUM INTO` ([OPERATIONS.md#L130](file:///home/some1sm/Coding/arribo/OPERATIONS.md#L130)). On a multi-gigabyte Catalonia-wide database, `VACUUM INTO` will hold locks and cause I/O spikes. A dedicated retention and archival strategy for `stop_visits` and `delay_logs` must be designed early.
