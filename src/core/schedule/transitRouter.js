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
    const candidates = this._resolveStopCandidates(query);
    return candidates.length > 0 ? candidates[0] : null;
  }

  _resolveStopCandidates(query) {
    if (!this.tracker || !this.tracker.allStopsMap) return [];
    const allStops = this.tracker.allStopsMap;

    // Coordinate object { lat, lon }
    if (typeof query === 'object' && query !== null && query.lat !== undefined && query.lon !== undefined) {
      const nearest = this.findNearestStop(query.lat, query.lon);
      if (!nearest) return [];
      return [nearest];
    }

    const qStr = String(query || '').trim();
    if (!qStr) return [];

    const lower = qStr.toLowerCase();
    const baseStops = [];

    // 1. Exact ID match
    if (allStops.has(qStr)) {
      baseStops.push(allStops.get(qStr));
    }
    // 2. Shorthand numeric ID (e.g. "1" -> "1001", "8" -> "1008", "16" -> "1016")
    if (baseStops.length === 0 && /^[0-9]{1,3}$/.test(qStr)) {
      const padded = `1${qStr.padStart(3, '0')}`;
      if (allStops.has(padded)) {
        baseStops.push(allStops.get(padded));
      }
    }
    // 3. Name match (contains or starts with)
    for (const [id, s] of allStops.entries()) {
      const sName = (s.name || '').toLowerCase();
      if (sName.includes(lower) || lower.includes(sName)) {
        if (!baseStops.some(b => String(b.id) === String(s.id))) {
          baseStops.push(s);
        }
      }
    }

    if (baseStops.length === 0) return [];

    // 4. Cluster expansion:
    // Add all sibling stops with identical clean name OR within 150 meters (opposite sides of street, hubs)
    const candidates = new Map();
    for (const b of baseStops) {
      const bLat = parseFloat(b.lat || b.latitude);
      const bLon = parseFloat(b.lon || b.longitude);
      const bClean = (b.name || '').replace(/ - \d+$/, '').trim().toLowerCase();
      const bId = String(b.id);

      if (!candidates.has(bId)) {
        candidates.set(bId, {
          id: bId,
          shorthandId: bId.replace(/^10*/, ''),
          name: (b.name || '').replace(/ - \d+$/, '').trim(),
          lat: bLat,
          lon: bLon,
          walkingMinutes: 0
        });
      }

      for (const [id, s] of allStops.entries()) {
        const sId = String(s.id);
        if (candidates.has(sId)) continue;
        const sClean = (s.name || '').replace(/ - \d+$/, '').trim().toLowerCase();
        const sLat = parseFloat(s.lat || s.latitude);
        const sLon = parseFloat(s.lon || s.longitude);

        // Identical base name (e.g. "Roca Blanca" or "Rodalies" opposite platforms)
        if (sClean === bClean) {
          candidates.set(sId, {
            id: sId,
            shorthandId: sId.replace(/^10*/, ''),
            name: (s.name || '').replace(/ - \d+$/, '').trim(),
            lat: sLat,
            lon: sLon,
            walkingMinutes: 0
          });
          continue;
        }

        // Close geographical proximity (< 150m walking interchange)
        if (Number.isFinite(bLat) && Number.isFinite(sLat)) {
          const dist = geoEngine.calculateDistanceMeters(bLat, bLon, sLat, sLon);
          if (dist <= 150) {
            candidates.set(sId, {
              id: sId,
              shorthandId: sId.replace(/^10*/, ''),
              name: (s.name || '').replace(/ - \d+$/, '').trim(),
              lat: sLat,
              lon: sLon,
              walkingMinutes: Math.max(1, Math.round(dist / 80))
            });
          }
        }
      }
    }

    return Array.from(candidates.values());
  }

  findNearestStop(lat, lon, maxDistanceMeters = 800) {
    if (!this.tracker || !this.tracker.allStopsMap) return null;
    let closest = null;
    let minDistance = Infinity;

    for (const [id, s] of this.tracker.allStopsMap.entries()) {
      const sLat = parseFloat(s.lat || s.latitude);
      const sLon = parseFloat(s.lon || s.longitude);
      if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) continue;

      const dist = geoEngine.calculateDistanceMeters(lat, lon, sLat, sLon);
      if (dist < minDistance && dist <= maxDistanceMeters) {
        minDistance = dist;
        closest = {
          id: String(s.id),
          shorthandId: String(s.id).replace(/^10*/, ''),
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

    const origCandidates = this._resolveStopCandidates(origin);
    const destCandidates = this._resolveStopCandidates(destination);

    if (origCandidates.length === 0 || destCandidates.length === 0) {
      return {
        success: false,
        error: origCandidates.length === 0 ? "No hem trobat la parada d'origen." : "No hem trobat la parada de destinació.",
        itineraries: []
      };
    }

    // Check same stop
    const origQueryStr = typeof origin === 'string' ? origin.trim().toLowerCase() : '';
    const destQueryStr = typeof destination === 'string' ? destination.trim().toLowerCase() : '';
    if ((origQueryStr && origQueryStr === destQueryStr) || (origCandidates[0].id === destCandidates[0].id)) {
      return {
        success: true,
        originStop: origCandidates[0],
        destStop: destCandidates[0],
        message: "L'origen i la destinació són la mateixa parada.",
        itineraries: []
      };
    }

    const directRoutes = [];
    const oneTransferRoutes = [];
    const seenDirectKeys = new Set();
    const seenTransferKeys = new Set();

    // 1. Check for DIRECT routes on any matching candidate pair
    for (const o of origCandidates) {
      for (const d of destCandidates) {
        if (o.id === d.id) continue;

        for (const route of this.routesGraph) {
          const origIdx = route.stops.findIndex(s => s.id === o.id || s.shorthandId === o.id);
          if (origIdx === -1) continue;

          const destIdx = route.stops.findIndex(s => s.id === d.id || s.shorthandId === d.id);
          if (destIdx === -1 || destIdx <= origIdx) continue;

          const directKey = `${route.lineId}_${o.id}_${d.id}`;
          if (seenDirectKeys.has(directKey)) continue;
          seenDirectKeys.add(directKey);

          const intermediateStops = route.stops.slice(origIdx, destIdx + 1);
          const stopsCount = destIdx - origIdx;
          const rideMinutes = Math.max(3, Math.round(stopsCount * 1.8));
          const totalDur = rideMinutes + (o.walkingMinutes || 0) + (d.walkingMinutes || 0);

          directRoutes.push({
            type: 'direct',
            transfersCount: 0,
            stopsCount,
            stopCount: stopsCount,
            rideMinutes,
            totalDurationMinutes: totalDur,
            totalDurationMins: totalDur,
            originStop: o,
            destStop: d,
            legs: [
              {
                lineId: route.lineId,
                lineCode: route.lineCode,
                lineColor: route.color,
                color: route.color,
                direction: route.direction,
                destination: route.destName || (intermediateStops[intermediateStops.length - 1] && intermediateStops[intermediateStops.length - 1].name) || 'Destinació',
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
      }
    }

    // 2. Check for 1-TRANSFER routes across candidate pairs
    for (const o of origCandidates) {
      for (const d of destCandidates) {
        if (o.id === d.id) continue;

        for (const route1 of this.routesGraph) {
          const origIdx = route1.stops.findIndex(s => s.id === o.id || s.shorthandId === o.id);
          if (origIdx === -1) continue;

          for (let t1Idx = origIdx + 1; t1Idx < route1.stops.length; t1Idx++) {
            const transferStop = route1.stops[t1Idx];

            for (const route2 of this.routesGraph) {
              if (route2.lineId === route1.lineId) continue;

              const t2Idx = route2.stops.findIndex(s => s.id === transferStop.id || s.shorthandId === transferStop.id);
              if (t2Idx === -1) continue;

              const destIdx = route2.stops.findIndex(s => s.id === d.id || s.shorthandId === d.id);
              if (destIdx === -1 || destIdx <= t2Idx) continue;

              const transferKey = `${route1.lineId}_${route2.lineId}_${transferStop.id}_${o.id}_${d.id}`;
              if (seenTransferKeys.has(transferKey)) continue;
              seenTransferKeys.add(transferKey);

              const leg1Stops = route1.stops.slice(origIdx, t1Idx + 1);
              const leg2Stops = route2.stops.slice(t2Idx, destIdx + 1);

              const leg1StopsCount = t1Idx - origIdx;
              const leg2StopsCount = destIdx - t2Idx;
              const leg1RideMinutes = Math.max(2, Math.round(leg1StopsCount * 1.8));
              const leg2RideMinutes = Math.max(2, Math.round(leg2StopsCount * 1.8));
              const transferWaitMinutes = 5;

              const totalDuration = leg1RideMinutes + transferWaitMinutes + leg2RideMinutes +
                (o.walkingMinutes || 0) + (d.walkingMinutes || 0);

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
                originStop: o,
                destStop: d,
                legs: [
                  {
                    lineId: route1.lineId,
                    lineCode: route1.lineCode,
                    lineColor: route1.color,
                    color: route1.color,
                    direction: route1.direction,
                    destination: route1.destName || (leg1Stops[leg1Stops.length - 1] && leg1Stops[leg1Stops.length - 1].name) || 'Destinació',
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
                    lineColor: route2.color,
                    color: route2.color,
                    direction: route2.direction,
                    destination: route2.destName || (leg2Stops[leg2Stops.length - 1] && leg2Stops[leg2Stops.length - 1].name) || 'Destinació',
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

    // Sort: direct routes first by duration, then transfers by duration
    directRoutes.sort((a, b) => a.totalDurationMinutes - b.totalDurationMinutes);
    oneTransferRoutes.sort((a, b) => a.totalDurationMinutes - b.totalDurationMinutes);

    // Pick top itineraries: prioritize direct routes, fallback to transfers
    let itineraries = [];
    if (directRoutes.length > 0) {
      itineraries = [...directRoutes.slice(0, 3)];
      // Only add transfer options if they offer a completely different line combination
      const usedLinePairs = new Set(directRoutes.map(d => d.legs[0].lineId));
      for (const t of oneTransferRoutes) {
        if (!usedLinePairs.has(t.legs[0].lineId)) {
          itineraries.push(t);
          if (itineraries.length >= 4) break;
        }
      }
    } else {
      itineraries = oneTransferRoutes.slice(0, 4);
    }

    // Enrich first leg with live departure countdown if available
    for (const itin of itineraries) {
      const firstLeg = itin.legs[0];
      let waitMinutes = 8;
      let depTime = 'En breu';
      let isRealTime = false;

      if (this.tracker && typeof this.tracker.getStopDepartures === 'function') {
        try {
          const boardStopId = firstLeg.fromStop && firstLeg.fromStop.id ? firstLeg.fromStop.id : origCandidates[0].id;
          const depData = await this.tracker.getStopDepartures(boardStopId, firstLeg.lineId, firstLeg.direction);
          if (depData && Array.isArray(depData.departures) && depData.departures.length > 0) {
            const nextDep = depData.departures[0];
            if (Number.isFinite(nextDep.minutesAway)) {
              waitMinutes = nextDep.minutesAway;
              depTime = nextDep.departureTime || `${nextDep.minutesAway} min`;
              isRealTime = Boolean(nextDep.isRealTime);
            }
          }
        } catch (_) {}
      }

      itin.nextDepartureMinutes = waitMinutes;
      itin.nextDepartureMins = waitMinutes;
      itin.departureTime = depTime;
      itin.isRealTime = isRealTime;

      firstLeg.nextDepartureMinutes = waitMinutes;
      firstLeg.nextDepartureMins = waitMinutes;
      firstLeg.departureTime = depTime;
      firstLeg.isRealTime = isRealTime;
    }

    return {
      success: true,
      originStop: origCandidates[0],
      destStop: destCandidates[0],
      count: itineraries.length,
      itineraries
    };
  }
}

module.exports = new TransitRouter();
