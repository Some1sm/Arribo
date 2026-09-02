const assert = require('assert');
const mataroFleet = require('../src/data/mataroFleet');
const intermodalHub = require('../src/core/intermodalHub');

async function runTests() {
  console.log('🧪 Running Intermodal Hub & Eco-Fleet Database Tests...\n');

  // 1. Eco-Fleet Database Tests
  console.log('Test 1: Vehicle 101 (Solaris Urbino Electric)');
  const v101 = mataroFleet.getVehicleFleetInfo('101');
  assert.strictEqual(v101.isElectric, true);
  assert.strictEqual(v101.propulsion, 'electric');
  assert.strictEqual(v101.isAccessible, true);
  assert.ok(v101.propulsionBadge.includes('Elèctric'));
  console.log('✓ Electric bus metadata matched correctly:', v101.modelName);

  console.log('Test 2: Vehicle 201 (Iveco Urbanway Hybrid)');
  const v201 = mataroFleet.getVehicleFleetInfo('201');
  assert.strictEqual(v201.isHybrid, true);
  assert.strictEqual(v201.isElectric, false);
  assert.strictEqual(v201.isAccessible, true);
  assert.ok(v201.propulsionBadge.includes('Híbrid'));
  console.log('✓ Hybrid bus metadata matched correctly:', v201.modelName);

  console.log('Test 3: Unknown vehicle number fallback');
  const unknownV = mataroFleet.getVehicleFleetInfo('9999');
  assert.strictEqual(unknownV.isAccessible, true);
  assert.strictEqual(unknownV.propulsion, 'diesel');
  console.log('✓ Unknown bus gracefully fell back to standard diesel Euro-6 defaults');

  // 2. Intermodal Hub Matching
  console.log('Test 4: Hub matching for Rodalies Mataró (stop 1016)');
  const hubRodalies = intermodalHub.matchHub('1016');
  assert.ok(hubRodalies, 'Should match Estació Rodalies hub');
  assert.strictEqual(hubRodalies.id, 'rodalies');
  console.log('✓ Rodalies hub matched:', hubRodalies.name);

  console.log('Test 5: Hub matching for Pl. de les Tereses (stop 1060)');
  const hubTereses = intermodalHub.matchHub('1060');
  assert.ok(hubTereses, 'Should match Pl. de les Tereses hub');
  assert.strictEqual(hubTereses.id, 'tereses');
  console.log('✓ Pl. Tereses hub matched:', hubTereses.name);

  console.log('Test 6: Non-hub stop returns null');
  const nonHub = intermodalHub.matchHub('999999');
  assert.strictEqual(nonHub, null);
  console.log('✓ Non-hub stop returned null correctly');

  // 3. Multimodal Connections Query
  console.log('Test 7: Fetch real-time multimodal connections for Estació Rodalies');
  const connRodalies = await intermodalHub.getConnectionsForStop('1016');
  assert.strictEqual(connRodalies.isHub, true);
  assert.ok(Array.isArray(connRodalies.connections));
  console.log(`✓ Fetched ${connRodalies.connections.length} intermodal departures at Estació Rodalies`);

  console.log('\n✅ ALL INTERMODAL & FLEET TESTS PASSED PERFECTLY!\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
