# AGENTS.md — Arribo! Transit Platform

> **Authoritative reference for AI coding agents.** Read this file first before exploring
> the codebase. It describes everything you need: architecture, file map, data flow,
> APIs, domain invariants, known gotchas, and required testing workflows.

---

## 0. Subagent Orchestration Policy

How to use subagents when working on this repository. These rules are binding for
any AI agent (or human) orchestrating delegated work.

### 0.1 Persistent Watcher / Heartbeat Monitor

- Spawn a dedicated supervisor agent running continuously in the background.
- Poll active subagents every **60 seconds** to assess progress, check execution
  states, and detect stalls, circular reasoning, or deadlocks.
- If a subagent is stuck, unresponsive, or looping on the same error:
  **terminate its process**, extract its current state logs, and reassign or pivot
  the task autonomously.

### 0.2 Architecture First

Deploy subagents to map the codebase, dependency trees, and blast radius **before**
modifying code. Never guess existing API contracts — verify them against source.

### 0.3 Role Specialization

| Role | Responsibility |
|-------|----------------|
| **Architect** | Formulates the implementation strategy and ensures architectural consistency. |
| **Implementer** | Writes complete, production-ready code with zero stubs, placeholders, or `// TODO` comments. |
| **Adversarial Reviewer** | Aggressive review pass hunting race conditions, edge cases, regression risks, and memory/performance bottlenecks. |
| **Watcher** | The heartbeat monitor from §0.1; owns stall detection and task reassignment. |

### 0.4 Autonomous Test & Fix Loop

Generate exhaustive test suites covering happy paths, edge cases, and failure modes.
Compile the project, execute tests, inspect outputs, and **self-heal any failures**
before concluding. A run is not finished while a suite is red.

### 0.5 Guaranteed User-Facing Output (Zero Silent Exits)

Never terminate silently. Every execution run must strictly end with a final,
structured output printed directly to the user:

- **On success** — an itemized delivery report: files modified, rationale, and
  validation test results.
- **On unrecoverable error or timeout** — a clear failure post-mortem detailing the
  exact blocker, attempted fixes, and recommended next steps instead of ending
  without output.

---

## 1. Current scope

Arribo! serves Mataró Bus Urbà **L1–L8**, eight lines and 153 indexed stops.
TrackerRegistry registers only Mataró. The Catalonia-wide trackers and their
GTFS/indexer helpers have been deleted, not left dormant; there is nothing to
re-enable. [docs/history/ARCHITECTURE.md](docs/history/ARCHITECTURE.md)
is historical. Use [README.md](README.md) and [OPERATIONS.md](OPERATIONS.md) for current
setup and contracts; verify disagreements against source, not fixed source-line lists.

## 2. Ownership and boundaries

- [server.js](server.js): Express, compatibility APIs, fleet SSE, readiness, shutdown.
- [WorkerBridge](src/core/WorkerBridge.js): worker supervisor and historical RPC.
- [ingestionWorker](src/workers/ingestionWorker.js) and
  [ingestionDaemon](src/ingestionDaemon.js): SIRI polling, notices, reports, persistence.
- [historyDb](src/historyDb.js): SQLite WAL, worker-owned during service. The HTTP
  process never opens SQLite; DB_REQUEST/DB_RESPONSE proxy historical operations.
  FlightRecorder is a main-side memory replica, with persistence only in the worker.
  Administrative backup is a separate local CLI, never an HTTP endpoint.
- SIRI requests use worker IPC. Geocoding and optional ORS walking have separate
  request-time clients; these do not change database or ingestion ownership.
- [transitRouter](src/core/schedule/transitRouter.js) generates direct/one-transfer
  candidates; [journeyTimeline](src/core/schedule/journeyTimeline.js) resolves walks,
  checks catchable departures, calculates absolute times, ranks and deduplicates.
- [pedestrianRouter](src/core/geo/pedestrianRouter.js): configured ORS foot-walking
  or labeled approximate fallback. Never substitute driving routes.
- [app.js](public/js/app.js) coordinates the main UI; [stopFeatures.js](public/js/stopFeatures.js)
  extracts favorite/nearby behavior behind existing app delegates.
- [dades.html](public/dades.html) and [observatori.js](public/js/observatori.js) own
  standalone historical delay analysis, peak hours, stop heatmaps, termòmetre, and incident deep-dives.
- [storage.js](public/js/storage.js), [requests.js](public/js/requests.js),
  [journeys.js](public/js/journeys.js), [journeyControls.js](public/js/journeyControls.js)
  own safe storage, cancellable requests and saved/recent journey controls.
- [plan.js](public/js/plan.js) guards stale searches and refresh selection;
  [map.js](public/js/map.js) renders walking geometry;
  [pwa.js](public/js/pwa.js) and [sw.js](public/sw.js) own offline/update behavior.

## 3. Invariants

- Use Europe/Madrid core engines, not host-local getHours/getDay. Preserve service
  dates across midnight and DST. No non-Mataró night providers remain in the tree.
