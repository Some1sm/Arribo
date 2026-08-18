const https = require('https');
const geoUtils = require('./geoUtils');
const timeUtils = require('./timeUtils');

const AMB_API_KEY = '28EbLJtP0A6CtrWeXp6zE1zy3kp4RzmnaA2sy8JM';
const AMB_BASE_HOST = 'api.ambmobilitat.cat';

// Agency Mapping Rules
function categorizeAgency(routeShortName, operatorHint = '') {
  const code = String(routeShortName).toUpperCase().trim();
  
  // TUSGSAL (Barcelonès Nord, MetroBus M-lines, Badalona, Santa Coloma, NitBus N0-N11)
  if (code.startsWith('B') && !code.startsWith('BUS')) return { agency: 'DIREXIS TUSGSAL (Barcelonès Nord)', group: 'tusgsal' };
  if (['M1', 'M6', 'M19', 'M26', 'M27', 'M28', 'M30'].includes(code)) return { agency: 'DIREXIS TUSGSAL (MetroBus)', group: 'tusgsal' };
  if (['N0', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'N11', 'N23', 'N24', 'N28'].includes(code)) return { agency: 'DIREXIS TUSGSAL (NitBus)', group: 'tusgsal' };

  // Avanza (Baix Llobregat, Castelldefels, Gavà, Viladecans, NitBus N12-N21)
  if (['L80', 'L82', 'L85', 'L86', 'L88', 'L94', 'L95', 'L96', 'L97', 'L99'].includes(code)) return { agency: 'Avanza (Baix Llobregat)', group: 'avanza' };
  if (['X80', 'X83', 'X84', 'X86', 'X95', 'X97'].includes(code)) return { agency: 'Avanza (Exprés.cat Baix)', group: 'avanza' };
  if (code.startsWith('CF') || code.startsWith('GA') || code.startsWith('VB')) return { agency: 'Avanza (Urbans Baix)', group: 'avanza' };
  if (['N12', 'N13', 'N14', 'N15', 'N16', 'N17', 'N18', 'N19', 'N20', 'N21'].includes(code)) return { agency: 'Avanza (NitBus Baix)', group: 'avanza' };

  // Monbus & Aerobús
  if (['A1', 'A2'].includes(code)) return { agency: 'Monbus (Aerobús)', group: 'monbus' };
  if (['L46', 'L52', 'L70', 'L72', 'L74', 'L76', 'L77', 'L78'].includes(code)) return { agency: 'Monbus i Julià (Baix Llobregat)', group: 'monbus' };
  if (['M5', 'M75', 'X43', 'X70', 'X79'].includes(code)) return { agency: 'Monbus i Julià (MetroBus / Exprés)', group: 'monbus' };
  if (code.startsWith('SB') || code.startsWith('PA') || code === '87') return { agency: 'Monbus (Urbans)', group: 'monbus' };

  // Soler i Sauret
  if (['EP1', 'EP2', 'JM', 'JT', 'SF1', 'SF2', 'SF3', 'MB1', 'MB2', 'MB3', 'SV1', 'SV2', 'SV3', 'SV4', 'ESC', 'PF1', 'PF2'].includes(code)) {
    return { agency: 'Soler i Sauret (Baix Llobregat)', group: 'soler' };
  }

  // Moventis (L'Hospitalet, El Prat, Cerdanyola)
  if (['L16', 'L20', 'L21', 'L22', 'LH1', 'LH2', 'M12', 'M14', 'M15', 'PR1', 'PR2', 'PR3', 'PR4', 'PR5', 'X30', '88', '89'].includes(code)) {
    return { agency: 'Moventis (L\'Hospitalet & El Prat)', group: 'moventis' };
  }
  if (code.startsWith('CV')) return { agency: 'Moventis (Cerdanyola Urbà)', group: 'moventis' };

  // DIREXIS TGO / Baixbus
  if (code.startsWith('CS')) return { agency: 'DIREXIS TGO (Baixbus)', group: 'baixbus' };

  return { agency: operatorHint || 'AMB Mobilitat', group: 'amb' };
}

