const http = require('http');
const corridorTracker = require('../src/corridorTracker');

async function testBackendDirectly() {
  console.log('--- TEST 1: corridorTracker.getTargetStopETA(1) (Dir 1: to Mataró) ---');
  const etaDir1 = await corridorTracker.getTargetStopETA('1');
  console.log('Target Stop:', etaDir1.targetStop.name, '-', etaDir1.targetStop.stopName);
  console.log('Next Bus:', etaDir1.nextBus ? `${etaDir1.nextBus.departureTime} (${etaDir1.nextBus.formattedStatus})` : 'None');
  console.log(`Upcoming Departures: ${etaDir1.upcomingDepartures.length}`);
  etaDir1.upcomingDepartures.forEach((d, i) => {
    console.log(`  ${i + 1}. [${d.departureTime}] ${d.destination} -> ${d.formattedStatus} (Realtime: ${d.isRealtime})`);
  });

  console.log('\n--- TEST 2: corridorTracker.getTargetStopETA(0) (Dir 0: to Barcelona) ---');
  const etaDir0 = await corridorTracker.getTargetStopETA('0');
  console.log('Target Stop:', etaDir0.targetStop.name, '-', etaDir0.targetStop.stopName);
  console.log('Next Bus:', etaDir0.nextBus ? `${etaDir0.nextBus.departureTime} (${etaDir0.nextBus.formattedStatus})` : 'None');
  console.log(`Upcoming Departures: ${etaDir0.upcomingDepartures.length}`);
  etaDir0.upcomingDepartures.forEach((d, i) => {
    console.log(`  ${i + 1}. [${d.departureTime}] ${d.destination} -> ${d.formattedStatus} (Realtime: ${d.isRealtime})`);
  });

  console.log('\n--- TEST 3: corridorTracker.getStops() ---');
  const stops1 = corridorTracker.getStops('1');
  const stops0 = corridorTracker.getStops('0');
  console.log(`Direction 1 stops count: ${stops1.length}`);
  console.log(`Direction 0 stops count: ${stops0.length}`);
  console.log(`First stop Dir 1: ${stops1[0]?.name}, Last stop: ${stops1[stops1.length - 1]?.name}`);

  console.log('\n--- TEST 4: corridorTracker.getCorridorLiveTracking(1) ---');
  const corridor = await corridorTracker.getCorridorLiveTracking('1');
  console.log(`Scanned ${corridor.checkpoints.length} checkpoints.`);
  corridor.checkpoints.forEach(cp => {
    const next = cp.nextBus ? `${cp.nextBus.departureTime} (${cp.nextBus.formattedStatus})` : 'No upcoming bus';
    console.log(`  Checkpoint [${cp.zone}] ${cp.name}: Next -> ${next}`);
  });
  console.log(`Active buses detected on corridor: ${corridor.activeBuses.length}`);
  corridor.activeBuses.forEach(b => {
    console.log(`  🚌 Bus Trip: ${b.tripId} @ ${b.nearestCheckpoint} (${b.minutesToCheckpoint} min away, progress: ${b.progressPercentage}%)`);
  });

  console.log('\n✅ ALL BACKEND TESTS COMPLETED SUCCESSFULLY!');
}

testBackendDirectly().catch(err => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
