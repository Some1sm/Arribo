const fs = require('fs');

const fullSchedule = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_full_schedule.json', 'utf8'));

console.log('Badalona (cp id 10025777, seq 7):');
fullSchedule.dir1.forEach(t => {
  if (t.serviceId === 'GEN_184749' || t.serviceId === 'GEN_185017') {
    const s = t.stops.find(st => st.seq === 7 || st.stopId === 'GEN_PF08015093');
    console.log(`Trip ${t.tripId} (${t.serviceId}, BCN ${t.stops[0].dep}): seq=${s?.seq}, stopId=${s?.stopId}, dep=${s?.dep}`);
  }
});
