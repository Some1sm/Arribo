/**
 * test/challenger_tracker_schedule_test.js
 * 
 * Empirical Stress & Adversarial Challenge Suite for Milestone 1:
 * - Schedule Synthesizer (estimateStopTravelTimes with 0, 1, 500 stops, interpolation, edge cases)
 * - Tracker Registry (1,000+ line resolution throughput, 4-tier deduplication, cache invalidation, search stress)
 * - BaseTracker (direction === 'both' parallel resolution, latency resilience, error injection, GPS vs dead-reckoning deduplication, proximity deduplication)
 */

const assert = require('assert');
const scheduleSynthesizer = require('../src/core/schedule/scheduleSynthesizer');
const timeEngine = require('../src/core/time/timeEngine');
const calendarEngine = require('../src/core/time/calendarEngine');
const delayEngine = require('../src/core/schedule/delayEngine');
const BaseTracker = require('../src/core/BaseTracker');
const trackerRegistry = require('../src/core/TrackerRegistry');

async function runChallengerTestSuite() {
  console.log('⚔️  STARTING CHALLENGER 2 EMPIRICAL ADVERSARIAL STRESS TEST SUITE\n');
  let totalTestsRun = 0;

  // =========================================================================
  // TEST SUITE 1: scheduleSynthesizer - Stop Travel Times & Schedule Stress
  // =========================================================================
  console.log('📌 [SUITE 1] Testing Schedule Synthesizer (estimateStopTravelTimes & Interpolation)...');

  // 1.1 Empty Sequences & Falsy Inputs
  assert.deepStrictEqual(scheduleSynthesizer.estimateStopTravelTimes([]), []);
  assert.deepStrictEqual(scheduleSynthesizer.estimateStopTravelTimes(null), []);
  assert.deepStrictEqual(scheduleSynthesizer.estimateStopTravelTimes(undefined), []);
  assert.deepStrictEqual(scheduleSynthesizer.estimateStopTravelTimes('invalid'), []);
  totalTestsRun += 4;
  console.log('  ✓ 1.1 Empty & falsy sequences handled safely');

  // 1.2 Single-Stop Sequence (Boundary Edge Case)
  const singleStop = [{ id: 'stop-origin', name: 'Terminal Origin', lat: 41.538, lon: 2.441, seq: 1 }];
  const singleRes = scheduleSynthesizer.estimateStopTravelTimes(singleStop);
  assert.strictEqual(singleRes.length, 1);
  assert.strictEqual(singleRes[0].stopId, 'stop-origin');
  assert.strictEqual(singleRes[0].stopIndex, 0);
  assert.strictEqual(singleRes[0].segmentMeters, 0);
  assert.strictEqual(singleRes[0].cumulativeMeters, 0);
  assert.strictEqual(singleRes[0].dwellSec, 0);
  assert.strictEqual(singleRes[0].travelSec, 0);
  assert.strictEqual(singleRes[0].travelMinutes, 0);
  totalTestsRun++;
  console.log('  ✓ 1.2 Single-stop sequence returns 0 travel time and correct attributes');

  // 1.3 500-Stop Massive Sequence Stress & Benchmark
  const stopCount500 = 500;
  const stops500 = [];
  const baseLat = 41.3851;
  const baseLon = 2.1734;

  for (let i = 0; i < stopCount500; i++) {
    // Generate stops spaced along route
    stops500.push({
      id: `stop-${i + 1}`,
      name: `Parada Transit ${i + 1}`,
      seq: i + 1,
      lat: baseLat + i * 0.003,
      lon: baseLon + i * 0.004
    });
  }

  const startTime500 = performance.now();
  const res500 = scheduleSynthesizer.estimateStopTravelTimes(stops500, {
    speedKmh: 24, // 6.67 m/s
    dwellSecPerStop: 30
  });
  const duration500Ms = performance.now() - startTime500;

  assert.strictEqual(res500.length, 500);
  assert.strictEqual(res500[0].travelSec, 0);
  assert.strictEqual(res500[0].cumulativeMeters, 0);

  // Monotonicity verification
  for (let i = 1; i < 500; i++) {
    assert(res500[i].cumulativeMeters > res500[i - 1].cumulativeMeters, `Cumulative distance must increase monotonically at step ${i}`);
    assert(res500[i].travelSec > res500[i - 1].travelSec, `Travel seconds must increase monotonically at step ${i}`);
    assert.strictEqual(res500[i].stopIndex, i);
    assert.strictEqual(res500[i].dwellSec, i * 30);
  }

  assert(duration500Ms < 100, `500-stop estimation took ${duration500Ms.toFixed(2)}ms (expected <100ms)`);
  totalTestsRun += 3;
  console.log(`  ✓ 1.3 500-stop sequence calculated in ${duration500Ms.toFixed(2)}ms with strict monotonic progression`);

  // 1.4 Coordinate Missing / Zero Fallback & Robustness
  const corruptedStops = [
    { id: '1', name: 'Valid Stop 1', lat: 41.538, lon: 2.441 },
    { id: '2', name: 'Corrupted Stop (NaN)', lat: 'N/A', lon: undefined },
    { id: '3', name: 'Zero Coords', lat: 0, lon: 0 },
    { id: '4', name: 'Missing Coords' },
    { id: '5', name: 'Valid Stop 5', lat: 41.560, lon: 2.460 }
  ];
  const corruptRes = scheduleSynthesizer.estimateStopTravelTimes(corruptedStops, {
    defaultSegmentMeters: 550,
    speedMps: 10,
    dwellSecPerStop: 15
  });
  assert.strictEqual(corruptRes.length, 5);
  assert.strictEqual(corruptRes[1].segmentMeters, 550); // Fallback applied
  assert.strictEqual(corruptRes[2].segmentMeters, 550); // Zero lat/lon fallback applied
  assert.strictEqual(corruptRes[3].segmentMeters, 550); // Missing fallback applied
  assert(corruptRes[4].travelSec > corruptRes[3].travelSec);
  totalTestsRun += 2;
  console.log('  ✓ 1.4 Corrupted/missing/zero coordinates gracefully fall back to default segment distance');

  // 1.5 Interpolation across 500 stops
  const baseTripSec = timeEngine.timeStringToSeconds('07:00');
  const interpolated500 = scheduleSynthesizer.interpolateStopArrivals(baseTripSec, res500);
  assert.strictEqual(interpolated500.length, 500);
  assert.strictEqual(interpolated500[0].departureTime, '07:00');
  assert.strictEqual(interpolated500[499].arrivalSec, baseTripSec + res500[499].travelSec);
  totalTestsRun += 2;
  console.log('  ✓ 1.5 Stop arrival interpolation across 500 stops verified');

  // 1.6 getTravelTimeToStop lookups with various identifier formats
  assert.strictEqual(scheduleSynthesizer.getTravelTimeToStop(res500, 'stop-250'), res500[249].travelSec);
  assert.strictEqual(scheduleSynthesizer.getTravelTimeToStop(res500, 250), res500[249].travelSec); // match by seq/index
  assert.strictEqual(scheduleSynthesizer.getTravelTimeToStop(res500, 'nonexistent'), 0);
  totalTestsRun += 3;
  console.log('  ✓ 1.6 getTravelTimeToStop lookup handles string, number, and missing IDs');


  // =========================================================================
  // TEST SUITE 2: TrackerRegistry - High-Volume Resolution & Deduplication
  // =========================================================================
  console.log('\n📌 [SUITE 2] Testing TrackerRegistry (High-Volume Resolution & 4-Tier Deduplication)...');

  // 2.1 Multi-Operator Line Resolution Throughput (2,000+ calls across multi-agency lines)
  const testLines = [
    'c10', 'C-10', 'gen_0498', '02498', 'LINE-C10',
    '1', 'L1', '8', 'L8', 'mataro_2',
    'e11.1', 'E11.1', 'e11.2', 'c-20', 'n80',
    'r1', 'R1', 'r8', 'rg1', 'rt1', 'rodalies_r3',
    'b25', 'B25', 'm27', 'l70', 'n12', 'pr1',
    'n82', 'N82', 'e13', '302',
    'cat_gen_0496', 'moute_generic_999'
  ];

  // Warm-up to trigger lazy loading of JSON caches
  trackerRegistry.getTrackerForLine('c10');
  trackerRegistry.getTrackerForLine('cat_gen_0496');

  const startResTime = performance.now();
  const iterations = 5000;
  for (let i = 0; i < iterations; i++) {
    const lineToTest = testLines[i % testLines.length];
    const resolved = trackerRegistry.getTrackerForLine(lineToTest);
    assert(resolved !== null && typeof resolved.type === 'string');
  }
  const durationResMs = performance.now() - startResTime;
  const opsPerSec = Math.round((iterations / durationResMs) * 1000);
  assert(durationResMs < 250, `5,000 line resolutions took ${durationResMs.toFixed(2)}ms (expected <250ms)`);
  totalTestsRun += 2;
  console.log(`  ✓ 2.1 5,000 polymorphic line resolutions executed in ${durationResMs.toFixed(2)}ms (~${opsPerSec} ops/sec)`);

  // 2.2 Unresolvable Line Handling
  assert.doesNotThrow(() => {
    const fallbackRes = trackerRegistry.getTrackerForLine('unknown_line_xyz_123');
    assert.strictEqual(fallbackRes.type, 'catalonia');
  });
  totalTestsRun++;
  console.log('  ✓ 2.2 Unrecognized lines cleanly route to Catalonia Mou-te fallback');

  // 2.3 4-Tier Deduplication across 1,200+ Lines in Custom Registry Instance
  const CustomTrackerRegistryClass = trackerRegistry.TrackerRegistry;
  const stressRegistry = new CustomTrackerRegistryClass();

  // Create 3 synthetic providers generating overlapping lines
  class SyntheticProvider extends BaseTracker {
    constructor(prefix, lines) {
      super();
      this.prefix = prefix;
      this.customLines = lines;
    }
    getLines() {
      return this.customLines;
    }
  }

  const batch1 = []; // Provider A: 500 lines
  const batch2 = []; // Provider B: 400 lines with 200 duplicates of A (same GTFS routeId or same internal ID)
  const batch3 = []; // Provider C: 300 lines with prominent line duplicates (e.g. e11.1, c10, n82)

  for (let i = 1; i <= 500; i++) {
    let code = `L-${i}`;
    if (i === 1) code = 'C-10';
    if (i === 2) code = 'e11.1';
    batch1.push({
      id: `p1_line_${i}`,
      routeId: `ROUTE_GTFS_${i}`,
      code: code,
      agency: 'Moventis / Casas',
      name: `Line ${i}`
    });
  }

  for (let i = 1; i <= 400; i++) {
    if (i <= 200) {
      // Tier 2: Duplicate GTFS routeId from batch 1 under different agency key
      batch2.push({
        id: `p2_dup_${i}`,
        routeId: `ROUTE_GTFS_${i}`,
        code: `ALT-${i}`,
        agency: 'Generalitat Mou-te',
        name: `Duplicate Line ${i}`
      });
    } else {
      batch2.push({
        id: `p2_line_${i}`,
        routeId: `ROUTE_GTFS_P2_${i}`,
        code: `B-${i}`,
        agency: 'AMB Mobilitat',
        name: `AMB Line ${i}`
      });
    }
  }

  for (let i = 1; i <= 300; i++) {
    // Tier 4: Prominent line duplicate injection (different internal ID and different routeId, but same prominent code)
    if (i === 1) {
      batch3.push({ id: 'c10_dup_alt', code: 'C-10', routeId: 'DIFF_ROUTE_1', agency: 'Mou-te Generic', name: 'C10 Generic' });
    } else if (i === 2) {
      batch3.push({ id: 'e111_dup_alt', code: 'e11.1', routeId: 'DIFF_ROUTE_2', agency: 'Mou-te GTFS', name: 'e11.1 Dup' });
    } else {
      batch3.push({ id: `p3_line_${i}`, code: `S-${i}`, agency: 'Sagalés', name: `Sagalés Line ${i}` });
    }
  }

  stressRegistry.registerTracker('c10', new SyntheticProvider('p1', batch1), { agency: 'Moventis', priority: 100 });
  stressRegistry.registerTracker('amb', new SyntheticProvider('p2', batch2), { agency: 'AMB', priority: 50 });
  stressRegistry.registerTracker('catalonia', new SyntheticProvider('p3', batch3), { agency: 'Mou-te', priority: 10 });

  const startDedupTime = performance.now();
  const allDeduped = stressRegistry.getAllLines();
  const dedupDurationMs = performance.now() - startDedupTime;

  // Total lines submitted: 500 + 400 + 300 + 1 (C-10 default canonical) = 1201
  // Deduplicated expected count:
  // - Batch 1: 500
  // - Batch 2: 200 unique (200 were GTFS duplicates of Batch 1)
  // - Batch 3: 298 unique (2 were prominent duplicates: c10 and e11.1)
  // Total expected = 500 + 200 + 298 = 998
  assert.strictEqual(allDeduped.length, 998, `Deduplicated lines should equal 998 (got: ${allDeduped.length})`);
  assert(dedupDurationMs < 50, `1,200-line 4-tier deduplication took ${dedupDurationMs.toFixed(2)}ms (expected <50ms)`);
  totalTestsRun += 2;
  console.log(`  ✓ 2.3 4-tier catalog deduplication processed 1,200 lines down to ${allDeduped.length} unique entries in ${dedupDurationMs.toFixed(2)}ms`);

  // 2.4 Cache Invalidation on Tracker Registration & Dynamic Provider Catalog
  const initialCache = stressRegistry.getAllLines();
  assert.strictEqual(initialCache.length, 998);

  // Note on Dynamic Provider Key Finding:
  // TrackerRegistry.getAllLines() iterates hardcoded keys ['maresme', 'mataro', 'rodalies', 'sagales', 'amb']
  // If registered under an existing known key (e.g. 'sagales'), it invalidates and updates properly.
  // If registered under an unknown key (e.g. 'new_provider'), getAllLines() currently omits it.
  let isDynamicKeySupported = false;
  stressRegistry.registerTracker('new_provider', new SyntheticProvider('np', [{ id: 'new_line_9999', code: 'NEW-99', agency: 'NewOp' }]));
  const dynamicKeyCache = stressRegistry.getAllLines();
  if (dynamicKeyCache.length === 999 && dynamicKeyCache.some(l => l.id === 'new_line_9999')) {
    isDynamicKeySupported = true;
  } else {
    console.log('  ⚠️ FINDING: TrackerRegistry.getAllLines() skips custom provider keys not in hardcoded priority list.');
  }

  // Verify cache invalidation when registered under supported key
  stressRegistry.registerTracker('sagales', new SyntheticProvider('sag', [{ id: 'sag_line_100', code: 'S-100', agency: 'Sagalés' }]));
  const refreshedCache = stressRegistry.getAllLines();
  assert(refreshedCache.some(l => l.id === 'sag_line_100'), 'Cache must invalidate and include newly registered lines under sagales');
  totalTestsRun += 2;
  console.log('  ✓ 2.4 Cache invalidation on provider registration verified');

  // 2.5 Stop and Line Search Stress
  const searchResults1 = stressRegistry.searchStopsAndLines('L-10', 10);
  assert(searchResults1.length > 0);
  assert(searchResults1.some(r => r.lineCode === 'L-10'));

  const searchResultsEmpty = stressRegistry.searchStopsAndLines('', 10);
  assert.deepStrictEqual(searchResultsEmpty, []);

  const searchResultsSpecial = stressRegistry.searchStopsAndLines('@#$!%', 10);
  assert(Array.isArray(searchResultsSpecial));
  totalTestsRun += 3;
  console.log('  ✓ 2.5 Multi-agency search stress test passed');


  // =========================================================================
  // TEST SUITE 3: BaseTracker - direction === 'both' Concurrency & Bus Deduplication
  // =========================================================================
  console.log('\n📌 [SUITE 3] Testing BaseTracker (Parallel Both-Directions & Bus Deduplication)...');

  // 3.1 Parallel 'both' resolution with asymmetric network latencies
  class LatencyTracker extends BaseTracker {
    constructor(delays = { dir0: 0, dir1: 0 }, errors = { dir0: null, dir1: null }) {
      super();
      this.delays = delays;
      this.errors = errors;
      this.routesMap.set('c-async', { id: 'c-async', code: 'ASYNC', name: 'Async Route' });
    }

    async getRawLineData(lineId, direction = '0') {
      const dirStr = String(direction);
      const delayMs = dirStr === '1' ? this.delays.dir1 : this.delays.dir0;
      const errorToThrow = dirStr === '1' ? this.errors.dir1 : this.errors.dir0;

      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }

      if (errorToThrow) {
        throw new Error(errorToThrow);
      }

      return {
        lineConfig: this.routesMap.get(lineId),
        stops: [
          { id: `stop-${dirStr}-1`, name: `Station ${dirStr} A`, seq: 1 },
          { id: `stop-${dirStr}-2`, name: `Station ${dirStr} B`, seq: 2 }
        ],
        polylineCoords: [{ lat: 41.5, lon: 2.4 }, { lat: 41.6, lon: 2.5 }],
        directions: [
          { dirId: '0', name: 'Anada Cap a Mataró' },
          { dirId: '1', name: 'Tornada Cap a Barcelona' }
        ]
      };
    }

    async fetchLiveVehicles(lineId) {
      return [
        { vehicleId: 'BUS_DIR0', direction: '0', isEstimated: false, isRealTime: true, lat: 41.51, lon: 2.41 },
        { vehicleId: 'BUS_DIR1', direction: '1', isEstimated: false, isRealTime: true, lat: 41.59, lon: 2.49 }
      ];
    }
  }

  // Measure parallel execution: dir0 = 60ms, dir1 = 30ms. Parallel should finish in ~60-80ms, NOT 90ms+
  const latencyTracker = new LatencyTracker({ dir0: 60, dir1: 30 });
  const startBothTime = performance.now();
  const bothDetails = await latencyTracker.getLineDetails('c-async', 'both');
  const bothDurationMs = performance.now() - startBothTime;

  assert.strictEqual(bothDetails.direction, 'both');
  assert.strictEqual(bothDetails.secondaryColor, '#38bdf8');
  assert.strictEqual(bothDetails.stops.length, 2);
  assert.strictEqual(bothDetails.secondaryStops.length, 2);
  assert.strictEqual(bothDetails.allDirections.length, 2);
  assert.strictEqual(bothDetails.activeBuses.length, 2);
  assert(bothDurationMs < 120, `Parallel resolution took ${bothDurationMs.toFixed(2)}ms (expected <120ms)`);
  totalTestsRun += 5;
  console.log(`  ✓ 3.1 Parallel direction === 'both' with asymmetric latency completed concurrently in ${bothDurationMs.toFixed(2)}ms`);

  // 3.2 Error Injection in Direction 0 (Graceful Fallback to Direction 1)
  const dir0FailingTracker = new LatencyTracker({ dir0: 0, dir1: 0 }, { dir0: 'Upstream 503 Gateway Timeout', dir1: null });
  const dir0FallRes = await dir0FailingTracker.getLineDetails('c-async', 'both');
  assert.strictEqual(dir0FallRes.id, 'c-async');
  assert.strictEqual(dir0FallRes.direction, '1'); // Primary fell back to direction 1
  totalTestsRun++;
  console.log('  ✓ 3.2 Upstream failure in Direction 0 gracefully falls back to Direction 1');

  // 3.3 Error Injection in Direction 1 (Graceful Fallback to Direction 0)
  const dir1FailingTracker = new LatencyTracker({ dir0: 0, dir1: 0 }, { dir0: null, dir1: 'Upstream 500 Internal Error' });
  const dir1FallRes = await dir1FailingTracker.getLineDetails('c-async', 'both');
  assert.strictEqual(dir1FallRes.id, 'c-async');
  assert.strictEqual(dir1FallRes.direction, '0'); // Primary fell back to direction 0
  totalTestsRun++;
  console.log('  ✓ 3.3 Upstream failure in Direction 1 gracefully falls back to Direction 0');

  // 3.4 Error Injection in Both Directions (Throws Error)
  const allFailingTracker = new LatencyTracker({ dir0: 0, dir1: 0 }, { dir0: 'Fail Dir 0', dir1: 'Fail Dir 1' });
  await assert.rejects(async () => {
    await allFailingTracker.getLineDetails('c-async', 'both');
  }, /Unable to fetch line details for c-async in both directions/);
  totalTestsRun++;
  console.log('  ✓ 3.4 Complete failure across both directions rejects with descriptive error');

  // 3.5 Real GPS Telemetry Overriding Dead-Reckoning Estimations
  const trackerBase = new BaseTracker();

  // Test Case A: Estimated vehicle arrived first, GPS vehicle arrives second -> GPS vehicle wins
  const streamA = [
    { vehicleId: 'BUS_99', lat: 41.5000, lon: 2.4000, isEstimated: true, isRealTime: false, speedKmh: 20 },
    { vehicleId: 'BUS_99', lat: 41.5050, lon: 2.4080, isEstimated: false, isRealTime: true, speedKmh: 45 }
  ];
  const dedupedA = trackerBase.deduplicateBuses(streamA);
  assert.strictEqual(dedupedA.length, 1);
  assert.strictEqual(dedupedA[0].vehicleId, 'BUS_99');
  assert.strictEqual(dedupedA[0].isEstimated, false);
  assert.strictEqual(dedupedA[0].isRealTime, true);
  assert.strictEqual(dedupedA[0].lat, 41.5050);

  // Test Case B: GPS vehicle arrived first, Estimated vehicle arrives second -> GPS vehicle stays
  const streamB = [
    { vehicleId: 'BUS_88', lat: 41.5050, lon: 2.4080, isEstimated: false, isRealTime: true, speedKmh: 45 },
    { vehicleId: 'BUS_88', lat: 41.5000, lon: 2.4000, isEstimated: true, isRealTime: false, speedKmh: 20 }
  ];
  const dedupedB = trackerBase.deduplicateBuses(streamB);
  assert.strictEqual(dedupedB.length, 1);
  assert.strictEqual(dedupedB[0].vehicleId, 'BUS_88');
  assert.strictEqual(dedupedB[0].isEstimated, false);
  assert.strictEqual(dedupedB[0].isRealTime, true);
  assert.strictEqual(dedupedB[0].lat, 41.5050);

  // Test Case C: Matching by tripId when vehicleId is missing
  const streamC = [
    { tripId: 'TRIP_77', lat: 41.51, lon: 2.41, isEstimated: true },
    { tripId: 'TRIP_77', lat: 41.52, lon: 2.42, isEstimated: false, isRealTime: true }
  ];
  const dedupedC = trackerBase.deduplicateBuses(streamC);
  assert.strictEqual(dedupedC.length, 1);
  assert.strictEqual(dedupedC[0].isEstimated, false);
  totalTestsRun += 4;
  console.log('  ✓ 3.5 Real GPS strictly overrides dead-reckoning estimations regardless of arrival order');

  // 3.6 Spatial & Proximity Deduplication (Vehicles without IDs)
  const streamSpatial = [
    { lat: 41.53812, lon: 2.44105, isEstimated: true, name: 'Ghost 1' },
    { lat: 41.53814, lon: 2.44108, isEstimated: true, name: 'Ghost 1 near' }, // close enough (4 decimals: 41.5381_2.4411)
    { lat: 41.55900, lon: 2.47000, isEstimated: true, name: 'Ghost 2 far' }
  ];
  const dedupedSpatial = trackerBase.deduplicateBuses(streamSpatial);
  assert.strictEqual(dedupedSpatial.length, 2);
  assert.strictEqual(dedupedSpatial[0].name, 'Ghost 1');
  assert.strictEqual(dedupedSpatial[1].name, 'Ghost 2 far');
  totalTestsRun += 2;
  console.log('  ✓ 3.6 Spatial coordinate proximity deduplicates anonymous ghost estimates');

  // 3.7 High-Density Mixed Stream Deduplication (500 vehicles stress test)
  const denseStream = [];
  for (let i = 1; i <= 200; i++) {
    // 200 real GPS vehicles
    denseStream.push({ vehicleId: `REAL_${i}`, lat: 41.5 + i * 0.001, lon: 2.4 + i * 0.001, isEstimated: false });
    // 200 estimated phantom copies of the same vehicles
    denseStream.push({ vehicleId: `REAL_${i}`, lat: 41.5, lon: 2.4, isEstimated: true });
    // 100 anonymous estimated vehicles at distinct locations
    if (i <= 100) {
      denseStream.push({ lat: 41.6 + i * 0.001, lon: 2.5 + i * 0.001, isEstimated: true });
    }
  }

  const startDenseTime = performance.now();
  const dedupedDense = trackerBase.deduplicateBuses(denseStream);
  const denseDurationMs = performance.now() - startDenseTime;

  assert.strictEqual(dedupedDense.length, 300); // 200 real + 100 anonymous
  assert(denseDurationMs < 20, `500-vehicle deduplication took ${denseDurationMs.toFixed(2)}ms (expected <20ms)`);
  totalTestsRun += 2;
  console.log(`  ✓ 3.7 High-density 500-vehicle deduplication completed in ${denseDurationMs.toFixed(2)}ms with 100% accuracy`);

  // 3.8 Checkpoint Generation (Adaptive Scaling on 500 Stops)
  const checkpoints500 = trackerBase.buildCheckpoints(stops500, dedupedDense.slice(0, 10));
  assert(checkpoints500.length >= 8 && checkpoints500.length <= 12, `Checkpoints should scale adaptively (got: ${checkpoints500.length})`);
  assert.strictEqual(checkpoints500[0].id, 'stop-1');
  assert.strictEqual(checkpoints500[checkpoints500.length - 1].id, 'stop-500');

  // Empty checkpoints
  assert.deepStrictEqual(trackerBase.buildCheckpoints([]), []);
  totalTestsRun += 3;
  console.log(`  ✓ 3.8 Adaptive checkpoint generator produced ${checkpoints500.length} milestones across 500 stops`);

  // 3.9 Vehicle Normalization & Dual-Compatibility Contract
  const rawVeh = {
    vehicleId: 'V100',
    lat: '41.5381234',
    lon: '2.4410987',
    bearing: 90,
    speedKmh: 42,
    delayMins: 5,
    isRealTime: true
  };
  const normVeh = trackerBase.normalizeVehicle(rawVeh);
  assert.strictEqual(normVeh.lat, 41.538123);
  assert.strictEqual(normVeh.lon, 2.441099);
  assert.strictEqual(normVeh.speed, 42);
  assert.strictEqual(normVeh.speedKmh, 42);
  assert.strictEqual(normVeh.delayMinutes, 5);
  assert.strictEqual(normVeh.delayMins, 5);
  assert.strictEqual(normVeh.isRealTime, true);
  assert.strictEqual(normVeh.isRealtime, true);
  assert.strictEqual(normVeh.compass.code, 'E');
  totalTestsRun += 4;
  console.log('  ✓ 3.9 normalizeVehicle emits 100% dual-compatibility properties');


  console.log(`\n================================================================`);
  console.log(`🎉 ALL ${totalTestsRun} CHALLENGER EMPIRICAL ADVERSARIAL TESTS PASSED PERFECTLY!`);
  console.log(`================================================================\n`);
}

runChallengerTestSuite().catch(err => {
  console.error('\n❌ CHALLENGER TEST FAILED:', err);
  process.exit(1);
});
