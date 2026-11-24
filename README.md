# Arribo! Mataró

Real-time bus tracking, arrival information, journey planning, and punctuality analysis for **Mataró Bus Urbà lines L1–L8**.

Arribo! combines Avanza SIRI vehicle and arrival data with local route geometry and timetables. The Catalan-language interface helps passengers find nearby stops, follow a bus, plan a journey, and inspect historical service performance.

## Current scope

The default line catalog, search, and background ingestion focus on Mataró's eight urban bus lines. Trackers for the earlier Catalonia-wide operators have been removed from the codebase, so **Mataró is the only provider present**.

A few compatibility API aliases from that earlier scope remain (see the endpoint table below). [docs/history/ARCHITECTURE.md](docs/history/ARCHITECTURE.md) is historical. Use the current source code and [AGENTS.md](AGENTS.md) when working on the active app.

See [OPERATIONS.md](OPERATIONS.md) for planner parameters, ORS configuration, local-data
privacy, PWA updates, readiness and backup/restore.

## Features

- **Live map and line details:** Leaflet maps with stops, route geometry, vehicle markers, direction selection, and telemetry inspection.
- **Arrivals and departure boards:** target-stop countdowns, timetables, and real-time or estimated departure information.
- **Stop discovery:** search for lines, stops, and streets; find nearby stops using location; browse neighborhood shortcuts and save favorite stops locally.
- **Journey planner:** the `/plan` page supports direct and one-transfer Mataró bus journeys, walking connections, and departure date/time selection.
- **Service notices:** official Mataró Bus disruptions and line-specific notices.
- **Observatori:** historical delay reports, line rankings, hourly delay analysis, the “Termòmetre del Bus” scorecard, and CSV export.
- **Mobile web app:** responsive layout, light/dark themes, arrival sounds, and a PWA manifest/service worker with offline app-shell support. Live arrivals still require connectivity.

### Live versus estimated data

The tracker distinguishes fresh GPS observations, extrapolated positions based on previously observed vehicles, and theoretical timetable-based vehicles used when trips lack GPS coverage. An estimated position is not proof that a bus is physically there.

Synthetic vehicles (`EST_` IDs or `isGhostVehicle`/`isTheoretical` flags) are excluded from the flight recorder. Telemetry freshness and fallback windows differ between the SIRI client, tracker, and recorder; there is no single universal 90-second cutoff.

## Data sources and trust

Arribo! integrates data from three primary sources with strict integrity rules:

- **SIRI (live):** Real-time vehicle positions and stop arrival predictions provided by Avanza via SIRI SOAP (`sirimataro.avanzagrupo.com/Siri/SiriWS.asmx`) polled every 20 seconds. Coordinates are validated against a strict Mataró bounding box (lat 41.45–41.65, lon 2.30–2.55) to reject invalid or unlocated GPS fixes. Speed and delay measurements remain explicitly nullable (`null` when unknown/unreported) to prevent fake 0 km/h or fake punctual classifications. Anonymous or unstitchable vehicle entities are dropped so phantom vehicles never pollute the fleet or map.
- **maresme.net (timetable, per trip):** Authoritative published timetables (`https://maresme.net/matarobus/{hivern,estiu}/`). Extracted and calibrated per-trip (`dayTrips`) across winter and summer grids, ensuring intermediate stop passing times and mid-route starts or early terminations precisely match what riders are held to.
- **Avanza portal (geometry, notices):** Official line geometries, stop coordinates, and service disruption notices scraped from `mataro.avanzagrupo.com`. Uses vendored intermediate TLS certificates to guarantee authenticity without bypassing certificate verification.

### Health and diagnostics fields (`/api/health` and `/api/ready`)

- `status`: Overall service health (`ok`, `degraded` if operating on timetable fallback, or `down`).
- `schedule.season` / `schedule.seasonSource`: Operational season (`winter` / `summer`) and provenance (`notice` from operator disruption feed or `calendar` window).
- `schedule.drift`: Daily automated check comparing local timetables against maresme.net (`drift: false` when in sync).
- `upstream`: Live status of the SIRI SOAP client, including circuit-breaker state (`circuitOpen`), consecutive failures, and upstream SOAP delivery flags.
- `upstreamCanary`: Background worker probe detecting empty or corrupted SIRI deliveries.
- `fleetAnomaly`: Discrepancy detection between active observed buses and scheduled trips.
- `lastObservationAt`: Timestamp of the freshest confirmed physical vehicle GPS fix.

