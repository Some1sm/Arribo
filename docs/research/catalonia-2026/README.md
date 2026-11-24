# Catalonia transit data research (November 2026)

Research only: no code was written or changed. This folder answers six questions:

1. How to get real-time data for the Moventis **C-10** bus (positions or stop arrival times).
2. How much data exists about **every Rodalies train**: position, delay, platform, unit, model, size, capacity.
3. Which **towns and cities in Catalonia** have buses with real-time data and which only have timetables, for **all of Catalonia**, not just Barcelona.
4. What real data exists for **every other form of public transport**: FGC, metro, tram, rack railways, funiculars, bikes, boats, airport buses, demand-responsive buses.
5. How the route planner could **show ticket prices** for a selected origin and destination.
6. Which lines behave **strangely**: festival-only lines (Les Santes, La Mercè…), branches with different terminals and timetables, seasonal and school-only services, demand-responsive buses, rail-replacement buses.

Research date: 23–24 November 2026. Nine research lanes ran in parallel; each lane's full report is listed in the [index of reports](#index-of-reports) at the end. This page is the synthesis, with the key claims re-checked by hand on 24 November (marked **[checked]**).

## How to read the evidence

- **[checked] / [V] / verified:** fetched from the source on 23–24 Nov 2026 (HTTP status and field names seen).
- **[R] / reported:** from documentation, search results, community code or third-party captures, not fetched today. Several official hosts were blocked by this cloud session's network for most of the research. The lane reports say exactly which, and their "re-verify" sections list what to fetch once access is available.
- **Official / unofficial.** You asked for unofficial sources as a fallback where no official one exists. Every unofficial source is labelled with its legal standing. *Grey* means an undocumented JSON endpoint behind an operator's public website, with no licence either way. *Reverse-engineered* means it depends on a token or credential extracted from an app; it is revocable and probably against the app's terms. Probes were limited to a few polite GET requests per endpoint; no authentication was defeated.

---

## 1. The short answers

### 1.1 C-10 (Moventis / Empresa Casas, Mataró – Barcelona per la N-II)

Full report: [01-c10-moventis-realtime.md](01-c10-moventis-realtime.md).

