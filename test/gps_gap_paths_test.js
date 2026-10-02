/**
 * test/gps_gap_paths_test.js
 *
 * GPS-loss hotspots grouped by distance, and the street each loss was driven
 * on (src/core/geo/gapClusters.js, src/core/geo/gapPath.js,
 * /api/analytics/gps-gaps/paths, the map on /dades).
 *  1. Losses within 100 m of a hotspot's centre are one hotspot, whatever
 *     grid line they straddle; a street of losses every 80 m does not chain
 *     into one long hotspot.
 *  2. The street driven without GPS is the stretch of the line's route from
 *     the lost point to the regained point, forward along the route; on a
 *     route that passes a street twice the right pass is chosen, a closed loop
 *     may wrap, and nothing drivable in the gap's time gives null.
 *  3. With the real L8 route: a loss and regain 400 m apart along it give a
 *     path that follows it.
 *  4. Wiring: hotspots carry gapIds, the worker and API serve paths, the page
 *     draws them when a circle opens.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-gap-paths-'));
process.env.DB_PATH = path.join(scratch, 'history.db');
process.env.REPORTS_DIR = path.join(scratch, 'reports');

const { clusterPoints, distanceM, RADIUS_M } = require('../src/core/geo/gapClusters');
const { gapPath } = require('../src/core/geo/gapPath');
const historyDb = require('../src/historyDb');
const ok = msg => console.log(`  ✓ ${msg}`);

// Metres to degrees at Mataró.
const M_LAT = 1 / 111195;
const M_LON = 1 / (111195 * Math.cos((41.54 * Math.PI) / 180));
const at = (lat, lon, dxM, dyM) => ({ lat: lat + dyM * M_LAT, lon: lon + dxM * M_LON });

(async () => {
  console.log('🧪 Testing GPS-loss hotspots and paths...');

  // ── 1. Distance grouping ───────────────────────────────────────────
  {
    assert.equal(RADIUS_M, 100);
    // 41.539350 / 2.449800 sit right on the old grid lines (0.00135, 0.0018):
    // two points 20 m apart either side of them were two cells.
    const base = { lat: 41.5395 - 0.0000005, lon: 2.4498 - 0.0000005 };
    const a = at(base.lat, base.lon, -10, -6);
    const b = at(base.lat, base.lon, 10, 6);
    assert.ok(Math.floor(a.lat / 0.00135) !== Math.floor(b.lat / 0.00135) || Math.floor(a.lon / 0.0018) !== Math.floor(b.lon / 0.0018), 'fixture straddles the old grid');
    assert.equal(clusterPoints([a, b]).length, 1, 'two losses 23 m apart are one hotspot');
    assert.equal(clusterPoints([a, at(a.lat, a.lon, 250, 0)]).length, 2, '250 m apart are two');

    const street = [0, 80, 160, 240, 320, 400, 480].map(x => at(41.54, 2.44, x, 0));
    const cs = clusterPoints(street);
    assert.ok(cs.length >= 3, `a street of losses every 80 m does not chain into one (${cs.length} hotspots)`);
    for (const c of cs) {
      const span = Math.max(...c.members.map(p => distanceM(c.lat, c.lon, p.lat, p.lon)));
      assert.ok(span <= 2 * RADIUS_M, `no hotspot reaches more than ${2 * RADIUS_M} m from its centre (${Math.round(span)})`);
    }
    assert.equal(cs.reduce((n, c) => n + c.members.length, 0), street.length, 'every loss is in exactly one hotspot');
    ok('losses within 100 m are one hotspot across grid lines; streets do not chain');
  }

  // ── 2. Path along a route ──────────────────────────────────────────
  {
    // An L-shaped route: 600 m east, then 600 m north.
    const o = { lat: 41.54, lon: 2.44 };
    const east = [0, 100, 200, 300, 400, 500, 600].map(x => at(o.lat, o.lon, x, 0));
    const north = [100, 200, 300, 400, 500, 600].map(y => at(o.lat, o.lon, 600, y));
    const route = [...east, ...north].map(p => ({ Latitude: String(p.lat), Longitude: String(p.lon) }));
    const lost = at(o.lat, o.lon, 450, 12);       // 12 m off the eastbound street
    const back = at(o.lat, o.lon, 590, 250);      // on the northbound street
    const r = gapPath(route, lost, back, 120);
    assert.ok(r, 'a path is found');
    assert.ok(Math.abs(r.lengthM - 400) <= 15, `it follows the streets round the corner (${r.lengthM} m, straight ${Math.round(distanceM(lost.lat, lost.lon, back.lat, back.lon))} m)`);
    const corner = at(o.lat, o.lon, 600, 0);
    assert.ok(r.path.some(([la, lo]) => distanceM(la, lo, corner.lat, corner.lon) < 1), 'and passes the corner');

    assert.equal(gapPath(route, back, lost, 120), null, 'backwards along the route is not a drive');
    assert.equal(gapPath(route, at(o.lat, o.lon, 0, 0), at(o.lat, o.lon, 600, 600), 30), null, '1.2 km in 30 s is not drivable');
    assert.equal(gapPath(route, at(o.lat, o.lon, 300, 300), back, 120), null, 'a point 300 m off the route is not on it');

    // Out and back on the same street: the right pass is the one in order.
    const outAndBack = [0, 100, 200, 300, 400, 300, 200, 100, 0].map(x => at(o.lat, o.lon, x, 0))
      .map(p => ({ lat: p.lat, lon: p.lon }));
    const r2 = gapPath(outAndBack, at(o.lat, o.lon, 350, 5), at(o.lat, o.lon, 150, 5), 120);
    assert.ok(r2 && Math.abs(r2.lengthM - 300) <= 15, `on the way back: 350 -> 400 -> 150 is ${r2 && r2.lengthM} m, not 200`);

    // A closed loop may wrap past its start.
    const loop = [[0, 0], [400, 0], [400, 400], [0, 400], [0, 0]].map(([x, y]) => at(o.lat, o.lon, x, y));
    const r3 = gapPath(loop, at(o.lat, o.lon, 0, 200), at(o.lat, o.lon, 200, 0), 120);
    assert.ok(r3 && Math.abs(r3.lengthM - 400) <= 15, `a closed loop wraps past its start (${r3 && r3.lengthM} m)`);
    ok('paths follow the route forward, pick the right pass, wrap loops, refuse the impossible');
  }

  // ── 3. Real L8 route ───────────────────────────────────────────────
  {
    const routes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cities', 'mataro', 'mataro_routes_full.json'), 'utf8'));
    const l8 = (routes['8'] || []).find(r => Array.isArray(r.coords) && r.coords.length > 50);
    assert.ok(l8, 'the L8 route is in the route file');
    const coords = l8.coords.map(c => ({ lat: Number(c.Latitude), lon: Number(c.Longitude) }));
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distanceM(coords[i - 1].lat, coords[i - 1].lon, coords[i].lat, coords[i].lon));
    const iA = cum.findIndex(d => d >= 1000);
    const iB = cum.findIndex(d => d >= 1400);
    const r = gapPath(l8.coords, coords[iA], coords[iB], 120);
    assert.ok(r && Math.abs(r.lengthM - (cum[iB] - cum[iA])) <= 5, `400 m along L8 is a ${r && r.lengthM} m path`);
    for (const [la, lo] of r.path) {
      const near = coords.some(c => distanceM(la, lo, c.lat, c.lon) < 60);
      assert.ok(near, 'every path point lies on the L8 route');
    }
    ok(`a loss 400 m along L8 is drawn along its route (${r.path.length} points)`);
  }

  // ── 4. Wiring ──────────────────────────────────────────────────────
  {
    historyDb.init(process.env.DB_PATH);
    const now = Date.now();
    const p = at(41.5394, 2.4499, 0, 0);
    for (let k = 0; k < 3; k++) {
      historyDb.recordGpsGap({ vehicleId: String(2670 + k), lineCode: 'L8', direction: '1', lostTs: now - (k + 1) * 60000, regainedTs: now - (k + 1) * 60000 + 120000, gapSec: 120,
        lostLat: p.lat + k * 0.0001, lostLon: p.lon, regainedLat: p.lat + 0.003, regainedLon: p.lon + 0.003, stopName: 'Can Marfà' });
    }
    const hs = historyDb.getGpsGapHotspots({ days: 7, now });
    assert.equal(hs.cells.length, 1, 'three losses 22 m apart are one hotspot');
    assert.equal(hs.cells[0].recurrent, true);
    assert.equal(hs.cells[0].gapIds.length, 3, 'the hotspot lists its gap ids');
    const rows = historyDb.getGpsGapsByIds([...hs.cells[0].gapIds, 'x', -1, 99999]);
    assert.equal(rows.length, 3, 'ids are validated and looked up');
    assert.equal(rows[0].direction, '1', 'with their direction');
    assert.ok(rows.every(r => Number.isFinite(r.lostTs) && r.vehicleId), 'and the bus and time each loss began');
    historyDb.close();

    const root = path.join(__dirname, '..');
    const read = f => fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(/case 'getGpsGapPaths':/.test(read('src/workers/ingestionWorker.js')), 'the worker cuts paths');
    assert.ok(read('server.js').includes("app.get('/api/analytics/gps-gaps/paths'"), 'the API serves them');
    const obs = read('public/js/observatori.js');
    assert.ok(obs.includes('this.selectGpsGapCell(i);') && obs.includes('this.showGpsGapPaths(c, detail);'), 'selecting a circle draws its streets');
    assert.ok(obs.includes('/api/analytics/gps-gaps/paths?ids='), 'from the API');
    assert.ok(obs.includes('data-gps-route') && obs.includes('data-gps-path='), 'the detail lists each bus, which highlights its street');
    assert.ok(obs.includes('vehicleId: g.vehicleId, lostTs: g.lostTs') || read('src/workers/ingestionWorker.js').includes('vehicleId: g.vehicleId, lostTs: g.lostTs'), 'paths carry the bus and the time');
    assert.ok(obs.includes('const widthOf = (code) => [8, 4, 2]'), 'lines sharing a street are drawn as nested stripes, not over each other');
    assert.ok(obs.includes("map.on('click', () => this.clearGpsGapSelection())"), 'a click on the map background clears them');
    ok('hotspots carry gap ids; worker, API and page draw the street of each bus on click, lines as nested stripes');
  }

  console.log('🎉 ALL GPS GAP PATH ASSERTIONS PASSED!');
})().finally(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
}).then(() => process.exit(0)).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
