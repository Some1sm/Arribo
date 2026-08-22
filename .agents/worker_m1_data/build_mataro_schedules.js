/**
 * .agents/worker_m1_data/build_mataro_schedules.js
 * 
 * Builder script to compile the authoritative Mataró Bus schedules,
 * stop sequences, cumulative run times, and metadata into src/data/mataro_schedules.json.
 */

const fs = require('fs');
const path = require('path');
const geoEngine = require('../../src/core/geo/geoEngine');
const scheduleSynthesizer = require('../../src/core/schedule/scheduleSynthesizer');

const minedSchedulesPath = path.join(__dirname, '../spec_miner_mataro_timetables/mataro_authoritative_schedules.json');
const routesFullPath = path.join(__dirname, '../../data/cities/mataro/mataro_routes_full.json');
const linesPath = path.join(__dirname, '../../data/cities/mataro/mataro_lineas.json');
const stopsPath = path.join(__dirname, '../../data/cities/mataro/mataro_paradas.json');

const minedSchedules = JSON.parse(fs.readFileSync(minedSchedulesPath, 'utf8'));
const routesFull = JSON.parse(fs.readFileSync(routesFullPath, 'utf8'));
const linesList = JSON.parse(fs.readFileSync(linesPath, 'utf8')).message;
const stopsList = JSON.parse(fs.readFileSync(stopsPath, 'utf8')).message;

const stopsMap = new Map();
stopsList.forEach(s => stopsMap.set(String(s.id), s));

console.log('Ingesting authoritative timetables and calculating cumulative run times...');

const compiled = {};

