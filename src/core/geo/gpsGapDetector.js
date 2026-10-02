/**
 * src/core/geo/gpsGapDetector.js
 *
 * Finds where buses stop reporting GPS. The Mataró SIRI feed sends a fix
 * about every 30 s (RecordedAtTime); when a bus's next fix arrives much later,
 * the tracker has been dead-reckoning it in between. This records each such
 * silence as one gap: the last fix before it, the first fix after it, and how
 * long it lasted, so the Observatori can map where signal is lost.
 *
 * Only real observations count. A fix is new evidence only when its
 * observedAt moves forward; re-emitted or extrapolated positions never are.
 * Three kinds of silence are recorded but flagged, because they say nothing
 * about the street the bus was on:
 *   - atTerminal: the bus was standing at a terminal (engines are switched off
 *     during layovers);
 *   - feedWide:   no other bus reported during the silence either, so the
 *     operator's feed stalled, not this bus's GPS;
 *   - the gap is longer than MAX_GAP_MS and is dropped (out of service).
 */

/** The feed's normal cadence is ~30 s; two missed reports is a real loss. */
const MIN_GAP_MS = 90 * 1000;
/** Longer than this the bus was out of service, not in a dead zone. */
const MAX_GAP_MS = 15 * 60 * 1000;
/** Fixes of other buses closer than this to either edge do not prove the feed was alive. */
const EDGE_MARGIN_MS = 15 * 1000;
/** Forget a vehicle (and old fix times) after this long. */
const RETENTION_MS = MAX_GAP_MS + 5 * 60 * 1000;

class GpsGapDetector {
  constructor() {
    this.last = new Map();   // vehicleId -> last fix
    this.fixTimes = [];      // [{ t, v }] recent fixes of every bus, ascending t
  }

  /**
   * Feed one tracker emission. Returns a gap when this fix ends one, else null.
   *
   * @param {object} bus  { vehicleId, lineCode, direction, lat, lon, observedAt,
   *                        isTerminalLayover, toStop }
   */
  observe(bus) {
    const vId = bus && bus.vehicleId ? String(bus.vehicleId) : '';
    const t = Number(bus && bus.observedAt);
    const lat = Number(bus && bus.lat);
    const lon = Number(bus && bus.lon);
    if (!vId || !Number.isFinite(t) || t <= 0 || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const prev = this.last.get(vId);
    if (prev && t <= prev.t) return null; // not new evidence

    const fix = {
      t,
      lat,
      lon,
      lineCode: String(bus.lineCode || ''),
      direction: bus.direction === undefined || bus.direction === null ? '' : String(bus.direction),
      stopName: String(bus.toStop || ''),
      atTerminal: Boolean(bus.isTerminalLayover)
    };
    this.last.set(vId, fix);
    this._addFixTime(t, vId);
    this._evict(t);

    if (!prev) return null;
    const gapMs = t - prev.t;
    if (gapMs < MIN_GAP_MS || gapMs > MAX_GAP_MS) return null;
    // A bus that changed line in the silence was reassigned, not in a dead zone.
    if (prev.lineCode && fix.lineCode && prev.lineCode !== fix.lineCode) return null;

    return {
      vehicleId: vId,
      lineCode: prev.lineCode || fix.lineCode,
      direction: prev.direction,
      lostTs: prev.t,
      regainedTs: t,
      gapSec: Math.round(gapMs / 1000),
      lostLat: prev.lat,
      lostLon: prev.lon,
      regainedLat: lat,
      regainedLon: lon,
      stopName: prev.stopName,
      atTerminal: prev.atTerminal || fix.atTerminal,
      feedWide: !this._othersReported(vId, prev.t, t)
    };
  }

  _addFixTime(t, v) {
    const arr = this.fixTimes;
    let i = arr.length;
    while (i > 0 && arr[i - 1].t > t) i--;
    arr.splice(i, 0, { t, v });
  }

  /** Did any other bus send a fix inside the silence (away from its edges)? */
  _othersReported(vId, from, to) {
    const lo = from + EDGE_MARGIN_MS;
    const hi = to - EDGE_MARGIN_MS;
    for (const f of this.fixTimes) {
      if (f.t <= lo) continue;
      if (f.t >= hi) break;
      if (f.v !== vId) return true;
    }
    return false;
  }

  _evict(now) {
    const cutoff = now - RETENTION_MS;
    let k = 0;
    while (k < this.fixTimes.length && this.fixTimes[k].t < cutoff) k++;
    if (k) this.fixTimes.splice(0, k);
    for (const [v, f] of this.last) if (f.t < cutoff) this.last.delete(v);
  }
}

module.exports = { GpsGapDetector, MIN_GAP_MS, MAX_GAP_MS };
