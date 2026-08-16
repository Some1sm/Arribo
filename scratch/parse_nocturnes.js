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
  const blocks = res.data.split(/class=["']linea-descripcio["']/);
  console.log(`Found ${blocks.length - 1} line blocks in Type 3 (Nocturnes):`);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const nameMatch = block.match(/<h3>([^<]+)<\/h3>/) || block.match(/class=["']title[^"']*["']>([^<]+)/);
    const codeMatch = block.match(/class=["']numero-linia["'][^>]*>([^<]+)/) || block.match(/class=["']lineaBus[^"']*["'][^>]*>([^<]+)/);
    const modalMatch = block.match(/modalTerm\((\d+)\)/);
    console.log(`- Line Code: ${codeMatch ? codeMatch[1].trim() : 'N/A'}, RouteId: ${modalMatch ? modalMatch[1] : 'N/A'}, Title: ${nameMatch ? nameMatch[1].trim() : 'N/A'}`);
  }
})();
