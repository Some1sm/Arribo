/**
 * Ingestion & Analytics Background Worker
 * Runs autonomous Mataró Bus API polling and SQLite analytics
 * in an isolated Node.js process / thread.
 */

const path = require('path');
const fs = require('fs');
const ingestionDaemon = require('../ingestionDaemon');
const historyDb = require('../historyDb');
const reportCacheService = require('../reportCacheService');
const flightRecorder = require('../flightRecorder');
const mataroSiriClient = require('../mataroSiriClient');
const mataroTracker = require('../mataroTracker');
const trackerRegistry = require('../core/TrackerRegistry');

let parentPort = null;
try {
  const workerThreads = require('worker_threads');
  if (workerThreads.parentPort) {
    parentPort = workerThreads.parentPort;
  }
} catch (e) {
  // worker_threads not in use or error
}

/**
 * Send typed message to parent master process/thread
 */
function sendToMaster(type, payload = {}) {
  const message = { type, payload, timestamp: Date.now() };
  if (typeof process.send === 'function') {
    try {
      process.send(message);
    } catch (err) {
      // Parent channel closed or disconnected
    }
  } else if (parentPort) {
    try {
      parentPort.postMessage(message);
    } catch (err) {
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

    case 'getMataroLiveVehicles':
      return mataroSiriClient.getLiveVehicles(String(args.lineRef || ''));

    case 'getMataroStopArrivals':
      return mataroSiriClient.getStopArrivals(String(args.stopId || ''), String(args.lineRef || ''));

    case 'proxyUpstreamHttp':
      return proxyUpstreamFetch(args);

    case 'getJournalismReport':
      return historyDb.getJournalismReport(args.hours, args.allLinesCatalog || trackerRegistry.getAllLines());

    case 'exportDelayLogsCsv':
      return historyDb.exportDelayLogsCsv(args.hours);

    case 'generateReport': {
      const catalog = Array.isArray(args.allLinesCatalog)
        ? args.allLinesCatalog
        : trackerRegistry.getAllLines();
      return reportCacheService.generateAndSaveReport(args.hours, catalog);
    }

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
    } catch (err) {
      // Parent channel closed or disconnected
    }
  }
}

/**
 * Handle incoming command from supervisor / master
 */
function handleMasterMessage(message) {
  if (!message || typeof message !== 'object') return;
  const { type, payload = {} } = message;

  switch (type) {
    case 'PING':
      sendToMaster('PONG', {
        timestamp: Date.now(),
        pid: process.pid,
        memory: process.memoryUsage(),
        uptime: process.uptime(),
        activeVehicles: flightRecorder.getAllVehicles().length
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
      } catch (e) {}
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

bootWorker().catch(err => {
  console.error('[Worker] Fatal bootstrap error:', err);
  process.exit(1);
});
