/**
 * Ingestion & Analytics Background Worker
 * Runs autonomous Mataró Bus API polling and SQLite analytics
 * in an isolated Node.js process / thread.
 */

const ingestionDaemon = require('../ingestionDaemon');
const historyDb = require('../historyDb');
const reportCacheService = require('../reportCacheService');
const flightRecorder = require('../flightRecorder');
const mataroSiriClient = require('../mataroSiriClient');
const mataroTracker = require('../mataroTracker');
const { gapPath } = require('../core/geo/gapPath');
const trackerRegistry = require('../core/TrackerRegistry');

let parentPort = null;
try {
  const workerThreads = require('worker_threads');
  if (workerThreads.parentPort) {
    parentPort = workerThreads.parentPort;
  }
} catch {
  // worker_threads not in use or error
}

// ==========================================
// PROCESS-LEVEL RESILIENCE TRAPS (WORKER)
// ==========================================
process.on('unhandledRejection', (reason) => {
  console.error('[Worker] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Worker] Uncaught exception:', err);
});

/**
 * Send typed message to parent master process/thread
 */
function sendToMaster(type, payload = {}) {
  const message = { type, payload, timestamp: Date.now() };
  if (typeof process.send === 'function') {
    try {
      process.send(message);
    } catch {
      // Parent channel closed or disconnected
    }
  } else if (parentPort) {
    try {
      parentPort.postMessage(message);
    } catch {
      // Parent port closed
    }
  }
}

/**
 * Worker-owned upstream HTTP fetch used by proxyUpstreamHttp
 */
