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
| 0.1 | `[!]` | **Decide the policy for unofficial sources.** Grey sources: moventis.es predictions, sagales.com, Renfe `flota.json`/`flotaLD.json`, TMG `busos_json.php`. Reverse-engineered sources: the Moventis app credential, the Mou-te token. Recommendation: grey yes, behind a config flag, labelled "font no oficial"; reverse-engineered no. | 3.x, 6.x, 7.x |
| 0.2 | `[!]` | **Test the Moventis app's GPS server from the VPS:** `curl -sS -m 15 -o /dev/null -w '%{http_code}\n' https://app.moventis.es/sae/api/posicion/linea/502` (no credential). Write the result in *Notes*. | 1.6 |
| 0.3 | `[!]` | **One-off look at the expired GeoActio planner server from the VPS** (commands in research report 11 §5b). Write whether `"realtime":true` appears. | — (information only) |
| 0.4 | `[!]` | **Register the free keys/tokens:** T-mobilitat static GTFS (CGIM, for fares v2 and all operator prefixes); NAP (nap.transportes.gob.es); TMB developer portal (`app_id`/`app_key`); TRAM OAuth (opendata.tram.cat). Store them as environment variables on the VPS, never in the repo. | 4.x, 7.3, 7.4 |
| 0.5 | `[!]` | **Send the data requests:** Generalitat (DGTM) for Casas real-time data and the concession clauses, with a GAIP appeal if ignored; ATM about `CAS RT: NO`; Renfe for R1–R8 unit/platform data; Sagalés, Avanza (Terrassa/Rubí), TUS, TMESA, EMT Tarragona, Reus Transport. Templates: [docs/catalonia-review/DATA_REQUESTS.md](../catalonia-review/DATA_REQUESTS.md) and research report 11 §5. | long term |

Notes:
- 0.1:
- 0.2:
- 0.3:

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
| 1.6 | `[!]` 0.1+0.2 | **Optional: Moventis app GPS as the measured tier.** Only if 0.2 shows the server answering and 0.1 allows it. Add it behind a flag (`ARRIBO_MOVENTIS_SAE=1`, credential from an env var, never committed): one request per line, real positions labelled as GPS, with the predictions poller as fallback. | new `app/moventissae.go` | flagged off by default |

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
| 2.1 | `[ ]` | **Script to cut the seven lines out of the Generalitat GTFS.** Source: `busos-interurbans-GTFS.zip`, no key. Route ids: 0498 C-10, 0501 C-20, 0495 C-30, 0496 e11.1, 0497 e11.2, 0502 865, 0109 N-80. The script writes a compact checked-in data file in the `scripts/lib/dataJson.js` format. Quirks to handle: leading spaces in the `stop_times.txt` header, non-zero seconds in times, rider-facing codes found only inside `route_long_name`, and `nota.txt`. | new `scripts/import_gencat_moventis.js`, `data/…` | the file exists; a test guards its format |
| 2.2 | `[ ]` | **Stop crosswalk:** GTFS `stop_code` ↔ Moventis `COD_PARADA` (83/88 match for C-10). Match the rest by coordinates and name, then review by hand. | same script, data file | every sampled stop has a GTFS stop or an explicit "unmatched" entry |
| 2.3 | `[ ]` | **Use the GTFS shapes for drawing and position estimates** instead of the moventis.es KML, keeping the KML as fallback. | `app/moventisline.go`, `app/moventisestimate.go` | maps unchanged or better; tests pass |
| 2.4 | `[ ]` | **Use the GTFS timetable to know when each line runs** (feeds 1.3), and attribute the Generalitat. | `app/moventis.go`, about/credits page | — |

---

## Phase 3 — Rodalies: per-train detail (research report 02 and its lead-researcher note)