- Internal/Leaflet geometry is [lat,lon]; GeoJSON/ORS is [lon,lat]. Preserve zero
  coordinates and lat/lon plus latitude/longitude vehicle compatibility fields.
- Reuse geoEngine, calendarEngine, timeEngine, delayEngine and scheduleSynthesizer.
  Missing cumulative offsets differ from zero; heuristic times must be labeled.
- **A timetable grid is season-scoped and must be internally consistent.** The
  operator publishes a different grid per season at maresme.net. The file that used
  to ship held a *mixture* — L1/L2/L4/L6/L8 were winter outbound and summer
  inbound — so a rider got correct times one way and wrong times back, and nothing
  could detect it. `src/data/seasonCalendar.js` resolves the season (a live operator
  notice outranks the static config in `SUMMER_WINDOWS`) and `mataroSchedules.js`
  applies it **at the module boundary**, so call sites never pass a season. Do not
  hand a caller a different season than the one it asked for: an unrecognised season
  returns nothing rather than silently substituting. Outside the period the data
  covers, report the grid as unverified — never assert it. `test/season_provenance_test.js`
  is the standing guard; it fails on any line that is winter in one direction and
  summer in the other.
- Times come from maresme.net (the grid riders are held to); stop geometry, coordinates
  and distances come from the Avanza scrape. `scripts/scrape_maresme_timetables.js --diff`
  is the audit for grid provenance.
- **A displayed or planned timetable time is the published time of that trip at that stop (`dayTrips`).**
  The median profile (`dayStopTravelSec`) is for position interpolation only. Call sites
  displaying or planning arrivals must query per-trip times (`getDeparturesForStop`,
  `getTripsServingStop`, `getTripStopTime`) rather than adding median cumulative offsets to
  origin departure times. See `test/timetable_per_trip_test.js`.
- **A live bus may hide its own trip on the board, never a neighbour's.**
  `compileStopDepartures` merges real vehicles into the published grid, and that
  merge is a deletion mechanism, so its scope must stay tight. When a bus names
  the trip it is running (an aimed/scheduled time from SIRI) that identification
  is authoritative and raw proximity to the observed time must NOT also be
  consulted — otherwise a bus merely running early absorbs the departure beside
  it, since the 8-minute duplicate window is easily that wide. Synthetic `EST_`
  runs must not delete published departures at all: their time at a stop is
  interpolated from position, never observed. They may fill an empty board, but
  they yield to a published trip. Getting this wrong is silent and looks like a
  timetable error, which is how a rider reported a missing 11:03 that was in the
  data all along. See `test/stop_departures_dedup_test.js`.
- **A stop board never lists a bus that has already served that stop.** "Has this bus
  passed?" must be decided by *signed progress along the route* — metres from the start
  of the direction, positive while the stop is still ahead. It must NOT be decided by the
  bus's nearest-stop index: the nearest stop is the one a bus is approaching OR the one it
  just left, so that index cannot tell the two apart. In the window where a bus has just
  left stop N while N is still its closest stop, a nearest-index test admits it, and if the
  remaining distance is then measured with the unsigned `calculatePolylineDistanceBetween`
  the result is a confident positive ETA for a stop already served. A rider saw one bus
  listed 2 min out at Pl. Fiveller while the same bus was arriving at La Coma, the very
  next stop along the road. Keep a small tolerance (`PASSED_STOP_TOLERANCE_M`, 30 m —
  polyline snapping errs under 10 m) so a bus standing AT a stop still reads as imminent
  rather than vanishing. The old index test also dropped buses that were legitimately
  still approaching. See `test/stop_passed_estimation_test.js`.
- **A forensic episode is one bus, and its identity must be carried end to end.**
  `inspectDelayIncident` groups raw `delay_logs` samples into episodes using the
  5-minute `EPISODE_GAP_MS` boundary, so the grouping key must include the vehicle
  — keying on the time gap alone merges any two buses that logged the same stop
  within five minutes, and an operator who clicked Investigar on one bus's delay
  was handed a second bus's rows under the same "Vehicles" heading. The key
  mirrors the ranking table's dedup key (`line+vehicle`, falling back to
  `line+stop` only when the id was never stored). The vehicle id must then travel
  from the button (`data-investigate-vehicle`) through `/api/analytics/incidents/inspect?vehicle=`
  into the episode *picker* too: the first episode whose window merely contains
  the clicked instant can belong to a neighbour. Measured on real data, the
  time-only rule reduced 744 rows to 2 "episodes", both multi-bus. An episode
  with no stored id on its opening row but ids on later rows is genuinely
  ambiguous and must say so (`vehicleAmbiguous`) rather than look like one trip.
  See `test/incident_drilldown_single_bus_test.js`.
- **The episode KPI and the episode table must count the same way.**
  `_delayDataQuality.distinctEpisodes` is displayed beside the drill-down, so it
  partitions on the same `episodeKey()` (line+vehicle, id-less falling back to
  line+stop) and the same `EPISODE_GAP_MS`. It previously partitioned by
  `(line_code, stop_name)`, which is wrong in the *opposite* direction from the
  drill-down's bug: splitting by stop gives every stop its own episode-start, so
  one bus passing four stops counted as four. On real data it reported 148
  episodes where the true per-vehicle figure is 52. Both implementations were
  measured at parity (52 = 52) before the check was written down.
