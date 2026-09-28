'use strict';

/**
 * scripts/export_gtfs.js
 *
 * Exports official Mataró Bus Urbà per-trip scheduled timetables (L1–L8)
 * as a standard static GTFS feed (General Transit Feed Specification).
 *
 * Generated files:
 *   - agency.txt
 *   - routes.txt
 *   - stops.txt
 *   - calendar.txt
 *   - calendar_dates.txt
 *   - trips.txt
 *   - stop_times.txt
 *   - feed_info.txt
 *
 * Usage:
 *   node scripts/export_gtfs.js [--out <output_directory>]
 *
 * Zero new production npm dependencies (native node:fs and node:path only).
 */

const fs = require('node:fs');
const path = require('node:path');
const tripMatcher = require('../src/core/schedule/tripMatcher');
const seasonCalendar = require('../src/data/seasonCalendar');

const SEASONS_DATA_PATH = path.join(__dirname, '..', 'src', 'data', 'mataro_schedules.seasons.json');
const HOLIDAYS_PATH = path.join(__dirname, '..', 'src', 'data', 'holidays.json');

const LINE_METADATA = {
  '1': { code: 'L1', name: 'Circular (Estació Rodalies - Cirera)', color: 'FF00FF', textColor: 'FFFFFF' },
  '2': { code: 'L2', name: 'Circular (Estació Rodalies - Cirera)', color: '804000', textColor: 'FFFFFF' },
  '3': { code: 'L3', name: 'Camí de la Serra - Vista Alegre - Rocafonda', color: '808080', textColor: 'FFFFFF' },
  '4': { code: 'L4', name: 'Cirera - Els Molins', color: 'FF0000', textColor: 'FFFFFF' },
  '5': { code: 'L5', name: 'Estació Rodalies - Hospital de Mataró', color: '00EA00', textColor: '000000' },
  '6': { code: 'L6', name: 'Institut Català de la Salut - Ctra. de Mata', color: 'FEBF01', textColor: '000000' },
  '7': { code: 'L7', name: 'Plaça de les Tereses - Cerdanyola', color: '80FFFF', textColor: '000000' },
  '8': { code: 'L8', name: 'Estació Rodalies - Galícia', color: '008040', textColor: 'FFFFFF' }
};

function formatGtfsTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function csvRow(fields) {
  return fields.map(f => {
    if (f === null || f === undefined) return '';
    const str = String(f);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }).join(',');
}

