const historyDb = require('./historyDb');

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
    this.init();
  }

  init() {
    // Start periodic dead-reckoning extrapolator every 5 seconds
    if (!this.deadReckonInterval) {
      this.deadReckonInterval = setInterval(() => this.extrapolateStaleVehicles(), 5000);
    }
  }

  ingestVehicle(snap) {
    if (!snap || !snap.vehicleId) return;

    const vId = String(snap.vehicleId);
    const lineCode = String(snap.lineCode || '').toUpperCase();
    const now = Date.now();

    let v = this.vehicles.get(vId);
    if (!v) {
      v = {
        vehicleId: vId,
        lineId: snap.lineId || '',
        lineCode: lineCode,
        agency: snap.agency || 'Transit',
        plateNumber: snap.plateNumber || '',
        lat: Number(snap.lat),
        lon: Number(snap.lon),
        speedKmh: Number(snap.speedKmh || 0),
        bearing: Number(snap.bearing || 0),
        delayMins: Number(snap.delayMins || 0),
        destination: snap.destination || '',
        isRealTime: snap.isRealTime !== false,
        status: 'active',
        lastSeen: now,
        lastPersistedAt: 0,
        history: []
      };
      this.vehicles.set(vId, v);
    } else {
      v.lat = Number(snap.lat);
      v.lon = Number(snap.lon);
      v.speedKmh = Number(snap.speedKmh || 0);
      v.bearing = Number(snap.bearing || 0);
      v.delayMins = Number(snap.delayMins || 0);
      if (snap.destination) v.destination = snap.destination;
      v.isRealTime = snap.isRealTime !== false;
      v.status = 'active';
      v.lastSeen = now;
      if (lineCode) v.lineCode = lineCode;
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
    if (!v.lastPersistedAt || now - v.lastPersistedAt >= this.snapshotIntervalMs) {
      historyDb.recordVehicleSnapshot({
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

  recordArrivalDelay(entry) {
    historyDb.recordDelayLog(entry);
  }

  extrapolateStaleVehicles() {
    const now = Date.now();
    const expirationThresholdMs = 5 * 60 * 1000; // 5 mins without GPS = expired
    const extrapolateThresholdMs = 18 * 1000;     // >18s without GPS = dead reckon

    for (const [vId, v] of this.vehicles.entries()) {
      const elapsed = now - v.lastSeen;

      if (elapsed > expirationThresholdMs) {
        // Vehicle finished run or parked
        this.vehicles.delete(vId);
        if (v.lineCode && this.lineIndex.has(v.lineCode)) {
          this.lineIndex.get(v.lineCode).delete(vId);
        }
        continue;
      }

      if (elapsed > extrapolateThresholdMs && v.speedKmh > 5 && v.bearing !== undefined) {
        // Project vehicle forward along bearing vector
        v.status = 'extrapolated';
        const speedMps = (v.speedKmh * 1000) / 3600;
        const distMeters = speedMps * 5; // 5-second interval distance
        const rad = (v.bearing * Math.PI) / 180;
        const dLat = (distMeters * Math.cos(rad)) / 111320;
        const dLon = (distMeters * Math.sin(rad)) / (111320 * Math.cos((v.lat * Math.PI) / 180));

        v.lat += dLat;
        v.lon += dLon;
      }
    }
  }

  getLineVehicles(lineCode) {
    if (!lineCode) return [];
    const codeUpper = String(lineCode).toUpperCase().trim();
    const set = this.lineIndex.get(codeUpper);
    if (!set || set.size === 0) return [];

    const result = [];
    for (const vId of set) {
      const v = this.vehicles.get(vId);
      if (v) result.push(v);
    }
    return result;
  }

  getAllVehicles() {
    return Array.from(this.vehicles.values());
  }

  getVehicleTrail(vehicleId) {
    const v = this.vehicles.get(String(vehicleId));
    if (v && v.history && v.history.length > 0) {
      return v.history;
    }
    return historyDb.getVehicleTrail(vehicleId, 60);
  }

  getLineStats(lineCode, lineId = null) {
    return historyDb.getLineDelayStats(lineCode, 24, lineId);
  }

  getJournalismReport(hours = 24, allLinesCatalog = []) {
    return historyDb.getJournalismReport(hours, allLinesCatalog);
  }

  exportCsv(hours = 48) {
    return historyDb.exportDelayLogsCsv(hours);
  }
}

module.exports = new FlightRecorder();
