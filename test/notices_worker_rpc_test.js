const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-notices-'));
process.env.REPORTS_DIR = path.join(scratch, 'reports');
const tracker = require('../src/mataroTracker');
const { WorkerBridge } = require('../src/core/WorkerBridge');

(async () => {
  tracker._fetchAvisos = async () => { throw new Error('Main process attempted upstream fetching'); };
  let calls = 0;
  tracker.setAvisosRpcBackend(async () => {
    calls++;
    return { avisos: [{ id: 'rpc', title: 'Informació', description: '', active: true }], timestamp: Date.now() };
  });
  const results = await Promise.all(Array.from({ length: 8 }, () => tracker.fetchAvisos()));
  assert.equal(calls, 1);
  assert(results.every(items => items[0].id === 'rpc'));
  await tracker.fetchAvisos();
  assert.equal(calls, 1);

  const bridge = new WorkerBridge();
  const generation = tracker._lineCacheGen;
  const pushed = [{ id: 'push', title: 'Informació', description: '', active: true }];
  bridge.handleWorkerMessage({ type: 'DISRUPTIONS_UPDATE', payload: { timestamp: Date.now(), disruptions: pushed } });
  pushed[0].id = 'mutated';
  assert.equal((await tracker.fetchAvisos())[0].id, 'push');
  assert(tracker._lineCacheGen > generation);

  tracker.avisosCacheTime = 0;
  tracker.setAvisosRpcBackend(async () => { calls++; throw new Error('worker unavailable'); });
  assert.equal((await tracker.fetchAvisos())[0].id, 'push');
  assert.equal(tracker.avisosCacheTime, 0);
  assert.equal(tracker._avisosInflight, null);
  tracker.setAvisosRpcBackend(async () => ({ avisos: [], timestamp: Date.now() }));
  assert.deepEqual(await tracker.fetchAvisos(), []);

  tracker.avisosCacheTime = 0;
  let finish;
  tracker.setAvisosRpcBackend(() => new Promise(resolve => { finish = resolve; }));
  const pending = tracker.fetchAvisos();
  bridge.handleWorkerMessage({ type: 'DISRUPTIONS_UPDATE', payload: { timestamp: Date.now(), disruptions: [{ id: 'newer' }] } });
  finish({ avisos: [{ id: 'older' }], timestamp: Date.now() - 10000 });
  assert.equal((await pending)[0].id, 'newer');
  console.log('PASS: notices RPC coalescing, push updates, isolation, invalidation, failure/retry and push/RPC race');
})().finally(() => fs.rmSync(scratch, { recursive: true, force: true })).then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
