const fs = require('fs');

const trips = fs.readFileSync('data/atm_gtfs/trips.txt', 'utf8').split('\n').filter(Boolean);
const n80Trips = trips.filter(t => t.startsWith('GEN_42671,') && t.includes(',GEN_0109,'));
console.log('N80 trips count:', n80Trips.length);
console.log('Sample N80 trips:', n80Trips.slice(0, 3));

const n81Trips = trips.filter(t => t.startsWith('GEN_42671,') && t.includes(',GEN_0147,'));
console.log('\nN81 trips count:', n81Trips.length);

const e111Trips = trips.filter(t => t.startsWith('GEN_42671,') && t.includes(',GEN_0496,'));
console.log('\nE11.1 trips count:', e111Trips.length);

const e112Trips = trips.filter(t => t.startsWith('GEN_42671,') && t.includes(',GEN_0497,'));
console.log('\nE11.2 trips count:', e112Trips.length);
