/**
 * stop_departures_dedup_test.js
 *
 * THE REGRESSION TEST FOR THE "WHERE IS THE 11:03 BUS?" DEFECT.
 *
 * A rider checked L1 at Roca Blanca against the published timetable and found
 * the board showing 10:28 10:37 10:50 11:16 11:29 — the real 10:25, 10:37 and
 * 11:03 were missing. The timetable grid was never wrong; the published times
 * were in the data the whole time. They were being deleted at render time by
 * the live/scheduled merge in scheduleSynthesizer.compileStopDepartures.
 *
 * Two distinct defects, both reproduced here:
 *
 *   1. A bus merely running early absorbed its NEIGHBOUR's trip. Bus 2680 was
 *      scheduled for 11:16 and observed at 11:11; 11:11 - 11:03 is exactly the
 *      8-minute duplicate window, so the real 11:03 departure was suppressed as
 *      a "duplicate" of a bus that was not running it. When a bus names the
 *      trip it is running, that identification is authoritative — raw proximity
 *      to the observed time must not be consulted as well.
 *
 *   2. A synthetic EST_ vehicle deleted published departures. Its time at a
 *      stop is interpolated from position, never observed, so it must not
 *      decide that a real trip is already covered. These are the same runs the
 *      flight recorder already excludes.
 *
 * The published times used below are L1 direction 11 (Rodalies -> Hospital),
 * weekday, at Roca Blanca (stop 1029, 26 min from the origin).
 */

'use strict';

const scheduleSynthesizer = require('../src/core/schedule/scheduleSynthesizer');
const mataroSchedules = require('../src/data/mataroSchedules');

let passed = 0;
const failed = [];

function check(cond, msg) {
  if (cond) { passed++; return; }
  failed.push(msg);
}

const LINE = '1';
const DIR = '1';
const STOP = '1029';
const TZ = 'Europe/Madrid';

// Pinned instants. The board is built relative to "now", so a wall-clock test
// would report different trips depending on the hour it runs. 09:00 Madrid
// puts the whole 10:25-11:29 reference window in the future, and 04:45 opens
// the pre-first-bus gap the synthetic vehicles exist to fill.
const PIN = '2026-09-24T09:00:00+02:00';
const PIN_EARLY = '2026-09-24T04:45:00+02:00';

function compile(liveDepartures, limit = 40, dateObj = PIN) {
  const sched = mataroSchedules.getDirectionSchedule(LINE, DIR, 'weekday');
  const stopTravelSec = mataroSchedules.getStopTravelTime(LINE, DIR, STOP, 'weekday');
  return scheduleSynthesizer.compileStopDepartures({
    baseDeparturesToday: sched.departures,
    baseDeparturesTomorrow: [],
    stopTravelSec,
    liveDepartures,
    limit,
    duplicateWindowMinutes: 8,
    dateObj: new Date(dateObj),
    timezone: TZ,
    lineId: LINE,
    lineCode: LINE,
    lineName: 'Circular',
    destination: sched.directionName,
    directionId: DIR,
    isTrain: false
  });
}

const times = (rows) => rows.map(r => r.scheduledTime || r.departureTime);

// ---------------------------------------------------------------------------
console.log('--- Stop Departures Deduplication Tests ---');
console.log('   (live/scheduled merge — the "missing 11:03" regression guard)\n');

// ===========================================================================
console.log('📌 Test 1: The published grid is correct before any live data');
// ===========================================================================
{
  const sched = mataroSchedules.getDirectionSchedule(LINE, DIR, 'weekday');
  const stopTravelSec = mataroSchedules.getStopTravelTime(LINE, DIR, STOP, 'weekday');
  const fromSec = t => { const [h, m] = t.split(':').map(Number); return h * 3600 + m * 60; };
  const toStr = s => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  const grid = sched.departures.map(t => toStr(fromSec(t) + stopTravelSec));

  // This is the rider's reference list, read off the published winter grid.
  const reference = ['10:25', '10:37', '10:50', '11:03', '11:16', '11:29'];
  reference.forEach(t => check(grid.includes(t), `Published grid must contain ${t} at Roca Blanca`));

  const out = times(compile([]));
  reference.forEach(t => check(out.includes(t), `With no live data the board must show ${t}`));

  console.log(`  ✓ Test 1 Passed: grid and no-live board both carry ${reference.join(' ')}.`);
}

// ===========================================================================
console.log('\n📌 Test 2: A bus running EARLY must not swallow its neighbour\'s trip');
// ===========================================================================
{
  // Bus 2680 is the 11:16 trip, observed 4 minutes early at 11:11.
  const earlyBus = {
    lineId: '1', lineCode: '1', lineName: 'Circular',
    destination: 'Rodalies - Hospital', directionId: '1',
    departureTime: '11:11',
    scheduledTime: '11:16',
    aimedIso: null,
    isRealTime: true, isRealtime: true, isEstimated: false,
    vehicleId: '2680', delayMins: -4
  };

  const out = compile([earlyBus]);
  const shown = times(out);

  // Its own trip IS absorbed — correctly, the bus is running it.
  check(out.some(r => r.isRealTime && (r.scheduledTime === '11:16' || r.departureTime === '11:11')),
    'The live bus must still appear on its own 11:16 trip');

  // The neighbour must survive. Before the fix this was the reported defect:
  // 11:11 is exactly 8 minutes after 11:03, so the window ate the real trip.
  check(shown.includes('11:03'),
    `The 11:03 departure must survive a bus running early; board was: ${shown.join(' ')}`);
  check(shown.includes('11:29'), 'Departures after the live trip must be unaffected');

  console.log('  ✓ Test 2 Passed: an early bus no longer eats its neighbour 11:03.');
}

