/**
 * delayMemory — persisted realtime bus observations ("delay memory").
 *
 * When an AMB-tracked bus is observed arriving at a stop with a known
 * delay, the observation is stored in SQLite (worker-owned, like all
 * history). Later, when a user opens the line and the bus has already
 * passed every realtime-covered stop, boards can still show its known
 * delay by linking scheduled entries via tripId.
 *
 * Architecture (AGENTS.md): the main process NEVER opens SQLite. This
 * module follows the flightRecorder.setHistoryGateway() pattern —
 * server.js installs the gateway (workerBridge.historyQuery) and
 * trackers call record()/recent() freely; without a gateway it degrades
 * to a small in-memory map (useful in tests and worker-side code).
 */

const MEM_FALLBACK_LIMIT = 500;

class DelayMemory {
  constructor() {
    this._gateway = null;
    this._mem = []; // [{lineId, direction, tripId, scheduledMs, actualMs, delayMins, stopId, createdMs}]
  }

  /** Install the DB RPC gateway. Pass null to use the memory fallback. */
  setGateway(fn) {
    this._gateway = typeof fn === 'function' ? fn : null;
  }

  /**
   * Fire-and-forget persistence of observations. Never throws, never
   * blocks callers on DB latency.
   * @param {Array<{agency?, lineCode?, lineId, direction?, tripId?, stopId, stopName?,
   *                scheduledMs, actualMs, delayMins, runDurationSecs?}>} rows
   */
  record(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    try {
      if (this._gateway) {
        Promise.resolve(this._gateway('saveAmbObservations', { rows }, { timeoutMs: 5000 }))
          .catch(() => {});
        return;
      }
      // Memory fallback (tests / worker-internal usage)
      const now = Date.now();
      for (const r of rows) {
        if (!r || !r.lineId || !r.stopId) continue;
        this._mem.push({ ...r, createdMs: now });
      }
      if (this._mem.length > MEM_FALLBACK_LIMIT) this._mem.splice(0, this._mem.length - MEM_FALLBACK_LIMIT);
    } catch (_) { /* best-effort */ }
  }

  /**
   * Recent observations for a line+direction (newest first). Fails soft → [].
   */
  async recent(lineId, direction = '0', windowMins = 120, limit = 50) {
    try {
      if (this._gateway) {
        const res = await Promise.resolve(this._gateway(
          'getRecentAmbObservations',
          { lineId, direction, windowMins, limit },
          { timeoutMs: 8000 }
        ));
        return Array.isArray(res) ? res : [];
      }
      const cutoff = Date.now() - Number(windowMins || 120) * 60000;
      return this._mem
        .filter(o => o.lineId === String(lineId) && String(o.direction ?? '0') === String(direction) && Number(o.scheduledMs) >= cutoff)
        .sort((a, b) => Number(b.scheduledMs) - Number(a.scheduledMs))
        .slice(0, limit);
    } catch (_) {
      return [];
    }
  }

  /**
   * Applies known delays from recent observations onto a departures board:
   * for each still-scheduled entry whose tripId was observed upstream,
   * recompute its arrival as actualAtObservedStop + scheduleDelta(stop→here)
   * using the entry's own aimedIso. Entries already carrying AMB realtime
   * are untouched.
   *
   * @param {Array} departures            board entries (mutated)
   * @param {{lineId, direction}} key
   * @param {Object} opts
   *   badgeKnown     e.g. '⏱ Retard conegut'
   *   formatClock(ms)->'HH:MM'   clock formatter in tracker timezone
   * @returns {Promise<Array>} same board reference
   */
  async applyKnownDelays(departures, key, opts = {}) {
    try {
      if (!Array.isArray(departures) || departures.length === 0) return departures;
      const obs = await this.recent(key.lineId, key.direction, 120, 50);
      if (obs.length === 0) return departures;

      // Latest observation per trip (most recently recorded wins)
      const byTrip = new Map();
      for (const o of obs) {
        const tid = o.tripId ? String(o.tripId) : '';
        if (!tid) continue;
        if (!byTrip.has(tid)) byTrip.set(tid, o);
      }
      if (byTrip.size === 0) return departures;

      const now = Date.now();
      for (const entry of departures) {
        const tid = entry.tripId ? String(entry.tripId) : '';
        if (!tid || !byTrip.has(tid)) continue;
        // Already has live data → skip
        if (/AMB/.test(entry.delayBadgeText || '') || (entry.isRealTime && /Temps real/.test(entry.delayBadgeText || ''))) continue;
        const o = byTrip.get(tid);
        const schedHereMs = Date.parse(entry.aimedIso || '');
        const schedObsMs = Number(o.scheduledMs);
        const actualObsMs = Number(o.actualMs);
        if (!Number.isFinite(schedHereMs) || !Number.isFinite(schedObsMs) || !Number.isFinite(actualObsMs)) continue;
        // Works in BOTH directions: observation may come from a downstream
        // stop (adjust earlier stops on the same trip) or upstream (propagate
        // forward). Only requirement: this stop's adjusted arrival must still
        // be in the future — otherwise the bus already passed and the stale
        // scheduled entry ages out through normal past-time filtering.
        const estArrivalMs = actualObsMs + (schedHereMs - schedObsMs);
        if (estArrivalMs < now - 90 * 1000 || estArrivalMs > now + 6 * 3600000) continue;
        const delayMin = Math.round((estArrivalMs - schedHereMs) / 60000);
        if (Math.abs(delayMin) > 180) continue;

        const diffMin = Math.max(0, Math.round((estArrivalMs - now) / 60000));
        const clock = typeof opts.formatClock === 'function' ? opts.formatClock(estArrivalMs) : null;
        entry.expectedIso = new Date(estArrivalMs).toISOString();
        if (clock) entry.departureTime = clock;
        entry.minutesAway = diffMin;
        entry.isRealTime = false;
        entry.isEstimated = true;
        entry.knownDelay = true;
        entry.delayMinutes = delayMin;
        entry.delayMins = delayMin;
        entry.scheduledTime = entry.scheduledTime || clock || entry.departureTime;
        entry.delayStatus = Math.abs(delayMin) >= 2 ? 'delayed' : 'on_time';
        entry.delayBadgeText = delayMin >= 2
          ? `${opts.badgeKnown || '⏱ Retard conegut'} · +${delayMin} min`
          : delayMin <= -2
            ? `${opts.badgeKnown || '⏱ Retard conegut'} · ${delayMin} min (avança)`
            : `${opts.badgeKnown || '⏱ Retard conegut'} · A l'hora`;
        entry.comparisonText = `⏱ Desviament observat en temps real a ${o.stopName || o.stopId} (${delayMin >= 0 ? '+' : ''}${delayMin} min), aplicat amb l'horari oficial`;
        entry.formattedStatus = diffMin <= 0 ? 'Imminent' : `${diffMin} min`;
      }
      departures.sort((a, b) => (a.minutesAway ?? Infinity) - (b.minutesAway ?? Infinity));
    } catch (_) { /* best-effort */ }
    return departures;
  }
}

module.exports = new DelayMemory();
