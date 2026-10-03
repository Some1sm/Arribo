/**
 * src/core/schedule/backwardLeg.js
 *
 * Detects a bus driving BACKWARDS along its route while the operator's feed still
 * reports the trip it was on: the stop order runs back (Ronda Barceló, Edif.
 * Vidre, Institut Català Salut, ... Roca Blanca) with the direction flag unchanged
 * and the last delay frozen on. Those records are not stop visits and not a delay.
 *
 * Seen live, L8 bus 2679 (2 Oct 2026): +26 at Ronda Barceló (10:07, the 12th of 13
 * stops), then from 10:13 to 10:30 the feed placed it at Edif. Vidre, Institut
 * Català Salut, Gatassa, Pl. Gatassa, Tarragona, Parc Cerdanyola, Roca Blanca,
 * Tarragona and Roca Blanca again, all "direction 0" and all +26, then Tarragona
 * +1 at 10:32 on the next trip. The bus had abandoned its late trip and driven back
 * to the start of the line; the deadhead rule (deadheadReturn.js) never saw it
 * because the direction flag did not change.
 *
 * The signature, for one bus's records on one line and direction:
 *  - a delay of BACK_MIN_DELAY_MINS or more,
 *  - the stop order falls BACK_MIN_STOPS or more places below the furthest stop reached,
 *  - the delay stays within BACK_DELAY_TOLERANCE_MINS of the one at that furthest stop
 *    (it is frozen, not recomputed),
 *  - at least BACK_MIN_VISITS stop visits,
 *  - the bus does not come back to the furthest stop it had reached (an out-and-back
 *    loop such as L3's run to Caldes d'Estrac, not an abandoned trip).
 * The feed's own jitter (a stop or two out of order) is far below BACK_MIN_STOPS.
 * The stretch ends when the delay changes, the silence passes RUN_GAP_MS or the
 * order moves forward again.
 *
 * Pure module: no database, no clock. Timestamps are epoch ms.
 */

'use strict';

// Large delays only: the stretches it removes are the ones that top the rankings.
const BACK_MIN_DELAY_MINS = 15;
const BACK_MIN_STOPS = 4;
// Once started, a stretch goes on while the bus stays this many places behind.
const BACK_KEEP_STOPS = 3;
const BACK_MIN_VISITS = 3;
const BACK_DELAY_TOLERANCE_MINS = 3;
// Samples of one stop closer than this are one visit; a longer silence ends a run.
const VISIT_GAP_MS = 5 * 60 * 1000;
const RUN_GAP_MS = 10 * 60 * 1000;

/**
 * @param {Array<{vehicleId: string, lineCode: string, direction?: string,
 *   delayMins: number, timestamp: number, stopName?: string}>} samples  Any order.
 * @param {{stopIndex: function(string, string, string): ({indexes: number[], lastIndex: number}|null)}} options
 *   Stop position in its direction's published order (scheduleStopIndex in historyDb).
 * @returns {Array<{vehicleId: string, lineCode: string, direction: string,
 *   lastServedStop: string, lastServedTs: number, lastServedDelay: number,
 *   staleFromTs: number, staleToTs: number, lowestStop: string, stepsBack: number,
 *   staleStops: string[], visitCount: number}>}
 */
