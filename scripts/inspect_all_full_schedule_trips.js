const fs = require('fs');
const readline = require('readline');
const path = require('path');

async function findTrips() {
  const fullSchedule = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_full_schedule.json', 'utf8'));

  console.log('=== All Direction 0 trips in c10_full_schedule.json ===');
  fullSchedule.dir0.forEach(t => {
    const firstStop = t.stops[0];
    console.log(`TripID: ${t.tripId} | ServiceID: ${t.serviceId} | FirstDep: ${firstStop?.dep} | Headsign: ${t.headsign}`);
  });

  console.log('\n=== All Direction 1 trips in c10_full_schedule.json ===');
  fullSchedule.dir1.forEach(t => {
    const firstStop = t.stops[0];
    console.log(`TripID: ${t.tripId} | ServiceID: ${t.serviceId} | FirstDep: ${firstStop?.dep} | Headsign: ${t.headsign}`);
  });
}

findTrips().catch(console.error);
