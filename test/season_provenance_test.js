/**
 * season_provenance_test.js
 *
 * THE REGRESSION TEST FOR THE DEFECT ACTUALLY FOUND.
 *
 * `src/data/mataro_schedules.json` shipped a MIXTURE of the winter and summer
 * grids with no season dimension anywhere. On L1, L2, L4, L6 and L8 direction
 * 11 held the winter grid while direction 12 held the summer one, so a rider
 * got correct times one way and wrong times back. L3 held summer in both
 * directions. Nothing in the codebase could detect this, because there was no
 * season to be inconsistent with.
 *
 * Every assertion below fails on the old file and passes on a grid that is
 * internally consistent. If a future scrape ever produces a mixed file again,
 * these turn red instead of shipping quietly.
 */

'use strict';

const mataroSchedules = require('../src/data/mataroSchedules');
const seasonCalendar = require('../src/data/seasonCalendar');

const LINES = ['1', '2', '3', '4', '5', '6', '7', '8'];
const DAYS = ['weekday', 'saturday', 'sunday'];
const SEASONS = ['winter', 'summer'];

let passed = 0;
const failed = [];

function check(cond, msg) {
  if (cond) { passed++; return; }
  failed.push(msg);
}

function eq(actual, expected, msg) {
  check(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

/** Departure sequence for a direction, or [] when the grid is absent. */
function departures(lineId, direction, day, season) {
  const d = mataroSchedules.getDirectionSchedule(lineId, direction, day, season);
  return d && Array.isArray(d.departures) ? d.departures.slice() : [];
}

const same = (a, b) => a.length === b.length && a.every((t, i) => t === b[i]);

function provenanceOf(lineId, direction, day) {
  const ours = departures(lineId, direction, day);
  const winter = departures(lineId, direction, day, 'winter');
  const summer = departures(lineId, direction, day, 'summer');
  if (same(ours, winter) && same(ours, summer)) return 'both';
  if (same(ours, winter)) return 'winter';
  if (same(ours, summer)) return 'summer';
  return 'neither';
}

// ---------------------------------------------------------------------------
console.log('--- Season Provenance Tests ---');
console.log('   (grid consistency — the mixed-season regression guard)\n');

// ===========================================================================
console.log('📌 Test 1: The default grid is a real season, never a mixture');
// ===========================================================================
{
  const mixed = [];
  const unclassified = [];
  let checked = 0;

  for (const lineId of LINES) {
    for (const direction of ['0', '1']) {
      for (const day of DAYS) {
        const tag = provenanceOf(lineId, direction, day);
        checked++;
        if (tag === 'neither') unclassified.push(`L${lineId} dir${direction} ${day}`);
      }
    }
  }

  check(unclassified.length === 0,
    `Every shipped grid must match a published season exactly; these matched neither: ${unclassified.join(', ')}`);

  // The real bug: a LINE whose two directions come from different seasons.
  // Weekend grids are legitimately identical in both seasons, so 'both' is not
  // a mixture. A line is only mixed when one direction says 'winter' and the
  // other says 'summer'.
  for (const lineId of LINES) {
    for (const day of DAYS) {
      const tags = ['0', '1'].map((d) => provenanceOf(lineId, d, day));
      if (tags.includes('winter') && tags.includes('summer')) {
        mixed.push(`L${lineId} ${day} (dir0=${tags[0]}, dir1=${tags[1]})`);
      }
    }
  }

  check(mixed.length === 0,
    `No line may be winter in one direction and summer in the other; mixed: ${mixed.join(', ')}`);

  console.log(`  ✓ Test 1 Passed: ${checked} grids checked, ${mixed.length} mixed, ${unclassified.length} unclassified.`);
}

// ===========================================================================
console.log('\n📌 Test 2: Both directions of a line share one grid for today');
// ===========================================================================
{
  // The user-visible symptom: L1 dir11 said 05:25 (winter) and dir12 said 05:33
  // (summer). Whatever the active season, the two directions must be answered
  // from the same file.
  const active = mataroSchedules.getActiveSeason();
  const problems = [];

  for (const lineId of LINES) {
    for (const day of DAYS) {
      for (const direction of ['0', '1']) {
        // Compare each direction's default read against that SAME direction
        // asked for by name. A line's two directions are different journeys
        // with different times, so the expectation is per direction.
        const want = departures(lineId, direction, day, active.season);
        if (!same(departures(lineId, direction, day), want)) {
          problems.push(`L${lineId} dir${direction} ${day}`);
        }
      }
    }
  }

  check(problems.length === 0,
    `With no season argument, both directions must return the ${active.season} grid; mismatched: ${problems.join(', ')}`);

  console.log(`  ✓ Test 2 Passed: default reads resolve to the ${active.season} grid on every line.`);
}

// ===========================================================================
console.log('\n📌 Test 3: The two seasons really do differ (the guard has teeth)');
// ===========================================================================
{
  // If the seasons were byte-identical everywhere, Test 1 would pass vacuously.
  // Weekends are season-invariant on this operator; weekdays are not.
  let differing = 0;
  for (const lineId of LINES) {
    for (const direction of ['0', '1']) {
      const w = departures(lineId, direction, 'weekday', 'winter');
      const s = departures(lineId, direction, 'weekday', 'summer');
      if (w.length && s.length && !same(w, s)) differing++;
    }
  }
  check(differing > 0,
    'Winter and summer weekday grids must actually differ somewhere, or the mixed-season guard is vacuous');
  console.log(`  ✓ Test 3 Passed: ${differing} direction-grids genuinely differ between seasons.`);
}

// ===========================================================================
console.log('\n📌 Test 4: A request for an unknown season is refused, not substituted');
// ===========================================================================
{
  // Silently returning the winter grid for a request that explicitly asked for
  // something else is exactly the class of bug this work is fixing.
  const problems = [];
  for (const lineId of LINES) {
    for (const direction of ['0', '1']) {
      for (const day of DAYS) {
        const asked = departures(lineId, direction, day, 'christmas');
        if (asked.length) problems.push(`L${lineId} dir${direction} ${day}`);
      }
    }
  }
  check(problems.length === 0,
    `An unknown season must return nothing rather than a substitute grid; these returned data: ${problems.join(', ')}`);

  eq(mataroSchedules.normalizeSeason('HIVERN'), 'winter', 'Season names are matched case-insensitively');
  eq(mataroSchedules.normalizeSeason('estiu'), 'summer', 'The Catalan season name is accepted');
  eq(mataroSchedules.normalizeSeason('verano'), 'summer', 'The Spanish season name is accepted');
  eq(mataroSchedules.normalizeSeason('christmas'), null, 'An unrecognised season normalises to null');
  eq(mataroSchedules.normalizeSeason(undefined), mataroSchedules.getActiveSeason().season,
    'A missing season means the active one, not null');
  eq(mataroSchedules.normalizeSeason(''), mataroSchedules.getActiveSeason().season,
    'An empty season means the active one');

  console.log('  ✓ Test 4 Passed: unknown seasons return nothing instead of a substitute.');
}

// ===========================================================================
console.log('\n📌 Test 5: Published stop offsets are monotonic and authoritative');
// ===========================================================================
{
  // A bus cannot arrive at stop N+1 before it left stop N. This is the
  // invariant a misaligned column block would break while still producing
  // plausible-looking times, and it is what the scraper checks when it builds
  // the file.
  const violations = [];
  let checked = 0;

  for (const season of SEASONS) {
    for (const lineId of LINES) {
      for (const direction of ['0', '1']) {
        for (const day of DAYS) {
          const d = mataroSchedules.getDirectionSchedule(lineId, direction, day, season);
          if (!d || !Array.isArray(d.stops) || !d.stopTravelSecMap) continue;
          let prev = -1;
          for (const stop of d.stops) {
            const v = d.stopTravelSecMap[String(stop.id)];
            if (v === undefined || v === null) continue;
            checked++;
            if (v < prev) {
              violations.push(`${season} L${lineId} dir${direction} ${day} stop ${stop.id} (${prev}s -> ${v}s)`);
            }
            prev = v;
          }
        }
      }
    }
  }

  check(checked > 0, 'The offset monotonicity check must actually inspect stops');
  check(violations.length === 0,
    `Cumulative stop offsets must never decrease; violations: ${violations.slice(0, 8).join('; ')}`);

  console.log(`  ✓ Test 5 Passed: ${checked} offsets checked across both seasons, none decreasing.`);
}

// ===========================================================================
console.log('\n📌 Test 6: Both seasons carry a complete grid for every line');
// ===========================================================================
{
  const missing = [];
  for (const season of SEASONS) {
    for (const lineId of LINES) {
      for (const direction of ['0', '1']) {
        for (const day of DAYS) {
          if (!departures(lineId, direction, day, season).length) {
            missing.push(`${season} L${lineId} dir${direction} ${day}`);
          }
        }
      }
    }
  }
  check(missing.length === 0,
    `Both seasons must cover every line, direction and day type; missing: ${missing.join(', ')}`);

  // The provenance must survive all the way to the resolution the app reports.
  const res = seasonCalendar.resolveSeason();
  check(typeof res.source === 'string' && res.source.length > 0,
    'The resolver must always report where its answer came from');

  console.log('  ✓ Test 6 Passed: both seasons are complete and provenance is always reported.');
}

// ---------------------------------------------------------------------------
console.log('\n=====================================================');
console.log(`Passed: ${passed}, Failed: ${failed.length}`);
if (failed.length) {
  console.error('\n🔴 FAILURES:');
  failed.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log('\n🎉 ALL SEASON PROVENANCE TESTS PASSED!\n');
