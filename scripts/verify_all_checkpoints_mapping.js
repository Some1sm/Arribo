const fs = require('fs');

const stopsDir1 = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_matched_stops_dir1.json', 'utf8'));
const stopsDir0 = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_matched_stops_dir0.json', 'utf8'));
const fullSchedule = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_full_schedule.json', 'utf8'));

console.log('=== DIRECTION 1 (to Mataró) Checkpoints Mapping ===');
const cpDir1 = [
  { id: '10008500', name: 'Barcelona - Metro la Pau', seq: 0 },
  { id: '10025777', name: 'Badalona - Pompeu Fabra', seq: 7 },
  { id: '10027798', name: 'Montgat - Estació Rodalies', seq: 12 },
  { id: '10038038', name: 'El Masnou - Estació', seq: 17 },
  { id: '10038471', name: 'Premià de Mar - Estació', seq: 21 },
  { id: '10037286', name: 'Vilassar de Mar - Estació', seq: 26 },
  { id: '10037205', name: 'Mataró - Porta Laietana', seq: 34 },
  { id: '10026784', name: 'Mataró - Pl. Granollers', seq: 37 },
  { id: '10037202', name: "Mataró - Pl. d'Itàlia (Target)", seq: 39 }
];

const sampleTrip1 = fullSchedule.dir1.find(t => t.tripId === 'GEN_1811096');
cpDir1.forEach(cp => {
  const matched = stopsDir1.find(s => s.mouteStopId === cp.id || s.seq === cp.seq);
  const schedEntry = sampleTrip1.stops.find(s => s.stopId === matched?.gtfsStopId || s.seq === cp.seq);
  console.log(`CP: ${cp.name} -> Matched GTFS: ${matched?.gtfsStopId} | Sched: ${schedEntry?.arr}`);
});

console.log('\n=== DIRECTION 0 (to Barcelona) Checkpoints Mapping ===');
const cpDir0 = [
  { id: '10037202', name: "Mataró - Pl. d'Itàlia (Target)", seq: 3 },
  { id: '10026784', name: 'Mataró - Pl. Granollers', seq: 5 },
  { id: '10037205', name: 'Mataró - Porta Laietana', seq: 8 },
  { id: '10037286', name: 'Vilassar de Mar - Estació', seq: 21 },
  { id: '10038471', name: 'Premià de Mar - Estació', seq: 21 },
  { id: '10038038', name: 'El Masnou - Estació', seq: 26 },
  { id: '10027798', name: 'Montgat - Estació Rodalies', seq: 32 },
  { id: '10025777', name: 'Badalona - Pompeu Fabra', seq: 37 },
  { id: '10008500', name: 'Barcelona - Metro la Pau', seq: 44 }
];

const sampleTrip0 = fullSchedule.dir0.find(t => t.serviceId === 'GEN_184749');
cpDir0.forEach(cp => {
  const matched = stopsDir0.find(s => s.mouteStopId === cp.id || s.seq === cp.seq);
  const schedEntry = sampleTrip0.stops.find(s => s.stopId === matched?.gtfsStopId || s.seq === cp.seq);
  console.log(`CP: ${cp.name} -> Matched GTFS: ${matched?.gtfsStopId} | Sched: ${schedEntry?.arr || schedEntry?.dep}`);
});
