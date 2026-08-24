/**
 * test/c10_telemetry_adversarial_test.js
 * 
 * Comprehensive Adversarial & Empirical Stress Harness for C-10 Telemetry Extractor.
 * Authored by: Challenger 1 (teamwork_preview_challenger_m1_1)
 */

const assert = require('assert');
const c10Extractor = require('../src/c10TelemetryExtractor');
const moventisClient = require('../src/moventisClient');
const flightRecorder = require('../src/flightRecorder');
const corridorTracker = require('../src/corridorTracker');
const geoEngine = require('../src/core/geo/geoEngine');
const delayEngine = require('../src/core/schedule/delayEngine');
const timeEngine = require('../src/core/time/timeEngine');
const calendarEngine = require('../src/core/time/calendarEngine');
const {
  C10_STOPS_DIR1,
  C10_STOPS_DIR0,
  C10_POLYLINE_DIR1,
  C10_POLYLINE_DIR0
} = require('../src/c10StaticData');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
let totalAssertions = 0;
const failureDetails = [];

function check(desc, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✓ ${desc}`);
  } catch (err) {
    failedTests++;
    console.error(`  ❌ FAIL: ${desc}`);
    console.error(`     Reason: ${err.message}`);
    failureDetails.push({ test: desc, error: err.stack || err.message });
  }
}

async function checkAsync(desc, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✓ ${desc}`);
  } catch (err) {
    failedTests++;
    console.error(`  ❌ FAIL: ${desc}`);
    console.error(`     Reason: ${err.message}`);
    failureDetails.push({ test: desc, error: err.stack || err.message });
  }
}

console.log('⚔️  =========================================================================');
console.log('⚔️  CHALLENGER 1: ADVERSARIAL STRESS HARNESS — C-10 TELEMETRY EXTRACTOR');
console.log('⚔️  =========================================================================\n');

// =============================================================================
// SECTION 1: Out-of-Bounds Coordinates & Degenerate Types
// =============================================================================
console.log('🔷 [Section 1] Out-of-Bounds Coordinates & Degenerate Types...');

check('1.1 Remote cities and geographical antipodes are strictly rejected', () => {
  const remoteCoords = [
    { city: 'Madrid', lat: 40.4168, lon: -3.7038 },
    { city: 'London', lat: 51.5074, lon: -0.1278 },
    { city: 'Valencia', lat: 39.4699, lon: -0.3763 },
    { city: 'Paris', lat: 48.8566, lon: 2.3522 },
    { city: 'Tokyo', lat: 35.6762, lon: 139.6503 },
    { city: 'Sydney', lat: -33.8688, lon: 151.2093 },
    { city: 'Buenos Aires', lat: -34.6037, lon: -58.3816 },
    { city: 'Equator / Null Island', lat: 0, lon: 0 }
  ];

  for (const { city, lat, lon } of remoteCoords) {
    assert.strictEqual(
      c10Extractor.isWithinBoundingBox(lat, lon),
      false,
      `Should reject ${city} (${lat}, ${lon})`
    );
    const raw = { id: `remote_${city}`, lat, lon, speed: 40 };
    assert.strictEqual(
      c10Extractor.normalizeRawVehicle(raw),
      null,
      `normalizeRawVehicle must return null for ${city}`
    );
    totalAssertions += 2;
  }
});

check('1.2 Sea coordinates and out-of-corridor regional points are rejected', () => {
  const regionalOutside = [
    { name: 'Deep Balearic Sea (South)', lat: 41.0000, lon: 2.3000 },
    { name: 'Offshore Maresme (15km in Sea)', lat: 41.4000, lon: 2.6500 },
    { name: 'Pyrenees (North)', lat: 42.4000, lon: 2.3000 },
    { name: 'Lleida (West)', lat: 41.6176, lon: 0.6200 },
    { name: 'Girona center', lat: 41.9794, lon: 2.8214 },
    { name: 'Tarragona port', lat: 41.1189, lon: 1.2445 }
  ];

  for (const { name, lat, lon } of regionalOutside) {
    assert.strictEqual(
      c10Extractor.isWithinBoundingBox(lat, lon),
      false,
      `Should reject ${name}`
    );
    totalAssertions++;
  }
});

