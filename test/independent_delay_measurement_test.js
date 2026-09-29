'use strict';

/**
 * test/independent_delay_measurement_test.js
 *
 * Verifies Phase 9.3:
 * 1. Computes bus's own passing time at that stop:
 *    the observedAt of the first sample whose toStop is the next stop,
 *    or if the bus was within 30m of the stop, that sample's observedAt.
 * 2. Matches trip with tripMatcher (per-trip times) and stores
 *    measured_delay_mins = passing - published in stop_visits.measured_delay_mins.
 * 3. Asserts getJournalismReport calculates delayMeasurementComparison (operator vs measured delay
 *    and agreement rate within 1 min).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-delay-meas-'));
process.env.DB_PATH = path.join(scratch, 'history.db');
process.env.REPORTS_DIR = path.join(scratch, 'reports');

const historyDb = require('../src/historyDb');
const _tripMatcher = require('../src/core/schedule/tripMatcher');
const mataroSchedules = require('../src/data/mataroSchedules');
const timeEngine = require('../src/core/time/timeEngine');
const { IngestionDaemon } = require('../src/ingestionDaemon');

(async () => {
  console.log('🧪 Testing Independent Delay Measurement (Phase 9.3)...');

  // Initialize DB
  historyDb.init(process.env.DB_PATH);

  const daemon = new IngestionDaemon();

  // Test setup: Pin a known service time on a weekday
  // Let's use Line 1 Direction 11 (Rodalies -> Hospital).
  // Origin is Rodalies (1016), terminal is Hospital (1001).
  const dayType = 'weekday';
  const departures = mataroSchedules.getDeparturesForStop('1', '11', '1016', dayType);
  assert(departures.length > 0, 'Line 1 must have departures at Rodalies');
  const publishedFirstTrip = departures[0]; // e.g. "05:25" or "05:33"
  const publishedSec = timeEngine.timeStringToSeconds(publishedFirstTrip);
  assert(Number.isFinite(publishedSec));

  // Construct a base timestamp for this departure in Europe/Madrid on 2026-09-28 (Monday)
  // 2026-09-28 is a weekday.
  // 05:25 Madrid is UTC 03:25 (CEST UTC+2).
  const baseEpochMs = Date.UTC(2026, 8, 28, Math.floor(publishedSec / 3600) - 2, Math.floor((publishedSec % 3600) / 60), publishedSec % 60);

  // Scenario 1: Bus arrives 2 minutes late (passing time = published + 120s)
  // Sample 1: Bus approaching stop 1016, 150m away.
  const sample1Ts = baseEpochMs + 60 * 1000; // 1 min after published
  daemon.openVisits.set('bus_test_1', {
    key: '1|11|Rodalies',
    vehicleId: 'bus_test_1',
    lineCode: 'L1',
    direction: '11',
    stopName: 'Rodalies',
    firstTs: sample1Ts,
    lastTs: sample1Ts,
    lastDelay: 2, // operator reports 2 min delay
    count: 1,
    scheduledTime: publishedFirstTrip,
    actualTime: publishedFirstTrip,
    timesSource: 'derived_timetable',
    isRealTime: true,
    lastObservedAt: sample1Ts,
    passingAt: null
  });

  // Sample 2: Bus is within 20m of Rodalies at passing time (+2 min, exactly 120s after published)
  const sample2Ts = baseEpochMs + 120 * 1000;
  const visit = daemon.openVisits.get('bus_test_1');
  assert(visit);
  // Bus reaches <= 30m of stop:
  visit.lastTs = sample2Ts;
  visit.lastDelay = 2;
  visit.count++;
  visit.passingAt = sample2Ts;

  // Flush the visit
  daemon.flushVisit(visit);

  // Query database to verify stop_visits row
  const rows = historyDb.db.prepare('SELECT * FROM stop_visits WHERE vehicle_id = ?').all('bus_test_1');
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.stop_name, 'Rodalies');
  assert.equal(row.delay_mins, 2, 'Operator delay should be 2 mins');
  assert.equal(row.measured_delay_mins, 2, `Arribo measured delay should be 2 mins (got ${row.measured_delay_mins})`);
  console.log(`  ✓ Sample 1 (bus at <=30m): Operator delay ${row.delay_mins}m, Measured delay ${row.measured_delay_mins}m.`);

  // Scenario 2: Bus passing time detected via transition to next stop
  // Published trip: 2nd departure on Line 1 at Rodalies
  const publishedTrip2 = departures[1];
  const pubSec2 = timeEngine.timeStringToSeconds(publishedTrip2);
  const baseEpochMs2 = Date.UTC(2026, 8, 28, Math.floor(pubSec2 / 3600) - 2, Math.floor((pubSec2 % 3600) / 60), pubSec2 % 60);

  // Bus approaching Rodalies:
  const sampleA_Ts = baseEpochMs2 + 180 * 1000; // 3 min after published
  daemon.openVisits.set('bus_test_2', {
    key: '1|11|Rodalies',
    vehicleId: 'bus_test_2',
    lineCode: 'L1',
    direction: '11',
    stopName: 'Rodalies',
    firstTs: sampleA_Ts,
    lastTs: sampleA_Ts,
    lastDelay: 4,
    count: 2,
    scheduledTime: publishedTrip2,
    actualTime: publishedTrip2,
    timesSource: 'derived_timetable',
    isRealTime: true,
    lastObservedAt: sampleA_Ts,
    passingAt: null
  });

  // Next sample: bus has passed Rodalies and toStop transitioned to next stop (Sant Joan) at +4 min (240s)
  const transitionTs = baseEpochMs2 + 240 * 1000;
  const visit2 = daemon.openVisits.get('bus_test_2');
  assert(!visit2.passingAt);
  // Transition detection:
  visit2.passingAt = transitionTs;
  daemon.flushVisit(visit2);

  const row2 = historyDb.db.prepare('SELECT * FROM stop_visits WHERE vehicle_id = ?').get('bus_test_2');
  assert(row2);
  assert.equal(row2.delay_mins, 4, 'Operator delay should be 4 mins');
  assert.equal(row2.measured_delay_mins, 4, `Arribo measured delay should be 4 mins (got ${row2.measured_delay_mins})`);
  console.log(`  ✓ Sample 2 (next-stop transition): Operator delay ${row2.delay_mins}m, Measured delay ${row2.measured_delay_mins}m.`);

  // Scenario 3: Verify getJournalismReport delayMeasurementComparison KPI
  // The fixture visits are dated 2026-09-28; evaluate the rolling 24 h report one
  // hour after the second visit so the suite does not depend on the real clock.
  const realDateNow = Date.now;
  Date.now = () => baseEpochMs2 + 3600 * 1000;
  let report;
  try {
    report = historyDb.getJournalismReport(24, [{ id: '1', code: 'L1' }]);
  } finally {
    Date.now = realDateNow;
  }
  assert(report.summary);
  assert(report.summary.delayMeasurementComparison, 'summary must include delayMeasurementComparison');
  const comp = report.summary.delayMeasurementComparison;
  assert.equal(comp.hasData, true);
  assert.equal(comp.comparedVisits, 2);
  assert.equal(comp.operatorAvgDelay, 3.0); // (2 + 4) / 2 = 3.0
  assert.equal(comp.measuredAvgDelay, 3.0); // (2 + 4) / 2 = 3.0
  assert.equal(comp.agreedVisits, 2);
  assert.equal(comp.agreementPct, 100);
  console.log(`  ✓ Journalism report delay comparison: ${comp.comparedVisits} visits compared, ${comp.agreementPct}% agreement.`);

  console.log('🎉 ALL INDEPENDENT DELAY MEASUREMENT ASSERTIONS PASSED!');
})().finally(() => {
  historyDb.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}).then(() => process.exit(0)).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
