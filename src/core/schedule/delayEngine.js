/**
 * src/core/schedule/delayEngine.js
 * 
 * Canonical Transit Delay Evaluation & Status Standardization Engine
 * Formats canonical delay status, badge texts, comparison strings,
 * and maintains dual-compatibility fields (delayMinutes and delayMins).
 */

/**
 * Computes canonical delay evaluation for any transit arrival or departure.
 * 
 * @param {number|string|null} delayMinutes - Delay in minutes (+ late, - early)
 * @param {boolean} [isRealTime=false] - Whether arrival is derived from live telemetry
 * @param {object} [options={}] - Thresholds, scheduled times, contextual flags
 * @returns {{
 *   delayMinutes: number,
 *   delayMins: number,
 *   delayStatus: 'on_time' | 'delayed' | 'early' | 'scheduled' | 'passed' | 'estimated',
 *   delayBadgeText: string,
 *   delayFormatted: string,
 *   comparisonText: string
 * }} Standardized delay status structure
 */
function computeDelayStatus(delayMinutes, isRealTime = false, options = {}) {
  const rawDelay = delayMinutes !== undefined && delayMinutes !== null ? Number(delayMinutes) : 0;
  const delay = isNaN(rawDelay) ? 0 : Math.round(rawDelay);

  const thresholdDelay = options.thresholdDelayMinutes !== undefined ? options.thresholdDelayMinutes : 2;
  const thresholdEarly = options.thresholdEarlyMinutes !== undefined ? options.thresholdEarlyMinutes : -2;
  const scheduledTime = options.scheduledTime || null;
  const realtimeTime = options.realtimeTime || null;
  const punctualStyle = options.punctualStyle || 'short';
  const punctualText = punctualStyle === 'long' ? "A l'hora (Puntual)" : 'Puntual';

  // 0. Bus is regulating / laying over at terminal
  if (options.isRegulating || options.isTerminalLayover || options.delayStatus === 'regulating') {
    return {
      delayMinutes: delay,
      delayMins: delay,
      delayStatus: 'regulating',
      delayBadgeText: options.delayBadgeText || '⏱️ Regulació',
      delayFormatted: 'Regulant a capçalera',
      comparisonText: scheduledTime ? `Regulant a capçalera (Sortida: ${scheduledTime})` : 'Regulant a capçalera'
    };
  }

  // 1. Bus / Train has physically passed this stop
  if (options.isPassed) {
    return {
      delayMinutes: 0,
      delayMins: 0,
      delayStatus: 'passed',
      delayBadgeText: 'Passat ✓',
      delayFormatted: 'Passat ✓',
      comparisonText: scheduledTime ? `Horari teòric: ${scheduledTime}` : 'Passat ✓'
    };
  }

  // 2. Scheduled timetable / overnight next-service / dead-reckoning estimate without GPS
  if (!isRealTime) {
    if (options.isFirstOfDay || options.isNextService) {
      const badge = options.isTrain ? '🌅 1r Tren del matí' : '🌅 1r Servei del matí';
      return {
        delayMinutes: 0,
        delayMins: 0,
        delayStatus: 'scheduled',
        delayBadgeText: badge,
        delayFormatted: badge,
        comparisonText: scheduledTime 
          ? `📅 Pas teòric previst demà a les ${scheduledTime}` 
          : badge
      };
    }

    if (options.isEstimated) {
      return {
        delayMinutes: delay,
        delayMins: delay,
        delayStatus: 'estimated',
        delayBadgeText: options.badgeText || '⚡ En ruta',
        delayFormatted: delay > 0 ? `+${delay} min retard` : punctualText,
        comparisonText: scheduledTime 
          ? `Teòric: ${scheduledTime} (${delay > 0 ? `+${delay} min retard` : punctualText})` 
          : '⚡ Estimació en ruta'
      };
    }

    return {
      delayMinutes: 0,
      delayMins: 0,
      delayStatus: 'scheduled',
      delayBadgeText: 'Horari teòric',
      delayFormatted: 'Horari teòric',
      comparisonText: scheduledTime ? `Horari teòric: ${scheduledTime}` : 'Horari teòric'
    };
  }

  // 3. Live Real-Time Telemetry
  let delayStatus = 'on_time';
  let delayBadgeText = punctualText;
  let delayFormatted = 'Puntual';

  if (delay >= thresholdDelay) {
    delayStatus = 'delayed';
    delayBadgeText = `+${delay} min retard`;
    delayFormatted = `+${delay} min retard`;
  } else if (delay <= thresholdEarly) {
    delayStatus = 'early';
    delayBadgeText = `${Math.abs(delay)} min avançat`;
    delayFormatted = `${Math.abs(delay)} min avançat`;
  }

  let comparisonText = '';
  if (scheduledTime) {
    comparisonText = `Teòric: ${scheduledTime} (${delayBadgeText})`;
  } else if (options.agency && realtimeTime) {
    comparisonText = `Temps real ${options.agency} (${realtimeTime})`;
  } else if (realtimeTime) {
    comparisonText = `Temps real (${realtimeTime})`;
  } else {
    comparisonText = `Temps real (${delayBadgeText})`;
  }

  return {
    delayMinutes: delay,
    delayMins: delay,
    delayStatus,
    delayBadgeText,
    delayFormatted,
    comparisonText
  };
}

