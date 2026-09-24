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
 * Scope: Catalonia regional + national holidays, which is what CTSA applies to
 * the Mataró urban network. Local Mataró-only holidays are not modelled — an
 * unmodelled holiday is reported as unknown by isHoliday(), never as "not a
 * holiday".
 *
 * All date work is Europe/Madrid wall-clock and calendar-date based; no
 * timestamps, no host-local getDay().
 */

const calendarEngine = require('./calendarEngine');

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
  // Days-from-civil style arithmetic via UTC, which is safe here because we
  // only ever manipulate a calendar date, never a wall-clock instant.
  const ms = Date.UTC(2000, month - 1, day) + days * 86400000;
  const d = new Date(ms);
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function ymd(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Fixed-date national + Catalan holidays, plus the Easter-derived ones. */
function holidayDatesForYear(year) {
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
    ymd(year, 12, 6),   // Sant Nicolau
    ymd(year, 12, 25),  // Nadal
    ymd(year, 12, 26),  // Sant Esteve
    // Catalan (Diada Nacional)
    ymd(year, 9, 11),   // Diada Nacional de Catalunya
    ymd(year, 6, 24),   // Sant Joan
    // Easter-derived
    ymd(year, goodFriday.month, goodFriday.day),   // Divendres Sant
    ymd(year, easter.month, easter.day),           // Pasqua
    ymd(year, easterMonday.month, easterMonday.day), // Dilluns de Pasqua
  ]);
  return dates;
}

const cache = new Map();

function holidaysForYear(year) {
  if (!cache.has(year)) cache.set(year, holidayDatesForYear(year));
  return cache.get(year);
}

/**
 * Whether a moment falls on a modelled public holiday in Europe/Madrid.
 *
 * @param {number} at Epoch ms
 * @returns {boolean} true only for a holiday this module actually knows about
 */
function isHoliday(at) {
  const c = calendarEngine.getDateComponents(at, 'Europe/Madrid');
  if (!c) return false;
  return holidaysForYear(c.year).has(ymd(c.year, c.month, c.day));
}

/**
 * The calendar date of a moment, as YYYY-MM-DD in Europe/Madrid.
 *
 * @param {number} at Epoch ms
 * @returns {string}
 */
function madridDate(at) {
  const c = calendarEngine.getDateComponents(at, 'Europe/Madrid');
  return ymd(c.year, c.month, c.day);
}

module.exports = { isHoliday, madridDate, holidaysForYear, easterSunday };
