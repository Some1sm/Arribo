'use strict';
// Differential-test case generator. Runs the JavaScript implementation on
// random inputs and writes one JSON line per case: {fn, args, out}, where out
// is the JSON.stringify of the result (or a String() for scalars that JSON
// cannot carry, like NaN). The Go `difftest` subcommand replays every case
// and compares byte-for-byte.
//
// Usage: TZ=Europe/Madrid node difftest/gen.js <repoRoot> <casesPerFn> [seed] > cases.jsonl

const path = require('path');
const root = path.resolve(process.argv[2] || '.');
const N = Number(process.argv[3] || 200);
let seed = Number(process.argv[4] || 12345) >>> 0;

function rand() { // mulberry32
  seed = (seed + 0x6D2B79F5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ri = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const req = (p) => require(path.join(root, p));
const timeEngine = req('src/core/time/timeEngine');
const calendarEngine = req('src/core/time/calendarEngine');
const holidays = req('src/core/time/holidayCalendar');
const seasons = req('src/data/seasonCalendar');
const sched = req('src/data/mataroSchedules');
const fleet = req('src/data/mataroFleet');
const geo = req('src/core/geo/geoEngine');
const gapClusters = req('src/core/geo/gapClusters');
const gapPathMod = req('src/core/geo/gapPath');
const { GpsGapDetector } = req('src/core/geo/gpsGapDetector');
const gapBuses = req('src/core/geo/gapBuses');
const tripMatcher = req('src/core/schedule/tripMatcher');
const delayEngine = req('src/core/schedule/delayEngine');
const serviceHours = req('src/core/schedule/serviceHours');

const out = [];
function emit(fn, args, result) {
  let s;
  if (typeof result === 'number' && !Number.isFinite(result)) s = 'NUM:' + String(result);
  else if (result === undefined) s = 'undefined';
  else s = JSON.stringify(result);
  // Arguments keep what JSON cannot carry: undefined, NaN, +-Infinity, -0.
  const enc = JSON.stringify(args, function (k, v) {
    if (v === undefined) return '__undef';
    if (typeof v === 'number' && (!Number.isFinite(v) || Object.is(v, -0))) return '__num:' + (Object.is(v, -0) ? '-0' : String(v));
    return v;
  });
  out.push(`{"fn":${JSON.stringify(fn)},"args":${enc},"out":${JSON.stringify(s)}}`);
}
function run(fn, args, f) {
  let r;
  try { r = f(); } catch (e) { r = { __throw: String(e && e.message) }; }
  emit(fn, args, r);
}

// ---------------------------------------------------------------- inputs
function lastSunday(y, m) { const d = new Date(Date.UTC(y, m + 1, 0)); return d.getUTCDate() - d.getUTCDay(); }
function rTs() {
  const r = rand();
  const y = pick([2025, 2026, 2026, 2026, 2027, 2028]);
  if (r < 0.25) { // around a DST switch (01:00 UTC on the last Sunday of March/October)
    const m = pick([2, 9]);
    return Date.UTC(y, m, lastSunday(y, m), 1, 0, 0) + ri(-3 * 3600, 3 * 3600) * 1000 + ri(0, 999);
  }
  if (r < 0.45) { // around Madrid midnight
    const m = ri(0, 11), d = ri(1, 28);
    return Date.UTC(y, m, d, pick([21, 22, 23]), 0, 0) + ri(-120, 3600 + 120) * 1000 + ri(0, 999);
  }
  if (r < 0.55) { // inside or at the edges of the 2026 summer window
    return Date.UTC(2026, pick([6, 7]), pick([25, 26, 27, 28, 22, 23, 24, 10]), ri(0, 23), ri(0, 59), ri(0, 59));
  }
  if (r < 0.65) { // holidays (fixed dates) +- a day
    const md = pick([[0, 1], [0, 6], [4, 1], [5, 24], [6, 27], [7, 15], [8, 11], [9, 12], [10, 1], [11, 6], [11, 8], [11, 25], [11, 26], [3, 3], [3, 6]]);
    return Date.UTC(y, md[0], md[1] + ri(-1, 1), ri(0, 23), ri(0, 59), ri(0, 59));
  }
  return Date.UTC(2025, 0, 1) + Math.floor(rand() * (4 * 365 * 86400 * 1000));
}
function rTimeStr() {
  const r = rand();
  if (r < 0.5) return `${String(ri(0, 23)).padStart(2, '0')}:${String(ri(0, 59)).padStart(2, '0')}`;
  if (r < 0.7) return `${String(ri(0, 27)).padStart(2, '0')}:${String(ri(0, 59)).padStart(2, '0')}:${String(ri(0, 59)).padStart(2, '0')}`;
  return pick(['', 'abc', '7:5', ' 08:00', '08:00 ', '8:00', '24:00', '25:61', '08:', ':30', '08:00:00.5', '1e1:00', '0x10:00', '08:30:xx', '-1:30', '12', '12:30:40:50', ' 12:00', 'Infinity:00', '08 :30']);
}
function rNum() {
  const r = rand();
  if (r < 0.2) return ri(-100000, 100000);
  if (r < 0.4) return (rand() - 0.5) * Math.pow(10, ri(-8, 22));
  if (r < 0.55) return ri(-2000, 2000) / pick([2, 4, 8, 10, 100, 1000, 3, 7]);
  if (r < 0.65) return pick([0, -0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 1e21, 1e-7, 123e-20, 0.1, 0.3, 1.005, 2.675, 1.45, 8.345, -8.345, 4.35, 1e15, 9007199254740993, 5e-324, 1.7976931348623157e308]);
  return Math.random() < 2 ? rand() * Math.pow(10, ri(-3, 9)) * (rand() < 0.3 ? -1 : 1) : 0;
}
function rNumStr() {
  const r = rand();
  if (r < 0.5) return String(rNum());
  return pick(['', ' ', '  12  ', '12px', 'px12', '0x1A', '0X1a', '0b101', '0o17', '-0x10', '+12', '-12.5e3', '.5', '5.', '1e', 'e5', 'Infinity', '-Infinity', 'infinity', 'NaN', '1_000', ' 7 ', '\t\n42\r', '12.34.56', '00012', '-0', '+-1', '1e400', '١٢', '0x', '3,5', '1n', '9007199254740993', '.e1', '0.0000001']);
}
function rCoord() { return [41.53 + rand() * 0.03, 2.42 + rand() * 0.04]; }
function rPoly(n) {
  const pts = [];
  let [la, lo] = rCoord();
  for (let i = 0; i < n; i++) {
    pts.push([la, lo]);
    la += (rand() - 0.5) * 0.004;
    lo += (rand() - 0.5) * 0.004;
    if (rand() < 0.05 && pts.length) { pts.push([la, lo]); } // duplicate vertex
  }
  return pts;
}
const lineIds = ['1', '2', '3', '4', '5', '6', '7', '8', 'L1', 'l3', ' 5', '9', '', 'X', '01'];
const dayTypes = ['weekday', 'saturday', 'sunday', 'Feiners', 'Dissabtes', 'Diumenges', 'holiday', 'festius', 'WEEKDAY', '', 'bogus'];
const seasonsArg = [undefined, null, 'winter', 'summer', 'hivern', 'estiu', 'bogus'];
const dirs = ['0', '1', 0, 1, 'IDA', 'VUELTA', 'A', 'B', '2', '', undefined, null];

function allStops() {
  const ids = new Set(); const names = new Set();
  for (const l of ['1', '2', '3', '4', '5', '6', '7', '8']) {
    for (const d of ['0', '1']) {
      for (const dt of ['weekday', 'saturday', 'sunday']) {
        const ds = sched.getDirectionSchedule(l, d, dt);
        if (!ds) continue;
        for (const s of ds.stops) { ids.add(String(s.id)); if (s.name) names.add(s.name); }
      }
    }
  }
  return { ids: [...ids], names: [...names] };
}
const { ids: stopIds, names: stopNames } = allStops();

// ---------------------------------------------------------------- JS builtins
for (let i = 0; i < N * 5; i++) { const x = rNum(); run('String', [x], () => String(x)); }
for (let i = 0; i < N * 5; i++) {
  const x = rand() < 0.5 ? rNum() : ri(-100000, 100000) / pick([8, 16, 1000, 200, 40]);
  const d = ri(0, 6);
  run('toFixed', [x, d], () => x.toFixed(d));
}
for (let i = 0; i < N * 3; i++) { const x = rand() < 0.5 ? rNum() : ri(-4000, 4000) / 2; run('Math.round', [x], () => Math.round(x)); }
for (let i = 0; i < N * 3; i++) { const s = rNumStr(); run('Number', [s], () => String(Number(s))); }
for (let i = 0; i < N * 3; i++) { const s = rNumStr(); run('parseFloat', [s], () => String(parseFloat(s))); }
for (let i = 0; i < N * 3; i++) { const s = rNumStr(); run('parseInt', [s], () => String(parseInt(s, 10))); }
for (let i = 0; i < N * 2; i++) {
  let s = '';
  const n = ri(0, 12);
  for (let k = 0; k < n; k++) s += String.fromCodePoint(pick([ri(0, 0x1f), ri(0x20, 0x7e), 0x7f, 0x80, 0xa0, 0x2028, 0x2029, ri(0x100, 0xd7ff), ri(0xe000, 0xfffd), ri(0x10000, 0x1f9ff), 0x22, 0x5c, 0x3c, 0x26]));
  run('JSON.stringify', [s], () => s);
}
// transcendental functions on the inputs geo code feeds them
for (let i = 0; i < N * 10; i++) {
  const x = rand() < 0.5 ? (rand() - 0.5) * 2 * Math.PI : (rand() - 0.5) * 0.002;
  run('Math.sin', [x], () => Math.sin(x));
  run('Math.cos', [x], () => Math.cos(x));
  const y = (rand() - 0.5) * pick([2, 0.001, 1e-6]); const z = (rand() - 0.5) * pick([2, 0.001, 1e-6]);
  run('Math.atan2', [y, z], () => Math.atan2(y, z));
  const a = rand(); run('Math.atan2s', [a], () => Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  run('Math.sqrt', [a], () => Math.sqrt(a));
  const e = -rand() * pick([1, 10, 50]); run('Math.exp', [e], () => Math.exp(e));
  // The code only uses x ** 2 and Math.pow(2, k).
  const b = (rand() - 0.5) * pick([2, 1e-3, 1e5]); run('Math.pow', [b, 2], () => b ** 2);
  const k = ri(0, 40); run('Math.pow', [2, k], () => Math.pow(2, k));
}

// ---------------------------------------------------------------- timeEngine
for (let i = 0; i < N; i++) {
  const s = rTimeStr();
  run('timeStringToMinutes', [s], () => timeEngine.timeStringToMinutes(s));
  run('timeStringToSeconds', [s], () => timeEngine.timeStringToSeconds(s));
  run('timeStringToSec', [s], () => sched.timeStringToSec(s));
  const m = rand() < 0.7 ? ri(-200, 3000) : rNum();
  run('minutesToTimeString', [m], () => timeEngine.minutesToTimeString(m));
  const sec = rand() < 0.7 ? ri(-2000, 200000) : rNum();
  run('secondsToTimeString', [sec], () => timeEngine.secondsToTimeString(sec));
}
for (let i = 0; i < N * 3; i++) {
  const ts = rTs();
  run('getNetworkTime', [ts], () => { const r = timeEngine.getNetworkTime('Europe/Madrid', new Date(ts)); delete r.rawDate; return r; });
  run('formatTimeToTimezone', [ts], () => timeEngine.formatTimeToTimezone(new Date(ts)));
  run('getDateComponents', [ts], () => calendarEngine.getDateComponents(new Date(ts)));
  run('getServiceCalendarInfo', [ts], () => calendarEngine.getServiceCalendarInfo(new Date(ts)));
  run('isHoliday', [ts], () => holidays.isHoliday(new Date(ts)));
  run('isHolidayKnown', [ts], () => holidays.isHolidayKnown(new Date(ts)));
  run('holidayInfo', [ts], () => holidays.holidayInfo(new Date(ts)));
  run('getHolidayCoverage', [ts], () => holidays.getHolidayCoverage(new Date(ts)));
  run('getServiceOverride', [ts], () => holidays.getServiceOverride(new Date(ts)));
  run('madridDate', [ts], () => holidays.madridDate(new Date(ts)));
  run('resolveSeason', [ts], () => seasons.resolveSeason(new Date(ts)));
  run('getSeasonOutlook', [ts], () => seasons.getSeasonOutlook(new Date(ts)));
  run('resolveDayType', [ts], () => { const r = tripMatcher.resolveDayType(new Date(ts)); return r; });
}
for (let i = 0; i < N * 2; i++) {
  const y = pick([2025, 2026, 2027]);
  const mon = ri(0, 11), d = ri(1, 31), h = rand() < 0.3 ? pick([1, 2, 3]) : ri(0, 23), mi = ri(0, 59), s = ri(0, 59);
  const ys = rand() < 0.4 ? [y, pick([2, 9]), lastSunday(y, pick([2, 9])), h, mi, s] : [y, mon, d, h, mi, s];
  if (rand() < 0.5) { ys[1] = pick([2, 9]); ys[2] = lastSunday(ys[0], ys[1]); ys[3] = pick([1, 2, 3, 0, 4]); }
  run('localTimeToUtcDate', ys, () => timeEngine.localTimeToUtcDate(...ys).getTime());
}
for (let y = 2024; y <= 2032; y++) run('easterSunday', [y], () => holidays.easterSunday(y));
for (let y = 2025; y <= 2028; y++) run('holidaysForYear', [y], () => [...holidays.holidaysForYear(y)].sort());

// ---------------------------------------------------------------- schedules
for (const l of lineIds) run('normalizeLineId', [l], () => sched.normalizeLineId(l));
for (const d of dayTypes) { run('normalizeDayType', [d], () => sched.normalizeDayType(d)); run('toCatalanDayType', [d], () => sched.toCatalanDayType(d)); }
for (const s of seasonsArg) run('normalizeSeason', [s === undefined ? '__undef' : s], () => sched.normalizeSeason(s));
run('getScheduleValidity', [], () => sched.getScheduleValidity());
for (const s of seasonsArg) run('getAllLines', [s === undefined ? '__undef' : s], () => sched.getAllLines(s));
for (let i = 0; i < N; i++) {
  const l = pick(lineIds), d = pick(dirs), dt = pick(dayTypes), se = pick(seasonsArg);
  const A = [l, d === undefined ? '__undef' : d, dt, se === undefined ? '__undef' : se];
  run('getDirectionSchedule', A, () => sched.getDirectionSchedule(l, d, dt, se));
  run('isDirectionUsable', [l, A[1], A[3]], () => sched.isDirectionUsable(l, d, se));
  const stop = rand() < 0.8 ? pick(stopIds) : pick(['', '0', 'x', '99999']);
  run('getTripsServingStop', [l, A[1], stop, dt, A[3]], () => sched.getTripsServingStop(l, d, stop, dt, se));
  run('getStopTravelTime', [l, A[1], stop, dt, A[3]], () => sched.getStopTravelTime(l, d, stop, dt, se));
  run('hasStopInSchedule', [l, A[1], stop, dt, A[3]], () => sched.hasStopInSchedule(l, d, stop, dt, se));
  run('getDeparturesForStop', [l, A[1], stop, dt, A[3]], () => sched.getDeparturesForStop(l, d, stop, dt, se));
  const ds = sched.getDirectionSchedule(l, d, dt, se);
  const dep = ds && ds.departures.length && rand() < 0.8 ? pick(ds.departures) : rTimeStr();
  run('getTripStopTime', [l, A[1], dep, stop, dt, A[3]], () => sched.getTripStopTime(l, d, dep, stop, dt, se));
  const nowSec = rand() < 0.2 ? '__undef' : ri(0, 90000);
  run('getScheduledFleetRequirement', [l, dt, nowSec, A[3]], () => sched.getScheduledFleetRequirement(l, dt, nowSec === '__undef' ? undefined : nowSec, se));
  run('getServiceWindow', [l, dt, A[3]], () => sched.getServiceWindow(l, dt, se === undefined ? null : se));
}
for (let i = 0; i < N; i++) {
  const v = pick([String(ri(2600, 2700)), ri(2600, 2700), ' 2668 ', '2687', '2668A', 'X12', '', null, undefined, '0002670', 'bus-2675', '2670.0', 2670.5]);
  run('getVehicleFleetInfo', [v === undefined ? '__undef' : v], () => fleet.getVehicleFleetInfo(v));
  run('normalizeVehicleId', [v === undefined ? '__undef' : v], () => fleet.normalizeVehicleId(v));
}

// ---------------------------------------------------------------- geo
for (let i = 0; i < N * 3; i++) {
  const [a, b] = rCoord(), [c, d] = rand() < 0.1 ? [a, b] : rCoord();
  run('calculateDistanceMeters', [a, b, c, d], () => geo.calculateDistanceMeters(a, b, c, d));
  run('calculateBearing', [a, b, c, d], () => geo.calculateBearing(a, b, c, d));
  run('gapDistanceM', [a, b, c, d], () => gapClusters.distanceM(a, b, c, d));
  const f = rand() < 0.2 ? pick([-1, 2, 0, 1, NaN]) : rand();
  run('interpolateCoordinate', [a, b, c, d, f], () => geo.interpolateCoordinate(a, b, c, d, f));
  const bb = rand() < 0.2 ? pick([-10, 360, 361, 359.9, 22.5, 337.5, NaN]) : rand() * 360;
  run('getCompassDirection', [bb], () => geo.getCompassDirection(bb));
}
for (let i = 0; i < N; i++) {
  const poly = rPoly(ri(0, 25));
  const objPoly = rand() < 0.3 ? poly.map(([la, lo]) => ({ lat: la, lon: lo })) : poly;
  const [a, b] = rand() < 0.5 && poly.length ? [poly[0][0] + (rand() - 0.5) * 0.002, poly[0][1] + (rand() - 0.5) * 0.002] : rCoord();
  const [c, d] = rCoord();
  run('snapPointToPolyline', [a, b, objPoly], () => geo.snapPointToPolyline(a, b, objPoly));
  run('calculatePolylineDistanceBetween', [objPoly, a, b, c, d], () => geo.calculatePolylineDistanceBetween(objPoly, a, b, c, d));
  run('calculateRouteTotalDistance', [objPoly], () => geo.calculateRouteTotalDistance(objPoly));
  const pos = rand() < 0.5 ? { lat: a, lon: b, bearing: rand() < 0.5 ? ri(0, 359) : undefined } : [a, b];
  const el = rand() < 0.1 ? pick([-5, 0, NaN]) : ri(0, 600);
  const sp = rand() < 0.2 ? pick([0, NaN, 2, '40', undefined]) : ri(5, 60);
  run('extrapolatePolylinePosition', [pos, el, sp === undefined ? '__undef' : sp, objPoly], () => geo.extrapolatePolylinePosition(pos, el, sp, objPoly));
  const table = geo.buildPolylineDistanceTable(poly);
  run('buildPolylineDistanceTable', [poly], () => table);
  const dist = rand() < 0.2 ? pick([-10, 0, 1e9]) : rand() * (table.total || 100);
  run('pointAtDistance', [poly, dist], () => geo.pointAtDistance(poly, table, dist));
  const stops = []; for (let k = ri(0, 6); k > 0; k--) { const [sl, so] = poly.length && rand() < 0.7 ? [pick(poly)[0] + (rand() - 0.5) * 0.003, pick(poly)[1] + (rand() - 0.5) * 0.003] : rCoord(); stops.push({ lat: sl, lon: so }); }
  const opts = rand() < 0.5 ? {} : { thresholdM: ri(20, 200), maxSpliceM: ri(100, 600) };
  run('composeRouteWithStops', [poly, stops, opts], () => geo.composeRouteWithStops(poly, stops, opts));
  const lost = { lat: a, lon: b }, reg = { lat: c, lon: d };
  if (poly.length >= 2 && rand() < 0.7) { const p1 = pick(poly), p2 = pick(poly); lost.lat = p1[0] + (rand() - 0.5) * 0.0005; lost.lon = p1[1]; reg.lat = p2[0]; reg.lon = p2[1] + (rand() - 0.5) * 0.0005; }
  const gs = ri(60, 1200);
  const routeObjs = rand() < 0.5 ? poly.map(([la, lo]) => ({ Latitude: la, Longitude: lo })) : poly.map(([la, lo]) => ({ lat: la, lon: lo }));
  run('gapPath', [routeObjs, lost, reg, gs], () => gapPathMod.gapPath(routeObjs, lost, reg, gs));
}
// polyline encoding round trip from random points
function encode(points) {
  let lastLat = 0, lastLng = 0, s = '';
  const enc = (v) => { v = v < 0 ? ~(v << 1) : v << 1; let r = ''; while (v >= 0x20) { r += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return r + String.fromCharCode(v + 63); };
  for (const [la, lo] of points) { const a = Math.round(la * 1e5), b = Math.round(lo * 1e5); s += enc(a - lastLat) + enc(b - lastLng); lastLat = a; lastLng = b; }
  return s;
}
for (let i = 0; i < N; i++) {
  let s;
  if (rand() < 0.7) s = encode(rPoly(ri(0, 20)));
  else if (rand() < 0.5) { s = ''; for (let k = ri(1, 40); k > 0; k--) s += String.fromCharCode(pick([ri(32, 126), ri(95, 126), 0xe9, 0x1f600])); }
  else s = pick(['', '?', '_p~iF~ps|U_ulLnnqC_mqNvxq`@', '~', 'abc', '~~~~~~~~~~~~~~~~', '\u{1F600}x', '!!!!']);
  run('decodePolyline', [s], () => geo.decodePolyline(s));
}
for (let i = 0; i < N / 2; i++) {
  const pts = []; for (let k = ri(0, 30); k > 0; k--) { const [la, lo] = rand() < 0.1 ? [NaN, 1] : [41.54 + (rand() - 0.5) * 0.004, 2.44 + (rand() - 0.5) * 0.004]; pts.push({ lat: la, lon: lo, id: k }); }
  const rad = rand() < 0.5 ? undefined : ri(20, 200);
  run('clusterPoints', [pts, rad === undefined ? '__undef' : rad], () => gapClusters.clusterPoints(pts, rad));
}
for (let i = 0; i < N / 4; i++) {
  const det = new GpsGapDetector();
  const vehicles = ['2670', '2671', '2680', 'X', ''];
  const seq = []; let t = Date.UTC(2026, 10, 10, 8, 0, 0);
  for (let k = 0; k < 60; k++) {
    t += ri(1, 400) * 1000;
    const [la, lo] = rCoord();
    seq.push({ vehicleId: pick(vehicles), lineCode: pick(['L1', 'L2', '', 'L1']), direction: pick([0, 1, '0', null, undefined]), lat: rand() < 0.05 ? 'x' : la, lon: lo, observedAt: rand() < 0.05 ? t - 1e6 : t, isTerminalLayover: rand() < 0.2, toStop: pick(['Pl. Santa Anna', '', undefined, 'Hospital']) });
  }
  run('GpsGapDetector', [seq], () => seq.map((b) => det.observe(b)));
}
for (let i = 0; i < N / 2; i++) {
  const n = ri(0, 40), lam = rand() < 0.1 ? pick([0, -1, NaN]) : rand() * 20;
  run('poissonTail', [n, lam], () => gapBuses.poissonTail(n, lam));
  const gaps = [], visits = [];
  const vs = ['2670', '2671', '2672', '2673', 'X', ''];
  for (let k = ri(0, 30); k > 0; k--) gaps.push({ id: k, vehicleId: pick(vs), lineCode: pick(['L1', 'L2', 'L3']), gapSec: ri(90, 900), shared: rand() < 0.3 });
  for (let k = ri(0, 20); k > 0; k--) visits.push({ vehicleId: pick(vs), lineCode: pick(['L1', 'L2', 'L3']), n: ri(-1, 300) });
  run('rankBuses', [gaps, visits], () => gapBuses.rankBuses(gaps, visits));
}

// ---------------------------------------------------------------- schedule logic
for (let i = 0; i < N; i++) {
  const s = rand() < 0.7 ? pick(stopNames) + pick(['', ' - 1234', ' -12345', '  ', '.']) : pick(['', 'Àvinguda d\'Ernest Lluch (Pg.)', 'CAMÍ RAL · LA RIERA', 'Plaça   de   Santa Anna - 999', 'ﬁ', 'İstanbul', 'Straße']);
  run('normalizeStopName', [s], () => tripMatcher.normalizeStopName(s));
}
for (let i = 0; i < N; i++) {
  const a = ri(-100000, 200000), b = ri(-100000, 200000);
  run('circularDiffSec', [a, b], () => tripMatcher.circularDiffSec(a, b));
  const list = []; for (let k = ri(0, 8); k > 0; k--) list.push(rTimeStr());
  run('medianHeadwayMinutes', [list], () => tripMatcher.medianHeadwayMinutes(list));
}
for (let i = 0; i < N * 3; i++) {
  const l = pick(['1', '2', '3', '4', '5', '6', '7', '8', 'L1', '', null, '9']);
  const d = pick(['0', '1', 0, 1, undefined, null, '']);
  const ds = l ? sched.getDirectionSchedule(String(l), d === undefined ? '0' : d, 'weekday') : null;
  const st = ds && ds.stops.length ? pick(ds.stops) : null;
  const args = { lineId: l, direction: d, at: rand() < 0.1 ? pick([0, -1, NaN, null]) : rTs() };
  if (st && rand() < 0.6) args.toSeq = rand() < 0.8 ? st.seq : String(st.seq);
  if (rand() < 0.5) args.stopName = st && rand() < 0.8 ? st.name : pick(['', 'Nowhere', stopNames[0]]);
  if (rand() < 0.8) args.delayMins = rand() < 0.8 ? ri(-10, 40) : pick(['5', '', null, 'x', NaN]);
  const A = { ...args }; for (const k of Object.keys(A)) if (A[k] === undefined) A[k] = '__undef';
  run('matchTrip', [A], () => tripMatcher.matchTrip(args));
  run('matchTripStart', [A], () => tripMatcher.matchTripStart(args));
}
for (let i = 0; i < N * 2; i++) {
  const delay = rand() < 0.2 ? pick([null, undefined, 'x', '3', NaN, 1.5, -1.5, 2.5]) : ri(-10, 30);
  const rt = rand() < 0.6;
  const opt = {};
  const maybe = (k, vals) => { if (rand() < 0.3) opt[k] = pick(vals); };
  maybe('scheduledTime', ['08:30', '', null, '23:59']);
  maybe('realtimeTime', ['08:31', '']);
  maybe('isRegulating', [true, false]);
  maybe('isTerminalLayover', [true]);
  maybe('delayStatus', ['regulating', 'delayed']);
  maybe('originTerminalName', ['Pl. Granollers', '']);
  maybe('originDepartureTime', ['08:40', '08:30', '']);
  maybe('delayBadgeText', ['custom', '']);
  maybe('isPassed', [true]);
  maybe('isFirstOfDay', [true]);
  maybe('isNextService', [true]);
  maybe('isTrain', [true]);
  maybe('isEstimated', [true]);
  maybe('badgeText', ['⚡ X', '']);
  maybe('punctualStyle', ['long', 'short']);
  maybe('thresholdDelayMinutes', [3, 0, 1]);
  maybe('thresholdEarlyMinutes', [-2, 0]);
  maybe('agency', ['Mataró', '']);
  const A = [delay === undefined ? '__undef' : delay, rt, opt];
  run('computeDelayStatus', A, () => delayEngine.computeDelayStatus(delay, rt, opt));
  const m = pick([null, undefined, -1, 0, 1, 2, 1.5, '3', 'x', NaN, 59]);
  run('formatCountdownStatus', [m === undefined ? '__undef' : m], () => delayEngine.formatCountdownStatus(m));
}
for (let i = 0; i < N * 3; i++) {
  const d = {};
  const maybe = (k, vals) => { if (rand() < 0.35) d[k] = pick(vals); };
  maybe('isRealTime', [true, false, 1, 0]);
  maybe('isRealtime', [true, false]);
  maybe('delayMinutes', [0, 3, -2, '4', null, 1.5]);
  maybe('delayMins', [5, null]);
  maybe('isRegulating', [true]);
  maybe('isTerminalLayover', [true]);
  maybe('delayStatus', ['regulating']);
  maybe('isOriginRegulating', [true]);
  maybe('originTerminalName', ['Hospital', '']);
  maybe('originDepartureTime', ['10:05', '']);
  maybe('scheduledTime', ['10:00', '10:00:30', '', '9:5']);
  maybe('departureTime', ['10:02', '10:02:59', '', '25:10', 'abc', '7:05']);
  maybe('arrivalTime', ['10:01', '09:59:00', '']);
  maybe('aimedIso', ['2026-11-12T09:00:00Z', '2026-11-12T10:00:00+01:00', '0001-01-01T00:00:00Z', '1970-01-01T00:00:00Z', '2026-11-12 10:00:00', 'garbage', '2026-11-12T10:00', '']);
  maybe('expectedIso', ['2026-11-12T09:02:00Z', '']);
  maybe('departureDate', ['2026-11-12T09:03:00Z']);
  maybe('minutesAway', [0, 5, -1, '7', 1, null, 2.5]);
  maybe('formattedStatus', ['x', '']);
  maybe('isEstimated', [true]);
  maybe('isFirstOfDay', [true]);
  maybe('isNextService', [true]);
  maybe('isPassed', [true]);
  maybe('isTrain', [true]);
  maybe('isToday', [false, true, 0]);
  maybe('lineId', ['L1', '', 5]);
  maybe('lineCode', ['L1']);
  maybe('lineName', ['Línia 1']);
  maybe('destination', ['Cerdanyola', '']);
  maybe('directionId', [0, 1, '1', null]);
  maybe('comparisonText', ['cmp', '']);
  maybe('delayBadgeText', ['b']);
  maybe('statusText', ['st', '']);
  maybe('arrivalMinutesAway', [3, null, '4']);
  maybe('departureMinutesAway', [4, null]);
  maybe('vehicleId', ['2670', '']);
  maybe('busCoords', [[41.5, 2.4], null]);
  const def = {};
  const ref = rTs();
  const r = rand();
  if (r < 0.3) def.referenceDate = ref; else if (r < 0.6) def.targetDate = ref; else if (r < 0.8) def.dateObj = ref; else def.referenceDate = new Date(ref).toISOString();
  if (rand() < 0.3) def.directionId = pick(['1', '', 0]);
  if (rand() < 0.3) def.lineId = 'L4';
  if (rand() < 0.3) def.destination = 'Def';
  run('standardizeDeparture', [d, def], () => delayEngine.standardizeDeparture(d, def));
}
for (let i = 0; i < N * 3; i++) {
  const lc = pick(['L1', 'L2', 'l3', '4', 'L5', 'L6', 'L7', 'L8', 'L9', '', null, undefined, ' L1 ', 'X']);
  const ts = rand() < 0.1 ? pick([0, -1, NaN, null]) : rTs();
  const L = lc === undefined ? '__undef' : lc;
  run('isOutsideRevenueService', [L, ts], () => serviceHours.isOutsideRevenueService(lc, ts));
  const mins = rand() < 0.5 ? '__undef' : ri(0, 60);
  run('isServiceStartup', [L, ts, mins], () => serviceHours.isServiceStartup(lc, ts, mins === '__undef' ? undefined : mins));
}
for (const lc of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', '']) for (const se of seasonsArg) run('operatingHours', [lc, se === undefined ? '__undef' : se], () => serviceHours.operatingHours(lc, se));
for (let i = 0; i < N; i++) {
  const ts = rTs(); const c = calendarEngine.getDateComponents(new Date(ts));
  run('serviceHoursOnDate', [c.year, c.month, c.day], () => [...serviceHours.serviceHoursOnDate(c.year, c.month, c.day)].sort((a, b) => a - b));
}

process.stdout.write(out.join('\n') + '\n');
process.stderr.write(`wrote ${out.length} cases\n`);
