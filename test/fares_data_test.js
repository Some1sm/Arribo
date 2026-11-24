'use strict';

/**
 * test/fares_data_test.js
 *
 * Invariants of src/data/fares.json, the table behind the planner's
 * "preu orientatiu" (app/fares.go).
 */

const assert = require('node:assert/strict');
const fares = require('../src/data/fares.json');

assert.match(fares.validFrom, /^\d{4}-\d{2}-\d{2}$/);
assert.equal(fares.currency, 'EUR');
assert.ok(fares.sources.length >= 3, 'source lines present');

const monotonic = (a) => a.every((v, i) => i === 0 || v > a[i - 1]);
for (const k of ['single', 'tCasual', 'tUsual']) {
  assert.equal(fares.atm[k].length, 7, `${k} has 7 zones`);
  assert.ok(monotonic(fares.atm[k]), `${k} grows with the zones`);
}
assert.ok(monotonic(fares.atm.transfer.windowSeconds), 'transfer window grows with the zones');
assert.equal(fares.atm.transfer.windowSeconds[0], 4500);
assert.equal(fares.atm.single[0], 2.9);
assert.equal(fares.atm.tCasual[2], 34.7);
assert.equal(fares.atm.tUsual[2], 42.7);
assert.equal(fares.atm.tJove, 45.5);
for (let i = 0; i < 7; i++) {
  assert.ok(fares.atm.tCasual[i] / fares.atm.tCasualTrips < fares.atm.single[i], `T-casual trip is cheaper than a single, zone ${i + 1}`);
}
assert.equal(fares.mataroBus.single, 1.7);
assert.equal(fares.mataroBus.t10, 4.85);
assert.equal(fares.mataroBus.sector, '3E');
assert.equal(fares.mataroBus.zone, 3);

for (const [from, row] of Object.entries(fares.sectorZones)) {
  assert.equal(row[from], 1, `${from} to itself is 1 zone`);
  for (const n of Object.values(row)) assert.ok(Number.isInteger(n) && n >= 1 && n <= 7);
}
for (const [name, sector] of Object.entries(fares.stations)) {
  assert.equal(name, name.toLowerCase(), `${name} is folded`);
  assert.ok(!/[^a-z0-9 ]/.test(name), `${name} has no accents or punctuation`);
  assert.ok(sector in fares.sectorZones['3E'], `${name}: sector ${sector} has a known zone count from Mataró`);
}
console.log('  ✓ fares.json invariants');
