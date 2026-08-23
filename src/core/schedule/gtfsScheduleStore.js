// GTFS Schedule Store
// ===================
// Per-route real GTFS schedules extracted from data/atm_gtfs, cached as one
// JSON file per route (data/cache/gtfs_sched/<routeId>.json) so trackers can
// load only the route they need (worker-heap friendly, 256MB limit).
//
// Built in a single chunked scan of stop_times.txt (~220MB, ~2-4s, once).
// Consumers: ambTracker (AMB_* routes), rodaliesTracker (ROD_* trains),
// sagalesTracker (GEN_* night/interurban routes).

const fs = require('fs');
const path = require('path');

const CACHE_VERSION = 1;
const CACHE_DIR = path.join(__dirname, '..', '..', '..', 'data', 'cache', 'gtfs_sched');
const ATM_DIR = path.join(__dirname, '..', '..', '..', 'data', 'atm_gtfs');
const LRU_MAX = 40;

// Sagalés line code -> GTFS route_id (resolved from routes.txt short names).
// '603' has no route in the current feed — trackers keep their legacy
// fallback for it.
const SAGALES_ROUTE_IDS = {
  n82: 'GEN_0115',
  n83: 'GEN_1819',
  n70: 'GEN_0082',
  n71: 'GEN_0095',
  n73: 'GEN_0125'
};

const lru = new Map(); // routeId -> schedule

function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function isTargetRoute(routeId) {
  return routeId.startsWith('AMB_') || routeId.startsWith('ROD_') ||
    Object.values(SAGALES_ROUTE_IDS).includes(routeId);
}

/**
 * Builds per-route schedule files for all target routes. Safe to call
 * repeatedly: a version-keyed marker short-circuits subsequent calls.
 * Returns { built: boolean, routes: number, reason?: string }.
 */
