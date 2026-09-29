const flightRecorder = require('./flightRecorder');
const mataroTracker = require('./mataroTracker');
const reportCacheService = require('./reportCacheService');
const historyDb = require('./historyDb');
const tripMatcher = require('./core/schedule/tripMatcher');
const mataroSchedules = require('./data/mataroSchedules');
const timeEngine = require('./core/time/timeEngine');
const calendarEngine = require('./core/time/calendarEngine');
const siriClient = require('./mataroSiriClient');

class IngestionDaemon {
  constructor() {
    this.isRunning = false;
    this.stopping = false;
    this.openVisits = new Map();
    this.mataroPollTimer = null;
    this.disruptionsTimer = null;
    this.pruneTimer = null;
    this.journalismReportTimer = null;
    this.canaryTimer = null;
    this.startupTimeouts = [];
    this.ipcCallback = null;
    this.lastFleetEmit = 0;
    this.lastWarnAt = new Map();
    this.upstreamCanary = null;
    this.fleetAnomaly = null;
    this.zeroFleetSince = null;
    this.scheduleDrift = null;
    this.driftTimer = null;
    this.lastDriftDate = null;
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
      vehicles,
      anomaly: this.fleetAnomaly,
      upstreamCanary: this.upstreamCanary,
      scheduleDrift: this.scheduleDrift
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

    // 6. Schedule Upstream Auth Canary Poll (first at 1.5s, then every 5 minutes)
    this.startupTimeouts.push(setTimeout(() => this.pollCanary(), 1500));
    this.canaryTimer = setInterval(() => this.pollCanary(), 5 * 60 * 1000);

    // 7. Schedule Daily Timetable Drift Check at 04:1x Madrid time (checked every 60s)
    this.driftTimer = setInterval(() => this.checkScheduleDriftSchedule(), 60000);

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
    if (this.canaryTimer) clearInterval(this.canaryTimer);
    this.canaryTimer = null;
    if (this.driftTimer) clearInterval(this.driftTimer);
    this.driftTimer = null;
    this.flushAllVisits();
    console.log('[IngestionDaemon] Ingestion Daemon Stopped.');
  }

  /**
   * Helper to determine if a line is outside scheduled revenue service window.
   * Window: from (first departure − 15 min) to (last departure + duration + 20 min).
   * Respects holiday-aware day type and midnight rollover (E9).
   */
  isOutsideRevenueService(lineId, at = Date.now()) {
    const c = calendarEngine.getDateComponents(at, 'Europe/Madrid');
    if (!c) return false;
    const secOfDay = c.hour * 3600 + c.minute * 60 + c.second;
    const { dayType } = tripMatcher.resolveDayType(at);
    const winToday = mataroSchedules.getServiceWindow(lineId, dayType);
    if (winToday && secOfDay >= winToday.startSec && secOfDay <= winToday.endSec) {
      return false;
    }
    // Check if it's late-night spillover from yesterday's service window
    const yesterdayMs = at - 86400 * 1000;
    const { dayType: prevDayType } = tripMatcher.resolveDayType(yesterdayMs);
    const winYesterday = mataroSchedules.getServiceWindow(lineId, prevDayType);
    if (winYesterday && winYesterday.endSec > 86400) {
      const secFromYesterday = secOfDay + 86400;
      if (secFromYesterday <= winYesterday.endSec) {
        return false;
      }
    }
    return true;
  }

  flushVisit(v) {
    if (!v) return;

    // Measured delay = our own passing time minus the published time of the
    // trip the feed's delay points to (v.scheduledTime). Matching the passing
    // time to the NEAREST departure instead would cap every delay at half a
    // headway: a bus 13 min late on an 18 min line would be recorded as 5 min
    // early on the next trip. Whether the nearest departure independently
    // lands on that same trip is kept separately in tripAgrees (1/0/null).
    let measuredDelayMins = null;
    let tripAgrees = null;
    const passingAt = v.passingAt || v.lastObservedAt || v.lastTs;
    const publishedSec = v.scheduledTime ? timeEngine.timeStringToSeconds(v.scheduledTime) : NaN;
    if (passingAt && Number.isFinite(publishedSec)) {
      try {
        const net = timeEngine.getNetworkTime('Europe/Madrid', new Date(passingAt));
        const passingSec = net.hour * 3600 + net.minute * 60 + net.second;
        measuredDelayMins = Math.round(tripMatcher.circularDiffSec(passingSec, publishedSec) / 60);
        const nearest = tripMatcher.matchTrip({
          lineId: String(v.lineCode || '').replace(/^L/i, ''),
          direction: v.direction,
          stopName: v.stopName,
          at: passingAt
        });
        const nearestSec = nearest && nearest.matched ? timeEngine.timeStringToSeconds(nearest.scheduledTime) : NaN;
        if (Number.isFinite(nearestSec)) {
          tripAgrees = tripMatcher.circularDiffSec(nearestSec, publishedSec) === 0 ? 1 : 0;
        }
      } catch {}
    }

    historyDb.recordStopVisit({
      vehicleId: v.vehicleId,
      lineCode: v.lineCode,
      direction: v.direction,
      stopName: v.stopName,
      firstTs: v.firstTs,
      lastTs: v.lastTs,
      delayMins: v.lastDelay,
      sampleCount: v.count,
      scheduledTime: v.scheduledTime,
      actualTime: v.actualTime,
      timesSource: v.timesSource,
      isRealTime: v.isRealTime,
      measuredDelayMins: Number.isFinite(measuredDelayMins) ? measuredDelayMins : null,
      measuredMethod: Number.isFinite(measuredDelayMins) ? 'operator_trip' : '',
      tripAgrees,
      source: 'live'
    });
  }

