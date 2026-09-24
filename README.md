# Arribo! Mataró

Real-time bus tracking, arrival information, journey planning, and punctuality analysis for **Mataró Bus Urbà lines L1–L8**.

Arribo! combines Avanza SIRI vehicle and arrival data with local route geometry and timetables. The Catalan-language interface helps passengers find nearby stops, follow a bus, plan a journey, and inspect historical service performance.

## Current scope

The default line catalog, search, and background ingestion focus on Mataró's eight urban bus lines. Trackers for the earlier Catalonia-wide operators have been removed from the codebase, so **Mataró is the only provider present**.

A few compatibility API aliases from that earlier scope remain (see the endpoint table below). [ARCHITECTURE.md](ARCHITECTURE.md) is historical. Use the current source code and [AGENTS.md](AGENTS.md) when working on the active app.

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

## Architecture

```text
Browser (vanilla JavaScript + Leaflet)
                 |
          Express HTTP server
          /api/* + public assets
                 |
           WorkerBridge IPC
                 |
      Background ingestion worker
      - Mataró SIRI polling
      - Fleet updates and service notices
      - SQLite history and delay recording
      - Cached analytics report generation
```

The main process serves the frontend and API, maintains in-memory fleet/report caches, and uses worker RPC for SIRI and historical database operations. The worker owns SQLite persistence and scheduled ingestion. Geocoding has its own client path.

- **Runtime:** Node.js **22.5 or newer**, required for built-in `node:sqlite`.
- **Production dependencies:** `express`, `cors`, and `compression`.
- **Frontend:** plain HTML/CSS/JavaScript; no build step is required.
- **Storage:** SQLite history plus local route and timetable data.

## Run locally

From the repository root:

```bash
npm ci
npm start
```

Open **http://localhost:3000**. `npm run dev` starts the same Node server; it does not provide automatic reload. Upstream live data requires network access.

## Docker deployment

```bash
docker compose up -d --build
docker compose logs -f arribo
```

The Compose service exposes port 3000 and mounts `./data:/app/data` for persistent storage. It uses a digest-pinned Node 22.19.0 Alpine image, `Europe/Madrid`, a 400 MB container memory limit, and a 160 MB V8 heap setting. See [docker-compose.yml](docker-compose.yml) and [Dockerfile](Dockerfile) for exact settings.

The repository targets a long-running Node/Docker deployment; retired serverless configuration has been removed.

### Storage settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | Repository `data/` | History database directory; not a global override for every data/cache path |
| `REPORTS_DIR` | Repository `data/reports/` | Independent generated-report directory |
| `ORS_BASE_URL` / `ORS_API_KEY` | Unset | Optional existing foot-walking endpoint; approximate fallback without it |
| `DB_PATH` | `transit_history.db` under `DATA_DIR` | Explicit history database path |
| `VEHICLE_SNAPSHOT_INTERVAL_MS` | `60000` | Minimum interval between stored snapshots per vehicle |
| `SNAPSHOT_RETENTION_HOURS` | `2` | Raw vehicle snapshot retention |
| `DELAY_RETENTION_DAYS` | `30` | Delay-log retention |

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

Mataró-specific aliases and older compatibility routes also exist; `server.js` is the definitive route reference.

## Testing

```bash
npm test             # Auto-discovers every test/ suite (except listed exclusions)
npm run test:list    # Show which suites would run and which are skipped
npm run test:full    # Also includes the performance benchmark suites
node scripts/docs_check.js # Local guide links and npm script references
```

Every `test/*.js` file runs in its own Node process with isolated temporary storage. A handful of retired-provider diagnostics and manual load tests are skipped with printed reasons (see `test/run.js`).

**Integration test note:** integration suites may start workers, contact upstream services, and write runtime data; inspect their setup before running against a deployment's data directory.

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
- **TLS Certificate Chain:** The upstream server certificate may lack intermediate certificates on standard Node trust stores; set `NODE_TLS_REJECT_UNAUTHORIZED=0` or supply intermediate CAs.

### Automated Scraper Script

Arribo! includes a scraper script to automate extraction and calibration across all 8 lines and 153 stops:

```bash
node scripts/scrape_avanza_schedules.js
```

This updates the network schedule cache in `src/data/mataro_schedules.json` and creates an archival snapshot in `data/cities/mataro/avanza_raw_timetables.json`.

#### Seasonal timetables (maresme.net)

The operator publishes a **genuinely different grid per season** at
`https://maresme.net/matarobus/{hivern,estiu}/`, and that is the grid riders are held to. It is
scraped separately:

```bash
node scripts/scrape_maresme_timetables.js            # write src/data/mataro_schedules.seasons.json
node scripts/scrape_maresme_timetables.js --diff     # report per-grid season provenance, write nothing
```

The seasons file carries **both** grids; `src/data/seasonCalendar.js` picks the one in force and
`src/data/mataroSchedules.js` serves it at require time, so no call site passes a season. Stop
geometry still comes from the Avanza scrape — only times are taken from maresme.net, which makes
cumulative offsets authoritative rather than locally calibrated.

`--diff` is the audit tool: it classifies every shipped grid as winter, summer, identical in
both, or neither. It is what surfaced the original defect — the previous
`mataro_schedules.json` held a **mixture**, with L1/L2/L4/L6/L8 winter in one direction and
summer in the other. `test/season_provenance_test.js` is the standing guard against that
returning.

The active season and its provenance are reported on `/api/health` (`schedule.season`,
`schedule.seasonSource`, `schedule.seasonKnown`) and shown as a pill in the page header. A live
operator notice naming `estiu`/`hivern` outranks the static config in `SUMMER_WINDOWS`; outside
the period the data covers, the server reports the grid as **not** verified rather than asserting it.

