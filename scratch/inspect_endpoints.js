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
  const mapaLinia = await get('https://www.sagales.com/front/js/mapa-linia.js');
  console.log('--- mapa-linia.js middle ---');
  console.log(mapaLinia.data.substring(2000, 4500));

  const timePas = await get('https://www.sagales.com/front/js/term-timePas.js');
  console.log('--- term-timePas.js middle ---');
  console.log(timePas.data.substring(1000, 3500));
})();
