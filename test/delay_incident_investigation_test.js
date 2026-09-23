/**
 * test/delay_incident_investigation_test.js
 *
 * Test suite for the forensic delay inspection capability.
 * Verifies: episode grouping, provenance verdicts, retired-scope flags.
 */

const path = require('node:path');
const fs = require('node:fs');

console.log('🧪 Starting Delay Incident Investigation Test Suite...\n');

// Isolated test database
const testDir = path.join(__dirname, '..', 'tmp', 'test_investigate');
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
const testDbPath = path.join(testDir, 'test_investigate.db');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

const historyDb = require('../src/historyDb');
historyDb.init(testDbPath);

const now = Date.now();
const twentySec = 20 * 1000;
const daytimeBase = now - 8 * 3600 * 1000;

// ── Test Scenario: One bus, 12 ping rows = inflated incident ──
const busId = '2671';
const lineCode = 'L5';
const stopName = 'Hospital de Mataró';
const baseTs = daytimeBase;
for (let i = 0; i < 12; i++) {
  historyDb.recordDelayLog({
    vehicleId: busId, lineId: '5', lineCode: lineCode, agency: 'Mataró Bus',
    stopId: stopName, stopName: stopName, delayMins: 15 + i, scheduledTime: '', actualTime: '',
    isRealTime: true, timestamp: baseTs + i * twentySec
  });
}

// ── Test Scenario: Row without vehicleId (historical data) ──
for (let i = 0; i < 5; i++) {
  historyDb.recordDelayLog({
    vehicleId: '', lineId: '5', lineCode: 'L5', agency: 'Mataró',
    stopId: 'Rodalies', stopName: 'Rodalies', delayMins: 20 + i,
    scheduledTime: '', actualTime: '', isRealTime: false, timestamp: baseTs + 10 * twentySec
  });
}

// ── Test Scenario: Retired-scope line (outside L1–L8) ──
historyDb.recordDelayLog({
  vehicleId: '', lineId: 'C10', lineCode: 'C-10', agency: 'C-10',
  stopId: 'El Masnou', stopName: 'El Masnou', delayMins: 12,
  scheduledTime: '', actualTime: '', isRealTime: false, timestamp: baseTs + 6 * twentySec
});

// ── Test Scenario: Row with provenance times (corroborated) ──
historyDb.recordDelayLog({
  vehicleId: '2680', lineId: '5', lineCode: 'L5', agency: 'Mataró',
  stopId: 'Plaça', stopName: "Plaça del Centre", delayMins: 10,
  scheduledTime: '08:15:00', actualTime: '08:25:00', isRealTime: true,
  timestamp: baseTs + 5 * twentySec
});

// ── Test Scenario: Derived (not observed) timetable times ──
for (let i = 0; i < 2; i++) {
  historyDb.recordDelayLog({
    vehicleId: '2690', lineId: '5', lineCode: 'L5', agency: 'Mataró',
    stopId: 'Teatre', stopName: 'Teatre Municipal', delayMins: 8,
    scheduledTime: '07:30:00', actualTime: '07:38:00',
    direction: '0', timesSource: 'derived_timetable',
    isRealTime: true, timestamp: baseTs + 7 * twentySec + i * twentySec
  });
}

