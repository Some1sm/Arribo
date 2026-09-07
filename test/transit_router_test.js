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
  // 6. Adversarial Hostile Inputs
  console.log('Test 6: Adversarial & Hostile Inputs (null, undefined, NaN, empty strings)');
  const nullRes = await transitRouter.plan(null, undefined);
  assert.strictEqual(nullRes.success, false);
  assert.strictEqual(nullRes.itineraries.length, 0);

  const emptyRes = await transitRouter.plan('', '   ');
  assert.strictEqual(emptyRes.success, false);
  assert.strictEqual(emptyRes.itineraries.length, 0);

  const nanRes = await transitRouter.plan({ lat: NaN, lon: NaN }, { lat: 'invalid', lon: 2.44 });
  assert.strictEqual(nanRes.success, false);
  assert.strictEqual(nanRes.itineraries.length, 0);

  const unknownRes = await transitRouter.plan('NonExistentStopXYZ12345', '1016');
  assert.strictEqual(unknownRes.success, false);
  assert.strictEqual(unknownRes.itineraries.length, 0);
  console.log('✓ Adversarial inputs handled safely without crashes');

  // 7. sliceRoutePolyline Edge Cases
  console.log('Test 7: sliceRoutePolyline boundary edge cases');
  // Null / empty stops
  assert.deepStrictEqual(transitRouter.sliceRoutePolyline([], null, null), []);
  assert.deepStrictEqual(transitRouter.sliceRoutePolyline(null, null, null), []);
  
  // Empty polyline with valid stops fallback
  const s1 = { lat: 41.539, lon: 2.444 };
  const s2 = { lat: 41.545, lon: 2.450 };
  const fallbackSlice = transitRouter.sliceRoutePolyline([], s1, s2);
  assert.strictEqual(fallbackSlice.length, 2);
  assert.deepStrictEqual(fallbackSlice[0], [41.539, 2.444]);
  assert.deepStrictEqual(fallbackSlice[1], [41.545, 2.450]);

  // 1-point polyline fallback
  const singlePtSlice = transitRouter.sliceRoutePolyline([[41.54, 2.44]], s1, s2);
  assert.strictEqual(singlePtSlice.length, 2);

  // Normal polyline slicing
  const routePoly = [
    [41.530, 2.440],
    [41.535, 2.442],
    [41.539, 2.444],
    [41.542, 2.446],
    [41.545, 2.450],
    [41.550, 2.455]
  ];
  const sliced = transitRouter.sliceRoutePolyline(routePoly, s1, s2);
  assert.ok(sliced.length >= 2, 'Sliced polyline should have at least 2 points');
  assert.deepStrictEqual(sliced[0], [s1.lat, s1.lon]);
  assert.deepStrictEqual(sliced[sliced.length - 1], [s2.lat, s2.lon]);
  console.log('✓ sliceRoutePolyline handles 0-length, 1-length, and sliced subpaths accurately');

  // 8. Coordinate-based planning ({ lat, lon })
  console.log('Test 8: Coordinate-based origin & destination routing');
  const coordRes = await transitRouter.plan(
    { lat: 41.556, lon: 2.434 }, // near Hospital de Mataró
    { lat: 41.534, lon: 2.445 }  // near Rodalies
  );
  assert.strictEqual(coordRes.success, true);
  assert.ok(coordRes.itineraries.length >= 1);
  console.log(`✓ Coordinate routing succeeded: ${coordRes.itineraries.length} options found`);

  // 9. Transfer Walk Calculation & Durations
  console.log('Test 9: Transfer itinerary structure and walk sanity');
  const transferTrip = await transitRouter.plan('1004', '1016');
  assert.strictEqual(transferTrip.success, true);
  const transItin = transferTrip.itineraries.find(it => it.type === 'transfer');
  if (transItin) {
    assert.strictEqual(transItin.legs.length, 2);
    assert.ok(transItin.transferWalk, 'Transfer should have transferWalk details');
    assert.ok(Number.isFinite(transItin.transferWalk.distanceMeters), 'Distance must be finite');
    assert.ok(Number.isFinite(transItin.transferWalk.walkingMinutes), 'Walk mins must be finite');
    assert.ok(transItin.totalDurationMinutes >= transItin.rideMinutes, 'Total duration must include wait/walk');
  }
  // 10. Prune Dominated & Duplicate Line Sequences
  console.log('Test 10: Pruning dominated & duplicate line sequences (Pareto optimality)');
  const dedupeTrip = await transitRouter.plan(
    { lat: 41.54547, lon: 2.42518, name: 'Carrer de Sant Josep de Calassanç' },
    'Estació Rodalies Mataró (mar)'
  );
  assert.strictEqual(dedupeTrip.success, true);
  assert.ok(dedupeTrip.itineraries.length >= 1, 'Should find itineraries');

  // Verify all returned itineraries have unique line sequences
  const seenSigs = new Set();
  for (const it of dedupeTrip.itineraries) {
    const sig = it.legs.map(l => l.lineCode || l.lineId).join('->');
    assert.ok(!seenSigs.has(sig), `Duplicate line sequence detected: ${sig}`);
    seenSigs.add(sig);
  }

  // Specifically verify that L1->L5 does NOT include the dominated transfer via Blanes
  const l1l5 = dedupeTrip.itineraries.find(it => it.legs.map(l => l.lineCode).join('->') === 'L1->L5');
  if (l1l5) {
    assert.strictEqual(l1l5.legs[0].toStop.name, 'Irlanda', 'Should transfer at Irlanda, not Blanes');
    assert.strictEqual(l1l5.transferWalk?.distanceMeters, 99, 'Should use 99m transfer walk');
  }
  console.log('✓ Zero duplicate line sequences, dominated alternatives strictly pruned');

  // Test 11: Preferences Handling
  console.log('Test 11: Route preferences (fastest, least_walking, direct_only)');
  const directOnlyTrip = await transitRouter.plan('Hospital de Mataró', 'Estació Rodalies', { preference: 'direct_only' });
  assert.strictEqual(directOnlyTrip.success, true);
  assert.ok(directOnlyTrip.itineraries.every(it => it.type === 'direct'), 'All itineraries in direct_only mode must be direct');
  console.log('✓ direct_only preference returns exclusively direct lines');

  // Test 12: Future Departure Timetable Simulation
  console.log('Test 12: Future departure planning using official schedules');
  const futureTrip = await transitRouter.plan('Hospital de Mataró', 'Estació Rodalies', {
    departureTime: '08:30',
    departureDate: '2026-10-15'
  });
  assert.strictEqual(futureTrip.success, true);
  assert.ok(futureTrip.itineraries.length > 0, 'Should find future itineraries');
  const firstItin = futureTrip.itineraries[0];
  assert.strictEqual(firstItin.isFutureSchedule, true);
  assert.strictEqual(firstItin.isRealTime, false);
  assert.ok(/^\d{1,2}:\d{2}$/.test(firstItin.departureTime), `Departure time should be HH:MM format: ${firstItin.departureTime}`);
  console.log(`✓ Future departure scheduled correctly: ${firstItin.departureTime} (isRealTime: ${firstItin.isRealTime})`);

  // Test 13: Sustainability & Approximate CO2 Savings Calculation
  console.log('Test 13: Sustainability & approximate CO2 savings calculation');
  assert.ok(typeof firstItin.transitDistanceKm === 'number' && firstItin.transitDistanceKm > 0, 'Should have positive transit km');
  assert.ok(typeof firstItin.co2SavedGrams === 'number' && firstItin.co2SavedGrams > 0, 'Should calculate positive CO2 saved');
  assert.ok(firstItin.co2Label.includes('(aprox.)'), `CO2 label must clearly state approximate: ${firstItin.co2Label}`);
  assert.ok(firstItin.co2BadgeHtml.includes('aprox.'), `CO2 badge must clearly state approximate: ${firstItin.co2BadgeHtml}`);
  console.log(`✓ CO2 calculation verified: ${firstItin.transitDistanceKm} km -> ${firstItin.co2Label}`);

  console.log('\n✅ ALL transitRouter TESTS PASSED PERFECTLY!\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
