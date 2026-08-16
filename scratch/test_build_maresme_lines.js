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

const shapes = {};
fs.readFileSync('data/atm_gtfs/shapes.txt', 'utf8').split('\n').slice(1).filter(Boolean).forEach(l => {
  const parts = l.split(',');
  const sId = parts[0];
  if (!shapes[sId]) shapes[sId] = [];
  shapes[sId].push({
    lat: parseFloat(parts[1]),
    lon: parseFloat(parts[2]),
    seq: parseInt(parts[3], 10)
  });
});
Object.values(shapes).forEach(pts => pts.sort((a, b) => a.seq - b.seq));

const trips = fs.readFileSync('data/atm_gtfs/trips.txt', 'utf8').split('\n').slice(1).filter(Boolean).map(l => {
  const p = l.split(',');
  return {
    routeId: p[0],
    tripId: p[1],
    headsign: p[2] || '',
    dirId: p[4] || '0',
    shapeId: p[6] || ''
  };
});

const stopTimes = fs.readFileSync('data/atm_gtfs/stop_times.txt', 'utf8').split('\n').slice(1).filter(Boolean).map(l => {
  const p = l.split(',');
  return {
    tripId: p[0],
    arr: p[1],
    dep: p[2],
    stopId: p[3],
    seq: parseInt(p[4], 10)
  };
});

const stopTimesByTrip = {};
stopTimes.forEach(st => {
  if (!stopTimesByTrip[st.tripId]) stopTimesByTrip[st.tripId] = [];
  stopTimesByTrip[st.tripId].push(st);
});
Object.values(stopTimesByTrip).forEach(arr => arr.sort((a, b) => a.seq - b.seq));

const MARESME_LINES = [
  { id: 'n80', routeId: 'GEN_0109', code: 'N80', name: 'Barcelona (Pg. de Gràcia) ⇄ Mataró (NitBus)', color: '#009485' },
  { id: 'n81', routeId: 'GEN_0147', code: 'N81', name: 'Barcelona (Pg. de Gràcia) ⇄ Vilassar de Dalt (NitBus)', color: '#009485' },
  { id: 'e111', routeId: 'GEN_0496', code: 'e11.1', name: 'Barcelona (Rda. Universitat) ⇄ Mataró (Pl. Tereses - Exprés)', color: '#009485' },
  { id: 'e112', routeId: 'GEN_0497', code: 'e11.2', name: 'Barcelona (Rda. Universitat) ⇄ Mataró (Nord - Exprés)', color: '#009485' },
  { id: 'c20', routeId: 'GEN_0501', code: 'C-20', name: 'Sant Vicenç de Montalt ⇄ Llavaneres ⇄ Mataró', color: '#009485' },
  { id: 'c30', routeId: 'GEN_0495', code: 'C-30', name: 'Vilassar de Dalt ⇄ Premià ⇄ Mataró (Hospital)', color: '#009485' },
  { id: 'c3', routeId: 'GEN_0831', code: 'C-3', name: 'Vilassar de Dalt ⇄ Premià de Mar ⇄ Barcelona', color: '#009485' },
  { id: 'c12', routeId: 'GEN_0832', code: 'C-12', name: 'Cabrils ⇄ Vilassar de Mar', color: '#009485' },
  { id: 'c14', routeId: 'GEN_0575', code: 'C-14', name: 'Premià de Dalt ⇄ Premià de Mar', color: '#009485' },
  { id: 'c15', routeId: 'GEN_0273', code: 'C-15', name: 'Teià ⇄ El Masnou', color: '#009485' }
];

console.log('--- Checking Maresme Moventis Lines GTFS Data ---');
MARESME_LINES.forEach(l => {
  const lineTrips = trips.filter(t => t.routeId === l.routeId);
  const dir0Trips = lineTrips.filter(t => t.dirId === '0');
  const dir1Trips = lineTrips.filter(t => t.dirId === '1');
  const sampleTrip = lineTrips[0];
  const tripStops = sampleTrip ? (stopTimesByTrip[sampleTrip.tripId] || []) : [];
  const shapePts = sampleTrip?.shapeId ? (shapes[sampleTrip.shapeId] || []) : [];
  console.log(`Línia ${l.code} (${l.id}): Trips: ${lineTrips.length} (Dir 0: ${dir0Trips.length}, Dir 1: ${dir1Trips.length}) | Stops: ${tripStops.length} | Shape Pts: ${shapePts.length}`);
});
