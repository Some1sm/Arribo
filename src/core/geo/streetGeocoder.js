/**
 * StreetGeocoder.js — Street and Address Search for Arribo!
 * Allows users to input street names in addition to transit stops.
 * Integrates OpenStreetMap/Photon geocoding with Mataró geographic bias
 * and associates each street with its nearest bus stop and walking distance.
 */

const geoEngine = require('./geoEngine');

class StreetGeocoder {
  constructor() {
    this.MATARO_LAT = 41.5388;
    this.MATARO_LON = 2.4445;
    this.MAX_RADIUS_METERS = 12000; // 12km radius around Mataró

    this.cache = new Map();
    this.MAX_CACHE_SIZE = 250;
    this.CACHE_TTL_MS = 3600 * 1000; // 1 hour

    this.stopsCatalog = null;
  }

  setStopsCatalog(stopsMap) {
    if (stopsMap instanceof Map) {
      this.stopsCatalog = Array.from(stopsMap.values());
    } else if (Array.isArray(stopsMap)) {
      this.stopsCatalog = stopsMap;
    }
  }

  findNearestStop(lat, lon) {
    if (!this.stopsCatalog || this.stopsCatalog.length === 0) return null;
    let closest = null;
    let minDistance = Infinity;

    for (const s of this.stopsCatalog) {
      const sLat = parseFloat(s.lat ?? s.latitude);
      const sLon = parseFloat(s.lon ?? s.longitude);
      if (!Number.isFinite(sLat) || !Number.isFinite(sLon)) continue;

      const d = geoEngine.calculateDistanceMeters(lat, lon, sLat, sLon);
      if (d < minDistance) {
        minDistance = d;
        closest = {
          id: String(s.id),
          name: (s.name || '').replace(/ - \d+$/, '').trim(),
          lat: sLat,
          lon: sLon,
          directionText: s.directionText || '',
          distMeters: Math.round(d),
          walkingMinutes: Math.max(1, Math.round(d / 80))
        };
      }
    }
    return closest;
  }

  async searchStreets(query, limit = 5) {
    const rawQ = String(query || '').trim();
    if (rawQ.length < 2) return [];

    const normKey = rawQ.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const cached = this.cache.get(normKey);
    if (cached && Date.now() - cached.ts < this.CACHE_TTL_MS) {
      return cached.results.slice(0, limit);
    }

    try {
      // Lazy load stops if not already populated
      if (!this.stopsCatalog) {
        try {
          const mataroTracker = require('../../mataroTracker');
          if (mataroTracker && mataroTracker.allStopsMap) {
            this.setStopsCatalog(mataroTracker.allStopsMap);
          }
        } catch (_) {}
      }

      // Constrain query to Maresme/Mataró bounding box with city bias
      const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(rawQ)}&lat=${this.MATARO_LAT}&lon=${this.MATARO_LON}&bbox=2.30,41.48,2.58,41.62&limit=15`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'ArriboTransit/1.0 (https://arribo.cat)'
        },
        signal: AbortSignal.timeout(1600)
      });

      if (!res.ok) return [];
      const data = await res.json();
      const features = Array.isArray(data.features) ? data.features : [];

      const streetResults = [];
      const seenNames = new Set();

      for (const f of features) {
        const p = f.properties || {};
        const coords = f.geometry?.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) continue;

        const lon = coords[0];
        const lat = coords[1];

        const distFromCenter = geoEngine.calculateDistanceMeters(this.MATARO_LAT, this.MATARO_LON, lat, lon);
        if (distFromCenter > this.MAX_RADIUS_METERS) {
          continue;
        }

        const rawName = p.name || p.street;
        if (!rawName) continue;

        const cleanName = rawName.trim();
        const city = p.city || p.locality || 'Mataró';
        const dedupeKey = `${cleanName.toLowerCase()}_${city.toLowerCase()}`;
        if (seenNames.has(dedupeKey)) continue;
        seenNames.add(dedupeKey);
        const nearest = this.findNearestStop(lat, lon);

        let subtitle = `Carrer • ${city}`;
        if (nearest) {
          subtitle = `A ${nearest.distMeters}m de parada ${nearest.name} (${nearest.walkingMinutes} min a peu)`;
        }

        streetResults.push({
          type: 'street',
          isStreet: true,
          id: `street_${p.osm_id || Math.round(lat * 10000)}`,
          name: cleanName,
          cityName: city,
          lat: Math.round(lat * 100000) / 100000,
          lon: Math.round(lon * 100000) / 100000,
          subtitle,
          nearestStop: nearest
        });

        if (streetResults.length >= limit) break;
      }

      streetResults.sort((a, b) => {
        const aMat = (a.cityName || '').toLowerCase().includes('matar');
        const bMat = (b.cityName || '').toLowerCase().includes('matar');
        if (aMat && !bMat) return -1;
        if (!aMat && bMat) return 1;
        const aDist = a.nearestStop?.distMeters ?? 99999;
        const bDist = b.nearestStop?.distMeters ?? 99999;
        return aDist - bDist;
      });

      if (this.cache.size >= this.MAX_CACHE_SIZE) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
      this.cache.set(normKey, { ts: Date.now(), results: streetResults });

      return streetResults.slice(0, limit);
    } catch (err) {
      return [];
    }
  }
}

const streetGeocoder = new StreetGeocoder();
module.exports = streetGeocoder;
