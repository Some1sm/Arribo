const assert = require('assert');
const historyDb = require('../src/historyDb');
const trackerRegistry = require('../src/core/TrackerRegistry');

/**
 * "El Termòmetre del Bus" scorecard.
 *
 * Two states are covered, and both matter:
 *  1. An EMPTY time window must publish no grade, no champion line, no
 *     bottleneck and no peak hour. It used to publish a full A+ scorecard
 *     (100% punctuality, L1 at 95%, "Pl. de les Tereses", 08:00-09:00 peak)
 *     invented from nothing, and the share/PNG exporters published it.
 *  2. A populated window must grade real samples and never invent a value for
 *     a sublist that is empty.
 */
async function runTests() {
  console.log('🧪 Running "El Termòmetre del Bus" Scorecard Tests...\n');

  const allLines = trackerRegistry.getAllLines();

  // ── 1. Empty window: an explicit "no data" state, not a perfect score ──
  console.log('Test 1: Empty time window must not fabricate a scorecard');
  historyDb.init();
  const emptyReport = await historyDb.getJournalismReport(24, allLines);
  assert.ok(emptyReport, 'Report should be defined');
  assert.ok(emptyReport.termometre, 'Report must still contain a termometre object so consumers render the empty state');

  const empty = emptyReport.termometre;
  console.log('  termometre.noData =', empty.noData, '| grade =', empty.grade, '| punctualityPct =', empty.punctualityPct);

  assert.strictEqual(empty.noData, true, 'noData must be true when the window holds no samples');
  assert.ok(empty.noDataReason && empty.noDataReason.length > 0, 'noData must carry a reason for the renderer');
  assert.strictEqual(empty.grade, null, 'No grade may be invented from an empty window');
  assert.strictEqual(empty.punctualityPct, null, 'Punctuality is a ratio over real samples; with none it is unknown, never 100');
  assert.strictEqual(empty.championLine, null, 'No champion line may be invented (it used to be L1 at 95%)');
  assert.strictEqual(empty.worstBottleneck, null, 'No bottleneck stop may be invented (it used to be "Pl. de les Tereses")');
  assert.strictEqual(empty.peakHour, null, 'No peak hour may be invented (it used to be 08:00 - 09:00)');
  assert.strictEqual(empty.peakHourDelay, null, 'No peak-hour delay may be invented (it used to be 2.5 min)');
  assert.strictEqual(empty.peakHourTag, null, 'No peak-hour tag may be invented');
  assert.strictEqual(empty.networkAvgDelay, null, 'Network average delay is unknown with no samples, never 0');
  assert.strictEqual(empty.totalTripsAnalyzed, 0, 'The sample count is reported as the real 0');

  // The same rule applies to the summary KPIs the Termòmetre is built from.
  assert.strictEqual(emptyReport.summary.hasSamples, false, 'Summary must declare that it has no samples');
  assert.strictEqual(emptyReport.summary.networkPunctualityPct, null, 'Summary punctuality must be null, not 100%');
  assert.strictEqual(emptyReport.summary.networkMaxDelay, null, 'Summary max delay must be null, not 0');
  assert.strictEqual(emptyReport.summary.networkAvgDelay, null, 'Summary average delay must be null, not 0');
  assert.strictEqual(emptyReport.summary.samplingBreakdown.nonRealtimePct, null, 'The non-realtime share is undefined without samples');
  assert.deepStrictEqual(emptyReport.peakHours, [], 'No peak hour can be ranked from an empty window');
  assert.deepStrictEqual(emptyReport.rankingWorstStops, [], 'No bottleneck stop can be ranked from an empty window');
  assert.deepStrictEqual(emptyReport.rankingMostDelayed, [], 'No line can be ranked from an empty window');
  console.log('✓ Empty window yields an explicit no-data state, no grade and no invented names.\n');

  // ── 2. Populated window: every figure traces to a real sample ──
  console.log('Test 2: Populated window grades real samples');
  // Anchor inside a Madrid daytime hour so the telemetry-anomaly filter
  // (night hours, depot stops, 06:00-06:30 SAE rollout) does not discard the
  // fixture and leave the window empty again.
  const now = Date.now();
  const utc = new Date(now);
  const tz = new Date(new Date(utc.toLocaleString('en-US', { timeZone: 'Europe/Madrid' })));
  const offset = tz.getTime() - utc.getTime();
  const madrid = new Date(now + offset);
  let base = Date.UTC(madrid.getUTCFullYear(), madrid.getUTCMonth(), madrid.getUTCDate(), 14, 0, 0) - offset;
  if (base > now - 2 * 3600 * 1000) base -= 86400000;
  const minute = 60 * 1000;

  // L2 is the worst line and the worst stop, inside a daytime hour.
  for (let i = 0; i < 6; i++) {
    historyDb.recordDelayLog({
      vehicleId: `268${i}`, lineId: '2', lineCode: 'L2', agency: 'Mataró Bus (Avanza)',
      stopId: '2001', stopName: 'Hospital de Mataró', delayMins: 6,
      isRealTime: true, timestamp: base + i * minute
    });
  }
  // L1 is punctual, and includes one extrapolated (non-realtime) sample.
  for (let i = 0; i < 5; i++) {
    historyDb.recordDelayLog({
      vehicleId: `269${i}`, lineId: '1', lineCode: 'L1', agency: 'Mataró Bus (Avanza)',
      stopId: '1001', stopName: 'Plaça de Cuba', delayMins: 0,
      isRealTime: i !== 0, timestamp: base + i * minute
    });
  }

  const report = await historyDb.getJournalismReport(24, allLines);
  const t = report.termometre;
  console.log('✓ Termòmetre object present:', t.title);

  assert.strictEqual(t.noData, false, 'A populated window is not flagged as no-data');
  assert.ok(['A+', 'A', 'B', 'C', 'D'].includes(t.grade), `Grade must be a real letter grade, got: ${t.grade}`);
  console.log('✓ Calculated letter grade:', t.grade);

  assert.ok(typeof t.punctualityPct === 'number' && t.punctualityPct >= 0 && t.punctualityPct <= 100);
  console.log('✓ Network punctuality percentage:', t.punctualityPct + '%');

  assert.ok(t.championLine, 'Champion line must be identified when there are samples');
  assert.strictEqual(t.championLine.code, 'L1', 'The punctual line is the champion — not a hardcoded L1');
  assert.ok(t.championLine.onTimePct === null || typeof t.championLine.onTimePct === 'number', 'Champion punctuality is measured or null, never defaulted');
  assert.strictEqual(t.championLine.avgDelay, 0, 'Champion average delay is the measured 0, not a fabricated 0.8');
  console.log(`✓ Champion line: ${t.championLine.code} (${t.championLine.onTimePct}% on time)`);

  assert.ok(t.worstBottleneck, 'Worst bottleneck stop must be identified when there are samples');
  assert.strictEqual(t.worstBottleneck.stopName, 'Hospital de Mataró', 'The bottleneck comes from the data, not from a hardcoded stop name');
  assert.strictEqual(t.worstBottleneck.lineCode, 'L2');
  console.log(`✓ Bottleneck stop: ${t.worstBottleneck.stopName} (+${t.worstBottleneck.avgDelay} min delay)`);

  assert.ok(t.peakHour, 'Peak congestion hour must be identified when there are samples');
  assert.ok(/^\d{2}:00 - \d{2}:00$/.test(t.peakHour), `Peak hour must be a real measured window, got: ${t.peakHour}`);
  assert.ok(typeof t.peakHourDelay === 'number', 'Peak-hour delay is measured, not defaulted');
  assert.notStrictEqual(t.peakHourDelay, 2.5, 'Peak-hour delay is not the old hardcoded 2.5');
  console.log(`✓ Peak congestion hour: ${t.peakHour} (+${t.peakHourDelay} min)`);

  // ── 3. Extrapolated samples are disclosed, not hidden ──
  console.log('\nTest 3: Extrapolated samples are disclosed in the sampling breakdown');
  const sb = report.summary.samplingBreakdown;
  assert.ok(sb, 'A sampling breakdown must be published');
  assert.strictEqual(sb.totalSamples, 11, 'All 11 recorded samples are counted');
  assert.strictEqual(sb.nonRealtimeSamples, 1, 'The single extrapolated sample is counted separately');
  assert.strictEqual(sb.realtimeSamples, 10, 'The realtime sample count is reported');
  assert.strictEqual(sb.nonRealtimePct, 9.1, 'The extrapolated share is disclosed as a percentage');
  assert.ok(sb.note && sb.note.length > 0, 'The breakdown explains what is_realtime = 0 means');
  console.log(`✓ ${sb.nonRealtimeSamples}/${sb.totalSamples} samples (${sb.nonRealtimePct}%) are extrapolated and disclosed.`);

  console.log('\n✅ ALL TERMÒMETRE SCORECARD TESTS PASSED!\n');
  try { historyDb.close(); } catch {}
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
