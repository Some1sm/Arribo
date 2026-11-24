# H — Fares: showing ticket prices for an origin→destination journey anywhere in Catalonia

Research date: **2026-11-24**. Research only: this report contains no application code.

## 0. How to read this report (evidence levels)

| Tag | Meaning |
|---|---|
| **[V]** | Verified today (2026-11-24) by opening the actual data file locally (GTFS copies on disk, analysed with read-only scripts). |
| **[V-23]** | Verified 2026-11-23 by an earlier Arribo research pass (`/home/user/Arribo/docs/research/MOVENTIS_SOURCES.md`). Not re-checked today. |
| **[R]** | Reported. Taken from web-search result snippets (press, operator or authority pages) that I could not open directly. Treat as likely, not confirmed. |
| **[?]** | Unknown, or the sources conflict. |

**Access limits in this session. They matter for how far you can trust the report.**
- The egress proxy **refused direct downloads** (HTTP 403 on CONNECT) from `www.ambmobilitat.cat`, `www.fgc.cat`, `territori.gencat.cat`, `ssl.renfe.com`, `www.atm.cat` and `ca-sermetra.atm.cat`. WebFetch to `www.atm.cat` and `ca-sermetra.atm.cat` also failed (host not allowed). So none of the official fare PDFs, nor the ATM calculator or Renfe endpoints, could be opened or probed.
- Sibling research agents in this session had already downloaded several GTFS feeds into the shared scratchpad from the Mobility Database mirror (Google Cloud Storage). The most important is the **ATM Catalonia unified CGIM / T-mobilitat feed (Mobility Database `mdb-2832`, `Last-Modified: Mon, 23 Nov 2026 01:19:50 GMT`)**. I analysed those copies read-only. I also copied its fare files to
  `(research scratch files, not committed)`
  (areas, stop_areas, fare_products, fare_leg_rules, fare_transfer_rules, fare_leg_join_rules, fare_media, networks, route_networks, rider_categories, feed_info and the HTTP headers).
- The session-wide WebSearch budget (200 calls) ran out before I could search urban-bus prices for Girona, Lleida, Tarragona and Reus, or fill some per-zone cells for ATM Girona and Camp de Tarragona. Those gaps are marked **[?]**.
- Analysis scripts: `(research scratch files, not committed)` (flr.py, sa.py, q.py). They take the data folder as an argument and run with `python3 -I`.

---

## 1. Key finding first: ATM Barcelona already publishes a full GTFS-Fares v2 model, in the unified T-mobilitat feed

The ATM unified static GTFS (the "CGIM" feed: `t-mobilitat.cat` open data, free token registration; also NAP 2059/2060 and Mobility Database mdb-2832) contains a **complete GTFS-Fares v2 implementation of the ATM Àrea de Barcelona integrated fare system (STI)**, with **2026 prices**. **[V]**

Files present **[V]**: `areas.txt` (290 areas), `stop_areas.txt` (49,885 rows), `fare_products.txt` (215 rows), `fare_leg_rules.txt` (23,478 rows), `fare_transfer_rules.txt`, `fare_leg_join_rules.txt`, `fare_media.txt`, `rider_categories.txt`, `networks.txt` and `route_networks.txt` (855 routes). `stops.txt` also has a `zone_id` column, filled for only 291 stops, so ignore it.

### 1.1 What is inside the ATM v2 model [V]

**Networks.** There is a single network, `STI_Barcelona` ("rutes integrades ATM Barcelona"). Of the feed's 1,612 routes, 855 are in it: all 8 Mataró Bus (`MAT_1…MAT_8`), 135/140 AMB, 113/116 TMB, 18/22 FGC, 9/11 Rodalies, 426/946 Generalitat (`GEN_`), all TUS Sabadell, and so on. Routes **not** in the network include FGC `RL1/RL2` (Lleida–La Pobla), FGC `L1` (Cremallera de Núria), Rodalies `RT1` and `RL3`, and every route of Tarragona, Reus, Girona, Lleida and similar networks.

**Fare media.** `TMA` = T-mobilitat anonymous card, `TMU` = personal card, `TMP` = app.

**Rider categories.** `menors_30` (T-jove), `monoparental_nombrosa` (single-parent or large families, "general" and "especial"), `menors_16` (T-16).

**Fare products and 2026 prices [V]** (the feed matches the press reports of the 15-Jan-2026 DOGC fares):

| Product (id prefix) | 1z | 2z | 3z | 4z | 5z | 6z | 7z |
|---|---|---|---|---|---|---|---|
| Bitllet senzill (`BS`) | 2.90 | 4.15 | 5.40 | 6.90 | 8.80 | 10.25 | 11.60 |
| T-casual, 10 trips (`TC`) | 13.00 | 25.50 | 34.70 | 44.65 | 51.20 | 54.45 | 57.60 |
| T-usual, 30 days unlimited, 50% off (`TU`) | 22.80 | 30.55 | 42.70 | 52.15 | 59.60 | 63.85 | 67.65 |
| T-familiar, 8 trips/30 days (`TF`) | 11.50 | 21.75 | 30.80 | 39.95 | 45.65 | 47.95 | 49.70 |
| T-dia (`TD`) | 12.00 | 18.30 | 22.95 | 25.65 | 28.70 | 32.10 | 34.70 |
| T-grup, 70 trips/30 days (`TG`) | 91.00 | 178.50 | 242.90 | 312.55 | 358.40 | 381.15 | 403.20 |
| T-70/90 FM/FN general (`T79G`) | 36.40 | 71.40 | 97.15 | 125.00 | 143.35 | 152.45 | 161.25 |
| T-70/90 FM/FN especial (`T79E`) | 22.75 | 44.60 | 60.70 | 78.10 | 89.60 | 95.25 | 100.80 |
| T-usual FM/FN general (`TUG`) | 18.20 | 24.40 | 34.15 | 41.70 | 47.65 | 51.05 | 54.10 |
| T-usual FM/FN especial (`TUE`) | 11.40 | 15.25 | 21.35 | 26.05 | 29.80 | 31.90 | 33.80 |

