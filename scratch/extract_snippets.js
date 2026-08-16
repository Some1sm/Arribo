const https = require('https');

async function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

(async () => {
  const res = await get('https://www.sagales.com/linies/3');
  const termMatches = [...res.data.matchAll(/modalTerm\((\d+)\)/g)];
  console.log(`Found ${termMatches.length} modalTerm matches:`);
  for (const m of termMatches) {
    const routeId = m[1];
    const index = m.index;
    const start = Math.max(0, index - 400);
    const end = Math.min(res.data.length, index + 400);
    const snippet = res.data.substring(start, end).replace(/\s+/g, ' ');
    console.log(`\n=== Route ID: ${routeId} ===`);
    console.log(snippet);
  }
})();
