const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const flightRecorder = require('../src/flightRecorder');
const mataroTracker = require('../src/mataroTracker');

console.log('🧪 Running Terminal Layover Oscillation & Attribution Fixes Tests...\n');

// ---------------------------------------------------------------------------
// 1. Verify Layover Metadata Preservation in FlightRecorder & IPC Fleet Sync
// ---------------------------------------------------------------------------
console.log('1. Testing FlightRecorder Layover Metadata Ingestion and Worker Sync...');

flightRecorder.vehicles.clear();
flightRecorder.lineIndex.clear();

const sampleLayoverVehicle = {
  vehicleId: 'mataro_1_2683',
  lineId: '1',
  lineCode: 'L1',
  agency: 'Mataró Bus (Avanza)',
  direction: '1',
  plateNumber: '2683',
  lat: 41.5325,
  lon: 2.4445,
  latitude: 41.5325,
  longitude: 2.4445,
  speedKmh: 0,
  bearing: 90,
  delayMins: 0,
  destination: 'Estació Rodalies',
  isRealTime: true,
  isEstimated: false,
  serviceableMs: 90000,
  isTerminalLayover: true,
  fromStop: 'El Cargol',
  toStop: 'Estació Rodalies',
  fromSeq: 27,
  toSeq: 28,
  totalProgress: 100,
  distanceToNextMeters: 18
};

flightRecorder.ingestVehicle(sampleLayoverVehicle);

const recordedVeh = flightRecorder.vehicles.get('mataro_1_2683');
assert.ok(recordedVeh, 'Vehicle must be ingested into FlightRecorder');
assert.strictEqual(recordedVeh.isTerminalLayover, true, 'isTerminalLayover must be preserved');
assert.strictEqual(recordedVeh.fromStop, 'El Cargol', 'fromStop must be preserved');
assert.strictEqual(recordedVeh.toStop, 'Estació Rodalies', 'toStop must be preserved');
assert.strictEqual(recordedVeh.fromSeq, 27, 'fromSeq must be preserved');
assert.strictEqual(recordedVeh.toSeq, 28, 'toSeq must be preserved');
assert.strictEqual(recordedVeh.totalProgress, 100, 'totalProgress must be preserved');
assert.strictEqual(recordedVeh.distanceToNextMeters, 18, 'distanceToNextMeters must be preserved');

// Verify that getAllVehicles preserves these fields for FLEET_UPDATE serialization
const allVehs = flightRecorder.getAllVehicles();
const foundInAll = allVehs.find(v => v.vehicleId === 'mataro_1_2683');
assert.ok(foundInAll, 'Vehicle must be returned by getAllVehicles()');
assert.strictEqual(foundInAll.isTerminalLayover, true, 'getAllVehicles() must retain isTerminalLayover');
assert.strictEqual(foundInAll.toStop, 'Estació Rodalies', 'getAllVehicles() must retain toStop');

// Test IPC sync: syncFleetFromWorker
flightRecorder.syncFleetFromWorker([foundInAll]);
const syncedVeh = flightRecorder.vehicles.get('mataro_1_2683');
assert.ok(syncedVeh, 'Vehicle must exist after syncFleetFromWorker');
assert.strictEqual(syncedVeh.isTerminalLayover, true, 'syncFleetFromWorker must retain isTerminalLayover');
assert.strictEqual(syncedVeh.fromStop, 'El Cargol', 'syncFleetFromWorker must retain fromStop');
assert.strictEqual(syncedVeh.toStop, 'Estació Rodalies', 'syncFleetFromWorker must retain toStop');
assert.strictEqual(syncedVeh.totalProgress, 100, 'syncFleetFromWorker must retain totalProgress');
assert.strictEqual(syncedVeh.distanceToNextMeters, 18, 'syncFleetFromWorker must retain distanceToNextMeters');

