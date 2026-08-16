const fs = require('fs');

async function main() {
  const sRes = await fetch('https://mou-te.gencat.cat/main-es2015.fd7cb803cd3488e24dd9.js');
  const sText = await sRes.text();

  // Find buildHttpOptions
  let idx = 0;
  while ((idx = sText.indexOf('buildHttpOptions', idx)) !== -1) {
    console.log('--- buildHttpOptions around', idx, '---');
    console.log(sText.slice(Math.max(0, idx - 200), Math.min(sText.length, idx + 400)));
    idx += 16;
  }

  // Find all occurrences of BASE_URL or MouteAPI
  idx = 0;
  while ((idx = sText.indexOf('MouteAPI', idx)) !== -1) {
    console.log('--- MouteAPI around', idx, '---');
    console.log(sText.slice(Math.max(0, idx - 100), Math.min(sText.length, idx + 300)));
    idx += 8;
  }

  // Search for how stop ID or line ID is formatted (maybe without GEN_ or with specific prefix?)
  idx = 0;
  while ((idx = sText.indexOf('nextdepartures', idx)) !== -1) {
    console.log('--- nextdepartures around', idx, '---');
    console.log(sText.slice(Math.max(0, idx - 150), Math.min(sText.length, idx + 350)));
    idx += 14;
  }
}

main().catch(console.error);
