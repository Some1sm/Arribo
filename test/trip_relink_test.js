'use strict';

/**
 * test/trip_relink_test.js
 *
 * A "trip relink" is the operator's AVL re-attaching a bus to its real trip
 * mid-route: the reported delay collapses by >= 10 min within <= 10 min on the
 * same line and direction, which no bus can do between neighbouring stops.
 *
 * Fixture = production L8 bus 2675 on 2026-09-25: standing still at Institut
 * Català Salut 14:30-14:41 (delay counting up 0 -> 10), no data for 47 min,
 * then La Coma / La Riera / Parc Central at exactly +50 while running the
 * 15:30 trip on time, then O´ Donnell at 0. Four controls must NOT be flagged:
 * bus 2677 recovering gradually (12 -> 4 over 13 min); bus 2683 finishing a
 * trip 22 min late and starting the opposite direction on time; bus 2667 at
 * +29 whose next sample is back at O´ Donnell (a new trip, same direction id);
 * bus 2690 whose delay resets at the Galícia terminus.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-trip-relink-'));
process.env.DB_PATH = path.join(scratch, 'history.db');
process.env.REPORTS_DIR = path.join(scratch, 'reports');

const historyDb = require('../src/historyDb');
const { findTripRelinks, relinkCovering } = require('../src/core/schedule/tripRelink');

// 2026-09-25 is CEST (UTC+2).
const madrid = (h, m, s = 0) => Date.UTC(2026, 8, 25, h - 2, m, s);

const samples = [];
const add = (vehicleId, direction, stopName, delayMins, ts) =>
  samples.push({ vehicleId, lineCode: 'L8', direction, stopName, delayMins, timestamp: ts });

// Bus 2675: standing still, delay counting up one minute per minute.
for (let k = 0; k <= 10; k++) add('2675', '1', 'Institut Català Salut', k, madrid(14, 30 + k, 8));
// 47 min without data, then the stale +50 stretch.
add('2675', '1', 'La Coma', 50, madrid(15, 28, 9));
add('2675', '1', 'La Coma', 50, madrid(15, 29, 29));
add('2675', '1', 'La Riera', 50, madrid(15, 30, 9));
add('2675', '1', 'La Riera', 50, madrid(15, 31, 9));
add('2675', '1', 'Parc Central', 50, madrid(15, 31, 29));
add('2675', '1', 'Parc Central', 50, madrid(15, 33, 49));
// Relinked to its real trip.
add('2675', '1', 'O´ Donnell', 0, madrid(15, 37, 29));
add('2675', '1', 'Biblioteca Pompeu Fabra', 0, madrid(15, 38, 49));

// Control 1: a real delay recovering gradually (never more than 3 min per step).
add('2677', '1', 'La Coma', 12, madrid(16, 0));
add('2677', '1', 'La Riera', 14, madrid(16, 2));
add('2677', '1', 'Parc Central', 13, madrid(16, 4));
add('2677', '1', 'Geganta', 11, madrid(16, 7));
add('2677', '1', 'Pl. Granollers', 8, madrid(16, 10));
add('2677', '1', 'O´ Donnell', 4, madrid(16, 13));

// Control 2: 22 min late at the end of direction 1, next trip starts on time.
add('2683', '1', 'Poliesportiu Euskadi', 21, madrid(17, 0));
add('2683', '1', 'Galícia', 22, madrid(17, 2));
add('2683', '0', 'Galícia', 0, madrid(17, 5));
add('2683', '0', 'Poliesportiu Euskadi', 0, madrid(17, 7));

// Control 3: +29 near the end of direction 1, next sample back at O´ Donnell
// (stop 11 after stop 23): a new trip that kept the same direction id.
add('2667', '1', 'Ample', 29, madrid(18, 0));
add('2667', '1', 'Poliesportiu Euskadi', 29, madrid(18, 4));
add('2667', '1', 'O´ Donnell', -13, madrid(18, 10));

// Control 4: delay resets while standing at the Galícia terminus.
add('2690', '1', 'Poliesportiu Euskadi', 23, madrid(19, 0));
add('2690', '1', 'Galícia', 23, madrid(19, 2));
add('2690', '1', 'Galícia', 0, madrid(19, 5));

// L8 direction 1 stop order (subset of the published list; Galícia is the terminus).
const L8_DIR1 = { 'Rodalies': 0, 'La Coma': 6, 'La Riera': 7, 'Parc Central': 8, 'Geganta': 9, 'Pl. Granollers': 10,
  'O´ Donnell': 11, 'Biblioteca Pompeu Fabra': 12, 'Institut Català Salut': 13, 'Ample': 19,
  'Poliesportiu Euskadi': 23, 'Galícia': 24 };
const l8Index = (lineCode, direction, stopName) =>
  (lineCode === 'L8' && String(direction) === '1' && L8_DIR1[stopName] !== undefined
    ? { indexes: [L8_DIR1[stopName]], lastIndex: 24 }
    : null);

(async () => {
  console.log('🧪 Testing trip relink detection...');

  // ── Pure detector ──────────────────────────────────────────────────
  const withoutRoute = findTripRelinks(samples).map(x => x.vehicleId).sort();
  assert.deepEqual(withoutRoute, ['2667', '2675', '2690'], 'without stop order only the direction check applies');
  const relinks = findTripRelinks(samples, { stopIndex: l8Index });
  assert.equal(relinks.length, 1, `exactly one relink expected with stop order (got ${relinks.length})`);
  const r = relinks[0];
  assert.equal(r.vehicleId, '2675');
  assert.equal(r.lineCode, 'L8');
  assert.equal(r.delayBefore, 50);
  assert.equal(r.delayAfter, 0);
  assert.equal(r.relinkStop, 'O´ Donnell');
  assert.equal(r.staleFromTs, madrid(15, 28, 9), 'the stale stretch starts after the 47-min gap, not before it');
  assert.equal(r.staleToTs, madrid(15, 33, 49));
  assert.deepEqual(r.staleStops, ['La Coma', 'La Riera', 'Parc Central']);
  assert.ok(relinkCovering(relinks, '2675', 'l8', madrid(15, 30, 9)), 'a stale sample is covered');
  assert.equal(relinkCovering(relinks, '2675', 'L8', madrid(14, 40, 8)), null, 'the standing-still stretch before the gap is not covered');
  assert.equal(findTripRelinks(samples.map(s => ({ ...s, direction: '' }))).length, 0, 'samples without a direction never relink');
  console.log('  ✓ Detector: one relink (2675, +50 -> 0 at O´ Donnell); gradual recovery, direction change, new trip and terminus reset ignored.');

  // ── Observatori integration ────────────────────────────────────────
  historyDb.init(process.env.DB_PATH);
  for (const s of samples) {
    historyDb.recordDelayLog({
      vehicleId: s.vehicleId, lineId: '8', lineCode: 'L8', agency: 'Mataró Bus (Avanza)',
      direction: s.direction, stopName: s.stopName, delayMins: s.delayMins,
      timestamp: s.timestamp, observedAt: s.timestamp, isRealTime: true, timesSource: 'derived_timetable'
    });
  }

  const realDateNow = Date.now;
  Date.now = () => madrid(19, 30);
  let inc;
  let relinkInspect;
  let controlInspect;
  try {
    inc = historyDb.getDelayIncidents({ lineCode: 'all', hours: 24, limit: 30, minDelay: 5 });
    relinkInspect = historyDb.inspectDelayIncident({ lineCode: 'L8', stopName: 'Parc Central', vehicleId: '2675', at: madrid(15, 33, 49), windowMins: 60, minDelay: 5 });
    controlInspect = historyDb.inspectDelayIncident({ lineCode: 'L8', stopName: 'La Riera', vehicleId: '2677', at: madrid(16, 2), windowMins: 60, minDelay: 5 });
  } finally {
    Date.now = realDateNow;
  }

  const inStale = row => row.vehicleId === '2675' && row.timestamp >= madrid(15, 28, 9) && row.timestamp <= madrid(15, 33, 49);
  assert.equal(inc.investigationIncidents.filter(inStale).length, 0, 'the stale +50 must not be listed as an unusual schedule');
  assert.equal(inc.topIncidents.filter(inStale).length, 0, 'the stale +50 must not be listed as a service incident');
  assert.ok(inc.topIncidents.some(row => row.vehicleId === '2677'), 'the gradual real delay stays a service incident');
  assert.ok(inc.topIncidents.some(row => row.vehicleId === '2683'), 'the end-of-line delay stays a service incident');
  assert.ok(inc.investigationIncidents.some(row => row.vehicleId === '2667'), 'the +29 before a new trip stays an unusual schedule (the schedule stop order is used)');
  assert.ok(inc.topIncidents.some(row => row.vehicleId === '2690'), 'the delay before a terminus reset stays a service incident');
  const relinkRows = inc.telemetryAnomalies.filter(row => row.anomalyType === 'trip_relink');
  assert.equal(relinkRows.length, 1, 'the relink is listed once with the SAE anomalies');
  assert.equal(relinkRows[0].vehicleId, '2675');
  assert.equal(relinkRows[0].delayMins, 50);
  assert.ok(relinkRows[0].diagnosticBadge.includes('reassignat'), 'the anomaly row says the trip was reassigned');
  assert.equal(relinkRows[0].relink.stopName, 'O´ Donnell');
  assert.equal(inc.summary.maxDelayMins, 29, 'the headline maximum excludes the stale +50');
  assert.equal(inc.summary.tripRelinkEpisodes, 1);
  console.log('  ✓ Incidents: stale +50 moved from the rankings to the SAE anomalies; max delay 29, not 50.');

  const relinkTrip = inc.incidentTrips.find(t => t.vehicleId === '2675' && t.endReason === 'relinked');
  assert.ok(relinkTrip, 'the 2675 trajectory ends as relinked, not recovered');
  assert.equal(relinkTrip.incidentType, 'trip_relink');
  assert.equal(relinkTrip.relink.delayBefore, 50);
  assert.equal(relinkTrip.relink.delayAfter, 0);
  assert.ok(relinkTrip.stopProgression.every(p => !p.isRecovered), 'no stop of a relinked trajectory is marked recovered');
  const controlTrip = inc.incidentTrips.find(t => t.vehicleId === '2677');
  assert.ok(controlTrip && controlTrip.endReason !== 'relinked', 'the gradual recovery is not relinked');
  assert.ok(inc.incidentTrips.indexOf(relinkTrip) > inc.incidentTrips.indexOf(controlTrip), 'relinked trajectories sort after real ones');
  console.log('  ✓ Trajectories: 2675 ends "relinked" and sorts after the real delays.');

  assert.equal(relinkInspect.found, true);
  assert.equal(relinkInspect.episode.verdict, 'trip_relink');
  assert.equal(relinkInspect.episode.tripRelink.delayAfter, 0);
  assert.notEqual(controlInspect.episode.verdict, 'trip_relink');
  console.log(`  ✓ Investigar: verdict "${relinkInspect.episode.verdict}" for 2675, "${controlInspect.episode.verdict}" for 2677.`);

  console.log('🎉 ALL TRIP RELINK ASSERTIONS PASSED!');
})().finally(() => {
  historyDb.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}).then(() => process.exit(0)).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
