/**
 * test/incident_drilldown_single_bus_test.js
 *
 * THE REGRESSION TEST FOR "INVESTIGAR SHOWS TWO BUSES FOR ONE DELAY".
 *
 * An operator clicked "Investigar" on the L3 delay attributed to bus 2672 at
 * 2026-09-24 12:07:44 and was handed a table containing a second bus. The
 * drill-down had grouped raw delay_logs samples into episodes using the 5-minute
 * time gap ALONE, with no notion of which bus produced a row. Any two buses
 * logging at the same stop within five minutes of each other were therefore
 * merged into one "episode", and the panel reported both under "Vehicles".
 *
 * This is not hypothetical. Measured on the real delay_logs table, the naive
 * grouping produced exactly 2 episodes for 744 rows spanning one hour, and BOTH
 * contained multiple distinct vehicles -- one merged 5 buses across 3 lines in
 * 2 minutes, the other merged 9 buses across 6 lines. Within a single
 * line+stop, L3/Rafael Estrany had bus 2662 at 10:19:11 and bus 2676 at
 * 10:23:09 -- 3 min 58 s apart, comfortably inside the 5-minute boundary.
 *
 * A second, independent defect rode along: even with per-vehicle grouping, the
 * episode PICKER chose the first episode whose window contained the clicked
 * instant, which can belong to the neighbouring bus. So the vehicle id has to
 * travel from the button through the fetch, or the panel still lands on the
 * wrong bus.
 *
 * Both are covered here, plus the fallback that keeps id-less historical rows
 * (pre-2026-09-19, before the vehicle_id column existed) working.
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

const testDir = path.join(__dirname, '..', 'tmp', 'test_drilldown_single_bus');
if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
const testDbPath = path.join(testDir, 'drilldown.db');
for (const suffix of ['', '-wal', '-shm']) {
  const p = testDbPath + suffix;
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

const historyDb = require('../src/historyDb');
historyDb.init(testDbPath);

let passed = 0;
const failed = [];
const check = (cond, msg) => {
  if (cond) { passed++; return; }
  failed.push(msg);
};

const twentySec = 20 * 1000;
const oneHour = 3600 * 1000;

// Anchor to a Madrid daytime hour. is_telemetry_anomaly() marks everything
// before 06:00 as depot/night maintenance, which short-circuits the verdict
// and made this suite clock-dependent when it was first written.
const madridHourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: 'numeric', hourCycle: 'h23' });
const currentMadridHour = parseInt(madridHourFmt.format(new Date()), 10);
const hoursBackTo16 = (currentMadridHour >= 16) ? (currentMadridHour - 16) : (currentMadridHour + 24 - 16);
const baseTs = Date.now() - hoursBackTo16 * oneHour;

const log = (o) => historyDb.recordDelayLog({
  agency: 'Mataró', scheduledTime: '', actualTime: '', isRealTime: true, ...o
});

// ── The rider's case, in miniature ──────────────────────────────────────
// Bus 2672 and bus 2688 both serve L3 and both pass Rafael Estrany. Their
// samples interleave and sit 2 minutes apart, so the old time-only grouping
// fused them into a single episode containing both.
const STOP = 'Rafael Estrany';
const busA = '2672';
const busB = '2688';
const overlapStart = baseTs;

// Bus A: the clicked trip, 6 samples every 20 s.
for (let i = 0; i < 6; i++) {
  log({
    vehicleId: busA, lineId: '3', lineCode: 'L3', stopId: 'rafael-estrany',
    stopName: STOP, delayMins: 16 + i, timestamp: overlapStart + i * twentySec
  });
}
// Bus B: a different bus at the SAME stop, starting 2 min later, overlapping
// bus A's tail. Under the old grouping these 5 rows joined bus A's episode.
for (let i = 0; i < 5; i++) {
  log({
    vehicleId: busB, lineId: '3', lineCode: 'L3', stopId: 'rafael-estrany',
    stopName: STOP, delayMins: 9 + i, timestamp: overlapStart + 120000 + i * twentySec
  });
}

// ── Historical rows with no vehicle_id (pre-column history) ─────────────
const noIdStop = 'Mercat Municipal';
for (let i = 0; i < 4; i++) {
  log({
    vehicleId: '', lineId: '3', lineCode: 'L3', stopId: 'mercat',
    stopName: noIdStop, delayMins: 13 + i, isRealTime: false,
    timestamp: overlapStart + 180000 + i * twentySec
  });
}

(async function run() {
  // ── 1. The defect: one episode must not contain two buses ────────────
  // The operator clicked bus A, so the drill-down must be bus A alone.
  const clicked = await historyDb.inspectDelayIncident({
    lineCode: 'L3', stopName: STOP, vehicleId: busA,
    at: overlapStart + 2 * twentySec, windowMins: 30, minDelay: 5
  });

  check(clicked.found === true, 'drill-down for the clicked bus returns data');
  check(clicked.episode?.distinctVehicles?.length === 1,
    `episode must name exactly ONE vehicle, got ${JSON.stringify(clicked.episode?.distinctVehicles)}`);
  check(clicked.episode?.distinctVehicles?.[0] === busA,
    `the surviving vehicle must be the clicked one (${busA}), got ${JSON.stringify(clicked.episode?.distinctVehicles?.[0])}`);
  check(clicked.episode?.rowCount === 6,
    `episode must hold only bus ${busA}'s 6 samples, got ${clicked.episode?.rowCount}`);
  check(clicked.episode?.rawRows?.every(r => r.vehicleId === busA),
    'every raw row shown belongs to the clicked bus');
  check(clicked.episode?.vehicleAmbiguous !== true,
    'a stored vehicle id means the episode is NOT ambiguous');

  // ── 2. Control: the fixture really does contain both buses ───────────
  // Without this, a fixture that failed to insert bus B would make every
  // assertion above pass vacuously -- the exact failure mode this suite
  // exists to prevent. The check is made against the RAW TABLE, not against a
  // second inspectDelayIncident() call: now that grouping is per-vehicle, the
  // unfiltered endpoint correctly returns ONE bus, so asking it whether two
  // buses are present would test the fix rather than the fixture.
  const rawInWindow = historyDb.db.prepare(
    `SELECT DISTINCT vehicle_id FROM delay_logs
      WHERE line_code = 'L3' AND stop_name LIKE ? AND delay_mins >= 5
        AND timestamp >= ? AND timestamp <= ? AND vehicle_id != ''`
  ).all(`%${STOP}%`, overlapStart - 900000, overlapStart + 900000).map(r => r.vehicle_id);
  check(rawInWindow.includes(busA) && rawInWindow.includes(busB),
    `CONTROL: the stored window really does contain both ${busA} and ${busB}, got ${JSON.stringify(rawInWindow)}`);

  // The two must also be close enough in time to have been merged by the old
  // rule, or the control proves nothing about the defect being fixed.
  const gapStmt = historyDb.db.prepare(
    `SELECT MIN(ABS(a.timestamp - b.timestamp)) AS gapMs
       FROM delay_logs a, delay_logs b
      WHERE a.vehicle_id = ? AND b.vehicle_id = ?
        AND a.stop_name = ? AND b.stop_name = ?`
  ).get(busA, busB, STOP, STOP);
  check(typeof gapStmt.gapMs === 'number' && gapStmt.gapMs <= 5 * 60 * 1000,
    `CONTROL: the two buses are within the 5-min episode boundary (${gapStmt.gapMs}ms), so the old rule would have merged them`);

  // ── 3. The neighbour is reachable on its own, with its own delay ─────
  const neighbour = await historyDb.inspectDelayIncident({
    lineCode: 'L3', stopName: STOP, vehicleId: busB,
    at: overlapStart + 120000, windowMins: 30, minDelay: 5
  });
  check(neighbour.episode?.distinctVehicles?.length === 1 &&
        neighbour.episode?.distinctVehicles?.[0] === busB,
    `drill-down for ${busB} returns ${busB} alone`);
  check(neighbour.episode?.rowCount === 5,
    `episode for ${busB} holds its own 5 samples, got ${neighbour.episode?.rowCount}`);
  check(neighbour.episode?.peakDelayMins === 13,
    `peak delay must be ${busB}'s own 13 min, not ${busA}'s 21, got ${neighbour.episode?.peakDelayMins}`);

  // ── 4. Trip key for the Expedicions & Trajectòries cross-link ─────────
  check(clicked.episode?.tripKey?.vehicleId === busA,
    'tripKey carries the clicked vehicle so the UI can match a trajectory card');
  check(clicked.episode?.tripKey?.lineCode === 'L3', 'tripKey carries the line code');
  check(typeof clicked.episode?.tripKey?.startTs === 'number' &&
        typeof clicked.episode?.tripKey?.endTs === 'number',
    'tripKey exposes numeric start/end so the UI compares instants, not localized strings');

  // ── 5. Id-less historical rows must still work ───────────────────────
  const legacy = await historyDb.inspectDelayIncident({
    lineCode: 'L3', stopName: noIdStop, at: overlapStart + 180000, windowMins: 30, minDelay: 5
  });
  check(legacy.found === true, 'id-less historical rows are still inspectable');
  check(legacy.episode?.rowCount === 4, 'the 4 id-less rows form their own episode');
  check(legacy.episode?.hasOwnProperty('tripKey'), 'an id-less episode still returns a tripKey shape');

  // ── 6. An unknown vehicle must not silently return a neighbour's data ──
  const unknown = await historyDb.inspectDelayIncident({
    lineCode: 'L3', stopName: STOP, vehicleId: '9999',
    at: overlapStart + 2 * twentySec, windowMins: 30, minDelay: 5
  });
  check(unknown.found === false,
    'a vehicle with no rows must report found:false rather than falling back to a neighbour');

  // ── 7. The KPI and the drill-down must count episodes the same way ────
  // _delayDataQuality reported distinctEpisodes right next to the drill-down
  // table, but partitioned by (line, stop). That is wrong in the opposite
  // direction from the drill-down's bug: splitting by stop gives every stop
  // its own episode-start, so one bus passing four stops counted as four.
  // They now share the key, so the two figures agree.
  const GAP = 5 * 60 * 1000;
  const countEpisodes = (sql, params = []) => {
    const rows = historyDb.db.prepare(sql).all(...params);
    const buckets = new Map();
    for (const r of rows) {
      const k = r.vehicle_id ? `${r.line_code}|${r.vehicle_id}` : `${r.line_code}|${r.stop_name || ''}`;
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    }
    let n = 0;
    for (const b of buckets.values()) {
      let cur = [];
      for (const r of b) {
        if (cur.length && r.timestamp - cur[cur.length - 1].timestamp > GAP) { n++; cur = []; }
        cur.push(r);
      }
      if (cur.length) n++;
    }
    return n;
  };

  const SCOPE = `SELECT line_code, stop_name, vehicle_id, timestamp FROM delay_logs
                 WHERE UPPER(line_code) = 'L3' ORDER BY timestamp ASC`;
  const quality = historyDb._delayDataQuality({ hours: 24, lineCode: 'L3' });
  const expected = countEpisodes(SCOPE);
  check(quality.distinctEpisodes === expected,
    `KPI episode count must equal the drill-down grouping (KPI ${quality.distinctEpisodes} vs drill-down ${expected})`);
  check(expected > 0, 'the L3 scope really has episodes, so the parity check is not vacuous');
  check(/line\+vehicle/.test(quality.episodesNote),
    'the KPI note documents the line+vehicle key it now uses');

  // The inflated-count regression: one bus visiting four stops is ONE episode.
  // Under the old (line, stop) partition the same trip added four.
  for (let i = 0; i < 4; i++) {
    log({
      vehicleId: '2700', lineId: '3', lineCode: 'L3', stopId: 'atur' + i,
      stopName: `Atur ${i}`, delayMins: 14, timestamp: baseTs + 240000 + i * twentySec
    });
  }
  const after = historyDb._delayDataQuality({ hours: 24, lineCode: 'L3' }).distinctEpisodes;
  check(after === expected + 1,
    `one new single-bus trip across 4 stops must add exactly ONE episode (got +${after - expected}, expected +1; the old (line,stop) partition would have added 4)`);

  const oneTrip = await historyDb.inspectDelayIncident({
    lineCode: 'L3', vehicleId: '2700', at: baseTs + 240000, windowMins: 30, minDelay: 5
  });
  check(oneTrip.episode?.distinctVehicles?.length === 1,
    'one bus across 4 stops is a single-vehicle episode in the drill-down');
  check(oneTrip.episode?.rowCount === 4,
    `that episode holds all 4 of its samples, got ${oneTrip.episode?.rowCount}`);

  console.log('=======================================================');
  console.log('Total Passed Assertions:', passed);
  console.log('Total Failures Detected:', failed.length);
  console.log('=======================================================');
  for (const f of failed) console.log('  ✗ ' + f);
  if (failed.length) {
    console.log('\n❌ INCIDENT DRILLDOWN SINGLE-BUS TESTS FAILED\n');
    process.exit(1);
  }
  console.log('\n🎉 ALL INCIDENT DRILLDOWN SINGLE-BUS TESTS PASSED\n');
  process.exit(0);
})().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
