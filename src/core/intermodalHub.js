/**
 * Intermodal Connections Hub for Mataró
 * Connects urban Mataró Bus stops with regional rail (Rodalies R1/RG1)
 * and interurban express coaches (Moventis e11.1, e11.2, C-10, C-20, C-30).
 */

const rodaliesTracker = require('../rodaliesTracker');
const maresmeTracker = require('../maresmeTracker');
const corridorTracker = require('../corridorTracker');
const geoEngine = require('./geo/geoEngine');

// Coordinates of key transfer hubs in Mataró
const HUBS_CONFIG = {
  rodalies: {
    id: 'rodalies',
    name: 'Estació de Rodalies Renfe',
    icon: '🚆',
    lat: 41.5331,
    lon: 2.4448,
    radiusMeters: 250,
    stopIds: new Set(['1016', '1058', '16', '58'])
  },
  tereses: {
    id: 'tereses',
    name: 'Plaça de les Tereses',
    icon: '🏛️',
    lat: 41.5383,
    lon: 2.4424,
    radiusMeters: 200,
    stopIds: new Set(['1060', '60'])
  },
  hospital: {
    id: 'hospital',
    name: 'Hospital de Mataró',
    icon: '🏥',
    lat: 41.5553,
    lon: 2.4293,
    radiusMeters: 300,
    stopIds: new Set(['1001', '1002', '1010', '1', '2', '10'])
  }
};

class IntermodalHub {
  constructor() {
    this.isInitialized = false;
    this.cache = new Map(); // hubKey -> { timestamp, data }
    this.cacheTtlMs = 20000; // 20s cache
  }

  async _ensureTrackers() {
    if (this.isInitialized) return;
    try {
      await Promise.allSettled([
        rodaliesTracker.init ? rodaliesTracker.init() : Promise.resolve(),
        maresmeTracker.init ? maresmeTracker.init() : Promise.resolve(),
        corridorTracker.init ? corridorTracker.init() : Promise.resolve()
      ]);
      this.isInitialized = true;
    } catch (_) {}
  }

  /**
   * Identifies if a stop is an intermodal hub
   * @param {string|number} stopId 
   * @param {string} [stopName=''] 
   * @param {number} [lat] 
   * @param {number} [lon] 
   * @returns {object|null} Hub config or null
   */
  matchHub(stopId, stopName = '', lat = null, lon = null) {
    const sId = String(stopId || '').trim();
    const sName = String(stopName || '').toLowerCase();

    for (const hub of Object.values(HUBS_CONFIG)) {
      if (hub.stopIds.has(sId)) return hub;
      if (sName.includes(hub.id) || (hub.id === 'rodalies' && (sName.includes('renfe') || sName.includes('estacio') || sName.includes('estació')))) {
        return hub;
      }
      if (lat !== null && lon !== null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) {
        const dist = geoEngine.calculateDistanceMeters(lat, lon, hub.lat, hub.lon);
        if (dist <= hub.radiusMeters) return hub;
      }
    }
    return null;
  }

  /**
   * Computes connection feasibility between an arriving urban bus and a departure
   * @param {number} depMinutesAway Minutes until external connection leaves
   * @param {number} [arrivalMinutes=0] Minutes until urban bus arrives at hub
   * @returns {{ status: string, badge: string, marginMins: number }}
   */
  calculateFeasibility(depMinutesAway, arrivalMinutes = 0) {
    const margin = depMinutesAway - arrivalMinutes;
    if (margin < 2) {
      return {
        status: 'missed',
        badge: 'Temps insuficient',
        badgeClass: 'conn-missed',
        marginMins: margin
      };
    }
    if (margin <= 4) {
      return {
        status: 'tight',
        badge: `Molt just (${margin} min)`,
        badgeClass: 'conn-tight',
        marginMins: margin
      };
    }
    if (margin <= 20) {
      return {
        status: 'feasible',
        badge: `Enllaç recomanat (${margin} min de marge)`,
        badgeClass: 'conn-feasible',
        marginMins: margin
      };
    }
    return {
      status: 'comfortable',
      badge: `Proper servei (${margin} min d'espera)`,
      badgeClass: 'conn-comfortable',
      marginMins: margin
    };
  }