## Architecture

```text
Browser (vanilla JavaScript + Leaflet)
                 |
     Go HTTP server (server world)
          /api/* + public assets
                 |
         bridge (JSON messages)
                 |
      Ingestion worker (worker world)
      - Mataró SIRI polling
      - Fleet updates and service notices
      - SQLite history and delay recording
      - Cached analytics report generation
```

Both worlds run in one Go process ([app/](app/README.md)). The server world serves the frontend and API, maintains in-memory fleet/report caches, and asks the worker for SIRI and historical database operations. The worker owns SQLite persistence and scheduled ingestion. Geocoding has its own client path.

- **Runtime:** one static Go binary (Go 1.26, pure-Go SQLite, no cgo). It replaced the former Node/Express server on 2026-11-13 and keeps its HTTP contract.
- **Node:** only for development tools: the minify step of the image build, the browser-code tests and the data scripts.
- **Frontend:** plain HTML/CSS/JavaScript; no build step is needed to develop or run locally. The Docker image serves esbuild-minified copies of `public/js` and `public/css` ([scripts/minify_public.js](scripts/minify_public.js)).
- **Storage:** SQLite history plus local route and timetable data.

## Run locally

From the repository root:

The simplest way is the Docker image below. Without Docker, build the binary with a Go 1.26 toolchain and run it from the repository root (it finds `public/`, `src/data/` and `data/` next to itself, or under `ARRIBO_ROOT`):

```bash
cd app && CGO_ENABLED=0 go build -o arribo . && cd ..
ARRIBO_ROOT=$PWD app/arribo
```

Open **http://localhost:3000**. This serves the unminified `public/` files. Upstream live data requires network access.

## Docker deployment

```bash
docker compose up -d --build
docker compose logs -f arribo
```

The Compose service exposes port 3000 and mounts `./data:/app/data` for persistent storage. The image runs the Go port of the server ([app/](app/README.md)): one static binary on a `scratch` base, serving the same `public/` (minified with Node at build time), the same `src/data/` files and the same SQLite database. It uses `Europe/Madrid`, a 400 MB container memory limit and a `GOMEMLIMIT` soft heap target. See [compose.yaml](compose.yaml) and [Dockerfile](Dockerfile) for exact settings.

The repository targets a long-running Docker deployment; retired serverless configuration has been removed. The production instance deploys itself on every push to `main` ([.forgejo/workflows/deploy.yaml](.forgejo/workflows/deploy.yaml)); [CLAUDE.md](CLAUDE.md) describes the pipeline and how to roll back.

### Storage settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | Repository `data/` | History database directory; not a global override for every data/cache path |
| `REPORTS_DIR` | Repository `data/reports/` | Independent generated-report directory |
| `ORS_BASE_URL` / `ORS_API_KEY` | Unset | Optional existing foot-walking endpoint; approximate fallback without it |
| `DB_PATH` | `transit_history.db` under `DATA_DIR` | Explicit history database path |
| `VEHICLE_SNAPSHOT_INTERVAL_MS` | `60000` | Minimum interval between stored snapshots per vehicle |
| `SNAPSHOT_RETENTION_HOURS` | `6` | Raw vehicle snapshot retention (GPS positions behind the /dades edge-case table) |
| `DELAY_RETENTION_DAYS` | `30` | Delay-log retention |
| `ARRIBO_GTFSRT` | `1` in compose | Rodalies and FGC feeds (GTFS-RT pollers and timetable imports) |
| `ARRIBO_MOVENTIS` | `1` in compose | Moventis buses, estimated from the arrival predictions of moventis.es (`app/moventis.go`); `/api/moventis` |
| `ARRIBO_MOVENTIS_LINES` | `47,48,51,53,57,59,68` | Moventis line ids to follow (the seven lines through Mataró). A stop's answer shows only the next live bus per line and direction, so stops are sampled about as far apart as consecutive buses (speed × headway, `movSpacingKm` in `app/moventis.go`): 31 stops, a ~6-minute cycle for the seven lines. Requests are 11 s apart (the site's crawl delay) |
| `ARRIBO_SPECIAL_LINES` | `10,11,12` | Mataró SIRI line refs asked for special services (Les Santes "Bus Focs" lines), shown as "Servei especial" with no timetable. Asked by name every 5 min, and on every 20 s cycle for 30 min after one is seen; empty or `off` turns it off |

