/**
 * test/coordinate_invariants_test.js
 *
 * Locks in the coordinate-handling invariants that AGENTS.md and CLAUDE.md
 * declare as hard requirements but that no other suite asserted:
 *
 *   1. A legitimate 0 coordinate must survive normalization. `lat || fallback`
 *      silently discards it, which is why the codebase uses `typeof`/`??`
 *      guards instead.
 *   2. Internal geometry is [lat, lon]; GeoJSON/ORS is [lon, lat].
 *
 * Mataró itself sits near 41.5N/2.2E, so 0 is never a real stop coordinate
 * here. These tests exist to stop the guards regressing, not because a
 * Mataró stop is currently mis-placed.
 */

const assert = require('assert');
const BaseTracker = require('../src/core/BaseTracker');
const transitRouter = require('../src/core/schedule/transitRouter');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

/** Minimal tracker shape that TransitRouter.buildGraph() consumes. */
function fakeTracker({ routesData, allStopsMap = new Map(), linesData = [] }) {
  return { routesData, allStopsMap, linesData };
}

console.log('\n🧭 COORDINATE INVARIANTS');
console.log('='.repeat(60));

// ---------------------------------------------------------------------------
// 1. Vehicle normalization preserves zero coordinates
// ---------------------------------------------------------------------------
console.log('\n[1] BaseTracker.normalizeVehicle — zero preservation');

const tracker = new BaseTracker();

check('numeric lat/lon of 0 survive normalization', () => {
  const v = tracker.normalizeVehicle({ tripId: 't0', lat: 0, lon: 0 });
  assert.strictEqual(v.lat, 0, `expected lat 0, got ${v.lat}`);
  assert.strictEqual(v.lon, 0, `expected lon 0, got ${v.lon}`);
});

check('ordinary coordinates are preserved', () => {
  const v = tracker.normalizeVehicle({ tripId: 't1', lat: 41.5405, lon: 2.4472 });
  assert.strictEqual(v.lat, 41.5405);
  assert.strictEqual(v.lon, 2.4472);
});

check('zero survives the string-coercion path', () => {
  const v = tracker.normalizeVehicle({ tripId: 't2', lat: '0', lon: '0' });
  assert.strictEqual(v.lat, 0, `expected lat 0, got ${v.lat}`);
  assert.strictEqual(v.lon, 0, `expected lon 0, got ${v.lon}`);
});

check('missing coordinates normalize to 0 rather than NaN', () => {
  const v = tracker.normalizeVehicle({ tripId: 't3' });
  assert.strictEqual(v.lat, 0);
  assert.strictEqual(v.lon, 0);
  assert.ok(Number.isFinite(v.lat) && Number.isFinite(v.lon));
});

check('lat/lon compatibility aliases are numeric, not strings', () => {
  const v = tracker.normalizeVehicle({ tripId: 't4', lat: '41.5', lon: '2.2' });
  assert.strictEqual(typeof v.lat, 'number');
  assert.strictEqual(typeof v.lon, 'number');
});

// ---------------------------------------------------------------------------
// 2. Router graph building preserves zero stop coordinates
// ---------------------------------------------------------------------------
console.log('\n[2] TransitRouter.buildGraph — zero stop coordinates');

// A stop whose `latitude` is legitimately 0 while `coords.lat` holds a
// different, non-zero value. The old `s.latitude || ...` chain silently
// returned 41.5 here; `??` correctly returns 0.
const zeroStopRoutes = {
  '1': [
    {
      name: 'L1 test',
      stops: [
        { id: '1', name: 'Zero Origin', latitude: 0, longitude: 0, coords: { lat: 41.54, lon: 2.44 } },
        { id: '2', name: 'Zero Destination', latitude: 0, longitude: 0 }
      ],
      coords: [
        { Latitude: 0, Longitude: 0 },
        { Latitude: 0, Longitude: 2.44 },
        { Latitude: 41.54, Longitude: 0 }
      ]
    }
  ]
};

