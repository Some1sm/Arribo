# Moventis Open Data Sources Research (Catalonia)

> **Checked by Claude on 2026-11-23** (independently of the research agent's own VERIFIED/UNVERIFIED labels below):
> - The Generalitat interurban GTFS (`busos-interurbans-GTFS.zip`, 24 MB) downloads without a key. It has 110 operators, 934 routes and shapes, with the calendar running to 2027-06-30. "Empresa Casas, SA" (agency 42671) runs all seven Mataró lines: L0498 (C10), L0501 (C20), L0495 (C30), L0496 (e11.1), L0497 (e11.2), L0502 (865) and L0109 (N80). Trips carry a shape_id.
> - Its `stop_code` matches the `COD_PARADA` of Moventis's own API for 83 of C-10's 88 stops, with the same coordinates. So Moventis's live predictions can be joined to the official timetable.
> - The T-mobilitat open trip-updates feed (`/opendata/trip_updates/json/user/token/open`) answers, at 282 KB. Its vehicle-positions URL returns 404.
> - Moventis's page "Com aconseguir les dades GTFS de Moventis" exists.
> - Not checked: the licence wording, the NAP datasets, the ATM CGIM registration and the AMB static GTFS contents.

**Date verified:** 2026-11-23  
**Scope:** Official and open data sources for Moventis bus networks in Catalonia—exact timetables, stops, route shapes (`shapes.txt`), and real-time vehicle positions / trip updates / alerts.  
**Priority lines (Empresa Casas, Maresme / Mataró):** `C-10`, `C-20`, `C-30`, `e11.1`, `e11.2`, `865`, `N-80`.  
**Secondary scope (rest of Moventis Catalonia, ~161 lines):** Sarbus / La Vallesana / Marfina Bus (Vallès Occidental), Sarfa (Girona / Costa Brava), TCC Barcelona (Barcelona / El Prat / Sant Sadurní / Sitges), Autobusos de Lleida, Pujol / Moventis Costa, and Moventis Llobregat / Port / Cerdanyola (AMB).

---

## Executive Summary

1. **Static timetables, stops, and road-accurate `shapes.txt` ARE already openly available today—no scraping required:**
   - **Priority 7 Mataró / Casas lines + 97 more Moventis interurban lines (104 routes total):** Direct, unauthenticated GTFS ZIP from **Generalitat de Catalunya (DGTM)** (`busos-interurbans-GTFS.zip`, 24.1 MB, updated `2026-11-23`, 100% `shape_id` coverage on all 7 priority lines).
   - **Moventis Llobregat, Port de Barcelona, and Cerdanyola (22 AMB-contracted routes):** Direct, unauthenticated daily GTFS ZIP from **AMB** (`ambmobilitat.cat/OpenData/google_transit.zip`, 8.1 MB, updated `2026-11-23`, 100% `shape_id` coverage).
   - **All ~161 Moventis lines (including urban Autobusos de Lleida, TCC, Pujol/Costa, Sarbus urban, Sarfa urban, and native Casas):** Available as clean per-subsidiary GTFS ZIPs from **Spain's NAP** (`nap.transportes.gob.es`, free API key) and unified daily in **ATM / T-mobilitat CGIM** (`t-mobilitat.cat`, free registration token).
2. **Real-time open data is split cleanly into two tiers:**
   - **AMB-contracted Moventis lines (22 routes: Llobregat, Port, Cerdanyola) HAVE open, unauthenticated GTFS-RT `TripUpdates` and `Alerts` right now** via **ATM / T-mobilitat** (`https://t-mobilitat.cat/opendata/trip_updates/[json/]user/token/open`). Verified live on `2026-11-23` matching Moventis lines `L20`, `L21`, `LH1`, `LH2`, and `PR1`.
   - **Non-AMB Moventis lines (including all 7 priority Casas/Mataró lines, Sarbus, Sarfa, Lleida, TCC, Pujol) have NO public GTFS-RT or SIRI feed** on Generalitat, ATM/T-mobilitat, NAP, or municipal portals. Neither T-mobilitat nor AMB publishes `VehiclePositions` (GPS coordinates).
   - **Moventis's own developer program** (`moventis.es/ca/eines-desenvolupadors`) explicitly states that it supplies weekly GTFS and real-time transport data to approved third-party platforms (as done for Google Transit since 2017), gated behind a formal request form.

---

## Comparison Matrix

| Source | Auth / Cost | Format | Stops / Timetables / Shapes | Priority 7 Casas Lines | Rest of Moventis | Real-Time (Positions / Predictions / Alerts) | Verified Freshness (2026-11-23) | Licence |
|---|---|---|---|---|---|---|---|---|
| **1. Generalitat DGTM Interurban GTFS** (`territori.gencat.cat`) | None (direct URL) | GTFS ZIP (24.1 MB) | Yes / Yes / Yes (99.96%, 72 MB `shapes.txt`) | **All 7** (100% shapes) | **Interurban only** (104 routes: Casas, Vallesana, Marfina, Sarfa, Ruri/Costa, joint) | **None** | `Last-Modified: 2026-11-23` (valid `2026-01-01`–`2027-06-30`) | *Llicència oberta d'ús d'informació – Catalunya* (attribution) |
| **2a. ATM / T-mobilitat CGIM Static GTFS** (`t-mobilitat.cat`) | Free portal registration (token) | GTFS ZIP (`completa` & `simplificada`) | Yes / Yes / Yes (`simplificada` keeps shape-bearing variant) | **All 7** (`CAS_` & `GEN_`) | **All** (`CAS`, `SAB`, `SAA`, `PUJ`, `TCC`, `LLE`, `AMB`, `GEN`) | See 2b | `creationDate: 23.11.26` (**Daily**) | Ley 37/2007 open reuse (attribution + update date) |
| **2b. ATM / T-mobilitat CGIM GTFS-RT** (`t-mobilitat.cat/opendata/.../open`) | **None** (`/user/token/open`) | GTFS-RT Protobuf & JSON | N/A (joins to static GTFS `trip_id`) | **No** (`CAS`/`GEN` RT = NO) | **AMB Moventis only** (22 routes: Llobregat, Port, Cerdanyola) | **TripUpdates + Alerts** (NO `VehiclePositions` — HTTP 404) | **Live** (`2026-11-23`, 494 active trip updates) | Ley 37/2007 open reuse |
| **3a. AMB Open Data Static GTFS** (`ambmobilitat.cat`) | None (direct URL) | GTFS ZIP (8.1 MB) | Yes / Yes / Yes (100%, 8.9 MB `shapes.txt`) | **No** (outside AMB) | **22 AMB routes** (Llobregat 14, Port 3, Cerdanyola 5) | Pair with 2b (`AMB_` prefix) | `Last-Modified: 2026-11-23` (**Daily**, rolling 6-day window) | Open public sector reuse (AMB) |
| **3b. TMB Developer Portal** (`developer.tmb.cat`) | Free `app_id` / `app_key` | GTFS + REST API | TMB Metro/Bus only | **No** | **No** (0 Moventis lines) | TMB only | Active | TMB Open Data terms |
| **4. Spain NAP (`nap.transportes.gob.es`)** | Free account + `ApiKey` header | GTFS ZIP (per-operator + regional) | Yes / Yes / Operator-dependent | **All 7** (file `1578` Casas + `1364`/`2060`) | **All 6 native feeds** (`1576`–`1581`) + ATM (`2059`/`2060`) | **None** for Moventis (static MMTIS) | Operator-maintained (API-gated; not downloadable without key) | MITRAMS *Licencia de datos abiertos* (commercial OK, attribution) |
| **5a. Mou-te (`mou-te.gencat.cat`)** | N/A | Web planner / widget only | Exports to Source #1 | Via Source #1 | Interurban via Source #1 | No public API | N/A | N/A |
| **5b. Moventis Developer Portal** (`moventis.es`) | Manual approval form (NIF + app details) | GTFS (weekly) + RT (unspecified spec) | Yes / Yes / Yes (documented) | **All 7** | **Full Moventis network** | Claims *"dades del transport en temps real"* on approval | Documented weekly GTFS | Private bilateral approval |
| **6. Aggregators** (Mobility Database, Transitland, OpenMobilityData, `datos.gob.es`) | Varies | Mirrors / Catalogs | Catalogs Source #1 & #4 | NAP mirrors **404**; Gencat mirror **5.5 mo stale** | NAP mirrors **404** | None | **Unreliable / Stale / Shutdown** | Upstream licences |
| **7. Municipal Portals** (Mataró, Sabadell, Terrassa, Girona, Lleida, ATMs) | None | N/A | **No Moventis GTFS published** | **No** | **No** | **No** | N/A | N/A |

---

## Detailed Source Assessments

### 1. Generalitat de Catalunya Interurban Bus Open Data (DGTM / Departament de Territori)

* **Direct GTFS URL:** `https://territori.gencat.cat/web/.content/home/serveis/visors-cartografia/bases-cartografiques/infraestructures-mobilitat/autobusos-interurbans/busos-interurbans-GTFS.zip`
* **Catalog metadata page (Socrata):** `https://analisi.transparenciacatalunya.cat/d/bca2-b4i3` (*"Xarxa de transport per carretera: parades, línies i horaris dels autobusos interurbans de Catalunya"*)
* **Format & contents:** Standard static GTFS ZIP (`24,085,885` bytes), containing `agency.txt` (110 agencies), `stops.txt` (917 KB), `routes.txt` (934 routes), `trips.txt` (29,701 trips), `stop_times.txt` (24.1 MB), `calendar.txt` (443 services), `calendar_dates.txt` (64,739 exception rows), `shapes.txt` (72.0 MB; **29,688 / 29,701 trips = 99.96%** carry a `shape_id`), plus a non-standard `nota.txt` (377 KB of service footnotes).
* **Authentication & licence:** **No authentication or registration.** Covered by the *Llicència oberta d'ús d'informació – Catalunya* (`https://web.gencat.cat/ca/generalitat/dades-indicadors/dades-obertes/llicencies`): permits worldwide, perpetual commercial and non-commercial reuse, distribution, and derivative works, provided the data is not altered/distorted and attribution reads `Generalitat de Catalunya`.
* **Freshness & validity (verified `2026-11-23`):**
  * HTTP `Last-Modified: Mon, 23 Nov 2026 10:22:28 GMT` (internal ZIP timestamps `2026-11-20`).
  * Calendar validity spans **`2026-01-01` to `2027-06-30`**.
  * Socrata metadata states *"Mensual"* cadence, though the direct ZIP on `territori.gencat.cat` is refreshed frequently (updated within days of our probe).
* **Coverage of the 7 priority Maresme / Empresa Casas lines (100% present, 100% `shape_id`):**
  * `route_id=0498` (`L0498`) — `(C10) Mataró - Barcelona per la N-II` — 78 trips (78 with shape), e.g., 45 stops per trip
  * `route_id=0501` (`L0501`) — `(C20) St.Vicenç de Montalt-Llavaneres-Mataró` — 42 trips (42 with shape)
  * `route_id=0495` (`L0495`) — `(C30) Vilassar de Dalt - Mataró` — 57 trips (57 with shape)
  * `route_id=0496` (`L0496`) — `(e11.1) Barcelona - Mataró (pl.Tereses)` — 268 trips (268 with shape)
  * `route_id=0497` (`L0497`) — `(e11.2) Barcelona - Mataró Nord` — 170 trips (170 with shape)
  * `route_id=0502` (`L0502`) — `(865) Mataró - Campus UAB` — 29 trips (29 with shape)
  * `route_id=0109` (`L0109`) — `(N80) Barcelona - Mataró (SN)` — 6 trips (6 with shape)
* **Coverage of the rest of Moventis (104 routes across 9 legal entities in `agency.txt`):**
  * `42671` **Empresa Casas, SA** (22 routes: all 7 priority lines + `C12`–`C22`, `803/804/805`, `806`, `807/C9`, `862`, `N81`)
  * `42557` **Empresa Sagalés, SA i Empresa Casas, SA** (2 joint routes: `808`, `849`)
  * `42673` **La Vallesana, SA** [Sarbus] (8 routes: `C1`–`C5`, `C7`, `e1`, `N65`)
  * `42674` **Marfina Bus, SA** [Sarbus] (28 routes: `A1`, `A2`, `A4`, `A6`, `A7`, `B1`–`B9`, `e2.1`, `e2.2`, `e3`, `LB1`, `SJ`, `N61`, `N64`, `N66`, `N67`, Bellaterra–Cerdanyola, plus 4 Lleida interurban routes)
  * `42582` **Autocares R. Font, SAU i Marfina Bus, SA** (2 joint routes: `648`, `N62`)
  * `42628` **SARFA SL** (34 routes: Costa Brava / Girona / Empordà / Barcelona / Airports / `e3` / `e6` / night)
  * `42742` **Barcelona Bus SL i SARFA** (1 joint route: Tossa–Lloret–Girona Airport)
  * `42555` **Miguel Gamon, SL/Autobusos de Lleida, SA** (2 night routes: `NL1`, `NL2`)
  * `42737` **Circuitos Ruri SLU** (7 routes: Blanes–Lloret–Tossa–Malgrat–Palafolls, incl. `1361`, `L4M`, `L5`)
  * **Not covered:** Municipal urban Moventis concessions (Autobusos de Lleida urban, TCC Barcelona/El Prat/Sitges/Sant Sadurní, Sant Cugat/Cerdanyola/L'Hospitalet urban, and AMB-contracted Moventis Llobregat).
* **Real-time availability:** **None.** A live catalog query on `analisi.transparenciacatalunya.cat` confirms that the Generalitat open data portal publishes GTFS-RT only for **FGC** (`y6iv-pycv` VehiclePositions, `9y7v-5ajc` TripUpdates), not for interurban buses.
* **Data-quality caveats (verified from ZIP contents):**
  1. `route_short_name` uses internal DGTM numeric codes (`L0498`, `L0496`), while rider-facing codes are embedded inside `route_long_name` (e.g., `(C10) Mataró - Barcelona per la N-II`, `(e11.1) Barcelona - Mataró (pl.Tereses)`). Arribo! must parse the leading parenthesized code or map by `route_id`.
  2. `stop_times.txt` has **non-zero seconds** (e.g., `08:15:07`, `08:17:07` on `C10`; `11:20:59` on `e11.1`; `00:05:41` on `N80`) and **no `timepoint` column**. This reflects Mou-te's internal speed/distance schedule export; origin departure minutes should be rounded/normalized carefully and cross-checked against Moventis published timetables before treating intermediate times as hard timepoints.
  3. Stop IDs use DGTM's `PF` codes (e.g., `PF08121097`) with numeric `stop_code` (e.g., `7090`) and full WGS84 coordinates. Matching against `moventis.es` "Temps real" stop IDs requires a crosswalk (by `stop_code` / coordinate + name).
  4. Non-standard `nota.txt` holds service remarks (e.g., school days, demand-responsive notes) not expressed solely via `calendar_dates.txt`.

---

### 2. ATM Àrea de Barcelona / T-mobilitat CGIM Open Data Portal

* **Portal & catalog:**
  * Main catalog & prefix table: `https://t-mobilitat.cat/web/t-mobilitat/datos-abiertos/catalogo-de-datos`
  * Static GTFS (deduplicated, prefers shape-bearing source): `https://t-mobilitat.cat/web/t-mobilitat/dades-obertes/cataleg-dades/informacio-estatica`
  * Static GTFS (complete/raw with all source prefixes): `https://t-mobilitat.cat/web/t-mobilitat/dades-obertes/cataleg-dades/informacio-estatica-cru`
  * Technical metadata JSON (open, verified HTTP 200):
    * `https://t-mobilitat.cat/opendata/static/ficha/tecnica/ca`
    * `https://t-mobilitat.cat/opendata/static/ficha/tecnica/WBL/ca`
  * Static download & registration API (from frontend bundle `opendatafront/static/js/main.b0c7282d.chunk.js`):
    * Registration endpoint: `POST https://t-mobilitat.cat/opendata/static/register/request/` (issues personal token)
    * Download URLs (require issued token; `/user/token/open` returns `404` for static): `https://t-mobilitat.cat/opendata/static/download/{token}` and `.../download/WBL/{token}`
  * **Live GTFS-RT endpoints (NO AUTH REQUIRED — verified HTTP 200 on `2026-11-23`):**
    * TripUpdates (Protobuf): `https://t-mobilitat.cat/opendata/trip_updates/user/token/open`
    * TripUpdates (JSON): `https://t-mobilitat.cat/opendata/trip_updates/json/user/token/open`
    * Service Alerts (Protobuf): `https://t-mobilitat.cat/opendata/alerts/user/token/open`
    * Service Alerts (JSON): `https://t-mobilitat.cat/opendata/alerts/json/user/token/open`
    * `vehicle_positions` (`/opendata/vehicle_positions/[json/]user/token/open`): **HTTP 404 (not published).**
* **Format & contents:** Catalonia-wide unified static GTFS (updated **daily**: `{"creationDate":"23.11.26","uploadFrecuency":"Diaria","geografico":"Cataluña","licence":"Autorización según la ley 37/2007"}`), plus live GTFS-RT `TripUpdates` and `Alerts` (both Protobuf and JSON).
* **Moventis coverage in the official CGIM Prefix Table (all Moventis subsidiaries are integrated!):**
  * `CAS` — **CASAS** (*Línies interurbanes al Maresme amb destí Barcelona*) — **RT: NO**
  * `SAB` — **SARBUS** (*Línies de bus interurbà de la Generalitat (Lleida i Barcelona), Urbà de Cerdanyola, L'Hospitalet de Llobregat, Sant Cugat del Vallès*) — **RT: NO**
  * `SAA` — **SARFA** (*Línies interurbanes a la Costa Brava–Girona, Urbans a Palamós, Calonge, Castell d'Aro, Platja d'Aro, S'Agaró, Santa Cristina, Sant Feliu, Figueres, Roses, Cadaqués*) — **RT: NO**
  * `PUJ` — **MOVENTIS COSTA** (*Línies de bus interurbà de Blanes, Lloret, Malgrat, Palafolls, Santa Susanna i Tossa; Urbà de Palafolls*) — **RT: NO**
  * `TCC` — **TCC** (*Urbans Barcelona, El Prat de Llobregat, Sant Sadurní d'Anoia i Sitges*) — **RT: NO**
  * `LLE` — **AUTOBUSOS DE LLEIDA** (*Servei de bus urbà de Lleida*) — **RT: NO**
  * `AMB` — **AMB** (explicitly lists **Moventis** and **Moventis (Port)** alongside TUSGSAL, Avanza, Monbus, Soler i Sauret, TGO) — **RT: SI**
  * `GEN` — **Generalitat de Catalunya (DGTM)** (also includes Empresa Casas, La Vallesana, Marfina Bus, SARFA) — **RT: NO**
* **Live GTFS-RT verification (`2026-11-23` ~23:15 CET):**
  * `trip_updates` returned **494 active trip entities** across exactly 4 prefixes: `AMB` (275), `TMB` (161), `FGC` (29), `ROD` (29).
  * `alerts` returned **550 active alerts** across 3 prefixes: `AMB` (485), `TMB` (51), `ROD` (14).
  * Cross-matching the 275 live `AMB_` trip IDs directly against AMB's static `trips.txt` confirmed **live `TripUpdates` for agency `69: Moventis`** (7 active evening trips at 23:17 CET on lines **`L20`, `L21`, `LH1`, `LH2`, `PR1`**; daytime AMB Moventis lines emit updates during service hours).
  * **Zero** live `CAS_`, `GEN_`, `SAB_`, `SAA_`, `PUJ_`, `TCC_`, or `LLE_` entities exist in `trip_updates` or `alerts`.
* **Authentication & licence:** Static GTFS requires a free one-time form registration via T-mobilitat; GTFS-RT `trip_updates` and `alerts` are open with no key. Reusable free of charge under Ley 37/2007 (do not alter/distort meaning, cite source, state last-update date).
* **Caveats:** The simplified feed deduplicates overlapping `CAS_` vs `GEN_` lines by keeping whichever source has `shapes.txt`; Arribo! should check after registering whether `CAS_` (operator-native Casas codes) or `GEN_` (DGTM codes) is kept in `simplificada`, or pull `completa` (`WBL`) and select prefixes explicitly. No GPS `VehiclePositions` are published even for `AMB`.

---

### 3. AMB (Àrea Metropolitana de Barcelona) and TMB Open Data Portals

#### 3a. AMB (`ambmobilitat.cat` / `amb.cat`)
* **Direct static GTFS URL (NO AUTH, verified HTTP 200):** `https://www.ambmobilitat.cat/OpenData/google_transit.zip`
* **Freshness & contents (verified `2026-11-23`):**
  * `Last-Modified: Mon, 23 Nov 2026 11:18:50 GMT`, `8,076,904` bytes (21 files, internal timestamps `2026-11-23 02:17`).
  * `feed_info.txt`: `AMBMobilitat`, `feed_start_date=20261123`, `feed_end_date=20261128`, `feed_version=20261123`.
  * **100% shape coverage:** `29,823 / 29,823` trips have a `shape_id` (`shapes.txt` = 8.85 MB). Also includes GTFS-Fares v2 (`areas.txt`, `fare_products.txt`, `fare_leg_rules.txt`).
* **Moventis coverage (22 routes across 3 AMB agencies):**
  * `agency_id=69` — **Moventis** (14 routes — Moventis Llobregat / L'Hospitalet / El Prat): `L16, L20, L21, L22, LH1, LH2, M12, M14, M15, PR1, PR2, PR3, PR5, X30`
  * `agency_id=74` — **Moventis (Port)** (3 routes): `88, 89, PR4`
  * `agency_id=79` — **Moventis (Cerdanyola)** (5 routes): `CV1, CV2, CV3, CV4, CV5`
  * *Clarification:* Baix Llobregat lines `L80, L82, L85, L86, L88, L94–L99, N12–N18, X95, X97` are operated by **Avanza** (`agency_id=56`), not Moventis.
  * **Does NOT cover** the 7 priority Mataró / Empresa Casas lines (outside AMB bus concessions) or Sarbus interurban, Sarfa, Lleida, Pujol, or non-AMB TCC lines.
* **Real-time:** AMB supplies GTFS-RT `TripUpdates` (stop-level arrival/departure predictions, no vehicle GPS) and `Alerts`, openly relayed through ATM/T-mobilitat (`AMB_` prefix; see §2). Note that `https://www.amb.cat/...` web pages return Cloudflare `403` to non-browser clients, while `https://www.ambmobilitat.cat/OpenData/google_transit.zip` downloads cleanly with HTTP `200`.
* **Caveat:** Because `feed_info.txt` covers a **rolling 6-day horizon** (`2026-11-23` to `2026-11-28`), Arribo! must refresh this ZIP daily (or at least every 2–3 days).

#### 3b. TMB (`developer.tmb.cat` / `api.tmb.cat`)
* **Endpoints:** `https://api.tmb.cat/v1/static/datasets/gtfs.zip` (returns `401` without free `app_id` & `app_key` from `https://developer.tmb.cat/`).
* **Moventis coverage:** **Zero.** TMB covers only Barcelona Metro and TMB urban buses (plus tourist bus/tram/funicular). Irrelevant for Moventis ingestion, though already integrated in T-mobilitat GTFS-RT (`TMB_`).

---

### 4. Spain's National Access Point (`nap.transportes.gob.es` / NAP)

* **Portal & API:** `https://nap.transportes.gob.es/` (download API: `https://nap.transportes.gob.es/api/Fichero/download/{fileId}`, catalog: `https://nap.transportes.gob.es/ConjuntoDato/List`).
* **Authentication & licence:**
  * Requires free registration at `nap.transportes.gob.es` to obtain an `ApiKey` header (verified: unauthenticated requests to `/api/Fichero/download/1578` and `/api/Fichero/GetList` return `401 Api Key was not provided`).
  * Licence (`https://nap.transportes.gob.es/licencia-datos`): **Licencia de datos abiertos del Ministerio de Transportes y Movilidad Sostenible (LDA)** — explicitly permits **commercial and non-commercial reuse** under Spanish Law 37/2007 / 18/2015, subject to attribution and non-distortion.
* **Confirmed Moventis & Catalonia static GTFS file IDs on NAP (verified via Mobility Database catalog entries pointing directly to NAP):**
  * **`1578`** — **Moventis Empresa Casas** (*Casas Company Buses*) — native Casas GTFS (all 7 priority Mataró lines + Maresme)
  * **`1581`** — **Moventis Sarbus** (*Autobuses Sarbus – La Vallesana*, includes Marfina Bus Vallès Occidental)
  * **`1576`** — **Moventis Sarfa** (*Sarfa buses*, Girona / Costa Brava)
  * **`1580`** — **TCC Barcelona** (*TCC Barcelona Buses*)
  * **`1579`** — **Autobusos de Lleida** (*Lleida urban buses*)
  * **`1577`** — **Pujol** (*Moventis Costa*)
  * **Regional / other relevant NAP IDs:** `1364` (Generalitat interurban), `2060` (ATM Catalonia full), `2059` (ATM Catalonia simplified), `1173` (Avanza Mataró Bus), `1175` (TMESA Terrassa), `1570` (TMG Girona).
  * *Note on Transgrup / Marfina:* No standalone Transgrup or Marfina Bus NAP file was found; Marfina Bus lines are included inside Sarbus (`1581`) and Generalitat (`1364`), while Moventis Llobregat is published under AMB (§3a) and ATM (`2059`/`2060`).
* **Real-time availability:** **None for Moventis.** Spain's NAP is primarily a static MMTIS repository (GTFS / NeTEx); no Moventis GTFS-RT or SIRI feed is published there.
* **Why NAP matters despite requiring an API key:** File `1578` (Casas) and `1576`–`1581` are **operator-native Moventis exports**, meaning they should carry Moventis's own commercial route codes (`C-10`, `e11.1`), stop IDs, and urban networks (`1579` Lleida, `1580` TCC, `1577` Pujol) that are absent from the Generalitat interurban ZIP. Because our probe had no NAP API key, exact `shapes.txt` completeness and update dates inside files `1576`–`1581` could not be inspected directly and must be verified once Arribo! registers a free NAP key.

---

### 5. Mou-te (Generalitat App) and Moventis Official Developer Program / App

#### 5a. Mou-te (`mou-te.gencat.cat`)
* **Documented API:** **None.** The Generalitat documents only web widgets and URL deep-linking for embedding the Mou-te route planner in external websites; there is no public third-party routing, timetable, or real-time REST API.
* **Published feed it uses:** The Generalitat's own Socrata record (`bca2-b4i3`) explicitly confirms that `busos-interurbans-GTFS.zip` (Source #1) is exported directly from Mou-te's underlying database (*"Dades provinents del cercador de rutes Mou-te"*).

#### 5b. Moventis Official Developer Portal & Mobile App (`moventis.es`)
* **Verified official pages:**
  * Developer overview (HTTP 200): `https://www.moventis.es/ca/eines-desenvolupadors`
  * Access request form (HTTP 200): `https://moventis.es/ca/com-aconseguir-les-dades-gtfs-de-moventis`
* **What Moventis officially documents:**
  * *"Moventis col·labora amb desenvolupadors d'aplicacions i plataformes d'informació, i **facilitem les dades del transport en temps real**."*
  * **Static GTFS:** Updated **weekly**, containing service schedules, stop passing times, stop coordinates/codes/names, line codes/names/colors, and route coordinate sequences (`shapes.txt`). Verified by Moventis and supplied to Google Transit since 2017.
  * **Real-time / App:** Moventis publishes no public API specification, endpoint URL, or self-service portal for its mobile app (iOS/Android since 2016) or for the *"dades del transport en temps real"* referenced on `eines-desenvolupadors`.
* **Access barrier:** Both GTFS and any real-time partnership require submitting a manual webform (`Nombre`, `Apellidos`, `NIF/Pasaporte`, `Nacionalidad`, `Dirección`, `Teléfono`, `Email`, `Nombre de la aplicación`, `Descripción`, optional PDF). **This is the only documented official path to obtain real-time feeds (GTFS-RT or SIRI) for Casas (`C-10`, `e11.1`, etc.), Sarbus, Sarfa, Lleida, TCC, and Pujol.**

---

### 6. Transit Data Aggregators

* **Mobility Database (`mobilitydatabase.org`):**
  * Catalogs all 6 Moventis NAP feeds (`mdb-2754` Casas, `mdb-2755` Sarbus, `mdb-2764` Sarfa, `mdb-2749` TCC, `mdb-2750` Pujol, `mdb-2753` Lleida), plus Gencat NAP (`mdb-2796`), ATM NAP (`mdb-2826` full, `mdb-2832` simplified), and Gencat direct (`mdb-2926`).
  * **Critical live audit (`2026-11-23`):**
    * **All 9 NAP-backed Mobility Database mirrors (`mdb-2749`–`2832`) return HTTP `404`** on `storage.googleapis.com/storage/v1/b/mdb-latest/o/...` because Mobility Database cannot fetch `ApiKey`-protected NAP URLs into its public mirror bucket.
    * The direct Gencat mirror (`mdb-2926`, `es-catalonia-autobusos-interurbans-gtfs-2926.zip`) returns HTTP `200`, **but `Last-Modified: Thu, 04 Jun 2026`**—nearly **6 months stale** compared to Gencat's live `2026-11-23` file!
  * **Verdict:** Useful only as a discovery index for NAP file IDs; **never ingest from `mdb-latest` mirrors.**
* **Transitland (`transit.land` / `transitland-atlas`):**
  * Audited `transitland/transitland-atlas` (`main` tree) directly: Catalonia feeds are limited to **TMB** (`f-sp3e-tmb`), **FGC** (`f-fgc~cat`), and **Renfe** (`f-ez-renfeoperadora`, `f-cercanías~renfe~rt`). **Zero Moventis, Gencat interurban, AMB, or ATM CGIM feeds.**
* **OpenMobilityData / TransitFeeds (`openmobilitydata.org`):**
  * Officially **shut down / deprecated** in favor of Mobility Database (`openmobilitydata.org` returned HTTP `403`). Do not use.
* **`datos.gob.es`:**
  * National metadata catalog; live queries for `moventis`, `mataro`, `sabadell`, and `girona` returned **no Moventis GTFS resources**. Spanish public transport GTFS feeds are consolidated in **NAP** (§4) rather than hosted on `datos.gob.es`.

---

### 7. Municipal & Territorial Open Data Portals

Probed live on `2026-11-23`:
* **Mataró** (`dadesobertes.mataro.cat`), **Sabadell** (`opendata.sabadell.cat`, `tus.es`), **Terrassa** (`opendata.terrassa.cat`, `tmesa.com`), **Girona** (`dadesobertes.girona.cat`, `web2.girona.cat/tmg/`), **Lleida** (`dadesobertes.paeria.cat`, `autobusosdelleida.cat`), **ATM Lleida** (`atmlleida.cat`), and **ATM Girona** (`atmgirona.cat`).
* **Result:** **None** of these portals expose a downloadable Moventis GTFS or real-time feed directly.
* **Network-ownership clarification:** Urban bus services in Mataró (Avanza, NAP `1173`), Sabadell (TUS cooperative, CGIM `TUS`), Terrassa (TMESA, NAP `1175`), and Girona city (TMG, NAP `1570`) are **not** Moventis. The urban services that **are** Moventis—Autobusos de Lleida, TCC (El Prat/Sitges/Sant Sadurní/Barcelona), Cerdanyola, L'Hospitalet, Sant Cugat, Malgrat/Palafolls—are instead published centrally through **NAP (`1577`–`1581`)**, **ATM / T-mobilitat CGIM (`LLE`, `TCC`, `SAB`, `PUJ`, `AMB`)**, and **AMB (`google_transit.zip`)**.

---

## Concrete Recommendation: What Arribo! Should Integrate First

### Phase 1 — Immediate, Zero-Auth Static + AMB Real-Time Wins (Can ship immediately)
1. **Integrate Generalitat DGTM Interurban GTFS (`busos-interurbans-GTFS.zip`) for all 7 priority Mataró/Casas lines (`C-10`, `C-20`, `C-30`, `e11.1`, `e11.2`, `865`, `N-80`) + 97 more Moventis interurban lines:**
   * Gives Arribo! official stops, coordinates, calendar validity through `2027-06-30`, and **100% road-accurate `shapes.txt`** immediately with zero registration and a clean open licence (`Generalitat de Catalunya`).
   * **Keep the existing `moventis.es` "Temps real" per-stop scraper ONLY for live arrival predictions** on Casas / non-AMB lines, and join those stop predictions onto the Gencat stops/shapes/timetables so estimated vehicle positions follow exact road geometry and official schedules instead of approximate stop-to-stop paths. Label these transparently as `predicted` (never `measured` GPS).
   * Handle the two verified Gencat quirks at the loader boundary: (a) extract public route codes from `route_long_name` (or pin `route_id` map: `0498`=C-10, `0501`=C-20, `0495`=C-30, `0496`=e11.1, `0497`=e11.2, `0502`=865, `0109`=N-80), and (b) normalize/audit the non-zero seconds in `stop_times.txt` against published Casas timetables.
2. **Integrate AMB Static GTFS (`ambmobilitat.cat/OpenData/google_transit.zip`, daily refresh) + ATM/T-mobilitat Open GTFS-RT (`trip_updates` & `alerts` at `/user/token/open`) for the 22 AMB-contracted Moventis lines (`69: Moventis`, `74: Moventis (Port)`, `79: Moventis (Cerdanyola)`):**
   * **Retires scraping completely** for Moventis Llobregat (`L16, L20–L22, LH1, LH2, M12, M14, M15, PR1–PR3, PR5, X30`), Port (`88, 89, PR4`), and Cerdanyola (`CV1–CV5`).
   * Gives daily static timetables + 100% `shapes.txt` + **live GTFS-RT `TripUpdates` and `Alerts`** with zero auth. Remember that AMB GTFS-RT provides stop arrival predictions (`predicted` tier), not raw GPS `VehiclePositions`.

### Phase 2 — Full 161-Line Moventis Static Coverage (Free API Key / Token)
3. **Register for Spain NAP (`nap.transportes.gob.es`) and/or ATM T-mobilitat CGIM (`t-mobilitat.cat`):**
   * **Recommended first between the two: ATM / T-mobilitat CGIM static GTFS (`completa` / `WBL` or `simplificada`)**, because it updates **daily** (`23.11.26`), uses one uniform schema/prefix set (`CAS`, `SAB`, `SAA`, `PUJ`, `TCC`, `LLE`, `AMB`, `GEN`) covering **all ~161 Moventis lines** (including urban Lleida, TCC, Pujol, Sarbus urban, and Sarfa urban missing from Gencat), and aligns 1:1 with T-mobilitat's open GTFS-RT `trip_id` prefixes.
   * **Use Spain NAP (`1578` Casas, `1581` Sarbus, `1576` Sarfa, `1580` TCC, `1579` Lleida, `1577` Pujol)** as a direct operator-native audit/source—especially to compare native Casas (`1578`) against Gencat (`0498`/`0496`/etc.) for cleaner `stop_times.txt` rounding and `moventis.es` stop-code matching.

### Phase 3 — Official Real-Time Access for Maresme / Casas & Non-AMB Moventis
4. **Submit Moventis's official developer form (`https://moventis.es/ca/com-aconseguir-les-dades-gtfs-de-moventis`):**
   * Because **no open government portal** currently publishes GTFS-RT or SIRI for Empresa Casas, Sarbus, Sarfa, Lleida, TCC, or Pujol, formally requesting access via Moventis's developer program (explicitly asking for both their weekly GTFS and the real-time feed referenced on `eines-desenvolupadors`, ideally `GTFS-RT VehiclePositions` + `TripUpdates` or SIRI-VM) is the only official route to retire the `moventis.es` "Temps real" scraper and upgrade Maresme buses from scraped predictions to an official feed.
