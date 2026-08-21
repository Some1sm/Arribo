/**
 * src/core/geo/geoEngine.js
 * 
 * Core Geographic and Polyline Engine
 * Pure math & geometric algorithms for multi-operator transit tracking.
 */

const EARTH_RADIUS_METERS = 6371000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

/**
 * Normalizes any coordinate representation into { lat: number, lon: number }
 * Supports objects with lat/lon, lat/lng, latitude/longitude, Latitude/Longitude, y/x, or array [lat, lon].
 */
function normalizeCoord(point) {
  if (!point) return { lat: 0, lon: 0 };
  if (Array.isArray(point)) {
    return { lat: Number(point[0]) || 0, lon: Number(point[1]) || 0 };
  }
  const lat = point.lat ?? point.latitude ?? point.Latitude ?? point.y ?? 0;
  const lon = point.lon ?? point.lng ?? point.longitude ?? point.Longitude ?? point.x ?? 0;
  return { lat: Number(lat) || 0, lon: Number(lon) || 0 };
}

/**
 * Calculates great-circle distance between two points in meters (Haversine formula).
 * Supports (lat1, lon1, lat2, lon2) or (point1, point2).
 */
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  let p1, p2;
  if (typeof lat1 === 'object' && lat1 !== null) {
    p1 = normalizeCoord(lat1);
    p2 = normalizeCoord(lon1);
  } else {
    p1 = { lat: Number(lat1) || 0, lon: Number(lon1) || 0 };
    p2 = { lat: Number(lat2) || 0, lon: Number(lon2) || 0 };
  }

  if (p1.lat === p2.lat && p1.lon === p2.lon) return 0;

  const dLat = toRad(p2.lat - p1.lat);
  const dLon = toRad(p2.lon - p1.lon);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Calculates initial compass bearing (heading) in degrees [0, 360).
 * Supports (lat1, lon1, lat2, lon2) or (point1, point2).
 */
function calculateBearing(lat1, lon1, lat2, lon2) {
  let p1, p2;
  if (typeof lat1 === 'object' && lat1 !== null) {
    p1 = normalizeCoord(lat1);
    p2 = normalizeCoord(lon1);
  } else {
    p1 = { lat: Number(lat1) || 0, lon: Number(lon1) || 0 };
    p2 = { lat: Number(lat2) || 0, lon: Number(lon2) || 0 };
  }

  if (p1.lat === p2.lat && p1.lon === p2.lon) return 0;

  const phi1 = toRad(p1.lat);
  const phi2 = toRad(p2.lat);
  const deltaLambda = toRad(p2.lon - p1.lon);

  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

  const theta = Math.atan2(y, x);
  const bearing = (toDeg(theta) + 360) % 360;
  return Math.round(bearing * 10) / 10;
}

/**
 * Converts bearing angle to Catalan compass cardinal point.
 */
function getCompassDirection(bearing) {
  const directions = [
    { code: 'N', label: 'Nord (N) ⬆️' },
    { code: 'NE', label: 'Nord-Est (NE) ↗️' },
    { code: 'E', label: 'Est (E) ➡️' },
    { code: 'SE', label: 'Sud-Est (SE) ↘️' },
    { code: 'S', label: 'Sud (S) ⬇️' },
    { code: 'SW', label: 'Sud-Oest (SO) ↙️' },
    { code: 'W', label: 'Oest (O) ⬅️' },
    { code: 'NW', label: 'Nord-Oest (NO) ↖️' }
  ];
  const normalized = (((Number(bearing) || 0) % 360) + 360) % 360;
  const index = Math.round(normalized / 45) % 8;
  return directions[index];
}

/**
 * Interpolates coordinate between two points along geodesic segment.
 */
function interpolateCoordinate(lat1, lon1, lat2, lon2, fraction) {
  let p1, p2, fVal;
  if (typeof lat1 === 'object' && lat1 !== null) {
    p1 = normalizeCoord(lat1);
    p2 = normalizeCoord(lon1);
    fVal = Number(lat2) || 0;
  } else {
    p1 = { lat: Number(lat1) || 0, lon: Number(lon1) || 0 };
    p2 = { lat: Number(lat2) || 0, lon: Number(lon2) || 0 };
    fVal = Number(fraction) || 0;
  }

  const f = Math.max(0, Math.min(1, fVal));
  const lat = p1.lat + f * (p2.lat - p1.lat);
  const lon = p1.lon + f * (p2.lon - p1.lon);
  return {
    lat: Math.round(lat * 1000000) / 1000000,
    lon: Math.round(lon * 1000000) / 1000000
  };
}

