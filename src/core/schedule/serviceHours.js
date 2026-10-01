/**
 * src/core/schedule/serviceHours.js
 *
 * When each line is in revenue service, from its published timetable, for any
 * instant: the window of that date's day type and season (first departure
 * - 15 min to last stop time + 20 min, mataroSchedules.getServiceWindow), plus
 * the previous day's window while it runs past midnight.
 *
 * This replaces clock rules that disagreed with the timetable. The Observatori
 * treated everything before 06:00 and from 23:00 as depot / night maintenance,
 * but on weekdays L1, L2, L3 and L5 publish 95 stop times before 06:00 (L1 and
 * L2 leave at 05:25) and L1 and L3 run until 23:05, so the first and last trips
 * of the day were left out of every figure and labelled "Cotxeres".
 *
 * Fast enough to run per row inside SQLite: the Europe/Madrid UTC offset is
 * cached per UTC hour (DST always changes on the hour), and the day type and
 * season per Madrid date.
 */

'use strict';

const calendarEngine = require('../time/calendarEngine');
const mataroSchedules = require('../../data/mataroSchedules');
const seasonCalendar = require('../../data/seasonCalendar');
const { resolveDayType } = require('./tripMatcher');

/** Records of 10+ min this soon after a line's first departure are shift-start misassignments. */
const STARTUP_WINDOW_MIN = 30;
const LINE_IDS = ['1', '2', '3', '4', '5', '6', '7', '8'];
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

const offsetByHour = new Map();
const dayByNumber = new Map();
const windowByKey = new Map();
let noticeWindowCount = -1;

function madridOffsetMs(ts) {
  const hourBucket = Math.floor(ts / HOUR_MS);
  let offset = offsetByHour.get(hourBucket);
  if (offset === undefined) {
    const at = hourBucket * HOUR_MS;
    const c = calendarEngine.getDateComponents(at, 'Europe/Madrid');
    offset = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second) - at;
    if (offsetByHour.size > 20000) offsetByHour.clear();
    offsetByHour.set(hourBucket, offset);
  }
  return offset;
}

/** Madrid calendar day (days since 1970-01-01) and second of that day. */
function madridClock(ts) {
  const local = ts + madridOffsetMs(ts);
  const dayNumber = Math.floor(local / DAY_MS);
  return { dayNumber, secOfDay: Math.floor((local - dayNumber * DAY_MS) / 1000) };
}

/** Day type and season of a Madrid calendar day. */
function serviceDay(dayNumber) {
  // A season window learned from a notice changes which grid a date runs.
  const count = seasonCalendar._noticeWindows.length;
  if (count !== noticeWindowCount) {
    noticeWindowCount = count;
    dayByNumber.clear();
  }
  let day = dayByNumber.get(dayNumber);
  if (!day) {
    // 10:00 UTC is 11:00 or 12:00 in Madrid: always inside that Madrid day.
    const midday = dayNumber * DAY_MS + 10 * HOUR_MS;
    day = { dayType: resolveDayType(midday).dayType, season: seasonCalendar.resolveSeason(midday).season };
    if (dayByNumber.size > 2000) dayByNumber.clear();
    dayByNumber.set(dayNumber, day);
  }
  return day;
}

function lineWindow(lineId, dayNumber) {
  const { dayType, season } = serviceDay(dayNumber);
  const key = `${lineId}|${dayType}|${season}`;
  if (!windowByKey.has(key)) windowByKey.set(key, mataroSchedules.getServiceWindow(lineId, dayType, season));
  return windowByKey.get(key);
}

function lineIdOf(lineCode) {
  const id = String(lineCode === undefined || lineCode === null ? '' : lineCode).trim().replace(/^L/i, '');
  return LINE_IDS.includes(id) ? id : null;
}

function inService(lineId, dayNumber, secOfDay) {
  const today = lineWindow(lineId, dayNumber);
  if (today && secOfDay >= today.startSec && secOfDay <= today.endSec) return true;
  const yesterday = lineWindow(lineId, dayNumber - 1);
  return Boolean(yesterday && yesterday.endSec > 86400 && secOfDay + 86400 <= yesterday.endSec);
}

/**
 * Whether a line runs no published service at this instant. An unknown line
 * ('L12', '') is outside service only when every Mataró line is.
 * @param {string|number} lineCode '1'..'8' or 'L1'..'L8'
 * @param {number|Date} at
 */
function isOutsideRevenueService(lineCode, at) {
  const ts = Number(at instanceof Date ? at.getTime() : at);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const { dayNumber, secOfDay } = madridClock(ts);
  const id = lineIdOf(lineCode);
  return !(id ? [id] : LINE_IDS).some(l => inService(l, dayNumber, secOfDay));
}

/**
 * Whether this instant is in the first STARTUP_WINDOW_MIN minutes of a line's
 * service day (from its window start, 15 min before the first departure).
 */
function isServiceStartup(lineCode, at, minutes = STARTUP_WINDOW_MIN) {
  const id = lineIdOf(lineCode);
  const ts = Number(at instanceof Date ? at.getTime() : at);
  if (!id || !Number.isFinite(ts) || ts <= 0) return false;
  const { dayNumber, secOfDay } = madridClock(ts);
  const w = lineWindow(id, dayNumber);
  return Boolean(w && secOfDay >= w.startSec && secOfDay < w.firstDepartureSec + minutes * 60);
}

/**
 * Earliest and latest hour of published service for a line over every day
 * type of the season in force (for hourly tables): { minH, maxH } or null.
 */
function operatingHours(lineCode, season = null) {
  const id = lineIdOf(lineCode);
  if (!id) return null;
  let minH = 24;
  let maxH = -1;
  for (const dayType of ['weekday', 'saturday', 'sunday']) {
    const w = mataroSchedules.getServiceWindow(id, dayType, season);
    if (!w) continue;
    minH = Math.min(minH, Math.floor(w.firstDepartureSec / 3600));
    maxH = Math.max(maxH, Math.floor(Math.min(w.lastStopSec, 86399) / 3600));
  }
  return maxH < 0 ? null : { minH, maxH };
}

/**
 * Published service hours of every line on one Madrid calendar date, as hour
 * numbers 0..23 (a window running past midnight is counted on its own date).
 * @param {number} year @param {number} month 1-12 @param {number} day
 * @returns {Set<number>}
 */
function serviceHoursOnDate(year, month, day) {
  const dayNumber = Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
  const hours = new Set();
  for (const id of LINE_IDS) {
    const w = lineWindow(id, dayNumber);
    if (!w) continue;
    const last = Math.min(w.lastStopSec, 86399);
    for (let h = Math.floor(w.firstDepartureSec / 3600); h <= Math.floor(last / 3600); h++) hours.add(h);
  }
  return hours;
}

module.exports = {
  isOutsideRevenueService,
  isServiceStartup,
  operatingHours,
  serviceHoursOnDate,
  lineIdOf,
  STARTUP_WINDOW_MIN
};
