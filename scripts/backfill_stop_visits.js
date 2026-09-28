#!/usr/bin/env node
'use strict';

/**
 * scripts/backfill_stop_visits.js
 *
 * Reconstructs stop_visits rows with source = 'backfill' from historical delay_logs.
 * Groups consecutive observations per vehicle by stop_name and <= 5 min gap.
 *
 * Usage:
 *   node scripts/backfill_stop_visits.js <path-to-db> [--force]
 *
 * Invariant: Must NEVER run against an active writer (checks BEGIN IMMEDIATE lock).
 * Must NEVER be exposed as an HTTP endpoint.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const dbPath = args.find(a => !a.startsWith('--'));

  if (!dbPath) {
    console.error('Usage: node scripts/backfill_stop_visits.js <path-to-db> [--force]');
    process.exit(1);
  }

  const resolvedPath = path.resolve(dbPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Database file does not exist: ${resolvedPath}`);
    process.exit(1);
  }

  let db;
  try {
    db = new DatabaseSync(resolvedPath);
  } catch (err) {
    console.error(`Failed to open SQLite database: ${err.message}`);
    process.exit(1);
  }

  // 1. Concurrency guard: verify we can take an exclusive write transaction
  try {
    db.exec('BEGIN IMMEDIATE;');
    db.exec('ROLLBACK;');
  } catch (err) {
    if (err.message && (err.message.includes('busy') || err.message.includes('locked'))) {
      console.error('❌ Database is currently locked by another process (SQLITE_BUSY).');
      console.error('   Stop the Arribo service or run backfill against a copy of the database.');
      process.exit(1);
    }
    console.error(`Unexpected transaction error: ${err.message}`);
    process.exit(1);
  }

  // 2. Ensure stop_visits table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS stop_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id TEXT NOT NULL,
      line_code TEXT NOT NULL,
      direction TEXT DEFAULT '',
      stop_name TEXT NOT NULL,
      first_ts INTEGER NOT NULL,
      last_ts INTEGER NOT NULL,
      delay_mins INTEGER NOT NULL,
      sample_count INTEGER NOT NULL,
      scheduled_time TEXT DEFAULT '',
      actual_time TEXT DEFAULT '',
      times_source TEXT DEFAULT '',
      is_realtime INTEGER DEFAULT 1,
      measured_delay_mins INTEGER,
      source TEXT DEFAULT 'live'
    );
    CREATE INDEX IF NOT EXISTS idx_visits_time_line ON stop_visits(last_ts, line_code);
    CREATE INDEX IF NOT EXISTS idx_visits_stop ON stop_visits(stop_name, last_ts);
  `);

  // 3. Idempotency check: check if backfill rows already exist
  const existingBackfill = db.prepare("SELECT COUNT(*) as cnt FROM stop_visits WHERE source = 'backfill'").get().cnt;
  if (existingBackfill > 0 && !force) {
    console.log(`⚠️ Stop visits table already contains ${existingBackfill} backfilled rows.`);
    console.log('   Use --force to overwrite existing backfill rows.');
    process.exit(0);
  }

  if (existingBackfill > 0 && force) {
    console.log(`Clearing ${existingBackfill} existing backfill rows (--force)...`);
    db.exec("DELETE FROM stop_visits WHERE source = 'backfill';");
  }

  console.log('Grouping delay_logs into stop visits...');
  const groupingSql = `
    WITH ordered AS (
      SELECT
        id,
        vehicle_id,
        line_code,
        direction,
        stop_name,
        timestamp,
        delay_mins,
        scheduled_time,
        actual_time,
        times_source,
        is_realtime,
        LAG(stop_name) OVER (PARTITION BY vehicle_id ORDER BY timestamp) as prev_stop,
        LAG(timestamp) OVER (PARTITION BY vehicle_id ORDER BY timestamp) as prev_ts
      FROM delay_logs
      WHERE delay_mins > -15 AND delay_mins <= 300
    ),
    flagged AS (
      SELECT *,
        CASE
          WHEN prev_stop IS NULL
            OR prev_stop != stop_name
            OR (timestamp - prev_ts) > 300000
          THEN 1 ELSE 0
        END as is_new_visit
      FROM ordered
    ),
    grouped AS (
      SELECT *,
        SUM(is_new_visit) OVER (PARTITION BY vehicle_id ORDER BY timestamp ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) as visit_group
      FROM flagged
    ),
    visit_bounds AS (
      SELECT
        vehicle_id,
        visit_group,
        MIN(timestamp) as first_ts,
        MAX(timestamp) as last_ts,
        COUNT(*) as sample_count,
        MAX(id) as max_id
      FROM grouped
      GROUP BY vehicle_id, visit_group
    )
    SELECT
      vb.vehicle_id,
      g.line_code,
      g.direction,
      g.stop_name,
      vb.first_ts,
      vb.last_ts,
      vb.sample_count,
      g.delay_mins,
      g.scheduled_time,
      g.actual_time,
      g.times_source,
      g.is_realtime
    FROM visit_bounds vb
    JOIN grouped g ON g.id = vb.max_id;
  `;

  db.exec('BEGIN TRANSACTION;');
  try {
    const visits = db.prepare(groupingSql).all();
    console.log(`Computed ${visits.length} stop visits from delay_logs. Inserting...`);

    const insertStmt = db.prepare(`
      INSERT INTO stop_visits
      (vehicle_id, line_code, direction, stop_name, first_ts, last_ts, delay_mins, sample_count, scheduled_time, actual_time, times_source, is_realtime, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'backfill')
    `);

    for (const v of visits) {
      insertStmt.run(
        v.vehicle_id || '',
        v.line_code || '',
        v.direction || '',
        v.stop_name || '',
        v.first_ts,
        v.last_ts,
        v.delay_mins !== null && v.delay_mins !== undefined ? v.delay_mins : 0,
        v.sample_count,
        v.scheduled_time || '',
        v.actual_time || '',
        v.times_source || '',
        v.is_realtime !== 0 ? 1 : 0
      );
    }

    db.exec('COMMIT;');
    console.log(`✅ Backfill complete. Inserted ${visits.length} stop_visits records.`);
  } catch (err) {
    db.exec('ROLLBACK;');
    console.error(`Backfill failed: ${err.message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
