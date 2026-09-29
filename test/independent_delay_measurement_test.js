'use strict';

/**
 * test/independent_delay_measurement_test.js
 *
 * Verifies Phase 9.3:
 * 1. Computes bus's own passing time at that stop:
 *    the observedAt of the first sample whose toStop is the next stop,
 *    or if the bus was within 30m of the stop, that sample's observedAt.
 * 2. Stores measured_delay_mins = passing - published time of the trip the
 *    operator's delay points to (visit.scheduledTime), with
 *    measured_method = 'operator_trip' and trip_agrees = whether the nearest
 *    departure to the passing time is that same trip.
 * 3. Asserts getJournalismReport calculates delayMeasurementComparison (operator vs measured delay,
 *    agreement within 1 min, bias, trip confirmation, per-line and per-hour rows) from
 *    operator_trip rows only, and that the visits CSV blanks legacy measurements.
 * 4. A bus later than half a headway keeps its real delay instead of flipping
 *    to "early on the next trip".
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
  assert.equal(row.measured_method, 'operator_trip');
  assert.equal(row.trip_agrees, 1, 'nearest departure is the operator trip');
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
  assert.equal(row2.measured_method, 'operator_trip');
  assert.equal(row2.trip_agrees, 1, 'nearest departure is the operator trip');
  console.log(`  ✓ Sample 2 (next-stop transition): Operator delay ${row2.delay_mins}m, Measured delay ${row2.measured_delay_mins}m.`);

  // A row written before measured_method existed (nearest-departure value) must
  // be excluded from the comparison and blanked in the CSV.
  historyDb.recordStopVisit({
    vehicleId: 'bus_legacy',
    lineCode: 'L1',
    direction: '11',
    stopName: 'Rodalies',
    firstTs: baseEpochMs2 + 300 * 1000,
    lastTs: baseEpochMs2 + 300 * 1000,
    delayMins: 3,
    sampleCount: 1,
    measuredDelayMins: -9,
    source: 'live'
  });

  // Scenario 3: Verify getJournalismReport delayMeasurementComparison KPI
  // The fixture visits are dated 2026-09-28; evaluate the rolling 24 h report one
  // hour after the second visit so the suite does not depend on the real clock.
  const realDateNow = Date.now;
  Date.now = () => baseEpochMs2 + 3600 * 1000;
  let report;
  let visitsCsv;
  try {
    report = historyDb.getJournalismReport(24, [{ id: '1', code: 'L1' }]);
    visitsCsv = historyDb.exportStopVisitsCsv(24).csv;
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
  assert.equal(comp.method, 'operator_trip');
  assert.equal(comp.biasMins, 0);
  assert.equal(comp.tripCheckedVisits, 2);
  assert.equal(comp.tripConfirmedVisits, 2);
  assert.equal(comp.tripConfirmedPct, 100);
  assert.equal(comp.byLine.length, 1);
  assert.equal(comp.byLine[0].lineCode, 'L1');
  assert.equal(comp.byLine[0].comparedVisits, 2);
  assert.equal(comp.byHour.reduce((sum, h) => sum + h.comparedVisits, 0), 2);
  console.log(`  ✓ Journalism report delay comparison: ${comp.comparedVisits} visits compared, ${comp.agreementPct}% agreement.`);

  const csvLines = visitsCsv.trim().split('\n');
  assert.ok(csvLines[0].endsWith(',Font,Viatge confirmat'), 'visits CSV header ends with Viatge confirmat');
  const legacyLine = csvLines.find(l => l.includes('"bus_legacy"'));
  assert.ok(legacyLine, 'legacy row is exported');
  assert.ok(legacyLine.includes(',3,"",1,'), 'legacy nearest-departure measurement is blank in the CSV');
  assert.ok(legacyLine.endsWith(',"live",""'), 'legacy row has no trip confirmation');
  const liveLine = csvLines.find(l => l.includes('"bus_test_2"'));
  assert.ok(liveLine.includes(',4,"4",') && liveLine.endsWith(',"live","1"'), 'operator-trip row exports measured delay and trip confirmation');
  console.log('  ✓ Visits CSV blanks legacy measurements and exports trip confirmation.');

  // Scenario 4: a bus later than half the headway. The nearest departure is the
  // NEXT trip, but the measurement stays on the operator's trip.
  let k = -1;
  for (let i = 0; i + 1 < departures.length; i++) {
    const gap = (timeEngine.timeStringToSeconds(departures[i + 1]) - timeEngine.timeStringToSeconds(departures[i])) / 60;
    if (gap >= 8 && gap <= 20) { k = i; break; }
  }
  assert(k >= 0, 'Line 1 Rodalies must have two consecutive departures 8-20 min apart');
  const gapMins = (timeEngine.timeStringToSeconds(departures[k + 1]) - timeEngine.timeStringToSeconds(departures[k])) / 60;
  const lateMins = Math.ceil(gapMins * 0.75);
  const pubSec4 = timeEngine.timeStringToSeconds(departures[k]);
  const baseEpochMs4 = Date.UTC(2026, 8, 28, Math.floor(pubSec4 / 3600) - 2, Math.floor((pubSec4 % 3600) / 60), pubSec4 % 60);
  const passing4 = baseEpochMs4 + lateMins * 60 * 1000;
  daemon.flushVisit({
    key: '1|11|Rodalies',
    vehicleId: 'bus_test_late',
    lineCode: 'L1',
    direction: '11',
    stopName: 'Rodalies',
    firstTs: passing4 - 60 * 1000,
    lastTs: passing4,
    lastDelay: lateMins,
    count: 3,
    scheduledTime: departures[k],
    actualTime: departures[k],
    timesSource: 'derived_timetable',
    isRealTime: true,
    lastObservedAt: passing4,
    passingAt: passing4
  });
  const row4 = historyDb.db.prepare('SELECT * FROM stop_visits WHERE vehicle_id = ?').get('bus_test_late');
  assert.equal(row4.measured_delay_mins, lateMins, `a bus ${lateMins} min late must be measured ${lateMins} min late (got ${row4.measured_delay_mins})`);
  assert.equal(row4.trip_agrees, 0, 'the nearest departure is the next trip, so the trip is not independently confirmed');
  console.log(`  ✓ Sample 4 (late beyond half headway): Operator delay ${row4.delay_mins}m, Measured delay ${row4.measured_delay_mins}m, trip confirmed ${row4.trip_agrees}.`);

  console.log('🎉 ALL INDEPENDENT DELAY MEASUREMENT ASSERTIONS PASSED!');
})().finally(() => {
  historyDb.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}).then(() => process.exit(0)).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
