'use strict';

/**
 * test/service_rows_test.js
 *
 * Every punctuality figure counts the same rows, and service hours come from
 * the timetable, not from a clock.
 *
 *  1. Service hours per line and date (src/core/schedule/serviceHours.js): L1
 *     leaves at 05:25 and runs until 23:05 on weekdays; L4 starts at 07:06;
 *     a public holiday runs the Sunday grid. The old rule called everything
 *     before 06:00 and from 23:00 "Cotxeres / Manteniment nocturn".
 *  2. The summary, line rankings, monthly report and line page leave out the
 *     stretches measured against a trip the bus was not running, as the
 *     incident tables already did (L7 bus 2653, 1 Oct 2026, +29/+30).
 *  3. The worst stop and worst hour are counted in stop visits, not in raw
 *     20-second samples, and say so.
 *  4. No data is not 100 % (or 0 %) on time; rolled-up hours that counted early
 *     buses as on time cannot state an on-time share.
 *  5. Monthly coverage counts the hours with published service, not a fixed
 *     05:00-23:00 window (no line runs on Sunday before 07:55).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-service-rows-'));
process.env.DB_PATH = path.join(scratch, 'history.db');
process.env.REPORTS_DIR = path.join(scratch, 'reports');

const historyDb = require('../src/historyDb');
const serviceHours = require('../src/core/schedule/serviceHours');
const timeEngine = require('../src/core/time/timeEngine');

// A Madrid wall-clock instant (month 1-12).
const madrid = (y, mo, d, h, mi, s = 0) => timeEngine.localTimeToUtcDate(y, mo - 1, d, h, mi, s).getTime();
const ok = msg => console.log(`  ✓ ${msg}`);

(async () => {
  console.log('🧪 Testing service rows...');

  // ── 1. Service hours from the timetable ─────────────────────────────
  // Thursday 1 Oct 2026 (winter weekday grid).
  assert.equal(serviceHours.isOutsideRevenueService('L1', madrid(2026, 10, 1, 5, 30)), false, 'L1 runs at 05:30');
  assert.equal(serviceHours.isOutsideRevenueService('L1', madrid(2026, 10, 1, 5, 5)), true, 'L1 window opens at 05:10');
  assert.equal(serviceHours.isOutsideRevenueService('L1', madrid(2026, 10, 1, 23, 20)), false, 'L1 runs until 23:05 (+20 min)');
  assert.equal(serviceHours.isOutsideRevenueService('L1', madrid(2026, 10, 1, 23, 30)), true);
  assert.equal(serviceHours.isOutsideRevenueService('L4', madrid(2026, 10, 1, 6, 30)), true, 'L4 starts at 07:06');
  assert.equal(serviceHours.isOutsideRevenueService('L12', madrid(2026, 10, 1, 5, 30)), false, 'an unknown line is outside only when every line is');
  // Monday 12 Oct 2026 is a public holiday: Sunday grid, L1 from 08:12.
  assert.equal(serviceHours.isOutsideRevenueService('L1', madrid(2026, 10, 12, 7, 30)), true, 'a holiday runs the Sunday grid');
  assert.equal(serviceHours.isServiceStartup('L1', madrid(2026, 10, 1, 5, 40)), true, 'first half hour of L1');
  assert.equal(serviceHours.isServiceStartup('L1', madrid(2026, 10, 1, 6, 10)), false);
  assert.deepEqual(serviceHours.operatingHours('L1'), { minH: 5, maxH: 23 });
  assert.equal(serviceHours.operatingHours('L3').minH, 5, 'L3 leaves at 05:28');
  const sunday = serviceHours.serviceHoursOnDate(2026, 10, 4);
  assert.ok(!sunday.has(5) && !sunday.has(6) && sunday.has(7) && sunday.has(22) && !sunday.has(23), 'Sunday service runs 07:55 (L2) to 22:38 (L3)');
  const weekday = serviceHours.serviceHoursOnDate(2026, 10, 1);
  assert.ok(weekday.has(5) && weekday.has(23), 'weekday service starts at 05 and reaches 23');
  assert.equal(historyDb.getHourlyTrafficContext(5).isDepot, false, '05:00-05:59 is not depot time');
  ok('L1 05:25-23:05 in service, L4 from 07:06, holiday on the Sunday grid, startup window per line');

  // ── fixture ─────────────────────────────────────────────────────────
  historyDb.init(process.env.DB_PATH);
  const log = (vehicleId, lineCode, direction, stopName, delayMins, ts) => historyDb.recordDelayLog({
    vehicleId, lineId: lineCode.replace(/^L/, ''), lineCode, agency: 'Mataró Bus (Avanza)', direction, stopName, delayMins,
    timestamp: ts, observedAt: ts, isRealTime: true, timesSource: 'derived_timetable'
  });
  const visit = (vehicleId, lineCode, direction, stopName, delayMins, firstTs, lastTs = firstTs, sampleCount = 1) => historyDb.recordStopVisit({
    vehicleId, lineCode, direction, stopName, firstTs, lastTs, delayMins, sampleCount, scheduledTime: '', actualTime: '',
    timesSource: 'derived_timetable', isRealTime: true, measuredDelayMins: null, measuredMethod: '', tripAgrees: null, source: 'live'
  });
  const day = (h, mi, s = 0) => madrid(2026, 10, 1, h, mi, s);

  // L7 bus 2653: on time inbound, then the feed's +29/+30 on a trip it had already run.
  for (const [stop, h, m, s] of [['Jaume Isern', 14, 3, 10], ['Pl.Granollers', 14, 6, 10], ['Salesians', 14, 8, 30], ['Puig i Cadafalch', 14, 10, 20]]) {
    log('2653', 'L7', '0', stop, 0, day(h, m, s));
    visit('2653', 'L7', '0', stop, 0, day(h, m, s));
  }
  log('2653', 'L7', '1', 'Institut Català Salut', 29, day(14, 14, 38));
  log('2653', 'L7', '1', 'Institut Català Salut', 30, day(14, 15, 58));
  visit('2653', 'L7', '1', 'Institut Català Salut', 30, day(14, 14, 38), day(14, 15, 58), 2);
  log('2653', 'L7', '1', 'Miquel Biada', 29, day(14, 16, 38));
  visit('2653', 'L7', '1', 'Miquel Biada', 29, day(14, 16, 38));
  log('2653', 'L7', '1', 'Pl. Tereses', 29, day(14, 18, 38));
  visit('2653', 'L7', '1', 'Pl. Tereses', 29, day(14, 18, 38));

  // L1 05:40, the first trip of the day: service, not "Cotxeres".
  log('2686', 'L1', '1', 'Ronda Barceló', 4, day(5, 40));
  visit('2686', 'L1', '1', 'Ronda Barceló', 4, day(5, 40));

  // Worst stop: Lepant has 3 late visits by 3 buses; Rodalies has one bus
  // waiting there with 12 raw samples (one visit).
  for (const [veh, m] of [['2677', 0], ['2679', 20], ['2681', 40]]) {
    log(veh, 'L2', '0', 'Lepant', 8, day(9, m));
    visit(veh, 'L2', '0', 'Lepant', 8, day(9, m));
  }
  for (let k = 0; k < 12; k++) log('2670', 'L2', '0', 'Rodalies', 9, day(11, 0, 20 * k));
  visit('2670', 'L2', '0', 'Rodalies', 9, day(11, 0), day(11, 3, 40), 12);
  // Volume for the late-share pick: 09:00 has 21 visits (3 late, 14 %), 11:00 has
  // 25 (1 late, 4 %), and 13:00 has a single late bus (100 %, but too few visits).
  for (let k = 0; k < 18; k++) visit(`28${String(k).padStart(2, '0')}`, 'L2', '0', 'Sant Isidor', 0, day(9, 45, k));
  for (let k = 0; k < 24; k++) visit(`29${String(k).padStart(2, '0')}`, 'L5', '0', 'Via Europa', 1, day(11, 5, k));
  log('2687', 'L3', '0', 'Geganta', 6, day(13, 0));
  visit('2687', 'L3', '0', 'Geganta', 6, day(13, 0));

  const realNow = Date.now;
  Date.now = () => day(15, 0);
  let journalism, lineL7, lineEmpty, incidents, monthly;
  try {
    journalism = historyDb.getJournalismReport(24, []);
    lineL7 = historyDb.getLineDelayStats('L7', 24);
    lineEmpty = historyDb.getLineDelayStats('L4', 24);
    incidents = historyDb.getDelayIncidents({ lineCode: 'all', hours: 24, limit: 20, minDelay: 5 });
    monthly = historyDb.getMonthlyReport('2026-10', []);
  } finally {
    Date.now = realNow;
  }

  // ── 2. Phantom stretches out of every figure ────────────────────────
  assert.equal(journalism.summary.networkMaxDelay, 9, 'the summary maximum excludes the phantom +30');
  assert.equal(journalism.summary.totalStopVisits, 52, 'the 3 phantom visits are not counted (55 - 3)');
  const l7Rank = journalism.rankingMostDelayed.find(r => String(r.lineCode).toUpperCase() === 'L7');
  assert.ok(l7Rank && l7Rank.maxDelay === 0, 'L7 ranks on its real visits only');
  assert.equal(lineL7.maxDelayMins, 0, 'the L7 line page excludes the phantom visits');
  assert.equal(lineL7.totalVisits, 4);
  assert.equal(monthly.summary.maxDelayMins, 9, 'the monthly report excludes the phantom +30');
  assert.ok(/salts de retard impossibles/.test(monthly.methodology), 'the methodology says what is left out');
  assert.ok(/retard que el sistema de l'operador/.test(monthly.methodology), 'and that the delay is the operator\'s');
  ok('summary, rankings, line page and monthly report leave out the +29/+30 the incident tables leave out');

  // The 05:40 L1 visit is service.
  const l1Rank = journalism.rankingMostDelayed.find(r => String(r.lineCode).toUpperCase() === 'L1');
  assert.ok(l1Rank && l1Rank.visitCount === 1, 'the 05:40 L1 visit counts');
  ok('the first L1 trip of the day (05:40) counts as service');

  // ── 3. Worst stop / hour in stop visits ─────────────────────────────
  assert.equal(incidents.summary.worstBasis, 'visits');
  assert.equal(incidents.summary.worstStop, 'Lepant', 'three late buses outrank one bus logged twelve times');
  assert.equal(incidents.summary.worstStopCount, 3);
  assert.equal(incidents.summary.worstHour, '09:00');
  assert.equal(incidents.summary.worstHourLatePct, 14, '09:00 has 3 of 21 visits late; 13:00 (1 of 1) has too few visits to rank');
  ok('worst stop Lepant (3 visits), not Rodalies (12 samples of one bus); worst hour by share of late visits');

  // ── 4. No data is not a score ───────────────────────────────────────
  assert.equal(lineEmpty.onTimePct, null);
  assert.equal(lineEmpty.latePct, null);
  assert.equal(lineEmpty.isBaseline, true);
  historyDb.db.exec('DELETE FROM stop_visits; DELETE FROM delay_logs;');
  historyDb.db.prepare(`INSERT INTO hourly_line_stats (line_code, agency, date_hour, sample_count, delay_sum, avg_delay_mins, max_delay_mins, on_time_count, early_count, late_count, timestamp)
    VALUES ('L6', 'Mataró Bus', '2026-10-01 10:00', 10, 5, 0.5, 4, 9, NULL, 1, ?)`).run(day(10, 0));
  historyDb.db.prepare(`INSERT INTO hourly_line_stats (line_code, agency, date_hour, sample_count, delay_sum, avg_delay_mins, max_delay_mins, on_time_count, early_count, late_count, timestamp)
    VALUES ('L6', 'Mataró Bus', '2026-10-01 11:00', 90, 270, 3, 9, 50, 10, 30, ?)`).run(day(11, 0));
  Date.now = () => day(15, 0);
  let rolled;
  try { rolled = historyDb.getLineDelayStats('L6', 24); } finally { Date.now = realNow; }
  assert.equal(rolled.avgDelayMins, 2.8, 'weighted by volume: 275 / 100 (a plain mean of hourly means says 1.8)');
  assert.equal(rolled.onTimePct, null, 'a legacy hour counted early buses as on time');
  assert.equal(rolled.latePct, 31);
  ok('no data reads null, rolled-up averages are weighted, legacy on-time is not stated');

  // ── 5. Monthly coverage over published service hours ───────────────
  Date.now = () => madrid(2026, 10, 5, 0, 0);
  let early;
  try { early = historyDb.getMonthlyReport('2026-10', []); } finally { Date.now = realNow; }
  const expected = [1, 2, 3, 4].reduce((n, d) => n + serviceHours.serviceHoursOnDate(2026, 10, d).size, 0);
  assert.equal(early.dataCoverage.scheduledServiceHours, expected, '1-4 Oct counted from each date\'s timetable');
  assert.ok(expected < 4 * 18, 'fewer hours than a fixed 05:00-23:00 window (the weekend starts later)');
  ok(`coverage over ${expected} published service hours for 1-4 Oct, not ${4 * 18}`);

  console.log('🎉 ALL SERVICE ROWS ASSERTIONS PASSED!');
})().finally(() => {
  historyDb.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}).then(() => process.exit(0)).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
