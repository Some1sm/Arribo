const fs = require('fs');
const path = require('path');

const dexFiles = ['scripts/apk_extracted/classes.dex', 'scripts/apk_extracted/classes2.dex', 'scripts/apk_extracted/classes3.dex'];

for (const df of dexFiles) {
  if (!fs.existsSync(df)) continue;
  const buf = fs.readFileSync(df);
  const text = buf.toString('latin1');
  console.log(`\n===================================`);
  console.log(`DEX FILE: ${df} (Size: ${buf.length})`);

  // Search for locactio, geoactio, api, user, pass
  const regex = /(https?:\/\/[a-zA-Z0-9_\-\.\:\/]+)/g;
  const urls = text.match(regex) || [];
  console.log('HTTP URLs:', Array.from(new Set(urls)));

  // Search for user/pass strings
  const creds = text.match(/[a-zA-Z0-9_\-\.]{3,30}:[a-zA-Z0-9_\-\.]{3,30}/g) || [];
  console.log('Potential credentials (user:pass):', Array.from(new Set(creds)).slice(0, 30));

  // Find strings around locactio
  let pos = 0;
  while ((pos = text.indexOf('locactio', pos)) !== -1) {
    console.log(`\nContext around locactio at ${pos}:`);
    console.log(text.substring(Math.max(0, pos - 150), Math.min(text.length, pos + 250)).replace(/[^\x20-\x7E\n]/g, ' '));
    pos += 8;
  }

  // Find strings around matarobus
  pos = 0;
  while ((pos = text.indexOf('matarobus.geoactio', pos)) !== -1) {
    console.log(`\nContext around matarobus.geoactio at ${pos}:`);
    console.log(text.substring(Math.max(0, pos - 150), Math.min(text.length, pos + 250)).replace(/[^\x20-\x7E\n]/g, ' '));
    pos += 18;
  }
}
