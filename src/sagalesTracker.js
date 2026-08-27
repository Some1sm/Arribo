const https = require('https');
const geoEngine = require('./core/geo/geoEngine');
const timeEngine = require('./core/time/timeEngine');
const calendarEngine = require('./core/time/calendarEngine');
const scheduleSynthesizer = require('./core/schedule/scheduleSynthesizer');
const delayEngine = require('./core/schedule/delayEngine');
const geoUtils = require('./geoUtils');
const timeUtils = require('./timeUtils');
const gtfsScheduleStore = require('./core/schedule/gtfsScheduleStore');
const BaseTracker = require('./core/BaseTracker');

// Polyline decoder using shared core geoEngine
function decodePolyline(encoded) {
  if (!encoded) return [];
  return geoEngine.decodePolyline(encoded).map(p => [p.lat, p.lon]);
}

function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// Sagalés Lines Catalog
const SAGALES_LINES_CONFIG = {
  'n82': {
    id: 'n82',
    sagalesRouteId: '680',
    code: 'N82',
    name: 'Barcelona ⇄ Mataró ⇄ Malgrat de Mar (NitBus)',
    color: '#457336',
    agency: 'Sagalés (NitBus Maresme)',
    defaultTargetStopCode: '3756', // Pg. de Gràcia (Barcelona)
    directions: [
      { dirId: '0', name: 'Cap a Malgrat de Mar' },
      { dirId: '1', name: 'Cap a Barcelona (Pg. de Gràcia)' }
    ]
  },
  'n83': {
    id: 'n83',
    sagalesRouteId: '683',
    code: 'N83',
    name: 'Mataró ⇄ Malgrat de Mar (NitBus)',
    color: '#457336',
    agency: 'Sagalés (NitBus Maresme)',
    defaultTargetStopCode: '4068',
    directions: [
      { dirId: '0', name: 'Cap a Malgrat de Mar' },
      { dirId: '1', name: 'Cap a Mataró' }
    ]
  },
  '603': {
    id: '603',
    sagalesRouteId: '603',
    code: '603',
    name: 'Aeroport T1/T2 ⇄ Barcelona ⇄ Blanes (per N-II)',
    color: '#15B0AF',
    agency: 'Sagalés (Línia Costa)',
    defaultTargetStopCode: '3756',
    directions: [
      { dirId: '0', name: 'Cap a Blanes' },
      { dirId: '1', name: 'Cap a Aeroport del Prat' }
    ]
  },
  'n70': {
    id: 'n70',
    sagalesRouteId: '280',
    code: 'N70',
    name: 'Barcelona ⇄ Caldes de Montbui (NitBus)',
    color: '#457336',
    agency: 'Sagalés (NitBus Vallès)',
    defaultTargetStopCode: '3756',
    directions: [
      { dirId: '0', name: 'Cap a Caldes de Montbui' },
      { dirId: '1', name: 'Cap a Barcelona' }
    ]
  },
  'n71': {
    id: 'n71',
    sagalesRouteId: '380',
    code: 'N71',
    name: 'Barcelona ⇄ Mollet ⇄ Granollers (NitBus)',
    color: '#457336',
    agency: 'Sagalés (NitBus Vallès)',
    defaultTargetStopCode: '3756',
    directions: [
      { dirId: '0', name: 'Cap a Granollers' },
      { dirId: '1', name: 'Cap a Barcelona' }
    ]
  },
  'n73': {
    id: 'n73',
    sagalesRouteId: '580',
    code: 'N73',
    name: 'Barcelona ⇄ Granollers ⇄ Sant Celoni (NitBus)',
    color: '#457336',
    agency: 'Sagalés (NitBus Vallès)',
    defaultTargetStopCode: '3756',
    directions: [
      { dirId: '0', name: 'Cap a Sant Celoni' },
      { dirId: '1', name: 'Cap a Barcelona' }
    ]
  }
};

class SagalesTracker extends BaseTracker {
  constructor() {
    super();
    this.agencyTimezone = 'Europe/Madrid';
    this.cache = new Map(); // `${routeId}_${dir}` -> { timestamp, data }
    this.cacheTtlMs = 12000; // 12 seconds TTL
    this.allStopsMap = new Map(); // stopCode -> stop object
    this._cachedRutaMap = new Map(); // `${routeId}_${dir}` -> ruta object (permanent route topography cache)
    // Pluggable transport: in the main HTTP process this is installed by
    // server.js to proxy upstream fetches through WorkerBridge IPC, so the
    // web process NEVER calls the Sagalés API directly. Defaults to direct
    // HTTPS (used inside the ingestion worker / local tooling).
    this._fetchBackend = null;
    this._loadRutaDiskCache();
  }

