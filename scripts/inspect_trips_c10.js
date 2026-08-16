const fs = require('fs');
const path = require('path');

const tripsHead = fs.readFileSync(path.join(__dirname, '..', 'data', 'atm_gtfs', 'trips.txt'), 'utf8').split('\n').slice(0, 10);
console.log('Trips Header:', tripsHead[0]);
console.log('Trips Sample 1:', tripsHead[1]);

// Search for GEN_42671
const allTrips = fs.readFileSync(path.join(__dirname, '..', 'data', 'atm_gtfs', 'trips.txt'), 'utf8').split('\n');
const match = allTrips.filter(l => l.includes('GEN_42671')).slice(0, 5);
console.log('Matching trips for GEN_42671:', match);
