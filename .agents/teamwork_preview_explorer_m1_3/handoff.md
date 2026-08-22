# Handoff Report: BaseTracker & TrackerRegistry Design Specifications (M1-3)

**Explorer**: Explorer M1-3 — BaseTracker & TrackerRegistry Specialist  
**Timestamp**: 2026-08-21T21:41:00Z  
**Working Directory**: `h:/Coding/C10Data/.agents/teamwork_preview_explorer_m1_3/`  
**Target Milestone**: Milestone 1 (Shared Transit Core Modules)  
**Authoritative References**: `h:/Coding/C10Data/ORIGINAL_REQUEST.md`, `h:/Coding/C10Data/PROJECT.md`

---

## 1. Observation

A systematic review of `server.js` and all existing tracker modules in `src/` revealed the exact mechanisms currently used for tracker lifecycle management, polymorphic line resolution, and `direction === 'both'` response synthesis:

### 1.1 Tracker Lifecycle Across Operators
- **`server.js` (lines 38–48)**: Eagerly pre-initializes async trackers at startup:
  ```javascript
  routeCacheService.initDailyCache();
  Promise.allSettled([
    ambTracker.init(),
    rodaliesTracker.init(),
    cataloniaTracker.init()
  ]).then(() => {
    console.log('[TransitPlatform] All Multi-Provider Trackers Initialized.');
    ingestionDaemon.start();
  });
  ```
- **Async vs Sync Initialization**:
  - `ambTracker.js` (lines 97–140): Async `init()` loads `/gtfs/routes-and-stops` from `api.ambmobilitat.cat` and builds `routesMap` and `stopsMap`.
  - `rodaliesTracker.js` (lines 79–185): Async `init()` loads `/gtfs/routes-and-stops` (renfe group) and indexes stations into `stationsMap` and `allStopsMap`.
  - `cataloniaTracker.js` (lines 25–119): Async `init()` checks JSON cache files (`routes.json`, `route_details.json`, `calendar.json`), invokes `indexer.buildIndex()` if missing, and connects to SQLite `data/shapes.db`.
  - `corridorTracker.js` (lines 48, 101–148): Synchronous `loadData()` in constructor; loads static arrays, SQLite shapes (`shapes.db`), and `loadCalendarSync()`.
  - `mataroTracker.js` (lines 60–120): Synchronous constructor loading `mataro_routes.json`, `mataro_lines.json`, `mataro_stops.json`.
  - `maresmeTracker.js` (lines 199, 231–300): Lazy `loadData()` in methods reading `maresme_cache.json` or `atm_gtfs` files.
  - `sagalesTracker.js` (lines 120–125): Constructor configures `SAGALES_LINES_CONFIG` and in-memory caches.
- **Real-Time Caching Patterns**:
  - `ambTracker.js` (line 55): `cacheTtlMs = 10000` (10s TTL)
  - `rodaliesTracker.js` (line 40): `cacheTtlMs = 15000` (15s TTL)
  - `sagalesTracker.js` (line 123): `cacheTtlMs = 12000` (12s TTL)
  - `corridorTracker.js` (line 98): `liveTrackingCache = new Map()` (dir -> `{ data, timestamp }`)

### 1.2 Polymorphic Line Resolution in `server.js`
- **`server.js` (lines 56–70)**: Defines `getTrackerForLine(lineId)`:
  ```javascript
  function getTrackerForLine(lineId) {
    const cleanId = String(lineId).toLowerCase().trim();
    if (cleanId === 'c10' || cleanId === 'c-10') return { type: 'c10', tracker: corridorTracker };

    // Mataró urban bus L1..L8 must be checked before AMB since AMB also has numeric codes
    const mataroId = cleanId.replace(/^l(?=[1-8]$)/, ''); // strip leading 'l' from l1..l8
    if (/^[1-8]$/.test(mataroId)) return { type: 'mataro', tracker: mataroTracker };

    if (maresmeTracker.resolveLine(cleanId)) return { type: 'maresme', tracker: maresmeTracker };
    if (rodaliesTracker.resolveLine(cleanId)) return { type: 'rodalies', tracker: rodaliesTracker };
    if (ambTracker.resolveLine(cleanId)) return { type: 'amb', tracker: ambTracker };
    if (sagalesTracker.resolveLineConfig(cleanId)) return { type: 'sagales', tracker: sagalesTracker };
    if (cataloniaTracker.resolveLine(cleanId)) return { type: 'catalonia', tracker: cataloniaTracker };
    return { type: 'catalonia', tracker: cataloniaTracker };
  }
  ```
