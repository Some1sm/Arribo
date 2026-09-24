/**
 * scripts/scrape_maresme_timetables.js
 *
 * Scrapes BOTH seasonal timetables for Mataró Bus Urbà L1–L8 from the public
 * Mataró Bus timetable site (maresme.net), which publishes a genuinely different
 * grid per season:
 *
 *   https://maresme.net/matarobus/hivern/index.php?l=es&id=1   -> winter
 *   https://maresme.net/matarobus/estiu/index.php?l=es&id=1    -> summer
 *
 * WHY THIS EXISTS
 * ---------------
 * src/data/mataro_schedules.json was found to contain a MIXTURE of both
 * seasons: on L1, L2, L4, L6 and L8 direction 11 held the winter grid while
 * direction 12 held the summer one, so a rider got correct times one way and
 * wrong times back. The file had no season dimension and nothing could detect
 * or correct it. This script produces the two grids separately so the loader
 * can pick one.
 *
 * WHY TIMES COME FROM HERE AND GEOMETRY FROM AVANZA
 * -------------------------------------------------
 * The site publishes an actual time for every stop of every trip, per season.
 * That makes cumulative offsets authoritative rather than calibrated: the
 * previous build derived some of them, which left visible +/-1-3 min jitter
 * (L3 Saturdays). Stop geography, coordinates and distances still come from the
 * Avanza scrape, and are copied through untouched.
 *
 * COLUMN -> STOP MAPPING
 * ----------------------
 * The page renders one table whose columns are the stops of BOTH directions
 * concatenated. Column count equals the sum of both directions' stop counts for
 * all 8 lines, but which direction comes FIRST varies (L8 lists direction 12
 * first). It is resolved from the origin stop named in the table header, then
 * validated per stop by name.
 *
 * USAGE
 *   node scripts/scrape_maresme_timetables.js            # write the seasons file
 *   node scripts/scrape_maresme_timetables.js --diff     # report only, write nothing
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const CURRENT_PATH = path.join(__dirname, '..', 'src', 'data', 'mataro_schedules.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'src', 'data', 'mataro_schedules.seasons.json');
const BACKUP_PATH = path.join(__dirname, '..', 'src', 'data', 'mataro_schedules.pre-season.json');

const SEASONS = { hivern: 'winter', estiu: 'summer' };
const DAY_KEYS = { a: 'weekday', b: 'saturday', c: 'sunday' };
const CATALAN = { weekday: 'Feiners', saturday: 'Dissabtes', sunday: 'Diumenges i Festius' };
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DIFF_ONLY = process.argv.includes('--diff');

// ---------------------------------------------------------------------------
// Fetch / parse
// ---------------------------------------------------------------------------

/** The page is ISO-8859-1; decoding as UTF-8 turns "Català" into mojibake. */
function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchPage(new URL(res.headers.location, url).href));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('latin1')));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error(`timeout for ${url}`)));
  });
}

const ENTITIES = {
  '&aacute;': 'á', '&eacute;': 'é', '&egrave;': 'è', '&agrave;': 'à', '&iacute;': 'í',
  '&oacute;': 'ó', '&ograve;': 'ò', '&uacute;': 'ú', '&ntilde;': 'ñ', '&ccedil;': 'ç',
  '&Aacute;': 'Á', '&Eacute;': 'É', '&Iacute;': 'Í', '&Oacute;': 'Ó', '&Uacute;': 'Ú',
  '&nbsp;': ' ', '&middot;': '·', '&ocute;': 'ó', '&middot ': '·', '&quot;': '"', '&amp;': '&'
};

function decodeEntities(s) {
  return String(s).replace(/&[a-zA-Z]+;|&#\d+;/g, (m) => {
    if (ENTITIES[m]) return ENTITIES[m];
    const num = m.match(/^&#(\d+);$/);
    return num ? String.fromCharCode(Number(num[1])) : m;
  });
}

const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, '')).trim();

const isTime = (v) => /^\d{1,2}:\d{2}$/.test(v);

/** seconds-of-day for 'HH:MM'; NaN for a '-----' no-service slot. */
function toSec(v) {
  if (!isTime(v)) return NaN;
  const [h, m] = v.split(':').map(Number);
  return h * 3600 + m * 60;
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Pulls the sNN{a,b,c} arrays out of the page. Slots are kept IN PLACE,
 * including '-----' markers, so that columns stay index-parallel to each other;
 * filtering before comparing would silently re-pair different trips.
 */
function parseSlotArrays(html) {
  const cols = {};
  for (const m of html.matchAll(/\bs(\d\d)([abc])\s*=\s*new Array\(([^)]*)\)/g)) {
    const col = m[1];
    if (!cols[col]) cols[col] = {};
    cols[col][m[2]] = m[3]
      .split(',')
      .map((x) => x.trim().replace(/^'(.*)'$/, '$1'))
      .filter((x) => x !== undefined);
  }
  return cols;
}

