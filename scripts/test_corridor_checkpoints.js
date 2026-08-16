const corridorTracker = require('../src/corridorTracker');

async function test() {
  console.log('Testing corridor checkpoints output...');
  const res = await corridorTracker.getCorridorLiveTracking('1');
  console.log('Active Buses:', res.activeBuses);
  console.log('Checkpoints:');
  res.checkpoints.forEach(cp => {
    console.log(`- ${cp.name} (Seq ${cp.seq}): NextBus=${cp.nextBus?.departureTime} (Sched: ${cp.nextBus?.scheduledTime}), Delay=${cp.nextBus?.delayBadgeText}, Status=${cp.nextBus?.formattedStatus}`);
  });
}

test().catch(console.error);
