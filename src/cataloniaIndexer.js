const fs = require('fs');
const path = require('path');
const readline = require('readline');

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

const AGENCY_INFO_MAP = {
  'montferri': {
    officialName: 'E. MONTFERRI HNOS., S.L.',
    website: 'https://montferri.com/linies-regulars/',
    notice: 'Horaris regulars i modificacions de servei oficials a montferri.com'
  },
  'sagales': {
    officialName: 'Sagalés',
    website: 'https://www.sagales.com',
    notice: 'Xarxa d\'autobusos interurbans de Catalunya'
  },
  'moventis': {
    officialName: 'Moventis / Casas',
    website: 'https://www.moventis.es',
    notice: 'Línies interurbanes del Maresme i Catalunya'
  },
  'plana': {
    officialName: 'Empresa Plana',
    website: 'https://www.busplana.com',
    notice: 'Línies Camp de Tarragona i Costa Daurada'
  },
  'hife': {
    officialName: 'HIFE',
    website: 'https://www.hife.es',
    notice: 'Línies Terres de l\'Ebre i connexions'
  },
  'teisa': {
    officialName: 'TEISA',
    website: 'https://www.teisa-bus.com',
    notice: 'Línies Comarques Gironines'
  },
  'soler': {
    officialName: 'Soler i Sauret',
    website: 'https://www.solerisauret.com',
    notice: 'Línies Baix Llobregat'
  },
  'tusgsal': {
    officialName: 'DIREXIS TUSGSAL',
    website: 'https://www.tusgsal.cat',
    notice: 'Xarxa Barcelonès Nord'
  },
  'avanza': {
    officialName: 'Avanza (Baix Llobregat)',
    website: 'https://barcelona.avanzagrupo.com',
    notice: 'Xarxa Baix Llobregat'
  },
  'monbus': {
    officialName: 'Monbus',
    website: 'https://www.monbus.es',
    notice: 'Línies Igualadina i Aerobús'
  },
  'tgo': {
    officialName: 'DIREXIS TGO',
    website: 'https://www.tgocables.com',
    notice: 'Línies Vallès i Montserrat'
  }
};

class CataloniaIndexer {
  constructor() {
    this.gtfsDir = path.join(__dirname, '..', 'data', 'atm_gtfs');
    this.cacheDir = path.join(__dirname, '..', 'data', 'cache');
  }

