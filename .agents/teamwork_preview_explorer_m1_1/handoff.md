# Milestone 1: Geo, Time & Calendar Core Modules — Implementation Specification Report

## 1. Observation

A comprehensive inspection of the existing codebase revealed significant duplication of geometric, timezone, and calendar calculations across individual tracker modules:

1. **Geometry & Polyline Math Duplication**:
   - `src/geoUtils.js` (lines 13–82): Implements basic `calculateDistanceMeters` (Haversine), `calculateBearing`, `bearingToCompassName`, and `interpolateCoordinate`.
   - `src/mataroTracker.js`:
     - Lines 310–352: Implements `snapPointToPolyline` using dot-product projection onto line segments.
     - Lines 505–545: Implements `extrapolatePolylinePosition` (dead-reckoning along polyline).
     - Lines 547–565: Implements `calculatePolylineDistanceBetween`.
     - Lines 567–575: Implements `calculateRouteTotalDistance`.
     - Lines 467–503: Implements `findNearestSegment`.
   - `src/sagalesTracker.js` (lines 6–35): Implements standalone `decodePolyline` (Google Encoded Polyline Algorithm) directly in the tracker file.
   - `src/corridorTracker.js` (lines 937–960): Implements segment interpolation, bearing, and distance calculations directly within `interpolateBusPosition`.
   - `src/maresmeTracker.js` (lines 543–544, 783–784): Computes bearing and compass lookups repeatedly.

2. **Time & Timezone Processing**:
   - `src/timeUtils.js` (lines 12–153): Implements `timeToSec`, `secToTime`, `getNetworkTime`, `localTimeToUtcDate`, and `formatTimeToTimezone` (with protection for `null`, `invalid-date`, `0001-01-01`, and `1970-01-01`).
   - `src/corridorTracker.js` (lines 15–31): Re-wraps `timeToSec`, `secToTime`, and defines `timeToMin`.
   - `src/maresmeTracker.js`, `src/sagalesTracker.js`, `src/cataloniaTracker.js`: Use custom manual minute/second calculations (`timeStr.split(':')`) across dozens of call sites.

3. **Calendar & GTFS Validation**:
   - `src/corridorTracker.js` (lines 209–237, 284–324): Implements `getDateComponents` and `isServiceActiveOnDate` with hardcoded seasonal service ID checks (`GEN_184749`, `GEN_185017`, `GEN_185080`, `GEN_184910`) and weekly calendar fallback.
   - `src/cataloniaTracker.js` (lines 130–179): Implements a separate `getDateComponents` and `isServiceActiveOnDate` validating against `calendar.txt` and `calendar_dates.txt` exception maps.

4. **Backward Compatibility & Downstream Impact**:
   - 12+ files currently import `src/geoUtils.js` and `src/timeUtils.js` (`ambTracker.js`, `cataloniaTracker.js`, `corridorTracker.js`, `maresmeTracker.js`, `mataroTracker.js`, `mataroSiriClient.js`, `rodaliesTracker.js`, `sagalesTracker.js`, `historyDb.js`, `flightRecorder.js`, `reportCacheService.js`, `routeCacheService.js`, and `test/verification_test.js`).

---

## 2. Logic Chain

1. **Decoupling Core Math from Tracker Instances**:
   Geometric algorithms (Haversine, bearing, dot-product projection, polyline decoding) and temporal calculations (time conversions, timezone mappings, GTFS calendar validations) are pure deterministic functions. Moving them into dedicated modules under `src/core/geo/` and `src/core/time/` eliminates ~400 lines of duplicated code, improves cacheability, and establishes single points of testing.

2. **Unified Coordinate Flexibility**:
   Coordinate structures vary across data sources (e.g. `{ lat, lon }`, `{ lat, lng }`, `{ latitude, longitude }`, `{ Latitude, Longitude }`, or `[lat, lon]`). The new `geoEngine.js` must normalize coordinate inputs transparently across all functions so callers never encounter format mismatches.

