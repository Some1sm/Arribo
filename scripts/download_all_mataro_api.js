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
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  console.log('Downloading all Mataró Bus data from GeoActio REST API...');

  // 1. Lineas
  const lineas = await fetchGeoActio('lineas');
  console.log('Lineas count:', lineas.data ? lineas.data.lineas?.length : 0);
  fs.writeFileSync('data/mataro_lineas.json', JSON.stringify(lineas.data, null, 2));

  // 2. Paradas
  const paradas = await fetchGeoActio('paradas');
  console.log('Paradas count:', paradas.data ? paradas.data.paradas?.length : 0);
  fs.writeFileSync('data/mataro_paradas.json', JSON.stringify(paradas.data, null, 2));

  // 3. Trayectos
  const trayectos = await fetchGeoActio('trayectos');
  console.log('Trayectos count:', trayectos.data ? trayectos.data.trayectos?.length : 0);
  fs.writeFileSync('data/mataro_trayectos.json', JSON.stringify(trayectos.data, null, 2));

  // 4. Avisos
  const avisos = await fetchGeoActio('avisos');
  console.log('Avisos count:', avisos.data ? avisos.data.avisos?.length : 0);
  fs.writeFileSync('data/mataro_avisos.json', JSON.stringify(avisos.data, null, 2));

  console.log('🎉 All core Mataró Bus datasets downloaded and saved to data/ !');
}

run().catch(console.error);
