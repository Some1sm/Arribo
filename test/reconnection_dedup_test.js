/**
 * test/reconnection_dedup_test.js
 * 
 * Regression test for GPS signal loss and recovery on Mataró Bus.
 * Verifies that:
 * 1. A physical bus that momentarily drops connection is dead-reckoned without spawning duplicate ghost vehicles.
 * 2. When live GPS is recovered, any stale or dead-reckoned ghost entries are completely purged.
 * 3. Synthetic ghost vehicles (EST_*) are never ingested into flightRecorder or vehicleHistory.
 * 4. The fleet count strictly adheres to scheduled active vehicle limits.
 */

const assert = require('assert');
const mataroTracker = require('../src/mataroTracker');
const flightRecorder = require('../src/flightRecorder');

async function runReconnectionTests() {
  console.log('🧪 =========================================================================');
  console.log('🧪 RUNNING GPS DISCONNECTION & RECONNECTION DUPLICATION REGRESSION TESTS');
  console.log('🧪 =========================================================================\n');

  // Test 1: flightRecorder and vehicleHistory must strictly reject EST_* ghost buses
  console.log('📌 Test 1: Invariant - flightRecorder and vehicleHistory reject synthetic ghost buses...');
  const fakeGhost = {
    vehicleId: 'EST_1_1601',
    lineId: '1',
    direction: '0',
    lat: 41.54,
    lon: 2.44,
    isGhostVehicle: true,
    isEstimated: true
  };

  flightRecorder.ingestVehicle(fakeGhost);
  assert.strictEqual(flightRecorder.vehicles.has('EST_1_1601'), false, 'flightRecorder must NOT ingest EST_* buses');

  mataroTracker.recordVehicleState(fakeGhost);
  assert.strictEqual(mataroTracker.vehicleHistory.has('EST_1_1601'), false, 'vehicleHistory must NOT store EST_* buses');
  console.log('  ✓ Test 1 Passed: flightRecorder and vehicleHistory reject synthetic ghost buses.\n');

  // Test 2: Simulating GPS loss and dead-reckoning on Line 1
  console.log('📌 Test 2: Simulating momentary GPS signal loss (dead-reckoning without ghost spawning)...');
  mataroTracker.vehicleHistory.clear();

  const routes = mataroTracker.routesData['1'] || [];
  const lineDetails = await mataroTracker.getLineDetails('1', 'both');
  const now = Date.now();

  // Bus 2673 seen 20 seconds ago at the start of route 0
  const bus2673 = {
    vehicleId: '2673',
    lineId: '1',
    direction: '0',
    lat: 41.555,
    lon: 2.428,
    bearing: 180,
    speedKmh: 25,
    lastSeen: now - 20000,
    timestamp: now - 20000
  };
  mataroTracker.recordVehicleState(bus2673);

  // Bus 2680 live right now on direction 1
  const bus2680 = {
    vehicleId: '2680',
    lineId: '1',
    direction: '1',
    lat: 41.533,
    lon: 2.438,
    bearing: 320,
    speedKmh: 20,
    isRealTime: true,
    isEstimated: false,
    timestamp: now
  };
  mataroTracker.recordVehicleState(bus2680);

  // Process dead-reckoning on direction 0 (where bus 2673 was operating)
  const processedBuses0 = mataroTracker.processBusesWithDeadReckoning([], routes[0], lineDetails.directions[0].stops, '0', [bus2680]);
  
  // Verify bus 2673 is dead-reckoned (not dropped)
  const drBus = processedBuses0.find(b => String(b.vehicleId) === '2673');
  assert.ok(drBus, 'Bus 2673 must be dead-reckoned during 20s drop');
  assert.strictEqual(drBus.isEstimated, true, 'Dead-reckoned bus must be marked isEstimated = true');
  assert.strictEqual(drBus.isGhostVehicle, undefined, 'Dead-reckoned bus is physical, NOT a ghost vehicle');

  // Total physical buses on line (dir 0 + dir 1) must be 2
  const processedBuses1 = mataroTracker.processBusesWithDeadReckoning([bus2680], routes[1], lineDetails.directions[1].stops, '1', [bus2680]);
  const allBuses = [...processedBuses0, ...processedBuses1];
  const physicalCount = allBuses.filter(b => mataroTracker.isPhysicalVehicle(b)).length;
  assert.strictEqual(physicalCount, 2, 'Must have exactly 2 physical buses');
  console.log('  ✓ Test 2 Passed: 20s GPS drop dead-reckoned properly as physical vehicle.\n');

  // Test 3: Simulating GPS reconnection (both buses live with GPS)
  console.log('📌 Test 3: Simulating GPS reconnection (live GPS returns for bus 2673)...');
  const liveBus2673 = {
    vehicleId: '2673',
    lineId: '1',
    direction: '0',
    lat: 41.550,
    lon: 2.430,
    bearing: 185,
    speedKmh: 22,
    isRealTime: true,
    isEstimated: false,
    timestamp: Date.now()
  };
  mataroTracker.recordVehicleState(liveBus2673);

  const reconnected0 = mataroTracker.processBusesWithDeadReckoning([liveBus2673], routes[0], lineDetails.directions[0].stops, '0', [liveBus2673, bus2680]);
  const reconnected1 = mataroTracker.processBusesWithDeadReckoning([bus2680], routes[1], lineDetails.directions[1].stops, '1', [liveBus2673, bus2680]);
  const reconnectedBuses = [...reconnected0, ...reconnected1];
  
  // Both buses must be present, with ZERO duplicates
  assert.strictEqual(reconnectedBuses.length, 2, 'Must contain exactly 2 buses upon reconnection');
  const b1 = reconnectedBuses.find(b => String(b.vehicleId) === '2673');
  const b2 = reconnectedBuses.find(b => String(b.vehicleId) === '2680');
  assert.ok(b1 && !b1.isEstimated, 'Bus 2673 must be live GPS (not estimated)');
  assert.ok(b2 && !b2.isEstimated, 'Bus 2680 must be live GPS (not estimated)');

  // No synthetic ghost bus should exist
  const ghosts = reconnectedBuses.filter(b => b.isGhostVehicle || String(b.vehicleId).startsWith('EST_'));
  assert.strictEqual(ghosts.length, 0, 'Must have zero ghost buses when all physical buses are connected');
  console.log('  ✓ Test 3 Passed: Reconnection successfully purges stale estimates and yields 0 duplicates.\n');

  console.log('=========================================================================');
  console.log('🎉 ALL GPS RECONNECTION DEDUPLICATION TESTS PASSED SUCCESSFULLY! 🎉');
  console.log('=========================================================================\n');
}

runReconnectionTests().catch(err => {
  console.error('❌ RECONNECTION DEDUP TEST FAILED:', err);
  process.exit(1);
});