  flushExpiredVisits(now = Date.now(), maxAgeMs = 5 * 60 * 1000) {
    for (const [vehId, v] of this.openVisits.entries()) {
      if (now - v.lastTs > maxAgeMs) {
        this.flushVisit(v);
        this.openVisits.delete(vehId);
      }
    }
  }

  flushAllVisits() {
    for (const v of this.openVisits.values()) {
      this.flushVisit(v);
    }
    this.openVisits.clear();
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
              // Also ignore depot telemetry outside revenue service hours (E9 service window from timetable).
              const outsideRevenue = this.isOutsideRevenueService(lId, observedAt || Date.now());
              // An unknown speed is not a confirmed measurement, so a
              // speed-based parked check must NOT be taken on it (the
              // per-vehicle terminal gate in the tracker already handles the
              // position-based part). Only a real speed drives this branch.
              const speed = hasSpeed ? speedKmh : null;
              const isLayover = b.isTerminalLayover || outsideRevenue ||
                (speed !== null && speed <= 3 && (delayMins !== null && (delayMins > 10 || delayMins < -5)));
              // Consistency (D4 & E8): a value Observatori would refuse to store
              // (unknown, sentinel <= -15, or outside plausible range) must not be advertised
              // as an authoritative live delay either. -15 is upstream sentinel.
              const isPlausibleDelay = hasDelay && delayMins > -15 && delayMins <= 300;
              if (isPlausibleDelay && !isLayover) {
                const vehId = b.vehicleId || (b.plateNumber ? `mataro_${lId}_${b.plateNumber}` : `mataro_${lId}_bus`);
                const stopName = b.toStop || 'Parada';
                const direction = b.direction !== undefined ? String(b.direction) : '';
                const lineCode = `L${lId}`;
                const sampleTs = observedAt || Date.now();
                const visitKey = `${lineCode}|${direction}|${stopName}`;

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
                  at: sampleTs
                });

                const open = this.openVisits.get(vehId);
                // Duplicate observations check: if same GPS fix was polled twice, skip
                if (open && open.key === visitKey && observedAt && open.lastObservedAt && observedAt === open.lastObservedAt) {
                  return;
                }

                const distToStop = Number.isFinite(Number(b.distanceToNextMeters)) ? Number(b.distanceToNextMeters) : null;
                const isWithin30m = distToStop !== null && distToStop <= 30;

                if (open && open.key === visitKey && (sampleTs - open.lastTs <= 5 * 60 * 1000) && sampleTs >= open.firstTs - 60000) {
                  // Update existing visit
                  open.lastTs = sampleTs;
                  open.lastDelay = delayMins;
                  open.count++;
                  if (isWithin30m) {
                    open.passingAt = observedAt || sampleTs;
                  }
                  if (trip.matched) {
                    open.scheduledTime = trip.scheduledTime;
                    open.actualTime = trip.actualTime;
                    open.timesSource = 'derived_timetable';
                  }
                  open.isRealTime = !b.isEstimated;
                  open.lastObservedAt = observedAt || null;
                } else {
                  // Flush existing visit for this vehicle if present
                  if (open) {
                    if (!open.passingAt) {
                      open.passingAt = observedAt || sampleTs;
                    }
                    this.flushVisit(open);
                  }
                  // Open new visit
                  const newVisit = {
                    key: visitKey,
                    vehicleId: vehId,
                    lineCode,
                    direction,
                    stopName,
                    firstTs: sampleTs,
                    lastTs: sampleTs,
                    lastDelay: delayMins,
                    count: 1,
                    scheduledTime: trip.matched ? trip.scheduledTime : '',
                    actualTime: trip.matched ? trip.actualTime : '',
                    timesSource: trip.matched ? 'derived_timetable' : '',
                    isRealTime: !b.isEstimated,
                    lastObservedAt: observedAt || null,
                    passingAt: isWithin30m ? (observedAt || sampleTs) : null
                  };
                  this.openVisits.set(vehId, newVisit);
                  // Bound the map at 500 entries (flush oldest when exceeded)
                  if (this.openVisits.size > 500) {
                    let oldestKey = null;
                    let oldestTs = Infinity;
                    for (const [k, v] of this.openVisits.entries()) {
                      if (v.lastTs < oldestTs) {
                        oldestTs = v.lastTs;
                        oldestKey = k;
                      }
                    }
                    if (oldestKey) {
                      this.flushVisit(this.openVisits.get(oldestKey));
                      this.openVisits.delete(oldestKey);
                    }
                  }
                }