function findBackwardLegs(samples, { stopIndex } = {}) {
  if (typeof stopIndex !== 'function') return [];
  const byVehicle = new Map();
  for (const s of Array.isArray(samples) ? samples : []) {
    if (!s || !s.vehicleId) continue;
    const ts = Number(s.timestamp);
    const delay = Number(s.delayMins);
    if (!Number.isFinite(ts) || !Number.isFinite(delay) || delay < BACK_MIN_DELAY_MINS) continue;
    const key = String(s.vehicleId);
    if (!byVehicle.has(key)) byVehicle.set(key, []);
    byVehicle.get(key).push({
      ts,
      delay,
      lineCode: String(s.lineCode || '').toUpperCase(),
      direction: s.direction === undefined || s.direction === null ? '' : String(s.direction),
      stopName: String(s.stopName || '')
    });
  }

  const legs = [];
  for (const [vehicleId, list] of [...byVehicle.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => a.ts - b.ts);

    // Stop visits: consecutive samples at one stop.
    const visits = [];
    for (const r of list) {
      const last = visits[visits.length - 1];
      if (last && last.lineCode === r.lineCode && last.direction === r.direction && last.stopName === r.stopName && r.ts - last.lastTs <= VISIT_GAP_MS) {
        last.lastTs = r.ts;
        last.delay = r.delay;
        continue;
      }
      const pos = r.direction === '' ? null : stopIndex(r.lineCode, r.direction, r.stopName);
      // A stop name that appears twice in a direction (L3 runs out to Caldes d'Estrac and back through
      // the same stops) has no single position, so it is neither evidence nor a break.
      const known = Boolean(pos) && pos.indexes.length === 1;
      visits.push({
        lineCode: r.lineCode,
        direction: r.direction,
        stopName: r.stopName,
        firstTs: r.ts,
        lastTs: r.ts,
        delay: r.delay,
        low: known ? pos.indexes[0] : null,
        high: known ? pos.indexes[0] : null
      });
    }

    // Runs: same line and direction, no silence over RUN_GAP_MS.
    let peak = null;
    let leg = null;
    const close = (returned = false) => {
      if (leg && !returned && leg.visits.length >= BACK_MIN_VISITS) {
        const names = [];
        for (const v of leg.visits) if (names[names.length - 1] !== v.stopName) names.push(v.stopName);
        const lowest = leg.visits.reduce((a, b) => (b.high < a.high ? b : a));
        legs.push({
          vehicleId,
          lineCode: leg.peak.lineCode,
          direction: leg.peak.direction,
          lastServedStop: leg.peak.stopName,
          lastServedTs: leg.peak.lastTs,
          lastServedDelay: leg.peak.delay,
          staleFromTs: leg.visits[0].firstTs,
          staleToTs: leg.visits[leg.visits.length - 1].lastTs,
          lowestStop: lowest.stopName,
          stepsBack: leg.peak.low - lowest.high,
          staleStops: names,
          visitCount: leg.visits.length
        });
      }
      leg = null;
      peak = null;
    };
    for (let i = 0; i < visits.length; i++) {
      const v = visits[i];
      const prev = visits[i - 1];
      if (prev && (prev.lineCode !== v.lineCode || prev.direction !== v.direction || v.firstTs - prev.lastTs > RUN_GAP_MS)) close();
      if (v.low === null) continue;
      if (leg) {
        const behind = leg.peak.low - v.high;
        if (behind >= BACK_KEEP_STOPS && Math.abs(v.delay - leg.peak.delay) <= BACK_DELAY_TOLERANCE_MINS) {
          leg.visits.push(v);
          continue;
        }
        close(v.high >= leg.peak.low - 1);
      }
      if (!peak || v.high >= peak.high) { peak = v; continue; }
      if (peak.low - v.high >= BACK_MIN_STOPS && Math.abs(v.delay - peak.delay) <= BACK_DELAY_TOLERANCE_MINS) {
        leg = { peak, visits: [v] };
      }
    }
    close();
  }
  return legs;
}

/** The backward leg whose stretch contains this sample, or null. */
function backwardCovering(legs, vehicleId, lineCode, timestamp) {
  if (!vehicleId || !Array.isArray(legs)) return null;
  const code = String(lineCode || '').toUpperCase();
  const ts = Number(timestamp);
  return legs.find(l => l.vehicleId === String(vehicleId) && l.lineCode === code
    && ts >= l.staleFromTs && ts <= l.staleToTs) || null;
}

/** The backward leg whose stretch overlaps [fromTs, toTs] for this bus, or null. */
function backwardOverlapping(legs, vehicleId, lineCode, fromTs, toTs) {
  if (!vehicleId || !Array.isArray(legs)) return null;
  const code = String(lineCode || '').toUpperCase();
  return legs.find(l => l.vehicleId === String(vehicleId) && l.lineCode === code
    && l.staleFromTs <= Number(toTs) && l.staleToTs >= Number(fromTs)) || null;
}

module.exports = {
  findBackwardLegs,
  backwardCovering,
  backwardOverlapping,
  BACK_MIN_DELAY_MINS,
  BACK_MIN_STOPS,
  BACK_KEEP_STOPS,
  BACK_MIN_VISITS,
  BACK_DELAY_TOLERANCE_MINS,
  RUN_GAP_MS
};
