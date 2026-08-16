const fs = require('fs');
const path = require('path');

const fullSchedule = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_full_schedule.json', 'utf8'));
const stopsDir1 = JSON.parse(fs.readFileSync('H:/Coding/C10Data/data/c10_matched_stops_dir1.json', 'utf8'));

const stopsMap = new Map();
stopsDir1.forEach(s => stopsMap.set(s.gtfsStopId, s));

function timeToSec(timeStr) {
  const [h, m, s] = timeStr.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
}

function secToTime(totalSec) {
  const h = Math.floor(totalSec / 3600) % 24;
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function getBusPositionAtTime(trip, currentSec) {
  const stops = trip.stops;
  if (!stops || stops.length < 2) return null;

  const firstDep = timeToSec(stops[0].dep);
  const lastArr = timeToSec(stops[stops.length - 1].arr);

  if (currentSec < firstDep - 300 || currentSec > lastArr + 300) {
    return null; // Not active
  }

  // Find active segment
  for (let i = 0; i < stops.length - 1; i++) {
    const s1 = stops[i];
    const s2 = stops[i + 1];
    const t1 = timeToSec(s1.dep);
    const t2 = timeToSec(s2.arr);

    if (currentSec >= t1 && currentSec <= t2) {
      const segDuration = t2 - t1;
      const progress = segDuration > 0 ? (currentSec - t1) / segDuration : 0;

      const stop1Data = stopsMap.get(s1.stopId);
      const stop2Data = stopsMap.get(s2.stopId);

      if (stop1Data && stop2Data && stop1Data.lat && stop2Data.lat) {
        const lat = stop1Data.lat + progress * (stop2Data.lat - stop1Data.lat);
        const lon = stop1Data.lon + progress * (stop2Data.lon - stop1Data.lon);

        return {
          tripId: trip.tripId,
          fromStop: stop1Data.name,
          toStop: stop2Data.name,
          fromSeq: s1.seq,
          toSeq: s2.seq,
          progressInSegment: progress,
          totalProgress: Math.round(((s1.seq + progress) / stops.length) * 100),
          lat,
          lon,
          secondsToNextStop: t2 - currentSec,
          currentSegmentTime: `${secToTime(t1)} -> ${secToTime(t2)}`
        };
      }
    }
  }

  // If before first stop
  if (currentSec < firstDep) {
    const stop1Data = stopsMap.get(stops[0].stopId);
    return {
      tripId: trip.tripId,
      fromStop: 'Inici de línia',
      toStop: stop1Data?.name,
      fromSeq: 0,
      toSeq: 1,
      progressInSegment: 0,
      totalProgress: 0,
      lat: stop1Data?.lat,
      lon: stop1Data?.lon,
      secondsToNextStop: firstDep - currentSec,
      currentSegmentTime: `Inici a ${secToTime(firstDep)}`
    };
  }

  return null;
}

// Test with a sample time e.g. 13:15:00
const testSec = timeToSec('13:15:00');
console.log('Testing active buses at 13:15:00:');
for (const trip of fullSchedule.dir1) {
  const pos = getBusPositionAtTime(trip, testSec);
  if (pos) {
    console.log('Active Bus:', pos);
  }
}
