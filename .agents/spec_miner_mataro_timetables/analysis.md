# Comprehensive Specification Analysis: Mataró Bus Authoritative Timetables (Lines 1–8)

**Author**: Spec Miner Subagent (Mataró Lines 1–8)  
**Date**: 2026-08-22  
**Specification Sources**: 
- Official Avanza / CTSA Mataró Urban Bus API (`mataro.avanzagrupo.com`)
- Real-Time SIRI Telemetry Endpoint (`sirimataro.avanzagrupo.com`)
- Official Mataró Bus Line & Stop Database (`data/cities/mataro/`)
- ATM Transit Feed Specification Standards

---

## Executive Summary

The Mataró Bus urban transit network comprises 8 operational lines (`L1` through `L8`), operated under concession by CTSA / Avanza (Grup Avanza). Previously, the codebase in `src/mataroTracker.js` approximated transit services using a synthetic headway generator (`depSec += headwaySec`, with uniform 15, 18, 20, 25, or 30-minute intervals). This created noticeable inaccuracies, such as:
1. Deviations from true irregular departures (peak vs off-peak non-uniform headways).
2. Misaligned morning resumption times (e.g. Line 8 starting at generic 06:45 instead of official 06:05 / 06:23).
3. Incorrect Sunday & Saturday schedules (e.g. Sunday Line 8 starts at 14:04 on Path 12 and 14:45 on Path 11, whereas synthetic logic forced symmetric 30-minute loops).
4. Line 6 Sunday service running only in the afternoon (Path 11 starting at 14:00, Path 12 at 14:17).

This document establishes the **authoritative schedule matrices** and **stop-by-stop cumulative run times** for all 8 lines across all service calendar types (**Feiners / Weekdays**, **Dissabtes / Saturdays**, **Diumenges i Festius / Sundays & Holidays**).

---

## Features Discovered

| # | Category | Feature | Description | Inputs | Outputs | Error Behavior | Discovered Via |
|---|----------|---------|-------------|--------|---------|----------------|----------------|
| 1 | Line 1 | Circular Mataró (Rodalies ⇄ Hospital) | Full 2-directional circular route connecting Rodalies station with Hospital de Mataró via Cerdanyola/Cirera | LineId: '1', dirId: '0'/'1', dayType | 76/67 trips (Wkd), 37/37 trips (Sat), 25/25 trips (Sun) | Fallback to weekend matrix if holiday | Avanza API / routes_full.json |
| 2 | Line 2 | Circular Mataró (Hospital ⇄ Rodalies) | Complementary counter-circular route serving Hospital, Rocafonda, Centre, and Rodalies | LineId: '2', dirId: '0'/'1', dayType | 77/65 trips (Wkd), 36/36 trips (Sat), 26/26 trips (Sun) | Fallback to weekend matrix if holiday | Avanza API / routes_full.json |
| 3 | Line 3 | Camí de la Serra - Vista Alegre - Rocafonda | Cross-town route linking high-density residential neighborhoods with Hospital and Rodalies | LineId: '3', dirId: '0'/'1', dayType | 50/48 trips (Wkd), 35/36 trips (Sat), 23/24 trips (Sun) | Fallback to closest variant | Avanza API / routes_full.json |
| 4 | Line 4 | Cirera - Molins | Radial connector serving northern districts Cirera and Els Molins to Rodalies | LineId: '4', dirId: '0'/'1', dayType | 26/13 trips (Wkd), 13/14 trips (Sat), 14/13 trips (Sun) | Fallback to standard loop | Avanza API / routes_full.json |
| 5 | Line 5 | Rodalies - Hospital de Mataró (Direct) | High-frequency direct corridor along Via Europa connecting Rodalies to Hospital | LineId: '5', dirId: '0'/'1', dayType | 69/68 trips (Wkd), 51/50 trips (Sat), 29/30 trips (Sun) | Fallback to weekday matrix | Avanza API / routes_full.json |
| 6 | Line 6 | ICS - Ctra. de Mata (Afternoon Sun) | Peripheral transverse route; operates afternoon-only on Sundays (from 14:00 / 14:17) | LineId: '6', dirId: '0'/'1', dayType | 64/40 trips (Wkd), 26/26 trips (Sat), 12/12 trips (Sun) | Inactive Sun morning (next morning resumption) | Avanza API / routes_full.json |
| 7 | Line 7 | Pl. Tereses - Parc de Cerdanyola | Urban shuttle between central Plaça de les Tereses and Parc de Cerdanyola | LineId: '7', dirId: '0'/'1', dayType | 51/51 trips (Wkd), 37/37 trips (Sat), 35/35 trips (Sun) | Variant 21 afternoon match | Avanza API / routes_full.json |
| 8 | Line 8 | Rodalies - Galícia (Afternoon Sun) | Eastern district feeder to TecnoCampus & Rodalies; afternoon-only Sundays (14:04 / 14:45) | LineId: '8', dirId: '0'/'1', dayType | 43/27 trips (Wkd), 14/14 trips (Sat), 7/8 trips (Sun) | Inactive Sun morning (next morning resumption) | Avanza API / routes_full.json |
| 9 | Synthesizer | Exact Matrix Injection | Native `scheduledDepartures: string[]` consumption in schedule synthesizer | baseDepartureTimes array + stopTravelSec | Monotonically sorted passing departures with correct badges | Empty array returns [] | `src/core/schedule/scheduleSynthesizer.js` |
| 10 | Real-Time | SIRI to Matrix Seamless Transition | Live vehicle arrivals take precedence, transitioning seamlessly to official timetable | Live SIRI departures + Timetable departures | Deduplicated 120-min countdown list | Falls back to static timetable on SIRI timeout | `src/mataroTracker.js` |

---

## Edge Cases Discovered & Observed Behavior

| # | Feature | Input / Condition | Observed Behavior |
|---|---------|-------------------|-------------------|
| 1 | Line 8 Sunday Morning | Querying L8 stop before 14:04 on Sunday | Line is inactive; upcoming departure list displays first afternoon service at 14:04 (Path 12) or 14:45 (Path 11) with badge "🌅 1r Servei del matí / tarda". |
| 2 | Line 6 Sunday Morning | Querying L6 stop before 14:00 on Sunday | Line is inactive; returns first trip at 14:00 (Path 11) / 14:17 (Path 12). |
| 3 | Line 3 Early Morning Variant | Path 21 first departure at 05:28 | Path 21 provides identical core timetable with explicit early morning insertion at 05:28 from Rodalies. |
| 4 | Line 7 ICS Variant | Path 21 departure at 15:17 | Variant from ICS to Pl. Tereses during school/work afternoon rush. |
| 5 | Asymmetric Trip Counts | Line 8 Weekdays: 43 trips Dir 0 vs 27 trips Dir 1 | Dir 0 (Galícia -> Rodalies) has short 13-stop run (~16 min); Dir 1 (Rodalies -> Galícia) has long 25-stop loop (~31 min), causing interleaved asymmetrical frequency. |
| 6 | Late Night Resumption | Querying after 22:35 on any line | Correctly transitions to tomorrow's dayType official 1st trip (e.g. Saturday night -> Sunday 08:12 for L1). |

---

## Detailed Line Profile: Line 1 — Circular 

- **Line ID**: `1`
- **Public Name**: `Circular `
- **Branding Color**: `#ff00ff`
- **Agency**: Mataró Bus (CTSA / Avanza)
- **Number of Directions / Routes**: 2

### Line 1 Direction 0: [Path ID 12] Hospital - Rodalies

- **Route Name**: `Hospital - Rodalies`
- **Origin Terminal**: `[1001] Hospital de Mataró - 1001`
- **Destination Terminal**: `[1016] Rodalies - 1016`
- **Total Stops**: 15
- **Polyline Coordinates**: 481 points
- **Route Distance**: **5.83 km** (5830 meters)
- **Cumulative Travel Time**: **~21 minutes** (1262 seconds)

#### Authoritative Departure Matrices (First Stop Departures)

##### Feiners (67 trips / day)
- **Operating Span**: `06:03` → `22:05`
```json
[
  "06:03",
  "06:48",
  "07:07",
  "07:28",
  "07:43",
  "07:55",
  "08:08",
  "08:21",
  "08:33",
  "08:46",
  "08:59",
  "09:12",
  "09:25",
  "09:38",
  "09:51",
  "10:04",
  "10:17",
  "10:31",
  "10:44",
  "10:57",
  "11:10",
  "11:23",
  "11:37",
  "11:50",
  "12:03",
  "12:16",
  "12:30",
  "12:45",
  "12:59",
  "13:13",
  "13:27",
  "13:41",
  "13:56",
  "14:10",
  "14:23",
  "14:36",
  "14:50",
  "15:03",
  "15:16",
  "15:29",
  "15:42",
  "15:55",
  "16:08",
  "16:21",
  "16:33",
  "16:46",
  "17:00",
  "17:14",
  "17:27",
  "17:40",
  "17:53",
  "18:07",
  "18:21",
  "18:35",
  "18:50",
  "19:05",
  "19:19",
  "19:34",
  "19:49",
  "20:04",
  "20:19",
  "20:39",
  "20:50",
  "21:03",
  "21:28",
  "21:45",
  "22:05"
]
```

##### Dissabtes (37 trips / day)
- **Operating Span**: `07:09` → `22:02`
```json
[
  "07:09",
  "07:29",
  "07:50",
  "08:13",
  "08:36",
  "09:00",
  "09:23",
  "09:47",
  "10:10",
  "10:35",
  "10:59",
  "11:23",
  "11:49",
  "12:16",
  "12:42",
  "13:08",
  "13:34",
  "14:00",
  "14:26",
  "14:51",
  "15:16",
  "15:41",
  "16:06",
  "16:31",
  "16:56",
  "17:21",
  "17:47",
  "18:14",
  "18:40",
  "19:07",
  "19:33",
  "20:00",
  "20:27",
  "20:53",
  "21:16",
  "21:38",
  "22:02"
]
```

##### Diumenges i Festius (25 trips / day)
- **Operating Span**: `08:15` → `21:58`
```json
[
  "08:15",
  "08:46",
  "09:20",
  "09:53",
  "10:26",
  "10:59",
  "11:33",
  "12:07",
  "12:41",
  "13:17",
  "13:53",
  "14:28",
  "15:03",
  "15:37",
  "16:11",
  "16:44",
  "17:18",
  "17:54",
  "18:29",
  "19:05",
  "19:41",
  "20:17",
  "20:52",
  "21:27",
  "21:58"
]
```

#### Stop Sequence & Topographic Passing Offsets

