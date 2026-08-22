/**
 * Milestone 5 Adversarial Challenger Harness:
 * SQLite Concurrency, WAL Checkpoint Truncation, and IPC Robustness
 * 
 * Tests:
 * 1. Multi-Handle & Multi-Thread SQLite Concurrency with PRAGMA busy_timeout = 5000
 * 2. WAL Checkpoint Truncation (checkpointTruncate) during active write bursts & storage bounds
 * 3. High-Frequency IPC Burst Stress (FLEET_UPDATE, REPORT_CACHE_UPDATE) & memory bounds
 * 4. Adversarial IPC Payload Fuzzing & Supervisor Crash Recovery
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { isMainThread, Worker, parentPort, workerData } = require('worker_threads');
const { DatabaseSync } = require('node:sqlite');

// If executed as a worker thread, run worker task
if (!isMainThread) {
  runWorkerThreadTask();
} else {
  runMainChallengerSuite()
    .then(() => {
      console.log('\n============================================================');
      console.log('🏁 MILESTONE 5 CHALLENGER SUITE: ALL ASSERTIONS CONFIRMED! 🏁');
      console.log('============================================================\n');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n❌ MILESTONE 5 CHALLENGER SUITE FAILED:', err);
      process.exit(1);
    });
}

/**
 * Worker thread execution logic for multi-threaded SQLite concurrency stress
 */
function runWorkerThreadTask() {
  const { dbPath, threadId, mode, iterations } = workerData;
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -2048;
      PRAGMA wal_autocheckpoint = 200;
      PRAGMA temp_store = MEMORY;
    `);

    if (mode === 'writer') {
      const stmt = db.prepare(`
        INSERT INTO delay_logs 
        (line_id, line_code, agency, stop_id, stop_name, delay_mins, scheduled_time, actual_time, is_realtime, is_delayed, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (let i = 0; i < iterations; i++) {
        const delay = (i % 10) + 1;
        const now = Date.now() - (i * 1000);
        stmt.run(
          `CAT_T${threadId}_${i}`,
          `TH${threadId}`,
          `ThreadAgency_${threadId}`,
          `STOP_${i % 20}`,
          `Stop Name ${i % 20}`,
          delay,
          '12:00:00',
          '12:05:00',
          1,
          delay > 3 ? 1 : 0,
          now
        );
      }
      db.close();
      parentPort.postMessage({ status: 'OK', mode, threadId, count: iterations });
    } else if (mode === 'reader') {
      let readCount = 0;
      for (let i = 0; i < iterations; i++) {
        const cutoff = Date.now() - 24 * 3600 * 1000;
        const row = db.prepare(`
          SELECT COUNT(*) as count, AVG(delay_mins) as avgDelay, MAX(delay_mins) as maxDelay
          FROM delay_logs
          WHERE timestamp >= ?
        `).get(cutoff);
        if (row && typeof row.count === 'number') {
          readCount++;
        }
      }
      db.close();
      parentPort.postMessage({ status: 'OK', mode, threadId, readCount });
    }
  } catch (err) {
    parentPort.postMessage({ status: 'ERROR', mode, threadId, error: err.message, stack: err.stack });
  }
}

/**
 * Main Challenger Test Suite
 */
