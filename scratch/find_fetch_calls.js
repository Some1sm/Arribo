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
  const c1 = await get('https://app.ambmobilitat.cat/static/js/main.44732a54.chunk.js');
  const c2 = await get('https://app.ambmobilitat.cat/static/js/2.06332518.chunk.js');
  const all = c1 + c2;

  const fetchMatches = [...all.matchAll(/fetch\(([^)]+)\)/g)];
  console.log('Found fetch calls:');
  fetchMatches.forEach(m => console.log('-', m[1]));
})();
