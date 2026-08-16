const crypto = require('crypto');

function getAuthHeader() {
  const timestamp = Date.now().toString();
  const substr = timestamp.substring(0, 7);
  const hash = crypto.createHash('md5').update('mouteapi' + substr).digest('hex');
  return hash;
}

async function queryMouTe(endpoint) {
  const at = getAuthHeader();
  const url = `https://mou-te.gencat.cat/MouteAPI/rest/${endpoint}`;
  console.log(`\n[GET] ${url}`);

  const res = await fetch(url, {
    headers: {
      'AT': at,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*'
    }
  });
  console.log(`Status: ${res.status}, Type: ${res.headers.get('content-type')}`);
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    console.log('JSON:', JSON.stringify(json, null, 2));
    return json;
  } catch (e) {
    console.log('Raw text:', text.substring(0, 500));
    return null;
  }
}

async function main() {
  // Test stop 10037202 (pl. Itàlia A)
  console.log('=== Stop 10037202 (pl. Itàlia A) Next Departures ===');
  await queryMouTe('infrastructure/nextdeparturesNEW?paradaId=10037202&useRealTime=true&language=ca_ES');
  await queryMouTe('infrastructure/stop/linesNEW?paradaId=10037202&language=ca_ES');
  await queryMouTe('infrastructure/nextdepartures?paradaId=10037202&language=ca_ES&useRealTime=true');
}

main().catch(console.error);
