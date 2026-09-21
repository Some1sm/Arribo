const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

console.log('🧪 Starting Delay Incident Inspector & Deep-Dive Test Suite...\n');

// 1. Setup isolated test database
const testDir = path.join(__dirname, '..', 'data', 'test_scratch');
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
const testDbPath = path.join(testDir, 'test_delay_incidents.db');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const historyDb = require('../src/historyDb');
historyDb.init(testDbPath);

const now = Date.now();
const oneHour = 3600 * 1000;
const twentySec = 20 * 1000;

const madridHourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: 'numeric', hourCycle: 'h23' });
const currentMadridHour = parseInt(madridHourFmt.format(new Date()), 10);
const hoursBackTo16 = (currentMadridHour >= 16) ? (currentMadridHour - 16) : (currentMadridHour + 24 - 16);
const daytimeBase = now - (hoursBackTo16 * oneHour);
const hoursBackTo04 = (currentMadridHour >= 4) ? (currentMadridHour - 4) : (currentMadridHour + 24 - 4);
const nightBase = now - (hoursBackTo04 * oneHour);

// Populate realistic test data into delay_logs:
// Scenario A: Line 5 moving in evening rush hour (moving bus across 4 stops, reaching +25m delay)
const l5Start = daytimeBase;
const l5Stops = ['Rodalies', 'Via Europa', 'Pl. Itàlia', 'Hospital de Mataró'];
l5Stops.forEach((stopName, idx) => {
  // 3 pings per stop
  for (let p = 0; p < 3; p++) {
    historyDb.recordDelayLog({
      vehicleId: '2684',
      lineId: '5',
      lineCode: 'L5',
      agency: 'Mataró Bus (Avanza)',
      stopId: stopName,
      stopName: stopName,
      delayMins: 15 + (idx * 3) + p, // delays reaching 24-25 min
      scheduledTime: '',
      actualTime: '',
      isRealTime: true,
      timestamp: l5Start + (idx * 3 + p) * twentySec
    });
  }
});

// Scenario B: Line 2 parked at terminal layover (stationary bus at same stop for 30 min, delay 20m)
const l2Start = daytimeBase - oneHour;
for (let p = 0; p < 5; p++) {
  historyDb.recordDelayLog({
    vehicleId: '2670',
    lineId: '2',
    lineCode: 'L2',
    agency: 'Mataró Bus (Avanza)',
    stopId: 'Estació Rodalies',
    stopName: 'Estació Rodalies',
    delayMins: 20,
    scheduledTime: '',
    actualTime: '',
    isRealTime: true,
    timestamp: l2Start + (p * 5 * 60 * 1000)
  });
}

// Scenario C: Minor delays (<5m) that should be excluded by default threshold
for (let p = 0; p < 5; p++) {
  historyDb.recordDelayLog({
    lineId: '1',
    lineCode: 'L1',
    agency: 'Mataró Bus (Avanza)',
    stopId: 'Pl. de les Tereses',
    stopName: 'Pl. de les Tereses',
    delayMins: 2,
    scheduledTime: '',
    actualTime: '',
    isRealTime: true,
    timestamp: daytimeBase + (p * twentySec)
  });
}

// Scenario D: Line 8 depot testing at night (04:00 Madrid time)
const l8Start = nightBase;
for (let p = 0; p < 3; p++) {
  historyDb.recordDelayLog({
    lineId: '8',
    lineCode: 'L8',
    agency: 'Mataró Bus (Avanza)',
    stopId: 'Cotxeres Avanza',
    stopName: 'Cotxeres Avanza',
    delayMins: 21,
    scheduledTime: '',
    actualTime: '',
    isRealTime: true,
    timestamp: l8Start + (p * 30 * 1000)
  });
}

console.log('--- 1. Testing getHourlyTrafficContext ---');
const depotCtx = historyDb.getHourlyTrafficContext(4);
assert.strictEqual(depotCtx.isDepot, true);
assert.ok(depotCtx.tag.includes('Cotxeres'));

const schoolCtx = historyDb.getHourlyTrafficContext(8);
assert.strictEqual(schoolCtx.isSchoolHour, true);
assert.strictEqual(schoolCtx.isPeak, true);
assert.ok(schoolCtx.tag.includes('Entrada escolar'));

const peakCtx = historyDb.getHourlyTrafficContext(19);
assert.strictEqual(peakCtx.isPeak, true);
assert.ok(peakCtx.tag.includes('Punta tornada feina'));

const valleyCtx = historyDb.getHourlyTrafficContext(11);
assert.strictEqual(valleyCtx.isPeak, false);
assert.ok(valleyCtx.tag.includes('Vall matinal'));
console.log('✅ getHourlyTrafficContext accurately identifies traffic windows & depot maintenance.');

