# Urban / municipal bus services in the province of Barcelona outside the AMB

Research for Arribo! · compiled 2026-11-24 · research only, no application code.

## 0. Method, sources and verification legend

**Network situation during this run.** During most of the run, direct HTTP from the sandbox was blocked for operator and government hosts: territori.gencat.cat, t-mobilitat.cat, nap.transportes.gob.es, sagales.com, moventis.es, tus.es, tmesa.com, ca.wikipedia.org, files.mobilitydatabase.org and gtfs-source-feeds.transit.land were all refused by the egress proxy, and WebFetch failed with ENOTFOUND. I could not download the Generalitat GTFS URL from the brief. WebSearch worked until the session-wide budget of 200 searches ran out. The coordinator later reported that sagales.com, www.moventis.es, t-mobilitat.cat, ambmobilitat.cat and mou-te.gencat.cat answer again; §5 records the probes I made after that.

**What made the inventory possible anyway:**

1. **Current GTFS files that sibling agents downloaded to this session's scratchpad today.** These are files I read today (verified), not files I fetched myself.
   - `scratchpad/F_gtfs/x2832/` is the **ATM / T-mobilitat CGIM simplified GTFS** (NAP 2059, Mobility Database mdb-2832). Its internal file dates are **2026-11-22**. It has 1,612 routes and 180 agencies, carries ATM operator prefixes, and is the authoritative cross-operator catalogue of what ATM integrates.
   - `scratchpad/F_gtfs/x2926/` is the **Generalitat interurban GTFS** (`busos-interurbans-GTFS.zip`, Mobility Database mdb-2926 / NAP 1364). Its files are dated **2026-11-20**, with 934 routes and 110 agencies. It is byte-identical in size (24,085,885 B) to the territori.gencat.cat ZIP that `docs/research/MOVENTIS_SOURCES.md` described on 2026-11-23.
   - `scratchpad/F_gtfs/feeds_v2.csv` is the Mobility Database catalogue. `scratchpad/F_ref/tl_atlas.json` is a Transitland atlas extract.
2. **Repository history.** An August 2026 ATM catalogue snapshot (`git show 6105dea:data/cache/routes.json`, 1,610 routes) agrees with the November file. The repository also holds code that was run against **Sagalés** (`git show 398aac0^:src/sagalesTracker.js`, Aug 2026) and **Moventis** (`git show 85b586e -- app/moventis.go`, 2026-11-23), plus the Generalitat **Mou-te** client (`git show 7a2a69c^:src/mouteClient.js`).
3. **Third-party open-source code on GitHub**, which was reachable through raw.githubusercontent.com:
   - `Piscu/buses-sagales-realtime`, a Sagalés client;
   - `rogerbacardit/movilidad-bcn` (`lib/moventis.mjs`);
   - `jtayped/moventis-lleida`, whose endpoint documentation is copied in `scratchpad/F_ref/moventis-api.md`.
4. **WebSearch snippets** (operator app-store listings, municipal PDFs, news), for operators, apps and real-time claims.

**Legend used in the tables:**
- **[V-gtfs]**: verified today from the current ATM (2026-11-22) or Generalitat (2026-11-20) GTFS in the scratchpad (route_id given).
- **[V-repo]**: verified from code in this repository that ran against the endpoint, with the date stated.
- **[V-probe]**: I fetched it myself today (see §5).
- **[R-3p]**: reported by third-party source code or README, not fetched by me.
- **[R-search]**: reported by a web-search result today, not fetched.
- **[H]**: hypothesis or inference, needs checking.

**Scope.** Every municipality of the province of Barcelona that is not one of the 36 AMB members. Those 36 are excluded even where the brief listed them: **Barberà del Vallès, Badia del Vallès, Ripollet, Montcada i Reixac, Sant Cugat (including Valldoreix), Cerdanyola, Castellbisbal, Corbera de Llobregat, Sant Andreu de la Barca, Pallejà, El Papiol, Molins de Rei, Montgat, Tiana, Badalona, Cervelló, La Palma, Begues, Torrelles** and the rest. Barberà's LB1 and Sarbus's Sant Cugat/Valldoreix/Cerdanyola urbans (prefix SAB) are therefore out of scope. Corbera's L1–L4 (Autocorb) are also out of scope.

---

## 1. Summary findings

- The non-AMB province has about **50 municipalities with some municipal or urban-type bus**: a fixed urban line, a local circular, a station feeder that is labelled "Urbà", or a municipal TAD (demand-responsive service). About **16 are "real" multi-line urban networks**: Sabadell, Terrassa, Mataró, Manresa, Granollers conurbation, Rubí, Vic, Igualada, Sitges, Mollet, Lliçà d'Amunt, Caldes de Montbui, Berga, Vilafranca, Vilanova i la Geltrú and Bigues i Riells.
- **Static data exists for almost all of them**, through three official channels:
  - the **ATM CGIM GTFS**: own prefixes MAT, TUS, RUB, MAN, GRA, SAG, FYT, CIN, COS, BGE, BGS, OSO, TCC, VFP, ABR, SSL and CUB, plus GEN for lines contracted by the Generalitat;
  - the **Generalitat interurban GTFS**, which contains about 60 "Urbà de …" lines because the Generalitat holds title to many small-town urbans;
  - **NAP** per-operator feeds: Transgran 2171, Manresa Bus 2170, Urbà de Vic 2162, Sagalés Osona 2169, Costa 2172, Mataró–St Celoni 2173/2204/2205, Bages 2202/2203, Direxis Masats 1983, Direxis TGO 1984, TCC 1580, Casas 1578, Pujol 1577, Montferri 2556, Mataró 1173 and Terrassa 1175.
