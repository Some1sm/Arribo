/**
 * test/adversarial_audit_test.js
 * 
 * Hostile Stress-Testing & Adversarial Edge Case Suite
 * Forensic Verification for Milestone 1 Core Transit Modules
 */

const assert = require('assert');

const geoEngine = require('../src/core/geo/geoEngine');
const timeEngine = require('../src/core/time/timeEngine');
const calendarEngine = require('../src/core/time/calendarEngine');
const scheduleSynthesizer = require('../src/core/schedule/scheduleSynthesizer');
const delayEngine = require('../src/core/schedule/delayEngine');
const BaseTracker = require('../src/core/BaseTracker');
const trackerRegistry = require('../src/core/TrackerRegistry');

console.log('🔬 Starting Hostile Adversarial Stress Test Suite...\n');

// =========================================================================
// 1. GEO ENGINE ADVERSARIAL CHECKS
// =========================================================================
console.log('--- 1. Testing GeoEngine Edge Cases ---');

// Antipodal points (North Pole to South Pole)
const poleDist = geoEngine.calculateDistanceMeters(90, 0, -90, 0);
assert(Math.abs(poleDist - Math.PI * 6371000) < 100, `Pole distance error: ${poleDist}`);

// Anti-meridian crossing
const merDist = geoEngine.calculateDistanceMeters(0, 179.9, 0, -179.9);
assert(merDist < 25000, `Anti-meridian distance error: ${merDist}`);

// Weird normalizeCoord inputs
assert.deepStrictEqual(geoEngine.normalizeCoord(null), { lat: 0, lon: 0 });
assert.deepStrictEqual(geoEngine.normalizeCoord(undefined), { lat: 0, lon: 0 });
assert.deepStrictEqual(geoEngine.normalizeCoord({ lat: '41.5', lng: '2.4' }), { lat: 41.5, lon: 2.4 });
assert.deepStrictEqual(geoEngine.normalizeCoord({ Latitude: 41.5, Longitude: 2.4 }), { lat: 41.5, lon: 2.4 });
assert.deepStrictEqual(geoEngine.normalizeCoord({ y: 41.5, x: 2.4 }), { lat: 41.5, lon: 2.4 });
assert.deepStrictEqual(geoEngine.normalizeCoord([41.5, 2.4]), { lat: 41.5, lon: 2.4 });

// Polyline Snapping with 0-length segment (duplicate vertex)
const polyDup = [{ lat: 41.5, lon: 2.4 }, { lat: 41.5, lon: 2.4 }, { lat: 41.6, lon: 2.5 }];
const snapDup = geoEngine.snapPointToPolyline(41.5, 2.4, polyDup);
assert.strictEqual(snapDup.lat, 41.5);
assert.strictEqual(snapDup.lon, 2.4);

// Extrapolate with 0 elapsed and huge elapsed
const extrap0 = geoEngine.extrapolatePolylinePosition({ lat: 41.5, lon: 2.4 }, 0, 30, polyDup);
assert.strictEqual(extrap0.progress, 0);

const extrapHuge = geoEngine.extrapolatePolylinePosition({ lat: 41.5, lon: 2.4 }, 999999, 50, polyDup);
assert.strictEqual(extrapHuge.progress, 100);
assert.strictEqual(extrapHuge.lat, 41.6);
assert.strictEqual(extrapHuge.lon, 2.5);

// Decode Polyline empty / malformed
assert.deepStrictEqual(geoEngine.decodePolyline(''), []);
assert.deepStrictEqual(geoEngine.decodePolyline(null), []);

console.log('✅ GeoEngine survived adversarial stress tests.');

// =========================================================================
// 2. TIME & CALENDAR ENGINE ADVERSARIAL CHECKS
// =========================================================================
console.log('\n--- 2. Testing Time & Calendar Engine Edge Cases ---');

// Overnight GTFS times (> 24:00)
assert.strictEqual(timeEngine.timeStringToMinutes('25:15'), 1515);
assert.strictEqual(timeEngine.minutesToTimeString(1515), '25:15');
assert.strictEqual(timeEngine.timeStringToSeconds('25:15:30'), 90930);
assert.strictEqual(timeEngine.secondsToTimeString(90930), '01:15:30'); // wraps modulo 24 for seconds

// Non-string / null conversions
assert.strictEqual(timeEngine.timeStringToMinutes(null), 0);
assert.strictEqual(timeEngine.timeStringToSeconds(undefined), 0);

// DST Transitions in Europe/Madrid
// Winter (CET = UTC+1): 2026-01-15 12:00 UTC -> 13:00 Madrid
const winterDate = new Date('2026-01-15T12:00:00Z');
const netWinter = timeEngine.getNetworkTime('Europe/Madrid', winterDate);
assert.strictEqual(netWinter.hour, 13);

// Summer (CEST = UTC+2): 2026-07-15 12:00 UTC -> 14:00 Madrid
const summerDate = new Date('2026-07-15T12:00:00Z');
const netSummer = timeEngine.getNetworkTime('Europe/Madrid', summerDate);
assert.strictEqual(netSummer.hour, 14);

