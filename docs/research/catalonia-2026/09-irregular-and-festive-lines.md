# I — Irregular, festive and structurally odd services across Catalonia

Research for Arribo! (journey planner + real-time). This is research only: no application code was changed.
Written 2026-11-24.

## 0. How to read this report

**Evidence labels**

- **[GTFS-verified]**: I counted or inspected it myself in a GTFS snapshot downloaded in this session (see §1 for each snapshot's date). This shows what the data published at that date. It does not prove what runs today.
- **[repo-verified]**: read from `/home/user/Arribo` source or data.
- **[reported]**: taken from web-search result snippets (press, operator pages). I could not open the pages themselves: WebFetch could not reach mataro.cat, tvmataro.cat, capgros, mitjamataro and others in this sandbox. Treat these as leads to confirm.
- **[inferred]**: my reading of the data, not stated anywhere.

**Coverage limits**

- The two canonical download URLs (territori.gencat.cat interurban GTFS, ambmobilitat.cat AMB GTFS) were **refused by the session egress proxy (HTTP 403)**. I used the **MobilityData (Mobility Database) mirrors** on `storage.googleapis.com/…/mdb-latest/…` instead (catalog ids 2926 and 892), plus the mirrors for Renfe Cercanías (2653), FGC (1856), TMB (2359) and Reus Transport GTFS-Flex (3081). The mirrors for ATM full/simplified, TMG Girona, EMT Tarragona, Autobusos de Lleida, TMESA and Avanza Mataró returned 404.
- The session's **web-search budget ran out** partway through. The topics I could not search are listed in §11.

Downloaded data sits in its own folder: `(research scratch files, not committed)` (`gencat/`, `amb/`, `renfe/`, `fgc/`, `tmb/`, `reus/`, `catalog/sources.csv`). The analysis scripts are in `…/scratchpad/I_scripts/`.

---

## 1. Data sources and how fresh the snapshots are

| Feed | Mirror snapshot (file mtime) | Service window inside the zip | Notes |
|---|---|---|---|
| Generalitat interurban bus (DGTM), MDB 2926 | 2026-03-17 | calendar_dates **2026-01-01 → 2026-06-30** only | 939 routes, 26,148 trips, 454 services, 24,117 calendar_dates rows (all `exception_type=1`). Every `calendar.txt` row has all seven weekday flags = 0, so service is defined *only* by calendar_dates. It adds a non-standard `calendar.name` column with a free-text Catalan description, plus `nota.txt` (3,044 trip-level footnotes) and a non-standard `stop_times.prohibition` column. |
| AMB bus, MDB 892 | 2026-06-03 | feed_info 2026-06-03 → 2026-06-08; calendar to 2028 | 137 routes, 29,844 trips. Uses calendar + calendar_dates (14,457 removals, 5,261 additions). `continuous_drop_off` is set at route level. |
| Renfe Cercanías (all Spain), MDB 2653 | 2026-06-03 | **2026-06-03 → 2026-07-02** | Every one of the 450 service_ids covers a single day (rolling 30-day window). Catalonia routes are `51T…`: 172 routes, 19,946 trips. Rail-replacement coaches appear as `route_type=3`. No calendar_dates. |
| FGC, MDB 1856 | 2026-05-22 | calendar_dates 2026-05-20 → 2026-12-31 | Includes Cremallera de Montserrat (MM), Núria (L1), Funicular de Vallvidrera (FV), and RL1/RL2 Lleida–La Pobla. |
| TMB, MDB 2359 | 2026-04-10 | 2026-04-10 → 2026-12-05 | Includes frequencies.txt (8 rows). |
| Reus Transport (Spare), MDB 3081 | 2026-06-04 | 2026-05-01 → 2027-05 | **GTFS-Flex**: booking_rules, location_groups. |

**Takeaway [GTFS-verified]:** none of these snapshots covers summer *and* winter *and* the Christmas period at once. The Generalitat zip contains 51 summer-only services with **0 dates and 0 trips**, for example "Diari juliol i agost" and "Festius. De l'1/07 al 31/08". Summer interurban service therefore simply does not exist in a January–June release. A planner must import every new release and keep the older ones for their own window. It must not assume one zip describes the year.

---

## 2. Headline counts from the GTFS

### 2.1 Generalitat interurban: `nota.txt` footnotes (3,044 trip notes, 347 route_ids, 323 distinct texts) [GTFS-verified]

| Category (regex over the note text) | Trips | Route_ids | Most common texts |
|---|---|---|---|
| Demand-responsive ("demanda", "reserva", TAD CAT, Nemi, Sagalés on Demand, clic.cat) | **1,691** | **224** | "Parades a la demanda: Les Ginesteres i Veïnat de Madà. Reserva prèvia al tlf. 900130014… o app Sagalés on Demand" (221); "Servei a la demanda… app TAD CAT" (167); "…Cots Alsina clic.cat… WhatsApp" (82) |
| Barcelona local holidays | 280 | 17 | "Excepte festes locals a Barcelona" (177); "I festes locals a Barcelona" (73) |
| School / university calendar | ~361 | 44 | "Dies lectius de la UAB" (115); trips with seats reserved for school transport ("reserva de places per a transport escolar", 20+12+…) |
| PortAventura opening days and closing hour | ~150 | 16 | "Dies d'obertura de Port Aventura fins a les 24:00h / 23 / 22 / 21 / 20 / 19 / 18" |
| Market day (route or stop changes) | 99 | 10 | "El dilluns, dia de mercat, recorregut alternatiu per ctra. Barcelona" (LB1 Barberà, 42); "Els dijous… (dies de mercat) no para a c. Mercè (CAP)" (C18 Premià); "Dimecres de mercat no fa parada a…" (Cambrils L1/L2) |
| Festive nights not in the calendar | 72 + 22 | 11 + 6 | "I nits de la Revetlla de Sant Joan, la de Cap d'Any i la de la Festivitat de la Mercè" on N61, N64, N30, N67, N73, N81 and others |
| Placeholder "." | 127 | 1 | route 1624, meaningless |

### 2.2 Generalitat interurban: `calendar.name` themes [GTFS-verified]

| Theme | Services | Trips | Routes |
|---|---|---|---|
| Names containing a summer window (Jul/Aug/15-06/23-06…) | 201 | 11,530 | 390 |
| School/university ("lectius", "escolar", "universitari") | 50 | 1,677 | 244 |
| Tied to Setmana Santa / Nadal / Rams / Pasqua | 47 | 499 | 36 |
| Barcelona local holidays | 5 | 374 | 7 |
| Night ("Nits …") | 9 | 253 | 18 |
| Ski season ("temporada d'esquí", "Bus de la neu") | 7 | 20 | 8 |
| Single-date festivities, e.g. "Circula el 22 de gener (Festa Major de Prats de Lluçanès)" (svc 185886, 1 date) and "Dissabte abans del diumenge de Rams" | several | — | — |

### 2.3 Structure [GTFS-verified]

| Metric | Gencat interurban | AMB |
|---|---|---|
| Trips whose first stop = last stop (loops) | 1,408 trips on 101 routes | 885 trips on 11 routes |
| Route+direction pairs with more than one origin/destination pair (branches or short-turns) | **693 of 1,743** | 41 of 255 |
| Trips with fewer than 60% of the stops of the longest trip in their route-direction | **3,222** | 39 |

The interurban network is far more irregular than AMB. Roughly 40% of route-directions have more than one terminus pattern.

---

## 3. Festivity-only and festival-modified services

The columns used for each entry: where / operator / dates / how it is published / real-time coverage / modelling recommendation.

### 3.1 Les Santes, Mataró (late July; local holiday 27 July 2026)

- **Holiday status [repo-verified]:** `src/data/holidays.json` lists `2026-07-27 "Festa major de Les Santes"` and `2026-05-25 "Fira a Mataró"` as Mataró local holidays. On those dates the app's `resolveDayType` returns the `sunday` grid, and a holiday wins over the summer window.
- **Bus Focs, the fireworks-night service [reported, 2025 edition]:** an extraordinary Mataró Bus service on the night of the Castell de Focs, 22:00–02:00, one bus every 15 minutes, on three special lines that do not otherwise exist:
  - **Línia 10** Cirera – Sant Simó
  - **Línia 11** Galícia – Ronda Barceló
  - **Línia 12** Plaça de França – Ronda Barceló

  The 2026 fireworks were reported for **Monday 27 July 2026 at 23:00**. The council's 2026 disruption notice (dated 15 July 2026) lists "Castell de Focs, dilluns 27, de 22 h a 1 h, Av. del Maresme". lessantes.cat mentions a special bus that night but the snippet gave no line details. Whether lines 10, 11 and 12 ran again in 2026 is **unconfirmed**.
- **Diversions [reported]:** every year the Ajuntament publishes "Afectacions de Mataró Bus, busos interurbans, parades de taxis i aparcaments durant Les Santes". It covers the Desvetllament, Ruixada, Nit Boja (25 July in 2025) and Focs nights, with diverted L1–L8 and interurban lines and relocated stops. The notice is published as an HTML page or PDF. **There is no GTFS for it** (Mataró's own Avanza GTFS mirror 2768 returned 404).
- **Interurban night buses [reported 2025]:** during the festival nights the N80 and N82 run until 04:00.
- **Night lines in GTFS [GTFS-verified]:** L0109 N80 Barcelona–Mataró runs "Diari" (6 trips). L1819 N83 Mataró–Malgrat runs only "Nits de divendres i dissabtes de l'1/06 al 30/09" (8 dates in the Jan–Jun window). L0115 N82 has separate summer and winter patterns. **Nothing in the Generalitat GTFS marks Les Santes extensions**, and the Jan–Jun 2026 snapshot does not cover July anyway.
- **Real-time:** the Mataró Bus SIRI feed the app consumes would show Bus Focs vehicles only if the operator publishes them under some line code. The repo has schedules for lines 1–8 only, so an unknown line "10/11/12" vehicle would not match any timetable [inferred].
- **Recommendation:** model each special line as a **separate dated route with its own shapes and stops**, active only on that night, with label "servei especial Les Santes". Model diversions as **dated stop closures/relocations for each line and time window** (an "overlay" layer), not as edits to the base timetable. Accept unknown SIRI line codes as "special service" vehicles rather than dropping them.

### 3.2 La Mercè (Barcelona, around 24 September)

- **Metro all night [reported]:** 2023 ran 91 hours continuously. 2024 ran all night Fri 20, Sat 21 and Mon 23 September. 2025 ran all night on three nights (Tue, Fri, Sat) during the 23–28 September festivities, with extra trains on L1 and L3 for the Sunday piromusical. The council's Mercè 2026 page has a "Metro tota la nit" section; I could not read its dates.
- **Interurban night buses [GTFS-verified]:** the note "I nits de la Revetlla de Sant Joan, la de Cap d'Any i la de la Festivitat de la Mercè" is attached to 72 trips on 11 night routes (N61, N64, N30, N67, N73, N81…). Their service is "Nits de divendres i dissabtes", which does **not** include those weekday nights. A GTFS-only planner would therefore **miss** these trips on a weekday Mercè or Sant Joan night. Those festive nights exist only in the footnote.
- **Barcelona local holidays inside other feeds [GTFS-verified]:** the e9 Barcelona–Caldes footnote says "excepte Segon Dilluns de Pasqua i 24/09". Its service 185380 nevertheless **includes 2026-05-25** (Segona Pasqua). The note and the calendar contradict each other. Separately, services 187002/187004 ("Festius locals de Barcelona") correctly hold 2026-05-25. 24/09 falls outside the snapshot window.
- **TMB GTFS (April snapshot) [GTFS-verified]:** the last L1 departure on 2026-09-23/24 is 24:44, the ordinary weekday close. All-night running is not encoded.
- **Recommendation:** keep a **festive-night calendar** (Revetlla, Cap d'Any, Mercè nights, local holiday eves) as named dates, and let operators' services opt into it. Parse known footnote patterns such as "I nits de …", "Excepte festes locals a Barcelona" and "excepte … 24/09" into extra or removed dates, and show the original note to the user. For metro all-nighters, synthesise "continuous service" by extending the last-night frequency until it meets the first morning run, clearly labelled as published by press release.

### 3.3 Revetlla de Sant Joan (night of 23→24 June)

- **[reported, 2026 plan]:** metro continuous from 05:00 Tuesday 23 June to midnight Wednesday 24, with 14–18 extra L4 trains overnight. TRAM all night except T6. Rodalies reinforced towards the coast, about every 30 minutes; in a previous year there were two extra R1 trains from L'Hospitalet to Mataró at 23:09 and 23:57, all stops. FGC ran until 02:00 and restarted at 05:00. NitBus and Generalitat night buses ran all night with reinforcements.
- **AMB GTFS does encode it [GTFS-verified]:** N1's Friday-night service 217.2252.29 is *added* on 20260402, 0405, 0430, **0623**, 0814, 0910, 1011, 1031… (eves of holidays). The ordinary weekday-night service has those same dates *removed*. This is the model to copy: holiday eves become "Friday-like nights" through calendar_dates.
- **Gencat GTFS [GTFS-verified]:** night services do *not* include 20260623 (see §3.2). TMB GTFS: 23 June is an ordinary weekday (L1 last departure 24:44).
- **Recommendation:** treat a holiday eve as a day type ("vigília de festiu"). Where a feed lacks it, apply operator-specific rules: AMB already includes it, gencat night lines need it injected from the footnote, and TMB metro needs an all-night overlay announced by press release.

### 3.4 Cap d'Any (31 Dec → 1 Jan)

- **[reported]:** TMB's standing pattern is about 43 hours of continuous metro (05:00 on 31 Dec to midnight on 1 Jan), with TRAM all night. Buses: last departures at 22:00 on 24 Dec. Some gencat services have "Circula el 25 i el 26 desembre i l'1 de gener" (svc 185359) or "Circula el 25/12 i 1/1" (svc 185632) [GTFS-verified], and others are "No circula el 25/12 ni el 1/01" (16 trip notes).
- **TMB GTFS ends 2026-12-05 [GTFS-verified]:** 31 Dec has no service at all in that snapshot.
- **Recommendation:** never extrapolate a feed past `feed_end_date`. Show "horari no publicat" instead of "no service".

### 3.5 Other named festivals (mostly [reported], no GTFS)

| Event | Where / operator | Dates | What changes | Published as |
|---|---|---|---|---|
| Fires de Sant Narcís | Girona, TMG | about 24 Oct – 2 Nov (2025) | **Night bus "Bus Nit Fires"** and extra daytime urban buses, procured by tender (TMG expedient 27/2025, documents "Pcap Servei Bus Nit Fires") | tender documents and press; no GTFS seen (TMG mirror 404) |
| Santa Tecla | Tarragona, EMT | about 15–24 Sep | EMT has 3 standing night lines (12, 13, 91: Thu/Fri/Sat and eves) with summer reinforcement. Special night buses for the Concurs de Focs (early July). **[GTFS-verified]** interurban L0808 note: "Setmana focs a Tarragona, no para Balcó-Sta. Tecla ni Tuset-Llevant", a stop skip during the fireworks week | press; one gencat footnote |
| Patum de Berga | Berguedà, Consell Comarcal | Corpus week (Wed/Thu/Sat nights) | Special coaches from comarca villages to Berga on 3–4 nights, return next morning, €4 return with prior ticket purchase | press, Consell Comarcal; ticketed, not GTFS |
| Aplec del Caragol | Lleida (Camps Elisis) | May weekend | **Free night bus 03:00–08:00** (2025) | Paeria press |
| Cremada del Dimoni / Festes de Maig | Badalona, TMB | night of 10 May | L2 reinforced (+25% Friday evening, +14% Saturday) | TMB press |
| Carnaval de Sitges | R2 Sud, Rodalies | Feb (2026: 12–18 Feb) | Historically ~38 extra double-unit trains with 01:29 departures from Sitges on the big nights. In 2025 the reinforcement was cancelled because of a labour dispute | Rodalies notices |
| Festival de Cinema de Sitges | R2 Sud | October | "trens especials per tornar" | press |
| Prats de Lluçanès Festa Major | gencat line (472 493) | 22 January | **One-date service** [GTFS-verified] svc 185886 | GTFS calendar |
| Tots Sants (1 Nov) | Barcelona TMB | 1 Nov | Reinforced lines 21, 102, 104, 107 (107 runs *inside* Montjuïc cemetery), plus a Plaça d'Espanya ↔ Montjuïc cemetery shuttle. Rubí ran a free cemetery shuttle bus; Granollers doubled its cemetery service. **[GTFS-verified]** FGC Cremallera de Montserrat special services 26 Oct–1 Nov | press; FGC GTFS |
| Christmas / 24 & 31 Dec | many urban networks | 24/31 Dec | Early finish (TMB last bus 22:00 on 24 Dec; Manresa L8 last 22:05). gencat services such as "Dissabte anterior a Nadal" (svc 185069) | press; some GTFS |
| Barcelona local holidays (Segona Pasqua, 24 Sep) | gencat express lines e5, e6, e9, e14, e15.1, e24… | 2 days a year | "Excepte festes locals a Barcelona" / "Festius locals de Barcelona" services [GTFS-verified] | GTFS + footnotes |

Not researched because the search budget ran out (generic advice applies): La Mercè Nitbus specifics, Festa Major de Gràcia/Sants and Sant Medir bus diversions, Temps de Flors, Fira de Sant Ermengol (Seu d'Urgell), Misericòrdia / Sant Pere (Reus), Sabadell/Terrassa festes majors, Carnaval de Vilanova, Corpus, Sant Antoni, election day, Sónar, Cruïlla, MWC/Fira Gran Via shuttles.

### 3.6 Events and venue-driven services

| Service | Evidence | Modelling |
|---|---|---|
| **PortAventura** (Teresa y José Plana lines L0410, L0411, L0713, L0715, L1621, L1688 "(hivern)", L1842; Hispano Igualadina L0595 "Parada a Port Aventura de l'1 al 31 d'agost"; R17/RT2 terminate at Salou-Port Aventura) | **[GTFS-verified]** ~150 annotated trips. Trips are conditional on **park opening days and the park's closing hour** ("Dies d'obertura… fins a les 24:00h / 23 / 22 / 21 / 20 / 19 / 18"; "Dies tancament P. Aventura a les 19:00h"; "Exped amb sortida Tgna igual hora o posterior a la de tancament del Parc, no paren a P.A-Visitants"). Winter has a separate route L1688 with svc "Dies obertura Parc del 26/10 a l'1/05 excepte S.Santa" (83 dates) | Needs an **external venue-calendar input** (park opening days plus closing hour per date). Each trip carries a predicate such as `closing_hour >= 22`. Without that input, label these trips "depèn de l'horari del parc". |
| **Tibidabo amusement park** | **[GTFS-verified]** L0242 (A6) Barcelona–Sant Cugat via Rabassada: "Dies d'obertura del Parc d'Atraccions del Tibidabo" vs "Dies que el Parc… està tancat" (complementary trips) | Same venue-calendar predicate |
| **La Roca Village** | **[GTFS-verified]** L1280 (L51) and L1546: "només els dies d'obertura del centre comercial" | Venue calendar |
| **Fundació Estela stop** | L0721: "Parada a Fund. Estela només dies obertura del centre" | Stop-level predicate |
| **Gelida Bus Funicular** | **[GTFS-verified]** L1567 "Circularà quan el funicular no estigui en servei" (16 trips encoded on every weekday) | Mark as **contingent replacement**: do not plan on it unless an alert says the funicular is down. Otherwise you get duplicate or phantom options. |
| **F1 / MotoGP, Circuit de Barcelona-Catalunya** | [reported] Sagalés shuttle from Barcelona (3-day pass ~€45; drop-off ~300 m from the gate), coast service from Lloret; F1 2026 on 12–14 June. Rail via R2/R8 Montmeló/Granollers | Ticketed private shuttle; at most list it as "event shuttle (cal bitllet)". Rail reinforcements arrive only as a Rodalies PDF. |
| **Spotify Camp Nou** | [reported] new TMB **perimeter bus** on match days, running from 2 h before kick-off to 1 h 30 after the end (Aug 2026); phased capacity (45,000 first phase) | Dated route keyed to the fixture list |
| **Primavera Sound (Fòrum)** | [reported] 3–7 June 2026; past editions had extra L4 trains plus two night shuttle buses Fòrum ↔ Pl. Catalunya | Press only; dated route |
| **Afterlife festival and similar** | [reported] Sagalés "we take you to…" event coaches | Ticketed |
| **Campus UAB** | **[GTFS-verified]** "Dies lectius de la UAB" (115 trips, 7 routes); services "Lectius universitaris", "Diumenges del Calendari universitari", "Divendres de classe del curs universitari", "Dilluns lectiu o primer dia de classe setmanal" (Olot–UAB) | A university calendar distinct from the school calendar |

---

## 4. Seasonal patterns

### 4.1 Summer and beach

- **AMB [GTFS-verified]:** PR3 "Est. Rodalies–Platja" (Castelldefels/El Prat) runs Sat/Sun only with a summer window (210 added and 257 removed dates). PR5 "Les Moreres–Platja" has 71 summer-weekend added dates. **VB4 "Centre–Platja"** (Viladecans) is valid only 2026-06-01 → 2026-09-13. CV1 (Cerdanyola) has an end-of-June school-holiday variant and an August variant.
- **Gencat [GTFS-verified]:** "Reus – Salou poble i platja" (separate winter weekend service 184847), "Lleida – Salou – Platja de la Pineda" ("Diari del divendres anterior a Setmana Santa al dilluns de Pasqua i del 14/06 al 7/09"), "Sant Feliu – Platja d'Aro – s'Agaró", "Palafrugell – Calella – Llafranc", "Palafrugell – Tamariu", "Barcelona–Costa Brava" (Fri–Mon in spring/autumn), Girona Airport–Maresme–Mataró (a dense seasonal matrix of 11 services such as "Diari. del 2/05 al 27/10" and "Divendres del 29 d'octubre al 30 de març"), summer night lines N82/N83 (1 Jun – 30 Sep), and "(C21) Sant Vicenç de Montalt–Caldes d'Estrac (TAD)" with summer Sunday whole-day demand-responsive service.
- **Mataró urban [repo-verified]:** a single summer window, `2026-07-27 → 2026-08-23` weekdays only, sourced from operator notice 1505 "HORARIS ESTIU 2026" (`app/calendar.go: summerWindows`). Weekend grids are identical in both seasons. Summer cuts weekday trips sharply on some lines: L4 26→13, L6 64→38, L7 51→36, L8 43→28. In 2025 the summer timetable ran 28 Jul → 22 Aug and Lines 1, 2 and 3 kept reinforced service [reported]. The app also learns season windows at run time from operator notices (`registerSeasonWindow`, regex on "estiu"/"hivern" in `app/tracker_avisos.go`).
- **TMB:** buses adapt to "hàbits diferenciats de temporada de calor" (summer bus timetables) [reported]. **FGC [GTFS-verified]:** separate August weekday variants on L6/L7/L12/S1/S2/FV (services with 2–9 dates such as 0803–0806 and 0824–0827), and RL1/RL2 Saturday trips 4 Jul – 8 Aug.

### 4.2 Ski (winter)

**[GTFS-verified]** gencat routes:

- L0876 Vilaller–el Pont de Suert–Taüll (pistes d'esquí), with services "dissabtes, diumenges, festius i vacances escolars temporada d'esquí" and "feiners servei extraordinari **Bus de la neu**"
- L1918 La Guingueta d'Àneu–Cap del Port la Peulla
- L1880 Llavorsí–Pleta del Prat
- Sort–Port Ainé ("De dilluns a divendres temporada d'esquí", 71 dates)
- Sort–Espot
- Girona–Vallter 2000
- Lleida–Port Ainé ("…temporada d'esquí excepte Nadal i Cap d'any")
- La Seu d'Urgell–Sant Joan de l'Erm ("Diumenges i festius temporada d'esquí i diari durant vacances escolars de Nadal", 120 dates)

**[reported]** Cerdanya "Bus Blanc 2025-26": from 6 Dec 2025, €2, weekends plus school holidays except Christmas Day, "condicionat a l'obertura de les estacions", serving Puigcerdà, Llívia, Alp, La Molina, Masella. ALSA Bus de Neu Sort–Espot needs prior booking.

**Key issue:** the season is **conditional on snow and resort opening**. The GTFS can only encode an assumed date range.

**Recommendation:** treat this as a venue-calendar predicate (resort open), plus a "temporada d'esquí" named calendar refreshed from resort status.

### 4.3 Winter-only and other half-year splits

- [GTFS-verified] "Cambrils–Salou–Port Aventura (hivern)" is a separate route, not a service variant.
- Many gencat lines switch on **1 May / 1 Nov** ("Dissabtes i festius del 2/11 al 30/04" vs "de l'1/05 a l'1/11", e.g. La Granadella–Tarragona–Barcelona) or on **Palm Sunday / 31 Oct** (Tarragona–Salou–Cambrils per La Pineda has 6 service variants keyed to "diumenge de Rams").
- Recommendation: support movable-feast anchors (Easter, Palm Sunday, Holy Thursday, Good Friday, Easter Monday, Segona Pasqua) in the calendar engine. Several gencat services are defined relative to them.

---

## 5. Calendar-type oddities (operating-day logic GTFS cannot express directly)

| Pattern | Example [GTFS-verified] | Recommendation |
|---|---|---|
| **School days ("lectius") vs school holidays** | 50 services / 1,677 trips. E.g. "Dilluns i dimarts lectius", "Lectius excepte divendres", "De dilluns a divendres feiners no lectius". Notes such as "També circula els festius escolars en període lectiu" and "La parada Mollerussa (IES La Serra) només es farà els dies lectius" | Maintain the official Catalan school calendar (and the UAB/university calendar) as named calendars. Validate feed dates against them (see §9.2). |
| **Market days** | LB1 Barberà: alternative route on Monday (market). C18 Premià: no stop at c. Mercè on Thursdays 7–16 h. Cambrils L1/L2: Wednesday stops skipped. Olot, l'Arboç, Sant Celoni, Mollet, la Múnia "dia de mercat" trips | **Stop- and shape-level variants keyed to weekday plus time window.** Gencat encodes these only in notes, with the same stop_times every day. |
| **Odd/even days** | L0859 Juncosa–les Borges Blanques: "Dies parells" / "Dies imparells", both trips on the same service (120 dates) | Date-parity predicate; without it the planner shows both trips every day. |
| **"If Monday is a holiday it runs Tuesday" / "If Friday is a holiday it runs the previous Thursday"** | Gencat footnotes | Rule-based date shifting. |
| **First Monday of the month** | Svc 184887 "Primer dilluns de cada mes" (dates 0105, 0202, 0302, 0406, 0504, 0601) | Handled correctly by calendar_dates. **Note:** 0406 is Easter Monday, a public holiday, yet it is included. |
| **First Sunday of the month (FGC)** | L6/L7/L12/S1/S2 service on 20260607, 0906, 1004, 1101, 1206 | Reason unknown [inferred: monthly event or works]. Trust the dates. |
| **One-off FGC days** | R50/R60/S9 trips only on 2026-05-26; L8/R5/R6/S3/S4/S8 variants on 23, 24 and 26 May | Likely works or special events: show only on those dates. |
| **Vigílies (eves of holidays)** | AMB N1 (see §3.3); gencat "Nits de divendres, dissabtes i vigílies de festiu" (N4 Salou, N2 Reus, N5 Valls, Girona–Palamós nocturn) | Day type "eve" derived from the holiday calendar. |
| **Contingent / conditional** | Gelida funicular replacement; "Aquesta expedició només entrarà a l'Aeroport si hi ha viatgers" (Eix Bus Girona–Lleida); "No es podrà fer ús d'aquest servei si no s'ha concertat prèviament" | Flag the trip as conditional, never as guaranteed. |

---

## 6. Structural oddities

### 6.1 Branches, short-turns, alternating termini

- **[GTFS-verified]:** 693 of 1,743 gencat route-directions have more than one origin/destination pair, and 3,222 trips have fewer than 60% of their route-direction's maximum stop count. Examples: "Expedició amb destinació Barcelona / Mollerussa / Balaguer" on L0056 Balaguer–Tàrrega; "Prové de Guimerà (L0183)" and "L'agost prové de Guimerà" on e5 (interlined continuation from another concession); "Enllaça amb el servei Lleida–la Seu d'Urgell i continua fins a la Farga de Moles"; "Tràfic conjunt amb concessió Tivissa–Reus (V-1003)".
- **Express variants sharing a corridor:** "Expedició que forma part del Bus Exprés e6 / e5 / e2 / e1". Individual trips of a conventional route are marketed under an express code. A planner should show the express brand on those trips (trip-level `route_short_name` override) and not invent a separate route.
- **Rodalies [GTFS-verified]:** R1 has 10 origin/destination/stop-count patterns (L'Hospitalet ↔ Mataró 15 stops; Blanes 25; Maçanet 27; Calella 21; Arenys 18). R2S has the **same termini with 17, 13 and 14 stops**, i.e. semi-fast trains that skip stations under the same line code. R11 Portbou trips come with 27, 29 or 12 stops. R16 has degenerate 1-stop "Ulldecona→Ulldecona" trips (26), a data artefact.
- **Recommendation:** never derive "line → stop list" from the longest pattern. Index stops per trip, give every trip its own headsign/terminus, and show "no para a X" for skip-stop trips.

### 6.2 Line codes that change during a journey (through-running)

- **R4 → RL4 [GTFS-verified]:** 282 blocks / train numbers appear on both R4 and RL4 the same day. One train runs Terrassa/Manresa as R4, then continues to Lleida as RL4. The RL4 patterns include "Rajadell → Lleida" (15 stops) and "Lleida → Manresa", which shows the split point.
- **The R2 family:** R2 trips run Vilanova i la Geltrú → Maçanet-Massanes (27 stops), crossing both the R2S and R2N sections. R2N trips run Portbou → Maçanet (44 trips), i.e. an R11 or RG1 territory segment carried under the R2N code. R2N also has an El Prat Aeroport ↔ Estació de França pattern. [reported] R2 Nord ends at the airport and R2 Sud at Estació de França, and both share the saturated Aragó tunnel (Passeig de Gràcia).
- **Gencat interlining:** "Prové de Guissona; veure L0361", "Prové de Guimerà (L0183)".
- **Recommendation:** use `block_id` (Renfe fills it in) to offer "stay on board" transfers with 0-minute connections, and show the line code change ("continua com RL4"). Do not count it as a transfer in the ranking.

### 6.3 Loops and asymmetric directions

- **[GTFS-verified]:** 1,408 loop trips on 101 gencat routes, 885 on 11 AMB routes. AMB SF2 "Circular" and gencat circuits ("Girona–Llagostera–Palamós–la Bisbal–Girona (circuït)"; "(N61)/(N64) Barcelona–Terrassa–Sabadell–Barcelona", a night loop in opposite senses).
- **Mataró [repo-verified]:** L1 and L2 are both "Circular" with very asymmetric directions (L1: Rodalies→Hospital 24 stops vs Hospital→Rodalies 15; L2 the reverse pair). L8 direction 12 "Rodalies – Galícia" has 25 stops vs 13 the other way. L6 and L8 are Sunday **afternoon-only** (`afternoonOnly.sunday=true`).
- **Recommendation:** for loops, allow a journey that boards near the end of one run and continues into the next run of the same block. Label loop direction by the next timing point rather than a fixed "direction 0/1". AMB's CV1 has 4 headsigns in one direction ("Montero-Flor M.", "M. Montero", "Flor de Maig", "Can Coll"), so headsigns change along the loop.

### 6.4 Night networks routed differently from day lines

- **[GTFS-verified]:** gencat "(SN)" lines (29 routes) such as N30 Barcelona–Vilanova–Vilafranca, which has five night services split by season and weekday ("Nits de diumenge a dijous de l'1/10 al 31/05", "Nits de divendres i dissabte de l'1/10 al 31/05", "…de l'1/06 al 30/09"). Night trips run past 24:00 on the previous service day. In gencat, trip 1580876 starts at 03:00:29 under the Friday–Saturday-nights service.
- **AMB [GTFS-verified]:** all 17 AMB N-lines (N1–N3, N6, N8, N9, N11–N20, N23) carry route-level `continuous_drop_off=3` ("coordinate with driver"), i.e. **drop-off on request between stops at night**. Every day line has `1`.
- **Recommendation:** never reuse day-line stop sequences for N-lines. Honour `continuous_drop_off` by showing "pots demanar baixar entre parades" on night legs. Handle service days past midnight in Europe/Madrid (the repo's time engine already does).

### 6.5 Demand-responsive transport (DRT / TAD / "a la demanda")

- **Gencat [GTFS-verified]:** 1,691 trips on 224 route_ids carry a DRT footnote, and 72 route names contain TAD/demanda/Clic. The GTFS itself treats them as **fixed-schedule trips**: `stop_times.pickup_type` is 0 in all 412,847 rows and `drop_off_type` is empty everywhere. The flex columns `start/end_pickup_drop_off_window` and `location_group_id` are present in the header but **empty in every row**. Booking information appears only in free text, for example:
  - phone numbers with 24 h, "before 12:00 the day before" or "before 17:00" deadlines
  - apps: TAD CAT, Nemi (clic.cat Gironès / Garrotxa / Pla de l'Estany, 15-minute margin), Sagalés on Demand, Cots Alsina clic.cat, ALSA les Garrigues
  - **partial DRT**: "Parades a la demanda: Querol" (only some stops), "Expedicions a la demanda: 1a sortida de Porrera a Torroja i última en sentit invers" (only some trips), "Els dies lectius l'expedició de les 07:45 sense necessitat de reserva prèvia" (fixed on school days, DRT otherwise)
- **Reus "Bus X Tu" D1 [GTFS-verified]:** proper **GTFS-Flex** published by Spare. Three routes ("D1 – Bus X Tu (direcció centre)", "(direcció barris)", "D1 – Cementiri"); location_groups such as "El Pinar, Urb. Sant Joan", "Passeig Nord – Mineta", "Cementiri, Av. Sant Jordi"; windows 06:30–21:30 (the cemetery route 10:00–13:00), Mon–Fri; booking_type 0 (real-time booking); travel-time model `mean_duration_factor 1.3`, `offset 1200 s`.
- **Recommendation:** model three tiers: (a) fixed trip, (b) fixed trip with **on-request stops**, (c) zonal flex. Parse gencat notes into `pickup_type=2` (phone agency) on the named stops or trips, and attach the booking deadline, phone or app as structured fields. Ingest GTFS-Flex where it exists (Reus). Exclude DRT legs from "catchable" real-time departures unless booked, and **never** present a DRT trip as a guaranteed departure.

### 6.6 Stops served only in one direction, or for boarding/alighting only

- The gencat feed has a **non-standard `stop_times.prohibition` column**. Value counts: 3 → 297,124 rows; 0 → 86,387; 4 → 23,333; 5 → 4,400; 6 → 1,469; 7/8/9 → a few. Common per-trip patterns are "0 0 0 … 3 3 3" and "3 3 3 … 0 0 0".
- [inferred] It encodes concession **traffic prohibitions**: groups of stops between which carrying passengers is forbidden, typically inside Barcelona or inside another urban concession's area, the classic Spanish "tráfico prohibido". It is undocumented, and `pickup_type`/`drop_off_type` do not reflect it.
- **Recommendation:** do not ignore it. Until it is documented, treat consecutive stops sharing the same non-zero prohibition group as "no local travel between them" (equivalent to pickup-only at origin-side stops and drop-off-only at destination-side stops), and confirm the semantics with DGTM before relying on it. AMB has no such column.

### 6.7 Llançadores (shuttles)

- **[GTFS-verified]:** 5 gencat route names contain "Llançadora", for example L1728 "Llançadora Hospital de Tortosa Verge de la Cinta" and "(M6A) Viladecavalls – Terrassa (llançadora)". Lles–Aransa summer shuttle [reported, FEEC PDF].
- Treat them as ordinary routes. Many are seasonal or school-day only.

### 6.8 Rail-replacement buses and Rodalies disruption, 2025–2026

- **Renfe GTFS [GTFS-verified]:** replacement coaches are published **inside the Rodalies GTFS as `route_type=3` under the same line code**:
  - R3 buses Barcelona Fabra i Puig ↔ Granollers-Canovelles (6 stops), ↔ Vic (**2 stops, direct**), ↔ Centelles (2 or 7 stops: direct and stopping variants), ↔ La Garriga. About 5,000 trips in the 3 Jun – 2 Jul 2026 window, ending 20 June.
  - R15 coach Sant Vicenç de Calders ↔ El Prat de Llobregat (2 stops, 264 trips, until 14 June).
- **[reported]:**
  - The **R3 16-month closure**: phase 1 Montcada Bifurcació–La Garriga until May 2026; phase 2 Mollet Santa Rosa–La Garriga until about January 2027, with buses covering the gap.
  - **R7** cut from 2 Nov until May 2026, with a Cerdanyola del Vallès ↔ Cerdanyola Universitat bus every 30 minutes on weekdays and every 60 minutes at weekends.
  - **RL4** Terrassa–Cervera weekend closures (July 2026).
  - **R2 Sud Garraf** works from mid-March 2026, with Barcelona–Sant Vicenç cut to 2 trains per hour.
  - Christmas R3 bus timetables for 24/25 Dec 2025 issued as a separate PDF.
  - **The Gelida accident** (20 Jan 2026): a retaining wall collapsed onto an R4 train (1 dead, 37 injured). The whole Rodalies network was suspended for about two days, partial service returned on 24 Jan, R4 Martorell–Sant Sadurní ran as buses only until **7 Apr 2026**, and there were replacement services on about 11 lines for a time, with buses overwhelmed. Rodalies publishes "Estat del servei i plans de transport alternatius" and PDFs per works package (e.g. `…/2026/02_12_Garraf/PDF/HORARIS-BUS.pdf`).
- **Real-time:** Renfe GTFS-RT (trip updates, vehicle positions, alerts) exists. Whether replacement coaches carry RT is unknown [unverified].
- **Recommendation:** treat replacement buses as first-class trips (they are in the GTFS). Show "bus substitutori", and warn that bus times depend on traffic, as the Rodalies PDFs state. Expect a short feed window, so refresh at least daily. Keep PDF-only plans as alerts with affected-segment geometry when they are not yet in the GTFS.

### 6.9 Rodalies trains skipping stations

- [GTFS-verified] R2S, R11 and R16 trips with the same termini but different stop counts (§6.1). Show stopping patterns per trip, and do not infer "all stops" from the line code.

---

## 7. How each kind of irregularity is published

| Mechanism | Who uses it | Machine-readable? |
|---|---|---|
| GTFS `calendar_dates` single dates | gencat (exclusively), FGC, AMB (eves, summer), TMB | Yes. The most reliable signal. |
| Separate route_id for a seasonal variant | gencat (Port Aventura hivern), AMB (VB4/PR3/PR5) | Yes |
| Free-text `calendar.name` | gencat (non-standard) | Semi. Useful for labels, **unreliable as truth** (§9). |
| Trip footnote `nota.txt` | gencat (non-standard) | No. Needs pattern parsing. Carries DRT, market, venue, festive nights, stop skips. |
| GTFS-Flex | Reus (Spare) | Yes |
| Route-level `continuous_drop_off` | AMB night lines | Yes |
| Non-standard `prohibition` column | gencat | Undocumented |
| `route_type=3` inside a rail feed | Renfe | Yes |
| PDF timetables | Rodalies works, ski buses (Bus Blanc), Patum, Mataró Santes diversions | No |
| Press releases / operator news | TMB (Mercè/Sant Joan/Cap d'Any all-nighters, Tots Sants), Ajuntament de Mataró (Santes), Girona TMG (Fires), Lleida (Aplec) | No |
| Tenders | TMG Girona "Bus Nit Fires" | No |
| Operator notices consumed live | Mataró Bus notices (the app parses "HORARIS ESTIU…" into a season window) | Partly: the repo already does this |

---

## 8. Mataró: what the repo does today and the gaps [repo-verified]

- **Calendar sources:** `src/data/holidays.json` holds regional plus 2 local holidays per year (2026: Fira a Mataró 25 May, Les Santes 27 Jul). **2027 local holidays are empty**, so `calendar.go` will warn "Festius locals de Mataró 2027 no configurats". There is a `serviceOverrides` array (date → dayType), currently empty in 2026 and 2027.
- **Seasons:** `mataro_schedules.seasons.json` holds complete `winter` and `summer` grids per line, direction and day type (weekday/saturday/sunday). `app/calendar.go` hard-codes one summer window (27 Jul – 23 Aug 2026, weekdays only) and accepts extra windows from live notices (`registerSeasonWindow`). Ambiguous overlapping notice windows fall back to winter with `Known:false`.
- **Day-type resolution:** override > holiday (sunday grid) > Sunday > Saturday > weekday. The board label becomes "Horari especial" when an override applies.
- **Gaps relative to the irregularities above:**
  1. **No representation of extra lines** (Bus Focs L10/L11/L12) or **dated diversions** (Santes route changes and stop closures). `serviceOverrides` can only swap the day-type grid for a whole day; it cannot add a night service or close stops for a time window.
  2. **No eve-of-holiday or special-night concept.** The urban network may not need it, but the interurban N80/N82/N83 overlap with Mataró stops does.
  3. **No early-finish rule for 24 and 31 Dec.** Most Catalan networks finish early; whether Mataró Bus does is unverified.
  4. **Afternoon-only Sunday flags** exist (L6, L8). That is good: keep that kind of partial-day encoding.
  5. Loop-line asymmetry is stored per direction (good). Planner continuity across loop runs should be checked.
  6. If Arribo! expands, the same mechanisms must cover the gencat footnote vocabulary (§2.1) and venue calendars (§3.6).

---

## 9. Data-quality hazards found in the published feeds

1. **Gencat: calendar names contradict dates [GTFS-verified].** Examples:
   - svc 185551 "De dilluns a divendres feiners de l'1/07 al 31/08" has **113 dates in Jan–Jun**
   - svc 186970 "Diari. de l'1/07 al 31/07" has 91 Jan–Jun dates
   - svc 186922 "Diari. del 25/06 al 3/09" has 91 dates from 20260326 to 20260624
   - svc 186882 "Diumenges i festius de juliol i agost" has 11 dates in Jan–Jun
   - svc 186930 "…durant els mesos de juliol i agost" has the single date 20260331
   - e13's svc 186878 "Festius de l'1/10 al 31/05" includes ordinary weekdays 2026-04-07 and 04-10
   - svc 186879 "Festius de l'1/06 al 30/09" has only 2026-06-24 (no June Sundays)

   Either the names or the date lists are wrong. **Use the dates for routing, but run a consistency check and flag mismatches** instead of displaying the name as truth.
2. **Gencat: the "Lectius" calendar looks wrong around Easter 2026 [GTFS-verified; official school calendar not re-checked because the search budget ran out].** Svc 184994 "Lectius" (112 dates, used by 199 routes) **includes** 30 Mar – 1 Apr, **3 Apr (Good Friday, a public holiday)**, **6 Apr (Easter Monday, a public holiday)** and 7–10 Apr. It **excludes** 2 Apr and 13–17 Apr. Catalan Easter school holidays normally sit around Easter week (Easter Sunday 2026 = 5 Apr). The university calendar svc 185331 also excludes 13–17 Apr and includes 30 Mar – 1 Apr. Recommendation: validate the school-day calendars against the Departament d'Educació calendar each year, and never let a "lectiu" trip run on a public holiday.
3. **Gencat: footnotes contradict the calendar [GTFS-verified].** e9 "excepte Segon Dilluns de Pasqua" is still active on 2026-05-25. Festive-night notes ("I nits de la Revetlla…") are not reflected in the dates.
4. **Gencat: the flex columns exist but are empty, and `pickup_type` is always 0** despite 1,691 DRT-annotated trips.
5. **Gencat: HTML entities and line breaks inside notes** (`&#224;`, `&#10;`), and 127 placeholder "." notes. Unescape them, and drop placeholders.
6. **Renfe:** 12 routes have an empty long name (`51T0051R2` …); several mislabelled "R1" routes point at Lleida, Binéfar and Riba-roja (not R1 territory); degenerate 1-stop R16 trips. Renfe stop_times is about 253 MB for Spain, so filter by `51T` routes early.
7. **AMB:** the published zip's `feed_info` claims validity of only 5 days (3–8 Jun) even though calendars extend to 2028. Several operator sub-services (B2, B29, M30, X30) had already expired inside the snapshot. Refresh often.
8. **TMB:** the feed ends 2026-12-05 and has no all-night metro encoded for Sant Joan or Mercè.

---

## 10. Recommended data model for a Catalonia-wide planner (prose)

1. **Layered service calendar.** Each operator has base services (GTFS). Arribo! adds named calendars:
   - regional and local holidays per municipality (the repo already has this for Mataró)
   - holiday eves
   - school days (Catalonia) and university days (UAB and others)
   - movable feasts
   - festive nights (Revetlla, Cap d'Any, Mercè, Santes Focs…)
   - venue calendars (PortAventura opening and closing hour, Tibidabo, La Roca Village, ski resorts, Spotify Camp Nou fixtures, Circuit events)

   A trip can carry predicates over these calendars ("runs only if PortAventura closes ≥ 22:00", "only on even dates", "school days only"). Keep the GTFS date list as the primary truth and the predicates as refinements. Show the original footnote whenever a predicate was derived from text.
2. **Overlay layer for dated exceptions:** extra dated routes (Bus Focs, event shuttles, Camp Nou perimeter bus), stop closures and relocations by time window (Santes diversions, market days, Santa Tecla fireworks week), and trip cancellations. Each overlay records its source type (GTFS, PDF, press, notice) and confidence. This generalises the repo's `serviceOverrides` (today it only swaps a whole-day grid).
3. **Per-trip stop patterns** (never per-line), block-based through-running with line-code changes (R4→RL4, the R2 family, gencat interlining), headsign per trip, and loop continuity.
4. **Pickup/drop-off semantics** at three levels: GTFS fields; parsed gencat DRT notes giving on-request stops with a booking deadline, phone or app; the prohibition groups; AMB `continuous_drop_off`. A GTFS-Flex reader for Reus and future Spare/TAD CAT exports.
5. **Contingent services** (Gelida bus-funicular, "only if passengers" airport detours) are hidden by default and surfaced when an alert or real-time feed triggers them.
6. **Feed-window honesty:** outside a feed's encoded window, show "horari no publicat" and never extrapolate (gencat Jan–Jun snapshots, Renfe 30-day rolling, TMB ending 5 Dec). This matches the repo's telemetry-honesty principle: label theoretical vs announced vs observed.
7. **Real-time:** SIRI and GTFS-RT generally cover regular lines. Festival specials appear (if at all) under unexpected line codes. Accept and label them, and never match them to base timetables.

---

## 11. Unverified items and follow-ups

- **Blocked hosts:** territori.gencat.cat and ambmobilitat.cat (proxy 403 for curl). WebFetch could not reach mataro.cat, tvmataro.cat, capgros.elnacional.cat and mitjamataro.cat. Allowing them would let someone confirm the 2026 Santes bus lines and diversions and the live gencat zip (likely a newer Jul–Dec release).
- **Web-search budget exhausted** before: AMB bus-a-demanda line list; TMB "Bus del Barri"; the Rodalies semi-direct policy; Festa Major de Gràcia/Sants and Sant Medir diversions; Temps de Flors; Sant Ermengol; Reus Misericòrdia/Sant Pere; Sabadell/Terrassa festes majors; Vilanova carnival; Sónar/Cruïlla/MWC shuttles; election-day measures; Mataró Bus Christmas and Tots Sants arrangements; the 2025–26 school calendar check for §9.2. Those rows above are marked "not researched" or rest on generic patterns.
- Not checked: whether Mataró Bus SIRI emits Bus Focs vehicles, and under which line ref.
- The meaning of the gencat `prohibition` column needs confirmation from DGTM.