/**
 * Stop name per column, from the table rows. Two conventions coexist:
 * a `class="nl"` cell names the select BEFORE it, a `class="nr"` cell the
 * select AFTER it. Rows may contain both, so they are resolved by position
 * rather than by "the name in this row".
 */
function parseColumnNames(html) {
  const map = {};
  for (const row of html.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
    const toks = [...row[1].matchAll(/<td class="n(l|r)">([\s\S]*?)<\/td>|<select name="s(\d\d)"/g)]
      .map((t) => (t[3] !== undefined ? { k: 'sel', col: t[3] } : { k: t[1], name: stripTags(t[2]) }));
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.k === 'l') {
        for (let j = i - 1; j >= 0; j--) if (toks[j].k === 'sel') { if (t.name) map[toks[j].col] = t.name; break; }
      } else if (t.k === 'r') {
        for (let j = i + 1; j < toks.length; j++) if (toks[j].k === 'sel') { if (t.name) map[toks[j].col] = t.name; break; }
      }
    }
  }
  return map;
}

/** The stop named in the header cell is the origin of the FIRST direction block. */
function parseFirstOriginName(html) {
  const m = html.match(/<td colspan="2" class="tc">[\s\S]*?<\/select><\/td>\s*<td colspan="4">([^<]*)<\/td>/i);
  return m ? stripTags(m[1]) : null;
}

const normName = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]/gi, '').toLowerCase();

/**
 * Median seconds from one column to another, taken across every trip that
 * serves both. Median rather than mean or first-trip: individual columns drift
 * by a minute against each other, and a single trip is not trustworthy, but the
 * central value is.
 */
function medianOffsetSec(from, to) {
  const diffs = [];
  const n = Math.min(from.length, to.length);
  for (let i = 0; i < n; i++) {
    const a = toSec(from[i]); const b = toSec(to[i]);
    if (Number.isFinite(a) && Number.isFinite(b)) diffs.push(b - a);
  }
  if (!diffs.length) return null;
  diffs.sort((a, b) => a - b);
  const mid = diffs.length >> 1;
  return diffs.length % 2 ? diffs[mid] : Math.round((diffs[mid - 1] + diffs[mid]) / 2);
}

// ---------------------------------------------------------------------------
// Build one season
// ---------------------------------------------------------------------------

const realDirectionKeys = (line) => Object.keys(line.directions)
  .filter((k) => k !== '21' && !line.directions[k]._invalid);

/**
 * Resolves which direction occupies columns [0, n) and which follows it.
 * Uses the header origin name, and refuses to guess if that is ambiguous or
 * disagrees with the column-count arithmetic.
 */
function resolveBlocks(line, colCount, firstOriginName) {
  const keys = realDirectionKeys(line);
  if (keys.length !== 2) return { error: `expected 2 real directions, found ${keys.length}` };
  const [a, b] = keys;
  const counts = { [a]: line.directions[a].stops.length, [b]: line.directions[b].stops.length };

  if (colCount !== counts[a] + counts[b]) {
    return { error: `column count ${colCount} != ${counts[a]} + ${counts[b]} stops` };
  }

  const target = normName(firstOriginName);
  const firstKey = [a, b].find((k) => normName(line.directions[k].originStop.name) === target);

  if (!firstKey) {
    return { error: `header origin "${firstOriginName}" matches neither direction (${a}=${line.directions[a].originStop.name}, ${b}=${line.directions[b].originStop.name})` };
  }
  const secondKey = firstKey === a ? b : a;
  return { offsets: { [firstKey]: 0, [secondKey]: counts[firstKey] }, order: [firstKey, secondKey] };
}

/**
 * Builds the timetable half of every direction for one season. Geometry,
 * distances and stop lists are carried over from the current file untouched;
 * only times are replaced.
 */