  async buildIndex() {
    console.log('[CataloniaIndexer] Building unified Catalonia GTFS index with canonical stops & road shapes...');
    const start = Date.now();

    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    const routesCachePath = path.join(this.cacheDir, 'routes.json');
    const stopsCachePath = path.join(this.cacheDir, 'stops.json');
    const routeDetailsPath = path.join(this.cacheDir, 'route_details.json');
    const calendarCachePath = path.join(this.cacheDir, 'calendar.json');
    const calendarDatesCachePath = path.join(this.cacheDir, 'calendar_dates.json');
    const shapesCachePath = path.join(this.cacheDir, 'shapes.json');

    // 1. Index Calendar & Calendar Dates
    const calendar = {};
    const calFile = path.join(this.gtfsDir, 'calendar.txt');
    if (fs.existsSync(calFile)) {
      const calStream = fs.createReadStream(calFile);
      const calRl = readline.createInterface({ input: calStream, crlfDelay: Infinity });
      for await (const line of calRl) {
        const parts = line.split(',');
        if (parts[0] !== 'service_id' && parts[0].trim()) {
          calendar[parts[0].trim()] = {
            monday: parts[1] === '1',
            tuesday: parts[2] === '1',
            wednesday: parts[3] === '1',
            thursday: parts[4] === '1',
            friday: parts[5] === '1',
            saturday: parts[6] === '1',
            sunday: parts[7] === '1',
            startDate: parts[8]?.trim() || '20250101',
            endDate: parts[9]?.trim() || '20301231'
          };
        }
      }
    }

    const calendarExceptions = {}; // dateStr -> { active: [], inactive: [] }
    const calDatesFile = path.join(this.gtfsDir, 'calendar_dates.txt');
    if (fs.existsSync(calDatesFile)) {
      const cdStream = fs.createReadStream(calDatesFile);
      const cdRl = readline.createInterface({ input: cdStream, crlfDelay: Infinity });
      for await (const line of cdRl) {
        const parts = line.split(',');
        if (parts[0] !== 'service_id' && parts[0].trim()) {
          const sId = parts[0].trim();
          const dStr = parts[1]?.trim();
          const excType = parts[2]?.trim();
          if (dStr && excType) {
            if (!calendarExceptions[dStr]) calendarExceptions[dStr] = { active: [], inactive: [] };
            if (excType === '1') calendarExceptions[dStr].active.push(sId);
            if (excType === '2') calendarExceptions[dStr].inactive.push(sId);
          }
        }
      }
    }

    // 2. Index Agencies
    const agencies = new Map();
    const aStream = fs.createReadStream(path.join(this.gtfsDir, 'agency.txt'));
    const aRl = readline.createInterface({ input: aStream, crlfDelay: Infinity });
    for await (const line of aRl) {
      const parts = parseCsvLine(line);
      if (parts[0] !== 'agency_id') {
        agencies.set(parts[0], (parts[1] || 'Interurbà').replace(/"/g, '').trim());
      }
    }

    // 3. Index Stops
    const stopsMap = new Map();
    const sStream = fs.createReadStream(path.join(this.gtfsDir, 'stops.txt'));
    const sRl = readline.createInterface({ input: sStream, crlfDelay: Infinity });
    for await (const line of sRl) {
      const parts = parseCsvLine(line);
      if (parts[0] !== 'stop_id') {
        const lat = parseFloat(parts[4]);
        const lon = parseFloat(parts[5]);
        stopsMap.set(parts[0], {
          id: parts[0],
          code: parts[1] || parts[0],
          name: (parts[2] || '').replace(/"/g, '').trim(),
          lat: (!isNaN(lat) && lat > 35 && lat < 45) ? lat : 41.3851,
          lon: (!isNaN(lon) && lon > 0 && lon < 5) ? lon : 2.1734,
          zone: parts[6] || 'Catalunya'
        });
      }
    }

    // 4. Index Routes
    const routes = [];
    const routeMetaMap = new Map();
    const rStream = fs.createReadStream(path.join(this.gtfsDir, 'routes.txt'));
    const rRl = readline.createInterface({ input: rStream, crlfDelay: Infinity });
    for await (const line of rRl) {
      const parts = parseCsvLine(line);
      if (parts[0] !== 'agency_id') {
        const agencyId = parts[0];
        const routeId = parts[1];
        const shortName = parts[2];
        const longName = parts[3];
        const color = parts[7] ? (parts[7].startsWith('#') ? parts[7] : '#' + parts[7]) : '#009485';
        const agencyName = agencies.get(agencyId) || 'Interurbà Catalunya';

        let group = 'interurba';
        let mode = 'Interurbà';
        let operatorInfo = null;
        const aLower = agencyName.toLowerCase();
        const sLower = (shortName || '').toLowerCase();

        for (const [k, info] of Object.entries(AGENCY_INFO_MAP)) {
          if (aLower.includes(k)) {
            operatorInfo = info;
            break;
          }
        }

        if (sLower.startsWith('e') || sLower.startsWith('expres') || aLower.includes('exprés') || aLower.includes('expres')) {
          group = 'expres';
          mode = 'Exprés.cat';
        } else if (sLower.startsWith('n') || aLower.includes('nitbus') || aLower.includes('nocturn')) {
          group = 'nitbus';
          mode = 'NitBus';
        } else if (aLower.includes('sagalés') || aLower.includes('sagales')) {
          group = 'sagales';
          mode = 'Sagalés';
        } else if (aLower.includes('moventis') || aLower.includes('casas') || aLower.includes('marfina') || aLower.includes('sarbus')) {
          group = 'moventis';
          mode = 'Moventis';
        } else if (aLower.includes('plana')) {
          group = 'plana';
          mode = 'Empresa Plana';
        } else if (aLower.includes('hife')) {
          group = 'hife';
          mode = 'HIFE';
        } else if (aLower.includes('teisa')) {
          group = 'teisa';
          mode = 'TEISA';
        } else if (aLower.includes('soler')) {
          group = 'soler';
          mode = 'Soler i Sauret';
        } else if (aLower.includes('tusgsal')) {
          group = 'tusgsal';
          mode = 'DIREXIS TUSGSAL';
        } else if (aLower.includes('avanza')) {
          group = 'avanza';
          mode = 'Avanza';
        } else if (aLower.includes('monbus') || aLower.includes('igualadina')) {
          group = 'monbus';
          mode = 'Monbus';
        } else if (aLower.includes('tgo') || aLower.includes('baixbus')) {
          group = 'baixbus';
          mode = 'DIREXIS TGO';
        } else if (aLower.includes('renfe') || aLower.includes('rodalies')) {
          group = 'rodalies';
          mode = 'Tren Rodalies';
        } else if (aLower.includes('fgc')) {
          group = 'fgc';
          mode = 'FGC Ferrocarrils';
        } else if (aLower.includes('tmb')) {
          group = 'tmb';
          mode = 'TMB Bus';
        }

        const cleanCode = shortName || routeId;
        const lineId = `cat_${routeId.toLowerCase()}_${cleanCode.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

        const routeItem = {
          id: lineId,
          routeId,
          code: cleanCode,
          name: (longName || cleanCode || '').replace(/"/g, '').trim(),
          color: color === '#000000' || color === '#ffffff' ? '#009485' : color,
          agency: agencyName,
          group,
          mode,
          operatorWebsite: operatorInfo?.website || null,
          operatorNotice: operatorInfo?.notice || null,
          directions: []
        };

        routes.push(routeItem);
        routeMetaMap.set(routeId, routeItem);
      }
    }

    // 5. Index Trips & Direction Associations
    const tripToRoute = new Map();
    const routeTrips = new Map(); // routeId -> dirId -> Array of tripIds
    const usedShapeIds = new Set();
    const tStream = fs.createReadStream(path.join(this.gtfsDir, 'trips.txt'));
    const tRl = readline.createInterface({ input: tStream, crlfDelay: Infinity });
    for await (const line of tRl) {
      const parts = parseCsvLine(line);
      if (parts[0] !== 'route_id') {
        const routeId = parts[0];
        const tripId = parts[1];
        const headsign = (parts[2] || '').replace(/"/g, '').trim();
        const dirId = parts[4] || '0';
        const shapeId = parts[6];
        const serviceId = parts[9] || parts[1];

        if (shapeId) usedShapeIds.add(shapeId);
        tripToRoute.set(tripId, { routeId, dirId, headsign, shapeId, serviceId });
        if (!routeTrips.has(routeId)) routeTrips.set(routeId, new Map());
        const dirMap = routeTrips.get(routeId);
        if (!dirMap.has(dirId)) {
          dirMap.set(dirId, { headsign, shapeId, trips: [] });
        }
        dirMap.get(dirId).trips.push(tripId);
      }
    }

    // 6. Index Shapes from shapes.txt (exact road polylines)
    const shapesRawMap = new Map();
    const shapesFile = path.join(this.gtfsDir, 'shapes.txt');
    if (fs.existsSync(shapesFile)) {
      const shStream = fs.createReadStream(shapesFile);
      const shRl = readline.createInterface({ input: shStream, crlfDelay: Infinity });
      for await (const line of shRl) {
        const parts = line.split(',');
        if (parts[0] !== 'shape_id') {
          const sId = parts[0];
          if (usedShapeIds.has(sId)) {
            const lat = parseFloat(parts[1]);
            const lon = parseFloat(parts[2]);
            const seq = parseInt(parts[3] || '0', 10);
            if (!shapesRawMap.has(sId)) shapesRawMap.set(sId, []);
            shapesRawMap.get(sId).push({ seq, lat, lon });
          }
        }
      }
    }

    const shapesOutput = {};
    shapesRawMap.forEach((pts, sId) => {
      shapesOutput[sId] = pts.sort((a, b) => a.seq - b.seq).map(p => [Number(p.lat.toFixed(5)), Number(p.lon.toFixed(5))]);
    });

    // 7. Index Route Stops & Departure Timetables from stop_times.txt
    const tripStopsMap = new Map(); // tripId -> Array of { seq, stopId, depTime }
    const stStream = fs.createReadStream(path.join(this.gtfsDir, 'stop_times.txt'));
    const stRl = readline.createInterface({ input: stStream, crlfDelay: Infinity });
    for await (const line of stRl) {
      const parts = line.split(',');
      if (parts[0] !== 'trip_id') {
        const tripId = parts[0];
        const depTime = (parts[2] || '').trim().substring(0, 5);
        const stopId = parts[3];
        const seq = parseInt(parts[4] || '0', 10);

        if (tripToRoute.has(tripId)) {
          if (!tripStopsMap.has(tripId)) tripStopsMap.set(tripId, []);
          tripStopsMap.get(tripId).push({ seq, stopId, depTime });
        }
      }
    }

    // Build route details lookup using canonical trip patterns
    const routeDetails = {};
    routes.forEach(r => {
      const dirStops = {};
      const schedulesByDirection = {};
      const dirMap = routeTrips.get(r.routeId);

      ['0', '1'].forEach(dId => {
        const dMeta = dirMap?.get(dId);
        const tripIds = dMeta?.trips || [];

        if (tripIds.length > 0) {
          // 1. Build schedule for this direction
          const schedList = [];
          tripIds.forEach(tId => {
            const meta = tripToRoute.get(tId);
            const stops = tripStopsMap.get(tId) || [];
            if (stops.length > 0) {
              const sorted = stops.sort((a, b) => a.seq - b.seq);
              const originDep = sorted[0]?.depTime;
              if (originDep) {
                schedList.push({
                  tripId: tId,
                  serviceId: meta.serviceId,
                  departureTime: originDep
                });
              }
            }
          });
          schedulesByDirection[dId] = schedList.sort((a, b) => a.departureTime.localeCompare(b.departureTime));

          // 2. Select canonical trip with the most complete stop sequence
          let canonicalTripId = tripIds[0];
          let maxStops = 0;
          tripIds.forEach(tId => {
            const count = tripStopsMap.get(tId)?.length || 0;
            if (count > maxStops) {
              maxStops = count;
              canonicalTripId = tId;
            }
          });

          const canonicalStops = (tripStopsMap.get(canonicalTripId) || []).sort((a, b) => a.seq - b.seq);
          dirStops[dId] = canonicalStops.map((s, idx) => {
            const sObj = stopsMap.get(s.stopId);
            if (!sObj) return null;
            return {
              id: sObj.id,
              code: sObj.code,
              mouteStopId: sObj.id,
              name: sObj.name,
              lat: sObj.lat,
              lon: sObj.lon,
              seq: idx + 1,
              zone: sObj.zone
            };
          }).filter(Boolean);
        }
      });

      // Update directions list with accurate names and shape IDs
      if (dirMap) {
        r.directions = Array.from(dirMap.entries()).map(([dId, dMeta]) => ({
          dirId: String(dId),
          name: dMeta.headsign ? `Cap a ${dMeta.headsign}` : (dId === '0' ? 'Sentit Anada' : 'Sentit Tornada'),
          shapeId: dMeta.shapeId
        }));
      }
      if (r.directions.length === 0) {
        r.directions = [{ dirId: '0', name: 'Cap a Destí', shapeId: null }];
      }

      routeDetails[r.id] = {
        ...r,
        stopsByDirection: dirStops,
        schedulesByDirection
      };
    });

    // Save JSON caches
    fs.writeFileSync(calendarCachePath, JSON.stringify(calendar));
    fs.writeFileSync(calendarDatesCachePath, JSON.stringify(calendarExceptions));
    fs.writeFileSync(shapesCachePath, JSON.stringify(shapesOutput));
    fs.writeFileSync(routesCachePath, JSON.stringify(routes));
    fs.writeFileSync(stopsCachePath, JSON.stringify(Array.from(stopsMap.values())));
    fs.writeFileSync(routeDetailsPath, JSON.stringify(routeDetails));

    console.log(`[CataloniaIndexer] Finished in ${Date.now() - start}ms! ${routes.length} routes, ${stopsMap.size} stops, ${Object.keys(shapesOutput).length} road shapes indexed.`);
    return { routes, stops: Array.from(stopsMap.values()), routeDetails, shapes: shapesOutput };
  }
}

module.exports = new CataloniaIndexer();
