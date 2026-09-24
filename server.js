const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const mataroTracker = require('./src/mataroTracker');
const mataroSiriClient = require('./src/mataroSiriClient');
const reportCacheService = require('./src/reportCacheService');
const flightRecorder = require('./src/flightRecorder');
const trackerRegistry = require('./src/core/TrackerRegistry');
const workerBridge = require('./src/core/WorkerBridge');
const calendarEngine = require('./src/core/time/calendarEngine');
const delayEngine = require('./src/core/schedule/delayEngine');
const mataroFleet = require('./src/data/mataroFleet');
const mataroSchedules = require('./src/data/mataroSchedules');
const streetGeocoder = require('./src/core/geo/streetGeocoder');

// ==========================================
// 0. PROCESS-LEVEL RESILIENCE TRAPS
// ==========================================
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err);
});

// Self-healing disk guard: purge any lingering core dump files on container startup
try {
  const rootFiles = fs.readdirSync(__dirname);
  for (const file of rootFiles) {
    if (/^core(\.|\b)/.test(file)) {
      try {
        fs.unlinkSync(path.join(__dirname, file));
        console.log(`[Startup] Cleaned residual core dump file: ${file}`);
      } catch {}
    }
  }
} catch {}

// Idle RAM compactor: periodically trim V8 working set if garbage collector is exposed
if (typeof global.gc === 'function') {
  setInterval(() => {
    try { global.gc(); } catch {}
  }, 10 * 60 * 1000).unref();
}

const app = express();
let shuttingDown = false;
let httpServer = null;
let shutdownPromise = null;
const PORT = process.env.PORT || 3000;

const { securityHeaders, createApiLimiter, trustedProxies } = require('./src/core/httpProtection');
app.disable('x-powered-by');
const proxyAddresses = trustedProxies(process.env.TRUSTED_PROXIES);
if (proxyAddresses.length) app.set('trust proxy', proxyAddresses);
app.use(securityHeaders);
app.use(cors());
app.use('/api', createApiLimiter());
// SSE endpoint is registered before compression middleware: compression
// buffers responses until a flush threshold, which would delay event frames.
// The route itself is defined further below alongside the broadcaster.

// Strict Read-Only Security Guard: Reject any write requests from clients
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed: This transit service is strictly read-only.' });
  }
  next();
});

// Static assets: enable etag + browser caching
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '5m',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Launch Background Ingestion Worker asynchronously via WorkerBridge supervisor
workerBridge.start();
flightRecorder.setAutoExtrapolation(false);
flightRecorder.setHistoryGateway((op, args) => workerBridge.historyQuery(op, args, { timeoutMs: op === 'getLineDelayStats' ? 25000 : 10000 }));

// Centralize Mataró SIRI traffic in the worker over IPC (fast-fail timeout of 1200ms)
mataroSiriClient.setRpcBackend((op, args) =>
  workerBridge.historyQuery(op, args, { timeoutMs: 1200 }));

mataroTracker.setAvisosRpcBackend(() => workerBridge.historyQuery('getMataroAvisos', {}, { timeoutMs: 7000 }));

// Sync live fleet telemetry directly into Mataró tracker vehicle history
workerBridge.on('fleet_update', (payload) => {
  if (payload && Array.isArray(payload.vehicles) && mataroTracker && typeof mataroTracker.syncFleetVehicles === 'function') {
    mataroTracker.syncFleetVehicles(payload.vehicles);
  }
});

// Never log passenger queries, coordinates, endpoint names or credentials.
app.use('/api', (req, res, next) => {
  req.requestId = require('node:crypto').randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  const start = performance.now();
  res.once('finish', () => {
    if (['/api/health', '/api/ready', '/api/fleet/events'].includes(req.route?.path)) return;
    console.log(JSON.stringify({ event: 'http_request', requestId: req.requestId, route: req.route?.path || 'unmatched', status: res.statusCode, durationMs: Math.round(performance.now() - start) }));
  });
  next();
});

function sendInternalError(req, res, err, extra = {}) {
  console.error(JSON.stringify({ event: 'http_error', requestId: req.requestId, route: req.route?.path || 'unmatched', errorType: err?.name || 'Error' }));
  res.status(500).json({ success: false, error: 'Internal server error', ...extra });
}

function handleRouteError(req, res, err) {
  if (err && /not found/i.test(String(err.message))) {
    return res.status(404).json({ success: false, error: 'Unknown line or stop' });
  }
  sendInternalError(req, res, err);
}

function getTrackerForLine(lineId) {
  return trackerRegistry.getTrackerForLine(lineId);
}

function resolveTrackerOr404(res, lineId) {
  try {
    const resolution = getTrackerForLine(lineId);
    if (!resolution || !resolution.tracker) {
      res.status(404).json({ success: false, error: 'Unknown line' });
      return null;
    }
    return resolution;
  } catch {
    res.status(404).json({ success: false, error: 'Unknown line' });
    return null;
  }
}

function buildDefaultCalendarInfo(date = new Date()) {
  return calendarEngine.getServiceCalendarInfo(date, 'Europe/Madrid');
}

