const fs = require('fs');
const path = require('path');

class TrackerRegistry {
  constructor() {
    this.providers = new Map();     // providerKey -> { tracker, meta }
    this.cachedLines = null;
    this.lastCacheTime = 0;
    this.cacheTtlMs = 60000;       // 1 minute line catalog cache
    this.isInitialized = false;
  }

  /**
   * Register a tracker instance for an operator.
   * @param {string} providerKey Unique key ('mataro')
   * @param {object} trackerInstance Subclass of BaseTracker or compatible tracker
   * @param {object} [metadata={}] Provider metadata (agency, priority, etc.)
   */
  registerTracker(providerKey, trackerInstance, metadata = {}) {
    if (!providerKey || !trackerInstance) {
      throw new Error('registerTracker requires providerKey and trackerInstance');
    }
    this.providers.set(providerKey, {
      tracker: trackerInstance,
      meta: {
        providerKey,
        agency: metadata.agency || providerKey,
        priority: metadata.priority || 100,
        ...metadata
      }
    });
    this.cachedLines = null; // Invalidate line catalog cache
  }

  /**
   * Lazy load default tracker singletons if none are registered yet.
   */
  _ensureDefaultProviders() {
    if (this.providers.size > 0) return;

    try {
      const mataroTracker = require('../mataroTracker');
      this.registerTracker('mataro', mataroTracker, { agency: 'Mataró Bus', priority: 100 });
    } catch (_) {}
  }

  /**
   * Initialize all registered trackers in parallel.
   * @returns {Promise<void>}
   */
  async initAll() {
    if (this.isInitialized) return;
    this._ensureDefaultProviders();

    const initPromises = [];
    for (const [key, entry] of this.providers.entries()) {
      if (typeof entry.tracker.init === 'function') {
        initPromises.push(
          entry.tracker.init().catch(err => {
            console.warn(`[TrackerRegistry] Tracker ${key} init warning:`, err.message);
          })
        );
      }
    }
    await Promise.allSettled(initPromises);
    this.isInitialized = true;
    console.log(`[TrackerRegistry] Initialized ${this.providers.size} transit provider (Mataró Bus).`);
  }

  /**
   * Polymorphic Line Resolution:
   * Maps any line identifier/alias to Mataró Bus.
   * 
   * @param {string|number} lineId
   * @returns {{
   *   type: string,
   *   tracker: object,
   *   lineId: string,
   *   cleanCode: string,
   *   agency: string,
   *   isTrain: boolean,
   *   color?: string,
   *   lineConfig?: object
   * }}
   */
  getTrackerForLine(lineId) {
    this._ensureDefaultProviders();

    const rawId = String(lineId || '').trim();
    const cleanId = rawId.toLowerCase().replace(/^(line-|linia-)/, '');
    const mataroId = cleanId.replace(/^mataro_?/, '').replace(/^l(?=[1-8]$)/, '');

    const mataroEntry = this.providers.get('mataro');
    if (!mataroEntry) {
      throw new Error(`No transit tracker registered for line '${lineId}'.`);
    }

    const resolvedId = /^[1-8]$/.test(mataroId) ? mataroId : '1';
    const lineConfig = mataroEntry.tracker.resolveLineConfig ? mataroEntry.tracker.resolveLineConfig(resolvedId) : null;

    return {
      type: 'mataro',
      tracker: mataroEntry.tracker,
      lineId: resolvedId,
      cleanCode: `L${resolvedId}`,
      agency: 'Mataró Bus',
      isTrain: false,
      color: lineConfig?.color || '#009485',
      lineConfig
    };
  }