transitRouter.setTracker(fakeTracker({ routesData: zeroStopRoutes }));

check('a legitimate 0 latitude is not overridden by a conflicting coords.lat', () => {
  const graph = transitRouter.routesGraph;
  assert.ok(graph.length > 0, 'expected the graph to build');
  const first = graph[0].stops[0];
  assert.strictEqual(first.lat, 0, `expected 0, got ${first.lat} (|| chain regression?)`);
  assert.strictEqual(first.lon, 0, `expected 0, got ${first.lon}`);
});

check('polyline points keep their 0 coordinate', () => {
  const coords = transitRouter.routesGraph[0].coords;
  assert.ok(coords.length >= 3, `expected 3 polyline points, got ${coords.length}`);
  assert.strictEqual(coords[0][0], 0, 'first polyline lat should be 0');
  assert.strictEqual(coords[0][1], 0, 'first polyline lon should be 0');
});

check('no NaN leaks into the route graph', () => {
  for (const route of transitRouter.routesGraph) {
    for (const stop of route.stops) {
      assert.ok(Number.isFinite(stop.lat), `stop ${stop.id} has non-finite lat`);
      assert.ok(Number.isFinite(stop.lon), `stop ${stop.id} has non-finite lon`);
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Coordinate-order convention: internal geometry is [lat, lon]
// ---------------------------------------------------------------------------
console.log('\n[3] Coordinate order — internal geometry is [lat, lon]');

check('graph polyline points are [lat, lon], not [lon, lat]', () => {
  const coords = transitRouter.routesGraph[0].coords;
  // Mataró is lon ~2.2, lat ~41.5. If the order were flipped, the 41.54
  // value would land in index 1 where it is not a valid longitude.
  const mataroPoint = coords.find(c => c[0] > 40);
  assert.ok(mataroPoint, 'expected a point near latitude 41.5');
  assert.strictEqual(mataroPoint[0], 41.54, 'latitude must occupy index 0');
  assert.ok(Math.abs(mataroPoint[1]) <= 180, `index 1 must be a valid longitude, got ${mataroPoint[1]}`);
  assert.ok(Math.abs(mataroPoint[1]) < 90, 'a 41.54 longitude would indicate flipped order');
  for (const c of coords) {
    assert.ok(Math.abs(c[0]) <= 90, `index 0 must be a valid latitude, got ${c[0]}`);
    assert.ok(Math.abs(c[1]) <= 180, `index 1 must be a valid longitude, got ${c[1]}`);
  }
});

// ---------------------------------------------------------------------------
// 4. Stop lookup preserves zero coordinates
// ---------------------------------------------------------------------------
console.log('\n[4] Stop resolution — zero preservation');

check('nearby-stop search finds a stop positioned at 0,0', () => {
  const stops = new Map();
  stops.set('1', { id: '1', name: 'Zero Stop', lat: 0, lon: 0 });
  transitRouter.setTracker(fakeTracker({ routesData: {}, allStopsMap: stops }));

  const found = transitRouter._resolveStopCandidates({ lat: 0, lon: 0, radiusMeters: 500 });
  assert.ok(found.length > 0, 'expected the stop at 0,0 to be found');
  assert.strictEqual(found[0].lat, 0);
  assert.strictEqual(found[0].lon, 0);
});

check('walking minutes are finite for a stop at 0,0', () => {
  const stops = new Map();
  stops.set('1', { id: '1', name: 'Zero Stop', lat: 0, lon: 0 });
  transitRouter.setTracker(fakeTracker({ routesData: {}, allStopsMap: stops }));

  const found = transitRouter._resolveStopCandidates({ lat: 0.001, lon: 0, radiusMeters: 500 });
  assert.ok(found.length > 0, 'expected a nearby match');
  assert.ok(Number.isFinite(found[0].walkingMinutes), 'walkingMinutes must be finite');
  assert.ok(found[0].distanceMeters >= 0, 'distance must not be negative');
});

// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(60)}`);
console.log(`Coordinate invariants: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