  _loadRutaDiskCache() {
    try {
      const fs = require('fs');
      const path = require('path');
      const cachePath = path.join(__dirname, '..', 'data', 'cache', 'sagales_rutas.json');
      if (fs.existsSync(cachePath)) {
        const raw = fs.readFileSync(cachePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) {
            if (v && typeof v === 'object') {
              this._cachedRutaMap.set(k, v);
            }
          }
        }
      }
    } catch (_) {}
  }

  _saveRutaDiskCache() {
    try {
      const fs = require('fs');
      const path = require('path');
      const cacheDir = path.join(__dirname, '..', 'data', 'cache');
      if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
      const obj = {};
      for (const [k, v] of this._cachedRutaMap.entries()) {
        obj[k] = v;
      }
      fs.writeFileSync(path.join(cacheDir, 'sagales_rutas.json'), JSON.stringify(obj), 'utf8');
    } catch (_) {}
  }

  /**
   * Install an alternative upstream transport. fn({ routeId, dir }) must
   * resolve to the raw feed JSON (or null on failure).
   */
  setFetchBackend(fn) {
    this._fetchBackend = typeof fn === 'function' ? fn : null;
  }

  // HTTP GET helper with timeout
  async fetchJson(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*'
        },
        timeout: 6000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`Failed to parse JSON from ${url}: ${err.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request timeout for ${url}`));
      });
    });
  }

  // Get raw Sagalés real-time data with caching
  async getSagalesFeed(sagalesRouteId, direction = '0') {
    const dir = direction === '1' ? '1' : '0';
    const cacheKey = `${sagalesRouteId}_${dir}`;
    const now = Date.now();

    const cached = this.cache.get(cacheKey);
    if (cached && (now - cached.timestamp < this.cacheTtlMs)) {
      return cached.data;
    }

    try {
      let json;
      if (this._fetchBackend) {
        json = await this._fetchBackend({ routeId: sagalesRouteId, dir });
      } else {
        const url = `https://www.sagales.com/real-time-bus/${sagalesRouteId}/${dir}`;
        json = await this.fetchJson(url);
      }
      if (json) {
        if (json.ruta && Array.isArray(json.ruta.stops) && json.ruta.stops.length > 0) {
          this._cachedRutaMap.set(cacheKey, json.ruta);
        } else if (!json.ruta && this._cachedRutaMap.has(cacheKey)) {
          json.ruta = this._cachedRutaMap.get(cacheKey);
        }
        this.cache.set(cacheKey, { timestamp: now, data: json });
      } else if (this._cachedRutaMap.has(cacheKey)) {
        json = { ruta: this._cachedRutaMap.get(cacheKey), bus: { entities: [] } };
      }
      return json;
    } catch (err) {
      console.warn(`[SagalesTracker] Notice: Upstream feed unavailable for ${sagalesRouteId}/${dir} (${err.message})`);
      if (cached) return cached.data; // Fallback to stale cache
      if (this._cachedRutaMap.has(cacheKey)) {
        return { ruta: this._cachedRutaMap.get(cacheKey), bus: { entities: [] } };
      }
      return null;
    }
  }

  // Get list of supported Sagalés lines
  getLines() {
    return Object.values(SAGALES_LINES_CONFIG).map(l => ({
      id: l.id,
      code: l.code,
      name: l.name,
      color: l.color,
      agency: l.agency,
      directions: l.directions
    }));
  }

  // Find line configuration by ID or code
  resolveLineConfig(lineId) {
    const key = String(lineId).toLowerCase().replace('line-', '').replace('linia-', '');
    return SAGALES_LINES_CONFIG[key] || Object.values(SAGALES_LINES_CONFIG).find(l => l.code.toLowerCase() === key || l.sagalesRouteId === key);
  }

  // 1. Get Line Details, Stops, Polyline & Active Buses
  async getLineDetails(lineId, direction = '0') {
    const lineConfig = this.resolveLineConfig(lineId);
    if (!lineConfig) {
      throw new Error(`Sagalés line ${lineId} not found`);
    }

    if (direction === 'both' && lineConfig.directions?.length > 1) {
      const details0 = await this.getLineDetails(lineConfig.id, '0');
      const details1 = await this.getLineDetails(lineConfig.id, '1');

      const seenVehs = new Set();
      const combinedActiveBuses = [];
      [...(details0.activeBuses || []), ...(details1.activeBuses || [])].forEach(b => {
        if (!b) return;
        const vKey = String(b.vehicleId || b.tripId || `${b.lat}_${b.lon}`);
        if (!seenVehs.has(vKey)) {
          seenVehs.add(vKey);
          combinedActiveBuses.push(b);
        }
      });

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
          { dirId: '0', name: lineConfig.directions[0]?.name || 'Sentit 1', stops: details0.stops, coords: details0.coords },
          { dirId: '1', name: lineConfig.directions[1]?.name || 'Sentit 2', stops: details1.stops, coords: details1.coords }
        ],
        activeBuses: combinedActiveBuses,
        totalActiveBuses: combinedActiveBuses.length
      };
    }

    const dir = direction === '1' ? '1' : '0';
    let feed = await this.getSagalesFeed(lineConfig.sagalesRouteId, dir);

    let stops = [];
    let polylineCoords = [];
    let activeBuses = [];

    const ruta = feed?.ruta || this._cachedRutaMap.get(`${lineConfig.sagalesRouteId}_${dir}`);

    if (ruta) {
      const rawStops = ruta.stops || [];
      stops = rawStops.map((s, idx) => {
        const stopObj = {
          id: String(s.stopCode || s.id),
          code: String(s.stopCode || s.id),
          mouteStopId: String(s.stopCode || s.id),
          name: s.stopName,
          city: s.commercialCity || '',
          lat: parseFloat(s.stopLat),
          lon: parseFloat(s.stopLon),
          seq: s.stopsequence || idx + 1,
          zone: s.commercialCity || 'Sagalés'
        };

        // Populate search map
        this.allStopsMap.set(stopObj.id, {
          ...stopObj,
          lineId: lineConfig.id,
          lineCode: lineConfig.code,
          lineColor: lineConfig.color
        });

        return stopObj;
      });

      if (ruta.shapes) {
        polylineCoords = decodePolyline(ruta.shapes);
      }
    }

    // Process Active Buses
    if (feed && feed.bus && Array.isArray(feed.bus.entities)) {
      const rawEntities = feed.bus.entities;
      const now = Date.now();

      // Filter to ONLY buses traveling in the requested direction
      const entities = rawEntities.filter(ent => {
        const entDir = String(ent.tripUpdate?.trip?.directionId ?? ent.vehicle?.trip?.directionId ?? '0');
        return entDir === dir;
      });

      activeBuses = entities.map((ent, idx) => {
        const v = ent.vehicle || {};
        // Upstream Sagalés feed misspells the key as "postion" — read both defensively
        const pos = v.position || v.postion || {};
        const trip = ent.tripUpdate?.trip || v.trip || {};
        const tripUpdates = ent.tripUpdate?.stopTimeUpdate || [];

        const lat = Number(pos.latitude);
        const lon = Number(pos.longitude);
        // Skip vehicles without a valid, non-zero GPS fix instead of defaulting to (0, 0)
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
          return null;
        }
        const speedKmh = Math.round((pos.speed || 0) * 3.6) || 0;
        const bearing = pos.bearing || 0;

        // Current Stop & Next Stop prediction
        const currSeq = v.currentStopSequence || 1;
        const nextStopObj = stops.find(s => s.seq === currSeq) || stops[Math.min(currSeq - 1, stops.length - 1)];
        const prevStopObj = stops.find(s => s.seq === currSeq - 1) || stops[0];

        // Next Stop ETA from stopTimeUpdate
        let secondsToNextStop = 0;
        if (tripUpdates.length > 0) {
          const nextUpdate = tripUpdates.find(u => parseInt(u.stopSequence, 10) >= currSeq) || tripUpdates[0];
          if (nextUpdate && nextUpdate.arrival?.time) {
            secondsToNextStop = Math.max(0, Math.round((nextUpdate.arrival.time - now) / 1000));
          }
        }

        const totalProgress = stops.length > 1 ? Math.round((currSeq / stops.length) * 100) : 50;

        return {
          vehicleId: v.vehicle?.id || `0${idx + 1}`,
          tripId: trip.tripId || `sagales_${lineConfig.code}_d${dir}_${idx}`,
          lineId: lineConfig.id,
          lineName: lineConfig.code,
          direction: String(dir),
          destination: trip.headSign || (dir === '0' ? lineConfig.directions[0].name : lineConfig.directions[1].name),
          lat,
          lon,
          bearing,
          speedKmh: speedKmh > 0 ? speedKmh : 35,
          currentStopSeq: currSeq,
          fromStop: prevStopObj?.name || 'Inici de línia',
          toStop: nextStopObj?.name || 'Destí',
          secondsToNextStop,
          totalProgress,
          isRealTime: true,
          isEstimated: false,
          isTerminalLayover: speedKmh === 0 && (currSeq <= 1 || currSeq >= stops.length),
          coordinatesFormatted: `${lat.toFixed(5)}° N, ${lon.toFixed(5)}° E`,
          compass: geoUtils.bearingToCompassName(bearing),
          statusText: '🟢 Senyal GPS Sagalés en Directe'
        };
      }).filter(Boolean);
    }

    // Generate Checkpoints
    const stepInterval = Math.max(1, Math.floor(stops.length / 8));
    const checkpoints = stops.filter((s, i) => i === 0 || i === stops.length - 1 || i % stepInterval === 0).map(s => {
      const activeBus = activeBuses[0] || null;
      const isPassed = activeBus ? s.seq < activeBus.currentStopSeq : false;
      const hasBus = activeBus ? (s.seq === activeBus.currentStopSeq) : false;

      return {
        id: s.id,
        name: s.name,
        seq: s.seq,
        zone: s.city || 'Sagalés',
        isPassed,
        hasBus,
        etaMinutes: activeBus ? Math.max(0, Math.round((s.seq - activeBus.currentStopSeq) * 2.5)) : 0
      };
    });

    return {
      id: lineConfig.id,
      code: lineConfig.code,
      name: lineConfig.name,
      color: lineConfig.color,
      agency: lineConfig.agency,
      direction: dir,
      directions: lineConfig.directions,
      stops,
      coords: polylineCoords,
      polyline: polylineCoords,
      activeBuses,
      checkpoints,
      totalActiveBuses: activeBuses.length,
      serviceStatus: {
        isOperating: activeBuses.length > 0,
        firstServiceTomorrow: '23:30'
      }
    };
  }

  // 2. Get Target Stop ETA & Upcoming Departures
  async getTargetStopETA(lineId, stopId = null, direction = '0') {
    const lineConfig = this.resolveLineConfig(lineId);
    if (!lineConfig) throw new Error(`Sagalés line ${lineId} not found`);

    const dir = direction === '1' ? '1' : '0';
    const lineDetails = await this.getLineDetails(lineConfig.id, dir);

    const stops = lineDetails.stops || [];
    let chosenStop = null;

    if (stopId) {
      chosenStop = stops.find(s => String(s.id) === String(stopId) || String(s.code) === String(stopId));
    }

    if (!chosenStop) {
      chosenStop = stops.find(s => s.code === lineConfig.defaultTargetStopCode) || stops[0];
    }

    if (!chosenStop) {
      return { targetStop: null, nextBus: null, upcomingDepartures: [] };
    }

    const feed = await this.getSagalesFeed(lineConfig.sagalesRouteId, dir);
    const stopDepartures = await this.getStopDepartures(chosenStop.id, lineConfig.id, dir, feed, lineDetails);

    const deps = stopDepartures.departures || [];
    const nextBus = deps.length > 0 ? deps[0] : null;

    return {
      targetStop: {
        id: chosenStop.id,
        code: chosenStop.code,
        name: chosenStop.name,
        lat: chosenStop.lat,
        lon: chosenStop.lon,
        zone: chosenStop.zone || chosenStop.city || 'Sagalés'
      },
      direction: dir,
      directionName: dir === '0' ? lineConfig.directions[0].name : lineConfig.directions[1].name,
      nextBus,
      upcomingDepartures: deps
    };
  }

  // 3. Get Stop Departures for any Stop
  /**
   * Memoised GTFS stop coordinates (stopId -> {lat, lon}) for proximity
   * mapping between tracker stop codes and GTFS stops.
   */
  gtfsStopCoords() {
    if (this._gtfsStopCoords) return this._gtfsStopCoords;
    this._gtfsStopCoords = new Map();
    try {
      const fs = require('fs');
      const path = require('path');
      const stopsPath = path.join(__dirname, '..', 'data', 'atm_gtfs', 'stops.txt');
      const lines = fs.readFileSync(stopsPath, 'utf8').split('\n');
      const h = {};
      (lines[0] || '').split(',').forEach((nm, i) => { h[nm.trim()] = i; });
      lines.slice(1).forEach(l => {
        if (!l.trim()) return;
        const p = parseCsvLine(l);
        const id = p[h.stop_id];
        const lat = parseFloat(p[h.stop_lat]), lon = parseFloat(p[h.stop_lon]);
        if (id && Number.isFinite(lat) && Number.isFinite(lon)) this._gtfsStopCoords.set(id, { lat, lon });
      });
    } catch (e) { /* keep empty */ }
    return this._gtfsStopCoords;
  }

  /**
   * Maps tracker stop codes to GTFS stop ids for a route schedule via
   * geographic proximity (<200m). Memoised per route.
   */
  gtfsStopMapping(lineConfigId, gtfsSched, stops, dir = '0') {
    if (!this._gtfsStopMaps) this._gtfsStopMaps = new Map();
    // Per-line AND per-direction: dir0/dir1 stop lists differ.
    const mapKey = lineConfigId + '_' + dir;
    if (this._gtfsStopMaps.has(mapKey)) return this._gtfsStopMaps.get(mapKey);
    const mapping = new Map(); // trackerStopCode -> gtfsStopId
    try {
      const coords = this.gtfsStopCoords();
      const gtfsStops = new Map(); // gtfsStopId -> {lat, lon}
      [...gtfsSched.dir0, ...gtfsSched.dir1].forEach(t => t.stops.forEach(s => {
        if (!gtfsStops.has(s.stopId) && coords.has(s.stopId)) gtfsStops.set(s.stopId, coords.get(s.stopId));
      }));
      for (const s of (stops || [])) {
        let best = null;
        for (const [gid, g] of gtfsStops) {
          const d = Math.hypot((g.lat - s.lat) * 111320, (g.lon - s.lon) * 111320 * Math.cos(g.lat * Math.PI / 180));
          if (d < 200 && (!best || d < best.d)) best = { gid, d };
        }
        if (best) mapping.set(String(s.id || s.code), best.gid);
      }
    } catch (_) {}
    this._gtfsStopMaps.set(mapKey, mapping);
    return mapping;
  }

  /**
   * Today's active GTFS trips passing through a tracker stop (via the
   * proximity mapping). Returns [{tripId, serviceId, passSec}] sorted.
   */
  gtfsTripsForStop(lineConfigId, gtfsSched, dir, trackerStopId, dateObj = new Date(), stops = null) {
    if (!gtfsSched) return [];
    const mapping = this.gtfsStopMapping(lineConfigId, gtfsSched, stops, dir);
    const gtfsStopId = mapping.get(String(trackerStopId));
    if (!gtfsStopId) return [];

    // Select the GTFS direction that best aligns with the tracker direction
    let score0 = 0;
    let score1 = 0;
    for (const s of (stops || [])) {
      const gid = mapping.get(String(s.id || s.code));
      if (!gid) continue;
      if (gtfsSched.dir0.some(t => t.stops.some(x => x.stopId === gid))) score0++;
      if (gtfsSched.dir1.some(t => t.stops.some(x => x.stopId === gid))) score1++;
    }
    const trips = (score1 > score0 && gtfsSched.dir1.length > 0) ? gtfsSched.dir1
      : ((score0 > score1 && gtfsSched.dir0.length > 0) ? gtfsSched.dir0
      : (String(dir) === '1' ? (gtfsSched.dir1.length ? gtfsSched.dir1 : gtfsSched.dir0) : (gtfsSched.dir0.length ? gtfsSched.dir0 : gtfsSched.dir1)));

    const out = [];
    for (const trip of trips) {
      if (!this.gtfsIsServiceActive(trip.serviceId, dateObj)) continue;
      const st = trip.stops.find(x => x.stopId === gtfsStopId);
      if (!st) continue;
      const sec = timeUtils.timeToSec(st.dep || st.arr);
      if (!Number.isFinite(sec)) continue;
      out.push({ tripId: trip.tripId, serviceId: trip.serviceId, passSec: sec });
    }
    out.sort((a, b) => a.passSec - b.passSec);
    return out;
  }

  ensureGtfsCalendar() {
    if (this._gtfsCalLoaded) return;
    this._gtfsCalLoaded = true;
    this._gtfsCalWeekly = [];
    this._gtfsCalExceptions = new Map();
    try {
      const fs = require('fs');
      const path = require('path');
      const atmDir = path.join(__dirname, '..', 'data', 'atm_gtfs');
      const datesFile = path.join(atmDir, 'calendar_dates.txt');
      if (fs.existsSync(datesFile)) {
        fs.readFileSync(datesFile, 'utf8').split('\n').slice(1).forEach(raw => {
          const line = raw.trim();
          if (!line) return;
          const [sId, dateStr, excType] = line.split(',');
          if (!sId || !dateStr) return;
          if (!this._gtfsCalExceptions.has(dateStr)) this._gtfsCalExceptions.set(dateStr, { active: new Set(), inactive: new Set() });
          const entry = this._gtfsCalExceptions.get(dateStr);
          if (excType === '1') entry.active.add(sId);
          if (excType === '2') entry.inactive.add(sId);
        });
      }
      const calFile = path.join(atmDir, 'calendar.txt');
      if (fs.existsSync(calFile)) {
        fs.readFileSync(calFile, 'utf8').split('\n').slice(1).forEach(raw => {
          const line = raw.trim();
          if (!line) return;
          const p = line.split(',');
          if (!p[0]) return;
          this._gtfsCalWeekly.push({
            serviceId: p[0],
            monday: p[1] === '1', tuesday: p[2] === '1', wednesday: p[3] === '1',
            thursday: p[4] === '1', friday: p[5] === '1', saturday: p[6] === '1', sunday: p[7] === '1',
            startDate: p[8], endDate: p[9]
          });
        });
      }
    } catch (e) { /* keep empty */ }
  }

  gtfsIsServiceActive(serviceId, dateObj = new Date()) {
    if (!serviceId) return true;
    this.ensureGtfsCalendar();
    return calendarEngine.isServiceActiveOnDate(serviceId, this._gtfsCalWeekly, this._gtfsCalExceptions, dateObj, this.agencyTimezone);
  }

  async getStopDepartures(stopId, lineId = null, direction = '0', feed = null, lineDetails = null) {
    const lineConfig = this.resolveLineConfig(lineId || 'n82');
    const dir = direction === '1' ? '1' : '0';

    const lDetails = lineDetails || await this.getLineDetails(lineConfig.id, dir);
    const lFeed = feed || await this.getSagalesFeed(lineConfig.sagalesRouteId, dir);

    const sIdStr = String(stopId);
    const stopObj = lDetails.stops.find(s => String(s.id) === sIdStr || String(s.code) === sIdStr) || { id: sIdStr, name: 'Parada Sagalés' };

    const departures = [];
    const now = Date.now();

    if (lFeed && lFeed.bus && Array.isArray(lFeed.bus.entities)) {
      lFeed.bus.entities.forEach(ent => {
        const trip = ent.tripUpdate?.trip || ent.vehicle?.trip || {};
        const entDir = String(trip.directionId ?? ent.vehicle?.trip?.directionId ?? '0');
        if (entDir !== dir) return; // Skip buses from opposite direction

        const v = ent.vehicle || {};
        const stopUpdates = ent.tripUpdate?.stopTimeUpdate || [];

        // Check if this vehicle is serving the requested stop
        const match = stopUpdates.find(u => String(u.stopId) === sIdStr);
        if (match && match.arrival?.time) {
          const rawTime = Number(match.arrival.time);
          const arrTime = rawTime > 1e11 ? rawTime : rawTime * 1000;
          if (!arrTime || isNaN(arrTime) || arrTime < 946684800000) return;
          const diffMs = arrTime - now;
          const diffMin = Math.round(diffMs / 60000);
          if (diffMin < -5) return;
          const safeDiffMin = Math.max(0, diffMin);
          const delayMin = Math.round((match.arrival.delay || 0) / 60);

          const clockStr = timeUtils.formatTimeToTimezone(new Date(arrTime), this.agencyTimezone);
          if (clockStr === '--:--') return;

          departures.push({
            lineId: lineConfig.id,
            lineName: lineConfig.code,
            destination: trip.headSign || (dir === '0' ? lineConfig.directions[0].name : lineConfig.directions[1].name),
            departureTime: clockStr,
            expectedIso: new Date(arrTime).toISOString(),
            aimedIso: new Date(arrTime - (match.arrival.delay || 0) * 1000).toISOString(),
            minutesAway: safeDiffMin,
            vehicleId: v.vehicle?.id || null,
            isRealTime: true,
            isEstimated: false,
            isToday: true,
            isFirstOfDay: false,
            delayStatus: delayMin >= 2 ? 'delayed' : 'on_time',
            delayBadgeText: delayMin >= 2 ? `+${delayMin} min retard` : 'Puntual',
            comparisonText: `Temps real Sagalés (${clockStr})`,
            formattedStatus: safeDiffMin === 0 ? 'Imminent' : `${safeDiffMin} min`
          });
        }
      });
    }

    // If no real-time trips found (or off-peak), use the REAL GTFS timetable
    // (service-day filtered) with the legacy hourly fallback only for routes
    // missing from the feed (e.g. 603).
    if (departures.length === 0) {
      const stops = lDetails.stops || [];
      const gtfsRouteId = gtfsScheduleStore.SAGALES_ROUTE_IDS[String(lineConfig.id).toLowerCase()];
      const gtfsSched = gtfsRouteId ? gtfsScheduleStore.getRouteSchedule(gtfsRouteId) : null;
      const gtfsTrips = gtfsSched ? this.gtfsTripsForStop(lineConfig.id, gtfsSched, dir, stopObj.id || sIdStr, new Date(), stops) : [];

      // Route known in the feed but this stop is not served by the current
      // (service-day-filtered) pattern — e.g. night express skipping urban
      // stops. Show an honest "no service" entry instead of fabricated times.
      if (gtfsSched && gtfsTrips.length === 0) {
        departures.push({
          lineId: lineConfig.id,
          lineName: lineConfig.code,
          destination: dir === '0' ? lineConfig.directions[0].name : lineConfig.directions[1].name,
          departureTime: '--:--',
          minutesAway: null,
          isRealTime: false,
          isEstimated: false,
          isToday: true,
          isFirstOfDay: false,
          isNextService: false,
          delayStatus: 'scheduled',
          delayBadgeText: 'Sense servei',
          comparisonText: '🚫 Aquesta parada no és servida pel patró actual de la línia (horari oficial GTFS)',
          formattedStatus: 'Sense servei'
        });
      } else if (gtfsTrips.length > 0) {
        const netNow = timeUtils.getNetworkTime(this.agencyTimezone, new Date(now));
        const nowSec = netNow.hour * 3600 + netNow.minute * 60 + netNow.second;
        const secToTimeStr = (sec) => `${String(Math.floor(sec / 3600) % 24).padStart(2, '0')}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}`;
        for (const t of gtfsTrips) {
          // Night-rollover: an early-morning pass time already in the past
          // belongs to TONIGHT's upcoming service (next occurrence ~24h later).
          let passSec = t.passSec;
          let isTodayDep = true;
          if (passSec < nowSec - 300 && passSec < 12 * 3600) {
            passSec += 86400;
            isTodayDep = false;
          } else if (passSec < nowSec - 300) {
            // Already departed earlier in the day; cycle forward to tomorrow's schedule
            passSec += 86400;
            isTodayDep = false;
          }
          const diffMin = Math.round((passSec - nowSec) / 60);
          const passTimeStr = secToTimeStr(passSec);
          departures.push({
            lineId: lineConfig.id,
            lineName: lineConfig.code,
            destination: dir === '0' ? lineConfig.directions[0].name : lineConfig.directions[1].name,
            departureTime: passTimeStr,
            expectedIso: timeUtils.localTimeToUtcDate(netNow.year, netNow.month, netNow.day + (isTodayDep ? 0 : 1), Math.floor(passSec / 3600) % 24, Math.floor(passSec / 60) % 60, 0, this.agencyTimezone).toISOString(),
            minutesAway: Math.max(1, diffMin),
            isRealTime: false,
            isEstimated: false,
            isToday: isTodayDep,
            isFirstOfDay: false,
            delayStatus: 'scheduled',
            delayBadgeText: 'Programat',
            comparisonText: `📅 Horari teòric (GTFS): ${passTimeStr}`,
            formattedStatus: passTimeStr
          });
        }
        departures.sort((a, b) => a.minutesAway - b.minutesAway);
      } else {
      const travelTimes = scheduleSynthesizer.estimateStopTravelTimes(stops, {
        speedMps: 10.0,
        dwellSecPerStop: 30,
        defaultSegmentMeters: 600
      });
      const travelSec = scheduleSynthesizer.getTravelTimeToStop(travelTimes, sIdStr);

      const netNow = timeUtils.getNetworkTime(this.agencyTimezone, new Date(now));
      const tomorrow = new Date(now + 24 * 3600 * 1000);
      const networkTomorrow = timeUtils.getNetworkTime(this.agencyTimezone, tomorrow);

      const baseScheduleMap = {
        'n82': {
          '0': ['23:45', '00:45', '01:45', '02:45', '03:45', '04:45'],
          '1': ['23:30', '00:30', '01:30', '02:30', '03:30', '04:30']
        },
        'n83': {
          '0': ['00:00', '01:00', '02:00', '03:00', '04:00', '05:00'],
          '1': ['23:30', '00:30', '01:30', '02:30', '03:30', '04:30']
        },
        '603': {
          '0': ['06:30', '07:30', '08:30', '09:30', '10:30', '11:30', '12:30', '13:30', '14:30', '15:30', '16:30', '17:30', '18:30', '19:30', '20:30', '21:30'],
          '1': ['06:00', '07:00', '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00', '21:00']
        },
        'n70': {
          '0': ['23:45', '00:45', '01:45', '02:45', '03:45', '04:45'],
          '1': ['23:15', '00:15', '01:15', '02:15', '03:15', '04:15']
        },
        'n71': {
          '0': ['23:45', '00:45', '01:45', '02:45', '03:45', '04:45'],
          '1': ['23:15', '00:15', '01:15', '02:15', '03:15', '04:15']
        },
        'n73': {
          '0': ['23:45', '00:45', '01:45', '02:45', '03:45', '04:45'],
          '1': ['23:15', '00:15', '01:15', '02:15', '03:15', '04:15']
        }
      };

      const baseTimes = baseScheduleMap[lineConfig.id]?.[dir] || ['23:45', '00:45', '01:45', '02:45', '03:45', '04:45'];

      baseTimes.forEach(initTimeStr => {
        const initSec = timeUtils.timeToSec(initTimeStr);
        const passSec = initSec + travelSec;
        const passHour = Math.floor(passSec / 3600) % 24;
        const passMin = Math.floor((passSec % 3600) / 60);
        const passTimeStr = `${String(passHour).padStart(2, '0')}:${String(passMin).padStart(2, '0')}`;

        // Check if passing time occurs today or rolls over to tomorrow
        const depUtcToday = timeUtils.localTimeToUtcDate(netNow.year, netNow.month, netNow.day, passHour, passMin, 0, this.agencyTimezone);
        let diffMs = depUtcToday.getTime() - now;
        let isToday = true;
        let depUtc = depUtcToday;

        if (diffMs < -180000) {
          depUtc = timeUtils.localTimeToUtcDate(networkTomorrow.year, networkTomorrow.month, networkTomorrow.day, passHour, passMin, 0, this.agencyTimezone);
          diffMs = depUtc.getTime() - now;
          isToday = false;
        }

        const diffMin = Math.max(1, Math.round(diffMs / 60000));

        departures.push({
          lineId: lineConfig.id,
          lineName: lineConfig.code,
          destination: dir === '0' ? lineConfig.directions[0].name : lineConfig.directions[1].name,
          departureTime: passTimeStr,
          expectedIso: depUtc.toISOString(),
          aimedIso: depUtc.toISOString(),
          minutesAway: diffMin,
          isRealTime: false,
          isEstimated: false,
          isToday: isToday,
          isFirstOfDay: false,
          isNextService: false,
          delayStatus: 'scheduled',
          delayBadgeText: 'Programat',
          comparisonText: isToday ? `📅 Horari teòric: Avui a les ${passTimeStr}` : `📅 Horari teòric: Demà a les ${passTimeStr}`,
          formattedStatus: passTimeStr
        });
      });
      } // end legacy hourly fallback

      // Sort departures strictly by next occurrence (minutesAway)
      departures.sort((a, b) => (a.minutesAway || 0) - (b.minutesAway || 0));

      if (departures.length > 0 && departures[0].departureTime !== '--:--') {
        departures[0].isFirstOfDay = true;
        departures[0].isNextService = true;
        departures[0].delayBadgeText = '🌅 1r Servei';
        departures[0].comparisonText = departures[0].isToday
          ? `📅 Primer servei d'avui (a les ${departures[0].departureTime})`
          : `📅 Primer autobús del matí (Demà a les ${departures[0].departureTime})`;
      }
    }

    const finalDepartures = [];
    const seenTimes = new Set();
    departures.forEach(dep => {
      const key = `${dep.departureTime}_${dep.destination}_${dep.isToday}`;
      if (!seenTimes.has(key)) {
        seenTimes.add(key);
        finalDepartures.push(dep);
      }
    });

    return {
      stop: {
        id: stopObj.id,
        name: stopObj.name,
        lat: stopObj.lat,
        lon: stopObj.lon,
        zone: stopObj.zone || 'Sagalés'
      },
      departures: finalDepartures,
      totalDepartures: finalDepartures.length
    };
  }
}

module.exports = new SagalesTracker();
