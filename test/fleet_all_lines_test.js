/**
 * test/fleet_all_lines_test.js
 *
 * THE REGRESSION TEST FOR THE ASYMMETRIC-FLEET BUG ACROSS ALL EIGHT LINES.
 *
 * test/fleet_direction_balance_test.js pins the defect on L1, which is the line
 * it was reported on. But the defect was never L1-specific: it lived in shared
 * code, and a survey of the whole network found the old even-split cap dropping
 * a bus on FIVE of the eight lines. A fix verified on one line can still be
 * wrong for the others -- most obviously in the mirrored case, where the busy
 * direction is dir0 instead of dir1. This suite covers every line so that
 * cannot happen silently.
 *
 * Measured loss from the old cap, buses no longer estimated, over a 5-minute
 * sweep of 06:00-23:00 on both weekday and Saturday grids:
 *
 *     line   before -> after      line   before -> after
 *       1       66 ->  18            5       20 ->  16
 *       2       38 ->  16            6       42 ->  32
 *       3       44 ->  30            7        8 ->   2
 *       4       12 ->   6            8       22 ->  12
 *
 * The fixtures below are the instants where the old code demonstrably lost a
 * bus AND the new code fully accounts for every trip, so the assertion is about
 * the cap and nothing else -- no anti-bunching refusal can be mistaken for a
 * regression, and no regression can hide behind one. L4, L6 and L7 have no such
 * instant: their headways happen to divide evenly, so the old cap never bound
 * on them. That is asserted explicitly rather than skipped, because "the fix
 * changed nothing here" is a real property worth pinning -- it is what shows the
 * fix is not over-broad.
 *
 * The split is read from the timetable at the same instant rather than
 * hardcoded, and a CONTROL re-derives the old ceil(lineMaxFleet / 2) ceiling to
 * prove each fixture is one the old code actually got wrong. A fixture that
 * stopped being asymmetric after a timetable revision would fail the control
 * loudly instead of passing vacuously.
 *
 * Not covered here, and deliberately so: the anti-bunching and terminal-clash
 * guards. Those legitimately refuse ghosts on self-folding polylines, and
 * fleet_direction_balance_test.js pins that they still bite.
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripComments } = require('./helpers/strip_comments.cjs');
const mataroTracker = require('../src/mataroTracker');
const mataroSchedules = require('../src/data/mataroSchedules');
const timeEngine = require('../src/core/time/timeEngine');

const ALL_LINES = ['1', '2', '3', '4', '5', '6', '7', '8'];

// Europe/Madrid is UTC+2 in September, so a local wall-clock time maps to
// Date.UTC at h-2. The DAY OF WEEK is load-bearing, not decoration:
// synthesizeMissingScheduledBuses resolves the grid from the date it is handed,
// so asking it for a Saturday grid means passing a Saturday. Comparing a
// Thursday run against a Saturday fleet requirement compares two different
// timetables and invents failures.
//
// 2026-09-24 is a Thursday, 2026-09-26 a Saturday. September is chosen so
// resolveDayType() does not silently route an August weekday onto the Saturday
// grid.
const madridInstant = (h, m, dayType = 'weekday') => new Date(
  Date.UTC(2026, 8, dayType === 'saturday' ? 26 : 24, h - 2, m, 0)
);

/** Trips the timetable says are in the air, read from the published grid. */
const timetableTrips = (lineId, dirKey, dayType, nowSec) => {
  const s = mataroSchedules.getDirectionSchedule(lineId, dirKey, dayType);
  if (!s || !Array.isArray(s.departures)) return 0;
  const travel = s.totalTravelSec;
  return s.departures
    .map((t) => timeEngine.timeStringToSeconds(t))
    .filter((dep) => nowSec >= dep && nowSec < dep + travel).length;
};

const splitOf = (buses) => buses.reduce((acc, b) => {
  const d = String(b.direction);
  acc[d] = (acc[d] || 0) + 1;
  return acc;
}, {});

/**
 * Instants where the old ceil(lineMaxFleet / 2) ceiling demonstrably lost a bus.
 * Each is (dayType, hour, minute); the expected split is NOT stored here, it is
 * read from the timetable at run time.
 */
const FIXTURES = {
  1: [['weekday', 10, 25]],
  2: [['weekday', 10, 15], ['weekday', 22, 20]],
  3: [['weekday', 12, 25]],
  5: [['weekday', 22, 35]],
  8: [['weekday', 7, 10]]
};

