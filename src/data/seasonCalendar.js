/**
 * src/data/seasonCalendar.js
 *
 * Which of the two published Mataró Bus timetables is in force on a given date.
 *
 * WHY THIS EXISTS
 * ---------------
 * The operator publishes a genuinely different grid per season at
 * https://maresme.net/matarobus/{hivern,estiu}/. Before this existed the
 * shipped timetable file held a MIXTURE of the two — on L1, L2, L4, L6 and L8
 * direction 11 was winter while direction 12 was summer — so a rider got
 * correct times one way and wrong times back, and nothing could detect it.
 *
 * MODELLING CHOICE: SUMMER IS THE EXCEPTION
 * ------------------------------------------
 * The operator announces the reduced summer timetable as a *notice* with an
 * explicit window ("HORARIS ESTIU 2026 — Del 27 de juliol fins al 23 d'agost"),
 * and otherwise runs the standard grid. So this module treats winter as the
 * default and records the known summer windows as dated exceptions. That
 * matches how the operator actually communicates, and it fails safe: a summer
 * period we never heard about degrades to winter rather than to a grid we have
 * no evidence for at all.
 *
 * HONESTY
 * --------
 * A date is only reported as winter with `known: true` from DATA_KNOWN_FROM
 * onward. Before that we have no information, and `known: false` says so
 * rather than asserting a grid. Callers surface that rather than hiding it.
 *
 * DATES ARE COMPARED AS 'YYYY-MM-DD' IN Europe/Madrid, not as instants. A
 * season window is a calendar-date concept; comparing epochs would make a
 * boundary fall at an arbitrary UTC instant and shift with DST.
 */

'use strict';

const calendarEngine = require('../core/time/calendarEngine');

const TIMEZONE = 'Europe/Madrid';

/**
 * The first date for which we hold a grid. Queries before this are reported
 * unknown rather than assumed.
 */
const DATA_KNOWN_FROM = '2026-01-01';

/**
 * Dated summer windows. `from`/`to` are inclusive, as the operator states them
 * ("Del 27 de juliol fins al 23 d'agost" is a service period, not an instant).
 */
const SUMMER_WINDOWS = [
  {
    from: '2026-07-27',
    to: '2026-08-23',
    season: 'summer',
    source: 'notice 1505 "HORARIS ESTIU 2026"',
    // The notice states the service period and that weekdays only change.
    weekdaysOnly: true
  }
];

/** Windows learned at runtime from live operator notices. See registerWindow. */
const noticeWindows = [];

/**
 * Which source wins when a date is covered by both. The operator's own live
 * notice outranks our static config, because it is maintained by whoever runs
 * the service and needs no upkeep here. Flip to 'config' to invert.
 */
const SEASON_PRECEDENCE = 'notice';

// ---------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' for an instant, in the service timezone. */
function madridDateKey(at = new Date()) {
  const c = calendarEngine.getDateComponents(at, TIMEZONE);
  return `${c.year}-${pad2(c.month)}-${pad2(c.day)}`;
}

/** Inclusive date-string comparison; valid for zero-padded ISO dates. */
function within(key, from, to) {
  return key >= from && key <= to;
}

/**
 * Records a season window learned from a live operator notice.
 *
 * Called by the tracker's aviso sync, which already parses notice date ranges
 * out of the portal text. Duplicates (the same window re-parsed on every 5
 * minute poll) are collapsed, so this is safe to call repeatedly.
 *
 * @param {{from:string,to:string,season:string,title?:string}} window
 * @returns {boolean} whether the window was new
 */
function registerWindow(window) {
  if (!window || !window.from || !window.to) return false;
  if (window.season !== 'summer' && window.season !== 'winter') return false;
  if (noticeWindows.some((w) => w.from === window.from && w.to === window.to && w.season === window.season)) {
    return false;
  }
  noticeWindows.push({
    from: window.from,
    to: window.to,
    season: window.season,
    source: window.title ? `notice "${window.title}"` : 'notice',
    title: window.title || null
  });
  return true;
}

/** Drops runtime-learned windows. Test seam. */
function clearNoticeWindows() {
  noticeWindows.length = 0;
}

/**
 * Resolves the season in force at an instant.
 *
 * @param {Date|number|string} [at=new Date()]
 * @returns {{season:'winter'|'summer', source:string, known:boolean, window:object|null}}
 *   `season` is always populated so a caller can proceed, but `known: false`
 *   means we are outside the period we hold data for and the caller should say
 *   so rather than presenting the grid as authoritative.
 */
function resolveSeason(at = new Date()) {
  const key = madridDateKey(at);

  // A single covering notice window is the operator's own statement about this
  // date, for either season, and outranks our static config. More than one is a
  // data problem — the tracker re-parses the portal every 5 minutes and
  // collapses identical windows, so overlapping distinct ones mean the operator
  // published something we cannot reconcile. That is not a reason to pick one.
  const covering = noticeWindows.filter((w) => within(key, w.from, w.to));
  if (SEASON_PRECEDENCE === 'notice' && covering.length > 1) {
    return { season: 'winter', source: 'ambiguous notice windows', known: false, window: null };
  }
  if (SEASON_PRECEDENCE === 'notice' && covering.length === 1) {
    const w = covering[0];
    return { season: w.season, source: w.source, known: true, window: w };
  }

  const config = SUMMER_WINDOWS.find((w) => within(key, w.from, w.to));
  if (config) {
    return { season: 'summer', source: config.source, known: true, window: config };
  }

  return {
    season: 'winter',
    source: 'default (no summer window covers this date)',
    known: key >= DATA_KNOWN_FROM,
    window: null
  };
}

module.exports = {
  TIMEZONE,
  DATA_KNOWN_FROM,
  SUMMER_WINDOWS,
  SEASON_PRECEDENCE,
  madridDateKey,
  registerWindow,
  clearNoticeWindows,
  resolveSeason,
  // exported for tests
  _noticeWindows: noticeWindows
};
