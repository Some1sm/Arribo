require('./helpers/fixed_clock.cjs').install('2026-09-26T20:30:00Z');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

try {
  // 1. Setup isolated test database
  const testDir = path.join(__dirname, '..', 'data', 'test_scratch');
  if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
  const testDbPath = process.env.DB_PATH || path.join(testDir, 'test_incident_trajectory.db');
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  const historyDb = require('../src/historyDb');
  historyDb.init(testDbPath);

  function add(vehicleId, lineCode, direction, stopName, delayMins, ts) {
    historyDb.recordDelayLog({
      vehicleId,
      lineId: lineCode.slice(1),
      lineCode,
      agency: 'Mataró Bus (Avanza)',
      stopId: stopName,
      stopName,
      delayMins,
      direction,
      isRealTime: true,
      timestamp: ts
    });
  }

  // Fixture: vehicle '2684', line 'L1'
  let t = Date.parse('2026-09-26T16:53:00Z');

  const dir1Stops = [
    ['Roca Blanca', 6],
    ['Escola El Turó', 5],
    ['Euskadi', 3],
    ['Irlanda', 5],
    ['Blanes', 6],
    ['Cementiri Les Valls', 7],
    ['Hospital de Mataró', 6]
  ];

  for (const [stopName, delayMins] of dir1Stops) {
    for (let s = 0; s < 3; s++) {
      add('2684', 'L1', '1', stopName, delayMins, t);
      t += 60 * 1000;
    }
  }

  const dir0Stops = [
    ['Cirera', 7],
    ['CAP Cirera-Molins', 7],
    ['Sant Oleguer', 7],
    ['Caputxins', 7],
    ['Perú', 7],
    ['Pau Picasso', 7],
    ['Escola Freta', 7],
    ['Cabanellas', 7],
    ['Parc Central', 7],
    ['Caminet', 7],
    ['Rodalies', 3]
  ];

  for (const [stopName, delayMins] of dir0Stops) {
    for (let s = 0; s < 3; s++) {
      add('2684', 'L1', '0', stopName, delayMins, t);
      t += 90 * 1000;
    }
  }

  add('2684', 'L1', '1', 'Ronda Barceló', 2, t);

  // Truncation fixture
  let oldT = Date.parse('2026-09-21T08:00:00Z');
  for (let i = 0; i < 3100; i++) {
    add('OLD1', 'L1', '1', 'Rodalies', 6, oldT);
    oldT += 20 * 1000;
  }

  let l3T = Date.parse('2026-09-26T19:00:00Z');
  const l3Stops = [
    ['Vista Alegre', 20],
    ['Rocafonda', 20],
    ['Camí de la Serra', 20]
  ];
  for (const [stopName, delayMins] of l3Stops) {
    for (let s = 0; s < 3; s++) {
      add('L3BUS', 'L3', '0', stopName, delayMins, l3T);
      l3T += 60 * 1000;
    }
  }

  const res = historyDb.getDelayIncidents({ lineCode: 'all', hours: 168, limit: 100, minDelay: 5 });

  assert.ok(res.incidentTrips.some(t => t.lineCode === 'L3'), 'recent L3 card must not be truncated away');
  assert.equal(res.summary.trajectorySamplesTruncated, false);

  const cards2684 = res.incidentTrips.filter(trip => trip.vehicleId === '2684');
  assert.equal(cards2684.length, 2, `Expected exactly 2 cards for vehicle '2684', got ${cards2684.length}`);

  const cardDir1 = cards2684.find(trip => trip.direction === '1');
  assert.ok(cardDir1, 'direction 1 card found');
  const expectedDir1Stops = ['Roca Blanca', 'Escola El Turó', 'Euskadi', 'Irlanda', 'Blanes', 'Cementiri Les Valls', 'Hospital de Mataró'];
  assert.deepEqual(cardDir1.stopProgression.map(p => p.stopName), expectedDir1Stops);
  const euskadi = cardDir1.stopProgression.find(p => p.stopName === 'Euskadi');
  assert.ok(euskadi, 'Euskadi stop present');
  assert.equal(euskadi.belowThreshold, true);
  assert.equal(cardDir1.endReason, 'end_of_line');

  const cardDir0 = cards2684.find(trip => trip.direction === '0');
  assert.ok(cardDir0, 'direction 0 card found');
  const expectedDir0Stops = ['Cirera', 'CAP Cirera-Molins', 'Sant Oleguer', 'Caputxins', 'Perú', 'Pau Picasso', 'Escola Freta', 'Cabanellas', 'Parc Central', 'Caminet', 'Rodalies'];
  assert.deepEqual(cardDir0.stopProgression.map(p => p.stopName), expectedDir0Stops);
  const lastEntry = cardDir0.stopProgression[cardDir0.stopProgression.length - 1];
  assert.equal(lastEntry.isRecovered, true);
  assert.equal(cardDir0.endReason, 'recovered');
  assert.equal(cardDir0.stopProgression.length, cardDir0.stopsTraversed.length);

  console.log('✅ INCIDENT TRAJECTORY TEST PASSED');
  process.exit(0);
} catch (err) {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
}
