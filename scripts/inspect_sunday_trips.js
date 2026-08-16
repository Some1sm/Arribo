const fs = require('fs');

const fullSchedule = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_full_schedule.json', 'utf8'));

console.log('Dir 1 Trips:');
fullSchedule.dir1.forEach(t => {
  console.log(`- Trip ${t.tripId} (service: ${t.serviceId}): Departs ${t.stops[0].dep}, Arrives ${t.stops[t.stops.length-1].arr}`);
  const s0 = t.stops[0]; // Barcelona
  const s1 = t.stops.find(s => s.seq === 7); // Pompeu Fabra (seq 7)
  const s2 = t.stops.find(s => s.seq === 12); // Montgat (seq 12)
  const s3 = t.stops.find(s => s.seq === 17); // El Masnou (seq 17)
  const s4 = t.stops.find(s => s.seq === 21); // Premia (seq 21)
  console.log(`   BCN: ${s0?.dep}, Pompeu: ${s1?.dep}, Montgat: ${s2?.dep}, Masnou: ${s3?.dep}, Premia: ${s4?.dep}`);
});
