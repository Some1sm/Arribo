/**
 * test/trip_start_test.js
 *
 * "Inici Trajecte" in the line cockpit. The SIRI feed reports a delay but
 * never which trip a bus is running or when it started, so the cockpit showed
 * "--" for every live bus. tripMatcher.matchTripStart recovers the trip from
 * the timetable and the reported delay; the tracker attaches it to live and
 * dead-reckoned buses as tripStartTime / tripStartStop (source 'timetable').
 *
 * Invariants: derived, never invented. No reported delay, a bus waiting at a
 * terminal, or two trips in the same minute give no start at all. A
 * short-turn trip starts at its own first stop. The telemetry card that shows
 * it starts folded.
 */

const fs = require('fs');
const path = require('path');
const tripMatcher = require('../src/core/schedule/tripMatcher');
const mataroSchedules = require('../src/data/mataroSchedules');
const mataroTracker = require('../src/mataroTracker');
const timeEngine = require('../src/core/time/timeEngine');

console.log('🧪 Starting Trip Start Test Suite...\n');

let passed = 0;
const failed = [];
const check = (cond, msg) => {
  if (cond) { passed++; console.log('  ✅', msg); }
  else { failed.push(msg); console.error('  ❌', msg); }
};

// Wednesday 30 Sep 2026, a plain weekday. `sec` is Madrid seconds of day.
const atSec = (sec) => timeEngine.localTimeToUtcDate(2026, 8, 30, Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60).getTime();
const hhmm = (sec) => timeEngine.secondsToTimeString(((sec % 86400) + 86400) % 86400).slice(0, 5);
const firstIndex = (trip) => trip.stopSecs.findIndex(s => s !== null && s !== undefined);

console.log('--- 1. A full trip is found from the stop it is heading to and its delay ---');
{
  const sched = mataroSchedules.getDirectionSchedule('8', '1', 'weekday');
  const trip = sched.trips[Math.floor(sched.trips.length / 2)];
  const i = 6;
  const next = sched.stops[i];
  const delay = 13;
  const r = tripMatcher.matchTripStart({
    lineId: '8', direction: '1', toSeq: next.seq, stopName: next.name, delayMins: delay,
    at: atSec(trip.stopSecs[i] - 60 + delay * 60)
  });
  const f = firstIndex(trip);
  check(r.matched === true, 'L8 trip 13 min late, a minute short of its 7th stop, is matched');
  check(r.startTime === hhmm(trip.stopSecs[f]), `It started at ${hhmm(trip.stopSecs[f])} (got ${r.startTime})`);
  check(r.startStopName === sched.stops[f].name, `It started at ${sched.stops[f].name} (got ${r.startStopName})`);
}

console.log('\n--- 2. A short-turn trip starts at its own first stop ---');
{
  const sched = mataroSchedules.getDirectionSchedule('3', '0', 'weekday');
  const trip = sched.trips.find(t => t.stopSecs[0] === null || t.stopSecs[0] === undefined);
  check(Boolean(trip), 'L3 direction 0 has a weekday trip that does not start at the line origin');
  if (trip) {
    const f = firstIndex(trip);
    const i = f + 2;
    const r = tripMatcher.matchTripStart({
      lineId: '3', direction: '0', toSeq: sched.stops[i].seq, stopName: sched.stops[i].name, delayMins: 0,
      at: atSec(trip.stopSecs[i] - 60)
    });
    // L3 has two stops named Rodalies (1016, the origin, and 1058), so compare ids.
    check(r.matched === true && r.startStopId === String(sched.stops[f].id) && r.startStopId !== String(sched.stops[0].id),
      `The short-turn starts at stop ${sched.stops[f].id} ${sched.stops[f].name}, not the line origin ${sched.stops[0].id} (got ${r.startStopId})`);
    check(r.startTime === hhmm(trip.stopSecs[f]), `…at ${hhmm(trip.stopSecs[f])} (got ${r.startTime})`);
  }
}

console.log('\n--- 3. Refusals ---');
{
  const sched = mataroSchedules.getDirectionSchedule('8', '1', 'weekday');
  const trip = sched.trips[Math.floor(sched.trips.length / 2)];
  const next = sched.stops[6];
  const base = { lineId: '8', direction: '1', toSeq: next.seq, stopName: next.name, at: atSec(trip.stopSecs[6]) };
  for (const delayMins of [null, undefined, '', 'PT5M']) {
    const r = tripMatcher.matchTripStart({ ...base, delayMins });
    check(r.matched === false && !r.startTime, `No start without a reported delay (${JSON.stringify(delayMins)})`);
  }
  const night = tripMatcher.matchTripStart({ ...base, delayMins: 0, at: atSec(3 * 3600) });
  check(night.matched === false && !night.startTime, 'No start at 03:00, when no trip is close enough');
}