- **A column-aligned UI comes from table structure, not from `table-layout`.**
  The Investigar panel's samples were one `<div>` per row with
  `display:flex; justify-content:space-between` around six inline `<span>`s, so
  each column's x-position was decided by the text before it — the "cells move
  depending on text length" report. A real `<table>` shares one column width
  across every row, which is what fixes it. Measured in headless Chrome:
  `table-layout: auto` still gave 0px drift, and `fixed` is kept only to stop a
  long value widening the table past its container. The regression that *does*
  break alignment is taking cells out of table layout (`display:block` on `td`),
  which measured as a 0px column offset. `scripts/investigate_table_cdp_check.js`
  renders the real renderer with adversarial text lengths and asserts measured
  x-positions; `test/investigate_table_ui_test.js` guards markup and stylesheet.
  Do not assert a fix works by scanning source for a string a COMMENT may quote —
  that trap has already bitten this repo once here, and in the TLS sweep.
- **Never match on a localized display string.** `startTime` is an en-GB
  `toLocaleString` value and `Date.parse('24/09/2026, 12:05:00')` is `NaN`, so
  matching a trajectory card to an incident window on it silently matches
  nothing. Compare the numeric `startTs`/`endTs` twins the server sends for
  exactly this reason. When a match cannot be made safely, render no link.
- Never fall back to missed departures. Include access/transfer walks and waits.
- **A line's scheduled fleet is not an even number per direction, so never
  derive a per-direction budget by dividing the whole-line one.**
  `getScheduledFleetRequirement` returns a WHOLE-LINE figure and takes no
  direction argument, because the two directions are not symmetric: L1 is 31
  minutes one way and 40 the other, so at equal headway one direction always
  has more buses airborne than the other (2 against 4 at 13:25). `ceil(lineMaxFleet / 2)`
  therefore undercounts the busy direction and overcounts the quiet one, and the
  bus it drops is one the timetable says is running. Two independent sites did
  this — the per-direction ghost cap in `synthesizeMissingScheduledBuses` and
  the single-direction fleet ceiling in `getLineDetails` — and fixing one leaves
  the other, so a payload could still report `scheduledVehicles: 4` and ship 3
  buses. A direction's allowance is its own unserved active-trip count, minus
  physical buses on it that no trip could claim. That subtraction is the reason
  a real bus is not given a phantom underneath: pairing tolerates 0.40 progress
  difference, so a bus running outside that window leaves its trip looking
  unpaired while a real bus is plainly out there. The co-location guard in
  `synthesizeMissingScheduledBuses` is separate and deliberate, but it guards
  CO-LOCATION only: 100 m same-direction, 250 m cross-direction, both named
  constants. It once ran at service-headway scale instead (18% route progress OR
  700 m), which is a different question and the wrong one — see the next
  invariant. See `test/fleet_direction_balance_test.js` for L1, and
  `test/fleet_all_lines_test.js` for the whole network. All eight lines are
  asymmetric and all eight were losing buses; L2, L3 and L5 are asymmetric the
  *other* way round, so a fix verified only on L1 can still be wrong. Do not
  derive a per-direction budget by division, and note that a count-based test
  cannot cover L4/L6/L7 — their shortfalls are entangled with the co-location
  guard, so the arithmetic is pinned structurally there instead.
- **Route progress is not distance, and a bus nearby is not a bus on top of the
  ghost.** The co-location guard once refused a ghost when it was within 18% of
  another bus's route progress OR 700 m away. Both thresholds are headway
  measures being used to answer a co-location question, and they deleted real
  buses. Progress is not a distance proxy on these routes because they fold back
  on themselves: on L1 dir0, p20% and p55% are 35% of the route apart and 81 m
  apart in space. Measured on L1, the guard hid the 14:57 dir1 trip because bus
  2679 sat at p50 while the ghost wanted p65.7 — 458 m apart, suppressed by both
  clauses. That ghost was a genuinely missing bus, not a duplicate: 2679 paired
  with the 15:11 trip, which is genuinely nearer to it (0.126 versus 0.224), and
  one bus can only serve one trip. **Pairing already decides which bus serves
  which trip; the guard must not override that decision in the one case where a
  second bus most needs to be shown.** The only legitimate suppression is a ghost
  that would land on a bus already drawn, because two markers on one pixel read
  as a mis-paired bus drawn twice. Beyond true co-location, a solid marker where
  we have GPS and a dashed amber one where we do not is the product working, not
  a rendering fault — never hide a bus the timetable says is running to tidy a
  count. Measured over a 42-instant, 8-line sweep with 60% GPS coverage: the old
  guard left 34 scheduled buses undrawn (L2 alone, 16); at 100 m it leaves 15,
  every one of them a genuine sub-100 m overlap. `fleet_direction_balance_test.js`
  tests 7 and 8 pin both halves — a bus 450 m away must not hide a ghost, and a
  ghost on a real bus's exact position must still be refused.
