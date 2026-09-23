# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Arribo! is a real-time transit platform for **Mataró Bus Urbà L1–L8** (8 lines, 153 stops): live map/arrivals, a direct+one-transfer journey planner, and a historical punctuality "Observatori". Node.js ≥22.5 (needs built-in `node:sqlite`), Express + vanilla JS frontend, no build step. Production deps: `express`, `cors`, `compression`.

**Read [AGENTS.md](AGENTS.md) first** — it is the authoritative contract for ownership boundaries, domain invariants, and required validation. [README.md](README.md) and [OPERATIONS.md](OPERATIONS.md) are current; [ARCHITECTURE.md](ARCHITECTURE.md) is historical and describes a retired Catalonia-wide scope. Verify anything against source, not against those older documents.

## Commands

```bash
npm ci                  # install (Node >= 22.5)
npm start               # run on http://localhost:3000 (npm run dev is the same, no reload)

npm run test:syntax     # vm.Script parse of every .js in the repo
npm run lint            # ESLint (correctness rules; no-unused-vars is a warning)
npm test                # auto-discovers test/*.js, one process per suite, isolated temp storage
npm run test:full       # adds the two performance suites
npm run test:list       # show which suites run/skip and why
node scripts/docs_check.js   # validates relative links + npm script refs in README/AGENTS/OPERATIONS
```

**Run a single test** — suites are standalone Node scripts; invoke one directly. They expect isolated storage, so set it yourself when running outside the runner:

```bash
node test/mataro_fleet_test.js
# or with isolation, mirroring test/run.js:
DATA_DIR=./tmp/db DB_PATH=./tmp/db/history.db REPORTS_DIR=./tmp/db/reports node test/worker_bridge_test.js
```

Narrower named scripts exist for fast loops (`test:core`, `test:unit`, `test:mataro`, `test:edge`, `test:infra`, `test:e2e`, `test:perf`) but they are static lists — prefer `node test/<suite>.js` for a single suite and `npm test` for a full sweep.

**Operational / data scripts**

```bash
node scripts/scrape_avanza_schedules.js                    # refresh src/data/mataro_schedules.json from the Avanza portal
node scripts/history_backup.js backup <src.db> <dest.db>   # also: verify | restore (restore writes a NEW file, never live storage)
node scripts/cdp_ui_check.js, upgrades_ui_check.js, observatori_cdp_layout_check.js, ui_card_height_check.js   # CDP layout probes
docker compose up -d --build                                # container on port 3000, ./data mounted
```

`test/run.js` excludes 4 manual/legacy suites and 2 performance suites by default, printing the reason for each skip. Integration suites can start workers, hit upstream, and write runtime data — check a suite's setup before pointing it at a deployment's data directory.

**Windows note:** this machine installs Node under `G:\Programas\nodejs`, not `C:\Program Files\nodejs`. If `npm` ever falls off PATH in the Git Bash tool, run it as
`node /g/Programas/nodejs/node_modules/npm/bin/npm-cli.js <script>`
with a process-local `PATH` that includes `/g/Programas/nodejs`, or use the PowerShell tool.

## Architecture

### Two processes, strict ownership

```
Browser (vanilla JS + Leaflet)
      │  /api/* (GET/HEAD only, read-only guard + rate limit)
Express main process  ── server.js
      │  • serves public/, owns in-memory fleet + report caches
      │  • flightRecorder = main-side MEMORY replica only
      │  WorkerBridge (src/core/WorkerBridge.js): spawn, heartbeat, watchdog, restart
      │  DB_REQUEST / DB_RESPONSE  +  REPORT / INGEST_* messages
      ▼  child_process fork + IPC
Ingestion worker  ── src/workers/ingestionWorker.js + src/ingestionDaemon.js
        • SIRI polling (vehicles 20s, notices 5min, reports 30min)
        • THE ONLY process that opens SQLite (src/historyDb.js, WAL mode)
        • notices, analytics reports, delay logs, vehicle snapshots
```

Consequences that are easy to get wrong:
- **The HTTP process must never open SQLite.** All history access goes through `workerBridge.historyQuery(op, args)` and is proxied to the worker. A change that imports `historyDb` into `server.js` breaks the ownership model.
- Backup/restore is a **separate local CLI**, deliberately not an HTTP endpoint.
- Geocoding and ORS walking are request-time clients in the main process; they do not touch DB or ingestion ownership.
- `flightRecorder` holds a replica of worker state in memory; persistence only happens worker-side.

### Module layering (reuse, don't reimplement)

`src/core/` holds the engines that must be reused rather than forked:

- `time/calendarEngine.js`, `time/timeEngine.js` — all date math. **Europe/Madrid only**; never host-local `getHours()`/`getDay()`. Service dates cross midnight and DST; a nonexistent spring time is rejected and a repeated autumn time resolves to the earlier occurrence.
- `schedule/transitRouter.js` → generates direct + one-transfer candidates; `schedule/journeyTimeline.js` → resolves walks, checks catchable departures, makes times absolute, ranks, dedupes.
- `schedule/scheduleSynthesizer.js`, `schedule/delayEngine.js`, `realtime/delayMemory.js`.
- `geo/geoEngine.js` + `geo/pedestrianRouter.js` (ORS foot-walking or labeled approximate fallback — **never substitute driving routes**), `geo/routeStitcher.js`, `geo/streetGeocoder.js`, `geo/osrmClient.js`.
- `BaseTracker.js` / `TrackerRegistry.js` — tracker lifecycle and line→tracker resolution. **Only Mataró is registered.** The non-Mataró provider trackers and their GTFS/indexer helpers were deleted rather than left dormant, so `TrackerRegistry` has a single provider by construction — there is nothing to re-enable.
- `httpProtection.js` — security headers, API rate limiter, trusted proxies. `serviceStatus.js` — service calendar/status.

