/**
 * telemetry_identity_stitching_test.js
 * 
 * Verifies Trajectory Continuity & Bus Identity Stitching in MataroTracker:
 * 1. Anonymous calca drop bug (SIRI sending <VehicleRef>Bus</VehicleRef>):
 *    Anonymous live fix correctly inherits physical vehicle ID from vehicleHistory,
 *    remains live GPS, and prevents phantom dead-reckoned duplicates.
 * 2. Bus Bunching ('en trenet') Preservation:
 *    Two physical buses close together (10-30m) in traffic jams are both preserved as live GPS.
 * 3. Bunched buses where one drops identity:
 *    Only the unassigned historical vehicle is stitched; the other named bus is untouched.
 * 4. Genuine GPS dead-zone loss:
 *    When a bus stops transmitting completely, it is correctly dead-reckoned up to 90s.
 * 5. Direction & corridor discrimination:
 *    Multiple anonymous buses on opposing directions stitch to their respective trajectories.
 */

const assert = require('assert');
const mataroTracker = require('../src/mataroTracker');
const geoEngine = require('../src/core/geo/geoEngine');
const mataroSchedules = require('../src/data/mataroSchedules');
const scheduleSynthesizer = require('../src/core/schedule/scheduleSynthesizer');

async function runTests() {
  console.log('--- Starting Telemetry Identity Stitching & Anti-Duplication Tests ---');

  const routeL1 = mataroTracker.routesData['1'] && mataroTracker.routesData['1'][0];
  const stopsL1 = routeL1 && routeL1.stops;
  assert.ok(routeL1 && routeL1.coords && routeL1.coords.length > 5, 'Route L1 data must be loaded');

  const poly0 = routeL1.coords.map(c => ({
    lat: parseFloat(c.Latitude !== undefined ? c.Latitude : c.lat),
    lon: parseFloat(c.Longitude !== undefined ? c.Longitude : c.lon)
  }));

  // Clean vehicleHistory before each test section
  mataroTracker.vehicleHistory.clear();
  mataroTracker.invalidateLineDetailsCache();

  // =========================================================================
  // Test 1: Anonymous Calca Drop (The User's Bug)
  // =========================================================================
  console.log('📌 Test 1: Anonymous Calca Drop & Trajectory Stitching...');
  {
    const now = Date.now();
    const pt0 = poly0[5]; // Historical position
    const pt1 = poly0[7]; // 15s later, slightly further along polyline

    // 1. Bus #2683 was previously tracked on L1 direction 0
    mataroTracker.vehicleHistory.set('2683', {
      vehicleId: '2683',
      lineId: '1',
      direction: '0',
      lat: pt0.lat,
      lon: pt0.lon,
      bearing: 90,
      speedKmh: 24,
      delayMins: 2,
      lastSeen: now - 18000, // seen 18s ago
      directionName: 'Estació Rodalies',
      origin: 'Mataró Parc',
      destination: 'Estació Rodalies'
    });

    // 2. Upstream SIRI now sends live GPS but with dropped vehicleId 'Bus'
    const anonLiveFix = [{
      vehicleId: 'Bus',
      lineId: '1',
      lineName: 'Línia 1',
      directionName: 'Estació Rodalies',
      lat: pt1.lat,
      lon: pt1.lon,
      bearing: 92,
      speedKmh: 22,
      delayMins: 2,
      recordedAt: new Date(now).toISOString(),
      isEstimated: false,
      timestamp: now
    }];

    // Execute stitching
    const stitched = mataroTracker.stitchAnonymousVehicles(anonLiveFix, '1', mataroTracker.routesData['1'], now);
    assert.strictEqual(stitched[0].vehicleId, '2683', 'Anonymous fix must inherit vehicleId #2683');
    assert.strictEqual(stitched[0].stitchedFromHistory, true, 'Fix must be flagged as stitchedFromHistory');

    // Run full dead-reckoning processor
    const result = mataroTracker.processBusesWithDeadReckoning(stitched, routeL1, stopsL1, '0', stitched);

    // Assertions:
    // a) There must be exactly ONE bus for #2683
    const buses2683 = result.filter(b => String(b.vehicleId) === '2683');
    assert.strictEqual(buses2683.length, 1, 'Must contain exactly 1 bus for #2683 (zero duplicate markers)');

    // b) It must be a live GPS vehicle, NOT estimated
    assert.strictEqual(buses2683[0].isRealTime, true, 'Stitched vehicle must remain real-time live GPS');
    assert.strictEqual(buses2683[0].isEstimated, false, 'Stitched vehicle must NOT be estimated');

    // c) Zero dead-reckoned clone buses
    const estBuses = result.filter(b => b.isEstimated);
    assert.strictEqual(estBuses.length, 0, 'No dead-reckoned duplicate buses should be created');

    console.log('  ✓ Test 1 Passed: Anonymous bus #2683 stitched successfully, zero duplicate markers generated.');
  }

  // =========================================================================
  // Test 2: Legitimate Bus Bunching ('En Trenet') Preservation
  // =========================================================================
  console.log('📌 Test 2: Bus Bunching (2 Buses 25m Apart in Traffic) Preservation...');
  {
    mataroTracker.vehicleHistory.clear();
    mataroTracker.invalidateLineDetailsCache();

    const now = Date.now();
    const ptA = poly0[10];
    // ptB is ~25 meters from ptA
    const ptB = {
      lat: ptA.lat + 0.00020,
      lon: ptA.lon + 0.00010
    };
    const distM = geoEngine.calculateDistanceMeters(ptA.lat, ptA.lon, ptB.lat, ptB.lon);
    assert.ok(distM < 50, `Distance between bunched buses must be < 50m (actual: ${distM.toFixed(1)}m)`);

    const bunchedLiveBuses = [
      {
        vehicleId: '2683',
        lineId: '1',
        direction: '0',
        directionName: 'Estació Rodalies',
        lat: ptA.lat,
        lon: ptA.lon,
        bearing: 90,
        speedKmh: 5, // Crawling in traffic jam
        delayMins: 8,
        recordedAt: new Date(now).toISOString(),
        isEstimated: false,
        timestamp: now
      },
      {
        vehicleId: '2663',
        lineId: '1',
        direction: '0',
        directionName: 'Estació Rodalies',
        lat: ptB.lat,
        lon: ptB.lon,
        bearing: 90,
        speedKmh: 4, // Crawling behind 2683
        delayMins: 12,
        recordedAt: new Date(now).toISOString(),
        isEstimated: false,
        timestamp: now
      }
    ];

    const result = mataroTracker.processBusesWithDeadReckoning(bunchedLiveBuses, routeL1, stopsL1, '0', bunchedLiveBuses);

    // Both physical buses must be preserved!
    assert.strictEqual(result.length, 2, 'Both bunched physical buses must be present');
    const has2683 = result.some(b => String(b.vehicleId) === '2683' && b.isRealTime);
    const has2663 = result.some(b => String(b.vehicleId) === '2663' && b.isRealTime);
    assert.strictEqual(has2683, true, 'Bus #2683 must be preserved as live GPS');
    assert.strictEqual(has2663, true, 'Bus #2663 must be preserved as live GPS');

    console.log('  ✓ Test 2 Passed: Legitimate bunched buses (25m apart) both preserved with real-time GPS.');
  }

  // =========================================================================
  // Test 3: Bunched Buses with One Anonymous Fix
  // =========================================================================
  console.log('📌 Test 3: Bunched Buses with One Anonymous Fix...');
  {
    mataroTracker.vehicleHistory.clear();
    mataroTracker.invalidateLineDetailsCache();

    const now = Date.now();
    const ptA = poly0[12];
    const ptB = poly0[13];

    // Historical tracking had both 2683 and 2663
    mataroTracker.vehicleHistory.set('2683', {
      vehicleId: '2683',
      lineId: '1',
      direction: '0',
      lat: ptA.lat,
      lon: ptA.lon,
      bearing: 85,
      speedKmh: 8,
      lastSeen: now - 15000
    });
    mataroTracker.vehicleHistory.set('2663', {
      vehicleId: '2663',
      lineId: '1',
      direction: '0',
      lat: ptB.lat,
      lon: ptB.lon,
      bearing: 85,
      speedKmh: 7,
      lastSeen: now - 15000
    });

    // In current poll, 2663 sends vehicleId: '2663', while 2683 sends vehicleId: 'Bus'
    const liveBatch = [
      {
        vehicleId: '2663',
        lineId: '1',
        direction: '0',
        lat: ptB.lat + 0.00005,
        lon: ptB.lon + 0.00005,
        bearing: 85,
        speedKmh: 8,
        recordedAt: new Date(now).toISOString(),
        isEstimated: false,
        timestamp: now
      },
      {
        vehicleId: 'Bus', // Anonymous 2683
        lineId: '1',
        direction: '0',
        lat: ptA.lat + 0.00005,
        lon: ptA.lon + 0.00005,
        bearing: 85,
        speedKmh: 8,
        recordedAt: new Date(now).toISOString(),
        isEstimated: false,
        timestamp: now
      }
    ];

    const stitched = mataroTracker.stitchAnonymousVehicles(liveBatch, '1', mataroTracker.routesData['1'], now);
    assert.strictEqual(stitched.find(b => b.stitchedFromHistory)?.vehicleId, '2683', 'Anonymous bus must stitch to #2683 without stealing #2663');
    assert.strictEqual(stitched.find(b => b.vehicleId === '2663')?.stitchedFromHistory, undefined, '#2663 must keep its original identity');

    const result = mataroTracker.processBusesWithDeadReckoning(stitched, routeL1, stopsL1, '0', stitched);
    assert.strictEqual(result.length, 2, 'Both buses must be present');
    assert.strictEqual(result.filter(b => b.isEstimated).length, 0, 'Zero estimated duplicates');

    console.log('  ✓ Test 3 Passed: Bunched bus correctly inherits #2683 without conflicting with active #2663.');
  }

  // =========================================================================
  // Test 4: Genuine GPS Signal Loss in Dead Zone
  // =========================================================================
  console.log('📌 Test 4: Genuine GPS Signal Loss (Dead-Reckoning Extrapolation)...');
  {
    mataroTracker.vehicleHistory.clear();
    mataroTracker.invalidateLineDetailsCache();

    const now = Date.now();
    const pt = poly0[8];

    // Bus #2683 was seen 30s ago, but is NOT sending any GPS currently (empty live list)
    mataroTracker.vehicleHistory.set('2683', {
      vehicleId: '2683',
      lineId: '1',
      direction: '0',
      lat: pt.lat,
      lon: pt.lon,
      bearing: 90,
      speedKmh: 25,
      delayMins: 1,
      lastSeen: now - 30000 // 30s ago
    });

    const result = mataroTracker.processBusesWithDeadReckoning([], routeL1, stopsL1, '0', []);
    assert.strictEqual(result.length, 1, 'Genuine missing bus must be dead-reckoned');
    assert.strictEqual(result[0].vehicleId, '2683', 'Dead-reckoned bus must have ID 2683');
    assert.strictEqual(result[0].isEstimated, true, 'Dead-reckoned bus must be marked as estimated');

    // Case 4b: Signal lost > 90 seconds ago -> must NOT dead-reckon
    mataroTracker.vehicleHistory.set('2683', {
      vehicleId: '2683',
      lineId: '1',
      direction: '0',
      lat: pt.lat,
      lon: pt.lon,
      bearing: 90,
      speedKmh: 25,
      lastSeen: now - 95000 // 95s ago (> 90s ceiling)
    });

    const resultOld = mataroTracker.processBusesWithDeadReckoning([], routeL1, stopsL1, '0', []);
    assert.strictEqual(resultOld.length, 0, 'Bus lost >90s must NOT be dead-reckoned');

    console.log('  ✓ Test 4 Passed: Genuine GPS dead zones extrapolate for up to 90s, then expire cleanly.');
  }

  // =========================================================================
  // Test 5: Opposing Directions Trajectory Discrimination
  // =========================================================================
  console.log('📌 Test 5: Opposing Direction Trajectory Discrimination...');
  {
    mataroTracker.vehicleHistory.clear();
    mataroTracker.invalidateLineDetailsCache();

    const routes = mataroTracker.routesData['1'];
    assert.ok(routes && routes.length >= 2, 'Line 1 must have 2 directions');
    const polyDir0 = routes[0].coords.map(c => ({ lat: parseFloat(c.Latitude), lon: parseFloat(c.Longitude) }));
    const polyDir1 = routes[1].coords.map(c => ({ lat: parseFloat(c.Latitude), lon: parseFloat(c.Longitude) }));

    const now = Date.now();
    const ptDir0 = polyDir0[6];
    const ptDir1 = polyDir1[6];

    // History: 2683 on dir 0, 2663 on dir 1
    mataroTracker.vehicleHistory.set('2683', {
      vehicleId: '2683',
      lineId: '1',
      direction: '0',
      directionName: routes[0].name,
      lat: ptDir0.lat,
      lon: ptDir0.lon,
      bearing: 90,
      speedKmh: 20,
      lastSeen: now - 20000
    });
    mataroTracker.vehicleHistory.set('2663', {
      vehicleId: '2663',
      lineId: '1',
      direction: '1',
      directionName: routes[1].name,
      lat: ptDir1.lat,
      lon: ptDir1.lon,
      bearing: 270,
      speedKmh: 20,
      lastSeen: now - 20000
    });

    // Both send anonymous pings near their respective corridors
    const anonBatch = [
      {
        vehicleId: 'Bus',
        lineId: '1',
        directionName: routes[1].name,
        destination: routes[1].name,
        lat: ptDir1.lat + 0.0001,
        lon: ptDir1.lon + 0.0001,
        bearing: 270,
        speedKmh: 20,
        recordedAt: new Date(now).toISOString(),
        timestamp: now
      },
      {
        vehicleId: 'Bus',
        lineId: '1',
        directionName: routes[0].name,
        destination: routes[0].name,
        lat: ptDir0.lat + 0.0001,
        lon: ptDir0.lon + 0.0001,
        bearing: 90,
        speedKmh: 20,
        recordedAt: new Date(now).toISOString(),
        timestamp: now
      }
    ];

    const stitched = mataroTracker.stitchAnonymousVehicles(anonBatch, '1', routes, now);
    const busForDir0 = stitched.find(b => b.directionName === routes[0].name);
    const busForDir1 = stitched.find(b => b.directionName === routes[1].name);

    assert.strictEqual(busForDir0.vehicleId, '2683', 'Direction 0 anonymous bus must stitch to #2683');
    assert.strictEqual(busForDir1.vehicleId, '2663', 'Direction 1 anonymous bus must stitch to #2663');

    console.log('  ✓ Test 5 Passed: Cross-direction anonymous buses correctly matched to respective corridors.');
  }

  // =========================================================================
  // Test 6: Spatial Route Matching Without Direction Text (Prevents Teleporting)
  // =========================================================================
  console.log('📌 Test 6: Spatial Route Matching Without Direction Text (Cerdanyola vs Via Europa)...');
  {
    const routes = mataroTracker.routesData['1'];
    // Bus at Gatassa (lat: 41.5377, lon: 2.42801) has NO direction text
    const busGatassa = {
      vehicleId: '2663',
      lineId: '1',
      lat: 41.5377,
      lon: 2.42801,
      speedKmh: 20
    };
    // Bus at Caputxins (lat: 41.5511, lon: 2.44606) has NO direction text
    const busCaputxins = {
      vehicleId: '2683',
      lineId: '1',
      lat: 41.5511,
      lon: 2.44606,
      speedKmh: 20
    };

    const matchGatassa = mataroTracker.matchVehicleToRouteIndex(busGatassa, routes);
    const matchCaputxins = mataroTracker.matchVehicleToRouteIndex(busCaputxins, routes);

    assert.strictEqual(matchGatassa, 1, 'Bus in Cerdanyola/Gatassa must match Direction 1 (Rodalies -> Hospital)');
    assert.strictEqual(matchCaputxins, 0, 'Bus at Caputxins must match Direction 0 (Hospital -> Rodalies)');

    console.log('  ✓ Test 6 Passed: Spatial polyline matching correctly identifies route index with zero direction text.');
  }

  // =========================================================================
  // Test 7: Stop 1015 (El Cargol) Official Timetable Calibration & Deduplication
  // =========================================================================
  console.log('📌 Test 7: Stop 1015 (El Cargol) Official Timetable Calibration & Deduplication...');
  {
    const travelSecSun = mataroSchedules.getStopTravelTime('1', '12', '1015', 'sunday');
    assert.strictEqual(travelSecSun, 1500, 'Stop 1015 (El Cargol) Sunday travelSec must be 1500s (25 min from Hospital)');

    // The weekday grid previously read 1188s here, which is impossible: the
    // stop before it (1014) sits at 1500s, so the bus cannot reach El Cargol
    // five minutes BEFORE it left the stop before. 1188 was a corrupt value;
    // the calibrated weekday step puts El Cargol at 1620s.
    const travelSecWk = mataroSchedules.getStopTravelTime('1', '12', '1015', 'weekday');
    assert.strictEqual(travelSecWk, 1620, 'Stop 1015 (El Cargol) Weekday travelSec must be 1620s (27 min from Hospital)');
    assert(
      travelSecWk >= mataroSchedules.getStopTravelTime('1', '12', '1014', 'weekday'),
      'El Cargol must not precede the stop before it on the weekday grid'
    );

    // 13:53 Hospital departure + 1500s -> 14:18:00
    const targetDate = new Date('2026-09-20T14:09:00+02:00'); // Sunday at 14:09
    const liveBus = {
      lineId: '1',
      destination: 'Rodalies',
      directionId: '0',
      vehicleId: '2683',
      departureTime: '14:23',
      scheduledTime: '14:18',
      expectedIso: '2026-09-20T12:23:00.000Z',
      aimedIso: '2026-09-20T12:18:00.000Z',
      minutesAway: 14,
      isRealTime: true,
      delayMins: 5
    };

    const compiled = scheduleSynthesizer.compileStopDepartures({
      baseDeparturesToday: ['13:53', '14:28', '15:03'],
      stopTravelSec: 1500,
      liveDepartures: [liveBus],
      duplicateWindowMinutes: 8,
      dateObj: targetDate,
      limit: 5
    });

    // Check that there is NO phantom 14:12 departure
    const has1412 = compiled.some(d => d.departureTime === '14:12' || d.scheduledTime === '14:12');
    assert.strictEqual(has1412, false, 'Must NOT contain phantom 14:12 departure');

    // Check that the live bus is present and has official time 14:18
    const liveMatch = compiled.find(d => d.isRealTime);
    assert(liveMatch, 'Live bus must be present');
    assert.strictEqual(liveMatch.departureTime, '14:23');
    assert.strictEqual(liveMatch.scheduledTime, '14:18');

    // Check that the next departure is the 14:28 trip -> 14:53 (not duplicated with 14:18)
    const nextTrip = compiled.find(d => !d.isRealTime);
    assert(nextTrip, 'Next scheduled trip must be present');
    assert.strictEqual(nextTrip.departureTime, '14:53');
    assert.strictEqual(nextTrip.scheduledTime, '14:53');

    // Total departures for these 2 trips must be exactly 2 (zero duplicates)
    assert.strictEqual(compiled.length, 3, 'Must have 1 live trip + 2 future scheduled trips');

    console.log('  ✓ Test 7 Passed: Authoritative passing time 14:18 verified and live trip deduplication confirmed with zero phantoms.');
  }

  // Clean up
  mataroTracker.vehicleHistory.clear();
  mataroTracker.invalidateLineDetailsCache();

  console.log('\n========================================================');
  console.log('🎉 ALL TELEMETRY IDENTITY STITCHING TESTS PASSED (7/7)!');
  console.log('========================================================\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
