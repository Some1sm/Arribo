const fs = require('fs');
const path = require('path');
const flightRecorder = require('./flightRecorder');
const mataroTracker = require('./mataroTracker');
const reportCacheService = require('./reportCacheService');
const historyDb = require('./historyDb');

class IngestionDaemon {
  constructor() {
    this.isRunning = false;
    this.mataroPollTimer = null;
    this.disruptionsTimer = null;
    this.pruneTimer = null;
    this.journalismReportTimer = null;
    this.startupTimeouts = [];
    this.ipcCallback = null;
    this.lastFleetEmit = 0;
    this.lastWarnAt = new Map();
  }

  setIpcCallback(callback) {
    this.ipcCallback = typeof callback === 'function' ? callback : null;
  }

  emitIpc(type, payload) {
    try {
      if (typeof process.send === 'function') {
        process.send({ type, payload });
      }
    } catch (e) {
      // IPC channel disconnected
    }
    if (this.ipcCallback) {
      try {
        this.ipcCallback(type, payload);
      } catch (e) {
        // Callback error
      }
    }
  }

  emitFleetUpdate() {
    const now = Date.now();
    if (this.lastFleetEmit && (now - this.lastFleetEmit < 500)) return;
    this.lastFleetEmit = now;
    const vehicles = flightRecorder.getAllVehicles();
    this.emitIpc('FLEET_UPDATE', {
      timestamp: now,
      vehicles
    });
  }

  warnThrottled(key, message, throttleMs = 5 * 60 * 1000) {
    const now = Date.now();
    const last = this.lastWarnAt.get(key) || 0;
    if ((now - last) < throttleMs) return;
    this.lastWarnAt.set(key, now);
    console.warn(`[IngestionDaemon] ⚠️ [${key}] ${message}`);
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[IngestionDaemon] 🚀 Starting Mataró Bus Ingestion Server...');

    // Clear any existing startup timeouts
    this.startupTimeouts.forEach(t => clearTimeout(t));
    this.startupTimeouts = [];

    // Apply retention in background
    this.startupTimeouts.push(setTimeout(() => historyDb.pruneOldRecords(), 1000));

    // 1. Initial Ingestion Run
    this.startupTimeouts.push(setTimeout(() => this.pollMataroVehicles(), 200));
    this.startupTimeouts.push(setTimeout(() => this.pollDisruptions(), 800));

    // 2. Schedule Mataró Bus SIRI Ingestion (every 20 seconds to prevent rate limits)
    this.mataroPollTimer = setInterval(() => this.pollMataroVehicles(), 20000);

    // 3. Schedule Disruptions Ingestion (every 5 minutes)
    this.disruptionsTimer = setInterval(() => this.pollDisruptions(), 300000);

    // 4. Schedule DB pruning (every hour)
    this.pruneTimer = setInterval(() => historyDb.pruneOldRecords(), 3600 * 1000);

    // 5. Schedule Periodic Journalism Report Generation (every 30 minutes)
    this.startupTimeouts.push(setTimeout(() => this.generateJournalismReport(), 3000));
    this.journalismReportTimer = setInterval(() => this.generateJournalismReport(), 30 * 60 * 1000);

    console.log('[IngestionDaemon] ✅ Mataró Bus Ingestion Engine Active.');
  }

  stop() {
    this.isRunning = false;
    this.startupTimeouts.forEach(t => clearTimeout(t));
    this.startupTimeouts = [];
    if (this.mataroPollTimer) clearInterval(this.mataroPollTimer);
    if (this.disruptionsTimer) clearInterval(this.disruptionsTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.journalismReportTimer) clearInterval(this.journalismReportTimer);
    console.log('[IngestionDaemon] Ingestion Daemon Stopped.');
  }

  async pollMataroVehicles() {
    try {
      const activeLines = ['1', '2', '3', '4', '5', '6', '7', '8'];
      await Promise.allSettled(activeLines.map(async (lId) => {
        try {
          const details = await mataroTracker.getLineDetails(lId, 'both');
          if (details && Array.isArray(details.activeBuses)) {
            details.activeBuses.forEach(b => {
              flightRecorder.ingestVehicle({
                vehicleId: b.vehicleId || `mataro_${lId}_${b.plateNumber || 'bus'}`,
                lineId: lId,
                lineCode: `L${lId}`,
                agency: 'Mataró Bus (Avanza)',
                plateNumber: b.plateNumber || '',
                lat: b.lat,
                lon: b.lon,
                latitude: b.lat,
                longitude: b.lon,
                speedKmh: b.speedKmh || 25,
                bearing: b.bearing || 0,
                delayMins: b.delayMins || 0,
                destination: b.destination || '',
                isRealTime: !b.isEstimated
              });

              if (b.delayMins !== undefined) {
                historyDb.recordDelayLog({
                  lineId: lId,
                  lineCode: `L${lId}`,
                  agency: 'Mataró Bus (Avanza)',
                  stopId: b.toStop || 'Parada',
                  stopName: b.toStop || 'Parada',
                  delayMins: b.delayMins,
                  scheduledTime: '',
                  actualTime: '',
                  isRealTime: !b.isEstimated
                });
              }
            });
          }

          // Asynchronously warm stop departures cache in background
          mataroTracker.warmLineStopsCache(lId).catch(() => {});
        } catch (err) {
          // Skip individual line
        }
      }));
      this.emitFleetUpdate();
    } catch (e) {
      this.warnThrottled('pollMataroVehicles', `Mataró SIRI poll failed: ${e.message}`);
    }
  }

  async pollDisruptions() {
    try {
      const disruptions = await mataroTracker.getDisruptions();
      this.emitIpc('DISRUPTIONS_UPDATE', {
        timestamp: Date.now(),
        disruptions: Array.isArray(disruptions) ? disruptions : []
      });
    } catch (e) {
      this.warnThrottled('pollDisruptions', `Disruptions poll failed: ${e.message}`);
    }
  }

  async generateJournalismReport() {
    try {
      const allLines = mataroTracker.getLines();
      await reportCacheService.generateAllReports(allLines);
    } catch (e) {
      console.error('[IngestionDaemon] Journalism report generation error:', e.message);
    }
  }
}

module.exports = new IngestionDaemon();
