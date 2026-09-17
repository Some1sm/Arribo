const calendar = require('../time/calendarEngine');
const time = require('../time/timeEngine');
const schedules = require('../../data/mataroSchedules');
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
      const configKey = `${leg.lineId}/${leg.direction}`;
      if (!configs.has(configKey)) configs.set(configKey, schedules.getDirectionSchedule(leg.lineId, leg.direction));
      const cfg = configs.get(configKey);
      const offsets = cfg?.stopTravelSecMap || {};
      const fromOffset = offsets[leg.fromStop.id];
      const toOffset = offsets[leg.toStop.id];
      const exact = Number.isFinite(fromOffset) && Number.isFinite(toOffset) && toOffset > fromOffset;
      const duration = exact ? toOffset - fromOffset : Math.max(180, (leg.durationMinutes || 3) * 60);
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
        const schedule = schedules.getDirectionSchedule(leg.lineId, leg.direction, day.isSunday ? 'sunday' : day.isSaturday ? 'saturday' : 'weekday');
        if (!Number.isFinite(schedule?.stopTravelSecMap?.[leg.fromStop.id])) continue;
        for (const clock of schedule.departures || []) {
          const seconds = time.timeStringToSeconds(clock);
          const serviceDate = new Date(Date.UTC(day.year, day.month - 1, day.day + Math.floor(seconds / 86400)));
          const originKey = `${serviceDate.toISOString().slice(0, 10)}/${clock}`;
          if (!originInstants.has(originKey)) originInstants.set(originKey, time.localTimeToUtcDate(serviceDate.getUTCFullYear(), serviceDate.getUTCMonth(), serviceDate.getUTCDate(), Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60).getTime());
          while (originInstants.size > 8192) originInstants.delete(originInstants.keys().next().value);
          const at = originInstants.get(originKey) + schedule.stopTravelSecMap[leg.fromStop.id] * 1000;
          // A live board takes precedence for matching scheduled departures.
          scheduled.push({ at, live: false });
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
  results.sort((a, b) => (options.preference === 'least_walking' ? a.walkingDistanceMeters - b.walkingDistanceMeters : 0) || Date.parse(a.arrivalAt) - Date.parse(b.arrivalAt) || a.walkingDistanceMeters - b.walkingDistanceMeters);
  const selected = [];
  const signatures = new Set();
  for (const itin of results) {
    const signature = itin.legs.map(leg => leg.lineId).join('->');
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    selected.push(itin);
    if (selected.length === 4) break;
  }
  return selected;
}
module.exports = { evaluate, requestedInstant };
