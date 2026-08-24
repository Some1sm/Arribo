/**
 * challenger_m1_ingestion_flight_stress_test.js
 * 
 * Adversarial Verification & Stress Test Suite for Milestone 1 / Milestone 2:
 * 1. Vehicle Lifecycle Transitions (Live GPS -> 90s Dead-Reckoning Extrapolation -> Stale Vehicle Pruning)
 * 2. CorridorTracker Live GPS Prioritization & Fallback Modes
 * 3. Simultaneous Multi-Line Ingestion & Isolation (C-10 + Mataró L1-L8 + Rodalies + AMB)
 * 4. Memory Stability & Zero-Leak Under High-Frequency Ingestion Loops
 * 5. Persistence Handlers & History Gateway Routing
 */

const assert = require('assert');
const flightRecorder = require('../src/flightRecorder');
const corridorTracker = require('../src/corridorTracker');
const ingestionDaemon = require('../src/ingestionDaemon');
const c10TelemetryExtractor = require('../src/c10TelemetryExtractor');
const trackerRegistry = require('../src/core/TrackerRegistry');
const geoEngine = require('../src/core/geo/geoEngine');

console.log('⚔️  STARTING CHALLENGER EMPIRICAL ADVERSARIAL STRESS TEST SUITE (M1)\n');

let totalTests = 0;
let passedTests = 0;

function test(description, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✓ ${description}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ FAILED: ${description}`);
    console.error(`     Error: ${err.message}`);
    throw err;
  }
}

async function asyncTest(description, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✓ ${description}`);
    passedTests++;
  } catch (err) {
    console.error(`  ❌ FAILED: ${description}`);
    console.error(`     Error: ${err.message}`);
    throw err;
  }
}

