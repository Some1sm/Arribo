const https = require('https');
const geoUtils = require('./geoUtils');
const timeUtils = require('./timeUtils');

// Polyline decoder for Google Encoded Polylines
function decodePolyline(encoded) {
  if (!encoded) return [];
  const points = [];
  let index = 0, len = encoded.length;
  let lat = 0, lng = 0;

  while (index < len) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lng += dlng;

    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
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

class SagalesTracker {
  constructor() {
    this.agencyTimezone = 'Europe/Madrid';
    this.cache = new Map(); // `${routeId}_${dir}` -> { timestamp, data }
    this.cacheTtlMs = 12000; // 12 seconds TTL
    this.allStopsMap = new Map(); // stopCode -> stop object
  }

  // HTTP GET helper with timeout
  async fetchJson(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*'
        },
        timeout: 8000
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
      const url = `https://www.sagales.com/real-time-bus/${sagalesRouteId}/${dir}`;
      const json = await this.fetchJson(url);
      this.cache.set(cacheKey, { timestamp: now, data: json });
      return json;
    } catch (err) {
      console.error(`[SagalesTracker] Error fetching ${sagalesRouteId}/${dir}:`, err.message);
      if (cached) return cached.data; // Fallback to stale cache
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
          { dirId: '0', name: lineConfig.directions[0]?.name || 'Sentit 1', stops: details0.stops, coords: details0.coords },
          { dirId: '1', name: lineConfig.directions[1]?.name || 'Sentit 2', stops: details1.stops, coords: details1.coords }
        ],
        activeBuses: [...(details0.activeBuses || []), ...(details1.activeBuses || [])],
        totalActiveBuses: (details0.activeBuses?.length || 0) + (details1.activeBuses?.length || 0)
      };
    }

    const dir = direction === '1' ? '1' : '0';
    const feed = await this.getSagalesFeed(lineConfig.sagalesRouteId, dir);

    let stops = [];
    let polylineCoords = [];
    let activeBuses = [];

    if (feed && feed.ruta) {
      const rawStops = feed.ruta.stops || [];
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

      if (feed.ruta.shapes) {
        polylineCoords = decodePolyline(feed.ruta.shapes);
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
        const pos = v.postion || {};
        const trip = ent.tripUpdate?.trip || v.trip || {};
        const tripUpdates = ent.tripUpdate?.stopTimeUpdate || [];

        const lat = pos.latitude || 0;
        const lon = pos.longitude || 0;
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
          tripId: trip.tripId || `sagales_${lineConfig.code}_${idx}`,
          lineId: lineConfig.id,
          lineName: lineConfig.code,
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
      });
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

    // If no real-time trips found (or off-peak), generate scheduled departures with exact calculated passing time for this stop
    if (departures.length === 0) {
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
            cumDist += 600;
          }
        }
        travelSec = Math.round((cumDist / 10.0) + (stopIdx * 30));
      }

      const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
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

      baseTimes.forEach((initTimeStr, idx) => {
        const initSec = timeUtils.timeToSec(initTimeStr);
        const passSec = initSec + travelSec;
        const passHour = Math.floor(passSec / 3600) % 24;
        const passMin = Math.floor((passSec % 3600) / 60);
        const passTimeStr = `${String(passHour).padStart(2, '0')}:${String(passMin).padStart(2, '0')}`;

        const depUtc = timeUtils.localTimeToUtcDate(networkTomorrow.year, networkTomorrow.month, networkTomorrow.day, passHour, passMin, 0, this.agencyTimezone);
        const diffMs = depUtc.getTime() - now;
        const diffMin = Math.max(1, Math.round(diffMs / 60000));
        const isFirst = idx === 0;

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
        zone: stopObj.zone || 'Sagalés'
      },
      departures,
      totalDepartures: departures.length
    };
  }
}

module.exports = new SagalesTracker();
