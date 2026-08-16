const crypto = require('crypto');
const https = require('https');

function generateAuthToken() {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:T.Z]/g, '').substring(0, 14);
  const secretKey = 'mouteapi' + timestamp.substring(0, 8);
  const at = crypto.createHash('md5').update(secretKey).digest('hex');
  return { at, timestamp };
}

function probeEndpoint(endpointPath) {
  return new Promise((resolve) => {
    const { at, timestamp } = generateAuthToken();
    const headers = {
      'AT': at,
      'Timestamp': timestamp,
      'User-Agent': 'okhttp/4.9.2',
      'Accept': 'application/json',
      'X-Requested-With': 'cat.gencat.moute'
    };

    const url = `https://mouteapi.gencat.cat/mouteapi/infrastructure/${endpointPath}`;
    https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ path: endpointPath, status: res.statusCode, json: JSON.parse(data) });
        } catch (e) {
          resolve({ path: endpointPath, status: res.statusCode, raw: data.substring(0, 150) });
        }
      });
    }).on('error', (e) => resolve({ path: endpointPath, error: e.message }));
  });
}

async function main() {
  const candidateEndpoints = [
    'nextdeparturesNEW?paradaId=10037202&useRealTime=true&language=ca_ES',
    'line?idLinia=02498',
    'lineNEW?idLinia=02498',
    'lines?network=cat',
    'network?networkId=cat',
    'vehiclepositions',
    'vehiclepositions?lineId=02498',
    'vehicles?lineId=02498',
    'vehiclesNEW?idLinia=02498',
    'tracking?lineId=02498',
    'sirivm?lineId=02498',
    'siri-vm?lineId=02498',
    'realtime?lineId=02498',
    'realtimeNEW?idLinia=02498',
    'trip?tripId=02498%20_131162900_001_3272703_1_15145680',
    'tripupdates?lineId=02498',
    'gtfsrt/vehiclepositions',
    'gtfsrt/tripupdates'
  ];

  console.log('--- Probing Mou-te API endpoints ---');
  for (const ep of candidateEndpoints) {
    const res = await probeEndpoint(ep);
    console.log(`[${res.status}] /infrastructure/${ep}`);
    if (res.status === 200) {
      console.log('   ✅ 200 OK Response:', JSON.stringify(res.json || res.raw).substring(0, 300));
    }
  }
}

main().catch(console.error);
