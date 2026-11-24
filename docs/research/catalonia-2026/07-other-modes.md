# G: Other public transport modes in Catalonia (not buses, not Rodalies)

Research for Arribo! Date: **2026-11-24**. Research only: no application code was changed.

## Read this first: how each fact was checked

This session's network let almost no transit host through. `dadesobertes.fgc.cat`, `api.tmb.cat`, `opendata.tram.cat`, `t-mobilitat.atm.cat`, `barcelona.publicbikesystem.net`, `api.bsmsa.eu`, `gbfs.nextbike.net`, `files.mobilitydatabase.org`, `transit.land` and `www.fgc.cat` all failed. curl got a proxy `403`, and WebFetch got "host not allowed". Only GitHub (`api.github.com` code search and `raw.githubusercontent.com`) and web search worked. **No operator endpoint was fetched directly today.** To re-verify by hand, add those hosts to the environment's allowed network hosts. The curl one-liners at the end are a starting point.

Each fact carries one of these marks:

| Mark | Meaning |
|---|---|
| **V-cat** | Verified today, 2026-11-24, from a machine-readable catalogue fetched off GitHub raw: MobilityData `gbfs/systems.csv`, `mobility-database-catalogs`, pybikes data files, an Opendatasoft schema corpus |
| **V-repo** | Verified in Arribo's own source or docs (`app/gtfsrtpoll.go`, `docs/catalonia-review/*`). Hand-checked by the project in Nov 2026 |
| **3P-meas (date)** | Measured live by a named third-party project on the date shown. Main source: `gariasf/viapeninsula` `docs/research/live-data-sources.md`, measured 2026-09-24/25 with real keys |
| **R** | Reported by press or web search only. Not checked against data |

Downloads are in `(research scratch files, not committed)`.

---

## 1. Master table

