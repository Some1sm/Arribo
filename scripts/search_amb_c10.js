const fs = require('fs');

const routes = fs.readFileSync('C:/Users/ceper/.gemini/antigravity/brain/646bbb25-2441-4428-8c81-ef161d0f8e1d/scratch/amb_gtfs/routes.txt', 'utf8');
console.log('AMB Routes matching C10/02498:');
routes.split('\n').filter(l => l.includes('C10') || l.includes('C-10') || l.includes('02498') || l.toLowerCase().includes('matar')).forEach(l => console.log(l));

const trips = fs.readFileSync('C:/Users/ceper/.gemini/antigravity/brain/646bbb25-2441-4428-8c81-ef161d0f8e1d/scratch/amb_gtfs/trips.txt', 'utf8');
const c10Trips = trips.split('\n').filter(l => l.includes('C10') || l.includes('02498'));
console.log(`\nAMB C10 Trips found: ${c10Trips.length}`);
if (c10Trips.length > 0) {
  console.log(c10Trips.slice(0, 5).join('\n'));
}
