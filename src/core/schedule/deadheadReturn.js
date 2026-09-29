/**
 * src/core/schedule/deadheadReturn.js
 *
 * Detects "deadhead returns" in the operator's delay feed: a late bus that
 * stops serving its trip, drives back to the start of its route without
 * passengers, and starts its next trip roughly on time. The trip in the other
 * direction that it was due to run in between is not run by this bus.
 *
 * The operator's AVL (SAE) does not say so. While the bus drives back it keeps
 * logging stops against the abandoned trip (a stop it already served, with a
 * delay that grows by the minutes elapsed) and then "arrives" once at a stop of
 * the skipped trip. Those records are not real stop visits: counting them turns
 * a +26 bus into "+49 at Biblioteca Pompeu Fabra" and credits a trip that was
 * never driven with a +10 arrival.
 *
 * Measured on production, L8 bus 2669 (29 Sep 2026): +26 at Euskadi (14:46),
 * Biblioteca Pompeu Fabra re-logged at +49 (already served at 14:29), Rodalies
 * logged on the Galícia -> Rodalies trip at +10, then Sant Joan +3 on the next
 * Rodalies -> Galícia trip at 14:57, 11 minutes after Euskadi. The Galícia ->
 * Rodalies trip takes 21 minutes. No other bus in the feed ran it: Roca Blanca
 * logged buses at 14:05 and 14:51.
 *
 * The signature, for one bus on one line (all must hold):
 *  1. A served run in direction D: MIN_RUN_STOPS or more distinct stops, moving
 *     forward along D's published stop order.
 *  2. The next served run (MIN_RUN_STOPS or more stops) is again in D, starts
 *     at one of D's first RESTART_MAX_INDEX + 1 stops, and starts at least
 *     max(MIN_JUMP_STOPS, half of D's stops) behind the furthest stop the
 *     first run reached.
 *  3. In between, the feed put the bus on the opposite direction at exactly
 *     one stop (the operator's system closing the skipped trip).
 *  4. The bus was back on D less than DEADHEAD_SPEED_FACTOR times the opposite
 *     direction's scheduled trip time after its last served stop: too soon to
 *     have driven that trip.
 * On 7 days of production samples (24-30 Sep 2026, 257,428 rows) these rules
 * find exactly the L8 case above. Relaxing 3 or 4 starts matching L3 buses
 * whose direction flag the operator reports inconsistently.
 *
 * Everything the bus logged between the two runs is a phantom record.
 *
 * What this cannot tell: whether a bus that sends nothing to the operator's
 * system covered the skipped trip. Wording built on it must say "no bus in the
 * operator's data", never "no bus".
 *
 * Pure module: no database, no clock. Timestamps are epoch ms.
 */

const MIN_RUN_STOPS = 3;
const RESTART_MAX_INDEX = 3;
const MIN_JUMP_STOPS = 5;
const DEADHEAD_SPEED_FACTOR = 0.6;
// Consecutive samples further apart than this are not one run.
const RUN_GAP_MS = 30 * 60 * 1000;

function hasDirection(s) {
  return s.direction !== undefined && s.direction !== null && String(s.direction) !== '';
}

/**
 * @param {Array<{vehicleId: string, lineCode: string, direction: string, stopName: string,
 *   delayMins: number, timestamp: number, scheduledTime?: string}>} samples
 *   Delay samples in any order. Samples without a vehicleId or direction are ignored.
 * @param {{stopIndex: function(string, string, string): ({indexes: number[], lastIndex: number}|null),
 *   tripMinutes: function(string, string): (number|null)}} options
 *   stopIndex as in tripRelink.js; tripMinutes(lineCode, direction) is that
 *   direction's scheduled end-to-end time. Both are required: without them
 *   nothing is detected.
 * @returns {Array<object>} One entry per deadhead return, ordered by vehicle then time:
 *   { vehicleId, lineCode, direction, oppositeDirection, lastServedStop, lastServedTs,
 *   lastServedDelay, lastServedIndex, directionLastIndex, resumeStop, resumeTs, resumeIndex, returnMinutes,
 *   oppositeTripMinutes, phantomFromTs, phantomToTs, phantoms: [{stopName, direction,
 *   delayMins, firstTs, lastTs, scheduledTime}], closedTrip: {direction, stopName,
 *   scheduledTime, timestamp} }. [phantomFromTs, phantomToTs] holds every phantom record.
 */
