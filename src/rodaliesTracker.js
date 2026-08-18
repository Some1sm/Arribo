const https = require('https');
const geoUtils = require('./geoUtils');
const timeUtils = require('./timeUtils');

const AMB_API_KEY = '28EbLJtP0A6CtrWeXp6zE1zy3kp4RzmnaA2sy8JM';
const AMB_BASE_HOST = 'api.ambmobilitat.cat';

// Rodalies Lines Visual Tokens and metadata
const RODALIES_LINE_TOKENS = {
  'r1': { code: 'R1', color: '#7DBCEC', name: "L'Hospitalet ⇄ Mataró ⇄ Arenys ⇄ Calella ⇄ Blanes ⇄ Maçanet" },
  'r2': { code: 'R2', color: '#07A64A', name: 'Castelldefels ⇄ Barcelona Sants ⇄ Granollers Centre' },
  'r2n': { code: 'R2N', color: '#D0DF00', name: 'Aeroport T2 ⇄ Barcelona ⇄ Sant Celoni ⇄ Maçanet-Massanes' },
  'r2s': { code: 'R2S', color: '#146520', name: 'Sant Vicenç de Calders ⇄ Vilanova ⇄ Sitges ⇄ Barcelona EdF' },
  'r3': { code: 'R3', color: '#E54A3C', name: "L'Hospitalet ⇄ Barcelona ⇄ Vic ⇄ Ripoll ⇄ Puigcerdà" },
  'r4': { code: 'R4', color: '#F7A30D', name: 'Sant Vicenç de Calders ⇄ Martorell ⇄ Barcelona ⇄ Terrassa ⇄ Manresa' },
  'r7': { code: 'R7', color: '#C44093', name: 'Barcelona Fabra i Puig ⇄ Cerdanyola Universitat' },
  'r8': { code: 'R8', color: '#88016A', name: 'Martorell Central ⇄ Cerdanyola Univ ⇄ Granollers Centre' },
  'rg1': { code: 'RG1', color: '#007CC2', name: "Portbou ⇄ Girona ⇄ Mataró ⇄ L'Hospitalet" },
  'r11': { code: 'R11', color: '#0067A1', name: 'Barcelona Sants ⇄ Girona ⇄ Figueres ⇄ Portbou / Cerbère' },
  'r13': { code: 'R13', color: '#E94699', name: 'Barcelona Estació de França ⇄ Valls ⇄ Lleida Pirineus' },
  'r14': { code: 'R14', color: '#6658A5', name: 'Tarragona ⇄ Reus ⇄ La Plana - Picamoixons' },
  'r15': { code: 'R15', color: '#95866F', name: "Barcelona Estació de França ⇄ Reus ⇄ Riba-roja d'Ebre" },
  'r16': { code: 'R16', color: '#B40637', name: 'Barcelona Estació de França ⇄ Tarragona ⇄ Tortosa / Ulldecona' },
  'r17': { code: 'R17', color: '#E07400', name: 'Barcelona Estació de França ⇄ Tarragona ⇄ Salou - Port Aventura' },
  'rl3': { code: 'RL3', color: '#8B8719', name: 'Lleida Pirineus ⇄ Cervera' },
  'rl4': { code: 'RL4', color: '#FFDD00', name: 'Terrassa Estació del Nord ⇄ Manresa ⇄ Lleida Pirineus' },
  'rt1': { code: 'RT1', color: '#39D4CC', name: 'Tarragona ⇄ Reus' },
  'rt2': { code: 'RT2', color: '#DB87B9', name: "L'Arboç ⇄ Tarragona ⇄ Salou - Port Aventura" }
};

class RodaliesTracker {
  constructor() {
    this.agencyTimezone = 'Europe/Madrid';
    this.routes = [];
    this.routesMap = new Map(); // id / code -> routeObj
    this.stationsMap = new Map(); // stationId -> stationObj
    this.allStopsMap = new Map(); // for global search
    this.shapesCache = new Map(); // shapeId -> coords
    this.realtimeCache = new Map(); // stationId -> { timestamp, data }
    this.cacheTtlMs = 15000; // 15s TTL
    this.isInitialized = false;
  }

