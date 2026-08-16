const assert = require('assert');

async function testServer() {
  const baseUrl = 'http://localhost:3000';

  console.log('Testing E2E Endpoints on', baseUrl);

  // 1. Health
  console.log('Testing GET /api/health...');
  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.strictEqual(healthRes.status, 200);
  const healthJson = await healthRes.json();
  assert.strictEqual(healthJson.status, 'ok');
  console.log('  ✅ /api/health OK');

  // 2. Static files
  console.log('Testing GET / (index.html)...');
  const indexRes = await fetch(`${baseUrl}/`);
  assert.strictEqual(indexRes.status, 200);
  const indexHtml = await indexRes.text();
  assert(indexHtml.includes("Itàlia") || indexHtml.includes("C10"), 'HTML should contain line or target stop');
  console.log('  ✅ Static index.html OK');

  console.log('Testing GET /css/style.css...');
  const cssRes = await fetch(`${baseUrl}/css/style.css`);
  assert.strictEqual(cssRes.status, 200);
  console.log('  ✅ /css/style.css OK');

  console.log('Testing GET /js/app.js...');
  const appJsRes = await fetch(`${baseUrl}/js/app.js`);
  assert.strictEqual(appJsRes.status, 200);
  console.log('  ✅ /js/app.js OK');

  // 3. Target ETA Dir 1
  console.log('Testing GET /api/c10/target-eta?direction=1...');
  const eta1Res = await fetch(`${baseUrl}/api/c10/target-eta?direction=1`);
  assert.strictEqual(eta1Res.status, 200);
  const eta1Json = await eta1Res.json();
  assert(eta1Json.success, 'ETA Dir 1 should succeed');
  assert(eta1Json.data.targetStop, 'Should contain targetStop');
  assert(eta1Json.data.upcomingDepartures.length > 0, 'Should have upcoming departures');
  console.log(`  ✅ /api/c10/target-eta?direction=1 OK -> Next: ${eta1Json.data.nextBus?.departureTime} (${eta1Json.data.nextBus?.formattedStatus})`);

  // 4. Target ETA Dir 0
  console.log('Testing GET /api/c10/target-eta?direction=0...');
  const eta0Res = await fetch(`${baseUrl}/api/c10/target-eta?direction=0`);
  assert.strictEqual(eta0Res.status, 200);
  const eta0Json = await eta0Res.json();
  assert(eta0Json.success, 'ETA Dir 0 should succeed');
  console.log(`  ✅ /api/c10/target-eta?direction=0 OK -> Next: ${eta0Json.data.nextBus?.departureTime} (${eta0Json.data.nextBus?.formattedStatus})`);

  // 5. Stops Dir 1
  console.log('Testing GET /api/c10/stops?direction=1...');
  const stops1Res = await fetch(`${baseUrl}/api/c10/stops?direction=1`);
  assert.strictEqual(stops1Res.status, 200);
  const stops1Json = await stops1Res.json();
  assert.strictEqual(stops1Json.success, true);
  assert(stops1Json.stops.length >= 40, 'Should have at least 40 stops');
  console.log(`  ✅ /api/c10/stops?direction=1 OK -> ${stops1Json.totalStops} stops`);

  // 6. Stop departures (Plaça d'Itàlia)
  console.log('Testing GET /api/c10/stop/10037202/departures?direction=1...');
  const stopDepRes = await fetch(`${baseUrl}/api/c10/stop/10037202/departures?direction=1`);
  assert.strictEqual(stopDepRes.status, 200);
  const stopDepJson = await stopDepRes.json();
  assert.strictEqual(stopDepJson.success, true);
  console.log(`  ✅ /api/c10/stop/10037202/departures OK -> ${stopDepJson.data.departures.length} departures`);

  // 7. Live Corridor Tracking
  console.log('Testing GET /api/c10/live-corridor?direction=1...');
  const corrRes = await fetch(`${baseUrl}/api/c10/live-corridor?direction=1`);
  assert.strictEqual(corrRes.status, 200);
  const corrJson = await corrRes.json();
  assert.strictEqual(corrJson.success, true);
  assert(corrJson.data.checkpoints.length >= 8, 'Should have checkpoints');
  console.log(`  ✅ /api/c10/live-corridor OK -> ${corrJson.data.checkpoints.length} checkpoints, ${corrJson.data.activeBuses.length} active buses`);

  console.log('\n🎉 ALL E2E TESTS PASSED 100% SUCCESSFULLY!');
}

testServer().catch(err => {
  console.error('❌ E2E TEST FAILED:', err);
  process.exit(1);
});
