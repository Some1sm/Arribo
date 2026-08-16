const fs = require('fs');
const path = require('path');
const siriClient = require('./mataroSiriClient');
const geoUtils = require('./geoUtils');

class MataroTracker {
  constructor() {
    this.linesData = [];
    this.routesData = {};
    this.allStopsMap = new Map();
    this.vehicleHistory = new Map(); // Vehicle tracking history for dead-zone estimation
    this.loadDatasets();
  }

  loadDatasets() {
    try {
      const lineasPath = path.join(__dirname, '..', 'data', 'mataro_lineas.json');
      const routesPath = path.join(__dirname, '..', 'data', 'mataro_routes_full.json');
      const paradasPath = path.join(__dirname, '..', 'data', 'mataro_paradas.json');

      if (fs.existsSync(lineasPath)) {
        const raw = JSON.parse(fs.readFileSync(lineasPath, 'utf8'));
        this.linesData = raw.message || [];
      }

      if (fs.existsSync(routesPath)) {
        this.routesData = JSON.parse(fs.readFileSync(routesPath, 'utf8'));
      }

      if (fs.existsSync(paradasPath)) {
        const raw = JSON.parse(fs.readFileSync(paradasPath, 'utf8'));
        const pList = raw.message || [];
        pList.forEach(p => {
          this.allStopsMap.set(String(p.id), {
            id: String(p.id),
            name: p.name.replace(/ - \d+$/, ''),
            lat: p.latitude,
            lon: p.longitude,
            lineas: p.lineas || []
          });
        });
      }

      console.log(`[MataroTracker] Loaded ${this.linesData.length} lines, ${this.allStopsMap.size} stops.`);
    } catch (e) {
      console.error('[MataroTracker] Error loading datasets:', e.message);
    }
  }

  // 1. Get all Mataro urban lines
  getLines() {
    return this.linesData.map(l => {
      const routes = this.routesData[l.id] || [];
      return {
        id: l.id,
        code: `L${l.id}`,
        name: l.name.trim(),
        color: l.color || '#009485',
        agency: 'Mataró Bus (Avanza)',
        directions: routes.map((r, idx) => ({
          dirId: String(idx),
          routeId: r.id,
          name: r.name,
          stopsCount: r.stops ? r.stops.length : 0
        }))
      };
    });
  }

  // 2. Get full details for a line & direction (stops, route polyline, and live/estimated buses)
  async getLineDetails(lineId, direction = '0') {
    const lId = String(lineId);
    const lineInfo = this.linesData.find(l => String(l.id) === lId) || { id: lId, name: `Línia ${lId}`, color: '#009485' };
    const routes = this.routesData[lId] || [];
    
    // Choose route by index or ID
    const dirIdx = parseInt(direction, 10) || 0;
    const selectedRoute = routes[dirIdx] || routes[0] || { coords: [], stops: [] };

    // Format polyline
    const polyline = (selectedRoute.coords || []).map(c => [
      parseFloat(c.Latitude),
      parseFloat(c.Longitude)
    ]);

    // Format stops
    const stops = (selectedRoute.stops || []).map((s, idx) => {
      const globalStop = this.allStopsMap.get(String(s.id)) || {};
      const cleanName = s.name.replace(/ - \d+$/, '');
      return {
        id: String(s.id),
        seq: idx + 1,
        name: cleanName,
        lat: s.latitude || globalStop.lat,
        lon: s.longitude || globalStop.lon,
        code: String(s.id),
        zone: 'Mataró Urbà',
        color: lineInfo.color
      };
    });

    // Fetch Live Buses via SIRI
    const liveVehicles = await siriClient.getLiveVehicles(lId);

    // Apply Dead-Zone Location Estimation
    const processedBuses = this.processBusesWithDeadReckoning(liveVehicles, selectedRoute, stops);

    return {
      lineId: lId,
      code: `L${lId}`,
      name: lineInfo.name.trim(),
      color: lineInfo.color,
      direction: String(dirIdx),
      directionName: selectedRoute.name || `${lineInfo.name}`,
      totalStops: stops.length,
      stops,
      polyline,
      activeBuses: processedBuses,
      totalActiveBuses: processedBuses.length
    };
  }

