'use strict';
/**
 * Writer for the data files the server reads (src/data/*.json and
 * data/cities/mataro/*.json).
 *
 * `JSON.stringify(v, null, 2)` puts every number and coordinate on its own
 * line, which made these files ~85 000 lines. This format keeps them readable
 * and diffable at a tenth of that: anything short or flat (a trip, a stop) is
 * one line, and lists of small items (departure times, route points) are
 * packed several to a line. Only whitespace differs: the parsed value is
 * exactly the one `JSON.stringify` would have written.
 *
 * The seasons timetable also stores each day type once. The alias keys
 * (`Feiners`, `Dissabtes`, `Diumenges i Festius`, `festius`) were exact copies
 * of `weekday` / `saturday` / `sunday`; the server rebuilds them when it loads
 * the file (restoreDayAliases in app/schedules.go).
 *
 * CLI: `node scripts/lib/dataJson.js <file.json>...` rewrites files in place
 * (a seasons file also loses its alias copies); `--check` only reports.
 */

const fs = require('fs');
const path = require('path');

const WIDTH = 200; // longest line content this writer produces where it can choose
const RECORD_WIDTH = 320; // a flat record (trip, stop) stays on one line up to this
const PACK_ITEM = 80; // arrays whose items are all this short are packed

function isFlat(v) {
  // Primitives, or containers holding only primitives / primitive arrays.
  if (v === null || typeof v !== 'object') return true;
  return Object.values(v).every((x) => x === null || typeof x !== 'object' ||
    (Array.isArray(x) && x.every((y) => y === null || typeof y !== 'object')));
}

function format(v, indent) {
  const compact = JSON.stringify(v);
  if (v === null || typeof v !== 'object' || compact.length <= WIDTH) return compact;
  if (!Array.isArray(v) && isFlat(v) && compact.length <= RECORD_WIDTH) return compact;
  const inner = indent + '  ';
  if (Array.isArray(v)) {
    const items = v.map((x) => JSON.stringify(x));
    if (items.every((s) => s.length <= PACK_ITEM)) {
      const lines = [];
      let cur = '';
      for (const s of items) {
        if (cur && cur.length + 2 + s.length > WIDTH) {
          lines.push(cur + ',');
          cur = s;
        } else {
          cur = cur ? cur + ', ' + s : s;
        }
      }
      lines.push(cur);
      return '[\n' + lines.map((l) => inner + l).join('\n') + '\n' + indent + ']';
    }
    return '[\n' + v.map((x) => inner + format(x, inner)).join(',\n') + '\n' + indent + ']';
  }
  const entries = Object.entries(v);
  if (!entries.length) return '{}';
  return '{\n' + entries.map(([k, x]) => inner + JSON.stringify(k) + ': ' + format(x, inner)).join(',\n') +
    '\n' + indent + '}';
}

/** Formats a value for a data file (with the trailing newline). */
function formatDataJson(value) {
  // Round-trip first so undefined fields, toJSON and NaN behave exactly as in
  // JSON.stringify.
  return format(JSON.parse(JSON.stringify(value)), '') + '\n';
}

const DAY_ALIASES = [
  ['Feiners', 'weekday'],
  ['Dissabtes', 'saturday'],
  ['Diumenges i Festius', 'sunday'],
  ['festius', 'sunday'],
];
const ALIASED_FIELDS = ['dayTrips', 'schedules'];

/**
 * Returns a copy of a seasons payload ({_meta, seasons: {winter, summer}})
 * without the day-type alias copies. Throws when an alias differs from its
 * day type, so nothing that is not a copy is ever dropped.
 */
function stripDayAliases(payload) {
  const out = JSON.parse(JSON.stringify(payload));
  for (const [season, grid] of Object.entries(out.seasons || {})) {
    for (const [lineId, line] of Object.entries(grid || {})) {
      if (lineId === '_meta' || !line || !line.directions) continue;
      for (const [dirKey, dir] of Object.entries(line.directions)) {
        for (const field of ALIASED_FIELDS) {
          const m = dir && dir[field];
          if (!m || typeof m !== 'object') continue;
          for (const [alias, day] of DAY_ALIASES) {
            if (!(alias in m)) continue;
            if (!(day in m) || JSON.stringify(m[alias]) !== JSON.stringify(m[day])) {
              throw new Error(`${season} L${lineId} ${dirKey} ${field}.${alias} is not a copy of ${field}.${day}`);
            }
            delete m[alias];
          }
        }
      }
    }
  }
  return out;
}

function isSeasonsPayload(v) {
  return !!(v && typeof v === 'object' && v.seasons && typeof v.seasons === 'object');
}

/** The exact text a data file should hold for this value. */
function dataFileText(value) {
  return formatDataJson(isSeasonsPayload(value) ? stripDayAliases(value) : value);
}

module.exports = { formatDataJson, stripDayAliases, dataFileText, DAY_ALIASES };

if (require.main === module) {
  const check = process.argv.includes('--check');
  const files = process.argv.slice(2).filter((a) => a !== '--check');
  let stale = 0;
  for (const file of files) {
    const before = fs.readFileSync(file, 'utf8');
    const after = dataFileText(JSON.parse(before));
    // A Windows checkout (core.autocrlf) holds these files with CRLF: compare
    // the content, and write back in the file's own line endings.
    if (before.replace(/\r\n/g, '\n') === after) continue;
    stale++;
    if (!check) fs.writeFileSync(file, before.includes('\r\n') ? after.replace(/\n/g, '\r\n') : after);
    console.log(`${check ? 'would reformat' : 'reformatted'} ${path.relative(process.cwd(), file)}`);
  }
  if (check && stale) process.exitCode = 1;
}