/**
 * Matches a real-time observation time against a set of scheduled trip times.
 * Handles circular midnight wrap-around (e.g. 23:55 vs 00:05).
 * 
 * @param {string} realtimeTimeStr - 'HH:MM'
 * @param {Array<string|object>} [scheduledItems=[]] - List of times or trip objects
 * @param {number} [maxDiffMinutes=55] - Maximum matching threshold
 * @returns {{
 *   matched: boolean,
 *   scheduledTime: string,
 *   delayMinutes: number,
 *   diff: number,
 *   bestTrip: any
 * }}
 */
function findClosestScheduledTime(realtimeTimeStr, scheduledItems = [], maxDiffMinutes = 55) {
  if (!realtimeTimeStr || !Array.isArray(scheduledItems) || scheduledItems.length === 0) {
    return {
      matched: false,
      scheduledTime: realtimeTimeStr || '--:--',
      delayMinutes: 0,
      diff: Infinity,
      bestTrip: null
    };
  }

  const [rH, rM] = realtimeTimeStr.split(':').map(Number);
  const liveMin = (rH || 0) * 60 + (rM || 0);

  let bestTrip = null;
  let bestSchedTime = realtimeTimeStr;
  let minDiff = Infinity;
  let delayMinutes = 0;

  for (const item of scheduledItems) {
    let schedStr = '';
    let tripRef = null;

    if (typeof item === 'string') {
      schedStr = item.substring(0, 5);
    } else if (item && typeof item === 'object') {
      schedStr = (item.dep || item.arr || item.departureTime || item.time || '').substring(0, 5);
      tripRef = item;
    }

    if (!schedStr || schedStr === '--:--') continue;

    const [sH, sM] = schedStr.split(':').map(Number);
    const schedMin = (sH || 0) * 60 + (sM || 0);

    let rawDiff = liveMin - schedMin;
    // Circular midnight wrap-around adjustment
    if (rawDiff > 720) rawDiff -= 1440;
    if (rawDiff < -720) rawDiff += 1440;

    const absDiff = Math.abs(rawDiff);
    if (absDiff < minDiff && absDiff <= maxDiffMinutes) {
      minDiff = absDiff;
      bestSchedTime = schedStr;
      delayMinutes = rawDiff;
      bestTrip = tripRef;
    }
  }

  const matched = minDiff <= maxDiffMinutes;
  return {
    matched,
    scheduledTime: matched ? bestSchedTime : realtimeTimeStr,
    delayMinutes: matched ? delayMinutes : 0,
    diff: minDiff,
    bestTrip
  };
}

/**
 * Formats a user-facing countdown badge string from minutes away.
 * 
 * @param {number|null|undefined} minutesAway 
 * @returns {string} e.g. 'Imminent', '1 min', '14 min', '--:--'
 */