Flat-price products: **T-jove** (under 30, 90 days, all zones, 50% off) **45.50**; T-jove FM/FN general 36.40; T-jove FM/FN especial 22.75; **T-16** 0.00.

### 1.2 How zones are modelled [V]

**Sectors, not rings.**

The areas are the ATM fare **sectors**. They carry names, not just numbers:
- `1`
- `2A…2E`
- `3A…3E`
- `4A…4H`
- `5A…5H`
- `6A…6H`
- `7C…7H`
- special sectors `4Z` (Monistrol / Montserrat), `LesPlanes`, `Aeroport`
- "prime" sectors `2A'`, `2B'`, `2C'`

Every stop in the ATM Barcelona area belongs to **exactly one sector**: 17,259 stops have one sector and **no stop has two**. The boundary problem is therefore handled by sector-pair rules, not by giving a stop two zones.

Stops outside the ATM Barcelona area have **no sector**. There are 10,743 of them: Girona, Tarragona, Lleida, Reus, Figueres, Rodalies Girona and Camp de Tarragona stations, and FGC Lleida–La Pobla. Their only area is the dummy `TJOVE`.

**The zone count is a sector×sector matrix, not ring arithmetic.**

The `fare_leg_rules` rows for each (from-sector, to-sector) pair point to a leg group `Zn_*`. The matrix is not simply the difference between rings. Examples from the sector `3E` row (Mataró) **[V]**:
- 3E→3E = 1 zone
- 3E→3D or 2E = 2
- 3E→1 (Barcelona) = 3
- 3E→3C = 3
- 3E→2A/2B/2C = 4
- 3E→3A/3B = 5, because the trip goes around through Barcelona
- 3E→4H (Arenys) = 2
- 3E→5H = 3
- 3E→6G = 4
- anything → 7x = 7

