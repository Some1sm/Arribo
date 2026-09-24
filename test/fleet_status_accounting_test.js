/**
 * test/fleet_status_accounting_test.js
 *
 * THE REGRESSION TEST FOR "liveGpsVehicles + estimatedVehicles != the fleet".
 *
 * A rider on L2 saw seven buses scheduled and, on L1, read a counter saying
 * "2 gps + 3 estimats" over a total of 6 while a fourth bus was plainly on the
 * map in the yellow/orange dead-reckoned style. The dead-reckoned bus was in
 * NEITHER reported bucket.
 *
 * A dead-reckoned bus is a real, identified vehicle whose GPS fix has gone
 * stale, so it carries BOTH `isPhysicalVehicle() === true` (it is a real bus,
 * and it correctly occupies a fleet slot rather than letting a ghost be drawn
 * for its trip) AND `isEstimated === true` (set by the 45-second freshness test
 * in processBusesWithDeadReckoning). The counters were computed by exclusion:
 *
 *     liveGpsVehicles  = physical && !isEstimated     -> dead-reckoned excluded
 *     estimatedVehicles = allSyntheticBuses.length    -> ghosts only
 *
 * so a dead-reckoned bus fell through both, and the two fields stopped summing
 * to the fleet by exactly one per dead-reckoned bus. Measured on L1: zero
 * dead-reckoned summed exactly, one was off by 1, two were off by 2.
 *
 * The rider-facing map counter was NEVER wrong about this — public/js/app.js
 * buckets on `isEstimated` and so already grouped dead-reckoned buses with the
 * estimates. What was wrong was the API payload, and the "6 en servei" that
 * papered over it: before commit 0a23eee the counter did
 * `Math.max(live + est, scheduled)`, inflating the total to hide the gap
 * instead of fixing it. That inflation is asserted absent below.
 *
 * `fleetCoveragePct` is deliberately NOT changed by this fix. It answers "how
 * much of the fleet is reporting GPS", so a dead-reckoned bus correctly lowers
 * it (50% -> 33% -> 17% in the measurement above). Counting an inferred
 * position as coverage would make the number mean less.
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const mataroTracker = require('../src/mataroTracker');
const siriClient = require('../src/mataroSiriClient');

/** A live bus on L1 dir1 at a given route progress, with an adjustable fix age. */
const busOnL1 = (id, dir, progress, ageMs = 0) => {
  const coords = mataroTracker.routesData['1'][dir].coords;
  const c = coords[Math.floor((coords.length - 1) * progress)];
  const lat = parseFloat(c.Latitude);
  const lon = parseFloat(c.Longitude);
  return {
    vehicleId: id, lineId: '1', direction: String(dir), lat, lon,
    latitude: lat, longitude: lon,
    speedKmh: 20, hasSpeed: true, totalProgress: Math.round(progress * 100),
    isEstimated: false, isRealTime: true,
    timestamp: Date.now() - ageMs
  };
};

/** Feed a bus set through the real getLineDetails path via the SIRI cache. */
async function fleetFor(buses) {
  siriClient.cache.set('veh_1', { ts: Date.now(), data: buses });
  mataroTracker.invalidateLineDetailsCache();
  try {
    return await mataroTracker.getLineDetails('1', 'both');
  } finally {
    siriClient.cache.delete('veh_1');
    mataroTracker.invalidateLineDetailsCache();
  }
}

const kindsOf = (r) => r.activeBuses.map((b) =>
  b.isGhostVehicle ? 'ghost' : b.isEstimated ? 'deadReck' : 'gps');

