const fs = require('fs');

const stops = {};
fs.readFileSync('data/atm_gtfs/stops.txt', 'utf8').split('\n').slice(1).filter(Boolean).forEach(l => {
  const parts = l.split(',');
  stops[parts[0]] = {
    id: parts[0],
    code: parts[1] || parts[0],
    name: parts[2]?.replace(/"/g, ''),
    lat: parseFloat(parts[4]),
    lon: parseFloat(parts[5])
  };
});

const stopTimes = fs.readFileSync('data/atm_gtfs/stop_times.txt', 'utf8').split('\n').slice(1).filter(Boolean);

function getRouteStops(tripId) {
  const st = stopTimes.filter(s => s.startsWith(tripId + ',')).map(s => {
    const p = s.split(',');
    return {
      tripId: p[0],
      arr: p[1],
      dep: p[2],
      stopId: p[3],
      seq: parseInt(p[4], 10),
      stop: stops[p[3]]
    };
  }).sort((a, b) => a.seq - b.seq);
  return st;
}

// Check N80 trips
console.log('N80 Trip GEN_1808579 stops:');
const n80Stops = getRouteStops('GEN_1808579');
console.log('Count:', n80Stops.length);
n80Stops.forEach(s => console.log(`[${s.seq}] ${s.stop?.name} (${s.stopId}) - ${s.dep}`));
