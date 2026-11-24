# Passenger features and operations

## Planner contract

`GET /api/plan` (alias `/api/mataro/plan`) takes `from` and `to` stop IDs or text.
Optional `fromLat/fromLon` and `toLat/toLon` must be paired finite coordinates within
latitude/longitude ranges. Endpoint queries can identify a home or workplace: do not log them.

| Parameter | Meaning |
| --- | --- |
| `preference` | `fastest` (default), `least_walking`, `direct_only` |
| `walkingSpeed` | Metres/minute, 30–120; default 80 |
| `maxWalkingDistance` | Total access + transfer + egress metres, 50–5000; default 2000 |
| `departureDate` / `date` | `YYYY-MM-DD`, Europe/Madrid |
| `departureTime` / `time` | `HH:MM`, Europe/Madrid |

Without date/time the search leaves now. Missing date uses today; missing time uses
the current local clock. Invalid inputs return 400. Nonexistent spring-DST times are
rejected; repeated autumn times select the earlier occurrence. The horizon is 24 hours
from the requested instant; no feasible service returns no itineraries rather than a
missed connection. Bus journeys are Mataró's, direct or with one transfer. Train journeys (Rodalies, FGC) are added when an endpoint names a station (as typed, accents, case and punctuation ignored) or is a point within 1.5 km of stations, and the two points are at least 3 km apart: direct or with one change, at the same station (3 min minimum) or at a nearby station up to 400 m away, across operators too. They use the operators' timetables, with the live delay only for trains the operator reports running (`timingSource` `live`, else `timetable`); walks to, from and between stations are straight lines with a detour factor, marked `approximate`. Train itineraries carry `mode: "rail"`, legs `mode: "rail"`, `agencyId`, `lineId` = the line's ref (`renfe_rodalies:R1`) and `tripId`. A journey needing two changes is not found yet.

Boarding follows access walking plus 60 seconds, or previous alighting plus transfer
walking plus 120 seconds. Cumulative timetable offsets supply ride durations when
present; otherwise they are labeled heuristic. Live boards are considered only near
now (within 20 minutes); distant future searches use timetables. Walks are resolved
before final feasibility checks. Fastest ranks by arrival; least walking ranks by
walking distance then arrival; direct only excludes transfers.

Additive response fields:
- Itinerary `id`: stable line/direction/boarding/alighting identity for refresh.
- `requestedDepartureAt`, `arrivalAt`: UTC ISO instants.
- `totalDurationMinutes` / `totalDurationMins`: wait-inclusive duration.
- `walkingMinutes`, `walkingDistanceMeters`, `rideMinutes`, `waitMinutes`,
  `initialWaitMinutes` and, for transfers, `transferWaitMinutes`.
- `timingSource`: `live`, `timetable` or `heuristic`.
- Legs include `boardAt`, `alightAt`, `waitMinutes`, `timingSource`; old departure
  clocks/countdowns/duration aliases remain. Rounded components can differ from totals.
- Walks include `distanceMeters`, `durationSeconds`, `[lat,lon]` `polyline`,
  `source` (`openrouteservice` or `approximate`) and `approximate` boolean.

## Fares

Every planner itinerary (bus and train) carries an additive `fare` object, or `fare: null` when the price is not known. It is always labelled "preu orientatiu" with the date the fares came into force. The table is [src/data/fares.json](src/data/fares.json) and the code is `app/fares.go`.

What is priced: Mataró Bus journeys (own single 1.70 €, which covers line changes within 75 minutes from the first boarding; own T-10 4.85 €, 0.485 €/trip; ATM 1-zone single 2.90 € and T-casual 1.30 €/trip as alternatives) and Rodalies/FGC journeys whose two stations are in `stations` and whose sector pair is in `sectorZones` (single ticket, one per leg, since it has no transfers; T-casual per trip inside the transfer window of 75 min for 1 zone, +15 min per extra zone, 3 h 30 for 7 zones). Anything else is `null`: only the Mataró (3E) row of the sector matrix and a few stations are checked in, and a missing pair is never guessed. The full stop-to-sector import is plan step 4.3.

Yearly update:

1. Fares change around 15 January (DOGC; the ATM board approves in mid-December). From late December look for the new ATM Àrea de Barcelona price list and the Mataró Bus fares at mataro.avanzagrupo.com/ca/tarifas-y-titulos.
2. The 50% discount on T-usual and T-jove depends on State and Generalitat co-funding, decided year by year (December and June). Recheck it every year. The single ticket, T-casual and own Mataró tickets are not discounted.
3. Edit `src/data/fares.json`: `validFrom` (the date the new prices apply), `checkedOn`, `sources`, the `atm` price lists (7 zones each), `mataroBus`. Then run `node scripts/lib/dataJson.js src/data/fares.json` and `npm test` (`test/fares_data_test.js` and `app/fares_test.go` pin the invariants and some prices: update those expectations to the new prices).
4. To price more stations, add `stations` (folded name: lowercase, no accents or punctuation) and the matching `sectorZones` rows from the ATM `stop_areas` / `fare_leg_rules`.

