const https = require('https');
const fs = require('fs');

function getUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function run() {
  console.log('Fetching todas-las-lineas...');
  const html = await getUrl('https://mataro.avanzagrupo.com/lineas-y-horarios/todas-las-lineas');
  fs.writeFileSync('scripts/todas_lineas.html', html);
  console.log('Saved todas_lineas.html, length:', html.length);

  // Extract all lines
  const lines = html.match(/<a[^>]+href=["'][^"']*detalle-linea[^"']*["'][^>]*>[\s\S]*?<\/a>/gi);
  console.log('Line links count:', lines ? lines.length : 0);
  if (lines) {
    console.log('Lines found:\n', lines.join('\n\n'));
  }
}

run().catch(console.error);
