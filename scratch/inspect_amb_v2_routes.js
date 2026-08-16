const https = require('https');

async function get(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.ambmobilitat.cat',
      path: `/v2${path}`,
      method: 'GET',
      headers: {
        'x-api-key': '28EbLJtP0A6CtrWeXp6zE1zy3kp4RzmnaA2sy8JM',
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch(e) {
          resolve({ status: res.statusCode, raw: data.substring(0, 300) });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  console.log('Fetching /v2/gtfs/routes...');
  const res = await get('/gtfs/routes');
  console.log('Keys:', Object.keys(res.data));
  console.log('busamb routes count:', res.data.busamb?.length);
  console.log('renfe routes count:', res.data.renfe?.length);
  console.log('fgc routes count:', res.data.fgc?.length);
  console.log('metro routes count:', res.data.metro?.length);
  console.log('trambesos routes count:', res.data.trambesos?.length);
  console.log('trambaix routes count:', res.data.trambaix?.length);

  if (res.data.busamb?.length > 0) {
    console.log('\nSample busamb route:', JSON.stringify(res.data.busamb[0], null, 2));
  }

  if (res.data.renfe?.length > 0) {
    console.log('\nSample renfe (Rodalies) route:', JSON.stringify(res.data.renfe[0], null, 2));
  }
})();
