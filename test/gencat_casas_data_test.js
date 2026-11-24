'use strict';

/**
 * test/gencat_casas_data_test.js
 *
 * src/data/gencat_casas.json is cut out of the Generalitat interurban GTFS
 * by scripts/import_gencat_moventis.js: the seven Empresa Casas lines through
 * Mataró, their stops, shapes, trips, calendar and the crosswalk to the
 * moventis.es stop ids. This guards its format and basic invariants.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { dataFileText } = require('../scripts/lib/dataJson');
const { zipEntries, simplify, nameSimilarity, parseGencatNote } = require('../scripts/import_gencat_moventis');

const FILE = path.join(__dirname, '..', 'src/data/gencat_casas.json');
const text = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
const data = JSON.parse(text);

assert.equal(text, dataFileText(data), 'gencat_casas.json is in the data-file format (node scripts/lib/dataJson.js src/data/gencat_casas.json)');
assert.ok(text.length < 5 * 1024 * 1024, 'file stays under 5 MB');

// Feed metadata
assert.match(data.feed.source, /^https:\/\/territori\.gencat\.cat\//);
assert.equal(data.feed.attribution, 'Generalitat de Catalunya');
assert.match(data.feed.licence, /Llicència oberta d'ús d'informació – Catalunya/);
assert.match(data.feed.calendarRange.start, /^\d{8}$/);
assert.ok(data.feed.calendarRange.end > data.feed.calendarRange.start);
assert.ok(data.feed.lastModified);

// The seven lines
const EXPECT = { 'C-10': '0498', 'C-20': '0501', 'C-30': '0495', 'e11.1': '0496', 'e11.2': '0497', 865: '0502', 'N-80': '0109' };
assert.equal(data.lines.length, 7);
const timeRe = /^\d{2,3}:[0-5]\d:[0-5]\d$/;
const usedServices = new Set();
for (const line of data.lines) {
  assert.equal(EXPECT[line.code], line.routeId, `${line.code} has route_id ${EXPECT[line.code]}`);
  assert.ok(line.name.startsWith(`(${line.gtfsCode})`), `${line.code}: name starts with its rider-facing code`);
  assert.ok(line.directions.length >= 1);
  for (const dir of line.directions) {
    const tag = `${line.code} dir ${dir.directionId}`;
    assert.ok(dir.stops.length >= 2, `${tag} has stops`);
    for (const s of dir.stops) {
      assert.ok(s.id && s.code && s.name, `${tag}: stop has id, code, name`);
      assert.ok(s.lat > 41 && s.lat < 42 && s.lon > 1.5 && s.lon < 3, `${tag}: stop ${s.id} is in the Maresme/Barcelona area`);
    }
    assert.ok(dir.shapes.length >= 1, `${tag} has shapes`);
    for (const sh of dir.shapes) {
      assert.ok(sh.length >= 2);
      for (const [la, lo] of sh) assert.ok(la > 41 && la < 42 && lo > 1.5 && lo < 3, `${tag}: shape points are [lat, lon]`);
    }
    assert.ok(dir.patterns.length >= 1);
    for (const p of dir.patterns) for (const i of p.stops) assert.ok(i >= 0 && i < dir.stops.length);
    assert.ok(dir.trips.length >= 1, `${tag} has trips`);
    for (const t of dir.trips) {
      const pat = dir.patterns[t.pattern];
      assert.ok(pat, `${tag}: trip ${t.id} has a pattern`);
      assert.equal(t.times.length, pat.stops.length, `${tag}: trip ${t.id} has one time per stop`);
      for (const tm of t.times) assert.match(tm, timeRe);
      for (let i = 1; i < t.times.length; i++) assert.ok(t.times[i] >= t.times[i - 1], `${tag}: trip ${t.id} times do not go backwards`);
      assert.ok(t.shape === null || (t.shape >= 0 && t.shape < dir.shapes.length));
      usedServices.add(String(t.service));
    }
  }
}
assert.equal(data.lines.find((l) => l.code === 'C-10').directions.length, 2);

// Calendar covers every service the trips use
for (const id of usedServices) {
  const s = data.services[id];
  assert.ok(s, `service ${id} has a calendar entry`);
  assert.equal(s.days.length, 7);
  assert.match(s.start, /^\d{8}$/);
  assert.ok(Array.isArray(s.added) && Array.isArray(s.removed));
}

// Crosswalk: Moventis ID_PARADA -> GTFS stop_id
const cw = data.crosswalk;
const gtfsIds = new Set(data.lines.flatMap((l) => l.directions.flatMap((d) => d.stops.map((s) => s.id))));
assert.deepEqual(Object.keys(cw.lineIds).sort(), Object.keys(EXPECT).sort());
assert.equal(Object.keys(cw.stops).length, cw.stats.total);
let matched = 0;
for (const [id, e] of Object.entries(cw.stops)) {
  assert.match(id, /^\d+$/);
  assert.ok(['stop_code', 'proximity+name', 'unmatched'].includes(e.method), `${id}: known method`);
  if (e.method === 'unmatched') assert.equal(e.gtfs, null);
  else { assert.ok(gtfsIds.has(e.gtfs), `${id}: GTFS stop ${e.gtfs} is one of the lines' stops`); matched++; }
}
assert.equal(matched, cw.stats.stop_code + cw.stats.proximity);
assert.equal(cw.stats.stop_code + cw.stats.proximity + cw.stats.unmatched, cw.stats.total);
// 188 Moventis stops on 2026-11-24: 169 by stop_code, 9 by proximity, 10 left unmatched
assert.ok(matched >= 170, `crosswalk covers at least 170 Moventis stop ids (got ${matched})`);
assert.ok(cw.perLine['C-10'].matched >= 80, 'C-10 crosswalk covers at least 80 stop ids');

// Importer helpers
const zlib = require('node:zlib');
function tinyZip(name, content) {
  const raw = Buffer.from(content);
  const def = zlib.deflateRawSync(raw);
  const nm = Buffer.from(name);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(def.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(def.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(0, 42);
  const body = Buffer.concat([lh, nm, def]);
  const cd = Buffer.concat([ch, nm]);
  const eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(1, 8); eo.writeUInt16LE(1, 10); eo.writeUInt32LE(cd.length, 12); eo.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, eo]);
}
assert.equal(zipEntries(tinyZip('a.txt', 'hello')).read('a.txt').toString(), 'hello', 'minimal ZIP reader inflates an entry');
const line = [[41, 2], [41.00001, 2.00001], [41.00002, 2.00002], [41.01, 2.01]];
assert.ok(simplify(line, 5).length < line.length, 'Douglas-Peucker drops near-collinear points');
assert.ok(nameSimilarity('Camí Ral (Sant Simó)', 'cami ral - sant simo') > 0.9);

// nota.txt parser (plan step 5.4): always preserves raw text + extracts dates/flags
{
  const n1 = parseGencatNote("I nits de la Revetlla de Sant Joan, la de Cap d'Any i la de la Festivitat de la Mercè", [2026]);
  assert.equal(n1.raw, "I nits de la Revetlla de Sant Joan, la de Cap d'Any i la de la Festivitat de la Mercè");
  assert.deepEqual(n1.added, ['20260623', '20260923', '20261231']);
  assert.ok(n1.tags.includes('festive_nights'));

  const n2 = parseGencatNote('Excepte festes locals a Barcelona', [2026]);
  assert.equal(n2.raw, 'Excepte festes locals a Barcelona');
  // 2026 Easter is April 5 -> Segona Pasqua (+50 days) is May 25; La Mercè is Sep 24.
  assert.deepEqual(n2.removed, ['20260525', '20260924']);
  assert.ok(n2.tags.includes('except_local_holidays'));

  const n3 = parseGencatNote('I festes locals a Barcelona', [2026]);
  assert.deepEqual(n3.added, ['20260525', '20260924']);
  assert.ok(n3.tags.includes('include_local_holidays'));

  const n4 = parseGencatNote('Parades a la demanda: Les Ginesteres. Reserva prèvia al tlf. 900130014', [2026]);
  assert.equal(n4.requestStop, true);
  assert.ok(n4.tags.includes('on_demand'));

  const n5 = parseGencatNote('Els dijous (dies de mercat) no para a c. Mercè (CAP)', [2026]);
  assert.deepEqual(n5.marketWeekdays, [3]);
  assert.ok(n5.tags.includes('market_day'));

  const n6 = parseGencatNote('Dies lectius de la UAB', [2026]);
  assert.equal(n6.raw, 'Dies lectius de la UAB');
  assert.ok(n6.tags.includes('academic_calendar'));
}

console.log('  ✓ gencat_casas.json: format, 7 lines, calendar and crosswalk invariants');
