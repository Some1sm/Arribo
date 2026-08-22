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
   * @param {object} [options={}]
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
   * @returns {object|null}
   */
  resolveLine(lineId) {
    if (!lineId) return null;
    const clean = String(lineId).toLowerCase().trim().replace(/^(line-|linia-)/, '');
    return this.routesMap.get(clean) || this.routesMap.get(String(lineId)) || null;
  }

  /**
   * Get all supported line catalog entries for this tracker.
   * @returns {Array<object>}
   */
  getLines() {
    return Array.from(this.routesMap.values());
  }

  /**
   * Abstract: Fetch live real-time vehicles for a given line from upstream API.
   * @param {string|number} lineId
   * @returns {Promise<Array<object>>}
   */
  async fetchLiveVehicles(lineId) {
    throw new Error(`fetchLiveVehicles() not implemented in ${this.constructor.name}`);
  }

  /**
   * Abstract: Fetch real-time arrivals at a specific stop for a line and direction.
   * @param {string|number} stopId
   * @param {string|number} [lineId]
   * @param {string} [direction='0']
   * @returns {Promise<Array<object>>}
   */
  async fetchStopArrivals(stopId, lineId, direction = '0') {
    throw new Error(`fetchStopArrivals() not implemented in ${this.constructor.name}`);
  }

  /**
   * Abstract: Fetch raw geometry, stops, and schedule data for line/direction.
   * @param {string|number} lineId
   * @param {string} [direction='0']
   * @returns {Promise<object>} { stops: [], polylineCoords: [], directions: [], lineConfig: {} }
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
   * @returns {Promise<object>}
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
   * @param {string} [direction='0']
   * @returns {Promise<object>}
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
   * @returns {Promise<object>}
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
   * @param {Array<object>} [buses=[]]
   * @returns {Array<object>}
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
   * @param {object} [raw={}]
   * @returns {object}
   */
  normalizeVehicle(raw = {}) {
    const r = raw || {};
    const lat = typeof r.lat === 'number' ? r.lat : parseFloat(r.lat || 0);
    const lon = typeof r.lon === 'number' ? r.lon : parseFloat(r.lon || 0);
    const bearing = typeof r.bearing === 'number' ? r.bearing : 0;
    const compass = geoEngine.getCompassDirection(bearing);
    const delayMins = r.delayMins !== undefined ? Number(r.delayMins) : (r.delayMinutes !== undefined ? Number(r.delayMinutes) : 0);
    const isReal = r.isRealTime !== undefined ? Boolean(r.isRealTime) : (r.isRealtime !== undefined ? Boolean(r.isRealtime) : !r.isEstimated);

    return {
      tripId: r.tripId || r.vehicleId || 'trip_unknown',
      vehicleId: r.vehicleId || r.tripId || 'veh_unknown',
      lat: Math.round(lat * 1000000) / 1000000,
      lon: Math.round(lon * 1000000) / 1000000,
      bearing: bearing,
      compass: r.compass || compass,
      speedKmh: r.speedKmh !== undefined ? Number(r.speedKmh) : (r.speed !== undefined ? Number(r.speed) : 0),
      speed: r.speedKmh !== undefined ? Number(r.speedKmh) : (r.speed !== undefined ? Number(r.speed) : 0),
      fromStop: r.fromStop || null,
      toStop: r.toStop || null,
      fromCoords: r.fromCoords || null,
      toCoords: r.toCoords || null,
      totalProgress: r.totalProgress !== undefined ? Number(r.totalProgress) : 0,
      delayMins: delayMins,
      delayMinutes: delayMins,
      delayStatus: r.delayStatus || 'on_time',
      delayBadgeText: r.delayBadgeText || 'A l\'hora',
      delayFormatted: r.delayFormatted || (delayMins > 0 ? `+${delayMins} min` : 'A l\'hora'),
      formattedStatus: r.formattedStatus || (delayMins > 0 ? `+${delayMins} min` : 'A l\'hora'),
      isRealTime: isReal,
      isRealtime: isReal,
      isEstimated: Boolean(r.isEstimated),
      isTerminalLayover: Boolean(r.isTerminalLayover),
      direction: r.direction !== undefined ? String(r.direction) : '0',
      lastUpdate: r.lastUpdate || new Date().toISOString()
    };
  }

  // =========================================================================
  // 4. CHECKPOINTS & SERVICE STATUS
  // =========================================================================

  /**
   * Build milestone checkpoints along route.
   * @param {Array<object>} [stops=[]]
   * @param {Array<object>} [activeBuses=[]]
   * @param {Array<object>|null} [customCheckpoints=null]
   * @returns {Array<object>}
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
   * @param {object} [calendarInfo={}]
   * @param {Array<object>} [departures=[]]
   * @param {Array<object>} [activeBuses=[]]
   * @returns {object}
   */
  buildServiceStatus(calendarInfo = {}, departures = [], activeBuses = []) {
    const cal = calendarInfo || {};
    const deps = Array.isArray(departures) ? departures : [];
    const buses = Array.isArray(activeBuses) ? activeBuses : [];
    const upcoming = deps.filter(d => d && !d.isPast);
    // Use agency timezone hour instead of host-local hour so that deployments on
    // UTC servers (e.g. Vercel) still evaluate the 06:00-22:00 service window correctly.
    let localHour;
    try {
      localHour = calendarEngine.getDateComponents(new Date(), this.agencyTimezone).hour;
    } catch (_) {
      localHour = new Date().getHours();
    }
    const isOperating = (buses.length > 0) || upcoming.length > 0 || (localHour >= 6 && localHour < 22);

    return {
      isOperating: isOperating,
      firstServiceTomorrow: '06:00',
      calendarTag: cal.calendarTag || 'Servei Regular',
      statusText: isOperating ? '🟢 En servei' : '🔴 Fora de servei',
      nextOperatingDayText: isOperating ? 'En servei' : 'Demà'
    };
  }

  /**
   * Helper: Get current service calendar metadata.
   * @param {Date|string|number} [targetDate=new Date()]
   * @returns {object}
   */
  getServiceCalendarInfo(targetDate = new Date()) {
    const dateComp = calendarEngine.getDateComponents(targetDate, this.agencyTimezone);
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
   * @param {object} [raw={}]
   * @returns {object}
   */
  normalizeDeparture(raw = {}) {
    return delayEngine.standardizeDeparture(raw);
  }
}

module.exports = BaseTracker;
