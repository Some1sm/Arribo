/**
 * test/upstream_canary_test.js
 *
 * Tests for Phase 2.4:
 * 1. serviceStatus reporting degraded status when upstream canary fails or fleet anomaly is set.
 * 2. IngestionDaemon canary polling with mocked SIRI backend (auth failure vs success).
 * 3. IngestionDaemon fleet anomaly detection (off-hours inactive vs service hours empty fleet).
 * 4. /api/ready and /api/diagnostics/upstream HTTP endpoint responses.
 */

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-canary-test-'));
process.env.DB_PATH = path.join(scratch, 'history.db');
process.env.REPORTS_DIR = path.join(scratch, 'reports');

const serviceStatus = require('../src/core/serviceStatus');
const ingestionDaemon = require('../src/ingestionDaemon');
const flightRecorder = require('../src/flightRecorder');
const siriClient = require('../src/mataroSiriClient');
const workerBridge = require('../src/core/WorkerBridge');
workerBridge.start = () => {};
const app = require('../server');

let server;

function getJson(urlPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}${urlPath}`, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch (err) { reject(err); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function run() {
  console.log('🧪 Running upstream_canary_test.js...');

  const now = Date.now();
  const mockReports = [{ hours: 24, fresh: true }, { hours: 48, fresh: true }, { hours: 168, fresh: true }];

  // 1. serviceStatus unit tests
  {
    // Case 1A: Fresh fleet, canary ok -> status ready
    const workerGood = {
      isHealthy: true,
      isRunning: true,
      metrics: {
        upstream: { lastVehicleSuccessAt: now - 10000, lastArrivalsSuccessAt: now - 10000 },
        noticesUpdatedAt: now - 10000,
        lastObservationAt: now - 10000,
        upstreamCanary: { ok: true, error: null, checkedAt: now - 60000 },
        fleetAnomaly: null
      }
    };
    const resGood = serviceStatus(workerGood, mockReports, true, false, now);
    assert.strictEqual(resGood.status, 'ready', 'Status must be ready when fresh and canary ok');
    assert.strictEqual(resGood.upstream.canaryOk, true);
    assert.strictEqual(resGood.upstream.canaryError, null);
    assert.strictEqual(resGood.fleet.anomaly, null);

    // Case 1B: Fresh fleet, but canary failed < 15 min ago -> degraded (HTTP 200 ready)
    const workerCanaryFailed = {
      isHealthy: true,
      isRunning: true,
      metrics: {
        upstream: { lastVehicleSuccessAt: now - 10000, lastArrivalsSuccessAt: now - 10000 },
        noticesUpdatedAt: now - 10000,
        lastObservationAt: now - 10000,
        upstreamCanary: { ok: false, error: 'auth', checkedAt: now - 120000 },
        fleetAnomaly: null
      }
    };
    const resCanaryFailed = serviceStatus(workerCanaryFailed, mockReports, true, false, now);
    assert.strictEqual(resCanaryFailed.ready, true, 'ready must still be true (returns HTTP 200)');
    assert.strictEqual(resCanaryFailed.status, 'degraded', 'status must be degraded when canary failed');
    assert.strictEqual(resCanaryFailed.upstream.canaryOk, false);
    assert.strictEqual(resCanaryFailed.upstream.canaryError, 'auth');

    // Case 1C: Canary failed > 15 min ago -> does not degrade on its own
    const workerCanaryExpired = {
      isHealthy: true,
      isRunning: true,
      metrics: {
        upstream: { lastVehicleSuccessAt: now - 10000, lastArrivalsSuccessAt: now - 10000 },
        noticesUpdatedAt: now - 10000,
        lastObservationAt: now - 10000,
        upstreamCanary: { ok: false, error: 'auth', checkedAt: now - 16 * 60 * 1000 },
        fleetAnomaly: null
      }
    };
    const resCanaryExpired = serviceStatus(workerCanaryExpired, mockReports, true, false, now);
    assert.strictEqual(resCanaryExpired.status, 'ready', 'Canary failure older than 15 min should not degrade');

    // Case 1D: Fleet anomaly set -> degraded
    const workerAnomaly = {
      isHealthy: true,
      isRunning: true,
      metrics: {
        upstream: { lastVehicleSuccessAt: now - 10000, lastArrivalsSuccessAt: now - 10000 },
        noticesUpdatedAt: now - 10000,
        lastObservationAt: now - 10000,
        upstreamCanary: { ok: true, error: null, checkedAt: now - 60000 },
        fleetAnomaly: 'no_vehicles_during_service'
      }
    };
    const resAnomaly = serviceStatus(workerAnomaly, mockReports, true, false, now);
    assert.strictEqual(resAnomaly.status, 'degraded', 'status must be degraded when fleetAnomaly is set');
    assert.strictEqual(resAnomaly.fleet.anomaly, 'no_vehicles_during_service');
  }

  // 2. IngestionDaemon fleet anomaly detection
  {
    // Off-hours inactive service: Sunday 03:00 Madrid (01:00 UTC)
    const offHoursTs = Date.parse('2026-09-27T01:00:00Z');
    ingestionDaemon.zeroFleetSince = null;
    ingestionDaemon.fleetAnomaly = null;
    flightRecorder.vehicles.clear();

    const offHoursRes = ingestionDaemon.checkFleetAnomaly(offHoursTs);
    assert.strictEqual(offHoursRes.scheduled, 0, '0 scheduled buses at 03:00 Madrid');
    assert.strictEqual(offHoursRes.anomaly, null, 'Empty fleet at 03:00 is not an anomaly');

    // Revenue service hours: Wednesday 10:00 Madrid (08:00 UTC)
    const serviceTs = Date.parse('2026-09-23T08:00:00Z');
    ingestionDaemon.zeroFleetSince = null;
    ingestionDaemon.fleetAnomaly = null;

    // First check: empty fleet detected, timer initialized, no anomaly yet (< 5 min)
    const firstCheck = ingestionDaemon.checkFleetAnomaly(serviceTs);
    assert.strictEqual(firstCheck.scheduled > 10, true, 'Service operating at 10:00 Madrid');
    assert.strictEqual(firstCheck.anomaly, null, 'Anomaly not triggered immediately');
    assert.strictEqual(ingestionDaemon.zeroFleetSince, serviceTs);

    // 4 minutes later: still no anomaly
    const fourMinCheck = ingestionDaemon.checkFleetAnomaly(serviceTs + 4 * 60 * 1000);
    assert.strictEqual(fourMinCheck.anomaly, null, 'Anomaly not triggered before 5 minutes');

    // 5 minutes later: anomaly triggers!
    const fiveMinCheck = ingestionDaemon.checkFleetAnomaly(serviceTs + 5 * 60 * 1000 + 1000);
    assert.strictEqual(fiveMinCheck.anomaly, 'no_vehicles_during_service', 'Anomaly triggered after 5 min empty fleet');

    // A real bus appears -> anomaly clears immediately
    flightRecorder.ingestVehicle({
      vehicleId: 'bus_123',
      lineId: '1',
      lat: 41.53,
      lon: 2.44,
      isRealTime: true,
      serviceableMs: 90000
    });
    const busAppearsCheck = ingestionDaemon.checkFleetAnomaly(serviceTs + 6 * 60 * 1000);
    assert.strictEqual(busAppearsCheck.anomaly, null, 'Anomaly clears when live bus is present');
    assert.strictEqual(ingestionDaemon.zeroFleetSince, null);
    flightRecorder.vehicles.clear();
  }

  // 3. IngestionDaemon canary polling
  {
    const origWarn = console.warn;
    const origError = console.error;
    console.warn = () => {};
    console.error = () => {};

    try {
      // Mock SOAP backend to simulate auth failure
      const AUTH_FAIL_XML = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetStopMonitoringResponse xmlns="http://tempuri.org/"><GetStopMonitoringResult><ServiceDeliveryInfo xmlns=""><ResponseTimestamp xmlns="http://www.siri.org.uk/siri">0001-01-01T00:00:00</ResponseTimestamp></ServiceDeliveryInfo><Answer xmlns=""><StopMonitoringDelivery xmlns="http://www.siri.org.uk/siri"><ResponseTimestamp>0001-01-01T00:00:00</ResponseTimestamp><ErrorCondition><Description>Invalid user/password</Description></ErrorCondition></StopMonitoringDelivery></Answer></GetStopMonitoringResult></GetStopMonitoringResponse></soap:Body></soap:Envelope>`;
      siriClient.setHttpBackend(async () => ({ status: 200, bodyText: AUTH_FAIL_XML }));

      await ingestionDaemon.pollCanary();
      assert.strictEqual(ingestionDaemon.upstreamCanary.ok, false, 'Canary must fail on auth error');
      assert.strictEqual(ingestionDaemon.upstreamCanary.error, 'auth');

      // Mock SOAP backend to simulate healthy stop
      const HEALTHY_XML = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetStopMonitoringResponse xmlns="http://tempuri.org/"><GetStopMonitoringResult><ServiceDeliveryInfo xmlns=""><ResponseTimestamp xmlns="http://www.siri.org.uk/siri">2026-09-27T22:46:55.2018494+02:00</ResponseTimestamp></ServiceDeliveryInfo><Answer xmlns=""><StopMonitoringDelivery xmlns="http://www.siri.org.uk/siri"><ResponseTimestamp>2026-09-27T22:46:55.2018494+02:00</ResponseTimestamp><Status>true</Status><ValidUntil>2026-09-27T22:47:55.2018494+02:00</ValidUntil><MonitoringRef>1016</MonitoringRef></StopMonitoringDelivery></Answer></GetStopMonitoringResult></GetStopMonitoringResponse></soap:Body></soap:Envelope>`;
      siriClient.setHttpBackend(async () => ({ status: 200, bodyText: HEALTHY_XML }));

      await ingestionDaemon.pollCanary();
      assert.strictEqual(ingestionDaemon.upstreamCanary.ok, true, 'Canary must succeed on healthy response');
      assert.strictEqual(ingestionDaemon.upstreamCanary.error, null);
    } finally {
      console.warn = origWarn;
      console.error = origError;
      siriClient.setHttpBackend(null);
    }
  }

  // 4. End-to-end HTTP endpoints (/api/ready and /api/diagnostics/upstream)
  {
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));

    try {
      // Mock worker status with canary failure
      workerBridge.getStatus = () => ({
        isHealthy: true,
        isRunning: true,
        lastHeartbeat: Date.now() - 2000,
        metrics: {
          upstream: {
            lastVehicleSuccessAt: Date.now() - 5000,
            lastArrivalsSuccessAt: Date.now() - 5000,
            lastError: 'auth',
            vehicleDeliveryStatus: false
          },
          noticesUpdatedAt: Date.now() - 5000,
          upstreamCanary: { ok: false, error: 'auth', checkedAt: Date.now() - 30000 },
          fleetAnomaly: 'no_vehicles_during_service'
        }
      });

      const readyRes = await getJson('/api/ready');
      assert.strictEqual(readyRes.status, 200, '/api/ready returns HTTP 200 even when degraded');
      assert.strictEqual(readyRes.data.status, 'degraded', 'status is degraded');
      assert.strictEqual(readyRes.data.upstream.canaryOk, false);
      assert.strictEqual(readyRes.data.upstream.canaryError, 'auth');
      assert.strictEqual(readyRes.data.fleet.anomaly, 'no_vehicles_during_service');

      const diagRes = await getJson('/api/diagnostics/upstream');
      assert.strictEqual(diagRes.status, 200);
      assert.strictEqual(diagRes.data.upstream.lastError, 'auth');
      assert.strictEqual(diagRes.data.upstream.vehicleDeliveryStatus, false);
      assert.strictEqual(diagRes.data.upstream.canary.ok, false);
      assert.strictEqual(diagRes.data.upstream.canary.error, 'auth');

      // Now mock worker status with healthy state
      workerBridge.getStatus = () => ({
        isHealthy: true,
        isRunning: true,
        lastHeartbeat: Date.now() - 2000,
        metrics: {
          upstream: {
            lastVehicleSuccessAt: Date.now() - 5000,
            lastArrivalsSuccessAt: Date.now() - 5000,
            lastError: null,
            vehicleDeliveryStatus: true
          },
          noticesUpdatedAt: Date.now() - 5000,
          upstreamCanary: { ok: true, error: null, checkedAt: Date.now() - 30000 },
          fleetAnomaly: null
        }
      });

      const readyHealthy = await getJson('/api/ready');
      assert.strictEqual(readyHealthy.status, 200);
      assert.strictEqual(readyHealthy.data.status, 'ready');
      assert.strictEqual(readyHealthy.data.upstream.canaryOk, true);
      assert.strictEqual(readyHealthy.data.fleet.anomaly, null);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  }

  console.log('✅ upstream_canary_test passed all assertions!');
}

run().catch((err) => {
  console.error('❌ upstream_canary_test failed:', err);
  process.exit(1);
});
