const fs = require('fs');

const html = fs.readFileSync('scripts/line1.html', 'utf8');

const idx = html.indexOf('genAutocomplete');
if (idx !== -1) {
  console.log('Found genAutocomplete at index:', idx);
  console.log(html.substring(idx - 200, idx + 4000));
} else {
  console.log('genAutocomplete not found in line1.html');
}
