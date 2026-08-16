const corridorTracker = require('../src/corridorTracker');
const mouteClient = require('../src/mouteClient');

async function test() {
  console.log('Testing Plaça Itàlia (D) direction 0 departures...');
  const data = await mouteClient.getNextDepartures('10037202', true, 'ca_ES');
  const res = corridorTracker.parseDepartures(data, 'GEN_184749_2', '0', '10037202', 2);
  console.log('\nDepartures:');
  res.forEach(d => {
    console.log(`- ${d.departureTime} | Sched: ${d.scheduledTime} | Delay: ${d.delayBadgeText} | Status: ${d.formattedStatus}`);
  });
}

test().catch(console.error);
