/**
 * test/trip_matcher_test.js
 *
 * Covers src/core/schedule/tripMatcher.js, which recovers the scheduled and
 * actual passing time of a vehicle from the static timetable.
 *
 * The invariant under test throughout: the matcher DERIVES, it never invents.
 * When no departure is close enough to believe, it must return matched:false
 * with empty times rather than a plausible-looking wrong answer.
 */

const tripMatcher = require('../src/core/schedule/tripMatcher');
const mataroSchedules = require('../src/data/mataroSchedules');
const timeEngine = require('../src/core/time/timeEngine');
const calendarEngine = require('../src/core/time/calendarEngine');

console.log('🧪 Starting Trip Matcher Test Suite...\n');

let passed = 0;
const failed = [];
const check = (cond, msg) => {
  if (cond) { passed++; console.log('  ✅', msg); }
  else { failed.push(msg); console.error('  ❌', msg); }
};

/** A Monday, a Wednesday and a Saturday in Sep 2026, at a Madrid wall-clock time. */
const at = (year, monthIdx, day, hour, minute) =>
  timeEngine.localTimeToUtcDate(year, monthIdx, day, hour, minute, 0).getTime();

const L5 = '5';
const DIR0 = '0';
const stopSeq = 5;
const dirSched = mataroSchedules.getDirectionSchedule(L5, DIR0, 'weekday');
const targetStop = dirSched.stops.find(s => Number(s.seq) === stopSeq);
const departures = mataroSchedules.getDeparturesForStop(L5, DIR0, targetStop.id, 'weekday');

console.log('--- 1. Day-type resolution ---');
{
  const wed = calendarEngine.getDateComponents(at(2026, 8, 23, 12, 0), 'Europe/Madrid');
  check(tripMatcher.resolveDayType(at(2026, 8, 23, 12, 0)).dayType === (wed.isSunday ? 'sunday' : (wed.isSaturday || (wed.isWeekday && wed.isAugust) ? 'saturday' : 'weekday')),
    'Day type matches calendarEngine for a mid-September Wednesday');
  check(tripMatcher.resolveDayType(at(2026, 7, 12, 12, 0)).dayType === 'saturday',
    'A weekday in August uses the reduced summer timetable bucket, not "weekday"');
  check(tripMatcher.resolveDayType(at(2026, 8, 20, 12, 0)).dayType === 'sunday',
    'Sunday resolves to the sunday bucket');
  check(tripMatcher.resolveDayType(at(2026, 8, 19, 12, 0)).dayType === 'saturday',
    'Saturday resolves to the saturday bucket');
}

console.log('\n--- 2. Stop name normalisation ---');
{
  check(tripMatcher.normalizeStopName('Pl. de Catalunya') === 'pl de catalunya',
    'Punctuation is stripped consistently');
  check(tripMatcher.normalizeStopName('  Plança   del  Centre ') === 'planca del centre',
    'Whitespace is collapsed and accents are stripped so accented spellings still match');
}

console.log('\n--- 3. Midnight wrap arithmetic ---');
{
  check(tripMatcher.circularDiffSec(5 * 60, 23 * 3600 + 50 * 60) / 60 === 15,
    '00:05 versus 23:50 is 15 minutes apart, not 23h45m');
  check(tripMatcher.circularDiffSec(60 * 60, 2 * 3600) === -3600,
    'Same-day differences are plain subtraction');
}

console.log('\n--- 4. A punctual bus is matched to its own departure ---');
{
  const first = departures[0];
  const [h, m] = first.split(':').map(Number);
  const r = tripMatcher.matchTrip({
    lineId: L5, direction: DIR0, toSeq: stopSeq, stopName: targetStop.name, delayMins: 0,
    at: at(2026, 8, 23, h, m)
  });
  check(r.matched === true, 'Match found for a bus on time');
  check(r.scheduledTime.slice(0, 5) === first, `Scheduled time is the timetable departure ${first} (got ${r.scheduledTime})`);
  check(r.actualTime.slice(0, 5) === first, 'Actual time equals scheduled when on time');
  check(r.residualMinutes === 0, 'Residual is zero for a clean match');
  check(r.stopId === String(targetStop.id), 'Stop resolved to the schedule stop id');
  check(r.dayType === 'weekday', 'Day type is recorded for audit');
}

