'use strict';

/**
 * test/deadhead_return_test.js
 *
 * A "deadhead return": a late bus skips a trip and drives back to the start of
 * its route without passengers, while the operator's AVL keeps logging stops it
 * does not serve.
 *
 * Fixture = production L8 bus 2669 on 2026-09-29, 13:50-15:12, as logged: +26
 * at Euskadi (14:46), Biblioteca Pompeu Fabra re-logged at +49 (already served
 * at 14:29), Rodalies logged on the Galícia -> Rodalies trip at +10, then Sant
 * Joan +3 at 14:57 on the next Rodalies -> Galícia trip. Buses 2665 and 2667 are
 * the only buses the feed logged at Roca Blanca (Galícia -> Rodalies) around it.
 * Three controls must NOT be flagged: bus 2690 running the opposite trip
 * normally; bus 2691 with the same pattern but back too late (14 min, the
 * opposite trip takes 21) to prove the trip was skipped; bus 2692 restarting
 * its direction without any opposite-direction record (the L3 pattern of an
 * inconsistent direction flag).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-deadhead-'));
process.env.DB_PATH = path.join(scratch, 'history.db');
process.env.REPORTS_DIR = path.join(scratch, 'reports');

const historyDb = require('../src/historyDb');
const mataroSchedules = require('../src/data/mataroSchedules');
const { normalizeStopName } = require('../src/core/schedule/tripMatcher');
const { findDeadheadReturns, deadheadCovering, deadheadTouching } = require('../src/core/schedule/deadheadReturn');
const { buildIncidentRun } = require('../src/core/schedule/incidentRun');

// 2026-09-29 is a Tuesday in CEST (UTC+2).
const madrid = hms => {
  const [h, m, s] = hms.split(':').map(Number);
  return Date.UTC(2026, 8, 29, h - 2, m, s || 0);
};

// [time, direction, stop, delay, scheduled] exactly as bus 2669 logged them.
const BUS_2669 = [
  ['13:50:30', '0', 'Institut Català Salut', 29, '13:23'],
  ['13:51:50', '0', 'Edif. Vidre - TecnoCampus', 28, '13:25'],
  ['13:52:30', '0', 'Porta Laietana-TecnoCampus', 28, '13:28'],
  ['13:57:10', '0', 'Jutjats', 31, '13:30'],
  ['13:57:50', '0', 'Jutjats', 30, '13:30'],
  ['13:58:30', '0', 'Jutjats', 30, '13:30'],
  ['13:59:10', '0', 'Pl. Doctor Fleming', 30, '13:31'],
  ['13:59:50', '0', 'Pl. Doctor Fleming', 29, '13:31'],
  ['14:02:30', '0', 'Ronda Barceló', 31, '13:32'],
  ['14:03:10', '0', 'Rodalies', 31, '13:34'],
  ['14:03:50', '0', 'Rodalies', 30, '13:34'],
  ['14:05:50', '1', 'La Rambla', 23, '13:45'],
  ['14:06:30', '1', 'Sant Joan', 22, '13:47'],
  ['14:09:10', '1', 'Can Marfà', 23, '13:48'],
  ['14:09:50', '1', 'Can Marfà', 23, '13:48'],
  ['14:11:50', '1', 'Floridablanca', 24, '13:50'],
  ['14:13:10', '1', 'Floridablanca', 24, '13:50'],
  ['14:14:30', '1', 'Pl. Fiveller', 23, '13:52'],
  ['14:16:30', '1', 'La Riera', 23, '13:55'],
  ['14:17:50', '1', 'La Riera', 24, '13:55'],
  ['14:19:11', '1', 'Parc Central', 24, '13:58'],
  ['14:20:30', '1', 'Geganta', 23, '14:00'],
  ['14:25:10', '1', 'Pl. Granollers', 25, '14:01'],
  ['14:26:30', '1', 'O´ Donnell', 25, '14:03'],
  ['14:27:50', '1', 'O´ Donnell', 26, '14:03'],
  ['14:28:30', '1', 'Biblioteca Pompeu Fabra', 26, '14:04'],
  ['14:29:11', '1', 'Biblioteca Pompeu Fabra', 26, '14:04'],
  ['14:29:50', '1', 'Institut Català Salut', 26, '14:06'],
  ['14:31:50', '1', 'Gatassa', 26, '14:07'],
  ['14:33:10', '1', 'Parc Cerdanyola', 26, '14:10'],
  ['14:33:50', '1', 'Parc Cerdanyola', 27, '14:10'],
  ['14:35:50', '1', 'Cerdanyola', 25, '14:11'],
  ['14:36:30', '1', 'Cerdanyola', 26, '14:11'],
  ['14:37:50', '1', 'Ronda Cerdanya', 27, '14:13'],
  ['14:41:10', '1', 'Ample', 27, '14:16'],
  ['14:42:30', '1', 'Roca Blanca', 25, '14:19'],
  ['14:43:10', '1', 'Escola El Turó', 24, '14:20'],
  ['14:46:30', '1', 'Euskadi', 26, '14:22'],
  ['14:52:30', '1', 'Biblioteca Pompeu Fabra', 49, '14:04'],
  ['14:55:50', '0', 'Rodalies', 10, '14:46'],
  ['14:57:50', '1', 'Sant Joan', 3, '14:58'],
  ['14:58:30', '1', 'Sant Joan', 3, '14:58'],
  ['14:59:10', '1', 'Sant Joan', 3, '14:58'],
  ['14:59:50', '1', 'Sant Joan', 3, '14:58'],
  ['15:00:30', '1', 'Sant Joan', 4, '14:58'],
  ['15:01:10', '1', 'Can Marfà', 4, '15:00'],
  ['15:01:50', '1', 'Can Marfà', 4, '15:00'],
  ['15:02:30', '1', 'Can Marfà', 4, '15:00'],
  ['15:03:10', '1', 'Floridablanca', 3, '15:01'],
  ['15:03:50', '1', 'Floridablanca', 3, '15:01'],
  ['15:05:10', '1', 'Pl. Fiveller', 4, '15:04'],
  ['15:05:50', '1', 'La Coma', 3, '15:06'],
  ['15:08:30', '1', 'La Riera', 2, '15:08'],
  ['15:09:10', '1', 'La Riera', 3, '15:08'],
  ['15:09:50', '1', 'Parc Central', 2, '15:10'],
  ['15:10:30', '1', 'Parc Central', 2, '15:10'],
  ['15:11:10', '1', 'Geganta', 2, '15:12'],
  ['15:11:50', '1', 'Geganta', 2, '15:12']
];
// The buses the feed logged at Roca Blanca on Galícia -> Rodalies around it.
const ROCA_BLANCA = [
  ['2665', '14:05:50', 5, '14:01'],
  ['2667', '14:51:10', 3, '14:49'],
  ['2665', '15:12:30', 0, '15:13']
];

const samples = [];
const add = (vehicleId, direction, stopName, delayMins, hms, scheduled = '') =>
  samples.push({ vehicleId, lineCode: 'L8', direction, stopName, delayMins, timestamp: madrid(hms), scheduledTime: scheduled ? `${scheduled}:00` : '' });
for (const [hms, direction, stop, delay, scheduled] of BUS_2669) add('2669', direction, stop, delay, hms, scheduled);
for (const [bus, hms, delay, scheduled] of ROCA_BLANCA) add(bus, '0', 'Roca Blanca', delay, hms, scheduled);

// Control 1: bus 2690 finishes Rodalies -> Galícia and runs Galícia -> Rodalies in full.
const TO_GALICIA_TAIL = ['Parc Cerdanyola', 'Cerdanyola', 'Ronda Cerdanya', 'Ample', 'Roca Blanca', 'Escola El Turó', 'Euskadi'];
const TO_RODALIES = ['Galícia', 'Roca Blanca', 'Tarragona', 'Pl. Gatassa', 'Parc Cerdanyola', 'Gatassa', 'Institut Català Salut',
  'Edif. Vidre - TecnoCampus', 'Porta Laietana-TecnoCampus', 'Jutjats', 'Pl. Doctor Fleming', 'Ronda Barceló', 'Rodalies'];
const at = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
TO_GALICIA_TAIL.forEach((stop, i) => add('2690', '1', stop, 8, at(16, i * 2)));
TO_RODALIES.forEach((stop, i) => add('2690', '0', stop, 6, at(16, 16 + i * 2)));
['La Rambla', 'Sant Joan', 'Can Marfà', 'Floridablanca'].forEach((stop, i) => add('2690', '1', stop, 4, at(16, 44 + i * 2)));

// Control 2: bus 2691, same pattern as 2669 but back 14 min after its last stop.
TO_GALICIA_TAIL.forEach((stop, i) => add('2691', '1', stop, 12, at(17, i * 2)));
add('2691', '1', 'Biblioteca Pompeu Fabra', 25, at(17, 18));
add('2691', '0', 'Rodalies', 5, at(17, 22));
['Sant Joan', 'Can Marfà', 'Floridablanca', 'Pl. Fiveller'].forEach((stop, i) => add('2691', '1', stop, 2, at(17, 26 + i * 2)));

// Control 3: bus 2692 restarts Rodalies -> Galícia with no opposite-direction record.
TO_GALICIA_TAIL.forEach((stop, i) => add('2692', '1', stop, 9, at(18, i * 2)));
['La Rambla', 'Sant Joan', 'Can Marfà', 'Floridablanca'].forEach((stop, i) => add('2692', '1', stop, 1, at(18, 16 + i * 2)));

// Published stop order and trip time, as src/historyDb.js resolves them.
const stopIndex = (lineCode, direction, stopName) => {
  const ds = mataroSchedules.getDirectionSchedule(String(lineCode).replace(/^L/i, ''), direction, 'weekday');
  if (!ds) return null;
  const names = ds.stops.map(s => normalizeStopName(s.name));
  const wanted = normalizeStopName(stopName);
  const indexes = [];
  names.forEach((n, i) => { if (n === wanted) indexes.push(i); });
  return indexes.length ? { indexes, lastIndex: names.length - 1 } : null;
};
const tripMinutes = (lineCode, direction) => {
  const ds = mataroSchedules.getDirectionSchedule(String(lineCode).replace(/^L/i, ''), direction, 'weekday');
  return ds ? ds.totalTravelMinutes : null;
};

(async () => {
  // ── Detector ───────────────────────────────────────────────────────
  const found = findDeadheadReturns(samples, { stopIndex, tripMinutes });
  assert.equal(found.length, 1, `exactly one deadhead return, got ${JSON.stringify(found.map(d => d.vehicleId))}`);
  const d = found[0];
  assert.equal(d.vehicleId, '2669');
  assert.equal(d.lineCode, 'L8');
  assert.equal(d.direction, '1');
  assert.equal(d.oppositeDirection, '0');
  assert.equal(d.lastServedStop, 'Euskadi');
  assert.equal(d.lastServedDelay, 26);
  assert.equal(d.lastServedTs, madrid('14:46:30'));
  assert.equal(d.resumeStop, 'Sant Joan');
  assert.equal(d.resumeTs, madrid('14:57:50'));
  assert.equal(d.returnMinutes, 11);
  assert.equal(d.oppositeTripMinutes, 21);
  assert.deepEqual(d.phantoms.map(p => [p.stopName, p.direction, p.delayMins]), [['Biblioteca Pompeu Fabra', '1', 49], ['Rodalies', '0', 10]]);
  assert.equal(d.phantomFromTs, madrid('14:52:30'));
  assert.equal(d.phantomToTs, madrid('14:55:50'));
  assert.deepEqual({ ...d.closedTrip }, { direction: '0', stopName: 'Rodalies', scheduledTime: '14:46:00', timestamp: madrid('14:55:50') });
  assert.ok(deadheadCovering(found, '2669', 'l8', madrid('14:52:30')), 'the +49 record is covered');
  assert.equal(deadheadCovering(found, '2669', 'L8', madrid('14:46:30')), null, 'the last served stop is not covered');
  assert.ok(deadheadTouching(found, '2669', 'L8', madrid('14:13:00'), madrid('14:46:30')), 'the run that ends at Euskadi touches it');
  assert.equal(deadheadTouching(found, '2669', 'L8', madrid('14:57:50'), madrid('15:12:00')), null, 'the next trip does not');
  assert.equal(findDeadheadReturns(samples, { stopIndex }).length, 0, 'without trip times nothing is detected');
  assert.equal(findDeadheadReturns(samples.map(s => ({ ...s, direction: '' })), { stopIndex, tripMinutes }).length, 0, 'samples without a direction are ignored');
  console.log('  ✓ Detector: 2669 back at Sant Joan 11 min after Euskadi (trip takes 21); normal turn, slow return and missing flip ignored.');

  // ── Investigar run ─────────────────────────────────────────────────
  const rows2669 = samples.filter(s => s.vehicleId === '2669')
    .map(s => ({ ...s, formattedDate: `2026-09-29 ${new Date(s.timestamp + 2 * 3600 * 1000).toISOString().slice(11, 19)}` }));
  const runOptions = { clickedStop: 'Escola El Turó', clickedFrom: madrid('14:43:10'), clickedTo: madrid('14:43:10'), stopIndex };
  const plain = buildIncidentRun(rows2669, runOptions);
  const run = buildIncidentRun(rows2669, { ...runOptions, deadheads: found });
  assert.equal(plain.trips.length - run.trips.length, 1, 'the two phantom records form one group instead of two trips');
  const clickedTrip = run.trips.findIndex(t => t.isClickedTrip);
  assert.equal(run.summary.pattern, 'sustained', 'the clicked trip stays a sustained +23..+27 delay');
  const group = run.trips[clickedTrip + 1];
  assert.equal(group.isDeadhead, true, 'the trip after the clicked one is the deadhead group');
  assert.equal(group.stopCount, 2);
  const next = run.trips[clickedTrip + 2];
  assert.equal(next.isDeadhead, false);
  assert.equal(run.stops[next.startIndex].stopName, 'Sant Joan', 'the next trip starts at Sant Joan');
  assert.equal(next.joinedMidRoute, null, 'a restart after a deadhead is not reported as a mid-route join');
  assert.deepEqual(run.stops.filter(s => s.phantom).map(s => s.stopName), ['Biblioteca Pompeu Fabra', 'Rodalies']);
  console.log('  ✓ Run: Biblioteca +49 and Rodalies +10 grouped as one phantom group between the two trips.');

  // ── Observatori integration ────────────────────────────────────────
  historyDb.init(process.env.DB_PATH);
  for (const s of samples) {
    historyDb.recordDelayLog({
      vehicleId: s.vehicleId, lineId: '8', lineCode: 'L8', agency: 'Mataró Bus (Avanza)',
      direction: s.direction, stopName: s.stopName, delayMins: s.delayMins, scheduledTime: s.scheduledTime,
      timestamp: s.timestamp, observedAt: s.timestamp, isRealTime: true, timesSource: s.scheduledTime ? 'derived_timetable' : ''
    });
  }

  const realDateNow = Date.now;
  Date.now = () => madrid('19:30:00');
  let inc;
  let phantomInspect;
  let servedInspect;
  let slowInspect;
  try {
    inc = historyDb.getDelayIncidents({ lineCode: 'all', hours: 24, limit: 30, minDelay: 5 });
    phantomInspect = historyDb.inspectDelayIncident({ lineCode: 'L8', stopName: 'Biblioteca Pompeu Fabra', vehicleId: '2669', at: madrid('14:52:30'), windowMins: 60, minDelay: 5 });
    servedInspect = historyDb.inspectDelayIncident({ lineCode: 'L8', stopName: 'Escola El Turó', vehicleId: '2669', at: madrid('14:43:10'), windowMins: 60, minDelay: 5 });
    slowInspect = historyDb.inspectDelayIncident({ lineCode: 'L8', stopName: 'Euskadi', vehicleId: '2691', at: madrid('17:12:00'), windowMins: 60, minDelay: 5 });
  } finally {
    Date.now = realDateNow;
  }

  const phantom = row => row.vehicleId === '2669' && row.timestamp >= madrid('14:52:30') && row.timestamp <= madrid('14:55:50');
  assert.equal(inc.topIncidents.filter(phantom).length, 0, 'the phantom records are not service incidents');
  assert.equal(inc.investigationIncidents.filter(phantom).length, 0, 'the phantom +49 is not an unusual schedule');
  const anomalies = inc.telemetryAnomalies.filter(row => row.anomalyType === 'deadhead_return');
  assert.ok(anomalies.length >= 1, 'the phantom records are listed with the SAE anomalies');
  assert.equal(anomalies[0].vehicleId, '2669');
  assert.equal(anomalies[0].delayMins, 49);
  assert.ok(anomalies[0].diagnosticBadge.includes('Tornada sense servei'));
  assert.equal(anomalies[0].deadhead.lastServedStop, 'Euskadi');
  assert.equal(inc.summary.deadheadReturns, 1);
  assert.equal(inc.summary.maxDelayMins, 31, 'the headline maximum excludes the phantom +49');
  console.log('  ✓ Incidents: phantom +49/+10 moved to the SAE anomalies; max delay 31, not 49.');

  const trip = inc.incidentTrips.find(t => t.vehicleId === '2669' && t.endReason === 'deadhead_return');
  assert.ok(trip, 'the 2669 trajectory ends as a deadhead return');
  assert.equal(trip.endStop, 'Euskadi');
  assert.equal(trip.stopsTraversed[trip.stopsTraversed.length - 1], 'Euskadi', 'the trajectory stops at the last served stop');
  assert.ok(trip.stopProgression.every(p => p.delayMins <= 27), 'the phantom +49 is not part of the trajectory');
  assert.equal(trip.maxDelayMins, 27, 'the trajectory maximum is the real +27, not the phantom +49');
  assert.equal(trip.endTs, madrid('14:46:30'), 'the trajectory ends when the bus stopped serving');
  assert.ok(trip.stopProgression.every(p => !p.isRecovered), 'a skipped trip is not a recovery');
  assert.equal(trip.deadhead.towards, 'Rodalies');
  assert.equal(trip.deadhead.returnMinutes, 11);
  assert.ok(!inc.incidentTrips.some(t => t.vehicleId === '2691' && t.endReason === 'deadhead_return'), 'the slow return is not a deadhead');
  console.log('  ✓ Trajectories: 2669 ends at Euskadi as "deadhead_return", not recovered.');

  assert.equal(phantomInspect.found, true);
  assert.equal(phantomInspect.episode.verdict, 'deadhead_return');
  const dh = phantomInspect.episode.deadheadReturn;
  assert.equal(dh.lastServedStop, 'Euskadi');
  assert.equal(dh.lastServedTime, '14:46');
  assert.equal(dh.resumeStop, 'Sant Joan');
  assert.equal(dh.resumeTime, '14:57');
  assert.equal(dh.towards, 'Galícia');
  assert.equal(dh.skippedFrom, 'Galícia');
  assert.equal(dh.skippedTo, 'Rodalies');
  assert.equal(dh.skippedDeparture, '14:24', 'the skipped trip is the 14:24 from Galícia');
  assert.deepEqual(dh.phantoms.map(p => `${p.stopName} ${p.delayMins} ${p.time}`), ['Biblioteca Pompeu Fabra 49 14:52', 'Rodalies 10 14:55']);
  assert.deepEqual({ ...dh.unservedGap }, { stopName: 'Roca Blanca', fromTime: '14:05', toTime: '14:51', minutes: 45, plannedHeadwayMinutes: 24 },
    'Roca Blanca had no bus in the operator data between 14:05 and 14:51');
  assert.ok(phantomInspect.episode.run.trips.some(t => t.isDeadhead), 'the run groups the phantom records');
  assert.notEqual(servedInspect.episode.verdict, 'deadhead_return', 'a served stop keeps its own verdict');
  assert.ok(servedInspect.episode.deadheadReturn, 'the served trip still explains the deadhead that follows it');
  assert.equal(servedInspect.episode.run.summary.pattern, 'sustained');
  assert.equal(slowInspect.episode.deadheadReturn, null, 'the slow return is not explained as a deadhead');
  console.log(`  ✓ Investigar: verdict "${phantomInspect.episode.verdict}"; skipped 14:24 Galícia -> Rodalies; Roca Blanca 14:05-14:51 without a bus in the data.`);

  // ── Panel wording (the page never says "no bus", only "no bus in the data") ──
  const observatori = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'observatori.js'), 'utf8');
  for (const needle of ['Tornada sense servei', "no consta cap bus a les dades de l'operador", 'Un bus sense equip de seguiment no constaria', "'is-phantom'", "inc.anomalyType === 'deadhead_return'"]) {
    assert.ok(observatori.includes(needle), `observatori.js mentions ${needle}`);
  }
  console.log('  ✓ Panel: "Tornada sense servei" group, phantom rows, and the gap worded as "no bus in the operator data".');

  console.log('🎉 ALL DEADHEAD RETURN ASSERTIONS PASSED!');
})().finally(() => {
  historyDb.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}).then(() => process.exit(0)).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
