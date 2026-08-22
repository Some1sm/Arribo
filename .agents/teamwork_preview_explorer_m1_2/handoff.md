# Handoff Report: Milestone 1 — Schedule & Delay Core Modules Specification

**Explorer**: Explorer M1-2 (`teamwork_preview_explorer_m1_2`)  
**Milestone**: M1 (Shared Transit Core Modules: `scheduleSynthesizer.js` & `delayEngine.js`)  
**Date**: 2026-08-21T21:41:00Z  
**Working Directory**: `h:/Coding/C10Data/.agents/teamwork_preview_explorer_m1_2`  
**Authoritative References**: `h:/Coding/C10Data/ORIGINAL_REQUEST.md`, `h:/Coding/C10Data/PROJECT.md`

---

## 1. Observation

A systematic review of all 7 existing tracker modules and upstream clients was conducted to document current schedule synthesis, travel time estimation, and delay evaluation logic:

### 1.1 Stop Travel Time Estimation Across Trackers

1. **Mataró Urban Bus (`src/mataroTracker.js`, lines 854–874 & lines 641–645)**:
   ```javascript
   let travelSec = 0;
   if (stopIdx > 0) {
     let cumDist = 0;
     for (let i = 1; i <= stopIdx; i++) {
       const p0 = routeStops[i - 1];
       const p1 = routeStops[i];
       if (p0 && p1) {
         const lat0 = p0.latitude || p0.lat || 0;
         const lon0 = p0.longitude || p0.lon || 0;
         const lat1 = p1.latitude || p1.lat || 0;
         const lon1 = p1.longitude || p1.lon || 0;
         if (lat0 && lon0 && lat1 && lon1) {
           cumDist += geoUtils.calculateDistanceMeters(lat0, lon0, lat1, lon1);
         } else {
           cumDist += 300;
         }
       }
     }
     travelSec = Math.round((cumDist / 4.8) + (stopIdx * 25)); // 4.8 m/s (~17.3 km/h), 25s dwell
   }
   ```

2. **Sagalés Interurban & Night Bus (`src/sagalesTracker.js`, lines 490–503)**:
   ```javascript
   let travelSec = 0;
   if (stopIdx > 0) {
     let cumDist = 0;
     for (let i = 1; i <= stopIdx; i++) {
       const s0 = stops[i - 1];
       const s1 = stops[i];
       if (s0.lat && s0.lon && s1.lat && s1.lon) {
         cumDist += geoUtils.calculateDistanceMeters(s0.lat, s0.lon, s1.lat, s1.lon);
       } else {
         cumDist += 600;
       }
     }
     travelSec = Math.round((cumDist / 10.0) + (stopIdx * 30)); // 10.0 m/s (~36.0 km/h), 30s dwell
   }
   ```

3. **AMB Metrobús & NitBus (`src/ambTracker.js`, lines 728–741)**:
   ```javascript
   let travelSec = 0;
   if (stopIdx > 0) {
     let cumDist = 0;
     for (let i = 1; i <= stopIdx; i++) {
       const s0 = stops[i - 1];
       const s1 = stops[i];
       if (s0.lat && s0.lon && s1.lat && s1.lon) {
         cumDist += geoUtils.calculateDistanceMeters(s0.lat, s0.lon, s1.lat, s1.lon);
       } else {
         cumDist += 400;
       }
     }
     travelSec = Math.round((cumDist / 8.0) + (stopIdx * 25)); // 8.0 m/s (~28.8 km/h), 25s dwell
   }
   ```

4. **Rodalies de Catalunya Trains (`src/rodaliesTracker.js`, lines 484–497)**:
   ```javascript
   let travelSec = 0;
   if (stopIdx > 0) {
     let cumDist = 0;
     for (let i = 1; i <= stopIdx; i++) {
       const s0 = stations[i - 1];
       const s1 = stations[i];
       if (s0.lat && s0.lon && s1.lat && s1.lon) {
         cumDist += geoUtils.calculateDistanceMeters(s0.lat, s0.lon, s1.lat, s1.lon);
       } else {
         cumDist += 2000;
       }
     }
     travelSec = Math.round((cumDist / 18.0) + (stopIdx * 45)); // 18.0 m/s (~65 km/h), 45s dwell
   }
   ```

5. **Moventis Maresme (`src/maresmeTracker.js`, lines 734–824 & lines 1158–1215)**:
   - Interpolates progress along polyline points with speeds 55 km/h for e11 express lines and 34 km/h for standard lines, accumulating stop-by-stop offset durations.

---

### 1.2 Delay Evaluation & Status Discrepancy Matrix

