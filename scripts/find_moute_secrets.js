const fs = require('fs');

async function main() {
  const sRes = await fetch('https://mou-te.gencat.cat/main-es2015.fd7cb803cd3488e24dd9.js');
  const sText = await sRes.text();

  // Search for TKNW or USET or TKN
  const keywords = ['TKNW', 'USET', 'TKN:'];
  for (const kw of keywords) {
    let idx = 0;
    while ((idx = sText.indexOf(kw, idx)) !== -1) {
      console.log(`\nMatch for "${kw}" at ${idx}:`);
      console.log(sText.slice(Math.max(0, idx - 100), Math.min(sText.length, idx + 200)));
      idx += kw.length;
    }
  }
}

main().catch(console.error);