## Existing OpenRouteService endpoint

Walking routing is **disabled unless ORS_BASE_URL is configured**. In production environments
where ORS environment variables are unset, walking calculations fall back to straight-line
approximate distance (`source: 'approximate'`, `approximate: true`). There is no silent public
provider default. To enable actual street-network pedestrian routing, configure a self-hosted
OpenRouteService container (e.g. using the official `openrouteservice/openrouteservice` image) or
provide an ORS key, setting process environment variables or Compose `.env`:

```text
ORS_BASE_URL=https://your-existing-ors-host.example/ors
ORS_API_KEY=your-provider-issued-key
```

The binary does not load `.env` itself (Compose does, for `docker compose`). Include `/ors` only if required
by your deployment, and do not append `/v2`. The adapter POSTs to
`{base}/v2/directions/foot-walking/geojson` with an optional Authorization header.
GeoJSON uses [lon,lat], converted back for Leaflet. URLs and keys are server-only
configuration, never request parameters.

The provider receives walking endpoints, which may be sensitive. Review hosting,
privacy policy and logging before enabling. Tests use a local stub, not personal
coordinates. Unconfigured service, timeout, invalid responses or exhausted budgets
produce explicitly approximate straight lines, not proof of pedestrian access, safe
crossings or step-free accessibility. Walking speed sets a minimum duration.

Limits: 2.5-second timeout, 256 KiB response, 256 cache entries, one-hour success TTL,
15-second failure TTL, three concurrent calls, twelve new calls per evaluation.

## Saved journeys, offline mode and updates

Up to 20 saved journeys and 10 recent searches use versioned browser localStorage.
Endpoints (including coordinates), labels, preferences and walking settings are
local to the device; live predictions are never stored. Repeating fetches current
results and defaults to leave-now unless date/time was explicitly saved. Rename,
remove and clear-all are available. Storage denial falls back to memory; clearing
site data removes saved entries. This is not encrypted or cross-device account storage.
Searches still send endpoints to the server and applicable configured location services.

After successful online installation the shell supports offline main/planner navigation
and planner aliases. Remote map tiles/libraries are not guaranteed offline. Catalog
and textual stop-search responses have a bounded cache (32 entries, 24-hour TTL).
Coordinate searches and dynamic arrivals, fleet and planner responses are not cached.
Offline warnings prevent treating countdowns as current; saved journeys remain visible
but calculating a route requires network.

Essential shell caching is atomic. New workers wait for the user to press
“Nova versió disponible · Actualitzar”, then activate and reload the accepting page
once. Cleanup affects only Arribo-owned caches. Update both HTML asset versions and
service-worker versions together when shell assets change.

## Moventis poller metrics

With `ARRIBO_MOVENTIS=1` the poller asks moventis.es for one stop at a time, at least 11 s apart. `/api/moventis` (field `status`) shows how it is doing: `sampledStops` is how many stops a cycle picks (spaced about as far apart as consecutive buses, preferring stops shared by several followed lines); `askedStops` and `skippedStops` split the last cycle's samples into those asked and those skipped because the stop's last answer showed no live bus and no timetable departure within 60 min (every stop is asked at least every 30 min); `lastCycleSec` is the duration of the last full cycle; `throttled` counts the site's placeholder answers (each starts a back-off, `backoffSec`), `requests` and `errors` count all calls. Off-peak, `skippedStops` rises and `lastCycleSec` falls. If a cycle asks nothing, the poller waits a minute before the next.

## Health, logs and shutdown

- `/api/health` remains HTTP-200 liveness and the Docker healthcheck target. It also
  reports `schedule`: the active timetable season, why it was chosen, whether the
  server considers the date covered, and `drift`: `{ drift, checkedAt, differencesCount }`
  (or null before the first check). The read is in-memory and touches neither a provider
  nor SQLite, so it does not weaken the probe contract.
- `/api/ready` returns 503 before catalog/worker usability and while stopping,
  otherwise 200 with `ready` or `degraded` status. Fleet fetch age over 60 seconds
  (or unknown) marks degraded; an empty overnight fleet alone does not.
- Fleet observation/fetch, arrivals fetch, notices and report freshness are separate.
  Unknown ages are null, not zero. Notice/report ages do not change the current
  fleet-based degraded classification. Probes never fetch upstream or query SQLite.
- New API request logs use generated X-Request-ID, route template, status and duration,
  excluding routine health probes and SSE. Query strings/credentials are omitted.
  This is not an audit of all retained legacy diagnostic logging.

CLI SIGINT/SIGTERM marks readiness false, closes SSE, drains HTTP for up to five
seconds, then awaits worker shutdown for up to five seconds. A 12-second outer
deadline fits the 15-second Compose grace. Validate signal handling on Linux or in the container.

## Reproducible installation