| Tracker File | Real-Time Field | Delay Fields | Delay Status Enum Values | Delay Badge Threshold & Strings | Comparison Text Pattern |
|---|---|---|---|---|---|
| `src/corridorTracker.js` (lines 380–408, 555–558) | `isRealtime` | `delayMinutes` | `'on_time'`, `'delayed'`, `'early'`, `'scheduled'` | `>= 2 min`: `+X min retard`<br>`<= -2 min`: `X min avançat`<br>else: `A l'hora (Puntual)` | `isRealtime ? "Teòric: " + sched + " (" + badge + ")" : "Horari teòric: " + sched` |
| `src/mataroTracker.js` (lines 689–691, 910–912, 952–954) | `isRealTime` | `delayMins`, `delayFormatted` | `'estimated'`, `'scheduled'` | SIRI live: `delayMins > 0 ? "+X min retard" : "Puntual"`<br>Estimated: `⚡ En ruta (Bus #X)` | `📅 Horari teòric: HH:MM`<br>`📅 Pas teòric previst demà a les HH:MM` |
| `src/maresmeTracker.js` (lines 1114–1145, 1210–1213) | `isRealTime` | `delayMins`, `delayMinutes` | `'delayed'`, `'early'`, `'on-time'`, `'scheduled'`, `'estimated'` | `>= 2 min`: `+X min retard`<br>`<= -2 min`: `X min avançat`<br>else: `Puntual` | `schedMatch ? "Teòric: " + sched + " (" + badge + ")" : "Horari Mou-te (" + clock + ")"` |
| `src/sagalesTracker.js` (lines 476–478, 562–564) | `isRealTime` | `delayMin` (local) | `'delayed'`, `'on_time'`, `'scheduled'` | `>= 2 min`: `+X min retard`<br>else: `Puntual` | `Temps real Sagalés (HH:MM)`<br>`📅 Horari teòric: HH:MM` |
| `src/ambTracker.js` (lines 709–717, 770–772, 810–812) | `isRealTime` | `delayMinutes`, `delayMins` | `'delayed'`, `'early'`, `'on_time'`, `'scheduled'` | `>= 2 min`: `+X min retard`<br>`<= -2 min`: `X min avançat`<br>else: `Puntual` | `delayMin !== 0 ? "📅 Horari teòric: " + aimed : "Temps real AMB (" + clock + ")"` |
| `src/rodaliesTracker.js` (lines 464–473, 530–532) | `isRealTime` | `delayMinutes`, `delayMins` | `'delayed'`, `'early'`, `'on_time'`, `'scheduled'` | `>= 2 min`: `+X min retard`<br>`<= -2 min`: `X min avançat`<br>else: `Puntual` | `delayMin !== 0 ? "📅 Horari teòric: " + aimed : "Temps real Rodalies (" + clock + ")"` |
| `src/cataloniaTracker.js` (lines 393–396, 425–427, 458–460, 629–632) | `isRealTime`, `isRealtime` | `delayMins`, `delayMinutes` | `'delayed'`, `'ontime'`, `'scheduled'` | `retard > 0 ? "+X min retard" : "Puntual"`<br>`Horari teòric` | `📅 Horari teòric: HH:MM`<br>`🌅 1r Servei del matí` |

---

### 1.3 Overnight / Next-Service Generator Patterns

When services conclude for the current calendar day, trackers create synthetic next-day departures with the following uniform flags:
- `isToday: false`
- `isFirstOfDay: true`
- `isNextService: true`
- `delayBadgeText`: `'🌅 1r Servei del matí'` (or `'🌅 1r Servei'` / `'🌅 1r Tren del matí'`)
- `comparisonText`: `'📅 Pas teòric previst demà a les HH:MM'` (or `'📅 Pas teòric previst: HH:MM'`)
- Subsequent departures on tomorrow: `isToday: false`, `isFirstOfDay: false`, `isNextService: false`, `delayBadgeText: 'Programat'`.

---

## 2. Logic Chain

1. **Step 1 — Deduplication of Travel Time Estimation**:
   - Observations 1.1 show that 5 separate trackers iterate stop arrays and compute `(cumDist / speedMps) + (stopIndex * dwellSecPerStop)`.
   - The variations are simply transit-mode parameters:
     - Urban Bus (Mataró): `speedMps = 4.8` (~17 km/h), `dwellSec = 25s`, fallback distance `300m`.
     - AMB Metrobús: `speedMps = 8.0` (~29 km/h), `dwellSec = 25s`, fallback distance `400m`.
     - Interurban Bus (Sagalés/Maresme): `speedMps = 10.0` (~36 km/h), `dwellSec = 30s`, fallback distance `600m`.
     - Heavy Rail (Rodalies): `speedMps = 18.0` (~65 km/h), `dwellSec = 45s`, fallback distance `2000m`.
   - **Conclusion**: A single pure function `estimateStopTravelTimes(stops, options)` accepting configurable `speedMps` (or `speedKmh`), `dwellSecPerStop`, and `defaultSegmentMeters` completely replaces all 5 ad-hoc loops while retaining mode-specific precision.

2. **Step 2 — Synthetic Departure & Overnight Timetable Synthesis**:
   - Headway-based departure generators and timetable interpolators calculate passing seconds as `passingSec = originDepSec + stopTravelSec`, convert to local wall-clock HH:MM, and derive UTC ISO dates using timezone math.
   - Overnight off-peak periods across all agencies require generating the first 5–10 trips of tomorrow, flagging the very first trip with `isFirstOfDay: true`, `isNextService: true`, and `'🌅 1r Servei del matí'`.
   - **Conclusion**: Unifying this in `src/core/schedule/scheduleSynthesizer.js` with `synthesizeDeparturesFromBaseTimes()`, `synthesizeHeadwayDepartures()`, and `generateMorningFirstService()` eliminates hundreds of lines of duplicate date arithmetic and ensures consistent edge-case handling across all operators.

