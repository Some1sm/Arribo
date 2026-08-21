const fs = require('fs');
const path = require('path');
const siriClient = require('./mataroSiriClient');
const geoEngine = require('./core/geo/geoEngine');
const timeEngine = require('./core/time/timeEngine');
const calendarEngine = require('./core/time/calendarEngine');
const scheduleSynthesizer = require('./core/schedule/scheduleSynthesizer');
const delayEngine = require('./core/schedule/delayEngine');
const geoUtils = require('./geoUtils');
const timeUtils = require('./timeUtils');

const MATARO_LINE_SCHEDULES = {
  '1': {
    weekday: { inicio: '06:30', fin: '22:15', headwayMins: 15 },
    saturday: { inicio: '07:15', fin: '22:15', headwayMins: 20 },
    sunday: { inicio: '08:15', fin: '22:00', headwayMins: 30 }
  },
  '2': {
    weekday: { inicio: '06:30', fin: '22:15', headwayMins: 15 },
    saturday: { inicio: '07:15', fin: '22:15', headwayMins: 20 },
    sunday: { inicio: '07:55', fin: '22:00', headwayMins: 30 }
  },
  '3': {
    weekday: { inicio: '06:30', fin: '22:15', headwayMins: 15 },
    saturday: { inicio: '07:15', fin: '22:15', headwayMins: 20 },
    sunday: { inicio: '08:00', fin: '22:15', headwayMins: 30 }
  },
  '4': {
    weekday: { inicio: '06:30', fin: '22:00', headwayMins: 18 },
    saturday: { inicio: '07:15', fin: '22:00', headwayMins: 20 },
    sunday: { inicio: '08:30', fin: '21:57', headwayMins: 30 }
  },
  '5': {
    weekday: { inicio: '06:40', fin: '21:40', headwayMins: 20 },
    saturday: { inicio: '07:30', fin: '21:30', headwayMins: 30 },
    sunday: { inicio: '08:32', fin: '21:22', headwayMins: 30 }
  },
  '6': {
    weekday: { inicio: '06:45', fin: '22:15', headwayMins: 20 },
    saturday: { inicio: '07:30', fin: '22:15', headwayMins: 30 },
    sunday: { inicio: '14:00', fin: '22:17', headwayMins: 30, afternoonOnly: true }
  },
  '7': {
    weekday: { inicio: '06:30', fin: '22:00', headwayMins: 20 },
    saturday: { inicio: '07:30', fin: '22:00', headwayMins: 30 },
    sunday: { inicio: '08:30', fin: '21:27', headwayMins: 30 }
  },
  '8': {
    weekday: { inicio: '06:45', fin: '21:45', headwayMins: 25 },
    saturday: { inicio: '14:04', fin: '21:35', headwayMins: 30, afternoonOnly: true },
    sunday: { inicio: '14:04', fin: '21:35', headwayMins: 30, afternoonOnly: true }
  }
};

class MataroTracker {
  constructor() {
    this.agencyTimezone = 'Europe/Madrid';
    this.linesData = [];
    this.routesData = {};
    this.allStopsMap = new Map();
    this.vehicleHistory = new Map(); // Vehicle tracking history for dead-zone estimation
    this.loadDatasets();
  }

  // Get authoritative schedule parameters for a line, route direction and day type
  getScheduleForLine(lIdStr, routeId = null, dayType = 'weekday') {
    const lId = String(lIdStr || '1');
    if (lId === '8') {
      if (dayType === 'saturday' || dayType === 'sunday') {
        const isRoute11 = String(routeId) === '11';
        return {
          inicio: isRoute11 ? '14:45' : '14:04',
          fin: isRoute11 ? '21:13' : '21:35',
          headwayMins: 30,
          afternoonOnly: true
        };
      }
      return { inicio: '06:45', fin: '21:45', headwayMins: 25 };
    }

    if (lId === '6') {
      if (dayType === 'sunday') {
        const isRoute12 = String(routeId) === '12';
        return {
          inicio: isRoute12 ? '14:17' : '14:00',
          fin: isRoute12 ? '22:17' : '22:03',
          headwayMins: 30,
          afternoonOnly: true
        };
      }
      if (dayType === 'saturday') {
        return { inicio: '07:30', fin: '22:15', headwayMins: 30 };
      }
      return { inicio: '06:45', fin: '22:15', headwayMins: 20 };
    }

    return MATARO_LINE_SCHEDULES[lId]?.[dayType] || {
      inicio: '06:30',
      fin: '22:00',
      headwayMins: 20
    };
  }

