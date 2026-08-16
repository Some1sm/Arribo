const fs = require('fs');

function timeToSec(timeStr) {
  const [h, m, s] = timeStr.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

const fullSchedule = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_full_schedule.json', 'utf8'));
const trip = fullSchedule.dir1.find(t => t.tripId === 'GEN_1811096');

// Test at 13:28:49 (current time)
const currentSec = 13 * 3600 + 28 * 60 + 49;
console.log('Testing segment matching at 13:28:49 (currentSec =', currentSec, ')');

for (let i = 0; i < trip.stops.length - 1; i++) {
  const s1 = trip.stops[i];
  const s2 = trip.stops[i + 1];
  const t1 = timeToSec(s1.dep);
  const t2 = timeToSec(s2.arr);
  const oldMatch = currentSec >= t1 && currentSec <= t2 + 300;
  const newMatch = currentSec >= t1 && currentSec < t2;
  console.log(`Seg ${i} (${s1.seq} -> ${s2.seq}, ${s1.dep.substring(0,5)} -> ${s2.arr.substring(0,5)}, t1=${t1}, t2=${t2}): oldMatch=${oldMatch}, newMatch=${newMatch}`);
}