function exportGtfs(targetDir = null) {
  const outDir = targetDir || path.join(__dirname, '..', 'data', 'gtfs_export');
  fs.mkdirSync(outDir, { recursive: true });

  const rawSeasons = JSON.parse(fs.readFileSync(SEASONS_DATA_PATH, 'utf8'));
  const seasons = rawSeasons.seasons || {};
  // The feed spans every year the holiday calendar covers; day type and season
  // for each date come from the same resolvers the app uses, so the feed can
  // never disagree with the boards.
  let years = [];
  try {
    years = Object.keys(JSON.parse(fs.readFileSync(HOLIDAYS_PATH, 'utf8')).years || {})
      .map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  } catch { years = []; }
  if (years.length === 0) {
    years = [Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric' }).format(new Date()))];
  }
  const firstYear = years[0];
  const lastYear = years[years.length - 1];
  const feedStart = `${firstYear}0101`;
  const feedEnd = `${lastYear}1231`;

  // 1. agency.txt
  const agencyRows = [
    csvRow(['agency_id', 'agency_name', 'agency_url', 'agency_timezone', 'agency_lang', 'agency_phone']),
    csvRow(['MAT_1', 'Mataró Bus (Avanza)', 'https://mataro.avanzagrupo.com', 'Europe/Madrid', 'ca', '900859900'])
  ];
  fs.writeFileSync(path.join(outDir, 'agency.txt'), agencyRows.join('\r\n') + '\r\n', 'utf8');

  // 2. routes.txt
  const routeRows = [
    csvRow(['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color', 'route_text_color'])
  ];
  for (let l = 1; l <= 8; l++) {
    const lStr = String(l);
    const meta = LINE_METADATA[lStr];
    routeRows.push(csvRow([
      lStr,
      'MAT_1',
      meta.code,
      meta.name,
      '3', // 3 = Bus
      meta.color,
      meta.textColor
    ]));
  }
  fs.writeFileSync(path.join(outDir, 'routes.txt'), routeRows.join('\r\n') + '\r\n', 'utf8');

  // 3. stops.txt (gather unique stops from both seasons)
  const stopsMap = new Map();
  for (const seasonKey of ['winter', 'summer']) {
    const seasonData = seasons[seasonKey] || {};
    for (let l = 1; l <= 8; l++) {
      const lineData = seasonData[String(l)];
      if (!lineData?.directions) continue;
      for (const dirKey of Object.keys(lineData.directions)) {
        const dir = lineData.directions[dirKey];
        if (!Array.isArray(dir.stops)) continue;
        for (const stop of dir.stops) {
          const sId = String(stop.id);
          if (!stopsMap.has(sId)) {
            stopsMap.set(sId, {
              id: sId,
              name: stop.name || `Parada ${sId}`,
              lat: Number.isFinite(stop.lat) ? stop.lat : 41.538,
              lon: Number.isFinite(stop.lon) ? stop.lon : 2.444
            });
          }
        }
      }
    }
  }

  const stopRows = [
    csvRow(['stop_id', 'stop_name', 'stop_lat', 'stop_lon', 'location_type'])
  ];
  for (const stop of stopsMap.values()) {
    stopRows.push(csvRow([
      stop.id,
      stop.name,
      stop.lat.toFixed(6),
      stop.lon.toFixed(6),
      '0' // 0 = Stop / Platform
    ]));
  }
  fs.writeFileSync(path.join(outDir, 'stops.txt'), stopRows.join('\r\n') + '\r\n', 'utf8');

  // 4. calendar.txt
  const calendarRows = [
    csvRow(['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date']),
    csvRow(['winter_weekday', '0', '0', '0', '0', '0', '0', '0', feedStart, feedEnd]),
    csvRow(['winter_saturday', '0', '0', '0', '0', '0', '0', '0', feedStart, feedEnd]),
    csvRow(['winter_sunday', '0', '0', '0', '0', '0', '0', '0', feedStart, feedEnd]),
    csvRow(['summer_weekday', '0', '0', '0', '0', '0', '0', '0', feedStart, feedEnd]),
    csvRow(['summer_saturday', '0', '0', '0', '0', '0', '0', '0', feedStart, feedEnd]),
    csvRow(['summer_sunday', '0', '0', '0', '0', '0', '0', '0', feedStart, feedEnd])
  ];
  fs.writeFileSync(path.join(outDir, 'calendar.txt'), calendarRows.join('\r\n') + '\r\n', 'utf8');

  // 5. calendar_dates.txt (exceptions: summer weekday override and public holidays)
  const calendarDateRows = [
    csvRow(['service_id', 'date', 'exception_type'])
  ];

  for (let t = Date.UTC(firstYear, 0, 1); t <= Date.UTC(lastYear, 11, 31); t += 86400000) {
    const d = new Date(t);
    const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 10, 0, 0); // midday in Madrid
    const { dayType } = tripMatcher.resolveDayType(at);
    const { season } = seasonCalendar.resolveSeason(at);
    calendarDateRows.push(csvRow([`${season}_${dayType}`, ymd, '1']));
  }
  fs.writeFileSync(path.join(outDir, 'calendar_dates.txt'), calendarDateRows.join('\r\n') + '\r\n', 'utf8');

  // 6. trips.txt & 7. stop_times.txt
  const tripRows = [
    csvRow(['route_id', 'service_id', 'trip_id', 'trip_headsign', 'direction_id'])
  ];
  const stopTimeRows = [
    csvRow(['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'])
  ];

  let totalTrips = 0;
  let totalStopTimes = 0;

  for (const seasonKey of ['winter', 'summer']) {
    const seasonData = seasons[seasonKey] || {};
    for (let l = 1; l <= 8; l++) {
      const lineId = String(l);
      const lineData = seasonData[lineId];
      if (!lineData?.directions) continue;

      for (const dirKey of Object.keys(lineData.directions)) {
        const dir = lineData.directions[dirKey];
        if (!dir?.dayTrips || !Array.isArray(dir.stops)) continue;

        // Binary direction_id: 0 for first direction (e.g. '11' or '0'), 1 for second direction ('12' or '1')
        const directionId = (dirKey === '11' || dirKey === '0') ? '0' : '1';
        const headsign = dir.headsign || dir.directionName || dir.stops[dir.stops.length - 1]?.name || `L${lineId}`;

        // Only export canonical day keys to prevent duplicate trip counts from language aliases
        for (const dayKey of ['weekday', 'saturday', 'sunday']) {
          const rawTrips = dir.dayTrips[dayKey] || [];
          const serviceId = `${seasonKey}_${dayKey}`;

          rawTrips.forEach((trip, tIdx) => {
            if (!Array.isArray(trip.s)) return;

            // Collect valid stop times for this trip
            const validStops = [];
            trip.s.forEach((timeSec, sIdx) => {
              if (Number.isFinite(timeSec) && dir.stops[sIdx]) {
                validStops.push({
                  stopId: String(dir.stops[sIdx].id),
                  sec: timeSec
                });
              }
            });

            // Referential invariant: Every trip must have at least 2 stop times
            if (validStops.length >= 2) {
              const tripId = `${serviceId}_L${lineId}_d${dirKey}_${tIdx + 1}`;
              totalTrips++;

              tripRows.push(csvRow([
                lineId,
                serviceId,
                tripId,
                headsign,
                directionId
              ]));

              validStops.forEach((st, seqIdx) => {
                totalStopTimes++;
                const timeStr = formatGtfsTime(st.sec);
                stopTimeRows.push(csvRow([
                  tripId,
                  timeStr,
                  timeStr,
                  st.stopId,
                  String(seqIdx + 1)
                ]));
              });
            }
          });
        }
      }
    }
  }

  fs.writeFileSync(path.join(outDir, 'trips.txt'), tripRows.join('\r\n') + '\r\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'stop_times.txt'), stopTimeRows.join('\r\n') + '\r\n', 'utf8');

  // 8. feed_info.txt
  const feedInfoRows = [
    csvRow(['feed_publisher_name', 'feed_publisher_url', 'feed_lang', 'feed_start_date', 'feed_end_date', 'feed_version']),
    csvRow(['Arribo! Transit Platform', 'https://arribo.cat', 'ca', feedStart, feedEnd, '3.0.0'])
  ];
  fs.writeFileSync(path.join(outDir, 'feed_info.txt'), feedInfoRows.join('\r\n') + '\r\n', 'utf8');

  const summary = {
    outputDirectory: outDir,
    agencyCount: 1,
    routesCount: 8,
    stopsCount: stopsMap.size,
    servicesCount: 6,
    calendarExceptionsCount: calendarDateRows.length - 1,
    tripsCount: totalTrips,
    stopTimesCount: totalStopTimes
  };

  return summary;
}

// CLI execution
if (require.main === module) {
  const args = process.argv.slice(2);
  let outDir = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) {
      outDir = path.resolve(args[i + 1]);
      i++;
    }
  }

  try {
    const summary = exportGtfs(outDir);
    console.log('=== Arribo! Mataró Bus Static GTFS Export Completed ===');
    console.log(`Directory:            ${summary.outputDirectory}`);
    console.log(`Agency records:       ${summary.agencyCount}`);
    console.log(`Routes (L1–L8):       ${summary.routesCount}`);
    console.log(`Stops:                ${summary.stopsCount}`);
    console.log(`Services:             ${summary.servicesCount}`);
    console.log(`Calendar Exceptions:  ${summary.calendarExceptionsCount}`);
    console.log(`Trips:                ${summary.tripsCount}`);
    console.log(`Stop Times:           ${summary.stopTimesCount}`);
    console.log('\n--- How to compress into a distributable GTFS zip archive ---');
    console.log('Linux / macOS:');
    console.log(`  cd "${summary.outputDirectory}" && zip -r mataro_gtfs.zip .`);
    console.log('Windows PowerShell:');
    console.log(`  Compress-Archive -Path "${summary.outputDirectory}\\*" -DestinationPath "${summary.outputDirectory}\\mataro_gtfs.zip"`);
  } catch (err) {
    console.error('GTFS Export failed:', err.message);
    process.exit(1);
  }
}

module.exports = { exportGtfs, formatGtfsTime, csvRow };
