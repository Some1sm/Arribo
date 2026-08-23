const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const corridorTracker = require('./src/corridorTracker');
const mataroTracker = require('./src/mataroTracker');
const sagalesTracker = require('./src/sagalesTracker');
const ambTracker = require('./src/ambTracker');
const rodaliesTracker = require('./src/rodaliesTracker');
const maresmeTracker = require('./src/maresmeTracker');
const cataloniaTracker = require('./src/cataloniaTracker');
const routeCacheService = require('./src/routeCacheService');
const reportCacheService = require('./src/reportCacheService');
const flightRecorder = require('./src/flightRecorder');
const trackerRegistry = require('./src/core/TrackerRegistry');
const workerBridge = require('./src/core/WorkerBridge');
const calendarEngine = require('./src/core/time/calendarEngine');
const delayEngine = require('./src/core/schedule/delayEngine');

// ==========================================
// 0. PROCESS-LEVEL RESILIENCE TRAPS
// Resilience-first transit tracker: log unexpected async/sync failures but
// NEVER crash the HTTP process — keep serving cached data to riders.
// ==========================================
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err);
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(compression());
// Note: no express.json() — this service is strictly read-only GET/HEAD (enforced below),
// so request-body parsing is intentionally omitted to shrink the attack surface.

// Strict Read-Only Security Guard: Reject any write requests from clients
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed: This transit service is strictly read-only.' });
  }
  next();
});

// Static assets: enable etag + browser caching for immutable-ish assets while keeping
// HTML always revalidated so deploys propagate immediately.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '5m',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Launch Background Ingestion & Analytics Worker asynchronously via WorkerBridge supervisor
workerBridge.start();
// Fleet positions are authoritative from the worker (already extrapolated there).
// Disable the master-process auto extrapolator to avoid double-applying drift.
flightRecorder.setAutoExtrapolation(false);
// History gateway: all SQLite reads in the main process are proxied to the
// ingestion worker via WorkerBridge.historyQuery() RPC (DB_REQUEST/DB_RESPONSE).
// The main process never opens the database itself.
flightRecorder.setHistoryGateway((op, args) => workerBridge.historyQuery(op, args));

// Request logger middleware
app.use('/api', (req, res, next) => {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] 🌐 ${req.method} ${req.originalUrl}`);
  next();
});

// Uniform internal-error responder: full error is logged server-side with the
// route path; clients only ever receive a generic message (no stack/SQL/key leaks).
function sendInternalError(req, res, err, extra = {}) {
  console.error(`[API] 500 on ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ success: false, error: 'Internal server error', ...extra });
}

// Centralized polymorphic line resolution via TrackerRegistry (src/core/TrackerRegistry.js)
function getTrackerForLine(lineId) {
  return trackerRegistry.getTrackerForLine(lineId);
}

function buildDefaultCalendarInfo(date = new Date()) {
  const dc = calendarEngine.getDateComponents(date, 'Europe/Madrid');
  const dayType = dc.isSunday ? 'Diumenge / Festiu' : (dc.isSaturday ? 'Dissabte' : 'Feiner');
  return {
    serviceId: dc.isWeekend ? 'weekend' : 'weekday',
    name: dayType,
    frequency: 'Cada 15-30 min',
    frequencyMinutes: 20,
    isWeekend: dc.isWeekend,
    calendarTag: `${dayType} (${dc.dateStr})`,
    dateFormatted: dc.dateStr
  };
}

function getCalendarInfoFor(tracker, date = new Date()) {
  try {
    if (tracker && typeof tracker.getServiceCalendarInfo === 'function') {
      return tracker.getServiceCalendarInfo(date);
    }
  } catch (_) {}
  return buildDefaultCalendarInfo(date);
}

// ==========================================
// CANONICAL SCHEMA HARMONIZATION (M3)
// Guarantees uniform JSON contracts across all 7 operator trackers
// while preserving dual-cased compatibility fields.
// ==========================================

// Canonical Vehicle payload with dual-cased compatibility fields
// (delayMinutes + delayMins, isRealTime + isRealtime, speedKmh + speed)
function standardizeVehicle(raw = {}) {
  const v = { ...(raw || {}) };

  const rawDelay = v.delayMinutes !== undefined ? v.delayMinutes : v.delayMins;
  const delay = Number.isFinite(Number(rawDelay)) ? Number(rawDelay) : 0;
  v.delayMinutes = delay;
  v.delayMins = delay;

  const isReal = v.isRealTime !== undefined ? Boolean(v.isRealTime)
    : (v.isRealtime !== undefined ? Boolean(v.isRealtime) : !v.isEstimated);
  v.isRealTime = isReal;
  v.isRealtime = isReal;

  const rawSpeed = v.speedKmh !== undefined ? v.speedKmh : v.speed;
  const speed = Number.isFinite(Number(rawSpeed)) ? Number(rawSpeed) : 0;
  v.speedKmh = speed;
  v.speed = speed;

  if (!v.lastUpdate) {
    v.lastUpdate = v.recordedAt || new Date().toISOString();
  }
  return v;
}

