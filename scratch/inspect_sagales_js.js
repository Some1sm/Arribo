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
  console.log('--- term-timePas.js ---');
  const timePas = await get('https://www.sagales.com/front/js/term-timePas.js');
  console.log(timePas.data);

  console.log('--- mapa-linia.js ---');
  const mapaLinia = await get('https://www.sagales.com/front/js/mapa-linia.js');
  console.log(mapaLinia.data);
})();
