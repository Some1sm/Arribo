const assert = require('assert');
const trackerRegistry = require('../src/core/TrackerRegistry');
const mataroTracker = require('../src/mataroTracker');
const siriClient = require('../src/mataroSiriClient');
const historyDb = require('../src/historyDb');
const flightRecorder = require('../src/flightRecorder');
const timeUtils = require('../src/timeUtils');
const { runMataroTimetableAccuracyTests } = require('./mataro_timetable_accuracy_test');

async function verifyAll() {
  console.log('🔍 Running Dedicated Verification Tests...');

  // 1. Time Utils formatting protection test
  console.log('1. Testing TimeUtils timestamp protection...');
  assert.strictEqual(timeUtils.formatTimeToTimezone(null), '--:--');
  assert.strictEqual(timeUtils.formatTimeToTimezone('invalid-date'), '--:--');
  assert.strictEqual(timeUtils.formatTimeToTimezone('0001-01-01T00:00:00'), '--:--');
  assert.strictEqual(timeUtils.formatTimeToTimezone(new Date('1970-01-01T00:00:00Z')), '--:--');
  assert.strictEqual(timeUtils.formatTimeToTimezone('2026-08-18T21:30:00+02:00'), '21:30');
  console.log('✅ TimeUtils protection test passed.');

  // 2. SIRI client invalid arrival drop test
  console.log('2. Testing Mataró SIRI client arrival parsing...');
  const arrivals = await siriClient.getStopArrivals('1001', '1');
  arrivals.forEach(a => {
    assert(a.departureTime !== '00:00' || a.minutesAway > 0, `SIRI arrival cannot be 00:00 with minutesAway 0 (got: ${JSON.stringify(a)})`);
    if (a.expectedIso) {
      assert(!a.expectedIso.startsWith('0001-'), 'Expected ISO must not be 0001-');
    }
  });
  console.log(`✅ SIRI Client returned ${arrivals.length} valid arrivals (zero 00:01/00:00 phantom arrivals).`);

  // 3. Mataró Tracker stop 1001 departures test
  console.log('3. Testing Mataró Tracker stop 1001 departures...');
  const stopData = await mataroTracker.getStopDepartures('1001', '1');
  assert(stopData.departures.length > 0, 'Stop 1001 must have departures');
  stopData.departures.forEach(d => {
    assert(d.departureTime !== '--:--', 'Departure time must be valid');
    if (d.isRealTime && d.minutesAway === 0) {
      assert(d.departureTime !== '00:00', `Real-time imminent arrival must not have 00:00 (got: ${d.departureTime})`);
    }
    if (d.expectedIso) {
      assert(!d.expectedIso.startsWith('0001-'), 'Expected ISO must not be 0001-');
      assert(!d.expectedIso.startsWith('1970-'), 'Expected ISO must not be 1970-');
    }
  });
  console.log(`✅ Mataró Tracker stop 1001 verified (${stopData.departures.length} departures).`);

  // 4. Target ETA for stop 1001 test
  console.log('4. Testing Target ETA for stop 1001...');
  const targetEta = await mataroTracker.getTargetStopETA('1', '1001', '0');
  assert(targetEta.targetStop !== null, 'Target stop must exist');
  assert.strictEqual(targetEta.targetStop.id, '1001');
  if (targetEta.nextBus) {
    if (targetEta.nextBus.isRealTime && targetEta.nextBus.minutesAway === 0) {
      assert(targetEta.nextBus.departureTime !== '00:00', 'Next bus departureTime cannot be 00:00 if imminent realtime');
    }
  }
  console.log(`✅ Target ETA for stop 1001 verified (Next: ${targetEta.nextBus?.departureTime || 'None'}, Status: ${targetEta.nextBus?.formattedStatus || 'N/A'}).`);

  // 5. Journalism report lines coverage
  console.log('5. Testing Journalism Report Coverage...');
  const report = historyDb.getJournalismReport(48, trackerRegistry.getAllLines());
  assert(report.summary.monitoredLinesCount > 0, 'Must have monitored lines count');
  assert(Array.isArray(report.rankingMostDelayed), 'Must have rankingMostDelayed array');
  assert(Array.isArray(report.agencyStats), 'Must have agencyStats array');
  assert(Array.isArray(report.rankingWorstStops), 'Must have rankingWorstStops array');
  console.log(`✅ Journalism Report verified:`);
  console.log(`   - Total Recorded Arrivals: ${report.summary.totalRecordedArrivals}`);
  console.log(`   - Monitored Lines: ${report.summary.monitoredLinesCount}`);
  console.log(`   - Delayed Lines in Ranking: ${report.rankingMostDelayed.length}`);
  console.log(`   - Worst Stops in Ranking: ${report.rankingWorstStops.length}`);
  console.log(`   - Agencies Reported: ${report.agencyStats.length}`);

  // 6. Mataró Timetable Accuracy & Universal Synthesizer Master Suite
  console.log('\n6. Testing Mataró Bus Timetable Accuracy & E2E Suite (Tiers 1–4)...');
  const accuracyResult = await runMataroTimetableAccuracyTests();
  assert(accuracyResult && accuracyResult.success, 'Timetable accuracy test suite must succeed');
  console.log(`✅ Mataró Timetable Accuracy & E2E Suite verified (${accuracyResult.totalAssertions} assertions passed).`);

  console.log('\n🎉 ALL VERIFICATION CHECKS PASSED PERFECTLY! 🎉\n');
}

verifyAll().then(() => {
  process.exit(0);
}).catch(e => {
  console.error('❌ Verification failed:', e);
  process.exit(1);
});

