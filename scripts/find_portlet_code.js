const fs = require('fs');
const https = require('https');

const html = fs.readFileSync('scripts/line1.html', 'utf8');

// Find all script blocks in line1.html that contain AdoLinea or linea or ajax
const scripts = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || [];
scripts.forEach((s, idx) => {
  if (s.includes('idBusLine') || s.includes('lista-paradas') || s.includes('AdoLinea') || s.includes('generar')) {
    console.log(`\n=== MATCH IN SCRIPT ${idx} ===\n`);
    console.log(s);
  }
});
