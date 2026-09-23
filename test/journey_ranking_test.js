/**
 * test/journey_ranking_test.js
 *
 * Regression suite for journey ranking quality.
 *
 * Arrival time alone produced absurd results: a one-transfer itinerary that
 * landed a minute earlier outranked the direct bus, and starting by walking
 * three stops in the wrong direction was free. These assertions pin the
 * complexity-aware ranking so it cannot silently revert to a pure
 * arrival-time sort.
 */

const tracker = require('../src/mataroTracker');
const router = require('../src/core/schedule/transitRouter');

let passedAssertions = 0;
const failureList = [];

function expect(condition, message) {
  if (!condition) {
    failureList.push(message);
    console.error(`  ❌ FAILED: ${message}`);
  } else {
    passedAssertions++;
  }
}

// A fixed departure keeps the ranking deterministic. Without it the suite
// would only catch the arrival-time regression at certain hours of the day,
// which is exactly the bug being pinned here.
const AT = { departureTime: '08:15' };
const opts = preference => ({ ...AT, preference });

async function run() {
  await tracker.init();
  router.setTracker(tracker);

  // 1. Roca Blanca -> Rodalies is a single bus (L8). It must rank first, and
  //    beating a 1-transfer alternative that arrives minutes earlier is the
  //    whole point of the complexity penalty.
  const direct = await router.planJourney('Roca Blanca', 'Rodalies', opts('fastest'));
  expect(direct.success, 'Roca Blanca -> Rodalies must plan');
  expect(direct.itineraries.length > 0, 'Roca Blanca -> Rodalies must return itineraries');

  const first = direct.itineraries[0];
  expect(first && first.transfersCount === 0, 'the direct bus must rank first for Roca Blanca -> Rodalies');
  expect(first && first.legs.length === 1, 'the winning itinerary must be a single leg');
  expect(first && first.legs[0].lineId === '8', 'the winning itinerary must be L8');

  // 2. A walking origin must not surface "walk backwards to an earlier stop"
  //    above a nearby direct board. The point sits on Roca Blanca itself, so
  //    the nearest stop needs only a few metres of walking.
  const nearOrigin = { lat: 41.5449, lon: 2.42533, radiusMeters: 900, name: 'Roca Blanca' };
  const walked = await router.planJourney(nearOrigin, 'Rodalies', opts('fastest'));
  expect(walked.success, 'coordinate origin -> Rodalies must plan');
  const walkedFirst = walked.itineraries[0];
  expect(walkedFirst && walkedFirst.transfersCount === 0, 'a direct board must beat a transfer from a walking origin');
  expect(walkedFirst && walkedFirst.walkingMinutes <= 5, 'the first itinerary must not start with a long walk');

  // 3. "Sense transbord" must never return a transfer itinerary.
  const directOnly = await router.planJourney('Roca Blanca', 'Hospital', opts('direct_only'));
  expect(directOnly.success, 'direct_only plan must succeed');
  expect(directOnly.itineraries.every(i => i.transfersCount === 0), 'direct_only must return transfersCount 0 for every itinerary');

  // 4. "Menys caminant" is a soft preference: it must never make the chosen
  //    itinerary walk FURTHER than the fastest option would, even when it
  //    does not end up reordering the board.
  const leastWalk = await router.planJourney(nearOrigin, 'Rodalies', opts('least_walking'));
  expect(leastWalk.success, 'least_walking plan must succeed');
  const leastTop = leastWalk.itineraries[0];
  expect(leastTop && leastTop.walkingDistanceMeters <= walkedFirst.walkingDistanceMeters,
    'least_walking must not pick a longer walk than fastest does');

  // 5. The result set stays small and diverse rather than a wall of transfers.
  expect(walked.itineraries.length <= 4, 'at most four itineraries are returned');

  console.log('\n=======================================================');
  console.log(`Total Passed Assertions: ${passedAssertions}`);
  console.log(`Total Failures Detected: ${failureList.length}`);
  console.log('=======================================================');
  if (failureList.length) {
    console.error('\n🔴 JOURNEY RANKING FAILURES:');
    failureList.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
    process.exit(1);
  }
  console.log('\n🎉 ALL JOURNEY RANKING ASSERTIONS PASSED!\n');
}

run().catch(err => {
  console.error('\n❌ JOURNEY RANKING HARNESS CRASHED:', err);
  process.exit(1);
});
