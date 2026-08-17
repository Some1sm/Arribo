const fs = require('fs');
const path = require('path');
const mouteClient = require('./mouteClient');
const geoUtils = require('./geoUtils');
const timeUtils = require('./timeUtils');

const MARESME_LINES_CONFIG = [
  {
    id: 'n80',
    routeId: 'GEN_0109',
    code: 'N80',
    name: 'Barcelona (Pg. de Gràcia) ⇄ Mataró (NitBus)',
    color: '#009485',
    agency: 'Moventis / Casas (NitBus Maresme)',
    group: 'moventis',
    directions: [
      { dirId: '0', name: 'Cap a Mataró (Hospital / Parc) i Barcelona' },
      { dirId: '1', name: 'Cap a Mataró (Hospital / Parc) i Barcelona' }
    ]
  },
  {
    id: 'n81',
    routeId: 'GEN_0147',
    code: 'N81',
    name: 'Barcelona (Pg. de Gràcia) ⇄ Vilassar de Dalt (NitBus)',
    color: '#009485',
    agency: 'Moventis / Casas (NitBus)',
    group: 'moventis',
    directions: [
      { dirId: '0', name: 'Cap a Vilassar de Dalt i Barcelona' },
      { dirId: '1', name: 'Cap a Vilassar de Dalt i Barcelona' }
    ]
  },
  {
    id: 'e111',
    routeId: 'GEN_0496',
    code: 'e11.1',
    name: 'Barcelona (Rda. Universitat) ⇄ Mataró (Pl. Tereses - Exprés)',
    color: '#009485',
    agency: 'Moventis / Casas (Exprés.cat)',
    group: 'moventis',
    directions: [
      { dirId: '0', name: 'Cap a Mataró (Pl. de les Tereses)' },
      { dirId: '1', name: 'Cap a Barcelona (Rda. Universitat)' }
    ]
  },
  {
    id: 'e112',
    routeId: 'GEN_0497',
    code: 'e11.2',
    name: 'Barcelona (Rda. Universitat) ⇄ Mataró (Camí de la Serra / Nord - Exprés)',
    color: '#009485',
    agency: 'Moventis / Casas (Exprés.cat)',
    group: 'moventis',
    directions: [
      { dirId: '0', name: 'Cap a Mataró (Nord / Camí de la Serra)' },
      { dirId: '1', name: 'Cap a Barcelona (Rda. Universitat)' }
    ]
  },
  {
    id: 'c20',
    routeId: 'GEN_0501',
    code: 'C-20',
    name: 'Sant Vicenç de Montalt ⇄ Llavaneres ⇄ Mataró (Estació)',
    color: '#009485',
    agency: 'Moventis / Casas (Maresme)',
    group: 'moventis',
    directions: [
      { dirId: '0', name: 'Cap a Mataró (Hospital / Estació)' },
      { dirId: '1', name: 'Cap a Sant Vicenç de Montalt' }
    ]
  },
  {
    id: 'c30',
    routeId: 'GEN_0495',
    code: 'C-30',
    name: 'Vilassar de Dalt ⇄ Premià ⇄ Cabrera ⇄ Mataró (Hospital)',
    color: '#009485',
    agency: 'Moventis / Casas (Maresme)',
    group: 'moventis',
    directions: [
      { dirId: '0', name: 'Cap a Mataró (Hospital)' },
      { dirId: '1', name: 'Cap a Vilassar de Dalt' }
    ]
  },
  {
    id: 'c3',
    routeId: 'GEN_0831',
    code: 'C-3',
    name: 'Vilassar de Dalt ⇄ Premià de Mar ⇄ Barcelona',
    color: '#009485',
    agency: 'Moventis / Casas (Maresme)',
    group: 'moventis',
    directions: [
      { dirId: '0', name: 'Cap a Vilassar de Dalt' },
      { dirId: '1', name: 'Cap a Barcelona (Gran Via)' }
    ]
  },
  {
    id: 'c12',
    routeId: 'GEN_0832',
    code: 'C-12',
    name: 'Cabrils ⇄ Vilassar de Mar (Estació Rodalies)',
    color: '#009485',
    agency: 'Moventis / Casas (Maresme)',
    group: 'moventis',
    directions: [
      { dirId: '0', name: 'Cap a Vilassar de Mar' },
      { dirId: '1', name: 'Cap a Cabrils' }
    ]
  },
  {
    id: 'c14',
    routeId: 'GEN_0575',
    code: 'C-14',
    name: 'Premià de Dalt ⇄ Premià de Mar (Estació Rodalies)',
    color: '#009485',
    agency: 'Moventis / Casas (Maresme)',
    group: 'moventis',
    directions: [
      { dirId: '0', name: 'Cap a Premià de Dalt' },
      { dirId: '1', name: 'Cap a Premià de Mar (Estació)' }
    ]
  },
  {
    id: 'c15',
    routeId: 'GEN_0273',
    code: 'C-15',
    name: 'Teià ⇄ El Masnou (Estació Rodalies)',
    color: '#009485',
    agency: 'Moventis / Casas (Maresme)',
    group: 'moventis',
    directions: [
      { dirId: '0', name: 'Cap a Teià' },
      { dirId: '1', name: 'Cap a El Masnou (Estació)' }
    ]
  }
];

