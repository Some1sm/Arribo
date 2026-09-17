const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { backup, verify } = require('../scripts/history_backup');
const serviceStatus = require('../src/core/serviceStatus');

function browser(disabled = false) {
  const data = new Map();
  const context = vm.createContext({ console, localStorage: {
    getItem(key) { if (disabled) throw new Error('disabled'); return data.get(key) || null; },
    setItem(key, value) { if (disabled) throw new Error('disabled'); data.set(key, value); },
    removeItem(key) { data.delete(key); }
  } });
  context.window = context;
  for (const name of ['storage', 'journeys']) vm.runInContext(fs.readFileSync(path.join(__dirname, `../public/js/${name}.js`), 'utf8'), context);
  return { context, data };
}
for (const disabled of [false, true]) {
  const { context, data } = browser(disabled);
  const journeys = context.TransitJourneys;
  const from = { query: 'Origen', lat: 0, lon: 0 }, to = { query: 'Destí', stopId: '1001' };
  const saved = journeys.save(from, to, 'Casa');
  assert.equal(saved.from.lat, 0);
  assert.equal(saved.to.lat, null);
  assert.equal(saved.departureDate, null);
  journeys.save(from, to, 'Actualitzat', { walkingSpeed: 50, maxWalkingDistance: 500 });
  assert.equal(journeys.listSaved()[0].walkingSpeed, 50);
  assert.equal(journeys.listSaved()[0].maxWalkingDistance, 500);
  assert.equal(journeys.listSaved().length, 1);
  journeys.rename(journeys.listSaved()[0].id, 'Nou nom');
  assert.equal(journeys.listSaved()[0].label, 'Nou nom');
  for (let i = 0; i < 12; i++) journeys.addRecent({ query: String(i) }, to, 'fastest');
  assert.equal(journeys.listRecent().length, 10);
  journeys.addRecent({ query: '11' }, to, 'fastest');
  assert.equal(journeys.listRecent().length, 10);
  journeys.clearAll();
  assert.equal(journeys.listSaved().length, 0);
  assert.equal(journeys.listRecent().length, 0);
  data.set('arribo_store_v1:saved_journeys', '{invalid');
  assert.equal(journeys.listSaved().length, 0);
}
const now = Date.now();
assert.equal(serviceStatus({}, [], true, false).ready, false);
const worker = { isHealthy: true, isRunning: true, metrics: { upstream: { lastVehicleSuccessAt: now } } };
assert.equal(serviceStatus(worker, [], true, false, now).status, 'ready');
assert.equal(serviceStatus(worker, [], true, true, now).status, 'stopping');
assert.equal(serviceStatus(worker, [], true, false, now + 120000).status, 'degraded');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arribo-backup-test-'));
let db;
try {
  const source = path.join(root, 'live.db'), target = path.join(root, 'backup.db'), restored = path.join(root, 'restored.db');
  db = new DatabaseSync(source);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE delay_logs(id); CREATE TABLE vehicle_snapshots(id); INSERT INTO delay_logs VALUES(1)');
  assert.equal(backup(source, target).delays, 1);
  db.exec('INSERT INTO delay_logs VALUES(2)');
  assert.equal(verify(target).delays, 1);
  assert.throws(() => backup(source, target), /overwrite/);
  assert.equal(backup(target, restored).delays, 1);
  assert.throws(() => backup(source, source), /overwrite/);
} finally { db?.close(); fs.rmSync(root, { recursive: true, force: true }); }
console.log('PASS: local journeys, corrupt/disabled storage, readiness states, WAL-consistent backup and isolated restore');
