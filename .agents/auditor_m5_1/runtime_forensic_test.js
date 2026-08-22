const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const net = require('net');
const sqlite = require('node:sqlite');
const fs = require('fs');
const assert = require('assert');

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const socket = new net.Socket();
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Port ${port} not open within ${timeoutMs}ms`));
        } else {
          setTimeout(check, 20);
        }
      });
      socket.connect(port, '127.0.0.1');
    };
    check();
  });
}

function timedGet(port, reqPath) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    http.get({ hostname: '127.0.0.1', port, path: reqPath }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          duration: Date.now() - start,
          data: JSON.parse(data)
        });
      });
    }).on('error', reject);
  });
}

async function verifyAll() {
  console.log('--- FORENSIC RUNTIME VERIFICATION ---');

  // 1. Database PRAGMAs and Indexes Verification via historyDb
  const historyDb = require('../../src/historyDb');
  console.log('1. Checking SQLite DB at:', historyDb.dbPath);
  assert(fs.existsSync(historyDb.dbPath), 'Database file must exist');

  const journalMode = historyDb.db.prepare('PRAGMA journal_mode;').get();
  console.log('   PRAGMA journal_mode:', journalMode);
  assert.strictEqual(journalMode.journal_mode.toLowerCase(), 'wal', 'journal_mode must be wal');

  const busyTimeout = historyDb.db.prepare('PRAGMA busy_timeout;').get();
  console.log('   PRAGMA busy_timeout on active connection:', busyTimeout);
  assert.strictEqual(busyTimeout.timeout, 5000, 'busy_timeout must be 5000 on active connection');

  const indexes = historyDb.db.prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type = 'index';`).all();
  console.log('   Indexes in Database:', indexes.map(i => `${i.tbl_name}.${i.name}`));
  const indexNames = indexes.map(i => i.name);
  assert(indexNames.includes('idx_delay_timestamp'), 'idx_delay_timestamp must exist');
  assert(indexNames.includes('idx_delay_time_line'), 'idx_delay_time_line must exist');
  assert(indexNames.includes('idx_delay_line_timestamp'), 'idx_delay_line_timestamp must exist');
  assert(indexNames.includes('idx_veh_timestamp'), 'idx_veh_timestamp must exist');
  console.log('   ✅ All SQLite WAL PRAGMAs and Indexes confirmed in real database connection.');

  // 2. Worker Process Isolation and PID Verification
  console.log('\n2. Testing Worker Process Isolation via WorkerBridge...');
  const workerBridge = require('../../src/core/WorkerBridge');
  workerBridge.start();

  // Wait for worker to be ready
  await new Promise((resolve) => {
    if (workerBridge.isHealthy) return resolve();
    workerBridge.once('ready', resolve);
    setTimeout(resolve, 5000);
  });

  const status = workerBridge.getStatus();
  console.log('   WorkerBridge Status:', JSON.stringify(status, null, 2));
  console.log('   Master PID:', process.pid);
  console.log('   Worker PID:', status.pid);

  assert(status.isRunning, 'Worker must be running');
  assert(status.isHealthy, 'Worker must be healthy');
  assert(typeof status.pid === 'number' && status.pid > 0, 'Worker PID must be a valid positive integer');
  assert.notStrictEqual(status.pid, process.pid, 'Worker PID must be distinct from Master PID (isolated process)');

  // 3. Test IPC Communication (triggering report and receiving update)
  console.log('\n3. Testing bidirectional IPC communication...');
  let reportReceived = false;
  workerBridge.once('report_update', (payload) => {
    console.log('   Received REPORT_CACHE_UPDATE from worker PID', status.pid, 'for', payload.timeframeHours, 'hours');
    reportReceived = true;
  });

  workerBridge.triggerReport(24);
  await new Promise(r => setTimeout(r, 2000));
  assert(reportReceived, 'REPORT_CACHE_UPDATE must be emitted over IPC channel');
  console.log('   ✅ Bidirectional IPC communication verified.');

  // Shutdown worker
  console.log('\n4. Testing graceful shutdown...');
  await workerBridge.shutdown();
  assert.strictEqual(workerBridge.getStatus().isRunning, false, 'Worker must be stopped after shutdown');
  console.log('   ✅ Worker shut down cleanly.');

  // 5. Server.js Subprocess Live Integration Test
  console.log('\n5. Testing server.js subprocess execution and /api/health worker report...');
  const port = await getFreePort();
  const serverProc = spawn(process.execPath, [path.join(__dirname, '../../server.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  serverProc.stdout.on('data', (d) => console.log('   [Server STDOUT]', d.toString().trim()));
  serverProc.stderr.on('data', (d) => console.error('   [Server STDERR]', d.toString().trim()));

  await waitForPort(port, 10000);
  console.log('   Server listening on port', port);
  const healthRes = await timedGet(port, '/api/health');
  console.log('   /api/health response:', JSON.stringify(healthRes.data, null, 2));
  assert.strictEqual(healthRes.statusCode, 200);
  assert.strictEqual(healthRes.data.status, 'ok');
  assert(healthRes.data.worker, 'Worker info must be reported in health endpoint');
  assert.strictEqual(healthRes.data.worker.isRunning, true, 'Server child worker must be running');
  assert(healthRes.data.worker.pid !== serverProc.pid, 'Worker PID must be different from Express server PID');

  serverProc.kill('SIGTERM');
  console.log('   ✅ Server subprocess and worker integration verified.');

  console.log('\n🎉 ALL RUNTIME FORENSIC CHECKS PASSED EMPIRICALLY!');
}

verifyAll().catch(err => {
  console.error('❌ VERIFICATION ERROR:', err);
  process.exit(1);
});
