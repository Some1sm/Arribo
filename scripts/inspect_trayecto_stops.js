const fs = require('fs');

const allRoutes = JSON.parse(fs.readFileSync('data/mataro_routes_full.json', 'utf8'));

for (const [lineId, routes] of Object.entries(allRoutes)) {
  console.log(`\n================ LINE ${lineId} ================`);
  routes.forEach(r => {
    console.log(`Route ID: ${r.id}, Name: "${r.name}", LineId: ${r.id_linea}, Coords: ${r.coords?.length}, Paradas: ${r.paradas ? r.paradas.length : 'none'}, Keys: ${Object.keys(r)}`);
    if (r.paradas) {
      console.log('Sample paradas:', r.paradas.slice(0, 3));
    }
  });
}