  loadDatasets() {
    try {
      const getFilePath = (fileName) => {
        const pCity = path.join(__dirname, '..', 'data', 'cities', 'mataro', fileName);
        if (fs.existsSync(pCity)) return pCity;
        const p1 = path.join(__dirname, '..', 'data', fileName);
        if (fs.existsSync(p1)) return p1;
        return pCity;
      };

      const lineasPath = getFilePath('mataro_lineas.json');
      const routesPath = getFilePath('mataro_routes_full.json');
      const paradasPath = getFilePath('mataro_paradas.json');

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

  // 1. Get all Mataro urban lines (L1..L8)
  getLines() {
    return this.linesData.map(l => {
      const routes = this.routesData[l.id] || [];
      return {
        id: l.id,
        code: String(l.id),
        name: l.name.trim(),
        color: l.color || '#009485',
        agency: 'Mataró Bus',
        group: 'mataro',
        mode: 'Urbà Mataró',
        directions: routes.map((r, idx) => ({
          dirId: String(idx),
          routeId: r.id,
          name: r.name,
          stopsCount: r.stops ? r.stops.length : 0
        }))
      };
    });
  }

  resolveLineConfig(lineId) {
    const cleanId = String(lineId).toLowerCase().replace(/^mataro_?/, '').replace(/^line-?/, '').replace(/^linia-?/, '').replace(/^l(?=[1-8]$)/, '').trim();
    return this.linesData.find(l => String(l.id).toLowerCase() === cleanId) || null;
  }

  // Deterministically match a SIRI live vehicle to route index (0 = Anada, 1 = Tornada)
  matchVehicleToRouteIndex(vehicle, routes) {
    if (!routes || routes.length <= 1) return 0;
    
    const cleanDir = (vehicle.directionName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanDest = (vehicle.destination || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    // 1. Exact string match against route name (e.g. "hospitalrodalies")
    for (let i = 0; i < routes.length; i++) {
      const cleanR = (routes[i].name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (cleanDir && cleanR && cleanDir === cleanR) return i;
    }

    // 2. Match route destination part (e.g. route "Hospital - Rodalies" has destination "Rodalies")
    for (let i = 0; i < routes.length; i++) {
      const parts = (routes[i].name || '').split('-');
      const destPart = (parts[1] || parts[0] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (cleanDest && destPart && (destPart.includes(cleanDest) || cleanDest.includes(destPart))) {
        return i;
      }
    }

    // 3. Substring match
    for (let i = 0; i < routes.length; i++) {
      const cleanR = (routes[i].name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      if (cleanDir && cleanR && (cleanDir.includes(cleanR) || cleanR.includes(cleanDir))) return i;
    }

    return 0;
  }

  // 2. Get full details for a line & direction (stops, route polyline, and live/estimated buses)
  async getLineDetails(lineId, direction = '0') {
    const lId = String(lineId);
    const lineInfo = this.linesData.find(l => String(l.id) === lId) || { id: lId, name: `Línia ${lId}`, color: '#009485' };
    const routes = this.routesData[lId] || [];
    const isBoth = direction === 'both';
    
    // Choose route by index or ID
    const dirIdx = isBoth ? 0 : (parseInt(direction, 10) || 0);
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

    // All Directions data for showing both directions on map
    const allDirections = routes.map((r, idx) => ({
      dirId: String(idx),
      name: r.name,
      polyline: (r.coords || []).map(c => [parseFloat(c.Latitude), parseFloat(c.Longitude)]),
      stops: (r.stops || []).map((s, sIdx) => {
        const globalStop = this.allStopsMap.get(String(s.id)) || {};
        return {
          id: String(s.id),
          seq: sIdx + 1,
          name: s.name.replace(/ - \d+$/, ''),
          lat: s.latitude || globalStop.lat,
          lon: s.longitude || globalStop.lon,
          code: String(s.id),
          zone: 'Mataró Urbà',
          color: lineInfo.color
        };
      })
    }));

    // Fetch Live Buses via SIRI
    const liveVehicles = await siriClient.getLiveVehicles(lId);

    // Apply Deterministic Direction Matching & Road-Snapping
    let processedBuses = [];
    if (isBoth && routes.length > 1) {
      const vehs0 = liveVehicles.filter(v => this.matchVehicleToRouteIndex(v, routes) === 0);
      const vehs1 = liveVehicles.filter(v => this.matchVehicleToRouteIndex(v, routes) === 1);

      const buses0 = this.processBusesWithDeadReckoning(vehs0, routes[0], allDirections[0].stops, '0', liveVehicles);
      const buses1 = this.processBusesWithDeadReckoning(vehs1, routes[1], allDirections[1].stops, '1', liveVehicles);

      processedBuses = [...buses0, ...buses1];
    } else {
      const vehsForDir = routes.length > 1
        ? liveVehicles.filter(v => this.matchVehicleToRouteIndex(v, routes) === dirIdx)
        : liveVehicles;

      processedBuses = this.processBusesWithDeadReckoning(vehsForDir, selectedRoute, stops, String(dirIdx), liveVehicles);
    }

    // Strict deduplication by vehicleId (Live GPS strictly takes precedence over estimated dead-reckoning)
    const uniqueBusesMap = new Map();
    processedBuses.forEach(b => {
      const vId = String(b.vehicleId || b.tripId);
      if (!uniqueBusesMap.has(vId)) {
        uniqueBusesMap.set(vId, b);
      } else {
        const existing = uniqueBusesMap.get(vId);
        if (existing.isEstimated && !b.isEstimated) {
          uniqueBusesMap.set(vId, b);
        }
      }
    });
    processedBuses = Array.from(uniqueBusesMap.values());

    return {
      lineId: lId,
      code: String(lId),
      name: lineInfo.name.trim(),
      color: lineInfo.color,
      direction: isBoth ? 'both' : String(dirIdx),
      directionName: isBoth ? 'Ambdós sentits' : (selectedRoute.name || `${lineInfo.name}`),
      totalStops: stops.length,
      stops,
      coords: polyline,
      polyline,
      secondaryCoords: (isBoth && allDirections.length > 1) ? allDirections[1].polyline : null,
      secondaryStops: (isBoth && allDirections.length > 1) ? allDirections[1].stops : null,
      secondaryColor: '#38bdf8',
      allDirections,
      activeBuses: processedBuses,
      totalActiveBuses: processedBuses.length,
      totalVehiclesInCircuit: processedBuses.length
    };
  }

  // Snap a lat/lon point strictly to the closest street segment on polyline
  snapPointToPolyline(lat, lon, polyCoords) {
    return geoEngine.snapPointToPolyline(lat, lon, polyCoords);
  }

  // Dead-Zone Position Estimation (Dead-Reckoning along Polyline)
  processBusesWithDeadReckoning(liveBuses, route, stops, dirId = '0', allLineLiveVehicles = liveBuses) {
    const now = Date.now();
    const result = [];
    const polyCoords = (route.coords || []).map(c => ({ lat: parseFloat(c.Latitude), lon: parseFloat(c.Longitude) }));

    // 1. Process active live buses
    liveBuses.forEach(b => {
      // Snap raw GPS strictly to road polyline
      const snapped = this.snapPointToPolyline(b.lat, b.lon, polyCoords);
      const roadLat = Math.round(snapped.lat * 1000000) / 1000000;
      const roadLon = Math.round(snapped.lon * 1000000) / 1000000;
      const roadBearing = snapped.bearing || b.bearing || 0;

      // Record to vehicle history
      this.vehicleHistory.set(String(b.vehicleId), {
        vehicleId: b.vehicleId,
        lineId: b.lineId,
        direction: dirId,
        lat: roadLat,
        lon: roadLon,
        bearing: roadBearing,
        speedKmh: b.speedKmh,
        delayMins: b.delayMins,
        lastSeen: now,
        directionName: b.directionName,
        origin: b.origin,
        destination: b.destination
      });

      // Calculate progress and segment along stops
      const segInfo = this.findNearestSegment(roadLat, roadLon, stops, polyCoords);

      result.push({
        tripId: `mataro_${b.vehicleId}`,
        vehicleId: b.vehicleId,
        lineId: b.lineId,
        direction: dirId,
        _snapDist: snapped.dist,
        lat: roadLat,
        lon: roadLon,
        bearing: roadBearing,
        compass: geoUtils.bearingToCompassName(roadBearing),
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
        coordinatesFormatted: `${roadLat.toFixed(5)}° N, ${roadLon.toFixed(5)}° E`,
        secondsToNextStop: segInfo.secondsToNextStop,
        distanceToNextMeters: segInfo.distanceToNextMeters,
        fromCoords: { lat: roadLat, lon: roadLon },
        toCoords: segInfo.toCoords,
        segStartSec: Math.floor(now / 1000) - 10,
        segEndSec: Math.floor(now / 1000) + Math.max(15, segInfo.secondsToNextStop),
        isTerminalLayover: b.speedKmh === 0 && (segInfo.totalProgress > 95 || segInfo.totalProgress < 5)
      });
    });

    // 2. Dead-Reckoning: Check if any recently tracked vehicles lost signal in dead zones
    for (const [vId, hist] of this.vehicleHistory.entries()) {
      if (String(hist.lineId) !== String(route.id_linea)) continue;
      if (String(hist.direction) !== String(dirId)) continue; // Only dead-reckon on the matching direction
      const elapsedSec = (now - hist.lastSeen) / 1000;

      // If vehicle is live on ANY direction of this line, do not dead-reckon it
      const isCurrentlyActive = (allLineLiveVehicles || liveBuses).some(b => String(b.vehicleId) === String(vId));
      if (!isCurrentlyActive && elapsedSec >= 15 && elapsedSec <= 120) {
        const estPos = this.extrapolatePolylinePosition(hist, elapsedSec, polyCoords);
        if (estPos) {
          const segInfo = this.findNearestSegment(estPos.lat, estPos.lon, stops, polyCoords);

          result.push({
            tripId: `mataro_${vId}`,
            vehicleId: vId,
            lineId: hist.lineId,
            direction: dirId,
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
    return geoEngine.extrapolatePolylinePosition(hist, elapsedSec, hist.speedKmh || 30, polyCoords);
  }

  // Calculate distance in meters along polyline between two coordinates
  calculatePolylineDistanceBetween(polyCoords, lat1, lon1, lat2, lon2) {
    return geoEngine.calculatePolylineDistanceBetween(polyCoords, lat1, lon1, lat2, lon2);
  }

  // Calculate total distance of a route polyline
  calculateRouteTotalDistance(polyCoords) {
    return geoEngine.calculateRouteTotalDistance(polyCoords);
  }

  // Estimate arrival ETA to stopId from active live vehicles along the route circuit
  async estimateArrivalsForStop(stopId, lineId = '', existingArrivals = []) {
    const sId = String(stopId);
    const existingVehicleIds = new Set(existingArrivals.map(a => a.vehicleId).filter(Boolean));
    const estimatedArrivals = [];

    // Determine relevant lines serving this stop
    let targetLineIds = [];
    if (lineId) {
      targetLineIds = [String(lineId)];
    } else {
      const stopInfo = this.allStopsMap.get(sId);
      if (stopInfo && stopInfo.lineas && stopInfo.lineas.length > 0) {
        targetLineIds = stopInfo.lineas.map(l => String(l.id));
      }
    }

    if (targetLineIds.length === 0) {
      targetLineIds = this.linesData.map(l => String(l.id));
    }

    const now = Date.now();

    for (const lId of targetLineIds) {
      const routes = this.routesData[lId] || [];
      if (routes.length === 0) continue;

      let liveVehicles = [];
      try {
        liveVehicles = await siriClient.getLiveVehicles(lId);
      } catch (e) {
        continue;
      }
      if (liveVehicles.length === 0) continue;

      const lineInfo = this.linesData.find(l => String(l.id) === lId) || { name: `Línia ${lId}` };

      // Find which routes contain this stop
      routes.forEach((route, routeIdx) => {
        const routeStops = route.stops || [];
        const targetStopIdx = routeStops.findIndex(s => String(s.id) === sId);
        if (targetStopIdx === -1) return; // This route direction does not visit this stop

        const targetStopObj = routeStops[targetStopIdx];
        const routePolyCoords = (route.coords || []).map(c => ({ lat: parseFloat(c.Latitude), lon: parseFloat(c.Longitude) }));

        // Check each live vehicle on the line
        liveVehicles.forEach(veh => {
          if (existingVehicleIds.has(veh.vehicleId)) return; // Already reported by SIRI

          const vehRouteIdx = this.matchVehicleToRouteIndex(veh, routes);
          const isSameDirection = (vehRouteIdx === routeIdx);

          let totalTravelSec = 0;
          let isUpstreamDirect = false;

          if (isSameDirection) {
            // Vehicle is on the same route direction
            const snapped = this.snapPointToPolyline(veh.lat, veh.lon, routePolyCoords);
            const vehNearestStop = this.findNearestSegment(snapped.lat, snapped.lon, routeStops, routePolyCoords);
            const vehStopIdx = Math.max(0, (vehNearestStop.fromSeq || 1) - 1);
            isUpstreamDirect = (vehStopIdx <= targetStopIdx);

            if (vehStopIdx <= targetStopIdx) {
              // Upstream: vehicle is approaching this stop directly on this run
              const remainingStops = targetStopIdx - vehStopIdx;
              const remainingMeters = this.calculatePolylineDistanceBetween(routePolyCoords, snapped.lat, snapped.lon, targetStopObj.latitude || veh.lat, targetStopObj.longitude || veh.lon);
              const speedMps = Math.max(4.5, (veh.speedKmh || 22) / 3.6);
              totalTravelSec = Math.round(remainingMeters / speedMps) + (remainingStops * 25);
            } else {
              // Downstream on loop: vehicle passed this stop, will loop through other direction & come back
              const otherRoute = routes[1 - routeIdx] || routes[0];
              const remainingOnCurrent = this.calculatePolylineDistanceBetween(routePolyCoords, snapped.lat, snapped.lon, routeStops[routeStops.length - 1]?.latitude || veh.lat, routeStops[routeStops.length - 1]?.longitude || veh.lon);
              const otherDist = this.calculateRouteTotalDistance((otherRoute.coords || []).map(c => ({ lat: parseFloat(c.Latitude), lon: parseFloat(c.Longitude) })));
              const nextRunDist = this.calculatePolylineDistanceBetween(routePolyCoords, routeStops[0]?.latitude || veh.lat, routeStops[0]?.longitude || veh.lon, targetStopObj.latitude || veh.lat, targetStopObj.longitude || veh.lon);

              const totalMeters = remainingOnCurrent + otherDist + nextRunDist;
              const speedMps = 20 / 3.6;
              totalTravelSec = Math.round(totalMeters / speedMps) + (routeStops.length * 25) + 300; // 5 min layover
            }
          } else {
            // Vehicle is on opposite direction
            const oppRoute = routes[vehRouteIdx] || routes[0];
            const oppPolyCoords = (oppRoute.coords || []).map(c => ({ lat: parseFloat(c.Latitude), lon: parseFloat(c.Longitude) }));
            const oppStops = oppRoute.stops || [];
            const snapped = this.snapPointToPolyline(veh.lat, veh.lon, oppPolyCoords);
            const oppRemainingMeters = this.calculatePolylineDistanceBetween(oppPolyCoords, snapped.lat, snapped.lon, oppStops[oppStops.length - 1]?.latitude || veh.lat, oppStops[oppStops.length - 1]?.longitude || veh.lon);
            const runDist = this.calculatePolylineDistanceBetween(routePolyCoords, routeStops[0]?.latitude || targetStopObj.latitude, routeStops[0]?.longitude || targetStopObj.longitude, targetStopObj.latitude, targetStopObj.longitude);

            const totalMeters = oppRemainingMeters + runDist;
            const speedMps = 20 / 3.6;
            totalTravelSec = Math.round(totalMeters / speedMps) + (targetStopIdx * 25) + 240; // 4 min layover
          }

          const minutesAway = Math.max(1, Math.round(totalTravelSec / 60));

          // Include within the extended 120-minute window
          if (minutesAway >= 1 && minutesAway <= 120) {
            const arrDate = new Date(now + minutesAway * 60000);
            const formattedTime = timeUtils.formatTimeToTimezone(arrDate, this.agencyTimezone);

            estimatedArrivals.push({
              lineId: lId,
              lineName: lineInfo.name,
              directionName: route.name,
              destination: route.name,
              vehicleId: veh.vehicleId,
              distanceFromStop: `${Math.round(totalTravelSec * 5.5)}m`,
              departureTime: formattedTime,
              expectedIso: arrDate.toISOString(),
              aimedIso: arrDate.toISOString(),
              minutesAway,
              formattedStatus: `${minutesAway} min`,
              delayMins: veh.delayMins || 0,
              delayBadgeText: isUpstreamDirect ? `⚡ En ruta (Bus #${veh.vehicleId})` : `⚡ Circuit complet (Bus #${veh.vehicleId})`,
              delayStatus: 'estimated',
              isRealTime: false,
              isEstimated: true,
              isUpstreamDirect,
              busCoords: { lat: veh.lat, lon: veh.lon }
            });

            existingVehicleIds.add(veh.vehicleId);
          }
        });
      });
    }

    return estimatedArrivals;
  }

  findRoutesServingStop(stopId, lineId = '') {
    const sId = String(stopId);
    const results = [];

    const linesToCheck = lineId ? [String(lineId)] : Object.keys(this.routesData);
    for (const lId of linesToCheck) {
      const routes = this.routesData[lId] || [];
      const lineInfo = this.linesData.find(l => String(l.id) === lId) || { id: lId, name: `Línia ${lId}` };
      for (const r of routes) {
        if ((r.stops || []).some(s => String(s.id) === sId)) {
          results.push({
            ...r,
            id_linea: lId,
            lineName: lineInfo.name.trim()
          });
        }
      }
    }

    if (results.length === 0 && lineId && this.routesData[lineId]) {
      const lineInfo = this.linesData.find(l => String(l.id) === String(lineId)) || { id: lineId, name: `Línia ${lineId}` };
      const defaultRoute = this.routesData[lineId][0];
      if (defaultRoute) {
        results.push({
          ...defaultRoute,
          id_linea: String(lineId),
          lineName: lineInfo.name.trim()
        });
      }
    }

    return results;
  }

  // 3. Get Real-Time & Estimated Departures for a stop (up to 120 mins)
  async getStopDepartures(stopId, lineId = '') {
    const sId = String(stopId);
    const stopInfo = this.allStopsMap.get(sId) || { id: sId, name: `Parada ${sId}` };
    
    // 1. Query Official Real-Time SIRI Departures
    let liveArrivals = [];
    try {
      liveArrivals = await siriClient.getStopArrivals(sId, lineId);
    } catch (e) {
      console.warn(`[getStopDepartures] SIRI query error for stop ${sId}:`, e.message);
    }

    // 2. Query Circuit Position Estimations for Active Vehicles
    let estimatedArrivals = [];
    try {
      estimatedArrivals = await this.estimateArrivalsForStop(sId, lineId, liveArrivals);
    } catch (e) {
      console.warn(`[getStopDepartures] Circuit estimation error for stop ${sId}:`, e.message);
    }

    // 3. Combine and deduplicate
    const combined = [...liveArrivals, ...estimatedArrivals];
    
    // Filter to 120-minute window and sort chronologically, ignoring invalid/malformed times
    const sorted = combined
      .filter(d => {
        if (d.minutesAway === undefined || d.minutesAway === null || d.minutesAway > 120) return false;
        if (!d.departureTime || d.departureTime === '--:--') return false;
        if (d.isRealTime && d.departureTime === '00:00' && d.minutesAway === 0) {
          if (!d.expectedIso || d.expectedIso.startsWith('0001-') || d.expectedIso.startsWith('1970-')) return false;
        }
        return true;
      })
      .sort((a, b) => a.minutesAway - b.minutesAway);

    const cleanStopName = (stopInfo.name || '').toLowerCase().trim();
    const filteredDepartures = [];

    for (const dep of sorted) {
      const vId = dep.vehicleId ? String(dep.vehicleId).trim() : null;
      const destName = (dep.destination || '').toLowerCase().trim();
      const isTerminatingHere = destName && (destName === cleanStopName || cleanStopName.startsWith(destName));

      // 1. Same vehicleId deduplication within 7 minutes (e.g. terminal arrival + departure turnaround)
      if (vId) {
        const existingIdx = filteredDepartures.findIndex(x => 
          x.vehicleId && String(x.vehicleId).trim() === vId && Math.abs(x.minutesAway - dep.minutesAway) <= 7
        );

        if (existingIdx !== -1) {
          const existing = filteredDepartures[existingIdx];
          const existingDest = (existing.destination || '').toLowerCase().trim();
          const existingTerminating = existingDest && (existingDest === cleanStopName || cleanStopName.startsWith(existingDest));

          // Prefer the outbound departure (going to the next destination) over the terminating arrival
          if (existingTerminating && !isTerminatingHere) {
            filteredDepartures[existingIdx] = dep;
          } else if (existing.isEstimated && dep.isRealTime) {
            filteredDepartures[existingIdx] = dep;
          }
          continue;
        }
      }

      // 2. Duplicate line + destination within 3 minutes (prefer real-time over estimated)
      const closeMatchIdx = filteredDepartures.findIndex(x =>
        String(x.lineId) === String(dep.lineId) &&
        (x.destination || '').toLowerCase().trim() === destName &&
        Math.abs(x.minutesAway - dep.minutesAway) <= 3
      );

      if (closeMatchIdx !== -1) {
        const match = filteredDepartures[closeMatchIdx];
        if (match.isEstimated && dep.isRealTime) {
          filteredDepartures[closeMatchIdx] = dep;
        }
        continue;
      }

      filteredDepartures.push(dep);
    }

    let finalDepartures = filteredDepartures;

    finalDepartures.forEach(d => {
      if (d.isToday === undefined) d.isToday = true;
      if (d.isFirstOfDay === undefined) d.isFirstOfDay = false;
      if (d.isNextService === undefined) d.isNextService = false;
    });

    // 4. Merge full daily scheduled timetable departures for this stop
    {
      const routesForStop = this.findRoutesServingStop(sId, lineId);
      const now = new Date();
      const networkNow = timeUtils.getNetworkTime(this.agencyTimezone, now);
      const nowSec = timeUtils.timeToSec(networkNow.timeStr);
      const dayTypeToday = (networkNow.dayOfWeek >= 1 && networkNow.dayOfWeek <= 5) ? 'weekday' : (networkNow.dayOfWeek === 6 ? 'saturday' : 'sunday');
      const seenTimes = new Set(finalDepartures.map(d => d.departureTime));

      const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
      const networkTomorrow = timeUtils.getNetworkTime(this.agencyTimezone, tomorrow);
      const dayTypeTomorrow = (networkTomorrow.dayOfWeek >= 1 && networkTomorrow.dayOfWeek <= 5) ? 'weekday' : (networkTomorrow.dayOfWeek === 6 ? 'saturday' : 'sunday');

      routesForStop.forEach(r => {
        const lIdStr = String(r.id_linea || lineId || '1');
        const lineSchedToday = this.getScheduleForLine(lIdStr, r.id, dayTypeToday);

        const startSecToday = timeUtils.timeToSec(lineSchedToday.inicio);
        const endSecToday = timeUtils.timeToSec(lineSchedToday.fin);
        const routeStops = r.stops || [];
        const travelTimes = scheduleSynthesizer.estimateStopTravelTimes(routeStops, {
          speedMps: 4.8,
          dwellSecPerStop: 25,
          defaultSegmentMeters: 300
        });
        const travelSec = scheduleSynthesizer.getTravelTimeToStop(travelTimes, sId);

        const headwaySec = (lineSchedToday.headwayMins || 20) * 60;
        const isOperatingToday = nowSec >= startSecToday && nowSec <= endSecToday + travelSec;

        if (isOperatingToday) {
          // Generate departures for today from now onwards
          let tripCount = 0;
          for (let depSec = startSecToday; depSec <= endSecToday; depSec += headwaySec) {
            const passingSec = depSec + travelSec;
            if (passingSec < nowSec - 60) continue;

            const passHour = Math.floor(passingSec / 3600) % 24;
            const passMin = Math.floor((passingSec % 3600) / 60);
            const passingTimeStr = `${String(passHour).padStart(2, '0')}:${String(passMin).padStart(2, '0')}`;

            if (seenTimes.has(passingTimeStr)) continue;
            seenTimes.add(passingTimeStr);

            const depUtcDate = timeUtils.localTimeToUtcDate(networkNow.year, networkNow.month, networkNow.day, passHour, passMin, 0, this.agencyTimezone);
            const diffMs = depUtcDate.getTime() - Date.now();
            const diffMin = Math.max(1, Math.round(diffMs / 60000));

            finalDepartures.push({
              lineId: lIdStr,
              lineName: r.lineName || `Línia ${lIdStr}`,
              destination: r.name,
              departureTime: passingTimeStr,
              departureDate: depUtcDate.toISOString(),
              expectedIso: depUtcDate.toISOString(),
              aimedIso: depUtcDate.toISOString(),
              minutesAway: diffMin,
              isRealTime: false,
              isEstimated: false,
              isToday: true,
              isFirstOfDay: false,
              isNextService: tripCount === 0 && finalDepartures.length === 0,
              delayStatus: 'scheduled',
              delayBadgeText: 'Horari teòric',
              comparisonText: `📅 Horari teòric: ${passingTimeStr}`,
              formattedStatus: `${passingTimeStr}`
            });
            tripCount++;
          }
        }

        // If few departures remain (e.g. night time after fin or before morning start), generate tomorrow morning departures
        if (finalDepartures.length < 5) {
          const lineSchedTomorrow = this.getScheduleForLine(lIdStr, r.id, dayTypeTomorrow);
          const startSecTomorrow = timeUtils.timeToSec(lineSchedTomorrow.inicio);
          const endSecTomorrow = timeUtils.timeToSec(lineSchedTomorrow.fin);
          const headwaySecTomorrow = (lineSchedTomorrow.headwayMins || 20) * 60;

          let tripCount = 0;
          for (let depSec = startSecTomorrow; depSec <= endSecTomorrow && tripCount < 10; depSec += headwaySecTomorrow) {
            const passingSec = depSec + travelSec;
            const passHour = Math.floor(passingSec / 3600) % 24;
            const passMin = Math.floor((passingSec % 3600) / 60);
            const passingTimeStr = `${String(passHour).padStart(2, '0')}:${String(passMin).padStart(2, '0')}`;

            const depUtcDate = timeUtils.localTimeToUtcDate(networkTomorrow.year, networkTomorrow.month, networkTomorrow.day, passHour, passMin, 0, this.agencyTimezone);
            const diffMs = depUtcDate.getTime() - Date.now();
            const diffMin = Math.max(1, Math.round(diffMs / 60000));
            const isFirst = tripCount === 0;

            finalDepartures.push({
              lineId: lIdStr,
              lineName: r.lineName || `Línia ${lIdStr}`,
              destination: r.name,
              departureTime: passingTimeStr,
              departureDate: depUtcDate.toISOString(),
              expectedIso: depUtcDate.toISOString(),
              aimedIso: depUtcDate.toISOString(),
              minutesAway: diffMin,
              isRealTime: false,
              isEstimated: false,
              isToday: false,
              isFirstOfDay: isFirst,
              isNextService: isFirst,
              delayStatus: 'scheduled',
              delayBadgeText: isFirst ? '🌅 1r Servei del matí' : 'Programat',
              comparisonText: isFirst ? `📅 Pas teòric previst demà a les ${passingTimeStr}` : `📅 Horari teòric: ${passingTimeStr}`,
              formattedStatus: `${passingTimeStr}`
            });
            tripCount++;
          }
        }
      });
    }

    return {
      stop: {
        id: sId,
        name: stopInfo.name,
        lat: stopInfo.lat,
        lon: stopInfo.lon,
        zone: 'Mataró Urbà'
      },
      departures: finalDepartures,
      totalDepartures: finalDepartures.length
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
      chosenStop = routeStops[0];
    }

    if (!chosenStop) {
      return { targetStop: null, nextBus: null, upcomingDepartures: [] };
    }

    const sId = String(chosenStop.id);
    const stopDepartures = await this.getStopDepartures(sId, lId);
    const deps = stopDepartures.departures || [];
    const nextBus = deps.length > 0 ? deps[0] : null;

    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const netTomorrow = timeUtils.getNetworkTime(this.agencyTimezone, tomorrow);
    const dayType = (netTomorrow.dayOfWeek >= 1 && netTomorrow.dayOfWeek <= 5) ? 'weekday' : (netTomorrow.dayOfWeek === 6 ? 'saturday' : 'sunday');
    const lineSched = this.getScheduleForLine(lId, selectedRoute?.id, dayType);
    const firstTimeTomorrow = nextBus?.departureTime || lineSched.inicio;

    return {
      line: {
        id: lId,
        code: String(lId),
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
      upcomingDepartures: deps,
      serviceStatus: {
        isOperating: deps.some(d => d.isRealTime || d.isEstimated),
        period: (new Date().getHours() >= 22 || new Date().getHours() < 6) ? 'night' : 'day',
        firstServiceTomorrow: firstTimeTomorrow,
        statusText: deps.some(d => d.isRealTime || d.isEstimated) ? 'Servei en funcionament' : `Servei fora d'horari • Represa demà a les ${firstTimeTomorrow}`
      }
    };
  }
}

module.exports = new MataroTracker();
