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
  console.log(`AT Header: ${at}`);

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
    console.log('JSON (preview):', JSON.stringify(json, null, 2).substring(0, 3000));
    return json;
  } catch (e) {
    console.log('Text:', text.substring(0, 1000));
    return null;
  }
}

async function main() {
  // Test target stop Pl. Italia Mataro: GEN_PF08121075 (Direction to Mataró) and GEN_PF08121041 (Direction to Barcelona)
  console.log('=== 1. Target stop departures (GEN_PF08121075) ===');
  await queryMouTe('infrastructure/nextdeparturesNEW?paradaId=GEN_PF08121075&useRealTime=true&language=ca_ES');

  console.log('=== 2. Target stop departures (GEN_PF08121041) ===');
  await queryMouTe('infrastructure/nextdeparturesNEW?paradaId=GEN_PF08121041&useRealTime=true&language=ca_ES');

  console.log('=== 3. C10 Line itineraries (GEN_0498) ===');
  await queryMouTe('infrastructure/line/itineraries?liniaId=GEN_0498');

  console.log('=== 4. Test intermediate stops (e.g., Premià, Vilassar, Montgat) ===');
  await queryMouTe('infrastructure/nextdeparturesNEW?paradaId=GEN_PF08172022&useRealTime=true&language=ca_ES'); // Premià
  await queryMouTe('infrastructure/nextdeparturesNEW?paradaId=GEN_PF08219011&useRealTime=true&language=ca_ES'); // Vilassar
  await queryMouTe('infrastructure/nextdeparturesNEW?paradaId=GEN_PF08126015&useRealTime=true&language=ca_ES'); // Montgat
}

main().catch(console.error);
