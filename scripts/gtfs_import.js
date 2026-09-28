'use strict';

/**
 * scripts/gtfs_import.js
 *
 * Streams ATM GTFS feed (agency, routes, trips, calendar, calendar_dates, stop_times)
 * and produces per-trip dayTrips structure without any npm dependencies.
 *
 * Usage:
 *   node scripts/gtfs_import.js <gtfs-dir> --agency MAT_1 --out <file.json>
 *
 * Invariant: stop_times.txt is ~220 MB; stream it strictly with readline,
 * never readFileSync the entire file.
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"') {
        inQuote = true;
      } else if (c === ',') {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
  }
  out.push(cur.trim());
  return out;
}

function timeToSec(hhmmss) {
  if (!hhmmss) return null;
  const parts = String(hhmmss).split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const s = parts[2] ? parseInt(parts[2], 10) : 0;
  if (isNaN(h) || isNaN(m)) return null;
  return h * 3600 + m * 60 + s;
}

function dateToDayType(yyyymmdd) {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const date = new Date(Date.UTC(y, m, d, 12, 0, 0));
  const day = date.getUTCDay(); // 0 = Sun, 6 = Sat
  if (day === 0) return 'sunday';
  if (day === 6) return 'saturday';
  return 'weekday';
}

async function importGtfs(gtfsDir, targetAgency, outFile) {
  console.log(`[GTFS Import] Reading GTFS directory: ${gtfsDir}`);
  console.log(`[GTFS Import] Target agency: ${targetAgency}`);

  // 1. Verify agency
  const agencyFile = path.join(gtfsDir, 'agency.txt');
  if (!fs.existsSync(agencyFile)) throw new Error(`agency.txt not found in ${gtfsDir}`);
  const agencyLines = fs.readFileSync(agencyFile, 'utf8').split(/\r?\n/).filter(Boolean);
  const agencyHeader = parseCsvLine(agencyLines[0]);
  const agencyIdIdx = agencyHeader.indexOf('agency_id');
  const targetAgencies = new Set();
  for (let i = 1; i < agencyLines.length; i++) {
    const cols = parseCsvLine(agencyLines[i]);
    if (cols[agencyIdIdx] === targetAgency) {
      targetAgencies.add(cols[agencyIdIdx]);
    }
  }
  if (targetAgencies.size === 0) {
    throw new Error(`Agency ${targetAgency} not found in agency.txt`);
  }
  console.log(`[GTFS Import] Found agency ${targetAgency}`);

  // 2. Read routes
  const routesFile = path.join(gtfsDir, 'routes.txt');
  const routeLines = fs.readFileSync(routesFile, 'utf8').split(/\r?\n/).filter(Boolean);
  const routeHeader = parseCsvLine(routeLines[0]);
  const rAgencyIdx = routeHeader.indexOf('agency_id');
  const rIdIdx = routeHeader.indexOf('route_id');
  const rShortIdx = routeHeader.indexOf('route_short_name');
  const rLongIdx = routeHeader.indexOf('route_long_name');
  const rColorIdx = routeHeader.indexOf('route_color');

  const agencyRoutes = new Map(); // route_id -> { routeId, shortName, longName, color }
  for (let i = 1; i < routeLines.length; i++) {
    const cols = parseCsvLine(routeLines[i]);
    if (targetAgencies.has(cols[rAgencyIdx])) {
      const rId = cols[rIdIdx];
      agencyRoutes.set(rId, {
        routeId: rId,
        shortName: cols[rShortIdx] || '',
        longName: cols[rLongIdx] || '',
        color: cols[rColorIdx] ? `#${cols[rColorIdx]}` : '#009485'
      });
    }
  }
  console.log(`[GTFS Import] Found ${agencyRoutes.size} routes for ${targetAgency}`);

  // 3. Read calendar & calendar_dates to map service_id -> dayType
  const serviceDayTypes = new Map(); // service_id -> 'weekday' | 'saturday' | 'sunday'

  const calFile = path.join(gtfsDir, 'calendar.txt');
  if (fs.existsSync(calFile)) {
    const calLines = fs.readFileSync(calFile, 'utf8').split(/\r?\n/).filter(Boolean);
    const calHeader = parseCsvLine(calLines[0]);
    const sIdIdx = calHeader.indexOf('service_id');
    const monIdx = calHeader.indexOf('monday');
    const satIdx = calHeader.indexOf('saturday');
    const sunIdx = calHeader.indexOf('sunday');
    for (let i = 1; i < calLines.length; i++) {
      const cols = parseCsvLine(calLines[i]);
      const sId = cols[sIdIdx];
      if (cols[sunIdx] === '1') serviceDayTypes.set(sId, 'sunday');
      else if (cols[satIdx] === '1') serviceDayTypes.set(sId, 'saturday');
      else if (cols[monIdx] === '1') serviceDayTypes.set(sId, 'weekday');
    }
  }

  const calDatesFile = path.join(gtfsDir, 'calendar_dates.txt');
  if (fs.existsSync(calDatesFile)) {
    const cdLines = fs.readFileSync(calDatesFile, 'utf8').split(/\r?\n/).filter(Boolean);
    const cdHeader = parseCsvLine(cdLines[0]);
    const cdSIdIdx = cdHeader.indexOf('service_id');
    const cdDateIdx = cdHeader.indexOf('date');
    const cdTypeIdx = cdHeader.indexOf('exception_type');
    for (let i = 1; i < cdLines.length; i++) {
      const cols = parseCsvLine(cdLines[i]);
      const sId = cols[cdSIdIdx];
      const dateStr = cols[cdDateIdx];
      const exType = cols[cdTypeIdx];
      if (exType === '1' && !serviceDayTypes.has(sId) && dateStr) {
        serviceDayTypes.set(sId, dateToDayType(dateStr));
      }
    }
  }
  console.log(`[GTFS Import] Mapped ${serviceDayTypes.size} service_ids to day types.`);

  // 4. Read stops
  const stopsFile = path.join(gtfsDir, 'stops.txt');
  const stopsMap = new Map(); // stop_id -> { stopId, name, lat, lon }
  if (fs.existsSync(stopsFile)) {
    const stopLines = fs.readFileSync(stopsFile, 'utf8').split(/\r?\n/).filter(Boolean);
    const sHeader = parseCsvLine(stopLines[0]);
    const sIdIdx = sHeader.indexOf('stop_id');
    const sNameIdx = sHeader.indexOf('stop_name');
    const sLatIdx = sHeader.indexOf('stop_lat');
    const sLonIdx = sHeader.indexOf('stop_lon');
    for (let i = 1; i < stopLines.length; i++) {
      const cols = parseCsvLine(stopLines[i]);
      const sId = cols[sIdIdx];
      stopsMap.set(sId, {
        stopId: sId,
        name: cols[sNameIdx] || '',
        lat: parseFloat(cols[sLatIdx] || '0'),
        lon: parseFloat(cols[sLonIdx] || '0')
      });
    }
  }
  console.log(`[GTFS Import] Loaded ${stopsMap.size} total stops catalog.`);

  // 5. Read trips for our agency routes
  const tripsFile = path.join(gtfsDir, 'trips.txt');
  const tripLines = fs.readFileSync(tripsFile, 'utf8').split(/\r?\n/).filter(Boolean);
  const tripHeader = parseCsvLine(tripLines[0]);
  const tRouteIdx = tripHeader.indexOf('route_id');
  const tIdIdx = tripHeader.indexOf('trip_id');
  const tDirIdx = tripHeader.indexOf('direction_id');
  const tServiceIdx = tripHeader.indexOf('service_id');
  const tHeadsignIdx = tripHeader.indexOf('trip_headsign');
  const tShortNameIdx = tripHeader.indexOf('trip_short_name');

  const agencyTrips = new Map(); // trip_id -> { tripId, routeId, directionId, serviceId, dayType, headsign, stops: [] }
  for (let i = 1; i < tripLines.length; i++) {
    const cols = parseCsvLine(tripLines[i]);
    const rId = cols[tRouteIdx];
    if (agencyRoutes.has(rId)) {
      const tId = cols[tIdIdx];
      const sId = cols[tServiceIdx];
      const dayType = serviceDayTypes.get(sId) || 'weekday';
      agencyTrips.set(tId, {
        tripId: tId,
        routeId: rId,
        directionId: cols[tDirIdx] !== '' ? String(cols[tDirIdx]) : '0',
        serviceId: sId,
        dayType,
        headsign: cols[tHeadsignIdx] || cols[tShortNameIdx] || '',
        stops: [] // filled by stop_times stream
      });
    }
  }
  console.log(`[GTFS Import] Identified ${agencyTrips.size} agency trips to extract.`);

  // 6. Stream stop_times.txt (220 MB) with readline
  const stopTimesFile = path.join(gtfsDir, 'stop_times.txt');
  if (!fs.existsSync(stopTimesFile)) throw new Error(`stop_times.txt not found in ${gtfsDir}`);

  console.log(`[GTFS Import] Streaming ${stopTimesFile} with readline...`);
  const fileStream = fs.createReadStream(stopTimesFile, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let lineCount = 0;
  let matchedStopsCount = 0;
  let stTripIdx = -1;
  let stArrIdx = -1;
  let stDepIdx = -1;
  let stStopIdx = -1;
  let stSeqIdx = -1;

  for await (const line of rl) {
    lineCount++;
    if (lineCount === 1) {
      const header = parseCsvLine(line);
      stTripIdx = header.indexOf('trip_id');
      stArrIdx = header.indexOf('arrival_time');
      stDepIdx = header.indexOf('departure_time');
      stStopIdx = header.indexOf('stop_id');
      stSeqIdx = header.indexOf('stop_sequence');
      continue;
    }

    // Fast preliminary prefix/submatch filter before CSV parsing
    // Only trips for MAT_1 have trip IDs starting with MAT_
    if (!line.startsWith('MAT_') && !agencyTrips.has(line.slice(0, line.indexOf(',')))) {
      continue;
    }

    const cols = parseCsvLine(line);
    const tripId = cols[stTripIdx];
    const trip = agencyTrips.get(tripId);
    if (!trip) continue;

    const stopId = cols[stStopIdx];
    const seq = parseInt(cols[stSeqIdx], 10);
    const timeStr = cols[stDepIdx] || cols[stArrIdx];
    const timeSec = timeToSec(timeStr);

    trip.stops.push({
      stopId,
      seq: isNaN(seq) ? trip.stops.length : seq,
      timeStr,
      timeSec
    });
    matchedStopsCount++;
  }

  console.log(`[GTFS Import] Streamed ${lineCount} lines, matched ${matchedStopsCount} stop times.`);

  // 7. Build structured per-trip matrix (dayTrips)
  const output = {
    _meta: {
      agency: targetAgency,
      importedAt: new Date().toISOString(),
      source: 'ATM GTFS Feed',
      routesCount: agencyRoutes.size,
      tripsCount: agencyTrips.size,
      stopTimesCount: matchedStopsCount
    },
    routes: {}
  };

  // Group trips by route and direction
  for (const [rId, rMeta] of agencyRoutes.entries()) {
    output.routes[rId] = {
      routeId: rId,
      shortName: rMeta.shortName,
      longName: rMeta.longName,
      color: rMeta.color,
      directions: {}
    };
  }

  for (const trip of agencyTrips.values()) {
    if (trip.stops.length === 0) continue;
    trip.stops.sort((a, b) => a.seq - b.seq);

    const rObj = output.routes[trip.routeId];
    if (!rObj) continue;

    if (!rObj.directions[trip.directionId]) {
      // Determine canonical stop sequence for this direction from first trip
      const dirStops = trip.stops.map(s => {
        const globalStop = stopsMap.get(s.stopId) || {};
        return {
          id: s.stopId,
          cleanId: s.stopId.replace(/^MAT_/, ''),
          name: globalStop.name || s.stopId,
          lat: globalStop.lat || null,
          lon: globalStop.lon || null
        };
      });

      rObj.directions[trip.directionId] = {
        directionId: trip.directionId,
        headsign: trip.headsign,
        stops: dirStops,
        dayTrips: {
          weekday: [],
          saturday: [],
          sunday: []
        }
      };
    }

    const dirObj = rObj.directions[trip.directionId];
    const stopIdToIndex = new Map(dirObj.stops.map((s, idx) => [s.id, idx]));

    // Map times to the direction stop positions
    const sArray = new Array(dirObj.stops.length).fill(null);
    for (const st of trip.stops) {
      const idx = stopIdToIndex.get(st.stopId);
      if (idx !== undefined && st.timeSec !== null) {
        sArray[idx] = st.timeSec;
      }
    }

    const dayKey = ['weekday', 'saturday', 'sunday'].includes(trip.dayType) ? trip.dayType : 'weekday';
    dirObj.dayTrips[dayKey].push({
      tripId: trip.tripId,
      s: sArray
    });
  }

  // Sort trips in each dayType by first departure time
  for (const rObj of Object.values(output.routes)) {
    for (const dirObj of Object.values(rObj.directions)) {
      for (const dayKey of ['weekday', 'saturday', 'sunday']) {
        dirObj.dayTrips[dayKey].sort((a, b) => {
          const aFirst = a.s.find(t => t !== null) ?? 0;
          const bFirst = b.s.find(t => t !== null) ?? 0;
          return aFirst - bFirst;
        });
      }
    }
  }

  // 8. Write output JSON
  const targetPath = path.resolve(outFile);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`[GTFS Import] ✅ Successfully exported GTFS dayTrips to: ${targetPath}`);
  return output;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let gtfsDir = 'data/atm_gtfs';
  let agency = 'MAT_1';
  let outFile = 'data/atm_gtfs_mataro.json';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agency' && args[i + 1]) {
      agency = args[++i];
    } else if (args[i] === '--out' && args[i + 1]) {
      outFile = args[++i];
    } else if (!args[i].startsWith('--')) {
      gtfsDir = args[i];
    }
  }

  importGtfs(gtfsDir, agency, outFile)
    .then(() => process.exit(0))
    .catch(err => {
      console.error(`[GTFS Import Error]: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { importGtfs, parseCsvLine, timeToSec, dateToDayType };
