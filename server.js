const express = require('express');
const cors = require('cors');
const path = require('path');
const corridorTracker = require('./src/corridorTracker');
const mataroTracker = require('./src/mataroTracker');
const sagalesTracker = require('./src/sagalesTracker');
const ambTracker = require('./src/ambTracker');
const rodaliesTracker = require('./src/rodaliesTracker');
const maresmeTracker = require('./src/maresmeTracker');
const cataloniaTracker = require('./src/cataloniaTracker');
const flightRecorder = require('./src/flightRecorder');
const ingestionDaemon = require('./src/ingestionDaemon');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Pre-initialize async trackers and launch Autonomous Ingestion Daemon
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
  if (maresmeTracker.resolveLine(cleanId)) return { type: 'maresme', tracker: maresmeTracker };
  if (rodaliesTracker.resolveLine(cleanId)) return { type: 'rodalies', tracker: rodaliesTracker };
  if (mataroTracker.resolveLineConfig(cleanId)) return { type: 'mataro', tracker: mataroTracker };
  if (ambTracker.resolveLine(cleanId)) return { type: 'amb', tracker: ambTracker };
  if (sagalesTracker.resolveLineConfig(cleanId)) return { type: 'sagales', tracker: sagalesTracker };
  if (cataloniaTracker.resolveLine(cleanId)) return { type: 'catalonia', tracker: cataloniaTracker };
  return { type: 'catalonia', tracker: cataloniaTracker };
}

// ==========================================
// 1. UNIVERSAL TRANSIT LINES & SEARCH
// ==========================================

// List all available transit lines across all providers
app.get('/api/lines', async (req, res) => {
  await Promise.allSettled([ambTracker.init(), rodaliesTracker.init(), cataloniaTracker.init()]);

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

  // Deduplicate against lines already registered in specialized trackers
  const seenCodes = new Set(['c-10', 'c10', '1', '2', '3', '4', '5', '6', '7', '8']);
  maresmeLines.forEach(l => seenCodes.add(String(l.code).toLowerCase()));
  ambLines.forEach(l => seenCodes.add(String(l.code).toLowerCase()));
  rodaliesLines.forEach(l => seenCodes.add(String(l.code).toLowerCase()));

  const extraCatLines = allCatLines.filter(l => !seenCodes.has(String(l.code).toLowerCase()));

  const combinedLines = [
    c10Line,
    ...maresmeLines,
    ...rodaliesLines,
    ...sagalesLines,
    ...ambLines,
    ...mataroLines,
    ...extraCatLines
  ];

  res.json({
    success: true,
    totalLines: combinedLines.length,
    lines: combinedLines
  });
});

// Universal Stop Searcher (Across all bus and train stops in Catalonia)
app.get('/api/search/stops', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q || q.length < 2) {
    return res.json({ success: true, results: [] });
  }

  const results = [];

  // 1. Search Rodalies train stations
  rodaliesTracker.allStopsMap.forEach(s => {
    if (s.name.toLowerCase().includes(q) || (s.cleanName && s.cleanName.toLowerCase().includes(q)) || s.id.includes(q)) {
      results.push({
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

  // 2. Search Maresme Moventis / Casas stops (N80, N81, e11.1, e11.2, C-20, C-30, etc.)
  maresmeTracker.allStopsMap.forEach(s => {
    if (results.length < 35 && (s.name.toLowerCase().includes(q) || (s.code && s.code.includes(q)))) {
      results.push({
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

  // 2. Search C-10 stops
  const c10Stops = corridorTracker.getStops('1');
  c10Stops.forEach(s => {
    if (s.name.toLowerCase().includes(q) || (s.code && s.code.includes(q))) {
      results.push({
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

  // 3. Search Sagalés stops
  sagalesTracker.allStopsMap.forEach(s => {
    if (s.name.toLowerCase().includes(q) || (s.code && s.code.includes(q))) {
      results.push({
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

  // 4. Search AMB Bus stops (TUSGSAL, Avanza, Monbus, Soler i Sauret, Baixbus, Moventis)
  ambTracker.allStopsMap.forEach(s => {
    if (results.length < 35 && (s.name.toLowerCase().includes(q) || (s.code && s.code.includes(q)))) {
      results.push({
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

  // 5. Search Mataró Bus stops
  mataroTracker.allStopsMap.forEach(s => {
    if (s.name.toLowerCase().includes(q) || s.id.includes(q)) {
      const lineCodes = s.lineas.map(l => `Línia ${l.id}`).join(', ') || 'Mataró Urbà';
      const firstLine = s.lineas[0] || { id: '1', color: '#ff00ff' };
      results.push({
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

  // 6. Search All Catalonia Interurban Bus stops (Sagalés, Plana, Hife, Teisa, etc.)
  if (results.length < 35) {
    cataloniaTracker.allStopsMap.forEach(s => {
      if (results.length < 40 && (s.name.toLowerCase().includes(q) || (s.code && s.code.includes(q)))) {
        results.push({
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
  try {
    const { type, tracker } = getTrackerForLine(lineId);
    if (type === 'c10') {
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
            serviceStatus: {
              isOperating: ((tracking1.activeBuses?.length || 0) + (tracking0.activeBuses?.length || 0)) > 0,
              firstServiceTomorrow: '06:45'
            }
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
            stops: stops,
            coords: tracking.routePolyline || [],
            activeBuses: tracking.activeBuses || [],
            checkpoints: tracking.checkpoints || [],
            totalVehiclesInCircuit: tracking.activeBuses?.length || 0,
            serviceStatus: {
              isOperating: (tracking.activeBuses?.length || 0) > 0,
              firstServiceTomorrow: dir === '1' ? '08:15' : '06:45'
            }
          }
        });
      }
    } else {
      const data = await tracker.getLineDetails(lineId, direction);
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
  try {
    const { type, tracker } = getTrackerForLine(lineId);
    if (type === 'c10') {
      const dir = direction === '0' ? '0' : '1';
      const data = await corridorTracker.getTargetStopETA(dir, stopId);
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
  try {
    const { type, tracker } = getTrackerForLine(lineId);
    if (type === 'c10') {
      const dir = direction === '0' ? '0' : '1';
      const data = await corridorTracker.getStopDepartures(stopId, dir);
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
  try {
    const data = await corridorTracker.getTargetStopETA(direction, stopId);
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
  try {
    const data = await corridorTracker.getStopDepartures(stopId, direction);
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
  const stats = flightRecorder.getLineStats(cleanCode);
  res.json({
    success: true,
    lineId,
    lineCode: cleanCode,
    stats
  });
});

// Journalism Investigation Report across all lines & operators
app.get('/api/analytics/journalism', (req, res) => {
  const hours = parseInt(req.query.hours || '24', 10);
  const report = flightRecorder.getJournalismReport(hours);
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
  res.setHeader('Content-Disposition', `attachment; filename="bad_amb_transit_delays_${Date.now()}.csv"`);
  res.send(csvData);
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Bad AMB Bus Tracker',
    version: '2.0.0',
    supportedLines: ['C-10', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'],
    timestamp: new Date().toISOString()
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`🚌 Bad AMB Bus Tracker Platform Running!`);
    console.log(`🌐 Lines: C-10 + Mataró Bus L1..L8`);
    console.log(`📍 Local URL: http://localhost:${PORT}`);
    console.log(`====================================================`);
  });
}

module.exports = app;
