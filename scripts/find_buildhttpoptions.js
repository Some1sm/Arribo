const fs = require('fs');

async function main() {
  const sRes = await fetch('https://mou-te.gencat.cat/main-es2015.fd7cb803cd3488e24dd9.js');
  const sText = await sRes.text();

  let idx = sText.indexOf('buildHttpOptions(');
  if (idx !== -1) {
    console.log('buildHttpOptions definition:');
    console.log(sText.slice(idx, idx + 400));
  } else {
    console.log('buildHttpOptions( not found as function, searching for buildHttpOptions');
    idx = sText.indexOf('buildHttpOptions');
    while (idx !== -1) {
      console.log('--- match at', idx, '---');
      console.log(sText.slice(Math.max(0, idx - 50), idx + 200));
      idx = sText.indexOf('buildHttpOptions', idx + 16);
    }
  }
}

main().catch(console.error);
