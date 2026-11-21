# Scaling Arribo! to all of Catalonia: review

*2026-11-19. Six parallel Gemini 3.8 Flash (High) agents read the code; Claude checked their main claims against the source and wrote this report. The raw agent reports are in [gemini-raw/](gemini-raw/).*

---

## Status: start here in a new chat

*Last updated 2026-11-20.*

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
  - [x] Fix (2026-11-20): the per-line and per-stop Mataró readers of `stop_visits` filtered by line code only, and FGC's L6, L7 and L8 share Mataró's codes, so with rail polling on, Mataró's L6–L8 line stats (`getLineDelayStats`, the line header's "Retard 24h") and per-line incidents counted FGC station visits. They now also filter `agency_id = mataro` (`mataroAgencySQL` in `app/historydb.go`; used in `historydb_gaps.go` ×3 and `historydb_incidents.go`). `app/agencyscope_test.go` seeds Mataró and FGC L6 visits: before the fix Mataró L6 showed 12 visits and a 45 min maximum, after it its own 6. The `delay_logs` readers need no change (rail writes only `stop_visits`), the "all lines" scope already had the agency term, and the CSV export and monthly report use `mataroVisitsScopeSQL`. Data already written is unaffected: the readers simply stop counting FGC rows.
  - [ ] Step 4b (part 2b-ii): `anomalies.go` `lineIDFromCode` (strips a leading L; needs a per-agency rule for codes like R1, S1, T4) and `pollMataroVehicles` becoming a per-agency poller. Both only matter once a second operator exists, so they can come with phase 2.
