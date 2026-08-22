# Spec Miner Handoff Report: Mataró Bus Authoritative Timetables (Lines 1–8)

**Agent Archetype**: Specification Miner  
**Working Directory**: `h:/Coding/C10Data/.agents/spec_miner_mataro_timetables/`  
**Target Milestone**: Spec Mining — Mataró Urban Lines 1–8 Official Schedules & Stop Sequences  
**Handoff Type**: Hard (Task Complete)

---

## 1. Observation

1. **Current Codebase Headway Implementation**:
   In `src/mataroTracker.js` (lines 12–53), lines 1–8 are defined with fixed uniform headways:
   ```javascript
   const MATARO_LINE_SCHEDULES = {
     '1': {
       weekday: { inicio: '06:30', fin: '22:15', headwayMins: 15 },
       saturday: { inicio: '07:15', fin: '22:15', headwayMins: 20 },
       sunday: { inicio: '08:15', fin: '22:00', headwayMins: 30 }
     },
     ...
     '8': {
       weekday: { inicio: '06:45', fin: '21:45', headwayMins: 25 },
       saturday: { inicio: '14:04', fin: '21:35', headwayMins: 30, afternoonOnly: true },
       sunday: { inicio: '14:04', fin: '21:35', headwayMins: 30, afternoonOnly: true }
     }
   };
   ```
   In `src/mataroTracker.js` (lines 769–810), departures are synthesized by incrementing fixed headways:
   ```javascript
   const headwaySec = (lineSchedToday.headwayMins || 20) * 60;
   for (let depSec = startSecToday; depSec <= endSecToday; depSec += headwaySec) { ... }
   ```

2. **Authoritative Specification Source**:
   The authoritative API endpoints on `https://mataro.avanzagrupo.com/detalle-linea` (Liferay Portlet `adoLinea_routes_AdoLineaRoutesPortlet_INSTANCE_9eVaGQ76b4lw`) with commands `getTrayectosIda`, `getTrayectosVuelta`, and `getHorariosTeoricos` were probed and extracted for all 8 Mataró urban lines.

3. **Authoritative Schedule Extraction Results**:
   All 8 lines (16 primary directional paths and 2 operational variants) were successfully mined and stored in `.agents/spec_miner_mataro_timetables/mataro_authoritative_schedules.json` and documented in `analysis.md`:
   - **Line 1 (Circular)**:
     - Path 11 (Rodalies -> Hospital): Feiners (76 trips, `05:25`–`22:35`), Dissabtes (37 trips, `06:36`–`22:09`), Diumenges (25 trips, `08:12`–`22:01`).
     - Path 12 (Hospital -> Rodalies): Feiners (67 trips, `06:03`–`22:05`), Dissabtes (37 trips, `07:09`–`22:02`), Diumenges (25 trips, `08:15`–`21:58`).
   - **Line 2 (Circular)**:
     - Path 11 (Hospital -> Rodalies): Feiners (77 trips, `05:25`–`22:19`), Dissabtes (36 trips, `06:56`–`22:13`), Diumenges (26 trips, `07:55`–`22:00`).
     - Path 12 (Rodalies -> Hospital): Feiners (65 trips, `05:28`–`22:24`), Dissabtes (36 trips, `06:26`–`22:08`), Diumenges (26 trips, `07:59`–`22:00`).
   - **Line 3 (Camí de la Serra - Vista Alegre - Rocafonda)**:
     - Path 11 (Rodalies -> Hospital): Feiners (50 trips, `06:31`–`21:41`), Dissabtes (35 trips, `07:34`–`21:17`), Diumenges (23 trips, `08:00`–`21:38`).
     - Path 12 (Hospital -> Rodalies): Feiners (48 trips, `06:06`–`21:12`), Dissabtes (36 trips, `07:04`–`21:54`), Diumenges (24 trips, `08:05`–`22:15`).
   - **Line 4 (Cirera - Molins)**:
     - Path 11 (Rodalies -> Hospital): Feiners (26 trips, `07:38`–`22:07`), Dissabtes (13 trips, `08:03`–`21:13`), Diumenges (14 trips, `08:30`–`21:57`).
     - Path 12 (Hospital -> Rodalies): Feiners (13 trips, `07:45`–`20:45`), Dissabtes (14 trips, `07:31`–`21:50`), Diumenges (13 trips, `09:01`–`21:30`).
   - **Line 5 (Rodalies - Hospital de Mataró)**:
     - Path 11 (Rodalies -> Hospital): Feiners (69 trips, `05:41`–`22:32`), Dissabtes (51 trips, `07:20`–`21:56`), Diumenges (29 trips, `08:52`–`21:19`).
     - Path 12 (Hospital -> Rodalies): Feiners (68 trips, `05:58`–`22:12`), Dissabtes (50 trips, `07:35`–`22:14`), Diumenges (30 trips, `08:32`–`21:22`).
   - **Line 6 (Institut Català Salut - Ctra. de Mata)**:
     - Path 11 (Ctra. Mata -> ICS): Feiners (64 trips, `06:00`–`21:47`), Dissabtes (26 trips, `07:16`–`21:24`), Diumenges (12 trips, `14:00`–`22:03` [Afternoon only]).
     - Path 12 (ICS -> Ctra. Mata): Feiners (40 trips, `06:51`–`21:53`), Dissabtes (26 trips, `07:34`–`21:43`), Diumenges (12 trips, `14:17`–`22:17` [Afternoon only]).
   - **Line 7 (Pl. Tereses - Parc de Cerdanyola)**:
     - Path 11 (Parc Cerdanyola -> Pl. Tereses): Feiners (51 trips, `07:25`–`21:35`), Dissabtes (37 trips, `08:19`–`21:46`), Diumenges (35 trips, `08:39`–`21:27`).
     - Path 12 (Pl. Tereses -> Parc Cerdanyola): Feiners (51 trips, `07:36`–`21:37`), Dissabtes (37 trips, `08:10`–`21:37`), Diumenges (35 trips, `08:30`–`21:18`).
   - **Line 8 (Rodalies - Galícia)**:
     - Path 11 (Galícia -> Rodalies): Feiners (43 trips, `06:05`–`22:11`), Dissabtes (14 trips, `07:00`–`21:31`), Diumenges & Festius (7 trips, `14:45`–`21:13` [Afternoon only]).
     - Path 12 (Rodalies -> Galícia): Feiners (27 trips, `06:23`–`21:22`), Dissabtes (14 trips, `07:20`–`21:55`), Diumenges & Festius (8 trips, `14:04`, `15:08`, `16:12`, `17:16`, `18:20`, `19:26`, `20:32`, `21:35` [Afternoon only]).