3. **Step 3 — Canonical Delay Classification & Dual Compatibility**:
   - Observations 1.2 demonstrate minor discrepancies in enum formatting (`on_time` vs `ontime` vs `on-time`), property naming (`delayMinutes` vs `delayMins`), and casing (`isRealTime` vs `isRealtime`).
   - The frontend codebase (`public/js/app.js`, `public/js/map.js`) and test suite consume both property names interchangeably (`dep.delayMins !== undefined ? dep.delayMins : dep.delayMinutes`).
   - **Conclusion**: `computeDelayStatus(delayMinutes, isRealTime, options)` must output canonical snake_case `'on_time' | 'delayed' | 'early' | 'scheduled' | 'passed' | 'estimated'`, and `standardizeDeparture(dep)` must always populate both `delayMinutes` AND `delayMins` as well as `isRealTime` AND `isRealtime`.

---

## 3. Caveats

1. **No Direct Source Writes in This Phase**: This handoff provides the exact, production-ready specification and code design for Milestone 1. The actual files in `src/core/schedule/` will be written during implementation turns.
2. **Midnight Rollover Handling**: Circular time difference math (`|t1 - t2| > 720 ? 1440 - |t1 - t2| : |t1 - t2|`) must be used when matching scheduled trips around midnight (e.g., 23:55 vs 00:05) to avoid false 23-hour delay calculations.
3. **Missing Stop Coordinates**: Certain remote or seasonal bus stops in rural Catalonia may lack GPS coordinates. The travel time estimator must gracefully fallback to `defaultSegmentMeters` without throwing `NaN` or `TypeError`.
4. **Train vs Bus Customization**: Rail lines (`isTrain: true`) use the badge text `'🌅 1r Tren del matí'` instead of `'🌅 1r Servei del matí'`. The synthesizer and delay engine must support this via an `isTrain` option flag.

---

## 4. Conclusion & Complete Implementation Specifications

### 4.1 Module 1: `src/core/schedule/scheduleSynthesizer.js`

#### Full Function Signatures & API Contract

```typescript
export interface StopInput {
  id?: string | number;
  stopId?: string | number;
  code?: string | number;
  name?: string;
  lat?: number;
  latitude?: number;
  lon?: number;
  longitude?: number;
  seq?: number;
}

export interface StopTravelTime {
  stopId: string;
  stopIndex: number;
  seq: number;
  name: string;
  segmentMeters: number;
  cumulativeMeters: number;
  dwellSec: number;
  travelSec: number;
  travelMinutes: number;
}

export interface EstimateOptions {
  speedMps?: number;           // Default: 8.0 m/s (~28.8 km/h)
  speedKmh?: number;           // Alternative: km/h (converted to m/s)
  avgSpeedKmh?: number;        // Alias for speedKmh
  dwellSecPerStop?: number;    // Default: 25 seconds
  defaultSegmentMeters?: number; // Default: 400 meters
  polyCoords?: Array<{ lat: number; lon: number } | [number, number]>;
}

export interface SynthesizeOptions {
  targetDate?: Date | string | number;
  timezone?: string;           // Default: 'Europe/Madrid'
  lineId?: string;
  lineCode?: string;
  lineName?: string;
  destination?: string;
  directionId?: string | number;
  minMinutesAway?: number;     // Default: -5
  maxMinutesAway?: number;     // Default: 240
  onlyUpcoming?: boolean;      // Default: true
}

export interface MorningServiceOptions {
  referenceDate?: Date | string | number;
  dayOffset?: number;          // Default: 1 (tomorrow)
  timezone?: string;           // Default: 'Europe/Madrid'
  lineId?: string;
  lineCode?: string;
  lineName?: string;
  destination?: string;
  directionId?: string | number;
  isTrain?: boolean;           // Default: false
  badgeTextFirst?: string;     // Default: isTrain ? '🌅 1r Tren del matí' : '🌅 1r Servei del matí'
  badgeTextSubsequent?: string; // Default: 'Programat'
  maxCount?: number;           // Default: 10
}
```

#### Complete Implementation Blueprint (`scheduleSynthesizer.js`)

