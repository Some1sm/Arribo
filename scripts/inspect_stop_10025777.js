const fs = require('fs');

const stopsDir1 = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_matched_stops_dir1.json', 'utf8'));
const matches = stopsDir1.filter(s => s.mouteStopId === '10025777');
console.log('Matches for 10025777 in stopsDir1:', matches);
