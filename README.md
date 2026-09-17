# Arribo! Mataró

Real-time bus tracking, arrival information, journey planning, and punctuality analysis for **Mataró Bus Urbà lines L1–L8**.

Arribo! combines Avanza SIRI vehicle and arrival data with local route geometry and timetables. The Catalan-language interface helps passengers find nearby stops, follow a bus, plan a journey, and inspect historical service performance.

## Current scope

The default line catalog, search, and background ingestion focus on Mataró's eight urban bus lines. The repository retains trackers from an earlier Catalonia-wide platform, but those operators are **not registered in the current default catalog**. Regional connections are available through the intermodal feature; that is not the same as full regional live-tracking coverage.

Older C-10 API paths and some architecture documents reflect that earlier scope. Use the current source code and [AGENTS.md](AGENTS.md) when working on the active app.

## Features

- **Live map and line details:** Leaflet maps with stops, route geometry, vehicle markers, direction selection, and telemetry inspection.
- **Arrivals and departure boards:** target-stop countdowns, timetables, and real-time or estimated departure information.
- **Stop discovery:** search for lines, stops, and streets; find nearby stops using location; browse neighborhood shortcuts and save favorite stops locally.
- **Journey planner:** the `/plan` page supports direct and one-transfer Mataró bus journeys, walking connections, and departure date/time selection.
- **Service notices:** official Mataró Bus disruptions and line-specific notices.
- **Intermodal connections:** regional rail and interurban bus connections at supported Mataró hubs, subject to upstream availability.
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

The main process serves the frontend and API, maintains in-memory fleet/report caches, and uses worker RPC for SIRI and historical database operations. The worker owns SQLite persistence and scheduled ingestion. Other features, such as geocoding and regional connections, have their own client paths.

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

The Compose service exposes port 3000 and mounts `./data:/app/data` for persistent storage. It uses Node 22 Alpine, `Europe/Madrid`, a 400 MB container memory limit, and a 160 MB V8 heap setting. See [docker-compose.yml](docker-compose.yml) and [Dockerfile](Dockerfile) for exact settings.

The repository targets a long-running Node/Docker deployment; retired serverless configuration has been removed.

### Storage settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | Repository `data/` | History database directory; not a global override for every data/cache path |
| `DB_PATH` | `transit_history.db` under `DATA_DIR` | Explicit history database path |
| `VEHICLE_SNAPSHOT_INTERVAL_MS` | `60000` | Minimum interval between stored snapshots per vehicle |
| `SNAPSHOT_RETENTION_HOURS` | `2` | Raw vehicle snapshot retention |
| `DELAY_RETENTION_DAYS` | `30` | Delay-log retention |

Storage sampling does not reduce live polling frequency. The ingestion daemon polls Mataró vehicles every 20 seconds, refreshes notices every five minutes, and schedules analytics reports every 30 minutes.

## Main API endpoints

API routes use GET; the server also permits HEAD. Other methods are rejected by the read-only guard, subject to CORS preflight handling.

| Endpoint | Purpose |
| --- | --- |
| `/api/health` | HTTP process health and uptime; not proof of fresh upstream data |
| `/api/lines` | Current Mataró L1–L8 catalog |
| `/api/search/stops?q=Hospital` | Search Mataró stops, lines, and street names |
| `/api/line/:lineId?direction=0` | Stops, geometry, and active buses |
| `/api/line/:lineId/vehicles` | Vehicle information for a line |
| `/api/line/:lineId/target-eta?direction=0&stopId=:id` | Target-stop arrival information |
| `/api/line/:lineId/stop/:stopId/departures?direction=0` | Stop departure board |
| `/api/stops/nearby?lat=:lat&lon=:lon` | Nearby stops and optional departures |
| `/api/plan?from=:origin&to=:destination` | Mataró journey planning |
| `/api/mataro/stop/:stopId/connections` | Regional connections at supported hubs |
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
```

Every `test/*.js` file runs in its own Node process with isolated temporary storage. A handful of retired-provider diagnostics and manual load tests are skipped with printed reasons (see `test/run.js`).

**Integration test note:** integration suites may start workers, contact upstream services, and write runtime data; inspect their setup before running against a deployment's data directory.