```javascript
/**
 * src/core/schedule/scheduleSynthesizer.js
 * 
 * Reusable Transit Schedule & Timetable Synthesis Engine
 * Provides cumulative stop travel time estimation, synthetic departure calculation,
 * and overnight first-morning-service generation.
 */

const timeUtils = require('../../timeUtils');
const geoEngine = require('../geo/geoEngine');

/**
 * Estimates cumulative travel distance and duration along a sequence of stops.
 * 
 * @param {Array<StopInput>} stops - Ordered list of stops
 * @param {EstimateOptions} options - Speed, dwell time, and polyline options
 * @returns {Array<StopTravelTime>} Cumulative travel time metadata per stop
 */
function estimateStopTravelTimes(stops = [], options = {}) {
  if (!Array.isArray(stops) || stops.length === 0) {
    return [];
  }

  const speedMps = options.speedMps || 
    (options.speedKmh ? options.speedKmh / 3.6 : 
    (options.avgSpeedKmh ? options.avgSpeedKmh / 3.6 : 8.0));
  const dwellSecPerStop = options.dwellSecPerStop !== undefined ? options.dwellSecPerStop : 25;
  const defaultSegmentMeters = options.defaultSegmentMeters || 400;

  const results = [];
  let cumulativeMeters = 0;

  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    const stopId = String(s.id || s.stopId || s.code || i);
    const name = s.name || `Parada ${stopId}`;
    const seq = s.seq !== undefined ? s.seq : i;

    let segmentMeters = 0;

    if (i > 0) {
      const prev = stops[i - 1];
      const lat0 = Number(prev.lat ?? prev.latitude);
      const lon0 = Number(prev.lon ?? prev.longitude);
      const lat1 = Number(s.lat ?? s.latitude);
      const lon1 = Number(s.lon ?? s.longitude);

      if (!isNaN(lat0) && !isNaN(lon0) && !isNaN(lat1) && !isNaN(lon1) && lat0 !== 0 && lat1 !== 0) {
        segmentMeters = geoEngine.calculateDistanceMeters(lat0, lon0, lat1, lon1);
      } else {
        segmentMeters = defaultSegmentMeters;
      }
    }

    cumulativeMeters += segmentMeters;
    const dwellSec = i * dwellSecPerStop;
    const travelSec = i === 0 ? 0 : Math.round((cumulativeMeters / speedMps) + dwellSec);
    const travelMinutes = Math.round(travelSec / 60);

    results.push({
      stopId,
      stopIndex: i,
      seq,
      name,
      segmentMeters: Math.round(segmentMeters),
      cumulativeMeters: Math.round(cumulativeMeters),
      dwellSec,
      travelSec,
      travelMinutes
    });
  }

  return results;
}

/**
 * Finds travel time from route origin to a target stop identifier.
 * 
 * @param {Array<StopTravelTime>} stopTravelTimes 
 * @param {string|number} stopIdentifier - stopId, code, seq, or stopIndex
 * @returns {number} Travel time in seconds
 */
function getTravelTimeToStop(stopTravelTimes = [], stopIdentifier) {
  if (!Array.isArray(stopTravelTimes) || stopTravelTimes.length === 0) return 0;
  const idStr = String(stopIdentifier);
  const match = stopTravelTimes.find(st => 
    String(st.stopId) === idStr || 
    String(st.seq) === idStr || 
    String(st.stopIndex) === idStr
  );
  return match ? match.travelSec : 0;
}

/**
 * Synthesizes departures at a stop from base route departure times.
 * 
 * @param {Array<string|{dep: string}>} baseDepartureTimes - e.g. ['06:00', '06:30']
 * @param {number} stopTravelSec - Cumulative seconds from route start
 * @param {SynthesizeOptions} options 
 * @returns {Array<Departure>}
 */
function synthesizeDeparturesFromBaseTimes(baseDepartureTimes = [], stopTravelSec = 0, options = {}) {
  const timezone = options.timezone || 'Europe/Madrid';
  const targetDate = options.targetDate ? new Date(options.targetDate) : new Date();
  const netNow = timeUtils.getNetworkTime(timezone, targetDate);
  const nowMs = targetDate.getTime();
  const currentSec = netNow.hour * 3600 + netNow.minute * 60 + netNow.second;

  const minMinutesAway = options.minMinutesAway !== undefined ? options.minMinutesAway : -5;
  const maxMinutesAway = options.maxMinutesAway !== undefined ? options.maxMinutesAway : 240;
  const onlyUpcoming = options.onlyUpcoming !== false;

  const departures = [];

  for (const item of baseDepartureTimes) {
    const timeStr = typeof item === 'string' ? item : (item.dep || item.arr || item.time || '');
    if (!timeStr) continue;

    const baseSec = timeUtils.timeToSec(timeStr);
    const passSec = baseSec + stopTravelSec;
    const passHour = Math.floor(passSec / 3600) % 24;
    const passMin = Math.floor((passSec % 3600) / 60);
    const passingTimeStr = `${String(passHour).padStart(2, '0')}:${String(passMin).padStart(2, '0')}`;

    const depUtcDate = timeUtils.localTimeToUtcDate(netNow.year, netNow.month, netNow.day, passHour, passMin, 0, timezone);
    const diffMs = depUtcDate.getTime() - nowMs;
    const diffMin = Math.round(diffMs / 60000);

    if (onlyUpcoming && (diffMin < minMinutesAway || diffMin > maxMinutesAway)) {
      continue;
    }

    const safeDiffMin = Math.max(0, diffMin);
    const depIso = depUtcDate.toISOString();

    departures.push({
      lineId: options.lineId || 'line',
      lineCode: options.lineCode || options.lineId || 'BUS',
      lineName: options.lineName || options.lineCode || 'Bus',
      destination: options.destination || 'Destinació',
      directionId: options.directionId !== undefined ? String(options.directionId) : '0',
      departureTime: passingTimeStr,
      departureDate: depIso,
      expectedIso: depIso,
      aimedIso: depIso,
      minutesAway: safeDiffMin,
      formattedStatus: safeDiffMin <= 0 ? 'Imminent' : (safeDiffMin === 1 ? '1 min' : `${safeDiffMin} min`),
      isRealTime: false,
      isRealtime: false,
      isEstimated: false,
      isToday: true,
      isFirstOfDay: false,
      isNextService: false,
      delayMinutes: 0,
      delayMins: 0,
      delayStatus: 'scheduled',
      delayBadgeText: 'Horari teòric',
      comparisonText: `Horari teòric: ${passingTimeStr}`
    });
  }

  return departures.sort((a, b) => a.minutesAway - b.minutesAway);
}

/**
 * Generates synthetic departures for frequency-based / headway service spans.
 * 
 * @param {object} config - { startTime, endTime, headwayMinutes, stopTravelSec, ...options }
 * @returns {Array<Departure>}
 */
function synthesizeHeadwayDepartures(config = {}) {
  const startSec = timeUtils.timeToSec(config.startTime || '06:00');
  const endSec = timeUtils.timeToSec(config.endTime || '22:00');
  const headwaySec = (config.headwayMinutes || 15) * 60;
  const stopTravelSec = config.stopTravelSec || 0;

  const baseTimes = [];
  for (let s = startSec; s <= endSec; s += headwaySec) {
    const h = Math.floor(s / 3600) % 24;
    const m = Math.floor((s % 3600) / 60);
    baseTimes.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }

  return synthesizeDeparturesFromBaseTimes(baseTimes, stopTravelSec, config);
}

/**
 * Generates next-day first morning departures during overnight off-peak periods.
 * 
 * @param {Array<string|{dep: string}>} baseDepartureTimes - Tomorrow's initial timetable
 * @param {number} stopTravelSec - Cumulative travel seconds from route origin
 * @param {MorningServiceOptions} options 
 * @returns {Array<Departure>}
 */
function generateMorningFirstService(baseDepartureTimes = [], stopTravelSec = 0, options = {}) {
  if (!Array.isArray(baseDepartureTimes) || baseDepartureTimes.length === 0) {
    return [];
  }

  const timezone = options.timezone || 'Europe/Madrid';
  const now = options.referenceDate ? new Date(options.referenceDate) : new Date();
  const dayOffset = options.dayOffset !== undefined ? options.dayOffset : 1;
  const targetDate = new Date(now.getTime() + dayOffset * 86400000);
  const netTomorrow = timeUtils.getNetworkTime(timezone, targetDate);

  const isTrain = Boolean(options.isTrain);
  const badgeFirst = options.badgeTextFirst || (isTrain ? '🌅 1r Tren del matí' : '🌅 1r Servei del matí');
  const badgeSubsequent = options.badgeTextSubsequent || 'Programat';
  const maxCount = options.maxCount || 10;

  const departures = [];
  const timesToUse = baseDepartureTimes.slice(0, maxCount);

  for (let idx = 0; idx < timesToUse.length; idx++) {
    const item = timesToUse[idx];
    const timeStr = typeof item === 'string' ? item : (item.dep || item.arr || item.time || '');
    if (!timeStr) continue;

    const baseSec = timeUtils.timeToSec(timeStr);
    const passSec = baseSec + stopTravelSec;
    const passHour = Math.floor(passSec / 3600) % 24;
    const passMin = Math.floor((passSec % 3600) / 60);
    const passingTimeStr = `${String(passHour).padStart(2, '0')}:${String(passMin).padStart(2, '0')}`;

    const depUtcDate = timeUtils.localTimeToUtcDate(netTomorrow.year, netTomorrow.month, netTomorrow.day, passHour, passMin, 0, timezone);
    const diffMs = depUtcDate.getTime() - now.getTime();
    const diffMin = Math.max(1, Math.round(diffMs / 60000));
    const isFirst = (idx === 0);
    const depIso = depUtcDate.toISOString();

    departures.push({
      lineId: options.lineId || 'line',
      lineCode: options.lineCode || options.lineId || 'BUS',
      lineName: options.lineName || options.lineCode || 'Bus',
      destination: options.destination || 'Destinació',
      directionId: options.directionId !== undefined ? String(options.directionId) : '0',
      departureTime: passingTimeStr,
      departureDate: depIso,
      expectedIso: depIso,
      aimedIso: depIso,
      minutesAway: diffMin,
      formattedStatus: passingTimeStr,
      isRealTime: false,
      isRealtime: false,
      isEstimated: false,
      isTrain,
      isToday: false,
      isFirstOfDay: isFirst,
      isNextService: isFirst,
      delayMinutes: 0,
      delayMins: 0,
      delayStatus: 'scheduled',
      delayBadgeText: isFirst ? badgeFirst : badgeSubsequent,
      comparisonText: isFirst 
        ? `📅 Pas teòric previst demà a les ${passingTimeStr}` 
        : `📅 Horari teòric: ${passingTimeStr}`
    });
  }

  return departures;
}

/**
 * Interpolates trip passing times across all stops in a route sequence.
 * 
 * @param {number} baseTripDepartureSec - Departure seconds at stop 0
 * @param {Array<StopTravelTime>} stopTravelTimes - From estimateStopTravelTimes
 * @param {Date|string} dateObj - Reference date
 * @param {object} options 
 * @returns {Array<object>}
 */
function interpolateStopArrivals(baseTripDepartureSec, stopTravelTimes = [], dateObj = new Date(), options = {}) {
  const timezone = options.timezone || 'Europe/Madrid';
  const netDate = timeUtils.getNetworkTime(timezone, dateObj);

  return stopTravelTimes.map(st => {
    const arrSec = baseTripDepartureSec + st.travelSec;
    const hour = Math.floor(arrSec / 3600) % 24;
    const min = Math.floor((arrSec % 3600) / 60);
    const sec = Math.floor(arrSec % 60);
    const timeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    const utcDate = timeUtils.localTimeToUtcDate(netDate.year, netDate.month, netDate.day, hour, min, sec, timezone);

    return {
      stopId: st.stopId,
      seq: st.seq,
      name: st.name,
      arrivalSec: arrSec,
      departureTime: timeStr,
      expectedIso: utcDate.toISOString(),
      travelSec: st.travelSec,
      cumulativeMeters: st.cumulativeMeters
    };
  });
}

module.exports = {
  estimateStopTravelTimes,
  getTravelTimeToStop,
  synthesizeDeparturesFromBaseTimes,
  synthesizeHeadwayDepartures,
  generateMorningFirstService,
  interpolateStopArrivals
};
```

