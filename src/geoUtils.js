/**
 * Geographic and Telemetry Utilities for C-10 Bus Tracker
 */

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

/**
 * Calculates great-circle distance between two points in meters (Haversine formula).
 */
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculates initial compass bearing (heading) in degrees [0, 360).
 */
function calculateBearing(lat1, lon1, lat2, lon2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const deltaLambda = toRad(lon2 - lon1);

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
function bearingToCompassName(bearing) {
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
  const index = Math.round(bearing / 45) % 8;
  return directions[index];
}

/**
 * Interpolates coordinate between two points along geodesic segment.
 */
function interpolateCoordinate(lat1, lon1, lat2, lon2, fraction) {
  const f = Math.max(0, Math.min(1, fraction));
  const lat = lat1 + f * (lat2 - lat1);
  const lon = lon1 + f * (lon2 - lon1);
  return {
    lat: Math.round(lat * 1000000) / 1000000,
    lon: Math.round(lon * 1000000) / 1000000
  };
}

module.exports = {
  calculateDistanceMeters,
  calculateBearing,
  bearingToCompassName,
  interpolateCoordinate
};
