const corridorTracker = require('../src/corridorTracker');

async function main() {
  const data = await corridorTracker.getCorridorLiveTracking('1');
  console.log('Checkpoint schedules check for Direction 1:');
  data.checkpoints.forEach(cp => {
    console.log(`Node: ${cp.name} (#${cp.seq}) -> Next: ${cp.nextBus?.departureTime} | Teòric: ${cp.nextBus?.scheduledTime} (${cp.nextBus?.delayBadgeText})`);
  });
}

main().catch(console.error);
