const https = require('https');
const http = require('http');

function fetchFollow(url) {
  return new Promise((resolve) => {
    const isHttps = url.startsWith('https:');
    const client = isHttps ? https : http;
    const req = client.get(url, { rejectUnauthorized: false, headers: { 'User-Agent': 'MataroBus/1.0' }, timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ url, status: res.statusCode, location: res.headers.location, data: data.substring(0, 400) });
      });
    });
    req.on('error', (e) => resolve({ url, error: e.message }));
  });
}

async function run() {
  const r1 = await fetchFollow('http://matarobus.geoactio.com/api/paradas');
  console.log('r1:', r1);

  if (r1.location) {
    const r2 = await fetchFollow(r1.location);
    console.log('r2:', r2);
  }

  // Also try https directly
  const r3 = await fetchFollow('https://matarobus.geoactio.com/index.php/api/getLineas');
  console.log('r3:', r3);
}

run().catch(console.error);
