# F — Public bus transport in the provinces of Tarragona and Lleida

Research for Arribo!, dated **2026-11-24**. Research only: no application code was changed.

## 0. How this was researched, and what the labels mean

**Network limits in this session.** The egress proxy allowed only `github.com`, `api.github.com`, `raw.githubusercontent.com` and `storage.googleapis.com`. It refused every operator and government host: `territori.gencat.cat`, `t-mobilitat.cat`, `nap.transportes.gob.es`, `moventis.es`, `emtanemambtu.cat`, `reustransport.cat`, `tarragona.cat`, `paeria.cat`, `gbfs.ganxeta.cat`, `atmcamptarragona.cat`, `atmlleida.cat`, `transit.land` and `apps.apple.com` (curl returned 403, and WebFetch could not resolve the hosts). The shared WebSearch budget ran out partway through the research. So:

- **No operator endpoint was probed live today.** Real-time endpoints below come from third-party code and documentation on GitHub and from earlier research. They are labelled accordingly.
- **The static data was downloaded and analysed today** from the MobilityData mirror bucket on `storage.googleapis.com` (`mobilitydata-datasets-prod/mdb-<id>/latest.zip`). That bucket holds same-day copies of the official feeds, including the Generalitat ZIP.

| Label | Meaning |
|---|---|
| **[V]** | Verified today, from data downloaded and parsed in this session, or from a document read in full today (with its date given) |
| **[R]** | Reported: a third-party source or a web-search snippet. Not probed today |
| **[K]** | Background knowledge. Unverified, so treat it as a lead |

### Data downloaded today (all [V])

Each feed sits in its own directory under `(research scratch files, not committed)`.

| MDB id | Feed | Mirror Last-Modified | Notes |
|---|---|---|---|
| mdb-2926 (= mdb-2796, byte-identical) | **Generalitat interurban GTFS** (`busos-interurbans-GTFS.zip`) | **2026-11-24 01:51 UTC** | 24.1 MB. 110 agencies. Calendar runs 2026-01-01 → 2027-06-30. Has `shapes.txt` and a non-standard `nota.txt` holding per-trip notes such as booking rules. The older bucket path `mdb-latest/o/…2926.zip` is stale (2026-06-04), so don't use it |
| mdb-2832 | **ATM / CGIM "simplificada" GTFS** (NAP 2059, all Catalonia) | 2026-11-23 01:19 | 58.7 MB. Prefixed ids (`TAR_`, `REU_`, `LLE_`, `GEN_`…). Has `fare_*` (GTFS-Fares v2), `areas` and `networks` |
| mdb-2777 | EMT Tarragona (NAP 1694) | 2026-10-08 | Calendar 2026-06-22 → 2026-12-31. **No shapes** |
| mdb-2753 | Autobusos de Lleida (NAP 1579) | 2026-11-20 | `calendar_dates` 2026-11-19 → 2026-12-31. Has shapes |
| mdb-2803 | Reus Transport (NAP 1788) | 2025-08-18 | **Deprecated, and its calendar ended 2026-02-23.** No shapes |
| mdb-3081 | Reus Transport "Bus x Tu" GTFS-Flex (Spare) | 2026-11-24 01:50 | Direct URL needs no key (see §2.2) |
| mdb-2805 | Cots Alsina (NAP 2009) | 2025-08-18 | Stale, and route names carry times |
| mdb-2809 | Avanza VAC-124 Huesca–Lleida (NAP 1713) | 2025-08-18 | `feed_end_date` 20240630, so expired |

Also used: the MobilityData `feeds_v2.csv` catalogue (same bucket), Transitland atlas DMFR (raw GitHub), and the INE municipality list (`codeforspain/ds-organizacion-administrativa`). Gencat `stop_id`s are `PF` plus the 5-digit INE municipality code, so the province can be read from the id: **43 = Tarragona, 25 = Lleida**.

**Filter output:** 399 Gencat routes touch province 43 or 25. They are in `F_gtfs/gencat_43_25.json` and `F_gtfs/gencat_43_25.txt`, one line per route: agency | code | name | provinces | trips in the week 2026-11-23…29 | total trips | shape | top municipalities. Booking, school and festive notes for those routes are in `F_gtfs/notes_kw.txt`. The scripts are in `F_scripts/`.

---

## 1. Master table

**Column key.** RT means real-time: **GPS** = vehicle positions, **ETA** = stop predictions, **none** = timetable only. Static source: **G** = Gencat interurban GTFS (open, no key); **A** = ATM/CGIM GTFS (T-mobilitat token, or NAP 2059/2060 with a key); **N####** = NAP file id (free key). "wk" = scheduled trips in the week of 2026-11-23, counted from the GTFS.

### 1a. Province of Tarragona: municipal and urban services

