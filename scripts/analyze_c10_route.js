const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function main() {
  const atmDir = 'H:/Coding/C10Data/data/atm_gtfs';

  // 1. Get all trips for route GEN_0498
  console.log('Loading trips for route GEN_0498 (C10)...');
  const tripsContent = fs.readFileSync(path.join(atmDir, 'trips.txt'), 'utf8').split('\n');
  const tripHeader = tripsContent[0].split(',');
  const routeIdIdx = tripHeader.indexOf('route_id');
  const tripIdIdx = tripHeader.indexOf('trip_id');
  const dirIdIdx = tripHeader.indexOf('direction_id');
  const headsignIdx = tripHeader.indexOf('trip_headsign');
  const shapeIdIdx = tripHeader.indexOf('shape_id');
  const serviceIdIdx = tripHeader.indexOf('service_id');

  const c10Trips = new Map(); // trip_id -> info
  for (let i = 1; i < tripsContent.length; i++) {
    const line = tripsContent[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts[routeIdIdx] === 'GEN_0498') {
      c10Trips.set(parts[tripIdIdx], {
        tripId: parts[tripIdIdx],
        directionId: parts[dirIdIdx],
        headsign: parts[headsignIdx],
        shapeId: parts[shapeIdIdx],
        serviceId: parts[serviceIdIdx]
      });
    }
  }
  console.log(`Found ${c10Trips.size} trips for C10.`);

  // 2. Load stops map
  const stopsMap = new Map();
  const stopsLines = fs.readFileSync(path.join(atmDir, 'stops.txt'), 'utf8').split('\n');
  const stopHeader = stopsLines[0].split(',');
  const sIdIdx = stopHeader.indexOf('stop_id');
  const sNameIdx = stopHeader.indexOf('stop_name');
  const sLatIdx = stopHeader.indexOf('stop_lat');
  const sLonIdx = stopHeader.indexOf('stop_lon');
  const sCodeIdx = stopHeader.indexOf('stop_code');

  for (let i = 1; i < stopsLines.length; i++) {
    const line = stopsLines[i].trim();
    if (!line) continue;
    const parts = line.split(',');
    stopsMap.set(parts[sIdIdx], {
      id: parts[sIdIdx],
      name: parts[sNameIdx],
      lat: parts[sLatIdx],
      lon: parts[sLonIdx],
      code: parts[sCodeIdx]
    });
  }

  // 3. Load stop_times for a sample trip in each direction
  const tripsByDir = {};
  for (const [tId, info] of c10Trips.entries()) {
    if (!tripsByDir[info.directionId]) {
      tripsByDir[info.directionId] = tId;
    }
  }
  console.log('Sample trips by direction:', tripsByDir);

  const stStream = fs.createReadStream(path.join(atmDir, 'stop_times.txt'));
  const rl = readline.createInterface({ input: stStream, crlfDelay: Infinity });

  let stHeader = [];
  const dir0Stops = [];
  const dir1Stops = [];

  for await (const line of rl) {
    if (stHeader.length === 0) {
      stHeader = line.split(',');
      continue;
    }
    const parts = line.split(',');
    const tripId = parts[0];
    if (tripId === tripsByDir['0']) {
      dir0Stops.push({
        seq: parseInt(parts[4]),
        stopId: parts[3],
        arr: parts[1],
        dep: parts[2]
      });
    } else if (tripId === tripsByDir['1']) {
      dir1Stops.push({
        seq: parseInt(parts[4]),
        stopId: parts[3],
        arr: parts[1],
        dep: parts[2]
      });
    }
  }

  dir0Stops.sort((a, b) => a.seq - b.seq);
  dir1Stops.sort((a, b) => a.seq - b.seq);

  console.log(`\n=== DIRECTION 0 (${c10Trips.get(tripsByDir['0'])?.headsign}) - ${dir0Stops.length} STOPS ===`);
  dir0Stops.forEach(s => {
    const st = stopsMap.get(s.stopId);
    console.log(`${s.seq.toString().padStart(2, ' ')}. [${s.stopId}] (code: ${st?.code}) ${st?.name} @ ${s.arr} (lat: ${st?.lat}, lon: ${st?.lon})`);
  });

  console.log(`\n=== DIRECTION 1 (${c10Trips.get(tripsByDir['1'])?.headsign}) - ${dir1Stops.length} STOPS ===`);
  dir1Stops.forEach(s => {
    const st = stopsMap.get(s.stopId);
    console.log(`${s.seq.toString().padStart(2, ' ')}. [${s.stopId}] (code: ${st?.code}) ${st?.name} @ ${s.arr} (lat: ${st?.lat}, lon: ${st?.lon})`);
  });

  // Save the structured C10 route & stops into a clean JSON file
  const c10Data = {
    route: {
      id: 'GEN_0498',
      shortName: 'C10',
      longName: 'Mataró - Barcelona per la N-II',
      agency: 'Empresa Casas (Moventis)',
      color: '#009485'
    },
    targetStop: {
      stopId: 'GEN_PF08121075',
      code: '121',
      name: 'plaça Itàlia (A)',
      coords: { lat: 41.5468674, lon: 2.4321194 },
      direction: 'Barcelona -> Mataró'
    },
    directions: {
      '0': {
        headsign: c10Trips.get(tripsByDir['0'])?.headsign,
        stops: dir0Stops.map(s => ({
          seq: s.seq,
          stopId: s.stopId,
          code: stopsMap.get(s.stopId)?.code,
          name: stopsMap.get(s.stopId)?.name,
          lat: parseFloat(stopsMap.get(s.stopId)?.lat),
          lon: parseFloat(stopsMap.get(s.stopId)?.lon),
          scheduledTime: s.arr
        }))
      },
      '1': {
        headsign: c10Trips.get(tripsByDir['1'])?.headsign,
        stops: dir1Stops.map(s => ({
          seq: s.seq,
          stopId: s.stopId,
          code: stopsMap.get(s.stopId)?.code,
          name: stopsMap.get(s.stopId)?.name,
          lat: parseFloat(stopsMap.get(s.stopId)?.lat),
          lon: parseFloat(stopsMap.get(s.stopId)?.lon),
          scheduledTime: s.arr
        }))
      }
    }
  };

  fs.writeFileSync('H:/Coding/C10Data/data/c10_route_stops.json', JSON.stringify(c10Data, null, 2));
  console.log('\nSaved H:/Coding/C10Data/data/c10_route_stops.json');
}

main().catch(console.error);
