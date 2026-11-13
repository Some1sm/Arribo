# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Arribo! is a real-time transit platform for **Mataró Bus Urbà L1–L8** (8 lines, 155 stops): live map/arrivals, a direct+one-transfer journey planner, and a historical punctuality "Observatori". The server is one static **Go** binary (`app/`, Go 1.26, pure-Go SQLite via modernc.org/sqlite, no cgo); the frontend is vanilla JS in `public/`, with no build step for development (the Docker image serves esbuild-minified copies of `public/js` and `public/css`, built by `scripts/minify_public.js` in a Node build stage). Node is only used for that minification, the browser-code tests and the data/maintenance scripts.

The Go server was ported from a Node/Express backend (removed 2026-11-13) and kept its HTTP contract byte for byte: JSON key order, number formatting, headers and error texts. [app/README.md](app/README.md) explains how (the `Obj` ordered object, the `World` lock that stands in for the event loop) and lists the few transport-level differences.

**Read [AGENTS.md](AGENTS.md) first** — it is the authoritative contract for ownership boundaries, domain invariants, and required validation. [README.md](README.md) and [OPERATIONS.md](OPERATIONS.md) are current; [docs/history/ARCHITECTURE.md](docs/history/ARCHITECTURE.md) is historical and describes a retired Catalonia-wide scope and the former Node code. Verify anything against source, not against those older documents.

## Commands

There is no Go toolchain on the Windows machine; build and vet in a container (on the VPS, under `/var/tmp`):

```bash
docker run --rm -v "$PWD/app":/src -w /src -e CGO_ENABLED=0 golang:1.26-alpine sh -c 'go vet ./... && go build -trimpath -ldflags="-s -w" -o arribo .'
docker compose up -d --build      # the real image: container on port 3000, ./data mounted
```

Node side (browser code, scripts):

```bash
npm ci                  # dev tools only: esbuild, eslint
npm run test:syntax     # vm.Script parse of every .js in the repo
npm run lint            # ESLint (correctness rules; no-unused-vars is a warning)
npm test                # auto-discovers test/*.js, one process per suite, isolated temp storage
npm run test:list       # show which suites run
node scripts/docs_check.js   # validates relative links + npm script refs in README/AGENTS/OPERATIONS
```

**Operational / data scripts**

```bash
node scripts/scrape_avanza_schedules.js                    # refresh src/data/mataro_schedules.json from the Avanza portal
node scripts/scrape_maresme_timetables.js [--diff]         # refresh / check src/data/mataro_schedules.seasons.json
node scripts/lib/dataJson.js <file.json>...                 # rewrite a data file in the compact data-file format (see OPERATIONS.md)
node scripts/history_backup.js backup <src.db> <dest.db>   # also: verify | restore (restore writes a NEW file, never live storage)
node scripts/cdp_ui_check.js, upgrades_ui_check.js, ui_card_height_check.js   # CDP layout probes against a running server
```

**Windows note:** this machine installs Node under `G:\Programas\nodejs`, not `C:\Program Files\nodejs`. If `npm` ever falls off PATH in the Git Bash tool, run it as
`node /g/Programas/nodejs/node_modules/npm/bin/npm-cli.js <script>`
with a process-local `PATH` that includes `/g/Programas/nodejs`, or use the PowerShell tool.

## Architecture

### Two worlds, strict ownership

```
Browser (vanilla JS + Leaflet)
      │  /api/* (GET/HEAD only, read-only guard + rate limit)
Server world  ── app/server.go (+ express.go, qs.go)
      │  • serves public/, owns in-memory fleet + report caches
      │  • flight recorder = server-side MEMORY replica only
      │  WorkerBridge (app/bridge.go): start, heartbeat, watchdog, restart
      │  DB_REQUEST / DB_RESPONSE  +  REPORT / INGEST_* messages (JSON round trip)
      ▼
Worker world  ── app/worker.go + app/ingestion.go
        • SIRI polling (vehicles 20s, notices 5min, reports 30min)
        • THE ONLY side that opens SQLite (app/historydb*.go, WAL mode)
        • notices, analytics reports, delay logs, vehicle snapshots
```

Both worlds live in one process. Each has its own lock (`World` in `app/tracker.go`): code runs holding it, `await` releases it around real I/O, and `spawn` runs a callee until its first await before handing the lock back, which keeps the ordering the Node event loop had.

Consequences that are easy to get wrong:
- **The server world must never open SQLite.** All history access goes through `historyQuery(op, args, timeout)` on the bridge and is answered by the worker. The HTTP side must never block on SQLite.
- Values crossing between the worlds are JSON round-tripped (`passJSON`), as IPC serialisation did; do not share mutable objects across them.
- Backup/restore is a **separate local CLI**, deliberately not an HTTP endpoint.
- Geocoding and ORS walking are request-time clients on the server side; they do not touch DB or ingestion ownership.
- The flight recorder holds a replica of worker state in memory; persistence only happens worker-side.

### Module layering (reuse, don't reimplement)

