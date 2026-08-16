const fs = require('fs');

const dex = fs.readFileSync('scripts/apk_extracted/classes.dex').toString('latin1');

let pos = 0;
while ((pos = dex.indexOf('USERWSMATARO', pos)) !== -1) {
  console.log(`\nMatch at offset ${pos}:`);
  const slice = dex.substring(Math.max(0, pos - 400), Math.min(dex.length, pos + 600));
  console.log(slice.replace(/[^\x20-\x7E\n]/g, ' '));
  pos += 12;
}
