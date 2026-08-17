const fs = require('fs');
const path = require('path');
const readline = require('readline');

class CataloniaIndexer {
  constructor() {
    this.gtfsDir = path.join(__dirname, '..', 'data', 'atm_gtfs');
    this.cacheDir = path.join(__dirname, '..', 'data', 'cache');
  }

  async buildIndex() {
    console.log('[CataloniaIndexer] Building unified Catalonia GTFS index...');
    const start = Date.now();

    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    const routesCachePath = path.join(this.cacheDir, 'routes.json');
    const stopsCachePath = path.join(this.cacheDir, 'stops.json');
    const routeDetailsPath = path.join(this.cacheDir, 'route_details.json');

    // 1. Index Agencies
    const agencies = new Map();
    const aStream = fs.createReadStream(path.join(this.gtfsDir, 'agency.txt'));
    const aRl = readline.createInterface({ input: aStream, crlfDelay: Infinity });
    for await (const line of aRl) {
      const parts = line.split(',');
      if (parts[0] !== 'agency_id') {
        agencies.set(parts[0], (parts[1] || 'Interurbà').replace(/"/g, '').trim());
      }
    }

    // 2. Index Stops (23,291 stops)
    const stopsMap = new Map();
    const sStream = fs.createReadStream(path.join(this.gtfsDir, 'stops.txt'));
    const sRl = readline.createInterface({ input: sStream, crlfDelay: Infinity });
    for await (const line of sRl) {
      const parts = line.split(',');
      if (parts[0] !== 'stop_id') {
        stopsMap.set(parts[0], {
          id: parts[0],
          code: parts[1] || parts[0],
          name: (parts[2] || '').replace(/"/g, '').trim(),
          lat: parseFloat(parts[4]),
          lon: parseFloat(parts[5]),
          zone: parts[6] || 'Catalunya'
        });
      }
    }

    // 3. Index Routes (1,610 routes)
    const routes = [];
    const routeMetaMap = new Map();
    const rStream = fs.createReadStream(path.join(this.gtfsDir, 'routes.txt'));
    const rRl = readline.createInterface({ input: rStream, crlfDelay: Infinity });
    for await (const line of rRl) {
      const parts = line.split(',');
      if (parts[0] !== 'agency_id') {
        const agencyId = parts[0];
        const routeId = parts[1];
        const shortName = parts[2];
        const longName = parts[3];
        const color = parts[7] ? (parts[7].startsWith('#') ? parts[7] : '#' + parts[7]) : '#009485';
        const agencyName = agencies.get(agencyId) || 'Interurbà Catalunya';

        let group = 'interurba';
        let mode = 'Interurbà';
        const aLower = agencyName.toLowerCase();
        const sLower = (shortName || '').toLowerCase();

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
          directions: []
        };

        routes.push(routeItem);
        routeMetaMap.set(routeId, routeItem);
      }
    }

    // 4. Index Trips & Shape Associations
    const tripToRoute = new Map();
    const routeTrips = new Map();
    const tStream = fs.createReadStream(path.join(this.gtfsDir, 'trips.txt'));
    const tRl = readline.createInterface({ input: tStream, crlfDelay: Infinity });
    for await (const line of tRl) {
      const parts = line.split(',');
      if (parts[0] !== 'route_id') {
        const routeId = parts[0];
        const tripId = parts[1];
        const headsign = (parts[2] || '').replace(/"/g, '').trim();
        const dirId = parts[4] || '0';
        const shapeId = parts[6];

        tripToRoute.set(tripId, { routeId, dirId, headsign, shapeId });
        if (!routeTrips.has(routeId)) routeTrips.set(routeId, new Map());
        const dirMap = routeTrips.get(routeId);
        if (!dirMap.has(dirId)) {
          dirMap.set(dirId, { headsign, shapeId, trips: [] });
        }
        dirMap.get(dirId).trips.push(tripId);
      }
    }

    // Attach directions to routes
    routes.forEach(r => {
      const dirMap = routeTrips.get(r.routeId);
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
    });

    // 5. Index Route Stops & Sequences
    const routeStopsMap = new Map(); // routeId_dirId -> stopId[]
    const stStream = fs.createReadStream(path.join(this.gtfsDir, 'stop_times.txt'));
    const stRl = readline.createInterface({ input: stStream, crlfDelay: Infinity });
    for await (const line of stRl) {
      const parts = line.split(',');
      if (parts[0] !== 'trip_id') {
        const tripId = parts[0];
        const stopId = parts[3];
        const seq = parseInt(parts[4] || '0', 10);
        const meta = tripToRoute.get(tripId);
        if (meta) {
          const key = `${meta.routeId}_${meta.dirId}`;
          if (!routeStopsMap.has(key)) {
            routeStopsMap.set(key, new Map());
          }
          const sMap = routeStopsMap.get(key);
          if (!sMap.has(stopId)) {
            sMap.set(stopId, seq);
          }
        }
      }
    }

    // Build route details lookup
    const routeDetails = {};
    routes.forEach(r => {
      const dirStops = {};
      ['0', '1'].forEach(dId => {
        const key = `${r.routeId}_${dId}`;
        const sMap = routeStopsMap.get(key);
        if (sMap) {
          const sortedStops = Array.from(sMap.entries())
            .sort((a,b) => a[1] - b[1])
            .map(([sId, seq], idx) => {
              const sObj = stopsMap.get(sId);
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
            })
            .filter(Boolean);
          dirStops[dId] = sortedStops;
        }
      });
      routeDetails[r.id] = {
        ...r,
        stopsByDirection: dirStops
      };
    });

    // Save JSON caches
    fs.writeFileSync(routesCachePath, JSON.stringify(routes));
    fs.writeFileSync(stopsCachePath, JSON.stringify(Array.from(stopsMap.values())));
    fs.writeFileSync(routeDetailsPath, JSON.stringify(routeDetails));

    console.log(`[CataloniaIndexer] Finished in ${Date.now() - start}ms! ${routes.length} routes, ${stopsMap.size} stops indexed.`);
    return { routes, stops: Array.from(stopsMap.values()), routeDetails };
  }
}

module.exports = new CataloniaIndexer();