check('1.3 Exact boundary box limits and epsilon boundaries', () => {
  const { minLat, maxLat, minLon, maxLon } = c10Extractor.boundingBox;
  const eps = 0.000001;

  // On the boundary (inclusive)
  assert.strictEqual(c10Extractor.isWithinBoundingBox(minLat, minLon), true);
  assert.strictEqual(c10Extractor.isWithinBoundingBox(maxLat, maxLon), true);
  assert.strictEqual(c10Extractor.isWithinBoundingBox(minLat, maxLon), true);
  assert.strictEqual(c10Extractor.isWithinBoundingBox(maxLat, minLon), true);

  // Outside by 1 epsilon
  assert.strictEqual(c10Extractor.isWithinBoundingBox(minLat - eps, minLon), false);
  assert.strictEqual(c10Extractor.isWithinBoundingBox(maxLat + eps, maxLon), false);
  assert.strictEqual(c10Extractor.isWithinBoundingBox(minLat, minLon - eps), false);
  assert.strictEqual(c10Extractor.isWithinBoundingBox(maxLat, maxLon + eps), false);

  totalAssertions += 8;
});

check('1.4 Hostile degenerate coordinate types do not throw and return false / null', () => {
  const degenerates = [
    [NaN, 2.24],
    [41.44, NaN],
    [NaN, NaN],
    [Infinity, 2.24],
    [41.44, -Infinity],
    [null, null],
    [undefined, undefined],
    ['invalid', 'coords'],
    [{}, {}],
    [[], []],
    [true, false],
    [41.48, 'not_a_number'],
    ['41.48', '2.35'] // Strings that convert to valid numbers
  ];

  for (const [lat, lon] of degenerates) {
    const isStringValid = !isNaN(Number(lat)) && !isNaN(Number(lon)) &&
      Number(lat) >= 41.35 && Number(lat) <= 41.60 &&
      Number(lon) >= 2.15 && Number(lon) <= 2.50;

    const result = c10Extractor.isWithinBoundingBox(lat, lon);
    assert.strictEqual(result, isStringValid, `Failed for [${lat}, ${lon}]`);

    const raw = { id: 'test_deg', lat, lon };
    const normalized = c10Extractor.normalizeRawVehicle(raw);
    if (isStringValid) {
      assert.ok(normalized !== null);
    } else {
      assert.strictEqual(normalized, null);
    }
    totalAssertions += 2;
  }
});

// =============================================================================
// SECTION 2: Malformed, Corrupted & Hostile Payloads
// =============================================================================
console.log('\n🔷 [Section 2] Malformed, Corrupted & Hostile Payloads...');

check('2.1 Corrupted and bizarre vehicle objects are handled cleanly without unhandled exceptions', () => {
  const hostileObjects = [
    null,
    undefined,
    12345,
    'not an object',
    [],
    {},
    { id: null },
    { id: 0, lat: 41.48, lon: 2.35 }, // id 0
    { id: '', lat: 41.48, lon: 2.35 }, // empty id
    { id: 'c10_502_999', lat: 41.48, lon: 2.35, speed: 999999, bearing: 99999 }, // Extreme speed/bearing
    { id: 'c10_502_998', lat: 41.48, lon: 2.35, speed: -50, bearing: -720 }, // Negative speed/bearing
    { id: 'c10_502_997', lat: 41.48, lon: 2.35, fechaHora: 'invalid-date-string' }, // Malformed date
    { id: 'c10_502_996', lat: 41.48, lon: 2.35, fechaHora: 999999999999999 }, // Future epoch
    { id: 'c10_502_995', lat: 41.48, lon: 2.35, plate: 'X'.repeat(5000) }, // Huge string
    { id: '!@#$%^&*()', lat: 41.48, lon: 2.35 } // Special chars
  ];

  for (const raw of hostileObjects) {
    let v = null;
    v = c10Extractor.normalizeRawVehicle(raw);

    if (v) {
      assert.strictEqual(typeof v.vehicleId, 'string');
      assert.strictEqual(typeof v.lat, 'number');
      assert.strictEqual(typeof v.lon, 'number');
      assert.strictEqual(typeof v.latitude, 'number');
      assert.strictEqual(typeof v.longitude, 'number');
      assert.strictEqual(typeof v.speedKmh, 'number');
      assert.ok(v.speedKmh >= 0 && v.speedKmh <= 100, `Speed bounded: ${v.speedKmh}`);
      assert.strictEqual(typeof v.bearing, 'number');
      assert.ok(v.bearing >= 0 && v.bearing <= 360, `Bearing bounded: ${v.bearing}`);
      assert.strictEqual(v.isRealTime, true);
      assert.strictEqual(v.isEstimated, false);
      assert.strictEqual(typeof v.timestamp, 'number');
      assert.ok(Number.isFinite(v.timestamp));
      totalAssertions += 10;
    }
    totalAssertions++;
  }
});

