'use strict';

const assert = require('node:assert/strict');
const bridge = require('../src/core/WorkerBridge');
bridge.start = () => {};
const ingestionDaemon = require('../src/ingestionDaemon');
const app = require('../server');
const http = require('node:http');

async function testDriftScheduleTiming() {
  console.log('📌 Testing drift schedule timing at 04:1x Europe/Madrid...');

  let checkCalled = 0;
  const originalCheck = ingestionDaemon.checkScheduleDrift;
  ingestionDaemon.checkScheduleDrift = async () => {
    checkCalled++;
    return { drift: false, checkedAt: new Date().toISOString(), differencesCount: 0 };
  };

  try {
    ingestionDaemon.lastDriftDate = null;

    // 03:30 Madrid (UTC 01:30 in Sept) -> should NOT trigger
    const at0330 = Date.UTC(2026, 8, 24, 1, 30, 0);
    ingestionDaemon.checkScheduleDriftSchedule(at0330);
    assert.equal(checkCalled, 0, 'Must not trigger at 03:30');

    // 04:15 Madrid (UTC 02:15 in Sept) -> MUST trigger
    const at0415 = Date.UTC(2026, 8, 24, 2, 15, 0);
    ingestionDaemon.checkScheduleDriftSchedule(at0415);
    assert.equal(checkCalled, 1, 'Must trigger at 04:15');

    // 04:18 Madrid same day -> MUST NOT trigger twice on the same date
    const at0418 = Date.UTC(2026, 8, 24, 2, 18, 0);
    ingestionDaemon.checkScheduleDriftSchedule(at0418);
    assert.equal(checkCalled, 1, 'Must not trigger twice on the same day');

    // 04:12 Madrid NEXT day (2026-09-25) -> MUST trigger again
    const atNextDay0412 = Date.UTC(2026, 8, 25, 2, 12, 0);
    ingestionDaemon.checkScheduleDriftSchedule(atNextDay0412);
    assert.equal(checkCalled, 2, 'Must trigger again on the next day');

    console.log('  ✓ Drift schedule timing operates strictly at 04:1x Madrid time without double-checks');
  } finally {
    ingestionDaemon.checkScheduleDrift = originalCheck;
  }
}

async function testHealthEndpointDrift() {
  console.log('📌 Testing /api/health schedule.drift contract...');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;

  const getHealth = () => new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/api/health`, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });

  try {
    // 1. Initial / cold state: schedule.drift is null
    bridge.workerMetrics = {};
    const cold = await getHealth();
    assert.equal(cold.schedule.drift, null, 'Cold schedule.drift must be null');

    // 2. Populated drift status
    const mockDrift = {
      drift: false,
      checkedAt: '2026-09-28T04:15:00.000Z',
      differencesCount: 0
    };
    bridge.workerMetrics = { scheduleDrift: mockDrift };
    const withDrift = await getHealth();
    assert.deepEqual(withDrift.schedule.drift, mockDrift, 'schedule.drift must match workerMetrics.scheduleDrift');

    console.log('  ✓ /api/health exposes schedule.drift accurately');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function main() {
  await testDriftScheduleTiming();
  await testHealthEndpointDrift();
  console.log('\n🎉 ALL SCHEDULE DRIFT TESTS PASSED!\n');
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
