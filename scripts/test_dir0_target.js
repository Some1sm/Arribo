const corridorTracker = require('../src/corridorTracker');

async function testDir0() {
  const res = await corridorTracker.getTargetStopETA('0');
  console.log('Target Stop ETA for Direction 0:');
  console.log(JSON.stringify(res, null, 2));
}

testDir0().catch(console.error);
