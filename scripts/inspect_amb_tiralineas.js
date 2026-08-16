const https = require('https');

function fetchHtml(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', (e) => resolve({ error: e.message }));
  });
}

async function main() {
  console.log('Testing AMB Mobilitat TiraLineas...');
  const res = await fetchHtml('https://www.ambmobilitat.cat/Principales/TiraLineas.aspx?linea=C10');
  console.log('Status:', res.status, 'Length:', res.data?.length);
  if (res.data) {
    const scripts = res.data.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
    console.log('Found scripts:', scripts.length);
    scripts.forEach((s, idx) => {
      if (s.includes('api') || s.includes('json') || s.includes('http') || s.includes('ajax')) {
        console.log(`\nScript ${idx}:`, s.substring(0, 300));
      }
    });
  }
}

main().catch(console.error);
