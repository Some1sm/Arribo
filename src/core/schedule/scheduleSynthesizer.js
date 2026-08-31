/**
 * src/core/schedule/scheduleSynthesizer.js
 * 
 * Reusable Transit Schedule & Timetable Synthesis Engine
 * Provides cumulative stop travel time estimation, synthetic departure calculation,
 * headway timetable expansion, and overnight first-morning-service generation.
 */

const timeEngine = require('../time/timeEngine');
const geoEngine = require('../geo/geoEngine');
const delayEngine = require('./delayEngine');

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
 * Supports exact departure arrays (`scheduledDepartures: string[]` or `baseDepartureTimes: string[]`).
 * 
 * @param {Array<string|object>|object} baseDepartureTimes - e.g. ['06:00', '06:30'] or options object
 * @param {number|object} [stopTravelSec=0] - Cumulative seconds from route start
 * @param {object} [options={}]
 * @returns {Array<object>}
 */
function synthesizeDeparturesFromBaseTimes(baseDepartureTimes = [], stopTravelSec = 0, options = {}) {
  let times = baseDepartureTimes;
  let travelSec = stopTravelSec;
  let opts = options;

  if (!Array.isArray(baseDepartureTimes) && typeof baseDepartureTimes === 'object' && baseDepartureTimes !== null) {
    opts = baseDepartureTimes;
    times = opts.scheduledDepartures || opts.baseDepartureTimes || opts.baseDepartures || [];
    travelSec = opts.stopTravelSec || 0;
  } else if (Array.isArray(baseDepartureTimes) && typeof stopTravelSec === 'object' && stopTravelSec !== null) {
    opts = stopTravelSec;
    travelSec = opts.stopTravelSec || 0;
  } else if (typeof travelSec !== 'number') {
    travelSec = Number(travelSec) || 0;
  }

  const timezone = opts.timezone || 'Europe/Madrid';
  const targetDate = opts.targetDate ? new Date(opts.targetDate) : (opts.dateObj ? new Date(opts.dateObj) : new Date());
  const netNow = timeEngine.getNetworkTime(timezone, targetDate);
  const nowMs = targetDate.getTime();

  const minMinutesAway = opts.minMinutesAway !== undefined ? opts.minMinutesAway : -5;
  const maxMinutesAway = opts.maxMinutesAway !== undefined ? opts.maxMinutesAway : 240;
  const onlyUpcoming = opts.onlyUpcoming !== false;

  const departures = [];

  if (!Array.isArray(times)) {
    return departures;
  }

  for (const item of times) {
    const timeStr = typeof item === 'string' ? item : (item ? (item.dep || item.arr || item.departureTime || item.time || '') : '');
    if (!timeStr) continue;

    const baseSec = timeEngine.timeStringToSeconds(timeStr);
    const passSec = baseSec + travelSec;
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
      lineId: opts.lineId || 'line',
      lineCode: opts.lineCode || opts.lineId || 'BUS',
      lineName: opts.lineName || opts.lineCode || 'Bus',
      destination: opts.destination || 'Destinació',
      directionId: opts.directionId !== undefined ? String(opts.directionId) : '0',
      departureTime: passingTimeStr,
      time: passingTimeStr,
      departureDate: depIso,
      expectedIso: depIso,
      aimedIso: depIso,
      minutesAway: safeDiffMin,
      formattedStatus: safeDiffMin <= 0 ? 'Imminent' : (safeDiffMin === 1 ? '1 min' : `${safeDiffMin} min`),
      isRealTime: false,
      isRealtime: false,
      isEstimated: false,
      isTrain: Boolean(opts.isTrain),
      isToday: true,
      isFirstOfDay: false,
      isNextService: false,
      delayMinutes: 0,
      delayMins: 0,
      delayStatus: 'scheduled',
      delayBadgeText: 'Horari teòric',
      badgeText: 'Horari teòric',
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
 * @param {Array<string|object>|object} baseDepartureTimes - Tomorrow's initial timetable or options object
 * @param {number|object} [stopTravelSec=0] - Cumulative travel seconds from route origin
 * @param {object} [options={}]
 * @returns {Array<object>}
 */
function generateMorningFirstService(baseDepartureTimes = [], stopTravelSec = 0, options = {}) {
  let times = baseDepartureTimes;
  let travelSec = stopTravelSec;
  let opts = options;

  if (!Array.isArray(baseDepartureTimes) && typeof baseDepartureTimes === 'object' && baseDepartureTimes !== null) {
    opts = baseDepartureTimes;
    times = opts.scheduledDepartures || opts.baseDepartureTimes || opts.baseDeparturesTomorrow || opts.baseDepartures || [];
    travelSec = opts.stopTravelSec || 0;
  } else if (Array.isArray(baseDepartureTimes) && typeof stopTravelSec === 'object' && stopTravelSec !== null) {
    opts = stopTravelSec;
    travelSec = opts.stopTravelSec || 0;
  } else if (typeof travelSec !== 'number') {
    travelSec = Number(travelSec) || 0;
  }

  if (!Array.isArray(times) || times.length === 0) {
    return [];
  }

  const timezone = opts.timezone || 'Europe/Madrid';
  const now = opts.referenceDate ? new Date(opts.referenceDate) : (opts.dateObj ? new Date(opts.dateObj) : new Date());
  const dayOffset = opts.dayOffset !== undefined ? opts.dayOffset : 1;
  const targetDate = new Date(now.getTime() + dayOffset * 86400000);
  const netTomorrow = timeEngine.getNetworkTime(timezone, targetDate);

  const isTrain = Boolean(opts.isTrain);
  const badgeFirst = opts.badgeTextFirst || (isTrain ? '🌅 1r Tren del matí' : '🌅 1r Servei del matí');
  const badgeSubsequent = opts.badgeTextSubsequent || 'Programat';
  const maxCount = opts.maxCount || 10;

  const departures = [];
  const timesToUse = times.slice(0, maxCount);

  for (let idx = 0; idx < timesToUse.length; idx++) {
    const item = timesToUse[idx];
    const timeStr = typeof item === 'string' ? item : (item ? (item.dep || item.arr || item.departureTime || item.time || '') : '');
    if (!timeStr) continue;

    const baseSec = timeEngine.timeStringToSeconds(timeStr);
    const passSec = baseSec + travelSec;
    const passHour = Math.floor(passSec / 3600) % 24;
    const passMin = Math.floor((passSec % 3600) / 60);
    const passingTimeStr = `${String(passHour).padStart(2, '0')}:${String(passMin).padStart(2, '0')}`;

    const depUtcDate = timeEngine.localTimeToUtcDate(netTomorrow.year, netTomorrow.month, netTomorrow.day, passHour, passMin, 0, timezone);
    const diffMs = depUtcDate.getTime() - now.getTime();
    const diffMin = Math.max(1, Math.round(diffMs / 60000));
    const isFirst = (idx === 0);
    const depIso = depUtcDate.toISOString();
    const badge = isFirst ? badgeFirst : badgeSubsequent;

    departures.push({
      lineId: opts.lineId || 'line',
      lineCode: opts.lineCode || opts.lineId || 'BUS',
      lineName: opts.lineName || opts.lineCode || 'Bus',
      destination: opts.destination || 'Destinació',
      directionId: opts.directionId !== undefined ? String(opts.directionId) : '0',
      departureTime: passingTimeStr,
      time: passingTimeStr,
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
      delayBadgeText: badge,
      badgeText: badge,
      comparisonText: isFirst 
        ? `📅 Pas teòric previst demà a les ${passingTimeStr}` 
        : `📅 Horari teòric: ${passingTimeStr}`
    });
  }

  return departures;
}

/**
 * Compiles a unified stop departure schedule by merging live telemetry arrivals (SIRI/GPS/GTFS-RT)
 * with scheduled timetable departures for today, suppressing duplicates within +-3 minutes,
 * and appending next-morning first service departures when today's service is winding down.
 * 
 * @param {object} options
 * @param {Array<string|object>} [options.baseDeparturesToday] - Origin departures for today
 * @param {Array<string|object>} [options.baseDeparturesTomorrow] - Origin departures for tomorrow
 * @param {number} [options.stopTravelSec=0] - Cumulative seconds from route origin to stop
 * @param {Array<object>} [options.liveDepartures=[]] - Live real-time arrivals
 * @param {number} [options.limit=10] - Max total departures to return
 * @param {number} [options.minCountBeforeMorning=5] - Threshold below which tomorrow's morning trips are appended
 * @param {number} [options.maxMorningCount=10] - Max morning trips to append
 * @param {number} [options.duplicateWindowMinutes=3] - Window in minutes to suppress scheduled trips covered by live trips
 * @param {number} [options.serviceStartSec] - Optional start of service day in seconds
 * @param {number} [options.serviceEndSec] - Optional end of service day in seconds
 * @param {Date|string|number} [options.dateObj] - Reference date
 * @param {string} [options.timezone='Europe/Madrid'] - Agency timezone
 * @param {string} [options.lineId] - Line ID
 * @param {string} [options.lineCode] - Line Code
 * @param {string} [options.lineName] - Line Name
 * @param {string} [options.destination] - Destination name
 * @param {string|number} [options.directionId] - Direction ID
 * @param {boolean} [options.isTrain] - Whether mode is rail
 * @param {number} [options.minMinutesAway=-1] - Min minutes away for scheduled items (default -1)
 * @param {number} [options.maxMinutesAway=1440] - Max minutes away for scheduled items
 * @returns {Array<object>} Standardized departure list matching interface contract
 */
function compileStopDepartures(options = {}) {
  const timezone = options.timezone || 'Europe/Madrid';
  const targetDate = options.dateObj ? new Date(options.dateObj) :
    (options.targetDate ? new Date(options.targetDate) :
    (options.referenceDate ? new Date(options.referenceDate) : new Date()));
  const netNow = timeEngine.getNetworkTime(timezone, targetDate);
  const nowMs = targetDate.getTime();
  const nowMinOfDay = netNow.hour * 60 + netNow.minute;

  const stopTravelSec = Number(options.stopTravelSec) || 0;
  const limit = options.limit !== undefined ? Number(options.limit) : 10;
  const minCountBeforeMorning = options.minCountBeforeMorning !== undefined ? Number(options.minCountBeforeMorning) : Math.min(limit, 5);
  const maxMorningCount = options.maxMorningCount !== undefined ? Number(options.maxMorningCount) : 10;
  const duplicateWindowMinutes = options.duplicateWindowMinutes !== undefined ? Number(options.duplicateWindowMinutes) : 3;
  const minMinutesAway = options.minMinutesAway !== undefined ? Number(options.minMinutesAway) : -1;
  const maxMinutesAway = options.maxMinutesAway !== undefined ? Number(options.maxMinutesAway) : 1440;

  const baseToday = options.baseDeparturesToday || options.scheduledDeparturesToday || options.scheduledDepartures || options.baseDepartureTimes || [];
  const baseTomorrow = options.baseDeparturesTomorrow || options.scheduledDeparturesTomorrow || options.tomorrowDepartures || [];
  const rawLive = Array.isArray(options.liveDepartures) ? options.liveDepartures : [];

  // 1. Process and standardize live telemetry departures
  const liveDepartures = [];
  const liveMinutesOfDay = [];
  const liveAimedMinutesOfDay = [];

  for (const raw of rawLive) {
    if (!raw) continue;
    const std = delayEngine.standardizeDeparture(raw, options);
    std.isRealTime = true;
    std.isRealtime = true;
    std.isToday = true;
    std.time = std.departureTime;
    std.badgeText = std.delayBadgeText;

    let depMin = null;
    let aimedMin = null;

    if (std.departureTime && std.departureTime !== '--:--' && std.departureTime.includes(':')) {
      const [h, m] = std.departureTime.split(':').map(Number);
      if (!isNaN(h) && !isNaN(m)) {
        depMin = (h % 24) * 60 + (m % 60);
      }
    } else if (std.minutesAway !== undefined && !isNaN(Number(std.minutesAway))) {
      depMin = (nowMinOfDay + Math.round(Number(std.minutesAway))) % 1440;
    }

    if (std.aimedIso && !std.aimedIso.startsWith('0001-') && !std.aimedIso.startsWith('1970-')) {
      const d = new Date(std.aimedIso);
      if (!isNaN(d.getTime())) {
        const aimedNet = timeEngine.getNetworkTime(timezone, d);
        aimedMin = (aimedNet.hour * 60 + aimedNet.minute) % 1440;
      }
    } else if (std.scheduledTime && std.scheduledTime.includes(':')) {
      const [sh, sm] = std.scheduledTime.split(':').map(Number);
      if (!isNaN(sh) && !isNaN(sm)) {
        aimedMin = (sh % 24) * 60 + (sm % 60);
      }
    } else if (depMin !== null) {
      const delay = std.delayMins || 0;
      aimedMin = (depMin - delay + 1440) % 1440;
    }

    if (depMin !== null) {
      liveMinutesOfDay.push(depMin);
      liveAimedMinutesOfDay.push(aimedMin !== null ? aimedMin : depMin);
    }
    liveDepartures.push(std);
  }

  // Helper to check whether a scheduled trip is already operated by an active live bus
  function isDuplicateWithLive(scheduledMinOfDay) {
    for (let i = 0; i < liveMinutesOfDay.length; i++) {
      const liveMin = liveMinutesOfDay[i];
      const liveAimedMin = liveAimedMinutesOfDay[i];
      const liveDep = liveDepartures[i];

      // 1. If live departure has an explicit aimed/scheduled time or aimedIso
      if (liveDep && (liveDep.aimedIso || liveDep.scheduledTime)) {
        let diffAimed = Math.abs(liveAimedMin - scheduledMinOfDay);
        if (diffAimed > 720) diffAimed = 1440 - diffAimed;
        if (diffAimed <= 3) {
          return true;
        }
      }

      // 2. Proximity to live arrival time (within duplicateWindowMinutes)
      let diffLive = Math.abs(liveMin - scheduledMinOfDay);
      if (diffLive > 720) diffLive = 1440 - diffLive;
      if (diffLive <= duplicateWindowMinutes) {
        return true;
      }

      // 3. Delayed in-flight trip match if liveDep has delayMins
      const delay = liveDep?.delayMins || 0;
      if (delay !== 0 && liveDep && (liveDep.aimedIso || liveDep.scheduledTime)) {
        const expectedSchedMin = (liveMin - delay + 1440) % 1440;
        let diffDelayed = Math.abs(expectedSchedMin - scheduledMinOfDay);
        if (diffDelayed > 720) diffDelayed = 1440 - diffDelayed;
        if (diffDelayed <= 3) {
          return true;
        }
      }
    }
    return false;
  }

  // 2. Process today's scheduled departures
  const scheduledTodayDepartures = [];
  const seenTimes = new Set();

  if (Array.isArray(baseToday)) {
    for (const item of baseToday) {
      const timeStr = typeof item === 'string' ? item : (item ? (item.dep || item.arr || item.departureTime || item.time || '') : '');
      if (!timeStr || !timeStr.includes(':')) continue;

      const baseSec = timeEngine.timeStringToSeconds(timeStr);

      if (options.serviceStartSec !== undefined && baseSec < Number(options.serviceStartSec)) continue;
      if (options.serviceEndSec !== undefined && baseSec > Number(options.serviceEndSec)) continue;

      const passSec = baseSec + stopTravelSec;
      const passHour = Math.floor(passSec / 3600) % 24;
      const passMin = Math.floor((passSec % 3600) / 60);
      const passingTimeStr = `${String(passHour).padStart(2, '0')}:${String(passMin).padStart(2, '0')}`;
      const passingMinOfDay = passHour * 60 + passMin;

      const depUtcDate = timeEngine.localTimeToUtcDate(netNow.year, netNow.month, netNow.day, passHour, passMin, 0, timezone);
      const diffMs = depUtcDate.getTime() - nowMs;
      const diffMin = Math.round(diffMs / 60000);

      if (diffMin < minMinutesAway || diffMin > maxMinutesAway) {
        continue;
      }

      if (isDuplicateWithLive(passingMinOfDay)) {
        continue;
      }

      if (seenTimes.has(passingTimeStr)) {
        continue;
      }
      seenTimes.add(passingTimeStr);

      const safeDiffMin = Math.max(0, diffMin);
      const depIso = depUtcDate.toISOString();

      const schedDep = delayEngine.standardizeDeparture({
        lineId: options.lineId || 'line',
        lineCode: options.lineCode || options.lineId || 'BUS',
        lineName: options.lineName || options.lineCode || 'Bus',
        destination: options.destination || 'Destinació',
        directionId: options.directionId !== undefined ? String(options.directionId) : '0',
        departureTime: passingTimeStr,
        time: passingTimeStr,
        departureDate: depIso,
        expectedIso: depIso,
        aimedIso: depIso,
        minutesAway: safeDiffMin,
        formattedStatus: passingTimeStr,
        isRealTime: false,
        isRealtime: false,
        isEstimated: false,
        isTrain: Boolean(options.isTrain),
        isToday: true,
        isFirstOfDay: false,
        isNextService: false,
        delayMinutes: 0,
        delayMins: 0,
        delayStatus: 'scheduled',
        delayBadgeText: 'Horari teòric',
        badgeText: 'Horari teòric',
        comparisonText: `📅 Horari teòric: ${passingTimeStr}`
      }, options);

      scheduledTodayDepartures.push(schedDep);
    }
  }

  // 3. Merge today's live and scheduled departures
  const combinedToday = [...liveDepartures, ...scheduledTodayDepartures];
  combinedToday.sort((a, b) => (Number(a.minutesAway) || 0) - (Number(b.minutesAway) || 0));

  if (combinedToday.length > 0 && liveDepartures.length === 0) {
    combinedToday[0].isNextService = true;
  }

  // 4. Append tomorrow morning first service departures if below threshold
  const finalDepartures = [...combinedToday];

  if (finalDepartures.length < minCountBeforeMorning && Array.isArray(baseTomorrow) && baseTomorrow.length > 0) {
    const morningCountNeeded = Math.min(maxMorningCount, limit > 0 ? (limit - finalDepartures.length) : maxMorningCount);
    if (morningCountNeeded > 0) {
      const morningDepartures = generateMorningFirstService(baseTomorrow, stopTravelSec, {
        ...options,
        referenceDate: targetDate,
        maxCount: morningCountNeeded
      });

      if (finalDepartures.length === 0 && morningDepartures.length > 0) {
        morningDepartures[0].isNextService = true;
      }

      for (const md of morningDepartures) {
        if (limit > 0 && finalDepartures.length >= limit) break;
        finalDepartures.push(md);
      }
    }
  }

  if (limit > 0 && finalDepartures.length > limit) {
    return finalDepartures.slice(0, limit);
  }

  return finalDepartures;
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
  compileStopDepartures,
  estimateStopTravelTimes,
  getTravelTimeToStop,
  synthesizeDeparturesFromBaseTimes,
  synthesizeHeadwayDepartures,
  generateMorningFirstService,
  interpolateStopArrivals
};

