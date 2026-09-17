const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-multiline-'));
process.env.DB_PATH = path.join(scratch, 'history.db');
process.env.REPORTS_DIR = path.join(scratch, 'reports');
const app = require('../server');
const bridge = require('../src/core/WorkerBridge');
let server;

function request(route) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: server.address().port, path: route }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          assert.equal(res.statusCode, 200, `${route}: ${data}`);
          resolve(JSON.parse(data));
        } catch (error) { reject(error); }
      });
      res.on('error', reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error(`Request timed out: ${route}`)));
    req.on('error', reject);
  });
}

async function runTests() {
  server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    assert.equal((await request('/api/health')).status, 'ok');
    const expectedCodes = Array.from({ length: 8 }, (_, i) => `L${i + 1}`);
    for (const route of ['/api/lines', '/api/mataro/lines']) {
      const catalog = await request(route);
      assert.equal(catalog.success, true);
      assert.deepEqual(catalog.lines.map(line => line.code).sort(), expectedCodes);
      assert.equal(new Set(catalog.lines.map(line => line.id)).size, 8);
    }
    const search = await request('/api/search/stops?q=Hospital');
    assert(search.results.some(result => result.type === 'stop'));

    for (let line = 1; line <= 8; line++) {
      for (const route of [`/api/line/${line}`, `/api/mataro/line/${line}`]) {
        const response = await request(route);
        assert.equal(response.success, true);
        assert.equal(response.data.code, `L${line}`);
        assert(response.data.stops.length > 0);
        assert(response.data.polyline.length > 0);
        assert(Array.isArray(response.data.activeBuses));
      }
    }
    for (const route of ['/api/line/8/target-eta?direction=0', '/api/mataro/target-eta?lineId=8']) {
      const response = await request(route);
      assert.equal(response.success, true);
      assert(response.data.targetStop);
    }
    for (const route of ['/api/mataro/stop/1001/departures?lineId=1', '/api/line/1/stop/1001/departures']) {
      const response = await request(route);
      assert.equal(response.success, true);
      const departures = response.data.departures;
      assert(departures.length > 0);
      for (const departure of departures) {
        assert.match(departure.departureTime, /^\d{2}:\d{2}$/);
        if (departure.minutesAway === 0 && departure.isRealTime) {
          assert.notEqual(departure.departureTime, '00:00');
        }
        if (departure.expectedIso) {
          assert(!departure.expectedIso.startsWith('0001-'));
          assert(!departure.expectedIso.startsWith('1970-'));
        }
      }
    }
    const journalism = await request('/api/analytics/journalism?hours=24');
    assert.equal(journalism.success, true);
    assert.equal(journalism.report.summary.monitoredLinesCount, 8);
    console.log('PASS: Mataró L1–L8 catalogs, line details, search, ETA, departures and reporting');
  } finally {
    await bridge.shutdown();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

runTests().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