The Dockerfile has three stages. `assets` uses the pinned official
`node:22.23.4-alpine` manifest digest only to minify the browser files; `build`
compiles the Go server with `golang:1.26-alpine` against the locked `go.sum`; the
runtime image is `scratch` with the binary, CA certificates, the timezone data,
`public/` and `src/data/`. The digest pin ensures repeatability, not that the image is
the latest security patch. For updates, verify an existing official tag/digest, review
security fixes, run the tests and container boot/shutdown checks, then update the pin.
Non-root operation (uid 1000, all capabilities dropped, no-new-privileges),
`GOGC=50` / `GOMEMLIMIT=128MiB` and the 400 MB Compose limit remain.

The image is built in two stages. The `assets` stage runs a full locked `npm ci` (dev dependencies included) and minifies copies of `public/js/*.js` and `public/css/*.css` with esbuild (`scripts/minify_public.js`); the runtime stage copies only those minified files over the readable sources. HTML, `sw.js` and the manifest are served unchanged. To debug a browser error with readable stack traces, run the binary from a checkout (see README, *Run locally*), which serves the sources.

## Consistent backup and isolated restore

The administrative CLI uses SQLite VACUUM INTO from a read-only source, including
committed WAL contents, verifies integrity/required tables and atomically publishes
via a same-directory hard link. The target filesystem must support hard links.
Existing targets are refused. Create destination directories yourself, restrict
access (history includes GPS), and allow disk space for staging plus retained copies.
A five-second busy timeout bounds lock waits, not total copy duration.

```bash
node scripts/history_backup.js backup data/transit_history.db /backups/history-2026-09-17.db
node scripts/history_backup.js verify /backups/history-2026-09-17.db
node scripts/history_backup.js restore /backups/history-2026-09-17.db /restore-check/history.db
```

## Stop visits backfill

The historical analytics system measures punctuality per **stop visit** (one vehicle
serving one stop), consolidating raw 20-second GPS polls. For databases populated
prior to stop visits tracking, the offline backfill CLI reconstructs `stop_visits`
records from historical `delay_logs` using SQLite window functions:

```bash
# Must be executed offline (stop the service or run against a backup copy)
node scripts/backfill_stop_visits.js data/transit_history.db

# To re-run and overwrite existing backfilled records:
node scripts/backfill_stop_visits.js data/transit_history.db --force
```

- **Concurrency protection:** Tries `BEGIN IMMEDIATE` and aborts immediately with a clear error on `SQLITE_BUSY` if the database is active or locked by another process.
- **Idempotency:** Checks for existing `source = 'backfill'` rows and skips unless `--force` is supplied. Never exposed over HTTP.


## Seasonal timetable checks

The grid in force changes with the season, and the summer grid is a real, different
schedule — not a variant. Two things to know operationally:

- **Confirm which grid is live** with `curl -s localhost:3000/api/health | jq .schedule`.
  `season` is what is being served, `seasonSource` is why, and `seasonKnown: false`
  means the date is outside the period the data covers and the grid is unverified.
  The same values appear as a pill in the page header.
- **Refresh the grids** with `node scripts/scrape_maresme_timetables.js`. Run it with
  `--diff` first: it classifies every shipped grid as winter, summer, identical in both,
  or neither, and writes nothing. A line reported as differing between its two
  directions is the mixed-season defect that shipped before — stop and investigate
  rather than committing the output.

The season is not hard-coded to a calendar rule. A live operator notice naming
`estiu`/`hivern` with a date window outranks the static `SUMMER_WINDOWS` config, so a
published summer period is picked up from the aviso sync without a code change. Two
overlapping notice windows resolve to winter marked `seasonKnown: false` rather than an
arbitrary pick. The known summer window in config is 27 Jul – 23 Aug 2026, the only one
the operator has published; **the 2026–2027 season boundary dates are not published**, so
add them to the summer windows in `app/calendar.go` when they are.

## Certificate chain rotations

`mataro.avanzagrupo.com` serves its leaf certificate **without** the Sectigo
intermediate that signed it, so a verifying client cannot build the chain and rejects
the connection. The chain itself is valid — the leaf's AIA extension points at the
missing certificate — so the intermediate and its root are vendored in
`src/data/certs/` and applied to that host only: by `chainRepairHosts` in `app/httpguard.go` for
the server, and by `scripts/lib/verifiedTls.js` for
`scripts/scrape_avanza_schedules.js`. Verification stays on for every request.

The scraper uses a plain `https.request` carrying that agent. Global `fetch`
is deliberately **not** used, because undici cannot accept a per-request
`https.Agent`. Setting `NODE_EXTRA_CA_CERTS` inside the script is not a
workaround either — Node reads that variable once at process startup.

**Do not respond to a chain error by disabling verification.**
`InsecureSkipVerify`, `NODE_TLS_REJECT_UNAUTHORIZED=0` and
`rejectUnauthorized: false` authenticate nothing, and the affected responses are operator notices (which drive line
detours and the season calendar) and scraped timetables. A stale notice is a
better failure than a forged one.

### Symptoms

