/**
 * src/core/schedule/tripRelink.js
 *
 * Detects "trip relinks" in the operator's delay feed: moments where the
 * operator's AVL (SAE) re-attaches a bus to the trip it is really running.
 *
 * The signature is a delay that collapses by RELINK_DROP_MINS or more within
 * RELINK_WINDOW_MS on the same line and direction. A bus can only claw back a
 * minute or two between neighbouring stops, so a drop like +50 -> 0 in four
 * minutes is physically impossible: the elevated delay before it was measured
 * against a trip the bus was not running (typically after a long stop, when
 * the AVL keeps the bus on its abandoned trip). Measured on production
 * (25-29 Sep 2026) this happened 16 times mid-trip in 4.5 days, including every
 * large "Horaris no habituals" case.
 *
 * A trip boundary is not a relink: a bus that arrives 20 minutes late and
 * starts its next trip on time legitimately resets its delay. So a direction
 * change never counts, and when a stop resolver is supplied the drop must also
 * happen mid-route (the stop before it is neither the direction's origin nor
 * its terminus) with the bus still moving forward along the route (the stop
 * after it is not behind the stop before it). Without a resolver only the
 * direction check applies.
 *
 * Pure module: no database, no clock. Timestamps are epoch ms.
 */

const RELINK_DROP_MINS = 10;
const RELINK_WINDOW_MS = 10 * 60 * 1000;
// Consecutive samples further apart than this belong to different runs, so the
// stale stretch before a relink never reaches back across a gap in the feed.
const STALE_RUN_GAP_MS = 10 * 60 * 1000;

function sameRun(a, b) {
  return String(a.lineCode || '').toUpperCase() === String(b.lineCode || '').toUpperCase()
    && a.direction !== undefined && a.direction !== null && String(a.direction) !== ''
    && String(a.direction) === String(b.direction);
}

/**
 * @param {Array<{vehicleId: string, lineCode: string, direction: string,
 *   delayMins: number, timestamp: number, stopName?: string}>} samples
 *   Delay samples in any order. Samples without a vehicleId or direction are ignored.
 * @param {{stopIndex?: function(string, string, string): ({indexes: number[], lastIndex: number}|null)}} [options]
 *   stopIndex(lineCode, direction, stopName) returns the stop's position(s) in
 *   that direction's stop order (a name can appear twice, e.g. L3 TecnoCampus)
 *   and the index of the terminus, or null when the stop is unknown. An
 *   unknown stop is never treated as evidence of a relink.
 * @returns {Array<{vehicleId: string, lineCode: string, direction: string,
 *   staleFromTs: number, staleToTs: number, relinkTs: number,
 *   delayBefore: number, delayAfter: number, relinkStop: string,
 *   staleStops: string[], staleSampleCount: number}>}
 *   One entry per relink, ordered by vehicle then time. [staleFromTs, staleToTs]
 *   is the stretch whose delay was measured against the wrong trip.
 */
function findTripRelinks(samples, { stopIndex } = {}) {
  const position = s => {
    if (!stopIndex) return null;
    if (s._position === undefined) s._position = stopIndex(s.lineCode, s.direction, s.stopName) || null;
    return s._position;
  };
  // `later` is not behind `earlier` on the route (lenient for repeated names).
  const movesForward = (earlier, later) => {
    const e = position(earlier);
    const l = position(later);
    return Boolean(e && l && Math.min(...e.indexes) <= Math.max(...l.indexes));
  };
  const byVehicle = new Map();
  for (const s of Array.isArray(samples) ? samples : []) {
    if (!s || !s.vehicleId) continue;
    const ts = Number(s.timestamp);
    const delay = Number(s.delayMins);
    if (!Number.isFinite(ts) || !Number.isFinite(delay)) continue;
    const key = String(s.vehicleId);
    if (!byVehicle.has(key)) byVehicle.set(key, []);
    byVehicle.get(key).push({ ...s, timestamp: ts, delayMins: delay });
  }

  const relinks = [];
  for (const [vehicleId, list] of [...byVehicle.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 1; i < list.length; i++) {
      const before = list[i - 1];
      const after = list[i];
      if (!sameRun(before, after)) continue;
      if (after.timestamp - before.timestamp > RELINK_WINDOW_MS) continue;
      if (before.delayMins - after.delayMins < RELINK_DROP_MINS) continue;
      if (stopIndex) {
        const b = position(before);
        // At the origin or terminus the next trip legitimately starts afresh.
        if (!b || b.indexes.every(idx => idx === 0 || idx === b.lastIndex)) continue;
        if (!movesForward(before, after)) continue;
      }

      // Walk back over the stale stretch: same run, no feed gap, delay still
      // at least RELINK_DROP_MINS above where it landed, and (with a resolver)
      // no step backwards along the route, which would be a previous trip.
      let start = i - 1;
      while (start - 1 >= 0
        && sameRun(list[start - 1], after)
        && list[start].timestamp - list[start - 1].timestamp <= STALE_RUN_GAP_MS
        && list[start - 1].delayMins >= after.delayMins + RELINK_DROP_MINS
        && (!stopIndex || movesForward(list[start - 1], list[start]))) {
        start--;
      }
      const stale = list.slice(start, i);
      const staleStops = [];
      for (const s of stale) {
        const name = String(s.stopName || '');
        if (name && staleStops[staleStops.length - 1] !== name) staleStops.push(name);
      }
      relinks.push({
        vehicleId,
        lineCode: String(after.lineCode || '').toUpperCase(),
        direction: String(after.direction),
        staleFromTs: stale[0].timestamp,
        staleToTs: before.timestamp,
        relinkTs: after.timestamp,
        delayBefore: before.delayMins,
        delayAfter: after.delayMins,
        relinkStop: String(after.stopName || ''),
        staleStops,
        staleSampleCount: stale.length
      });
    }
  }
  return relinks;
}

/**
 * The relink whose stale stretch contains this sample, or null.
 */
function relinkCovering(relinks, vehicleId, lineCode, timestamp) {
  if (!vehicleId || !Array.isArray(relinks)) return null;
  const code = String(lineCode || '').toUpperCase();
  const ts = Number(timestamp);
  return relinks.find(r => r.vehicleId === String(vehicleId) && r.lineCode === code
    && ts >= r.staleFromTs && ts <= r.staleToTs) || null;
}

/**
 * The relink whose stale stretch overlaps [fromTs, toTs] for this bus, or null.
 */
function relinkOverlapping(relinks, vehicleId, lineCode, fromTs, toTs) {
  if (!vehicleId || !Array.isArray(relinks)) return null;
  const code = String(lineCode || '').toUpperCase();
  return relinks.find(r => r.vehicleId === String(vehicleId) && r.lineCode === code
    && r.staleFromTs <= Number(toTs) && r.staleToTs >= Number(fromTs)) || null;
}

module.exports = {
  findTripRelinks,
  relinkCovering,
  relinkOverlapping,
  RELINK_DROP_MINS,
  RELINK_WINDOW_MS,
  STALE_RUN_GAP_MS
};
