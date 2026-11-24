# Real-Time Data Sources for Moventis / Empresa Casas C-10 (Mataró – Barcelona) and Maresme Lines

> **Lead-researcher check, 2026-11-24:** `app.moventis.es` (SAE GPS) was retried after the host was allowed: still `CONNECT tunnel failed, response 502` — the origin is unreachable from this cloud egress, so the SAE GPS endpoint remains **unverified**. The T-mobilitat open trip-updates feed was re-counted independently: 1,702 entities, prefixes TMB 804 / AMB 741 / ROD 102 / FGC 55, **zero Casas**; `vehicle_positions` → 404.

**Research date:** 2026-11-24 · **Author:** Arribo research agent
**Scope:** Every practical way to obtain live **vehicle GPS positions** and/or **real-time stop-arrival predictions** for the Moventis (Empresa Casas) **C-10** (Mataró – Barcelona per la N-II) and the other Maresme Casas lines (**C-20, C-30, e11.1, e11.2, 865, N-80**); briefly, the rest of the Moventis / Sagalés group.
**Method:** light, polite GET probes (a few per endpoint, normal browser User-Agent) through the session's egress proxy; corroborated with an independent community API doc and the retired Arribo Catalonia scrapers in git history.

> Read against `docs/research/MOVENTIS_SOURCES.md` (static GTFS + open-data landscape, verified 2026-11-23) and `docs/catalonia-review/REPORT.md` / `gemini-raw/lane4-...md` (the retired Catalonia scrapers). **This file is specifically about real-time.** Where this document and those disagree, the live probes here (dated 2026-11-24) are newer.

---

## TL;DR — the answer for C-10

1. **There is NO official open real-time feed (GTFS-RT or SIRI) for Empresa Casas / C-10.** Re-verified today: the only Catalonia-wide open GTFS-RT (T-mobilitat) carries **only `TMB`, `FGC`, `ROD`, `AMB`** prefixes — **zero `CAS_`/`GEN_`/`SAB_`** entities. The Generalitat open portal publishes GTFS-RT for FGC only.
2. **The working real-time source today is Moventis's own website JSON API** — `https://www.moventis.es/api/json/GetTiemposParada/...` — **per-stop arrival countdowns**. **Verified live today** for C-10 (Moventis line id `53`): it returns seconds-precise, GPS-backed ETAs (`"real":"S"`) for tracked buses. Undocumented but public (used by Moventis's own "Temps real" page). **This is exactly what the current Arribo `app/moventis.go` poller already consumes.**
3. **True vehicle GPS** (lat/lon/speed/vehicle number) historically came from the Moventis mobile-app SAE endpoint `https://app.moventis.es/sae/api/posicion/linea/502` (`502` = C-10), with the app's embedded HTTP Basic credential. **Could NOT be verified today:** the host returned proxy `502 Bad Gateway` on every attempt — the egress could not reach the origin (likely a transient outage or geo-restriction, **not** an auth rejection). Re-test from a Spanish/residential IP.
4. **Recommended stack (details at the end):** official **Generalitat interurban GTFS** (static: stops, calendar, 100% road-accurate shapes for all 7 lines) **+ live per-stop predictions scraped from `moventis.es/api/json`** (labelled strictly `predicted`), with positions *estimated* from those predictions (as the Go poller does). In parallel: **submit the Moventis developer form** for an official feed, and **re-test the SAE GPS endpoint** for genuine positions.

---

## Source inventory & ranking (C-10 real-time)

