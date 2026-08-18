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
    this.ambLinesPollTimer = null;
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
    this.pollAmbLines();
    this.pollMataroVehicles();
    this.pollCorridorDelays();
    this.pollMaresmeLines();
    this.pollRodaliesTrains();
    this.pollSagalesLines();

    // 2. Schedule High-Frequency AMB Vehicle Fleet Ingestion (every 12 seconds)
    this.vehiclePollTimer = setInterval(() => this.pollAmbVehicles(), 12000);

    // 3. Schedule AMB Lines Realtime Delay Ingestion (every 20 seconds)
    this.ambLinesPollTimer = setInterval(() => this.pollAmbLines(), 20000);

    // 4. Schedule Mataró Bus SIRI Ingestion (every 15 seconds)
    this.mataroPollTimer = setInterval(() => this.pollMataroVehicles(), 15000);

    // 5. Schedule Active Corridor Delays Ingestion (every 20 seconds)
    this.corridorPollTimer = setInterval(() => this.pollCorridorDelays(), 20000);

    // 6. Schedule Moventis Maresme Ingestion (every 25 seconds)
    this.maresmePollTimer = setInterval(() => this.pollMaresmeLines(), 25000);

    // 7. Schedule Rodalies Train Ingestion (every 30 seconds)
    this.rodaliesPollTimer = setInterval(() => this.pollRodaliesTrains(), 30000);

    // 8. Schedule Sagalés Ingestion (every 30 seconds)
    this.sagalesPollTimer = setInterval(() => this.pollSagalesLines(), 30000);

    // 9. Schedule Disruptions Ingestion (every 3 minutes)
    this.disruptionsTimer = setInterval(() => this.pollDisruptions(), 180000);

    // 10. Schedule DB Pruning (every 12 hours)
    this.pruneTimer = setInterval(() => historyDb.pruneOldRecords(30), 12 * 3600 * 1000);
  }

  stop() {
    this.isRunning = false;
    if (this.vehiclePollTimer) clearInterval(this.vehiclePollTimer);
    if (this.ambLinesPollTimer) clearInterval(this.ambLinesPollTimer);
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
          const lCode = String(v.line || v.lineCode || v.lineName || '').toUpperCase();
          if (!lCode) return;
          const lat = parseFloat(v.latitude || v.lat);
          const lon = parseFloat(v.longitude || v.lon);
          if (isNaN(lat) || isNaN(lon)) return;

          const route = ambTracker.resolveLine(lCode);
          const agency = route?.agency || 'AMB Mobilitat';
          const vehicleId = v.id || v.vehicleId || `amb_${lCode}_${v.tripId || Math.random()}`;

          flightRecorder.ingestVehicle({
            vehicleId,
            lineId: route?.id || `amb_${lCode.toLowerCase()}`,
            lineCode: lCode,
            agency: agency,
            plateNumber: v.plate || v.id || '',
            lat,
            lon,
            speedKmh: v.speedKmh || 30,
            bearing: v.bearing || 0,
            delayMins: v.delayMins || 0,
            destination: v.destination || route?.name || '',
            isRealTime: true
          });
        });
      }
    } catch (e) {
      // Upstream temporary hiccup
    }
  }

  async pollAmbLines() {
    try {
      const targetAmbLines = ['b25', 'm28', 'l80', 'l82', 'a1', 'm30', 'b24', 'v15', 'h12', 'd20', 'pa2'];
      for (const lId of targetAmbLines) {
        try {
          const eta = await ambTracker.getTargetStopETA(lId, null, '0');
          const nb = eta?.nextBus;
          if (nb && (nb.isRealTime || nb.isRealtime)) {
            const delay = nb.expectedIso && nb.aimedIso
              ? Math.max(0, Math.round((new Date(nb.expectedIso).getTime() - new Date(nb.aimedIso).getTime()) / 60000))
              : (nb.delayMinutes || nb.delayMins || 0);

            const route = ambTracker.resolveLine(lId);
            historyDb.recordDelayLog({
              lineId: route?.id || `amb_${lId}`,
              lineCode: route?.code || lId.toUpperCase(),
              agency: route?.agency || 'AMB Mobilitat',
              stopId: eta.targetStop?.id || 'parada',
              stopName: eta.targetStop?.name || 'Parada',
              delayMins: delay,
              scheduledTime: nb.departureTime || '',
              actualTime: nb.departureTime || '',
              isRealTime: true
            });
          }
        } catch (err) {
          // Line-specific skip
        }
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

        historyDb.recordDelayLog({
          lineId: 'c10',
          lineCode: 'C-10',
          agency: 'Moventis / Casas',
          stopId: c10Eta.targetStop?.id || '10037202',
          stopName: c10Eta.targetStop?.name || "pl. Itàlia (A)",
          delayMins: b.delayMins || 0,
          scheduledTime: b.scheduledTime || '',
          actualTime: b.time || '',
          isRealTime: true
        });
      }
    } catch (e) {
      // Upstream temporary hiccup
    }
  }

  async pollMaresmeLines() {
    try {
      const lines = ['e111', 'e112', 'c20', 'c3', 'c12', 'c14', 'c15', 'n80', 'n81'];
      for (const lId of lines) {
        try {
          const eta = await maresmeTracker.getTargetStopETA(lId, '0');
          const nb = eta?.nextBus;
          if (nb) {
            const isReal = nb.isRealTime !== false && nb.isRealtime !== false;
            const delay = nb.expectedIso && nb.aimedIso
              ? Math.max(0, Math.round((new Date(nb.expectedIso).getTime() - new Date(nb.aimedIso).getTime()) / 60000))
              : (nb.delayMinutes || nb.delayMins || 0);

            historyDb.recordDelayLog({
              lineId: lId,
              lineCode: eta.lineCode || lId.toUpperCase(),
              agency: 'Moventis / Casas (Maresme)',
              stopId: eta.targetStop?.id || 'parada',
              stopName: eta.targetStop?.name || 'Parada',
              delayMins: delay,
              scheduledTime: nb.scheduledTime || nb.departureTime || '',
              actualTime: nb.departureTime || '',
              isRealTime: isReal
            });
          }
        } catch (err) {
          // Skip individual line
        }
      }
    } catch (e) {
      // Upstream temporary hiccup
    }
  }

  async pollRodaliesTrains() {
    try {
      const trains = ['r1', 'r2', 'r2n', 'r2s', 'r3', 'r4', 'rg1', 'r11'];
      for (const tId of trains) {
        try {
          const eta = await rodaliesTracker.getTargetStopETA(tId, '0');
          const nb = eta?.nextBus;
          if (nb) {
            const isReal = nb.isRealTime !== false && nb.isRealtime !== false;
            const delay = nb.expectedIso && nb.aimedIso
              ? Math.max(0, Math.round((new Date(nb.expectedIso).getTime() - new Date(nb.aimedIso).getTime()) / 60000))
              : (nb.delayMinutes || nb.delayMins || 0);

            historyDb.recordDelayLog({
              lineId: tId,
              lineCode: eta.lineCode || tId.toUpperCase(),
              agency: 'Renfe Rodalies de Catalunya',
              stopId: eta.targetStop?.id || 'estacio',
              stopName: eta.targetStop?.name || 'Estació',
              delayMins: delay,
              scheduledTime: nb.scheduledTime || nb.departureTime || '',
              actualTime: nb.departureTime || '',
              isRealTime: isReal
            });
          }
        } catch (err) {
          // Skip individual line
        }
      }
    } catch (e) {
      // Upstream temporary hiccup
    }
  }

  async pollSagalesLines() {
    try {
      const sagalesLines = ['603', 'n82', 'n83', 'n70', 'n71'];
      for (const sId of sagalesLines) {
        try {
          const eta = await sagalesTracker.getTargetStopETA(sId, '0');
          const nb = eta?.nextBus;
          if (nb) {
            const isReal = nb.isRealTime !== false && nb.isRealtime !== false;
            const delay = nb.expectedIso && nb.aimedIso
              ? Math.max(0, Math.round((new Date(nb.expectedIso).getTime() - new Date(nb.aimedIso).getTime()) / 60000))
              : (nb.delayMinutes || nb.delayMins || 0);

            historyDb.recordDelayLog({
              lineId: sId,
              lineCode: eta.lineCode || sId.toUpperCase(),
              agency: 'Sagalés',
              stopId: eta.targetStop?.id || 'parada',
              stopName: eta.targetStop?.name || 'Parada',
              delayMins: delay,
              scheduledTime: nb.scheduledTime || nb.departureTime || '',
              actualTime: nb.departureTime || '',
              isRealTime: isReal
            });
          }
        } catch (err) {
          // Skip individual line
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