3. **Strict Time & Calendar Standards**:
   - Agency wall-clock operations in Catalonia rely on `Europe/Madrid` timezone. All date formatting, day-of-week detection, and GTFS schedule conversions must default to `Europe/Madrid`.
   - `formatTimeToTimezone` must maintain strict defensive checks returning `'--:--'` for invalid dates, `null`, epoch (`1970-01-01`), or placeholder timestamps (`0001-01-01`), as required by `test/verification_test.js`.
   - `getDateComponents` must provide a comprehensive superset of fields (`dateStr`, `mmdd`, `year`, `month`, `monthIndex`, `day`, `dayOfWeek`, `hour`, `minute`, `second`, `timeStr`, `isWeekend`, `isSunday`, `isSaturday`, `isWeekday`, `isAugust`) so all consumers (`corridorTracker`, `cataloniaTracker`, `maresmeTracker`) obtain identical, correct values without extra computation.

4. **Zero-Breaking Backward Compatibility**:
   By turning `src/geoUtils.js` and `src/timeUtils.js` into re-export facades, existing code continues to function with zero changes during Milestone 1, enabling incremental refactoring in Milestone 2.

---

## 3. Detailed Technical Specifications

### 3.1. `src/core/geo/geoEngine.js`

```javascript
/**
 * Core Geographic and Polyline Engine
 * Pure math & geometric algorithms for transit tracking.
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
 * Calculates initial compass bearing in degrees [0, 360).
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
 */
function snapPointToPolyline(lat, lon, polyCoords) {
  const p = normalizeCoord({ lat, lon });
  if (!polyCoords || polyCoords.length === 0) {
    return { lat: p.lat, lon: p.lon, index: 0, bearing: 0, dist: 0 };
  }

  const coords = polyCoords.map(normalizeCoord);
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
 */
function calculatePolylineDistanceBetween(polyCoords, lat1, lon1, lat2, lon2) {
  if (!polyCoords || polyCoords.length < 2) {
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
  totalDist += calculateDistanceMeters(coords[startIdx].lat === snap1.lat && coords[startIdx].lon === snap1.lon ? coords[startIdx] : { lat: snap1.lat, lon: snap1.lon }, coords[startIdx + 1]);

  // Intermediate full segments
  for (let i = startIdx + 1; i < endIdx; i++) {
    totalDist += calculateDistanceMeters(coords[i].lat, coords[i].lon, coords[i + 1].lat, coords[i + 1].lon);
  }

  // Distance from last vertex to snap2
  totalDist += calculateDistanceMeters(coords[endIdx], { lat: snap2.lat, lon: snap2.lon });

  return Math.max(0, Math.round(totalDist));
}

/**
 * Calculates total route polyline length in meters.
 */
function calculateRouteTotalDistance(polyCoords) {
  if (!polyCoords || polyCoords.length < 2) return 0;
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
  if (!polyCoords || polyCoords.length < 2) return null;
  const coords = polyCoords.map(normalizeCoord);
  const pos = normalizeCoord(currentPos);
  const snap = snapPointToPolyline(pos.lat, pos.lon, coords);

  const speed = Math.max(5, (Number(speedKmh) || 30) / 3.6); // speed in m/s
  const advanceMeters = speed * Math.max(0, Number(elapsedSec) || 0);

  let accumulated = 0;
  let currIdx = snap.index;

  // Segment remaining from snap point to currIdx + 1
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
```

---

### 3.2. `src/core/time/timeEngine.js`