| Rank | Source | What it gives for C-10 | Auth | Verified 2026-11-24 | Legal status |
|---|---|---|---|---|---|
| **1** | **moventis.es `/api/json/GetTiemposParada`** | Per-stop live ETAs (`real:"S"`, seconds precision) | none (browser UA) | **YES** — HTTP 200, live `real:"S"` entries for line 53 | Grey: undocumented public endpoint on operator's own site; `robots.txt` Crawl-delay 10; no API ToS found. Poll politely. |
| **2** | **app.moventis.es SAE `/sae/api/posicion/linea/502`** | True vehicle GPS (lat, lon, speed, vehicle id) | HTTP Basic, app's embedded creds | **NO** — proxy 502, host unreachable from egress | Grey/amber: reverse-engineered mobile-app endpoint + embedded credential; revocable; likely against app ToS. |
| **3** | **Mou-te (Generalitat) `MouteAPI/rest/...nextdeparturesNEW?useRealTime=true`** | Stop predictions w/ `realtime` flag (no GPS) | reverse-eng. `AT` header (md5) | **PARTIAL** — API alive, `AT` auth works (notes=200); C-10 stop binding not completed; realtime flag present | Grey: reverse-engineered token; Generalitat can change it without notice. |
| **4** | **Generalitat interurban GTFS (static)** | Stops, timetable, **shapes** for all 7 lines (route_id 0498=C10) — *no RT*, but the join target | none (direct ZIP) | (static, verified 2026-11-23 in sibling doc) | **Open licence** (Llicència oberta Catalunya; attribution). Clean. |
| **5** | **Moventis developer program form** | Official weekly GTFS + "dades en temps real" (spec unstated) | manual approval (NIF + app) | page content confirmed today | Official, bilateral — the *only* clean path to an official RT feed for Casas. |
| **n/a** | **T-mobilitat open GTFS-RT** | — nothing for Casas | none | **YES it answers; NO CAS entities** | Open (Ley 37/2007) — but no C-10. |
| **n/a** | **AMB API v2** | — Casas is outside AMB | `x-api-key` | 403 without key; Casas not in AMB anyway | Needs AMB key; irrelevant to C-10. |
| **n/a** | **Sagalés `real-time-bus`** | — for Sagalés group, not Casas | none | **YES, alive, GPS entities** | Grey public AJAX; not Casas. |

---

## Detailed findings

### 1. Moventis website JSON API — `www.moventis.es/api/json/*`  ★ primary working RT source

**Verified live 2026-11-24 (~11:00–11:05 CET)**, browser User-Agent, `robots.txt` honoured (`Crawl-delay: 10`; the API paths under `/api/json/` and `/es/moventis/` are **not** in the Disallow list).

- **Line catalog** — `GET /es/moventis/ca/lines` → HTTP 200, `application/json`, 2.70 MB.
  - 8 582 rows → **161 unique lines** (one row per operating day). All 161 carry `TREAL:"S"` (real-time-capable flag).
  - Fields: `nid, ID_LINEA, COD_LINEA, DESC_LINEA, ID_ZONA, ID_SUBZONA, TREAL, FORMA, COLOR, TEXT_COLOR, ID_EXPLOTADORA, ID_CONCESION, ID_GRUPO, ADAPTADA, MARCA, DIAS_QUE_CIRCULA`.
  - **The 7 Maresme Casas lines** (zone 4 / subzone 1, `ID_EXPLOTADORA:3` "CASAS", `ID_CONCESION:10`):
    | `ID_LINEA` | `COD_LINEA` | `DESC_LINEA` |
    |---|---|---|
    | **53** | **C-10** | MATARO - BARCELONA (PER N-II) |
    | 57 | C-20 | MATARÓ - LLAVANERES - ST. VICENÇ DE MONTALT |
    | 59 | C-30 | MATARÓ - VILASSAR DE DALT |
    | 47 | e11.1 | MATARO (CENTRE) - BARCELONA (PER AUTOPISTA) |
    | 48 | e11.2 | MATARO (NORD) - BARCELONA (PER AUTOPISTA) |
    | 51 | 865 | MATARÓ - BELLATERRA (UAB) |
    | 68 | N-80 | BARCELONA - MATARÓ (NOCTURNA) |
  - These exactly match `movDefaultLines = {47,48,51,53,57,59,68}` in `app/moventis.go` (confirmed correct).

