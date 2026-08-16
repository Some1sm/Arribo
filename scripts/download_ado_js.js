const https = require('https');

function getUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    }).on('error', reject);
  });
}

async function run() {
  const urls = [
    'https://mataro.avanzagrupo.com/o/com.ado.portlet.linea.routes/js/main.js',
    'https://mataro.avanzagrupo.com/o/com.ado.portlet.linea.routes/js/custom.js',
    'https://mataro.avanzagrupo.com/o/com.ado.buscador/js/custom.js',
    'https://mataro.avanzagrupo.com/o/mx.com.ado.line.selector/js/main.js',
    'https://mataro.avanzagrupo.com/o/com.ado.portlet.mapa/js/custom.js',
    'https://mataro.avanzagrupo.com/o/com.ado.portlet.avisos/js/custom.js'
  ];

  for (const url of urls) {
    const res = await getUrl(url);
    console.log(`URL: ${url} -> Status: ${res.status}, Length: ${res.data.length}`);
    if (res.status === 200) {
      console.log('Snippet:\n', res.data.substring(0, 500));
      // Search for URLs or ajax
      const apis = res.data.match(/["'](\/[^"']*(?:api|json|rest|data|linea|parada|bus)[^"']*)["']/gi);
      if (apis) console.log('Potential API endpoints:', apis);
    }
  }
}

run().catch(console.error);