function findDeadheadReturns(samples, { stopIndex, tripMinutes } = {}) {
  if (typeof stopIndex !== 'function' || typeof tripMinutes !== 'function') return [];
  const byVehicle = new Map();
  for (const s of Array.isArray(samples) ? samples : []) {
    if (!s || !s.vehicleId || !hasDirection(s)) continue;
    const ts = Number(s.timestamp);
    const delay = Number(s.delayMins);
    if (!Number.isFinite(ts) || !Number.isFinite(delay)) continue;
    const key = String(s.vehicleId);
    if (!byVehicle.has(key)) byVehicle.set(key, []);
    byVehicle.get(key).push({
      ...s,
      lineCode: String(s.lineCode || '').toUpperCase(),
      direction: String(s.direction),
      stopName: String(s.stopName || ''),
      timestamp: ts,
      delayMins: delay
    });
  }

  const found = [];
  for (const [vehicleId, list] of [...byVehicle.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => a.timestamp - b.timestamp);

    // Runs: consecutive samples on one line and direction that never step back
    // along the route. A step back starts a new run.
    const runs = [];
    for (const s of list) {
      const pos = stopIndex(s.lineCode, s.direction, s.stopName);
      if (!pos) continue;
      const run = runs[runs.length - 1];
      const steppedBack = run && Math.min(...run.lastPos.indexes) > Math.max(...pos.indexes);
      if (!run || run.lineCode !== s.lineCode || run.direction !== s.direction || steppedBack
        || s.timestamp - run.lastTs > RUN_GAP_MS) {
        runs.push({
          lineCode: s.lineCode,
          direction: s.direction,
          samples: [s],
          stops: new Set([s.stopName]),
          firstIndex: Math.min(...pos.indexes),
          maxIndex: Math.max(...pos.indexes),
          lastIndex: pos.lastIndex,
          lastPos: pos,
          firstTs: s.timestamp,
          lastTs: s.timestamp
        });
        continue;
      }
      run.samples.push(s);
      run.stops.add(s.stopName);
      run.maxIndex = Math.max(run.maxIndex, ...pos.indexes);
      run.lastPos = pos;
      run.lastTs = s.timestamp;
    }

    let prevServed = -1;
    for (let k = 0; k < runs.length; k++) {
      if (runs[k].stops.size < MIN_RUN_STOPS) continue;
      const served = prevServed;
      prevServed = k;
      if (served < 0) continue;
      const before = runs[served];
      const after = runs[k];
      if (before.lineCode !== after.lineCode || before.direction !== after.direction) continue;
      if (after.firstIndex > RESTART_MAX_INDEX) continue;
      if (before.maxIndex - after.firstIndex < Math.max(MIN_JUMP_STOPS, after.lastIndex / 2)) continue;

      const between = runs.slice(served + 1, k).flatMap(r => r.samples)
        .filter(s => s.lineCode === after.lineCode);
      const opposite = between.filter(s => s.direction !== after.direction);
      const oppositeStops = new Set(opposite.map(s => s.stopName));
      if (oppositeStops.size !== 1) continue;
      const oppositeDirection = opposite[0].direction;
      const oppositeMinutes = Number(tripMinutes(after.lineCode, oppositeDirection));
      if (!Number.isFinite(oppositeMinutes) || oppositeMinutes <= 0) continue;
      const returnMs = after.firstTs - before.lastTs;
      if (returnMs >= DEADHEAD_SPEED_FACTOR * oppositeMinutes * 60000) continue;

      // The last stop the first run served: the furthest one, first reached.
      const lastServed = before.samples[before.samples.length - 1];
      const lastServedPos = stopIndex(lastServed.lineCode, lastServed.direction, lastServed.stopName);
      const phantoms = [];
      for (const s of between) {
        const last = phantoms[phantoms.length - 1];
        if (last && last.stopName === s.stopName && last.direction === s.direction) {
          last.lastTs = s.timestamp;
          last.delayMins = Math.max(last.delayMins, s.delayMins);
          continue;
        }
        phantoms.push({
          stopName: s.stopName,
          direction: s.direction,
          delayMins: s.delayMins,
          firstTs: s.timestamp,
          lastTs: s.timestamp,
          scheduledTime: String(s.scheduledTime || '')
        });
      }
      found.push({
        vehicleId,
        lineCode: after.lineCode,
        direction: after.direction,
        oppositeDirection,
        lastServedStop: lastServed.stopName,
        lastServedTs: before.lastTs,
        lastServedDelay: lastServed.delayMins,
        lastServedIndex: lastServedPos ? Math.max(...lastServedPos.indexes) : before.maxIndex,
        directionLastIndex: after.lastIndex,
        resumeStop: after.samples[0].stopName,
        resumeTs: after.firstTs,
        resumeIndex: after.firstIndex,
        returnMinutes: Math.round(returnMs / 60000),
        oppositeTripMinutes: oppositeMinutes,
        phantomFromTs: between[0].timestamp,
        phantomToTs: between[between.length - 1].timestamp,
        phantoms,
        closedTrip: {
          direction: oppositeDirection,
          stopName: opposite[0].stopName,
          scheduledTime: String(opposite[0].scheduledTime || ''),
          timestamp: opposite[0].timestamp
        }
      });
    }
  }
  return found;
}

/**
 * The deadhead return whose phantom stretch contains this sample, or null.
 */
function deadheadCovering(deadheads, vehicleId, lineCode, timestamp) {
  if (!vehicleId || !Array.isArray(deadheads)) return null;
  const code = String(lineCode || '').toUpperCase();
  const ts = Number(timestamp);
  return deadheads.find(d => d.vehicleId === String(vehicleId) && d.lineCode === code
    && ts >= d.phantomFromTs && ts <= d.phantomToTs) || null;
}

/**
 * The deadhead return of this bus that begins inside [fromTs, toTs] (its last
 * served stop falls in the window) or whose phantom stretch overlaps it, or null.
 */
function deadheadTouching(deadheads, vehicleId, lineCode, fromTs, toTs) {
  if (!vehicleId || !Array.isArray(deadheads)) return null;
  const code = String(lineCode || '').toUpperCase();
  const from = Number(fromTs);
  const to = Number(toTs);
  return deadheads.find(d => d.vehicleId === String(vehicleId) && d.lineCode === code
    && ((d.lastServedTs >= from && d.lastServedTs <= to) || (d.phantomFromTs <= to && d.phantomToTs >= from))) || null;
}

module.exports = {
  findDeadheadReturns,
  deadheadCovering,
  deadheadTouching,
  MIN_RUN_STOPS,
  RESTART_MAX_INDEX,
  MIN_JUMP_STOPS,
  DEADHEAD_SPEED_FACTOR,
  RUN_GAP_MS
};
