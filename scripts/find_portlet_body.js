const fs = require('fs');

const html = fs.readFileSync('scripts/line1.html', 'utf8');

const idx = html.indexOf('adoLinea_routes_AdoLineaRoutesPortlet');
if (idx !== -1) {
  console.log('Found portlet at index:', idx);
  console.log(html.substring(idx - 200, idx + 4000));
} else {
  console.log('Not found');
}
