const fs = require('fs');

const agencies = {};
fs.readFileSync('data/amb_gtfs/agency.txt', 'utf8').split('\n').slice(1).filter(Boolean).forEach(l => {
  const [id, name] = l.split(',');
  if (id && name) agencies[id.trim()] = name.trim();
});

const routes = fs.readFileSync('data/amb_gtfs/routes.txt', 'utf8').split('\n').slice(1).filter(Boolean).map(l => {
  const parts = l.split(',');
  return {
    id: parts[0]?.trim(),
    agencyId: parts[1]?.trim(),
    agencyName: agencies[parts[1]?.trim()] || 'AMB',
    code: parts[2]?.trim(),
    name: parts[3]?.trim(),
    color: parts[7]?.trim() ? `#${parts[7].trim()}` : '#009485',
    textColor: parts[8]?.trim() ? `#${parts[8].trim()}` : '#ffffff'
  };
});

console.log(`Loaded ${routes.length} AMB routes across agencies:`);
const byAg = {};
routes.forEach(r => {
  byAg[r.agencyName] = byAg[r.agencyName] || [];
  byAg[r.agencyName].push(r.code);
});

for (const [ag, codes] of Object.entries(byAg)) {
  console.log(`\n=== ${ag} (${codes.length} lines) ===`);
  console.log(codes.join(', '));
}