Storage sampling does not reduce live polling frequency. The ingestion daemon polls Mataró vehicles every 20 seconds, refreshes notices every five minutes, and schedules analytics reports every 30 minutes.

## Main API endpoints

API routes use GET; the server also permits HEAD. Other methods are rejected by the read-only guard, subject to CORS preflight handling.

| Endpoint | Purpose |
| --- | --- |
| `/api/ready` | Readiness and subsystem freshness; usable upstream outages are degraded |
| `/api/fleet/events` | Fleet SSE stream |
| `/api/health` | HTTP process health and uptime; not proof of fresh upstream data |
| `/api/diagnostics/upstream` | Passive upstream circuit-breaker state from the worker heartbeat; no upstream calls |
| `/api/lines` | Current Mataró L1–L8 catalog |
| `/api/search/stops?q=Hospital` | Search Mataró stops, lines, and street names |
| `/api/line/:lineId?direction=0` | Stops, geometry, and active buses |
| `/api/line/:lineId/vehicles` | Vehicle information for a line |
| `/api/line/:lineId/target-eta?direction=0&stopId=:id` | Target-stop arrival information |
| `/api/line/:lineId/stop/:stopId/departures?direction=0` | Stop departure board |
| `/api/stops/nearby?lat=:lat&lon=:lon` | Nearby stops and optional departures |
| `/api/plan?from=:origin&to=:destination` | Mataró journey planning |
| `/api/mataro/line/:lineId/traffic` | Estimated line congestion information |
| `/api/disruptions` | Service notices; optional `line` filter |
| `/api/vehicles` and `/api/fleet/live` | Recorder-backed vehicle state |
| `/api/vehicle/:vehicleId/trail` | Recorded vehicle trail |
| `/api/line/:lineId/stats` | Historical line delay statistics |
| `/api/analytics/journalism?hours=24` | Delay report; common windows are 24, 48, and 168 hours |
| `/api/analytics/ranking` | Delay ranking |
| `/api/analytics/termometre?hours=24` | Bus-service scorecard |
| `/api/analytics/export/csv?hours=48` | Delay-log CSV export |

Mataró-specific aliases and older compatibility routes also exist; [app/server.go](app/server.go) is the definitive route reference.

## Testing

```bash
npm ci               # dev tools: esbuild, eslint
npm test             # Auto-discovers every test/ suite
npm run test:list    # Show which suites would run
node scripts/docs_check.js # Local guide links and npm script references
```

Every `test/*.js` file runs in its own Node process with isolated temporary storage. These cover the browser code, the data scripts and the portal's TLS chain. The Go server has no unit tests of its own yet (the harness that compared it with the Node server went with that code); `go vet` and `gofmt -l` must be clean, and a server change is checked by running the binary on a copy of the database and comparing the affected endpoints.

## Avanza Mataró Timetable API & Data Extraction

The official Avanza Mataró portal (`https://mataro.avanzagrupo.com`) runs on a Liferay CMS that exposes internal AJAX service endpoints returning authoritative transit geometries, route variants, origin timetables, and stop-by-stop passing times across all day types (*Feiners*, *Dissabtes*, and *Diumenges i Festius*).

Other open-source tools and community transit projects can query these endpoints directly:

### 1. Route Variants & Geometry (`getTrayectosIda` / `getTrayectosVuelta`)

- **URL:** `POST https://mataro.avanzagrupo.com/detalle-linea?p_p_id=adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_cacheability=cacheLevelPage&_adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_cmd=getTrayectosIda`
- **Form Data:**
  - `_adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_idBusLine`: Line number (`1`–`8`).
  - `_adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_pathIdBusLine`: Direction path ID (e.g. `11`, `12`).
- **Response:** JSON containing GeoJSON `MultiLineString` route alignment, all sequenced stops (`outTrip.features` / `backTrip.features`), and route variants in `trayectosResponse`.

### 2. Origin Scheduled Departures (`getHorariosTeoricos`)

