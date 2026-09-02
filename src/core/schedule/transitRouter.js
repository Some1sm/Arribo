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

        const rawCoords = (r.coords || []).map(c => [
          parseFloat(c.Latitude || c.lat || c.latitude),
          parseFloat(c.Longitude || c.lon || c.longitude)
        ]).filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1]));

        if (stopsList.length > 1) {
          this.routesGraph.push({
            lineId: String(lineId),
            lineCode,
            color,
            direction: String(dirIdx),
            routeName: r.name || `${stopsList[0].name} ➔ ${stopsList[stopsList.length - 1].name}`,
            originName: stopsList[0].name,
            destName: stopsList[stopsList.length - 1].name,
            stops: stopsList,
            coords: rawCoords
          });
        }
      });
    }

    this.isBuilt = true;
  }

  sliceRoutePolyline(rawCoords, fromStop, toStop) {
    if (!fromStop || !toStop) return [];
    const fromLat = parseFloat(fromStop.lat ?? fromStop.latitude ?? 0);
    const fromLon = parseFloat(fromStop.lon ?? fromStop.longitude ?? 0);
    const toLat = parseFloat(toStop.lat ?? toStop.latitude ?? 0);
    const toLon = parseFloat(toStop.lon ?? toStop.longitude ?? 0);

    const fallback = [[fromLat, fromLon], [toLat, toLon]];
    if (!Array.isArray(rawCoords) || rawCoords.length < 2) {
      return fallback;
    }

    const findClosestIndex = (lat, lon, polyline, startIdx = 0) => {
      let bestIdx = startIdx;
      let bestDist = Infinity;
      for (let i = startIdx; i < polyline.length; i++) {
        const pt = polyline[i];
        if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
        const d = geoEngine.calculateDistanceMeters(lat, lon, pt[0], pt[1]);
        if (Number.isFinite(d) && d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      return bestIdx;
    };

    const iStart = findClosestIndex(fromLat, fromLon, rawCoords, 0);
    const iEnd = findClosestIndex(toLat, toLon, rawCoords, iStart);

    let sliced = rawCoords.slice(iStart, iEnd + 1);
    if (sliced.length < 2) {
      sliced = fallback;
    } else {
      sliced[0] = [fromLat, fromLon];
      sliced[sliced.length - 1] = [toLat, toLon];
    }
    return sliced;
  }

  _resolveStop(query) {
    const candidates = this._resolveStopCandidates(query);
    return candidates.length > 0 ? candidates[0] : null;
  }

  _resolveStopCandidates(query) {
    if (!this.tracker || !this.tracker.allStopsMap) return [];
    const allStops = this.tracker.allStopsMap;

    if (query === null || query === undefined) return [];

    // Coordinate object { lat, lon }
    if (typeof query === 'object' && query.lat !== undefined && query.lon !== undefined) {
      const nLat = parseFloat(query.lat);
      const nLon = parseFloat(query.lon);
      if (!Number.isFinite(nLat) || !Number.isFinite(nLon)) return [];

      const maxRadiusMeters = query.radiusMeters || 500;
      const nearby = [];

      for (const [id, s] of allStops.entries()) {
        const sLat = parseFloat(s.lat ?? s.latitude);
        const sLon = parseFloat(s.lon ?? s.longitude);
        if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) continue;

        const d = geoEngine.calculateDistanceMeters(nLat, nLon, sLat, sLon);
        if (Number.isFinite(d) && d <= maxRadiusMeters) {
          nearby.push({
            id: String(s.id),
            shorthandId: String(s.id).replace(/^10*/, ''),
            name: (s.name || '').replace(/ - \d+$/, '').trim(),
            lat: sLat,
            lon: sLon,
            distanceMeters: Math.round(d),
            walkingMinutes: Math.max(1, Math.round(d / 80)),
            isWalkPoint: true,
            pointName: query.name || null,
            pointCoord: { lat: nLat, lon: nLon }
          });
        }
      }

      nearby.sort((a, b) => a.distanceMeters - b.distanceMeters);
      if (nearby.length > 0) {
        return nearby.slice(0, 5);
      }

      const nearest = this.findNearestStop(nLat, nLon);
      if (nearest) {
        nearest.isWalkPoint = true;
        nearest.pointName = query.name || null;
        nearest.pointCoord = { lat: nLat, lon: nLon };
        return [nearest];
      }
      return [];
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
    const nLat = parseFloat(lat);
    const nLon = parseFloat(lon);
    if (!Number.isFinite(nLat) || !Number.isFinite(nLon)) return null;

    let closest = null;
    let minDistance = Infinity;

    for (const [id, s] of this.tracker.allStopsMap.entries()) {
      const sLat = parseFloat(s.lat || s.latitude);
      const sLon = parseFloat(s.lon || s.longitude);
      if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) continue;

      const dist = geoEngine.calculateDistanceMeters(nLat, nLon, sLat, sLon);
      if (Number.isFinite(dist) && dist < minDistance && dist <= maxDistanceMeters) {
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

          let walkToFirstStop = null;
          if (o.pointCoord && o.distanceMeters) {
            const rawOrig = (o.pointName || options.originName || (typeof origin === 'object' ? origin.name : '') || '').trim();
            const fromName = (rawOrig && !/^\d+$/.test(rawOrig)) ? rawOrig : 'l\'origen';
            walkToFirstStop = {
              from: [o.pointCoord.lat, o.pointCoord.lon],
              to: [intermediateStops[0].lat, intermediateStops[0].lon],
              fromName,
              toName: intermediateStops[0].name,
              distanceMeters: o.distanceMeters,
              walkingMinutes: o.walkingMinutes || Math.max(1, Math.round(o.distanceMeters / 80))
            };
          }

          let walkFromLastStop = null;
          if (d.pointCoord && d.distanceMeters) {
            const rawDest = (d.pointName || options.destName || (typeof destination === 'object' ? destination.name : '') || '').trim();
            const toName = (rawDest && !/^\d+$/.test(rawDest)) ? rawDest : 'la destinació';
            walkFromLastStop = {
              from: [intermediateStops[intermediateStops.length - 1].lat, intermediateStops[intermediateStops.length - 1].lon],
              to: [d.pointCoord.lat, d.pointCoord.lon],
              fromName: intermediateStops[intermediateStops.length - 1].name,
              toName,
              distanceMeters: d.distanceMeters,
              walkingMinutes: d.walkingMinutes || Math.max(1, Math.round(d.distanceMeters / 80))
            };
          }

          const totalDur = (walkToFirstStop?.walkingMinutes || 0) + rideMinutes + (walkFromLastStop?.walkingMinutes || 0);

          const polyline = this.sliceRoutePolyline(route.coords, intermediateStops[0], intermediateStops[intermediateStops.length - 1]);

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
            walkToFirstStop,
            walkFromLastStop,
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
                polyline,
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

              // Match transfer stops: exact ID, shorthand ID, same clean name, or nearby within 160m
              const possibleT2 = [];
              for (let i = 0; i < route2.stops.length; i++) {
                const s2 = route2.stops[i];
                if (s2.id === transferStop.id || s2.shorthandId === transferStop.id) {
                  possibleT2.push({ idx: i, stop: s2, dist: 0 });
                } else if (s2.name.toLowerCase() === transferStop.name.toLowerCase()) {
                  possibleT2.push({ idx: i, stop: s2, dist: 25 });
                } else {
                  const dist = geoEngine.calculateDistanceMeters(transferStop.lat, transferStop.lon, s2.lat, s2.lon);
                  if (dist <= 160) {
                    possibleT2.push({ idx: i, stop: s2, dist });
                  }
                }
              }

              for (const { idx: t2Idx, stop: t2Stop, dist: transferDist } of possibleT2) {
                const destIdx = route2.stops.findIndex(s => s.id === d.id || s.shorthandId === d.id);
                if (destIdx === -1 || destIdx <= t2Idx) continue;

                const transferKey = `${route1.lineId}_${route2.lineId}_${transferStop.id}_${t2Stop.id}_${o.id}_${d.id}`;
                if (seenTransferKeys.has(transferKey)) continue;
                seenTransferKeys.add(transferKey);

                const leg1Stops = route1.stops.slice(origIdx, t1Idx + 1);
                const leg2Stops = route2.stops.slice(t2Idx, destIdx + 1);

                const leg1StopsCount = t1Idx - origIdx;
                const leg2StopsCount = destIdx - t2Idx;
                const leg1RideMinutes = Math.max(2, Math.round(leg1StopsCount * 1.8));
                const leg2RideMinutes = Math.max(2, Math.round(leg2StopsCount * 1.8));
                const transferWaitMinutes = 5;

                const leg1Polyline = this.sliceRoutePolyline(route1.coords, leg1Stops[0], leg1Stops[leg1Stops.length - 1]);
                const leg2Polyline = this.sliceRoutePolyline(route2.coords, leg2Stops[0], leg2Stops[leg2Stops.length - 1]);

                const transferWalk = {
                  from: [leg1Stops[leg1Stops.length - 1].lat, leg1Stops[leg1Stops.length - 1].lon],
                  to: [leg2Stops[0].lat, leg2Stops[0].lon],
                  fromStop: leg1Stops[leg1Stops.length - 1],
                  toStop: leg2Stops[0],
                  distanceMeters: Math.round(transferDist),
                  walkingMinutes: Math.max(0, Math.round(transferDist / 80))
                };

                let walkToFirstStop = null;
                if (o.pointCoord && o.distanceMeters) {
                  const rawOrig = (o.pointName || options.originName || (typeof origin === 'object' ? origin.name : '') || '').trim();
                  const fromName = (rawOrig && !/^\d+$/.test(rawOrig)) ? rawOrig : 'l\'origen';
                  walkToFirstStop = {
                    from: [o.pointCoord.lat, o.pointCoord.lon],
                    to: [leg1Stops[0].lat, leg1Stops[0].lon],
                    fromName,
                    toName: leg1Stops[0].name,
                    distanceMeters: o.distanceMeters,
                    walkingMinutes: o.walkingMinutes || Math.max(1, Math.round(o.distanceMeters / 80))
                  };
                }

                let walkFromLastStop = null;
                if (d.pointCoord && d.distanceMeters) {
                  const rawDest = (d.pointName || options.destName || (typeof destination === 'object' ? destination.name : '') || '').trim();
                  const toName = (rawDest && !/^\d+$/.test(rawDest)) ? rawDest : 'la destinació';
                  walkFromLastStop = {
                    from: [leg2Stops[leg2Stops.length - 1].lat, leg2Stops[leg2Stops.length - 1].lon],
                    to: [d.pointCoord.lat, d.pointCoord.lon],
                    fromName: leg2Stops[leg2Stops.length - 1].name,
                    toName,
                    distanceMeters: d.distanceMeters,
                    walkingMinutes: d.walkingMinutes || Math.max(1, Math.round(d.distanceMeters / 80))
                  };
                }

                const totalDuration = (walkToFirstStop?.walkingMinutes || 0) +
                  leg1RideMinutes + transferWaitMinutes + leg2RideMinutes +
                  transferWalk.walkingMinutes +
                  (walkFromLastStop?.walkingMinutes || 0);

                oneTransferRoutes.push({
                  type: 'transfer',
                  transfersCount: 1,
                  transferStop,
                  transferWalk,
                  walkToFirstStop,
                  walkFromLastStop,
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
                      polyline: leg1Polyline,
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
                      polyline: leg2Polyline,
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
    }

    // Deduplication & Dominance Filtering:
    // Prunes strictly dominated routes (e.g. walking further to catch the exact same bus)
    // and prioritizes diverse transit choices (different lines / interchange points).
    const filterDominatedRoutes = (routesList, maxResults = 4) => {
      routesList.sort((a, b) => {
        if (a.totalDurationMinutes !== b.totalDurationMinutes) {
          return a.totalDurationMinutes - b.totalDurationMinutes;
        }
        const aWalk = (a.walkToFirstStop?.distanceMeters || 0) + (a.walkFromLastStop?.distanceMeters || 0) + (a.transferWalk?.distanceMeters || 0);
        const bWalk = (b.walkToFirstStop?.distanceMeters || 0) + (b.walkFromLastStop?.distanceMeters || 0) + (b.transferWalk?.distanceMeters || 0);
        return aWalk - bWalk;
      });

      const selected = [];
      const seenLineSignatures = new Map();

      for (const itin of routesList) {
        const lineSig = itin.legs.map(l => l.lineId).join('->');
        const origWalk = itin.walkToFirstStop?.distanceMeters || 0;
        const destWalk = itin.walkFromLastStop?.distanceMeters || 0;
        const totalWalk = origWalk + destWalk + (itin.transferWalk?.distanceMeters || 0);

        if (!seenLineSignatures.has(lineSig)) {
          seenLineSignatures.set(lineSig, { itin, totalWalk, origWalk, destWalk });
          selected.push(itin);
        } else {
          const existing = seenLineSignatures.get(lineSig);
          const origWalkDiff = origWalk - existing.origWalk;

          // If the user has to walk 40+ meters MORE at origin to catch the EXACT SAME line, discard it!
          if (origWalkDiff > 40) {
            continue;
          }

          // If durations are close (within 3 mins) and same lines:
          if (Math.abs(itin.totalDurationMinutes - existing.itin.totalDurationMinutes) <= 3) {
            // If this route drops off closer to destination (by at least 25m) without adding origin walking, prefer it!
            if (destWalk < existing.destWalk - 25 && origWalk <= existing.origWalk + 20) {
              const idx = selected.indexOf(existing.itin);
              if (idx !== -1) selected[idx] = itin;
              seenLineSignatures.set(lineSig, { itin, totalWalk, origWalk, destWalk });
            }
            continue;
          }

          if (selected.length < maxResults) {
            selected.push(itin);
          }
        }

        if (selected.length >= maxResults) break;
      }

      return selected;
    };

    let itineraries = [];
    if (directRoutes.length > 0) {
      const bestDirect = filterDominatedRoutes(directRoutes, 3);
      itineraries.push(...bestDirect);

      // Only add transfer options that offer a different line
      const usedFirstLines = new Set(bestDirect.map(d => d.legs[0].lineId));
      const transferCandidates = oneTransferRoutes.filter(t => !usedFirstLines.has(t.legs[0].lineId));
      const bestTransfers = filterDominatedRoutes(transferCandidates, 2);
      itineraries.push(...bestTransfers);
    } else {
      itineraries = filterDominatedRoutes(oneTransferRoutes, 4);
    }

    // Enrich first leg with live departure countdown if available, falling back to official schedules
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
            const upcoming = depData.departures.filter(d => Number.isFinite(d.minutesAway) && d.minutesAway >= 0);
            const nextDep = upcoming.length > 0 ? upcoming[0] : depData.departures[0];
            if (nextDep && Number.isFinite(nextDep.minutesAway)) {
              waitMinutes = nextDep.minutesAway;
              depTime = nextDep.departureTime || `${nextDep.minutesAway} min`;
              isRealTime = Boolean(nextDep.isRealTime);
            }
          }
        } catch (_) {}
      }

      // If no live or stop departures found, fallback to official timetable schedule
      if (depTime === 'En breu') {
        try {
          const mataroSchedules = require('../../data/mataroSchedules');
          const dateComp = calendarEngine.getDateComponents(new Date(), 'Europe/Madrid');
          const dayType = dateComp.isSunday ? 'sunday' : (dateComp.isSaturday ? 'saturday' : 'weekday');
          const sched = mataroSchedules.getDirectionSchedule(firstLeg.lineId, firstLeg.direction, dayType);
          if (sched && Array.isArray(sched.departures) && sched.departures.length > 0) {
            const currentSec = dateComp.hour * 3600 + dateComp.minute * 60 + (dateComp.second || 0);
            const nextTrip = sched.departures.find(t => timeEngine.timeStringToSeconds(t) >= currentSec);
            if (nextTrip) {
              const tripSec = timeEngine.timeStringToSeconds(nextTrip);
              waitMinutes = Math.max(1, Math.round((tripSec - currentSec) / 60));
              depTime = nextTrip;
              isRealTime = false;
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
