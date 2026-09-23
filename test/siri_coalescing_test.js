const assert = require('assert');

// Focused regression: concurrent identical SIRI requests must share one
// upstream call; different keys must not share; settled promises (success
// and failure) must clear so later calls start fresh.

async function run() {
  const siriClient = require('../src/mataroSiriClient');

  // Isolate from any state other tests might have set
  siriClient.cache.clear();
  siriClient._inflight.clear();
  siriClient.circuitOpenUntil = 0;
  siriClient.consecutiveFailures = 0;

  let upstreamCalls = 0;
  siriClient.setRpcBackend(async (op, args) => {
    upstreamCalls++;
    await new Promise(r => setTimeout(r, 25));
    if (op === 'getMataroLiveVehicles') {
      return [{
        vehicleId: 'TEST_1',
        lineId: args.lineRef,
        lat: 41.5381,
        lon: 2.4447,
        bearing: 90,
        speedKmh: 30,
        delayMins: 0,
        isEstimated: false,
        timestamp: Date.now()
      }];
    }
    return [];
  });

  // 1. Cold-cache burst of 6 identical calls -> exactly one upstream call
  const burst = await Promise.all(Array.from({ length: 6 }, () => siriClient.getLiveVehicles('1')));
  assert.strictEqual(upstreamCalls, 1, `burst must coalesce to one upstream call, got ${upstreamCalls}`);
  for (const r of burst) assert.strictEqual(r[0].vehicleId, 'TEST_1', 'all callers receive same data');
  assert.strictEqual(siriClient._inflight.size, 0, 'in-flight map must be cleared after settle');

  // 2. Fresh cache hit -> still one upstream call total
  await siriClient.getLiveVehicles('1');
  assert.strictEqual(upstreamCalls, 1, 'fresh cache must not trigger upstream');

  // 3. Different line -> its own upstream call
  await siriClient.getLiveVehicles('2');
  assert.strictEqual(upstreamCalls, 2, 'different lineRef must not share the request');

  // 4. Different stop key isolation
  let stopCalls = 0;
  siriClient.setRpcBackend(async () => { stopCalls++; await new Promise(r => setTimeout(r, 20)); return [{ lineId: '1', minutesAway: 5, departureTime: '10:00' }]; });
  const stopBurst = await Promise.all([siriClient.getStopArrivals('1016', '1'), siriClient.getStopArrivals('1016', '1')]);
  assert.strictEqual(stopCalls, 1, 'identical stop burst must coalesce');
  assert.strictEqual(stopBurst[0][0].minutesAway, 5);
  assert.strictEqual(stopCalls, 1);
  await siriClient.getStopArrivals('1001', '1');
  assert.strictEqual(stopCalls, 2, 'different stop must fetch separately');

  // 5. Failure clears in-flight; retry starts a new upstream attempt
  let failures = 0;
  siriClient.setRpcBackend(async () => { failures++; throw new Error('upstream down'); });
  const firstAttempt = await siriClient.getLiveVehicles('9');
  assert.deepStrictEqual(firstAttempt, [], 'upstream failure with no cache returns empty');
  assert.strictEqual(failures, 1, 'the failure must reach the backend exactly once');
  assert.strictEqual(siriClient._inflight.size, 0, 'failed promise must be removed from in-flight map');

  // circuit is now open (2 consecutive failures) — reset to test retry path
  siriClient.circuitOpenUntil = 0;
  siriClient.consecutiveFailures = 0;
  let okAfterFail = 0;
  siriClient.setRpcBackend(async () => { okAfterFail++; return [{ vehicleId: 'OK_1', lineId: '9', lat: 41.5, lon: 2.44 }]; });
  const recovered = await siriClient.getLiveVehicles('9');
  assert.strictEqual(okAfterFail, 1, 'request after failure must attempt upstream again');
  assert.strictEqual(recovered[0].vehicleId, 'OK_1', 'recovery returns fresh data');

  // 6. Concurrent callers on a failing request all get the fallback (no unhandled rejection)
  siriClient.cache.clear();
  siriClient.circuitOpenUntil = 0;
  siriClient.consecutiveFailures = 0;
  let failCalls = 0;
  siriClient.setRpcBackend(async () => { failCalls++; throw new Error('boom'); });
  const results = await Promise.all([
    siriClient.getLiveVehicles('7'),
    siriClient.getLiveVehicles('7'),
    siriClient.getLiveVehicles('7')
  ]);
  assert.strictEqual(failCalls, 1, 'concurrent failures must coalesce to one upstream call');
  for (const r of results) assert.deepStrictEqual(r, []);

  console.log('🎉 ALL SIRI COALESCING TESTS PASSED! 🎉');
}

run().then(() => process.exit(0)).catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
