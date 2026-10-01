'use strict';

/**
 * test/mataro_fleet_test.js
 *
 * The fleet chips state only sourced facts (src/data/mataroFleet.js): the 20
 * hybrids 2668-2687 are Volvo 7900 Hybrid, Euro VI; every bus is accessible.
 * Nothing is stated about the other buses' make or propulsion, nor about air
 * conditioning, and invented series (101, 201, two-digit numbers) are unknown.
 */

const assert = require('assert');
const mataroFleet = require('../src/data/mataroFleet');

console.log('Running fleet database tests...\n');

const hybrid = mataroFleet.getVehicleFleetInfo('2675');
assert.strictEqual(hybrid.isHybrid, true);
assert.strictEqual(hybrid.propulsion, 'hybrid');
assert.strictEqual(hybrid.modelName, 'Volvo 7900 Hybrid');
assert.strictEqual(hybrid.emissionStandard, 'Euro VI');
assert.strictEqual(hybrid.propulsionBadge, '🌱 Híbrid Eco');
assert.strictEqual(hybrid.isAccessible, true);
assert.strictEqual(hybrid.isElectric, false);
for (const id of ['2668', '2687', '#2683']) assert.strictEqual(mataroFleet.getVehicleFleetInfo(id).isHybrid, true, `${id} is a hybrid`);
assert.strictEqual(mataroFleet.HYBRID_VEHICLE_IDS.size, 20, 'the operator reports 20 hybrids');
console.log('✓ 2668-2687: Volvo 7900 Hybrid, Euro VI, accessible');

for (const id of ['2653', '2667', '2688', '101', '201', '75', '9999']) {
  const v = mataroFleet.getVehicleFleetInfo(id);
  assert.strictEqual(v.isHybrid, false, `${id} is not a known hybrid`);
  assert.strictEqual(v.propulsion, null, `${id}: propulsion not stated`);
  assert.strictEqual(v.modelName, null, `${id}: model not stated`);
  assert.strictEqual(v.propulsionBadge, null, `${id}: no badge`);
  assert.strictEqual(v.emissionStandard, null, `${id}: no emission standard`);
  assert.strictEqual(v.hasAirConditioning, null, `${id}: air conditioning not stated`);
  assert.strictEqual(v.isAccessible, true, `${id}: every bus has a ramp`);
}
console.log('✓ other buses: no make, model, propulsion or air conditioning stated');

console.log('\nAll fleet database tests passed.\n');