async function runTests() {
  let passed = 0;
  const failed = [];

  const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ✅', msg); }
    else { failed.push(msg); console.error('  ❌', msg); }
  };

  console.log('--- 1. Episode grouping for known vehicle ---');
  const ep1 = await historyDb.inspectDelayIncident({ lineCode: 'L5', stopName: 'Hospital', at: baseTs, windowMins: 30, minDelay: 10 });
  check(ep1.found === true, 'Incident found within window');
  check(ep1.episode?.rowCount === 12, 'Episode groups the 12 raw polls of one bus (Rodalies rows excluded by stop filter)');
  check(ep1.episode?.verdict === 'poll_inflated', 'Verdict is poll_inflated for one bus logged repeatedly with no corroboration');

  console.log('\n--- 2. Poll-inflated verdict for empty vehicleId ---');
  for (let i = 0; i < 3; i++) {
    historyDb.recordDelayLog({
      vehicleId: '', lineId: '2', lineCode: 'L2', agency: 'Mataró',
      stopId: 'Estació', stopName: 'Estació Rodalies', delayMins: 22,
      scheduledTime: '', actualTime: '', isRealTime: false, timestamp: baseTs + i * twentySec
    });
  }
  const ep2 = await historyDb.inspectDelayIncident({ lineCode: 'L2', stopName: 'Estació', at: baseTs + 3 * twentySec, minDelay: 20 });
  check(ep2.found === true, 'L2 incident found');
  check(ep2.episode?.verdict === 'poll_inflated', 'Verdict for empty vehicleId + multiple rows is poll_inflated');

  console.log('\n--- 3. Corroborated verdict with provenance times ---');
  const ep3 = await historyDb.inspectDelayIncident({ lineCode: 'L5', stopName: "Plaça del Centre", at: baseTs + 5 * twentySec, minDelay: 5 });
  check(ep3.found === true, 'Plaça incident found');
  check(ep3.episode?.verdict === 'corroborated', 'Verdict is corroborated for row with scheduled_time');

  console.log('\n--- 4. Derived timetable times are not treated as observed ---');
  const epDerived = await historyDb.inspectDelayIncident({ lineCode: 'L5', stopName: 'Teatre', at: baseTs + 7 * twentySec, minDelay: 5 });
  check(epDerived.found === true, 'Teatre incident found');
  check(epDerived.episode?.verdict === 'derived_only', 'Derived times alone do not corroborate — verdict is derived_only');
  check(epDerived.episode?.evidence?.hasDerivedTimes === true, 'Derived-time rows are counted');
  check(epDerived.episode?.evidence?.hasProvenanceTimes === false, 'Derived times are not counted as observed provenance');
  check(epDerived.episode?.timetableCheck?.derivedFromTimetable === true, 'Drilldown flags the times as derived from the timetable');
  check(epDerived.episode?.rawRows?.[0]?.timesSource === 'derived_timetable', 'Raw rows carry their times_source through');
  check(epDerived.episode?.rawRows?.[0]?.direction === '0', 'Raw rows carry the direction needed to re-derive the join');

  console.log('\n--- 5. Retired-scope flag ---');
  const retiredEp = await historyDb.inspectDelayIncident({ lineCode: 'C-10', stopName: 'El Masnou', at: baseTs + 6 * twentySec, minDelay: 10 });
  check(retiredEp.episode?.retiredScope === true || retiredEp.dataQuality?.retiredScopeLinesPresent === true, 'Retirement scope detected for non-L1-L8 line');

  console.log('\n--- 6. Data quality summary in getDelayIncidents ---');
  const summary = await historyDb.getDelayIncidents({ lineCode: 'all', hours: 24, minDelay: 5 });
  check(summary.summary.dataQuality !== undefined, 'Data quality block present in summary');
  check(summary.summary.dataQuality.totalRawRows > 0, 'Total raw rows > 0');
  check(summary.summary.dataQuality.rowsWithoutVehicleId >= 0, 'Rows without vehicleId counted');
  check(summary.summary.dataQuality.rowsWithoutProvenance >= 0, 'Rows without provenance counted');
  check(summary.summary.dataQuality.distinctEpisodes >= 0, 'Distinct episodes calculated');

  console.log('\n--- 7. Worker RPC dispatch ---');
  const worker = require('../src/workers/ingestionWorker');
  const rpcResult = await worker.executeDbOperation('inspectDelayIncident', { lineCode: 'L5', at: baseTs, windowMins: 60, minDelay: 5 });
  check(rpcResult.found === true || rpcResult.found === false, 'RPC dispatch returns valid structure');

  console.log('\n=====================================================');
  console.log(`Passed: ${passed}, Failed: ${failed.length}`);
  if (failed.length) {
    console.error('\n🔴 FAILURES:');
    failed.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
    process.exit(1);
  }
  console.log('\n🎉 ALL INVESTIGATION TESTS PASSED!\n');

  // Cleanup
  try { historyDb.close(); if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath); } catch {}
}

runTests().catch(err => {
  console.error('\n❌ Test harness crashed:', err);
  process.exit(1);
});