| Rank | Source | What it gives | Status today | Standing |
|---|---|---|---|---|
| 1 | `www.moventis.es/api/json/GetTiemposParada/ca/{ID_PARADA}/{ID_LINEA}/0` (C-10 = `ID_LINEA` 53) | Live arrival countdown per stop. `real:"S"` = GPS-tracked bus, with seconds precision. `real:"N"` = timetable only | **[checked]** live `real:"S"` predictions for C-10 at Premià de Mar | Grey: the backend of Moventis's own "Temps real" page. `robots.txt` asks for a 10 s crawl delay. Arribo's current Moventis poller already uses it |
| 2 | `app.moventis.es/sae/api/posicion/linea/502` (502 = C-10 in the app's numbering) | **Real GPS**: lat/lon, speed, vehicle number | **Unreachable from this cloud network** (proxy 502, twice). Worked in older Arribo versions. Re-test from a Spanish/production IP | Reverse-engineered: the Moventis mobile app's built-in credential (already in git history; not reprinted) |
| 3 | Mou-te (Generalitat) `mou-te.gencat.cat/MouteAPI/rest/infrastructure/nextdeparturesNEW?paradaId=…&useRealTime=true` | Stop predictions with a `realtime` flag, no GPS | API alive and the derived `AT` header still accepted. A C-10 stop board was not yet obtained | Reverse-engineered token on a government site |
| 4 | Generalitat interurban GTFS (`territori.gencat.cat/…/busos-interurbans-GTFS.zip`) | **Static**: stops, timetable, exact road shapes for all 7 Casas lines (C-10 = route 0498). Its `stop_code` matches Moventis `COD_PARADA` for 83 of 88 C-10 stops | Verified 23 Nov | **Open licence** (attribution "Generalitat de Catalunya") |
| 5 | Moventis developer programme (`moventis.es/ca/eines-desenvolupadors`) | Weekly GTFS plus "dades del transport en temps real" (format unstated), after manual approval | Page confirmed | **The only clean route to official real time for Casas** |
| – | T-mobilitat open GTFS-RT | Nothing for Casas | **[checked]** 1,702 trip updates: TMB 804, AMB 741, Rodalies 102, FGC 55, **Casas 0**; vehicle positions → 404 | Open |

**Recommendation:** use the Generalitat GTFS as the static base (shapes, stops, calendar). Overlay the moventis.es stop predictions, and keep positions estimated from them labelled "predicted", never shown as GPS. Re-test the app's GPS endpoint from production. Submit the Moventis developer form asking for GTFS-RT VehiclePositions + TripUpdates (or SIRI) for Empresa Casas. The other Maresme Casas lines (C-20 = 57, C-30 = 59, e11.1 = 47, e11.2 = 48, 865 = 51, N-80 = 68 in Moventis numbering) behave identically.

### 1.2 Rodalies: what we can know about every train

Full report: [02-rodalies-trains.md](02-rodalies-trains.md).

| Data item | Commuter lines R1–R8 | Regional lines R11, R13–R17, RG1, RL3/RL4, RT1/RT2 | Source |
|---|---|---|---|
| Position | yes; stopped/arriving trains snap to station coordinates | yes | Renfe GTFS-RT (open) **[checked]**; Renfe web map `flota.json` **[checked]** |
| Delay | one delay per train (not per stop) | same | GTFS-RT TripUpdates; `flota.json` `retrasoMin`; `flotaLD.json` `ultRetraso` |
| Platform | GTFS-RT label only near a station (22/116 trains). **`flota.json` `nextVia` = platform at next station for 49/82 Catalan trains** | same | **[checked]** 24 Nov |
| Train number | yes (`vehicle.id`, `codTren`) | yes | all feeds |
| **Unit number(s), series/model, single vs coupled** | **no public source** | **yes: `flotaLD.json` `mat`**, e.g. `449027,449034` = two 449 units coupled. Join on train number: 8/8 matches on R11, R15, R16, R17, RL4 | **[checked]**: 24 Catalan trains in `flotaLD`, all with `mat`; 5 doubled; series 447, 449, 470, 448 |
| Accessibility of the actual train | rough: GTFS-RT wheelchair flag on 41/116 trips; `flota.json` `accesible` | same | GTFS-RT, `flota.json` |
| Capacity, length, seats | not in any feed; derive from series (fleet table) | derivable from `mat` series | report 02 §4 |
| Occupancy / crowding | **none** (unlike FGC, which publishes per-car occupancy) | none | — |
| WiFi, bikes, depot, livery | not in any feed; static per-series facts | same | — |

**Fleet in service.** Series 447 (3 cars, ~76 m, ~750 places), 450/451 double-deck, Civia 463/464/465 (3/4/5 cars, low floor), 448, 449 and, contrary to earlier sources, **470 (five units seen in service on R15/R17 today)**. Coming: Alstom series 452 (100 m, 905 places, testing on R1, passenger service expected Q1 2027), Stadler series 453, CAF regionals from 2027, and 14 series 121 for regionals. Unit counts in Catalonia conflict between sources; report 02 tabulates them.

**What this means for Arribo.** For regional trains, the app can honestly show "2 × series 449 units (~200 m)". For R1–R8 it can only show the series *usually seen* on that line, never as fact. The richer per-train fields come from Renfe's public web-map JSON (`tiempo-real.renfe.com/renfe-visor/flota.json`, `tiempo-real.largorecorrido.renfe.com/renfe-visor/flotaLD.json`). Those files are grey (no licence), so they belong as a fallback layer beside the open GTFS-RT. Adif's data (composition, platforms) is not reusable under its terms, and its app API needs signed requests; do not use it.

### 1.3 Buses: which places have real time and which only timetables

Full reports: [03](03-barcelona-province-urban-buses.md) (Barcelona province outside the metropolitan area), [04](04-barcelona-amb-buses.md) (Barcelona and the 36 AMB municipalities), [05](05-girona-province.md) (Girona), [06](06-tarragona-lleida.md) (Tarragona and Lleida). Each has a per-municipality table with operator, line codes, real-time source and static source.

**There is no official open real-time feed for any Catalan bus outside the AMB area.** Real time is reachable only through an operator's own back end, one per operator family:

| Operator family | Real-time kind | Endpoint (standing) | Where it covers |
|---|---|---|---|
| **AMB** (metropolitan bus: TUSGSAL, Baixbus/Avanza, Monbus, Moventis, Soler i Sauret, TGO, Sagalés, NitBus) | stop-level predictions + alerts, **no GPS** | **Official, open, keyless:** `www.ambmobilitat.cat/transit/trips-updates/trips.bin` and `/transit/alerts/alerts.bin` **[checked]**; also relayed in T-mobilitat. Vehicle positions file → 404 **[checked]** | AMB lines in the 36 metropolitan municipalities |
| **TMB** (Barcelona city bus) | per-stop predictions with bus id, no public GPS | **Official, free key:** `api.tmb.cat/v1/itransit/bus/parades/{code}` | Barcelona and TMB lines into neighbouring towns |
| **Avanza** | full SIRI (GPS) in Mataró | Mataró SIRI (already in production in Arribo). Terrassa (TMESA) and Rubí have apps, but their back ends were not found | Mataró; Terrassa and Rubí unknown |
| **Sagalés group** (Transgran, BusManresa, Urbà de Vic, Barcelona Bus, LloretBus, Sagalés Costa) | **GPS positions + stop delays + route polyline** | Grey: `www.sagales.com/es/real-time-bus/{routeId}/{dir}` (GTFS-RT-shaped JSON; position key misspelt `postion`, timestamps in ms). All 96 Catalan urban lines answered and ~55 had live vehicles at 11:10 on 24 Nov | Granollers conurbation, Manresa, Vic (new 10-line network from 1 Dec 2026), Mollet, Caldes, Lliçà, Bigues, Parets, Sant Celoni, Cardedeu, Pineda–Calella, Lloret, Girona airport lines and more |
| **Moventis group** (Casas, Sarbus/La Vallesana, Sarfa, Moventis Costa/Pujol, TCC, Autobusos de Lleida) | stop predictions only, no GPS | Grey: `moventis.es/api/json/GetTiemposParada/…` (164 lines; every line is flagged real-time-capable, so the flag means nothing). Only AMB-contracted Moventis lines are in open GTFS-RT | Maresme (C-10 etc. and urban lines in Vilassar, Cabrera, Premià, Masnou), Sitges, Sant Sadurní, Castellar, Malgrat, Palafolls, Blanes, Costa Brava (Sarfa), **Lleida city** |
| **TMG Girona** | ETA text inside HTML-in-JSON | Grey: `web2.girona.cat/appbus/cat/busos_json.php?linia=…&dir=anada|torna&codi=…` | Girona city L1–L12 (TEISA-run L3/L4/L9 uncertain) |
| **EMT Tarragona, Reus Transport, TUS Sabadell, TEISA, Direxis (Olesa, Igualada), Monbus (Abrera, Esparreguera)** | ETA or map in their own apps | back end **not identified** | Tarragona, Reus, Sabadell, Girona/Salt TEISA lines, Olot, Igualada, Olesa, Abrera, Esparreguera |
| **Generalitat interurban lines and small-town "Urbà de …" lines** | none open | Mou-te answers `nextdeparturesNEW?…&useRealTime=true` for Generalitat lines (reverse-engineered token) | everywhere else |

**Places with real-time data of some kind:**
- **Barcelona province:** Barcelona, the AMB municipalities on AMB/TMB lines, Mataró, the Granollers conurbation, Manresa, Vic, Mollet, Caldes, Lliçà, Bigues, Parets, Sant Celoni, Cardedeu, Pineda/Calella, and the Moventis Maresme towns. Sabadell, Terrassa and Rubí have real time only in their apps.
- **Girona province:** Girona, Lloret, Blanes, Costa Brava Sarfa lines, airport lines.
- **Tarragona province:** Tarragona and Reus, in their apps only.
- **Lleida province:** Lleida.

**Places with timetables only** (static GTFS, no live data found): Vilanova i la Geltrú (and no feed at all; its operator is unclear), Berga, Vilafranca, Igualada (app claims live data), Sitges (Moventis; unverified), Figueres (FISERSA), Olot (TPO), Banyoles, Palafrugell, Palamós, Roses, Empuriabrava, L'Estartit, Puigcerdà, Valls, El Vendrell, Calafell, Cunit, Torredembarra, Cambrils, Vila-seca/La Pineda, Tortosa, Amposta, Mont-roig, Vandellòs, Balaguer, Tàrrega, Solsona, Val d'Aran, and every Generalitat demand-responsive (TAD) network in the Pyrenees, Terres de l'Ebre and Segarra.

**No urban bus in any feed:** Salou (a circular line is planned for 2027), Altafulla, Deltebre, La Ràpita, Montblanc, Mollerussa, Tordera (PDF only), and others listed in reports 03–06.

**Static data** exists for almost every network, through three channels:
1. the Generalitat interurban GTFS (open, no key; includes ~60 "Urbà de …" lines);
2. the ATM/T-mobilitat unified GTFS (free registration; operator prefixes such as `MAT_`, `TUS_`, `EMT_`…);
3. per-operator files on Spain's NAP (free key).

Gaps: Terrassa (NAP file expired May 2026), Vilanova i la Geltrú, Tordera, and TMG Girona (its feed expires 31 Dec 2026).

### 1.4 Other forms of public transport

Full report: [07-other-modes.md](07-other-modes.md).

| Mode | Best live source | Notes |
|---|---|---|
| **FGC** trains | Opendatasoft **`posicionament-dels-trens`** ("Geotren"): series (`tipus_unitat`), hashed unit id (`ut`), **occupancy per car** | CC BY 4.0, keyless, 5,000 requests/day per IP. The GTFS-RT vehicle-positions file is often empty; trip updates carry platforms but no delay field. Updates every 100–140 s |
| FGC Montserrat rack railway | Geotren lists its trains | Núria rack railway and the Gelida/Montserrat funiculars have no data |
| FGC ski resorts | `estat-d-obertura-de-les-explotacions`: open/closed, snow depth | — |
| **TMB Metro** | iTransit `GET /v1/itransit/metro/estacions` (free key): whole network in one call | Predictions only for **L1–L5 and L11**; L9, L10 and the Montjuïc funicular are timetable-only; no GTFS-RT |
| **TRAM** (T1–T6) | `opendata.tram.cat` GTFS (no key) + live API (free OAuth registration): per-stop times and per-tram delay | Terms require deleting data when the agreement ends, which matters for the Observatori history |
| **Bike share** | GBFS: Bicing (no licence stated), AMBici, Ganxeta (Reus), Donkey, Cooltra, Getaround | Girona (Girocleta) is HTML only; Manresa (Baik) none. Barcelona's private bike-share licences end 31 Dec 2026 |
| Renfe regional / long distance | `vehicle_positions_LD.pb`, `trip_updates_LD.pb` + `flotaLD.json` (unit numbers) | Ouigo and Iryo publish nothing live |
| Aerobús, airport buses, boats, taxis, carsharing | almost nothing; Aerobús may be inside the AMB GTFS-RT (unverified); boats only via AIS | — |

### 1.5 Ticket prices in the route planner

Full report: [08-fares-and-ticket-prices.md](08-fares-and-ticket-prices.md).

**Key finding.** The ATM/T-mobilitat unified GTFS already contains a complete **GTFS-Fares v2 model of the Barcelona integrated fare system with the 2026 prices**: 290 fare areas, 49,885 stop→area rows, 215 products, 23,478 leg rules, transfer rules, rider categories (T-jove, T-16, large/single-parent families). The planner can price a journey by mapping each leg's stops to fare areas and applying the leg and transfer rules.

**2026 prices (ATM, in force since 15 Jan 2026), 1 zone / 2 zones / 3 zones:**

| Ticket | 1 zone | 2 zones | 3 zones |
|---|---|---|---|
| Single ticket | 2.90 € | 4.15 € | 5.40 € |
| T-casual | 13.00 € | 25.50 € | 34.70 € |
| T-usual (with the 50% discount) | 22.80 € | 30.55 € | 42.70 € |

Other prices: T-jove 45.50 €; T-16 free.

**Zones.** There have been 7 zones since July 2025; Mataró is zone 3, sector 3E.

**Overrides the feed needs:**
- The Aerobús appears as integrated but is not (≈ 7.75 €).
- The airport metro supplement (≈ 5.90 €) is missing.
- The Núria rack railway is priced by ATM rules but ATM tickets are not valid there.
- Operators' own single tickets are missing. Mataró Bus's own fares beat ATM tickets for trips inside Mataró: 1.70 € single, 4.85 € T-10.

**Outside the Barcelona area.** The Camp de Tarragona, Girona and Lleida integrated systems, Renfe distance-band fares, Generalitat per-line fares and city-bus fares are mostly not in machine-readable form. Report 08 §3–7 lists prices and sources per system.

**Proposed approach (described in prose in report 08 §10):**
1. Ingest the ATM v2 fare tables.
2. Resolve the fare area per stop.
3. Compute the cheapest suitable ticket for one- and two-leg journeys, respecting transfer windows.
4. Add a small hand-maintained override table: Aerobús, airport, Núria, own city-bus tickets, non-integrated operators.
5. Label every result **"preu orientatiu"**.
6. Refresh every January when fares change.

### 1.6 Lines with strange behaviour

Full report: [09-irregular-and-festive-lines.md](09-irregular-and-festive-lines.md).

**Les Santes, Mataró:**
- The **"Bus Focs"** night service ran in 2025, 22:00–02:00 every 15 minutes, on three lines that exist only that night: **L10** Cirera – Sant Simó, **L11** Galícia – Ronda Barceló, **L12** Plaça de França – Ronda Barceló. Whether they ran in 2026 is unconfirmed.
- Every year L1–L8 and interurban lines are diverted on the Desvetllament, Ruixada, Nit Boja and Focs nights. The diversions are published only as an HTML page or PDF, never in GTFS.
- N80 and N82 run until 04:00.
- Arribo already treats 27 July as a local holiday (Sunday timetable) in `src/data/holidays.json`. The SIRI feed would show a Bus Focs vehicle under an unknown line code, which the app should keep as a "special service" vehicle rather than drop.

**Generalitat GTFS footnotes.** The non-standard `nota.txt` holds **3,044 trip notes on 347 routes**. Examples:
- "I nits de la Revetlla de Sant Joan, la de Cap d'Any i la de la Mercè" on 72 trips of 11 night routes, whose calendars do *not* include those weeknights;
- market-day stop skips (Cambrils on Wednesdays);
- school-day-only and on-demand trips.

A GTFS-only planner gets these wrong.

**Other patterns catalogued with examples:**
- Festival networks: La Mercè (all-night metro), Sant Joan, Cap d'Any, Fires de Sant Narcís and Temps de Flors (both encoded in TMG Girona's GTFS), Santa Tecla, Patum, Aplec del Caragol.
- Event shuttles: the Montmeló circuit, stadiums, Port Aventura.
- Seasons: summer beach lines and August variants (Tortosa `L2A/L3A/LDA`), ski buses, and the Pyrenees summer-only Bus del Parc.
- Shared line codes: "L1" exists in at least five Girona-province networks, so line codes need an operator prefix.
- Route shapes: branches and alternating terminals, loop lines with different outbound and return paths, night networks routed differently from day lines.
- Demand-responsive services: book-by-noon-the-day-before lines with 2 trips a week.
- Rodalies: line codes that change mid-journey (R2/R2N/R2S), trains skipping stations, and the 2025–2026 rail-replacement buses.

