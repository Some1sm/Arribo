const https = require('https');
const path = require('path');
const fs = require('fs');
const moventisClient = require('./moventisClient');
const geoEngine = require('./core/geo/geoEngine');
const delayEngine = require('./core/schedule/delayEngine');
const timeEngine = require('./core/time/timeEngine');
const calendarEngine = require('./core/time/calendarEngine');
const {
  C10_GTFS_TRIPS,
  C10_STOPS_DIR1,
  C10_STOPS_DIR0,
  C10_POLYLINE_DIR1,
  C10_POLYLINE_DIR0,
  C10_TRIPS_DIR1,
  C10_TRIPS_DIR0
} = require('./c10StaticData');

/**
 * C10TelemetryExtractor
 * 
 * Direct Real-Time GPS Telemetry Extractor for Empresa Casas / Moventis C-10 bus
 * (Barcelona ⇄ Mataró per N-II).
 * 
 * Primary Feed: AMB Mobilitat v2 `/bus/vehicles` (line === "C-10" / "C10")
 * Secondary Fallback: Moventis SAE `/posicion/linea/502`
 */
class C10TelemetryExtractor {
  constructor() {
    this.agencyTimezone = 'Europe/Madrid';
    this.ambApiKey = process.env.AMB_API_KEY || '28EbLJtP0A6CtrWeXp6zE1zy3kp4RzmnaA2sy8JM';
    this.ambBaseHost = 'api.ambmobilitat.cat';
    this.cacheTtlMs = 12000;
    this.cachedVehicles = [];
    this.lastFetchTime = 0;

    this._inflight = new Map();
    this._mockSource = null;
    this._fetchBackend = null;
    this._circuitBreaker = {
      failures: 0,
      lastFailure: 0,
      cooldownMs: 30000
    };

    // Bounding box for the Barcelona-Mataró N-II coastal corridor
    this.boundingBox = {
      minLat: 41.35,
      maxLat: 41.60,
      minLon: 2.15,
      maxLon: 2.50
    };

    this.stopsDir1 = [...C10_STOPS_DIR1];
    this.stopsDir0 = [...C10_STOPS_DIR0];
    this.polylineDir1 = [...C10_POLYLINE_DIR1];
    this.polylineDir0 = [...C10_POLYLINE_DIR0];
    this.schedule = C10_GTFS_TRIPS || {
      dir1: [...C10_TRIPS_DIR1],
      dir0: [...C10_TRIPS_DIR0]
    };
  }

  /**
   * Set a mock source for testing or simulation.
   * @param {Function|null} fn - async () => Array<RawVehicle>
   */
  setMockSource(fn) {
    this._mockSource = typeof fn === 'function' ? fn : null;
    this.cachedVehicles = [];
    this.lastFetchTime = 0;
  }

  /**
   * Set custom transport backend for AMB API (used by WorkerBridge proxy or tests).
   * @param {Function|null} fn - async (path) => { status, data }
   */
  setFetchBackend(fn) {
    this._fetchBackend = typeof fn === 'function' ? fn : null;
  }

  /**
   * Validates if a GPS fix is within the N-II Barcelona-Mataró bounding box.
   * @param {number} lat
   * @param {number} lon
   * @returns {boolean}
   */
  isWithinBoundingBox(lat, lon) {
    const nLat = Number(lat);
    const nLon = Number(lon);
    if (!Number.isFinite(nLat) || !Number.isFinite(nLon)) return false;
    return (
      nLat >= this.boundingBox.minLat &&
      nLat <= this.boundingBox.maxLat &&
      nLon >= this.boundingBox.minLon &&
      nLon <= this.boundingBox.maxLon
    );
  }

  /**
   * Directly fetches all live vehicles from AMB Mobilitat API v2.
   * @returns {Promise<Array<object>>}
   */
  async fetchAmbVehicles() {
    if (typeof this._fetchBackend === 'function') {
      const res = await this._fetchBackend('/bus/vehicles');
      const list = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : []);
      return list.filter(v => {
        const line = String(v?.line || '').toUpperCase().trim();
        return line === 'C-10' || line === 'C10';
      });
    }

