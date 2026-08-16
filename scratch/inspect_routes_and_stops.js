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
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  console.log('Fetching /gtfs/routes-and-stops...');
  const data = await get('/gtfs/routes-and-stops');
  console.log('Keys:', Object.keys(data));
  console.log('busamb structure keys:', Object.keys(data.busamb || {}));
  console.log('renfe structure keys:', Object.keys(data.renfe || {}));

  if (data.busamb) {
    if (data.busamb.stops) {
      console.log('busamb.stops count:', Object.keys(data.busamb.stops).length);
      const firstStopKey = Object.keys(data.busamb.stops)[0];
      console.log('Sample busamb stop:', firstStopKey, data.busamb.stops[firstStopKey]);
    }
    if (data.busamb.routes) {
      console.log('busamb.routes count:', data.busamb.routes.length);
    }
  }

  if (data.renfe) {
    if (data.renfe.stops) {
      console.log('renfe.stops count:', Object.keys(data.renfe.stops).length);
      const firstStopKey = Object.keys(data.renfe.stops)[0];
      console.log('Sample renfe stop:', firstStopKey, data.renfe.stops[firstStopKey]);
    }
  }
})();
