# Implementation plan: Catalonia research → Arribo!

This is the step-by-step plan for implementing the November 2026 research in
[docs/research/catalonia-2026/](../research/catalonia-2026/README.md). It is the single place to
track progress. **Every session that works on it must update the status of the
steps it touches, in the same commit as the change.** How to pick up the work
(branch, setup, rules) is in [HANDOFF.md](HANDOFF.md).

## Status legend

- `[ ]` not started
- `[~]` in progress (say what is done in the step's *Notes*)
- `[x]` done (give the commit hash)
- `[!]` blocked on something only the owner can do (a key, a decision, a request): see Phase 0

## Ground rules (from CLAUDE.md and AGENTS.md; they win over this plan)

- **Telemetry honesty.** Real GPS, positions estimated from predictions, and timetable-only vehicles are three different things. Label each; never show an estimate as GPS.
- **Ownership.** The server world never opens SQLite. Feed polling lives in the worker or in its own poller, like `app/moventis.go` and `app/gtfsrtpoll.go`.
- **Response formatting.** Build JSON with the JS-semantics helpers (`Obj`, `writeJSON`), not Go maps or `encoding/json`.
- **Time.** Use Europe/Madrid only, through `timeengine.go` and `calendar.go`.
- **TLS.** Never disable certificate checks.
- **Politeness.** Respect every source's crawl delay or quota: moventis.es 10 s, FGC 5,000 requests a day.
- **Privacy.** Never log coordinates, queries or keys.
- **Validation for every step:**
  - in `app/`: `gofmt -l .` prints nothing, `go vet ./...`, `go test ./...`, `go build`;
  - then `npm run test:syntax && npm run lint && npm test && node scripts/docs_check.js`.
- **Server changes.** Compare the old and new binary as described in CLAUDE.md, *Checking a server change*.
- **Frontend.** Bump `public/sw.js` and the HTML asset versions together when frontend files change.
- **Pushing.** A push to `main` on Forgejo deploys. Work on a branch and push only when the owner asks.
- **Scope.** AGENTS.md §1 still says "only Mataró is registered". The trains (Rodalies, FGC) and Moventis were added since, as separate pollers. New networks follow that pattern: their own poller and endpoint, not a revived Catalonia tracker. Update AGENTS.md §1 when a phase changes the scope.

---

## Phase 0 — Owner actions and decisions (not code)

| ID | Status | Action | Unblocks |
|---|---|---|---|
| 0.1 | `[x]` | **Decide the policy for unofficial sources.** Grey sources: moventis.es predictions, sagales.com, Renfe `flota.json`/`flotaLD.json`, TMG `busos_json.php`. Reverse-engineered sources: the Moventis app credential, the Mou-te token. Recommendation: grey yes, behind a config flag, labelled "font no oficial"; reverse-engineered no. | 3.x, 6.x, 7.x |
| 0.2 | `[x]` | **Test the Moventis app's GPS server from the VPS:** `curl -sS -m 15 -o /dev/null -w '%{http_code}\n' https://app.moventis.es/sae/api/posicion/linea/502` (no credential). Write the result in *Notes*. | 1.6 |
| 0.3 | `[x]` | **One-off look at the expired GeoActio planner server from the VPS** (commands in research report 11 §5b). Write whether `"realtime":true` appears. | — (information only) |
| 0.4 | `[x]` | **Register the free keys/tokens:** T-mobilitat static GTFS (CGIM, also on NAP 2059/2060); NAP (`NAP_API_KEY`); TMB developer portal (`TMB_APP_ID`/`TMB_APP_KEY`); TRAM OAuth (`TRAM_CLIENT_ID`/`TRAM_CLIENT_SECRET`). Store them as environment variables on the VPS `.env`, never in the repo. | 4.x, 6.5, 6.6 |
| 0.5 | `[x]` | **Send the data requests:** Generalitat (DGTM) for Casas real-time data and the concession clauses, with a GAIP appeal if ignored; ATM about `CAS RT: NO`; Renfe for R1–R8 unit/platform data; Sagalés, Avanza (Terrassa/Rubí), TUS, TMESA, EMT Tarragona, Reus Transport. Templates: [docs/catalonia-review/DATA_REQUESTS.md](../catalonia-review/DATA_REQUESTS.md) and research report 11 §5. | long term |

Notes:
- 0.1: Approved 2026-11-24 — unofficial public sources may be used behind config flags and labelled "font no oficial". **Amended 2026-11-25:** owner also approved the AMB app's reverse-engineered key for real Casas GPS (`ARRIBO_AMB_VEHICLES`, `app/ambvehicles.go`), enabled in compose, as a stopgap until an official AMB key (0.5). Key in `AMB_API_KEY` (VPS `.env`), never committed.
- 0.2: Done 2026-11-24 from VPS — `curl: (6) Could not resolve host: app.moventis.es` (HTTP 000, DNS gone). Closes 1.6 (no Moventis app GPS server exists).
- 0.3: Done 2026-11-24 from VPS — `otp-client.pre.geoactio.com/otp/routers/default` returns HTTP 503 Service Temporarily Unavailable (no `"realtime":true`, abandoned).
- 0.4: Done 2026-11-24 — owner registered TMB (`app_id`/`app_key`; license requires attributing TMB with last-update date and not distorting data), TRAM OAuth (`client_id`/`client_secret`), and NAP (`ApiKey`, which also serves ATM CGIM GTFS-Fares v2 feeds 2059/2060). Env var pass-throughs wired in `compose.yaml`; values live only in VPS `.env`.
- 0.5: Done 2026-11-24 — owner sent data requests.

---

## Phase 1 — Moventis: refresh every bus faster (research report 11)

Goal: cut the full refresh of the seven lines through Mataró from ~16 min (89 stops × 11 s) to ~6–9 min, without asking moventis.es more often.

| ID | Status | Step | Files | Done when |
|---|---|---|---|---|
| 1.1 | `[x]` | **Headway-based stop spacing.** In `movSamples`, replace the fixed `movStopSpacingKm = 1.5` with a per-route spacing of about speed × headway (the distance between consecutive buses). The headway comes from the timetable in the stop answers or from the static routes (trips per day). Clamp it: at least 1.5 km, at most route length ÷ 2. Always keep the first and last stop. Pass the day-average headway in as data, so the selection stays a pure function that can be tested. | `app/moventis.go`, `app/moventis_test.go` | test: C-10 (~27 km, 26 min headway) picks ~3–4 stops per direction, e11.1 keeps all its stops; total for the 7 lines ≤ 55 (today 89) |
| 1.2 | `[x]` | **Prefer stops shared by several followed lines.** Within a spacing window, pick the stop that serves the most followed lines (Hospital 7340 and Brussel·les 23253 serve four). | `app/moventis.go`, test | test with a synthetic two-line route sharing a stop |
| 1.3 | `[x]` | **Skip lines with no bus due.** Do not ask stops whose only followed lines have no trip in the next ~60 min, judged from the timetable entries (`real:"N"`, `hora`) of their last answers or from static data (e.g. the N-80 by day). Ask each line at least every 30 min anyway, to notice extra trips. | `app/moventis.go`, test | stats show fewer samples off-peak; `/api/health` or the poller stats expose the current sample count |
| 1.4 | `[x]` | **Run each bus's countdown forward between refreshes.** Advance the estimated position from the last `real:"S"` countdown (`app/moventisestimate.go` already maps ETA + `NKM_ORIGEN` to a point). It must stay labelled as estimated from predictions (`positionSource:"stop_predictions"`), and must stop advancing past the stop or after a timeout. | `app/moventisestimate.go`, tests | tests: monotonic progress, no overshoot, stale after N min |
| 1.5 | `[x]` | **Expose cycle metrics:** last full cycle duration, samples per cycle, throttle count, in the existing Moventis stats/health. Document them in OPERATIONS.md. | `app/moventis.go`, OPERATIONS.md | visible in `/api/moventis` or health |
| 1.6 | `[x]` | **Optional: Moventis app GPS as the measured tier.** Closed 2026-11-24: step 0.2 confirmed `app.moventis.es` no longer resolves in DNS (HTTP 000). Predictions poller (`app/moventis.go`) remains the live source until official data arrives via 0.5. | — | closed (host gone) |

Notes:
- 1.1: done. `movSpacingKm` (speed × day-average headway × 0.8, clamped to [1.5 km, route/2]); per-line headways in `movHeadwayMin`, speeds in `movSpeedKmh`. On the 24 Nov routes: 89 → 31 sampled stops, cycle 16.3 → 5.7 min. Headways are a static table from the Generalitat GTFS; step 2.4 can derive them from the timetable instead.
- 1.2: done. `movPickStops` picks, from each window [spacing/2, spacing] after the last sample, the stop served by most followed lines (`movStopLines`), furthest on a tie; first and last stop always sampled. Test `TestMovSamplesSharedStop`.
- 1.3: done. `parseMovStopTimes` now also keeps the `real:"N"` `hora` times (`Sched`); per stop the poller keeps `movStopObs`; `movShouldAsk(now, ...)` skips a stop when no followed line showed a live bus and none is scheduled within 60 min, but asks every stop at least every 30 min. A cycle that asks nothing waits a minute.
- 1.4: already in place before the plan: moventisestimate.go advances positions by the age of each countdown (now - At) and drops predictions older than movObsMaxAge (40 min).
- 1.5: done. `/api/moventis` status has `sampledStops`, `askedStops`, `skippedStops`, `lastCycleSec`, `throttled`; described in OPERATIONS.md, *Moventis poller metrics*.

---

## Phase 2 — Moventis static base from the Generalitat GTFS

Goal: official stops, calendar and road-accurate shapes for the seven lines, under an open licence, joined to the moventis.es stop ids.

| ID | Status | Step | Files | Done when |
|---|---|---|---|---|
| 2.1 | `[x]` | **Script to cut the seven lines out of the Generalitat GTFS.** Source: `busos-interurbans-GTFS.zip`, no key. Route ids: 0498 C-10, 0501 C-20, 0495 C-30, 0496 e11.1, 0497 e11.2, 0502 865, 0109 N-80. The script writes a compact checked-in data file in the `scripts/lib/dataJson.js` format. Quirks to handle: leading spaces in the `stop_times.txt` header, non-zero seconds in times, rider-facing codes found only inside `route_long_name`, and `nota.txt`. | new `scripts/import_gencat_moventis.js`, `data/…` | the file exists; a test guards its format (done 2026-11-24: `scripts/import_gencat_moventis.js` -> `data/moventis/gencat_casas.json`, 362 KB, 650 trips, 12 services, shapes simplified at 5 m; guarded by `test/gencat_casas_data_test.js`; documented in OPERATIONS.md) |
| 2.2 | `[x]` | **Stop crosswalk:** GTFS `stop_code` ↔ Moventis `COD_PARADA` (83/88 match for C-10). Match the rest by coordinates and name, then review by hand. | same script, data file | every sampled stop has a GTFS stop or an explicit "unmatched" entry (done 2026-11-24: 188 Moventis stop ids, 169 by stop_code, 9 by 60 m + name, 10 listed as unmatched in the file; C-10 84 of 86) |
| 2.3 | `[x]` | **Use the GTFS shapes for drawing and position estimates** instead of the moventis.es KML, keeping the KML as fallback. | `app/moventisline.go`, `app/moventisestimate.go` | maps unchanged or better; tests pass (done 2026-11-24: `app/moventisgencat.go` fits each route to its line's shapes, ordered projection, 90% of stops within 150 m; drawn trimmed to the route; buses placed along the road between stops; KML and straight lines stay the fallback. All 15 production routes fitted. The data file moved to `src/data/gencat_casas.json`, since `./data` is a volume in production) |
| 2.4 | `[x]` | **Use the GTFS timetable to know when each line runs** (feeds 1.3), and attribute the Generalitat. | `app/moventis.go`, about/credits page | — (done 2026-11-24: `movShouldAsk` takes the timetable's next departure per line; due within 60 min asks, nothing due stretches the 30-min re-ask to 2 h; a day with no trip of a line in the file reads as unknown, because the feed gave the C-10 weekday service no 2026 dates. Credit added to every Moventis `attribution`; there is no separate credits page. Headways in `movHeadwayMin` are still the static table) |

---

## Phase 3 — Rodalies: per-train detail (research report 02 and its lead-researcher note)

| ID | Status | Step | Files | Done when |
|---|---|---|---|---|
| 3.1 | `[x]` | **Poll Renfe's commuter map** `https://tiempo-real.renfe.com/renfe-visor/flota.json`. Keep núcleo `50` (Catalonia) and take `nextVia` (the platform at the next station: 49/82 trains on 24 Nov, against 22/116 from the GTFS-RT label) and `via`. Join on `codTren` ↔ the GTFS-RT train number. Poll no more than every 30 s. Label it as an unofficial source. | `app/renfemap.go`, `app/railplatforms.go`, `app/raildepartures.go` | Done 2026-11-24: gated behind `ARRIBO_RENFE_MAP=1`, polled every 30 s, official GTFS-RT platforms always win, unofficial platforms labelled `renfe_visor_unofficial` / `unofficial` and feed `rail_platforms` usual-platform learning (`app/renfemap_test.go`). |
| 3.2 | `[x]` | **Poll Renfe's long-distance map** `https://tiempo-real.largorecorrido.renfe.com/renfe-visor/flotaLD.json`. Take `mat` (unit numbers; several = coupled units) and `codProduct`, joined on `codComercial` ↔ train number. Covers regionals (R11, R13–R17, RG1, RL3/RL4, RT1/RT2), not R1–R8. | `app/renfemap.go`, `app/trains.go` | Done 2026-11-24: parses `mat` into `units`/`series`/`coupledCount`, attaches additive `unit` with `unofficial: true` and static facts from `renfe_fleet.json` (`app/renfemap_test.go`). |
| 3.3 | `[x]` | **Static fleet table** (series → manufacturer, cars, length, places, low floor), from research report 02 §4 with the 470 correction. Show it for 3.2 trains. For R1–R8 show at most "sèries habituals en aquesta línia", never as fact. | `src/data/renfe_fleet.json`, `app/renfefleet.go`, `public/js/networkMap.js`, `public/js/i18n.js` | Done 2026-11-24: `renfeSeriesSpecFor` enriches 3.2 units with static facts; `buildTrainPopupHtml` shows e.g. `2 × sèrie 449 · CAF · font no oficial` when `unit` is known, and keeps "sèries habituals en aquesta línia" for R1–R8 when unknown. |
| 3.4 | `[x]` | **Wheelchair access of the actual train**, where the feed has it (GTFS-RT wheelchair flag, `flota.json` `accesible`). Show it only when present. | `app/renfemap.go`, `app/trains.go`, `public/js/networkMap.js`, `public/js/i18n.js` | Done 2026-11-24: exposes `wheelchairAccessible` + `wheelchairSource: "renfe_visor_unofficial"` from `flota.json`/`flotaLD.json` only when present, rendered in train popup labelled "font no oficial". |
| 3.5 | `[~]` | **Add the Renfe long-distance GTFS-RT** (`vehicle_positions_LD.pb`, `trip_updates_LD.pb`) for regionals, and remove duplicates against the commuter feed by train number. | `app/gtfsrtpoll.go` | regionals not lost when they appear only in LD. **Done (partial):** both LD feeds answer (checked 2026-11-24: 200, 12.7 and 15.3 KB, no key). Polled with the commuter cadence in `app/gtfsrtld.go`. LD trip ids are not in the Cercanías static GTFS, so a train is kept only if its number matches exactly one active Rodalies trip on the LD service date (gives line and direction); others (AVE, Avant, MD) are counted and dropped. Commuter entity wins on the same number. Position time is the LD header time (no per-vehicle timestamp). Go tests in `app/gtfsrtld_test.go`. **Left:** LD delays are not in the station-board delay map, LD cancellations and station visits are ignored, regionals with a number that is not in the Cercanías static (if any) stay invisible, and the LD feed header was seen about an hour older than its trip updates (check its real freshness before relying on it). Checked live on 2026-11-24 after the first deploy: the LD trip id's date was a day behind the trains (so nothing matched the one-day Cercanías services; now the feed's own date is tried first), and the LD feed ran about an hour behind the commuter feed with positions really that old (4-75 km off for trains in both feeds), so LD trains are left out while the lag exceeds the stale window. Old-vs-new comparison on the VPS: 1 669 requests, the only differences the new planner `fare` key and the asset version. | `app/gtfsrtpoll.go`, `app/gtfsrtld.go` | — |

---

## Phase 4 — Ticket prices in the planner (research report 08)

| ID | Status | Step | Files | Done when |
|---|---|---|---|---|
| 4.1 | `[x]` | **Fare data, first version without the CGIM token:** replaced by the full ATM GTFS-Fares v2 import in 4.3 (`src/data/fares.json`), keeping Mataró Bus own tickets and non-GTFS overrides. | `src/data/fares.json`, `test/fares_data_test.js` | superseded by 4.3 |
| 4.2 | `[x]` | **Price each planner journey:** count zones crossed; integrated ATM tickets with the transfer window; the Mataró own ticket for intra-Mataró legs; cheapest single and cheapest 10-trip option. Label it "preu orientatiu" with the date of the fares. Never claim a price for operators that aren't integrated. Done across full ATM sector matrix + priority-1 boundary overrides (`ROD_Z1`/`FGC_Z1`) + Aerobús/Airport Metro/non-STI exclusions in `app/fares.go` and `app/fares_test.go`. | `app/fares.go`, `public/js/plan.js`, `i18n.js` | Done 2026-11-24 |
| 4.3 | `[x]` | **Replace the hand table with the ATM GTFS-Fares v2 import** (areas, stop_areas, fare_products, fare_leg_rules, fare_transfer_rules) from the CGIM feed (NAP 2059 with `NAP_API_KEY`). Done 2026-11-24: `scripts/import_atm_fares.js` imports all 46 sectors (2,116 pairs), 379 Rodalies/FGC stop sectors, 208 folded station names, 58 `ROD_Z1`/`FGC_Z1` boundary pairs (multi-trip 1-zone only), and `STI_Barcelona` route membership into `src/data/fares.json`, keeping Mataró Bus + Aerobús (7.75 €) + Airport Metro L9 Sud (5.90 €) + Núria/Montserrat/RL1-RL2/RT1-RL4 exclusions as the override layer in `app/fares.go`. | `scripts/import_atm_fares.js`, `src/data/fares.json`, `app/fares.go`, `app/fares_test.go`, `test/fares_data_test.js` | Done 2026-11-24 |
| 4.4 | `[x]` | **Yearly update note in OPERATIONS.md:** fares change around 15 January (DOGC); check the 50% T-usual subsidy every year. **Done:** OPERATIONS.md, "Fares". | OPERATIONS.md | — |

---

## Phase 5 — Irregular and festive services (research reports 09 and 10)

| ID | Status | Step | Files | Done when |
|---|---|---|---|---|
| 5.1 | `[x]` | **Keep vehicles with unknown line codes.** A Mataró SIRI vehicle whose line is not L1–L8 (e.g. Bus Focs lines 10, 11, 12 during Les Santes) is shown as "servei especial" without a timetable, instead of being dropped. Check first what the tracker does today. **Finding:** the vehicle was never even requested. The worker asks SIRI one line at a time (`pollMataroVehicles` loops `mataroAgency.LineIDs`, `getLiveVehicles("1")` ... `("8")`) and `parseVehicles` filters nothing by line, so a line 10 bus was neither dropped nor mis-assigned: it simply never came back, because no request named line 10. **Done:** `app/specialservice.go`. **Correction (lead check, 2026-11-24):** Avanza answers an empty LineRef with `Status false` and no vehicles, but a named line such as `10` with `Status true`, so the special lines are now asked by name (`ARRIBO_SPECIAL_LINES`, default `10,11,12`), every 5 min while none runs and every 20 s cycle for 30 min after one is seen (`specialPollDue`). Every vehicle whose LineRef is a short numeric code outside L1–L8 goes into the flight recorder with `lineCode` `L10`, no delay, `isSpecialService: true` (additive key, only on these vehicles). It never reaches `ingestBus` (no trip matching, GPS-gap, stop-visit, delay records), `ingestVehicle` skips `recordVehicleSnapshot` for it (so nothing in history tables), the fleet anomaly count and `syncFleetVehicles` ignore it. Frontend: the network map draws it with a neutral colour and the popup says "Servei especial" (ca/es/en), no delay, no progress, no line link; `sw.js` and HTML versions bumped to 9.4.89. **Unverified:** that Avanza publishes the Bus Focs buses under LineRef 10/11/12 (nobody has seen them; check on the next Castell de Focs night), and the old-vs-new binary comparison CLAUDE.md asks for could not be run in the cloud session. | `app/tracker*.go`, frontend | Go tests with a SIRI fixture for line 10 (`app/specialservice_test.go`, `app/testdata/siri_vehicles_special_service.xml`) |
| 5.2 | `[x]` | **Dated notices for Les Santes and other diversions:** a checked-in file of dated stop closures/diversions per line and time window, shown on the stop and line views. Seed it with the 2026 diversions from report 10 as an example, plus the yearly checklist (Les Santes in July, Fira in May, Tots Sants, Christmas). | new `src/data/mataro_events.json`, `app/`, frontend | stops show "desviada" during the window (done 2026-11-24: `src/data/mataro_events.json` + `app/mataroevents.go`; open events served as notices with `source: "calendar"` in the line view and `/api/disruptions`; listed stops marked `divertedBy`, labelled "Desviada"; seeded with the five 2026 Les Santes diversions, line level only; yearly checklist in OPERATIONS.md, *Dated diversions*. The planner does not avoid these stops yet) |
| 5.3 | `[x]` | **Use `serviceOverrides` in `holidays.json`** (it already exists) for special day types. Write in OPERATIONS.md how to add one each year. **Done:** OPERATIONS.md, "Service overrides for special days" (format, what it does and does not do, yearly checklist for Les Santes, Fira, Tots Sants, Christmas); no overrides invented in the data file. | OPERATIONS.md, `src/data/holidays.json` | — |
| 5.4 | `[x]` | **When Generalitat lines are imported (Phase 2):** parse the known `nota.txt` patterns ("I nits de la Revetlla…, Cap d'Any…, Mercè", "excepte festes locals…", request stops, market days) into added/removed dates. Always show the original note. Done 2026-11-24: `parseGencatNote` in `scripts/import_gencat_moventis.js` (always preserves `raw`, extracts festive nights, Barcelona local holidays via Easter+50 / Mercè, on-demand stops, market weekdays, and academic calendar tags), `gcStopTime.runsOn` in `app/moventisgencat.go`, tests in `test/gencat_casas_data_test.js`. | `scripts/import_gencat_moventis.js`, `app/moventisgencat.go`, `test/gencat_casas_data_test.js` | Done 2026-11-24 |

---

## Phase 6 — More real-time networks (research reports 03–07)

Do each only after 0.1 and as its own poller. Order by value for Mataró users first.

| ID | Status | Network | Source | Notes |
|---|---|---|---|---|
| 6.1 | `[x]` | **Other Moventis lines via the same poller:** the Maresme Casas urban lines C-12…C-22, then the rest of the 164 | moventis.es `GetTiemposParada` | Done 2026-11-24: added all 11 Maresme Casas urban/feeder lines (`55` C-12, `56` C-15, `58` C-22, `60` C-16, `64` C-14, `67` C-21, `161` C-13, `340` C-19, `385` C-18, `627` 862, `715` C-17) behind `ARRIBO_MOVENTIS_MARESME=1` with priority cycling (`movStopIsPrimary`: Mataró 7 primary lines every cycle, secondary-only stops every 2nd cycle). Also added Moventis estimated delays in Dades (`app/moventisdelays.go`, persisted to `DATA_DIR/moventis/delays.json`, `/api/moventis?hours=H`, Dades Moventis scope KPIs & per-line table labelled `predicted`). |
| 6.2 | `[x]` | **Sagalés** (Granollers, Manresa, Vic, Mollet, Pineda–Calella, Lloret…): GPS + delays | `www.sagales.com/es/real-time-bus/{id}/{dir}` | Done 2026-11-24: `app/sagales.go` (`ARRIBO_SAGALES=1`, default 13 Mataró/Maresme/Vallès/Girona lines `550,551,553,554,400,405,691,601,604,617,671,672,673`, overridable via `ARRIBO_SAGALES_LINES`, `noHistory`). Handles misspelt `postion`, unix ms timestamps, Google encoded polylines, and deduplicates repeated trips per physical vehicle; labelled "font no oficial" (`app/sagales_test.go`). |
| 6.3 | `[x]` | **AMB buses** (open, official) | `www.ambmobilitat.cat/transit/trips-updates/trips.bin` + AMB GTFS (`/OpenData/google_transit.zip`, 6-day window, refresh daily) | predictions only, no GPS; the vehicle positions file does not exist (done 2026-11-24: `app/amb.go`, `ARRIBO_AMB=1` in compose; 140 lines in the catalog and line view, live departures from the trip updates (a trip is live when its update names a bus due within 30 min), AMB alerts as plain text. No map positions; no stored visits (`noHistory`, ~750 000 a day): Dades for AMB needs sampled storage first) |
| 6.4 | `[x]` | **FGC occupancy and series** | Opendatasoft `posicionament-dels-trens` (Geotren): `tipus_unitat`, `ut`, occupancy per car | mind the 5,000/day quota already shared with the current FGC polling (done 2026-11-24: `app/fgcgeotren.go` polls Geotren every 3 min inside the FGC poller (+480 requests a day, ~4 610 of 5 000 in all); joined by `ut` = vehicle id; `/api/trains` FGC trains carry `unit` {series, occupancyPercent, cars}; shown in the train popup) |
| 6.5 | `[x]` | **TMB Metro predictions** (L1–L5, L11) and **TMB bus** | `api.tmb.cat/v1/itransit/...` | Done 2026-11-24: `app/tmb.go` (`ARRIBO_TMB=1`, `TMB_APP_ID`/`TMB_APP_KEY` from VPS `.env`, `noHistory: true`); daily TMB GTFS import puts Metro (L1–L5, L9N/S, L10N/S, L11, FM) and TMB Bus (105 lines) in the catalog and line views; single-call Metro iTransit polled every 30 s; on-demand per-stop Bus iTransit with 20 s TTL cache (drops `transit_namespace="amb"` duplicates when AMB is on, exposes bus ramp status); cites TMB + last-update date (`app/tmb_test.go`). |
| 6.6 | `[x]` | **TRAM** | opendata.tram.cat OAuth | Done 2026-11-24: `app/tram.go` (`ARRIBO_TRAM=1`, `TRAM_CLIENT_ID`/`TRAM_CLIENT_SECRET` from VPS `.env`, `noHistory: true` for deletion terms); OAuth2 `client_credentials` token cache; Trambaix (`TBX.zip` + `networkId=1`, T1–T3) and Trambesòs (`TBS.zip` + `networkId=2`, T4–T6) GTFS-RT TripUpdates; cites "Powered by TRAM Barcelona" + date (`app/tram_test.go`). |
| 6.7 | `[x]` | **TMG Girona** | `web2.girona.cat/appbus/cat/busos_json.php` | Done 2026-11-24: `app/girona.go` (`ARRIBO_GIRONA=1`, `NAP_API_KEY` from VPS `.env`, `noHistory: true`); daily static GTFS from NAP 1570 (L1, L2, L5, L7, L8, L10, L11, L12) + on-demand 20 s cached HTML parsing of `busos_json.php` (falls back to GTFS on "(sense informació)"); labelled "font no oficial" (`app/girona_test.go`). |

---

## Phase 7 — Documentation upkeep

| ID | Status | Step |
|---|---|---|
| 7.1 | `[x]` | After each phase, update README.md, OPERATIONS.md and AGENTS.md §1 (scope), and run `node scripts/docs_check.js`. Done 2026-11-24: updated `AGENTS.md` §1 and `OPERATIONS.md` for Phases 3–6, verified with `docs_check.js`. |
| 7.2 | `[ ]` | Keep [docs/catalonia-review/DATA_REQUESTS.md](../catalonia-review/DATA_REQUESTS.md) in step with Phase 0.5 answers. |

---

## Progress log

Newest first. One line per session: date, who, steps touched, commit.

- 2026-11-25, cloud session: AMB app-API real GPS for the Maresme/Casas lines (C-10, e11, 865, C-20/30, C-12..C-22), the whole route into Mataró — the source behind AMB Mobilitat. New `app/ambvehicles.go` poller behind `ARRIBO_AMB_VEHICLES`+`AMB_API_KEY`; measured GPS replaces the moventis.es estimate per line while AMB has it live, both on the map and the line view. Research in report 13. Reverses policy 0.1 (owner-approved), enabled in compose. Verified locally: /api/moventis and the line view show measured GPS (`operator_gps`, `positionsEstimated:false`, label "Posició GPS") for C-10/e11/865/C-20/C-30. Known limits: a Casas line whose moventis routes failed to load shows its AMB buses with raw direction and no headsign/bearing; the routeId→direction map is unverified (flip if directions look swapped). Old-vs-new binary comparison not run here — run on the VPS before deploy (CLAUDE.md).

- 2026-11-24, local session: step 6.1 (Moventis Maresme Casas lines C-12…C-22 + 862 behind `ARRIBO_MOVENTIS_MARESME=1` with priority cycling) and Moventis estimated delays in Dades (`app/moventisdelays.go`, `/api/moventis?hours=H`, Dades Moventis KPIs & table, `?v=9.4.99`).
- 2026-11-24, local session: steps 6.2 (Sagalés real GPS + delays, `app/sagales.go`, `ARRIBO_SAGALES=1`), 6.7 (TMG Girona NAP 1570 GTFS + unofficial appbus predictions, `app/girona.go`, `ARRIBO_GIRONA=1`), and 7.1 (updated `AGENTS.md` §1 and `OPERATIONS.md`, `b755f68`).
- 2026-11-24, local session: steps 6.5 (TMB Metro + Bus iTransit + GTFS, `app/tmb.go`, `ARRIBO_TMB=1`, `noHistory: true`) and 6.6 (TRAM Trambaix + Trambesòs OAuth GTFS-RT, `app/tram.go`, `ARRIBO_TRAM=1`, `noHistory: true`, `2f03d48`).
- 2026-11-24, local session: Phase 0 complete (0.2 `app.moventis.es` NXDOMAIN closes 1.6; 0.3 GeoActio 503), Phase 4 complete (4.3 ATM GTFS-Fares v2 import from NAP 2059 with full 46×46 matrix, 379 stop sectors, 58 boundary pairs, and Aerobús/Airport/non-STI overrides), and Phase 5 complete (5.4 Generalitat `nota.txt` pattern parser, `bc79786`).
- 2026-11-24, local session: Phase 0 (0.1, 0.4, 0.5 recorded) and Phase 3 (3.1–3.4: Renfe `flota.json`/`flotaLD.json` platforms, coupled units, fleet popup, and wheelchair accessibility behind `ARRIBO_RENFE_MAP=1`, `128be53`).
- 2026-11-24, local session: step 6.4 (FGC series and occupancy from Geotren).
- 2026-11-24, local session: step 6.3 (AMB buses: catalog, line views, live departures; no history).
- 2026-11-24, local session: step 5.2 (dated diversions file and notices).
- 2026-11-24, local session: step 3.3 (usual series per line in the train popup).
- 2026-11-24, local session: steps 2.3, 2.4 (Generalitat shapes and timetable in the server; data file moved to `src/data/`).
- 2026-11-24, local session: deployed the cloud branch after the VPS comparison (1 669 requests, only expected differences); fixed 3.5 (LD trip-id date a day behind, LD feed an hour late: left out while it lags).
- 2026-11-24, cloud session (agent): steps 3.5, 3.3 (data)
- 2026-11-24, cloud session (agent): steps 4.1, 4.2, 4.4
- 2026-11-24, cloud session (agent): steps 5.1, 5.3
- 2026-11-24, cloud session (agent): steps 2.1, 2.2
- 2026-11-24, cloud session (agent): steps 1.2, 1.3, 1.5
- 2026-11-24, cloud session: checked the agents' work; fixed 5.1 to ask special lines by name (an empty LineRef returns nothing).
- 2026-11-24, cloud session: step 1.1 done (headway-based Moventis stop spacing).
- 2026-11-24, cloud session: wrote this plan and HANDOFF.md.
