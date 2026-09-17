const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.TZ = 'Europe/Madrid';
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-rollup-'));
process.env.DB_PATH = path.join(scratch, 'history.db');
const history = require('../src/historyDb');
const now = Date.now;
const hour = 3600000;
let clock = Date.parse('2026-09-17T12:30:00Z');
Date.now = () => clock;
const timestamp = clock - 2 * hour;
const record = (delay, time = timestamp, line = 'L1') => history.recordDelayLog({ lineCode: line, agency: 'Mataró Bus', delayMins: delay, timestamp: time });
const state = () => history.db.prepare('SELECT line_code, date_hour, sample_count, delay_sum, avg_delay_mins, max_delay_mins, on_time_count, late_count FROM hourly_line_stats ORDER BY line_code, date_hour').all();
const progress = () => history.db.prepare('SELECT last_id FROM hourly_rollup_progress').get().last_id;
try {
  history.init();
  history.aggregateHourlyStats();
  assert.equal(progress(), 0);
  for (const d of [1, 2, 2]) record(d);
  history.aggregateHourlyStats();
  assert.equal(state()[0].avg_delay_mins, 1.67);
  record(3);
  history.aggregateHourlyStats();
  assert.equal(state()[0].delay_sum, 8);
  assert.equal(state()[0].avg_delay_mins, 2);
  assert.equal(history.aggregateHourlyStats().bucketsUpdated, 0);
  const saved = progress();
  history.close();
  history.init();
  assert.equal(progress(), saved);
  record(-2, timestamp, 'L2');
  record(9, timestamp + hour);
  history.aggregateHourlyStats();
  const reference = history.db.prepare(`
    SELECT line_code, strftime('%Y-%m-%d %H:00', timestamp / 1000, 'unixepoch', 'localtime') AS date_hour,
      COUNT(*) AS sample_count, SUM(delay_mins) AS delay_sum, ROUND(AVG(delay_mins), 2) AS avg_delay_mins,
      MAX(delay_mins) AS max_delay_mins, SUM(delay_mins <= 3) AS on_time_count, SUM(delay_mins > 3) AS late_count
    FROM delay_logs GROUP BY line_code, date_hour ORDER BY line_code, date_hour
  `).all();
  assert.deepEqual(state(), reference);

  const before = state();
  clock += 40 * 24 * hour;
  history.pruneOldRecords();
  assert.equal(history.db.prepare('SELECT COUNT(*) AS n FROM delay_logs').get().n, 0);
  assert.deepEqual(state(), before);
  assert.equal(progress(), saved + 2);
  record(7);
  history.aggregateHourlyStats();
  assert.equal(state()[0].sample_count, 5);
  assert.equal(state()[0].delay_sum, 15);
  assert.equal(state()[0].avg_delay_mins, 3);
  history.aggregateHourlyStats();
  assert.equal(state()[0].sample_count, 5);

  const checkpoint = progress();
  const snapshot = state();
  record(1, timestamp, 'LFAIL');
  history.db.exec(`CREATE TRIGGER fail_rollup BEFORE INSERT ON hourly_line_stats
    WHEN NEW.line_code = 'LFAIL' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
  assert.throws(() => history.aggregateHourlyStats(), /injected failure/);
  assert.equal(progress(), checkpoint);
  assert.deepEqual(state(), snapshot);
  const rawCount = history.db.prepare('SELECT COUNT(*) AS n FROM delay_logs').get().n;
  history.pruneOldRecords();
  assert.equal(history.db.prepare('SELECT COUNT(*) AS n FROM delay_logs').get().n, rawCount);
  history.db.exec('DROP TRIGGER fail_rollup');
  history.aggregateHourlyStats();
  assert(progress() > checkpoint);

  history.close();
  history.dbPath = path.join(scratch, 'legacy.db');
  history.init();
  history.db.prepare(`INSERT INTO hourly_line_stats
    (line_code, agency, date_hour, sample_count, avg_delay_mins, max_delay_mins, on_time_count, late_count, timestamp)
    VALUES ('L1', 'Mataró Bus', strftime('%Y-%m-%d %H:00', ? / 1000, 'unixepoch', 'localtime'), 10, 2.5, 6, 8, 2, ?)`)
    .run(timestamp, timestamp);
  record(2);
  history.aggregateHourlyStats();
  assert.equal(state()[0].sample_count, 10, 'migration preserves a fuller legacy bucket');
  record(8);
  history.aggregateHourlyStats();
  assert.equal(state()[0].sample_count, 11);
  assert.equal(state()[0].delay_sum, 33);
  assert.equal(state()[0].avg_delay_mins, 3);
  console.log('PASS: exact sums, reference equivalence, no-op reruns, restart, late data, pruning, rollback, legacy migration');
} finally {
  Date.now = now;
  history.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
