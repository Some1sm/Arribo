const fs = require('fs');

const dex = fs.readFileSync('scripts/apk_extracted/classes.dex').toString('latin1');

function dumpAround(keyword, radius = 500) {
  let pos = 0;
  console.log(`\n================== DUMP FOR: ${keyword} ==================`);
  while ((pos = dex.indexOf(keyword, pos)) !== -1) {
    console.log(`\nMatch at offset ${pos}:`);
    const slice = dex.substring(Math.max(0, pos - radius), Math.min(dex.length, pos + radius));
    console.log(slice.replace(/[^\x20-\x7E\n]/g, ' '));
    pos += keyword.length;
  }
}

dumpAround('sirimataro');
dumpAround('matarobus.geoactio.com/index.php/api/');
dumpAround('AccountId');
dumpAround('AccountKey');
