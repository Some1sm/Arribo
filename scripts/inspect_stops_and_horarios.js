const fs = require('fs');

const allRoutes = JSON.parse(fs.readFileSync('data/mataro_routes_full.json', 'utf8'));

for (const [lineId, routes] of Object.entries(allRoutes)) {
  console.log(`\n================ LINE ${lineId} ================`);
  routes.forEach(r => {
    console.log(`Route ${r.id} ("${r.name}"):`);
    console.log('  Stops count:', r.stops ? r.stops.length : 0);
    console.log('  Horario keys:', r.horario ? Object.keys(r.horario) : 'none');
    if (r.stops && r.stops.length > 0) {
      console.log('  First 3 stops:', JSON.stringify(r.stops.slice(0, 3), null, 2));
    }
  });
}
