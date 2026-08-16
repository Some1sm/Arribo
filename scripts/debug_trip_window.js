const fs = require('fs');
const fullSchedule = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_full_schedule.json', 'utf8'));

const todaysTrips = fullSchedule.dir1.filter(t => t.serviceId === 'GEN_184749');
const now = new Date();
const currentSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
console.log('currentSec:', currentSec);

for (const trip of todaysTrips) {
  const stopEntry = trip.stops.find(s => s.stopId === 'GEN_PF08015014');
  console.log(`Trip ${trip.tripId}: stopEntry =`, stopEntry);
  if (stopEntry) {
    const tripStartSec = 12 * 3600 + 45 * 60 + 15;
    const tripEndSec = 14 * 3600 + 5 * 60 + 15;
    const stopSchedSec = 13 * 3600 + 0 * 60 + 15;
    console.log(`  tripStartSec: ${tripStartSec}, tripEndSec: ${tripEndSec}, stopSchedSec: ${stopSchedSec}`);
    console.log(`  check 1 (currentSec in window):`, currentSec >= tripStartSec - 300 && currentSec <= tripEndSec + 900);
    console.log(`  check 2 (currentSec - stopSchedSec <= 600):`, currentSec - stopSchedSec <= 600, `(diff: ${currentSec - stopSchedSec})`);
  }
}
