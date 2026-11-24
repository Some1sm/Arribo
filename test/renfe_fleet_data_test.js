'use strict';

/**
 * test/renfe_fleet_data_test.js
 *
 * Invariants of src/data/renfe_fleet.json (research report 02 section 4).
 * Figures are unverified: the file must say so and never turn "unknown" into 0.
 */

const assert = require('node:assert/strict');
const fleet = require('../src/data/renfe_fleet.json');

assert.match(fleet.asOf, /^\d{4}-\d{2}-\d{2}$/);
assert.ok(Array.isArray(fleet.series) && fleet.series.length >= 10);

const seen = new Set();
const STATUS = new Set(['in_service', 'planned']);
for (const s of fleet.series) {
  assert.equal(typeof s.series, 'string', 'series name');
  assert.ok(!seen.has(s.series), `duplicate series ${s.series}`);
  seen.add(s.series);
  assert.ok(STATUS.has(s.status), `${s.series} status`);
  assert.ok(s.confidence, `${s.series} carries a confidence`);
  assert.ok(s.manufacturer && s.years, `${s.series} manufacturer and years`);
  assert.ok(Array.isArray(s.usual_lines), `${s.series} usual_lines`);
  for (const l of s.usual_lines) assert.match(l, /^(R\d+[NS]?|RG1|RL\d|RT\d)$/, `${s.series} line ${l}`);
  for (const k of ['cars', 'length_m', 'seats', 'places', 'max_speed_kmh']) {
    assert.ok(k in s, `${s.series} has ${k} (null when unknown)`);
    assert.notEqual(s[k], 0, `${s.series} ${k} must not be 0`);
  }
  if (typeof s.max_speed_kmh === 'number') assert.ok(s.max_speed_kmh >= 100 && s.max_speed_kmh <= 300);
}

const by = (n) => fleet.series.find((s) => s.series === n);
for (const n of ['447', '450', '451', '448', '449', '470', '452']) assert.ok(by(n), `series ${n}`);
assert.ok(by('463/464/465 (Civia)').aliases.includes('464'));
assert.equal(by('463/464/465 (Civia)').step_free, true);

// The 470 correction: still in service on R15 and R17 (seen 2026-11-24).
assert.equal(by('470').status, 'in_service');
assert.ok(by('470').usual_lines.includes('R15') && by('470').usual_lines.includes('R17'));
assert.match(by('470').correction, /R15 and R17/);
// The 452 is not yet in passenger service.
assert.equal(by('452').status, 'planned');
console.log('renfe_fleet data: ok');
