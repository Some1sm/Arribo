/**
 * test/challenger_geo_delay_test.js
 * 
 * Adversarial Property & Empirical Stress Test Suite for Milestone 1:
 * - Geo Engine (degenerate polylines, 10,000+ points, extreme/antipodal coordinates, micro-segments)
 * - Time Engine & Calendar Engine (DST switchovers, rollover, defensive epoch/ancient guards)
 * - Delay Engine & Schedule Synthesizer (circular midnight wrap-around, >12h diffs, dual compatibility)
 * - BaseTracker & TrackerRegistry robustness under adverse inputs
 */

const assert = require('assert');

const geoEngine = require('../src/core/geo/geoEngine');
const timeEngine = require('../src/core/time/timeEngine');
const calendarEngine = require('../src/core/time/calendarEngine');
const delayEngine = require('../src/core/schedule/delayEngine');
const scheduleSynthesizer = require('../src/core/schedule/scheduleSynthesizer');
const BaseTracker = require('../src/core/BaseTracker');
const trackerRegistry = require('../src/core/TrackerRegistry');

let passedAssertions = 0;
const failureList = [];

function expect(condition, message) {
  if (!condition) {
    failureList.push(message);
    console.error(`  ❌ FAILED: ${message}`);
  } else {
    passedAssertions++;
  }
}

function expectNoThrow(fn, message) {
  try {
    fn();
    passedAssertions++;
  } catch (err) {
    failureList.push(`${message} (Threw: ${err.message})`);
    console.error(`  ❌ FAILED: ${message} (Threw: ${err.message})`);
  }
}

