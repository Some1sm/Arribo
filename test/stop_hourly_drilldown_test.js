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
    entry.delayMins, '08:00', '08:05', 1, entry.delayMins > 3 ? 1 : 0, entry.timestamp
  );
}

async function run() {
  console.log('Running stop hourly drilldown report tests...');
  historyDb.init();
  reportCacheService.setDatabase(historyDb);

  const now = Date.now();
  // Anchor inserts inside one Madrid-local hour so bucket counts are deterministic
  const base = Math.floor((now - 2 * 3600 * 1000) / 3600000) * 3600000 + 10 * 60000;

  // Same stop NAME on two lines sharing stop ID 1016 — identity must keep rows separate
  for (let i = 0; i < 5; i++) {
    insert({ lineId: 'L1', lineCode: 'L1', agency: 'Mataró Bus', stopId: '1016', stopName: 'Estació Rodalies', delayMins: 8, timestamp: base + i * 60000 });
  }
  for (let i = 0; i < 4; i++) {
    insert({ lineId: 'L2', lineCode: 'L2', agency: 'Mataró Bus', stopId: '1016', stopName: 'Estació Rodalies', delayMins: 6, timestamp: base + i * 60000 });
  }
  // Different stop ID, same name, same line — must NOT merge with 1016
  insert({ lineId: 'L1', lineCode: 'L1', agency: 'Mataró Bus', stopId: '1099', stopName: 'Estació Rodalies', delayMins: 9, timestamp: base });

  // Early/on-time samples counted in buckets when the row qualifies overall
  insert({ lineId: 'L3', lineCode: 'L3', agency: 'Mataró Bus', stopId: '1001', stopName: 'Hospital', delayMins: 7, timestamp: base });
  insert({ lineId: 'L3', lineCode: 'L3', agency: 'Mataró Bus', stopId: '1001', stopName: 'Hospital', delayMins: -2, timestamp: base + 60000 });
  insert({ lineId: 'L3', lineCode: 'L3', agency: 'Mataró Bus', stopId: '1001', stopName: 'Hospital', delayMins: 0, timestamp: base + 120000 });

  const catalog = [
    { id: '1', code: 'L1', name: 'Línia 1', agency: 'Mataró Bus' },
    { id: '2', code: 'L2', name: 'Línia 2', agency: 'Mataró Bus' },
    { id: '3', code: 'L3', name: 'Línia 3', agency: 'Mataró Bus' }
  ];

  const report = historyDb.getJournalismReport(24, catalog);
  const worst = report.rankingWorstStops;
  assert.ok(Array.isArray(worst), 'rankingWorstStops must exist');
  assert.ok(worst.length >= 2, `expected at least two bottleneck rows, got ${worst.length}`);

  for (const stop of worst) {
    assert.equal(stop.hourly.length, 24, 'each stop carries 24 hourly buckets');
    for (const bucket of stop.hourly) {
      assert.match(bucket.hour, /^\d{2}$/);
      assert.equal(typeof bucket.sampleCount, 'number');
      if (bucket.sampleCount === 0) {
        assert.equal(bucket.avgDelay, null, 'empty bucket keeps null avgDelay');
        assert.equal(bucket.maxDelay, null, 'empty bucket keeps null maxDelay');
        assert.equal(bucket.severeLatePct, null, 'empty bucket keeps null severeLatePct');
      } else {
        assert.equal(typeof bucket.avgDelay, 'number');
        assert.equal(typeof bucket.maxDelay, 'number');
        assert.equal(typeof bucket.severeLatePct, 'number');
      }
    }
  }

  const l1 = worst.find(s => s.stopId === '1016' && s.lineCode === 'L1');
  assert.ok(l1, 'stop 1016 L1 row present with stable stopId');
  assert.equal(l1.stopName, 'Estació Rodalies');
  assert.equal(l1.hourly.reduce((a, b) => a + b.sampleCount, 0), 5, 'L1 1016 has exactly its 5 samples');
  const activeL1 = l1.hourly.filter(b => b.sampleCount > 0);
  assert.ok(activeL1.length === 1 || activeL1.length === 2, 'samples fall in one or two hour buckets');
  assert.equal(l1.hourly.filter(b => b.sampleCount === 0).length, 24 - activeL1.length, 'remaining buckets empty, not zero-filled');
  assert.ok(Math.abs(l1.avgDelay - 8) < 0.1, 'L1 avgDelay reflects fixture values');

  const l2 = worst.find(s => s.stopId === '1016' && s.lineCode === 'L2');
  assert.ok(l2, 'same stop on a different line kept separate');
  assert.equal(l2.hourly.reduce((a, b) => a + b.sampleCount, 0), 4, 'L2 1016 has exactly its 4 samples');

  const other = worst.find(s => s.stopId === '1099');
  assert.ok(other, 'same-name stop on different ID is its own row');
  assert.equal(other.hourly.reduce((a, b) => a + b.sampleCount, 0), 1, '1099 has exactly 1 sample');

  const hospital = worst.find(s => s.stopId === '1001');
  assert.ok(hospital, 'Hospital row qualifies via severe sample');
  assert.equal(hospital.hourly.reduce((a, b) => a + b.sampleCount, 0), 3, 'early/on-time samples counted alongside late ones');
  assert.ok(hospital.hourly.some(b => b.sampleCount > 0 && b.avgDelay !== null && b.avgDelay < 3),
    'bucket with only early/zero samples reports its true low average');

  const weighted = l1.hourly.reduce((acc, b) => acc + (b.avgDelay || 0) * b.sampleCount, 0) / l1.hourly.reduce((a, b) => a + b.sampleCount, 0);
  assert.ok(Math.abs(l1.avgDelay - weighted) < 0.6, `overall avgDelay (${l1.avgDelay}) consistent with weighted hourly data (${weighted})`);

  const generated = await reportCacheService.generateAndSaveReport(24, catalog);
  assert.ok(Array.isArray(generated.rankingWorstStops));
  assert.ok(generated.rankingWorstStops.every(s => Array.isArray(s.hourly) && s.hourly.length === 24),
    'report cache carries hourly data through');

  // Timeframe boundary: a row older than 24h but within 48h is excluded from 24h and included in 48h.
  // Anchor timestamp to daytime revenue hours (12:00 UTC / 14:00 Madrid) so it is not excluded by anomaly filters near midnight.
  let boundaryTs = now - 30 * 3600 * 1000;
  const bd = new Date(boundaryTs);
  bd.setUTCHours(12, 0, 0, 0);
  boundaryTs = bd.getTime();
  if (boundaryTs <= now - 48 * 3600 * 1000) boundaryTs += 24 * 3600 * 1000;
  if (boundaryTs >= now - 24 * 3600 * 1000) boundaryTs -= 24 * 3600 * 1000;

  insert({ lineId: 'L1', lineCode: 'L1', agency: 'Mataró Bus', stopId: '1016', stopName: 'Estació Rodalies', delayMins: 4, timestamp: boundaryTs });
  const report24 = historyDb.getJournalismReport(24, catalog);
  const l1b = report24.rankingWorstStops.find(s => s.stopId === '1016' && s.lineCode === 'L1');
  assert.equal(l1b.hourly.reduce((a, b) => a + b.sampleCount, 0), 5, 'row outside 24h window excluded');
  const report48 = historyDb.getJournalismReport(48, catalog);
  const l1c = report48.rankingWorstStops.find(s => s.stopId === '1016' && s.lineCode === 'L1');
  assert.equal(l1c.hourly.reduce((a, b) => a + b.sampleCount, 0), 6, 'same row included in 48h window');

  console.log('All stop hourly drilldown tests passed.');
}

run().then(() => process.exit(0)).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