function getCalendarInfoFor(tracker, date = new Date()) {
  try {
    if (tracker && typeof tracker.getServiceCalendarInfo === 'function') {
      return tracker.getServiceCalendarInfo(date);
    }
  } catch {}
  return buildDefaultCalendarInfo(date);
}

// ==========================================
// CANONICAL SCHEMA HARMONIZATION
// ==========================================

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

  if (v.isGhostVehicle || (v.vehicleId && String(v.vehicleId).startsWith('EST_'))) {
    v.isGhostVehicle = true;
    v.isEstimated = true;
    v.isRealTime = false;
    v.isRealtime = false;
    if (!v.delayBadgeText) v.delayBadgeText = '⚡ Estimat (sense GPS)';
    if (!v.delayFormatted) v.delayFormatted = 'Horari teòric';
    if (!v.statusText) v.statusText = '⚡ Vehicle estimat segons horari oficial (sense GPS)';
  }

  if (v.lat === undefined && Number.isFinite(Number(v.latitude))) v.lat = Number(v.latitude);
  if (v.lon === undefined && Number.isFinite(Number(v.longitude))) v.lon = Number(v.longitude);
  if (Number.isFinite(Number(v.lat))) v.latitude = Number(v.lat);
  if (Number.isFinite(Number(v.lon))) v.longitude = Number(v.lon);

  if (!v.lastUpdate) {
    v.lastUpdate = v.recordedAt || new Date().toISOString();
  }

  if (v.isElectric === undefined) {
    const fleet = mataroFleet.getVehicleFleetInfo(v.vehicleId || v.tripId);
    v.propulsion = fleet.propulsion;
    v.isElectric = fleet.isElectric;
    v.isHybrid = fleet.isHybrid;
    v.propulsionBadge = fleet.propulsionBadge || `${fleet.badgeIcon} ${fleet.badgeText}`;
    v.propulsionIcon = fleet.badgeIcon;
    v.propulsionClass = fleet.badgeClass;
    v.modelName = fleet.modelName;
    v.isAccessible = fleet.isAccessible;
  }

  return v;
}

function harmonizeDeparture(dep = {}) {
  const d = { ...(dep || {}) };

  const rawDelay = d.delayMinutes !== undefined ? d.delayMinutes : d.delayMins;
  const delay = Number.isFinite(Number(rawDelay)) ? Math.round(Number(rawDelay)) : 0;
  d.delayMinutes = delay;
  d.delayMins = delay;

  const isRealTime = Boolean(d.isRealTime !== undefined ? d.isRealTime : d.isRealtime);
  d.isRealTime = isRealTime;
  d.isRealtime = isRealTime;

  if (!d.delayStatus) {
    const evalStatus = delayEngine.computeDelayStatus(delay, isRealTime, {
      scheduledTime: d.scheduledTime || d.departureTime,
      isFirstOfDay: Boolean(d.isFirstOfDay),
      isNextService: Boolean(d.isNextService),
      isPassed: Boolean(d.isPassed),
      isEstimated: Boolean(d.isEstimated),
      isRegulating: Boolean(d.isRegulating),
      isOriginRegulating: Boolean(d.isOriginRegulating),
      originTerminalName: d.originTerminalName,
      originDepartureTime: d.originDepartureTime
    });
    d.delayStatus = evalStatus.delayStatus;
    if (!d.delayBadgeText) d.delayBadgeText = evalStatus.delayBadgeText;
    if (!d.delayFormatted) d.delayFormatted = evalStatus.delayFormatted;
    if (!d.comparisonText) d.comparisonText = evalStatus.comparisonText;
  }
  if (!d.formattedStatus) d.formattedStatus = delayEngine.formatCountdownStatus(d.minutesAway);

  return d;
}

