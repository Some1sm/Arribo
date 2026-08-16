const fs = require('fs');

const trips = fs.readFileSync('H:/Coding/C10Data/data/atm_gtfs/trips.txt', 'utf8').split('\n');
const c10Trips = trips.filter(t => t.includes('GEN_PF081210') || t.includes('02498'));
console.log('Sample C10 trips from trips.txt:');
const services = new Set();
trips.forEach(t => {
  if (t.startsWith('02498') || t.includes('02498')) {
    const parts = t.split(',');
    services.add(parts[1]);
  }
});
console.log('Services for 02498:', Array.from(services));

const calLines = fs.readFileSync('H:/Coding/C10Data/data/atm_gtfs/calendar.txt', 'utf8').split('\n');
console.log('\ncalendar.txt:');
calLines.filter(l => Array.from(services).some(s => l.startsWith(s))).forEach(l => console.log(l));

const dateLines = fs.readFileSync('H:/Coding/C10Data/data/atm_gtfs/calendar_dates.txt', 'utf8').split('\n');
console.log('\ncalendar_dates.txt:');
dateLines.filter(l => Array.from(services).some(s => l.startsWith(s))).forEach(l => console.log(l));
