const express = require('express');
const cors = require('cors');
const path = require('path');
const corridorTracker = require('./src/corridorTracker');
const mataroTracker = require('./src/mataroTracker');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Request logger middleware
app.use('/api', (req, res, next) => {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] 🌐 ${req.method} ${req.originalUrl}`);
  next();
});

// ==========================================
// 1. UNIVERSAL TRANSIT LINES & SEARCH
// ==========================================

// List all available bus lines (C-10 + Mataró Urban Lines L1..L8)
app.get('/api/lines', (req, res) => {
  const c10Line = {
    id: 'c10',
    code: 'C-10',
    name: 'Barcelona ⇄ Mataró (per N-II)',
    color: '#009485',
    agency: 'Moventis / Casas (Interurbà Maresme)',
    directions: [
      { dirId: '1', name: "Cap a Mataró (Hospital / Pl. d'Itàlia)" },
      { dirId: '0', name: 'Cap a Barcelona (Metro la Pau)' }
    ]
  };

  const mataroLines = mataroTracker.getLines();

  res.json({
    success: true,
    lines: [c10Line, ...mataroLines]
  });
});

// Universal Stop Searcher (Across C-10 and all Mataró Bus stops)
app.get('/api/search/stops', (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q || q.length < 2) {
    return res.json({ success: true, results: [] });
  }

  const results = [];

  // Search C-10 stops
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
        zone: s.lon >= 2.289 ? 'Zona Maresme' : 'Zona AMB',
        lat: s.lat,
        lon: s.lon
      });
    }
  });

  // Search Mataró Bus stops
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
        zone: 'Mataró Urbà',
        lat: s.lat,
        lon: s.lon
      });
    }
  });

  res.json({
    success: true,
    query: q,
    results: results.slice(0, 25)
  });
});

// ==========================================
// 2. LINE C-10 CORRIDOR ENDPOINTS
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

// ==========================================
// 3. MATARÓ BUS (L1–L8) ENDPOINTS
// ==========================================

// List of all Mataró urban lines
app.get('/api/mataro/lines', (req, res) => {
  const lines = mataroTracker.getLines();
  res.json({ success: true, lines });
});

// Get Line details (stops, polyline geometry, and active buses with dead-zone estimation)
app.get('/api/mataro/line/:lineId', async (req, res) => {
  const { lineId } = req.params;
  const direction = req.query.direction === '1' ? '1' : '0';
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
// 4. HEALTH CHECK & SPA FALLBACK
// ==========================================

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