| Seq | Stop ID | Stop Name | Offset (Min:Sec) | Cumulative Sec | Segment (m) | Total Dist (m) |
|---|---|---|---|---|---|---|
| 1 | `1001` | Hospital de Mataró - 1001 | `+00:00` | 0s | 0m | 0m |
| 2 | `1003` | Cirera - 1003 | `+03:03` | 183s | 759m | 759m |
| 3 | `1004` | CAP Cirera-Molins - 1004 | `+04:26` | 266s | 280m | 1039m |
| 4 | `1005` | Sant Oleguer - 1005 | `+05:58` | 358s | 321m | 1360m |
| 5 | `1006` | Caputxins - 1006 | `+07:52` | 472s | 425m | 1786m |
| 6 | `1007` | Perú - 1007 | `+08:51` | 531s | 163m | 1949m |
| 7 | `1008` | Pau Picasso - 1008 | `+10:02` | 602s | 222m | 2171m |
| 8 | `1009` | Escola Freta - 1009 | `+11:06` | 666s | 184m | 2355m |
| 9 | `1010` | Cabanellas - 1010 | `+12:08` | 728s | 180m | 2535m |
| 10 | `1011` | Parc Central - 1011 | `+13:49` | 829s | 364m | 2899m |
| 11 | `1012` | Caminet - 1012 | `+15:36` | 936s | 395m | 3294m |
| 12 | `1013` | Muralla - 1013 | `+16:38` | 998s | 178m | 3472m |
| 13 | `1014` | Santa Anna - 1014 | `+18:07` | 1087s | 307m | 3779m |
| 14 | `1015` | El Cargol - 1015 | `+19:48` | 1188s | 362m | 4142m |
| 15 | `1016` | Rodalies - 1016 | `+21:02` | 1262s | 236m | 4378m |

---

### Line 1 Direction 1: [Path ID 11] Rodalies - Hospital

- **Route Name**: `Rodalies - Hospital`
- **Origin Terminal**: `[1016] Rodalies - 1016`
- **Destination Terminal**: `[1001] Hospital de Mataró - 1001`
- **Total Stops**: 23
- **Polyline Coordinates**: 621 points
- **Route Distance**: **7.75 km** (7749 meters)
- **Cumulative Travel Time**: **~30 minutes** (1811 seconds)

#### Authoritative Departure Matrices (First Stop Departures)

##### Feiners (76 trips / day)
- **Operating Span**: `05:25` → `22:35`
```json
[
  "05:25",
  "06:25",
  "06:46",
  "06:53",
  "07:01",
  "07:14",
  "07:26",
  "07:39",
  "07:52",
  "08:03",
  "08:14",
  "08:27",
  "08:40",
  "08:53",
  "09:07",
  "09:20",
  "09:33",
  "09:46",
  "09:59",
  "10:11",
  "10:24",
  "10:37",
  "10:50",
  "11:03",
  "11:16",
  "11:28",
  "11:41",
  "11:54",
  "12:08",
  "12:21",
  "12:34",
  "12:46",
  "12:59",
  "13:12",
  "13:25",
  "13:38",
  "13:51",
  "14:03",
  "14:16",
  "14:29",
  "14:43",
  "14:57",
  "15:11",
  "15:24",
  "15:36",
  "15:48",
  "16:01",
  "16:15",
  "16:29",
  "16:43",
  "16:56",
  "17:09",
  "17:22",
  "17:36",
  "17:50",
  "18:04",
  "18:17",
  "18:29",
  "18:42",
  "18:56",
  "19:10",
  "19:23",
  "19:35",
  "19:48",
  "20:00",
  "20:14",
  "20:31",
  "20:49",
  "21:02",
  "21:15",
  "21:29",
  "21:43",
  "21:58",
  "22:11",
  "22:22",
  "22:35"
]
```

##### Dissabtes (37 trips / day)
- **Operating Span**: `06:36` → `22:09`
```json
[
  "06:36",
  "07:12",
  "07:41",
  "08:03",
  "08:26",
  "08:49",
  "09:11",
  "09:34",
  "09:58",
  "10:22",
  "10:46",
  "11:10",
  "11:34",
  "11:59",
  "12:25",
  "12:52",
  "13:18",
  "13:44",
  "14:10",
  "14:36",
  "15:02",
  "15:27",
  "15:52",
  "16:17",
  "16:42",
  "17:07",
  "17:33",
  "17:59",
  "18:26",
  "18:52",
  "19:19",
  "19:46",
  "20:12",
  "20:39",
  "21:04",
  "21:29",
  "22:09"
]
```

##### Diumenges i Festius (25 trips / day)
- **Operating Span**: `08:12` → `22:01`
```json
[
  "08:12",
  "08:48",
  "09:19",
  "09:51",
  "10:24",
  "10:58",
  "11:31",
  "12:05",
  "12:40",
  "13:16",
  "13:51",
  "14:27",
  "15:01",
  "15:35",
  "16:08",
  "16:42",
  "17:17",
  "17:51",
  "18:27",
  "19:03",
  "19:40",
  "20:16",
  "20:53",
  "21:25",
  "22:01"
]
```

#### Stop Sequence & Topographic Passing Offsets

| Seq | Stop ID | Stop Name | Offset (Min:Sec) | Cumulative Sec | Segment (m) | Total Dist (m) |
|---|---|---|---|---|---|---|
| 1 | `1016` | Rodalies - 1016 | `+00:00` | 0s | 0m | 0m |
| 2 | `1017` | Ronda Barceló - 1017 | `+01:07` | 67s | 202m | 202m |
| 3 | `1018` | Pl. Doctor Fleming - 1018 | `+02:36` | 156s | 307m | 508m |
| 4 | `1019` | President Macià - 1019 | `+03:45` | 225s | 214m | 722m |
| 5 | `1020` | Sant Valentí - 1020 | `+04:54` | 294s | 207m | 930m |
| 6 | `1021` | Edif. Vidre - TecnoCampus - 1021 | `+05:55` | 355s | 175m | 1104m |
| 7 | `1022` | Institut Català Salut - 1022 | `+08:12` | 492s | 540m | 1644m |
| 8 | `1023` | Gatassa - 1023 | `+09:24` | 564s | 221m | 1865m |
| 9 | `1024` | Rosselló - 1024 | `+10:33` | 633s | 211m | 2077m |
| 10 | `1025` | València - 1025 | `+11:54` | 714s | 273m | 2349m |
| 11 | `1026` | Ronda Cerdanya - 1026 | `+13:01` | 781s | 202m | 2551m |
| 12 | `1027` | Vallès - 1027 | `+14:02` | 842s | 171m | 2722m |
| 13 | `1028` | Ample - 1028 | `+14:53` | 893s | 126m | 2847m |
| 14 | `1029` | Roca Blanca - 1029 | `+16:13` | 973s | 263m | 3111m |
| 15 | `1030` | Escola El Turó - 1030 | `+17:50` | 1070s | 343m | 3454m |
| 16 | `1031` | Euskadi - 1031 | `+18:56` | 1136s | 197m | 3651m |
| 17 | `1032` | Irlanda - 1032 | `+20:15` | 1215s | 259m | 3910m |
| 18 | `1033` | Parc La Llàntia - 1033 | `+21:18` | 1278s | 186m | 4096m |
| 19 | `1034` | Blanes - 1034 | `+22:27` | 1347s | 211m | 4307m |
| 20 | `1035` | La Llàntia - 1035 | `+23:44` | 1424s | 250m | 4558m |
| 21 | `1036` | Cementiri Les Valls - 1036 | `+26:56` | 1616s | 801m | 5359m |
| 22 | `1002` | Mataró Parc - 1002 | `+29:07` | 1747s | 508m | 5866m |
| 23 | `1001` | Hospital de Mataró - 1001 | `+30:11` | 1811s | 187m | 6054m |

---

## Detailed Line Profile: Line 2 — Circular 

- **Line ID**: `2`
- **Public Name**: `Circular `
- **Branding Color**: `#804000`
- **Agency**: Mataró Bus (CTSA / Avanza)
- **Number of Directions / Routes**: 2

### Line 2 Direction 0: [Path ID 11] Hospital - Rodalies

- **Route Name**: `Hospital - Rodalies`
- **Origin Terminal**: `[1073] Hospital de Mataró - 1073`
- **Destination Terminal**: `[1058] Rodalies - 1058`
- **Total Stops**: 23
- **Polyline Coordinates**: 486 points
- **Route Distance**: **7.43 km** (7431 meters)
- **Cumulative Travel Time**: **~29 minutes** (1719 seconds)

#### Authoritative Departure Matrices (First Stop Departures)

##### Feiners (77 trips / day)
- **Operating Span**: `05:25` → `22:19`
```json
[
  "05:25",
  "06:02",
  "06:30",
  "06:51",
  "07:03",
  "07:16",
  "07:28",
  "07:41",
  "07:54",
  "08:07",
  "08:20",
  "08:33",
  "08:46",
  "09:00",
  "09:13",
  "09:26",
  "09:39",
  "09:51",
  "10:03",
  "10:15",
  "10:28",
  "10:41",
  "10:54",
  "11:07",
  "11:19",
  "11:31",
  "11:44",
  "11:56",
  "12:09",
  "12:22",
  "12:35",
  "12:48",
  "13:01",
  "13:14",
  "13:27",
  "13:40",
  "13:52",
  "14:04",
  "14:17",
  "14:30",
  "14:43",
  "14:56",
  "15:08",
  "15:20",
  "15:33",
  "15:46",
  "15:58",
  "16:10",
  "16:22",
  "16:35",
  "16:48",
  "17:01",
  "17:14",
  "17:27",
  "17:41",
  "17:54",
  "18:07",
  "18:20",
  "18:33",
  "18:46",
  "18:59",
  "19:12",
  "19:25",
  "19:38",
  "19:50",
  "20:02",
  "20:14",
  "20:26",
  "20:38",
  "20:50",
  "21:02",
  "21:14",
  "21:26",
  "21:38",
  "21:49",
  "22:00",
  "22:19"
]
```

##### Dissabtes (36 trips / day)
- **Operating Span**: `06:56` → `22:13`
```json
[
  "06:56",
  "07:32",
  "08:00",
  "08:19",
  "08:46",
  "09:09",
  "09:33",
  "09:57",
  "10:22",
  "10:47",
  "11:12",
  "11:37",
  "12:03",
  "12:29",
  "12:55",
  "13:22",
  "13:48",
  "14:14",
  "14:40",
  "15:06",
  "15:31",
  "15:56",
  "16:22",
  "16:47",
  "17:12",
  "17:37",
  "18:03",
  "18:29",
  "18:56",
  "19:23",
  "19:49",
  "20:15",
  "20:40",
  "21:04",
  "21:34",
  "22:13"
]
```

##### Diumenges i Festius (26 trips / day)
- **Operating Span**: `07:55` → `22:00`
```json
[
  "07:55",
  "08:27",
  "08:58",
  "09:29",
  "10:02",
  "10:35",
  "11:09",
  "11:42",
  "12:17",
  "12:51",
  "13:26",
  "14:00",
  "14:35",
  "15:09",
  "15:43",
  "16:16",
  "16:50",
  "17:23",
  "17:57",
  "18:32",
  "19:07",
  "19:42",
  "20:17",
  "20:51",
  "21:24",
  "22:00"
]
```