| Mode / system | Operator | Static data | Real-time source | Auth | Format | Freshness | Licence | Unofficial fallback | Status |
|---|---|---|---|---|---|---|---|---|---|
| **FGC trains** (BV, LA, Lleida–La Pobla) | FGC (Generalitat) | `https://www.fgc.cat/google/google_transit.zip`; also per file on Opendatasoft (`gtfs_*`) | Opendatasoft: `vehicle-positions-gtfs_realtime`, `trip-updates-gtfs_realtime`, `alerts-gtfs_realtime` (.pb attachments); **`posicionament-dels-trens` ("Geotren", JSON)** | none; **5,000 req/day/IP** anonymous | GTFS-RT protobuf + ODS JSON | Geotren changes every 100–140 s; RT data is 2–4 min old | CC BY 4.0, "Ferrocarrils de la Generalitat de Catalunya" | not needed | V-repo + 3P-meas |
| FGC Montserrat rack (MM) and Vallvidrera funicular (FV) | FGC | in the FGC GTFS (`MM`, `FV`, route_type 7) | Geotren lists Montserrat rack trains (`M1`/`M2`). FV: none seen | as above | as above | as above | CC BY 4.0 | — | 3P-meas |
| FGC Núria rack, Gelida, Sant Joan and Santa Cova funiculars | FGC / FGC Turisme | not seen in recent FGC GTFS copies. Older ATM-derived copies had `L1 Cremallera de Núria` | none known | — | — | — | — | turistren.cat notices (HTML) | R |
| FGC ski resorts (La Molina, Vall de Núria, Vallter, Espot, Port Ainé, Boí Taüll) | FGC Turisme | ODS `pistes-de-esqui`, `remuntadors`, `zones-turisme-i-muntanya`, `circuits-*` | ODS **`estat-d-obertura-de-les-explotacions`** (`is_open`, snow depth, sky, visibility, `last_update`) | none (same quota) | ODS JSON | per update, typically daily (R) | CC BY 4.0 (portal default) | resort web pages | V-cat (schema) |
| Tren dels Llacs, Tren del Ciment (heritage) | FGC Turisme | none (seasonal, dated runs) | none | — | — | — | — | turistren.cat calendar | R |
| **TMB Metro** L1–L5, L9N/S, L10N/S, L11, FM | TMB | `https://api.tmb.cat/v1/static/datasets/gtfs.zip` (key). Keyless mirror: MDB `mdb-2359` | **iTransit** `GET /v1/itransit/metro/estacions` (whole network in one call). Predictions for **L1–L5 and L11 only**. No GTFS-RT | `app_id`+`app_key` (free signup) | JSON | built per request (0.3–3 s) | TMB terms: cite TMB and the update date, don't alter, key "solely for the application indicated" | none needed | 3P-meas |
| Funicular de Montjuïc (FM) | TMB | in the TMB GTFS | iTransit lists no stations for FM | key | — | — | TMB terms | — | 3P-meas |
| Telefèric de Montjuïc | TMB (telefericdemontjuic.cat) | none in GTFS (R) | none | — | — | — | — | opening-hours HTML | R |
| Tramvia Blau | TMB | — | — | — | — | — | — | — | **Out of service.** Restoration tied to the 2027 budget (R) |
| Funicular del Tibidabo ("Cuca de Llum") | Parc d'Atraccions Tibidabo (BSM) | none | none | — | — | — | — | runs with the park's opening hours | R |
| Transbordador Aeri del Port | private | none | none | — | — | — | — | — | R |
| **TRAM** Trambaix T1–T3, Trambesòs T4–T6 | TRAM (Tramvia Metropolità SA, ATM concession) | `https://opendata.tram.cat/GTFS/zip/TBX.zip`, `.../TBS.zip` (no key) | `GET /api/v1/activevehicles?networkId=1\|2`, `GET /api/v1/gtfsrealtime?networkId=` (GTFS-RT TripUpdates) | OAuth2 client-credentials (free signup, `POST /connect/token`, 1 h token) | JSON + protobuf | ~10 s (activevehicles). TU header 10–15 s old | TRAM terms: "Powered by TRAM Barcelona", no alteration, cite the update date, 1-year auto-renewing agreement, delete data at the end | endpoints answered without a token on 2026-09-24. **Don't build on that** | 3P-meas |
| **Bicing** (Barcelona) | BSM / Ajuntament (PBSC platform) | GBFS 3.0 `https://barcelona.publicbikesystem.net/customer/gbfs/v3.0/gbfs.json` (also v1.1, v2.3) | same GBFS (`station_status`, `vehicle_types`, `geofencing_zones`) | none. CORS `*` | GBFS JSON | ttl 0 (live) | **No licence stated in the feed.** The licensed route is Open Data BCN `estat-estacions-bicing` (CC BY 4.0, needs a token, anti-bot challenge) | `https://www.bicing.barcelona/get-stations` (website JSON, used by pybikes). Legacy `api.bsmsa.eu/ext/api/bsm/gbfs/v2/...` reported **503 "API blocked temporarily"** since May 2026 | V-cat + 3P (CORS probe 2026-10-15) |
| **AMBici** (AMB e-bike, about 15 municipalities) | AMB (UTE Nextbike–Moventis–Movus) | GBFS 2.3 `https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_bs/gbfs.json` | same | none | GBFS | ~1 min (R) | nextbike GBFS terms (unstated in catalogue) | nextbike `maps/nextbike-live.json?domains=bs` (R) | V-cat |
| **Ganxeta** (Reus) | Ajuntament de Reus | GBFS 2.3/3.0 `https://gbfs.ganxeta.cat/v3/gbfs.json` | same | none | GBFS | ttl 60 | unstated | — | V-cat |
| **Girocleta** (Girona) | Ajuntament / ICNITA (Emovity) | no GBFS | — | — | HTML | — | — | `https://www.girocleta.cat/mapaestacions.aspx` (HTML scrape, pybikes `emovity`) | V-cat (pybikes) |
| **Baik** (Manresa, since Mar 2026) | Ajuntament / Cooltra | none found | none found | — | — | — | — | Cooltra app only | R |
| Lleida, Terrassa, Sabadell, Sant Cugat, Vilanova, Granollers, Mataró, Tarragona | — | no municipal bike-share with data found. Lleida "LABici" is a 6-month loan scheme. Tarragona dropped its private bike and scooter concession | — | — | — | — | — | — | R |
| Private dockless bikes in Barcelona (Donkey Republic etc.) | private | GBFS: Donkey `https://stables.donkey.bike/api/public/gbfs/3.0/donkey_barcelona/gbfs.json` | same | none | GBFS | — | operator terms | — | V-cat. **Licences end 31 Dec 2026**: banned in Barcelona city from 1 Jan 2027 (R) |
| Moped sharing | Cooltra (and others) | GBFS 3.0 `https://maas.zeus.cooltra.com/gbfs/barcelona/3.0/en/gbfs.json` | same | none | GBFS | — | operator terms | — | V-cat |
| Bird Barcelona | Bird | GBFS `https://mds.bird.co/gbfs/v2/public/barcelona/gbfs.json` | same | none | GBFS 1.1/2.3 | — | — | — | V-cat (listed). Operating status unverified: Barcelona doesn't license shared e-scooters |
| Dott Tarragona | Dott | GBFS `https://gbfs.api.ridedott.com/public/v2/tarragona/gbfs.json` | — | — | GBFS | — | — | — | V-cat (pybikes). The concession was **not renewed** (R), so the feed is probably dead |
| Carsharing | Getaround (P2P); Som Mobilitat (co-op) | Getaround GBFS 3.0: `https://getaround.com/gbfs/v3/{barcelona,badalona,castelldefels,granollers,sabadell,viladecans}/gbfs` | same | none | GBFS | — | — | Som Mobilitat: no public API/GBFS found | V-cat / R |
| **Aerobús** A1/A2 | AMB concession (Monbus per Eurecat; verify) | AMB GTFS (R). ATM integrated GTFS | AMB GTFS-RT TripUpdates `https://www.ambmobilitat.cat/transit/trips-updates/trips.bin` (if Aerobús is included: R) | none | GTFS-RT | 30 s | AMB reuse conditions (Llei 37/2007): cite the source and update date | aerobusbarcelona.es "real-time" web | V-cat (AMB RT exists) / R |
| Girona / Reus / Lleida airport buses | Sagalés (Barcelona Bus), others | Generalitat interurban GTFS (MDB 2926) (R) | none open | — | — | — | — | — | R |
| Boats: Golondrinas (BCN port), Delta de l'Ebre cruises, Dofi Jet (Sagalés group), Creuers Costa Brava | private | none | none | — | — | — | — | AIS (aisstream.io: free key, **no licence published**; AISHub: no onward sharing) | R |
| Balearia / GNV / Grimaldi / Trasmed ferries | private | — | — | — | — | — | — | AIS | out of scope |
| Taxi, demand-responsive | AMB-IMET taxi; AMB "Bus a demanda"; Generalitat TAD | DRT sometimes appears in AMB/interurban GTFS (R) | none | — | — | — | — | — | R |
| Renfe regional and long distance | Renfe | `https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip` (no shapes) | `https://gtfsrt.renfe.com/vehicle_positions_LD.pb`, `trip_updates_LD.pb`. Unofficial visor: `tiempo-real.largorecorrido.renfe.com/renfe-visor/flotaLD.json` | none | GTFS-RT / JSON | 15–30 s | CC BY 4.0 (visor not in the catalogue) | visor | 3P-meas (covered in another report) |