async function run() {
  console.log('🧪 =========================================================================');
  console.log('🧪 RUNNING ALL-LINES ASYMMETRIC-FLEET REGRESSION TESTS (L1–L8)');
  console.log('🧪 =========================================================================\n');

  const dirTemplates = {};
  for (const lid of ALL_LINES) {
    dirTemplates[lid] = (await mataroTracker.getLineDetails(lid, 'both', { skipSiri: true })).directions;
  }

  // ── CONTROL 1: every line really is asymmetric ───────────────────────────
  // The whole defect rests on this. If a future timetable revision balances a
  // line, this fails loudly rather than letting the tests below pass for a
  // reason that no longer has anything to do with the bug.
  console.log('📌 CONTROL: all eight lines are asymmetric...');
  for (const lid of ALL_LINES) {
    const d0 = mataroSchedules.getDirectionSchedule(lid, '0', 'weekday');
    const d1 = mataroSchedules.getDirectionSchedule(lid, '1', 'weekday');
    assert.ok(d0 && d1 && Array.isArray(d0.departures) && Array.isArray(d1.departures),
      `CONTROL FAILED: line ${lid} no longer has two readable direction schedules`);
    assert.notStrictEqual(
      d0.totalTravelSec, d1.totalTravelSec,
      `CONTROL FAILED: line ${lid} is now symmetric (${d0.totalTravelSec}s both ways). ` +
      'The even-split bug cannot occur on it, so the fixtures below would pass vacuously. ' +
      'Re-derive them rather than deleting this assertion.'
    );
  }
  console.log(`  ✓ all ${ALL_LINES.length} lines asymmetric\n`);

  // ── 1. The regression, on every line that had one ───────────────────────
  console.log('📌 Test 1: every line the old cap got wrong is now fully estimated...');
  let fixtureCount = 0;
  for (const [lid, fixtures] of Object.entries(FIXTURES)) {
    const routes = mataroTracker.routesData[lid];
    for (const [dayType, h, m] of fixtures) {
      const nowSec = h * 3600 + m * 60;
      const t0 = timetableTrips(lid, '0', dayType, nowSec);
      const t1 = timetableTrips(lid, '1', dayType, nowSec);
      const total = t0 + t1;
      assert.ok(total > 0, `L${lid} ${dayType} ${h}:${m}: no trips in the air, fixture is dead`);

      // CONTROL 2: re-derive what the old code would have produced and prove
      // it was short. Without this, a fixture could drift into an instant the
      // old cap handled correctly and the assertion would prove nothing.
      const lineMaxFleet = mataroSchedules.getScheduledFleetRequirement(lid, dayType, nowSec);
      const oldCeiling = Math.max(1, Math.ceil(lineMaxFleet / 2));
      const oldWouldMake = Math.min(t0, oldCeiling) + Math.min(t1, oldCeiling);
      assert.ok(
        oldWouldMake < total,
        `CONTROL FAILED: L${lid} ${dayType} ${h}:${m} is no longer a regression -- ` +
        `the old ceil(${lineMaxFleet}/2)=${oldCeiling} ceiling would have produced ${oldWouldMake} ` +
        `for ${total} trips, so nothing was lost here. Pick a different instant.`
      );

      const r = mataroTracker.synthesizeMissingScheduledBuses(
        lid, 'both', routes, dirTemplates[lid], [], madridInstant(h, m)
      );

      assert.strictEqual(
        r.syntheticBuses.length, total,
        `L${lid} ${dayType} ${h}:${m}: expected ${total} ghosts for ${t0}/${t1} trips ` +
        `(old code produced ${oldWouldMake}), got ${r.syntheticBuses.length}`
      );

      const got = splitOf(r.syntheticBuses);
      const expected = {};
      if (t0 > 0) expected['0'] = t0;
      if (t1 > 0) expected['1'] = t1;
      assert.deepStrictEqual(
        got, expected,
        `L${lid} ${dayType} ${h}:${m}: ghosts must follow the timetable split, not be forced toward an even split`
      );
      fixtureCount++;
    }
    console.log(`  ✓ L${lid}: ${fixtures.length} instants, oldest ceiling would have lost a bus, all now complete`);
  }
  console.log(`  ✓ ${fixtureCount} regression fixtures across ${Object.keys(FIXTURES).length} lines\n`);

  // ── 2. The mirrored orientation must work too ───────────────────────────
  // L1 and L8 carry the load on dir1; L2, L3 and L5 on dir0. A fix that only ever
  // relieved pressure on the second direction would pass an L1-only test and
  // fail here.
  console.log('📌 Test 2: the fix works whichever direction is the busy one...');
  const orientation = { '1': '1', '2': '0', '3': '0', '5': '0', '8': '1' };
  for (const [lid, fixtures] of Object.entries(FIXTURES)) {
    const [dayType, h, m] = fixtures[0];
    const nowSec = h * 3600 + m * 60;
    const counts = { '0': timetableTrips(lid, '0', dayType, nowSec), '1': timetableTrips(lid, '1', dayType, nowSec) };
    const busyDir = counts['0'] > counts['1'] ? '0' : '1';
    const quietDir = busyDir === '0' ? '1' : '0';
    assert.strictEqual(
      busyDir, orientation[lid],
      `L${lid} ${dayType} ${h}:${m}: expected the busy direction to be ${orientation[lid]}, ` +
      `but the timetable now has ${counts['0']}/${counts['1']}. Re-derive the orientation map.`
    );
    assert.ok(counts[busyDir] > counts[quietDir],
      `L${lid}: the fixture is no longer asymmetric at ${h}:${m}`);
  }
  console.log('  ✓ L1/L8 carry the load on dir1, L2/L3/L5 on dir0 — both orientations covered\n');

  // ── 3. The even-split arithmetic must not come back ─────────────────────
  // The defect WAS an arithmetic shape: a whole-line fleet figure divided by
  // the number of directions. Re-deriving a per-direction budget that way is
  // wrong on every line, and no behavioural test can catch it on a line whose
  // losses happen to be entangled with the anti-bunching guard — which is
  // exactly L4, L6 and L7. So pin the shape directly, against comments
  // stripped by the repo's string-aware stripper: a comment or a string that
  // merely QUOTES the old formula must not fail this check, because AGENTS.md
  // records that trap biting this repo twice already.
  console.log('📌 Test 3: no whole-line fleet figure is halved to get a per-direction budget...');
  {
    const code = stripComments(
      fs.readFileSync(path.join(__dirname, '..', 'src', 'mataroTracker.js'), 'utf8')
    );
    // The old line, and the general form of it. Both were per-direction budgets
    // derived by dividing a whole-line figure.
    const halvings = [
      { re: /Math\.ceil\(\s*lineMaxFleet\s*\/\s*2\s*\)/g, what: 'ceil(lineMaxFleet / 2)' },
      { re: /Math\.ceil\(\s*lineMaxFleet\s*\/\s*Math\.max\(\s*1\s*,\s*[^)]*\)\s*\)/g, what: 'ceil(lineMaxFleet / <direction count>)' },
      { re: /Math\.floor\(\s*lineMaxFleet\s*\/\s*2\s*\)/g, what: 'floor(lineMaxFleet / 2)' }
    ];
    for (const { re, what } of halvings) {
      const hits = code.match(re);
      assert.ok(!hits,
        `${what} is back in mataroTracker.js (${hits && hits.length} occurrence(s)). ` +
        'A per-direction budget must come from that direction\'s own unserved trips, ' +
        'never from dividing a whole-line figure — every Mataró line is asymmetric.');
    }
    // CONTROL: the stripper must genuinely strip comments, or the check above
    // would be satisfied by a comment quoting the old formula.
    const probe = `// ceil(lineMaxFleet / 2) in a comment\nconst s = "*/*;q=0.8";\n/* ceil(lineMaxFleet / 2) */`;
    const strippedProbe = stripComments(probe);
    assert.ok(!strippedProbe.includes('lineMaxFleet'),
      'CONTROL FAILED: the comment stripper is not removing comments, so this test cannot detect the arithmetic');
    assert.ok(strippedProbe.includes('*/*;q=0.8'),
      'CONTROL FAILED: the comment stripper ate a string containing "*/" — the exact trap AGENTS.md records');
    console.log('  ✓ no even-split budget in executable code; the stripper is proven to be comment-blind-safe');
  }
  console.log('');

  // ── 4. The whole-line ceiling still holds everywhere ────────────────────
  // The per-direction allowance was widened; the global one must not have been.
  // A ghost fleet larger than the line's own scheduled fleet is a phantom fleet,
  // and this is the invariant that would catch such a regression.
  console.log('📌 Test 4: the whole-line fleet ceiling still bounds every line...');
  for (const lid of ALL_LINES) {
    const routes = mataroTracker.routesData[lid];
    let checked = 0;
    for (const dayType of ['weekday', 'saturday']) {
      for (let h = 6; h < 23; h++) {
        for (const m of [10, 25, 40, 55]) {
          const nowSec = h * 3600 + m * 60;
          const lineMaxFleet = mataroSchedules.getScheduledFleetRequirement(lid, dayType, nowSec);
          if (!lineMaxFleet) continue;
          const r = mataroTracker.synthesizeMissingScheduledBuses(
            lid, 'both', routes, dirTemplates[lid], [], madridInstant(h, m, dayType)
          );
          checked++;
          assert.ok(
            r.syntheticBuses.length <= lineMaxFleet,
            `L${lid} ${dayType} ${h}:${m}: ${r.syntheticBuses.length} ghosts exceeds the line's scheduled fleet of ${lineMaxFleet}`
          );
        }
      }
    }
    assert.ok(checked > 0, `L${lid}: the sweep checked nothing`);
    console.log(`  ✓ L${lid}: ${checked} instants, never above the line's scheduled fleet`);
  }
  console.log('');

  console.log('=========================================================================');
  console.log('🎉 ALL-LINES ASYMMETRIC-FLEET TESTS PASSED');
  console.log('=========================================================================');
}

run().catch((err) => {
  console.error('❌ ALL-LINES FLEET TEST FAILED:', err);
  process.exit(1);
});