**Recommended model, in prose (report 09 §10):**
- a base timetable plus dated overlay layers (special routes, stop closures and relocations, extra or removed dates parsed from footnotes);
- a named festive-night calendar that services opt into;
- the original operator note always shown to the user.

---

## 2. What to do next (priority, no code)

1. **Submit the Moventis developer form** (C-10 and all Moventis lines, official real time). Add **Sagalés, Avanza (Terrassa/Rubí), TUS, TMESA, EMT Tarragona, Reus Transport and TMG/TEISA** to the public-information requests in [../../catalonia-review/DATA_REQUESTS.md](../../catalonia-review/DATA_REQUESTS.md). Ask Renfe for unit/composition and platform data for R1–R8, citing that it already publishes them for regionals (`flotaLD.json`) and partly for commuter trains (`flota.json`).
2. **Register the free keys/tokens:** T-mobilitat static GTFS (fares v2 and all operator prefixes), NAP, TMB developer portal (bus iTransit and metro predictions), TRAM OAuth, AMB API.
3. **Re-test from production:** the Moventis app's GPS endpoint, the Mou-te C-10 stop board, and the hosts that were blocked here (each report's "re-verify" list).
4. **Decide the policy for grey and reverse-engineered sources.** In practice: moventis.es predictions, sagales.com and Renfe's web-map JSON are grey public endpoints; the Moventis app credential and the Mou-te token are reverse-engineered. The earlier Catalonia review recommended not to use reverse-engineered credentials.
5. **Fares:** adopt the ATM v2 model with the override table in §1.5 and label prices "orientatiu".
6. **Irregular services:** build the dated overlay layer, starting with Les Santes, and parse `nota.txt`.

