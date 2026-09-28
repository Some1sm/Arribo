/**
 * src/data/mataroSchedules.js
 * 
 * Authoritative Mataró Bus Timetable & Route Topography Module.
 * Exports official CTSA/Avanza scheduled departures, stop-by-stop cumulative run times,
 * and helper query utilities for all 8 Mataró urban lines (Lines 1–8).
 */

const seasonCalendar = require('./seasonCalendar');

/**
 * The pre-season file. Kept as a fallback and as the source of stop geometry,
 * but it is NOT what the app serves: it was found to hold a mixture of the
 * winter and summer grids (on L1/L2/L4/L6/L8 direction 11 was winter while
 * direction 12 was summer), so serving it produced correct times one way and
 * wrong times back with nothing able to detect it.
 */
const legacySchedules = require('./mataro_schedules.json');

/** Both seasonal grids, produced by scripts/scrape_maresme_timetables.js. */
let seasonsFile = null;
try {
  seasonsFile = require('./mataro_schedules.seasons.json');
} catch {
  seasonsFile = null;
}

/**
 * Resolves the grid in force right now, cached per (season, known, source).
 *
 * Resolution happens HERE, at the module boundary, rather than in each caller.
 * That is deliberate: getDirectionSchedule and friends are called from ~40
 * places in the tracker, planner and trip matcher, and threading a season
 * through all of them would be both invasive and easy to get wrong at one call
 * site. An optional `season` argument is still accepted for callers that
 * genuinely need a specific one.
 *
 * A missing seasons file is not fatal — the legacy grid is served and the
 * situation is reported through getScheduleValidity() rather than thrown, so a
 * fresh clone still starts.
 */
let _activeCache = null;
function activeGrid() {
  const res = seasonCalendar.resolveSeason();
  const key = `${res.season}|${res.known}|${res.source}`;
  if (_activeCache && _activeCache.key === key) return _activeCache;

  const chosen = seasonsFile && seasonsFile.seasons ? seasonsFile.seasons[res.season] : null;
  _activeCache = {
    key,
    resolution: res,
    data: chosen || legacySchedules,
    usingSeasonsFile: Boolean(chosen),
    meta: chosen ? (seasonsFile._meta || {}) : (legacySchedules._meta || {})
  };
  return _activeCache;
}

/** The timetable grid currently in force, as the legacy raw shape. */
function rawSchedules() {
  return activeGrid().data;
}

/**
/**
 * The grid for a named season. Returns null when that season is not available,
 * rather than quietly substituting the active one: asking for summer and being
 * handed winter is the bug this whole change exists to eliminate.
 */
function gridFor(season) {
  const norm = normalizeSeason(season);
  if (!norm) return null;
  if (norm === activeGrid().resolution.season) return activeGrid().data;
  const s = seasonsFile && seasonsFile.seasons ? seasonsFile.seasons[norm] : null;
  return s || null;
}

/**
 * Normalizes a caller-supplied season. Returns null for anything unrecognised
 * rather than defaulting: a wrong-but-confident grid is the exact failure this
 * module exists to prevent.
 */
function normalizeSeason(season) {
  if (season === null || season === undefined || season === '') return activeGrid().resolution.season;
  const s = String(season).toLowerCase().trim();
  if (s === 'hivern' || s === 'invierno' || s === 'winter') return 'winter';
  if (s === 'estiu' || s === 'verano' || s === 'summer') return 'summer';
  return null;
}

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
function getLineSchedule(lineId, season) {
  const grid = gridFor(season);
  if (!grid) return null;
  const cleanId = normalizeLineId(lineId);
  if (!/^[1-8]$/.test(cleanId)) return null;
  return grid[cleanId] || null;
}

