const https = require('https');

const authCombos = [
  { name: 'Headers user & pass', headers: { 'user': 'USERWSMATARO', 'pass': 'USERWSMATARO%67' } },
  { name: 'Headers User & Pass', headers: { 'User': 'USERWSMATARO', 'Pass': 'USERWSMATARO%67' } },
  { name: 'Headers USER & PASS', headers: { 'USER': 'USERWSMATARO', 'PASS': 'USERWSMATARO%67' } },
  { name: 'Basic Auth encoded', headers: { 'Authorization': 'Basic ' + Buffer.from('USERWSMATARO:USERWSMATARO%67').toString('base64') } },
  { name: 'Basic Auth decoded (%67 -> g)', headers: { 'Authorization': 'Basic ' + Buffer.from('USERWSMATARO:USERWSMATAROg').toString('base64') } },
  { name: 'Query params user & pass', query: '?user=USERWSMATARO&pass=USERWSMATARO%67' },
  { name: 'Query params customerId', query: '?customerId=USERWSMATARO' }
];

function testAuth(opt) {
  return new Promise((resolve) => {
    const path = '/api/paradas' + (opt.query || '');
    const options = {
      hostname: 'matarobus.geoactio.com',
      port: 443,
      path: path,
      method: 'GET',
      rejectUnauthorized: false,
      headers: {
        'User-Agent': 'MataroBus/2.4.0 (Android; com.geoactio.matarobus)',
        'Accept': 'application/json',
        ...(opt.headers || {})
      }
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ name: opt.name, status: res.statusCode, body: data });
      });
    }).on('error', (e) => resolve({ name: opt.name, error: e.message }));
  });
}

async function run() {
  for (const c of authCombos) {
    const res = await testAuth(c);
    console.log(`[${res.status}] ${res.name} -> ${res.body}`);
  }
}

run().catch(console.error);
