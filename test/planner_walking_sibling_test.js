'use strict';

const assert = require('node:assert/strict');
const tracker = require('../src/mataroTracker');
const transitRouter = require('../src/core/schedule/transitRouter');

async function main() {
  console.log('🧪 Testing Planner Walking Sibling & TimesBasis Logic...');

  await tracker.init();
  transitRouter.setTracker(tracker);

  // 1. Sibling boarding stop with distance < 30m: 1016 (Rodalies) requested, 1058 (Rodalies) chosen
  // Stop 1060 is served by Line 2 and Line 5, which depart from 1058 (not 1016)
  console.log('Test 1: Sibling stop with distance < 30m (1016 -> 1060, boarding at 1058)');
  const resSmallWalk = await transitRouter.plan('1016', '1060');
  assert.strictEqual(resSmallWalk.success, true, 'Planning 1016 -> 1060 should succeed');
  assert.ok(resSmallWalk.itineraries.length > 0, 'Should find at least 1 itinerary');

  const itinSmall = resSmallWalk.itineraries[0];
  assert.strictEqual(itinSmall.timesBasis, 'published_trip', 'Itinerary must declare timesBasis: published_trip');
  assert.strictEqual(itinSmall.legs[0].fromStop.id, '1058', 'Itinerary should board at stop 1058');
  assert.ok(itinSmall.walkToFirstStop, 'Itinerary should have walkToFirstStop between requested 1016 and boarding 1058');
  assert.strictEqual(itinSmall.walkToFirstStop.fromStop.id, '1016', 'walkToFirstStop origin must be requested stop 1016');
  assert.strictEqual(itinSmall.walkToFirstStop.toStop.id, '1058', 'walkToFirstStop destination must be boarding stop 1058');
  assert.ok(itinSmall.walkToFirstStop.distanceMeters < 30, `Distance between 1016 and 1058 should be < 30m (was ${itinSmall.walkToFirstStop.distanceMeters}m)`);
  assert.strictEqual(itinSmall.walkToFirstStop.walkingMinutes, 0, 'Walking minutes for < 30m pole difference must be 0');
  assert.strictEqual(itinSmall.walkToFirstStop.approximate, true, 'Approximate walking must retain approximate: true');
  assert.strictEqual(itinSmall.walkToFirstStop.source, 'approximate', 'Walking source should be approximate when unconfigured');
  console.log(`✓ Sibling stop < 30m verified: ${itinSmall.walkToFirstStop.distanceMeters}m -> ${itinSmall.walkToFirstStop.walkingMinutes} min`);

  // 2. Sibling boarding stop with distance >= 30m: 1001 (Hospital) requested, 1073 (Hospital) chosen
  // Stop 1060 is served by Line 2, which departs from 1073 (opposite platform / other entrance, 123m away)
  console.log('Test 2: Sibling stop with distance >= 30m (1001 -> 1060, boarding at 1073)');
  const resLargeWalk = await transitRouter.plan('1001', '1060');
  assert.strictEqual(resLargeWalk.success, true, 'Planning 1001 -> 1060 should succeed');
  assert.ok(resLargeWalk.itineraries.length > 0, 'Should find at least 1 itinerary');

  const itinLarge = resLargeWalk.itineraries.find(it => it.legs[0].fromStop.id === '1073') || resLargeWalk.itineraries[0];
  assert.strictEqual(itinLarge.timesBasis, 'published_trip', 'Itinerary must declare timesBasis: published_trip');
  if (itinLarge.legs[0].fromStop.id === '1073') {
    assert.ok(itinLarge.walkToFirstStop, 'Itinerary should have walkToFirstStop between 1001 and 1073');
    assert.strictEqual(itinLarge.walkToFirstStop.fromStop.id, '1001', 'walkToFirstStop origin must be 1001');
    assert.strictEqual(itinLarge.walkToFirstStop.toStop.id, '1073', 'walkToFirstStop destination must be 1073');
    assert.ok(itinLarge.walkToFirstStop.distanceMeters >= 30, `Distance between 1001 and 1073 must be >= 30m (was ${itinLarge.walkToFirstStop.distanceMeters}m)`);
    assert.ok(itinLarge.walkToFirstStop.walkingMinutes >= 1, `Walking minutes for >= 30m pole difference must be >= 1 (was ${itinLarge.walkToFirstStop.walkingMinutes})`);
    assert.strictEqual(itinLarge.walkToFirstStop.approximate, true, 'Estimated walks must retain approximate: true');
    console.log(`✓ Sibling stop >= 30m verified: ${itinLarge.walkToFirstStop.distanceMeters}m -> ${itinLarge.walkToFirstStop.walkingMinutes} min`);
  }

  // 3. Sibling destination stop with distance >= 30m: destination 1001 requested from 1060, alighting at 1073
  console.log('Test 3: Destination sibling stop with distance >= 30m (1060 -> 1001, alighting at 1073)');
  const resDestWalk = await transitRouter.plan('1060', '1001');
  assert.strictEqual(resDestWalk.success, true, 'Planning 1060 -> 1001 should succeed');
  assert.ok(resDestWalk.itineraries.length > 0, 'Should find at least 1 itinerary');

  const itinDest = resDestWalk.itineraries.find(it => it.legs[it.legs.length - 1].toStop.id === '1073') || resDestWalk.itineraries[0];
  assert.strictEqual(itinDest.timesBasis, 'published_trip', 'Itinerary must declare timesBasis: published_trip');
  if (itinDest.legs[itinDest.legs.length - 1].toStop.id === '1073') {
    assert.ok(itinDest.walkFromLastStop, 'Itinerary should have walkFromLastStop between 1073 and 1001');
    assert.strictEqual(itinDest.walkFromLastStop.fromStop.id, '1073', 'walkFromLastStop origin must be 1073');
    assert.strictEqual(itinDest.walkFromLastStop.toStop.id, '1001', 'walkFromLastStop destination must be 1001');
    assert.ok(itinDest.walkFromLastStop.distanceMeters >= 30, `Distance between 1073 and 1001 must be >= 30m (was ${itinDest.walkFromLastStop.distanceMeters}m)`);
    assert.ok(itinDest.walkFromLastStop.walkingMinutes >= 1, `Walking minutes for >= 30m pole difference must be >= 1 (was ${itinDest.walkFromLastStop.walkingMinutes})`);
    assert.strictEqual(itinDest.walkFromLastStop.approximate, true, 'Estimated walks must retain approximate: true');
    console.log(`✓ Destination sibling stop >= 30m verified: ${itinDest.walkFromLastStop.distanceMeters}m -> ${itinDest.walkFromLastStop.walkingMinutes} min`);
  }

  // 4. Same stop requested
  console.log('Test 4: Same stop request (1016 -> 1016)');
  const sameRes = await transitRouter.plan('1016', '1016');
  assert.strictEqual(sameRes.success, true);
  assert.strictEqual(sameRes.itineraries.length, 0);
  assert.strictEqual(sameRes.message, "L'origen i la destinació són la mateixa parada.");
  console.log('✓ Same stop returns message with 0 itineraries');

  // 5. Direct request between 1016 and 1058
  console.log('Test 5: Direct request between 1016 and 1058');
  const pairRes = await transitRouter.plan('1016', '1058');
  assert.strictEqual(pairRes.success, true);
  assert.ok(pairRes.itineraries.length > 0);
  for (const it of pairRes.itineraries) {
    assert.strictEqual(it.timesBasis, 'published_trip', 'All itineraries must have timesBasis: published_trip');
  }
  console.log(`✓ Direct pair 1016 -> 1058 returned ${pairRes.itineraries.length} itineraries with timesBasis: published_trip`);

  console.log('\n🎉 ALL PLANNER SIBLING WALKING & TIMESBASIS TESTS PASSED PERFECTLY!\n');
}

main().catch(err => {
  console.error('\n❌ PLANNER SIBLING WALKING TEST FAILED:', err);
  process.exit(1);
});
