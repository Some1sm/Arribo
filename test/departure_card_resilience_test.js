// The vehicle fixture models active daytime service, independent of execution time.
const NativeDate = Date;
const fixtureNow = NativeDate.parse('2026-09-18T10:00:00Z');
global.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [fixtureNow])); }
  static now() { return fixtureNow; }
};

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const https = require('node:https');

const mataroTracker = require('../src/mataroTracker');
const mataroSiriClient = require('../src/mataroSiriClient');

console.log('🧪 Running Departure Card Resilience & Suffix Stripping Tests...\n');

// ---------------------------------------------------------------------------
// Helper: Load public/js/app.js TransitApp in a controlled headless environment
// ---------------------------------------------------------------------------
function createTestApp() {
  const elements = {};
  const appJsCode = fs.readFileSync(path.join(__dirname, '../public/js/app.js'), 'utf8');

  const ctx = {
    console,
    window: {},
    document: {
      hidden: false,
      addEventListener: () => {},
      getElementById: (id) => {
        if (!elements[id]) {
          elements[id] = {
            innerHTML: '',
            textContent: '',
            classList: {
              contains: () => false,
              add: () => {},
              remove: () => {},
              toggle: () => {}
            },
            querySelectorAll: () => []
          };
        }
        return elements[id];
      },
      querySelector: () => null
    },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    URLSearchParams: class { get() { return null; } },
    navigator: { onLine: true },
    addEventListener: () => {},
    location: { hash: '', search: '' },
    requestAnimationFrame: () => {}
  };
  ctx.window = ctx;

  vm.runInNewContext(appJsCode + '\n; this.TransitApp = TransitApp;', ctx);

  const app = Object.create(ctx.TransitApp.prototype);
  app.esc = s => s || '';
  app.formatTimeHHMM = s => s || '';
  app.resolveBusForDeparture = () => null;
  app.timeStringToSeconds = s => {
    if (!s || !s.includes(':')) return 0;
    const [h, m] = s.split(':').map(Number);
    return (h * 3600) + (m * 60);
  };

  return { app, elements };
}

// ---------------------------------------------------------------------------
// 1. SIRI SOAP Timeout Resilience (mataroSiriClient.js)
// ---------------------------------------------------------------------------
console.log('1. Testing SIRI SOAP Timeout Resilience...');

// 1.1 Verify static code invariant
const siriClientCode = fs.readFileSync(path.join(__dirname, '../src/mataroSiriClient.js'), 'utf8');
const timeoutMatch = siriClientCode.match(/timeout:\s*(\d+)/);
assert.ok(timeoutMatch, 'mataroSiriClient.js must specify a timeout in HTTPS options');
assert.strictEqual(Number(timeoutMatch[1]), 3500, 'SIRI request timeout must be 3500ms');

// 1.2 Verify runtime options passed to https.request
let capturedOptions = null;
const origRequest = https.request;
https.request = function(options, cb) {
  capturedOptions = options;
  const mockReq = {
    on: () => mockReq,
    write: () => {},
    end: () => {},
    destroy: () => {}
  };
  return mockReq;
};

try {
  mataroSiriClient.setHttpBackend(null);
  mataroSiriClient.setRpcBackend(null);
  mataroSiriClient.callSoap('TestOp', '<xml/>');
  assert.ok(capturedOptions, 'https.request must be called');
  assert.strictEqual(capturedOptions.timeout, 3500, 'https.request options.timeout must be 3500ms');
} finally {
  https.request = origRequest;
}

console.log('   ✓ SIRI SOAP timeout resilience (3500ms) verified.\n');

// ---------------------------------------------------------------------------
// 2. Destination Stop Code Suffix Stripping & Delayed GPS Estimates (mataroTracker.js)
// ---------------------------------------------------------------------------
console.log('2. Testing Destination Stop Code Suffix Stripping in estimateArrivalsForStop...');

// 2.1 String cleaning unit assertions (including trailing whitespace resilience)
const cleanDestRegex = /\s*-\s*\d+\s*$/;
const stripDest = (raw) => (raw || '').trim().replace(cleanDestRegex, '').trim();

assert.strictEqual(stripDest('Hospital de Mataró - 1001'), 'Hospital de Mataró');
assert.strictEqual(stripDest('Hospital de Mataró - 1001 '), 'Hospital de Mataró');
assert.strictEqual(stripDest('Rodalies - 1016'), 'Rodalies');
assert.strictEqual(stripDest('Pl. de les Tereses - 1008'), 'Pl. de les Tereses');
assert.strictEqual(stripDest('Parc Central - 11'), 'Parc Central');
assert.strictEqual(stripDest('Hospital de Mataró'), 'Hospital de Mataró');
assert.strictEqual(stripDest('Línia L1 - Hospital'), 'Línia L1 - Hospital');
assert.strictEqual(stripDest(''), '');
assert.strictEqual(stripDest(null), '');

// 2.2 Live tracker synthesized arrivals destination & delay check
mataroSiriClient.circuitOpenUntil = fixtureNow + 30000;
mataroSiriClient.cache.delete('veh_1');