- [x] Licences and update rates of the Rodalies/FGC feeds checked (see "Licences and limits" above). The owner allows `--yolo` for Gemini delegation.
- [ ] **Phase 2:** GTFS importer (Renfe Cercanías filtered to Catalonia, FGC) into an on-disk SQLite timetable, plus a GTFS-RT ingester for both. Shown in Dades as separate operators with their data-quality tier.
  - [x] Slice 1 (branch `phase2/gtfs-import`): `arribo gtfs-import <agency_id> <gtfs.zip> <out.db> [--bbox minLat,maxLat,minLon,maxLon]` (`app/gtfsimport.go`, with 9 tests in `app/gtfsimport_test.go`). It streams a GTFS zip into a standalone indexed SQLite file. Not wired into the server. Real feeds: FGC 22 routes, 305 stops, 11,675 trips, 136k stop_times in 0.3 s and 26 MB peak RSS (18 MB file); Renfe Cercanías with the Catalonia bbox 40.5,42.9,0.15,3.4 gives 92 routes (R1–R17, RG1, RT1/2, RL3/4), 208 stops, 33,619 trips, 408k stop_times in 1.8 s and 40 MB (43 MB file). Gemini wrote the first draft; Claude fixed silent truncation on CSV read errors and pinned one SQLite connection.
  - [x] Slice 2a: a dependency-free GTFS-RT protobuf decoder (`decodeGtfsRealtime` in `app/gtfsrt.go`, tests in `app/gtfsrt_test.go`) and `arribo gtfsrt-dump <file.pb|url> [--json]`. Checked against Renfe's own JSON for the same snapshot: 330/330 vehicle positions and 336/336 trip updates identical, headers included. It also decodes the FGC feed (44 trains). Gemini wrote the draft; Claude added `VehicleDescriptor.wheelchair_accessible` (field 4), which Renfe sends.
  - [x] Slice 2b: `app/gtfsrtpoll.go` polls Renfe (positions and trip updates every 30 s, positions cut to the Catalonia box) and FGC (positions every 30 s, trip updates every 90 s: about 3,840 requests a day, under the 5,000 limit; the .pb file URL is resolved from the dataset record and cached). Each operator has its own goroutine and keeps its latest snapshot (`rtVehicle` with `AgencyID`/`Mode`, trip delays) behind an atomic pointer: no World lock, no SQLite. **Opt-in with `ARRIBO_GTFSRT=1`** (off by default, so a merge changes nothing). Live test: Renfe 59 trains, 57 with a trip delay; FGC 36 trains. Shutdown is still about 90 ms.
    - Finding: **FGC trip updates carry predicted times only, no `delay`**, so FGC delays must be computed against the imported timetable (slice 3). Renfe sends trip-level delays.
  - [x] Slice 3a: `app/rttimetable.go` opens `ARRIBO_GTFS_DIR/<agency_id>.db` (an imported timetable) read-only and computes a delay as predicted minus scheduled at the first upcoming stop, with service days counted from GTFS's "noon minus 12 h" in Europe/Madrid (DST-tested). The poller uses it when a trip update has no `delay`. Live: FGC trip updates joined 37/37 by trip_id and 123/123 by stop_id; delays computed for 35/35, range 0–154 s (median 0). Renfe's own delays include implausible values (−3,240 s seen), so Dades must filter them.
  - [x] Slice 3b: `app/gtfsrefresh.go` downloads each operator's static GTFS zip and imports it into `<DATA_DIR>/gtfs/<agency_id>.db` (or `ARRIBO_GTFS_DIR`) at start-up when it is missing, and again once it is older than 20 h (checked hourly), one import at a time. A failed refresh keeps the previous file. The poller reopens the timetable when the file changes. Runs only with `ARRIBO_GTFSRT=1`. Live from an empty data dir: Renfe imported in 3.4 s, FGC in 0.5 s; container memory 35–37 MiB throughout (GOMEMLIMIT 128 MiB, 400 MB limit); FGC then computed 31/31 delays (0–142 s). In production the files land in the mounted `./data/gtfs/` (about 60 MB), so they survive redeploys.
  - [x] Slice 3c-i: `app/railvisits.go` turns trip updates into station visits for trains: a stop listed in its trip's update keeps its latest predicted and scheduled time and closes when it leaves the list (the train passed it) or is predicted more than 2 min ago. Delays outside −10 / +90 min are dropped and counted. Renfe is limited to trips in the Catalonia timetable. Closed visits wait in a bounded queue (5,000) in the poller; nothing is written yet. Unit-tested. Live, 10 min: Renfe 229 visits closed (60 implausible), FGC 136 (0 implausible), 33 MiB.
    - Finding: Renfe's implausible values are large "early" delays (−12 to −54 min) clustered at a few stations (e.g. 71802, 78710) and repeated as the trip delay; most likely a feed quirk (a trip id matched to another departure). Worth a closer look before trusting Renfe's early side.
    - Resolved (2026-11-21, `stuTimes` in `app/railvisits.go`): the "early" values come from trains **waiting at their origin**. While a train waits, Renfe predicts it at the next stop before it is even scheduled to leave (one live snapshot: 10 of the 13 trains waiting at their origin, 9 to 73 min "early"; 71802 and 78710 are simply the second stops of many trips). Those between −5 and −10 min passed the bound and were recorded as early arrivals. Now, with the stop in the imported timetable: a prediction for a later stop earlier than the trip's scheduled origin departure (60 s slack) is rejected; the delay is the predicted time minus the **timetable's** scheduled time, not Renfe's `delay` field (which is whole minutes, and in a few updates contradicts its own time); an update whose `delay` differs from that by more than 5 min is dropped as contradictory (seen: "6 min early" by its delay, 14 min late by its time). Replay of a live snapshot (94 Catalan trips, 91 stop updates): old code 4 fake early visits recorded; new code 15 updates rejected, 2 small early ones kept (−1.5 and −3 min). Unit test `TestStuTimesTimetableChecks`. Rows already written are not corrected: a few early Rodalies visits of −1 to −10 min since slice 3c-ii may be this artefact.
  - [x] Slice 3c-ii: every 30 s a daemon task (under the worker lock, so only the worker writes SQLite) drains the queued visits into `stop_visits` with `agency_id`/`mode`, line code (route short name) and station name from the timetable, `measured_method = gtfsrt_trip_update`, `times_source = gtfsrt`; `vehicle_id` holds the trip id. The late bound was raised to +3 h after the owner reported daily Rodalies delays of an hour or more (the early bound stays at −10 min). Live, 6.5 min: FGC 96 visits (9 lines, 48 stations, avg 0.7 min, max 3); Rodalies 167 visits (10 lines, 35 stations, **avg 19.8 min**, max 56); Mataró's own rows kept being written under `mataro`, and Mataró's reports stay Mataró-only through the agency filter.
  - [x] Slice 3d: a "Trens: Rodalies i FGC" section in Dades (`public/js/operators.js`, token-only CSS `.op-*`), fed by the new `/api/analytics/operators?hours=24|168` (`app/historydb_operators.go`, worker op `getOperatorReport`, 60 s cache). Per operator: punctuality (rail on time = ≤ 5 min, stated on screen), average and maximum delay, station visits, trains, a delay-bucket bar, a per-line table (worst first), the 10 worst stations, where the delay comes from (a "D'on surt aquest retard?" disclosure), and the live feed state (trains now, data age, impossible values dropped). Hidden while no train data exists, so a Mataró-only deployment looks unchanged. Asset version 9.4.45 → 9.4.46 in `sw.js` and all three HTML pages. Old vs new: the 15 existing Dades endpoints are identical. Live after 5 min: Rodalies 24.2 % on time, average +24.1 min, R2S +46.8 min; FGC 100 %, +0.6 min. Checked on desktop and at 375 px (no horizontal scroll).
