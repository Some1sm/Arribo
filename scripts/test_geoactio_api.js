const https = require('https');
const fs = require('fs');

function fetchGeoActio(endpoint) {
  return new Promise((resolve, reject) => {
    const url = `https://matarobus.geoactio.com/api/${endpoint}`;
    const options = {
      rejectUnauthorized: false,
      headers: {
        'User-Agent': 'MataroBus/2.4.0 (Android; com.geoactio.matarobus)',
        'user': 'USERWSMATARO',
        'pass': 'USERWSMATARO%67',
        'Accept': 'application/json'
      }
    };

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ endpoint, status: res.statusCode, len: data.length, data }));
    }).on('error', reject);
  });
}

async function run() {
  console.log('Testing GeoActio REST API with extracted credentials (USERWSMATARO / USERWSMATARO%67)...');

  const testEndpoints = [
    'lineas',
    'paradas',
    'stops',
    'lines',
    'buses',
    'posiciones',
    'tiempos',
    'trayectos',
    'rutas',
    'getInfo',
    'puntosVenta',
    'avisos'
  ];

  for (const ep of testEndpoints) {
    try {
      const res = await fetchGeoActio(ep);
      console.log(`[${res.status}] /api/${ep} -> Length: ${res.len}`);
      if (res.status === 200) {
        fs.writeFileSync(`scripts/geoactio_${ep}.json`, res.data);
        console.log(`🎉 SUCCESS /api/${ep}:\n`, res.data.substring(0, 500), '\n');
      }
    } catch (e) {
      console.log(`Error on /api/${ep}:`, e.message);
    }
  }
}

run().catch(console.error);
