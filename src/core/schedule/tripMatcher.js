/**
 * src/core/schedule/tripMatcher.js
 *
 * Derives the scheduled and actual passing time of a vehicle from the static
 * timetable, for ingestion rows that otherwise have no provenance at all.
 *
 * Telemetry honesty: these times are DERIVED, never observed. The upstream feed
 * reports a delay but not the timetable time it is measured against, so we
 * recover it by asking which scheduled departure a bus could plausibly be on.
 * When no departure is close enough to be believable we return matched:false
 * rather than inventing a time — a wrong schedule is worse than none.
 *
 * All clock work is Europe/Madrid. Service dates cross midnight and DST, so
 * host-local getHours()/getDay() is never used here.
 */

const mataroSchedules = require('../../data/mataroSchedules');
const calendarEngine = require('../time/calendarEngine');
const timeEngine = require('../time/timeEngine');
const holidayCalendar = require('../time/holidayCalendar');

/**
 * Absolute ceiling on how far the recovered trip may sit from the vehicle's
 * observed position before we refuse to call it a match. The SIRI delay is
 * measured against the operator's own schedule, which drifts from ours by a few
 * minutes.
 */
const MAX_RESIDUAL_MINUTES = 30;

/**
 * Floor added to half the local headway when deriving the effective tolerance.
 * A dense line (13 min headway) needs a much tighter bound than a sparse one
 * (65 min), otherwise the fixed 30-minute ceiling can never refuse while
 * service is running and a detour is recorded as a confident match.
 */
const HEADWAY_TOLERANCE_FLOOR_MINUTES = 5;

