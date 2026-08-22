const assert = require('assert');
const { WorkerBridge } = require('../src/core/WorkerBridge');

async function testWorkerCrashAndRestart() {
  console.log('🧪 Testing WorkerBridge Crash Detection and Auto-Restart...');

  const bridge = new WorkerBridge({
    pingIntervalMs: 1000,
    pingTimeoutMs: 3000,
    baseBackoffMs: 300,
    maxBackoffMs: 1000
  });

  bridge.start();

  // 1. Wait for first worker to be ready
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Worker did not send initial WORKER_READY')), 10000);
    bridge.once('ready', () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  const firstPid = bridge.pid;
  assert(firstPid > 0, 'First worker PID should be valid');
  assert.strictEqual(bridge.isHealthy, true, 'Bridge should be healthy initially');
  console.log('   ✅ First worker running with PID:', firstPid);

  // 2. Kill the child process forcefully to simulate an unexpected crash
  console.log('   Simulating unexpected crash (process.kill SIGKILL)...');
  const restartPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Worker did not auto-restart in time')), 10000);
    bridge.once('ready', (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });

  process.kill(firstPid, 'SIGKILL');

  // Wait for restarted worker to become ready
  const restartPayload = await restartPromise;
  const secondPid = bridge.pid;

  assert(secondPid > 0, 'Second worker PID should be valid');
  assert.notStrictEqual(secondPid, firstPid, 'Second worker PID should be different from crashed worker');
  assert.strictEqual(bridge.isHealthy, true, 'Bridge should be healthy after restart');
  assert(bridge.restarts >= 1, `Restart count should be >= 1 (actual: ${bridge.restarts})`);

  console.log(`   ✅ Auto-restart verified: Old PID ${firstPid} -> New PID ${secondPid} (Restarts: ${bridge.restarts})`);

  // Clean shutdown
  await bridge.shutdown(3000);
  console.log('   ✅ Clean shutdown of restarted worker completed.');

  console.log('\n🎉 AUTO-RESTART RESILIENCE TEST PASSED PERFECTLY!\n');
}

testWorkerCrashAndRestart()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Auto-restart test failed:', err);
    process.exit(1);
  });
