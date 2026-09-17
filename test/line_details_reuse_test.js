const assert = require('node:assert/strict');
const Module = require('node:module');
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === './core/intermodalHub') return {};
  return load.call(this, id, ...args);
};
const tracker = require('../src/mataroTracker');
Module._load = load;
const siri = require('../src/mataroSiriClient');
const recorder = require('../src/flightRecorder');

async function run() {
  const realNow = Date.now;
  const compute = tracker._computeLineDetails;
  let now = 2000000000100;
  let calls = 0;
  Date.now = () => now;
  const seed = line => siri.cache.set(`veh_${line}`, { ts: now, data: [] });
  for (const line of ['1', '2', '3']) seed(line);
  tracker._computeLineDetails = async (lineId, direction) => {
    calls++;
    await Promise.resolve();
    return { lineId, direction, activeBuses: [{ vehicleId: 'B1' }, { vehicleId: 'B2' }] };
  };
  try {
    tracker.invalidateLineDetailsCache();
    const [a, b] = await Promise.all([tracker.getLineDetails('1', '0'), tracker.getLineDetails('l1', '0')]);
    assert.equal(calls, 1);
    a.activeBuses[0].vehicleId = 'changed';
    a.activeBuses.reverse();
    a.delayStats = { injected: true };
    assert.deepEqual(b.activeBuses.map(v => v.vehicleId), ['B1', 'B2']);
    const again = await tracker.getLineDetails('1', '0');
    assert.deepEqual(again, b);
    assert.equal(calls, 1);
    now += 1000;
    await tracker.getLineDetails('1', '0');
    assert.equal(calls, 2);
    seed('1');
    await tracker.getLineDetails('1', '0');
    assert.equal(calls, 3, 'new SIRI observation must invalidate reuse');
    tracker.syncFleetVehicles([]);
    await tracker.getLineDetails('1', '0');
    assert.equal(calls, 4);
    siri.cache.get('veh_1').ts = now - siri.cacheTtlMs;
    await tracker.getLineDetails('1', '0');
    assert.equal(calls, 5, 'expired upstream data must not be hidden by cache');
    seed('1');
    calls = 0;
    for (const options of [new Date(now), { targetDate: now }, { referenceDate: now }, { skipCache: true }, { skipSiri: true }, { custom: true }]) {
      await tracker.getLineDetails('1', '0', options);
    }
    assert.equal(calls, 6);
    calls = 0;
    await tracker.getLineDetails('2', '0');
    await tracker.getLineDetails('2', 'both');
    await tracker.getLineDetails('3', '0');
    assert.equal(calls, 3);

    tracker.invalidateLineDetailsCache();
    let resolveOld;
    tracker._computeLineDetails = () => new Promise(resolve => { resolveOld = resolve; });
    const oldRequest = tracker.getLineDetails('1', '0');
    await Promise.resolve();
    tracker.syncFleetVehicles([]);
    tracker._computeLineDetails = async () => ({ activeBuses: [{ vehicleId: 'NEW' }] });
    const fresh = await tracker.getLineDetails('1', '0');
    resolveOld({ activeBuses: [{ vehicleId: 'OLD' }] });
    await oldRequest;
    assert.deepEqual(await tracker.getLineDetails('1', '0'), fresh, 'old in-flight result must not poison a new generation');

    tracker.invalidateLineDetailsCache();
    tracker._computeLineDetails = async () => { throw new Error('computation failed'); };
    await assert.rejects(tracker.getLineDetails('1', '0'), /computation failed/);
    assert.equal(tracker._lineDetailsInflight.size, 0);
    tracker._computeLineDetails = async () => ({ activeBuses: [] });
    await tracker.getLineDetails('1', '0');
    assert(tracker._lineDetailsCache.size <= 24);
    console.log('PASS: line reuse, expiry, nested isolation, source invalidation, option isolation, in-flight race, and retry');
  } finally {
    tracker._computeLineDetails = compute;
    Date.now = realNow;
    recorder.setAutoExtrapolation(false);
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