- [x] **Data-trust bug fixed:** with no report (or one without a termòmetre), `hTermometre` (`app/server.go`) used to answer with made-up numbers: grade A, 92 % punctuality, a fictional "worst bottleneck" (Pl. de les Tereses, L2). It now answers `noData: true` with a reason and nulls, using the same keys as a real termòmetre. Checked old vs new with an unusable database (old: the fake scorecard; new: no data), the normal path identical on 16 endpoints, and the page shows its "Sense dades per puntuar" card.
  - [ ] Slice 3: match live trains to the imported timetable (trip_id, stop visits), then show them in Dades with their data-quality tier.
- [ ] Unofficial sources and data requests: list the operators with no public real-time feed (Section 3) and draft a request to the relevant authority (ATM / Generalitat).
- [x] Housekeeping: GitHub's extra merge commit (`11c0998`) was merged into `main` (2026-11-19), so both remotes fast-forward again.
- [x] **Phase 3, storage bit 1: visit indexes per operator** (2026-11-21, `app/historydb.go` migration). Rail now writes about 47,000 station visits a day (Rodalies 24k, FGC 23k) against Mataró's 9,400, so with 30 days kept `stop_visits` heads for about 1.7 million rows, and with only `(last_ts, line_code)` and `(stop_name, last_ts)` every Mataró report also read every train row in its window. `(agency_id, stop_name, last_ts)` replaces `(stop_name, last_ts)` (the one query filtering by stop names also filters by agency) and `(agency_id, last_ts)` is added. Synthetic 30-day table at today's volume, with ANALYZE (production runs `PRAGMA optimize`): Mataró per-stop 7 d 272 → 57 ms and 30 d 1,346 → 252 ms, counts about 2× faster, a Rodalies line's stations 285 → 131 ms; one query slower (Rodalies per-station 24 h, 18 → 33 ms, behind the 60 s cache); file +23 %. Old vs new binary on the same seeded database (an old-schema DB with 20k Mataró and 60k train visits, FGC L6 sharing Mataró's code and stop names), frozen clock, no network: 30 Dades responses, 0 mismatches. Next for storage: hourly rollups per (agency, line, stop) so the long windows stop grouping raw rows.
- [x] **Train directions and destinations** (2026-11-21). Neither Renfe's nor FGC's GTFS has a `direction_id` column, so every trip and live train had an unknown direction: each rail line had one "direction" holding both ways, and the line view's default one-direction mode showed **no trains** (production: R1 0 trains with 19 running; only "both directions" showed them). Renfe trips also have no headsign, so station departures had no destination. The importer now (`app/gtfsdirections.go`) infers directions per line (route short name; Renfe splits a line into a route per direction) from the operator's own station order (parent stations; FGC has a platform per direction): the longest trip is direction 0, and directions spread to trips sharing two stations with an oriented one, so R3's Barcelona section is reached through trips spanning both sections. A trip with no such overlap stays unknown (R3's 2,450 two-stop Vic - Fabra i Puig services, plus a few hundred on R4/R13/R16). Lines whose trips carry a `direction_id` keep the operator's. Trips without a headsign get their last station's name. Result: FGC 12,085 of 12,085 trips oriented, Renfe 30,881 of 33,784. `trips(trip_id)` gets an index (the per-trip updates and the live trip lookups scanned the table; Renfe import 41 s -> 5 s). `gtfs_meta.import_format` = 2: older timetables are re-imported at the next check. Live test against the real feeds: R1 11 + 10 trains named "Cap a L'Hospitalet de Llobregat" / "Cap a Maçanet-Massanes", R2S 9 + 9, R3 4 + 2; Mataró's R1 departures carry destination, direction and delay; FGC departures at Gràcia split Pl. Catalunya / Terrassa or Sarrià. 30 Dades requests identical to production. (FGC showed no trains during the test because its own feed was 208 s old, past the 180 s cutoff; production showed the same.)
  - FGC freshness: FGC publishes a new positions file only about every 2 minutes, each already 1.5-2 minutes old (source ages 122-222 s; about 209 s as served), so with the 180 s "stale" bound every FGC train was hidden for much of each cycle (production showed 0 FGC trains on S1 and L6 after the direction fix). The bound is now per operator (`trainStaleAfter` in `app/trains.go`): FGC 300 s, Renfe still 180 s; `/api/trains` gives each operator's `staleAfterSec`, and trains keep their `ageSec`. Live for 2 minutes: S1 5 + 3, S2 5 + 4, L6 1 + 1, R5 2 + 2 trains throughout, ages 145-234 s.
  - Landing page (9.4.63): the line grid listed only the trackable lines (`availableLines`: Mataró's 8), so Rodalies and FGC were reachable only through the line picker and the network map. It now lists the line picker's lines (`pickerLines()`: Mataró plus every openable train line), grouped by operator, with train lines opening by their `lineRef`; long groups show 8 lines and a "Mostra les N línies" button (all of them while searching), and the hero search filters train lines too ("Terrassa" finds RL4 and FGC S1). Renfe names lose their file padding on the cards. The train card no longer says station timetables are "not available yet" (they are, from the station's modal); it says to tap a station. Station search is still Mataró-only (`/api/search/stops` knows only Mataró's stops): a server task. The i18n test checks the asset versions are in sync instead of a literal version.
  - Station search (9.4.64): `/api/search/stops` also returns train stations (`app/railstations.go`), from the line profiles in memory (no database, no lock): accents and case ignored, name prefixes first, then stations with more lines; each result opens the station on its first line (`lineId` = lineRef, `stopId` as that line lists it) and names the lines in `zone` ("Rodalies · R1, R2N, …"). The client's `showTrainsInUI` filter is on, and station codes (platform ids like GR1) are not shown. "Sants" finds Barcelona-Sants with 10 Rodalies lines; clicking it opens R1 and the station's departures.
  - Map, filters and train views (9.4.65): bus markers scale with the network map's zoom (38 % over the region, full size from zoom 14; zoom classes on the container, no inline styles); the map draws every train line's path from `/api/network/rail-routes` (39 lines, 21 KB gzip) under the buses; the landing filter offers all lines, each operator, and the picked operator's lines, and the map honours operator and train-line filters (it used to treat operator filters as "all"); the header counts every followed line ("47 línies") instead of the fixed "8 línies actives". In a train line view, the chosen station now drives the card and the panel, as for buses: the next departure from that station in that direction and the station's departures, with the trains on the line underneath. Station departures count as live only for a trip with a train in the positions feed (Renfe lists not-yet-started trips with delay 0). The train popup uses the bus popup's card (header, line pill, status badge, ribbon, four tiles, buttons), coloured through `data-line`.
  - Rail line headers: `/api/line/<agency>:<line>/stats` returned `stats: null`, so "Retard 24h" stayed empty on every train line. It now answers the shape the header reads (`totalVisits`, `avgDelayMins`, `latePct`, plus `earlyPct`, `onTimePct`, `maxDelayMins`, `onTimeMaxMins`) from that line's station visits over 24 h (worker op `getRailLineStats`, rail on time = up to 5 min, early below −1, the Dades train report's rules); null with nothing recorded. Unit test `TestRailLineStats`; Mataró's line stats unchanged in the side-by-side.
