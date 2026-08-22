const fs = require('fs');
const path = require('path');
const mouteClient = require('./mouteClient');
const moventisClient = require('./moventisClient');
const geoEngine = require('./core/geo/geoEngine');
const timeEngine = require('./core/time/timeEngine');
const calendarEngine = require('./core/time/calendarEngine');
const scheduleSynthesizer = require('./core/schedule/scheduleSynthesizer');
const delayEngine = require('./core/schedule/delayEngine');
const geoUtils = require('./geoUtils');
const timeUtils = require('./timeUtils');
const BaseTracker = require('./core/BaseTracker');

const MARESME_LINES_CONFIG = [
  {
    id: 'n80',
    routeId: 'GEN_0109',
    moventisLineId: '68',
    code: 'N80',
    name: 'Barcelona (Pg. de Gràcia) ⇄ Mataró (NitBus)',
    color: '#009485',
    agency: 'Moventis / Casas (NitBus Maresme)',
    group: 'moventis',
    directions: [
      { dirId: '0', name: 'Cap a Barcelona (Pg. de Gràcia)' },
      { dirId: '1', name: 'Cap a Mataró (Renfe)' }
    ]
  },
  {
    id: 'n81',
    routeId: 'GEN_0147',
    moventisLineId: '69',
    code: 'N81',
    name: 'Barcelona (Pg. de Gràcia) ⇄ Vilassar de Dalt (NitBus)',
    color: '#009485',
    agency: 'Moventis / Casas (NitBus)',
    group: 'moventis',
    directions: [
      { dirId: '0', name: 'Cap a Barcelona (Pg. de Gràcia)' },
      { dirId: '1', name: 'Cap a Vilassar de Dalt' }
    ]
  },
  {
    id: 'e111',
    routeId: 'GEN_0496',
    moventisLineId: '47',
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
    moventisLineId: '48',
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
    moventisLineId: '57',
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
    moventisLineId: '59',
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
    moventisLineId: '61',
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
    moventisLineId: '54',
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
    moventisLineId: '55',
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
    moventisLineId: '56',
    code: 'C-15',
    name: 'Teià ⇄ El Masnou (Estació Rodalies)',
    color: '#009485',
    agency: 'Moventis / Casas (Maresme)',
    group: 'moventis',
    directions: [
      { dirId: '0', name: 'Cap a Teià' },
      { dirId: '1', name: 'Cap a El Masnou (Estació)' }
    ]
  },
  {
    id: '865',
    routeId: 'GEN_0865',
    moventisLineId: '51',
    code: '865',
    name: 'Mataró ⇄ Bellaterra (UAB)',
    color: '#009485',
    agency: 'Moventis / Casas (Universitat)',
    group: 'moventis',
    directions: [
      { dirId: '0', name: 'Cap a Bellaterra (UAB)' },
      { dirId: '1', name: 'Cap a Mataró' }
    ]
  }
];

const MARESME_CANONICAL_SHAPES = {
  'e111_0': 'GEN_24318',
  'e111_1': 'GEN_23685',
  'e112_0': 'GEN_18664',
  'e112_1': 'GEN_18716',
  'n80_0': 'GEN_31875',
  'n80_1': 'GEN_31875',
  'n81_0': 'GEN_23494',
  'n81_1': 'GEN_23494',
  'c20_0': 'GEN_25347',
  'c20_1': 'GEN_22065',
  'c30_0': 'GEN_23682',
  'c30_1': 'GEN_22381',
  'c3_0': 'GEN_17923',
  'c3_1': 'GEN_22652',
  'c12_0': 'GEN_18107',
  'c12_1': 'GEN_18074',
  'c14_0': 'GEN_17988',
  'c14_1': 'GEN_22907'
};

class MaresmeTracker extends BaseTracker {
  constructor() {
    super();
    this.agencyTimezone = 'Europe/Madrid';
    this.lines = MARESME_LINES_CONFIG;
    this.stopsMap = new Map();
    this.shapesMap = new Map();
    this.tripsMap = new Map();
    this.stopTimesByTrip = new Map();
    this.allStopsMap = new Map();
    this.shapesDb = null;
    this.getShapeStmt = null;
    this.isLoaded = false;
    this.baseLineDetailsCache = new Map();
    this._shapeDbWarned = false;
  }

  async init() {
    this.loadData();
  }

