'use strict';

const assert = require('node:assert');
const siriClient = require('../src/mataroSiriClient');

const AUTH_FAILURE_XML = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body><GetStopMonitoringResponse xmlns="http://tempuri.org/"><GetStopMonitoringResult><ServiceDeliveryInfo xmlns=""><ResponseTimestamp xmlns="http://www.siri.org.uk/siri">0001-01-01T00:00:00</ResponseTimestamp></ServiceDeliveryInfo><Answer xmlns=""><StopMonitoringDelivery xmlns="http://www.siri.org.uk/siri"><ResponseTimestamp>0001-01-01T00:00:00</ResponseTimestamp><ErrorCondition><Description>Invalid user/password</Description></ErrorCondition></StopMonitoringDelivery></Answer></GetStopMonitoringResult></GetStopMonitoringResponse></soap:Body></soap:Envelope>`;

const HEALTHY_EMPTY_STOP_XML = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body><GetStopMonitoringResponse xmlns="http://tempuri.org/"><GetStopMonitoringResult><ServiceDeliveryInfo xmlns=""><ResponseTimestamp xmlns="http://www.siri.org.uk/siri">2026-09-27T22:46:55.2018494+02:00</ResponseTimestamp></ServiceDeliveryInfo><Answer xmlns=""><StopMonitoringDelivery xmlns="http://www.siri.org.uk/siri"><ResponseTimestamp>2026-09-27T22:46:55.2018494+02:00</ResponseTimestamp><Status>true</Status><ValidUntil>2026-09-27T22:47:55.2018494+02:00</ValidUntil><MonitoringRef>1001</MonitoringRef></StopMonitoringDelivery></Answer></GetStopMonitoringResult></GetStopMonitoringResponse></soap:Body></soap:Envelope>`;

const VEHICLE_STATUS_FALSE_XML = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body><GetVehicleMonitoringResponse xmlns="http://tempuri.org/"><GetVehicleMonitoringResult><ServiceDeliveryInfo xmlns=""><ResponseTimestamp xmlns="http://www.siri.org.uk/siri">2026-09-27T22:46:43.076938+02:00</ResponseTimestamp></ServiceDeliveryInfo><Answer xmlns=""><VehicleMonitoringDelivery xmlns="http://www.siri.org.uk/siri"><ResponseTimestamp>2026-09-27T22:46:43.076938+02:00</ResponseTimestamp><Status>false</Status><ValidUntil>2026-09-27T22:47:43.076938+02:00</ValidUntil></VehicleMonitoringDelivery></Answer></GetVehicleMonitoringResult></GetVehicleMonitoringResponse></soap:Body></soap:Envelope>`;

const SOAP_FAULT_XML = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Server</faultcode><faultstring>boom</faultstring></soap:Fault></soap:Body></soap:Envelope>`;

const TIMETABLE_ONLY_ARRIVAL_XML = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetStopMonitoringResponse xmlns="http://tempuri.org/"><GetStopMonitoringResult><ServiceDeliveryInfo xmlns=""><ResponseTimestamp xmlns="http://www.siri.org.uk/siri">2026-09-27T22:46:55.2018494+02:00</ResponseTimestamp></ServiceDeliveryInfo><Answer xmlns=""><StopMonitoringDelivery xmlns="http://www.siri.org.uk/siri"><ResponseTimestamp>2026-09-27T22:46:55.2018494+02:00</ResponseTimestamp><Status>true</Status><MonitoredStopVisit><MonitoredVehicleJourney><LineRef>1</LineRef><PublishedLineName>L1</PublishedLineName><DirectionName>Hospital</DirectionName><DestinationName>Hospital</DestinationName><VehicleRef>2679</VehicleRef><MonitoredCall><AimedArrivalTime>${new Date(Date.now() + 600000).toISOString()}</AimedArrivalTime></MonitoredCall></MonitoredVehicleJourney></MonitoredStopVisit></StopMonitoringDelivery></Answer></GetStopMonitoringResult></GetStopMonitoringResponse></soap:Body></soap:Envelope>`;

const LIVE_ARRIVAL_XML = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><GetStopMonitoringResponse xmlns="http://tempuri.org/"><GetStopMonitoringResult><ServiceDeliveryInfo xmlns=""><ResponseTimestamp xmlns="http://www.siri.org.uk/siri">2026-09-27T22:46:55.2018494+02:00</ResponseTimestamp></ServiceDeliveryInfo><Answer xmlns=""><StopMonitoringDelivery xmlns="http://www.siri.org.uk/siri"><ResponseTimestamp>2026-09-27T22:46:55.2018494+02:00</ResponseTimestamp><Status>true</Status><MonitoredStopVisit><MonitoredVehicleJourney><LineRef>1</LineRef><PublishedLineName>L1</PublishedLineName><DirectionName>Hospital</DirectionName><DestinationName>Hospital</DestinationName><VehicleRef>2679</VehicleRef><MonitoredCall><AimedArrivalTime>${new Date(Date.now() + 600000).toISOString()}</AimedArrivalTime><ExpectedArrivalTime>${new Date(Date.now() + 780000).toISOString()}</ExpectedArrivalTime></MonitoredCall></MonitoredVehicleJourney></MonitoredStopVisit></StopMonitoringDelivery></Answer></GetStopMonitoringResult></GetStopMonitoringResponse></soap:Body></soap:Envelope>`;

