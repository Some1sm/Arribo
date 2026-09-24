/**
 * season_calendar_test.js
 *
 * Verifies src/data/seasonCalendar.js: which of the two published Mataró Bus
 * timetables is in force on a given date, and — just as important — when the
 * module refuses to claim to know.
 *
 * The contract being defended:
 *   1. Window bounds are inclusive, as the operator states them
 *      ("Del 27 de juliol fins al 23 d'agost").
 *   2. Dates are compared as calendar dates in Europe/Madrid, never as
 *      instants, so DST cannot move a boundary.
 *   3. A live operator notice outranks static config, but only when it is
 *      unambiguous.
 *   4. Outside the period we hold data for, the answer is winter with
 *      `known: false` — the caller is told to doubt it rather than handed a
 *      confident answer. (Project rule: missing data is never a default.)
 */

'use strict';

const seasonCalendar = require('../src/data/seasonCalendar');
const mataroSchedules = require('../src/data/mataroSchedules');

let passed = 0;
const failed = [];

function check(cond, msg) {
  if (cond) { passed++; return; }
  failed.push(msg);
}

function eq(actual, expected, msg) {
  check(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ---------------------------------------------------------------------------
console.log('--- Season Calendar Tests ---');

// ===========================================================================
console.log('\n📌 Test 1: Config summer window boundaries are inclusive');
// ===========================================================================
{
  const w = seasonCalendar.SUMMER_WINDOWS[0];
  check(Array.isArray(seasonCalendar.SUMMER_WINDOWS) && seasonCalendar.SUMMER_WINDOWS.length > 0,
    'At least one summer window must be configured');
  eq(w.from, '2026-07-27', 'Summer window opens 2026-07-27');
  eq(w.to, '2026-08-23', 'Summer window closes 2026-08-23');

  // Both endpoints must be INSIDE the window, matching how the operator words it.
  eq(seasonCalendar.resolveSeason('2026-07-27T10:00:00+02:00').season, 'summer',
    'First day of the summer window is inclusive');
  eq(seasonCalendar.resolveSeason('2026-08-23T23:00:00+02:00').season, 'summer',
    'Last day of the summer window is inclusive');

  // One day either side must fall back to the default grid.
  eq(seasonCalendar.resolveSeason('2026-07-26T23:59:00+02:00').season, 'winter',
    'The day before the summer window is not summer');
  eq(seasonCalendar.resolveSeason('2026-08-24T00:00:00+02:00').season, 'winter',
    'The day after the summer window is not summer');

  // A date inside the window is reported with provenance, not as a bare value.
  const inside = seasonCalendar.resolveSeason('2026-08-01T12:00:00+02:00');
  eq(inside.season, 'summer', '2026-08-01 is inside the summer window');
  eq(inside.known, true, 'A configured window is known data');
  check(typeof inside.source === 'string' && inside.source.length > 0,
    'A resolved season must carry provenance');
  check(inside.window && inside.window.from === '2026-07-27',
    'The matched window must be reported alongside the season');

  console.log('  ✓ Test 1 Passed: window bounds inclusive, provenance attached.');
}

// ===========================================================================
console.log('\n📌 Test 2: Outside coverage, the season is winter but NOT asserted as known');
// ===========================================================================
{
  // Before DATA_KNOWN_FROM we have no grid at all. resolveSeason still returns
  // a season so callers can proceed, but `known: false` is the honest answer.
  const before = seasonCalendar.resolveSeason('2025-06-01T12:00:00+02:00');
  eq(before.season, 'winter', 'A date before our data window defaults to winter');
  eq(before.known, false, 'A date before DATA_KNOWN_FROM must NOT be reported as known');
  eq(seasonCalendar.DATA_KNOWN_FROM, '2026-01-01', 'DATA_KNOWN_FROM is 2026-01-01');

  // The boundary itself is inside coverage.
  eq(seasonCalendar.resolveSeason('2026-01-01T00:30:00+01:00').known, true,
    'The first covered date is known');

  // Today, and any ordinary weekday outside the summer window.
  const winter = seasonCalendar.resolveSeason('2026-09-24T08:00:00+02:00');
  eq(winter.season, 'winter', '2026-09-24 is winter');
  eq(winter.known, true, '2026-09-24 is inside our coverage');
  eq(winter.window, null, 'A default resolution has no matched window');

  // A default resolution must still explain itself.
  check(typeof winter.source === 'string' && winter.source.length > 0,
    'Even the default resolution must carry a reason string');

  console.log('  ✓ Test 2 Passed: unknown coverage is labelled, not asserted.');
}

// ===========================================================================
console.log('\n📌 Test 3: A live operator notice outranks static config');
// ===========================================================================
{
  const saved = seasonCalendar._noticeWindows.slice();
  seasonCalendar.clearNoticeWindows();

  try {
    eq(seasonCalendar.SEASON_PRECEDENCE, 'notice', 'Notice precedence is the shipped policy');

    // The operator's own statement about a window our config does not know.
    const isNew = seasonCalendar.registerWindow({
      from: '2026-12-23', to: '2027-01-03', season: 'winter', title: 'HORARIS NADAL 2026'
    });
    eq(isNew, true, 'A new window registers');

    const r = seasonCalendar.resolveSeason('2026-12-27T10:00:00+01:00');
    eq(r.season, 'winter', 'A notice can declare a window');
    eq(r.known, true, 'A notice-backed window is known data');
    check(r.source.includes('NADAL'), `The notice's own title must be the provenance (got "${r.source}")`);

    // Re-registering the same window on the next 5-minute poll is a no-op, not
    // a duplicate. This path runs on every poll, so it has to be idempotent.
    const again = seasonCalendar.registerWindow({
      from: '2026-12-23', to: '2027-01-03', season: 'winter', title: 'HORARIS NADAL 2026'
    });
    eq(again, false, 'Re-registering an identical window returns false');
    eq(seasonCalendar._noticeWindows.length, 1, 'No duplicate window is appended');

    // Garbage in must not become a window.
    eq(seasonCalendar.registerWindow(null), false, 'null is rejected');
    eq(seasonCalendar.registerWindow({ from: '2026-01-01', to: '2026-01-02', season: 'autumn' }), false,
      'An unknown season name is rejected');
    eq(seasonCalendar.registerWindow({ from: '2026-01-01' }), false, 'A window without `to` is rejected');
    eq(seasonCalendar._noticeWindows.length, 1, 'Rejected input adds nothing');

    console.log('  ✓ Test 3 Passed: notice precedence, idempotency and input validation.');
  } finally {
    seasonCalendar.clearNoticeWindows();
    saved.forEach((w) => seasonCalendar.registerWindow(w));
  }
}

// ===========================================================================
console.log('\n📌 Test 4: Ambiguous or contradictory notices are reported, not guessed');
// ===========================================================================
{
  seasonCalendar.clearNoticeWindows();
  try {
    // Two overlapping summer windows: a data problem. Picking one would be a
    // silent guess about which grid riders are actually held to.
    seasonCalendar.registerWindow({ from: '2027-07-01', to: '2027-08-15', season: 'summer', title: 'A' });
    seasonCalendar.registerWindow({ from: '2027-07-20', to: '2027-08-31', season: 'summer', title: 'B' });

    const r = seasonCalendar.resolveSeason('2027-07-25T12:00:00+02:00');
    eq(r.season, 'winter', 'Overlapping windows fall through to the default grid');
    eq(r.known, false, 'Overlapping windows must be reported as unknown');
    check(/ambiguous/i.test(r.source), `The doubt must be named in the source (got "${r.source}")`);

    // A date outside the overlap is unaffected by the ambiguity.
    const outside = seasonCalendar.resolveSeason('2027-08-20T12:00:00+02:00');
    eq(outside.season, 'summer', 'A single covering window still resolves normally');
    eq(outside.known, true, 'A single covering window is known');

    console.log('  ✓ Test 4 Passed: ambiguity is surfaced, never silently resolved.');
  } finally {
    seasonCalendar.clearNoticeWindows();
  }
}

// ===========================================================================
console.log('\n📌 Test 5: Date keys are Europe/Madrid calendar dates across DST');
// ===========================================================================
{
  eq(seasonCalendar.TIMEZONE, 'Europe/Madrid', 'Season dates are Europe/Madrid');

  // Madrid springs forward 2026-03-29 (02:00 -> 03:00) and falls back
  // 2026-10-25 (03:00 -> 02:00). A window boundary must land on the calendar
  // date the operator named, not drift by an hour of UTC offset.
  eq(seasonCalendar.madridDateKey(new Date('2026-03-28T23:30:00Z')), '2026-03-29',
    '23:30Z on 28 March is already 29 March in Madrid (spring-forward eve)');
  eq(seasonCalendar.madridDateKey(new Date('2026-10-24T22:30:00Z')), '2026-10-25',
    '22:30Z on 24 October is 25 October in Madrid (fall-back eve)');
  eq(seasonCalendar.madridDateKey(new Date('2026-10-25T22:30:00Z')), '2026-10-25',
    'The whole of the fall-back day is one calendar date in Madrid');

  // A summer window queried from two instants either side of a UTC midnight
  // must agree, because both are the same Madrid date.
  const a = seasonCalendar.resolveSeason('2026-07-27T00:30:00+02:00');
  const b = seasonCalendar.resolveSeason('2026-07-26T22:45:00Z'); // same instant-ish, 00:45 Madrid
  eq(a.season, 'summer', '00:30 local on 27 July is summer');
  eq(b.season, 'summer', 'The same Madrid date reached via UTC is also summer');

  console.log('  ✓ Test 5 Passed: boundaries are calendar dates and survive DST.');
}

// ===========================================================================
console.log('\n📌 Test 6: The loader consumes the calendar rather than re-deriving it');
// ===========================================================================
{
  // mataroSchedules must agree with seasonCalendar, and must expose which grid
  // it loaded and why. If these disagree, the app and its reporting diverge.
  const viaSchedules = mataroSchedules.getActiveSeason('2026-08-01T12:00:00+02:00');
  const viaCalendar = seasonCalendar.resolveSeason('2026-08-01T12:00:00+02:00');
  eq(viaSchedules.season, viaCalendar.season, 'getActiveSeason agrees with resolveSeason');
  eq(viaSchedules.known, viaCalendar.known, 'getActiveSeason agrees on known-ness');
  eq(viaSchedules.source, viaCalendar.source, 'getActiveSeason reports the same provenance');

  const validity = mataroSchedules.getScheduleValidity();
  eq(validity.season, mataroSchedules.getActiveSeason().season, 'Validity reports the active season');
  eq(typeof validity.seasonSource, 'string', 'Validity reports a season source');
  eq(typeof validity.seasonKnown, 'boolean', 'Validity reports season known-ness');
  check(Array.isArray(validity.seasonsAvailable) && validity.seasonsAvailable.includes('winter'),
    'Both seasons must be reported as available');
  check(Array.isArray(validity.seasonsAvailable) && validity.seasonsAvailable.includes('summer'),
    'The summer grid must be available, not just the active one');
  eq(validity.usingSeasonsFile, true, 'The seasons file is the active source');

  console.log('  ✓ Test 6 Passed: the loader and the calendar agree on season and provenance.');
}

// ---------------------------------------------------------------------------
console.log('\n=====================================================');
console.log(`Passed: ${passed}, Failed: ${failed.length}`);
if (failed.length) {
  console.error('\n🔴 FAILURES:');
  failed.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log('\n🎉 ALL SEASON CALENDAR TESTS PASSED!\n');