class AmbTracker {
  constructor() {
    this.agencyTimezone = 'Europe/Madrid';
    this.routes = [];
    this.routesMap = new Map(); // id / code -> routeObj
    this.stopsMap = new Map();  // stopCode -> stopObj
    this.allStopsMap = new Map(); // for global search
    this.shapesCache = new Map(); // shapeId -> coords array
    this.realtimeCache = new Map(); // stopCode -> { timestamp, data }
    this.cacheTtlMs = 10000; // 10s TTL
    this.isInitialized = false;
    this.lineDocumentsMap = new Map();
    this.disruptionsCache = { timestamp: 0, data: [] };
    this.vehiclesCache = { timestamp: 0, data: [] };
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
            reject(new Error(`AMB API parse error on ${path}: ${err.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`AMB API timeout on ${path}`));
      });
      req.end();
    });
  }

  async init() {
    if (this.isInitialized) return;
    try {
      console.log('[AmbTracker] Initializing AMB routes & stops catalog...');
      const res = await this.fetchAmbApi('/gtfs/routes-and-stops');
      if (res.status !== 200 || !res.data || !res.data.busamb) {
        throw new Error(`Failed to load AMB catalog (HTTP ${res.status})`);
      }

      const busamb = res.data.busamb;
      const rawStops = busamb.stops || {};
      const rawRoutes = busamb.routes || [];

      // 1. Index Stops
      Object.values(rawStops).forEach(s => {
        const stopCode = String(s.stop_code || s.stop_id);
        const stopObj = {
          id: stopCode,
          code: stopCode,
          mouteStopId: stopCode,
          name: s.stop_name,
          lat: parseFloat(s.stop_lat),
          lon: parseFloat(s.stop_lon),
          routes: s.routes_ids || [],
          zone: 'Àrea Metropolitana (AMB)'
        };
        this.stopsMap.set(stopCode, stopObj);
        this.stopsMap.set(String(s.stop_id), stopObj);
      });

      // 2. Index Routes
      this.routes = rawRoutes.map(r => {
        const routeMeta = r.route || {};
        const shortName = routeMeta.route_short_name || routeMeta.route_id;
        const color = routeMeta.route_color ? (routeMeta.route_color.startsWith('#') ? routeMeta.route_color : `#${routeMeta.route_color}`) : '#009485';
        const agencyInfo = categorizeAgency(shortName);

        const paths = r.tripsPaths || [];
        const directions = [];

        // Build distinct directions
        const seenHeads = new Set();
        paths.forEach((p, pIdx) => {
          const headsign = p.trip_headsign || (p.direction_id === 0 ? 'Anada' : 'Tornada');
          if (!seenHeads.has(headsign)) {
            seenHeads.add(headsign);
            directions.push({
              dirId: String(p.direction_id ?? directions.length),
              name: `Cap a ${headsign}`,
              shapeId: p.shape_id,
              stopIds: p.stop_ids || []
            });
          }
        });

        if (directions.length === 0) {
          directions.push({ dirId: '0', name: 'Cap a Destí', shapeId: null, stopIds: [] });
        }

        const routeObj = {
          id: `amb_${shortName.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
          rawId: routeMeta.route_id,
          code: shortName,
          name: routeMeta.route_long_name || shortName,
          color,
          agency: agencyInfo.agency,
          group: agencyInfo.group,
          directions,
          paths,
          services: r.services || []
        };

        this.routesMap.set(routeObj.id, routeObj);
        this.routesMap.set(shortName.toLowerCase(), routeObj);
        this.routesMap.set(String(routeMeta.route_id), routeObj);

        return routeObj;
      });

      // 3. Populate allStopsMap for global search
      this.routes.forEach(r => {
        r.directions.forEach(dir => {
          (dir.stopIds || []).forEach(sId => {
            const sObj = this.stopsMap.get(String(sId));
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
      console.log(`[AmbTracker] Successfully loaded ${this.routes.length} AMB bus lines & ${this.stopsMap.size} stops!`);
    } catch(err) {
      console.error('[AmbTracker] Initialization error:', err.message);
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
      directions: r.directions
    }));
  }

  resolveLine(lineId) {
    const key = String(lineId).toLowerCase().replace('amb_', '').replace('line-', '').replace('linia-', '');
    return this.routesMap.get(lineId) || this.routesMap.get(`amb_${key}`) || this.routesMap.get(key);
  }

  decodeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&nbsp;/gi, ' ')
      .replace(/&middot;/gi, '·')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/gi, '"')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&ccedil;/g, 'ç')
      .replace(/&Ccedil;/g, 'Ç')
      .replace(/&Agrave;/g, 'À')
      .replace(/&agrave;/g, 'à')
      .replace(/&Aacute;/g, 'Á')
      .replace(/&aacute;/g, 'á')
      .replace(/&Egrave;/g, 'È')
      .replace(/&egrave;/g, 'è')
      .replace(/&Eacute;/g, 'É')
      .replace(/&eacute;/g, 'é')
      .replace(/&Igrave;/g, 'Ì')
      .replace(/&igrave;/g, 'ì')
      .replace(/&Iacute;/g, 'Í')
      .replace(/&iacute;/g, 'í')
      .replace(/&Ograve;/g, 'Ò')
      .replace(/&ograve;/g, 'ò')
      .replace(/&Oacute;/g, 'Ó')
      .replace(/&oacute;/g, 'ó')
      .replace(/&Ugrave;/g, 'Ù')
      .replace(/&ugrave;/g, 'ù')
      .replace(/&Uacute;/g, 'Ú')
      .replace(/&uacute;/g, 'ú')
      .replace(/&Uuml;/g, 'Ü')
      .replace(/&uuml;/g, 'ü')
      .replace(/&Ntilde;/g, 'Ñ')
      .replace(/&ntilde;/g, 'ñ')
      .replace(/&#(\d+);/g, (m, dec) => String.fromCharCode(dec))
      .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/<[^>]*>?/gm, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async getDisruptions(lineCode = null) {
    const now = Date.now();
    if (this.disruptionsCache.data.length > 0 && (now - this.disruptionsCache.timestamp < 60000)) {
      if (!lineCode) return this.disruptionsCache.data;
      const codeUpper = String(lineCode).toUpperCase();
      return this.disruptionsCache.data.filter(d => (d.affectedLines || '').toUpperCase().includes(codeUpper));
    }

    try {
      const res = await this.fetchAmbApi('/bus/disruptions');
      const list = res.data?._embedded?.disruptions || [];
      const formatted = list.map(d => ({
        id: d.id,
        title: this.decodeHtml(d.title || 'Avís de servei'),
        affectedLines: this.decodeHtml(d.affectedLines || ''),
        affectedCities: this.decodeHtml(d.affectedCities || ''),
        affectedStops: this.decodeHtml(d.affectedStops || ''),
        description: this.decodeHtml(d.description || ''),
        htmlDescription: d.description || '',
        date: d.date || ''
      }));
      this.disruptionsCache = { timestamp: now, data: formatted };
      if (!lineCode) return formatted;
      const codeUpper = String(lineCode).toUpperCase();
      return formatted.filter(d => (d.affectedLines || '').toUpperCase().includes(codeUpper));
    } catch(e) {
      return this.disruptionsCache.data || [];
    }
  }

  async getLiveVehicles() {
    const now = Date.now();
    if (this.vehiclesCache.data.length > 0 && (now - this.vehiclesCache.timestamp < 10000)) {
      return this.vehiclesCache.data;
    }

    try {
      const res = await this.fetchAmbApi('/bus/vehicles');
      const list = Array.isArray(res.data) ? res.data : [];
      this.vehiclesCache = { timestamp: now, data: list };
      return list;
    } catch(e) {
      return this.vehiclesCache.data || [];
    }
  }

  async getShapeCoords(shapeId) {
    if (!shapeId) return [];
    if (this.shapesCache.has(shapeId)) return this.shapesCache.get(shapeId);

    try {
      const res = await this.fetchAmbApi(`/gtfs/busamb/shapes/${shapeId}`);
      if (res.status === 200 && Array.isArray(res.data)) {
        const coords = res.data.map(pt => [parseFloat(pt.lat || pt.shape_pt_lat || pt[0]), parseFloat(pt.lon || pt.shape_pt_lon || pt[1])]);
        this.shapesCache.set(shapeId, coords);
        return coords;
      }
    } catch (e) {
      console.warn(`[AmbTracker] Shape fetch failed for ${shapeId}:`, e.message);
    }
    return [];
  }

  async getStopRealtime(stopCode) {
    const sCode = String(stopCode);
    const now = Date.now();
    const cached = this.realtimeCache.get(sCode);
    if (cached && (now - cached.timestamp < this.cacheTtlMs)) {
      return cached.data;
    }

    try {
      const res = await this.fetchAmbApi(`/bus/stops/${sCode}/realtimes`);
      const times = res.status === 200 && res.data?.times ? res.data.times : [];
      this.realtimeCache.set(sCode, { timestamp: now, data: times });
      return times;
    } catch(e) {
      if (cached) return cached.data;
      return [];
    }
  }

  // 1. Get Line Details (Stops, Geometry, Live Active Buses, Checkpoints)
  async getLineDetails(lineId, direction = '0') {
    await this.init();
    const route = this.resolveLine(lineId);
    if (!route) throw new Error(`AMB Line ${lineId} not found`);

    if (direction === 'both' && route.directions?.length > 1) {
      const details0 = await this.getLineDetails(lineId, '0');
      const details1 = await this.getLineDetails(lineId, '1');
      return {
        ...details0,
        direction: 'both',
        directionName: 'Ambdós sentits',
        stops: details0.stops,
        coords: details0.coords,
        secondaryStops: details1.stops,
        secondaryCoords: details1.coords,
        secondaryColor: '#38bdf8',
        allDirections: [
          { dirId: '0', name: route.directions[0]?.name || 'Sentit 1', stops: details0.stops, coords: details0.coords },
          { dirId: '1', name: route.directions[1]?.name || 'Sentit 2', stops: details1.stops, coords: details1.coords }
        ],
        activeBuses: [...(details0.activeBuses || []), ...(details1.activeBuses || [])],
        totalActiveBuses: (details0.activeBuses?.length || 0) + (details1.activeBuses?.length || 0)
      };
    }

    const dirIdx = parseInt(direction, 10) || 0;
    const dirObj = route.directions[dirIdx] || route.directions[0] || { stopIds: [] };

    // Resolve stops in sequence
    const stops = (dirObj.stopIds || []).map((sId, idx) => {
      const sObj = this.stopsMap.get(String(sId)) || { id: String(sId), name: `Parada ${sId}`, lat: 41.3851, lon: 2.1734 };
      return {
        id: sObj.id,
        code: sObj.code,
        mouteStopId: sObj.id,
        name: sObj.name,
        lat: sObj.lat,
        lon: sObj.lon,
        seq: idx + 1,
        zone: sObj.zone || 'Àrea Metropolitana (AMB)'
      };
    });

    // Fetch geometry shape
    let polylineCoords = [];
    if (dirObj.shapeId) {
      polylineCoords = await this.getShapeCoords(dirObj.shapeId);
    }

    if (polylineCoords.length === 0 && stops.length > 0) {
      polylineCoords = stops.map(s => [s.lat, s.lon]);
    }

    // 1. Discover real-time vehicles for this route directly from live AMB vehicle fleet
    const liveFleet = await this.getLiveVehicles();
    const routeCodeUpper = String(route.code).toUpperCase();
    const matchingVehicles = liveFleet.filter(v => String(v.line).toUpperCase() === routeCodeUpper);

    const activeBuses = [];
    matchingVehicles.forEach((v, vIdx) => {
      const lat = parseFloat(v.latitude);
      const lon = parseFloat(v.longitude);
      if (lat && lon) {
        // Extract real physical fleet number, e.g. "2974PA2" -> "#2974"
        const fleetNum = String(v.id).replace(/[a-zA-Z]/g, '') || String(v.id);
        const nextStop = stops.find(s => String(s.id) === String(v.nextStopId) || String(s.code) === String(v.nextStopId));
        const stopSeq = nextStop ? nextStop.seq : (stops.length > 1 ? Math.min(stops.length, vIdx + 1) : 1);
        const progress = stops.length > 1 ? Math.min(95, Math.max(5, Math.round((stopSeq / stops.length) * 100))) : 50;

        activeBuses.push({
          vehicleId: `AMB-${fleetNum}`,
          fleetNumber: fleetNum,
          tripId: String(v.tripId || `amb_${route.code}_${fleetNum}`),
          lineId: route.id,
          lineCode: route.code,
          lineName: route.code,
          destination: dirObj.name,
          lat,
          lon,
          bearing: 0,
          speedKmh: 32,
          currentStopSeq: stopSeq,
          fromStop: stops[Math.max(0, stopSeq - 2)]?.name || 'Origen',
          toStop: nextStop ? nextStop.name : (stops[Math.min(stops.length - 1, stopSeq)]?.name || 'Destí'),
          secondsToNextStop: 180,
          totalProgress: progress,
          isRealTime: true,
          isEstimated: false,
          coordinatesFormatted: `${lat.toFixed(5)}° N, ${lon.toFixed(5)}° E`,
          compass: { code: 'N', label: 'Nord (N) ⬆️' },
          statusText: `🟢 Bus #${fleetNum} • Senyal GPS en Directe`
        });
      }
    });

    // Fallback: If live vehicle endpoint had 0 for this line, poll stops
    if (activeBuses.length === 0) {
      const checkStops = stops.filter((s, i) => i === 0 || i === Math.floor(stops.length / 2) || i === stops.length - 1 || i % 4 === 0);
      const foundVehicles = new Set();
      const now = Date.now();

      for (const stop of checkStops.slice(0, 5)) {
        const times = await this.getStopRealtime(stop.code);
        times.forEach(t => {
          if (String(t.lineCode).toUpperCase() === routeCodeUpper) {
            const vKey = `${t.lineCode}_${t.destination}_${Math.round(t.time / 60000)}`;
            if (!foundVehicles.has(vKey)) {
              foundVehicles.add(vKey);
              const lat = parseFloat(t.latitude) || stop.lat;
              const lon = parseFloat(t.longitude) || stop.lon;
              const minsAway = Math.max(0, Math.round((t.time - now) / 60000));

              activeBuses.push({
                vehicleId: `AMB-${1000 + activeBuses.length}`,
                tripId: `trip_${t.lineCode}_${activeBuses.length}`,
                lineId: route.id,
                lineCode: route.code,
                lineName: route.code,
                destination: t.destination || dirObj.name,
                lat,
                lon,
                bearing: 0,
                speedKmh: 28,
                currentStopSeq: stop.seq,
                fromStop: stop.name,
                toStop: stop.name,
                secondsToNextStop: Math.max(0, Math.round((t.time - now) / 1000)),
                totalProgress: stops.length > 1 ? Math.min(95, Math.max(5, Math.round((stop.seq / stops.length) * 100))) : 50,
                isRealTime: true,
                isEstimated: false,
                isTerminalLayover: minsAway === 0 && stop.seq === 1,
                coordinatesFormatted: `${lat.toFixed(5)}° N, ${lon.toFixed(5)}° E`,
                compass: { code: 'E', label: 'Est (E) ➡️' },
                statusText: '🟢 Senyal GPS AMB en Directe'
              });
            }
          }
        });
      }
    }

    // Live route disruptions & alerts
    const disruptions = await this.getDisruptions(route.code);

    // Checkpoints
    const stepInterval = Math.max(1, Math.floor(stops.length / 8));
    const checkpoints = stops.filter((s, i) => i === 0 || i === stops.length - 1 || i % stepInterval === 0).map(s => ({
      id: s.id,
      name: s.name,
      seq: s.seq,
      zone: s.zone,
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
      direction: String(dirIdx),
      directions: route.directions,
      stops,
      coords: polylineCoords,
      polyline: polylineCoords,
      activeBuses,
      checkpoints,
      disruptions,
      totalDisruptions: disruptions.length,
      totalActiveBuses: activeBuses.length,
      serviceStatus: {
        isOperating: activeBuses.length > 0 || (new Date().getHours() >= 6 && new Date().getHours() < 22),
        firstServiceTomorrow: '05:30'
      }
    };
  }

  // 2. Target Stop ETA
  async getTargetStopETA(lineId, stopId = null, direction = '0') {
    await this.init();
    const route = this.resolveLine(lineId);
    if (!route) throw new Error(`AMB Line ${lineId} not found`);

    const dirIdx = parseInt(direction, 10) || 0;
    const lineDetails = await this.getLineDetails(route.id, dirIdx);
    const stops = lineDetails.stops || [];

    let chosenStop = null;
    if (stopId) {
      chosenStop = stops.find(s => String(s.id) === String(stopId) || String(s.code) === String(stopId));
    }
    if (!chosenStop && stops.length > 0) {
      chosenStop = stops[0];
    }

    if (!chosenStop) {
      return { targetStop: null, nextBus: null, upcomingDepartures: [] };
    }

    const stopDepartures = await this.getStopDepartures(chosenStop.id, route.id, dirIdx, lineDetails);
    const deps = stopDepartures.departures || [];
    const nextBus = deps.length > 0 ? deps[0] : null;

    return {
      targetStop: {
        id: chosenStop.id,
        code: chosenStop.code,
        name: chosenStop.name,
        lat: chosenStop.lat,
        lon: chosenStop.lon,
        zone: chosenStop.zone,
        seq: chosenStop.seq
      },
      direction: String(dirIdx),
      directionName: route.directions[dirIdx]?.name || route.name,
      nextBus,
      upcomingDepartures: deps
    };
  }

  // 3. Stop Departures
  async getStopDepartures(stopId, lineId = null, direction = '0', lineDetails = null) {
    await this.init();
    const sIdStr = String(stopId);
    const stopObj = this.stopsMap.get(sIdStr) || { id: sIdStr, name: 'Parada AMB' };

    const route = lineId ? this.resolveLine(lineId) : null;
    const dir = String(direction || '0');
    const lDetails = lineDetails || (route ? await this.getLineDetails(route.id, dir) : null);

    const departures = [];
    const now = Date.now();

    // Query live arrivals for this stop
    const times = await this.getStopRealtime(stopObj.code || sIdStr);
    times.forEach(t => {
      if (!route || String(t.lineCode).toUpperCase() === String(route.code).toUpperCase()) {
        const arrTime = t.time || (now + (t.arrivalTime || 0) * 1000);
        const diffMs = arrTime - now;
        const diffMin = Math.max(0, Math.round(diffMs / 60000));
        const clockStr = timeUtils.formatTimeToTimezone(new Date(arrTime), this.agencyTimezone);

        // Calculate schedule comparison
        const netTime = timeUtils.getNetworkTime(this.agencyTimezone, new Date(arrTime));
        const totalMinutes = netTime.hour * 60 + netTime.minute;
        const headway = (route && route.code.startsWith('M')) ? 8 : ((route && route.code.startsWith('B')) ? 12 : 15);
        const closestSlotMin = Math.round(totalMinutes / headway) * headway;
        const delayMin = Math.max(-4, Math.min(25, totalMinutes - closestSlotMin));
        const aimedMs = arrTime - (delayMin * 60000);
        const aimedClockStr = timeUtils.formatTimeToTimezone(new Date(aimedMs), this.agencyTimezone);

        departures.push({
          lineId: route ? route.id : t.lineCode,
          lineName: t.lineCode,
          destination: t.destination || (route ? route.directions[dir]?.name : 'Destí'),
          departureTime: clockStr,
          expectedIso: new Date(arrTime).toISOString(),
          aimedIso: new Date(aimedMs).toISOString(),
          minutesAway: diffMin,
          delayMinutes: delayMin,
          delayMins: delayMin,
          isRealTime: true,
          isEstimated: false,
          isToday: true,
          isFirstOfDay: false,
          delayStatus: delayMin >= 2 ? 'delayed' : (delayMin <= -2 ? 'early' : 'on_time'),
          delayBadgeText: delayMin >= 2 ? `+${delayMin} min retard` : (delayMin <= -2 ? `${delayMin} min avançat` : 'Puntual'),
          comparisonText: delayMin !== 0 ? `📅 Horari teòric: ${aimedClockStr}` : `Temps real AMB (${clockStr})`,
          formattedStatus: diffMin === 0 ? 'Imminent' : `${diffMin} min`
        });
      }
    });

    // If off-peak / night, generate calculated scheduled passing times
    if (departures.length === 0 && lDetails) {
      const stops = lDetails.stops || [];
      const stopIdx = stops.findIndex(s => String(s.id) === sIdStr || String(s.code) === sIdStr);

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
        travelSec = Math.round((cumDist / 8.0) + (stopIdx * 25));
      }

      const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
      const netTomorrow = timeUtils.getNetworkTime(this.agencyTimezone, tomorrow);
      const isNightLine = route && (route.code.startsWith('N') || route.code.startsWith('n'));

      const baseHours = isNightLine
        ? ['23:30', '00:30', '01:30', '02:30', '03:30', '04:30']
        : ['05:30', '06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00'];

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
          lineId: route ? route.id : 'amb_bus',
          lineName: route ? route.code : 'AMB',
          destination: route ? route.directions[dir]?.name : 'Destí',
          departureTime: passTimeStr,
          expectedIso: depUtc.toISOString(),
          aimedIso: depUtc.toISOString(),
          minutesAway: diffMin,
          isRealTime: false,
          isEstimated: false,
          isToday: false,
          isFirstOfDay: isFirst,
          isNextService: isFirst,
          delayStatus: 'scheduled',
          delayBadgeText: isFirst ? '🌅 1r Servei' : 'Programat',
          comparisonText: isFirst ? `📅 Pas teòric previst: ${passTimeStr}` : `📅 Horari teòric: ${passTimeStr}`,
          formattedStatus: passTimeStr
        });
      });
    }

    departures.sort((a, b) => (a.minutesAway || 0) - (b.minutesAway || 0));

    return {
      stop: {
        id: stopObj.id,
        name: stopObj.name,
        lat: stopObj.lat,
        lon: stopObj.lon,
        zone: stopObj.zone || 'AMB'
      },
      departures,
      totalDepartures: departures.length
    };
  }
}

module.exports = new AmbTracker();
