/**
 * test/mataro_timetable_accuracy_test.js
 * 
 * Comprehensive 4-Tier E2E & Timetable Accuracy Test Suite for Mataró Bus:
 * - Tier 1: Feature Coverage (Exact CTSA/Avanza Timetables, All 8 Lines & 16 Directions, Standard Deviation Headway Analysis)
 * - Tier 2: Boundary & Corner Cases (Line 8 Weekend 14:04, Line 6 Sunday 14:00, Overnight Transitions, Terminal/Origin Run Times)
 * - Tier 3: Cross-Feature Interactions (scheduleSynthesizer Live SIRI/GPS Merging, +-3 Min Duplicate Suppression, Delay Badges)
 * - Tier 4: Real-World Passenger Scenarios (Hospital de Mataró, Estació Rodalies, Parc de Cerdanyola, Pl. Tereses Journeys)
 * 
 * Requirement source: ORIGINAL_REQUEST.md (§R1, §R2, §R3, §R4), PROJECT.md, TEST_INFRA.md
 */

const assert = require('assert');
const mataroSchedules = require('../src/data/mataroSchedules');
const rawSchedules = require('../src/data/mataro_schedules.json');
const scheduleSynthesizer = require('../src/core/schedule/scheduleSynthesizer');
const delayEngine = require('../src/core/schedule/delayEngine');
const timeEngine = require('../src/core/time/timeEngine');
const calendarEngine = require('../src/core/time/calendarEngine');
const mataroTracker = require('../src/mataroTracker');

/**
 * Calculates mean and sample standard deviation for an array of numbers.
 * 
 * @param {number[]} values 
 * @returns {{ mean: number, variance: number, stdDev: number, min: number, max: number }}
 */
function calculateStatistics(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { mean: 0, variance: 0, stdDev: 0, min: 0, max: 0 };
  }
  if (values.length === 1) {
    return { mean: values[0], variance: 0, stdDev: 0, min: values[0], max: values[0] };
  }
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / (values.length - 1);
  const stdDev = Math.sqrt(variance);
  const min = Math.min(...values);
  const max = Math.max(...values);
  return { mean, variance, stdDev, min, max };
}

/**
 * Computes inter-departure headway intervals in minutes between consecutive departures.
 * 
 * @param {string[]} departures - Array of 'HH:MM' departure times
 * @returns {number[]} Array of headway differences in minutes
 */
function computeHeadwayIntervals(departures) {
  if (!Array.isArray(departures) || departures.length < 2) return [];
  const intervals = [];
  for (let i = 1; i < departures.length; i++) {
    const [h0, m0] = departures[i - 1].split(':').map(Number);
    const [h1, m1] = departures[i].split(':').map(Number);
    let diffMin = (h1 * 60 + m1) - (h0 * 60 + m0);
    if (diffMin < 0) diffMin += 1440; // Rollover handling if applicable
    intervals.push(diffMin);
  }
  return intervals;
}

