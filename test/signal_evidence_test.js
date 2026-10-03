require('./helpers/fixed_clock.cjs').install('2026-10-03T08:00:00Z');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// "No records for the first stops" is not proof of a short-turn. The panel and the
// edge-case table must say what the GPS silences and stored positions show, and say
// "unknown" when they show nothing. Production case: L1 bus 2684, 26 Sep 2026
// (relink at Parc Central +12 -> 0 after a 7-minute silence), and L2 bus 2684, 2 Oct
// (+28 at Cirera, nine minutes with no record, then on time mid-route on the next trip).
try {
  const testDir = path.join(__dirname, '..', 'data', 'test_scratch');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  const testDbPath = process.env.DB_PATH || path.join(testDir, 'test_signal_evidence.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  const historyDb = require('../src/historyDb');
  historyDb.init(testDbPath);

  const min = 60 * 1000;
  // 2 Oct 2026 17:00 Madrid (CEST) = 15:00Z.
  const T0 = Date.parse('2026-10-02T15:00:00Z');
  const add = (vehicleId, direction, stopName, delayMins, ts) => historyDb.recordDelayLog({
    vehicleId, lineId: '2', lineCode: 'L2', agency: 'Mataró Bus (Avanza)', stopId: stopName, stopName,
    delayMins, direction, isRealTime: true, timestamp: ts
  });
  const visit = (v, dir, stop, delay, ts) => { add(v, dir, stop, delay, ts); add(v, dir, stop, delay, ts + 20000); };
  const gap = (vehicleId, lostTs, regainedTs, flags = {}) => historyDb.recordGpsGap({
    vehicleId, lineCode: 'L2', direction: '1', lostTs, regainedTs, gapSec: Math.round((regainedTs - lostTs) / 1000),
    lostLat: 41.54, lostLon: 2.44, regainedLat: 41.55, regainedLon: 2.45, stopName: 'Cirera',
    atTerminal: Boolean(flags.atTerminal), feedWide: Boolean(flags.feedWide)
  });
  const snap = (vehicleId, ts, isRealTime = true) => historyDb.recordVehicleSnapshot({ vehicleId, lineId: '2', lineCode: 'L2', lat: 41.54, lon: 2.44, delayMins: 27, isRealTime, timestamp: ts });

  const DIR1 = [['Lepant', 27], ['Sant Isidor', 27], ['Parc Central', 26], ['Cabanellas', 26], ['Escola Freta', 26], ['Pau Picasso', 26], ['Perú', 26],
    ['Escola Vista Alegre', 27], ['Sant Oleguer', 27], ['Cirera', 28]];
  // Ten delayed stops, then nine minutes with no record. Returns the time of the last Cirera sample.
  const delayedTrip = (v) => { let ts = T0; for (const [s, d] of DIR1) { visit(v, '1', s, d, ts); ts += 3 * min; } return ts - 3 * min + 20000; };

  // A. Joined mid-route on the opposite direction (the 15th stop), five different silences.
  const buses = {};
  for (const [id, name] of [['S1', 'lost'], ['S2', 'kept'], ['S3', 'unknown'], ['S4', 'feed_stalled'], ['S5', 'terminal']]) {
    const lastTs = delayedTrip(id);
    buses[name] = { id, lastTs };
    visit(id, '0', 'Edif. Vidre - TecnoCampus', 0, lastTs + 9 * min);
    visit(id, '0', 'Sant Valentí', 0, lastTs + 10.5 * min);
    visit(id, '0', 'President Macià', 0, lastTs + 12 * min);
  }
  gap('S1', buses.lost.lastTs + 1 * min, buses.lost.lastTs + 8 * min);
  for (const m of [2, 4, 6]) snap('S2', buses.kept.lastTs + m * min);
  gap('S4', buses.feed_stalled.lastTs + 1 * min, buses.feed_stalled.lastTs + 8 * min, { feedWide: true });
  gap('S5', buses.terminal.lastTs + 1 * min, buses.terminal.lastTs + 8 * min, { atTerminal: true });
  // Estimated (dead-reckoned) positions are not GPS: S3 has two of them and still counts as unknown.
  snap('S3', buses.unknown.lastTs + 2 * min, false);
  snap('S3', buses.unknown.lastTs + 4 * min, false);

  const evidenceOf = (id, lastTs) => {
    const insp = historyDb.inspectDelayIncident({ lineCode: 'L2', stopName: 'Cirera', vehicleId: id, at: lastTs - 10000, windowMins: 30, minDelay: 5 });
    assert.equal(insp.found, true, `${id}: Investigar finds the episode`);
    const trip = insp.episode.run.trips.find(t => t.joinedMidRoute);
    assert.ok(trip, `${id}: the next trip is flagged as joined mid-route`);
    return trip;
  };
  const trips = {};
  for (const [name, b] of Object.entries(buses)) trips[name] = evidenceOf(b.id, b.lastTs);

  for (const [name, expected] of [['lost', 'lost'], ['kept', 'kept'], ['unknown', 'unknown'], ['feed_stalled', 'feed_stalled'], ['terminal', 'terminal']]) {
    const ev = trips[name].joinedMidRoute.evidence;
    assert.ok(ev, `${name}: the join carries evidence`);
    assert.equal(ev.signal, expected, `${name}: signal`);
    assert.ok(ev.toTs > ev.fromTs, `${name}: the window runs from the last record of the previous trip to the first of the next`);
  }
  assert.equal(trips.lost.joinedMidRoute.evidence.gaps.length, 1);
  assert.equal(trips.lost.joinedMidRoute.evidence.gaps[0].gapSec, 420);
  assert.equal(trips.kept.joinedMidRoute.evidence.snapshots, 3);
  assert.equal(trips.unknown.joinedMidRoute.evidence.snapshots, 0, 'estimated positions are not counted');
  assert.equal(trips.feed_stalled.joinedMidRoute.evidence.gaps[0].feedWide, true);
  assert.equal(trips.terminal.joinedMidRoute.evidence.gaps[0].atTerminal, true);
  // A silence that does not overlap the window is not evidence either.
  assert.equal(historyDb._signalEvidence('S1', buses.lost.lastTs + 30 * min, buses.lost.lastTs + 40 * min).signal, 'unknown');
  assert.equal(historyDb._signalEvidence('', 1, 2).signal, 'unknown');
  assert.equal(historyDb._signalEvidence('S1', 5, 1).signal, 'unknown');
  assert.equal(historyDb._signalEvidence('S1', undefined, undefined).signal, 'unknown');

  // B. The panel's wording, from the real source.
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'observatori.js'), 'utf8');
  const from = src.indexOf('  /** HH:MM (Madrid) of an epoch-ms timestamp');
  const to = src.indexOf('  /** Plain-Catalan label for the server-side times_provenance');
  assert.ok(from > 0 && to > from, 'the helpers are in observatori.js');
  const edgeFrom = src.indexOf('  /** "02/10 18:23" (Madrid)');
  const edgeTo = src.indexOf('  /** Copy the edge-case table as tab-separated text. */');
  assert.ok(edgeFrom > 0 && edgeTo > edgeFrom, 'the edge-case helpers are in observatori.js');
  const Ui = new Function('return class { esc(s) { return String(s); } ' + src.slice(from, to) + src.slice(edgeFrom, edgeTo) + ' }')();
  const ui = new Ui();
  const note = name => ui._shortTurnNote(trips[name], 'Edif. Vidre - TecnoCampus');
  const lostNote = note('lost');
  assert.ok(lostNote.includes('Per què el retard desapareix després?'));
  assert.ok(lostNote.includes('El bus va perdre el senyal GPS entre les ') && lostNote.includes('(420 s, a prop de Cirera)'), lostNote);
  assert.ok(lostNote.includes('tornés a assignar') && lostNote.includes('No es pot saber si el retard es va recuperar'), lostNote);
  const keptNote = note('kept');
  assert.ok(keptNote.includes('va continuar enviant posicions GPS') && keptNote.includes('(3 guardades)') && keptNote.includes('no és un tall de senyal'), keptNote);
  assert.ok(keptNote.includes('no es pot distingir'), 'kept still does not claim a short-turn');
  const unknownNote = note('unknown');
  assert.ok(unknownNote.includes('No hi ha dades de senyal') && unknownNote.includes('no es pot saber'), unknownNote);
  assert.ok(note('feed_stalled').includes("l'operador va deixar d'enviar dades"));
  assert.ok(note('terminal').includes('aturat a la capçalera'));
  for (const name of Object.keys(trips)) {
    const n = note(name);
    assert.equal(/undefined|NaN|\bnull\b/.test(n), false, `${name}: no placeholder text`);
    assert.equal(n.includes('es va saltar part del trajecte'), false, `${name}: the unproven short-turn claim is gone`);
    assert.ok(n.includes('Edif. Vidre - TecnoCampus') && n.includes('no tenen cap registre'), `${name}: states the fact (the first stops have no records)`);
  }
  // A join the server gave no evidence for (an older cached payload) still renders, as unknown.
  const legacy = ui._shortTurnNote({ towards: 'Hospital de Mataró', joinedMidRoute: { skippedCount: 3, firstSkipped: 'A', lastSkipped: 'B' } }, 'C');
  assert.ok(legacy.includes('No hi ha dades de senyal'));

  // C. The edge-case table says the same, per case (same-direction trip change).
  const changeBus = (id) => { const lastTs = delayedTrip(id); visit(id, '1', 'Parc Central', 0, lastTs + 9 * min); visit(id, '1', 'Cabanellas', 0, lastTs + 10 * min); return lastTs; };
  const e1 = changeBus('E1'); gap('E1', e1 + 1 * min, e1 + 8 * min);
  const e2 = changeBus('E2'); for (const m of [2, 4, 6]) snap('E2', e2 + m * min);
  changeBus('E3');
  const res = historyDb.getDelayIncidents({ lineCode: 'all', hours: 240, limit: 100, minDelay: 5 });
  const caseOf = id => res.edgeCases.find(c => c.vehicleId === id && c.kind === 'trip_change');
  assert.equal(caseOf('E1').signal, 'lost'); assert.equal(caseOf('E1').signalGapSec, 420);
  assert.equal(caseOf('E2').signal, 'kept'); assert.equal(caseOf('E2').signalGapSec, 0);
  assert.equal(caseOf('E3').signal, 'unknown');
  assert.ok(res.edgeCases.every(c => ['lost', 'feed_stalled', 'terminal', 'kept', 'unknown'].includes(c.signal)), 'every case has a signal');
  assert.ok(res.edgeCases.every(c => Number.isFinite(c.sigFromTs) && Number.isFinite(c.sigToTs)), 'every case has its silent window');
  assert.equal(ui._edgeCaseSignal(caseOf('E1')), 'va perdre el GPS (420 s)');
  assert.equal(ui._edgeCaseSignal(caseOf('E2')), 'va seguir amb GPS');
  assert.equal(ui._edgeCaseSignal(caseOf('E3')), 'sense dades');
  const table = ui._renderEdgeCaseTable(res);
  assert.ok(table.includes('<th scope="col">Senyal</th>') && table.includes('edge-signal-lost') && table.includes('edge-signal-kept'));
  assert.equal(table.includes('style="'), false);

  console.log('✅ SIGNAL EVIDENCE TEST PASSED');
  process.exit(0);
} catch (err) {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
}