| Log / test output | Meaning |
| --- | --- |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | The portal is serving a leaf with no intermediate again. Re-vendor the chain. |
| `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` | Sectigo rotated to a new CA. The vendored root no longer signs the leaf. |
| `CERT_HAS_EXPIRED` | A vendored certificate reached its expiry. |

`describeChainFailure()` in `app/httpguard.go` names the cause in
the tracker log (in Node's error codes, as above), and a failed avisos fetch falls back to the last known
notices rather than serving nothing.

### Re-vendoring

1. Read the leaf's current AIA pointer to learn which intermediate is expected:
   ```bash
   node -e "const tls=require('tls');const s=tls.connect({host:'mataro.avanzagrupo.com',port:443,servername:'mataro.avanzagrupo.com',rejectUnauthorized:false},()=>{console.log(s.getPeerCertificate().infoAccess);s.end();});"
   ```
   Prints the `CA Issuers - URI` for the intermediate. Repeat the same command
   against the downloaded intermediate to find its root.
2. Download the intermediate from its AIA URL, then the root from the
   intermediate's own AIA URL. Both are DER, not PEM — convert before saving.
3. Replace `src/data/certs/sectigo-ov-r36-intermediate.pem` and
   `src/data/certs/sectigo-root-r46.pem` (rename if the CA changed), and
   regenerate `avanza-portal-chain.pem` (intermediate **and** root, one file).
4. Update the two pinned SHA-256 fingerprints in
   `test/portal_tls_verification_test.js`.
5. `npm test`. The suite re-verifies both signatures, both fingerprints, the
   expiry dates, and that the live portal still authorizes — an unrotated
   vendored cert fails loudly here rather than in production.

## Promoting a restore

Verification returns counts for delay_logs and vehicle_snapshots. Restore writes a
**new isolated target**, never replacing live storage. Never copy only the main file
of a running WAL database. To promote a restore:
1. Verify and restore to a new directory. Inspect counts; use a read-only SQLite
   client on that scratch copy for additional read queries if needed.
2. Obtain operator approval and stop the application; confirm the worker exited.
3. Preserve the old database and WAL/SHM together for rollback. Never pair restored
   data with stale sidecars from another database, or delete a live WAL file.
4. Point DB_PATH to the restored file, explicitly updating Compose mount/environment
   if applicable. Grant service-account access, restart, check readiness/history.
5. Retain old storage until recovery is confirmed. Promotion is not automated.

### Windows Task Scheduler example (operator-installed)

Create an access-restricted backup directory and an operator-owned PowerShell script
with verified local paths:

```powershell
$ErrorActionPreference = 'Stop'
$node = 'C:\Program Files\nodejs\node.exe'
$repo = 'H:\Coding\Arribo!'
$backupDir = 'D:\ArriboBackups' # configurable; must already exist
$target = Join-Path $backupDir ('history-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.db')
& $node "$repo\scripts\history_backup.js" backup "$repo\data\transit_history.db" $target
if ($LASTEXITCODE -ne 0) { throw 'Arribo backup failed' }
```

In Task Scheduler set a daily trigger and an account with database/backup access.
Action: powershell.exe; arguments:
`-NoProfile -NonInteractive -File "D:\ArriboBackups\backup-arribo.ps1"`.
Check task exit status and periodically verify an isolated restore. Nothing is
scheduled by the app. **Retention defaults to keep everything**: configure your
backup system explicitly (for example 30 verified daily copies). The CLI does not
prune old files automatically. Monitor disk space.

## Timetable drift monitoring and refresh procedure

The ingestion worker automatically monitors maresme.net for timetable drift daily at
04:1x Europe/Madrid without touching the HTTP process or writing files to disk.
The drift status is published via `/api/health` under `schedule.drift`:

```json
"schedule": {
  "season": "winter",
  "drift": {
    "drift": false,
    "checkedAt": "2026-09-28T04:15:00.000Z",
    "differencesCount": 0
  }
}
```

If `drift.drift` is `true`, the published timetable on maresme.net has changed compared
to the shipped `src/data/mataro_schedules.seasons.json`. To refresh:

1. Review differences against the published grid:
   ```bash
   node scripts/scrape_maresme_timetables.js --diff
   ```
2. If differences are legitimate operator updates, scrape and regenerate the seasons dataset:
   ```bash
   node scripts/scrape_maresme_timetables.js
   ```
3. Run the validation suite to ensure integrity:
   ```bash
   npm test
   ```
4. Deploy the updated dataset.

### Data file format

The scrapers and `scripts/stop_route_distances.js` write the timetable, route and stop
files with `scripts/lib/dataJson.js`: one trip or stop per line, short lists packed
several to a line, so the files stay diffable at about a tenth of their pretty-printed
size. The seasons file stores each day type once (`weekday`, `saturday`, `sunday`); the
server rebuilds the Catalan alias keys (`Feiners`, `Dissabtes`, `Diumenges i Festius`,
`festius`) when it loads it. If a data file is replaced by hand (a new route export, for
example), rewrite it with `node scripts/lib/dataJson.js <file>`;
`test/data_files_format_test.js` fails until you do.

### Moventis static data from the Generalitat GTFS

`src/data/gencat_casas.json` holds the seven Empresa Casas (Moventis) lines through
Mataró (C-10, C-20, C-30, e11.1, e11.2, 865, N-80), cut out of the Generalitat de
Catalunya interurban bus GTFS: stops, simplified road shapes, trips with the published
departure time at every stop, the calendar of the services they use, and a crosswalk from
moventis.es stop ids (`ID_PARADA`) to GTFS stop ids. Refresh it (the feed is updated every
few days; the calendar runs to 2027-06-30) with:

    node scripts/import_gencat_moventis.js            # downloads the 24 MB zip, then asks moventis.es
    node scripts/import_gencat_moventis.js --zip busos-interurbans-GTFS.zip --last-modified "<HTTP date>"

It needs Node 22 and no packages. moventis.es is asked for 7 `GetTrayectos` answers, one
request at a time, 11.5 s apart (its robots.txt asks for a 10 s crawl delay; keep it), so a
run takes about 1.5 minutes. `--moventis-cache DIR` saves and reuses the raw answers;
`--skip-moventis` keeps the crosswalk already in the file. Check the printed match
statistics and the list of unmatched stops, then run `npm test`. Times keep the feed's
non-zero seconds (they come from a speed/distance export, not from timepoints). The
data is under the "Llicència oberta d'ús d'informació – Catalunya": credit
"Generalitat de Catalunya" wherever it is shown and do not alter its meaning. It lives
in `src/data/` (baked into the image) because production mounts `./data` over the
image's `data/`.

The server (`app/moventisgencat.go`) reads it once at start-up and uses it for two things:

- **Shapes** (plan step 2.3). Each moventis.es route gets the Generalitat shape of its line
  that fits it best: its stops, in order, are projected onto the shape (never going back, so
  loops and out-and-back streets keep their order), and the shape is used when at least 90%
  of the stops lie within 150 m. The line view draws it from the first to the last stop, and
  an estimated bus between two stops is placed at the same share of the way along the road
  instead of on the straight line. Without a fitting shape the moventis.es KML is drawn and
  buses go straight between stops, as before. On 2026-11-24 every route fitted; the stops
  off their shape were the "(Habilitada)" temporary stops of a diversion and the N-80
  terminus at Mataró station.
- **When a line is due** (plan step 2.4). Before asking a sampled stop, the poller looks up
  when each followed line is next due there by the timetable. A departure due within 60 min
  makes it ask, like a timetable time in the stop's last answer; while the timetable knows
  every line at the stop and has none due within two hours, the "ask every 30 min anyway"
  re-ask stretches to every two hours (night hours, the N-80 by day). A line or stop not in
  the file keeps the old rules.
- **Feed gaps.** A day on which the file has no trip of a line at all is read as "the
  timetable does not know", never as "no bus": the 23 Nov 2026 feed gave the C-10's weekday
  service (184910) dates only from January 2027, so by the file the C-10 ran no weekday trip
  in 2026. Check this after each refresh (`TestGencatTimetable` uses a Saturday).

The Moventis attribution in the API (`attribution`) reads "… · Recorreguts i horaris:
Generalitat de Catalunya" while the file is loaded.

### Yearly seasonal upkeep checklist

In June of each year, the operator publishes the summer service window notice (e.g. "HORARIS ESTIU <year>").
1. Check `/api/health` for `schedule.seasonOutlook`: starting 1 June, a warning (`Horari d'estiu <year> no configurat`) is published if the upcoming summer window is not yet configured.
2. Read the operator's summer notice from the portal or notice feed to find the exact service dates.
3. Add the dated window to the summer windows in `app/calendar.go` with its `source` description.
4. Run `node scripts/scrape_maresme_timetables.js --diff` to check that both directions of every line come from the same season, then build and vet the server.
5. Deploy the updated configuration.

### Yearly holiday upkeep

`src/data/holidays.json` holds the regional holidays and Mataró's two local days per year. The Generalitat publishes both as open data (Socrata, no key): `yf2b-mjr6` (regional, usually by spring) and `b4eh-r8up` (local days of every municipality by INE code, usually by December).

```bash
node scripts/update_holidays.js --check
```

reports any date the open data and the file disagree on (exit 1) and the years not published yet; without `--check` it adds published dates the file lacks (generic name, dataset as source) and never removes one. `--ine <code>` and `--years 2026,2027` choose another municipality or years. Review the diff, give new entries their proper name and legal source, and deploy.

### Service overrides for special days

Each year in `src/data/holidays.json` has a `serviceOverrides` list (empty today). An entry makes one calendar date use another day type's timetable, whatever the weekday or holiday calendar says:

```json
"serviceOverrides": [
  { "date": "2026-07-25", "dayType": "saturday" }
]
```

`date` is `YYYY-MM-DD` in Europe/Madrid and `dayType` is one of `weekday`, `saturday`, `sunday` (the day types of the timetable grid). `getServiceOverride` (`app/calendar.go`) is read first by `resolveDayType` (`app/schedlogic.go`), so an override wins over a holiday and over the weekend rule, and the day is then not reported as a holiday. It is keyed by the date of the instant being asked about and only chooses which existing grid is used: it adds no trips, so a night that needs trips the grid does not have (for example Les Santes after 22:00) cannot be created this way. Add an entry only when the operator has published that the day runs like another day type, quote its notice in the commit message, and do not guess: a wrong override moves every line's expected departures and the Observatori's delay matching for that day.

Yearly checklist, once the Ajuntament and the operator have published the dates (the 2026 local holidays are Fira, 25 May, and Les Santes, 27 July):

1. Les Santes (July): read the Ajuntament's "Afectacions de Mataró Bus" notice, decide whether any night needs an override (the Nit Boja and Castell de Focs nights are the usual ones), and on the Castell de Focs night check `/api/vehicles` for the special "Bus Focs" lines 10, 11, 12, which are shown as "Servei especial" with no timetable.
2. Fira (late May): the local holiday is already in `holidays.json`; check the notice for a changed service.
3. Tots Sants (1 November, a regional holiday): confirm it is in the year's `regional` list (it runs on the `sunday` grid) and read the operator's notice for the eve and the day.
4. Christmas: read the notice for 24, 25, 26 and 31 December and 1 and 6 January; add overrides only for dates that run unlike their usual day type.
5. Run `npm test`, then deploy.

### Dated diversions

`src/data/mataro_events.json` lists dated Mataró Bus diversions and stop closures (Les
Santes, Fira, Reis…). While an event's window is open, the server (`app/mataroevents.go`)
serves it as a notice of the same shape as Avanza's, with three more keys:
`"source": "calendar"`, `startsAt` and `confidence`. It goes into the line view (banner,
notice list) and `/api/disruptions`. Each stop id it lists is marked closed in that line's
view, with the additive key `divertedBy` and the label "Desviada". The events are added
where the server reads notices, never to the worker's Avanza list, so their text is never
parsed for dates and nothing reaches the history database.

Each event: `id`, `title`, `start` and `end` (Europe/Madrid local `YYYY-MM-DD HH:MM`, end
exclusive), `lines` (`"1"`…`"8"`; empty means a general notice), `stops` (Mataró Bus stop
ids from `data/cities/mataro/mataro_paradas.json`; empty when the notice names no stop),
`description` (as published, in Catalan), `source` (the notice's URL) and `confidence`
(`reported` from a search summary, `verified` once read on the official page). An event
with a bad window is skipped with a log line. The file is in the data-file format
(`node scripts/lib/dataJson.js src/data/mataro_events.json`) and is baked into the image,
so a change needs a deploy.

It is seeded with the 2026 Les Santes diversions from research report 10. They are line
level only: the notice's stop table could not be retrieved. Every year, read the
Ajuntament's avisos (mataro.cat/ca/actualitat/avisos) and add the year's events:

- Fira a Mataró (local holiday, late May);
- Les Santes (about 18–29 July; the notice comes out in mid-July): Dissantes, Gegantada,
  Barram, Nit Boja, castell de focs (the Bus Focs lines 10–12 show by themselves, see
  `ARRIBO_SPECIAL_LINES`);
- Tots Sants (1 November, Cementiri de Les Valls);
- Christmas to Reis (24 December – 6 January, including the 5 January Cavalcada).

Not done: the journey planner still only avoids the stops Avanza's notices cancel, not the
stops these events close.

### FGC series and occupancy (Geotren)

The FGC poller also reads FGC's open dataset `posicionament-dels-trens` (Geotren,
`https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/posicionament-dels-trens/records?limit=100`)
every 3 minutes (`app/fgcgeotren.go`). Per train in service it gives the unit type
(`tipus_unitat`: the series, 112, 113, 114, 115, 213…) and the occupancy FGC reports per car
(`ocupacio_<car>_percent`, cars MI, RI, M1, M2…). Its `ut` is the GTFS-RT vehicle id and its
`id` the trip id, so it joins exactly: 57 of 58 trains on 2026-11-24. `/api/trains` adds an
additive `unit` key to those trains: `series`, `occupancyPercent` (the mean of the cars),
`cars`, `observedAt` and `source: "fgc_geotren"`. A record older than 7 minutes is dropped.
The train popup shows "Unitat de la sèrie 112 · Ocupació segons FGC: 39%".

**Quota.** FGC allows 5 000 anonymous requests a day per address. The poller uses about
4 610: positions every 30 s (2 880), trip updates every 90 s (960), alerts every 5 min (288),
Geotren every 3 min (480), plus a few dataset lookups. Do not add another FGC request without
lowering one of these.

## AMB Bus Metropolità

With `ARRIBO_AMB=1` (on in compose) and the GTFS-RT pollers (`ARRIBO_GTFSRT=1`), the
pollers follow the Àrea Metropolitana de Barcelona's buses (`app/amb.go`): 140 lines of
11 operators (TUSGSAL, Baixbus, Monbus, Moventis, Soler i Sauret, TGO, Aerobús…). Sources,
open and keyless:

- `https://www.ambmobilitat.cat/transit/trips-updates/trips.bin`: GTFS-RT trip updates,
  every minute (~260 KB; about 870 trips in the evening). Predicted arrival times per stop
  and a `vehicle` (fleet number), but no delays and **no positions**:
  `vehicle-positions.bin` does not exist.
- `https://www.ambmobilitat.cat/transit/alerts/alerts.bin`: service alerts. Their texts
  come as HTML; `ambAlertText` turns them into plain text.
- `https://www.ambmobilitat.cat/OpenData/google_transit.zip`: the static GTFS (8 MB, a
  six-day window, republished daily), imported by the daily timetable refresh. The import
  takes ~3 s, ~30 MB of memory, and gives a ~95 MB timetable under `DATA_DIR/gtfs/amb.db`.

What it gives: the lines in the catalog (group "AMB", mode "Bus", `positions: "none"`),
their line views (stops and paths from the GTFS, AMB alerts), and departures at each stop.
A departure counts as live when the trip's update names a bus whose next predicted stop is
at most 30 minutes away (`rtNoFeedRunningWindow`). Its delay is the predicted time against
the timetable (`delaySource: "timetable"`). AMB also lists trips that have not started yet,
up to two hours ahead; those stay on timetable times.

What it does not give:

- **Buses on the map.** No source publishes AMB GPS. The map counter says "Sense posició
  dels busos (AMB)".
- **Dades history.** The source has `noHistory`: about 30 000 trips a day would add some
  750 000 stop-visit rows a day to the history database. A punctuality report for AMB needs
  sampled or aggregated storage first.
- **`/api/trains` and the rail planner.** These stay with the train operators.

The credit is "Àrea Metropolitana de Barcelona (dades obertes)", on the line view and the
departures.

## Vercel domain (proxy only)

The Vercel project for the `bad-amb-bus-tracker` domain does not run Arribo: the Go server, its polling, SQLite and SSE need the always-on VPS, and Vercel functions are short-lived with no persistent disk. `vercel.json` makes each deployment a proxy instead: no install or build (the build only writes an empty `.vercel-proxy/` output folder, so no stale copy of `public/` is ever served from Vercel), and every path is rewritten to the live app on the VPS (`http://87.106.33.66:3000`). Change that address there if the VPS moves.

Limits of the proxy:

- The VPS sees Vercel's addresses, not the visitor's: `TRUSTED_PROXIES` cannot list Vercel's changing egress ranges, so visitors behind the same Vercel address share the API rate limit (120 requests a minute) and the SSE cap (8 streams per address). A refused stream falls back to polling. Watch for 429s in the browser if the domain gets traffic.
- Vercel may close long-lived responses, so the live SSE stream can reconnect or fall back to polling more often than on the VPS address.
- Production deployments follow the Vercel project's production branch (normally GitHub `main`); other branches get preview deployments of the same proxy.

## Documentation checks and credentials

Run `node scripts/docs_check.js` for relative links and npm script references in the
current guides. Historical ARCHITECTURE prose is not a current contract. No CI or
browser framework is introduced.

Credential values were removed from the agent guide and historical architecture.
This does not erase git history or remaining legacy source defaults. Review historical
exposure separately with the operator. No credentials were rotated, accounts changed,
history rewritten or production data replaced.

## Renfe long-distance feed (regional trains)

The Rodalies poller (`app/gtfsrtpoll.go`, `app/gtfsrtld.go`, only with `ARRIBO_GTFSRT=1`) reads, besides the commuter feed, `https://gtfsrt.renfe.com/vehicle_positions_LD.pb` and `trip_updates_LD.pb` (same host, no key, same licence and attribution; one request each per tick, so the cadence is the commuter feed's 30 s). They carry the Catalan regionals (R11, R13-R17, RG1, RL3/RL4, RT1/RT2) and some of them appear only there.

- **Matching.** LD trip ids (`<5-digit number><segment digit><date>`, label = the number, no route, no per-vehicle timestamp) are not in the Cercanías static GTFS. A train is kept only when its number matches a trip of the imported Rodalies timetable (the digits after `M` in ids like `5127M15916R11`) on a service date tried in order: the LD feed header's Madrid date, the day before (trains past midnight), then the date in the LD trip id (on 2026-11-24 that date was a day behind the trains it named, and the Cercanías timetable has one-day services, so it matched nothing). Renfe publishes one such id per day-type service, so the candidates are narrowed to the services active that day, and a number that still maps to different routes is dropped (an earlier date does not settle it). That gives the line and direction. Trains with no match (AVE, Avant, Alvia, Lleida/Zaragoza medium distance) are counted (`LDDropped`, in the `[GTFS-RT]` log line) and not shown.
- **Deduplication.** A number found in the commuter feed (by label or by static trip id) is skipped in the LD feed: the commuter entity wins because it has the line label, the platform and its own timestamp. Several LD entities with one number are one train.
- **Honesty.** An LD train has no timestamp of its own, so its position time is the LD feed's header time (`positionTimeSource: "feed"`), judged stale after 180 s like any other. `/api/trains` marks these trains with the additive key `feedVariant: "ld"`. The delay comes from the LD trip updates by number (`delaySource: "feed"`). A failure of the LD feeds is logged and kept in the snapshot (`LDErr`, `LDTripsErr`) and never affects the commuter feed.
- **Lag.** While the LD header is further behind the commuter feed's header than the stale window (180 s), no LD train is added and the `[GTFS-RT]` line says `long-distance feed <n> s behind the commuter feed: not shown`. On 2026-11-24 it was about 3 600 s behind, and the positions really were that old: trains in both feeds were 4-75 km from where the commuter feed put them. Watch that log line; LD trains appear by themselves once the feed catches up.
- **Not done.** LD delays are not in the trip-level delay map used by station boards (boards still show the timetable for those trips); cancellations in the LD trip updates are ignored; LD-only trains get no station visits, platform sightings or history rows from trip updates.

`src/data/renfe_fleet.json` is the static rolling-stock table (series, manufacturer, cars, length, seats, speed, accessibility, usual lines), from research report 02 section 4. All figures are marked unverified; series 470 is in service on R15/R17 (seen 2026-11-24). The server (`app/renfefleet.go`) reads it once and adds `usualSeries` (the series in service whose `usual_lines` include the train's line) to each Rodalies train in `/api/trains`; the train popup shows it as "Sèries habituals en aquesta línia: …. No se sap quina unitat fa aquest tren." When `ARRIBO_RENFE_MAP=1` (`app/renfemap.go`), regional trains seen in `flotaLD.json` get their actual coupled units (`unit`, enriched with `renfeSeriesSpecFor`), commuter trains get unofficial `nextVia`/`via` platforms when official GTFS-RT labels omit them, and `accesible` populates `wheelchairAccessible` — all labelled "font no oficial".

## Additional Catalonia networks (TRAM, TMB, Sagalés, TMG Girona)

Each runs as its own poller or GTFS-RT source with `noHistory: true` (never written to the persistent Mataró/rail history SQLite):

- **TRAM Barcelona (`app/tram.go`, `ARRIBO_TRAM=1`)**: requires `TRAM_CLIENT_ID` and `TRAM_CLIENT_SECRET` in `.env` (never committed). Polls Trambaix (`TBX.zip` + `networkId=1`, T1–T3) and Trambesòs (`TBS.zip` + `networkId=2`, T4–T6) via OAuth2 `client_credentials` token cache. Cites "Powered by TRAM Barcelona (https://opendata.tram.cat)" with the update date; no history stored due to deletion terms.
- **TMB Metro & Bus (`app/tmb.go`, `ARRIBO_TMB=1`)**: requires `TMB_APP_ID` and `TMB_APP_KEY` in `.env`. Daily GTFS import (`api.tmb.cat/v1/static/datasets/gtfs.zip`, URLs never logged) provides Metro (L1–L5, L9N/S, L10N/S, L11, FM) and TMB Bus (105 lines). Single-call Metro iTransit (`itransit/metro/estacions`) polls every 30 s; TMB Bus stops query `itransit/bus/parades/{code}` on demand with a 20 s TTL cache (dropping `transit_namespace="amb"` duplicates when `ARRIBO_AMB=1`). Cites "Transports Metropolitans de Barcelona (TMB)" with the update date.
- **Sagalés (`app/sagales.go`, `ARRIBO_SAGALES=1`)**: unofficial public JSON (`sagales.com/es/real-time-bus/{id}/{dir}`), default 13 Maresme/Vallès/Girona lines (`550,551,553,554,400,405,691,601,604,617,671,672,673`; overridable via `ARRIBO_SAGALES_LINES`). Gives real GPS (`postion` key), delays, stops, and encoded polylines; deduplicates repeated trips per physical vehicle; labelled "font no oficial".
- **TMG Girona (`app/girona.go`, `ARRIBO_GIRONA=1`)**: static GTFS from NAP feed `1570` (`NAP_API_KEY` in `.env`) plus on-demand unofficial live stop predictions (`web2.girona.cat/appbus/cat/busos_json.php`, 20 s TTL cache, falls back to GTFS when "(sense informació)"). Labelled "font no oficial".

### Refreshing ATM GTFS-Fares v2 (`src/data/fares.json`)

```bash
NAP_API_KEY=... node scripts/import_atm_fares.js
# or from a local copy of NAP 2059:
node scripts/import_atm_fares.js --zip nap2059.zip
```

Imports the full 46×46 ATM Àrea de Barcelona sector matrix, Rodalies/FGC stop-to-sector mappings, priority-1 `ROD_Z1`/`FGC_Z1` boundary overrides (multi-trip only), and `STI_Barcelona` route membership while preserving the non-GTFS override layer (Mataró Bus own tickets, Aerobús, Airport Metro L9 Sud, and non-integrated exclusions such as Cremallera de Núria). Run `npm test` after every yearly January fare refresh.