class MaresmeTracker {
  constructor() {
    this.agencyTimezone = 'Europe/Madrid';
    this.lines = MARESME_LINES_CONFIG;
    this.stopsMap = new Map();
    this.shapesMap = new Map();
    this.tripsMap = new Map();
    this.stopTimesByTrip = new Map();
    this.allStopsMap = new Map();
    this.isLoaded = false;
    this.loadData();
  }

  loadData() {
    if (this.isLoaded) return;
    try {
      const atmDir = path.join(__dirname, '..', 'data', 'atm_gtfs');
      if (!fs.existsSync(atmDir)) return;

      // 1. Stops
      const stopsPath = path.join(atmDir, 'stops.txt');
      if (fs.existsSync(stopsPath)) {
        fs.readFileSync(stopsPath, 'utf8').split('\n').slice(1).filter(Boolean).forEach(l => {
          const parts = l.split(',');
          const id = parts[0];
          const mouteId = id.replace('GEN_PF', '').replace(/^0+/, '');
          const stopObj = {
            id,
            mouteStopId: mouteId,
            code: parts[1] || mouteId,
            name: parts[2]?.replace(/"/g, '') || `Parada ${id}`,
            lat: parseFloat(parts[4]),
            lon: parseFloat(parts[5]),
            zone: 'Zona Maresme'
          };
          this.stopsMap.set(id, stopObj);
          this.stopsMap.set(mouteId, stopObj);
        });
      }

      // 2. Shapes
      const shapesPath = path.join(atmDir, 'shapes.txt');
      if (fs.existsSync(shapesPath)) {
        fs.readFileSync(shapesPath, 'utf8').split('\n').slice(1).filter(Boolean).forEach(l => {
          const parts = l.split(',');
          const sId = parts[0];
          if (!this.shapesMap.has(sId)) this.shapesMap.set(sId, []);
          this.shapesMap.get(sId).push({
            lat: parseFloat(parts[1]),
            lon: parseFloat(parts[2]),
            seq: parseInt(parts[3], 10)
          });
        });
        this.shapesMap.forEach(pts => pts.sort((a, b) => a.seq - b.seq));
      }

      // 3. Trips
      const tripsPath = path.join(atmDir, 'trips.txt');
      if (fs.existsSync(tripsPath)) {
        fs.readFileSync(tripsPath, 'utf8').split('\n').slice(1).filter(Boolean).forEach(l => {
          const p = l.split(',');
          const routeId = p[0];
          const tripId = p[1];
          const dirId = p[4] || '0';
          const shapeId = p[6] || '';
          if (!this.tripsMap.has(routeId)) this.tripsMap.set(routeId, []);
          this.tripsMap.get(routeId).push({ tripId, routeId, dirId, shapeId });
        });
      }

      // 4. Stop Times
      const stPath = path.join(atmDir, 'stop_times.txt');
      if (fs.existsSync(stPath)) {
        fs.readFileSync(stPath, 'utf8').split('\n').slice(1).filter(Boolean).forEach(l => {
          const p = l.split(',');
          const tripId = p[0];
          if (!this.stopTimesByTrip.has(tripId)) this.stopTimesByTrip.set(tripId, []);
          this.stopTimesByTrip.get(tripId).push({
            tripId,
            arr: p[1],
            dep: p[2],
            stopId: p[3],
            seq: parseInt(p[4], 10)
          });
        });
        this.stopTimesByTrip.forEach(arr => arr.sort((a, b) => a.seq - b.seq));
      }

      // 5. Index search stops
      this.lines.forEach(l => {
        const lineTrips = this.tripsMap.get(l.routeId) || [];
        const sampleTrip = lineTrips[0];
        if (sampleTrip) {
          const st = this.stopTimesByTrip.get(sampleTrip.tripId) || [];
          st.forEach(s => {
            const sObj = this.stopsMap.get(s.stopId);
            if (sObj) {
              this.allStopsMap.set(sObj.id, {
                ...sObj,
                lineId: l.id,
                lineCode: l.code,
                lineColor: l.color
              });
            }
          });
        }
      });

      this.isLoaded = true;
      console.log(`[MaresmeTracker] Loaded ${this.lines.length} Moventis Maresme lines with ${this.allStopsMap.size} stops!`);
    } catch(e) {
      console.error('[MaresmeTracker] Error loading GTFS data:', e.message);
    }
  }

  getLines() {
    return this.lines.map(l => ({
      id: l.id,
      code: l.code,
      name: l.name,
      color: l.color,
      agency: l.agency,
      group: l.group,
      directions: l.directions
    }));
  }

  resolveLine(lineId) {
    const cleanId = String(lineId).toLowerCase().replace('moventis_', '').replace('line-', '').trim();
    return this.lines.find(l => l.id === cleanId || l.code.toLowerCase() === cleanId || l.code.toLowerCase().replace(/[^a-z0-9]/g, '') === cleanId) || null;
  }

  async getLineDetails(lineId, direction = '0') {
    this.loadData();
    const lineConfig = this.resolveLine(lineId);
    if (!lineConfig) throw new Error(`Maresme line ${lineId} not found`);

    if (direction === 'both' && lineConfig.directions?.length > 1) {
      const details0 = await this.getLineDetails(lineId, String(lineConfig.directions[0].dirId || '0'));
      const details1 = await this.getLineDetails(lineId, String(lineConfig.directions[1].dirId || '1'));
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
          { dirId: String(lineConfig.directions[0].dirId || '0'), name: lineConfig.directions[0].name, stops: details0.stops, coords: details0.coords },
          { dirId: String(lineConfig.directions[1].dirId || '1'), name: lineConfig.directions[1].name, stops: details1.stops, coords: details1.coords }
        ],
        activeBuses: [...(details0.activeBuses || []), ...(details1.activeBuses || [])],
        totalActiveBuses: (details0.activeBuses?.length || 0) + (details1.activeBuses?.length || 0)
      };
    }

