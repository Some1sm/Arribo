const assert = require('assert');
const historyDb = require('../src/historyDb');
const reportCacheService = require('../src/reportCacheService');

async function runHourlyDelaysObservatoriTests() {
  console.log('🧪 Running Hourly Delays & Bottlenecks Observatori Test Suite...');

  historyDb.init();

  // Test 1: Report Schema Structure
  console.log('\n1. Testing 24h Journalism Report Schema for Hourly Delays...');
  const report = historyDb.getJournalismReport(24);
  
  assert(report, 'Report must not be null/undefined');
  assert(Array.isArray(report.hourlyDelays), 'report.hourlyDelays must be an array');
  assert.strictEqual(report.hourlyDelays.length, 24, 'report.hourlyDelays must have exactly 24 hours (00 to 23)');

  for (let h = 0; h < 24; h++) {
    const entry = report.hourlyDelays[h];
    const expectedH = String(h).padStart(2, '0');
    assert.strictEqual(entry.hour, expectedH, `Entry index ${h} should have hour '${expectedH}'`);
    assert(typeof entry.timeWindow === 'string' && entry.timeWindow.includes(':00 - '), `Entry ${expectedH} must have valid timeWindow string`);
    assert(typeof entry.sampleCount === 'number', `Entry ${expectedH} sampleCount must be a number`);
    assert(typeof entry.avgDelay === 'number', `Entry ${expectedH} avgDelay must be a number`);
    assert(typeof entry.trafficTag === 'string' && entry.trafficTag.length > 0, `Entry ${expectedH} trafficTag must be non-empty string`);
    assert(typeof entry.isSchoolHour === 'boolean', `Entry ${expectedH} isSchoolHour must be boolean`);
    assert(typeof entry.isPeak === 'boolean', `Entry ${expectedH} isPeak must be boolean`);
    assert(typeof entry.icon === 'string', `Entry ${expectedH} icon must be a string`);
  }
  console.log('✓ All 24 hourly buckets conform strictly to schema.');

  // Test 2: School Rush Contextual Tags
  console.log('\n2. Testing Catalan School Rush & Peak Hour Mapping...');
  const h08 = report.hourlyDelays[8];
  assert.strictEqual(h08.isSchoolHour, true, '08:00 must be marked as isSchoolHour=true');
  assert.strictEqual(h08.isPeak, true, '08:00 must be marked as isPeak=true');
  assert(h08.trafficTag.includes('Entrada escolar'), `08:00 tag should mention 'Entrada escolar', got: ${h08.trafficTag}`);
  assert.strictEqual(h08.icon, '🎒', '08:00 icon should be 🎒');

  const h13 = report.hourlyDelays[13];
  assert.strictEqual(h13.isSchoolHour, true, '13:00 must be marked as isSchoolHour=true');
  assert(h13.trafficTag.includes('Migdia'), `13:00 tag should mention 'Migdia', got: ${h13.trafficTag}`);

  const h17 = report.hourlyDelays[17];
  assert.strictEqual(h17.isSchoolHour, true, '17:00 must be marked as isSchoolHour=true');
  assert(h17.trafficTag.includes('Sortida escolar'), `17:00 tag should mention 'Sortida escolar', got: ${h17.trafficTag}`);

  const h18 = report.hourlyDelays[18];
  assert.strictEqual(h18.isSchoolHour, false, '18:00 is work commute, not school rush');
  assert.strictEqual(h18.isPeak, true, '18:00 is peak work hour');
  assert(h18.trafficTag.includes('tornada feina'), `18:00 tag should mention 'tornada feina', got: ${h18.trafficTag}`);
  console.log('✓ School rush and peak context mappings verified.');

  // Test 3: Peak Hours and Worst Stops during Peak
  console.log('\n3. Testing Peak Hours and Associated Bottlenecks...');
  assert(Array.isArray(report.peakHours), 'report.peakHours must be an array');
  assert(report.peakHours.length <= 5, 'report.peakHours should contain at most 5 entries');

  if (report.peakHours.length > 0) {
    const topPeak = report.peakHours[0];
    assert(topPeak.hour, 'topPeak must have hour');
    assert(Array.isArray(topPeak.worstStopsDuringHour), 'topPeak.worstStopsDuringHour must be an array');
    console.log(`✓ Top peak hour: ${topPeak.timeWindow} (+${topPeak.avgDelay}m avg) with ${topPeak.worstStopsDuringHour.length} bottlenecks attached.`);
  }

  // Test 4: Colls d'Ampolla (rankingWorstStops) Critical Hour Fields
  console.log('\n4. Testing Colls d\'Ampolla (rankingWorstStops) Critical Hour Attachment...');
  assert(Array.isArray(report.rankingWorstStops), 'rankingWorstStops must be an array');
  for (const stop of report.rankingWorstStops) {
    assert(typeof stop.criticalHour === 'string', 'stop.criticalHour must be a string');
    assert(typeof stop.criticalHourAvgDelay === 'number', 'stop.criticalHourAvgDelay must be a number');
    assert(typeof stop.criticalHourTag === 'string', 'stop.criticalHourTag must be a string');
    assert(typeof stop.isSchoolHour === 'boolean', 'stop.isSchoolHour must be a boolean');
  }
  console.log(`✓ ${report.rankingWorstStops.length} bottleneck stops tested. All have criticalHour and school tag fields.`);

  // Test 5: Synthetic Insertion of Delay Logs to Verify End-to-End Aggregation
  console.log('\n5. Testing End-to-End Aggregation with Synthetic School Rush Delays...');
  const testStopName = '__TEST_SCHOOL_BOTTLENECK_STOP__';
  const testLineCode = 'T99';
  const testAgency = 'TestBus';

  // Calculate current Madrid offset
  const now = Date.now();
  const d = new Date();
  const utcDate = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  const tzDate = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Madrid' }));
  const madridOffsetMs = tzDate.getTime() - utcDate.getTime();

  // Create a timestamp that corresponds strictly to 08:30 Europe/Madrid today
  const madridNow = new Date(now + madridOffsetMs);
  const testDateMadrid = new Date(Date.UTC(
    madridNow.getUTCFullYear(),
    madridNow.getUTCMonth(),
    madridNow.getUTCDate(),
    8, 30, 0
  ));
  const testTimestamp = testDateMadrid.getTime() - madridOffsetMs;

  const insertStmt = historyDb.db.prepare(`
    INSERT INTO delay_logs (
      line_id, line_code, agency, stop_id, stop_name,
      delay_mins, scheduled_time, actual_time, is_realtime, is_delayed, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  try {
    // Insert 5 delayed samples at 08:30
    for (let i = 0; i < 5; i++) {
      insertStmt.run(
        'test_99', testLineCode, testAgency, 'stop_99', testStopName,
        12, '08:30', '08:42', 1, 1, testTimestamp + (i * 60000)
      );
    }

    const testReport = historyDb.getJournalismReport(24);
    const bucket08 = testReport.hourlyDelays[8];
    assert(bucket08.sampleCount >= 5, `08:00 bucket should have at least 5 samples, got ${bucket08.sampleCount}`);
    assert(bucket08.avgDelay > 0, `08:00 bucket should have positive avgDelay, got ${bucket08.avgDelay}`);
    assert.strictEqual(bucket08.isSchoolHour, true, '08:00 bucket must be isSchoolHour=true');

    // Find the test stop in rankingWorstStops
    const foundStop = testReport.rankingWorstStops.find(s => s.stopName === testStopName);
    assert(foundStop, `Synthetic bottleneck stop '${testStopName}' should be in rankingWorstStops`);
    assert.strictEqual(foundStop.criticalHour, '08:00 - 09:00', `Critical hour should be '08:00 - 09:00', got ${foundStop.criticalHour}`);
    assert.strictEqual(foundStop.isSchoolHour, true, 'isSchoolHour on synthetic bottleneck should be true');
    assert(foundStop.criticalHourTag.includes('Entrada escolar'), `Tag should mention Entrada escolar, got ${foundStop.criticalHourTag}`);

    // Check peakHours to see if 08:00 includes our stop
    const peak08 = testReport.peakHours.find(p => p.hour === '08');
    if (peak08 && peak08.worstStopsDuringHour.length > 0) {
      const inPeakStops = peak08.worstStopsDuringHour.find(s => s.stopName === testStopName);
      assert(inPeakStops, `Synthetic stop should be listed in worstStopsDuringHour for 08:00`);
      assert.strictEqual(inPeakStops.avgDelay, 12, `avgDelay for test stop should be 12 min`);
    }

    console.log('✓ End-to-end synthetic delay aggregation & bottleneck linkage verified successfully.');
  } finally {
    // Clean up test data
    historyDb.db.prepare("DELETE FROM delay_logs WHERE stop_name = ?").run(testStopName);
    console.log('✓ Cleaned up synthetic test records.');
  }

  // Test 6: ReportCacheService Integration & Fallback Skeleton
  console.log('\n6. Testing ReportCacheService Integration & Fallback Skeleton...');
  reportCacheService.setDatabase(historyDb);
  const generated = await reportCacheService.generateAndSaveReport(24);
  assert(generated, 'ReportCacheService should generate a valid report');
  assert(Array.isArray(generated.hourlyDelays), 'generated.hourlyDelays must be an array');
  assert.strictEqual(generated.hourlyDelays.length, 24, 'generated.hourlyDelays must have 24 hours');
  assert(Array.isArray(generated.peakHours), 'generated.peakHours must be an array');
  console.log('✓ ReportCacheService schema matches historyDb output.');

  console.log('\n🎉 ALL HOURLY DELAYS & BOTTLENECK OBSERVATORI CHECKS PASSED PERFECTLY!\n');
}

runHourlyDelaysObservatoriTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
