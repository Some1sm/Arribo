# B. Rodalies de Catalunya: what data exists for every train (research, 2026-11-24)

> **Lead-researcher check, 2026-11-24 ~11:17 Madrid (supersedes the "unverified" marks on §2 for these two feeds):**
> - `https://tiempo-real.largorecorrido.renfe.com/renfe-visor/flotaLD.json` answered **200** (31 KB, no auth, Renfe's public long-distance map). Fields: `codComercial` (train number), `codProduct` (19 Regional, 16 Media Distancia, 18 Regional Exprés, 2 AVE, 10 …), `codOrigen`, `codDestino`, `codEstAnt`, `codEstSig`, `horaLlegadaSigEst`, `ultRetraso` (delay min), `latitud`, `longitud`, `time`, `p` (platform), `accesible`, and **`mat` = the physical unit number(s)**. **24 trains were in Catalonia; all 24 had `mat`; 5 ran as two coupled units** (e.g. `449027,449034` on R11 train 15780; `470095,470116`; `447173,447177`). Series seen: 447 ×9 units, 449 ×5, **470 ×5**, 448 ×2, plus AVE/Avlo 103, 100, 112, 130.
> - **Correction to §4:** series **470 is NOT withdrawn in Catalonia** — five 470 units were in service on R15/R17 today.
> - **Joining by train number works for regionals:** 8 trains in `flotaLD` matched trains in the commuter map feed with lines R11, R15, R16, R17 and RL4, so those lines can show unit number, series and single/double composition live. **Commuter lines R1, R2, R2N, R2S, R3, R4, R7, R8 (and that sample's R13/RG1 trains) never appear in `flotaLD`: no unit data for them.**
> - `https://tiempo-real.renfe.com/renfe-visor/flota.json` answered **200** (121 KB): 82 trains in núcleo 50 (Rodalies de Catalunya), fields `tripId, codTren, codLinea, retrasoMin, codEstAct, codEstSig, horaLlegadaSigEst, codEstDest, codEstOrig, porAvanc, latitud, longitud, nucleo, accesible, via, nextVia`. `via` was filled for 18/82 and **`nextVia` (platform at the next station) for 49/82** — far better platform coverage than the GTFS-RT label (22/116). `accesible` true for 70/82. **No unit field.**
> - Legal: both are undocumented JSON behind Renfe's public web maps; no published licence. Treat as unofficial fallback, poll gently (they update about every 15–30 s).

**Bottom line.** For every Rodalies train, the open Renfe GTFS-RT feed gives: the train number, the line, a position, a status, the next stop, one delay, cancellations, sometimes the platform, and (for about a third of trips) a per-trip wheelchair flag. It gives **no** unit number, series or model, composition (single or double), length, capacity, occupancy, WiFi or bike information. Renfe's long-distance web visor (`flotaLD.json`) carries a `mat` field with the unit number(s) of each train, and Catalan regional trains appear in Renfe's AV/LD/MD feeds. That is the only near-open route to unit and model data, and only for regional and long-distance trains. Adif's systems have composition data and platforms, but they are closed by terms or by signed authentication. Rodalies urban lines (R1–R8) have no unit data at all from any public source.

**How sure each part is**
- **[verified]**: checked in this session, against live feeds pulled on 2026-11-24 10:09 UTC (11:09 Madrid, a Tuesday) or files downloaded here.
- **[second-hand]**: read from open-source client code or docs on GitHub, written by people who called the endpoint.
- **[unverified]**: from web-search summaries only.

**Network limits in this session.** Only `gtfsrt.renfe.com` and `ssl.renfe.com` answered. The egress proxy refused all of these, both by curl and by WebFetch: `tiempo-real.renfe.com`, `tiempo-real.largorecorrido.renfe.com`, `serveisgrs.rodalies.gencat.cat`, `info.adif.es`, `data.renfe.com`, `t-mobilitat.cat`, Wikipedia, and the news sites. Everything said about those sources comes from GitHub code or docs (`raw.githubusercontent.com` works) and from search summaries. Re-check those sources once the hosts are allowed.

**Downloads** are under `(research scratch files, not committed)`:
- `live/`: this session's GTFS-RT pulls, with HTTP headers
- `pb/`: a third-party recording of the Renfe feed from 2026-11-15 17:10 Madrid, found in a public repo's `samples/recordings`
- `gtfs_cer/`: today's Cercanías GTFS, `trips.txt` and `routes.txt`
- `raw/` and `gh/`: the GitHub source files read

The decoding scripts are in `.../research/scripts_B/`.

---

## 1. Renfe GTFS-RT, Cercanías feed (`gtfsrt.renfe.com`) [verified]

The endpoints are `vehicle_positions.{pb,json}`, `trip_updates.{pb,json}` and `alerts.{pb,json}`, all GTFS-RT 2.0. The headers are `Cache-Control: max-age=30, public`, plus `ETag` and `Last-Modified`. There is no CORS header and no key. The licence is CC BY 4.0 (data.renfe.com, "Origen de los datos: Renfe Operadora"). There are also LD variants, `vehicle_positions_LD` and `trip_updates_LD`; see section 4.

### 1.1 VehiclePositions

Snapshot at 2026-11-24 10:09:13 UTC: 390 entities nationwide, **116 of them Rodalies** (`trip_id` prefix `51`). The 2026-11-15 17:10 recording had 297 entities, 75 of them Rodalies.

Catalan trains per line in the live snapshot:

| R4 | R1 | R2S | R2N | R11 | R3 | R8 | R16 | RG1 | R15 | RL4 | R13 | R17 | R14 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 31 | 22 | 19 | 13 | 7 | 5 | 4 | 4 | 3 | 2 | 2 | 2 | 1 | 1 |

No R7, RT1, RT2 or RL3 train was running at that moment. All of these lines exist in the static GTFS.

How each field was populated across the 116 Catalan entities:

| Field | Populated | Content |
|---|---|---|
| `entity.id` | 116/116 | `VP_<LINE>-<TRAIN>`, e.g. `VP_R2N-28430` |
| `vehicle.trip.trip_id` | 116/116 | `<service_id 5><train no. 5><line>`, e.g. `5127M28430R2N`. `51` = Rodalies núcleo, `27M` = day code |
| `trip.start_date`, `start_time`, `route_id`, `direction_id` | 0 | absent |
| `vehicle.position.latitude/longitude` | 116/116 | WGS84 (see the caveat on snapping below) |
| `vehicle.current_status` | 116/116 | INCOMING_AT 54, STOPPED_AT 50, IN_TRANSIT_TO 12 |
| `vehicle.stop_id` | 116/116 | Adif 5-digit station code (`00000` = unknown, per third parties) |
| `vehicle.timestamp` | 116/116 | All 4 s older than the header. Steps of about 20 s |
| `vehicle.vehicle.id` | 116/116 | **The 5-digit commercial train number** (116/116 equal to the number in the label). **Not a unit or vehicle id** |
| `vehicle.vehicle.label` | 116/116 | `LINE-TRAIN` or `LINE-TRAIN-PLATF.(n)`. 22/116 carry a platform (16/75 on 11-15). Platform values seen: 1, 2, 7, 10, 11, 13 |
| `vehicle.license_plate`, `occupancy_status`, `occupancy_percentage`, `multi_carriage_details`, `congestion_level` | 0 | absent |

**What identifies the unit or model: nothing.** `vehicle.id` is the train number, and nothing in the feed names a unit, series, composition or length.

**Caveat on positions** [second-hand, viapeninsula 2026-09 measurements]. IN_TRANSIT_TO positions are real GPS. STOPPED_AT and INCOMING_AT positions are snapped to station coordinates and often frozen. In this session's snapshot several trains share one coordinate, for example `41.36431, 2.1008937` (stop 72305). About 36% of consecutive distinct positions implied speeds above 180 km/h. Draw these positions with a timetable or interpolation layer.

### 1.2 TripUpdates

The live snapshot has 116 Catalan entities: 113 SCHEDULED and 3 CANCELED. The 11-15 recording had 82: 73 SCHEDULED and 9 CANCELED.

| Field | Content |
|---|---|
| `entity.id` | `TUUPDATE_<trip_id>` or `TUCANCEL_<trip_id>` |
| `trip.trip_id`, `trip.schedule_relationship` | always. `CANCELED` is used for whole-trip cancellations |
| `trip_update.delay` | a trip-level delay in seconds |
| `stop_time_update` | **108/116 trips have exactly 1 entry** (the next stop, `arrival.time` and `arrival.delay`), and 3 have none. A few trips running altered routes carry extra entries with `schedule_relationship: SKIPPED`: two R4 trips with 28 entries, R16 18122 with 7, R4 77524 with 4. So skipped stops are published during disruptions. There are still no predictions per remaining stop |
| `trip_update.vehicle.wheelchair_accessible` | **41 of 116 Catalan trips** (24 ACCESSIBLE, 17 INACCESSIBLE); absent on the rest. See section 3 |
| `vehicle.id`, `label`, `start_date` | absent |

Flag by line in the live snapshot:
- **R11, R15, RG1, RL4:** ACCESSIBLE.
- **R13, R14, R16, R17:** INACCESSIBLE.
- **R2S:** 9 ACCESSIBLE, 9 INACCESSIBLE.
- **R1, R2N, R3, R8:** absent.
- **R4:** absent, except 1 ACCESSIBLE.

### 1.3 Alerts

76 entities nationwide, 12 of them targeting Rodalies `route_id`s, for example `51T0020R4`. The texts come in Spanish and Catalan, but **both translations are tagged `language: "es"`**, so detect Catalan by content. `active_period` has a start and usually no end. `Last-Modified` was current today. A third party saw the alerts feed stale for weeks in October 2026, so keep a staleness guard.

### 1.4 Static GTFS (`ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip`, built 2026-11-24 03:08) [verified]

- Catalonia today (`service_id` 5127M): 1,359 trips. Over the whole file: 34,638 Catalan trips in 25 service days.
- Lines: R1, R2, R2N, R2S, R3, R4, R7, R8, R11, R13, R14, R15, R16, R17, RG1, RL3, RL4, RT1, RT2. The route ids still read `51T00xx<line>`. Nothing has been renumbered after the transfer to Rodalies de Catalunya SME. The 2026–2030 plan proposes *new* lines (R9 Terrassa–Granollers, R88 Reus–Girona via the Vallès) but no renaming [unverified].
- `trips.txt` has `wheelchair_accessible` (1 or 2) per trip and `block_id`. **`block_id` is just service + train number** (1,353 of 1,359), so it says nothing about vehicle rostering. `trip_headsign` is blank.
- Planned wheelchair flag by line:
  - **R1, R2, R2N, R8:** all 1.
  - **R2S:** 35 trips 1, 108 trips 2.
  - **R4:** 151 trips 1, 10 trips 2.
  - **R3:** 34 trips 1, 443 trips 2. The R3 has many short route variants because of works.
  - **All regional lines (R11, R13–R17, RG1, RL3, RL4, RT1, RT2):** 2. R11 is 46 trips 2 and 2 trips 1.
- There is no platform data (`platform_code` and parent stations are not used).

---

## 2. Other sources, field by field

### 2.1 Matrix

Legend: ✔ = present, ◐ = partial or sometimes, ✖ = absent, ? = unknown.

| Field | Renfe GTFS-RT (Cercanías) | Renfe GTFS-RT LD (`_LD`) | Renfe visor `flota.json` (Cercanías) | Renfe visor `flotaLD.json` | Renfe visor station board (`salidas/estacion/<code>.json`) | Rodalies app API (`serveisgrs`) | Adif InfoStation (info.adif.es SignalR) | Adif Elcano (app API) | ATM T-mobilitat GTFS-RT (`ROD_`) | Static GTFS |
|---|---|---|---|---|---|---|---|---|---|---|
| Access / licence | open, CC BY 4.0 | open, CC BY 4.0 (TU_LD not in the catalogue) | unauthenticated JSON, not in the catalogue | unauthenticated JSON, not in the catalogue | unauthenticated JSON | undocumented public API (OpenAPI at `/api/v3/api-docs`), no stated licence | open websocket, **Adif legal notice forbids reuse** | **HMAC-signed with app keys; do not use** | open (`/user/token/open`), Ley 37/2007 reuse | open, CC BY 4.0 |
| Verified here | **yes** | yes (positions) | no (blocked) | no (blocked) | no | no | no | no | no | **yes** |
| Train number | ✔ (`vehicle.id`, label) | ✔ | ✔ `codTren` | ✔ `codComercial` | ✔ `trenId` | ? | ✔ | ✔ `commercialNumber` | ◐ (in `trip_id`?) | ✔ (in `trip_id`) |
| Line | ✔ (label, `trip_id`) | ✖ (product via GTFS) | ✔ `codLinea` | ✖ (`codProduct`) | ✔ `linea` | ✔ `line` | ✔ | ✔ `line` | ? | ✔ |
| Position | ✔ (snapped when stopped) | ✔ continuous GPS (no per-vehicle timestamp) | ✔ `latitud/longitud`, `porAvanc` (% to the next station) | ✔ + `time` | ◐ `localizacion` | ✖ ("no coordinates") | ✖ | ◐ (between-stations state) | ✖ (404) | – |
| Delay | ✔ one per trip | ✔ | ✔ `retrasoMin` | ✔ `ultRetraso` | ✔ (real vs planned) | ✔ `delay` | ✔ | ✔ `forecastedOrAuditedDelay` per stop | ✔ | – |
| Predictions per stop | ✖ (next stop only) | ✖ / ◐ | next station `horaLlegadaSigEst` | next station | per-station board | per-station board | per-station board | ✔ per-stop path (`onepaths`) | ? | – |
| Cancellations | ✔ CANCELED, ◐ SKIPPED | ? | ? | ? | ? | ✔ `trainCancelled` | ✔ | ✔ `circulationState` | ? | – |
| Platform | ◐ only `PLATF.(n)` near the next stop | ✖ | ✔ `via`, `nextVia` | ✖ | ✔ `via` | ✔ `platformSelectedStation` | ✔ (planned/CTC/SITRA/operator) | ✔ `plannedPlatform`, `ctcPlatform`, `sitraPlatform`, `operatorPlatform`, `resultantPlatform` | ? | ✖ |
| **Unit / vehicle no.** | ✖ | ✖ | ✖ | **✔ `mat`** (comma-separated when coupled, e.g. `"200001,200002"`) | ✖ | ✖ | ? | ◐ (compositions endpoint, coaches model) | ✖ | ✖ |
| **Series / model** | ✖ | ✖ | ✖ | **inferable: first 3 digits of `mat`** | ✖ | ? `trainType` (values unknown) | ? | ◐ `compositionData.compositionType*` | ✖ | ✖ |
| Composition (single/double) | ✖ | ✖ | ✖ | ✔ count of units in `mat` | ✖ | ✖ | ✔ (`showComposition` option, `coach-pictos`) | ✔ `compositions/path` | ✖ | ✖ |
| Length / capacity | ✖ | ✖ | ✖ | via series lookup | ✖ | ✖ | ? | ? | ✖ | ✖ |
| Accessibility | ◐ `wheelchair_accessible` on about 35% of TUs | ✖ | ✔ `accesible` (boolean per train) | ✔ `accesible` | ✔ `accesible` (1/2) | ✔ `trainAccessible` | ? | ? | ? | ✔ planned, per trip |
| Occupancy / crowding | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ | ✖ |
| WiFi / bikes / depot / livery | ✖ everywhere (static per-series knowledge only) | | | | | | | | | |

### 2.2 Notes per source

**Renfe Cercanías visor (`https://tiempo-real.renfe.com/renfe-visor/flota.json`)** [second-hand]
- This is the public map Renfe launched in 2025. Sources: the cmilanf/home-assistant-renfe-tiempo-real client and its real fixture of 2026-08-05.
- Fields per train: `tripId`, `codTren`, `codLinea`, `retrasoMin` (it can be the string `"no"`), `codEstAct`, `codEstSig`, `horaLlegadaSigEst`, `codEstDest`, `codEstOrig`, `porAvanc` (a percentage of the way to the next station, or the letters `E`/`A`, which are status codes), `latitud`, `longitud`, `nucleo` (**`"50"` for Rodalies, while the GTFS uses `51`**), `accesible` (boolean), `via`, `nextVia`.
- **There is no `mat`.** It carries the same tripIds as the open feed (viapeninsula: 126 of the feed's 128 trains were also in the visor).
- What it adds over GTFS-RT: **a platform for every train, current and next** (`via`, `nextVia`), a per-train accessibility boolean, and progress to the next station.
- The same host serves `data/estaciones.geojson`, `renfe-visor/alerts.json`, `renfe-visor/lineas.geojson` and the station boards at `renfe-json-cutter/write/salidas/estacion/<code>.json`. A board covers about the next 2 hours and has `trenId`, `tripId`, `linea`, `via`, `accesible`, `horaSalida`, `horaSalidaPlanificada` and `localizacion`.
- Status: unauthenticated and undocumented, not in the CKAN catalogue, no stated licence. It is the same publisher as the CC BY data, so it is a grey area: polite polling only.

**Renfe LD visor (`https://tiempo-real.largorecorrido.renfe.com/renfe-visor/flotaLD.json`)** [second-hand]
- Sources: viapeninsula docs, Renfetraso, renfe-tracker, retrasometro.
- Fields: `codComercial`, `codProduct` (2 AVE, 3 Avant, 10 Euromed/Avant, 11 Alvia, 13 Intercity, 16 MD, 18 Regional/Proximidad, 19 Regional Exprés, 28 Avlo), `codOrigen`, `codDestino`, `codEstAnt`, `codEstSig`, `horaLlegadaSigEst`, `ultRetraso`, `latitud`, `longitud`, `time`, **`mat`**, `accesible`, `p`, `corr`.
- **`mat` is the rolling-stock unit number**, comma-separated when units are coupled. Examples seen: `598008`, `120058`, `103021`. Renfetraso groups units by series using the first 3 digits.
- 111–116 trains at a time, refreshed every 15–30 s.
- **Catalan regionals (R11, R13, R14, R15, R16, RL4…) appear in Renfe's LD GTFS-RT** [verified, live]: 33 LD positions inside Catalonia. 8 of them are also in the Cercanías feed (R15-15005, R11-15780, R11-15854, R16-18093, RL4-15623, R16-18124, R15-15036, R13-15042). Others appear only in LD, for example 15001, 15006, 15007, 15032, 15063, 15634, 15806 and 17501.
- **Whether these regional trains also appear in `flotaLD.json` with a `mat` is unverified** (host blocked). It is the single most valuable thing to check.

**Rodalies de Catalunya app and web API (`https://serveisgrs.rodalies.gencat.cat/api/…`)** [second-hand]
- Sources: knoopx/rodalies-wearos, the vicinae extension, RodaliesWidget, Mapaor/horaris-rodalies.
- Endpoints:
  - `stations?lang=…&limit=250`: id, name, accessible, lat/lon, connections, services.
  - `departures?fullResponse=true&lang=…&stationId=…&minute=60|180`, returning `trains[]` with `departureDateHourSelectedStation`, `destinationStation{id,name,accessible}`, `line{id,name}`, **`trainType`**, `delay`, `platformSelectedStation`, `trainObservations`, `trainCancelled`, `trainAccessible`.
  - `timetables?originStationId&destinationStationId&travelingOn&fromTime`, which returns `tipusTren`.
- The OpenAPI document is reportedly at `/api/v3/api-docs` (radar-es).
- **No coordinates.** It is per-station only, so polling every station costs about 200 requests per cycle.
- What `trainType` means (product or rolling stock) is **unknown**. Check it first when the host is allowed.
- The new official Rodalies app launched on 2026-07-30 shows trains on a live map [unverified]. Its backend endpoint was not identified.

**Adif**
- **InfoStation** [second-hand: rubenbupe/adif-panel-configurator, mariomnts/pantallas-estaciones]:
  - The `info.adif.es` station screens (the "Gravita" panels) use a SignalR websocket at `https://info.adif.es/InfoStation`: `JoinInfo("ECM-<station>")` and `GetLastMessage`, with no token.
  - The JSON includes trains, platforms (planned and actual) and observations. The panel has a `showComposition` option and a `coach-pictos` asset set (pictograms of coach features), so **composition and coach data exist on Adif's side**.
  - Adif's legal notice reserves all rights and forbids reproduction without authorisation. The site returns 403 to automated clients on its main CDN.
  - The user's own DATA_REQUESTS.md already records that this data "is not open data and its terms do not allow reuse". **Not recommended without written authorisation.**
- **Elcano** (Adif app; `circulacion.api.adif.es`, `estaciones.api.adif.es`) [second-hand: iscle/Adif_Unofficial]:
  - Endpoints: `/portroyalmanager/secure/circulationpaths/{departures,arrivals,betweenstations}/traffictype/`, `circulationpathdetails/onepaths/`, and `circulationpaths/compositions/path/`.
  - The DTOs include `compositionData{compositionType, compositionTypeCode, compositionTypeDescription}`, per-stop `plannedPlatform`, `ctcPlatform`, `sitraPlatform` and `operatorPlatform`, `forecastedOrAuditedDelay`, `circulationState`, and `CommuterNetwork.RODALIES_CATALUNYA`.
  - Every request is **HMAC-signed with keys extracted from the app**. Using it means defeating authentication. **Do not use.** It is listed only to show that the data exists, as a target for a public-information request.

**ATM T-mobilitat GTFS-RT (`https://t-mobilitat.cat/opendata/trip_updates/{,json/}user/token/open`, `alerts/…`)** [second-hand: Some1sm/Arribo `docs/research/MOVENTIS_SOURCES.md`, verified there on 2026-11-23]
- No key. TripUpdates and Alerts only (vehicle positions return 404).
- At 23:15 CET there were 494 trip entities with prefixes `AMB` (275), `TMB` (161), `FGC` (29) and **`ROD` (29)**, and 550 alerts, 14 of them `ROD`.
- What a `ROD_` entity contains (stop-level times? a vehicle descriptor?) was **not checked**. It is most likely a re-publication of Renfe's feed, keyed to ATM's integrated GTFS. **Do not expect unit data.**

**Community projects** (all [second-hand])
- **Renfe Cercanías GTFS-RT consumers:** gariasf/viapeninsula (Catalonia-first map, with detailed measurement notes), StructuralWizard/TrainRadar, NoPrettyColors/trainradar, ficosta/renfe-live-map, yopaseopor/tempsrealcat (a Catalan real-time map), FlorinTodor/radar-es (a catalogue of sources).
- **Unit and series analytics:** ComputingVictor/Renfetraso. It works from `flotaLD.json` `mat`, so long distance only.
- **GTFS-only interpolated Rodalies map:** wonx/rodalies-tracker (2024).
- **Per-unit records:** listadotren.es has one record per unit, with depot, status and service type (example: unit 9-447-349-2, Media Distancia, depot BCN-SAC = Sant Andreu Comtal) [unverified]. It does not track which unit runs which train.
- **No public tracker** maps Rodalies train numbers to unit numbers in real time. Unit-to-service sightings live in forums (forotrenes, skyscrapercity) and Telegram groups and are not machine-readable.

---

## 3. Can train number → unit or model be inferred?

**Unit number for Rodalies urban lines (R1–R8): no.** No open or grey source publishes it. Renfe's rolling-stock diagrams (*diagrames de material*) are internal.

**Unit number for regional lines (R11, R13–R17, RG1, RL3/RL4, RT1/RT2): probably yes**, through `flotaLD.json` `mat`, *if* those trains are in the LD visor. They are in the LD GTFS-RT [verified]. That they are also in the visor with `mat` is [unverified]. If so, `mat`'s first three digits give the series (for example `449xxx` or `447xxx`), and the count of comma-separated units gives single or double composition. Reliability would be high, since it is Renfe's own operational data.

**Series by line, from public knowledge** (low–medium reliability):
- The 5-digit train number encodes the line family and direction (in today's data: `25xxx` and `28xxx` R1/R2N/R2S, `77xxx` R4, `78xxx` R8, `35xxx` R3, `15xxx` regionals, `18xxx` R16, `30xxx` some R2S services). It does **not** encode the stock.
- A rough line→series prior [unverified, from rodalies.gencat.cat summaries and Wikipedia]:
  - **R2 family:** Civia (463/464/465), 447, and 450/451 double-deck.
  - **R1, R3, R4, R7, R8:** 447 and Civia.
  - **R11:** 447, 449 (historically also 470).
  - **R16:** 447, 448, 449 (historically 470).
  - **Other regionals:** 448 and 449 mostly.
- Any given trip can run any compatible series. Expect to be right about the series on lines with one dominant series (R7, the regionals), and often wrong on R2/R4/R1.

**Per-trip accessibility proxy (new finding)** [verified data; the interpretation is an inference]
- `trip_update.vehicle.wheelchair_accessible` is present on about 35% of Catalan trips, and **it varies between trips of the same line**. On R2S: 9 accessible and 9 inaccessible in the live sample. On 11-15: 25544 accessible, 25546 and 25547 inaccessible.
- It also **disagrees with the static GTFS flag**. Comparing live to static for R2S: static 2 / RT ACCESSIBLE 9 times, static 1 / RT INACCESSIBLE 3 times. On R11: static 2, RT ACCESSIBLE 7 out of 7.
- So the RT flag probably reflects the **unit actually assigned**. Step-free stock means Civia, 449, or a PMR-refurbished 447. Inaccessible stock means 450/451 double-deck, an unrefurbished 447, or 448.
- That supports a coarse two-way split ("low-floor modern" vs "older stepped") for those trips. It is not a model.
- To validate it, log the flag for weeks and compare with sightings or with `flotaLD` `mat` for the regionals.

**Double composition (coupled units on peak R2/R4/R1)**
- Not published openly anywhere.
- Adif InfoStation and Elcano have it (closed). `flotaLD` `mat` has it for regional and long-distance trains only.
- Inference from the timetable alone is not reliable. The only honest proxy is "peak-hour trains on R2/R4 are often double", shown as a heuristic, never as data.

---

## 4. Fleet table (Rodalies and Renfe regionals in Catalonia)

Figures come from search summaries of Wikipedia (es/en), the rodalies.gencat.cat "tipus de trens" pages, Vía Libre, Railvolution and ministry releases. **All [unverified] against the primary pages** (Wikipedia and rodalies.gencat.cat are blocked here). The official Rodalies series pages are known to mix up headings (the "447" page shows 470 data and vice versa).

| Series | Manufacturer | Years | Cars | Length | Seats / total | Max speed | Usual Catalan lines | Accessibility | Units in Catalonia |
|---|---|---|---|---|---|---|---|---|---|
| **447** | CAF / Alstom (Macosa) / Siemens / ABB | 1992–2001 (183 built) | 3 (M-R-M). Couples to 2 or 3 units | 75.99 m | 234 (lots 1, 3, 4) / 270 (lot 2) / 190 (R3 refit) / 219–233 (PMR refit). About 750 total | 120 km/h | R1, R2, R3, R4, R7, R8, some R11/R16. The most numerous Barcelona series | high floor with steps; some refitted for PMR | about 75 maintained at Cornellà per a 2026 report; "more than 100" per es-wiki |
| **450** (double-deck) | CAF / Alstom / Siemens / ABB | 1993–1995 | 6 (M-4R-M) | about 160 m (estimate) | rodalies.gencat.cat: 128 per motor car, 188 per trailer (2×128 + 4×188 = 1,008; unclear whether seats or places) | 140 km/h | R2/R2S/R2N, some MD | double-deck; not step-free | about 6 based at Vilanova i la Geltrú (2026 report) |
| **451** (double-deck) | same | 1997–1998 | 3 | about 80 m (estimate) | about half of a 450 | 140 km/h | R2 family | not step-free | about 12 at Vilanova (2026 report) |
| **463 / 464 / 465 Civia** | CAF / Alstom / Siemens / Bombardier | 2003–2011 | 3 / 4 / 5 (modular; 462 = 2 cars). Couple in pairs | 65.55 / 80.30 / 98.05 m | 169/607, 223/832, 277/997 | 120 km/h | R1, R2 family, R4, some R3/R8 | **low floor, step-free**, PMR spaces | more than 50 (2016 figure); current count unknown |
| **448** | CAF | 1987–1990 | 3 | about 80 m | about 200 seats | 160 km/h | regionals (R11, R13–R16) | high floor | unknown |
| **449** | CAF | 2008–2010 | 5 (estimate) | about 100 m | about 281 seats? (a ministry release cites 281 seats for "current" regional trains) | 160 km/h | R11, R14, R15, R16, RG1, RL | partly low entry; RT feed flags R11/R15/RG1 as accessible | unknown |
| **470** (historical) | CAF (rebuilt from 440) | 1990s | 3 | about 75 m | about 200 | 140 km/h | formerly R11/R16 | high floor | probably withdrawn in Catalonia; check |
| **121** | CAF | 2009–2011 | 4 | about 107 m | about 280 | 250 km/h, dual gauge | to be added: 14 for Catalan regionals (2025–27 plan) | step-free (estimate) | 14 planned |
| **452 (new)** | **Alstom**, Coradia High Capacity, built at Santa Perpètua | deliveries 2026–2029 | 6 cars / 100 m base (4- or 7-car options). Mixed single- and double-deck cars | 100 m | 905 total at 6 pax/m² (seats unknown) | 140 km/h | R1 first (night tests between Arenys and Badalona since 2025) | level boarding in single-deck cars; wider doors | 201 ordered nationally. Catalonia share given variously as 49, 72 or "101/110 incl. others". 16 to be delivered by the end of 2026. **Passenger service expected Q1 2027** (Sept 2026 report); not confirmed in service as of today |
| **453 (new, Stadler)** | Stadler (KISS double-deck middle cars + FLIRT single-deck end cars) | 2026– | T100 = 4 cars, T200 = 8 cars | about 100 / 200 m | 916 / 1,883 total | 140 km/h? | in service in **Madrid** (C-7) since August 2026; 20 for Rodalies per a 2025 ministry note | step-free (estimate) | 20 planned (unconfirmed) |
| **New CAF regional EMU** (series number unclear; "480" is cited) | CAF | 2027– | 100 m | 100 m | 256 seats | up to 200 km/h | Catalan regionals | level boarding | 24–32 planned |

**Depots and workshops** [unverified]: Mataró, Sant Andreu Comtal, Montcada, Cornellà, Vilanova i la Geltrú. Renfe's 2025–30 workshop plan adds or expands workshops at Ripoll, Vilanova, Manresa and Sant Andreu Comtal. Not in any feed.

**Livery:** Rodalies (red/white Generalitat "Rodalies de Catalunya" branding) versus legacy Renfe Cercanías. Not in any feed.

**WiFi and bikes:** no per-train data anywhere. Bikes are allowed under Rodalies rules (with peak restrictions), and Civia and 452 have multipurpose areas. Treat these as static per-series attributes, if shown at all.

**Occupancy:** none from Renfe or Rodalies. A 2025 Xataka article notes that the Rodalies app lacks it, unlike FGC. By contrast, FGC's open Geotren publishes `tipus_unitat` (series), `ut` (a hashed unit id) and occupancy per car.

---

## 5. Other Renfe and rail services in Catalonia: real time, briefly

| Service | Real-time open data | Notes |
|---|---|---|
| Regionals / Media Distancia (R11, R13–R17, RG1, RL3/4, RT1/2; MD Barcelona–Lleida/Zaragoza/València) | Cercanías GTFS-RT for those in núcleo 51, plus LD GTFS-RT (`vehicle_positions_LD`, `trip_updates_LD`) [verified]. `flotaLD.json` with `mat` [second-hand] | Deduplicate on the 5-digit train number. LD positions have no per-vehicle timestamp, and the LD `trip_id` is `<number>1<date>` |
| Avant (Barcelona–Girona–Figueres, Barcelona–Lleida) | LD GTFS-RT + `flotaLD` (`codProduct` 3 or 10) with `mat` | — |
| AVE / Avlo / Alvia / Intercity / Euromed (Renfe) | same as Avant | `mat` gives the unit, for example the 103 or 112 series |
| Renfe–SNCF (AVE to France) | likely LD feeds (codProduct 25 "AVE TGV" in older lists) | unverified |
| **Ouigo** | **none.** Timetable only (NAP dataset 1515, GTFS via a key) | show as timetable-based |
| **Iryo** | **none** public | — |
| All operators at stations | Adif InfoStation / Elcano (closed; see above) | the only source covering Ouigo and Iryo in real time |

---

## 6. Recommendations for Arribo!

1. **Keep Renfe GTFS-RT as the backbone** (open, CC BY 4.0). Parse:
   - the platform out of the label;
   - `CANCELED` trips and `SKIPPED` stops, which are published during disruptions;
   - `trip_update.vehicle.wheelchair_accessible`, shown as "accessible train" or "train not accessible" only when present, and never derived from the static flag, which disagrees with the live one.

   Label snapped or stopped positions honestly. They are station coordinates, not GPS, which fits the project's telemetry-honesty rule.
2. **Add the LD feeds** (`vehicle_positions_LD`, `trip_updates_LD`) for Catalan regionals and long distance, and deduplicate by train number. Some regionals appear only in LD.
3. **Highest-value next check, once `tiempo-real.largorecorrido.renfe.com` is allowed:** confirm that Catalan regional trains appear in `flotaLD.json` and what `mat` contains for them. If they do, Arribo can show the **series, a unit count (single or double) and a derived capacity** for regionals, and should label it "per Renfe's operational data".
4. **Second check, once `tiempo-real.renfe.com` is allowed:** `flota.json`'s `via` and `nextVia` give **a platform for every running Rodalies train** (not only the ones whose label carries `PLATF`), plus an accessibility boolean. It sits on the same host as the open data but is not catalogued, so poll centrally (once per 20–30 s), cache, and attribute Renfe.
5. **Third check:** what `serveisgrs` `trainType` contains, and what is in `/api/v3/api-docs`. Its per-station platforms and `trainCancelled` complement the above. It is per station, so use it on demand (station board views), not for a network sweep.
6. **Do not use Adif Elcano** (signed requests) or scrape Adif InfoStation without written authorisation. Put composition, length and platform data into the public-information requests already drafted in `docs/catalonia-review/DATA_REQUESTS.md`, to Renfe and Rodalies de Catalunya SME, and to Adif via the Consejo de Transparencia. The new SME may fall under GAIP.
7. **Model or unit for R1–R8:** do not display it as data. At most, a static "trains usually seen on this line" note (447, Civia, 450/451), labelled as typical. Add the 452s to the note once they enter service (expected Q1 2027).
8. **Occupancy, WiFi, bikes and depot:** no live source exists. Bikes and PMR can be static per-series facts. Do not imply anything per train.
9. **Validation loop:** log the RT wheelchair flag together with the train number for a few weeks. Repeated per-number patterns would show whether diagrams are stable, which would make a "this train is usually step-free" hint feasible.

---

## Sources

**Verified live:**
- https://gtfsrt.renfe.com/vehicle_positions.json, `trip_updates.pb`, `alerts.pb`, `vehicle_positions_LD.json`, `trip_updates_LD.pb`
- https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip
- https://ssl.renfe.com/ftransit/Fichero_estaciones/estaciones.csv

**Third-party recording:** github.com/PedroFlores199/RailWatch, `samples/recordings/0{0,1,2}-*.pb` (2026-11-15).

**GitHub code and docs read:**
- gariasf/viapeninsula: `docs/research/live-data-sources.md`, `map-against-reality.md`, `high-speed.md`
- cmilanf/home-assistant-renfe-tiempo-real: `custom_components/renfe_tiempo_real/api.py`, `tests/fixtures/flota.json`
- StructuralWizard/TrainRadar: `docs/data-sources.md`, `crates/engine/src/renfe.rs`
- ComputingVictor/Renfetraso: `app.js`, README
- lexisphoenix/canitren: `docs/INVESTIGATION.md`
- knoopx/rodalies-wearos: `RodaliesRepository.kt`
- vicinaehq/extensions: `extensions/rodalies/src/types.ts`
- AngelMariages/RodaliesWidget; Mapaor/horaris-rodalies
- FlorinTodor/radar-es: `docs/prompt-cowork-fuentes.md`
- iscle/Adif_Unofficial: Elcano DTOs and `CirculationService.kt`
- rubenbupe/adif-panel-configurator: `GravitaWrapper.tsx`; mariomnts/pantallas-estaciones: `format.ts`
- Some1sm/Arribo: `docs/catalonia-review/DATA_REQUESTS.md`, `docs/research/MOVENTIS_SOURCES.md`
- wonx/rodalies-tracker; Ellaymat/Tresnes (`api/api/flota.js`)

**Web (search summaries only):**
- rodalies.gencat.cat "tipus de trens" pages (Civia, 450, 447/470, 449) and the 452 homologation article
- es/en Wikipedia: Serie 447, Civia, Serie 452, R-line articles
- Vía Libre material sheets; trenvista.net (452, 465 transfers)
- railvolution.net (Class 453 Madrid; financing of the Catalan EMUs)
- lamoncloa.gob.es: Stadler in service 2026-08, new Cercanías app 2026-07-30, 2025 note "101 units for Catalonia: 49 Alstom + 20 Stadler + 32 CAF"
- metropoliabierta / elespanol (2026-09: 452 homologation in its final phase, service Q1 2027)
- ara.cat / naciodigital / govern.cat (124 new trains plan; Rodalies de Catalunya SME, 50.1% Renfe / 49.9% Generalitat, constituted January 2026)
- xatakamovil (Rodalies app lacks occupancy)
- listadotren.es (per-unit records)
