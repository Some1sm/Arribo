# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Arribo! is a real-time transit platform for **Mataró Bus Urbà L1–L8** (8 lines, 155 stops): live map/arrivals, a direct+one-transfer journey planner, and a historical punctuality "Observatori". The server is one static **Go** binary (`app/`, Go 1.26, pure-Go SQLite via modernc.org/sqlite, no cgo); the frontend is vanilla JS in `public/`, with no build step for development (the Docker image serves esbuild-minified copies of `public/js` and `public/css`, built by `scripts/minify_public.js` in a Node build stage). Node is only used for that minification, the browser-code tests and the data/maintenance scripts.

The Go server was ported from a Node/Express backend (removed 2026-11-13) and kept its HTTP contract byte for byte: JSON key order, number formatting, headers and error texts. [app/README.md](app/README.md) explains how (the `Obj` ordered object, the `World` lock that stands in for the event loop) and lists the few transport-level differences.

**Work in progress:** the Catalonia research is being implemented step by step. The plan, with the status of every step, is [docs/plan/IMPLEMENTATION_PLAN.md](docs/plan/IMPLEMENTATION_PLAN.md); how to pick it up is [docs/plan/HANDOFF.md](docs/plan/HANDOFF.md). Update step statuses in the same commit as the work.

**Read [AGENTS.md](AGENTS.md) first** — it is the authoritative contract for ownership boundaries, domain invariants, and required validation. [README.md](README.md) and [OPERATIONS.md](OPERATIONS.md) are current; [docs/history/ARCHITECTURE.md](docs/history/ARCHITECTURE.md) is historical and describes a retired Catalonia-wide scope and the former Node code. Verify anything against source, not against those older documents.

## Commands

There is no Go toolchain on the Windows machine; build and vet in a container (on the VPS, under `/var/tmp`):

```bash
docker run --rm -v "$PWD/app":/src -w /src -e CGO_ENABLED=0 golang:1.26-alpine sh -c 'go vet ./... && go build -trimpath -ldflags="-s -w" -o arribo .'
docker compose up -d --build      # the real image from a checkout: container on port 3000, ./data mounted
```

Production does not use this: a push to `main` deploys (see *Deploying*).

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
- Values crossing between the worlds get JSON semantics (`passJSON`), as IPC serialisation did; do not share mutable objects across them. `passJSON` uses `jsonClone` (app/jsmap.go), which builds the same value `parseJSON(toJSON(v))` would without writing the text, so a big report is not held three times at once. A new value type that `writeJSON` knows must get a matching case in `jsonClone` (otherwise it falls back to the slower text round trip).
- `HistoryDB.all` builds one object per row. For a query that can return thousands of rows only to reduce them (the incident clustering reads up to 30 000), use `HistoryDB.each` and keep a small struct per row (see `incRow` in app/historydb_incidents.go); keep the SQL text unchanged so the row order stays the same.
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

### Data files

Timetables (`src/data/mataro_schedules*.json`), routes and stops (`data/cities/mataro/`) are checked in, not fetched at run time: the Observatori measures punctuality against them, and the worker's nightly drift check against maresme.net (`schedule.drift` on `/api/health`) says when they need a refresh. They are written by `scripts/lib/dataJson.js` (one trip or stop per line; never `JSON.stringify(v, null, 2)`, which made them ~85 000 lines), and the seasons file stores each day type once: `restoreSeasonDayAliases` in `app/schedules.go` rebuilds the `Feiners` / `Dissabtes` / `Diumenges i Festius` / `festius` copies at load. `test/data_files_format_test.js` guards both. Details in OPERATIONS.md, *Data file format*.

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
| `ARRIBO_MOVENTIS` / `ARRIBO_MOVENTIS_LINES` | `1` in compose / the 7 lines through Mataró | Moventis buses scraped from moventis.es arrival predictions (`app/moventis.go`): one request at a time, ≥11 s apart (robots.txt crawl delay), backs off when the site answers its placeholder; positions are estimated (`/api/moventis`) |

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

The Go server has no unit tests of its own yet: the parity harness that checked it against the Node code went with the Node code. For any server change, compare the old and new binary side by side (*Checking a server change* below).

`npm run lint` is advisory: it exits 0 with `no-unused-vars` warnings, so a
non-zero exit means a genuine correctness error. `npm run test:syntax` remains
the hard gate.

When a test fails, **compare against HEAD before changing anything** and prefer fixing the fixture over relaxing the assertion. Use a local ORS stub, never personal coordinates.

Commit, push, deploy, or restore live data **only when explicitly asked** — and a push to `main` **is** a deploy. Report files changed, rationale, test results, and anything unverified.

### Checking a server change