---

### 4.2 Module 2: `src/core/schedule/delayEngine.js`

#### Full Function Signatures & API Contract

```typescript
export type CanonicalDelayStatus = 'on_time' | 'delayed' | 'early' | 'scheduled' | 'passed' | 'estimated';

export interface DelayStatusResult {
  delayMinutes: number;
  delayMins: number;           // Dual-compatibility alias
  delayStatus: CanonicalDelayStatus;
  delayBadgeText: string;
  delayFormatted: string;
  comparisonText: string;
}

export interface DelayComputeOptions {
  thresholdDelayMinutes?: number; // Default: 2
  thresholdEarlyMinutes?: number; // Default: -2
  scheduledTime?: string | null;  // e.g. '21:30'
  realtimeTime?: string | null;   // e.g. '21:35'
  isFirstOfDay?: boolean;
  isNextService?: boolean;
  isPassed?: boolean;
  isEstimated?: boolean;
  isTrain?: boolean;
  agency?: string;                // e.g. 'AMB', 'Sagalés', 'Rodalies'
  punctualStyle?: 'short' | 'long'; // Default: 'short' ('Puntual' vs "A l'hora (Puntual)")
}

export interface ScheduledMatchResult {
  matched: boolean;
  scheduledTime: string;
  delayMinutes: number;
  diff: number;
  bestTrip: any;
}
```

