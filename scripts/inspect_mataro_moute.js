const https = require('https');
const crypto = require('crypto');

function getAuthHeader() {
  const ts = Date.now().toString();
  const raw = 'mouteapi' + ts.substring(0, 8);
  const hash = crypto.createHash('md5').update(raw).digest('hex');
  return `Token ${hash}`;
}

function fetchMouTe(endpoint) {
  return new Promise((resolve, reject) => {
    const url = `https://mou-te.gencat.cat/MouteAPI/rest/${endpoint}`;
    const options = {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0',
        'AT': getAuthHeader(),
        'Sec-Fetch-Site': 'same-site',
        'Sec-Fetch-Mode': 'cors',
        'Referer': 'https://mou-te.gencat.cat/'
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ raw: data.substring(0, 500) });
        }
      });
    }).on('error', reject);
  });
}

async function searchMataro() {
  console.log('Searching Mou-te for Mataro lines...');
  // 1. Search lines by municipality or name
  const res1 = await fetchMouTe('cercaLinies?nom=Matar%C3%B3');
  console.log('Nom=Mataró results:', JSON.stringify(res1, null, 2).substring(0, 1000));

  const res2 = await fetchMouTe('cercaLinies?nom=L1');
  console.log('Nom=L1 results:', JSON.stringify(res2, null, 2).substring(0, 1000));

  // Search by operator / agency (CTSA / Avanza)
  const res3 = await fetchMouTe('cercaLinies?nom=CTSA');
  console.log('Nom=CTSA results:', JSON.stringify(res3, null, 2).substring(0, 1000));

  // Search by municipality ID or text
  const res4 = await fetchMouTe('paradesProperes?lat=41.54&lon=2.44&radi=1500');
  console.log('Nearby stops in Mataro center:', JSON.stringify(res4, null, 2).substring(0, 1500));
}

searchMataro().catch(console.error);
