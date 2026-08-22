const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');
const historyDb = require('../src/historyDb');

function runHistoryDbTests() {
  console.log('Testing HistoryDb SQLite Concurrency, PRAGMAs & Indexes...');

  // Lazy-open: explicitly open the database before poking internals.
  historyDb.init();

  // 1. Verify PRAGMAs
  console.log('\n1. Verifying PRAGMA configuration...');
  const busyTimeout = historyDb.db.prepare('PRAGMA busy_timeout;').get();
  assert(busyTimeout.timeout === 5000, `Expected busy_timeout=5000, got ${busyTimeout.timeout}`);

  const journalMode = historyDb.db.prepare('PRAGMA journal_mode;').get();
  assert(journalMode.journal_mode.toLowerCase() === 'wal', `Expected journal_mode=wal, got ${journalMode.journal_mode}`);

  const synchronous = historyDb.db.prepare('PRAGMA synchronous;').get();
  assert(synchronous.synchronous === 1, `Expected synchronous=1 (NORMAL), got ${synchronous.synchronous}`);

  const cacheSize = historyDb.db.prepare('PRAGMA cache_size;').get();
  assert(cacheSize.cache_size === -2048, `Expected cache_size=-2048, got ${cacheSize.cache_size}`);

  const walCheckpoint = historyDb.db.prepare('PRAGMA wal_autocheckpoint;').get();
  assert(walCheckpoint.wal_autocheckpoint === 200, `Expected wal_autocheckpoint=200, got ${walCheckpoint.wal_autocheckpoint}`);

  const tempStore = historyDb.db.prepare('PRAGMA temp_store;').get();
  assert(tempStore.temp_store === 2, `Expected temp_store=2 (MEMORY), got ${tempStore.temp_store}`);

  const autoVacuum = historyDb.db.prepare('PRAGMA auto_vacuum;').get();
  assert(autoVacuum.auto_vacuum === 2, `Expected auto_vacuum=2 (INCREMENTAL), got ${autoVacuum.auto_vacuum}`);

  console.log('✓ All PRAGMAs verified (WAL, busy_timeout=5000, synchronous=NORMAL, cache_size=-2048, wal_autocheckpoint=200, temp_store=MEMORY, auto_vacuum=INCREMENTAL).');

  // 2. Verify Indexes
  console.log('\n2. Verifying required direct and composite indexes...');
  const indexes = historyDb.db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'").all();
  const indexNames = indexes.map(i => i.name);

  // idx_delay_timestamp and idx_delay_line_timestamp were removed as redundant
  // (idx_delay_time_line(timestamp, line_code) prefix-covers both). The migration
  // in historyDb.init() drops them from pre-existing databases.
  const requiredIndexes = [
    'idx_delay_time_line',
    'idx_delay_stop',
    'idx_delay_stop_timestamp',
    'idx_veh_timestamp'
  ];

  for (const req of requiredIndexes) {
    assert(indexNames.includes(req), `Index ${req} missing from database! Found: ${indexNames.join(', ')}`);
    console.log(`✓ Index ${req} verified.`);
  }
  for (const dropped of ['idx_delay_timestamp', 'idx_delay_line_timestamp']) {
    assert(!indexNames.includes(dropped), `Redundant index ${dropped} should have been dropped by migration! Found: ${indexNames.join(', ')}`);
    console.log(`✓ Redundant index ${dropped} correctly absent.`);
  }

  // 3. Verify Query Plan uses indexes
  console.log('\n3. Verifying EXPLAIN QUERY PLAN optimizations...');
  const cutoff = Date.now() - 24 * 3600 * 1000;
  
  const qpDelayTimestamp = historyDb.db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM delay_logs WHERE timestamp >= ?').all(cutoff);
  // timestamp queries are served by the composite idx_delay_time_line (timestamp prefix)
  const usesDelayTimestampIndex = qpDelayTimestamp.some(s => s.detail.includes('idx_delay_time_line'));
  assert(usesDelayTimestampIndex, `Expected query on timestamp to use idx_delay_time_line, got: ${JSON.stringify(qpDelayTimestamp)}`);
  console.log('✓ EXPLAIN QUERY PLAN confirms idx_delay_time_line used for timestamp queries.');

  const qpVehTimestamp = historyDb.db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM vehicle_snapshots WHERE timestamp >= ?').all(cutoff);
  const usesVehTimestampIndex = qpVehTimestamp.some(s => s.detail.includes('idx_veh_timestamp'));
  assert(usesVehTimestampIndex, `Expected query on vehicle timestamp to use idx_veh_timestamp, got: ${JSON.stringify(qpVehTimestamp)}`);
  console.log('✓ EXPLAIN QUERY PLAN confirms idx_veh_timestamp used for vehicle queries.');

  // 4. Verify checkpointTruncate()
  console.log('\n4. Testing checkpointTruncate()...');
  const cpRes = historyDb.checkpointTruncate();
  assert.strictEqual(cpRes, true, 'checkpointTruncate must return true');
  console.log('✓ checkpointTruncate() successfully executed.');

  // 5. Test SQLite Concurrency & busy_timeout under multiple readers/writers
  console.log('\n5. Testing Concurrency & Busy Timeout under second connection...');
  const readerDb = new DatabaseSync(historyDb.dbPath);
  readerDb.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');

  // Concurrently insert via historyDb and read via readerDb
  historyDb.recordVehicleSnapshot({
    vehicleId: 'TEST_CONCURRENCY_1',
    lineId: 'CAT_TEST_1',
    lineCode: 'TEST',
    agency: 'ConcurrencyTest',
    lat: 41.5,
    lon: 2.4,
    speedKmh: 45,
    bearing: 90,
    delayMins: 2,
    isRealTime: true,
    status: 'active',
    timestamp: Date.now()
  });

  const row = readerDb.prepare("SELECT * FROM vehicle_snapshots WHERE vehicle_id = 'TEST_CONCURRENCY_1'").get();
  assert(row && row.vehicle_id === 'TEST_CONCURRENCY_1', 'Reader connection must observe concurrent write without locking error');
  console.log('✓ Concurrent read/write across separate DatabaseSync handles verified.');

  // Cleanup test snapshot
  historyDb.db.prepare("DELETE FROM vehicle_snapshots WHERE vehicle_id = 'TEST_CONCURRENCY_1'").run();
  readerDb.close();

  console.log('\n🎉 ALL HISTORYDB CONCURRENCY & INDEX TESTS PASSED! 🎉\n');
}

if (require.main === module) {
  try {
    runHistoryDbTests();
    process.exit(0);
  } catch (err) {
    console.error('❌ HistoryDb tests failed:', err);
    process.exit(1);
  }
}

module.exports = { runHistoryDbTests };
