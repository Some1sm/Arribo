/**
 * src/core/schedule/incidentRun.js
 *
 * The "Investigar" panel's view of one bus: every stop it logged around the
 * clicked delay (one entry per consecutive stop visit, whatever the delay), and
 * a plain summary of how the delay evolved in the clicked direction.
 *
 * The panel used to list only the samples at the clicked stop, so a bus that
 * ran 25 minutes late across 21 stops looked like "one GPS ping". Showing the
 * run is what lets a reader tell a sustained real delay from a one-off value or
 * an operator-system glitch.
 *
 * Records the operator's system logged while the bus drove back to the start of
 * its route without passengers (a deadhead return, see deadheadReturn.js) are
 * marked `phantom` and grouped on their own, so they neither read as trips nor
 * count in any trip's delay pattern.
 *
 * The panel also traces where the clicked delay came from: back to the last stop
 * the bus logged without delay (possibly several trips earlier), with the stops
 * where the delay grew most. A bus that starts a trip at +18 inherited it from
 * the trips before; showing only the clicked trip hid that.
 *
 * Pure module: no database, no clock. Timestamps are epoch ms.
 */

const { LATE_LIMIT_MIN } = require('../punctuality');

// How much of the bus's run to show on each side of the clicked episode.
const RUN_CONTEXT_MS = 30 * 60 * 1000;
// How far back the caller should load the bus's samples so the origin of a delay
// can be traced (production L8 bus 2667, 29 Sep 2026: +25 at 13:40, last without
// delay at 10:38).
const RUN_LOOKBACK_MS = 4 * 60 * 60 * 1000;
// A rise of at least this much between two consecutive stop visits is named as a
// place where the delay grew.
const ORIGIN_GROWTH_MINS = 3;
// At most this many such places are named.
const MAX_ORIGIN_EVENTS = 3;
// A delay that stays within this spread over the whole direction is "sustained".
const SUSTAINED_SPREAD_MINS = 5;
// A first-to-last change of at least this much is "building" or "recovering".
const TREND_MINS = 5;
// Below this a delay is ordinary service (same threshold as the incident lists).
const SERVICE_DELAY_MINS = 5;
// Upper bound on rows sent to the browser.
const MAX_RUN_STOPS = 150;
// A turn-around whose first logged stop sits at this position or later in its
// direction's stop order was joined mid-route (the first stop or two are often
// not logged because the bus is still flagged as a terminal layover there).
const MID_ROUTE_JOIN_MIN_INDEX = 3;
// A step back along the route of at least this many stops starts a new trip. The
// operator's feed often logs neighbouring stops out of order near a terminus (L8:
// Galícia, Euskadi, Poliesportiu Euskadi, Galícia): on 7 days of production samples
// 1,006 of 1,088 backward steps were 1-2 stops, so smaller steps are not a new trip.
const JUMP_BACK_MIN_STOPS = 3;

