const fs = require('fs');

const fullSchedule = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_full_schedule.json', 'utf8'));
const stopsDir1 = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_matched_stops_dir1.json', 'utf8'));

// Inspect trip GEN_1811096 (12:45 -> 14:05) in dir1
const trip = fullSchedule.dir1.find(t => t.tripId === 'GEN_1811096');
console.log('Trip GEN_1811096 stops:');
trip.stops.forEach((s, idx) => {
  const matchedStop = stopsDir1.find(st => st.gtfsStopId === s.stopId) || {};
  console.log(`Seq ${s.seq} (Idx ${idx}): stopId="${s.stopId}", arr="${s.arr}", dep="${s.dep}" | Name: "${matchedStop.name}", MouTeId: "${matchedStop.mouteStopId}"`);
});
