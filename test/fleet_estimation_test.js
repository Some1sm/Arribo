/**
 * test/fleet_estimation_test.js
 * 
 * Verifies the Scheduled Active Fleet Estimation engine and Theoretical Ghost Bus Synthesis
 * for Mataró Bus Urbà (L1–L8).
 */

const assert = require('assert');
const mataroTracker = require('../src/mataroTracker');
const mataroSchedules = require('../src/data/mataroSchedules');

async function runFleetEstimationTests() {
  console.log('🧪 =========================================================================');
  console.log('🧪 RUNNING SCHEDULED FLEET ESTIMATION & GHOST BUS SYNTHESIS TESTS');
  console.log('🧪 =========================================================================\n');

  // Test 1: Active Trip Synthesis during Weekday Peak Hours (16:30) with 0 GPS
  console.log('📌 Test 1: Simulating Line 1 at 16:30:00 on a Weekday with 0 GPS telemetry...');
  
  const testDate1 = new Date('2026-09-09T14:30:00Z'); // 16:30 CEST
  
  const lineDetails1 = await mataroTracker.getLineDetails('1', 'both');
  assert.ok(lineDetails1, 'getLineDetails returned valid object');
  assert.ok(lineDetails1.fleetStatus, 'fleetStatus exists on lineDetails');

  const routes1 = mataroTracker.routesData['1'] || [];
  const synthResult1 = mataroTracker.synthesizeMissingScheduledBuses('1', 'both', routes1, lineDetails1.directions, [], testDate1);

  console.log(`  -> Scheduled active vehicles: ${synthResult1.fleetStatus.scheduledVehicles}`);
  console.log(`  -> Synthesized ghost vehicles: ${synthResult1.syntheticBuses.length}`);
  console.log(`  -> Fleet coverage: ${synthResult1.fleetStatus.fleetCoveragePct}%`);

  assert.ok(synthResult1.fleetStatus.scheduledVehicles > 0, 'Should detect scheduled trips active at 16:30');
  assert.strictEqual(synthResult1.syntheticBuses.length, synthResult1.fleetStatus.scheduledVehicles, 'Should synthesize a ghost bus for each unmatched trip');
  assert.strictEqual(synthResult1.fleetStatus.liveGpsVehicles, 0, 'Live GPS count should be 0');
  assert.strictEqual(synthResult1.fleetStatus.fleetCoveragePct, 0, 'Fleet coverage should be 0% when no GPS');

  synthResult1.syntheticBuses.forEach((bus, i) => {
    assert.ok(bus.isGhostVehicle, `Bus ${i} must have isGhostVehicle = true`);
    assert.strictEqual(bus.isEstimated, true, `Bus ${i} must have isEstimated = true`);
    assert.strictEqual(bus.isRealTime, false, `Bus ${i} must have isRealTime = false`);
    assert.ok(typeof bus.lat === 'number' && !isNaN(bus.lat), `Bus ${i} lat must be valid number`);
    assert.ok(typeof bus.lon === 'number' && !isNaN(bus.lon), `Bus ${i} lon must be valid number`);
    assert.strictEqual(bus.lat, bus.latitude, `Bus ${i} dual-compat schema lat == latitude`);
    assert.strictEqual(bus.lon, bus.longitude, `Bus ${i} dual-compat schema lon == longitude`);
    assert.ok(bus.lat >= 41.5 && bus.lat <= 41.6, `Bus ${i} lat within Mataró bounds: ${bus.lat}`);
    assert.ok(bus.lon >= 2.4 && bus.lon <= 2.5, `Bus ${i} lon within Mataró bounds: ${bus.lon}`);
    assert.ok(bus.departureTime, `Bus ${i} must have departureTime`);
    assert.ok(bus.delayBadgeText.includes('Estimat'), `Bus ${i} must have ghost delayBadgeText`);
  });

  console.log('  ✓ Test 1 Passed: 100% of ghost buses synthesized with valid schemas & bounds.\n');

  // Test 2: Dynamic Trip Pairing with Live GPS
  console.log('📌 Test 2: Dynamic Trip Pairing (Matching a live GPS bus to an active trip)...');

  const firstGhost = synthResult1.syntheticBuses[0];
  const mockLiveBus = {
    tripId: 'LIVE_SIRI_BUS_101',
    vehicleId: '101',
    lineId: '1',
    direction: firstGhost.direction,
    lat: firstGhost.lat,
    lon: firstGhost.lon,
    latitude: firstGhost.lat,
    longitude: firstGhost.lon,
    bearing: firstGhost.bearing,
    isEstimated: false,
    isRealTime: true
  };

  const synthResult2 = mataroTracker.synthesizeMissingScheduledBuses('1', 'both', routes1, lineDetails1.directions, [mockLiveBus], testDate1);

  console.log(`  -> Scheduled active vehicles: ${synthResult2.fleetStatus.scheduledVehicles}`);
  console.log(`  -> Live GPS vehicles: ${synthResult2.fleetStatus.liveGpsVehicles}`);
  console.log(`  -> Remaining ghost vehicles: ${synthResult2.syntheticBuses.length}`);
  console.log(`  -> Fleet coverage: ${synthResult2.fleetStatus.fleetCoveragePct}%`);

  assert.strictEqual(synthResult2.fleetStatus.liveGpsVehicles, 1, 'Should register 1 live GPS vehicle');
  assert.strictEqual(synthResult2.syntheticBuses.length, synthResult1.syntheticBuses.length - 1, 'Should pair 1 trip and synthesize 1 fewer ghost bus');
  assert.ok(synthResult2.fleetStatus.fleetCoveragePct > 0, 'Fleet coverage should be > 0%');

  console.log('  ✓ Test 2 Passed: Dynamic trip pairing correctly matched live bus to scheduled trip.\n');

  // Test 3: Off-Hours Invariant (03:00 AM)
  console.log('📌 Test 3: Off-hours inactive service check (03:00 AM)...');

  const nightDate = new Date('2026-09-09T01:00:00Z'); // 03:00 CEST
  const synthResult3 = mataroTracker.synthesizeMissingScheduledBuses('1', 'both', routes1, lineDetails1.directions, [], nightDate);

  assert.strictEqual(synthResult3.fleetStatus.scheduledVehicles, 0, 'No scheduled vehicles at 03:00');
  assert.strictEqual(synthResult3.syntheticBuses.length, 0, 'No ghost buses synthesized at 03:00');
  assert.strictEqual(synthResult3.fleetStatus.estimatedVehicles, 0, 'Estimated vehicles should be 0');

  console.log('  ✓ Test 3 Passed: 0 vehicles scheduled or synthesized off-hours.\n');

  // Test 4: Line 8 Weekend Afternoon Constraint
  console.log('📌 Test 4: Line 8 Weekend Afternoon constraint...');

  const sundayMorning = new Date('2026-09-13T08:00:00Z'); // 10:00 CEST
  const routes8 = mataroTracker.routesData['8'] || [];
  const synthResult4 = mataroTracker.synthesizeMissingScheduledBuses('8', 'both', routes8, [], [], sundayMorning);

  assert.strictEqual(synthResult4.fleetStatus.scheduledVehicles, 0, 'Line 8 has no Sunday morning trips');
  assert.strictEqual(synthResult4.syntheticBuses.length, 0, 'Line 8 synthesizes 0 buses Sunday morning');

  const sundayAfternoon = new Date('2026-09-13T15:00:00Z'); // 17:00 CEST
  const synthResult5 = mataroTracker.synthesizeMissingScheduledBuses('8', 'both', routes8, [], [], sundayAfternoon);

  assert.ok(synthResult5.fleetStatus.scheduledVehicles > 0, 'Line 8 has Sunday afternoon trips');
  assert.ok(synthResult5.syntheticBuses.length > 0, 'Line 8 synthesizes active ghost buses Sunday afternoon');

  console.log(`  -> Line 8 Sunday Morning: ${synthResult4.syntheticBuses.length} buses`);
  console.log(`  -> Line 8 Sunday Afternoon: ${synthResult5.syntheticBuses.length} buses`);
  console.log('  ✓ Test 4 Passed: Line 8 calendar constraints respected perfectly.\n');

  // Test 5: Integration with getLineDetails Endpoint Flow
  console.log('📌 Test 5: Integration with getLineDetails for Line 2...');

  const lineDetails2 = await mataroTracker.getLineDetails('2', '0');
  assert.ok(lineDetails2.fleetStatus, 'Line 2 details include fleetStatus');
  assert.ok(typeof lineDetails2.fleetStatus.scheduledVehicles === 'number', 'scheduledVehicles is a number');
  assert.ok(typeof lineDetails2.fleetStatus.liveGpsVehicles === 'number', 'liveGpsVehicles is a number');
  assert.ok(typeof lineDetails2.fleetStatus.estimatedVehicles === 'number', 'estimatedVehicles is a number');
  assert.ok(Array.isArray(lineDetails2.activeBuses), 'activeBuses is an array');

  console.log(`  -> Line 2 activeBuses total: ${lineDetails2.activeBuses.length}`);
  console.log(`  -> Fleet status:`, lineDetails2.fleetStatus);
  console.log('  ✓ Test 5 Passed: getLineDetails returns full fleet telemetry and status.\n');

  // Test 6: Saturday Anti-Bunching & Fleet Cap Invariant
  console.log('📌 Test 6: Saturday Anti-Bunching & Headway Fleet Cap Invariant...');
  const saturdayNoon = new Date('2026-09-12T10:15:00Z'); // 12:15 CEST (Saturday)
  const routes6 = mataroTracker.routesData['6'] || [];
  
  // Simulate 1 live bus already operating on Dir 1 of Line 6
  const mockLiveBusL6 = {
    tripId: 'LIVE_BUS_L6',
    vehicleId: '2683',
    lineId: '6',
    direction: '1',
    lat: 41.542,
    lon: 2.437,
    totalProgress: 27,
    isEstimated: false,
    isRealTime: true
  };

  const synthResult6 = mataroTracker.synthesizeMissingScheduledBuses(
    '6',
    '1',
    routes6,
    [],
    [mockLiveBusL6],
    saturdayNoon,
    [mockLiveBusL6]
  );

  // Line 6 Dir 1 has 1 scheduled trip and 1 live bus on Saturday noon -> Direction cap must prevent ghost bus!
  assert.strictEqual(
    synthResult6.syntheticBuses.length,
    0,
    'Must NOT synthesize duplicate ghost bus when live bus already operates on the direction'
  );
  assert.strictEqual(synthResult6.fleetStatus.liveGpsVehicles, 1, 'Should record 1 live GPS vehicle');
  assert.strictEqual(synthResult6.fleetStatus.estimatedVehicles, 0, 'Estimated vehicles must be 0');
  console.log('  ✓ Test 6 Passed: Direction and whole-line caps strictly prevent duplicate ghost buses and headway bunching.\n');

  console.log('=========================================================================');
  console.log('🎉 ALL SCHEDULED FLEET ESTIMATION TESTS PASSED SUCCESSFULLY! 🎉');
  console.log('=========================================================================');
}

runFleetEstimationTests().catch(err => {
  console.error('❌ FLEET ESTIMATION TEST FAILED:', err);
  process.exit(1);
});