function buildSeason(html, line, seasonName, notes) {
  const cols = parseSlotArrays(html);
  const names = parseColumnNames(html);
  const colIds = Object.keys(cols).sort();
  const colCount = colIds.length;
  const blocks = resolveBlocks(line, colCount, parseFirstOriginName(html));
  if (blocks.error) return { error: blocks.error };

  const out = {};
  for (const dirKey of blocks.order) {
    const src = line.directions[dirKey];
    const offset = blocks.offsets[dirKey];
    const stops = src.stops;

    // Confirm the block really is this direction, stop by stop, wherever the
    // page named the column. Informational only: the operator abbreviates stop
    // names ("Pl. Dr. Fleming" vs "Pl. Doctor Fleming"), so a textual mismatch
    // is not evidence of a bad mapping. The fatal checks are the column count
    // and the header origin, both enforced in resolveBlocks.
    for (let i = 0; i < stops.length; i++) {
      const pageName = names[pad2(offset + i)];
      if (pageName && normName(pageName) !== normName(stops[i].name)) {
        notes.push(`${seasonName} L${line.lineId} d${dirKey} col${pad2(offset + i)}: page "${pageName}" vs data "${stops[i].name}"`);
      }
    }

    const dir = JSON.parse(JSON.stringify(src));
    dir.schedules = {};
    dir.dayStopTravelSec = {};
    dir.dayTravelSec = {};
    dir.scheduleStats = {};
    dir.afternoonOnly = {};

    for (const [slot, day] of Object.entries(DAY_KEYS)) {
      const originCol = cols[pad2(offset)][slot];
      if (!originCol) { notes.push(`${seasonName} L${line.lineId} d${dirKey} ${day}: no origin column`); continue; }

      const departures = originCol.filter(isTime);
      if (!departures.length) { notes.push(`${seasonName} L${line.lineId} d${dirKey} ${day}: no departures`); continue; }

      const stopMap = {};
      stops.forEach((stop, i) => {
        if (i === 0) { stopMap[String(stop.id)] = 0; return; }
        const target = cols[pad2(offset + i)] && cols[pad2(offset + i)][slot];
        if (!target) return;
        const off = medianOffsetSec(originCol, target);
        if (off !== null) stopMap[String(stop.id)] = off;
      });

      const terminal = stopMap[String(stops[stops.length - 1].id)];
      if (terminal === undefined) {
        notes.push(`${seasonName} L${line.lineId} d${dirKey} ${day}: no terminal offset`);
        continue;
      }

      // The published grid gives a real time for every stop, so the terminal
      // offsets that the previous build had to estimate are no longer estimates.
      // A bus cannot arrive at stop N+1 before stop N. A decrease means the
      // column block is misaligned, which is the one failure mode that would
      // quietly produce plausible-looking but wrong times, so it is fatal.
      let prev = -1;
      for (const stop of stops) {
        const v = stopMap[String(stop.id)];
        if (v === undefined) continue;
        if (v < prev) {
          return { error: `${day} offsets decrease at stop ${stop.id} (${prev}s -> ${v}s); column block is misaligned` };
        }
        prev = v;
      }

      dir.schedules[day] = departures;
      dir.dayStopTravelSec[day] = stopMap;
      dir.dayTravelSec[day] = terminal;
      dir.scheduleStats[day] = { count: departures.length, first: departures[0], last: departures[departures.length - 1] };
      dir.afternoonOnly[day] = toSec(departures[0]) >= 12 * 3600;

      // Keep the historical alias keys populated; the loader still falls back
      // to them and the data file has always carried both.
      dir.schedules[CATALAN[day]] = departures.slice();
      if (day === 'sunday') dir.schedules.festius = departures.slice();
    }

    if (!dir.dayTravelSec.weekday) {
      notes.push(`${seasonName} L${line.lineId} d${dirKey}: no weekday grid, copying current totals`);
      dir.dayTravelSec.weekday = src.totalTravelSec;
    }
    dir.totalTravelSec = dir.dayTravelSec.weekday;
    dir.totalTravelMinutes = Math.round(dir.totalTravelSec / 60);
    dir._estimatedStops = [];
    dir._season = seasonName;
    out[dirKey] = dir;
  }
  return { data: out, order: blocks.order };
}

// ---------------------------------------------------------------------------
// Diff mode
// ---------------------------------------------------------------------------

