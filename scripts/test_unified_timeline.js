const corridorTracker = require('../src/corridorTracker');

async function test() {
  console.log('Testing unified trip timeline logic...');
  const res = await corridorTracker.getCorridorLiveTracking('1');
  console.log('Active bus:', res.activeBuses[0]?.fromStop, '->', res.activeBuses[0]?.toStop, 'Seq:', res.activeBuses[0]?.fromSeq, '->', res.activeBuses[0]?.toSeq);
  console.log('\nUnified Checkpoints:');
  res.checkpoints.forEach(cp => {
    console.log(`- Checkpoint ${cp.name} (Seq ${cp.seq}): ${cp.nextBus?.departureTime} | Teòric: ${cp.nextBus?.scheduledTime} | Status: ${cp.nextBus?.formattedStatus} | Badge: ${cp.nextBus?.delayBadgeText} | Passed: ${cp.nextBus?.isPassed}`);
  });
}

test().catch(console.error);
