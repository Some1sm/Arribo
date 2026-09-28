'use strict';

const assert = require('node:assert/strict');
const client = require('../src/mataroSiriClient');

async function main() {
  console.log('🧪 Testing SIRI Parsing Robustness & Hygiene (Phase 8)...');

  // 1. Tag extraction with prefixes and tag name disambiguation
  console.log('Test 1: Tag extraction disambiguation and namespace prefixes');
  assert.strictEqual(
    client.extractTag('<DelayReason>Driver swap</DelayReason><Delay>PT2M</Delay>', 'Delay'),
    'PT2M',
    'extractTag should match <Delay> exactly and not be confused by <DelayReason>'
  );
  assert.strictEqual(
    client.extractTag('<siri:Latitude>41.5333</siri:Latitude>', 'Latitude'),
    '41.5333',
    'extractTag should match tags with namespace prefix <siri:Latitude>'
  );
  assert.strictEqual(
    client.extractTag('<siri:Longitude>2.4447</siri:Longitude>', 'Longitude'),
    '2.4447',
    'extractTag should match tags with namespace prefix <siri:Longitude>'
  );
  assert.strictEqual(
    client.extractTag('<tem:LineRef>1</tem:LineRef>', 'LineRef'),
    '1',
    'extractTag should match tags with arbitrary namespace prefix'
  );
  console.log('✓ extractTag prefix and exact name disambiguation verified.');

  // 2. Mataró Bounding Box Validation
  console.log('Test 2: Mataró coordinate bounding box sanity check (41.45-41.65, 2.30-2.55)');
  assert.strictEqual(client.isValidMataroCoord(41.5333, 2.4447), true, 'Valid Mataró coordinate should pass');
  assert.strictEqual(client.isValidMataroCoord(41.45, 2.30), true, 'Bounding box minimum edge should pass');
  assert.strictEqual(client.isValidMataroCoord(41.65, 2.55), true, 'Bounding box maximum edge should pass');
  assert.strictEqual(client.isValidMataroCoord(0, 0), false, 'Zero coordinate (0,0) must be rejected for Mataró');
  assert.strictEqual(client.isValidMataroCoord(41.44, 2.40), false, 'Latitude below 41.45 must be rejected');
  assert.strictEqual(client.isValidMataroCoord(41.66, 2.40), false, 'Latitude above 41.65 must be rejected');
  assert.strictEqual(client.isValidMataroCoord(41.53, 2.29), false, 'Longitude below 2.30 must be rejected');
  assert.strictEqual(client.isValidMataroCoord(41.53, 2.56), false, 'Longitude above 2.55 must be rejected');
  assert.strictEqual(client.isValidMataroCoord(NaN, 2.44), false, 'NaN latitude must be rejected');
  assert.strictEqual(client.isValidMataroCoord(41.53, Infinity), false, 'Infinite longitude must be rejected');
  console.log('✓ Mataró coordinate bounding box checks verified.');

  // 3. Rejected fixes counter in getUpstreamStatus
  console.log('Test 3: rejectedFixes counter and getUpstreamStatus');
  const initialStatus = client.getUpstreamStatus();
  assert.ok(typeof initialStatus.rejectedFixes === 'number', 'rejectedFixes must be reported in getUpstreamStatus');

  // Simulate parsing XML with valid and invalid vehicle coordinates
  const initialRejected = client.rejectedFixes;
  const mockHttpBackend = async () => ({
    status: 200,
    bodyText: `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:siri="http://www.siri.org.uk/siri">
  <soap:Body>
    <GetVehicleMonitoringResponse xmlns="http://tempuri.org/">
      <GetVehicleMonitoringResult>
        <siri:VehicleMonitoringDelivery version="2.0">
          <siri:ResponseTimestamp>${new Date().toISOString()}</siri:ResponseTimestamp>
          <siri:Status>true</siri:Status>
          <!-- Valid bus in Mataró -->
          <siri:VehicleActivity>
            <siri:RecordedAtTime>${new Date().toISOString()}</siri:RecordedAtTime>
            <siri:Latitude>41.5385</siri:Latitude>
            <siri:Longitude>2.4421</siri:Longitude>
            <siri:LineRef>1</siri:LineRef>
            <siri:VehicleRef>2680</siri:VehicleRef>
          </siri:VehicleActivity>
          <!-- Invalid bus with (0,0) coordinates -->
          <siri:VehicleActivity>
            <siri:RecordedAtTime>${new Date().toISOString()}</siri:RecordedAtTime>
            <siri:Latitude>0</siri:Latitude>
            <siri:Longitude>0</siri:Longitude>
            <siri:LineRef>1</siri:LineRef>
            <siri:VehicleRef>9999</siri:VehicleRef>
          </siri:VehicleActivity>
          <!-- Invalid bus outside Mataró (e.g. Madrid or ocean) -->
          <siri:VehicleActivity>
            <siri:RecordedAtTime>${new Date().toISOString()}</siri:RecordedAtTime>
            <siri:Latitude>40.4168</siri:Latitude>
            <siri:Longitude>-3.7038</siri:Longitude>
            <siri:LineRef>1</siri:LineRef>
            <siri:VehicleRef>8888</siri:VehicleRef>
          </siri:VehicleActivity>
        </siri:VehicleMonitoringDelivery>
      </GetVehicleMonitoringResult>
    </GetVehicleMonitoringResponse>
  </soap:Body>
</soap:Envelope>`
  });

  const prevBackend = client._httpBackend;
  client.setHttpBackend(mockHttpBackend);
  client.cache.clear();

  try {
    const vehicles = await client.getLiveVehicles('1');
    assert.strictEqual(vehicles.length, 1, 'Only the valid in-bounds vehicle should be returned');
    assert.strictEqual(vehicles[0].vehicleId, '2680', 'Returned vehicle should be 2680');
    assert.strictEqual(client.rejectedFixes, initialRejected + 2, 'Two invalid fixes should be counted in rejectedFixes');
    const updatedStatus = client.getUpstreamStatus();
    assert.strictEqual(updatedStatus.rejectedFixes, initialRejected + 2, 'getUpstreamStatus should reflect incremented rejectedFixes');
    console.log(`✓ Upstream rejectedFixes properly incremented to ${updatedStatus.rejectedFixes}`);
  } finally {
    client.setHttpBackend(prevBackend);
    client.cache.clear();
  }

  console.log('\n🎉 ALL SIRI BOUNDING BOX & ROBUSTNESS TESTS PASSED PERFECTLY!\n');
}

main().catch(err => {
  console.error('\n❌ SIRI BOUNDING BOX TEST FAILED:', err);
  process.exit(1);
});