    const dir = String(direction || '0');
    const lineTrips = this.tripsMap.get(lineConfig.routeId) || [];
    const dirTrips = lineTrips.filter(t => t.dirId === dir);
    const chosenTrip = dirTrips[0] || lineTrips[0];

    const rawStopTimes = chosenTrip ? (this.stopTimesByTrip.get(chosenTrip.tripId) || []) : [];
    const stops = rawStopTimes.map((st, idx) => {
      const sObj = this.stopsMap.get(st.stopId) || { id: st.stopId, name: `Parada ${st.stopId}`, lat: 41.5365, lon: 2.43047 };
      return {
        id: sObj.id,
        code: sObj.code,
        mouteStopId: sObj.mouteStopId,
        name: sObj.name,
        lat: sObj.lat,
        lon: sObj.lon,
        seq: idx + 1,
        zone: sObj.zone || 'Zona Maresme'
      };
    });

    let polylineCoords = [];
    if (chosenTrip?.shapeId && this.shapesMap.has(chosenTrip.shapeId)) {
      polylineCoords = this.shapesMap.get(chosenTrip.shapeId).map(p => [p.lat, p.lon]);
    }
    if (polylineCoords.length === 0 && stops.length > 0) {
      polylineCoords = stops.map(s => [s.lat, s.lon]);
    }