async function proxyUpstreamFetch(args = {}) {
  const url = String(args.url || '');
  if (!/^https?:\/\//.test(url)) {
    throw new Error('proxyUpstreamHttp: invalid url');
  }
  const options = (args.options && typeof args.options === 'object') ? { ...args.options } : {};
  if (typeof args.body === 'string' && !options.body) options.body = args.body;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(args.timeoutMs) || 6000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const bodyText = await res.text();
    return { status: res.status, bodyText };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Single dispatch table for DB RPC operations.
 */
async function executeDbOperation(op, args = {}) {
  switch (op) {
    case 'getVehicleTrail':
      return historyDb.getVehicleTrail(args.vehicleId, args.minutesBack ?? 60);

    case 'getLineDelayStats':
      return historyDb.getLineDelayStats(args.lineCode, args.hours ?? 24, args.lineId);

    case 'getMataroAvisos': {
      const avisos = await mataroTracker.fetchAvisos();
      return { avisos, timestamp: mataroTracker.avisosCacheTime };
    }

    case 'getMataroLiveVehicles': {
      const res = await mataroSiriClient.getLiveVehicles(String(args.lineRef || ''));
      if (mataroSiriClient.lastError) {
        throw new Error(`SIRI ${mataroSiriClient.lastError}`);
      }
      return res;
    }

    case 'getMataroStopArrivals': {
      const res = await mataroSiriClient.getStopArrivals(String(args.stopId || ''), String(args.lineRef || ''), { bypassCache: !!args.bypassCache });
      if (mataroSiriClient.lastError) {
        throw new Error(`SIRI ${mataroSiriClient.lastError}`);
      }
      return res;
    }

    case 'proxyUpstreamHttp':
      return proxyUpstreamFetch(args);

    case 'getJournalismReport':
      return historyDb.getJournalismReport(args.hours, args.allLinesCatalog || trackerRegistry.getAllLines());

    case 'getMonthlyReport':
      return historyDb.getMonthlyReport(args.month, args.allLinesCatalog || trackerRegistry.getAllLines());

    case 'exportDelayLogsCsv':
      return historyDb.exportDelayLogsCsv(args.hours, args.page, args.pageSize);

    case 'exportStopVisitsCsv':
      return historyDb.exportStopVisitsCsv(args.hours, args.page, args.pageSize);

    case 'getDelayIncidents':
      return historyDb.getDelayIncidents(args);

    case 'inspectDelayIncident':
      return historyDb.inspectDelayIncident(args);

    case 'getGpsGapHotspots':
      return historyDb.getGpsGapHotspots({ days: args.days, lineCode: args.lineCode, vehicleId: args.vehicleId, hide: args.hide });

    case 'getGpsGapPasses':
      return historyDb.getGpsGapPasses(args.ids, { days: args.days });

    case 'getGpsGapPaths':
      // The street each gap's bus drove without GPS, cut from its line's route
      // (its own direction first, then the other). No plausible stretch: null.
      return historyDb.getGpsGapsByIds(args.ids).map(g => {
        const routes = mataroTracker.routesData[String(g.lineCode).replace(/^L/, '')] || [];
        const pref = Number(g.direction) || 0;
        const order = [pref, ...routes.map((_, i) => i).filter(i => i !== pref)];
        for (const i of order) {
          const res = gapPath(routes[i] && routes[i].coords,
            { lat: g.lostLat, lon: g.lostLon }, { lat: g.regainedLat, lon: g.regainedLon }, g.gapSec);
          if (res) return { id: g.id, lineCode: g.lineCode, vehicleId: g.vehicleId, lostTs: g.lostTs, gapSec: g.gapSec, lengthM: res.lengthM, path: res.path };
        }
        return { id: g.id, lineCode: g.lineCode, vehicleId: g.vehicleId, lostTs: g.lostTs, gapSec: g.gapSec, lengthM: null, path: null };
      });

    case 'generateReport': {
      const catalog = Array.isArray(args.allLinesCatalog)
        ? args.allLinesCatalog
        : trackerRegistry.getAllLines();
      return reportCacheService.generateAndSaveReport(args.hours, catalog);
    }

    case 'checkScheduleDrift':
      return ingestionDaemon.checkScheduleDrift();

    default:
      throw new Error(`Unknown DB operation: ${String(op)}`);
  }
}

/**
 * Send a flat (unwrapped) DB_RESPONSE frame back to the master process.
 */
function sendDbResponse(response) {
  if (typeof process.send === 'function') {
    try {
      process.send(response);
    } catch {
      // Parent channel closed or disconnected
    }
  }
}

/**
 * Handle incoming command from supervisor / master
 */
function handleMasterMessage(message) {
  if (!message || typeof message !== 'object') return;
  const { type } = message;

  switch (type) {
    case 'PING':
      sendToMaster('PONG', {
        timestamp: Date.now(),
        pid: process.pid,
        memory: process.memoryUsage(),
        uptime: process.uptime(),
        activeVehicles: flightRecorder.getAllVehicles().length,
        upstream: mataroSiriClient.getUpstreamStatus(),
        noticesUpdatedAt: ingestionDaemon.noticesUpdatedAt || null,
        upstreamCanary: ingestionDaemon.upstreamCanary || null,
        fleetAnomaly: ingestionDaemon.fleetAnomaly || null,
        scheduleDrift: ingestionDaemon.scheduleDrift || null,
        // Freshest REAL observation across the fleet. Reads the flight
        // recorder's observedAt clock (threaded from the SIRI RecordedAtTime
        // through the tracker and daemon). Falls back to the legacy
        // timestamp/recordedAt fields only if observedAt is somehow absent.
        // An empty fleet yields null (unknown), never 0.
        lastObservationAt: Math.max(0, ...flightRecorder.getAllVehicles().map(vehicle =>
          Number(vehicle.observedAt) || Number(vehicle.timestamp) || Date.parse(vehicle.recordedAt) || 0)) || null
      });
      break;

    case 'TRIGGER_POLL':
      ingestionDaemon.pollMataroVehicles().catch(err => {
        console.error('[Worker] Manual poll error:', err.message);
      });
      break;

    case 'GENERATE_REPORT':
      reportCacheService.generateAllReports(trackerRegistry.getAllLines()).then(() => {
        sendToMaster('REPORT_GENERATED', { timestamp: Date.now() });
      }).catch(err => {
        console.error('[Worker] Manual report generation error:', err.message);
      });
      break;

    case 'DB_REQUEST': {
      const { requestId, op, args } = message;
      if (!requestId || !op) {
        return;
      }
      Promise.resolve()
        .then(() => executeDbOperation(op, args))
        .then((result) => {
          sendDbResponse({
            type: 'DB_RESPONSE',
            requestId,
            ok: true,
            result
          });
        })
        .catch((err) => {
          sendDbResponse({
            type: 'DB_RESPONSE',
            requestId,
            ok: false,
            error: err && err.message ? err.message : String(err)
          });
        });
      break;
    }

    case 'SHUTDOWN':
      console.log('[Worker] Graceful shutdown requested by master...');
      try {
        ingestionDaemon.stop();
        historyDb.close();
      } catch {}
      process.exit(0);
      break;

    default:
      console.warn(`[Worker] Unhandled master message type: ${type}`);
  }
}

// Attach listener to IPC channel
if (typeof process.on === 'function') {
  process.on('message', handleMasterMessage);
}
if (parentPort && typeof parentPort.on === 'function') {
  parentPort.on('message', handleMasterMessage);
}

// Forward daemon events to master process over IPC
ingestionDaemon.setIpcCallback((type, payload) => {
  sendToMaster(type, payload);
});

// Boot the background worker
async function bootWorker() {
  console.log(`[Worker] ⚡ Ingestion Worker Process initializing (PID: ${process.pid})...`);
  
  // 1. Initialize SQLite Database exclusively in worker
  try {
    historyDb.init();
    reportCacheService.setDatabase(historyDb);
    reportCacheService.setIpcCallback((type, payload) => sendToMaster(type, payload));
  } catch (err) {
    console.error('[Worker] Fatal: SQLite initialization failed:', err.message);
  }

  // 2. Enable persistence on FlightRecorder
  flightRecorder.enablePersistence(historyDb);

  // Wire flightRecorder historical queries directly through the worker's DB execution
  flightRecorder.setHistoryGateway((op, args) => Promise.resolve(executeDbOperation(op, args)));

  // 3. Initialize Tracker Registry
  try {
    await trackerRegistry.initAll();
  } catch (err) {
    console.warn('[Worker] Tracker Registry init warning:', err.message);
  }

  // 4. Launch ingestion daemon
  ingestionDaemon.start();

  // 5. Notify master that worker is ready
  sendToMaster('WORKER_READY', {
    pid: process.pid,
    version: '3.0.0-mataro'
  });

  console.log('[Worker] ✅ Ingestion Worker Ready and Listening.');
}

if (require.main === module) {
  bootWorker().catch(err => {
    console.error('[Worker] Fatal bootstrap error:', err);
    process.exit(1);
  });
}

module.exports = {
  executeDbOperation,
  bootWorker
};
