/**
 * src/core/schedule/scheduleSynthesizer.js
 * 
 * Reusable Transit Schedule & Timetable Synthesis Engine
 * Provides cumulative stop travel time estimation, synthetic departure calculation,
 * headway timetable expansion, and overnight first-morning-service generation.
 */

const timeEngine = require('../time/timeEngine');
const geoEngine = require('../geo/geoEngine');

/**
 * Estimates cumulative travel distance and duration along a sequence of stops.
 * 
 * @param {Array<object>} stops - Ordered list of stops
 * @param {object} [options={}] - Speed, dwell time, and polyline options
 * @returns {Array<{
 *   stopId: string,
 *   stopIndex: number,
 *   seq: number,
 *   name: string,
 *   segmentMeters: number,
 *   cumulativeMeters: number,
 *   dwellSec: number,
 *   travelSec: number,
 *   travelMinutes: number
 * }>}
 */
function estimateStopTravelTimes(stops = [], options = {}) {
  if (!Array.isArray(stops) || stops.length === 0) {
    return [];
  }

  const speedMps = options.speedMps || 
    (options.speedKmh ? Number(options.speedKmh) / 3.6 : 
    (options.avgSpeedKmh ? Number(options.avgSpeedKmh) / 3.6 : 8.0));
  const dwellSecPerStop = options.dwellSecPerStop !== undefined ? Number(options.dwellSecPerStop) : 25;
  const defaultSegmentMeters = Number(options.defaultSegmentMeters) || 400;

  const results = [];
  let cumulativeMeters = 0;

  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    const stopId = String(s.id ?? s.stopId ?? s.code ?? i);
    const name = s.name || `Parada ${stopId}`;
    const seq = s.seq !== undefined ? Number(s.seq) : i;

    let segmentMeters = 0;

    if (i > 0) {
      const prev = stops[i - 1];
      const lat0 = Number(prev.lat ?? prev.latitude);
      const lon0 = Number(prev.lon ?? prev.longitude);
      const lat1 = Number(s.lat ?? s.latitude);
      const lon1 = Number(s.lon ?? s.longitude);

      if (!isNaN(lat0) && !isNaN(lon0) && !isNaN(lat1) && !isNaN(lon1) && lat0 !== 0 && lat1 !== 0) {
        segmentMeters = geoEngine.calculateDistanceMeters(lat0, lon0, lat1, lon1);
      } else {
        segmentMeters = defaultSegmentMeters;
      }
    }

    cumulativeMeters += segmentMeters;
    const dwellSec = i * dwellSecPerStop;
    const travelSec = i === 0 ? 0 : Math.round((cumulativeMeters / speedMps) + dwellSec);
    const travelMinutes = Math.round(travelSec / 60);

    results.push({
      stopId,
      stopIndex: i,
      seq,
      name,
      segmentMeters: Math.round(segmentMeters),
      cumulativeMeters: Math.round(cumulativeMeters),
      dwellSec,
      travelSec,
      travelMinutes
    });
  }

  return results;
}

/**
 * Finds travel time from route origin to a target stop identifier.
 * 
 * @param {Array<object>} stopTravelTimes 
 * @param {string|number} stopIdentifier - stopId, code, seq, or stopIndex
 * @returns {number} Travel time in seconds
 */
function getTravelTimeToStop(stopTravelTimes = [], stopIdentifier) {
  if (!Array.isArray(stopTravelTimes) || stopTravelTimes.length === 0) return 0;
  const idStr = String(stopIdentifier);
  const match = stopTravelTimes.find(st => 
    String(st.stopId) === idStr || 
    String(st.seq) === idStr || 
    String(st.stopIndex) === idStr
  );
  return match ? match.travelSec : 0;
}

/**
 * Synthesizes departures at a stop from base route departure times.
 * 
 * @param {Array<string|object>} baseDepartureTimes - e.g. ['06:00', '06:30']
 * @param {number} [stopTravelSec=0] - Cumulative seconds from route start
 * @param {object} [options={}]
 * @returns {Array<object>}
 */
