/**
 * In-Memory Transit Router for Mataró Bus Urbà (L1–L8)
 * Computes optimal direct and 1-transfer itineraries across 153 stops in <5ms.
 */

const geoEngine = require('../geo/geoEngine');
const timeEngine = require('../time/timeEngine');
const calendarEngine = require('../time/calendarEngine');

class TransitRouter {
  constructor(mataroTracker = null) {
    this.tracker = mataroTracker;
    this.routesGraph = []; // Array of { lineId, lineCode, color, direction, stops }
    this.isBuilt = false;
  }

  setTracker(tracker) {
    this.tracker = tracker;
    this.buildGraph();
  }

  buildGraph() {
    if (!this.tracker || !this.tracker.routesData) return;
    this.routesGraph = [];

    const linesConfig = this.tracker.linesData || [];
    const configMap = new Map();
    linesConfig.forEach(l => configMap.set(String(l.id), l));

    for (const [lineId, dirRoutes] of Object.entries(this.tracker.routesData)) {
      const cfg = configMap.get(String(lineId)) || {};
      const lineCode = `L${lineId}`;
      const color = cfg.color || '#009485';

      (dirRoutes || []).forEach((r, dirIdx) => {
        const stopsList = (r.stops || []).map((s, idx) => ({
          seq: idx,
          id: String(s.id),
          shorthandId: String(s.id).replace(/^10*/, ''),
          name: (s.name || '').replace(/ - \d+$/, '').trim(),
          lat: parseFloat(s.latitude || (s.coords && s.coords.lat) || 0),
          lon: parseFloat(s.longitude || (s.coords && s.coords.lon) || 0)
        }));

        if (stopsList.length > 1) {
          this.routesGraph.push({
            lineId: String(lineId),
            lineCode,
            color,
            direction: String(dirIdx),
            routeName: r.name || `${stopsList[0].name} ➔ ${stopsList[stopsList.length - 1].name}`,
            originName: stopsList[0].name,
            destName: stopsList[stopsList.length - 1].name,
            stops: stopsList
          });
        }
      });
    }

    this.isBuilt = true;
  }

  _resolveStop(query) {
    if (!this.tracker) return null;
    const allStops = this.tracker.allStopsMap;
    if (!allStops) return null;

    const qStr = String(query || '').trim();

    // 1. Direct ID match
    if (allStops.has(qStr)) {
      const s = allStops.get(qStr);
      return { id: String(s.id), name: s.name.replace(/ - \d+$/, ''), lat: s.latitude, lon: s.longitude };
    }

    // 2. Try normalized 4-digit ID (e.g. "1" -> "1001")
    if (/^[0-9]{1,3}$/.test(qStr)) {
      const padded = `1${qStr.padStart(3, '0')}`;
      if (allStops.has(padded)) {
        const s = allStops.get(padded);
        return { id: String(s.id), name: s.name.replace(/ - \d+$/, ''), lat: s.latitude, lon: s.longitude };
      }
    }

    // 3. Substring name match
    const lower = qStr.toLowerCase();
    for (const [id, s] of allStops.entries()) {
      if ((s.name || '').toLowerCase().includes(lower)) {
        return { id: String(s.id), name: s.name.replace(/ - \d+$/, ''), lat: s.latitude, lon: s.longitude };
      }
    }

    return null;
  }

  findNearestStop(lat, lon, maxDistanceMeters = 800) {
    if (!this.tracker || !this.tracker.allStopsMap) return null;
    let closest = null;
    let minDistance = Infinity;

    for (const [id, s] of this.tracker.allStopsMap.entries()) {
      const sLat = parseFloat(s.latitude);
      const sLon = parseFloat(s.longitude);
      if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) continue;

      const dist = geoEngine.calculateDistanceMeters(lat, lon, sLat, sLon);
      if (dist < minDistance && dist <= maxDistanceMeters) {
        minDistance = dist;
        closest = {
          id: String(s.id),
          name: s.name.replace(/ - \d+$/, ''),
          lat: sLat,
          lon: sLon,
          distanceMeters: Math.round(dist),
          walkingMinutes: Math.max(1, Math.round(dist / 80)) // ~4.8 km/h walking
        };
      }
    }

