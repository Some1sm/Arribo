const assert = require('assert');
const http = require('http');
const app = require('../server');

let server;
const PORT = 3456;

function request(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    }).on('error', reject);
  });
}

async function runTests() {
  console.log('🧪 Starting Multi-Line Transit Platform E2E Tests...');

  server = app.listen(PORT);

  try {
    // 1. Health check
    console.log('Test 1: Health check');
    const health = await request('/api/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.status, 'ok');
    console.log('✅ Health check passed');

    // 2. All Lines
    console.log('Test 2: All Lines endpoint');
    const lines = await request('/api/lines');
    assert.strictEqual(lines.status, 200);
    assert(lines.body.lines.length >= 9, 'Should have at least 9 lines (C10 + L1..L8)');
    console.log(`✅ Lines endpoint passed (${lines.body.lines.length} lines loaded)`);

    // 3. Search Stops
    console.log('Test 3: Universal Stop Search');
    const search = await request('/api/search/stops?q=Hospital');
    assert.strictEqual(search.status, 200);
    assert(search.body.results.length > 0, 'Should find stops with "Hospital"');
    console.log(`✅ Universal Stop Search passed (${search.body.results.length} matches found)`);

    // 4. Mataró Line 8 details
    console.log('Test 4: Mataró Line 8 details');
    const line8 = await request('/api/mataro/line/8');
    assert.strictEqual(line8.status, 200);
    assert(line8.body.data.stops.length > 0, 'Line 8 should have stops');
    assert(line8.body.data.polyline.length > 0, 'Line 8 should have polyline');
    console.log(`✅ Mataró Line 8 passed (${line8.body.data.stops.length} stops, ${line8.body.data.polyline.length} polyline coords)`);

    // 5. Mataró Target ETA
    console.log('Test 5: Mataró Target ETA');
    const targetEta = await request('/api/mataro/target-eta?lineId=8');
    assert.strictEqual(targetEta.status, 200);
    assert(targetEta.body.data.targetStop !== null, 'Target stop should exist');
    console.log(`✅ Mataró Target ETA passed (Target: ${targetEta.body.data.targetStop.name})`);

    // 6. C-10 Target ETA
    console.log('Test 6: C-10 Target ETA');
    const c10Eta = await request('/api/c10/target-eta?direction=1');
    assert.strictEqual(c10Eta.status, 200);
    assert(c10Eta.body.data.targetStop !== null, 'C-10 Target stop should exist');
    console.log(`✅ C-10 Target ETA passed (Target: ${c10Eta.body.data.targetStop.name})`);

    // 7. C-10 Live Corridor
    console.log('Test 7: C-10 Live Corridor');
    const corridor = await request('/api/c10/live-corridor?direction=1');
    assert.strictEqual(corridor.status, 200);
    assert(corridor.body.data.checkpoints.length >= 9, 'Should have 9 corridor checkpoints');
    console.log(`✅ C-10 Live Corridor passed (${corridor.body.data.checkpoints.length} checkpoints)`);

    // 8. Universal Dynamic Endpoints
    console.log('Test 8: Universal Dynamic API Endpoints');
    const uLine = await request('/api/line/c10?direction=1');
    assert.strictEqual(uLine.status, 200);
    assert.strictEqual(uLine.body.data.code, 'C-10');
    const uEta = await request('/api/line/8/target-eta?direction=0');
    assert.strictEqual(uEta.status, 200);
    assert(uEta.body.data.targetStop !== null);
    console.log(`✅ Universal Dynamic Endpoints passed (Polymorphic API verified)`);

    console.log('\n🎉 ALL MULTI-LINE E2E TESTS PASSED SUCCESSFULLY! 🎉\n');
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  if (server) server.close();
  process.exit(1);
});