for (const line of linesList) {
  const lineId = String(line.id);
  const minedLine = minedSchedules[lineId] || {};
  const routes = routesFull[lineId] || [];

  compiled[lineId] = {
    lineId: lineId,
    code: lineId,
    lineName: line.name.trim(),
    color: line.color || '#009485',
    agency: 'Mataró Bus',
    operator: 'CTSA / Avanza',
    mode: 'Urbà Mataró',
    directions: {},
    directionIndices: {}
  };

  // Process standard routes from routesFull
  routes.forEach((route, dirIdx) => {
    const pathId = String(route.id);
    const minedDir = minedLine.directions ? minedLine.directions[pathId] : null;

    const polyCoords = (route.coords || []).map(c => ({
      lat: parseFloat(c.Latitude),
      lon: parseFloat(c.Longitude)
    }));
    const totalDistMeters = Math.round(geoEngine.calculateRouteTotalDistance(polyCoords));

    const stopTravelTimes = scheduleSynthesizer.estimateStopTravelTimes(route.stops || [], {
      speedMps: 4.8, // ~17.3 km/h
      dwellSecPerStop: 25,
      defaultSegmentMeters: 300
    });

    const stopTravelSecMap = {};
    const detailedStops = (route.stops || []).map((s, sIdx) => {
      const globalStop = stopsMap.get(String(s.id)) || {};
      const st = stopTravelTimes[sIdx] || { travelSec: 0, travelMinutes: 0, segmentMeters: 0, cumulativeMeters: 0, dwellSec: 0 };
      const stopId = String(s.id);
      stopTravelSecMap[stopId] = st.travelSec;
      return {
        id: stopId,
        seq: sIdx + 1,
        name: (s.name || globalStop.name || '').replace(/ - \d+$/, '').trim(),
        lat: parseFloat(s.latitude || globalStop.latitude || 0),
        lon: parseFloat(s.longitude || globalStop.longitude || 0),
        segmentMeters: st.segmentMeters,
        cumulativeMeters: st.cumulativeMeters,
        dwellSec: st.dwellSec,
        travelSec: st.travelSec,
        travelMinutes: st.travelMinutes
      };
    });

    const totalTravelSec = detailedStops.length > 0 ? detailedStops[detailedStops.length - 1].travelSec : 0;
    const totalTravelMinutes = Math.round(totalTravelSec / 60);

    const rawSchedules = minedDir ? (minedDir.schedules || {}) : {};
    const feiners = rawSchedules['Feiners'] || [];
    const dissabtes = rawSchedules['Dissabtes'] || [];
    const diumenges = rawSchedules['Diumenges i Festius'] || [];

    const isAfternoonSaturday = lineId === '8' && (dissabtes.length > 0 && dissabtes[0] >= '14:00');
    const isAfternoonSunday = (lineId === '8' || lineId === '6') && (diumenges.length > 0 && diumenges[0] >= '14:00');

    const schedulesObj = {
      'Feiners': feiners,
      'Dissabtes': dissabtes,
      'Diumenges i Festius': diumenges,
      'weekday': feiners,
      'saturday': dissabtes,
      'sunday': diumenges,
      'festius': diumenges
    };

    const dirEntry = {
      dirId: String(dirIdx),
      pathId: pathId,
      direction: minedDir ? minedDir.direction : (dirIdx === 0 ? 'I' : 'V'),
      directionName: route.name || (minedDir ? minedDir.directionName : ('Direcció ' + pathId)),
      originStop: detailedStops[0] ? { id: detailedStops[0].id, name: detailedStops[0].name } : null,
      terminalStop: detailedStops.length > 0 ? { id: detailedStops[detailedStops.length - 1].id, name: detailedStops[detailedStops.length - 1].name } : null,
      stopsCount: detailedStops.length,
      totalDistanceMeters: totalDistMeters,
      totalDistanceKm: Number((totalDistMeters / 1000).toFixed(2)),
      totalTravelSec: totalTravelSec,
      totalTravelMinutes: totalTravelMinutes,
      afternoonOnly: {
        weekday: false,
        saturday: Boolean(isAfternoonSaturday),
        sunday: Boolean(isAfternoonSunday)
      },
      schedules: schedulesObj,
      scheduleStats: {
        weekday: { count: feiners.length, first: feiners[0] || null, last: feiners[feiners.length - 1] || null },
        saturday: { count: dissabtes.length, first: dissabtes[0] || null, last: dissabtes[dissabtes.length - 1] || null },
        sunday: { count: diumenges.length, first: diumenges[0] || null, last: diumenges[diumenges.length - 1] || null }
      },
      stopTravelSecMap: stopTravelSecMap,
      stops: detailedStops
    };

    compiled[lineId].directions[pathId] = dirEntry;
    compiled[lineId].directionIndices[String(dirIdx)] = dirEntry;
  });

  // Also include variant directions from minedLine (e.g. path 21)
  if (minedLine.directions) {
    for (const [pId, mDir] of Object.entries(minedLine.directions)) {
      if (!compiled[lineId].directions[pId]) {
        const baseDir = compiled[lineId].directions['11'] || compiled[lineId].directions['12'] || Object.values(compiled[lineId].directions)[0];
        const rawSchedules = mDir.schedules || {};
        const feiners = rawSchedules['Feiners'] || [];
        const dissabtes = rawSchedules['Dissabtes'] || [];
        const diumenges = rawSchedules['Diumenges i Festius'] || [];

        compiled[lineId].directions[pId] = {
          dirId: pId,
          pathId: pId,
          direction: mDir.direction || 'I',
          directionName: mDir.directionName || ('Variant ' + pId),
          originStop: mDir.originStop || (baseDir ? baseDir.originStop : null),
          terminalStop: mDir.terminalStop || (baseDir ? baseDir.terminalStop : null),
          stopsCount: baseDir ? baseDir.stopsCount : 0,
          totalDistanceMeters: baseDir ? baseDir.totalDistanceMeters : 0,
          totalDistanceKm: baseDir ? baseDir.totalDistanceKm : 0,
          totalTravelSec: baseDir ? baseDir.totalTravelSec : 0,
          totalTravelMinutes: baseDir ? baseDir.totalTravelMinutes : 0,
          afternoonOnly: {
            weekday: false,
            saturday: false,
            sunday: false
          },
          schedules: {
            'Feiners': feiners,
            'Dissabtes': dissabtes,
            'Diumenges i Festius': diumenges,
            'weekday': feiners,
            'saturday': dissabtes,
            'sunday': diumenges,
            'festius': diumenges
          },
          scheduleStats: {
            weekday: { count: feiners.length, first: feiners[0] || null, last: feiners[feiners.length - 1] || null },
            saturday: { count: dissabtes.length, first: dissabtes[0] || null, last: dissabtes[dissabtes.length - 1] || null },
            sunday: { count: diumenges.length, first: diumenges[0] || null, last: diumenges[diumenges.length - 1] || null }
          },
          stopTravelSecMap: baseDir ? baseDir.stopTravelSecMap : {},
          stops: baseDir ? baseDir.stops : []
        };
      }
    }
  }
}

const targetDir = path.join(__dirname, '../../src/data');
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

const targetFile = path.join(targetDir, 'mataro_schedules.json');
fs.writeFileSync(targetFile, JSON.stringify(compiled, null, 2), 'utf8');

console.log('✅ Generated ' + targetFile + ' successfully.');
console.log('Size: ' + fs.statSync(targetFile).size + ' bytes');
