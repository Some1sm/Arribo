/**
 * routeStitcher.js — Fills road-geometry gaps in GTFS shape polylines.
 *
 * Problem: canonical GTFS shapes sometimes omit urban terminus deviations
 * (e.g. e11.1's GEN_24318 ends at the Mataró city boundary while its last
 * three stops are in the city centre). Drawing that shape raw leaves stops
 * disconnected; falling back to stop-to-stop chords ignores roads entirely.
 *
 * Solution: shapes.db contains thousands of sibling variants (often from the
 * same operator family). When the primary shape leaves stops uncovered, scan
 * the DB for a sibling shape that DOES pass near them, orient it correctly,
 * trim it to the divergence point and splice it onto the primary polyline.
 *
 * All results are memoised per (primary shape id + stop signature) so the
 * expensive DB scan runs once per line/direction, not per request.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { fetchRoadRoute } = require('./osrmClient');
const { composeRouteWithStops } = require('./geoEngine');

const dbHandles = new Map();   // dbPath -> DatabaseSync
const coordCache = new Map(); // shapeId -> [[lat,lon]] (only shapes actually selected)
const resultCache = new Map(); // cacheKey -> {coords, stitched, source} | null
const RESULT_CACHE_MAX = 300;

function getDb(dbPath) {
  if (!dbHandles.has(dbPath)) {
    if (!fs.existsSync(dbPath)) return null;
    try {
      dbHandles.set(dbPath, new DatabaseSync(dbPath));
    } catch (e) {
      console.warn(`[RouteStitcher] failed to open ${dbPath}:`, e.message);
      return null;
    }
  }
  return dbHandles.get(dbPath);
}

function distM(a, b) {
  const dLat = (a[0] - b[0]) * 111320;
  const dLon = (a[1] - b[1]) * 111320 * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
  return Math.sqrt(dLat * dLat + dLon * dLon);
}

/** Nearest vertex of `coords` to point p → {idx, dist}. */
function nearestVertex(p, coords) {
  let idx = -1, dist = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = distM(p, coords[i]);
    if (d < dist) { dist = d; idx = i; }
  }
  return { idx, dist };
}

/**
 * Stitch road geometry so every stop sits on the drawn polyline.
 *
 * @param {object} params
 * @param {Array<[number,number]>} params.coords      primary road-shape polyline
 * @param {Array<{lat:number, lon:number, id?:string}>} params.stops ordered stops
 * @param {string}            params.dbPath           path to shapes.db
 * @param {string}            [params.primaryShapeId] id used as part of the cache key
 * @param {number}            [params.thresholdM=150] coverage tolerance
 * @returns {{coords:Array<[number,number]>, stitched:number, source:string}|null}
 *          null when nothing needed stitching or no candidate was found.
 */
function stitchShapeGaps({ coords, stops, dbPath, primaryShapeId = '', thresholdM = 150 }) {
  if (!Array.isArray(coords) || coords.length < 2 || !Array.isArray(stops) || stops.length === 0) return null;

  const sig = stops.map(s => `${s.id || `${s.lat.toFixed(5)},${s.lon.toFixed(5)}`}`).join(';');
  const cacheKey = `${primaryShapeId}|${sig}`;
  if (resultCache.has(cacheKey)) return resultCache.get(cacheKey);

  const result = computeStitch(coords, stops, dbPath, primaryShapeId, thresholdM, cacheKey);
  resultCache.set(cacheKey, result);
  if (resultCache.size > RESULT_CACHE_MAX) {
    resultCache.delete(resultCache.keys().next().value);
  }
  return result;
}

