const https = require('https');

function getUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { rejectUnauthorized: false, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function run() {
  console.log('Fetching detalle-linea?idBusLine=1 ...');
  const line1Html = await getUrl('https://mataro.avanzagrupo.com/detalle-linea?idBusLine=1');
  console.log('Line 1 HTML length:', line1Html.length);

  // Search for JSON, endpoints, ajax calls, or data attributes in Line 1 HTML
  const ajaxMatches = line1Html.match(/(\/o\/[^\s"']+|\/c\/[^\s"']+|p_p_id=[^\s"']+|url:\s*["'][^"']+["'])/g);
  console.log('Ajax/Liferay portlet URL matches:', ajaxMatches);

  // Look for stop names or coordinates
  const stopMatches = line1Html.match(/(?:parada|stop|lat|lng|coord|schedule|horari)[^<]{1,100}/gi);
  console.log('Stop/Coord samples:', (stopMatches || []).slice(0, 15));

  // Also let's inspect the map custom.js
  const mapJs = await getUrl('https://mataro.avanzagrupo.com/o/avanzatheme/js/custom.js');
  console.log('custom.js length:', mapJs.length);
  console.log('custom.js content snippet:\n', mapJs.substring(0, 2000));
}

run().catch(console.error);
