'use strict';

/**
 * test/incident_run_test.js
 *
 * The Investigar panel shows the bus's whole run around the clicked delay,
 * not only the samples at the clicked stop. Fixture = production L8 bus 2669
 * on 2026-09-29: ~25 min late at every stop from Floridablanca (14:13) to
 * Euskadi (14:46), with a single sample at the clicked stop, Escola El Turó
 * (14:43, +24). Before this change the panel showed that one sample alone.
 *
 * Also covers: the pattern summary (sustained / building / recovering /
 * variable / isolated), stop-visit collapsing, direction changes, the stop cap,
 * and the GPS-position window around a single-sample episode (it used to be
 * zero-length, so it could never find the two positions it needs).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-incident-run-'));
process.env.DB_PATH = path.join(scratch, 'history.db');
process.env.REPORTS_DIR = path.join(scratch, 'reports');

const historyDb = require('../src/historyDb');
const { buildIncidentRun, MAX_RUN_STOPS } = require('../src/core/schedule/incidentRun');

// 2026-09-29 is CEST (UTC+2).
const madrid = (h, m, s = 0) => Date.UTC(2026, 8, 29, h - 2, m, s);
const hms = (h, m, s = 0) => `2026-09-29 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
const row = (stopName, delayMins, h, m, s = 0, direction = '1') =>
  ({ stopName, delayMins, direction, lineCode: 'L8', timestamp: madrid(h, m, s), formattedDate: hms(h, m, s), isRealTime: 1 });

(async () => {
  console.log('🧪 Testing the Investigar run view...');

  // ── Pure: patterns ─────────────────────────────────────────────────
  const series = (delays) => delays.map((d, i) => row(`Stop ${i}`, d, 14, i * 2));
  const clickLast = (rows) => ({ clickedStop: rows[rows.length - 1].stopName, clickedFrom: rows[rows.length - 1].timestamp, clickedTo: rows[rows.length - 1].timestamp });
  const patternOf = (delays) => { const rows = series(delays); return buildIncidentRun(rows, clickLast(rows)).summary; };
  assert.equal(patternOf([24, 23, 25, 27, 26]).pattern, 'sustained');
  const building = patternOf([2, 4, 7, 10, 13]);
  assert.equal(building.pattern, 'building');
  assert.equal(building.firstDelay, 2);
  assert.equal(building.lastDelay, 13);
  assert.equal(patternOf([15, 12, 9, 6, 3]).pattern, 'recovering');
  assert.equal(patternOf([6, 14, 5, 9]).pattern, 'variable');
  assert.equal(patternOf([12]).pattern, 'isolated');
  assert.equal(buildIncidentRun([], {}).summary.pattern, 'none');
  console.log('  ✓ Patterns: sustained, building, recovering, variable, isolated, none.');

  // ── Pure: collapsing, direction change, towards, cap ───────────────
  const mixed = [
    row('A', 10, 14, 0), row('A', 11, 14, 0, 20), row('B', 12, 14, 2),
    row('C', 3, 14, 10, 0, '0'), row('D', 2, 14, 12, 0, '0')
  ];
  const run = buildIncidentRun(mixed, { clickedStop: 'b', clickedFrom: madrid(14, 2), clickedTo: madrid(14, 2), towards: (line, dir) => (dir === '1' ? 'Galícia' : 'Rodalies') });
  assert.equal(run.stops.length, 4, 'consecutive samples at one stop collapse into one visit');
  assert.equal(run.stops[0].sampleCount, 2);
  assert.equal(run.stops[0].delayMins, 11, 'a visit shows its latest delay');
  assert.equal(run.stops[0].time, '14:00:00');
  assert.equal(run.stops[1].isClicked, true, 'the clicked stop is matched case- and accent-insensitively');
  assert.equal(run.stops.filter(s => s.isClicked).length, 1);
  assert.equal(run.stops[2].directionChanged, true);
  assert.equal(run.stops[2].newTrip, true, 'a direction change starts a new trip');
  assert.equal(run.stops[0].towards, 'Galícia');
  assert.equal(run.stops[2].towards, 'Rodalies');
  assert.equal(run.summary.stopCount, 2, 'the summary covers only the clicked direction');
  const many = Array.from({ length: MAX_RUN_STOPS + 50 }, (_, i) => ({ ...row(`S${i}`, 8, 12, 0), timestamp: madrid(12, 0) + i * 30000 }));
  const capped = buildIncidentRun(many, { clickedStop: 'S190', clickedFrom: many[190].timestamp, clickedTo: many[190].timestamp });
  assert.equal(capped.stops.length, MAX_RUN_STOPS);
  assert.ok(capped.stops.some(s => s.isClicked), 'the clicked stop stays inside the capped run');
  // A jump back along the route in the same direction is a new trip too.
  const order = { P: 3, Q: 4, R: 5, S: 1 };
  const byOrder = (line, dir, name) => (order[name] !== undefined ? { indexes: [order[name]], lastIndex: 9 } : null);
  const jump = [row('P', 20, 14, 0), row('Q', 21, 14, 2), row('R', 22, 14, 4), row('S', 45, 14, 9)];
  const jumpRun = buildIncidentRun(jump, { clickedStop: 'Q', clickedFrom: madrid(14, 2), clickedTo: madrid(14, 2), stopIndex: byOrder });
  assert.equal(jumpRun.stops[3].newTrip, true, 'stop 1 after stop 5 in the same direction starts a new trip');
  assert.equal(jumpRun.stops[3].directionChanged, false);
  assert.equal(jumpRun.summary.stopCount, 3);
  assert.equal(jumpRun.summary.pattern, 'sustained', 'the +45 after the jump does not turn a steady trip into a growing delay');
  assert.equal(buildIncidentRun(jump, { clickedStop: 'Q', clickedFrom: madrid(14, 2), clickedTo: madrid(14, 2) }).summary.pattern, 'building', 'CONTROL: without stop order the jump is not detected');
  console.log('  ✓ Visits collapse, direction changes and jumps back split the summary, the cap keeps the clicked stop.');

  // ── Observatori integration: bus 2669 ──────────────────────────────
  historyDb.init(process.env.DB_PATH);
  const bus2669 = [
    ['Floridablanca', 24, 14, 13, 10], ['La Riera', 23, 14, 16, 30], ['Parc Central', 24, 14, 19, 11],
    ['Pl. Granollers', 25, 14, 25, 10], ['O´ Donnell', 25, 14, 26, 30], ['O´ Donnell', 26, 14, 27, 50],
    ['Gatassa', 26, 14, 31, 50], ['Ronda Cerdanya', 27, 14, 37, 50], ['Roca Blanca', 25, 14, 42, 30],
    ['Escola El Turó', 24, 14, 43, 10], ['Euskadi', 26, 14, 46, 30],
    // As on production: the feed then jumps back along the route at +49.
    ['Biblioteca Pompeu Fabra', 49, 14, 52, 0]
  ];
  for (const [stopName, delayMins, h, m, s] of bus2669) {
    historyDb.recordDelayLog({ vehicleId: '2669', lineId: '8', lineCode: 'L8', agency: 'Mataró Bus (Avanza)', direction: '1', stopName, delayMins, timestamp: madrid(h, m, s), observedAt: madrid(h, m, s), isRealTime: true, scheduledTime: '14:20:00', actualTime: '14:44:00', timesSource: 'derived_timetable' });
  }
  historyDb.recordDelayLog({ vehicleId: '2669', lineId: '8', lineCode: 'L8', agency: 'Mataró Bus (Avanza)', direction: '0', stopName: 'Galícia', delayMins: 3, timestamp: madrid(14, 55), observedAt: madrid(14, 55), isRealTime: true });
  // Two GPS positions two minutes either side of the single clicked sample.
  for (const [h, m] of [[14, 41], [14, 45]]) {
    historyDb.recordVehicleSnapshot({ vehicleId: '2669', lineId: '8', lineCode: 'L8', lat: 41.54, lon: 2.44, speedKmh: 18, delayMins: 25, timestamp: madrid(h, m) });
  }

  const realDateNow = Date.now;
  Date.now = () => madrid(18, 0);
  let result;
  try {
    result = historyDb.inspectDelayIncident({ lineCode: 'L8', stopName: 'Escola El Turó', vehicleId: '2669', at: madrid(14, 43, 10), windowMins: 60, minDelay: 5 });
  } finally {
    Date.now = realDateNow;
  }
  assert.equal(result.found, true);
  const ep = result.episode;
  assert.equal(ep.rawRows.length, 1, 'the clicked episode itself is still the single sample at Escola El Turó');
  assert.ok(ep.run, 'the episode carries the bus run');
  const dir1 = ep.run.stops.filter(s => s.direction === '1');
  assert.equal(dir1.length, 11, `eleven stop visits in direction 1 (got ${dir1.length})`);
  const jumpBack = ep.run.stops.find(s => s.stopName === 'Biblioteca Pompeu Fabra');
  assert.equal(jumpBack.newTrip, true, 'the jump back to Biblioteca Pompeu Fabra starts a new trip (published stop order)');
  assert.deepEqual(ep.run.stops.filter(s => s.isClicked).map(s => s.stopName), ['Escola El Turó']);
  assert.equal(ep.run.summary.pattern, 'sustained');
  assert.equal(ep.run.summary.minDelay, 23);
  assert.equal(ep.run.summary.maxDelay, 27);
  assert.equal(ep.run.summary.stopCount, 10);
  assert.equal(ep.run.summary.fromTime, '14:13:10');
  assert.equal(ep.run.summary.towards, 'Galícia', 'the direction is named by its terminus from the published timetable');
  assert.equal(ep.run.stops[ep.run.stops.length - 1].directionChanged, true, 'the return trip is marked as a new direction');
  assert.equal(ep.run.stops[ep.run.stops.length - 1].newTrip, true);
  assert.equal(ep.evidence.snapshotTrailPoints, 2, 'positions two minutes either side of a single-sample episode are found');
  assert.equal(ep.evidence.snapshotRetentionHours, 2);
  assert.equal(ep.verdict, 'corroborated');
  console.log(`  ✓ Bus 2669: ${ep.run.stops.length} stop visits around 1 clicked sample, pattern "${ep.run.summary.pattern}" (+${ep.run.summary.minDelay}..+${ep.run.summary.maxDelay}), verdict "${ep.verdict}".`);

  console.log('🎉 ALL INCIDENT RUN ASSERTIONS PASSED!');
})().finally(() => {
  historyDb.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}).then(() => process.exit(0)).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
