'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-data-health-'));
process.env.DB_PATH = path.join(scratch, 'history.db');
process.env.REPORTS_DIR = path.join(scratch, 'reports');

const bridge = require('../src/core/WorkerBridge');
bridge.start = () => {};
const _reports = require('../src/reportCacheService');
const app = require('../server');

let server;

function requestDataHealth() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}/api/data-health`, res => {
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

  // 1. Endpoint contract verification
  bridge.getStatus = () => ({
    isHealthy: true,
    isRunning: true,
    lastHeartbeat: Date.now(),
    restarts: 0,
    metrics: {
      upstreamCanary: { ok: true, error: null, checkedAt: Date.now() - 5000 },
      upstream: { lastError: null },
      fleetAnomaly: { detectedAt: null, severity: 'none', message: null },
      scheduleDrift: { driftFound: false, discrepancies: 0 }
    }
  });

  const res = await requestDataHealth();
  assert.equal(res.success, true);
  assert(Number.isFinite(res.timestamp));

  // Check all required fields are present
  assert('upstreamCanary' in res, 'Missing upstreamCanary field');
  assert('lastError' in res, 'Missing lastError field');
  assert('fleetAnomaly' in res, 'Missing fleetAnomaly field');
  assert('fleet' in res, 'Missing fleet field');
  assert('scheduleDrift' in res, 'Missing scheduleDrift field');
  assert('season' in res, 'Missing season field');
  assert('seasonOutlook' in res, 'Missing seasonOutlook field');
  assert('holidaysKnownForYear' in res, 'Missing holidaysKnownForYear field');
  assert('reportFreshness' in res, 'Missing reportFreshness field');

  // Verify fleet line breakdown
  assert.equal(typeof res.fleet, 'object');
  assert(Array.isArray(res.fleet.lines));
  assert.equal(res.fleet.lines.length, 8);
  for (let i = 1; i <= 8; i++) {
    const l = res.fleet.lines[i - 1];
    assert.equal(l.lineId, String(i));
    assert.equal(l.lineCode, `L${i}`);
    assert(typeof l.liveGpsVehicles === 'number');
    assert(typeof l.scheduledVehicles === 'number');
  }

  // Verify zero SQLite database access
  assert.equal(fs.existsSync(process.env.DB_PATH), false, 'Endpoint must not open SQLite database');

  // 2. Test UI Renderer behavior: null fields render as "sense dades", NEVER green (status-success)
  // Read the renderer logic directly from observatori.js
  const obsSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'observatori.js'), 'utf8');
  assert(obsSource.includes('renderDataHealth(data)'), 'renderDataHealth must be defined in observatori.js');

  // Simulate renderDataHealth in a mock DOM environment
  const mockDom = {
    gridInnerHtml: '',
    timeText: ''
  };
  global.document = {
    getElementById: (id) => {
      if (id === 'data-health-grid') {
        return {
          set innerHTML(val) { mockDom.gridInnerHtml = val; },
          get innerHTML() { return mockDom.gridInnerHtml; }
        };
      }
      if (id === 'data-health-timestamp') {
        return {
          set textContent(val) { mockDom.timeText = val; },
          get textContent() { return mockDom.timeText; }
        };
      }
      return null;
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    documentElement: { setAttribute: () => {}, getAttribute: () => 'dark' }
  };

  // Evaluate the ObservatoriApp class in test sandbox
  const vm = require('node:vm');
  const context = {
    document: global.document,
    window: {
      location: { search: '', pathname: '/dades' },
      addEventListener: () => {},
      history: { replaceState: () => {} }
    },
    URLSearchParams: global.URLSearchParams,
    localStorage: { getItem: () => 'dark', setItem: () => {} },
    Date: global.Date,
    Math: global.Math,
    Array: global.Array
  };
  vm.createContext(context);
  vm.runInContext(obsSource, context);
  const ObservatoriApp = vm.runInContext('ObservatoriApp', context);

  const appInstance = new ObservatoriApp();

  // Test Case A: All fields null
  const nullData = {
    upstreamCanary: null,
    lastError: null,
    fleetAnomaly: null,
    fleet: null,
    scheduleDrift: null,
    season: null,
    seasonOutlook: null,
    holidaysKnownForYear: null,
    reportFreshness: null
  };
  appInstance.renderDataHealth(nullData);

  // Assertions for null fields:
  // Must NEVER contain status-success
  assert(!mockDom.gridInnerHtml.includes('status-success'), 'Null fields must NEVER produce green status-success!');
  // Must render "Sense dades" in status-neutral badge for all 9 indicators
  const badgeCount = (mockDom.gridInnerHtml.match(/status-neutral[^>]*>Sense dades<\/span>/gi) || []).length;
  assert.equal(badgeCount, 9, `All 9 indicators must render "Sense dades" in neutral badge when null (got ${badgeCount})`);

  // Test Case B: Healthy fields
  const healthyData = {
    upstreamCanary: { ok: true, error: null, checkedAt: Date.now() },
    lastError: null, // no error
    fleetAnomaly: { detected: false },
    fleet: { totalLiveGps: 12, totalScheduled: 12, lines: [] },
    scheduleDrift: { driftFound: false },
    season: { season: 'winter', seasonKnown: true, seasonSource: 'config' },
    seasonOutlook: { warning: null },
    holidaysKnownForYear: true,
    reportFreshness: [{ hours: 24, fresh: true }]
  };
  appInstance.renderDataHealth(healthyData);
  assert(mockDom.gridInnerHtml.includes('status-success'), 'Healthy fields must render green status-success badges');

  console.log('PASS: /api/data-health contract, null fields rendered as "sense dades" (never green), zero SQLite access.');
})().finally(async () => {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}).then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