console.log('\n--- 2. Testing getDelayIncidents for specific line (L5) ---');
const l5Incidents = historyDb.getDelayIncidents({ lineCode: 'L5', hours: 24, limit: 10, minDelay: 5 });
assert.strictEqual(l5Incidents.lineCode, 'L5');
assert.ok(l5Incidents.summary.totalRecordedIncidents > 0);
assert.ok(l5Incidents.summary.maxDelayMins >= 24);
assert.ok(l5Incidents.topIncidents.length > 0);
assert.strictEqual(l5Incidents.topIncidents[0].lineCode, 'L5');
assert.ok(Number.isFinite(l5Incidents.topIncidents[0].rank));
assert.ok(l5Incidents.topIncidents[0].trafficTag.length > 0);

// Check trip clustering for moving bus
assert.ok(l5Incidents.incidentTrips.length > 0);
const l5Trip = l5Incidents.incidentTrips[0];
assert.strictEqual(l5Trip.lineCode, 'L5');
assert.strictEqual(l5Trip.isMovingTraffic, true);
assert.strictEqual(l5Trip.incidentType, 'traffic');
assert.ok(l5Trip.stopsTraversed.length >= 3);
assert.ok(Array.isArray(l5Trip.stopProgression));
assert.strictEqual(l5Trip.stopProgression.length, l5Trip.stopsTraversed.length);
assert.strictEqual(l5Trip.stopProgression[0].stopName, 'Rodalies');
assert.ok(Number.isFinite(l5Trip.stopProgression[0].delayMins));
console.log('✅ Specific line query and moving bus trip clustering with stopProgression verified.');

console.log('\n--- 3. Testing getDelayIncidents for stationary layover (L2) ---');
const l2Incidents = historyDb.getDelayIncidents({ lineCode: 'L2', hours: 24, limit: 10, minDelay: 5 });
assert.strictEqual(l2Incidents.lineCode, 'L2');
assert.ok(l2Incidents.incidentTrips.length > 0);
const l2Trip = l2Incidents.incidentTrips[0];
assert.strictEqual(l2Trip.isMovingTraffic, false);
assert.strictEqual(l2Trip.incidentType, 'layover');
assert.strictEqual(l2Trip.stopsTraversed.length, 1);
assert.strictEqual(l2Trip.stopsTraversed[0], 'Estació Rodalies');
assert.ok(Array.isArray(l2Trip.stopProgression));
assert.strictEqual(l2Trip.stopProgression.length, 1);
assert.strictEqual(l2Trip.stopProgression[0].stopName, 'Estació Rodalies');
assert.strictEqual(l2Trip.stopProgression[0].delayMins, 20);
console.log('✅ Stationary layover vs moving vehicle detection verified.');

console.log('\n--- 4. Testing network-wide query (ALL lines) ---');
const allIncidents = historyDb.getDelayIncidents({ lineCode: 'all', hours: 24, limit: 20, minDelay: 5 });
assert.strictEqual(allIncidents.lineCode, 'ALL');
assert.ok(allIncidents.summary.totalRecordedIncidents >= l5Incidents.summary.totalRecordedIncidents + l2Incidents.summary.totalRecordedIncidents);
assert.ok(allIncidents.summary.movingCount >= 1);
assert.ok(allIncidents.summary.stationaryCount >= 1);
assert.ok(allIncidents.summary.movingPct > 0 && allIncidents.summary.movingPct < 100);
console.log('✅ Network-wide query and aggregate metrics verified.');

console.log('\n--- 5. Testing threshold filter (minDelay) ---');
// Line 1 only has delays of 2m; should yield 0 records with minDelay=5
const l1Incidents = historyDb.getDelayIncidents({ lineCode: 'L1', hours: 24, minDelay: 5 });
assert.strictEqual(l1Incidents.summary.totalRecordedIncidents, 0);
assert.strictEqual(l1Incidents.topIncidents.length, 0);
assert.strictEqual(l1Incidents.incidentTrips.length, 0);

// With minDelay=1, Line 1 records must appear
const l1IncidentsLow = historyDb.getDelayIncidents({ lineCode: 'L1', hours: 24, minDelay: 1 });
assert.ok(l1IncidentsLow.summary.totalRecordedIncidents > 0);
assert.strictEqual(l1IncidentsLow.topIncidents[0].lineCode, 'L1');
console.log('✅ Delay threshold boundary filtering verified.');

console.log('\n--- 5b. Testing telemetryAnomalies partitioning & diagnostics ---');
// Insert an early morning SAE startup anomaly at 06:03 (Madrid time) with +16 min delay
const madridFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
const [dDay, dMon, dYr] = madridFmt.format(new Date()).split('/');
const morning0603Ts = new Date(`${dYr}-${dMon}-${dDay}T06:03:09+02:00`).getTime();

