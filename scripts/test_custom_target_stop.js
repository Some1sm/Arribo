const http = require('http');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function test() {
  console.log('Testing custom target stop selection...');
  
  // 1. Default (no stopId specified)
  const defaultRes = await fetchJson('http://localhost:3000/api/c10/target-eta?direction=1');
  console.log('Default Target Stop:', defaultRes.data.targetStop.name, '| Code:', defaultRes.data.targetStop.code);

  // 2. Custom stop: Montgat Nord (10027798)
  const customRes1 = await fetchJson('http://localhost:3000/api/c10/target-eta?direction=1&stopId=10027798');
  console.log('Custom Target Stop 1 (Montgat):', customRes1.data.targetStop.name, '| Code:', customRes1.data.targetStop.code, '| Next Bus:', customRes1.data.nextBus?.departureTime);

  // 3. Custom stop: Premià de Mar (10037205)
  const customRes2 = await fetchJson('http://localhost:3000/api/c10/target-eta?direction=1&stopId=10037205');
  console.log('Custom Target Stop 2 (Premià):', customRes2.data.targetStop.name, '| Code:', customRes2.data.targetStop.code, '| Next Bus:', customRes2.data.nextBus?.departureTime);
}

test().catch(console.error);