- **Hysteresis sticks the suppression; it never resurrects a served trip.**
  Ghosts are recomputed from scratch each poll against wherever the real buses
  are *now*, so a bus drifting beside a ghost used to delete a scheduled bus from
  the count and put it back, and the rider watched the estimate total flicker for
  no reason. `ghostHysteresisMemory` records each ghost that was actually drawn,
  keyed on line + direction + **scheduled departure** — not position, since a
  ghost moves along its route and a position key would never match. A drawn
  ghost is held while its blocker sits inside the wider release radius
  (350 m same-direction, 600 m cross), and the entry expires after
  `GHOST_HYSTERESIS_TTL_MS` so a bus that parks beside a ghost cannot pin it to
  the map. The map is bounded at 256 entries and pruned by age on every write;
  age alone is not a bound, because entries are only ever *read* when the guard
  fires. This holds the suppression ONLY: pairing runs before the guard and a
  paired trip is never a candidate, so a ghost can never be resurrected over a
  real bus that has since claimed its trip. Tests 9 and 10 pin both halves.
  **Know what this does not fix:** the fleet total still moves as the timetable
  advances and the operator's feed changes, which is correct — a bus appearing
  converts a ghost to a GPS bus and vice versa. Hysteresis only stops the
  co-location guard from flickering a bus that is genuinely still unserved.
  Measured over the 8-line sweep it recovers 6 further ghosts (1085 → 1091).
- **A vehicle the operator never identified is not a real bus.**
  `mataroSiriClient` emits `vehicleRef || 'Bus'`, so any activity with no
  `<VehicleRef>` arrives literally identified `"Bus"`. The only guard was
  positional — drop it when more than 1.5 km from every route coordinate — which
  admitted any phantom near a route. Identity is the right test: run the shared
  `isAnonymousVehicle` predicate, let `stitchAnonymousVehicles` try to recover a
  real id from recent history, and DROP whatever is still anonymous afterwards.
  Keeping one is harmful three ways: it occupies a fleet slot and so suppresses
  the ghost that should have been drawn in its place, it renders on the map with
  no identity, and it arrives carrying `isRealTime: true`, claiming identified
  telemetry the operator never provided. Dropping must not break stitching — a
  report that *can* be tied to a recently-seen bus is still recovered.
- **A live bus off its route is drawn where it is.** Live fixes are snapped to the line's
  drawn route, except when a fresh fix is more than `OFF_ROUTE_M` (75 m) from every direction
  of the line twice in a row (`processBusesWithDeadReckoning`, `lineRoutes`): then it keeps its
  real position and carries `offRoute` / `offRouteM` through the daemon and flightRecorder, and
  neither map snaps it or glides it along the route (`followRoute`). Measured on 174 live fixes
  (6 Oct 2026, 20:30): median 8 m, p99 46 m, max 68 m. See `test/off_route_test.js`.
- Exclude EST_, isGhostVehicle and isTheoretical vehicles from flightRecorder.
  Freshness is subsystem-specific, not one universal 90-second cutoff. Estimated
  markers do not prove observed GPS.
- **A dead-reckoned bus is a real bus with an inferred position, and it must be
  counted as one.** It carries `isPhysicalVehicle() === true` (it is a real,
  identified bus, so it keeps its fleet slot and no ghost is drawn for its trip)
  **and** `isEstimated === true` (the 45-second freshness test in
  `processBusesWithDeadReckoning` marks a stale fix). So the two `fleetStatus`
  counters cannot be derived by exclusion —
  `liveGpsVehicles = physical && !isEstimated` drops it, and counting only
  `allSyntheticBuses` drops it too, leaving it in **neither** bucket and making
  `liveGpsVehicles + estimatedVehicles` miss the fleet by one per dead-reckoned
  bus. Split physical vehicles explicitly; `estimatedVehicles` is ghosts **plus**
  dead-reckoned, with `deadReckonedVehicles` reported separately.
  `fleetCoveragePct` is deliberately NOT changed: it answers "how much of the
  fleet is reporting GPS", so a bus losing its fix must lower it, and counting
  an inferred position as coverage would make the number mean less.
  Never let a display total paper over this with `Math.max(live + est, scheduled)`
  — that exact clamp is what made a 5-bus fleet read "6 en servei" until 0a23eee
  removed it. Report the count. See `test/fleet_status_accounting_test.js`.
- Preserve visibility deep sleep, bounded caches, Leaflet canvas, event delegation,
  async state guards and full scrollable departure boards.
- Preserve unbuffered SSE and close its clients/timers on shutdown. Dynamic arrivals,
  fleet and planner responses stay out of offline caches.
