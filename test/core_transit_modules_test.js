/**
 * test/core_transit_modules_test.js
 * 
 * Comprehensive Unit and Integration Test Suite for Core Transit Modules:
 * - src/core/geo/geoEngine.js
 * - src/core/time/timeEngine.js
 * - src/core/time/calendarEngine.js
 * - src/core/schedule/scheduleSynthesizer.js
 * - src/core/schedule/delayEngine.js
 * - src/core/BaseTracker.js
 * - src/core/TrackerRegistry.js
 * - src/geoUtils.js & src/timeUtils.js re-export bridges
 */

const assert = require('assert');

// 1. Geo Engine
const geoEngine = require('../src/core/geo/geoEngine');
const geoUtils = require('../src/geoUtils');

// 2. Time & Calendar Engines
const timeEngine = require('../src/core/time/timeEngine');
const calendarEngine = require('../src/core/time/calendarEngine');
const timeUtils = require('../src/timeUtils');

// 3. Schedule & Delay Engines
const scheduleSynthesizer = require('../src/core/schedule/scheduleSynthesizer');
const delayEngine = require('../src/core/schedule/delayEngine');

// 4. Base Tracker & Registry
const BaseTracker = require('../src/core/BaseTracker');
const trackerRegistry = require('../src/core/TrackerRegistry');