  getShapeCoords(shapeId) {
    if (!shapeId) return null;
    if (!this.isLoaded) {
      this.loadData();
    }
    if (this.shapesMap.has(shapeId)) {
      const pts = this.shapesMap.get(shapeId);
      if (pts && pts.length > 0) {
        return pts.map(p => Array.isArray(p) ? p : [p.lat, p.lon]);
      }
    }
    if (!this.getShapeStmt) {
      try {
        const sqlite = require('node:sqlite');
        const dbPath = path.join(__dirname, '..', 'data', 'shapes.db');
        if (fs.existsSync(dbPath)) {
          this.shapesDb = new sqlite.DatabaseSync(dbPath);
          this.getShapeStmt = this.shapesDb.prepare('SELECT coords FROM shapes WHERE shape_id = ?');
        }
      } catch (e) {
        if (!this._shapeDbWarned) {
          this._shapeDbWarned = true;
          console.warn('[MaresmeTracker] ⚠️ shapes.db unavailable or corrupted — routes fall back to straight segments between stops');
        }
      }
    }
    if (this.getShapeStmt) {
      try {
        const row = this.getShapeStmt.get(shapeId);
        if (row?.coords) {
          return JSON.parse(row.coords);
        }
      } catch (e) {
        if (!this._shapeDbWarned) {
          this._shapeDbWarned = true;
          console.warn('[MaresmeTracker] ⚠️ shapes.db unavailable or corrupted — routes fall back to straight segments between stops');
        }
      }
    }
    return null;
  }