/**
 * Resolves a caller-supplied direction onto a key of lineObj.directions.
 *
 * Callers use two forms in the wild: the legacy numeric index ('0'/'1', the
 * position of the direction in the route array) and the Avanza path id
 * ('11'/'12'/'21'). Both are accepted. `directionIndexOrder` in the data file
 * maps the index form onto a `directions` key.
 *
 * Returns null for anything unrecognised. A wrong-but-confident timetable is
 * worse than no timetable, so this deliberately has no default fallback: the
 * file previously carried a second, stale copy of every direction and this
 * function silently substituted one for the other, which is how uncalibrated
 * cumulative offsets reached production.
 *
 * @param {object} lineObj
 * @param {string|number} direction
 * @returns {string|null} A key of lineObj.directions, or null.
 */
function resolveDirectionKey(lineObj, direction) {
  if (!lineObj || !lineObj.directions) return null;
  const dirKeys = Object.keys(lineObj.directions);
  const key = String(direction === null || direction === undefined ? '' : direction).trim();
  if (!key) return null;

  const order = lineObj.directionIndexOrder || dirKeys;

  // Legacy index form: '0' / '1'.
  if (/^\d+$/.test(key) && order[Number(key)] !== undefined) return order[Number(key)];

  // Direct path-id form: '11' / '12' / '21'.
  if (lineObj.directions[key]) return key;

  // A path id arriving in another numeric shape, e.g. 11 as a number.
  return dirKeys.find(dk => String(lineObj.directions[dk].pathId) === key) || null;
}

/**
 * Whether a direction is present, resolvable and not marked as known-bad.
 *
 * @param {string|number} lineId
 * @param {string|number} direction
 * @returns {boolean}
 */
function isDirectionUsable(lineId, direction, season) {
  const lineObj = getLineSchedule(lineId, season);
  const key = resolveDirectionKey(lineObj, direction);
  if (!key) return false;
  return !lineObj.directions[key]._invalid;
}

/**
 * Validity metadata for the loaded timetable, including which seasonal grid is
 * in force and why.
 *
 * `validUntil: null` means the scraper has not recorded one. That is reported
 * as unknown, never as "current" - the file previously carried no validity
 * information at all, so a stale timetable could not be detected.
 *
 * The season block is the important half: `seasonKnown: false` means we are
 * serving a grid on a date we hold no evidence for, which the UI must say
 * rather than present as authoritative.
 *
 * @returns {{validUntil: string|null, expired: boolean, known: boolean, source: string,
 *   season: string, seasonSource: string, seasonKnown: boolean,
 *   seasonsAvailable: string[], usingSeasonsFile: boolean}}
 */
