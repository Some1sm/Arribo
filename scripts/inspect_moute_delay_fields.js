const mouteClient = require('../src/mouteClient');

async function main() {
  const data = await mouteClient.getNextDepartures('10037202', true, 'ca_ES');
  console.log('Mou-te departures for Plaça d\'Itàlia (10037202):');
  console.log(JSON.stringify(data, null, 2));
}

main().catch(console.error);