Build the old and the new binary, run each against its own copy of the same database snapshot on an internal Docker network (no internet, provider hosts such as `sirimataro.avanzagrupo.com`, `mataro.avanzagrupo.com`, `photon.komoot.io`, `maresme.net` mapped to `127.0.0.1`), with a frozen clock (`ARRIBO_FAKE_EPOCH_MS=<ms>`, `ARRIBO_FAKE_RATE=0`) and the same `public/` mounted in both, then send the same requests to both and compare status, headers and body. The client used so far (about 1 700 requests over every route, written for the Node-vs-Go port) and a database snapshot live only on the VPS, under `/var/tmp/arribo-go/e2e/` (`client/`, `db/snap.db`, `start.sh` shows the container setup). `/var/tmp` is not backed up, so do not count on it staying. Mount `src/` read-only and give each server its own `data/` copy. On that replay a `/api/line/N` that looks slower on one side is ordering (the first call builds a ~0.3 s cache), not a regression: time it directly before believing it.

`/var/tmp/arribo-go/gocmp.sh` on the VPS does this image against image: it builds `arribo-arribo:next` from `/var/tmp/arribo-go/next`, runs it next to `arribo-arribo:latest` (or `OLD=`/`NEW=` images) on a copy of live data (`/var/tmp/arribo-prof/snap.db`), runs the client and prints `<n> requests, <m> mismatches`. It copies the data with `cp -a`: the report files' modification times decide which saved report is the latest, so a plain copy makes the two sides pick different ones. Send the sources with LF endings (`git -c core.autocrlf=false archive`); a Windows working tree has CRLF and makes every HTML page differ. For memory, `/var/tmp/arribo-prof/peak.sh` (`IMG=`, `NAME=`) samples the heap during each heavy report request and prints the cgroup peak; compare against the old image in the same run of the day, since the live data grows.

## Deploying

The repository is `some1sm/arribo` on the self-hosted Forgejo (`git@git.lan:some1sm/arribo.git`, private). From Windows push with `GIT_SSH_COMMAND=/c/Windows/System32/OpenSSH/ssh.exe` so the Windows ssh-agent supplies the key; "Permission denied (publickey)" means the agent does not hold it (the user runs `ssh-add`).

**Every push to `main` deploys to production** through [.forgejo/workflows/deploy.yaml](.forgejo/workflows/deploy.yaml) on the server's runner:

1. `go` (gofmt must print nothing, `go vet`) and `node` (`npm ci`, `test:syntax`, `lint`, `npm test`, `docs_check`) run in parallel. A red check stops the deploy.
2. `deploy` tags the running image `arribo-arribo:previous`, then `vps-common/forgejo-actions/deploy-compose@v1.1` builds `arribo-arribo:latest` from the repository, copies `compose.yaml` and `data/cities/mataro/` into the stack folder and runs `docker compose up -d`. It never pulls base images, never overwrites `.env`, and refuses to run if a project called `arribo` is running from another folder.
3. It waits up to 2 minutes for the container's healthcheck; a container that does not get healthy fails the job (and is left running: roll back by hand).

A re-run of an old job redeploys that old commit. `workflow_dispatch` redeploys `main` from the Actions tab. Job logs are in the repository's Actions tab, or on the host under `/home/server/containers/infra/services/forgejo/data/gitea/actions_log/Some1sm/arribo/<nn>/<task>.log.zst` (capital S: Forgejo keeps the owner's original spelling; read with `zstd -dc`). A run takes about 1½ minutes from push to healthy container.

**The live stack** is `/home/server/containers/apps-dave/arribo` on the VPS (`ssh vps`, Windows OpenSSH; compose project and container `arribo`, port 3000). It holds `compose.yaml`, `.env` (the ORS settings; the repository never overwrites it) and `data/`: `transit_history.db` (~200 MB, WAL), `reports/`, `cache/`, `snapshots/` and the city files. Nothing else belongs there: until 2026-11-13 this folder was a git checkout deployed by hand, and that checkout (`.git`, sources, the old `docker-compose.yml`) was moved to `/var/tmp/arribo-old-checkout-20261113` once the workflow had deployed. Touching files there by hand counts as deploying.

`./data` is mounted over the image's `/app/data`, so the repository's `data/cities/mataro/*.json` reach production only because the workflow syncs that folder. A new file elsewhere under `data/` needs adding to `sync_files`. Files deleted from the repository are not deleted on the server. The synced files end up owned by root (mode 644): the container only reads them, and `server` can still delete them because it owns the folder.

**Rolling back**, on the host in the stack folder: `docker tag arribo-arribo:previous arribo-arribo:latest && docker compose up -d` (the next push replaces it again), or revert the commit and push. Kept by hand: `arribo-arribo:go-1dda103` (first Go deploy) and `arribo-arribo:node-100f254` (the last Node image; it needs the Node-era `docker-compose.yml` and `Dockerfile`, saved with a database copy in `/var/tmp/arribo-backup-20261113`, which may not survive). The deploy action prunes untagged images, so an image is only kept if it has a tag.

**After a deploy** check `docker ps` (healthy), `docker logs arribo` (no `error` / `panic`), and `/api/ready` (`ready`, fleet `fresh`). Memory is ~55–65 MiB in normal service and ~105–120 MiB with every cache full (Node used ~100 MiB in service); see *Memory* in [app/README.md](app/README.md).

Base images: the Node pin (digest) is repeated in the Dockerfile and the workflow — change both together. `golang:1.26-alpine` and `docker:latest` float.
