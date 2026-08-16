const https = require('https');
const fs = require('fs');

const authHeader = 'Basic ' + Buffer.from('USERWSMATARO:USERWSMATARO%67').toString('base64');

function fetchGeoActio(endpoint) {
  return new Promise((resolve, reject) => {
    const url = `https://matarobus.geoactio.com/api/${endpoint}`;
    const options = {
      rejectUnauthorized: false,
      headers: {
        'User-Agent': 'MataroBus/2.4.0 (Android; com.geoactio.matarobus)',
        'Authorization': authHeader,
        'Accept': 'application/json'
      }
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ raw: data });
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  console.log('Downloading trajectories for lines 1 to 8...');
  const lineIds = ['1', '2', '3', '4', '5', '6', '7', '8'];
  const allRoutes = {};

  for (const id of lineIds) {
    // Try query param idLinea=
    let res = await fetchGeoActio(`trayectos?idLinea=${id}`);
    if (!res.success) res = await fetchGeoActio(`trayectos?id=${id}`);
    if (!res.success) res = await fetchGeoActio(`trayectos?linea=${id}`);

    console.log(`Line ${id} -> Success: ${res.success}, Routes:`, res.message ? res.message.length : 0);
    allRoutes[id] = res.message || res;
  }

  fs.writeFileSync('data/mataro_routes_full.json', JSON.stringify(allRoutes, null, 2));
  console.log('Sample Line 1 trajectory:\n', JSON.stringify(allRoutes['1'], null, 2).substring(0, 1500));
}

run().catch(console.error);