                historyDb.recordDelayLog({
                  vehicleId: vehId,
                  lineId: lId,
                  lineCode,
                  agency: 'Mataró Bus (Avanza)',
                  // stop_id stays the stop NAME: getDelayIncidents groups and
                  // geolocates by it, so its semantics must not change. The
                  // numeric schedule id is only needed for the join above.
                  stopId: stopName,
                  stopName,
                  delayMins,
                  scheduledTime: trip.matched ? trip.scheduledTime : '',
                  actualTime: trip.matched ? trip.actualTime : '',
                  direction,
                  timesSource: trip.matched ? 'derived_timetable' : '',
                  isRealTime: !b.isEstimated,
                  observedAt: observedAt || null
                });
              }
            });
          }

        } catch {
          // Skip individual line
        }
      }));
      if (!this.stopping) {
        this.flushExpiredVisits();
        this.checkFleetAnomaly();
        this.emitFleetUpdate();
      }
    } catch (e) {
      this.warnThrottled('pollMataroVehicles', `Mataró SIRI poll failed: ${e.message}`);
    }
  }

  async pollCanary() {
    const checkedAt = Date.now();
    try {
      await siriClient.getStopArrivals('1016', '', { bypassCache: true, direct: true });
      if (siriClient.lastError) {
        this.upstreamCanary = { ok: false, error: siriClient.lastError, checkedAt };
      } else {
        this.upstreamCanary = { ok: true, error: null, checkedAt };
      }
    } catch (err) {
      const errName = siriClient.lastError || (err.message && err.message.startsWith('SIRI ') ? err.message.slice(5) : 'upstream_error');
      this.upstreamCanary = { ok: false, error: errName, checkedAt };
    }
    if (!this.stopping) {
      this.emitFleetUpdate();
    }
  }

  checkFleetAnomaly(now = Date.now()) {
    const liveVehicles = flightRecorder.getAllVehicles();
    const liveCount = liveVehicles.length;

    const net = timeEngine.getNetworkTime('Europe/Madrid', new Date(now));
    const nowSec = net.hour * 3600 + net.minute * 60 + net.second;
    const { dayType } = tripMatcher.resolveDayType(now);
    let scheduled = 0;
    for (const lineId of ['1', '2', '3', '4', '5', '6', '7', '8']) {
      scheduled += mataroSchedules.getScheduledFleetRequirement(lineId, dayType, nowSec);
    }

    if (liveCount > 0) {
      this.zeroFleetSince = null;
      this.fleetAnomaly = null;
    } else {
      if (!this.zeroFleetSince) {
        this.zeroFleetSince = now;
      }
      if (scheduled >= 3 && (now - this.zeroFleetSince >= 5 * 60 * 1000)) {
        this.fleetAnomaly = 'no_vehicles_during_service';
      } else {
        this.fleetAnomaly = null;
      }
    }
    return { scheduled, liveCount, anomaly: this.fleetAnomaly };
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

  checkScheduleDriftSchedule(now = Date.now()) {
    const net = timeEngine.getNetworkTime('Europe/Madrid', new Date(now));
    if (net.hour === 4 && net.minute >= 10 && net.minute <= 20) {
      const todayKey = `${net.year}-${net.month}-${net.day}`;
      if (this.lastDriftDate !== todayKey) {
        this.lastDriftDate = todayKey;
        this.checkScheduleDrift().catch(() => {});
      }
    }
  }

  async checkScheduleDrift() {
    try {
      const scraper = require('../scripts/scrape_maresme_timetables');
      const fs = require('fs');
      const path = require('path');
      const shippedPath = path.resolve(__dirname, 'data/mataro_schedules.seasons.json');
      if (!fs.existsSync(shippedPath)) {
        return null;
      }
      const shipped = JSON.parse(fs.readFileSync(shippedPath, 'utf8'));
      const freshSeasons = {};
      const notes = [];
      for (const season of scraper.SEASONS) {
        freshSeasons[season] = await scraper.buildSeason(season, notes);
      }
      const differences = scraper.diffAgainstShipped(shipped.seasons, freshSeasons);
      this.scheduleDrift = {
        drift: differences.length > 0,
        checkedAt: new Date().toISOString(),
        differencesCount: differences.length
      };
      this.emitIpc('SCHEDULE_DRIFT_UPDATE', this.scheduleDrift);
      return this.scheduleDrift;
    } catch (err) {
      console.warn('[IngestionDaemon] Schedule drift check failed:', err.message);
      return null;
    }
  }
}

const daemonInstance = new IngestionDaemon();
daemonInstance.IngestionDaemon = IngestionDaemon;
module.exports = daemonInstance;
