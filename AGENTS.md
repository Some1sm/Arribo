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
re-enable. [ARCHITECTURE.md](ARCHITECTURE.md)
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
- Never fall back to missed departures. Include access/transfer walks and waits.
- Exclude EST_, isGhostVehicle and isTheoretical vehicles from flightRecorder.
  Freshness is subsystem-specific, not one universal 90-second cutoff. Estimated
  markers do not prove observed GPS.
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
- The planner is a full-bleed app shell: `body.planner-page-body .header-container`
  spans the viewport while the map and Observatori pages keep a centred
  `max-width` container. Do not unify these — the centred layout is correct for the
  document pages.

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