// Canonical Departure payload with dual-cased delay fields
function harmonizeDeparture(dep = {}) {
  const d = { ...(dep || {}) };

  const rawDelay = d.delayMinutes !== undefined ? d.delayMinutes : d.delayMins;
  const delay = Number.isFinite(Number(rawDelay)) ? Math.round(Number(rawDelay)) : 0;
  d.delayMinutes = delay;
  d.delayMins = delay;

  const isRealTime = Boolean(d.isRealTime !== undefined ? d.isRealTime : d.isRealtime);
  d.isRealTime = isRealTime;
  d.isRealtime = isRealTime;

  // Fill canonical status fields only when the tracker omitted them
  if (!d.delayStatus) {
    const evalStatus = delayEngine.computeDelayStatus(delay, isRealTime, {
      scheduledTime: d.scheduledTime || d.departureTime,
      isFirstOfDay: Boolean(d.isFirstOfDay),
      isNextService: Boolean(d.isNextService),
      isPassed: Boolean(d.isPassed),
      isEstimated: Boolean(d.isEstimated)
    });
    d.delayStatus = evalStatus.delayStatus;
    if (!d.delayBadgeText) d.delayBadgeText = evalStatus.delayBadgeText;
    if (!d.delayFormatted) d.delayFormatted = evalStatus.delayFormatted;
    if (!d.comparisonText) d.comparisonText = evalStatus.comparisonText;
  }
  if (!d.formattedStatus) d.formattedStatus = delayEngine.formatCountdownStatus(d.minutesAway);

  return d;
}

// Canonical Stop Departures envelope:
// { stopId, stopName, stop: { id, code, name, lat, lon, zone }, departures, totalDepartures, calendarInfo, lastUpdated }
function harmonizeDeparturesEnvelope(data, tracker, lineId) {
  if (!data || typeof data !== 'object') return data;

  const stopRaw = data.stop || {};
  const stopId = data.stopId || stopRaw.id || stopRaw.mouteStopId || stopRaw.gtfsStopId || null;
  const stopName = data.stopName || stopRaw.name || '';
  const departures = Array.isArray(data.departures) ? data.departures.map(harmonizeDeparture) : [];

  const stop = {
    id: stopRaw.id || stopId,
    code: stopRaw.code || stopRaw.gtfsStopId || stopId,
    name: stopName,
    zone: stopRaw.zone || 'Zona Transit'
  };
  if (stopRaw.lat !== undefined) stop.lat = stopRaw.lat;
  else if (typeof stopRaw.latitude === 'number') stop.lat = stopRaw.latitude;
  if (stopRaw.lon !== undefined) stop.lon = stopRaw.lon;
  else if (typeof stopRaw.longitude === 'number') stop.lon = stopRaw.longitude;

  return {
    ...data,
    lineId: data.lineId || String(lineId || ''),
    stopId,
    stopName,
    stop,
    departures,
    totalDepartures: typeof data.totalDepartures === 'number' ? data.totalDepartures : departures.length,
    calendarInfo: data.calendarInfo || getCalendarInfoFor(tracker),
    lastUpdated: data.lastUpdated || new Date().toISOString()
  };
}

// Canonical Target ETA envelope:
// { targetStop (flat coords + coords{lat,lon}), direction, directionName, nextBus, upcomingDepartures, allDepartures, calendarInfo, serviceStatus, lastUpdated }
function harmonizeTargetEta(data, tracker, lineId, direction) {
  if (!data || typeof data !== 'object') return data;

  const tsRaw = data.targetStop || {};
  const tsLat = tsRaw.lat !== undefined ? tsRaw.lat : (tsRaw.coords ? tsRaw.coords.lat : undefined);
  const tsLon = tsRaw.lon !== undefined ? tsRaw.lon : (tsRaw.coords ? tsRaw.coords.lon : undefined);
  const nestedCoords = { ...(tsRaw.coords || {}) };
  if (tsLat !== undefined) nestedCoords.lat = tsLat;
  if (tsLon !== undefined) nestedCoords.lon = tsLon;

  const targetStop = { ...tsRaw };
  if (tsLat !== undefined) targetStop.lat = tsLat;
  if (tsLon !== undefined) targetStop.lon = tsLon;
  if (nestedCoords.lat !== undefined || nestedCoords.lon !== undefined) targetStop.coords = nestedCoords;

  const upcoming = Array.isArray(data.upcomingDepartures)
    ? data.upcomingDepartures
    : (Array.isArray(data.allDepartures) ? data.allDepartures : []);
  const allDepartures = Array.isArray(data.allDepartures) ? data.allDepartures : upcoming;

  return {
    ...data,
    targetStop,
    direction: data.direction !== undefined ? String(data.direction) : String(direction || '0'),
    directionName: data.directionName || null,
    nextBus: data.nextBus ? harmonizeDeparture(data.nextBus) : null,
    upcomingDepartures: upcoming.map(harmonizeDeparture),
    allDepartures: allDepartures.map(harmonizeDeparture),
    calendarInfo: data.calendarInfo || getCalendarInfoFor(tracker),
    serviceStatus: data.serviceStatus || null,
    lastUpdated: data.lastUpdated || new Date().toISOString()
  };
}

