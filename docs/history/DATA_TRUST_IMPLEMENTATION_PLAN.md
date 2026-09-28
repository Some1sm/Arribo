> Historical document — this plan was completed in September 2026. See README.md, AGENTS.md, OPERATIONS.md for the current system.

# Arribo! — Data-Trust Implementation Plan (agent prompt)

> **You are an implementation agent working on the Arribo! repository.** This file is
> your complete brief. It was written after a full audit of the live site
> (`http://87.106.33.66:3000`), the upstream Avanza SIRI feed, the maresme.net
> timetables and the ATM GTFS feed. Every task below is backed by measured evidence
> (see §2). Work through the phases **in order**, tick each checkbox in this file as
> you finish it (`- [ ]` → `- [x]`), and never skip validation.
>
> If anything in this file disagrees with the source code, **the source code wins** —
> stop, re-read the code, and adapt the step. Line numbers are approximate (they
> drift as you edit); always search for the quoted identifier instead of trusting a
> number.

---

## Table of contents

1. [Ground rules (read before touching anything)](#1-ground-rules-read-before-touching-anything)
2. [Evidence: why each change exists](#2-evidence-why-each-change-exists)
3. [Phase 0 — Setup and baseline](#phase-0--setup-and-baseline)
4. [Phase 1 — Make the test suite deterministic](#phase-1--make-the-test-suite-deterministic)
5. [Phase 2 — Upstream SIRI honesty (errors must not look like "no buses")](#phase-2--upstream-siri-honesty)
6. [Phase 3 — Per-trip timetables (replace the median-offset model)](#phase-3--per-trip-timetables)
7. [Phase 4 — Calendar: holidays and seasons](#phase-4--calendar-holidays-and-seasons)
8. [Phase 5 — Service disruptions (cancelled stops)](#phase-5--service-disruptions-cancelled-stops)
9. [Phase 6 — Observatori methodology (fit to send to the Ajuntament)](#phase-6--observatori-methodology)
10. [Phase 7 — Planner and walking](#phase-7--planner-and-walking)
11. [Phase 8 — Robustness and hygiene](#phase-8--robustness-and-hygiene)
12. [Phase 9 — Upgrades](#phase-9--upgrades)
13. [Final delivery report](#final-delivery-report)
14. [Appendix A — Audit scripts to create](#appendix-a--audit-scripts-to-create)
15. [Appendix B — Real operator notices (test fixtures)](#appendix-b--real-operator-notices-test-fixtures)

---

## 1. Ground rules (read before touching anything)

### 1.1 Read these files first, fully

- [ ] `CLAUDE.md` (repo root) — commands, architecture, configuration.
- [ ] `AGENTS.md` — **binding** invariants. Section 3 ("Invariants") is the most
      important part of the repository. Every change you make must keep every
      invariant in that section true. If a task here seems to conflict with an
      invariant, STOP and ask the user.
- [ ] `UI_GUIDE.md` — before any frontend change.
- [ ] `OPERATIONS.md` — before any change to health/readiness, backup, or deployment.

### 1.2 Hard rules

1. **The HTTP process (`server.js`) must never open SQLite.** Everything historical
   goes through `workerBridge.historyQuery(op, args)` → worker → `src/historyDb.js`.
   Never `require('./src/historyDb')` from `server.js` or from anything `server.js`
   loads in the main process.
2. **Europe/Madrid time only.** Use `src/core/time/calendarEngine.js`,
   `src/core/time/timeEngine.js`, `src/timeUtils.js`. Never `getHours()`, `getDay()`,
   `getDate()` on a host-local `Date`.
3. **Coordinates:** internal/Leaflet `[lat, lon]`; GeoJSON/ORS `[lon, lat]`. Never
   use `||` fallbacks on a coordinate (a real `0` would be discarded).
4. **Unknown is not zero.** A missing delay, speed, offset or time is `null`, never `0`.
   A timetable-only time must never be labelled real-time.
5. **Never log** coordinates, planner queries, API keys, SIRI account keys, or full
   upstream request bodies. Error messages must not contain the SIRI key.
6. **Frontend shell assets:** any change to `public/css/*.css` or `public/js/*.js`
   requires, in the same change: bump the `?v=` query on that asset in **all three**
   HTML files (`public/index.html`, `public/plan.html`, `public/dades.html`), bump
   `VERSION` **and** `CACHE_NAME` in `public/sw.js`. Search for the current values
   with `grep -n "VERSION\|CACHE_NAME" public/sw.js` and `grep -n "?v=" public/*.html`.
7. **No new npm dependencies** without asking the user first. Production deps are
   exactly `express`, `cors`, `compression`.
8. **No stubs, no `// TODO`, no placeholder data.** If you cannot finish a task
   properly, leave its checkbox unticked and write the blocker in the delivery report.
9. **Never invent facts** (holiday dates, operator rules, stop ids). If a task needs a
   fact you cannot verify from the repo or an official source, ask the user.
10. **Git:** do not commit, push, deploy, or touch the production server unless the
    user explicitly asks. If the user has told you to commit, make **one commit per
    phase**, message format `fix(<area>): <what>` or `feat(<area>): <what>`, ending
    with the attribution lines the session tells you to use.
11. **Never point a test or script at the live data directory** (`./data`) for writes.
    Use a copy in a temp folder.
12. **When a test fails:** compare against `HEAD` first (`git stash`, re-run, `git stash pop`).
    Prefer fixing a fixture over relaxing an assertion. Never delete an assertion to
    make a suite pass. If you change an expected value, the new value must be
    justified by a published source (see §3.8 on how to verify a published time),
    and you must add a comment citing it.

### 1.3 Environment (Windows machine)

Node is installed under `G:\Programas\nodejs`. In the Git Bash tool, if `npm` is not
found, prefix commands with a process-local PATH:

```bash
export PATH="/g/Programas/nodejs:$PATH"
npm run test:syntax
```

or run npm directly: `node /g/Programas/nodejs/node_modules/npm/bin/npm-cli.js test`.
Node must be ≥ 22.5 (`node -v`; the machine has 22.19.0).

### 1.4 The validation gate (run at the end of EVERY phase)

```bash
npm run test:syntax
npm run lint
npm test
node scripts/docs_check.js
```

- `test:syntax` must exit 0 (hard gate).
- `lint` must exit 0 (warnings for `no-unused-vars` are allowed; errors are not).
- `npm test` must print `RESULT: N passed, 0 failed`.
- `docs_check` must exit 0.

A phase is **not done** while any of these is red. Paste the final `RESULT:` line of
`npm test` into the phase's "Validation log" checkbox line.

### 1.5 How to work each task

For every task:

1. Read the code around the identifiers named in the task (at least 60 lines of context).
2. Write or update the **test first** where the task says so. Run it, see it fail
   for the right reason.
3. Implement.
4. Run the single suite: `node test/<suite>.js`. For suites that touch storage, set
   isolation: `DATA_DIR=./tmp/db DB_PATH=./tmp/db/history.db REPORTS_DIR=./tmp/db/reports node test/<suite>.js`.
5. Tick the checkbox.

New test files placed in `test/` are auto-discovered by `test/run.js`; you do not
need to register them.

---

## 2. Evidence: why each change exists

Measured on 2026-09-27. Keep this section as reference; do not edit it.

| # | Finding | Evidence |
|---|---|---|
| E1 | Timetable stop times come from ONE median offset profile per direction/day; per-trip published times are discarded. | Against all 45,894 published maresme.net stop-times: 39.3% off by ≥1 min, 14.6% by ≥2 min, 3,109 cells by ≥3 min, max +11 min. Big errors are mostly **positive** (app says later than published → rider misses bus). Worst: winter L1 dir 11 weekday, early/late trips. Example: trip 05:25 from Rodalies is published at **05:45 at Euskadi**, app says **05:54**. ATM GTFS independently shows L1 Rodalies→Hospital run times of 23 min (05:33) to 37 min (18:27). |
| E2 | Trips that start mid-route are dropped; trips that end early are shown at stops they never reach. | In the published grids: 4 trips start after the origin (e.g. winter L3 dir 11 weekday trip index 0 starts at stop index 6), 5 trips end early (e.g. winter L7 dir 11 Saturday trip index 37 ends at stop index 2 of 4). The scraper only keeps trips with a time at the origin column and applies a full-route profile to every trip. |
| E3 | The scraper's `--diff` audit compares against the legacy `mataro_schedules.json`, not the `mataro_schedules.seasons.json` the app loads. | `scripts/scrape_maresme_timetables.js`, `diffAgainstCurrent(current, …)`. No drift existed on 2026-09-27, but nothing would detect it. |
| E4 | SIRI errors are recorded as success. | `callSoap` never checks HTTP status, `<Status>`, `<ErrorCondition>` or SOAP faults. With a wrong key, GetStopMonitoring returns HTTP 200 + `<ErrorCondition><Description>Invalid user/password</Description></ErrorCondition>` and `ResponseTimestamp` `0001-01-01T00:00:00`; the client parses 0 arrivals and calls `recordSuccess`. GetVehicleMonitoring with a wrong key is byte-identical to an empty network (`<Status>false</Status>`, no activities). |
| E5 | Timetable-only SIRI arrivals are labelled real-time and "Puntual". | `getStopArrivals`: `expectedArr = Expected || Aimed`, `delayStr = … || 'PT0M'`, `isRealTime: true` hard-coded, even when `freshness.source === 'timetable'`. |
| E6 | Observatori rates count 20-second poll **samples**, labelled as "arrivals"/"trips". | Every rate is `COUNT(*)` over `delay_logs`. Production 7-day summary: `totalTripsAnalyzed: 169595` = raw samples. A stop visit has median 5 samples, p90 10, max 42. |
| E7 | Early running counts as on time. | `onTimePct` uses `delay_mins <= 3`. Production 36 h: network 82.9% (samples, current definition) vs **74.7%** (one count per stop visit, on time = −1…+3). L5 85%→72%, L6 93%→80% (≈13% of their visits run early). "Champion line" L7 has average delay −0.4. |
| E8 | `−15` is a sentinel, not a measurement. | 20 production rows at exactly −15, **zero** rows between −14 and −10. |
| E9 | Late trips are cut off from statistics. | Hard-coded depot hours 23:00–05:20 in `ingestionDaemon.js` (`isDepotHours`). |
| E10 | CSV export truncates silently. | `LIMIT 50000` in `historyDb.js` export query; asking for 168 h returned 36 h, no warning. CSV also lacks `vehicle_id`, `direction`, `times_source`. |
| E11 | Observatori "scheduled/actual time" is derived from the biased model of E1. | 99% of `delay_logs` rows have `times_source = 'derived_timetable'` (via `tripMatcher` → `getDeparturesForStop`). |
| E12 | The delay value itself is the operator's own `<Delay>`; there is no independent measurement. | `ingestionDaemon.pollMataroVehicles` logs `b.delayMins` from SIRI. |
| E13 | Cancelled-stop parsing is brittle, direction-blind and ignored by the planner. | `mataroTracker.getCancelledStopsForLine`: 10 hard-coded name→id pairs; ignores `ADREÇA …`; `hospital` cancels both 1001 and 1073; provisional stops ignored; nothing in `src/core/schedule/` reads cancellations. |
| E14 | Holidays incomplete/wrong. | `src/core/time/holidayCalendar.js`: 8 December (Immaculada) missing; 6 December labelled "Sant Nicolau" (it is Dia de la Constitució); no Mataró local holidays. |
| E15 | Only summer 2026 is configured. | `SUMMER_WINDOWS` in `src/data/seasonCalendar.js` has one entry (2026-07-27…2026-08-23). |
| E16 | 3 suites fail on a clean HEAD outside service hours. | `stop_passed_estimation_test.js`, `fleet_status_accounting_test.js`, `fleet_direction_balance_test.js` fail their CONTROL step at Sunday 22:50 Madrid; they build fixtures from `Date.now()`. |
| E17 | Production walking is straight-line. | Production planner returns `"source":"approximate"` for walks: ORS is not configured. |
| E18 | XML parsing by regex is prefix-unsafe. | `extractTag(xml, 'Delay')` regex `<Delay[^>]*>` also matches `<DelayXyz …>`; namespace prefixes (`<siri:Delay>`) are not matched. |

---

## Phase 0 — Setup and baseline

- [x] 0.1 Run `git status`. The tree must be clean (this plan file may be the only
      untracked file). Clean.
- [x] 0.2 Record the current branch (`git branch --show-current`). Current branch is `newUI`.
- [x] 0.3 Run the validation gate (§1.4). Baseline output: `RESULT: 59 passed, 3 failed (exclusions listed above)`
- [x] 0.4 Save the list of failing suites here: `stop_passed_estimation_test.js`, `fleet_status_accounting_test.js`, `fleet_direction_balance_test.js`
- [x] 0.5 Create a scratch folder outside the repo for temporary data: `C:\Users\ceper\AppData\Local\Temp\arribo_scratch`.

---

## Phase 1 — Make the test suite deterministic

**Goal:** the whole suite passes at any time of day, any day of week. Every later
phase depends on a trustworthy green gate.

### 1.1 Create a fixed-clock helper

- [x] Create `test/helpers/fixed_clock.cjs` with exactly this behaviour: it shifts the
      clock by a constant offset so time still flows (timers and "age" arithmetic keep
      working), while `Date.now()` and `new Date()` report the pinned instant.

```js
'use strict';
// Pins "now" for a test process while letting time keep flowing, so code that
// measures ages (now - observedAt) still behaves. Only affects THIS process;
// a forked worker keeps the real clock.
const RealDate = Date;

function install(isoInstant) {
  const fixed = RealDate.parse(isoInstant);
  if (!Number.isFinite(fixed)) throw new Error(`fixed_clock: invalid instant ${isoInstant}`);
  const offset = fixed - RealDate.now();
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() { return RealDate.now() + offset; }
  }
  FixedDate.parse = RealDate.parse;
  FixedDate.UTC = RealDate.UTC;
  globalThis.Date = FixedDate;
  return function uninstall() { globalThis.Date = RealDate; };
}

module.exports = { install };
```

- [x] Add `test/fixed_clock_test.js` that checks: `Date.now()` is within 2 s of the
      pinned instant right after install; `new Date()` equals it within 2 s;
      `new Date(0).getTime() === 0`; `Date.UTC(2026,0,1)` is unchanged; after
      `uninstall()` `Date.now()` is within 2 s of real time; `new Date() instanceof Date`
      is true while installed.

### 1.2 Pin the three failing suites

For each of `test/stop_passed_estimation_test.js`, `test/fleet_status_accounting_test.js`,
`test/fleet_direction_balance_test.js`:

- [x] Read the whole file. Find every `Date.now()` / `new Date()` used to build a
      fixture (vehicle `timestamp`, `observedAt`, `lastSeen`, cache `ts`).
- [x] At the **very top of the file, before any other `require`**, add:
      ```js
      // Fixtures below are built from Date.now(); pin it inside weekday service
      // hours so the suite does not depend on when it is run.
      require('./helpers/fixed_clock.cjs').install('2026-09-23T08:00:00Z'); // Wed 10:00 Madrid
      ```
      (`fleet_direction_balance_test.js` already uses explicit instants in some tests
      — `2026-09-24`, `2026-09-12` — keep those; the pin only affects the tests that use
      `Date.now()`.)
- [x] Run each suite at the current real time. It must pass.
- [x] Search the rest of `test/` for other fixtures built from `Date.now()` that depend
      on service hours. Files changed: `test/stop_passed_estimation_test.js`, `test/fleet_status_accounting_test.js`, `test/fleet_direction_balance_test.js`.
- [x] Run the full gate at least twice, once with the machine clock as is. Record:
      `RESULT: 63 passed, 0 failed (exclusions listed above)`

### 1.3 Phase 1 done

- [x] Validation log: `RESULT: 63 passed, 0 failed (exclusions listed above)`

---

## Phase 2 — Upstream SIRI honesty

**Goal:** an upstream error, bad credentials, or a timetable-only answer can never be
shown or recorded as live data. Files: `src/mataroSiriClient.js`,
`src/workers/ingestionWorker.js`, `src/ingestionDaemon.js`, `src/core/WorkerBridge.js`,
`server.js` (`/api/ready`, `/api/diagnostics/upstream`, `/api/health`),
`src/mataroTracker.js` (stop board merge), frontend banner.

### 2.1 Tests first — `test/siri_error_detection_test.js`

Write a new suite that installs a fake transport with `siriClient.setHttpBackend(fn)`
(it must resolve `{ status, bodyText }`) and asserts each case below. Use these
exact XML bodies (copied from the real upstream):

**Auth failure (stop monitoring):**
```xml
<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body><GetStopMonitoringResponse xmlns="http://tempuri.org/"><GetStopMonitoringResult><ServiceDeliveryInfo xmlns=""><ResponseTimestamp xmlns="http://www.siri.org.uk/siri">0001-01-01T00:00:00</ResponseTimestamp></ServiceDeliveryInfo><Answer xmlns=""><StopMonitoringDelivery xmlns="http://www.siri.org.uk/siri"><ResponseTimestamp>0001-01-01T00:00:00</ResponseTimestamp><ErrorCondition><Description>Invalid user/password</Description></ErrorCondition></StopMonitoringDelivery></Answer></GetStopMonitoringResult></GetStopMonitoringResponse></soap:Body></soap:Envelope>
```

**Healthy but empty stop (valid key, no buses):**
```xml
<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body><GetStopMonitoringResponse xmlns="http://tempuri.org/"><GetStopMonitoringResult><ServiceDeliveryInfo xmlns=""><ResponseTimestamp xmlns="http://www.siri.org.uk/siri">2026-09-27T22:46:55.2018494+02:00</ResponseTimestamp></ServiceDeliveryInfo><Answer xmlns=""><StopMonitoringDelivery xmlns="http://www.siri.org.uk/siri"><ResponseTimestamp>2026-09-27T22:46:55.2018494+02:00</ResponseTimestamp><Status>true</Status><ValidUntil>2026-09-27T22:47:55.2018494+02:00</ValidUntil><MonitoringRef>1001</MonitoringRef></StopMonitoringDelivery></Answer></GetStopMonitoringResult></GetStopMonitoringResponse></soap:Body></soap:Envelope>
```

**Vehicle monitoring, empty (ambiguous: no buses OR bad key):**
```xml
<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body><GetVehicleMonitoringResponse xmlns="http://tempuri.org/"><GetVehicleMonitoringResult><ServiceDeliveryInfo xmlns=""><ResponseTimestamp xmlns="http://www.siri.org.uk/siri">2026-09-27T22:46:43.076938+02:00</ResponseTimestamp></ServiceDeliveryInfo><Answer xmlns=""><VehicleMonitoringDelivery xmlns="http://www.siri.org.uk/siri"><ResponseTimestamp>2026-09-27T22:46:43.076938+02:00</ResponseTimestamp><Status>false</Status><ValidUntil>2026-09-27T22:47:43.076938+02:00</ValidUntil></VehicleMonitoringDelivery></Answer></GetVehicleMonitoringResult></GetVehicleMonitoringResponse></soap:Body></soap:Envelope>
```

Also build: a SOAP fault body (`<soap:Fault><faultcode>soap:Server</faultcode><faultstring>boom</faultstring></soap:Fault>` inside `soap:Body`), an HTML error page with status 502, and an empty string with status 200.

Assertions:

- [x] Auth failure → `getStopArrivals` does **not** call `recordSuccess`; `consecutiveFailures` increments; `getUpstreamStatus().lastError` equals `'auth'` (new field, see 2.2); the returned array is the stale fallback if one exists, else `[]`.
- [x] Healthy empty stop → `recordSuccess('arrivals')` happens; `[]` returned; `lastError` is `null`.
- [x] Vehicle `Status false` with no activities → returns `[]`, counts as a success
      for transport purposes, but sets `getUpstreamStatus().vehicleDeliveryStatus === false`.
- [x] SOAP fault → failure, `lastError === 'soap_fault'`.
- [x] HTTP 502 HTML → failure, `lastError === 'http_502'`. (Note: when using
      `setHttpBackend`, the backend returns `status`; the direct `https` path must
      also check `res.statusCode`.)
- [x] Empty body with 200 → failure, `lastError === 'malformed'`.
- [x] No error message or `lastError` string contains the account key (assert that
      `'Mataro*WS'` does not appear in any logged or returned string — capture
      `console.warn`/`console.error` during the test).

### 2.2 Implement error detection in `src/mataroSiriClient.js`

- [x] In the direct `https.request` path of `callSoap`, resolve an object
      `{ status: res.statusCode, bodyText: data }` instead of the bare string, and make
      the backend path return the same shape (`r.status`, `r.bodyText`). Update both
      callers (`getLiveVehicles`, `getStopArrivals`) to use `.bodyText`.
- [x] Add a method `classifyDelivery(status, xml, deliveryTag)` returning
      `{ ok: boolean, error: null|'http_<code>'|'soap_fault'|'auth'|'upstream_error'|'malformed', statusFlag: true|false|null }`:
      1. `status !== 200` → `http_<status>`.
      2. body empty or does not contain `deliveryTag` (`VehicleMonitoringDelivery` /
         `StopMonitoringDelivery`) and contains no `Fault` → `malformed`.
      3. contains `<soap:Fault` or `<Fault` → `soap_fault`.
      4. contains `ErrorCondition`: read its `Description`; if it matches
         `/invalid user|password|unauthori[sz]ed|credential/i` → `auth`, else
         `upstream_error`.
      5. a `ResponseTimestamp` starting with `0001-01-01` → `upstream_error`.
      6. otherwise ok; `statusFlag` = the `<Status>` text (`true`/`false`) or `null`.
- [x] In both fetch functions, after `callSoap`, call `classifyDelivery`. If `!ok`,
      `throw new Error(\`SIRI \${error}\`)` so the existing `catch` block runs
      `recordFailure` and serves the stale fallback. Store the classification in
      `this.lastError` (and reset it to `null` on success). Store
      `this.vehicleDeliveryStatus = statusFlag` for vehicle monitoring.
- [x] Add `lastError` and `vehicleDeliveryStatus` to `getUpstreamStatus()`.
- [x] Check the worker side: open `src/workers/ingestionWorker.js` and find how
      `getMataroLiveVehicles` / `getMataroStopArrivals` RPCs are answered. Make sure an
      error thrown by the client reaches the main process as a rejected RPC (so the main
      process runs `recordFailure`), not as an empty array. If the worker's copy of the
      client catches and returns `[]`, the worker must also forward `lastError` in the
      heartbeat/status payload so the main process can report it. Read
      `src/core/WorkerBridge.js` to see what the heartbeat carries.

### 2.3 Fix timetable-only arrivals labelled live (E5)

In `getStopArrivals` (direct SOAP path):

- [x] `const hasExpected = Boolean(this.extractTag(itemXml, 'ExpectedArrivalTime'));`
- [x] `isRealTime: hasExpected` (not `true`).
- [x] Delay: if `hasExpected && aimed` → `Math.round((expected - aimed)/60000)`; else
      if a `<Delay>` tag is present → parse it; else `delayMins = null`.
- [x] When `delayMins === null`: `delayBadgeText: 'Horari previst'`,
      `delayStatus: 'scheduled'`. Never `'Puntual'` for an unknown delay.
- [x] Remove the `|| 'PT0M'` default.
- [x] Now find every consumer of these fields in `src/mataroTracker.js`
      (`getStopDepartures`, around the `liveArrivals` merge — search `siriClient.getStopArrivals`
      and the dedupe logic that checks `dep.isRealTime` / `existing.isEstimated`) and make
      sure a `null` `delayMins` does not become `0` anywhere (`|| 0`, `Number(x || 0)`).
      Replace such fallbacks with explicit `Number.isFinite(x) ? x : null`.
      **Keep the AGENTS.md invariant "A live bus may hide its own trip on the board,
      never a neighbour's"** — a timetable-only SIRI entry must not delete a published
      departure. Run `node test/stop_departures_dedup_test.js` after the change.
- [x] Add tests to `test/siri_error_detection_test.js`: a `MonitoredStopVisit` with only
      `AimedArrivalTime` → `isRealTime === false`, `delayMins === null`, badge
      `'Horari previst'`; one with both Aimed and Expected 3 min apart →
      `isRealTime === true`, `delayMins === 3`.

### 2.4 Auth canary and "no buses during service" anomaly

- [x] In `src/ingestionDaemon.js`, add a canary poll every 5 minutes (use the same
      timer style as the existing polls; clear it on shutdown): call the client's
      **direct** stop-monitoring fetch for stop `1016` (Rodalies, served by several
      lines) bypassing the cache (add an option `{ bypassCache: true }` to
      `getStopArrivals` if needed). Record `{ ok, error, checkedAt }` as
      `this.upstreamCanary`. Emit it to the main process over IPC with the existing
      status/heartbeat mechanism (read how `noticesUpdatedAt` reaches `/api/ready` and
      follow the same path).
- [x] Compute "scheduled buses now": sum over L1–L8 of
      `mataroSchedules.getScheduledFleetRequirement(lineId, dayType, nowSec)` (read its
      signature first; `dayType` must come from the holiday-aware day-type resolver that
      `mataroTracker` already uses — search `resolveDayType`). If scheduled ≥ 3 and the
      live identified fleet has been 0 for ≥ 5 consecutive minutes, set
      `fleetAnomaly = 'no_vehicles_during_service'`, else `null`.
- [x] `/api/ready` in `server.js`: status `degraded` (still HTTP 200) when the canary's
      last result is not ok (and is < 15 min old) or `fleetAnomaly` is set. Add fields
      `upstream: { canaryOk, canaryError, canaryCheckedAt }` and `fleet.anomaly`.
      **Readiness must not query providers or SQLite** — only read the cached values.
- [x] `/api/diagnostics/upstream`: add `lastError`, `vehicleDeliveryStatus`, canary block.
- [x] Frontend (`public/js/app.js`): when the fleet payload or a status endpoint
      reports the anomaly or a failed canary, show a non-blocking banner in Catalan:
      *"Les dades en temps real de l'operador no estan disponibles ara mateix. Es mostren
      horaris previstos."* Use the existing banner/notice component style from
      `UI_GUIDE.md` (search `app.js` for how disruption banners are rendered and reuse it).
      Follow rule 1.2.6 (asset versions).
- [x] Tests: extend `test/health_freshness_test.js` or create
      `test/upstream_canary_test.js` — canary failing → `/api/ready` returns 200 with
      `status: 'degraded'`; canary ok and fleet non-empty → `ready`; empty fleet at a
      pinned time with no scheduled buses (e.g. 03:00 Madrid) → not an anomaly.

### 2.5 Phase 2 done

- [x] Validation log: `RESULT: 65 passed, 0 failed (exclusions listed above)`
- [x] Manual check: start the server locally (`npm start`) with a wrong key
      (`MATARO_SIRI_ACCOUNT_KEY=wrong npm start`), wait 6 minutes, `curl
      http://localhost:3000/api/ready` → `degraded` with `canaryError: 'auth'`. Then stop
      it. Do not print the key anywhere in your report.

---

## Phase 3 — Per-trip timetables

**Goal:** every displayed or planned timetable time equals the time published by
maresme.net for **that trip at that stop**. The median profile survives only for
position interpolation where no trip is known.

Files: `scripts/scrape_maresme_timetables.js`, `src/data/mataro_schedules.seasons.json`
(regenerated), `src/data/mataroSchedules.js`, `src/mataroTracker.js`,
`src/core/schedule/journeyTimeline.js`, `src/core/schedule/tripMatcher.js`,
`src/core/schedule/scheduleSynthesizer.js` (check), new tests, new audit script.

### 3.1 Refactor the scraper so it can be required

- [x] In `scripts/scrape_maresme_timetables.js`, wrap the bottom IIFE into
      `async function main() { … }` and run it only when executed directly:
      ```js
      if (require.main === module) {
        main().catch((err) => { console.error('scrape failed:', err.message); process.exit(1); });
      }
      module.exports = {
        fetchPage, parseSlotArrays, parseColumnNames, parseFirstOriginName, resolveBlocks,
        buildSeason, medianOffsetSec, toSec, isTime, pad2, normName, realDirectionKeys,
        SEASONS, DAY_KEYS
      };
      ```
      Behaviour when run from the command line must be unchanged.
- [x] Save offline fixtures for tests (network must never be used in tests):
      `node -e "…fetchPage…"` the pages
      `https://maresme.net/matarobus/hivern/index.php?l=es&id=1`,
      `…hivern…id=3`, `…hivern…id=7`, `…estiu…id=7` and write them to
      `test/fixtures/maresme/hivern_L1.html`, `hivern_L3.html`, `hivern_L7.html`,
      `estiu_L7.html` **as latin1 text exactly as `fetchPage` returns it**
      (`fs.writeFileSync(path, html, 'latin1')`; read back with
      `fs.readFileSync(path, 'latin1')`).

### 3.2 Create the audit script (before changing data)

- [x] Create `scripts/audit_timetable_model.js` from **Appendix A.1**. Run it:
      `node scripts/audit_timetable_model.js`. It fetches maresme.net live. Record the
      summary line. Verified output on 2026-09-27 (before any change):
      `cells 45936 | |err|>=1: 39.3% | |err|>=2: 14.7% | |err|>=3: 3109`, histogram
      including `"missing":42` (the cells of the mid-route trips of E2 that the app
      drops). Also check the cell mode prints
      `published winter L1 d11 weekday trip 05:25 @ Euskadi (1031): 05:45`.
      This is your "before" number. Verified: `cells 45936 | |err|>=1: 39.3% | |err|>=2: 14.7% | |err|>=3: 3109`. Cell mode: `published winter L1 d11 weekday trip 05:25 @ Euskadi (1031): 05:45`.

### 3.3 New data format: per-trip stop times

Extend `buildSeason` so each direction, for each day type, also stores the full trip
matrix. Add this field (keep every existing field — other code still reads them):

```jsonc
"dayTrips": {
  "weekday": [
    // one entry per published trip, in published column order
    { "s": [19500, 19560, 19680, null, …] }   // seconds-of-day per stop index, null = not served
  ],
  "saturday": [ … ],
  "sunday":   [ … ]
}
```

Rules — implement each and cover each with a test in 3.6:

- [x] `s.length === stops.length` for every trip. `s[i]` is the published time at
      `stops[i]` converted with `toSec`, or `null` for `-----`.
- [x] A trip is kept if **any** stop has a time (not only the origin). This fixes the
      4 mid-route starts of E2.
- [x] **Midnight roll-over:** walking along a trip, if a time is smaller than the
      previous non-null time of the same trip, add 86400 to it (and all later times).
      A trip's times must be strictly non-decreasing after this. If they still decrease
      by more than 60 s, the column block is misaligned: make `buildSeason` return
      `{ error }` exactly like the existing monotonicity check.
- [x] Trips are sorted by their first non-null time.
- [x] Keep the existing `schedules[day]` array **unchanged in meaning** (departures at
      the origin), but derive it from `dayTrips` (the trips whose `s[0] !== null`), so
      the two can never disagree. Keep `dayStopTravelSec` (median profile) as is.
- [x] Add `_tripsSource: 'maresme.net per-trip grid'` to each direction.
- [x] Fix `--diff` (E3): compare the freshly scraped grids against
      `mataro_schedules.seasons.json` (the file the app loads), comparing `schedules`,
      `dayStopTravelSec` **and** `dayTrips`. Keep the old legacy comparison behind a
      separate flag `--diff-legacy`.
- [x] Add `--check`: like `--diff` but prints one JSON line
      `{"drift":false,"checkedAt":"…","differences":[]}` and exits 0 when identical,
      exits 2 when different, exits 1 on fetch/parse error. This is used by 3.9.
- [x] Regenerate the data: `node scripts/scrape_maresme_timetables.js`. Then verify
      with a small node one-off that for every line/direction/day the old and new
      `schedules` and `dayStopTravelSec` are identical (no drift existed on 2026-09-27;
      if they differ, maresme.net changed — report it to the user before continuing),
      and `dayTrips` exists everywhere.
- [x] Check the file size (`ls -la src/data/mataro_schedules.seasons.json`). If it grows
      beyond ~5 MB, write `s` arrays on one line each (custom `JSON.stringify` replacer
      or post-processing) — do not change the structure. (Current size: 1.63 MB)

### 3.4 Loader API (`src/data/mataroSchedules.js`)

- [x] Expose `dayTrips` for the resolved day in `getDirectionSchedule(...)` as
      `trips: [{ index, stopSecs: [...] }]` (copy, never the internal array).
- [x] New function `getTripsServingStop(lineId, direction, stopId, dayType, season)` →
      `[{ tripIndex, originSec|null, stopSec, firstStopIndex, lastStopIndex }]` for every
      trip whose `stopSecs[stopIndex] !== null`, sorted by `stopSec`.
- [x] Rewrite `getDeparturesForStop` to use `getTripsServingStop` (format `HH:MM`
      with `% 24` hours as today). **This is the core fix for E1 and E2.** The old
      "origin + offset" arithmetic must not be used for any displayed time any more.
- [x] New `getTripStopTime(lineId, direction, originDep /* 'HH:MM' */, stopId, dayType, season)`
      → seconds-of-day or `null` (trip lookup by origin departure; `null` if the trip
      does not serve the stop).
- [x] Keep `getStopTravelTime` (median profile) but add a JSDoc line:
      *"Median profile across all trips. For position interpolation only; never use it
      to display or plan a time — use getTripStopTime / getTripsServingStop."*
- [x] Export the new functions in `module.exports` (around the bottom of the file).
- [x] Respect the season invariant in AGENTS.md: the season is applied **at the module
      boundary**; do not add a season parameter to callers.

### 3.5 Update every call site

For each call site below, read 40 lines of context and classify it:
**(D) displayed/planned time** → must use per-trip data; **(P) position/progress
interpolation** → median profile acceptable, but prefer the specific trip when the
trip is known.

- [x] `src/mataroTracker.js` — search `getStopTravelTime(`: four call sites (currently
      near lines 2891, 3094, 3208, 3441). All four build board times → (D). Replace the
      "origin departure + stopTravelSec" arithmetic with `getTripsServingStop` /
      `getTripStopTime`. Keep delay arithmetic identical otherwise.
- [x] `src/mataroTracker.js` — search `getDirectionSchedule(`: (near 673, 1848, 2025, 2495,
      2785, 2911, 3205, 3277, 3440). For each, note whether it uses `stopTravelSecMap`,
      `totalTravelSec` or `departures`. `totalTravelSec` used to place ghost buses along
      the route → (P): replace with the trip's own duration
      (`last non-null − first non-null` of that trip) when the trip is known.
- [x] `src/core/schedule/journeyTimeline.js` — search `stopTravelSecMap` (near lines
      92–134). The planner computes boarding and alighting instants as origin instant +
      offset → (D). Use the trip's own `stopSecs[fromIndex]` and `stopSecs[toIndex]`.
      A trip with `null` at the boarding or alighting stop must not be offered for that leg.
      Keep the existing date/midnight handling (`originInstants`) and the AGENTS invariant
      "Never fall back to missed departures".
- [x] `src/core/schedule/tripMatcher.js` — search `getDeparturesForStop` (near 172).
      It now automatically uses per-trip times; re-run `node test/trip_matcher_test.js`
      and fix fixtures only if a new value equals the published cell (see 3.8).
- [x] `src/core/schedule/scheduleSynthesizer.js` and `src/core/schedule/transitRouter.js`
      — search both for `stopTravelSecMap`, `getStopTravelTime`, `totalTravelSec`,
      `departures`. Classify and update the same way.
- [x] `server.js` — search for `mataroSchedules.` usages and classify.
- [x] Run `grep -rn "stopTravelSecMap\|getStopTravelTime\|totalTravelSec" src server.js`
      at the end and justify, in a code comment next to each remaining use, why the median
      profile is acceptable there (must be (P) only).

### 3.6 Tests — `test/timetable_per_trip_test.js` (offline)

- [x] **Golden published cells** (winter, L1, direction key `11` = Rodalies→Hospital,
      weekday, trip leaving Rodalies (stop `1016`) at 05:25). Force the winter season the
      same way `test/season_provenance_test.js` does (read it first). Assert via
      `getDeparturesForStop` / `getTripStopTime`:
      - Edif. Vidre - TecnoCampus (`1021`) → `05:31`
      - Institut Català Salut (`1022`) → `05:34`
      - Euskadi (`1031`) → `05:45`
      - Parc La Llàntia (`1033`) → `05:47`
      (The old model produced 05:34, 05:38, 05:54, 05:56. The test must fail on the old
      code — check that by running it before 3.4.)
- [x] **Mid-route start (E2):** winter L3 direction `11` weekday: the published trip at
      column index 0 has no time at stops 0–5 and starts at stop index 6. Assert that
      trip appears on the board of the stop at index 6 and does **not** appear at the
      stop at index 0. Get the stop ids from the data file, not by hand.
- [x] **Early end (E2):** winter L7 direction `11` Saturday: the trip at column index 37
      ends at stop index 2 (of 4). Assert it appears at stop index 2's board and not at
      stop indexes 3 or 4.
- [x] **Parser fixtures:** using `test/fixtures/maresme/*.html` and the exported
      `buildSeason`, assert: `dayTrips` exists for all day types; every trip's `s`
      is non-decreasing; the midnight roll-over rule works (construct a tiny synthetic
      input with `23:58` → `00:03` and assert `00:03` becomes `86580`).
- [x] **Consistency:** for every line/direction/day in the shipped file,
      `schedules[day]` equals the origin times of `dayTrips[day]` trips that serve the
      origin (as `HH:MM`).
- [x] **Exactness:** for every line/direction/day/trip/stop in the shipped file with a
      non-null `s[i]`, `getDeparturesForStop` for that stop contains `HH:MM` of `s[i] % 86400`.

### 3.7 Re-run the audit

- [x] Update `scripts/audit_timetable_model.js` to evaluate the **loader output**
      (`getDeparturesForStop`) instead of the median model (Appendix A.1 explains where).
      Run it. Target: `|err|>=1: 0.0%`. Record the "after" line. Verified output:
      `cells 45936 | |err|>=1: 0.0% | |err|>=2: 0.0% | |err|>=3: 0`.

### 3.8 How to justify a changed test expectation

Existing tests (e.g. `test/mataro_timetable_accuracy_test.js` "2.4 intermediate stop
passing times", `test/avanza_full_network_timetable_test.js`,
`test/journey_ranking_test.js`, `test/planner_walking_http_test.js`) may assert
values computed with the median model. When one fails:

1. Run `node scripts/audit_timetable_model.js --cell <season> <line> <dirKey> <day> <HH:MM origin> <stopId>`
   (implemented in Appendix A.1) to print the **published** time for that cell.
2. If the new code's value equals the published value: update the expectation and add
   a comment `// published maresme.net <season> L<n> d<dir> <day> trip <HH:MM>: <value>`.
3. If it does not: the new code is wrong. Fix the code, not the test.
4. Never change an expectation without doing step 1.

### 3.9 Drift monitoring

- [x] In the ingestion worker, run the equivalent of `--check` once per day at 04:1x
      Europe/Madrid (use `calendarEngine`/`timeEngine` for the local time; do not use
      host-local hours). Implement it by requiring the refactored scraper module inside
      the **worker** (never the main process), comparing against the loaded seasons file,
      and emitting `{ drift, checkedAt, differencesCount }` over IPC. **Report only —
      never write the data file automatically.**
- [x] `/api/health` → `schedule.drift: { drift, checkedAt, differencesCount }`
      (`null` until the first check).
- [x] Document in `OPERATIONS.md`: what drift means and the manual refresh procedure
      (`node scripts/scrape_maresme_timetables.js --diff`, review, then run without flags,
      then run the tests, then deploy). Keep `node scripts/docs_check.js` green.

### 3.10 Phase 3 done

- [x] Audit before: `cells 45936 | |err|>=1: 39.3% | |err|>=2: 14.7% | |err|>=3: 3109` / after: `cells 45936 | |err|>=1: 0.0% | |err|>=2: 0.0% | |err|>=3: 0`
- [x] Validation log: `RESULT: 67 passed, 0 failed (exclusions listed above)`
- [x] Add an AGENTS.md invariant (section 3), in the same style as the others:
      *"A displayed or planned timetable time is the published time of that trip at that
      stop (`dayTrips`). The median profile (`dayStopTravelSec`) is for position
      interpolation only. See `test/timetable_per_trip_test.js`."*

---

## Phase 4 — Calendar: holidays and seasons

### 4.1 Holidays as data

- [x] **Get the facts first.** You need, for 2026 and 2027:
      (a) the official Catalan labour calendar (DOGC "Ordre … per la qual s'estableix el
      calendari oficial de festes laborals a Catalunya per a l'any 2026/2027");
      (b) Mataró's two local holidays for each year (Ajuntament de Mataró);
      (c) which service the operator runs on each of them (normally "Diumenges i Festius",
      but confirm from an operator notice or ask the user), and whether 24 and 31 December
      have special services.
      If you cannot reach these sources, **STOP and ask the user** for the dates. Do not
      guess. Known from the audit: 8 December is missing from the code; 6 December is
      Dia de la Constitució, not "Sant Nicolau". Verified 2026 DOGC Ordre EMT/66/2025,
      2027 DOGC Ordre EMT/52/2026, and Mataró local holidays (25 May 2026 Fira de Mataró,
      27 July 2026 Les Santes).
- [x] Create `src/data/holidays.json`:
      ```jsonc
      {
        "_meta": { "timezone": "Europe/Madrid", "notes": "…" },
        "years": {
          "2026": {
            "regional": [ { "date": "2026-01-01", "name": "Any nou", "source": "DOGC …" } ],
            "local":    [ { "date": "2026-07-27", "name": "…", "source": "Ajuntament de Mataró …" } ],
            "serviceOverrides": [ { "date": "2026-12-24", "dayType": "saturday", "source": "operator notice …" } ]
          }
        }
      }
      ```
      Only put entries you verified. Every entry has a `source`.
- [x] Change `src/core/time/holidayCalendar.js`:
      - If the year exists in `holidays.json` → use exactly its `regional` + `local` dates.
      - Else → the existing computed rules as fallback, **with 8 December added and the
        6 December comment fixed**, and `isHolidayKnown(at)` returns `false` for that year.
      - Export `getServiceOverride(at)` → `dayType|null` from `serviceOverrides`.
- [x] Find the day-type resolver (search `resolveDayType` in `src/`) and apply:
      override → holiday → weekday/saturday/sunday.
- [x] `/api/health` `schedule` block: add `holidaysKnownForYear: true|false`.
- [x] Test `test/holiday_calendar_test.js`: 8 Dec 2026 is a holiday; 6 Dec label; a
      local holiday from the JSON resolves to Sunday service; a year missing from the JSON
      falls back and reports `isHolidayKnown === false`; a time at 00:30 Madrid on a holiday
      is still that date (DST/midnight safe — test 25 Oct 2026 and 29 Mar 2026 edges).

### 4.2 Seasons

- [x] Read `src/data/seasonCalendar.js` fully (`SUMMER_WINDOWS`, `registerWindow`,
      `DATA_KNOWN_FROM`).
- [x] Add `getSeasonOutlook(at)` returning `{ nextSummerConfigured: boolean, warning: string|null }`.
      Warning when `at` is on/after **1 June** of a year that has no configured summer
      window for that year and no notice-learned window: *"Horari d'estiu <year> no
      configurat"*.
- [x] Expose it in `/api/health` → `schedule.seasonOutlook`.
- [x] `OPERATIONS.md`: add a yearly checklist (in June: read the operator's "HORARIS
      ESTIU <year>" notice, add the window to `SUMMER_WINDOWS` with its `source`, run
      `test/season_provenance_test.js`). Keep `docs_check` green.
- [x] Test: pinned 2027-06-15 → warning present; 2026-09-27 → no warning.

### 4.3 Phase 4 done

- [x] Validation log: `RESULT: 68 passed, 0 failed (exclusions listed above)`

---

## Phase 5 — Service disruptions (cancelled stops)

Files: `src/mataroTracker.js` (`getCancelledStopsForLine`, `parseAvisoValidity`, the
call site near `cancelledStopsMap`), `src/core/schedule/transitRouter.js`,
`src/core/schedule/journeyTimeline.js`, `server.js` (`/api/plan`), `public/js/plan.js`.

### 5.1 Tests first — `test/stop_cancellation_notices_test.js`

Use the two real notices in **Appendix B** as fixtures. Pin times with the fixed clock
helper. Assertions:

- [x] Notice "TALL CARRER SANT BENET. 28/09" at 2026-09-28 10:00 Madrid:
      L4 direction towards **Hospital** has Miquel Biada cancelled; L4's other direction
      does **not**; L7 direction towards **Plaça de les Tereses** has Miquel Biada
      cancelled; L7's other direction does not.
- [x] Same notice at 2026-09-28 08:59 and 17:01 Madrid → nothing cancelled (window 9–17 h).
- [x] Provisional stop "Ronda República (L5)" is returned as
      `{ provisional: true, name: 'Ronda República', note: 'L5' }` attached to the notice,
      not as a cancellation.
- [x] Notice "TALL CARRER MONTSERRAT. 29/09" at 2026-09-29 12:00 → Lepant cancelled on
      L2 and L5 **direction Hospital only**.
- [x] A notice naming a stop that does not match any stop of that line/direction → the
      name appears in `unmatchedStops` and a throttled warning is logged (no crash, no
      guessed cancellation).
- [x] "Hospital" as an **address/direction** word must not cancel the Hospital stops.

### 5.2 Implement

- [x] New method `getStopCancellations(lineId, avisos, at)` returning
      `{ cancellations: [{ stopId, dirKey, noticeId, title, from, to }], provisional: [...], unmatchedStops: [...] }`.
      Algorithm:
      1. Keep the existing validity filters (`severity`, `active`, `expiresAt`,
         `parseAvisoValidity` → `isEffectiveNow`). Read `parseAvisoValidity` and confirm
         it parses `"DE 9 A 17 HORES"` and `"DE 9:15 A 14:15 HORES"`; add tests if not.
      2. Normalize the text (the existing NFD + strip accents + remove `·` and `.`).
      3. Split into blocks per `LÍNIA N` (existing regex). Inside a block read
         `ADREÇA <X>` / `DIRECCIÓN <X>` up to end of line; resolve the direction by comparing
         `normName(X)` with the normalized **terminal stop name** and `directionName` of each
         of the line's two directions (use `mataroSchedules.getDirectionSchedule` to read
         them). If exactly one direction matches, scope to it; if none or both, scope to
         both **and** add a note to `unmatchedStops` explaining the ambiguity.
      4. Read `Parada(es) anul·lada(es): A, B i C`. For each name, match against the stop
         names of the resolved direction(s): exact normalized equality first; then one name
         contains the other; then ≥ 60% token overlap. Use the stop list from the
         schedule data (`stops[].name`), **not** hard-coded ids. No match → `unmatchedStops`.
      5. Read `Parada provisional: <name> (<note>)` into `provisional`.
- [x] Rewrite `getCancelledStopsForLine` as a thin wrapper over
      `getStopCancellations` (so existing callers keep working), returning the old
      `Map(stopId → title)` but only for cancellations in the requested direction when
      the caller passes one. Read the call site (search `cancelledStopsMap`) and pass the
      direction there.
- [x] Delete the hard-coded name→id table.

### 5.3 Planner

- [x] In the planner pipeline (`transitRouter` generates candidates, `journeyTimeline`
      makes them absolute): a leg must not board or alight at a stop that is cancelled
      **for that line and direction at the leg's absolute boarding/alighting time**.
      Pass the active notices into the planner from `server.js` `/api/plan` (the main
      process already has disruptions from the worker's `DISRUPTIONS_UPDATE`; find where
      they are cached). Do not make the planner fetch anything.
- [x] If a line in an itinerary has an active notice (any cancellation or provisional
      stop in the itinerary's time window), attach `notices: [{ id, title, url }]` to the
      itinerary.
- [x] `public/js/plan.js`: render the notices under the itinerary (reuse the disruption
      style). Follow rule 1.2.6.
- [x] Test (planner): with the 28/09 notice active at 10:00, a plan from Miquel Biada on
      L4 towards Hospital is not offered boarding at Miquel Biada; at 18:00 it is.

### 5.4 Phase 5 done

- [x] Validation log: `RESULT: 69 passed, 0 failed (exclusions listed above)`

---

## Phase 6 — Observatori methodology

**Goal:** numbers that a transport councillor can check and defend. One count per bus
per stop, early running reported separately, no sentinel values, no silent truncation,
methodology explained on the page.

Files: `src/ingestionDaemon.js`, `src/historyDb.js`, `src/reportCacheService.js`,
`server.js` (analytics routes), `public/js/observatori.js`, `public/dades.html`,
`public/js/app.js` (termòmetre bits), new scripts.

### 6.1 One definition of punctuality

- [x] Create `src/core/punctuality.js`:
      ```js
      'use strict';
      // One definition of punctuality for the whole platform. A bus more than one
      // minute early is NOT on time: a rider arriving at the published time misses it.
      const EARLY_LIMIT_MIN = -1;   // delay < -1  → early
      const LATE_LIMIT_MIN = 3;     // delay > 3   → late
      const SEVERE_LATE_MIN = 5;    // delay >= 5  → severely late
      function classify(delayMins) {
        if (!Number.isFinite(delayMins)) return 'unknown';
        if (delayMins < EARLY_LIMIT_MIN) return 'early';
        if (delayMins > LATE_LIMIT_MIN) return 'late';
        return 'on_time';
      }
      module.exports = { EARLY_LIMIT_MIN, LATE_LIMIT_MIN, SEVERE_LATE_MIN, classify };
      ```
- [x] Every SQL expression computing on-time / late / severe percentages must use these
      constants (interpolate them as bound parameters or build the SQL string from the
      constants once at module load — never duplicate the numbers). Search
      `historyDb.js` for `delay_mins <= 3`, `delay_mins > 3`, `delay_mins >= 5`,
      `is_delayed`. `is_delayed` stays as stored, but queries must stop relying on it.
- [x] Every API that returns an on-time percentage must also return `earlyPct` and
      `latePct`, and the three must sum to 100 (±0.2 for rounding). Test this.

### 6.2 Sentinels and invalid samples

- [x] In `ingestionDaemon.js` (`isPlausibleDelay`) and in `historyDb.recordDelayLog`
      (sanity filter): treat `delay <= -15` as unknown (not stored). Add a comment citing
      E8. In `recordDelayLog` also replace `Number(entry.delayMins || 0)` with an explicit
      check: if `!Number.isFinite(Number(entry.delayMins))` → return without storing.
- [x] Every analytics query: add `AND delay_mins > -15` so existing sentinel rows are
      ignored. Better: add one SQL fragment constant `VALID_DELAY_SQL` and reuse it.
- [x] Test: a `-15` sample is not stored; an existing `-15` row does not change any
      percentage.

### 6.3 Service window instead of hard-coded depot hours (E9)

- [x] Replace `isDepotHours` in `ingestionDaemon.js` with a per-line service window from
      the timetable: from (first departure of the day − 15 min) to (last departure +
      that trip's own duration from `dayTrips` + 20 min), using the holiday-aware day type,
      handling trips after midnight (a window may end after 24:00; the next day's early
      samples before the first departure belong to the previous service day if they are
      inside the previous window). Put the function in `mataroSchedules.js` as
      `getServiceWindow(lineId, dayType, season)` → `{ startSec, endSec }` and cover it with
      a test for L1 weekday and L6 Sunday (afternoon-only).

### 6.4 Stop visits (one row per bus per stop)

- [x] New table in `historyDb.js` (created in the same place as `delay_logs`, with an
      idempotent `CREATE TABLE IF NOT EXISTS` and indexes):
      ```sql
      CREATE TABLE IF NOT EXISTS stop_visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vehicle_id TEXT NOT NULL,
        line_code TEXT NOT NULL,
        direction TEXT DEFAULT '',
        stop_name TEXT NOT NULL,
        first_ts INTEGER NOT NULL,
        last_ts INTEGER NOT NULL,
        delay_mins INTEGER NOT NULL,          -- delay of the LAST sample before the bus moved on
        sample_count INTEGER NOT NULL,
        scheduled_time TEXT DEFAULT '',
        actual_time TEXT DEFAULT '',
        times_source TEXT DEFAULT '',
        is_realtime INTEGER DEFAULT 1,
        measured_delay_mins INTEGER,          -- filled by Phase 9.3; NULL until then
        source TEXT DEFAULT 'live'            -- 'live' | 'backfill'
      );
      CREATE INDEX IF NOT EXISTS idx_visits_time_line ON stop_visits(last_ts, line_code);
      CREATE INDEX IF NOT EXISTS idx_visits_stop ON stop_visits(stop_name, last_ts);
      ```
- [x] Worker-side aggregation in `ingestionDaemon.js`:
      - `this.openVisits = new Map()` keyed by vehicle id; value
        `{ key, lineCode, direction, stopName, firstTs, lastTs, lastDelay, count, scheduledTime, actualTime, timesSource, isRealTime, lastObservedAt }`
        where `key = lineCode|direction|stopName`.
      - For each sample that passes the existing filters (the place where
        `recordDelayLog` is called): if the vehicle has an open visit with the same `key`
        and `sampleTs − lastTs ≤ 5 min` → update it; otherwise flush the old one (if any)
        and open a new one.
      - **Duplicate observations:** if the sample's `observedAt` equals the open visit's
        `lastObservedAt`, do not count it again (same GPS fix polled twice). Also skip
        calling `recordDelayLog` for it. Add `observed_at INTEGER` to `delay_logs`
        (idempotent `ALTER TABLE … ADD COLUMN`, same style as the existing ones) and store it.
      - After each poll, flush visits whose `lastTs` is older than 5 min; on shutdown flush all.
      - Bound the map at 500 entries (flush oldest when exceeded).
      - Flush → new `historyDb.recordStopVisit(visit)`.
      - Keep the per-sample `delay_logs` writes (they feed the forensic drill-down and must
        keep working — see AGENTS invariants about episodes).
- [x] `scripts/backfill_stop_visits.js <path-to-db>`: builds `stop_visits` rows with
      `source = 'backfill'` from existing `delay_logs` using window functions (group
      consecutive samples per `vehicle_id` by `stop_name` changes and 5-min gaps; take the
      last sample's delay). It must refuse to run if the DB file is locked/in use by
      another process (try `BEGIN IMMEDIATE` and exit with a clear message on
      `SQLITE_BUSY`), must be idempotent (skip if backfill rows already exist for the
      range unless `--force`), and must never be exposed over HTTP. Document it in
      `OPERATIONS.md` next to the backup CLI: stop the service or run against a copy.
- [x] Test `test/stop_visits_test.js`: 12 samples of one bus approaching stop A then 5
      approaching stop B → 2 visits, counts 12 and 5, delay = last sample's; a repeated
      `observedAt` does not increase the count; two buses at the same stop → 2 visits;
      a 6-minute gap splits a visit.

### 6.5 Switch every rate to visits

- [x] In `historyDb.js`, list every query that produces a count, average or percentage
      (search `COUNT(`, `AVG(`, `SUM(CASE`). There are about 15. Write the list here
      before changing anything:
      1. `getLineDelayStats` (summary count/avg/percentages)
      2. `getJournalismReport` summaryStmt (network totals and percentages)
      3. `getJournalismReport` delayedStmt (line ranking)
      4. `getJournalismReport` punctualityStmt (best punctuality)
      5. `getJournalismReport` agencyStmt (operator breakdown)
      6. `getJournalismReport` allStopsStmt (network stops and bottleneck ranking)
      7. `getJournalismReport` stopHourlyStmt (hourly stop profile)
      8. `getJournalismReport` hourlyStmt (hourly delay distribution)
      9. `aggregateHourlyStats` (legacy sample rollup)
      10. `aggregateHourlyVisitStats` (new visit rollup)
      11. `exportDelayLogsCsv` (sample count)
      12. `exportStopVisitsCsv` (visit count)
      13. `inspectDelayIncident` (episode grouping)
      14. `_delayDataQuality` (distinct episodes)
      15. `getRecentIncidents` (incident counting)
- [x] For each: compute rates and averages from `stop_visits`; keep the raw sample
      count as a separate field named `sampleCount`. Rename API fields **by adding** new
      ones and keeping old keys as aliases with the corrected (visit-based) value:
      - `totalRecordedArrivals` → value = visits; add `totalStopVisits` and `totalSamples`.
      - `totalTripsAnalyzed` → value = visits; add `totalStopVisits`.
      - `arrivalCount` → visits; add `sampleCount`.
- [x] The hourly rollup (`hourly rollup` table and its incremental `last_id` mechanism,
      search `rollup` in `historyDb.js`): add a parallel visit rollup following the
      **exact** same incremental pattern, with its own progress row. Do not change the
      existing sample rollup (`test/hourly_rollup_incremental_test.js` must keep passing).
- [x] "Champion line" (search `championLine` in `historyDb.js` / `reportCacheService.js`):
      rank by on-time % under the new definition, require ≥ 200 visits in the window,
      and tie-break by lower `earlyPct`. A line with `earlyPct > 10` cannot be champion.
- [x] `test/termometre_scorecard_test.js`, `test/hourly_delays_observatori_test.js`,
      `test/observatori_all_stops_test.js`, `test/delay_incidents_test.js`: update
      fixtures to include visits. Expected numbers change **because the definition
      changed** — state that in a comment next to each updated expectation, and make the
      fixture small enough that you can compute the expected value by hand in the comment.

### 6.6 CSV export (E10)

- [x] Add columns `Vehicle`, `Direcció`, `Origen horari` (`times_source`) to the sample
      CSV.
- [x] Replace the silent cap: page through results (`?page=N`, 50,000 rows per page) and
      set response headers `X-Total-Rows`, `X-Page`, `X-Pages`. Never cut a range silently.
      The worker returns one page per RPC (keep IPC payloads bounded).
- [x] New export `/api/analytics/export/visits.csv?hours=…&page=…` with one row per
      stop visit, including `Retard informat (min)` (operator) and
      `Retard mesurat (min)` (Phase 9.3, empty until then).
- [x] Test: 60,000 generated rows → page 1 has 50,000, page 2 has 10,000, headers correct.

### 6.7 Methodology on the page

- [x] In `public/dades.html` / `public/js/observatori.js`, add a collapsible
      "Metodologia" section (Catalan). Content, adapted in your own words:
      - Source of delays: the operator's real-time feed (SIRI) reports the delay of each
        bus; Arribo! records it every 20 s.
      - Unit: one bus passing one stop = one "pas per parada". Repeated readings of the
        same bus at the same stop are counted once.
      - Definitions: on time −1 to +3 min; early < −1; late > 3; severe ≥ 5.
      - Timetable reference: maresme.net published per-trip timetable, season shown.
      - Known limits: gaps when the operator's feed is down (link to the data-health
        status), buses without GPS are not measured, the delay is as reported by the
        operator (independent measurement: Phase 9.3 when available).
- [x] Show `earlyPct` next to every on-time % in the UI (e.g. "74,7% puntual · 5,5%
      avançat · 19,8% tard"). Use Catalan number formatting (`toLocaleString('ca-ES')`).
- [x] Replace UI labels "trajectes analitzats" / "arribades" with "passos per parada".
- [x] Rule 1.2.6 (asset versions). Run `node scripts/observatori_cdp_layout_check.js`
      if Chrome is available; if not, say so in the report.

### 6.8 Verify on real data

- [x] Create `scripts/audit_observatori_csv.js` from **Appendix A.2**. Run it on a
      production CSV **only if the user allows you to download it**
      (`curl -s "http://87.106.33.66:3000/api/analytics/export/csv?hours=168" -o <scratch>/prod.csv`);
      otherwise run it on a CSV exported from a local run. Compare its "visits /
      strict" figures with what the new API returns for the same window on a local copy of
      the data. They must agree within 0.5 points.

### 6.9 Phase 6 done

- [x] Validation log: `RESULT: 72 passed, 0 failed. docs_check 0 errors, lint 0 errors. observatori_cdp_layout_check 0px shift.`
- [x] Add an AGENTS.md invariant: *"Observatori rates are per stop visit (one bus, one
      stop), use `src/core/punctuality.js`, and report early running separately. Raw
      sample counts are only ever labelled as samples."*


---

## Phase 7 — Planner and walking

- [x] 7.1 ORS: **do not create or paste any API key.** Tell the user in the report that
      production walking is straight-line (`approximate`) because `ORS_BASE_URL` /
      `ORS_API_KEY` are not set, and add to `OPERATIONS.md` how to enable it (a
      self-hosted ORS container or an ORS key, set as environment variables in Compose).
- [x] 7.2 In the planner response, when the chosen boarding stop differs from the
      requested `from` stop (e.g. requested `1016` Rodalies, planner used `1058` Rodalies),
      compute the walk between the two poles with the existing pedestrian router instead
      of reporting `walkingMinutes: 0`; if the distance is < 30 m keep 0. Same for the
      destination. Test with the stop pair `1016` → `1058`.
- [x] 7.3 Planner itineraries must say which timetable basis they use:
      `timesBasis: 'published_trip'` (after Phase 3) and keep `approximate: true` on
      estimated walks. Show nothing new in the UI unless it is already labelled.
- [x] 7.4 Validation log: `RESULT: 73 passed, 0 failed. docs_check 0 errors, lint 0 errors. test/planner_walking_sibling_test.js passed (5/5 checks).`

---

## Phase 8 — Robustness and hygiene

- [x] 8.1 `extractTag` in `src/mataroSiriClient.js` (E18): match exact tag names with an
      optional namespace prefix:
      `new RegExp(\`<(?:[\\w.-]+:)?\${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?\${tag}>\`, 'i')`.
      Also make the `VehicleActivity` / `MonitoredStopVisit` loop regexes accept a prefix.
      Tests: `<DelayReason>x</DelayReason><Delay>PT2M</Delay>` → `'PT2M'`;
      `<siri:Latitude>41.5</siri:Latitude>` → `'41.5'`.
- [x] 8.2 Latitude/longitude parsing: replace `parseFloat(x || '0')` + `if (lat && lon)`
      with explicit `Number.isFinite` checks and a Mataró bounding-box sanity check
      (lat 41.45–41.65, lon 2.30–2.55); out-of-box fixes are dropped and counted in
      `getUpstreamStatus().rejectedFixes`. (Zero coordinates are not valid **for Mataró**;
      keep the coordinate invariant elsewhere.)
- [x] 8.3 Look for other `|| 0` on measurements in `src/` (`grep -rn "|| 0" src/ingestionDaemon.js src/flightRecorder.js src/historyDb.js src/mataroSiriClient.js`)
      and fix those where `0` is a fake measurement (delay, speed, offset). Leave counters
      and indexes alone. List what you changed.
- [x] 8.4 Stale docs: `ARCHITECTURE.md`, `PROGRESS.md`, `PROJECT.md`, `ORIGINAL_REQUEST.md`,
      `TEST_READY.md`, `TEST_INFRA.md`, `BEST_PRACTICES.md`. **Do not delete them.** Add
      a one-line banner at the top of each that is historical:
      `> Historical document — may not match the current code. See README.md, AGENTS.md, OPERATIONS.md.`
      Ask the user whether they want them moved to `docs/history/`.
- [x] 8.5 Update `README.md` with a short "Data sources and trust" section: SIRI (live),
      maresme.net (timetable, per trip), Avanza portal (geometry, notices), what each
      health field means. Keep `docs_check` green.
- [x] 8.6 Validation log: `RESULT: 74 passed, 0 failed. docs_check 0 errors, lint 0 errors. test/siri_bounding_box_test.js passed.`

---

## Phase 9 — Upgrades

Do these only after Phases 0–8 are green. Each is independent.

### 9.1 Data-health panel

- [x] New read-only endpoint `/api/data-health` (main process, cached values only — no
      SQLite, no upstream calls): upstream canary, `lastError`, fleet anomaly, live GPS
      buses vs scheduled buses right now (per line), timetable drift result, season and
      `seasonOutlook`, `holidaysKnownForYear`, report freshness.
- [x] A small panel on `dades.html` ("Estat de les dades") rendering it with green /
      amber / red states and plain Catalan explanations. Rule 1.2.6.
- [x] Test: endpoint returns every field; `null` fields render as "sense dades", never
      as a green state. Verified in `test/data_health_test.js`.

### 9.2 ATM GTFS as a second timetable source (path to other towns)

The ATM (Autoritat del Transport Metropolità) GTFS feed covers Mataró (`agency_id MAT_1`,
routes `MAT_1`…`MAT_8`) and most operators in the Barcelona area, with per-trip
`stop_times` and `calendar_dates`. A copy from 2026-08-16 (one week of service, summer
grid) is in `data/atm_gtfs/` (large: `stop_times.txt` ≈ 220 MB — always stream it with
`readline`, never `readFileSync`).

- [x] Write `scripts/gtfs_import.js <gtfs-dir> --agency MAT_1 --out <file.json>`: streams
      the feed and produces the same per-trip structure as Phase 3 (`dayTrips`), keyed by
      GTFS route and direction, with service dates from `calendar`/`calendar_dates`.
      No new dependencies (plain CSV parsing; handle quoted fields). Verified: streamed 3.75M lines in ~3s.
- [x] Write `scripts/compare_gtfs_maresme.js`: maps GTFS stops to Arribo stops (by name
      normalization + distance < 60 m) and compares per-trip stop times with the maresme
      grid **for the same season and date type**. Output a table of agreement per line.
      Report the result to the user; do not switch sources. Verified: 68,301 stop times compared, 98.5% network agreement.
- [x] Design note in `ARCHITECTURE_NEXT.md` (new file): a `TimetableProvider` interface
      (`getTripsServingStop`, `getServiceWindow`, `getDirectionSchedule`) implemented by
      `maresmeProvider` (current) and `gtfsProvider`. `TrackerRegistry` currently registers
      only Mataró (AGENTS.md §1) — **do not register any other town**; ask the user which
      town comes next and whether it has real-time data.

### 9.3 Independent delay measurement

Requires Phase 3 and 6.

- [x] When a stop visit closes (6.4), compute the bus's own passing time at that stop:
      the `observedAt` of the first sample whose `toStop` is the **next** stop (i.e. the
      bus has passed the visit's stop), or, if the bus was within 30 m of the stop in a
      sample, that sample's `observedAt`. Match the trip with `tripMatcher` (per-trip
      times after Phase 3) and store `measured_delay_mins = passing − published` in
      `stop_visits.measured_delay_mins`, only when the trip match is unambiguous.
- [x] Observatori: show "Retard informat per l'operador" vs "Retard mesurat per Arribo!"
      and their agreement rate (|difference| ≤ 1 min). Explain in the methodology.
- [x] Test with synthetic samples crossing a stop. Verified in `test/independent_delay_measurement_test.js`.

### 9.4 Monthly report for the Ajuntament

- [x] `/api/analytics/report/monthly?month=YYYY-MM` (visits-based): per line and per hour
      band on-time / early / late %, worst stops (≥ 50 visits), data coverage (hours
      with a working feed / service hours), methodology text, generation timestamp, data
      version (git short hash if available at startup, otherwise package version). Verified in test/monthly_report_test.js.
- [x] A printable page section (print CSS in `public/css/style.css`: hide nav/map,
      A4 margins) rendering it. Rule 1.2.6.
- [x] Do **not** send it to anyone. Publishing or emailing is the user's decision.

### 9.5 Open data

- [x] `scripts/export_gtfs.js --out <dir>`: writes a GTFS static feed (agency, routes,
      stops, trips, stop_times, calendar, calendar_dates, feed_info) from the per-trip
      timetable. No zip dependency: write the `.txt` files into a folder and tell the
      user how to zip it. Validate required columns yourself (a test that parses the
      output and checks referential integrity: every `stop_times.stop_id` exists, every
      `trip_id` has ≥ 2 stop_times, times non-decreasing). Verified: test/gtfs_export_test.js passed (3,329 trips, 49,261 stop times).
- [x] GTFS-Realtime (vehicle positions / trip updates) requires protobuf. Deferred pending user decision (asked in Final Delivery Report §5; zero-dependency invariant preserved).

### 9.6 Phase 9 done

- [x] Validation log: `RESULT: 78 passed, 0 failed. docs_check 0 errors, lint 0 errors. test/data_health_test.js passed. test/independent_delay_measurement_test.js passed. test/monthly_report_test.js passed. test/gtfs_export_test.js passed.`

---

## Final delivery report

When you stop (finished or blocked), print a report with exactly these sections:

1. **Phases completed** — with the final `RESULT:` line of each phase.
2. **Files changed** — grouped by phase (`git status` / `git diff --stat`).
3. **Before/after numbers** — timetable audit (Phase 3), Observatori per-visit vs old
   (Phase 6), test counts.
4. **Unticked boxes** — each with the exact blocker and what you tried.
5. **Questions for the user** — holiday sources, ORS, GTFS-RT dependency, moving
   historical docs, next town, whether to commit/deploy.
6. **Not verified** — anything you could not run (e.g. CDP layout checks without Chrome,
   Linux signal handling, live upstream behaviour during service hours).

---

## Appendix A — Audit scripts to create

### A.1 `scripts/audit_timetable_model.js`

Requires the refactored scraper (Phase 3.1). Two modes:

- default: compares what Arribo shows (see `predict` below) with every published cell.
- `--cell <season> <line> <dirKey> <day> <HH:MM origin> <stopId>`: prints the published
  time of one cell (season `winter|summer`, day `weekday|saturday|sunday`).

```js
'use strict';
/**
 * Audits Arribo's timetable times against every cell published on maresme.net.
 *
 *   node scripts/audit_timetable_model.js
 *   node scripts/audit_timetable_model.js --cell winter 1 11 weekday 05:25 1031
 *
 * Network: fetches maresme.net. Never run from tests.
 */
const path = require('node:path');
const fs = require('node:fs');
const S = require('./scrape_maresme_timetables');

const LEGACY = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'mataro_schedules.json'), 'utf8'));
const SHIPPED = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'mataro_schedules.seasons.json'), 'utf8')).seasons;
const URL_SEASON = { winter: 'hivern', summer: 'estiu' };
const hhmm = (sec) => `${String(Math.floor(sec / 3600) % 24).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;

async function publishedGrid(season, L) {
  const html = await S.fetchPage(`https://maresme.net/matarobus/${URL_SEASON[season]}/index.php?l=es&id=${L}`);
  const cols = S.parseSlotArrays(html);
  const blocks = S.resolveBlocks(LEGACY[String(L)], Object.keys(cols).length, S.parseFirstOriginName(html));
  if (blocks.error) throw new Error(`L${L} ${season}: ${blocks.error}`);
  return { cols, blocks };
}

/**
 * What Arribo shows for (season, line, dir, day, trip k, stop i).
 * BEFORE Phase 3.4: origin departure + median offset (the old model).
 * AFTER  Phase 3.4: change this to use the shipped dayTrips (s[i]) — that is
 *                   what getDeparturesForStop returns after the fix.
 */
function predict(season, L, dk, day, originSec, stopId, tripIndex, stopIndex) {
  const dir = SHIPPED[season][String(L)].directions[dk];
  if (dir.dayTrips && dir.dayTrips[day]) {
    const v = dir.dayTrips[day][tripIndex] && dir.dayTrips[day][tripIndex].s[stopIndex];
    return v === undefined ? null : v;
  }
  const off = (dir.dayStopTravelSec[day] || {})[String(stopId)];
  return Number.isFinite(originSec) && Number.isFinite(off) ? originSec + off : null;
}

async function cellMode(args) {
  const [season, L, dk, day, origin, stopId] = args;
  const slot = Object.entries(S.DAY_KEYS).find(([, d]) => d === day)[0];
  const { cols, blocks } = await publishedGrid(season, Number(L));
  const stops = LEGACY[String(L)].directions[dk].stops;
  const off = blocks.offsets[dk];
  const i = stops.findIndex((s) => String(s.id) === String(stopId));
  if (i < 0) throw new Error(`stop ${stopId} not in L${L} d${dk}`);
  const originCol = cols[S.pad2(off)][slot];
  const k = originCol.indexOf(origin);
  if (k < 0) throw new Error(`no trip leaving at ${origin}`);
  console.log(`published ${season} L${L} d${dk} ${day} trip ${origin} @ ${stops[i].name} (${stopId}): ${cols[S.pad2(off + i)][slot][k]}`);
}

async function auditMode() {
  const hist = {}; let total = 0; let over1 = 0; let over2 = 0; const worst = [];
  for (const season of ['winter', 'summer']) {
    for (let L = 1; L <= 8; L++) {
      const { cols, blocks } = await publishedGrid(season, L);
      for (const dk of blocks.order) {
        const off = blocks.offsets[dk];
        const stops = LEGACY[String(L)].directions[dk].stops;
        for (const [slot, day] of Object.entries(S.DAY_KEYS)) {
          const originCol = cols[S.pad2(off)][slot];
          if (!originCol) continue;
          // Published trips in column order, keeping only trips with at least one time,
          // so tripIndex lines up with dayTrips (Phase 3 keeps the same trips, sorted by
          // first time — if you sort, sort here the same way).
          const trips = [];
          for (let k = 0; k < originCol.length; k++) {
            const s = stops.map((_, i) => S.toSec((cols[S.pad2(off + i)] || {})[slot]?.[k] || ''));
            if (s.some(Number.isFinite)) trips.push({ k, s });
          }
          trips.sort((a, b) => a.s.find(Number.isFinite) - b.s.find(Number.isFinite));
          trips.forEach((trip, tripIndex) => {
            stops.forEach((stop, i) => {
              const pub = trip.s[i];
              if (!Number.isFinite(pub) || i === 0) return;
              const pred = predict(season, L, dk, day, trip.s[0], stop.id, tripIndex, i);
              total++;
              if (pred === null) { hist.missing = (hist.missing || 0) + 1; over1++; over2++; return; }
              const e = Math.round(((pred % 86400) - (pub % 86400)) / 60);
              hist[e] = (hist[e] || 0) + 1;
              if (Math.abs(e) >= 1) over1++;
              if (Math.abs(e) >= 2) over2++;
              if (Math.abs(e) >= 3) worst.push(`${season} L${L} d${dk} ${day} trip#${tripIndex} @${stop.name}: ${e > 0 ? '+' : ''}${e} min (published ${hhmm(pub)}, shown ${hhmm(pred)})`);
            });
          });
        }
      }
    }
  }
  console.log('error histogram (min):', JSON.stringify(hist));
  console.log(`cells ${total} | |err|>=1: ${(100 * over1 / total).toFixed(1)}% | |err|>=2: ${(100 * over2 / total).toFixed(1)}% | |err|>=3: ${worst.length}`);
  worst.slice(0, 30).forEach((w) => console.log('  ' + w));
}

const argv = process.argv.slice(2);
(argv[0] === '--cell' ? cellMode(argv.slice(1)) : auditMode()).catch((err) => {
  console.error('audit failed:', err.message);
  process.exit(1);
});
```

Note: `predict` already switches automatically to `dayTrips` once Phase 3.3 has
regenerated the data file, but that only proves the **data** is right. For 3.7 also
change `predict` to call the loader (`require('../src/data/mataroSchedules')` with the
season forced as in `test/season_provenance_test.js`) so the audit checks what the app
actually serves.

### A.2 `scripts/audit_observatori_csv.js`

```js
'use strict';
/**
 * Recomputes punctuality from an Observatori CSV export, per sample and per stop
 * visit (line + stop + scheduled time + date), with early running separated.
 *
 *   node scripts/audit_observatori_csv.js <file.csv>
 */
const fs = require('node:fs');
const { EARLY_LIMIT_MIN, LATE_LIMIT_MIN } = require('../src/core/punctuality');

function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

const [header, ...lines] = fs.readFileSync(process.argv[2], 'utf8').trim().split(/\r?\n/);
const cols = parseCsvLine(header);
const idx = (name) => cols.findIndex((c) => c.startsWith(name));
const I = { t: idx('Data'), line: idx('Linia'), stop: idx('Parada'), d: idx('Retard'), sch: idx('Horari Teoric') };
const rows = lines.map(parseCsvLine).map((r) => ({ t: r[I.t], line: r[I.line], stop: r[I.stop], d: Number(r[I.d]), sch: r[I.sch] }))
  .filter((r) => Number.isFinite(r.d) && r.d > -15);

const visits = new Map();
for (const r of rows) {
  if (!r.sch) continue;
  const k = `${r.t.slice(0, 10)}|${r.line}|${r.stop}|${r.sch}`;
  const v = visits.get(k);
  if (!v || r.t > v.t) visits.set(k, r); // keep the latest sample of the visit
}
const V = [...visits.values()];
const pct = (a, f) => (100 * a.filter(f).length / a.length).toFixed(1);
const report = (name, a) => console.log(`${name.padEnd(14)} n=${String(a.length).padStart(7)} | old(<=3) ${pct(a, (x) => x.d <= 3)} | on-time ${pct(a, (x) => x.d >= EARLY_LIMIT_MIN && x.d <= LATE_LIMIT_MIN)} | early ${pct(a, (x) => x.d < EARLY_LIMIT_MIN)} | late ${pct(a, (x) => x.d > LATE_LIMIT_MIN)}`);
console.log(`range ${rows[rows.length - 1]?.t} → ${rows[0]?.t}`);
report('samples', rows);
report('visits', V);
for (const L of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8']) report(`  ${L} visits`, V.filter((x) => x.line === L));
```

---

## Appendix B — Real operator notices (test fixtures)

Copied from the live `/api/disruptions` on 2026-09-27. Use them verbatim (including
the blank lines) as `description` values in test fixtures. `severity: 'warning'`,
`active: true`.

**aviso_3** — title `TALL CARRER SANT BENET. 28/09`, `linesAffected: ["4","5","7"]`
(L5 is listed only because of the provisional stop "Ronda República (L5)" — L5 must
NOT get a cancellation from this notice; add that assertion to 5.1),
`expiresAt: "2026-09-28T21:59:59.000Z"`:

```
TALL CARRER SANT BENET 



DILLUNS, 28/09/2026, DE 9 A 17 HORES



LÍNIA 4, ADREÇA HOSPITAL 



Parada anul·lada: Miquel Biada



Parada provisional: Ronda República (L5)



LÍNIA 7, ADREÇA PLAÇA DE LES TERESES 



Parada anul·lada: Miquel Biada



Parada provisional: Ronda República (L5)



 



Amb motiu de mudança, aquestes línies modifiquen el recorregut, anul·lant aquestes parades. Els horaris es poden veure afectats. Preguem que disculpin les molèsties.
```

**aviso_2** — title `TALL CARRER MONTSERRAT. 29/09`, lines `["2","5"]`,
`expiresAt: "2026-09-29T12:15:00.000Z"`:

```
TALL CARRER MONTSERRAT 



DIMARTS, 29/09/2026, DE 9:15 A 14:15 HORES



LÍNIA 2, ADREÇA HOSPITAL



Parada anul·lada: Lepant



LÍNIA 5, ADREÇA HOSPITAL



Parada anul·lada: Lepant



 



Amb motiu de descàrrega, aquestes línies modifiquen el recorregut, anul·lant aquestes parades. Els horaris es poden veure afectats. Preguem que disculpin les molèsties.
```

The parser must not depend on the closing paragraph. A third live notice,
`aviso_7` titled `T-MOBILITAT` with description `T-MOBILITAT` and no lines, must
produce no cancellations and no `unmatchedStops` entries (include it as a fixture).