- [x] **Incidents view speed** (2026-11-21). Uncached incidents views took 1.7–3.4 s in production with a 60 s cache. Profiled on a database rebuilt from the production CSV exports (190k delay logs, 72k visits, 7 days): the time is SQLite reading `delay_logs` vehicle by vehicle (window functions for phantom stretches and the data-quality summary). (1) `idx_delay_veh_cover (vehicle_id, timestamp, id, line_code, line_id, agency_id, direction, delay_mins, stop_name)` replaces `(vehicle_id, timestamp)`, so those readers skip the table lookups; `id` after `timestamp` keeps equal-timestamp rows in their old order, so the "previous sample" of the window functions is unchanged (without it one output changed). Go, real data: single-line 7-day views 808 → 600 ms and 949 → 725 ms, all lines 7 days 1.89 → 1.80 s; outputs identical (hashes) in 6 cases. (2) `hIncidents` serves a result up to 10 min old at once (`X-Cache: STALE`) while one background query refreshes it (`app/README.md`, deliberate changes). Checked MISS → HIT → STALE (same body) → HIT (refreshed) with a running fake clock, and 30 Dades requests identical to the production binary on the rebuilt data. Still open: the remaining ~1.8 s is SQLite window-function CPU (phantom candidates ~0.6 s, data quality ~0.4 s); rewriting them in Go would risk output parity.

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