- `timeengine.go`, `calendar.go` — all date math. **Europe/Madrid only** (embedded tz database); never host-local time. Service dates cross midnight and DST; a nonexistent spring time is rejected and a repeated autumn time resolves to the earlier occurrence.
- `planner.go` — candidate generation (direct + one transfer) and the journey timeline: walks, catchable departures, absolute times, ranking, dedupe.
- `schedules.go` (timetables, fleet registry), `schedlogic.go` (trip matching, delay engine, service hours), `synth.go` (schedule synthesis).
- `geo.go` (geometry, GPS gap detection) + `walkgeo.go` (ORS foot-walking or labeled approximate fallback — **never substitute driving routes**; street geocoder).
- `tracker*.go` (the Mataró tracker), `registry.go` — **only Mataró is registered**; there is nothing to re-enable.
- `httpguard.go` — security headers, API rate limiter, trusted proxies, bounded bodies, the per-host TLS chain repair; `anomalies.go`, `incidentrun.go` — phantom-stretch and incident logic.
- `jsobj.go`, `jsonparse.go`, `jsmap.go`, `jscase.go`, `mathjs.go`, `fdlibm.go` — JavaScript value semantics (ordered objects, `JSON.stringify` formatting, case mapping, V8's Math). Build responses with these, not Go maps or `encoding/json`, or key order and number formatting change.

`server.go` is the route table, with compatibility aliases (`/api/mataro/*`, `/api/plan` vs `/api/mataro/plan`, and page aliases `/com-anar-hi`, `/rutes`, `/itinerari`, `/observatori`). Inspect it rather than assuming a contract has been retired.

### Coordinates: two orders, both load-bearing

- Internal / Leaflet geometry: **[lat, lon]**
- GeoJSON / OpenRouteService: **[lon, lat]**

Conversions exist at the boundaries (`walkgeo.go`, `geo.go`). Preserve zero coordinates (`||`-style fallbacks silently break Equator/Prime Meridian) and keep the `lat`/`lon` plus `latitude`/`longitude` vehicle field compatibility aliases.

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
| `TRUSTED_PROXIES` | unset | Feeds the trusted-proxy check |
| `MATARO_SIRI_ACCOUNT_ID` / `MATARO_SIRI_ACCOUNT_KEY` | built-in Avanza defaults | Override the SIRI account; public well-known values, not secrets |
| `ARRIBO_ROOT` | the binary's directory | Holds `public/`, `src/data/` and `data/` |
| `GOGC` / `GOMEMLIMIT` | `50` / `128MiB` in compose | See *Memory* in [app/README.md](app/README.md) |

The binary does **not** load `.env` — set real environment variables (or Compose `.env`).

`MATARO_SIRI_ACCOUNT_ID` / `MATARO_SIRI_ACCOUNT_KEY` override the SIRI account. They are unset by default, in which case the client falls back to the built-in Avanza well-known values (`Mataro` / `Mataro*WS`) — these are public client defaults shared by every consumer of the portal, not secrets. Unchanged deployments need no configuration.

## Health, logging, privacy

- `/api/health` = liveness (the container healthcheck runs `/app/arribo healthcheck`, which GETs it). `/api/ready` = 503 during startup/shutdown, else 200 with `ready` or `degraded`; **probes must never query providers or SQLite**. An empty overnight fleet alone is not degraded; fleet fetch age >60 s or unknown is.
- SSE (`/api/fleet/events`) is unbuffered, capped at 200 streams and 8 per client address (a refused browser falls back to polling); its clients and timers must be closed on shutdown.
- Never log or return endpoint queries, coordinates, or key values. Planner requests may carry home/workplace coordinates — do not log them. Transport errors are logged in Node's wording without URLs (`nodeErrMessage`, `describeChainFailure`).
- Never disable TLS verification (`InsecureSkipVerify`); the Avanza portal's incomplete chain is repaired with vendored CAs in `src/data/certs/` (see OPERATIONS.md).
- SIGINT/SIGTERM: mark not-ready → close SSE → drain HTTP ≤5 s → await worker shutdown ≤5 s, under Compose's 15 s grace.
- Compose: 400 MB limit, 80 MB reservation, `GOGC=50`, `GOMEMLIMIT=128MiB`, uid 1000 with all capabilities dropped and no-new-privileges, `Europe/Madrid`, a `scratch` image (no shell).

## Delivery

Validate before reporting done — a run is not finished while a check is red:

```bash
# Go (in a golang:1.26-alpine container): gofmt -l . must print nothing; go vet ./...; go build
npm run test:syntax && npm run lint && npm test && node scripts/docs_check.js
```

The Go server has no unit tests of its own yet: the parity harness that checked it against the Node code went with the Node code. For any server change, run the binary against a copy of the database and compare the affected endpoints before and after.

`npm run lint` is advisory: it exits 0 with `no-unused-vars` warnings, so a
non-zero exit means a genuine correctness error. `npm run test:syntax` remains
the hard gate.

When a test fails, **compare against HEAD before changing anything** and prefer fixing the fixture over relaxing the assertion. Use a local ORS stub, never personal coordinates.

Commit, push, deploy, or restore live data **only when explicitly asked**. Report files changed, rationale, test results, and anything unverified.
