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
      fleetAnomaly: null,
      scheduleDrift: { drift: false, checkedAt: '2026-09-28T04:15:00.000Z', differencesCount: 0 }
    }
  });

  const res = await requestDataHealth();
  assert.equal(res.success, true);
  assert(Number.isFinite(res.timestamp));
  assert.equal(res.fleetAnomaly.detected, false);
  assert.equal(res.fleet.lines.length, 8);
  assert.equal(typeof res.fleet.totalEstimated, 'number');

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
    fleetAnomaly: { detected: false, code: null, message: null },
    fleet: { totalLiveGps: 12, totalEstimated: 0, totalScheduled: 12, complete: true, lines: [] },
    scheduleDrift: { drift: false, differencesCount: 0 },
    season: { season: 'winter', seasonKnown: true, seasonSource: 'config' },
    seasonOutlook: { warning: null },
    holidaysKnownForYear: true,
    reportFreshness: [{ hours: 24, fresh: true }]
  };
  appInstance.renderDataHealth(healthyData);
  assert(mockDom.gridInnerHtml.includes('status-success'), 'Healthy fields must render green status-success badges');

  appInstance.renderDataHealth({ ...healthyData, fleetAnomaly: { detected: true, code: 'no_vehicles_during_service', message: 'x' }, scheduleDrift: { drift: true, differencesCount: 3 } });
  assert(mockDom.gridInnerHtml.includes('>Anomalia<'), 'A detected anomaly must render the Anomalia badge');
  assert(mockDom.gridInnerHtml.includes('>Desviació<'), 'Worker-shaped drift must render the Desviació badge');
  assert(!mockDom.gridInnerHtml.includes('>Normal<'), 'A detected anomaly must never render Normal');

  // D1. Season unescaped label and default text
  appInstance.renderDataHealth({ ...healthyData, season: { season: 'winter', seasonKnown: true, seasonSource: 'default (no summer window covers this date)' } });
  assert(mockDom.gridInnerHtml.includes('Horari d&#039;hivern'), 'Should contain unescaped entity in rendered html');
  assert(!mockDom.gridInnerHtml.includes('&amp;#039;'), 'Must not contain double-escaped &amp;#039;');
  assert(mockDom.gridInnerHtml.includes('per defecte'), 'Should include per defecte');
  assert(!mockDom.gridInnerHtml.includes('no summer window'), 'Must not include raw English reason string');

  // D2. Operator error: malformed recent
  appInstance.renderDataHealth({ ...healthyData, upstreamKnown: true, lastError: 'malformed', lastErrorAt: Date.now() - 60000, circuitOpen: false });
  assert(mockDom.gridInnerHtml.includes('>Error recent<'), 'Should include Error recent badge');
  assert(mockDom.gridInnerHtml.includes('resposta buida o incompleta'), 'Should describe malformed error in Catalan');
  assert(!mockDom.gridInnerHtml.includes('malformed'), 'Must not include raw error code malformed');

  // D3. Operator error: malformed older than 10 min
  appInstance.renderDataHealth({ ...healthyData, upstreamKnown: true, lastError: 'malformed', lastErrorAt: Date.now() - 30 * 60000, circuitOpen: false });
  assert(mockDom.gridInnerHtml.includes('>Recuperat<'), 'Older error should render Recuperat badge');

  // D4. Operator error: auth with circuit open
  appInstance.renderDataHealth({ ...healthyData, upstreamKnown: true, lastError: 'auth', lastErrorAt: Date.now() - 60000, circuitOpen: true });
  assert(mockDom.gridInnerHtml.includes('>Error<'), 'Circuit open should render Error badge');
  assert(mockDom.gridInnerHtml.includes('credencials SIRI rebutjades'), 'Should describe auth error in Catalan');

  // D5. Operator error: null
  appInstance.renderDataHealth({ ...healthyData, upstreamKnown: true, lastError: null });
  assert(mockDom.gridInnerHtml.includes('>Sense errors<'), 'Null lastError with upstreamKnown should render Sense errors badge');

  console.log('PASS: /api/data-health contract, null fields rendered as "sense dades" (never green), zero SQLite access.');
})().finally(async () => {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}).then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