| ID | Status | Step | Files | Done when |
|---|---|---|---|---|
| 3.1 | `[!]` 0.1 | **Poll Renfe's commuter map** `https://tiempo-real.renfe.com/renfe-visor/flota.json`. Keep núcleo `50` (Catalonia) and take `nextVia` (the platform at the next station: 49/82 trains on 24 Nov, against 22/116 from the GTFS-RT label) and `via`. Join on `codTren` ↔ the GTFS-RT train number. Poll no more than every 30 s. Label it as an unofficial source. | new `app/renfemap.go`, `app/railplatforms.go` | station boards show the announced platform for more trains; "habitual" stays the fallback |
| 3.2 | `[!]` 0.1 | **Poll Renfe's long-distance map** `https://tiempo-real.largorecorrido.renfe.com/renfe-visor/flotaLD.json`. Take `mat` (unit numbers; several = coupled units) and `codProduct`, joined on `codComercial` ↔ train number. Covers regionals (R11, R13–R17, RG1, RL3/RL4, RT1/RT2), not R1–R8. | `app/renfemap.go` | the train popup shows e.g. "2 × sèrie 449" for regionals |
| 3.3 | `[ ]` | **Static fleet table** (series → manufacturer, cars, length, places, low floor), from research report 02 §4 with the 470 correction. Show it for 3.2 trains. For R1–R8 show at most "sèries habituals en aquesta línia", never as fact. | new `src/data/renfe_fleet.json`, frontend popup | — |
| 3.4 | `[ ]` | **Wheelchair access of the actual train**, where the feed has it (GTFS-RT wheelchair flag, `flota.json` `accesible`). Show it only when present. | `app/gtfsrt.go` / renfemap, frontend | — |
| 3.5 | `[ ]` | **Add the Renfe long-distance GTFS-RT** (`vehicle_positions_LD.pb`, `trip_updates_LD.pb`) for regionals, and remove duplicates against the commuter feed by train number. | `app/gtfsrtpoll.go` | regionals not lost when they appear only in LD |

---

## Phase 4 — Ticket prices in the planner (research report 08)

| ID | Status | Step | Files | Done when |
|---|---|---|---|---|
| 4.1 | `[ ]` | **Fare data, first version without the CGIM token:** check in a small fare table for what the planner already covers. ATM 2026: zone 3 sector 3E for Mataró, single ticket 2.90/4.15/5.40 € for 1/2/3 zones, T-casual 13.00/25.50/34.70 €, T-usual 22.80/30.55/42.70 €. Mataró Bus own tickets: 1.70 € single (75 min transfer), T-10 4.85 €. Zone per Rodalies/FGC station from the ATM `stop_areas` (copy in research report 08 §1.2). Include a `validFrom` date and a source line. | new `src/data/fares.json`, `test/` format guard | — |
| 4.2 | `[ ]` | **Price each planner journey:** count zones crossed; integrated ATM tickets with the transfer window; the Mataró own ticket for intra-Mataró legs; cheapest single and cheapest 10-trip option. Label it "preu orientatiu" with the date of the fares. Never claim a price for operators that aren't integrated. | `app/planner.go` (new `fares.go`), `public/js/plan.js`, `i18n.js` | planner response has a `fare` object; UI shows it; tests for 1-leg, 2-leg, intra-Mataró |
| 4.3 | `[!]` 0.4 | **Replace the hand table with the ATM GTFS-Fares v2 import** (areas, stop_areas, fare_products, fare_leg_rules, fare_transfer_rules) from the CGIM feed. Apply the overrides: Aerobús not integrated (≈ 7.75 €); airport metro ticket (≈ 5.90 €); Núria not ATM; a route is priced with ATM products only if it is in the `STI_Barcelona` network; trim header whitespace. | new import script, `fares.go` | the hand table becomes the override layer only |
| 4.4 | `[ ]` | **Yearly update note in OPERATIONS.md:** fares change around 15 January (DOGC); check the 50% T-usual subsidy every year. | OPERATIONS.md | — |

---

## Phase 5 — Irregular and festive services (research reports 09 and 10)

