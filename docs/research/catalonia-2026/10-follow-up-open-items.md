# J — Gap closure (follow-up research), 2026-11-24

Legend: **[verified-today]** = fetched from this container today; **[reported]** = web search / secondary source, not fetched.

Status: complete — see end of file.

## 1. Mataró festive services — repo state (verified-today, local grep)

What the repo models today:
- `src/data/holidays.json`: 2026 local days **Fira a Mataró 2026-05-25** and **Festa major de Les Santes 2026-07-27**, plus 12 regional days; 2027 regional only. `serviceOverrides: []` for both years.
- `app/calendar.go` already supports `serviceOverrides` entries `{date, dayType}` (`getServiceOverride`), so a per-date day-type swap (e.g. "run Sunday grid on 28 Jul") is expressible without code changes. Nothing is populated.
- `src/data/mataro_schedules*.json`: winter/summer grids from maresme.net (scraped 2026-10-28) + "Cementiri Les Valls" stop. No Santes/Bus Focs/Tots Sants extra trips or diversions modelled.
- mataro.cat, capgros.com, mataroaudiovisual.cat, mataro.avanzagrupo.com are **refused by the proxy (403 CONNECT)** from this container, so findings below are [reported] via search.

(Web findings for item 1 appended further down.)

## 2. Generalitat interurban GTFS (verified-today, downloaded)

File: `busos-interurbans-GTFS.zip` (24,085,885 B) → saved at `research/dl_J_gtfs/gtfs.zip`, extracted to `research/dl_J_gtfs/x/`.
- HTTP `Last-Modified: Mon, 23 Nov 2026 10:22:28 GMT`, ETag `"16f857d-660eef885ca8e"`, `cache-control: max-age=3600`, `access-control-allow-origin: *.gencat.cat`. Inner files are dated 2026-11-20 12:12.
- **Calendar range 2026-01-01 → 2027-06-30.** `calendar.txt` (443 services) has **every weekday flag = 0**; all service days are additions in `calendar_dates.txt` (64,739 rows, exception_type 1 only). calendar.txt carries an extra non-standard `name` column with human-readable Catalan service descriptions (e.g. 185886 "Circula el 22 de gener (Festa Major de Prats de Lluçanès)" → route 0574 (472 493) Santa Eulàlia de Puig-oriol–Prats de Lluçanès, dates 20260122 & 20270122). Note: MobilityDatabase mdb-2926 still lists the older Jan–Jun 2026 range — stale.
- **110 agencies, 934 routes, 29,701 trips, 9,168 stops.** `stop_times.txt` uses the GTFS-Flex header (`start/end_pickup_drop_off_window`, `location_group_id`, `location_id` — all empty) plus a non-standard `prohibition` column. pickup/drop_off = 0/0 except 309 rows with 2/2 (phone-arranged).
- Shapes 72 MB (shapes.txt).

### route_long_name matches (case-insensitive festa|fira|santes|merc|estiu|platja|nadal|nit|neu|esqu|demanda|llan|escolar|aeroport|circuit)
No route contains fira, santes, merc(at), estiu, circuit or a genuine "festa" event line. Many hits are substring false positives (Esterri d'Àneu→"neu", Penitenciari→"nit", Llançadora→"llan", Enfesta→"festa", l'Esquirol→"esqu", el Nadal = a Vic neighbourhood). Genuine thematic hits:

