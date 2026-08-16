const https = require('https');

async function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

(async () => {
  console.log('Fetching app.ambmobilitat.cat stop page...');
  const res = await get('https://app.ambmobilitat.cat/stops/busamb:109303');
  console.log('Status:', res.status, 'Length:', res.data.length);
  const scripts = res.data.match(/src=["']([^"']+\.js[^"']*)["']/g) || [];
  console.log('Scripts:', scripts);
})();