  // Dead-Zone Position Estimation (Dead-Reckoning along Polyline)
  processBusesWithDeadReckoning(liveBuses, route, stops) {
    const now = Date.now();
    const result = [];
    const polyCoords = (route.coords || []).map(c => ({ lat: parseFloat(c.Latitude), lon: parseFloat(c.Longitude) }));

    // 1. Process active live buses
    liveBuses.forEach(b => {
      // Record to vehicle history
      this.vehicleHistory.set(b.vehicleId, {
        vehicleId: b.vehicleId,
        lineId: b.lineId,
        lat: b.lat,
        lon: b.lon,
        bearing: b.bearing,
        speedKmh: b.speedKmh,
        delayMins: b.delayMins,
        lastSeen: now,
        directionName: b.directionName,
        origin: b.origin,
        destination: b.destination
      });

      // Calculate progress and segment along stops
      const segInfo = this.findNearestSegment(b.lat, b.lon, stops, polyCoords);

      result.push({
        tripId: `mataro_${b.vehicleId}`,
        vehicleId: b.vehicleId,
        lineId: b.lineId,
        lat: b.lat,
        lon: b.lon,
        bearing: b.bearing,
        compass: geoUtils.bearingToCompassName(b.bearing),
        speedKmh: b.speedKmh,
        delayMins: b.delayMins,
        delayFormatted: b.delayFormatted,
        isEstimated: false,
        statusText: '🟢 Senyal GPS Actiu',
        fromStop: segInfo.fromStop,
        toStop: segInfo.toStop,
        fromSeq: segInfo.fromSeq,
        toSeq: segInfo.toSeq,
        totalProgress: segInfo.totalProgress,
        coordinatesFormatted: `${b.lat.toFixed(5)}° N, ${b.lon.toFixed(5)}° E`,
        secondsToNextStop: segInfo.secondsToNextStop,
        distanceToNextMeters: segInfo.distanceToNextMeters,
        fromCoords: segInfo.fromCoords,
        toCoords: segInfo.toCoords,
        segStartSec: Math.floor(now / 1000) - 10,
        segEndSec: Math.floor(now / 1000) + Math.max(15, segInfo.secondsToNextStop),
        isTerminalLayover: b.speedKmh === 0 && (segInfo.totalProgress > 95 || segInfo.totalProgress < 5)
      });
    });

    // 2. Dead-Reckoning: Check if any recently tracked vehicles lost signal in dead zones
    for (const [vId, hist] of this.vehicleHistory.entries()) {
      if (String(hist.lineId) !== String(route.id_linea)) continue;
      const elapsedSec = (now - hist.lastSeen) / 1000;

      // If missing between 15s and 180s, extrapolate position along polyline
      const isCurrentlyActive = liveBuses.some(b => b.vehicleId === vId);
      if (!isCurrentlyActive && elapsedSec >= 12 && elapsedSec <= 180) {
        const estPos = this.extrapolatePolylinePosition(hist, elapsedSec, polyCoords);
        if (estPos) {
          const segInfo = this.findNearestSegment(estPos.lat, estPos.lon, stops, polyCoords);

          result.push({
            tripId: `mataro_${vId}`,
            vehicleId: vId,
            lineId: hist.lineId,
            lat: estPos.lat,
            lon: estPos.lon,
            bearing: estPos.bearing,
            compass: geoUtils.bearingToCompassName(estPos.bearing),
            speedKmh: Math.max(15, Math.min(45, hist.speedKmh || 30)),
            delayMins: hist.delayMins,
            delayFormatted: hist.delayMins > 0 ? `+${hist.delayMins} min retard` : 'Puntual',
            isEstimated: true,
            statusText: `⚡ Estimació Zona Cobertura (${Math.round(elapsedSec)}s sense GPS)`,
            fromStop: segInfo.fromStop,
            toStop: segInfo.toStop,
            fromSeq: segInfo.fromSeq,
            toSeq: segInfo.toSeq,
            totalProgress: segInfo.totalProgress,
            coordinatesFormatted: `${estPos.lat.toFixed(5)}° N, ${estPos.lon.toFixed(5)}° E (Est.)`,
            secondsToNextStop: Math.max(10, segInfo.secondsToNextStop),
            distanceToNextMeters: segInfo.distanceToNextMeters,
            fromCoords: segInfo.fromCoords,
            toCoords: segInfo.toCoords,
            segStartSec: Math.floor(now / 1000) - 10,
            segEndSec: Math.floor(now / 1000) + Math.max(15, segInfo.secondsToNextStop),
            isTerminalLayover: false
          });
        }
      }
    }

    return result;
  }

  // Find nearest stop segment and progress
  findNearestSegment(lat, lon, stops, polyCoords) {
    if (!stops || stops.length === 0) {
      return { fromStop: 'Mataró', toStop: 'Destí', fromSeq: 1, toSeq: 1, totalProgress: 50, secondsToNextStop: 60, distanceToNextMeters: 300 };
    }

    let minIdx = 0;
    let minDist = Infinity;

    for (let i = 0; i < stops.length; i++) {
      const d = geoUtils.calculateDistanceMeters(lat, lon, stops[i].lat, stops[i].lon);
      if (d < minDist) {
        minDist = d;
        minIdx = i;
      }
    }

    const fromIdx = Math.max(0, Math.min(stops.length - 2, minIdx));
    const toIdx = Math.min(stops.length - 1, fromIdx + 1);
    const s1 = stops[fromIdx];
    const s2 = stops[toIdx];

    const distToNext = Math.round(geoUtils.calculateDistanceMeters(lat, lon, s2.lat, s2.lon));
    const totalProgress = Math.round((toIdx / Math.max(1, stops.length - 1)) * 100);
    const secondsToNext = Math.max(15, Math.round((distToNext / 30) * 3.6));

    return {
      fromStop: s1.name,
      toStop: s2.name,
      fromSeq: s1.seq,
      toSeq: s2.seq,
      totalProgress,
      distanceToNextMeters: distToNext,
      secondsToNextStop: secondsToNext,
      fromCoords: { lat: s1.lat, lon: s1.lon },
      toCoords: { lat: s2.lat, lon: s2.lon }
    };
  }

