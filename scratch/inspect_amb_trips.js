const fs = require('fs');

const trips = fs.readFileSync('data/amb_gtfs/trips.txt', 'utf8').split('\n').filter(Boolean);
console.log('Total trips:', trips.length);
console.log('Sample trip header & row:', trips.slice(0, 3));

const stopTimes = fs.readFileSync('data/amb_gtfs/stop_times.txt', 'utf8').split('\n').filter(Boolean);
console.log('Total stop times:', stopTimes.length);
console.log('Sample stop time header & row:', stopTimes.slice(0, 3));