function fold(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function summarise(segment) {
  if (!segment.length) return { pattern: 'none', stopCount: 0 };
  const delays = segment.map(s => s.delayMins);
  const minDelay = Math.min(...delays);
  const maxDelay = Math.max(...delays);
  const firstDelay = delays[0];
  const lastDelay = delays[delays.length - 1];
  let pattern;
  if (segment.length === 1) pattern = 'isolated';
  else if (minDelay >= SERVICE_DELAY_MINS && maxDelay - minDelay <= SUSTAINED_SPREAD_MINS) pattern = 'sustained';
  else if (lastDelay - firstDelay >= TREND_MINS) pattern = 'building';
  else if (firstDelay - lastDelay >= TREND_MINS) pattern = 'recovering';
  else pattern = 'variable';
  return {
    pattern,
    stopCount: segment.length,
    fromTime: segment[0].time,
    toTime: segment[segment.length - 1].time,
    minDelay,
    maxDelay,
    firstDelay,
    lastDelay,
    direction: segment[0].direction,
    towards: segment[0].towards
  };
}

/**
 * @param {Array<{stopName: string, direction: string, delayMins: number, timestamp: number,
 *   lineCode?: string, formattedDate?: string, isRealTime?: (boolean|number),
 *   scheduledTime?: string, actualTime?: string, timesProvenance?: string}>} rows
 *   One bus's delay samples on one line, any order.
 * @param {object} [options]
 * @param {string} [options.clickedStop]   Stop name (or fragment) the reader clicked.
 * @param {number} [options.clickedFrom]   Start of the clicked episode (epoch ms).
 * @param {number} [options.clickedTo]     End of the clicked episode (epoch ms).
 * @param {function(string, string): string} [options.towards]  (lineCode, direction) -> terminus name.
 * @param {function(string, string, string): ({indexes: number[], lastIndex: number}|null)} [options.stopIndex]
 *   Position of a stop in its direction's published stop order (as in tripRelink.js).
 *   With it, a jump back to an earlier stop in the same direction starts a new trip,
 *   and a new trip that starts far along its route is flagged as joined mid-route.
 * @param {function(string, string): string[]} [options.directionStops]
 *   (lineCode, direction) -> that direction's published stop names, used to name the
 *   stops a mid-route join left out.
 * @param {Array<{lineCode: string, phantomFromTs: number, phantomToTs: number}>} [options.deadheads]
 *   This bus's deadhead returns (findDeadheadReturns). Stop visits inside a phantom
 *   stretch get `phantom: true` and form one group; the visit after it starts a trip.
 * @param {number} [options.showFrom]  Epoch ms. Stop visits that ended before it are left
 *   out, unless they are needed to show where the clicked delay came from. Without it
 *   every visit is shown.
 * @returns {{stops: Array<object>, summary: object, trips: Array<object>, origin: (object|null)}}
 *   stops: { stopName, direction, towards, time ('HH:MM:SS'), firstTs, lastTs, delayMins,
 *   sampleCount, isRealTime, scheduledTime, actualTime, timesProvenance, directionChanged,
 *   newTrip, isClicked, phantom }. newTrip is true on the first visit of a new trip (direction
 *   change or jump back along the route) and on the first visit of a phantom group. trips:
 *   one summary per group, with isDeadhead true for a phantom group. Stops also carry
 *   firstDelay, lastTime, delayGrowth (minutes gained there when it is one of the named
 *   places, else 0) and originStart (the last visit without delay before the clicked one).
 *   origin (see traceDelayOrigin) is null when the clicked visit is not a service delay. summary: the clicked trip's pattern ('sustained' |
 *   'building' | 'recovering' | 'variable' | 'isolated' | 'none') with its stop count, time
 *   range and delays.
 */
function buildIncidentRun(rows, { clickedStop = '', clickedFrom, clickedTo, towards, stopIndex, directionStops, deadheads, showFrom } = {}) {
  const sorted = (Array.isArray(rows) ? rows : [])
    .filter(r => r && Number.isFinite(Number(r.timestamp)) && Number.isFinite(Number(r.delayMins)))
    .slice()
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

  const towardsCache = new Map();
  const terminusOf = (lineCode, direction) => {
    if (typeof towards !== 'function') return '';
    const key = `${lineCode}|${direction}`;
    if (!towardsCache.has(key)) towardsCache.set(key, String(towards(lineCode, direction) || ''));
    return towardsCache.get(key);
  };

  const stops = [];
  for (const r of sorted) {
    const last = stops[stops.length - 1];
    const direction = r.direction === undefined || r.direction === null ? '' : String(r.direction);
    const stopName = String(r.stopName || '');
    const ts = Number(r.timestamp);
    const delay = Number(r.delayMins);
    if (last && last.stopName === stopName && last.direction === direction) {
      last.lastTs = ts;
      last.lastTime = String(r.formattedDate || '').slice(11, 19);
      last.delayMins = delay;
      last.sampleCount++;
      if (r.isRealTime) last.isRealTime = true;
      if (r.scheduledTime) {
        last.scheduledTime = String(r.scheduledTime);
        last.actualTime = String(r.actualTime || '');
        last.timesProvenance = r.timesProvenance || last.timesProvenance;
      }
      continue;
    }
    const directionChanged = Boolean(last && last.direction !== direction);
    let jumpedBack = false;
    if (last && !directionChanged && typeof stopIndex === 'function') {
      const prev = stopIndex(r.lineCode, last.direction, last.stopName);
      const cur = stopIndex(r.lineCode, direction, stopName);
      jumpedBack = Boolean(prev && cur && Math.min(...prev.indexes) - Math.max(...cur.indexes) >= JUMP_BACK_MIN_STOPS);
    }
    stops.push({
      stopName,
      lineCode: String(r.lineCode || ''),
      direction,
      towards: terminusOf(r.lineCode, direction),
      time: String(r.formattedDate || '').slice(11, 19),
      lastTime: String(r.formattedDate || '').slice(11, 19),
      firstTs: ts,
      lastTs: ts,
      firstDelay: delay,
      delayMins: delay,
      sampleCount: 1,
      isRealTime: Boolean(r.isRealTime),
      scheduledTime: String(r.scheduledTime || ''),
      actualTime: String(r.actualTime || ''),
      timesProvenance: r.timesProvenance || 'none',
      directionChanged,
      newTrip: directionChanged || jumpedBack,
      isClicked: false,
      phantom: false,
      delayGrowth: 0,
      originStart: false
    });
  }

  // A deadhead return: everything logged between the last served stop and the
  // restart is one phantom group, and the stop after it starts the next trip.
  // Measured on L8 bus 2669 (29 Sep 2026): Biblioteca Pompeu Fabra re-logged at
  // +49 and Rodalies at +10 read as two one-stop "new trips" within 3 minutes.
  const deadheadList = Array.isArray(deadheads) ? deadheads : [];
  if (deadheadList.length) {
    let group = null;
    for (const s of stops) {
      const code = s.lineCode.toUpperCase();
      const d = deadheadList.find(x => String(x.lineCode || '').toUpperCase() === code
        && s.firstTs >= x.phantomFromTs && s.firstTs <= x.phantomToTs) || null;
      if (d) {
        s.phantom = true;
        s.newTrip = group !== d;
      } else if (group) {
        s.newTrip = true;
      }
      group = d;
    }
  }

  // A new trip that begins far along its route: the bus joined it mid-route (a
  // short-turn), so the stops before it on that trip were not served by this bus.
  // Measured on L2 bus 2679 (29 Sep 2026): +26 at Mataró Parc, then the next trip
  // from Edif. Vidre - TecnoCampus (15th stop) on time; La Llàntia and Cerdanyola
  // went 35-36 min without a bus. Without this the drop read as "recovered 26 min".
  // Only a turn-around counts (the bus changed direction and then stayed on the new
  // trip for at least two stops): a same-direction jump back or a single stray
  // sample is too weak to say a trip was joined mid-route.
  if (typeof stopIndex === 'function') {
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      if (!s.directionChanged || !stops[i + 1] || stops[i + 1].newTrip) continue;
      // After a deadhead return the restart is explained by the phantom group.
      if (s.phantom || (i > 0 && stops[i - 1].phantom)) continue;
      const pos = stopIndex(s.lineCode, s.direction, s.stopName);
      const first = pos ? Math.min(...pos.indexes) : 0;
      if (first < MID_ROUTE_JOIN_MIN_INDEX) continue;
      const names = typeof directionStops === 'function' ? (directionStops(s.lineCode, s.direction) || []) : [];
      s.joinedMidRoute = { skippedCount: first, firstSkipped: String(names[0] || ''), lastSkipped: String(names[first - 1] || '') };
    }
  }

  const wanted = fold(clickedStop);
  const from = Number(clickedFrom);
  const to = Number(clickedTo);
  let clickedIdx = -1;
  if (Number.isFinite(from) && Number.isFinite(to)) {
    stops.forEach((s, i) => {
      if (s.firstTs <= to && s.lastTs >= from && (!wanted || fold(s.stopName).includes(wanted))) {
        s.isClicked = true;
        if (clickedIdx < 0) clickedIdx = i;
      }
    });
  }

  // The summary describes the clicked trip only: a new trip (direction change or
  // jump back along the route) says nothing about the one the reader asked about.
  // Measured on L8 bus 2669 (29 Sep 2026): after Euskadi +26 the feed jumped back
  // to Biblioteca Pompeu Fabra at +49; counting it turned a steady +23..+27 trip
  // into "delay growing from +24 to +49".
  let segStart = 0;
  let segEnd = stops.length - 1;
  if (clickedIdx >= 0) {
    segStart = clickedIdx;
    while (segStart > 0 && !stops[segStart].newTrip) segStart--;
    segEnd = clickedIdx;
    while (segEnd + 1 < stops.length && !stops[segEnd + 1].newTrip) segEnd++;
  }
  const summary = summarise(stops.slice(segStart, segEnd + 1));
  const origin = traceDelayOrigin(stops, clickedIdx, segStart);

  // Show from showFrom, reaching further back when the delay began earlier.
  let first = 0;
  const showFromTs = Number(showFrom);
  if (showFrom !== undefined && showFrom !== null && Number.isFinite(showFromTs)) {
    first = stops.findIndex(s => s.lastTs >= showFromTs);
    if (first < 0) first = stops.length;
    if (clickedIdx >= 0) first = Math.min(first, clickedIdx);
    if (origin) first = Math.min(first, origin.fromIndex);
  }
  let shown = stops.slice(first);
  // Keep the clicked stop in view when the run is longer than the cap, starting
  // where the delay began when that still leaves room after the clicked stop.
  if (shown.length > MAX_RUN_STOPS) {
    const centre = clickedIdx >= 0 ? clickedIdx - first : 0;
    const preferred = origin ? origin.fromIndex - first : centre - Math.floor(MAX_RUN_STOPS / 2);
    const begin = Math.max(0, Math.min(shown.length - MAX_RUN_STOPS, Math.max(preferred, centre - (MAX_RUN_STOPS - 20))));
    shown = shown.slice(begin, begin + MAX_RUN_STOPS);
  }

  // One entry per trip in the shown run, for the panel's group headers.
  const trips = [];
  shown.forEach((s, i) => {
    if (i === 0 || s.newTrip) trips.push({ startIndex: i, endIndex: i });
    else trips[trips.length - 1].endIndex = i;
  });
  const tripSummaries = trips.map(t => {
    const segment = shown.slice(t.startIndex, t.endIndex + 1);
    return {
      ...summarise(segment),
      startIndex: t.startIndex,
      endIndex: t.endIndex,
      joinedMidRoute: segment[0].joinedMidRoute || null,
      isDeadhead: segment[0].phantom,
      isClickedTrip: segment.some(v => v.isClicked)
    };
  });
  if (origin) delete origin.fromIndex;
  return { stops: shown, summary, trips: tripSummaries, origin };
}