function buildAll(force = false) {
  const markerPath = path.join(CACHE_DIR, '_built.json');
  if (!force && fs.existsSync(markerPath)) {
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      if (marker.version === CACHE_VERSION) return { built: false, routes: marker.routes || 0 };
    } catch (_) {}
  }

  const tripsPath = path.join(ATM_DIR, 'trips.txt');
  const stopTimesPath = path.join(ATM_DIR, 'stop_times.txt');
  const routesPath = path.join(ATM_DIR, 'routes.txt');
  if (!fs.existsSync(tripsPath) || !fs.existsSync(stopTimesPath) || !fs.existsSync(routesPath)) {
    return { built: false, routes: 0, reason: 'feed-missing' };
  }

  // routes.txt: routeId -> short name (code)
  const rLines = fs.readFileSync(routesPath, 'utf8').split('\n').filter(l => l.trim());
  const rH = {};
  parseCsvLine(rLines[0]).forEach((nm, i) => { rH[nm] = i; });
  const codeByRoute = new Map();
  for (let i = 1; i < rLines.length; i++) {
    const p = parseCsvLine(rLines[i]);
    if (p[rH.route_id]) codeByRoute.set(p[rH.route_id], p[rH.route_short_name] || '');
  }

  // trips.txt: target trips grouped per route
  const tLines = fs.readFileSync(tripsPath, 'utf8').split('\n').filter(l => l.trim());
  const tH = {};
  parseCsvLine(tLines[0]).forEach((nm, i) => { tH[nm] = i; });
  const routeTrips = new Map(); // routeId -> Map(tripId -> {serviceId, dirId})
  const targetTripIds = new Set();
  for (let i = 1; i < tLines.length; i++) {
    const p = parseCsvLine(tLines[i]);
    const routeId = p[tH.route_id];
    if (!routeId || !isTargetRoute(routeId)) continue;
    const tripId = p[tH.trip_id];
    if (!tripId) continue;
    if (!routeTrips.has(routeId)) routeTrips.set(routeId, new Map());
    routeTrips.get(routeId).set(tripId, {
      serviceId: p[tH.service_id] || '',
      dirId: String(p[tH.direction_id] || '0')
    });
    targetTripIds.add(tripId);
  }

  // code -> [routeId] index for resolveRouteId()
  const codeIndex = {};
  for (const [routeId, tm] of routeTrips) {
    const code = (codeByRoute.get(routeId) || '').toUpperCase();
    if (!code) continue;
    if (!codeIndex[code]) codeIndex[code] = [];
    codeIndex[code].push(routeId);
  }

  // stop_times.txt: chunked sync scan
  const stHeader = parseCsvLine(fs.readFileSync(stopTimesPath, 'utf8').split('\n')[0]);
  const stI = {};
  stHeader.forEach((nm, i) => { stI[nm] = i; });
  const fd = fs.openSync(stopTimesPath, 'r');
  const buf = Buffer.alloc(1 << 22);
  let leftover = '', bytesRead;
  const byTrip = new Map(); // tripId -> [{stopId, seq, arr, dep}]
  try {
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      const lines = (leftover + buf.toString('utf8', 0, bytesRead)).split('\n');
      leftover = lines.pop();
      for (const l of lines) {
        const p = l.split(',');
        const tripId = p[stI.trip_id];
        if (!tripId || !targetTripIds.has(tripId)) continue;
        if (!byTrip.has(tripId)) byTrip.set(tripId, []);
        byTrip.get(tripId).push({
          stopId: p[stI.stop_id] || '',
          seq: parseInt(p[stI.stop_sequence], 10) || 0,
          arr: p[stI.arrival_time] || '',
          dep: p[stI.departure_time] || ''
        });
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  // Write one file per route
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  let written = 0;
  for (const [routeId, tm] of routeTrips) {
    const dir0 = [], dir1 = [];
    for (const [tripId, meta] of tm) {
      const rows = (byTrip.get(tripId) || []).sort((a, b) => a.seq - b.seq);
      if (rows.length < 2) continue;
      const stops = rows.map(r => {
        const arr = (r.arr || r.dep || '').trim();
        const dep = (r.dep || r.arr || '').trim();
        return { stopId: r.stopId, seq: r.seq, arr, dep };
      });
      const trip = { tripId, serviceId: meta.serviceId, dirId: meta.dirId, stops };
      (meta.dirId === '1' ? dir1 : dir0).push(trip);
    }
    const sortTrips = (list) => list.sort((a, b) => (a.stops[0].dep || '').localeCompare(b.stops[0].dep || ''));
    sortTrips(dir0); sortTrips(dir1);
    const payload = { version: CACHE_VERSION, routeId, code: codeByRoute.get(routeId) || '', dir0, dir1 };
    const tmp = path.join(CACHE_DIR, routeId + '.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, path.join(CACHE_DIR, routeId + '.json'));
    written++;
  }

  fs.writeFileSync(markerPath, JSON.stringify({ version: CACHE_VERSION, routes: written, builtAt: new Date().toISOString() }), 'utf8');
  fs.writeFileSync(path.join(CACHE_DIR, '_index.json'), JSON.stringify(codeIndex), 'utf8');
  console.log(`[GtfsScheduleStore] 📖 Built real schedules for ${written} routes (${[...routeTrips.keys()].filter(r => r.startsWith('AMB_')).length} AMB, ${[...routeTrips.keys()].filter(r => r.startsWith('ROD_')).length} ROD).`);
  return { built: true, routes: written };
}

/**
 * Returns the real schedule for a routeId:
 * { routeId, code, dir0: [trips], dir1: [trips] } or null.
 * Trips: { tripId, serviceId, dirId, stops: [{stopId, seq, arr, dep}] }.
 */
function getRouteSchedule(routeId) {
  if (!routeId) return null;
  if (lru.has(routeId)) {
    // LRU refresh
    const v = lru.get(routeId);
    lru.delete(routeId);
    lru.set(routeId, v);
    return v;
  }
  const file = path.join(CACHE_DIR, routeId + '.json');
  if (!fs.existsSync(file)) return null;
  try {
    const sched = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (sched.version !== CACHE_VERSION) return null;
    lru.set(routeId, sched);
    if (lru.size > LRU_MAX) {
      const oldest = lru.keys().next().value;
      lru.delete(oldest);
    }
    return sched;
  } catch (_) {
    return null;
  }
}

/**
 * Resolves a line code to a routeId among target routes.
 * Returns the routeId or null. AMB codes are matched within the AMB_ prefix;
 * Sagalés codes via the fixed mapping.
 */
function resolveRouteId(code, agencyPrefix = 'AMB_') {
  const codeNorm = String(code || '').toUpperCase().trim();
  if (SAGALES_ROUTE_IDS[codeNorm]) return SAGALES_ROUTE_IDS[codeNorm];
  const idxFile = path.join(CACHE_DIR, '_index.json');
  try {
    const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
    const ids = idx[codeNorm] || [];
    const prefixed = ids.find(id => id.startsWith(agencyPrefix));
    return prefixed || ids[0] || null;
  } catch (_) {
    return null;
  }
}

module.exports = { buildAll, getRouteSchedule, resolveRouteId, SAGALES_ROUTE_IDS };