- **URL:** `POST https://mataro.avanzagrupo.com/detalle-linea?p_p_id=adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_cacheability=cacheLevelPage&_adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_cmd=getHorariosTeoricos`
- **Form Data:**
  - `_adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_idBusLine`: Line number (`1`–`8`).
  - `_adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_pathIdBusLine`: Direction path ID (e.g. `11`, `12`).
  - `_adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_direccion`: `'I'` (outbound / anada) or `'V'` (return / tornada).
  - `_adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw_primeraParada`: Origin stop ID (e.g. `1016`).
- **Response:** JSON containing `horariosTeoricosResponse` with complete departure lists by day type.

### 3. Stop-by-Stop Passing Times (`getHorarios`)

- **URL:** `POST https://mataro.avanzagrupo.com/detalleparada?p_p_id=com_ado_portlet_parada_AdoParadaPortlet_INSTANCE_PNmv1B2yu9UG&p_p_lifecycle=2&p_p_state=normal&p_p_mode=view&p_p_cacheability=cacheLevelPage&_com_ado_portlet_parada_AdoParadaPortlet_INSTANCE_PNmv1B2yu9UG_cmd=getHorarios`
- **Form Data:**
  - `_com_ado_portlet_parada_AdoParadaPortlet_INSTANCE_PNmv1B2yu9UG_idB`: Line number (`1`–`8`).
  - `_com_ado_portlet_parada_AdoParadaPortlet_INSTANCE_PNmv1B2yu9UG_busStopID`: Stop ID (e.g. `1015` El Cargol, `1134` Gatassa).
  - `_com_ado_portlet_parada_AdoParadaPortlet_INSTANCE_PNmv1B2yu9UG_busDir`: Direction (`1` for outbound, `2` for return).
- **Response:** JSON containing `horariosIdajson` with exact passing times at that specific stop for each day type.

### Protocol & Connection Notes

- **Session Cookies:** Send an initial `GET https://mataro.avanzagrupo.com/detalle-linea?idBusLine=1` to receive session cookies (`JSESSIONID`, `COOKIE_SUPPORT`), and supply them in the `Cookie` header on subsequent POSTs.
- **Headers:** Include `'X-Requested-With': 'XMLHttpRequest'` and `'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'`.
- **TLS Certificate Chain:** `mataro.avanzagrupo.com` serves its leaf certificate without the Sectigo intermediate that signed it, so neither Go nor Node can verify the chain and fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. This is repaired, not bypassed: the intermediate and its root are vendored in `src/data/certs/` and supplied for that host only, so verification stays on. **Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0` or `rejectUnauthorized: false`** — these notices and timetables would then be unauthenticated. See [OPERATIONS.md](OPERATIONS.md#certificate-chain-rotations) and `test/portal_tls_verification_test.js`.

### Automated Scraper Script

Arribo! includes a scraper script to automate extraction and calibration across all 8 lines and 155 stops:

```bash
node scripts/scrape_avanza_schedules.js
```

This updates the network schedule cache in `src/data/mataro_schedules.json` and keeps a local raw archive in `data/cities/mataro/avanza_raw_timetables.json` (git-ignored; the scraper reuses it as a cache on its next run).

#### Seasonal timetables (maresme.net)

The operator publishes a **genuinely different grid per season** at
`https://maresme.net/matarobus/{hivern,estiu}/`, and that is the grid riders are held to. It is
scraped separately:

```bash
node scripts/scrape_maresme_timetables.js            # write src/data/mataro_schedules.seasons.json
node scripts/scrape_maresme_timetables.js --diff     # report per-grid season provenance, write nothing
```

The seasons file carries **both** grids; `app/calendar.go` picks the one in force and
`app/schedules.go` serves it at load time, so no call site passes a season. Stop
geometry still comes from the Avanza scrape — only times are taken from maresme.net, which makes
cumulative offsets authoritative rather than locally calibrated.

`--diff` is the audit tool: it classifies every shipped grid as winter, summer, identical in
both, or neither. It is what surfaced the original defect — the previous
`mataro_schedules.json` held a **mixture**, with L1/L2/L4/L6/L8 winter in one direction and
summer in the other. Run `--diff` after every refresh to keep it from returning.

The active season and its provenance are reported on `/api/health` (`schedule.season`,
`schedule.seasonSource`, `schedule.seasonKnown`) and shown as a pill in the page header. A live
operator notice naming `estiu`/`hivern` outranks the static config in `SUMMER_WINDOWS`; outside
the period the data covers, the server reports the grid as **not** verified rather than asserting it.

