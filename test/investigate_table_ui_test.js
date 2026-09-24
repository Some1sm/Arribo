/**
 * test/investigate_table_ui_test.js
 *
 * THE REGRESSION TEST FOR THE "UGLY INVESTIGAR TABLE" AND THE EXPEDICIONS LINK.
 *
 * Two rider complaints drove this:
 *
 *  1. The panel that opens on "Investigar" had no headers, and its cells moved
 *     around depending on text length. The cause was structural, not cosmetic:
 *     it was not a table at all. Each sample was a <div> with
 *     display:flex + justify-content:space-between holding six inline <span>s,
 *     so every column's position was decided by the width of the cells before
 *     it. Nothing could hold a column still, and nothing labelled what the
 *     values meant.
 *
 *  2. The drill-down and the "Expedicions & Trajectòries" tab are two different
 *     aggregations of the same delay_logs rows, with no way to get from one to
 *     the other. An operator had to match times by eye.
 *
 * The table checks are STRUCTURAL on purpose: what actually stops the drifting
 * layout is a real <table> with a fixed layout and a header, and those are
 * properties of the emitted markup and the stylesheet, not of a rendered pixel
 * box. A pixel-diff would be a worse test -- it would pass on a table that
 * happens to look aligned today and fail on a harmless font change.
 *
 * The trip-link checks are FUNCTIONAL. _matchIncidentTrip is pure logic, so it
 * is executed for real against the actual class in observatori.js rather than
 * against a copy of it -- a copy would drift from the shipped file and quietly
 * stop testing anything.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const observatoriSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'observatori.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');

let passed = 0;
const failed = [];
const check = (cond, msg) => {
  if (cond) { passed++; return; }
  failed.push(msg);
};

// ── Load the REAL class out of observatori.js ───────────────────────────
// The file declares a top-level class and self-instantiates on
// DOMContentLoaded. In a vm script, a top-level `class` is a lexical binding
// that never lands on the context object, so the class is handed to a global
// explicitly. The DOMContentLoaded listener is never fired, so the constructor
// (and its DOM work) does not run.
const sandbox = {
  window: { addEventListener() {} },
  document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
  console,
  setTimeout, clearTimeout, Intl, Date, Math, JSON, Object, Array, String, Number, Boolean, Promise, RegExp, Map, Set, Error, isNaN, parseInt, parseFloat
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(observatoriSrc + '\n;globalThis.__ObservatoriApp = ObservatoriApp;', sandbox, { filename: 'observatori.js' });
const ObservatoriApp = sandbox.__ObservatoriApp;
check(typeof ObservatoriApp === 'function', 'the real ObservatoriApp class loads from observatori.js');

// A receiver without running the constructor: the methods under test are pure
// and touch only `esc` and `lastIncidentData`.
const app = Object.create(ObservatoriApp.prototype);
app.lastIncidentData = null;

const EP_START = Date.parse('2026-09-24T12:05:00+02:00');
const EP_END = EP_START + 5 * 60 * 1000;
const episode = (vehicleId) => ({
  tripKey: { lineCode: 'L3', vehicleId, startTs: EP_START, endTs: EP_END }
});

const trip = (over = {}) => ({
  vehicleId: '2672', lineCode: 'L3',
  startTime: new Date(EP_START).toLocaleString('en-GB', { timeZone: 'Europe/Madrid' }),
  endTime: new Date(EP_END).toLocaleString('en-GB', { timeZone: 'Europe/Madrid' }),
  // The numeric twin the matcher actually uses. startTime is a localized
  // en-GB string that Date.parse cannot read back, which is why the server
  // sends this alongside it.
  startTs: EP_START,
  endTs: EP_END,
  sampleCount: 7,
  stopProgression: [
    { stopName: 'TecnoCampus', delayMins: 7, isRecovered: false },
    { stopName: 'Rafael Estrany', delayMins: 16, isRecovered: false },
    { stopName: 'Vista Alegre', delayMins: 5, isRecovered: true }
  ],
  ...over
});

// ── 1. The trip link matches the episode's own bus ──────────────────────
app.lastIncidentData = { incidentTrips: [trip()] };
const linked = app._matchIncidentTrip(episode('2672'));
check(linked.includes('drilldown-trip-card'), 'a matching trip renders the trajectory card');
check(linked.includes('TecnoCampus') && linked.includes('Rafael Estrany') && linked.includes('Vista Alegre'),
  'the card lists the stops of the trajectory');
check(linked.includes('+16'), 'the card shows the per-stop delay');
check(linked.includes('2672'), 'the card names the bus');
check(linked.includes('data-incident-tab="trips"'),
  'the card offers a jump to the Expedicions tab (reuses the existing tab handler)');

// ── 2. It must NOT link the wrong bus ──────────────────────────────────
const otherBus = app._matchIncidentTrip(episode('9999'));
check(otherBus === '',
  'an episode whose bus is absent from the trip list renders no card rather than a wrong one');
check(app._matchIncidentTrip({ tripKey: { lineCode: 'L3', vehicleId: '2672', startTs: EP_START, endTs: EP_END } })
  === linked, 'the same input yields the same card (no hidden state)');

const wrongTime = app._matchIncidentTrip({
  tripKey: { lineCode: 'L3', vehicleId: '2672', startTs: EP_START + 6 * 3600 * 1000, endTs: EP_END + 6 * 3600 * 1000 }
});
check(wrongTime === '',
  'the same bus hours later must not match -- a loose match would be worse than no link');

const wrongLine = app._matchIncidentTrip({
  tripKey: { lineCode: 'L7', vehicleId: '2672', startTs: EP_START, endTs: EP_END }
});
check(wrongLine === '', 'the same bus on a different line must not match');

// Id-less historical episodes cannot be matched safely, so no card.
check(app._matchIncidentTrip(episode('')) === '',
  'an episode with no stored vehicle id renders no card instead of guessing');

// Missing inputs degrade quietly rather than throwing.
check(app._matchIncidentTrip(null) === '', 'a null episode is handled');
app.lastIncidentData = null;
check(app._matchIncidentTrip(episode('2672')) === '', 'no card when the trips tab has not been loaded');

// The bug this suite caught in its own first draft: startTime is a localized
// string, and Date.parse cannot read it. Matching on it silently matched
// nothing. Assert the numeric field is what the matcher consults, so the
// localized string can be reworded or re-localized without breaking the link.
app.lastIncidentData = { incidentTrips: [trip({ startTs: undefined })] };
check(app._matchIncidentTrip(episode('2672')) === '',
  'a trip with no numeric startTs does not link -- failing safe, not guessing from text');
check(isNaN(Date.parse(trip().startTime)),
  'CONTROL: the localized startTime really is un-parseable, which is why startTs is required');
app.lastIncidentData = { incidentTrips: [trip()] };
check(app._matchIncidentTrip(episode('2672')) !== '',
  'and the link works again once the numeric field is present');

// ── 3. The panel emits a real table with headers ───────────────────────
// Structural, because the defect WAS structural: a flex div cannot hold
// columns still, and a real <table> with a fixed layout can.
const drilldownBody = observatoriSrc.slice(
  observatoriSrc.indexOf('const rawHtml = (ep.rawRows || [])'),
  observatoriSrc.indexOf('_matchIncidentTrip(ep) {')
);
check(drilldownBody.includes('<table class="drilldown-samples-table">'),
  'the sample list is a real <table>');
check(drilldownBody.includes('<thead>') && drilldownBody.includes('<tbody>'),
  'the table has a thead and a tbody');

const headers = [...drilldownBody.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map(m => m[1].trim());
check(headers.length === 6, `every column is labelled, found ${headers.length}: ${JSON.stringify(headers)}`);
check(headers.join('|') === 'Hora|Retard|Parada|Bus|Teòric → Real|Origen',
  `headers are the expected six, got ${JSON.stringify(headers)}`);

// One <td> per column per row, or the cells drift out of alignment again.
const rowHtml = drilldownBody.slice(drilldownBody.indexOf('return `'), drilldownBody.indexOf('}).join(\'\');'));
const cellCount = (rowHtml.match(/<td /g) || []).length;
check(cellCount === 6, `each sample row emits exactly 6 cells, got ${cellCount}`);

// The old drifting pattern must be gone from this renderer. Scoped to the
// renderer, not the whole file: other panels legitimately use flex rows.
//
// The check is for `display:flex` -- the mechanism that made columns drift --
// and not for the literal `justify-content:space-between`. That literal now
// appears in a COMMENT explaining what was replaced, so asserting its absence
// fails on the explanation and would tempt someone into deleting the comment
// to make a test pass. AGENTS.md records the same class of trap elsewhere: a
// naive source scan reading a comment as code.
const rowBlock = drilldownBody.slice(0, drilldownBody.indexOf('}).join(\'\');'));
check(rowBlock.includes('<tr>') && rowBlock.includes('<td class="drilldown-cell-time"'),
  'the sample renderer emits table rows and cells');
check(!rowBlock.includes('display:flex'),
  'the flex layout that made the columns drift is gone from the sample renderer');
check(!/<div style="padding:4px 0; border-bottom:1px solid var\(--border-subtle\); font-size:0\.78rem; display:flex/.test(observatoriSrc),
  'the original flex-div sample row no longer exists anywhere in the file');

// ── 4. The stylesheet is what actually pins the columns ────────────────
const tableBlock = css.slice(css.indexOf('.drilldown-samples-table {'), css.indexOf('.drilldown-cell-time'));
check(tableBlock.includes('table-layout: fixed'),
  'the table uses a fixed layout -- this, not the markup alone, is what stops column drift');
check(css.includes('.drilldown-samples-table thead th {') &&
      /position:\s*sticky/.test(css.slice(css.indexOf('.drilldown-samples-table thead th {'), css.indexOf('.drilldown-samples-table tbody td {'))),
  'the header is sticky inside the scroll container');
check(css.includes('.drilldown-table-scroll {') &&
      /overflow:\s*auto/.test(css.slice(css.indexOf('.drilldown-table-scroll {'), css.indexOf('.drilldown-samples-table {'))),
  'the table scrolls horizontally rather than squeezing its columns on a narrow screen');
check(css.includes('overflow-wrap: anywhere'),
  'long stop names wrap inside their own cell instead of widening the column');

// Every one of the six body cells has a width, or fixed layout has nothing
// to hold. Whitespace before the brace is not pinned -- the stylesheet
// aligns these with two spaces, and pinning that would break the test on a
// formatting change that changes nothing.
for (const cls of ['drilldown-cell-time', 'drilldown-cell-delay', 'drilldown-cell-stop',
                   'drilldown-cell-veh', 'drilldown-cell-times', 'drilldown-cell-src']) {
  check(new RegExp(`\\.${cls}\\s*\\{[^}]*width:`).test(css), `${cls} declares a width`);
}

// ── 5. The vehicle identity reaches the API ────────────────────────────
// Without this the panel can still resolve to a neighbouring bus even with
// per-vehicle grouping, so the whole chain is asserted end to end.
check(observatoriSrc.includes('data-investigate-vehicle='),
  'the Investigar button carries the vehicle id');
const clickHandler = observatoriSrc.slice(
  observatoriSrc.indexOf("closest('[data-investigate-stop]')"),
  observatoriSrc.indexOf('// Copy anomalies report')
);
check(clickHandler.includes('dataset.investigateVehicle'),
  'the click handler reads the vehicle id off the button');
check(clickHandler.includes('openIncidentDrilldown(line, stop, at, vehicle)'),
  'the handler forwards the vehicle id to the drill-down');
const fetchBlock = observatoriSrc.slice(
  observatoriSrc.indexOf('async openIncidentDrilldown('),
  observatoriSrc.indexOf('const data = await res.json();')
);
check(fetchBlock.includes("params.set('vehicle', vehicleId)"),
  'the drill-down sends the vehicle to the API');

console.log('=======================================================');
console.log('Total Passed Assertions:', passed);
console.log('Total Failures Detected:', failed.length);
console.log('=======================================================');
for (const f of failed) console.log('  ✗ ' + f);
if (failed.length) {
  console.log('\n❌ INVESTIGATE TABLE UI TESTS FAILED\n');
  process.exit(1);
}
console.log('\n🎉 ALL INVESTIGATE TABLE UI TESTS PASSED\n');
process.exit(0);