    return closest;
  }

  /**
   * Plans journeys between origin and destination
   * @param {string|object} origin Stop ID/name or { lat, lon }
   * @param {string|object} destination Stop ID/name or { lat, lon }
   * @param {object} [options={}]
   * @returns {Promise<object>}
   */
  async plan(origin, destination, options = {}) {
    return this.planJourney(origin, destination, options);
  }

  async planJourney(origin, destination, options = {}) {
    if (!this.isBuilt) this.buildGraph();

    let originStop = null;
    let destStop = null;
    let originWalking = null;
    let destWalking = null;

    // Handle origin as coordinate or stop query
    if (typeof origin === 'object' && origin !== null && origin.lat !== undefined && origin.lon !== undefined) {
      originWalking = this.findNearestStop(origin.lat, origin.lon);
      originStop = originWalking;
    } else {
      originStop = this._resolveStop(origin);
    }

    // Handle destination as coordinate or stop query
    if (typeof destination === 'object' && destination !== null && destination.lat !== undefined && destination.lon !== undefined) {
      destWalking = this.findNearestStop(destination.lat, destination.lon);
      destStop = destWalking;
    } else {
      destStop = this._resolveStop(destination);
    }

    if (!originStop || !destStop) {
      return {
        success: false,
        error: !originStop ? 'No hem trobat la parada d\'origen.' : 'No hem trobat la parada de destinació.',
        itineraries: []
      };
    }

    if (originStop.id === destStop.id) {
      return {
        success: true,
        originStop,
        destStop,
        message: 'L\'origen i la destinació són la mateixa parada.',
        itineraries: []
      };
    }

    const directRoutes = [];
    const oneTransferRoutes = [];

    // 1. Check for direct routes on the same line
    for (const route of this.routesGraph) {
      const origIdx = route.stops.findIndex(s => s.id === originStop.id || s.shorthandId === originStop.id);
      if (origIdx === -1) continue;

      const destIdx = route.stops.findIndex(s => s.id === destStop.id || s.shorthandId === destStop.id);
      if (destIdx === -1 || destIdx <= origIdx) continue;

      const intermediateStops = route.stops.slice(origIdx, destIdx + 1);
      const stopsCount = destIdx - origIdx;
      const rideMinutes = Math.max(3, Math.round(stopsCount * 1.8));

      const totalDur = rideMinutes + (originWalking ? originWalking.walkingMinutes : 0) + (destWalking ? destWalking.walkingMinutes : 0);
      directRoutes.push({
        type: 'direct',
        transfersCount: 0,
        stopsCount,
        stopCount: stopsCount,
        rideMinutes,
        totalDurationMinutes: totalDur,
        totalDurationMins: totalDur,
        legs: [
          {
            lineId: route.lineId,
            lineCode: route.lineCode,
            color: route.color,
            direction: route.direction,
            fromStop: intermediateStops[0],
            toStop: intermediateStops[intermediateStops.length - 1],
            intermediateStops,
            stopsCount,
            stopCount: stopsCount,
            durationMinutes: rideMinutes,
            durationMins: rideMinutes,
            travelTimeMins: rideMinutes
          }
        ]
      });
    }

    // 2. Check for 1-transfer routes if less than 2 direct routes exist
    if (directRoutes.length < 3) {
      for (const route1 of this.routesGraph) {
        const origIdx = route1.stops.findIndex(s => s.id === originStop.id || s.shorthandId === originStop.id);
        if (origIdx === -1) continue;

        // Iterate through reachable stops from origin on route1 as potential transfer stops
        for (let t1Idx = origIdx + 1; t1Idx < route1.stops.length; t1Idx++) {
          const transferStop = route1.stops[t1Idx];

          // Check if any route2 goes from transferStop to destination
          for (const route2 of this.routesGraph) {
            if (route2.lineId === route1.lineId) continue; // Must transfer to a different line

            const t2Idx = route2.stops.findIndex(s => s.id === transferStop.id || s.shorthandId === transferStop.id);
            if (t2Idx === -1) continue;

            const destIdx = route2.stops.findIndex(s => s.id === destStop.id || s.shorthandId === destStop.id);
            if (destIdx === -1 || destIdx <= t2Idx) continue;

            const leg1Stops = route1.stops.slice(origIdx, t1Idx + 1);
            const leg2Stops = route2.stops.slice(t2Idx, destIdx + 1);

            const leg1StopsCount = t1Idx - origIdx;
            const leg2StopsCount = destIdx - t2Idx;
            const leg1RideMinutes = Math.max(2, Math.round(leg1StopsCount * 1.8));
            const leg2RideMinutes = Math.max(2, Math.round(leg2StopsCount * 1.8));
            const transferWaitMinutes = 5; // standard headway transfer wait

            const totalDuration = leg1RideMinutes + transferWaitMinutes + leg2RideMinutes +
              (originWalking ? originWalking.walkingMinutes : 0) + (destWalking ? destWalking.walkingMinutes : 0);

            // Deduplicate: only keep best 1-transfer combination between line pairs
            const exists = oneTransferRoutes.some(r => 
              r.legs[0].lineId === route1.lineId && 
              r.legs[1].lineId === route2.lineId &&
              r.transferStop.id === transferStop.id
            );

            if (!exists) {
              oneTransferRoutes.push({
                type: 'transfer',
                transfersCount: 1,
                transferStop,
                stopsCount: leg1StopsCount + leg2StopsCount,
                stopCount: leg1StopsCount + leg2StopsCount,
                rideMinutes: leg1RideMinutes + leg2RideMinutes,
                transferWaitMinutes,
                totalDurationMinutes: totalDuration,
                totalDurationMins: totalDuration,
                legs: [
                  {
                    lineId: route1.lineId,
                    lineCode: route1.lineCode,
                    color: route1.color,
                    direction: route1.direction,
                    fromStop: leg1Stops[0],
                    toStop: leg1Stops[leg1Stops.length - 1],
                    intermediateStops: leg1Stops,
                    stopsCount: leg1StopsCount,
                    stopCount: leg1StopsCount,
                    durationMinutes: leg1RideMinutes,
                    durationMins: leg1RideMinutes,
                    travelTimeMins: leg1RideMinutes
                  },
                  {
                    lineId: route2.lineId,
                    lineCode: route2.lineCode,
                    color: route2.color,
                    direction: route2.direction,
                    fromStop: leg2Stops[0],
                    toStop: leg2Stops[leg2Stops.length - 1],
                    intermediateStops: leg2Stops,
                    stopsCount: leg2StopsCount,
                    stopCount: leg2StopsCount,
                    durationMinutes: leg2RideMinutes,
                    durationMins: leg2RideMinutes,
                    travelTimeMins: leg2RideMinutes
                  }
                ]
              });
            }
          }
        }
      }
    }

    // Sort: direct routes first by stops count, then transfers by total duration
    directRoutes.sort((a, b) => a.stopsCount - b.stopsCount);
    oneTransferRoutes.sort((a, b) => a.totalDurationMinutes - b.totalDurationMinutes);

    const itineraries = [...directRoutes.slice(0, 3), ...oneTransferRoutes.slice(0, 3)];

    // Enrich first leg with live departure countdown if available
    for (const itin of itineraries) {
      const firstLeg = itin.legs[0];
      if (this.tracker && typeof this.tracker.getStopDepartures === 'function') {
        try {
          const depData = await this.tracker.getStopDepartures(originStop.id, firstLeg.lineId, firstLeg.direction);
          if (depData && Array.isArray(depData.departures) && depData.departures.length > 0) {
            const nextDep = depData.departures[0];
            itin.nextDepartureMinutes = nextDep.minutesAway;
            itin.departureTime = nextDep.departureTime;
            itin.isRealTime = Boolean(nextDep.isRealTime);
          }
        } catch (_) {}
      }
      if (itin.nextDepartureMinutes === undefined) {
        itin.nextDepartureMinutes = 8; // fallback average frequency
        itin.departureTime = 'En breu';
        itin.isRealTime = false;
      }
    }

    return {
      success: true,
      originStop,
      destStop,
      originWalking,
      destWalking,
      count: itineraries.length,
      itineraries
    };
  }
}

module.exports = new TransitRouter();
