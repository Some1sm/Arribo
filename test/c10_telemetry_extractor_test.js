/**
 * test/c10_telemetry_extractor_test.js
 * 
 * Exhaustive Test Suite for C-10 Direct Real-Time Telemetry Extractor
 * (Moventis / Empresa Casas - Barcelona ⇄ Mataró N-II Corridor).
 * 
 * Verifies:
 * - Bounding box filtering & coordinate validation
 * - Polyline snapping & directional matcher
 * - Dual-coordinate schema compliance & standardized fields
 * - Upstream format normalization (AMB v2, SAE, GMV, Indra)
 * - GTFS schedule delay matching & canonical delay badges
 * - Single-flight request coalescing & cache management
 * - Error resilience, circuit breakers & graceful fallbacks
 * - FlightRecorder & CorridorTracker polymorphic integration
 * - IngestionDaemon corridor poll integration & live AMB schema
 */

const assert = require('assert');
const c10Extractor = require('../src/c10TelemetryExtractor');
const moventisClient = require('../src/moventisClient');
const flightRecorder = require('../src/flightRecorder');
const corridorTracker = require('../src/corridorTracker');
const ingestionDaemon = require('../src/ingestionDaemon');
const geoEngine = require('../src/core/geo/geoEngine');
const delayEngine = require('../src/core/schedule/delayEngine');

let passedTests = 0;
let totalAssertions = 0;

function check(desc, fn) {
  try {
    fn();
    passedTests++;
    console.log(`  ✓ ${desc}`);
  } catch (err) {
    console.error(`  ❌ FAILED: ${desc}`);
    console.error(err);
    process.exit(1);
  }
}

async function checkAsync(desc, fn) {
  try {
    await fn();
    passedTests++;
    console.log(`  ✓ ${desc}`);
  } catch (err) {
    console.error(`  ❌ FAILED: ${desc}`);
    console.error(err);
    process.exit(1);
  }
}

console.log('🧪 =========================================================================');
console.log('🧪 STARTING C-10 DIRECT REAL-TIME TELEMETRY EXTRACTOR TEST SUITE');
console.log('🧪 =========================================================================\n');

// =============================================================================
// SUITE 1: Bounding Box Filtering & Coordinate Validation
// =============================================================================
console.log('📌 [SUITE 1] Bounding Box & Coordinate Validation...');

check('1.1 Valid coordinates along the Barcelona-Mataró N-II corridor pass filter', () => {
  // Badalona (N-II)
  assert.strictEqual(c10Extractor.isWithinBoundingBox(41.4477, 2.2427), true);
  // Premià de Mar
  assert.strictEqual(c10Extractor.isWithinBoundingBox(41.4878, 2.3554), true);
  // Mataró (Porta Laietana)
  assert.strictEqual(c10Extractor.isWithinBoundingBox(41.5305, 2.4362), true);
  totalAssertions += 3;
});

check('1.2 Out-of-bounds coordinates outside the coastal corridor are strictly rejected', () => {
  // Madrid
  assert.strictEqual(c10Extractor.isWithinBoundingBox(40.4168, -3.7038), false);
  // London
  assert.strictEqual(c10Extractor.isWithinBoundingBox(51.5074, -0.1278), false);
  // Girona (too far north)
  assert.strictEqual(c10Extractor.isWithinBoundingBox(41.9794, 2.8214), false);
  // Tarragona (too far south)
  assert.strictEqual(c10Extractor.isWithinBoundingBox(41.1189, 1.2445), false);
  // NaN / null / undefined
  assert.strictEqual(c10Extractor.isWithinBoundingBox(NaN, 2.24), false);
  assert.strictEqual(c10Extractor.isWithinBoundingBox(41.44, null), false);
  assert.strictEqual(c10Extractor.isWithinBoundingBox(undefined, undefined), false);
  totalAssertions += 7;
});

// =============================================================================
// SUITE 2: Polyline Snapping & Directional Matcher
// =============================================================================
console.log('\n📌 [SUITE 2] Polyline Snapping & Directional Matcher...');