    return new Promise((resolve, reject) => {
      const options = {
        hostname: this.ambBaseHost,
        path: '/v2/bus/vehicles',
        method: 'GET',
        headers: {
          'x-api-key': this.ambApiKey,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Arribo/1.0',
          'Accept': 'application/json'
        },
        timeout: 6000
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(new Error(`AMB API HTTP ${res.statusCode}`));
            }
            const parsed = JSON.parse(data);
            const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : []);
            const c10Vehicles = list.filter(v => {
              const line = String(v?.line || '').toUpperCase().trim();
              return line === 'C-10' || line === 'C10';
            });
            resolve(c10Vehicles);
          } catch (err) {
            reject(new Error(`AMB API JSON parse error: ${err.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('AMB API request timed out'));
      });
      req.end();
    });
  }

  /**
   * Fetches positions from Moventis SAE fallback endpoint.
   * @returns {Promise<Array<object>>}
   */
  async fetchMoventisPositions() {
    try {
      const positions = await moventisClient.getLinePositions(502);
      return Array.isArray(positions) ? positions : [];
    } catch (_) {
      return [];
    }
  }

  /**
   * Fetches raw telemetry from upstream sources with circuit breaker and fallback.
   * @returns {Promise<Array<object>>}
   */
  async fetchRawTelemetry() {
    if (this._mockSource) {
      return await this._mockSource();
    }

    const now = Date.now();
    const isCircuitOpen = this._circuitBreaker.failures >= 3 &&
      (now - this._circuitBreaker.lastFailure < this._circuitBreaker.cooldownMs);

    if (!isCircuitOpen) {
      try {
        const ambVehicles = await this.fetchAmbVehicles();
        this._circuitBreaker.failures = 0;
        if (Array.isArray(ambVehicles) && ambVehicles.length > 0) {
          return ambVehicles;
        }
      } catch (err) {
        this._circuitBreaker.failures++;
        this._circuitBreaker.lastFailure = now;
      }
    }

    // Fallback: Moventis SAE
    return await this.fetchMoventisPositions();
  }

  /**
   * Normalizes raw vehicle payload from any provider into Arribo! canonical Vehicle schema.
   * @param {object} raw
   * @returns {object|null}
   */
  normalizeRawVehicle(raw) {
    if (!raw || typeof raw !== 'object') return null;

    // Check if line is explicitly specified and does not match C-10
    const rawLine = String(raw.line || raw.lineCode || raw.lineId || raw.nomLinia || '').toUpperCase().trim();
    if (rawLine && !['C-10', 'C10', '502', 'GEN_0498', '02498'].includes(rawLine) && !rawLine.includes('C-10') && !rawLine.includes('C10')) {
      return null;
    }

    // 1. Parse coordinates across disparate schema conventions
    const rawLat = raw.lat ?? raw.latitud ?? raw.latitude ?? raw.y;
    const rawLon = raw.lon ?? raw.longitud ?? raw.longitude ?? raw.lng ?? raw.x;
    const lat = Number(rawLat);
    const lon = Number(rawLon);

    if (!this.isWithinBoundingBox(lat, lon)) {
      return null;
    }

    // 2. Parse vehicle identity / fleet number
    const rawId = raw.idVehiculo ?? raw.calca ?? raw.id ?? raw.vehicleId ?? raw.code ?? raw.numero ?? raw.matricula ?? '342';
    const cleanCalca = String(rawId).replace(/C-?10/gi, '').replace(/[^a-zA-Z0-9_-]/g, '') || String(rawId);
    let vehicleId;
    if (String(rawId).startsWith('c10_502_')) {
      vehicleId = String(rawId);
    } else if (String(rawId).startsWith('c10_')) {
      vehicleId = String(rawId);
    } else {
      vehicleId = `c10_502_${cleanCalca}`;
    }

    const plateNumber = String(raw.matricula || raw.plateNumber || raw.plate || '').trim();

    // 3. Parse speed and bearing
    const rawSpeed = raw.velocidad ?? raw.speed ?? raw.speedKmh ?? raw.vel;
    const speedKmh = Number.isFinite(Number(rawSpeed)) ? Math.max(0, Math.min(100, Math.round(Number(rawSpeed)))) : 35;
    const rawBearing = raw.rumbo ?? raw.bearing ?? raw.heading ?? raw.angle;
    let bearing = Number.isFinite(Number(rawBearing)) ? ((Number(rawBearing) % 360) + 360) % 360 : null;

    // 4. Direction Discrimination
    let direction = null;

    // Check explicit direction hints
    const rawDir = String(raw.dir ?? raw.direction ?? raw.sentido ?? raw.trayecto ?? raw.routeId ?? '').trim().toUpperCase();
    if (rawDir === '1' || rawDir === 'V' || rawDir === '11940001' || rawDir.endsWith('1')) {
      direction = '1';
    } else if (rawDir === '0' || rawDir === 'A' || rawDir === '2' || rawDir === '11940002' || rawDir.endsWith('2')) {
      direction = '0';
    }

    // If direction is still ambiguous, evaluate bearing angle
    if (!direction && bearing !== null) {
      // Traveling northeast (~20° to 110°) -> Dir 1 (Mataró)
      // Traveling southwest (~190° to 290°) -> Dir 0 (Barcelona)
      if (bearing >= 15 && bearing <= 125) {
        direction = '1';
      } else if (bearing >= 175 && bearing <= 305) {
        direction = '0';
      }
    }

    // Snapping comparison if direction is still unresolved
    if (!direction) {
      const snap1 = geoEngine.snapPointToPolyline(lat, lon, this.polylineDir1);
      const snap0 = geoEngine.snapPointToPolyline(lat, lon, this.polylineDir0);
      direction = snap1.dist <= snap0.dist ? '1' : '0';
    }

    const isDir1 = direction === '1';
    const destination = isDir1 ? 'Hospital de Mataró' : 'Barcelona (Metro la Pau)';
    const polyline = isDir1 ? this.polylineDir1 : this.polylineDir0;
    const stops = isDir1 ? this.stopsDir1 : this.stopsDir0;

    // 5. Snap point to corridor polyline & refine bearing
    const snapped = geoEngine.snapPointToPolyline(lat, lon, polyline);
    if (bearing === null) {
      bearing = (Number.isFinite(snapped?.bearing)) ? snapped.bearing : (isDir1 ? 48 : 228);
    }
    bearing = Math.round(bearing * 10) / 10;
    const compass = geoEngine.getCompassDirection(bearing);

    // 6. Stop Progress & Sequence Mapping
    let closestStopIdx = 0;
    let minStopDist = Infinity;
    for (let i = 0; i < stops.length; i++) {
      const dist = geoEngine.calculateDistanceMeters(lat, lon, stops[i].lat, stops[i].lon);
      if (dist < minStopDist) {
        minStopDist = dist;
        closestStopIdx = i;
      }
    }

    let fromIdx = closestStopIdx;
    let toIdx = Math.min(stops.length - 1, closestStopIdx + 1);

    if (closestStopIdx === stops.length - 1) {
      fromIdx = Math.max(0, stops.length - 2);
      toIdx = stops.length - 1;
    } else {
      const sCur = stops[closestStopIdx];
      const sNext = stops[closestStopIdx + 1];
      const vLat = sNext.lat - sCur.lat;
      const vLon = sNext.lon - sCur.lon;
      const wLat = lat - sCur.lat;
      const wLon = lon - sCur.lon;
      const dot = vLat * wLat + vLon * wLon;
      if (dot > 0) {
        fromIdx = closestStopIdx;
        toIdx = closestStopIdx + 1;
      } else if (closestStopIdx > 0) {
        fromIdx = closestStopIdx - 1;
        toIdx = closestStopIdx;
      }
    }

    const fromStopData = stops[fromIdx] || stops[0];
    const toStopData = stops[toIdx] || stops[stops.length - 1];

    const segDist = geoEngine.calculateDistanceMeters(fromStopData.lat, fromStopData.lon, toStopData.lat, toStopData.lon);
    const distToFrom = geoEngine.calculateDistanceMeters(fromStopData.lat, fromStopData.lon, lat, lon);
    const distToNext = geoEngine.calculateDistanceMeters(lat, lon, toStopData.lat, toStopData.lon);
    const progressFraction = (distToFrom + distToNext) > 0 ? Math.max(0, Math.min(1, distToFrom / (distToFrom + distToNext))) : 0;
    const totalProgress = Math.min(100, Math.max(0, Math.round(((fromStopData.seq + progressFraction) / Math.max(1, stops.length)) * 100)));

    const speedMs = Math.max(5, (speedKmh * 1000) / 3600);
    const secondsToNextStop = Math.max(10, Math.round(distToNext / speedMs));

    // 7. Time & GTFS Schedule Delay Matching
    const rawTime = raw.fechaHora || raw.recordedAt || raw.timestampIso || raw.hora || null;
    let targetDate = rawTime ? new Date(rawTime) : new Date();
    if (isNaN(targetDate.getTime()) || targetDate.getUTCFullYear() < 2000 || targetDate.getUTCFullYear() > 2100) {
      targetDate = new Date();
    }
    const recordedAt = targetDate.toISOString();
    const timestamp = targetDate.getTime();

    const delayInfo = this.calculateTripDelay(lat, lon, direction, fromStopData.seq, targetDate);

    return {
      vehicleId,
      fleetNumber: cleanCalca,
      tripId: String(raw.tripId || `c10_${direction}_${cleanCalca}`),
      lineId: 'c10',
      lineCode: 'C-10',
      lineName: 'Barcelona ⇄ Mataró (per N-II)',
      agency: 'Moventis / Casas (Interurbà Maresme)',
      plateNumber,
      direction,
      destination,
      lat: Math.round(lat * 1000000) / 1000000,
      lon: Math.round(lon * 1000000) / 1000000,
      latitude: Math.round(lat * 1000000) / 1000000,
      longitude: Math.round(lon * 1000000) / 1000000,
      speedKmh,
      speed: speedKmh,
      bearing,
      compass,
      delayMinutes: delayInfo.delayMinutes,
      delayMins: delayInfo.delayMins,
      delayStatus: delayInfo.delayStatus,
      delayBadgeText: delayInfo.delayBadgeText,
      delayFormatted: delayInfo.delayFormatted,
      comparisonText: delayInfo.comparisonText,
      fromStop: fromStopData.name || 'Origen',
      toStop: toStopData.name || 'Destí',
      fromSeq: fromStopData.seq,
      toSeq: toStopData.seq,
      fromCoords: { lat: fromStopData.lat, lon: fromStopData.lon },
      toCoords: { lat: toStopData.lat, lon: toStopData.lon },
      totalProgress,
      secondsToNextStop,
      distanceToNextMeters: Math.round(distToNext),
      segmentDistanceMeters: Math.round(segDist),
      isRealTime: true,
      isRealtime: true,
      isEstimated: false,
      isDeadReckoned: false,
      statusText: '🟢 Senyal GPS Actiu',
      recordedAt,
      timestamp,
      lastUpdate: recordedAt
    };
  }

  /**
   * Calculates schedule delay against GTFS trips for C-10.
   * @param {number} lat
   * @param {number} lon
   * @param {string} direction - '0' or '1'
   * @param {number} stopSeq - Sequence index
   * @param {Date} [targetDate=new Date()]
   * @returns {object} Standardized delay status
   */
  calculateTripDelay(lat, lon, direction, stopSeq, targetDate = new Date()) {
    try {
      const validDate = (targetDate instanceof Date && !isNaN(targetDate.getTime()) && targetDate.getUTCFullYear() >= 2000 && targetDate.getUTCFullYear() <= 2100)
        ? targetDate
        : (typeof targetDate === 'number' || typeof targetDate === 'string' ? new Date(targetDate) : null);

      if (!validDate || isNaN(validDate.getTime()) || validDate.getUTCFullYear() < 2000 || validDate.getUTCFullYear() > 2100) {
        const evalStatus = delayEngine.computeDelayStatus(0, true, { punctualStyle: 'short' });
        return {
          delayMinutes: 0,
          delayMins: 0,
          delayStatus: evalStatus.delayStatus,
          delayBadgeText: evalStatus.delayBadgeText,
          delayFormatted: evalStatus.delayFormatted,
          comparisonText: evalStatus.comparisonText
        };
      }

      const netNow = timeEngine.getNetworkTime(this.agencyTimezone, validDate);
      const currentSec = netNow.currentSec;
      const trips = direction === '1' ? (this.schedule?.dir1 || []) : (this.schedule?.dir0 || []);

      const activeTrips = trips.filter(t => {
        if (t.serviceId) {
          return calendarEngine.isServiceActiveOnDate(t.serviceId, validDate);
        }
        return true;
      });

      const candidateTrips = activeTrips.length > 0 ? activeTrips : trips;
      let bestTrip = null;
      let minDiffSec = Infinity;
      let bestDiffSec = 0;
      let bestSchedTime = null;

      for (const trip of candidateTrips) {
        const stopEntry = (trip.stops || []).find(s => s.seq === stopSeq) || (trip.stops || [])[0];
        if (stopEntry) {
          const sTime = stopEntry.dep || stopEntry.arr || stopEntry.departureTime || stopEntry.arrivalTime;
          if (sTime) {
            const sSec = timeEngine.timeToSec(sTime);
            const diff = Math.abs(currentSec - sSec);
            if (diff < minDiffSec) {
              minDiffSec = diff;
              bestDiffSec = currentSec - sSec;
              bestSchedTime = sTime.substring(0, 5);
              bestTrip = trip;
            }
          }
        }
      }

      if (bestTrip && minDiffSec < 7200) {
        const delayMins = Math.round(bestDiffSec / 60);
        const boundedDelay = Math.max(-15, Math.min(60, delayMins));
        const evalStatus = delayEngine.computeDelayStatus(boundedDelay, true, {
          scheduledTime: bestSchedTime,
          punctualStyle: 'short'
        });
        return {
          delayMinutes: evalStatus.delayMinutes,
          delayMins: evalStatus.delayMins,
          delayStatus: evalStatus.delayStatus,
          delayBadgeText: evalStatus.delayBadgeText,
          delayFormatted: evalStatus.delayFormatted,
          comparisonText: evalStatus.comparisonText
        };
      }
    } catch (_) {}

    const evalStatus = delayEngine.computeDelayStatus(0, true, { punctualStyle: 'short' });
    return {
      delayMinutes: 0,
      delayMins: 0,
      delayStatus: evalStatus.delayStatus,
      delayBadgeText: evalStatus.delayBadgeText,
      delayFormatted: evalStatus.delayFormatted,
      comparisonText: evalStatus.comparisonText
    };
  }

  /**
   * Main entrypoint to retrieve active real-time GPS vehicles for C-10 corridor.
   * @param {object} [options={}]
   * @param {boolean} [options.bypassCache=false]
   * @returns {Promise<Array<object>>}
   */
  async getLiveVehicles(options = {}) {
    const now = Date.now();
    if (!options.bypassCache && (now - this.lastFetchTime < this.cacheTtlMs)) {
      return this.cachedVehicles;
    }

    if (this._inflight.has('getLiveVehicles')) {
      return this._inflight.get('getLiveVehicles');
    }

    const job = (async () => {
      try {
        const rawTelemetry = await this.fetchRawTelemetry();
        if (!Array.isArray(rawTelemetry)) {
          return [];
        }

        const validVehicles = [];
        for (const raw of rawTelemetry) {
          const v = this.normalizeRawVehicle(raw);
          if (v) {
            validVehicles.push(v);
          }
        }

        this.cachedVehicles = validVehicles;
        this.lastFetchTime = Date.now();
        return validVehicles;
      } catch (err) {
        return this.cachedVehicles || [];
      } finally {
        this._inflight.delete('getLiveVehicles');
      }
    })();

    this._inflight.set('getLiveVehicles', job);
    return job;
  }
}

module.exports = new C10TelemetryExtractor();
