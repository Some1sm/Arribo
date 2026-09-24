const flightRecorder = require('./flightRecorder');
const mataroTracker = require('./mataroTracker');
const reportCacheService = require('./reportCacheService');
const historyDb = require('./historyDb');
const tripMatcher = require('./core/schedule/tripMatcher');

class IngestionDaemon {
  constructor() {
    this.isRunning = false;
    this.stopping = false;
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
    if (this.ipcCallback) {
      try {
        this.ipcCallback(type, payload);
        return;
      } catch {
        // Callback error
      }
    }
    try {
      if (typeof process.send === 'function') {
        process.send({ type, payload });
      }
    } catch {
      // IPC channel disconnected
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

    // 5. Schedule Periodic Journalism Report Generation (first at 45s to avoid boot spike, then every 30 minutes)
    this.startupTimeouts.push(setTimeout(() => this.generateJournalismReport(), 45000));
    this.journalismReportTimer = setInterval(() => this.generateJournalismReport(), 30 * 60 * 1000);

    console.log('[IngestionDaemon] ✅ Mataró Bus Ingestion Engine Active.');
  }

  stop() {
    this.stopping = true;
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
          if (this.stopping) return;
          if (details && Array.isArray(details.activeBuses)) {
            details.activeBuses.forEach(b => {
              // Never ingest synthetic timetable ghost buses into flightRecorder!
              if (b.isGhostVehicle || (b.vehicleId && String(b.vehicleId).startsWith('EST_'))) {
                return;
              }

              // Resolve the real observation time of this bus, or null. This is
              // the per-vehicle timestamp that was previously dropped entirely,
              // which left observationAgeMs permanently null. A derived
              // (dead-reckoned / estimated) emission carries the last REAL
              // observation, never the moment we re-emitted our own guess, so
              // the flight recorder can tell fresh evidence from a re-ingest.
              const isDerived = Boolean(b.isEstimated) || b.isRealTime === false;
              const resolveObservedAt = (bus) => {
                const cand = Number(bus.observedAt);
                if (Number.isFinite(cand) && cand > 0) return cand;
                const fresh = bus.freshness && Number(bus.freshness.observedAt);
                if (Number.isFinite(fresh) && fresh > 0) return fresh;
                // A derived emission has no independent observation stamp: its
                // timestamp/recordedAt are the re-emit moment, not a new
                // measurement. Do NOT let those fake a fresh observation here.
                if (isDerived) return null;
                if (Number.isFinite(Number(bus.timestamp)) && Number(bus.timestamp) > 0) return Number(bus.timestamp);
                const rec = bus.recordedAt ? Date.parse(bus.recordedAt) : NaN;
                if (Number.isFinite(rec) && rec > 0) return rec;
                return null;
              };
              const observedAt = resolveObservedAt(b);

              // Speed: a missing measurement stays UNKNOWN (null), not 25. A real
              // measured 0 (bus stopped) stays 0 and stays distinguishable.
              const hasSpeed = b.hasSpeed !== undefined
                ? Boolean(b.hasSpeed)
                : Number.isFinite(b.speedKmh);
              const speedKmh = hasSpeed ? Number(b.speedKmh) : null;

              // Delay: "not reported by the feed" stays UNKNOWN (null) and is
              // flagged, so it is neither counted as punctual nor advertised live
              // as if authoritative. A measured 0 stays 0.
              const hasDelay = b.hasDelay !== undefined
                ? Boolean(b.hasDelay)
                : Number.isFinite(b.delayMins);
              const delayMins = hasDelay ? Number(b.delayMins) : null;

              flightRecorder.ingestVehicle({
                vehicleId: b.vehicleId || `mataro_${lId}_${b.plateNumber || 'bus'}`,
                lineId: lId,
                lineCode: `L${lId}`,
                agency: 'Mataró Bus (Avanza)',
                direction: b.direction !== undefined ? String(b.direction) : undefined,
                plateNumber: b.plateNumber || '',
                lat: b.lat,
                lon: b.lon,
                latitude: b.lat,
                longitude: b.lon,
                speedKmh,
                hasSpeed,
                bearing: b.bearing || 0,
                delayMins,
                hasDelay,
                destination: b.destination || '',
                isRealTime: !b.isEstimated,
                isEstimated: Boolean(b.isEstimated),
                // The real upstream observation time (null when unknown — never
                // faked to now). flightRecorder only advances its observation
                // clock on fresh (non-derived) evidence.
                observedAt,
                serviceableMs: 90 * 1000,
                isTerminalLayover: Boolean(b.isTerminalLayover),
                fromStop: b.fromStop !== undefined ? b.fromStop : undefined,
                toStop: b.toStop !== undefined ? b.toStop : undefined,
                fromSeq: b.fromSeq !== undefined ? b.fromSeq : undefined,
                toSeq: b.toSeq !== undefined ? b.toSeq : undefined,
                totalProgress: b.totalProgress !== undefined ? b.totalProgress : undefined,
                distanceToNextMeters: b.distanceToNextMeters !== undefined ? b.distanceToNextMeters : undefined
              });

              // Sanity check: Do NOT record delay logs for ghost buses, parked vehicles, or terminal layovers.
              // Also ignore depot telemetry outside revenue service hours (23:00 - 05:20 Europe/Madrid).
              const madridTimeStr = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
              const [mH, mM] = madridTimeStr.split(':').map(Number);
              const isDepotHours = mH < 5 || (mH === 5 && mM < 20) || mH >= 23;
              // An unknown speed is not a confirmed measurement, so a
              // speed-based parked check must NOT be taken on it (the
              // per-vehicle terminal gate in the tracker already handles the
              // position-based part). Only a real speed drives this branch.
              const speed = hasSpeed ? speedKmh : null;
              const isLayover = b.isTerminalLayover || isDepotHours ||
                (speed !== null && speed <= 3 && (delayMins !== null && (delayMins > 10 || delayMins < -5)));
              // Consistency (D4): a value Observatori would refuse to store
              // (unknown, or outside the plausible range) must not be advertised
              // as an authoritative live delay either, so the same bus cannot
              // read "+400 min" on the map while Observatori records nothing.
              const isPlausibleDelay = hasDelay && delayMins >= -15 && delayMins <= 300;
              if (isPlausibleDelay && !isLayover) {
                const vehId = b.vehicleId || (b.plateNumber ? `mataro_${lId}_${b.plateNumber}` : `mataro_${lId}_bus`);
                // Recover the scheduled/actual passing time from the static
                // timetable. The feed reports a delay but never the time it is
                // measured against, so these times are DERIVED, not observed —
                // times_source records that so Observatori can say so.
                const trip = tripMatcher.matchTrip({
                  lineId: lId,
                  direction: b.direction,
                  toSeq: b.toSeq,
                  stopName: b.toStop,
                  delayMins,
                  at: observedAt || Date.now()
                });
                historyDb.recordDelayLog({
                  vehicleId: vehId,
                  lineId: lId,
                  lineCode: `L${lId}`,
                  agency: 'Mataró Bus (Avanza)',
                  // stop_id stays the stop NAME: getDelayIncidents groups and
                  // geolocates by it, so its semantics must not change. The
                  // numeric schedule id is only needed for the join above.
                  stopId: b.toStop || 'Parada',
                  stopName: b.toStop || 'Parada',
                  delayMins,
                  scheduledTime: trip.matched ? trip.scheduledTime : '',
                  actualTime: trip.matched ? trip.actualTime : '',
                  direction: b.direction !== undefined ? String(b.direction) : '',
                  timesSource: trip.matched ? 'derived_timetable' : '',
                  isRealTime: !b.isEstimated
                });
              }
            });
          }

        } catch {
          // Skip individual line
        }
      }));
      if (!this.stopping) this.emitFleetUpdate();
    } catch (e) {
      this.warnThrottled('pollMataroVehicles', `Mataró SIRI poll failed: ${e.message}`);
    }
  }

  async pollDisruptions() {
    try {
      const disruptions = await mataroTracker.getDisruptions();
      if (this.stopping) return;
      this.noticesUpdatedAt = Date.now();
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
