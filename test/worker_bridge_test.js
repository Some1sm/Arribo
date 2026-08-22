const assert = require('assert');
const path = require('path');
const { WorkerBridge } = require('../src/core/WorkerBridge');
const flightRecorder = require('../src/flightRecorder');
const reportCacheService = require('../src/reportCacheService');

async function testWorkerBridge() {
  console.log('🧪 Testing WorkerBridge & IngestionWorker IPC lifecycle...');

  // 1. Test FlightRecorder syncFleetFromWorker
  console.log('1. Testing flightRecorder.syncFleetFromWorker...');
  const mockVehicles = [
    {
      vehicleId: 'test_bus_1',
      lineId: 'c10',
      lineCode: 'C-10',
      agency: 'Moventis',
      lat: 41.5381,
      lon: 2.4447,
      speedKmh: 42,
      bearing: 180,
      delayMins: 3,
      destination: 'Barcelona',
      isRealTime: true,
      status: 'active'
    },
    {
      vehicleId: 'test_bus_2',
      lineId: '8',
      lineCode: 'L8',
      agency: 'Mataró Bus',
      lat: 41.5420,
      lon: 2.4400,
      speedKmh: 20,
      bearing: 90,
      delayMins: 0,
      destination: 'Hospital',
      isRealTime: true,
      status: 'active'
    }
  ];

  const t0 = performance.now();
  flightRecorder.syncFleetFromWorker(mockVehicles);
  const syncDuration = performance.now() - t0;
  console.log(`   ⚡ syncFleetFromWorker duration: ${syncDuration.toFixed(4)}ms (Target < 0.05ms)`);

  const allVehicles = flightRecorder.getAllVehicles();
  assert(allVehicles.length >= 2, 'Should contain at least 2 vehicles');
  const c10Vehicles = flightRecorder.getLineVehicles('C-10');
  assert.strictEqual(c10Vehicles.length, 1, 'Should find C-10 vehicle');
  assert.strictEqual(c10Vehicles[0].vehicleId, 'test_bus_1');
  const l8Vehicles = flightRecorder.getLineVehicles('L8');
  assert.strictEqual(l8Vehicles.length, 1, 'Should find L8 vehicle');
  console.log('   ✅ flightRecorder syncFleetFromWorker verified.');

  // 2. Test ReportCacheService updateMemoryCache
  console.log('2. Testing reportCacheService.updateMemoryCache...');
  const mockReport = {
    summary: { totalArrivals: 999, monitoredLinesCount: 42 },
    rankingMostDelayed: [{ lineCode: 'C-10', avgDelayMinutes: 5.2 }],
    meta: { timeframeHours: 24, generatedAt: new Date().toISOString() }
  };
  reportCacheService.updateMemoryCache(24, mockReport);
  const cached24 = await reportCacheService.getLatestReport(24);
  assert.deepStrictEqual(cached24.summary.totalArrivals, 999);
  assert.deepStrictEqual(cached24.rankingMostDelayed[0].lineCode, 'C-10');
  console.log('   ✅ reportCacheService updateMemoryCache verified.');

  // 3. Test WorkerBridge supervisor lifecycle and IPC
  console.log('3. Testing WorkerBridge supervisor lifecycle...');
  const bridge = new WorkerBridge({
    pingIntervalMs: 2000,
    pingTimeoutMs: 5000,
    baseBackoffMs: 500,
    maxBackoffMs: 2000
  });

  assert.strictEqual(bridge.isHealthy, false, 'Initial bridge should not be healthy');
  assert.strictEqual(bridge.pid, null, 'Initial PID should be null');
  assert.strictEqual(bridge.restarts, 0, 'Initial restarts should be 0');

  console.log('   Spawning worker process...');
  bridge.start();

  // Wait for WORKER_READY event
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Worker did not send WORKER_READY in time')), 10000);
    bridge.once('ready', (payload) => {
      clearTimeout(timeout);
      console.log('   ✅ Received WORKER_READY event from worker process (PID:', bridge.pid, ')');
      resolve(payload);
    });
  });

  assert.strictEqual(bridge.isHealthy, true, 'Bridge should be marked healthy');
  assert(bridge.pid > 0, 'Worker PID should be a valid positive integer');
  assert(bridge.lastHeartbeat > 0, 'lastHeartbeat should be recorded');

  // Test PING / PONG
  console.log('4. Testing PING / PONG heartbeat...');
  const pongReceived = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('PONG not received in time')), 5000);
    bridge.once('pong', (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
    bridge.send('PING');
  });

  assert(pongReceived.timestamp > 0, 'PONG should contain timestamp');
  assert(pongReceived.pid === bridge.pid, 'PONG PID should match');
  console.log('   ✅ PING/PONG heartbeat round-trip verified (Worker uptime:', Math.round(pongReceived.uptime), 's).');

  // Test Status / Metrics
  const status = bridge.getStatus();
  assert.strictEqual(status.isHealthy, true);
  assert.strictEqual(status.isRunning, true);
  assert.strictEqual(status.pid, bridge.pid);
  console.log('   ✅ getStatus() diagnostics verified:', JSON.stringify(status));

  // Test Graceful Shutdown
  console.log('5. Testing graceful shutdown...');
  const shutdownStart = Date.now();
  await bridge.shutdown(4000);
  const shutdownDuration = Date.now() - shutdownStart;
  console.log(`   ⚡ Graceful shutdown completed in ${shutdownDuration}ms.`);
  assert.strictEqual(bridge.isHealthy, false, 'Bridge should be marked unhealthy after shutdown');
  assert.strictEqual(bridge.pid, null, 'Worker PID should be null after shutdown');
  console.log('   ✅ Graceful shutdown verified.');

  console.log('\n🎉 ALL WORKER BRIDGE & IPC TESTS PASSED PERFECTLY!\n');
}

testWorkerBridge()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('❌ Test failed:', err);
    process.exit(1);
  });