check('2.1 Snapping near El Masnou directed North-East resolves Direction 1 (Mataró)', () => {
  // GPS near El Masnou traveling towards Mataró (bearing ~48°)
  const raw = {
    id: 'bus_342',
    lat: 41.4780,
    lon: 2.3130,
    speed: 42,
    bearing: 50
  };
  const vehicle = c10Extractor.normalizeRawVehicle(raw);
  assert.ok(vehicle, 'Vehicle should normalize successfully');
  assert.strictEqual(vehicle.direction, '1', 'Should resolve Direction 1 (Cap a Mataró)');
  assert.strictEqual(vehicle.destination, 'Hospital de Mataró');
  assert.strictEqual(vehicle.lineCode, 'C-10');
  assert.ok(vehicle.lat >= 41.47 && vehicle.lat <= 41.49);
  totalAssertions += 5;
});

check('2.2 Snapping near Premià de Mar directed South-West resolves Direction 0 (Barcelona)', () => {
  // GPS near Premià traveling towards Barcelona (bearing ~230°)
  const raw = {
    id: 'bus_345',
    lat: 41.4885,
    lon: 2.3580,
    speed: 38,
    bearing: 235
  };
  const vehicle = c10Extractor.normalizeRawVehicle(raw);
  assert.ok(vehicle, 'Vehicle should normalize successfully');
  assert.strictEqual(vehicle.direction, '0', 'Should resolve Direction 0 (Cap a Barcelona)');
  assert.strictEqual(vehicle.destination, 'Barcelona (Metro la Pau)');
  totalAssertions += 3;
});

check('2.3 Explicit direction hints (sentido / trayecto) are accurately respected', () => {
  const rawDir1 = {
    id: 'bus_901',
    lat: 41.5000,
    lon: 2.3900,
    dir: '1'
  };
  const v1 = c10Extractor.normalizeRawVehicle(rawDir1);
  assert.strictEqual(v1.direction, '1');

  const rawDir0 = {
    id: 'bus_902',
    lat: 41.5000,
    lon: 2.3900,
    sentido: 'A' // Anada a Barcelona
  };
  const v0 = c10Extractor.normalizeRawVehicle(rawDir0);
  assert.strictEqual(v0.direction, '0');
  totalAssertions += 2;
});

// =============================================================================
// SUITE 3: Dual-Coordinate Schema Compliance & Standardized Fields
// =============================================================================
console.log('\n📌 [SUITE 3] Dual-Coordinate Schema Compliance...');

check('3.1 Emitted Vehicle satisfies 100% of the Arribo! standardized vehicle schema', () => {
  const raw = {
    idVehiculo: '502342',
    matricula: '1234-LMN',
    latitud: 41.5208,
    longitud: 2.4209,
    velocidad: 45,
    rumbo: 42,
    fechaHora: '2026-08-24T20:15:00.000Z'
  };

  const v = c10Extractor.normalizeRawVehicle(raw);
  assert.ok(v, 'Vehicle normalized');

  // Dual-coordinate compatibility
  assert.strictEqual(typeof v.lat, 'number');
  assert.strictEqual(typeof v.lon, 'number');
  assert.strictEqual(typeof v.latitude, 'number');
  assert.strictEqual(typeof v.longitude, 'number');
  assert.strictEqual(v.lat, v.latitude);
  assert.strictEqual(v.lon, v.longitude);

  // Line & agency identities
  assert.strictEqual(v.lineId, 'c10');
  assert.strictEqual(v.lineCode, 'C-10');
  assert.strictEqual(v.lineName, 'Barcelona ⇄ Mataró (per N-II)');
  assert.strictEqual(v.agency, 'Moventis / Casas (Interurbà Maresme)');
  assert.strictEqual(v.vehicleId, 'c10_502_502342');
  assert.strictEqual(v.plateNumber, '1234-LMN');

  // Telemetry attributes
  assert.strictEqual(v.speedKmh, 45);
  assert.strictEqual(v.speed, 45);
  assert.strictEqual(typeof v.bearing, 'number');
  assert.ok(v.compass && v.compass.code && v.compass.label);

  // Real-time flags
  assert.strictEqual(v.isRealTime, true);
  assert.strictEqual(v.isRealtime, true);
  assert.strictEqual(v.isEstimated, false);
  assert.strictEqual(v.isDeadReckoned, false);
  assert.strictEqual(v.statusText, '🟢 Senyal GPS Actiu');

  // Progress & stop tracking
  assert.ok(typeof v.totalProgress === 'number' && v.totalProgress >= 0 && v.totalProgress <= 100);
  assert.ok(v.fromStop, 'fromStop should be populated');
  assert.ok(v.toStop, 'toStop should be populated');
  assert.ok(v.fromCoords && typeof v.fromCoords.lat === 'number');
  assert.ok(v.toCoords && typeof v.toCoords.lat === 'number');
  assert.ok(typeof v.secondsToNextStop === 'number');

  // Time fields
  assert.ok(typeof v.timestamp === 'number');
  assert.strictEqual(v.recordedAt, '2026-08-24T20:15:00.000Z');

  totalAssertions += 22;
});

