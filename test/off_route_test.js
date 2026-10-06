/**
 * test/off_route_test.js
 *
 * A live bus off its route is shown where it is (src/mataroTracker.js,
 * flightRecorder, both maps). A late L5 bus that skipped stops and took a
 * shortcut was drawn on its route the whole time: every live fix was snapped
 * to the drawn route, however far away it was.
 *  1. A fresh fix more than 75 m from every direction of its line, twice in
 *     a row, keeps its real position and says offRoute / offRouteM; one fix
 *     (a GPS jump) or the same fix re-emitted does not.
 *  2. Near the other direction's route is not off route.
 *  3. Back on the route it is snapped again.
 *  4. The flag crosses the flight recorder and the maps stop snapping it.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mataroTracker = require('../src/mataroTracker');
const geoEngine = require('../src/core/geo/geoEngine');
const ok = msg => console.log(`  ✓ ${msg}`);

const M_LAT = 1 / 111195;
const M_LON = 1 / (111195 * Math.cos((41.54 * Math.PI) / 180));

(async () => {
  console.log('🧪 Testing buses off their route...');
  const routes = mataroTracker.routesData['5'];
  assert.ok(Array.isArray(routes) && routes.length === 2, 'L5 has two directions');
  const polys = routes.map(r => r.coords.map(c => ({ lat: +c.Latitude, lon: +c.Longitude })));
  const lineDist = (lat, lon) => Math.min(...polys.map(p => geoEngine.snapPointToPolyline(lat, lon, p).dist));

  // A point ~250 m from both L5 directions, east of the middle of direction 0.
  const mid = polys[0][Math.floor(polys[0].length / 2)];
  let off = null;
  for (let k = 1; k < 40 && !off; k++) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const p = { lat: mid.lat + dy * k * 50 * M_LAT, lon: mid.lon + dx * k * 50 * M_LON };
      const d = lineDist(p.lat, p.lon);
      if (d > 200 && d < 400) { off = p; break; }
    }
  }
  assert.ok(off, 'a point 200-400 m from L5 exists');

  const now = Date.now();
  let seq = 0;
  const fix = (p, fixAt, extra = {}) => ({
    vehicleId: '2671', lineId: '5', direction: '0', lat: p.lat, lon: p.lon, bearing: 90,
    speedKmh: 25, hasSpeed: true, delayMins: 9, hasDelay: true, isRealTime: true,
    timestamp: now, observedAt: fixAt, freshness: { source: 'position', fetchedAt: now, observedAt: fixAt }, ...extra
  });
  const run = (b) => mataroTracker.processBusesWithDeadReckoning([b], routes[0], routes[0].stops || [], '0', [b], new Date(now + (seq++)), routes)
    .find(x => x.vehicleId === '2671');
  mataroTracker.vehicleHistory.delete('2671');

  // ── 1. Two fresh fixes off the route ──────────────────────────────
  {
    const first = run(fix(off, now - 40000));
    assert.equal(first.offRoute, false, 'one fix off the route may be a GPS jump');
    assert.ok(lineDist(first.lat, first.lon) < 5, 'and is still drawn on the route');
    const again = run(fix(off, now - 40000));
    assert.equal(again.offRoute, false, 'the same fix re-emitted is not a second fix');
    const second = run(fix({ lat: off.lat + 20 * M_LAT, lon: off.lon }, now - 20000));
    assert.equal(second.offRoute, true, 'two fresh fixes off the route: off route');
    assert.ok(Math.abs(second.lat - (off.lat + 20 * M_LAT)) < 1e-5 && Math.abs(second.lon - off.lon) < 1e-5, 'shown where its GPS puts it');
    assert.ok(second.offRouteM > 75, `with how far: ${second.offRouteM} m`);
    assert.equal(second.latitude, second.lat, 'the lat/latitude aliases agree');
    ok(`two fresh fixes ${second.offRouteM} m away keep the real position; one fix or a re-emit does not`);
  }

  // ── 2. On the other direction's street ─────────────────────────────
  {
    mataroTracker.vehicleHistory.delete('2671');
    let other = null;
    for (const c of polys[1]) if (geoEngine.snapPointToPolyline(c.lat, c.lon, polys[0]).dist > 150) { other = c; break; }
    assert.ok(other, 'L5 directions part somewhere');
    run(fix(other, now - 30000));
    const r = run(fix(other, now - 10000));
    assert.equal(r.offRoute, false, 'on the other direction\'s route is not off the line');
    ok('a bus on the other direction\'s street is not off route');
  }

  // ── 3. Back on the route ───────────────────────────────────────────
  {
    mataroTracker.vehicleHistory.delete('2671');
    run(fix(off, now - 50000));
    assert.equal(run(fix(off, now - 30000)).offRoute, true);
    const near = polys[0][Math.floor(polys[0].length / 3)];
    const back = run(fix({ lat: near.lat + 15 * M_LAT, lon: near.lon }, now - 10000));
    assert.equal(back.offRoute, false, 'back within 75 m');
    assert.equal(back.offRouteM, null);
    assert.ok(lineDist(back.lat, back.lon) < 5, 'and snapped to the route again');
    mataroTracker.vehicleHistory.delete('2671');
    ok('back on the route it is snapped again');
  }

  // ── 4. Wiring ──────────────────────────────────────────────────────
  {
    const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const flightRecorder = require('../src/flightRecorder');
    flightRecorder.ingestVehicle({ vehicleId: '2671', lineCode: 'L5', lat: off.lat, lon: off.lon, observedAt: Date.now(), offRoute: true, offRouteM: 240 });
    const v = flightRecorder.getAllVehicles().find(x => x.vehicleId === '2671');
    assert.ok(v && v.offRoute === true && v.offRouteM === 240, 'the flight recorder keeps the flag');
    assert.ok(read('src/flightRecorder.js').includes('offRoute: Boolean(v.offRoute)'), 'and replicates it to the main process');
    assert.ok(read('src/ingestionDaemon.js').includes('offRoute: Boolean(b.offRoute)'), 'the daemon passes it on');
    assert.ok(read('src/mataroTracker.js').includes("'0', liveVehicles, targetDate, routes)"), 'the tracker compares with every direction');
    const map = read('public/js/map.js');
    assert.ok(map.includes('const followRoute = !bus.offRoute') && map.includes('targetPolyline: followRoute ? targetPolyline : null'), 'the line map does not snap it or glide it along the route');
    assert.ok(map.includes('map-popup-offroute-notice'), 'and its popup says so');
    assert.ok(read('public/js/networkMap.js').includes('const followRoute = !bus.offRoute'), 'nor does the network map');
    ok('the flag crosses the flight recorder; both maps show the real position');
  }

  console.log('🎉 ALL OFF-ROUTE ASSERTIONS PASSED!');
  process.exit(0);
})().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
