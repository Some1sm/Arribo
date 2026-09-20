/**
 * test/avanza_full_network_timetable_test.js
 * 
 * Verifies full network schedule calibration across all 8 Mataró urban lines (L1–L8),
 * 153 indexed stops, and 3 day types (weekday, Saturday, Sunday/holiday).
 */

const assert = require('node:assert');
const mataroSchedules = require('../src/data/mataroSchedules');
const rawSchedules = require('../src/data/mataro_schedules.json');

console.log('--- Starting Full Network Avanza Timetable Calibration Test ---');

// 1. Validate All 8 Lines Exist and Have Full Day-Type Coverage
console.log('📌 Test 1: Network Catalog & Day-Type Schedule Completeness (Lines 1–8)...');
const lines = ['1', '2', '3', '4', '5', '6', '7', '8'];

for (const lineId of lines) {
  const lineObj = rawSchedules[lineId];
  assert(lineObj, `Line ${lineId} must exist in schedules`);
  assert(lineObj.directions, `Line ${lineId} must have directions`);

  for (const [dirKey, dir] of Object.entries(lineObj.directions)) {
    // Check departures for all 3 day types
    assert(Array.isArray(dir.schedules.Feiners) && dir.schedules.Feiners.length > 0,
      `Line ${lineId} Dir ${dirKey} must have Feiners departures`);
    assert(Array.isArray(dir.schedules.Dissabtes) && dir.schedules.Dissabtes.length > 0,
      `Line ${lineId} Dir ${dirKey} must have Dissabtes departures`);
    assert(Array.isArray(dir.schedules['Diumenges i Festius']) && dir.schedules['Diumenges i Festius'].length > 0,
      `Line ${lineId} Dir ${dirKey} must have Diumenges i Festius departures`);

    // Check dayStopTravelSec coverage
    assert(dir.dayStopTravelSec, `Line ${lineId} Dir ${dirKey} must have dayStopTravelSec`);
    assert(dir.dayStopTravelSec.weekday, `Line ${lineId} Dir ${dirKey} must have weekday stop travel times`);
    assert(dir.dayStopTravelSec.saturday, `Line ${lineId} Dir ${dirKey} must have saturday stop travel times`);
    assert(dir.dayStopTravelSec.sunday, `Line ${lineId} Dir ${dirKey} must have sunday stop travel times`);

    // Check dayTravelSec
    assert(dir.dayTravelSec, `Line ${lineId} Dir ${dirKey} must have dayTravelSec`);
    assert(dir.dayTravelSec.weekday > 0, `Line ${lineId} Dir ${dirKey} weekday travel sec must be > 0`);
    assert(dir.dayTravelSec.saturday > 0, `Line ${lineId} Dir ${dirKey} saturday travel sec must be > 0`);
    assert(dir.dayTravelSec.sunday > 0, `Line ${lineId} Dir ${dirKey} sunday travel sec must be > 0`);

    // Check stops
    for (const stop of (dir.stops || [])) {
      const sId = String(stop.id);
      assert(dir.dayStopTravelSec.weekday[sId] !== undefined,
        `Line ${lineId} Dir ${dirKey} Stop ${sId} (${stop.name}) missing weekday travel time`);
      assert(dir.dayStopTravelSec.saturday[sId] !== undefined,
        `Line ${lineId} Dir ${dirKey} Stop ${sId} (${stop.name}) missing saturday travel time`);
      assert(dir.dayStopTravelSec.sunday[sId] !== undefined,
        `Line ${lineId} Dir ${dirKey} Stop ${sId} (${stop.name}) missing sunday travel time`);
    }
  }
}
console.log('  ✓ Test 1 Passed: Complete schedule coverage across all 8 lines, directions, and day types.\n');

// 2. Validate Stop Passing Times Helper & Day-Type Specificity
console.log('📌 Test 2: Helper API (getStopTravelTime & getDeparturesForStop) Verification...');
{
  // Stop 1015 (El Cargol) on Line 1 Dir 12
  const wkTravel = mataroSchedules.getStopTravelTime('1', '12', '1015', 'weekday');
  const satTravel = mataroSchedules.getStopTravelTime('1', '12', '1015', 'saturday');
  const sunTravel = mataroSchedules.getStopTravelTime('1', '12', '1015', 'sunday');

  assert(wkTravel > 1000 && wkTravel < 1800, `Stop 1015 weekday travel (${wkTravel}s) must be realistic`);
  assert(satTravel > 1000 && satTravel < 1800, `Stop 1015 saturday travel (${satTravel}s) must be realistic`);
  assert(sunTravel > 1000 && sunTravel < 1800, `Stop 1015 sunday travel (${sunTravel}s) must be realistic`);

  // Origin stop (1001) must always be 0s
  const originTravelWk = mataroSchedules.getStopTravelTime('1', '12', '1001', 'weekday');
  assert.strictEqual(originTravelWk, 0, 'Origin stop travel time must be 0s');

  // Passing departures format check
  const stopDepartures = mataroSchedules.getDeparturesForStop('1', '12', '1015', 'weekday');
  assert(Array.isArray(stopDepartures) && stopDepartures.length > 50, 'Stop departures must contain trips');
  for (const dep of stopDepartures) {
    assert(/^\d{2}:\d{2}$/.test(dep), `Departure time ${dep} must match HH:MM`);
  }

  // Stop 1134 (Euskadi) on Line 2 Dir 11
  const travel1134Wk = mataroSchedules.getStopTravelTime('2', '11', '1134', 'weekday');
  const travel1134Sun = mataroSchedules.getStopTravelTime('2', '11', '1134', 'sunday');
  assert.strictEqual(travel1134Wk, 480, 'Stop 1134 weekday travel must be 480s (8 min from Hospital)');
  assert.strictEqual(travel1134Sun, 420, 'Stop 1134 sunday travel must be 420s (7 min from Hospital)');
}
console.log('  ✓ Test 2 Passed: Day-type travel time differentiation verified.\n');

// 3. Validate Fleet Invariant Maintenance
console.log('📌 Test 3: Fleet Requirement Invariants Preserved...');
{
  const l1Weekday = mataroSchedules.getScheduledFleetRequirement('1', 'weekday', 59400); // 16:30
  const l1SatNoon = mataroSchedules.getScheduledFleetRequirement('1', 'saturday', 47164); // 13:06
  const l1Night = mataroSchedules.getScheduledFleetRequirement('1', 'weekday', 10800); // 03:00
  
  assert.strictEqual(l1Weekday, 5, 'Line 1 weekday peak dynamically calculated as 5 vehicles');
  assert.strictEqual(l1SatNoon, 3, 'Line 1 Saturday dynamically calculated as 3 vehicles');
  assert.strictEqual(l1Night, 0, 'Line 1 off-hours dynamically calculated as 0 vehicles');

  const l8SunMorning = mataroSchedules.getScheduledFleetRequirement('8', 'sunday', 36000); // 10:00
  const l8SunAfternoon = mataroSchedules.getScheduledFleetRequirement('8', 'sunday', 61200); // 17:00
  assert.strictEqual(l8SunMorning, 0, 'Line 8 Sunday morning dynamically calculated as 0 vehicles');
  assert.strictEqual(l8SunAfternoon, 1, 'Line 8 Sunday afternoon dynamically calculated as 1 vehicle');
}
console.log('  ✓ Test 3 Passed: Dynamic fleet requirement calculations intact.\n');

console.log('=================================================================');
console.log('🎉 ALL FULL NETWORK AVANZA TIMETABLE TESTS PASSED (3/3)!');
console.log('=================================================================\n');
