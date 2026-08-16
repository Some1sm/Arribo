const corridorTracker = require('../src/corridorTracker');
const mouteClient = require('../src/mouteClient');

async function test() {
  const res = await corridorTracker.getStopDepartures('10025777', '1');
  console.log('Returned departures length:', res.departures.length);
  res.departures.forEach(d => {
    console.log(`- ${d.departureTime} (Scheduled: ${d.scheduledTime}) -> ${d.formattedStatus} (${d.delayBadgeText})`);
  });
}

test().catch(console.error);
