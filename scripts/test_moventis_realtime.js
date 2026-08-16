const fs = require('fs');

async function testMoventis() {
  const urls = [
    // Moventis Casas / C10 URLs
    'https://www.moventis.es/es/lineas-y-horarios/linea-c-10-mataro-barcelona-por-n-ii',
    'https://www.moventis.es/ca/linies-i-horaris/c-10-mataro-barcelona-per-n-ii',
    'https://www.moventis.es/api/line/C10',
    'https://www.moventis.es/api/lines',
    'https://app.moventis.es/api/v1/lines',
    'https://app.moventis.es/api/v1/stops/121',
    'https://api.moventis.es/v1/lines/C10',
    'https://api.moventis.es/v1/stops/121',
    'https://www.quantriga.com/ajax/getTimes.php?stop=121',
    'https://www.quantriga.com/api/stop/121',
    // Gencat mou-te
    'https://mou-te.gencat.cat/api/v1/stops/GEN_PF08121075',
    'https://mou-te.gencat.cat/api/v1/lines/GEN_0498',
    'https://mou-te.gencat.cat/ws/gtfs/stops/GEN_PF08121075'
  ];

  for (const u of urls) {
    try {
      const res = await fetch(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      console.log(`[${res.status}] ${u} (${res.headers.get('content-type')}, len: ${res.headers.get('content-length')})`);
      if (res.status === 200) {
        const t = await res.text();
        console.log('   Preview:', t.substring(0, 300).replace(/\s+/g, ' '));
      }
    } catch (e) {
      console.log(`[ERR] ${u}: ${e.message}`);
    }
  }
}

testMoventis();
