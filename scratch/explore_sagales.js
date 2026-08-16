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
  console.log('--- 1. Fetching Nocturnes lines list ---');
  const nocturnes = await get('https://www.sagales.com/linies/3/linies-nocturnes');
  const lineLinks = nocturnes.data.match(/href=["'](https:\/\/www\.sagales\.com\/linia\/[^"']+)["']/g) || [];
  console.log('Nocturne Line links:', lineLinks);

  console.log('\n--- 2. Fetching consultasAjax.js ---');
  const ajaxJs = await get('https://www.sagales.com/front/js/consultasAjax.js');
  console.log(ajaxJs.data.substring(0, 1500));

  console.log('\n--- 3. Fetching linia.js ---');
  const liniaJs = await get('https://www.sagales.com/front/js/linia.js');
  console.log(liniaJs.data.substring(0, 1500));

  console.log('\n--- 4. Fetching term-timePas.js ---');
  const timePasJs = await get('https://www.sagales.com/front/js/term-timePas.js');
  console.log(timePasJs.data.substring(0, 1500));
})();