historyDb.recordDelayLog({
  lineId: '2',
  lineCode: 'L2',
  agency: 'Mataró Bus (Avanza)',
  stopId: 'Sant Isidor',
  stopName: 'Sant Isidor',
  delayMins: 16,
  scheduledTime: '',
  actualTime: '',
  isRealTime: true,
  timestamp: morning0603Ts
});

// Insert an early morning 05:14 telemetry ping (pre-service / maintenance)
const morning0514Ts = new Date(`${dYr}-${dMon}-${dDay}T05:14:46+02:00`).getTime();
historyDb.recordDelayLog({
  lineId: '7',
  lineCode: 'L7',
  agency: 'Mataró Bus (Avanza)',
  stopId: 'Salesians',
  stopName: 'Salesians',
  delayMins: 25,
  scheduledTime: '',
  actualTime: '',
  isRealTime: true,
  timestamp: morning0514Ts
});

const anomaliesCheck = historyDb.getDelayIncidents({ lineCode: 'all', hours: 48, minDelay: 5 });
assert.ok(Array.isArray(anomaliesCheck.telemetryAnomalies));
assert.ok(anomaliesCheck.telemetryAnomalies.length >= 3, 'Should have nocturnal maintenance, 05:14 maintenance, and 06:03 morning rollout anomalies');

// Check 05:14 anomaly: before 06:00 is maintenance, NOT startup_sae
const early0514Anomaly = anomaliesCheck.telemetryAnomalies.find(a => a.lineCode === 'L7' && a.timestamp === morning0514Ts);
assert.ok(early0514Anomaly, '05:14 telemetry must be caught in telemetryAnomalies');
assert.strictEqual(early0514Anomaly.anomalyType, 'maintenance', '05:14 before 06:00 must be classified as maintenance');
assert.strictEqual(early0514Anomaly.diagnosticBadge, '🔧 Cotxeres / Manteniment nocturn');
assert.ok(early0514Anomaly.formattedDate.includes('05:14:46'), 'formattedDate must be formatted in Madrid time (05:14:46)');

// Check nocturnal maintenance anomaly (L8 Cotxeres)
const maintAnomaly = anomaliesCheck.telemetryAnomalies.find(a => a.lineCode === 'L8' || a.stopName.includes('Cotxeres'));
assert.ok(maintAnomaly, 'Nocturnal maintenance anomaly must be detected');
assert.strictEqual(maintAnomaly.anomalyType, 'maintenance');
assert.strictEqual(maintAnomaly.diagnosticBadge, '🔧 Cotxeres / Manteniment nocturn');
assert.strictEqual(maintAnomaly.trafficIcon, '🔧');

// Check early morning startup anomaly (L2 06:03:09)
const startupAnomaly = anomaliesCheck.telemetryAnomalies.find(a => a.lineCode === 'L2' && a.stopName === 'Sant Isidor');
assert.ok(startupAnomaly, 'Early morning rollout anomaly must be detected in telemetryAnomalies');
assert.strictEqual(startupAnomaly.anomalyType, 'startup_sae');
assert.strictEqual(startupAnomaly.diagnosticBadge, '⚠️ Desfasament SAE torn matinal');
assert.strictEqual(startupAnomaly.trafficIcon, '⚠️');

// Ensure topIncidents only contains regular revenue service delays (no Cotxeres, 05:14, or 06:03 startup)
const hasStartupInTop = anomaliesCheck.topIncidents.some(i => i.lineCode === 'L2' && i.stopName === 'Sant Isidor' && i.timestamp === morning0603Ts);
const has0514InTop = anomaliesCheck.topIncidents.some(i => i.lineCode === 'L7' && i.timestamp === morning0514Ts);
const hasCotxeresInTop = anomaliesCheck.topIncidents.some(i => i.stopName.includes('Cotxeres'));
assert.strictEqual(hasStartupInTop, false, 'Early morning startup anomaly must NOT appear in topIncidents');
assert.strictEqual(has0514InTop, false, '05:14 maintenance anomaly must NOT appear in topIncidents');
assert.strictEqual(hasCotxeresInTop, false, 'Cotxeres maintenance must NOT appear in topIncidents');
console.log('✅ Telemetry anomalies properly partitioned, 05:14 verified as maintenance, and labeled with diagnostic badges.');

