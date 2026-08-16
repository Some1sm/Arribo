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
  const chunkMatches = js.match(/static\/js\/[^"']+\.chunk\.js/g) || [];
  console.log('Other chunks mentioned in main:', [...new Set(chunkMatches)]);
})();
