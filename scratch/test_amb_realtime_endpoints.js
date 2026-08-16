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
  console.log('1. Testing AMB Bus real-time: /bus/stops/100005/realtimes...');
  const res1 = await get('/bus/stops/100005/realtimes');
  console.log('Status 1:', res1.status, 'Data:', res1.data);

  console.log('\n2. Testing Rodalies real-time: /gtfs/renfe/realtime/79500 (Mataró Station)...');
  const res2 = await get('/gtfs/renfe/realtime/79500');
  console.log('Status 2:', res2.status, 'Data:', res2.data);

  console.log('\n3. Testing Rodalies shapes: /gtfs/renfe/shapes/51_R1...');
  const res3 = await get('/gtfs/renfe/shapes/51_R1');
  console.log('Status 3:', res3.status, 'Points:', res3.data?.length || res3.data);
})();
