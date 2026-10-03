require('./helpers/fixed_clock.cjs').install('2026-10-03T08:00:00Z');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// How a delayed trip's trajectory ends, and one incident row per bus trip.
// Production cases (Oct 2026): L2 bus 2684 ("recovered" at Parc Central +0 nine
// stops behind its last delayed stop, 2 Oct) and L3 bus 2676 (one 24-minute trip
// listed three times, 24 Sep).
try {
  const testDir = path.join(__dirname, '..', 'data', 'test_scratch');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  const testDbPath = process.env.DB_PATH || path.join(testDir, 'test_incident_trip_outcome.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const historyDb = require('../src/historyDb');
  historyDb.init(testDbPath);

  const min = 60 * 1000;
  // 2 Oct 2026 17:00 Madrid (CEST) = 15:00Z, a weekday inside every line's service.
  const T0 = Date.parse('2026-10-02T15:00:00Z');
  function add(vehicleId, lineCode, direction, stopName, delayMins, ts) {
    historyDb.recordDelayLog({
      vehicleId, lineId: lineCode.slice(1), lineCode, agency: 'Mataró Bus (Avanza)',
      stopId: stopName, stopName, delayMins, direction, isRealTime: true, timestamp: ts
    });
  }
  // Two samples 20 s apart per stop, `step` minutes between stops; returns the time after the last stop.
  function run(vehicleId, lineCode, direction, stops, startTs, step = 3) {
    let ts = startTs;
    for (const [stopName, delayMins] of stops) {
      add(vehicleId, lineCode, direction, stopName, delayMins, ts);
      add(vehicleId, lineCode, direction, stopName, delayMins, ts + 20 * 1000);
      ts += step * min;
    }
    return ts;
  }

  // 1. L2 bus T1: +26..+28 for ten stops, nine minutes with no record, then
  //    Parc Central (the 5th stop of 16 in this direction) at +0. Not a recovery.
  const t1After = run('T1', 'L2', '1', [
    ['Lepant', 27], ['Sant Isidor', 27], ['Parc Central', 26], ['Cabanellas', 26], ['Escola Freta', 26],
    ['Pau Picasso', 26], ['Perú', 26], ['Escola Vista Alegre', 27], ['Sant Oleguer', 27], ['Cirera', 28]
  ], T0);
  const t1End = t1After - 3 * min + 20 * 1000; // the last Cirera sample
  run('T1', 'L2', '1', [['Parc Central', 0], ['Cabanellas', 0]], t1End + 9 * min, 1);

  // 2. A real, gradual recovery: 8, 7, 6, then 4 at the next stop.
  run('T2', 'L2', '1', [['Lepant', 8], ['Sant Isidor', 7], ['Parc Central', 6], ['Cabanellas', 4], ['Escola Freta', 3]], T0 + 40 * min);

  // 3. A drop of 10+ min at the next stop along the route, after a 12-minute silence, is not a recovery
  //    either (inside 10 minutes the trip-relink rule catches it first, see trip_relink_test.js).
  const t3After = run('T3', 'L3', '0', [['Sant Joan', 16], ['Can Marfà', 15]], T0 + 40 * min);
  run('T3', 'L3', '0', [['L´Havana', 2], ['Sant Simó', 1]], t3After - 3 * min + 12 * min, 3);

  // 4. A trip that reaches the end of its line late, then leaves again.
  const t4After = run('T4', 'L2', '1', [['Cirera', 14], ['Mataró Parc', 15], ['Hospital de Mataró', 15]], T0 + 70 * min);
  run('T4', 'L2', '0', [['Hospital de Mataró', 6], ['Cementiri Les Valls', 5]], t4After + 1 * min);

  // 5. One continuous 27-minute trip whose peak passes 25: one row per tier (Top Incidents holds its
  //    peak below 25, "En investigació" its 26), not one row per 20 minutes.
  run('T5', 'L3', '1', [['Mataró Parc', 21], ['Can Soleret', 22], ['Camí de la Serra', 23], ['Joan Oliver', 24], ['Ronda Creu de Pedra', 24],
    ['Montalt', 25], ['Caputxins', 26], ['Franck Marshall', 25], ['Rafael Estrany', 24]], T0 + 100 * min, 3);

  // 6. The same shape without a 25+ sample: ONE row in Top Incidents, not one per 20 minutes.
  run('T6', 'L3', '1', [['Mataró Parc', 20], ['Can Soleret', 21], ['Camí de la Serra', 22], ['Joan Oliver', 22], ['Ronda Creu de Pedra', 22],
    ['Montalt', 23], ['Caputxins', 23], ['Franck Marshall', 22], ['Rafael Estrany', 21], ['Cervantes', 21]], T0 + 140 * min, 3);

  // 7. Two separate trips of one bus (a 40-minute silence between them): TWO rows.
  run('T7', 'L2', '1', [['Lepant', 18], ['Sant Isidor', 18], ['Parc Central', 19]], T0 + 200 * min);
  run('T7', 'L2', '1', [['Lepant', 17], ['Sant Isidor', 17], ['Parc Central', 16]], T0 + 250 * min);

  const res = historyDb.getDelayIncidents({ lineCode: 'all', hours: 168, limit: 100, minDelay: 5 });
  const card = id => res.incidentTrips.filter(t => t.vehicleId === id);

  // 1
  const c1 = card('T1')[0];
  assert.ok(c1, 'T1 has a trajectory card');
  assert.equal(c1.endReason, 'trip_change', 'a delay that vanishes on another trip is not a recovery');
  assert.ok(c1.stopProgression.every(p => !p.isRecovered), 'no stop is marked recovered');
  assert.equal(c1.stopProgression[c1.stopProgression.length - 1].stopName, 'Cirera', 'the trajectory ends at the last delayed stop');
  assert.equal(c1.endDelayMins, 28);
  assert.equal(c1.endMomentTs, t1End, 'endMomentTs is the last logged sample of the trajectory');
  assert.equal(c1.nextTrip.stopName, 'Parc Central');
  assert.equal(c1.nextTrip.delayMins, 0);
  assert.ok(c1.nextTrip.ts > c1.endMomentTs + 8 * min, 'the silence before the next record is visible through nextTrip.ts');
  // 2
  const c2 = card('T2')[0];
  assert.equal(c2.endReason, 'recovered', 'a gradual recovery is still a recovery');
  assert.equal(c2.stopProgression[c2.stopProgression.length - 1].isRecovered, true);
  assert.equal(c2.endDelayMins, 4);
  assert.equal(c2.nextTrip, null);
  // 3
  const c3 = card('T3')[0];
  assert.equal(c3.endReason, 'trip_change', 'a drop of 10+ min at the next stop is a trip change');
  assert.equal(c3.nextTrip.delayMins, 2);
  // 4
  const c4 = card('T4').find(t => t.direction === '1');
  assert.equal(c4.endReason, 'end_of_line');
  assert.equal(c4.endDelayMins, 15);
  assert.equal(c4.nextTrip.stopName, 'Hospital de Mataró');
  assert.equal(c4.nextTrip.delayMins, 6, 'the first record of the next trip is reported');
  // every card carries the new fields
  assert.ok(res.incidentTrips.every(t => Number.isFinite(t.endMomentTs) && 'nextTrip' in t && 'endDelayMins' in t));

  const rowsOf = id => [...res.topIncidents, ...res.investigationIncidents].filter(r => r.vehicleId === id);
  // 5
  assert.equal(res.investigationIncidents.filter(r => r.vehicleId === 'T5').length, 1, 'a trip with a 25+ sample is one row under investigation');
  assert.equal(res.investigationIncidents.find(r => r.vehicleId === 'T5').delayMins, 26, 'the investigation row is the trip peak');
  assert.equal(res.topIncidents.filter(r => r.vehicleId === 'T5').length, 1, 'and one row in Top Incidents, not one per 20 minutes');
  assert.equal(res.topIncidents.find(r => r.vehicleId === 'T5').delayMins, 24, 'holding the peak below 25');
  // 6
  assert.equal(rowsOf('T6').length, 1, 'a 30-minute trip with no 25+ sample is one Top Incidents row');
  assert.equal(rowsOf('T6')[0].delayMins, 23);
  // 7
  assert.equal(rowsOf('T7').length, 2, 'two trips of one bus are two rows');

  // The panel's wording for each ending, taken from the real source of the two helpers.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'observatori.js'), 'utf8');
  const from = src.indexOf('  /** HH:MM (Madrid) of an epoch-ms timestamp');
  const to = src.indexOf('  /** Plain-Catalan label for the server-side times_provenance');
  assert.ok(from > 0 && to > from, 'the outcome helpers are in observatori.js');
  const Helpers = new Function('return class { esc(s) { return String(s); } ' + src.slice(from, to) + ' }')();
  const ui = new Helpers();
  const clock = ts => new Date(ts).toLocaleTimeString('ca-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const o1 = ui._trajectoryOutcome(c1);
  assert.ok(o1.startsWith('El retard no es va recuperar en ruta.'), o1);
  assert.ok(o1.includes('Parc Central') && o1.includes(clock(c1.nextTrip.ts)) && o1.includes('0 min') && o1.includes('9 min sense registres'), o1);
  assert.ok(!/Recuperat/.test(o1), 'a trip change is never worded as a recovery');
  const o2 = ui._trajectoryOutcome(c2);
  assert.ok(o2.startsWith('Recuperat a Cabanellas a les ' + clock(c2.endMomentTs)) && o2.includes('+4 min'), o2);
  const o4 = ui._trajectoryOutcome(c4);
  assert.ok(o4.includes('final de línia') && o4.includes('+15 min de retard') && o4.includes('Torna a sortir') && o4.includes('+6 min'), o4);
  assert.equal(ui._trajectoryOutcome({ endReason: 'signal_lost', endStop: 'X', endMomentTs: c1.endMomentTs, endDelayMins: 12 }).startsWith('Sense registres des de les '), true);
  assert.equal(ui._trajectoryOutcome({ endReason: 'unknown' }), '');
  assert.equal(ui._clockOf(undefined), '');

  console.log('✅ INCIDENT TRIP OUTCOME TEST PASSED');
  process.exit(0);
} catch (err) {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
}
