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

    const isNightLine = lineConfig && (lineConfig.id.startsWith('n') || lineConfig.code.startsWith('N'));
    const baseTimes = isNightLine
      ? ['23:30', '00:30', '01:30', '02:30', '03:30', '04:30', '05:30']
      : ['06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00', '21:30', '22:00'];

    const netNow = timeUtils.getNetworkTime(this.agencyTimezone);
    const currentSec = netNow.hour * 3600 + netNow.minute * 60 + netNow.second;
    const tripDurationSec = Math.max(1800, stops.length * 240);
    const activeBuses = [];

    baseTimes.forEach((initTimeStr, tIdx) => {
      const initSec = timeUtils.timeToSec(initTimeStr);
      let elapsedSec = currentSec - initSec;
      
      if (isNightLine && initSec > 72000 && currentSec < 21600) {
        elapsedSec = (86400 - initSec) + currentSec;
      }

      if (elapsedSec >= 0 && elapsedSec <= tripDurationSec) {
        const progress = Math.min(0.99, Math.max(0.01, elapsedSec / tripDurationSec));
        const polyIdx = Math.min(polylineCoords.length - 1, Math.floor(progress * (polylineCoords.length - 1)));
        const pos = polylineCoords[polyIdx];
        const nextPos = polylineCoords[Math.min(polylineCoords.length - 1, polyIdx + 1)] || pos;

        const bearing = Math.round(geoUtils.calculateBearing(pos[0], pos[1], nextPos[0], nextPos[1]) || 0);
        const compass = geoUtils.bearingToCompassName(bearing);

        const stopIndex = Math.min(stops.length - 2, Math.floor(progress * (stops.length - 1)));
        const fromStop = stops[stopIndex];
        const toStop = stops[stopIndex + 1];

        const speedKmh = lineConfig.code.includes('e11') ? 62 : 38;
        const remainingSec = Math.round(tripDurationSec - elapsedSec);

        activeBuses.push({
          tripId: `${lineConfig.code}_${initTimeStr.replace(':', '')}`,
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
      directionName: lineConfig.directions[dir]?.name || lineConfig.name,
      nextBus,
      upcomingDepartures: deps
    };
  }

  async getStopDepartures(stopId, lineId = null, direction = '0', lineDetails = null) {
    const lineConfig = lineId ? this.resolveLine(lineId) : null;
    const dir = String(direction || '0');
    const sIdStr = String(stopId);
    const stopObj = this.stopsMap.get(sIdStr) || { id: sIdStr, name: 'Parada Maresme' };
    const lDetails = lineDetails || (lineConfig ? await this.getLineDetails(lineConfig.id, dir) : null);

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

            departures.push({
              lineId: lineConfig ? lineConfig.id : 'moventis',
              lineName: lineConfig ? lineConfig.code : 'Moventis',
              destination: s.direccio || (lineConfig ? lineConfig.directions[dir]?.name : 'Destí'),
              departureTime: clockStr,
              expectedIso: depUtc.toISOString(),
              aimedIso: depUtc.toISOString(),
              minutesAway: diffMin,
              isRealTime: Boolean(s.realtime),
              isEstimated: !s.realtime,
              isToday: true,
              isFirstOfDay: false,
              delayStatus: 'on_time',
              delayBadgeText: 'Puntual',
              comparisonText: `Horari Mou-te (${clockStr})`,
              formattedStatus: diffMin === 0 ? 'Imminent' : `${diffMin} min`
            });
          });
        }
      } catch(e) {
        // Mou-te transient error fallback
      }
    }

    // If no live departures, calculate stop-specific passing times
    if (departures.length === 0 && lDetails) {
      const stops = lDetails.stops || [];
      const stopIdx = stops.findIndex(s => String(s.id) === sIdStr || String(s.mouteStopId) === sIdStr);

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

      const isNightLine = lineConfig && (lineConfig.id.startsWith('n') || lineConfig.code.startsWith('N'));
      const netNow = timeUtils.getNetworkTime(this.agencyTimezone);

      const baseTimes = isNightLine
        ? ['23:30', '00:30', '01:30', '02:30', '03:30', '04:30', '05:30']
        : ['06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00', '21:30', '22:00'];

      baseTimes.forEach((initTimeStr) => {
        const initSec = timeUtils.timeToSec(initTimeStr);
        const passSec = initSec + travelSec;
        const passHour = Math.floor(passSec / 3600) % 24;
        const passMin = Math.floor((passSec % 3600) / 60);
        const passTimeStr = `${String(passHour).padStart(2, '0')}:${String(passMin).padStart(2, '0')}`;

        let dayOffset = 0;
        if (isNightLine) {
          const origH = Math.floor(initSec / 3600) % 24;
          if (origH === 23 && netNow.hour < 12) {
            dayOffset = -1;
          } else if (origH < 12 && netNow.hour >= 12) {
            dayOffset = 1;
          }
        } else {
          const currentSec = netNow.hour * 3600 + netNow.minute * 60;
          if (passSec < currentSec - 300) {
            dayOffset = 1;
          }
        }

        const dateTarget = new Date(now + dayOffset * 86400000);
        const netT = timeUtils.getNetworkTime(this.agencyTimezone, dateTarget);
        const depUtc = timeUtils.localTimeToUtcDate(netT.year, netT.month, netT.day, passHour, passMin, 0, this.agencyTimezone);
        const diffMs = depUtc.getTime() - now;
        const diffMin = Math.round(diffMs / 60000);

        if (diffMin >= -5) {
          departures.push({
            lineId: lineConfig ? lineConfig.id : 'moventis',
            lineName: lineConfig ? lineConfig.code : 'Moventis',
            destination: lineConfig ? lineConfig.directions[dir]?.name : 'Destí',
            departureTime: passTimeStr,
            expectedIso: depUtc.toISOString(),
            aimedIso: depUtc.toISOString(),
            minutesAway: Math.max(0, diffMin),
            isRealTime: false,
            isEstimated: false,
            isToday: dayOffset === 0,
            isFirstOfDay: false,
            isNextService: false,
            delayStatus: 'scheduled',
            delayBadgeText: 'Programat',
            comparisonText: `📅 Horari teòric: ${passTimeStr}`,
            formattedStatus: diffMin <= 0 ? 'Imminent' : `${diffMin} min`
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
