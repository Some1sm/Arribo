# D — Buses in Barcelona and the 36 AMB municipalities: networks, operators, static and real-time sources

> **Lead-researcher check, 2026-11-24:** AMB's own keyless GTFS-RT files are confirmed live: `https://www.ambmobilitat.cat/transit/trips-updates/trips.bin` → 200 (280 KB protobuf), `.../transit/alerts/alerts.bin` → 200 (127 KB). The community-mentioned `.../transit/vehicle-positions/vehicle-positions.bin` → **404** (does not exist). So: AMB = open stop-level predictions + alerts, **no open GPS**.

Research date: **2026-11-24**. Research only; no application code was written.

## 0. Read this first: what could and could not be verified today

**The egress policy of this session blocked every official host.** These hosts were refused, either with proxy `CONNECT 403` or with DNS `ENOTFOUND` from WebFetch:

- `www.ambmobilitat.cat`, `api.ambmobilitat.cat`, `www.amb.cat`
- `t-mobilitat.cat`, `www.atm.cat`
- `developer.tmb.cat`, `api.tmb.cat`, `www.tmb.cat`
- `opendata-ajuntament.barcelona.cat`, `mobilitydatabase.org`, `files.mobilitydatabase.org`, `transit.land`

To fetch these sources live, the hosts must be added to the session's network allowlist. **No live probe of AMB, TMB or T-mobilitat ran today.** That includes the T-mobilitat GTFS-RT entity counts the brief asked for.

What was verified today (marked **[V-today]**):

| Artefact | How obtained | Snapshot |
|---|---|---|
| **AMB static GTFS**, `google_transit.zip`, the same file as `www.ambmobilitat.cat/OpenData/google_transit.zip` | Mobility Database mirror `storage.googleapis.com/storage/v1/b/mdb-latest/o/es-barcelona-autos-castellbisbal-gtfs-892.zip?alt=media` (reachable), 8,055,356 B | `feed_version=20260603` (window 2026-06-03 to 06-08). Fully analysed. |
| AMB GTFS `agency.txt`, `routes.txt` and `feed_info.txt` | Raw GitHub mirrors (`bmantepe/stop-location`, `OSM-Catalan/tpcatvsosm`, `yopaseopor/tempsrealcat`, `enekomateos/amb_app_garmin`) | Newest: `feed_version=20260729`. Older: 20260112 and 20250701. |
| **TMB static GTFS** | Mobility Database mirror `mdb-latest/.../es-barcelona-transports-metropolitans-de-barcelona-tmb-gtfs-2359.zip`, 7,603,813 B | `feed_version=084410042026002`, valid 2026-04-10 to **2026-12-05**. Fully analysed. |
| **ATM/T-mobilitat-derived urban and interurban GTFS subset**: `routes.txt` and `agency.txt` with ATM `PREFIX_` ids | Raw GitHub mirror `OSM-Catalan/tpcatvsosm/gtfs_cat_urba_bus` | 2,072 routes, 179 agencies. The date is unknown, because `feed_info` has no dates. |
| Mobility Database catalogue entries for AMB GTFS-RT, AMB, TMB, ATM and NAP feeds | Raw GitHub (`MobilityData/mobility-database-catalogs`) | Current `main` |
| Community API documentation and captures | Raw GitHub (`alegoml/tmb-cli` docs, captures dated 24–27 Oct 2026; `gariasf/viapeninsula` measurements dated 24–25 Sep 2026; `esteveavi/ibus-mcp`; `apuratepp/tmb`; `alemuro/tmb`) | See §4 |

The rest is marked **[R]** (reported). Where a claim comes from a dated first-hand capture by someone else, its date is given. That includes this repository's own `docs/research/MOVENTIS_SOURCES.md`, which was verified live on **2026-11-23**, the day before today.

The scratchpad has the downloads and the analysis output:

- `(research scratch files, not committed)`: the extracted AMB GTFS.
- `(research scratch files, not committed)`: the per-municipality and per-route analysis.
- `(research scratch files, not committed)`: the extracted TMB GTFS.
- `(research scratch files, not committed)`: the analysis script.

The WebSearch budget shared by all agents in this turn ran out midway. A few municipal urban-bus details are therefore still open; they are listed in §7.

---

## 1. Executive summary

1. **Bus in the AMB is three data worlds:**
   - **TMB:** Barcelona city plus TMB lines into L'Hospitalet, Cornellà, Esplugues, Sant Joan Despí, Sant Just, El Prat, Montcada, Sant Adrià, Badalona and Santa Coloma.
   - **AMB "Bus Metropolità":** 11 agencies in one AMB GTFS. These are TUSGSAL, Avanza/Baixbus, Monbus, Moventis, Soler i Sauret, TGO and Aerobús, including the NitBus N lines.
   - **Generalitat (DGTM) interurban concessions** that run inside the AMB, plus a few town-run urban buses: Sarbus and Marfina (Moventis), Autocorb, R. Font (Rosanbus brand), HIFE, Soler i Sauret, TGO and TUS. These are found only in the Generalitat, ATM or NAP GTFS.
