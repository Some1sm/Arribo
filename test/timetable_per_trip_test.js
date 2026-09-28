/**
 * test/timetable_per_trip_test.js
 *
 * Tests the per-trip timetable model (Phase 3 of docs/history/DATA_TRUST_IMPLEMENTATION_PLAN.md).
 * Offline test: never calls network. Uses fixtures and shipped data.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const mataroSchedules = require('../src/data/mataroSchedules');
const S = require('../scripts/scrape_maresme_timetables');

let passed = 0;
const failed = [];

function check(cond, msg) {
  if (cond) {
    passed++;
    return;
  }
  console.error(`  ✗ FAIL: ${msg}`);
  failed.push(msg);
}

function eq(actual, expected, msg) {
  check(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

console.log('🧪 Starting timetable_per_trip_test.js...\n');

// ===========================================================================
// Test 1: Golden published cells
// ===========================================================================
console.log('📌 Test 1: Golden published cells (winter L1 d11 weekday trip 05:25)');
{
  // Trip leaving Rodalies (1016) at 05:25
  const stop1021Deps = mataroSchedules.getDeparturesForStop('1', '11', '1021', 'weekday', 'winter');
  eq(stop1021Deps[0], '05:31', 'Stop 1021 first departure is 05:31');
  const t1021Sec = mataroSchedules.getTripStopTime('1', '11', '05:25', '1021', 'weekday', 'winter');
  eq(t1021Sec, 5 * 3600 + 31 * 60, 'Stop 1021 trip stop time is 05:31 in sec (19860)');

  const stop1022Deps = mataroSchedules.getDeparturesForStop('1', '11', '1022', 'weekday', 'winter');
  eq(stop1022Deps[0], '05:34', 'Stop 1022 first departure is 05:34');
  const t1022Sec = mataroSchedules.getTripStopTime('1', '11', '05:25', '1022', 'weekday', 'winter');
  eq(t1022Sec, 5 * 3600 + 34 * 60, 'Stop 1022 trip stop time is 05:34 in sec (20040)');

  const stop1031Deps = mataroSchedules.getDeparturesForStop('1', '11', '1031', 'weekday', 'winter');
  eq(stop1031Deps[0], '05:45', 'Stop 1031 first departure is 05:45');
  const t1031Sec = mataroSchedules.getTripStopTime('1', '11', '05:25', '1031', 'weekday', 'winter');
  eq(t1031Sec, 5 * 3600 + 45 * 60, 'Stop 1031 trip stop time is 05:45 in sec (20700)');

  const stop1033Deps = mataroSchedules.getDeparturesForStop('1', '11', '1033', 'weekday', 'winter');
  eq(stop1033Deps[0], '05:47', 'Stop 1033 first departure is 05:47');
  const t1033Sec = mataroSchedules.getTripStopTime('1', '11', '05:25', '1033', 'weekday', 'winter');
  eq(t1033Sec, 5 * 3600 + 47 * 60, 'Stop 1033 trip stop time is 05:47 in sec (20820)');
}

// ===========================================================================
// Test 2: Mid-route start (E2)
// ===========================================================================
console.log('\n📌 Test 2: Mid-route start (E2 - winter L3 d11 weekday)');
{
  const dir = mataroSchedules.getDirectionSchedule('3', '11', 'weekday', 'winter');
  check(Boolean(dir), 'L3 d11 schedule found');
  const trip0 = dir.trips[0];
  check(Boolean(trip0), 'Trip 0 found');
  // First 6 stops (indices 0..5) are null
  for (let i = 0; i <= 5; i++) {
    eq(trip0.stopSecs[i], null, `Trip 0 has null at stop index ${i}`);
  }
  check(trip0.stopSecs[6] !== null, 'Trip 0 has a valid time at stop index 6');

  const stop0Id = dir.stops[0].id;
  const stop6Id = dir.stops[6].id;
  const stop0Board = mataroSchedules.getDeparturesForStop('3', '11', stop0Id, 'weekday', 'winter');
  const stop6Board = mataroSchedules.getDeparturesForStop('3', '11', stop6Id, 'weekday', 'winter');

  const passSec = trip0.stopSecs[6];
  const passH = Math.floor(passSec / 3600) % 24;
  const passM = Math.floor((passSec % 3600) / 60);
  const trip0TimeStr = `${String(passH).padStart(2, '0')}:${String(passM).padStart(2, '0')}`;

  check(stop6Board.includes(trip0TimeStr), `Mid-route trip time ${trip0TimeStr} appears on stop 6 (${stop6Id}) board`);
  check(!stop0Board.includes(trip0TimeStr), `Mid-route trip time ${trip0TimeStr} does NOT appear on stop 0 (${stop0Id}) board`);
}

// ===========================================================================
// Test 3: Early end (E2)
// ===========================================================================
console.log('\n📌 Test 3: Early end (E2 - winter L7 d11 Saturday)');
{
  const dir = mataroSchedules.getDirectionSchedule('7', '11', 'saturday', 'winter');
  check(Boolean(dir), 'L7 d11 Saturday schedule found');
  // Find the trip that ends at stop index 2 (stops 0, 1, 2 served; 3, 4 null)
  const shortTrip = dir.trips.find(t => t.stopSecs[2] !== null && t.stopSecs[3] === null);
  check(Boolean(shortTrip), 'Short trip ending at stop index 2 exists');

  const stop2Id = dir.stops[2].id;
  const stop3Id = dir.stops[3].id;
  const stop4Id = dir.stops[4].id;

  const stop2Board = mataroSchedules.getDeparturesForStop('7', '11', stop2Id, 'saturday', 'winter');
  const stop3Board = mataroSchedules.getDeparturesForStop('7', '11', stop3Id, 'saturday', 'winter');
  const stop4Board = mataroSchedules.getDeparturesForStop('7', '11', stop4Id, 'saturday', 'winter');

  const passSec = shortTrip.stopSecs[2];
  const passH = Math.floor(passSec / 3600) % 24;
  const passM = Math.floor((passSec % 3600) / 60);
  const shortTripTimeStr = `${String(passH).padStart(2, '0')}:${String(passM).padStart(2, '0')}`;

  check(stop2Board.includes(shortTripTimeStr), `Short trip time ${shortTripTimeStr} appears on stop index 2 board`);
  check(!stop3Board.includes(shortTripTimeStr), `Short trip time ${shortTripTimeStr} does NOT appear on stop index 3 board`);
  check(!stop4Board.includes(shortTripTimeStr), `Short trip time ${shortTripTimeStr} does NOT appear on stop index 4 board`);
}

// ===========================================================================
// Test 4: Parser fixtures and midnight roll-over
// ===========================================================================
console.log('\n📌 Test 4: Parser fixtures and midnight roll-over');
{
  const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'mataro_schedules.json'), 'utf8'));

  const fixtures = [
    { file: 'hivern_L1.html', lineId: '1', season: 'winter' },
    { file: 'hivern_L3.html', lineId: '3', season: 'winter' },
    { file: 'hivern_L7.html', lineId: '7', season: 'winter' },
    { file: 'estiu_L7.html', lineId: '7', season: 'summer' }
  ];

  for (const fx of fixtures) {
    const htmlPath = path.join(__dirname, 'fixtures', 'maresme', fx.file);
    const html = fs.readFileSync(htmlPath, 'latin1');
    const notes = [];
    const built = S.buildSeason(html, legacy[fx.lineId], fx.season, notes);
    check(!built.error, `Parser fixture ${fx.file} built without error: ${built.error}`);

    for (const dk of built.order) {
      const dir = built.data[dk];
      for (const day of ['weekday', 'saturday', 'sunday']) {
        const trips = dir.dayTrips[day];
        check(Array.isArray(trips) && trips.length > 0, `${fx.file} d${dk} ${day} has dayTrips`);

        for (const trip of trips) {
          eq(trip.s.length, dir.stops.length, `Trip s.length matches stops.length in ${fx.file} d${dk} ${day}`);
          // Assert every trip's s is non-decreasing
          let prev = null;
          let nonDecreasing = true;
          for (const sec of trip.s) {
            if (sec === null) continue;
            if (prev !== null && sec < prev) {
              nonDecreasing = false;
              break;
            }
            prev = sec;
          }
          check(nonDecreasing, `Trip times strictly non-decreasing in ${fx.file} d${dk} ${day}`);
        }
      }
    }
  }

  // Midnight roll-over synthetic check: 23:58 -> 00:03 -> 86580
  const syntheticHtml = [
    '<td colspan="2" class="tc"><select name="s00"></select></td><td colspan="4">Origin</td>',
    '<tr><select name="s00"></select><td class="nl">Origin</td>',
    '<select name="s01"></select><td class="nl">Next</td></tr>',
    '<tr><select name="s02"></select><td class="nl">Other</td></tr>',
    '<script>',
    's00a = new Array(\'23:58\');',
    's01a = new Array(\'00:03\');',
    's02a = new Array(\'00:10\');',
    '</script>'
  ].join('\n');

  const mockLine = {
    lineId: '99',
    code: '99',
    lineName: 'Mock',
    color: '#000',
    directions: {
      '11': {
        originStop: { id: 9001, name: 'Origin' },
        stops: [{ id: 9001, name: 'Origin' }, { id: 9002, name: 'Next' }]
      },
      '12': {
        originStop: { id: 9003, name: 'Other' },
        stops: [{ id: 9003, name: 'Other' }]
      }
    }
  };

  const synthNotes = [];
  const synthBuilt = S.buildSeason(syntheticHtml, mockLine, 'winter', synthNotes);
  check(!synthBuilt.error, `Synthetic rollover built without error: ${synthBuilt.error}`);
  if (synthBuilt.data && synthBuilt.data['11']) {
    const synthTrips = synthBuilt.data['11'].dayTrips.weekday;
    check(synthTrips && synthTrips.length === 1, 'Synthetic trip exists');
    eq(synthTrips[0].s[0], 86280, '23:58 converted to 86280');
    eq(synthTrips[0].s[1], 86580, '00:03 rolled over midnight to 86580');
  }
}

// ===========================================================================
// Test 5: Consistency across all lines/directions/days
// ===========================================================================
console.log('\n📌 Test 5: Consistency of schedules[day] vs dayTrips[day]');
{
  const seasonsData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'mataro_schedules.seasons.json'), 'utf8')).seasons;
  let checksDone = 0;

  for (const season of ['winter', 'summer']) {
    for (let L = 1; L <= 8; L++) {
      const line = seasonsData[season][String(L)];
      for (const dk of Object.keys(line.directions)) {
        const dir = line.directions[dk];
        for (const day of ['weekday', 'saturday', 'sunday']) {
          const originTrips = dir.dayTrips[day].filter(t => t.s[0] !== null);
          const originTimes = originTrips.map(t => {
            const passSec = ((t.s[0] % 86400) + 86400) % 86400;
            const passH = Math.floor(passSec / 3600);
            const passM = Math.floor((passSec % 3600) / 60);
            return `${String(passH).padStart(2, '0')}:${String(passM).padStart(2, '0')}`;
          });
          const schedTimes = dir.schedules[day];
          eq(originTimes.length, schedTimes.length, `${season} L${L} d${dk} ${day} count matches`);
          check(originTimes.every((t, idx) => t === schedTimes[idx]), `${season} L${L} d${dk} ${day} times match schedules[day] exactly`);
          checksDone++;
        }
      }
    }
  }
  console.log(`  ✓ Checked ${checksDone} direction-day configurations for consistency.`);
}

// ===========================================================================
// Test 6: Exactness across shipped file
// ===========================================================================
console.log('\n📌 Test 6: Exactness of getDeparturesForStop against dayTrips');
{
  const seasonsData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'data', 'mataro_schedules.seasons.json'), 'utf8')).seasons;
  let exactChecks = 0;

  for (const season of ['winter', 'summer']) {
    for (let L = 1; L <= 8; L++) {
      const line = seasonsData[season][String(L)];
      for (const dk of Object.keys(line.directions)) {
        const dir = line.directions[dk];
        for (const day of ['weekday', 'saturday', 'sunday']) {
          const trips = dir.dayTrips[day];
          for (let stopIdx = 0; stopIdx < dir.stops.length; stopIdx++) {
            const stopId = dir.stops[stopIdx].id;
            const departures = mataroSchedules.getDeparturesForStop(L, dk, stopId, day, season);

            for (const trip of trips) {
              const sec = trip.s[stopIdx];
              if (sec === null) continue;
              const passSec = ((sec % 86400) + 86400) % 86400;
              const passH = Math.floor(passSec / 3600);
              const passM = Math.floor((passSec % 3600) / 60);
              const expectedTime = `${String(passH).padStart(2, '0')}:${String(passM).padStart(2, '0')}`;
              check(departures.includes(expectedTime), `${season} L${L} d${dk} ${day} stop ${stopId} includes ${expectedTime}`);
              exactChecks++;
            }
          }
        }
      }
    }
  }
  console.log(`  ✓ Verified ${exactChecks} stop passing times for exactness.`);
}

console.log('\n=========================================================================');
if (failed.length === 0) {
  console.log(`🎉 ALL ${passed} PER-TRIP TIMETABLE TESTS PASSED PERFECTLY! 🎉`);
  process.exit(0);
} else {
  console.error(`💥 ${failed.length} TEST(S) FAILED OUT OF ${passed + failed.length}:`);
  failed.forEach(f => console.error(`  - ${f}`));
  process.exit(1);
}
