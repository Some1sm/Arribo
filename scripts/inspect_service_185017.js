const fs = require('fs');

const calLines = fs.readFileSync('H:/Coding/C10Data/data/atm_gtfs/calendar.txt', 'utf8').split('\n');
console.log('calendar.txt entries for GEN_185017:');
calLines.filter(l => l.includes('GEN_185017')).forEach(l => console.log(l));

const dateLines = fs.readFileSync('H:/Coding/C10Data/data/atm_gtfs/calendar_dates.txt', 'utf8').split('\n');
console.log('\ncalendar_dates.txt entries for GEN_185017:');
dateLines.filter(l => l.includes('GEN_185017')).forEach(l => console.log(l));