| ID | Status | Step | Files | Done when |
|---|---|---|---|---|
| 5.1 | `[ ]` | **Keep vehicles with unknown line codes.** A Mataró SIRI vehicle whose line is not L1–L8 (e.g. Bus Focs lines 10, 11, 12 during Les Santes) is shown as "servei especial" without a timetable, instead of being dropped. Check first what the tracker does today. | `app/tracker*.go`, frontend | test with a SIRI fixture for line 10 |
| 5.2 | `[ ]` | **Dated notices for Les Santes and other diversions:** a checked-in file of dated stop closures/diversions per line and time window, shown on the stop and line views. Seed it with the 2026 diversions from report 10 as an example, plus the yearly checklist (Les Santes in July, Fira in May, Tots Sants, Christmas). | new `src/data/mataro_events.json`, `app/`, frontend | stops show "desviada" during the window |
| 5.3 | `[ ]` | **Use `serviceOverrides` in `holidays.json`** (it already exists) for special day types. Write in OPERATIONS.md how to add one each year. | OPERATIONS.md, `src/data/holidays.json` | — |
| 5.4 | `[ ]` | **When Generalitat lines are imported (Phase 2):** parse the known `nota.txt` patterns ("I nits de la Revetlla…, Cap d'Any…, Mercè", "excepte festes locals…", request stops, market days) into added/removed dates. Always show the original note. | Phase 2 script | — |

---

## Phase 6 — More real-time networks (research reports 03–07)

Do each only after 0.1 and as its own poller. Order by value for Mataró users first.

| ID | Status | Network | Source | Notes |
|---|---|---|---|---|
| 6.1 | `[ ]` | **Other Moventis lines via the same poller:** the Maresme Casas urban lines C-12…C-22, then the rest of the 164 | moventis.es `GetTiemposParada` | the crawl delay limits how many lines fit in a cycle; prioritise |
| 6.2 | `[!]` 0.1 | **Sagalés** (Granollers, Manresa, Vic, Mollet, Pineda–Calella, Lloret…): GPS + delays | `www.sagales.com/es/real-time-bus/{id}/{dir}` | position key misspelt `postion`, timestamps in ms; one bus repeated per upcoming trip; Vic network changes on 1 Dec 2026 |
| 6.3 | `[ ]` | **AMB buses** (open, official) | `www.ambmobilitat.cat/transit/trips-updates/trips.bin` + AMB GTFS (`/OpenData/google_transit.zip`, 6-day window, refresh daily) | predictions only, no GPS; the vehicle positions file does not exist |
| 6.4 | `[ ]` | **FGC occupancy and series** | Opendatasoft `posicionament-dels-trens` (Geotren): `tipus_unitat`, `ut`, occupancy per car | mind the 5,000/day quota already shared with the current FGC polling |
| 6.5 | `[!]` 0.4 | **TMB Metro predictions** (L1–L5, L11) and **TMB bus** | `api.tmb.cat/v1/itransit/...` | free key |
| 6.6 | `[!]` 0.4 | **TRAM** | opendata.tram.cat OAuth | terms require deleting data when the agreement ends: check before storing history |
| 6.7 | `[!]` 0.1 | **TMG Girona** | `web2.girona.cat/appbus/cat/busos_json.php` | ETA text in HTML; covers TEISA's L3 too |

---

## Phase 7 — Documentation upkeep

| ID | Status | Step |
|---|---|---|
| 7.1 | `[ ]` | After each phase, update README.md, OPERATIONS.md and AGENTS.md §1 (scope), and run `node scripts/docs_check.js`. |
| 7.2 | `[ ]` | Keep [docs/catalonia-review/DATA_REQUESTS.md](../catalonia-review/DATA_REQUESTS.md) in step with Phase 0.5 answers. |

---

## Progress log

Newest first. One line per session: date, who, steps touched, commit.

- 2026-11-24, cloud session (agent): steps 1.2, 1.3, 1.5
- 2026-11-24, cloud session: step 1.1 done (headway-based Moventis stop spacing).
- 2026-11-24, cloud session: wrote this plan and HANDOFF.md.
