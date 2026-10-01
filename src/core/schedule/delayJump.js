/**
 * src/core/schedule/delayJump.js
 *
 * Detects delay jumps the clock cannot explain in the operator's delay feed:
 * the operator's AVL (SAE) putting a bus on a trip scheduled EARLIER than the
 * one it was on, so the reported delay rises faster than time passes.
 *
 * A delay is the bus's time minus the schedule time of the trip the AVL says it
 * runs. Between two records of one bus Δt apart, a real delay can grow by at
 * most Δt: the bus standing still while the timetable moves on. Across a
 * terminus the same bound holds, because a bus's next trip is scheduled after
 * its previous one ends. A rise larger than Δt means the schedule time it is
 * measured against went BACKWARDS: the records from there on are measured
 * against a trip the bus is not running (already run, or someone else's).
 * tripRelink.js catches the mirror image (a delay that collapses mid-route).
 *
 * Seen live, L7 bus 2653 (1 Oct 2026): L7 runs a single bus at midday on a
 * 28-minute cycle. The bus reached Parc Cerdanyola on time (delay 0 at 14:12)
 * and left on the 14:12 trip; at 14:14 the feed put it on the 13:44 trip it had
 * run one cycle earlier and reported +29/+30 all the way to Pl. Tereses. Our
 * measured delay agreed (+28) because it is timed on the trip the operator's
 * delay points to; only trip_agrees = 0 disagreed. Neither the relink nor the
 * deadhead rules saw it.
 *
 * The signature, for consecutive records of one bus on one line:
 *  - the earlier delay is a normal reading (>= JUMP_FROM_MIN_MINS),
 *  - the delay rises by JUMP_MIN_MINS or more,
 *  - the rise exceeds the elapsed time by more than JUMP_SLACK_MINS (minute
 *    rounding of both records plus feed lag),
 *  - the two records are at most JUMP_MAX_GAP_MS apart.
 * The stale stretch runs from the jump while the delay stays JUMP_MIN_MINS or
 * more above the pre-jump reading, with no feed gap over STALE_RUN_GAP_MS. It
 * may cross a terminus: an AVL a cycle behind stays a cycle behind.
 *
 * What this cannot tell: if a dispatcher really sent this bus to cover another
 * bus's late trip, that trip was late for its riders. The records still do not
 * describe the trip this bus was on, which is what the rankings count.
 *
 * Pure module: no database, no clock. Timestamps are epoch ms.
 */

'use strict';

const JUMP_MIN_MINS = 10;
const JUMP_SLACK_MINS = 3;
const JUMP_MAX_GAP_MS = 20 * 60 * 1000;
// A reading below this is itself suspect (the feed's -15 sentinel, or a bus
// waiting at a terminus logged against a later trip), so it never anchors a jump.
const JUMP_FROM_MIN_MINS = -3;
const STALE_RUN_GAP_MS = 10 * 60 * 1000;

/**
 * @param {Array<{vehicleId: string, lineCode: string, direction?: string,
 *   delayMins: number, timestamp: number, stopName?: string}>} samples
 *   Delay samples in any order. Samples without a vehicleId are ignored.
 * @returns {Array<{vehicleId: string, lineCode: string, direction: string,
 *   beforeTs: number, beforeStop: string, delayBefore: number,
 *   jumpTs: number, jumpStop: string, delayAfter: number, elapsedMins: number,
 *   staleFromTs: number, staleToTs: number, staleStops: string[], staleSampleCount: number}>}
 *   One entry per jump, ordered by vehicle then time. [staleFromTs, staleToTs]
 *   holds every record measured against the wrong trip.
 */
function findDelayJumps(samples) {
  const byVehicle = new Map();
  for (const s of Array.isArray(samples) ? samples : []) {
    if (!s || !s.vehicleId) continue;
    const ts = Number(s.timestamp);
    const delay = Number(s.delayMins);
    if (!Number.isFinite(ts) || !Number.isFinite(delay)) continue;
    const key = String(s.vehicleId);
    if (!byVehicle.has(key)) byVehicle.set(key, []);
    byVehicle.get(key).push({ ...s, timestamp: ts, delayMins: delay, lineCode: String(s.lineCode || '').toUpperCase() });
  }

  const jumps = [];
  for (const [vehicleId, list] of [...byVehicle.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => a.timestamp - b.timestamp);
    let i = 1;
    while (i < list.length) {
      const before = list[i - 1];
      const after = list[i];
      const elapsedMs = after.timestamp - before.timestamp;
      const rise = after.delayMins - before.delayMins;
      const isJump = before.lineCode && before.lineCode === after.lineCode
        && before.delayMins >= JUMP_FROM_MIN_MINS
        && elapsedMs <= JUMP_MAX_GAP_MS
        && rise >= JUMP_MIN_MINS
        && rise * 60000 > elapsedMs + JUMP_SLACK_MINS * 60000;
      if (!isJump) { i++; continue; }

      let end = i;
      while (end + 1 < list.length
        && list[end + 1].lineCode === after.lineCode
        && list[end + 1].timestamp - list[end].timestamp <= STALE_RUN_GAP_MS
        && list[end + 1].delayMins >= before.delayMins + JUMP_MIN_MINS) {
        end++;
      }
      const stale = list.slice(i, end + 1);
      const staleStops = [];
      for (const s of stale) {
        const name = String(s.stopName || '');
        if (name && staleStops[staleStops.length - 1] !== name) staleStops.push(name);
      }
      jumps.push({
        vehicleId,
        lineCode: after.lineCode,
        direction: after.direction === undefined || after.direction === null ? '' : String(after.direction),
        beforeTs: before.timestamp,
        beforeStop: String(before.stopName || ''),
        delayBefore: before.delayMins,
        jumpTs: after.timestamp,
        jumpStop: String(after.stopName || ''),
        delayAfter: after.delayMins,
        elapsedMins: Math.round(elapsedMs / 60000),
        staleFromTs: after.timestamp,
        staleToTs: stale[stale.length - 1].timestamp,
        staleStops,
        staleSampleCount: stale.length
      });
      i = end + 1;
    }
  }
  return jumps;
}

/** The jump whose stale stretch contains this sample, or null. */
function jumpCovering(jumps, vehicleId, lineCode, timestamp) {
  if (!vehicleId || !Array.isArray(jumps)) return null;
  const code = String(lineCode || '').toUpperCase();
  const ts = Number(timestamp);
  return jumps.find(j => j.vehicleId === String(vehicleId) && j.lineCode === code
    && ts >= j.staleFromTs && ts <= j.staleToTs) || null;
}

/** The jump whose stale stretch overlaps [fromTs, toTs] for this bus, or null. */
function jumpOverlapping(jumps, vehicleId, lineCode, fromTs, toTs) {
  if (!vehicleId || !Array.isArray(jumps)) return null;
  const code = String(lineCode || '').toUpperCase();
  return jumps.find(j => j.vehicleId === String(vehicleId) && j.lineCode === code
    && j.staleFromTs <= Number(toTs) && j.staleToTs >= Number(fromTs)) || null;
}

module.exports = {
  findDelayJumps,
  jumpCovering,
  jumpOverlapping,
  JUMP_MIN_MINS,
  JUMP_SLACK_MINS,
  JUMP_MAX_GAP_MS,
  JUMP_FROM_MIN_MINS,
  STALE_RUN_GAP_MS
};