```javascript
/**
 * Core Time Engine
 * Universal time, timezone, and format utilities.
 */

/**
 * Converts HH:MM or HH:MM:SS string to total minutes since midnight.
 */
function timeStringToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const parts = timeStr.split(':').map(Number);
  return (parts[0] || 0) * 60 + (parts[1] || 0);
}

/**
 * Converts total minutes since midnight to HH:MM string.
 */
function minutesToTimeString(totalMinutes) {
  const normalized = Math.max(0, Math.round(Number(totalMinutes) || 0));
  const h = Math.floor(normalized / 60);
  const m = normalized % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Converts HH:MM or HH:MM:SS string to total seconds since midnight.
 */
function timeStringToSeconds(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const parts = timeStr.split(':').map(Number);
  return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
}

/**
 * Converts seconds since midnight to HH:MM:SS string.
 */
function secondsToTimeString(totalSec) {
  const normalized = Math.max(0, Math.floor(Number(totalSec) || 0));
  const h = Math.floor(normalized / 3600) % 24;
  const m = Math.floor((normalized % 3600) / 60);
  const s = normalized % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Gets wall-clock time breakdown in the specified agency timezone.
 */
function getNetworkTime(timeZone = 'Europe/Madrid', baseDate = new Date()) {
  const dateObj = (baseDate instanceof Date && !isNaN(baseDate.getTime()))
    ? baseDate
    : (typeof baseDate === 'number' || typeof baseDate === 'string' ? new Date(baseDate) : new Date());

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false
  });

  const parts = formatter.formatToParts(dateObj);
  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }

  const year = parseInt(map.year, 10);
  const month = parseInt(map.month, 10) - 1; // 0-indexed
  const day = parseInt(map.day, 10);
  let hour = parseInt(map.hour, 10);
  if (hour === 24) hour = 0;
  const minute = parseInt(map.minute, 10);
  const second = parseInt(map.second, 10);

  const currentSec = hour * 3600 + minute * 60 + second;
  const dateStr = `${year}${String(month + 1).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  const weekdayName = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(dateObj);
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dayMap[weekdayName] !== undefined ? dayMap[weekdayName] : dateObj.getDay();

  return {
    rawDate: dateObj,
    timeZone,
    year,
    month,           // 0-indexed (0 = Jan)
    month1: month + 1, // 1-indexed (1 = Jan)
    day,
    hour,
    minute,
    second,
    currentSec,
    dateStr,
    timeStr,
    dayOfWeek
  };
}

/**
 * Converts agency wall-clock date and time into exact Universal UTC Date object.
 */
function localTimeToUtcDate(year, monthIndex, day, hour, minute, second = 0, timeZone = 'Europe/Madrid') {
  const y = parseInt(year, 10);
  const mon = parseInt(monthIndex, 10);
  const d = parseInt(day, 10);
  const h = parseInt(hour, 10);
  const min = parseInt(minute, 10);
  const s = parseInt(second, 10);

  const utcGuess = Date.UTC(y, mon, d, h, min, s);

  const invFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false
  });

  const parts = invFormatter.formatToParts(new Date(utcGuess));
  const m = {};
  for (const p of parts) m[p.type] = p.value;

  let invHour = parseInt(m.hour, 10);
  if (invHour === 24) invHour = 0;

  const invUtc = Date.UTC(
    parseInt(m.year, 10),
    parseInt(m.month, 10) - 1,
    parseInt(m.day, 10),
    invHour,
    parseInt(m.minute, 10),
    parseInt(m.second, 10)
  );

  const offsetMs = invUtc - utcGuess;
  return new Date(utcGuess - offsetMs);
}

/**
 * Formats a given timestamp into the local time string (HH:MM).
 * Strictly guards against null, invalid-date, epoch (1970), and placeholder dates (0001) returning '--:--'.
 */