  // Extrapolate position along polyline for dead reckoning
  extrapolatePolylinePosition(hist, elapsedSec, polyCoords) {
    if (!polyCoords || polyCoords.length < 2) return null;

    // Find closest vertex on polyline
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < polyCoords.length; i++) {
      const d = geoUtils.calculateDistanceMeters(hist.lat, hist.lon, polyCoords[i].lat, polyCoords[i].lon);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }

    // Advance along polyline by (speed * time)
    const speedMps = Math.max(5, (hist.speedKmh || 30) / 3.6);
    const advanceMeters = speedMps * elapsedSec;

    let accumulated = 0;
    let currIdx = bestIdx;

    while (currIdx < polyCoords.length - 1 && accumulated < advanceMeters) {
      const p1 = polyCoords[currIdx];
      const p2 = polyCoords[currIdx + 1];
      const segD = geoUtils.calculateDistanceMeters(p1.lat, p1.lon, p2.lat, p2.lon);
      if (accumulated + segD >= advanceMeters) {
        const frac = (advanceMeters - accumulated) / Math.max(1, segD);
        const lat = p1.lat + frac * (p2.lat - p1.lat);
        const lon = p1.lon + frac * (p2.lon - p1.lon);
        const bearing = geoUtils.calculateBearing(p1.lat, p1.lon, p2.lat, p2.lon);
        return { lat: Math.round(lat * 1000000) / 1000000, lon: Math.round(lon * 1000000) / 1000000, bearing };
      }
      accumulated += segD;
      currIdx++;
    }

    const last = polyCoords[Math.min(polyCoords.length - 1, currIdx)];
    return { lat: last.lat, lon: last.lon, bearing: hist.bearing || 0 };
  }

  // 3. Get Real-Time Departures for a stop
  async getStopDepartures(stopId, lineId = '') {
    const sId = String(stopId);
    const stopInfo = this.allStopsMap.get(sId) || { id: sId, name: `Parada ${sId}` };
    const liveArrivals = await siriClient.getStopArrivals(sId, lineId);

    return {
      stop: {
        id: sId,
        name: stopInfo.name,
        lat: stopInfo.lat,
        lon: stopInfo.lon,
        zone: 'Mataró Urbà'
      },
      departures: liveArrivals,
      totalDepartures: liveArrivals.length
    };
  }

  // 4. Get Target Stop ETA
  async getTargetStopETA(lineId, stopId = null, direction = '0') {
    const lId = String(lineId);
    const lineInfo = this.linesData.find(l => String(l.id) === lId) || { id: lId, name: `Línia ${lId}`, color: '#009485' };
    const routes = this.routesData[lId] || [];
    const dirIdx = parseInt(direction, 10) || 0;
    const selectedRoute = routes[dirIdx] || routes[0] || { stops: [] };

    const routeStops = selectedRoute.stops || [];
    let chosenStop = null;

    if (stopId) {
      chosenStop = routeStops.find(s => String(s.id) === String(stopId)) || this.allStopsMap.get(String(stopId));
    }

    if (!chosenStop && routeStops.length > 0) {
      // Default to middle or major stop
      chosenStop = routeStops[Math.floor(routeStops.length / 2)] || routeStops[0];
    }

    if (!chosenStop) {
      return { targetStop: null, nextBus: null, upcomingDepartures: [] };
    }

    const sId = String(chosenStop.id);
    const stopDepartures = await this.getStopDepartures(sId, lId);
    const deps = stopDepartures.departures || [];
    const nextBus = deps.length > 0 ? deps[0] : null;

    return {
      line: {
        id: lId,
        code: `L${lId}`,
        name: lineInfo.name.trim(),
        color: lineInfo.color
      },
      targetStop: {
        id: sId,
        mouteStopId: sId,
        name: chosenStop.name.replace(/ - \d+$/, ''),
        lat: chosenStop.latitude || chosenStop.lat,
        lon: chosenStop.longitude || chosenStop.lon,
        zone: 'Mataró Urbà',
        seq: routeStops.findIndex(s => String(s.id) === sId) + 1
      },
      direction: String(dirIdx),
      directionName: selectedRoute.name || lineInfo.name,
      nextBus,
      upcomingDepartures: deps
    };
  }
}

module.exports = new MataroTracker();