  loadData() {
    if (this.isLoaded) return;
    try {
      const cachePath = path.join(__dirname, '..', 'data', 'cache', 'maresme_cache.json');
      const stopsCachePath = path.join(__dirname, '..', 'data', 'cache', 'stops.json');
      const atmDir = path.join(__dirname, '..', 'data', 'atm_gtfs');

      if (fs.existsSync(cachePath)) {
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        Object.entries(cached.tripsMap || {}).forEach(([k, v]) => this.tripsMap.set(k, v));
        Object.entries(cached.shapesMap || {}).forEach(([k, v]) => {
          this.shapesMap.set(k, v.map((pt, i) => ({ lat: pt[0], lon: pt[1], seq: i })));
        });
        Object.entries(cached.stopTimesByTrip || {}).forEach(([k, v]) => this.stopTimesByTrip.set(k, v));

        if (fs.existsSync(stopsCachePath)) {
          const stopsList = JSON.parse(fs.readFileSync(stopsCachePath, 'utf8'));
          stopsList.forEach(s => {
            const mouteId = String(s.code || s.id).replace('GEN_PF', '').replace(/^0+/, '');
            const stopObj = {
              id: s.id,
              mouteStopId: mouteId,
              code: mouteId,
              name: s.name,
              lat: s.lat,
              lon: s.lon,
              zone: 'Zona Maresme'
            };
            this.stopsMap.set(s.id, stopObj);
            this.stopsMap.set(mouteId, stopObj);
          });
        }
      } else if (fs.existsSync(atmDir)) {
        const targetRouteIds = new Set(this.lines.map(l => l.routeId));
        const targetTripIds = new Set();
        const targetShapeIds = new Set();

        // 1. Filtered Trips
        const tripsPath = path.join(atmDir, 'trips.txt');
        if (fs.existsSync(tripsPath)) {
          fs.readFileSync(tripsPath, 'utf8').split('\n').slice(1).filter(Boolean).forEach(l => {
            const p = l.split(',');
            const routeId = p[0];
            if (targetRouteIds.has(routeId)) {
              const tripId = p[1];
              const dirId = p[4] || '0';
              const shapeId = p[6] || '';
              if (!this.tripsMap.has(routeId)) this.tripsMap.set(routeId, []);
              this.tripsMap.get(routeId).push({ tripId, routeId, dirId, shapeId });
              targetTripIds.add(tripId);
              if (shapeId) targetShapeIds.add(shapeId);
            }
          });
        }

        // 2. Filtered Shapes
        const shapesPath = path.join(atmDir, 'shapes.txt');
        if (fs.existsSync(shapesPath)) {
          fs.readFileSync(shapesPath, 'utf8').split('\n').slice(1).filter(Boolean).forEach(l => {
            const parts = l.split(',');
            const sId = parts[0];
            if (targetShapeIds.has(sId)) {
              if (!this.shapesMap.has(sId)) this.shapesMap.set(sId, []);
              this.shapesMap.get(sId).push({
                lat: parseFloat(parts[1]),
                lon: parseFloat(parts[2]),
                seq: parseInt(parts[3], 10)
              });
            }
          });
          this.shapesMap.forEach(pts => pts.sort((a, b) => a.seq - b.seq));
        }

        // 3. Filtered Stop Times
        const stPath = path.join(atmDir, 'stop_times.txt');
        if (fs.existsSync(stPath)) {
          fs.readFileSync(stPath, 'utf8').split('\n').slice(1).filter(Boolean).forEach(l => {
            const p = l.split(',');
            const tripId = p[0];
            if (targetTripIds.has(tripId)) {
              if (!this.stopTimesByTrip.has(tripId)) this.stopTimesByTrip.set(tripId, []);
              this.stopTimesByTrip.get(tripId).push({
                tripId,
                arr: p[1],
                dep: p[2],
                stopId: p[3],
                seq: parseInt(p[4], 10)
              });
            }
          });
          this.stopTimesByTrip.forEach(arr => arr.sort((a, b) => a.seq - b.seq));
        }

        // 4. Stops
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
        activeBuses: (() => {
          const seen = new Set();
          const list = [];
          [...(details0.activeBuses || []), ...(details1.activeBuses || [])].forEach(b => {
            if (!b) return;
            const k = String(b.tripId || b.vehicleId || `${b.lat}_${b.lon}`);
            if (!seen.has(k)) {
              seen.add(k);
              list.push(b);
            }
          });
          return list;
        })(),
        totalActiveBuses: (() => {
          const seen = new Set();
          let cnt = 0;
          [...(details0.activeBuses || []), ...(details1.activeBuses || [])].forEach(b => {
            if (!b) return;
            const k = String(b.tripId || b.vehicleId || `${b.lat}_${b.lon}`);
            if (!seen.has(k)) {
              seen.add(k);
              cnt++;
            }
          });
          return cnt;
        })()
      };
    }

    const dir = String(direction || '0');

    // Priority 1: Moventis Official API Resolution
    if (lineConfig.moventisLineId) {
      try {
        const cacheKey = `${lineConfig.id}_${dir}`;
        let baseData = this.baseLineDetailsCache.get(cacheKey);

        if (!baseData) {
          const trayectos = await moventisClient.getLineTrayectos(lineConfig.moventisLineId);
          if (trayectos && trayectos.length > 0) {
            const targetSentido = (dir === '0') ? 'V' : 'I';
            let matchingTrays = trayectos.filter(t => t.SENTIDO === targetSentido);
            if (matchingTrays.length === 0) matchingTrays = trayectos;
            matchingTrays.sort((a, b) => (b.TrayectosDet?.length || 0) - (a.TrayectosDet?.length || 0));
            const chosenTray = matchingTrays[0] || trayectos[0];

            if (chosenTray && chosenTray.TrayectosDet && chosenTray.TrayectosDet.length > 0) {
              const stops = chosenTray.TrayectosDet.map((st, idx) => {
                const p = st.Parada || {};
                const idStr = String(p.ID_PARADA || p.COD_PARADA);
                return {
                  id: idStr,
                  code: String(p.COD_PARADA || idStr),
                  moventisStopId: String(p.ID_PARADA || idStr),
                  mouteStopId: String(p.COD_PARADA || idStr),
                  name: p.DESC_PARADA || `Parada ${idStr}`,
                  lat: p.LATITUD || 41.5365,
                  lon: p.LONGITUD || 2.43047,
                  seq: idx + 1,
                  zone: p.MUNICIPIO || 'Zona Maresme'
                };
              });

              stops.forEach(s => this.stopsMap.set(s.id, s));

              let polylineCoords = [];
              const canonicalShape = MARESME_CANONICAL_SHAPES[`${lineConfig.id}_${dir}`];
              if (canonicalShape) {
                const sqliteCoords = this.getShapeCoords(canonicalShape);
                if (sqliteCoords && sqliteCoords.length > 0) {
                  polylineCoords = sqliteCoords;
                }
              }
              if (polylineCoords.length === 0 && stops.length > 0) {
                polylineCoords = stops.map(s => [s.lat, s.lon]);
              }
              if (polylineCoords.length > 1 && stops.length > 0) {
                const composed = geoEngine.composeRouteWithStops(polylineCoords, stops);
                if (composed.stitched > 0) polylineCoords = composed.coords;
              }

              // Parallel timetable fetch across all matching trajectories
              const allScheds = await Promise.all(
                matchingTrays.map(t => moventisClient.getParadasTimetable(lineConfig.moventisLineId, t.ID_TRAYECTO))
              );

              const scheduledRuns = [];
              const seenStartTimes = new Set();

              allScheds.forEach(paradasSched => {
                if (paradasSched && paradasSched.length > 0 && paradasSched[0].hora) {
                  const startTimes = paradasSched[0].hora || [];
                  const lastStopSched = paradasSched[paradasSched.length - 1];
                  const lastTimes = lastStopSched?.hora || [];

                  startTimes.forEach((startStr, tIdx) => {
                    if (!seenStartTimes.has(startStr)) {
                      seenStartTimes.add(startStr);
                      const endStr = lastTimes[tIdx] || lastTimes[lastTimes.length - 1] || startStr;
                      const startSec = timeUtils.timeToSec(startStr);
                      const endSec = timeUtils.timeToSec(endStr);
                      const durSec = Math.max(900, (endSec >= startSec ? endSec - startSec : (86400 - startSec + endSec)));
                      scheduledRuns.push({ startSec, durSec, startStr });
                    }
                  });
                }
              });

              baseData = {
                stops,
                polylineCoords,
                scheduledRuns
              };
              this.baseLineDetailsCache.set(cacheKey, baseData);
            }
          }
        }

        if (baseData) {
          const { stops, polylineCoords, scheduledRuns } = baseData;
          const netNow = timeUtils.getNetworkTime(this.agencyTimezone);
          const currentSec = netNow.hour * 3600 + netNow.minute * 60 + netNow.second;
          const activeBuses = [];

          scheduledRuns.forEach((run, tIdx) => {
            let elapsedSec = currentSec - run.startSec;
            if (elapsedSec < 0 && run.startSec > 72000 && currentSec < 21600) {
              elapsedSec = (86400 - run.startSec) + currentSec;
            }

            if (elapsedSec >= 0 && elapsedSec <= run.durSec) {
              const progress = Math.min(0.99, Math.max(0.01, elapsedSec / run.durSec));
              const polyIdx = Math.min(polylineCoords.length - 1, Math.floor(progress * (polylineCoords.length - 1)));
              const pos = polylineCoords[polyIdx];
              const nextPos = polylineCoords[Math.min(polylineCoords.length - 1, polyIdx + 1)] || pos;

              const bearing = Math.round(geoEngine.calculateBearing(pos[0], pos[1], nextPos[0], nextPos[1]) || 0);
              const compass = geoEngine.bearingToCompassName(bearing);

              const stopIndex = Math.min(stops.length - 2, Math.floor(progress * (stops.length - 1)));
              const fromStop = stops[stopIndex];
              const toStop = stops[stopIndex + 1];

              const speedKmh = lineConfig.code.includes('e11') ? 55 : 34;
              const remainingSec = Math.round(run.durSec - elapsedSec);

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
                isEstimated: true,
                statusText: '⚡ Estimació de Posició (Dead-Reckoning)',
                coordinatesFormatted: `${pos[0].toFixed(5)}° N, ${pos[1].toFixed(5)}° E`
              });
            }
          });

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
              isOperating: (() => {
                const localHour = calendarEngine.getDateComponents(new Date(), this.agencyTimezone).hour;
                return lineConfig.id.startsWith('n') ? (localHour >= 23 || localHour < 6) : (localHour >= 6 && localHour < 23);
              })(),
              calendarTag: 'Feiners (de dilluns a divendres)',
              firstServiceTomorrow: lineConfig.id.startsWith('n') ? '23:30' : '06:00'
            }
          };
        }
      } catch (movErr) {
        console.warn(`[MaresmeTracker] Moventis API fallback for ${lineConfig.code}:`, movErr.message);
      }
    }

    // Dynamic GTFS Resolution via CataloniaTracker
    try {
      const cataloniaTracker = require('./cataloniaTracker');
      const catRoute = cataloniaTracker.routes?.find(r => r.routeId === lineConfig.routeId || r.code?.toLowerCase() === lineConfig.code?.toLowerCase() || r.id.includes(lineConfig.id));
      if (catRoute) {
        const catDetails = await cataloniaTracker.getLineDetails(catRoute.id, dir);
        if (catDetails && catDetails.stops?.length > 0) {
          const activeBuses = this.calculateActiveBuses(lineConfig, dir, catDetails.stops, catDetails.coords || []);
          return {
            id: lineConfig.id,
            code: lineConfig.code,
            name: lineConfig.name,
            color: lineConfig.color,
            agency: lineConfig.agency,
            direction: dir,
            directions: catDetails.directions || lineConfig.directions,
            stops: catDetails.stops,
            coords: catDetails.coords || [],
            polyline: catDetails.coords || [],
            activeBuses,
            checkpoints: catDetails.stops.filter((s, i) => i === 0 || i === catDetails.stops.length - 1 || i % 4 === 0).map(s => ({
              id: s.id,
              name: s.name,
              seq: s.seq,
              zone: s.zone,
              isPassed: false,
              hasBus: activeBuses.some(b => b.toSeq >= s.seq && b.fromSeq <= s.seq),
              etaMinutes: 0
            })),
            totalActiveBuses: activeBuses.length,
            serviceStatus: {
              isOperating: (() => {
                const localHour = calendarEngine.getDateComponents(new Date(), this.agencyTimezone).hour;
                return lineConfig.id.startsWith('n') ? (localHour >= 23 || localHour < 6) : (localHour >= 6 && localHour < 23);
              })(),
              calendarTag: 'Feiners (de dilluns a divendres)',
              firstServiceTomorrow: lineConfig.id.startsWith('n') ? '23:30' : '06:00'
            }
          };
        }
      }
    } catch (e) {
      // Fallback to local cache if cataloniaTracker is still initializing
    }

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
    const canonicalShape = MARESME_CANONICAL_SHAPES[`${lineConfig.id}_${dir}`] || chosenTrip?.shapeId;
    if (canonicalShape) {
      const sqliteCoords = this.getShapeCoords(canonicalShape);
      if (sqliteCoords && sqliteCoords.length > 0) {
        polylineCoords = sqliteCoords;
      }
    }
    if (polylineCoords.length === 0 && chosenTrip?.shapeId && this.shapesMap.has(chosenTrip.shapeId)) {
      polylineCoords = this.shapesMap.get(chosenTrip.shapeId).map(p => [p.lat, p.lon]);
    }
    if (polylineCoords.length === 0 && stops.length > 0) {
      polylineCoords = stops.map(s => [s.lat, s.lon]);
    }
    if (polylineCoords.length > 1 && stops.length > 0) {
      const composed = geoEngine.composeRouteWithStops(polylineCoords, stops);
      if (composed.stitched > 0) polylineCoords = composed.coords;
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
        isOperating: (() => {
          const localHour = calendarEngine.getDateComponents(new Date(), this.agencyTimezone).hour;
          return lineConfig.id.startsWith('n') ? (localHour >= 23 || localHour < 6) : (localHour >= 6 && localHour < 23);
        })(),
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

    scheduledRuns.forEach((run, tIdx) => {
      let elapsedSec = currentSec - run.startSec;
      if (elapsedSec < 0 && run.startSec > 72000 && currentSec < 21600) {
        elapsedSec = (86400 - run.startSec) + currentSec;
      }

      if (elapsedSec >= 0 && elapsedSec <= run.durSec) {
        const progress = Math.min(0.99, Math.max(0.01, elapsedSec / run.durSec));
        const polyIdx = Math.min(polylineCoords.length - 1, Math.floor(progress * (polylineCoords.length - 1)));
        const pos = polylineCoords[polyIdx];
        const nextPos = polylineCoords[Math.min(polylineCoords.length - 1, polyIdx + 1)] || pos;

        const bearing = Math.round(geoEngine.calculateBearing(pos[0], pos[1], nextPos[0], nextPos[1]) || 0);
        const compass = geoEngine.bearingToCompassName(bearing);

        const stopIndex = Math.min(stops.length - 2, Math.floor(progress * (stops.length - 1)));
        const fromStop = stops[stopIndex];
        const toStop = stops[stopIndex + 1];

        const speedKmh = lineConfig.code.includes('e11') ? 55 : 34;
        const remainingSec = Math.round(run.durSec - elapsedSec);

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
          isEstimated: true,
          statusText: '⚡ Estimació de Posició (Dead-Reckoning)',
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

  matchesDirection(destName, dir, lineConfig) {
    if (dir === 'both' || !lineConfig || !lineConfig.directions) return true;
    const currentDirObj = lineConfig.directions.find(d => String(d.dirId) === String(dir));
    const otherDirObj = lineConfig.directions.find(d => String(d.dirId) !== String(dir));
    if (!currentDirObj) return true;

    const cleanPlaceName = (str) => {
      return String(str || '')
        .toLowerCase()
        .replace(/\bbcn\b/g, 'barcelona')
        .replace(/\([^)]*\)/g, '')
        .replace(/^cap a\s+/i, '')
        .trim();
    };

    const rawClean = cleanPlaceName(destName);
    const parts = rawClean.split(/\s*[-–➔⇄]\s*/).map(p => p.trim()).filter(Boolean);
    const terminus = parts.length > 1 ? parts[parts.length - 1] : (parts[0] || rawClean);

    const currTarget = cleanPlaceName(currentDirObj.name);
    const otherTarget = otherDirObj ? cleanPlaceName(otherDirObj.name) : '';

    const getKeywords = (str) => {
      return str
        .split(/[\s,\/]+/)
        .filter(w => w.length > 2 && !['cap', 'les', 'dels', 'dalt', 'mar', 'renfe', 'estacio', 'estació', 'centre', 'nord', 'parc'].includes(w));
    };

    const currKeywords = getKeywords(currTarget);
    const otherKeywords = getKeywords(otherTarget);

    const matchesCurr = currKeywords.some(k => terminus.includes(k) || (parts.length === 1 && rawClean.includes(k)));
    const matchesOther = otherKeywords.some(k => terminus.includes(k) || (parts.length === 1 && rawClean.includes(k)));

    if (matchesCurr && !matchesOther) return true;
    if (matchesOther && !matchesCurr) return false;
    return true;
  }

  async getStopDepartures(stopId, lineId = null, direction = '0', lineDetails = null) {
    if (!this.isLoaded) {
      this.loadData();
    }
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

    // Moventis Official API Real-Time SAE ETAs & Timetables
    if (lineConfig?.moventisLineId) {
      try {
        const movStopId = stopObj.moventisStopId || stopObj.id || sIdStr;
        const rtRaw = await moventisClient.getRealtimeStopETAs(movStopId, lineConfig.moventisLineId);

        if (Array.isArray(rtRaw) && rtRaw.length > 0) {
          const matchingItems = rtRaw.filter(li => String(li.idLinea) === String(lineConfig.moventisLineId));
          const netNow = timeUtils.getNetworkTime(this.agencyTimezone);
          const rawDeps = [];

          matchingItems.forEach(lineItem => {
            const trs = lineItem.trayectos || {};
            for (const [destName, depList] of Object.entries(trs)) {
              // Strictly filter trayectos by the requested route direction
              if (!this.matchesDirection(destName, dir, lineConfig)) {
                continue;
              }

              const list = Array.isArray(depList) ? depList : (typeof depList === 'object' ? Object.values(depList) : []);
              list.forEach(dep => {
                const isRT = dep.real === 'S';
                let safeMins = null;
                let clockStr = dep.hora || null;

                if (isRT) {
                  const mins = moventisClient.parseRealtimeMinutes(dep.minutos);
                  if (mins !== null) {
                    safeMins = Math.max(0, Math.round(mins));
                    clockStr = timeUtils.secToTime(netNow.currentSec + safeMins * 60).substring(0, 5);
                  }
                } else {
                  if (dep.tiempo) {
                    const matchH = String(dep.tiempo).match(/(\d+)\s*h\s*(\d+)\s*min/i);
                    if (matchH) {
                      safeMins = Math.max(0, parseInt(matchH[1], 10) * 60 + parseInt(matchH[2], 10));
                    }
                  }
                  if (safeMins === null && dep.hora) {
                    const sSec = timeUtils.timeToSec(dep.hora);
                    let diffSec = sSec - netNow.currentSec;
                    if (diffSec < -300 && netNow.hour >= 20 && timeUtils.timeToSec(dep.hora) < 21600) {
                      diffSec += 86400;
                    }
                    safeMins = Math.max(0, Math.round(diffSec / 60));
                  }
                }

                if (safeMins !== null && safeMins >= 0 && safeMins <= 1440) {
                  const depUtc = new Date(Date.now() + safeMins * 60 * 1000);
                  const cleanDest = defaultDest;
                  rawDeps.push({
                    lineId: displayLineId,
                    lineName: lineConfig.code,
                    destination: cleanDest,
                    departureTime: clockStr || timeUtils.secToTime(netNow.currentSec + safeMins * 60).substring(0, 5),
                    expectedIso: depUtc.toISOString(),
                    aimedIso: depUtc.toISOString(),
                    minutesAway: safeMins,
                    isRealTime: isRT,
                    isEstimated: !isRT,
                    isToday: true,
                    isFirstOfDay: false,
                    delayMins: 0,
                    delayStatus: 'on-time',
                    delayBadgeText: isRT ? 'En temps real (GPS)' : 'Horari teòric',
                    comparisonText: isRT ? 'En temps real (GPS Moventis)' : `Horari oficial (${clockStr || dep.hora || ''})`,
                    formattedStatus: safeMins === 0 ? 'Ara' : `${safeMins} min`
                  });
                }
              });
            }
          });

          // Sort by minutesAway first, prioritizing real-time departures
          rawDeps.sort((a, b) => {
            if (a.minutesAway !== b.minutesAway) return a.minutesAway - b.minutesAway;
            if (a.isRealTime && !b.isRealTime) return -1;
            if (!a.isRealTime && b.isRealTime) return 1;
            return 0;
          });

          // Deduplicate by departureTime and close real-time windows
          const seenTimes = new Set();
          rawDeps.forEach(item => {
            if (!seenTimes.has(item.departureTime)) {
              const isOverlapped = !item.isRealTime && departures.some(existing => existing.isRealTime && Math.abs(existing.minutesAway - item.minutesAway) <= 3);
              if (!isOverlapped) {
                seenTimes.add(item.departureTime);
                departures.push(item);
              }
            }
          });
        }

        // If no real-time departures, query stop timetable
        if (departures.length === 0) {
          const trayectos = await moventisClient.getLineTrayectos(lineConfig.moventisLineId);
          const targetSentido = (dir === '0') ? 'V' : 'I';
          let matchingTrays = (trayectos || []).filter(t => t.SENTIDO === targetSentido);
          if (matchingTrays.length === 0) matchingTrays = trayectos || [];
          matchingTrays.sort((a, b) => (b.TrayectosDet?.length || 0) - (a.TrayectosDet?.length || 0));
          const chosenTray = matchingTrays[0] || (trayectos && trayectos[0]);

          if (chosenTray) {
            const paradasSched = await moventisClient.getParadasTimetable(lineConfig.moventisLineId, chosenTray.ID_TRAYECTO);
            const stopEntry = paradasSched.find(p => String(p.COD_PARADA).startsWith(String(stopObj.code)) || String(p.COD_PARADA).startsWith(String(stopObj.id))) || paradasSched[0];
            if (stopEntry && Array.isArray(stopEntry.hora)) {
              const netNow = timeUtils.getNetworkTime(this.agencyTimezone);
              const currentSec = netNow.currentSec;
              stopEntry.hora.forEach(hStr => {
                const sSec = timeUtils.timeToSec(hStr);
                const diffSec = sSec - currentSec;
                if (diffSec >= -300 && diffSec <= 28800) { // next 8 hours
                  const mAway = Math.max(0, Math.round(diffSec / 60));
                  const depUtc = new Date(Date.now() + diffSec * 1000);
                  departures.push({
                    lineId: displayLineId,
                    lineName: lineConfig.code,
                    destination: defaultDest,
                    departureTime: hStr,
                    expectedIso: depUtc.toISOString(),
                    aimedIso: depUtc.toISOString(),
                    minutesAway: mAway,
                    isRealTime: false,
                    isEstimated: true,
                    isToday: true,
                    isFirstOfDay: false,
                    delayMins: 0,
                    delayStatus: 'on-time',
                    delayBadgeText: 'Programat',
                    comparisonText: `Horari oficial Moventis (${hStr})`,
                    formattedStatus: mAway === 0 ? 'Ara' : `${mAway} min`
                  });
                }
              });
            }
          }
        }

        if (departures.length > 0) {
          departures.sort((a, b) => a.minutesAway - b.minutesAway);
          return {
            stop: {
              id: stopObj.id,
              name: stopObj.name,
              zone: stopObj.zone || 'Zona Maresme'
            },
            lineCode: lineConfig.code,
            lineColor: lineConfig.color,
            departures: departures.slice(0, 10),
            totalDepartures: departures.length
          };
        }
      } catch (err) {
        console.warn(`[MaresmeTracker] Stop departures Moventis API fallback:`, err.message);
      }
    }

    // Query Mou-te API with strict line matching and stop validation
    if (stopObj.mouteStopId) {
      try {
        const mouteData = await mouteClient.getNextDepartures(stopObj.mouteStopId, true);
        if (mouteData && mouteData.sortides && Array.isArray(mouteData.sortides.sortida)) {
          const rawLines = mouteData?.parada?.lineas?.linia;
          const linesInStop = Array.isArray(rawLines) ? rawLines : (rawLines ? [rawLines] : []);
          const normCode = lineConfig ? lineConfig.code.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
          const matchingLineIds = new Set();

          linesInStop.forEach(l => {
            const nom = (l.nomLinia || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const desc = (l.descripcioLinia || '').toLowerCase();
            if (normCode && (nom.includes(normCode) || normCode.includes(nom))) {
              matchingLineIds.add(String(l.idLinia));
            } else if (lineConfig && desc.includes(lineConfig.name.toLowerCase())) {
              matchingLineIds.add(String(l.idLinia));
            }
          });

          // Only accept departures if Mou-te confirms this stop serves the requested line
          if (lineConfig && matchingLineIds.size > 0) {
            const seenClockTimes = new Set();
            mouteData.sortides.sortida.forEach(s => {
              if (s.liniaId && !matchingLineIds.has(String(s.liniaId))) {
                return; // Discard departures from other lines at shared stops (e.g. Teià, Alella)
              }

              const arrHour = parseInt(s.hora, 10);
              const arrMin = parseInt(s.minuts, 10);
              if (isNaN(arrHour) || isNaN(arrMin)) return;
              const clockStr = `${String(arrHour).padStart(2, '0')}:${String(arrMin).padStart(2, '0')}`;
              if (seenClockTimes.has(clockStr)) return;
              seenClockTimes.add(clockStr);

              const netDate = timeUtils.getNetworkTime(this.agencyTimezone);
              let depUtc = timeUtils.localTimeToUtcDate(netDate.year, netDate.month, netDate.day, arrHour, arrMin, 0, this.agencyTimezone);
              // Handle midnight rollover (e.g. at 22:00, 00:30 is tomorrow)
              if (netDate.hour >= 18 && arrHour < 6) {
                depUtc = new Date(depUtc.getTime() + 24 * 3600 * 1000);
              }
              const diffMs = depUtc.getTime() - now;
              const diffMin = Math.round(diffMs / 60000);
              if (diffMin < -5) return;
              const safeDiffMin = Math.max(0, diffMin);
              const dest = defaultDest;

              // Match against official GTFS timetable to calculate real delays
              const schedMatch = lineConfig ? this.findClosestScheduledTime(clockStr, stopObj.id, lineConfig.routeId, dir) : null;
              const delayMins = schedMatch ? schedMatch.delayMins : 0;
              const schedTimeStr = schedMatch ? schedMatch.scheduledTime : clockStr;
              
              const delayInfo = delayEngine.computeDelayStatus(delayMins, Boolean(s.realtime), {
                scheduledTime: schedTimeStr
              });

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
                minutesAway: safeDiffMin,
                isRealTime: Boolean(s.realtime),
                isEstimated: !s.realtime,
                isToday: true,
                isFirstOfDay: false,
                delayMins,
                delayMinutes: delayMins,
                delayStatus: delayInfo.delayStatus,
                delayBadgeText: delayInfo.delayBadgeText,
                comparisonText: schedMatch ? `Teòric: ${schedTimeStr} (${delayInfo.delayBadgeText})` : `Horari Mou-te (${clockStr})`,
                formattedStatus: safeDiffMin === 0 ? 'Imminent' : `${safeDiffMin} min`
              });
            });
          }
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

    // Deduplicate departures so each departure minute appears at most once
    const finalDepartures = [];
    const seenTimes = new Set();
    departures.forEach(dep => {
      const key = `${dep.departureTime}_${dep.destination}`;
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
        zone: stopObj.zone || 'Maresme'
      },
      departures: finalDepartures,
      totalDepartures: finalDepartures.length
    };
  }
}

module.exports = new MaresmeTracker();