#### Stop Sequence & Topographic Passing Offsets

| Seq | Stop ID | Stop Name | Offset (Min:Sec) | Cumulative Sec | Segment (m) | Total Dist (m) |
|---|---|---|---|---|---|---|
| 1 | `1073` | Hospital de Mataró - 1073 | `+00:00` | 0s | 0m | 0m |
| 2 | `1037` | Cementiri Les Valls - 1037 | `+01:12` | 72s | 224m | 224m |
| 3 | `1038` | La Llàntia - 1038 | `+04:31` | 271s | 834m | 1059m |
| 4 | `1039` | Blanes - 1039 | `+05:46` | 346s | 241m | 1300m |
| 5 | `1040` | Parc La Llàntia - 1040 | `+06:55` | 415s | 211m | 1511m |
| 6 | `1041` | Irlanda - 1041 | `+08:02` | 482s | 201m | 1712m |
| 7 | `1134` | Euskadi - 1134 | `+09:00` | 540s | 160m | 1872m |
| 8 | `1043` | Escola El Turó - 1043 | `+10:09` | 609s | 212m | 2084m |
| 9 | `1044` | Queralbs - 1044 | `+11:31` | 691s | 274m | 2358m |
| 10 | `1045` | Pl. Gatassa - 1045 | `+12:16` | 736s | 96m | 2454m |
| 11 | `1046` | Cerdanyola - 1046 | `+13:21` | 801s | 191m | 2645m |
| 12 | `1047` | Pres.Tarradellas - 1047 | `+15:00` | 900s | 357m | 3001m |
| 13 | `1048` | Plaça Andalusia - 1048 | `+16:25` | 985s | 288m | 3289m |
| 14 | `1049` | Rosselló - 1049 | `+17:40` | 1060s | 239m | 3528m |
| 15 | `1050` | Gatassa - 1050 | `+18:30` | 1110s | 122m | 3650m |
| 16 | `1051` | Institut Català Salut - 1051 | `+20:03` | 1203s | 325m | 3975m |
| 17 | `1052` | Edif. Vidre - TecnoCampus - 1052 | `+22:06` | 1326s | 469m | 4445m |
| 18 | `1053` | Sant Valentí - 1053 | `+23:21` | 1401s | 240m | 4684m |
| 19 | `1054` | President Macià - 1054 | `+24:22` | 1462s | 175m | 4859m |
| 20 | `1055` | Jutjats - 1055 | `+25:12` | 1512s | 116m | 4975m |
| 21 | `1056` | Pl. Doctor Fleming - 1056 | `+26:12` | 1572s | 173m | 5148m |
| 22 | `1057` | Ronda Barceló - 1057 | `+27:31` | 1651s | 258m | 5406m |
| 23 | `1058` | Rodalies - 1058 | `+28:39` | 1719s | 205m | 5611m |

---

### Line 2 Direction 1: [Path ID 12] Rodalies - Hospital

- **Route Name**: `Rodalies - Hospital`
- **Origin Terminal**: `[1058] Rodalies - 1058`
- **Destination Terminal**: `[1073] Hospital de Mataró - 1073`
- **Total Stops**: 16
- **Polyline Coordinates**: 399 points
- **Route Distance**: **5.77 km** (5766 meters)
- **Cumulative Travel Time**: **~22 minutes** (1322 seconds)

#### Authoritative Departure Matrices (First Stop Departures)

##### Feiners (65 trips / day)
- **Operating Span**: `05:28` → `22:24`
```json
[
  "05:28",
  "05:56",
  "06:25",
  "06:54",
  "07:23",
  "08:03",
  "08:24",
  "08:34",
  "08:44",
  "08:58",
  "09:11",
  "09:25",
  "09:39",
  "09:52",
  "10:06",
  "10:19",
  "10:33",
  "10:47",
  "11:00",
  "11:14",
  "11:28",
  "11:42",
  "11:56",
  "12:10",
  "12:24",
  "12:38",
  "12:52",
  "13:06",
  "13:20",
  "13:34",
  "13:48",
  "14:02",
  "14:15",
  "14:28",
  "14:42",
  "14:56",
  "15:10",
  "15:23",
  "15:36",
  "15:49",
  "16:02",
  "16:15",
  "16:28",
  "16:41",
  "16:55",
  "17:08",
  "17:21",
  "17:35",
  "17:49",
  "18:03",
  "18:17",
  "18:31",
  "18:45",
  "18:59",
  "19:14",
  "19:28",
  "19:42",
  "19:57",
  "20:12",
  "20:27",
  "20:40",
  "21:04",
  "21:18",
  "21:43",
  "22:24"
]
```

##### Dissabtes (36 trips / day)
- **Operating Span**: `06:26` → `22:08`
```json
[
  "06:26",
  "07:27",
  "08:10",
  "08:33",
  "08:57",
  "09:21",
  "09:45",
  "10:09",
  "10:34",
  "10:59",
  "11:25",
  "11:50",
  "12:17",
  "12:44",
  "13:10",
  "13:36",
  "14:03",
  "14:29",
  "14:54",
  "15:19",
  "15:45",
  "16:10",
  "16:34",
  "17:00",
  "17:25",
  "17:50",
  "18:16",
  "18:42",
  "19:08",
  "19:34",
  "20:01",
  "20:27",
  "20:54",
  "21:18",
  "21:40",
  "22:08"
]
```

##### Diumenges i Festius (26 trips / day)
- **Operating Span**: `07:59` → `22:00`
```json
[
  "07:59",
  "08:27",
  "08:57",
  "09:30",
  "10:02",
  "10:35",
  "11:08",
  "11:43",
  "12:17",
  "12:52",
  "13:26",
  "14:01",
  "14:35",
  "15:10",
  "15:43",
  "16:17",
  "16:50",
  "17:24",
  "17:57",
  "18:32",
  "19:07",
  "19:42",
  "20:17",
  "20:51",
  "21:26",
  "22:00"
]
```

#### Stop Sequence & Topographic Passing Offsets

| Seq | Stop ID | Stop Name | Offset (Min:Sec) | Cumulative Sec | Segment (m) | Total Dist (m) |
|---|---|---|---|---|---|---|
| 1 | `1058` | Rodalies - 1058 | `+00:00` | 0s | 0m | 0m |
| 2 | `1059` | Lepant - 1059 | `+01:31` | 91s | 317m | 317m |
| 3 | `1060` | Pl. Tereses - 1060 | `+03:00` | 180s | 306m | 622m |
| 4 | `1061` | Sant Isidor - 1061 | `+04:37` | 277s | 350m | 972m |
| 5 | `1062` | Parc Central - 1062 | `+06:20` | 380s | 370m | 1342m |
| 6 | `1063` | Cabanellas - 1063 | `+08:23` | 503s | 472m | 1814m |
| 7 | `1064` | Escola Freta - 1064 | `+09:26` | 566s | 183m | 1997m |
| 8 | `1065` | Pau Picasso - 1065 | `+10:32` | 632s | 194m | 2191m |
| 9 | `1066` | Perú - 1066 | `+11:50` | 710s | 256m | 2447m |
| 10 | `1067` | Escola Vista Alegre - 1067 | `+12:42` | 762s | 130m | 2577m |
| 11 | `1068` | Salvador Espriu - 1068 | `+13:50` | 830s | 207m | 2784m |
| 12 | `1069` | Sant Oleguer - 1069 | `+15:12` | 912s | 276m | 3060m |
| 13 | `1070` | CAP Cirera-Molins - 1070 | `+16:54` | 1014s | 368m | 3428m |
| 14 | `1099` | Cirera - 1099 | `+18:13` | 1093s | 257m | 3685m |
| 15 | `1002` | Mataró Parc - 1002 | `+20:36` | 1236s | 570m | 4255m |
| 16 | `1073` | Hospital de Mataró - 1073 | `+22:02` | 1322s | 292m | 4547m |

---

## Detailed Line Profile: Line 3 — Camí de la Serra-Vista Alegre-Rocafonda

- **Line ID**: `3`
- **Public Name**: `Camí de la Serra-Vista Alegre-Rocafonda`
- **Branding Color**: `#808080`
- **Agency**: Mataró Bus (CTSA / Avanza)
- **Number of Directions / Routes**: 2

### Line 3 Direction 0: [Path ID 11] Rodalies  - Hospital Mataró

- **Route Name**: `Rodalies  - Hospital Mataró`
- **Origin Terminal**: `[1016] Rodalies - 1016`
- **Destination Terminal**: `[1001] Hospital de Mataró - 1001`
- **Total Stops**: 24
- **Polyline Coordinates**: 692 points
- **Route Distance**: **9.96 km** (9961 meters)
- **Cumulative Travel Time**: **~38 minutes** (2289 seconds)

#### Authoritative Departure Matrices (First Stop Departures)

##### Feiners (50 trips / day)
- **Operating Span**: `06:31` → `21:41`
```json
[
  "06:31",
  "06:55",
  "07:15",
  "07:38",
  "08:01",
  "08:14",
  "08:30",
  "08:48",
  "09:06",
  "09:24",
  "09:41",
  "09:58",
  "10:16",
  "10:34",
  "10:52",
  "11:10",
  "11:28",
  "11:46",
  "12:04",
  "12:22",
  "12:40",
  "12:58",
  "13:16",
  "13:34",
  "13:52",
  "14:10",
  "14:28",
  "14:46",
  "15:04",
  "15:22",
  "15:40",
  "15:58",
  "16:16",
  "16:33",
  "16:51",
  "17:09",
  "17:27",
  "17:45",
  "18:03",
  "18:21",
  "18:39",
  "18:58",
  "19:17",
  "19:35",
  "19:53",
  "20:12",
  "20:30",
  "20:48",
  "21:06",
  "21:41"
]
```

##### Dissabtes (35 trips / day)
- **Operating Span**: `07:34` → `21:17`
```json
[
  "07:34",
  "08:02",
  "08:35",
  "08:57",
  "09:20",
  "09:43",
  "10:06",
  "10:29",
  "10:53",
  "11:18",
  "11:42",
  "12:06",
  "12:30",
  "12:54",
  "13:18",
  "13:42",
  "14:06",
  "14:31",
  "14:54",
  "15:17",
  "15:40",
  "16:02",
  "16:25",
  "16:49",
  "17:12",
  "17:36",
  "18:01",
  "18:26",
  "18:49",
  "19:16",
  "19:42",
  "20:05",
  "20:29",
  "20:55",
  "21:17"
]
```