function synthesizeDeparturesFromBaseTimes(baseDepartureTimes = [], stopTravelSec = 0, options = {}) {
  const timezone = options.timezone || 'Europe/Madrid';
  const targetDate = options.targetDate ? new Date(options.targetDate) : new Date();
  const netNow = timeEngine.getNetworkTime(timezone, targetDate);
  const nowMs = targetDate.getTime();

  const minMinutesAway = options.minMinutesAway !== undefined ? options.minMinutesAway : -5;
  const maxMinutesAway = options.maxMinutesAway !== undefined ? options.maxMinutesAway : 240;
  const onlyUpcoming = options.onlyUpcoming !== false;

  const departures = [];

  for (const item of baseDepartureTimes) {
    const timeStr = typeof item === 'string' ? item : (item ? (item.dep || item.arr || item.time || '') : '');
    if (!timeStr) continue;

    const baseSec = timeEngine.timeStringToSeconds(timeStr);
    const passSec = baseSec + stopTravelSec;
    const passHour = Math.floor(passSec / 3600) % 24;
    const passMin = Math.floor((passSec % 3600) / 60);
    const passingTimeStr = `${String(passHour).padStart(2, '0')}:${String(passMin).padStart(2, '0')}`;

    const depUtcDate = timeEngine.localTimeToUtcDate(netNow.year, netNow.month, netNow.day, passHour, passMin, 0, timezone);
    const diffMs = depUtcDate.getTime() - nowMs;
    const diffMin = Math.round(diffMs / 60000);

    if (onlyUpcoming && (diffMin < minMinutesAway || diffMin > maxMinutesAway)) {
      continue;
    }

    const safeDiffMin = Math.max(0, diffMin);
    const depIso = depUtcDate.toISOString();

    departures.push({
      lineId: options.lineId || 'line',
      lineCode: options.lineCode || options.lineId || 'BUS',
      lineName: options.lineName || options.lineCode || 'Bus',
      destination: options.destination || 'Destinació',
      directionId: options.directionId !== undefined ? String(options.directionId) : '0',
      departureTime: passingTimeStr,
      departureDate: depIso,
      expectedIso: depIso,
      aimedIso: depIso,
      minutesAway: safeDiffMin,
      formattedStatus: safeDiffMin <= 0 ? 'Imminent' : (safeDiffMin === 1 ? '1 min' : `${safeDiffMin} min`),
      isRealTime: false,
      isRealtime: false,
      isEstimated: false,
      isToday: true,
      isFirstOfDay: false,
      isNextService: false,
      delayMinutes: 0,
      delayMins: 0,
      delayStatus: 'scheduled',
      delayBadgeText: 'Horari teòric',
      comparisonText: `Horari teòric: ${passingTimeStr}`
    });
  }

  return departures.sort((a, b) => a.minutesAway - b.minutesAway);
}

/**
 * Generates synthetic departures for frequency-based / headway service spans.
 * 
 * @param {object} [config={}] - { startTime, endTime, headwayMinutes, stopTravelSec, ...options }
 * @returns {Array<object>}
 */
function synthesizeHeadwayDepartures(config = {}) {
  const startSec = timeEngine.timeStringToSeconds(config.startTime || '06:00');
  const endSec = timeEngine.timeStringToSeconds(config.endTime || '22:00');
  const headwaySec = (config.headwayMinutes || 15) * 60;
  const stopTravelSec = config.stopTravelSec || 0;

  const baseTimes = [];
  for (let s = startSec; s <= endSec; s += headwaySec) {
    const h = Math.floor(s / 3600) % 24;
    const m = Math.floor((s % 3600) / 60);
    baseTimes.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }

  return synthesizeDeparturesFromBaseTimes(baseTimes, stopTravelSec, config);
}

/**
 * Generates next-day first morning departures during overnight off-peak periods.
 * 
 * @param {Array<string|object>} baseDepartureTimes - Tomorrow's initial timetable
 * @param {number} [stopTravelSec=0] - Cumulative travel seconds from route origin
 * @param {object} [options={}]
 * @returns {Array<object>}
 */