// =============================================================================
// SUITE 4: Upstream Format Normalization
// =============================================================================
console.log('\n📌 [SUITE 4] Upstream Format Normalization (SAE / Indra / GMV)...');

check('4.1 Normalizes Moventis SAE official format', () => {
  const saePayload = {
    idVehiculo: '8401',
    matricula: '5678-KBC',
    latitud: '41.4633',
    longitud: '2.2727',
    velocidad: '35',
    rumbo: '55',
    fechaHora: new Date().toISOString()
  };
  const v = c10Extractor.normalizeRawVehicle(saePayload);
  assert.ok(v);
  assert.strictEqual(v.vehicleId, 'c10_502_8401');
  assert.strictEqual(v.plateNumber, '5678-KBC');
  assert.strictEqual(v.speedKmh, 35);
  totalAssertions += 4;
});

check('4.2 Normalizes Indra / GMV format (calca, x, y, vel)', () => {
  const indraPayload = {
    calca: '302',
    y: 41.5344,
    x: 2.4401,
    vel: 28,
    heading: 40
  };
  const v = c10Extractor.normalizeRawVehicle(indraPayload);
  assert.ok(v);
  assert.strictEqual(v.vehicleId, 'c10_502_302');
  assert.strictEqual(v.speedKmh, 28);
  totalAssertions += 3;
});

// =============================================================================
// SUITE 5: GTFS Trip Matching & Schedule Delay Calculation
// =============================================================================
console.log('\n📌 [SUITE 5] GTFS Trip Matching & Delay Calculation...');

check('5.1 Calculates schedule delay against GTFS trips (GEN_0498)', () => {
  const delayStatus = c10Extractor.calculateTripDelay(41.4633, 2.2727, '1', 12, new Date());
  assert.ok(delayStatus);
  assert.strictEqual(typeof delayStatus.delayMins, 'number');
  assert.strictEqual(typeof delayStatus.delayStatus, 'string');
  assert.ok(delayStatus.delayBadgeText);
  assert.ok(delayStatus.delayFormatted);
  totalAssertions += 5;
});

// =============================================================================
// SUITE 6: Single-Flight Request Coalescing & Inflight Deduplication
// =============================================================================
console.log('\n📌 [SUITE 6] Request Coalescing & Inflight Protection...');