  /**
   * Fetches real-time connections for a given stop
   * @param {string|number} stopId 
   * @param {object} [options={}]
   * @returns {Promise<{ isHub: boolean, hub?: object, connections: Array }>}
   */
  async getConnectionsForStop(stopId, options = {}) {
    await this._ensureTrackers();

    const hub = this.matchHub(stopId, options.stopName, options.lat, options.lon);
    if (!hub) {
      return { isHub: false, connections: [] };
    }

    const now = Date.now();
    const cached = this.cache.get(hub.id);
    if (cached && (now - cached.timestamp < this.cacheTtlMs)) {
      return {
        isHub: true,
        hub: { id: hub.id, name: hub.name, icon: hub.icon },
        connections: this._enrichFeasibility(cached.data, options.arrivalMinutes)
      };
    }

    const connections = [];

    try {
      if (hub.id === 'rodalies') {
        // 1. Rodalies R1 / RG1 from Estació de Mataró (station ID: 79500)
        try {
          const r1Deps = await rodaliesTracker.getStopDepartures('79500', 'r1');
          if (r1Deps && Array.isArray(r1Deps.departures)) {
            r1Deps.departures.slice(0, 6).forEach(d => {
              connections.push({
                mode: 'train',
                modeLabel: 'Tren Rodalies',
                lineCode: 'R1',
                lineColor: '#7DBCEC',
                operator: 'Rodalies de Catalunya',
                destination: d.destination || 'Barcelona / Maçanet',
                departureTime: d.departureTime,
                minutesAway: d.minutesAway,
                isRealTime: Boolean(d.isRealTime),
                delayBadgeText: d.delayBadgeText || 'Programat',
                delayStatus: d.delayStatus || 'scheduled'
              });
            });
          }
        } catch (_) {}

        // 2. Moventis C-10 (Barcelona - Mataró)
        try {
          const c10Deps = await corridorTracker.getStopDepartures('mataro_renfe', 'c10', '0');
          if (c10Deps && Array.isArray(c10Deps.departures)) {
            c10Deps.departures.slice(0, 3).forEach(d => {
              connections.push({
                mode: 'interurban_bus',
                modeLabel: 'Bus Interurbà',
                lineCode: 'C-10',
                lineColor: '#009485',
                operator: 'Moventis / Casas',
                destination: d.destination || 'Barcelona (Glòries / Sagrera)',
                departureTime: d.departureTime,
                minutesAway: d.minutesAway,
                isRealTime: Boolean(d.isRealTime),
                delayBadgeText: d.delayBadgeText || 'Horari oficial',
                delayStatus: d.delayStatus || 'scheduled'
              });
            });
          }
        } catch (_) {}
      } else if (hub.id === 'tereses') {
        // 1. Moventis e11.1 Exprés (Barcelona Rda. Universitat ⇄ Mataró Tereses)
        try {
          const e111Deps = await maresmeTracker.getStopDepartures('GEN_PF08121020', 'e111', '0');
          if (e111Deps && Array.isArray(e111Deps.departures)) {
            e111Deps.departures.slice(0, 4).forEach(d => {
              connections.push({
                mode: 'express_bus',
                modeLabel: 'Bus Exprés.cat',
                lineCode: 'e11.1',
                lineColor: '#009485',
                operator: 'Moventis Exprés',
                destination: 'Barcelona (Rda. Universitat)',
                departureTime: d.departureTime,
                minutesAway: d.minutesAway,
                isRealTime: Boolean(d.isRealTime),
                delayBadgeText: d.delayBadgeText || 'Horari oficial',
                delayStatus: d.delayStatus || 'scheduled'
              });
            });
          }
        } catch (_) {}

        // 2. Moventis C-10
        try {
          const c10Deps = await corridorTracker.getStopDepartures('mataro_tereses', 'c10', '0');
          if (c10Deps && Array.isArray(c10Deps.departures)) {
            c10Deps.departures.slice(0, 3).forEach(d => {
              connections.push({
                mode: 'interurban_bus',
                modeLabel: 'Bus Interurbà',
                lineCode: 'C-10',
                lineColor: '#009485',
                operator: 'Moventis',
                destination: 'Barcelona (Glòries)',
                departureTime: d.departureTime,
                minutesAway: d.minutesAway,
                isRealTime: Boolean(d.isRealTime),
                delayBadgeText: d.delayBadgeText || 'Horari oficial',
                delayStatus: d.delayStatus || 'scheduled'
              });
            });
          }
        } catch (_) {}
      } else if (hub.id === 'hospital') {
        // 1. Moventis e11.2 Exprés (Barcelona ⇄ Mataró Camí de la Serra / Hospital Nord)
        try {
          const e112Deps = await maresmeTracker.getStopDepartures('MAT_HOSP_NORD', 'e112', '0');
          if (e112Deps && Array.isArray(e112Deps.departures)) {
            e112Deps.departures.slice(0, 4).forEach(d => {
              connections.push({
                mode: 'express_bus',
                modeLabel: 'Bus Exprés.cat',
                lineCode: 'e11.2',
                lineColor: '#009485',
                operator: 'Moventis Exprés',
                destination: 'Barcelona (Rda. Universitat)',
                departureTime: d.departureTime,
                minutesAway: d.minutesAway,
                isRealTime: Boolean(d.isRealTime),
                delayBadgeText: d.delayBadgeText || 'Horari oficial',
                delayStatus: d.delayStatus || 'scheduled'
              });
            });
          }
        } catch (_) {}
      }
    } catch (_) {}

    // Sort connections by upcoming departure time (minutes away)
    connections.sort((a, b) => (a.minutesAway || 0) - (b.minutesAway || 0));

    this.cache.set(hub.id, { timestamp: now, data: connections });

    return {
      isHub: true,
      hub: { id: hub.id, name: hub.name, icon: hub.icon },
      connections: this._enrichFeasibility(connections, options.arrivalMinutes)
    };
  }

  _enrichFeasibility(connections, arrivalMinutes) {
    const arr = Number.isFinite(Number(arrivalMinutes)) ? Number(arrivalMinutes) : 0;
    return connections.map(conn => {
      const depMins = conn.minutesAway !== undefined ? conn.minutesAway : 0;
      const feasibility = this.calculateFeasibility(depMins, arr);
      return {
        ...conn,
        feasibility
      };
    });
  }
}

module.exports = new IntermodalHub();
