const corridorTracker = require('../src/corridorTracker');

async function test() {
  const res = await corridorTracker.getCorridorLiveTracking('1');
  console.log('Dir 1 Active Buses:', res.activeBuses);
  console.log('Dir 1 Checkpoints:');
  res.checkpoints.forEach(cp => {
    console.log(`- ${cp.name} (Seq ${cp.seq}): ${cp.nextBus?.departureTime} (${cp.nextBus?.formattedStatus}) | Delay: ${cp.nextBus?.delayBadgeText} | Realtime: ${cp.nextBus?.isRealtime}`);
  });
}

test().catch(console.error);