// ===========================================================================
console.log('\n📌 Test 3: A synthetic EST_ vehicle must not delete published departures');
// ===========================================================================
{
  // A theoretical run at 10:29 sat 4 minutes from 10:25 and 8 minutes from
  // 10:37, removing both from the board. Its time is interpolated, not observed.
  const ghost = {
    lineId: '1', lineCode: '1', lineName: 'Circular',
    destination: 'Rodalies - Hospital', directionId: '1',
    departureTime: '10:29',
    scheduledTime: '10:29',
    isRealTime: false, isRealtime: false, isEstimated: true,
    vehicleId: 'EST_1_1_1011', delayMins: 0
  };

  const out = compile([ghost]);
  const shown = times(out);

  check(shown.includes('10:25'), `The 10:25 departure must survive a synthetic vehicle; board was: ${shown.join(' ')}`);
  check(shown.includes('10:37'), `The 10:37 departure must survive a synthetic vehicle; board was: ${shown.join(' ')}`);

  // And when a published trip is right there, the ghost yields: the real time is
  // the one riders are held to, and two near-identical rows invite the reader to
  // wonder which is real.
  check(!out.some(r => r.vehicleId === 'EST_1_1_1011' && r.departureTime === '10:29'),
    'A synthetic vehicle must yield to the published trip beside it');

  console.log('  ✓ Test 3 Passed: EST_ runs enrich but never remove published trips.');
}

// ===========================================================================
console.log('\n📌 Test 4: A synthetic vehicle still appears when nothing published is near');
// ===========================================================================
{
  // Its whole purpose is to stop the board being empty before the first real bus.
  // Far from any published trip it must remain. L1's first Roca Blanca passing
  // time is 05:51, so 05:00 sits in the empty gap ahead of the service.
  const earlyGhost = {
    lineId: '1', lineCode: '1', lineName: 'Circular',
    destination: 'Rodalies - Hospital', directionId: '1',
    departureTime: '05:00',
    scheduledTime: '05:00',
    isRealTime: false, isRealtime: false, isEstimated: true,
    vehicleId: 'EST_1_1_0500', delayMins: 0
  };
  const out = compile([earlyGhost], 10, PIN_EARLY);
  check(out.some(r => r.vehicleId === 'EST_1_1_0500'),
    'A synthetic vehicle with no published trip nearby must still be shown');
  console.log('  ✓ Test 4 Passed: synthetic runs still fill an otherwise empty board.');
}

// ===========================================================================
console.log('\n📌 Test 5: The exact reported scenario, end to end');
// ===========================================================================
{
  // The three departures present in the app when the rider reported the bug:
  // a synthetic run, a bus on time, and a bus four minutes early.
  const live = [
    { lineId: '1', lineCode: '1', lineName: 'Circular', destination: 'Rodalies - Hospital', directionId: '1',
      departureTime: '10:29', scheduledTime: '10:29', isRealTime: false, isRealtime: false, isEstimated: true,
      vehicleId: 'EST_1_1_1011', delayMins: 0 },
    { lineId: '1', lineCode: '1', lineName: 'Circular', destination: 'Rodalies - Hospital', directionId: '1',
      departureTime: '10:50', scheduledTime: '10:50', isRealTime: true, isRealtime: true, isEstimated: false,
      vehicleId: '2682', delayMins: 0 },
    { lineId: '1', lineCode: '1', lineName: 'Circular', destination: 'Rodalies - Hospital', directionId: '1',
      departureTime: '11:11', scheduledTime: '11:16', isRealTime: true, isRealtime: true, isEstimated: false,
      vehicleId: '2680', delayMins: -4 }
  ];

  const shown = times(compile(live));
  const reference = ['10:25', '10:37', '10:50', '11:03', '11:16', '11:29'];
  reference.forEach(t => check(shown.includes(t),
    `Reported scenario must show ${t}; board was: ${shown.join(' ')}`));

  // No ghost rows left behind once a real trip covers the slot.
  check(!compile(live).some(r => r.vehicleId && String(r.vehicleId).startsWith('EST_')),
    'No synthetic row should remain beside a published trip');

  const window = [...shown].sort().filter(t => t >= '10:25' && t <= '11:29');
  console.log(`  ✓ Test 5 Passed: the 10:25-11:29 window reads ${window.join(' ')} — the rider's expected list.`);
}

// ---------------------------------------------------------------------------
console.log('\n=====================================================');
console.log(`Passed: ${passed}, Failed: ${failed.length}`);
if (failed.length) {
  console.error('\n🔴 FAILURES:');
  failed.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log('\n🎉 ALL STOP DEPARTURES DEDUP TESTS PASSED!\n');