/** Strip accents, punctuation and the " - 1234" stop-id suffix. */
function normalizeStopName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // Route-derived names carry a trailing " - <stopId>" that schedule names do
    // not ("Cirera - 1003" vs "Cirera"). Strip it before anything else so the
    // two halves of the lookup are comparable at all.
    .replace(/\s*-\s*\d{3,5}\s*$/, '')
    .replace(/[.,;:'"()·-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Shortest signed distance between two second-of-day values, wrapping at
 * midnight. A 23:50 departure and a 00:05 observation are 15 minutes apart,
 * not 23h45m apart.
 */
function circularDiffSec(a, b) {
  let d = a - b;
  while (d > 43200) d -= 86400;
  while (d < -43200) d += 86400;
  return d;
}

/**
 * Which timetable bucket a moment falls in. August weekdays run the reduced
 * "Dissabtes" timetable, so they must not be treated as ordinary weekdays.
 * Public holidays run the reduced "Diumenges i Festius" timetable.
 */
function resolveDayType(at) {
  const c = calendarEngine.getDateComponents(at, 'Europe/Madrid');
  let dayType = 'weekday';
  if (c.isSunday) dayType = 'sunday';
  else if (c.isSaturday || (c.isWeekday && c.isAugust)) dayType = 'saturday';
  else if (holidayCalendar.isHoliday(at)) dayType = 'sunday';
  return { dayType, components: c, isHoliday: dayType === 'sunday' && !c.isSunday };
}

/**
 * Median gap between consecutive departures at a stop, in minutes. Used to
 * scale the match tolerance to how dense the service actually is.
 */
function medianHeadwayMinutes(passingTimes) {
  const secs = passingTimes
    .map(t => timeEngine.timeStringToSeconds(t))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (secs.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < secs.length; i++) gaps.push((secs[i] - secs[i - 1]) / 60);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return median > 0 ? median : null;
}

/**
 * Locate the stop this vehicle is heading to, by sequence number then by name.
 *
 * A name that matches more than one stop in the same direction is AMBIGUOUS and
 * is refused rather than resolved to the first hit. L3 has two "TecnoCampus"
 * stops six minutes apart; picking the first would return a confident time six
 * minutes wrong, which is well inside the residual tolerance and so would never
 * be caught downstream.
 *
 * @returns {{stop: object|null, ambiguous: boolean}}
 */
function resolveStop(dirSched, toSeq, stopName) {
  const stops = Array.isArray(dirSched.stops) ? dirSched.stops : [];
  if (toSeq !== undefined && toSeq !== null && toSeq !== '') {
    const wanted = Number(toSeq);
    if (Number.isFinite(wanted)) {
      const bySeq = stops.find(s => Number(s.seq) === wanted);
      if (bySeq) return { stop: bySeq, ambiguous: false };
    }
  }
  if (stopName) {
    const wantedName = normalizeStopName(stopName);
    if (wantedName) {
      const matches = stops.filter(s => normalizeStopName(s.name) === wantedName);
      if (matches.length === 1) return { stop: matches[0], ambiguous: false };
      if (matches.length > 1) return { stop: null, ambiguous: true };
    }
  }
  return { stop: null, ambiguous: false };
}

/**
 * Recover the scheduled and actual passing time for one vehicle observation.
 *
 * @param {object} args
 * @param {string|number} args.lineId            Route id, e.g. '5'
 * @param {string|number} [args.direction]       Direction id as reported by the feed
 * @param {string|number} [args.toSeq]           Sequence number of the next stop
 * @param {string} [args.stopName]              Next stop name, used when toSeq is absent
 * @param {number} [args.delayMins]             Delay the feed reported
 * @param {number} [args.at]                    Epoch ms of the observation
 * @returns {{matched: boolean, reason?: string, scheduledTime: string, actualTime: string,
 *   dayType: string, direction: string, stopId: string, stopSeq: (number|string|null),
 *   residualMinutes: number|null, candidateCount: number}}
 */
function matchTrip({ lineId, direction, toSeq, stopName, delayMins, at = Date.now() } = {}) {
  const empty = (reason, extra = {}) => ({
    matched: false,
    reason,
    scheduledTime: '',
    actualTime: '',
    dayType: '',
    direction: String(direction || ''),
    stopId: '',
    stopSeq: null,
    residualMinutes: null,
    candidateCount: 0,
    ...extra
  });

  if (lineId === undefined || lineId === null || String(lineId).trim() === '') {
    return empty('no lineId');
  }
  if (at === undefined || at === null || Number.isNaN(Number(at)) || Number(at) <= 0) {
    return empty('no observation timestamp');
  }

  const { dayType, components, isHoliday } = resolveDayType(at);
  const dirSched = mataroSchedules.getDirectionSchedule(lineId, direction, dayType);
  if (!dirSched) return empty('no direction schedule', { dayType, isHoliday });

  const { stop, ambiguous } = resolveStop(dirSched, toSeq, stopName);
  if (ambiguous) return empty('ambiguous stop name in schedule', { dayType, isHoliday });
  if (!stop) return empty('next stop not found in schedule', { dayType, isHoliday });

  const passingTimes = mataroSchedules.getDeparturesForStop(lineId, direction, stop.id, dayType);
  if (!Array.isArray(passingTimes) || passingTimes.length === 0) {
    return empty('no scheduled departures for this stop', { dayType, isHoliday, stopId: String(stop.id), stopSeq: stop.seq });
  }

  // The vehicle should be arriving around now; step back its delay to land on
  // the departure it is running.
  const delayNum = Number.isFinite(Number(delayMins)) ? Number(delayMins) : 0;
  const nowSec = (components.hour % 24) * 3600 + components.minute * 60 + components.second;
  const targetSec = nowSec - delayNum * 60;

  let best = null;
  for (const t of passingTimes) {
    const sec = timeEngine.timeStringToSeconds(t);
    if (!Number.isFinite(sec)) continue;
    const diff = circularDiffSec(targetSec, sec);
    if (!best || Math.abs(diff) < Math.abs(best.diff)) best = { time: t, diff };
  }
  if (!best) return empty('no parseable scheduled departures', { dayType, isHoliday, stopId: String(stop.id), stopSeq: stop.seq });

  const residualMinutes = Math.round(best.diff / 60);

  // Scale the tolerance to the service density. On a 13-minute line a 30-minute
  // ceiling is unreachable and every observation matches something; on a
  // 65-minute line a tight ceiling would refuse legitimate matches. Half the
  // local headway (plus a small floor for schedule drift) is the honest bound.
  const headway = medianHeadwayMinutes(passingTimes);
  const effectiveTolerance = headway
    ? Math.min(MAX_RESIDUAL_MINUTES, headway / 2 + HEADWAY_TOLERANCE_FLOOR_MINUTES)
    : MAX_RESIDUAL_MINUTES;

  if (Math.abs(residualMinutes) > effectiveTolerance) {
    return empty('no departure close enough to trust', {
      dayType,
      isHoliday,
      stopId: String(stop.id),
      stopSeq: stop.seq,
      residualMinutes,
      toleranceMinutes: effectiveTolerance,
      candidateCount: passingTimes.length
    });
  }

  const schedSec = timeEngine.timeStringToSeconds(best.time);
  const actualSec = schedSec + delayNum * 60;

  return {
    matched: true,
    scheduledTime: timeEngine.secondsToTimeString(((schedSec % 86400) + 86400) % 86400),
    actualTime: timeEngine.secondsToTimeString(((actualSec % 86400) + 86400) % 86400),
    dayType,
    isHoliday,
    direction: String(dirSched.dirId || direction || ''),
    stopId: String(stop.id),
    stopSeq: stop.seq,
    residualMinutes,
    toleranceMinutes: effectiveTolerance,
    headwayMinutes: headway,
    candidateCount: passingTimes.length
  };
}

module.exports = {
  matchTrip,
  resolveDayType,
  normalizeStopName,
  circularDiffSec,
  medianHeadwayMinutes,
  MAX_RESIDUAL_MINUTES,
  HEADWAY_TOLERANCE_FLOOR_MINUTES
};
