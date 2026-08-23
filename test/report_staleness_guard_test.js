#!/usr/bin/env node
/**
 * Report Staleness Guard Test
 * ---------------------------
 * Guards against the Observatori de Retards freezing at a fossil timestamp:
 * reportCacheService.getLatestReport() must treat stale memory-cached reports
 * (worker generation stalled / IPC lost) as cache misses so callers fall back
 * to the on-demand worker RPC instead of serving ancient data forever.
 *
 * Run: node test/report_staleness_guard_test.js
 */
process.env.TZ = 'Europe/Madrid';
const assert = require('assert');
const path = require('path');
const reportCacheService = require(path.join(__dirname, '..', 'src', 'reportCacheService'));

const mkReport = (ageMs) => ({
  summary: { totalArrivals: 1 },
  meta: { generatedTimestamp: Date.now() - ageMs }
});

(async () => {
  let passed = 0;
  const check = (name, cond) => { check.total++; assert(cond, name); passed++; console.log(`✅ ${name}`); };
  check.total = 0;

  // Fresh report → served instantly from memory (<1ms contract)
  reportCacheService.updateMemoryCache(24, mkReport(10 * 60 * 1000));
  const r1 = await reportCacheService.getLatestReport(24);
  check('fresh (10 min old) served from memory', r1 && r1.summary.totalArrivals === 1);

  // Stale report (2h old) → miss → null → caller falls back to worker RPC
  reportCacheService.updateMemoryCache(48, mkReport(2 * 60 * 60 * 1000));
  check('stale (2h old) treated as miss → null', (await reportCacheService.getLatestReport(48)) === null);

  // Skeleton without meta (degraded catch-all return) → stale
  reportCacheService.updateMemoryCache(168, { summary: {} });
  check('skeleton (no meta) treated as miss → null', (await reportCacheService.getLatestReport(168)) === null);

  // Boundary semantics (deterministic under coarse clocks)
  check('65 min boundary = stale', reportCacheService.isReportStale(mkReport(66 * 60 * 1000)) === true);
  check('64 min boundary = fresh', reportCacheService.isReportStale(mkReport(64 * 60 * 1000)) === false);
  check('custom maxAgeMs respected', reportCacheService.isReportStale(mkReport(20 * 60 * 1000), { maxAgeMs: 10 * 60 * 1000 }) === true);

  console.log(`\n🎉 ALL ${passed} REPORT STALENESS-GUARD CHECKS PASSED`);
  process.exit(0);
})().catch(e => { console.error('\n💥 FAIL:', e.message); process.exit(1); });
