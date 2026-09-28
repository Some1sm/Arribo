/**
 * src/core/time/holidayCalendar.js
 *
 * Catalan / Mataró public holidays.
 *
 * Mataró Bus Urbà runs the reduced "Diumenges i Festius" timetable on public
 * holidays, not the full weekday one. Without this, an Easter Monday or a
 * Sant Joan observation is matched against a weekday timetable with roughly
 * half the headway, and the matcher returns a confident wrong time because the
 * residual still lands inside its tolerance.
 *
 * Scope: Catalonia regional + national holidays + Mataró local holidays.
 * Verified dates for covered years are loaded from src/data/holidays.json.
 * Unmodelled years fall back to anonymous Gregorian computus + fixed dates,
 * reporting isHolidayKnown() === false.
 *
 * All date work is Europe/Madrid wall-clock and calendar-date based; no
 * host-local getDay(), safe across midnight and DST.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const calendarEngine = require('./calendarEngine');

let holidaysData = null;
try {
  const jsonPath = path.join(__dirname, '..', '..', 'data', 'holidays.json');
  if (fs.existsSync(jsonPath)) {
    holidaysData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  }
} catch (e) {
  console.warn('[HolidayCalendar] Could not load holidays.json:', e.message);
}

/** Anonymous Gregorian computus. Returns {month, day} 1-based for Easter Sunday. */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function shift({ month, day }, days) {
  const ms = Date.UTC(2000, month - 1, day) + days * 86400000;
  const d = new Date(ms);
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function ymd(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Fallback fixed-date national + Catalan holidays, plus the Easter-derived ones. */
function fallbackHolidayDatesForYear(year) {
  const easter = easterSunday(year);
  const easterMonday = shift(easter, 1);
  const goodFriday = shift(easter, -2);
  const dates = new Set([
    // Fixed national
    ymd(year, 1, 1),    // Any nou
    ymd(year, 1, 6),    // Reis
    ymd(year, 5, 1),    // Dia del treball
    ymd(year, 8, 15),   // Assumpció
    ymd(year, 10, 12),  // Mare de Déu del Pilar
    ymd(year, 11, 1),   // Tots Sants
    ymd(year, 12, 6),   // Dia de la Constitució
    ymd(year, 12, 8),   // La Immaculada
    ymd(year, 12, 25),  // Nadal
    ymd(year, 12, 26),  // Sant Esteve
    // Catalan (Diada Nacional)
    ymd(year, 9, 11),   // Diada Nacional de Catalunya
    ymd(year, 6, 24),   // Sant Joan
    // Easter-derived
    ymd(year, goodFriday.month, goodFriday.day),    // Divendres Sant
    ymd(year, easter.month, easter.day),            // Pasqua
    ymd(year, easterMonday.month, easterMonday.day) // Dilluns de Pasqua
  ]);
  return dates;
}

const cache = new Map();

function holidaysForYear(year) {
  if (cache.has(year)) return cache.get(year);

  const yearStr = String(year);
  const yearData = holidaysData?.years?.[yearStr];
  if (yearData) {
    const dates = new Set();
    (yearData.regional || []).forEach(h => dates.add(h.date));
    (yearData.local || []).forEach(h => dates.add(h.date));
    cache.set(year, dates);
    return dates;
  }

  const fallback = fallbackHolidayDatesForYear(year);
  cache.set(year, fallback);
  return fallback;
}

/**
 * How completely the holidays of a year are known from src/data/holidays.json.
 * @param {Date|number|string} [at=new Date()]
 * @returns {{year:number, regionalKnown:boolean, localKnown:boolean, known:boolean, warning:string|null}}
 */
function getHolidayCoverage(at = new Date()) {
  const c = calendarEngine.getDateComponents(at, 'Europe/Madrid');
  if (!c) return { year: null, regionalKnown: false, localKnown: false, known: false, warning: null };
  const status = (year) => {
    const y = holidaysData?.years?.[String(year)];
    const regionalKnown = Array.isArray(y?.regional) && y.regional.length === 12;
    const localKnown = Array.isArray(y?.local) && y.local.length === 2;
    return { regionalKnown, localKnown, known: regionalKnown && localKnown };
  };
  const cur = status(c.year);
  let warning = null;
  if (!cur.regionalKnown) warning = `Festius oficials ${c.year} no configurats`;
  else if (!cur.localKnown) warning = `Festius locals de Mataró ${c.year} no configurats`;
  else if (c.month >= 11 && !status(c.year + 1).known) warning = `Festius ${c.year + 1} pendents de configurar`;
  return { year: c.year, ...cur, warning };
}

/**
 * Whether the holidays for the year of this moment are authoritatively known from data.
 * @param {Date|number|string} [at=new Date()]
 * @returns {boolean}
 */
function isHolidayKnown(at = new Date()) {
  return getHolidayCoverage(at).known;
}

/**
 * Whether a moment falls on a modelled public holiday in Europe/Madrid.
 * @param {Date|number|string} at Epoch ms or Date
 * @returns {boolean} true only for a holiday this module knows about
 */
function isHoliday(at) {
  const c = calendarEngine.getDateComponents(at, 'Europe/Madrid');
  if (!c) return false;
  return holidaysForYear(c.year).has(ymd(c.year, c.month, c.day));
}

/**
 * Checks for a service override for the date of `at`.
 * @param {Date|number|string} at Epoch ms or Date
 * @returns {string|null} 'weekday'|'saturday'|'sunday'|null
 */
function getServiceOverride(at) {
  const c = calendarEngine.getDateComponents(at, 'Europe/Madrid');
  if (!c) return null;
  const dateKey = ymd(c.year, c.month, c.day);
  const yearData = holidaysData?.years?.[String(c.year)];
  if (!yearData || !Array.isArray(yearData.serviceOverrides)) return null;
  const override = yearData.serviceOverrides.find(o => o.date === dateKey);
  return override ? override.dayType : null;
}

/**
 * The calendar date of a moment, as YYYY-MM-DD in Europe/Madrid.
 * @param {Date|number|string} at Epoch ms or Date
 * @returns {string}
 */
function madridDate(at) {
  const c = calendarEngine.getDateComponents(at, 'Europe/Madrid');
  return ymd(c.year, c.month, c.day);
}

module.exports = {
  isHoliday,
  isHolidayKnown,
  getHolidayCoverage,
  getServiceOverride,
  madridDate,
  holidaysForYear,
  easterSunday
};