#### Complete Implementation Blueprint (`delayEngine.js`)

```javascript
/**
 * src/core/schedule/delayEngine.js
 * 
 * Canonical Transit Delay Evaluation & Status Standardization Engine
 * Formats canonical delay status, badge texts, comparison strings,
 * and maintains dual-compatibility fields (delayMinutes and delayMins).
 */

const timeUtils = require('../../timeUtils');

/**
 * Computes canonical delay evaluation for any transit arrival or departure.
 * 
 * @param {number|string|null} delayMinutes - Delay in minutes (+ late, - early)
 * @param {boolean} isRealTime - Whether arrival is derived from live telemetry
 * @param {DelayComputeOptions} options - Thresholds, scheduled times, contextual flags
 * @returns {DelayStatusResult} Standardized delay status structure
 */
function computeDelayStatus(delayMinutes, isRealTime = false, options = {}) {
  const rawDelay = delayMinutes !== undefined && delayMinutes !== null ? Number(delayMinutes) : 0;
  const delay = isNaN(rawDelay) ? 0 : Math.round(rawDelay);

  const thresholdDelay = options.thresholdDelayMinutes !== undefined ? options.thresholdDelayMinutes : 2;
  const thresholdEarly = options.thresholdEarlyMinutes !== undefined ? options.thresholdEarlyMinutes : -2;
  const scheduledTime = options.scheduledTime || null;
  const realtimeTime = options.realtimeTime || null;
  const punctualStyle = options.punctualStyle || 'short';
  const punctualText = punctualStyle === 'long' ? "A l'hora (Puntual)" : 'Puntual';

  // 1. Bus / Train has physically passed this stop
  if (options.isPassed) {
    return {
      delayMinutes: 0,
      delayMins: 0,
      delayStatus: 'passed',
      delayBadgeText: 'Passat ✓',
      delayFormatted: 'Passat ✓',
      comparisonText: scheduledTime ? `Horari teòric: ${scheduledTime}` : 'Passat ✓'
    };
  }

  // 2. Scheduled timetable / overnight next-service / dead-reckoning estimate without GPS
  if (!isRealTime) {
    if (options.isFirstOfDay || options.isNextService) {
      const badge = options.isTrain ? '🌅 1r Tren del matí' : '🌅 1r Servei del matí';
      return {
        delayMinutes: 0,
        delayMins: 0,
        delayStatus: 'scheduled',
        delayBadgeText: badge,
        delayFormatted: badge,
        comparisonText: scheduledTime 
          ? `📅 Pas teòric previst demà a les ${scheduledTime}` 
          : badge
      };
    }

    if (options.isEstimated) {
      return {
        delayMinutes: delay,
        delayMins: delay,
        delayStatus: 'estimated',
        delayBadgeText: options.badgeText || '⚡ En ruta',
        delayFormatted: delay > 0 ? `+${delay} min retard` : punctualText,
        comparisonText: scheduledTime 
          ? `Teòric: ${scheduledTime} (${delay > 0 ? `+${delay} min retard` : punctualText})` 
          : '⚡ Estimació en ruta'
      };
    }

    return {
      delayMinutes: 0,
      delayMins: 0,
      delayStatus: 'scheduled',
      delayBadgeText: 'Horari teòric',
      delayFormatted: 'Horari teòric',
      comparisonText: scheduledTime ? `Horari teòric: ${scheduledTime}` : 'Horari teòric'
    };
  }

  // 3. Live Real-Time Telemetry
  let delayStatus = 'on_time';
  let delayBadgeText = punctualText;
  let delayFormatted = 'Puntual';

  if (delay >= thresholdDelay) {
    delayStatus = 'delayed';
    delayBadgeText = `+${delay} min retard`;
    delayFormatted = `+${delay} min retard`;
  } else if (delay <= thresholdEarly) {
    delayStatus = 'early';
    delayBadgeText = `${Math.abs(delay)} min avançat`;
    delayFormatted = `${Math.abs(delay)} min avançat`;
  }

  let comparisonText = '';
  if (scheduledTime) {
    comparisonText = `Teòric: ${scheduledTime} (${delayBadgeText})`;
  } else if (options.agency && realtimeTime) {
    comparisonText = `Temps real ${options.agency} (${realtimeTime})`;
  } else if (realtimeTime) {
    comparisonText = `Temps real (${realtimeTime})`;
  } else {
    comparisonText = `Temps real (${delayBadgeText})`;
  }

  return {
    delayMinutes: delay,
    delayMins: delay,
    delayStatus,
    delayBadgeText,
    delayFormatted,
    comparisonText
  };
}

/**
 * Matches a real-time observation time against a set of scheduled trip times.
 * Handles circular midnight wrap-around (e.g. 23:55 vs 00:05).
 * 
 * @param {string} realtimeTimeStr - 'HH:MM'
 * @param {Array<string|object>} scheduledItems - List of times or trip objects
 * @param {number} maxDiffMinutes - Maximum matching threshold (default: 55 min)
 * @returns {ScheduledMatchResult}
 */
function findClosestScheduledTime(realtimeTimeStr, scheduledItems = [], maxDiffMinutes = 55) {
  if (!realtimeTimeStr || !Array.isArray(scheduledItems) || scheduledItems.length === 0) {
    return {
      matched: false,
      scheduledTime: realtimeTimeStr || '--:--',
      delayMinutes: 0,
      diff: Infinity,
      bestTrip: null
    };
  }

  const [rH, rM] = realtimeTimeStr.split(':').map(Number);
  const liveMin = (rH || 0) * 60 + (rM || 0);

  let bestTrip = null;
  let bestSchedTime = realtimeTimeStr;
  let minDiff = Infinity;
  let delayMinutes = 0;

  for (const item of scheduledItems) {
    let schedStr = '';
    let tripRef = null;

    if (typeof item === 'string') {
      schedStr = item.substring(0, 5);
    } else if (item && typeof item === 'object') {
      schedStr = (item.dep || item.arr || item.departureTime || item.time || '').substring(0, 5);
      tripRef = item;
    }

    if (!schedStr || schedStr === '--:--') continue;

    const [sH, sM] = schedStr.split(':').map(Number);
    const schedMin = (sH || 0) * 60 + (sM || 0);

    let rawDiff = liveMin - schedMin;
    // Circular midnight wrap-around adjustment
    if (rawDiff > 720) rawDiff -= 1440;
    if (rawDiff < -720) rawDiff += 1440;

    const absDiff = Math.abs(rawDiff);
    if (absDiff < minDiff && absDiff <= maxDiffMinutes) {
      minDiff = absDiff;
      bestSchedTime = schedStr;
      delayMinutes = rawDiff;
      bestTrip = tripRef;
    }
  }

  const matched = minDiff <= maxDiffMinutes;
  return {
    matched,
    scheduledTime: matched ? bestSchedTime : realtimeTimeStr,
    delayMinutes: matched ? delayMinutes : 0,
    diff: minDiff,
    bestTrip
  };
}

/**
 * Formats a user-facing countdown badge string from minutes away.
 * 
 * @param {number|null|undefined} minutesAway 
 * @returns {string} e.g. 'Imminent', '1 min', '14 min', '--:--'
 */
function formatCountdownStatus(minutesAway) {
  if (minutesAway === null || minutesAway === undefined || isNaN(Number(minutesAway))) {
    return '--:--';
  }
  const mins = Number(minutesAway);
  if (mins <= 0) return 'Imminent';
  if (mins === 1) return '1 min';
  return `${mins} min`;
}

/**
 * Standardizes any departure object to guarantee 100% contract compliance
 * with dual-compatibility fields across all frontend consumers.
 * 
 * @param {object} dep - Raw departure object from any tracker
 * @param {object} defaults - Optional fallback properties
 * @returns {object} Fully compliant Departure schema
 */
function standardizeDeparture(dep = {}, defaults = {}) {
  const isRealTime = Boolean(dep.isRealTime !== undefined ? dep.isRealTime : dep.isRealtime);
  const rawDelay = dep.delayMinutes !== undefined ? dep.delayMinutes : (dep.delayMins !== undefined ? dep.delayMins : 0);
  
  const delayEval = computeDelayStatus(rawDelay, isRealTime, {
    scheduledTime: dep.scheduledTime || dep.departureTime,
    realtimeTime: dep.departureTime,
    isFirstOfDay: Boolean(dep.isFirstOfDay),
    isNextService: Boolean(dep.isNextService),
    isPassed: Boolean(dep.isPassed),
    isEstimated: Boolean(dep.isEstimated),
    isTrain: Boolean(dep.isTrain),
    punctualStyle: 'short'
  });

  const minutesAway = dep.minutesAway !== undefined ? Number(dep.minutesAway) : 0;
  const formattedStatus = dep.formattedStatus || formatCountdownStatus(minutesAway);

  return {
    lineId: String(dep.lineId || defaults.lineId || 'line'),
    lineCode: String(dep.lineCode || dep.lineName || defaults.lineCode || 'BUS'),
    lineName: String(dep.lineName || dep.lineCode || defaults.lineName || 'Bus'),
    destination: String(dep.destination || defaults.destination || 'Destinació'),
    directionId: String(dep.directionId !== undefined ? dep.directionId : (defaults.directionId || '0')),
    departureTime: String(dep.departureTime || '--:--'),
    departureDate: dep.departureDate || dep.expectedIso || new Date().toISOString(),
    expectedIso: dep.expectedIso || dep.departureDate || new Date().toISOString(),
    aimedIso: dep.aimedIso || dep.expectedIso || dep.departureDate || new Date().toISOString(),
    minutesAway,
    formattedStatus,
    isRealTime,
    isRealtime: isRealTime, // Dual-cased compatibility
    isEstimated: Boolean(dep.isEstimated),
    isTrain: Boolean(dep.isTrain),
    isToday: dep.isToday !== undefined ? Boolean(dep.isToday) : true,
    isFirstOfDay: Boolean(dep.isFirstOfDay),
    isNextService: Boolean(dep.isNextService),
    delayMinutes: delayEval.delayMinutes,
    delayMins: delayEval.delayMins,       // Dual-named compatibility
    delayStatus: delayEval.delayStatus,
    delayBadgeText: dep.delayBadgeText || delayEval.delayBadgeText,
    delayFormatted: delayEval.delayFormatted,
    comparisonText: dep.comparisonText || delayEval.comparisonText,
    vehicleId: dep.vehicleId || null,
    busCoords: dep.busCoords || null
  };
}

module.exports = {
  computeDelayStatus,
  findClosestScheduledTime,
  formatCountdownStatus,
  standardizeDeparture
};
```

