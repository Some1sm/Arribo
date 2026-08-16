const fs = require('fs');

const html = fs.readFileSync('scripts/line1.html', 'utf8');

const regex = /["']([^"']*(?:com\.ado|mx\.com\.ado|linea|routes|custom|portlet)[^"']*\.js[^"']*)["']/gi;
let m;
const scripts = new Set();
while ((m = regex.exec(html)) !== null) {
  scripts.add(m[1]);
}
console.log('Found scripts:\n', Array.from(scripts));