console.log('\n--- 5. A late bus is matched to the departure it ran ---');
{
  const first = departures[0];
  const [h, m] = first.split(':').map(Number);
  const r = tripMatcher.matchTrip({
    lineId: L5, direction: DIR0, toSeq: stopSeq, stopName: targetStop.name, delayMins: 7,
    at: at(2026, 8, 23, h, m + 7)
  });
  check(r.matched === true, 'Match found for a 7-minute-late bus');
  check(r.scheduledTime.slice(0, 5) === first, 'Scheduled time is still the original departure');
  check(r.actualTime.slice(0, 5) === timeEngine.minutesToTimeString(h * 60 + m + 7),
    'Actual time is scheduled plus the observed delay');
}

console.log('\n--- 6. Stop resolution falls back from seq to name ---');
{
  const byName = tripMatcher.matchTrip({
    lineId: L5, direction: DIR0, toSeq: undefined, stopName: targetStop.name, delayMins: 0,
    at: at(2026, 8, 23, Number(departures[1].split(':')[0]), Number(departures[1].split(':')[1]))
  });
  check(byName.matched === true, 'Stop resolved by name when no sequence number is supplied');
  check(byName.stopId === String(targetStop.id), 'Name lookup yields the same schedule stop');

  const noStop = tripMatcher.matchTrip({
    lineId: L5, direction: DIR0, toSeq: 9999, stopName: 'Parada Inexistents', delayMins: 0,
    at: at(2026, 8, 23, 8, 0)
  });
  check(noStop.matched === false, 'An unknown stop is reported unmatched');
  check(noStop.scheduledTime === '' && noStop.actualTime === '', 'An unmatched row carries no times at all');
  check(noStop.reason === 'next stop not found in schedule', 'The failure reason is specific');
}

console.log('\n--- 7. Bad input is refused rather than guessed ---');
{
  check(tripMatcher.matchTrip({ delayMins: 0, at: Date.now() }).matched === false, 'Missing lineId is refused');
  check(tripMatcher.matchTrip({ lineId: L5, direction: DIR0, at: 0 }).matched === false, 'Missing timestamp is refused');
  check(tripMatcher.matchTrip({ lineId: L5, direction: DIR0, at: undefined }).matched === false, 'Undefined timestamp is refused');
  const badLine = tripMatcher.matchTrip({ lineId: 'ZZ', direction: DIR0, toSeq: 1, stopName: 'x', delayMins: 0, at: Date.now() });
  check(badLine.matched === false, 'An unknown line is refused');
  check(badLine.scheduledTime === '' && badLine.actualTime === '', 'A refused match returns empty times');
}

console.log('\n--- 8. Tolerances are bounded and reported ---');
{
  // Away from service, no departure should be close enough to trust.
  const night = tripMatcher.matchTrip({
    lineId: L5, direction: DIR0, toSeq: stopSeq, stopName: targetStop.name, delayMins: 0,
    at: at(2026, 8, 23, 3, 0)
  });
  check(night.matched === false || night.residualMinutes <= tripMatcher.MAX_RESIDUAL_MINUTES,
    'An out-of-service observation never returns an over-tolerance match');
  check(typeof tripMatcher.MAX_RESIDUAL_MINUTES === 'number' && tripMatcher.MAX_RESIDUAL_MINUTES > 0,
    'The residual tolerance is a positive number of minutes');
}

console.log('\n=====================================================');
console.log(`Passed: ${passed}, Failed: ${failed.length}`);
if (failed.length) {
  console.error('\n🔴 FAILURES:');
  failed.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log('\n🎉 ALL TRIP MATCHER TESTS PASSED!\n');
