'use strict';

/**
 * test/delay_jump_test.js
 *
 * An "impossible delay jump" is the operator's AVL putting a bus on a trip
 * scheduled earlier than the one it is on: the reported delay rises by more
 * than the time that passed, which no bus can do (src/core/schedule/delayJump.js).
 *
 * Fixture = L7 bus 2653 on 2026-10-01. L7 runs a single bus at midday on a
 * 28-minute cycle. The +29/+30 records at Institut Català Salut, Miquel Biada
 * and Pl. Tereses (14:14:38-14:18:38, direction 1, scheduled 13:48-13:55) are
 * as the ingestion logged them in a local run against the live feed; the bus
 * stood at Parc Cerdanyola with delay 0 at 14:12-14:13 (GPS snapshots). The
 * inbound records before it (direction 0, the 14:02 Pl. Tereses -> Parc
 * Cerdanyola trip at delay 0) are reconstructed from the timetable, because
 * that local run only started recording at 14:12:19; in production they exist.
 *
 * Controls that must NOT be flagged: a bus standing still with its delay
 * counting up one minute per minute; a real delay building over 9 minutes; a
 * +28 after a 47-minute gap in the feed; a jump from the -15 sentinel or from
 * an early reading at a terminus; a bus that changes line; a late inbound bus
 * that leaves late.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-delay-jump-'));
process.env.DB_PATH = path.join(scratch, 'history.db');
process.env.REPORTS_DIR = path.join(scratch, 'reports');

const historyDb = require('../src/historyDb');
const { findDelayJumps, jumpCovering } = require('../src/core/schedule/delayJump');

// 2026-10-01 is CEST (UTC+2).
const madrid = (h, m, s = 0) => Date.UTC(2026, 9, 1, h - 2, m, s);

const samples = [];
const add = (vehicleId, lineCode, direction, stopName, delayMins, ts) =>
  samples.push({ vehicleId, lineCode, direction, stopName, delayMins, timestamp: ts });

// Bus 2653, inbound 14:02 trip on time (reconstructed from the timetable).
add('2653', 'L7', '0', 'Jaume Isern', 0, madrid(14, 3, 10));
add('2653', 'L7', '0', 'Pl.Granollers', 0, madrid(14, 6, 10));
add('2653', 'L7', '0', 'Salesians', 0, madrid(14, 8, 30));
add('2653', 'L7', '0', 'Puig i Cadafalch', 0, madrid(14, 10, 20));
// As logged on 1 Oct 2026: the AVL puts it on the 13:44 trip it ran one cycle earlier.
add('2653', 'L7', '1', 'Institut Català Salut', 29, madrid(14, 14, 38));
add('2653', 'L7', '1', 'Institut Català Salut', 30, madrid(14, 15, 58));
add('2653', 'L7', '1', 'Miquel Biada', 29, madrid(14, 16, 38));
add('2653', 'L7', '1', 'Miquel Biada', 29, madrid(14, 17, 58));
add('2653', 'L7', '1', 'Pl. Tereses', 29, madrid(14, 18, 38));
// The AVL catches up on the next trip: back to a normal reading.
add('2653', 'L7', '0', 'Jaume Isern', 1, madrid(14, 25, 0));

// Control 1: standing still, delay counting up one minute per minute.
for (let k = 0; k <= 12; k++) add('2675', 'L8', '1', 'Institut Català Salut', k, madrid(10, 30 + k, 8));
// Control 2: a real delay building over 9 minutes (+2 -> +12).
add('2677', 'L8', '1', 'La Coma', 2, madrid(11, 0));
add('2677', 'L8', '1', 'Geganta', 12, madrid(11, 9));
// Control 3: +28 after 47 minutes without data (a trip relink case, not this one).
add('2679', 'L2', '0', 'Lepant', 0, madrid(11, 0));
add('2679', 'L2', '0', 'Pl. Granollers', 28, madrid(11, 47));
// Control 4: from the feed's -15 sentinel, and from an early reading at a terminus.
add('2681', 'L5', '1', 'Rodalies', -15, madrid(12, 0));
add('2681', 'L5', '1', 'Ronda Barceló', 0, madrid(12, 1));
add('2683', 'L1', '0', 'Hospital de Mataró', -8, madrid(12, 30));
add('2683', 'L1', '1', 'Biblioteca Pompeu Fabra', 5, madrid(12, 31));
// Control 5: the bus moves from L1 to L2 (a different timetable).
add('2686', 'L1', '1', 'Rodalies', 0, madrid(13, 0));
add('2686', 'L2', '1', 'Rodalies', 20, madrid(13, 2));
// Control 6: arrives 12 late and leaves 14 late (the delay carried over).
add('2687', 'L3', '0', 'Hospital de Mataró', 12, madrid(13, 30));
add('2687', 'L3', '1', 'Hospital de Mataró', 14, madrid(13, 33));

(async () => {
  console.log('🧪 Testing impossible delay jump detection...');

  // ── Pure detector ──────────────────────────────────────────────────
  const jumps = findDelayJumps(samples);
  assert.equal(jumps.length, 1, `exactly one jump expected (got ${jumps.map(j => j.vehicleId).join(', ')})`);
  const j = jumps[0];
  assert.equal(j.vehicleId, '2653');
  assert.equal(j.lineCode, 'L7');
  assert.equal(j.delayBefore, 0);
  assert.equal(j.beforeStop, 'Puig i Cadafalch');
  assert.equal(j.delayAfter, 29);
  assert.equal(j.jumpStop, 'Institut Català Salut');
  assert.equal(j.elapsedMins, 4);
  assert.equal(j.staleFromTs, madrid(14, 14, 38));
  assert.equal(j.staleToTs, madrid(14, 18, 38), 'the stretch ends when the reading is normal again');
  assert.deepEqual(j.staleStops, ['Institut Català Salut', 'Miquel Biada', 'Pl. Tereses']);
  assert.equal(j.staleSampleCount, 5);
  assert.ok(jumpCovering(jumps, '2653', 'l7', madrid(14, 16, 38)), 'a stale record is covered');
  assert.equal(jumpCovering(jumps, '2653', 'L7', madrid(14, 10, 20)), null, 'the on-time record before the jump is not covered');
  assert.equal(jumpCovering(jumps, '2653', 'L7', madrid(14, 25, 0)), null, 'the normal reading after it is not covered');

  // An AVL that stays a cycle behind stays behind across the terminus.
  const behind = samples.filter(s => s.vehicleId === '2653' && s.timestamp < madrid(14, 25)).concat([
    { vehicleId: '2653', lineCode: 'L7', direction: '0', stopName: 'Jaume Isern', delayMins: 27, timestamp: madrid(14, 25, 0) },
    { vehicleId: '2653', lineCode: 'L7', direction: '0', stopName: 'Salesians', delayMins: 26, timestamp: madrid(14, 29, 0) }
  ]);
  assert.equal(findDelayJumps(behind)[0].staleToTs, madrid(14, 29, 0), 'the stale stretch continues on the next trip while the reading stays a cycle behind');
  console.log('  ✓ Detector: 2653 0 -> +29 in 4 min flagged (5 records, ICS -> Pl. Tereses); 6 controls ignored.');

  // ── Observatori integration ────────────────────────────────────────
  historyDb.init(process.env.DB_PATH);
  for (const s of samples) {
    historyDb.recordDelayLog({
      vehicleId: s.vehicleId, lineId: s.lineCode.replace(/^L/, ''), lineCode: s.lineCode, agency: 'Mataró Bus (Avanza)',
      direction: s.direction, stopName: s.stopName, delayMins: s.delayMins,
      timestamp: s.timestamp, observedAt: s.timestamp, isRealTime: true, timesSource: 'derived_timetable'
    });
  }

  const realDateNow = Date.now;
  Date.now = () => madrid(15, 0);
  let inc;
  let jumpInspect;
  let controlInspect;
  try {
    inc = historyDb.getDelayIncidents({ lineCode: 'all', hours: 24, limit: 30, minDelay: 5 });
    jumpInspect = historyDb.inspectDelayIncident({ lineCode: 'L7', stopName: 'Institut Català Salut', vehicleId: '2653', at: madrid(14, 15, 58), windowMins: 60, minDelay: 5 });
    controlInspect = historyDb.inspectDelayIncident({ lineCode: 'L8', stopName: 'Geganta', vehicleId: '2677', at: madrid(11, 9), windowMins: 60, minDelay: 5 });
  } finally {
    Date.now = realDateNow;
  }

  const inStale = row => row.vehicleId === '2653' && row.timestamp >= madrid(14, 14, 38) && row.timestamp <= madrid(14, 18, 38);
  assert.equal(inc.investigationIncidents.filter(inStale).length, 0, 'the +29/+30 must not be listed as an unusual schedule');
  assert.equal(inc.topIncidents.filter(inStale).length, 0, 'the +29/+30 must not be listed as a service incident');
  assert.ok(inc.topIncidents.some(row => row.vehicleId === '2677'), 'the real delay building over 9 minutes stays a service incident');
  const jumpRows = inc.telemetryAnomalies.filter(row => row.anomalyType === 'delay_jump');
  assert.equal(jumpRows.length, 1, 'the jump is listed once with the SAE anomalies');
  assert.equal(jumpRows[0].vehicleId, '2653');
  assert.equal(jumpRows[0].delayJump.beforeStop, 'Puig i Cadafalch');
  assert.ok(jumpRows[0].diagnosticBadge.includes('impossible'));
  assert.equal(inc.summary.delayJumps, 1);
  assert.equal(inc.summary.maxDelayMins, 28, 'the headline maximum is the +28 after the gap, not the phantom +30');
  console.log(`  ✓ Incidents: the +29/+30 left the rankings for the SAE anomalies; max delay ${inc.summary.maxDelayMins}.`);

  assert.equal(jumpInspect.found, true);
  assert.equal(jumpInspect.episode.verdict, 'delay_jump');
  assert.equal(jumpInspect.episode.delayJump.delayBefore, 0);
  assert.equal(jumpInspect.episode.delayJump.delayAfter, 29);
  assert.equal(jumpInspect.episode.delayJump.beforeTime, '14:10');
  assert.equal(jumpInspect.episode.delayJump.jumpTime, '14:14');
  assert.notEqual(controlInspect.episode.verdict, 'delay_jump');
  console.log(`  ✓ Investigar: verdict "${jumpInspect.episode.verdict}" for 2653, "${controlInspect.episode.verdict}" for 2677.`);

  console.log('🎉 ALL DELAY JUMP ASSERTIONS PASSED!');
})().finally(() => {
  historyDb.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}).then(() => process.exit(0)).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
