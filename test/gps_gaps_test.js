/**
 * test/gps_gaps_test.js
 *
 * Where buses lose GPS (src/core/geo/gpsGapDetector.js, gps_gaps in
 * historyDb, /api/analytics/gps-gaps, the map on /dades).
 *
 * The feed sends a fix about every 30 s. A silence of 90 s - 15 min between a
 * bus's real fixes is one gap, from the last fix before it to the first after.
 *  1. Only real evidence counts: a fix time that does not move forward
 *     (re-emit, dead reckoning) never opens or closes a gap.
 *  2. Out-of-service silences (> 15 min) and line changes are not gaps.
 *  3. A silence during which no other bus reported is the operator's feed
 *     stalling (feedWide); a bus at a terminal is flagged atTerminal. Both are
 *     stored and counted, but kept off the map.
 *  4. Hotspots group gaps into ~150 m cells; a cell is recurrent with 3+ gaps
 *     from 2+ buses. Line and period filters; pruning with the delay logs.
 *  5. The worker records what the detector finds during revenue service.
 *  6. A fix without a fleet number (the SIRI client's placeholder "Bus") names
 *     no bus and is ignored: two of them on one line looked like one bus.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-gps-gaps-'));
process.env.DB_PATH = path.join(scratch, 'history.db');
process.env.REPORTS_DIR = path.join(scratch, 'reports');

const { GpsGapDetector, MIN_GAP_MS, MAX_GAP_MS, isFleetId } = require('../src/core/geo/gpsGapDetector');
const historyDb = require('../src/historyDb');
const ok = msg => console.log(`  ✓ ${msg}`);

const T0 = Date.UTC(2026, 8, 30, 15, 0, 0); // Wed 30 Sep 2026 17:00 Madrid
const s = sec => T0 + sec * 1000;
const bus = (vehicleId, sec, lat, lon, extra = {}) => ({ vehicleId, lineCode: 'L8', direction: '1', lat, lon, observedAt: s(sec), toStop: 'Can Marfà', ...extra });

(async () => {
  console.log('🧪 Testing GPS gaps...');

  // ── 1-3. Detector ───────────────────────────────────────────────────
  {
    const d = new GpsGapDetector();
    assert.equal(MIN_GAP_MS, 90000);
    assert.equal(MAX_GAP_MS, 15 * 60000);
    // A second bus reporting every 30 s keeps the feed provably alive.
    const other = sec => d.observe(bus('2600', sec, 41.53, 2.43, { lineCode: 'L1' }));
    for (let t = 0; t <= 600; t += 30) other(t);

    assert.equal(d.observe(bus('2679', 0, 41.5390, 2.4500)), null, 'first fix opens nothing');
    assert.equal(d.observe(bus('2679', 30, 41.5392, 2.4503)), null, 'normal 30 s cadence');
    assert.equal(d.observe(bus('2679', 30, 41.5400, 2.4510)), null, 'a re-emit with the same fix time is not evidence');
    assert.equal(d.observe(bus('2679', 20, 41.5400, 2.4510)), null, 'an older fix time is not evidence');
    assert.equal(d.observe(bus('2679', 90, 41.5394, 2.4506)), null, '60 s is one missed report, not a gap');
    const gap = d.observe(bus('2679', 300, 41.5420, 2.4560, { toStop: 'Sant Simó' }));
    assert.ok(gap, '210 s of silence is a gap');
    assert.equal(gap.gapSec, 210);
    assert.deepEqual([gap.lostLat, gap.lostLon, gap.regainedLat, gap.regainedLon], [41.5394, 2.4506, 41.542, 2.456]);
    assert.equal(gap.lostTs, s(90));
    assert.equal(gap.regainedTs, s(300));
    assert.equal(gap.stopName, 'Can Marfà', 'named after the stop the bus was heading to when it went silent');
    assert.equal(gap.lineCode, 'L8');
    assert.equal(gap.feedWide, false, 'bus 2600 kept reporting, so the feed was alive');
    assert.equal(gap.atTerminal, false);
    ok('a 210 s silence is one gap from the last fix to the next; 60 s and re-emits are not');

    assert.equal(d.observe(bus('2679', 300 + 16 * 60, 41.55, 2.46)), null, 'longer than 15 min is out of service');
    d.observe(bus('2690', 0, 41.54, 2.44, { lineCode: 'L5' }));
    assert.equal(d.observe(bus('2690', 200, 41.54, 2.44, { lineCode: 'L3' })), null, 'a bus that changed line was reassigned');
    ok('out-of-service silences and line changes are not gaps');

    const alone = new GpsGapDetector();
    alone.observe(bus('2661', 0, 41.53, 2.44));
    alone.observe(bus('2662', 5, 41.52, 2.43));
    alone.observe(bus('2662', 150, 41.52, 2.43));
    const stalled = alone.observe(bus('2661', 150, 41.531, 2.441));
    assert.equal(stalled.feedWide, true, 'nobody else reported in the silence: the feed stalled');
    const term = alone.observe(bus('2662', 300, 41.52, 2.43, { isTerminalLayover: true }));
    assert.equal(term.atTerminal, true, 'a bus at a terminal is flagged');
    ok('feed-wide stalls and terminal layovers are flagged');

    const many = new GpsGapDetector();
    for (let i = 0; i < 50; i++) many.observe(bus(`V${i}`, i, 41.5, 2.4));
    many.observe(bus('2699', 3600, 41.5, 2.4));
    assert.equal(many.last.size, 1, 'vehicles not seen for 20 min are forgotten');
    assert.ok(many.fixTimes.length <= 1, 'old fix times are dropped');
    ok('memory is bounded');

    // A fix without <VehicleRef> is labelled 'Bus' by the SIRI client; two of
    // them on one line must not be read as one bus with a gap between them.
    const anon = new GpsGapDetector();
    const ghost = (sec, lat) => anon.observe(bus('Bus', sec, lat, 2.44));
    anon.observe(bus('2600', 0, 41.53, 2.43));
    for (let t = 30; t <= 300; t += 30) anon.observe(bus('2600', t, 41.53, 2.43));
    assert.equal(ghost(0, 41.52), null);
    assert.equal(ghost(200, 41.55), null, 'a placeholder id never opens or closes a gap');
    assert.equal(anon.last.has('Bus'), false, 'and is not remembered');
    for (const id of ['', '  ', 'Bus', 'bus', 'mataro_bus']) assert.equal(isFleetId(id), false, `"${id}" names no bus`);
    for (const id of ['2679', 'mataro_8_2679', 'EST_8_1_1700']) assert.equal(isFleetId(id), true);
    ok('fixes without a fleet number (the placeholder "Bus") are ignored');
  }

  // ── 4. Storage and hotspots ─────────────────────────────────────────
  historyDb.init(process.env.DB_PATH);
  const now = Date.now();
  const rec = (vehicleId, lineCode, minsAgo, lat, lon, extra = {}) => historyDb.recordGpsGap({
    vehicleId, lineCode, direction: '1', lostTs: now - minsAgo * 60000, regainedTs: now - minsAgo * 60000 + 150000, gapSec: 150,
    lostLat: lat, lostLon: lon, regainedLat: lat + 0.004, regainedLon: lon + 0.004, stopName: 'Can Marfà', ...extra
  });
  // Can Marfà: 3 gaps from 2 buses within a few metres -> recurrent.
  rec('2679', 'L8', 10, 41.53940, 2.44986);
  rec('2679', 'L8', 70, 41.53945, 2.44990);
  rec('2661', 'L3', 130, 41.53938, 2.44980, { gapSec: 300 });
  // One-off elsewhere, plus excluded kinds.
  rec('2673', 'L1', 20, 41.5500, 2.4200, { stopName: 'Hospital de Mataró' });
  rec('2673', 'L1', 25, 41.5500, 2.4200, { atTerminal: true });
  rec('2680', 'L1', 30, 41.5600, 2.4300, { feedWide: true });
  // Older than a day, younger than a week; and older than 30 days.
  rec('2670', 'L2', 3 * 1440, 41.5450, 2.4400, { stopName: 'Pl. Gatassa' });
  historyDb.db.prepare('INSERT INTO gps_gaps (vehicle_id, line_code, lost_ts, regained_ts, gap_sec, lost_lat, lost_lon, regained_lat, regained_lon) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('2600', 'L4', now - 40 * 86400000, now - 40 * 86400000 + 100000, 100, 41.5, 2.4, 41.5, 2.4);

  const week = historyDb.getGpsGapHotspots({ days: 7, now });
  assert.equal(week.totals.gaps, 7, 'every gap in the week is counted');
  assert.equal(week.totals.mapped, 5, 'terminal and feed-wide gaps are left off the map');
  assert.equal(week.totals.atTerminal, 1);
  assert.equal(week.totals.feedWide, 1);
  assert.equal(week.totals.vehicles, 4);
  const top = week.cells[0];
  assert.equal(top.count, 3);
  assert.equal(top.vehicles, 2);
  assert.equal(top.recurrent, true, '3 gaps from 2 buses is a recurrent point');
  assert.deepEqual(top.lines, ['L3', 'L8']);
  assert.equal(top.stopName, 'Can Marfà');
  assert.equal(top.medianGapSec, 150);
  assert.equal(top.maxGapSec, 300);
  assert.ok(Math.abs(top.lat - 41.53941) < 0.0001 && Math.abs(top.lon - 2.44985) < 0.0001, 'the cell sits at the mean lost position');
  assert.equal(week.cells.length, 3);
  assert.ok(week.cells.slice(1).every(c => !c.recurrent && c.count === 1));
  assert.equal(week.totals.recurrentShare, 60, '3 of 5 mapped gaps are in recurrent points');
  assert.equal(week.gaps.length, 5);
  ok('hotspots: Can Marfà is recurrent (3 gaps, 2 buses, 60 % of the week); terminal and feed stalls excluded');

  const day = historyDb.getGpsGapHotspots({ days: 1, now });
  assert.equal(day.totals.mapped, 4, 'the 3-day-old gap is outside 24 h');
  const l8 = historyDb.getGpsGapHotspots({ days: 7, lineCode: '8', now });
  assert.equal(l8.lineCode, 'L8');
  assert.equal(l8.totals.mapped, 2);
  assert.equal(l8.cells[0].recurrent, false, 'on L8 alone the point has one bus');
  assert.equal(historyDb.getGpsGapHotspots({ days: 7, lineCode: 'all', now }).totals.mapped, 5);
  assert.equal(historyDb.getGpsGapHotspots({ days: 999, now }).days, 30, 'the period is capped at 30 days');
  ok('period and line filters');

  historyDb.pruneOldRecords(30);
  assert.equal(historyDb.db.prepare('SELECT COUNT(*) AS n FROM gps_gaps').get().n, 7, 'a 40-day-old gap is pruned with the delay logs');
  ok('pruned after 30 days');

  // ── 5. The worker records gaps it detects ───────────────────────────
  {
    const mataroTracker = require('../src/mataroTracker');
    const ingestionDaemon = require('../src/ingestionDaemon');
    const recorded = [];
    const origDetails = mataroTracker.getLineDetails;
    const origRecord = historyDb.recordGpsGap;
    const origOutside = ingestionDaemon.isOutsideRevenueService;
    let fixAt = s(0);
    let feedAt = s(0);
    mataroTracker.getLineDetails = async (lId) => ({
      activeBuses: lId === '8'
        ? [{ vehicleId: '2679', lineId: '8', direction: '1', lat: 41.5394, lon: 2.4506, observedAt: fixAt, toStop: 'Can Marfà', isEstimated: false },
          { vehicleId: '2600', lineId: '8', direction: '0', lat: 41.53, lon: 2.43, observedAt: feedAt, isEstimated: false },
          { vehicleId: 'EST_8_1_1700', lineId: '8', direction: '1', lat: 41.5, lon: 2.4, isGhostVehicle: true }]
        : []
    });
    historyDb.recordGpsGap = gap => recorded.push(gap);
    ingestionDaemon.isOutsideRevenueService = () => false;
    try {
      await ingestionDaemon.pollMataroVehicles();
      for (const t of [30, 60, 90, 120, 150]) { feedAt = s(t); await ingestionDaemon.pollMataroVehicles(); }
      fixAt = s(150);
      await ingestionDaemon.pollMataroVehicles();
      assert.equal(recorded.length, 1, 'one gap recorded');
      assert.equal(recorded[0].vehicleId, '2679');
      assert.equal(recorded[0].lineCode, 'L8');
      assert.equal(recorded[0].gapSec, 150);
      assert.equal(recorded[0].feedWide, false);
      ingestionDaemon.isOutsideRevenueService = () => true;
      fixAt = s(400);
      await ingestionDaemon.pollMataroVehicles();
      assert.equal(recorded.length, 1, 'nothing is recorded outside revenue service');
    } finally {
      mataroTracker.getLineDetails = origDetails;
      historyDb.recordGpsGap = origRecord;
      ingestionDaemon.isOutsideRevenueService = origOutside;
      ingestionDaemon.flushAllVisits();
    }
    ok('the worker records a 150 s silence of bus 2679 on L8, and none outside service hours');
  }

  // ── 6. Wiring ───────────────────────────────────────────────────────
  {
    const root = path.join(__dirname, '..');
    const read = f => fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(/case 'getGpsGapHotspots':/.test(read('src/workers/ingestionWorker.js')), 'the worker answers getGpsGapHotspots');
    assert.ok(read('server.js').includes("app.get('/api/analytics/gps-gaps'"), 'the API route exists');
    assert.ok(!/require\(['"]\.\/src\/historyDb['"]\)/.test(read('server.js')), 'the HTTP process still never opens SQLite');
    const dades = read('public/dades.html');
    assert.ok(dades.includes('id="gps-gaps-map"') && dades.includes('unpkg.com/leaflet@1.9.4/dist/leaflet.js'), '/dades has the map and loads Leaflet');
    assert.ok(dades.indexOf('leaflet.js') < dades.indexOf('/js/observatori.js'), 'Leaflet loads before observatori.js');
    ok('worker op, API route and /dades map are wired');

    // The map: wheel zoom on, a popup with its own width and padding, and a
    // map box that stretches to the list's height (no empty band under it).
    const obs = read('public/js/observatori.js');
    const css = read('public/css/style.css');
    assert.ok(!/scrollWheelZoom:\s*false/.test(obs), 'the GPS map zooms with the mouse wheel');
    assert.ok(obs.includes("className: 'gps-gaps-leaflet-popup'"), 'the popup has its own class');
    assert.ok(/\.gps-gaps-leaflet-popup \.leaflet-popup-content \{[^}]*width: auto !important/.test(css), 'it is not forced to the bus popup\'s 330px');
    assert.ok(/\.gps-gaps-popup \{[^}]*padding: var\(--space-5\)/.test(css), 'its content is padded');
    assert.ok(/\.gps-gaps-layout \{[^}]*align-items: stretch/.test(css) && /\.gps-gaps-map-box \{[^}]*flex: 1 1 auto/.test(css), 'the map stretches to the list');
    assert.ok(dades.includes('<div class="gps-gaps-map-box">'), 'the map sits in its stretching box');
    assert.ok(!/observatori-line-badge" style=/.test(obs.slice(obs.indexOf('renderGpsGaps('), obs.indexOf('focusGpsGapCell('))), 'line badges use .line-chip, not inline colours');
    ok('wheel zoom, padded popup, map as tall as the list, token line chips');
  }

  console.log('🎉 ALL GPS GAP ASSERTIONS PASSED!');
})().finally(() => {
  historyDb.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}).then(() => process.exit(0)).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
