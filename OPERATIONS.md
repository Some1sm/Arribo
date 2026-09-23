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
missed connection. Only direct and one-transfer Mataró journeys are supported.

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

## Existing OpenRouteService endpoint

Walking routing is **disabled unless ORS_BASE_URL is configured**. There is no silent
public provider default. Set process environment variables, or Compose `.env`:

```text
ORS_BASE_URL=https://your-existing-ors-host.example/ors
ORS_API_KEY=your-provider-issued-key
```

Plain `npm start` does not automatically load `.env`. Include `/ors` only if required
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

## Health, logs and shutdown

- `/api/health` remains HTTP-200 liveness and the Docker healthcheck target.
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
deadline fits the 15-second Compose grace. Windows native child termination does
not test POSIX signal delivery; validate that on Linux/container. When importing the
Express app, callers own servers opened with `app.listen()` and must close those
alongside calling `app.shutdown()` for worker cleanup.

## Reproducible installation

Docker uses locked `npm ci --omit=dev`, with no install fallback. Dockerfile pins the
verified official `node:22.19.0-alpine` manifest digest. This ensures repeatability,
not that the image is the latest security patch. For updates, verify an existing
official tag/digest, review security fixes, run syntax/full tests and container
boot/shutdown checks, then update the pin. A registry lookup is not a Docker build.
Non-root operation, 160 MB V8 heap and 400 MB Compose limit remain.

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

## Backfilling derived timetable times

Live ingestion derives `scheduled_time` / `actual_time` for each new delay row from
the static timetable and stamps `times_source='derived_timetable'`. Rows written
before that existed have neither. This CLI fills them in.

The values are **approximations, not observations**. Old rows carry no direction and
no stop sequence number, so the match is made on line + stop name + time + delay
across every direction the line runs, keeping the best-fitting one. Every row it
touches is stamped `times_source='derived_timetable_backfill'`, which the Observatori
drilldown reports differently from a live derivation and from a real upstream time.

The pending backlog is mostly retired-provider data (Catalonia-wide agencies whose
trackers were deleted). Those lines have no timetable in this repo, so they are
counted as skipped rather than silently attempted. Back up first; it is a dry run
unless `--apply` is passed.

```bash
node scripts/backfill_delay_times.js                    # report only
node scripts/backfill_delay_times.js --limit 500        # sample a subset
node scripts/backfill_delay_times.js --apply            # write
```

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

## Documentation checks and credentials

Run `node scripts/docs_check.js` for relative links and npm script references in the
current guides. Historical ARCHITECTURE prose is not a current contract. No CI or
browser framework is introduced.

Credential values were removed from the agent guide and historical architecture.
This does not erase git history or remaining legacy source defaults. Review historical
exposure separately with the operator. No credentials were rotated, accounts changed,
history rewritten or production data replaced.