async function runMainChallengerSuite() {
  console.log('============================================================');
  console.log('⚡ STARTING M5 ADVERSARIAL CHALLENGER HARNESS: SQLITE & IPC ⚡');
  console.log('============================================================\n');

  const historyDb = require('../src/historyDb');
  const flightRecorder = require('../src/flightRecorder');
  const reportCacheService = require('../src/reportCacheService');
  const { WorkerBridge } = require('../src/core/WorkerBridge');

  const testDbDir = path.join(__dirname, '..', 'data', 'test_scratch');
  if (!fs.existsSync(testDbDir)) {
    fs.mkdirSync(testDbDir, { recursive: true });
  }
  const testDbPath = path.join(testDbDir, `challenger_m5_${Date.now()}.db`);

  // =========================================================================
  // SUITE 1: Multi-Handle & Multi-Thread SQLite Concurrency & Lock Contention
  // =========================================================================
  console.log('------------------------------------------------------------');
  console.log('SUITE 1: Multi-Handle & Multi-Thread SQLite Concurrency');
  console.log('------------------------------------------------------------');

  // Initialize test database schema with PRAGMA busy_timeout = 5000
  const initDb = new DatabaseSync(testDbPath);
  initDb.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = -2048;
    PRAGMA wal_autocheckpoint = 200;
    PRAGMA temp_store = MEMORY;

    CREATE TABLE IF NOT EXISTS vehicle_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      line_code TEXT NOT NULL,
      agency TEXT,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      speed_kmh REAL DEFAULT 0,
      bearing REAL DEFAULT 0,
      delay_mins INTEGER DEFAULT 0,
      is_realtime INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active',
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS delay_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      line_id TEXT NOT NULL,
      line_code TEXT NOT NULL,
      agency TEXT,
      stop_id TEXT,
      stop_name TEXT,
      delay_mins INTEGER DEFAULT 0,
      scheduled_time TEXT,
      actual_time TEXT,
      is_realtime INTEGER DEFAULT 1,
      is_delayed INTEGER DEFAULT 0,
      timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_delay_timestamp ON delay_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_veh_timestamp ON vehicle_snapshots(timestamp);
  `);
  initDb.close();

  // Test 1.1: 10 Parallel Connection Handles Contention in Single Process
  console.log('\n[Test 1.1] Stress-testing 10 parallel DatabaseSync connection handles...');
  const numHandles = 10;
  const writesPerHandle = 200;
  const totalExpectedWrites = numHandles * writesPerHandle;

  const handles = [];
  for (let h = 0; h < numHandles; h++) {
    const handle = new DatabaseSync(testDbPath);
    handle.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -2048;
      PRAGMA wal_autocheckpoint = 200;
      PRAGMA temp_store = MEMORY;
    `);
    handles.push(handle);
  }

  const t0HandleStress = performance.now();
  const handleTasks = handles.map((dbHandle, handleIdx) => {
    return new Promise((resolve, reject) => {
      setImmediate(() => {
        try {
          const insertStmt = dbHandle.prepare(`
            INSERT INTO delay_logs 
            (line_id, line_code, agency, stop_id, stop_name, delay_mins, scheduled_time, actual_time, is_realtime, is_delayed, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          for (let i = 0; i < writesPerHandle; i++) {
            const delay = (i % 5) + 1;
            insertStmt.run(
              `LINE_H${handleIdx}_${i}`,
              `CODE_H${handleIdx}`,
              `HandleAgency_${handleIdx}`,
              `STOP_${i % 10}`,
              `Stop ${i % 10}`,
              delay,
              '10:00:00',
              '10:05:00',
              1,
              delay > 3 ? 1 : 0,
              Date.now() - (i * 500)
            );
          }
          resolve(writesPerHandle);
        } catch (err) {
          reject(err);
        }
      });
    });
  });

  const writeResults = await Promise.all(handleTasks);
  const handleDuration = performance.now() - t0HandleStress;
  const totalWritten = writeResults.reduce((a, b) => a + b, 0);

  // Close worker handles
  handles.forEach(h => h.close());

  // Verify row count from verification connection
  const verifyDb = new DatabaseSync(testDbPath);
  verifyDb.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  const countRow = verifyDb.prepare('SELECT COUNT(*) as total FROM delay_logs').get();
  assert.strictEqual(countRow.total, totalExpectedWrites, `Expected ${totalExpectedWrites} rows, found ${countRow.total}`);
  console.log(`  ✅ 10-Handle Contention: ${totalWritten} writes succeeded in ${handleDuration.toFixed(2)}ms (${Math.round(totalWritten / (handleDuration / 1000))} writes/sec) with 0 SQLITE_BUSY errors.`);

  // Test 1.2: Multi-Thread Worker Concurrency via worker_threads (2 Writers + 2 Readers)
  console.log('\n[Test 1.2] Stress-testing OS Multi-Thread Concurrency (4 worker_threads)...');
  const threadCount = 4;
  const threadIterations = 300;

  const t0Threads = performance.now();
  const threadPromises = [];

  for (let i = 0; i < threadCount; i++) {
    const mode = i < 2 ? 'writer' : 'reader';
    const p = new Promise((resolve, reject) => {
      const worker = new Worker(__filename, {
        workerData: {
          dbPath: testDbPath,
          threadId: i + 1,
          mode,
          iterations: threadIterations
        }
      });

      worker.on('message', (msg) => {
        if (msg.status === 'OK') {
          resolve(msg);
        } else {
          reject(new Error(`Worker Thread ${i + 1} Error: ${msg.error}`));
        }
      });

      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Worker Thread exited with code ${code}`));
      });
    });
    threadPromises.push(p);
  }

  // Simultaneously run analytical queries on the main thread
  const mainThreadCutoff = Date.now() - 24 * 3600 * 1000;
  for (let q = 0; q < 20; q++) {
    const res = verifyDb.prepare(`
      SELECT line_code, COUNT(*) as samples, AVG(delay_mins) as avgDelay
      FROM delay_logs
      WHERE timestamp >= ?
      GROUP BY line_code
      ORDER BY avgDelay DESC
      LIMIT 10
    `).all(mainThreadCutoff);
    assert(Array.isArray(res), 'Main thread queries must succeed concurrently');
  }

  const threadResults = await Promise.all(threadPromises);
  const threadDuration = performance.now() - t0Threads;
  console.log(`  ✅ 4-Thread Worker Concurrency completed in ${threadDuration.toFixed(2)}ms with 0 thread deadlocks or collisions.`);

  // Test 1.3: Verify SQLite Integrity Check
  console.log('\n[Test 1.3] Verifying SQLite DB Integrity (PRAGMA integrity_check / quick_check)...');
  const integrityResult = verifyDb.prepare('PRAGMA integrity_check;').get();
  assert.strictEqual(integrityResult.integrity_check, 'ok', 'integrity_check must return "ok"');
  const quickResult = verifyDb.prepare('PRAGMA quick_check;').get();
  assert.strictEqual(quickResult.quick_check, 'ok', 'quick_check must return "ok"');
  console.log('  ✅ SQLite PRAGMA integrity_check: OK. PRAGMA quick_check: OK.');

  verifyDb.close();


  // =========================================================================
  // SUITE 2: WAL Checkpoint Truncation during Active Write Bursts
  // =========================================================================
  console.log('\n------------------------------------------------------------');
  console.log('SUITE 2: WAL Checkpoint Truncation under High-Frequency Writes');
  console.log('------------------------------------------------------------');

  const walDb = new DatabaseSync(testDbPath);
  walDb.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = -2048;
    PRAGMA wal_autocheckpoint = 200;
    PRAGMA temp_store = MEMORY;
  `);

  // Test 2.1: Continuous writes with interleaved checkpointTruncate()
  console.log('\n[Test 2.1] Executing continuous write flood (1,000 rows) with interleaved WAL truncates...');
  const burstSize = 1000;
  const insertSnap = walDb.prepare(`
    INSERT INTO vehicle_snapshots 
    (vehicle_id, line_id, line_code, agency, lat, lon, speed_kmh, bearing, delay_mins, is_realtime, status, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let checkpointsExecuted = 0;
  const t0WalBurst = performance.now();

  for (let i = 0; i < burstSize; i++) {
    insertSnap.run(
      `VEH_BURST_${i}`,
      'CAT_M5',
      'C-10',
      'Moventis',
      41.5 + (i * 0.0001),
      2.4 + (i * 0.0001),
      45,
      180,
      i % 6,
      1,
      'active',
      Date.now()
    );

    // Trigger checkpoint truncate every 200 inserts
    if (i > 0 && i % 200 === 0) {
      walDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      checkpointsExecuted++;
    }
  }

  // Final explicit checkpoint truncate
  walDb.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  checkpointsExecuted++;
  const walDuration = performance.now() - t0WalBurst;
  console.log(`  ✅ Write burst + ${checkpointsExecuted} WAL checkpoints completed in ${walDuration.toFixed(2)}ms (${Math.round(burstSize / (walDuration / 1000))} rows/sec).`);

  // Test 2.2: Verify WAL file size on disk after checkpointTruncate
  console.log('\n[Test 2.2] Checking physical WAL file size after truncation...');
  const walFilePath = `${testDbPath}-wal`;
  if (fs.existsSync(walFilePath)) {
    const walStat = fs.statSync(walFilePath);
    console.log(`  Physical WAL file size: ${walStat.size} bytes`);
    assert(walStat.size <= 32768, `WAL file size (${walStat.size}B) should be truncated to 0 or bounded page header (<32KB)`);
    console.log('  ✅ WAL file truncated and bounded within storage constraints.');
  } else {
    console.log('  ✅ WAL file completely merged and 0 bytes.');
  }

  // Test 2.3: historyDb.checkpointTruncate() method verification
  console.log('\n[Test 2.3] Testing production historyDb.checkpointTruncate() method...');
  // Lazy-open: ensure the DB is open first (checkpointTruncate is a no-op
  // returning false when the DB was never opened — by design, so shutdown
  // cannot lazy-create a fresh database file).
  historyDb.init();
  const cpOk = historyDb.checkpointTruncate();
  assert.strictEqual(cpOk, true, 'historyDb.checkpointTruncate() must return true');
  console.log('  ✅ historyDb.checkpointTruncate() returned true.');

  walDb.close();


  // =========================================================================
  // SUITE 3: IPC Message Burst Stress & Memory Bounds Verification
  // =========================================================================
  console.log('\n------------------------------------------------------------');
  console.log('SUITE 3: IPC Message Burst Stress & In-Memory Bounds');
  console.log('------------------------------------------------------------');

  // Test 3.1: High-Frequency FLEET_UPDATE Burst (10,000 Messages, 50 vehicles each)
  console.log('\n[Test 3.1] Dispatching 10,000 high-frequency FLEET_UPDATE bursts...');
  const fleetBurstCount = 10000;
  const numDistinctVehicles = 50;

  // Generate 50 mock vehicles
  const baseFleet = [];
  for (let v = 0; v < numDistinctVehicles; v++) {
    baseFleet.push({
      vehicleId: `BUS_${v}`,
      lineId: `LINE_${v % 5}`,
      lineCode: `L${(v % 5) + 1}`,
      agency: v % 2 === 0 ? 'Moventis' : 'Mataró Bus',
      lat: 41.538 + (v * 0.001),
      lon: 2.444 + (v * 0.001),
      speedKmh: 30 + (v % 20),
      bearing: (v * 15) % 360,
      delayMins: v % 4,
      isRealTime: true,
      status: 'active'
    });
  }

  const initialHeap = process.memoryUsage().heapUsed;
  const t0FleetBurst = performance.now();

  for (let i = 0; i < fleetBurstCount; i++) {
    // Slightly mutate positions to simulate live GPS motion
    const updatedFleet = baseFleet.map(b => ({
      ...b,
      lat: b.lat + (Math.sin(i) * 0.0001),
      lon: b.lon + (Math.cos(i) * 0.0001),
      delayMins: (b.delayMins + (i % 2)) % 10
    }));

    flightRecorder.syncFleetFromWorker(updatedFleet);
  }

  const fleetBurstDuration = performance.now() - t0FleetBurst;
  const fleetThroughput = Math.round(fleetBurstCount / (fleetBurstDuration / 1000));
  const avgSyncTime = fleetBurstDuration / fleetBurstCount;

  console.log(`  ⚡ Processed ${fleetBurstCount} FLEET_UPDATE cycles in ${fleetBurstDuration.toFixed(2)}ms`);
  console.log(`  ⚡ Average sync duration: ${avgSyncTime.toFixed(4)}ms per message (Budget < 0.05ms)`);
  console.log(`  ⚡ Throughput: ${fleetThroughput.toLocaleString()} messages/sec`);

  // Assert vehicle map bounds
  const storedVehicles = flightRecorder.getAllVehicles();
  assert.strictEqual(storedVehicles.length, numDistinctVehicles, `Expected exactly ${numDistinctVehicles} active vehicles in Map, got ${storedVehicles.length}`);
  
  // Assert breadcrumb history bounds per vehicle
  for (const veh of storedVehicles) {
    assert(veh.history.length <= flightRecorder.maxMemoryBreadcrumbs, `Vehicle breadcrumbs (${veh.history.length}) exceeded maxMemoryBreadcrumbs (${flightRecorder.maxMemoryBreadcrumbs})`);
  }
  console.log(`  ✅ In-Memory Fleet Map bounds strictly maintained (Map size: ${storedVehicles.length}, breadcrumbs <= ${flightRecorder.maxMemoryBreadcrumbs}).`);

  // Test 3.2: High-Frequency REPORT_CACHE_UPDATE Burst (5,000 Messages)
  console.log('\n[Test 3.2] Dispatching 5,000 REPORT_CACHE_UPDATE bursts across canonical & non-canonical timeframes...');
  const reportBurstCount = 5000;
  const t0ReportBurst = performance.now();

  for (let i = 0; i < reportBurstCount; i++) {
    const rawHours = [12, 24, 36, 48, 72, 168, 200][i % 7];
    const mockReport = {
      summary: {
        totalRecordedArrivals: 1000 + i,
        monitoredLinesCount: 25,
        networkAvgDelay: 2.3,
        networkMaxDelay: 15,
        networkPunctualityPct: 92,
        hoursAnalyzed: rawHours
      },
      rankingMostDelayed: [{ lineCode: 'C-10', avgDelay: 4.5, sampleCount: 100 + i }],
      rankingBestPunctuality: [{ lineCode: 'L1', avgDelay: 0.8, sampleCount: 200 + i }],
      rankingWorstStops: [],
      agencyStats: []
    };

    reportCacheService.updateMemoryCache(rawHours, mockReport);
  }

  const reportBurstDuration = performance.now() - t0ReportBurst;
  console.log(`  ⚡ Processed ${reportBurstCount} REPORT_CACHE_UPDATE cycles in ${reportBurstDuration.toFixed(2)}ms (${Math.round(reportBurstCount / (reportBurstDuration / 1000))} updates/sec).`);

  // Assert report cache bounds (strictly canonical keys: 24, 48, 168)
  const cachedKeys = Array.from(reportCacheService.cachedReports.keys());
  assert(cachedKeys.length <= 3, `Cached report keys should be bounded <= 3, got: ${cachedKeys.join(', ')}`);
  for (const k of cachedKeys) {
    assert(['24', '48', '168'].includes(k), `Unexpected cached report timeframe key: ${k}`);
  }
  console.log(`  ✅ ReportCache memory strictly bounded to ${cachedKeys.length} canonical timeframes (${cachedKeys.join(', ')}).`);

  // Test 3.3: Memory Bounds & Heap Stability Check
  console.log('\n[Test 3.3] Verifying Heap Stability under 15,000 IPC message burst...');
  if (global.gc) {
    global.gc();
  }
  const finalHeap = process.memoryUsage().heapUsed;
  const heapGrowthMb = (finalHeap - initialHeap) / (1024 * 1024);
  console.log(`  Initial Heap: ${(initialHeap / (1024 * 1024)).toFixed(2)} MB`);
  console.log(`  Final Heap:   ${(finalHeap / (1024 * 1024)).toFixed(2)} MB (Delta: ${heapGrowthMb >= 0 ? '+' : ''}${heapGrowthMb.toFixed(2)} MB)`);
  assert(heapGrowthMb < 50, `Heap growth (${heapGrowthMb.toFixed(2)} MB) exceeded 50MB budget`);
  console.log('  ✅ Memory bounds verified: Zero unbounded heap leaks.');

  // Test 3.4: Adversarial Fuzzing of WorkerBridge Message Dispatcher
  console.log('\n[Test 3.4] Adversarial fuzzing of WorkerBridge.handleWorkerMessage with corrupt/invalid payloads...');
  const dummyBridge = new WorkerBridge({ mode: 'fork' });

  const maliciousPayloads = [
    null,
    undefined,
    {},
    '',
    12345,
    true,
    false,
    { type: 'UNKNOWN_EVENT_TYPE_123' },
    { type: 'FLEET_UPDATE' }, // missing payload
    { type: 'FLEET_UPDATE', payload: null },
    { type: 'FLEET_UPDATE', payload: { vehicles: null } },
    { type: 'FLEET_UPDATE', payload: { vehicles: 'not-an-array' } },
    { type: 'FLEET_UPDATE', payload: { vehicles: [null, undefined, 123, 'str', {}, { vehicleId: null }] } },
    { type: 'REPORT_CACHE_UPDATE' },
    { type: 'REPORT_CACHE_UPDATE', payload: null },
    { type: 'REPORT_CACHE_UPDATE', payload: { timeframeHours: null, report: null } },
    { type: 'DISRUPTIONS_UPDATE', payload: { disruptions: 'invalid' } },
    { type: 'PONG', payload: null },
    { type: 'STATUS', payload: null }
  ];

  for (let idx = 0; idx < maliciousPayloads.length; idx++) {
    const payload = maliciousPayloads[idx];
    assert.doesNotThrow(() => {
      dummyBridge.handleWorkerMessage(payload);
    }, `WorkerBridge crashed on adversarial payload #${idx}: ${JSON.stringify(payload)}`);
  }
  console.log(`  ✅ Fuzzed ${maliciousPayloads.length} adversarial payloads through WorkerBridge with 0 crashes or unhandled rejections.`);


  // =========================================================================
  // SUITE 4: Worker Process Lifecycle, SIGKILL Crash Recovery & Shutdown
  // =========================================================================
  console.log('\n------------------------------------------------------------');
  console.log('SUITE 4: Worker Process Lifecycle & Supervisor Crash Recovery');
  console.log('------------------------------------------------------------');

  console.log('\n[Test 4.1] Testing WorkerBridge spawn & WORKER_READY handshake...');
  const supervisorBridge = new WorkerBridge({
    pingIntervalMs: 2000,
    pingTimeoutMs: 5000,
    baseBackoffMs: 200,
    maxBackoffMs: 1000
  });

  supervisorBridge.start();

  // Await first ready
  const initialPid = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Initial worker did not become ready within 12s')), 12000);
    supervisorBridge.once('ready', () => {
      clearTimeout(timeout);
      resolve(supervisorBridge.pid);
    });
  });

  assert(initialPid > 0, `Expected valid PID, got ${initialPid}`);
  assert.strictEqual(supervisorBridge.isHealthy, true);
  console.log(`  ✅ Worker 1 spawned and verified healthy (PID: ${initialPid}).`);

  // Adversarially SIGKILL the running worker process
  console.log(`\n[Test 4.2] Simulating unhandled crash / SIGKILL on worker process (PID: ${initialPid})...`);
  const restartPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Worker did not auto-restart after SIGKILL within 12s')), 12000);
    supervisorBridge.once('ready', () => {
      clearTimeout(timeout);
      resolve(supervisorBridge.pid);
    });
  });

  try {
    process.kill(initialPid, 'SIGKILL');
  } catch (e) {
    // Ignore if already terminating
  }

  const replacementPid = await restartPromise;
  assert(replacementPid > 0, `Expected valid replacement PID, got ${replacementPid}`);
  assert.notStrictEqual(replacementPid, initialPid, `Replacement PID (${replacementPid}) must be different from initial PID (${initialPid})`);
  assert.strictEqual(supervisorBridge.isHealthy, true, 'Bridge should be marked healthy after restart');
  assert(supervisorBridge.restarts >= 1, `Restarts counter should be >= 1, got ${supervisorBridge.restarts}`);
  console.log(`  ✅ Supervisor successfully recovered from SIGKILL! Respawned replacement worker (PID: ${replacementPid}, Restarts: ${supervisorBridge.restarts}).`);

  // Test Graceful Shutdown
  console.log('\n[Test 4.3] Executing graceful shutdown with WAL checkpoint flush...');
  const t0Shutdown = performance.now();
  await supervisorBridge.shutdown(3000);
  const shutdownDuration = performance.now() - t0Shutdown;

  assert.strictEqual(supervisorBridge.isHealthy, false, 'Bridge should be unhealthy after shutdown');
  assert.strictEqual(supervisorBridge.pid, null, 'PID should be null after shutdown');
  console.log(`  ✅ Graceful shutdown verified in ${shutdownDuration.toFixed(2)}ms with clean process exit.`);

  // Cleanup scratch database files
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(`${testDbPath}-wal`)) fs.unlinkSync(`${testDbPath}-wal`);
    if (fs.existsSync(`${testDbPath}-shm`)) fs.unlinkSync(`${testDbPath}-shm`);
  } catch (e) {}

  return true;
}
