/**
 * test/gps_gap_min_filter_test.js
 *
 * "On perden el GPS" on /dades: a slider keeps only the points with at least
 * N losses, from 1 to the busiest point of the loaded answer.
 *  1. Every drawn loss names its hotspot (`cell`, an index into `cells`), so
 *     the dashed streets can be filtered with the circles; losses whose
 *     hotspot is not sent read null. No internal field leaks.
 *  2. The slider follows each answer (max = busiest point, a higher choice is
 *     lowered), hides while no point repeats, filters circles, list and
 *     dashed streets without a new request or a new bus ranking, and the
 *     summary keeps the totals of the whole answer.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-gps-min-'));
const dbPath = process.env.DB_PATH || path.join(scratch, 'history.db');
const historyDb = require('../src/historyDb');
const ok = (msg) => console.log(`  ✓ ${msg}`);

try {
  // ── 1. Each loss names its hotspot ──────────────────────────────────
  historyDb.init(dbPath);
  const now = Date.now();
  const rec = (vehicleId, lineCode, minsAgo, lat, lon, stopName) => historyDb.recordGpsGap({
    vehicleId, lineCode, direction: '1', lostTs: now - minsAgo * 60000, regainedTs: now - minsAgo * 60000 + 150000, gapSec: 150,
    lostLat: lat, lostLon: lon, regainedLat: lat + 0.004, regainedLon: lon + 0.004, stopName
  });
  // Rodalies x4 (2 buses), Sant Isidor x2, Perú x1: three hotspots far apart.
  rec('2679', 'L1', 10, 41.53940, 2.44986, 'Rodalies');
  rec('2679', 'L1', 70, 41.53945, 2.44990, 'Rodalies');
  rec('2661', 'L2', 130, 41.53938, 2.44980, 'Rodalies');
  rec('2661', 'L2', 190, 41.53942, 2.44984, 'Rodalies');
  rec('2673', 'L1', 20, 41.55000, 2.42000, 'Sant Isidor');
  rec('2673', 'L1', 80, 41.55003, 2.42004, 'Sant Isidor');
  rec('2680', 'L2', 30, 41.56000, 2.43000, 'Perú');

  for (const q of [{ days: 7, now }, { days: 7, now, lineCode: 'L1' }]) {
    const r = historyDb.getGpsGapHotspots(q);
    assert.ok(r.cells.length >= 2, 'hotspots built');
    for (const c of r.cells) assert.equal(c.memberIds, undefined, 'the member list stays server-side');
    for (const g of r.gaps) {
      assert.ok(Number.isInteger(g.cell) && g.cell >= 0 && g.cell < r.cells.length, 'each loss names a sent hotspot');
      const c = r.cells[g.cell];
      assert.ok(Math.abs(c.lat - g.lostLat) < 0.002 && Math.abs(c.lon - g.lostLon) < 0.002, 'and it is the hotspot where it was lost');
    }
    r.cells.forEach((c, i) => assert.equal(r.gaps.filter(g => g.cell === i).length, c.count, 'every loss of a hotspot is tagged with it'));
  }
  ok('every drawn loss names its hotspot, on all lines and on one line');

  // ── 2. The slider ──────────────────────────────────────────────────
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'observatori.js'), 'utf8').replace(/\r\n/g, '\n');
  const from = src.indexOf('  /**\n   * The minimum-losses slider');
  const to = src.indexOf('  focusGpsGapCell(');
  assert.ok(from > 0 && to > from, 'syncGpsGapMin and renderGpsGaps are in observatori.js');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dades.html'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(/id="gps-gaps-min-group"[^>]*hidden/.test(html), 'the slider starts hidden');
  assert.ok(/<input type="range" id="gps-gaps-min" min="1"/.test(html), 'the slider starts at 1');
  assert.ok(/<label for="gps-gaps-min">/.test(html), 'the slider has a label');

  const el = (extra = {}) => ({ hidden: false, innerHTML: '', textContent: '', value: '', max: '', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, ...extra });
  const dom = {};
  for (const id of ['gps-gaps-summary', 'gps-gaps-list', 'gps-gaps-empty', 'gps-gaps-min-group', 'gps-gaps-min', 'gps-gaps-min-value']) dom[id] = el();
  global.document = { getElementById: (id) => dom[id] || null };
  const drawn = { circles: [], lines: [], fits: 0 };
  const layer = () => ({ addTo() { return this; } });
  global.L = {
    polyline: (pts) => { drawn.lines.push(pts); return layer(); },
    circleMarker: (ll) => { drawn.circles.push(ll); return { ...layer(), on() {} }; }
  };
  const map = { invalidateSize() {}, fitBounds() { drawn.fits++; } };
  const Ui = new Function('return class { ' + src.slice(from, to) + ' }')();
  const ui = new Ui();
  Object.assign(ui, {
    gpsGapMin: 1,
    busRenders: 0,
    esc: (s) => String(s),
    fmtGapDuration: (s) => `${s} s`,
    lineChip: (c) => c,
    ensureGpsGapMap: () => map,
    clearGpsGapSelection() {},
    gpsGapMarkerStyle: () => ({}),
    renderGpsGapBuses() { this.busRenders++; },
    gpsGapLayer: { clearLayers() { drawn.circles = []; drawn.lines = []; } }
  });

  const data = historyDb.getGpsGapHotspots({ days: 7, now });
  const total = data.cells.length;
  ui.renderGpsGaps(data);
  assert.equal(dom['gps-gaps-min-group'].hidden, false, 'shown when a point repeats');
  assert.equal(dom['gps-gaps-min'].max, '4', 'max = the busiest point');
  assert.equal(dom['gps-gaps-min'].value, '1');
  assert.equal(drawn.circles.length, total);
  assert.equal(drawn.lines.length, 7);
  assert.equal(ui.busRenders, 1);
  const fullSummary = dom['gps-gaps-summary'].innerHTML;
  ok('at 1 every point and street is drawn (as before)');

  // Drag to 2: what the input handler does.
  ui.gpsGapMin = 2;
  ui.renderGpsGaps(ui._gpsGapData, { fit: false });
  assert.equal(drawn.circles.length, 2, 'Perú (1 loss) is hidden');
  assert.equal(drawn.lines.length, 6, 'and its dashed street');
  assert.equal(ui.gpsGapCells.length, 2, 'the clickable cells are the shown ones');
  assert.equal((dom['gps-gaps-list'].innerHTML.match(/data-gps-cell=/g) || []).length, 2, 'the list follows');
  assert.equal(drawn.fits, 1, 'dragging does not refit the map');
  assert.equal(ui.busRenders, 1, 'the bus ranking is not redrawn');
  assert.equal(dom['gps-gaps-min-value'].textContent, '2+');
  assert.ok(dom['gps-gaps-summary'].innerHTML.includes('<strong>7</strong> pèrdues'), 'totals stay those of the whole answer');
  assert.ok(dom['gps-gaps-summary'].innerHTML.includes(`només els 2 punts amb 2 pèrdues o més (de ${total})`), 'the summary says what the map keeps');
  assert.ok(!fullSummary.includes('pèrdues o més'), 'and says nothing at 1');
  ui.renderGpsGaps(ui._gpsGapData); // letting go
  assert.equal(drawn.fits, 2, 'letting go refits to what is left');

  ui.gpsGapMin = 4;
  ui.renderGpsGaps(ui._gpsGapData);
  assert.equal(drawn.circles.length, 1);
  assert.equal(drawn.lines.length, 4, 'only Rodalies streets');
  assert.ok(dom['gps-gaps-summary'].innerHTML.includes('només el punt amb 4 pèrdues o més'), 'one point reads in the singular');
  ok('raising the minimum hides the smaller points, their streets and rows, with no new ranking');

  // A narrower answer: the choice is lowered to its busiest point.
  const l1 = historyDb.getGpsGapHotspots({ days: 7, now, lineCode: 'L1' });
  ui.renderGpsGaps(l1);
  assert.equal(dom['gps-gaps-min'].max, '2', 'L1: Rodalies 2 and Sant Isidor 2');
  assert.equal(ui.gpsGapMin, 2, 'a choice above the new max is lowered to it');
  assert.equal(dom['gps-gaps-min'].value, '2');
  assert.equal(ui.busRenders, 2, 'a new answer redraws the ranking');

  const one = historyDb.getGpsGapHotspots({ days: 7, now, vehicleId: '2680' });
  ui.renderGpsGaps(one);
  assert.equal(dom['gps-gaps-min-group'].hidden, true, 'hidden when no point repeats');
  assert.equal(ui.gpsGapMin, 1);
  assert.equal(drawn.circles.length, 1);

  ui.renderGpsGaps(null);
  assert.equal(dom['gps-gaps-min-group'].hidden, true, 'hidden on a failed load');
  ok('the slider range follows each answer and hides when nothing repeats');

  console.log('GPS GAP MIN FILTER TEST PASSED');
} catch (err) {
  console.error('Test failed:', err);
  process.exitCode = 1;
} finally {
  historyDb.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