##### Diumenges i Festius (23 trips / day)
- **Operating Span**: `08:00` → `21:38`
```json
[
  "08:00",
  "08:34",
  "09:09",
  "09:44",
  "10:20",
  "10:55",
  "11:31",
  "12:06",
  "12:42",
  "13:18",
  "13:53",
  "14:28",
  "15:03",
  "15:38",
  "16:13",
  "16:48",
  "17:24",
  "17:59",
  "18:36",
  "19:13",
  "19:50",
  "20:29",
  "21:38"
]
```

#### Stop Sequence & Topographic Passing Offsets

| Seq | Stop ID | Stop Name | Offset (Min:Sec) | Cumulative Sec | Segment (m) | Total Dist (m) |
|---|---|---|---|---|---|---|
| 1 | `1016` | Rodalies - 1016 | `+00:00` | 0s | 0m | 0m |
| 2 | `1173` | TecnoCampus - 1173 | `+04:10` | 250s | 1079m | 1079m |
| 3 | `1174` | Les Hortes - 1174 | `+05:34` | 334s | 283m | 1363m |
| 4 | `1175` | El Rengle - 1175 | `+06:58` | 418s | 285m | 1648m |
| 5 | `1176` | Caldes d'Estrac - 1176 | `+08:21` | 501s | 277m | 1925m |
| 6 | `1177` | TecnoCampus - 1177 | `+09:59` | 599s | 348m | 2273m |
| 7 | `1058` | Rodalies - 1058 | `+13:56` | 836s | 1019m | 3292m |
| 8 | `1087` | La Rambla - 1087 | `+15:47` | 947s | 412m | 3704m |
| 9 | `1088` | Sant Joan - 1088 | `+17:31` | 1051s | 381m | 4084m |
| 10 | `1089` | Can Marfà - 1089 | `+18:50` | 1130s | 260m | 4344m |
| 11 | `1090` | L´Havana - 1090 | `+20:13` | 1213s | 280m | 4624m |
| 12 | `1091` | Sant Simó - 1091 | `+21:27` | 1287s | 235m | 4859m |
| 13 | `1092` | Escorxador - 1092 | `+22:36` | 1356s | 208m | 5068m |
| 14 | `1130` | El Palau - 1130 | `+24:04` | 1444s | 303m | 5370m |
| 15 | `1106` | Alfons X - 1106 | `+25:25` | 1525s | 271m | 5642m |
| 16 | `1162` | Ctra. Mata - 1162 | `+26:26` | 1586s | 170m | 5812m |
| 17 | `1094` | Rafael Estrany - 1094 | `+27:41` | 1661s | 240m | 6051m |
| 18 | `1095` | Frank Marshall - 1095 | `+29:02` | 1742s | 272m | 6323m |
| 19 | `1067` | Escola Vista Alegre - 1067 | `+30:27` | 1827s | 288m | 6612m |
| 20 | `1068` | Salvador Espriu - 1068 | `+31:36` | 1896s | 207m | 6819m |
| 21 | `1096` | Sant Oleguer - 1096 | `+33:00` | 1980s | 287m | 7106m |
| 22 | `1097` | Can Soleret - 1097 | `+34:44` | 2084s | 377m | 7483m |
| 23 | `1098` | Mataró Parc (nomès baixada d´usuaris) - 1098 | `+36:54` | 2214s | 505m | 7988m |
| 24 | `1001` | Hospital de Mataró - 1001 | `+38:09` | 2289s | 237m | 8225m |

---

### Line 3 Direction 1: [Path ID 12] Hospital - Rodalies

- **Route Name**: `Hospital - Rodalies`
- **Origin Terminal**: `[1001] Hospital de Mataró - 1001`
- **Destination Terminal**: `[1016] Rodalies - 1016`
- **Total Stops**: 17
- **Polyline Coordinates**: 406 points
- **Route Distance**: **6.22 km** (6224 meters)
- **Cumulative Travel Time**: **~24 minutes** (1429 seconds)

#### Authoritative Departure Matrices (First Stop Departures)

##### Feiners (48 trips / day)
- **Operating Span**: `06:06` → `21:12`
```json
[
  "06:06",
  "06:28",
  "07:09",
  "07:33",
  "07:59",
  "08:20",
  "08:41",
  "08:56",
  "09:11",
  "09:28",
  "09:46",
  "10:04",
  "10:22",
  "10:40",
  "10:58",
  "11:16",
  "11:34",
  "11:52",
  "12:10",
  "12:28",
  "12:46",
  "13:04",
  "13:22",
  "13:40",
  "13:58",
  "14:16",
  "14:34",
  "14:52",
  "15:10",
  "15:28",
  "15:46",
  "16:04",
  "16:22",
  "16:40",
  "16:58",
  "17:15",
  "17:33",
  "17:51",
  "18:09",
  "18:27",
  "18:46",
  "19:04",
  "19:22",
  "19:41",
  "20:00",
  "20:18",
  "20:36",
  "21:12"
]
```

##### Dissabtes (36 trips / day)
- **Operating Span**: `07:04` → `21:54`
```json
[
  "07:04",
  "07:34",
  "08:11",
  "08:51",
  "09:12",
  "09:35",
  "09:58",
  "10:23",
  "10:47",
  "11:11",
  "11:36",
  "12:01",
  "12:26",
  "12:50",
  "13:14",
  "13:38",
  "14:02",
  "14:26",
  "14:48",
  "15:10",
  "15:33",
  "15:56",
  "16:19",
  "16:41",
  "17:04",
  "17:29",
  "17:54",
  "18:18",
  "18:44",
  "19:09",
  "19:32",
  "19:58",
  "20:25",
  "20:46",
  "21:34",
  "21:54"
]
```

##### Diumenges i Festius (24 trips / day)
- **Operating Span**: `08:05` → `22:15`
```json
[
  "08:05",
  "08:40",
  "09:14",
  "09:49",
  "10:24",
  "11:00",
  "11:35",
  "12:11",
  "12:46",
  "13:22",
  "13:57",
  "14:33",
  "15:07",
  "15:43",
  "16:17",
  "16:53",
  "17:27",
  "18:04",
  "18:39",
  "19:16",
  "19:56",
  "20:30",
  "21:07",
  "22:15"
]
```

#### Stop Sequence & Topographic Passing Offsets

| Seq | Stop ID | Stop Name | Offset (Min:Sec) | Cumulative Sec | Segment (m) | Total Dist (m) |
|---|---|---|---|---|---|---|
| 1 | `1001` | Hospital de Mataró - 1001 | `+00:00` | 0s | 0m | 0m |
| 2 | `1074` | Mataró Parc - 1074 | `+01:43` | 103s | 376m | 376m |
| 3 | `1075` | Can Soleret - 1075 | `+03:48` | 228s | 477m | 853m |
| 4 | `1076` | Camí de la Serra - 1076 | `+05:04` | 304s | 246m | 1099m |
| 5 | `1077` | Joan Oliver - 1077 | `+06:45` | 405s | 366m | 1466m |
| 6 | `1172` | Ronda Creu de Pedra - 1172 | `+07:48` | 468s | 181m | 1647m |
| 7 | `1078` | Montalt - 1078 | `+08:26` | 506s | 62m | 1709m |
| 8 | `1079` | Vista Alegre - 1079 | `+09:56` | 596s | 313m | 2021m |
| 9 | `1006` | Caputxins - 1006 | `+10:40` | 640s | 92m | 2114m |
| 10 | `1080` | Franck Marshall - 1080 | `+12:07` | 727s | 296m | 2409m |
| 11 | `1081` | Rafael Estrany - 1081 | `+13:29` | 809s | 276m | 2685m |
| 12 | `1082` | Cervantes - 1082 | `+14:37` | 877s | 207m | 2891m |
| 13 | `1083` | Escorxador - 1083 | `+16:49` | 1009s | 512m | 3404m |
| 14 | `1084` | Sant Simó - 1084 | `+18:07` | 1087s | 256m | 3660m |
| 15 | `1085` | Pl. del Gas - 1085 | `+19:58` | 1198s | 411m | 4071m |
| 16 | `1015` | El Cargol - 1015 | `+22:35` | 1355s | 631m | 4702m |
| 17 | `1016` | Rodalies - 1016 | `+23:49` | 1429s | 236m | 4938m |

---

## Detailed Line Profile: Line 4 — Cirera-Molins

- **Line ID**: `4`
- **Public Name**: `Cirera-Molins`
- **Branding Color**: `#ff0000`
- **Agency**: Mataró Bus (CTSA / Avanza)
- **Number of Directions / Routes**: 2

### Line 4 Direction 0: [Path ID 12] Hospital - Rodalies

- **Route Name**: `Hospital - Rodalies`
- **Origin Terminal**: `[1001] Hospital de Mataró - 1001`
- **Destination Terminal**: `[1016] Rodalies - 1016`
- **Total Stops**: 14
- **Polyline Coordinates**: 484 points
- **Route Distance**: **5.53 km** (5528 meters)
- **Cumulative Travel Time**: **~19 minutes** (1148 seconds)

#### Authoritative Departure Matrices (First Stop Departures)

##### Feiners (13 trips / day)
- **Operating Span**: `07:45` → `20:45`
```json
[
  "07:45",
  "08:47",
  "09:51",
  "10:55",
  "11:59",
  "13:05",
  "14:11",
  "15:15",
  "16:20",
  "17:25",
  "18:32",
  "19:38",
  "20:45"
]
```

##### Dissabtes (14 trips / day)
- **Operating Span**: `07:31` → `21:50`
```json
[
  "07:31",
  "08:33",
  "09:38",
  "10:44",
  "11:50",
  "12:57",
  "14:05",
  "15:12",
  "16:16",
  "17:21",
  "18:29",
  "19:35",
  "20:41",
  "21:50"
]
```

##### Diumenges i Festius (13 trips / day)
- **Operating Span**: `09:01` → `21:30`
```json
[
  "09:01",
  "10:03",
  "11:05",
  "12:07",
  "13:11",
  "14:15",
  "15:17",
  "16:19",
  "17:22",
  "18:25",
  "19:28",
  "20:31",
  "21:30"
]
```

#### Stop Sequence & Topographic Passing Offsets

| Seq | Stop ID | Stop Name | Offset (Min:Sec) | Cumulative Sec | Segment (m) | Total Dist (m) |
|---|---|---|---|---|---|---|
| 1 | `1001` | Hospital de Mataró - 1001 | `+00:00` | 0s | 0m | 0m |
| 2 | `1002` | Mataró Parc - 1002 | `+01:04` | 64s | 187m | 187m |
| 3 | `1100` | Joan Peiró - 1100 | `+03:35` | 215s | 606m | 794m |
| 4 | `1101` | Centre Cívic Cirera - 1101 | `+04:59` | 299s | 281m | 1074m |
| 5 | `1102` | Pl. A. Machado - 1102 | `+06:04` | 364s | 192m | 1266m |
| 6 | `1004` | CAP Cirera-Molins - 1004 | `+07:40` | 460s | 344m | 1610m |
| 7 | `1103` | Figuera Major - 1103 | `+08:52` | 532s | 225m | 1835m |
| 8 | `1104` | Carles Padrós - 1104 | `+10:27` | 627s | 336m | 2171m |
| 9 | `1011` | Parc Central - 1011 | `+11:55` | 715s | 301m | 2471m |
| 10 | `1012` | Caminet - 1012 | `+13:42` | 822s | 395m | 2866m |
| 11 | `1013` | Muralla - 1013 | `+14:44` | 884s | 178m | 3044m |
| 12 | `1014` | Santa Anna - 1014 | `+16:13` | 973s | 307m | 3351m |
| 13 | `1015` | El Cargol - 1015 | `+17:54` | 1074s | 362m | 3714m |
| 14 | `1016` | Rodalies - 1016 | `+19:08` | 1148s | 236m | 3950m |