// Test transition from layover -> moving bus
flightRecorder.ingestVehicle({
  ...sampleLayoverVehicle,
  speedKmh: 24,
  isTerminalLayover: false,
  fromStop: 'Rodalies',
  toStop: 'Ronda Barceló',
  fromSeq: 1,
  toSeq: 2,
  totalProgress: 15,
  distanceToNextMeters: 200
});
const updatedMovingVeh = flightRecorder.vehicles.get('mataro_1_2683');
assert.strictEqual(updatedMovingVeh.isTerminalLayover, false, 'isTerminalLayover must update to false when vehicle resumes movement');
assert.strictEqual(updatedMovingVeh.speedKmh, 24, 'speedKmh must update');
assert.strictEqual(updatedMovingVeh.fromStop, 'Rodalies', 'fromStop must update');
assert.strictEqual(updatedMovingVeh.toStop, 'Ronda Barceló', 'toStop must update');

console.log('   ✓ FlightRecorder and syncFleetFromWorker layover metadata preservation verified.\n');

// ---------------------------------------------------------------------------
// 2. Verify Polling Countdown Overwrite Fix in public/js/app.js
// ---------------------------------------------------------------------------
console.log('2. Testing Polling Countdown Overwrite in public/js/app.js...');

const appJsPath = path.join(__dirname, '..', 'public', 'js', 'app.js');
const appJsContent = fs.readFileSync(appJsPath, 'utf8');

