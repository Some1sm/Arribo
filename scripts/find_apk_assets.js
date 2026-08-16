const fs = require('fs');
const path = require('path');

function walk(dir) {
  let list = [];
  fs.readdirSync(dir).forEach(f => {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) list = list.concat(walk(full));
    else list.push(full);
  });
  return list;
}

const files = walk('scripts/apk_extracted');
console.log('Total files in APK:', files.length);

files.forEach(f => {
  if (f.endsWith('.db') || f.endsWith('.sqlite') || f.endsWith('.json') || f.endsWith('.txt') || f.includes('asset')) {
    console.log(`Found data file: ${f} (${fs.statSync(f).size} bytes)`);
  }
});
