const fs = require('fs');

async function main() {
  const sRes = await fetch('https://mou-te.gencat.cat/main-es2015.fd7cb803cd3488e24dd9.js');
  const sText = await sRes.text();

  // Look for all occurrences of `.get(` and `.post(`
  const regex = /this\.http\.(get|post|put)\(([^)]+)\)/g;
  let match;
  const calls = new Set();
  while ((match = regex.exec(sText)) !== null) {
    calls.add(`${match[1].toUpperCase()}: ${match[2]}`);
  }
  console.log('HTTP calls in Mou-te:');
  for (const c of calls) {
    console.log(c);
  }
}

main().catch(console.error);