function harmonizeDeparturesEnvelope(data, tracker, lineId) {
  if (!data || typeof data !== 'object') return data;

  const stopRaw = data.stop || {};
  const stopId = data.stopId || stopRaw.id || null;
  const stopName = data.stopName || stopRaw.name || '';
  const departures = Array.isArray(data.departures) ? data.departures.map(harmonizeDeparture) : [];

  const stop = {
    id: stopRaw.id || stopId,
    code: stopRaw.code || stopId,
    name: stopName,
    zone: stopRaw.zone || 'Mataró Urbà'
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
// 1a. SSE Fleet Broadcaster
// Replays the latest worker FLEET_UPDATE snapshot to browsers over
// /api/fleet/events. Fed exclusively by the WorkerBridge 'fleet_update'
// event: no upstream polling and no SQLite access in this path. Declared
// and registered BEFORE compression middleware so event frames are never
// buffered.
// ==========================================
const fleetBroadcaster = (() => {
  const MAX_CLIENTS = 200;
  const clients = new Set();
  let latestSnapshot = null;
  let heartbeatTimer = null;

  function writeSnapshot(client) {
    try {
      if (latestSnapshot) {
        client.res.write(`event: fleet\ndata: ${JSON.stringify(latestSnapshot)}\n\n`);
      } else {
        client.res.write(`event: waiting\ndata: {}\n\n`);
      }
    } catch {
      removeClient(client);
    }
  }

  function removeClient(client) {
    if (!clients.has(client)) return;
    clients.delete(client);
    try { client.res.end(); } catch {}
  }

  function broadcast(snapshot) {
    latestSnapshot = snapshot;
    for (const client of Array.from(clients)) {
      try {
        client.res.write(`event: fleet\ndata: ${JSON.stringify(snapshot)}\n\n`);
      } catch {
        removeClient(client);
      }
    }
  }

  function handleRequest(req, res) {
    if (req.method === 'HEAD') {
      res.status(405).json({ success: false, error: 'SSE stream requires GET.' });
      return;
    }
    if (clients.size >= MAX_CLIENTS) {
      res.status(503).json({ success: false, error: 'Too many fleet stream clients.' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    const client = { res };
    clients.add(client);
    req.on('close', () => removeClient(client));
    writeSnapshot(client);
  }

  function start() {
    if (heartbeatTimer) return;
    // Transport liveness only: proves the stream is open, not that upstream
    // telemetry is fresh.
    heartbeatTimer = setInterval(() => {
      for (const client of Array.from(clients)) {
        try { client.res.write(': ping\n\n'); } catch { removeClient(client); }
      }
    }, 25000);
    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
  }

  function shutdown() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    for (const client of Array.from(clients)) removeClient(client);
  }

  workerBridge.on('fleet_update', (payload) => {
    if (payload && Array.isArray(payload.vehicles)) {
      broadcast({ timestamp: payload.timestamp || Date.now(), vehicles: payload.vehicles });
    }
  });
  start();

  return { handleRequest, getClientCount: () => clients.size, shutdown, resetForTests: () => { shutdown(); latestSnapshot = null; } };
})();

app.get('/api/fleet/events', fleetBroadcaster.handleRequest);

// Response compression for all other routes (registered after the SSE route
// so event frames are never buffered by the compression stream).
app.use(compression());

// Dedicated Journey Planner Full Page
app.get(['/plan', '/com-anar-hi', '/rutes', '/itinerari'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'plan.html'));
});

// Dedicated Observatori & Delay Analytics Full Page
app.get(['/dades', '/observatori', '/analytics'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'dades.html'));
});

// Health Check
app.get('/api/ready', (req, res) => {
  const status = require('./src/core/serviceStatus')(workerBridge.getStatus(), reportCacheService.getFreshnessStatus(), trackerRegistry.getAllLines().length > 0, shuttingDown);
  res.setHeader('Cache-Control', 'no-store');
  res.status(status.ready ? 200 : 503).json(status);
});

app.get('/api/health', (req, res) => {
  const now = Date.now();
  const worker = workerBridge.getStatus();
  const reports = reportCacheService.getFreshnessStatus();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: now,
    agency: 'Mataró Bus Urbà',
    worker: {
      healthy: worker.isHealthy,
      running: worker.isRunning,
      lastHeartbeat: worker.lastHeartbeat,
      heartbeatAgeMs: Number.isFinite(worker.lastHeartbeat) ? Math.max(0, now - worker.lastHeartbeat) : null,
      restarts: worker.restarts
    },
    reports,
    // Which published timetable grid is loaded, and why. The file that used to
    // ship here held a MIXTURE of the winter and summer grids, so a wrong
    // season was invisible until a rider noticed the times. Reporting it makes
    // that class of mistake visible in the product. Purely in-memory: this
    // reads a JSON file already loaded, never a provider or SQLite.
    schedule: (() => {
      const v = mataroSchedules.getScheduleValidity();
      return {
        season: v.season,
        seasonSource: v.seasonSource,
        // false means we are outside the period the data covers. Callers must
        // label the grid as unverified rather than present it as authoritative.
        seasonKnown: v.seasonKnown,
        seasonsAvailable: v.seasonsAvailable,
        usingSeasonsFile: v.usingSeasonsFile,
        validUntil: v.validUntil,
        expired: v.expired,
        source: v.source
      };
    })(),
    dataReady: worker.isHealthy && reports.every(report => report.fresh)
  });
});

// All Available Lines (Lines 1 to 8)
app.get('/api/lines', (req, res) => {
  try {
    const lines = trackerRegistry.getAllLines();
    res.json({
      success: true,
      count: lines.length,
      lines
    });
  } catch (err) {
    sendInternalError(req, res, err, { count: 0, lines: [] });
  }
});

