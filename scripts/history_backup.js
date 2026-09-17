const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

function verify(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Database integrity check failed');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    if (!tables.includes('delay_logs') || !tables.includes('vehicle_snapshots')) throw new Error('Not an Arribo history database');
    return { delays: db.prepare('SELECT count(*) AS count FROM delay_logs').get().count, snapshots: db.prepare('SELECT count(*) AS count FROM vehicle_snapshots').get().count };
  } finally { db.close(); }
}

function backup(source, destination) {
  source = path.resolve(source);
  destination = path.resolve(destination);
  if (!fs.statSync(source).isFile()) throw new Error('Source must be an existing database');
  if (!fs.statSync(path.dirname(destination)).isDirectory()) throw new Error('Destination parent must exist');
  if (source === destination || fs.existsSync(destination)) throw new Error('Refusing to overwrite destination');
  const staging = `${destination}.${crypto.randomUUID()}.partial`;
  let db;
  try {
    db = new DatabaseSync(source, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('VACUUM INTO ?').run(staging);
    db.close(); db = null;
    const summary = verify(staging);
    // Hard-link publication is atomic and fails if destination appeared meanwhile.
    fs.linkSync(staging, destination);
    return summary;
  } finally {
    if (db) db.close();
    if (fs.existsSync(staging)) fs.unlinkSync(staging);
  }
}

if (require.main === module) {
  const [mode, source, target] = process.argv.slice(2);
  try {
    if (!['backup', 'restore', 'verify'].includes(mode) || !source || (mode !== 'verify' && !target)) throw new Error('Usage: node scripts/history_backup.js backup|restore SOURCE NEW_TARGET; or verify FILE');
    const result = mode === 'verify' ? verify(path.resolve(source)) : backup(source, target);
    console.log(JSON.stringify({ operation: mode, ...result }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { backup, verify };