    // Discover live buses along the route
    const activeBuses = this.calculateActiveBuses(lineConfig, dir, stops, polylineCoords);
    const checkpoints = stops.filter((s, i) => i === 0 || i === stops.length - 1 || i % 4 === 0).map(s => ({
      id: s.id,
      name: s.name,
      seq: s.seq,
      zone: s.zone,
      isPassed: false,
      hasBus: activeBuses.some(b => b.toSeq >= s.seq && b.fromSeq <= s.seq),
      etaMinutes: 0
    }));

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
        isOperating: lineConfig.id.startsWith('n')
          ? (new Date().getHours() >= 23 || new Date().getHours() < 6)
          : (new Date().getHours() >= 6 && new Date().getHours() < 23),
        firstServiceTomorrow: lineConfig.id.startsWith('n') ? '23:30' : '06:00'
      }
    };
  }

  calculateActiveBuses(lineConfig, dir, stops, polylineCoords) {
    if (!polylineCoords || polylineCoords.length < 2 || !stops || stops.length < 2) return [];

    const trips = (this.tripsMap.get(lineConfig.routeId) || []).filter(t => String(t.dirId) === String(dir));
    const netNow = timeUtils.getNetworkTime(this.agencyTimezone);
    const currentSec = netNow.hour * 3600 + netNow.minute * 60 + netNow.second;
    const activeBuses = [];

    // Group unique departure times across trips for this route/direction
    const scheduledRuns = [];
    const seenTimes = new Set();

    for (const trip of trips) {
      const stList = this.stopTimesByTrip.get(trip.tripId) || [];
      if (stList.length >= 2) {
        const startStr = stList[0].dep || stList[0].arr;
        const endStr = stList[stList.length - 1].arr || stList[stList.length - 1].dep;
        if (startStr && endStr && !seenTimes.has(startStr)) {
          seenTimes.add(startStr);
          const startSec = timeUtils.timeToSec(startStr);
          const endSec = timeUtils.timeToSec(endStr);
          const durSec = Math.max(900, (endSec >= startSec ? endSec - startSec : (86400 - startSec + endSec)));
          scheduledRuns.push({
            tripId: trip.tripId,
            startStr: startStr.substring(0, 5),
            startSec,
            endSec,
            durSec,
            stList
          });
        }
      }
    }

    // Sort chronologically
    scheduledRuns.sort((a, b) => a.startSec - b.startSec);

    // Peak-hour highway traffic congestion adjustment (Weekdays 07:30-09:30 and 17:30-19:45)
    const isWeekday = (netNow.dayOfWeek >= 1 && netNow.dayOfWeek <= 5);
    const isMorningPeak = isWeekday && ((netNow.hour === 7 && netNow.minute >= 30) || netNow.hour === 8 || (netNow.hour === 9 && netNow.minute <= 30));
    const isEveningPeak = isWeekday && ((netNow.hour === 17 && netNow.minute >= 15) || netNow.hour === 18 || (netNow.hour === 19 && netNow.minute <= 45));
    
    let trafficDelaySec = 0;
    if (isMorningPeak && String(dir) === '1') {
      trafficDelaySec = 600; // +10 min morning inbound rush
    } else if (isEveningPeak) {
      trafficDelaySec = String(dir) === '1' ? 660 : 480; // +11 min evening inbound to BCN, +8 min evening outbound
    }

    scheduledRuns.forEach((run, tIdx) => {
      const adjustedDurSec = run.durSec + trafficDelaySec;
      let elapsedSec = currentSec - run.startSec;
      if (elapsedSec < 0 && run.startSec > 72000 && currentSec < 21600) {
        elapsedSec = (86400 - run.startSec) + currentSec;
      }

      if (elapsedSec >= 0 && elapsedSec <= adjustedDurSec) {
        const progress = Math.min(0.99, Math.max(0.01, elapsedSec / adjustedDurSec));
        const polyIdx = Math.min(polylineCoords.length - 1, Math.floor(progress * (polylineCoords.length - 1)));
        const pos = polylineCoords[polyIdx];
        const nextPos = polylineCoords[Math.min(polylineCoords.length - 1, polyIdx + 1)] || pos;

        const bearing = Math.round(geoUtils.calculateBearing(pos[0], pos[1], nextPos[0], nextPos[1]) || 0);
        const compass = geoUtils.bearingToCompassName(bearing);

        const stopIndex = Math.min(stops.length - 2, Math.floor(progress * (stops.length - 1)));
        const fromStop = stops[stopIndex];
        const toStop = stops[stopIndex + 1];

        const speedKmh = lineConfig.code.includes('e11') ? (trafficDelaySec > 0 ? 46 : 62) : 34;
        const remainingSec = Math.round(adjustedDurSec - elapsedSec);

        activeBuses.push({
          tripId: `${lineConfig.code}_${run.startStr.replace(':', '')}`,
          vehicleId: `MOV-${1000 + (tIdx * 17) % 900}`,
          lineId: lineConfig.id,
          lineCode: lineConfig.code,
          lineColor: lineConfig.color,
          direction: String(dir),
          lat: pos[0],
          lon: pos[1],
          bearing,
          compass,
          speedKmh,
          trafficDelayMins: Math.round(trafficDelaySec / 60),
          progressInSegment: (progress * (stops.length - 1)) % 1,
          totalProgress: Math.round(progress * 100),
          fromStop: fromStop?.name || 'Origen',
          toStop: toStop?.name || 'Destí',
          fromSeq: fromStop?.seq || 1,
          toSeq: toStop?.seq || 2,
          secondsToNextStop: Math.max(30, Math.round(remainingSec / (stops.length - stopIndex))),
          distanceToNextMeters: Math.round(((remainingSec / (stops.length - stopIndex)) * (speedKmh / 3.6))),
          isTerminalLayover: progress > 0.95,
          currentSegmentTime: `En ruta cap a ${toStop?.name || 'Destí'}`,
          isDeadReckoned: true,
          coordinatesFormatted: `${pos[0].toFixed(5)}° N, ${pos[1].toFixed(5)}° E`
        });
      }
    });

    return activeBuses;
  }

  async getTargetStopETA(lineId, stopId = null, direction = '0') {
    const lineConfig = this.resolveLine(lineId);
    if (!lineConfig) throw new Error(`Maresme line ${lineId} not found`);

    const dir = String(direction || '0');
    const lineDetails = await this.getLineDetails(lineConfig.id, dir);
    const stops = lineDetails.stops || [];

    let chosenStop = null;
    if (stopId) {
      chosenStop = stops.find(s => String(s.id) === String(stopId) || String(s.mouteStopId) === String(stopId) || String(s.code) === String(stopId));
    }
    if (!chosenStop && stops.length > 0) {
      chosenStop = stops[0];
    }

    if (!chosenStop) {
      return { targetStop: null, nextBus: null, upcomingDepartures: [] };
    }

    const stopDepartures = await this.getStopDepartures(chosenStop.id, lineConfig.id, dir, lineDetails);
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
      direction: dir,
      directionName: lineConfig.directions.find(d => String(d.dirId) === dir)?.name || lineConfig.name,
      nextBus,
      upcomingDepartures: deps
    };
  }

  findClosestScheduledTime(clockStr, stopId, routeId, dirId) {
    if (!clockStr || !routeId) return null;
    const trips = (this.tripsMap.get(routeId) || []).filter(t => String(t.dirId) === String(dirId));
    const targetSec = timeUtils.timeToSec(clockStr);
    let bestMatch = null;
    let minDiffSec = Infinity;

    for (const trip of trips) {
      const stList = this.stopTimesByTrip.get(trip.tripId) || [];
      const st = stList.find(s => String(s.stopId) === String(stopId) || String(s.stopId).includes(String(stopId)));
      if (st && st.dep) {
        const schedSec = timeUtils.timeToSec(st.dep);
        const diffSec = Math.abs(targetSec - schedSec);
        if (diffSec < minDiffSec && diffSec <= 2100) {
          minDiffSec = diffSec;
          const delayMins = Math.round((targetSec - schedSec) / 60);
          bestMatch = {
            scheduledTime: st.dep.substring(0, 5),
            schedSec,
            delayMins
          };
        }
      }
    }
    return bestMatch;
  }

  async getStopDepartures(stopId, lineId = null, direction = '0', lineDetails = null) {
    const lineConfig = lineId ? this.resolveLine(lineId) : null;
    const dir = String(direction || '0');
    const sIdStr = String(stopId);
    const stopObj = this.stopsMap.get(sIdStr) || { id: sIdStr, name: 'Parada Maresme' };
    const lDetails = lineDetails || (lineConfig ? await this.getLineDetails(lineConfig.id, dir) : null);

    const dirObj = lineConfig?.directions?.find(d => String(d.dirId) === String(dir)) || lineConfig?.directions?.[0];
    const defaultDest = dirObj ? dirObj.name : (lineConfig ? lineConfig.name : 'Destí');
    const displayLineId = lineConfig ? lineConfig.code : (lineId || 'Moventis');

    const departures = [];
    const now = Date.now();

    // Query Mou-te API
    if (stopObj.mouteStopId) {
      try {
        const mouteData = await mouteClient.getNextDepartures(stopObj.mouteStopId, true);
        if (mouteData && mouteData.sortides && Array.isArray(mouteData.sortides.sortida)) {
          mouteData.sortides.sortida.forEach(s => {
            const arrHour = parseInt(s.hora, 10);
            const arrMin = parseInt(s.minuts, 10);
            const netDate = timeUtils.getNetworkTime(this.agencyTimezone);
            const depUtc = timeUtils.localTimeToUtcDate(netDate.year, netDate.month, netDate.day, arrHour, arrMin, 0, this.agencyTimezone);
            const diffMs = depUtc.getTime() - now;
            const diffMin = Math.max(0, Math.round(diffMs / 60000));
            const clockStr = `${String(arrHour).padStart(2, '0')}:${String(arrMin).padStart(2, '0')}`;
            const dest = s.direccio || s.destinacio || defaultDest;

            // Match against official GTFS timetable to calculate real delays
            const schedMatch = lineConfig ? this.findClosestScheduledTime(clockStr, stopObj.id, lineConfig.routeId, dir) : null;
            const delayMins = schedMatch ? schedMatch.delayMins : 0;
            const schedTimeStr = schedMatch ? schedMatch.scheduledTime : clockStr;
            
            let delayStatus = 'on-time';
            let delayBadgeText = 'Puntual';
            if (delayMins >= 2) {
              delayStatus = 'delayed';
              delayBadgeText = `+${delayMins} min retard`;
            } else if (delayMins <= -2) {
              delayStatus = 'early';
              delayBadgeText = `${Math.abs(delayMins)} min avançat`;
            }

            const aimedUtc = schedMatch
              ? new Date(depUtc.getTime() - delayMins * 60000)
              : depUtc;

            departures.push({
              lineId: displayLineId,
              lineName: lineConfig ? lineConfig.code : 'Moventis',
              destination: dest,
              departureTime: clockStr,
              expectedIso: depUtc.toISOString(),
              aimedIso: aimedUtc.toISOString(),
              minutesAway: diffMin,
              isRealTime: Boolean(s.realtime),
              isEstimated: !s.realtime,
              isToday: true,
              isFirstOfDay: false,
              delayMins,
              delayStatus,
              delayBadgeText,
              comparisonText: schedMatch ? `Teòric: ${schedTimeStr} (${delayBadgeText})` : `Horari Mou-te (${clockStr})`,
              formattedStatus: diffMin === 0 ? 'Imminent' : `${diffMin} min`
            });
          });
        }
      } catch(e) {
        // Mou-te transient error fallback
      }
    }

    // If no live departures, calculate stop-specific passing times from real GTFS timetable
    if (departures.length === 0 && lineConfig) {
      const trips = (this.tripsMap.get(lineConfig.routeId) || []).filter(t => String(t.dirId) === dir);
      const netNow = timeUtils.getNetworkTime(this.agencyTimezone);
      const currentSec = netNow.hour * 3600 + netNow.minute * 60;

      const stopSchedTimes = [];
      const seenTimes = new Set();

      for (const trip of trips) {
        const stList = this.stopTimesByTrip.get(trip.tripId) || [];
        const st = stList.find(s => String(s.stopId) === sIdStr || String(s.stopId) === stopObj.id || String(s.stopId) === stopObj.mouteStopId);
        if (st && st.dep) {
          const timeStr = st.dep.substring(0, 5);
          if (!seenTimes.has(timeStr)) {
            seenTimes.add(timeStr);
            const depSec = timeUtils.timeToSec(st.dep);
            const originDepStr = (stList[0]?.dep || st.dep).substring(0, 5);
            const tripKey = `${lineConfig.code}_${originDepStr.replace(':', '')}`;
            stopSchedTimes.push({ timeStr, depSec, tripKey });
          }
        }
      }

      stopSchedTimes.sort((a, b) => a.depSec - b.depSec);

      stopSchedTimes.forEach(({ timeStr, depSec, tripKey }) => {
        let diffSec = depSec - currentSec;
        let dayOffset = 0;

        if (diffSec < -60) {
          dayOffset = 1;
          diffSec += 86400;
        }

        const dateTarget = new Date(now + dayOffset * 86400000);
        const netT = timeUtils.getNetworkTime(this.agencyTimezone, dateTarget);
        const [passH, passM] = timeStr.split(':').map(Number);
        const depUtc = timeUtils.localTimeToUtcDate(netT.year, netT.month, netT.day, passH, passM, 0, this.agencyTimezone);
        const diffMin = Math.round(diffSec / 60);

        if (diffMin >= 0 && diffMin <= 1440) {
          departures.push({
            lineId: displayLineId,
            lineName: lineConfig ? lineConfig.code : 'Moventis',
            destination: defaultDest,
            departureTime: timeStr,
            expectedIso: depUtc.toISOString(),
            aimedIso: depUtc.toISOString(),
            minutesAway: Math.max(0, diffMin),
            tripId: tripKey,
            isRealTime: false,
            isEstimated: false,
            isToday: dayOffset === 0,
            isFirstOfDay: false,
            isNextService: false,
            delayStatus: 'scheduled',
            delayBadgeText: 'Programat',
            comparisonText: `📅 Horari teòric: ${timeStr}`,
            formattedStatus: diffMin === 0 ? 'Imminent' : `${diffMin} min`
          });
        }
      });

      if (departures.length > 0) {
        departures[0].isNextService = true;
        if (!departures[0].isToday) {
          departures[0].isFirstOfDay = true;
          departures[0].delayBadgeText = '🌅 1r Servei';
        }
      }
    }

    // Strictly match active circulating vehicles with their corresponding GTFS trip
    if (lineConfig) {
      const activeBuses = this.calculateActiveBuses(lineConfig, dir, lDetails?.stops || [], lDetails?.coords || []);

      departures.forEach((dep) => {
        const matchedBus = activeBuses.find(b => b.tripId && dep.tripId && b.tripId === dep.tripId);
        if (matchedBus) {
          dep.vehicleId = matchedBus.vehicleId;
          dep.tripId = matchedBus.tripId;
          dep.busCoords = { lat: matchedBus.lat, lon: matchedBus.lon };
          if (!dep.isRealTime) {
            dep.isEstimated = true;
            dep.delayBadgeText = '⚡ En ruta';
            dep.delayStatus = 'estimated';
          }
        }
      });
    }

    departures.sort((a, b) => (a.minutesAway || 0) - (b.minutesAway || 0));

    return {
      stop: {
        id: stopObj.id,
        name: stopObj.name,
        lat: stopObj.lat,
        lon: stopObj.lon,
        zone: stopObj.zone || 'Maresme'
      },
      departures,
      totalDepartures: departures.length
    };
  }
}

module.exports = new MaresmeTracker();
