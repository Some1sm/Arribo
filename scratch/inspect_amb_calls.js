const https = require('https');

async function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

(async () => {
  const js = await get('https://app.ambmobilitat.cat/static/js/main.44732a54.chunk.js');
  const matches = [...js.matchAll(/https:\/\/api\.ambmobilitat\.cat\/v2/g)];
  for (const m of matches) {
    const idx = m.index;
    console.log('\n=== Context ===');
    console.log(js.substring(Math.max(0, idx - 200), Math.min(js.length, idx + 400)));
  }
})();