console.log('\n--- 4. The tracker attaches it to live and dead-reckoned buses ---');
{
  const route = mataroTracker.routesData['8'] && mataroTracker.routesData['8'][1];
  const stops = (route && route.stops) || [];
  check(stops.length > 8, 'L8 route 1 has its stops loaded');
  const sched = mataroSchedules.getDirectionSchedule('8', '1', 'weekday');
  const trip = sched.trips[Math.floor(sched.trips.length / 2)];
  const s = stops[5];
  // Route stops carry no seq (the tracker numbers them by position), so find
  // the timetable stop by id.
  const schedIdx = sched.stops.findIndex(x => String(x.id) === String(stops[6].id));
  check(schedIdx === 6, 'The route and the timetable list L8 direction 1 stops in the same order');
  const delay = 4;
  const nowMs = atSec(trip.stopSecs[schedIdx] - 60 + delay * 60);
  const lat = parseFloat(s.latitude !== undefined ? s.latitude : s.lat);
  const lon = parseFloat(s.longitude !== undefined ? s.longitude : s.lon);
  const bus = (id, extra) => ({
    vehicleId: id, lineId: '8', direction: '1', lat, lon, speedKmh: 20, hasSpeed: true,
    timestamp: nowMs, ...extra
  });

  try {
    const live = bus('TS_LIVE', { delayMins: delay, hasDelay: true });
    const [out] = mataroTracker.processBusesWithDeadReckoning([live], route, stops, '1', [live], new Date(nowMs));
    const f = firstIndex(trip);
    check(out && out.tripStartTime === hhmm(trip.stopSecs[f]), `A live bus 4 min late carries its trip start ${hhmm(trip.stopSecs[f])} (got ${out && out.tripStartTime})`);
    check(out && out.tripStartStop === sched.stops[f].name && out.tripStartSource === 'timetable', 'It names the first stop and says the time comes from the timetable');

    const silent = bus('TS_NODELAY', { delayMins: null, hasDelay: false });
    const [outSilent] = mataroTracker.processBusesWithDeadReckoning([silent], route, stops, '1', [silent], new Date(nowMs));
    check(outSilent && outSilent.tripStartTime === null && outSilent.tripStartSource === null, 'A bus that reports no delay gets no trip start');

    const o = stops[0];
    const parked = bus('TS_TERMINAL', {
      lat: parseFloat(o.latitude !== undefined ? o.latitude : o.lat),
      lon: parseFloat(o.longitude !== undefined ? o.longitude : o.lon),
      speedKmh: 0, delayMins: 0, hasDelay: true
    });
    const [outParked] = mataroTracker.processBusesWithDeadReckoning([parked], route, stops, '1', [parked], new Date(nowMs));
    check(outParked && outParked.isTerminalLayover === true && outParked.tripStartTime === null,
      'A bus standing at the terminal gets no trip start (it could be matched to the bus ahead\'s trip)');

    // 30 s later the live bus has dropped out of the feed and is dead-reckoned.
    const later = nowMs + 30000;
    const dr = mataroTracker.processBusesWithDeadReckoning([], route, stops, '1', [], new Date(later))
      .find(b => b.vehicleId === 'TS_LIVE');
    check(dr && dr.isEstimated === true && dr.tripStartTime === out.tripStartTime && dr.tripStartSource === 'timetable',
      'The dead-reckoned bus keeps the trip start it was last matched to');
  } finally {
    for (const id of ['TS_LIVE', 'TS_NODELAY', 'TS_TERMINAL']) mataroTracker.vehicleHistory.delete(id);
  }
}

console.log('\n--- 5. The telemetry card starts folded ---');
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  check(/id="telemetry-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="telemetry-body"/.test(html),
    'The header is a toggle button, collapsed, controlling the body');
  check(/<div class="telemetry-body" id="telemetry-body" hidden>/.test(html), 'The body is hidden in the markup');
  check(['telemetry-coords', 'telemetry-trip-start', 'telemetry-vehicles-chips'].every(id => {
    const body = html.indexOf('id="telemetry-body"');
    const card = html.indexOf('id="corridor-timeline-container"');
    const at = html.indexOf(`id="${id}"`);
    return at > body && at < card;
  }), 'The technical fields live inside the folded body; the route timeline does not');
  check(app.includes("localStorage.getItem('arribo_telemetry_open') === '1'"), 'It opens only if this browser opened it before');
}

console.log('\n=====================================================');
console.log(`Passed: ${passed}, Failed: ${failed.length}`);
if (failed.length) {
  console.error('\n🔴 FAILURES:');
  failed.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log('\n🎉 ALL TRIP START TESTS PASSED!\n');
process.exit(0);