function generateMorningFirstService(baseDepartureTimes = [], stopTravelSec = 0, options = {}) {
  if (!Array.isArray(baseDepartureTimes) || baseDepartureTimes.length === 0) {
    return [];
  }

  const timezone = options.timezone || 'Europe/Madrid';
  const now = options.referenceDate ? new Date(options.referenceDate) : new Date();
  const dayOffset = options.dayOffset !== undefined ? options.dayOffset : 1;
  const targetDate = new Date(now.getTime() + dayOffset * 86400000);
  const netTomorrow = timeEngine.getNetworkTime(timezone, targetDate);

  const isTrain = Boolean(options.isTrain);
  const badgeFirst = options.badgeTextFirst || (isTrain ? '🌅 1r Tren del matí' : '🌅 1r Servei del matí');
  const badgeSubsequent = options.badgeTextSubsequent || 'Programat';
  const maxCount = options.maxCount || 10;

  const departures = [];
  const timesToUse = baseDepartureTimes.slice(0, maxCount);

  for (let idx = 0; idx < timesToUse.length; idx++) {
    const item = timesToUse[idx];
    const timeStr = typeof item === 'string' ? item : (item ? (item.dep || item.arr || item.time || '') : '');
    if (!timeStr) continue;

    const baseSec = timeEngine.timeStringToSeconds(timeStr);
    const passSec = baseSec + stopTravelSec;
    const passHour = Math.floor(passSec / 3600) % 24;
    const passMin = Math.floor((passSec % 3600) / 60);
    const passingTimeStr = `${String(passHour).padStart(2, '0')}:${String(passMin).padStart(2, '0')}`;

    const depUtcDate = timeEngine.localTimeToUtcDate(netTomorrow.year, netTomorrow.month, netTomorrow.day, passHour, passMin, 0, timezone);
    const diffMs = depUtcDate.getTime() - now.getTime();
    const diffMin = Math.max(1, Math.round(diffMs / 60000));
    const isFirst = (idx === 0);
    const depIso = depUtcDate.toISOString();

    departures.push({
      lineId: options.lineId || 'line',
      lineCode: options.lineCode || options.lineId || 'BUS',
      lineName: options.lineName || options.lineCode || 'Bus',
      destination: options.destination || 'Destinació',
      directionId: options.directionId !== undefined ? String(options.directionId) : '0',
      departureTime: passingTimeStr,
      departureDate: depIso,
      expectedIso: depIso,
      aimedIso: depIso,
      minutesAway: diffMin,
      formattedStatus: passingTimeStr,
      isRealTime: false,
      isRealtime: false,
      isEstimated: false,
      isTrain,
      isToday: false,
      isFirstOfDay: isFirst,
      isNextService: isFirst,
      delayMinutes: 0,
      delayMins: 0,
      delayStatus: 'scheduled',
      delayBadgeText: isFirst ? badgeFirst : badgeSubsequent,
      comparisonText: isFirst 
        ? `📅 Pas teòric previst demà a les ${passingTimeStr}` 
        : `📅 Horari teòric: ${passingTimeStr}`
    });
  }

  return departures;
}

/**
 * Interpolates trip passing times across all stops in a route sequence.
 * 
 * @param {number} baseTripDepartureSec - Departure seconds at stop 0
 * @param {Array<object>} stopTravelTimes - From estimateStopTravelTimes
 * @param {Date|string|number} [dateObj=new Date()] - Reference date
 * @param {object} [options={}]
 * @returns {Array<object>}
 */
function interpolateStopArrivals(baseTripDepartureSec, stopTravelTimes = [], dateObj = new Date(), options = {}) {
  const timezone = options.timezone || 'Europe/Madrid';
  const netDate = timeEngine.getNetworkTime(timezone, dateObj);

  return stopTravelTimes.map(st => {
    const arrSec = baseTripDepartureSec + st.travelSec;
    const hour = Math.floor(arrSec / 3600) % 24;
    const min = Math.floor((arrSec % 3600) / 60);
    const sec = Math.floor(arrSec % 60);
    const timeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    const utcDate = timeEngine.localTimeToUtcDate(netDate.year, netDate.month, netDate.day, hour, min, sec, timezone);

    return {
      stopId: st.stopId,
      seq: st.seq,
      name: st.name,
      arrivalSec: arrSec,
      departureTime: timeStr,
      expectedIso: utcDate.toISOString(),
      travelSec: st.travelSec,
      cumulativeMeters: st.cumulativeMeters
    };
  });
}

module.exports = {
  estimateStopTravelTimes,
  getTravelTimeToStop,
  synthesizeDeparturesFromBaseTimes,
  synthesizeHeadwayDepartures,
  generateMorningFirstService,
  interpolateStopArrivals
};
