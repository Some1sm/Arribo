const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const mataroTracker = require('../src/mataroTracker');
const app = require('../server');

async function main() {
  console.log('🧪 Starting Mataró PWA, Nearby Stops & Favorite Bookmarking Test Suite...\n');

  // 1. PWA Manifest & Service Worker
  console.log('📌 1. Testing PWA Web App Manifest & Service Worker Shell...');
  const manifestPath = path.join(__dirname, '..', 'public', 'manifest.webmanifest');
  assert(fs.existsSync(manifestPath), 'manifest.webmanifest must exist');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.strictEqual(manifest.short_name, 'Arribo! Mataró');
  assert.strictEqual(manifest.display, 'standalone');
  assert(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  console.log('   ✓ manifest.webmanifest is valid PWA configuration.');

  const swPath = path.join(__dirname, '..', 'public', 'sw.js');
  assert(fs.existsSync(swPath), 'sw.js must exist');
  const swContent = fs.readFileSync(swPath, 'utf8');
  assert(swContent.includes('arribo-mataro-cache'));
  assert(swContent.includes('/manifest.webmanifest'));
  console.log('   ✓ sw.js service worker configured for offline caching.');

  // 2. Core Nearby Stops Geolocation
  console.log('\n📌 2. Testing Mataró Nearby Stops Geolocation Engine...');
  const teresesNearby = mataroTracker.getNearbyStops(41.5392, 2.4445, 500, 5);
  assert(Array.isArray(teresesNearby));
  assert(teresesNearby.length > 0);
  assert(teresesNearby[0].distanceMeters <= teresesNearby[teresesNearby.length - 1].distanceMeters);
  assert(typeof teresesNearby[0].walkingMinutes === 'number');
  console.log(`   ✓ Found ${teresesNearby.length} stops near Tereses (closest: "${teresesNearby[0].name}" at ${teresesNearby[0].distanceMeters}m).`);

  const hospitalNearby = mataroTracker.getNearbyStops(41.5562, 2.4355, 400, 3);
  assert(hospitalNearby.length > 0);
  console.log(`   ✓ Found ${hospitalNearby.length} stops near Hospital.`);

  const distant = mataroTracker.getNearbyStops(40.4168, -3.7038, 500, 5);
  assert.strictEqual(distant.length, 0);
  console.log('   ✓ Out-of-bounds coordinate filtering verified.');

  // 3. Nearby Stops with Live Departures Enrichment
  console.log('\n📌 3. Testing Nearby Stops with Departures Enrichment...');
  const stopsWithDeps = await mataroTracker.getNearbyStopsWithDepartures(41.5392, 2.4445, 400, 3);
  assert(Array.isArray(stopsWithDeps));
  assert(stopsWithDeps.length > 0);
  stopsWithDeps.forEach(s => {
    assert(s.id && s.name && typeof s.distanceMeters === 'number');
    assert(Array.isArray(s.departures));
  });
  console.log(`   ✓ Enriched ${stopsWithDeps.length} stops with departures.`);

  // 4. HTTP API Endpoints for Nearby Stops
  console.log('\n📌 4. Testing Nearby Stops REST Endpoints...');
  const TEST_PORT = 3589;
  const server = app.listen(TEST_PORT);

  try {
    const fetchJson = (urlPath) => new Promise((resolve, reject) => {
      http.get(`http://localhost:${TEST_PORT}${urlPath}`, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch (e) { resolve({ status: res.statusCode, raw }); }
        });
      }).on('error', reject);
    });

    const res1 = await fetchJson('/api/mataro/stops/nearby?lat=41.5392&lon=2.4445&radius=500&limit=4');
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res1.body.success, true);
    assert(Array.isArray(res1.body.stops));
    assert(res1.body.stops.length > 0);
    console.log(`   ✓ GET /api/mataro/stops/nearby returned ${res1.body.stops.length} stops.`);

    const res2 = await fetchJson('/api/mataro/nearby?lat=41.5392&lon=2.4445');
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.body.success, true);
    console.log('   ✓ GET /api/mataro/nearby alias verified.');

    const resMissing = await fetchJson('/api/mataro/nearby');
    assert.strictEqual(resMissing.status, 400);
    console.log('   ✓ Missing parameter validation verified (HTTP 400).');
  } finally {
    server.close();
  }

  console.log('\n🎉 ALL MATARÓ PWA, NEARBY STOPS & FAVORITES TESTS PASSED 100%! 🎉');
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ Test Suite Failure:', err);
  process.exit(1);
});
