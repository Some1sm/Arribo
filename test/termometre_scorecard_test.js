const assert = require('assert');
const historyDb = require('../src/historyDb');
const trackerRegistry = require('../src/core/TrackerRegistry');

async function runTests() {
  console.log('🧪 Running "El Termòmetre del Bus" Scorecard Tests...\n');

  // Test Journalism report structure including Termometre scorecard
  console.log('Test 1: Check termometre payload in getJournalismReport');
  const allLines = trackerRegistry.getAllLines();
  const report = await historyDb.getJournalismReport(24, allLines);

  assert.ok(report, 'Report should be defined');
  assert.ok(report.termometre, 'Report must contain termometre scorecard payload');

  const t = report.termometre;
  console.log('✓ Termòmetre object present:', t.title);

  assert.ok(['A+', 'A', 'B+', 'B', 'C', 'D'].includes(t.grade), `Grade must be a valid letter grade, got: ${t.grade}`);
  console.log('✓ Calculated letter grade:', t.grade);

  assert.ok(typeof t.punctualityPct === 'number' && t.punctualityPct >= 0 && t.punctualityPct <= 100);
  console.log('✓ Network punctuality percentage:', t.punctualityPct + '%');

  assert.ok(t.championLine, 'Champion line must be identified');
  console.log(`✓ Champion line: ${t.championLine.code} (${t.championLine.onTimePct}% on time)`);

  assert.ok(t.worstBottleneck, 'Worst bottleneck stop must be identified');
  console.log(`✓ Bottleneck stop: ${t.worstBottleneck.stopName} (+${t.worstBottleneck.avgDelay} min delay)`);

  assert.ok(t.peakHour, 'Peak congestion hour must be identified');
  console.log(`✓ Peak congestion hour: ${t.peakHour}`);

  console.log('\n✅ ALL TERMÒMETRE SCORECARD TESTS PASSED PERFECTLY!\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