**The prime sectors.** `2A'/2B'/2C'` cost the same as zone 1 when the trip starts from zone 1: 1→2B' = 1 zone, while 1→2B = 2 zones. 2B'→2B is also 1 zone. Stops in these sectors include AMB stops in Sant Boi / Colònia Güell, Castelldefels/Gavà and Cerdanyola/UAB (2A' 68 stops, 2B' 1,170, 2C' 1,219). **[V]** *(Interpretation: these are 2nd-ring AMB areas given zone-1 treatment. I could not read the official rationale.)*

**Leg groups.** There is one per product family:
- `Zn_BS`: single ticket, `rule_priority` empty
- `Zn_MV`: multi-trip T-casual, T-familiar, T-grup, T-70/90; empty network
- `Zn_AB`: passes T-usual (+FM/FN), T-dia, T-16; `network_id=STI_Barcelona`
- `TJOVE→TJOVE`: T-jove, valid in all zones

**Boundary overrides (priority > 0).** These are the only place where the feed encodes the "neighbouring stop across a zone line counts as 1 zone" rule:
- `ROD_Z1` / `FGC_Z1`, priority 1: 114 station pairs, each a per-station area such as `ROD_79500` or `FGC_OL`, priced as 1 zone. Examples: Mataró ↔ Cabrera de Mar–Vilassar de Mar, Martorell Central ↔ Castellbisbal, Rubí ↔ Terrassa stations, Olesa ↔ Montserrat-Aeri.
- `BUS_Z1`, priority 2: 228 pairs of **neighbouring municipalities** in the outer rings, e.g. Viladecavalls ↔ Abrera, Vilassar de Mar ↔ Cabrera de Mar. They are priced as 1 zone for interurban bus. This is why 1,140 stops also carry a municipality area (INE-like code, e.g. `82191` Vilassar de Mar).
- **These overrides apply only to the multi-trip products** (TC1, TF1, TG1, T79G1, T79E1). They do **not** apply to the single ticket, T-usual or T-dia. **[V]**

**Transfers.** `fare_transfer_rules` gives each `Zn_MV` group a duration limit:
- 4,500 s (75 min) for 1 zone, plus 900 s per extra zone, up to 9,000 s (2 h 30) for 6 zones
- **12,600 s (3 h 30) for 7 zones**

`transfer_count=3` and `fare_transfer_type=0` mean free transfers within the window, up to 3. `fare_leg_join_rules` joins consecutive `STI_Barcelona` legs into one effective leg, so a multi-leg trip is priced from its **first origin sector to its last destination sector**, not per leg. These numbers match the ATM's published rule (1h15 for 1 zone … 2h30 for 6 zones, 3h30 for 7 zones) **[R]**. The single ticket has no transfer rule: no transfers, except metro-to-metro inside stations **[R]**.

### 1.3 Mataró specifically [V]

- All 153 `MAT_` stops in the feed are in sector **3E**, i.e. **zone 3**. Arribo has 155 stops, so a crosswalk by `stop_code` or coordinates is needed.
- Mataró Rodalies station `ROD_79500` is also in 3E, plus a station override area. `GEN_` interurban stops in Mataró are 3E as well.
- All 8 Mataró Bus routes are in `STI_Barcelona`, so the ATM integrated tickets are valid on them. Within Mataró a trip is 1 zone: T-casual 13.00 = **1.30 €/trip**.
- **Own (non-integrated) Mataró Bus titles [R]** (Avanza site, via search):
  - Single ticket **1.70 €**, sold on board. It allows changing lines within **1 h 15 min**.
  - Own **T-10 4.85 €**.
  - **T-Rosa 3.95 €** (pensioners or people with disabilities, not on Carnet Blau).
  - A **40% reduction** on the urban passes runs **until 31 Dec 2026**.
  - These products are **not** in the ATM GTFS.
  - For a one-off urban trip, the own single ticket (1.70 €) beats the ATM BS1 (2.90 €). The T-10 at 0.485 €/trip beats the T-casual. **Arribo should show the Mataró own titles for intra-Mataró legs.**

### 1.4 Gaps and errors in the ATM v2 data (must be handled) [V]

1. **Aerobús A1/A2 (`AMB_130`, `AMB_269`) are in the `STI_Barcelona` network.** Taken literally, the feed would price the Aerobús at a T-casual or T-usual fare. In reality the Aerobús is **not integrated** (≈ **7.75 € single, 13.30 € return** in 2026 **[R]**). Override it.
2. **No airport supplement.** The `Aeroport` area exists but holds 0 stops. L9 Sud Aeroport T1/T2 (`TMB_1.901`, `TMB_1.903`) are plain sector 1. In reality the T-casual and single ticket are **not valid** at the airport stations: you need the **Bitllet Aeroport ≈ 5.90 €** (2026 **[R]**), while T-usual, T-jove, T-dia etc. are valid. Override it.
3. **Non-integrated routes still sit in integrated sectors.**
   - Cremallera de **Núria** (`FGC_L1`) stops (Queralbs, Núria, Ribes) are in sector 7H. Because the `MV` and `BS` rules have an **empty `network_id`**, a strict GTFS v2 engine would price Núria at ATM fares. The operator FAQ says ATM tickets are **not valid** there **[R]**.
   - **Rule:** price a leg with ATM products only if its route is in `route_networks` → `STI_Barcelona`, even when the rules carry no network.
4. `FGC_MM` (Cremallera de **Montserrat**) **is** in the network, with `4Z/4D` sectors. The tourist fare is separate (≈ 9 € single / 15 € return adult **[R]**). Whether ATM integrated titles are accepted on the cremallera, and for whom, could not be verified **[?]**. Label it as "consulta l'operador".
5. **Products that are missing:**
   - the per-operator non-integrated single tickets (Mataró 1.70, TUS Sabadell 1.80, TMESA ≈ 1.45, etc.)
   - the T-4 (2.25 € **[R]**, AMB T-metropolitana)
   - Targeta Rosa
   - Bitllet Aeroport
   - Rodalies-only titles
   - the T-usual for unemployed people (5.65 € **[R]**)
6. **Header and whitespace glitches:**
   - `fare_transfer_rules.txt` has a trailing space in `nonconsecutive_transfers_allowed `.
   - AMB's own `areas.txt` has `area_id, area_name` with a space, and tab characters inside names.
   - Parse defensively: trim header names and values.

---

## 2. ATM Àrea de Barcelona: system rules, 2026 prices, subsidies

- **Zones.** The system **has 7 zones since 1 July 2025**. Zone 7 covers 67 municipalities of the Berguedà, Ripollès and Solsonès (R3 stations in sectors 7G/7H). A 7-zone ticket is needed only if a trip exceeds 6 zones **and** starts or ends in those comarques. **[R]** The 7-zone products and 7H/7G sectors are present in the feed **[V]**. I found no further zone reform for 2026 beyond the 3.5% price update **[R]**.
- **2026 fares.** In force since **15 Jan 2026** (DOGC 9582, 14 Jan 2026), with an average +3.5%. The single ticket rose most: 2.65 → 2.90 (+9.4%). **[R]** The prices match the GTFS **[V]**.
- **Subsidies.**
  - The **50% discount** on T-usual and T-jove (and their social variants) is kept for 2026. The State pays 20% and the Generalitat 30%, conditional on the State extending its share. **[R]**
  - The T-casual, single ticket and T-dia are **not** discounted **[R]**.
  - Unemployed people get a T-usual at **5.65 €** for all zones **[R]**.
- **Social and age titles.**
  - **T-16**: free, ages 4–16 resident in Catalonia, T-mobilitat only, renewed yearly **[R]** (in the GTFS as `T16`, 0.00 **[V]**).
  - **T-jove** 45.50 € for under-30s, 90 days.
  - **Targeta Rosa** (AMB, 60+ or 33%+ disability, income-tested): free tier ≈ 6.20 €/year; reduced tier uses the **T-4 = 2.25 €** (2026, metropolitan area only). **[R]**
  - FM/FN family products are in the GTFS **[V]**.
- **T-mobilitat.** All integrated titles are on T-mobilitat: card, anonymous card, app. Single tickets have been issued on rechargeable cardboard T-mobilitat since May 2025. **Contactless EMV bank-card pay-as-you-go is planned for 2027 and covers single tickets only.** For distance- or zone-based services the card will be tapped in and out. **[R]** Arribo cannot rely on EMV fare capping in 2026.
- **Night buses (NitBus).** Integrated: N1, N17 and N18 are in `STI_Barcelona` **[V]**.
- **Montjuïc funicular.** Integrated: TMB `FM` is in the network **[V]**. It reopened on 13 Apr 2026 after closing on 20 Oct 2025 **[R]**.
- **Vallvidrera funicular.** Integrated: `FGC_FV` is in the network, sector 1 **[V]**.
- **Montjuïc cable car and Bus Turístic.** Not integrated (tourist fares) **[R]**.
- **Hola Barcelona tourist card.** Not researched in depth; the search budget ran out **[?]**. Treat it as out of scope for O-D pricing. At most mention it as a tourist alternative.

## 3. ATM Camp de Tarragona, ATM Girona, ATM Lleida

All three:
- kept the **50% discount** on passes and multi-trip titles for 2026
- raised fares by 3.5%
- put new fares in force from **15 Jan 2026**, with a grace period for older titles until 28 Feb 2026 **[R]**

None of them has fare data in any GTFS I could inspect. The ATM CGIM feed gives their stops **no** area **[V]**.

| ATM | Zones | 2026 products and prices **[R]** | Zone data source |
|---|---|---|---|
| **Camp de Tarragona** | Was 3 zones. **A 4th zone was added** for Terres de l'Ebre integration; the offer has existed in Terres de l'Ebre since **2 Mar 2026** (T-MES, T-JOVE, T-70/90, T-50/30, T-10/30, T-10). | **T-10**: 6.75 / 13.35 / 19.15 / 24.20 (1–4 z). **T-10/30**: 5.45 / 10.40 / 14.95 / 17.50. **T-MES**: 25.60 / 40.15 / 54.25 / 67.80. **T-50/30** 1z ≈ 18.20 [?]. T-JOVE figure 51.20 seen, but its mapping is unclear [?]. | Official "Comptador de zones" (min. zones between municipalities) and "Zones de mobilitat" pages on atmcamptarragona.cat. Zone is per **municipality**; no machine-readable file found. |
| **Àrea de Girona** | 4 zones (titles for 1–4 z). **The Ripollès joined the Girona STI in Mar 2026** (it is also zone 7 of ATM Barcelona since 2025, so it overlaps two ATMs). | **T-10**: 6.40 / 12.25 / 17.05 / 20.70 (1–4 z). T-10/30 1z 5.35; T-50/30 1z 18.65; T-MES 1z 26.65. Other per-zone cells were seen as 18.65 / 29.30 / 41.05 / 54.85 and 21.35 / 32.00 / 42.65 / 56.75, but which title they belong to is ambiguous [?]. Transfers: 75 / 90 / 105 min for 1 / 2 / 3+ zones. | "Mapa geogràfic de zones tarifàries" plus a zone counter on atmgirona.cat. Per **municipality**. |
| **Àrea de Lleida** | 4 zones, 242 municipalities. | **T-10**: 5.50 / 8.60 / 27.45 / 38.45. **T-MES**: 22.10 / 31.95 / 102.80 / 143.85. **T-10/30**: 4.40 / 6.95 / 22.00 / 30.80 (from an FGC notice). Valid 15 Jan–31 Dec 2026. The 3–4 zone T-10 prices look undiscounted; probably only some titles get the 50% [?]. | Table and map on atmlleida.cat. Per **municipality**. **FGC Lleida–La Pobla uses the ATM Lleida zones** (FGC notice C0226 repeats the ATM Lleida tables). |

The **T-jove** arrived in Girona, Lleida and Camp de Tarragona as an STI title **[R]** (AMTU). The 2026 prices for these three areas were not found **[?]**.

## 4. Generalitat interurban buses outside the ATM areas

- **GTFS has no fares.** The Generalitat interurban GTFS (`busos-interurbans-GTFS.zip`, Mou-te export) contains `agency, stops, routes, trips, stop_times, calendar, calendar_dates, shapes, nota.txt` and **no fare files**. **[V]** on the copies in the scratchpad `I_dl/gencat`, `F_gtfs/x2926` and `girona_gtfs`, and **[V-23]**.
- **The ATM feed covers part of the network.** In the ATM CGIM feed, 426 of 946 `GEN_` routes are in `STI_Barcelona`. The remaining 520 are the Lleida, Pyrenees, Camp de Tarragona and Girona lines, e.g. "Albesa – Lleida", "Alforja – Salou". **[V]**
- **Fares are per concession, set as origin–destination tables.** Each concession has its own O-D tariff table, approved for the operator and usually updated every January in line with the ATM date (15 Jan 2026). Some operators publish O-D PDFs: for example Soler i Sauret's "Tarifes 2026 vàlides des del 15 de gener de 2026 — Origen / Destinació" **[R]**. A DOGC 2026 example lists Vic-area single fares such as 2.65 € for 1 zone and 6.35 € for 2 zones **[R]**.
- **No Catalonia-wide per-km table was found.** I found no Catalonia-wide "tarifa màxima per viatger-km" publication for 2026; the searches returned nothing **[?]**. **Practical consequence:** outside an ATM there is **no open machine-readable fare source** for interurban buses. Options are:
  - operator PDFs, scraped yearly
  - operator sites (Sagalés, Alsa, Teisa, Moventis…)
  - a labelled heuristic estimate
- **Exprés.cat.** No 2026 fare table found **[?]**.
- **Long-distance coaches** (Alsa, Sagalés airport lines). Market or ticketed fares, e.g. Barcelona–Girona from ≈ 19 € on aggregators and 22 € on the Girona airport line **[R]**. Show these as "preu de l'operador" with a link.

## 5. Renfe: Rodalies and Regionals

- **Inside ATM Barcelona.** Rodalies (R1–R8, RG1 and the integrated part of R3/R4) accepts **ATM integrated titles**, and the ATM sector matrix applies. 112 of 149 `ROD_` stations have a sector **[V]**. Renfe's own "Només Rodalia" titles also exist; the Rodalies-only monthly pass does **not** allow transfers to metro, bus, tram or FGC **[R]**.
- **Stations with no ATM sector [V]** (37):
  - Camp de Tarragona: Tarragona, Reus, Vila-seca, Salou, Picamoixons…
  - Cerdanya: La Molina, Puigcerdà, Latour-de-Carol
  - Lleida–Cervera: Lleida Pirineus, Tàrrega, Cervera…
  - Girona line: Sils, Caldes de Malavella, Girona, Figueres, Portbou…

  These use the Camp de Tarragona and Girona ATM zones **where integrated** (Rodalies has a "Servei integrat ATM Camp de Tarragona" page) **[R]**. Otherwise they use **Renfe distance fares**.
- **Distance fares.** Regionals and Media Distancia are priced by **km band** ("tramos"). Rodalies publishes a per-km PDF (`rodalies.gencat.cat/web/.content/03_Tarifes/TARIFAS-KM.pdf`), and the R14–R16 / Terres de l'Ebre lines have specific 2026 tables, including a "Bono Exprés" with 40% off. **[R]** Return tickets get 20% off if used within 24 h **[R]**.
- **2026 passes and the free period:**
  - **Free Rodalies passes**: introduced on **26 Jan 2026** after the Gelida derailment and service disruption. 10-trip free passes valid to **8 May 2026**; monthly passes were extended. **[R]**
  - **Since 9 May 2026**: free travel ended.
    - a **20 € monthly pass for Rodalies de Barcelona**, unlimited within the chosen zone or route
    - a **10 € youth** pass
    - a **child pass free until 31 Dec 2026**
    - an **"Abono Único" at 60 €/30 days** (30 € for those born 2000–2026). It covers Rodalies public-service routes and all Renfe Media Distancia, but **not** ATM metro, bus or FGC. It started on 19 Jan 2026. **[R]**
  - **Recurrent-traveller passes** (40% off the 10- and 40-trip cards, 70% for under-26s) are maintained in 2026 **[R]**.

  For Arribo, these passes are **"si ets usuari recurrent"** context rather than a per-trip price.
- **Renfe data sources:**
  - Renfe Cercanías GTFS (`I_dl/renfe`, Jun-2026 copy): no fare files **[V]**.
  - data.renfe.com lists GTFS, GTFS-RT, JSON, CSV and XLSX, but no fares dataset **[R]**.
  - No official price API exists.
  - Unofficial routes (allowed as a fallback): open-source clients `Sn4pe/renfe-cli` (JSON timetables and fares, anonymous, undocumented API) and `afiodorov/renfe_mcp_server` (DWR scraper). They hit `venta.renfe.com`, with a stated migration to `venta.rsv.renfe.com` for trips after 25 Jan 2027. **[R]**
  - I could not probe these hosts: blocked here.
  - **Legal and ToS:** an undocumented private sales API carries ToS risk and breaks without notice. Use it only on demand, with light GETs and cached results, without defeating any captcha or auth. Label the result as "preu consultat a Renfe (no oficial)".

## 6. FGC

- **Barcelona–Vallès, Llobregat–Anoia and the Vallvidrera funicular** are fully ATM-integrated; they are in the network with sectors **[V]**. FGC's own "Cercador de preus i zones" gives zones and price per station pair **[R]**. There is no public API; the endpoint could not be probed **[?]**.
- **FGC GTFS** (`I_dl/fgc`, May-2026 copy, `feed_version 2026-05-22`): **no fare files** **[V]**. A separate 2019 dataset "FGC – Tarifes per bitllets i zones 2019" exists on the Catalan portal (HTML, stale) **[R]**.
- **Lleida–La Pobla** (`RL1/RL2`, not in STI Barcelona): uses ATM Lleida zone titles (T-10 5.50…38.45). A single ticket was 1.85 € for 1 zone in 2025; the 2026 figure is unconfirmed **[R]/[?]**. No ATM Barcelona sector **[V]**.
- **Montserrat cremallera** ≈ **9 € single / 15 € return** for adults 14–65, valid to 31 Dec 2026 **[R]**. The funiculars and the Aeri are separate.
- **Núria cremallera**: ≈ 21.50 € single / 31 € return Queralbs–Núria. ATM titles are not valid **[R]**.

## 7. Urban buses outside Barcelona

| City | Integrated in an ATM? | Own single ticket (2026) | Notes |
|---|---|---|---|
| **Mataró** (Mataró Bus / Avanza) | Yes, ATM BCN sector 3E **[V]** | **1.70 €** (1 h 15 min transfers) **[R]** | Own T-10 4.85 €, T-Rosa 3.95 €; 40% off passes until 31 Dec 2026 **[R]** |
| **Sabadell** (TUS) | Yes, routes in STI **[V]** | **1.80 €** from 1 May 2026 **[R]** | T-10 10.10 €, T-mensual 20.60 € **[R]** |
| **Terrassa** (TMESA) | Yes **[V]** (TTS/TMESA routes are listed separately; `TTS` 0/6 are not in the network. Check which prefix is the urban network **[?]**) | ≈ **1.45 €** (2025 decree; 2026 not confirmed) **[R]** | T-25 with 50% subsidy kept **[R]** |
| **Girona** (TMG) | ATM Girona | **[?]** (search budget exhausted) | `GIR_` stops have no ATM BCN sector **[V]** |
| **Lleida** (Autobusos de Lleida) | ATM Lleida | **[?]** | GTFS has no fares **[V]** (`F_gtfs/x2753`) |
| **Tarragona** (EMT) | ATM Camp de Tarragona | **[?]** (an "EMT tarifes i abonaments 2026" page exists **[R]**) | GTFS has no fares **[V]** (`F_gtfs/x2777`) |
| **Reus** (Reus Transport) | ATM Camp de Tarragona | **[?]** | GTFS has no fares (flex feed) **[V]** (`F_gtfs/x2803`, `x3081`) |

## 8. GTFS fare availability: summary

| Feed | Fare files | Status |
|---|---|---|
| **ATM CGIM / T-mobilitat unified** (mdb-2832, 23 Nov 2026) | **Full v2**: areas, stop_areas, fare_products, fare_leg_rules, fare_transfer_rules, fare_leg_join_rules, fare_media, rider_categories, networks, route_networks | **[V]**. ATM Barcelona STI only, with 2026 prices. Gaps listed in §1.4. Needs free token registration at t-mobilitat.cat **[V-23]**; also on NAP 2059/2060 (API key). |
| **AMB** `ambmobilitat.cat/OpenData/google_transit.zip` | Mobility Database copy (Jun 2026, `I_dl/amb`, `dl_amb_gtfs/mdb892`): only `areas.txt` (36 **AMB municipalities**, INE codes) and `stop_areas.txt` (3,567 of 4,926 stops). **No products or rules.** | **[V]** for the June copy. The 23-Nov live feed reportedly has 21 files including `fare_products` and `fare_leg_rules` **[V-23]**; the Mobility Database lists Fares V1, Fare Media, Fare Products and Route-Based Fares **[R]**. AMB areas are municipalities, not ATM sectors, so they are not enough to count zones. **Use the ATM CGIM feed instead.** |
| TMB GTFS (`I_dl/tmb`, Apr 2026) | none | **[V]** |
| FGC GTFS (`I_dl/fgc`, May 2026) | none | **[V]** |
| Renfe Cercanías (`I_dl/renfe`, Jun 2026) | none | **[V]** |
| Generalitat interurban (`I_dl/gencat`, `F_gtfs/x2926`) | none | **[V]** |
| Lleida urban, EMT Tarragona, Reus, Cots Alsina, Avanza (`F_gtfs/x27xx/x28xx/x3081`) | none | **[V]** |
| Third-party "gtfs_cat_urba_bus" (GitHub tpcatvsosm, ATM-derived) | `fare_attributes.txt` and `fare_rules.txt` exist but are **header-only** | **[V]** |

## 9. Official calculators and their back ends (unofficial fallback)

- **ATM Barcelona:** "Cercador de títols / comptador de zones", municipality → municipality, recommends a title and compares monthly cost. It is described as the precursor of a T-mobilitat cost simulator **[R]**. **Endpoint not probed** (host blocked). The GTFS v2 model makes it unnecessary for zone counting.
- **ATM Camp de Tarragona:** "Comptador de zones" (gives the minimum zones between O and D, explicitly *indicative*) and "Cercador de títols" (enter trips per month) **[R]**. This is the most useful fallback for Tarragona, because there is no open data.
- **ATM Girona:** zone map plus counter **[R]**. **ATM Lleida:** fare page and zone map **[R]**.
- **FGC:** "Bitllets: cercador de preus i zones" (station → station: zones plus price) **[R]**.
- **Renfe:** the venta.renfe.com search, used by the open-source clients in §5 **[R]**.
- **ToS and legal stance:**
  - Generalitat, ATM and NAP data is reusable under open licences (Llicència oberta Catalunya; Ley 37/2007 / MITRAMS LDA) **[V-23]**.
  - Web calculators are not licensed APIs.
  - If used: on-demand only, cache the results (zone counts rarely change), identify with a generic UA, respect robots.txt, never bypass auth or captcha, and degrade gracefully.
  - Do not bulk-scrape Renfe.

---

## 10. Proposed approach for Arribo!

### 10.1 Data to ingest

1. **ATM CGIM fares v2** (from the T-mobilitat static GTFS, which Arribo will need for Catalonia-wide timetables anyway). Ingest areas, stop_areas, fare_products, fare_leg_rules, fare_transfer_rules, fare_leg_join_rules and route_networks into compact lookup tables:
   - `stop → sector` (and the optional municipality or station override area)
   - `(sectorA, sectorB) → zones`, kept separately for MV, AB and BS
   - the overrides, keyed by `(areaA, areaB)` and priority
   - `product → price per zone`, with rider category
   - `route → in STI_Barcelona?`

   Refresh it with the timetable feed. Diff fare_products on each refresh to detect the January price change.
2. **A curated "fare overlay" JSON**, hand-maintained, versioned, one per calendar year, each entry with its `valid_from` and `source_url`, holding what no open feed has:
   - **Non-integrated operator titles**, per route or agency: Mataró Bus (1.70 / T-10 4.85 / T-Rosa 3.95), TUS, TMESA, etc.
   - **Exclusions and supplements:** Aerobús (own fare), L9 airport stations (Bitllet Aeroport 5.90; T-casual and BS not valid), the Núria cremallera, the Montserrat cremallera and the cable cars (own fare), the tourist bus.
   - **ATM Girona, Lleida and Camp de Tarragona** product tables (≈ 4 zones × 5–6 products each) and a **municipality → zone** table for each. Build it once from their zone maps and counters; it changes rarely, mainly with integrations such as Terres de l'Ebre and Ripollès in 2026.
   - **Renfe distance bands** (the TARIFAS-KM PDF) plus a station-km table, as an *estimate* for non-integrated Regionals.
   - **Pass context:** Rodalies 20 € monthly, Abono Único 60/30 €, T-16, T-jove, Targeta Rosa, unemployed T-usual. Show these as notes, not as per-trip prices.
3. **Optional on-demand fallbacks:** Renfe price lookup (unofficial), FGC and ATM calculators. Cache results by O-D for ≥ 30 days. Treat failures as "preu no disponible".

### 10.2 Zone per stop

- **ATM Barcelona:** take the sector from `stop_areas` (one per stop, verified), joined via the CGIM `stop_id`. Map Arribo's Mataró stop ids (155) to `MAT_*` by `stop_code` or name plus coordinates; all are 3E. For feeds Arribo ingests from other sources (Generalitat GTFS, Renfe GTFS), crosswalk to the CGIM stop by prefix id or `stop_code`, else by nearest stop of the same mode within about 50 m. If there is no match, fall back to **point-in-municipality** (an IDESCAT/ICGC municipality polygon) plus a **municipality → sector** table built from CGIM, where most municipalities have a single sector.
- **Other ATMs:** stop → municipality (polygon or `GEN_` stop code prefix, since `PF08121…` codes embed the INE code) → zone, from the curated table.
- **Never show a zone count without its basis.** Keep the sector names so the UI can say "3E → 1 · 3 zones".

### 10.3 Cheapest suitable ticket: 1-leg and 2-leg journeys

**Step 1. Classify each leg:**
- `ATM_BCN` if its route is in `STI_Barcelona` **and** both stops have a sector **and** the route is not on the exclusion list
- `ATM_GIR`, `ATM_LLE` or `ATM_CTA` via the overlay
- `OWN` (operator title only, e.g. Aerobús, cremalleres)
- `RENFE_DIST`
- `UNKNOWN`

**Step 2. Price the journey:**
- **1 leg, ATM_BCN:**
  1. Zones come from the sector matrix.
  2. Then check the priority overrides (ROD_Z1, FGC_Z1, BUS_Z1). They lower the count to 1 zone **only for MV products** (T-casual, T-familiar, T-grup, T-70/90).
  3. Candidates: BS(n), TC(n)/10 per trip, plus any **operator own single ticket** for that route (e.g. Mataró 1.70).
  4. Show the **cheapest single purchase** (the lower of BS and own single) **and** the **cheapest per trip with a multi-trip card** (T-casual/10, own T-10/10), plus pass break-even hints, e.g. "T-usual 3 zones 42.70 €/30 dies: et surt a compte a partir de ~13 viatges".
- **2 legs, both ATM_BCN:**
  1. The fare is a **single journey**, priced from the **first boarding sector to the last alighting sector** (`fare_leg_join_rules`). With MV products the transfer is free if total elapsed time ≤ 75 + 15·(n−1) min (210 min for 7 zones) and there are ≤ 3 transfers.
  2. Compare it against two separate BS(n1)+BS(n2) purchases, because the BS has no transfer.
  3. Also compare against own-single + own-single when the legs are on the same operator (Mataró 1.70 with free line change within 1 h 15).
  4. Use the planner's real times to check the time window. If the timeline exceeds it, show two validations: "cal validar de nou".
- **2 legs across systems** (ATM_BCN + RENFE_DIST, ATM_BCN + ATM_GIR, or OWN + ATM):
  - **Sum** the per-system prices. There is no integrated transfer between ATMs; an ATM Barcelona title is not valid in ATM Girona.
  - Exceptions are the overlap areas: Ripollès (zone 7 BCN **and** Girona STI) and the Rodalies stations served by several ATMs. In those cases, offer both options.
- **UNKNOWN legs:** show "preu no disponible — consulta l'operador" with the agency's `agency_fare_url` (which is often filled in CGIM) instead of guessing.

### 10.4 Honest labelling ("preu orientatiu")

- Always caption it: **"Preu orientatiu. Tarifes 2026 (vigents des del 15/01/2026). El preu final depèn del títol i de les condicions de l'operador."**
- Put a per-figure badge with the source class:
  - *Oficial ATM (dades obertes)*
  - *Tarifa de l'operador (revisada dd/mm/aaaa)*
  - *Estimació per distància*
  - *Consultat a Renfe (no oficial)*
- **Show the zone count and the sectors.** Note when an override applied ("tram frontera: 1 zona amb T-casual").
- **Never present a discounted pass as the trip price.** Show discounts (T-jove, T-16, FM/FN, Targeta Rosa, unemployed) as "si tens dret a…" notes, keyed by rider category.
- Follow Arribo's telemetry-honesty principle: a missing price is "desconegut", never 0. T-16 = 0 € is legitimate only as a labelled eligible-rider option.

### 10.5 Edge cases

- **Boundary stops.** Every ATM BCN stop has exactly one sector, so handle "frontera" cases with the 114 station-pair and 228 municipality-pair overrides, and **only for MV products**. The prime sectors (`2A'/2B'/2C'`) behave as zone 1 from Barcelona: trust the matrix and do not infer zones from the sector's first digit.
- **The matrix is not symmetric in 2 pairs** of 4,761 **[V]**. Look up in the travel direction.
- **Same-line round trips** (anada i tornada) over two days count as 2 journeys.
- **Aerobús, airport and L9:** use the overrides from §1.4. The R2N to the Aeroport station is sector 1 with ATM titles valid; the supplement applies to metro only **[R]**.
- **ATM titles listed on routes where they are not valid** (Núria; Montserrat tourist fare): use the exclusion list.
- **Cross-ATM journeys and Rodalies outside ATM BCN** (Girona, Figueres, Tarragona, Lleida): sum the parts, use Renfe distance-band estimates, and label them.
- **Zone 7 rule:** 7 zones only if the trip starts or ends in Berguedà, Ripollès or Solsonès. The matrix already encodes this (anything → 7x = 7).
- **Discount volatility:** the 50% T-usual/T-jove discount depends on yearly State co-funding (RDL 17/2025 for 2026). Keep `discount_valid_until` and show a warning when it lapses.
- **Grace periods:** titles bought before 15 Jan stay valid until ~28 Feb. This does not matter for pricing a new trip.
- **Future EMV pay-as-you-go (2027):** single tickets only, tap in and out. Revisit then.

### 10.6 Update cadence

- **January (main event).** ATM Barcelona, the three Generalitat ATMs, Renfe and the urban operators all change fares around **1–15 January**; 2026's took effect on 15 Jan. Schedule a check from late December (the ATM board approves in mid-December, the DOGC publishes in mid-January).
- **Ingestion check.** Re-ingest the CGIM fares daily alongside the timetable. Alert when `fare_products` amounts change or when `stop_areas` gains or loses sectors, which happens on integrations such as zone 7 in July 2025.
- **Mid-year events.** Integrations (Terres de l'Ebre and Ripollès in March 2026), Renfe pass changes (26 Jan, 9 May 2026), discount extensions (usually decided in December and June) and operator-specific changes (TUS on 1 May 2026). Review the curated overlay **quarterly**, and stamp every entry with its `checked_on` date.
- **Cache policy.** Calculator and Renfe lookups: up to 30 days, but invalidated at each January change.

### 10.7 Still to verify (could not be done here)

1. Download the live AMB feed (23-Nov) and confirm its fare_products and fare_leg_rules contents. It is probably redundant with CGIM.
2. Open the official DOGC 2026 ATM PDF and confirm the T-4, Bitllet Aeroport and unemployed T-usual figures.
3. ATM Girona, Lleida and Camp de Tarragona: full 2026 tables (T-JOVE, T-50/30, T-70/90), and a municipality → zone extraction from their counters.
4. Urban single-ticket prices for Girona, Lleida, Tarragona, Reus and Terrassa in 2026.
5. Whether the 20 € Rodalies pass and the Abono Único continue into 2027.
6. Probe the ATM, FGC and Renfe calculator endpoints (light GETs), once their hosts are allowed in the session's network settings: `www.atm.cat`, `ca-sermetra.atm.cat`, `www.fgc.cat`, `ssl.renfe.com`, `venta.renfe.com`, `www.ambmobilitat.cat`, `territori.gencat.cat`.

---

### Sources (search-reported unless marked [V])

- **[V] ATM CGIM GTFS** (Mobility Database mdb-2832, `Last-Modified 2026-11-23`). Local copy: `(research scratch files, not committed)`; fare files copied to `(research scratch files, not committed)`.
- [V] Other GTFS copies: `(research scratch files, not committed)`, `(research scratch files, not committed)`.
- [V-23] `/home/user/Arribo/docs/research/MOVENTIS_SOURCES.md`.
- ATM 2026 fares: [beteve](https://beteve.cat/mobilitat/tarifes-atm-2025-tmb-transport-public-barcelona/), [totbarcelona](https://www.totbarcelona.cat/societat/aixi-quedaran-les-noves-tarifes-del-transport-public-a-barcelona-per-al-2026-679602/), [3cat](https://www.3cat.cat/3catinfo/com-queden-les-tarifes-del-transport-public-per-al-2026-a-barcelona-tarragona-lleida-i-girona/noticia/3386238/), [Ajuntament BCN](https://ajuntament.barcelona.cat/premsa/2025/12/16/latm-mantindra-totes-les-bonificacions-del-transport-public-per-al-2026/), [DOGC ATM 2026 PDF](https://ca-sermetra.atm.cat/documents/662112/2707738/Tarifes_DOGC_ATMBarcelona_2026.pdf/0be94269-ccb1-d72a-b964-5b51bb22a379?t=1769354537414), [ATM bitllet senzill](https://www.atm.cat/en/titols-i-tarifes/bitllet-senzill), [ATM STI functioning](https://www.atm.cat/en/titols-tarifes/sistema-de-transport/funcionament-del-sistema-tarifari-integrat), [ATM 7-zone approval](https://www.atm.cat/en/w/ndp_l-atm-de-barcelona-aprova-els-preus-dels-t%C3%ADtols-de-7-zones-que-integraran-plenament-a-les-comarques-del-bergued%C3%A0-el-ripoll%C3%A8s-i-el-solson%C3%A8s-1), [Rodalies zone 7](https://rodalies.gencat.cat/ca/detalls/article/06_18_zona_7_ATM), [ATM tarifació social](https://www.atm.cat/en/titols-tarifes/titols-i-tarifes/tarifaciosocial), [TMB 2026 reductions (T-4)](https://www.tmb.cat/en/barcelona-fares-metro-bus/transport-fares-reduction), [metropoliabierta T-rosa](https://www.metropoliabierta.cat/mobilitat/20260108/popular-targeta-metro-barcelona-puja-preu-gener-afectara-usuaris/1003742721822_0.html), [TMB conditions (no transfer on BS)](https://www.tmb.cat/ca/tarifes-metro-bus-barcelona/condicions-us-bitllets), [3cat EMV 2027](https://www.3cat.cat/3catinfo/el-transport-public-de-barcelona-es-podra-pagar-directament-amb-targeta-bancaria-a-partir-del-2027/noticia/3425972/)
- Airport: [barcelona.com L9](https://www.barcelona.com/transportation/barcelona-airport-bcn/metro), [travelgingers](https://travelgingers.cz/en/barcelona-public-transport/)
- Other ATMs: [ATM Camp de Tarragona tarifes](https://www.atmcamptarragona.cat/tarifes/), [comptador de zones CT](https://www.atmcamptarragona.cat/comptador-de-zones/), [ATM Girona tarifes](https://www.atmgirona.cat/tarifes/), [Ripollès → ATM Girona](https://ripolles.cat/2026/03/03/el-ripolles-entra-al-sistema-tarifari-integrat-de-latm-de-girona-amb-preus-i-abonaments-de-transport-public-mes-competitius/), [ATM Lleida fares](https://atmlleida.cat/en/fares/), [FGC notice C0226 (Lleida)](https://www.fgc.cat/wp-content/uploads/2026/01/C0226_Canvi-tarifes-gener-i-validesa_LPS.pdf), [govern.cat 50%](https://govern.cat/gov/notes-premsa/778776/les-atm-de-girona-lleida-i-camp-de-tarragona-mantenen-els-descomptes-del-50-percent-al-transport-public)
- Renfe and Rodalies: [Rodalies abonaments 2026 PDF](https://rodalies.gencat.cat/web/.content/01_Actualitat/2025/12_29_Infomacio-tarifes-2026/Tarifes_Tarifas_Fares_2026_A3_v4.pdf), [Rodalies gratuïtat](https://rodalies.gencat.cat/ca/detalls/article/01_26_Mesures_gratuitat), [catalunyapress 9 May](https://www.catalunyapress.cat/article/societat/2026-05-03/5866658-9-maig-rodalies-catalunya-activa-nous-abonaments-amb-preus-i-usos-adaptats-cada-viatger), [laciutat](https://laciutat.cat/catalunya/rodalies-de-catalunya-estrena-nova-oferta-d-abonaments-despres-de-la-fi-de-la-gratuitat-el-9-de-maig_890813_102.html), [Abono Único (Rodalies)](https://rodalies.gencat.cat/es/tarifes/Abono-unico/index.html), [Ministerio](https://www.transportes.gob.es/ministerio/comunicacion/sala-prensa/mar-23122025-1410), [Rodalies TARIFAS-KM](https://rodalies.gencat.cat/web/.content/03_Tarifes/TARIFAS-KM.pdf), [Només rodalia](https://rodalies.gencat.cat/en/tarifes/servei_rodalia_barcelona/nomes_rodalies/index.html), [renfe-cli](https://github.com/Sn4pe/renfe-cli), [renfe_mcp_server](https://github.com/afiodorov/renfe_mcp_server), [data.renfe.com](https://data.renfe.com/dataset)
- FGC and tourist: [FGC bitllets cercador](https://www.fgc.cat/bitllets/), [Turistren Montserrat](https://turistren.cat/en/trains/montserrat-rack-railway-and-funiculars/), [Núria](https://barcelonaurbana.com/ca/blog/vall-de-nuria-preu-del-cremallera-i-horaris), [Montjuïc funicular](https://barcelonaurbana.com/ca/blog/teleferic-i-funicular-de-montjuic-preus)
- Urban: [Mataró Avanza tarifes](https://mataro.avanzagrupo.com/ca/tarifas-y-titulos), [Mataró títols propis](https://mataro.avanzagrupo.com/ca/titulos-propios), [TUS 2026](https://www.isabadell.cat/societat/mobilitat/preus-bus-tus-2026-326544/), [TMESA tarifes](https://tmesa.com/p/tarifes-preus-targetes-bus-terrassa-tmesa/)
- Interurban: [Soler i Sauret O-D tarifes 2026](https://solerisauret.com/pdf/tarifa-billets-senzills-interurbans.pdf), [Mobility Database AMB](https://mobilitydatabase.org/feeds/gtfs/mdb-892), [GTFS fares reference](https://gtfs.org/documentation/schedule/reference/)
