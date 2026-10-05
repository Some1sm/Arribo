/**
 * test/gps_gap_period_layout_test.js
 *
 * /dades: one period selector, and the GPS map below the delays.
 *  1. "On perden el GPS" has no 24 h / 7 dies / 30 dies buttons of its own:
 *     it follows the report's tab (24 h -> 1 day, 48 h -> 2, 7 dies -> 7),
 *     reloading only once it has been loaded and only when the days change.
 *  2. Order on the page: the delay report, then the GPS map, then the
 *     operator comparison ("Comparativa per Empresa Operadora"), which the
 *     report renders into its own container and which hides with the map.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n');
const ok = (msg) => console.log(`  ✓ ${msg}`);

try {
  const html = read('public/dades.html');
  const css = read('public/css/style.css');
  const src = read('public/js/observatori.js');
  const body = (name) => {
    let at = src.indexOf(`\n  ${name}(`);
    if (at < 0) at = src.indexOf(`\n  async ${name}(`);
    assert.ok(at > 0, `${name} exists`);
    const end = src.indexOf('\n  }\n', at);
    return src.slice(at, end + 4);
  };

  // ── 1. One period selector ─────────────────────────────────────────
  assert.ok(!html.includes('data-gps-days'), 'no period buttons on the GPS map');
  assert.ok(!html.includes('id="gps-gaps-days"'), 'nor their group');
  assert.ok(!css.includes('#gps-gaps-days'), 'nor their styles');
  assert.ok(!src.includes('data-gps-days'), 'nor their click handling');
  assert.ok(body('loadJournalismReport').includes('this.setGpsGapPeriod(hours)'), 'the report tab sets the map period');

  const Ui = new Function('return class { ' + body('setGpsGapPeriod') + ' }')();
  const ui = new Ui();
  let loads = 0;
  ui.loadGpsGaps = () => { loads++; };
  ui.gpsGapDays = 7;
  ui.gpsGapVehicle = '2679';
  ui.setGpsGapPeriod(24);
  assert.equal(ui.gpsGapDays, 1, '24 h -> 1 day');
  assert.equal(loads, 0, 'not loaded before the map is first shown');
  ui._gpsGapReq = 1;
  ui.setGpsGapPeriod(48);
  assert.equal(ui.gpsGapDays, 2, '48 h -> 2 days');
  assert.equal(loads, 1, 'reloaded once the map has loaded');
  assert.equal(ui.gpsGapVehicle, '', 'a picked bus is cleared with the period');
  ui.setGpsGapPeriod(48);
  assert.equal(loads, 1, 'the same period does not reload');
  ui.setGpsGapPeriod(168);
  assert.equal(ui.gpsGapDays, 7, '7 dies -> 7 days');
  ui.setGpsGapPeriod(undefined);
  assert.equal(ui.gpsGapDays, 1, 'no hours reads as 24 h');
  assert.ok(body('initGpsGaps').includes('this.currentHours'), 'the first load uses the report period too');
  ok('the GPS map follows the report tab (24 h / 48 h / 7 dies) and has no period buttons');

  // ── 2. Order and the operator comparison ───────────────────────────
  const report = html.indexOf('id="journalism-content-container"');
  const gps = html.indexOf('id="gps-gaps-section"');
  const operators = html.indexOf('id="journalism-operators-container"');
  assert.ok(report > 0 && gps > report && operators > gps, 'report, then GPS map, then operator comparison');
  assert.ok(html.indexOf('id="data-health-container"') < report, 'data health stays above the report');

  const render = body('renderJournalismReport');
  const marker = '<!-- Ranking: Operators Performance -->';
  assert.equal(render.split(`\n      ${marker}\n`).length, 2, 'the operator block is marked once in the report');
  assert.ok(render.includes(`html.indexOf('${marker}')`), 'and the split looks for that marker');
  assert.ok(render.indexOf(`\n      ${marker}\n`) < render.indexOf('Comparativa per Empresa Operadora'), 'which opens the comparison');
  assert.ok(/operators\.innerHTML = html\.slice\(operatorsAt\)/.test(render), 'it renders into its own container');
  assert.ok(render.indexOf('html = html.slice(0, operatorsAt)') < render.indexOf('container.innerHTML = html'), 'and leaves the report container');

  const load = body('loadJournalismReport');
  assert.equal(load.split('this.clearOperatorComparison()').length, 3, 'no report (no data or an error) clears the comparison');

  const dom = { 'gps-gaps-section': { style: {} }, 'journalism-operators-container': { style: {}, innerHTML: '<table>' } };
  global.document = { getElementById: (id) => dom[id] || null };
  const Show = new Function('return class { ' + body('showGpsGaps') + body('clearOperatorComparison') + ' }')();
  const show = new Show();
  show.showGpsGaps(false);
  assert.equal(dom['journalism-operators-container'].style.display, 'none', 'the comparison hides with the map');
  assert.equal(dom['gps-gaps-section'].style.display, 'none');
  show.showGpsGaps(true);
  assert.equal(dom['journalism-operators-container'].style.display, '', 'and shows with it');
  show.clearOperatorComparison();
  assert.equal(dom['journalism-operators-container'].innerHTML, '');
  ok('the GPS map sits between the delays and the operator comparison, which hides with it');

  console.log('GPS GAP PERIOD LAYOUT TEST PASSED');
} catch (err) {
  console.error('Test failed:', err);
  process.exitCode = 1;
}
