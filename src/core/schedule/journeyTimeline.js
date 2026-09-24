const calendar = require('../time/calendarEngine');
const time = require('../time/timeEngine');
const schedules = require('../../data/mataroSchedules');
const tripMatcher = require('./tripMatcher');
const walking = require('../geo/pedestrianRouter');
const originInstants = new Map();
const datedBoards = new Map();
const displayClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false });

function requestedInstant(options, now = Date.now()) {
  if (!options.departureDate && !options.departureTime) return now;
  const c = calendar.getDateComponents(now);
  const date = options.departureDate || `${c.year}-${String(c.month).padStart(2, '0')}-${String(c.day).padStart(2, '0')}`;
  const clock = options.departureTime || `${String(c.hour % 24).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(clock)) throw new Error('Data o hora no vàlida');
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = clock.split(':').map(Number);
  const candidate = time.localTimeToUtcDate(y, m - 1, d, h, min).getTime();
  const matches = value => {
    const check = calendar.getDateComponents(value);
    return check.year === y && check.month === m && check.day === d && check.hour % 24 === h && check.minute === min;
  };
  if (!matches(candidate)) throw new Error('Data o hora inexistent a Europe/Madrid');
  const instant = matches(candidate - 3600000) ? candidate - 3600000 : candidate;
  return options.departureDate || options.departureTime ? instant : now;
}

async function evaluate(candidates, tracker, options = {}) {
  const start = requestedInstant(options);
  const horizon = start + 86400000;
  const live = Math.abs(start - Date.now()) < 1200000;
  const boards = new Map();
  const budget = { remaining: 12 };
  const speed = Number(options.walkingSpeed) || 80;
  const maxWalk = Number(options.maxWalkingDistance) || 2000;
  const results = [];
  const scheduleBoards = new Map();
  const startDay = calendar.getDateComponents(start);
  const serviceDays = [-1, 0, 1].map(offset => calendar.getDateComponents(new Date(Date.UTC(startDay.year, startDay.month - 1, startDay.day + offset, 12))));
  // The timetable bucket is a property of the SERVICE date, not of the instant a
  // trip happens to pass a stop: a 23:50 trip on a Friday is a Friday trip even
  // though it alights just after midnight on Saturday. Resolving it from the
  // service date (rather than from each departure's `at`) is what keeps a
  // late-night leg from silently borrowing Saturday's or Sunday's offsets.
  //
  // resolveDayType is shared with the ingestion matcher so the planner and the
  // Observatori can never disagree about which grid a date runs on - including
  // the August reduction and public holidays, which are not Saturday or Sunday.
  const dayTypeByDate = new Map(serviceDays.map(day => [
    day.dateStr,
    tripMatcher.resolveDayType(Date.UTC(day.year, day.month - 1, day.day, 12)).dayType
  ]));
  const configs = new Map();
  for (const itin of candidates) {
    let walkMeters = 0;
    for (const field of ['walkToFirstStop', 'transferWalk', 'walkFromLastStop']) {
      if (!itin[field]) continue;
      const route = await walking.route(itin[field].from, itin[field].to, speed, budget);
      Object.assign(itin[field], route, { walkingMinutes: Math.ceil(route.durationSeconds / 60) });
      walkMeters += route.distanceMeters;
    }
    if (walkMeters > maxWalk) continue;
    let cursor = start + (itin.walkToFirstStop?.durationSeconds || 0) * 1000;
    let feasible = true;
    let rideSeconds = 0;
    let waitSeconds = 0;
    for (let index = 0; index < itin.legs.length; index++) {
      const leg = itin.legs[index];
      if (index) cursor += (itin.transferWalk?.durationSeconds || 0) * 1000;
      const ready = cursor + (index ? 120000 : 60000);
      const key = `${leg.lineId}/${leg.direction}/${leg.fromStop.id}`;
      let departures = [];
      // Direction identity (dirId/pathId) is day-independent, so this config is
      // safe to cache without a date. Cumulative offsets are NOT day-independent
      // - the ride duration is resolved below, from the chosen departure's own
      // service day, so a Sunday departure is not given a weekday ride time.
      const configKey = `${leg.lineId}/${leg.direction}`;
      if (!configs.has(configKey)) configs.set(configKey, schedules.getDirectionSchedule(leg.lineId, leg.direction));
      const cfg = configs.get(configKey);
      if (live && tracker?.getStopDepartures) {
        if (!boards.has(key)) boards.set(key, Promise.resolve().then(() => tracker.getStopDepartures(leg.fromStop.id, leg.lineId, leg.direction)).catch(() => null));
        const board = await boards.get(key);
        departures = (board?.departures || []).filter(dep => {
          const direction = dep.direction;
          return direction == null || [leg.direction, cfg?.dirId, cfg?.pathId].some(value => String(value) === String(direction));
        }).map(dep => ({ at: Date.parse(dep.expectedIso || dep.aimedIso), live: !!dep.isRealTime }));
      }
      // Origin clock plus cumulative stop offsets, retaining the service date.
      if (!scheduleBoards.has(key)) {
        const datedKey = `${startDay.dateStr}/${key}`;
        const existing = datedBoards.get(datedKey);
        if (existing && existing.schedule === cfg?.departures && existing.offsets === cfg?.stopTravelSecMap) {
          scheduleBoards.set(key, existing.departures);
        } else {
        const scheduled = [];
        for (const day of serviceDays) {
        const dayType = dayTypeByDate.get(day.dateStr);
        const schedule = schedules.getDirectionSchedule(leg.lineId, leg.direction, dayType);
        if (!Number.isFinite(schedule?.stopTravelSecMap?.[leg.fromStop.id])) continue;
        for (const clock of schedule.departures || []) {
          const seconds = time.timeStringToSeconds(clock);
          const serviceDate = new Date(Date.UTC(day.year, day.month - 1, day.day + Math.floor(seconds / 86400)));
          const originKey = `${serviceDate.toISOString().slice(0, 10)}/${clock}`;
          if (!originInstants.has(originKey)) originInstants.set(originKey, time.localTimeToUtcDate(serviceDate.getUTCFullYear(), serviceDate.getUTCMonth(), serviceDate.getUTCDate(), Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60).getTime());
          while (originInstants.size > 8192) originInstants.delete(originInstants.keys().next().value);
          const at = originInstants.get(originKey) + schedule.stopTravelSecMap[leg.fromStop.id] * 1000;
          // A live board takes precedence for matching scheduled departures.
          // dayType travels with the departure so the ride duration below is
          // resolved from the same timetable this instant was drawn from.
          scheduled.push({ at, live: false, dayType });
        }
      }
        scheduleBoards.set(key, scheduled);
        datedBoards.set(datedKey, { departures: scheduled, schedule: cfg?.departures, offsets: cfg?.stopTravelSecMap });
        if (datedBoards.size > 512) datedBoards.delete(datedBoards.keys().next().value);
        }
      }
      const scheduled = scheduleBoards.get(key);
      departures.push(...scheduled.filter(dep => !departures.some(observation => Math.abs(observation.at - dep.at) < 60000)));
      const departure = departures.filter(dep => Number.isFinite(dep.at) && dep.at >= ready && dep.at <= horizon).sort((a, b) => a.at - b.at)[0];
      if (!departure) { feasible = false; break; }
      // Ride duration comes from the timetable of the day this bus departs on.
      // Weekday offsets applied to a Sunday or holiday departure understate the
      // ride by several minutes, and the leg would still be labelled
      // timingSource:'timetable' - a confident wrong answer, which is exactly
      // what a planner cannot show.
      //
      // A scheduled departure carries its service date. A live departure is an
      // observation, so its day is read off the instant itself: the observed
      // Madrid date is the best available signal, and it correctly picks up
      // August and public holidays where a hardcoded weekday grid would not.
      const depDayType = departure.dayType || tripMatcher.resolveDayType(departure.at).dayType;
      const dayCfg = schedules.getDirectionSchedule(leg.lineId, leg.direction, depDayType);
      const dayOffsets = dayCfg?.stopTravelSecMap;
      const fromOffset = dayOffsets?.[leg.fromStop.id];
      const toOffset = dayOffsets?.[leg.toStop.id];
      // A stop whose offset was repaired rather than calibrated is an estimate.
      // Almost every direction's terminus is one.
      //
      // The estimate is still the best number available, so it is USED for the
      // arrival time - discarding a calibrated offset for the neighbouring stop
      // and substituting the router's guess would make the answer worse, not
      // more honest. What the estimate must not do is make the leg look
      // authoritative, so it caps how the leg is LABELLED, separately from what
      // value it is computed from.
      const estimated = dayCfg?.estimatedStopIds || [];
      const touchesEstimate = estimated.includes(String(leg.fromStop.id))
        || estimated.includes(String(leg.toStop.id));
      const hasOffsets = Number.isFinite(fromOffset) && Number.isFinite(toOffset) && toOffset > fromOffset;
      const exact = hasOffsets && !touchesEstimate;
      const duration = hasOffsets ? toOffset - fromOffset : Math.max(180, (leg.durationMinutes || 3) * 60);
      const wait = (departure.at - cursor) / 1000;
      waitSeconds += wait;
      rideSeconds += duration;
      Object.assign(leg, {
        boardAt: new Date(departure.at).toISOString(), alightAt: new Date(departure.at + duration * 1000).toISOString(),
        departureTime: displayClock.format(departure.at), isRealTime: departure.live,
        timingSource: exact ? (departure.live ? 'live' : 'timetable') : 'heuristic',
        waitMinutes: Math.ceil(wait / 60), nextDepartureMinutes: Math.ceil((departure.at - start) / 60000),
        nextDepartureMins: Math.ceil((departure.at - start) / 60000), durationMinutes: duration / 60, durationMins: duration / 60, travelTimeMins: duration / 60
      });
      if (!index) itin.initialWaitMinutes = leg.waitMinutes;
      else itin.transferWaitMinutes = leg.waitMinutes;
      cursor = departure.at + duration * 1000;
    }
    if (!feasible) continue;
    cursor += (itin.walkFromLastStop?.durationSeconds || 0) * 1000;
    if (cursor > horizon) continue;
    const walkSeconds = ['walkToFirstStop', 'transferWalk', 'walkFromLastStop'].reduce((sum, field) => sum + (itin[field]?.durationSeconds || 0), 0);
    Object.assign(itin, {
      id: itin.legs.map(leg => `${leg.lineId}:${leg.direction}:${leg.fromStop.id}:${leg.toStop.id}`).join('|'),
      requestedDepartureAt: new Date(start).toISOString(), arrivalAt: new Date(cursor).toISOString(),
      totalDurationMinutes: Math.ceil((cursor - start) / 60000), totalDurationMins: Math.ceil((cursor - start) / 60000),
      walkingMinutes: Math.ceil(walkSeconds / 60), walkingDistanceMeters: walkMeters, rideMinutes: rideSeconds / 60, waitMinutes: Math.ceil(waitSeconds / 60),
      departureTime: itin.legs[0].departureTime, nextDepartureMinutes: itin.legs[0].nextDepartureMinutes, nextDepartureMins: itin.legs[0].nextDepartureMinutes,
      isRealTime: itin.legs[0].isRealTime, isFutureSchedule: !live, plannedDepartureTime: options.departureTime || null, plannedDepartureDate: options.departureDate || null,
      timingSource: itin.legs.some(leg => leg.timingSource === 'heuristic') ? 'heuristic' : itin.legs.some(leg => leg.isRealTime) ? 'live' : 'timetable'
    });
    results.push(itin);
  }
  // Ranking. Arrival time on its own produces absurd results: a one-transfer
  // itinerary that lands a minute earlier beats the direct bus, and starting
  // by walking three stops in the wrong direction is free, so the search
  // happily offers it. Each itinerary therefore carries a complexity cost and
  // the two are traded off. The weights are deliberately conservative —
  // a transfer still wins when it is genuinely worth it.
  const WEIGHTS = {
    fastest: { transfer: 7, walk: 2, walkCap: 25, perMeter: 0 },
    direct_only: { transfer: 7, walk: 2, walkCap: 25, perMeter: 0 },
    least_walking: { transfer: 5, walk: 4, walkCap: 60, perMeter: 0.004 }
  };
  const weights = WEIGHTS[options.preference] || WEIGHTS.fastest;
  const rankScore = itin => {
    const transfers = Number.isFinite(itin.transfersCount) ? itin.transfersCount : Math.max(0, itin.legs.length - 1);
    return Date.parse(itin.arrivalAt) / 60000
      + transfers * weights.transfer
      + Math.min(weights.walkCap, (itin.walkingMinutes || 0) * weights.walk)
      + (itin.walkingDistanceMeters || 0) * weights.perMeter;
  };
  results.sort((a, b) => rankScore(a) - rankScore(b)
    || Date.parse(a.arrivalAt) - Date.parse(b.arrivalAt)
    || a.walkingDistanceMeters - b.walkingDistanceMeters);
  const selected = [];
  const signatures = new Set();
  let sawTransfer = false;
  let sawDirect = false;
  for (const itin of results) {
    const signature = itin.legs.map(leg => leg.lineId).join('->');
    if (signatures.has(signature)) continue;
    // Keep the board varied but not lopsided: never spend more than two of the
    // four slots on transfer routes when a direct one is available, so a slow
    // direct does not push every direct option off the list behind transfers.
    if (itin.transfersCount > 0) {
      if (!sawDirect && selected.length >= 2) continue;
      if (sawTransfer && selected.length >= 3) continue;
      sawTransfer = true;
    } else {
      sawDirect = true;
    }
    signatures.add(signature);
    selected.push(itin);
    if (selected.length === 4) break;
  }
  return selected;
}
module.exports = { evaluate, requestedInstant };