  /**
   * Aggregates all transit lines for registered operators with 4-tier deduplication.
   * @returns {Array<object>}
   */
  getAllLines() {
    this._ensureDefaultProviders();

    const now = Date.now();
    if (this.cachedLines && (now - this.lastCacheTime < this.cacheTtlMs)) {
      return this.cachedLines;
    }

    const seenIds = new Set();
    const seenRouteIds = new Set();
    const seenProminentCodes = new Set();
    const allCombined = [];

    const addLine = (l) => {
      if (!l || !l.id) return;
      const cleanId = String(l.id).toLowerCase();
      const cleanRouteId = l.routeId ? String(l.routeId).toUpperCase() : '';
      const normCode = (l.code || '').toLowerCase().replace(/[^a-z0-9]/g, '');

      // Tier 1: Unique internal identifier
      if (seenIds.has(cleanId)) return;

      // Tier 2: Official GTFS routeId
      if (cleanRouteId && seenRouteIds.has(cleanRouteId)) return;

      // Tier 3: Prominent line codes (e.g. c10, e11.1, e11.2, n80, n81, n82, etc.)
      const prominentCodes = ['c10', 'e111', 'e112', 'n80', 'n81', 'n82', 'n83', '603'];
      if (prominentCodes.includes(normCode) && seenProminentCodes.has(normCode)) return;

      seenIds.add(cleanId);
      if (cleanRouteId) seenRouteIds.add(cleanRouteId);
      if (prominentCodes.includes(normCode)) seenProminentCodes.add(normCode);
      allCombined.push(l);
    };

    // Sort providers by priority (highest first)
    const sortedEntries = Array.from(this.providers.entries())
      .sort((a, b) => (b[1].meta.priority || 50) - (a[1].meta.priority || 50));

    for (const [key, entry] of sortedEntries) {
      if (typeof entry.tracker.getLines === 'function') {
        const lines = entry.tracker.getLines();
        if (Array.isArray(lines)) {
          lines.forEach(addLine);
        }
      }
    }

    this.cachedLines = allCombined;
    this.lastCacheTime = now;
    return allCombined;
  }

  /**
   * Search stops and lines across Mataró Bus.
   * @param {string} query
   * @param {number} [limit=35]
   * @returns {Array<object>}
   */
  searchStopsAndLines(query, limit = 35) {
    this._ensureDefaultProviders();

    const q = (query || '').trim().toLowerCase();
    if (!q) return [];

    const normQ = q.replace(/[-_\s\.]/g, '');
    const results = [];

    // 1. Search Lines First (high priority matches)
    const allLines = this.getAllLines();
    const matchingLines = allLines.filter(l => {
      const code = String(l.code || '').toLowerCase();
      const name = String(l.name || '').toLowerCase();
      const id = String(l.id || '').toLowerCase();
      const normCode = code.replace(/[-_\s\.]/g, '');
      const normId = id.replace(/[-_\s\.]/g, '');
      if (q.length === 1) {
        return code === q || normCode === normQ || code.startsWith(q) || normCode.startsWith(normQ);
      }
      return code.includes(q) || normCode.includes(normQ) || id.includes(q) || normId.includes(normQ) || name.includes(q);
    });

    matchingLines.sort((a, b) => {
      const aCode = String(a.code || '').toLowerCase();
      const bCode = String(b.code || '').toLowerCase();
      const aExact = aCode === q || aCode.replace(/[-_\s\.]/g, '') === normQ;
      const bExact = bCode === q || bCode.replace(/[-_\s\.]/g, '') === normQ;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      return 0;
    });

    matchingLines.slice(0, 8).forEach(l => {
      results.push({
        type: 'line',
        isLine: true,
        lineId: l.id,
        lineCode: l.code,
        lineName: l.name,
        lineColor: l.color || '#009485',
        agency: l.agency || 'Mataró Bus',
        zone: `🚌 Línia • ${l.agency || 'Mataró Bus'}`,
        isTrain: false
      });
    });

    // 2. Search stops across Mataró stops map
    const mataroEntry = this.providers.get('mataro');
    if (mataroEntry && mataroEntry.tracker && mataroEntry.tracker.allStopsMap) {
      mataroEntry.tracker.allStopsMap.forEach(s => {
        if (results.length >= limit || !s) return;
        const sName = (s.name || '').toLowerCase();
        const sCode = String(s.code || s.id || '').toLowerCase();
        if (sName.includes(q) || sCode.includes(q)) {
          results.push({
            type: 'stop',
            lineId: (s.lineas && s.lineas[0] ? String(s.lineas[0].id) : '1'),
            lineCode: (s.lineas && s.lineas[0] ? `L${s.lineas[0].id}` : 'L1'),
            lineName: s.name,
            lineColor: '#009485',
            stopId: String(s.id),
            stopName: s.name,
            code: String(s.id),
            zone: 'Mataró Urbà',
            isTrain: false,
            lat: s.lat,
            lon: s.lon,
            lineas: s.lineas || []
          });
        }
      });
    }

    return results.slice(0, limit);
  }
}

// Export singleton instance initialized with default provider
const trackerRegistry = new TrackerRegistry();
trackerRegistry.TrackerRegistry = TrackerRegistry;

module.exports = trackerRegistry;
