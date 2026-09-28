'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-monthly-report-'));
process.env.DB_PATH = path.join(scratch, 'history.db');
process.env.DATA_DIR = scratch;

const historyDb = require('../src/historyDb');
const bridge = require('../src/core/WorkerBridge');
bridge.start = () => {};
const app = require('../server');

let server;

function requestMonthly(query = '') {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}/api/analytics/report/monthly${query}`, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          assert.equal(res.statusCode, 200);
          resolve(JSON.parse(body));
        } catch (error) { reject(error); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  try {
    historyDb.init(process.env.DB_PATH);

    // Seed synthetic stop_visits for 2026-09
    // Mid-September timestamp: 2026-09-15 10:00:00 Europe/Madrid (UTC: 2026-09-15 08:00:00Z)
    const midSeptTs = Date.UTC(2026, 8, 15, 8, 0, 0); // 1757923200000
    // Mid-August timestamp: 2026-08-15
    const midAugTs = Date.UTC(2026, 7, 15, 8, 0, 0);
    // Mid-October timestamp: 2026-10-15
    const midOctTs = Date.UTC(2026, 9, 15, 8, 0, 0);

    const insertVisit = historyDb.db.prepare(`
      INSERT INTO stop_visits (vehicle_id, line_code, direction, stop_name, first_ts, last_ts, delay_mins, sample_count, scheduled_time, actual_time, times_source, is_realtime, measured_delay_mins, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // L1: 10 on-time (0 min), 2 early (-2 min), 2 late (4 min), 2 severe late (7 min) = 16 visits
    for (let i = 0; i < 10; i++) insertVisit.run('veh_1', 'L1', '0', 'Parada L1', midSeptTs, midSeptTs, 0, 1, '10:00', '10:00', 'observed', 1, 0, 'live');
    for (let i = 0; i < 2; i++) insertVisit.run('veh_2', 'L1', '0', 'Parada L1', midSeptTs, midSeptTs, -2, 1, '10:15', '10:13', 'observed', 1, -2, 'live');
    for (let i = 0; i < 2; i++) insertVisit.run('veh_3', 'L1', '0', 'Parada L1', midSeptTs, midSeptTs, 4, 1, '10:30', '10:34', 'observed', 1, 4, 'live');
    for (let i = 0; i < 2; i++) insertVisit.run('veh_4', 'L1', '0', 'Parada L1', midSeptTs, midSeptTs, 7, 1, '10:45', '10:52', 'observed', 1, 7, 'live');

    // L2: Stop "Estació Rodalies" with 55 visits (>= 50 threshold) with delay 5 min
    for (let i = 0; i < 55; i++) {
      insertVisit.run(`veh_l2_${i}`, 'L2', '0', 'Estació Rodalies', midSeptTs, midSeptTs, 5, 1, '11:00', '11:05', 'observed', 1, 5, 'live');
    }

    // L2: Stop "Pl. de les Tereses" with 20 visits (< 50 threshold) with delay 10 min
    for (let i = 0; i < 20; i++) {
      insertVisit.run(`veh_l2_b_${i}`, 'L2', '0', 'Pl. de les Tereses', midSeptTs, midSeptTs, 10, 1, '12:00', '12:10', 'observed', 1, 10, 'live');
    }

    // Out-of-window visits (August and October)
    for (let i = 0; i < 5; i++) insertVisit.run('veh_aug', 'L1', '0', 'Parada August', midAugTs, midAugTs, 0, 1, '10:00', '10:00', 'observed', 1, 0, 'live');
    for (let i = 0; i < 5; i++) insertVisit.run('veh_oct', 'L1', '0', 'Parada October', midOctTs, midOctTs, 0, 1, '10:00', '10:00', 'observed', 1, 0, 'live');

    // Retired line visit (should be excluded by Mataró scope)
    insertVisit.run('veh_c10', 'C-10', '0', 'Parada C10', midSeptTs, midSeptTs, 0, 1, '10:00', '10:00', 'observed', 1, 0, 'live');

    // 1. Direct historyDb.getMonthlyReport verification
    const rep = historyDb.getMonthlyReport('2026-09');

    assert.equal(rep.month, '2026-09', 'Month should be 2026-09');
    assert(Number.isFinite(rep.startTs) && Number.isFinite(rep.endTs) && rep.startTs < rep.endTs, 'Epoch bounds should be valid');
    assert(rep.generationTimestamp, 'generationTimestamp must exist');
    assert(rep.dataVersion, 'dataVersion must exist');
    assert(typeof rep.methodology === 'string' && rep.methodology.length > 50, 'Methodology text must be present');

    // Total visits in September: 16 (L1) + 55 (L2) + 20 (L2) = 91
    assert.equal(rep.summary.totalVisits, 91, `Expected 91 total visits in 2026-09, got ${rep.summary.totalVisits}`);
    assert.equal(rep.summary.monitoredLinesCount, 2, 'Expected 2 monitored lines (L1, L2)');

    // Line L1 punctuality check:
    // 10 on-time (62.5%), 2 early (12.5%), 4 late (25.0%), 2 severe late (12.5%)
    const l1 = rep.linesPunctuality.find(l => l.lineCode === 'L1');
    assert(l1, 'L1 must be present in linesPunctuality');
    assert.equal(l1.visitCount, 16);
    assert.equal(l1.onTimePct, 62.5);
    assert.equal(l1.earlyPct, 12.5);
    assert.equal(l1.latePct, 25.0);
    assert.equal(l1.severeLatePct, 12.5);

    // Worst stops >= 50 visits check:
    // "Estació Rodalies" has 55 visits -> MUST appear
    // "Pl. de les Tereses" has 20 visits -> MUST NOT appear
    assert.equal(rep.worstStops.length, 1, 'Only stops with >= 50 visits should appear in worstStops');
    assert.equal(rep.worstStops[0].stopName, 'Estació Rodalies');
    assert.equal(rep.worstStops[0].visitCount, 55);

    // Hourly punctuality check:
    assert(Array.isArray(rep.hourlyPunctuality) && rep.hourlyPunctuality.length > 0, 'Hourly breakdown must be present');

    // Data coverage check:
    assert(rep.dataCoverage, 'dataCoverage must exist');
    assert(rep.dataCoverage.scheduledServiceHours > 0, 'scheduledServiceHours must be > 0');
    assert(Number.isFinite(rep.dataCoverage.coveragePct), 'coveragePct must be finite number');

    // 2. HTTP Endpoint verification
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));

    // Wire workerBridge mock to return this report
    const origQuery = bridge.historyQuery;
    bridge.historyQuery = async (op, args) => {
      if (op === 'getMonthlyReport') {
        return rep;
      }
      return origQuery ? origQuery.call(bridge, op, args) : null;
    };

    const httpRes = await requestMonthly('?month=2026-09');
    assert.equal(httpRes.success, true);
    assert.equal(httpRes.month, '2026-09');
    assert.equal(httpRes.summary.totalVisits, 91);
    assert.equal(httpRes.worstStops.length, 1);
    assert.equal(httpRes.worstStops[0].stopName, 'Estació Rodalies');
    assert.equal(httpRes.dataVersion, rep.dataVersion);

    bridge.historyQuery = origQuery;
    console.log('RESULT: test/monthly_report_test.js passed (all checks verified).');
  } finally {
    if (server) server.close();
    historyDb.close();
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  }
})();