## 3. Legal and ToS summary

| Source | Standing |
|---|---|
| Generalitat GTFS, AMB GTFS and GTFS-RT, T-mobilitat GTFS + GTFS-RT, FGC Opendatasoft, Renfe GTFS/GTFS-RT, TRAM GTFS | **Open licences** (attribution; Llei 37/2007 reuse; CC BY 4.0 for FGC) |
| TMB API, TRAM live API, NAP, T-mobilitat static download | Official, free registration; their terms apply (TRAM requires deletion when the agreement ends) |
| moventis.es `/api/json`, sagales.com `real-time-bus`, Renfe `flota.json` / `flotaLD.json`, TMG `busos_json.php`, Bicing GBFS | **Grey**: public endpoints behind official websites, no licence. Poll gently, cache, label "unofficial", ask for permission before production |
| Moventis app GPS (app credential), Mou-te API (derived token), AMB v2 with a key taken from the app | **Reverse-engineered**: revocable, probably against app terms. Not recommended |
| Adif station data and Adif app API | **Do not use**: terms forbid reuse; signed requests |

## Index of reports

| # | Report | Scope |
|---|---|---|
| 01 | [C-10 and Moventis real time](01-c10-moventis-realtime.md) | every real-time path for C-10 and the Casas, Moventis and Sagalés networks |
| 02 | [Rodalies trains](02-rodalies-trains.md) | field-by-field per-train data, fleet table, inference of unit from train number, other Renfe services |
| 03 | [Barcelona province urban buses](03-barcelona-province-urban-buses.md) | ~50 non-AMB municipalities, per comarca, with live Sagalés and Moventis probes |
| 04 | [Barcelona and AMB buses](04-barcelona-amb-buses.md) | TMB, AMB and the 36 AMB municipalities |
| 05 | [Girona province](05-girona-province.md) | TMG, TEISA, Sagalés, Sarfa and town buses |
| 06 | [Tarragona and Lleida](06-tarragona-lleida.md) | EMT Tarragona, Reus, Lleida, coast, Pyrenees, demand-responsive networks |
| 07 | [Other modes](07-other-modes.md) | FGC, metro, tram, rack railways, funiculars, bikes, boats, airport buses |
| 08 | [Fares and ticket prices](08-fares-and-ticket-prices.md) | ATM GTFS-Fares v2, 2026 prices, other systems, proposed planner approach |
| 09 | [Irregular and festive lines](09-irregular-and-festive-lines.md) | festivals, events, seasons, structural oddities, data hazards |
| 10 | [Follow-up on open items](10-follow-up-open-items.md) | second pass on gaps left by the first nine reports |

Related earlier documents: [../MOVENTIS_SOURCES.md](../MOVENTIS_SOURCES.md) (Moventis static data, 23 Nov) and [../../catalonia-review/](../../catalonia-review/) (architecture review and data requests).
