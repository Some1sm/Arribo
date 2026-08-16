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
  // Let's test termometre for N82 candidates: 'N82', 'n82', '115', 'GEN_0115', '82'
  const candidates = ['N82', 'n82', 'GEN_0115', '0115', '115', '82', '315', '603', '614'];
  for (const c of candidates) {
    try {
      const res = await get(`https://www.sagales.com/termometre/${c}/0`);
      console.log(`termometre/${c}/0 -> Status: ${res.status}, Length: ${res.data.length}`);
      if (res.status === 200 && !res.data.includes('404') && res.data.length > 500) {
        console.log(`>>> MATCH for ${c}! First 200 chars:`, res.data.substring(0, 200));
      }
    } catch(e) {
      console.error(e.message);
    }
  }
})();
