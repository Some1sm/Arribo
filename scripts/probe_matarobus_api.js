const http = require('http');
const https = require('https');

const endpoints = [
  'api',
  'api/lineas',
  'api/lines',
  'api/paradas',
  'api/stops',
  'api/buses',
  'api/posiciones',
  'api/estimaciones',
  'api/tiempos',
  'index.php/api',
  'index.php/api/lineas',
  'index.php/api/lines',
  'index.php/api/paradas',
  'index.php/api/stops',
  'index.php/api/buses',
  'index.php/api/posiciones',
  'index.php/api/estimaciones',
  'index.php/api/tiempos',
  'index.php/api/getInfo',
  'index.php/api/getLineas',
  'index.php/api/getParadas',
  'index.php/api/getTiempos',
  'index.php/api/getPosiciones',
  'index.php/api/getEstimaciones',
  'index.php/api/getPasoParada',
  'index.php/api/getBuses',
  'index.php/api/v1/lines',
  'index.php/api/v1/stops',
  'index.php/api/v1/buses',
  'index.php/ws/getLineas',
  'index.php/ws/getParadas',
  'index.php/ws/getTiempos',
  'index.php/ws/getPosiciones',
  'ws/getLineas',
  'ws/getParadas',
  'ws/getTiempos',
  'servicios/getLineas',
  'servicios/getParadas',
  'servicios/getTiempos',
  'servicios/getPosiciones',
  'index.php/servicios/getLineas',
  'index.php/servicios/getParadas',
  'index.php/servicios/getTiempos',
  'index.php/servicios/getPosiciones',
  'index.php/site/login',
  'index.php/app/getLineas',
  'index.php/app/getParadas',
  'index.php/app/getTiempos',
  'index.php/app/getPosiciones'
];

function fetchPath(path) {
  return new Promise((resolve) => {
    const url = `http://matarobus.geoactio.com/${path}`;
    const req = http.get(url, { headers: { 'User-Agent': 'MataroBus/1.0 (Android; com.geoactio.matarobus)' }, timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ path, status: res.statusCode, headers: res.headers, len: data.length, body: data.substring(0, 300) });
      });
    });
    req.on('error', (e) => resolve({ path, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ path, timeout: true }); });
  });
}

async function run() {
  console.log('Testing matarobus.geoactio.com endpoints...');
  for (const ep of endpoints) {
    const res = await fetchPath(ep);
    if (res.status !== 404 && res.status !== 302 && !res.error && !res.timeout) {
      console.log(`🎯 [FOUND ${res.status}] /${res.path} -> ${res.body}`);
    } else if (res.status === 302 && !res.headers?.location?.includes('login')) {
      console.log(`🔄 [REDIRECT ${res.status}] /${res.path} -> ${res.headers.location}`);
    } else {
      console.log(`[${res.status || 'ERR'}] /${res.path}`);
    }
  }
}

run().catch(console.error);
