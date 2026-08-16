const fs = require('fs');

const fullSchedule = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_full_schedule.json', 'utf8'));

console.log('--- DIR 1 (BCN -> Mataro) ---');
fullSchedule.dir1.filter(t => t.serviceId === 'GEN_184749' || t.serviceId === 'GEN_185017').forEach(t => {
  console.log(`Trip ${t.tripId}: BCN ${t.stops[0].dep} -> Mataro ${t.stops[t.stops.length-1].arr}`);
});

console.log('\n--- DIR 0 (Mataro -> BCN) ---');
fullSchedule.dir0.filter(t => t.serviceId === 'GEN_184749' || t.serviceId === 'GEN_185017').forEach(t => {
  console.log(`Trip ${t.tripId}: Mataro ${t.stops[0].dep} -> BCN ${t.stops[t.stops.length-1].arr}`);
});
