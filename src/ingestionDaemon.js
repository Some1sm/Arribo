const flightRecorder = require('./flightRecorder');
const ambTracker = require('./ambTracker');
const mataroTracker = require('./mataroTracker');
const corridorTracker = require('./corridorTracker');
const maresmeTracker = require('./maresmeTracker');
const rodaliesTracker = require('./rodaliesTracker');
const sagalesTracker = require('./sagalesTracker');
const historyDb = require('./historyDb');

class IngestionDaemon {
  constructor() {
    this.isRunning = false;
    this.vehiclePollTimer = null;
    this.mataroPollTimer = null;
    this.corridorPollTimer = null;
    this.maresmePollTimer = null;
    this.rodaliesPollTimer = null;
    this.sagalesPollTimer = null;
    this.disruptionsTimer = null;
    this.pruneTimer = null;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[IngestionDaemon] 🚀 Starting Autonomous Centralized Ingestion Server...');

    // 1. Initial Ingestion Run
    this.pollAmbVehicles();
    this.pollMataroVehicles();
    this.pollCorridorDelays();
    this.pollMaresmeLines();
    this.pollRodaliesTrains();
    this.pollSagalesLines();

    // 2. Schedule High-Frequency AMB Vehicle Fleet Ingestion (every 12 seconds)
    this.vehiclePollTimer = setInterval(() => this.pollAmbVehicles(), 12000);

    // 3. Schedule Mataró Bus SIRI Ingestion (every 15 seconds)
    this.mataroPollTimer = setInterval(() => this.pollMataroVehicles(), 15000);

    // 4. Schedule Active Corridor Delays Ingestion (every 20 seconds)
    this.corridorPollTimer = setInterval(() => this.pollCorridorDelays(), 20000);

    // 5. Schedule Moventis Maresme Ingestion (every 25 seconds)
    this.maresmePollTimer = setInterval(() => this.pollMaresmeLines(), 25000);

    // 6. Schedule Rodalies Train Ingestion (every 30 seconds)
    this.rodaliesPollTimer = setInterval(() => this.pollRodaliesTrains(), 30000);

    // 7. Schedule Sagalés Ingestion (every 30 seconds)
    this.sagalesPollTimer = setInterval(() => this.pollSagalesLines(), 30000);

    // 8. Schedule Disruptions Ingestion (every 3 minutes)
    this.disruptionsTimer = setInterval(() => this.pollDisruptions(), 180000);

    // 9. Schedule DB Pruning (every 12 hours)
    this.pruneTimer = setInterval(() => historyDb.pruneOldRecords(30), 12 * 3600 * 1000);
  }

  stop() {
    this.isRunning = false;
    if (this.vehiclePollTimer) clearInterval(this.vehiclePollTimer);
    if (this.mataroPollTimer) clearInterval(this.mataroPollTimer);
    if (this.corridorPollTimer) clearInterval(this.corridorPollTimer);
    if (this.maresmePollTimer) clearInterval(this.maresmePollTimer);
    if (this.rodaliesPollTimer) clearInterval(this.rodaliesPollTimer);
    if (this.sagalesPollTimer) clearInterval(this.sagalesPollTimer);
    if (this.disruptionsTimer) clearInterval(this.disruptionsTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    console.log('[IngestionDaemon] Stopped ingestion daemon.');
  }

  async pollAmbVehicles() {
    try {
      const vehicles = await ambTracker.getLiveVehicles();
      if (Array.isArray(vehicles) && vehicles.length > 0) {
        vehicles.forEach(v => {
          const lCode = String(v.lineCode || v.lineName || '').toUpperCase();
          flightRecorder.ingestVehicle({
            vehicleId: v.vehicleId || v.id,
            lineId: v.lineId || v.lineCode,
            lineCode: lCode,
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

          if (v.delayMins !== undefined && lCode) {
            historyDb.recordDelayLog({
              lineId: v.lineId || lCode,
              lineCode: lCode,
              agency: v.agency || 'AMB Mobilitat',
              stopId: v.destination || 'Tram en línia',
              stopName: v.destination || 'Tram en línia',
              delayMins: v.delayMins,
              scheduledTime: '',
              actualTime: '',
              isRealTime: true
            });
          }
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
            stopId: c10Eta.targetStop?.id || '10037202',
            stopName: c10Eta.targetStop?.name || "pl. Itàlia (A)",
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

  async pollMaresmeLines() {
    try {
      const lines = ['n80', 'n81', 'e111', 'e112', 'c20'];
      for (const lId of lines) {
        const eta = await maresmeTracker.getTargetStopETA(lId, '0');
        if (eta && eta.nextBus && eta.nextBus.isRealtime) {
          historyDb.recordDelayLog({
            lineId: lId,
            lineCode: eta.lineCode || lId.toUpperCase(),
            agency: 'Moventis / Casas (Maresme)',
            stopId: eta.targetStop?.id || 'parada',
            stopName: eta.targetStop?.name || 'Parada',
            delayMins: eta.nextBus.delayMinutes || 0,
            scheduledTime: eta.nextBus.scheduledTime || '',
            actualTime: eta.nextBus.departureTime || '',
            isRealTime: true
          });
        }
      }
    } catch (e) {
      // Upstream temporary hiccup
    }
  }

  async pollRodaliesTrains() {
    try {
      const trains = ['r1', 'r2', 'r4'];
      for (const tId of trains) {
        const eta = await rodaliesTracker.getTargetStopETA(tId, '0');
        if (eta && eta.nextBus && eta.nextBus.isRealtime) {
          historyDb.recordDelayLog({
            lineId: tId,
            lineCode: eta.lineCode || tId.toUpperCase(),
            agency: 'Renfe Rodalies de Catalunya',
            stopId: eta.targetStop?.id || 'estacio',
            stopName: eta.targetStop?.name || 'Estació',
            delayMins: eta.nextBus.delayMinutes || 0,
            scheduledTime: eta.nextBus.scheduledTime || '',
            actualTime: eta.nextBus.departureTime || '',
            isRealTime: true
          });
        }
      }
    } catch (e) {
      // Upstream temporary hiccup
    }
  }

  async pollSagalesLines() {
    try {
      const sagalesLines = ['n82', '201', '400'];
      for (const sId of sagalesLines) {
        const eta = await sagalesTracker.getTargetStopETA(sId, '0');
        if (eta && eta.nextBus && eta.nextBus.isRealtime) {
          historyDb.recordDelayLog({
            lineId: sId,
            lineCode: eta.lineCode || sId.toUpperCase(),
            agency: 'Sagalés',
            stopId: eta.targetStop?.id || 'parada',
            stopName: eta.targetStop?.name || 'Parada',
            delayMins: eta.nextBus.delayMinutes || 0,
            scheduledTime: eta.nextBus.scheduledTime || '',
            actualTime: eta.nextBus.departureTime || '',
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

