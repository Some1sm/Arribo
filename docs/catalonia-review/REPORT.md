# Scaling Arribo! to all of Catalonia: review

*2026-11-19. Six parallel Gemini 3.8 Flash (High) agents read the code; Claude checked their main claims against the source and wrote this report. The raw agent reports are in [gemini-raw/](gemini-raw/).*

---

## Status: start here in a new chat

*Last updated 2026-11-19.*

**Done**
- [x] This review: six agent lanes, with the main claims checked against the code (Section 7 lists the claims that were wrong).
- [x] Quick wins shipped. Commit `6a8e63c`, merged to `main` as `c365414` (git.lan PR #1), deployed and confirmed live on http://87.106.33.66:3000/:
  - Static files from `public/` are gzip/br-compressed (`app/server.go`, `serveStatic`). `app.js` went from 276 KB to 64 KB gzip.
  - SSE clients keep at most 4 waiting frames, and each frame write has a 30 s deadline (`msgQueue.pushLatest` in `app/worker.go`; `sseMaxQueued` and `sseWriteTimeout` in `app/server.go`).
  - Both are recorded in `app/README.md` under "Deliberate changes made after the Node code was removed".
- [x] The other quick wins were examined and ruled out, with reasons (Section 6, "Update").
- [x] **Section 8 decisions answered by the owner.** In short:
  - Official **and** unofficial sources. Where nothing is public, request the data from the authorities.
  - **Rodalies + FGC first.**
  - **No more RAM;** Postgres is acceptable, or something cheaper.
  - **The planner is in scope** (goal: better than the official planner).
  - **Data-quality tiers: yes.** Always say when data is timetable-only or the real-time feed is poor, and offer alternatives.
- [x] **Phase 0 for Rodalies + FGC: feeds confirmed** (2026-11-19, live requests; see "Verified feeds" below).

**Verified feeds (2026-11-19)**

| Feed | URL | Key | What was seen |
|---|---|---|---|
| Renfe GTFS-RT positions | `https://gtfsrt.renfe.com/vehicle_positions.pb` (also `.json`) | none | National feed: 437 trains, **127 in Catalonia** (R1 31, R4 27, R2S 19, R2N 10, R2 8, R11 8, R15 6, R3 5, R8 4, R16 4, RG1 2, R13/R14/RL4 1), header 36 s old. Each entry has `tripId`, `stopId`, `currentStatus` and a label like `R2S-28385` |
| Renfe GTFS-RT trip updates | `https://gtfsrt.renfe.com/trip_updates.pb` (also `.json`) | none | 442 entries. Trip-level `delay` in seconds: 70 of 117 Catalan trips non-zero, max 3,480 s. Only 1–2 `stopTimeUpdate`s per trip, so per-stop visits must still come from positions |
| Renfe GTFS-RT alerts | `https://gtfsrt.renfe.com/alerts.pb` | none | Present (not parsed yet) |
| Renfe static GTFS (Cercanías) | `https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip` | none | 15.7 MB, all of Spain's Cercanías; filter to Rodalies de Catalunya |
| FGC static GTFS | `https://www.fgc.cat/google/google_transit.zip` | none | 1.1 MB |
| FGC open data (Opendatasoft) | `https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/<id>/records` | none | Datasets `vehicle-positions-gtfs_realtime`, `trip-updates-gtfs_realtime`, `alerts-gtfs_realtime`, `posicionament-dels-trens` (65 trains live: line, lat/lon, direction, next stops, `en_hora` flag), `gtfs_*`, `avisos` |

**Licences and limits** (Gemini web research, 2026-11-19; items marked ✓ re-checked by hand. Raw notes in [gemini-raw/feeds-licences.md](gemini-raw/feeds-licences.md)):
- **Renfe GTFS-RT and static GTFS:** CC BY 4.0 under Spain's public-sector re-use terms ([data.renfe.com/legal](https://data.renfe.com/legal)). Attribution "Origen de los datos: Renfe Operadora" is required; derived statistics are allowed; don't distort the data or imply endorsement. Documented update every 20 s, ✓ `Cache-Control: max-age=30`. No documented rate limit. The feed is Cercanías/Rodalies only (long distance is a separate `vehicle_positions_LD.pb`). The static GTFS has no `feed_info.txt` and many validator warnings (Mobility Database mdb-2653), so import it defensively.
- **FGC static GTFS and open-data API:** CC BY 4.0, with attribution "Ferrocarrils de la Generalitat de Catalunya". ✓ **Anonymous API limit: 5,000 requests a day** (`x-ratelimit-limit: 5000`, resets at 00:00 UTC). Budget it: positions every 30 s is 2,880 a day, plus trip updates every 60 s is 1,440, for 4,320 in total. Register for a key if more is needed.
- **FGC GTFS-RT delivery:** each `*-gtfs_realtime` dataset is a single record whose `file` field points at a `.pb` download. ✓ Vehicle positions: `https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/vehicle-positions-gtfs_realtime/files/d286964db2d107ecdb1344bf02f7b27b` (200, protobuf). The trip-updates and alerts file ids are in the raw notes; resolve the URL from the dataset record at run time rather than hard-coding the id. `posicionament-dels-trens` is plain JSON records, one per train.

**Storage given "no more RAM":** Postgres would need roughly 100–200 MB of its own on a box capped at 400 MB for the app, so the recommendation is to **stay on SQLite** (zero extra RAM): one DB file per month, incremental hourly rollups per (agency, line, stop), and reports that read the rollups. Revisit Postgres only if the VPS gets more memory.

**Open**
- [ ] **Phase 1:** `agency_id` / `mode` columns and an agency registry with only Mataró in it. Zero behaviour change, checked old-vs-new.
  - [x] Step 1 (`82722ef`, branch `phase1/agency-columns`): `agency_id` (default `'mataro'`) and `mode` (default `'bus'`) added to `delay_logs`, `stop_visits`, `vehicle_snapshots` and `gps_gaps` through the column migration in `app/historydb.go`. Not read or written yet.
  - [x] Step 2: the four INSERTs write `agency_id`/`mode` explicitly, from the record's optional `agencyId`/`mode` fields (`rowAgency` in `app/historydb.go`), defaulting to `mataro`/`bus`. This is the hook new ingesters will set.
  - [x] Step 3: both hourly rollup tables are rebuilt once (keeping rows and ids) with `agency_id` and `UNIQUE(agency_id, line_code, date_hour)` (`rebuildRollupsPerAgency` in `app/historydb.go`). The rollup groups, looks up and upserts per `agency_id` (`app/historydb_maint.go`). Still open: the readers in `historydb_gaps.go` (~698, ~730) filter by `line_code` only, so they must filter by agency before a second operator is ingested.
  - [x] Step 4a: `app/agency.go` adds an `Agency` type (id, name, mode, default colour, line matcher) and a list holding Mataró. `getTrackerForLine` resolves through it, and the resolution carries `AgencyID`. Old and new gave identical answers on 19 requests (every line-id form, the 404s, catalog, search, stats, departures).
  - [x] Step 4b (part 1): the seven literal `"1"…"8"` lists (`historydb.go`, `ingestion.go` ×2, `schedlogic.go`, `tracker_avisos.go`, `server.go`) now read `mataroAgency.LineIDs`, and the `siri.go` geofence reads `mataroAgency.Bounds`. Identical answers on 24 requests.
  - [x] Step 4b (part 2a): the `^[1-8]$` regexes in `schedules.go` (`getLineSchedule`), `tracker.go` (`getLineDetails`) and the registry matcher are replaced by `Agency.hasLine` (same ids accepted). `lineIdOf` already reads the agency list. Identical answers on 28 requests.
  - [x] Step 4b (part 2b-i): `mataroScopeSQL` and `mataroVisitsScopeSQL` (the "all lines" scope of every Dades report) and the two `historydb_gaps.go` rollup readers also filter on `agency_id = mataro`. Old and new answered 15 Dades endpoints identically on a seeded DB (672 visits + 672 delay rows over 7 days).
  - [ ] Step 4b (part 2b-ii): `anomalies.go` `lineIDFromCode` (strips a leading L; needs a per-agency rule for codes like R1, S1, T4) and `pollMataroVehicles` becoming a per-agency poller. Both only matter once a second operator exists, so they can come with phase 2.
- [x] Licences and update rates of the Rodalies/FGC feeds checked (see "Licences and limits" above). The owner allows `--yolo` for Gemini delegation.
- [ ] **Phase 2:** GTFS importer (Renfe Cercanías filtered to Catalonia, FGC) into an on-disk SQLite timetable, plus a GTFS-RT ingester for both. Shown in Dades as separate operators with their data-quality tier.
  - [x] Slice 1 (branch `phase2/gtfs-import`): `arribo gtfs-import <agency_id> <gtfs.zip> <out.db> [--bbox minLat,maxLat,minLon,maxLon]` (`app/gtfsimport.go`, with 9 tests in `app/gtfsimport_test.go`). It streams a GTFS zip into a standalone indexed SQLite file. Not wired into the server. Real feeds: FGC 22 routes, 305 stops, 11,675 trips, 136k stop_times in 0.3 s and 26 MB peak RSS (18 MB file); Renfe Cercanías with the Catalonia bbox 40.5,42.9,0.15,3.4 gives 92 routes (R1–R17, RG1, RT1/2, RL3/4), 208 stops, 33,619 trips, 408k stop_times in 1.8 s and 40 MB (43 MB file). Gemini wrote the first draft; Claude fixed silent truncation on CSV read errors and pinned one SQLite connection.
  - [x] Slice 2a: a dependency-free GTFS-RT protobuf decoder (`decodeGtfsRealtime` in `app/gtfsrt.go`, tests in `app/gtfsrt_test.go`) and `arribo gtfsrt-dump <file.pb|url> [--json]`. Checked against Renfe's own JSON for the same snapshot: 330/330 vehicle positions and 336/336 trip updates identical, headers included. It also decodes the FGC feed (44 trains). Gemini wrote the draft; Claude added `VehicleDescriptor.wheelchair_accessible` (field 4), which Renfe sends.
  - [x] Slice 2b: `app/gtfsrtpoll.go` polls Renfe (positions and trip updates every 30 s, positions cut to the Catalonia box) and FGC (positions every 30 s, trip updates every 90 s: about 3,840 requests a day, under the 5,000 limit; the .pb file URL is resolved from the dataset record and cached). Each operator has its own goroutine and keeps its latest snapshot (`rtVehicle` with `AgencyID`/`Mode`, trip delays) behind an atomic pointer: no World lock, no SQLite. **Opt-in with `ARRIBO_GTFSRT=1`** (off by default, so a merge changes nothing). Live test: Renfe 59 trains, 57 with a trip delay; FGC 36 trains. Shutdown is still about 90 ms.
    - Finding: **FGC trip updates carry predicted times only, no `delay`**, so FGC delays must be computed against the imported timetable (slice 3). Renfe sends trip-level delays.
  - [x] Slice 3a: `app/rttimetable.go` opens `ARRIBO_GTFS_DIR/<agency_id>.db` (an imported timetable) read-only and computes a delay as predicted minus scheduled at the first upcoming stop, with service days counted from GTFS's "noon minus 12 h" in Europe/Madrid (DST-tested). The poller uses it when a trip update has no `delay`. Live: FGC trip updates joined 37/37 by trip_id and 123/123 by stop_id; delays computed for 35/35, range 0–154 s (median 0). Renfe's own delays include implausible values (−3,240 s seen), so Dades must filter them.
  - [x] Slice 3b: `app/gtfsrefresh.go` downloads each operator's static GTFS zip and imports it into `<DATA_DIR>/gtfs/<agency_id>.db` (or `ARRIBO_GTFS_DIR`) at start-up when it is missing, and again once it is older than 20 h (checked hourly), one import at a time. A failed refresh keeps the previous file. The poller reopens the timetable when the file changes. Runs only with `ARRIBO_GTFSRT=1`. Live from an empty data dir: Renfe imported in 3.4 s, FGC in 0.5 s; container memory 35–37 MiB throughout (GOMEMLIMIT 128 MiB, 400 MB limit); FGC then computed 31/31 delays (0–142 s). In production the files land in the mounted `./data/gtfs/` (about 60 MB), so they survive redeploys.
  - [ ] Slice 3c: stop visits for Renfe/FGC trains written to the history tables with `agency_id`/`mode` (rail: from trip-update arrival times, not a 30 m GPS radius), then Dades views per operator with data-quality tiers.
  - [ ] Slice 3: match live trains to the imported timetable (trip_id, stop visits), then show them in Dades with their data-quality tier.
- [ ] Unofficial sources and data requests: list the operators with no public real-time feed (Section 3) and draft a request to the relevant authority (ATM / Generalitat).
- [ ] Housekeeping: GitHub `main` has its own merge commit (`11c0998`), with the same tree as git.lan's `c365414`. Reset GitHub `main` to git.lan's before the next mirror push, otherwise it won't fast-forward.

**Ground rules for whoever continues**
- git.lan is the source of truth. A push to `main` there **deploys**. GitHub is a mirror.
- Validate every server change with gofmt, go vet and a build in `golang:1.26-alpine`; npm syntax, lint, test and docs_check in the pinned `node:22.23.4-alpine` image; and old and new binaries side by side on an internal Docker network (no internet).
- Data trust comes first: never infer positions or delays a feed did not report (Section 2).

---

## 0. Summary

1. **This has been tried before and was rolled back.** From August to September 2026 Arribo covered about 1,548 Catalan bus lines plus AMB, Rodalies, Moventis and Sagalés. It was cut back to Mataró on 2026-08-31 (`d93a01f`) after three things went wrong: made-up telemetry (phantom buses, downstream delay extrapolation), getting blocked or rate-limited by unofficial APIs, and memory blowing up (2.1 GB heap, `e169ace`). The rigour built since then (stop visits, telemetry honesty, no ghost logging) is the asset. The plan for Catalonia should protect it.
2. **The Go server is Mataró-only at every layer.** Line ids are hard-coded to L1–L8, coordinates outside Mataró are thrown away, the analytics SQL is pinned to L1–L8, holidays are Mataró's, the geocoder is boxed to Mataró, and the timetable format is maresme.net's. None of this is hard to find; it just touches almost every file.
3. **The biggest structural limit is the single `World` lock** (one mutex standing in for Node's event loop). Every HTTP request and every ingestion step takes it. It is fine for about 20 buses and becomes the ceiling long before Catalonia scale.
4. **The Dades pipeline won't scale as it stands.** Reports recompute from raw `stop_visits` and `delay_logs` on a single SQLite connection, inside the worker that also does ingestion. There is also no agency or transport-mode column, so "L1" (Mataró bus) and "L1" (TMB metro) would collide.
5. **Recommended direction:** adopt GTFS + GTFS-RT as the internal data model, with Mataró's SIRI as one adapter. Namespace every id as `agency:id`. Shard the runtime per agency rather than tearing out the lock everywhere at once. Make the Dades reports read pre-aggregated rollups. Onboard operators **only where an official real-time feed exists**, and label each operator by how good its data is.
6. **Some quick wins help Mataró today:** gzip/brotli for static files, read-only SQLite connections for reports, rollup-based monthly reports, less noise in `delay_logs`, and bounded SSE queues (Section 6).

---

## 1. How this review was done

| Lane | Topic | Raw report |
|---|---|---|
| 1 | Backend coupling to Mataró, data model, `TimetableProvider` proposal | [lane1](gemini-raw/lane1-backend-coupling.md) |
| 2 | History DB, ingestion, the Dades data pipeline at scale | [lane2](gemini-raw/lane2-historydb-dades-pipeline.md) |
| 3 | Frontend and Dades tab UX at scale | [lane3](gemini-raw/lane3-frontend-dades-ux.md) |
| 4 | The retired Catalonia version (old Node code from git history) | [lane4](gemini-raw/lane4-retired-catalonia-archaeology.md) |
| 5 | Open-data research: which operators publish what | [lane5](gemini-raw/lane5-open-data-research.md) |
| 6 | Go server performance and Node-compat overhead | [lane6](gemini-raw/lane6-go-performance.md) |

**Verification.** I re-read the cited code for every blocker and every quick win below. Items marked ✅ were checked against the source. Items marked ⚠️ are Gemini's estimates or claims I could not check. **Lane 5's web research is entirely unverified:** my own web search tool failed during this session, so treat its table as a lead list, not as fact. Section 7 lists the Gemini claims that turned out to be wrong.

---

## 2. Lessons from the retired Catalonia version (lane 4, ✅ commits checked)

**Data sources the old code used** (from `old-catalonia/src/*`, which is the tree at `b7cf3ea^`):

| Source | How it was accessed | What it gave |
|---|---|---|
| Generalitat Mou-te (`mou-te.gencat.cat/MouteAPI/rest/`) | Reverse-engineered `AT` header: md5 of `"mouteapi"` + a timestamp slice (`mouteClient.js:31`) | Stop arrival predictions only, **no GPS** |
| AMB Mobilitat API v2 (`api.ambmobilitat.cat/v2`) | `x-api-key`, with a hard-coded fallback key | Bus positions, stop countdowns, Renfe station boards |
| Moventis SAE (`app.moventis.es/sae/api/posicion/linea/:id`) | Basic auth with the mobile app's built-in credentials (`moventisClient.js:298-301`) | Live GPS for Moventis/Casas lines (e.g. C-10) |
| Moventis web API | Browser-imitating headers | ETAs, routes, timetables |
| Sagalés (`sagales.com/real-time-bus/:route/:dir`) | Public AJAX endpoint (`sagalesTracker.js:215`) | GPS, delay, polyline |
| Rodalies via AMB | AMB key | Station boards and shapes. Renfe GTFS-RT was **not** used |
| ATM static GTFS | Local files indexed into `shapes.db` | 1,548 line geometries, stops, calendars |

**What went wrong:**
- **Fabricated data.** Delays were extrapolated past where telemetry ended, and "bus chains" were built out of ETA countdowns. Removed in `22ba526` (2026-08-21).
- **Upstream limits.** Polling 1,610 lines in batches of 100 per 30 s took more than 8 minutes per sweep (`38f3b10`). It led to 502s and a circuit breaker (`503eab5`).
- **Memory.** In-memory GTFS caused a 2.1 GB V8 heap. It was fixed by moving shapes into SQLite (`e169ace`).
- **Data trust.** Raw 20 s polls were counted as arrivals ("169,595 trips" in 7 days), and provider error codes like -15 were averaged as real delays (`docs/history/DATA_TRUST_IMPLEMENTATION_PLAN.md`).

**Take forward:**
- Never infer positions or delays the feed did not report.
- Never poll thousands of lines one request at a time.
- Never load full GTFS into the heap.
- Prefer official feeds over reverse-engineered app credentials: Mou-te's token scheme, the Moventis app login and AMB's fallback key can all be revoked at any time, and some may break those services' terms.

---

## 3. Data sources: what can actually be measured (lane 5, ⚠️ unverified)

Gemini's verdict, to be checked against the operators' own portals before any work starts:

| Network | Static | Real time | Can delays be measured? |
|---|---|---|---|
| FGC | GTFS, open (CC-BY) | GTFS-RT positions + trip updates | Yes |
| Renfe Rodalies | GTFS (data.renfe.com) | GTFS-RT positions + trip updates | Yes; GPS is lost in the Barcelona tunnels |
| TMB bus + metro | GTFS (developer.tmb.cat, `app_id`/`app_key`) | iBus REST; GTFS-RT claimed | Bus yes; metro uncertain |
| TRAM | GTFS | Registration needed | Probably |
| AMB metropolitan buses | GTFS | Trip updates; vehicle GPS restricted | Partly (stop-level) |
| ATM integrated feed | Unified GTFS | Trip updates + alerts | Partly |
| Generalitat interurban buses | GTFS (900+ lines) | Mostly closed (Mou-te app only) | **Mostly timetables only** |
| City buses (Sabadell, Terrassa, Girona, Lleida, Tarragona, Reus) | Varies | Mostly proprietary apps | **Mostly no** |
| Mataró (today) | Scraped maresme.net | Avanza SIRI | Yes |
| Bicing | — | GBFS | No timetable, so no delays |
| Holidays | dadesobertes.gencat.cat | — | Needed for every municipality |

**What this means for the product:** "everything that's public" splits into three tiers, and the Dades tab should show which tier an operator is in rather than mixing them:

1. **Measured:** real vehicle positions or official trip updates (FGC, Rodalies, TMB bus, Mataró). Full punctuality statistics.
2. **Predicted:** stop-level ETAs only. Show them, but label them, and keep them out of punctuality rankings or show them separately.
3. **Timetable only:** show the schedule, and no delay statistics at all.

This is the "telemetry honesty" rule from CLAUDE.md applied to a whole operator.

---

## 4. Findings by area

### 4.1 Backend coupling to Mataró (lanes 1, 4, 5) ✅

| # | Where | What | Severity |
|---|---|---|---|
| B1 | `app/registry.go:38-66` | Line resolution accepts only `^l?[1-8]$`; agency is hard-coded "Mataró Bus" and `IsTrain:false` | Blocker |
| B2 | `app/schedules.go:432-478`, `app/schedlogic.go:698,767-809`, `app/anomalies.go:780` | Line-id normalisation and revenue-service checks assume lines 1–8; `lineIDFromCode` strips a leading "L" (wrong for metro L1 or FGC L6) | Blocker |
| B3 | `app/ingestion.go:299-300` | `pollMataroVehicles` polls the literal list 1–8 | Blocker |
| B4 | `app/siri.go:92-94, 604` | `isValidMataroCoord` drops every fix outside the Mataró box | Blocker |
| B5 | `app/siri.go:65-85, 693-703` | One Avanza SIRI endpoint; `normalizeStopId` adds 1000 to numeric ids; no GTFS-RT decoder exists | Blocker |
| B6 | `app/schedules.go:83-142, 317-341` | Timetables are the maresme.net season grid (`Feiners`/`Dissabtes`/`Diumenges i Festius`, trip index = row index). GTFS `calendar_dates` and `frequencies` can't be represented | Major |
| B7 | `app/calendar.go:150-183` | Holidays are a single set: 12 regional + exactly 2 local (Mataró) | Major |
| B8 | `app/walkgeo.go:243, 347` | Photon geocoder boxed to Mataró's bbox with a 12 km radius | Major |
| B9 | `app/planner.go:722-793` | Transfer search: origin × destination × route × stops × route × stops, with a haversine in the inner loop. Fine for 16 route directions; impossible for about 3,000 | Blocker for the planner |
| B10 | `app/server.go`, `/api/mataro/*`, `hHealth` | Mataró aliases and labels in routes and responses | Minor |

**On `ARCHITECTURE_NEXT.md`'s `TimetableProvider` proposal:**
- It's the right idea but too narrow. Its `dayType` enum and `tripIndex` integer copy the maresme grid.
- Real GTFS needs `service_id` evaluated against `calendar` plus `calendar_dates`, string `trip_id`s, branches and short turns, and `frequencies.txt` for metro and tram.
- It also needs a real-time side (GTFS-RT `TripUpdate` matched by `trip_id` + `stop_sequence`), which the proposal doesn't model.
- Catalonia's `stop_times` is about 10⁷ rows, so it must live on disk (SQLite with indexes), not in `*Obj` trees.

### 4.2 The `World` lock and concurrency (lanes 1, 2, 6) ✅

- `app/server.go:71-73`: `ServeHTTP` holds `s.w.mu` for the whole `dispatch`, and I/O is released only through `await`. All route matching, JSON building and in-memory lookups therefore run one request at a time.
- `app/worker.go` and `app/ingestion.go`: the worker world does polling, flight-recorder updates **and** every Dades report query, under its own lock and on **one** SQLite connection (`app/historydb.go:398`, `SetMaxOpenConns(1)`). A slow report delays polling.
- **Recommendation:** don't try to remove the lock from 30k lines in one go. The port relies on it for ordering. Instead:
  - (a) give each agency its own world: one tracker, one poller, one lock;
  - (b) serve fleet and catalog reads from immutable snapshots swapped in atomically (`atomic.Pointer`), outside any lock;
  - (c) move report queries to separate read-only SQLite connections, which WAL mode allows, outside the ingestion lock.

### 4.3 History DB and the Dades pipeline (lane 2) ✅ with corrected estimates

- **Schema** (`app/historydb.go:434-590`): `vehicle_snapshots`, `delay_logs`, `stop_visits`, two hourly rollup tables, `gps_gaps`, and a leftover `amb_bus_observations`.
  - There is no `agency`/`mode` column in `stop_visits` or `gps_gaps`, and stops are keyed by `stop_name`.
  - The rollups are `UNIQUE(line_code, date_hour)`, so line codes from different operators would collide.
- **Scope pinned in SQL** (`app/historydb.go:102-128`): `mataroScopeSQL` / `mataroVisitsScopeSQL` add `line_code IN ('L1'…'L8')` to the "all lines" queries.
- **`delay_logs` gets one row per bus per poll** (`app/ingestion.go:563-577`), even when nothing changed. `stop_visits` (one row per bus per stop) is the real measurement, and is much smaller.
- **Reports recompute from raw tables.**
  - The monthly and journalism reports scan `stop_visits` and `delay_logs` (`app/historydb_monthly.go:48,321-410`, `app/historydb_report.go:204,828-860`).
  - The existing `hourly_line_visit_stats` rollup is read only by the GPS-gaps code (`app/historydb_gaps.go:698`).
  - `generateAllReports` rebuilds the 24 h, 48 h and 168 h reports every 30 minutes.
- **Go functions are called per row inside SQL:** `madrid_hour`, `madrid_datetime` and `is_telemetry_anomaly` (registered at `app/historydb.go:338-381`, used about 32 times across the history files). `is_telemetry_anomaly` also checks Mataró service hours, so it is Mataró-specific.
- **Large in-memory reads:** `LIMIT 200000` in `historydb_phantom.go:446`, `LIMIT 30000` in incident clustering (already streamed), and per-stop × 24 h buckets in the journalism report.
- **Scale estimate (⚠️ Gemini's numbers).**
  - At about 4,000 vehicles: roughly 300–450 inserts/s and 2–3 GB/day if `delay_logs` keeps logging every poll.
  - Most of that is `delay_logs` noise. With change-only logging, stop visits come to roughly 1.6–2.5 M rows/day.
  - Gemini also says today's DB is about 350 MB; CLAUDE.md says about 200 MB.
- **Storage engine, my view:**
  - Gemini's lane 2 says SQLite can't do this and recommends Postgres + TimescaleDB.
  - I'd stage it. SQLite is still fine for a first expansion of a few hundred vehicles, *if* writes are batched, reports read rollups on read-only connections, and raw data is partitioned (for example one DB file per month or per agency).
  - Plan the move to Postgres/Timescale or ClickHouse for the full network. Mainly that buys compression and continuous aggregates; raw speed matters less.
  - The bigger change is the same either way: **make the Dades reports incremental.**

### 4.4 Frontend and the Dades tab (lane 3) ✅

**Hard-coded to Mataró:**
- `public/js/app.js:484-508` has fallback lines 1–8.
- The line cache is capped at 8 entries (`app.js:34,163`).
- `networkMap.js:23` only recognises line codes matching `^L?\d+$`.
- `app.js:5198-5205` fetches every line's geometry in one go.
- CSS has `--line-1..8`, `.line-chip-1..8` and an 8-column gap grid (`public/css/style.css:474-489, 10606+`).
- The map is centred on Mataró (`map.js:84`).
- Geolocation outside Mataró is ignored (`stopFeatures.js:75`).
- `MATARO_ZONES` and calls to `/api/mataro/plan`, `/api/mataro/stop/...` and `/api/mataro/stops/nearby` are baked in.

**Scale problems:**
- **One SSE stream sends the whole fleet** (`app.js:5327`), and the client filters it. At 3,000+ vehicles that is about 1–2 MB per tick (⚠️ estimate). Needs per-bbox or per-line channels and delta updates.
- **Vehicles are DOM markers** (`L.divIcon`) animated every frame. Thousands of them need canvas or WebGL drawing (Leaflet canvas circle markers, or MapLibre GL) plus culling to the visible area.
- **Two very large single files:** `app.js` is 276 KB and `observatori.js` is 259 KB.

**What Dades has today:**

| View | Endpoint |
|---|---|
| Historical report | `/api/analytics/journalism?hours=24/48/168` |
| Data health | `/api/data-health` |
| GPS loss map | `/api/analytics/gps-gaps`, `…/paths`, `…/passes` |
| El Termòmetre | `/api/analytics/termometre` (a single grade) |
| Incidents and drill-down | `/api/analytics/incidents`, `…/inspect` |
| Monthly report | `/api/analytics/report/monthly`, written for the Ajuntament de Mataró |
| CSV exports | `/api/analytics/export/csv`, `…/visits.csv` |

**How Dades should evolve:**
- A filter bar: **territory (ATM area) → mode → operator → line → stop**.
- An operator league table built from `agencyStats`.
- A Termòmetre per mode or operator instead of one blended grade.
- Heatmaps limited to one corridor or the top N stops, with virtual scrolling (480k cells for 20k stops would crash the page).
- Rodalies-style incident timelines grouped by corridor.
- Shareable URLs for every view.
- The data-quality tier (Section 3) shown on every number.
- Catalan stays the main language; Spanish and English need a string table (today Catalan is hard-coded in the HTML).

**Small finding:** `observatori.js:323` hard-codes a Carto basemap key in client code. At regional traffic it could run into quota or domain limits. Worth checking the Carto account's terms.

### 4.5 Go performance (lane 6) ✅ unless marked

| # | Finding | Verified | Value |
|---|---|---|---|
| P1 | **Static files are served without compression**: `serveStatic` runs before `runRoutes` sets `res.compress = true` (`app/server.go:123,187`). ⚠️ Check whether the reverse proxy in front already compresses | ✅ | High, small change |
| P2 | Every response hashes its body with SHA-1 for an ETag (`app/express.go:227`), including large reports. Express does the same, so this was kept for parity | ✅ | Medium |
| P3 | Each SSE client's queue grows without limit; there's no drop policy and no write deadline (`app/worker.go:59-80`, `app/server.go:770-785`). A stalled phone keeps piling up frames until TCP gives up. Cap is 200 streams total, 8 per client | ✅ | Small for Mataró, mandatory at scale |
| P4 | `passJSON`/`jsonClone` deep-copies every message between the two worlds, though both share one address space | ✅ | Medium at scale |
| P5 | `GOMEMLIMIT=128MiB` plus a 30-second `FreeOSMemory` loop (`app/memtrim.go`) is right for Mataró but will thrash with a Catalonia-sized live set | ✅ | Revisit when scaling |
| P6 | `getLineDetails` deep-copies on every cache hit (`app/tracker.go:1020-1045`) | ✅ (per Gemini's citation) | Low |
| P7 | `serveStatic` stats a file under `public/` before every `/api/*` request | ✅ | Low (a cheap failed stat), easy fix |
| P8 | The Node-compat layers (`fdlibm`, `jscase`, `qs`, ordered `Obj`) are overhead now that Node is gone | Partly | See Section 7 |

---

## 5. Recommended roadmap

Order matters: each phase is useful on its own, and Mataró keeps working throughout.

**Phase 0: decide and verify (no code)**
- Confirm the real feeds and their terms with the operators (Section 3). Start with FGC, Rodalies and TMB bus: the networks that can be measured.
- Decide whether reverse-engineered sources (Mou-te, the Moventis app login, AMB's fallback key) are off-limits. I recommend yes.
- Pick the first expansion target. A good candidate is **Rodalies R1 plus FGC**: a few hundred trains, open GTFS-RT, and riders who care a lot about delays. Mataró sits on R1, so it fits.

**Phase 1: a multi-agency data model (L)**
- `agency_id` and `route_type` everywhere; ids as `agency:route`, `agency:stop`, `agency:trip`.
- Add `agency_id` and `mode` (and `stop_id`, `trip_id`) to `stop_visits`, `delay_logs`, `gps_gaps` and the rollups; rollups become `UNIQUE(agency_id, line_code, date_hour)`.
- Replace `mataroScopeSQL` with an agency filter.
- Remove the L1–L8 regexes (B1, B2) and the Mataró geofence (B4); bounding boxes become per agency.

**Phase 2: GTFS + GTFS-RT ingestion (L)**
- A GTFS importer into an indexed on-disk timetable DB, with calendars resolved through `service_id` and `calendar_dates`.
- A GTFS-RT adapter (protobuf: VehiclePositions, TripUpdates, Alerts) next to the existing SIRI client, behind one `IngestionSource` interface, with one poller per agency.
- Stop-visit detection for trains: a 30 m radius with 20 s polling misses stations at 100 km/h, so use TripUpdates arrival times or interpolate along the track.
- Mode-specific punctuality rules: Rodalies is commonly judged on time at ≤5 min; for metro, regular headways matter more than the timetable.
- A holiday calendar per municipality from Generalitat open data, linked through each stop's municipality.

**Phase 3: concurrency and storage (M–L)**
- One world per agency; snapshot reads (Section 4.2).
- Batched writes; `delay_logs` only on change; report queries on read-only connections.
- Incremental rollups per (agency, line, stop, hour). All Dades reports read rollups, and raw data is kept 30–90 days.
- Re-evaluate SQLite against Postgres/Timescale at the first phase-3 milestone.

**Phase 4: frontend for many operators (M–L)**
- A catalog API with search, so the client doesn't download every line.
- SSE channels per area and per line with delta frames; canvas or WebGL vehicles with culling.
- Colours from GTFS `route_color`; an initial map view based on where the user is.
- The new Dades filter bar, league tables and data-quality labels (Section 4.4).

**Phase 5: a planner for many operators (L)**
- Replace the direct + one-transfer brute force with RAPTOR or CSA over the GTFS timetable, plus a spatial index for nearby stops.
- Keep the current planner for Mataró until it is replaced.

---

## 6. Quick wins (useful now, for Mataró)

| Change | Where | Gain | Risk |
|---|---|---|---|
| Compress static files (check the proxy first) | `app/server.go:123/187` | Much smaller JS/CSS on mobile | Low; HTML output changes, so the old-vs-new binary comparison will differ on headers |
| Skip `serveStatic` for `/api/*` | `app/server.go:123` | One less stat per API call | Low |
| Report queries on a read-only SQLite connection | `app/historydb.go:398` | Reports stop delaying ingestion | Medium (touches the "worker only opens SQLite" rule; keep it worker-side) |
| Monthly and journalism reports from `hourly_line_visit_stats` | `app/historydb_monthly.go`, `historydb_report.go` | Much faster reports | Medium; rollups lack some splits (see `historydb_gaps.go:758`) |
| Store `madrid_hour` (and an anomaly flag) at insert time | `historydb.go`, ingestion | Removes per-row Go calls from aggregations | Low–medium; needs a backfill |
| `delay_logs` only when the delay or stop changes | `app/ingestion.go:563` | Far fewer writes and a smaller DB | Low; check which reports read `delay_logs` |
| Bounded SSE queue that drops old frames and sets a write deadline | `app/worker.go:59`, `server.go:770` | No memory growth from stalled clients | Low |
| Stream CSV exports instead of building them in memory | `app/historydb_monthly.go:353` | No heap spikes of tens of MB | Low |
| Plain prefix checks instead of regexes in the rate limiter | `app/httpguard.go:226` | Tiny | Low |

**Update (same day): the first two were implemented on branch `perf/quick-wins`.** Static compression and the bounded SSE queue with a write deadline are done and validated (gofmt, go vet, build, npm syntax/lint/test/docs, an old-vs-new probe on an isolated Docker network, and a unit test for the queue). Reading the code more closely ruled the rest out as quick wins:
- **Read-only connection for reports:** report queries run synchronously inside the worker lock (`app/worker.go` dispatch → `executeDbOperation`), so a second connection alone would not stop them blocking polling. It belongs with the lock work in Phase 3.
- **`delay_logs` only on change:** about 30 queries read it (phantom detection, incident clustering, the inspector, GPS gaps, monthly sample counts) and depend on every poll sample. Thinning it would change what they detect.
- **Rollup-based reports, storing `madrid_hour` at insert:** these change report numbers or need schema migration and backfill. They are product and schema work, not quick wins.
- **Skipping `serveStatic` for `/api/*`, regexes in the rate limiter:** the gain is negligible (one failed stat; regexes compiled once) and edge cases would change (`/api/../index.html`, case-insensitive matching).
- **Streaming CSV:** the worker builds the CSV and sends it over the bridge, so streaming needs bridge changes.

Remember that a push to `main` deploys.

---

## 7. Corrections to the Gemini reports

| Claim | Reality |
|---|---|
| Lane 3: "Flip `showTrainsInUI = true` to show train data the backend already processes" | **Wrong.** The backend produces no trains (`IsTrain:false` everywhere in `registry.go`). The flag only hides an empty category |
| Lane 6: "`vehicleHistory` is never evicted" | **Wrong.** It is pruned lazily per line and direction after 90 s, and synthetic entries are removed (`app/tracker_line.go:747-766`) |
| Lane 2: the Go SQL functions are "non-deterministic" | **Wrong.** They are registered as deterministic (`RegisterDeterministicScalarFunction`). The cost is calling Go per row, not lost determinism |
| Lane 6: the `os.Stat` on every API call is "Major" | **Overstated.** It is a cheap failed stat; still worth removing |
| Lane 6: "replace `jscase` with `strings.ToUpper`, nothing breaks" | **Risky.** JS and Go uppercase some characters differently (`ß` → `SS` in JS), and stop names flow into ids and matching. Low value, so leave it until there are server tests |
| Lane 6: "`fdlibm` is 3–5× slower" | **Unmeasured.** Plausible, but geometry is not the bottleneck; benchmark before changing |
| Lane 6: "key order doesn't matter, switch to structs" | True for the browser, but CLAUDE.md's comparison method relies on byte-identical output. Doable, but the way changes are checked has to change first |
| Lane 2: all storage numbers | Gemini's estimates (Section 4.3); today's DB size disagrees with CLAUDE.md |
| Lane 5: the whole open-data table | **Unverified**; phrases like "zero jitter" are not evidence |

---

## 8. Decisions only you can make

1. **Sources:** official feeds only, or also unofficial and reverse-engineered APIs (the old approach)? Do both, if public sources arent available we have to ask for them to the authorities. because its public data they must provide it.
2. **First expansion:** which network first? My suggestion is Rodalies + FGC, or TMB bus. Rodalies + FGC sounds good.
3. **Infrastructure:** stay on the single VPS with SQLite for now, or budget for Postgres/Timescale and more RAM (Gemini suggests 2–4 GB for a full Catalonia live set)? we could budget for postgres, or if you know of a cheaper alternative thats also completely valid we could investigate it. we are not getting more RAM for now so we will optimize as much as possible. I´m making this project so people can see how efficient a tool can be done by a single user with AI. 
4. **Product:** is the planner part of the Catalonia scope, or is Arribo a *delay observatory and live map* first? Dropping the planner from scope removes the largest single rewrite (Phase 5). It is part of it, idea is getting a better planner than officially provided by government. with real data from everywhere possible.
5. **Data-quality tiers:** do you accept showing "timetable only" operators with no delay statistics? YES. i want users to 100% trust this app/tool. If schedules are just timetables or if the realtime is bad, please make sure to point it out and provide alternatives.