// ==========================================
// 1. UNIVERSAL TRANSIT LINES & SEARCH
// ==========================================

// Canonical multi-provider line catalog via TrackerRegistry (4-tier deduplication + 60s TTL cache)
function getAllTransitLines() {
  return trackerRegistry.getAllLines();
}

// List all available transit lines across all providers
app.get('/api/lines', (req, res) => {
  const combinedLines = getAllTransitLines();

  res.json({
    success: true,
    totalLines: combinedLines.length,
    lines: combinedLines
  });
});

// Universal Stop & Line Searcher — delegates to TrackerRegistry.searchStopsAndLines(),
// the single shared search implementation across all registered providers.
// The dedicated C-10 corridor stops are supplemented here because corridorTracker
// keeps its own per-direction stop maps rather than a registry-searchable stopsMap.
const SEARCH_RESULT_LIMIT = 35;
app.get('/api/search/stops', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) {
    return res.json({ success: true, query: '', results: [] });
  }

  const results = trackerRegistry.searchStopsAndLines(q, SEARCH_RESULT_LIMIT);

  // Supplement: dedicated C-10 corridor stops
  if (results.length < SEARCH_RESULT_LIMIT) {
    const qLower = q.toLowerCase();
    const normQ = qLower.replace(/[-_\s.]/g, '');
    const seenStopIds = new Set(
      results.filter(r => r && r.type === 'stop').map(r => String(r.stopId))
    );
    outer: for (const dir of ['1', '0']) {
      const c10Stops = corridorTracker.getStops(dir) || [];
      for (const s of c10Stops) {
        if (results.length >= SEARCH_RESULT_LIMIT) break outer;
        if (!s) continue;
        const sName = String(s.name || '').toLowerCase();
        const sCode = String(s.code || '').toLowerCase();
        const stopKey = String(s.mouteStopId || s.gtfsStopId || s.id || '');
        const matches = sName.includes(qLower) ||
          sCode.includes(qLower) ||
          (stopKey && stopKey.toLowerCase().includes(normQ));
        if (!matches || seenStopIds.has(stopKey)) continue;
        seenStopIds.add(stopKey);
        results.push({
          type: 'stop',
          lineId: 'c10',
          lineCode: 'C-10',
          lineName: 'Barcelona ⇄ Mataró',
          lineColor: '#009485',
          stopId: stopKey,
          stopName: s.name,
          code: s.code,
          zone: s.lon >= 2.289 ? '🌊 Zona Maresme' : '🏙️ Zona AMB',
          lat: s.lat,
          lon: s.lon
        });
      }
    }
  }

  res.json({
    success: true,
    query: q,
    results
  });
});

// ==========================================
// 2. UNIVERSAL DYNAMIC LINE ENDPOINTS
// ==========================================

// ==========================================
// 2. UNIVERSAL DYNAMIC LINE ENDPOINTS
// ==========================================