function getScheduleValidity() {
  const active = activeGrid();
  const meta = active.meta || {};
  const validUntil = meta.validUntil || null;
  const seasonBlock = {
    season: active.resolution.season,
    seasonSource: active.resolution.source,
    seasonKnown: Boolean(active.resolution.known),
    seasonsAvailable: seasonsFile && seasonsFile.seasons ? Object.keys(seasonsFile.seasons) : [],
    usingSeasonsFile: active.usingSeasonsFile
  };
  if (!validUntil) {
    return { validUntil: null, expired: false, known: false, source: meta.source || '', ...seasonBlock };
  }
  const expiry = Date.parse(`${validUntil}T23:59:59Z`);
  const known = Number.isFinite(expiry);
  return {
    validUntil,
    known,
    expired: known && Date.now() > expiry,
    source: meta.source || '',
    ...seasonBlock
  };
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
function getDirectionSchedule(lineId, direction = '0', dayType = 'weekday', season) {
  const lineObj = getLineSchedule(lineId, season);
  if (!lineObj) return null;

  const dirKey = resolveDirectionKey(lineObj, direction);
  if (!dirKey) return null;
  const dirObj = lineObj.directions[dirKey];
  if (!dirObj) return null;

  // Directions flagged by the data build as known-bad are refused outright.
  // Serving a corrupt timetable is worse than serving none: the caller labels
  // what it gets as authoritative, so a wrong-but-confident answer here becomes
  // a wrong arrival time on the board.
  if (dirObj._invalid) return null;

  const normDay = normalizeDayType(dayType);
  const catDay = toCatalanDayType(dayType);
  const departures = dirObj.schedules[normDay] || dirObj.schedules[catDay] || [];
  const rawTrips = (dirObj.dayTrips && (dirObj.dayTrips[normDay] || dirObj.dayTrips[catDay])) || [];
  const trips = rawTrips.map((t, idx) => ({
    index: idx,
    stopSecs: Array.isArray(t.s) ? t.s.slice() : []
  }));
  const afternoonOnly = Boolean(dirObj.afternoonOnly?.[normDay]);
  const totalTravelSec = (dirObj.dayTravelSec && dirObj.dayTravelSec[normDay]) || dirObj.totalTravelSec || 0;
  const totalTravelMinutes = Math.round(totalTravelSec / 60) || dirObj.totalTravelMinutes || 0;
  const stopTravelSecMap = (dirObj.dayStopTravelSec && dirObj.dayStopTravelSec[normDay]) || dirObj.stopTravelSecMap || {};

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
    trips: trips,
    stops: dirObj.stops || [],
    stopTravelSecMap: stopTravelSecMap,
    // Stops whose cumulative offset is a repaired estimate rather than a
    // calibrated value. Every direction's terminus is in here: the data build
    // wrote a direction total into the terminal's offset slot, so the true
    // terminal offset was never known. A leg touching one of these must be
    // reported as an estimate, not as a timetable time.
    estimatedStopIds: Array.isArray(dirObj._estimatedStops) ? dirObj._estimatedStops.slice() : [],
    totalTravelSec: totalTravelSec,
    totalTravelMinutes: totalTravelMinutes,
    totalDistanceMeters: dirObj.totalDistanceMeters || 0,
    totalDistanceKm: dirObj.totalDistanceKm || 0,
    afternoonOnly: afternoonOnly,
    firstTrip: departures[0] || null,
    lastTrip: departures[departures.length - 1] || null,
    tripsCount: departures.length
  };
}

/**
 * Returns all published trips that serve a specific stop, with their scheduled times.
 *
 * @param {string|number} lineId
 * @param {string|number} [direction='0']
 * @param {string|number} stopId
 * @param {string} [dayType='weekday']
 * @param {string} [season]
 * @returns {Array<{ tripIndex: number, originSec: number|null, stopSec: number, firstStopIndex: number, lastStopIndex: number }>}
 */
function getTripsServingStop(lineId, direction = '0', stopId, dayType = 'weekday', season) {
  const dirSched = getDirectionSchedule(lineId, direction, dayType, season);
  if (!dirSched || !Array.isArray(dirSched.stops)) return [];

  const sId = String(stopId);
  const stopIndex = dirSched.stops.findIndex(s => String(s.id) === sId);
  if (stopIndex < 0) return [];

  if (Array.isArray(dirSched.trips) && dirSched.trips.length > 0) {
    const results = [];
    for (const t of dirSched.trips) {
      const stopSec = t.stopSecs[stopIndex];
      if (stopSec === null || stopSec === undefined || !Number.isFinite(stopSec)) continue;

      let firstStopIndex = -1;
      let lastStopIndex = -1;
      for (let i = 0; i < t.stopSecs.length; i++) {
        if (t.stopSecs[i] !== null && t.stopSecs[i] !== undefined) {
          if (firstStopIndex === -1) firstStopIndex = i;
          lastStopIndex = i;
        }
      }

      const originSec = (t.stopSecs[0] !== null && t.stopSecs[0] !== undefined) ? t.stopSecs[0] : null;
      results.push({
        tripIndex: t.index,
        originSec,
        stopSec,
        firstStopIndex,
        lastStopIndex
      });
    }
    return results.sort((a, b) => a.stopSec - b.stopSec || a.tripIndex - b.tripIndex);
  }

  // Fallback for legacy data without dayTrips
  const travelSec = (dirSched.stopTravelSecMap && dirSched.stopTravelSecMap[sId]) ?? 0;
  return (dirSched.departures || []).map((dep, idx) => {
    const originSec = timeStringToSec(dep);
    return {
      tripIndex: idx,
      originSec,
      stopSec: originSec + travelSec,
      firstStopIndex: 0,
      lastStopIndex: dirSched.stops.length - 1
    };
  }).sort((a, b) => a.stopSec - b.stopSec);
}