---

## 2. FGC (Ferrocarrils de la Generalitat de Catalunya)

### 2.1 Network

FGC's GTFS has these route ids (3P-meas Sep 2026; also seen in GitHub copies of `routes.txt`):

- **Barcelona–Vallès:** L6, L7, L12 (route_type 1); S1, S2 (route_type 2). Geotren also shows variants such as `L66`.
- **Llobregat–Anoia:** L8 (type 1); S3, S4, S8, S9, R5, R6, R50, R53, R60 (type 2).
- **Lleida–La Pobla de Segur:** RL1, RL2. RL1 is the commuter Lleida–Balaguer service and RL2 the through service. Both are route_type 2, colour `FF8000`.
- **Funicular and rack:** `MM` (Cremallera de Montserrat) and `FV` (Funicular de Vallvidrera), both route_type 7.
- **Not seen in 2026 copies of the FGC GTFS:**
  - Cremallera de Núria. A combined ATM/Generalitat GTFS copy (`OSM-Catalan/tpcatvsosm`) carried `FGC_L1 "Cremallera de Nuria"`, so the ATM integrated GTFS may still have it.
  - Funicular de Gelida, which FGC operates.
  - The Montserrat funiculars Sant Joan and Santa Cova, which FGC has run since 1986. Santa Cova is reported out of service for maintenance.
  - Aeri de Montserrat. This cable car is privately run. FGC lists it in joint notices ("Aeri i funis Montserrat").
- **Heritage trains (FGC Turisme, turistren.cat):** these run on dated days, with no GTFS and no real time.
  - **Tren dels Llacs**, Lleida–La Pobla, on the RL2 tracks. In 2026: 29 runs. The Historic Train ran on Saturdays to 27 June, then 22 August–31 October. The Panoramic Train ran in summer from about 4 July.
  - **Tren del Ciment**, Cercs/La Pobla de Lillet. 2026 dates not found.
  - Both are part of the 2026 "Turistren Passport".
  - Planned trips could be put into a small hand-made GTFS from the published calendar. Mark it as timetable-only.
- **Ski resorts:** FGC Turisme runs La Molina, Vall de Núria, Vallter, Espot, Port Ainé and Boí Taüll.

### 2.2 Opendatasoft portal (`https://dadesobertes.fgc.cat/api/explore/v2.1/`)

**Access:**

- No key needed. Anonymous quota is **5,000 requests/day per IP**. Headers: `x-ratelimit-limit: 5000`, `x-ratelimit-remaining`, `x-ratelimit-reset`. The quota resets at 00:00 UTC. (V-repo: hand-checked by the Arribo project in Nov 2026. 3P-meas 2026-09-24.)
- CORS `*`.
- An account API key may raise the quota. The portal login was broken on 2026-09-24 (3P). Not yet confirmed.
- Arribo currently polls about 3,840 requests/day: positions every 30 s plus trip updates every 90 s (`app/gtfsrtpoll.go`, `docs/catalonia-review/REPORT.md`).

**Datasets** (field lists come from the Opendatasoft schema corpus `clairey-zx81/yac`, `corpus/ODS/data.opendatasoft.com/*@fgc.json`. V-cat, but the corpus snapshot date is unknown):

