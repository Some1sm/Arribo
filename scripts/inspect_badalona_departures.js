const corridorTracker = require('../src/corridorTracker');
const mouteClient = require('../src/mouteClient');

async function test() {
  const depData = await mouteClient.getNextDepartures('10025777', true, 'ca_ES');
  console.log('Mou-te API raw lineas for 10025777:');
  const lineas = depData?.parada?.lineas?.linia || [];
  lineas.forEach(l => {
    console.log(`Line ${l.nomLinia}:`, l.proximosAutobuses?.proximoAutobus);
  });

  const parsed = corridorTracker.parseDepartures(depData, 'GEN_PF08015093', '1', '10025777', 7);
  console.log('\nParsed departures for 10025777:');
  parsed.forEach(p => {
    console.log(`- ${p.departureTime} (Sched: ${p.scheduledTime}, Min: ${p.minutesAway}, RT: ${p.isRealtime}, Status: ${p.formattedStatus})`);
  });
}

test().catch(console.error);