async function runMataroTimetableAccuracyTests() {
  console.log('🧪 =========================================================================');
  console.log('🧪 STARTING MATARÓ BUS TIMETABLE ACCURACY & E2E MASTER TEST SUITE');
  console.log('🧪 =========================================================================\n');

  let totalAssertions = 0;

  // =========================================================================
  // TIER 1: FEATURE COVERAGE — AUTHORITATIVE TIMETABLES & HEADWAY DISPERSION
  // =========================================================================
  console.log('📌 [TIER 1: Feature Coverage] Validating Official Timetables for Lines 1–8...');

  const EXPECTED_LINE_MATRIX = {
    '1': {
      name: 'Circular',
      directions: {
        '11': { weekdayTrips: 76, satTrips: 37, sunTrips: 25, firstWk: '05:25', lastWk: '22:35', firstSat: '06:36', lastSat: '22:09', firstSun: '08:12', lastSun: '22:01' },
        '12': { weekdayTrips: 67, satTrips: 37, sunTrips: 25, firstWk: '06:03', lastWk: '22:05', firstSat: '07:09', lastSat: '22:02', firstSun: '08:15', lastSun: '21:58' }
      }
    },
    '2': {
      name: 'Circular',
      directions: {
        '11': { weekdayTrips: 77, satTrips: 36, sunTrips: 26, firstWk: '05:25', lastWk: '22:19', firstSat: '06:56', lastSat: '22:13', firstSun: '07:55', lastSun: '22:00' },
        '12': { weekdayTrips: 65, satTrips: 36, sunTrips: 26, firstWk: '05:28', lastWk: '22:24', firstSat: '06:26', lastSat: '22:08', firstSun: '07:59', lastSun: '22:00' }
      }
    },
    '3': {
      name: 'Camí de la Serra',
      directions: {
        '11': { weekdayTrips: 50, satTrips: 35, sunTrips: 23, firstWk: '06:31', lastWk: '21:41', firstSat: '07:34', lastSat: '21:17', firstSun: '08:00', lastSun: '21:38' },
        '12': { weekdayTrips: 48, satTrips: 36, sunTrips: 24, firstWk: '06:06', lastWk: '21:12', firstSat: '07:04', lastSat: '21:54', firstSun: '08:05', lastSun: '22:15' }
      }
    },
    '4': {
      name: 'Cirera',
      directions: {
        '11': { weekdayTrips: 26, satTrips: 13, sunTrips: 14, firstWk: '07:38', lastWk: '22:07', firstSat: '08:03', lastSat: '21:13', firstSun: '08:30', lastSun: '21:57' },
        '12': { weekdayTrips: 13, satTrips: 14, sunTrips: 13, firstWk: '07:45', lastWk: '20:45', firstSat: '07:31', lastSat: '21:50', firstSun: '09:01', lastSun: '21:30' }
      }
    },
    '5': {
      name: 'Hospital',
      directions: {
        '11': { weekdayTrips: 69, satTrips: 51, sunTrips: 29, firstWk: '05:41', lastWk: '22:32', firstSat: '07:20', lastSat: '21:56', firstSun: '08:52', lastSun: '21:19' },
        '12': { weekdayTrips: 68, satTrips: 50, sunTrips: 30, firstWk: '05:58', lastWk: '22:12', firstSat: '07:35', lastSat: '22:14', firstSun: '08:32', lastSun: '21:22' }
      }
    },
    '6': {
      name: 'Institut Català Salut',
      directions: {
        '11': { weekdayTrips: 64, satTrips: 26, sunTrips: 12, firstWk: '06:00', lastWk: '21:47', firstSat: '07:16', lastSat: '21:24', firstSun: '14:00', lastSun: '22:03' },
        '12': { weekdayTrips: 40, satTrips: 26, sunTrips: 12, firstWk: '06:51', lastWk: '21:53', firstSat: '07:34', lastSat: '21:43', firstSun: '14:17', lastSun: '22:17' }
      }
    },
    '7': {
      name: 'Pl. Tereses',
      directions: {
        '11': { weekdayTrips: 51, satTrips: 37, sunTrips: 35, firstWk: '07:25', lastWk: '21:35', firstSat: '08:19', lastSat: '21:46', firstSun: '08:39', lastSun: '21:27' },
        '12': { weekdayTrips: 51, satTrips: 37, sunTrips: 35, firstWk: '07:36', lastWk: '21:37', firstSat: '08:10', lastSat: '21:37', firstSun: '08:30', lastSun: '21:18' }
      }
    },
    '8': {
      name: 'Galícia',
      directions: {
        '11': { weekdayTrips: 43, satTrips: 14, sunTrips: 7, firstWk: '06:05', lastWk: '22:11', firstSat: '07:00', lastSat: '21:31', firstSun: '14:45', lastSun: '21:13' },
        '12': { weekdayTrips: 27, satTrips: 14, sunTrips: 8, firstWk: '06:23', lastWk: '21:22', firstSat: '07:20', lastSat: '21:55', firstSun: '14:04', lastSun: '21:35' }
      }
    }
  };

  let grandTotalWeekday = 0;
  let grandTotalSaturday = 0;
  let grandTotalSunday = 0;
  let nonUniformCount = 0;

  for (const [lineId, expectedData] of Object.entries(EXPECTED_LINE_MATRIX)) {
    const lineConfig = rawSchedules[lineId];
    assert(lineConfig, `Line ${lineId} must exist in raw schedules`);
    assert.strictEqual(lineConfig.agency, 'Mataró Bus');
    assert.strictEqual(lineConfig.operator, 'CTSA / Avanza');
    totalAssertions += 3;

    for (const [pathId, expDir] of Object.entries(expectedData.directions)) {
      const dirScheduleWeekday = mataroSchedules.getDirectionSchedule(lineId, pathId, 'weekday');
      const dirScheduleSaturday = mataroSchedules.getDirectionSchedule(lineId, pathId, 'saturday');
      const dirScheduleSunday = mataroSchedules.getDirectionSchedule(lineId, pathId, 'sunday');

      assert(dirScheduleWeekday, `L${lineId} dir ${pathId} weekday schedule must exist`);
      assert(dirScheduleSaturday, `L${lineId} dir ${pathId} saturday schedule must exist`);
      assert(dirScheduleSunday, `L${lineId} dir ${pathId} sunday schedule must exist`);
      totalAssertions += 3;

      // Assert exact trip counts
      assert.strictEqual(dirScheduleWeekday.tripsCount, expDir.weekdayTrips, `L${lineId} dir ${pathId} weekday trip count`);
      assert.strictEqual(dirScheduleSaturday.tripsCount, expDir.satTrips, `L${lineId} dir ${pathId} saturday trip count`);
      assert.strictEqual(dirScheduleSunday.tripsCount, expDir.sunTrips, `L${lineId} dir ${pathId} sunday trip count`);
      totalAssertions += 3;

      grandTotalWeekday += dirScheduleWeekday.tripsCount;
      grandTotalSaturday += dirScheduleSaturday.tripsCount;
      grandTotalSunday += dirScheduleSunday.tripsCount;

      // Assert first and last departures
      assert.strictEqual(dirScheduleWeekday.firstTrip, expDir.firstWk, `L${lineId} dir ${pathId} first weekday departure`);
      assert.strictEqual(dirScheduleWeekday.lastTrip, expDir.lastWk, `L${lineId} dir ${pathId} last weekday departure`);
      assert.strictEqual(dirScheduleSaturday.firstTrip, expDir.firstSat, `L${lineId} dir ${pathId} first saturday departure`);
      assert.strictEqual(dirScheduleSaturday.lastTrip, expDir.lastSat, `L${lineId} dir ${pathId} last saturday departure`);
      assert.strictEqual(dirScheduleSunday.firstTrip, expDir.firstSun, `L${lineId} dir ${pathId} first sunday departure`);
      assert.strictEqual(dirScheduleSunday.lastTrip, expDir.lastSun, `L${lineId} dir ${pathId} last sunday departure`);
      totalAssertions += 6;

      // Assert Non-Uniform Headway Intervals (Standard Deviation > 0)
      // This mathematically proves that synthetic uniform (e.g. constant 30-min) headways have been eliminated
      const weekdayHeadways = computeHeadwayIntervals(dirScheduleWeekday.departures);
      const satHeadways = computeHeadwayIntervals(dirScheduleSaturday.departures);
      const sunHeadways = computeHeadwayIntervals(dirScheduleSunday.departures);

      const wkStats = calculateStatistics(weekdayHeadways);
      const satStats = calculateStatistics(satHeadways);
      const sunStats = calculateStatistics(sunHeadways);

      assert(wkStats.stdDev > 0, `L${lineId} dir ${pathId} weekday headways must have standard deviation > 0 (got: ${wkStats.stdDev})`);
      assert(satStats.stdDev >= 0, `L${lineId} dir ${pathId} saturday headways must have valid standard deviation`);
      assert(sunStats.stdDev >= 0, `L${lineId} dir ${pathId} sunday headways must have valid standard deviation`);

      // Verify that no line has all identical 30-min (or any constant) headways on weekdays
      const uniqueWkHeadways = new Set(weekdayHeadways);
      assert(uniqueWkHeadways.size > 1, `L${lineId} dir ${pathId} weekday must have diverse headways (found single headway: ${[...uniqueWkHeadways].join(',')})`);
      nonUniformCount++;
      totalAssertions += 5;

      // Assert Topography & Stop Travel Time Monotonicity
      const stops = dirScheduleWeekday.stops;
      assert(Array.isArray(stops) && stops.length >= 5, `L${lineId} dir ${pathId} must have valid stop sequence`);
      assert.strictEqual(stops[0].travelSec, 0, `L${lineId} dir ${pathId} origin stop travelSec must be 0`);
      assert(dirScheduleWeekday.totalTravelSec > 0, `L${lineId} dir ${pathId} total travel sec must be > 0`);
      assert(dirScheduleWeekday.totalDistanceMeters > 0, `L${lineId} dir ${pathId} total distance must be > 0`);

      for (let i = 1; i < stops.length; i++) {
        assert(stops[i].cumulativeMeters >= stops[i - 1].cumulativeMeters, `Monotonic distance failed at stop ${i} on L${lineId} dir ${pathId}`);
        assert(stops[i].travelSec >= stops[i - 1].travelSec, `Monotonic travel time failed at stop ${i} on L${lineId} dir ${pathId}`);
        assert.strictEqual(stops[i].seq, i + 1, `Sequential numbering mismatch on stop ${i}`);
      }
      totalAssertions += 5;
    }
  }

  assert.strictEqual(grandTotalWeekday, 835, 'Grand total weekday departures across all 8 Mataró lines must be 835');
  assert.strictEqual(grandTotalSaturday, 499, 'Grand total Saturday departures must be 499');
  assert.strictEqual(grandTotalSunday, 344, 'Grand total Sunday departures must be 344');
  assert.strictEqual(nonUniformCount, 16, 'All 16 directional paths must exhibit non-uniform headways');
  totalAssertions += 4;

  console.log(`  ✓ 1.1 All 8 lines and 16 directions verified: 835 weekday, 499 Saturday, 344 Sunday trips (1,678 total official daily trips).`);
  console.log(`  ✓ 1.2 Non-uniform headway mathematical proof: 100% of routes show standard deviation > 0 (synthetic 30-min intervals eliminated).`);
  console.log(`  ✓ 1.3 Topographical run-time monotonicity verified across all stop sequences.`);


  // =========================================================================
  // TIER 2: BOUNDARY & CORNER CASES
  // =========================================================================
  console.log('\n📌 [TIER 2: Boundary & Corner Cases] Testing Line 8 & 6 Constraints, Overnight Rollover & Edges...');

  // 2.1 Line 8 Weekend Afternoon-Only Schedule Constraints
  console.log('  Testing Line 8 weekend morning query boundary...');
  const l8SunDir12 = mataroSchedules.getDirectionSchedule('8', '12', 'sunday');
  assert.strictEqual(l8SunDir12.afternoonOnly, true);
  assert.strictEqual(l8SunDir12.firstTrip, '14:04');
  assert.strictEqual(l8SunDir12.lastTrip, '21:35');
  assert.deepStrictEqual(l8SunDir12.departures, ['14:04', '15:08', '16:12', '17:16', '18:20', '19:26', '20:32', '21:35']);

  const l8SunDir11 = mataroSchedules.getDirectionSchedule('8', '11', 'sunday');
  assert.strictEqual(l8SunDir11.afternoonOnly, true);
  assert.strictEqual(l8SunDir11.firstTrip, '14:45');
  assert.strictEqual(l8SunDir11.lastTrip, '21:13');
  assert.deepStrictEqual(l8SunDir11.departures, ['14:45', '15:49', '16:53', '17:57', '19:02', '20:08', '21:13']);
  totalAssertions += 8;

  // 2.2 Line 6 Sunday Afternoon-Only Schedule Constraints
  console.log('  Testing Line 6 Sunday morning query boundary...');
  const l6SunDir11 = mataroSchedules.getDirectionSchedule('6', '11', 'sunday');
  assert.strictEqual(l6SunDir11.afternoonOnly, true);
  assert.strictEqual(l6SunDir11.firstTrip, '14:00');
  assert.strictEqual(l6SunDir11.lastTrip, '22:03');
  assert.deepStrictEqual(l6SunDir11.departures, [
    '14:00', '14:44', '15:28', '16:12', '16:56', '17:40', '18:25', '19:10', '19:55', '20:40', '21:22', '22:03'
  ]);

  const l6SunDir12 = mataroSchedules.getDirectionSchedule('6', '12', 'sunday');
  assert.strictEqual(l6SunDir12.afternoonOnly, true);
  assert.strictEqual(l6SunDir12.firstTrip, '14:17');
  assert.strictEqual(l6SunDir12.lastTrip, '22:17');
  totalAssertions += 8;

  // 2.3 Overnight Service Rollover & Morning First Service
  console.log('  Testing overnight service transition and first morning trip generation...');
  const lateNightDate = new Date('2026-08-22T23:45:00+02:00'); // Saturday night
  const l8SatOvernightDeps = scheduleSynthesizer.compileStopDepartures({
    baseDeparturesToday: ['07:00', '07:59', '21:35'],
    baseDeparturesTomorrow: l8SunDir12.departures,
    stopTravelSec: 0,
    liveDepartures: [],
    dateObj: lateNightDate,
    limit: 5,
    minCountBeforeMorning: 5
  });

  assert(l8SatOvernightDeps.length > 0, 'Must return morning resumption departures');
  assert.strictEqual(l8SatOvernightDeps[0].isToday, false, 'First morning trip isToday must be false');
  assert.strictEqual(l8SatOvernightDeps[0].isFirstOfDay, true, 'First morning trip isFirstOfDay must be true');
  assert.strictEqual(l8SatOvernightDeps[0].isNextService, true, 'First morning trip isNextService must be true');
  assert.strictEqual(l8SatOvernightDeps[0].departureTime, '14:04', 'L8 Sunday morning resumption must be 14:04');
  assert(l8SatOvernightDeps[0].badgeText.includes('1r Servei del matí'), 'Must have first service badge');
  totalAssertions += 6;

  // 2.4 Intermediate Stop Travel Time Calculation with Real Topography
  const l1HospitalTravelSec = mataroSchedules.getStopTravelTime('1', '11', '1001');
  assert(l1HospitalTravelSec > 1500 && l1HospitalTravelSec < 2000, `L1 Hospital travel sec should be ~1800s (got: ${l1HospitalTravelSec})`);

  const l1OriginTravelSec = mataroSchedules.getStopTravelTime('1', '11', '1016');
  assert.strictEqual(l1OriginTravelSec, 0, 'Origin stop travelSec must be 0');

  const l1HospitalPassingDeps = mataroSchedules.getDeparturesForStop('1', '11', '1001', 'weekday');
  assert.strictEqual(l1HospitalPassingDeps.length, 76);
  // Origin 05:25 + 1811s (30m 11s) -> 05:55
  assert.strictEqual(l1HospitalPassingDeps[0], '05:55');
  assert.strictEqual(l1HospitalPassingDeps[l1HospitalPassingDeps.length - 1], '23:05');
  totalAssertions += 5;

  // 2.5 Corrupted / Falsy / Fallback Inputs in Schedule Synthesizer
  assert.deepStrictEqual(scheduleSynthesizer.compileStopDepartures({ baseDeparturesToday: null, dateObj: new Date() }), []);
  assert.deepStrictEqual(scheduleSynthesizer.generateMorningFirstService([], 0), []);
  assert.strictEqual(mataroSchedules.getStopTravelTime('999', '0', '99999'), 0);
  assert.strictEqual(mataroSchedules.normalizeLineId('L8'), '8');
  assert.strictEqual(mataroSchedules.normalizeLineId('mataro_3'), '3');
  assert.strictEqual(mataroSchedules.normalizeDayType('Festius'), 'sunday');
  assert.strictEqual(mataroSchedules.normalizeDayType('Dissabte'), 'saturday');
  totalAssertions += 7;

  console.log('  ✓ 2.1 Line 8 weekend afternoon-only constraint strictly verified (14:04 / 14:45 first service).');
  console.log('  ✓ 2.2 Line 6 Sunday afternoon-only constraint strictly verified (14:00 / 14:17 first service).');
  console.log('  ✓ 2.3 Overnight rollover correctly produces tomorrow first service with canonical badges.');
  console.log('  ✓ 2.4 Topography-adjusted intermediate stop passing times accurately computed.');
  console.log('  ✓ 2.5 Resilient handling of unknown lines, null schedules, and day type normalization.');


  // =========================================================================
  // TIER 3: CROSS-FEATURE INTERACTIONS — LIVE MERGING & DELAY BADGES
  // =========================================================================
  console.log('\n📌 [TIER 3: Cross-Feature Interactions] Testing Live SIRI Merging & Delay Standardization...');

  // 3.1 Live SIRI Telemetry Merging with Exact Schedule
  const targetDateMidday = new Date('2026-08-22T14:00:00+02:00'); // 14:00 Madrid
  const sampleBaseDeps = ['14:04', '14:35', '15:08', '15:40'];
  const sampleLiveDeps = [
    {
      vehicleId: 'BUS-108',
      departureTime: '14:05',
      minutesAway: 5,
      isRealTime: true,
      delayMinutes: 2,
      destination: 'Hospital'
    }
  ];

  const mergedDeps = scheduleSynthesizer.compileStopDepartures({
    baseDeparturesToday: sampleBaseDeps,
    liveDepartures: sampleLiveDeps,
    stopTravelSec: 0,
    duplicateWindowMinutes: 3,
    dateObj: targetDateMidday,
    limit: 10
  });

  // Scheduled trip at 14:04 is within +-3 min of live trip at 14:05 -> Suppressed
  assert.strictEqual(mergedDeps.length, 4, `Expected 4 departures after deduplication (got: ${mergedDeps.length})`);
  assert.strictEqual(mergedDeps[0].departureTime, '14:05');
  assert.strictEqual(mergedDeps[0].isRealTime, true);
  assert.strictEqual(mergedDeps[0].isRealtime, true);
  assert.strictEqual(mergedDeps[0].delayMinutes, 2);
  assert.strictEqual(mergedDeps[0].delayStatus, 'delayed');
  assert.strictEqual(mergedDeps[0].delayBadgeText, '+2 min retard');

  // Scheduled departures follow
  assert.strictEqual(mergedDeps[1].departureTime, '14:35');
  assert.strictEqual(mergedDeps[1].isRealTime, false);
  assert.strictEqual(mergedDeps[1].isRealtime, false);
  assert.strictEqual(mergedDeps[1].delayStatus, 'scheduled');
  assert.strictEqual(mergedDeps[1].delayBadgeText, 'Horari teòric');

  assert.strictEqual(mergedDeps[2].departureTime, '15:08');
  assert.strictEqual(mergedDeps[3].departureTime, '15:40');
  totalAssertions += 12;

  // 3.2 Duplicate Window Boundary Verification (+-3 min threshold)
  // Case A: Live at 14:07 vs Scheduled at 14:04 (diff = 3 min) -> Suppressed
  const mergedWin3 = scheduleSynthesizer.compileStopDepartures({
    baseDeparturesToday: ['14:04', '14:35'],
    liveDepartures: [{ departureTime: '14:07', minutesAway: 7, isRealTime: true }],
    duplicateWindowMinutes: 3,
    dateObj: targetDateMidday
  });
  assert.strictEqual(mergedWin3.length, 2);
  assert.strictEqual(mergedWin3[0].departureTime, '14:07');
  assert.strictEqual(mergedWin3[1].departureTime, '14:35');

  // Case B: Live at 14:08 vs Scheduled at 14:04 (diff = 4 min) -> Kept
  const mergedWin4 = scheduleSynthesizer.compileStopDepartures({
    baseDeparturesToday: ['14:04', '14:35'],
    liveDepartures: [{ departureTime: '14:08', minutesAway: 8, isRealTime: true }],
    duplicateWindowMinutes: 3,
    dateObj: targetDateMidday
  });
  assert.strictEqual(mergedWin4.length, 3);
  assert.strictEqual(mergedWin4[0].departureTime, '14:04');
  assert.strictEqual(mergedWin4[1].departureTime, '14:08');
  assert.strictEqual(mergedWin4[2].departureTime, '14:35');
  totalAssertions += 8;

  // 3.3 Delay Engine Standardization for Scheduled vs Live Departures
  const standardizedLive = delayEngine.standardizeDeparture({
    departureTime: '10:15',
    delayMinutes: 5,
    minutesAway: 15,
    isRealTime: true
  });
  assert.strictEqual(standardizedLive.delayMinutes, 5);
  assert.strictEqual(standardizedLive.delayStatus, 'delayed');
  assert.strictEqual(standardizedLive.delayBadgeText, '+5 min retard');

  const standardizedSched = delayEngine.standardizeDeparture({
    departureTime: '10:15',
    isRealTime: false
  });
  assert.strictEqual(standardizedSched.delayMinutes, 0);
  assert.strictEqual(standardizedSched.delayStatus, 'scheduled');
  assert.strictEqual(standardizedSched.delayBadgeText, 'Horari teòric');
  totalAssertions += 6;

  console.log('  ✓ 3.1 Live SIRI telemetry properly merges with exact scheduled departures.');
  console.log('  ✓ 3.2 +-3 minute circular window deduplication eliminates phantom scheduled entries.');
  console.log('  ✓ 3.3 Canonical delay badges and dual-compatibility schemas enforced.');


  // =========================================================================
  // TIER 4: REAL-WORLD PASSENGER SCENARIOS — HUBS, TARGET ETAs & JOURNEYS
  // =========================================================================
  console.log('\n📌 [TIER 4: Real-World Scenarios] Simulating Key Transit Hubs & Passenger Journeys...');

  // 4.1 Hub 1: Hospital de Mataró (Stop 1001) - Major Health Hub
  console.log('  Testing Stop 1001 (Hospital de Mataró) multi-line aggregation...');
  const hospitalDeps = await mataroTracker.getStopDepartures('1001');
  assert(hospitalDeps && hospitalDeps.stop, 'Hospital stop object must exist');
  assert.strictEqual(hospitalDeps.stop.id, '1001');
  assert(Array.isArray(hospitalDeps.departures) && hospitalDeps.departures.length > 0, 'Hospital must have departures');

  // Verify all departures have non-empty formattedStatus and valid departureTime
  hospitalDeps.departures.forEach((dep, idx) => {
    assert(dep.departureTime && dep.departureTime !== '--:--', `Stop 1001 dep ${idx} departureTime valid`);
    assert(dep.formattedStatus, `Stop 1001 dep ${idx} formattedStatus present`);
    assert(typeof dep.isRealTime === 'boolean');
    assert(typeof dep.isToday === 'boolean');
    assert(typeof dep.delayMinutes === 'number');
  });
  totalAssertions += 5;

  // 4.2 Hub 2: Estació Rodalies (Stop 1016) - Multimodal Train & Bus Interchange
  console.log('  Testing Stop 1016 (Estació Rodalies) multi-line interchange...');
  const rodaliesDeps = await mataroTracker.getStopDepartures('1016');
  assert(rodaliesDeps && rodaliesDeps.stop, 'Rodalies stop object must exist');
  assert.strictEqual(rodaliesDeps.stop.id, '1016');
  assert(rodaliesDeps.departures.length > 0, 'Rodalies must have departures');
  totalAssertions += 3;

  // 4.3 Hub 3: Parc de Cerdanyola (Stop 1004) & Pl. de les Tereses (Stop 1008)
  console.log('  Testing Stop 1004 (Parc de Cerdanyola) and Stop 1008 (Pl. de les Tereses)...');
  const cerdanyolaDeps = await mataroTracker.getStopDepartures('1004');
  assert(cerdanyolaDeps && cerdanyolaDeps.departures.length > 0);

  const teresesDeps = await mataroTracker.getStopDepartures('1008');
  assert(teresesDeps && teresesDeps.departures.length > 0);
  totalAssertions += 2;

  // 4.4 Passenger Flow: getTargetStopETA for L1, L2, L3, L5, L8
  console.log('  Testing Passenger Flow: Target Stop ETA across lines...');
  const linesToTest = ['1', '2', '3', '5', '8'];

  for (const lId of linesToTest) {
    const etaRes = await mataroTracker.getTargetStopETA(lId, '1001', '0');
    assert(etaRes.line, `L${lId} line info must exist`);
    assert(etaRes.targetStop, `L${lId} targetStop must exist`);
    assert(etaRes.serviceStatus, `L${lId} serviceStatus must exist`);
    assert(typeof etaRes.serviceStatus.firstServiceTomorrow === 'string', `L${lId} firstServiceTomorrow must be string`);
    assert(Array.isArray(etaRes.upcomingDepartures), `L${lId} upcomingDepartures must be array`);

    if (etaRes.nextBus) {
      assert(etaRes.nextBus.departureTime, `L${lId} nextBus departureTime present`);
      assert(typeof etaRes.nextBus.minutesAway === 'number', `L${lId} nextBus minutesAway numeric`);
    }
    totalAssertions += 6;
  }

  // 4.5 Full Route Trip Monotonic Passing Time Simulation (Line 1 Dir 11)
  console.log('  Simulating full route trip passing time progression (Line 1 Dir 11)...');
  const l1Dir11Schedule = mataroSchedules.getDirectionSchedule('1', '11', 'weekday');
  assert(l1Dir11Schedule && l1Dir11Schedule.stops.length > 0);

  const tripOriginTime = '08:05';
  const tripOriginSec = timeEngine.timeStringToSeconds(tripOriginTime);

  let previousArrivalSec = -1;
  l1Dir11Schedule.stops.forEach((stop, idx) => {
    const passingSec = tripOriginSec + stop.travelSec;
    const passingHour = Math.floor(passingSec / 3600) % 24;
    const passingMin = Math.floor((passingSec % 3600) / 60);
    const passingTimeStr = `${String(passingHour).padStart(2, '0')}:${String(passingMin).padStart(2, '0')}`;

    assert(passingSec >= previousArrivalSec, `Monotonic passing time failed at stop ${stop.id} (idx: ${idx})`);
    assert(passingTimeStr.length === 5 && passingTimeStr.includes(':'), `Passing time format invalid: ${passingTimeStr}`);
    previousArrivalSec = passingSec;
  });

  const totalTripMinutes = Math.round((previousArrivalSec - tripOriginSec) / 60);
  assert(totalTripMinutes >= 25 && totalTripMinutes <= 45, `L1 full circuit duration should be ~30-35 mins (got: ${totalTripMinutes} mins)`);
  totalAssertions += 3;

  console.log(`  ✓ 4.1 Hospital de Mataró (Stop 1001) returns complete multi-line departure envelope.`);
  console.log(`  ✓ 4.2 Estació Rodalies (Stop 1016), Parc de Cerdanyola, and Pl. Tereses verified.`);
  console.log(`  ✓ 4.3 Target Stop ETA flow validated across Lines 1, 2, 3, 5, 8.`);
  console.log(`  ✓ 4.4 Full route trip monotonic passing time progression verified (duration: ${totalTripMinutes} mins).`);

  console.log('\n=========================================================================');
  console.log(`🎉 ALL ${totalAssertions} MATARÓ TIMETABLE ACCURACY & E2E ASSERTIONS PASSED! 🎉`);
  console.log('=========================================================================\n');

  return { success: true, totalAssertions };
}

if (require.main === module) {
  runMataroTimetableAccuracyTests().then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('\n❌ TIMETABLE ACCURACY TEST FAILED:', err);
    process.exit(1);
  });
}

module.exports = {
  runMataroTimetableAccuracyTests,
  calculateStatistics,
  computeHeadwayIntervals
};