- **Gaps in static data:** **Terrassa (TMESA)** is *absent* from ATM CGIM. Its only feed is NAP 1175, whose last version ran to May 2026, and Mobility Database marks it "inactive". **Vilanova i la Geltrú's urban bus** is absent from the ATM simplified feed. **Tordera** (municipal BUS 1–3) is in no feed at all.
- **No official real-time feed covers any non-AMB urban network.** T-mobilitat's open GTFS-RT carries only AMB, TMB, FGC and Rodalies ([V-repo], docs/research/MOVENTIS_SOURCES.md, 2026-11-23); its ATM prefix table marks every other prefix "RT: NO". There is no SIRI or GTFS-RT on NAP either.
- **Real time exists only through operator systems.** Each family uses one backend for all its towns:
  - **Avanza** (Mataró, Terrassa/TMESA, Rubí): SIRI SOAP in Mataró ([V-repo], in production in Arribo), plus per-city apps. The hosts for Terrassa and Rubí are unknown.
  - **Sagalés** (Transgran, BusManresa, Urbà de Vic, Mollet, Caldes, Lliçà, Bigues, Parets, Sant Celoni, Cardedeu, Pineda–Calella…): the public JSON at `www.sagales.com/real-time-bus/{routeId}/{dir}`. It is GTFS-RT-shaped JSON with **vehicle GPS positions**, stop updates and a polyline. **[V-probe] today:** all 96 Catalan urban lines answered, and about 55 had live GPS vehicles at 11:10 CET (§5.1). This is the richest unofficial source in the province.
  - **Moventis** (Casas urbans in Vilassar, Cabrera, Premià, Masnou; TCC Sitges / Sant Sadurní; Moventis Costa in Malgrat and Palafolls; Sarbus C4 in Castellar): the public JSON behind `www.moventis.es` "Temps real". It gives **stop predictions only, with no GPS**. [V-probe]: the catalogue holds 164 lines, all flagged `TREAL=S`; live `real:"S"` predictions were seen for the Masnou/Teià lines C-15 and C-17. Vilanova i la Geltrú is **not** in the Moventis catalogue.
  - **TUS Sabadell**: its own app gives stop predictions; the backend is not identified.
  - **Direxis** (TGO Olesa/Vacarisses; Masats Igualada): apps claim real-time estimates and tracking; the backend is not identified.
  - **Monbus/Hispano Igualadina** (Abrera, Esparreguera): a new app, Oct 2026, with a live map; coverage is unknown.
  - **Alsina/ALSA** (Berga), **Autocars del Penedès** (Vilafranca), **HIFE** (Cubelles), **Llacunense**, **Montferri**, **Cingles** and municipal services: no real time found.
- **Mou-te (Generalitat)** answers `nextdeparturesNEW?…&useRealTime=` for every GEN line, which includes many small-town urbans. It sits behind a client-side derived header token (see §4.7). Treat it as not reusable without permission.

---

## 2. Master table

RT = real time. "Stop pred." = predicted arrival times at stops. GPS = vehicle positions. Static: ATM = ATM CGIM GTFS (NAP 2059/2060, also t-mobilitat.cat with registration); GEN = Generalitat interurban GTFS (territori.gencat.cat ZIP / NAP 1364); NAP n = NAP file id (free API key; mirrored by Transitland as `gtfs-source-feeds.transit.land/es-nap-n.zip`).

### 2.1 Maresme

| Municipality | Operator | Lines (codes) | RT? | RT source | Static source | Notes |
|---|---|---|---|---|---|---|
| **Mataró** | Avanza (Mataró Bus) | 8: L1–L8 (`MAT_1…8`) [V-gtfs] | **Yes**: GPS and stop predictions | SIRI SOAP `https://sirimataro.avanzagrupo.com/Siri/SiriWS.asmx`, public account `Mataro`/`Mataro*WS` [V-repo, in production]; "Mataró Bus" app (iOS id1062561505) | ATM `MAT`; NAP 1173 (mdb-2768) | Arribo's current scope. Summer beach service on L6/L7 historically (2008 PDF) [R-search] |
| Vilassar de Mar | Empresa Casas (Moventis) | C13 "Urbà de Vilassar de Mar" (`GEN_1497`; Moventis id 161); C12 Cabrils–Vilassar (`GEN_0832`) [V-gtfs] | Possible stop pred. | moventis.es `GetTiemposParada` (catalogue TREAL=S for every line [V-probe]) | GEN; ATM GEN; NAP 1578 (Casas) | |
| Cabrera de Mar | Casas | C16 "Urbà de Cabrera de Mar" (`GEN_1498`) | Possible stop pred. | moventis.es | GEN; NAP 1578 | |
| Premià de Mar | Casas | C18 "Urbà de Premià de Mar" (`GEN_1803`); C14 Premià de Dalt–Premià de Mar (`GEN_0575`) | Possible stop pred. | moventis.es | GEN; NAP 1578 | C14 timetable extended 1 Apr 2025 [R-search] |
| Premià de Dalt | Casas | C14 (shared); 862 Premià de Dalt–Intercanviador 804 (`GEN_1887`) | Possible stop pred. | moventis.es | GEN | Feeders rather than an urban network |
| El Masnou | Casas | 848 "C19 Servei urbà del Masnou" (`GEN_1711`, Moventis id 340); also 845 C15 Teià–Masnou, 847 C17 Teià–Masnou–Teià | **Yes, partly: live `real:"S"` predictions for C-15 and C-17 at stop 7170; C-19 showed only timetable times at probe time [V-probe]** | moventis.es | GEN; NAP 1578 | The municipal "BUS" service charter is published (elmasnou.cat memòria 2023) [R-search] |
| Teià | Casas | C15 (845), C17 (847) (`GEN_0273`, `GEN_2214`) | Possible stop pred. | moventis.es | GEN | |
| Alella | Sagalés | 646 "Alella urbanitzacions – el Masnou" (`GEN_0251`); 690 Alella–el Masnou (`GEN_0015`) | Possible GPS | sagales.com real-time-bus | GEN | |
| Sant Andreu de Llavaneres | Casas | C22 Llavaneres–Estació (`GEN_0642`) | Possible stop pred. | moventis.es | GEN | Station feeder |
| Sant Vicenç de Montalt / Caldes d'Estrac | Casas | C21 TAD with demand services (`GEN_0704`); C20 interurban | Probably none for the TAD | — | GEN | TAD |
| Argentona | Sagalés (Mataró–St Celoni) | 570 "Argentona Urbanitzacions (Festa Major)" (`CIN_570`) | — | — | ATM `CIN`; NAP 2173 | **Seasonal (festival) only.** No regular urban line found [R-search] |
| Malgrat de Mar | Circuitos Ruri / Moventis Costa (Pujol) | L4M "Urbà de Malgrat de Mar" (`GEN_1495`) | Possible stop pred. | moventis.es (brand Moventis Costa) | GEN; NAP 1577 (Pujol) | ATM prefix PUJ is described as "Urbà de Palafolls"; GEN carries both |
| Palafolls | Ruri / Moventis Costa | L5 "Urbà de Palafolls" (`GEN_1670`) | Possible stop pred. | moventis.es | GEN; NAP 1577 | |
| Pineda de Mar / Calella | Sagalés Costa (and Barcelona Bus, Sagalés group) | 691 Pineda–Calella (`COS_691`, 45 stops) [V-gtfs] | **Yes: GPS [V-probe]** (3 vehicles) | sagales.com (operator Barcelona Bus SL) | ATM `COS`; NAP 2172 | A 2025 Pineda/Calella/ATM/Barcelona Bus agreement covers the Pineda–Calella service [R-search] |
| Sant Pol / Sant Cebrià / Canet | Sagalés Costa | 628 Castellar d'Indies–St Cebrià–Vistamar–St Pol; 629 Can Palau–St Cebrià–Vistamar–St Pol–Canet (`COS_628/629`) | Possible GPS | sagales.com | ATM `COS` | Links housing estates (urbanitzacions) to the coast; low frequency |
| Tordera | Ajuntament (municipal) | BUS 1, BUS 2, BUS 3 "Urbanitzacions" | None known | — | **No GTFS anywhere** (PDF timetables on tordera-prd.diba.cat) [R-search] | Municipal fee under Ordinance 34 |
| Arenys de Mar | Municipal TAD | On-demand only (app or 900 69 65 66; €2/€3) | — | — | none | No fixed urban line [R-search] |
| Canet, Santa Susanna, Pineda (own urban), Vilassar de Dalt, Cabrils, Arenys de Munt | — | No dedicated urban line found | — | — | — | Served by interurban lines only |