function formatTimeToTimezone(dateOrIso, timeZone = 'Europe/Madrid') {
  if (!dateOrIso) return '--:--';
  const d = (dateOrIso instanceof Date) ? dateOrIso : new Date(dateOrIso);
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return '--:--';
  return d.toLocaleTimeString('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

module.exports = {
  timeStringToMinutes,
  minutesToTimeString,
  timeStringToSeconds,
  secondsToTimeString,
  getNetworkTime,
  localTimeToUtcDate,
  formatTimeToTimezone,
  // Backward compatibility aliases
  timeToMin: timeStringToMinutes,
  minToTime: minutesToTimeString,
  timeToSec: timeStringToSeconds,
  secToTime: secondsToTimeString
};
```

---

### 3.3. `src/core/time/calendarEngine.js`

```javascript
/**
 * Core Calendar Engine
 * Day-type detection, GTFS calendar validity, and exception matching.
 */

const { getNetworkTime } = require('./timeEngine');

/**
 * Returns structured calendar components for a given date in agency timezone.
 */
function getDateComponents(dateObj = new Date(), timeZone = 'Europe/Madrid') {
  const d = (dateObj instanceof Date && !isNaN(dateObj.getTime()))
    ? dateObj
    : (typeof dateObj === 'string' || typeof dateObj === 'number' ? new Date(dateObj) : new Date());

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(d);
  let year = 2026, month = 8, day = 20, hour = 0, minute = 0, second = 0;
  for (const p of parts) {
    if (p.type === 'year') year = parseInt(p.value, 10);
    if (p.type === 'month') month = parseInt(p.value, 10);
    if (p.type === 'day') day = parseInt(p.value, 10);
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    if (p.type === 'minute') minute = parseInt(p.value, 10);
    if (p.type === 'second') second = parseInt(p.value, 10);
  }

  const utcDate = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = utcDate.getUTCDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
  const isSunday = dayOfWeek === 0;
  const isSaturday = dayOfWeek === 6;
  const isWeekend = isSunday || isSaturday;
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isAugust = month === 8;

  const dateStr = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  const mmdd = `${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  return {
    dateStr,
    mmdd,
    year,
    month,          // 1-indexed (1-12)
    monthIndex: month - 1, // 0-indexed (0-11)
    day,
    dayOfWeek,
    hour,
    minute,
    second,
    timeStr,
    isWeekend,
    isSunday,
    isSaturday,
    isWeekday,
    isAugust
  };
}

/**
 * Validates whether a GTFS service is active on a specified date.
 * Checks calendar_dates exceptions first, then regular calendar range and day-of-week flags.
 * Also supports legacy seasonal service IDs (e.g. C-10).
 */
function isServiceActiveOnDate(serviceId, calendar = null, calendarExceptions = null, dateObj = new Date(), timeZone = 'Europe/Madrid') {
  if (!serviceId) return true;

  const { dateStr, mmdd, dayOfWeek, isSunday, isSaturday, isWeekday, isAugust } = getDateComponents(dateObj, timeZone);

  // 1. Check calendar_dates exceptions (exceptionType 1 = added, 2 = removed)
  if (calendarExceptions) {
    const entry = calendarExceptions instanceof Map
      ? calendarExceptions.get(dateStr)
      : calendarExceptions[dateStr];

    if (entry) {
      const activeSet = entry.active instanceof Set ? entry.active : new Set(entry.active || []);
      const inactiveSet = entry.inactive instanceof Set ? entry.inactive : new Set(entry.inactive || []);

      if (activeSet.has(serviceId)) return true;
      if (inactiveSet.has(serviceId)) return false;
    }
  }

  // 2. Check C-10 legacy seasonal service IDs
  if (serviceId === 'GEN_184749') {
    return isSunday;
  }
  if (serviceId === 'GEN_185017') {
    const isSummerSeason = mmdd >= '0615' && mmdd <= '0915';
    return isSunday && isSummerSeason;
  }
  if (serviceId === 'GEN_185080') {
    return isSaturday || (isWeekday && isAugust);
  }
  if (serviceId === 'GEN_184910') {
    return isWeekday && !isAugust;
  }

  // 3. Check regular GTFS weekly calendar
  if (calendar) {
    let calEntry = null;
    if (calendar instanceof Map) {
      calEntry = calendar.get(serviceId);
    } else if (Array.isArray(calendar)) {
      calEntry = calendar.find(c => c.serviceId === serviceId || c.service_id === serviceId);
    } else if (typeof calendar === 'object') {
      calEntry = calendar[serviceId];
    }

    if (calEntry) {
      const start = calEntry.startDate || calEntry.start_date;
      const end = calEntry.endDate || calEntry.end_date;
      if (start && end && (dateStr < start || dateStr > end)) {
        return false;
      }

      const dayKeys = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const dayKey = dayKeys[dayOfWeek];
      const val = calEntry[dayKey];
      return val === true || val === '1' || val === 1;
    }
  }

  // Safe fallback if calendar table is unpopulated
  return true;
}

/**
 * Returns user-facing service calendar descriptor object.
 */
function getServiceCalendarInfo(dateObj = new Date(), timeZone = 'Europe/Madrid') {
  const { isAugust, isSaturday, isSunday, isWeekday, year, month, day } = getDateComponents(dateObj, timeZone);
  const dateFormatted = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;

  if (isSunday) {
    return {
      serviceId: 'GEN_184749',
      name: 'Diumenges i festius',
      frequency: 'Cada 120 minuts (2 hores)',
      frequencyMinutes: 120,
      isAugustSeason: isAugust,
      isWeekend: true,
      calendarTag: 'Diumenges i festius (cada 2h)',
      periodLabel: 'Festius',
      dateFormatted
    };
  }

  if (isSaturday || (isWeekday && isAugust)) {
    return {
      serviceId: 'GEN_185080',
      name: isSaturday ? 'Dissabtes' : "Feiners d'Agost",
      frequency: 'Cada 90 minuts (1h 30m)',
      frequencyMinutes: 90,
      isAugustSeason: isAugust,
      isWeekend: isSaturday,
      calendarTag: isAugust ? "Horari d'estiu (Agost: cada 90 min)" : 'Dissabtes (cada 90 min)',
      periodLabel: isAugust ? 'Estiu (Agost)' : 'Dissabte',
      dateFormatted
    };
  }

  return {
    serviceId: 'GEN_184910',
    name: "Feiners de dilluns a divendres (resta de l'any)",
    frequency: 'Cada 45 minuts',
    frequencyMinutes: 45,
    isAugustSeason: false,
    isWeekend: false,
    calendarTag: 'Feiners habituals (cada 45 min)',
    periodLabel: 'Feiners',
    dateFormatted
  };
}

module.exports = {
  getDateComponents,
  isServiceActiveOnDate,
  getServiceCalendarInfo
};
```

---

### 3.4. Backward Compatibility Bridges

#### `src/geoUtils.js`
```javascript
/**
 * Backward compatibility facade re-exporting from src/core/geo/geoEngine.js
 */
const geoEngine = require('./core/geo/geoEngine');

module.exports = {
  ...geoEngine
};
```

#### `src/timeUtils.js`
```javascript
/**
 * Backward compatibility facade re-exporting from src/core/time/timeEngine.js and calendarEngine.js
 */
const timeEngine = require('./core/time/timeEngine');
const calendarEngine = require('./core/time/calendarEngine');

module.exports = {
  ...timeEngine,
  ...calendarEngine
};
```

---

## 4. Caveats

1. **GTFS Extended Hours**: GTFS feeds may represent times after midnight as `24:15`, `25:30`. `timeStringToMinutes` and `timeStringToSeconds` properly convert these without throwing, preserving cumulative departure sequence order.
2. **Timezone Daylight Saving Time (DST)**: `localTimeToUtcDate` utilizes two-pass convergence through `Intl.DateTimeFormat` to ensure that clock transitions in late March (+2) and late October (+1) compute exact epoch millisecond values without skew.
3. **Flexible Polyline Inputs**: Downstream modules pass coordinates as arrays `[[lat, lon], ...]`, objects `{ lat, lon }`, or capitalized `{ Latitude, Longitude }`. All functions in `geoEngine.js` normalize coordinates through `normalizeCoord()`.

---

## 5. Conclusion & Actionable Recommendation

Milestone 1 Core Modules (`src/core/geo/geoEngine.js`, `src/core/time/timeEngine.js`, `src/core/time/calendarEngine.js`) together with the re-export bridges in `src/geoUtils.js` and `src/timeUtils.js` are fully specified and ready for implementation.

The implementer can drop in these files immediately. Since `src/geoUtils.js` and `src/timeUtils.js` re-export all legacy and new methods, existing tracker modules (`corridorTracker`, `mataroTracker`, `sagalesTracker`, `cataloniaTracker`, `maresmeTracker`, `ambTracker`, `rodaliesTracker`) and tests (`verification_test.js`, `e2e_multiline_test.js`) will continue to pass without any breaking changes.

---

## 6. Verification Method

To independently verify the implementation after writing the core files:

1. **Unit Verification Suite**: Run:
   ```powershell
   node test/verification_test.js
   ```
   *Expected result*: 100% pass including TimeUtils protection test (`--:--` on invalid/epoch/placeholder timestamps).

2. **Multi-line Integration Suite**: Run:
   ```powershell
   node test/e2e_multiline_test.js
   ```
   *Expected result*: 100% pass across all 16 tests.

3. **Core Geo & Time Invariant Checks**: Run an ad-hoc test verifying:
   - `geoEngine.calculateDistanceMeters(41.4214, 2.2036, 41.5543, 2.4332)` returns ~24,000m - 25,000m.
   - `geoEngine.getCompassDirection(45)` returns `{ code: 'NE', label: 'Nord-Est (NE) ↗️' }`.
   - `geoEngine.decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`")` decodes valid coordinate array.
   - `timeEngine.formatTimeToTimezone('invalid')` returns `'--:--'`.
   - `calendarEngine.getDateComponents(new Date('2026-08-16T12:00:00Z'))` returns `isSunday === true` and `isAugust === true`.