/**
 * Looks up the published passing time in seconds-of-day for a specific trip at a stop.
 * Trip is identified by its origin departure time ('HH:MM').
 *
 * @param {string|number} lineId
 * @param {string|number} [direction='0']
 * @param {string} originDep - 'HH:MM' departure time at route origin
 * @param {string|number} stopId
 * @param {string} [dayType='weekday']
 * @param {string} [season]
 * @returns {number|null} seconds-of-day or null if trip does not exist or does not serve the stop
 */
function getTripStopTime(lineId, direction = '0', originDep, stopId, dayType = 'weekday', season) {
  const dirSched = getDirectionSchedule(lineId, direction, dayType, season);
  if (!dirSched || !Array.isArray(dirSched.stops)) return null;

  const sId = String(stopId);
  const stopIndex = dirSched.stops.findIndex(s => String(s.id) === sId);
  if (stopIndex < 0) return null;

  const targetOriginSec = timeStringToSec(originDep);

  if (Array.isArray(dirSched.trips) && dirSched.trips.length > 0) {
    const trip = dirSched.trips.find(t => {
      if (t.stopSecs[0] === null || t.stopSecs[0] === undefined) return false;
      return ((t.stopSecs[0] % 86400) + 86400) % 86400 === targetOriginSec;
    });
    if (!trip) return null;
    const stopSec = trip.stopSecs[stopIndex];
    return (stopSec !== null && stopSec !== undefined && Number.isFinite(stopSec)) ? stopSec : null;
  }

  // Fallback for legacy
  if (!dirSched.departures.includes(originDep)) return null;
  const travelSec = (dirSched.stopTravelSecMap && dirSched.stopTravelSecMap[sId]) ?? null;
  return travelSec !== null ? targetOriginSec + travelSec : null;
}

/**
 * Median profile across all trips. For position interpolation only; never use it
 * to display or plan a time — use getTripStopTime / getTripsServingStop.
 *
 * Looks up the cumulative travel time in seconds from route origin to a target stop.
 * 
 * @param {string|number} lineId 
 * @param {string|number} [direction='0'] 
 * @param {string|number} stopId 
 * @param {string} [dayType='weekday']
 * @returns {number} Travel time in seconds (0 if origin or not found)
 */
function getStopTravelTime(lineId, direction = '0', stopId, dayType = 'weekday', season) {
  const dirSched = getDirectionSchedule(lineId, direction, dayType, season);
  if (!dirSched || !dirSched.stopTravelSecMap) return 0;
  const sId = String(stopId);
  return dirSched.stopTravelSecMap[sId] || 0;
}

/**
 * Whether a stop is part of this direction's stop list.
 *
 * Needed to tell a legitimate cumulative travel time of 0 (the origin) apart
 * from "this stop is not in this timetable". getStopTravelTime returns 0 for
 * both, which previously made an unknown stop id resolve to the origin board.
 *
 * @param {string|number} lineId
 * @param {string|number} [direction='0']
 * @param {string|number} stopId
 * @param {string} [dayType='weekday']
 * @returns {boolean}
 */
function hasStopInSchedule(lineId, direction = '0', stopId, dayType = 'weekday', season) {
  const dirSched = getDirectionSchedule(lineId, direction, dayType, season);
  if (!dirSched || !Array.isArray(dirSched.stops)) return false;
  const sId = String(stopId);
  return dirSched.stops.some(s => String(s.id) === sId);
}

/**
 * Computes passing timetable departure times at a specific stop directly from
 * published per-trip stop times (dayTrips).
 *
 * Returns an empty array when the stop is not part of this direction.
 *
 * @param {string|number} lineId
 * @param {string|number} [direction='0']
 * @param {string|number} stopId
 * @param {string} [dayType='weekday']
 * @param {string} [season]
 * @returns {string[]} Array of passing times in 'HH:MM' format; empty if unresolvable
 */
