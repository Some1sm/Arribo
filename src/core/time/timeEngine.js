/**
 * src/core/time/timeEngine.js
 * 
 * Core Time Engine
 * Universal time, timezone, and format utilities for multi-agency transit.
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
 * 
 * @param {string} [timeZone='Europe/Madrid']
 * @param {Date|number|string} [baseDate=new Date()]
 */
function getNetworkTime(timeZone = 'Europe/Madrid', baseDate = new Date()) {
  const dateObj = (baseDate instanceof Date && !isNaN(baseDate.getTime()))
    ? baseDate
    : (typeof baseDate === 'number' || typeof baseDate === 'string' ? new Date(baseDate) : new Date());

  const validDate = isNaN(dateObj.getTime()) ? new Date() : dateObj;

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

  const parts = formatter.formatToParts(validDate);
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

  const weekdayName = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(validDate);
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dayOfWeek = dayMap[weekdayName] !== undefined ? dayMap[weekdayName] : validDate.getDay();

  return {
    rawDate: validDate,
    timeZone,
    year,
    month,             // 0-indexed (0 = Jan)
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
 * 
 * @param {string|number} year
 * @param {string|number} monthIndex - 0-11
 * @param {string|number} day - 1-31
 * @param {string|number} hour - 0-23
 * @param {string|number} minute - 0-59
 * @param {string|number} [second=0] - 0-59
 * @param {string} [timeZone='Europe/Madrid']
 * @returns {Date}
 */
function localTimeToUtcDate(year, monthIndex, day, hour, minute, second = 0, timeZone = 'Europe/Madrid') {
  const y = parseInt(year, 10);
  const mon = parseInt(monthIndex, 10);
  const d = parseInt(day, 10);
  const h = parseInt(hour, 10);
  const min = parseInt(minute, 10);
  const s = parseInt(second, 10);

  const targetLocalUtc = Date.UTC(y, mon, d, h, min, s);

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

  let guess = targetLocalUtc;
  for (let i = 0; i < 5; i++) {
    const parts = invFormatter.formatToParts(new Date(guess));
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

    const diff = invUtc - targetLocalUtc;
    if (diff === 0) break;
    guess -= diff;
  }

  return new Date(guess);
}

/**
 * Formats a given timestamp into the local time string (HH:MM).
 * Strictly guards against null, invalid-date, epoch (1970), and placeholder dates (0001) returning '--:--'.
 * 
 * @param {string|Date|number|null} dateOrIso
 * @param {string} [timeZone='Europe/Madrid']
 * @returns {string} HH:MM or '--:--'
 */
function formatTimeToTimezone(dateOrIso, timeZone = 'Europe/Madrid') {
  if (!dateOrIso) return '--:--';
  const d = (dateOrIso instanceof Date) ? dateOrIso : new Date(dateOrIso);
  if (isNaN(d.getTime()) || d.getUTCFullYear() < 2000) return '--:--';
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