/** Which season each grid currently shipped in the file actually came from. */
function diffAgainstCurrent(current, seasons) {
  const rows = [];
  for (let L = 1; L <= 8; L++) {
    const line = current[String(L)];
    if (!line) continue;
    for (const dirKey of realDirectionKeys(line)) {
      for (const day of ['weekday', 'saturday', 'sunday']) {
        const ours = (line.directions[dirKey].schedules || {})[day] || [];
        if (!ours.length) continue;
        const match = {};
        for (const [sName, sData] of Object.entries(seasons)) {
          const theirs = ((sData[String(L)] || {}).directions?.[dirKey]?.schedules || {})[day] || [];
          match[sName] = theirs.length === ours.length && theirs.every((t, i) => t === ours[i]);
        }
        const tag = match.winter && match.summer ? 'both' : match.winter ? 'winter' : match.summer ? 'SUMMER' : 'NEITHER';
        rows.push({ line: L, dir: dirKey, day, n: ours.length, tag });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  const current = JSON.parse(fs.readFileSync(CURRENT_PATH, 'utf8'));
  const notes = [];
  const seasons = {};

  for (const [urlSeason, seasonName] of Object.entries(SEASONS)) {
    seasons[seasonName] = {};
    for (let L = 1; L <= 8; L++) {
      const url = `https://maresme.net/matarobus/${urlSeason}/index.php?l=es&id=${L}`;
      const html = await fetchPage(url);
      const line = current[String(L)];
      const built = buildSeason(html, line, seasonName, notes);
      if (built.error) {
        console.error(`✗ L${L} ${seasonName}: ${built.error}`);
        process.exitCode = 1;
        return;
      }
      seasons[seasonName][String(L)] = {
        lineId: line.lineId, code: line.code, lineName: line.lineName, color: line.color,
        agency: line.agency, operator: line.operator, mode: line.mode,
        directions: built.data,
        // Deliberately the EXISTING order, not the table order. The table lists
        // whichever direction the operator put first (L8 lists direction 12
        // first), and that is only an input to column mapping. directionIndexOrder
        // maps the legacy 0/1 index onto a directions key, so rewriting it here
        // would silently reverse every direction in the app.
        directionIndexOrder: line.directionIndexOrder
      };
      const counts = built.order.map((k) => `d${k}=${built.data[k].schedules.weekday.length}`).join(' ');
      console.log(`  ${seasonName} L${L}: ${counts} (order ${built.order.join(',')})`);
    }
  }

  if (DIFF_ONLY) {
    const rows = diffAgainstCurrent(current, seasons);
    const bad = rows.filter((r) => r.tag !== 'both' && r.tag !== 'winter');
    console.log('\n── Which season the SHIPPED file currently holds ──');
    for (const r of rows) {
      const mark = r.tag === 'SUMMER' ? '<< SUMMER' : r.tag === 'NEITHER' ? '<< NEITHER' : '';
      console.log(`  L${r.line} d${r.dir} ${r.day.padEnd(8)} n=${String(r.n).padStart(3)} ${r.tag}${mark}`);
    }
    const t = rows.reduce((a, r) => (a[r.tag] = (a[r.tag] || 0) + 1, a), {});
    console.log(`\n  tally: ${JSON.stringify(t)}`);
    console.log(`  grids that are NOT the winter grid: ${bad.length} of ${rows.length}`);
    if (notes.length) {
      console.log('\n── Warnings ──');
      for (const w of notes.slice(0, 40)) console.log('  ' + w);
    }
    return;
  }

  const payload = {
    _meta: {
      source: 'maresme.net Mataró Bus public timetables (see scripts/scrape_maresme_timetables.js)',
      seasonsSource: 'https://maresme.net/matarobus/{hivern,estiu}/index.php?l=es&id=N',
      geometrySource: current._meta.source,
      scrapedAt: new Date().toISOString(),
      validUntil: null,
      notes: [
        'Each season holds a complete grid. The loader picks one via seasonCalendar.',
        'Cumulative stop offsets are median deltas between adjacent published columns, so they are authoritative rather than calibrated.',
        'Weekend grids are identical in both seasons on this operator, which is recorded rather than assumed.',
        '_estimatedStops is empty: every offset here comes from a published time.'
      ]
    },
    seasons
  };


  if (!fs.existsSync(BACKUP_PATH)) fs.copyFileSync(CURRENT_PATH, BACKUP_PATH);
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2) + '\n');
  console.log(`\n✓ Wrote ${path.relative(process.cwd(), OUTPUT_PATH)}`);
  console.log(`  backup: ${path.relative(process.cwd(), BACKUP_PATH)}`);
  if (notes.length) {
    console.log(`\n── ${notes.length} note(s) ──`);
    for (const w of notes.slice(0, 40)) console.log('  ' + w);
  }
})().catch((err) => {
  console.error('scrape failed:', err.message);
  process.exit(1);
});
