'use strict';

/**
 * test/delay_origin_test.js
 *
 * Investigar traces a delay back to where it began. Fixture = production L8 bus
 * 2667 on 2026-09-29, 10:20-14:12 (first and last sample of each stop visit, as
 * logged). Clicked: Biblioteca Pompeu Fabra at 13:40, +25, on a trip that
 * started at La Rambla at +18. The bus was last without delay at La Rambla at
 * 10:38 (+3), four trips earlier; the delay grew at Sant Joan (10:41-10:50,
 * +5 -> +12), between Pl. Doctor Fleming and Ronda Barceló (+10 -> +13) and
 * between Sant Joan and Can Marfà (11:55-12:07, +10 -> +19). Near Galícia the
 * feed logs Galícia, Euskadi, Poliesportiu Euskadi, Galícia: a 2-stop step back
 * that must not split the trip.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-delay-origin-'));
process.env.DB_PATH = path.join(scratch, 'history.db');
process.env.REPORTS_DIR = path.join(scratch, 'reports');

const historyDb = require('../src/historyDb');
const mataroSchedules = require('../src/data/mataroSchedules');
const { normalizeStopName } = require('../src/core/schedule/tripMatcher');
const { buildIncidentRun, RUN_CONTEXT_MS } = require('../src/core/schedule/incidentRun');

// 2026-09-29 is a Tuesday in CEST (UTC+2).
const madrid = hms => {
  const [h, m, s] = hms.split(':').map(Number);
  return Date.UTC(2026, 8, 29, h - 2, m, s || 0);
};

// [time, direction, stop, delay, scheduled] exactly as bus 2667 logged them.
const BUS_2667 = [
  ['10:20:28', '0', 'Edif. Vidre - TecnoCampus', 4, '10:18'],
  ['10:21:08', '0', 'Edif. Vidre - TecnoCampus', 4, '10:18'],
  ['10:21:48', '0', 'Porta Laietana-TecnoCampus', 4, '10:21'],
  ['10:23:09', '0', 'Porta Laietana-TecnoCampus', 5, '10:21'],
  ['10:23:48', '0', 'Jutjats', 4, '10:23'],
  ['10:26:28', '0', 'Jutjats', 5, '10:23'],
  ['10:27:09', '0', 'Pl. Doctor Fleming', 4, '10:24'],
  ['10:30:28', '0', 'Pl. Doctor Fleming', 7, '10:24'],
  ['10:31:08', '0', 'Ronda Barceló', 7, '10:25'],
  ['10:33:08', '0', 'Ronda Barceló', 9, '10:25'],
  ['10:33:48', '0', 'Rodalies', 9, '10:27'],
  ['10:35:08', '0', 'Rodalies', 8, '10:27'],
  ['10:38:28', '1', 'La Rambla', 3, '10:38'],
  ['10:41:08', '1', 'Sant Joan', 5, '10:40'],
  ['10:50:29', '1', 'Sant Joan', 12, '10:40'],
  ['10:51:49', '1', 'Can Marfà', 12, '10:41'],
  ['10:52:28', '1', 'Can Marfà', 12, '10:41'],
  ['10:53:09', '1', 'Floridablanca', 12, '10:43'],
  ['10:53:49', '1', 'Pl. Fiveller', 12, '10:45'],
  ['10:54:29', '1', 'Pl. Fiveller', 11, '10:45'],
  ['10:55:09', '1', 'La Coma', 11, '10:46'],
  ['10:58:29', '1', 'La Riera', 11, '10:48'],
  ['10:59:49', '1', 'Parc Central', 10, '10:51'],
  ['11:00:29', '1', 'Geganta', 9, '10:53'],
  ['11:01:09', '1', 'Pl. Granollers', 9, '10:54'],
  ['11:02:29', '1', 'Pl. Granollers', 9, '10:54'],
  ['11:03:09', '1', 'O´ Donnell', 9, '10:56'],
  ['11:04:29', '1', 'O´ Donnell', 10, '10:56'],
  ['11:06:29', '1', 'Biblioteca Pompeu Fabra', 11, '10:57'],
  ['11:07:09', '1', 'Institut Català Salut', 10, '10:59'],
  ['11:08:29', '1', 'Institut Català Salut', 11, '10:59'],
  ['11:09:49', '1', 'Gatassa', 11, '11:00'],
  ['11:11:09', '1', 'Parc Cerdanyola', 11, '11:03'],
  ['11:11:49', '1', 'Parc Cerdanyola', 11, '11:03'],
  ['11:12:29', '1', 'Cerdanyola', 9, '11:04'],
  ['11:13:49', '1', 'Cerdanyola', 10, '11:04'],
  ['11:14:29', '1', 'Ronda Cerdanya', 10, '11:06'],
  ['11:15:09', '1', 'Ronda Cerdanya', 11, '11:06'],
  ['11:15:49', '1', 'Vallès', 10, '11:07'],
  ['11:16:29', '1', 'Vallès', 10, '11:07'],
  ['11:17:09', '1', 'Ample', 10, '11:08'],
  ['11:17:49', '1', 'Roca Blanca', 9, '11:11'],
  ['11:18:29', '1', 'Roca Blanca', 9, '11:11'],
  ['11:19:09', '1', 'Escola El Turó', 8, '11:12'],
  ['11:20:29', '1', 'Escola El Turó', 9, '11:12'],
  ['11:21:09', '1', 'Galícia', 10, '11:16'],
  ['11:21:49', '1', 'Euskadi', 10, '11:14'],
  ['11:22:29', '1', 'Poliesportiu Euskadi', 9, '11:14'],
  ['11:23:09', '1', 'Galícia', 9, '11:16'],
  ['11:23:49', '1', 'Galícia', 8, '11:16'],
  ['11:25:10', '0', 'Tarragona', 8, '11:19'],
  ['11:26:29', '0', 'Tarragona', 9, '11:19'],
  ['11:27:09', '0', 'Pl. Gatassa', 9, '11:20'],
  ['11:28:29', '0', 'Pl. Gatassa', 9, '11:20'],
  ['11:29:09', '0', 'Parc Cerdanyola', 10, '11:22'],
  ['11:30:30', '0', 'Parc Cerdanyola', 10, '11:22'],
  ['11:31:09', '0', 'Gatassa', 9, '11:23'],
  ['11:32:29', '0', 'Gatassa', 10, '11:23'],
  ['11:33:09', '0', 'Institut Català Salut', 10, '11:26'],
  ['11:35:09', '0', 'Institut Català Salut', 11, '11:26'],
  ['11:35:50', '0', 'Edif. Vidre - TecnoCampus', 10, '11:27'],
  ['11:36:29', '0', 'Edif. Vidre - TecnoCampus', 10, '11:27'],
  ['11:37:09', '0', 'Porta Laietana-TecnoCampus', 10, '11:30'],
  ['11:37:49', '0', 'Porta Laietana-TecnoCampus', 11, '11:30'],
  ['11:39:09', '0', 'Jutjats', 11, '11:32'],
  ['11:41:10', '0', 'Jutjats', 11, '11:32'],
  ['11:41:49', '0', 'Pl. Doctor Fleming', 10, '11:33'],
  ['11:42:29', '0', 'Pl. Doctor Fleming', 10, '11:33'],
  ['11:46:30', '0', 'Ronda Barceló', 13, '11:35'],
  ['11:47:09', '0', 'Ronda Barceló', 13, '11:35'],
  ['11:47:49', '0', 'Rodalies', 12, '11:37'],
  ['11:48:29', '0', 'Rodalies', 12, '11:37'],
  ['11:50:29', '1', 'La Rambla', 7, '11:47'],
  ['11:54:29', '1', 'Sant Joan', 9, '11:49'],
  ['11:56:29', '1', 'Sant Joan', 10, '11:49'],
  ['12:07:50', '1', 'Can Marfà', 19, '11:51'],
  ['12:08:29', '1', 'Can Marfà', 19, '11:51'],
  ['12:09:09', '1', 'Floridablanca', 19, '11:52'],
  ['12:09:49', '1', 'Floridablanca', 18, '11:52'],
  ['12:11:09', '1', 'Pl. Fiveller', 19, '11:55'],
  ['12:12:29', '1', 'Pl. Fiveller', 20, '11:55'],
  ['12:13:10', '1', 'La Coma', 18, '11:56'],
  ['12:13:49', '1', 'La Coma', 18, '11:56'],
  ['12:14:29', '1', 'La Riera', 18, '11:58'],
  ['12:15:09', '1', 'La Riera', 19, '11:58'],
  ['12:15:50', '1', 'Parc Central', 18, '12:01'],
  ['12:17:09', '1', 'Parc Central', 18, '12:01'],
  ['12:19:49', '1', 'Geganta', 19, '12:03'],
  ['12:21:10', '1', 'Geganta', 19, '12:03'],
  ['12:21:49', '1', 'Pl. Granollers', 19, '12:04'],
  ['12:23:49', '1', 'O´ Donnell', 20, '12:06'],
  ['12:25:49', '1', 'O´ Donnell', 21, '12:06'],
  ['12:26:30', '1', 'Biblioteca Pompeu Fabra', 20, '12:07'],
  ['12:27:09', '1', 'Institut Català Salut', 20, '12:09'],
  ['12:29:09', '1', 'Gatassa', 21, '12:10'],
  ['12:31:50', '1', 'Gatassa', 22, '12:10'],
  ['12:32:29', '1', 'Parc Cerdanyola', 22, '12:13'],
  ['12:33:09', '1', 'Parc Cerdanyola', 23, '12:13'],
  ['12:33:49', '1', 'Cerdanyola', 21, '12:14'],
  ['12:35:49', '1', 'Cerdanyola', 22, '12:14'],
  ['12:38:29', '1', 'Ronda Cerdanya', 23, '12:16'],
  ['12:39:49', '1', 'Ample', 23, '12:18'],
  ['12:40:29', '1', 'Ample', 23, '12:18'],
  ['12:43:11', '1', 'Escola El Turó', 22, '12:22'],
  ['12:44:29', '1', 'Galícia', 23, '12:26'],
  ['12:45:09', '1', 'Euskadi', 22, '12:24'],
  ['12:45:49', '1', 'Poliesportiu Euskadi', 22, '12:24'],
  ['12:46:29', '1', 'Galícia', 22, '12:26'],
  ['12:47:50', '1', 'Galícia', 22, '12:26'],
  ['12:48:29', '0', 'Tarragona', 21, '12:29'],
  ['12:50:29', '0', 'Tarragona', 22, '12:29'],
  ['12:51:09', '0', 'Pl. Gatassa', 22, '12:30'],
  ['12:51:49', '0', 'Parc Cerdanyola', 22, '12:32'],
  ['12:53:49', '0', 'Gatassa', 22, '12:33'],
  ['12:54:29', '0', 'Gatassa', 22, '12:33'],
  ['12:55:49', '0', 'Institut Català Salut', 23, '12:36'],
  ['12:57:09', '0', 'Edif. Vidre - TecnoCampus', 23, '12:37'],
  ['12:59:09', '0', 'Edif. Vidre - TecnoCampus', 23, '12:37'],
  ['12:59:49', '0', 'Porta Laietana-TecnoCampus', 23, '12:40'],
  ['13:01:49', '0', 'Porta Laietana-TecnoCampus', 24, '12:40'],
  ['13:03:09', '0', 'Jutjats', 23, '12:42'],
  ['13:03:49', '0', 'Jutjats', 23, '12:42'],
  ['13:05:49', '0', 'Ronda Barceló', 23, '12:44'],
  ['13:07:09', '0', 'Ronda Barceló', 24, '12:44'],
  ['13:08:29', '0', 'Rodalies', 24, '12:46'],
  ['13:09:49', '0', 'Rodalies', 24, '12:46'],
  ['13:11:09', '1', 'La Rambla', 17, '12:57'],
  ['13:13:09', '1', 'La Rambla', 18, '12:57'],
  ['13:13:49', '1', 'Sant Joan', 18, '12:59'],
  ['13:18:29', '1', 'Sant Joan', 21, '12:59'],
  ['13:19:50', '1', 'Can Marfà', 21, '13:01'],
  ['13:20:29', '1', 'Can Marfà', 20, '13:01'],
  ['13:21:09', '1', 'Floridablanca', 21, '13:02'],
  ['13:22:29', '1', 'Pl. Fiveller', 20, '13:05'],
  ['13:23:50', '1', 'Pl. Fiveller', 21, '13:05'],
  ['13:24:29', '1', 'La Coma', 21, '13:06'],
  ['13:25:49', '1', 'La Coma', 21, '13:06'],
  ['13:26:29', '1', 'La Riera', 20, '13:08'],
  ['13:27:49', '1', 'La Riera', 21, '13:08'],
  ['13:28:29', '1', 'Parc Central', 20, '13:11'],
  ['13:29:50', '1', 'Parc Central', 20, '13:11'],
  ['13:32:29', '1', 'Geganta', 21, '13:13'],
  ['13:33:50', '1', 'Geganta', 22, '13:13'],
  ['13:36:29', '1', 'Pl. Granollers', 23, '13:14'],
  ['13:37:09', '1', 'O´ Donnell', 23, '13:16'],
  ['13:39:09', '1', 'O´ Donnell', 24, '13:16'],
  ['13:40:29', '1', 'Biblioteca Pompeu Fabra', 24, '13:17'],
  ['13:41:10', '1', 'Biblioteca Pompeu Fabra', 25, '13:17'],
  ['13:41:50', '1', 'Institut Català Salut', 25, '13:19'],
  ['13:42:30', '1', 'Institut Català Salut', 25, '13:19'],
  ['13:45:10', '1', 'Gatassa', 26, '13:20'],
  ['13:47:49', '1', 'Parc Cerdanyola', 27, '13:23'],
  ['13:49:50', '1', 'Cerdanyola', 26, '13:24'],
  ['13:51:09', '1', 'Ronda Cerdanya', 27, '13:26'],
  ['13:51:50', '1', 'Ronda Cerdanya', 27, '13:26'],
  ['13:53:09', '1', 'Vallès', 28, '13:27'],
  ['13:54:30', '1', 'Vallès', 28, '13:27'],
  ['13:55:10', '1', 'Ample', 28, '13:28'],
  ['13:58:30', '1', 'Escola El Turó', 27, '13:32'],
  ['13:59:10', '1', 'Galícia', 27, '13:36'],
  ['14:01:50', '1', 'Poliesportiu Euskadi', 29, '13:34'],
  ['14:03:10', '1', 'Poliesportiu Euskadi', 29, '13:34'],
  ['14:11:10', '1', 'O´ Donnell', -13, '14:27'],
  ['14:11:50', '1', 'Pl. Granollers', -13, '14:25']
];

const rows = BUS_2667.map(([hms, direction, stopName, delayMins, scheduled]) => ({
  vehicleId: '2667', lineCode: 'L8', direction, stopName, delayMins,
  timestamp: madrid(hms), formattedDate: `2026-09-29 ${hms}`, scheduledTime: `${scheduled}:00`
}));

const stopIndex = (lineCode, direction, stopName) => {
  const ds = mataroSchedules.getDirectionSchedule(String(lineCode).replace(/^L/i, ''), direction, 'weekday');
  if (!ds) return null;
  const names = ds.stops.map(s => normalizeStopName(s.name));
  const wanted = normalizeStopName(stopName);
  const indexes = [];
  names.forEach((n, i) => { if (n === wanted) indexes.push(i); });
  return indexes.length ? { indexes, lastIndex: names.length - 1 } : null;
};

const clicked = { clickedStop: 'Biblioteca Pompeu Fabra', clickedFrom: madrid('13:40:29'), clickedTo: madrid('13:41:10'), stopIndex };

(async () => {
  // ── Origin ─────────────────────────────────────────────────────────
  const run = buildIncidentRun(rows, { ...clicked, showFrom: madrid('13:40:29') - RUN_CONTEXT_MS });
  const o = run.origin;
  assert.ok(o, 'a +25 delay has an origin');
  assert.deepEqual({ ...o.onTime }, { stopName: 'La Rambla', towards: '', time: '10:38:28', delayMins: 3 });
  assert.equal(o.tripsBefore, 4, 'the delay was carried over four trips');
  assert.deepEqual(o.events.map(e => [e.kind, e.previousStop, e.stopName, e.fromTime, e.toTime, e.fromDelay, e.toDelay, e.growth]), [
    ['at_stop', 'La Rambla', 'Sant Joan', '10:41:08', '10:50:29', 5, 12, 9],
    ['between', 'Pl. Doctor Fleming', 'Ronda Barceló', '11:42:29', '11:47:09', 10, 13, 3],
    ['between', 'Sant Joan', 'Can Marfà', '11:56:29', '12:08:29', 10, 19, 9]
  ]);
  assert.equal(run.stops[0].time, '10:38:28', 'the run reaches back to the last stop without delay');
  assert.equal(run.stops[0].originStart, true);
  assert.deepEqual(run.stops.filter(s => s.delayGrowth).map(s => `${s.stopName} ${s.delayGrowth}`), ['Sant Joan 9', 'Ronda Barceló 3', 'Can Marfà 9']);
  assert.equal(run.summary.pattern, 'building', 'the clicked trip keeps its own summary');
  assert.equal(run.summary.firstDelay, 18);
  console.log('  ✓ Origin: last without delay at La Rambla 10:38 (+3), four trips back; grew at Sant Joan, Ronda Barceló and Can Marfà.');

  // ── Trips: 1-2 stop jitter does not split a trip ─────────────────────
  assert.deepEqual(run.trips.map(t => `${t.direction}:${t.fromTime.slice(0, 5)}`), ['1:10:38', '0:11:25', '1:11:50', '0:12:48', '1:13:11', '1:14:11'],
    'five trips plus the next one; Galícia/Euskadi/Poliesportiu Euskadi does not start a trip');
  assert.equal(run.trips.findIndex(t => t.isClickedTrip), 4);
  const jitter = buildIncidentRun([
    ['12:00:00', 'Escola El Turó'], ['12:01:00', 'Galícia'], ['12:02:00', 'Euskadi'], ['12:03:00', 'Poliesportiu Euskadi'], ['12:04:00', 'Galícia']
  ].map(([hms, stopName]) => ({ lineCode: 'L8', direction: '1', stopName, delayMins: 8, timestamp: madrid(hms), formattedDate: `2026-09-29 ${hms}` })), { stopIndex });
  assert.equal(jitter.trips.length, 1, 'a 2-stop step back near the terminus is jitter');
  const jump = buildIncidentRun([
    ['12:00:00', 'Euskadi'], ['12:02:00', 'Ample']
  ].map(([hms, stopName]) => ({ lineCode: 'L8', direction: '1', stopName, delayMins: 8, timestamp: madrid(hms), formattedDate: `2026-09-29 ${hms}` })), { stopIndex });
  assert.equal(jump.trips.length, 2, 'a 3-stop step back is a new trip');
  console.log('  ✓ Trips: a 2-stop step back is jitter, a 3-stop one starts a trip.');

  // ── Edges ──────────────────────────────────────────────────────────
  const small = buildIncidentRun(rows, { ...clicked, clickedStop: 'La Rambla', clickedFrom: madrid('10:38:28'), clickedTo: madrid('10:38:28') });
  assert.equal(small.origin, null, 'a delay under 5 min has no origin to trace');
  const late = rows.filter(r => r.timestamp >= madrid('11:00:00'));
  const noOnTime = buildIncidentRun(late, { ...clicked, showFrom: madrid('13:40:29') - RUN_CONTEXT_MS });
  assert.equal(noOnTime.origin.onTime, null, 'no stop without delay in the loaded samples');
  assert.deepEqual({ ...noOnTime.origin.since }, { time: '11:00:29', delayMins: 9 });
  assert.equal(noOnTime.stops[0].time, '11:00:29', 'the run then starts at the first sample');
  const plain = buildIncidentRun(rows, clicked);
  assert.equal(plain.stops[0].time, rows[0].formattedDate.slice(11), 'without showFrom every visit is shown');
  console.log('  ✓ Edges: no origin under 5 min; "already late at the first sample" when nothing earlier is on time.');

  // ── Investigar integration ─────────────────────────────────────────
  historyDb.init(process.env.DB_PATH);
  for (const r of rows) {
    historyDb.recordDelayLog({
      vehicleId: r.vehicleId, lineId: '8', lineCode: 'L8', agency: 'Mataró Bus (Avanza)',
      direction: r.direction, stopName: r.stopName, delayMins: r.delayMins, scheduledTime: r.scheduledTime,
      timestamp: r.timestamp, observedAt: r.timestamp, isRealTime: true, timesSource: 'derived_timetable'
    });
  }
  const realDateNow = Date.now;
  Date.now = () => madrid('19:30:00');
  let inspect;
  try {
    inspect = historyDb.inspectDelayIncident({ lineCode: 'L8', stopName: 'Biblioteca Pompeu Fabra', vehicleId: '2667', at: madrid('13:40:29'), windowMins: 60, minDelay: 5 });
  } finally {
    Date.now = realDateNow;
  }
  assert.equal(inspect.found, true);
  const ir = inspect.episode.run;
  assert.equal(ir.origin.onTime.time, '10:38:28', 'Investigar loads enough of the bus to reach 10:38');
  assert.equal(ir.origin.onTime.towards, 'Galícia');
  assert.equal(ir.origin.tripsBefore, 4);
  assert.equal(ir.stops[0].time, '10:38:28');
  assert.ok(ir.stops.some(s => s.isClicked && s.stopName === 'Biblioteca Pompeu Fabra'));
  console.log('  ✓ Investigar: the run starts at 10:38 and carries the origin.');

  const observatori = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'observatori.js'), 'utf8');
  for (const needle of ["D'on ve el retard", "L'últim registre sense retard", 'drilldown-growth', 'is-origin-start', 'drilldown-jump']) {
    assert.ok(observatori.includes(needle), `observatori.js mentions ${needle}`);
  }
  console.log('  ✓ Panel: "D\'on ve el retard" note, ▲ marks and the jump to the last stop without delay.');

  console.log('🎉 ALL DELAY ORIGIN ASSERTIONS PASSED!');
})().finally(() => {
  historyDb.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}).then(() => process.exit(0)).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
