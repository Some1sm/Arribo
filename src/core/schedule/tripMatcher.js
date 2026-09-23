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

/**
 * How far the recovered trip may sit from the vehicle's observed position
 * before we refuse to call it a match. The SIRI delay is measured against the
 * operator's own schedule, which drifts from ours by a few minutes, but a bus
 * cannot be 40 minutes from any departure on the line and still be on it.
 */
const MAX_RESIDUAL_MINUTES = 30;

/** Strip accents and punctuation so "Pl. de Catalunya" matches "Pl Catalunya". */
function normalizeStopName(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
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
 */
function resolveDayType(at) {
  const c = calendarEngine.getDateComponents(at, 'Europe/Madrid');
  let dayType = 'weekday';
  if (c.isSunday) dayType = 'sunday';
  else if (c.isSaturday || (c.isWeekday && c.isAugust)) dayType = 'saturday';
  return { dayType, components: c };
}

/** Locate the stop this vehicle is heading to, by sequence number then by name. */
function resolveStop(dirSched, toSeq, stopName) {
  const stops = Array.isArray(dirSched.stops) ? dirSched.stops : [];
  if (toSeq !== undefined && toSeq !== null && toSeq !== '') {
    const wanted = Number(toSeq);
    if (Number.isFinite(wanted)) {
      const bySeq = stops.find(s => Number(s.seq) === wanted);
      if (bySeq) return bySeq;
    }
  }
  if (stopName) {
    const wantedName = normalizeStopName(stopName);
    if (wantedName) {
      const byName = stops.find(s => normalizeStopName(s.name) === wantedName);
      if (byName) return byName;
    }
  }
  return null;
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

  const { dayType, components } = resolveDayType(at);
  const dirSched = mataroSchedules.getDirectionSchedule(lineId, direction, dayType);
  if (!dirSched) return empty('no direction schedule', { dayType });

  const stop = resolveStop(dirSched, toSeq, stopName);
  if (!stop) return empty('next stop not found in schedule', { dayType });

  const passingTimes = mataroSchedules.getDeparturesForStop(lineId, direction, stop.id, dayType);
  if (!Array.isArray(passingTimes) || passingTimes.length === 0) {
    return empty('no scheduled departures for this stop', { dayType, stopId: String(stop.id), stopSeq: stop.seq });
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
  if (!best) return empty('no parseable scheduled departures', { dayType, stopId: String(stop.id), stopSeq: stop.seq });

  const residualMinutes = Math.round(best.diff / 60);
  if (Math.abs(residualMinutes) > MAX_RESIDUAL_MINUTES) {
    return empty('no departure close enough to trust', {
      dayType,
      stopId: String(stop.id),
      stopSeq: stop.seq,
      residualMinutes,
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
    direction: String(dirSched.dirId || direction || ''),
    stopId: String(stop.id),
    stopSeq: stop.seq,
    residualMinutes,
    candidateCount: passingTimes.length
  };
}

module.exports = { matchTrip, resolveDayType, normalizeStopName, circularDiffSec, MAX_RESIDUAL_MINUTES };