## GUI scalability (started 2026-11-19)

Plan agreed with the owner, following the Arribo! Design System artifact (https://claude.ai/artifact/P3Z3SD1FZH7nSPU8k4QaSQ): 0 component layer; 1 data-driven GUI (Mataró only); 2 Rodalies/FGC lines and trains in the main app; 3 a map for thousands of vehicles; 4 Dades filters per operator/mode/line; 5 branding and texts ("Arribo! Catalunya"), strings table.

- [x] Phase 0 (`c998b23`, branch `ui/phase0-components`): the design system's 7 components in `style.css` (UI_GUIDE §2.0.1); existing screens identical to production. The design system's LineBadge guideline now says colours come from data (artifact version 8).
- [x] Phase 1 (branch `ui/phase1-catalog-gui`): `/api/lines` carries `agencyId`, `textColor` and `operators` (from the operator registry); line colours come from one generated stylesheet (`TransitUtils.applyLineColors`) instead of inline styles or runtime contrast; landing filters and the line picker's filter are SegmentedControls built from the catalog (per line with one operator, per operator with several); landing and picker group lines by operator; the network map takes every catalog line; map start and the geolocation check use the operators' area (`TransitUtils.serviceArea`); the Trens section uses Card / KpiTile / SegmentedControl / StatusChip / LineBadge. Inline styles 747 → 735 (ratchet ceiling lowered).
- [x] Phase 2: Rodalies/FGC lines in the catalog (names, GTFS colours, shapes) and their live trains on the map, with StatusChip labels.
  - [x] Bit 1 (branch `phase2b/rail-catalog`): the pollers publish each operator's lines from its imported timetable (grouped by short name, names whitespace-collapsed, GTFS colours); `/api/lines` adds them (41 lines: Renfe 19, FGC 22) and their operators with `trackable: false`. The client colours badges from every catalog line (Trens table now in GTFS colours) but lists, filters, the network map and the map start use trackable lines only, so the landing page is unchanged. Note: some operator colours pair badly with their own text colour (FGC R6 `#b3b3b3` with white, about 2:1); they are the official values.
  - [x] Bit 2 (branch `phase2b/rail-catalog`): `GET /api/trains[?agency=<id>][&line=<code>]` (`app/trains.go`, tests in `app/trains_test.go`) lists every train the Renfe and FGC feeds report, read from the pollers' in-memory snapshots through `rtLivePollers` (no World lock for the data, no SQLite, no upstream request). Each train carries `lat`/`lon` and `latitude`/`longitude`, the line code and station name (looked up from the imported timetable on the poller's goroutine; Renfe's label prefix such as `R2S-28385` is used only when it is a catalog line), the age of its position (vehicle timestamp, else the feed header's, `positionTimeSource` says which), `stale` / `isRealTime` (stale after 180 s or with no timestamp at all), and its delay with `delaySource` (`feed` for Renfe, `timetable` for FGC's computed delays) or `delayDiscarded: true` outside the −10 min / +3 h bounds the station visits use. Operators are always listed with their feed state, errors and the attribution their CC BY 4.0 licence requires; `enabled: false` when polling is off. Also fixed: a restarted worker no longer keeps the previous worker's stopped pollers in `gtfsRtPollers`. Checked: gofmt, go vet, go test, build (Go 1.26); live in a sandbox whose network blocks the feed hosts, so only the error path was seen (operators listed with the proxy error, `count: 0`); the live data path is covered by the unit tests only and still needs a look on the VPS.
  - [x] Bit 3 (branch `phase2b/rail-catalog`): the landing page's network map draws the trains from `/api/trains` (refreshed with the bus lines every 30 s, same stale-response guard and visibility sleep) as canvas circle markers in their GTFS line colour (`NetworkMap.renderTrains` in `public/js/networkMap.js`), at the reported position (never snapped or animated). A stale train (position older than 180 s or of unknown age) is drawn hollow and dashed in the neutral token colour. The popup uses LineBadge and StatusChip: "En directe · fa 20 s" / "Posició antiga · fa 7 min" / "Hora de la posició desconeguda"; the delay as signed minutes (rail on time ≤ 5 min), "Retard descartat" with the reason, or "Sense dada de retard"; whether the delay is the operator's or computed from its timetable; the next or current station; and the licence attribution. The fleet badge adds "· N trens (M sense actualitzar)". A "Amaga els trens / Mostra els trens" button (remembered per browser) appears only while `/api/trains` has data, and trains are shown with "Totes les línies" only, so a Mataró-only deployment and the per-line filters look unchanged. App-shell version 9.4.49. Checked: design_system_test (ratchet unchanged), syntax, lint, npm test; in Chromium against the local server with a mocked `/api/trains` (the sandbox blocks the feeds and unpkg): 4 trains drawn, badge and toggle right, popups for live / stale / discarded delay, toggle hides and restores, no console errors, no horizontal scroll at 375 px. Not yet seen with the real feeds.
  - [x] Bit 4: rail lines trackable (line view from GTFS).
    - [x] Slice 4a (server): rail lines are addressed as `<agency>:<code>` (`fgc:L6`, `renfe_rodalies:R2S`), because FGC's L6/L7/L8 would otherwise resolve to Mataró's lines 6–8 (the registry accepts `L6`). When a timetable opens, the poller builds each line's profile (`lineProfiles` in `app/rttimetable.go`): per direction, the stations of the line's longest trip and that trip's GTFS shape (thinned to 600 points), else straight segments between the stations, flagged `geometrySource: "gtfs_stops"` / `geometryEstimated: true`; published with the catalog (`rtCatalogOp.Profiles`). `/api/line/<agency>:<code>?direction=0|1|both` (`app/railline.go`) answers in the shape the single-line view reads for a Mataró line (stops, coords, directions, allDirections, secondary*), with the line's live trains as `activeBuses` (built on the `/api/trains` fields; trains now carry their trip's `direction_id`; stale trains are left off the line and counted in `railData.staleTrains`; unknown-direction trains only with both directions) and a `railData` block (source, attribution, how stations were chosen). `/stats` answers `stats: null`; target-eta, vehicles and stop departures answer 404 "Not available for rail lines yet" rather than Mataró's empty shapes. Checked: go test (profiles built through the real importer from a synthetic feed, ref parsing, line body), gofmt, vet; old vs new binary with a frozen clock and a synthetic FGC L6 timetable loaded: `/api/line/6?direction=both`, `/api/line/L6`, `/api/line/3`, `/api/lines`, `/api/line/6/stats`, a departures 404 and an unknown line identical; `/api/line/fgc:L6` served.
    - [x] Slice 4b (client): rail lines open in the single-line view. `/api/lines` gives each rail line `lineRef` (`fgc:L6`) and `openable` (a profile exists); they stay `trackable: false`, so the landing lists, filters and network map are unchanged. Ways in: the train popup on the network map ("Obre la línia L6") and the URL `#lfgc:L6` (parsed before the Mataró rules; checked against the catalog at start-up, so a fresh load works). In the view: the Mataró fleet stream is not merged into a rail line (it would wipe the trains every ~20 s); trains are drawn where the operator puts them (never snapped to the line, whose drawing may be approximate) with the train popup; the target card says how many trains the operator reports now in this direction ("1 tren" / "Cap tren", plus how many are not updating) and lists them with next station, position age and delay chip, instead of "Sense bus" / "no departures"; the stop modal says per-station times are not available yet; the Mataró outage banner, the GPS telemetry card and traffic are hidden; the route subtitle says stations come from the line's longest trip and whether the drawing is approximate. The train delay labels come from the server (`railDelayLabel`: rail on time ≤ 5 min; a missing delay is "Sense dada de retard", never "Puntual"); `/stats` is asked by `lineRef` (a rail catalog id like "L6" is Mataró's L6) and target-eta is not requested. App-shell version 9.4.50. Checked: go test, gofmt, vet, design_system_test, syntax, lint, npm test, docs_check; Chromium against the local server with a synthetic FGC L6 timetable and a mocked train: popup button → `#lfgc:L6`, 3 stations, 1 train with the train popup, "1 tren" panel, stop note, no request to Mataró endpoints, no console errors; fresh load of `#lfgc:L6` at 375 px ("Cap tren", no horizontal scroll); `#l6` still opens Mataró's L6 with its bus panels. Not seen with real feeds.
    - [x] Station departures: `/api/line/<agency>:<code>/stop/:stopId/departures?direction=` lists the line's timetable departures in the next 120 min (`app/raildepartures.go`). The timetable query runs on the worker (op `getRailDepartures`, its own read-only handle per operator, reopened when a refresh replaces the file), so the server world never opens SQLite. Service days follow `calendar` and `calendar_dates`, trips after midnight are found on the previous service day, other platforms of the same parent station count, and a trip's last stop is not a departure. The server adds the live trip delay from the pollers' snapshot (`isRealTime`, `delaySource`, impossible values discarded); a trip without one is labelled "Horari" (timetable only), never on time. An unknown station is a 404. The stop modal shows them (and a note if the timetable cannot be read). Checked: go test (service days, a removed date, after midnight, direction, last stop; live/timetable/discarded labelling), and in Chromium with a frozen clock: the 09:00 departure from Sarrià shows as "Programat · Horari teòric".
    - [x] Line picker and train icon: the "Canviar línia" picker lists every openable rail line under its operator (operator pills appear once there are several operators; the cards open `lineRef`, show "Tren"), and trains in the line view use a train drawing (`TRAIN_ICON_INNER_SVG` in `public/js/map.js`) with no heading cone, since the feed gives no heading. App-shell version 9.4.51. Checked in Chromium: picker groups "Mataró Bus (8)" and "FGC (1)", picking FGC L6 opens `#lfgc:L6`, the train marker carries the train icon; bus_icon_test and design_system_test pass.
    - Bit 4 done, and seen with the real feeds before the 2026-11-20 deploy (R1, S1 line views live; 190 trains on `/api/trains`). The picker's heading and hint still say Mataró / L1–L8: phase 5 texts.
- [ ] Phase 3 (a map for thousands of vehicles), started:
  - [x] Bit 1: `/api/trains?bbox=minLat,minLon,maxLat,maxLon` lists only the trains inside the box (`parseTrainBox` / `trainsResponse` in `app/trains.go`, test `TestTrainsBox`; an invalid box means no filter; operator totals unchanged; the applied box is echoed as `bbox`). The network map asks for its visible area padded by 30 % and refetches 400 ms after a pan or zoom (`networkTrainsUrl` / `refreshNetworkTrains` in `public/js/app.js`, one sequence guard shared with the 30 s refresh); the badge says "N trens a la vista". Live: 11.0 KB gzip per refresh for all 187 trains → 1.2 KB around Mataró (12 trains), 4.8 KB around Barcelona (76). App-shell 9.4.56.
  - [x] Bit 2: `GET /api/network/vehicles` (`hNetworkVehicles` in `app/server.go`) returns every trackable line's `activeBuses` exactly as `/api/line/:id?direction=both` builds them, without geometry, stops or departures. The network map loads full lines once (geometry) and then polls this one request every 30 s instead of one full line view per line. Live: identical buses, directions and fields on all 8 lines; per refresh 767 KB raw (8 full lines, about 250 KB gzip) became 42 KB raw / 4.9 KB gzip, and 9 requests became 2. App-shell 9.4.57.
  - Deferred: a viewport marker budget instead of `MAX_TRAIN_MARKERS` (1,500). With trains fetched by visible area it can only bind with more than 1,500 trains on screen; Catalonia has about 190.
  - [ ] Next: a cap-free marker budget (draw by viewport instead of `MAX_TRAIN_MARKERS`); SSE per area if the bus fleet grows.
- [ ] Phase 4 (Dades filters per operator/mode/line), started:
  - [x] Network scope: a "Xarxa" SegmentedControl under the Dades header ("Tot · Mataró Bus · Rodalies · FGC", short names from `operatorInfo.ShortName`), shown only while there is train data. A train operator hides the bus blocks (marked `.dades-bus-only`) and shows that operator's card alone; "Mataró Bus" hides the trains. Kept in the URL (`?xarxa=fgc`).
  - [x] Line drill-down: in a train operator's table each line is a button that opens, inside the card, its punctuality per station (in line order from the timetable profile; stations the profile lacks follow, worst first, in muted text) and an hourly strip of average delay (SVG; hours without data stay empty). Served by `/api/analytics/operators/line?agency=&line=&hours=24|168` (`app/operatorline.go`; worker op `getOperatorLineReport` in `app/historydb_operators.go`; 60 s cache, only for lines in the operator's catalog so the cache cannot grow with arbitrary codes; 400 for an unknown operator, 404 for a line not in its catalog). App-shell version 9.4.53. Checked: go test (per-station and per-hour figures, Mataró's L6 and another FGC line excluded, station ordering), npm checks; Chromium with 57 seeded FGC L6 visits: scope pills hide and show the right blocks, the URL restores the scope, L6 opens with Sarrià → Gràcia → Pl. Catalunya and 19 hourly bars, no horizontal scroll at 375 px.
  - [x] Mataró's report per line: a "Totes · L1 … L8" SegmentedControl under the report search (`renderLineFilter` in `public/js/observatori.js`, built from the catalog's trackable lines) filters the report by exact line code, on top of the text search (which matches substrings, so "L1" would also catch a stop named "Hospital 1"): the measurement-contrast table, the line ranking, the worst stops and the hourly heatmap. Kept in the URL as `?linia=L3`. Operator totals stay network-wide. App-shell 9.4.58. Checked on a seeded database: all four tables show only L3; reloading with `?linia=L3` restores it.
  - [ ] Still open: a mode filter once there are bus operators beyond Mataró.