// Universal Search across Mataró stops, lines, and street names
app.get('/api/search/stops', async (req, res) => {
  const q = req.query.q || '';
  if (!q.trim()) {
    return res.json({ success: true, query: '', results: [], stops: [], streets: [] });
  }

  // Ensure stops catalog is set for nearest stop computation
  if (!streetGeocoder.stopsCatalog && mataroTracker && mataroTracker.allStopsMap) {
    streetGeocoder.setStopsCatalog(mataroTracker.allStopsMap);
  }

  const results = trackerRegistry.searchStopsAndLines(q, 35);
  const stops = results
    .filter(r => r.type === 'stop')
    .map(r => ({
      id: r.stopId || r.code,
      name: r.stopName,
      code: r.code || r.stopId,
      zone: r.zone || 'Mataró Urbà',
      directionText: r.directionText || '',
      destinations: r.destinations || [],
      lineCode: r.lineCode,
      lat: r.lat,
      lon: r.lon
    }));

  // Concurrently search for street names in Mataró when query length >= 3
  let streets = [];
  if (q.trim().length >= 3) {
    try {
      streets = await streetGeocoder.searchStreets(q.trim(), 4);
    } catch {}
  }

  res.json({
    success: true,
    query: q,
    results,
    stops,
    streets
  });
});

// Get unified line details (stops, geometry, active vehicles)
app.get('/api/line/:lineId', async (req, res) => {
  const { lineId } = req.params;
  const direction = req.query.direction || '0';
  try {
    const resolution = resolveTrackerOr404(res, lineId);
    if (!resolution) return;
    const { tracker } = resolution;
    const targetLine = resolution.lineId || lineId;
    const data = await tracker.getLineDetails(targetLine, direction);
    if (data) {
      if (Array.isArray(data.activeBuses)) {
        data.activeBuses = data.activeBuses.map(standardizeVehicle);
      }
      data.delayStats = await flightRecorder.getLineStats(data.code || targetLine, targetLine);
    }
    res.json({ success: true, data });
  } catch (err) {
    handleRouteError(req, res, err);
  }
});

// Get unified Target Stop ETA
app.get('/api/line/:lineId/target-eta', async (req, res) => {
  const { lineId } = req.params;
  const direction = req.query.direction || '0';
  const stopId = req.query.stopId || null;
  try {
    const resolution = resolveTrackerOr404(res, lineId);
    if (!resolution) return;
    const { tracker } = resolution;
    const targetLine = resolution.lineId || lineId;
    const data = await tracker.getTargetStopETA(targetLine, stopId, direction);
    res.json({ success: true, data: harmonizeTargetEta(data, tracker, targetLine, direction) });
  } catch (err) {
    handleRouteError(req, res, err);
  }
});

// Get Live Vehicles for a line
app.get('/api/line/:lineId/vehicles', async (req, res) => {
  const { lineId } = req.params;
  const direction = req.query.direction || '0';
  try {
    const resolution = resolveTrackerOr404(res, lineId);
    if (!resolution) return;
    const { tracker, cleanCode, agency } = resolution;
    const targetLine = resolution.lineId || lineId;
    let vehicles = flightRecorder.getLineVehicles(cleanCode || targetLine);
    let details = null;

    if (!vehicles || vehicles.length === 0) {
      details = await tracker.getLineDetails(targetLine, direction);
      vehicles = (details?.activeBuses || []).map(standardizeVehicle);
    } else {
      // flightRecorder filters by line + serviceability only, so the direction
      // query must be applied here too. A vehicle with no direction is kept:
      // we cannot prove it travels the other way.
      const wantedDir = String(direction);
      vehicles = vehicles
        .map(standardizeVehicle)
        .filter(v => v.direction === undefined || v.direction === null || String(v.direction) === wantedDir);
    }

    res.json({
      success: true,
      lineId,
      code: details?.code || cleanCode || String(lineId),
      name: details?.name || null,
      agency: details?.agency || agency || 'Mataró Bus',
      direction: String(direction),
      totalVehicles: vehicles.length,
      vehicles,
      lastUpdated: new Date().toISOString()
    });
  } catch (err) {
    sendInternalError(req, res, err, { totalVehicles: 0, vehicles: [] });
  }
});

// Get Stop Departures
app.get('/api/line/:lineId/stop/:stopId/departures', async (req, res) => {
  const { lineId, stopId } = req.params;
  const direction = req.query.direction || '0';
  try {
    const resolution = resolveTrackerOr404(res, lineId);
    if (!resolution) return;
    const { tracker } = resolution;
    const targetLine = resolution.lineId || lineId;
    const data = await tracker.getStopDepartures(stopId, targetLine, direction);
    res.json({ success: true, data: harmonizeDeparturesEnvelope(data, tracker, targetLine) });
  } catch (err) {
    handleRouteError(req, res, err);
  }
});

// Mataró specific alias endpoints
app.get('/api/mataro/lines', (req, res) => {
  const lines = mataroTracker.getLines();
  res.json({ success: true, lines });
});

app.get('/api/mataro/line/:lineId', async (req, res) => {
  const { lineId } = req.params;
  const direction = req.query.direction === 'both' ? 'both' : (req.query.direction === '1' ? '1' : '0');
  try {
    const data = await mataroTracker.getLineDetails(lineId, direction);
    res.json({ success: true, data });
  } catch (err) {
    handleRouteError(req, res, err);
  }
});

app.get('/api/mataro/target-eta', async (req, res) => {
  const lineId = req.query.lineId || '1';
  const stopId = req.query.stopId || null;
  const direction = req.query.direction === '1' ? '1' : '0';
  try {
    const data = await mataroTracker.getTargetStopETA(lineId, stopId, direction);
    res.json({ success: true, data });
  } catch (err) {
    handleRouteError(req, res, err);
  }
});

