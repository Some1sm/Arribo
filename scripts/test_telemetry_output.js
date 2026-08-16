const corridorTracker = require('../src/corridorTracker');

async function test() {
  const data = await corridorTracker.getCorridorLiveTracking('1');
  console.log('Active Buses telemetry:', JSON.stringify(data.activeBuses, null, 2));
}

test().catch(console.error);
