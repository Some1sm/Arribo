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
  const js = await get('https://app.ambmobilitat.cat/static/js/2.06332518.chunk.js');
  console.log('Chunk 2 length:', js.length);
  const v2matches = js.match(/\/v2\/[^"'\s`)]+/g) || [];
  console.log('Chunk 2 /v2/ paths:', [...new Set(v2matches)]);
  const gtfsMatches = js.match(/\/gtfs\/[^"'\s`)]+/g) || [];
  console.log('Chunk 2 /gtfs/ paths:', [...new Set(gtfsMatches)]);
  const estimationsMatches = js.match(/[^"'\s`)]*estimation[^"'\s`)]*/gi) || [];
  console.log('Chunk 2 estimation keywords:', [...new Set(estimationsMatches)].slice(0, 15));
})();