---

## 5. Verification Method

To verify the correct execution and compliance of the specified core modules:

1. **Automated End-to-End Test Suite**:
   ```bash
   node test/verification_test.js
   node test/e2e_multiline_test.js
   ```

2. **Dedicated Core Unit Test Assertions**:
   ```javascript
   const assert = require('assert');
   const { estimateStopTravelTimes, synthesizeDeparturesFromBaseTimes, generateMorningFirstService } = require('../src/core/schedule/scheduleSynthesizer');
   const { computeDelayStatus, findClosestScheduledTime, standardizeDeparture } = require('../src/core/schedule/delayEngine');

   // 1. Travel Time Accumulation
   const stops = [
     { id: '1', lat: 41.538, lon: 2.441, name: 'Stop A' },
     { id: '2', lat: 41.545, lon: 2.449, name: 'Stop B' },
     { id: '3', lat: 41.552, lon: 2.458, name: 'Stop C' }
   ];
   const travelTimes = estimateStopTravelTimes(stops, { speedMps: 8.0, dwellSecPerStop: 25 });
   assert.strictEqual(travelTimes.length, 3);
   assert.strictEqual(travelTimes[0].travelSec, 0);
   assert(travelTimes[1].travelSec > 0);
   assert(travelTimes[2].travelSec > travelTimes[1].travelSec);

   // 2. Overnight Morning First Service
   const morning = generateMorningFirstService(['06:30', '07:00'], 300, { lineCode: 'C-10' });
   assert.strictEqual(morning.length, 2);
   assert.strictEqual(morning[0].isToday, false);
   assert.strictEqual(morning[0].isFirstOfDay, true);
   assert.strictEqual(morning[0].isNextService, true);
   assert.strictEqual(morning[0].delayBadgeText, '🌅 1r Servei del matí');
   assert.strictEqual(morning[1].isFirstOfDay, false);
   assert.strictEqual(morning[1].delayBadgeText, 'Programat');

   // 3. Canonical Delay Engine
   const delayed = computeDelayStatus(4, true);
   assert.strictEqual(delayed.delayStatus, 'delayed');
   assert.strictEqual(delayed.delayBadgeText, '+4 min retard');
   assert.strictEqual(delayed.delayMinutes, 4);
   assert.strictEqual(delayed.delayMins, 4);

   const onTime = computeDelayStatus(0, true);
   assert.strictEqual(onTime.delayStatus, 'on_time');
   assert.strictEqual(onTime.delayBadgeText, 'Puntual');

   const early = computeDelayStatus(-3, true);
   assert.strictEqual(early.delayStatus, 'early');
   assert.strictEqual(early.delayBadgeText, '3 min avançat');

   // 4. Midnight Wrap-Around Matching
   const match = findClosestScheduledTime('00:03', ['23:58', '00:30']);
   assert.strictEqual(match.matched, true);
   assert.strictEqual(match.scheduledTime, '23:58');
   assert.strictEqual(match.delayMinutes, 5); // 5 minutes late relative to 23:58
   ```

3. **Invalidation Conditions**:
   - Any departure schema missing `delayMins` when `delayMinutes` is present.
   - Any departure schema where `isRealTime !== isRealtime`.
   - Any `delayStatus` producing legacy non-canonical values (e.g. `'ontime'` or `'on-time'`).
   - `estimateStopTravelTimes` producing `NaN` on invalid or missing stop coordinates.