- **Line Resolution Hierarchy**:
  1. `c10` / `c-10` (Specialized corridor tracker)
  2. `mataro` (L1–L8 urban lines, regex `/^[1-8]$/`)
  3. `maresme` (Moventis / Casas: N80, N81, e11.1, e11.2, C-20, C-30, C-3/C-4, C-12, C-14, C-15, 865)
  4. `rodalies` (Renfe / Rodalies: R1, R2, R2Nord, R2Sud, R3, R4, R7, R8, RG1, RL1, RL2, RL3, RL4, RT1, RT2)
  5. `amb` (AMB Mobilitat: M27, B24, B25, L80, A1, A2, NitBus N0–N28, etc.)
  6. `sagales` (Sagalés: N82, N83, e13, 302, 303, 603, 627)
  7. `catalonia` (Universal fallback for all interurban lines across Catalonia)

### 1.3 `direction === 'both'` Handling Duplication
Every tracker implements custom, repetitive code when `direction === 'both'`:
- **`src/ambTracker.js` (lines 361–396)**:
  ```javascript
  if (direction === 'both' && route.directions?.length > 1) {
    const details0 = await this.getLineDetails(lineId, '0');
    const details1 = await this.getLineDetails(lineId, '1');
    const seenVehs = new Set();
    const seenLocations = new Set();
    const combinedActiveBuses = [];
    [...(details0.activeBuses || []), ...(details1.activeBuses || [])].forEach(b => {
      if (!b) return;
      const locKey = (b.isEstimated && typeof b.lat === 'number' && typeof b.lon === 'number') ? `${b.lat.toFixed(4)}_${b.lon.toFixed(4)}` : null;
      if (b.vehicleId && seenVehs.has(b.vehicleId)) return;
      if (locKey && seenLocations.has(locKey)) return;
      if (b.vehicleId) seenVehs.add(b.vehicleId);
      if (locKey) seenLocations.add(locKey);
      combinedActiveBuses.push(b);
    });
    return {
      ...details0,
      direction: 'both',
      directionName: 'Ambdós sentits',
      stops: details0.stops,
      coords: details0.coords,
      secondaryStops: details1.stops,
      secondaryCoords: details1.coords,
      secondaryColor: '#38bdf8',
      allDirections: [
        { dirId: '0', name: route.directions[0]?.name || 'Sentit 1', stops: details0.stops, coords: details0.coords },
        { dirId: '1', name: route.directions[1]?.name || 'Sentit 2', stops: details1.stops, coords: details1.coords }
      ],
      activeBuses: combinedActiveBuses,
      totalActiveBuses: combinedActiveBuses.length
    };
  }
  ```
- **`src/mataroTracker.js` (lines 258–266, 294–307)**:
  Splits live vehicles across routes `0` and `1`, performs dead-reckoning on each, combines results, and populates `secondaryCoords`, `secondaryStops`, `secondaryColor: '#38bdf8'`.
- **`src/maresmeTracker.js` (lines 395–438)**:
  Queries `details0` and `details1`, combines buses with Set deduplication, sets `secondaryColor: '#38bdf8'`, `secondaryStops`, `secondaryCoords`.
- **`src/sagalesTracker.js` (lines 206–237)**:
  Queries `details0` and `details1`, deduplicates active buses, returns `secondaryStops`, `secondaryCoords`.
- **`src/cataloniaTracker.js` (lines 238–260)**:
  Queries `details0` and `details1`, merges active buses and sets `secondaryColor: '#38bdf8'`.
- **`server.js` (lines 379–418)**:
  Contains inline special-cased `direction === 'both'` logic specifically for `c10` instead of delegating to `corridorTracker.getLineDetails('c10', 'both')`.

### 1.4 Bus Deduplication Patterns Across Trackers
- `mataroTracker.js` (lines 274–287): Live GPS entries must strictly take precedence over dead-reckoning estimates for the same `vehicleId` / `tripId`.
- `ambTracker.js` (lines 365–378): Deduplicates by `vehicleId` and by coordinate proximity (`${b.lat.toFixed(4)}_${b.lon.toFixed(4)}`) for estimated buses.
- `maresmeTracker.js` (lines 411–423): Deduplicates by `b.tripId || b.vehicleId || `${b.lat}_${b.lon}``.
- `sagalesTracker.js` (lines 210–219): Deduplicates by `b.vehicleId || b.tripId || `${b.lat}_${b.lon}``.

