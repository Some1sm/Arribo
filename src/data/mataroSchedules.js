/**
 * src/data/mataroSchedules.js
 * 
 * Authoritative Mataró Bus Timetable & Route Topography Module.
 * Exports official CTSA/Avanza scheduled departures, stop-by-stop cumulative run times,
 * and helper query utilities for all 8 Mataró urban lines (Lines 1–8).
 */

const rawSchedules = require('./mataro_schedules.json');

/**
 * Normalizes line identifier (e.g. '1', 1, 'mataro_1', 'L1', 'Line 1') -> '1'..'8'
 * 
 * @param {string|number} lineId 
 * @returns {string}
 */
function normalizeLineId(lineId) {
  if (lineId === null || lineId === undefined) return '1';
  const clean = String(lineId).toLowerCase().trim()
    .replace(/^mataro_?/, '')
    .replace(/^line-?/, '')
    .replace(/^linia-?/, '')
    .replace(/^l(?=[1-8]$)/, '')
    .trim();
  return clean || '1';
}

/**
 * Normalizes day type string to canonical keys: 'weekday', 'saturday', 'sunday'
 * 
 * @param {string} dayType 
 * @returns {'weekday'|'saturday'|'sunday'}
 */
function normalizeDayType(dayType) {
  if (!dayType) return 'weekday';
  const s = String(dayType).toLowerCase().trim();
  if (s.includes('dissabte') || s.includes('sat') || s === '6') {
    return 'saturday';
  }
  if (s.includes('diumenge') || s.includes('festiu') || s.includes('sun') || s.includes('hol') || s === '0' || s === '7') {
    return 'sunday';
  }
  return 'weekday';
}

/**
 * Normalizes day type to official Catalan label: 'Feiners', 'Dissabtes', 'Diumenges i Festius'
 * 
 * @param {string} dayType 
 * @returns {'Feiners'|'Dissabtes'|'Diumenges i Festius'}
 */
function toCatalanDayType(dayType) {
  const norm = normalizeDayType(dayType);
  if (norm === 'saturday') return 'Dissabtes';
  if (norm === 'sunday') return 'Diumenges i Festius';
  return 'Feiners';
}

/**
 * Retrieves the full schedule record for a Mataró Bus line.
 * 
 * @param {string|number} lineId 
 * @returns {object|null}
 */
function getLineSchedule(lineId) {
  const cleanId = normalizeLineId(lineId);
  return rawSchedules[cleanId] || null;
}

/**
 * Retrieves direction details and departure matrices for a specific line, direction, and day.
 * 
 * @param {string|number} lineId 
 * @param {string|number} [direction='0'] - Direction index ('0'/'1') or path ID ('11'/'12'/'21')
 * @param {string} [dayType='weekday'] - 'weekday', 'saturday', 'sunday', 'Feiners', etc.
 * @returns {{
 *   lineId: string,
 *   lineName: string,
 *   dirId: string,
 *   pathId: string,
 *   directionName: string,
 *   departures: string[],
 *   stops: Array<object>,
 *   stopTravelSecMap: Record<string, number>,
 *   totalTravelSec: number,
 *   totalTravelMinutes: number,
 *   totalDistanceMeters: number,
 *   totalDistanceKm: number,
 *   afternoonOnly: boolean,
 *   firstTrip: string|null,
 *   lastTrip: string|null,
 *   tripsCount: number
 * }|null}
 */
