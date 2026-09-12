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
  // Test 7: Saturday Line 1 Terminal Layover & Missing GPS Regulation Vehicle Synthesis
  console.log('📌 Test 7: Saturday Line 1 Terminal Layover & Missing GPS Regulation Vehicle Synthesis...');
  const saturday1243 = new Date('2026-09-12T10:43:00Z'); // 12:43 CEST (Saturday)
  const routes1_7 = mataroTracker.routesData['1'] || [];
  const allDirs1_7 = [
    { dirId: '0', stops: routes1_7[0]?.stops || [] },
    { dirId: '1', stops: routes1_7[1]?.stops || [] }
  ];

  const mockLiveBusesL1 = [
    {
      tripId: 'LIVE_2667',
      vehicleId: '2667',
      lineId: '1',
      direction: '0',
      lat: 41.5553,
      lon: 2.42927,
      speedKmh: 18,
      totalProgress: 7,
      isEstimated: false,
      isRealTime: true
    },
    {
      tripId: 'LIVE_2672',
      vehicleId: '2672',
      lineId: '1',
      direction: '1',
      lat: 41.5393,
      lon: 2.42299,
      speedKmh: 24,
      totalProgress: 41,
      isEstimated: false,
      isRealTime: true
    }
  ];

  // Test with 'both' directions
  const synthResult7Both = mataroTracker.synthesizeMissingScheduledBuses(
    '1',
    'both',
    routes1_7,
    allDirs1_7,
    mockLiveBusesL1,
    saturday1243,
    mockLiveBusesL1
  );

  assert.strictEqual(synthResult7Both.fleetStatus.scheduledVehicles, 3, 'Line 1 Saturday at 12:43 must have 3 scheduled vehicles (2 in transit + 1 in layover)');
  assert.strictEqual(synthResult7Both.fleetStatus.liveGpsVehicles, 2, 'Must count 2 live GPS vehicles');
  assert.strictEqual(synthResult7Both.fleetStatus.estimatedVehicles, 1, 'Must synthesize 1 missing estimated vehicle');
  assert.strictEqual(synthResult7Both.syntheticBuses.length, 1, 'Must produce exactly 1 synthetic bus');

  const layoverBus = synthResult7Both.syntheticBuses[0];
  assert.strictEqual(layoverBus.vehicleId, 'EST_1_1252', 'Synthesized bus must be EST_1_1252 for the 12:52 departure');
  assert.strictEqual(layoverBus.direction, '1', 'Layover bus must be on Direction 1 (Rodalies -> Hospital)');
  assert.strictEqual(layoverBus.isTerminalLayover, true, 'Must have isTerminalLayover = true');
  assert.strictEqual(layoverBus.speedKmh, 0, 'Layover vehicle speed must be 0 km/h');
  assert.strictEqual(layoverBus.isGhostVehicle, true, 'Must be marked as isGhostVehicle');
  assert.strictEqual(layoverBus.isEstimated, true, 'Must be marked as isEstimated');
  assert.strictEqual(layoverBus.isRealTime, false, 'Must not be marked as real-time');
  assert.ok(layoverBus.lat >= 41.530 && layoverBus.lat <= 41.536, `Layover bus must be positioned at Estació Rodalies (lat: ${layoverBus.lat})`);
  assert.ok(layoverBus.lon >= 2.440 && layoverBus.lon <= 2.450, `Layover bus must be positioned at Estació Rodalies (lon: ${layoverBus.lon})`);
  assert.strictEqual(layoverBus.departureTime, '12:52', 'Departure time must be 12:52');

  // Test with '1' direction specifically (as viewed when user inspects Sentit 2)
  const synthResult7Dir1 = mataroTracker.synthesizeMissingScheduledBuses(
    '1',
    '1',
    routes1_7,
    allDirs1_7,
    [mockLiveBusesL1[1]], // only live bus on dir 1
    saturday1243,
    mockLiveBusesL1
  );

  assert.strictEqual(synthResult7Dir1.syntheticBuses.length, 1, 'Direction 1 must synthesize the 12:52 layover bus');
  assert.strictEqual(synthResult7Dir1.syntheticBuses[0].vehicleId, 'EST_1_1252', 'Direction 1 must synthesize EST_1_1252');

  // Test transition post-departure at 12:54 (2 min in transit along Direction 1)
  const saturday1254 = new Date('2026-09-12T10:54:00Z');
  const liveVehsAt1254 = [
    {
      tripId: 'LIVE_2667',
      vehicleId: '2667',
      lineId: '1',
      direction: '0',
      lat: 41.539,
      lon: 2.442,
      speedKmh: 20,
      totalProgress: 57,
      isEstimated: false,
      isRealTime: true
    },
    {
      tripId: 'LIVE_2672',
      vehicleId: '2672',
      lineId: '1',
      direction: '1',
      lat: 41.5546,
      lon: 2.4313,
      speedKmh: 22,
      totalProgress: 96,
      isEstimated: false,
      isRealTime: true
    }
  ];

  const synthResult7Transit = mataroTracker.synthesizeMissingScheduledBuses(
    '1',
    'both',
    routes1_7,
    allDirs1_7,
    liveVehsAt1254,
    saturday1254,
    liveVehsAt1254
  );

  assert.strictEqual(synthResult7Transit.syntheticBuses.length, 1, 'In-transit bus must still be synthesized at 12:54');
  const transitBus = synthResult7Transit.syntheticBuses[0];
  assert.strictEqual(transitBus.isTerminalLayover, false, 'At 12:54 vehicle is now in transit');
  assert.strictEqual(transitBus.speedKmh, 20, 'In-transit vehicle speed is 20 km/h');
  assert.ok(transitBus.totalProgress > 0, 'In-transit vehicle progress must be > 0');
  assert.ok(transitBus.toStop.includes('1019') || transitBus.toStop.includes('President Macià'), 'Next stop must be President Macià (Stop 1019)');

  console.log('  ✓ Test 7 Passed: Terminal layover regulation and post-departure transition fully verified.\n');

  // Test 8: Strict Fleet Size Ceiling Invariant (Saturday Line 1 Never Exceeds 3 Buses)
  console.log('📌 Test 8: Saturday Line 1 Strict 3-Bus Fleet Ceiling Invariant...');
  const saturday1306 = new Date('2026-09-12T11:06:04Z'); // 13:06:04 CEST
  for (let p0 of [10, 30, 60, 71, 80]) {
    for (let p1 of [10, 30, 50, 70, 100]) {
      const live = [
        { vehicleId: '2667', direction: '0', lat: 41.544, lon: 2.441, totalProgress: p0, isRealTime: true, isEstimated: false },
        { vehicleId: '2672', direction: '1', lat: 41.556, lon: 2.430, totalProgress: p1, isRealTime: true, isEstimated: false }
      ];
      const synth = mataroTracker.synthesizeMissingScheduledBuses('1', 'both', routes1_7, allDirs1_7, live, saturday1306, live);
      const totalBuses = synth.fleetStatus.liveGpsVehicles + synth.syntheticBuses.length;
      assert.ok(totalBuses <= 3, `Total active buses on Saturday Line 1 (${totalBuses}) must never exceed 3 (p0=${p0}, p1=${p1})`);
      assert.ok(synth.fleetStatus.scheduledVehicles <= 3, `Scheduled vehicles on Saturday Line 1 (${synth.fleetStatus.scheduledVehicles}) must never exceed 3`);
    }
  }
  console.log('  ✓ Test 8 Passed: Physical fleet ceiling (3 buses) strictly enforced across all progress states.\n');

  // Test 9: Dynamic Timetable-Derived Fleet Requirement Computation (Zero Hardcoded Fleet)
  console.log('📌 Test 9: Dynamic Schedule Fleet Computation (Zero Hardcoding)...');
  
  // Line 1: 5 on weekday peak, 3 on Saturday, 0 off-hours (03:00)
  const l1Weekday = mataroSchedules.getScheduledFleetRequirement('1', 'weekday', 59400); // 16:30
  const l1SatNoon = mataroSchedules.getScheduledFleetRequirement('1', 'saturday', 47164); // 13:06
  const l1Night = mataroSchedules.getScheduledFleetRequirement('1', 'weekday', 10800); // 03:00
  
  assert.strictEqual(l1Weekday, 5, 'Line 1 weekday peak dynamically calculated as 5 vehicles');
  assert.strictEqual(l1SatNoon, 3, 'Line 1 Saturday dynamically calculated as 3 vehicles');
  assert.strictEqual(l1Night, 0, 'Line 1 off-hours dynamically calculated as 0 vehicles');

  // Line 8: 0 on Sunday morning (no service), 2 on Sunday afternoon (operating)
  const l8SunMorning = mataroSchedules.getScheduledFleetRequirement('8', 'sunday', 36000); // 10:00
  const l8SunAfternoon = mataroSchedules.getScheduledFleetRequirement('8', 'sunday', 61200); // 17:00
  assert.strictEqual(l8SunMorning, 0, 'Line 8 Sunday morning dynamically calculated as 0 vehicles');
  assert.strictEqual(l8SunAfternoon, 2, 'Line 8 Sunday afternoon dynamically calculated as 2 vehicles');

  console.log('  ✓ Test 9 Passed: Dynamic fleet requirement accurately computed from timetable cycle/headway (0 hardcoding).\n');

  console.log('=========================================================================');
  console.log('🎉 ALL SCHEDULED FLEET ESTIMATION TESTS PASSED SUCCESSFULLY! 🎉');
  console.log('=========================================================================');
}

runFleetEstimationTests().catch(err => {
  console.error('❌ FLEET ESTIMATION TEST FAILED:', err);
  process.exit(1);
});