console.log('\n--- 5c. Testing investigationIncidents partitioning (0-24m vs 24-infinite) ---');
assert.ok(Array.isArray(anomaliesCheck.investigationIncidents), 'investigationIncidents must be an array');
// Verify every item in topIncidents has delay < 25 (0 to 24 min)
for (const inc of anomaliesCheck.topIncidents) {
  assert.ok(inc.delayMins < 25, `topIncidents item delay (${inc.delayMins}m) must be strictly < 25m (0-24m)`);
}
// Verify investigationIncidents contains delays >= 25m (24-infinite / +24m)
assert.ok(anomaliesCheck.investigationIncidents.length > 0, 'Must have records in investigationIncidents (L5 peaked at 26m)');
for (const inc of anomaliesCheck.investigationIncidents) {
  assert.ok(inc.delayMins >= 25, `investigationIncidents item delay (${inc.delayMins}m) must be >= 25m`);
  assert.strictEqual(inc.trafficTag, '🔬 En investigació');
  assert.ok(inc.investigationReason.includes('Horari no habitual'));
}
assert.strictEqual(typeof anomaliesCheck.summary.investigationCount, 'number');
assert.ok(anomaliesCheck.summary.investigationCount >= 1);
assert.ok(anomaliesCheck.summary.maxCommercialDelayMins <= 24);
console.log('✅ 0-24m commercial delays cleanly partitioned from 24-infinite non-normal schedules in investigation.');

console.log('\n--- 5d. Testing simultaneous multi-bus separation on the same line (Line 3) ---');
// Insert interleaved pings from two distinct buses on Line 3
const baseT = now - (1 * oneHour);
// Bus A (vehicle 2665 in Cirera): Pau Picasso (+15) -> Escola Freta (+14)
// Bus B (vehicle 2680 in Cerdanyola): Ample (+6) -> Roca Blanca (+5)
historyDb.recordDelayLog({
  vehicleId: '2665',
  lineId: '3',
  lineCode: 'L3',
  agency: 'Mataró Bus (Avanza)',
  stopId: 'Pau Picasso',
  stopName: 'Pau Picasso',
  delayMins: 15,
  timestamp: baseT
});
historyDb.recordDelayLog({
  vehicleId: '2680',
  lineId: '3',
  lineCode: 'L3',
  agency: 'Mataró Bus (Avanza)',
  stopId: 'Ample',
  stopName: 'Ample',
  delayMins: 6,
  timestamp: baseT + 15000
});
historyDb.recordDelayLog({
  vehicleId: '2665',
  lineId: '3',
  lineCode: 'L3',
  agency: 'Mataró Bus (Avanza)',
  stopId: 'Escola Freta',
  stopName: 'Escola Freta',
  delayMins: 14,
  timestamp: baseT + 30000
});
historyDb.recordDelayLog({
  vehicleId: '2680',
  lineId: '3',
  lineCode: 'L3',
  agency: 'Mataró Bus (Avanza)',
  stopId: 'Roca Blanca',
  stopName: 'Roca Blanca',
  delayMins: 5,
  timestamp: baseT + 45000
});

const l3Incidents = historyDb.getDelayIncidents({ lineCode: 'L3', hours: 24, minDelay: 5 });
assert.ok(Array.isArray(l3Incidents.incidentTrips));
// Must be cleanly partitioned into 2 separate trips, NOT 1 merged trip!
assert.strictEqual(l3Incidents.incidentTrips.length, 2, 'Simultaneous buses on Line 3 must be partitioned into 2 distinct trips');

const tripA = l3Incidents.incidentTrips.find(t => t.vehicleId === '2665');
assert.ok(tripA, 'Trip for Bus 2665 must exist');
assert.deepStrictEqual(tripA.stopsTraversed, ['Pau Picasso', 'Escola Freta']);
assert.strictEqual(tripA.maxDelayMins, 15);

const tripB = l3Incidents.incidentTrips.find(t => t.vehicleId === '2680');
assert.ok(tripB, 'Trip for Bus 2680 must exist');
assert.deepStrictEqual(tripB.stopsTraversed, ['Ample', 'Roca Blanca']);
assert.strictEqual(tripB.maxDelayMins, 6);
console.log('✅ Simultaneous buses on the same line cleanly separated by vehicleId and spatial continuity.');

console.log('\n--- 6. Testing Worker RPC operation dispatch ---');
const ingestionWorker = require('../src/workers/ingestionWorker');
// Verify executeDbOperation is a function
assert.strictEqual(typeof ingestionWorker.executeDbOperation, 'function');
ingestionWorker.executeDbOperation('getDelayIncidents', { lineCode: 'L5', hours: 24 })
  .then(res => {
    assert.ok(res);
    assert.strictEqual(res.lineCode, 'L5');
    assert.ok(res.summary);
    assert.ok(Array.isArray(res.topIncidents));
    assert.ok(Array.isArray(res.incidentTrips));
    console.log('✅ Worker RPC dispatch for getDelayIncidents verified.');

    // Cleanup test database
    try {
      historyDb.close();
      if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    } catch (_) {}

    console.log('\n🎉 ALL DELAY INCIDENT INSPECTOR TESTS PASSED PERFECTLY! 🎉');
  })
  .catch(err => {
    console.error('❌ Worker RPC test failed:', err);
    process.exit(1);
  });