- Keep both HTML script order/versions aligned with the service-worker shell.
- **Three things move together for any shell asset change** (`css/style.css`, any
  `js/*.js`): the `?v=` query in all three HTML files, `VERSION` in [sw.js](public/sw.js),
  **and** `CACHE_NAME`. Bumping only the HTML `?v=` is not enough — the worker
  precaches `/css/style.css?v=VERSION`, so an unchanged URL keeps serving the stale
  copy and the fix appears to do nothing in the browser. The `CACHE_NAME` bump is what
  evicts the old shell on activate; `VERSION` alone does not. When a CSS/JS change
  mysteriously has no effect locally, check for a precached shell before re-debugging.
- **Observatori rates are per stop visit (one bus, one stop), use `src/core/punctuality.js`, and report early running separately. Raw sample counts are only ever labelled as samples.** Consolidated stop visits (`stop_visits`) eliminate dwell/congestion sampling bias. The platform punctuality contract is: early (< -1 min), on-time (-1..+3 min), late (> 3 min), severe late (>= 5 min). Delays <= -15 min are sentinels, not genuine time-travel.
- The planner is a full-bleed app shell: `body.planner-page-body .header-container`
  spans the viewport while the map and Observatori pages keep a centred
  `max-width` container. Do not unify these — the centred layout is correct for the
  document pages.
- **A measured delay is timed on the trip the operator's delay points to, never on the
  nearest departure.** `flushVisit` in [ingestionDaemon.js](src/ingestionDaemon.js) subtracts
  the published time of `visit.scheduledTime` (recovered by `tripMatcher.matchTrip` WITH the
  feed delay) from our own passing time. Matching the passing time to the nearest departure
  caps every delay at half a headway: on 29 Sep 2026 production it turned 662 visits with an
  operator delay of about 14 min into "about 4 min early on the next trip" and pulled the
  published agreement from 79 % down to 72 %. Whether the nearest departure independently
  lands on the same trip is stored separately in `stop_visits.trip_agrees`. Rows with
  `measured_method = ''` predate this and are excluded from the comparison and blanked in
  the visits CSV.
- **A delay that collapses by 10+ min within 10 min on the same line and direction is a
  trip relink, not a recovery.** A bus can only claw back a minute or two between
  neighbouring stops. On 25 Sep 2026 L8 bus 2675 showed +50 at La Coma, La Riera and
  Parc Central while running the 15:30 trip on time, then 0 at O´ Donnell: the
  operator's AVL had kept it on the 14:41 trip (run by bus 2677) after a long stop.
  [tripRelink.js](src/core/schedule/tripRelink.js) detects the stale stretch;
  `getDelayIncidents` lists it with the SAE anomalies, keeps it out of the service
  KPIs and rankings and ends its trajectory as `relinked`, and
  `inspectDelayIncident` returns the `trip_relink` verdict. A direction change, a
  reset at the origin or terminus, or a jump back to an earlier stop is a trip
  boundary, never a relink: the delay before it may have been real.
- **Investigar shows the bus's run, not the clicked stop alone.** A stop often
  holds a single sample of a bus that reported all along its route (L8 bus 2669,
  29 Sep 2026: one sample at Escola El Turó inside a +23..+27 run over 10 stops),
  and on its own it read as "one GPS ping". `inspectDelayIncident` returns
  `episode.run` ([incidentRun.js](src/core/schedule/incidentRun.js): every stop
  visit 30 min either side, with a sustained / building / recovering / variable /
  isolated summary for the clicked trip only: a direction change or a jump back
  along the route starts a new trip), and looks for GPS positions 5 min
  either side of the episode. Positions are kept only SNAPSHOT_RETENTION_HOURS
  (6 h in Compose and by default), so their absence on an older episode is not evidence.
- **A large delay that vanishes at a new trip can be a short-turn, not a recovery.**
  L2 bus 2679 (29 Sep 2026) was +26 at Mataró Parc, then ran the next trip on time
  from Edif. Vidre - TecnoCampus, the 15th stop of that trip; La Llàntia and
  Cerdanyola went 35-36 min without a bus. `buildIncidentRun` flags a new trip whose
  first logged stop is the 4th or later of its direction as `joinedMidRoute`, and
  Investigar names the stops it left out. Stop-visit punctuality cannot see skipped
  stops at all: it only measures buses that came.
- **A bus can skip a whole trip, and the operator's feed hides it.** L8 bus 2669
  (29 Sep 2026) was +26 at Euskadi (14:46), then Sant Joan +3 on the next
  Rodalies -> Galícia trip at 14:57: it never ran the 14:24 Galícia -> Rodalies trip
  (21 min). Meanwhile the feed re-logged Biblioteca Pompeu Fabra at +49 (already
  served at 14:29) and "arrived" at Rodalies at +10. `findDeadheadReturns`
  (src/core/schedule/deadheadReturn.js) detects this; those records stay out of the
  rankings and Investigar groups them as "Tornada sense servei". Say "no bus in the
  operator's data", never "no bus": a bus without tracking would not appear.