// Get unified line details (stops, geometry, active vehicles) for any line
app.get('/api/line/:lineId', async (req, res) => {
  const { lineId } = req.params;
  const direction = req.query.direction || '0';
  const targetDate = req.query.date || null;
  try {
    const { type, tracker } = getTrackerForLine(lineId);
    if (type === 'c10') {
      const calInfo = corridorTracker.getServiceCalendarInfo(targetDate ? new Date(targetDate) : new Date());
      if (direction === 'both') {
        const tracking1 = await corridorTracker.getCorridorLiveTracking('1');
        const tracking0 = await corridorTracker.getCorridorLiveTracking('0');
        const stops1 = corridorTracker.getStops('1');
        const stops0 = corridorTracker.getStops('0');
        res.json({
          success: true,
          data: {
            id: 'c10',
            code: 'C-10',
            name: 'Barcelona ⇄ Mataró (per N-II)',
            color: '#009485',
            secondaryColor: '#38bdf8',
            agency: 'Moventis / Casas (Interurbà Maresme)',
            direction: 'both',
            directionName: 'Ambdós sentits (Barcelona ⇄ Mataró)',
            directions: [
              { dirId: '1', name: "Cap a Mataró (Hospital / Pl. d'Itàlia)" },
              { dirId: '0', name: "Cap a Barcelona (Metro la Pau)" }
            ],
            stops: stops1,
            coords: tracking1.routePolyline || [],
            geometrySource: tracking1.geometrySource || 'gtfs',
            geometryEstimated: Boolean(tracking1.geometryEstimated || tracking0.geometryEstimated),
            secondaryStops: stops0,
            secondaryCoords: tracking0.routePolyline || [],
            allDirections: [
              { dirId: '1', name: "Cap a Mataró (Hospital / Pl. d'Itàlia)", stops: stops1, coords: tracking1.routePolyline || [] },
              { dirId: '0', name: "Cap a Barcelona (Metro la Pau)", stops: stops0, coords: tracking0.routePolyline || [] }
            ],
            activeBuses: [ ...(tracking1.activeBuses || []), ...(tracking0.activeBuses || []) ],
            checkpoints: tracking1.checkpoints || [],
            totalVehiclesInCircuit: (tracking1.activeBuses?.length || 0) + (tracking0.activeBuses?.length || 0),
            calendarInfo: calInfo,
            serviceStatus: {
              isOperating: ((tracking1.activeBuses?.length || 0) + (tracking0.activeBuses?.length || 0)) > 0,
              firstServiceTomorrow: '06:45',
              calendarTag: calInfo.calendarTag
            },
            delayStats: await flightRecorder.getLineStats('C-10', 'c10')
          }
        });
      } else {
        const dir = direction === '0' ? '0' : '1';
        const tracking = await corridorTracker.getCorridorLiveTracking(dir);
        const stops = corridorTracker.getStops(dir);
        res.json({
          success: true,
          data: {
            id: 'c10',
            code: 'C-10',
            name: 'Barcelona ⇄ Mataró (per N-II)',
            color: '#009485',
            agency: 'Moventis / Casas (Interurbà Maresme)',
            direction: String(dir),
            directionName: dir === '1' ? "Cap a Mataró (Hospital / Pl. d'Itàlia)" : "Cap a Barcelona (Metro la Pau)",
            directions: [
              { dirId: '1', name: "Cap a Mataró (Hospital / Pl. d'Itàlia)" },
              { dirId: '0', name: "Cap a Barcelona (Metro la Pau)" }
            ],
            stops: stops,
            coords: tracking.routePolyline || [],
            geometrySource: tracking.geometrySource || 'gtfs',
            geometryEstimated: Boolean(tracking.geometryEstimated),
            activeBuses: tracking.activeBuses || [],
            checkpoints: tracking.checkpoints || [],
            totalVehiclesInCircuit: tracking.activeBuses?.length || 0,
            calendarInfo: calInfo,
            serviceStatus: {
              isOperating: (tracking.activeBuses?.length || 0) > 0,
              firstServiceTomorrow: dir === '1' ? '08:15' : '06:45',
              calendarTag: calInfo.calendarTag
            },
            delayStats: await flightRecorder.getLineStats('C-10', 'c10')
          }
        });
      }
    } else {
      const data = await tracker.getLineDetails(lineId, direction);
      if (data) {
        data.delayStats = await flightRecorder.getLineStats(data.code || lineId, lineId);
      }
      res.json({ success: true, data });
    }
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

// Get unified Target Stop ETA for any line
app.get('/api/line/:lineId/target-eta', async (req, res) => {
  const { lineId } = req.params;
  const direction = req.query.direction || '0';
  const stopId = req.query.stopId || null;
  const targetDate = req.query.date || null;
  try {
    const { type, tracker } = getTrackerForLine(lineId);
    if (type === 'c10') {
      const dir = direction === '0' ? '0' : '1';
      const data = await corridorTracker.getTargetStopETA(dir, stopId, targetDate);
      res.json({ success: true, data: harmonizeTargetEta(data, corridorTracker, lineId, dir) });
    } else {
      const data = await tracker.getTargetStopETA(lineId, stopId, direction);
      res.json({ success: true, data: harmonizeTargetEta(data, tracker, lineId, direction) });
    }
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

// Get canonical Live Vehicles for any line (uniform vehicle schema)
app.get('/api/line/:lineId/vehicles', async (req, res) => {
  const { lineId } = req.params;
  const direction = req.query.direction || '0';
  try {
    const { type, tracker, cleanCode, agency } = getTrackerForLine(lineId);
    let vehicles = flightRecorder.getLineVehicles(cleanCode || lineId);
    let details = null;

    if (!vehicles || vehicles.length === 0) {
      if (type === 'c10') {
        const dir = direction === '0' ? '0' : '1';
        details = await corridorTracker.getCorridorLiveTracking(dir);
      } else {
        details = await tracker.getLineDetails(lineId, direction);
      }
      vehicles = (details?.activeBuses || []).map(standardizeVehicle);
    } else {
      vehicles = vehicles.map(standardizeVehicle);
    }

    res.json({
      success: true,
      lineId,
      code: details?.code || cleanCode || String(lineId),
      name: details?.name || null,
      agency: details?.agency || agency || null,
      direction: String(direction),
      totalVehicles: vehicles.length,
      vehicles,
      lastUpdated: new Date().toISOString()
    });
  } catch (err) {
    sendInternalError(req, res, err, { totalVehicles: 0, vehicles: [] });
  }
});

// Get unified Live Telemetry & Vehicles for any line
app.get('/api/line/:lineId/live', async (req, res) => {
  const { lineId } = req.params;
  const direction = req.query.direction || '0';
  try {
    const { type, tracker } = getTrackerForLine(lineId);
    if (type === 'c10') {
      const dir = direction === '0' ? '0' : '1';
      const data = await corridorTracker.getCorridorLiveTracking(dir);
      res.json({ success: true, data });
    } else {
      const data = await tracker.getLineDetails(lineId, direction);
      res.json({ success: true, data });
    }
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

// Get unified Stop Departures for any line & stop
app.get('/api/line/:lineId/stop/:stopId/departures', async (req, res) => {
  const { lineId, stopId } = req.params;
  const direction = req.query.direction || '0';
  const targetDate = req.query.date || null;
  try {
    const { type, tracker } = getTrackerForLine(lineId);
    if (type === 'c10') {
      const dir = direction === '0' ? '0' : '1';
      const data = await corridorTracker.getStopDepartures(stopId, dir, targetDate);
      res.json({ success: true, data: harmonizeDeparturesEnvelope(data, corridorTracker, lineId) });
    } else {
      const data = await tracker.getStopDepartures(stopId, lineId, direction);
      res.json({ success: true, data: harmonizeDeparturesEnvelope(data, tracker, lineId) });
    }
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

// ==========================================
// 3. LEGACY ENDPOINTS (BACKWARDS COMPATIBILITY)
// ==========================================

// Target stop real-time ETA endpoint for C-10
app.get('/api/c10/target-eta', async (req, res) => {
  const direction = req.query.direction === '0' ? '0' : '1';
  const stopId = req.query.stopId || null;
  const targetDate = req.query.date || null;
  try {
    const data = await corridorTracker.getTargetStopETA(direction, stopId, targetDate);
    res.json({ success: true, data });
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

// All stops on C-10
app.get('/api/c10/stops', (req, res) => {
  const direction = req.query.direction === '0' ? '0' : '1';
  try {
    const stops = corridorTracker.getStops(direction);
    res.json({
      success: true,
      direction,
      totalStops: stops.length,
      stops
    });
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

// Real-time departures for any C-10 stop
app.get('/api/c10/stop/:stopId/departures', async (req, res) => {
  const { stopId } = req.params;
  const direction = req.query.direction === '0' ? '0' : '1';
  const targetDate = req.query.date || null;
  try {
    const data = await corridorTracker.getStopDepartures(stopId, direction, targetDate);
    res.json({ success: true, data });
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

// Live Corridor Tracking & Active Buses across checkpoints for C-10
app.get('/api/c10/live-corridor', async (req, res) => {
  const direction = req.query.direction === '0' ? '0' : '1';
  try {
    const data = await corridorTracker.getCorridorLiveTracking(direction);
    res.json({ success: true, data });
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

// List of all Mataró urban lines
app.get('/api/mataro/lines', (req, res) => {
  const lines = mataroTracker.getLines();
  res.json({ success: true, lines });
});

// Get Line details (stops, polyline geometry, and active buses with dead-zone estimation)
app.get('/api/mataro/line/:lineId', async (req, res) => {
  const { lineId } = req.params;
  const direction = req.query.direction === 'both' ? 'both' : (req.query.direction === '1' ? '1' : '0');
  try {
    const data = await mataroTracker.getLineDetails(lineId, direction);
    res.json({ success: true, data });
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

// Target stop real-time countdown & departures for Mataró Bus line
app.get('/api/mataro/target-eta', async (req, res) => {
  const lineId = req.query.lineId || '1';
  const stopId = req.query.stopId || null;
  const direction = req.query.direction === '1' ? '1' : '0';
  try {
    const data = await mataroTracker.getTargetStopETA(lineId, stopId, direction);
    res.json({ success: true, data });
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

// Real-time departures for any Mataró Bus stop
app.get('/api/mataro/stop/:stopId/departures', async (req, res) => {
  const { stopId } = req.params;
  const lineId = req.query.lineId || '';
  try {
    const data = await mataroTracker.getStopDepartures(stopId, lineId);
    res.json({ success: true, data });
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

// ==========================================
// 4. API CONNECTION DIAGNOSTICS & HEALTH
// ==========================================

// Diagnostic test for current line's upstream API
app.get('/api/diagnostics/test', async (req, res) => {
  const lineId = req.query.lineId || 'c10';
  const start = Date.now();

  // Tracker resolution happens INSIDE structured handling: an unknown line
  // (the registry throws for unresolved IDs) must become a JSON 404 instead
  // of escaping this handler as an unhandled rejection.
  let type;
  let tracker;
  try {
    const resolution = getTrackerForLine(lineId);
    if (!resolution || !resolution.tracker) {
      return res.status(404).json({ success: false, error: 'Unknown line' });
    }
    type = resolution.type;
    tracker = resolution.tracker;
  } catch (err) {
    console.error(`[API] 404 on GET ${req.originalUrl} (lineId=${lineId}):`, err.message);
    return res.status(404).json({ success: false, error: 'Unknown line' });
  }
  const providerMeta = {
    c10: {
      provider: 'Generalitat de Catalunya (Mou-te / ATM)',
      host: 'moute.gencat.cat',
      auth: 'HMAC-MD5 Token Authentication',
      type: 'REST JSON / Nexus NextDepartures'
    },
    maresme: {
      provider: 'Moventis / Casas (Generalitat Mou-te & ATM)',
      host: 'moute.gencat.cat',
      auth: 'HMAC-MD5 Token Authentication',
      type: 'REST JSON / Nexus NextDepartures'
    },
    mataro: {
      provider: 'Mataró Bus Urbà (Avanza SIRI Gateway)',
      host: 'sirimataro.avanzagrupo.com',
      auth: 'SIRI-Lite Protocol',
      type: 'SOAP / XML VehicleMonitoring'
    },
    sagales: {
      provider: 'Sagalés Real-Time Web Service',
      host: 'www.sagales.com',
      auth: 'Direct JSON Telemetry',
      type: 'REST JSON Vehicle Entities'
    },
    amb: {
      provider: 'Àrea Metropolitana de Barcelona (AMB Mobilitat)',
      host: 'api.ambmobilitat.cat',
      auth: 'API Key Header (x-api-key)',
      type: 'REST JSON v2 GTFS & Realtime'
    },
    rodalies: {
      provider: 'Renfe Rodalies de Catalunya (AMB Mobilitat)',
      host: 'api.ambmobilitat.cat',
      auth: 'API Key Header (x-api-key)',
      type: 'REST JSON v2 GTFS-RT'
    }
  }[type] || {
    provider: 'AMB Mobilitat',
    host: 'api.ambmobilitat.cat',
    auth: 'API Key Header',
    type: 'REST API'
  };

  try {
    let result = null;
    if (type === 'c10') {
      result = await corridorTracker.getCorridorLiveTracking('1');
    } else {
      result = await tracker.getLineDetails(lineId, '0');
    }
    const latencyMs = Date.now() - start;
    const activeVehicles = result?.activeBuses?.length || result?.totalActiveBuses || 0;

    res.json({
      success: true,
      lineId,
      provider: providerMeta.provider,
      host: providerMeta.host,
      auth: providerMeta.auth,
      type: providerMeta.type,
      latencyMs,
      status: latencyMs > 3000 ? 'slow' : 'online',
      statusCode: 200,
      activeVehicles,
      message: `Connexió correcta amb ${providerMeta.host} (${latencyMs}ms). ${activeVehicles} vehicle${activeVehicles === 1 ? '' : 's'} actiu${activeVehicles === 1 ? '' : 's'}.`,
      testedAt: new Date().toLocaleTimeString('ca-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    });
  } catch (err) {
    console.error(`[API] Diagnostics upstream failure on ${req.originalUrl} (lineId=${lineId}):`, err);
    const latencyMs = Date.now() - start;
    res.json({
      success: false,
      lineId,
      provider: providerMeta.provider,
      host: providerMeta.host,
      auth: providerMeta.auth,
      type: providerMeta.type,
      latencyMs,
      status: 'offline',
      statusCode: 502,
      error: err.message,
      message: `Error en connectar amb ${providerMeta.host}: ${err.message}`,
      testedAt: new Date().toLocaleTimeString('ca-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    });
  }
});

// Live Transit Disruptions & Service Alerts API
app.get('/api/disruptions', async (req, res) => {
  try {
    const lineCode = req.query.line || null;
    const disruptions = await ambTracker.getDisruptions(lineCode);
    res.json({
      success: true,
      count: disruptions.length,
      disruptions
    });
  } catch (err) {
    sendInternalError(req, res, err, { disruptions: [] });
  }
});

// ==========================================
// 4. CENTRALIZED FLIGHT RECORDER & JOURNALISM ANALYTICS
// ==========================================

// Global fleet snapshot across all monitored lines in Catalonia
app.get('/api/fleet/live', (req, res) => {
  const vehicles = flightRecorder.getAllVehicles();
  res.json({
    success: true,
    count: vehicles.length,
    timestamp: Date.now(),
    vehicles
  });
});

// Canonical Global Live Vehicles API (uniform vehicle schema with dual-cased compatibility fields)
app.get('/api/vehicles', (req, res) => {
  const lineFilter = req.query.line ? String(req.query.line).toUpperCase() : null;
  let vehicles = flightRecorder.getAllVehicles();
  if (lineFilter) {
    vehicles = vehicles.filter(v => String(v.lineCode || '').toUpperCase() === lineFilter);
  }
  const standardized = vehicles.map(standardizeVehicle);
  res.json({
    success: true,
    count: standardized.length,
    timestamp: Date.now(),
    vehicles: standardized
  });
});

// GPS breadcrumb trail history for a specific vehicle.
// Trail reads are proxied to the worker's SQLite history via the history gateway.
app.get('/api/vehicle/:vehicleId/trail', async (req, res) => {
  const { vehicleId } = req.params;
  try {
    const trail = await flightRecorder.getVehicleTrail(vehicleId);
    res.json({
      success: true,
      vehicleId,
      pointsCount: trail.length,
      trail
    });
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

// Real-time & 24h delay statistics and punctuality score for a line.
// Stats reads are proxied to the worker's SQLite history via the history gateway.
app.get('/api/line/:lineId/stats', async (req, res) => {
  const { lineId } = req.params;
  const cleanCode = lineId.replace('cat_gen_', '').replace(/.*_/, '').toUpperCase();
  try {
    const stats = await flightRecorder.getLineStats(cleanCode, lineId);
    res.json({
      success: true,
      lineId,
      lineCode: cleanCode,
      stats
    });
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

// Shared Journalism Report handler (Instant Cache & 30-min background generation)

// Coalesces concurrent cold-miss generations per timeframe so a request burst
// triggers ONE worker RPC instead of N, and warms the memory cache with the result.
const inFlightReportGeneration = new Map(); // canonicalHours -> Promise<report|null>

// Memoized serialization: identical report object => identical JSON body.
// Avoids re-stringifying a ~750KB report on every request during bursts
// (event-loop head-of-line blocking for all other endpoints).
const serializedReportBodies = new WeakMap();
function sendReportResponse(res, report) {
  let body = serializedReportBodies.get(report);
  if (body === undefined) {
    body = JSON.stringify({ success: true, report });
    serializedReportBodies.set(report, body);
  }
  res.set('Content-Type', 'application/json').send(body);
}
function generateReportViaWorker(canonicalHours) {
  if (inFlightReportGeneration.has(canonicalHours)) {
    return inFlightReportGeneration.get(canonicalHours);
  }
  const promise = workerBridge.historyQuery(
    'generateReport',
    { hours: canonicalHours },
    { timeoutMs: 30000 }
  )
    .then((report) => {
      if (report && report.summary) {
        reportCacheService.updateMemoryCache(canonicalHours, report);
      }
      return report;
    })
    .catch(() => null)
    .finally(() => inFlightReportGeneration.delete(canonicalHours));
  inFlightReportGeneration.set(canonicalHours, promise);
  return promise;
}

async function handleJournalismReport(req, res) {
  try {
    const canonicalHours = reportCacheService.normalizeHours(parseInt(req.query.hours || '24', 10));
    // Memory-cache hit first (never generates in main); null on miss.
    let report = await reportCacheService.getLatestReport(canonicalHours, () => getAllTransitLines());
    if (!report) {
      // Cache miss: coalesced RPC (one generation per timeframe under bursts).
      report = await generateReportViaWorker(canonicalHours);
    }
    if (!report) {
      return res.status(503).json({ success: false, error: 'Report warming up — try again shortly' });
    }
    sendReportResponse(res, report);
  } catch (err) {
    sendInternalError(req, res, err);
  }
}

// Shared CSV Export handler for spreadsheet / investigative journalism analysis
async function handleAnalyticsCsv(req, res) {
  const hours = parseInt(req.query.hours || '48', 10);
  try {
    // CSV export reads the worker's SQLite delay logs through the history gateway.
    const csvData = await flightRecorder.exportCsv(hours);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="arribo_transit_delays_${Date.now()}.csv"`);
    res.send(csvData);
  } catch (err) {
    sendInternalError(req, res, err);
  }
}

// Shared Delay Ranking handler (canonical delay rankings across lines & stops)
async function handleRankingReport(req, res) {
  try {
    const canonicalHours = reportCacheService.normalizeHours(parseInt(req.query.hours || '24', 10));
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '25', 10)));
    // Memory-cache hit first (never generates in main); null on miss.
    let report = await reportCacheService.getLatestReport(canonicalHours, () => getAllTransitLines());
    if (!report) {
      // Cache miss: coalesced RPC (one generation per timeframe under bursts).
      report = await generateReportViaWorker(canonicalHours);
    }
    if (!report) {
      return res.status(503).json({ success: false, error: 'Report warming up — try again shortly' });
    }
    res.json({
      success: true,
      timeframeHours: report?.meta?.timeframeHours || canonicalHours,
      generatedAt: report?.meta?.generatedAt || null,
      summary: report?.summary || {},
      rankingMostDelayed: (report?.rankingMostDelayed || []).slice(0, limit),
      rankingBestPunctuality: (report?.rankingBestPunctuality || []).slice(0, limit),
      rankingWorstStops: (report?.rankingWorstStops || []).slice(0, limit),
      agencyStats: report?.agencyStats || []
    });
  } catch (err) {
    sendInternalError(req, res, err);
  }
}

// Journalism Investigation Report across all lines & operators
app.get('/api/analytics/journalism', handleJournalismReport);

// Canonical Catalan alias namespace (/api/retards/*) mirroring /api/analytics/*
app.get('/api/retards/journalism', handleJournalismReport);
app.get('/api/retards/export/csv', handleAnalyticsCsv);
app.get('/api/retards/ranking', handleRankingReport);

// CSV Export for spreadsheet / investigative journalism analysis
app.get('/api/analytics/export/csv', handleAnalyticsCsv);

// Delay Ranking endpoint (mirrored at /api/retards/ranking)
app.get('/api/analytics/ranking', handleRankingReport);

// ==========================================
// 5. DAILY ROUTE SNAPSHOTS & 3-DAY RETENTION
// ==========================================

// Get list of daily route snapshots and change metadata (maintained for the last 3 days)
app.get('/api/routes/snapshots', (req, res) => {
  try {
    const snapshots = routeCacheService.getSnapshotsList();
    const diff = routeCacheService.get3DayDiff();
    res.json({
      success: true,
      retentionDays: 3,
      totalSnapshots: snapshots.length,
      snapshots,
      diff
    });
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

// Get full route snapshot for a specific date
app.get('/api/routes/snapshots/:date', (req, res) => {
  try {
    const { date } = req.params;
    const snapshot = routeCacheService.getSnapshotByDate(date);
    if (!snapshot) {
      return res.status(404).json({ success: false, error: `Snapshot for date ${date} not found or pruned (retained for 3 days).` });
    }
    res.json({ success: true, snapshot });
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

// Get 3-day changes and route topology diffs
app.get('/api/routes/diff', (req, res) => {
  try {
    const diff = routeCacheService.get3DayDiff();
    res.json({ success: true, diff });
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

app.get('/api/health', (req, res) => {
  let appVersion = '2.0.0';
  try {
    appVersion = require('./package.json').version;
  } catch (_) {}
  res.json({
    status: 'ok',
    app: 'Arribo!',
    version: appVersion,
    description: 'Universal Realtime Bus Telemetry & Schedule Platform for Catalonia',
    timestamp: new Date().toISOString(),
    worker: workerBridge.getStatus()
  });
});

// Unknown /api/* paths must return a proper JSON 404 (never the SPA HTML),
// so API consumers and the frontend can distinguish "no such endpoint" reliably.
app.use('/api', (req, res) => {
  res.status(404).json({ success: false, error: `Not found: ${req.method} ${req.originalUrl}` });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  const runningServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`====================================================`);
    console.log(`🚌 Arribo! Transit Telemetry Platform Running!`);
    console.log(`🌐 Full Catalonia Multi-Provider Realtime Bus Network`);
    console.log(`📍 Local URL: http://localhost:${PORT}`);
    console.log(`====================================================`);
  });

  const gracefulShutdown = async (signal) => {
    console.log(`[Server] Received ${signal}. Shutting down gracefully...`);
    try {
      if (typeof workerBridge.stop === 'function') {
        await workerBridge.stop();
      } else if (typeof workerBridge.shutdown === 'function') {
        await workerBridge.shutdown();
      }
    } catch (e) {
      console.error('[Server] WorkerBridge shutdown error:', e.message);
    }
    runningServer.close(() => {
      console.log('[Server] HTTP server closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

module.exports = app;