### 1.5 Checkpoint & ServiceStatus Generation
- **Checkpoints**:
  - `ambTracker.js` (line 587), `cataloniaTracker.js` (line 311), `sagalesTracker.js` (line 343), `rodaliesTracker.js` (line 345): Sample stops with `stepInterval = Math.max(1, Math.floor(stops.length / 8))` (always including origin `i === 0` and destination `i === stops.length - 1`).
  - `corridorTracker.js` (lines 74–96, 1047–1101): Configures key interurban stops (Barcelona Metro la Pau, Badalona Pompeu Fabra, Montgat Rodalies, El Masnou, Premià de Mar, Vilassar de Mar, Mataró Porta Laietana, Mataró Pl. Granollers, Mataró Pl. d'Itàlia) and computes `isPassed`, `hasBus`, `etaMinutes`, `nextBus`.
- **ServiceStatus**:
  - Trackers compute:
    - `isOperating`: boolean indicating active live buses or upcoming trips.
    - `firstServiceTomorrow`: string `HH:MM`.
    - `calendarTag`: string tag (e.g. `'Feiners lectius (Dilluns a Divendres)'`, `'Dissabtes i Festius'`).
    - `statusText`: human-readable status badge.
    - `nextOperatingDayText`: string describing the next departure day.

---

## 2. Logic Chain

1. **Premise 1 (Inheritance & Polymorphism)**:
   - All 7 tracker modules need the same high-level behavior: loading lines, resolving line configurations, querying single-direction or both-direction route geometries, deduplicating live buses, generating checkpoint milestones, evaluating service status, calculating target stop countdowns, and serving stop departures.
   - An abstract base class `BaseTracker` in `src/core/BaseTracker.js` eliminates hundreds of lines of boilerplate and ensures that new operators automatically inherit standard behaviors (`direction === 'both'`, dual-property compatibility formatting, deduplication, error handling).

2. **Premise 2 (Template Method Pattern for Direction Handling)**:
   - By implementing `getLineDetails(lineId, direction = '0')` in `BaseTracker` with automatic delegation to `handleBothDirections(lineId)` when `direction === 'both'`, individual tracker subclasses only need to implement `getRawLineData(lineId, direction)` or `getSingleDirectionDetails(lineId, direction)`.
   - `handleBothDirections` queries direction `0` and direction `1` in parallel, applies `deduplicateBuses()`, merges `allDirections`, sets `secondaryStops`, `secondaryCoords`, and assigns `secondaryColor: '#38bdf8'`.

3. **Premise 3 (Deterministic Bus Deduplication Strategy)**:
   - Deduplication must reconcile two data sources: raw live GPS telemetry and synthetic/dead-reckoning vehicle estimations.
   - Algorithm rules:
     a. Primary key: `vehicle.vehicleId` or `vehicle.tripId` or `vehicle.id`.
     b. Quality precedence: Real live GPS (`isEstimated !== true` or `isRealTime === true`) strictly overrides an estimated position with the same ID.
     c. Proximity fallback: If IDs are absent or generic, dead-reckoned vehicles within ~10 meters (`lat.toFixed(4)_lon.toFixed(4)`) are merged to prevent map ghosting.

4. **Premise 4 (Decoupled Operator Registry in `TrackerRegistry.js`)**:
   - `server.js` currently embeds `getTrackerForLine(lineId)` and `getAllTransitLines()` directly (lines 56–151).
   - Moving this into `src/core/TrackerRegistry.js`:
     - Centralizes all operator registrations and metadata.
     - Provides `getTrackerForLine(lineId)` returning `{ type, tracker, lineId, cleanCode, agency, isTrain, color, lineConfig }` preserving existing consumer access to `.type` and `.tracker`.
     - Provides `getAllLines()` with the 4-tier deduplication algorithm (seen IDs, seen GTFS routeIds, operator+code keys, prominent lines).
     - Provides `initAll()` for asynchronous startup coordination.
     - Provides `searchStopsAndLines(query)` unifying stop & station search across all transit operators.

---

## 3. Caveats

1. **C-10 Corridor Tracker Nuance**:
   - `corridorTracker.js` uses custom fixed checkpoint definitions with manual GTFS stop IDs (`GEN_PF...`). `BaseTracker.buildCheckpoints` must allow trackers to pass custom checkpoint arrays while defaulting to auto-sampling when custom checkpoints are not provided.
2. **Dual-Property Compatibility**:
   - `corridorTracker` historically used `isRealtime` and `delayMinutes`, whereas other trackers used `isRealTime` and `delayMins`. `BaseTracker.normalizeVehicle()` and `BaseTracker.normalizeDeparture()` must always populate both variants simultaneously.
3. **No Direct Code Modifications in Exploration Turn**:
   - As an explorer agent, no application source files are modified during this turn. All code definitions below are specifications ready for Milestone 1 implementation.

---

## 4. Conclusion & Complete Implementation Specifications

### 4.1 Specification for `src/core/BaseTracker.js`

```javascript
/**
 * src/core/BaseTracker.js
 * 
 * Abstract Base Class for Transit Trackers in Catalonia.
 * Provides unified template methods, direction === 'both' handling,
 * bus deduplication, milestone checkpoints, and service status synthesis.
 */

const timeEngine = require('./time/timeEngine');
const calendarEngine = require('./time/calendarEngine');
const geoEngine = require('./geo/geoEngine');
const delayEngine = require('./schedule/delayEngine');

class BaseTracker {
  /**
   * @param {Object} [options]
   * @param {string} [options.agencyTimezone='Europe/Madrid']
   * @param {number} [options.cacheTtlMs=10000]
   */
  constructor(options = {}) {
    this.agencyTimezone = options.agencyTimezone || 'Europe/Madrid';
    this.cacheTtlMs = options.cacheTtlMs || 10000;
    this.isInitialized = false;

    // In-memory caches and lookup maps
    this.realtimeCache = new Map();
    this.routesMap = new Map();
    this.stopsMap = new Map();
    this.allStopsMap = new Map();
    this.shapesCache = new Map();
  }

  // =========================================================================
  // 1. LIFECYCLE & ABSTRACT TEMPLATE METHODS (Subclasses implement/override)
  // =========================================================================

  /**
   * Asynchronously initialize routes, stops, schedules, or SQLite shapes.
   * @returns {Promise<void>}
   */
  async init() {
    if (this.isInitialized) return;
    this.isInitialized = true;
  }

  /**
   * Resolve a line identifier to an internal route/line configuration.
   * @param {string|number} lineId
   * @returns {Object|null}
   */
  resolveLine(lineId) {
    if (!lineId) return null;
    const clean = String(lineId).toLowerCase().trim().replace(/^(line-|linia-)/, '');
    return this.routesMap.get(clean) || this.routesMap.get(String(lineId)) || null;
  }

  /**
   * Get all supported line catalog entries for this tracker.
   * @returns {Array<Object>}
   */
  getLines() {
    return Array.from(this.routesMap.values());
  }

  /**
   * Abstract: Fetch live real-time vehicles for a given line from upstream API.
   * @param {string|number} lineId
   * @returns {Promise<Array<Object>>}
   */
  async fetchLiveVehicles(lineId) {
    throw new Error(`fetchLiveVehicles() not implemented in ${this.constructor.name}`);
  }

  /**
   * Abstract: Fetch real-time arrivals at a specific stop for a line and direction.
   * @param {string|number} stopId
   * @param {string|number} [lineId]
   * @param {string} [direction='0']
   * @returns {Promise<Array<Object>>}
   */
  async fetchStopArrivals(stopId, lineId, direction = '0') {
    throw new Error(`fetchStopArrivals() not implemented in ${this.constructor.name}`);
  }

  /**
   * Abstract: Fetch raw geometry, stops, and schedule data for line/direction.
   * @param {string|number} lineId
   * @param {string} [direction='0']
   * @returns {Promise<Object>} { stops: [], polylineCoords: [], directions: [], lineConfig: {} }
   */
  async getRawLineData(lineId, direction = '0') {
    throw new Error(`getRawLineData() not implemented in ${this.constructor.name}`);
  }

  // =========================================================================
  // 2. UNIFIED LINE DETAILS & DIRECTION === 'BOTH' MERGING
  // =========================================================================

  /**
   * Main entrypoint: Get line details, polyline, stops, active buses, and checkpoints.
   * Automatically intercepts direction === 'both' and delegates to handleBothDirections.
   * 
   * @param {string|number} lineId
   * @param {string} [direction='0']
   * @returns {Promise<Object>}
   */
  async getLineDetails(lineId, direction = '0') {
    await this.init();

    if (direction === 'both') {
      return this.handleBothDirections(lineId);
    }

    return this.getSingleDirectionDetails(lineId, direction);
  }

  /**
   * Get line details for a single direction (0 or 1).
   * @param {string|number} lineId
   * @param {string} direction
   * @returns {Promise<Object>}
   */
  async getSingleDirectionDetails(lineId, direction = '0') {
    const raw = await this.getRawLineData(lineId, direction);
    if (!raw || !raw.lineConfig) {
      throw new Error(`Line ${lineId} not found in ${this.constructor.name}`);
    }

    const { lineConfig, stops = [], polylineCoords = [], directions = [] } = raw;
    const dirIdx = String(direction);

    // Fetch live vehicles
    let activeBuses = [];
    try {
      activeBuses = await this.fetchLiveVehicles(lineId);
    } catch (e) {
      console.warn(`[${this.constructor.name}] Live vehicles unavailable for ${lineId}: ${e.message}`);
    }

    // Filter buses by direction if vehicle has direction info
    const busesForDir = activeBuses.filter(b => b.direction === undefined || String(b.direction) === dirIdx);
    const dedupedBuses = this.deduplicateBuses(busesForDir.map(b => this.normalizeVehicle(b)));

    // Generate checkpoints
    const checkpoints = this.buildCheckpoints(stops, dedupedBuses, raw.customCheckpoints);

    // Generate calendar & service status
    const calInfo = this.getServiceCalendarInfo(new Date());
    const serviceStatus = this.buildServiceStatus(calInfo, [], dedupedBuses);

    const dirMeta = directions.find(d => String(d.dirId) === dirIdx) || directions[0] || {};

    return {
      id: lineConfig.id || String(lineId),
      code: lineConfig.code || String(lineId),
      name: lineConfig.name || `Línia ${lineId}`,
      color: lineConfig.color || '#009485',
      agency: lineConfig.agency || 'Xarxa de Transport',
      group: lineConfig.group || 'transit',
      isTrain: Boolean(lineConfig.isTrain),
      direction: dirIdx,
      directionName: dirMeta.name || (dirIdx === '1' ? 'Sentit Tornada' : 'Sentit Anada'),
      directions: directions,
      stops: stops,
      coords: polylineCoords,
      polyline: polylineCoords,
      activeBuses: dedupedBuses,
      totalActiveBuses: dedupedBuses.length,
      totalVehiclesInCircuit: dedupedBuses.length,
      checkpoints: checkpoints,
      calendarInfo: calInfo,
      serviceStatus: serviceStatus
    };
  }

  /**
   * Automatically resolve both directions, combine active buses, and construct dual-direction response.
   * @param {string|number} lineId
   * @returns {Promise<Object>}
   */
  async handleBothDirections(lineId) {
    const [details0, details1] = await Promise.all([
      this.getSingleDirectionDetails(lineId, '0').catch(() => null),
      this.getSingleDirectionDetails(lineId, '1').catch(() => null)
    ]);

    const primary = details0 || details1;
    if (!primary) {
      throw new Error(`Unable to fetch line details for ${lineId} in both directions.`);
    }

    // If only one direction exists (e.g. circular route)
    if (!details1 || !details0) {
      return primary;
    }

    // Deduplicate combined buses
    const rawCombinedBuses = [...(details0.activeBuses || []), ...(details1.activeBuses || [])];
    const combinedActiveBuses = this.deduplicateBuses(rawCombinedBuses);

    const dir0Name = details0.directionName || details0.directions?.[0]?.name || 'Sentit 1';
    const dir1Name = details1.directionName || details1.directions?.[1]?.name || 'Sentit 2';

    return {
      id: primary.id,
      code: primary.code,
      name: primary.name,
      color: primary.color,
      secondaryColor: '#38bdf8',
      agency: primary.agency,
      group: primary.group,
      isTrain: Boolean(primary.isTrain),
      direction: 'both',
      directionName: 'Ambdós sentits',
      directions: primary.directions,
      stops: details0.stops,
      coords: details0.coords,
      polyline: details0.polyline,
      secondaryStops: details1.stops,
      secondaryCoords: details1.coords,
      secondaryPolyline: details1.polyline,
      allDirections: [
        { dirId: '0', name: dir0Name, stops: details0.stops, coords: details0.coords, polyline: details0.polyline },
        { dirId: '1', name: dir1Name, stops: details1.stops, coords: details1.coords, polyline: details1.polyline }
      ],
      activeBuses: combinedActiveBuses,
      totalActiveBuses: combinedActiveBuses.length,
      totalVehiclesInCircuit: combinedActiveBuses.length,
      checkpoints: details0.checkpoints || [],
      calendarInfo: details0.calendarInfo || details1.calendarInfo,
      serviceStatus: {
        isOperating: (details0.serviceStatus?.isOperating || details1.serviceStatus?.isOperating || combinedActiveBuses.length > 0),
        firstServiceTomorrow: details0.serviceStatus?.firstServiceTomorrow || '06:00',
        calendarTag: details0.serviceStatus?.calendarTag || primary.calendarInfo?.calendarTag || 'Servei Regular'
      }
    };
  }

  // =========================================================================
  // 3. BUS DEDUPLICATION & NORMALIZATION
  // =========================================================================

  /**
   * Strictly deduplicate active vehicles:
   * - Prioritizes Real GPS over Dead-Reckoning estimations for matching vehicleId/tripId.
   * - Deduplicates by coordinate proximity for estimated positions.
   * 
   * @param {Array<Object>} buses
   * @returns {Array<Object>}
   */
  deduplicateBuses(buses = []) {
    if (!Array.isArray(buses) || buses.length <= 1) return buses || [];

    const mapById = new Map();
    const seenLocations = new Set();
    const result = [];

    buses.forEach(b => {
      if (!b) return;
      const vId = b.vehicleId ? String(b.vehicleId) : (b.tripId ? String(b.tripId) : (b.id ? String(b.id) : null));
      const isEst = Boolean(b.isEstimated);

      if (vId) {
        if (!mapById.has(vId)) {
          mapById.set(vId, b);
        } else {
          const existing = mapById.get(vId);
          // If existing is estimated and new is real GPS, replace it
          if (existing.isEstimated && !isEst) {
            mapById.set(vId, b);
          }
        }
      } else {
        // Fallback: Deduplicate estimated proximity coordinates
        const locKey = (typeof b.lat === 'number' && typeof b.lon === 'number')
          ? `${b.lat.toFixed(4)}_${b.lon.toFixed(4)}`
          : null;

        if (locKey) {
          if (!seenLocations.has(locKey)) {
            seenLocations.add(locKey);
            result.push(b);
          }
        } else {
          result.push(b);
        }
      }
    });

    return [...Array.from(mapById.values()), ...result];
  }

  /**
   * Normalizes vehicle schema to satisfy all frontend and analytics contracts.
   * @param {Object} raw
   * @returns {Object}
   */
  normalizeVehicle(raw = {}) {
    const lat = typeof raw.lat === 'number' ? raw.lat : parseFloat(raw.lat || 0);
    const lon = typeof raw.lon === 'number' ? raw.lon : parseFloat(raw.lon || 0);
    const bearing = typeof raw.bearing === 'number' ? raw.bearing : 0;
    const compass = geoEngine.getCompassDirection(bearing);
    const delayMins = raw.delayMins !== undefined ? raw.delayMins : (raw.delayMinutes !== undefined ? raw.delayMinutes : 0);
    const isReal = raw.isRealTime !== undefined ? Boolean(raw.isRealTime) : (raw.isRealtime !== undefined ? Boolean(raw.isRealtime) : !raw.isEstimated);

    return {
      tripId: raw.tripId || raw.vehicleId || 'trip_unknown',
      vehicleId: raw.vehicleId || raw.tripId || 'veh_unknown',
      lat: Math.round(lat * 1000000) / 1000000,
      lon: Math.round(lon * 1000000) / 1000000,
      bearing: bearing,
      compass: raw.compass || compass,
      speedKmh: raw.speedKmh !== undefined ? raw.speedKmh : (raw.speed !== undefined ? raw.speed : 0),
      speed: raw.speedKmh !== undefined ? raw.speedKmh : 0,
      fromStop: raw.fromStop || null,
      toStop: raw.toStop || null,
      fromCoords: raw.fromCoords || null,
      toCoords: raw.toCoords || null,
      totalProgress: raw.totalProgress !== undefined ? raw.totalProgress : 0,
      delayMins: delayMins,
      delayMinutes: delayMins,
      delayStatus: raw.delayStatus || 'on_time',
      delayBadgeText: raw.delayBadgeText || 'A l\'hora',
      delayFormatted: raw.delayFormatted || (delayMins > 0 ? `+${delayMins} min` : 'A l\'hora'),
      formattedStatus: raw.formattedStatus || (delayMins > 0 ? `+${delayMins} min` : 'A l\'hora'),
      isRealTime: isReal,
      isRealtime: isReal,
      isEstimated: Boolean(raw.isEstimated),
      isTerminalLayover: Boolean(raw.isTerminalLayover),
      direction: raw.direction !== undefined ? String(raw.direction) : '0',
      lastUpdate: raw.lastUpdate || new Date().toISOString()
    };
  }

  // =========================================================================
  // 4. CHECKPOINTS & SERVICE STATUS
  // =========================================================================

  /**
   * Build milestone checkpoints along route.
   * @param {Array<Object>} stops
   * @param {Array<Object>} activeBuses
   * @param {Array<Object>} [customCheckpoints]
   * @returns {Array<Object>}
   */
  buildCheckpoints(stops = [], activeBuses = [], customCheckpoints = null) {
    if (customCheckpoints && Array.isArray(customCheckpoints)) {
      return customCheckpoints;
    }

    if (!stops || stops.length === 0) return [];

    const stepInterval = Math.max(1, Math.floor(stops.length / 8));
    return stops
      .filter((s, i) => i === 0 || i === stops.length - 1 || i % stepInterval === 0)
      .map(s => {
        const hasBus = activeBuses.some(b => b.toStop === s.name || b.fromStop === s.name);
        return {
          id: s.id || s.code,
          gtfsStopId: s.gtfsStopId || s.id,
          name: s.name,
          seq: s.seq,
          zone: s.zone || 'Zona Transit',
          isPassed: false,
          hasBus: hasBus,
          etaMinutes: 0
        };
      });
  }

  /**
   * Build uniform service status badge & operational state.
   * @param {Object} calendarInfo
   * @param {Array<Object>} departures
   * @param {Array<Object>} [activeBuses=[]]
   * @returns {Object}
   */
  buildServiceStatus(calendarInfo = {}, departures = [], activeBuses = []) {
    const upcoming = departures.filter(d => !d.isPast);
    const isOperating = (activeBuses && activeBuses.length > 0) || upcoming.length > 0 || (new Date().getHours() >= 6 && new Date().getHours() < 22);

    return {
      isOperating: isOperating,
      firstServiceTomorrow: '06:00',
      calendarTag: calendarInfo?.calendarTag || 'Servei Regular',
      statusText: isOperating ? '🟢 En servei' : '🔴 Fora de servei',
      nextOperatingDayText: isOperating ? 'En servei' : 'Demà'
    };
  }

  /**
   * Helper: Get current service calendar metadata.
   * @param {Date} [targetDate=new Date()]
   * @returns {Object}
   */
  getServiceCalendarInfo(targetDate = new Date()) {
    const dateComp = timeEngine.getDateComponents(targetDate, this.agencyTimezone);
    const dayType = dateComp.isSunday ? 'Diumenge / Festiu' : (dateComp.isSaturday ? 'Dissabte' : 'Feiner');
    return {
      serviceId: dateComp.isWeekend ? 'weekend' : 'weekday',
      name: dayType,
      frequency: 'Cada 15-30 min',
      frequencyMinutes: 20,
      isWeekend: dateComp.isWeekend,
      calendarTag: `${dayType} (${dateComp.dateStr})`,
      dateFormatted: dateComp.dateStr
    };
  }

  /**
   * Helper: Normalizes stop departure response envelope.
   * @param {Object} raw
   * @returns {Object}
   */
  normalizeDeparture(raw = {}) {
    const delayMins = raw.delayMins !== undefined ? raw.delayMins : (raw.delayMinutes !== undefined ? raw.delayMinutes : 0);
    const isReal = raw.isRealTime !== undefined ? Boolean(raw.isRealTime) : (raw.isRealtime !== undefined ? Boolean(raw.isRealtime) : !raw.isEstimated);

    return {
      lineId: raw.lineId || '',
      lineCode: raw.lineCode || raw.lineId || '',
      lineName: raw.lineName || '',
      destination: raw.destination || 'Destí',
      direction: raw.direction !== undefined ? String(raw.direction) : '0',
      departureTime: raw.departureTime || '--:--',
      scheduledTime: raw.scheduledTime || raw.departureTime || '--:--',
      expectedIso: raw.expectedIso || null,
      aimedIso: raw.aimedIso || raw.expectedIso || null,
      minutesAway: raw.minutesAway !== undefined ? raw.minutesAway : 0,
      formattedStatus: raw.formattedStatus || (raw.minutesAway === 0 ? 'Imminent' : `${raw.minutesAway} min`),
      isRealTime: isReal,
      isRealtime: isReal,
      isEstimated: Boolean(raw.isEstimated),
      isToday: raw.isToday !== undefined ? Boolean(raw.isToday) : true,
      isFirstOfDay: Boolean(raw.isFirstOfDay),
      isNextService: Boolean(raw.isNextService),
      delayMins: delayMins,
      delayMinutes: delayMins,
      delayStatus: raw.delayStatus || 'on_time',
      delayBadgeText: raw.delayBadgeText || 'A l\'hora',
      vehicleId: raw.vehicleId || null,
      busCoords: raw.busCoords || null
    };
  }
}

module.exports = BaseTracker;
```

---

### 4.2 Specification for `src/core/TrackerRegistry.js`

```javascript
/**
 * src/core/TrackerRegistry.js
 * 
 * Centralized Tracker Registry & Multi-Provider Dispatcher.
 * Handles polymorphic line resolution, 4-tier line deduplication,
 * multi-agency asynchronous initialization, and universal stop search.
 */

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
   * @param {string} providerKey Unique key ('c10', 'mataro', 'maresme', 'rodalies', 'sagales', 'amb', 'catalonia')
   * @param {Object} trackerInstance Subclass of BaseTracker or compatible tracker
   * @param {Object} [metadata={}] Provider metadata (agency, priority, isFallback, etc.)
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
   * Initialize all registered trackers in parallel.
   * @returns {Promise<void>}
   */
  async initAll() {
    if (this.isInitialized) return;
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
   *   tracker: Object,
   *   lineId: string,
   *   cleanCode: string,
   *   agency: string,
   *   isTrain: boolean,
   *   color?: string,
   *   lineConfig?: Object
   * }}
   */
  getTrackerForLine(lineId) {
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
    const rodaliesEntry = this.providers.get('rodalies');
    if (rodaliesEntry && typeof rodaliesEntry.tracker.resolveLine === 'function') {
      const cfg = rodaliesEntry.tracker.resolveLine(cleanId);
      if (cfg) {
        return {
          type: 'rodalies',
          tracker: rodaliesEntry.tracker,
          lineId: cfg.id || cleanId,
          cleanCode: cfg.code || cleanId.toUpperCase(),
          agency: 'Rodalies de Catalunya (Renfe / Gencat)',
          isTrain: true,
          color: cfg.color || '#E54A3C',
          lineConfig: cfg
        };
      }
    }

    // 5. AMB Mobilitat (TUSGSAL, Avanza, Monbus, Baixbus, Soler i Sauret)
    const ambEntry = this.providers.get('amb');
    if (ambEntry && typeof ambEntry.tracker.resolveLine === 'function') {
      const cfg = ambEntry.tracker.resolveLine(cleanId);
      if (cfg) {
        return {
          type: 'amb',
          tracker: ambEntry.tracker,
          lineId: cfg.id || cleanId,
          cleanCode: cfg.code || cleanId.toUpperCase(),
          agency: cfg.agency || 'AMB Mobilitat',
          isTrain: false,
          color: cfg.color || '#009485',
          lineConfig: cfg
        };
      }
    }

    // 6. Sagalés Interurban & Night Bus (N82, N83, e13, 302, 303, 603, 627)
    const sagalesEntry = this.providers.get('sagales');
    if (sagalesEntry && typeof sagalesEntry.tracker.resolveLineConfig === 'function') {
      const cfg = sagalesEntry.tracker.resolveLineConfig(cleanId);
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
   * @returns {Array<Object>}
   */
  getAllLines() {
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
    const priorityProviders = ['c10', 'maresme', 'mataro', 'rodalies', 'sagales', 'amb'];
    for (const key of priorityProviders) {
      const entry = this.providers.get(key);
      if (entry && typeof entry.tracker.getLines === 'function') {
        const lines = entry.tracker.getLines();
        if (Array.isArray(lines)) lines.forEach(addLine);
      }
    }

    // 2. Generic Catalonia Fallback Catalog
    const catEntry = this.providers.get('catalonia');
    if (catEntry && typeof catEntry.tracker.getLines === 'function') {
      const catLines = catEntry.tracker.getLines();
      if (Array.isArray(catLines)) catLines.forEach(addLine);
    }

    this.cachedLines = allCombined;
    this.lastCacheTime = now;
    return allCombined;
  }

  /**
   * Search stops and lines across all registered trackers.
   * @param {string} query
   * @param {number} [limit=35]
   * @returns {Array<Object>}
   */
  searchStopsAndLines(query, limit = 35) {
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
module.exports = trackerRegistry;
```

---

## 5. Verification Method

To independently verify these specifications against the existing codebase:

1. **Verify Line Resolution Completeness**:
   Run line resolution against all sample lines tested in `test/e2e_multiline_test.js`:
   - `c10` -> type `'c10'`, code `'C-10'`
   - `1` / `l8` -> type `'mataro'`, code `'L1'` / `'L8'`
   - `n80` / `e11_1` -> type `'maresme'`, code `'N80'` / `'e11.1'`
   - `r1` / `r4` -> type `'rodalies'`, isTrain `true`
   - `b25` / `l80` / `a1` -> type `'amb'`
   - `n82` / `e13` -> type `'sagales'`
   - `cat_gen_0496` -> type `'catalonia'`

2. **Verify Dual-Property Compatibility**:
   Ensure `normalizeVehicle` and `normalizeDeparture` populate:
   - `isRealTime` AND `isRealtime`
   - `delayMins` AND `delayMinutes`
   - `lat`, `lon` AND `coords: { lat, lon }`
   - `formattedStatus` AND `delayBadgeText`

3. **Verify Zero Regression on Test Suite**:
   Upon implementation in Milestone 1:
   - `node test/verification_test.js` passes 100% with zero errors.
   - `node test/e2e_multiline_test.js` passes 100% with zero errors.
   - `node test/e2e_flight_recorder_test.js` passes 100% with zero errors.
