const fs = require('fs');

async function main() {
  const sRes = await fetch('https://mou-te.gencat.cat/main-es2015.fd7cb803cd3488e24dd9.js');
  const sText = await sRes.text();
  
  // Search for environment / api / ws / url / backend strings
  const regex = /"(https?:\/\/[^"]+|ws\/[^"]+|\/api\/[^"]+|\/ws\/[^"]+)"/g;
  let match;
  const found = new Set();
  while ((match = regex.exec(sText)) !== null) {
    const val = match[1];
    if (!val.includes('w3.org') && !val.includes('schema') && !val.includes('google') && !val.includes('openlayers') && !val.includes('stamen')) {
      found.add(val);
    }
  }
  console.log('API strings found:');
  console.log([...found]);

  // Search for keywords like "realtime", "nextBus", "passage", "estimat", "propers", "vehicle"
  const kws = ['realtime', 'real_time', 'temps_real', 'siri', 'gtfs-rt', 'estimate', 'propers', 'linia', 'c-10', 'c10', 'gencat'];
  for (const kw of kws) {
    let idx = 0;
    let count = 0;
    while ((idx = sText.toLowerCase().indexOf(kw, idx)) !== -1 && count < 3) {
      console.log(`\nMatch for "${kw}":`);
      console.log(sText.slice(Math.max(0, idx - 100), Math.min(sText.length, idx + 200)));
      idx += kw.length;
      count++;
    }
  }
}

main().catch(console.error);
