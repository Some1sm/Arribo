const https = require('https');

async function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch(e) {
          resolve({ status: res.statusCode, raw: data.substring(0, 500) });
        }
      });
    }).on('error', reject);
  });
}

(async () => {
  console.log('Testing Sagales real-time-bus endpoint for line 680 (N82)...');
  const res0 = await get('https://www.sagales.com/real-time-bus/680/0');
  console.log('\n=== Direction 0 ===');
  console.log('Status:', res0.status);
  if (res0.json) {
    console.log('Line:', res0.json.linia);
    console.log('Direction travel:', res0.json.directionTravel);
    console.log('Stops count:', res0.json.ruta?.stops?.length);
    console.log('Shapes length:', res0.json.ruta?.shapes?.length);
    console.log('Active bus entities:', JSON.stringify(res0.json.bus, null, 2));
    if (res0.json.ruta?.stops?.length > 0) {
      console.log('First 3 stops:', res0.json.ruta.stops.slice(0, 3));
      console.log('Last 2 stops:', res0.json.ruta.stops.slice(-2));
    }
  } else {
    console.log('Raw:', res0.raw);
  }

  const res1 = await get('https://www.sagales.com/real-time-bus/680/1');
  console.log('\n=== Direction 1 ===');
  console.log('Status:', res1.status);
  if (res1.json) {
    console.log('Line:', res1.json.linia);
    console.log('Direction travel:', res1.json.directionTravel);
    console.log('Stops count:', res1.json.ruta?.stops?.length);
    console.log('Active bus entities:', JSON.stringify(res1.json.bus, null, 2));
  } else {
    console.log('Raw:', res1.raw);
  }
})();
