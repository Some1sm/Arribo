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
  const routeIds = [280, 380, 381, 480, 580, 581, 680, 683];
  for (const rId of routeIds) {
    const res = await get(`https://www.sagales.com/termometre/${rId}/0`);
    const titleMatch = res.data.match(/<h4 class=["']modal-title["'][^>]*>([\s\S]*?)<\/h4>/);
    const stopsMatches = [...res.data.matchAll(/class=["']parada[^"']*["'][^>]*>([\s\S]*?)<\/li>/g)];
    const stopNames = stopsMatches.map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean);
    console.log(`\n=== Route ${rId} ===`);
    console.log('Title:', titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : 'N/A');
    console.log('Total Stops:', stopNames.length);
    console.log('Stops Sample:', stopNames.slice(0, 5).join(' -> '), '... ->', stopNames.slice(-2).join(' -> '));
  }
})();