async function run() {
  console.log('🧪 =========================================================================');
  console.log('🧪 RUNNING FLEET STATUS ACCOUNTING TESTS (dead-reckoned buses must be counted)');
  console.log('🧪 =========================================================================\n');

  // ── CONTROL: the fixture really does produce a dead-reckoned bus ─────────
  // Everything below is void if the 90 s-old fix stops being stale, so prove
  // the mechanism is live before asserting anything about the counters.
  console.log('📌 CONTROL: a 90 s-old fix produces a dead-reckoned bus, not a ghost...');
  {
    const r = await fleetFor([busOnL1('2682', 0, 0.20), busOnL1('2690', 1, 0.55, 90000)]);
    const dr = r.activeBuses.filter((b) => !b.isGhostVehicle && b.isEstimated);
    assert.strictEqual(dr.length, 1, 'CONTROL FAILED: expected exactly one dead-reckoned bus in the fixture');
    assert.strictEqual(String(dr[0].vehicleId), '2690', 'CONTROL FAILED: the stale bus is not the one expected');
    assert.ok(mataroTracker.isPhysicalVehicle(dr[0]),
      'CONTROL FAILED: a dead-reckoned bus must still be a PHYSICAL vehicle — that is what stops a ghost being drawn for its trip');
    assert.ok(!String(dr[0].vehicleId).startsWith('EST_'),
      'CONTROL FAILED: a dead-reckoned bus must never be an EST_ timetable ghost');
    console.log('  ✓ stale fix -> isEstimated + isPhysicalVehicle: a real bus with an inferred position');
    console.log('  ✓ it is excluded from the flight-recorder ghost set (EST_) but keeps its fleet slot\n');
  }

  // ── 1. THE REGRESSION: the counters must sum to the fleet ───────────────
  console.log('📌 Test 1: liveGpsVehicles + estimatedVehicles equals the fleet returned...');
  const cases = [
    { label: 'no dead-reckoned bus', buses: [busOnL1('2682', 0, 0.20), busOnL1('2680', 1, 0.35), busOnL1('2690', 1, 0.55)] },
    { label: 'one dead-reckoned bus', buses: [busOnL1('2682', 0, 0.20), busOnL1('2680', 1, 0.35), busOnL1('2690', 1, 0.55, 90000)] },
    { label: 'two dead-reckoned buses', buses: [busOnL1('2682', 0, 0.20, 90000), busOnL1('2680', 1, 0.35, 90000), busOnL1('2690', 1, 0.55)] },
    { label: 'all three dead-reckoned', buses: [busOnL1('2682', 0, 0.20, 90000), busOnL1('2680', 1, 0.35, 90000), busOnL1('2690', 1, 0.55, 90000)] }
  ];
  for (const { label, buses } of cases) {
    const r = await fleetFor(buses);
    const f = r.fleetStatus;
    const sum = f.liveGpsVehicles + f.estimatedVehicles;
    assert.strictEqual(
      sum, r.activeBuses.length,
      `${label}: counters report ${f.liveGpsVehicles} GPS + ${f.estimatedVehicles} estimated = ${sum}, ` +
      `but the payload carries ${r.activeBuses.length} buses [${kindsOf(r).join(', ')}]`
    );
    // The dead-reckoned count must be reported explicitly and must be exactly
    // the number of physical-but-estimated buses, not a re-derivation of them.
    const actualDr = r.activeBuses.filter((b) => !b.isGhostVehicle && b.isEstimated).length;
    assert.strictEqual(
      f.deadReckonedVehicles, actualDr,
      `${label}: deadReckonedVehicles must equal the number of dead-reckoned buses (${actualDr})`
    );
    assert.strictEqual(
      f.estimatedVehicles, f.deadReckonedVehicles + r.activeBuses.filter((b) => b.isGhostVehicle).length,
      `${label}: estimatedVehicles must be ghosts PLUS dead-reckoned buses`
    );
    console.log(`  ✓ ${label}: ${f.liveGpsVehicles} GPS + ${f.estimatedVehicles} estimated ` +
      `(${f.deadReckonedVehicles} dead-reckoned) = ${sum} = fleet`);
  }
  console.log('');

  // ── 2. The single-direction payload must agree too ──────────────────────
  // The whole-line and per-direction figures were two separate expressions, and
  // the per-direction one had the identical exclusion bug. A fix at one site
  // that leaves the other is exactly how the original even-split defect
  // survived in two places.
  console.log('📌 Test 2: the single-direction payload agrees with its own fleet...');
  for (const dir of ['0', '1']) {
    siriClient.cache.set('veh_1', { ts: Date.now(), data: cases[1].buses });
    mataroTracker.invalidateLineDetailsCache();
    let r;
    try {
      r = await mataroTracker.getLineDetails('1', dir);
    } finally {
      siriClient.cache.delete('veh_1');
      mataroTracker.invalidateLineDetailsCache();
    }
    const f = r.fleetStatus;
    const sum = f.liveGpsVehicles + f.estimatedVehicles;
    assert.strictEqual(
      sum, r.activeBuses.length,
      `dir ${dir}: counters report ${f.liveGpsVehicles} + ${f.estimatedVehicles} = ${sum} ` +
      `but the payload carries ${r.activeBuses.length} buses [${kindsOf(r).join(', ')}]`
    );
    assert.ok(
      f.deadReckonedVehicles >= 0 && f.deadReckonedVehicles <= f.estimatedVehicles,
      `dir ${dir}: deadReckonedVehicles (${f.deadReckonedVehicles}) must be a subset of estimatedVehicles (${f.estimatedVehicles})`
    );
    console.log(`  ✓ dir ${dir}: ${f.liveGpsVehicles} GPS + ${f.estimatedVehicles} estimated = ${sum} = fleet`);
  }
  console.log('');

  // ── 3. Coverage must still mean "reporting GPS" ─────────────────────────
  // The tempting wrong fix is to leave estimatedVehicles alone and instead
  // count dead-reckoned buses as live coverage, which would make the two
  // numbers agree while making coverage a lie. Pin that coverage is unaffected.
  console.log('📌 Test 3: coverage still measures OBSERVED GPS, not inferred positions...');
  {
    const fresh = await fleetFor(cases[0].buses);
    const stale = await fleetFor(cases[1].buses);
    assert.ok(
      fresh.fleetStatus.fleetCoveragePct > stale.fleetStatus.fleetCoveragePct,
      `a bus losing its GPS must lower coverage: fresh ${fresh.fleetStatus.fleetCoveragePct}% vs stale ${stale.fleetStatus.fleetCoveragePct}%`
    );
    assert.strictEqual(
      stale.fleetStatus.liveGpsVehicles, fresh.fleetStatus.liveGpsVehicles - 1,
      'a dead-reckoned bus must NOT be counted as live GPS — the position was inferred'
    );
    console.log(`  ✓ coverage ${fresh.fleetStatus.fleetCoveragePct}% -> ${stale.fleetStatus.fleetCoveragePct}% when a bus drops its fix`);
    console.log('  ✓ and liveGpsVehicles drops with it, so coverage never counts an inferred position');
  }
  console.log('');

  // ── 4. The counter must not be able to hide a gap again ─────────────────
  // `Math.max(live + est, scheduled)` is what turned a 5-bus fleet into a
  // "6 en servei" readout. It is gone, but it is the kind of line that comes
  // back, and it would be invisible in review because it looks like a harmless
  // clamp. Assert the source does not do it, with comments stripped so a
  // comment quoting the old expression cannot fail this.
  console.log('📌 Test 4: the frontend cannot inflate the total to cover a shortfall...');
  {
    const { stripComments } = require('./helpers/strip_comments.cjs');
    const app = stripComments(
      fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8')
    );
    assert.ok(
      !/Math\.max\(\s*live\s*\+\s*est\s*,/.test(app),
      'app.js computes `Math.max(live + est, scheduled)`, which inflates the reported total ' +
      'to the scheduled figure and hides buses missing from either counter. Report the count.'
    );
    assert.ok(
      /const\s+total\s*=\s*live\s*\+\s*est/.test(app),
      'CONTROL FAILED: the map counter no longer derives its total from live + est, ' +
      'so this test is asserting against a counter that has been restructured. Re-derive it.'
    );
    console.log('  ✓ the map total is live + est, never floored up to the scheduled figure');
  }
  console.log('');

  console.log('=========================================================================');
  console.log('🎉 ALL FLEET STATUS ACCOUNTING TESTS PASSED');
  console.log('=========================================================================');
}

run().catch((err) => {
  console.error('❌ FLEET STATUS ACCOUNTING TEST FAILED:', err);
  process.exit(1);
});
