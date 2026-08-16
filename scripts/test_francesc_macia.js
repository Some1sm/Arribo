const corridorTracker = require('../src/corridorTracker');

async function main() {
  const res = await corridorTracker.getStopDepartures('10025777', '1');
  console.log('Departures for c. Francesc Macià (10025777):');
  console.log(JSON.stringify(res, null, 2));
}

main().catch(console.error);
