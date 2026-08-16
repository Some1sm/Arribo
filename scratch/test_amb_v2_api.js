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
  console.log('--- Testing AMB Mobilitat API v2 ---');
  
  // Test stop departures / estimations for a stop (e.g. 100005, 109303, 100257)
  const testPaths = [
    '/gtfs/stops',
    '/gtfs/routes',
    '/gtfs/stop/100005/estimations',
    '/gtfs/stop/100005',
    '/gtfs/estimations/stop/100005',
    '/gtfs/realtime/stop/100005',
    '/gtfs/line/B25',
    '/gtfs/line/L80',
    '/search/place/Badalona'
  ];

  for (const p of testPaths) {
    try {
      const res = await get(p);
      console.log(`GET /v2${p} -> Status: ${res.status}`);
      if (res.status === 200 && res.data) {
        console.log('>>> Result keys:', Object.keys(res.data), 'Sample:', Array.isArray(res.data) ? `Array(${res.data.length})` : JSON.stringify(res.data).substring(0, 200));
      }
    } catch(e) {
      console.error(e.message);
    }
  }
})();
