/**
 * test/gps_gap_buses_test.js
 *
 * Which buses lose GPS the most (src/core/geo/gapBuses.js, the "Quins busos
 * el perden més" block on /dades).
 *  1. The chance of n or more losses when λ are expected (Poisson tail).
 *  2. Each bus against the others on its lines, per stop served: far above
 *     them and unlikely by chance is "suspect", above them but possibly
 *     chance is "watch", in line is "normal", under 3 losses is "few";
 *     buses without a fleet number are left out.
 *  3. getGpsGapHotspots returns the ranking and the fleet in service, and
 *     one picked bus narrows the map but not the ranking.
 *  4. Wiring: worker, API and page.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-gap-buses-'));
process.env.DB_PATH = path.join(scratch, 'history.db');
process.env.REPORTS_DIR = path.join(scratch, 'reports');

const { rankBuses, poissonTail } = require('../src/core/geo/gapBuses');
const historyDb = require('../src/historyDb');
const ok = msg => console.log(`  ✓ ${msg}`);

(async () => {
  console.log('🧪 Testing which buses lose GPS the most...');

  // ── 1. Poisson tail ────────────────────────────────────────────────
  {
    assert.equal(poissonTail(0, 3), 1, 'zero or more is certain');
    assert.ok(Math.abs(poissonTail(1, 2) - (1 - Math.exp(-2))) < 1e-12, 'one or more is 1 - e^-λ');
    assert.ok(Math.abs(poissonTail(6, 2.4) - 0.0357) < 0.001, `6 or more when 2.4 are expected: ${poissonTail(6, 2.4).toFixed(4)}`);
    assert.equal(poissonTail(3, 0), 0, 'nothing expected, nothing happens');
    ok('the chance of n or more losses by luck');
  }

  // ── 2. Each bus against its line colleagues ────────────────────────
  {
    const gaps = [];
    const visits = [];
    let id = 1;
    const add = (vehicleId, lineCode, n, shared = false) => {
      for (let k = 0; k < n; k++) gaps.push({ id: id++, vehicleId, lineCode, gapSec: 120 + k, shared });
    };
    // L3: five buses, 100 stops each. 2701 loses GPS 12 times, the rest 2.
    for (const v of ['2701', '2702', '2703', '2704', '2705']) visits.push({ vehicleId: v, lineCode: 'L3', n: 100 });
    add('2701', 'L3', 12);
    for (const v of ['2702', '2703', '2704', '2705']) add(v, 'L3', 2, true);
    // L1: three buses with 4, 3 and 3 losses on 100 stops each: in line.
    for (const v of ['2711', '2712', '2713']) visits.push({ vehicleId: v, lineCode: 'L1', n: 100 });
    add('2711', 'L1', 4, true); add('2712', 'L1', 3, true); add('2713', 'L1', 3, true);
    // L5: 2721 has 5 losses where its colleagues have 1 and 1 on few stops.
    for (const v of ['2721', '2722', '2723']) visits.push({ vehicleId: v, lineCode: 'L5', n: 15 });
    add('2721', 'L5', 5); add('2722', 'L5', 1); add('2723', 'L5', 1);
    // A placeholder id (no fleet number) and a bus in service with no loss.
    add('Bus', 'L3', 9);
    visits.push({ vehicleId: 'Bus', lineCode: 'L3', n: 500 });
    visits.push({ vehicleId: '2730', lineCode: 'L7', n: 80 });

    const r = rankBuses(gaps, visits);
    const by = Object.fromEntries(r.buses.map(b => [b.vehicleId, b]));
    assert.ok(!by.Bus, 'no fleet number, no row');
    assert.equal(r.buses[0].vehicleId, '2701', 'the outlier comes first');
    assert.equal(by['2701'].verdict, 'suspect', '12 losses where its L3 colleagues have 2 each');
    assert.equal(by['2701'].per100, 12);
    assert.equal(by['2701'].expected, 4, 'expected: 100 stops × 20 losses / 500 stops');
    assert.equal(by['2701'].ratio, 3);
    assert.ok(by['2701'].pValue < 0.05);
    assert.equal(by['2701'].sharedPct, 0, 'nobody else lost GPS where it did');
    assert.equal(by['2702'].verdict, 'few', '2 losses say nothing');
    assert.equal(by['2711'].verdict, 'normal', '4 losses where the L1 average is 3.3');
    assert.equal(by['2711'].sharedPct, 100);
    assert.equal(by['2721'].verdict, 'watch', '2.1× its colleagues, but on 15 stops it can be chance');
    assert.ok(by['2721'].pValue >= 0.05);
    assert.deepEqual([r.inService, r.withoutLoss], [12, 1], '12 fleet buses served stops, 2730 never lost GPS');
    const order = r.buses.map(b => b.verdict);
    assert.deepEqual(order, [...order].sort((a, b) => ['suspect', 'watch', 'normal', 'few'].indexOf(a) - ['suspect', 'watch', 'normal', 'few'].indexOf(b)), 'suspects, then watch, normal, few');
    ok('each bus against its line colleagues: suspect, watch, normal, few');
  }

  // ── 3. From the database ───────────────────────────────────────────
  {
    historyDb.init(process.env.DB_PATH);
    const now = Date.now();
    const visit = historyDb.db.prepare(`INSERT INTO stop_visits (vehicle_id, line_code, direction, stop_name, first_ts, last_ts, delay_mins, sample_count)
      VALUES (?, ?, '0', ?, ?, ?, 0, 1)`);
    for (const v of ['2687', '2665', '2676']) {
      for (let k = 0; k < 50; k++) visit.run(v, 'L3', `Parada ${k}`, now - 3600000 + k * 1000, now - 3600000 + k * 1000);
    }
    // 2687 loses GPS at six different places; 2665 and 2676 once each, at the same spot.
    const gap = (vehicleId, k, lat, lon) => historyDb.recordGpsGap({ vehicleId, lineCode: 'L3', direction: '0', lostTs: now - 3000000 + k * 60000,
      regainedTs: now - 3000000 + k * 60000 + 150000, gapSec: 150, lostLat: lat, lostLon: lon, regainedLat: lat + 0.002, regainedLon: lon, stopName: 'Prova' });
    for (let k = 0; k < 6; k++) gap('2687', k, 41.53 + k * 0.004, 2.43);
    gap('2665', 7, 41.56, 2.46); gap('2676', 8, 41.5601, 2.4601);

    const all = historyDb.getGpsGapHotspots({ days: 7, now: now + 1000 });
    assert.equal(all.buses[0].vehicleId, '2687');
    assert.equal(all.buses[0].visits, 50);
    assert.equal(all.buses[0].sharedPct, 0);
    assert.equal(all.buses.find(b => b.vehicleId === '2665').sharedPct, 100, 'lost where 2676 lost it too');
    assert.deepEqual(all.fleet, { inService: 3, withoutLoss: 0 });
    assert.equal(all.gaps[0].vehicleId !== undefined, true, 'map lines carry the bus');

    const one = historyDb.getGpsGapHotspots({ days: 7, vehicleId: '2687', now: now + 1000 });
    assert.equal(one.vehicleId, '2687');
    assert.equal(one.totals.mapped, 6, 'the map shows its 6 losses');
    assert.ok(one.cells.every(c => c.vehicles === 1));
    assert.deepEqual(one.buses, all.buses, 'the ranking still compares every bus');
    assert.equal(historyDb.getGpsGapHotspots({ days: 7, vehicleId: "1' OR 1=1", now: now + 1000 }).vehicleId, '', 'only a fleet number narrows the map');
    historyDb.close();
    ok('the hotspots answer carries the ranking; one bus narrows the map only');
  }

  // ── 4. Wiring ──────────────────────────────────────────────────────
  {
    const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(read('src/workers/ingestionWorker.js').includes('vehicleId: args.vehicleId'), 'the worker passes the bus');
    const server = read('server.js');
    assert.ok(/const vehicleId = \/\^\\d\{3,6\}\$\/\.test\(rawVehicle\)/.test(server), 'the API takes a fleet number only');
    assert.ok(server.includes("historyQuery('getGpsGapHotspots', { days, lineCode, vehicleId }"), 'and asks the worker for it');
    const dades = read('public/dades.html');
    assert.ok(dades.includes('id="gps-gaps-buses"') && dades.indexOf('id="gps-gaps-buses"') > dades.indexOf('id="gps-gaps-list"'), 'the bus block sits under the map');
    const obs = read('public/js/observatori.js');
    assert.ok(obs.includes('renderGpsGapBuses(data) {') && obs.includes('data-gps-bus="') && obs.includes('&vehicle='), 'the page lists the buses and narrows the map to one');
    ok('worker, API and page carry the per-bus comparison');
  }

  console.log('🎉 ALL GPS GAP BUS ASSERTIONS PASSED!');
})().finally(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
}).then(() => process.exit(0)).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
