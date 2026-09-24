class FlightRecorder {
  constructor() {
    this.vehicles = new Map(); // vehicleId -> VehicleState
    this.lineIndex = new Map(); // lineCodeUpper -> Set(vehicleId)
    this.maxMemoryBreadcrumbs = 60;
    const snapshotIntervalMs = Number.parseInt(process.env.VEHICLE_SNAPSHOT_INTERVAL_MS || '60000', 10);
    this.snapshotIntervalMs = Number.isFinite(snapshotIntervalMs) && snapshotIntervalMs > 0
      ? snapshotIntervalMs
      : 60000;
    this.deadReckonInterval = null;
    // Per-line delay stats cache so per-request reads never hit SQLite synchronously
    // more than once every STATS_CACHE_TTL_MS per line.
    this.statsCache = new Map(); // key -> { data, timestamp }
    this.statsCacheTtlMs = 30000;
    // When a background worker owns ingestion, the master process receives already-
    // extrapolated fleet states via syncFleetFromWorker and must not extrapolate again
    // (that would double the drift). The web server disables this after starting the bridge.
    this.autoExtrapolation = true;
    // Injectable persistence handle (worker-only). Null in the main process,
    // where all SQLite reads/writes are routed through the async gateway.
    this._db = null;
    // Async persistence gateway: async (op, args) => result. Backed by RPC in
    // the main process and by direct dispatch in the worker.
    this._gateway = null;
    // Maximum cumulative dead-reckoning window per vehicle (strict 90s window, §7.6).
    this.maxExtrapolationMs = 90000;
    // Hard ceiling on API-serving staleness (strict 90s window).
    this.staleEvictionCeilingMs = 90000;
    this.init();
  }

  /**
   * Enable/disable the automatic 5s dead-reckoning timer. Manual calls to
   * extrapolateStaleVehicles() remain available for tests and workers.
   * @param {boolean} enabled
   */
  setAutoExtrapolation(enabled) {
    this.autoExtrapolation = enabled !== false;
    if (!this.autoExtrapolation && this.deadReckonInterval) {
      clearInterval(this.deadReckonInterval);
      this.deadReckonInterval = null;
    }
  }

  /**
   * Attach a persistence backend. Called ONLY in the worker process by
   * ingestionWorker. When absent (main process), write paths are skipped
   * silently and reads fall through to the gateway.
   * @param {object} db - lazy-opened persistence handle exposing
   *   recordVehicleSnapshot() and recordDelayLog()
   */
  enablePersistence(db) {
    this._db = db || null;
  }

  /**
   * Install the async history gateway: async (op, args) => result. Called in
   * BOTH processes (server.js via WorkerBridge.historyQuery in main; direct
   * dispatch in worker) so read paths behave identically everywhere.
   * @param {Function} fn
   */
  setHistoryGateway(fn) {
    this._gateway = typeof fn === 'function' ? fn : null;
  }

  init() {
    // Start periodic dead-reckoning extrapolator every 5 seconds
    if (!this.deadReckonInterval && this.autoExtrapolation !== false) {
      this.deadReckonInterval = setInterval(() => this.extrapolateStaleVehicles(), 5000);
      if (this.deadReckonInterval && typeof this.deadReckonInterval.unref === 'function') {
        this.deadReckonInterval.unref();
      }
    }
  }

  ingestVehicle(snap) {
    if (!snap || !snap.vehicleId) return;

    const vId = String(snap.vehicleId);
    // Never ingest theoretical ghost vehicles into flightRecorder (only real physical telemetry)
    if (vId.startsWith('EST_') || snap.isGhostVehicle || snap.isTheoretical) return;

    const lineCode = String(snap.lineCode || '').toUpperCase();
    const now = Date.now();

    // A snapshot is FRESH EVIDENCE only when it is not itself a derived
    // (dead-reckoned / schedule-estimated / stale-replayed) emission. A derived
    // emission is a re-ingest of our own previous output and must NOT advance
    // the observation clock, otherwise a bus that lost telemetry would be
    // re-minted from this recorder every poll and never go stale (D1).
    const isFreshEvidence = !snap.isEstimated && !snap.isDeadReckoned;
    // The real observation time of the underlying feed, when known. Falls back
    // to the ingest moment for a genuinely fresh fix (it was just seen now).
    const snapObservedAt = Number(snap.observedAt);

    let v = this.vehicles.get(vId);
    if (!v) {
      v = {
        vehicleId: vId,
        lineId: snap.lineId || '',
        lineCode: lineCode,
        direction: snap.direction !== undefined ? String(snap.direction) : undefined,
        agency: snap.agency || 'Transit',
        plateNumber: snap.plateNumber || '',
        lat: Number(snap.lat),
        lon: Number(snap.lon),
        // Nullable: missing speed/delay stay UNKNOWN (null) instead of being
        // coerced to a measured 0/25. hasSpeed/hasDelay let consumers tell
        // "no data" apart from a genuine 0 (a stopped bus / punctual run).
        speedKmh: Number.isFinite(Number(snap.speedKmh)) ? Number(snap.speedKmh) : null,
        hasSpeed: snap.hasSpeed !== undefined ? Boolean(snap.hasSpeed) : Number.isFinite(Number(snap.speedKmh)),
        bearing: Number(snap.bearing || 0),
        delayMins: Number.isFinite(Number(snap.delayMins)) ? Number(snap.delayMins) : null,
        hasDelay: snap.hasDelay !== undefined ? Boolean(snap.hasDelay) : Number.isFinite(Number(snap.delayMins)),
        destination: snap.destination || '',
        isRealTime: snap.isRealTime !== false,
        // Schedule-estimated buses (no real GPS) must not be dead-reckoned:
        // their position is already recomputed from the timetable every poll,
        // and extrapolation would drag them off the drawn route.
        isEstimated: Boolean(snap.isEstimated || snap.isDeadReckoned),
        // Per-operator re-ingestion budget (ms). Retained for the (currently
        // single-operator) configuration; the serviceability gate uses the
        // strict 90s observation window, so this cannot raise it.
        serviceableMs: Number.isFinite(Number(snap.serviceableMs)) && Number(snap.serviceableMs) > 0
          ? Number(snap.serviceableMs)
          : undefined,
        status: 'active',
        // Ingest clock: when we last received ANY payload for this vehicle.
        lastSeen: now,
        // Observation clock: when the vehicle was last ACTUALLY OBSERVED by the
        // upstream feed. Only fresh evidence moves this; derived re-ingests keep
        // it so real observation age keeps growing (D1/D2). Feeds the
        // serviceability gate and the worker's lastObservationAt.
        observedAt: Number.isFinite(snapObservedAt) && snapObservedAt > 0 ? snapObservedAt : now,
        extrapolatedMs: 0,
        lastPersistedAt: 0,
        history: [],
        isTerminalLayover: Boolean(snap.isTerminalLayover),
        fromStop: snap.fromStop !== undefined ? snap.fromStop : undefined,
        toStop: snap.toStop !== undefined ? snap.toStop : undefined,
        fromSeq: snap.fromSeq !== undefined ? snap.fromSeq : undefined,
        toSeq: snap.toSeq !== undefined ? snap.toSeq : undefined,
        totalProgress: snap.totalProgress !== undefined ? snap.totalProgress : undefined,
        distanceToNextMeters: snap.distanceToNextMeters !== undefined ? snap.distanceToNextMeters : undefined
      };
      this.vehicles.set(vId, v);
    } else {
      v.lat = Number(snap.lat);
      v.lon = Number(snap.lon);
      v.speedKmh = Number.isFinite(Number(snap.speedKmh)) ? Number(snap.speedKmh) : null;
      if (snap.hasSpeed !== undefined) v.hasSpeed = Boolean(snap.hasSpeed);
      v.bearing = Number(snap.bearing || 0);
      v.delayMins = Number.isFinite(Number(snap.delayMins)) ? Number(snap.delayMins) : null;
      if (snap.hasDelay !== undefined) v.hasDelay = Boolean(snap.hasDelay);
      if (snap.destination) v.destination = snap.destination;
      if (snap.direction !== undefined) v.direction = String(snap.direction);
      v.isRealTime = snap.isRealTime !== false;
      v.isEstimated = Boolean(snap.isEstimated || snap.isDeadReckoned);
      if (snap.serviceableMs !== undefined) {
        v.serviceableMs = Number.isFinite(Number(snap.serviceableMs)) && Number(snap.serviceableMs) > 0
          ? Number(snap.serviceableMs) : undefined;
      }
      v.status = 'active';
      if (isFreshEvidence) {
        // A fresh real fix resets the dead-reckoning budget so vehicles that
        // regain telemetry can extrapolate again during the next cellular shadow.
        v.extrapolatedMs = 0;
        // Only fresh evidence advances the observation clock (D1). A derived
        // re-ingest of our own output leaves observedAt untouched.
        v.observedAt = Number.isFinite(snapObservedAt) && snapObservedAt > 0 ? snapObservedAt : now;
      }
      // Ingest clock always advances (any payload counts as an ingest).
      v.lastSeen = now;
      if (lineCode) v.lineCode = lineCode;
      v.isTerminalLayover = Boolean(snap.isTerminalLayover);
      if (snap.fromStop !== undefined) v.fromStop = snap.fromStop;
      if (snap.toStop !== undefined) v.toStop = snap.toStop;
      if (snap.fromSeq !== undefined) v.fromSeq = snap.fromSeq;
      if (snap.toSeq !== undefined) v.toSeq = snap.toSeq;
      if (snap.totalProgress !== undefined) v.totalProgress = snap.totalProgress;
      if (snap.distanceToNextMeters !== undefined) v.distanceToNextMeters = snap.distanceToNextMeters;
    }

    // Add to memory breadcrumb trail
    v.history.push({
      lat: v.lat,
      lon: v.lon,
      speedKmh: v.speedKmh,
      bearing: v.bearing,
      timestamp: now
    });
    if (v.history.length > this.maxMemoryBreadcrumbs) {
      v.history.shift();
    }

    // Index by line
    if (lineCode) {
      if (!this.lineIndex.has(lineCode)) this.lineIndex.set(lineCode, new Set());
      this.lineIndex.get(lineCode).add(vId);
    }

    // Persist live state independently of the polling frequency. The frontend
    // still receives every poll in memory, but one-minute sampling is enough
    // for the historical trail and prevents raw GPS rows dominating the DB.
    if (this._db && (!v.lastPersistedAt || now - v.lastPersistedAt >= this.snapshotIntervalMs)) {
      this._db.recordVehicleSnapshot({
        vehicleId: v.vehicleId,
        lineId: v.lineId,
        lineCode: v.lineCode,
        agency: v.agency,
        lat: v.lat,
        lon: v.lon,
        speedKmh: v.speedKmh,
        bearing: v.bearing,
        delayMins: v.delayMins,
        isRealTime: v.isRealTime,
        status: v.status,
        timestamp: now
      });
      v.lastPersistedAt = now;
    }
  }

  extrapolateStaleVehicles() {
    const now = Date.now();
    const expirationThresholdMs = this.maxExtrapolationMs; // 90s without a real observation = expired (§7.6)
    const extrapolateThresholdMs = 15 * 1000;              // >15s without a real observation = dead reckon

    for (const [vId, v] of this.vehicles.entries()) {
      // Age is measured on the OBSERVATION clock (observedAt), NOT the ingest
      // clock (lastSeen). A derived re-ingest of our own output refreshes
      // lastSeen but must not make a bus look freshly observed, otherwise the
      // tracker re-mint loop would keep it alive forever (D1).
      const observedAt = Number.isFinite(Number(v.observedAt)) ? Number(v.observedAt) : Number(v.lastSeen);
      const observationAge = Number.isFinite(observedAt) ? now - observedAt : Infinity;

      if (observationAge > expirationThresholdMs) {
        // Vehicle finished run or parked (or lost real telemetry for >90s).
        this.vehicles.delete(vId);
        if (v.lineCode && this.lineIndex.has(v.lineCode)) {
          this.lineIndex.get(v.lineCode).delete(vId);
        }
        continue;
      }

      // Dead-reckon using a REAL speed measurement and a known bearing. An
      // unknown speed is not projected (we cannot honestly move a bus whose
      // speed we do not have). The cumulative budget below lets the projection
      // ACCUMULATE across ticks (D6) rather than firing once, while remaining
      // bounded by maxExtrapolationMs total.
      const canProject = Number.isFinite(v.speedKmh) && v.speedKmh > 5 && v.bearing !== undefined && v.bearing !== null;
      if (observationAge > extrapolateThresholdMs && canProject) {
        // Bound TOTAL dead-reckoning to maxExtrapolationMs so vehicles never
        // drift arbitrarily far from their last real GPS fix. extrapolatedMs is
        // the accumulated projection; it is reset only by a fresh real fix
        // (see ingestVehicle), so a derived re-ingest cannot extend the budget.
        const projectedMs = (v.extrapolatedMs || 0);
        if (projectedMs >= this.maxExtrapolationMs) {
          continue;
        }
        // Project vehicle forward along bearing vector
        v.status = 'extrapolated';
        v.isEstimated = true;
        v.isRealTime = false;
        const stepMs = 5000;
        const stepCap = this.maxExtrapolationMs - projectedMs; // never exceed the total budget
        v.extrapolatedMs = Math.min(this.maxExtrapolationMs, projectedMs + stepMs);
        const speedMps = (v.speedKmh * 1000) / 3600;
        const distMeters = speedMps * (Math.min(stepMs, stepCap) / 1000); // 5-second interval distance
        const rad = (v.bearing * Math.PI) / 180;
        const dLat = (distMeters * Math.cos(rad)) / 111320;
        const dLon = (distMeters * Math.sin(rad)) / (111320 * Math.cos((v.lat * Math.PI) / 180));

        v.lat += dLat;
        v.lon += dLon;
      }
    }
  }

  /**
   * Serviceability gate: a vehicle whose last REAL observation is older than
   * maxExtrapolationMs (§7.6, 90s) must never reach API consumers. This guards
   * the MAIN process, where auto-extrapolation is disabled (server.js) and a
   * worker stall/restart gap could otherwise freeze night-service ghosts
   * (e.g. an N80 bus from 05:00 still served at 15:50). Healthy vehicles are
   * re-observed every ~20s poll, so they always stay well inside the window;
   * only genuinely dead entries fall out.
   *
   * The gate reads the OBSERVATION clock (observedAt), not the ingest clock
   * (lastSeen). The tracker re-mints a bus from this recorder's own previous
   * output when SIRI returns nothing, and the daemon re-ingests that clone on
   * every poll; keying on lastSeen would let those derived emissions refresh
   * the clock and keep a telemetry-less bus on the map all service day (D1).
   */
  _isServiceable(v) {
    if (!v) return false;
    // Fall back to lastSeen only when no observation clock was recorded (e.g.
    // a state built before this change); a fresh real fix always has one.
    const observedAt = Number.isFinite(Number(v.observedAt)) ? Number(v.observedAt) : Number(v.lastSeen);
    if (!Number.isFinite(observedAt)) return false;
    // Strict §7.6 window. staleEvictionCeilingMs is the same 90s cap; the old
    // per-vehicle serviceableMs "raise" was dead arithmetic (min capped it
    // back to the floor) and is gone, along with its incorrect "5 minutes" note.
    const threshold = Math.min(this.maxExtrapolationMs, this.staleEvictionCeilingMs);
    return (Date.now() - observedAt) <= threshold;
  }

  getLineVehicles(lineCode) {
    if (!lineCode) return [];
    const codeUpper = String(lineCode).toUpperCase().trim();
    const set = this.lineIndex.get(codeUpper);
    if (!set || set.size === 0) return [];

    const result = [];
    for (const vId of set) {
      const v = this.vehicles.get(vId);
      if (v && this._isServiceable(v)) result.push(v);
    }
    return result;
  }

  getAllVehicles() {
    return Array.from(this.vehicles.values()).filter(v => this._isServiceable(v));
  }

  async getVehicleTrail(vehicleId) {
    const v = this.vehicles.get(String(vehicleId));
    if (v && v.history && v.history.length > 0) {
      return v.history;
    }
    if (this._gateway) {
      // minutesBack (not row count): the DB path returns snapshots within this
      // recency window, capped at 100 rows by the SQL LIMIT.
      return this._gateway('getVehicleTrail', { vehicleId, minutesBack: 60 });
    }
    return [];
  }

  async getLineStats(lineCode, lineId = null) {
    // Cached for statsCacheTtlMs so frequent per-line HTTP requests never issue
    // synchronous SQLite scans on the web-server event loop.
    const key = `${String(lineCode || '').toUpperCase()}|${lineId || ''}`;
    const now = Date.now();
    const cached = this.statsCache.get(key);
    if (cached && (now - cached.timestamp) < this.statsCacheTtlMs) {
      return cached.data;
    }
    let data;
    if (this._gateway) {
      try {
        data = await this._gateway('getLineDelayStats', { lineCode, hours: 24, lineId });
      } catch (err) {
        // Delay stats are auxiliary: a DB RPC timeout (e.g. worker busy with
        // startup report scans) must never 500 the line-details route.
        console.warn(`[FlightRecorder] getLineDelayStats unavailable (${err.message}) — serving baseline stats.`);
        data = { totalSamples: 0, avgDelayMins: 0, maxDelayMins: 0, onTimePct: 100, latePct: 0, moderateLatePct: 0, severeLatePct: 0, isBaseline: true };
      }
    } else {
      // Mirror the persistence layer's empty-stats shape so callers see an
      // identical baseline whether or not a gateway is installed.
      data = { totalSamples: 0, avgDelayMins: 0, maxDelayMins: 0, onTimePct: 100, latePct: 0, moderateLatePct: 0, severeLatePct: 0, isBaseline: true };
    }
    this.statsCache.set(key, { data, timestamp: now });
    // Bound cache size defensively
    if (this.statsCache.size > 500) {
      const oldestKey = this.statsCache.keys().next().value;
      if (oldestKey !== undefined) this.statsCache.delete(oldestKey);
    }
    return data;
  }

  async getJournalismReport(hours = 24, allLinesCatalog = []) {
    if (!this._gateway) {
      throw new Error('No history gateway configured');
    }
    return this._gateway('getJournalismReport', { hours, allLinesCatalog });
  }

  syncFleetFromWorker(vehicles) {
    if (!Array.isArray(vehicles)) return;
    const newMap = new Map();
    const newLineIndex = new Map();
    const now = Date.now();

    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i];
      if (!v || !v.vehicleId) continue;
      const vId = String(v.vehicleId);
      const lineCode = String(v.lineCode || '').toUpperCase();

      const existing = this.vehicles.get(vId);
      const history = (v.history && Array.isArray(v.history) && v.history.length > 0)
        ? v.history
        : (existing ? existing.history : []);

      const state = {
        vehicleId: vId,
        lineId: v.lineId || '',
        lineCode: lineCode,
        direction: v.direction !== undefined ? String(v.direction) : (existing ? existing.direction : undefined),
        agency: v.agency || 'Transit',
        plateNumber: v.plateNumber || '',
        lat: Number(v.lat),
        lon: Number(v.lon),
        // Preserve unknown speed/delay as null (unknown), never coerce to 0.
        speedKmh: Number.isFinite(Number(v.speedKmh)) ? Number(v.speedKmh) : null,
        hasSpeed: v.hasSpeed !== undefined ? Boolean(v.hasSpeed) : Number.isFinite(Number(v.speedKmh)),
        bearing: Number(v.bearing || 0),
        delayMins: Number.isFinite(Number(v.delayMins)) ? Number(v.delayMins) : null,
        hasDelay: v.hasDelay !== undefined ? Boolean(v.hasDelay) : Number.isFinite(Number(v.delayMins)),
        destination: v.destination || '',
        isRealTime: v.isRealTime !== false,
        // Preserve the honest "estimated" label across IPC: schedule-synthesized
        // or dead-reckoned buses must keep their amber badge in the main process
        // instead of silently masquerading as real-time telemetry.
        isEstimated: Boolean(v.isEstimated || v.isDeadReckoned),
        serviceableMs: Number(v.serviceableMs) > 0 ? Number(v.serviceableMs) : undefined,
        status: v.status || 'active',
        // Ingest clock (advances on any payload) and observation clock (advances
        // only on real evidence). Both must cross IPC so the main process's
        // serviceability gate sees the true observation age (D1/D2).
        lastSeen: v.lastSeen || now,
        observedAt: Number.isFinite(Number(v.observedAt)) ? Number(v.observedAt) : (v.lastSeen || now),
        lastPersistedAt: v.lastPersistedAt || 0,
        extrapolatedMs: v.extrapolatedMs || (existing ? existing.extrapolatedMs : 0),
        history: history,
        isTerminalLayover: Boolean(v.isTerminalLayover),
        fromStop: v.fromStop !== undefined ? v.fromStop : (existing ? existing.fromStop : undefined),
        toStop: v.toStop !== undefined ? v.toStop : (existing ? existing.toStop : undefined),
        fromSeq: v.fromSeq !== undefined ? v.fromSeq : (existing ? existing.fromSeq : undefined),
        toSeq: v.toSeq !== undefined ? v.toSeq : (existing ? existing.toSeq : undefined),
        totalProgress: v.totalProgress !== undefined ? v.totalProgress : (existing ? existing.totalProgress : undefined),
        distanceToNextMeters: v.distanceToNextMeters !== undefined ? v.distanceToNextMeters : (existing ? existing.distanceToNextMeters : undefined)
      };

      newMap.set(vId, state);

      if (lineCode) {
        let set = newLineIndex.get(lineCode);
        if (!set) {
          set = new Set();
          newLineIndex.set(lineCode, set);
        }
        set.add(vId);
      }
    }

    this.vehicles = newMap;
    this.lineIndex = newLineIndex;
  }

  async exportCsv(hours = 48) {
    if (!this._gateway) {
      throw new Error('No history gateway configured');
    }
    return this._gateway('exportDelayLogsCsv', { hours });
  }
}

module.exports = new FlightRecorder();