function getDeparturesForStop(lineId, direction = '0', stopId, dayType = 'weekday', season) {
  const trips = getTripsServingStop(lineId, direction, stopId, dayType, season);
  if (!trips.length) return [];

  return trips.map(t => {
    const passSec = ((t.stopSec % 86400) + 86400) % 86400;
    const passH = Math.floor(passSec / 3600);
    const passM = Math.floor((passSec % 3600) / 60);
    return `${String(passH).padStart(2, '0')}:${String(passM).padStart(2, '0')}`;
  });
}

/**
 * Returns summary catalog of all 8 Mataró urban lines.
 * 
 * @returns {Array<object>}
 */
function getAllLines(season) {
  const grid = gridFor(season);
  if (!grid) return [];
  // _meta is a top-level key in the data file, not a line.
  return Object.keys(grid)
    .filter(k => k !== '_meta')
    .map(k => grid[k])
    .map(l => ({
    id: l.lineId,
    code: l.code,
    name: l.lineName,
    color: l.color,
    agency: l.agency,
    operator: l.operator,
    directions: (l.directionIndexOrder || Object.keys(l.directions || {}))
      .map(k => l.directions[k])
      .filter(d => d && !d._invalid)
      .map(d => ({
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

// Parsed trip intervals per timetable. Keyed by the departures array the loader
// returns (the same array object for the same line/direction/day/season), so a
// season or data change produces a new key and never a stale answer.
const _fleetIntervalCache = new WeakMap();

function fleetIntervals(s0, s1, t0, t1) {
  const hit = _fleetIntervalCache.get(s0.departures);
  if (hit && hit.dep1 === s1.departures && hit.t0 === t0 && hit.t1 === t1) return hit;
  const dep0 = s0.departures.map(d => timeStringToSec(d));
  const dep1 = s1.departures.map(d => timeStringToSec(d));
  const starts = [...dep0, ...dep1].sort((a, b) => a - b);
  const ends = [...dep0.map(s => s + t0 + 60), ...dep1.map(s => s + t1 + 60)].sort((a, b) => a - b);
  const entry = { dep1: s1.departures, t0, t1, starts, ends };
  _fleetIntervalCache.set(s0.departures, entry);
  return entry;
}

/** How many values of the ascending array `sorted` are <= x. */
function countAtOrBelow(sorted, x) {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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
function getScheduledFleetRequirement(lineId, dayType, nowSec = null, season) {
  const normLine = normalizeLineId(lineId);
  const normDay = normalizeDayType(dayType);
  const s0 = getDirectionSchedule(normLine, '0', normDay, season);
  const s1 = getDirectionSchedule(normLine, '1', normDay, season);

  if (!s0 || !s1 || !Array.isArray(s0.departures) || !Array.isArray(s1.departures)) return 1;
  if (s0.departures.length === 0 && s1.departures.length === 0) return 0;

  const t0 = s0.totalTravelSec || (s0.totalTravelMinutes * 60) || 1800;
  const t1 = s1.totalTravelSec || (s1.totalTravelMinutes * 60) || 1800;
  const { starts, ends } = fleetIntervals(s0, s1, t0, t1);

  // If nowSec is provided, check if service is currently operating
  if (nowSec !== null) {
    if (starts.length === 0) return 0;
    const firstServiceSec = Math.max(0, starts[0] - 1200); // 20m buffer before first departure
    const lastServiceSec = starts[starts.length - 1] + Math.max(t0, t1);
    if (nowSec < firstServiceSec || nowSec > lastServiceSec) {
      return 0; // Off-hours inactive service
    }
  }

  if (starts.length === 0) return 0;

  // Maximum concurrent trips over the next hour, sampled every 30 s. A trip is
  // active at s when start <= s < end, so the count is (#starts <= s) - (#ends <= s)
  // because every end is later than its own start.
  const winStart = nowSec !== null ? nowSec : 0;
  const winEnd = nowSec !== null ? Math.min(86400, nowSec + 3600) : 86400;

  let maxConcurrent = 0;
  for (let s = winStart; s <= winEnd; s += 30) {
    const count = countAtOrBelow(starts, s) - countAtOrBelow(ends, s);
    if (count > maxConcurrent) maxConcurrent = count;
  }

  return nowSec !== null ? maxConcurrent : Math.max(1, maxConcurrent);
}

module.exports = {
  normalizeLineId,
  normalizeSeason,
  getActiveSeason,
  normalizeDayType,
  toCatalanDayType,
  getLineSchedule,
  resolveDirectionKey,
  isDirectionUsable,
  getScheduleValidity,
  getDirectionSchedule,
  hasStopInSchedule,
  getStopTravelTime,
  getTripsServingStop,
  getTripStopTime,
  getDeparturesForStop,
  getAllLines,
  getScheduledFleetRequirement,
  timeStringToSec,
  getSeasonOutlook: (at) => seasonCalendar.getSeasonOutlook(at),
  getServiceWindow
};

/**
 * Calculates the revenue service window for a line on a given dayType:
 * from (first departure of the day − 15 min) to (last departure + that trip's duration from dayTrips + 20 min).
 *
 * @param {string|number} lineId
 * @param {string} [dayType='weekday']
 * @param {string|null} [season=null]
 * @returns {{ startSec: number, endSec: number } | null}
 */
function getServiceWindow(lineId, dayType = 'weekday', season = null) {
  const lId = String(lineId).replace(/^l/i, '');
  const sched = getLineSchedule(lId, season);
  if (!sched || !sched.directions) return null;

  let minOriginSec = Infinity;
  let maxEndSec = -Infinity;

  for (const dk of Object.keys(sched.directions)) {
    const dir = sched.directions[dk];
    const trips = dir.dayTrips?.[dayType] || [];
    if (trips.length > 0) {
      for (const t of trips) {
        const s = t.s || [];
        let firstSec = null;
        let lastSec = null;
        for (let i = 0; i < s.length; i++) {
          if (s[i] !== null && Number.isFinite(s[i])) {
            if (firstSec === null) firstSec = s[i];
            lastSec = s[i];
          }
        }
        if (firstSec !== null && firstSec < minOriginSec) minOriginSec = firstSec;
        if (lastSec !== null && lastSec > maxEndSec) maxEndSec = lastSec;
      }
    } else {
      // Fallback to departures and median totalTravelSec
      const deps = dir.schedules?.[dayType] || [];
      const travelSec = dir.dayStopTravelSec?.[dayType]?.totalTravelSec || 1800;
      for (const clock of deps) {
        const sec = timeStringToSec(clock);
        if (sec < minOriginSec) minOriginSec = sec;
        const endSec = sec + travelSec;
        if (endSec > maxEndSec) maxEndSec = endSec;
      }
    }
  }

  if (!Number.isFinite(minOriginSec) || !Number.isFinite(maxEndSec)) {
    return null;
  }

  return {
    startSec: minOriginSec - 15 * 60,
    endSec: maxEndSec + 20 * 60
  };
}

/**
 * The seasonal grid currently in force, with the reason it was chosen.
 * @param {Date|number|string} [at=new Date()]
 */
function getActiveSeason(at) {
  return at === undefined
    ? { ...activeGrid().resolution, usingSeasonsFile: activeGrid().usingSeasonsFile }
    : { ...seasonCalendar.resolveSeason(at), usingSeasonsFile: Boolean(gridFor(at)) };
}

// `rawSchedules` used to be a plain object. It is a getter now so that anything
// still reading it sees the grid in force rather than whichever file happened to
// be on disk at require time.
Object.defineProperty(module.exports, 'rawSchedules', {
  enumerable: true,
  get: () => rawSchedules()
});
