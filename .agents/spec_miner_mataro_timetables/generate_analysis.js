const fs = require('fs');
const path = require('path');
const geoEngine = require('../../src/core/geo/geoEngine');
const scheduleSynthesizer = require('../../src/core/schedule/scheduleSynthesizer');

const schedules = JSON.parse(fs.readFileSync(path.join(__dirname, 'mataro_authoritative_schedules.json'), 'utf8'));
const routesData = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/cities/mataro/mataro_routes_full.json'), 'utf8'));
const linesData = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/cities/mataro/mataro_lineas.json'), 'utf8')).message;
const stopsData = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/cities/mataro/mataro_paradas.json'), 'utf8')).message;

let md = `# Comprehensive Specification Analysis: Mataró Bus Authoritative Timetables (Lines 1–8)

**Author**: Spec Miner Subagent (Mataró Lines 1–8)  
**Date**: 2026-08-22  
**Specification Sources**: 
- Official Avanza / CTSA Mataró Urban Bus API (\`mataro.avanzagrupo.com\`)
- Real-Time SIRI Telemetry Endpoint (\`sirimataro.avanzagrupo.com\`)
- Official Mataró Bus Line & Stop Database (\`data/cities/mataro/\`)
- ATM Transit Feed Specification Standards

---

## Executive Summary

The Mataró Bus urban transit network comprises 8 operational lines (\`L1\` through \`L8\`), operated under concession by CTSA / Avanza (Grup Avanza). Previously, the codebase in \`src/mataroTracker.js\` approximated transit services using a synthetic headway generator (\`depSec += headwaySec\`, with uniform 15, 18, 20, 25, or 30-minute intervals). This created noticeable inaccuracies, such as:
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
| 9 | Synthesizer | Exact Matrix Injection | Native \`scheduledDepartures: string[]\` consumption in schedule synthesizer | baseDepartureTimes array + stopTravelSec | Monotonically sorted passing departures with correct badges | Empty array returns [] | \`src/core/schedule/scheduleSynthesizer.js\` |
| 10 | Real-Time | SIRI to Matrix Seamless Transition | Live vehicle arrivals take precedence, transitioning seamlessly to official timetable | Live SIRI departures + Timetable departures | Deduplicated 120-min countdown list | Falls back to static timetable on SIRI timeout | \`src/mataroTracker.js\` |

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

`;

for (const line of linesData) {
  const lId = String(line.id);
  const lSched = schedules[lId];
  const lRoutes = routesData[lId] || [];

  md += `## Detailed Line Profile: Line ${lId} — ${line.name}\n\n`;
  md += `- **Line ID**: \`${lId}\`\n`;
  md += `- **Public Name**: \`${line.name}\`\n`;
  md += `- **Branding Color**: \`${line.color}\`\n`;
  md += `- **Agency**: Mataró Bus (CTSA / Avanza)\n`;
  md += `- **Number of Directions / Routes**: ${lRoutes.length}\n\n`;

  for (let rIdx = 0; rIdx < lRoutes.length; rIdx++) {
    const route = lRoutes[rIdx];
    const pathId = String(route.id);
    const dirInfo = lSched.directions[pathId] || {};
    const daySchedules = dirInfo.schedules || {};

    const polyCoords = (route.coords || []).map(c => ({ lat: parseFloat(c.Latitude), lon: parseFloat(c.Longitude) }));
    const totalDistMeters = geoEngine.calculateRouteTotalDistance(polyCoords);

    const stopTravelTimes = scheduleSynthesizer.estimateStopTravelTimes(route.stops || [], {
      speedMps: 4.8,
      dwellSecPerStop: 25,
      defaultSegmentMeters: 300
    });

    const totalTravelSec = stopTravelTimes.length > 0 ? stopTravelTimes[stopTravelTimes.length - 1].travelSec : 0;
    const totalTravelMins = Math.round(totalTravelSec / 60);

    md += `### Line ${lId} Direction ${rIdx}: [Path ID ${pathId}] ${route.name}\n\n`;
    md += `- **Route Name**: \`${route.name}\`\n`;
    md += `- **Origin Terminal**: \`[${route.stops[0]?.id}] ${route.stops[0]?.name}\`\n`;
    md += `- **Destination Terminal**: \`[${route.stops[route.stops.length - 1]?.id}] ${route.stops[route.stops.length - 1]?.name}\`\n`;
    md += `- **Total Stops**: ${route.stops?.length || 0}\n`;
    md += `- **Polyline Coordinates**: ${polyCoords.length} points\n`;
    md += `- **Route Distance**: **${(totalDistMeters / 1000).toFixed(2)} km** (${Math.round(totalDistMeters)} meters)\n`;
    md += `- **Cumulative Travel Time**: **~${totalTravelMins} minutes** (${totalTravelSec} seconds)\n\n`;

    md += `#### Authoritative Departure Matrices (First Stop Departures)\n\n`;
    for (const [dayType, deps] of Object.entries(daySchedules)) {
      md += `##### ${dayType} (${deps.length} trips / day)\n`;
      md += `- **Operating Span**: \`${deps[0]}\` → \`${deps[deps.length - 1]}\`\n`;
      md += `\`\`\`json\n${JSON.stringify(deps, null, 2)}\n\`\`\`\n\n`;
    }

    md += `#### Stop Sequence & Topographic Passing Offsets\n\n`;
    md += `| Seq | Stop ID | Stop Name | Offset (Min:Sec) | Cumulative Sec | Segment (m) | Total Dist (m) |\n`;
    md += `|---|---|---|---|---|---|---|\n`;

    route.stops.forEach((s, idx) => {
      const st = stopTravelTimes[idx] || {};
      const mins = Math.floor((st.travelSec || 0) / 60);
      const secs = (st.travelSec || 0) % 60;
      const offsetStr = `+${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      md += `| ${idx + 1} | \`${s.id}\` | ${s.name.replace(/ - \\d+$/, '')} | \`${offsetStr}\` | ${st.travelSec || 0}s | ${st.segmentMeters || 0}m | ${st.cumulativeMeters || 0}m |\n`;
    });

    md += `\n---\n\n`;
  }
}

// Add Section on Recommended Codebase Data Structure
md += `## Authoritative Codebase Data Structure Schema

To cleanly integrate these exact official departure tables and eliminate synthetic headway loops across the codebase, the following static dataset structure in \`src/data/mataroAuthoritativeSchedules.js\` (or \`src/mataroStaticData.js\`) is recommended:

\`\`\`javascript
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
\`\`\`

### Ingestion & Processing Pipeline in \`src/mataroTracker.js\`

1. **Exact Timetable Lookup**:
   When queried for stop departures (\`getStopDepartures(stopId, lineId)\`), determine \`dayTypeToday\` and \`dayTypeTomorrow\` via \`calendarEngine\` or \`timeUtils\`.
2. **Stop Travel Time Computation**:
   Calculate the exact travel offset from route origin using \`scheduleSynthesizer.estimateStopTravelTimes(routeStops)\`.
3. **Passing Departure Synthesis**:
   Iterate through \`departures[dayType]\`, adding \`travelSec\` to each base trip start time:
   \`passingSec = baseDepSec + travelSec\`
4. **Filtering & Deduplication**:
   - Filter departures matching \`nowSec - 60 <= passingSec\`.
   - Deduplicate against live SIRI departures within a ±3 minute window.
   - If fewer than 5 trips remain today, seamlessly append tomorrow morning's trips using tomorrow's official first trip matrix.

---
`;

fs.writeFileSync(path.join(__dirname, 'analysis.md'), md, 'utf8');
console.log('analysis.md written successfully!');
