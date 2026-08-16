const https = require('https');

function fetchUrl(path) {
  return new Promise((resolve) => {
    const url = `https://api.ambmobilitat.cat/v2${path}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data.substring(0, 500) });
        }
      });
    }).on('error', (e) => resolve({ error: e.message }));
  });
}

async function main() {
  console.log('--- Testing /bus/vehicles ---');
  const vehRes = await fetchUrl('/bus/vehicles');
  console.log('Status /bus/vehicles:', vehRes.status);
  if (vehRes.data) {
    console.log('Vehicles sample:', JSON.stringify(vehRes.data).substring(0, 800));
  } else {
    console.log('Raw:', vehRes.raw);
  }

  console.log('\n--- Testing /bus/lines with C10 ---');
  const linesRes = await fetchUrl('/bus/lines/search/byDescription?description=C10');
  console.log('Lines search status:', linesRes.status);
  console.log('Lines search result:', JSON.stringify(linesRes.data, null, 2));
}

main().catch(console.error);
