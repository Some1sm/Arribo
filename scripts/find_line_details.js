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
  const html = await getUrl('https://mataro.avanzagrupo.com/detalle-linea?idBusLine=1');
  fs.writeFileSync('scripts/line1.html', html);
  console.log('Saved line1.html');

  // Find all <div or elements with line data
  const matches = html.match(/<[^>]+(?:linea|parada|stop|coord|geojson|horario|data-)[^>]*>/gi);
  console.log('Data elements count:', matches ? matches.length : 0);
  if (matches) {
    console.log('Sample elements:\n', matches.slice(0, 25).join('\n'));
  }
}

run().catch(console.error);