check('2.2 Batch extraction with 1000 noisy/corrupted items isolates valid C-10 buses', () => {
  const noiseBatch = [];

  // 990 junk items
  for (let i = 0; i < 990; i++) {
    if (i % 5 === 0) noiseBatch.push(null);
    else if (i % 5 === 1) noiseBatch.push({ lat: 'sea', lon: 'mountain' });
    else if (i % 5 === 2) noiseBatch.push({ id: `junk_${i}`, lat: 40.0 + (i * 0.001), lon: 3.0 });
    else if (i % 5 === 3) noiseBatch.push({ id: `non_c10_${i}`, line: 'B25', lat: 41.45, lon: 2.25 });
    else noiseBatch.push({ foo: 'bar', baz: 123 });
  }

  // 10 genuine C-10 vehicles along N-II
  for (let i = 0; i < 10; i++) {
    noiseBatch.push({
      line: 'C-10',
      id: `genuine_${100 + i}`,
      lat: 41.4500 + (i * 0.008),
      lon: 2.2500 + (i * 0.015),
      speed: 35,
      bearing: 50
    });
  }

  const validVehicles = [];
  for (const raw of noiseBatch) {
    const v = c10Extractor.normalizeRawVehicle(raw);
    if (v) validVehicles.push(v);
  }

  assert.strictEqual(validVehicles.length, 10, 'Should extract exactly the 10 valid C-10 buses');
  for (const v of validVehicles) {
    assert.strictEqual(v.lineId, 'c10');
    assert.strictEqual(v.lineCode, 'C-10');
    assert.ok(v.vehicleId.startsWith('c10_502_genuine_'));
  }
  totalAssertions += 21;
});

// =============================================================================
// SECTION 3: High Concurrency Burst & Single-Flight Coalescing
// =============================================================================
console.log('\n🔷 [Section 3] High Concurrency Burst & Single-Flight Coalescing...');

