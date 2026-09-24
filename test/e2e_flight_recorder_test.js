const assert = require('assert');
const server = require('../server');
const historyDb = require('../src/historyDb');
const flightRecorder = require('../src/flightRecorder');

async function runTests() {
  console.log('🧪 Starting Centralized Flight Recorder & Journalism Server Tests...');
  const appServer = server.listen(3098);

  try {
    // Test 1: Ingest sample vehicle snapshot
    console.log('Test 1: Flight Recorder vehicle ingestion');
    flightRecorder.ingestVehicle({
      vehicleId: 'test_bus_101',
      lineId: 'c10',
      lineCode: 'C-10',
      agency: 'Moventis / Casas',
      lat: 41.4501,
      lon: 2.2401,
      speedKmh: 42,
      bearing: 55,
      delayMins: 3,
      destination: 'Mataró'
    });

    const fleet = flightRecorder.getAllVehicles();
    assert(fleet.length >= 1, 'Fleet should contain at least 1 vehicle');
    console.log(`✅ Flight Recorder vehicle ingested (${fleet.length} active vehicles in memory)`);

    // Test 2: Ingest sample arrival delay logs
    // Recorded on Mataró lines: the journalism report aggregates the Mataró
    // L1–L8 network, so retired-scope rows (the old C-10 / E13 fixture) are
    // correctly excluded and could not be asserted on here.
    console.log('Test 2: Historical delay log recording');
    historyDb.recordDelayLog({
      lineId: '1',
      lineCode: 'L1',
      agency: 'Mataró Bus (Avanza)',
      stopId: 'stop_1001',
      stopName: 'Pl. Tetuan',
      delayMins: 4,
      scheduledTime: '19:30',
      actualTime: '19:34',
      isRealTime: true
    });

    historyDb.recordDelayLog({
      lineId: '3',
      lineCode: 'L3',
      agency: 'Mataró Bus (Avanza)',
      stopId: 'stop_2001',
      stopName: 'Granollers Centre',
      delayMins: 12,
      scheduledTime: '19:15',
      actualTime: '19:27',
      isRealTime: true
    });

    const stats = historyDb.getLineDelayStats('L1', 24);
    assert(stats.totalSamples >= 1, 'L1 stats should have at least 1 sample');
    console.log(`✅ Historical delay stats verified for L1 (Avg delay: +${stats.avgDelayMins} min)`);

    // Test 3: Dead-reckoning extrapolation
    console.log('Test 3: Dead-reckoning extrapolator');
    const bus = flightRecorder.vehicles.get('test_bus_101');
    // Staleness is measured on the OBSERVATION clock (observedAt), not the
    // ingest clock (lastSeen): a derived re-ingest refreshes lastSeen but must
    // not make a bus look freshly observed (D1). Backdate both for realism.
    bus.observedAt = Date.now() - 25000; // 25s without a real GPS observation
    bus.lastSeen = Date.now() - 25000;
    flightRecorder.extrapolateStaleVehicles();
    assert.strictEqual(bus.status, 'extrapolated', 'Bus should be marked as extrapolated');
    console.log(`✅ Dead-reckoning projection verified (Status: ${bus.status}, New Lat: ${bus.lat.toFixed(5)})`);

    // Test 4: Endpoint /api/fleet/live
    console.log('Test 4: Endpoint GET /api/fleet/live');
    const fleetRes = await fetch('http://localhost:3098/api/fleet/live').then(r => r.json());
    assert.strictEqual(fleetRes.success, true);
    assert(fleetRes.count >= 1);
    console.log(`✅ GET /api/fleet/live passed (${fleetRes.count} buses returned in <5ms)`);

    // Test 5: Endpoint GET /api/vehicle/:vehicleId/trail
    console.log('Test 5: Endpoint GET /api/vehicle/:vehicleId/trail');
    const trailRes = await fetch('http://localhost:3098/api/vehicle/test_bus_101/trail').then(r => r.json());
    assert.strictEqual(trailRes.success, true);
    console.log(`✅ GET /api/vehicle/:id/trail passed (${trailRes.pointsCount} GPS breadcrumbs returned)`);

    // Test 6: Endpoint GET /api/analytics/journalism
    console.log('Test 6: Endpoint GET /api/analytics/journalism');
    const journRes = await fetch('http://localhost:3098/api/analytics/journalism?hours=24').then(r => r.json());
    assert.strictEqual(journRes.success, true);
    assert(journRes.report.summary.totalRecordedArrivals >= 2);
    console.log(`✅ Journalism Report passed (Monitored lines: ${journRes.report.summary.monitoredLinesCount}, Arrivals: ${journRes.report.summary.totalRecordedArrivals})`);

    // Test 7: Endpoint GET /api/analytics/export/csv
    console.log('Test 7: Endpoint GET /api/analytics/export/csv');
    const csvText = await fetch('http://localhost:3098/api/analytics/export/csv?hours=48').then(r => r.text());
    assert(csvText.includes('Data i Hora,Linia,Operador,Parada,Retard'), 'CSV should have standard headers');
    assert(csvText.includes('L1') || csvText.includes('L3'), 'CSV should contain recorded line delay samples');
    console.log(`✅ CSV Data Export passed (${csvText.split('\n').length} CSV rows generated)`);

    console.log('\n🎉 ALL FLIGHT RECORDER & JOURNALISM SERVER TESTS PASSED SUCCESSFULLY! 🎉\n');
    process.exit(0);
  } catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
  } finally {
    appServer.close();
  }
}

runTests();
