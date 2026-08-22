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

module.exports = {
  rawSchedules,
  normalizeLineId,
  normalizeDayType,
  toCatalanDayType,
  getLineSchedule,
  getDirectionSchedule,
  getStopTravelTime,
  getDeparturesForStop,
  getAllLines
};