- **Routes & stops** — `GET /api/json/GetTrayectos/{ID_LINEA}/{YYYYMMDD}` → for line 53, HTTP 200, 41 KB, two trayectos:
  - `ID_TRAYECTO:1` (SENTIDO `I`, "(C10) MATARÓ - BCN (PER LA NII)", 46 stops), `ID_TRAYECTO:2` (SENTIDO `V`, "(C10) BCN - MATARÓ", 42 stops).
  - Each stop (`TrayectosDet[].Parada`) has `ID_PARADA`, **`COD_PARADA`**, `DESC_PARADA`, `MUNICIPIO`, `LATITUD`, `LONGITUD`, `UTMX/UTMY`, plus `SECUENCIA` and `NKM_ORIGEN` (km from origin — used for position estimation).
  - **Crosswalk:** `COD_PARADA` here (e.g. 3750 = "Camí Ral, Estació de Premià de Mar") matches the Generalitat GTFS `stop_code` for 83 of C-10's 88 stops (per the 2026-11-23 sibling doc). This is the key that joins Moventis live ETAs onto the official GTFS stops/shapes/timetable.
  - Also: `GET /api/json/GetKMLs/{ID_LINEA}/{ID_TRAYECTO}` → route geometry as KML (served `text/html`; `app/moventis.go:parseMovKML` parses it).

