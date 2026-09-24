/**
 * test/fleet_direction_balance_test.js
 *
 * THE REGRESSION TEST FOR "A LINE'S SCHEDULED FLEET IS NOT AN EVEN NUMBER PER DIRECTION".
 *
 * A rider reported "3 buses with no GPS but we are only showing 2, total should
 * be 6" on L1. The total of 6 was right: getScheduledFleetRequirement('1') says
 * 6 at that hour. What was wrong was that two SEPARATE places derived a
 * per-direction allowance by DIVIDING that whole-line figure in half:
 *
 *   - synthesizeMissingScheduledBuses capped ghosts at ceil(lineMaxFleet / 2)
 *   - the fleet ceiling in getLineDetails did the same for the payload
 *
 * L1 is asymmetric. It is 31 minutes one way and 40 the other, so at equal
 * headway one direction always has more buses in the air than the other: 2
 * against 4 at 13:25. Halving 6 gives 3 and 3, which undercounts the busy
 * direction and overcounts the quiet one. The bus that vanished is a bus the
 * timetable says is running.
 *
 * The assertions here are built to fail on the old code, so they are checked
 * against the schedule rather than against magic numbers: each expected split
 * is read from mataroSchedules at the same instant, and a CONTROL asserts the
 * fixture is actually asymmetric so the test cannot pass vacuously if the
 * timetable is ever rebalanced to symmetric times.
 *
 * The anti-bunching guards are NOT weakened here, and that is asserted too --
 * a test that only checked the count would happily pass a fix that also deleted
 * the spatial guard. One case pins a case where a real bus legitimately blocks
 * a ghost, and one pins the lagging-bus case that the "unmatched physical bus"
 * subtraction exists for.
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const mataroTracker = require('../src/mataroTracker');
const mataroSchedules = require('../src/data/mataroSchedules');
const siriClient = require('../src/mataroSiriClient');
const timeEngine = require('../src/core/time/timeEngine');
const geoEngine = require('../src/core/geo/geoEngine');

// Europe/Madrid is UTC+2 in September, so a local wall-clock time maps to
// Date.UTC at h-2. Frozen: these are schedule-sensitive instants.
const madridInstant = (h, m) => new Date(Date.UTC(2026, 8, 24, h - 2, m, 0));

const fmt = (sec) => `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;

/**
 * Count the trips the TIMETABLE says are in the air, per direction. This is
 * the independent expectation -- it reads the published grid, not the code
 * under test.
 */
const timetableTrips = (lineId, dirKey, dayType, nowSec) => {
  const s = mataroSchedules.getDirectionSchedule(lineId, dirKey, dayType);
  const travel = s.totalTravelSec;
  return s.departures
    .map((t) => timeEngine.timeStringToSeconds(t))
    .filter((dep) => nowSec >= dep && nowSec < dep + travel);
};

const split = (buses) => buses.reduce((acc, b) => {
  const d = String(b.direction);
  acc[d] = (acc[d] || 0) + 1;
  return acc;
}, {});

const live = (id, dir, lat, lon, progress) => ({
  vehicleId: id, lineId: '1', direction: String(dir),
  lat, lon, latitude: lat, longitude: lon,
  speedKmh: 20, totalProgress: progress,
  isEstimated: false, isRealTime: true
});