---

### Line 4 Direction 1: [Path ID 11] Rodalies - Hospital

- **Route Name**: `Rodalies - Hospital`
- **Origin Terminal**: `[1016] Rodalies - 1016`
- **Destination Terminal**: `[1001] Hospital de Mataró - 1001`
- **Total Stops**: 17
- **Polyline Coordinates**: 332 points
- **Route Distance**: **6.89 km** (6891 meters)
- **Cumulative Travel Time**: **~25 minutes** (1524 seconds)

#### Authoritative Departure Matrices (First Stop Departures)

##### Feiners (26 trips / day)
- **Operating Span**: `07:38` → `22:07`
```json
[
  "07:38",
  "08:09",
  "08:42",
  "09:17",
  "09:52",
  "10:26",
  "11:01",
  "11:36",
  "12:11",
  "12:47",
  "13:22",
  "13:57",
  "14:32",
  "15:07",
  "15:42",
  "16:17",
  "16:51",
  "17:27",
  "18:03",
  "18:39",
  "19:15",
  "19:50",
  "20:25",
  "20:58",
  "21:32",
  "22:07"
]
```

##### Dissabtes (13 trips / day)
- **Operating Span**: `08:03` → `21:13`
```json
[
  "08:03",
  "09:05",
  "10:10",
  "11:16",
  "12:22",
  "13:31",
  "14:39",
  "15:43",
  "16:47",
  "17:55",
  "19:01",
  "20:07",
  "21:13"
]
```

##### Diumenges i Festius (14 trips / day)
- **Operating Span**: `08:30` → `21:57`
```json
[
  "08:30",
  "09:30",
  "10:32",
  "11:34",
  "12:37",
  "13:41",
  "14:44",
  "15:46",
  "16:49",
  "17:52",
  "18:55",
  "19:58",
  "20:59",
  "21:57"
]
```

#### Stop Sequence & Topographic Passing Offsets

| Seq | Stop ID | Stop Name | Offset (Min:Sec) | Cumulative Sec | Segment (m) | Total Dist (m) |
|---|---|---|---|---|---|---|
| 1 | `1016` | Rodalies - 1016 | `+00:00` | 0s | 0m | 0m |
| 2 | `1017` | Ronda Barceló - 1017 | `+01:07` | 67s | 202m | 202m |
| 3 | `1018` | Pl. Doctor Fleming - 1018 | `+02:36` | 156s | 307m | 508m |
| 4 | `1153` | Porta Laietana-TecnoCampus - 1153 | `+04:42` | 282s | 487m | 995m |
| 5 | `1053` | Sant Valentí - 1053 | `+06:06` | 366s | 279m | 1275m |
| 6 | `1071` | Pl. Joaquim Galí - 1071 | `+07:57` | 477s | 413m | 1688m |
| 7 | `1107` | Miquel Biada - 1107 | `+09:22` | 562s | 290m | 1978m |
| 8 | `1060` | Pl. Tereses - 1060 | `+11:23` | 683s | 460m | 2438m |
| 9 | `1061` | Sant Isidor - 1061 | `+13:01` | 781s | 350m | 2787m |
| 10 | `1062` | Parc Central - 1062 | `+14:43` | 883s | 370m | 3157m |
| 11 | `1108` | Carles Padrós - 1108 | `+15:52` | 952s | 211m | 3368m |
| 12 | `1042` | Desviament - 1042 | `+17:14` | 1034s | 274m | 3642m |
| 13 | `1109` | Figuera Major - 1109 | `+18:16` | 1096s | 179m | 3821m |
| 14 | `1096` | Sant Oleguer - 1096 | `+19:25` | 1165s | 212m | 4033m |
| 15 | `1070` | CAP Cirera-Molins - 1070 | `+21:08` | 1268s | 375m | 4408m |
| 16 | `1099` | Cirera - 1099 | `+22:27` | 1347s | 257m | 4665m |
| 17 | `1001` | Hospital de Mataró - 1001 | `+25:24` | 1524s | 732m | 5397m |

---

## Detailed Line Profile: Line 5 — Rodalies-Hospital de Mataró

- **Line ID**: `5`
- **Public Name**: `Rodalies-Hospital de Mataró`
- **Branding Color**: `#00ea00`
- **Agency**: Mataró Bus (CTSA / Avanza)
- **Number of Directions / Routes**: 2

### Line 5 Direction 0: [Path ID 11] Rodalies - Hospital

- **Route Name**: `Rodalies - Hospital`
- **Origin Terminal**: `[1058] Rodalies - 1058`
- **Destination Terminal**: `[1073] Hospital de Mataró - 1073`
- **Total Stops**: 9
- **Polyline Coordinates**: 537 points
- **Route Distance**: **3.74 km** (3737 meters)
- **Cumulative Travel Time**: **~14 minutes** (855 seconds)

#### Authoritative Departure Matrices (First Stop Departures)

##### Feiners (69 trips / day)
- **Operating Span**: `05:41` → `22:32`
```json
[
  "05:41",
  "06:01",
  "06:19",
  "06:37",
  "06:55",
  "07:13",
  "07:27",
  "07:41",
  "07:54",
  "08:07",
  "08:20",
  "08:34",
  "08:49",
  "09:03",
  "09:18",
  "09:34",
  "09:49",
  "10:04",
  "10:18",
  "10:33",
  "10:48",
  "11:03",
  "11:18",
  "11:33",
  "11:48",
  "12:03",
  "12:18",
  "12:32",
  "12:47",
  "13:02",
  "13:16",
  "13:31",
  "13:46",
  "14:00",
  "14:15",
  "14:30",
  "14:44",
  "14:59",
  "15:14",
  "15:29",
  "15:43",
  "15:58",
  "16:13",
  "16:27",
  "16:42",
  "16:57",
  "17:12",
  "17:26",
  "17:41",
  "17:56",
  "18:10",
  "18:25",
  "18:40",
  "18:54",
  "19:09",
  "19:24",
  "19:38",
  "19:53",
  "20:08",
  "20:23",
  "20:38",
  "20:52",
  "21:05",
  "21:18",
  "21:30",
  "21:42",
  "21:55",
  "22:19",
  "22:32"
]
```

##### Dissabtes (51 trips / day)
- **Operating Span**: `07:20` → `21:56`
```json
[
  "07:20",
  "07:36",
  "07:56",
  "08:15",
  "08:37",
  "08:59",
  "09:21",
  "09:42",
  "10:04",
  "10:25",
  "10:47",
  "11:08",
  "11:29",
  "11:50",
  "12:12",
  "12:34",
  "12:55",
  "13:17",
  "13:39",
  "14:01",
  "14:22",
  "14:43",
  "15:03",
  "15:23",
  "15:36",
  "15:50",
  "16:04",
  "16:17",
  "16:31",
  "16:45",
  "16:59",
  "17:14",
  "17:28",
  "17:43",
  "17:57",
  "18:12",
  "18:28",
  "18:44",
  "18:59",
  "19:14",
  "19:29",
  "19:44",
  "20:00",
  "20:16",
  "20:32",
  "20:48",
  "21:02",
  "21:16",
  "21:30",
  "21:40",
  "21:56"
]
```

##### Diumenges i Festius (29 trips / day)
- **Operating Span**: `08:52` → `21:19`
```json
[
  "08:52",
  "09:30",
  "10:09",
  "10:48",
  "11:28",
  "12:08",
  "12:48",
  "13:28",
  "14:08",
  "14:48",
  "15:09",
  "15:29",
  "15:49",
  "16:09",
  "16:28",
  "16:48",
  "17:08",
  "17:28",
  "17:49",
  "18:10",
  "18:32",
  "18:53",
  "19:14",
  "19:35",
  "19:56",
  "20:17",
  "20:39",
  "21:00",
  "21:19"
]
```

#### Stop Sequence & Topographic Passing Offsets

| Seq | Stop ID | Stop Name | Offset (Min:Sec) | Cumulative Sec | Segment (m) | Total Dist (m) |
|---|---|---|---|---|---|---|
| 1 | `1058` | Rodalies - 1058 | `+00:00` | 0s | 0m | 0m |
| 2 | `1059` | Lepant - 1059 | `+01:31` | 91s | 317m | 317m |
| 3 | `1060` | Pl. Tereses - 1060 | `+03:00` | 180s | 306m | 622m |
| 4 | `1117` | Jaume Isern - 1117 | `+04:38` | 278s | 351m | 973m |
| 5 | `1118` | Pl. Granollers - 1118 | `+06:19` | 379s | 367m | 1340m |
| 6 | `1119` | Via Europa - 1119 | `+07:45` | 465s | 294m | 1634m |
| 7 | `1120` | Pl. Itàlia - 1120 | `+09:39` | 579s | 424m | 2058m |
| 8 | `1121` | Pl. França - 1121 | `+11:11` | 671s | 323m | 2381m |
| 9 | `1073` | Hospital de Mataró - 1073 | `+14:15` | 855s | 765m | 3145m |

---

### Line 5 Direction 1: [Path ID 12] Hospital - Rodalies

- **Route Name**: `Hospital - Rodalies`
- **Origin Terminal**: `[1073] Hospital de Mataró - 1073`
- **Destination Terminal**: `[1058] Rodalies - 1058`
- **Total Stops**: 11
- **Polyline Coordinates**: 691 points
- **Route Distance**: **4.18 km** (4177 meters)
- **Cumulative Travel Time**: **~16 minutes** (935 seconds)

#### Authoritative Departure Matrices (First Stop Departures)

