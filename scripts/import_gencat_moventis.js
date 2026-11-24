#!/usr/bin/env node
'use strict';
/**
 * Cuts the seven Empresa Casas (Moventis) lines through Mataró out of the
 * Generalitat de Catalunya interurban bus GTFS and writes
 * src/data/gencat_casas.json (data-file format, see
 * scripts/lib/dataJson.js), with a stop crosswalk to the moventis.es stop ids.
 *
 *   node scripts/import_gencat_moventis.js                 # download + moventis.es
 *   node scripts/import_gencat_moventis.js --zip feed.zip  # local GTFS copy
 *   node scripts/import_gencat_moventis.js --skip-moventis # keep the crosswalk of the existing file
 *   node scripts/import_gencat_moventis.js --moventis-cache DIR   # reuse/save raw GetTrayectos answers
 *   options: --last-modified "<HTTP date>" (with --zip), --out FILE, --tolerance METRES (shape simplification, default 5)
 *
 * No npm dependencies. The ZIP is read with a minimal central-directory reader
 * and zlib.inflateRawSync. moventis.es is asked ONE request at a time, at least
 * 11 s apart (its robots.txt says Crawl-delay: 10).
 *
 * Output layout (see OPERATIONS.md, "Moventis static data from the Generalitat GTFS"):
 *   feed        source URL, Last-Modified, calendar range, licence, attribution, notes
 *   lines[]     per line: code, routeId, name, directions[]
 *     direction   directionId, stops[] (the canonical pattern first, then any extra
 *                 stops other patterns use), patterns[] (stops = indexes into stops),
 *                 shapes[] ([lat, lon] pairs, 5 decimals, Douglas-Peucker simplified),
 *                 trips[] {id, service, pattern, shape, times[] ("HH:MM:SS" departure at
 *                 each stop of the pattern, as published, may exceed 24:00), note?}
 *   services    calendar.txt + calendar_dates.txt for the services the trips use
 *   crosswalk   moventis.es ID_PARADA -> GTFS stop_id and how it was matched
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { formatDataJson } = require('./lib/dataJson');

const ZIP_URL = 'https://territori.gencat.cat/web/.content/home/serveis/visors-cartografia/bases-cartografiques/infraestructures-mobilitat/autobusos-interurbans/busos-interurbans-GTFS.zip';
const MOVENTIS_BASE = 'https://www.moventis.es';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MOVENTIS_GAP_MS = 11500;

// route_id -> [rider-facing code, Moventis ID_LINEA]
const LINES = [
  ['0498', 'C10', 53],
  ['0501', 'C20', 57],
  ['0495', 'C30', 59],
  ['0496', 'e11.1', 47],
  ['0497', 'e11.2', 48],
  ['0502', '865', 51],
  ['0109', 'N80', 68],
];
const DISPLAY_CODE = { C10: 'C-10', C20: 'C-20', C30: 'C-30', 'e11.1': 'e11.1', 'e11.2': 'e11.2', 865: '865', N80: 'N-80' };

const ROOT = path.join(__dirname, '..');

// ---- ZIP -------------------------------------------------------------------

function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP file (no end-of-central-directory record)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad ZIP central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...out.keys()],
    read(name) {
      const e = out.get(name);
      if (!e) return null;
      const nl = buf.readUInt16LE(e.local + 26);
      const el = buf.readUInt16LE(e.local + 28);
      const start = e.local + 30 + nl + el;
      const raw = buf.subarray(start, start + e.csize);
      if (e.method === 0) return Buffer.from(raw);
      if (e.method === 8) return zlib.inflateRawSync(raw);
      throw new Error(`${name}: unsupported ZIP method ${e.method}`);
    },
  };
}

// ---- CSV -------------------------------------------------------------------

function splitCsvLine(line) {
  if (!line.includes('"')) return line.split(',').map((s) => s.trim());
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

/** Calls fn(row) for every row of a GTFS CSV. Header names and values are trimmed. */
function eachRow(buf, fn) {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let pos = 0;
  let header = null;
  while (pos < text.length) {
    let nl = text.indexOf('\n', pos);
    if (nl < 0) nl = text.length;
    const line = text.slice(pos, nl).replace(/\r$/, '');
    pos = nl + 1;
    if (!line) continue;
    const cells = splitCsvLine(line);
    if (!header) { header = cells; continue; }
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cells[i] === undefined ? '' : cells[i];
    fn(row);
  }
}

