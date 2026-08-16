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
  console.log('JS Length:', js.length);
  const urls = js.match(/https?:\/\/[^"'\s)]+/g) || [];
  console.log('URLs in main chunk:', [...new Set(urls)].slice(0, 20));
  const apiMatches = js.match(/["'](\/api\/[^"']+)["']/g) || [];
  console.log('API routes in main chunk:', [...new Set(apiMatches)]);
})();
