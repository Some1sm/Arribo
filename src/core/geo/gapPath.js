/**
 * src/core/geo/gapPath.js
 *
 * The street a bus drove without GPS: the stretch of its line's drawn route
 * from where the signal was lost to where it came back.
 *
 * Circular lines pass some streets twice, so the nearest point on the route
 * can be the wrong pass. Every place the route comes within SNAP_M of each end
 * is a candidate; the chosen stretch is the shortest one running forward
 * along the route (wrapping once on a closed loop) that the bus could have
 * driven in the gap's duration. Nothing plausible: null, never a guess.
 */

const { distanceM } = require('./gapClusters');

const SNAP_M = 60;
/** 60 km/h, generous for a city bus; plus slack for a short gap. */
const MAX_SPEED_MPS = 16.7;
const MIN_REACH_M = 400;

const norm = c => ({
  lat: Number(c.lat !== undefined ? c.lat : c.Latitude),
  lon: Number(c.lon !== undefined ? c.lon : c.Longitude)
});

/** Projection of p on segment a-b (flat approximation, fine at street scale). */
function project(p, a, b) {
  const kx = Math.cos((p.lat * Math.PI) / 180);
  const ax = a.lon * kx, ay = a.lat, bx = b.lon * kx, by = b.lat, px = p.lon * kx, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  const q = { lat: ay + t * dy, lon: (ax + t * dx) / kx };
  return { t, q, d: distanceM(p.lat, p.lon, q.lat, q.lon) };
}

/** Local best snap per run of nearby segments. */
function candidates(p, coords, cum) {
  const out = [];
  let run = null;
  for (let i = 0; i < coords.length - 1; i++) {
    const pr = project(p, coords[i], coords[i + 1]);
    if (pr.d <= SNAP_M) {
      const along = cum[i] + distanceM(coords[i].lat, coords[i].lon, pr.q.lat, pr.q.lon);
      const c = { i, along, q: pr.q, d: pr.d };
      if (run && i === run.last + 1) {
        if (c.d < run.best.d) run.best = c;
        run.last = i;
      } else {
        if (run) out.push(run.best);
        run = { best: c, last: i };
      }
    } else if (run) {
      out.push(run.best);
      run = null;
    }
  }
  if (run) out.push(run.best);
  return out;
}

/**
 * @param {Array} routeCoords  [{Latitude, Longitude}] or [{lat, lon}], in driving order
 * @param {{lat:number, lon:number}} lost
 * @param {{lat:number, lon:number}} regained
 * @param {number} gapSec
 * @returns {{path: Array<[number, number]>, lengthM: number}|null}
 */
function gapPath(routeCoords, lost, regained, gapSec) {
  const coords = (routeCoords || []).map(norm).filter(c => Number.isFinite(c.lat) && Number.isFinite(c.lon));
  if (coords.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distanceM(coords[i - 1].lat, coords[i - 1].lon, coords[i].lat, coords[i].lon));
  const total = cum[cum.length - 1];
  const closed = distanceM(coords[0].lat, coords[0].lon, coords[coords.length - 1].lat, coords[coords.length - 1].lon) < 80;

  const from = candidates(lost, coords, cum);
  const to = candidates(regained, coords, cum);
  if (!from.length || !to.length) return null;

  const straight = distanceM(lost.lat, lost.lon, regained.lat, regained.lon);
  const reach = Math.max(MIN_REACH_M, (Number(gapSec) || 0) * MAX_SPEED_MPS);
  let best = null;
  for (const a of from) {
    for (const b of to) {
      let len = b.along - a.along;
      let wraps = false;
      if (len < 0 && closed) { len += total; wraps = true; }
      if (len < 0 || len > reach || len < straight * 0.8 - 2 * SNAP_M) continue;
      if (!best || len < best.len) best = { a, b, len, wraps };
    }
  }
  if (!best) return null;

  const { a, b, wraps } = best;
  const pts = [[a.q.lat, a.q.lon]];
  const push = i => pts.push([coords[i].lat, coords[i].lon]);
  if (!wraps) {
    for (let i = a.i + 1; i <= b.i; i++) push(i);
  } else {
    for (let i = a.i + 1; i < coords.length; i++) push(i);
    for (let i = 1; i <= b.i; i++) push(i);
  }
  pts.push([b.q.lat, b.q.lon]);
  const round = x => Math.round(x * 1e6) / 1e6;
  return { path: pts.map(([la, lo]) => [round(la), round(lo)]), lengthM: Math.round(best.len) };
}

module.exports = { gapPath, SNAP_M };