- [ ] Phase 5 (texts), started: strings table, bit 1: `public/js/i18n.js` (`window.ArriboI18n`: `t(key, vars)`, `list()`, `apply()`, `setLang()`; Catalan stays in the HTML and marked elements restore it, so the dictionary holds Spanish and English for static text and all three languages only for text built in JavaScript; a language change fires `arribo:lang`). A "CA · ES · EN" select in every page header, remembered across pages (`arribo_lang`). Translated so far: the landing hero, search hint, quick actions, network-map and favourites headings, the catalog-driven hero texts, header pill, tab title and "Totes les línies (N)". The default stays Catalan until every screen is translated (`AUTO_DETECT = false`), so no screen mixes languages unless the visitor picks one. App-shell 9.4.59. Bit 2: the rest of the main page's static text (beacon, nearby section, search clear, hero button titles) and its modals (line picker, disruptions, zone picker, planner headings), the landing lists and favourites, and the line picker (header for several operators, filter, cards, empty state) translated in all three languages; redrawn on a language change. First draft by a Sonnet subagent, reviewed (escaping, plurals) and checked in the browser. Bits 3a-3b: the single-line view (header, directions, stop card, ETAs, departures, telemetry, favourites' arrivals, route timeline and schematic, stops browser, stop inspector, departures modal, banners, map controls) in all three languages, redrawn on a language change from data in memory. The timetable-only telemetry chip, which read "Estimat (…)" in Catalan and so mixed up timetable-only with estimated, now reads "Horari teòric / Horario teórico / Timetable only (…)". Still Catalan: the stop modal's static labels in index.html, a few toasts (shared focus, share), Dades and the planner. Before that, the Dades header (eyebrow, intro, tab title) names every network with data and where each figure comes from, once train data exists (`wordHeader` in `public/js/operators.js`; app-shell 9.4.55); the landing hero (eyebrow, title, subtitle), the header pill and the tab title follow the catalog (`renderLandingHeader` in `public/js/app.js`): with one operator they keep the Mataró wording, with trains they read "Xarxa en directe • Mataró Bus · Rodalies · FGC", "Quin bus o tren vols seguir?", "8 línies de Mataró Bus amb GPS en directe, i els trens de Rodalies i FGC al mapa de la xarxa i a la vista de cada línia.", pill "Catalunya"; `/api/lines` operators carry `shortName` (app-shell 9.4.54). Before that, the line picker's badge, title, subtitle and search hint follow the lines it lists (`renderLinePickerHeader`): with Mataró's lines only they keep the Mataró wording, with several operators they read "Totes les xarxes · Explorador de línies · N línies de M operadors: …". App-shell version 9.4.52. Checked in Chromium against a server with the synthetic FGC timetable and one without. Still Mataró-worded and accurate while the landing lists Mataró's lines only: the hero, the header's "8 línies actives", page titles and the footer; the "Arribo! Catalunya" branding is its own step.