##### Feiners (68 trips / day)
- **Operating Span**: `05:58` → `22:12`
```json
[
  "05:58",
  "06:16",
  "06:34",
  "06:52",
  "07:09",
  "07:21",
  "07:31",
  "07:44",
  "07:58",
  "08:11",
  "08:25",
  "08:39",
  "08:54",
  "09:09",
  "09:24",
  "09:39",
  "09:54",
  "10:09",
  "10:24",
  "10:38",
  "10:53",
  "11:08",
  "11:23",
  "11:38",
  "11:53",
  "12:08",
  "12:23",
  "12:38",
  "12:52",
  "13:07",
  "13:22",
  "13:36",
  "13:51",
  "14:06",
  "14:20",
  "14:35",
  "14:50",
  "15:04",
  "15:19",
  "15:34",
  "15:49",
  "16:03",
  "16:18",
  "16:33",
  "16:47",
  "17:02",
  "17:17",
  "17:32",
  "17:46",
  "18:01",
  "18:16",
  "18:30",
  "18:45",
  "19:00",
  "19:14",
  "19:29",
  "19:44",
  "19:59",
  "20:14",
  "20:29",
  "20:43",
  "20:56",
  "21:09",
  "21:22",
  "21:35",
  "21:47",
  "21:59",
  "22:12"
]
```

##### Dissabtes (50 trips / day)
- **Operating Span**: `07:35` → `22:14`
```json
[
  "07:35",
  "07:54",
  "08:15",
  "08:36",
  "08:58",
  "09:19",
  "09:41",
  "10:03",
  "10:25",
  "10:46",
  "11:07",
  "11:28",
  "11:49",
  "12:10",
  "12:32",
  "12:54",
  "13:16",
  "13:38",
  "14:00",
  "14:21",
  "14:42",
  "15:03",
  "15:24",
  "15:43",
  "15:56",
  "16:10",
  "16:24",
  "16:37",
  "16:51",
  "17:05",
  "17:20",
  "17:34",
  "17:49",
  "18:04",
  "18:20",
  "18:36",
  "18:51",
  "19:06",
  "19:21",
  "19:37",
  "19:52",
  "20:08",
  "20:25",
  "20:41",
  "20:55",
  "21:09",
  "21:21",
  "21:35",
  "21:54",
  "22:14"
]
```

##### Diumenges i Festius (30 trips / day)
- **Operating Span**: `08:32` → `21:22`
```json
[
  "08:32",
  "09:10",
  "09:48",
  "10:28",
  "11:07",
  "11:47",
  "12:27",
  "13:07",
  "13:47",
  "14:31",
  "14:52",
  "15:08",
  "15:28",
  "15:48",
  "16:08",
  "16:28",
  "16:48",
  "17:08",
  "17:28",
  "17:49",
  "18:11",
  "18:32",
  "18:54",
  "19:14",
  "19:35",
  "19:57",
  "20:18",
  "20:40",
  "21:01",
  "21:22"
]
```

#### Stop Sequence & Topographic Passing Offsets

| Seq | Stop ID | Stop Name | Offset (Min:Sec) | Cumulative Sec | Segment (m) | Total Dist (m) |
|---|---|---|---|---|---|---|
| 1 | `1073` | Hospital de Mataró - 1073 | `+00:00` | 0s | 0m | 0m |
| 2 | `1002` | Mataró Parc - 1002 | `+01:26` | 86s | 292m | 292m |
| 3 | `1112` | Pl. França - 1112 | `+03:58` | 238s | 612m | 903m |
| 4 | `1113` | Pl. Itàlia - 1113 | `+05:17` | 317s | 257m | 1160m |
| 5 | `1114` | Via Europa - 1114 | `+07:16` | 436s | 455m | 1615m |
| 6 | `1115` | Pl. Granollers - 1115 | `+08:40` | 520s | 281m | 1896m |
| 7 | `1168` | CAP Prim - 1168 | `+09:57` | 597s | 249m | 2145m |
| 8 | `1166` | Ronda de la República - 1166 | `+10:59` | 659s | 179m | 2324m |
| 9 | `1056` | Pl. Doctor Fleming - 1056 | `+13:09` | 789s | 502m | 2826m |
| 10 | `1057` | Ronda Barceló - 1057 | `+14:28` | 868s | 258m | 3084m |
| 11 | `1058` | Rodalies - 1058 | `+15:35` | 935s | 205m | 3289m |

---

## Detailed Line Profile: Line 6 — Institut Català Salut - Ctra. de Mata

- **Line ID**: `6`
- **Public Name**: `Institut Català Salut - Ctra. de Mata`
- **Branding Color**: `#febf01`
- **Agency**: Mataró Bus (CTSA / Avanza)
- **Number of Directions / Routes**: 2

### Line 6 Direction 0: [Path ID 11] Ctra. Mata - Institut Català Salut

- **Route Name**: `Ctra. Mata - Institut Català Salut`
- **Origin Terminal**: `[1122] Ctra. Mata - 1122`
- **Destination Terminal**: `[1051] Institut Català Salut - 1051`
- **Total Stops**: 11
- **Polyline Coordinates**: 248 points
- **Route Distance**: **3.19 km** (3186 meters)
- **Cumulative Travel Time**: **~14 minutes** (865 seconds)

#### Authoritative Departure Matrices (First Stop Departures)

##### Feiners (64 trips / day)
- **Operating Span**: `06:00` → `21:47`
```json
[
  "06:00",
  "06:42",
  "07:10",
  "07:22",
  "07:34",
  "07:46",
  "08:00",
  "08:11",
  "08:24",
  "08:37",
  "08:49",
  "09:02",
  "09:15",
  "09:29",
  "09:42",
  "09:54",
  "10:07",
  "10:20",
  "10:33",
  "10:45",
  "10:58",
  "11:11",
  "11:24",
  "11:36",
  "11:49",
  "12:02",
  "12:15",
  "12:27",
  "12:40",
  "12:53",
  "13:06",
  "13:19",
  "13:32",
  "13:44",
  "13:57",
  "14:10",
  "14:20",
  "14:33",
  "14:50",
  "14:57",
  "15:07",
  "15:24",
  "15:40",
  "15:56",
  "16:13",
  "16:29",
  "16:46",
  "17:03",
  "17:21",
  "17:39",
  "17:57",
  "18:15",
  "18:33",
  "18:51",
  "19:08",
  "19:25",
  "19:42",
  "19:59",
  "20:15",
  "20:32",
  "20:48",
  "21:03",
  "21:19",
  "21:47"
]
```

##### Dissabtes (26 trips / day)
- **Operating Span**: `07:16` → `21:24`
```json
[
  "07:16",
  "08:02",
  "08:27",
  "08:51",
  "09:15",
  "09:40",
  "10:04",
  "10:29",
  "10:53",
  "11:18",
  "11:42",
  "12:07",
  "12:32",
  "12:57",
  "13:23",
  "13:52",
  "14:14",
  "15:03",
  "15:50",
  "16:37",
  "17:24",
  "18:12",
  "19:01",
  "19:50",
  "20:39",
  "21:24"
]
```

##### Diumenges i Festius (12 trips / day)
- **Operating Span**: `14:00` → `22:03`
```json
[
  "14:00",
  "14:44",
  "15:28",
  "16:12",
  "16:56",
  "17:40",
  "18:25",
  "19:10",
  "19:55",
  "20:40",
  "21:22",
  "22:03"
]
```

#### Stop Sequence & Topographic Passing Offsets

| Seq | Stop ID | Stop Name | Offset (Min:Sec) | Cumulative Sec | Segment (m) | Total Dist (m) |
|---|---|---|---|---|---|---|
| 1 | `1122` | Ctra. Mata - 1122 | `+00:00` | 0s | 0m | 0m |
| 2 | `1123` | Alfons X - 1123 | `+01:26` | 86s | 292m | 292m |
| 3 | `1010` | Cabanellas - 1010 | `+02:38` | 158s | 226m | 518m |
| 4 | `1011` | Parc Central - 1011 | `+04:19` | 259s | 364m | 882m |
| 5 | `1124` | Geganta - 1124 | `+05:48` | 348s | 309m | 1190m |
| 6 | `1167` | Pl. Granollers - 1167 | `+07:22` | 442s | 333m | 1523m |
| 7 | `1126` | Salesians - 1126 | `+09:08` | 548s | 388m | 1911m |
| 8 | `1127` | Puig i Cadafalch - 1127 | `+10:31` | 631s | 279m | 2191m |
| 9 | `1128` | Parc Cerdanyola - 1128 | `+11:38` | 698s | 200m | 2391m |
| 10 | `1050` | Gatassa - 1050 | `+12:53` | 773s | 239m | 2629m |
| 11 | `1051` | Institut Català Salut - 1051 | `+14:25` | 865s | 325m | 2954m |

---

### Line 6 Direction 1: [Path ID 12] Institut Català Salut - Ctra. Mata

- **Route Name**: `Institut Català Salut - Ctra. Mata`
- **Origin Terminal**: `[1051] Institut Català Salut - 1051`
- **Destination Terminal**: `[1122] Ctra. Mata - 1122`
- **Total Stops**: 12
- **Polyline Coordinates**: 420 points
- **Route Distance**: **4.09 km** (4090 meters)
- **Cumulative Travel Time**: **~17 minutes** (999 seconds)

#### Authoritative Departure Matrices (First Stop Departures)

##### Feiners (40 trips / day)
- **Operating Span**: `06:51` → `21:53`
```json
[
  "06:51",
  "07:17",
  "07:34",
  "07:59",
  "08:19",
  "08:42",
  "09:04",
  "09:26",
  "09:48",
  "10:10",
  "10:33",
  "10:55",
  "11:18",
  "11:40",
  "12:03",
  "12:26",
  "12:49",
  "13:12",
  "13:35",
  "13:58",
  "14:20",
  "14:43",
  "15:05",
  "15:28",
  "15:49",
  "16:12",
  "16:33",
  "16:56",
  "17:18",
  "17:41",
  "18:05",
  "18:28",
  "18:52",
  "19:15",
  "19:39",
  "20:02",
  "20:26",
  "20:48",
  "21:11",
  "21:53"
]
```

##### Dissabtes (26 trips / day)
- **Operating Span**: `07:34` → `21:43`
```json
[
  "07:34",
  "07:54",
  "08:20",
  "08:45",
  "09:09",
  "09:34",
  "09:59",
  "10:23",
  "10:48",
  "11:12",
  "11:37",
  "12:02",
  "12:27",
  "12:53",
  "13:19",
  "13:44",
  "14:34",
  "15:22",
  "16:09",
  "16:56",
  "17:43",
  "18:32",
  "19:21",
  "20:10",
  "20:57",
  "21:43"
]
```

##### Diumenges i Festius (12 trips / day)
- **Operating Span**: `14:17` → `22:17`
```json
[
  "14:17",
  "15:01",
  "15:45",
  "16:29",
  "17:13",
  "17:57",
  "18:42",
  "19:27",
  "20:12",
  "20:55",
  "21:36",
  "22:17"
]
```

#### Stop Sequence & Topographic Passing Offsets