mataroTracker.recordVehicleState({
  vehicleId: 'test_veh_2680',
  lineId: '1',
  lineCode: 'L1',
  agency: 'Mataró Bus (Avanza)',
  direction: '0',
  directionName: 'Rodalies',
  lat: 41.5447,
  lon: 2.44163,
  bearing: 150,
  speedKmh: 28,
  delayMins: 3,
  lastSeen: fixtureNow
});

(async function testTrackerArrivals() {
  const arrsRodalies = await mataroTracker.estimateArrivalsForStop('1016', '1', [], { skipSiri: true });
  assert.ok(arrsRodalies.length > 0, 'Must produce arrivals for Stop 1016');
  for (const arr of arrsRodalies) {
    assert.ok(!/\s*-\s*\d+\s*$/.test(arr.destination), `Destination "${arr.destination}" must not contain stop code suffix`);
  }
  const matchingRodalies = arrsRodalies.find(a => a.vehicleId === 'test_veh_2680');
  if (matchingRodalies) {
    assert.strictEqual(matchingRodalies.destination, 'Rodalies', 'Destination for Line 1 Dir 0 must be Rodalies without suffix');
    assert.strictEqual(matchingRodalies.delayBadgeText, '+3 min retard', 'Delayed estimated bus must report delay in delayBadgeText');
    assert.strictEqual(matchingRodalies.delayStatus, 'delayed', 'Delayed estimated bus must report delayStatus delayed');
  }

  mataroTracker.recordVehicleState({
    vehicleId: 'test_veh_2681',
    lineId: '1',
    lineCode: 'L1',
    agency: 'Mataró Bus (Avanza)',
    direction: '1',
    directionName: 'Hospital',
    lat: 41.535,
    lon: 2.443,
    bearing: 10,
    speedKmh: 25,
    delayMins: 0,
    lastSeen: fixtureNow
  });

  const arrsHospital = await mataroTracker.estimateArrivalsForStop('1001', '1', [], { skipSiri: true });
  assert.ok(arrsHospital.length > 0, 'Must produce arrivals for Stop 1001');
  for (const arr of arrsHospital) {
    assert.ok(!/\s*-\s*\d+\s*$/.test(arr.destination), `Destination "${arr.destination}" must not contain stop code suffix`);
  }
  const matchingHospital = arrsHospital.find(a => a.vehicleId === 'test_veh_2681');
  if (matchingHospital) {
    assert.strictEqual(matchingHospital.destination, 'Hospital de Mataró', 'Destination for Line 1 Dir 1 must be Hospital de Mataró without suffix');
    assert.strictEqual(matchingHospital.delayBadgeText, '⚡ En ruta (Estimat)', 'On-time estimated bus must have En ruta (Estimat) badge');
    assert.strictEqual(matchingHospital.delayStatus, 'estimated', 'On-time estimated bus must have estimated delayStatus');
  }

  console.log('   ✓ Destination stop code suffix stripping verified in mataroTracker.\n');

  // ---------------------------------------------------------------------------
  // 3. Show Delay on GPS Estimates (public/js/app.js)
  // ---------------------------------------------------------------------------
  console.log('3. Testing Delay Badge on GPS Estimates in Departure Cards...');

  const { app, elements } = createTestApp();

  // Test 3.1: In renderDeparturesInto (Main Line Departure View)
  // With delay >= 2 and generic delayBadgeText '⚡ En ruta (Estimat)': must display '+3 min retard'
  app.renderDeparturesInto('dep-container', 'dep-badge', [
    { isEstimated: true, delayMins: 3, delayBadgeText: '⚡ En ruta (Estimat)', departureTime: '14:30', destination: 'Hospital de Mataró' }
  ]);
  const depDelayedHtml = elements['dep-container'].innerHTML;
  assert.ok(depDelayedHtml.includes('+3 min retard'), 'Pill label must display delay when delayMins >= 2 even if delayBadgeText is generic');
  assert.ok(depDelayedHtml.includes('dep-delay-pill delayed'), 'Pill class must be "delayed"');
  assert.ok(depDelayedHtml.includes('title="+3 min retard"'), 'Pill title must reflect the delay');
  assert.ok(depDelayedHtml.includes('⚡ En ruta'), 'Tag label must still identify bus as en route');

  // With delay < 2: should keep '⚡ En ruta' as pillLabel
  app.renderDeparturesInto('dep-container', 'dep-badge', [
    { isEstimated: true, delayMins: 0, delayBadgeText: '⚡ En ruta (Estimat)', departureTime: '14:30', destination: 'Hospital de Mataró' }
  ]);
  const depOnTimeHtml = elements['dep-container'].innerHTML;
  assert.ok(depOnTimeHtml.includes('dep-delay-pill on-time'), 'Pill class must be on-time');
  assert.ok(depOnTimeHtml.includes('>⚡ En ruta</span>'), 'Pill label must be "⚡ En ruta" when not delayed');

  // Test 3.2: In renderModalDepartures (Stop Detail Modal)
  // With delay >= 2 and generic delayBadgeText:
  app.renderModalDepartures({
    departures: [
      { isEstimated: true, delayMins: 4, delayBadgeText: '⚡ En ruta (Estimat)', departureTime: '14:35', destination: 'Hospital de Mataró' }
    ]
  }, '1001', 0, []);
  const modalDelayedHtml = elements['modal-departures-list'].innerHTML;
  assert.ok(modalDelayedHtml.includes('+4 min retard'), 'Modal pill label must display delay when delayMins >= 2');
  assert.ok(modalDelayedHtml.includes('dep-delay-pill delayed'), 'Modal pill class must be "delayed"');
  assert.ok(modalDelayedHtml.includes('title="+4 min retard"'), 'Modal pill title must reflect delay');

  // With custom delayBadgeText containing explicit delay:
  app.renderModalDepartures({
    departures: [
      { isEstimated: true, delayMins: 5, delayBadgeText: '+5 min retard acumulat', departureTime: '14:35', destination: 'Hospital de Mataró' }
    ]
  }, '1001', 0, []);
  const modalCustomBadgeHtml = elements['modal-departures-list'].innerHTML;
  assert.ok(modalCustomBadgeHtml.includes('+5 min retard acumulat'), 'Modal pill label must prefer explicit delayBadgeText');

  // With delay < 2:
  app.renderModalDepartures({
    departures: [
      { isEstimated: true, delayMins: 1, departureTime: '14:35', destination: 'Hospital de Mataró' }
    ]
  }, '1001', 0, []);
  const modalOnTimeHtml = elements['modal-departures-list'].innerHTML;
  assert.ok(modalOnTimeHtml.includes('dep-delay-pill on-time'), 'Modal pill class must be on-time');
  assert.ok(modalOnTimeHtml.includes('>⚡ En ruta</span>'), 'Modal pill label must be "⚡ En ruta" when delay < 2');

  console.log('   ✓ Delay display on GPS estimates verified for both line view and modal.\n');

  // ---------------------------------------------------------------------------
  // 4. Eliminate Conflicting Badges (public/js/app.js)
  // ---------------------------------------------------------------------------
  console.log('4. Testing Conflicting Badge Suppression when Parked at Terminal...');

  // Test 4.1: Bus parked at terminal in renderDeparturesInto
  app.renderDeparturesInto('dep-container', 'dep-badge', [
    {
      isEstimated: true,
      isTerminalLayover: true,
      arrivalTime: '14:00',
      departureTime: '14:10',
      arrivalMinutesAway: 0,
      minutesAway: 10,
      delayMins: 0,
      destination: 'Rodalies'
    }
  ]);
  const parkedLineHtml = elements['dep-container'].innerHTML;
  assert.ok(parkedLineHtml.includes('🅿️ A la parada'), 'Must render "🅿️ A la parada" when parked at terminal');
  assert.ok(!parkedLineHtml.includes('dep-tag-sub'), 'Must suppress secondary dep-tag-sub badge when parked at terminal');
  assert.ok(!parkedLineHtml.includes('⚡ En ruta'), 'Must not display "⚡ En ruta" when parked at terminal');

  // Test 4.2: Bus parked at terminal in renderModalDepartures
  app.renderModalDepartures({
    departures: [
      {
        isEstimated: true,
        isTerminalLayover: true,
        arrivalTime: '14:00',
        departureTime: '14:10',
        arrivalMinutesAway: 0,
        minutesAway: 10,
        delayMins: 0,
        destination: 'Rodalies'
      }
    ]
  }, '1001', 0, []);
  const parkedModalHtml = elements['modal-departures-list'].innerHTML;
  assert.ok(parkedModalHtml.includes('🅿️ A la parada'), 'Modal must render "🅿️ A la parada" when parked at terminal');
  assert.ok(!parkedModalHtml.includes('dep-tag-sub'), 'Modal must suppress secondary dep-tag-sub badge when parked at terminal');
  assert.ok(!parkedModalHtml.includes('⚡ En ruta'), 'Modal must not display "⚡ En ruta" when parked at terminal');

  // Test 4.3: Bus approaching terminal (arrMinsAway > 0) should show "⏱️ En camí" and allow tagLabel
  app.renderModalDepartures({
    departures: [
      {
        isEstimated: true,
        isTerminalLayover: true,
        arrivalTime: '14:05',
        departureTime: '14:15',
        arrivalMinutesAway: 3,
        minutesAway: 13,
        delayMins: 0,
        destination: 'Rodalies'
      }
    ]
  }, '1001', 0, []);
  const approachingModalHtml = elements['modal-departures-list'].innerHTML;
  assert.ok(approachingModalHtml.includes('⏱️ En camí'), 'Modal must render "⏱️ En camí" when approaching terminal');
  assert.ok(approachingModalHtml.includes('dep-tag-sub'), 'Modal must render dep-tag-sub when approaching (not parked)');
  assert.ok(approachingModalHtml.includes('⚡ En ruta'), 'Modal must render "⚡ En ruta" tag when approaching');

  console.log('   ✓ Conflicting badge elimination verified.\n');

  console.log('🎉 ALL DEPARTURE CARD RESILIENCE & SUFFIX TESTS PASSED PERFECTLY! 🎉\n');
})().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