| Municipality | Operator | Lines (codes as in GTFS) | Real-time? | RT source | Static source | Notes |
|---|---|---|---|---|---|---|
| **Tarragona** (+ La Canonja) | EMT Tarragona (Empresa Municipal de Transports Públics de Tarragona) | 3, 5, 6, 8, 11, 12, 13, 21, 22, 23, 30, 34, 41, 42, 43, 54, 55, 85; night 71, 72, 73 **[V]** | ETA in the app **[R]** | App "EMT Tarragona" (iOS id435718030; built by Technodac; renewed in 2025 with waiting times and incidents) and QR codes at stops **[R]**. **Backend endpoint not found** | N1694 (mdb-2777) **[V]**; A `TAR_` **[V]**; Google Transit since 2011 **[R]** | **New 17-line network starts 2026-12-22 [R]**, so both GTFS feeds (valid to 2026-12-31) will be wrong from that date. Lines 3, 30 and 72 serve La Canonja. Night lines 71–73 run Fri/Sat and the eves of public holidays (~17 nights a month) **[V]**. No `shapes.txt` in either feed **[V]**. 2,113 trips in ATM **[V]**. Santa Tecla (September) and Sant Magí (August) special services are **not in the GTFS [K]** |
| **Reus** | Reus Transport (Reus Transport Públic SA, municipal) | L10, L11, L20, L21, L30, L31, L32, L33, L35, L40–L44 (school), L50 Aeroport, L60, L80 Fira Reus, L81 Parc de Nadal, L82 Fira Reus (serveis) **[V]** | ETA in the app **[R]** | App "Reus Transport Bus ONLINE" (iOS id384665389, around since 2010) **[R]**. **Backend not found**. Displays at main stops **[R]** | A `REU_` (calendar 2026-10-09 → 2027-10-09, the current copy) **[V]**; N1788 is stale **[V]** | **L80 runs only 2026-10-09…12** (the Fira) **[V]**. L81, L82 and L35 have route rows but **zero trips** in the current ATM copy: they are loaded seasonally (Parc de Nadal at Christmas, Tots Sants on 1 Nov) **[V]**. L32 and L33 run 4–6 trips a week **[V]**. School lines L40–L44: 1 trip a day each **[V]**. No shapes **[V]**. Misericòrdia (25 Sep) and Sant Pere (29 Jun) specials are not in the GTFS **[K]** |
| Reus (demand-responsive) | Reus Transport, using the Spare platform | D1 "Bus x Tu" (3 flex routes: to centre, to barris, Cementiri) **[V]** | GPS of the booked vehicle, in the booking app only **[R]** | BusXtu app (Spare) **[R]**. No public feed | **GTFS-Flex, open**: `https://api.sparelabs.com/v1/gtfs/generate/organization/78112279-c065-4987-be69-bc18ab604142` (mdb-3081) **[V]** | Mon–Fri 06:30–21:30, zones El Pinar / Urb. Sant Joan / Passeig Nord–Mineta / Av. Sant Jordi / Cementiri **[V]**. Four electric minibuses due in January 2027 **[R]** |
| Reus (bike share, for context) | Ganxeta (Reus Mobilitat i Serveis SA) | 21 stations **[R]** | Live dock status | **GBFS 2.3/3.0**: `https://gbfs.ganxeta.cat/v3/gbfs.json` (MobilityData `systems.csv` **[V]**; host blocked here); GraphQL `https://bks-api.ganxeta.cat/rms-bike-sharing-real-time/graphql`, operation `StationsRealtime` (pybikes **[V]**) | — | Licence: MDB says CC BY 4.0, while a third-party catalogue says CC0 **[V: the two catalogues disagree]** |
| **Valls** | HIFE | L1, L1diss, L2, L2diss, L2p (Polígon) **[V]** | none known | — | A `VAL_` (to 2026-12-31) **[V]** | ~12 trips a weekday per line **[V]** |
| **El Vendrell** (+ Coma-ruga, Sant Salvador, Roda de Berà part) | Autocars del Penedès (Generalitat-registered "urban") | L0, L1, L2; L1p, L2p, L3p; school/mixed L1e, L2e (×2), L3e, L4e, L5e **[V]** | none known | — | G (L1671–L1682, L1674) **[V]** | The `e` and `p` variants are school or partial services (2–8 trips a week) **[V]** |
| **Calafell** (+ Segur de Calafell) | HIFE | L1, L2, L3 **[V]** | none known | — | A `CAL_` (calendar from 2026-11-10, so newly reloaded) **[V]** | ~20 trips a weekday per line **[V]** |
| **Cunit** | Empresa Plana | "Ruta 1" **[V]** | none known | — | A `CUN_` **[V]** | 16 trips a weekday **[V]** |
| **Torredembarra** | HIFE | L1, L2 (Pl. del Mar – Rotonda N-340, C. Comercial; L2 via Polígon Centre Onada) **[V]** | none known | — | A `TRD_` **[V]** | 11 trips a weekday each **[V]** |
| **Cambrils** | Empresa Plana | (L1) llevant, (L2) ponent **[V]** | none known | — | G L0689, L0688 **[V]** | Wednesday market: some stops skipped (per `nota`) **[V]** |
| **Vila-seca / La Pineda** | Empresa Plana | (L1) Vila-seca–La Pineda, (L2), (L3), (L4) C. Comercial, (L11) Instituts, (L22), (L33) **[V]** | none known | — | G L1847–L1850, L2222–L2224 **[V]** | L1 has 317 trips a week **[V]** |
| **Salou** | **No municipal urban bus [R]** | — | — | — | — | A circular urban line is planned for 2027 (2026 budget) **[R]**. Served by Plana interurban, Port Aventura and ECT lines (§1c) |
| **Tortosa** (+ Jesús, Roquetes) | HIFE | (L1) Tortosa–Jesús–Roquetes **[V]** (G L1610); L2, L3, LD, plus "agost" variants L2A, L3A, LDA **[V]** (A `TTS_`); Llançadora Hospital Verge de la Cinta (G L1728); shuttles to l'Aldea station (G L1733) **[V]** | none known | — | G + A **[V]** | **Quirk:** the "(agost)" variants actually run September–June in the current ATM file, so trust the calendars, not the names **[V]** |
| **Amposta** | HIFE | L1, L2 **[V]** | none known | — | A `AMP_` **[V]** | L1: 24 trips a weekday; L2: 4 a weekday **[V]**. Also shuttle Amposta – l'Aldea station (G L1734) |
| **Mont-roig del Camp** | Nostreserveis (municipal public company) | Casalot – Mont-roig del Camp (both directions) **[V]** | none | — | A `MON_` **[V]** | 4 trips a weekday each way **[V]**. Miami Platja summer services: not found **[K]** |
| **Vandellòs i l'Hospitalet de l'Infant** | Municipal bus | L'Almadrava – L'Hospitalet – Vandellòs (weekday and Saturday variants) **[V]** | none | — | A `VHI_` **[V]** | 14 trips a weekday each way **[V]** |
| **Móra d'Ebre** | TPP Domènech Autocars | M1 La Figuera – Móra d'Ebre (Hospital), **on demand**: book by 12:00 the day before, tel. 977 831 871 **[V]** | none | — | A `MOR_` **[V]** | 2 trips a week **[V]**. Also shuttle Móra d'Ebre – Móra la Nova station (G L0520, 113 trips a week) **[V]** |
| **Falset / Marçà** | TPP Domènech | Falset – Marçà rail station shuttle (G L1508) **[V]** | none | — | G **[V]** | 120 trips a week |
| **L'Ametlla de Mar** | Empresa Plana | "Tortosa – l'Ametlla de Mar i urbanitzacions" (G L0769) **[V]** | none | — | G **[V]** | A separate summer-only beach or urbanisation bus was **not found** in any feed **[K: may exist as a municipal contract outside the GTFS]** |
| Altafulla, Deltebre, La Ràpita (formerly Sant Carles de la Ràpita), Montblanc, Alcanar, L'Ampolla, Riudoms, Constantí, Creixell | — | **No urban bus in any feed [V]** | — | — | — | Served only by interurban lines. Any summer-only urban or beach bus in these towns is **not in the GTFS**; needs municipal confirmation **[K]** |