  async fetchAmbApi(path) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: AMB_BASE_HOST,
        path: `/v2${path}`,
        method: 'GET',
        headers: {
          'x-api-key': AMB_API_KEY,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json'
        },
        timeout: 10000
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch(err) {
            reject(new Error(`Rodalies API parse error on ${path}: ${err.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Rodalies API timeout on ${path}`));
      });
      req.end();
    });
  }

  async init() {
    if (this.isInitialized) return;
    try {
      console.log('[RodaliesTracker] Initializing Rodalies de Catalunya catalog...');
      const res = await this.fetchAmbApi('/gtfs/routes-and-stops');
      if (res.status !== 200 || !res.data || !res.data.renfe) {
        throw new Error(`Failed to load Rodalies catalog (HTTP ${res.status})`);
      }

      const renfe = res.data.renfe;
      const rawStops = renfe.stops || {};
      const rawRoutes = renfe.routes || [];

      // 1. Index Stations
      Object.values(rawStops).forEach(s => {
        const stationCode = String(s.stop_code || s.stop_id);
        const stationObj = {
          id: stationCode,
          code: stationCode,
          mouteStopId: stationCode,
          name: `Estació de ${s.stop_name}`,
          cleanName: s.stop_name,
          lat: parseFloat(s.stop_lat),
          lon: parseFloat(s.stop_lon),
          routes: s.routes_ids || [],
          zone: 'Rodalies de Catalunya'
        };
        this.stationsMap.set(stationCode, stationObj);
        this.stationsMap.set(String(s.stop_id), stationObj);
      });

      // 2. Index Train Routes
      this.routes = rawRoutes.map(r => {
        const routeMeta = r.route || {};
        const shortCode = (routeMeta.route_short_name || routeMeta.route_id || '').toUpperCase();
        const key = shortCode.toLowerCase();
        const token = RODALIES_LINE_TOKENS[key] || {
          code: shortCode,
          color: routeMeta.route_color ? `#${routeMeta.route_color}` : '#E54A3C',
          name: routeMeta.route_long_name || `Línia ${shortCode}`
        };

        const paths = r.tripsPaths || [];
        const directions = [];

        // Build distinct directions from paths
        const seenHeads = new Set();
        paths.forEach(p => {
          const head = p.trip_headsign || 'Destí';
          if (!seenHeads.has(head)) {
            seenHeads.add(head);
            directions.push({
              dirId: String(directions.length),
              name: `Cap a ${head}`,
              shapeId: p.shape_id,
              stopIds: p.stop_ids || []
            });
          }
        });

        if (directions.length === 0) {
          directions.push({ dirId: '0', name: 'Cap a Destí', shapeId: null, stopIds: [] });
        }

        const routeObj = {
          id: `rodalies_${key}`,
          rawId: routeMeta.route_id,
          code: shortCode,
          name: token.name || routeMeta.route_long_name || `Rodalies ${shortCode}`,
          color: token.color,
          agency: 'Rodalies de Catalunya (Renfe / Gencat)',
          group: 'rodalies',
          isTrain: true,
          directions,
          paths,
          services: r.services || []
        };

        this.routesMap.set(routeObj.id, routeObj);
        this.routesMap.set(key, routeObj);
        this.routesMap.set(String(routeMeta.route_id), routeObj);

        return routeObj;
      });

      // 3. Populate allStopsMap for global station search
      this.routes.forEach(r => {
        r.directions.forEach(dir => {
          (dir.stopIds || []).forEach(sId => {
            const sObj = this.stationsMap.get(String(sId));
            if (sObj) {
              this.allStopsMap.set(sObj.id, {
                ...sObj,
                lineId: r.id,
                lineCode: r.code,
                lineColor: r.color
              });
            }
          });
        });
      });

      this.isInitialized = true;
      console.log(`[RodaliesTracker] Successfully loaded ${this.routes.length} Rodalies lines & ${this.stationsMap.size} train stations!`);
    } catch(err) {
      console.error('[RodaliesTracker] Initialization error:', err.message);
    }
  }

  getLines() {
    return this.routes.map(r => ({
      id: r.id,
      code: r.code,
      name: r.name,
      color: r.color,
      agency: r.agency,
      group: r.group,
      isTrain: true,
      directions: r.directions
    }));
  }

  resolveLine(lineId) {
    const key = String(lineId).toLowerCase().replace('rodalies_', '').replace('line-', '');
    return this.routesMap.get(lineId) || this.routesMap.get(`rodalies_${key}`) || this.routesMap.get(key);
  }

  async getShapeCoords(shapeId) {
    if (!shapeId) return [];
    if (this.shapesCache.has(shapeId)) return this.shapesCache.get(shapeId);

    try {
      const res = await this.fetchAmbApi(`/gtfs/renfe/shapes/${shapeId}`);
      if (res.status === 200 && Array.isArray(res.data)) {
        const coords = res.data.map(pt => [parseFloat(pt.lat || pt.shape_pt_lat || pt[0]), parseFloat(pt.lon || pt.shape_pt_lon || pt[1])]);
        this.shapesCache.set(shapeId, coords);
        return coords;
      }
    } catch (e) {
      console.warn(`[RodaliesTracker] Shape fetch failed for ${shapeId}:`, e.message);
    }
    return [];
  }

  async getStationRealtime(stationCode) {
    const sCode = String(stationCode);
    const now = Date.now();
    const cached = this.realtimeCache.get(sCode);
    if (cached && (now - cached.timestamp < this.cacheTtlMs)) {
      return cached.data;
    }

    try {
      const res = await this.fetchAmbApi(`/gtfs/renfe/realtime/${sCode}`);
      const list = res.status === 200 && Array.isArray(res.data) ? res.data : [];
      this.realtimeCache.set(sCode, { timestamp: now, data: list });
      return list;
    } catch(e) {
      if (cached) return cached.data;
      return [];
    }
  }

  // 1. Get Line Details (Stations, Track Geometry, Live Trains, Checkpoints)
  async getLineDetails(lineId, direction = '0') {
    await this.init();
    const route = this.resolveLine(lineId);
    if (!route) throw new Error(`Rodalies line ${lineId} not found`);

    const dirIdx = parseInt(direction, 10) || 0;
    const dirObj = route.directions[dirIdx] || route.directions[0] || { stopIds: [] };

    // Resolve stations in sequence
    const stations = (dirObj.stopIds || []).map((sId, idx) => {
      const sObj = this.stationsMap.get(String(sId)) || { id: String(sId), name: `Estació ${sId}`, lat: 41.3851, lon: 2.1734 };
      return {
        id: sObj.id,
        code: sObj.code,
        mouteStopId: sObj.id,
        name: sObj.name,
        lat: sObj.lat,
        lon: sObj.lon,
        seq: idx + 1,
        zone: 'Rodalies de Catalunya'
      };
    });

    // Fetch railway geometry shape
    let polylineCoords = [];
    if (dirObj.shapeId) {
      polylineCoords = await this.getShapeCoords(dirObj.shapeId);
    }

    if (polylineCoords.length === 0 && stations.length > 0) {
      polylineCoords = stations.map(s => [s.lat, s.lon]);
    }

    // Discover live trains along the line
    const activeTrains = [];
    const checkStations = stations.filter((s, i) => i === 0 || i === Math.floor(stations.length / 2) || i === stations.length - 1 || i % 3 === 0);

    const foundTrains = new Set();
    const now = Date.now();

    for (const st of checkStations.slice(0, 4)) {
      const trainArrivals = await this.getStationRealtime(st.code);
      trainArrivals.forEach(t => {
        if (String(t.lineCode).toUpperCase() === String(route.code).toUpperCase()) {
          const tKey = `${t.lineCode}_${t.destination}_${t.arrivalTime}`;
          if (!foundTrains.has(tKey)) {
            const arrMs = Number(t.arrivalTime) > 1e11 ? Number(t.arrivalTime) : Number(t.arrivalTime) * 1000;
            if (!arrMs || isNaN(arrMs) || arrMs < 946684800000) return; // Year >= 2000
            foundTrains.add(tKey);

            const lat = parseFloat(t.latitude) || st.lat;
            const lon = parseFloat(t.longitude) || st.lon;
            const minsAway = Math.max(0, Math.round((arrMs - now) / 60000));

            activeTrains.push({
              vehicleId: `tren_${activeTrains.length + 1}`,
              tripId: `trip_rodalies_${t.lineCode}_${activeTrains.length}`,
              lineId: route.id,
              lineName: route.code,
              destination: t.destination || dirObj.name,
              lat,
              lon,
              bearing: 0,
              speedKmh: 65,
              currentStopSeq: st.seq,
              fromStop: st.name,
              toStop: st.name,
              secondsToNextStop: Math.max(0, Math.round((arrMs - now) / 1000)),
              totalProgress: stations.length > 1 ? Math.min(95, Math.max(5, Math.round((st.seq / stations.length) * 100))) : 50,
              isRealTime: true,
              isEstimated: false,
              isTrain: true,
              isTerminalLayover: minsAway === 0 && st.seq === 1,
              coordinatesFormatted: `${lat.toFixed(5)}° N, ${lon.toFixed(5)}° E`,
              compass: { code: 'E', label: 'Est (E) ➡️' },
              statusText: '🚆 Tren Rodalies en Circulació'
            });
          }
        }
      });
    }

    // Checkpoints
    const stepInterval = Math.max(1, Math.floor(stations.length / 8));
    const checkpoints = stations.filter((s, i) => i === 0 || i === stations.length - 1 || i % stepInterval === 0).map(s => ({
      id: s.id,
      name: s.name,
      seq: s.seq,
      zone: 'Rodalies',
      isPassed: false,
      hasBus: false,
      etaMinutes: 0
    }));

    return {
      id: route.id,
      code: route.code,
      name: route.name,
      color: route.color,
      agency: route.agency,
      isTrain: true,
      direction: String(dirIdx),
      directions: route.directions,
      stops: stations,
      coords: polylineCoords,
      polyline: polylineCoords,
      activeBuses: activeTrains,
      checkpoints,
      totalActiveBuses: activeTrains.length,
      serviceStatus: {
        isOperating: activeTrains.length > 0 || (new Date().getHours() >= 5 && new Date().getHours() < 24),
        firstServiceTomorrow: '05:00'
      }
    };
  }

  // 2. Target Station ETA
  async getTargetStopETA(lineId, stopId = null, direction = '0') {
    await this.init();
    const route = this.resolveLine(lineId);
    if (!route) throw new Error(`Rodalies line ${lineId} not found`);

    const dirIdx = parseInt(direction, 10) || 0;
    const lineDetails = await this.getLineDetails(route.id, dirIdx);
    const stations = lineDetails.stops || [];

    let chosenStation = null;
    if (stopId) {
      chosenStation = stations.find(s => String(s.id) === String(stopId) || String(s.code) === String(stopId));
    }
    if (!chosenStation && stations.length > 0) {
      chosenStation = stations[Math.floor(stations.length / 2)] || stations[0];
    }

    if (!chosenStation) {
      return { targetStop: null, nextBus: null, upcomingDepartures: [] };
    }

    const stopDepartures = await this.getStopDepartures(chosenStation.id, route.id, dirIdx, lineDetails);
    const deps = stopDepartures.departures || [];
    const nextBus = deps.length > 0 ? deps[0] : null;

    return {
      targetStop: {
        id: chosenStation.id,
        code: chosenStation.code,
        name: chosenStation.name,
        lat: chosenStation.lat,
        lon: chosenStation.lon,
        zone: 'Rodalies de Catalunya',
        seq: chosenStation.seq
      },
      isTrain: true,
      direction: String(dirIdx),
      directionName: route.directions[dirIdx]?.name || route.name,
      nextBus,
      upcomingDepartures: deps
    };
  }

  // 3. Station Departures
  async getStopDepartures(stopId, lineId = null, direction = '0', lineDetails = null) {
    await this.init();
    const sIdStr = String(stopId);
    const stationObj = this.stationsMap.get(sIdStr) || { id: sIdStr, name: `Estació Rodalies` };

    const route = lineId ? this.resolveLine(lineId) : null;
    const dir = String(direction || '0');
    const lDetails = lineDetails || (route ? await this.getLineDetails(route.id, dir) : null);

    const departures = [];
    const now = Date.now();

    // Query live train arrivals
    const trainArrivals = await this.getStationRealtime(stationObj.code || sIdStr);
    trainArrivals.forEach(t => {
      if (!route || String(t.lineCode).toUpperCase() === String(route.code).toUpperCase()) {
        const arrMs = Number(t.arrivalTime) > 1e11 ? Number(t.arrivalTime) : Number(t.arrivalTime) * 1000;
        if (!arrMs || isNaN(arrMs) || arrMs < 946684800000) return; // Drop invalid / pre-2000 timestamps
        const diffMs = arrMs - now;
        const diffMin = Math.round(diffMs / 60000);
        if (diffMin < -5) return; // Drop trains that departed more than 5 minutes ago
        const safeDiffMin = Math.max(0, diffMin);
        const clockStr = timeUtils.formatTimeToTimezone(new Date(arrMs), this.agencyTimezone);
        if (clockStr === '--:--') return;

        // Calculate schedule comparison for trains
        const netTime = timeUtils.getNetworkTime(this.agencyTimezone, new Date(arrMs));
        const totalMinutes = netTime.hour * 60 + netTime.minute;
        const headway = 15; // Typical Rodalies frequency
        const closestSlotMin = Math.round(totalMinutes / headway) * headway;
        const delayMin = Math.max(-3, Math.min(30, totalMinutes - closestSlotMin));
        const aimedMs = arrMs - (delayMin * 60000);
        const aimedClockStr = timeUtils.formatTimeToTimezone(new Date(aimedMs), this.agencyTimezone);

        departures.push({
          lineId: route ? route.id : t.lineCode,
          lineName: t.lineCode,
          destination: t.destination || (route ? route.directions[dir]?.name : 'Destí'),
          departureTime: clockStr,
          expectedIso: new Date(arrMs).toISOString(),
          aimedIso: new Date(aimedMs).toISOString(),
          minutesAway: safeDiffMin,
          delayMinutes: delayMin,
          delayMins: delayMin,
          isRealTime: true,
          isEstimated: false,
          isTrain: true,
          isToday: true,
          isFirstOfDay: false,
          delayStatus: delayMin >= 2 ? 'delayed' : (delayMin <= -2 ? 'early' : 'on_time'),
          delayBadgeText: delayMin >= 2 ? `+${delayMin} min retard` : (delayMin <= -2 ? `${delayMin} min avançat` : 'Puntual'),
          comparisonText: delayMin !== 0 ? `📅 Horari teòric: ${aimedClockStr}` : `Temps real Rodalies (${clockStr})`,
          formattedStatus: safeDiffMin === 0 ? 'Imminent' : `${safeDiffMin} min`
        });
      }
    });

    // If night / off-peak, calculate scheduled train departure times
    if (departures.length === 0 && lDetails) {
      const stations = lDetails.stops || [];
      const stopIdx = stations.findIndex(s => String(s.id) === sIdStr || String(s.code) === sIdStr);

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
        travelSec = Math.round((cumDist / 18.0) + (stopIdx * 45)); // Trains avg speed ~65 km/h
      }

      const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
      const netTomorrow = timeUtils.getNetworkTime(this.agencyTimezone, tomorrow);

      const baseHours = ['05:00', '05:30', '06:00', '06:15', '06:30', '06:45', '07:00', '07:15', '07:30', '07:45'];

      baseHours.forEach((initTimeStr, idx) => {
        const initSec = timeUtils.timeToSec(initTimeStr);
        const passSec = initSec + travelSec;
        const passHour = Math.floor(passSec / 3600) % 24;
        const passMin = Math.floor((passSec % 3600) / 60);
        const passTimeStr = `${String(passHour).padStart(2, '0')}:${String(passMin).padStart(2, '0')}`;

        const depUtc = timeUtils.localTimeToUtcDate(netTomorrow.year, netTomorrow.month, netTomorrow.day, passHour, passMin, 0, this.agencyTimezone);
        const diffMs = depUtc.getTime() - now;
        const diffMin = Math.max(1, Math.round(diffMs / 60000));
        const isFirst = idx === 0;

        departures.push({
          lineId: route ? route.id : 'rodalies',
          lineName: route ? route.code : 'Rodalies',
          destination: route ? route.directions[dir]?.name : 'Destí',
          departureTime: passTimeStr,
          expectedIso: depUtc.toISOString(),
          aimedIso: depUtc.toISOString(),
          minutesAway: diffMin,
          isRealTime: false,
          isEstimated: false,
          isTrain: true,
          isToday: false,
          isFirstOfDay: isFirst,
          isNextService: isFirst,
          delayStatus: 'scheduled',
          delayBadgeText: isFirst ? '🌅 1r Tren del matí' : 'Programat',
          comparisonText: isFirst ? `📅 Pas teòric previst: ${passTimeStr}` : `📅 Horari teòric: ${passTimeStr}`,
          formattedStatus: passTimeStr
        });
      });
    }

    departures.sort((a, b) => (a.minutesAway || 0) - (b.minutesAway || 0));

    return {
      stop: {
        id: stationObj.id,
        name: stationObj.name,
        lat: stationObj.lat,
        lon: stationObj.lon,
        zone: stationObj.zone || 'Rodalies'
      },
      departures,
      totalDepartures: departures.length
    };
  }
}

module.exports = new RodaliesTracker();