// Defensive formatTimeToTimezone
assert.strictEqual(timeEngine.formatTimeToTimezone('0001-01-01T00:00:00Z'), '--:--');
assert.strictEqual(timeEngine.formatTimeToTimezone('1970-01-01T00:00:00Z'), '--:--');
assert.strictEqual(timeEngine.formatTimeToTimezone('1998-05-15T12:00:00Z'), '--:--');
assert.strictEqual(timeEngine.formatTimeToTimezone('2026-08-21T10:00:00Z', 'Europe/Madrid'), '12:00');

// C-10 Summer boundary check (GEN_185017: Sunday & 0615..0915)
const sundayBeforeSummer = new Date('2026-06-07T12:00:00Z'); // June 7 Sunday
assert.strictEqual(calendarEngine.isServiceActiveOnDate('GEN_185017', null, null, sundayBeforeSummer), false);

const sundayInSummer = new Date('2026-06-21T12:00:00Z'); // June 21 Sunday
assert.strictEqual(calendarEngine.isServiceActiveOnDate('GEN_185017', null, null, sundayInSummer), true);

console.log('✅ Time & Calendar Engine survived adversarial stress tests.');

// =========================================================================
// 3. SCHEDULE SYNTHESIZER & DELAY ENGINE ADVERSARIAL CHECKS
// =========================================================================
console.log('\n--- 3. Testing Schedule & Delay Engine Edge Cases ---');

// Empty stops
assert.deepStrictEqual(scheduleSynthesizer.estimateStopTravelTimes([]), []);

// Single stop
const singleStop = scheduleSynthesizer.estimateStopTravelTimes([{ id: 'S1', name: 'Only Stop', lat: 41.5, lon: 2.4 }]);
assert.strictEqual(singleStop.length, 1);
assert.strictEqual(singleStop[0].travelSec, 0);

// Delay Status Threshold boundaries
// Threshold delay: +2 min -> delayed; +1 min -> on_time
const delay1 = delayEngine.computeDelayStatus(1, true);
assert.strictEqual(delay1.delayStatus, 'on_time');

const delay2 = delayEngine.computeDelayStatus(2, true);
assert.strictEqual(delay2.delayStatus, 'delayed');

const early1 = delayEngine.computeDelayStatus(-1, true);
assert.strictEqual(early1.delayStatus, 'on_time');

const early2 = delayEngine.computeDelayStatus(-2, true);
assert.strictEqual(early2.delayStatus, 'early');

// Midnight Wrap-Around Delay Matching:
// Live bus at 00:02, scheduled trip was 23:58 (4 minutes late across midnight)
const midnightMatch1 = delayEngine.findClosestScheduledTime('00:02', ['23:58', '00:30']);
assert.strictEqual(midnightMatch1.matched, true);
assert.strictEqual(midnightMatch1.scheduledTime, '23:58');
assert.strictEqual(midnightMatch1.delayMinutes, 4);

// Live bus at 23:57, scheduled trip is 00:03 (6 minutes early across midnight)
const midnightMatch2 = delayEngine.findClosestScheduledTime('23:57', ['23:15', '00:03']);
assert.strictEqual(midnightMatch2.matched, true);
assert.strictEqual(midnightMatch2.scheduledTime, '00:03');
assert.strictEqual(midnightMatch2.delayMinutes, -6);

console.log('✅ Schedule Synthesizer & Delay Engine survived adversarial stress tests.');

// =========================================================================
// 4. BASE TRACKER & DEDUPLICATION STRESS TESTS
// =========================================================================
console.log('\n--- 4. Testing BaseTracker Telemetry Deduplication Under Load ---');

const base = new BaseTracker();

// 100 duplicate vehicles: 50 estimated + 50 real GPS for identical vehicle IDs
const fleet = [];
for (let i = 1; i <= 50; i++) {
  fleet.push({
    vehicleId: `BUS_${i}`,
    lat: 41.5 + i * 0.001,
    lon: 2.4 + i * 0.001,
    bearing: 90,
    isEstimated: true,
    isRealTime: false
  });
  fleet.push({
    vehicleId: `BUS_${i}`,
    lat: 41.5 + i * 0.001 + 0.0001,
    lon: 2.4 + i * 0.001 + 0.0001,
    bearing: 95,
    isEstimated: false,
    isRealTime: true
  });
}

const deduped = base.deduplicateBuses(fleet);
assert.strictEqual(deduped.length, 50, `Expected exactly 50 buses after deduping 100 entries, got ${deduped.length}`);
assert(deduped.every(b => b.isEstimated === false && b.isRealTime === true), 'All remaining buses must be authentic real GPS telemetry');

console.log('✅ BaseTracker deduplication under load passed 100%.');

console.log('\n🎉 ALL ADVERSARIAL STRESS TESTS PASSED WITH ZERO FAILURES! 🎉\n');
