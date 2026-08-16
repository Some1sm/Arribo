const express = require('express');
const cors = require('cors');
const path = require('path');
const corridorTracker = require('./src/corridorTracker');

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

// 1. Target stop real-time ETA endpoint (Customizable by user)
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

// 2. All stops on the C-10 line with coordinates & metadata
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

// 3. Departures for any specific stop along the line
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

// 4. Live Corridor Tracking & Active Buses across checkpoints
app.get('/api/c10/live-corridor', async (req, res) => {
  const direction = req.query.direction === '0' ? '0' : '1';
  try {
    const data = await corridorTracker.getCorridorLiveTracking(direction);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'C-10 Realtime Bus Tracker',
    targetStop: "Plaça d'Itàlia (Mataró)",
    timestamp: new Date().toISOString()
  });
});

// Fallback to index.html for SPA routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚌 C-10 Real-Time Bus Tracker Server Running!`);
  console.log(`📍 Target Stop: Plaça d'Itàlia (Mataró)`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`====================================================`);
});