function computeStitch(coords, stops, dbPath, primaryShapeId, thresholdM, cacheKey) {
  // 1. Project stops onto the primary shape.
  const proj = stops.map(s => nearestVertex([s.lat, s.lon], coords));
  const uncovered = [];
  for (let i = 0; i < stops.length; i++) {
    if (proj[i].dist > thresholdM) uncovered.push({ seq: i, stop: stops[i] });
  }
  if (uncovered.length === 0) return null;

  // Only head/tail runs are supported; isolated mid-route gaps fall back to
  // the caller's simpler strategies.
  let leadEnd = 0;
  while (leadEnd < uncovered.length && uncovered[leadEnd].seq === leadEnd) leadEnd++;
  let trailCount = 0;
  for (let i = stops.length - 1; i >= 0 && proj[i].dist > thresholdM; i--) trailCount++;
  const hasTrailing = trailCount > 0;
  const hasLeading = leadEnd > 0;
  if (!hasTrailing && !hasLeading) return null;

  // 2. Scan shapes.db for a sibling covering the uncovered stops.
  const db = getDb(dbPath);
  if (!db) return null;

  const gapStops = hasTrailing
    ? stops.slice(stops.length - trailCount)
    : stops.slice(0, leadEnd);
  const refPoint = hasTrailing
    ? coords[proj[Math.max(0, stops.length - trailCount - 1)]?.idx ?? coords.length - 1] || coords[coords.length - 1]
    : coords[proj[leadEnd]?.idx ?? 0];

  let best = null; // {id, orientedTail, score}
  let rows;
  try {
    rows = db.prepare('SELECT shape_id, coords FROM shapes').all();
  } catch (e) {
    console.warn('[RouteStitcher] shapes.db query failed:', e.message);
    return null;
  }

  for (const row of rows) {
    if (row.shape_id === primaryShapeId) continue;
    let c;
    try { c = JSON.parse(row.coords); } catch (_) { continue; }
    if (!Array.isArray(c) || c.length < 5) continue;

    // Cheap bbox prefilter: candidate must reach every gap stop.
    let ok = true;
    for (const s of gapStops) {
      let inReach = false;
      for (const v of c) {
        if (Math.abs(v[0] - s.lat) * 111320 < thresholdM &&
            Math.abs(v[1] - s.lon) * 111320 * Math.cos(s.lat * Math.PI / 180) < thresholdM) { inReach = true; break; }
      }
      if (!inReach) { ok = false; break; }
    }
    if (!ok) continue;

    // Try both orientations; require full coverage of gap stops and pick the
    // best (lowest total gap-stop distance).
    for (const oriented of [c, [...c].reverse()]) {
      // Trim from the vertex nearest the divergence reference point.
      const j = nearestVertex(refPoint, oriented).idx;
      const tail = oriented.slice(j);
      if (tail.length < 3) continue;
      let score = 0, coversAll = true;
      for (const s of gapStops) {
        const d = covDist(tail, s);
        if (d > thresholdM) { coversAll = false; break; }
        score += d;
      }
      if (!coversAll) continue;
      if (!best || score < best.score) best = { id: row.shape_id, oriented, score };
    }
  }

  if (!best) return null;

  // 3. Merge.
  let merged;
  let stitchedCount;
  if (hasTrailing) {
    const lastCoveredIdx = stops.length - trailCount - 1;
    const headCut = lastCoveredIdx >= 0 ? proj[lastCoveredIdx].idx : coords.length - 1;
    const head = coords.slice(0, Math.min(headCut + 1, coords.length));
    // Tail: orient candidate so it starts near the head's cut point.
    let tail = best.oriented;
    const jj = nearestVertex(head[head.length - 1] || coords[coords.length - 1], tail).idx;
    tail = tail.slice(jj);
    merged = head.concat(tail);
    stitchedCount = trailCount;
  } else {
    // Leading run: prepend candidate legs before the primary start.
    const cutIdx = proj[leadEnd].idx;
    const headPrimary = coords.slice(0, cutIdx + 1);
    let pre = best.oriented;
    // Orientation that ENDS nearest the primary's first covered stop.
    const jj = nearestVertex(headPrimary[headPrimary.length - 1], pre).idx;
    pre = pre.slice(0, jj + 1);
    merged = pre.concat(headPrimary);
    stitchedCount = leadEnd;
  }

  // 4. Final validation: every stop must now be within threshold of merged.
  for (let i = 0; i < stops.length; i++) {
    if (nearestVertex([stops[i].lat, stops[i].lon], merged).dist > thresholdM) {
      console.warn(`[RouteStitcher] candidate rejected for ${cacheKey}: stop ${i} still uncovered`);
      return null;
    }
  }

  console.log(`[RouteStitcher] stitched ${stitchedCount} stop(s) into ${cacheKey} using sibling shape ${best.id}`);
  return { coords: merged, stitched: stitchedCount, source: best.id };
}

