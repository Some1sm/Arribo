require('./helpers/fixed_clock.cjs').install('2026-10-03T08:00:00Z');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// The edge-case debug table at the bottom of /dades Top Incidents: one row per
// relink, deadhead return, delay jump, backward leg and trip change, with the
// number of stored GPS positions around it. Fixtures are the production cases of
// Sep-Oct 2026 (L8 bus 2669 deadhead, L8 bus 2679 backward leg, L2 bus 2684 trip
// change) plus a small relink and delay jump.
try {
  const testDir = path.join(__dirname, '..', 'data', 'test_scratch');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  const testDbPath = process.env.DB_PATH || path.join(testDir, 'test_edge_cases.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  const historyDb = require('../src/historyDb');
  historyDb.init(testDbPath);

  assert.equal(historyDb.snapshotRetentionHours, 6, 'GPS positions are kept 6 h by default');
  const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  assert.ok(/SNAPSHOT_RETENTION_HOURS=6\b/.test(compose), 'docker-compose keeps positions 6 h');

  const min = 60 * 1000;
  const add = (vehicleId, lineCode, direction, stopName, delayMins, ts) => historyDb.recordDelayLog({
    vehicleId, lineId: lineCode.slice(1), lineCode, agency: 'Mataró Bus (Avanza)', stopId: stopName, stopName,
    delayMins, direction, isRealTime: true, timestamp: ts
  });
  const visit = (v, line, dir, stop, delay, ts) => { add(v, line, dir, stop, delay, ts); add(v, line, dir, stop, delay, ts + 20000); };

  // L8 bus 2679 backward leg, 2 Oct 09:50 Madrid = 07:50Z.
  const T8 = Date.parse('2026-10-02T07:50:00Z');
  const at8 = m => T8 + m * min;
  for (const [stop, delay, m] of [['Tarragona', 29, 0], ['Pl. Gatassa', 29, 2.5], ['Parc Cerdanyola', 29, 3], ['Gatassa', 28, 5], ['Institut Català Salut', 27, 6.5],
    ['Edif. Vidre - TecnoCampus', 26, 11], ['Ronda Barceló', 26, 17.5],
    ['Edif. Vidre - TecnoCampus', 26, 23], ['Institut Català Salut', 26, 25.5], ['Gatassa', 26, 32], ['Pl. Gatassa', 26, 34], ['Tarragona', 26, 36.5],
    ['Parc Cerdanyola', 26, 38], ['Roca Blanca', 26, 38.5], ['Tarragona', 26, 39.5], ['Roca Blanca', 26, 40.5]]) visit('B1', 'L8', '0', stop, delay, at8(m));
  visit('B1', 'L8', '0', 'Tarragona', 1, at8(42.5));
  // GPS positions stored around the leg.
  for (const m of [24, 28, 33, 38]) historyDb.recordVehicleSnapshot({ vehicleId: 'B1', lineId: '8', lineCode: 'L8', lat: 41.54, lon: 2.44, delayMins: 26, timestamp: at8(m) });

  // L2 bus T1 trip change, 2 Oct 17:00 Madrid = 15:00Z.
  const T2 = Date.parse('2026-10-02T15:00:00Z');
  let ts = T2;
  for (const [stop, delay] of [['Lepant', 27], ['Sant Isidor', 27], ['Parc Central', 26], ['Cabanellas', 26], ['Escola Freta', 26], ['Pau Picasso', 26], ['Perú', 26],
    ['Escola Vista Alegre', 27], ['Sant Oleguer', 27], ['Cirera', 28]]) { visit('T1', 'L2', '1', stop, delay, ts); ts += 3 * min; }
  const t1End = ts - 3 * min + 20000;
  visit('T1', 'L2', '1', 'Parc Central', 0, t1End + 9 * min);
  visit('T1', 'L2', '1', 'Cabanellas', 0, t1End + 10 * min);

  // L3 relink: +16, +15 then +2 at the next stops, 3 minutes apart, 2 Oct 13:00 Madrid = 11:00Z.
  const T3 = Date.parse('2026-10-02T11:00:00Z');
  visit('R1', 'L3', '0', 'Sant Joan', 16, T3);
  visit('R1', 'L3', '0', 'Can Marfà', 15, T3 + 3 * min);
  visit('R1', 'L3', '0', 'L´Havana', 2, T3 + 6 * min);
  visit('R1', 'L3', '0', 'Sant Simó', 1, T3 + 9 * min);

  // L7 delay jump: on time, then +29 two minutes later (a delay cannot grow faster than the clock), 2 Oct 14:00 Madrid.
  const T7 = Date.parse('2026-10-02T12:00:00Z');
  visit('J1', 'L7', '1', 'Parc Cerdanyola', 0, T7);
  for (let i = 0; i < 3; i++) visit('J1', 'L7', '1', 'Pl. Tereses', 29 + (i === 2 ? 1 : 0), T7 + 2 * min + i * 20000);

  // L8 bus 2669 deadhead return, 29 Sep 2026 (production), Madrid = UTC+2.
  const madrid = hms => { const [h, m, s] = hms.split(':').map(Number); return Date.UTC(2026, 8, 29, h - 2, m, s || 0); };
  const BUS_2669 = [
    ['14:05:50', '1', 'La Rambla', 23], ['14:06:30', '1', 'Sant Joan', 22], ['14:09:10', '1', 'Can Marfà', 23], ['14:11:50', '1', 'Floridablanca', 24],
    ['14:14:30', '1', 'Pl. Fiveller', 23], ['14:16:30', '1', 'La Riera', 23], ['14:19:11', '1', 'Parc Central', 24], ['14:20:30', '1', 'Geganta', 23],
    ['14:25:10', '1', 'Pl. Granollers', 25], ['14:26:30', '1', 'O´ Donnell', 25], ['14:28:30', '1', 'Biblioteca Pompeu Fabra', 26],
    ['14:29:50', '1', 'Institut Català Salut', 26], ['14:31:50', '1', 'Gatassa', 26], ['14:33:10', '1', 'Parc Cerdanyola', 26], ['14:35:50', '1', 'Cerdanyola', 25],
    ['14:37:50', '1', 'Ronda Cerdanya', 27], ['14:41:10', '1', 'Ample', 27], ['14:42:30', '1', 'Roca Blanca', 25], ['14:43:10', '1', 'Escola El Turó', 24],
    ['14:46:30', '1', 'Euskadi', 26], ['14:52:30', '1', 'Biblioteca Pompeu Fabra', 49], ['14:55:50', '0', 'Rodalies', 10],
    ['14:57:50', '1', 'Sant Joan', 3], ['15:01:10', '1', 'Can Marfà', 4], ['15:03:10', '1', 'Floridablanca', 3], ['15:05:10', '1', 'Pl. Fiveller', 4], ['15:08:30', '1', 'La Riera', 2]
  ];
  for (const [hms, dir, stop, delay] of BUS_2669) add('2669', 'L8', dir, stop, delay, madrid(hms));
  // The only buses the feed logged at Roca Blanca on Galícia -> Rodalies around it.
  add('2665', 'L8', '0', 'Roca Blanca', 5, madrid('14:05:50'));
  add('2667', 'L8', '0', 'Roca Blanca', 3, madrid('14:51:10'));
  add('2665', 'L8', '0', 'Roca Blanca', 0, madrid('15:12:30'));

  const res = historyDb.getDelayIncidents({ lineCode: 'all', hours: 240, limit: 100, minDelay: 5 });
  assert.equal(res.snapshotRetentionHours, 6);
  assert.ok(Array.isArray(res.edgeCases), 'the payload carries edgeCases');
  const byVehicle = (kind, vehicle) => res.edgeCases.find(c => c.kind === kind && c.vehicleId === vehicle);

  const relink = byVehicle('relink', 'R1');
  const jump = byVehicle('delay_jump', 'J1');
  const back = byVehicle('backward_leg', 'B1');
  const change = byVehicle('trip_change', 'T1');
  const dead = byVehicle('deadhead_return', '2669');
  for (const [name, c] of [['relink', relink], ['delay_jump', jump], ['backward_leg', back], ['trip_change', change], ['deadhead_return', dead]]) {
    assert.ok(c, `an edge case of kind ${name} is listed`);
    assert.ok(Number.isFinite(c.fromTs) && Number.isFinite(c.toTs) && c.toTs >= c.fromTs, `${name}: a time range`);
    assert.ok(c.lineCode && c.fromStop && c.toStop && c.stop, `${name}: lines and stops`);
    assert.ok(Number.isFinite(c.at), `${name}: an instant to investigate`);
    assert.ok(Number.isInteger(c.gpsPoints) && typeof c.gpsExpired === 'boolean', `${name}: GPS evidence`);
    // The Investigar button's arguments find the case.
    const insp = historyDb.inspectDelayIncident({ lineCode: c.lineCode, stopName: c.stop, vehicleId: c.vehicleId, at: c.at, windowMins: 60, minDelay: 5 });
    assert.equal(insp.found, true, `${name}: Investigar finds it (stop ${c.stop})`);
  }
  assert.equal(relink.delayBefore, 15); assert.equal(relink.delayAfter, 2);
  assert.equal(jump.delayBefore, 0); assert.equal(jump.delayAfter, 29); assert.equal(jump.detail.elapsedMins, 2);
  assert.equal(back.fromStop, 'Ronda Barceló'); assert.equal(back.toStop, 'Roca Blanca'); assert.equal(back.detail.stepsBack, 10); assert.equal(back.detail.visits, 9);
  assert.equal(change.fromStop, 'Cirera'); assert.equal(change.toStop, 'Parc Central'); assert.equal(change.delayBefore, 28); assert.equal(change.delayAfter, 0);
  assert.equal(change.detail.silentMinutes, 9);
  assert.equal(dead.fromStop, 'Euskadi'); assert.equal(dead.toStop, 'Sant Joan'); assert.equal(dead.detail.returnMinutes, 11);

  // GPS evidence: the backward leg has 4 stored positions; the others none, and old enough to be pruned.
  assert.equal(back.gpsPoints, 4);
  assert.equal(back.gpsExpired, false);
  assert.equal(change.gpsPoints, 0);
  assert.equal(change.gpsExpired, true, 'no positions and older than the retention: they were pruned');
  assert.ok(res.edgeCases.every(c => c.gpsPoints >= 0));
  // Newest first.
  for (let i = 1; i < res.edgeCases.length; i++) assert.ok(res.edgeCases[i - 1].fromTs >= res.edgeCases[i].fromTs, 'newest first');

  // The panel: render the real method from observatori.js.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'observatori.js'), 'utf8');
  const from = src.indexOf('  /** "02/10 18:23" (Madrid)');
  const to = src.indexOf('  /** Copy the edge-case table as tab-separated text. */');
  assert.ok(from > 0 && to > from, 'the edge-case helpers are in observatori.js');
  const body = src.slice(from, to);
  assert.equal(body.includes('style="'), false, 'no inline styles (the design-system ratchet counts them)');
  const Ui = new Function('return class { esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"); } ' + body + ' }')();
  const ui = new Ui();
  const html = ui._renderEdgeCaseTable(res);
  for (const label of ['Viatge reassignat', 'Tornada sense servei', 'Salt de retard', 'Sentit invers', 'Canvi de viatge']) assert.ok(html.includes(label), `the table names ${label}`);
  assert.ok(html.includes('Casos límit (taula de depuració)'));
  assert.ok(html.includes('data-investigate-vehicle="B1"') && html.includes('data-investigate-at="'), 'rows carry the Investigar arguments');
  assert.ok(html.includes('4 posicions'), 'the GPS count is shown');
  assert.ok(html.includes('caducades (només 6 h)'), 'pruned positions say why');
  assert.ok(html.includes('id="btn-copy-edge-cases"'));
  assert.ok(html.includes('es guarden 6 h'));
  assert.equal(/undefined|NaN|\bnull\b/.test(html), false, 'no placeholder text leaks into the table');
  const empty = ui._renderEdgeCaseTable({});
  assert.ok(empty.includes('Cap cas límit'), 'an empty list says so');
  assert.equal(empty.includes('btn-copy-edge-cases'), false, 'and offers no copy button');
  assert.ok(src.includes('copyEdgeCases()') && src.includes("closest('#btn-copy-edge-cases')"), 'the copy button is wired');

  console.log('✅ EDGE CASES TEST PASSED');
  process.exit(0);
} catch (err) {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
}
