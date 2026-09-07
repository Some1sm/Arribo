const assert = require('assert');
const mataroFleet = require('../src/data/mataroFleet');
const intermodalHub = require('../src/core/intermodalHub');

async function runTests() {
  console.log('🧪 Running Intermodal Hub & Eco-Fleet Database Tests...\n');

  // 1. Eco-Fleet Database Tests
  console.log('Test 1: Vehicle 101 (Mercedes Citaro C2 / Scania Euro-6 Diesel)');
  const v101 = mataroFleet.getVehicleFleetInfo('101');
  assert.strictEqual(v101.isElectric, false);
  assert.strictEqual(v101.propulsion, 'diesel');
  assert.strictEqual(v101.isAccessible, true);
  assert.ok(v101.propulsionBadge.includes('Dièsel'));
  console.log('✓ Euro-6 diesel bus metadata matched correctly:', v101.modelName);

  console.log('Test 2: Vehicle 201 (MAN Lion\'s City Hybrid)');
  const v201 = mataroFleet.getVehicleFleetInfo('201');
  assert.strictEqual(v201.isHybrid, true);
  assert.strictEqual(v201.isElectric, false);
  assert.strictEqual(v201.isAccessible, true);
  assert.ok(v201.propulsionBadge.includes('Híbrid'));
  console.log('✓ Hybrid bus metadata matched correctly:', v201.modelName);

  console.log('Test 3: Live 2600-series Hybrid bus (2675 & 75 - Volvo 7900 Hybrid B5LH)');
  const v2675 = mataroFleet.getVehicleFleetInfo('2675');
  assert.strictEqual(v2675.isHybrid, true);
  assert.strictEqual(v2675.propulsion, 'hybrid');
  assert.strictEqual(v2675.modelName, 'Volvo 7900 Hybrid (B5LH)');
  assert.ok(v2675.propulsionBadge.includes('Híbrid'));

  const v75 = mataroFleet.getVehicleFleetInfo('75');
  assert.strictEqual(v75.isHybrid, true);
  assert.strictEqual(v75.propulsion, 'hybrid');
  console.log('✓ 2600-series Volvo 7900 Hybrid bus identified correctly:', v2675.modelName);

  console.log('Test 4: Live 2600-series Euro-6 Diesel bus (2667 & 67 - Scania N320UB Castrosua)');
  const v2667 = mataroFleet.getVehicleFleetInfo('2667');
  assert.strictEqual(v2667.isHybrid, false);
  assert.strictEqual(v2667.propulsion, 'diesel');
  assert.strictEqual(v2667.modelName, 'Scania N320UB Castrosua');
  assert.ok(v2667.propulsionBadge.includes('Euro 6'));

  const v67 = mataroFleet.getVehicleFleetInfo('67');
  assert.strictEqual(v67.isHybrid, false);
  assert.strictEqual(v67.propulsion, 'diesel');
  console.log('✓ 2600-series Euro-6 diesel bus identified correctly:', v2667.modelName);

  console.log('Test 5: Live 2600-series Euro-6 Citaro (2653 & 53)');
  const v2653 = mataroFleet.getVehicleFleetInfo('2653');
  assert.strictEqual(v2653.isHybrid, false);
  assert.strictEqual(v2653.propulsion, 'diesel');
  assert.ok(v2653.propulsionBadge.includes('Euro 6'));
  console.log('✓ 2600-series Mercedes Citaro C2 / Scania identified correctly:', v2653.modelName);

  console.log('Test 6: Unknown vehicle number fallback (conventional diesel)');
  const unknownV = mataroFleet.getVehicleFleetInfo('9999');
  assert.strictEqual(unknownV.isAccessible, true);
  assert.strictEqual(unknownV.propulsion, 'diesel');
  assert.strictEqual(unknownV.isHybrid, false);
  assert.strictEqual(unknownV.isElectric, false);
  console.log('✓ Unknown bus gracefully fell back to conventional diesel defaults');

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