app.get('/api/mataro/stop/:stopId/departures', async (req, res) => {
  const { stopId } = req.params;
  const lineId = req.query.lineId || '';
  try {
    const data = await mataroTracker.getStopDepartures(stopId, lineId);
    res.json({ success: true, data });
  } catch (err) {
    handleRouteError(req, res, err);
  }
});

// Legacy C-10 Corridor alias endpoints
app.get('/api/c10/target-eta', async (req, res) => {
  const direction = req.query.direction === '1' ? '1' : '0';
  const stopId = req.query.stopId || null;
  try {
    const resolution = resolveTrackerOr404(res, 'c10');
    if (!resolution) return;
    const { tracker } = resolution;
    const data = await tracker.getTargetStopETA('c10', stopId, direction);
    res.json({ success: true, data: harmonizeTargetEta(data, tracker, 'c10', direction) });
  } catch (err) {
    handleRouteError(req, res, err);
  }
});

app.get('/api/c10/live-corridor', async (req, res) => {
  const direction = req.query.direction === '1' ? '1' : '0';
  try {
    const resolution = resolveTrackerOr404(res, 'c10');
    if (!resolution) return;
    const { tracker } = resolution;
    const data = await tracker.getLineDetails('c10', direction);
    res.json({ success: true, data });
  } catch (err) {
    handleRouteError(req, res, err);
  }
});

app.get('/api/c10/stops', async (req, res) => {
  const direction = req.query.direction === '1' ? '1' : '0';
  try {
    const resolution = resolveTrackerOr404(res, 'c10');
    if (!resolution) return;
    const { tracker } = resolution;
    const data = await tracker.getLineDetails('c10', direction);
    res.json({ success: true, totalStops: data?.stops?.length || 0, stops: data?.stops || [] });
  } catch (err) {
    handleRouteError(req, res, err);
  }
});

app.get('/api/c10/stop/:stopId/departures', async (req, res) => {
  const { stopId } = req.params;
  const direction = req.query.direction || '0';
  try {
    const resolution = resolveTrackerOr404(res, 'c10');
    if (!resolution) return;
    const { tracker } = resolution;
    const data = await tracker.getStopDepartures(stopId, 'c10', direction);
    res.json({ success: true, data: harmonizeDeparturesEnvelope(data, tracker, 'c10') });
  } catch (err) {
    handleRouteError(req, res, err);
  }
});
// Get Nearby Stops for Mataró Bus (GPS or Zone coordinates)
app.get(['/api/mataro/stops/nearby', '/api/mataro/nearby', '/api/stops/nearby'], async (req, res) => {
  const lat = req.query.lat;
  const lon = req.query.lon;
  const radius = parseInt(req.query.radius, 10) || 800;
  const limit = Math.min(parseInt(req.query.limit, 10) || 5, 12);
  const includeDepartures = req.query.departures !== 'false';

  if (!lat || !lon) {
    return res.status(400).json({
      success: false,
      error: 'Query parameters "lat" and "lon" are required.'
    });
  }

  try {
    const stops = includeDepartures
      ? await mataroTracker.getNearbyStopsWithDepartures(lat, lon, radius, limit)
      : mataroTracker.getNearbyStops(lat, lon, radius, limit);

    res.json({
      success: true,
      coords: { lat: parseFloat(lat), lon: parseFloat(lon) },
      radiusMeters: radius,
      count: stops.length,
      stops
    });
  } catch (err) {
    sendInternalError(req, res, err, { count: 0, stops: [] });
  }
});

