const https = require('https');
const http = require('http');
const dns = require('dns');

const hosts = [
  'mataro.geoactio.com',
  'matarobus.geoactio.com',
  'ws.geoactio.com',
  'api.geoactio.com',
  'sae.geoactio.com',
  'actiosae.geoactio.com',
  'mataro.actiosae.com',
  'mataro.actioapp.com',
  'matarobus.avanzagrupo.com',
  'mataro-bus.avanzagrupo.com',
  'ws.avanzagrupo.com',
  'api.avanzagrupo.com',
  'sae.mataro.cat',
  'opendata.mataro.cat'
];

async function checkHost(host) {
  return new Promise((resolve) => {
    dns.lookup(host, (err, address) => {
      if (err) {
        resolve({ host, status: 'DNS_FAIL', err: err.code });
      } else {
        // Try HTTPS get
        const req = https.get(`https://${host}/`, { rejectUnauthorized: false, timeout: 4000 }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve({ host, address, httpsStatus: res.statusCode, headers: res.headers, sample: data.substring(0, 200) }));
        });
        req.on('error', (e) => resolve({ host, address, httpsError: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ host, address, timeout: true }); });
      }
    });
  });
}

async function run() {
  console.log('Probing hosts...');
  for (const host of hosts) {
    const res = await checkHost(host);
    console.log(JSON.stringify(res, null, 2));
  }
}

run().catch(console.error);
