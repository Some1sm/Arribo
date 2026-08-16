const corridorTracker = require('../src/corridorTracker');

function sec(timeStr) {
  const [h, m, s = 0] = timeStr.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

// Test at 14:08 (during layover)
const time1408 = sec('14:08:00');
// Test at 14:17 (after turnaround departure)
const time1417 = sec('14:17:00');

console.log('Testing at 14:08 (during layover):');
const trip1245 = corridorTracker.fullSchedule.dir1.find(t => t.tripId === 'GEN_1811096');
const oppTrips0 = corridorTracker.fullSchedule.dir0.filter(t => corridorTracker.isServiceActiveOnDate(t.serviceId, new Date()));

const pos1408 = corridorTracker.interpolateBusPosition(trip1245, time1408, corridorTracker.stopsMapDir1, corridorTracker.stopsDir1, oppTrips0);
console.log('14:08 Dir 1 Bus Position:', pos1408 ? { isLayover: pos1408.isTerminalLayover, status: pos1408.currentSegmentTime } : null);

console.log('\nTesting at 14:17 (after turnaround departure):');
const pos1417 = corridorTracker.interpolateBusPosition(trip1245, time1417, corridorTracker.stopsMapDir1, corridorTracker.stopsDir1, oppTrips0);
console.log('14:17 Dir 1 Bus Position (should be null):', pos1417);
