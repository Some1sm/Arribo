const corridorTracker = require('../src/corridorTracker');
const mouteClient = require('../src/mouteClient');

async function main() {
  const data = await mouteClient.getNextDepartures('10025777', true, 'ca_ES');
  console.log('Raw Mou-te data for 10025777:');
  console.log(JSON.stringify(data, null, 2));

  const parsed = corridorTracker.parseDepartures(data, 'GEN_PF08015014', '1', '10025777', 7);
  console.log('Parsed departures:');
  console.log(JSON.stringify(parsed, null, 2));
}

main().catch(console.error);
