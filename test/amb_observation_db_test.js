#!/usr/bin/env node
/**
 * amb_observation_db_test.js — validates the delay-memory persistence layer:
 * insert, query (window/ordering), and the "2 route completions" purge rule.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.DB_PATH = path.join(__dirname, '..', 'data', 'test_scratch', 'amb_observations_test.db');
fs.mkdirSync(path.dirname(process.env.DB_PATH), { recursive: true });
try { for (const suffix of ['', '-wal', '-shm']) fs.unlinkSync(process.env.DB_PATH + suffix); } catch (_) {}

const historyDb = require('../src/historyDb');

let failures = 0;
function check(name, cond) {
  console.log((cond ? '✅' : '❌') + ' ' + name);
  if (!cond) failures++;
}

async function main() {
  const now = Date.now();
  const rows = [
    { agency: 'moventis', lineCode: 'E11.1', lineId: 'e11.1', direction: '0', tripId: 'T1', stopId: 'S1', stopName: 'Pl. Tetuan', scheduledMs: now + 10 * 60000, actualMs: now + 18 * 60000, delayMins: 8, runDurationSecs: 3600 },
    { agency: 'moventis', lineCode: 'E11.1', lineId: 'e11.1', direction: '0', tripId: 'T2', stopId: 'S2', stopName: 'Gran Via', scheduledMs: now + 20 * 60000, actualMs: now + 21 * 60000, delayMins: 1, runDurationSecs: 3600 },
    { agency: 'moventis', lineCode: 'E11.1', lineId: 'e11.1', direction: '1', tripId: 'T3', stopId: 'S1', stopName: 'Pl. Tetuan', scheduledMs: now + 30 * 60000, actualMs: now + 40 * 60000, delayMins: 10, runDurationSecs: 3600 },
    { agency: 'c10', lineCode: 'C-10', lineId: 'c10', direction: '1', tripId: 'T4', stopId: 'S9', stopName: 'Montgat Nord', scheduledMs: now + 5 * 60000, actualMs: now + 13 * 60000, delayMins: 8, runDurationSecs: 4500 },
    { agency: 'moventis', lineCode: 'E11.1', lineId: 'e11.1', direction: '0', tripId: null, stopId: 'S3', stopName: null, scheduledMs: now - 90 * 60000, actualMs: now - 88 * 60000, delayMins: 2, runDurationSecs: null }
  ];
  // one invalid row must be skipped
  rows.push({ lineId: '', stopId: 'X', scheduledMs: NaN, actualMs: 0, delayMins: 0 });

  const r1 = historyDb.saveAmbObservations(rows);
  check('inserts valid rows only', r1.inserted === 5);

  const recent = historyDb.getRecentAmbObservations({ lineId: 'e11.1', direction: '0' });
  check('query returns dir0 rows newest-first', recent.length === 3 && recent[0].tripId === 'T2' && recent[2].tripId === null);
  check('camelCase mapping', recent[0].scheduledMs && typeof recent[0].lineCode === 'string');

  const narrow = historyDb.getRecentAmbObservations({ lineId: 'e11.1', direction: '0', windowMins: 60 });
  check('window filter excludes old row', narrow.length === 2);

  const other = historyDb.getRecentAmbObservations({ lineId: 'e11.1', direction: '1' });
  check('direction filter', other.length === 1 && other[0].delayMins === 10);

  // Purge: force created_ms far beyond retention (2 × run_duration_secs)
  historyDb._ensureOpen();
  historyDb.db.prepare(`UPDATE amb_bus_observations SET created_ms = ? WHERE trip_id = 'T4'`).run(Date.now() - 6 * 3600000);
  const r2 = historyDb.saveAmbObservations([]);
  check('purge removes expired observation', r2.purged >= 1);
  const afterPurge = historyDb.getRecentAmbObservations({ lineId: 'c10', direction: '1' });
  check('purged row gone', !afterPurge.some(o => o.tripId === 'T4'));

  // Retention clamp: short-run trip survives beyond 2h but dies past... verify floor
  const rShort = historyDb.saveAmbObservations([{ agency: 'x', lineCode: 'L1', lineId: 'l1', direction: '0', tripId: 'TS', stopId: 'A', scheduledMs: now, actualMs: now, delayMins: 0, runDurationSecs: 600 }]);
  historyDb.db.prepare(`UPDATE amb_bus_observations SET created_ms = ?`).run(Date.now() - 2 * 3600000 - 60000);
  const r3 = historyDb.saveAmbObservations([]);
  check('retention floor (2h) purges short-run trips', r3.purged >= 1);

  console.log(failures === 0 ? '\n🎉 ALL AMB OBSERVATION DB TESTS PASSED' : `\n💥 ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('💥 Test crashed:', e); process.exit(1); });