function covDist(seg, s) {
  let m = Infinity;
  for (const v of seg) { const d = distM([s.lat, s.lon], v); if (d < m) m = d; }
  return m;
}

/**
 * Discovers a road shape for routes that have NO shape at all: scans shapes.db
 * for a polyline that passes near every stop (within thresholdM) IN STOP ORDER
 * (monotonic vertex progression). Returns the best candidate's coordinates.
 *
 * @param {object} params
 * @param {Array<{lat:number, lon:number, id?:string}>} params.stops ordered stops
 * @param {string}   params.dbPath      path to shapes.db
 * @param {number}   [params.thresholdM=150]
 * @param {number}   [params.minCoverage=0.9] fraction of stops that must be covered
 * @returns {{coords:Array<[number,number]>, source:string}|null}
 */
function discoverShapeForStops({ stops, dbPath, thresholdM = 150, minCoverage = 0.9 }) {
  if (!Array.isArray(stops) || stops.length < 2) return null;
  const db = getDb(dbPath);
  if (!db) return null;

  let rows;
  try {
    rows = db.prepare('SELECT shape_id, coords FROM shapes').all();
  } catch (e) {
    console.warn('[RouteStitcher] discovery query failed:', e.message);
    return null;
  }

  const need = Math.ceil(stops.length * minCoverage);
  let best = null; // {id, coords, covered, maxDist}

  for (const row of rows) {
    let c;
    try { c = JSON.parse(row.coords); } catch (_) { continue; }
    if (!Array.isArray(c) || c.length < stops.length) continue;

    // Walk stops in order, requiring monotonically advancing vertex indices.
    let vi = 0, covered = 0, maxDist = 0;
    for (const s of stops) {
      let bi = -1, bd = Infinity;
      for (let k = vi; k < c.length; k++) {
        const d = distM([s.lat, s.lon], c[k]);
        if (d < bd) { bd = d; bi = k; }
      }
      if (bd <= thresholdM && bi >= vi - 1) { covered++; maxDist = Math.max(maxDist, bd); vi = Math.max(vi, bi); }
      else if (bd > 800) break; // hopeless — stop early
    }
    if (covered < need) continue;
    if (!best || covered > best.covered || (covered === best.covered && maxDist < best.maxDist)) {
      best = { id: row.shape_id, coords: c, covered, maxDist };
    }
  }

  if (!best) return null;
  console.log(`[RouteStitcher] discovered shape ${best.id} covering ${best.covered}/${stops.length} stops (max ${best.maxDist.toFixed(0)}m)`);
  return { coords: best.coords, source: best.id };
}

/**
 * Detects stop-to-stop chord polylines masquerading as shapes: the coordinate
 * count tracks the stop count and nearly every stop coincides with a vertex.
 * Real GTFS road shapes are 10-100x denser and rarely pass exactly through
 * every stop.
 */
function looksLikeChordPolyline(coords, stops, toleranceM = 30) {
  if (!Array.isArray(coords) || coords.length < 2 || !Array.isArray(stops) || stops.length < 3) return false;
  if (coords.length > stops.length + 4) return false; // too dense to be chords
  let onVertex = 0;
  for (const s of stops) {
    for (const c of coords) {
      if (distM([s.lat, s.lon], c) <= toleranceM) { onVertex++; break; }
    }
  }
  return onVertex / stops.length >= 0.8;
}

