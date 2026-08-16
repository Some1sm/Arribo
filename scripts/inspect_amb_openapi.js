const https = require('https');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('Fetching AMB Mobilitat OpenAPI Docs...');
  const docs = await fetchJson('https://api.ambmobilitat.cat/v2/v2/api-docs');
  
  if (docs.paths) {
    console.log('\nFound Paths in AMB Mobilitat API:');
    Object.keys(docs.paths).forEach(p => {
      const methods = Object.keys(docs.paths[p]).join(', ').toUpperCase();
      console.log(`- [${methods}] ${p}`);
    });
  } else {
    console.log('Docs response:', docs);
  }
}

main().catch(console.error);