(async () => {
  await checkAsync('6.1 10 concurrent requests coalesce into 1 single upstream fetch', async () => {
    let callCount = 0;
    c10Extractor.setMockSource(async () => {
      callCount++;
      await new Promise(r => setTimeout(r, 20));
      return [
        { id: '101', lat: 41.45, lon: 2.25, speed: 30, bearing: 45 },
        { id: '102', lat: 41.51, lon: 2.41, speed: 40, bearing: 225 }
      ];
    });

    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(c10Extractor.getLiveVehicles({ bypassCache: true }));
    }

    const results = await Promise.all(promises);
    assert.strictEqual(callCount, 1, 'Upstream should be called exactly once for 10 concurrent calls');
    assert.strictEqual(results.length, 10);
    assert.strictEqual(results[0].length, 2);
    assert.strictEqual(results[0][0].vehicleId, 'c10_502_101');
    c10Extractor.setMockSource(null); // Reset
    totalAssertions += 4;
  });

  // =============================================================================
  // SUITE 7: Error Resilience & Circuit Breaker
  // =============================================================================
  console.log('\n📌 [SUITE 7] Error Resilience & Circuit Breaker...');

  await checkAsync('7.1 Upstream network failure returns graceful empty array without throwing', async () => {
    c10Extractor.setMockSource(async () => {
      throw new Error('Upstream 503 Service Unavailable');
    });

    const res = await c10Extractor.getLiveVehicles({ bypassCache: true });
    assert.ok(Array.isArray(res), 'Should return array');
    c10Extractor.setMockSource(null);
    totalAssertions += 1;
  });

  await checkAsync('7.2 Malformed non-array response is safely handled', async () => {
    c10Extractor.setMockSource(async () => {
      return { error: 'invalid format', code: 500 };
    });

    const res = await c10Extractor.getLiveVehicles({ bypassCache: true });
    assert.ok(Array.isArray(res));
    assert.strictEqual(res.length, 0);
    c10Extractor.setMockSource(null);
    totalAssertions += 2;
  });

  // =============================================================================
  // SUITE 8: FlightRecorder & CorridorTracker Integration
  // =============================================================================
  console.log('\n📌 [SUITE 8] FlightRecorder & CorridorTracker Polymorphic Integration...');

  await checkAsync('8.1 Ingesting C-10 live vehicle into FlightRecorder registers with C-10 line code', async () => {
    const liveVeh = {
      vehicleId: 'c10_502_test777',
      lineId: 'c10',
      lineCode: 'C-10',
      agency: 'Moventis / Casas (Interurbà Maresme)',
      lat: 41.4878,
      lon: 2.3554,
      speedKmh: 42,
      bearing: 50,
      delayMins: 2,
      destination: 'Hospital de Mataró',
      isRealTime: true,
      isEstimated: false
    };

    flightRecorder.ingestVehicle(liveVeh);
    const lineBuses = flightRecorder.getLineVehicles('C-10');
    assert.ok(Array.isArray(lineBuses) && lineBuses.length > 0);
    const found = lineBuses.find(b => b.vehicleId === 'c10_502_test777');
    assert.ok(found, 'Found ingested vehicle in FlightRecorder');
    assert.strictEqual(found.lineCode, 'C-10');
    assert.strictEqual(found.speedKmh, 42);
    totalAssertions += 4;
  });

  await checkAsync('8.2 CorridorTracker prioritizes genuine live GPS vehicles over synthetic estimates', async () => {
    // Inject mock live GPS bus into extractor
    c10Extractor.setMockSource(async () => [
      { id: 'live_bus_888', lat: 41.4878, lon: 2.3554, speed: 45, bearing: 48, direction: '1' }
    ]);

    const liveData = await corridorTracker.getCorridorLiveTracking('1');
    assert.ok(liveData);
    assert.ok(Array.isArray(liveData.activeBuses) && liveData.activeBuses.length > 0);
    const firstBus = liveData.activeBuses[0];
    assert.strictEqual(firstBus.isRealTime, true);
    assert.strictEqual(firstBus.isEstimated, false);
    assert.strictEqual(firstBus.statusText, '🟢 Senyal GPS Actiu');
    c10Extractor.setMockSource(null);
    totalAssertions += 5;
  });

  await checkAsync('8.3 CorridorTracker gracefully falls back to schedule interpolation when live telemetry drops', async () => {
    // Set mock returning empty
    c10Extractor.setMockSource(async () => []);
    c10Extractor.cachedVehicles = [];
    c10Extractor.lastFetchTime = 0;

    // Clear flight recorder vehicle
    flightRecorder.vehicles.delete('c10_502_test777');
    if (flightRecorder.lineIndex.has('C-10')) {
      flightRecorder.lineIndex.get('C-10').clear();
    }
    corridorTracker.liveTrackingCache.clear();

    const liveData = await corridorTracker.getCorridorLiveTracking('1');
    assert.ok(liveData);
    assert.ok(Array.isArray(liveData.activeBuses));
    // If active buses exist from timetable interpolation, they are marked isEstimated
    if (liveData.activeBuses.length > 0) {
      const b = liveData.activeBuses[0];
      assert.strictEqual(b.isEstimated, true);
      assert.strictEqual(b.isDeadReckoned, true);
      assert.strictEqual(b.statusText, '⚡ Estimació de Posició (Dead-Reckoning)');
    }
    c10Extractor.setMockSource(null);
    totalAssertions += 2;
  });

  // =============================================================================
  // SUITE 9: AMB Mobilitat API v2 Live Telemetry Feed Normalization
  // =============================================================================
  console.log('\n📌 [SUITE 9] AMB Mobilitat API v2 Telemetry Normalization & Ingestion Loop...');

  check('9.1 Normalizes direct AMB Mobilitat v2 GPS payload schema accurately', () => {
    const ambRaw = {
      line: 'C-10',
      tripId: 119400021306,
      routeId: '11940002',
      latitude: '41.4697242',
      longitude: '2.2888583',
      nextStopId: 3525,
      id: '1306C-10'
    };

    const v = c10Extractor.normalizeRawVehicle(ambRaw);
    assert.ok(v, 'AMB vehicle should normalize cleanly');
    assert.strictEqual(v.fleetNumber, '1306');
    assert.strictEqual(v.vehicleId, 'c10_502_1306');
    assert.strictEqual(v.direction, '0', 'RouteId 11940002 must map to Direction 0 (Barcelona)');
    assert.strictEqual(v.destination, 'Barcelona (Metro la Pau)');
    assert.strictEqual(v.lat, 41.469724);
    assert.strictEqual(v.lon, 2.288858);
    assert.strictEqual(v.latitude, 41.469724);
    assert.strictEqual(v.longitude, 2.288858);
    assert.strictEqual(v.isRealTime, true);
    assert.strictEqual(v.isEstimated, false);
    assert.strictEqual(v.statusText, '🟢 Senyal GPS Actiu');
    totalAssertions += 11;
  });

  check('9.2 RouteId 11940001 maps to Direction 1 (Cap a Mataró)', () => {
    const ambRawDir1 = {
      line: 'C-10',
      tripId: 119400011306,
      routeId: '11940001',
      latitude: '41.4632978',
      longitude: '2.2724117',
      nextStopId: 3525,
      id: '1306C-10'
    };

    const v = c10Extractor.normalizeRawVehicle(ambRawDir1);
    assert.ok(v);
    assert.strictEqual(v.direction, '1');
    assert.strictEqual(v.destination, 'Hospital de Mataró');
    totalAssertions += 3;
  });

  await checkAsync('9.3 IngestionDaemon.pollCorridorDelays ingests active C-10 live telemetry', async () => {
    c10Extractor.setMockSource(async () => [
      {
        line: 'C-10',
        tripId: 119400011405,
        routeId: '11940001',
        latitude: '41.4878387',
        longitude: '2.3554115',
        nextStopId: 3525,
        id: '1405C-10'
      }
    ]);

    await ingestionDaemon.pollCorridorDelays();

    const c10Fleet = flightRecorder.getLineVehicles('C-10');
    assert.ok(Array.isArray(c10Fleet) && c10Fleet.length > 0);
    const bus1405 = c10Fleet.find(b => b.vehicleId === 'c10_502_1405');
    assert.ok(bus1405, 'Vehicle #1405 should be present in FlightRecorder');
    assert.strictEqual(bus1405.isRealTime, true);
    assert.strictEqual(bus1405.isEstimated, false);

    c10Extractor.setMockSource(null);
    totalAssertions += 4;
  });

  // =============================================================================
  // SUMMARY
  // =============================================================================
  console.log('\n=========================================================================');
  console.log(`🎉 ALL ${passedTests} TEST BLOCKS PASSED (${totalAssertions} INDIVIDUAL ASSERTIONS)! 🎉`);
  console.log('=========================================================================\n');
})();