const IDLE_LINE_XML = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"><soap:Body><GetVehicleMonitoringResponse xmlns="http://tempuri.org/"><GetVehicleMonitoringResult><ServiceDeliveryInfo xmlns=""><ResponseTimestamp xmlns="http://www.siri.org.uk/siri">2026-09-28T21:50:01.5820725+02:00</ResponseTimestamp></ServiceDeliveryInfo><Answer xmlns="" /></GetVehicleMonitoringResult></GetVehicleMonitoringResponse></soap:Body></soap:Envelope>`;

async function run() {
  console.log('🧪 Running siri_error_detection_test.js...');

  // Helper to capture console.warn / console.error for credential leak checks
  let capturedLogs = '';
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args) => { capturedLogs += ' ' + args.join(' '); };
  console.error = (...args) => { capturedLogs += ' ' + args.join(' '); };

  try {
    // 1. Auth failure test
    siriClient.cache.clear();
    siriClient.consecutiveFailures = 0;
    siriClient.circuitOpenUntil = 0;
    siriClient.lastArrivalsSuccessAt = null;
    siriClient.setHttpBackend(async () => ({ status: 200, bodyText: AUTH_FAILURE_XML }));

    const authRes = await siriClient.getStopArrivals('1001');
    assert.deepStrictEqual(authRes, [], 'Auth failure should return empty array when no cache');
    assert.strictEqual(siriClient.lastArrivalsSuccessAt, null, 'Auth failure must not record success');
    assert.ok(siriClient.consecutiveFailures >= 1, 'Auth failure must increment consecutiveFailures');
    assert.strictEqual(siriClient.getUpstreamStatus().lastError, 'auth', 'lastError must be auth');

    // 2. Healthy empty stop test
    siriClient.cache.clear();
    siriClient.consecutiveFailures = 0;
    siriClient.circuitOpenUntil = 0;
    siriClient.setHttpBackend(async () => ({ status: 200, bodyText: HEALTHY_EMPTY_STOP_XML }));

    const emptyRes = await siriClient.getStopArrivals('1001');
    assert.deepStrictEqual(emptyRes, [], 'Healthy empty stop returns []');
    assert.ok(siriClient.lastArrivalsSuccessAt > 0, 'Healthy empty stop must record arrivals success');
    assert.strictEqual(siriClient.getUpstreamStatus().lastError, null, 'Healthy empty stop sets lastError to null');

    // 3. Vehicle Status false with no activities
    siriClient.cache.clear();
    siriClient.consecutiveFailures = 0;
    siriClient.circuitOpenUntil = 0;
    siriClient.setHttpBackend(async () => ({ status: 200, bodyText: VEHICLE_STATUS_FALSE_XML }));

    const vehRes = await siriClient.getLiveVehicles('1');
    assert.deepStrictEqual(vehRes, [], 'Vehicle Status false returns []');
    assert.ok(siriClient.lastVehicleSuccessAt > 0, 'Vehicle Status false counts as success for transport');
    assert.strictEqual(siriClient.getUpstreamStatus().vehicleDeliveryStatus, false, 'vehicleDeliveryStatus must be false');
    assert.strictEqual(siriClient.getUpstreamStatus().lastError, null, 'lastError must be null for Status false delivery');

    // 4. SOAP fault
    siriClient.cache.clear();
    siriClient.consecutiveFailures = 0;
    siriClient.circuitOpenUntil = 0;
    siriClient.setHttpBackend(async () => ({ status: 200, bodyText: SOAP_FAULT_XML }));

    await siriClient.getStopArrivals('1001');
    assert.strictEqual(siriClient.getUpstreamStatus().lastError, 'soap_fault', 'SOAP fault classified as soap_fault');

    // 5. HTTP 502 HTML
    siriClient.cache.clear();
    siriClient.consecutiveFailures = 0;
    siriClient.circuitOpenUntil = 0;
    siriClient.setHttpBackend(async () => ({ status: 502, bodyText: '<html><body>502 Bad Gateway</body></html>' }));

    await siriClient.getStopArrivals('1001');
    assert.strictEqual(siriClient.getUpstreamStatus().lastError, 'http_502', 'HTTP 502 classified as http_502');

    // 6. Empty body with 200
    siriClient.cache.clear();
    siriClient.consecutiveFailures = 0;
    siriClient.circuitOpenUntil = 0;
    siriClient.setHttpBackend(async () => ({ status: 200, bodyText: '' }));

    await siriClient.getStopArrivals('1001');
    assert.strictEqual(siriClient.getUpstreamStatus().lastError, 'malformed', 'Empty body classified as malformed');

    // 7. Credential privacy check
    assert.ok(!capturedLogs.includes('Mataro*WS'), 'Account key Mataro*WS must never appear in logs');
    assert.ok(!JSON.stringify(siriClient.getUpstreamStatus()).includes('Mataro*WS'), 'Account key must never appear in getUpstreamStatus()');

    // 8. Timetable-only SIRI arrival (only AimedArrivalTime)
    siriClient.cache.clear();
    siriClient.consecutiveFailures = 0;
    siriClient.circuitOpenUntil = 0;
    siriClient.setHttpBackend(async () => ({ status: 200, bodyText: TIMETABLE_ONLY_ARRIVAL_XML }));

    const ttRes = await siriClient.getStopArrivals('1001');
    assert.strictEqual(ttRes.length, 1, 'Timetable-only arrival parsed');
    assert.strictEqual(ttRes[0].isRealTime, false, 'Timetable-only arrival must have isRealTime: false');
    assert.strictEqual(ttRes[0].delayMins, null, 'Timetable-only arrival must have delayMins: null');
    assert.strictEqual(ttRes[0].delayBadgeText, 'Horari previst', 'Badge must be Horari previst');
    assert.strictEqual(ttRes[0].delayStatus, 'scheduled', 'delayStatus must be scheduled');

    // 9. Live SIRI arrival with Aimed and Expected (3 min apart)
    siriClient.cache.clear();
    siriClient.consecutiveFailures = 0;
    siriClient.circuitOpenUntil = 0;
    siriClient.setHttpBackend(async () => ({ status: 200, bodyText: LIVE_ARRIVAL_XML }));

    const liveRes = await siriClient.getStopArrivals('1001');
    assert.strictEqual(liveRes.length, 1, 'Live arrival parsed');
    assert.strictEqual(liveRes[0].isRealTime, true, 'Live arrival must have isRealTime: true');
    assert.strictEqual(liveRes[0].delayMins, 3, 'Expected - Aimed = 3 mins');

    // 10. Idle line with empty <Answer xmlns="" />
    siriClient.cache.clear();
    siriClient.consecutiveFailures = 0;
    siriClient.circuitOpenUntil = 0;
    siriClient.setHttpBackend(async () => ({ status: 200, bodyText: IDLE_LINE_XML }));

    const idleRes = await siriClient.getLiveVehicles('7');
    assert.deepStrictEqual(idleRes, []);
    assert.strictEqual(siriClient.consecutiveFailures, 0);
    assert.strictEqual(siriClient.getUpstreamStatus().lastError, null);
    assert.strictEqual(siriClient.isCircuitOpen(), false);

    // 11. Same body without <Answer xmlns="" /> → malformed
    siriClient.cache.clear();
    siriClient.consecutiveFailures = 0;
    siriClient.circuitOpenUntil = 0;
    const noAnswerXml = IDLE_LINE_XML.replace(/<Answer\s+xmlns=""\s*\/>/, '');
    siriClient.setHttpBackend(async () => ({ status: 200, bodyText: noAnswerXml }));

    await siriClient.getLiveVehicles('7');
    assert.strictEqual(siriClient.getUpstreamStatus().lastError, 'malformed');

    console.log('✅ siri_error_detection_test passed all assertions!');
  } finally {
    console.warn = origWarn;
    console.error = origError;
    siriClient.setHttpBackend(null);
  }
}

run().catch((err) => {
  console.error('❌ siri_error_detection_test failed:', err);
  process.exit(1);
});
