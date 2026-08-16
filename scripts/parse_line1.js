const fs = require('fs');

const html = fs.readFileSync('scripts/line1.html', 'utf8');

// Search for portlets
const portletMatches = html.match(/adoLinea_routes[^\n]+/gi);
console.log('adoLinea_routes matches:', portletMatches ? portletMatches.length : 0);

// Search for any script tags inside body
const inlineScripts = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi);
console.log('Inline script tags count:', inlineScripts ? inlineScripts.length : 0);
if (inlineScripts) {
  inlineScripts.forEach((sc, i) => {
    if (sc.includes('map') || sc.includes('parada') || sc.includes('linea') || sc.includes('lat') || sc.includes('http') || sc.includes('function') || sc.includes('ajax')) {
      console.log(`\n--- Script #${i} snippet ---`);
      console.log(sc.substring(0, 500));
    }
  });
}

// Search for stop names or text
const stopDivs = html.match(/<div[^>]+class=["'][^"']*(?:parada|stop|line|ruta|sentit|direction|horari)[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi);
console.log('\nStop divs count:', stopDivs ? stopDivs.length : 0);
if (stopDivs) {
  console.log('Sample stop divs:\n', stopDivs.slice(0, 10).join('\n'));
}
