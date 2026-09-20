const assert = require('node:assert/strict');
const historyDb = require('../src/historyDb');
const reportCacheService = require('../src/reportCacheService');

function insert(entry) {
  historyDb.db.prepare(`
    INSERT INTO delay_logs (
      line_id, line_code, agency, stop_id, stop_name,
      delay_mins, scheduled_time, actual_time, is_realtime, is_delayed, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.lineId, entry.lineCode, entry.agency, entry.stopId, entry.stopName,
    entry.delayMins, '10:00', '10:05', 1, entry.delayMins > 3 ? 1 : 0, entry.timestamp
  );
}

async function run() {
  console.log('🧪 Running Observatori All-Stops & Bottlenecks Test...');
  historyDb.init();
  reportCacheService.setDatabase(historyDb);

  const now = Date.now();
  // Safe midday hour so is_telemetry_anomaly returns 0
  const d = new Date(now);
  d.setUTCHours(10, 0, 0, 0);
  const base = d.getTime();

  const catalog = [
    { id: '1', code: 'L1', name: 'Línia 1', agency: 'Mataró Bus' },
    { id: '2', code: 'L2', name: 'Línia 2', agency: 'Mataró Bus' },
    { id: '6', code: 'L6', name: 'Línia 6', agency: 'Mataró Bus' }
  ];

  // 1. Insert bottleneck stops for L2 (avgDelay >= 1.5 min)
  insert({ lineId: '2', lineCode: 'L2', agency: 'Mataró Bus', stopId: '2001', stopName: 'Hospital de Mataró', delayMins: 4.5, timestamp: base });
  insert({ lineId: '2', lineCode: 'L2', agency: 'Mataró Bus', stopId: '2002', stopName: 'Mataró Parc', delayMins: 2.2, timestamp: base + 60000 });

  // 2. Insert punctual stops for L2 (avgDelay < 1.5 min, severeLatePct < 20%)
  insert({ lineId: '2', lineCode: 'L2', agency: 'Mataró Bus', stopId: '2003', stopName: 'Plaça de Cuba', delayMins: 0.2, timestamp: base + 120000 });
  insert({ lineId: '2', lineCode: 'L2', agency: 'Mataró Bus', stopId: '2004', stopName: 'Camí del Mig', delayMins: 0.0, timestamp: base + 180000 });
  insert({ lineId: '2', lineCode: 'L2', agency: 'Mataró Bus', stopId: '2005', stopName: 'La Riera', delayMins: -0.5, timestamp: base + 240000 });

  // 3. Insert punctual stop for L6
  insert({ lineId: '6', lineCode: 'L6', agency: 'Mataró Bus', stopId: '6001', stopName: 'Can Soleret', delayMins: 0.3, timestamp: base + 300000 });

  const report = historyDb.getJournalismReport(24, catalog);

  // Assertion 1: rankingWorstStops must exist and ONLY contain bottlenecks
  assert.ok(Array.isArray(report.rankingWorstStops), 'rankingWorstStops must be an array');
  assert.ok(Array.isArray(report.allStopDelays), 'allStopDelays must be an array');

  console.log(`   - rankingWorstStops count: ${report.rankingWorstStops.length}`);
  console.log(`   - allStopDelays count: ${report.allStopDelays.length}`);

  // All entries in rankingWorstStops must satisfy bottleneck criteria
  for (const s of report.rankingWorstStops) {
    assert.equal(s.isBottleneck, true, `stop ${s.stopName} in rankingWorstStops must have isBottleneck === true`);
    assert.ok(s.avgDelay >= 1.5 || (s.severeLatePct || 0) >= 20, `stop ${s.stopName} must qualify as bottleneck`);
  }

  // All entries in allStopDelays must be correctly tagged
  assert.ok(report.allStopDelays.length >= report.rankingWorstStops.length, 'allStopDelays >= rankingWorstStops');

  const l2Worst = report.rankingWorstStops.filter(s => s.lineCode === 'L2');
  const l2All = report.allStopDelays.filter(s => s.lineCode === 'L2');
  console.log(`   - L2 bottlenecks: ${l2Worst.length}, L2 all stops: ${l2All.length}`);

  assert.ok(l2Worst.length >= 2, 'L2 has at least 2 bottlenecks');
  assert.ok(l2All.length >= 5, 'L2 has at least 5 total stops recorded');

  // Verify punctual stops are present in allStopDelays but NOT in rankingWorstStops
  const plCuba = report.allStopDelays.find(s => s.stopId === '2003');
  assert.ok(plCuba, 'Plaça de Cuba must be present in allStopDelays');
  assert.equal(plCuba.isBottleneck, false, 'Plaça de Cuba must have isBottleneck === false');
  assert.equal(report.rankingWorstStops.some(s => s.stopId === '2003'), false, 'Plaça de Cuba must NOT be in rankingWorstStops');

  // Verify 24-hour buckets exist for punctual stops
  assert.equal(plCuba.hourly.length, 24, 'Punctual stops must carry full 24h hourly buckets');

  // Verify L6 punctual stop
  const l6All = report.allStopDelays.filter(s => s.lineCode === 'L6');
  const l6Worst = report.rankingWorstStops.filter(s => s.lineCode === 'L6');
  assert.ok(l6All.some(s => s.stopId === '6001'), 'Can Soleret in allStopDelays');
  assert.equal(l6Worst.some(s => s.stopId === '6001'), false, 'Can Soleret not in bottlenecks');

  // Assertion 2: ReportCacheService generates and preserves allStopDelays
  const cachedReport = await reportCacheService.generateAndSaveReport(24, catalog);
  assert.ok(Array.isArray(cachedReport.allStopDelays), 'cached report carries allStopDelays');
  assert.ok(cachedReport.allStopDelays.length >= 5, 'cached report carries full stop delays array');

  console.log('✅ ALL OBSERVATORI ALL-STOPS & BOTTLENECK TESTS PASSED!');
}

run().then(() => process.exit(0)).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