`server.js` is a ~44 KB route table with compatibility aliases (`/api/mataro/*`, `/api/c10/*`, `/api/plan` vs `/api/mataro/plan`, and page aliases `/com-anar-hi`, `/rutes`, `/itinerari`, `/observatori`). Inspect it rather than assuming a contract has been retired.

### Coordinates: two orders, both load-bearing

- Internal / Leaflet geometry: **[lat, lon]**
- GeoJSON / OpenRouteService: **[lon, lat]**

Conversions exist at the boundaries (`pedestrianRouter`, `geoEngine`). Preserve zero coordinates (`||`-style fallbacks silently break Equator/Prime Meridian) and keep the `lat`/`lon` plus `latitude`/`longitude` vehicle field compatibility aliases.

### Telemetry honesty

The platform distinguishes three things and must not conflate them: **fresh GPS**, **extrapolated** positions from previously observed vehicles, and **theoretical** timetable-only vehicles. `EST_` prefixes and `isGhostVehicle` / `isTheoretical` flags mark synthetic vehicles and are excluded from the flight recorder. Freshness is **subsystem-specific** (SIRI client, tracker, recorder each have their own windows) — there is no single 90-second cutoff, and an `estimated` marker is not proof of observed GPS. Missing cumulative timetable offsets are not zero; heuristic times must be labeled.

### Frontend

`public/` is served statically; `index.html` (main), `plan.html` (planner), `dades.html` (Observatori) each load scripts in a fixed order. The app-shell cache is versioned by `public/sw.js` **and** the HTML asset versions — **change both together**. Dynamic arrivals, fleet, and planner responses must stay out of offline caches; the catalog and textual stop search may be cached (32 entries, 24h TTL).

Vanilla-JS constraints to preserve: Leaflet canvas renderer, event delegation, bounded caches, visibility-driven deep sleep, async state guards (stale-search invalidation in `plan.js`), and fully scrollable departure boards. [UI_GUIDE.md](UI_GUIDE.md) is the design system reference — CSS custom properties (`--c10-primary`, `--bg-surface*`, `--btn-*`), the 150 ms `cubic-bezier(0.16, 1, 0.3, 1)` interaction timing, and the button-class hierarchy (`.btn-primary`, `.btn-secondary`, pills, `.btn-icon`). Read it before adding UI.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | History DB directory only — **not** a global cache override |
| `REPORTS_DIR` | `./data/reports` | Independent of `DATA_DIR` |
| `DB_PATH` | `transit_history.db` under `DATA_DIR` | |
| `ORS_BASE_URL` / `ORS_API_KEY` | unset | Walking is **disabled** without these; there is no silent public-provider default |
| `TRUSTED_PROXIES` | unset | Feeds `trustedProxies()` |
| `MATARO_SIRI_ACCOUNT_ID` / `MATARO_SIRI_ACCOUNT_KEY` | built-in Avanza defaults | Override the SIRI account; public well-known values, not secrets |

Plain `npm start` does **not** load `.env` — set real environment variables (or Compose `.env`).

`MATARO_SIRI_ACCOUNT_ID` / `MATARO_SIRI_ACCOUNT_KEY` override the SIRI account. They are unset by default, in which case the client falls back to the built-in Avanza well-known values (`Mataro` / `Mataro*WS`) — these are public client defaults shared by every consumer of the portal, not secrets. Unchanged deployments need no configuration.

## Health, logging, privacy

- `/api/health` = liveness (always the Docker healthcheck target). `/api/ready` = 503 during startup/shutdown, else 200 with `ready` or `degraded`; **probes must never query providers or SQLite**. An empty overnight fleet alone is not degraded; fleet fetch age >60 s or unknown is.
- SSE (`/api/fleet/events`) is unbuffered; its clients and timers must be closed on shutdown.
- Never log or return endpoint queries, coordinates, or key values. Planner requests may carry home/workplace coordinates — do not log them.
- SIGINT/SIGTERM: mark not-ready → close SSE → drain HTTP ≤5 s → await worker shutdown ≤5 s, inside a 12 s outer deadline under Compose's 15 s grace. Windows child termination does not exercise POSIX signal delivery — validate that on Linux/container.
- Compose: 400 MB limit, 80 MB reservation, 160 MB V8 heap, non-root, `Europe/Madrid`, digest-pinned `node:22.19.0-alpine`.

## Delivery

Validate before reporting done — a run is not finished while a suite is red:

```bash
npm run test:syntax && npm run lint && npm test && node scripts/docs_check.js
```

`npm run lint` is advisory: it exits 0 with `no-unused-vars` warnings, so a
non-zero exit means a genuine correctness error. `npm run test:syntax` remains
the hard gate.

When a test fails, **compare against HEAD before changing anything** and prefer fixing the fixture over relaxing the assertion. Schedule-sensitive fixtures are frozen deliberately. Use a local ORS stub, never personal coordinates.

Commit, push, deploy, or restore live data **only when explicitly asked**. Report files changed, rationale, test results, and anything unverified.
