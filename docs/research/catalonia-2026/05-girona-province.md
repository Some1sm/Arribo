# E. Public bus transport in the province of Girona: operators, real-time and static data

**Research date:** 2026-11-24 · **Scope:** research only, no application code
**Author:** research sub-agent for Arribo!

## 0. Read this first: what was and was not verified

This session's network policy **blocked every official transit host**. Both `curl` (proxy CONNECT 403) and WebFetch (DNS ENOTFOUND) failed for:
`territori.gencat.cat`, `analisi.transparenciacatalunya.cat`, `web2.girona.cat`, `www.girona.cat`, `umat.girona.cat`, `dadesobertes.girona.cat`, `nap.transportes.gob.es`, `t-mobilitat.cat`, `www.sagales.com`, `www.moventis.es`, `www.teisa-bus.com`, `www.atmgirona.cat`, `mobilitat.gencat.cat`, `www.transit.land`, `mobilitydatabase.org`, `files.mobilitydatabase.org`, `www.polisnetwork.eu`.

The direct Generalitat GTFS download therefore **failed** (`territori.gencat.cat` refused, 403). I worked around this as follows:

| What | Status | How |
|---|---|---|
| Generalitat interurban GTFS, filtered to Girona | **VERIFIED-TODAY (mirror copy)** | Mobility Database mirror `storage.googleapis.com/storage/v1/b/mdb-latest/o/es-catalonia-autobusos-interurbans-gtfs-2926.zip?alt=media`. HTTP 200, 22.99 MB, `Last-Modified: Thu, 04 Jun 2026`. Files inside are dated 2026-03-17/18 and the calendar runs **2026-01-01 → 2026-06-30**, so it is stale. Route and stop inventory is valid; dates are not. |
| Generalitat GTFS, Feb-2026 copy | VERIFIED-TODAY (mirror) | GitHub `OSM-Catalan/tpcatvsosm/gtfs_cat_interurba_bus` (commit 2026-02-16) |
| ATM / T-mobilitat CGIM "completa" GTFS (all prefixes) | VERIFIED-TODAY (mirror, Feb 2026) | GitHub `OSM-Catalan/tpcatvsosm/gtfs_cat_urba_bus` (feed_info `ATM`). Has no stop_times (too big for the repo); routes, agencies, stops and shapes are present |
| TMG Girona GTFS (NAP 1570) | VERIFIED-TODAY (mirror copy) | Bundled in GitHub `MiquelRoca08/App-Bus-Girona/libs/` (commit 2026-11-17). The Mobility Database mirror `es-cantalonia-girona-city-bus-gtfs-2751` returns **404** |
| TMG real-time endpoint | **FOUND, not probed** | Read from community source code (§2.1). `web2.girona.cat` is blocked here |
| Sagalés real-time endpoint | **FOUND, not probed** | Read from community source code (`Piscu/buses-sagales-realtime`), which stored live samples on 2026-10-14 |
| Moventis (Sarfa / Moventis Costa) real-time | Reported | Arribo's own `app/moventis.go` and `jtayped/moventis-lleida/docs/moventis-api.md` (verified there on 2026-10-03) |
| Live Generalitat GTFS calendar to 2027-06-30; T-mobilitat RT carries no Girona prefix | Reported (Arribo research, 2026-11-23) | `docs/research/MOVENTIS_SOURCES.md` |
| Everything else (urban lines in small towns, apps, summer services) | Reported | Web search snippets only. Treat as leads |

**To finish verification, allow these hosts** in the session network settings: `territori.gencat.cat`, `analisi.transparenciacatalunya.cat`, `web2.girona.cat`, `umat.girona.cat`, `www.girona.cat`, `nap.transportes.gob.es`, `t-mobilitat.cat`, `www.sagales.com`, `www.moventis.es`, `www.teisa-bus.com`, `www.fisersa.cat`, `www.atmgirona.cat`.

Local artefacts produced (scratchpad):
- `girona_gtfs/gencat_jun2026/`: the extracted Mobility Database mirror of the Gencat GTFS
- `girona_gtfs/gencat_jun2026_girona_routes.txt` and `gencat_feb2026_girona_routes.txt`: the Girona filter output (142 and 133 routes)
- `scripts/girona_filter.py` and `scripts/girona_seasonal.py`: the filter scripts
- `gh_repos/`: the community repos read for this report

---

## 1. Master table

Legend for the RT column: **GPS** = vehicle positions; **ETA** = stop predictions; **none** = timetable only; **?** = unknown.