| Seq | Stop ID | Stop Name | Offset (Min:Sec) | Cumulative Sec | Segment (m) | Total Dist (m) |
|---|---|---|---|---|---|---|
| 1 | `1051` | Institut Català Salut - 1051 | `+00:00` | 0s | 0m | 0m |
| 2 | `1149` | Biblioteca Pompeu Fabra - 1149 | `+01:48` | 108s | 401m | 401m |
| 3 | `1129` | Geganta - 1129 | `+04:00` | 240s | 511m | 912m |
| 4 | `1062` | Parc Central - 1062 | `+05:26` | 326s | 294m | 1206m |
| 5 | `1108` | Carles Padrós - 1108 | `+06:35` | 395s | 211m | 1417m |
| 6 | `1131` | Institut A. Satorras - 1131 | `+08:00` | 480s | 287m | 1704m |
| 7 | `1004` | CAP Cirera-Molins - 1004 | `+09:16` | 556s | 244m | 1949m |
| 8 | `1005` | Sant Oleguer - 1005 | `+10:48` | 648s | 321m | 2270m |
| 9 | `1006` | Caputxins - 1006 | `+12:42` | 762s | 425m | 2695m |
| 10 | `1080` | Franck Marshall - 1080 | `+14:08` | 848s | 296m | 2991m |
| 11 | `1081` | Rafael Estrany - 1081 | `+15:31` | 931s | 276m | 3267m |
| 12 | `1122` | Ctra. Mata - 1122 | `+16:39` | 999s | 210m | 3477m |

---

## Detailed Line Profile: Line 7 — Pl. Tereses - Cerdanyola

- **Line ID**: `7`
- **Public Name**: `Pl. Tereses - Cerdanyola`
- **Branding Color**: `#80ffff`
- **Agency**: Mataró Bus (CTSA / Avanza)
- **Number of Directions / Routes**: 2

### Line 7 Direction 0: [Path ID 12] Pl. Tereses - Parc de Cerdanyola

- **Route Name**: `Pl. Tereses - Parc de Cerdanyola`
- **Origin Terminal**: `[1060] Pl. Tereses - 1060`
- **Destination Terminal**: `[1128] Parc Cerdanyola - 1128`
- **Total Stops**: 6
- **Polyline Coordinates**: 166 points
- **Route Distance**: **1.69 km** (1690 meters)
- **Cumulative Travel Time**: **~7 minutes** (442 seconds)

#### Authoritative Departure Matrices (First Stop Departures)

##### Feiners (51 trips / day)
- **Operating Span**: `07:36` → `21:37`
```json
[
  "07:36",
  "08:03",
  "08:24",
  "08:51",
  "09:19",
  "09:40",
  "10:01",
  "10:29",
  "10:50",
  "11:11",
  "11:39",
  "12:00",
  "12:21",
  "12:49",
  "13:11",
  "13:33",
  "14:02",
  "14:23",
  "14:49",
  "15:14",
  "15:27",
  "15:39",
  "15:52",
  "16:04",
  "16:17",
  "16:29",
  "16:42",
  "16:54",
  "17:07",
  "17:20",
  "17:33",
  "17:46",
  "17:59",
  "18:12",
  "18:25",
  "18:38",
  "18:51",
  "19:04",
  "19:17",
  "19:29",
  "19:42",
  "19:54",
  "20:07",
  "20:19",
  "20:31",
  "20:42",
  "20:53",
  "21:04",
  "21:15",
  "21:26",
  "21:37"
]
```

##### Dissabtes (37 trips / day)
- **Operating Span**: `08:10` → `21:37`
```json
[
  "08:10",
  "08:30",
  "08:57",
  "09:17",
  "09:37",
  "10:04",
  "10:24",
  "10:44",
  "11:11",
  "11:31",
  "11:51",
  "12:18",
  "12:38",
  "12:58",
  "13:25",
  "13:45",
  "14:05",
  "14:32",
  "14:52",
  "15:12",
  "15:39",
  "15:59",
  "16:19",
  "16:46",
  "17:07",
  "17:28",
  "17:56",
  "18:17",
  "18:38",
  "19:06",
  "19:27",
  "19:47",
  "20:14",
  "20:34",
  "20:53",
  "21:17",
  "21:37"
]
```

##### Diumenges i Festius (35 trips / day)
- **Operating Span**: `08:30` → `21:18`
```json
[
  "08:30",
  "08:57",
  "09:17",
  "09:37",
  "10:04",
  "10:24",
  "10:44",
  "11:11",
  "11:31",
  "11:51",
  "12:18",
  "12:38",
  "12:58",
  "13:25",
  "13:45",
  "14:05",
  "14:32",
  "14:52",
  "15:12",
  "15:39",
  "15:59",
  "16:19",
  "16:46",
  "17:07",
  "17:28",
  "17:56",
  "18:17",
  "18:38",
  "19:06",
  "19:27",
  "19:47",
  "20:14",
  "20:34",
  "20:53",
  "21:18"
]
```

#### Stop Sequence & Topographic Passing Offsets

| Seq | Stop ID | Stop Name | Offset (Min:Sec) | Cumulative Sec | Segment (m) | Total Dist (m) |
|---|---|---|---|---|---|---|
| 1 | `1060` | Pl. Tereses - 1060 | `+00:00` | 0s | 0m | 0m |
| 2 | `1117` | Jaume Isern - 1117 | `+01:38` | 98s | 351m | 351m |
| 3 | `1105` | Pl.Granollers - 1105 | `+03:22` | 202s | 379m | 729m |
| 4 | `1126` | Salesians - 1126 | `+04:53` | 293s | 315m | 1044m |
| 5 | `1127` | Puig i Cadafalch - 1127 | `+06:16` | 376s | 279m | 1323m |
| 6 | `1128` | Parc Cerdanyola - 1128 | `+07:22` | 442s | 200m | 1523m |

---

### Line 7 Direction 1: [Path ID 11] Parc de Cerdanyola - Pl. Tereses

- **Route Name**: `Parc de Cerdanyola - Pl. Tereses`
- **Origin Terminal**: `[1128] Parc Cerdanyola - 1128`
- **Destination Terminal**: `[1060] Pl. Tereses - 1060`
- **Total Stops**: 5
- **Polyline Coordinates**: 207 points
- **Route Distance**: **1.90 km** (1899 meters)
- **Cumulative Travel Time**: **~7 minutes** (426 seconds)

#### Authoritative Departure Matrices (First Stop Departures)

##### Feiners (51 trips / day)
- **Operating Span**: `07:25` → `21:35`
```json
[
  "07:25",
  "07:46",
  "08:13",
  "08:37",
  "09:01",
  "09:29",
  "09:50",
  "10:11",
  "10:39",
  "11:00",
  "11:21",
  "11:49",
  "12:10",
  "12:31",
  "13:00",
  "13:22",
  "13:44",
  "14:12",
  "14:36",
  "14:59",
  "15:24",
  "15:37",
  "15:49",
  "16:02",
  "16:14",
  "16:27",
  "16:39",
  "16:52",
  "17:05",
  "17:18",
  "17:31",
  "17:44",
  "17:57",
  "18:10",
  "18:23",
  "18:36",
  "18:49",
  "19:02",
  "19:14",
  "19:27",
  "19:39",
  "19:52",
  "20:04",
  "20:16",
  "20:28",
  "20:39",
  "20:50",
  "21:01",
  "21:12",
  "21:23",
  "21:35"
]
```

##### Dissabtes (37 trips / day)
- **Operating Span**: `08:19` → `21:46`
```json
[
  "08:19",
  "08:39",
  "09:06",
  "09:26",
  "09:46",
  "10:13",
  "10:33",
  "10:53",
  "11:20",
  "11:40",
  "12:00",
  "12:27",
  "12:47",
  "13:07",
  "13:34",
  "13:54",
  "14:14",
  "14:41",
  "15:01",
  "15:21",
  "15:48",
  "16:08",
  "16:28",
  "16:55",
  "17:16",
  "17:37",
  "18:05",
  "18:26",
  "18:47",
  "19:15",
  "19:36",
  "19:56",
  "20:23",
  "20:43",
  "21:02",
  "21:27",
  "21:46"
]
```

##### Diumenges i Festius (35 trips / day)
- **Operating Span**: `08:39` → `21:27`
```json
[
  "08:39",
  "09:06",
  "09:26",
  "09:46",
  "10:13",
  "10:33",
  "10:53",
  "11:20",
  "11:40",
  "12:00",
  "12:27",
  "12:47",
  "13:07",
  "13:34",
  "13:54",
  "14:14",
  "14:41",
  "15:01",
  "15:21",
  "15:48",
  "16:08",
  "16:28",
  "16:55",
  "17:16",
  "17:37",
  "18:05",
  "18:26",
  "18:47",
  "19:15",
  "19:36",
  "19:56",
  "20:23",
  "20:43",
  "21:02",
  "21:27"
]
```

#### Stop Sequence & Topographic Passing Offsets

| Seq | Stop ID | Stop Name | Offset (Min:Sec) | Cumulative Sec | Segment (m) | Total Dist (m) |
|---|---|---|---|---|---|---|
| 1 | `1128` | Parc Cerdanyola - 1128 | `+00:00` | 0s | 0m | 0m |
| 2 | `1050` | Gatassa - 1050 | `+01:15` | 75s | 239m | 239m |
| 3 | `1179` | Institut Català Salut - 1179 | `+03:03` | 183s | 398m | 637m |
| 4 | `1107` | Miquel Biada - 1107 | `+05:05` | 305s | 466m | 1103m |
| 5 | `1060` | Pl. Tereses - 1060 | `+07:06` | 426s | 460m | 1563m |

---

## Detailed Line Profile: Line 8 — Rodalies - Galícia

- **Line ID**: `8`
- **Public Name**: `Rodalies - Galícia`
- **Branding Color**: `#008040`
- **Agency**: Mataró Bus (CTSA / Avanza)
- **Number of Directions / Routes**: 2

### Line 8 Direction 0: [Path ID 11] Galícia - Rodalies

- **Route Name**: `Galícia - Rodalies`
- **Origin Terminal**: `[1132] Galícia - 1132`
- **Destination Terminal**: `[1058] Rodalies - 1058`
- **Total Stops**: 13
- **Polyline Coordinates**: 417 points
- **Route Distance**: **4.07 km** (4074 meters)
- **Cumulative Travel Time**: **~16 minutes** (986 seconds)

#### Authoritative Departure Matrices (First Stop Departures)

##### Feiners (43 trips / day)
- **Operating Span**: `06:05` → `22:11`
```json
[
  "06:05",
  "06:27",
  "06:48",
  "07:07",
  "07:26",
  "07:46",
  "08:09",
  "08:33",
  "08:57",
  "09:21",
  "09:44",
  "10:07",
  "10:30",
  "10:53",
  "11:16",
  "11:39",
  "12:02",
  "12:26",
  "12:50",
  "13:13",
  "13:36",
  "14:00",
  "14:24",
  "14:48",
  "15:12",
  "15:36",
  "16:00",
  "16:24",
  "16:48",
  "17:13",
  "17:38",
  "18:02",
  "18:27",
  "18:52",
  "19:16",
  "19:40",
  "20:04",
  "20:26",
  "20:48",
  "21:10",
  "21:31",
  "21:51",
  "22:11"
]
```

