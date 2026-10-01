/**
 * src/core/time/calendarEngine.js
 * 
 * Core Calendar Engine
 * Day-type detection, GTFS calendar validity, exception matching, and seasonal descriptors.
 */


// Intl.DateTimeFormat construction is expensive; reuse one per timezone.
const COMPONENT_FORMATTERS = new Map();
function componentFormatter(timeZone) {
  let formatter = COMPONENT_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    COMPONENT_FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Returns structured calendar components for a given date in agency timezone.
 * 
 * @param {Date|string|number} [dateObj=new Date()]
 * @param {string} [timeZone='Europe/Madrid']
 * @returns {{
 *   dateStr: string,
 *   mmdd: string,
 *   year: number,
 *   month: number,
 *   monthIndex: number,
 *   day: number,
 *   dayOfWeek: number,
 *   hour: number,
 *   minute: number,
 *   second: number,
 *   timeStr: string,
 *   isWeekend: boolean,
 *   isSunday: boolean,
 *   isSaturday: boolean,
 *   isWeekday: boolean,
 *   isAugust: boolean
 * }}
 */
function getDateComponents(dateObj = new Date(), timeZone = 'Europe/Madrid') {
  const d = (dateObj instanceof Date && !isNaN(dateObj.getTime()))
    ? dateObj
    : (typeof dateObj === 'string' || typeof dateObj === 'number' ? new Date(dateObj) : new Date());

  const validDate = isNaN(d.getTime()) ? new Date() : d;

  const formatter = componentFormatter(timeZone);

  const parts = formatter.formatToParts(validDate);
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
    month,                 // 1-indexed (1-12)
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
 * Checks calendar_dates exceptions first, then legacy seasonal service IDs,
 * then regular weekly calendar range and day-of-week flags.
 * 
 * @param {string} serviceId
 * @param {Map|Array|Object|null} [calendar=null]
 * @param {Map|Object|null} [calendarExceptions=null]
 * @param {Date|string|number} [dateObj=new Date()]
 * @param {string} [timeZone='Europe/Madrid']
 * @returns {boolean}
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
      calEntry = calendar.find(c => c && (c.serviceId === serviceId || c.service_id === serviceId));
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
 * Calendar-only service-day descriptor: the day of the week, nothing more.
 *
 * Holidays and the summer season are not known here (holidayCalendar depends
 * on this module), so the Mataró tracker overrides getServiceCalendarInfo with
 * the holiday- and season-aware version. This used to return the retired C-10
 * line's service ids and frequencies ("cada 45 / 90 / 120 minuts"), which were
 * never true for Mataró Bus Urbà.
 *
 * @param {Date|string|number} [dateObj=new Date()]
 * @param {string} [timeZone='Europe/Madrid']
 * @returns {{serviceId:string, dayType:string, name:string, isWeekend:boolean, calendarTag:string, dateFormatted:string}}
 */
function getServiceCalendarInfo(dateObj = new Date(), timeZone = 'Europe/Madrid') {
  const { isSaturday, isSunday, isWeekend, year, month, day } = getDateComponents(dateObj, timeZone);
  const dayType = isSunday ? 'sunday' : (isSaturday ? 'saturday' : 'weekday');
  const name = isSunday ? 'Diumenge' : (isSaturday ? 'Dissabte' : 'Feiner');
  return {
    serviceId: dayType,
    dayType,
    name,
    isWeekend,
    calendarTag: name,
    dateFormatted: `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`
  };
}

module.exports = {
  getDateComponents,
  isServiceActiveOnDate,
  getServiceCalendarInfo
};
