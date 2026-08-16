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
  const matches = [...js.matchAll(/class\s+([A-Za-z0-9_]+)/g)];
  console.log('Classes in main:', matches.map(m => m[1]));

  const stopMatches = [...js.matchAll(/getStop[^({]*\([^)]*\)/g)];
  console.log('getStop functions:', stopMatches.map(m => m[0]));
})();
