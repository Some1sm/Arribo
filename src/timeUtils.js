/**
 * Universal Time & Timezone Utilities for Multi-Agency Transit Platforms
 * 
 * Supports transit networks in any IANA timezone (e.g. 'Europe/Madrid', 'Europe/London', 'America/New_York', 'Asia/Tokyo').
 * Handles wall-clock GTFS timetable conversions to universal UTC timestamps, daylight saving transitions,
 * and client-neutral countdown calculations.
 */

/**
 * Converts a HH:MM[:SS] time string to total seconds since midnight.
 */
function timeToSec(timeStr) {
  if (!timeStr) return 0;
  const parts = timeStr.split(':').map(Number);
  return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
}

/**
 * Converts seconds since midnight to HH:MM:SS string.
 */
function secToTime(totalSec) {
  const normalized = Math.max(0, totalSec);
  const h = Math.floor(normalized / 3600) % 24;
  const m = Math.floor((normalized % 3600) / 60);
  const s = Math.floor(normalized % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Gets wall-clock time breakdown in the specified agency timezone.
 * 
 * @param {string} timeZone - IANA timezone string (e.g., 'Europe/Madrid')
 * @param {Date|number} baseDate - Base date/timestamp (defaults to Date.now())
 */
function getNetworkTime(timeZone = 'Europe/Madrid', baseDate = new Date()) {
  const dateObj = typeof baseDate === 'number' ? new Date(baseDate) : baseDate;
  
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
  const month = parseInt(map.month, 10) - 1; // 0-indexed (0 = Jan)
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
    month,
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
 * Converts agency wall-clock date and time (e.g. 20260816, 21:30) into exact Universal UTC Date object.
 * 
 * @param {string|number} year - YYYY
 * @param {string|number} monthIndex - 0-11
 * @param {string|number} day - 1-31
 * @param {string|number} hour - 0-23
 * @param {string|number} minute - 0-59
 * @param {string|number} second - 0-59
 * @param {string} timeZone - Agency IANA timezone (e.g., 'Europe/Madrid')
 * @returns {Date}
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
 * Formats a given timestamp into the local time string of the agency or specified timezone.
 */
function formatTimeToTimezone(dateOrIso, timeZone = 'Europe/Madrid') {
  if (!dateOrIso) return '--:--';
  const d = typeof dateOrIso === 'string' ? new Date(dateOrIso) : dateOrIso;
  if (isNaN(d.getTime()) || d.getFullYear() < 2000) return '--:--';
  return d.toLocaleTimeString('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
}

module.exports = {
  timeToSec,
  secToTime,
  getNetworkTime,
  localTimeToUtcDate,
  formatTimeToTimezone
};