function getDirectionSchedule(lineId, direction = '0', dayType = 'weekday') {
  const lineObj = getLineSchedule(lineId);
  if (!lineObj) return null;

  const dirKey = String(direction !== null && direction !== undefined ? direction : '0').trim();
  let dirObj = lineObj.directionIndices[dirKey] || lineObj.directions[dirKey];

  if (!dirObj) {
    // Default to index 0 or first available direction
    dirObj = lineObj.directionIndices['0'] || Object.values(lineObj.directions)[0];
  }

  if (!dirObj) return null;

  const normDay = normalizeDayType(dayType);
  const catDay = toCatalanDayType(dayType);
  const departures = dirObj.schedules[normDay] || dirObj.schedules[catDay] || [];
  const afternoonOnly = Boolean(dirObj.afternoonOnly?.[normDay]);

  return {
    lineId: lineObj.lineId,
    code: lineObj.code,
    lineName: lineObj.lineName,
    color: lineObj.color,
    dirId: dirObj.dirId,
    pathId: dirObj.pathId,
    direction: dirObj.direction,
    directionName: dirObj.directionName,
    originStop: dirObj.originStop,
    terminalStop: dirObj.terminalStop,
    departures: departures,
    stops: dirObj.stops || [],
    stopTravelSecMap: dirObj.stopTravelSecMap || {},
    totalTravelSec: dirObj.totalTravelSec || 0,
    totalTravelMinutes: dirObj.totalTravelMinutes || 0,
    totalDistanceMeters: dirObj.totalDistanceMeters || 0,
    totalDistanceKm: dirObj.totalDistanceKm || 0,
    afternoonOnly: afternoonOnly,
    firstTrip: departures[0] || null,
    lastTrip: departures[departures.length - 1] || null,
    tripsCount: departures.length
  };
}

/**
 * Looks up the cumulative travel time in seconds from route origin to a target stop.
 * 
 * @param {string|number} lineId 
 * @param {string|number} [direction='0'] 
 * @param {string|number} stopId 
 * @returns {number} Travel time in seconds (0 if origin or not found)
 */
function getStopTravelTime(lineId, direction = '0', stopId) {
  const dirSched = getDirectionSchedule(lineId, direction);
  if (!dirSched || !dirSched.stopTravelSecMap) return 0;
  const sId = String(stopId);
  return dirSched.stopTravelSecMap[sId] || 0;
}

/**
 * Computes passing timetable departure times at a specific stop by adding stop travel time
 * to origin departures.
 * 
 * @param {string|number} lineId 
 * @param {string|number} [direction='0'] 
 * @param {string|number} stopId 
 * @param {string} [dayType='weekday'] 
 * @returns {string[]} Array of passing times in 'HH:MM' format
 */
function getDeparturesForStop(lineId, direction = '0', stopId, dayType = 'weekday') {
  const dirSched = getDirectionSchedule(lineId, direction, dayType);
  if (!dirSched || !Array.isArray(dirSched.departures)) return [];

  const travelSec = getStopTravelTime(lineId, direction, stopId);
  if (travelSec === 0) return dirSched.departures.slice();

  return dirSched.departures.map(originTime => {
    const [hStr, mStr] = originTime.split(':');
    const baseSec = parseInt(hStr, 10) * 3600 + parseInt(mStr, 10) * 60;
    const passSec = baseSec + travelSec;
    const passH = Math.floor(passSec / 3600) % 24;
    const passM = Math.floor((passSec % 3600) / 60);
    return `${String(passH).padStart(2, '0')}:${String(passM).padStart(2, '0')}`;
  });
}

/**
 * Returns summary catalog of all 8 Mataró urban lines.
 * 
 * @returns {Array<object>}
 */
function getAllLines() {
  return Object.values(rawSchedules).map(l => ({
    id: l.lineId,
    code: l.code,
    name: l.lineName,
    color: l.color,
    agency: l.agency,
    operator: l.operator,
    directions: Object.values(l.directionIndices).map(d => ({
      dirId: d.dirId,
      pathId: d.pathId,
      name: d.directionName,
      stopsCount: d.stopsCount,
      distanceKm: d.totalDistanceKm,
      travelMinutes: d.totalTravelMinutes,
      weekdayTrips: d.scheduleStats?.weekday?.count || 0,
      saturdayTrips: d.scheduleStats?.saturday?.count || 0,
      sundayTrips: d.scheduleStats?.sunday?.count || 0
    }))
  }));
}

/**
 * Helper to convert HH:MM(:SS) string to seconds of day.
 * 
 * @param {string} timeStr 
 * @returns {number}
 */
function timeStringToSec(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return 0;
  const parts = timeStr.split(':');
  const h = parseInt(parts[0], 10) || 0;
  const m = parseInt(parts[1], 10) || 0;
  const s = parseInt(parts[2], 10) || 0;
  return h * 3600 + m * 60 + s;
}