| Municipality | Operator | Lines (public codes) | Real-time? | RT source | Static source | Notes |
|---|---|---|---|---|---|---|
| **Girona** (city) | **TMG** (Transports Municipals del Gironès SAU, municipal) | L1, L2, L5, L7, L8, L10, L11, L12 | **ETA** | `web2.girona.cat/appbus/cat/busos_json.php?linia=&dir=anada|torna&codi=` (unofficial use, §2.1). Also the "Girona App" and stop displays | NAP 1570 (API key); copy in GitHub App-Bus-Girona; ATM CGIM prefix `GIR` | TMG GTFS has **8 routes, 251 stops, 2,642 trips**. `feed_end_date` is **2026-12-31**, so it expires in 5 weeks. It includes Fires and Temps de Flors service_ids (§5) |
| Girona and **Salt** (joint urban network) | **TEISA** under Generalitat concession | **L3, L4, L9** (Salt–Girona), **L6, L16** (Sarrià de Ter–Girona–Vila-roja), plus the Girona–Sarrià circular | ETA **?** (NaviLens claims "real time"; TEISA app reported) | NaviLens codes at stops (vendor claim); TEISA app; appbus may cover them (stop PDFs exist for L3 at umat.girona.cat): **unverified** | **Gencat GTFS** (agency 42641): L0968, L1383, L1800, L1665 "L6", L2021 "L16", L0335 | **Not in the TMG GTFS.** Inferred mapping: L0968 ≈ L3, L1383 ≈ L4, L1800 ≈ L9. BRCAT bus lanes and the Pl. Joan Brossa hub opened 2025; L9 ridership is up 61% |
| Sarrià de Ter / Sant Julià de Ramis | TEISA | L6, L16, Clic.cat L1835/L1836 | ? | as above | Gencat | On-demand trips booked through the Nemi app or 972 204 868 |
| Fornells de la Selva, Vilablareix, Aiguaviva | TMG | L10, L5 | ETA | appbus | TMG GTFS | Suburban branches of TMG lines |
| **Figueres** (+ Vilafant) | **FISERSA** (Figueres de Serveis SA, municipal) | L1 Vilatenim–Geriàtric, L2 Sud, L3 Nord, L4 Pl. del Gra–Méndez Núñez (electric); interurban Figueres–Vilafant TAV (L54 / Gencat L1512, TEISA) | **none found** | — | ATM prefix `FIG` (routes FIG_416–419); `fisersa.cat/ca/03_BusLinies.html` | Moovit lists extra names (Rambla, Rec Arnau, Sociosanitari, Parc de les Aigües), possibly old |
| **Olot** | **TPO** (Transport Públic d'Olot), run by TEISA | A, B, C, D, E (E = working Saturdays) | ? | TEISA app (reported) | ATM prefix `OLO` | Seasonal calendars exist (2025-07..08 and 2025-06..09) |
| **Banyoles** / Pla de l'Estany | TEISA | L053 "Bus Banyoles", L052 "Bus Pla de l'Estany"; Gencat L0980, L1423, L1424 | ? | TEISA app / Nemi for on-request stops | ATM `TEI_53`, `TEI_52`; Gencat | Porqueres on-request stop activated through Nemi |
| **Lloret de Mar** | **Sagalés** (LloretBus brand, "Sagalés (Costa)") | L011 Fenals, L012 Lloret de Dalt, L013 El Molí–El Rieral, L02 Lloret Residencial (on demand), L03 Cala Canyelles, L04 Roca Grossa–Lloret de Dalt | **GPS + ETA** | `www.sagales.com/es/real-time-bus/{routeId}/{dir}` (route ids 671–675, 677); LloretBus app (official, shows real-time) | ATM prefix `COS` (COS_671…677) | Service started 2018-05-01 |
| **Blanes** | **Moventis Costa** (Pujol) | L2 Urbà Blanes, L4 Renfe Blanes–Centre–Renfe, L53 Valldoliga–barris–campings–port (summer-heavy), L1/L6 Lloret–Blanes, L69 Tossa–Lloret–Blanes Renfe | **ETA** (only where `real:"S"`) | moventis.es `GetTiemposParada` (unofficial, §2.4) | ATM prefix `PUJ` (PUJ_430…671); NAP 1577 | Malgrat and Palafolls urban lines (also PUJ) are in Barcelona province |
| Blanes–Lloret–Tossa corridor | **Circuits Ruri** (Moventis Costa group) | Gencat L0168, L0170, L1464, L1547 | ETA? (moventis) | moventis.es if listed | Gencat agency 42737 | Very frequent in summer ("every 10–15 min", Sagalés group CEO) |
| **Tossa de Mar** | Ruri / Moventis Costa / Sarfa | no urban network found; interurban only | — | — | Gencat | — |
| **Palamós** and **Calonge** | **Sarfa** (Moventis) | Sarfa urban **L1–L2** Palamós–Calonge (Gencat L1480 "(L1-L2) Calonge–Palamós–Calonge"; ATM `SAA_165` code 71); **summer:** "Badia Bus" Palamós–Calonge (L1545), Palamós–Sant Antoni (L1604), free Calonge–Sant Antoni shuttle (15 Jul–31 Aug 2026, extension of lines 41/42); L76 Vall-llobrega–Palamós | ETA (moventis) | moventis.es | Gencat 42628, ATM `SAA` | Summer routes appear in the Gencat feed only from 2026-06-20 |
| **Sant Feliu de Guíxols** / **Santa Cristina d'Aro** / **Castell-Platja d'Aro** / **S'Agaró** | Sarfa | Urban **L5–L6** Sant Feliu–Santa Cristina (ATM `SAA_168`, code 75; Gencat L1511); Gencat L1583 Sant Feliu–Monestir–Vilartagues–Tueda | ETA (moventis) | moventis.es | Gencat, ATM `SAA` | T-mobilitat lists Sarfa urban services in Castell d'Aro, Platja d'Aro, S'Agaró, Santa Cristina and Sant Feliu |
| **Palafrugell** (Calella, Llafranc, Tamariu, Begur) | Sarfa | **Summer:** BUS 30' Palafrugell–Calella–Llafranc (07:30–23:15) and BUS 60' Palafrugell–Tamariu, both extensions of **line 8**; Gencat L1169 Palafrugell–Calella–Llafranc, L1148 Tamariu, L1123 Begur; "Julivia" tourist bus (late Jun–11 Sep) | ETA (moventis) | moventis.es | Gencat, ATM `SAA_80` (code 8) | BUS30' is free during the Cantada d'Havaneres. Palafrugell joined ATM Girona in 2026 |
| **La Bisbal d'Empordà** | Sarfa | Clic.cat R1 Fonteta, R2 Casavells, R3 Polígon Corçà (Gencat L2178–2180) | Clic app: vehicle GPS for booked trips | Nemi app (booking-only) | Gencat | No urban fixed line found |
| **Roses** | **Estarriol** | L1 Santa Margarida, L2 Almadrava (**summer Jun–Sep**, 09:00–22:00), L3 Mas Mates | none found | — | ATM prefix `ROS` | Seasonal calendars present (2025-06..09) |
| **Castelló d'Empúries – Empuriabrava** | Estarriol | LV1 Línia Vermella **Estiu**, LV4 Vermella Dll–Dss, LV5 Vermella Dmg/Festius, LG3 Groga, LVD2 Verda | none found | — | ATM prefix `EMP` (route centroid 42.252 N, 3.10 E = Empuriabrava) | Calendars in the Feb-2026 mirror end in 2026-04, so it needs a refresh |
| **Cadaqués** / Cap de Creus | Sarfa | T-mobilitat lists a Sarfa urban service in Cadaqués; summer "Circumval·lació Cap de Creus" (Gencat L1690, Port de la Selva–Cadaqués) | ETA (moventis)? | moventis.es | Gencat | Barcelona Nord–Cadaqués (L1120) appears in summer |
| **Torroella de Montgrí – L'Estartit** | **AMPSA** (Autocars Martí Pi) | Gencat L0761 Torroella–L'Estartit (37 trips/day), e2 L0440 L'Estartit–Torroella–Girona, L0439, L0796 Verges–Girona; Clic.cat Baix Ter | none found | — | Gencat agency 42581 | No AMPSA app or API found |
| **L'Escala** | Sarfa | none found (interurban 10, 11; Gencat L1150 "Vilartagas – l'Escala") | — | — | Gencat | Unclear whether a summer local bus exists |
| **Puigcerdà** | **TPVP** (municipal) | 1 line, "Bus urbà de Puigcerdà" | none found | — | ATM prefix `PUI` | "Bus Blanc" ski shuttle (weekends and school holidays, €2) is separate. liO 566 Bourg-Madame (France) |
| **Ripoll** | — | no urban line found; Transports Mir L1309 Ripoll–Campdevànol and L1286 Vall de Ribes; Clic.cat Ripollès R1–R5 | — | — | Gencat 42647 | — |
| **Santa Coloma de Farners**, **Llagostera**, **Sils**, **Caldes de Malavella** | TEISA / Hispano Hilarienca / Sarfa | no urban network found; interurban only (L0334, e5 L1765, L1878 Tossa–Llagostera, L0327 Caldes) | — | — | Gencat | — |
| **Llançà**, **Port de la Selva** | Sarfa | interurban only (L1198 Figueres–Portbou, L1690 summer) | — | — | Gencat | — |
| Garrotxa (rural) | TEISA | L0163 Bus Transversal Garrotxa, Rumbus L1947 Les Preses–Olot–Santa Pau (weekends/holidays, seasonal), Clic.cat L1881 Vall d'en Bas | ? | TEISA app / Nemi | Gencat | Rumbus runs only some days, Mar–May and later |
| **Girona–Costa Brava airport (GRO)** | **Barcelona Bus (Sagalés)**, Sarfa, TEISA | 607 Girona–Airport (Gencat L0328); 604 Barcelona Nord–Airport; 602 BCN Airport–BCN–Girona–Figueres; 605 Canet–Calella–Blanes–Airport (L1494); 613 Airport–Lloret–Tossa (L1831, joint Barcelona Bus + Sarfa); Roses–Airport (L1516, seasonal May–Oct); TEISA L038 Girona–Airport–Platja d'Aro | **GPS + ETA** for Sagalés lines | sagales.com real-time-bus (route ids 602, 604, 605, 607, 613) | Gencat, ATM `COS` | Timetables are **"coordinated with airline schedules"**. 56 daily Barcelona trips from 2026-06-01. Eix-Bus L0324 serves the airport only 15/06–15/09 and only "if there are passengers" |

---

## 2. Per-operator technical sections

### 2.1 TMG Girona (Transports Municipals del Gironès SAU)

**Static GTFS (VERIFIED-TODAY from the GitHub copy of NAP 1570)**
- Official: `https://nap.transportes.gob.es/api/Fichero/download/1570`, which needs a free NAP `ApiKey` header. Licence: NAP LDA (commercial reuse allowed, attribution "Powered by MITRAMS").
- The Mobility Database `mdb-2751` mirror (`storage.googleapis.com/.../es-cantalonia-girona-city-bus-gtfs-2751.zip`) returns **404** (the NAP key blocks the mirror).
- Contents of the copy in `MiquelRoca08/App-Bus-Girona/libs` (2026-11-17):
  - `agency_id=TMG`, `Europe/Madrid`, `lang=ca`.
  - `feed_info`: `20230412 → 20261231`.
  - 8 routes: L1 Montjuïc–Ramon Folch–Avellaneda; L2 Hospital Trueta–Estació–Avellaneda; L5 Germans Sàbat–Sant Narcís–Vilablareix–Aiguaviva; L7 Torre Gironella–Can Gibert del Pla; L8 Estació–UdG Montilivi; L10 Estació–Fornells de la Selva; L11 CAP Güell–UdG Montilivi; L12 Ramon Folch–Barri Vell–Sant Daniel–Puig d'en Roca.
  - 251 stops, ids `15000`–`15398`, each with `stop_url=https://www.girona.cat/appbus/go?qr=<stop_id>`.
  - Shapes are present (22k points).
  - service_ids: `Feiners-26`, `Dissabtes-26`, `Festius-26`, `Agost` (August weekdays), `DS_Flo`/`DG_Flo` (Temps de Flors Saturday/Sunday), `DisFir`/`DiuFir` (Fires de Sant Narcís).
  - L8 runs weekdays only (78 trips, no August service). L12 runs weekdays and August only.
- The same routes appear in the ATM CGIM feed with prefix `GIR_`.
- **Gap:** the network also has L3, L4, L6, L9, L16, plus L13 per the council. These belong to TEISA, are absent from this feed and are present in the Gencat feed instead.

**Real-time (FOUND in community code, NOT probed: host blocked)**
- Endpoint: `GET https://web2.girona.cat/appbus/cat/busos_json.php?linia=<n>&dir=<anada|torna>&codi=<stop_id>&_=<ms>`
  - Example: `?linia=1&dir=anada&codi=15014`.
  - Headers used by the client: `X-Requested-With: XMLHttpRequest`, `Referer: https://web2.girona.cat/appbus/cat/app_index.php`.
  - Response: JSON whose `contingut` field holds an **HTML fragment** with "N min" or `HH:MM` text, or "sense informació".
  - `linia` is numeric without the "L" prefix, and `codi` equals the GTFS `stop_id`.
  - Per-stop official page: `https://web2.girona.cat/appbus/cat/parada.php?codi=<stop_id>`.
- Sources: `app/config.py` and `app/tmg/cliente.py` / `parser.py` in `github.com/MiquelRoca08/App-Bus-Girona`; also `akidev-frontend/mapa-bus-girona`, which only deep-links to parada.php.
- Output is **ETA only, no GPS**. The README says "Tiempo real (X min) ✅ Funciona" as of 2026-11-17. Relative minutes appear to mean a tracked prediction and `HH:MM` probably means timetable; this needs confirming.
- Legal status: not part of the open-data portal and **no reuse licence**. The community project calls it "consulta no oficial" and gives the TMG contact as gestio@tmgsau.cat. For use in Arribo: poll lightly (one stop per request; each line needs both `anada` and `torna`), cache, and ask TMG/Ajuntament for permission or a feed.
- Other channels:
  - "Girona App" (official Ajuntament app, App Store id1331385222) shows arrival predictions.
  - Alsa's pages mention a "Girona In" app.
  - In 2011 about 40 stops had real-time displays.
  - Stop timetable PDFs: `https://umat.girona.cat/apps/bus/cerca_pdf/parada/<stop>_L<n>` and `/linia/L<n>`. Coverage is 249 of 251 stops; 15392 and 15398 (L10) have no PDF. A PDF also exists for **L3**, which suggests the city's tools cover the TEISA lines too.
- Open data portal `dadesobertes.girona.cat` could not be checked (blocked). No real-time dataset was referenced anywhere.

### 2.2 TEISA (Transports Elèctrics Interurbans SA), including TPO Olot

- **Static data:**
  - Gencat GTFS agency `42641` has 54 routes touching Girona (Jun-2026 mirror). These include the Girona/Salt urban-like lines L0968, L1383, L1800, L1665, L2021 and L0335, the Clic.cat on-demand routes, the Olot network, Figueres–La Jonquera C3Connect and more.
  - ATM CGIM prefix `TEI_` has 52 routes with public codes `L001`…`L080`, for example L001 Girona–Olot per Banyoles, L032 Girona–Olot–Ripoll–Puigcerdà–Llívia, L038 Girona–Aeroport–Platja d'Aro, L041 night bus, L053 Bus Banyoles, L078 Bicibus, L080 Rumbus.
  - ATM prefix `OLO_` holds TPO Olot A–E (agency URL `teisa-bus.com/es/tpo`).
  - No TEISA NAP dataset was found.
- **Real-time:**
  - TEISA app (App Store id1451296777): the store text mentions tickets, timetables and incidents. One local source says the app gives "real-time position of the vehicle and arrival time", but that may refer to Clic.cat/Nemi.
  - NaviLens case study `navilens.com/en/case-studies/girona-teisa` claims real-time "next arrivals" at Girona urban and Salt L3 stops (vendor claim).
  - **No public endpoint found.** GitHub code search for `teisa-bus.com/api` and `api.teisa` returned 0 hits. TEISA uses Optibus for planning.
  - **Gap:** reverse-engineering the TEISA app or NaviLens backend was not attempted, and the host is blocked.
- **Clic.cat on demand** (Generalitat, run by TEISA, Sarfa and Hispano Hilarienca): booked through the **Nemi app** (`nemi.mobi`) or 972 204 868, with 15 min notice. The Gencat `nota.txt` marks these trips. Treat them as **"conditional trips"**: never show them as scheduled departures unless booked.

### 2.3 Sagalés group: Barcelona Bus, "Sagalés (Costa)", LloretBus, Eix-Bus

- **Static data:** Gencat agencies `42593 Barcelona Bus, SL` (13 Girona routes), `42742 Barcelona Bus SL i SARFA` (613) and `42680 Eix-Bus`. ATM prefix `COS_` uses public codes 601–663, e4, L011–L04.
- **Real-time (FOUND in `github.com/Piscu/buses-sagales-realtime`, `src/lib/sagalesClient.js`; NOT probed today):**
  - `GET https://www.sagales.com/es/real-time-bus/{routeId}/{direction}[?bus=true]`, direction 0 or 1. Returns JSON with `linia`, `ruta.stops` (id, stopCode, lat/lon, city), `ruta.shapes` (encoded polyline), `schedule` and `bus.entities[]`.
  - `bus.entities[]` holds a GTFS-RT-style `vehicle` with `postion` (sic: the typo is in the feed) giving lat, lon, bearing, speed, plus `occupancy`, `stopId`, `trip.tripId`/`directionId`/`headSign`. It also holds `tripUpdate.stopTimeUpdate[]` with arrival/departure epoch ms (`time` in ms), delay and `realTime:true`.
  - Also: `/es/next-bus/{stopId}` (HTML fragment of next arrivals), `/es/termometre/{routeId}/{dir}`, `/es/lineas/{1..4}` (catalogue) and `/front/js-nexus/planificador/funcionsAjax.php`.
  - The repo's SQLite (`data/sagales.db`) stored 12 live vehicles on **2026-10-14**, all on non-Girona lines. Girona-province route ids in that catalogue:
    - 601 Blanes–Girona
    - 602 BCN airport–BCN–Girona–Figueres
    - 603 airport–Blanes
    - **604 Barcelona–Girona airport**
    - 605 Canet–Calella–Blanes–GRO
    - **607 Girona–GRO**
    - 612 Vilafreser–Bàscara
    - **613 GRO–Lloret–Tossa**
    - 621, 622, 625
    - 650 Girona–UAB
    - 662 Lloret–Circuit de Catalunya
    - 663 Lloret–Girona
    - 617 = e4 Lloret–Girona express
    - **671–675, 677 = LloretBus urban L011, L012, L013, L02 (on demand), L03, L04**
    - 800 = L-28 Eix-Bus Girona–Lleida
- ToS: public website JSON, no auth. The community client uses a 25 s poll and a custom User-Agent. Sagalés robots.txt and ToS were **not checked** (blocked).
- Note: Sagalés also owns Moventis, but Sarfa lines are **not** in the sagales.com catalogue.

### 2.4 Moventis: Sarfa (Costa Brava/Girona) and Moventis Costa (Pujol: Blanes, Lloret, Tossa)

- **Static data:**
  - Gencat `42628 SARFA SL`: 39 Girona routes in the Jun-2026 mirror, for example L0134 Barcelona–Costa Brava, L1177 e6 Figueres–Roses, L1727 e3, L1461/L1556 circular routes, L1198 Figueres–Portbou, the night lines L0331 and L1475, plus the summer urban lines L1480, L1545, L1604 and L1690.
  - Gencat `42737 Circuitos Ruri`.
  - ATM prefixes `SAA_` (26 routes with Sarfa public codes 1–76) and `PUJ_` (9 routes).
  - NAP `1576` (Sarfa) and `1577` (Pujol) need an API key.
  - The T-mobilitat prefix description for SAA includes urban services at Palamós, Calonge, Castell d'Aro, Platja d'Aro, S'Agaró, Santa Cristina, Sant Feliu, Figueres, Roses and Cadaqués, with RT: NO.
- **Real-time (reported; Arribo already has a client, `app/moventis.go`):** `https://www.moventis.es`
  - `/es/moventis/es/lines` (all zones; one row per line per operating day; the Sarfa and Costa zone ids are not yet identified)
  - `/api/json/GetTrayectos/<ID_LINEA>/<YYYYMMDD>`
  - `/api/json/GetTiemposParada/ca/<ID_PARADA>/<ID_LINEA>/0`. Use only `real:"S"` items; `real:"N"` items are timetable.
  - robots.txt asks for a 10 s crawl delay. An all-`"A"` placeholder response means "too many requests".
  - **ETA only, no GPS.** The official route is the developer form at `moventis.es/ca/com-aconseguir-les-dades-gtfs-de-moventis`.
- Clic app: Baix Empordà on-demand vehicles show GPS position for booked trips, inside the app only.

### 2.5 Smaller operators

| Operator | Girona services | Data | RT |
|---|---|---|---|
| **FISERSA** (Figueres de Serveis SA) | Figueres urban L1–L4, Figueres–Vilafant | ATM `FIG` | none found |
| **Estarriol** (Estarriol Bus SL) | Roses L1–L3; Empuriabrava LV1/LV4/LV5/LG3/LVD2; Gencat L0887 Ordis–Figueres–Vilafant, L1066 Figueres–polígons | ATM `ROS`, `EMP`; Gencat 42658 | none found |
| **AMPSA** (Autocars Martí Pi) | Torroella–L'Estartit, e2 to Girona, Verges–Girona | Gencat 42581 | none found |
| **Ampurdan Bus** | Garriguella–Figueres (L0313, L0314) | Gencat 42670 | none |
| **Hispano Hilarienca** | Girona–Sant Hilari–Arbúcies (e5), Osor, Sant Esteve de Llémena, Clic.cat Gironès L1834 | Gencat 42710 | none |
| **Cia. Ferrocarril d'Olot a Girona** (TEISA group) | L0536 Olot–Girona, L0327 Girona–Caldes | Gencat 42602 | none |
| **Transports Mir** | Ripoll–Campdevànol, Vall de Ribes, Bagà–Ripoll | Gencat 42647 | none |
| **Alsina Graells (ALSA)** | Llívia–Puigcerdà–Barcelona / La Seu / Lleida; Berga–Ripoll | Gencat 42675; ATM `ALS` | none known |
| **Osona Bus (Sagalés)** | Torelló–Ripoll, Vic–Viladrau (seasonal) | Gencat 42655 | sagales.com (Osona lines) |
| **TPVP** Puigcerdà | 1 urban line | ATM `PUI` | none |
| **liO Occitanie 66** | 566 Bourg-Madame–Mont-Louis (cross-border at Puigcerdà) | ATM `LIO` | none |
| **Autocars Mas** | Requested by the brief: **not found** in any Girona feed. ATM `MAS_` is Masats (Igualada/Manresa) | — | — |
| **Alsa long-distance / FlixBus / BlaBlaCar** | Girona station, international | not in Catalan GTFS | — |

### 2.6 ATM Girona and fare integration

- Consorci del Transport Públic de l'Àrea de Girona (`atmgirona.cat`, blocked here).
- 2026 changes:
  - The 11 fare zones of the Girona counties are being merged into **one zone** (APD, 2026-03-01).
  - The first phase covers road transport, so ATM Girona tickets become valid on any interurban bus.
  - Garrotxa (21 municipalities) joins in 2026.
  - Palafrugell and Palamós have joined.
  - Generalitat budget target: about 30 M trips and 21 M ATM validations in 2026.
- T-mobilitat card rollout to all of Catalonia was announced for 2026, keeping regional fare products. No Girona-specific go-live date was found.
- T-mobilitat CGIM open data:
  - Static GTFS (free registration token): prefixes `GIR`, `TEI`, `SAA`, `PUJ`, `COS`, `FIG`, `OLO`, `ROS`, `EMP`, `PUI`, `GEN`.
  - Open GTFS-RT `trip_updates` and `alerts` at `/opendata/.../user/token/open` contained only `AMB`, `TMB`, `FGC` and `ROD` on 2026-11-23, so **no Girona real-time** there. `vehicle_positions` returns 404.
- Fares, where reported: Clic.cat single ticket €1.90, monthly pass €8.75; 607 Girona–airport €2.85; Bus Blanc €2.

### 2.7 Moovit / Google / Citymapper

- Moovit and Citymapper list Girona lines (for example Moventis/Sarfa line 75 and Fisersa stops). They are schedule-based from the GTFS feeds above.
- No evidence was found of Girona live data in Google Maps or Moovit. The only live sources found are first-party: TMG appbus, Sagalés and Moventis.
- Not usable as Arribo sources: their ToS forbid scraping. They are useful only for manual cross-checks.

---

## 3. Data-engineering quirks (load-bearing for an Arribo integration)

1. **Line-code collisions.** "L1" exists in TMG Girona, Figueres, Roses, Blanes (Moventis Costa L1 Lloret–Blanes), the Sarfa urban "L1–L2" and Mataró. Every key needs an operator prefix. The ATM CGIM prefix scheme (`GIR_L1`, `FIG_416`, `PUJ_430`) is a ready-made namespace.
2. **Gencat route codes are not public codes.** The Gencat feed uses `L0968` while riders see "L3". Some long names embed the public code in parentheses (`(e3)`, `(601)`, `L6 …`, `(L1-L2)`), but not all do. A manual mapping table is needed for the Girona/Salt TEISA lines.
3. **Gencat stop IDs encode the province.** They look like `PF` + 5-digit INE municipality code + sequence. **Girona = `PF17…`** (990 stops in the Jun-2026 mirror). I used this as the province filter; it is more reliable than a bounding box, which would wrongly include Osona and Maresme.
4. **Gencat `stop_times.txt` header has GTFS-Flex columns and leading spaces**:
   `trip_id,arrival_time,departure_time,start_pickup_drop_off_window,end_pickup_drop_off_window,stop_id,location_group_id, location_id, stop_sequence,…`
   A naive `DictReader` fails on `' stop_sequence'`; strip header names. No rows actually use the flex windows yet. Times have **non-zero seconds** (`13:50:26`), artefacts of interpolation, so round for display.
5. **`nota.txt`** (non-standard file in the Gencat feed) carries per-trip notes. It is the only machine-readable marker for on-demand trips, school-day-only trips ("O últim dia de classe setmanal", "També circula els festius escolars"), market-day trips ("Dia de mercat a Olot"), "airport only 15/06–15/09" and "only enters the airport if there are passengers".
6. **TMG service_ids are event-specific and re-used across years.** In 2026:
   - `DS_Flo`/`DG_Flo` = Temps de Flors on 9, 10, 16 and 17 May (festival ran 9–17 May; extra L7 service).
   - `DisFir`/`DiuFir` = Fires de Sant Narcís on 24, 25, 29 (Sant Narcís, a local holiday), 31 Oct and 1 Nov.
   - The calendar.txt rows keep 2023 date ranges with all-zero weekdays; activation is purely through `calendar_dates`.
   - The **feed expires 2026-12-31**. Watch NAP 1570 for the 2027 file.
7. **Summer-only lines** (Jun/Jul–Sep): Calonge/Palamós Badia Bus and Sant Antoni shuttle, Palafrugell BUS30'/BUS60', Roses L2, Empuriabrava LV1, Blanes L53, Cap de Creus circular, Roses–airport (from May), BCN Nord–Cadaqués, Sarfa L0134 seasonal frequency. Winter-only: Setcases–Campdevànol and Llívia–Girona (Dec–Mar), Girona–Vallter 2000, Bus Blanc. The Jun-2026 mirror only covers Jan–Jun, so summer calendars must come from the live feed.
8. **Airport services are flight-tied** (Sagalés 604/607 "coordinated with airline schedules"). Expect frequent timetable revisions with Ryanair seasons (late March / late October).
9. **Multi-branch / circular lines:** Sarfa L1461 and L1556 "circuit" loops Girona–Llagostera–Palamós–La Bisbal–Girona in both directions (Sarfa 41/42). TEISA e1 L0326 combines Olot–Girona and Girona–Banyoles–Olot. Sarfa urban "L1–L2" and "L5–L6" are paired loop directions under one route_id. TMG L11 and L12 are loop-ish.
10. **Coordinates:** all feeds are standard GTFS lat/lon. Sagalés `ruta.shapes` is a Google-encoded polyline. Moventis `NKM_ORIGEN` is a cumulative km figure. The Sagalés `postion` typo is in the feed itself.

---

## 4. Real-time availability summary

| Source | Coverage in Girona | Kind | Auth | Status |
|---|---|---|---|---|
| `web2.girona.cat/appbus/cat/busos_json.php` | TMG L1–L12 (maybe TEISA L3/L4/L9 too) | ETA text in HTML-in-JSON | none | Found in code 2026-11-17; not probed (blocked); unofficial, no licence |
| `www.sagales.com/{lang}/real-time-bus/{route}/{dir}` | Sagalés Costa / Barcelona Bus: airport 602/604/605/607/613, 601, 663, e4, LloretBus L011–L04, Eix-Bus | **GPS + trip updates** | none | Found in code; live samples 2026-10-14 (non-Girona lines); not probed |
| `www.moventis.es/api/json/GetTiemposParada/...` | Sarfa, Moventis Costa (Blanes), probably Ruri | ETA (`real:"S"`) | none; 10 s crawl delay | Arribo client exists; Girona zone ids unknown |
| T-mobilitat GTFS-RT | none for Girona (2026-11-23) | TripUpdates/Alerts | none | Reported |
| TEISA app / NaviLens | TEISA urban Girona/Salt, interurban | claimed ETA/position | app | No endpoint found |
| LloretBus app, Girona App, Moventis app, Nemi/Clic app | per operator | ETA / GPS of booked vehicle | app | Not reverse-engineered |
| FISERSA, Estarriol, AMPSA, TPVP, TPO | — | none found | — | — |

---

## 5. Gaps and next steps

1. **Re-run with hosts allowed** (§0) to:
   - download the live Gencat GTFS (expected calendar to 2027-06-30) and re-run `scripts/girona_filter.py`
   - probe `busos_json.php` once per line and direction for L1 and L3 (checking whether TEISA lines are covered)
   - probe `sagales.com/es/real-time-bus/607/0` and `/671/0`
   - read the `moventis.es` lines feed to find the Sarfa and Costa `ID_ZONA` values and check `TREAL`
2. **NAP API key** for 1570 (TMG 2027 feed), 1576 (Sarfa) and 1577 (Pujol). Also check the NAP catalogue for TEISA, FISERSA and Estarriol.
3. **T-mobilitat static registration** to get a current `completa` GTFS. The GitHub mirror is from Feb 2026, and its EMP/ROS calendars ended April/May 2026.
4. **TEISA real-time:** contact TEISA or the Generalitat DGTM. The Generalitat's fleet SAE data is not published. Reverse-engineering the TEISA app was not attempted.
5. **Unconfirmed urban services:**
   - L'Escala (summer?), Tossa, Llançà, Begur/Pals beach buses, Ripoll, Santa Coloma de Farners, Llagostera, Sant Antoni de Calonge winter service, Cassà, Vidreres, Maçanet, Hostalric: no urban line was found.
   - Lloret's 2026 line set should be checked against the app.
   - "L13" in Girona (mentioned by the council) is unidentified; it may be the Gencat L0335 Girona–Sarrià circular.
6. **Legal:** none of the three real-time endpoints carries a reuse licence. Before production, request written permission from TMG (gestio@tmgsau.cat), Sagalés and Moventis (developer form). Keep polling light, cache aggressively and label data "unofficial".
7. **Fire/festival specials beyond the GTFS** (Fires night buses, Festa Major shuttles in Palamós, Sant Feliu and Figueres): no 2026 data was found. They are usually announced only as PDFs or news. Fires 2026 ran 23 Oct–1 Nov.

## Sources (main)

- GitHub `MiquelRoca08/App-Bus-Girona` (TMG appbus endpoint, TMG GTFS copy): `app/config.py`, `app/tmg/cliente.py`, `app/tmg/parser.py`, `libs/*.txt`, README §3.5, §9
- GitHub `akidev-frontend/mapa-bus-girona` (parada.php deep link)
- GitHub `Piscu/buses-sagales-realtime` (`src/lib/sagalesClient.js`, `src/server/realtimeService.js`, `data/sagales.db`)
- GitHub `OSM-Catalan/tpcatvsosm` (`gtfs_cat_urba_bus` = ATM CGIM; `gtfs_cat_interurba_bus` = Gencat, Feb 2026)
- GitHub `MobilityData/mobility-database-catalogs` (entries 2926 and 2751), and the `storage.googleapis.com` mirror of 2926
- GitHub `jtayped/moventis-lleida/docs/moventis-api.md`; Arribo `app/moventis.go`; Arribo `docs/research/MOVENTIS_SOURCES.md`
- Web search snippets: apd.cat (Girona–Salt BRCAT, ridership; fare zones 11→1), naciodigital.cat (Calonge shuttle 2026; real-time stops 2011), comunicacio.palafrugell.cat (BUS30'/BUS60', ATM adhesion), sagales.com/en/mark/21/lloretbus and the LloretBus App Store listing, navilens.com Girona TEISA case study, aena.es GRO bus page, barnadiario/BCN 56-departure note, tempsdeflors 2026 magazine, femturisme (Fires 2026 dates), cerdanya.org (Bus Blanc 2026, Puigcerdà urban), corca.cat ATM 2026 PDF, diaricatalunya.cat (ATM Girona phase 1, Baix Ter Clic.cat), findit.city (Roses L2 summer), Moovit (Figueres stop lines, Blanes L53)
