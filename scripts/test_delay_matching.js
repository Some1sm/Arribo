const fs = require('fs');
const path = require('path');
const mouteClient = require('../src/mouteClient');
const corridorTracker = require('../src/corridorTracker');

async function main() {
  const etaDir1 = await corridorTracker.getTargetStopETA('1');
  console.log('Target Stop ETA Result with Delay comparison:');
  console.log('Next Bus:', etaDir1.nextBus);
  console.log('\nUpcoming Departures:');
  etaDir1.upcomingDepartures.forEach(d => console.log(d));
}

main().catch(console.error);