- **A delay often starts trips earlier.** L8 bus 2667 (29 Sep 2026) started a trip
  at +18 because it had been late since 10:38 (La Rambla, +3): +9 at Sant Joan
  (10:41-10:50) and +9 between Sant Joan and Can Marfà (11:55-12:07), carried over
  four trips. Investigar loads 4 h of the bus (`RUN_LOOKBACK_MS`) and `buildIncidentRun`
  returns `origin`: the last stop without delay (<= +3) and the largest rises. A step
  back of 1-2 stops is feed jitter, not a new trip (`JUMP_BACK_MIN_STOPS` = 3).
- **Summer is a season, not a day type, and notice dates are read in Catalan.** An
  August weekday runs the summer weekday grid, which seasonCalendar selects; mapping it to
  "saturday" (a rule left over from the retired C-10 line) served L1 37 trips instead of 69
  on 5 Aug 2026, and kept doing so after the window ended on 23 Aug. The window comes from
  the operator's notice ("Del 27 de juliol fins al 23 d'agost"), so month patterns accept
  "de " and "d'" (abril, agost, octubre) and its bounds are Madrid dates on any host. A
  notice names a line only as "Línia N", "línies N i M" or "LN"; "(L5)" after a stop name is
  the line serving that stop. See `test/calendar_and_notices_test.js`.
- **A delay cannot rise faster than the clock.** A rise of 10+ min that exceeds the time
  elapsed by more than 3 min means the operator's AVL moved the bus onto an earlier trip.
  L7 bus 2653 (1 Oct 2026, single midday bus, 28-min cycle) arrived at Parc Cerdanyola on
  time, left on the 14:12 trip and was reported +29/+30 to Pl. Tereses against the 13:44
  trip it had already run. Our measured delay agreed (+28) because it is timed on the
  operator's trip, so it cannot catch this. [delayJump.js](src/core/schedule/delayJump.js)
  finds the stretch; it gets the relink treatment (out of KPIs and rankings, listed with
  the SAE anomalies, Investigar verdict `delay_jump`). See `test/delay_jump_test.js`.