/**
 * Snaps a lat/lon point strictly to the closest segment of a polyline using vector projection.
 * 
 * @param {number|object} lat - Latitude or coordinate object
 * @param {number|Array} lon - Longitude or polyline coords if lat is object
 * @param {Array<object|Array>} [polyCoords] - Ordered array of polyline vertices
 * @returns {{ lat: number, lon: number, index: number, bearing: number, dist: number }}
 */
function snapPointToPolyline(lat, lon, polyCoords) {
  let p, coordsRaw;
  if (typeof lat === 'object' && lat !== null) {
    p = normalizeCoord(lat);
    coordsRaw = lon;
  } else {
    p = normalizeCoord({ lat, lon });
    coordsRaw = polyCoords;
  }

  if (!coordsRaw || !Array.isArray(coordsRaw) || coordsRaw.length === 0) {
    return { lat: p.lat, lon: p.lon, index: 0, bearing: 0, dist: 0 };
  }

  const coords = coordsRaw.map(normalizeCoord);
  if (coords.length === 1) {
    const d = calculateDistanceMeters(p.lat, p.lon, coords[0].lat, coords[0].lon);
    return { lat: coords[0].lat, lon: coords[0].lon, index: 0, bearing: 0, dist: d };
  }

  let minDistance = Infinity;
  let bestPoint = { lat: coords[0].lat, lon: coords[0].lon, index: 0, bearing: 0, dist: 0 };

  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i];
    const p2 = coords[i + 1];

    const x1 = p1.lon, y1 = p1.lat;
    const x2 = p2.lon, y2 = p2.lat;
    const px = p.lon, py = p.lat;

    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;

    let t = 0;
    if (lenSq > 0) {
      t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
    }

    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    const dist = calculateDistanceMeters(p.lat, p.lon, projY, projX);

    if (dist < minDistance) {
      minDistance = dist;
      bestPoint = {
        lat: Math.round(projY * 1000000) / 1000000,
        lon: Math.round(projX * 1000000) / 1000000,
        index: i,
        bearing: calculateBearing(p1.lat, p1.lon, p2.lat, p2.lon),
        dist: Math.round(dist * 10) / 10
      };
    }
  }

  return bestPoint;
}

/**
 * Calculates along-polyline distance in meters between two points.
 * Snaps both endpoints to polyline and accumulates distance along intermediate vertices.
 */
function calculatePolylineDistanceBetween(polyCoords, lat1, lon1, lat2, lon2) {
  if (!polyCoords || !Array.isArray(polyCoords) || polyCoords.length < 2) {
    return calculateDistanceMeters(lat1, lon1, lat2, lon2);
  }

  const coords = polyCoords.map(normalizeCoord);
  const snap1 = snapPointToPolyline(lat1, lon1, coords);
  const snap2 = snapPointToPolyline(lat2, lon2, coords);

  const startIdx = Math.min(snap1.index, snap2.index);
  const endIdx = Math.max(snap1.index, snap2.index);

  if (startIdx === endIdx) {
    return calculateDistanceMeters(snap1.lat, snap1.lon, snap2.lat, snap2.lon);
  }

  let totalDist = 0;
  // Distance from snap1 to next vertex
  const isSnap1First = snap1.index <= snap2.index;
  const firstSnap = isSnap1First ? snap1 : snap2;
  const secondSnap = isSnap1First ? snap2 : snap1;

  totalDist += calculateDistanceMeters(firstSnap.lat, firstSnap.lon, coords[startIdx + 1].lat, coords[startIdx + 1].lon);

  // Intermediate full segments
  for (let i = startIdx + 1; i < endIdx; i++) {
    totalDist += calculateDistanceMeters(coords[i].lat, coords[i].lon, coords[i + 1].lat, coords[i + 1].lon);
  }

  // Distance from last vertex to second snap point
  totalDist += calculateDistanceMeters(coords[endIdx].lat, coords[endIdx].lon, secondSnap.lat, secondSnap.lon);

  return Math.max(0, Math.round(totalDist));
}

/**
 * Calculates total route polyline length in meters.
 */
