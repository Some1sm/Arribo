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

  loadWarmSnapshotCatalog() {
    // 1. Try cache/routes.json (full warm catalog)
    try {
      const cachePath = path.join(__dirname, '..', '..', 'data', 'cache', 'routes.json');
      if (fs.existsSync(cachePath)) {
        const raw = fs.readFileSync(cachePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch (e) {}

    // 2. Try local snapshot directory (data/snapshots/routes_*.json)
    try {
      const snapshotsDir = path.join(__dirname, '..', '..', 'data', 'snapshots');
      if (fs.existsSync(snapshotsDir)) {
        const files = fs.readdirSync(snapshotsDir)
          .filter(f => f.startsWith('routes_') && f.endsWith('.json'))
          .sort()
          .reverse();
        if (files.length > 0) {
          const snapshotFile = path.join(snapshotsDir, files[0]);
          const raw = fs.readFileSync(snapshotFile, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.routes) && parsed.routes.length > 0) {
            return parsed.routes;
          }
        }
      }
    } catch (e) {
      console.warn('[TrackerRegistry] Could not read daily routes snapshot:', e.message);
    }

    return [];
  }

  /**
   * Register a tracker instance for an operator.
   * @param {string} providerKey Unique key ('c10', 'mataro', 'maresme', 'rodalies', 'sagales', 'amb', 'catalonia')
   * @param {object} trackerInstance Subclass of BaseTracker or compatible tracker
   * @param {object} [metadata={}] Provider metadata (agency, priority, isFallback, etc.)
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
        priority: metadata.priority || 50,
        isFallback: Boolean(metadata.isFallback),
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
      const corridorTracker = require('../corridorTracker');
      this.registerTracker('c10', corridorTracker, { agency: 'Moventis / Casas (C-10)', priority: 100 });
    } catch (_) {}

    try {
      const mataroTracker = require('../mataroTracker');
      this.registerTracker('mataro', mataroTracker, { agency: 'Mataró Bus', priority: 90 });
    } catch (_) {}

    try {
      const maresmeTracker = require('../maresmeTracker');
      this.registerTracker('maresme', maresmeTracker, { agency: 'Moventis / Casas', priority: 80 });
    } catch (_) {}

    try {
      const rodaliesTracker = require('../rodaliesTracker');
      this.registerTracker('rodalies', rodaliesTracker, { agency: 'Rodalies de Catalunya', isTrain: true, priority: 70 });
    } catch (_) {}

    try {
      const ambTracker = require('../ambTracker');
      this.registerTracker('amb', ambTracker, { agency: 'AMB Mobilitat', priority: 60 });
    } catch (_) {}

    try {
      const sagalesTracker = require('../sagalesTracker');
      this.registerTracker('sagales', sagalesTracker, { agency: 'Sagalés', priority: 50 });
    } catch (_) {}

    try {
      const cataloniaTracker = require('../cataloniaTracker');
      this.registerTracker('catalonia', cataloniaTracker, { agency: 'Generalitat de Catalunya (Mou-te)', isFallback: true, priority: 10 });
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
    console.log(`[TrackerRegistry] Initialized ${this.providers.size} transit providers.`);
  }

  /**
   * Polymorphic Line Resolution:
   * Maps any line identifier/alias to the appropriate provider and tracker instance.
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

    // 1. C-10 Specialized Corridor
    if (cleanId === 'c10' || cleanId === 'c-10' || cleanId === 'gen_0498' || cleanId === '02498') {
      const c10Entry = this.providers.get('c10');
      if (c10Entry) {
        return {
          type: 'c10',
          tracker: c10Entry.tracker,
          lineId: 'c10',
          cleanCode: 'C-10',
          agency: 'Moventis / Casas (Interurbà Maresme)',
          isTrain: false,
          color: '#009485'
        };
      }
    }

    // 2. Mataró Urban Lines (L1..L8 / 1..8) - Check before AMB due to numeric IDs
    const mataroId = cleanId.replace(/^mataro_?/, '').replace(/^l(?=[1-8]$)/, '');
    if (/^[1-8]$/.test(mataroId)) {
      const mataroEntry = this.providers.get('mataro');
      if (mataroEntry) {
        return {
          type: 'mataro',
          tracker: mataroEntry.tracker,
          lineId: mataroId,
          cleanCode: `L${mataroId}`,
          agency: 'Mataró Bus',
          isTrain: false,
          color: '#009485'
        };
      }
    }

    // 3. Moventis / Casas Maresme Interurban Lines (e11.1, e11.2, C-20, C-30, N80, etc.)
    const maresmeEntry = this.providers.get('maresme');
    if (maresmeEntry && typeof maresmeEntry.tracker.resolveLine === 'function') {
      const cfg = maresmeEntry.tracker.resolveLine(cleanId);
      if (cfg) {
        return {
          type: 'maresme',
          tracker: maresmeEntry.tracker,
          lineId: cfg.id || cleanId,
          cleanCode: cfg.code || cleanId.toUpperCase(),
          agency: cfg.agency || 'Moventis / Casas',
          isTrain: false,
          color: cfg.color || '#009485',
          lineConfig: cfg
        };
      }
    }

    // 4. Rodalies de Catalunya Train Lines (R1..R8, RG1, RL1..RL4, RT1..RT2)
    const isRodaliesCode = /^(r[1-8]|r1[1-7]|r2[ns]|rg1|rl[1-4]|rt[1-2])$/i.test(cleanId) || cleanId.startsWith('rodalies_');
    const rodaliesEntry = this.providers.get('rodalies');
    if (rodaliesEntry) {
      const cfg = typeof rodaliesEntry.tracker.resolveLine === 'function' ? rodaliesEntry.tracker.resolveLine(cleanId) : null;
      if (cfg || isRodaliesCode) {
        return {
          type: 'rodalies',
          tracker: rodaliesEntry.tracker,
          lineId: cfg?.id || cleanId,
          cleanCode: cfg?.code || cleanId.toUpperCase(),
          agency: 'Rodalies de Catalunya (Renfe / Gencat)',
          isTrain: true,
          color: cfg?.color || '#E54A3C',
          lineConfig: cfg
        };
      }
    }

    // 5. AMB Mobilitat (TUSGSAL, Avanza, Monbus, Baixbus, Soler i Sauret)
    const isAmbPattern = /^(b\d+|m(1|5|6|12|14|15|19|26|27|28|30|75)|a[12]|n([0-9]|1[0-9]|2[0-8])|l(16|20|21|22|46|52|70|72|74|76|77|78|80|82|85|86|88|94|95|96|97|99)|x(30|43|70|79|80|83|84|86|95|97)|lh[12]|pr[1-5]|vb[12]|ga[12]|cf[12]|ep[12]|jm|jt|sf[1-3]|mb[1-3]|sv[1-4]|pf[12])$/i.test(cleanId) || cleanId.startsWith('amb_');
    const ambEntry = this.providers.get('amb');
    if (ambEntry) {
      const cfg = typeof ambEntry.tracker.resolveLine === 'function' ? ambEntry.tracker.resolveLine(cleanId) : null;
      if (cfg || isAmbPattern) {
        return {
          type: 'amb',
          tracker: ambEntry.tracker,
          lineId: cfg?.id || cleanId,
          cleanCode: cfg?.code || cleanId.toUpperCase(),
          agency: cfg?.agency || 'AMB Mobilitat',
          isTrain: false,
          color: cfg?.color || '#009485',
          lineConfig: cfg
        };
      }
    }

    // 6. Sagalés Interurban & Night Bus (N82, N83, e13, 302, 303, 603, 627)
    const sagalesEntry = this.providers.get('sagales');
    if (sagalesEntry) {
      const cfg = typeof sagalesEntry.tracker.resolveLineConfig === 'function' 
        ? sagalesEntry.tracker.resolveLineConfig(cleanId)
        : (typeof sagalesEntry.tracker.resolveLine === 'function' ? sagalesEntry.tracker.resolveLine(cleanId) : null);
      if (cfg) {
        return {
          type: 'sagales',
          tracker: sagalesEntry.tracker,
          lineId: cfg.id || cleanId,
          cleanCode: cfg.code || cleanId.toUpperCase(),
          agency: cfg.agency || 'Sagalés',
          isTrain: false,
          color: cfg.color || '#457336',
          lineConfig: cfg
        };
      }
    }

    // 7. Catalonia Mou-te GTFS Universal Catalog Fallback
    const catEntry = this.providers.get('catalonia');
    if (catEntry) {
      const cfg = typeof catEntry.tracker.resolveLine === 'function' ? catEntry.tracker.resolveLine(cleanId) : null;
      return {
        type: 'catalonia',
        tracker: catEntry.tracker,
        lineId: cfg?.id || cleanId,
        cleanCode: cfg?.code || cleanId.toUpperCase(),
        agency: cfg?.agency || 'Generalitat de Catalunya (Mou-te)',
        isTrain: false,
        color: cfg?.color || '#009485',
        lineConfig: cfg
      };
    }

    throw new Error(`No transit tracker registered to resolve line '${lineId}'.`);
  }

  /**
   * Aggregates all transit lines across all registered operators with 4-tier deduplication.
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
    const seenCodesByAgency = new Set();
    const allCombined = [];

    const addLine = (l) => {
      if (!l || !l.id) return;
      const cleanId = String(l.id).toLowerCase();
      const cleanRouteId = l.routeId ? String(l.routeId).toUpperCase() : '';
      const normCode = (l.code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const normAgency = (l.agency || '').toLowerCase().replace(/[^a-z0-9]/g, '');

      // Tier 1: Unique internal identifier
      if (seenIds.has(cleanId)) return;

      // Tier 2: Official GTFS routeId
      if (cleanRouteId && seenRouteIds.has(cleanRouteId)) return;

      // Tier 3: Normalized line code + operator keyword
      const agencyKey = normAgency.includes('casas') || normAgency.includes('moventis') ? 'moventis'
        : normAgency.includes('mataro') || normAgency.includes('avanza') ? 'mataro'
        : normAgency.includes('sagales') ? 'sagales'
        : normAgency.includes('tusgsal') ? 'tusgsal'
        : normAgency.includes('renfe') || normAgency.includes('rodalies') ? 'rodalies'
        : normAgency.includes('monbus') || normAgency.includes('igualadina') ? 'monbus'
        : normAgency.slice(0, 8);
      const agencyCodeKey = `${agencyKey}_${normCode}`;
      if (seenCodesByAgency.has(agencyCodeKey)) return;

      // Tier 4: Canonical deduplication for prominent lines
      const isProminentLine = ['e111', 'e112', 'c10', 'c20', 'c30', 'c3', 'c12', 'c14', 'c15', 'n80', 'n81', '865', 'n82', 'n83', 'e13'].includes(normCode);
      if (isProminentLine && seenCodesByAgency.has(`prominent_${normCode}`)) return;

      seenIds.add(cleanId);
      if (cleanRouteId) seenRouteIds.add(cleanRouteId);
      seenCodesByAgency.add(agencyCodeKey);
      if (isProminentLine) seenCodesByAgency.add(`prominent_${normCode}`);

      allCombined.push(l);
    };

    // 1. Authoritative specialized trackers first
    const c10CanonicalLine = {
      id: 'c10',
      routeId: 'GEN_0498',
      code: 'C-10',
      name: 'Barcelona ⇄ Mataró (per N-II)',
      color: '#009485',
      agency: 'Moventis / Casas (Interurbà Maresme)',
      group: 'moventis',
      directions: [
        { dirId: '1', name: "Cap a Mataró (Hospital / Pl. d'Itàlia)" },
        { dirId: '0', name: "Cap a Barcelona (Metro la Pau)" }
      ]
    };

    const c10Entry = this.providers.get('c10');
    if (c10Entry) {
      if (typeof c10Entry.tracker.getLines === 'function') {
        const lines = c10Entry.tracker.getLines();
        if (Array.isArray(lines) && lines.length > 0) lines.forEach(addLine);
        else addLine(c10CanonicalLine);
      } else {
        addLine(c10CanonicalLine);
      }
    }

    const priorityProviders = ['maresme', 'mataro', 'rodalies', 'sagales', 'amb'];
    for (const key of priorityProviders) {
      const entry = this.providers.get(key);
      if (entry && typeof entry.tracker.getLines === 'function') {
        const lines = entry.tracker.getLines();
        if (Array.isArray(lines)) lines.forEach(addLine);
      }
    }

    // 2. Generic Catalonia Fallback Catalog / Warm Snapshot
    const catEntry = this.providers.get('catalonia');
    let catLines = (catEntry && typeof catEntry.tracker.getLines === 'function') ? catEntry.tracker.getLines() : [];
    if (!Array.isArray(catLines) || catLines.length === 0) {
      catLines = this.loadWarmSnapshotCatalog();
    }
    if (Array.isArray(catLines)) {
      catLines.forEach(addLine);
    }

    this.cachedLines = allCombined;
    this.lastCacheTime = now;
    return allCombined;
  }

  /**
   * Search stops and lines across all registered trackers.
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
      const agency = String(l.agency || '').toLowerCase();
      const normCode = code.replace(/[-_\s\.]/g, '');
      const normId = id.replace(/[-_\s\.]/g, '');
      if (q.length === 1) {
        return code === q || normCode === normQ || code.startsWith(q) || normCode.startsWith(normQ);
      }
      return code.includes(q) || normCode.includes(normQ) || id.includes(q) || normId.includes(normQ) || name.includes(q) || agency.includes(q);
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

    matchingLines.slice(0, 6).forEach(l => {
      results.push({
        type: 'line',
        isLine: true,
        lineId: l.id,
        lineCode: l.code,
        lineName: l.name,
        lineColor: l.color || '#009485',
        agency: l.agency || 'Xarxa de Transport',
        zone: `🚌 Línia • ${l.agency || 'Transport'}`,
        isTrain: Boolean(l.isTrain || l.group === 'rodalies' || l.group === 'renfe')
      });
    });

    // 2. Search stops across all provider stopsMap
    for (const [key, entry] of this.providers.entries()) {
      if (results.length >= limit) break;
      const stopMap = entry.tracker.allStopsMap || entry.tracker.stationsMap || entry.tracker.stopsMap;
      if (stopMap && typeof stopMap.forEach === 'function') {
        stopMap.forEach(s => {
          if (results.length >= limit || !s) return;
          const sName = (s.name || s.cleanName || '').toLowerCase();
          const sCode = String(s.code || s.id || '').toLowerCase();
          if (sName.includes(q) || sCode.includes(q)) {
            results.push({
              type: 'stop',
              lineId: s.lineId || key,
              lineCode: s.lineCode || s.code || key.toUpperCase(),
              lineName: s.name || s.cleanName,
              lineColor: s.lineColor || '#009485',
              stopId: s.id || s.code,
              stopName: s.name,
              code: s.code || s.id,
              zone: s.zone || entry.meta.agency || 'Zona Transit',
              isTrain: Boolean(s.isTrain || entry.meta.isTrain),
              lat: s.lat,
              lon: s.lon
            });
          }
        });
      }
    }

    return results.slice(0, limit);
  }
}

// Export singleton instance initialized with default providers
const trackerRegistry = new TrackerRegistry();
trackerRegistry.TrackerRegistry = TrackerRegistry;
module.exports = trackerRegistry;
