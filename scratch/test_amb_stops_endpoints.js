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
          resolve({ status: res.statusCode, raw: data.substring(0, 200) });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const paths = [
    '/stops/busamb:100005',
    '/stops/busamb:109303',
    '/stops/renfe:79500',
    '/stops/79500',
    '/gtfs/stops/busamb',
    '/gtfs/stops/renfe',
    '/gtfs/stop_times',
    '/gtfs/shapes',
    '/estimations/busamb:100005',
    '/estimations/100005',
    '/estimations/stop/100005',
    '/gtfs/estimations/100005',
    '/gtfs/realtime'
  ];

  for (const p of paths) {
    const res = await get(p);
    console.log(`GET /v2${p} -> Status: ${res.status}`);
    if (res.status === 200) {
      console.log('>>> Data keys:', Object.keys(res.data), 'Sample:', JSON.stringify(res.data).substring(0, 150));
    }
  }
})();