// Ensure no bare 'this.secondsRemaining = this.pollInterval;' in refreshAllData
const refreshAllDataMatch = appJsContent.match(/async refreshAllData\(shouldFitBounds = false\) \{([\s\S]*?)finally \{/);
assert.ok(refreshAllDataMatch, 'refreshAllData method must be found in app.js');
const refreshBody = refreshAllDataMatch[1];

assert.ok(
  !refreshBody.includes('this.secondsRemaining = this.pollInterval;'),
  'refreshAllData must not contain bare "this.secondsRemaining = this.pollInterval;"'
);

// The invariant here is STRUCTURAL: the countdown must respect the SSE backoff
// rather than resetting to the bare 20s pollInterval, and there must be exactly
// two such guards (entry and exit). The backoff VALUE is a tunable served by the
// named constant sseRestRefreshSec, so it is deliberately not asserted here --
// pinning a literal number would make ordinary tuning a test-breaking change.
const matches = refreshBody.match(/this\.secondsRemaining\s*=\s*this\.fleetStreamOk\s*\?\s*this\.sseRestRefreshSec\s*:\s*this\.pollInterval;/g);
assert.ok(matches && matches.length === 2, 'refreshAllData must contain exactly 2 fleetStreamOk backoff guards (entry and exit)');

console.log('   ✓ app.js polling countdown backoff preservation verified.\n');

// ---------------------------------------------------------------------------
// 3. Verify Layover Stop Name Fix in public/js/map.js
// ---------------------------------------------------------------------------
console.log('3. Testing Layover Stop Name Logic in public/js/map.js...');

const mapJsPath = path.join(__dirname, '..', 'public', 'js', 'map.js');
const mapJsContent = fs.readFileSync(mapJsPath, 'utf8');

// Ensure map.js uses totalProgress >= 90 && bus.toStop to choose toStop over fromStop
assert.ok(
  mapJsContent.includes('bus.totalProgress >= 90 && bus.toStop'),
  'map.js must check "bus.totalProgress >= 90 && bus.toStop" in layover ribbon'
);

// Simulate the expression behavior
const testLayoverRender = (bus, fromStop, toStop) => {
  return ((bus.totalProgress >= 90 && bus.toStop) ? toStop : fromStop) || 'Capçalera de Línia';
};

const inboundLayoverBus = {
  totalProgress: 100,
  toStop: 'Estació Rodalies',
  fromStop: 'El Cargol'
};
assert.strictEqual(
  testLayoverRender(inboundLayoverBus, inboundLayoverBus.fromStop, inboundLayoverBus.toStop),
  'Estació Rodalies',
  'Inbound terminus layover must display destination terminus stop name, not penultimate stop'
);

const outboundLayoverBus = {
  totalProgress: 0,
  toStop: 'Camí Ral',
  fromStop: 'Estació Rodalies'
};
assert.strictEqual(
  testLayoverRender(outboundLayoverBus, outboundLayoverBus.fromStop, outboundLayoverBus.toStop),
  'Estació Rodalies',
  'Outbound terminus layover must display origin stop name'
);

console.log('   ✓ map.js terminus layover stop name attribution verified.\n');

// ---------------------------------------------------------------------------
// 4. Verify Platform Proximity Gating in mataroTracker.js
// ---------------------------------------------------------------------------
console.log('4. Testing Platform Proximity Gating in mataroTracker.js...');

const mataroTrackerPath = path.join(__dirname, '..', 'src', 'mataroTracker.js');
const mataroTrackerContent = fs.readFileSync(mataroTrackerPath, 'utf8');

// Ensure platform proximity constraint is present in mataroTracker.js
assert.ok(
  mataroTrackerContent.includes('segInfo.distanceToNextMeters <= 50'),
  'mataroTracker.js must gate totalProgress > 92 on segInfo.distanceToNextMeters <= 50'
);

// Verify logic directly:
const isTerminalCheck = (speedKmh, totalProgress, distanceToNextMeters) => {
  return (speedKmh <= 3 || speedKmh === undefined) &&
    ((totalProgress > 92 && distanceToNextMeters <= 50) || totalProgress < 8);
};

// Scenario A: Queued at red light on Carrer Churruca (120m away from Rodalies, speed 0 km/h)
const queuedAtRedLight = isTerminalCheck(0, 96, 120);
assert.strictEqual(queuedAtRedLight, false, 'Bus queued at red light (120m away) must NOT be marked as terminal layover');

// Scenario B: Arrived at platform at Rodalies (15m away, speed 0 km/h)
const arrivedAtPlatform = isTerminalCheck(0, 100, 15);
assert.strictEqual(arrivedAtPlatform, true, 'Bus arrived at platform (15m away) MUST be marked as terminal layover');

// Scenario C: Moving at normal speed near platform (30 km/h)
const movingNearPlatform = isTerminalCheck(30, 98, 20);
assert.strictEqual(movingNearPlatform, false, 'Moving bus must not be marked as terminal layover');

// Scenario D: At origin terminal waiting to depart (progress < 8, speed 0 km/h)
const waitingAtOrigin = isTerminalCheck(0, 0, 300);
assert.strictEqual(waitingAtOrigin, true, 'Bus at origin terminal must be marked as terminal layover');

// Scenario E: Real GIS check using MataroTracker Line 1 Route 0 & Route 1
const line1Routes = mataroTracker.routesData['1'];
assert.ok(line1Routes && line1Routes.length >= 2, 'Line 1 must have at least 2 route directions');
const inboundRoute = line1Routes[0];
const inboundStops = inboundRoute.stops;
const inboundPoly = mataroTracker.shapesCache.get('1_0');

// Bus 2683 at Rodalies platform (Stop 1016: 41.5333, 2.44474)
const platformSeg = mataroTracker.findNearestSegment(41.5333, 2.44474, inboundStops, inboundPoly);
assert.strictEqual(platformSeg.toStop, 'Rodalies - 1016');
assert.ok(platformSeg.totalProgress > 92, 'Total progress at terminus must be > 92');
assert.ok(platformSeg.distanceToNextMeters <= 50, 'Platform distance must be <= 50m');
const isLayoverAtPlatform = (0 <= 3) && ((platformSeg.totalProgress > 92 && platformSeg.distanceToNextMeters <= 50) || platformSeg.totalProgress < 8);
assert.strictEqual(isLayoverAtPlatform, true, 'Real Stop 1016 at speed 0 must trigger isTerminal');

// Bus 2683 queued at red light on Carrer Churruca (41.5340, 2.4455, ~100m away)
const redLightSeg = mataroTracker.findNearestSegment(41.5340, 2.4455, inboundStops, inboundPoly);
assert.ok(redLightSeg.totalProgress > 92, 'Total progress on Churruca is > 92');
assert.ok(redLightSeg.distanceToNextMeters > 50, 'Distance on Churruca must be > 50m');
const isLayoverAtRedLight = (0 <= 3) && ((redLightSeg.totalProgress > 92 && redLightSeg.distanceToNextMeters <= 50) || redLightSeg.totalProgress < 8);
assert.strictEqual(isLayoverAtRedLight, false, 'Bus stopped at red light on Churruca must NOT trigger isTerminal');

console.log('   ✓ Platform proximity gating logic and real GIS route segments verified.\n');

console.log('🎉 ALL 4 TERMINAL LAYOVER FIXES VERIFIED SUCCESSFULLY!\n');