function formatCountdownStatus(minutesAway) {
  if (minutesAway === null || minutesAway === undefined || isNaN(Number(minutesAway))) {
    return '--:--';
  }
  const mins = Number(minutesAway);
  if (mins <= 0) return 'Imminent';
  if (mins === 1) return '1 min';
  return `${mins} min`;
}

/**
 * Standardizes any departure object to guarantee 100% contract compliance
 * with dual-compatibility fields across all frontend consumers.
 * 
 * @param {object} [dep={}] - Raw departure object from any tracker
 * @param {object} [defaults={}] - Optional fallback properties
 * @returns {object} Fully compliant Departure schema
 */
function standardizeDeparture(dep = {}, defaults = {}) {
  const d = dep || {};
  const def = defaults || {};
  const isRealTime = Boolean(d.isRealTime !== undefined ? d.isRealTime : d.isRealtime);
  const rawDelay = d.delayMinutes !== undefined ? d.delayMinutes : (d.delayMins !== undefined ? d.delayMins : 0);
  
  const isRegulating = Boolean(d.isRegulating || d.isTerminalLayover || d.delayStatus === 'regulating');
  const delayEval = computeDelayStatus(rawDelay, isRealTime, {
    scheduledTime: d.scheduledTime || d.departureTime,
    realtimeTime: d.departureTime,
    isFirstOfDay: Boolean(d.isFirstOfDay),
    isNextService: Boolean(d.isNextService),
    isPassed: Boolean(d.isPassed),
    isEstimated: Boolean(d.isEstimated),
    isRegulating,
    isTrain: Boolean(d.isTrain),
    delayBadgeText: d.delayBadgeText,
    punctualStyle: 'short'
  });

  const minutesAway = d.minutesAway !== undefined ? Number(d.minutesAway) : 0;
  const formattedStatus = d.formattedStatus || (isRegulating ? 'En regulació' : formatCountdownStatus(minutesAway));

  return {
    lineId: String(d.lineId || def.lineId || 'line'),
    lineCode: String(d.lineCode || d.lineName || def.lineCode || 'BUS'),
    lineName: String(d.lineName || d.lineCode || def.lineName || 'Bus'),
    destination: String(d.destination || def.destination || 'Destinació'),
    directionId: String(d.directionId !== undefined ? d.directionId : (def.directionId || '0')),
    departureTime: String(d.departureTime || '--:--'),
    departureDate: d.departureDate || d.expectedIso || new Date().toISOString(),
    expectedIso: d.expectedIso || d.departureDate || new Date().toISOString(),
    aimedIso: d.aimedIso || d.expectedIso || d.departureDate || new Date().toISOString(),
    minutesAway,
    formattedStatus,
    isRealTime,
    isRealtime: isRealTime, // Dual-cased compatibility
    isEstimated: Boolean(d.isEstimated),
    isTrain: Boolean(d.isTrain),
    isToday: d.isToday !== undefined ? Boolean(d.isToday) : true,
    isFirstOfDay: Boolean(d.isFirstOfDay),
    isNextService: Boolean(d.isNextService),
    delayMinutes: delayEval.delayMinutes,
    delayMins: delayEval.delayMins,       // Dual-named compatibility
    delayStatus: delayEval.delayStatus,
    delayBadgeText: d.delayBadgeText || delayEval.delayBadgeText,
    delayFormatted: delayEval.delayFormatted,
    comparisonText: (d.arrivalTime && d.departureTime && d.arrivalTime !== d.departureTime) 
      ? `Arribada: ${d.arrivalTime} • Sortida: ${d.departureTime}` 
      : (d.comparisonText || delayEval.comparisonText),
    arrivalTime: d.arrivalTime || null,
    isRegulating,
    vehicleId: d.vehicleId || null,
    busCoords: d.busCoords || null
  };
}

module.exports = {
  computeDelayStatus,
  findClosestScheduledTime,
  formatCountdownStatus,
  standardizeDeparture
};