### 1b. Province of Lleida: municipal and urban services

| Municipality | Operator | Lines | Real-time? | RT source | Static source | Notes |
|---|---|---|---|---|---|---|
| **Lleida** | **Autobusos de Lleida SA (Moventis / Sarbus group)** | 1 Interior, 2 Ronda–Hospitals, 3 Exterior–Hospitals, 4, 5, 6, 7, 8, 9 Polígons, 10, 16 Ciutat Jardí, 20 Ronda, 70 Llívia–Cappont, N1 (night) **[V]**; Bus Turístic de Lleida (brand subzone, no rows) **[R]** | **ETA** (live countdown flag `real:"S"` plus timetable fallback) **[R, documented 2026-10-03]** | Moventis' undocumented web JSON: `GET https://www.moventis.es/api/json/GetTiemposParada/{es\|ca}/{ID_PARADA}/{ID_LINEA}/0`; QR at every stop → `paeria.es/buslleida/`; Moventis app **[R]** | N1579 (mdb-2753) **[V]**; A `LLE_` **[V]** | **The NAP and ATM `stop_id` equals Moventis `ID_PARADA`, and `stop_code` equals the public `COD_PARADA` (e.g. 10161 / 20209) [V]**, so live arrivals join the GTFS with no matching step. Line 70 and N1 run on a few dates only (N1: Saturdays plus festes; 70: ~14 dates over Nov–Dec) **[V]**. The Lleida zone disappeared from the Moventis line feed from 2026-08-02 to some date before 2026-10-03 **[R]**. Festa Major (May), Aplec del Caragol (May, Camps Elisis: night specials 23:00–01:00, N1 also runs) and Fira de Sant Miquel are **not modelled** beyond N1 dates **[R/K]** |
| Lleida area "urban-like" interurban | Sarbus/Marfina (121 El Cogul, 120 L'Albagés, 122 Torres de Segre, 401 Alcarràs–Torres) **[R]**; Gamón and Autobusos de Lleida (NL1, NL2 night) **[V]**; bus exprés e2–e6 **[V]** | — | Sarbus lines appear in the Moventis feed (ID_ZONA 2, subzone 3), so the same ETA API applies **[R]** | Moventis JSON | G (L0271, L0425, L0756, L0755, L1536, L1537) **[V]** | NL1 and NL2: 7–8 trips a week (weekend nights) **[V]** |
| **Balaguer** | ALSA (Alsina Graells) | "Urb. Balaguer Ruta Principal Línea 1 y 4" (L1-L4), "Escolar Línea 2 y 3" (L2-L3) **[V]** | none known | — | A `ALS_3229`, `ALS_3703` **[V]** | L2-L3 is school-only (6 trips a day) **[V]** |
| **Tàrrega** | ALSA (Alsina Graells) | "Urbà de Tàrrega" **[V]** | none known | — | G L1948 **[V]** | 27 trips a weekday |
| **Solsona** | ALSA (Alsina Graells) | Solsona – el Pi de Sant Just (urban in practice) **[V]** | none | — | G L0965 **[V]** | 115 trips a week |
| **Mollerussa** | — | **No urban line in any feed [V]** | — | — | — | A municipal urban service may exist outside the GTFS **[K]** |
| **Cervera** | Cots Alsina (rural network centred on Cervera/Guissona) | 19 Gencat routes, many on demand via the "Cots Alsina clic.cat" app or WhatsApp 677 49 49 05 **[V]** | none | — | G **[V]**; N2009 (stale) | No urban line **[V]** |
| **La Seu d'Urgell** | — (hub of on-demand rural lines) | No urban line in any feed **[V]** | — | — | — | Hub for ~15 demand-responsive (TAD) feeder lines (§1d) **[V]**. A municipal bus is possible outside the GTFS **[K]** |
| **Tremp / La Pobla de Segur** | — | No urban line **[V]** | — | — | — | Hub for ~15 TAD feeders (§1d) |
| **Sort** | — | No urban line **[V]** | — | — | — | Hub for ~20 TAD feeders, plus Port Ainé and Espot ski buses |
| **Vielha e Mijaran / Val d'Aran** | ALSA; Alsa–Nex Continental; liO Occitanie | ALSA: Arró–Arròs–Vila–Vielha (`ALS_9403`, `9405`), Canejan–Les–Bossòst (`ALS_9404`), Vielha–Taüll–Pla de l'Ermita (`ALS_3326`); `BLB` Bossòst–Les–Bausen; **liO line 395 Les – Barbazan – Saint-Gaudens** (`LIO_395`) **[V]** | liO: **GTFS-RT VehiclePositions + TripUpdates (open, ODbL)** **[V: catalogue]**. ALSA: none known | `https://www.data.gouv.fr/api/1/datasets/r/3a40f4e7-3068-43d2-9cd1-7b33cb0c2fe5` (VP), `…/5bcc6b45-c538-4410-a752-8f32b54eb857` (TU) **[V: catalogue]**. Whether line 395 actually appears in them is **not verified** | A; liO GTFS `…/d747fe79-2915-4cdd-8cc5-51a810baaca5` **[V: catalogue]** | **Baqueira-Beret free ski bus** (resort-run; ALSA operates it **[K]**): **not in any feed [V]**. No Vielha town bus found **[V]** |
| **El Pont de Suert / Vall de Boí** | ALSA, Autocars Palmerola | Pont de Suert–Vielha (L2272), Tremp–Pont de Suert (L2206), **Vilaller–Pont de Suert–Taüll (ski slopes, L0876)**, **Bus del Parc** (L1645, summer only: data shows 2027-06-23 onward) **[V]** | none | — | G **[V]** | Ski bus to Boí Taüll: 8–23 days a month in season **[V]** |

### 1c. Seasonal, tourist, airport and Port Aventura services (Tarragona coast)

All via Gencat (G) **[V]**. Real-time: none known.

| Code | Operator | Route | Active period in the GTFS **[V]** |
|---|---|---|---|
| L0411 | Plana | BM Cambrils – Port Aventura | All year (39 trips) |
| L0410 | Plana | La Pineda – Port Aventura | May–Oct plus Jan–Apr 2027 (Port Aventura park calendar) |
| L0635 | Plana | Salou – P. Aventura – Vila-seca | All year |
| L1842 | Plana | Salou – Baixador de Renfe – Port Aventura | All year (196 trips a week) |
| L0715 | Plana | Tarragona – Port Aventura | Oct–May (winter) |
| L1688 | Plana | Cambrils – Salou – Port Aventura (**hivern**, winter) | Oct–Apr |
| L1621 / L1626 | Plana | Tarragona – Pineda – Salou – Port Aventura / – Camí Cavet | Jun–Sep only |
| L1815 / L1817 | Plana | Cambrils / La Pineda – Salou – Estació del Camp de Tarragona (ECT, high-speed station) "(juny-set)" | Jun–Sep only |
| L1632, L1787, L1788, L0787 | Plana | Costa Daurada / Reus / Tarragona / Valls – ECT | All year; ECT shuttles to the AVE station |
| L1799 | Plana | Vistabella – ECT (**TAD**, on demand) | All year |
| L0019, L0177 | Plana | Alforja–Salou; BM Cambrils–Reus via Salou | Summer only (Jul–Aug; May–Oct) |
| L0412 (N4), L0525 (N2), L0529 (N3), L0526 (N1), L0528 (N5), L0527 (N6) | Plana, Hispano Igualadina, Autocars del Penedès | **Camp de Tarragona night network (SN)**: N1 Reus–Tarragona, N2 Reus–Salou, N3 Tarragona–Salou, N4 La Pineda–Salou–Cambrils, N5 Valls–Tarragona, N6 Torredembarra–Tarragona | Weekends all year; **every night in Jul–Aug** (N4) |
| **L1826** | **La Hispano Igualadina (Monbus group)** | **Aeroport de Reus – Tarragona** | **Mar–Oct only (flight season)**; 0 trips in November |
| L50 (REU_50) | Reus Transport | **Aeroport** (urban) | From 2026-10-23 daily; before that only scattered dates |
| L1463 | HIFE | Lleida – Salou – Platja de la Pineda | Weekends; daily Jul–Aug |
| L0414 | ALSA | La Pobla de Lillet – Tarragona – Cambrils | Weekends; daily in summer |
| L0380, L0491 | Hispano Igualadina | Igualada – Coma-ruga – Calafell – Cunit; Manresa – Tarragona | School-term or seasonal (0 trips this week) |

### 1d. Province of Lleida: ski, mountain and seasonal (G **[V]**)

| Code | Operator | Route | Period |
|---|---|---|---|
| L1668 | Rabasa Turístic | Sort – **Port Ainé** | Dec–Apr |
| L1669 | ALSA | Lleida – Port Ainé | Jan–Apr 2027, weekends |
| ALS_9391/9392 | ALSA | Lleida – Portainé (ATM copy) | 0 trips this week |
| L1722 / L1647 | Autocars Mario / ALSA | Sort – **Espot** (estació) winter / Sort – Espot summer | Jan–Apr / Jun–Sep |
| L1820 | ALSA | La Pobla de Segur – Espot | From 2027-06-23 (summer) |
| L1880 | Ivan Pey Queró | Llavorsí – **Pleta del Prat** (Tavascan ski) | ~2 days a week all year, more in winter |
| L1918 | Pere Cortina | La Guingueta d'Àneu – **Cap del Port / La Peülla** (ski) | As above |
| L0876 | Autocars Palmerola | Vilaller – Pont de Suert – **Taüll** (Boí Taüll ski) | Daily in winter, weekends otherwise |
| L1645 | ALSA | **Bus del Parc** (Aigüestortes) | Summer (from 2027-06-23 in the data) |
| L0699 | Pau Colom | Sort – La Seu d'Urgell (on demand) | Apr–Oct |
| L1112 | ALSA | La Pobla de Segur – Pont de Suert | Daily in Jul–Aug, otherwise weekly |
| — | Baqueira-Beret ski bus; Port del Comte bus | — | **Not in any GTFS [V]** |

### 1e. Very-low-frequency and demand-responsive rural lines (TAD / "transport a la demanda")

Read from `nota.txt` in Gencat GTFS **[V]**. Full list in `F_gtfs/notes_kw.txt`.

- **About 95 Lleida-province routes are "Servei a la demanda. Reserva prèvia al tlf. … amb 24 hores d'antelació"**, mostly 1-car operators: individual taxi or minibus owners such as Josep Colom Prió, Joan Bellera, Benito Espuñes, Laura Campi Giró. They are clustered around **Sort, Tremp, La Pobla de Segur, La Seu d'Urgell, Esterri d'Àneu, Llavorsí, Organyà, Solsona, Artesa de Segre, Seròs/Almatret, Torrebesses/Bovera** and run **2–15 trips a week**, with many at 2 a week (e.g. L0053 Baiasca–Sort, L0515 Montenartró–Sort, L0549 Ossera–La Seu, L0842 Espluga de Serra–Tremp).
- **Booking channels named in the data:** individual phone numbers; Generalitat TAD phone **900 106 848** (Seròs, Camarasa, Alamús, Cogul…); **app "TAD CAT"** (L0342 Gósol); **app "Cots Alsina clic.cat"** plus WhatsApp; **app "ALSA les Garrigues"** (L0184); "**Clic.cat**"-branded Garrigues lines L0732, L0857, L1871 (ALSA) and Terra Alta TA1–TA6 (L2170–L2175, HIFE).
- **Tarragona TAD:** Terra Alta Clic.cat TA1–TA6 (HIFE); L1520 Barberà de la Conca – Montblanc section on demand; L0580 Querol stop; L0407 Morera de Montsant; L0815 Vilanova de Prades; L0571 Porrera; L1055 urbanisations Alzineta / Can Gordei / La Miralba; L0267 Aiguaviva–Sant Jaume dels Domenys; L0630 Pau Casals stop; M1 Móra d'Ebre.
- **School-only (Esc):** Cots Alsina route names carry "(Esc)"; El Vendrell L1e–L5e; Reus L40–L44; Balaguer L2-L3; and stops "only on school days", e.g. Mollerussa IES La Serra on L0399 and L0972.
- **Odd ones:** L2157 "Tallers participatius del municipi de Vall de Cardós" (a workshop service, ~9 days a month); L0398 La Granadella–Reus ("if Friday is a holiday, runs the previous Thursday"); L1534 and L1027 run once a week.

### 1f. Interurban operators in the two provinces (from Gencat GTFS **[V]**)

| Operator (Gencat agency_id) | Group | Routes in T/L | Trips per week | Main area | RT |
|---|---|---|---|---|---|
| Teresa y José Plana — **Empresa Plana** (42634) | Plana | 77 | 6,541 | Camp de Tarragona, Costa Daurada, Port Aventura, ECT, Vila-seca/Cambrils urban, Priorat, Ebre (L0769), Cunit | **None public.** Only the "Plana Bus Escolar" school-tracking app (iOS id1561423289) **[R]** |
| **SA Alsina Graells de Auto Transportes** (42675) + ALS_720 in ATM | **ALSA** | 68 | 2,858 | All of Lleida province, Pyrenees, Aran, Lleida–Barcelona, Andorra, Tàrrega/Balaguer urban | ALSA's "localiza tu bus" exists for its own long-distance services **[R]**; no feed |
| **La Hispano de Fuente en Segures (HIFE)** (42725) + AMP/CAL/TRD/TTS/VAL in ATM | HIFE (Grup Hife) | 43 | 3,764 | Terres de l'Ebre, Terra Alta, Tarragona–Valls via Bràfim, Lleida–Salou, plus the urban networks of Tortosa, Amposta, Valls, Calafell and Torredembarra | None found **[K]** |
| **La Hispano Igualadina** (42672) | **Monbus** | 26 | 2,579 | Reus–Tarragona e4 (377 trips a week), Pratdip–Reus–Tarragona (937), Valls–Reus, Lleida–Tarragona, Reus Airport, Guissona–Cervera (502) | None public **[K]** |
| Cots Alsina (42660) | — | 19 | 702 | Segarra (Cervera/Guissona/Torà) | None |
| Autocars del Penedès (42569) | — | 17 | 1,243 | El Vendrell urban, Vilafranca–Vendrell–Tarragona–Port Aventura (579), e1 | None |
| Miguel Gamón (42714) + GAM | — | 8 | 840 | Segrià: e2 Lleida–Alfarràs, e3 Lleida–Alcarràs | None |
| Marfina Bus (42674) | Moventis / Sarbus | 4 | 263 | Lleida–Torres de Segre, El Cogul, L'Albagés | **Moventis ETA API** **[R]** |
| Cintoi Bus (42662) | Plana | 4 | 747 | Vendrell–Vilanova, Calafell–Barcelona (310) | None |
| Autocares Ízaro (45218) | — | 4 | 181 | Baix Penedès inland (Bisbal, Santa Oliva) | None |
| Transports Públics del Priorat i Domènech (42648) | — | 5 | 440 | Falset, Móra, La Figuera–Reus | None |
| Autocars Morell, Empresa Lax, Autocars Salvia, Autocars Agramunt, Autocars del Pla, Autocars Aler, Solé Seró, Vidao, 17 Bages Bus, Eix-Bus, Hispano Llacunense, Bus Castellví, Transportes Regina | — | 1–9 each | — | Local Lleida plain / Penedès links | None |
| ~40 one-vehicle licensees (personal names) | — | 1–4 each | 2–15 | Pyrenean TAD | None |

**Not found anywhere in the data:** **Vibasa** and **"Autocars Baix Penedès"** (these may not be public-service operators in these provinces); **"Autobuses de Lleida"** as an interurban operator (Autobusos de Lleida is urban, apart from the NL1/NL2 joint licence). Monbus appears only through La Hispano Igualadina. ALSA long-distance and state-licensed routes (e.g. Barcelona–Valencia via Tarragona, Avanza VAC-124 Huesca–Lleida–**Salou**) belong to the state's NAP feeds (ALSA 1133; Avanza 1713, expired 2024-06-30), not to Gencat.

---

## 2. Per-operator technical sections

### 2.1 EMT Tarragona

- **Static [V]:** NAP 1694 (MDB mdb-2777): 21 routes, 407 stops, `stop_id` 25000…, headsigns, colours, **no shapes**, `agency_url` `http://emtanemambtu.cat`, phone 902 365 114. The ATM copy (`TAR_` prefix) has the same 21 routes and 2,113 trips, also without shapes. Both calendars end **2026-12-31**.
- **Network change [R]:** a new network of 17 daytime lines comes in on **2026-12-22**. The timetables were due on 2026-12-01 and the maps are at `emtanemambtu.cat/about/nova-xarxa`. It keeps the three night lines and the summer line (Diari de Tarragona, Diari Més, diaricatalunya, apd.cat). **Treat every current EMT GTFS as expiring on 2026-12-21.** The fleet was raised to 87 buses with 10 hybrids in November 2026 **[R]**.
- **Real-time:** the official app "EMT Tarragona" (iOS id435718030; developer Technodac per technodac.com; renewed in 2025 with "temps d'espera", incidents and geolocated stops) and QR/BIDI codes at stops since 2011 **[R]**. The **backend endpoint was not identified.** `emtanemambtu.cat` and the app store were unreachable from this session, and no public reverse-engineering exists on GitHub. The only GitHub scraper found (ManelCast/M12…, PHP) reads static stop lists from `http://emtanemambtu.cat/about/detalldelineas/?linecode=N` (`div#tablatermometroIDA` / `VUELTA`) **[V: code read]**. There is no GTFS-RT, and **no `TAR_` entities in T-mobilitat open trip_updates** (checked 2026-11-23 in `docs/research/MOVENTIS_SOURCES.md`, which found only the AMB, TMB, FGC and ROD prefixes).
- **Next step:** in a session where `emtanemambtu.cat` is allowed, load a stop QR page (e.g. a URL printed on a stop) and record the XHR it makes. Ask EMT for GTFS-RT under the open-data request template in `docs/catalonia-review/DATA_REQUESTS.md`.

### 2.2 Reus Transport

- **Static [V]:** use **ATM `REU_`** (calendar 2026-10-09 → 2027-10-09; 19 routes; 184 stops; 475 trips; no shapes). **NAP 1788 is deprecated and expired on 2026-02-23**; MDB redirects it to mdb-3081, which is only the Flex feed.
- **Seasonal and event lines [V]:** L80 Fira Reus (2026-10-09…12 only), L81 Parc de Nadal and L82 Fira (serveis) (defined, but no trips loaded yet), L35 Tots Sants (defined, no trips).
- **Real-time:** app "Reus Transport Bus ONLINE" (iOS id384665389; Android "Reus Transport Bus" v3.45 per filehippo) gives arrivals at a stop **[R]**. **Backend unknown, and nothing on GitHub** (the `jsalvans/reustransport` repo is an interurban timetable search from 2017). Dynamic displays at the main stops **[R]**.
- **Bus x Tu (D1), demand-responsive [V]:** GTFS-Flex v2 produced by **Spare** (`feed_publisher_name` "Spare GTFS-Flex Editor", exported 2026-11-24T01:50Z). It has `location_groups`, `booking_rules` (booking_type 0 = real-time booking) and pickup windows 06:30–21:30, Mon–Fri. The public URL needs no key: `https://api.sparelabs.com/v1/gtfs/generate/organization/78112279-c065-4987-be69-bc18ab604142`. Vehicle location shows only to the person who booked, in the BusXtu app **[R]**.
- **Ganxeta bike share:** see table 1a. GBFS v3 is the cleanest real-time feed in either province.

### 2.3 Autobusos de Lleida (Moventis)

- **Static [V]:** NAP 1579 (mdb-2753): 14 routes, 250 stops, shapes, `calendar_dates` only (2026-11-19 → 2026-12-31), and a `frequencies.txt` that holds only a header. The ATM `LLE_` copy matches: 1,970 trips, 1,966 of them with shapes. **`stop_id` = Moventis `ID_PARADA`; `stop_code` = public `COD_PARADA` [V].**
- **Real-time [R]:** the Moventis website's own JSON, documented on **2026-10-03** by the open-source project `jtayped/moventis-lleida` (`docs/moventis-api.md`, read in full today):
  - Lines: `GET https://www.moventis.es/es/moventis/es/lines` (~3.6 MB; Lleida = `ID_ZONA` "2"; `ID_SUBZONA` 1 = urban, 3 = interurban Sarbus)
  - Routes and stops: `GET /api/json/GetTrayectos/{ID_LINEA}/{YYYYMMDD}`
  - Geometry: `GET /api/json/GetKMLs/{ID_LINEA}/{segment}` (KML served as text/html)
  - Timetable: `GET /api/json/GetParadas/{ID_LINEA}/{segment}/{YYYYMMDD}/{fromMinute};{segments}`
  - **Live:** `GET /api/json/GetTiemposParada/{es|ca}/{ID_PARADA}/{ID_LINEA}/{2nd line or 0}`. The answer is every line at the stop, each arrival `{minutos, real:"S"|"N", hora}`, looking about 1–2.5 h ahead. The official site polls every 10 s. Not every `real:"S"` entry is live: entries after the first few are countdowns to timetable times.
  - Alerts: `GET /es/moventis/es/incidencias`
  - Arribo! already calls the same API family for Empresa Casas (`app/moventis.go`, commit 85b586e). It respects `robots.txt` crawl-delay 10 s, and the site throttles silently by answering placeholder "A" values.
- **Legal [R]:** no licence for these endpoints. The official route is the Moventis developer form (`/es/como-conseguir-los-datos-gtfs-de-moventis`; weekly GTFS plus real-time to approved partners, as supplied to Google since 2017). La Paeria advertises QR arrival times at every stop (`http://www.paeria.es/buslleida/`).
- **Festive [R/V]:** N1 runs Saturday nights plus festes and the Aplec del Caragol (diaricatalunya). It has 2–4 dates a month in the GTFS. Line 70 Llívia–Cappont runs on specific dates. Aplec del Caragol night specials run 23:00–01:00 on the Wednesday and Saturday eves (Paeria security document, undated).

### 2.4 Generalitat interurban (all non-urban operators) and the two ATMs

- **Static [V]:** Gencat ZIP; mirror `https://storage.googleapis.com/mobilitydata-datasets-prod/mdb-2926/latest.zip` (same-day copy, 24 MB). Open licence (Llicència oberta d'ús d'informació – Catalunya). **Every route has shapes. `route_short_name` is the internal `L####` code; the public code (e1, N4, 310, 411…) sits in parentheses in `route_long_name`, e.g. "(e4) Tarragona - Reus".** `nota.txt` carries the booking and day rules. Note that `calendar.txt` rows often have every weekday flag at 0 and are driven by `calendar_dates` (1.1 MB).
- **ATM Camp de Tarragona** (atmcamptarragona.cat) and **ATM Àrea de Lleida** (atmlleida.cat) set integrated fares. ATM Lleida 2026: T-10 €5.50 for 1 zone, T-MES €22.10, T-16 free (per moventis-lleida `sources.md`) **[R]**. Neither publishes its own GTFS or real-time **[R]**. Their routes appear in the CGIM GTFS under `GEN_`, `TAR_`, `REU_`, `LLE_` etc. **The CGIM `networks.txt` names only `STI_Barcelona` [V]**, and the `fare_leg_rules` / `areas` were not examined for Camp de Tarragona or Lleida zones (gap).
- **T-mobilitat prefix table [V, from the feed]:** relevant prefixes are `TAR_EMT`, `REU_`, `LLE_5`, `AMP_1`, `CAL_1`, `CUN_1`, `TRD_1`, `TTS_1`, `VAL_1`, `MON_1`, `MOR_1`, `VHI_1`, `ALS_720`, `BLB_1`, `GAM_Gamón`, `LIO_131`, `GEN_<agency>`. (`TOR_`, `PIE_`, `CUB_` and `VFP_` are in Girona or Barcelona, not here.)
- **Real-time:** **none public** for any Tarragona or Lleida operator. T-mobilitat open trip_updates (`https://t-mobilitat.cat/opendata/trip_updates/json/user/token/open`) carried only AMB, TMB, FGC and ROD on 2026-11-23 (sibling research, not re-probed). `vehicle_positions` returns 404 there.

### 2.5 Third-party apps

- **Google Maps:** EMT Tarragona has been on Google Transit since 2011 (static) **[R]**. Moventis feeds Google **[R]**. Whether Google shows live times for any of these: **unverified**.
- **Moovit / Citymapper:** not checked (search budget exhausted).
- Third-party apps "Tarragona Bus" and "Bus Lleida" are recommended on ALSA station pages **[R]**. They are probably wrappers around the same operator backends.

---

## 3. Quirks for Arribo's model

1. **EMT Tarragona replaces its network on 2026-12-22.** Static feeds expire 2026-12-31 and will overlap wrongly for 10 days.
2. **Lines with event-only calendars:** Reus L80 (Fira, 4 days), L81 Parc de Nadal, L82, L35 Tots Sants (1 Nov). Lleida N1 and 70. Tarragona night lines 71–73 on Fri/Sat and eves of holidays.
3. **Seasonal coast:** Port Aventura lines change between winter (L0715, L1688) and summer (L1621, L1626, L1815, L1817) variants. Aeroport de Reus L1826 runs Mar–Oct only. Night SN lines run daily in Jul–Aug.
4. **Misleading names:** Tortosa "(agost)" variants run September–June. Cots Alsina route names embed departure times and "(Esc)". Gencat short names are internal (`L####`), with public codes in the long name.
5. **Multiple terminals and loops:** EMT 21 and 23 are loops from the Estació. Lleida line 1 is a loop (it starts and ends at stop 10242). Moventis `CIRCULAR:"S"` is **not** a loop flag (§2.3).
6. **Missing cumulative offsets:** EMT and Reus feeds have no `shapes.txt`. Lleida trips must be stitched across segments when built from the Moventis API.
7. **Very low frequency:** about 60 routes run 2–4 trips a week, and many need booking 24 h ahead, so they should be labelled "on demand" rather than shown as scheduled certainty.
8. **Cross-border:** Val d'Aran line 395 to Saint-Gaudens is in the French liO network, which has open GTFS-RT. Llívia (an exclave of Girona province) is reached by the Lleida–La Seu–Puigcerdà–Llívia ALSA lines.
9. **School-only:** Reus L40–L44, Balaguer L2-L3, El Vendrell L*e, and stops served only on school days. All need the school calendar, which the GTFS already encodes through `calendar_dates`.
10. **Festivals not in any GTFS:** Santa Tecla and Sant Magí (Tarragona); Misericòrdia and Sant Pere (Reus); Festa Major de Maig, Aplec del Caragol and Fira de Sant Miquel (Lleida). Specials are announced in press releases or PDFs only **[K]**.

---

## 4. Gaps and recommendations

| Gap | Why it matters | Next step |
|---|---|---|
| EMT Tarragona real-time backend unknown | Biggest urban network (~2,100 trips a week in ATM, 87 buses) | Allow `emtanemambtu.cat` and capture the XHR from a stop's QR page. Formal data request to EMT and the Ajuntament |
| Reus Transport real-time backend unknown | Second city | Allow `reustransport.cat` and inspect the web or the APK. Reus already publishes GBFS and Flex openly, so a formal request is likely to succeed |
| Moventis Lleida API not re-probed today | `moventis.es` blocked here | Arribo's existing `moventis.go` client should work for `ID_ZONA` 2 lines unchanged: join on `stop_id` = `ID_PARADA` |
| No real-time at all for Plana, HIFE, Monbus/Hispano Igualadina, ALSA regional, Cots Alsina or the TAD licensees | ~95 % of interurban trips in the two provinces | Ask the Generalitat (DG Transports) for SAE/SIRI output. Nothing public exists today |
| Municipal services outside every GTFS (possible: Mollerussa, La Seu d'Urgell, Salou circular from 2027, summer beach buses in L'Ametlla de Mar, Altafulla, Deltebre, La Ràpita, Miami Platja; Baqueira ski bus) | Completeness | Municipal websites (blocked here) and a follow-up web search once the budget allows |
| CGIM fare areas for ATM Camp de Tarragona and ATM Lleida not examined | Fares in the planner | Parse `areas.txt`, `stop_areas.txt`, `fare_leg_rules.txt` in mdb-2832 (already downloaded) |
| Not verified: liO line 395 in the GTFS-RT; Google/Moovit live coverage; licence of the EMT and Reus apps | — | Fetch the data.gouv RT feeds (blocked here) |
| Stale NAP feeds: Reus 1788 (expired), Cots Alsina 2009 (2025), Avanza 1713 (2024) | Wrong timetables if used | Prefer Gencat (G) and CGIM (A) |

**Recommended ingestion order (static):** (1) Gencat GTFS from the MDB mirror (open, daily, shapes); (2) the CGIM simplified feed for urban `TAR_`, `REU_`, `LLE_`, HIFE urban networks, `MON`, `VHI`, `MOR`, `CUN` and `ALS` urban (NAP 2059 with a free key, or the MDB mirror mdb-2832); (3) Reus Bus x Tu Flex (open). **Real-time today:** only Moventis Lleida (unofficial web API, polite rate limits, no licence) and Ganxeta GBFS (open) are usable. Both are labelled "stop predictions" or "dock status", never GPS.

---

## Sources

**Downloaded and analysed today [V]:**

- MobilityData bucket: `https://storage.googleapis.com/mobilitydata-datasets-prod/mdb-{2926,2796,2832,2777,2753,2803,3081,2805,2809}/latest.zip` and `…/feeds_v2.csv`
- [MobilityData catalogue entries](https://github.com/MobilityData/mobility-database-catalogs)
- [Transitland atlas](https://github.com/transitland/transitland-atlas)
- [INE municipalities CSV](https://github.com/codeforspain/ds-organizacion-administrativa)
- [jtayped/moventis-lleida docs](https://github.com/jtayped/moventis-lleida), `docs/moventis-api.md` and `docs/sources.md` (dated 2026-10-03)
- [pybikes Ganxeta](https://github.com/eskerda/pybikes/blob/master/pybikes/ganxeta.py)
- [MobilityData GBFS systems.csv](https://github.com/MobilityData/gbfs/blob/master/systems.csv)
- [ManelCast EMT scraper](https://github.com/ManelCast/M12_ManelCCyCarlosCG)
- Local: `/home/user/Arribo/docs/research/MOVENTIS_SOURCES.md` and the `app/moventis.go` history (commit 85b586e)

**Web-search snippets [R]:**

- [EMT Tarragona app (App Store)](https://apps.apple.com/es/app/emt-tarragona/id435718030)
- [Tarragona.cat: EMT actualitza la seva app](https://www.tarragona.cat/mobilitat/noticies/noticies-2025/lemt-actualitza-la-seva-app)
- [Tarragona Digital: EMT renova l'aplicació](https://tarragonadigital.com/societat/emt-tarragona-renova-aplicacio-mobil_2079874_102.html)
- [Technodac: EMT app](https://www.technodac.com/es/nuestros-trabajos-apps-nativas/1099-emt.html)
- [Diari de Tarragona: new network from 22 December](https://www.diaridetarragona.com/tarragona/275002/reordenacion-lineas-autobus-publicas-comenzara-22-diciembre.html)
- [diaricatalunya: 17 daytime lines](https://diaricatalunya.cat/en/tarragones/general/emt-tarragona-presents-new-bus-map-with-17-daytime-lines)
- [Diari Més: 87 buses](https://www.diarimes.com/ca/tarragona/261118/l-emt-tarragona-incorpora-deu-autobusos-hibrids-i-amplia-flota-municipal-fins-als-87-vehicles_243431.html)
- [Reus Transport Bus ONLINE (App Store)](https://apps.apple.com/us/app/id384665389)
- [Reus municipal apps](https://www.reus.cat/en/municipal-apps)
- [Diari de Tarragona: Bus x Tu stops](https://www.diaridetarragona.com/reus/199348/el-servei-de-bus-a-demanda-de-reus-bus-x-tu-amplia-parades-mc16366956.html)
- [diaricatalunya: Reus on-demand bus 2027](https://diaricatalunya.cat/en/baix-camp/general/reus-ampliara-el-bus-a-demanda-amb-quatre-nous-vehicles-electrics-el-2027)
- [Diari de Tarragona: Reus fleet](https://www.diaridetarragona.com/reus/269887/reus-augmenta-25-seva-flota-busos-amb-quatre-vehicles-hibrids.html)
- [Diari de Tarragona: Salou circular bus 2027](https://www.diaridetarragona.com/costa/272591/salou-preve-implantar-autobus-urbano-circular-2027.html)
- [Moventis Lleida service charter, October 2025](https://www.moventis.es/sites/moventis/files/imce/moventis_autobusos_lleida_carta_serveis_cat_102025_0.pdf)
- [diaricatalunya: Lleida N1](https://diaricatalunya.cat/en/segria/general/lleida-launches-n1-night-bus-line-to-connect-neighborhoods-and-nightlife-areas)
- [Paeria Aplec document](https://www.paeria.cat/arxius/noticies/Document_cat_17142.pdf)
- [Plana Bus Escolar (App Store)](https://apps.apple.com/us/app/-/id1561423289)
- [ALSA station Tarragona](https://www.alsa.com/it/stazioni/stazione-tarragona)
- [ALSA station Lleida](https://www.alsa.com/en/bus-stations/lleida-station)
- [Ganxeta app](https://apps.apple.com/app/id6448753388)
- [transit.land EMT Tarragona feed](https://www.transit.land/feeds/f-emt~tarragona)