async function run() {
  console.log('🧪 =========================================================================');
  console.log('🧪 RUNNING FLEET DIRECTION-BALANCE (ASYMMETRIC LINE) TESTS');
  console.log('🧪 =========================================================================\n');

  const routes1 = mataroTracker.routesData['1'] || [];
  const dirTemplate = (await mataroTracker.getLineDetails('1', 'both', { skipSiri: true })).directions;

  // ── CONTROL: the fixture must be asymmetric, or nothing below proves anything
  const d0 = mataroSchedules.getDirectionSchedule('1', '0', 'weekday');
  const d1 = mataroSchedules.getDirectionSchedule('1', '1', 'weekday');
  assert.notStrictEqual(
    d0.totalTravelSec, d1.totalTravelSec,
    `CONTROL FAILED: L1 is expected to be asymmetric, but both directions are ${d0.totalTravelSec}s. ` +
    'If the timetable was rebalanced, pick new instants for this test rather than ' +
    'letting it pass vacuously.'
  );
  console.log(`  ✓ CONTROL: L1 is asymmetric — dir0 ${d0.totalTravelSec / 60} min vs dir1 ${d1.totalTravelSec / 60} min\n`);

  // ── 1. THE REGRESSION: an asymmetric hour must be fully estimated ──────────
  // 13:25 has 2 trips on dir0 and 4 on dir1. The old cap allowed ceil(6/2)=3
  // per direction, so dir1 lost one and the rider saw 5 buses for 6 trips.
  console.log('📌 Test 1: 13:25 — 2 trips dir0 / 4 trips dir1, no GPS at all...');
  {
    const nowSec = 13 * 3600 + 25 * 60;
    const t0 = timetableTrips('1', '0', 'weekday', nowSec).length;
    const t1 = timetableTrips('1', '1', 'weekday', nowSec).length;
    assert.strictEqual(t0, 2, `CONTROL: expected 2 dir0 trips at 13:25, timetable has ${t0}`);
    assert.strictEqual(t1, 4, `CONTROL: expected 4 dir1 trips at 13:25, timetable has ${t1}`);
    assert.notStrictEqual(t0, t1, 'CONTROL: the 13:25 fixture must be asymmetric');
    console.log(`  -> timetable says ${t0} on dir0 and ${t1} on dir1 (an even split would allow ${Math.ceil((t0 + t1) / 2)} each)`);

    const r = mataroTracker.synthesizeMissingScheduledBuses('1', 'both', routes1, dirTemplate, [], madridInstant(13, 25));

    assert.strictEqual(
      r.syntheticBuses.length, t0 + t1,
      'every active scheduled trip must be estimated, not just half the line fleet'
    );
    assert.deepStrictEqual(
      split(r.syntheticBuses), { '0': t0, '1': t1 },
      'ghosts must follow the timetable split, not be forced toward an even 3/3'
    );
    assert.strictEqual(r.fleetStatus.scheduledVehicles, t0 + t1, 'fleetStatus must report the whole-line figure');
    console.log(`  ✓ ${r.syntheticBuses.length} ghosts synthesized, split ${JSON.stringify(split(r.syntheticBuses))}\n`);
  }

  // ── 2. Symmetric instants must be unchanged ──────────────────────────────
  // The fix must be narrow: where the timetable genuinely is balanced, the old
  // even split was already right and nothing may move.
  console.log('📌 Test 2: symmetric instants (09:10, 19:00) are unchanged...');
  for (const [h, m] of [[9, 10], [19, 0]]) {
    const nowSec = h * 3600 + m * 60;
    const t0 = timetableTrips('1', '0', 'weekday', nowSec).length;
    const t1 = timetableTrips('1', '1', 'weekday', nowSec).length;
    const r = mataroTracker.synthesizeMissingScheduledBuses('1', 'both', routes1, dirTemplate, [], madridInstant(h, m));
    assert.strictEqual(
      r.syntheticBuses.length, t0 + t1,
      `${fmt(nowSec)}: a balanced instant must still be fully estimated (${t0}/${t1})`
    );
    console.log(`  ✓ ${fmt(nowSec)}: ${r.syntheticBuses.length} ghosts for ${t0}/${t1} trips`);
  }
  console.log('');

  // ── 3. The single-direction payload must not contradict its own status ────
  // The second even-split lived in the fleet ceiling: for a one-direction
  // request it allowed ceil(lineMaxFleet / 2), so a payload could report
  // scheduledVehicles: 4 and still ship 3 buses. Freeze the clock so the
  // chosen instant is the one under test.
  console.log('📌 Test 3: a single-direction payload returns the buses it claims are scheduled...');
  {
    const realDate = global.Date;
    const frozen = new realDate('2026-09-24T10:25:00+02:00').getTime();
    class FrozenDate extends realDate {
      constructor(...args) { if (!args.length) super(frozen); else super(...args); }
      static now() { return frozen; }
    }
    global.Date = FrozenDate;
    try {
      for (const dir of ['0', '1']) {
        const r = await mataroTracker.getLineDetails('1', dir, { skipSiri: true });
        const ghosts = r.activeBuses.filter((b) => b.isGhostVehicle).length;
        assert.strictEqual(
          r.activeBuses.length, r.fleetStatus.scheduledVehicles,
          `dir ${dir}: the payload reported ${r.fleetStatus.scheduledVehicles} scheduled but returned ${r.activeBuses.length} buses`
        );
        assert.ok(ghosts > 0, `dir ${dir}: expected estimated buses at this instant`);
      }
      const both = await mataroTracker.getLineDetails('1', 'both', { skipSiri: true });
      assert.strictEqual(
        both.activeBuses.length, both.fleetStatus.scheduledVehicles,
        'the whole-line payload must also agree with its own status'
      );
      console.log(`  ✓ every direction agrees with its own scheduledVehicles (both = ${both.activeBuses.length})\n`);
    } finally {
      global.Date = realDate;
      mataroTracker.invalidateLineDetailsCache();
    }
  }

  // ── 4. Anti-bunching must STILL bite ─────────────────────────────────────
  // A count-only test would pass a fix that deleted the spatial guard. Put a
  // real bus exactly where a ghost would land and assert no ghost appears.
  console.log('📌 Test 4: a real bus on the route still suppresses its ghost...');
  {
    const r0 = mataroTracker.synthesizeMissingScheduledBuses('1', 'both', routes1, dirTemplate, [], madridInstant(13, 25));
    const target = r0.syntheticBuses.find((b) => b.direction === '1');
    assert.ok(target, 'expected a dir1 ghost to use as a blocker');

    // A bus sitting on that ghost's exact coordinates must keep it from being drawn.
    const blocker = live('2699', '1', target.lat, target.lon, target.totalProgress);
    const r1 = mataroTracker.synthesizeMissingScheduledBuses(
      '1', 'both', routes1, dirTemplate, [blocker], madridInstant(13, 25), [blocker]
    );
    assert.ok(
      !r1.syntheticBuses.some((b) => b.vehicleId === target.vehicleId),
      'the anti-bunching guard must still refuse a ghost placed on a real bus'
    );
    assert.ok(
      r1.syntheticBuses.length < r0.syntheticBuses.length,
      'placing a real bus on a ghost must reduce the number of ghosts'
    );
    console.log(`  ✓ ${r0.syntheticBuses.length} ghosts -> ${r1.syntheticBuses.length} with a real bus on one of them\n`);
  }

  // ── 5. A LAGGING bus must not get a phantom drawn under it ──────────────
  // Pairing has a 0.40 progress tolerance, so a bus running outside that
  // window leaves its trip looking unpaired. A physical bus on the road is
  // still evidence a bus is out, so the direction's allowance subtracts buses
  // that claimed no trip. Regression: a 42%-off bus on L1 Saturday drew a
  // second, phantom bus for a direction that already had one.
  console.log('📌 Test 5: a bus too far off its trip to match does not get a phantom underneath...');
  {
    const at = new Date('2026-09-12T10:54:00Z'); // Saturday 12:54 Madrid
    const nowSec = 12 * 3600 + 54 * 60;
    const lagging = live('2667', '0', 41.539, 2.442, 57);
    const onTime = live('2672', '1', 41.5546, 2.4313, 96);
    const feeders = [lagging, onTime];

    const r = mataroTracker.synthesizeMissingScheduledBuses('1', 'both', routes1, dirTemplate, feeders, at, feeders);

    const dir0Trips = timetableTrips('1', '0', 'saturday', nowSec).length;
    assert.strictEqual(dir0Trips, 1, `CONTROL: expected 1 dir0 trip at Saturday 12:54, got ${dir0Trips}`);

    const dir0Ghosts = r.syntheticBuses.filter((b) => b.direction === '0').length;
    assert.strictEqual(
      dir0Ghosts, 0,
      'dir0 already has a physical bus that no trip could claim; drawing a second bus there is a phantom'
    );
    assert.ok(
      r.syntheticBuses.some((b) => b.direction === '1'),
      'the genuinely unserved direction must still be estimated'
    );
    console.log(`  ✓ dir0 keeps 0 ghosts despite 1 unclaimed trip (a real bus is out there); dir1 still estimated\n`);
  }

  // ── 6. An unattributable vehicle is not a real bus ───────────────────────
  // mataroSiriClient emits `vehicleRef || 'Bus'`, so an activity with no
  // <VehicleRef> arrives literally identified "Bus". Counting it as real eats a
  // fleet slot (suppressing the ghost that should have been drawn), renders a
  // bus with no identity, and claims isRealTime: true for telemetry the
  // operator never identified.
  console.log('📌 Test 6: an anonymous "Bus" activity is dropped, and a stitchable one is still recovered...');
  {
    // The predicate, on its own terms.
    for (const id of ['Bus', 'bus', 'BUS', 'Vehicle', 'unknown', '', '   ', null, undefined]) {
      assert.strictEqual(
        mataroTracker.isAnonymousVehicle({ vehicleId: id }), true,
        `'${id}' carries no operator identity and must be anonymous`
      );
    }
    for (const id of ['2679', 'Bus-12', 'buseta', 'unknownX', '1234']) {
      assert.strictEqual(
        mataroTracker.isAnonymousVehicle({ vehicleId: id }), false,
        `'${id}' is an operator-assigned id and must be kept`
      );
    }

    // End to end: seed the SIRI cache so getLineDetails consumes it for real.
    // The clock is FROZEN here, and it has to be. These buses are seeded at
    // 30/70/50% and carry speedKmh: 20, so the tracker dead-reckons them
    // forward from the seeded position as the cache ages; left on the real
    // clock they land somewhere different on every run, and at roughly 30 of
    // 102 instants through the service day one of them drifts close enough to
    // a ghost for the anti-bunching guard to suppress it legitimately. The
    // equality below then fails on the wall clock while production is correct.
    // A frozen instant is the fixture fix; the assertion itself is right — a
    // dropped phantom must not shrink the payload below the scheduled fleet.
    const realDate = global.Date;
    const frozen = new realDate('2026-09-24T10:25:00+02:00').getTime();
    class FrozenDate extends realDate {
      constructor(...args) { if (!args.length) super(frozen); else super(...args); }
      static now() { return frozen; }
    }
    global.Date = FrozenDate;
    const coordAt = (p, dir = 0) => {
      const c = routes1[dir].coords[Math.floor((routes1[dir].coords.length - 1) * p)];
      return { lat: parseFloat(c.Latitude), lon: parseFloat(c.Longitude) };
    };
    const a = coordAt(0.30), b = coordAt(0.70), c = coordAt(0.50);
    const identified = [live('2679', '1', a.lat, a.lon, 30), live('2680', '1', b.lat, b.lon, 70), live('2681', '1', c.lat, c.lon, 50)];
    const phantom = live('Bus', '1', a.lat + 0.0004, a.lon, 30); // 40 m from a real bus, well inside the old 1.5 km rule

    siriClient.cache.set('veh_1', { ts: Date.now(), data: [...identified, phantom] });
    mataroTracker.invalidateLineDetailsCache();
    try {
      const r = await mataroTracker.getLineDetails('1', 'both');
      const ids = r.activeBuses.map((b) => String(b.vehicleId));
      assert.ok(!ids.includes('Bus'), 'the unattributable "Bus" activity must not be returned as a vehicle');
      assert.strictEqual(r.fleetStatus.liveGpsVehicles, 3, 'liveGpsVehicles must count only identified buses');
      assert.ok(
        !r.activeBuses.some((b) => b.isRealTime && String(b.vehicleId) === 'Bus'),
        'a phantom must never carry isRealTime: true'
      );
      // Its fleet slot must go to a ghost instead of being silently consumed.
      assert.strictEqual(
        r.activeBuses.length, r.fleetStatus.scheduledVehicles,
        'dropping the phantom must not shrink the payload below the scheduled fleet'
      );
      console.log(`  ✓ phantom dropped; ${r.fleetStatus.liveGpsVehicles} identified + ${r.fleetStatus.estimatedVehicles} estimated`);
    } finally {
      siriClient.cache.delete('veh_1');
      mataroTracker.invalidateLineDetailsCache();
      global.Date = realDate;
    }

    // And the stitcher must still do its job: an anonymous report that CAN be
    // tied to a recently-seen real bus is recovered, not thrown away.
    const h = coordAt(0.50, 0);
    mataroTracker.vehicleHistory.set('2679', {
      vehicleId: '2679', lineId: '1', direction: '0', lat: h.lat, lon: h.lon,
      lastSeen: Date.now() - 20000, isGhostVehicle: false, isTheoretical: false
    });
    const anon = coordAt(0.52, 0);
    siriClient.cache.set('veh_1', {
      ts: Date.now(),
      data: [live('Bus', '0', anon.lat, anon.lon, 52)]
    });
    mataroTracker.invalidateLineDetailsCache();
    try {
      const r = await mataroTracker.getLineDetails('1', '0');
      const ids = r.activeBuses.map((b) => String(b.vehicleId));
      assert.ok(ids.includes('2679'), 'a stitchable anonymous report must still recover its real id');
      assert.ok(!ids.includes('Bus'), 'and must not also surface the placeholder');
      console.log('  ✓ stitchable anonymous report still recovers 2679');
    } finally {
      siriClient.cache.delete('veh_1');
      mataroTracker.vehicleHistory.delete('2679');
      mataroTracker.invalidateLineDetailsCache();
    }
    console.log('');
  }

  // ── 7. A bus NEARBY is not a bus ON TOP OF the ghost ────────────────────
  // The guard used to be an anti-BUNCHING test at service-headway scale: 18%
  // route progress OR 700 m same-direction. Those are headway numbers being
  // used to answer a co-location question, and they deleted real buses. The
  // reported case: L1 dir1, bus 2679 at p50 and the 14:57 trip's ghost at p65.7
  // — 458 m apart in space, 15.7% apart in progress, suppressed by the progress
  // clause and then by the distance clause as well.
  //
  // That ghost was a genuinely missing bus, not a duplicate of 2679. 2679
  // paired with the 15:11 trip, which is genuinely nearer to it (0.126 versus
  // 0.224), and one bus can only serve one trip. So the guard was not
  // preventing a double-draw pairing would have caused — it was overriding a
  // pairing decision in exactly the case where a second bus most needs showing.
  console.log('📌 Test 7: a bus 450 m away must NOT hide a bus the timetable says is running...');
  {
    const base = mataroTracker.synthesizeMissingScheduledBuses(
      '1', 'both', routes1, dirTemplate, [], madridInstant(13, 25)
    );
    const target = base.syntheticBuses.find((b) => b.direction === '1');
    assert.ok(target, 'expected a dir1 ghost to work with');

    // Walk along the route until we are ~450 m from where the ghost would land.
    // Progress is not distance on these folded loops, so step the polyline and
    // measure rather than assuming a progress delta means a distance delta.
    const routeCoords = routes1[1].coords;
    let frac = 0, placed = null;
    for (frac = 0.02; frac < 0.98; frac += 0.01) {
      const c = routeCoords[Math.floor((routeCoords.length - 1) * frac)];
      const d = geoEngine.calculateDistanceMeters(
        parseFloat(c.Latitude), parseFloat(c.Longitude), target.lat, target.lon
      );
      if (d > 430 && d < 520) { placed = { c, d: Math.round(d) }; break; }
    }
    assert.ok(placed, 'CONTROL FAILED: could not find a route point ~450 m from the ghost');

    const neighbour = live('2699', '1', parseFloat(placed.c.Latitude), parseFloat(placed.c.Longitude),
      Math.round(frac * 100));
    const r = mataroTracker.synthesizeMissingScheduledBuses(
      '1', 'both', routes1, dirTemplate, [neighbour], madridInstant(13, 25), [neighbour]
    );

    assert.ok(
      r.syntheticBuses.some((b) => b.vehicleId === target.vehicleId),
      `a real bus ${placed.d} m away must not hide a scheduled bus — that is a co-location ` +
      'threshold, not a headway one. A bus this far off is a separate vehicle on the map.'
    );
    console.log(`  ✓ a bus ${placed.d} m away leaves the ghost visible`);

    // ...and the co-location case it DOES exist for must still be refused.
    const onTop = live('2698', '1', target.lat, target.lon, target.totalProgress);
    const r2 = mataroTracker.synthesizeMissingScheduledBuses(
      '1', 'both', routes1, dirTemplate, [onTop], madridInstant(13, 25), [onTop]
    );
    assert.ok(
      !r2.syntheticBuses.some((b) => b.vehicleId === target.vehicleId),
      'a ghost landing on a real bus must still be refused — two markers on one pixel read as a duplicate'
    );
    console.log('  ✓ a ghost on the exact position of a real bus is still refused');
  }

  // ── 8. The progress clause must not come back ───────────────────────────
  // It is the specific defect, and it is invisible in a count test: on a folded
  // loop it fires on buses hundreds of metres apart. Pin the shape, the way
  // test 3 in fleet_all_lines_test.js pins the even-split arithmetic, and strip
  // comments first so a comment quoting the old thresholds cannot fail this.
  console.log('📌 Test 8: no route-progress headway test survives in the co-location guard...');
  {
    const { stripComments } = require('./helpers/strip_comments.cjs');
    const code = stripComments(
      fs.readFileSync(path.join(__dirname, '..', 'src', 'mataroTracker.js'), 'utf8')
    );
    // Anchor on executable code, not on the comment that explains it: the
    // stripper has by definition already deleted every comment by this point,
    // so searching for prose here would find nothing even when the guard is
    // present and correct.
    const start = code.indexOf('const allCurrentBuses = [...allKnownBuses, ...allSyntheticBuses]');
    const end = code.indexOf('const depTimeClean', start);
    assert.ok(start !== -1 && end > start, 'CONTROL FAILED: the co-location guard block was not found');
    const guard = code.slice(start, end);
    assert.ok(
      !/totalProgress\s*\/\s*100/.test(guard),
      'the guard tests route progress again. Progress is not distance on a self-folding route: ' +
      'on L1 dir0, p20% and p55% are 35% of the route apart and 81 m apart in space.'
    );
    assert.ok(
      /GHOST_OVERLAP_M_SAME_DIR/.test(guard) && /GHOST_OVERLAP_M_CROSS_DIR/.test(guard),
      'CONTROL FAILED: the guard no longer names the co-location constants; re-derive this check'
    );
    console.log('  ✓ the guard measures distance only, through named constants');
  }
  console.log('');

  console.log('=========================================================================');
  console.log('🎉 ALL FLEET DIRECTION-BALANCE TESTS PASSED');
  console.log('=========================================================================');
}

run().catch((err) => {
  console.error('❌ FLEET DIRECTION-BALANCE TEST FAILED:', err);
  process.exit(1);
});
