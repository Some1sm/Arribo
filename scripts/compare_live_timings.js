const mouteClient = require('../src/mouteClient');
const https = require('https');

async function fetchAmbDepartures(stopCode) {
  // Let's test AMB open data / Mobilitat if accessible
  return new Promise((resolve) => {
    https.get(`https://api.ambmobilitat.cat/v1/stops/${stopCode}/departures`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', (e) => resolve({ error: e.message }));
  });
}

async function main() {
  console.log('--- Current Time:', new Date().toISOString(), '---');

  // Check Mou-te for Barcelona Metro La Pau (10008500)
  const mouteLaPau = await mouteClient.getNextDepartures('10008500', true, 'ca_ES');
  console.log('\nMou-te departures at Barcelona La Pau (10008500):');
  console.log(JSON.stringify(mouteLaPau, null, 2));

  // Check Mou-te for Target Stop Pl. Itàlia (10037202)
  const mouteTarget = await mouteClient.getNextDepartures('10037202', true, 'ca_ES');
  console.log('\nMou-te departures at Pl. Itàlia (10037202):');
  console.log(JSON.stringify(mouteTarget, null, 2));
}

main().catch(console.error);
