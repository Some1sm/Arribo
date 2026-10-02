/**
 * scripts/stop_route_distances.js
 *
 * Rewrites the per-stop distance and time fields of both timetable files from
 * data that exists:
 *  - segmentMeters / cumulativeMeters: distance ALONG the drawn route
 *    (data/cities/mataro/mataro_routes_full.json), each stop projected onto the
 *    polyline in order. They were straight lines between stops, 8-28 % shorter
 *    than the route (L1 Rodalies -> Hospital: 6,054 m against a 7,749 m route).
 *  - travelSec / travelMinutes: the published weekday median offset from the
 *    origin (dayStopTravelSec, else stopTravelSecMap). They were an estimate at
 *    8 m/s plus 25 s per stop (67 s to Ronda Barceló; the timetable says 120 s).
 *  - dwellSec: removed. It was 25 s times the stop index, not a measurement.
 * Nothing at runtime reads these fields; this keeps them from being read as facts.
 * Both files are written with the same formatting they already have, so only
 * these fields change.
 *
 * USAGE
 *   node scripts/stop_route_distances.js           # rewrite both files
 *   node scripts/stop_route_distances.js --check   # report only; exit 1 if a file would change
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ROUTES_PATH = path.join(ROOT, 'data', 'cities', 'mataro', 'mataro_routes_full.json');
const LEGACY_PATH = path.join(ROOT, 'src', 'data', 'mataro_schedules.json');
const SEASONS_PATH = path.join(ROOT, 'src', 'data', 'mataro_schedules.seasons.json');

const EARTH_M = 6371000;
const RAD = Math.PI / 180;
// A stop is "on" the route within this distance; the nearest pass after it is taken.
const ON_ROUTE_M = 35;
const LOCAL_SEARCH_M = 250;

function haversine(a, b) {
  const dLat = (b[0] - a[0]) * RAD;
  const dLon = (b[1] - a[1]) * RAD;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(x));
}

/** Distance along `coords` ([[lat, lon]]) of each stop, projected in order. */
function alongRoute(coords, stops) {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
  const lat0 = coords[0][0] * RAD;
  const xy = ([lat, lon]) => [lon * RAD * Math.cos(lat0) * EARTH_M, lat * RAD * EARTH_M];
  const pts = coords.map(xy);
  const project = (p, s) => {
    const [ax, ay] = pts[s];
    const [bx, by] = pts[s + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const tt = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2)) : 0;
    const qx = ax + tt * dx;
    const qy = ay + tt * dy;
    return { d: Math.hypot(p[0] - qx, p[1] - qy), along: cum[s] + tt * (cum[s + 1] - cum[s]), s };
  };
  let fromSeg = 0;
  return stops.map(stop => {
    const p = xy([Number(stop.lat), Number(stop.lon)]);
    let best = null;
    let firstHit = null;
    for (let s = fromSeg; s < pts.length - 1; s++) {
      const c = project(p, s);
      if (firstHit === null && c.d <= ON_ROUTE_M) firstHit = c;
      if (firstHit !== null && c.along > firstHit.along + LOCAL_SEARCH_M) break;
      if (!best || c.d < best.d) best = c;
    }
    fromSeg = best.s;
    return best;
  });
}

function formatSeasons(obj) {
  // Same as formatJsonWithCompactArrays in scripts/scrape_maresme_timetables.js.
  return JSON.stringify(obj, null, 2).replace(/"s": \[\s+([\s\S]*?)\s+\]/g, (_, inner) => `"s": [${inner.split(/,\s*/).map(x => x.trim()).join(', ')}]`);
}

function rewriteGrid(grid, routes, report) {
  for (const [lineId, line] of Object.entries(grid)) {
    if (lineId === '_meta' || !line || !line.directions) continue;
    for (const [dirKey, dir] of Object.entries(line.directions)) {
      const route = Object.values(routes[lineId] || {}).find(r => String(r.id) === String(dir.pathId || dirKey));
      if (!route || !Array.isArray(dir.stops) || dir.stops.length < 2) continue;
      const coords = route.coords.map(c => [Number(c.Latitude), Number(c.Longitude)]);
      const proj = alongRoute(coords, dir.stops);
      const offsets = (dir.dayStopTravelSec && dir.dayStopTravelSec.weekday) || dir.stopTravelSecMap || {};
      dir.stops.forEach((stop, i) => {
        const cumulative = Math.round(proj[i].along - proj[0].along);
        const segment = i === 0 ? 0 : Math.round(proj[i].along - proj[i - 1].along);
        const straight = i === 0 ? 0 : haversine([dir.stops[i - 1].lat, dir.stops[i - 1].lon], [stop.lat, stop.lon]);
        if (i > 0 && (segment < straight * 0.95 - 10 || segment > straight * 4 + 400)) {
          report.push(`L${lineId} ${dirKey} ${dir.stops[i - 1].name} -> ${stop.name}: ${segment} m along the route, ${Math.round(straight)} m straight`);
        }
        if (proj[i].d > 120) report.push(`L${lineId} ${dirKey} ${stop.name}: ${Math.round(proj[i].d)} m from the route`);
        stop.segmentMeters = segment;
        stop.cumulativeMeters = cumulative;
        delete stop.dwellSec;
        const travel = offsets[String(stop.id)];
        stop.travelSec = Number.isFinite(travel) ? travel : null;
        stop.travelMinutes = Number.isFinite(travel) ? Math.round(travel / 60) : null;
      });
    }
  }
}

function main() {
  const check = process.argv.includes('--check');
  const routes = JSON.parse(fs.readFileSync(ROUTES_PATH, 'utf8'));
  const report = [];
  let changed = 0;

  const legacyRaw = fs.readFileSync(LEGACY_PATH, 'utf8');
  const legacy = JSON.parse(legacyRaw);
  rewriteGrid(legacy, routes, report);
  const legacyOut = JSON.stringify(legacy, null, 2) + '\n';

  const seasonsRaw = fs.readFileSync(SEASONS_PATH, 'utf8');
  const seasons = JSON.parse(seasonsRaw);
  for (const grid of Object.values(seasons.seasons || {})) rewriteGrid(grid, routes, report);
  const seasonsOut = formatSeasons(seasons) + '\n';

  for (const [file, before, after] of [[LEGACY_PATH, legacyRaw, legacyOut], [SEASONS_PATH, seasonsRaw, seasonsOut]]) {
    // A Windows checkout (core.autocrlf) holds these files with CRLF: compare
    // the content, and write back in the file's own line endings.
    if (before.replace(/\r\n/g, '\n') === after) continue;
    changed++;
    if (!check) fs.writeFileSync(file, before.includes('\r\n') ? after.replace(/\n/g, '\r\n') : after);
    console.log(`${check ? 'would update' : 'updated'} ${path.relative(ROOT, file)}`);
  }
  for (const line of [...new Set(report)]) console.log(`  note: ${line}`);
  if (!changed) console.log('per-stop distances and times already match the route and the timetable');
  if (check && changed) process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { alongRoute, haversine };
