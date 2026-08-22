/**
 * test/mataro_schedules_data_test.js
 * 
 * Verification Test Suite for Milestone 1 (Authoritative Timetable Data Ingestion):
 * - src/data/mataro_schedules.json schema & content validation
 * - src/data/mataroSchedules.js helper API validation
 * - Topography, cumulative run times, stop sequences, and non-synthetic departure counts
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const mataroSchedulesHelper = require('../src/data/mataroSchedules');
const rawSchedules = require('../src/data/mataro_schedules.json');

console.log('🧪 Running Mataró Bus Authoritative Schedules (M1) Test Suite...\n');

// 1. Root Keys & Basic Schema
console.log('1. Testing root keys and schema structure...');
const lineKeys = Object.keys(rawSchedules);
assert.strictEqual(lineKeys.length, 8, 'Expected exactly 8 Mataró urban lines');
assert.deepStrictEqual(lineKeys.sort(), ['1', '2', '3', '4', '5', '6', '7', '8']);
console.log('  ✓ 8 lines present: 1, 2, 3, 4, 5, 6, 7, 8');

// 2. Comprehensive Line & Direction Assertions
console.log('2. Testing per-line departure matrices, directions, and day types...');

const EXPECTED_STATS = {
  '1': {
    name: 'Circular',
    dirs: ['11', '12'],
    trips: {
      '11': { weekday: 76, saturday: 37, sunday: 25, firstWk: '05:25', lastWk: '22:35' },
      '12': { weekday: 67, saturday: 37, sunday: 25, firstWk: '06:03', lastWk: '22:05' }
    }
  },
  '2': {
    name: 'Circular',
    dirs: ['11', '12'],
    trips: {
      '11': { weekday: 77, saturday: 36, sunday: 26, firstWk: '05:25', lastWk: '22:19' },
      '12': { weekday: 65, saturday: 36, sunday: 26, firstWk: '05:28', lastWk: '22:24' }
    }
  },
  '3': {
    name: 'Camí de la Serra',
    dirs: ['11', '12'],
    trips: {
      '11': { weekday: 50, saturday: 35, sunday: 23, firstWk: '06:31', lastWk: '21:41' },
      '12': { weekday: 48, saturday: 36, sunday: 24, firstWk: '06:06', lastWk: '21:12' }
    }
  },
  '4': {
    name: 'Cirera',
    dirs: ['11', '12'],
    trips: {
      '11': { weekday: 26, saturday: 13, sunday: 14, firstWk: '07:38', lastWk: '22:07' },
      '12': { weekday: 13, saturday: 14, sunday: 13, firstWk: '07:45', lastWk: '20:45' }
    }
  },
  '5': {
    name: 'Hospital',
    dirs: ['11', '12'],
    trips: {
      '11': { weekday: 69, saturday: 51, sunday: 29, firstWk: '05:41', lastWk: '22:32' },
      '12': { weekday: 68, saturday: 50, sunday: 30, firstWk: '05:58', lastWk: '22:12' }
    }
  },
  '6': {
    name: 'Institut Català Salut',
    dirs: ['11', '12'],
    trips: {
      '11': { weekday: 64, saturday: 26, sunday: 12, firstWk: '06:00', lastWk: '21:47', firstSun: '14:00' },
      '12': { weekday: 40, saturday: 26, sunday: 12, firstWk: '06:51', lastWk: '21:53', firstSun: '14:17' }
    }
  },
  '7': {
    name: 'Pl. Tereses',
    dirs: ['11', '12'],
    trips: {
      '11': { weekday: 51, saturday: 37, sunday: 35, firstWk: '07:25', lastWk: '21:35' },
      '12': { weekday: 51, saturday: 37, sunday: 35, firstWk: '07:36', lastWk: '21:37' }
    }
  },
  '8': {
    name: 'Galícia',
    dirs: ['11', '12'],
    trips: {
      '11': { weekday: 43, saturday: 14, sunday: 7, firstWk: '06:05', lastWk: '22:11', firstSun: '14:45' },
      '12': { weekday: 27, saturday: 14, sunday: 8, firstWk: '06:23', lastWk: '21:22', firstSun: '14:04' }
    }
  }
};

for (const [lId, exp] of Object.entries(EXPECTED_STATS)) {
  const line = rawSchedules[lId];
  assert(line, `Line ${lId} must exist`);
  assert.strictEqual(line.lineId, lId);
  assert.strictEqual(line.agency, 'Mataró Bus');
  assert.strictEqual(line.operator, 'CTSA / Avanza');

  for (const pId of exp.dirs) {
    const dir = line.directions[pId];
    assert(dir, `Line ${lId} direction ${pId} must exist`);
    assert(Array.isArray(dir.stops), `Line ${lId} dir ${pId} must have stops array`);
    assert(dir.stops.length > 0, `Line ${lId} dir ${pId} must have >0 stops`);
    assert(dir.totalDistanceMeters > 0, `Line ${lId} dir ${pId} distance must be > 0`);
    assert(dir.totalTravelSec > 0, `Line ${lId} dir ${pId} travelSec must be > 0`);

    // Monotonic distance and runtime check
    for (let i = 1; i < dir.stops.length; i++) {
      assert(dir.stops[i].cumulativeMeters >= dir.stops[i - 1].cumulativeMeters, `Monotonic meters failed on L${lId} dir ${pId} stop ${i}`);
      assert(dir.stops[i].travelSec >= dir.stops[i - 1].travelSec, `Monotonic travelSec failed on L${lId} dir ${pId} stop ${i}`);
      assert.strictEqual(dir.stops[i].seq, i + 1);
    }

    // Schedule counts
    const expTrips = exp.trips[pId];
    assert.strictEqual(dir.schedules['Feiners'].length, expTrips.weekday, `L${lId} dir ${pId} weekday trip count mismatch`);
    assert.strictEqual(dir.schedules['Dissabtes'].length, expTrips.saturday, `L${lId} dir ${pId} saturday trip count mismatch`);
    assert.strictEqual(dir.schedules['Diumenges i Festius'].length, expTrips.sunday, `L${lId} dir ${pId} sunday trip count mismatch`);

    // First and last trip
    assert.strictEqual(dir.schedules['Feiners'][0], expTrips.firstWk, `L${lId} dir ${pId} first weekday departure mismatch`);
    assert.strictEqual(dir.schedules['Feiners'][dir.schedules['Feiners'].length - 1], expTrips.lastWk, `L${lId} dir ${pId} last weekday departure mismatch`);

    if (expTrips.firstSun) {
      assert.strictEqual(dir.schedules['Diumenges i Festius'][0], expTrips.firstSun, `L${lId} dir ${pId} Sunday start time mismatch`);
    }
  }
}
console.log('  ✓ All 8 lines, 16 directional paths, and day types validated with exact counts');

// 3. Line 8 & Line 6 Weekend Constraints
console.log('3. Testing Line 8 & Line 6 weekend afternoon-only schedule logic...');
const l8Dir12Sun = mataroSchedulesHelper.getDirectionSchedule('8', '12', 'sunday');
assert.strictEqual(l8Dir12Sun.tripsCount, 8);
assert.strictEqual(l8Dir12Sun.firstTrip, '14:04');
assert.strictEqual(l8Dir12Sun.lastTrip, '21:35');
assert.strictEqual(l8Dir12Sun.afternoonOnly, true);
assert.deepStrictEqual(l8Dir12Sun.departures, ['14:04', '15:08', '16:12', '17:16', '18:20', '19:26', '20:32', '21:35']);

const l6Dir11Sun = mataroSchedulesHelper.getDirectionSchedule('6', '0', 'sunday');
assert.strictEqual(l6Dir11Sun.tripsCount, 12);
assert.strictEqual(l6Dir11Sun.firstTrip, '14:00');
assert.strictEqual(l6Dir11Sun.lastTrip, '22:03');
assert.strictEqual(l6Dir11Sun.afternoonOnly, true);
console.log('  ✓ Line 8 and Line 6 afternoon-only weekend logic verified');

// 4. Helper Function Tests
console.log('4. Testing mataroSchedules helper methods...');

// 4.1 normalizeLineId
assert.strictEqual(mataroSchedulesHelper.normalizeLineId('mataro_8'), '8');
assert.strictEqual(mataroSchedulesHelper.normalizeLineId('L1'), '1');
assert.strictEqual(mataroSchedulesHelper.normalizeLineId(5), '5');

// 4.2 normalizeDayType
assert.strictEqual(mataroSchedulesHelper.normalizeDayType('Dissabtes'), 'saturday');
assert.strictEqual(mataroSchedulesHelper.normalizeDayType('Diumenges i Festius'), 'sunday');
assert.strictEqual(mataroSchedulesHelper.normalizeDayType('Feiners'), 'weekday');

// 4.3 getStopTravelTime
const l1StopTravel = mataroSchedulesHelper.getStopTravelTime('1', '11', '1001'); // Terminal Hospital
assert(l1StopTravel > 1500, `Hospital on L1 should be ~1800s (got: ${l1StopTravel})`);

const l1OriginTravel = mataroSchedulesHelper.getStopTravelTime('1', '11', '1016'); // Origin Rodalies
assert.strictEqual(l1OriginTravel, 0);

// 4.4 getDeparturesForStop
const l1HospitalDeps = mataroSchedulesHelper.getDeparturesForStop('1', '11', '1001', 'weekday');
assert.strictEqual(l1HospitalDeps.length, 76);
// Origin departs 05:25 + 1811s (30m 11s) -> 05:55
assert.strictEqual(l1HospitalDeps[0], '05:55');

// 4.5 getAllLines
const allLines = mataroSchedulesHelper.getAllLines();
assert.strictEqual(allLines.length, 8);
assert(allLines.every(l => l.directions.length >= 2));
console.log('  ✓ Helper functions (getLineSchedule, getDirectionSchedule, getStopTravelTime, getDeparturesForStop, getAllLines) passed');

console.log('\n🎉 ALL MATARÓ SCHEDULES DATA INGESTION CHECKS PASSED PERFECTLY! 🎉');
