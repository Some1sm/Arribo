const fs = require('fs');

const fullSchedule = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_full_schedule.json', 'utf8'));
const stopsDir1 = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_matched_stops_dir1.json', 'utf8'));

function timeToMin(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function computeDelay(liveTimeStr, isRealtime, stopGtfsId, direction, activeServiceId = 'GEN_184749') {
  const trips = direction === '0' ? fullSchedule.dir0 : fullSchedule.dir1;
  const todaysTrips = trips.filter(t => t.serviceId === activeServiceId);

  const liveMin = timeToMin(liveTimeStr);
  let bestTrip = null;
  let minDiff = Infinity;
  let scheduledTime = liveTimeStr;

  for (const trip of todaysTrips) {
    const stopTime = trip.stops.find(s => s.stopId === stopGtfsId);
    if (stopTime) {
      const schedStr = stopTime.arr.substring(0, 5);
      const schedMin = timeToMin(schedStr);
      const diff = Math.abs(liveMin - schedMin);
      if (diff < minDiff && diff <= 45) { // Within 45 min matching window
        minDiff = diff;
        bestTrip = trip;
        scheduledTime = schedStr;
      }
    }
  }

  const schedMin = timeToMin(scheduledTime);
  const delayMinutes = isRealtime ? liveMin - schedMin : 0;

  let delayStatus = 'scheduled';
  let delayBadgeText = 'Programat';

  if (isRealtime) {
    if (delayMinutes >= 2) {
      delayStatus = 'delayed';
      delayBadgeText = `+${delayMinutes} min retard`;
    } else if (delayMinutes <= -2) {
      delayStatus = 'early';
      delayBadgeText = `${Math.abs(delayMinutes)} min avançat`;
    } else {
      delayStatus = 'on_time';
      delayBadgeText = "A l'hora";
    }
  }

  return {
    scheduledTime,
    realtimeTime: liveTimeStr,
    delayMinutes,
    delayStatus,
    delayBadgeText,
    comparisonText: isRealtime
      ? `Horari programat: ${scheduledTime} (${delayBadgeText})`
      : `Horari programat: ${scheduledTime}`
  };
}

// Test sample
const res1 = computeDelay('14:04', true, 'GEN_PF08121075', '1');
console.log('Sample 14:04 with GPS:', res1);

const res2 = computeDelay('14:00', false, 'GEN_PF08121075', '1');
console.log('Sample 14:00 Scheduled:', res2);
