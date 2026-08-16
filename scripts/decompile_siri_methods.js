const fs = require('fs');

const dex = fs.readFileSync('scripts/apk_extracted/classes.dex').toString('latin1');

function findMethodStrings(name) {
  let idx = 0;
  console.log(`\n================ SEARCH: ${name} ================`);
  while ((idx = dex.indexOf(name, idx)) !== -1) {
    console.log(`Offset ${idx}:`);
    const slice = dex.substring(Math.max(0, idx - 300), Math.min(dex.length, idx + 700));
    console.log(slice.replace(/[^\x20-\x7E\n]/g, ' '));
    idx += name.length;
  }
}

findMethodStrings('GetStopMonitoring');
findMethodStrings('GetVehicleMonitoring');
findMethodStrings('StopPointsDiscovery');