| Dataset id | What | Fields |
|---|---|---|
| `vehicle-positions-gtfs_realtime` | one record, `file` → `.pb` | GTFS-RT VehiclePositions: `occupancyStatus`, `currentStatus`, `stopId`. `route_id` is empty. **Vehicle id = Geotren `ut`** |
| `trip-updates-gtfs_realtime` | one record, `file` → `.pb` | arrival/departure predictions for every remaining stop. No `delay` field: delay is implied (same at every stop). Platform stop ids (e.g. `PC1`). One `timestamp` per entity |
| `alerts-gtfs_realtime` | one record, `file` → `.pb` | 186 alerts seen on 2026-09-24, many per-trip notes (e.g. bus connections) |
| **`posicionament-dels-trens`** ("Geotren") | one JSON record per train, about 50–65 | `id` (= GTFS `trip_id`, except Montserrat rack trains), `lin`, `geo_point_2d {lat,lon}`, `dir`, `origen`, `desti`, `properes_parades` (semicolon-joined JSON fragments `{"parada":"XX"}`), `estacionat_a`, `en_hora` ("True"/"False"), **`tipus_unitat`** (fleet series, e.g. `"112"`), **`ut`** (hashed unit id, 12 hex chars, e.g. `1f2cc5fd0372`), per-car occupancy `ocupacio_{mi,ri,m1,m2}_{percent,tram}`. Add `record_timestamp` via `select=` to get the time FGC last updated it |
| `gtfs_zip`, `gtfs_routes`, `gtfs_stops`, `gtfs_shapes`, `trips`, `calendar_dates`, `gtfs_agency` | static GTFS, per file | — |
| `estat-d-obertura-de-les-explotacions` | ski and mountain resort status | `business_unit_2`, `last_update`, `is_open` (int), `min_snow_2`, `max_snow_2`, `sky`, `visibility`, `coordenades` |
| `remuntadors` | ski lift inventory | `id`, `business_unit_2`, `name_bu`, `nom_remuntador`, `tipus_remuntador`. **No open/closed status** |
| `pistes-de-esqui` | slope inventory | `nom_pista`, `color_2`, `zona`, `available_on_winter/summer`, `produced_snow`, `slope`, heights |
| `zones-turisme-i-muntanya`, `circuits-amb-raquetes`, `circuits-esqui-de-muntanya` | tourism and mountain zones | — |
| `prediccion-meteorologica-del-dia-por-paradas` | weather forecast per stop | — |
| `codigo-estaciones`, `lineas-red-fgc`, `accesibilidad-itinerarios`, `tarifas`, `tarifas-por-billetes-y-zonas-2020`, `ecocalculadora` | reference data | — |
| `avisos` | service notices (V-repo, REPORT.md) | — |

### 2.3 How the real-time data behaves

All of this is 3P-meas 2026-09-24/25 and agrees with Arribo's own Nov 2026 checks.

**Getting the files:**

- To fetch a GTFS-RT file, request `.../datasets/<id>/records?limit=1`, take `results[0].file.url` and download it. Arribo does exactly this in `fgcFileURL()`. The file id can change, so on failure look it up again.

**Freshness:**

- Arribo measured the files 1.5–2 min old when fetched, replaced about every 2 min (V-repo).
- Geotren changed every 100–140 s, once after 6 min.

**The vehicle-positions file is unreliable:**

- It was often **empty (0 bytes)**. It was empty throughout a 20-min Cloudflare test, and empty at 09:05 while Geotren listed 60 trains.
- When it isn't empty, it holds Geotren's positions from about 2 minutes earlier.
- Other projects (`OxyHQ/GoWay`, viapeninsula) take positions from Geotren for this reason.

**Joins:**

- Geotren `id` = trip_id for 58/62 records.
- GTFS-RT vehicle ids = Geotren `ut`.
- TripUpdates join the static GTFS 58/58.

### 2.4 Per-train information (fleet)

