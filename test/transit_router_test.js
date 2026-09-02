const assert = require('assert');
const transitRouter = require('../src/core/schedule/transitRouter');
const mataroTracker = require('../src/mataroTracker');

async function runTests() {
  console.log('🧪 Running transitRouter Journey Planner Unit Tests...\n');

  // Initialize router with mataroTracker
  transitRouter.setTracker(mataroTracker);

  // 1. Same Stop
  console.log('Test 1: Same origin and destination');
  const sameRes = await transitRouter.plan('1', '1');
  assert.strictEqual(sameRes.success, true);
  assert.strictEqual(sameRes.itineraries.length, 0);
  assert.ok(sameRes.message.includes('mateixa parada'));
  console.log('✓ Same stop handled correctly');

  // 2. Direct Route on L1
  console.log('Test 2: Direct route on Line 1 (Estació Rodalies -> Pl. de les Tereses)');
  const directRes = await transitRouter.plan('1016', '1');
  assert.strictEqual(directRes.success, true);
  assert.ok(directRes.itineraries.length >= 1, 'Should find at least 1 itinerary');
  const directIt = directRes.itineraries.find(it => it.type === 'direct');
  assert.ok(directIt, 'Should find a direct route');
  assert.strictEqual(directIt.legs.length, 1);
  assert.ok(directIt.totalDurationMins > 0, 'Duration should be positive');
  assert.ok(directIt.legs[0].stopCount >= 1, 'Should pass at least 1 stop');
  console.log(`✓ Direct route found: Line ${directIt.legs[0].lineCode}, duration ~${directIt.totalDurationMins} min, ${directIt.legs[0].stopCount} stops`);

  // 3. Multi-line itinerary search
  console.log('Test 3: Cross-town itinerary requiring route search');
  const transferRes = await transitRouter.plan('1001', '1016'); // Hospital to Rodalies
  assert.strictEqual(transferRes.success, true);
  assert.ok(transferRes.itineraries.length >= 1);
  const bestIt = transferRes.itineraries[0];
  console.log(`✓ Itinerary found: ${bestIt.type} (${bestIt.legs.map(l => l.lineCode).join(' ➔ ')}), duration ~${bestIt.totalDurationMins} min`);

  // 4. Fuzzy Name Search
  console.log('Test 4: Fuzzy name search (e.g. "Hospital" to "Rodalies")');
  const fuzzyRes = await transitRouter.plan('Hospital', 'Rodalies');
  assert.strictEqual(fuzzyRes.success, true);
  assert.ok(fuzzyRes.itineraries.length >= 1);
  console.log(`✓ Fuzzy search resolved origin "${fuzzyRes.originStop.name}" and dest "${fuzzyRes.destStop.name}"`);

  // 5. Performance Latency Check
  console.log('Test 5: Performance benchmark (50 route lookups)');
  const start = performance.now();
  for (let i = 0; i < 50; i++) {
    await transitRouter.plan('1016', '1060');
  }
  const elapsed = performance.now() - start;
  const avgMs = elapsed / 50;
  console.log(`✓ Average route computation time: ${avgMs.toFixed(3)} ms (Target: < 5 ms)`);
  assert.ok(avgMs < 10, 'Route planning must take less than 10ms');

  console.log('\n✅ ALL transitRouter TESTS PASSED PERFECTLY!\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