(async () => {
  await checkAsync('3.1 100 simultaneous burst requests coalesce into exactly 1 upstream query', async () => {
    let upstreamCallCount = 0;
    c10Extractor.setMockSource(async () => {
      upstreamCallCount++;
      await new Promise(resolve => setTimeout(resolve, 30));
      return [
        { id: 'burst_1', lat: 41.47, lon: 2.30, speed: 40, bearing: 45 },
        { id: 'burst_2', lat: 41.52, lon: 2.42, speed: 35, bearing: 225 }
      ];
    });

    const burstRequests = Array.from({ length: 100 }, () =>
      c10Extractor.getLiveVehicles({ bypassCache: true })
    );

    const allResults = await Promise.all(burstRequests);

    assert.strictEqual(upstreamCallCount, 1, 'Upstream must be invoked exactly ONCE for 100 concurrent requests');
    assert.strictEqual(allResults.length, 100);
    for (const res of allResults) {
      assert.strictEqual(res.length, 2);
      assert.strictEqual(res[0].vehicleId, 'c10_502_burst_1');
      assert.strictEqual(res[1].vehicleId, 'c10_502_burst_2');
    }
    assert.strictEqual(c10Extractor._inflight.size, 0, '_inflight map must be completely clean after resolution');

    c10Extractor.setMockSource(null);
    totalAssertions += 5;
  });

  await checkAsync('3.2 Concurrent error failure cleanly clears _inflight and rejects gracefully', async () => {
    c10Extractor.setMockSource(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      throw new Error('500 Internal Server Error in Upstream Gateway');
    });

    const requests = Array.from({ length: 25 }, () =>
      c10Extractor.getLiveVehicles({ bypassCache: true })
    );

    const results = await Promise.all(requests);
    assert.strictEqual(results.length, 25);
    for (const r of results) {
      assert.ok(Array.isArray(r), 'Failed concurrent calls must return safe fallback array');
    }
    assert.strictEqual(c10Extractor._inflight.size, 0, '_inflight map must be deleted even on throw');

    c10Extractor.setMockSource(null);
    totalAssertions += 3;
  });

  // =============================================================================
  // SECTION 4: Timeout, Network Failure & Circuit Breaker State Machine
  // =============================================================================
  console.log('\n🔷 [Section 4] Timeout, Network Failure & Circuit Breaker State Machine...');

  await checkAsync('4.1 Circuit breaker trips after 3 failures and falls back to Moventis SAE', async () => {
    let ambCallCount = 0;
    let saeCallCount = 0;

    // Reset circuit breaker
    c10Extractor._circuitBreaker.failures = 0;
    c10Extractor._circuitBreaker.lastFailure = 0;

    // Custom fetch backend to simulate AMB failing
    c10Extractor.setFetchBackend(async () => {
      ambCallCount++;
      throw new Error('ECONNREFUSED: api.ambmobilitat.cat');
    });

    // Mock Moventis client
    const originalGetPositions = moventisClient.getLinePositions;
    moventisClient.getLinePositions = async (lineId) => {
      saeCallCount++;
      return [
        { idVehiculo: 'sae_fallback_1', latitud: '41.4850', longitud: '2.3400', velocidad: '30' }
      ];
    };

    // Call 1: AMB fails (failure 1) -> SAE called
    const res1 = await c10Extractor.getLiveVehicles({ bypassCache: true });
    assert.strictEqual(ambCallCount, 1);
    assert.strictEqual(saeCallCount, 1);
    assert.strictEqual(c10Extractor._circuitBreaker.failures, 1);
    assert.strictEqual(res1.length, 1);
    assert.strictEqual(res1[0].vehicleId, 'c10_502_sae_fallback_1');

    // Call 2: AMB fails (failure 2) -> SAE called
    const res2 = await c10Extractor.getLiveVehicles({ bypassCache: true });
    assert.strictEqual(ambCallCount, 2);
    assert.strictEqual(saeCallCount, 2);
    assert.strictEqual(c10Extractor._circuitBreaker.failures, 2);

    // Call 3: AMB fails (failure 3) -> circuit trips OPEN!
    const res3 = await c10Extractor.getLiveVehicles({ bypassCache: true });
    assert.strictEqual(ambCallCount, 3);
    assert.strictEqual(saeCallCount, 3);
    assert.strictEqual(c10Extractor._circuitBreaker.failures, 3);

    // Call 4: Circuit is OPEN -> AMB must NOT be called at all! Immediately goes to SAE
    const res4 = await c10Extractor.getLiveVehicles({ bypassCache: true });
    assert.strictEqual(ambCallCount, 3, 'AMB should NOT be called when circuit breaker is OPEN');
    assert.strictEqual(saeCallCount, 4);
    assert.strictEqual(res4.length, 1);

    // Call 5: Fast-forward cooldown (simulate 35s passed)
    c10Extractor._circuitBreaker.lastFailure = Date.now() - 35000;
    // Now AMB is restored
    c10Extractor.setFetchBackend(async () => {
      ambCallCount++;
      return [{ line: 'C-10', id: 'amb_recovered_99', latitude: '41.4850', longitude: '2.3400' }];
    });

    const res5 = await c10Extractor.getLiveVehicles({ bypassCache: true });
    assert.strictEqual(ambCallCount, 4, 'AMB should be probed again after cooldown');
    assert.strictEqual(c10Extractor._circuitBreaker.failures, 0, 'Failures should reset to 0 on success');
    assert.strictEqual(res5[0].vehicleId, 'c10_502_amb_recovered_99');

    // Clean up
    c10Extractor.setFetchBackend(null);
    moventisClient.getLinePositions = originalGetPositions;
    totalAssertions += 15;
  });

  await checkAsync('4.2 Total catastrophic failure (AMB and SAE both throw) returns [] gracefully', async () => {
    c10Extractor._circuitBreaker.failures = 0;
    c10Extractor.setFetchBackend(async () => { throw new Error('AMB down'); });
    const origSae = moventisClient.getLinePositions;
    moventisClient.getLinePositions = async () => { throw new Error('SAE down'); };

    const res = await c10Extractor.getLiveVehicles({ bypassCache: true });
    assert.ok(Array.isArray(res));
    assert.strictEqual(res.length, 0);

    c10Extractor.setFetchBackend(null);
    moventisClient.getLinePositions = origSae;
    totalAssertions += 2;
  });

  // =============================================================================
  // SECTION 5: Coordinate Projections along N-II Corridor Vertices
  // =============================================================================
  console.log('\n🔷 [Section 5] Coordinate Projections along N-II Corridor Vertices...');

  check('5.1 Exact stop vertices across all 42 Dir 1 stops project with valid progress', () => {
    for (let i = 0; i < C10_STOPS_DIR1.length; i++) {
      const stop = C10_STOPS_DIR1[i];
      const raw = {
        id: `stop_dir1_${i}`,
        lat: stop.lat,
        lon: stop.lon,
        dir: '1',
        speed: 30
      };

      const v = c10Extractor.normalizeRawVehicle(raw);
      assert.ok(v, `Stop ${i} (${stop.name}) should normalize`);
      assert.strictEqual(v.direction, '1');
      assert.strictEqual(v.destination, 'Hospital de Mataró');
      assert.strictEqual(typeof v.totalProgress, 'number');
      assert.ok(v.totalProgress >= 0 && v.totalProgress <= 100);
      assert.ok(v.fromStop.length > 0);
      assert.ok(v.toStop.length > 0);
      assert.ok(v.secondsToNextStop >= 10);
      totalAssertions += 7;
    }
  });

  check('5.2 Exact stop vertices across all 45 Dir 0 stops project with valid progress', () => {
    for (let i = 0; i < C10_STOPS_DIR0.length; i++) {
      const stop = C10_STOPS_DIR0[i];
      const raw = {
        id: `stop_dir0_${i}`,
        lat: stop.lat,
        lon: stop.lon,
        dir: '0',
        speed: 30
      };

      const v = c10Extractor.normalizeRawVehicle(raw);
      assert.ok(v, `Stop ${i} (${stop.name}) should normalize`);
      assert.strictEqual(v.direction, '0');
      assert.strictEqual(v.destination, 'Barcelona (Metro la Pau)');
      assert.strictEqual(typeof v.totalProgress, 'number');
      assert.ok(v.totalProgress >= 0 && v.totalProgress <= 100);
      assert.ok(v.fromStop.length > 0);
      assert.ok(v.toStop.length > 0);
      assert.ok(v.secondsToNextStop >= 10);
      totalAssertions += 7;
    }
  });

  check('5.3 Boundary speed conditions: 0 km/h stopped bus and 100 km/h highway cruise', () => {
    // 0 km/h stopped bus
    const stopped = c10Extractor.normalizeRawVehicle({
      id: 'stopped_1',
      lat: 41.4878,
      lon: 2.3554,
      speed: 0,
      dir: '1'
    });
    assert.ok(stopped);
    assert.strictEqual(stopped.speedKmh, 0);
    assert.ok(stopped.secondsToNextStop >= 10, 'No division by zero on 0 km/h');

    // 100 km/h highway speed
    const fast = c10Extractor.normalizeRawVehicle({
      id: 'fast_1',
      lat: 41.4878,
      lon: 2.3554,
      speed: 100,
      dir: '1'
    });
    assert.ok(fast);
    assert.strictEqual(fast.speedKmh, 100);
    assert.ok(fast.secondsToNextStop >= 10);
    totalAssertions += 5;
  });

  check('5.4 Direction resolution from bearing angle edge cases', () => {
    // Bearing 45° (NE) -> Dir 1
    const vNE = c10Extractor.normalizeRawVehicle({ id: 'b45', lat: 41.48, lon: 2.35, bearing: 45 });
    assert.strictEqual(vNE.direction, '1');

    // Bearing 225° (SW) -> Dir 0
    const vSW = c10Extractor.normalizeRawVehicle({ id: 'b225', lat: 41.48, lon: 2.35, bearing: 225 });
    assert.strictEqual(vSW.direction, '0');

    // Bearing 15° (lower limit Dir 1)
    const v15 = c10Extractor.normalizeRawVehicle({ id: 'b15', lat: 41.48, lon: 2.35, bearing: 15 });
    assert.strictEqual(v15.direction, '1');

    // Bearing 125° (upper limit Dir 1)
    const v125 = c10Extractor.normalizeRawVehicle({ id: 'b125', lat: 41.48, lon: 2.35, bearing: 125 });
    assert.strictEqual(v125.direction, '1');

    // Bearing 175° (lower limit Dir 0)
    const v175 = c10Extractor.normalizeRawVehicle({ id: 'b175', lat: 41.48, lon: 2.35, bearing: 175 });
    assert.strictEqual(v175.direction, '0');

    // Bearing 305° (upper limit Dir 0)
    const v305 = c10Extractor.normalizeRawVehicle({ id: 'b305', lat: 41.48, lon: 2.35, bearing: 305 });
    assert.strictEqual(v305.direction, '0');

    totalAssertions += 6;
  });

  // =============================================================================
  // SECTION 6: Delay & Schedule Engine Edge Cases
  // =============================================================================
  console.log('\n🔷 [Section 6] Delay & Schedule Engine Edge Cases...');

  check('6.1 Trip delay computation with extreme early/late offsets is strictly bounded [-15..60]', () => {
    // Fake target dates at various hours
    const morningDate = new Date('2026-08-24T08:30:00.000Z');
    const delay1 = c10Extractor.calculateTripDelay(41.4878, 2.3554, '1', 10, morningDate);
    assert.ok(delay1);
    assert.strictEqual(typeof delay1.delayMins, 'number');
    assert.ok(delay1.delayMins >= -15 && delay1.delayMins <= 60);
    assert.ok(delay1.delayBadgeText);
    assert.ok(delay1.delayStatus);

    // Midnight rollover test
    const midnightDate = new Date('2026-08-24T23:59:50.000Z');
    const delay2 = c10Extractor.calculateTripDelay(41.4878, 2.3554, '0', 5, midnightDate);
    assert.ok(delay2);
    assert.strictEqual(typeof delay2.delayMins, 'number');
    assert.ok(delay2.delayMins >= -15 && delay2.delayMins <= 60);

    // Invalid date fallback
    const delayInvalid = c10Extractor.calculateTripDelay(41.4878, 2.3554, '1', 10, new Date('invalid'));
    assert.strictEqual(delayInvalid.delayMins, 0);
    assert.strictEqual(delayInvalid.delayStatus, 'on_time');

    totalAssertions += 10;
  });

  // =============================================================================
  // HARNESS SUMMARY
  // =============================================================================
  console.log('\n⚔️  =========================================================================');
  console.log(`📊 TOTAL: ${totalTests} | PASSED: ${passedTests} | FAILED: ${failedTests} | ASSERTIONS: ${totalAssertions}`);
  if (failedTests > 0) {
    console.log(`❌ ${failedTests} TEST(S) FAILED. Details:`);
    for (const f of failureDetails) {
      console.log(`   - ${f.test}: ${f.error}`);
    }
  } else {
    console.log(`🎉 ALL ${totalTests} ADVERSARIAL TEST BLOCKS PASSED PERFECTLY! 🎉`);
  }
  console.log('⚔️  =========================================================================\n');
})();