- Geotren `tipus_unitat` gives the series, and `ut` gives a stable but **hashed** unit id. You can tell series apart and follow one unit through the day. You cannot get the public unit number (e.g. 112.07).
- Series by line. This is background only and wasn't checked against Geotren values:
  - **BV:** 112 (4 cars), 113 (4 cars), 114 (3 cars, for L7's short platforms), and **115** (Stadler Valencia, 15 four-car units for about €99.5M, now entering S1/S2 service; an EU spare-parts notice of May 2026 says they are in service).
  - **LA:** 213, plus older 211-family units. 254/253/252 numbers are locomotives (freight/potash): R, unverified.
  - **Lleida–La Pobla:** DMUs (series not verified).
- Per-car occupancy (M1/MI/RI/M2) is a rare extra. It could be shown as "occupancy reported by FGC".

### 2.5 Recommendation for FGC

1. Keep Arribo's current approach (resolved file URL, cached).
2. **Add Geotren as the position source.** Use the vehicle-positions file only when it isn't empty.
3. Budget: Geotren every 60–120 s plus TripUpdates every 90–120 s, about 2,000–2,900 requests/day, which leaves headroom.
4. Read `x-ratelimit-remaining` and back off below 1,000.
5. Register for an account key once the portal login works.
6. Ski resort status (`estat-d-obertura-de-les-explotacions`) costs one call per hour and is cheap.

---

## 3. TMB: Metro, funiculars and cable cars

### Metro (L1–L5, L9N, L9S, L10N, L10S, L11) and FM

**Static data:**

- `https://api.tmb.cat/v1/static/datasets/gtfs.zip?app_id=…&app_key=…`, updated weekly.
- Has shapes and `pathways.txt`. No `block_id` on metro trips.
- A keyless copy is at Mobility Database `mdb-2359`. The old `developer.tmb.cat/downloads/gtfs.zip` is deprecated (MDB 3232). (V-cat)

**Real time** (3P-meas 2026-09-24/25 with a key; field list confirmed by `alegoml/tmb-cli` captures on 2026-10-25):

- `GET https://api.tmb.cat/v1/itransit/metro/estacions` returns the whole network in one call, about 97 KB. `?estacions=<codes>` limits it to some stations.
- Structure: `linies[] → estacions[]` (`codi_estacio`, `codi_via`, `id_sentit`) `→ linies_trajectes[]` (`codi_trajecte`, `desti_trajecte`) `→ propers_trens[]` (`temps_arribada` epoch ms, `codi_servei`).
- `codi_servei` is the train's service number. It is unique only within a line, and it names a block, not a trip.
- **Predictions cover L1–L5 and L11 only. L9, L10 and FM have none.**
- There is no data timestamp. `timestamp` is when the server answered, so a frozen backend can't be detected.
- No positions. A train's position can be estimated from its countdowns to successive stations (label it estimated).
- Joins: `codi_estacio` = GTFS `stop_code` (stop `1.<codi>`). Headsign + line + next station matched 4,160/4,160 readings to trips.
- Response time: median 1.2 s, sometimes over 10 s.

**Access and terms:**

- **No GTFS-RT** from TMB, confirmed in neither docs nor captures.
- Rate limits are not published, and none appeared in headers or on the portal.
- Free key from developer.tmb.cat. Terms allow derived and commercial use, but must cite TMB and the data date, must not alter data, and the key is "solely for the application indicated". Several public repos embed TMB keys: **don't reuse them**.
- Station screens and the iMetro web use the same backend. Calling them without a key isn't useful and would sidestep TMB's authentication, so don't.

### Other TMB and Barcelona cable systems

| System | Operator | Data |
|---|---|---|
| Funicular de Montjuïc (FM) | TMB | In the GTFS (`frequencies`-style service). No iTransit stations. Timetable only |
| Telefèric de Montjuïc | TMB (telefericdemontjuic.cat) | No GTFS or real time found. Opening hours published (e.g. Jan–Feb 11:00–18:00). Reopened 13 Apr 2026 after a technical stop (R) |
| Tramvia Blau | TMB | **Not running** (stored >7 years). One car shown statically for the 125th anniversary, Oct–Nov 2026. Restoration tied to the 2027 budget (R) |
| Funicular del Tibidabo "Cuca de Llum" | Parc d'Atraccions Tibidabo (BSM) | Runs during park opening hours. No data |
| Transbordador Aeri del Port | private | No data |

---

## 4. TRAM Barcelona (Trambaix T1–T3, Trambesòs T4–T6)

**Static data** (V-cat, MDB 1003/1004; MDB quality reports Jun and Apr 2026):

- `https://opendata.tram.cat/GTFS/zip/TBX.zip` and `TBS.zip`. No key, shapes included, no `feed_info.txt`.

**Real time** (3P-meas 2026-09-24/25 with OAuth credentials; manual at `opendata.tram.cat/manual_en.pdf`):

- **Auth:** register at opendata.tram.cat, then `POST https://opendata.tram.cat/connect/token` with `grant_type=client_credentials`. The bearer token lasts 3,599 s.
- **`GET /api/v1/activevehicles?networkId=1|2`** (1 = TRAMBAIX, 2 = TRAMBESÒS):
  - Fields: `vehicleId` (the unit), `lineName` (`"0"` = out of service), `originStopCode/Name`, `nextStopCode/Name`, `vehiclePosition`, `inStop`, **`delay` (s)**, `destinationStopName`, `courseDirection`, `vehicleStatus`.
  - `vehiclePosition` holds metres from the trip's origin for about 40 s as the tram reaches a stop, then reads `0`. So it is stop-level, not GPS.
- **`GET /api/v1/gtfsrealtime?networkId=`**: GTFS-RT **TripUpdates** with each `trip_id` and `vehicle.id`, and arrival plus departure for every stop. The manual mentions VehiclePositions for Trambesòs, but none were seen. Joins to the static GTFS 100%.
- The manual also documents alerts, occupancy, timetables and trips.
- No rate-limit headers, about 125 ms per answer, no CORS.
- **On 2026-09-24 the endpoints answered without a token.** The terms require registration for dynamic data, so register; don't rely on that.

**Terms:**

- "Powered by TRAM Barcelona" with a link, no alteration, keep data current and cite the update date.
- TRAM can revoke access. The agreement runs 1 year and renews automatically.
- **Data must be deleted when the agreement ends.** That matters for Arribo's historical Observatori, which keeps data; get the history-keeping question answered in writing.

**Diagonal link (R):**

- Glòries–Verdaguer opened on 9 Nov 2024, with T4 running along the Diagonal (new stops Monumental, Sicília, Verdaguer). T5/T6 run to Ciutadella–Vila Olímpica.
- Works around Glòries cut T4/T5/T6 from 3 Jul to 13 Sep 2026. T5/T6 between Glòries and Sant Martí stay affected until about spring 2027.
- Verdaguer → Francesc Macià is planned, with works to finish around 2031.
- Re-import the GTFS often: stop codes around Glòries changed (e.g. `2003` Monumental vs Glòries).

---

## 5. Bike sharing (GBFS)

All feed URLs below were checked today in the MobilityData `systems.csv` catalogue (V-cat).

| System | City | Auto-discovery URL | Versions |
|---|---|---|---|
| Bicing | Barcelona | `https://barcelona.publicbikesystem.net/customer/gbfs/v3.0/gbfs.json` | 1.1, 2.3, 3.0 |
| AMBici | AMB (Cornellà, Esplugues, el Prat, Sant Boi, Sant Joan Despí, Sant Just, Badalona, L'Hospitalet, Santa Coloma, Castelldefels, Viladecans, Sant Feliu, Gavà, Sant Adrià, Molins; pybikes region ids 833–856) | `https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_bs/gbfs.json` | 2.3 |
| Ganxeta | Reus | `https://gbfs.ganxeta.cat/v3/gbfs.json` | 2.3, 3.0 |
| Donkey Republic | Barcelona | `https://stables.donkey.bike/api/public/gbfs/3.0/donkey_barcelona/gbfs.json` | 1.0, 2.3, 3.0 |
| Cooltra (mopeds/e-bikes) | Barcelona | `https://maas.zeus.cooltra.com/gbfs/barcelona/3.0/en/gbfs.json` | 3.0 |
| Bird | Barcelona | `https://mds.bird.co/gbfs/v2/public/barcelona/gbfs.json` | 1.1, 2.3 |
| Getaround (cars) | Barcelona, Badalona, Castelldefels, Granollers, Sabadell, Viladecans | `https://getaround.com/gbfs/v3/<city>/gbfs` | 3.0 |
| Dott (pybikes) | Tarragona | `https://gbfs.api.ridedott.com/public/v2/tarragona/gbfs.json` | 2.x (probably dead) |

**Bicing:**

- The GBFS 3.0 feed lists `gbfs_versions`, `geofencing_zones`, `station_information`, `station_status`, `system_information`, `system_pricing_plans`, `system_regions` and `vehicle_types`. A 2026-10-08 copy was seen. Mechanical and e-bikes are told apart through `vehicle_types`.
- A CORS probe on 2026-10-15 got 200 with `Access-Control-Allow-Origin: *`.
- **Licence:** the feed states none. The licensed copy is Open Data BCN `informacio-estacions-bicing` / `estat-estacions-bicing` (CC BY 4.0). Downloads need a token from `opendata-ajuntament.barcelona.cat/tokens`, and Home Assistant integrations report an anti-bot challenge.
- The legacy `api.bsmsa.eu/ext/api/bsm/gbfs/v2/en/station_status` is reported returning **503 "API blocked temporarily" (error 700700) since May 2026**. Don't use it.
- Unofficial fallback: `https://www.bicing.barcelona/get-stations` (pybikes).
- A new Bicing contract is due to be tendered in autumn 2026 (8,000 → 12,000 bikes), which may change the platform.

**Girocleta (Girona):** no GBFS. Only an HTML station map at `girocleta.cat/mapaestacions.aspx`, which pybikes scrapes (operator ICNITA/Emovity). Three new Girona–Salt stations are planned for 2026.

**Baik (Manresa):** municipal e-bikes from March 2026, 200 bikes, run by Cooltra from a hub at Plaça Bages. There are no docking stations, so there is little to show beyond "service exists". No feed found.

**No municipal system with data found** in Lleida, Terrassa, Sabadell, Sant Cugat, Vilanova, Granollers, Mataró or Tarragona.

- Lleida's LABici is a long-term loan scheme.
- Tarragona did not renew its private bike and scooter concession.
- AMBici expanding to the Vallès is only a proposal (R).

**Private bike licences in Barcelona** end on **31 Dec 2026**. Collboni said they won't be renewed, which affects seven operators and about 3,478 e-bikes. Don't invest in Donkey or Bird Barcelona.

Shared e-scooters aren't licensed in Barcelona city. The new e-scooter rules (helmet, €500 fines) took effect on 1 Feb 2025.

---

## 6. Boats and ferries

| Service | Operator | Data |
|---|---|---|
| Las Golondrinas (Port Vell) | private | Tourist only. No data |
| Delta de l'Ebre cruises (Deltebre, Riumar) and river "pas de barca" crossings (e.g. Flix, Miravet) | private / local councils | No data |
| Dofi Jet Boats (Calella–Pineda–Santa Susanna–Malgrat–Blanes–Lloret–Tossa) | Sagalés group | Seasonal timetables on its website. No feed |
| Creuers Costa Brava, Fondo Cristal etc. (L'Estartit, Roses, Cadaqués) | private | No data |
| Balearia, GNV, Grimaldi, Trasmed (Barcelona/Tarragona–Balearics/Italy) | private | Out of scope |

**Fallback for all boats: AIS positions.**

- aisstream.io gives a free key over WebSocket but **publishes no licence or terms**.
- AISHub allows display but not passing positions on, needs you to run a receiver, and allows 1 request/min.
- Grey area, low value for Arribo. Not recommended.

---

## 7. Airport buses

**Aerobús A1/A2** (Plaça Catalunya ↔ T1/T2):

- An AMB-owned concession. Eurecat names Monbus as the operator; check that.
- Its own website and app show real-time information, but there is no public API.
- It appears as `amb/bus-a1` in the Transit app, so it is probably in AMB's data (R).
- AMB publishes keyless GTFS-RT. These two catalogue entries exist (V-cat):
  - **TripUpdates:** `https://www.ambmobilitat.cat/transit/trips-updates/trips.bin` (MDB 2368)
  - **Alerts:** `.../transit/alerts/alerts.bin` (MDB 2369)
- Whether Aerobús trips are in that feed is **unverified**. Check `route_short_name` A1/A2 in the AMB GTFS. This belongs with the bus research.

**Other airport lines:**

- Sagalés "Barcelona Bus" to Girona airport, Reus airport buses and Lleida-Alguaire are probably in the Generalitat interurban GTFS (MDB 2926) or the ATM integrated GTFS (MDB 2826, NAP 2060) (R).
- No open real time. GoWay checked on 2026-10-12: the Mobility Database lists only AMB's real time for all of Catalonia.

---

## 8. Demand-responsive transport, carsharing, scooters, taxis

- **Demand-responsive:** AMB "Bus a demanda" lines and Generalitat rural TAD. These may appear in the AMB/interurban GTFS. No real time. GTFS-Flex not seen.
- **Carsharing:**
  - **Getaround** has GBFS 3.0 for six Catalan cities (see §5).
  - **Som Mobilitat** (co-op): no public API or GBFS found.
  - Others (Ubeeqo, Zity) are not in the GBFS catalogue for Catalonia.
- **Motosharing:** Cooltra GBFS 3.0 for Barcelona.
- **E-scooters:** not licensed in Barcelona city. Tarragona's Dott ended. A Sant Cugat pilot was reported (R). No usable feeds.
- **MDS:** no Catalan city is known to publish or require MDS publicly.
- **Taxi:** no open data. AMB-IMET publishes statistics only. Apps (FreeNow, Cabify, Uber via taxi) have no public APIs.

---

## 9. Renfe regional and long distance (brief; covered elsewhere)

Source: 3P-meas, viapeninsula 2026-09-24.

- **Static:** `https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip`. No shapes, space-padded fields, `trip_id` = train number + `1` + date.
- **Official real time:** `https://gtfsrt.renfe.com/vehicle_positions_LD.{pb,json}` and `trip_updates_LD.{pb,json}`. Positions have no per-vehicle timestamp.
- **Unofficial:** `https://tiempo-real.largorecorrido.renfe.com/renfe-visor/flotaLD.json`. Fields: `codComercial`, `codProduct`, previous and next station, `ultRetraso` (min), lat/lon, `mat` (unit, e.g. `598008`). Refreshes every 15–30 s. Not in Renfe's catalogue, so the licence is unclear.
- Catalan regionals (R11, R15, R16…) appear in **both** the Cercanías and LD feeds. Dedupe on the 5-digit train number.

---

## 10. Recommendations (ordered)

1. **FGC, now:** add Geotren (`posicionament-dels-trens`) as the position source next to the existing trip updates.
   - Keep the vehicle-positions file as a fallback that is skipped when empty.
   - Expose `tipus_unitat` (series), and occupancy where present.
   - Watch the 5,000/day quota.
   - Add hourly ski resort status (`estat-d-obertura-de-les-explotacions`) as an info panel, not transit.
2. **TRAM, next (best value for the effort):** register for OAuth.
   - Ingest GTFS-RT TripUpdates (stop-level arrivals and departures, joins 100%) plus `activevehicles.delay`.
   - Show trams as "stop-level / estimated between stops", never as GPS.
   - Before storing history, get written confirmation that historical delay statistics are compatible with the terms' "delete on termination" clause.
3. **TMB Metro:** register Arribo's own key.
   - Ingest the one-call `itransit/metro/estacions` as **predicted arrivals** (L1–L5, L11). L9/L10/FM are timetable-only.
   - Label train positions as estimated, and keep them out of punctuality rankings unless matched to trips. iTransit has no data timestamp, so frozen data can't be detected.
4. **Bike share, low effort:** read GBFS for Bicing, AMBici and Ganxeta.
   - For Bicing, prefer the Open Data BCN CC BY 4.0 copy (token) for licence certainty, or ask BSM for written OK on the PBSC GBFS.
   - Skip private Barcelona operators (licences end 31 Dec 2026).
5. **Timetable-only extras:** Funicular de Montjuïc (TMB GTFS), Montserrat rack (FGC GTFS), and Tren dels Llacs / Tren del Ciment from the published calendar. Label all as theoretical.
6. **Skip for now:** boats (no data; AIS has no licence), cable cars, Tibidabo, taxis, scooters, carsharing (except optionally Getaround GBFS).
7. **Network setup for verification:** allow `dadesobertes.fgc.cat`, `opendata.tram.cat`, `api.tmb.cat`, `barcelona.publicbikesystem.net`, `gbfs.nextbike.net`, `gbfs.ganxeta.cat`, `www.ambmobilitat.cat`, `t-mobilitat.atm.cat` and `files.mobilitydatabase.org`, then run the checks below.

### Re-verify (light, polite GETs)

```sh
curl -sI 'https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/posicionament-dels-trens/records?limit=1' | grep -i ratelimit
curl -s  'https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/posicionament-dels-trens/records?limit=100&select=id,lin,tipus_unitat,ut,record_timestamp' | jq '.total_count'
curl -s  'https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets/estat-d-obertura-de-les-explotacions/records?limit=20' | jq '.results'
curl -s  'https://dadesobertes.fgc.cat/api/explore/v2.1/catalog/datasets?limit=100&select=dataset_id' | jq -r '.results[].dataset_id'
curl -s  'https://barcelona.publicbikesystem.net/customer/gbfs/v3.0/system_information' | jq '.data | {name, license_url, attribution_organization_name}'
curl -s  'https://gbfs.nextbike.net/maps/gbfs/v2/nextbike_bs/gbfs.json' | jq '.data | keys'
curl -s  'https://gbfs.ganxeta.cat/v3/gbfs.json' | jq '.data.feeds[].name'
# with keys / tokens (do not commit):
curl -s  "https://api.tmb.cat/v1/itransit/metro/estacions?app_id=$TMB_APP_ID&app_key=$TMB_APP_KEY" | jq '[.linies[].nom_linia]'
```

---

## Sources

**Machine-readable, fetched today from GitHub raw (V-cat):**

- MobilityData GBFS catalogue: `raw.githubusercontent.com/MobilityData/gbfs/master/systems.csv`
- Mobility Database catalogue entries: `MobilityData/mobility-database-catalogs`. Schedule: 1003, 1004, 1856, 2359, 3232, 2826, 1101. Real time (via code search): 2368, 2369
- pybikes data (`eskerda/pybikes`): `ambici.json`, `bicing.json`, `emovity.json`, `gbfs.json`, `ambici.py`, `bicing.py`
- Opendatasoft schema corpus: `clairey-zx81/yac/corpus/ODS/data.opendatasoft.com/*@fgc.json`
- Bicing GBFS 3.0 discovery copy (2026-10-08): `j03rul4nd/ifc-viewer-online/src/lib/layers/__fixtures__/gbfs-bcn-discovery.json`
- CORS probe CSV (2026-10-15): `j03rul4nd/ifc-viewer-online/public/blog/data/city-open-data-cors-2026-10.csv`

**Third-party measurements:**

- `gariasf/viapeninsula` `docs/research/live-data-sources.md`, 2026-09-24/25: FGC, TRAM, TMB and Renfe measurements
- `alegoml/tmb-cli` `docs/tmb-api.md`, 2026-10-24/27: TMB swagger and captures
- `OxyHQ/GoWay` `docs/MAP_LIVE.md`, 2026-10: licence decisions for Bicing, TMB and AIS; FGC vehicle-positions file empty
- `KubaDusza/barcelona-smart-city` (api.bsmsa.eu 503 note); `ocr99/ha-bicing`, `oscarsanchezdm/bicing-hassio` (Open Data BCN token and anti-bot challenge)

**Arribo repo:**

- `app/gtfsrtpoll.go`
- `docs/catalonia-review/REPORT.md`, `DATA_REQUESTS.md`, `gemini-raw/feeds-licences.md`

**Press and web (R):**

- 3cat, Ara, NacióDigital: TRAM Diagonal and Glòries works; Tramvia Blau; Baik Manresa; Girocleta
- road.cc: Barcelona private bike licences end 2027
- Diari de Tarragona: Ganxeta; Tarragona concession
- turistren.cat: Tren dels Llacs 2026; Montserrat funiculars
- Railway Gazette / Railvolution: FGC class 115
- Eurecat AIDA report: Aerobús operator
- telefericdemontjuic.cat; sagales.com (Dofi Jet)
