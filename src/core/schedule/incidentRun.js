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
 * Pure module: no database, no clock. Timestamps are epoch ms.
 */

// How much of the bus's run to show on each side of the clicked episode.
const RUN_CONTEXT_MS = 30 * 60 * 1000;
// A delay that stays within this spread over the whole direction is "sustained".
const SUSTAINED_SPREAD_MINS = 5;
// A first-to-last change of at least this much is "building" or "recovering".
const TREND_MINS = 5;
// Below this a delay is ordinary service (same threshold as the incident lists).
const SERVICE_DELAY_MINS = 5;
// Upper bound on rows sent to the browser.
const MAX_RUN_STOPS = 150;

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
 *   With it, a jump back to an earlier stop in the same direction starts a new trip.
 * @returns {{stops: Array<object>, summary: object}}
 *   stops: { stopName, direction, towards, time ('HH:MM:SS'), firstTs, lastTs, delayMins,
 *   sampleCount, isRealTime, scheduledTime, actualTime, timesProvenance, directionChanged,
 *   newTrip, isClicked }. newTrip is true on the first visit of a new trip (direction change
 *   or jump back along the route). summary: the clicked trip's pattern ('sustained' |
 *   'building' | 'recovering' | 'variable' | 'isolated' | 'none') with its stop count, time
 *   range and delays.
 */
function buildIncidentRun(rows, { clickedStop = '', clickedFrom, clickedTo, towards, stopIndex } = {}) {
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
      jumpedBack = Boolean(prev && cur && Math.max(...cur.indexes) < Math.min(...prev.indexes));
    }
    stops.push({
      stopName,
      direction,
      towards: terminusOf(r.lineCode, direction),
      time: String(r.formattedDate || '').slice(11, 19),
      firstTs: ts,
      lastTs: ts,
      delayMins: delay,
      sampleCount: 1,
      isRealTime: Boolean(r.isRealTime),
      scheduledTime: String(r.scheduledTime || ''),
      actualTime: String(r.actualTime || ''),
      timesProvenance: r.timesProvenance || 'none',
      directionChanged,
      newTrip: directionChanged || jumpedBack,
      isClicked: false
    });
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

  // Keep the clicked stop in view when the run is longer than the cap.
  let shown = stops;
  if (stops.length > MAX_RUN_STOPS) {
    const centre = clickedIdx >= 0 ? clickedIdx : 0;
    const begin = Math.max(0, Math.min(stops.length - MAX_RUN_STOPS, centre - Math.floor(MAX_RUN_STOPS / 2)));
    shown = stops.slice(begin, begin + MAX_RUN_STOPS);
  }
  return { stops: shown, summary };
}

module.exports = {
  buildIncidentRun,
  RUN_CONTEXT_MS,
  SUSTAINED_SPREAD_MINS,
  TREND_MINS,
  SERVICE_DELAY_MINS,
  MAX_RUN_STOPS
};
