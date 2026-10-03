require('./helpers/fixed_clock.cjs').install('2026-10-03T08:00:00Z');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// A bus that drives back along its route while the operator's feed keeps the
// trip's direction and the last delay. Production case: L8 bus 2679, 2 Oct 2026,
// 10:13-10:30, +26 at Ronda Barceló then nine records running back to Roca Blanca.
try {
  const { findBackwardLegs, backwardCovering, backwardOverlapping } = require('../src/core/schedule/backwardLeg');
  const { normalizeStopName } = require('../src/core/schedule/tripMatcher');
  const mataroSchedules = require('../src/data/mataroSchedules');

  const orderCache = new Map();
  const stopIndex = (lineCode, direction, stopName) => {
    const key = `${lineCode}|${direction}`;
    if (!orderCache.has(key)) {
      const ds = mataroSchedules.getDirectionSchedule(String(lineCode).replace(/^L/i, ''), direction, 'weekday');
      orderCache.set(key, ds && ds.stops.length ? ds.stops.map(s => normalizeStopName(s.name)) : null);
    }
    const names = orderCache.get(key);
    if (!names) return null;
    const wanted = normalizeStopName(stopName);
    const indexes = [];
    names.forEach((n, i) => { if (n === wanted) indexes.push(i); });
    return indexes.length ? { indexes, lastIndex: names.length - 1 } : null;
  };

  const min = 60 * 1000;
  // 2 Oct 2026, 09:50 Madrid (CEST) = 07:50Z.
  const T0 = Date.parse('2026-10-02T07:50:00Z');
  const at = (m, s = 0) => T0 + m * min + s * 1000;
  const sample = (vehicleId, lineCode, direction, stopName, delayMins, ts) => ({ vehicleId, lineCode, direction, stopName, delayMins, timestamp: ts });
  // A visit = two samples 20 s apart.
  const visit = (v, line, dir, stop, delay, ts) => [sample(v, line, dir, stop, delay, ts), sample(v, line, dir, stop, delay, ts + 20000)];

  // L8 direction 0: Galícia(0) Roca Blanca(1) Tarragona(2) Pl. Gatassa(3) Parc Cerdanyola(4) Gatassa(5)
  //   Institut Català Salut(6) Edif. Vidre - TecnoCampus(7) Porta Laietana-TecnoCampus(8) Jutjats(9)
  //   Pl. Doctor Fleming(10) Ronda Barceló(11) Rodalies(12)
  const forward = [
    ['Tarragona', 29, 0], ['Pl. Gatassa', 29, 2.5], ['Parc Cerdanyola', 29, 3], ['Gatassa', 28, 5], ['Institut Català Salut', 27, 6.5],
    ['Edif. Vidre - TecnoCampus', 26, 11], ['Ronda Barceló', 26, 17.5]
  ];
  const back = [
    ['Edif. Vidre - TecnoCampus', 26, 23], ['Institut Català Salut', 26, 25.5], ['Gatassa', 26, 32], ['Pl. Gatassa', 26, 34], ['Tarragona', 26, 36.5],
    ['Parc Cerdanyola', 26, 38], ['Roca Blanca', 26, 38.5], ['Tarragona', 26, 39.5], ['Roca Blanca', 26, 40.5]
  ];
  const trip = (v, list) => list.flatMap(([stop, delay, m]) => visit(v, 'L8', '0', stop, delay, at(m)));

  // 1. The production pattern is found, with its exact window and the stop it started from.
  const samples = [...trip('B1', forward), ...trip('B1', back), ...visit('B1', 'L8', '0', 'Tarragona', 1, at(42.5))];
  const legs = findBackwardLegs(samples, { stopIndex });
  assert.equal(legs.length, 1, 'one backward leg');
  const leg = legs[0];
  assert.equal(leg.vehicleId, 'B1');
  assert.equal(leg.lineCode, 'L8');
  assert.equal(leg.lastServedStop, 'Ronda Barceló');
  assert.equal(leg.lastServedDelay, 26);
  assert.equal(leg.lowestStop, 'Roca Blanca');
  assert.equal(leg.stepsBack, 10, 'Ronda Barceló is index 11, Roca Blanca index 1');
  assert.equal(leg.visitCount, 9);
  assert.equal(leg.staleFromTs, at(23), 'the leg starts at its first record behind the furthest stop');
  assert.equal(leg.staleToTs, at(40.5, 20), 'and ends at the last record before the delay changes');
  assert.equal(backwardCovering(legs, 'B1', 'l8', at(30)) === leg, true, 'a record inside the leg is covered (line code case-insensitive)');
  assert.equal(backwardCovering(legs, 'B1', 'L8', at(17.5)), null, 'the forward stretch is not covered');
  assert.equal(backwardCovering(legs, 'B1', 'L8', at(42.5)), null, 'the on-time record after it is not covered');
  assert.equal(backwardOverlapping(legs, 'B1', 'L8', at(0), at(20)), null);
  assert.equal(backwardOverlapping(legs, 'B1', 'L8', at(20), at(24)) === leg, true);
  assert.equal(backwardCovering(legs, 'B2', 'L8', at(30)), null, 'another bus is never covered');

  // 2. An ordinary forward trip, however late, is not one.
  const ordinary = trip('B2', [['Roca Blanca', 22, 0], ['Tarragona', 22, 3], ['Pl. Gatassa', 23, 5], ['Parc Cerdanyola', 23, 6], ['Gatassa', 24, 8], ['Institut Català Salut', 24, 10], ['Edif. Vidre - TecnoCampus', 24, 14]]);
  assert.equal(findBackwardLegs(ordinary, { stopIndex }).length, 0);

  // 3. The feed's own jitter (a stop or two out of order) is not one.
  const jitter = trip('B3', [['Tarragona', 20, 0], ['Parc Cerdanyola', 20, 3], ['Pl. Gatassa', 20, 4], ['Gatassa', 20, 6], ['Parc Cerdanyola', 20, 7], ['Institut Català Salut', 21, 9], ['Gatassa', 21, 10], ['Edif. Vidre - TecnoCampus', 21, 13]]);
  assert.equal(findBackwardLegs(jitter, { stopIndex }).length, 0, 'steps back of 1-2 stops are feed jitter');

  // 4. A delay below the floor is never flagged; neither is one that is recomputed on the way back.
  const small = [...trip('B4', forward.map(([s, d, m]) => [s, d - 16, m])), ...trip('B4', back.map(([s, d, m]) => [s, d - 16, m]))];
  assert.equal(findBackwardLegs(small, { stopIndex }).length, 0, 'a +10 delay is below the floor');
  const recomputed = [...trip('B5', forward), ...trip('B5', back.map(([s, d, m], i) => [s, 26 - i * 4, m]))];
  assert.equal(findBackwardLegs(recomputed, { stopIndex }).length, 0, 'a delay that changes on the way back is a real, moving delay');

  // 5. L3 runs out to Caldes d'Estrac and back through the same stops (production, L3 bus 2681, 2 Oct 2026: La Rambla,
  //    Rodalies, Les Hortes, El Rengle, Caldes d'Estrac, TecnoCampus, El Rengle, Les Hortes, Rodalies, La Rambla, ...).
  //    The order looks backwards by the published list, but the bus comes back to where it started: not a leg.
  const loop = [['La Rambla', 0], ['Rodalies', 2], ['Les Hortes', 3], ['El Rengle', 4], ["Caldes d'Estrac", 5], ['TecnoCampus', 6], ['El Rengle', 7],
    ['Les Hortes', 8], ['Rodalies', 9], ['La Rambla', 11], ['TecnoCampus', 12], ['Sant Joan', 13]]
    .flatMap(([s, m]) => visit('B6', 'L3', '0', s, 17, at(m)));
  assert.equal(findBackwardLegs(loop, { stopIndex }).length, 0, 'an out-and-back loop is not an abandoned trip');

  // 6. Missing direction, missing vehicle, no resolver: nothing, and no crash.
  assert.deepEqual(findBackwardLegs(samples.map(s => ({ ...s, direction: '' })), { stopIndex }), []);
  assert.deepEqual(findBackwardLegs(samples.map(s => ({ ...s, vehicleId: '' })), { stopIndex }), []);
  assert.deepEqual(findBackwardLegs(samples, {}), []);
  assert.deepEqual(findBackwardLegs(null, { stopIndex }), []);

  // 7. Two legs by one bus, an hour apart, are two entries.
  const twice = [...samples, ...samples.map(s => ({ ...s, timestamp: s.timestamp + 90 * min }))];
  assert.equal(findBackwardLegs(twice, { stopIndex }).length, 2);

  // ---- through the database ----
  const testDir = path.join(__dirname, '..', 'data', 'test_scratch');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  const testDbPath = process.env.DB_PATH || path.join(testDir, 'test_backward_leg.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  const historyDb = require('../src/historyDb');
  historyDb.init(testDbPath);
  for (const s of [...samples, ...ordinary.map(r => ({ ...r, timestamp: r.timestamp + 5 * min }))]) {
    historyDb.recordDelayLog({
      vehicleId: s.vehicleId, lineId: '8', lineCode: s.lineCode, agency: 'Mataró Bus (Avanza)',
      stopId: s.stopName, stopName: s.stopName, delayMins: s.delayMins, direction: s.direction, isRealTime: true, timestamp: s.timestamp
    });
  }

  const res = historyDb.getDelayIncidents({ lineCode: 'all', hours: 168, limit: 100, minDelay: 5 });
  assert.equal(res.summary.backwardLegs, 1, 'the summary counts the leg');
  const inLeg = r => r.vehicleId === 'B1' && r.timestamp >= leg.staleFromTs && r.timestamp <= leg.staleToTs;
  assert.equal([...res.topIncidents, ...res.investigationIncidents].filter(inLeg).length, 0, 'leg records are kept out of the rankings');
  assert.ok([...res.topIncidents, ...res.investigationIncidents].some(r => r.vehicleId === 'B1'), 'the forward, real delay stays listed');
  const anomaly = res.telemetryAnomalies.find(r => r.anomalyType === 'backward_leg');
  assert.ok(anomaly, 'the leg is listed with the SAE anomalies');
  assert.equal(anomaly.vehicleId, 'B1');
  assert.equal(anomaly.backwardLeg.lowestStop, 'Roca Blanca');
  assert.ok(String(anomaly.diagnosticBadge).includes('sentit invers'));
  assert.equal(res.telemetryAnomalies.filter(r => r.vehicleId === 'B2').length, 0, 'the ordinary bus is not an anomaly');

  const cards = res.incidentTrips.filter(t => t.vehicleId === 'B1');
  assert.equal(cards.length, 1, 'the leg is not a trip of its own');
  assert.equal(cards[0].endReason, 'backward_leg', 'the trajectory ends as a backward leg, not as a recovery');
  assert.equal(cards[0].endStop, 'Ronda Barceló');
  assert.equal(cards[0].stopProgression[cards[0].stopProgression.length - 1].stopName, 'Ronda Barceló');
  assert.ok(cards[0].stopProgression.every(p => !p.isRecovered));
  assert.equal(cards[0].backwardLeg.lowestStop, 'Roca Blanca');
  assert.equal(res.incidentTrips.find(t => t.vehicleId === 'B2').endReason !== 'backward_leg', true);

  // Investigar on a record inside the leg.
  const insp = historyDb.inspectDelayIncident({ lineCode: 'L8', stopName: 'Tarragona', vehicleId: 'B1', at: at(39.5), windowMins: 30, minDelay: 5 });
  assert.equal(insp.found, true);
  assert.equal(insp.episode.verdict, 'backward_leg');
  assert.equal(insp.episode.backwardLeg.lastServedStop, 'Ronda Barceló');
  assert.equal(insp.episode.backwardLeg.visitCount, 9);
  const phantomTrips = insp.episode.run.trips.filter(t => t.isDeadhead);
  assert.equal(phantomTrips.length, 1, 'the leg is one phantom group in the run');
  assert.equal(phantomTrips[0].phantomKind, 'backward');
  assert.equal(insp.episode.run.stops.filter(s => s.phantom).length, 9, 'its nine visits are marked phantom');
  const real = historyDb.inspectDelayIncident({ lineCode: 'L8', stopName: 'Ronda', vehicleId: 'B1', at: at(17.5), windowMins: 20, minDelay: 5 });
  assert.notEqual(real.episode.verdict, 'backward_leg', 'the real forward delay is not called a backward leg');

  // The punctuality figures leave the leg out as well (stop visits and samples).
  const { windows, backs } = historyDb._findPhantomStretches({ since: 0, lineWhereSql: '', lineParams: [] });
  assert.equal(backs.length, 1);
  assert.ok(windows.some(w => w.vehicleId === 'B1' && w.staleFromTs === leg.staleFromTs && w.staleToTs === leg.staleToTs));

  // The wording in the panel.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'observatori.js'), 'utf8');
  for (const needle of ['backward_leg', 'Recorregut en sentit invers', "phantomKind === 'backward'", 'trip.backwardLeg']) {
    assert.ok(src.includes(needle), `observatori.js mentions ${needle}`);
  }

  console.log('✅ BACKWARD LEG TEST PASSED');
  process.exit(0);
} catch (err) {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
}