4. **Distance and Topographic Run Times**:
   - Total route distances and stop-by-stop cumulative run times were calculated for each direction using the high-precision polyline coordinates in `data/cities/mataro/mataro_routes_full.json` with average urban transit speed (4.8 m/s ≈ 17.3 km/h) and 25s stop dwell time.
   - Run times range from 7 minutes (Line 7, 1.5–1.9 km) up to 31 minutes (Line 8 Dir 1, 6.83 km, 25 stops).

---

## 2. Logic Chain

1. **Premise 1**: The synthetic arithmetic `depSec += headwaySec` generates uniform, artificial departure steps (e.g. 15, 20, 30 min) that do not match official timetables (Observation 1).
2. **Premise 2**: Avanza / CTSA publishes exact per-trip timetable matrices via the official Mataró Bus web API `getHorariosTeoricos` (Observation 2).
3. **Premise 3**: Extracting all 8 lines across Feiners, Dissabtes, and Diumenges yields exact trip arrays that reflect peak frequency boosts (e.g., Line 1 morning rush headways of 7–11 min vs 15 min base), Sunday afternoon-only constraints (Lines 6 and 8), and actual first-trip starting times (Observation 3).
4. **Premise 4**: Pairing exact departure arrays with stop travel time offsets (`estimateStopTravelTimes`) computes authentic passing times for every stop in the network (Observation 4).
5. **Conclusion**: Replacing `MATARO_LINE_SCHEDULES` in `src/mataroTracker.js` with the extracted dataset in `mataro_authoritative_schedules.json` completely eliminates synthetic 30-minute gaps and satisfies all user requirements (R1, R2, R4).

---

## 3. Caveats

1. **Special Event / Festa Major Services**: Annual temporary festival buses (e.g. Les Santes night buses) are published as temporary GTFS or news alerts (`mataro_avisos.json`) rather than regular seasonal schedules; the mined dataset represents the official base timetable in effect throughout the year.
2. **Seasonal Variation**: Avanza maintains winter and summer timetables; the mined schedules represent the current official network dataset with holiday calendar fallback.
3. No other caveats.

---

## 4. Conclusion

All authoritative timetable data, departure matrices, stop sequences, and cumulative topographic run times for Mataró Bus Lines 1–8 have been mined, verified, and structured.

Key deliverables produced:
- `.agents/spec_miner_mataro_timetables/mataro_authoritative_schedules.json` (Machine-readable JSON dataset for all 8 lines)
- `.agents/spec_miner_mataro_timetables/analysis.md` (2,760-line exhaustive specification document detailing all 18 routes, departure matrices, and stop sequence tables)

---

## 5. Verification Method

To independently verify the mined datasets and analysis:

1. **Inspect Mined Schedules**:
   ```powershell
   node -e "const s = require('./.agents/spec_miner_mataro_timetables/mataro_authoritative_schedules.json'); console.log('Lines mined:', Object.keys(s)); console.log('L8 Sunday Vuelta:', s['8'].directions['12'].schedules['Diumenges i Festius']);"
   ```
   **Expected Output**:
   ```
   Lines mined: [ '1', '2', '3', '4', '5', '6', '7', '8' ]
   L8 Sunday Vuelta: [ '14:04', '15:08', '16:12', '17:16', '18:20', '19:26', '20:32', '21:35' ]
   ```

2. **Execute Full Analysis Verification Script**:
   ```powershell
   node .agents/spec_miner_mataro_timetables/analyze_all.js
   ```

3. **Check Test Suite Health**:
   ```powershell
   node test/challenger_tracker_schedule_test.js
   ```
