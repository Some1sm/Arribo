const https = require('https');

async function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

(async () => {
  const data = await get('https://www.sagales.com/real-time-bus/680/0');
  console.log('=== Sagales Real-time JSON keys ===:', Object.keys(data));
  console.log('\n--- Linia ---:', data.linia);
  console.log('\n--- Schedule ---:', data.schedule);
  console.log('\n--- Ruta stops (first 2) ---:', data.ruta?.stops?.slice(0, 2));
  console.log('\n--- Bus entities (first entity) ---:', JSON.stringify(data.bus?.entities?.[0], null, 2));
})();