- **Every punctuality figure counts the same rows, and service hours come from the
  timetable.** `_serviceFilter` in historyDb leaves out records outside the line's
  published service that day ([serviceHours.js](src/core/schedule/serviceHours.js): day
  type, holidays, season), 10+ min records in the first half hour of the line's service,
  and relink / deadhead / delay-jump stretches. The incident tables did this; the summary,
  rankings, termòmetre, monthly report and line pages did not, so one week could show
  "+50 max" beside an incident list calling it a relink. Fixed clock rules ("before 06:00
  is depot") dropped L1/L2's 05:25 trips and L1/L3's last trips. The worst stop and hour
  count stop visits, never raw 20-second samples. No data is `null` ("--"), never 100 %
  or 0 %. See `test/service_rows_test.js`.
- **A fact shown to riders needs a source.** [mataroFleet.js](src/data/mataroFleet.js)
  states only what the Ajuntament (5 Jul 2024) and the operator publish: 2668-2687 are
  Volvo 7900 Hybrid, Euro VI, and every bus has a ramp. Make, model and propulsion of the
  other buses, and air conditioning, are unknown and show no chip; the old diesel models,
  legacy series and "Dièsel" fallback were not sourced. Per-stop `segmentMeters` /
  `cumulativeMeters` are along the drawn route and `travelSec` is the published offset
  (`node scripts/stop_route_distances.js --check`); they were straight lines and an
  8 m/s estimate. See `test/mataro_fleet_test.js` and `test/stop_route_distances_test.js`.
- **A live bus's trip start is a timetable time, not an observation.** The SIRI feed
  reports a delay but never the trip or when it began, so the cockpit's "Inici Trajecte"
  read "--" for every live bus. `tripMatcher.matchTripStart` recovers the trip from the
  next stop and the reported delay and returns its first stop and departure (a short-turn
  starts at its own first stop); the tracker sets `tripStartTime` / `tripStartStop` /
  `tripStartSource: 'timetable'`, and dead-reckoned buses keep the last match. No
  reported delay, a bus at a terminal, or two trips in one minute give none; the UI says
  "(horari)". The technical telemetry card starts folded. See `test/trip_start_test.js`.
- **A GPS gap is a silence between two real fixes, recorded by the worker.** The feed sends
  a fix about every 30 s; [gpsGapDetector.js](src/core/geo/gpsGapDetector.js) records a
  silence of 90 s - 15 min (only when `observedAt` moves forward, so re-emits and
  dead-reckoned positions never count) in `gps_gaps`: last fix before, first fix after,
  duration. Silences at a terminal (`at_terminal`) or while no other bus reported
  (`feed_wide`, the operator's feed stalled) are stored but kept off the /dades map;
  longer ones, line changes and fixes without a fleet number (the SIRI client's placeholder
  `Bus`, shared by every bus sent without `<VehicleRef>`) are not gaps. `/api/analytics/gps-gaps` groups the rest into
  hotspots by distance (within 100 m of a hotspot's centre, [gapClusters.js](src/core/geo/gapClusters.js);
  a fixed grid split neighbours across its lines; recurrent: 3+ gaps from 2+ buses). Clicking
  a hotspot draws the street each loss was driven on, cut from the line's route by
  [gapPath.js](src/core/geo/gapPath.js) (forward along the route, right pass on circular
  lines, drivable in the gap's time; otherwise none). The hotspot's detail opens beside the
  map (under it on a phone), never over its streets, with one row per bus that highlights
  its street; lines sharing a street are drawn as nested stripes, each bus's end dot is
  where its GPS came back. A click on the map background clears it. Rows are pruned with the delay logs.
  "Quins busos el perden més" ([gapBuses.js](src/core/geo/gapBuses.js)) compares each bus with
  the other buses on its lines per stop visit (`stop_visits`): expected losses = Σ its visits ×
  that line's losses per visit, and a Poisson tail says whether the excess can be chance
  (suspect: 4+ losses, 1.5×, p < 0.05). Far above its colleagues on the same streets points
  at the bus's equipment, not coverage; a picked bus (`?vehicle=`) narrows the map only, and
  `?hide=suspect|watch` leaves the flagged buses off the map (the ranking still lists them).
  A selected hotspot also says who else drove past (`/api/analytics/gps-gaps/passes`,
  `getGpsGapPasses`): a stop visit to the stop its losses were heading to is a pass with GPS
  unless that bus lost GPS on its way there (20 min before to 1 min after the visit).
  `/api/analytics/gps-gaps*` has its own rate budget (60/min, `RATE_LIMIT_MAP_MAX`) apart
  from the 12/min heavy reports; the page reuses answers for 60 s, sends one request for
  quick clicks, and on a 429 keeps the map on screen and retries after `Retry-After`.
  See `test/gps_gaps_test.js`, `test/gps_gap_paths_test.js` and `test/gps_gap_buses_test.js`.
- **The Investigar "Pas" is the last sample before the stop, a trajectory card says how it ended, and an incident is one bus trip.**
  The run table's first column used to show the FIRST sample logged while the bus was heading to a stop, which
  is when it left the previous stop: on L2 bus 2684 (2 Oct 2026) the row read 17:17 beside "17:06 → 17:23", and 17:17 was the previous
  stop's "Real". "Pas" is `lastTime` (the last sample before the stop, within about 2 min of the projected "Real");
  the first sample stays as a tooltip. The trajectory card (`_matchIncidentTrip`) now shows `fi HH:MM` and
  one sentence from `endReason`: `recovered`, `end_of_line` (with the next trip's first record), `signal_lost`,
  `ongoing`, `relinked`, `deadhead_return` and `trip_change`. **A delay that falls by 10+ min at once, or a record
  at a stop 3+ places behind the last delayed one, is the bus on another trip, not a recovery**
  (`_buildVehicleTrajectory`; L2 bus 2684: Cirera +28 at 18:23, nine minutes with no record, then Parc Central +0 nine
  stops back, which the card called "recovered"). Such a card ends at its last delayed stop and carries
  `nextTrip`. `getDelayIncidents` lists ONE row per bus trip (consecutive samples, one direction, no gap over
  12 min), not one per 20-minute window: a 24-minute trip was three rows. The two tiers stay separate: a trip with
  samples on both sides of 25 min is one row in Top Incidents and one under "En investigació". Rows with no vehicle id keep the window. A bus that carries its delay across trips is still
  one row per trip, which is honest: the delay is real (L3 and L2 buses on 2 Oct had 30-39 min gaps in service
  against 13-19 min headways). See `test/incident_trip_outcome_test.js`.
- **A bus driving BACK along its route with the delay frozen on is a phantom stretch, not a delay.**
  L8 bus 2679 (2 Oct 2026): +26 at Ronda Barceló (10:07, stop 12 of 13), then from 10:13 to 10:30 the feed placed it at
  Edif. Vidre, Institut Català Salut, Gatassa, Pl. Gatassa, Tarragona, Parc Cerdanyola, Roca Blanca, Tarragona and Roca Blanca
  again, all "direction 0" and all +26, and at 10:32 Tarragona +1 on the next trip. The bus had abandoned its late trip and
  driven back to the start of the line. The deadhead rule never saw it because the direction flag did not change.
  [backwardLeg.js](src/core/schedule/backwardLeg.js) finds it: delay >= 15 min, the stop order 4+ places behind the furthest
  stop reached, the delay within 3 min of the one at that stop, 3+ stop visits, and the bus never comes back to the
  furthest stop (L3 runs out to Caldes d'Estrac and returns through the same stops, which looks backwards by the
  published list; a stop name that appears twice in a direction is skipped for the same reason). Measured on 48 h of
  production (20,540 stop visits) it finds exactly that one stretch. It is handled like the other phantom stretches:
  `_findPhantomStretches` returns `backs` and adds their windows, so the service KPIs, rankings, termòmetre and visits leave
  it out; it is listed with the SAE anomalies as `backward_leg` (and wins over the relink that its tail also forms); a
  trajectory that reaches it ends as `backward_leg` at the furthest stop served; Investigar returns the `backward_leg`
  verdict and groups its visits as one phantom group (`phantomKind: 'backward'`). See `test/backward_leg_test.js`.
- **The edge-case debug table is the way to find out what a phantom stretch really was.** The bottom of /dades
  Top Incidents lists one row per relink, deadhead return, delay jump, backward leg and `trip_change` trajectory
  (`_buildEdgeCases`, newest first, 150 at most), each with the number of stored GPS positions around it
  (`gpsPoints`; `gpsExpired` when there are none because they were pruned) and an Investigar button. Positions are
  kept 6 h, so open a case within that time to look at where the bus really was. "Copiar taula" copies it as
  tab-separated text. See `test/edge_cases_test.js`.
- **"No records for the first stops" is not proof of a short-turn: check the signal.** A bus that joins its next trip
  mid-route (`joinedMidRoute`) was explained as "it skipped part of the route". The same gap appears when the bus lost
  GPS and the operator's system reassigned it (L1 bus 2684, 26 Sep 2026: relink at Parc Central +12 -> 0 after a 7-minute silence),
  when the operator's feed stalled, or when the bus waited at a terminal (not logged). `_signalEvidence(vehicleId, fromTs, toTs)`
  looks at the `gps_gaps` silences and the stored real GPS positions in the silent window and returns `lost`,
  `feed_stalled`, `terminal`, `kept` (2+ real positions, no silence) or `unknown`. Investigar's "Per què el retard desapareix
  després?" says only what that found, and `unknown` says it cannot tell (positions are kept 6 h, silences are recorded
  only since they were introduced). The edge-case table carries the same `signal` per case. Absence of evidence is never
  worded as evidence. See `test/signal_evidence_test.js`.
- **Colours, radii and spacing come from tokens.** [UI_GUIDE.md](UI_GUIDE.md) §2.0 lists the
  design-system tokens (`--brand`, `--action`/`--on-action`, `--status-*`, `--punct-*`,
  `--line-N`/`--on-line-N`, `--radius-xs`…`--radius-xl`, `--space-1`…`--space-8`). Every
  `var()` must be defined; text pairs hold 4.5:1 in both themes; a component carries no
  `[data-theme="light"]` override of its own. `test/design_system_test.js` checks this and
  ratchets hard-coded colours, light overrides and inline styles: they may only go down,
  and a change that removes some lowers its ceilings. Phone-width rules that once broke
  silently (icon-only header links, hero glow and badge, filter pill rows, the delay
  investigation's width) are pinned by `test/mobile_layout_test.js`; check a layout change
  at 412 px.

## 4. Runtime, configuration and privacy

Compose retains 400 MB limit, 80 MB reservation, 160 MB V8 heap, non-root execution,
15-second stop grace and the data volume. DATA_DIR controls history placement, not
all caches; REPORTS_DIR independently controls reports. Node >=22.5 is required.

/api/health is liveness. /api/ready returns 503 during startup/shutdown and 200 when
usable (including degraded timetable-only operation). Probes must not query providers
or SQLite. Preserve aliases; inspect server.js rather than restoring retired contracts.

Never publish credential values or log endpoint queries, coordinates or keys.
ORS_BASE_URL / ORS_API_KEY configure walking; AMB_API_KEY belongs to inactive AMB.
MATARO_SIRI_ACCOUNT_ID / MATARO_SIRI_ACCOUNT_KEY override the SIRI account and fall
back to the built-in Avanza well-known defaults when unset. Documentation
redaction does not revoke secrets, erase history or remove legacy source defaults.
Historical exposure needs operator review; do not rotate accounts incidentally.

- **Never disable TLS certificate verification to work around an upstream
  misconfiguration.** `mataro.avanzagrupo.com` serves its leaf without the
  Sectigo intermediate that signed it, which used to be answered with
  `rejectUnauthorized: false` and `NODE_TLS_REJECT_UNAUTHORIZED=0`. Those notices
  feed line detours and `seasonCalendar.registerWindow`, and the scraped
  response is the source of the published timetable, so an unverified response
  is an integrity hole, not an inconvenience. The chain is genuine — it is just
  incomplete — so the missing certificates are vendored in `src/data/certs/`
  and applied to that host alone via `src/core/http/verifiedTls.js`. Adding a
  broken host to `CHAIN_REPAIR_HOSTS` is the fix; relaxing verification is not,
  and `test/portal_tls_verification_test.js` fails if a blanket bypass returns.
  That sweep strips comments with a **string-aware** helper: the Accept header
  contains `*/*;q=0.8`, and a naive regex reads that as a comment opener and
  skips real code while reporting success.

## 5. Validation and delivery

```bash
npm run test:syntax
npm test
npm run test:full
node scripts/docs_check.js
```

The runner discovers test/*.js with isolated DATA_DIR/DB_PATH/REPORTS_DIR and prints
exclusions; --full adds performance suites. Freeze schedule-sensitive fixtures and
compare unexpected failures with HEAD before modifying assertions or production code.
Use local ORS stubs, not personal coordinates. No CI workflow or browser framework
is part of this upgrade. Review git diff/status and report files, rationale, tests
and unverified dependencies (§0.5). Commit, push, deploy or live restore only when asked.
