const flightRecorder = require('./flightRecorder');
const ambTracker = require('./ambTracker');
const mataroTracker = require('./mataroTracker');
const corridorTracker = require('./corridorTracker');
const maresmeTracker = require('./maresmeTracker');
const rodaliesTracker = require('./rodaliesTracker');
const sagalesTracker = require('./sagalesTracker');
const cataloniaTracker = require('./cataloniaTracker');
const routeCacheService = require('./routeCacheService');
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
    this.cataloniaPollTimer = null;
    this.disruptionsTimer = null;
    this.pruneTimer = null;
    this.dailySnapshotTimer = null;
    this.cataloniaBatchOffset = 0;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[IngestionDaemon] 🚀 Starting Autonomous Centralized Ingestion Server...');

    // Apply retention immediately so a restart cannot leave the previous
    // retention window on disk until the first scheduled maintenance pass.
    historyDb.pruneOldRecords();

    // Initialize daily route cache and snapshots
    routeCacheService.initDailyCache();

    // 1. Initial Ingestion Run
    this.pollAmbVehicles();
    this.pollAmbLines();
    this.pollMataroVehicles();
    this.pollCorridorDelays();
    this.pollMaresmeLines();
    this.pollRodaliesTrains();
    this.pollSagalesLines();
    this.pollCataloniaLines();

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

    // 8b. Schedule Catalonia Interurban Ingestion (every 35 seconds)
    this.cataloniaPollTimer = setInterval(() => this.pollCataloniaLines(), 35000);

    // 9. Schedule Disruptions Ingestion (every 3 minutes)
    this.disruptionsTimer = setInterval(() => this.pollDisruptions(), 180000);

    // 10. Schedule DB pruning (every hour) to keep the short raw snapshot
    // window bounded even when the service runs continuously.
    this.pruneTimer = setInterval(() => historyDb.pruneOldRecords(), 3600 * 1000);

    // 11. Schedule Daily Route Cache & Snapshot Pass (every 24 hours, keeping last 3 days)
    this.dailySnapshotTimer = setInterval(() => {
      console.log('[IngestionDaemon] 🔄 Running 24-hour route caching and 3-day snapshot maintenance...');
      routeCacheService.takeDailySnapshot();
      routeCacheService.pruneOldSnapshots();
    }, 24 * 3600 * 1000);
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
    if (this.cataloniaPollTimer) clearInterval(this.cataloniaPollTimer);
    if (this.disruptionsTimer) clearInterval(this.disruptionsTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.dailySnapshotTimer) clearInterval(this.dailySnapshotTimer);
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

          // Log delay record for all active AMB lines in the vehicle fleet
          if (v.delayMins !== undefined) {
            historyDb.recordDelayLog({
              lineId: route?.id || `amb_${lCode.toLowerCase()}`,
              lineCode: lCode,
              agency: agency,
              stopId: v.destination || 'Tram en línia',
              stopName: v.destination || `${lCode} en circulació`,
              delayMins: v.delayMins || 0,
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

  async pollAmbLines() {
    try {
      const targetAmbLines = ['m1', 'm6', 'm19', 'm26', 'm28', 'b25', 'b24', 'l80', 'a1', 'v15', 'h12', 'd20'];
      await Promise.allSettled(targetAmbLines.map(async (lId) => {
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
          // Skip individual line
        }
      }));
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
      const allLines = maresmeTracker.getLines();
      const lines = allLines.length > 0 ? allLines.map(l => l.id) : ['e111', 'e112', 'c20', 'c30', 'c3', 'c12', 'c14', 'c15', 'n80', 'n81'];
      for (const lId of lines) {
        try {
          for (const dir of ['0', '1']) {
            const lineDetails = await maresmeTracker.getLineDetails(lId, dir);
            if (lineDetails) {
              const stops = lineDetails.stops || [];
              // Ingest live telemetry for active buses on highway / urban corridor
              if (Array.isArray(lineDetails.activeBuses)) {
                lineDetails.activeBuses.forEach(b => {
                  flightRecorder.ingestVehicle({
                    vehicleId: b.vehicleId || `mov_${lId}_${b.tripId}`,
                    lineId: lId,
                    lineCode: lineDetails.code || lId.toUpperCase(),
                    agency: 'Moventis / Casas (Maresme)',
                    lat: b.lat,
                    lon: b.lon,
                    speedKmh: b.speedKmh || 45,
                    bearing: b.bearing || 0,
                    delayMins: b.trafficDelayMins || 0,
                    destination: b.toStop || '',
                    isRealTime: true
                  });

                  if (b.trafficDelayMins !== undefined) {
                    historyDb.recordDelayLog({
                      lineId: lId,
                      lineCode: lineDetails.code || lId.toUpperCase(),
                      agency: 'Moventis / Casas (Maresme)',
                      stopId: b.toStop || 'Tram en línia',
                      stopName: b.toStop || 'Tram en línia',
                      delayMins: b.trafficDelayMins,
                      scheduledTime: '',
                      actualTime: '',
                      isRealTime: true
                    });
                  }
                });
              }

              // Sample intermediate checkpoint stop (bottleneck) and destination
              const sampleStops = [
                stops[Math.floor(stops.length / 2)],
                stops[stops.length - 1]
              ].filter(Boolean);

              for (const st of sampleStops) {
                const eta = await maresmeTracker.getTargetStopETA(lId, st.id, dir);
                const nb = eta?.nextBus;
                if (nb && nb.delayMins !== undefined) {
                  historyDb.recordDelayLog({
                    lineId: lId,
                    lineCode: eta.lineCode || lineDetails.code || lId.toUpperCase(),
                    agency: 'Moventis / Casas (Maresme)',
                    stopId: st.id,
                    stopName: st.name,
                    delayMins: nb.delayMins || 0,
                    scheduledTime: nb.scheduledTime || '',
                    actualTime: nb.departureTime || '',
                    isRealTime: true
                  });
                }
              }
            }
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
      const trains = ['r1', 'r2', 'r2n', 'r3', 'r4', 'rg1', 'r11'];
      await Promise.allSettled(trains.map(async (tId) => {
        try {
          const lineDetails = await rodaliesTracker.getLineDetails(tId, '0');
          const stations = lineDetails?.stops || [];
          const sampleStations = [stations[Math.floor(stations.length / 2)]].filter(Boolean);

          for (const st of sampleStations) {
            const eta = await rodaliesTracker.getTargetStopETA(tId, st.id, '0');
            const nb = eta?.nextBus;
            if (nb && nb.delayMinutes !== undefined) {
              historyDb.recordDelayLog({
                lineId: tId,
                lineCode: eta.lineCode || tId.toUpperCase(),
                agency: 'Renfe Rodalies de Catalunya',
                stopId: st.id || 'estacio',
                stopName: st.name || 'Estació',
                delayMins: nb.delayMinutes || 0,
                scheduledTime: nb.scheduledTime || nb.departureTime || '',
                actualTime: nb.departureTime || '',
                isRealTime: true
              });
            }
          }
        } catch (err) {
          // Skip individual train
        }
      }));
    } catch (e) {
      // Upstream temporary hiccup
    }
  }

  async pollSagalesLines() {
    try {
      const allLines = sagalesTracker.getLines();
      const sagalesLines = allLines.length > 0 ? allLines.map(l => l.id) : ['603', 'n82', 'n83', 'n70', 'n71', 'n73'];
      await Promise.allSettled(sagalesLines.map(async (sId) => {
        try {
          const lineDetails = await sagalesTracker.getLineDetails(sId, '0');
          const stops = lineDetails?.stops || [];
          const sampleStops = [stops[Math.floor(stops.length / 2)]].filter(Boolean);

          for (const st of sampleStops) {
            const eta = await sagalesTracker.getTargetStopETA(sId, st.id, '0');
            const nb = eta?.nextBus;
            if (nb) {
              const delay = nb.delayMinutes || (nb.expectedIso && nb.aimedIso
                ? Math.max(0, Math.round((new Date(nb.expectedIso).getTime() - new Date(nb.aimedIso).getTime()) / 60000))
                : 0);

              historyDb.recordDelayLog({
                lineId: sId,
                lineCode: eta.lineCode || sId.toUpperCase(),
                agency: 'Sagalés',
                stopId: st.id || 'parada',
                stopName: st.name || 'Parada',
                delayMins: delay,
                scheduledTime: nb.scheduledTime || nb.departureTime || '',
                actualTime: nb.departureTime || '',
                isRealTime: true
              });
            }
          }
        } catch (err) {
          // Skip individual line
        }
      }));
    } catch (e) {
      // Upstream temporary hiccup
    }
  }

  async pollCataloniaLines() {
    try {
      const allRoutes = cataloniaTracker.routes;
      if (!allRoutes || allRoutes.length === 0) return;

      const batchSize = 25;
      const startIdx = this.cataloniaBatchOffset % allRoutes.length;
      this.cataloniaBatchOffset = (startIdx + batchSize) % allRoutes.length;

      const sampleRoutes = allRoutes.slice(startIdx, startIdx + batchSize);
      await Promise.allSettled(sampleRoutes.map(async (r) => {
        try {
          const details = cataloniaTracker.routeDetailsMap.get(r.id);
          const stops = details?.stopsByDirection?.['0'] || [];
          if (stops.length > 0) {
            const targetStop = stops[Math.floor(stops.length / 2)] || stops[0];
            const deps = await cataloniaTracker.getStopDepartures(targetStop.id, r.id, '0');
            if (deps && deps.departures && deps.departures.length > 0) {
              const next = deps.departures[0];
              if (next && next.delayMins !== undefined) {
                historyDb.recordDelayLog({
                  lineId: r.id,
                  lineCode: r.code || r.id,
                  agency: r.agency || 'Interurbà Catalunya',
                  stopId: targetStop.id,
                  stopName: targetStop.name || 'Parada',
                  delayMins: next.delayMins || 0,
                  scheduledTime: next.departureTime || '',
                  actualTime: next.departureTime || '',
                  isRealTime: next.isRealTime
                });
              }
            }
          }
        } catch (err) {
          // Skip individual route
        }
      }));
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
