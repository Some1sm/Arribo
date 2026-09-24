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
const oneHour = 3600 * 1000;
// Anchor the scenarios to a Madrid daytime hour (16:00). A fixed "now - 8h"
// drifts into the overnight window, where is_telemetry_anomaly() marks every
// row as depot/night maintenance and the verdict short-circuits to
// 'telemetry_anomaly' — the suite then failed depending on the wall clock.
const madridHourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: 'numeric', hourCycle: 'h23' });
const currentMadridHour = parseInt(madridHourFmt.format(new Date()), 10);
const hoursBackTo16 = (currentMadridHour >= 16) ? (currentMadridHour - 16) : (currentMadridHour + 24 - 16);
const daytimeBase = now - (hoursBackTo16 * oneHour);

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

// ── Test Scenario: Backfilled approximation (scripts/backfill_delay_times.js) ──
// Offline guess written by the backfill CLI: same shape as a live derivation
// but a different times_source literal, and explicitly weaker.
for (let i = 0; i < 3; i++) {
  historyDb.recordDelayLog({
    vehicleId: '2695', lineId: '3', lineCode: 'L3', agency: 'Mataró',
    stopId: 'Mercat', stopName: 'Mercat Municipal', delayMins: 11,
    scheduledTime: '16:40:00', actualTime: '16:51:00',
    direction: '', timesSource: 'derived_timetable_backfill',
    isRealTime: true, timestamp: baseTs + 9 * twentySec + i * twentySec
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

  console.log('\n--- 5b. Backfilled approximation is NOT corroborating evidence (D1 regression) ---');
  // Regression: the verdict used to exact-match a single 'derived_timetable'
  // literal, so 'derived_timetable_backfill' fell into the OBSERVED bucket and
  // produced verdict "corroborated" with a note claiming the times were empty.
  const backfilledEp = await historyDb.inspectDelayIncident({ lineCode: 'L3', stopName: 'Mercat', at: baseTs + 9 * twentySec, minDelay: 5 });
  check(backfilledEp.found === true, 'Backfilled incident found');
  check(backfilledEp.episode?.verdict !== 'corroborated', 'A backfilled approximation can never produce a corroborated verdict');
  check(backfilledEp.episode?.verdict === 'derived_only', 'Backfilled rows alone yield derived_only');
  check(backfilledEp.episode?.evidence?.hasProvenanceTimes === false, 'Backfilled times are NOT counted as observed provenance');
  check(backfilledEp.episode?.evidence?.hasBackfilledTimes === true, 'Backfilled rows are counted separately from live-derived rows');
  check(backfilledEp.episode?.evidence?.rowsWithBackfilledTimes === 3, 'All 3 backfilled rows are counted');
  check(backfilledEp.episode?.evidence?.rowsWithDerivedTimes === 0, 'Backfilled rows are not miscounted as live-derived');
  check(backfilledEp.episode?.timesProvenance === 'derived_timetable_backfill', 'Episode provenance names the backfill literal');
  check(backfilledEp.episode?.timetableCheck?.backfilledFromTimetable === true, 'timetableCheck flags the rows as backfilled');
  check(backfilledEp.episode?.timetableCheck?.derivedLiveFromTimetable === false, 'timetableCheck does not claim a live derivation');
  check(backfilledEp.episode?.verdictLabel !== backfilledEp.episode?.verdictLabel?.replace('Backfilled approximation', 'Derived only'),
    'The backfilled verdict label is distinguishable from a live derivation');
  check(backfilledEp.episode?.timetableCheck?.note?.includes('approximated offline') === true, 'timetableCheck note explains the offline approximation');
  check(backfilledEp.episode?.rawRows?.[0]?.timesProvenance === 'derived_timetable_backfill', 'Per-row provenance lets the UI colour backfilled rows apart');
  check(backfilledEp.episode?.rawRows?.[0]?.timesSource === 'derived_timetable_backfill', 'Raw rows still carry the raw times_source through');

  console.log('\n--- 5c. Real upstream times stay corroborated (D1 non-regression) ---');
  check(ep3.episode?.timesProvenance === 'observed', 'A real upstream observation is classified as observed');
  check(ep3.episode?.timetableCheck?.derivedFromTimetable === false, 'Observed times are not flagged as timetable-derived');
  check(epDerived.episode?.timesProvenance === 'derived_timetable', 'A live derivation is classified as derived_timetable');
  check(epDerived.episode?.evidence?.hasBackfilledTimes === false, 'A live derivation is not reported as backfilled');

  console.log('\n--- 6. Data quality summary in getDelayIncidents ---');
  const summary = await historyDb.getDelayIncidents({ lineCode: 'all', hours: 24, minDelay: 5 });
  check(summary.summary.dataQuality !== undefined, 'Data quality block present in summary');
  check(summary.summary.dataQuality.totalRawRows > 0, 'Total raw rows > 0');
  check(summary.summary.dataQuality.rowsWithoutVehicleId >= 0, 'Rows without vehicleId counted');
  check(summary.summary.dataQuality.rowsWithoutProvenance >= 0, 'Rows without provenance counted');
  check(summary.summary.dataQuality.distinctEpisodes >= 0, 'Distinct episodes calculated');
  check(summary.summary.dataQuality.episodeGapMinutes === 5, 'Episode boundary is published (5 min) so the number is interpretable');
  check(summary.summary.dataQuality.episodesNote && summary.summary.dataQuality.episodesNote.length > 0, 'Episode count states what it actually counts');
  check(summary.summary.dataQuality.distinctEpisodes <= summary.summary.dataQuality.totalRawRows, 'An episode count can never exceed the raw sample count it clusters');

  console.log('\n--- 6b. Retired non-Mataró rows are excluded from "all lines" (D4 regression) ---');
  const allLines = await historyDb.getDelayIncidents({ lineCode: 'all', hours: 720, minDelay: 5 });
  const retiredInTop = [...(allLines.topIncidents || []), ...(allLines.investigationIncidents || []), ...(allLines.telemetryAnomalies || [])]
    .filter(i => i.lineCode === 'C-10');
  check(retiredInTop.length === 0, 'A retired C-10 row must not surface in any "all lines" incident list');
  const retiredInspect = await historyDb.inspectDelayIncident({ lineCode: 'all', stopName: 'El Masnou', at: baseTs + 6 * twentySec, minDelay: 5 });
  check(retiredInspect.found === false, 'inspectDelayIncident("all") must not return retired-scope rows');
  check(retiredInspect.episode === null || retiredInspect.episode === undefined, 'No episode is built from retired-scope rows');
  const scopedReport = await historyDb.getJournalismReport(24, []);
  const retiredInReport = (scopedReport.rankingMostDelayed || []).filter(r => r.lineCode === 'C-10');
  check(retiredInReport.length === 0, 'getJournalismReport must not rank retired C-10 lines');

  console.log('\n--- 6c. The headline maximum is the true maximum (D2 regression) ---');
  // Every genuine delay in the window sits in the investigation tier, so the
  // commercial figure is unknown. It used to be forced to 0 and the UI printed
  // "+0 min" as the maximum service delay.
  const onlyExtreme = await historyDb.getDelayIncidents({ lineCode: 'L3', hours: 24, minDelay: 5 });
  check(onlyExtreme.summary.maxDelayMins === 11, 'Headline max reports the real 11-min delay in the L3 window');
  check(onlyExtreme.summary.maxCommercialDelayMins === 11, 'An 11-min delay IS commercial (< 25 min) and is reported as such');
  // Now a window whose only delay is >= 25 min.
  historyDb.recordDelayLog({
    vehicleId: '2700', lineId: '7', lineCode: 'L7', agency: 'Mataró',
    stopId: 'Salesians', stopName: 'Salesians', delayMins: 30,
    isRealTime: true, timestamp: daytimeBase
  });
  const extremeOnly = await historyDb.getDelayIncidents({ lineCode: 'L7', hours: 24, minDelay: 5 });
  check(extremeOnly.summary.maxDelayMins === 30, 'Headline max reports the real 30-min delay, not 0');
  check(extremeOnly.summary.maxCommercialDelayMins === null, 'The commercial-tier max is null (unknown), never 0');
  check(extremeOnly.summary.maxDelayIsFromInvestigationTier === true, 'The API says the max came from the investigation tier so the UI can say so');
  check(extremeOnly.investigationIncidents.length > 0, 'The 30-min row lands in investigationIncidents');
  check(extremeOnly.investigationIncidents[0].investigationReason.includes('≥25 min'), 'The investigation label matches its >= 25 min threshold');

  console.log('\n--- 6d. Distinct buses on one line are not merged by the dedup key (D5 regression) ---');
  // Both rows have an empty vehicle_id (the dominant historical case) and sit
  // 5 min apart at different stops. A bare lineCode key merged them into one.
  for (const [stopId, stopName, delayMins] of [['M1', 'La Riera', 7], ['M2', 'El Castell', 8]]) {
    historyDb.recordDelayLog({
      vehicleId: '', lineId: '6', lineCode: 'L6', agency: 'Mataró',
      stopId, stopName, delayMins, isRealTime: true,
      timestamp: daytimeBase + (stopId === 'M2' ? 5 * 60 * 1000 : 0)
    });
  }
  const twoStops = await historyDb.getDelayIncidents({ lineCode: 'L6', hours: 24, minDelay: 5 });
  const l6Stops = twoStops.topIncidents.map(i => i.stopName);
  check(l6Stops.includes('La Riera') && l6Stops.includes('El Castell'), 'Two stops on one line stay two episodes');
  check(twoStops.summary.rawSamplesOverThreshold === 2, 'Raw sample KPI counts both samples');
  check(twoStops.summary.listedCommercialEpisodes === 2, 'The deduped episode count matches the two distinct stops');
  check(twoStops.summary.kpiBasis && /RAW SAMPLES/.test(twoStops.summary.kpiBasis), 'The API states plainly that the KPI is raw samples, not episodes');

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