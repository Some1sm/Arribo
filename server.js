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
const flightRecorder = require('./src/flightRecorder');
const ingestionDaemon = require('./src/ingestionDaemon');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(compression());
app.use(express.json());

// Strict Read-Only Security Guard: Reject any write requests from clients
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed: This transit service is strictly read-only.' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  etag: false
}));

// Pre-initialize async trackers, daily route cache, and launch Autonomous Ingestion Daemon
routeCacheService.initDailyCache();

Promise.allSettled([
  ambTracker.init(),
  rodaliesTracker.init(),
  cataloniaTracker.init()
]).then(() => {
  console.log('[TransitPlatform] All Multi-Provider Trackers Initialized.');
  ingestionDaemon.start();
});

// Request logger middleware
app.use('/api', (req, res, next) => {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] 🌐 ${req.method} ${req.originalUrl}`);
  next();
});

function getTrackerForLine(lineId) {
  const cleanId = String(lineId).toLowerCase().trim();
  if (cleanId === 'c10' || cleanId === 'c-10') return { type: 'c10', tracker: corridorTracker };

  // Mataró urban bus L1..L8 must be checked before AMB since AMB also has numeric codes
  const mataroId = cleanId.replace(/^l(?=[1-8]$)/, ''); // strip leading 'l' from l1..l8
  if (/^[1-8]$/.test(mataroId)) return { type: 'mataro', tracker: mataroTracker };

  if (maresmeTracker.resolveLine(cleanId)) return { type: 'maresme', tracker: maresmeTracker };
  if (rodaliesTracker.resolveLine(cleanId)) return { type: 'rodalies', tracker: rodaliesTracker };
  if (ambTracker.resolveLine(cleanId)) return { type: 'amb', tracker: ambTracker };
  if (sagalesTracker.resolveLineConfig(cleanId)) return { type: 'sagales', tracker: sagalesTracker };
  if (cataloniaTracker.resolveLine(cleanId)) return { type: 'catalonia', tracker: cataloniaTracker };
  return { type: 'catalonia', tracker: cataloniaTracker };
}

// ==========================================
// 1. UNIVERSAL TRANSIT LINES & SEARCH
// ==========================================

function getAllTransitLines() {
  const c10Line = {
    id: 'c10',
    code: 'C-10',
    name: 'Barcelona ⇄ Mataró (per N-II)',
    color: '#009485',
    agency: 'Moventis / Casas (Interurbà Maresme)',
    group: 'moventis',
    directions: [
      { dirId: '1', name: "Cap a Mataró (Hospital / Pl. d'Itàlia)" },
      { dirId: '0', name: 'Cap a Barcelona (Metro la Pau)' }
    ]
  };

  const maresmeLines = maresmeTracker.getLines();
  const rodaliesLines = rodaliesTracker.getLines();
  const sagalesLines = sagalesTracker.getLines();
  const ambLines = ambTracker.getLines();
  const mataroLines = mataroTracker.getLines();
  const allCatLines = cataloniaTracker.getLines();

  const seenIds = new Set();
  const allCombined = [];

  const addLine = (l) => {
    if (l && l.id && !seenIds.has(String(l.id).toLowerCase())) {
      seenIds.add(String(l.id).toLowerCase());
      allCombined.push(l);
    }
  };

  addLine(c10Line);
  maresmeLines.forEach(addLine);
  mataroLines.forEach(addLine);
  rodaliesLines.forEach(addLine);
  sagalesLines.forEach(addLine);
  ambLines.forEach(addLine);
  allCatLines.forEach(addLine);

  return allCombined;
}

// List all available transit lines across all providers
app.get('/api/lines', async (req, res) => {
  await Promise.allSettled([ambTracker.init(), rodaliesTracker.init(), cataloniaTracker.init()]);
  const combinedLines = getAllTransitLines();

  res.json({
    success: true,
    totalLines: combinedLines.length,
    lines: combinedLines
  });
});

// Universal Stop & Line Searcher (Across all bus and train lines & stops in Catalonia)
app.get('/api/search/stops', async (req, res) => {
  await Promise.allSettled([ambTracker.init(), rodaliesTracker.init(), cataloniaTracker.init()]);
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q || q.length < 1) {
    return res.json({ success: true, results: [] });
  }

  const normQ = q.replace(/[-_\s\.]/g, '');
  const results = [];

  // 1. Search Lines First (high priority matches)
  const allLines = getAllTransitLines();
  const matchingLines = allLines.filter(l => {
    const code = String(l.code || '').toLowerCase();
    const name = String(l.name || '').toLowerCase();
    const id = String(l.id || '').toLowerCase();
    const agency = String(l.agency || '').toLowerCase();
    const normCode = code.replace(/[-_\s\.]/g, '');
    const normId = id.replace(/[-_\s\.]/g, '');
    if (q.length === 1) {
      return code === q || normCode === normQ || code.startsWith(q) || normCode.startsWith(normQ);
    }
    return code.includes(q) || normCode.includes(normQ) || id.includes(q) || normId.includes(normQ) || name.includes(q) || agency.includes(q);
  });

  // Sort exact code matches to the top
  matchingLines.sort((a, b) => {
    const aCode = String(a.code || '').toLowerCase();
    const bCode = String(b.code || '').toLowerCase();
    const aExact = aCode === q || aCode.replace(/[-_\s\.]/g, '') === normQ;
    const bExact = bCode === q || bCode.replace(/[-_\s\.]/g, '') === normQ;
    if (aExact && !bExact) return -1;
    if (!aExact && bExact) return 1;
    const aStarts = aCode.startsWith(q) || aCode.replace(/[-_\s\.]/g, '').startsWith(normQ);
    const bStarts = bCode.startsWith(q) || bCode.replace(/[-_\s\.]/g, '').startsWith(normQ);
    if (aStarts && !bStarts) return -1;
    if (!aStarts && bStarts) return 1;
    return 0;
  });

  matchingLines.slice(0, 6).forEach(l => {
    results.push({
      type: 'line',
      isLine: true,
      lineId: l.id,
      lineCode: l.code,
      lineName: l.name,
      lineColor: l.color || '#009485',
      agency: l.agency || 'Xarxa de Transport',
      zone: `🚌 Línia • ${l.agency || 'Transport'}`,
      isTrain: l.group === 'rodalies' || l.group === 'renfe'
    });
  });

  // 2. Search Rodalies train stations
  rodaliesTracker.allStopsMap.forEach(s => {
    if (s.name.toLowerCase().includes(q) || (s.cleanName && s.cleanName.toLowerCase().includes(q)) || s.id.includes(q)) {
      results.push({
        type: 'stop',
        lineId: s.lineId || 'rodalies_r1',
        lineCode: s.lineCode || 'R1',
        lineName: s.name,
        lineColor: s.lineColor || '#7DBCEC',
        stopId: s.id,
        stopName: s.name,
        code: s.code,
        zone: '🚆 Rodalies de Catalunya',
        isTrain: true,
        lat: s.lat,
        lon: s.lon
      });
    }
  });

  // 3. Search Maresme Moventis / Casas stops (N80, N81, e11.1, e11.2, C-20, C-30, etc.)
  maresmeTracker.allStopsMap.forEach(s => {
    if (results.length < 35 && s && ((s.name && s.name.toLowerCase().includes(q)) || (s.code && String(s.code).includes(q)))) {
      results.push({
        type: 'stop',
        lineId: s.lineId,
        lineCode: s.lineCode,
        lineName: s.name,
        lineColor: s.lineColor || '#009485',
        stopId: s.id,
        stopName: s.name,
        code: s.code,
        zone: '🌊 Moventis Maresme',
        lat: s.lat,
        lon: s.lon
      });
    }
  });

  // 4. Search C-10 stops
  const c10Stops = corridorTracker.getStops('1');
  c10Stops.forEach(s => {
    if (results.length < 35 && s && ((s.name && s.name.toLowerCase().includes(q)) || (s.code && String(s.code).includes(q)))) {
      results.push({
        type: 'stop',
        lineId: 'c10',
        lineCode: 'C-10',
        lineName: 'Barcelona ⇄ Mataró',
        lineColor: '#009485',
        stopId: s.mouteStopId,
        stopName: s.name,
        code: s.code,
        zone: s.lon >= 2.289 ? '🌊 Zona Maresme' : '🏙️ Zona AMB',
        lat: s.lat,
        lon: s.lon
      });
    }
  });

  // 5. Search Sagalés stops
  sagalesTracker.allStopsMap.forEach(s => {
    if (results.length < 35 && s && ((s.name && s.name.toLowerCase().includes(q)) || (s.code && String(s.code).includes(q)))) {
      results.push({
        type: 'stop',
        lineId: s.lineId || 'n82',
        lineCode: s.lineCode || 'N82',
        lineName: s.name,
        lineColor: s.lineColor || '#457336',
        stopId: s.id,
        stopName: s.name,
        code: s.code,
        zone: `🦉 Sagalés (${s.city || 'Costa'})`,
        lat: s.lat,
        lon: s.lon
      });
    }
  });

  // 6. Search AMB Bus stops (TUSGSAL, Avanza, Monbus, Soler i Sauret, Baixbus, Moventis)
  ambTracker.allStopsMap.forEach(s => {
    if (results.length < 35 && s && ((s.name && s.name.toLowerCase().includes(q)) || (s.code && String(s.code).includes(q)))) {
      results.push({
        type: 'stop',
        lineId: s.lineId,
        lineCode: s.lineCode,
        lineName: s.name,
        lineColor: s.lineColor || '#009485',
        stopId: s.id,
        stopName: s.name,
        code: s.code,
        zone: '🏙️ Àrea Metropolitana (AMB)',
        lat: s.lat,
        lon: s.lon
      });
    }
  });

  // 7. Search Mataró Bus stops
  mataroTracker.allStopsMap.forEach(s => {
    if (s.name.toLowerCase().includes(q) || s.id.includes(q)) {
      const lineCodes = s.lineas.map(l => `Línia ${l.id}`).join(', ') || 'Mataró Urbà';
      const firstLine = s.lineas[0] || { id: '1', color: '#ff00ff' };
      results.push({
        type: 'stop',
        lineId: firstLine.id,
        lineCode: lineCodes,
        lineName: s.name,
        lineColor: firstLine.color || '#00ea00',
        stopId: s.id,
        stopName: s.name,
        code: s.id,
        zone: '📍 Mataró Urbà',
        lat: s.lat,
        lon: s.lon
      });
    }
  });

  // 8. Search All Catalonia Interurban Bus stops (Sagalés, Plana, Hife, Teisa, etc.)
  if (results.length < 35) {
    cataloniaTracker.allStopsMap.forEach(s => {
      if (results.length < 40 && (s.name.toLowerCase().includes(q) || (s.code && s.code.includes(q)))) {
        results.push({
          type: 'stop',
          lineId: s.lineId,
          lineCode: s.lineCode,
          lineName: s.name,
          lineColor: s.lineColor || '#009485',
          stopId: s.id,
          stopName: s.name,
          code: s.code,
          zone: `🚌 ${s.agency || 'Interurbà Catalunya'}`,
          lat: s.lat,
          lon: s.lon
        });
      }
    });
  }

  res.json({
    success: true,
    query: q,
    results: results.slice(0, 35)
  });
});

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
            delayStats: flightRecorder.getLineStats('C-10', 'c10')
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
            activeBuses: tracking.activeBuses || [],
            checkpoints: tracking.checkpoints || [],
            totalVehiclesInCircuit: tracking.activeBuses?.length || 0,
            calendarInfo: calInfo,
            serviceStatus: {
              isOperating: (tracking.activeBuses?.length || 0) > 0,
              firstServiceTomorrow: dir === '1' ? '08:15' : '06:45',
              calendarTag: calInfo.calendarTag
            },
            delayStats: flightRecorder.getLineStats('C-10', 'c10')
          }
        });
      }
    } else {
      const data = await tracker.getLineDetails(lineId, direction);
      if (data) {
        data.delayStats = flightRecorder.getLineStats(data.code || lineId, lineId);
      }
      res.json({ success: true, data });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
      res.json({ success: true, data });
    } else {
      const data = await tracker.getTargetStopETA(lineId, stopId, direction);
      res.json({ success: true, data });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
    res.status(500).json({ success: false, error: err.message });
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
      res.json({ success: true, data });
    } else {
      const data = await tracker.getStopDepartures(stopId, lineId, direction);
      res.json({ success: true, data });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
    res.status(500).json({ success: false, error: err.message });
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
    res.status(500).json({ success: false, error: err.message });
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
    res.status(500).json({ success: false, error: err.message });
  }
});

// Live Corridor Tracking & Active Buses across checkpoints for C-10
app.get('/api/c10/live-corridor', async (req, res) => {
  const direction = req.query.direction === '0' ? '0' : '1';
  try {
    const data = await corridorTracker.getCorridorLiveTracking(direction);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
    res.status(500).json({ success: false, error: err.message });
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
    res.status(500).json({ success: false, error: err.message });
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
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 4. API CONNECTION DIAGNOSTICS & HEALTH
// ==========================================

// Diagnostic test for current line's upstream API
app.get('/api/diagnostics/test', async (req, res) => {
  const lineId = req.query.lineId || 'c10';
  const { type, tracker } = getTrackerForLine(lineId);
  const start = Date.now();

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
    res.status(500).json({ success: false, error: err.message, disruptions: [] });
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

// GPS breadcrumb trail history for a specific vehicle
app.get('/api/vehicle/:vehicleId/trail', (req, res) => {
  const { vehicleId } = req.params;
  const trail = flightRecorder.getVehicleTrail(vehicleId);
  res.json({
    success: true,
    vehicleId,
    pointsCount: trail.length,
    trail
  });
});

// Real-time & 24h delay statistics and punctuality score for a line
app.get('/api/line/:lineId/stats', (req, res) => {
  const { lineId } = req.params;
  const cleanCode = lineId.replace('cat_gen_', '').replace(/.*_/, '').toUpperCase();
  const stats = flightRecorder.getLineStats(cleanCode, lineId);
  res.json({
    success: true,
    lineId,
    lineCode: cleanCode,
    stats
  });
});

// Journalism Investigation Report across all lines & operators
app.get('/api/analytics/journalism', async (req, res) => {
  await Promise.allSettled([ambTracker.init(), rodaliesTracker.init(), cataloniaTracker.init()]);
  const hours = parseInt(req.query.hours || '24', 10);
  const allLines = getAllTransitLines();
  const report = flightRecorder.getJournalismReport(hours, allLines);
  res.json({
    success: true,
    report
  });
});

// CSV Export for spreadsheet / investigative journalism analysis
app.get('/api/analytics/export/csv', (req, res) => {
  const hours = parseInt(req.query.hours || '48', 10);
  const csvData = flightRecorder.exportCsv(hours);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="arribo_transit_delays_${Date.now()}.csv"`);
  res.send(csvData);
});

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
    res.status(500).json({ success: false, error: err.message });
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
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get 3-day changes and route topology diffs
app.get('/api/routes/diff', (req, res) => {
  try {
    const diff = routeCacheService.get3DayDiff();
    res.json({ success: true, diff });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Arribo!',
    version: '3.0.0',
    description: 'Universal Realtime Bus Telemetry & Schedule Platform for Catalonia',
    timestamp: new Date().toISOString()
  });
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

  const gracefulShutdown = (signal) => {
    console.log(`[Server] Received ${signal}. Shutting down gracefully...`);
    ingestionDaemon.stop();
    runningServer.close(() => {
      console.log('[Server] HTTP server closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

module.exports = app;
