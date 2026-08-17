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

    // 9. Sagalés N82 Real-time API
    console.log('Test 9: Sagalés N82 Night Bus Integration');
    const n82Line = await request('/api/line/n82?direction=0');
    assert.strictEqual(n82Line.status, 200);
    assert.strictEqual(n82Line.body.data.code, 'N82');
    assert(n82Line.body.data.stops.length >= 10, 'N82 should have stops');
    assert(n82Line.body.data.coords.length >= 500, 'N82 should have decoded polyline');
    const n82Eta = await request('/api/line/n82/target-eta?direction=0');
    assert.strictEqual(n82Eta.status, 200);
    assert(n82Eta.body.data.targetStop !== null);
    console.log(`✅ Sagalés N82 passed (${n82Line.body.data.stops.length} stops, ${n82Line.body.data.coords.length} polyline coords)`);

    // 10. Rodalies de Catalunya Trains (R1)
    console.log('Test 10: Rodalies de Catalunya Trains (R1)');
    const r1Line = await request('/api/line/r1?direction=0');
    assert.strictEqual(r1Line.status, 200);
    assert.strictEqual(r1Line.body.data.code, 'R1');
    assert.strictEqual(r1Line.body.data.isTrain, true);
    assert(r1Line.body.data.stops.length >= 20, 'R1 should have >= 20 train stations');
    assert(r1Line.body.data.coords.length >= 100, 'R1 should have track coordinates');
    const r1Eta = await request('/api/line/r1/target-eta?direction=0');
    assert.strictEqual(r1Eta.status, 200);
    assert(r1Eta.body.data.targetStop !== null);
    console.log(`✅ Rodalies R1 passed (${r1Line.body.data.stops.length} stations, ${r1Line.body.data.coords.length} track coords, ${r1Line.body.data.activeBuses.length} live trains)`);

    // 11. DIREXIS TUSGSAL (B25)
    console.log('Test 11: DIREXIS TUSGSAL Bus Line (B25)');
    const b25Line = await request('/api/line/b25?direction=0');
    assert.strictEqual(b25Line.status, 200);
    assert.strictEqual(b25Line.body.data.code, 'B25');
    assert(b25Line.body.data.stops.length >= 15, 'B25 should have stops');
    const b25Eta = await request('/api/line/b25/target-eta?direction=0');
    assert.strictEqual(b25Eta.status, 200);
    assert(b25Eta.body.data.targetStop !== null);
    console.log(`✅ TUSGSAL B25 passed (${b25Line.body.data.stops.length} stops, Agency: ${b25Line.body.data.agency})`);

    // 12. Avanza Baix Llobregat (L80)
    console.log('Test 12: Avanza Baix Llobregat Bus Line (L80)');
    const l80Line = await request('/api/line/l80?direction=0');
    assert.strictEqual(l80Line.status, 200);
    assert.strictEqual(l80Line.body.data.code, 'L80');
    assert(l80Line.body.data.stops.length >= 15, 'L80 should have stops');
    console.log(`✅ Avanza L80 passed (${l80Line.body.data.stops.length} stops, Agency: ${l80Line.body.data.agency})`);

    // 13. Monbus Aerobús (A1)
    console.log('Test 13: Monbus Aerobús Line (A1)');
    const a1Line = await request('/api/line/a1?direction=0');
    assert.strictEqual(a1Line.status, 200);
    assert.strictEqual(a1Line.body.data.code, 'A1');
    assert(a1Line.body.data.stops.length >= 4, 'A1 should have stops');
    console.log(`✅ Monbus Aerobús A1 passed (${a1Line.body.data.stops.length} stops, Agency: ${a1Line.body.data.agency})`);

    // 14. Moventis / Casas NitBus N80
    console.log('Test 14: Moventis / Casas NitBus N80 Line');
    const n80Line = await request('/api/line/n80?direction=0');
    assert.strictEqual(n80Line.status, 200);
    assert.strictEqual(n80Line.body.data.code, 'N80');
    assert(n80Line.body.data.stops.length >= 25, 'N80 should have >= 25 stops');
    assert(n80Line.body.data.coords.length >= 500, 'N80 should have >= 500 shape points');
    const n80Eta = await request('/api/line/n80/target-eta?direction=0');
    assert.strictEqual(n80Eta.status, 200);
    assert(n80Eta.body.data.targetStop !== null);
    console.log(`✅ Moventis N80 passed (${n80Line.body.data.stops.length} stops, ${n80Line.body.data.coords.length} polyline coords)`);

    console.log('\n🎉 ALL MULTI-LINE & MULTI-PROVIDER E2E TESTS PASSED SUCCESSFULLY! 🎉\n');
  } finally {
    const ingestionDaemon = require('../src/ingestionDaemon');
    ingestionDaemon.stop();
    server.close();
    process.exit(0);
  }
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  if (server) server.close();
  process.exit(1);
});
