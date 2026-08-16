const fs = require('fs');
const path = require('path');

async function testEndpoints() {
  const urls = [
    // Web services
    'https://www.ambmobilitat.cat/Principales/TiemposEspera.aspx',
    'https://www.ambmobilitat.cat/Principales/BuscarLineas.aspx',
    'https://www.ambmobilitat.cat/Principales/Mapa.aspx',
    'https://www.ambmobilitat.cat/Services/LineasService.asmx',
    'https://www.ambmobilitat.cat/Services/TiemposEspera.asmx',
    'https://www.ambmobilitat.cat/Services/ParadasService.asmx',
    
    // API endpoints
    'https://api.ambmobilitat.cat/v1/lines',
    'https://api.ambmobilitat.cat/v2/lines',
    'https://api.ambmobilitat.cat/v1/vehicles',
    'https://api.ambmobilitat.cat/v2/vehicles',
    'https://api.ambmobilitat.cat/v1/stops',
    'https://api.ambmobilitat.cat/v2/stops',
    'https://api.ambmobilitat.cat/v1/swagger-ui.html',
    'https://api.ambmobilitat.cat/v2/swagger-ui.html',
    'https://api.ambmobilitat.cat/v1/api-docs',
    'https://api.ambmobilitat.cat/v2/api-docs',
    'https://api.ambmobilitat.cat/v3/api-docs',

    // App endpoints
    'https://app.ambmobilitat.cat/lines/busamb:130',
    'https://app.ambmobilitat.cat/api/lines',
    'https://serveis.ambmobilitat.cat/api/lines',
    'https://serveis.ambmobilitat.cat/api/v1/lines'
  ];

  for (const u of urls) {
    try {
      const res = await fetch(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*'
        }
      });
      console.log(`[${res.status}] ${u} (${res.headers.get('content-type')}, len: ${res.headers.get('content-length')})`);
      if (res.status === 200) {
        const text = await res.text();
        console.log(`   Sample text:`, text.substring(0, 200).replace(/\s+/g, ' '));
      }
    } catch (e) {
      console.log(`[ERR] ${u}: ${e.message}`);
    }
  }
}

testEndpoints();