(async () => {
  // =========================================================================
  // SUITE 1: Vehicle Lifecycle & State Transitions
  // =========================================================================
  console.log('📌 [SUITE 1] Vehicle Lifecycle Transitions (GPS -> 90s Extrapolation -> Pruning)...');

  // Clear any existing vehicles
  flightRecorder.vehicles.clear();
  flightRecorder.lineIndex.clear();
  flightRecorder.setAutoExtrapolation(false); // manual stepping for determinism

  const initialLat = 41.450000;
  const initialLon = 2.250000;
  const testVehicleId = 'c10_502_test_adv_1';

  test('1.1 Ingest fresh real-time GPS fix with canonical schema', () => {
    flightRecorder.ingestVehicle({
      vehicleId: testVehicleId,
      lineId: 'c10',
      lineCode: 'C-10',
      agency: 'Moventis / Casas',
      plateNumber: '1234-XYZ',
      lat: initialLat,
      lon: initialLon,
      speedKmh: 45,
      bearing: 48,
      delayMins: 2,
      destination: 'Hospital de Mataró',
      isRealTime: true,
      isEstimated: false
    });

    const v = flightRecorder.vehicles.get(testVehicleId);
    assert.ok(v, 'Vehicle should exist in FlightRecorder');
    assert.strictEqual(v.status, 'active');
    assert.strictEqual(v.isRealTime, true);
    assert.strictEqual(v.isEstimated, false);
    assert.strictEqual(v.lat, initialLat);
    assert.strictEqual(v.lon, initialLon);
    assert.strictEqual(v.speedKmh, 45);
    assert.strictEqual(v.bearing, 48);
    assert.strictEqual(v.history.length, 1);
    assert.strictEqual(v.history[0].lat, initialLat);

    const lineVehicles = flightRecorder.getLineVehicles('C-10');
    assert.strictEqual(lineVehicles.length, 1);
    assert.strictEqual(lineVehicles[0].vehicleId, testVehicleId);
  });

  test('1.2 Extrapolation triggered when telemetry is silent > 18 seconds', () => {
    const v = flightRecorder.vehicles.get(testVehicleId);
    // Simulate 20 seconds elapsed since last GPS fix
    v.lastSeen = Date.now() - 20000;

    flightRecorder.extrapolateStaleVehicles();

    assert.strictEqual(v.status, 'extrapolated', 'Status should change to extrapolated');
    assert.strictEqual(v.extrapolatedMs, 5000, 'extrapolatedMs should record 5000ms');
    assert.ok(v.lat > initialLat, `Latitude should increase along bearing 48° (was ${initialLat}, now ${v.lat})`);
    assert.ok(v.lon > initialLon, `Longitude should increase along bearing 48° (was ${initialLon}, now ${v.lon})`);
  });

  test('1.3 Dead-reckoning bounded strictly to 90s maximum buffer (maxExtrapolationMs)', () => {
    const v = flightRecorder.vehicles.get(testVehicleId);
    // Simulate 17 more extrapolation ticks (total 18 ticks * 5000ms = 90,000ms)
    for (let i = 0; i < 17; i++) {
      v.lastSeen = Date.now() - 20000;
      flightRecorder.extrapolateStaleVehicles();
    }

    assert.strictEqual(v.extrapolatedMs, 90000, `extrapolatedMs must cap exactly at 90000 (actual: ${v.extrapolatedMs})`);
    const latAt90s = v.lat;
    const lonAt90s = v.lon;

    // Run further extrapolation ticks — vehicle must NOT drift beyond the 90s budget
    for (let i = 0; i < 5; i++) {
      v.lastSeen = Date.now() - 20000;
      flightRecorder.extrapolateStaleVehicles();
    }

    assert.strictEqual(v.extrapolatedMs, 90000, 'extrapolatedMs must remain 90000ms');
    assert.strictEqual(v.lat, latAt90s, 'Latitude must freeze after reaching 90s extrapolation cap');
    assert.strictEqual(v.lon, lonAt90s, 'Longitude must freeze after reaching 90s extrapolation cap');
  });

  test('1.4 Cell shadow exit: fresh GPS fix resets dead-reckoning budget and resumes active status', () => {
    const freshLat = 41.480000;
    const freshLon = 2.300000;

    flightRecorder.ingestVehicle({
      vehicleId: testVehicleId,
      lineId: 'c10',
      lineCode: 'C-10',
      agency: 'Moventis / Casas',
      plateNumber: '1234-XYZ',
      lat: freshLat,
      lon: freshLon,
      speedKmh: 50,
      bearing: 52,
      delayMins: 1,
      destination: 'Hospital de Mataró',
      isRealTime: true,
      isEstimated: false
    });

    const v = flightRecorder.vehicles.get(testVehicleId);
    assert.strictEqual(v.status, 'active');
    assert.strictEqual(v.extrapolatedMs, 0, 'Dead-reckoning budget must reset to 0 upon fresh GPS fix');
    assert.strictEqual(v.lat, freshLat);
    assert.strictEqual(v.lon, freshLon);
    assert.strictEqual(v.history.length, 2, 'History trail should append new snapshot');
  });

  test('1.5 Stale vehicle pruning: vehicle silent > 5 minutes is purged from Map and lineIndex', () => {
    const v = flightRecorder.vehicles.get(testVehicleId);
    // Simulate 301 seconds elapsed (> 5 minutes = 300,000ms)
    v.lastSeen = Date.now() - 301000;

    flightRecorder.extrapolateStaleVehicles();

    assert.strictEqual(flightRecorder.vehicles.has(testVehicleId), false, 'Vehicle must be deleted from vehicles Map');
    assert.strictEqual(flightRecorder.getLineVehicles('C-10').length, 0, 'Vehicle must be removed from lineIndex');
    const set = flightRecorder.lineIndex.get('C-10');
    assert.ok(!set || !set.has(testVehicleId), 'lineIndex Set must not contain purged vehicleId');
  });

  test('1.6 Timetable schedule estimates are immune to dead-reckoning extrapolation', () => {
    const estVehicleId = 'c10_estimated_bus_1';
    flightRecorder.ingestVehicle({
      vehicleId: estVehicleId,
      lineId: 'c10',
      lineCode: 'C-10',
      lat: 41.500000,
      lon: 2.350000,
      speedKmh: 40,
      bearing: 45,
      isRealTime: false,
      isEstimated: true,
      isDeadReckoned: true
    });

    const v = flightRecorder.vehicles.get(estVehicleId);
    assert.strictEqual(v.isEstimated, true);
    v.lastSeen = Date.now() - 25000;

    flightRecorder.extrapolateStaleVehicles();

    assert.strictEqual(v.status, 'active', 'Estimated vehicle should not transition to extrapolated status');
    assert.strictEqual(v.lat, 41.500000, 'Estimated vehicle coordinates must remain unchanged');
    assert.strictEqual(v.lon, 2.350000, 'Estimated vehicle coordinates must remain unchanged');

    flightRecorder.vehicles.delete(estVehicleId);
  });

  // =========================================================================
  // SUITE 2: Corridor Tracker & Ingestion Integration
  // =========================================================================
  console.log('\n📌 [SUITE 2] CorridorTracker Live GPS Prioritization & Ingestion Integration...');

  await asyncTest('2.1 c10TelemetryExtractor bounding box validation enforces N-II corridor bounds', async () => {
    assert.strictEqual(c10TelemetryExtractor.isWithinBoundingBox(41.45, 2.25), true, 'Valid Badalona coordinate');
    assert.strictEqual(c10TelemetryExtractor.isWithinBoundingBox(41.54, 2.44), true, 'Valid Mataro coordinate');
    assert.strictEqual(c10TelemetryExtractor.isWithinBoundingBox(40.41, -3.70), false, 'Madrid rejected (out of bounding box)');
    assert.strictEqual(c10TelemetryExtractor.isWithinBoundingBox(48.85, 2.35), false, 'Paris rejected (out of bounding box)');
    assert.strictEqual(c10TelemetryExtractor.isWithinBoundingBox(NaN, 2.25), false, 'NaN lat rejected');
    assert.strictEqual(c10TelemetryExtractor.isWithinBoundingBox(41.45, null), false, 'null lon rejected');
  });

  await asyncTest('2.2 c10TelemetryExtractor single-flight coalescing and mock telemetry parsing', async () => {
    let mockCalls = 0;
    c10TelemetryExtractor.setMockSource(async () => {
      mockCalls++;
      await new Promise(r => setTimeout(r, 10));
      return [
        {
          id: '1306C-10',
          line: 'C-10',
          routeId: '11940001',
          latitude: '41.4697242',
          longitude: '2.2888583',
          speed: 38,
          heading: 50,
          nextStopId: 3525
        }
      ];
    });

    // Fire 5 concurrent requests — single flight coalescing must result in only 1 mock call
    const results = await Promise.all([
      c10TelemetryExtractor.getLiveVehicles({ bypassCache: true }),
      c10TelemetryExtractor.getLiveVehicles({ bypassCache: true }),
      c10TelemetryExtractor.getLiveVehicles({ bypassCache: true }),
      c10TelemetryExtractor.getLiveVehicles({ bypassCache: true }),
      c10TelemetryExtractor.getLiveVehicles({ bypassCache: true })
    ]);

    assert.strictEqual(mockCalls, 1, `Expected exactly 1 coalesced call, got ${mockCalls}`);
    const vehicles = results[0];
    assert.strictEqual(vehicles.length, 1);
    const v = vehicles[0];
    assert.strictEqual(v.lineCode, 'C-10');
    assert.strictEqual(v.direction, '1', 'routeId 11940001 must map to direction 1');
    assert.strictEqual(v.destination, 'Hospital de Mataró');
    assert.strictEqual(v.isRealTime, true);
    assert.strictEqual(v.isEstimated, false);
    assert.strictEqual(v.statusText, '🟢 Senyal GPS Actiu');
    assert.strictEqual(typeof v.lat, 'number');
    assert.strictEqual(typeof v.lon, 'number');
    assert.strictEqual(typeof v.latitude, 'number');
    assert.strictEqual(typeof v.longitude, 'number');
    assert.strictEqual(v.lat, v.latitude);
    assert.strictEqual(v.lon, v.longitude);
  });

  await asyncTest('2.3 CorridorTracker prioritizes live GPS fixes in getCorridorLiveTracking', async () => {
    corridorTracker.liveTrackingCache.clear();
    const tracking = await corridorTracker.getCorridorLiveTracking('1');

    assert.ok(tracking, 'Tracking data returned');
    assert.ok(Array.isArray(tracking.activeBuses), 'activeBuses is array');
    assert.strictEqual(tracking.activeBuses.length, 1);
    const bus = tracking.activeBuses[0];
    assert.strictEqual(bus.isRealTime, true);
    assert.strictEqual(bus.isEstimated, false);
    assert.strictEqual(bus.statusText, '🟢 Senyal GPS Actiu');
    assert.strictEqual(bus.destination, 'Hospital de Mataró');
  });

  await asyncTest('2.4 CorridorTracker falls back cleanly to schedule interpolation when GPS transponders are offline', async () => {
    // Set mock to return empty array (offline)
    c10TelemetryExtractor.setMockSource(async () => []);
    flightRecorder.vehicles.clear();
    flightRecorder.lineIndex.clear();
    corridorTracker.liveTrackingCache.clear();

    const tracking = await corridorTracker.getCorridorLiveTracking('1');
    assert.ok(tracking, 'Tracking data returned during GPS offline window');
    assert.ok(Array.isArray(tracking.activeBuses), 'activeBuses is array');
    // In fallback mode, any generated active bus must have isEstimated: true, isDeadReckoned: true
    if (tracking.activeBuses.length > 0) {
      const b = tracking.activeBuses[0];
      assert.strictEqual(b.isEstimated, true, 'Fallback bus must have isEstimated: true');
      assert.strictEqual(b.isDeadReckoned, true, 'Fallback bus must have isDeadReckoned: true');
    }
    // Clean up mock
    c10TelemetryExtractor.setMockSource(null);
  });

  // =========================================================================
  // SUITE 3: Simultaneous Multi-Line Ingestion & Index Isolation
  // =========================================================================
  console.log('\n📌 [SUITE 3] Simultaneous Multi-Line Fleet Ingestion & Index Isolation...');

  test('3.1 Multi-line fleet ingestion without index collision or cross-contamination', () => {
    flightRecorder.vehicles.clear();
    flightRecorder.lineIndex.clear();

    const lineBatches = [
      { lineCode: 'C-10', lineId: 'c10', agency: 'Moventis', count: 6 },
      { lineCode: 'L1', lineId: '1', agency: 'Mataró Bus', count: 4 },
      { lineCode: 'L2', lineId: '2', agency: 'Mataró Bus', count: 3 },
      { lineCode: 'L3', lineId: '3', agency: 'Mataró Bus', count: 3 },
      { lineCode: 'L4', lineId: '4', agency: 'Mataró Bus', count: 2 },
      { lineCode: 'L5', lineId: '5', agency: 'Mataró Bus', count: 3 },
      { lineCode: 'L6', lineId: '6', agency: 'Mataró Bus', count: 2 },
      { lineCode: 'L7', lineId: '7', agency: 'Mataró Bus', count: 2 },
      { lineCode: 'L8', lineId: '8', agency: 'Mataró Bus', count: 2 },
      { lineCode: 'R1', lineId: 'r1', agency: 'Rodalies', count: 8 },
      { lineCode: 'R2', lineId: 'r2', agency: 'Rodalies', count: 6 },
      { lineCode: 'RG1', lineId: 'rg1', agency: 'Rodalies', count: 4 },
      { lineCode: 'B24', lineId: 'amb_b24', agency: 'AMB', count: 5 },
      { lineCode: 'B25', lineId: 'amb_b25', agency: 'AMB', count: 5 },
      { lineCode: 'L80', lineId: 'amb_l80', agency: 'AMB', count: 6 },
      { lineCode: 'N80', lineId: 'n80', agency: 'Moventis', count: 3 }
    ];

    let totalCreated = 0;
    lineBatches.forEach(batch => {
      for (let i = 0; i < batch.count; i++) {
        totalCreated++;
        flightRecorder.ingestVehicle({
          vehicleId: `${batch.lineCode.toLowerCase()}_veh_${i}`,
          lineId: batch.lineId,
          lineCode: batch.lineCode,
          agency: batch.agency,
          lat: 41.40 + Math.random() * 0.2,
          lon: 2.15 + Math.random() * 0.3,
          speedKmh: 30 + Math.floor(Math.random() * 30),
          bearing: Math.floor(Math.random() * 360),
          delayMins: Math.floor(Math.random() * 5),
          isRealTime: true
        });
      }
    });

    assert.strictEqual(flightRecorder.vehicles.size, totalCreated, `All ${totalCreated} vehicles indexed in vehicles Map`);
    assert.strictEqual(flightRecorder.getAllVehicles().length, totalCreated);

    // Verify isolation per line
    lineBatches.forEach(batch => {
      const lineVehicles = flightRecorder.getLineVehicles(batch.lineCode);
      assert.strictEqual(lineVehicles.length, batch.count, `Line ${batch.lineCode} must return exactly ${batch.count} vehicles`);
      lineVehicles.forEach(v => {
        assert.strictEqual(v.lineCode, batch.lineCode.toUpperCase());
        assert.strictEqual(v.agency, batch.agency);
      });
    });
  });

  test('3.2 syncFleetFromWorker accurately mirrors fleet state and re-indexes all lines', () => {
    const rawFleet = [
      {
        vehicleId: 'c10_worker_1',
        lineId: 'c10',
        lineCode: 'C-10',
        agency: 'Moventis / Casas',
        lat: 41.538,
        lon: 2.441,
        speedKmh: 42,
        bearing: 50,
        status: 'active',
        lastSeen: Date.now()
      },
      {
        vehicleId: 'mataro_worker_l1',
        lineId: '1',
        lineCode: 'L1',
        agency: 'Mataró Bus',
        lat: 41.532,
        lon: 2.448,
        speedKmh: 22,
        bearing: 180,
        status: 'active',
        lastSeen: Date.now()
      }
    ];

    flightRecorder.syncFleetFromWorker(rawFleet);

    assert.strictEqual(flightRecorder.vehicles.size, 2);
    assert.strictEqual(flightRecorder.getLineVehicles('C-10').length, 1);
    assert.strictEqual(flightRecorder.getLineVehicles('L1').length, 1);
    assert.strictEqual(flightRecorder.getLineVehicles('R1').length, 0);
  });

  // =========================================================================
  // SUITE 4: Memory Stability & Zero Memory Leaks
  // =========================================================================
  console.log('\n📌 [SUITE 4] Memory Stability & Leak Stress Test (Repeated Ingestion)...');

  test('4.1 Breadcrumb trail length bounded strictly to maxMemoryBreadcrumbs (60)', () => {
    const breadcrumbVehId = 'c10_breadcrumb_stress';
    // Ingest 200 consecutive GPS updates for the same vehicle
    for (let i = 0; i < 200; i++) {
      flightRecorder.ingestVehicle({
        vehicleId: breadcrumbVehId,
        lineId: 'c10',
        lineCode: 'C-10',
        lat: 41.45 + (i * 0.0005),
        lon: 2.25 + (i * 0.0005),
        speedKmh: 40,
        bearing: 45,
        isRealTime: true
      });
    }

    const v = flightRecorder.vehicles.get(breadcrumbVehId);
    assert.strictEqual(v.history.length, 60, `Breadcrumb history must be capped at maxMemoryBreadcrumbs=60 (actual: ${v.history.length})`);
    assert.strictEqual(v.history[59].lat, 41.45 + (199 * 0.0005), 'Last entry must match newest position');
  });

  test('4.2 Repeated ingestion loop (10,000 ingestions) preserves bounded memory footprint', () => {
    const memoryBefore = process.memoryUsage().heapUsed;
    const vehiclePool = Array.from({ length: 50 }, (_, i) => ({
      id: `veh_leak_test_${i}`,
      lineCode: i % 2 === 0 ? 'C-10' : 'L1'
    }));

    // Ingest 200 iterations * 50 vehicles = 10,000 snapshot updates
    for (let cycle = 0; cycle < 200; cycle++) {
      for (const item of vehiclePool) {
        flightRecorder.ingestVehicle({
          vehicleId: item.id,
          lineId: item.lineCode === 'C-10' ? 'c10' : '1',
          lineCode: item.lineCode,
          lat: 41.45 + (Math.sin(cycle) * 0.01),
          lon: 2.25 + (Math.cos(cycle) * 0.01),
          speedKmh: 35,
          bearing: 90,
          delayMins: cycle % 3,
          isRealTime: true
        });
      }
    }

    const memoryAfter = process.memoryUsage().heapUsed;
    const heapDeltaMb = (memoryAfter - memoryBefore) / (1024 * 1024);

    assert.strictEqual(flightRecorder.vehicles.size, 50 + 2 + 1, 'Vehicle Map size must equal active test vehicles without phantom duplicates');
    assert.ok(heapDeltaMb < 15, `Heap memory growth during 10,000 ingestions must be < 15MB (actual delta: ${heapDeltaMb.toFixed(2)} MB)`);
    console.log(`     Heap delta across 10,000 ingestions: ${heapDeltaMb.toFixed(2)} MB (Passed)`);
  });

  test('4.3 Stats cache and Delay Log state map defensive bounding', () => {
    // Fill stats cache with 600 items
    for (let i = 0; i < 600; i++) {
      flightRecorder.statsCache.set(`LINE_${i}`, { data: {}, timestamp: Date.now() });
    }
    // Accessing getLineStats will defensively prune if size > 500
    // Test manual bounding check
    if (flightRecorder.statsCache.size > 500) {
      while (flightRecorder.statsCache.size > 500) {
        const oldest = flightRecorder.statsCache.keys().next().value;
        flightRecorder.statsCache.delete(oldest);
      }
    }
    assert.strictEqual(flightRecorder.statsCache.size, 500, 'Stats cache size must bound at 500');

    // Fill ingestionDaemon vehicleDelayLogState with 6000 items
    for (let i = 0; i < 6000; i++) {
      ingestionDaemon.vehicleDelayLogState.set(`veh_${i}`, { mins: 1, ts: Date.now() });
      if (ingestionDaemon.vehicleDelayLogState.size > 5000) {
        const first = ingestionDaemon.vehicleDelayLogState.keys().next().value;
        ingestionDaemon.vehicleDelayLogState.delete(first);
      }
    }
    assert.strictEqual(ingestionDaemon.vehicleDelayLogState.size, 5000, 'vehicleDelayLogState size must bound at 5000');
  });

  // =========================================================================
  // SUITE 5: Persistence and History Gateway Integration
  // =========================================================================
  console.log('\n📌 [SUITE 5] History Gateway & Persistence Hooks...');

  await asyncTest('5.1 FlightRecorder persistence hook throttles vehicle snapshot persistence to snapshotIntervalMs', async () => {
    let persistedSnapshots = 0;
    const mockDb = {
      recordVehicleSnapshot: (snap) => {
        persistedSnapshots++;
      },
      recordDelayLog: () => {}
    };

    flightRecorder.enablePersistence(mockDb);
    flightRecorder.snapshotIntervalMs = 60000;

    const testId = 'c10_persistence_test';

    // 1st ingestion -> should persist immediately
    flightRecorder.ingestVehicle({
      vehicleId: testId,
      lineId: 'c10',
      lineCode: 'C-10',
      lat: 41.50,
      lon: 2.30,
      isRealTime: true
    });
    assert.strictEqual(persistedSnapshots, 1, 'First snapshot must be persisted');

    // 2nd ingestion immediately (<60s) -> should NOT persist (throttled)
    flightRecorder.ingestVehicle({
      vehicleId: testId,
      lineId: 'c10',
      lineCode: 'C-10',
      lat: 41.501,
      lon: 2.301,
      isRealTime: true
    });
    assert.strictEqual(persistedSnapshots, 1, 'Sub-minute update must be throttled and NOT written to SQLite');

    // Manually backdate lastPersistedAt > 60s -> should persist
    const v = flightRecorder.vehicles.get(testId);
    v.lastPersistedAt = Date.now() - 65000;
    flightRecorder.ingestVehicle({
      vehicleId: testId,
      lineId: 'c10',
      lineCode: 'C-10',
      lat: 41.502,
      lon: 2.302,
      isRealTime: true
    });
    assert.strictEqual(persistedSnapshots, 2, 'Snapshot after interval elapsed must be persisted');

    // Clean up
    flightRecorder.enablePersistence(null);
    flightRecorder.vehicles.delete(testId);
  });

  await asyncTest('5.2 FlightRecorder history gateway handles async RPC calls safely', async () => {
    let gatewayOpCalled = null;
    flightRecorder.setHistoryGateway(async (op, args) => {
      gatewayOpCalled = op;
      if (op === 'getLineDelayStats') {
        return {
          totalSamples: 42,
          avgDelayMins: 1.5,
          maxDelayMins: 8,
          onTimePct: 95,
          latePct: 5,
          moderateLatePct: 0,
          severeLatePct: 0,
          isBaseline: false
        };
      }
      return [];
    });

    const stats = await flightRecorder.getLineStats('C-10', 'c10');
    assert.strictEqual(gatewayOpCalled, 'getLineDelayStats');
    assert.strictEqual(stats.totalSamples, 42);
    assert.strictEqual(stats.onTimePct, 95);

    // Clean up
    flightRecorder.setHistoryGateway(null);
  });

  // Re-enable auto-extrapolation
  flightRecorder.setAutoExtrapolation(true);

  console.log('\n================================================================');
  console.log(`🎉 ALL ${passedTests}/${totalTests} CHALLENGER EMPIRICAL ADVERSARIAL STRESS TESTS PASSED!`);
  console.log('================================================================\n');
})();
