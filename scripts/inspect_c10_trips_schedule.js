const fs = require('fs');
const path = require('path');
const readline = require('readline');

async function main() {
  const atmDir = 'H:/Coding/C10Data/data/atm_gtfs';

  // 1. Get all C10 trips
  const tripsContent = fs.readFileSync(path.join(atmDir, 'trips.txt'), 'utf8').split('\n');
  const tripHeader = tripsContent[0].split(',');
  const rIdIdx = tripHeader.indexOf('route_id');
  const tIdIdx = tripHeader.indexOf('trip_id');
  const dIdIdx = tripHeader.indexOf('direction_id');
  const sIdIdx = tripHeader.indexOf('service_id');
  const hIdx = tripHeader.indexOf('trip_headsign');

  const c10TripMap = new Map();
  for (let i = 1; i < tripsContent.length; i++) {
    const p = tripsContent[i].trim().split(',');
    if (p[rIdIdx] === 'GEN_0498') {
      c10TripMap.set(p[tIdIdx], {
        tripId: p[tIdIdx],
        directionId: p[dIdIdx],
        serviceId: p[sIdIdx],
        headsign: p[hIdx]
      });
    }
  }
  console.log(`Total C10 trips: ${c10TripMap.size}`);

  // 2. Read stop_times for all C10 trips
  const stStream = fs.createReadStream(path.join(atmDir, 'stop_times.txt'));
  const rl = readline.createInterface({ input: stStream, crlfDelay: Infinity });

  let stHeader = [];
  const tripsWithTimes = new Map(); // tripId -> [{ stopId, arr, dep, seq }]

  for await (const line of rl) {
    if (stHeader.length === 0) {
      stHeader = line.split(',');
      continue;
    }
    const p = line.split(',');
    const tripId = p[0];
    if (c10TripMap.has(tripId)) {
      if (!tripsWithTimes.has(tripId)) {
        tripsWithTimes.set(tripId, []);
      }
      tripsWithTimes.get(tripId).push({
        stopId: p[3],
        arr: p[1],
        dep: p[2],
        seq: parseInt(p[4])
      });
    }
  }

  console.log(`Loaded stop_times for ${tripsWithTimes.size} C10 trips.`);

  // Inspect a few trips in Direction 1 (to Mataró) and Direction 0 (to Barcelona)
  const dir1Trips = [];
  const dir0Trips = [];

  for (const [tId, times] of tripsWithTimes.entries()) {
    times.sort((a, b) => a.seq - b.seq);
    const info = c10TripMap.get(tId);
    const firstTime = times[0]?.dep;
    const lastTime = times[times.length - 1]?.arr;

    const tripObj = {
      tripId: tId,
      direction: info.directionId,
      headsign: info.headsign,
      serviceId: info.serviceId,
      startTime: firstTime,
      endTime: lastTime,
      stopsCount: times.length,
      stops: times
    };

    if (info.directionId === '1') {
      dir1Trips.push(tripObj);
    } else {
      dir0Trips.push(tripObj);
    }
  }

  dir1Trips.sort((a, b) => a.startTime.localeCompare(b.startTime));
  dir0Trips.sort((a, b) => a.startTime.localeCompare(b.startTime));

  console.log(`\nDirection 1 (to Mataró) has ${dir1Trips.length} scheduled trips:`);
  dir1Trips.slice(0, 15).forEach(t => {
    console.log(`  Trip ${t.tripId}: ${t.startTime} -> ${t.endTime} (${t.stopsCount} stops)`);
  });

  console.log(`\nDirection 0 (to Barcelona) has ${dir0Trips.length} scheduled trips:`);
  dir0Trips.slice(0, 15).forEach(t => {
    console.log(`  Trip ${t.tripId}: ${t.startTime} -> ${t.endTime} (${t.stopsCount} stops)`);
  });

  // Save the complete schedule into data/c10_full_schedule.json
  const scheduleData = {
    dir1: dir1Trips,
    dir0: dir0Trips
  };

  fs.writeFileSync('H:/Coding/C10Data/data/c10_full_schedule.json', JSON.stringify(scheduleData, null, 2));
  console.log('\nSaved full schedule to H:/Coding/C10Data/data/c10_full_schedule.json');
}

main().catch(console.error);