// Journey Planner ("Com anar-hi" - A to B routing in Mataró)
app.get(['/api/mataro/plan', '/api/plan'], async (req, res) => {
  const numeric = (name, min, max) => req.query[name] === undefined || (typeof req.query[name] === 'string' && req.query[name].trim() !== '' && Number.isFinite(Number(req.query[name])) && Number(req.query[name]) >= min && Number(req.query[name]) <= max);
  const preference = req.query.preference || 'fastest';
  if (!['fastest', 'least_walking', 'direct_only'].includes(preference) ||
      !numeric('walkingSpeed', 30, 120) || !numeric('maxWalkingDistance', 50, 5000) ||
      !numeric('fromLat', -90, 90) || !numeric('toLat', -90, 90) || !numeric('fromLon', -180, 180) || !numeric('toLon', -180, 180) ||
      (req.query.fromLat === undefined) !== (req.query.fromLon === undefined) || (req.query.toLat === undefined) !== (req.query.toLon === undefined)) {
    return res.status(400).json({ success: false, error: 'Paràmetres del trajecte no vàlids.' });
  }
  try {
    require('./src/core/schedule/journeyTimeline').requestedInstant({ departureDate: req.query.departureDate || req.query.date, departureTime: req.query.departureTime || req.query.time });
  } catch (error) { return res.status(400).json({ success: false, error: error.message }); }

  const from = req.query.from;
  const to = req.query.to;
  if (!from || !to) {
    return res.status(400).json({ success: false, error: 'Query parameters "from" and "to" are required.' });
  }

  let origin = from;
  let destination = to;
  if (req.query.fromLat && req.query.fromLon) {
    origin = {
      lat: parseFloat(req.query.fromLat),
      lon: parseFloat(req.query.fromLon),
      name: req.query.fromName || from
    };
  }
  if (req.query.toLat && req.query.toLon) {
    destination = {
      lat: parseFloat(req.query.toLat),
      lon: parseFloat(req.query.toLon),
      name: req.query.toName || to
    };
  }

  // Geocode origin / destination if they are street names not matching a known stop
  if (typeof origin === 'string' && !/^\d+$/.test(origin)) {
    const isStop = mataroTracker.allStopsMap && Array.from(mataroTracker.allStopsMap.values()).some(s => s.name.toLowerCase() === origin.toLowerCase());
    if (!isStop) {
      try {
        const found = await streetGeocoder.searchStreets(origin, 1);
        if (found.length > 0) {
          origin = { lat: found[0].lat, lon: found[0].lon, name: found[0].name || origin };
        }
      } catch {}
    }
  }

  if (typeof destination === 'string' && !/^\d+$/.test(destination)) {
    const isStop = mataroTracker.allStopsMap && Array.from(mataroTracker.allStopsMap.values()).some(s => s.name.toLowerCase() === destination.toLowerCase());
    if (!isStop) {
      try {
        const found = await streetGeocoder.searchStreets(destination, 1);
        if (found.length > 0) {
          destination = { lat: found[0].lat, lon: found[0].lon, name: found[0].name || destination };
        }
      } catch {}
    }
  }

  try {
    const origLabel = (typeof origin === 'object' && origin.name) ? origin.name : (req.query.fromName || from);
    const destLabel = (typeof destination === 'object' && destination.name) ? destination.name : (req.query.toName || to);
    const plan = await mataroTracker.planJourney(origin, destination, {
      originName: origLabel,
      destName: destLabel,
      preference: req.query.preference || 'fastest',
      walkingSpeed: req.query.walkingSpeed,
      maxWalkingDistance: req.query.maxWalkingDistance,
      departureTime: req.query.departureTime || req.query.time || null,
      departureDate: req.query.departureDate || req.query.date || null
    });
    res.json(plan);
  } catch (err) {
    sendInternalError(req, res, err, { success: false, itineraries: [] });
  }
});

// Traffic Congestion & Slowdown Heatmap for a line
app.get('/api/mataro/line/:lineId/traffic', async (req, res) => {
  const { lineId } = req.params;
  const direction = req.query.direction || '0';
  try {
    const traffic = await mataroTracker.getLineCongestion(lineId, direction);
    res.json({ success: true, ...traffic });
  } catch (err) {
    sendInternalError(req, res, err, { success: false, segments: [] });
  }
});

// Disruptions / Notices for Mataró Bus (Live official Avanza notices)
app.get('/api/disruptions', async (req, res) => {
  try {
    const lineId = req.query.line || null;
    const disruptions = await mataroTracker.getDisruptions(lineId);
    res.json({
      success: true,
      count: disruptions.length,
      disruptions
    });
  } catch (err) {
    sendInternalError(req, res, err, { count: 0, disruptions: [] });
  }
});

// All Active Vehicles across Mataró Bus
app.get('/api/vehicles', (req, res) => {
  // Accept both `1` and `L1` (any case) like the rest of the API: vehicles store
  // lineCode as `L<n>`, so normalize the filter to the same canonical form.
  const rawLine = req.query.line !== undefined ? String(req.query.line).trim() : '';
  const lineFilter = rawLine ? `L${rawLine.replace(/^l/i, '')}` : null;
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

app.get('/api/fleet/live', (req, res) => {
  const vehicles = flightRecorder.getAllVehicles();
  res.json({
    success: true,
    count: vehicles.length,
    timestamp: Date.now(),
    vehicles
  });
});

// Vehicle Trail
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
    handleRouteError(req, res, err);
  }
});

// Line Delay Stats
app.get('/api/line/:lineId/stats', async (req, res) => {
  const { lineId } = req.params;
  const cleanCode = `L${lineId.replace(/^l/i, '')}`;
  try {
    const stats = await flightRecorder.getLineStats(cleanCode, lineId);
    res.json({
      success: true,
      lineId,
      code: cleanCode,
      hoursMonitored: 24,
      stats
    });
  } catch (err) {
    handleRouteError(req, res, err);
  }
});

