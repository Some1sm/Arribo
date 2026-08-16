const fs = require('fs');
const path = require('path');

const atmDir = 'H:/Coding/C10Data/data/atm_gtfs';

// 1. Inspect calendar.txt
console.log('=== CALENDAR.TXT ===');
const calContent = fs.readFileSync(path.join(atmDir, 'calendar.txt'), 'utf8').split('\n');
console.log('Calendar Header:', calContent[0]);
calContent.slice(1, 20).forEach(l => console.log(l));

// 2. Inspect calendar_dates.txt
console.log('\n=== CALENDAR_DATES.TXT ===');
const calDatesContent = fs.readFileSync(path.join(atmDir, 'calendar_dates.txt'), 'utf8').split('\n');
console.log('Calendar Dates Header:', calDatesContent[0]);
console.log(`Total calendar exception dates: ${calDatesContent.length}`);

// 3. Find service_ids used by C10 trips (route GEN_0498)
console.log('\n=== C10 TRIPS SERVICE IDS ===');
const tripsContent = fs.readFileSync(path.join(atmDir, 'trips.txt'), 'utf8').split('\n');
const tripHeader = tripsContent[0].split(',');
const rIdIdx = tripHeader.indexOf('route_id');
const tIdIdx = tripHeader.indexOf('trip_id');
const sIdIdx = tripHeader.indexOf('service_id');
const dIdIdx = tripHeader.indexOf('direction_id');

const c10Services = new Set();
const c10TripsByService = new Map(); // service_id -> [trips]

for (let i = 1; i < tripsContent.length; i++) {
  const line = tripsContent[i].trim();
  if (!line) continue;
  const p = line.split(',');
  if (p[rIdIdx] === 'GEN_0498') {
    const sId = p[sIdIdx];
    c10Services.add(sId);
    if (!c10TripsByService.has(sId)) {
      c10TripsByService.set(sId, []);
    }
    c10TripsByService.get(sId).push({
      tripId: p[tIdIdx],
      direction: p[dIdIdx]
    });
  }
}

console.log('Service IDs used by C10:', [...c10Services]);

// Check details of each service_id in calendar.txt
const calMap = new Map();
for (let i = 1; i < calContent.length; i++) {
  const line = calContent[i].trim();
  if (!line) continue;
  const p = line.split(',');
  calMap.set(p[0], {
    serviceId: p[0],
    monday: p[1],
    tuesday: p[2],
    wednesday: p[3],
    thursday: p[4],
    friday: p[5],
    saturday: p[6],
    sunday: p[7],
    startDate: p[8],
    endDate: p[9]
  });
}

for (const sId of c10Services) {
  const cal = calMap.get(sId);
  const trips = c10TripsByService.get(sId);
  console.log(`Service ${sId}: ${trips.length} trips. Calendar:`, cal);
}