2. **Real-time ranking for buses in the AMB:**
   - **AMB operators:** the best case. **Official, keyless GTFS-RT TripUpdates and Alerts**:
     - `https://www.ambmobilitat.cat/transit/trips-updates/trips.bin`
     - `https://www.ambmobilitat.cat/transit/alerts/alerts.bin`

     The same data is relayed as `AMB_…` entities in the open T-mobilitat GTFS-RT. The feeds carry absolute epoch arrival and departure times and a `vehicle.id` or `label`, but **no GPS** [R: catalogued in MDB 2368/2369 with `authentication_type: 0`; captured by alegoml on 2026-10-25; relay verified by the repo's MOVENTIS doc on 2026-11-23].
   - **TMB buses:** official **iTransit** per-stop predictions at `https://api.tmb.cat/v1/itransit/bus/parades/{codi}`, which needs a free `app_id` and `app_key`. The response includes `id_bus`, and it also returns AMB-operator lines at TMB stops. TMB has **no network-wide bus feed and no public GPS** [R, captured 2026-10-25]. T-mobilitat does relay `TMB_…` trip updates, but which TMB mode they cover was not determined (see §5).
   - **Generalitat lines and municipal urban buses outside the AMB GTFS:** **no open real-time.** This covers Sant Cugat urban (Sarbus), Barberà LB1, Corbera urban (Autocorb), Badia, Begues, Cervelló and the rest. Only static data exists.
3. **Vehicle positions:** no open source publishes GPS for any bus in the AMB.
   - T-mobilitat's `vehicle_positions` returns **404** [R 2026-11-23].
   - The AMB "v2" API had `/bus/vehicles`, but only behind an `x-api-key`. The retired Arribo code used a key extracted from the AMB app; **do not reuse it**.
   - A community client polls `www.ambmobilitat.cat/transit/vehicle-positions/vehicle-positions.bin` with a "not available" fallback. Whether that file exists is **unverified**.
4. **Coverage gap by municipality [V-today, AMB GTFS 2026-06-03].** Six of the 36 municipalities have **zero AMB-GTFS stops**: Badia del Vallès, Barberà del Vallès, Begues, Cervelló, La Palma de Cervelló and Sant Andreu de la Barca. Sant Cugat has only MB3. All of them depend on Generalitat or municipal lines with no open real-time.

---

## 2. Municipality and network table

Abbreviations:

- *AMB-GTFS* = `ambmobilitat.cat/OpenData/google_transit.zip` (agency ids 34–79).
- *AMB-RT* = `ambmobilitat.cat/transit/trips-updates/trips.bin` plus `alerts.bin`, or the T-mobilitat `AMB_` relay.
- *TMB-RT* = `api.tmb.cat/v1/itransit/bus/parades/{code}`.
- *GEN* = Generalitat DGTM interurban GTFS (`busos-interurbans-GTFS.zip`, see the sibling research) or the ATM/T-mobilitat GTFS (`GEN_` prefix).
- *ATM* = T-mobilitat static GTFS. It needs a free token: register via `POST t-mobilitat.cat/opendata/static/register/request/`, then download from `/opendata/static/download/{token}`.

**How the lines were assigned:** the AMB line lists come from joining AMB `stop_times`, `stops` and `stop_areas` (the INE municipality code per stop) **[V-today]**. TMB lines outside Barcelona come from joining TMB stop codes to AMB `stop_areas`, using the shared code space described in §3.3 **[V-today]**. Lines marked "GEN/ATM" come from the ATM-derived route list **[V-today, undated snapshot]**.

| # | Municipality | Operator(s) | Lines (AMB-GTFS unless noted) | Real-time? | RT source | Static source | Notes |
|---|---|---|---|---|---|---|---|
| 1 | **Barcelona** | TMB; plus AMB operators on routes into the city | **TMB:** 74 numbered lines, including Bus del Barri / proximity lines 102–196; **H** H2–H16 (8); **V** V1–V33 odd (17); **D** D20, D40, D50; **X** X1, X2 (Prat XPRES), X3; 983 "Llançadora Funicular" (all from TMB GTFS, 105 bus routes). **AMB lines in Barcelona:** 59, including **NitBus** N0–N9, N11–N18, N20, N23, N24, N28; **Aerobús** A1, A2; 86, 87 (Monbus Horta); 88, 89, PR4 (Moventis Port); L16, M12, M14, M15, X30, LH2; L70, L72, X43, X70, X79; L80, L86, L94, L95, L97, X80, X83, X84, X86, X95, X97; B20, B21, B23, B24, B25, M19, M28; JM | TMB: yes, per stop. AMB lines: yes, network-wide. | TMB-RT (key); AMB-RT (no key); T-mobilitat relay | TMB GTFS (`api.tmb.cat/v1/static/datasets/gtfs.zip`, key; MDB mirror 2359); AMB-GTFS | **Bus Turístic** and **El Meu Bus** (on-demand, Torre Baró, Torre Baró Sud–Vallbona, Montbau–Vall d'Hebron, Farró–Galvany) appear as `NOM_FAMILIA` "BusTuristic" and "Bus a la Demanda" in `transit/linies/bus` [R], but **neither is in the TMB GTFS** [V-today]. Cemetery lines 102, 104 and 107 have 6–12 trips a day. |
| 2 | **Badalona** | DIREXIS TUSGSAL (44); TMB (H10); GEN (Sagalés 360, 849; R. Font 690) | B2, B3, B4, B5, B7, B8, B14, B15, B18, B20, B21, B23, B24, B25, B29, B31, B32, B80, B81, B82, M1, M6, M19, M26, M27, M28, M30; N2, N6, N9, N11 (31 lines). TMB H10 | Yes | AMB-RT; TMB-RT for H10 | AMB-GTFS; TMB; GEN | B15 has Thursday-only services (pattern `0001000`, likely a market-day variant). There are 10 service ids, and shapes are duplicated per service. |
| 3 | **Badia del Vallès** | Sarbus/Marfina (Moventis), GEN | **None in AMB-GTFS.** GEN: A2 (Badia–Barberà–Barcelona), B1, B4, B6 | **No** | — | GEN/ATM (`GEN_0050`, `0618`, `0187`, `SAB_14`, `SAB_16`, `SAB_22`) | A 2022 town flyer mentions an "URBÀ" service with metropolitan social fares; its operator and line code are unconfirmed [R]. |
| 4 | **Barberà del Vallès** | Sarbus (Moventis); TUS Sabadell; GEN | **None in AMB-GTFS.** **LB1** "Urbà de Barberà" (GEN_1008 / SAB_30 "Pl. Espanya–Baricentro"); TUS L2 and F2 (Can Deu–La Creu de Barberà); GEN A1, B1, B2, B6 | **No** | — | GEN/ATM (`SAB_`, `TUS_`) | TUS has its own app; no open feed is known. |
| 5 | **Begues** | HIFE (GEN) | **None in AMB-GTFS.** GEN 902 (Olesa de Bonesvalls–Begues–Gavà and –Barcelona) | **No** | — | GEN (`GEN_0112`, `GEN_0530`) | HIFE reinforced the 902 [R, hife.es]. A Begues urban bus was not found (§7). |
| 6 | **Castellbisbal** | DIREXIS TGO (37) | CS1, CS2, CS3, CS4 | Probably (AMB agency) | AMB-RT [R for the feed; not checked per agency] | AMB-GTFS; also ATM `TGO_AMB` CS1–CS4 | CS1–CS4 have 3–4 origin–destination variants per direction: cemetery and station short turns. GEN: TGO L66, L67, C6; Sarbus C7. |
| 7 | **Castelldefels** | Avanza "Baixbus" (56); Monbus (M5) | CF1, CF2, GA1, GA2, L94, L95, L96, L97, L99, X95, X97, N14, N16, N19, M5 | Yes | AMB-RT | AMB-GTFS | **CF1 has `pickup_type=2` / `drop_off_type=3` on 122 stop-times** (phone or driver-arranged stops). CF2, L95, L96, L97, X95 and X97 have **Wednesday-specific services** (`0010000`, likely the market-day detour). L94 and CF2 also reach Les Botigues de Sitges, which is outside the AMB (area 08270). |
| 8 | **Cerdanyola del Vallès** | Moventis (Cerdanyola) (79) | **CV1–CV5** (new agency; calendars start 2026-04-09) | Yes, presumed | AMB-RT | AMB-GTFS | CV1 has 5 and 3 origin–destination variants per direction and summer-only (`0000000` plus added dates) services. The older Sarbus urban lines SU1–SU3 still appear in the ATM snapshot, so they are probably stale. GEN: A4, A7, B7, E3, 648 and others. |
| 9 | **Cervelló** | Soler i Sauret (GEN); municipal service | **None in AMB-GTFS.** GEN: N52, 567, 575 | **No** | — | GEN | An AMB urban service from 2020 ran mornings fixed-route and **afternoons on demand**, booked via app or phone [R, 2020 Baix Llobregat forum deck]. The urban contract was re-tendered 2025-10-29 to 2025-11-28 (EU TED 903757/25); the winner is unknown [R]. |
| 10 | **Corbera de Llobregat** | Soler i Sauret (34); Autocorb (GEN) | PF1 (AMB). **Autocorb urban L1, L2 (Corbera–St Andreu), L3, L4**; 560, 566, 574, e8 | Partly (PF1 only) | AMB-RT for PF1 | AMB-GTFS; GEN (`GEN_0906`, `0941`, `0943`, `0946`; `AUC_` in ATM) | — |
| 11 | **Cornellà de Llobregat** | Monbus i Julià (62); Moventis (69); Avanza; TMB | L46, L52, L74, L77, M5, M75, X79; L21, M12, M15; L82, L85, N13, N14, N15. **TMB 67, 68, 78, 94, 95** (94 and 95 are the "Circular Cornellà" lines) | Yes | AMB-RT; TMB-RT | AMB-GTFS; TMB | Cornellà's urban circulars are TMB lines. |
| 12 | **El Papiol** | Monbus (Papiol) (71) | PA1 (Circular int.), PA2 (Circular ext.) | Yes, presumed | AMB-RT | AMB-GTFS | Both lines are one-direction loops. GEN: L59, L67. |
| 13 | **El Prat de Llobregat** | Moventis (69); Moventis Port (74); Monbus; Avanza; Aerobús; TMB | **PR1, PR2, PR3, PR5**, 89, PR4; L20; L70, L72, L77, L78; L80, L86, L94, L95, L99, N17, N18, N19; A1, A2. **TMB 21, 46, 65, X2** | Yes | AMB-RT; TMB-RT | AMB-GTFS; TMB | **PR3 "Est. Rodalies–Platja"** runs weekends only and seasonally: added from mid-June, removed from October. **PR5 "Les Moreres–Platja"** runs on summer weekends: its daily service is cancelled and a dates-only service added on Sat/Sun from 2026-06-06. PR2 and PR3 have `pickup_type=2` / `drop_off_type=3` rows. |
| 14 | **Esplugues de Llobregat** | Soler i Sauret (34); Monbus; Moventis; Avanza; TMB | **EP1, EP2**, JM, JT; L46, L77; L20, L21, X30; L85, N12, N14, N15. **TMB 63, 67, 68, 78, 95, 157** | Yes | AMB-RT; TMB-RT | AMB-GTFS; TMB | — |
| 15 | **Gavà** | Avanza (56); Monbus | **GA1, GA2**, L80, L82, L85, L94, L95, L96, L97, L99, X80, X83, N14, N16, N19; L77, M5 | Yes | AMB-RT | AMB-GTFS; GEN 902 | GA1 and GA2 serve Gavà Mar (beach). |
| 16 | **L'Hospitalet de Llobregat** | Moventis (69); Avanza; Monbus; TUSGSAL; TMB | **LH1, LH2** (Moventis circulars, one direction each); L16, L20, L21, M12, M14, M15; L80, L82, L85, L86, L94, L95, X95, N13–N18, N20; L52, L70, L72; N2, N3, N28. **TMB 46, 52, 54, 65, 157, D20, H12, V1, X3** (and likely more: some TMB stops have no area code) | Yes | AMB-RT; TMB-RT | AMB-GTFS; TMB | LH2 has 2 origin–destination variants. The ATM listing names SAB (Sarbus) for "Urbà de L'Hospitalet", but the urban circulars are in the AMB feed as Moventis agency 69. |
| 17 | **La Palma de Cervelló** | Autocorb (GEN) | **None in AMB-GTFS.** GEN 560, 566 (Corbera–La Palma–Molins) | **No** | — | GEN | — |
| 18 | **Molins de Rei** | Soler i Sauret (34) | **MB1, MB2, MB3** (MB3 runs Molins–FGC La Floresta, entering Sant Cugat) | Yes, presumed | AMB-RT | AMB-GTFS | MB1 and MB2 are one-direction loops. GEN: L60, L61, L62M, 560, 566, 567, L68, L69, N52, L59, L67. |
| 19 | **Montcada i Reixac** | TMB; TUSGSAL | **TMB 137, 138** ("Circular Montcada i Reixac 1/2"), 62, 76, 96, 104, 183. AMB: B18, N3, N23 | Yes | TMB-RT; AMB-RT | TMB; AMB-GTFS | Montcada's urban circulars are TMB lines. GEN: 648, 685 (R. Font, i.e. Rosanbus). |
| 20 | **Montgat** | TUSGSAL | B29, B31, B32, M30, N9 | Yes | AMB-RT | AMB-GTFS | — |
| 21 | **Pallejà** | Soler i Sauret | **PF1** (Pallejà–Corbera), **PF2** (Fontpineda: **1 trip per weekday**) | Yes, presumed | AMB-RT | AMB-GTFS | PF2 is effectively a school or once-a-day run. GEN: L69. |
| 22 | **Ripollet** | Moventis (Cerdanyola); R. Font / Rosanbus (GEN) | CV2, CV4 (AMB). GEN: 620, 685, 690, E4, B2, B5, 648 | Partly | AMB-RT for CV2 and CV4 | AMB-GTFS; GEN | CV4 runs 10 trips a weekday. A Ripollet urban line was not confirmed (§7). |
| 23 | **Sant Adrià de Besòs** | TUSGSAL; TMB | B7, B14, B20, B21, B23, B25, M26, M30, N2, N6, N11. **TMB 60, H10, H14, V33** | Yes | AMB-RT; TMB-RT | AMB-GTFS; TMB | — |
| 24 | **Sant Andreu de la Barca** | Autocorb, TGO, Soler i Sauret (GEN) | **None in AMB-GTFS.** GEN: L2 (Corbera–St Andreu), L66 (Castellbisbal–SAB), L0783 "Clic.cat – CSNY Valldaina – Sant Andreu de la Barca" (an on-demand "Clic.cat" product) | **No** | — | GEN | The town's own urban bus is unconfirmed (§7). |
| 25 | **Sant Boi de Llobregat** | Monbus i Julià (62); Avanza | **SB1, SB2, SB3**; L70, L72, L74, L76, L77, L78, M5, M75, X70, X79; L80, L82, L85, L86, L96, L97, L99, X84, X86, N13, N14, N16, N20 | Yes | AMB-RT | AMB-GTFS | SB3 has 2 origin–destination variants. GEN: L61, 574, 575. |
| 26 | **Sant Climent de Llobregat** | Avanza | L88 (Viladecans–Sant Climent); N21 (night, Sant Climent–Gavà Mar) | Yes | AMB-RT | AMB-GTFS | — |
| 27 | **Sant Cugat del Vallès** | **Sarbus (Moventis)**, urban; Soler i Sauret (MB3) | AMB: MB3 only. **Sarbus urban (GEN/ATM `SAB_`):** L1 (Mira-sol), L2A, L2B, L2C, L3 (Les Planes–La Floresta–FGC), L4 (La Floresta), L5 (Les Planes), L7A, L7B, L7C, L8 (Esade), L9, L10 (Can Trabal), L11, R9, SJ (Polígon Sant Joan), PR (Roquetes shuttle), **TAD LP** (on-demand Les Planes), **TAD CT** (on-demand Can Trabal). Interurban: A4, A6, B7, B8, N62 | **No** (except MB3) | — (Moventis web "temps real" scraping is possible; see the repo's MOVENTIS doc) | ATM (`SAB_`), NAP 1581 (Sarbus) | **On-demand zones are modelled as GTFS routes named "TAD …"** in ATM. ATM also has TAD CB (Can Barata, in Sant Quirze). Unidentified "Línia V1–V4.2" (Pl. Estació–Mas Roig) also sit under `SAB_`; their municipality is unconfirmed. |
| 28 | **Sant Feliu de Llobregat** | Soler i Sauret; Monbus; Moventis; Avanza | **SF1, SF2, SF3** (all "Circular", Pl. Estació–Pl. Estació); L52, L77; L21, X30; N12 | Yes | AMB-RT | AMB-GTFS | SF2 splits Monday (`1000000`) from Tue–Fri (`0111100`). SF3 runs **weekends only** (`0000011`). TRAM T3 also serves the town. GEN: L51, L60, L62M. |
| 29 | **Sant Joan Despí** | Monbus; Moventis; Avanza; TMB | L46, L52, L77, X43, X79; L20, L21, X30; N12, N15. **TMB 63, 78, 157** | Yes | AMB-RT; TMB-RT | AMB-GTFS; TMB | — |
| 30 | **Sant Just Desvern** | Soler i Sauret; Monbus; Moventis; Avanza; TMB | EP1, EP2, JM, JT, SF1, SF2, SF3; L46, L52, L77; L21, X30; N12. **TMB 63, 157** | Yes | AMB-RT; TMB-RT | AMB-GTFS; TMB | GEN: L65 (Walden–Martorell). |
| 31 | **Sant Vicenç dels Horts** | Soler i Sauret | **SV1, SV2, SV3, SV4, ESC** (ESC = FGC–Instituts, school run, 3 trips) | Yes, presumed | AMB-RT | AMB-GTFS | SV1–SV3 are FGC loops. SV4 runs **Saturdays only** (8 stops, 11 trips). SV2 and SV4 have `pickup_type=2` / `drop_off_type=3` rows. GEN: L60, L62, L62M, L61A, L71, E20, L59A. |
| 32 | **Santa Coloma de Cervelló** | Monbus i Julià | L76 (St Boi–Torrelles) | Yes | AMB-RT | AMB-GTFS | A municipal urban or on-demand service is unconfirmed. Baix Llobregat on-demand *adapted* (PMR) transport covers the town [R]. |
| 33 | **Santa Coloma de Gramenet** | TUSGSAL; TMB | B14, B15, B18, B20, B21, B24, B5, B80, B81, B82, M1, M19, M27, M28, M30, N2, N6, N8, N9. **TMB V33** | Yes | AMB-RT; TMB-RT | AMB-GTFS; TMB | — |
| 34 | **Tiana** | TUSGSAL | B29, B32, M30, N9 | Yes | AMB-RT | AMB-GTFS | — |
| 35 | **Torrelles de Llobregat** | Monbus; Soler i Sauret (GEN) | L76. GEN: L62, L62M, L71, E20 | Partly | AMB-RT for L76 | AMB-GTFS; GEN | — |
| 36 | **Viladecans** | Avanza (56); Monbus | **VB1, VB2, VB4**; GA1, GA2, L80, L82, L85, L86, L88, L96, L97, L99, X80, X83, X84, X86, N14, N16, N19; M5. TMB 46, at the edge of the town | Yes | AMB-RT | AMB-GTFS | **VB4 "Centre–Platja" is a summer beach line**: all of its services are calendar-dates-only, 2026-06-01 to 2026-09-13. |

### Network-level rows

| Network | Operator | Lines | Real-time? | RT source | Static source | Notes |
|---|---|---|---|---|---|---|
| **TMB Bus** (city plus metro area) | TMB | 105 bus routes in GTFS: 74 numbered, H×8, V×17, D×3, X×3. `transit/linies/bus` lists 114, adding Bus Turístic and El Meu Bus families [R] | Per stop | `GET api.tmb.cat/v1/itransit/bus/parades/{code}` | TMB GTFS (key), `transit/*` GeoJSON | §4.1 |
| **NitBus** (N lines) | TUSGSAL (N0–N11, N23, N24, N28); Avanza (N12–N21) | N0, N1, N2, N3, N4, N5, N6, N7, N8, N9, N11, N12, N13, N14, N15, N16, N17, N18, N19, N20, N21, N23, N24, N28 (24 lines; colour `0062a1`) | Yes | AMB-RT | AMB-GTFS | **The 17 intercity N lines carry `continuous_drop_off=3`** ("coordinate with driver"), which encodes drop-off between stops on request. The Barcelona-internal N0, N4, N5, N7 and N28 carry `1`. Most N lines run all week (`1111111`) with one shape. Times run up to **31:xx**. |
| **Aerobús** | Monbus (Aerobús) (72) | A1 (T1), A2 (T2) | Yes, presumed | AMB-RT | AMB-GTFS | `ticketing_deep_link_id=aerobus_checkout` in the July snapshot. 948 and 547 trips a day. |
| **Bus Turístic** | TMB (Barcelona Bus Turístic) | Routes present in `transit/linies/bus` as family "BusTuristic" [R] | **Unknown** | — | Not in TMB GTFS [V-today] | Commercial product; no open data was found. |
| **El Meu Bus** (TMB on-demand) | TMB | Torre Baró, Torre Baró Sud–Vallbona Sud, Montbau–Vall d'Hebron, El Farró–Galvany; Vallbona Nord planned [R tmb.cat / barcelona.cat] | No | — | Not in GTFS [V-today] | Booked via the "El Meu Bus" app or 900 927 575. |
| **TMB "Bus del Barri" / Proximitat** | TMB | 102–196 range, e.g. 111 Tibidabo, 118 Mas Guimbau, 128 El Rectoret, 130 Can Caralleu, 137 and 138 Montcada | Yes | TMB-RT | TMB GTFS | Collserola-side neighbourhoods (Vallvidrera, Mas Guimbau, El Rectoret) are fixed-route Proximitat lines in GTFS. They are not on-demand. |

---

## 3. AMB static GTFS — technical section [V-today]

**URL:** `https://www.ambmobilitat.cat/OpenData/google_transit.zip`. It is open, has no key, and is republished every few days.

**Licence:** "Autorització segons Llei 37/2007". Reusers must cite AMB, not alter the data, and state the last-update date. Commercial reuse is allowed [R].

**Keyless mirror:** Mobility Database `mdb-892` at the `storage.googleapis.com/.../es-barcelona-autos-castellbisbal-gtfs-892.zip?alt=media` path. The id is misleadingly named "autos-castellbisbal"; it is the full AMB feed.

### 3.1 Files in the 2026-06-03 snapshot

| File | Size | Notes |
|---|---|---|
| `agency.txt` | 814 B | **11 agencies:** 34 Soler i Sauret; 37 DIREXIS TGO; 44 DIREXIS TUSGSAL; 56 Avanza; 62 Monbus i Julià; 69 Moventis; 71 Monbus (Papiol); 72 Monbus (Aerobús); 73 Monbus (Horta); 74 Moventis (Port); 79 Moventis (Cerdanyola) |
| `routes.txt` | 44 KB | 137 routes, all `route_type=3`. The July snapshot has 138 and the October capture 140 [R]. Extra columns: `continuous_drop_off`, `map_url`, `timetable_url` (PDF links on `serveis.ambmobilitat.cat`), and, from July, `ticketing_deep_link_id`. `route_url` = `https://app.ambmobilitat.cat/lines/busamb:{route_id}`. |
| `stops.txt` | 606 KB | 4,926 stops; 110 have `out_of_service=1`. **1,534 `stop_id` values are zero-padded** (`000477`), and for those `stop_code` = the id without padding. `stop_desc` gives the stop type: Marquesina 2,440, Pal 2,209, Banderola 176, Monolit 98. `stop_url` = `https://app.ambmobilitat.cat/stops/busamb:{id}`. |
| `trips.txt` | 3.2 MB | 29,848 trips. `trip_id` looks like `128.11.1.1.0`. **`trip_short_name` holds the full stop-list description**, not a short name. `trip_headsign` is always filled. |
| `stop_times.txt` | 44 MB | 926,189 rows. **Hours are not zero-padded** (`9:00:00`) and **run up to 31:xx**. About 86% of times have non-zero seconds, so times are precise to the second. 527 rows have `pickup_type=2` / `drop_off_type=3`: PR2 259, CF1 122, PR3 104, SV2 30, 88 8, SV4 4. Also has a `continuous_drop_off` column. |
| `calendar.txt` and `calendar_dates.txt` | 18 KB and 462 KB | Calendars run to 2027 and 2028, although `feed_info` covers only a 6-day window. Many services use `0000000` plus added dates. |
| `shapes.txt` | 8.6 MB | `shape_id` like `128.1.1.11`. **Shapes are duplicated per service id**: the shape count per route and direction equals the service count, not the number of geometric variants. |
| `transfers.txt` | 265 B | 7 rows, all type 0. |
| **`areas.txt` and `stop_areas.txt`** | 1 KB and 50 KB | **Not fare zones.** These map **INE municipality codes to names** (37 areas: the 36 AMB towns plus 08270 Les Botigues de Sitges) and assign 3,567 of 4,926 stops. **The header has a space after the comma** (`area_id, area_name`), names have **trailing tabs**, and lines end in CRLF. Strip all of these. |
| `feed_info.txt` | 165 B | `AMBMobilitat, ca, 20260603, 20260608`. |

### 3.2 GTFS-Fares v2

- The June snapshot has **no `fare_products.txt`, `fare_leg_rules.txt` or `fare_media.txt`**. Its `areas.txt` is municipalities only.
- The repo's MOVENTIS doc reports `areas.txt`, `fare_products.txt` and `fare_leg_rules.txt` in the **2026-11-23** zip [R, not re-checked: host blocked]. It also reports 8,076,904 B, 21 files, 29,823 trips and 100% `shape_id`.
- Fares v2 may therefore have been added between June and November. Re-check once `ambmobilitat.cat` is allowlisted.
- The **ATM integrated GTFS** carries Fares v2 for the integrated ATM zone system [R, viapeninsula].

### 3.3 Join keys and quirks

- **Static and RT trip ids change with each republication** [R, alegoml]. Always pair RT with the static zip of the same day. Keep a daily refresh; the window is about 6 days.
- **TMB and AMB share one stop-code space.** `stop_code` of an AMB stop on a TMB street equals TMB's `CODI_PARADA`: for example, AMB `001103` = TMB 1103, "Pl Catalunya – Portal de l'Àngel". 1,419 of TMB's 2,708 stops appear in AMB's GTFS [R, alegoml]. This was used today to map TMB lines to municipalities.
- **Branches and short turns are visible in the data** [V-today]:
  - Distinct origin–destination pairs per direction: CV1 (5 and 3), CS2 (4 and 2), CS1 (3), CS4 (3 and 2), N1 (2 and 4), B3 (2 and 3), M30 (2 and 2), X30 (2 and 2), 86 (3, loop), JM (2 and 2).
  - Short turns sometimes appear only as **one or a few trips**: ESC, PF1 "Parc Central", SV1 and SV2 "Barcelona–Llobregat".
- **One-direction loops** have only `direction_id=0`: LH1, LH2, MB1, MB2, PA1, PA2, SF1–SF3, SV1–SV4, 86, PR5, CS1, CS3, B8.
- **Day-specific splits:**
  - Wednesday (`0010000`) on CF2, L95, L96, L97, X95, X97 (Castelldefels).
  - Thursday (`0001000`) on B15.
  - Monday only on SF2.
  - Weekends only on SF3, PR3 and B31/B32 weekend variants.
  - Saturday only on SV4.
  - Mon–Sat (`1111110`) on L80, L86, L88, GA1 and GA2, with a separate Sunday service.
- **Seasonal lines** [V-today]:
  - **VB4** Viladecans beach: dates-only, 2026-06-01 to 2026-09-13.
  - **PR5** El Prat beach: summer weekend dates.
  - **PR3** El Prat beach: Sat/Sun pattern, with added dates from mid-June and removals from October.
  - August reduced timetables (`add` dates from 2026-08-03 on 86, LH2, CV1) are modelled as dates-only services.
- **Agencies missing from the AMB feed:**
  - **Sagalés, Rosanbus/R. Font, Oliveras, Mohn and Authosa** do not appear (snapshots from 2025-07 through 2026-07).
  - Transitland's legacy id `f-sp3e-authosa~mohnsl~oliverassl~rosanbussl~solerisauret~sgmt~tc` shows that **older** AMB feeds listed those operators.
  - Today the AMB-contracted lines run under the 11 agencies above. **Avanza 56 is the "Baixbus" concession.** The Rosanbus and Sagalés services inside the AMB are **Generalitat** lines.

---

## 4. Real-time sources — technical sections

### 4.1 TMB (developer.tmb.cat / api.tmb.cat) [R — host blocked; captures by alegoml/tmb-cli 2026-10-24..27, viapeninsula 2026-09-24/25]

**Access**

- **Auth:** query parameters `app_id` and `app_key` from a free developer.tmb.cat sign-up.
- **Errors:** a missing key returns `401 Authentication failed. Authentication parameters missing`. A wrong key returns `401 … Invalid credentials`, although the swagger says 403.
- **Quotas:** not published. No rate-limit headers have been seen.
- **CORS:** echoes `Origin`. Proxy the calls server-side anyway, so the key stays private.
- **Swagger files:** `developer.tmb.cat/assets/api-docs/v1/{ibus,imetro,transit,static,planner}/swagger.json`.
- **Terms:** cite TMB and the update date, and do not alter the data. Several public repositories embed TMB keys; **do not use them**.

**Bus real time:** `GET https://api.tmb.cat/v1/itransit/bus/parades/{codi_parada}`. One stop per call. About 2,600–2,700 stops in total.

```text
timestamp                 epoch ms (time of answer, not data time)
parades[]: codi_parada (str), nom_parada
  linies_trajectes[]: id_operador (int), transit_namespace ("bus" = TMB, "amb" = other AMB operator),
     codi_linia (int, e.g. 215), nom_linia ("V15"), id_sentit (1 anada / 2 tornada),
     codi_trajecte ("2151"), desti_trajecte
     propers_busos[]: temps_arribada (epoch ms), id_bus (int, "if available"),
                      info_bus.accessibilitat.estat_rampa ("SENSE_INCIDENCIA")
```

- Predictions come from the bus's last known position, "max precision one minute".
- **An unknown stop answers HTTP 200 with `parades: []`.** So does a stop served only by another operator, such as a TUSGSAL stop in Badalona.
- TMB stops **also list AMB-operator lines** (`transit_namespace: "amb"`, `id_operador` 6). Their times match AMB's feed within a few seconds, but the lists are incomplete. Prefer the AMB feed and drop TMB's `amb` entries.
- **Legacy iBus** (`/v1/ibus/stops/{id}`, `/v1/ibus/lines/{line}/stops/{id}`, documented at `/api-docs/v1/ibus_legacy`):
  - Response `data.ibus[]`: `line`, `destination`, `routeId`, `t-in-s`, `t-in-min`, `text-ca`.
  - TMB marks it **deprecated, "will disappear"**. Do not build on it.

**Metro real time** (context): `GET /v1/itransit/metro/estacions?estacions=…`. Without the parameter it returns the whole network.

**Static data**

- `GET /v1/static/datasets/gtfs.zip` (key; updated weekly; MDB mirror 2359).
- `GET /v1/transit/linies/bus`: GeoJSON with 114 lines. Fields: `CODI_LINIA`, `NOM_LINIA`, `DESC_LINIA`, `ORIGEN_LINIA`, `DESTI_LINIA`, `NOM_FAMILIA` (Convencionals, Verticals, Horitzontals, Diagonals, Proximitat, XPRESBus, Llançadores, Bus a la Demanda, BusTuristic).
- `/transit/linies/bus/{codi}/parades`.
- `/transit/parades`: 2,708 active stops with `CODI_PARADA`, `ID_POBLACIO`, …
- `/transit/elements/superficie/{tipus}/{lon}/{lat}/{dist}`.
- `planner/plan`: OpenTripPlanner 2. Its legs have `realTime: false`.

**TMB GTFS facts [V-today, snapshot 2026-04-10 to 12-05]**

- One agency, "TMB". 116 routes: 105 bus, 10 metro, 1 funicular (`route_type 7`).
- **Bus `route_id` = `2.<codi_linia>.<n>`**, for example `2.220.2999` = D20. The middle number is the iTransit `codi_linia`, which is the join key.
- Bus `stop_id` = `2.<codi_parada>`. Metro `stop_id` = `1.<codi_estacio>`. Entrances are `E.*` and parents `P.*`.
- Trip id looks like `2.220.85.3218709.2999`.
- Some long names carry a `<M>` prefix: 62, 96, 185.
- `frequencies.txt` covers only a few non-bus trips. There is `pathways.txt`, and the trip-to-route join has a 4-part service id.
- **There is no `feed_info` validity past 2026-12-05**, so this mirror expires in 11 days. Refresh it from `api.tmb.cat` with a key.

**TMB GTFS-RT:**

- None found on developer.tmb.cat in community docs or the Mobility Database (only the static mdb-2359).
- T-mobilitat relays **`TMB_` TripUpdates and Alerts** [R 2026-11-23: 161 TU and 51 alerts at 23:17]. Whether these are bus or metro trips was not determined (§7).

**Unofficial:** the TMB App and the tmb.cat "Temps d'espera" pages use the same `api.tmb.cat` back end [R, community repos]. No separate public endpoint is worth reverse-engineering.

### 4.2 AMB operator GTFS-RT (official, keyless) [R — host blocked]

| Feed | URL | MDB id | Auth |
|---|---|---|---|
| TripUpdates | `https://www.ambmobilitat.cat/transit/trips-updates/trips.bin` | 2368 (`entity_type: tu`, `static_reference: 892`) | none (`authentication_type: 0`) |
| Alerts | `https://www.ambmobilitat.cat/transit/alerts/alerts.bin` | 2369 (`sa`) | none |
| Vehicle positions | `https://www.ambmobilitat.cat/transit/vehicle-positions/vehicle-positions.bin` | **not catalogued** | — |

The vehicle-positions file is referenced only by `yopaseopor/tempsrealcat`, whose code handles "not available". Treat it as **unverified, probably absent**.

TripUpdates contents, from an alegoml capture on 2026-10-25:

- GTFS-RT 1.0, refreshed about every 30 s, about 280 KB, covering the **whole network**. Headers include `last-modified` and `etag`.
- About 650 entities, **all `trip_update`**.
- `trip.trip_id` matches static `trips.txt` (100%). Also present: `start_time` and `start_date`.
- **`trip_update.vehicle.id` / `label`** are present, for example "9510" / "4276".
- `stop_time_update[]`: `stop_sequence`, `stop_id` (sometimes zero-padded), and **absolute `arrival.time` / `departure.time` epochs, never `delay`**. `schedule_relationship` 1 (SKIPPED) entries carry no time.
- Of 8,920 STUs: 152 were SKIPPED, predictions reached about 2 h ahead, and 52 were already in the past. Filter out passed stops.
- Licence: same as the static feed (Llei 37/2007).

### 4.3 AMB REST API (v1/v2) [R]

- Base `https://api.ambmobilitat.cat/v1`, with swagger at `/v1/swagger-ui.html`. Auth is the header **`x-api-key`**, requested through the form at `https://www.ambmobilitat.cat/Principales/OpenData.aspx` [R, deployEMDS docs].
- **v1 endpoints** [R, teaching material]:
  - `/stops/search/byName?name=`
  - `/stops/{id}/realtimes`, returning `times[]` with `lineCode`, `destination`, `arrivalTime` in seconds
  - `/stops/search/realtimes/byIds?idStops=`
  - `/lines`, `/lines/{id}/stops`, `/companies`, `/companies/{id}/lines`
- **v2** (`https://api.ambmobilitat.cat/v2`) was used by Arribo's retired Catalonia code [R, `docs/history/ARCHITECTURE.md`, `docs/catalonia-review/gemini-raw/lane4-…`]:
  - `/gtfs/routes-and-stops`: 243 routes, so it includes TMB-run AMB lines.
  - `/bus/stops/:code/realtimes`: minutes, expected and aimed timestamps, vehicle id.
  - `/bus/vehicles`: **positions**.
  - `/gtfs/busamb/shapes/:id`, and Renfe station boards at `/gtfs/renfe/realtime/:id`.
- That code shipped a **hard-coded fallback key from the AMB app**. That key is not an authorised credential. **Do not reuse it.** Legitimate use requires a key from the AMB request form, so `/bus/vehicles` is the only potential GPS source and it is gated.
- **AMB "Temps de pas" web page and the app** (`app.ambmobilitat.cat/stops/busamb:{id}`, `/lines/busamb:{id}`): the back end was not inspected. No public repo documents it, and probing it today was impossible. The front end is expected to call `api.ambmobilitat.cat` [R, inferred].
- **AMB SIRI:** no public SIRI endpoint was found in any source. AMB's static SOAP service sits behind a request form [R, alegoml].

### 4.4 ATM / T-mobilitat (CGIM) [R — host blocked; verified by repo doc 2026-11-23]

GTFS-RT, open with no token:

| Feed | URL |
|---|---|
| TripUpdates (protobuf) | `https://t-mobilitat.cat/opendata/trip_updates/user/token/open` |
| TripUpdates (JSON) | `https://t-mobilitat.cat/opendata/trip_updates/json/user/token/open` |
| Alerts (protobuf) | `https://t-mobilitat.cat/opendata/alerts/user/token/open` |
| Alerts (JSON) | `https://t-mobilitat.cat/opendata/alerts/json/user/token/open` |
| Vehicle positions | `/opendata/vehicle_positions/[json/]user/token/open` returns **HTTP 404** |

- **Entity counts, 2026-11-23 at 23:17 CET** (not re-counted today):
  - TripUpdates: 494, by prefix **`AMB_` 275, `TMB_` 161, `FGC_` 29, `ROD_` 29**.
  - Alerts: 550, by prefix `AMB_` 485, `TMB_` 51, `ROD_` 14.
  - **No** `GEN_`, `SAB_`, `CAS_`, `TCC_`, `TGO_`, `TUS_` … entities. So no Generalitat or municipal bus has RT here.
- **Static:** daily ("Diaria"), `simplificada` and `completa`/`WBL`. Needs a free token, from `POST /opendata/static/register/request/` then `/opendata/static/download/{token}`. Metadata is at `/opendata/static/ficha/tecnica/ca`.
- **Static id prefixes:** `AMB_<agency>`, `TMB…`, `GEN_<agency>`, `SAB_` (Sarbus), `TGO_` (with `TGO_AMB` for CS1–CS4), `AUC_` (Autocorb), `SSI_` (Soler i Sauret interurban), `TUS_`, and others [V-today on the mirror route list].
- **ATM ids do not equal operator ids.** The ATM integrated GTFS "IDs are ATM's own, so they don't join the operators' real-time feeds" [R, viapeninsula]. The T-mobilitat RT, however, uses prefixed operator ids (`AMB_<trip_id>`), which the 2026-11-23 check matched against AMB `trips.txt`.
- **Mirrors:** NAP files 2060 (complete) and 2059 (simplified) need an `ApiKey`. MDB 2826 and 2832 returned 404 on the `mdb-latest` bucket today.

### 4.5 Barcelona open data (opendata-ajuntament.barcelona.cat)

The host was blocked, so nothing was verified. The city portal is known to republish TMB stop and line datasets [R, general knowledge]. It does **not** hold an independent bus real-time feed. Use TMB directly.

### 4.6 Unofficial and community sources (fallback; ToS notes)

- **GitHub code search** found AMB feed users: `alegoml/tmb-cli` (best documentation), `yopaseopor/tempsrealcat` (browser client via its own Vercel proxy), `enekomateos/amb_app_garmin`, `FlorinTodor/radar-es`, `OxyHQ/GoWay` and `jdamcd/gtfs-mcp`. It found TMB users including `esteveavi/ibus-mcp`, `medusero/tmb-telegram-bot-ts`, `FabianUB/minibarcelona3d` and the official `TMB-Barcelona/TMB-API-samples`. All of them use the official endpoints above. **No independent bus-GPS source was found.**
- **Moventis web "temps real" and SAE.** The repo's MOVENTIS doc covers the Moventis web endpoints for Sarbus and Sant Cugat urban. The SAE GPS endpoint uses Basic auth with credentials embedded in the app. **That defeats authentication, so it is excluded.**
- **Sagalés `sagales.com/real-time-bus/:route/:dir`** is a public AJAX endpoint [R, archaeology doc]. It is relevant only to Sagalés Generalitat lines that touch Badalona (360, 849). Check the ToS before use.

---

## 5. Answers to the specific brief items

| Brief item | Finding | Status |
|---|---|---|
| AMB static GTFS: agencies and routes | 11 agencies, 137–140 routes, 4,926 stops, about 30k trips; per-agency line list in §2 and §3 | **V-today** (June/July mirror) |
| GTFS-Fares v2 in AMB GTFS | June: only `areas.txt` and `stop_areas.txt`, and those are municipalities, not fares. November: fare files reported | V-today / R |
| AMB API v2 `/bus/vehicles`, `/bus/stops/:id/realtimes`; key needed? | Yes, the `x-api-key` header, via a request form; there are no public docs beyond the v1 swagger | R |
| AMB SIRI | None public | R |
| T-mobilitat counts per prefix | AMB 275, TMB 161, FGC 29, ROD 29 (TU); AMB 485, TMB 51, ROD 14 (alerts). **Vehicle positions: 404** | R (2026-11-23); **not re-run today: host blocked** |
| Vehicle positions anywhere? | No open source. Gated AMB v2 `/bus/vehicles`; unverified `vehicle-positions.bin`. TMB iTransit gives `id_bus` but no coordinates | R |
| TMB endpoints and fields | §4.1 | R (captures Oct 2026) |
| TMB GTFS-RT | Not found on TMB's portal; `TMB_` entities exist via T-mobilitat, mode unknown | R |
| On-demand services | TMB El Meu Bus (Barcelona). Sarbus TAD LP and TAD CT (Sant Cugat), modelled as GTFS routes in ATM. Clic.cat L0783 (Sant Andreu de la Barca, GEN). Cervelló afternoon on-demand (2020; status after the 2025 re-tender unknown). Castellbisbal: CS lines are fixed-route; **no on-demand service was found**. Collserola: fixed Proximitat lines 111, 118 and 128, **no on-demand service was found** | V-today (GTFS) / R |
| Seasonal beach lines | VB4 (Viladecans), PR3 and PR5 (El Prat): dates-only or seasonal calendars. GA1, GA2 and CF2 serve the beaches all year, with timetable variants | **V-today** |
| Branches, short turns, day-specific lines | §3.3 | **V-today** |

---

## 6. Recommendations for Arribo! (if this scope is ever taken on)

1. **Tier 1, keyless and official:** AMB static GTFS (daily) plus `trips.bin` and `alerts.bin`, with T-mobilitat as a redundant relay. Label times as **predicted**, never GPS. `vehicle.id` lets you chain trips per bus, but it is not a position. Respect the "freshness is per subsystem" rule: use the feed `header.timestamp` and `last-modified`.
2. **Tier 2, free key:** TMB iTransit per stop. Poll only the stops in view or on a saved journey, because there is no bulk endpoint. Join on the shared stop codes and drop `transit_namespace:"amb"` duplicates when the AMB feed is loaded.
3. **Tier 3, static only:** Generalitat and municipal lines in the six uncovered towns, plus Sant Cugat urban. Take them from the GEN DGTM GTFS (keyless) or the ATM static GTFS (token). These must be presented as **theoretical**, consistent with the telemetry-honesty rules in CLAUDE.md.
4. **Normalise at the loader:**
   - Zero-padded stop ids, header spaces, tabs and CRLF.
   - Unpadded `H:MM:SS` and hours of 24 or more.
   - Shapes duplicated per service.
   - `trip_short_name` misuse.
   - `continuous_drop_off=3` on NitBus.
   - `pickup_type=2` / `drop_off_type=3` stops.
   - Trip-id churn between republications.

---

## 7. Gaps and open items

1. **Live verification blocked.** Re-run the following once these hosts are allowed: `ambmobilitat.cat`, `api.ambmobilitat.cat`, `t-mobilitat.cat`, `api.tmb.cat`, `developer.tmb.cat`, `opendata-ajuntament.barcelona.cat`, `mobilitydatabase.org`.
   - The T-mobilitat prefix counts.
   - A check of whether `vehicle-positions.bin` exists.
   - Today's AMB zip: Fares v2 files and agency count.
   - A check of which TMB mode the `TMB_` RT entities belong to: match their `trip_id` against TMB `2.*` (bus) and `1.*` (metro) trips.
2. **Per-agency AMB-RT coverage is unconfirmed.** Coverage was confirmed only for Moventis (69) [R 2026-11-23] and for TMB-stop AMB lines (L70, L72, L80, L86, L94, L95, LH1) [R 2026-10-26]. Soler i Sauret, TGO, Monbus Papiol and Horta, Aerobús and Moventis Cerdanyola still need to be matched against `trips.bin`.
3. **Municipal urban buses still unconfirmed** (the WebSearch budget ran out):
   - Badia del Vallès "URBÀ": operator and line code.
   - Begues urban bus: existence.
   - Sant Andreu de la Barca urban bus.
   - Ripollet urban line.
   - Santa Coloma de Cervelló urban or on-demand service.
   - The winner of the Cervelló urban contract (tender 2025-11).
   - The municipality of the Sarbus "Línia V1–V4.2" lines.
4. **Bus Turístic and El Meu Bus:** they are not in the GTFS and have no open real-time. Only TMB `transit/linies/bus` lists them [R].
5. **The TMB GTFS mirror expires 2026-12-05.** The AMB June mirror is about 6 months old. Both must be refreshed from the official hosts with a key or token before any production use.
6. **ATM-derived route list:** the snapshot date is unknown. The Cerdanyola SU1–SU3 lines in it may be stale, given AMB CV1–CV5 from 2026-04-09.

---

## Sources

**Verified today:** data files

- AMB GTFS via the Mobility Database bucket: `https://storage.googleapis.com/storage/v1/b/mdb-latest/o/es-barcelona-autos-castellbisbal-gtfs-892.zip?alt=media`
- TMB GTFS via the Mobility Database bucket: `https://storage.googleapis.com/storage/v1/b/mdb-latest/o/es-barcelona-transports-metropolitans-de-barcelona-tmb-gtfs-2359.zip?alt=media`
- Raw GitHub mirrors:
  - `bmantepe/stop-location/Data/GTFS_AMB/`
  - `OSM-Catalan/tpcatvsosm/gtfs_amb_bus/`
  - `OSM-Catalan/tpcatvsosm/gtfs_cat_urba_bus/`
  - `yopaseopor/tempsrealcat/docs/assets/gtfs/amb_bus/`
  - `enekomateos/amb_app_garmin/GTFS_static/`
- Mobility Database catalogue entries:
  - [es-barcelona-amb-mobilitat-gtfs-rt-tu-2368](https://github.com/MobilityData/mobility-database-catalogs/blob/main/catalogs/sources/gtfs/realtime/es-barcelona-amb-mobilitat-gtfs-rt-tu-2368.json)
  - [es-barcelona-amb-mobilitat-gtfs-rt-sa-2369](https://github.com/MobilityData/mobility-database-catalogs/blob/main/catalogs/sources/gtfs/realtime/es-barcelona-amb-mobilitat-gtfs-rt-sa-2369.json)
  - [892](https://github.com/MobilityData/mobility-database-catalogs/blob/main/catalogs/sources/gtfs/schedule/es-barcelona-autos-castellbisbal-gtfs-892.json)
  - [2359](https://github.com/MobilityData/mobility-database-catalogs/blob/main/catalogs/sources/gtfs/schedule/es-barcelona-transports-metropolitans-de-barcelona-tmb-gtfs-2359.json)
  - [2826](https://github.com/MobilityData/mobility-database-catalogs/blob/main/catalogs/sources/gtfs/schedule/es-atm-autobuses-trains-complete-gtfs-2826.json)
- [transitland-atlas ambmobilitat.cat.dmfr.json](https://github.com/transitland/transitland-atlas/blob/main/feeds/ambmobilitat.cat.dmfr.json)

**Community first-hand captures**

- [alegoml/tmb-cli docs/amb-api.md](https://github.com/alegoml/tmb-cli/blob/main/docs/amb-api.md) and [docs/tmb-api.md](https://github.com/alegoml/tmb-cli/blob/main/docs/tmb-api.md)
- [gariasf/viapeninsula docs/research/live-data-sources.md](https://github.com/gariasf/viapeninsula/blob/main/docs/research/live-data-sources.md)
- [esteveavi/ibus-mcp](https://github.com/esteveavi/ibus-mcp)
- [apuratepp/tmb](https://github.com/apuratepp/tmb)
- [alemuro/tmb](https://github.com/alemuro/tmb)
- [deployEMDS barcelona.md](https://github.com/deployEMDS/technical-documentation/blob/main/design_decisions/data_sources/barcelona.md)
- [mrcarle-asb flask workbook, AMB API](https://github.com/mrcarle-asb/flask-sequence-workbook/blob/main/book/045-tmb-arrivals/04-amb-api.md)
- [yopaseopor/tempsrealcat busamb.functions.js](https://github.com/yopaseopor/tempsrealcat/blob/main/docs/assets/js/busamb.functions.js)
- [FabianUB/minibarcelona3d](https://github.com/FabianUB/minibarcelona3d)

**This repository**

- `/home/user/Arribo/docs/research/MOVENTIS_SOURCES.md` (verified 2026-11-23)
- `/home/user/Arribo/docs/history/ARCHITECTURE.md`
- `/home/user/Arribo/docs/catalonia-review/REPORT.md`
- `/home/user/Arribo/docs/catalonia-review/gemini-raw/lane4-retired-catalonia-archaeology.md`

**Web (search results only; the pages were not fetched)**

- [TMB bus a demanda](https://www.tmb.cat/ca/barcelona/bus-a-demanda)
- [TMB bus-on-demand terms](https://www.tmb.cat/en/terms-and-condidionts-bus-on-demand)
- [Barcelona bus on demand](https://barcelona.cat/mobilitat/en/means-of-transport/bus/bus-demand)
- [Montbau and Vall d'Hebron on-demand launch](https://barcelona.cat/infobarcelona/en/bus-on-demand-service-to-start-operating-in-montbau-and-vall-dhebron-from-17-january_1134720.html)
- [TMB El Farró–Galvany on-demand](https://noticies.tmb.cat/sala-de-premsa/bus-demanda-farro-galvany-de-sarria-sant-gervasi-servei-28-de-novembre)
- [Cervelló TAD presentation (2020)](https://www.elbaixllobregat.cat/sites/default/files/arxius/PWP_NEUS_FIGUERAS_TAD_CERVELLO_271120.pdf)
- [EU tender, Cervelló urban transport](https://op.europa.eu/en/web/public-procurement/procurement-details/-/procurement/6c24c4c6-6584-488d-89f0-3faee484a0dd)
- [HIFE 902 Begues–Gavà–Olesa](https://www.hife.es/en/banner/hife-strengthens-the-beguesgavaolesa-902)
- [Badia urban fares flyer](https://www.badiadelvalles.cat/ARXIUS/2022/Noticies/2_Cartell_i_Flyer_informatiu_URBA__TARIFES_SOCIALS_METROP.pdf)
- [Molins de Rei adapted transport](https://molinsderei.cat/ampliacio-del-servei-de-transport-adaptat)
- [NitBus N23/N24 (NacióDigital)](https://naciodigital.cat/societat/canvis-al-bus-nocturn-de-larea-de-barcelona-amb-dues-noves-linies.html)
- [Avanza Barcelona notices (beach lines)](https://barcelona.avanzagrupo.com/en/notices)
- [Mobility Database mdb-2359](https://mobilitydatabase.org/feeds/gtfs/mdb-2359)