function calculateRouteTotalDistance(polyCoords) {
  if (!polyCoords || !Array.isArray(polyCoords) || polyCoords.length < 2) return 0;
  const coords = polyCoords.map(normalizeCoord);
  let dist = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    dist += calculateDistanceMeters(coords[i].lat, coords[i].lon, coords[i + 1].lat, coords[i + 1].lon);
  }
  return Math.round(dist);
}

/**
 * Dead-reckoning position extrapolation along polyline based on elapsed time and speed.
 */
function extrapolatePolylinePosition(currentPos, elapsedSec, speedKmh, polyCoords) {
  if (!polyCoords || !Array.isArray(polyCoords) || polyCoords.length < 2) return null;
  const coords = polyCoords.map(normalizeCoord);
  const pos = normalizeCoord(currentPos);
  const snap = snapPointToPolyline(pos.lat, pos.lon, coords);

  const speed = Math.max(5, (Number(speedKmh) || 30) / 3.6); // speed in m/s
  const advanceMeters = speed * Math.max(0, Number(elapsedSec) || 0);

  let accumulated = 0;
  let currIdx = snap.index;

  // Segment remaining from snap point to currIdx + 1
  if (currIdx >= coords.length - 1) {
    const last = coords[coords.length - 1];
    return {
      lat: last.lat,
      lon: last.lon,
      bearing: currentPos.bearing || 0,
      progress: 100
    };
  }

  const distToNextVertex = calculateDistanceMeters(snap.lat, snap.lon, coords[currIdx + 1].lat, coords[currIdx + 1].lon);
  if (distToNextVertex >= advanceMeters) {
    const frac = distToNextVertex > 0 ? advanceMeters / distToNextVertex : 0;
    const lat = snap.lat + frac * (coords[currIdx + 1].lat - snap.lat);
    const lon = snap.lon + frac * (coords[currIdx + 1].lon - snap.lon);
    const bearing = calculateBearing(snap.lat, snap.lon, coords[currIdx + 1].lat, coords[currIdx + 1].lon);
    return {
      lat: Math.round(lat * 1000000) / 1000000,
      lon: Math.round(lon * 1000000) / 1000000,
      bearing,
      progress: Math.min(100, Math.round(((currIdx + frac) / coords.length) * 100))
    };
  }

  accumulated += distToNextVertex;
  currIdx++;

  while (currIdx < coords.length - 1 && accumulated < advanceMeters) {
    const p1 = coords[currIdx];
    const p2 = coords[currIdx + 1];
    const segD = calculateDistanceMeters(p1.lat, p1.lon, p2.lat, p2.lon);
    if (accumulated + segD >= advanceMeters) {
      const frac = segD > 0 ? (advanceMeters - accumulated) / segD : 0;
      const lat = p1.lat + frac * (p2.lat - p1.lat);
      const lon = p1.lon + frac * (p2.lon - p1.lon);
      const bearing = calculateBearing(p1.lat, p1.lon, p2.lat, p2.lon);
      return {
        lat: Math.round(lat * 1000000) / 1000000,
        lon: Math.round(lon * 1000000) / 1000000,
        bearing,
        progress: Math.min(100, Math.round(((currIdx + frac) / coords.length) * 100))
      };
    }
    accumulated += segD;
    currIdx++;
  }

  const last = coords[coords.length - 1];
  return {
    lat: last.lat,
    lon: last.lon,
    bearing: currentPos.bearing || 0,
    progress: 100
  };
}

/**
 * Decodes a Google Encoded Polyline string into an array of { lat, lon } coordinate objects.
 */
function decodePolyline(encodedString) {
  if (!encodedString || typeof encodedString !== 'string') return [];
  const points = [];
  let index = 0, len = encodedString.length;
  let lat = 0, lng = 0;

  while (index < len) {
    let b, shift = 0, result = 0;
    do {
      b = encodedString.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      b = encodedString.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lng += dlng;

    points.push({
      lat: Math.round((lat / 1e5) * 1000000) / 1000000,
      lon: Math.round((lng / 1e5) * 1000000) / 1000000
    });
  }
  return points;
}

module.exports = {
  normalizeCoord,
  calculateDistanceMeters,
  calculateBearing,
  getCompassDirection,
  bearingToCompassName: getCompassDirection, // Alias for backward compatibility
  interpolateCoordinate,
  snapPointToPolyline,
  calculatePolylineDistanceBetween,
  calculateRouteTotalDistance,
  extrapolatePolylinePosition,
  decodePolyline
};
