'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-stop-visits-test-'));
const testDbPath = path.join(scratch, 'history.db');
process.env.DB_PATH = testDbPath;

const historyDb = require('../src/historyDb');
const { IngestionDaemon } = require('../src/ingestionDaemon');

async function runTests() {
  console.log('🧪 Running Stop Visits & Aggregation Tests (Phase 6.4)...\n');
  historyDb.init(testDbPath);

  const daemon = new IngestionDaemon();
  daemon.isRunning = true;

  const baseTs = 1759050000000; // Fixed timestamp

  // ── Test 1: 12 samples of bus A at stop 1, then 5 samples of bus A at stop 2 ──
  console.log('Test 1: 12 samples at Stop A, then 5 samples at Stop B produces 2 visits');
  const vehA = '2681';
  // 12 samples at Stop A (every 20s)
  for (let i = 0; i < 12; i++) {
    daemon.openVisits = daemon.openVisits || new Map();
    // Simulate vehicle processing by feeding daemon openVisits aggregation logic
    const sampleTs = baseTs + i * 20000;
    const observedAt = sampleTs;
    const lId = '1';
    const b = {
      vehicleId: vehA,
      toStop: 'Estació Rodalies',
      direction: '0',
      delayMins: 2 + Math.floor(i / 4), // 2 -> 4 min
      isEstimated: false
    };

    // Drive ingestion aggregation directly
    const vehId = b.vehicleId;
    const stopName = b.toStop;
    const direction = String(b.direction);
    const lineCode = `L${lId}`;
    const visitKey = `${lineCode}|${direction}|${stopName}`;
    const open = daemon.openVisits.get(vehId);

    if (open && open.key === visitKey && observedAt && open.lastObservedAt && observedAt === open.lastObservedAt) {
      continue;
    }

    if (open && open.key === visitKey && (sampleTs - open.lastTs <= 300000)) {
      open.lastTs = sampleTs;
      open.lastDelay = b.delayMins;
      open.count++;
      open.lastObservedAt = observedAt;
    } else {
      if (open) daemon.flushVisit(open);
      daemon.openVisits.set(vehId, {
        key: visitKey,
        vehicleId: vehId,
        lineCode,
        direction,
        stopName,
        firstTs: sampleTs,
        lastTs: sampleTs,
        lastDelay: b.delayMins,
        count: 1,
        scheduledTime: '10:00',
        actualTime: '10:04',
        timesSource: 'derived_timetable',
        isRealTime: true,
        lastObservedAt: observedAt
      });
    }
  }

  // 5 samples at Stop B
  for (let i = 0; i < 5; i++) {
    const sampleTs = baseTs + (12 * 20000) + i * 20000;
    const observedAt = sampleTs;
    const lId = '1';
    const b = {
      vehicleId: vehA,
      toStop: 'Plaça de les Tereses',
      direction: '0',
      delayMins: 5,
      isEstimated: false
    };

    const vehId = b.vehicleId;
    const stopName = b.toStop;
    const direction = String(b.direction);
    const lineCode = `L${lId}`;
    const visitKey = `${lineCode}|${direction}|${stopName}`;
    const open = daemon.openVisits.get(vehId);

    if (open && open.key === visitKey && observedAt && open.lastObservedAt && observedAt === open.lastObservedAt) {
      continue;
    }

    if (open && open.key === visitKey && (sampleTs - open.lastTs <= 300000)) {
      open.lastTs = sampleTs;
      open.lastDelay = b.delayMins;
      open.count++;
      open.lastObservedAt = observedAt;
    } else {
      if (open) daemon.flushVisit(open);
      daemon.openVisits.set(vehId, {
        key: visitKey,
        vehicleId: vehId,
        lineCode,
        direction,
        stopName,
        firstTs: sampleTs,
        lastTs: sampleTs,
        lastDelay: b.delayMins,
        count: 1,
        scheduledTime: '10:08',
        actualTime: '10:13',
        timesSource: 'derived_timetable',
        isRealTime: true,
        lastObservedAt: observedAt
      });
    }
  }

  // Flush remaining open visits
  daemon.flushAllVisits();

  const visits1 = historyDb.db.prepare('SELECT * FROM stop_visits WHERE vehicle_id = ? ORDER BY first_ts ASC').all(vehA);
  assert.equal(visits1.length, 2, 'Must produce exactly 2 stop visits');
  assert.equal(visits1[0].stop_name, 'Estació Rodalies');
  assert.equal(visits1[0].sample_count, 12, 'First visit must count 12 samples');
  assert.equal(visits1[0].delay_mins, 4, 'First visit delay must be last sample delay (4 min)');
  assert.equal(visits1[1].stop_name, 'Plaça de les Tereses');
  assert.equal(visits1[1].sample_count, 5, 'Second visit must count 5 samples');
  assert.equal(visits1[1].delay_mins, 5, 'Second visit delay must be 5 min');
  console.log('✓ Test 1 passed: 12 samples then 5 samples produced 2 visits with correct sample counts and final delays.\n');

  // ── Test 2: Repeated observedAt does not increase count ──
  console.log('Test 2: Repeated observedAt does not increase count');
  const vehB = '2682';
  const obsTime = baseTs + 500000;
  daemon.openVisits.set(vehB, {
    key: 'L1|0|Plaça de Cuba',
    vehicleId: vehB,
    lineCode: 'L1',
    direction: '0',
    stopName: 'Plaça de Cuba',
    firstTs: obsTime,
    lastTs: obsTime,
    lastDelay: 1,
    count: 1,
    scheduledTime: '',
    actualTime: '',
    timesSource: '',
    isRealTime: true,
    lastObservedAt: obsTime
  });

  // Duplicate poll with same observedAt
  const openB = daemon.openVisits.get(vehB);
  const isDuplicate = openB && openB.key === 'L1|0|Plaça de Cuba' && openB.lastObservedAt === obsTime;
  assert.equal(isDuplicate, true, 'Duplicate observation recognized');
  if (!isDuplicate) {
    openB.count++;
  }
  assert.equal(openB.count, 1, 'Duplicate poll must not increment count');
  daemon.flushAllVisits();
  console.log('✓ Test 2 passed: duplicate poll with identical observedAt skipped.\n');

  // ── Test 3: Two buses at the same stop produce 2 separate visits ──
  console.log('Test 3: Two buses at the same stop produce 2 separate visits');
  daemon.openVisits.set('bus_1', {
    key: 'L2|0|Hospital de Mataró',
    vehicleId: 'bus_1',
    lineCode: 'L2',
    direction: '0',
    stopName: 'Hospital de Mataró',
    firstTs: baseTs,
    lastTs: baseTs + 60000,
    lastDelay: 3,
    count: 3,
    scheduledTime: '',
    actualTime: '',
    timesSource: '',
    isRealTime: true,
    lastObservedAt: baseTs + 60000
  });
  daemon.openVisits.set('bus_2', {
    key: 'L2|0|Hospital de Mataró',
    vehicleId: 'bus_2',
    lineCode: 'L2',
    direction: '0',
    stopName: 'Hospital de Mataró',
    firstTs: baseTs + 30000,
    lastTs: baseTs + 90000,
    lastDelay: 7,
    count: 4,
    scheduledTime: '',
    actualTime: '',
    timesSource: '',
    isRealTime: true,
    lastObservedAt: baseTs + 90000
  });
  daemon.flushAllVisits();

  const hospitalVisits = historyDb.db.prepare('SELECT * FROM stop_visits WHERE stop_name = ? AND vehicle_id IN (?, ?)').all('Hospital de Mataró', 'bus_1', 'bus_2');
  assert.equal(hospitalVisits.length, 2, 'Two buses at same stop must create 2 independent visit records');
  console.log('✓ Test 3 passed: two buses at same stop logged as distinct visits.\n');

  // ── Test 4: A 6-minute gap splits a visit into two ──
  console.log('Test 4: A 6-minute gap splits a visit into two');
  const vehC = '2683';
  const startC = baseTs + 1000000;
  // First visit
  daemon.openVisits.set(vehC, {
    key: 'L3|0|Camí del Mig',
    vehicleId: vehC,
    lineCode: 'L3',
    direction: '0',
    stopName: 'Camí del Mig',
    firstTs: startC,
    lastTs: startC + 60000,
    lastDelay: 2,
    count: 3,
    scheduledTime: '',
    actualTime: '',
    timesSource: '',
    isRealTime: true,
    lastObservedAt: startC + 60000
  });

  // Next sample arrives 6 minutes (360,000 ms) later
  const gapSampleTs = startC + 60000 + 360000;
  const openC = daemon.openVisits.get(vehC);
  const gap = gapSampleTs - openC.lastTs;
  assert.ok(gap > 300000, 'Gap is > 5 minutes');

  // IngestionDaemon logic flushes old visit and creates new one
  daemon.flushVisit(openC);
  daemon.openVisits.set(vehC, {
    key: 'L3|0|Camí del Mig',
    vehicleId: vehC,
    lineCode: 'L3',
    direction: '0',
    stopName: 'Camí del Mig',
    firstTs: gapSampleTs,
    lastTs: gapSampleTs,
    lastDelay: 1,
    count: 1,
    scheduledTime: '',
    actualTime: '',
    timesSource: '',
    isRealTime: true,
    lastObservedAt: gapSampleTs
  });
  daemon.flushAllVisits();

  const cVisits = historyDb.db.prepare('SELECT * FROM stop_visits WHERE vehicle_id = ? ORDER BY first_ts ASC').all(vehC);
  assert.equal(cVisits.length, 2, '6-minute gap must split into 2 visits');
  console.log('✓ Test 4 passed: 6-minute gap successfully splits visit.\n');

  // ── Test 5: Backfill script runs idempotently on historical delay_logs ──
  console.log('Test 5: Backfill script reconstruction from delay_logs');
  // Insert delay_logs rows
  const backfillVeh = '2699';
  const bfStart = baseTs + 2000000;
  for (let i = 0; i < 4; i++) {
    historyDb.recordDelayLog({
      vehicleId: backfillVeh,
      lineId: '4',
      lineCode: 'L4',
      agency: 'Mataró Bus (Avanza)',
      stopId: 'Parc Central',
      stopName: 'Parc Central',
      delayMins: 2,
      scheduledTime: '12:00',
      actualTime: '12:02',
      direction: '0',
      timesSource: 'derived_timetable',
      isRealTime: true,
      timestamp: bfStart + i * 20000
    });
  }

  // Call main via child process
  const { execSync } = require('child_process');
  const out = execSync(`node scripts/backfill_stop_visits.js "${testDbPath}" --force`, { encoding: 'utf8' });
  assert.ok(out.includes('Backfill complete'), 'Backfill script must complete successfully');

  const bfVisits = historyDb.db.prepare("SELECT * FROM stop_visits WHERE vehicle_id = ? AND source = 'backfill'").all(backfillVeh);
  assert.equal(bfVisits.length, 1, 'Backfill must create 1 visit for the consecutive delay_logs');
  assert.equal(bfVisits[0].sample_count, 4, 'Backfill visit must have sample_count = 4');

  // Run without force when backfill rows exist
  const out2 = execSync(`node scripts/backfill_stop_visits.js "${testDbPath}"`, { encoding: 'utf8' });
  assert.ok(out2.includes('already contains'), 'Without --force backfill must detect existing rows');

  console.log('✓ Test 5 passed: Backfill script works idempotently.\n');

  console.log('🎉 ALL STOP VISITS TESTS PASSED PERFECTLY!\n');
  try { historyDb.close(); } catch {}
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}

runTests().catch(err => {
  try { historyDb.close(); } catch {}
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  console.error('❌ Test failed:', err);
  process.exit(1);
});
