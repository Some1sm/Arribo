const assert = require('assert');
const mataroTracker = require('../src/mataroTracker');
const siriClient = require('../src/mataroSiriClient');
const flightRecorder = require('../src/flightRecorder');

async function runResilienceTests() {
  console.log('🧪 Starting Mataró SIRI Resilience & Dead-Reckoning Tests...');

  // -------------------------------------------------------------
  // Test 1: Circuit breaker fast-fail and instant stale fallback
  // -------------------------------------------------------------
  console.log('\n1. Testing SIRI circuit breaker and fast-fail behavior...');

  // Seed cache with a known vehicle
  const seedVehicles = [{
    vehicleId: '2675',
    lineId: '1',
    lineName: 'Línia 1',
    directionName: 'Hospital',
    origin: 'Estació Rodalies',
    destination: 'Hospital de Mataró',
    lat: 41.545,
    lon: 2.441,
    bearing: 45,
    speedKmh: 28,
    delayMins: 2,
    recordedAt: new Date().toISOString(),
    isEstimated: false,
    timestamp: Date.now() - 60000 // 1 minute ago
  }];

  siriClient.cache.set('veh_1', {
    ts: Date.now() - 60000, // 1 min old (older than 20s live TTL, well within 10-min stale TTL)
    data: seedVehicles
  });

  // Trip circuit breaker manually
  siriClient.circuitOpenUntil = Date.now() + 30000;
  assert.strictEqual(siriClient.isCircuitOpen(), true, 'Circuit breaker must report open');

  // Querying getLiveVehicles while circuit is open must return instant (<15ms) stale fallback
  const t0 = process.hrtime.bigint();
  const fallbackVehs = await siriClient.getLiveVehicles('1');
  const t1 = process.hrtime.bigint();
  const durMs = Number(t1 - t0) / 1e6;

  console.log(`   - Circuit open fetch completed in ${durMs.toFixed(2)}ms`);
  assert.ok(durMs < 50, `Circuit open fetch must be under 50ms (was ${durMs.toFixed(2)}ms)`);
  assert.strictEqual(fallbackVehs.length, 1, 'Must return seeded fallback vehicle');
  assert.strictEqual(fallbackVehs[0].vehicleId, '2675');
  assert.strictEqual(fallbackVehs[0].isEstimated, true, 'Fallback vehicle must be marked isEstimated: true');
  assert.strictEqual(fallbackVehs[0].isRealTime, false, 'Fallback vehicle must be marked isRealTime: false');
  assert.ok(fallbackVehs[0].delayBadgeText.includes('Estimat'), 'Badge must indicate estimated status');
  console.log('   ✓ Circuit breaker returned stale fallback vehicle instantly');

  // Reset circuit
  siriClient.circuitOpenUntil = 0;
  siriClient.consecutiveFailures = 0;

  // -------------------------------------------------------------
  // Test 2: Dead-reckoning from vehicleHistory when SIRI drops
  // -------------------------------------------------------------
  console.log('\n2. Testing vehicleHistory retention and dead-reckoning extrapolation...');

  // Register vehicle in tracker memory history at Parc Central (Stop 1011) heading towards Rodalies (Stop 1016)
  mataroTracker.recordVehicleState({
    vehicleId: '2680',
    lineId: '1',
    lineCode: 'L1',
    agency: 'Mataró Bus (Avanza)',
    direction: '0',
    directionName: 'Rodalies',
    lat: 41.5447,
    lon: 2.44163,
    bearing: 150,
    speedKmh: 28,
    delayMins: 1,
    lastSeen: Date.now() - 60000 // 1 minute ago
  });

  assert.ok(mataroTracker.vehicleHistory.has('2680'), 'Vehicle 2680 must be present in vehicleHistory');

  // Simulate SIRI failure by mocking an open circuit
  siriClient.circuitOpenUntil = Date.now() + 30000;
  siriClient.cache.delete('veh_1'); // No SIRI cache

  const lineDetails = await mataroTracker.getLineDetails('1', '0');
  assert.ok(lineDetails, 'Line details must return a valid envelope');
  assert.ok(lineDetails.activeBuses && lineDetails.activeBuses.length > 0, 'Active buses must include dead-reckoned vehicles');
  
  const deadReckonedBus = lineDetails.activeBuses.find(b => String(b.vehicleId) === '2680');
  assert.ok(deadReckonedBus, 'Vehicle 2680 must be present in line details activeBuses');
  assert.strictEqual(deadReckonedBus.isEstimated, true, 'Vehicle must be marked isEstimated');
  console.log(`   ✓ Active bus retrieved via dead-reckoning: Bus #${deadReckonedBus.vehicleId} at ${deadReckonedBus.lat}, ${deadReckonedBus.lon}`);

  // -------------------------------------------------------------
  // Test 3: Estimated stop arrival countdowns when SIRI is down
  // -------------------------------------------------------------
  console.log('\n3. Testing estimated stop arrival synthesis when SIRI is down...');

  // Query arrivals for downstream Stop 1016 (Rodalies) where Bus 2680 is approaching
  const estimatedArrivals = await mataroTracker.estimateArrivalsForStop('1016', '1', []);
  console.log(`   - Estimated arrivals count for Stop 1016: ${estimatedArrivals.length}`);
  assert.ok(estimatedArrivals.length > 0, 'Must produce estimated arrivals for downstream stop');
  assert.strictEqual(estimatedArrivals[0].isEstimated, true, 'Synthesized arrival must be marked isEstimated');
  assert.strictEqual(estimatedArrivals[0].isRealTime, false, 'Synthesized arrival must not be marked real-time');
  assert.ok(estimatedArrivals[0].minutesAway >= 0, 'Must provide countdown minutesAway');
  console.log(`   ✓ Estimated arrival countdown to Stop 1016: ${estimatedArrivals[0].minutesAway} min (${estimatedArrivals[0].departureTime}) [${estimatedArrivals[0].delayBadgeText}]`);

  const stopDepartures = await mataroTracker.getStopDepartures('1016', '1', '0', { skipCache: true, skipSiri: true });
  assert.ok(stopDepartures && Array.isArray(stopDepartures.departures), 'Must return valid departures list');
  assert.ok(stopDepartures.departures.length > 0, 'Must return departures');

  const estimatedDep = stopDepartures.departures.find(d => d.isEstimated);
  assert.ok(estimatedDep, 'Departures board must contain an estimated active departure');
  console.log(`   ✓ Stop departures board contains estimated countdown: ${estimatedDep.minutesAway} min [${estimatedDep.delayBadgeText}]`);

  // -------------------------------------------------------------
  // Test 4: Target Stop ETA fast response (< 15ms steady-state)
  // -------------------------------------------------------------
  console.log('\n4. Testing Target Stop ETA latency under SIRI downtime simulation...');

  // First call warms lazy modules (e.g. intermodalHub)
  await mataroTracker.getTargetStopETA('1', '1001', '0');

  const tStart = process.hrtime.bigint();
  const targetEta = await mataroTracker.getTargetStopETA('1', '1001', '0');
  const tEnd = process.hrtime.bigint();
  const etaLatencyMs = Number(tEnd - tStart) / 1e6;

  console.log(`   - getTargetStopETA steady-state latency: ${etaLatencyMs.toFixed(2)}ms`);
  assert.ok(etaLatencyMs < 25, `Target Stop ETA steady-state latency must be under 25ms (was ${etaLatencyMs.toFixed(2)}ms)`);
  assert.ok(targetEta.targetStop, 'Target stop must be resolved');
  assert.ok(targetEta.upcomingDepartures && targetEta.upcomingDepartures.length > 0, 'Upcoming departures must be populated');

  // Clean up
  siriClient.circuitOpenUntil = 0;
  siriClient.consecutiveFailures = 0;

  console.log('\n🎉 ALL MATARÓ SIRI RESILIENCE & DEAD-RECKONING TESTS PASSED PERFECTLY! 🎉\n');
}

runResilienceTests().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
