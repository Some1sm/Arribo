/**
 * test/observation_clock_test.js
 *
 * Regression coverage for the observation-vs-ingest clock separation and the
 * "missing values stay missing" rules:
 *
 *  - D1: a derived/dead-reckoned re-ingest (a re-mint of our own previous
 *    output) must NOT refresh the observation clock, so a bus that lost real
 *    telemetry still goes stale and is evicted even while the tracker re-feeds
 *    it every poll.
 *  - D3: a missing <Velocity> stays UNKNOWN (null) and is distinguishable from
 *    a genuine measured 0; a missing <Delay> stays unknown too (D4).
 *  - D6: dead reckoning accumulates across ticks within the 90s budget rather
 *    than firing exactly once.
 *
 * Runs entirely in-memory (no HTTP server, no SQLite). The flight recorder is
 * a singleton, so the test clears its state and disables the background
 * extrapolator for determinism.
 */

const flightRecorder = require('../src/flightRecorder');
const siriClient = require('../src/mataroSiriClient');

let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) { passed++; console.log(`  ok  ${msg}`); }
  else { failed++; console.error(`  FAIL ${msg}`); }
}

function resetRecorder() {
  flightRecorder.setAutoExtrapolation(false);
  flightRecorder.vehicles.clear();
  flightRecorder.lineIndex.clear();
}

console.log('🧪 Observation clock & missing-value regression tests');

// ---------------------------------------------------------------------------
console.log('\n— D1: a re-ingested estimated vehicle must eventually go stale —');
{
  resetRecorder();
  const now = Date.now();

  // A bus last REALLY observed 91s ago, then repeatedly re-minted from our own
  // previous output (isEstimated: true) every poll. lastSeen advances on each
  // re-ingest (ingest clock); observedAt must NOT.
  flightRecorder.ingestVehicle({
    vehicleId: 'D1_BUS',
    lineId: '1',
    lineCode: 'L1',
    lat: 41.54, lon: 2.44,
    speedKmh: 30, bearing: 0, delayMins: 0,
    isEstimated: false, isRealTime: true,
    observedAt: now - 91000 // last real fix was 91s ago
  });

  // Simulate the re-ingest loop: our own previous (estimated) output fed back in.
  for (let i = 0; i < 5; i++) {
    flightRecorder.ingestVehicle({
      vehicleId: 'D1_BUS',
      lineId: '1',
      lineCode: 'L1',
      lat: 41.54, lon: 2.44,
      speedKmh: 30, bearing: 0, delayMins: 0,
      isEstimated: true, isRealTime: false, // derived re-mint
      observedAt: now - 91000 // carries the SAME real observation time
    });
  }

  const v = flightRecorder.vehicles.get('D1_BUS');
  check(!!v, 'D1: vehicle still present before eviction tick');
  check(v && v.observedAt === now - 91000,
    'D1: derived re-ingest did NOT advance the observation clock');
  check(v && (Date.now() - v.lastSeen) < 5000,
    'D1: derived re-ingest DID advance the ingest clock (lastSeen)');

  // The staleness gate must reject it on real observation age, not lastSeen.
  check(flightRecorder.getAllVehicles().length === 0,
    'D1: stale-by-observation vehicle is not served (re-ingest loop defeated)');

  // The periodic delete (bounded by the 90s window) must also drop it.
  flightRecorder.extrapolateStaleVehicles();
  check(!flightRecorder.vehicles.has('D1_BUS'),
    'D1: stale-by-observation vehicle evicted by extrapolateStaleVehicles');
}

// ---------------------------------------------------------------------------
console.log('\n— D2: a fresh real fix DOES advance the observation clock —');
{
  resetRecorder();
  const now = Date.now();
  flightRecorder.ingestVehicle({
    vehicleId: 'D2_BUS', lineId: '1', lineCode: 'L1',
    lat: 41.54, lon: 2.44, speedKmh: 30, bearing: 0, delayMins: 0,
    isEstimated: false, isRealTime: true,
    observedAt: now - 20000
  });
  // A genuinely fresh observation arrives later.
  flightRecorder.ingestVehicle({
    vehicleId: 'D2_BUS', lineId: '1', lineCode: 'L1',
    lat: 41.54, lon: 2.44, speedKmh: 30, bearing: 0, delayMins: 0,
    isEstimated: false, isRealTime: true,
    observedAt: now
  });
  const v = flightRecorder.vehicles.get('D2_BUS');
  check(v && v.observedAt === now, 'D2: fresh real fix advances observedAt');
  check(flightRecorder.getAllVehicles().length === 1, 'D2: fresh vehicle is serviceable');
}

