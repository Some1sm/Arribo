/**
 * Ingestion & Analytics Background Worker
 * Runs autonomous API polling, GTFS ingestion, and heavy SQLite analytics
 * in an isolated Node.js process / thread.
 */

const path = require('path');
const ingestionDaemon = require('../ingestionDaemon');
const historyDb = require('../historyDb');
const reportCacheService = require('../reportCacheService');
const flightRecorder = require('../flightRecorder');
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
        activeVehicles: flightRecorder.getAllVehicles().length,
        isRunning: ingestionDaemon.isRunning
      });
      break;

    case 'TRIGGER_REPORT': {
      const hours = payload.hours || 24;
      reportCacheService.generateAndSaveReport(hours, () => trackerRegistry.getAllLines())
        .then(rep => {
          sendToMaster('REPORT_CACHE_UPDATE', {
            timeframeHours: reportCacheService.normalizeHours(hours),
            report: rep,
            generatedAt: Date.now()
          });
        })
        .catch(err => {
          console.error('[IngestionWorker] Error generating triggered report:', err.message);
        });
      break;
    }

    case 'GET_STATUS':
      sendToMaster('STATUS', {
        pid: process.pid,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        activeVehicles: flightRecorder.getAllVehicles().length,
        isRunning: ingestionDaemon.isRunning
      });
      break;

    case 'SHUTDOWN':
      console.log('[IngestionWorker] Received SHUTDOWN command. Initiating graceful shutdown...');
      try {
        ingestionDaemon.stop();
      } catch (err) {
        console.error('[IngestionWorker] Error stopping ingestion daemon:', err.message);
      }
      try {
        historyDb.checkpointTruncate();
        historyDb.close();
      } catch (err) {
        console.error('[IngestionWorker] Error closing SQLite database handle:', err.message);
      }
      setTimeout(() => {
        process.exit(0);
      }, 50);
      break;

    default:
      // Unknown message type
      break;
  }
}

// Bind incoming message listeners
if (process.on) {
  process.on('message', handleMasterMessage);
}
if (parentPort) {
  parentPort.on('message', handleMasterMessage);
}

// Graceful signal handlers
const handleTermination = (sig) => {
  console.log(`[IngestionWorker] Received ${sig}. Closing database and exiting...`);
  try {
    ingestionDaemon.stop();
    historyDb.checkpointTruncate();
    historyDb.close();
  } catch (err) {
    // Ignore cleanup error on exit
  }
  process.exit(0);
};

process.on('SIGTERM', () => handleTermination('SIGTERM'));
process.on('SIGINT', () => handleTermination('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('[IngestionWorker] FATAL uncaughtException:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[IngestionWorker] unhandledRejection:', reason);
});

// Initialize Trackers, start autonomous ingestion daemon, and announce readiness
async function initWorker() {
  console.log('[IngestionWorker] 🚀 Booting background ingestion & analytics worker (PID:', process.pid, ')...');
  try {
    await trackerRegistry.initAll();
    console.log('[IngestionWorker] All multi-provider trackers initialized.');
  } catch (err) {
    console.warn('[IngestionWorker] Non-fatal tracker initialization warning:', err.message);
  }

  // Start background pollers and timers
  ingestionDaemon.start();

  // Announce worker is ready to master supervisor
  sendToMaster('WORKER_READY', {
    timestamp: Date.now(),
    pid: process.pid,
    version: '1.0.0',
    nodeVersion: process.version
  });

  console.log('[IngestionWorker] ✅ Worker ready and operational.');
}

initWorker().catch(err => {
  console.error('[IngestionWorker] Fatal error during worker startup:', err);
  process.exit(1);
});
