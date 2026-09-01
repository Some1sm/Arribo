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

// ==========================================
// 0. PROCESS-LEVEL RESILIENCE TRAPS
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
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// Launch Background Ingestion Worker asynchronously via WorkerBridge supervisor
workerBridge.start();
flightRecorder.setAutoExtrapolation(false);
flightRecorder.setHistoryGateway((op, args) => workerBridge.historyQuery(op, args, { timeoutMs: op === 'getLineDelayStats' ? 25000 : 10000 }));

// Centralize Mataró SIRI traffic in the worker over IPC
mataroSiriClient.setRpcBackend(async (op, args) => {
  try {
    const res = await workerBridge.historyQuery(op, args, { timeoutMs: 8000 });
    return Array.isArray(res) ? res : [];
  } catch (_) { return []; }
});

// Request logger middleware
app.use('/api', (req, res, next) => {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] 🌐 ${req.method} ${req.originalUrl}`);
  next();
});

function sendInternalError(req, res, err, extra = {}) {
  console.error(`[API] 500 on ${req.method} ${req.originalUrl}:`, err);
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
  } catch (_) {
    res.status(404).json({ success: false, error: 'Unknown line' });
    return null;
  }
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

  if (v.lat === undefined && Number.isFinite(Number(v.latitude))) v.lat = Number(v.latitude);
  if (v.lon === undefined && Number.isFinite(Number(v.longitude))) v.lon = Number(v.longitude);
  if (Number.isFinite(Number(v.lat))) v.latitude = Number(v.lat);
  if (Number.isFinite(Number(v.lon))) v.longitude = Number(v.lon);

  if (!v.lastUpdate) {
    v.lastUpdate = v.recordedAt || new Date().toISOString();
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
// 1. PUBLIC REST API ENDPOINTS
// ==========================================

// Health Check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
    agency: 'Mataró Bus Urbà'
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

// Universal Search across Mataró stops and lines
app.get('/api/search/stops', (req, res) => {
  const q = req.query.q || '';
  if (!q.trim()) {
    return res.json({ success: true, query: '', results: [] });
  }

  const results = trackerRegistry.searchStopsAndLines(q, 35);
  res.json({
    success: true,
    query: q,
    results
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
      vehicles = vehicles.map(standardizeVehicle);
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
    if (!report) {
      try {
        report = await workerBridge.historyQuery('generateReport', { hours, allLinesCatalog: allLines }, { timeoutMs: 30000 });
      } catch (_) {}
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
      } catch (_) {}
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

// 404 handler for unmatched API routes
app.all('/api/*', (req, res) => {
  res.status(404).json({ success: false, error: `API endpoint '${req.path}' not found.` });
});

// SPA fallback for HTML5 routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚌 Arribo! Mataró Bus Tracker HTTP Server`);
    console.log(`📡 URL: http://localhost:${PORT}`);
    console.log(`📊 Lines: Mataró Bus Urbà (L1 - L8)`);
    console.log(`🛰️ SIRI: sirimataro.avanzagrupo.com`);
    console.log(`======================================================\n`);
  });
}

module.exports = app;
