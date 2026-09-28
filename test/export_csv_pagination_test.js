'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const express = require('express');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-export-csv-test-'));
const testDbPath = path.join(scratch, 'history.db');
process.env.DB_PATH = testDbPath;

const historyDb = require('../src/historyDb');
const flightRecorder = require('../src/flightRecorder');

async function runTests() {
  console.log('🧪 Running CSV Export Pagination & Headers Tests (Phase 6.6)...\n');
  historyDb.init(testDbPath);

  const now = Date.now();
  const db = historyDb.db;

  // ── 1. Seed 60,000 rows into delay_logs ──
  console.log('1. Seeding 60,000 delay_logs...');
  db.exec('BEGIN TRANSACTION;');
  const insertLogStmt = db.prepare(`
    INSERT INTO delay_logs (
      line_id, stop_id, delay_mins, agency, timestamp, observed_at,
      vehicle_id, line_code, direction, stop_name, scheduled_time, actual_time, times_source, is_realtime
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  for (let i = 0; i < 60000; i++) {
    const ts = now - (i * 1000); // within last 16 hours
    insertLogStmt.run(
      '1', '1001', (i % 10) - 2, 'Mataró Bus (Avanza)', ts, ts,
      `V-${2600 + (i % 20)}`, 'L1', String(i % 2), `Parada ${i % 50}`,
      '12:00:00', '12:02:00', 'maresme_scrape', 1
    );
  }
  db.exec('COMMIT;');
  console.log('  ✓ 60,000 delay_logs inserted.');

  // ── 2. Test historyDb.exportDelayLogsCsv pagination ──
  console.log('2. Testing delay_logs CSV export pagination (Page 1 & 2)...');
  const p1 = historyDb.exportDelayLogsCsv(48, 1, 50000);
  assert.equal(p1.total, 60000, 'Total rows must be 60,000');
  assert.equal(p1.page, 1, 'Current page must be 1');
  assert.equal(p1.totalPages, 2, 'Total pages must be 2');

  const p1Lines = p1.csv.trim().split('\n');
  assert.equal(p1Lines.length, 50001, 'Page 1 must contain header + 50,000 rows');
  assert.ok(p1Lines[0].includes('Vehicle'), 'Header must contain Vehicle');
  assert.ok(p1Lines[0].includes('Direcció'), 'Header must contain Direcció');
  assert.ok(p1Lines[0].includes('Origen horari'), 'Header must contain Origen horari');

  const p2 = historyDb.exportDelayLogsCsv(48, 2, 50000);
  assert.equal(p2.total, 60000, 'Total rows must be 60,000');
  assert.equal(p2.page, 2, 'Current page must be 2');
  assert.equal(p2.totalPages, 2, 'Total pages must be 2');

  const p2Lines = p2.csv.trim().split('\n');
  assert.equal(p2Lines.length, 10001, 'Page 2 must contain header + 10,000 rows');
  console.log('  ✓ delay_logs export: Page 1 = 50,000 rows, Page 2 = 10,000 rows.');

  // ── 3. Seed 60,000 rows into stop_visits ──
  console.log('3. Seeding 60,000 stop_visits...');
  db.exec('BEGIN TRANSACTION;');
  const insertVisitStmt = db.prepare(`
    INSERT INTO stop_visits (
      vehicle_id, line_code, direction, stop_name, first_ts, last_ts,
      delay_mins, sample_count, scheduled_time, actual_time, times_source, is_realtime, source
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?
    )
  `);

  for (let i = 0; i < 60000; i++) {
    const ts = now - (i * 1000);
    insertVisitStmt.run(
      `V-${2600 + (i % 20)}`, 'L1', String(i % 2), `Parada ${i % 50}`, ts - 20000, ts,
      (i % 10) - 2, 4, '12:00:00', '12:02:00', 'maresme_scrape', 1, 'live'
    );
  }
  db.exec('COMMIT;');
  console.log('  ✓ 60,000 stop_visits inserted.');

  // ── 4. Test historyDb.exportStopVisitsCsv pagination ──
  console.log('4. Testing stop_visits CSV export pagination (Page 1 & 2)...');
  const vp1 = historyDb.exportStopVisitsCsv(48, 1, 50000);
  assert.equal(vp1.total, 60000, 'Total visits must be 60,000');
  assert.equal(vp1.page, 1, 'Current page must be 1');
  assert.equal(vp1.totalPages, 2, 'Total pages must be 2');

  const vp1Lines = vp1.csv.trim().split('\n');
  assert.equal(vp1Lines.length, 50001, 'Page 1 visits must contain header + 50,000 rows');
  assert.ok(vp1Lines[0].includes('Retard informat (min)'), 'Header must contain Retard informat (min)');
  assert.ok(vp1Lines[0].includes('Retard mesurat (min)'), 'Header must contain Retard mesurat (min)');

  const vp2 = historyDb.exportStopVisitsCsv(48, 2, 50000);
  assert.equal(vp2.total, 60000, 'Total visits must be 60,000');
  assert.equal(vp2.page, 2, 'Current page must be 2');
  assert.equal(vp2.totalPages, 2, 'Total pages must be 2');

  const vp2Lines = vp2.csv.trim().split('\n');
  assert.equal(vp2Lines.length, 10001, 'Page 2 visits must contain header + 10,000 rows');
  console.log('  ✓ stop_visits export: Page 1 = 50,000 rows, Page 2 = 10,000 rows.');

  // ── 5. Test HTTP routes with X-Total-Rows, X-Page, X-Pages headers ──
  console.log('5. Testing HTTP endpoints & pagination response headers...');
  flightRecorder.setHistoryGateway(async (op, args) => {
    if (op === 'exportDelayLogsCsv') {
      return historyDb.exportDelayLogsCsv(args.hours, args.page, args.pageSize);
    }
    if (op === 'exportStopVisitsCsv') {
      return historyDb.exportStopVisitsCsv(args.hours, args.page, args.pageSize);
    }
    throw new Error(`Unhandled op ${op}`);
  });

  const app = express();
  app.get(['/api/analytics/export/csv', '/api/retards/export/csv'], async (req, res) => {
    const hours = Math.max(1, Math.min(720, parseInt(req.query.hours, 10) || 48));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const result = await flightRecorder.exportCsv(hours, page);
    const csv = typeof result === 'string' ? result : (result?.csv || '');
    const total = result?.total ?? 0;
    const totalPages = result?.totalPages ?? 1;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transit_delays_${hours}h_p${page}.csv"`);
    res.setHeader('X-Total-Rows', String(total));
    res.setHeader('X-Page', String(page));
    res.setHeader('X-Pages', String(totalPages));
    res.send(csv);
  });

  app.get(['/api/analytics/export/visits.csv', '/api/retards/export/visits.csv'], async (req, res) => {
    const hours = Math.max(1, Math.min(720, parseInt(req.query.hours, 10) || 48));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const result = await flightRecorder.exportVisitsCsv(hours, page);
    const csv = typeof result === 'string' ? result : (result?.csv || '');
    const total = result?.total ?? 0;
    const totalPages = result?.totalPages ?? 1;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transit_stop_visits_${hours}h_p${page}.csv"`);
    res.setHeader('X-Total-Rows', String(total));
    res.setHeader('X-Page', String(page));
    res.setHeader('X-Pages', String(totalPages));
    res.send(csv);
  });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = server.address().port;

  try {
    // Check GET /api/analytics/export/csv?page=1
    const res1 = await fetch(`http://127.0.0.1:${port}/api/analytics/export/csv?page=1`);
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get('X-Total-Rows'), '60000');
    assert.equal(res1.headers.get('X-Page'), '1');
    assert.equal(res1.headers.get('X-Pages'), '2');
    const text1 = await res1.text();
    assert.equal(text1.trim().split('\n').length, 50001);

    // Check GET /api/analytics/export/csv?page=2
    const res2 = await fetch(`http://127.0.0.1:${port}/api/analytics/export/csv?page=2`);
    assert.equal(res2.status, 200);
    assert.equal(res2.headers.get('X-Total-Rows'), '60000');
    assert.equal(res2.headers.get('X-Page'), '2');
    assert.equal(res2.headers.get('X-Pages'), '2');
    const text2 = await res2.text();
    assert.equal(text2.trim().split('\n').length, 10001);

    // Check GET /api/analytics/export/visits.csv?page=1
    const vRes1 = await fetch(`http://127.0.0.1:${port}/api/analytics/export/visits.csv?page=1`);
    assert.equal(vRes1.status, 200);
    assert.equal(vRes1.headers.get('X-Total-Rows'), '60000');
    assert.equal(vRes1.headers.get('X-Page'), '1');
    assert.equal(vRes1.headers.get('X-Pages'), '2');
    const vText1 = await vRes1.text();
    assert.equal(vText1.trim().split('\n').length, 50001);

    // Check GET /api/analytics/export/visits.csv?page=2
    const vRes2 = await fetch(`http://127.0.0.1:${port}/api/analytics/export/visits.csv?page=2`);
    assert.equal(vRes2.status, 200);
    assert.equal(vRes2.headers.get('X-Total-Rows'), '60000');
    assert.equal(vRes2.headers.get('X-Page'), '2');
    assert.equal(vRes2.headers.get('X-Pages'), '2');
    const vText2 = await vRes2.text();
    assert.equal(vText2.trim().split('\n').length, 10001);

    console.log('  ✓ HTTP export headers X-Total-Rows, X-Page, X-Pages verified for both samples and visits.');
  } finally {
    server.close();
    historyDb.close();
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {}
  }

  console.log('\n🎉 ALL CSV EXPORT PAGINATION TESTS PASSED PERFECTLY!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
