const https = require('https');

async function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json, text/html, */*' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    }).on('error', reject);
  });
}

(async () => {
  const types = [1, 2, 3, 4];
  for (const t of types) {
    const res = await get(`https://www.sagales.com/linies/${t}`);
    console.log(`linies/${t} -> status: ${res.status}, length: ${res.data.length}`);
    const matches = res.data.match(/modalTerm\(([^)]+)\)/g) || [];
    console.log(`Type ${t} modalTerm calls:`, matches.slice(0, 10));

    // Also look for line names and route IDs in the HTML
    const lineCards = res.data.match(/class=["']linea-nom["'][^>]*>([^<]+)/g) || [];
    console.log(`Type ${t} line names:`, lineCards.slice(0, 10));
  }
})();