| route_id | short | long name | agency | trips |
|---|---|---|---|---|
| 0331 | L0331 | Girona–Sant Feliu–Platja d'Aro–Sant Antoni–Palamós–Palafrugell (**Bus Nocturn**) | SARFA SL | 12 |
| 0704 | L0704 | (C21) Sant Vicenç de Montalt–Caldes d'Estrac (**TAD**, amb serveis a demanda) | Empresa Casas, SA | 70 |
| 1574 | L1574 | (486) Tavertet–l'Esquirol (**TAD**) | 25 Osona Bus, SA | 5 |
| 0876 | L0876 | Vilaller–el Pont de Suert–Taüll (**pistes d'esquí**) | Autocars Palmerola, SL | 4 |
| 1918 | L1918 | La Guingueta d'Àneu–Cap del Port la Peulla (**estació d'esquí**) | PERE CORTINA BOCHACA | 2 |
| 1880 | L1880 | Llavorsí–Estació d'esquí de la Pleta del Prat | Ivan Pey Queró | 2 |
| 1674 | L1674 | (L2e) (L. **Escolar** Mixt Urbà ESO i conjunta Muntanya/Platja) Roda de Berà–Creixell–Francàs | Autocars del Penedès, SA | 8 |
| 1401 | L1401 | (449) Sant Pere de Torelló–Vic (festius) (SC) | 25 Osona Bus, SA | 14 |
| 1563 | L1563 | (LTF) Urbà d'Igualada: línia transversal festius | SA Masats Transports Generals | 12 |
| 1740 | L1740 | Vilanova i la Geltrú–BCN (dissabtes i festius) | Cintoi Bus, SL | 34 |
| 0592 | L0592 | Reus–Salou poble i **platja** | Empresa Plana | 70 |
| 1463 | L1463 | Lleida–Salou–**Platja** de la Pineda | HIFE | 6 |
| 1511 | L1511 | (L5-L6) Sant Feliu–**Platja** d'Aro–s'Agaró–Sta. Cristina | SARFA SL | 12 |
| 1461 / 1556 / 1727 | | Girona–…–Platja d'Aro–Palamós–Palafrugell circuits (1727 = Exprés.cat E3) | SARFA SL | 43 / 33 / 85 |
| 1316 | L1316 | (602) **Aeroport** del Prat–Barcelona–Girona–Figueres per A7 | Barcelona Bus, SL | 8 |
| 0328 | L0328 | Girona–Fornells de la Selva–**Aeroport** Costa Brava | Barcelona Bus, SL | 98 |
| 1494 | L1494 | **Aeroport** de Girona–el Maresme–**Mataró** | Barcelona Bus, SL | 43 |
| 1561 | L1561 | Blanes–el Maresme–**Mataró–Aeroport** del Prat | Barcelona Bus, SL | 27 |
| 1125 | L1125 | Tossa–Lloret–Barcelona–**Aeroport** BCN T1 i T2 | SARFA SL | 137 |
| 1831 / 1891 | | Tossa–Lloret–**Aeroport** de Girona (both directions) | Barcelona Bus SL i SARFA / SARFA | 51 / 11 |
| 1516 | L1516 | Roses–**aeroport** de Girona | Barcelona Bus, SL | 6 |
| 1826 | L1826 | **Aeroport** de Reus–Tarragona | La Hispano Igualadina | 32 |
| 1728 / 1733 / 1734 | | **Llançadora** Hospital de Tortosa; Tortosa–l'Aldea Estació; Amposta–l'Aldea Estació | HIFE | 48 / 22 / 22 |
| 1755 | L1755 | **Llançadora** Figueres–CP Puig de les Basses | TEISA | 34 |
| 1864 | L1864 | (M6A) Viladecavalls–Terrassa (**llançadora**) | Transportes Generales de Olesa | 20 |
| 0087 / 0348 / 0482 / 1710 | | Prison shuttles (Can Brians, Quatre Camins, Lledoners, Mas d'Enric) | Hispano Igualadina / Sagalés / Bages Bus / HIFE | 21/27/28/22 |
False positives (substring only, not thematic): 0288, 0383, 0776, 0443, 0023, 0390, 0600, 0287, 0315 (Esterri d'Àneu → "neu"); 1617 (Vic urbà "el Nadal" neighbourhood); 0380, 1654, 2204 (Cunit → "nit"); 0251, 0769 (urbanitzacions → "nit"); 1224, 1274, 1860 (l'Esquirol → "esqu"); 1701, 1702 (Enfesta → "festa"); 2224 (Centre Comercial → "merc").

Event/festive service in this feed is encoded **in calendars, not routes**: calendar `name` strings reference Nadal, Setmana Santa, school holidays, ski season ("temporada d'esquí"), local festa major days (Prats de Lluçanès 22 Jan). No calendar or route mentions Santes, Fira de Mataró, Tots Sants, Patum, Temps de Flors, Carnaval.

### nota.txt
Columns: `route_id, trip_id, nota` (2,993 rows) — free-text per-trip notes, HTML-entity-encoded (`&#10;` newlines, `&#237;` etc.). Content: on-demand stops with phone reservation ("Parades a la demanda … Reserva prèvia al tlf … amb 24 hores d'antelació"; ~1,600 rows mention demanda/reserva), market-day diversions (~100: "El dilluns, dia de mercat, recorregut alternatiu per ctra. Barcelona", "Dimecres de mercat no fa parada a …"), school/summer remarks, 16 cementiri mentions (C21 TAD stop "3-Cementiri"). These are not machine-readable — they modify the timetable semantics (diversions, request stops) and would need NLP/manual handling.

### `prohibition` column (stop_times) — NOT documented anywhere found (datos.gob.es / MobilityDatabase / territori pages say nothing). Empirical decoding [inferred, unverified]:
Value counts: 3=332,091; 0=103,710; 4=26,937; 5=3,899; 6=710; 7=76; 8=22; 9=12.
- Pattern strongly suggests a **traffic-restriction code** (Spanish concession "prohibiciones de tráfico"): `3` = board and alight allowed; `0` = **boarding only**; `4` = **alighting only**. Evidence: origins are typically 0 and termini 4; C-10 (route 0498) toward BCN codes Badalona stops `0` (board only) and La Pau terminus `4`; the reverse trip codes BCN origin stops `0` and Badalona stops `4` (alight only) → i.e. Maresme↔Badalona trips are prohibited on C-10 in both directions while BCN↔Badalona is allowed. 0720 Tarragona–Valls: Tarragona urban stops 0, Valls 4.
- `5–9` appear on night/long lines (e.g. N30 BCN–Vilanova–Vilafranca: pairs of stops in the same town share 5,7,8) → most likely **"no travel between stops sharing the same group code"** (intra-town traffic protected for the urban operator).
- Caveat: 570 trips are all-0 (e.g. Vic urban L1–L3, Manresa–Xup), which would be nonsensical under the board-only reading → the field is unreliable for urban lines; treat as advisory. Ask the Generalitat (DGTM/dades obertes) before enforcing it in a planner.

## 1b. Mataró festive services — web findings (all [reported]; mataro.cat/capgros/tvmataro unreachable from container and from WebFetch)

**Les Santes 2026** (festa 18–29 Jul 2026; local holiday Mon 27 Jul):
- Castell de focs **Mon 27 Jul 2026, 23:00**, launched from **three sites** for the first time (Varador beach, Institut Escola Mar Mediterrània, Escola Vista Alegre / Cerdanyola) — lessantes.cat/agenda-cultura/2026-castell-de-focs. Passeig Marítim closed Cargol ↔ pas de Sant Simó 15:00 → 01:30 next day; no parking on Passeig Marítim from 12:00.
- Official notice "Afectacions de Mataró Bus, busos interurbans, parades de taxis i aparcaments durant Les Santes" (mataro.cat/ca/actualitat/avisos/afectacions-de-mataro-bus-durant-les-santes; search snippet says published 15 Jul 2026; weekdays match 2026):
  - **Sat 18 Jul (Dissantes)**: L1, L2, L4, L6, L8 diverted via plaça d'Espanya 19:00 → 08:00 next day.
  - **Fri 24 Jul (Gegantada)**: L3, L8 diverted via Camí Ral 19:30–21:30.
  - **Sun 26 Jul**: L1, L4 diverted (Barram/Repicada 12:00–14:30; cercavila "De parranda" from 17:00).
  - Notice also covers interurban stops (C-10 etc.), taxi ranks and car parks — full table not retrievable.
- **"Bus Focs"** (fireworks-night special) — confirmed for **2025** (Sun 27 Jul 2025): 3 special lines **L10 Cirera–Sant Simó, L11 Galícia–Ronda Barceló, L12 Plaça de França–Ronda Barceló**, 22:00–02:00, every 15 min (TV Mataró, mataro.cat 2025). Recurring since ≥2015 (2016 notice: "torna a fer un servei especial la nit dels focs amb tres línies", one more than 2015). **2026 Bus Focs routing NOT found** — with three launch sites in 2026 the pattern may have changed; unverified.
- Summer timetable: since 2025 Mataró Bus starts "horari d'estiu" on 28 Jul (day after Santes) with L1–L3 reinforced (mataro.cat 2025; laclau.cat). Repo's seasonCalendar should be checked against that boundary.
- Separate small event: Festes del barri Santes-Escorxador (early Sept) traffic notice exists on mataro.cat.

**Tots Sants, Nadal/Cap d'Any/Reis, Fira (25 May)/Cirera, Sant Jordi (Mataró)**: no Mataró Bus-specific special service found by search (only TMB/Manresa/Granollers analogues). Repo already has a "Cementiri Les Valls" stop in the regular grid. Likely only diversions published as avisos on mataro.cat — must be checked by a human/browser with mataro.cat access.

**Recommendation for repo**: add `serviceOverrides` / a dated "extra trips" mechanism for Bus Focs (L10–L12 synthetic lines, labelled as special/theoretical), and model 18/24/26 Jul diversions as notices rather than geometry. Needs mataro.cat allow-listed to verify 2026 details.

## 3. Mou-te real time for C-10 (verified-today, 3 API requests + 3 static files, 10:27–10:29 UTC)

Web client facts (from `https://mou-te.gencat.cat/main-es2015.fd7cb803cd3488e24dd9.js`, Angular bundle, saved in `research/dl_J_moute/main.js`):
- Base `https://mou-te.gencat.cat/MouteAPI/rest/`. Token: `buildHttpOptions` → header `AT: md5("mouteapi" + String(Date.now()).substring(0,7))` (config `TKN:7, TKNW:"mouteapi"`) — **still current**, unchanged from the repo's docs. Changes every 10^6 ms (~16.7 min).
- Endpoints in bundle: `infrastructure/{nearby, nearbyotp, nextdepartures, nextdeparturesNEW, nextdeparturesbylist, stop/lines, stop/linesNEW, stop/histograma, line/itineraries, line/itinerarie/initialHours, line/timetable, trip/stoptime/hourByStop}`, `gtfs/GTFSGeometries` (POST), banners/alerts.
- Exact web call: `infrastructure/nextdeparturesNEW?paradaId=<id>&useRealTime=true&language=ca_ES` (variant adds `&favouriteLinesIds=…&beforeNow=true`). Older: `nextdepartures?language&liniaId&network&paradaId&project&suplement&useRealTime`.
- `infrastructure/nearby?coordX=<UTM31N E>&coordY=<UTM31N N>&language=ca_ES&radius=500` → `{transports:[{desc,type,id,coords,distance,tipusTransports}]}`.
- **paradaId is Mou-te's internal numeric id (`100xxxxx`), NOT the GTFS `PF…` id**: `paradaId=PF08121036` returned **HTTP 200 with empty body**. (The retired repo client passed PF ids — that is why its C-10 boards may have been empty.) Mapping: use `nearby` or the static mock structure; no PF→numeric table found in the GTFS.
- Static mock files (no token) document the schema: `/assets/jsons/nearby.json`, `/assets/jsons/next-departures.json`.

Result for C-10: `nearby` around plaça França (Mataró) → id **10026783 "pl. França (A)"**; `nextdeparturesNEW?paradaId=10026783&useRealTime=true` → 200, 11.9 KB:
- `parada{idParada, descripcio, coordX, coordY, lineas.linia[{nomLinia, descripcioLinia, idLinia, network, project, suplement, direction, tipusTransport, operador{idOperador,nom}, ondemand}]}` — lines **C10 (idLinia 02498)** and **N80 (02109) Barcelona–Mataró (SN)**, operator `PTO84:cat` Empresa Casas, SA.
- `sortides.sortida[{dia, mes, any, hora, minuts, direccio, direccioId ("R"), liniaId, tripId ("02498 _131772591_001_3299861_1_15265044"), realtime}]` — 52 departures for the rest of the day.
- **All 52 have `realtime: false`** (40 C10 + 12 N80) on a Tuesday at 11:29 local with C-10 in service. No delay, vehicle or occupancy fields exist in the schema. ⇒ **Mou-te does NOT expose real time for C-10 today**; it is timetable-only. Moventis (app/moventis.go) remains the only C-10 prediction source.
- Note Mou-te idLinia = "02" + GTFS route_id ("0498" → "02498"), so line ids map cleanly to the GTFS; stop ids do not.
- Legal/ToS: header token is a client-side derived value in a public government web app with no published third-party API; usage is grey (not authentication bypass, but no permission). The prior repo recommendation (request formal access via DGTM / ATM) stands.

## 4. Girona TMG appbus (verified-today, 2 requests 10:30 UTC; raw in `research/dl_J_girona/`)

`GET https://web2.girona.cat/appbus/cat/busos_json.php?linia=<n>&dir=<anada|torna>&codi=<stop>&_=<ms>` with `X-Requested-With: XMLHttpRequest` + Referer `…/appbus/cat/app_index.php`. Content-Type is `text/html` but body is JSON `{"contingut": "<html fragment>", "missatge": ""}`.
- **L1 (TMG), codi 15164 "c. Peius Pascual 23", anada** → `Properes arribades: » 4 minuts → destinació: Avellaneda » 22 minuts → destinació: Avellaneda` + links (add to favourites; per-stop PDF `umat.girona.cat/apps/bus/cerca_pdf/parada/15164_L1`).
- **L3 (TEISA, Salt–Girona), codi 15226 "Santa Eugènia 44 (Parc Central)", anada** → `» 2 minuts → destinació: Salt - c. Miquel Martí i Pol (Terminal Bus) » 12 minuts → …` + line PDF link `umat.girona.cat/apps/bus/cerca_pdf/linia/L3`.
- ⇒ **appbus DOES cover TEISA L3** (closes the open question in E_girona.md). Key finding: the **Generalitat GTFS `stop_code` for TEISA Girona/Salt stops equals the TMG appbus `codi`** (e.g. PF17079093 → stop_code 15226; some TEISA stops have stop_code `null`) — so L3/L4/L6/L9/L16 boards can be keyed from the Gencat GTFS.
- Output: next 2 arrivals per line+direction+stop, relative minutes + destination; no GPS, no trip id, no explicit realtime flag (whether "N minuts" is tracked or timetable-derived is not stated; the HH:MM form seen in community code likely marks timetable). One request per (line, dir, stop).
- Legal: unofficial, no licence; community project calls it "consulta no oficial". Contact gestio@tmgsau.cat for permission.

## 5. Sagalés real-time-bus 607 (Girona–Aeroport de Girona) (verified-today, 1 request 10:30 UTC; raw `research/dl_J_sagales/`)

`GET https://www.sagales.com/es/real-time-bus/607/0` → 200 `application/json`, 3.5 KB, `cache-control: no-cache, private`, Laravel session + XSRF cookies set (not required for the GET).
- `linia`: `{agency{id:9, name:"Barcelona Bus S.L.", externalName:"Sagalés (Costa)", phone, timezone, fareUrl}, id:"607", shortName:"607", longName:"Girona - Aeroport de Girona", color "002f6c", textColor, routeType 3, routeGroup "A", ondemand 0, clicCat false, imgPath…}`
- `ruta`: `{shapes: <Google encoded polyline, 732 chars>, stops:[9 × {id, stopCode ("16105"…), stopName, stopLat, stopLon, commercialCity, onDemand, stopsequence}]}` — first stop Estació d'Autobusos de Girona (16105), via Fornells, Riudellots, … airport.
- `bus`: **GTFS-RT-shaped** `{header:{gtfsRealtimeVersion:"1.0", incrementality:"FULL_DATASET", timestamp:1795516220410 (ms)}, entities:[]}` — **no vehicle at probe time** (entities empty). Other agents saw entities with vehicle position/trip/stop updates on other lines.
- `schedule`: `{anada:true, tornada:true, routeDirectionAnada:"Girona", routeDirectionTornada:"Aeroport de Girona", schedule:null, scheduleFlex:null, incidencies:null, clicCat:false}`; plus `visibleButtonChangeRoute:true`, `directionTravel:"0"`.
- Same route is in the Gencat GTFS as L0328 (Girona–Fornells–Aeroport Costa Brava, Barcelona Bus SL, 98 trips). Sagalés stopCode values are in the 16xxx Gencat stop_code space (e.g. 16105) — joinable to the Gencat GTFS by stop_code.
- Legal: undocumented public website back-end, no auth, no licence/terms; robots.txt does not disallow. Ask Sagalés for a data agreement before production use.

## 6. Operator real-time backends (Terrassa, Rubí, Sabadell, Tarragona, Reus)

New leads (GitHub code search + raw.githubusercontent fetches [verified-today: files read]; hosts themselves unreachable/blocked → endpoint behaviour [reported]):
- **GeoActio / Actio is the app vendor for TUS Sabadell (`com.geoactio.tus`) and TMESA Terrassa (`com.geoactio.tmesa`)** [reported: appgoblin, Google Play]. Also TGO and Avanza Largo Recorrido (`com.geoactio.avanzalargorecorrido`). The Rubí-bus app is listed under "Avanza Spain, S.A." (iOS id1342129103) — vendor not confirmed.
- Two GeoActio backend generations found in public code:
  1. **Legacy, unauthenticated**: `https://<city>.geoactio.com/index.php/api/{lineas,paradas}` returning `{"message":[…]}` (lines: id, name, color; stops: id, name, lineas[].id, latitude/longitude) — `TheMovingTeam/Providers/scripts/modules/geoactio_common.py` (used for `llorentebus`). Arrival-time endpoint not in that script. A single probe of `tmesa.geoactio.com` was **refused by the proxy (403 CONNECT)**; the city slug for TUS/TMESA is unknown — not guess-scanned.
  2. **ActioSAE BFF**: `https://<feed>.actiosae.com/bff/mobile/{route/list, stop/list, stopInfo/{id}, arrivals/{stopId}, vehiclePosition, alert/list}?feedId=<feed>&key=<Google API key>` — proprietary JSON incl. **GPS vehicle positions**. Documented in `10198aprieto/arroyobus/arroyobus_api_docs.md` (Arroyo de la Encomienda). **The key is restricted to the official Android app (X-Android-Package / X-Android-Cert headers); calling it means impersonating the app → this is defeating an access control. Do NOT use.** Listed only so the team knows what TUS/TMESA likely run on and what to ask for (a partner feedId/key).
- **Avanza SIRI**: besides `sirimataro.avanzagrupo.com/Siri/SiriWS.asmx` (Mataró, in production), public code shows **`https://sirigmv.avanzagrupo.com/Siriv2/SiriWS.asmx`** used for Llorente Bus/Benidorm (TheMovingTeam/Providers `Llorente Bus/metadata.json`) and Avanza QR pattern `https://consultas.avanzagrupo.com/qr/benidorm-<stop>`. ⇒ Avanza runs a shared GMV-SAE SIRI v2 endpoint; **Terrassa/Rubí may be on `sirigmv` with a different account**, or have `siri<city>` hosts — unverified (avanzagrupo.com blocked here; no account known). Avanza contact page lists business units `terrassa.avanzagrupo.com` and `rubi.avanzagrupo.com` [reported]. Legal: Mataró's account is a publicly published default; using another city's account would need Avanza's permission.
- **EMT Tarragona** (Technodac app) and **Reus Transport** ("Bus ONLINE" app): nothing new — no GitHub/web documentation of a backend; emtanemambtu.cat not reachable. Only official path: data request (EMT also changes to a 17-line network on 2026-12-22).
- Recommendation: approach TUS (municipal) and TMESA (20% municipal) via the DATA_REQUESTS template asking explicitly for GTFS-RT or ActioSAE partner access; ask Avanza for a SIRI account for Terrassa/Rubí mirroring Mataró's.

## 7. Vilanova i la Geltrú urban bus (2026)

- [reported: vilanova.cat news id 99997730, busplana.com, laciutat.cat] After a court ruling annulled the municipal urban concession, **from 3 Feb 2025 the old urban L1 (Tacó–Càmping) and L2 were folded into the Generalitat interurban concession V-GC-18 (Vilanova–Vilafranca)** as **"L68 blava" and "L68 vermella"**, operated by **BusPlana (Teresa y José Plana, Empresa Plana SL)**, 9 vehicles. No new municipal concession/operator change announced for 2026 (search). TCC/Moventis no longer runs it (consistent with it being absent from the Moventis catalogue).
- Tourism page (vilanovaturisme.cat/bus_urba) lists "bus urbà" as ~5 lines incl. the L68 variants and **L72 Vilanova–Sant Pere de Ribes–Sitges** (also Plana); 2026 urban fares listed there; municipal discount valid only with Bus Garraf (Cintoi Bus) and Empresa Plana. From 6 Jul 2026 stops temporarily relocated due to bus-station works (vilanova.cat/mobilitat/bus_interurba).
- [verified-today, Gencat GTFS] agency 42634 Empresa Plana: **L0820 "(L68) Vilanova i la Geltrú – Vilafranca del Penedès" 214 trips**, **L1738 "(L68) Vilanova i G.–Sitges–St. Pere de Ribes–Vilafranca" 12 trips**, **L0818 "(L72) Vilanova–Sant Pere de Ribes–Sitges" 275 trips**. No blava/vermella split visible (trip_headsign/short_name empty) — variants must be inferred from stop patterns/shapes. ⇒ The "static gap" in C_bcn_province_urban.md is closed: Vilanova's urban service **is in the Gencat GTFS** (and therefore ATM `GEN_`). Real time: none known (Plana has no known RT web endpoint; Mou-te shows Generalitat lines but C-10 test suggests realtime=false is typical).
- Side note: search engines index Mou-te API timetable URLs, e.g. `mou-te.gencat.cat/MouteAPI/rest/infrastructure/line/timetable?liniaId=02140&project=001&network=cat&suplement=+&language=ca_ES`.

## 8. Festive / event services across Catalonia (all [reported] unless noted; partial — appended as found)

| Event | 2026 dates | Operator(s) | Extra service / changes | Where published | In GTFS? |
|---|---|---|---|---|---|
| Festa Major de Gràcia (BCN) | mid-Aug (15–21 Aug pattern) | TMB | Bus del Barri **114, 116** diverted inside perimeter Gran de Gràcia–Lesseps–Trav. de Dalt–Escorial–Trav. de Gràcia–Bailèn–Còrsega; Metro L3 (and historically all-night metro on the closing weekend in some years) | tmb.cat "avis-festa-major-de-gracia" (undated notice), noticies.tmb.cat press notes yearly (2019–2024 found) | No — TMB GTFS doesn't encode diversions; T-mobilitat/TMB alerts only |
| Festa Major de Sants | late Aug | TMB | Security dispositiu announced (barcelona.cat 2026); bus diversions via TMB notices; no 2026 detail found | barcelona.cat, tmb.cat | No |
| Temps de Flors (Girona) | **9–17 May 2026** (71st ed., 141 projects/113 sites) | TMG (+TEISA) | Official revista lists a mobility section incl. **extra service on urban L7** and bus access to neighbourhood projects | tempsdeflors.girona.cat/docs/revista_tempsdeflors_2026.pdf | **Yes, partially**: E_girona.md found TMG GTFS has Temps de Flors and Fires service_ids |
| La Patum (Berga) | **2/3–7 Jun 2026** | Consell Comarcal del Berguedà charter (2024 contract: **17 Bages Bus**); Generalitat Berga–BCN corridor (Alsa) reinforced May 2026 (not Patum-specific) | Comarcal Patum buses from Berguedà villages, ticketed (2024: €4/day return, return 05:00 from Pl. Gernika), extended to 4 days (Wed–Sat) | naciodigital.cat/bergueda, consell comarcal | No (charter, ticketed) |
| Carnaval de Sitges / Vilanova | Sitges **12–18 Feb 2026** (Rua de l'Extermini Tue 17 Feb 21:00) | Renfe R2 Sud; Generalitat N30 night bus (Cintoi/Bus Garraf) | Precedent 2015: N30 reinforced every night Sat–Tue and 38 special trains 14–18 Feb. 2026: R2 Sud single-track works (Feb 2026, 3 months, with replacement buses) — no 2026 Carnival specials found; one undated report says Renfe gave no reinforcement | govern.cat (2015), naciodigital | No (specials not in GTFS) |

| Festa Major de Terrassa | **3–8 Jul 2026** | TMESA (Avanza); FGC S1 | Free **shuttle Pl. del Doré ↔ CAP Rambla 2–6 Jul** (2–3 Jul 06–23 h, 4–6 Jul 08–22 h, frequency-based, no fixed times) due to FM + carrer d'Arquimedes works (terrassa.cat PDF 260701 "Bus llançadora Festa Major"); TMESA special timetables Fri/Sat/Sun/Wed; night service with on-demand intermediate stops; Rambla closed & buses diverted; FGC notice C2126 "festa major de TR" (fgc.cat, Jun 2026) | terrassa.cat, tmesa.com, fgc.cat | No (TMESA has no current GTFS at all) |
| Festa Major de Sabadell | early Sep (craft fair 5–7 Sep 2026) | TUS; FGC S2 | **FGC S2 non-stop service for 4 days** (Ara, 28 Aug 2026); TUS lines **2, 3, 4, 5, 8, 9 special services until 03:00 Fri–Sun** (Nació Digital, undated); diversions published by Ajuntament | ara.cat, naciodigital.cat/sabadell, sabadell.cat | No — though ATM `TUS_` has festius F1–F6/F15/N1/N4 lines (C_bcn) |
| Sant Pere (Reus) | 28–29 Jun 2026 (extraordinary tronada 28 Jun, 400 years of relic) | Reus Transport | No special bus found | diaridetarragona.com | No (F_tarragona: not in GTFS) |
| Misericòrdia (Reus) | main day **Fri 25 Sep 2026** | Reus Transport | No special bus found; F_tarragona notes REU_ L81/L82 rows are seasonal (Parc de Nadal, Fira) | diaridetarragona.com | No |
| Fira de Sant Ermengol (La Seu d'Urgell) | **16–18 Oct 2026** (Retaule de Sant Ermengol 7–15 Aug) | Alsa (Seu–Andorra, Seu–BCN) | No special bus found; Andorra–La Seu frequencies raised from 1 Sep 2026 to 40 trips (alto.ad) | — | No |

| Primavera Sound (BCN) | early Jun 2026 | TMB (+AMB NitBus) | Precedent (2022–2024 TMB press): metro reinforcement + **two night shuttle buses** Fòrum ↔ Pl. Catalunya (2024); 2026 guides only cite L4 El Maresme|Fòrum, T4, NitBus N6/N7, day lines 7, 136, H16, V29, V31, V33. No 2026 TMB notice found | noticies.tmb.cat (yearly "transport-public-festival-primavera-sound-YYYY") | No (shuttles never in GTFS) |
| Cruïlla (BCN) | **8–11 Jul 2026**, Parc del Fòrum | TMB | Precedent: night shuttle Fòrum ↔ Pl. Catalunya (2018, 2019), "Festival Cruïlla" special night buses on 2 nights (2021); tmb.cat avis "festival-cruilla-bus-metro" (undated) | noticies.tmb.cat, cruillabarcelona.cat "how to get there" | No |
| Sónar (BCN, Fira Montjuïc/Gran Via) | mid-Jun | — | Nothing found for 2026 | — | No |
| MWC (BCN, Fira Gran Via) | early Mar 2026 | TMB; Fira | L9 Sud reinforced Collblanc–Fira (~2–3 min headway in past editions); **electric shuttle Fira Gran Via (C/ Alumini, 4YFN North) ↔ Pl. Espanya / Talent Arena**, Mon–Wed 08–20, Thu 08–16 (mwcbarcelona.com/transportation, year unstated); regular V1, 46, 65; tmb.cat/mwcbarcelona landing page | tmb.cat/ca/mwcbarcelona, noticies.tmb.cat yearly | No |
| Sant Medir (Gràcia, 3 Mar) | 3 Mar 2026 | TMB | No 2026 notice found (expect Gràcia diversions similar to Festa Major: 114/116 + crossing lines) | noticies.tmb.cat | No |
| Election day | none in Catalonia in 2026 (next Catalan/municipal: 2027) | — | No free-transport/special-service practice found in Catalonia (Brazil does; Balearics has assisted transport for disabled voters) | — | n/a |
| Tots Sants (BCN) | 1 Nov | TMB | Yearly press release reinforcing cemetery lines; TMB GTFS has dedicated cemetery lines **102 (Pl. Eivissa–Cementiri de Collserola), 104 (Fabra i Puig–Collserola), 107 (Cementiri Montjuïc)** at 6–12 trips/day | noticies.tmb.cat "transport-public-cementiris-de-barcelona-tots-sants-YYYY" (2015–2023 found) | Base lines yes; extra Tots Sants trips not confirmed |

**AMB "bus a demanda"** [reported + local data]: TMB "El Meu Bus" on-demand zones in Barcelona — Torre Baró, Torre Baró Sud–Vallbona, Montbau–Vall d'Hebron, Farró–Galvany (Sarrià-Sant Gervasi, launched 28 Nov) — booked via elMeuBus app; present in TMB API `transit/linies/bus` as NOM_FAMILIA "Bus a la Demanda", **absent from TMB GTFS** (D_amb_buses.md). AMB-run models listed in a 2020 AMB/Baix Llobregat deck: **Tiana, NitBus (on-demand stops), El Prat, Cervelló** (Cervelló: regular morning + on-demand 16–19 h, app/phone, modifiable up to 1 h before). No consolidated 2026 AMB list found; amb.cat not searchable here. Outside AMB the ATM GTFS carries many TAD lines (e.g. FYT_289 Caldes urbanitzacions, BGS_498 Vic–Sta Maria d'Oló, GEN Berguedà TADs, ALSA Lleida TADs).

**TMB "Bus del Barri" / proximitat** [verified-today from local TMB GTFS copy `scratchpad/dl_D_tmb/tmb.zip`]: 41 routes numbered 102–196: 102 Pl. Eivissa/Cementiri de Collserola; 104 Fabra i Puig/Cementiri de Collserola; 107 Cementiri Montjuïc; 109 Hospital Clínic/Polígon Zona Franca; 111 Tibidabo; 112 Sant Genís; 113 La Mercè; 114 Gràcia/Can Baró; 115 La Bordeta; 117 Guinardó; 118 Mas Guimbau; 119 La Teixonera; 120 Ciutat Vella; 121 Poble Sec; 122 Turó de la Peira; 123 Bonanova Alta; 124 Penitents; 125 La Marina; 126 Sant Andreu; 127 Roquetes; 128 El Rectoret; 129 El Coll; 130 Can Caralleu; 131 El Putxet; 132 Torre Llobeta/Prosperitat; 133 Trinitat Vella/Fabra i Puig; 134 Roquetes/Fabra i Puig; 136 Pg. Marítim/Verneda; 137 Circular Montcada i Reixac 2; 138 Circular Montcada i Reixac 1 (both from 19 Jan 2026); 141 Esq. de l'Eixample; 150 Pl. Espanya/Castell de Montjuïc; 157 Collblanc/Sant Joan Despí; 175 Les Corts; 180 Torre Baró Sud; 182 Pl. Virrei Amat/Torre Baró; 183 Torre Baró/Ciutat Meridiana; 185 Canyelles/Vall d'Hebron; 191 Pl. Congrés/Can Baró; 192 Poblenou/Hospital de Sant Pau; 196 Pl. Kennedy/Bellesguard. (TMB says "up to 26 proximity lines" — the 1xx range also includes cemetery, Montjuïc and Montcada circulars.)

### Cross-cutting conclusion for item 8
Event services in Catalonia are published as PDFs/press releases (TMB noticies, municipal avisos, FGC "C####" notices), **almost never in GTFS** (exceptions: TMG Girona Fires/Temps de Flors service_ids; Reus REU_ L80 Fira; Gencat calendar names for a few festa major days; TUS festius lines). Real-time feeds (TMB/AMB GTFS-RT via T-mobilitat) carry diversions only implicitly. A curated "event calendar" (date range + affected lines + text + source URL) is the realistic model.

---
Status: **complete** (all 8 items addressed; see per-item verified/reported tags). Hosts refused today: mataro.cat, capgros.com, mataroaudiovisual.cat (tvmataro), mataro.avanzagrupo.com, tmesa.geoactio.com, github.com (HTML), avanzagrupo.com subdomains; WebFetch to mataro.cat fails ENOTFOUND.