/**
 * Where the clicked delay came from: walk back from the clicked stop visit to the
 * last visit whose delay was LATE_LIMIT_MIN or less (the platform's "not late"),
 * and name the places in between where the delay grew by ORIGIN_GROWTH_MINS or
 * more (the MAX_ORIGIN_EVENTS largest, in time order). A rise is measured from the
 * previous visit on the same trip; at a new trip, from the previous trip's last
 * visit (a late departure after turning). Phantom visits (deadhead returns) are
 * skipped and break the chain across them. Marks originStart and delayGrowth on
 * the stop objects.
 *
 * @returns {null|{onTime: (null|{stopName, towards, time, delayMins}), since: {time, delayMins},
 *   tripsBefore: number, events: Array<{kind: ('at_stop'|'between'|'turn'), stopName, previousStop,
 *   fromTime, toTime, fromDelay, toDelay, growth}>, fromIndex: number}}
 */
function traceDelayOrigin(stops, clickedIdx, clickedTripStart) {
  if (clickedIdx < 0) return null;
  const clicked = stops[clickedIdx];
  if (clicked.phantom || clicked.delayMins < SERVICE_DELAY_MINS) return null;
  let onTimeIdx = -1;
  for (let i = clickedIdx - 1; i >= 0; i--) {
    const s = stops[i];
    if (s.phantom) continue;
    if (Math.min(s.firstDelay, s.delayMins) <= LATE_LIMIT_MIN) { onTimeIdx = i; break; }
  }
  let from = onTimeIdx;
  if (from < 0) from = stops.findIndex(s => !s.phantom);
  if (from < 0 || from > clickedIdx) return null;

  const events = [];
  let prev = null;
  let tripsBefore = 0;
  for (let i = from; i <= clickedIdx; i++) {
    const s = stops[i];
    if (s.phantom) { prev = null; continue; }
    if (i > from && s.newTrip && i <= clickedTripStart) tripsBefore++;
    let kind;
    let startDelay;
    if (!prev) {
      kind = 'at_stop';
      startDelay = s.firstDelay;
    } else if (s.newTrip) {
      kind = 'turn';
      startDelay = prev.delayMins;
    } else {
      startDelay = prev.delayMins;
      kind = (s.delayMins - s.firstDelay) * 2 >= s.delayMins - startDelay ? 'at_stop' : 'between';
    }
    const growth = s.delayMins - startDelay;
    if (growth >= ORIGIN_GROWTH_MINS) {
      const atStop = kind === 'at_stop';
      events.push({
        index: i,
        kind,
        stopName: s.stopName,
        previousStop: prev ? prev.stopName : '',
        fromTime: atStop ? s.time : prev.lastTime,
        toTime: s.lastTime,
        fromDelay: atStop ? s.firstDelay : prev.delayMins,
        toDelay: s.delayMins,
        growth
      });
    }
    prev = s;
  }
  const named = events.slice().sort((a, b) => b.growth - a.growth || a.index - b.index)
    .slice(0, MAX_ORIGIN_EVENTS).sort((a, b) => a.index - b.index);
  for (const e of named) stops[e.index].delayGrowth = e.growth;
  if (onTimeIdx >= 0) stops[onTimeIdx].originStart = true;
  const start = stops[from];
  return {
    onTime: onTimeIdx >= 0
      ? { stopName: start.stopName, towards: start.towards, time: start.time, delayMins: Math.min(start.firstDelay, start.delayMins) }
      : null,
    since: { time: start.time, delayMins: start.firstDelay },
    tripsBefore,
    events: named.map(({ index, ...e }) => e),
    fromIndex: from
  };
}

module.exports = {
  buildIncidentRun,
  RUN_CONTEXT_MS,
  RUN_LOOKBACK_MS,
  ORIGIN_GROWTH_MINS,
  MAX_ORIGIN_EVENTS,
  SUSTAINED_SPREAD_MINS,
  TREND_MINS,
  SERVICE_DELAY_MINS,
  MAX_RUN_STOPS,
  MID_ROUTE_JOIN_MIN_INDEX,
  JUMP_BACK_MIN_STOPS
};