async function runAdversarialTests() {
  console.log('⚡ STARTING ADVERSARIAL & EMPIRICAL STRESS TESTS FOR MILESTONE 1\n');

  // =========================================================================
  // SECTION 1: DEGENERATE POLYLINES & GEOMETRIC EDGE CASES
  // =========================================================================
  console.log('🔷 [Section 1] Stress-testing Snapping & Geometric Edge Cases...');

  // 1.1 Empty / Null / Non-array polylines
  const snapEmpty = geoEngine.snapPointToPolyline(41.5, 2.4, []);
  expect(snapEmpty.lat === 41.5 && snapEmpty.lon === 2.4 && snapEmpty.index === 0, 'Empty polyline returns original point');

  const snapNull = geoEngine.snapPointToPolyline(41.5, 2.4, null);
  expect(snapNull.lat === 41.5 && snapNull.lon === 2.4, 'Null polyline returns original point');

  const snapUndefined = geoEngine.snapPointToPolyline(41.5, 2.4, undefined);
  expect(snapUndefined.lat === 41.5 && snapUndefined.lon === 2.4, 'Undefined polyline returns original point');

  // 1.2 Single-point polyline
  const singlePointPoly = [{ lat: 41.538, lon: 2.441 }];
  const snapSingle = geoEngine.snapPointToPolyline(41.540, 2.445, singlePointPoly);
  expect(snapSingle.lat === 41.538 && snapSingle.lon === 2.441, 'Single point polyline snaps to the only vertex');
  expect(snapSingle.index === 0, 'Single point index is 0');
  expect(snapSingle.dist > 0, 'Distance to single point is positive');

  // 1.3 Zero-length segment (coincident vertices)
  const zeroSegPoly = [
    { lat: 41.500, lon: 2.400 },
    { lat: 41.500, lon: 2.400 },
    { lat: 41.510, lon: 2.410 }
  ];
  const snapZeroSeg = geoEngine.snapPointToPolyline(41.500, 2.400, zeroSegPoly);
  expect(snapZeroSeg.lat === 41.500 && snapZeroSeg.lon === 2.400, 'Zero-length segment handles projection without division by zero');
  expect(!isNaN(snapZeroSeg.dist) && !isNaN(snapZeroSeg.bearing), 'Zero-length segment outputs valid numbers');

  // 1.4 Collinear points with orthogonal projection & segment overshoot
  const collinearPoly = [
    { lat: 41.0, lon: 2.0 },
    { lat: 41.0, lon: 2.2 },
    { lat: 41.0, lon: 2.4 },
    { lat: 41.0, lon: 2.6 }
  ];
  const snapCollinearMid = geoEngine.snapPointToPolyline(41.05, 2.3, collinearPoly);
  expect(snapCollinearMid.lat === 41.0, 'Collinear projection on latitude line');
  expect(Math.abs(snapCollinearMid.lon - 2.3) < 0.001, 'Collinear longitude projected accurately');
  expect(snapCollinearMid.index === 1, 'Correct segment index selected (segment 1: 2.2->2.4)');

  const snapBeforeStart = geoEngine.snapPointToPolyline(41.0, 1.8, collinearPoly);
  expect(snapBeforeStart.lat === 41.0 && snapBeforeStart.lon === 2.0, 'Clamps to start vertex');
  expect(snapBeforeStart.index === 0, 'Clamped index is 0');

  const snapAfterEnd = geoEngine.snapPointToPolyline(41.0, 2.8, collinearPoly);
  expect(snapAfterEnd.lat === 41.0 && snapAfterEnd.lon === 2.6, 'Clamps to end vertex');
  expect(snapAfterEnd.index === 2, 'Clamped index is last segment index');

  // 1.5 Micro-segments (sub-millimeter resolution)
  const microPoly = [
    { lat: 41.5000000, lon: 2.4000000 },
    { lat: 41.5000001, lon: 2.4000001 },
    { lat: 41.5000002, lon: 2.4000002 }
  ];
  const snapMicro = geoEngine.snapPointToPolyline(41.50000005, 2.40000005, microPoly);
  expect(!isNaN(snapMicro.lat) && !isNaN(snapMicro.lon) && !isNaN(snapMicro.dist), 'Micro-segment produces non-NaN numbers');

  // 1.6 Antipodal and extreme global coordinates
  const distPoles = geoEngine.calculateDistanceMeters(90, 0, -90, 0);
  expect(distPoles > 20000000 && distPoles < 20030000, `North to South pole distance ~20,015km (got: ${distPoles})`);

  const distEquatorAntipodal = geoEngine.calculateDistanceMeters(0, 0, 0, 180);
  expect(distEquatorAntipodal > 20000000 && distEquatorAntipodal < 20030000, `Equatorial antipodal distance ~20,015km (got: ${distEquatorAntipodal})`);

  const distNearAntipodal = geoEngine.calculateDistanceMeters(0, 0, 0, 179.9999999);
  expect(!isNaN(distNearAntipodal) && isFinite(distNearAntipodal), 'Near-antipodal points do not result in NaN from sqrt domain errors');

  // 1.7 International Date Line (180th meridian) crossing
  const bearingDateline = geoEngine.calculateBearing(0, 179, 0, -179);
  expect(!isNaN(bearingDateline) && bearingDateline >= 0 && bearingDateline < 360, 'Bearing across 180th meridian is valid degrees');

  // 1.8 Heterogeneous coordinate normalization
  const coordFormats = [
    { lat: 41.5, lon: 2.4 },
    { lat: 41.5, lng: 2.4 },
    { latitude: 41.5, longitude: 2.4 },
    { Latitude: 41.5, Longitude: 2.4 },
    { y: 41.5, x: 2.4 },
    [41.5, 2.4],
    { lat: '41.5', lon: '2.4' }
  ];
  for (const fmt of coordFormats) {
    const norm = geoEngine.normalizeCoord(fmt);
    expect(norm.lat === 41.5 && norm.lon === 2.4, `Correctly normalized format: ${JSON.stringify(fmt)}`);
  }

  // 1.9 Fallbacks for malformed coordinates
  const normBad = geoEngine.normalizeCoord(null);
  expect(normBad.lat === 0 && normBad.lon === 0, 'Null coordinate normalizes to 0,0');
  const normEmpty = geoEngine.normalizeCoord({});
  expect(normEmpty.lat === 0 && normEmpty.lon === 0, 'Empty coordinate normalizes to 0,0');
  const normStr = geoEngine.normalizeCoord({ lat: 'not_a_number', lon: undefined });
  expect(normStr.lat === 0 && normStr.lon === 0, 'NaN string coordinate normalizes to 0,0');

  // =========================================================================
  // SECTION 2: 10,000+ POINT POLYLINES & CUMULATIVE DISTANCES
  // =========================================================================
  console.log('\n🔷 [Section 2] Stress-testing 10,000+ Point Polyline Performance & Cumulative Distance...');

  const NUM_POINTS = 10000;
  const largePolyline = [];
  let curLat = 41.3851;
  let curLon = 2.1734;

  for (let i = 0; i < NUM_POINTS; i++) {
    curLat += 0.00002 + Math.sin(i / 100) * 0.000005;
    curLon += 0.00003 + Math.cos(i / 100) * 0.000005;
    largePolyline.push({
      lat: Math.round(curLat * 1000000) / 1000000,
      lon: Math.round(curLon * 1000000) / 1000000
    });
  }

  const tStart = Date.now();
  const totalLargeDist = geoEngine.calculateRouteTotalDistance(largePolyline);
  const elapsedCalc = Date.now() - tStart;

  expect(totalLargeDist > 20000, `10,000 point polyline distance calculated: ${totalLargeDist}m`);
  expect(elapsedCalc < 100, `Calculation over 10,000 points was fast (${elapsedCalc}ms < 100ms)`);

  const midVertex = largePolyline[5000];
  const tSnapStart = Date.now();
  const snapLarge = geoEngine.snapPointToPolyline(midVertex.lat + 0.0001, midVertex.lon, largePolyline);
  const elapsedSnap = Date.now() - tSnapStart;

  expect(Math.abs(snapLarge.index - 5000) <= 5, `Snapped accurately to near vertex 5000 (got: ${snapLarge.index})`);
  expect(elapsedSnap < 50, `Snapping on 10,000 points took ${elapsedSnap}ms (< 50ms)`);

  const p1 = largePolyline[1000];
  const p2 = largePolyline[8000];
  const subDist = geoEngine.calculatePolylineDistanceBetween(largePolyline, p1.lat, p1.lon, p2.lat, p2.lon);
  const subDistReversed = geoEngine.calculatePolylineDistanceBetween(largePolyline, p2.lat, p2.lon, p1.lat, p1.lon);

  expect(subDist > 0, 'Sub-polyline distance is positive');
  expect(subDist < totalLargeDist, 'Sub-polyline distance is less than total route distance');
  expect(Math.abs(subDist - subDistReversed) <= 1, 'Sub-polyline distance is symmetric (direction-invariant)');

  const zeroPolyDist = geoEngine.calculatePolylineDistanceBetween(largePolyline, p1.lat, p1.lon, p1.lat, p1.lon);
  expect(zeroPolyDist === 0, 'Polyline distance between identical points is 0');

  const fallbackDist = geoEngine.calculatePolylineDistanceBetween([], 41.4, 2.2, 41.5, 2.4);
  const directDist = Math.round(geoEngine.calculateDistanceMeters(41.4, 2.2, 41.5, 2.4));
  expect(Math.abs(fallbackDist - directDist) <= 1, 'Polyline distance falls back cleanly to direct Haversine when polyline < 2 points');

  const extrapPos = geoEngine.extrapolatePolylinePosition(largePolyline[0], 600, 36, largePolyline);
  expect(extrapPos !== null, 'Extrapolation returned non-null');
  expect(extrapPos.progress > 0 && extrapPos.progress <= 100, `Extrapolation progress in bounds (got: ${extrapPos?.progress}%)`);

  // =========================================================================
  // SECTION 3: CIRCULAR MIDNIGHT ROLLOVER COMPARISONS
  // =========================================================================
  console.log('\n🔷 [Section 3] Stress-testing Circular Midnight Rollover Comparisons...');

  // 3.1 Live arrival just after midnight (00:01) vs scheduled just before midnight (23:59)
  const matchPostMidnight = delayEngine.findClosestScheduledTime('00:01', ['23:59', '00:30', '01:00']);
  expect(matchPostMidnight.matched === true, 'Matched 23:59 across midnight');
  expect(matchPostMidnight.scheduledTime === '23:59', 'Scheduled time is 23:59');
  expect(matchPostMidnight.delayMinutes === 2, `Delay is +2 min (got: ${matchPostMidnight.delayMinutes})`);

  // 3.2 Live arrival just before midnight (23:58) vs scheduled just after midnight (00:05)
  const matchPreMidnight = delayEngine.findClosestScheduledTime('23:58', ['23:15', '00:05', '00:45']);
  expect(matchPreMidnight.matched === true, 'Matched 00:05 across midnight');
  expect(matchPreMidnight.scheduledTime === '00:05', 'Scheduled time is 00:05');
  expect(matchPreMidnight.delayMinutes === -7, `Delay is -7 min (got: ${matchPreMidnight.delayMinutes})`);

  // 3.3 Exactly midnight (00:00) vs 23:55
  const matchExactMidnight = delayEngine.findClosestScheduledTime('00:00', ['23:55']);
  expect(matchExactMidnight.matched === true, 'Matched 23:55 from 00:00');
  expect(matchExactMidnight.delayMinutes === 5, `Delay is +5 min (got: ${matchExactMidnight.delayMinutes})`);

  // 3.4 Exactly 23:59 vs 00:00
  const matchExactBefore = delayEngine.findClosestScheduledTime('23:59', ['00:00']);
  expect(matchExactBefore.matched === true, 'Matched 00:00 from 23:59');
  expect(matchExactBefore.delayMinutes === -1, `Delay is -1 min (got: ${matchExactBefore.delayMinutes})`);

  // 3.5 Maximum diff threshold boundary (> 55 minutes should not match)
  const matchOverThreshold = delayEngine.findClosestScheduledTime('00:10', ['22:50'], 55);
  expect(matchOverThreshold.matched === false, '80 min diff exceeds 55 min max threshold');
  expect(matchOverThreshold.delayMinutes === 0, 'Unmatched returns 0 delayMinutes');
  expect(matchOverThreshold.scheduledTime === '00:10', 'Unmatched scheduledTime falls back to live string');

  // 3.6 >12 hour distance
  const match12h = delayEngine.findClosestScheduledTime('06:00', ['18:00'], 55);
  expect(match12h.matched === false, '12-hour offset is not matched with 55 min threshold');

  // 3.7 Scheduled items with object formats
  const objectTrips = [
    { tripId: 'T1', dep: '23:50' },
    { tripId: 'T2', departureTime: '00:15' },
    { tripId: 'T3', time: '00:45' }
  ];
  const matchObj = delayEngine.findClosestScheduledTime('00:17', objectTrips);
  expect(matchObj.matched === true, 'Matched trip object');
  expect(matchObj.bestTrip && matchObj.bestTrip.tripId === 'T2', 'Returned exact matched trip object reference');
  expect(matchObj.scheduledTime === '00:15', 'Scheduled time extracted correctly');
  expect(matchObj.delayMinutes === 2, 'Delay computed correctly for object trip');

  // 3.8 Empty / Null / Invalid scheduled items
  const matchEmptyList = delayEngine.findClosestScheduledTime('12:00', []);
  expect(matchEmptyList.matched === false && matchEmptyList.scheduledTime === '12:00', 'Handles empty schedule array');

  const matchNullTime = delayEngine.findClosestScheduledTime(null, ['12:00']);
  expect(matchNullTime.matched === false, 'Handles null realtime string');

  const matchInvalidTime = delayEngine.findClosestScheduledTime('--:--', ['12:00']);
  expect(matchInvalidTime.matched === false, 'Handles placeholder --:-- string');

  // =========================================================================
  // SECTION 4: TIMEZONE & DST SWITCHOVERS (EUROPE/MADRID)
  // =========================================================================
  console.log('\n🔷 [Section 4] Stress-testing Timezone & DST Switchovers (Europe/Madrid)...');

  // 4.1 Spring Forward Transition: March 29, 2026 (CET UTC+1 -> CEST UTC+2 at 02:00 -> 03:00)
  const preSpring = timeEngine.localTimeToUtcDate(2026, 2, 29, 1, 30, 0, 'Europe/Madrid');
  const netPreSpring = timeEngine.getNetworkTime('Europe/Madrid', preSpring);
  expect(preSpring.toISOString() === '2026-03-29T00:30:00.000Z', `Pre-spring localTimeToUtcDate is 00:30 UTC (got: ${preSpring.toISOString()})`);
  expect(netPreSpring.hour === 1 && netPreSpring.minute === 30, `Pre-spring roundtrip preserves 01:30 local wall-clock (got: ${netPreSpring.hour}:${netPreSpring.minute})`);

  const postSpring = timeEngine.localTimeToUtcDate(2026, 2, 29, 3, 30, 0, 'Europe/Madrid');
  const netPostSpring = timeEngine.getNetworkTime('Europe/Madrid', postSpring);
  expect(postSpring.toISOString() === '2026-03-29T01:30:00.000Z', `Post-spring localTimeToUtcDate is 01:30 UTC (got: ${postSpring.toISOString()})`);
  expect(netPostSpring.hour === 3 && netPostSpring.minute === 30, `Post-spring roundtrip preserves 03:30 local wall-clock (got: ${netPostSpring.hour}:${netPostSpring.minute})`);

  // 4.2 Fall Back Transition: October 25, 2026 (CEST UTC+2 -> CET UTC+1 at 03:00 -> 02:00)
  const preFall = timeEngine.localTimeToUtcDate(2026, 9, 25, 1, 30, 0, 'Europe/Madrid');
  expect(preFall.toISOString() === '2026-10-24T23:30:00.000Z', `Pre-fall localTimeToUtcDate is 23:30 UTC prev day (got: ${preFall.toISOString()})`);

  const postFall = timeEngine.localTimeToUtcDate(2026, 9, 25, 4, 30, 0, 'Europe/Madrid');
  expect(postFall.toISOString() === '2026-10-25T03:30:00.000Z', `Post-fall localTimeToUtcDate is 03:30 UTC (got: ${postFall.toISOString()})`);

  const netPostFall = timeEngine.getNetworkTime('Europe/Madrid', postFall);
  expect(netPostFall.hour === 4 && netPostFall.minute === 30, 'Post-fall roundtrip preserves 04:30 local wall-clock');

  // 4.3 Year-end boundary (Dec 31 23:59:59 to Jan 1 00:00:01)
  const newYearsEve = timeEngine.localTimeToUtcDate(2026, 11, 31, 23, 59, 59, 'Europe/Madrid');
  expect(newYearsEve.toISOString() === '2026-12-31T22:59:59.000Z', 'Year end maps cleanly to UTC');

  const compNYE = calendarEngine.getDateComponents(newYearsEve);
  expect(compNYE.year === 2026 && compNYE.month === 12 && compNYE.day === 31, 'CalendarEngine decomposes Dec 31 accurately');

  const newYearsDay = timeEngine.localTimeToUtcDate(2027, 0, 1, 0, 0, 1, 'Europe/Madrid');
  const compNYD = calendarEngine.getDateComponents(newYearsDay);
  expect(compNYD.year === 2027 && compNYD.month === 1 && compNYD.day === 1, 'CalendarEngine decomposes Jan 1 accurately');

  // 4.4 Day type classifications across calendar boundaries
  const augustSaturday = new Date('2026-08-01T10:00:00Z');
  const compAugSat = calendarEngine.getDateComponents(augustSaturday);
  expect(compAugSat.isSaturday === true && compAugSat.isAugust === true && compAugSat.isWeekend === true, 'August Saturday classified correctly');

  const augustMonday = new Date('2026-08-03T10:00:00Z');
  const compAugMon = calendarEngine.getDateComponents(augustMonday);
  expect(compAugMon.isWeekday === true && compAugMon.isAugust === true && compAugMon.isWeekend === false, 'August Monday classified correctly');

  const septMonday = new Date('2026-09-07T10:00:00Z');
  const compSeptMon = calendarEngine.getDateComponents(septMonday);
  expect(compSeptMon.isWeekday === true && compSeptMon.isAugust === false, 'September Monday classified correctly');

  // =========================================================================
  // SECTION 5: DEFENSIVE PROTECTIONS & ADVERSARIAL INPUTS
  // =========================================================================
  console.log('\n🔷 [Section 5] Stress-testing Defensive Protections for Null, Ancient & Corrupt Data...');

  // 5.1 formatTimeToTimezone protections
  const badTimeInputs = [
    null,
    undefined,
    '',
    false,
    'invalid-date',
    'NaN',
    0,
    new Date(0),                      // 1970-01-01T00:00:00.000Z (epoch)
    '1970-01-01T00:00:00Z',           // Epoch string
    '0001-01-01T00:00:00Z',           // C# DateTime.MinValue / placeholder
    '1999-12-31T23:59:59Z',           // Year < 2000 ancient timestamp
    new Date('1800-05-12T00:00:00Z')  // 19th century date
  ];

  for (const input of badTimeInputs) {
    const res = timeEngine.formatTimeToTimezone(input);
    expect(res === '--:--', `Defensively returned '--:--' for input: ${input}`);
  }

  const validIso = '2026-08-21T12:45:00Z';
  const formattedValid = timeEngine.formatTimeToTimezone(validIso, 'Europe/Madrid');
  expect(formattedValid === '14:45', `Valid ISO timestamp formatted to local time: ${formattedValid}`);

  // 5.2 Numeric Time conversion functions
  expect(timeEngine.timeStringToMinutes(null) === 0, 'timeStringToMinutes(null) -> 0');
  expect(timeEngine.timeStringToMinutes(undefined) === 0, 'timeStringToMinutes(undefined) -> 0');
  expect(timeEngine.timeStringToMinutes('') === 0, 'timeStringToMinutes("") -> 0');
  expect(timeEngine.timeStringToMinutes('25:15') === 1515, 'timeStringToMinutes("25:15") -> 1515');
  expect(timeEngine.timeStringToSeconds('25:15:30') === 90930, 'timeStringToSeconds("25:15:30") -> 90930');

  expect(timeEngine.minutesToTimeString(null) === '00:00', 'minutesToTimeString(null) -> 00:00');
  expect(timeEngine.minutesToTimeString(-10) === '00:00', 'minutesToTimeString(-10) -> 00:00');
  expect(timeEngine.minutesToTimeString(1440) === '24:00', 'minutesToTimeString(1440) -> 24:00');
  expect(timeEngine.secondsToTimeString(null) === '00:00:00', 'secondsToTimeString(null) -> 00:00:00');

  // 5.3 Delay status evaluation & standardization
  const badDelayInputs = [null, undefined, 'not_a_num', NaN, Infinity, -Infinity];
  for (const bd of badDelayInputs) {
    const status = delayEngine.computeDelayStatus(bd, true);
    expect(status.delayStatus === 'on_time' || status.delayStatus === 'delayed' || status.delayStatus === 'early', 'Status handles bad delay numbers safely');
    expect(typeof status.delayMinutes === 'number' && !isNaN(status.delayMinutes), 'delayMinutes is always a valid number');
    expect(typeof status.delayMins === 'number' && !isNaN(status.delayMins), 'delayMins is always a valid number');
  }

  // 5.4 Standardize Departure Schema with explicit null / empty inputs
  expectNoThrow(() => delayEngine.standardizeDeparture(null), 'standardizeDeparture(null) does not throw TypeError');
  expectNoThrow(() => delayEngine.standardizeDeparture(undefined), 'standardizeDeparture(undefined) does not throw TypeError');
  expectNoThrow(() => delayEngine.standardizeDeparture({}), 'standardizeDeparture({}) does not throw TypeError');

  // 5.5 ScheduleSynthesizer with null / sparse baseDepartureTimes
  expectNoThrow(() => {
    scheduleSynthesizer.synthesizeDeparturesFromBaseTimes(['', null, undefined, '08:00'], 60, {
      targetDate: '2026-08-21T07:30:00+02:00'
    });
  }, 'synthesizeDeparturesFromBaseTimes with sparse null array does not throw TypeError');

  expectNoThrow(() => {
    scheduleSynthesizer.generateMorningFirstService([null, undefined, '06:00'], 0);
  }, 'generateMorningFirstService with sparse null array does not throw TypeError');

  // 5.6 GTFS Calendar exception & calendar array null-safety
  expectNoThrow(() => {
    calendarEngine.isServiceActiveOnDate('SRV1', [null, { serviceId: 'SRV1', monday: 1 }], null, new Date());
  }, 'calendarEngine.isServiceActiveOnDate with sparse calendar array does not throw TypeError');

  // 5.7 Countdown badge formatting
  expect(delayEngine.formatCountdownStatus(null) === '--:--', 'formatCountdownStatus(null) -> --:--');
  expect(delayEngine.formatCountdownStatus(undefined) === '--:--', 'formatCountdownStatus(undefined) -> --:--');
  expect(delayEngine.formatCountdownStatus('abc') === '--:--', 'formatCountdownStatus("abc") -> --:--');
  expect(delayEngine.formatCountdownStatus(0) === 'Imminent', 'formatCountdownStatus(0) -> Imminent');
  expect(delayEngine.formatCountdownStatus(-5) === 'Imminent', 'formatCountdownStatus(-5) -> Imminent');
  expect(delayEngine.formatCountdownStatus(1) === '1 min', 'formatCountdownStatus(1) -> 1 min');
  expect(delayEngine.formatCountdownStatus(15) === '15 min', 'formatCountdownStatus(15) -> 15 min');

  // 5.8 Schedule Synthesizer with empty/corrupt stops
  const emptyStopsTravel = scheduleSynthesizer.estimateStopTravelTimes([]);
  expect(Array.isArray(emptyStopsTravel) && emptyStopsTravel.length === 0, 'estimateStopTravelTimes([]) returns []');

  const corruptStops = [
    { id: null, lat: 'bad', lon: null },
    { id: undefined, latitude: undefined, longitude: undefined }
  ];
  const corruptTravel = scheduleSynthesizer.estimateStopTravelTimes(corruptStops);
  expect(corruptTravel.length === 2, 'Processed corrupt stops with fallback segment distances');
  expect(!isNaN(corruptTravel[1].travelSec), 'Corrupt stop travelSec is a valid number');

  // =========================================================================
  // SECTION 6: BASE TRACKER & DEDUPLICATION UNDER ADVERSARIAL VEHICLES
  // =========================================================================
  console.log('\n🔷 [Section 6] Stress-testing BaseTracker vehicle deduplication under high contention...');

  class StressTracker extends BaseTracker {
    async fetchLiveVehicles() { return []; }
    async fetchStopArrivals() { return []; }
    async getRawLineData() { return { lineConfig: { id: 'test' } }; }
  }

  const tracker = new StressTracker();

  // Test null-safety in BaseTracker helper methods
  expectNoThrow(() => tracker.normalizeVehicle(null), 'tracker.normalizeVehicle(null) does not throw TypeError');
  expectNoThrow(() => tracker.buildServiceStatus(null, null, null), 'tracker.buildServiceStatus(null, null, null) does not throw TypeError');

  // Test deduplication with mixed real and estimated buses
  const testBuses = [];
  for (let id = 0; id < 50; id++) {
    // Add estimated version first
    testBuses.push({
      vehicleId: `BUS_${id}`,
      lat: 41.5 + (id * 0.001),
      lon: 2.4 + (id * 0.001),
      isEstimated: true,
      isRealTime: false
    });
    // Add real GPS version second
    testBuses.push({
      vehicleId: `BUS_${id}`,
      lat: 41.5 + (id * 0.001) + 0.0001,
      lon: 2.4 + (id * 0.001) + 0.0001,
      isEstimated: false,
      isRealTime: true
    });
  }

  const deduped = tracker.deduplicateBuses(testBuses);
  expect(deduped.length === 50, `Exactly 50 unique vehicle IDs retained (got: ${deduped.length})`);
  const allReal = deduped.every(b => b.isEstimated === false);
  expect(allReal === true, 'Real GPS telemetry strictly superseded estimated positions for all 50 IDs');

  const noIdBuses = [
    { lat: 41.5381, lon: 2.4411, isEstimated: true },
    { lat: 41.5381, lon: 2.4411, isEstimated: true },
    { lat: 41.5381, lon: 2.4411, isEstimated: true },
    { lat: 41.6000, lon: 2.5000, isEstimated: true }
  ];
  const dedupedNoId = tracker.deduplicateBuses(noIdBuses);
  expect(dedupedNoId.length === 2, `Proximity deduplication reduced 4 anonymous buses to 2 (got: ${dedupedNoId.length})`);

  // =========================================================================
  // FINAL SUMMARY REPORT
  // =========================================================================
  console.log(`\n=======================================================`);
  console.log(`Total Passed Assertions: ${passedAssertions}`);
  console.log(`Total Failures Detected: ${failureList.length}`);
  console.log(`=======================================================`);

  if (failureList.length > 0) {
    console.error('\n🔴 DETECTED ISSUES & ADVERSARIAL FAILURES:');
    failureList.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
    process.exit(1);
  } else {
    console.log('\n🎉 ALL ADVERSARIAL STRESS ASSERTIONS PASSED PERFECTLY!\n');
  }
}

runAdversarialTests().catch(err => {
  console.error('\n❌ ADVERSARIAL HARNESS CRASHED:', err);
  process.exit(1);
});
