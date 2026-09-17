const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-health-'));
process.env.DB_PATH = path.join(scratch, 'history.db');
process.env.REPORTS_DIR = path.join(scratch, 'reports');
const bridge = require('../src/core/WorkerBridge');
bridge.start = () => {};
const reports = require('../src/reportCacheService');
const app = require('../server');
let server;

function request() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}/api/health`, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          assert.equal(res.statusCode, 200);
          resolve(JSON.parse(body));
        } catch (error) { reject(error); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  reports.cachedReports.clear();
  bridge.getStatus = () => ({ isHealthy: false, isRunning: false, lastHeartbeat: null, restarts: 0 });
  const cold = await request();
  assert.equal(cold.status, 'ok');
  assert.equal(cold.dataReady, false);
  assert.equal(cold.worker.heartbeatAgeMs, null);
  assert(cold.reports.every(report => !report.fresh && report.ageMs === null));

  bridge.getStatus = () => ({ isHealthy: true, isRunning: true, lastHeartbeat: Date.now() - 1000, restarts: 2 });
  for (const hours of reports.supportedHours) {
    reports.updateMemoryCache(hours, { summary: {}, meta: { generatedTimestamp: Date.now() - 60000 } });
  }
  const fresh = await request();
  assert.equal(fresh.dataReady, true);
  assert.equal(fresh.worker.restarts, 2);
  assert(fresh.worker.heartbeatAgeMs >= 1000);
  assert.deepEqual(fresh.reports.map(report => report.hours), [24, 48, 168]);
  assert(fresh.reports.every(report => report.fresh && report.ageMs >= 60000));

  reports.updateMemoryCache(48, { summary: {}, meta: { generatedTimestamp: Date.now() - 65 * 60000 } });
  const stale = await request();
  assert.equal(stale.dataReady, false);
  assert.equal(stale.reports.find(report => report.hours === 48).fresh, false);
  reports.updateMemoryCache(168, { summary: {} });
  assert.equal((await request()).reports.find(report => report.hours === 168).generatedTimestamp, null);
  assert.equal(reports._db, null);
  assert.equal(fs.existsSync(process.env.DB_PATH), false);
  console.log('PASS: health liveness, worker diagnostics, fresh/stale/missing reports, no database access');
})().finally(async () => {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}).then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