### 2.2 Vallès Occidental (non-AMB)

| Municipality | Operator | Lines | RT? | RT source | Static | Notes |
|---|---|---|---|---|---|---|
| **Sabadell** | TUS (Transports Urbans de Sabadell, municipal company) | 26 routes [V-gtfs `TUS_*`]: L1, L2, L3, L4, L5, L7, L8, L10, L11, L12, L14, L15, L23, L44, L55, L80; festius F1–F6, F15; night N1, N4; SEM (European Mobility Week) | **Yes**: stop pred. | "TUS – Bus Sabadell" app (iOS id730326007) and stop e-panels [R-search]. Backend not identified | ATM `TUS` only. **No NAP feed found** in Mobility Database or Transitland | L12 serves Sant Quirze Parc; L2 reaches La Creu de Barberà (AMB) |
| **Terrassa** | TMESA (Transports Municipals d'Egara; 80% Avanza, 20% Ajuntament) | About 17 routes in NAP 1175 GTFS [R-search via Mobility Database]; 2018: 12 regular, 1 PMR (reduced-mobility), Mercat, Terrassa Plaça, 1 night | **Yes**: stop pred. | "TMESA – Bus Terrassa" app (iOS id918469320). An Avanza backend is likely but its host is unknown [H] | **Not in ATM CGIM** [V-gtfs: no TMESA agency]; NAP 1175 (mdb-2716 "inactive", validity ended May 2026); opendata.terrassa.cat / datos.gob.es "Paradas y horarios de autobuses urbanos de Terrassa" (tld-5846 deprecated) | Biggest static gap. A new network awaits the concession tender. Festa Major shuttle (terrassa.cat PDF, Jul 2026) |
| **Rubí** | Rubíbus (Avanza) | 7: 1–7 (`RUB_1…7`) [V-gtfs] | **Probably**: stop pred. | "Rubí-bus" app by Avanza Spain (id1342129103) shows arrival times [R-search]; host unknown | ATM `RUB`; no NAP feed found | Agency URL rubibus.com |
| Sant Quirze del Vallès | TUS (L12); Sarbus/Moventis (TAD) | TUS L12 Estació Centre–Sant Quirze Parc; `SAB_365` "TAD CB Transport a demanda Can Barata" | L12 via TUS app | TUS app | ATM `TUS`, `SAB` | The PMUS (urban mobility plan) only *proposes* a town-only urban bus [R-search] |
| Castellar del Vallès | La Vallesana (Moventis/Sarbus) | C4 Castellar–St Feliu del Racó–el Balcó (`GEN_0228`; Moventis id 5) is the local line; C1 to Sabadell | Possible stop pred. (catalogue flag TREAL=S [V-probe]) | moventis.es | GEN; NAP 1581 | The C6 urban was replaced by on-demand taxi in 2012 [R-search] |
| Palau-solità i Plegamans | Ferrocarriles y Transportes (Sagalés group) | 296 "Urbà de Palau-solità i Plegamans" (`GEN_1469`, 38 stops) | **Yes: GPS [V-probe]** | sagales.com | GEN | |
| Vacarisses | Direxis TGO | M10 "Autobús urbà de Vacarisses (TAD)" (`GEN_2201`); M5B to Torreblanca station | Possible | DIREXIS TGO app | GEN; NAP 1984 | |
| Viladecavalls | Direxis TGO | M6A Viladecavalls–Terrassa shuttle (`GEN_1864`) | Possible | TGO app | GEN | Feeder |
| Matadepera, Polinyà, Sentmenat, Ullastrell, Rellinars, Gallifa, Sant Llorenç Savall | — | Interurban only (M8A/M8D, B3, 335 TAD…) | — | — | GEN | No urban bus found. Santa Perpètua's circular 295 is listed under Vallès Oriental |

### 2.3 Vallès Oriental

| Municipality | Operator | Lines | RT? | RT source | Static | Notes |
|---|---|---|---|---|---|---|
| **Granollers + Canovelles + Les Franqueses + La Roca** | **Transgran** (Sagalés; L52 run by Cingles Bus, Sagalés group) | L1 Can Gili–Hospital, L3 Pl. Europa–Jutjats, L4 Granollers–Canovelles, L6 Les Franqueses–Granollers, L7 El Lledoner–Can Bassa, L20, L21, L22, L51 Granollers–La Roca Village, L52 Sta Agnès–La Roca–Granollers [V-gtfs `GEN_1590–1594,1739,1280,1698`, `GRA_914,907`] | **Yes: GPS and stop pred. [V-probe]** | sagales.com real-time-bus (live on L1, L3, L4, L6, L7, L21, L22, L51, L52, 512); TransGran app (iOS id1212854867) | ATM `GEN` and `GRA`; **NAP 2171** (Transitland f-transgran) | The lines are split between ATM prefixes GEN and GRA. Agreement for 2025 published in BOPB (provincial gazette), 20 Jun 2025 |
| **Mollet del Vallès** | Sagalés | L.1, L.2 (`SAG_396`, `SAG_329`) | **Yes: GPS [V-probe]** | sagales.com | ATM `SAG` | New L2 route chosen by public participation in Feb 2025 [R-search] |
| Sant Fost de Campsentelles | Sagalés | 389 Servei Urbà de Sant Fost; 389.1 Estació–Ajuntament; 389.2 Ajuntament–La Conreria; 389.3/389.4 school | **Yes: GPS on 389.1 and 389.2 [V-probe]** | sagales.com | GEN | Found in the Sagalés catalogue [V-probe] |
| Parets del Vallès | Sagalés | 390 "Urbà de Parets" (`GEN_1541`); 370/375 circulars Parets–Montmeló–Montornès | **Yes: GPS on 390 [V-probe]** | sagales.com | GEN | |
| Montmeló / Montornès del Vallès | Sagalés | 370, 375 circulars (`GEN_0561`, `GEN_0518`); 427 | Possible | sagales.com | GEN, ATM `SAG` | Shared inter-town circulars |
| **Lliçà d'Amunt** | Sagalés | A1, A2, A4, A5, A7, A11, A21, A22, A37, A42 + A40 (Festa Major night bus) | **Yes: GPS on A1, A2, A4, A5, A7, A22 [V-probe]** | sagales.com | GEN | The largest small-town "Urbà" set |
| Lliçà de Vall | Sagalés | LV1 Can Salgot, LV2 Ca l'Esteper | Possible | sagales.com | GEN | |
| Bigues i Riells | Sagalés | 364, 377/383, 382 | Possible | sagales.com | GEN | |
| **Caldes de Montbui** | Ferrocarriles y Transportes / Sagalés Vallès Oriental | 291 Font Enamorats, 293 Can Valls (GEN), 298 Cementiri, 289 housing-estate TAD, 299 Festa Major night (`FYT_*`) | Possible | sagales.com | GEN, ATM `FYT`; NAP 2204 (Sagalés Mataró–St Celoni / F&T) | |
| Cardedeu | Sagalés | 591 BUC "Urbà de Cardedeu" (`GEN_1213`) | **Yes: GPS [V-probe]** | sagales.com | GEN | |
| Sant Celoni | Cingles Bus (Sagalés group) | 598 "Urbà de Sant Celoni" (`GEN_0690`); 589 Sant Celoni–La Batllòria (`CIN_589`); 588 to Boscos del Montnegre | Possible | sagales.com | GEN, ATM `CIN` | |
| Santa Maria de Palautordera | Cingles Bus | 597 "Urbà" (`GEN_0250`) | Possible | sagales.com | GEN | |
| L'Ametlla del Vallès | Sagalés | 348 Servei Urbà L'Ametlla–Granollers; 424 Servei Urbà L'Ametlla–La Garriga; 347 Festa Major (`SAG_347`, seasonal) | **Yes: GPS on 348 [V-probe]** | sagales.com | GEN, ATM `SAG` | "Servei Urbà" names from the Sagalés catalogue [V-probe] |
| Llinars del Vallès / Sant Antoni de Vilamajor / Sant Pere de Vilamajor | Sagalés | 582, 583 "Servei Urbà de Vilamajor" | **Yes: GPS on 582 [V-probe]** | sagales.com | GEN | |
| Vilanova del Vallès / Vallromanes | Sagalés | 596 SOD "Servei Urbà de Vilanova del Vallès i Vallromanes a Granollers" (demand-responsive) | **Yes: GPS [V-probe]** | sagales.com | GEN | |
| Santa Perpètua de Mogoda / La Llagosta | Sagalés | 295 circular Santa Perpètua–La Llagosta–Santa Perpètua | **Yes: GPS [V-probe]** | sagales.com | GEN | Listed among Sagalés's urban lines |
| La Garriga, Martorelles, Canovelles (own service) | — | Covered by 424 (shared with L'Ametlla), 426 TAD, 376 and Transgran | — | — | GEN | No dedicated urban line |

### 2.4 Bages, Osona, Lluçanès, Moianès, Berguedà

| Municipality | Operator | Lines | RT? | RT source | Static | Notes |
|---|---|---|---|---|---|---|
| **Manresa** | BusManresa (Sagalés) | 12: L1–L5, L8 Perimetral, L11 Centre Històric, L12 Campi qui Jugui, FB (L6 festius), FP (L7 festius), N9, N10 (`MAN_791–804`) [V-gtfs]; also 705 Barri del Xup, 707 Cementiri (Sagalés Bages) | **Yes: GPS and stop pred. [V-probe]** | sagales.com (live on L1–L5, L8, L11); BusManresa app (id1158939179) | ATM `MAN`; **NAP 2170** (f-manresa~bus) | |
| Sant Fruitós de Bages | Sagalés Bages | 789 circular Sant Fruitós–Les Brucardes; 785 (`BGE_789/785`) | Possible | sagales.com | ATM `BGE`; NAP 2202/2203 | |
| Sant Vicenç de Castellet | Sagalés Bages | 770 "SMT Sant Vicenç de Castellet" (`BGE_770`, 21 stops) [V-gtfs] | **Yes: GPS [V-probe]** | sagales.com (Transbages SL) | ATM `BGE` | Looks like a municipal service ("SMT") [H] |
| Sant Joan de Vilatorrada, Navarcles, Súria, Sallent, Navàs | — | Interurban to Manresa only (760/761…) | — | — | GEN | [R-search] |
| **Vic** (+Calldetenes, Gurb, la Guixa) | 25 Osona Bus SA (Sagalés group), held by the Generalitat | L1 Serra de Senferm, L2 Remei–Horta Vermella, L3 Nadal–Hospital, L4 Calldetenes–Estació, L6 Sentfores–la Guixa–Tanatori, L7, L8 [V-gtfs] | **Yes: GPS [V-probe]** | sagales.com ids 971–978; **new network L-1…L-10 from 2026-12-01** (ids 980–989) | GEN; **NAP 2162** (f-autobús~urbano~de~vic); NAP 2169 Sagalés Osona | |
| Manlleu, Torelló, Sant Pere de Torelló | 25 Osona Bus | 434 TAD Sant Hipòlit–Manlleu; 482/483 Sant Pere de Torelló–Torelló | — | — | GEN | No urban network [R-search] |
| Lluçanès (Prats…), Moianès (Moià, Castellterçol) | 25 Osona, 17 Bages Bus, F&T | Only TADs (494, 496, 730, 250, 251) | — | — | GEN | No urban bus |
| **Berga** | Alsina Graells (ALSA) | L1 Circuït interior, L2 Avià–Berga, L3 Casampons (`GEN_1543,1744,1745`) [V-gtfs] | None found | — | GEN | Many TADs feed Berga |

### 2.5 Anoia, Alt Penedès, Garraf, Baix Llobregat (non-AMB)

| Municipality | Operator | Lines | RT? | RT source | Static | Notes |
|---|---|---|---|---|---|---|
| **Igualada** (+Vilanova del Camí, Sta Margarida de Montbui, Òdena) | SA Masats (Direxis Masats); Òdena line by Hispano Igualadina | LC1 interior, LC2 exterior, LTF festius (`GEN_1082,1084,1563`); LTV, LTM; L0378 Òdena circumvallation; L1866/L1867 Clic.cat industrial estates | Unconfirmed | DIREXIS MASATS app (id1610603894) [R-search] | GEN; **NAP 1983** (mdb-2761 / f-direxis~masats) | |
| Piera | Montferri | L0216 "Urbà de Piera: Piera (FGC)–Capellades" (`GEN_0216`) | Unknown | Montferri app (id1228083439) | GEN; NAP 2556 | |
| Capellades | Montferri | C1 Capellades–FGC station (`GEN_0215`) | Unknown | Montferri app | GEN | Feeder |
| **Vilafranca del Penedès** | Autocars del Penedès | L1, L2 "Bus urbà de Vilafranca" (`VFP_hcmt`, `VFP_9tfk`; L1 has 38 stops) [V-gtfs] | None found | A 2014 plan for vehicle tracking (SAE) at stops; status unknown | ATM `VFP` | OSM tags the operator as Monbus, which conflicts |
| Sant Sadurní d'Anoia | TCC (Moventis) | SSDA L1 (`TCC_158`) | Possible stop pred. | moventis.es | ATM `TCC`; NAP 1580 | |
| Gelida | La Hispano Llacunense | L1567 "Bus Funicular" (`GEN_1567`) | — | — | GEN | |
| **Sitges** | TCC (Moventis) | SL1 Poble Sec–Vallpineda, SL2 Can Pei–Terramar, SL3 Llevantina–Quint Mar, SL5 school-hours extra (Maria Ossó), TrenSitges (tourist train) (`TCC_*`) | Possible stop pred. | moventis.es; Moventis app | ATM `TCC`; NAP 1580 (mdb-2749; the version seen ended May 2026) | Official charter numbers them L1–L3/L5 [R-search] |
| **Vilanova i la Geltrú** | Unknown today. TCC (Moventis) ran it under a concession from 1994; the 2021 charter lists L1 Tacó–Càmping, L2 Càmping–Tacó [R-search] | L1, L2 (2021) | Unknown | **Not in the Moventis catalogue today [V-probe]** | **Not in ATM simplified** [V-gtfs]; maybe in NAP 1580 [H] | Static gap |
| Cubelles | HIFE | 1 "Velázquez/Dalí – Zona Comercial" (`CUB_1`, 39 stops, centroid 41.215,1.664) [V-gtfs] | None found | — | ATM `CUB` | hife.es lists the Cubelles urban service |
| Sant Pere de Ribes | Municipal TAD (managed by AMTU) | No urban bus (PMUS 2022); TAD | — | — | — | e16 express serves Roquetes [R-search] |
| Martorell | Unknown (agency "Martorell", URL martorell.cat) | LU Hospital Sagrat Cor–La Vila (`SSL_1255`, 44 stops), 100% electric | Unknown | — | ATM `SSL` | |
| Abrera | Hispano Igualadina (Monbus) | "Urbà" Nucli urbà–Estació FGC (`ABR_1`) | Unknown | Monbus Catalunya app (Oct 2026, live map) [R-search] | ATM `ABR` | |
| Esparreguera | Hispano Igualadina; TGO | L1114 "Urbà d'Esparreguera" (`GEN_1114`); M3 Esparreguera–Olesa FGC feeder (TGO, electric, opened Dec 2022) | Possible | Monbus app / TGO app | GEN; NAP 1984 | |
| Olesa de Montserrat | Direxis TGO | M2 "Urbà d'Olesa" (`GEN_0532`, Oasi / Ribes Blaves branches) | Claimed | DIREXIS TGO app (iOS id1570632475: "real-time estimates, track your bus") [R-search] | GEN; NAP 1984 (mdb-2775) | |
| Sant Esteve Sesrovires | La Hispano Llacunense | L1147 "Urbà" (`GEN_1147`) | — | — | GEN | |
| Collbató, El Bruc, Castellví de Rosanes, Vallirana | — | No urban bus found | — | — | — | |

### 2.6 Seasonal and event services seen in GTFS

- Argentona 570 (Festa Major)
- L'Ametlla 347 (Festa Major)
- Caldes 299 (Festa Major night bus)
- Lliçà d'Amunt A40 (Festa Major night bus)
- Lliçà A31 (24-hour moped race event)
- Sagalés 418 and 662 (Circuit de Catalunya events)
- TUS SEM (European Mobility Week)
- TCC TrenSitges (tourist train)
- Terrassa Festa Major shuttle (PDF only)

No summer beach bus for the 2026 season was found in GTFS for the Maresme. One historically ran on Mataró L6/L7.

---

## 3. Which feed carries what (static)

| Feed | Access | Covers (Barcelona province, non-AMB urban) |
|---|---|---|
| ATM CGIM simplified/full (NAP 2059/2060; t-mobilitat.cat registration token; Mobility Database mdb-2832/2826) | Free token or NAP key | Prefixes MAT, TUS, RUB, MAN, GRA, SAG, FYT, CIN, COS, BGE, BGS, OSO, TCC, VFP, ABR, SSL, CUB, plus every GEN urban. **Not covered: TMESA, Vilanova urban, Tordera** |
| Generalitat interurban (`busos-interurbans-GTFS.zip`, no auth) | Open | About 60 "Urbà de …" lines (Vic, Igualada, Berga, Lliçà, Bigues, Caldes, Parets, Palau-solità, Cardedeu, Sant Celoni, Palautordera, Olesa, Esparreguera, Sant Esteve, Gelida, Piera, Vilassar de Mar, Cabrera, Premià, Masnou, Malgrat, Palafolls, Transgran L1–L52, Vacarisses TAD). Codes are in `route_short_name` (`L0xxx` internal codes, or public codes such as A5 and LC1); timetable seconds are non-zero |
| NAP per-operator | Free API key; Transitland mirrors | 2171 Transgran, 2170 Manresa, 2162 Vic, 2169 Osona, 2172 Costa, 2173/2204/2205 Mataró–St Celoni, 2202/2203 Bages, 1983 Masats, 1984 TGO, 1580 TCC, 1578 Casas, 1577 Pujol, 2556 Montferri, 1173 Mataró, 1175 Terrassa (stale) |
| Municipal open data | Varies | Terrassa (opendata.terrassa.cat; datos.gob.es l01082798) |

---

## 4. Real-time sources by operator family (endpoint shapes)

### 4.1 Avanza: Mataró, Terrassa (TMESA), Rubí
- **Mataró [V-repo, in production]:**
  - SOAP 1.1 POST to `https://sirimataro.avanzagrupo.com/Siri/SiriWS.asmx`, using the SIRI StopMonitoring / VehicleMonitoring envelope (`app/siri.go`).
  - The `AccountId`/`AccountKey` pair is `Mataro`/`Mataro*WS`. These are public client defaults shared by every consumer of the portal; they are overridable by `MATARO_SIRI_ACCOUNT_ID/KEY`.
  - Returns vehicle GPS and stop predictions.
- **Terrassa and Rubí:** official apps exist ("TMESA – Bus Terrassa", "Rubí-bus", both published by Avanza) and show stop arrival times. The backend host was **not identified**: the sandbox has no DNS for avanzagrupo.com, so I could not check whether `siri<city>.avanzagrupo.com` exists [H]. Next step: inspect the apps' traffic, or ask Avanza/TMESA (TMESA is 20% municipally owned, which gives an institutional route). ToS: no published open-data licence.

### 4.2 Sagalés: Transgran, BusManresa, Urbà de Vic, Vallès Oriental, Costa, Bages
All of these were observed in code, not probed by me today: [V-repo] = the repository's `src/sagalesTracker.js` (Aug 2026); [R-3p] = `Piscu/buses-sagales-realtime` `src/lib/sagalesClient.js` (Oct 2026).

**Line catalogue.** `GET https://www.sagales.com/{es|en|fr|''}/lineas/{1..4}` returns HTML; category 1 = urban (U), 2 = interurban, 3 = night, 4 = express. The internal route id is parsed from JS calls such as `modalTerm(291)`, `mapaLinia('282',0)` and `pdfBus(...)`.

**Real-time per line and direction.** `GET https://www.sagales.com/{lang}/real-time-bus/{routeId}/{dir}`, with `dir` 0 or 1 and an optional `?bus=true`. It returns JSON:
```
{ linia:{…longName…}, schedule:{routeDirectionAnada, routeDirectionTornada},
  ruta:{ stops:[{stopCode,stopName,stopLat,stopLon,stopsequence,commercialCity}], shapes:"<encoded polyline>" },
  bus:{ entities:[{ vehicle:{ vehicle:{id}, trip:{tripId,directionId,headSign},
         postion:{latitude,longitude,bearing,speed}, currentStopSequence },   // sic "postion"
       tripUpdate:{ trip:{…}, stopTimeUpdate:[{stopSequence, arrival:{time,delay}}] } }] } }
```
This is GTFS-RT FeedEntity semantics in JSON, with **real vehicle GPS** and per-stop delay. The upstream misspells the key as `postion`, so read both spellings. Example ids from the repository: N82=680, N83=683, 603=603, N70=280, N71=380, N73=580.

**Other endpoints:**
- `GET /{lang}/next-bus/{stopId}`: HTML fragment with the next arrivals at a stop.
- `GET /{lang}/termometre/{routeId}/{dir}?origen=&desti=`: HTML "thermometer" (stop strip).
- `GET /front/js-nexus/planificador/funcionsAjax.php?...&idioma=`: planner AJAX.
- `GET /{lang}/sagales-on-demand/load?...`

**Usage notes:**
- There are no CORS headers and no authentication.
- The feed includes only vehicles that are in service and tracked. The app text says real time covers "some lines".
- The earlier Arribo tracker polled with a 12 s cache; Piscu polls every 25 s with concurrency 3. Be polite and respect robots.txt.
- No licence covers these endpoints. Static data has an official route (NAP, attribution "Powered by MITRAMS").

### 4.3 Moventis: Casas, TCC, La Vallesana/Sarbus, Moventis Costa
All observed in code: [V-repo] `app/moventis.go`, 2026-11-23; [R-3p] `rogerbacardit/movilidad-bcn/lib/moventis.mjs` and `scratchpad/F_ref/moventis-api.md`.

**Endpoints** (base `https://www.moventis.es`, headers `X-Requested-With: XMLHttpRequest`):
- `GET /{es|ca}/moventis/{lang}/lines`: about 3.6 MB, one row per line per operating day. Fields include `ID_LINEA`, `COD_LINEA`, `DESC_LINEA`, `ID_ZONA`, `ID_SUBZONA` (1 = urban, 3 = interurban), `COLOR`, `MARCA` and **`TREAL` ("S" when the line has real time)**.
- `GET /{lang}/moventis/{lang}/brands`, `/zones`, `/incidencias` (alerts).
- `GET /api/json/GetTrayectos/{ID_LINEA}/{YYYYMMDD}`: variants with `TrayectosDet[].Parada{ID_PARADA, DESC_PARADA, MUNICIPIO, LATITUD, LONGITUD}`, plus km.
- `GET /api/json/GetKMLs/{line}/{segment}`: geometry as KML. `GetParadas/...` returns timetables.
- `GET /api/json/GetTiemposParada/{lang}/{ID_PARADA}/{ID_LINEA}/0` returns
  `[{idLinea, desc_linea, trayectos:{ "<dest>":[{minutos:"26 min 42.37 s", real:"S"}] | {"00044":{minutos:"44' 00''", real:"N", hora:"22:08"}} }, incidencias}]`.
  `real:"S"` marks a tracked prediction; `"N"` marks a timetable time.

**Usage notes:**
- **No GPS and no vehicle id.** Positions can only be estimated from predictions; Arribo labels them `positionSource:"stop_predictions"`.
- robots.txt asks for a 10 s crawl delay. Arribo used one request at a time, at least 11 s apart.
- When throttling, the site answers with a placeholder in which every field is "A".
- The official path is the developer form (`/ca/com-aconseguir-les-dades-gtfs-de-moventis`), which offers weekly GTFS and "real-time data" for approved partners.
- Third-party code says the network has 89 lines across Casas, Moventis, Sarbus, Sarfa and TCC. Which urban lines (C13, C16, C18, C19, SL1–3, SSDA L1, Vilanova L1/L2, L4M, L5) have `TREAL=S` is **unverified**; see §5.

### 4.4 TUS Sabadell
The official app "TUS – Bus Sabadell" (id730326007) shows real arrival times, and there are stop e-panels [R-search]. No public API was found, and no third-party GitHub client turned up (repository search for "tus sabadell" found nothing relevant). The backend endpoint is unknown. Next steps: find an AJAX "temps de pas" call on tus.es, or ask TUS, which is municipal and so a good institutional candidate.

### 4.5 Direxis: TGO (Olesa, Vacarisses, Viladecavalls, Esparreguera M3) and Masats (Igualada)
Apps "DIREXIS TGO" (id1570632475) and "DIREXIS MASATS" (id1610603894). The TGO listing claims "Estimacions en temps real" and "Fes el seguiment del teu autobús en temps real"; an older version said "some lines" [R-search]. A 2024 Generalitat note said TGO planned to add each bus's real-time position. The backend is unknown, and the ElMeuBus DX app (id1608392736) may share it [H]. Static: NAP 1983/1984.

### 4.6 Monbus / Hispano Igualadina (Abrera, Esparreguera); Montferri (Piera, Capellades); Autocars del Penedès (Vilafranca); ALSA (Berga); HIFE (Cubelles)
- Monbus launched a "Monbus Catalunya" app in Oct 2026 with a live map and stop predictions [R-search]. Whether it covers the urban lines is unknown.
- Montferri has an app (id1228083439) with unknown capability.
- No real time was found for the others.

### 4.7 Generalitat Mou-te (all GEN lines, including about 60 small-town urbans)
[V-repo, old client]:
- Base `https://mou-te.gencat.cat/MouteAPI/rest/`.
- `infrastructure/nextdeparturesNEW?paradaId=&useRealTime=&language=` returns predictions.
- `infrastructure/stop/linesNEW?paradaId=`, `infrastructure/line/detailsNEW?lineId=&useRealTime=` and `alerts/lineNEW?lineId=` are the other calls.
- No GPS.

Requests carry a header token that the public web client derives on the client side (time-based hash). It is an access control, however weak, and the Generalitat publishes Mou-te only as a widget with no third-party API. **Recommendation:** do not reproduce it. Request access formally (DGTM / ATM CGIM).

### 4.8 Aggregators
Moovit and Google show "live" times for TUS, TCC, Sagalés and Monbus. That data comes from operator agreements, and there is no reusable API.

---

## 5. Probes made after the hosts reopened (2026-11-24, about 10:05–10:25 UTC) [V-probe]

All probes were polite: one request at a time, 3 s apart for Sagalés and at least 11 s apart for Moventis (its robots.txt sets `Crawl-delay: 10`). Raw responses are in `scratchpad/C_probe/`. Hosts still refused today: tus.es, tmesa.com, rubibus.com, transgran.cat, territori.gencat.cat.

### 5.1 Sagalés: urban catalogue and live vehicles, all urban lines
- `GET https://www.sagales.com/es/lineas/1` → 200, 390 KB HTML. It lists **101 urban (category 1) lines**; parsed list in `C_probe/sag_urban_catalog.txt`. Five Dénia (Valencia) lines are excluded below. robots.txt disallows only /uploads/, *.pdf, /sale/* and the museum pages, so `/real-time-bus/` is not disallowed.
- `GET https://www.sagales.com/es/real-time-bus/{id}/0` returned **200 application/json for all 96 Catalan urban lines** (direction 0 only, Tuesday about 11:10 CET). Shape confirmed:
  - top keys `linia, ruta, bus, schedule, visibleButtonChangeRoute, directionTravel`;
  - `bus.header = {gtfsRealtimeVersion:"1.0", incrementality:"FULL_DATASET", timestamp:<ms>}`;
  - `bus.entities[].vehicle = {postion:{latitude,longitude,bearing,speed,odometer}, timestamp:<ms epoch>, currentStopSequence, currentStatus, stopId, occupancy, congestionLevel, trip, vehicle}`;
  - `tripUpdate.stopTimeUpdate[] = {stopId, stopSequence, arrival:{time(ms),delay(s)}, departure, realTime:true, scheduleRelationship}`;
  - `linia.agency` names the legal operator. Timestamps are **milliseconds**, not GTFS-RT seconds.
- **Quirk:** one physical vehicle appears as several entities, one for its current trip and more for upcoming trips, with identical position and timestamp. Example: Vic L-1 returned 2 entities for 1 vehicle. Count distinct vehicles by `vehicle.id` or position. The key is misspelled `postion`.
- **Live GPS was present at probe time** on these lines (distinct vehicles in brackets):

  | Network | Lines with live vehicles |
  |---|---|
  | Transgran | L1 [4], L21 [3], L6 [3], L7 [2], L51 [2], L22, L3, L4, L52, 512 Granollers–Les Franqueses–Cànoves |
  | BusManresa | L1 [4], L2 [3], L4 [2], L8 [6], L3 SOD, L5, L11 |
  | Urbà de Vic (current network) | L-1, L-2, L-3, L-4, L-6, L-8 |
  | Mollet | L.1 [4], L.2 |
  | Pineda–Calella | 691 [3] |
  | Vallès Oriental small towns | Parets 390 [2], Cardedeu 591 BUC, Palau-solità 296, Caldes 291 and 293, Bigues 383, Sant Fost 389.1 and 389.2, Alella/Masnou 646 and 690, L'Ametlla 348, Vilamajor 582, Vilanova del Vallès/Vallromanes 596 SOD, Santa Perpètua–La Llagosta 295 |
  | Lliçà d'Amunt | A1, A2, A4, A5, A7, A22 |
  | Others | Sant Celoni–La Batllòria 589; Sant Vicenç de Castellet 770 |

- **No vehicle at probe time:** Bigues 364.x, 377 and 382; Sant Celoni 598; Palautordera 597; Lliçà de Vall LV1/LV2; Lliçà A11, A21, A37, A42; Transgran L20; Vic L-7; Manresa FB/FP/N9/N10; seasonal and school lines. This can mean off-service at that hour, the opposite direction only, or untracked. Repeat at peak hours before concluding.
- **New facts from the catalogue that are not in the earlier tables:**
  - Sant Fost has its own urban service: 389 Servei Urbà, plus 389.1–389.4.
  - Vilamajor has 582/583 "Servei Urbà de Vilamajor" (Llinars – Sant Antoni / Sant Pere de Vilamajor).
  - L'Ametlla del Vallès has 348 (to Granollers) and 424 (to La Garriga), both "Servei Urbà".
  - Vilanova del Vallès and Vallromanes have 596 SOD (demand-responsive).
  - Bigues i Riells has 364.1/364.2/364.3 "servei municipal".
  - Caldes has 291.1/293.1 (school variants).
  - Santa Perpètua–La Llagosta has circular 295.
  - **Vic switches to a new network on 2026-12-01**: L-1 Estació–Barri Osona, L-2 Universitat–Horta Vermella, L-3 Estadi–Can Pau Raba, L-4 Universitat–Hospital, L-5 Hospital–Caputxins, L-6 El Sucre–Universitat–Hospital, L-7 El Blanqueig–Centre, L-8/L-9 school-hours perimeter extras, L-10 Transversal (Sagalés ids 980–989). The GTFS in §2 still shows the old L1–L8.

### 5.2 Moventis: line catalogue and stop predictions
- `GET https://www.moventis.es/es/moventis/es/lines` → 200, 2.67 MB JSON, 8,486 rows, **164 distinct lines**. Fields: `ID_LINEA, COD_LINEA, DESC_LINEA, ID_ZONA, ID_SUBZONA, TREAL, FORMA, COLOR, TEXT_COLOR, ID_EXPLOTADORA, ID_CONCESION, ID_GRUPO, ADAPTADA, MARCA, DIAS_QUE_CIRCULA`. `/brands` → 200.
  - **`TREAL` is "S" on all 164 lines**, so the flag does not tell which lines are actually tracked.
  - Non-AMB urban lines in the catalogue:
    - Casas: C-13 (161), C-16 (60), C-18 (385), C-19 (340), C-14 (64), C-15 (56), C-17 (715), C-21 (67), C-22 (58), C-12 (55), 862 (627).
    - TCC: SL1 (112), SL2 (243), SL3 (156), SL5 (157), SSDA L1 (158).
    - Moventis Costa (brand 122375): L4M Urbà Malgrat (434), L5 Urbà Palafolls (435), L1361 Santa Susanna–Malgrat–Palafolls (438).
    - Sarbus: C4 Castellar–El Balcó–St Feliu del Racó (5), TAD CB Can Barata (365).
  - **There is no Vilanova i la Geltrú urban line in the Moventis catalogue** (and none in ATM). The 1994–2021 TCC concession may have ended, so the operator is unknown (gap).
- `GET /api/json/GetTrayectos/340/20261124` (C-19) and `/112/20261124` (SL1) → 200; stops carry `MUNICIPIO`.
- `GET /api/json/GetTiemposParada/ca/7170/340/0` (El Masnou, Mercat Vell) → 200. It returned **`real:"S"` predictions for C-15 and C-17** (for example `"03 min 43.19 s"`) and **timetable-only (`real:"N"`) times for C-19 and C-10** at that moment. So Moventis tracks at least some Maresme local lines live, and per-trip tracking varies.
- The Sitges SL1 stop query (`/ca/13739/112/0`) returned the throttle placeholder (all fields "N") despite the 11 s gap. It needs a retry with a longer back-off; Sitges tracking is not verified.

### 5.3 T-mobilitat open GTFS-RT
`GET https://t-mobilitat.cat/opendata/trip_updates/json/user/token/open` → 200, 960 KB, **1,735 entities: TMB 813, AMB 765, ROD 102, FGC 55**. This confirms that **no non-AMB urban bus operator** (MAT, TUS, RUB, MAN, GRA, SAG, TCC, GEN…) publishes trip updates there today.

---

## 6. Gaps and next steps

1. **Terrassa (TMESA)** has no current static feed: it is absent from ATM, NAP 1175 is stale since May 2026, and the municipal dataset is deprecated. Real time is app-only. Ask TMESA/Ajuntament, or check opendata.terrassa.cat.
2. **Vilanova i la Geltrú urban**: absent from ATM simplified **and from the Moventis line catalogue** [V-probe]. Its current operator and data are unknown; ask the Ajuntament or check NAP 1580.
3. **Tordera** BUS 1–3 exists only as PDFs, and the Arenys de Mar and Sant Pere de Ribes TADs have no data.
4. **TUS Sabadell, TMESA, Rubíbus, Direxis**: real-time backends not identified.
5. **Sagalés:** done for direction 0 at one instant (§5.1). Repeat at peak hours and in both directions to classify the lines that showed no vehicle.
6. **Moventis:** `TREAL` is "S" for every line, so it is not informative. Sample `GetTiemposParada` on each urban line at peak hours to see which return `real:"S"`. Sitges is still unverified because of throttling.
7. **Martorell LU** operator unidentified (the CGIM agency is just "Martorell").
8. **Vilafranca** operator conflict (Autocars del Penedès in ATM; Monbus in OSM).
9. WebSearch budget ran out before Castellar's current lines, the Sitges/Vilanova NAP 1580 contents and a TUS API search were done.
10. Arribo also cannot use the official real-time options: T-mobilitat GTFS-RT carries no non-AMB urban bus, and there is no SIRI on NAP. Bilateral requests to Avanza (Terrassa, Rubí), Sagalés, Moventis and TUS are the official route.

---

## 7. Key source URLs (web-search results today, not fetched unless marked)

| Topic | URL |
|---|---|
| TUS app | https://apps.apple.com/us/app/-/id730326007 |
| TMESA app | https://apps.apple.com/us/app/-/id918469320 |
| Rubí-bus app | https://apps.apple.com/us/app/-/id1342129103 |
| Mataró Bus app | https://apps.apple.com/us/app/-/id1062561505 |
| BusManresa app | https://apps.apple.com/es/app/busmanresa/id1158939179 |
| TransGran app | https://apps.apple.com/es/app/transgran/id1212854867 |
| Sagalés app | https://apps.apple.com/app/id1449464623 |
| DIREXIS TGO app | https://apps.apple.com/us/app/-/id1570632475 |
| DIREXIS MASATS app | https://apps.apple.com/us/app/-/id1610603894 |
| Montferri app | https://apps.apple.com/us/app/id1228083439 |
| TMESA GTFS (Mobility Database) | https://mobilitydatabase.org/feeds/gtfs/mdb-2716 |
| Terrassa open data | https://datos.gob.es/en/catalogo/l01082798-paradas-y-horarios-de-autobuses-urbanos-de-terrassa |
| Terrassa service charter | https://governobert.terrassa.cat/transparencia/wp-content/uploads/sites/2/2025/06/05_carta_autobusos_def.pdf |
| Rubíbus 2017 satisfaction study (Avanza group) | https://rubi.cat/ca/fitxers/documents-ok/area-de-serveis-territorials/mobilitat/transport-public/estudi-index-de-satisfaccio-del-client-de-les-linies-d2019autbus-urba-de-rubi-2017 |
| Moventis TCC service charters | https://www.moventis.es/sites/moventis/files/imce/carta_de_serveis_tcc_2021.pdf · https://www.moventis.es/sites/moventis/files/imce/moventis-tcc_carta_servicios_cast_102025.pdf |
| Moventis service charter 2022 (Castellar) | https://www.moventis.es/sites/moventis/files/imce/carta_de_servicios_rev._des_2022_ca_ca.pdf |
| HIFE Cubelles urban service | https://www.hife.es/en/urban-services/17 |
| Sant Pere de Ribes PMUS (no urban bus) | https://santperederibes.cat/documents/10180/68844/Sintesi+Pla+Mobilitat+Urbana+Sostenible+mar%C3%A7+2022/94b8dbc2-70ec-4f32-afaf-f8f97d7b47b2 |
| Tordera BUS 1–3 | https://tordera-prd.diba.cat/media/repository/tordera/transports/BUS_1___URBANITZACIONS___BUS_1.pdf |
| Arenys de Mar TAD | https://arenysdemar.cat/ARXIUS/2025/MOBILITAT/Triptic_TAD_Arenys_de_Mar__2_.pdf |
| Mollet L2 participation | https://participa311-mollet.diba.cat/processes/L2Mollet |
| Monbus RT app (ATM news) | https://omc.cat/en/web/portal-atm/w/la-t-mobilitat-es-posa-en-marxa-en-una-quarantena-de-l%C3%ADnies-interurbanes-de-l-operador-monbus-hispano-igualadina |
| Third-party code: Sagalés client | https://github.com/Piscu/buses-sagales-realtime |
| Third-party code: Moventis client | https://github.com/rogerbacardit/movilidad-bcn |
| Third-party code: Moventis Lleida | https://github.com/jtayped/moventis-lleida |
| Probed today [V-probe] | https://www.sagales.com/es/lineas/1 · https://www.sagales.com/es/real-time-bus/{id}/0 · https://www.moventis.es/es/moventis/es/lines · https://www.moventis.es/api/json/GetTrayectos/{line}/{date} · https://www.moventis.es/api/json/GetTiemposParada/ca/{stop}/{line}/0 · https://t-mobilitat.cat/opendata/trip_updates/json/user/token/open |

**Legal note.** None of the operator JSON endpoints (Sagalés, Moventis) has a published licence or API terms. They are the operators' own public website back-ends, called without authentication. Sagalés's robots.txt does not disallow them; Moventis's asks for a 10 s crawl delay. Reuse in a product should go through the operators' official channels: Moventis's developer form, and a Sagalés data request. The static GTFS (ATM, NAP, Generalitat) is openly licensed with attribution ("Generalitat de Catalunya"; "Powered by MITRAMS"; ATM: cite the source and update date).
