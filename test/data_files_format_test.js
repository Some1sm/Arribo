'use strict';

/**
 * test/data_files_format_test.js
 *
 * The data files the server reads are written by scripts/lib/dataJson.js:
 * one trip / stop per line and packed lists instead of one number per line
 * (they were ~85 000 lines pretty-printed), and the seasons timetable stores
 * each day type once (the server rebuilds the Catalan alias keys on load).
 * A file rewritten by hand or by an old writer would quietly grow back.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { formatDataJson, stripDayAliases, dataFileText, DAY_ALIASES } = require('../scripts/lib/dataJson');

const ROOT = path.join(__dirname, '..');
const FILES = [
  'src/data/mataro_schedules.seasons.json',
  'src/data/mataro_schedules.json',
  'data/cities/mataro/mataro_routes_full.json',
  'data/cities/mataro/mataro_paradas.json',
  'src/data/gencat_casas.json',
  'src/data/fares.json',
  'src/data/renfe_fleet.json',
  'src/data/mataro_events.json',
];

for (const rel of FILES) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(text, dataFileText(JSON.parse(text)), `${rel} is in the data-file format (node scripts/lib/dataJson.js ${rel})`);
  console.log(`  ✓ ${rel}: ${text.split('\n').length - 1} lines, data-file format`);
}

// The seasons file holds no alias copies.
const seasons = require('../src/data/mataro_schedules.seasons.json').seasons;
for (const [season, grid] of Object.entries(seasons)) {
  for (const [lineId, line] of Object.entries(grid)) {
    if (lineId === '_meta') continue;
    for (const [dirKey, dir] of Object.entries(line.directions)) {
      for (const field of ['dayTrips', 'schedules']) {
        for (const [alias] of DAY_ALIASES) {
          assert.ok(!(alias in (dir[field] || {})), `${season} L${lineId} ${dirKey} ${field} has no ${alias} copy`);
        }
        for (const day of ['weekday', 'saturday', 'sunday']) {
          assert.ok(Array.isArray(dir[field][day]), `${season} L${lineId} ${dirKey} ${field}.${day} is stored`);
        }
      }
    }
  }
}
console.log('  ✓ seasons timetable: each day type stored once');

// The format changes whitespace only.
const sample = { a: [1, 2.5, -0, 1e21, 'x'], b: { c: null, d: undefined, e: NaN }, f: [{ s: [1, 2] }], g: {}, h: [] };
assert.deepEqual(JSON.parse(formatDataJson(sample)), JSON.parse(JSON.stringify(sample)));
const long = { trips: Array.from({ length: 50 }, (_, i) => ({ s: Array.from({ length: 30 }, (_, j) => i * 1000 + j * 60) })) };
assert.deepEqual(JSON.parse(formatDataJson(long)), long);
assert.equal(formatDataJson(long).split('\n').filter((l) => /^\s*\{"s":\[[\d,]+\]\},?$/.test(l)).length, 50, 'one trip per line');
console.log('  ✓ formatDataJson changes whitespace only');

// stripDayAliases drops copies and refuses anything that is not one.
const payload = (feiners) => ({ seasons: { winter: { 1: { directions: { 11: { schedules: { weekday: ['06:00'], Feiners: feiners } } } } } } });
assert.deepEqual(stripDayAliases(payload(['06:00'])).seasons.winter[1].directions[11].schedules, { weekday: ['06:00'] });
assert.throws(() => stripDayAliases(payload(['06:05'])), /not a copy/);
console.log('  ✓ stripDayAliases drops exact copies only');