// ---- geometry --------------------------------------------------------------

const R = 6371008.8;
function distM(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Douglas-Peucker on [lat, lon] points, tolerance in metres (local equirectangular plane). */
function simplify(pts, tol) {
  if (pts.length < 3 || !(tol > 0)) return pts;
  const lat0 = pts[0][0] * Math.PI / 180;
  const kx = Math.cos(lat0) * Math.PI / 180 * R;
  const ky = Math.PI / 180 * R;
  const xy = pts.map(([la, lo]) => [lo * kx, la * ky]);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = -1;
    let idx = -1;
    const [ax, ay] = xy[a];
    const [bx, by] = xy[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      let t = len2 ? ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(xy[i][0] - (ax + t * dx), xy[i][1] - (ay + t * dy));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// ---- names -----------------------------------------------------------------

function normName(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter((w) => w && !['c', 'av', 'avda', 'ctra', 'pl', 'de', 'del', 'la', 'el', 'les', 'els', 'l', 'd', 'i', 'carrer', 'avinguda', 'carretera', 'placa', 'pg', 'passeig'].includes(w));
}
function nameSimilarity(a, b) {
  const A = new Set(normName(a));
  const B = new Set(normName(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---- args ------------------------------------------------------------------

function parseArgs(argv) {
  const o = { out: path.join(ROOT, 'src/data/gencat_casas.json'), tolerance: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--zip') o.zip = argv[++i];
    else if (a === '--last-modified') o.lastModified = argv[++i];
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--tolerance') o.tolerance = Number(argv[++i]);
    else if (a === '--moventis-cache') o.cache = path.resolve(argv[++i]);
    else if (a === '--skip-moventis') o.skipMoventis = true;
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); } else throw new Error(`unknown option ${a}`);
  }
  return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- GTFS ------------------------------------------------------------------

async function loadZip(opts) {
  if (opts.zip) {
    const st = fs.statSync(opts.zip);
    return { buf: fs.readFileSync(opts.zip), lastModified: opts.lastModified || st.mtime.toUTCString(), source: ZIP_URL, local: true };
  }
  const res = await fetch(ZIP_URL, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`GTFS download failed: HTTP ${res.status}`);
  return { buf: Buffer.from(await res.arrayBuffer()), lastModified: res.headers.get('last-modified') || '', source: ZIP_URL };
}

function cutLines(zip) {
  const rd = (n) => {
    const b = zip.read(n);
    if (!b) throw new Error(`${n} missing from the GTFS zip`);
    return b;
  };
  const wanted = new Map(LINES.map(([id, code, mov]) => [id, { code, mov }]));
  const routes = new Map();
  eachRow(rd('routes.txt'), (r) => {
    if (!wanted.has(r.route_id)) return;
    const m = /^\(([^)]+)\)\s*(.*)$/.exec(r.route_long_name);
    const code = m ? m[1] : null;
    if (code !== wanted.get(r.route_id).code) throw new Error(`route ${r.route_id}: long name "${r.route_long_name}" does not start with (${wanted.get(r.route_id).code})`);
    routes.set(r.route_id, { name: r.route_long_name, shortName: r.route_short_name, agency: r.agency_id });
  });
  if (routes.size !== LINES.length) throw new Error(`found ${routes.size} of ${LINES.length} routes`);

  const trips = new Map();
  eachRow(rd('trips.txt'), (r) => {
    if (routes.has(r.route_id)) trips.set(r.trip_id, r);
  });

  const stopTimes = new Map(); // trip -> [{seq, stop, dep, arr, pickup, dropoff}]
  let nonZeroSeconds = 0;
  let totalTimes = 0;
  eachRow(rd('stop_times.txt'), (r) => {
    if (!trips.has(r.trip_id)) return;
    let a = stopTimes.get(r.trip_id);
    if (!a) stopTimes.set(r.trip_id, a = []);
    const dep = r.departure_time || r.arrival_time;
    totalTimes++;
    if (!/:00$/.test(dep)) nonZeroSeconds++;
    a.push({ seq: Number(r.stop_sequence), stop: r.stop_id, dep, arr: r.arrival_time });
  });
  for (const a of stopTimes.values()) a.sort((x, y) => x.seq - y.seq);

  const stops = new Map();
  const needStops = new Set();
  for (const a of stopTimes.values()) for (const s of a) needStops.add(s.stop);
  eachRow(rd('stops.txt'), (r) => {
    if (needStops.has(r.stop_id)) stops.set(r.stop_id, { id: r.stop_id, code: r.stop_code, name: r.stop_name, lat: round(Number(r.stop_lat), 6), lon: round(Number(r.stop_lon), 6) });
  });

  const shapeIds = new Set([...trips.values()].map((t) => t.shape_id).filter(Boolean));
  const shapeRaw = new Map();
  eachRow(rd('shapes.txt'), (r) => {
    if (!shapeIds.has(r.shape_id)) return;
    let a = shapeRaw.get(r.shape_id);
    if (!a) shapeRaw.set(r.shape_id, a = []);
    a.push([Number(r.shape_pt_sequence), Number(r.shape_pt_lat), Number(r.shape_pt_lon)]);
  });

  const notes = new Map();
  const notaBuf = zip.read('nota.txt');
  if (notaBuf) {
    eachRow(notaBuf, (r) => {
      if (trips.has(r.trip_id) && routes.has(r.route_id)) {
        const prev = notes.get(r.trip_id);
        notes.set(r.trip_id, prev ? `${prev}; ${r.nota}` : r.nota);
      }
    });
  }

  const usedServices = new Set([...trips.values()].map((t) => t.service_id));
  const calendar = new Map();
  let feedStart = '99999999';
  let feedEnd = '00000000';
  eachRow(rd('calendar.txt'), (r) => {
    if (r.start_date < feedStart) feedStart = r.start_date;
    if (r.end_date > feedEnd) feedEnd = r.end_date;
    if (usedServices.has(r.service_id)) calendar.set(r.service_id, r);
  });
  const dates = new Map();
  eachRow(rd('calendar_dates.txt'), (r) => {
    if (!usedServices.has(r.service_id)) return;
    let d = dates.get(r.service_id);
    if (!d) dates.set(r.service_id, d = { added: [], removed: [] });
    (r.exception_type === '1' ? d.added : d.removed).push(r.date);
  });

  return { routes, trips, stopTimes, stops, shapeRaw, notes, calendar, dates, feedStart, feedEnd, nonZeroSeconds, totalTimes };
}

// ---- nota.txt pattern parser (plan step 5.4) -------------------------------

function foldNote(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// Anonymous Gregorian algorithm for Easter Sunday (month 1..12, day 1..31).
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function fmtYmdUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function barcelonaLocalHolidays(year) {
  const easter = easterSunday(year);
  const pentecostMon = new Date(easter.getTime() + 50 * 86400000); // Segona Pasqua
  return [fmtYmdUTC(pentecostMon), `${year}0924`]; // La Mercè
}

const MARKET_WEEKDAYS = [
  ['dilluns', 0],
  ['dimarts', 1],
  ['dimecres', 2],
  ['dijous', 3],
  ['divendres', 4],
  ['dissabte', 5],
  ['diumenge', 6],
];

/**
 * Parses known Generalitat nota.txt patterns (report 09 §2.1, plan step 5.4)
 * into structured calendar/behaviour metadata while ALWAYS keeping the
 * original text in `raw`.
 */
function parseGencatNote(text, years = []) {
  const raw = String(text || '').trim();
  const f = foldNote(raw);
  const added = new Set();
  const removed = new Set();
  const tags = new Set();
  const marketWeekdays = [];
  let requestStop = false;

  const yrs = [...new Set(years.map(Number).filter((y) => y >= 2000 && y <= 2100))].sort();

  // 1. Festive nights ("I nits de la Revetlla de Sant Joan, la de Cap d'Any i la de la Festivitat de la Mercè")
  if (/\bnits?\b/.test(f) || /\brevetlla\b/.test(f)) {
    let matchedNight = false;
    if (f.includes('sant joan')) {
      matchedNight = true;
      for (const y of yrs) added.add(`${y}0623`);
    }
    if (f.includes("cap d'any") || f.includes('cap d any')) {
      matchedNight = true;
      for (const y of yrs) added.add(`${y}1231`);
    }
    if (f.includes('merce')) {
      matchedNight = true;
      for (const y of yrs) added.add(`${y}0923`);
    }
    if (matchedNight) tags.add('festive_nights');
  }

  // 2. Local holidays ("Excepte festes locals a Barcelona", "I festes locals a Barcelona")
  if (/festes?\s+locals?/.test(f)) {
    const isExcept = /\bexcepte\b|\bno\s+circula\b|\bmenys\b/.test(f);
    const isBcn = /\bbarcelona\b/.test(f);
    tags.add(isExcept ? 'except_local_holidays' : 'include_local_holidays');
    if (isBcn) {
      for (const y of yrs) {
        for (const d of barcelonaLocalHolidays(y)) {
          if (isExcept) removed.add(d);
          else added.add(d);
        }
      }
    }
  }

  // 3. Request / demand-responsive stops
  if (/\ba\s+la\s+demanda\b|\breserva\s+previa\b|\btad\s*cat\b|\bsagales\s+on\s+demand\b|\bclic\.cat\b|\bparada\s+a\s+demanda\b/.test(f)) {
    requestStop = true;
    tags.add('on_demand');
  }

  // 4. Market days ("dia de mercat", "dies de mercat", "dimecres de mercat")
  if (/\bde\s+mercat\b|\bmercat\s+setmanal\b/.test(f)) {
    tags.add('market_day');
    for (const [name, idx] of MARKET_WEEKDAYS) {
      if (new RegExp(`\\b${name}\\b`).test(f)) marketWeekdays.push(idx);
    }
  }

  // 5. Academic / school calendar
  if (/\bdies?\s+lectius?\b|\btransport\s+escolar\b|\buab\b/.test(f)) {
    tags.add('academic_calendar');
  }

  const out = { raw };
  if (added.size) out.added = [...added].sort();
  if (removed.size) out.removed = [...removed].sort();
  if (requestStop) out.requestStop = true;
  if (marketWeekdays.length) out.marketWeekdays = marketWeekdays;
  if (tags.size) out.tags = [...tags].sort();
  return out;
}

function feedYears(feedStart, feedEnd) {
  const y0 = Number(String(feedStart || '').slice(0, 4));
  const y1 = Number(String(feedEnd || '').slice(0, 4));
  if (!Number.isFinite(y0) || y0 < 2000) return [];
  const end = Number.isFinite(y1) && y1 >= y0 ? y1 : y0;
  const yrs = [];
  for (let y = y0; y <= end; y++) yrs.push(y);
  return yrs;
}

function buildLines(g, tolerance) {
  const years = feedYears(g.feedStart, g.feedEnd);
  const lines = [];
  const usedServices = new Set();
  let shapePointsRaw = 0;
  let shapePointsKept = 0;
  for (const [routeId, code] of LINES.map((l) => [l[0], l[1]])) {
    const r = g.routes.get(routeId);
    const byDir = new Map();
    for (const t of g.trips.values()) {
      if (t.route_id !== routeId) continue;
      const d = t.direction_id === '' ? '0' : t.direction_id;
      if (!byDir.has(d)) byDir.set(d, []);
      byDir.get(d).push(t);
    }
    const directions = [];
    for (const dirId of [...byDir.keys()].sort()) {
      const dtrips = byDir.get(dirId).filter((t) => g.stopTimes.has(t.trip_id));
      // distinct stop patterns, most used first
      const patMap = new Map();
      for (const t of dtrips) {
        const key = g.stopTimes.get(t.trip_id).map((s) => s.stop).join('|');
        let p = patMap.get(key);
        if (!p) patMap.set(key, p = { key, ids: key.split('|'), n: 0 });
        p.n++;
      }
      const pats = [...patMap.values()].sort((a, b) => b.n - a.n || b.ids.length - a.ids.length);
      const stopList = [];
      const stopIdx = new Map();
      for (const p of pats) {
        for (const id of p.ids) {
          if (!stopIdx.has(id)) { stopIdx.set(id, stopList.length); stopList.push(g.stops.get(id)); }
        }
      }
      const patIdx = new Map(pats.map((p, i) => [p.key, i]));
      const shapes = [];
      const shapeKeyIdx = new Map();
      const shapeOfId = new Map();
      const shapeFor = (sid) => {
        if (!sid) return null;
        if (shapeOfId.has(sid)) return shapeOfId.get(sid);
        const raw = (g.shapeRaw.get(sid) || []).sort((a, b) => a[0] - b[0]).map((x) => [x[1], x[2]]);
        shapePointsRaw += raw.length;
        const simp = simplify(raw, tolerance).map(([la, lo]) => [round(la, 5), round(lo, 5)]);
        const key = JSON.stringify(simp);
        let i = shapeKeyIdx.get(key);
        if (i === undefined) { i = shapes.length; shapes.push(simp); shapeKeyIdx.set(key, i); shapePointsKept += simp.length; }
        shapeOfId.set(sid, i);
        return i;
      };
      const outTrips = dtrips.map((t) => {
        const st = g.stopTimes.get(t.trip_id);
        const key = st.map((s) => s.stop).join('|');
        usedServices.add(t.service_id);
        const o = { id: Number(t.trip_id), service: Number(t.service_id), pattern: patIdx.get(key), shape: shapeFor(t.shape_id), times: st.map((s) => s.dep) };
        const note = g.notes.get(t.trip_id);
        if (note) {
          o.note = note;
          const parsed = parseGencatNote(note, years);
          if (parsed.added) o.noteAdded = parsed.added;
          if (parsed.removed) o.noteRemoved = parsed.removed;
          if (parsed.requestStop) o.requestStop = true;
          if (parsed.marketWeekdays) o.marketWeekdays = parsed.marketWeekdays;
          if (parsed.tags) o.noteTags = parsed.tags;
        }
        return o;
      }).sort((a, b) => (a.times[0] < b.times[0] ? -1 : a.times[0] > b.times[0] ? 1 : a.id - b.id));
      directions.push({
        directionId: Number(dirId),
        headsign: '', // filled below
        stops: stopList,
        patterns: pats.map((p) => ({ trips: p.n, stops: p.ids.map((id) => stopIdx.get(id)) })),
        shapes,
        trips: outTrips,
      });
    }
    for (const d of directions) {
      const first = d.stops[d.patterns[0].stops[0]];
      const last = d.stops[d.patterns[0].stops[d.patterns[0].stops.length - 1]];
      d.headsign = `${first.name} - ${last.name}`;
    }
    lines.push({ code: DISPLAY_CODE[code] || code, gtfsCode: code, routeId, name: r.name, directions });
  }
  return { lines, usedServices, shapePointsRaw, shapePointsKept };
}

function buildServices(g, used) {
  const out = {};
  for (const id of [...used].sort((a, b) => Number(a) - Number(b))) {
    const c = g.calendar.get(id);
    const d = g.dates.get(id) || { added: [], removed: [] };
    out[id] = {
      name: c ? c.name : '',
      days: c ? ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((k) => Number(c[k])) : [0, 0, 0, 0, 0, 0, 0],
      start: c ? c.start_date : '',
      end: c ? c.end_date : '',
      added: d.added.sort(),
      removed: d.removed.sort(),
    };
  }
  return out;
}

// ---- moventis.es crosswalk -------------------------------------------------

async function fetchMoventisRoutes(opts) {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }).replace(/-/g, '');
  const result = [];
  let lastRequest = 0;
  for (const [, code, mov] of LINES) {
    const cacheFile = opts.cache ? path.join(opts.cache, `GetTrayectos_${mov}.json`) : null;
    let body;
    if (cacheFile && fs.existsSync(cacheFile)) body = fs.readFileSync(cacheFile, 'utf8');
    else {
      const wait = lastRequest + MOVENTIS_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequest = Date.now();
      const url = `${MOVENTIS_BASE}/api/json/GetTrayectos/${mov}/${today}`;
      console.log(`  GET GetTrayectos/${mov} (${code})`);
      const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } });
      lastRequest = Date.now();
      if (!res.ok) throw new Error(`moventis.es line ${mov}: HTTP ${res.status}`);
      body = await res.text();
      if (cacheFile) { fs.mkdirSync(opts.cache, { recursive: true }); fs.writeFileSync(cacheFile, body); }
    }
    const rows = JSON.parse(body);
    if (!Array.isArray(rows)) throw new Error(`moventis.es line ${mov}: unexpected answer`);
    for (const t of rows) {
      for (const d of t.TrayectosDet || []) {
        const p = d.Parada || {};
        const lat = Number(p.LATITUD);
        const lon = Number(p.LONGITUD);
        if (!p.ID_PARADA || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        result.push({ line: code, lineId: mov, id: String(p.ID_PARADA), code: String(p.COD_PARADA || '').trim(), name: String(p.DESC_PARADA || '').trim(), lat, lon });
      }
    }
  }
  return result;
}

function buildCrosswalk(movStops, g) {
  // candidate GTFS stops: those the seven lines use
  const gtfs = [...g.stops.values()];
  const byCode = new Map();
  for (const s of gtfs) {
    if (!byCode.has(s.code)) byCode.set(s.code, []);
    byCode.get(s.code).push(s);
  }
  const agg = new Map();
  for (const m of movStops) {
    let a = agg.get(m.id);
    if (!a) agg.set(m.id, a = { id: m.id, code: m.code, name: m.name, lat: m.lat, lon: m.lon, lines: new Set() });
    a.lines.add(m.line);
  }
  const stops = {};
  const stats = { total: agg.size, stop_code: 0, proximity: 0, unmatched: 0 };
  const unmatched = [];
  const usedGtfs = new Set();
  const ids = [...agg.keys()].sort((a, b) => Number(a) - Number(b));
  const pending = [];
  for (const id of ids) {
    const a = agg.get(id);
    const cands = byCode.get(a.code) || [];
    let best = null;
    for (const c of cands) {
      const d = distM(a.lat, a.lon, c.lat, c.lon);
      if (!best || d < best.d) best = { c, d };
    }
    if (best && best.d < 300) {
      stats.stop_code++;
      usedGtfs.add(best.c.id);
      stops[id] = { code: a.code, name: a.name, gtfs: best.c.id, method: 'stop_code', distM: Math.round(best.d), lines: [...a.lines] };
    } else pending.push(a);
  }
  for (const a of pending) {
    let best = null;
    for (const c of gtfs) {
      const d = distM(a.lat, a.lon, c.lat, c.lon);
      if (d >= 60) continue;
      const sim = nameSimilarity(a.name, c.name);
      const score = sim - d / 1000;
      if (!best || score > best.score) best = { c, d, sim, score };
    }
    if (best && best.sim >= 0.3) {
      stats.proximity++;
      stops[a.id] = { code: a.code, name: a.name, gtfs: best.c.id, method: 'proximity+name', distM: Math.round(best.d), nameSimilarity: round(best.sim, 2), lines: [...a.lines] };
    } else {
      stats.unmatched++;
      stops[a.id] = { code: a.code, name: a.name, gtfs: null, method: 'unmatched', lines: [...a.lines] };
      unmatched.push({ id: a.id, ...stops[a.id], nearest: best ? { gtfs: best.c.id, name: best.c.name, distM: Math.round(best.d) } : null });
    }
  }
  const perLine = {};
  for (const [, code] of LINES) {
    const mine = ids.filter((id) => agg.get(id).lines.has(code));
    perLine[DISPLAY_CODE[code] || code] = { moventisStops: mine.length, matched: mine.filter((id) => stops[id].gtfs).length };
  }
  return { stops, stats, unmatched, perLine };
}

// ---- main ------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(opts.zip ? `Reading ${opts.zip}` : `Downloading ${ZIP_URL}`);
  const z = await loadZip(opts);
  const zip = zipEntries(z.buf);
  console.log(`  ${(z.buf.length / 1048576).toFixed(1)} MB, Last-Modified ${z.lastModified}`);
  const g = cutLines(zip);
  const { lines, usedServices, shapePointsRaw, shapePointsKept } = buildLines(g, opts.tolerance);
  const services = buildServices(g, usedServices);

  let crosswalk = null;
  if (opts.skipMoventis) {
    if (fs.existsSync(opts.out)) crosswalk = JSON.parse(fs.readFileSync(opts.out, 'utf8')).crosswalk;
  } else {
    console.log('Fetching moventis.es stops (one request every 11.5 s)');
    const mov = await fetchMoventisRoutes(opts);
    const cw = buildCrosswalk(mov, g);
    crosswalk = {
      source: `${MOVENTIS_BASE}/api/json/GetTrayectos/{ID_LINEA}/{YYYYMMDD}`,
      method: 'stop_code == COD_PARADA (same place within 300 m), then GTFS stops within 60 m with a similar name; the rest are listed as unmatched',
      lineIds: Object.fromEntries(LINES.map(([, code, id]) => [DISPLAY_CODE[code] || code, id])),
      stats: cw.stats,
      perLine: cw.perLine,
      stops: cw.stops,
    };
    console.log('Crosswalk:', JSON.stringify(cw.stats), JSON.stringify(cw.perLine));
    for (const u of cw.unmatched) console.log(`  unmatched ${u.id} cod ${u.code} "${u.name}" lines ${u.lines.join(',')}${u.nearest ? ` nearest ${u.nearest.gtfs} "${u.nearest.name}" ${u.nearest.distM} m` : ''}`);
  }

  const data = {
    feed: {
      source: z.source,
      lastModified: z.lastModified,
      calendarRange: { start: g.feedStart, end: g.feedEnd },
      licence: "Llicència oberta d'ús d'informació – Catalunya",
      licenceUrl: 'https://web.gencat.cat/ca/generalitat/dades-indicadors/dades-obertes/llicencies',
      attribution: 'Generalitat de Catalunya',
      operator: 'Empresa Casas, SA (Moventis)',
      notes: [
        'Times are the published departure_time of each stop, "HH:MM:SS", exactly as in stop_times.txt; hours may exceed 23 (service past midnight).',
        `Seconds are not zero in the source (${g.nonZeroSeconds} of ${g.totalTimes} times of these lines): they come from a speed/distance export, not from timepoints. Kept as published.`,
        'Header names and values of every file are trimmed (the feed has had leading spaces in the stop_times.txt header).',
        `Shapes are [lat, lon] pairs rounded to 5 decimals and simplified with Douglas-Peucker at ${opts.tolerance} m (${shapePointsRaw} source points -> ${shapePointsKept}).`,
        'Rider-facing line codes come from the leading "(C10)" of route_long_name; route_short_name is an internal id.',
        'A trip "note" is the text of nota.txt for that trip (non-standard file); show it as published.',
        'directions[].stops lists the most used stop pattern first, then stops only other patterns use; patterns[].stops and trips[].pattern index into it.',
      ],
    },
    lines,
    services,
    crosswalk,
  };
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  const text = formatDataJson(data);
  fs.writeFileSync(opts.out, text);
  const trips = lines.reduce((n, l) => n + l.directions.reduce((m, d) => m + d.trips.length, 0), 0);
  console.log(`Wrote ${path.relative(ROOT, opts.out)}: ${(text.length / 1024).toFixed(0)} KB, ${text.split('\n').length - 1} lines, ${lines.length} lines, ${trips} trips, ${Object.keys(services).length} services`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { zipEntries, eachRow, simplify, nameSimilarity, parseGencatNote };