async function runTests() {
  console.log('🧪 Starting Core Transit Modules Comprehensive Test Suite...\n');

  // =========================================================================
  // 1. GEO ENGINE TESTS
  // =========================================================================
  console.log('1. Testing Geo Engine (geoEngine.js & geoUtils.js)...');

  // Haversine distance
  const dist = geoEngine.calculateDistanceMeters(41.4214, 2.2036, 41.5543, 2.4332);
  assert(dist > 23000 && dist < 26000, `Distance should be ~24km (got: ${dist})`);

  // Distance with object coords
  const distObj = geoEngine.calculateDistanceMeters({ lat: 41.4214, lon: 2.2036 }, { latitude: 41.5543, longitude: 2.4332 });
  assert.strictEqual(Math.round(dist), Math.round(distObj));

  // Distance between identical points
  assert.strictEqual(geoEngine.calculateDistanceMeters(41.4, 2.2, 41.4, 2.2), 0);

  // Bearing calculation
  const bearing = geoEngine.calculateBearing(41.4214, 2.2036, 41.5543, 2.4332);
  assert(bearing >= 40 && bearing <= 70, `Bearing towards northeast expected (got: ${bearing})`);

  // Compass directions (Catalan labels)
  const compassNE = geoEngine.getCompassDirection(45);
  assert.strictEqual(compassNE.code, 'NE');
  assert(compassNE.label.includes('Nord-Est'));

  const compassN = geoEngine.getCompassDirection(0);
  assert.strictEqual(compassN.code, 'N');

  const compassS = geoEngine.getCompassDirection(180);
  assert.strictEqual(compassS.code, 'S');

  // Backward compatibility alias in geoUtils
  const legacyCompass = geoUtils.bearingToCompassName(90);
  assert.strictEqual(legacyCompass.code, 'E');

  // Interpolate coordinate
  const mid = geoEngine.interpolateCoordinate(41.0, 2.0, 42.0, 4.0, 0.5);
  assert.strictEqual(mid.lat, 41.5);
  assert.strictEqual(mid.lon, 3.0);

  // Polyline Snapping (vector dot-product)
  const polyline = [
    { lat: 41.538, lon: 2.441 },
    { lat: 41.545, lon: 2.449 },
    { lat: 41.552, lon: 2.458 }
  ];
  const snap = geoEngine.snapPointToPolyline(41.540, 2.442, polyline);
  assert(snap.lat > 41.538 && snap.lat < 41.545, `Snapped lat out of range: ${snap.lat}`);
  assert.strictEqual(snap.index, 0);
  assert(snap.dist >= 0);

  // Along-polyline distance
  const polyDist = geoEngine.calculatePolylineDistanceBetween(polyline, 41.538, 2.441, 41.552, 2.458);
  const totalDist = geoEngine.calculateRouteTotalDistance(polyline);
  assert(polyDist > 0 && totalDist > 0);
  assert.strictEqual(polyDist, totalDist);

  // Dead-reckoning extrapolation
  const extrap = geoEngine.extrapolatePolylinePosition({ lat: 41.538, lon: 2.441 }, 60, 30, polyline);
  assert(extrap !== null);
  assert(extrap.lat > 41.538);
  assert(extrap.progress > 0 && extrap.progress <= 100);

  // Google Polyline Decoder
  const encoded = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
  const decoded = geoEngine.decodePolyline(encoded);
  assert(Array.isArray(decoded) && decoded.length > 0);
  assert(typeof decoded[0].lat === 'number' && typeof decoded[0].lon === 'number');

  console.log('✅ Geo Engine verified.');

  // =========================================================================
  // 2. TIME ENGINE TESTS
  // =========================================================================
  console.log('\n2. Testing Time Engine (timeEngine.js & timeUtils.js)...');

  // Conversions
  assert.strictEqual(timeEngine.timeStringToMinutes('08:30'), 510);
  assert.strictEqual(timeEngine.minutesToTimeString(510), '08:30');
  assert.strictEqual(timeEngine.timeStringToSeconds('08:30:15'), 30615);
  assert.strictEqual(timeEngine.secondsToTimeString(30615), '08:30:15');

  // Aliases in timeUtils
  assert.strictEqual(timeUtils.timeToMin('01:15'), 75);
  assert.strictEqual(timeUtils.minToTime(75), '01:15');
  assert.strictEqual(timeUtils.timeToSec('00:01:00'), 60);
  assert.strictEqual(timeUtils.secToTime(60), '00:01:00');

  // Network time in Europe/Madrid
  const fixedDate = new Date('2026-08-21T12:00:00Z');
  const netTime = timeEngine.getNetworkTime('Europe/Madrid', fixedDate);
  assert.strictEqual(netTime.year, 2026);
  assert.strictEqual(netTime.month1, 8); // August
  assert.strictEqual(netTime.timeZone, 'Europe/Madrid');

  // localTimeToUtcDate roundtrip
  const utcDate = timeEngine.localTimeToUtcDate(2026, 7, 21, 14, 0, 0, 'Europe/Madrid'); // 14:00 Madrid (CEST is UTC+2)
  assert.strictEqual(utcDate.getUTCHours(), 12);

  // formatTimeToTimezone defensive guards
  assert.strictEqual(timeEngine.formatTimeToTimezone(null), '--:--');
  assert.strictEqual(timeEngine.formatTimeToTimezone(undefined), '--:--');
  assert.strictEqual(timeEngine.formatTimeToTimezone('invalid'), '--:--');
  assert.strictEqual(timeEngine.formatTimeToTimezone('0001-01-01T00:00:00'), '--:--');
  assert.strictEqual(timeEngine.formatTimeToTimezone(new Date('1970-01-01T00:00:00Z')), '--:--');
  assert.strictEqual(timeEngine.formatTimeToTimezone('2026-08-21T12:30:00Z', 'Europe/Madrid'), '14:30');

  console.log('✅ Time Engine verified.');

  // =========================================================================
  // 3. CALENDAR ENGINE TESTS
  // =========================================================================
  console.log('\n3. Testing Calendar Engine (calendarEngine.js)...');

  // Sunday in August
  const sundayAug = new Date('2026-08-16T12:00:00Z');
  const compSun = calendarEngine.getDateComponents(sundayAug);
  assert.strictEqual(compSun.isSunday, true);
  assert.strictEqual(compSun.isWeekend, true);
  assert.strictEqual(compSun.isWeekday, false);
  assert.strictEqual(compSun.isAugust, true);
  assert.strictEqual(compSun.dateStr, '20260816');

  // Weekday in August
  const wednesdayAug = new Date('2026-08-19T12:00:00Z');
  const compWed = calendarEngine.getDateComponents(wednesdayAug);
  assert.strictEqual(compWed.isWeekday, true);
  assert.strictEqual(compWed.isWeekend, false);
  assert.strictEqual(compWed.isAugust, true);

  // GTFS Calendar Exceptions check
  const exceptionsMap = new Map([
    ['20260816', { active: new Set(['SPECIAL_ACTIVE']), inactive: new Set(['REGULAR_SUN']) }]
  ]);
  assert.strictEqual(calendarEngine.isServiceActiveOnDate('SPECIAL_ACTIVE', null, exceptionsMap, sundayAug), true);
  assert.strictEqual(calendarEngine.isServiceActiveOnDate('REGULAR_SUN', null, exceptionsMap, sundayAug), false);

  // C-10 Legacy Seasonal Service IDs
  assert.strictEqual(calendarEngine.isServiceActiveOnDate('GEN_184749', null, null, sundayAug), true); // Sunday
  assert.strictEqual(calendarEngine.isServiceActiveOnDate('GEN_184749', null, null, wednesdayAug), false); // Not Sunday
  assert.strictEqual(calendarEngine.isServiceActiveOnDate('GEN_185080', null, null, wednesdayAug), true); // Weekday August
  assert.strictEqual(calendarEngine.isServiceActiveOnDate('GEN_184910', null, null, wednesdayAug), false); // Weekday non-August

  // Service Calendar Info
  const calInfoSun = calendarEngine.getServiceCalendarInfo(sundayAug);
  assert.strictEqual(calInfoSun.serviceId, 'GEN_184749');
  assert.strictEqual(calInfoSun.frequencyMinutes, 120);

  const calInfoWedAug = calendarEngine.getServiceCalendarInfo(wednesdayAug);
  assert.strictEqual(calInfoWedAug.serviceId, 'GEN_185080');
  assert.strictEqual(calInfoWedAug.frequencyMinutes, 90);

  console.log('✅ Calendar Engine verified.');

  // =========================================================================
  // 4. SCHEDULE SYNTHESIZER & DELAY ENGINE TESTS
  // =========================================================================
  console.log('\n4. Testing Schedule Synthesizer & Delay Engine...');

  const sampleStops = [
    { id: '101', name: 'Origin Terminal', lat: 41.5380, lon: 2.4410, seq: 1 },
    { id: '102', name: 'Intermediate Station', lat: 41.5450, lon: 2.4490, seq: 2 },
    { id: '103', name: 'Destination Terminus', lat: 41.5520, lon: 2.4580, seq: 3 }
  ];

  // Stop travel time estimation
  const travelTimes = scheduleSynthesizer.estimateStopTravelTimes(sampleStops, {
    speedKmh: 30,
    dwellSecPerStop: 20
  });
  assert.strictEqual(travelTimes.length, 3);
  assert.strictEqual(travelTimes[0].travelSec, 0);
  assert(travelTimes[1].travelSec > 0);
  assert(travelTimes[2].travelSec > travelTimes[1].travelSec);

  const tToStop = scheduleSynthesizer.getTravelTimeToStop(travelTimes, '102');
  assert.strictEqual(tToStop, travelTimes[1].travelSec);

  // Synthetic Departures from Base Times
  const departures = scheduleSynthesizer.synthesizeDeparturesFromBaseTimes(['06:00', '06:30', '07:00'], 300, {
    lineCode: 'TEST-1',
    targetDate: '2026-08-21T05:00:00+02:00',
    minMinutesAway: -5,
    maxMinutesAway: 240
  });
  assert(departures.length >= 3);
  assert.strictEqual(departures[0].lineCode, 'TEST-1');
  assert.strictEqual(departures[0].isRealTime, false);
  assert.strictEqual(departures[0].isRealtime, false);
  assert.strictEqual(departures[0].delayMinutes, 0);
  assert.strictEqual(departures[0].delayMins, 0);

  // Headway departures
  const headwayDeps = scheduleSynthesizer.synthesizeHeadwayDepartures({
    startTime: '08:00',
    endTime: '09:00',
    headwayMinutes: 20,
    stopTravelSec: 120,
    targetDate: '2026-08-21T07:30:00+02:00',
    minMinutesAway: -5,
    maxMinutesAway: 240
  });
  assert.strictEqual(headwayDeps.length, 4); // 08:00, 08:20, 08:40, 09:00

  // Overnight Morning First Service
  const morning = scheduleSynthesizer.generateMorningFirstService(['06:15', '06:45'], 180, {
    lineCode: 'C-10',
    isTrain: false
  });
  assert.strictEqual(morning.length, 2);
  assert.strictEqual(morning[0].isToday, false);
  assert.strictEqual(morning[0].isFirstOfDay, true);
  assert.strictEqual(morning[0].isNextService, true);
  assert.strictEqual(morning[0].delayBadgeText, '🌅 1r Servei del matí');
  assert.strictEqual(morning[1].isFirstOfDay, false);
  assert.strictEqual(morning[1].delayBadgeText, 'Programat');

  // Rail variation for Morning First Service
  const morningRail = scheduleSynthesizer.generateMorningFirstService(['06:00'], 0, { isTrain: true });
  assert.strictEqual(morningRail[0].delayBadgeText, '🌅 1r Tren del matí');

  // Interpolate stop arrivals
  const interpolated = scheduleSynthesizer.interpolateStopArrivals(timeEngine.timeStringToSeconds('08:00'), travelTimes);
  assert.strictEqual(interpolated.length, 3);
  assert.strictEqual(interpolated[0].departureTime, '08:00');

  // Delay Engine: canonical status computation
  const delayed = delayEngine.computeDelayStatus(4, true);
  assert.strictEqual(delayed.delayStatus, 'delayed');
  assert.strictEqual(delayed.delayBadgeText, '+4 min retard');
  assert.strictEqual(delayed.delayMinutes, 4);
  assert.strictEqual(delayed.delayMins, 4);

  const onTime = delayEngine.computeDelayStatus(1, true);
  assert.strictEqual(onTime.delayStatus, 'on_time');
  assert.strictEqual(onTime.delayBadgeText, 'Puntual');

  const early1 = delayEngine.computeDelayStatus(-1, true);
  assert.strictEqual(early1.delayStatus, 'early');
  assert.strictEqual(early1.delayBadgeText, '1 min avançat');

  const early2 = delayEngine.computeDelayStatus(-2, true);
  assert.strictEqual(early2.delayStatus, 'early');
  assert.strictEqual(early2.delayBadgeText, '2 min avançat');

  const early = delayEngine.computeDelayStatus(-3, true);
  assert.strictEqual(early.delayStatus, 'early');
  assert.strictEqual(early.delayBadgeText, '3 min avançat');

  const passed = delayEngine.computeDelayStatus(0, false, { isPassed: true });
  assert.strictEqual(passed.delayStatus, 'passed');
  assert.strictEqual(passed.delayBadgeText, 'Passat ✓');

  // Midnight wrap-around matching
  const matchWrap = delayEngine.findClosestScheduledTime('00:04', ['23:59', '00:30']);
  assert.strictEqual(matchWrap.matched, true);
  assert.strictEqual(matchWrap.scheduledTime, '23:59');
  assert.strictEqual(matchWrap.delayMinutes, 5); // 5 mins late relative to 23:59

  // Departure standardization (dual compatibility)
  const standardized = delayEngine.standardizeDeparture({
    lineId: 'l1',
    departureTime: '10:00',
    delayMinutes: 3,
    isRealTime: true
  });
  assert.strictEqual(standardized.delayMinutes, 3);
  assert.strictEqual(standardized.delayMins, 3);
  assert.strictEqual(standardized.isRealTime, true);
  assert.strictEqual(standardized.isRealtime, true);
  assert.strictEqual(standardized.delayStatus, 'delayed');

  // =========================================================================
  // compileStopDepartures & Universal Synthesizer Enhancement Tests
  // =========================================================================
  console.log('   - Testing compileStopDepartures with exact timetables & live merging...');

  // 1. Exact Timetable Passing Calculation & Options Object Signature
  const exactDepartures = scheduleSynthesizer.synthesizeDeparturesFromBaseTimes({
    scheduledDepartures: ['07:05', '07:22', '07:48'],
    stopTravelSec: 180, // +3 min
    targetDate: '2026-08-21T07:00:00+02:00',
    minMinutesAway: -5
  });
  assert.strictEqual(exactDepartures.length, 3);
  assert.strictEqual(exactDepartures[0].departureTime, '07:08');
  assert.strictEqual(exactDepartures[0].time, '07:08');
  assert.strictEqual(exactDepartures[1].departureTime, '07:25');
  assert.strictEqual(exactDepartures[2].departureTime, '07:51');

  // 2. compileStopDepartures: Live SIRI merging with +-3 minute duplicate suppression
  const compiledWithLive = scheduleSynthesizer.compileStopDepartures({
    baseDeparturesToday: ['07:05', '07:22', '07:48'], // passing times at stop: 07:08, 07:25, 07:51
    baseDeparturesTomorrow: ['05:30', '06:00'],
    stopTravelSec: 180,
    liveDepartures: [
      {
        lineId: 'L1',
        departureTime: '07:24', // Live bus arriving at 07:24 (matches scheduled 07:25 within +-1 min)
        minutesAway: 4,
        isRealTime: true,
        vehicleId: 'BUS-42'
      }
    ],
    dateObj: '2026-08-21T07:20:00+02:00',
    minMinutesAway: -5,
    limit: 10
  });

  // Scheduled 07:25 must be suppressed because live bus at 07:24 covers it
  assert(compiledWithLive.length >= 2, `Expected at least 2 departures, got ${compiledWithLive.length}`);
  const liveDep = compiledWithLive.find(d => d.isRealTime);
  assert(liveDep, 'Must contain real-time departure');
  assert.strictEqual(liveDep.departureTime, '07:24');
  assert.strictEqual(liveDep.vehicleId, 'BUS-42');

  // Check that duplicate 07:25 is NOT present as a separate scheduled departure
  const duplicateSched = compiledWithLive.find(d => !d.isRealTime && d.departureTime === '07:25');
  assert.strictEqual(duplicateSched, undefined, 'Duplicate scheduled departure at 07:25 must be suppressed');

  // Non-duplicate scheduled departure at 07:51 must be present
  const futureSched = compiledWithLive.find(d => !d.isRealTime && d.departureTime === '07:51');
  assert(futureSched, 'Non-duplicate scheduled trip at 07:51 must be preserved');
  assert.strictEqual(futureSched.isRealTime, false);
  assert.strictEqual(futureSched.isToday, true);

  // 3. compileStopDepartures: Overnight Next-Morning First Service Resumption
  const compiledOvernight = scheduleSynthesizer.compileStopDepartures({
    baseDeparturesToday: ['06:00', '07:00'], // Already passed at 23:45
    baseDeparturesTomorrow: ['05:15', '05:45', '06:15'],
    stopTravelSec: 300, // +5 min -> passing times: 05:20, 05:50, 06:20
    liveDepartures: [],
    dateObj: '2026-08-21T23:45:00+02:00',
    minMinutesAway: 0,
    limit: 5
  });

  assert(compiledOvernight.length >= 3, `Expected at least 3 overnight departures, got ${compiledOvernight.length}`);
  assert.strictEqual(compiledOvernight[0].departureTime, '05:20');
  assert.strictEqual(compiledOvernight[0].isToday, false);
  assert.strictEqual(compiledOvernight[0].isFirstOfDay, true);
  assert.strictEqual(compiledOvernight[0].isNextService, true);
  assert.strictEqual(compiledOvernight[0].delayBadgeText, '🌅 1r Servei del matí');
  assert.strictEqual(compiledOvernight[0].badgeText, '🌅 1r Servei del matí');

  assert.strictEqual(compiledOvernight[1].departureTime, '05:50');
  assert.strictEqual(compiledOvernight[1].isToday, false);
  assert.strictEqual(compiledOvernight[1].isFirstOfDay, false);
  assert.strictEqual(compiledOvernight[1].isNextService, false);
  assert.strictEqual(compiledOvernight[1].delayBadgeText, 'Programat');

  // 4. Rail Overnight Next-Morning Resumption
  const compiledOvernightRail = scheduleSynthesizer.compileStopDepartures({
    baseDeparturesToday: [],
    baseDeparturesTomorrow: ['06:05'],
    stopTravelSec: 0,
    liveDepartures: [],
    isTrain: true,
    dateObj: '2026-08-21T23:50:00+02:00'
  });
  assert.strictEqual(compiledOvernightRail[0].delayBadgeText, '🌅 1r Tren del matí');
  assert.strictEqual(compiledOvernightRail[0].isTrain, true);

  console.log('✅ Schedule Synthesizer & Delay Engine verified.');

  // =========================================================================
  // 5. BASE TRACKER & TRACKER REGISTRY TESTS
  // =========================================================================
  console.log('\n5. Testing BaseTracker & TrackerRegistry...');

  class MockTracker extends BaseTracker {
    constructor() {
      super();
      this.routesMap.set('mock-1', {
        id: 'mock-1',
        code: 'M1',
        name: 'Mock Line 1',
        color: '#ff0000',
        agency: 'Mock Transit'
      });
    }

    async fetchLiveVehicles(lineId) {
      return [
        { vehicleId: 'V1', lat: 41.54, lon: 2.44, bearing: 45, isEstimated: true, direction: '0' },
        { vehicleId: 'V1', lat: 41.541, lon: 2.442, bearing: 50, isEstimated: false, isRealTime: true, direction: '0' }, // Real GPS overrides V1 estimate
        { vehicleId: 'V2', lat: 41.55, lon: 2.45, bearing: 180, isEstimated: false, isRealTime: true, direction: '1' }
      ];
    }

    async getRawLineData(lineId, direction = '0') {
      return {
        lineConfig: this.routesMap.get(lineId),
        stops: sampleStops,
        polylineCoords: polyline,
        directions: [
          { dirId: '0', name: 'Direction 0' },
          { dirId: '1', name: 'Direction 1' }
        ]
      };
    }
  }

  const mock = new MockTracker();
  await mock.init();

  // Test single direction resolution and vehicle deduplication
  const details0 = await mock.getLineDetails('mock-1', '0');
  assert.strictEqual(details0.code, 'M1');
  assert.strictEqual(details0.activeBuses.length, 1);
  assert.strictEqual(details0.activeBuses[0].vehicleId, 'V1');
  assert.strictEqual(details0.activeBuses[0].isEstimated, false); // Real GPS won
  assert.strictEqual(details0.activeBuses[0].isRealTime, true);
  assert.strictEqual(details0.activeBuses[0].isRealtime, true);
  assert(details0.checkpoints.length > 0);

  // Test direction === 'both' resolution
  const detailsBoth = await mock.getLineDetails('mock-1', 'both');
  assert.strictEqual(detailsBoth.direction, 'both');
  assert.strictEqual(detailsBoth.secondaryColor, '#38bdf8');
  assert.strictEqual(detailsBoth.activeBuses.length, 2); // V1 (dir 0) and V2 (dir 1)
  assert.strictEqual(detailsBoth.allDirections.length, 2);

  // Test Tracker Registry
  const resMataro1 = trackerRegistry.getTrackerForLine('1');
  assert.strictEqual(resMataro1.type, 'mataro');
  assert.strictEqual(resMataro1.cleanCode, 'L1');

  const resMataro8 = trackerRegistry.getTrackerForLine('L8');
  assert.strictEqual(resMataro8.type, 'mataro');
  assert.strictEqual(resMataro8.cleanCode, 'L8');

  const resMataroAlias = trackerRegistry.getTrackerForLine('mataro_5');
  assert.strictEqual(resMataroAlias.type, 'mataro');
  assert.strictEqual(resMataroAlias.cleanCode, 'L5');

  // Universal Stop & Line Search
  const searchLines = trackerRegistry.searchStopsAndLines('L1');
  assert(searchLines.length > 0);
  assert(searchLines.some(r => r.type === 'line'));

  const searchStops = trackerRegistry.searchStopsAndLines('Hospital');
  assert(searchStops.length > 0);
  assert(searchStops.some(r => r.type === 'stop'));

  console.log('✅ BaseTracker & TrackerRegistry verified.');

  console.log('\n🎉 ALL CORE TRANSIT MODULE TESTS PASSED 100%! 🎉\n');
}

runTests().catch(err => {
  console.error('❌ Core test failure:', err);
  process.exit(1);
});