- **Live stop predictions** — `GET /api/json/GetTiemposParada/ca/{ID_PARADA}/{ID_LINEA}/0` → **the real-time call.** Verified for stop `7001` (Premià de Mar), line 53, HTTP 200.
  - Shape: array of lines serving the stop; each `{idLinea, desc_linea, trayectos:{ <dirName>: [ {minutos, adaptada, real} ] or { <expedicion>: {minutos, real, hora, tiempo} } }, incidencias, selected}`.
  - **`real:"S"`** = GPS-tracked bus; `minutos` is seconds-precise, e.g. `"28 min 01.4540174 s"`. **`real:"N"`** = timetable-only; `minutos` is `"MM' SS''"` with `hora` (HH:MM) and `tiempo`.
  - **Use only `real:"S"` for real-time** (the Go poller does: ignores `real:"N"`; discards the site's throttle placeholder where every field is `"A"`).
  - The site itself polls this endpoint on a 10 s `stream` interval (confirmed in `.../backbone/collections/allTiemposParada.js` + `allLineasView.js`: URL built as `/api/json/GetTiemposParada/ + lang + /{idParada}/{idLinea}/{idLinea2 or 0}`).
- **No GPS here.** Positions must be *estimated* from the per-stop ETAs + the route's `NKM_ORIGEN` ladder (see `app/moventisestimate.go`), always labelled `predicted` / `positionSource:"stop_predictions"` — never as measured GPS.
- **Independent corroboration:** community repo `jtayped/moventis-lleida` (`docs/moventis-api.md`) documents this exact API — base `https://www.moventis.es`, **no auth**, `GetTiemposParada` is "the only live endpoint; mixes live + scheduled"; **the only SAE reference is a static `ID_TRAYECTO_SAE` field — no GPS/AVL in the web API.** Also `joan-domingo/public-transport-map` and `joan-domingo/bus-map-rsc` call the same endpoints. (These community repos are a useful cross-check but not an authority on ToS.)
- **Legal:** undocumented public endpoint on the operator's own public website. No API terms-of-use located. `robots.txt` asks `Crawl-delay: 10`; the Go poller spaces requests ≥11 s and backs off on the throttle placeholder — keep that discipline. This is a scrape, not a licensed feed; the Moventis developer form (source 5) is the clean replacement.

### 2. Moventis SAE (AVL) — `app.moventis.es/sae/api/posicion/linea/{id}`  ★ true GPS, UNVERIFIED today

- **What it is:** the backend of the Moventis mobile app (`com.geoactio.moventis` on Android; iOS app id `1067752414`), built by vendor **geoactio** (same `geoaction` module seen in the Moventis Drupal site). `linea/502` = C-10. Returns a JSON array of vehicles.
- **Historical fields** (from Arribo's retired extractor, commit `9eee5ab` `src/moventisClient.js` / `c10TelemetryExtractor.js`): `idVehiculo`/`calca`/`matricula` (vehicle id), `latitud`/`lat`, `longitud`/`lon`, `velocidad`/`speed`; array sometimes wrapped as `{posiciones|data|vehicles|autobuses}`. The extractor rounded coords to 6 dp and marked them as measured GPS (the honest tier).
- **Auth:** HTTP Basic with the app's **embedded** credential (`appmoventis:...`, base64 in the old client; held in env `MOVENTIS_SAE_AUTH`). I did **not** reprint the token; it is already in git history. This is a reverse-engineered app credential — revocable at any time and almost certainly outside the app's ToS.
- **Today's probe:** every request to `https://app.moventis.es/...` (authenticated and unauthenticated, 4+ attempts with delays) returned **proxy `502 Bad Gateway`** — the egress proxy could not establish a TLS tunnel to the origin. This is an **upstream-reachability failure, not a 401/403**, so it tells us nothing about whether the credential still works; the host may be down, moved, or geo-fenced off the egress IP. **Action: re-test from a Spanish residential IP / the production box.** If it answers, this is the only path to genuine C-10 GPS without a partnership.
- **ID mapping gotcha:** SAE line ids (`502`) differ from the web-API `ID_LINEA` (`53`). Keep the `502 ⇄ C-10` map; other Casas SAE ids are not confirmed and must be discovered empirically.

### 3. Mou-te (Generalitat de Catalunya) — `mou-te.gencat.cat/MouteAPI/rest/*`  — alive, predictions only

- **Status today:** **alive.** The site is now an Angular/MapLibre SPA. API base `https://mou-te.gencat.cat/MouteAPI/rest/`.
- **Auth still works:** the `AT` header scheme is unchanged — `AT = md5("mouteapi" + Date.now().toString().slice(0,7))` (the bundle still defines `TKNW:"mouteapi", TKN:7`). Verified: `GET /MouteAPI/rest/notes?language=ca` with that header → **HTTP 200** with real content. The **old** flat paths (`rest/lines`, etc.) now 404; the live endpoints are namespaced.
- **Real-time endpoints discovered in `main-es2015.*.js`:**
  - `infrastructure/nextdeparturesNEW?paradaId={stop}&useRealTime=true&language=ca` ← the live-arrivals call (explicit `useRealTime=true`; departure model carries a `realtime` boolean).
  - also `infrastructure/nextdepartures?...&liniaId={line}`, `infrastructure/stop/lines?paradaId=`, `infrastructure/nearby?coordX=&coordY=&radius=`, `infrastructure/line/timetable|itineraries`, `gtfs/GTFSGeometries`.
- **C-10 binding not completed today:** `infrastructure/nearby` returned `{"transports":[],"insideZBE":false}` for Maresme and even Barcelona-centre coords (likely needs a different parameter/verb or a POST), so I could not fetch a C-10 stop's live board through Mou-te within budget. Mou-te historically showed interurban predictions for Casas; treat **C-10 realtime via Mou-te as plausible but unverified**. No GPS — predictions only.
- **Legal:** reverse-engineered token on a government site; revocable without notice; grey. The Generalitat's open path is the static GTFS (source 4), not this app API.

### 4. Generalitat interurban GTFS (static) — the join target, not RT

- `https://territori.gencat.cat/.../busos-interurbans-GTFS.zip` — no auth, **open licence** (Llicència oberta d'ús d'informació – Catalunya; attribution "Generalitat de Catalunya"). Verified fresh 2026-11-23 in the sibling doc.
- Contains all 7 Casas lines with **100% road-accurate `shapes.txt`** (route_id `0498`=C10, `0501`=C20, `0495`=C30, `0496`=e11.1, `0497`=e11.2, `0502`=865, `0109`=N80) and stop `stop_code` that joins to Moventis `COD_PARADA` (83/88 for C-10).
- **No real-time** (GTFS-RT only for FGC on the Generalitat portal). It is the clean static spine onto which the scraped predictions (source 1) are overlaid.

### 5. Moventis developer program — the only official RT path for Casas

- Pages confirmed today (downloaded `moventis.es/ca/eines-desenvolupadors`, HTTP 200):
  - Verbatim: *"col·laborem amb desenvolupadors... i **facilitem les dades del transport en temps real**."*
  - **GTFS:** *"Tenim la informació en format GTFS... s'actualitza **setmanalment**"* — schedules, stop passing times, stop coords/codes, line code/name/colour, and route point sequences (shapes).
  - **Google Transit:** *"Col·laborem amb Google Transit des del 2017"* — so Moventis data (incl. C-10) appears in Google Maps. This is a **GTFS (static) partnership**; the page does **not** claim a live GTFS-RT feed to Google, so Google Maps "live" times for C-10 are **not** proof of a public RT feed (and would in any case be Google's, not reusable). Treat Google/Moovit/Citymapper as *consumers* of the same static GTFS + any private Moventis RT, not as sources Arribo can pull from.
  - **Access:** a manual webform (`Nom, Cognoms, NIF/Passaport, Nacionalitat, Adreça, Telèfon, Email, Nom de l'aplicació, Descripció`, optional PDF) at `moventis.es/.../com-aconseguir-les-dades-gtfs-de-moventis`.
- **Recommendation:** submit it, explicitly requesting **GTFS-RT `VehiclePositions` + `TripUpdates`, or SIRI-VM/SM**, for Empresa Casas. This is the only clean, durable route to official C-10 real-time and would let Arribo retire the scraper.

---

## Other Maresme Casas lines (C-20, C-30, e11.1, e11.2, 865, N-80)

Identical to C-10: **same `moventis.es/api/json` web API** (line ids 57, 59, 47, 48, 51, 68 — table above), same `GetTiemposParada` live predictions (`real:"S"`), same lack of any open GTFS-RT. SAE GPS line ids other than `502` are unconfirmed and would need empirical discovery once `app.moventis.es` is reachable. All 7 are in the Generalitat static GTFS with full shapes.

---

## Rest of the Moventis / Sagalés group (brief)

| Network / subsidiary | Real-time source | Verified | Notes |
|---|---|---|---|
| **Moventis Llobregat / Port / Cerdanyola** (AMB-contracted: L16, L20–22, LH1/2, M12/14/15, PR1–5, X30, 88/89, CV1–5) | **T-mobilitat open GTFS-RT `TripUpdates`+`Alerts`** (`t-mobilitat.cat/opendata/.../user/token/open`) + AMB static GTFS | **YES** — today 1 729 trip-update entities incl. `AMB` prefix (749); `vehicle_positions` still **404** | **Open, no auth.** Stop predictions only (no GPS). The only *open* RT in the whole group. |
| **AMB API v2** (`api.ambmobilitat.cat/v2/bus/vehicles`, `/bus/stops/:id/realtimes`) | AMB's own key | 403 without `x-api-key` today | Covers AMB Moventis only (not Casas). Needs a free AMB developer key. |
| **Sagalés / Sarfa / Barcelona Bus / Moventis Costa** | **`www.sagales.com/real-time-bus/{route}/{dir}`** public AJAX | **YES** — HTTP 200 JSON; GTFS-RT-shaped `bus.entities` (vehicle GPS) + encoded-polyline `ruta.shapes` + `ruta.stops` (lat/lon, stopCode) + schedule. (Casas codes return `linia:null` — not a Sagalés operator) | Grey public endpoint. Good for Sagalés-group lines; `entities` empty when no bus is mid-route. |
| **Sarbus (La Vallesana/Marfina), TCC, Autobusos de Lleida, Pujol** | none open | — | In T-mobilitat **static** GTFS (prefixes `SAB/TCC/LLE/PUJ`), **RT: NO**. Live only via `moventis.es` web API (same as Casas) or the Moventis dev program. |
| **Spain NAP** (`nap.transportes.gob.es`, file 1578 Casas etc.) | static GTFS only (free key) | 401 without key (reachable) | **No Moventis RT on NAP.** No "SAEi" centralized Generalitat real-time feed was found to exist publicly. |

---

## Negative / dead-end results (so you don't re-chase them)

- **T-mobilitat `vehicle_positions`** → persistent **404**: no open GPS anywhere in the Catalonia feed, even for AMB.
- **No `CAS_`/`GEN_`/`SAB_`** entities in T-mobilitat `trip_updates` or `alerts` today (grep + prefix count = 0). The "centralized Generalitat SAEi" is not a public feed.
- **Aggregators** (Mobility Database, Transitland, OpenMobilityData) carry **no** Moventis RT; their NAP mirrors 404 and the Gencat mirror is months stale — discovery only, never ingest.
- **Google Maps / Moovit / Citymapper** are downstream consumers, not pullable sources; Google's C-10 presence is the static-GTFS partnership, not a public RT feed.

---

## Concrete recommended stack for C-10 real-time

1. **Static spine (ship now, clean licence):** Generalitat interurban GTFS — stops, calendar, **shapes** for all 7 lines. Join key: GTFS `stop_code` ⇄ Moventis `COD_PARADA`.
2. **Live tier (ship now, already built):** poll `moventis.es/api/json/GetTiemposParada` per sampled stop for the 7 lines (`app/moventis.go`), use only `real:"S"`, ≥11 s spacing + backoff on the `"A"` placeholder, cache routes/KML daily. **Estimate** positions from ETAs + `NKM_ORIGEN` and **label them `predicted`** (never measured GPS) — this respects Arribo's telemetry-honesty invariant.
3. **Genuine GPS (as soon as reachable):** re-test `app.moventis.es/sae/api/posicion/linea/502` from a Spanish/production IP. If it answers, add it as the *measured* tier for C-10, gated behind a flag, and keep the scraper as fallback. Note the credential and the whole endpoint are revocable and ToS-grey.
4. **Official endgame:** submit the Moventis developer form requesting GTFS-RT (VehiclePositions + TripUpdates) or SIRI for Empresa Casas; if granted, it replaces both the scraper and the SAE hack.
5. **Group bonus (not C-10):** for AMB-contracted Moventis lines use the open T-mobilitat GTFS-RT; for Sagalés-group lines use `sagales.com/real-time-bus`.

### Governance note
Of the C-10 options, only (1) and (4) are clean. (2) is a tolerated scrape of the operator's own public site; (3) and the Mou-te token are reverse-engineered and revocable. Decide explicitly whether reverse-engineered app credentials (SAE Basic auth, Mou-te `AT`) are in-scope; the retired-Catalonia review recommended *no*. Never log stop/endpoint coordinates or the planner's home/work coords when polling (CLAUDE.md privacy rule).

---

## Evidence log (probes run 2026-11-24, Europe/Madrid)

- `www.moventis.es/robots.txt` → 200, `Crawl-delay: 10`; `/api/json/` not disallowed.
- `www.moventis.es/es/moventis/ca/lines` → 200, 161 lines, 7 Casas lines present, `TREAL:"S"`.
- `www.moventis.es/api/json/GetTrayectos/53/20261124` → 200, 2 trayectos, 46/42 stops, `COD_PARADA`+lat/lon present.
- `www.moventis.es/api/json/GetTiemposParada/ca/7001/53/0` → 200, live `real:"S"` ETA `"28 min 01.45 s"` for C-10.
- `app.moventis.es/sae/api/posicion/linea/502` (±auth) → proxy **502 Bad Gateway** (host unreachable from egress), 4+ attempts.
- `t-mobilitat.cat/opendata/trip_updates/json/user/token/open` → 200, 1 729 entities, prefixes `{TMB:818, AMB:749, ROD:102, FGC:60}`, **no CAS**.
- `t-mobilitat.cat/opendata/vehicle_positions/json/user/token/open` → **404**.
- `t-mobilitat.cat/opendata/alerts/json/user/token/open` → 200, 134 entities, prefixes `{AMB, TMB, ROD}`, **no CAS**.
- `mou-te.gencat.cat/` → 200 (Angular SPA); `MouteAPI/rest/notes?language=ca` with `AT` header → **200**; old `rest/lines` → 404; `infrastructure/nearby` → 200 but empty.
- `www.sagales.com/real-time-bus/602/0` → 200, GTFS-RT-shaped JSON (entities + shapes + stops); Casas codes → `linia:null`.
- `api.ambmobilitat.cat/v2/...` → **403** `{"message":"Forbidden"}` (needs `x-api-key`).
- `nap.transportes.gob.es/` → reachable; API 401 without key (static only).
- Downloaded artefacts in `(research scratch files, not committed)` (lines.json, tray53.json, tp7001.json, Mou-te bundle + backbone JS, Sagalés samples, developer-page HTML).