// ---------------------------------------------------------------------------
console.log('\n— D6: dead reckoning accumulates across ticks within the budget —');
{
  resetRecorder();
  const now = Date.now();
  flightRecorder.ingestVehicle({
    vehicleId: 'D6_BUS', lineId: '1', lineCode: 'L1',
    lat: 41.54, lon: 2.44, speedKmh: 30, bearing: 90, delayMins: 0,
    isEstimated: false, isRealTime: true,
    observedAt: now - 20000, lastSeen: now - 20000
  });
  const startLon = flightRecorder.vehicles.get('D6_BUS').lon;
  // 3 ticks; each should advance the position and the cumulative budget.
  for (let i = 0; i < 3; i++) flightRecorder.extrapolateStaleVehicles();
  const v = flightRecorder.vehicles.get('D6_BUS');
  check(!!v, 'D6: vehicle not evicted within budget');
  check(v && v.extrapolatedMs === 15000, 'D6: extrapolatedMs accumulates (0→5000→10000→15000)');
  // bearing 90 (east) => lon must increase measurably beyond a single 5s step.
  const singleStep = (30 * 1000 / 3600) * 5 / (111320 * Math.cos(41.54 * Math.PI / 180));
  check(v && (v.lon - startLon) > singleStep * 2,
    'D6: position advances cumulatively, not just once');
  check(v && v.extrapolatedMs <= flightRecorder.maxExtrapolationMs,
    'D6: cumulative projection stays within the 90s budget');
}

// ---------------------------------------------------------------------------
async function runSiriChecks() {
  console.log('\n— D3/D4: missing <Velocity> and <Delay> stay unknown —');
  resetRecorder();
  const origCallSoap = siriClient.callSoap;
  const buildXml = (inner) => `<?xml version="1.0"?><SiriServiceResponse><ServiceDelivery>
    <VehicleMonitoringDelivery><VehicleActivity>${inner}</VehicleActivity></VehicleMonitoringDelivery>
  </ServiceDelivery></SiriServiceResponse>`;
  const vehicleXml = (fields) => buildXml(`
    <VehicleRef>BUSX</VehicleRef>
    <LineRef>1</LineRef>
    <Latitude>41.54</Latitude><Longitude>2.44</Longitude>
    <Bearing>90</Bearing>
    <RecordedAtTime>${new Date().toISOString()}</RecordedAtTime>
    ${fields}`);

  try {
    // (a) No <Velocity> and no <Delay>: both unknown.
    siriClient.cache.clear();
    siriClient._inflight.clear();
    siriClient.callSoap = async () => vehicleXml('');
    let vs = await siriClient.getLiveVehicles('D3TEST');
    check(vs.length === 1, 'D3: parsed one vehicle with no Velocity/Delay');
    check(vs[0].speedKmh === null, 'D3: missing <Velocity> -> speedKmh is null (unknown), not 25');
    check(vs[0].hasSpeed === false, 'D3: hasSpeed=false for missing <Velocity>');
    check(vs[0].delayMins === null, 'D4: missing <Delay> -> delayMins is null (unknown), not 0');
    check(vs[0].hasDelay === false, 'D4: hasDelay=false for missing <Delay>');

    // (b) A genuine measured 0 velocity and a genuine PT0M delay stay measurements.
    siriClient.cache.clear();
    siriClient._inflight.clear();
    siriClient.callSoap = async () => vehicleXml('<Velocity>0</Velocity><Delay>PT0M</Delay>');
    vs = await siriClient.getLiveVehicles('D3TEST');
    check(vs[0].speedKmh === 0, 'D3: measured <Velocity>0</Velocity> stays a real 0');
    check(vs[0].hasSpeed === true, 'D3: hasSpeed=true for measured 0');
    check(vs[0].delayMins === 0 && vs[0].hasDelay === true,
      'D4: measured <Delay>PT0M</Delay> stays a real 0 (distinct from unknown)');

    // (c) Unparseable <Velocity> is also unknown, not 25.
    siriClient.cache.clear();
    siriClient._inflight.clear();
    siriClient.callSoap = async () => vehicleXml('<Velocity>abc</Velocity>');
    vs = await siriClient.getLiveVehicles('D3TEST');
    check(vs[0].speedKmh === null, 'D3: unparseable <Velocity> -> null (unknown)');
  } finally {
    siriClient.callSoap = origCallSoap;
    siriClient.cache.clear();
    siriClient._inflight.clear();
    resetRecorder();
  }
}

async function main() {
  await runSiriChecks();

  // -------------------------------------------------------------------------
  console.log('\n— D3: unknown speed does not defeat the stationary/terminal gate —');
  resetRecorder();
  const mataroTracker = require('../src/mataroTracker');
  // A bus at the very start of the route (totalProgress < 8) with UNKNOWN
  // speed. It must be treated as "not confirmed moving" so the terminal gate
  // can fire — i.e. unknown must NOT be coerced into a moving 25 km/h.
  const out = mataroTracker.processBusesWithDeadReckoning(
    [{
      vehicleId: 'D3_GATE', lineId: '1', lat: 41.54, lon: 2.44,
      speedKmh: null, hasSpeed: false, delayMins: null, hasDelay: false,
      isEstimated: false, isRealTime: true, timestamp: Date.now()
    }],
    { id_linea: '1', name: 'L1', coords: [], stops: [] },
    [], '0', [], new Date()
  );
  const bus = out[0];
  check(bus && bus.speedKmh === null, 'D3: unknown speed stays null on the emitted bus');
  check(bus && bus.hasSpeed === false, 'D3: hasSpeed=false on the emitted bus');
  resetRecorder();
}

main().then(() => {
  resetRecorder();
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) process.exit(1);
  console.log('ALL OBSERVATION CLOCK TESTS PASSED');
}).catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
