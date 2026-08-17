const flightRecorder = require('./flightRecorder');
const ambTracker = require('./ambTracker');
const mataroTracker = require('./mataroTracker');
const corridorTracker = require('./corridorTracker');
const maresmeTracker = require('./maresmeTracker');
const cataloniaTracker = require('./cataloniaTracker');
const mouteClient = require('./mouteClient');
const historyDb = require('./historyDb');

class IngestionDaemon {
  constructor() {
    this.isRunning = false;
    this.vehiclePollTimer = null;
    this.mataroPollTimer = null;
    this.corridorPollTimer = null;
    this.disruptionsTimer = null;
    this.pruneTimer = null;
    this.activeMonitoredLines = new Set(['C10', 'E11.1', 'E11.2', 'E13', 'E21', '201', '230', '400', 'B24', 'B25', 'M28', 'M30', 'L80', 'L82']);
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[IngestionDaemon] 🚀 Starting Autonomous Centralized Ingestion Server...');

    // 1. Initial Ingestion Run
    this.pollAmbVehicles();
    this.pollMataroVehicles();
    this.pollCorridorDelays();

    // 2. Schedule High-Frequency AMB Vehicle Fleet Ingestion (every 12 seconds)
    this.vehiclePollTimer = setInterval(() => this.pollAmbVehicles(), 12000);

    // 3. Schedule Mataró Bus SIRI Ingestion (every 15 seconds)
    this.mataroPollTimer = setInterval(() => this.pollMataroVehicles(), 15000);

    // 4. Schedule Active Corridor Delays Ingestion (every 25 seconds)
    this.corridorPollTimer = setInterval(() => this.pollCorridorDelays(), 25000);

    // 5. Schedule Disruptions Ingestion (every 3 minutes)
    this.disruptionsTimer = setInterval(() => this.pollDisruptions(), 180000);

    // 6. Schedule DB Pruning (every 12 hours)
    this.pruneTimer = setInterval(() => historyDb.pruneOldRecords(7), 12 * 3600 * 1000);
  }

  stop() {
    this.isRunning = false;
    if (this.vehiclePollTimer) clearInterval(this.vehiclePollTimer);
    if (this.mataroPollTimer) clearInterval(this.mataroPollTimer);
    if (this.corridorPollTimer) clearInterval(this.corridorPollTimer);
    if (this.disruptionsTimer) clearInterval(this.disruptionsTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    console.log('[IngestionDaemon] Stopped ingestion daemon.');
  }

  registerActiveLine(lineCode) {
    if (!lineCode) return;
    const code = String(lineCode).toUpperCase().trim();
    this.activeMonitoredLines.add(code);
  }

  async pollAmbVehicles() {
    try {
      const vehicles = await ambTracker.getLiveVehicles();
      if (Array.isArray(vehicles) && vehicles.length > 0) {
        vehicles.forEach(v => {
          flightRecorder.ingestVehicle({
            vehicleId: v.vehicleId || v.id,
            lineId: v.lineId || v.lineCode,
            lineCode: v.lineCode || v.lineName,
            agency: v.agency || 'AMB Mobilitat',
            plateNumber: v.plate || v.vehicleId,
            lat: v.lat,
            lon: v.lon,
            speedKmh: v.speedKmh || 30,
            bearing: v.bearing || 0,
            delayMins: v.delayMins || 0,
            destination: v.destination || '',
            isRealTime: true
          });
        });
      }
    } catch (e) {
      // Upstream temporary hiccup
    }
  }

  async pollMataroVehicles() {
    try {
      const activeLines = ['1', '2', '3', '4', '5', '6', '7', '8'];
      for (const lId of activeLines) {
        const details = await mataroTracker.getLineDetails(lId);
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
              speedKmh: b.speedKmh || 25,
              bearing: b.bearing || 0,
              delayMins: b.delayMins || 0,
              destination: b.destination || '',
              isRealTime: !b.isEstimated
            });

            // Log delay sample
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
      }
    } catch (e) {
      // Upstream temporary hiccup
    }
  }

  async pollCorridorDelays() {
    try {
      // Sample C-10 corridor
      const c10Eta = await corridorTracker.getTargetStopETA('1');
      if (c10Eta && c10Eta.closestBus) {
        const b = c10Eta.closestBus;
        flightRecorder.ingestVehicle({
          vehicleId: b.vehicleId || 'c10_active_lead',
          lineId: 'c10',
          lineCode: 'C-10',
          agency: 'Moventis / Casas',
          lat: b.lat,
          lon: b.lon,
          speedKmh: b.speedKmh || 38,
          bearing: b.bearing || 45,
          delayMins: b.delayMins || 0,
          destination: b.destination || 'Mataró',
          isRealTime: true
        });

        if (b.delayMins !== undefined) {
          historyDb.recordDelayLog({
            lineId: 'c10',
            lineCode: 'C-10',
            agency: 'Moventis / Casas',
            stopId: c10Eta.targetStop?.id,
            stopName: c10Eta.targetStop?.name,
            delayMins: b.delayMins,
            scheduledTime: b.scheduledTime || '',
            actualTime: b.time || '',
            isRealTime: true
          });
        }
      }
    } catch (e) {
      // Upstream temporary hiccup
    }
  }

  async pollDisruptions() {
    try {
      await ambTracker.getDisruptions();
    } catch (e) {
      // Upstream temporary hiccup
    }
  }
}

module.exports = new IngestionDaemon();