/**
 * Dynamically computes the scheduled active vehicle requirement (fleet size)
 * for a line and day type directly from the official timetable schedule.
 * Uses the fundamental transit scheduling theorem: Fleet = ceil(CycleTime / Headway).
 * 
 * @param {string|number} lineId 
 * @param {string} dayType 
 * @param {number|null} [nowSec=null] Optional seconds of day to evaluate local service period
 * @returns {number}
 */
function getScheduledFleetRequirement(lineId, dayType, nowSec = null) {
  const normLine = normalizeLineId(lineId);
  const normDay = normalizeDayType(dayType);
  const s0 = getDirectionSchedule(normLine, '0', normDay);
  const s1 = getDirectionSchedule(normLine, '1', normDay);

  if (!s0 || !s1 || !Array.isArray(s0.departures) || !Array.isArray(s1.departures)) return 1;
  if (s0.departures.length === 0 && s1.departures.length === 0) return 0;

  const t0 = s0.totalTravelSec || (s0.totalTravelMinutes * 60) || 1800;
  const t1 = s1.totalTravelSec || (s1.totalTravelMinutes * 60) || 1800;

  // If nowSec is provided, check if service is currently operating
  if (nowSec !== null) {
    const allDepSecs = [
      ...s0.departures.map(d => timeStringToSec(d)),
      ...s1.departures.map(d => timeStringToSec(d))
    ].sort((a, b) => a - b);

    if (allDepSecs.length === 0) return 0;
    const firstServiceSec = Math.max(0, allDepSecs[0] - 1200); // 20m buffer before first departure
    const lastServiceSec = allDepSecs[allDepSecs.length - 1] + Math.max(t0, t1);

    if (nowSec < firstServiceSec || nowSec > lastServiceSec) {
      return 0; // Off-hours inactive service
    }
  }

  const roundTripSec = t0 + t1;

  // Derive headways from departure intervals
  const localHeadways = [];
  const globalHeadways = [];

  [s0.departures, s1.departures].forEach(deps => {
    for (let i = 1; i < deps.length; i++) {
      const pSec = timeStringToSec(deps[i - 1]);
      const cSec = timeStringToSec(deps[i]);
      const diff = cSec - pSec;
      if (diff >= 300 && diff <= 5400) {
        globalHeadways.push(diff);
        if (nowSec !== null && cSec >= nowSec - 7200 && pSec <= nowSec + 7200) {
          localHeadways.push(diff);
        }
      }
    }
  });

  const headways = localHeadways.length > 0 ? localHeadways : globalHeadways;
  if (headways.length === 0) return 1;

  headways.sort((a, b) => a - b);
  const medianHeadwaySec = headways[Math.floor(headways.length / 2)];

  // Measure actual scheduled turnaround buffers between arrival and next departure
  let bufferSum = 0;
  let bufferCount = 0;
  [ { from: s0, to: s1, travel: t0 }, { from: s1, to: s0, travel: t1 } ].forEach(pair => {
    pair.from.departures.forEach(dep => {
      const arr = timeStringToSec(dep) + pair.travel;
      const nextDep = pair.to.departures
        .map(d => timeStringToSec(d))
        .find(d => d >= arr && d <= arr + 2400);
      if (nextDep !== undefined) {
        if (nowSec === null || (arr >= nowSec - 7200 && arr <= nowSec + 7200)) {
          bufferSum += (nextDep - arr);
          bufferCount++;
        }
      }
    });
  });

  const avgBuffer = bufferCount > 0 ? (bufferSum / bufferCount) : Math.max(180, roundTripSec * 0.08);
  const cycleSec = roundTripSec + (avgBuffer * 2);

  // Fundamental transit scheduling theorem: Fleet = ceil(CycleTime / Headway)
  const calculatedFleet = Math.ceil(cycleSec / medianHeadwaySec);
  return Math.max(1, calculatedFleet);
}

module.exports = {
  rawSchedules,
  normalizeLineId,
  normalizeDayType,
  toCatalanDayType,
  getLineSchedule,
  getDirectionSchedule,
  getStopTravelTime,
  getDeparturesForStop,
  getAllLines,
  getScheduledFleetRequirement
};