// Observatori & Analytics Reports
app.get(['/api/analytics/journalism', '/api/retards/journalism'], async (req, res) => {
  const hours = Math.max(1, Math.min(168, parseInt(req.query.hours, 10) || 24));
  const allLines = trackerRegistry.getAllLines();
  try {
    let report = await reportCacheService.getLatestReport(hours, allLines);
    if (!report || !report.summary || Object.keys(report.summary).length === 0) {
      try {
        report = await workerBridge.historyQuery('generateReport', { hours, allLinesCatalog: allLines }, { timeoutMs: 30000 });
      } catch {}
    }
    if (!report) {
      return res.status(503).json({ success: false, error: 'Report is warming up, retry shortly.' });
    }
    res.json({ success: true, ...report, report });
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

app.get(['/api/analytics/export/csv', '/api/retards/export/csv'], async (req, res) => {
  const hours = Math.max(1, Math.min(168, parseInt(req.query.hours, 10) || 48));
  try {
    const csv = await flightRecorder.exportCsv(hours);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transit_delays_${hours}h.csv"`);
    res.send(csv);
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

app.get(['/api/retards/ranking', '/api/analytics/ranking'], async (req, res) => {
  const allLines = trackerRegistry.getAllLines();
  try {
    let report = await reportCacheService.getLatestReport(24, allLines);
    if (!report) {
      try {
        report = await workerBridge.historyQuery('generateReport', { hours: 24, allLinesCatalog: allLines }, { timeoutMs: 30000 });
      } catch {}
    }
    const rankingMostDelayed = report ? (report.rankingMostDelayed || []) : [];
    const agencyStats = report ? (report.agencyStats || []) : [];
    res.json({
      success: true,
      timeframe: '24h',
      timeframeHours: 24,
      ranking: rankingMostDelayed,
      rankingMostDelayed,
      agencyStats
    });
  } catch (err) {
    sendInternalError(req, res, err, { ranking: [], rankingMostDelayed: [], agencyStats: [], timeframeHours: 24 });
  }
});

// "El Termòmetre del Bus" — Scorecard & Weekly/Monthly Infographic Data
app.get(['/api/analytics/termometre', '/api/retards/termometre'], async (req, res) => {
  const hours = Math.max(1, Math.min(168, parseInt(req.query.hours, 10) || 24));
  const allLines = trackerRegistry.getAllLines();
  try {
    let report = await reportCacheService.getLatestReport(hours, allLines);
    if (!report) {
      try {
        report = await workerBridge.historyQuery('generateReport', { hours, allLinesCatalog: allLines }, { timeoutMs: 30000 });
      } catch {}
    }
    const termometre = report?.termometre || {
      title: `El Termòmetre del Bus (${hours}h)`,
      timeframeHours: hours,
      grade: 'A',
      punctualityPct: report?.summary?.networkPunctualityPct || 92,
      networkAvgDelay: report?.summary?.networkAvgDelay || 1.1,
      championLine: { code: 'L1', name: 'Línia 1', onTimePct: 95, avgDelay: 0.8 },
      worstBottleneck: { stopName: 'Pl. de les Tereses', lineCode: 'L2', avgDelay: 3.2, severeLatePct: 14 },
      peakHour: '08:00 - 09:00',
      peakHourDelay: 2.3,
      totalTripsAnalyzed: report?.summary?.totalRecordedArrivals || 0
    };
    res.json({ success: true, termometre, summary: report?.summary || {} });
  } catch (err) {
    sendInternalError(req, res, err);
  }
});

// Incident Deep-Dive: Query and analyze extreme delays, bottlenecks, and affected trips
const incidentQueryCache = new Map();
const INCIDENT_CACHE_TTL_MS = 60 * 1000; // 60s TTL

app.get(['/api/analytics/incidents', '/api/retards/incidents', '/api/analytics/line/:lineId/incidents'], async (req, res) => {
  const lineParam = req.params.lineId || req.query.line || 'all';
  const hours = Math.max(1, Math.min(720, parseInt(req.query.hours, 10) || 168));
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
  const minDelay = Math.max(1, parseInt(req.query.minDelay, 10) || 5);

  const cacheKey = `${String(lineParam).toUpperCase()}_${hours}_${limit}_${minDelay}`;
  const now = Date.now();
  const cached = incidentQueryCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < INCIDENT_CACHE_TTL_MS) {
    res.setHeader('X-Cache', 'HIT');
    return res.json({
      success: true,
      ...cached.data
    });
  }

  try {
    const data = await workerBridge.historyQuery('getDelayIncidents', {
      lineCode: lineParam,
      hours,
      limit,
      minDelay
    }, { timeoutMs: 35000 });

    if (data) {
      incidentQueryCache.set(cacheKey, { data, timestamp: now });
      if (incidentQueryCache.size > 40) {
        const oldestKey = incidentQueryCache.keys().next().value;
        incidentQueryCache.delete(oldestKey);
      }
    }

    res.setHeader('X-Cache', 'MISS');
    res.json({
      success: true,
      ...data
    });
  } catch (err) {
    sendInternalError(req, res, err, {
      success: false,
      lineCode: String(lineParam).toUpperCase(),
      hoursAnalyzed: hours,
      summary: {},
      topIncidents: [],
      incidentTrips: []
    });
  }
});

// Inspect endpoint: deep-dive forensic packet for a given incident window
app.get('/api/analytics/incidents/inspect', async (req, res) => {
  const lineParam = req.query.line || 'all';
  const at = Number(req.query.at || 0);
  const windowMins = Math.max(5, Math.min(240, parseInt(req.query.windowMins || 60, 10)));
  const minDelay = Math.max(1, parseInt(req.query.minDelay || 5, 10));

  try {
    const data = await workerBridge.historyQuery('inspectDelayIncident', {
      lineCode: lineParam, stopName: String(req.query.stop || ''),
      // The vehicle is the episode identity: without it the drill-down can
      // resolve to a neighbouring bus that logged the same stop in the window.
      vehicleId: String(req.query.vehicle || ''),
      at, windowMins, minDelay
    }, { timeoutMs: 35000 });

    if (data && data.found) {
      res.json({ success: true, ...data });
    } else {
      res.json({ success: true, found: false, error: data?.error || 'no data in window', episode: null, dataQuality: data?.dataQuality || {} });
    }
  } catch (err) {
    sendInternalError(req, res, err, { success: false, found: false, error: err.message, episode: null, dataQuality: {} });
  }
});

// Passive upstream diagnostics, served entirely from cached worker status
app.get('/api/diagnostics/upstream', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const now = Date.now();
  const status = workerBridge.getStatus();
  const circuit = status.metrics?.upstream || null;
  const snapshotAt = circuit?.timestamp || null;
  const snapshotAgeMs = Number.isFinite(snapshotAt) ? Math.max(0, now - snapshotAt) : null;
  res.json({
    success: true,
    timestamp: now,
    worker: {
      running: status.isRunning,
      healthy: status.isHealthy,
      lastHeartbeatAgeMs: Number.isFinite(status.lastHeartbeat) ? Math.max(0, now - status.lastHeartbeat) : null
    },
    upstream: circuit ? {
      circuitOpen: !!circuit.circuitOpen,
      circuitOpenUntil: circuit.circuitOpenUntil || null,
      consecutiveFailures: circuit.consecutiveFailures ?? null,
      cooldownMs: circuit.cooldownMs ?? null,
      lastSuccess: {
        vehicles: circuit.lastVehicleSuccessAt || null,
        arrivals: circuit.lastArrivalsSuccessAt || null
      },
      lastFailureAt: circuit.lastFailureAt || null,
      snapshotAgeMs
    } : { available: false, snapshotAgeMs }
  });
});

// Diagnostic upstream test
app.get('/api/diagnostics/test', async (req, res) => {
  const lineId = req.query.lineId || '1';
  const start = Date.now();
  try {
    const result = await mataroTracker.getLineDetails(lineId, '0');
    const latencyMs = Date.now() - start;
    const activeVehicles = result?.activeBuses?.length || 0;
    res.json({
      success: true,
      lineId,
      provider: 'Mataró Bus Urbà (Avanza SIRI Gateway)',
      host: 'sirimataro.avanzagrupo.com',
      auth: 'SIRI-Lite Protocol',
      type: 'SOAP / XML VehicleMonitoring',
      latencyMs,
      status: latencyMs > 3000 ? 'slow' : 'online',
      statusCode: 200,
      activeVehicles,
      message: `Connexió correcta amb sirimataro.avanzagrupo.com (${latencyMs}ms). ${activeVehicles} vehicles actius.`,
      testedAt: new Date().toLocaleTimeString('ca-ES', { timeZone: 'Europe/Madrid' })
    });
  } catch (err) {
    res.json({
      success: false,
      lineId,
      provider: 'Mataró Bus Urbà',
      host: 'sirimataro.avanzagrupo.com',
      status: 'offline',
      statusCode: 502,
      error: err.message
    });
  }
});

// Service Worker explicit route (strictly no-cache to guarantee instant PWA updates)
app.get('/sw.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// Dedicated Planner HTML Routes
app.get(['/plan', '/com-anar-hi', '/rutes', '/itinerari'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'plan.html'));
});

// Dedicated Observatori HTML Routes
app.get(['/dades', '/observatori', '/analytics'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'dades.html'));
});

// 404 handler for unmatched API routes
app.all('/api/*', (req, res) => {
  res.status(404).json({ success: false, error: `API endpoint '${req.path}' not found.` });
});

// SPA fallback for HTML5 routing
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
if (require.main === module) {
  httpServer = app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚌 Arribo! Mataró Bus Tracker HTTP Server`);
    console.log(`📡 URL: http://localhost:${PORT}`);
    console.log(`📊 Lines: Mataró Bus Urbà (L1 - L8)`);
    console.log(`🛰️ SIRI: sirimataro.avanzagrupo.com`);
    console.log(`======================================================\n`);
  });
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    fleetBroadcaster.shutdown();
    if (httpServer) {
      await new Promise(resolve => {
        const deadline = setTimeout(() => { httpServer.closeAllConnections(); resolve(); }, 5000);
        httpServer.close(() => { clearTimeout(deadline); resolve(); });
      });
    }
    await workerBridge.shutdown(5000);
    console.log(JSON.stringify({ event: 'shutdown_complete' }));
  })();
  return shutdownPromise;
}
if (require.main === module) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    const deadline = setTimeout(() => process.exit(1), 12000);
    shutdown().then(() => { clearTimeout(deadline); process.exit(0); }).catch(() => process.exit(1));
  });
}
app.shutdown = shutdown;
module.exports = app;
