#!/usr/bin/env node
/**
 * scripts/backfill_delay_times.js
 *
 * Fills in scheduled_time / actual_time for historical delay_logs rows that
 * were written before ingestion derived them from the timetable.
 *
 * These are APPROXIMATIONS, not observations. Old rows have no direction and
 * no stop sequence number, so the match is made on line + stop name + time +
 * delay, trying both directions and keeping whichever fits best. Every row it
 * touches is stamped times_source='derived_timetable_backfill' so the
 * Observatori drilldown can tell a backfilled guess from a live derivation
 * and from a real upstream observation.
 *
 * This is a deliberate local CLI, never an HTTP endpoint, and it is a dry run
 * unless --apply is passed. Take a backup first:
 *
 *   node scripts/history_backup.js backup data/transit_history.db backup.db
 *   node scripts/backfill_delay_times.js                  # report only
 *   node scripts/backfill_delay_times.js --apply          # write
 *   node scripts/backfill_delay_times.js --apply --limit 5000
 */

const historyDb = require('../src/historyDb');
const tripMatcher = require('../src/core/schedule/tripMatcher');
const mataroSchedules = require('../src/data/mataroSchedules');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const limitArg = argv.indexOf('--limit');
const LIMIT = limitArg !== -1 ? Math.max(1, parseInt(argv[limitArg + 1], 10) || 1000) : Infinity;
const BATCH = 500;

/**
 * Old rows carry no direction, so try every direction the line runs and keep
 * the one whose nearest departure fits the observed delay best.
 */
function bestMatchAnyDirection(lineId, stopName, delayMins, at) {
  const dirSched = mataroSchedules.getLineSchedule(lineId);
  if (!dirSched) return null;
  const dirIds = Object.keys(dirSched.directionIndices || {});
  if (!dirIds.length) return null;
  let best = null;
  for (const dirId of dirIds) {
    const r = tripMatcher.matchTrip({ lineId, direction: dirId, stopName, delayMins, at });
    if (!r.matched) continue;
    if (!best || Math.abs(r.residualMinutes) < Math.abs(best.residualMinutes)) best = { ...r, direction: dirId };
  }
  return best;
}

function run() {
  const total = historyDb.db.prepare('SELECT COUNT(*) AS n FROM delay_logs').get().n;
  const pending = historyDb.db.prepare(
    "SELECT COUNT(*) AS n FROM delay_logs WHERE (scheduled_time IS NULL OR scheduled_time = '') AND (actual_time IS NULL OR actual_time = '')"
  ).get().n;

  // Most of the pending backlog is retired-provider data (Catalonia-wide
  // agencies whose trackers were deleted). Those lines have no timetable in
  // this repo at all, so there is nothing to match them against. Count them so
  // the report never implies they were attempted.
  const backfillable = historyDb.db.prepare(
    "SELECT COUNT(*) AS n FROM delay_logs WHERE (scheduled_time IS NULL OR scheduled_time = '') AND (actual_time IS NULL OR actual_time = '') AND line_id IN ('1','2','3','4','5','6','7','8')"
  ).get().n;
  const legacyNoSchedule = pending - backfillable;

  const rows = historyDb.db.prepare(`
    SELECT id, line_id, line_code, stop_name, delay_mins, timestamp
    FROM delay_logs
    WHERE (scheduled_time IS NULL OR scheduled_time = '')
      AND (actual_time IS NULL OR actual_time = '')
      AND line_id IN ('1','2','3','4','5','6','7','8')
    ORDER BY id
    LIMIT ?
  `).all(LIMIT === Infinity ? -1 : LIMIT);

  const byLine = new Map();
  const reasonTally = new Map();
  let matched = 0;
  const updates = [];

  for (const row of rows) {
    const lineId = String(row.line_id || row.line_code || '').replace(/^L/i, '');
    const r = bestMatchAnyDirection(lineId, row.stop_name, row.delay_mins, row.timestamp);
    if (r) {
      matched++;
      byLine.set(row.line_code, (byLine.get(row.line_code) || 0) + 1);
      updates.push({ id: row.id, scheduled: r.scheduledTime, actual: r.actualTime, direction: r.direction });
    } else {
      const key = 'no_match';
      reasonTally.set(key, (reasonTally.get(key) || 0) + 1);
    }
  }

  const report = {
    mode: APPLY ? 'apply' : 'dry-run',
    totalRows: total,
    rowsWithoutTimes: pending,
    mataroRowsWithoutTimes: backfillable,
    legacyRowsSkippedNoSchedule: legacyNoSchedule,
    examined: rows.length,
    matched,
    matchRate: rows.length ? +(matched / rows.length).toFixed(3) : 0,
    matchedByLine: Object.fromEntries([...byLine.entries()].sort()),
    written: 0
  };

  if (APPLY && updates.length) {
    const stmt = historyDb.db.prepare(
      'UPDATE delay_logs SET scheduled_time = ?, actual_time = ?, direction = ?, times_source = ? WHERE id = ?'
    );
    historyDb.db.exec('BEGIN IMMEDIATE');
    try {
      let written = 0;
      for (let i = 0; i < updates.length; i += BATCH) {
        for (const u of updates.slice(i, i + BATCH)) {
          stmt.run(u.scheduled, u.actual, u.direction, 'derived_timetable_backfill', u.id);
          written++;
        }
      }
      historyDb.db.exec('COMMIT');
      report.written = written;
    } catch (err) {
      historyDb.db.exec('ROLLBACK');
      throw err;
    }
  }

  console.log(JSON.stringify(report, null, 2));
  if (!APPLY && updates.length) {
    console.log('\nDry run — nothing was written. Re-run with --apply to store these approximations.');
  }
  if (APPLY) {
    console.log('\nAll touched rows are stamped derived_timetable_backfill. They are approximations, not observations.');
  }
}

if (require.main === module) {
  try {
    historyDb.init();
    run();
    historyDb.close();
  } catch (err) {
    console.error(`backfill_delay_times failed: ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = { bestMatchAnyDirection };