/**
 * Unified geometry-resolution chain for a line's polyline.
 *
 * Resolution order (first success wins):
 *   1. Provided coords are stitched/composed so every stop sits on the road.
 *      - stitchShapeGaps first (sibling-shape splicing from shapes.db),
 *      - then geoEngine.composeRouteWithStops (splice/chord fallback),
 *      - else the raw shape as-is.
 *   2. No coords: discoverShapeForStops scans shapes.db for a full-coverage sibling.
 *   3. Still nothing: OSRM public router builds a road route through the stops
 *      (disk-cached; see osrmClient.js).
 *   4. Total failure → null (caller draws straight stop-to-stop chords).
 *
 * @param {object} params
 * @param {Array<[number,number]>|null} [params.coords]     existing shape polyline [lat,lon]
 * @param {Array<{lat:number, lon:number, id?:string}>} [params.stops] ordered stops
 * @param {string}  [params.dbPath]           path to shapes.db
 * @param {string}  [params.primaryShapeId]   primary shape id (stitch cache key)
 * @param {number}  [params.thresholdM=150]   coverage tolerance in metres
 * @param {boolean} [params.useOsrm=true]     allow OSRM fallback when no shape is found
 * @returns {Promise<{coords:Array<[number,number]>, stitched:number,
 *                     source?:string, method:string}|null>}
 *          method ∈ 'stitched-shape' | 'composed' | 'shape' | 'discovered' | 'osrm'
 */
async function resolveRouteGeometry({
  coords = null,
  stops = [],
  dbPath = '',
  primaryShapeId = '',
  thresholdM = 150,
  useOsrm = true
} = {}) {
  if (!Array.isArray(stops) || stops.length < 2) return null;

  // --- Chain 1: valid provided coords → stitch or compose onto them. ---
  // A polyline that is essentially just the stops joined together (what we get
  // when shapes.db is unavailable) is NOT road geometry — treat it like no
  // shape at all so discovery/OSRM still get a chance.
  const chordLike = looksLikeChordPolyline(coords, stops);
  if (Array.isArray(coords) && coords.length > 1 && !chordLike) {
    const stitched = stitchShapeGaps({ coords, stops, dbPath, primaryShapeId, thresholdM });
    if (stitched && Array.isArray(stitched.coords) && stitched.coords.length > 1) {
      return { ...stitched, method: 'stitched-shape' };
    }
    const composed = composeRouteWithStops(coords, stops, { thresholdM });
    if (composed && composed.stitched > 0 && Array.isArray(composed.coords) && composed.coords.length > 1) {
      return { coords: composed.coords, stitched: composed.stitched, method: 'composed' };
    }
    return { coords, stitched: 0, method: 'shape' };
  }
  if (chordLike) coords = null; // discard chords — discovery/OSRM below will replace them

  // --- Chain 2: no usable coords → discover a covering sibling shape. ---
  const discovered = discoverShapeForStops({ stops, dbPath, thresholdM });
  if (discovered && Array.isArray(discovered.coords) && discovered.coords.length > 1) {
    return {
      coords: discovered.coords,
      stitched: 0,
      source: discovered.source,
      method: 'discovered'
    };
  }

  // --- Chain 3: last resort → OSRM road route through the stops. ---
  if (useOsrm) {
    const osrmCoords = await fetchRoadRoute(stops);
    if (osrmCoords && osrmCoords.length > 1) {
      return { coords: osrmCoords, stitched: 0, source: 'osrm', method: 'osrm' };
    }
  }

  // --- Chain 4: nothing worked. ---
  return null;
}

module.exports = { stitchShapeGaps, discoverShapeForStops, resolveRouteGeometry };