##### Dissabtes (14 trips / day)
- **Operating Span**: `07:00` → `21:31`
```json
[
  "07:00",
  "07:59",
  "09:03",
  "10:09",
  "11:15",
  "12:23",
  "13:33",
  "14:39",
  "15:45",
  "16:51",
  "18:00",
  "19:12",
  "20:24",
  "21:31"
]
```

##### Diumenges i Festius (7 trips / day)
- **Operating Span**: `14:45` → `21:13`
```json
[
  "14:45",
  "15:49",
  "16:53",
  "17:57",
  "19:02",
  "20:08",
  "21:13"
]
```

#### Stop Sequence & Topographic Passing Offsets

| Seq | Stop ID | Stop Name | Offset (Min:Sec) | Cumulative Sec | Segment (m) | Total Dist (m) |
|---|---|---|---|---|---|---|
| 1 | `1132` | Galícia - 1132 | `+00:00` | 0s | 0m | 0m |
| 2 | `1116` | Roca Blanca - 1116 | `+01:15` | 75s | 242m | 242m |
| 3 | `1136` | Tarragona - 1136 | `+02:21` | 141s | 194m | 435m |
| 4 | `1045` | Pl. Gatassa - 1045 | `+03:24` | 204s | 184m | 619m |
| 5 | `1128` | Parc Cerdanyola - 1128 | `+04:36` | 276s | 223m | 843m |
| 6 | `1050` | Gatassa - 1050 | `+05:50` | 350s | 239m | 1081m |
| 7 | `1051` | Institut Català Salut - 1051 | `+07:23` | 443s | 325m | 1406m |
| 8 | `1052` | Edif. Vidre - TecnoCampus - 1052 | `+09:26` | 566s | 469m | 1876m |
| 9 | `1161` | Porta Laietana-TecnoCampus - 1161 | `+11:07` | 667s | 365m | 2241m |
| 10 | `1055` | Jutjats - 1055 | `+12:59` | 779s | 417m | 2658m |
| 11 | `1056` | Pl. Doctor Fleming - 1056 | `+14:00` | 840s | 173m | 2831m |
| 12 | `1057` | Ronda Barceló - 1057 | `+15:19` | 919s | 258m | 3089m |
| 13 | `1058` | Rodalies - 1058 | `+16:26` | 986s | 205m | 3294m |

---

### Line 8 Direction 1: [Path ID 12] Rodalies - Galícia

- **Route Name**: `Rodalies - Galícia`
- **Origin Terminal**: `[1058] Rodalies - 1058`
- **Destination Terminal**: `[1132] Galícia - 1132`
- **Total Stops**: 25
- **Polyline Coordinates**: 490 points
- **Route Distance**: **6.83 km** (6828 meters)
- **Cumulative Travel Time**: **~31 minutes** (1851 seconds)

#### Authoritative Departure Matrices (First Stop Departures)

##### Feiners (27 trips / day)
- **Operating Span**: `06:23` → `21:22`
```json
[
  "06:23",
  "07:25",
  "07:56",
  "08:28",
  "09:00",
  "09:33",
  "10:06",
  "10:39",
  "11:12",
  "11:45",
  "12:19",
  "12:54",
  "13:29",
  "14:04",
  "14:38",
  "15:11",
  "15:44",
  "16:16",
  "16:49",
  "17:22",
  "17:55",
  "18:30",
  "19:05",
  "19:40",
  "20:15",
  "20:49",
  "21:22"
]
```

##### Dissabtes (14 trips / day)
- **Operating Span**: `07:20` → `21:55`
```json
[
  "07:20",
  "08:23",
  "09:28",
  "10:34",
  "11:40",
  "12:48",
  "13:58",
  "15:04",
  "16:10",
  "17:17",
  "18:26",
  "19:38",
  "20:49",
  "21:55"
]
```

##### Diumenges i Festius (8 trips / day)
- **Operating Span**: `14:04` → `21:35`
```json
[
  "14:04",
  "15:08",
  "16:12",
  "17:16",
  "18:20",
  "19:26",
  "20:32",
  "21:35"
]
```

#### Stop Sequence & Topographic Passing Offsets

| Seq | Stop ID | Stop Name | Offset (Min:Sec) | Cumulative Sec | Segment (m) | Total Dist (m) |
|---|---|---|---|---|---|---|
| 1 | `1058` | Rodalies - 1058 | `+00:00` | 0s | 0m | 0m |
| 2 | `1087` | La Rambla - 1087 | `+01:51` | 111s | 412m | 412m |
| 3 | `1088` | Sant Joan - 1088 | `+03:35` | 215s | 381m | 792m |
| 4 | `1089` | Can Marfà - 1089 | `+04:54` | 294s | 260m | 1052m |
| 5 | `1135` | Floridablanca - 1135 | `+06:06` | 366s | 224m | 1276m |
| 6 | `1138` | Pl. Fiveller - 1138 | `+07:23` | 443s | 251m | 1527m |
| 7 | `1139` | La Coma - 1139 | `+08:50` | 530s | 296m | 1823m |
| 8 | `1140` | La Riera - 1140 | `+10:18` | 618s | 306m | 2128m |
| 9 | `1011` | Parc Central - 1011 | `+11:52` | 712s | 331m | 2459m |
| 10 | `1124` | Geganta - 1124 | `+13:22` | 802s | 309m | 2768m |
| 11 | `1167` | Pl. Granollers - 1167 | `+14:56` | 896s | 333m | 3101m |
| 12 | `1143` | O´ Donnell - 1143 | `+15:53` | 953s | 155m | 3255m |
| 13 | `1144` | Biblioteca Pompeu Fabra - 1144 | `+17:16` | 1036s | 278m | 3533m |
| 14 | `1022` | Institut Català Salut - 1022 | `+18:21` | 1101s | 192m | 3725m |
| 15 | `1023` | Gatassa - 1023 | `+19:32` | 1172s | 221m | 3947m |
| 16 | `1145` | Parc Cerdanyola - 1145 | `+20:49` | 1249s | 248m | 4194m |
| 17 | `1046` | Cerdanyola - 1046 | `+21:57` | 1317s | 206m | 4400m |
| 18 | `1026` | Ronda Cerdanya - 1026 | `+22:50` | 1370s | 135m | 4535m |
| 19 | `1027` | Vallès - 1027 | `+23:50` | 1430s | 171m | 4706m |
| 20 | `1028` | Ample - 1028 | `+24:42` | 1482s | 126m | 4831m |
| 21 | `1029` | Roca Blanca - 1029 | `+26:01` | 1561s | 263m | 5095m |
| 22 | `1030` | Escola El Turó - 1030 | `+27:38` | 1658s | 343m | 5438m |
| 23 | `1093` | Euskadi - 1093 | `+28:29` | 1709s | 126m | 5564m |
| 24 | `1133` | Poliesportiu Euskadi - 1133 | `+29:18` | 1758s | 116m | 5680m |
| 25 | `1132` | Galícia - 1132 | `+30:51` | 1851s | 326m | 6006m |

---

## Authoritative Codebase Data Structure Schema

To cleanly integrate these exact official departure tables and eliminate synthetic headway loops across the codebase, the following static dataset structure in `src/data/mataroAuthoritativeSchedules.js` (or `src/mataroStaticData.js`) is recommended:

```javascript
/**
 * Authoritative Timetables for Mataró Bus Lines 1–8
 * Source: Avanza / CTSA Mataró Urban Network
 */

const MATARO_EXACT_SCHEDULES = {
  // Line ID
  "8": {
    lineId: "8",
    name: "Rodalies - Galícia",
    directions: {
      // Path ID 11: Galícia -> Rodalies (Direction 0)
      "11": {
        dirId: "0",
        name: "Galícia - Rodalies",
        originStopId: "1132",
        terminalStopId: "1058",
        travelSec: 986,
        departures: {
          weekday: [
            "06:05", "06:27", "06:48", "07:07", "07:26", "07:46", "08:09", "08:33", "08:57",
            "09:21", "09:44", "10:07", "10:30", "10:53", "11:16", "11:39", "12:02", "12:26",
            "12:50", "13:13", "13:36", "14:00", "14:24", "14:48", "15:12", "15:36", "16:00",
            "16:24", "16:48", "17:13", "17:38", "18:02", "18:27", "18:52", "19:16", "19:40",
            "20:04", "20:26", "20:48", "21:10", "21:31", "21:51", "22:11"
          ],
          saturday: [
            "07:00", "07:59", "09:03", "10:09", "11:15", "12:23", "13:33", "14:39", "15:45",
            "16:51", "18:00", "19:12", "20:24", "21:31"
          ],
          sunday: [
            "14:45", "15:49", "16:53", "17:57", "19:02", "20:08", "21:13"
          ]
        }
      },
      // Path ID 12: Rodalies -> Galícia (Direction 1)
      "12": {
        dirId: "1",
        name: "Rodalies - Galícia",
        originStopId: "1058",
        terminalStopId: "1132",
        travelSec: 1851,
        departures: {
          weekday: [
            "06:23", "07:25", "07:56", "08:28", "09:00", "09:33", "10:06", "10:39", "11:12",
            "11:45", "12:19", "12:54", "13:29", "14:04", "14:38", "15:11", "15:44", "16:16",
            "16:49", "17:22", "17:55", "18:30", "19:05", "19:40", "20:15", "20:49", "21:22"
          ],
          saturday: [
            "07:20", "08:23", "09:28", "10:34", "11:40", "12:48", "13:58", "15:04", "16:10",
            "17:17", "18:26", "19:38", "20:49", "21:55"
          ],
          sunday: [
            "14:04", "15:08", "16:12", "17:16", "18:20", "19:26", "20:32", "21:35"
          ]
        }
      }
    }
  }
};
```

### Ingestion & Processing Pipeline in `src/mataroTracker.js`

1. **Exact Timetable Lookup**:
   When queried for stop departures (`getStopDepartures(stopId, lineId)`), determine `dayTypeToday` and `dayTypeTomorrow` via `calendarEngine` or `timeUtils`.
2. **Stop Travel Time Computation**:
   Calculate the exact travel offset from route origin using `scheduleSynthesizer.estimateStopTravelTimes(routeStops)`.
3. **Passing Departure Synthesis**:
   Iterate through `departures[dayType]`, adding `travelSec` to each base trip start time:
   `passingSec = baseDepSec + travelSec`
4. **Filtering & Deduplication**:
   - Filter departures matching `nowSec - 60 <= passingSec`.
   - Deduplicate against live SIRI departures within a ±3 minute window.
   - If fewer than 5 trips remain today, seamlessly append tomorrow morning's trips using tomorrow's official first trip matrix.

---
