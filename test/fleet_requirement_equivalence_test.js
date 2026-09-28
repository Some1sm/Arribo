'use strict';
const assert = require('node:assert/strict');
const S = require('../src/data/mataroSchedules');

// Frozen copy of the pre-optimisation algorithm. The optimised function must
// return exactly the same number for every input below.
function reference(lineId, dayType, nowSec = null, season) {
  const normLine = S.normalizeLineId(lineId);
  const normDay = S.normalizeDayType(dayType);
  const s0 = S.getDirectionSchedule(normLine, '0', normDay, season);
  const s1 = S.getDirectionSchedule(normLine, '1', normDay, season);
  if (!s0 || !s1 || !Array.isArray(s0.departures) || !Array.isArray(s1.departures)) return 1;
  if (s0.departures.length === 0 && s1.departures.length === 0) return 0;
  const t0 = s0.totalTravelSec || (s0.totalTravelMinutes * 60) || 1800;
  const t1 = s1.totalTravelSec || (s1.totalTravelMinutes * 60) || 1800;
  if (nowSec !== null) {
    const all = [...s0.departures.map(d => S.timeStringToSec(d)), ...s1.departures.map(d => S.timeStringToSec(d))].sort((a, b) => a - b);
    if (all.length === 0) return 0;
    const first = Math.max(0, all[0] - 1200);
    const last = all[all.length - 1] + Math.max(t0, t1);
    if (nowSec < first || nowSec > last) return 0;
  }
  const trips = [];
  s0.departures.forEach(d => { const s = S.timeStringToSec(d); trips.push({ start: s, end: s + t0 + 60 }); });
  s1.departures.forEach(d => { const s = S.timeStringToSec(d); trips.push({ start: s, end: s + t1 + 60 }); });
  if (trips.length === 0) return 0;
  const winStart = nowSec !== null ? nowSec : 0;
  const winEnd = nowSec !== null ? Math.min(86400, nowSec + 3600) : 86400;
  let max = 0;
  for (let s = winStart; s <= winEnd; s += 30) {
    const c = trips.filter(t => s >= t.start && s < t.end).length;
    if (c > max) max = c;
  }
  return nowSec !== null ? max : Math.max(1, max);
}

let checked = 0;
for (const season of ['winter', 'summer']) {
  for (let line = 1; line <= 8; line++) {
    for (const day of ['weekday', 'saturday', 'sunday']) {
      const points = [null];
      for (let sec = 0; sec <= 86400; sec += 120) points.push(sec);
      for (const nowSec of points) {
        const expected = reference(String(line), day, nowSec, season);
        const actual = S.getScheduledFleetRequirement(String(line), day, nowSec, season);
        assert.strictEqual(actual, expected, `L${line} ${day} ${season} nowSec=${nowSec}: expected ${expected}, got ${actual}`);
        checked++;
      }
    }
  }
}
let t = Date.now();
for (let i = 0; i < 2000; i++) S.getScheduledFleetRequirement('1', 'weekday', 13 * 3600);
const optimisedMs = Date.now() - t;
t = Date.now();
for (let i = 0; i < 2000; i++) reference('1', 'weekday', 13 * 3600);
const referenceMs = Date.now() - t;
console.log(`checked ${checked} inputs; 2000 calls: optimised ${optimisedMs} ms, reference ${referenceMs} ms`);
console.log('✅ FLEET REQUIREMENT EQUIVALENCE TEST PASSED');
