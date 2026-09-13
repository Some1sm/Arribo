/**
 * test/mataro_turnaround_propagation_test.js
 * 
 * Regression test suite verifying that when a vehicle is terminating/regulating at
 * an origin terminal (e.g. Stop 1016 Rodalies) with a delay, downstream stops
 * (e.g. Stop 1017 Ronda Barceló, Stop 1018 Pl. Doctor Fleming) properly receive
 * and display the projected departure with origin terminal regulation tags,
 * and scheduled departures preserve accurate local Europe/Madrid time without UTC offsets.
 */

const assert = require('assert');
const tracker = require('../src/mataroTracker');
const siriClient = require('../src/mataroSiriClient');

async function runTest() {
  console.log('🧪 Running Mataró Turnaround & Downstream Propagation Regression Test...');

  const simDate = new Date('2026-09-13T13:55:00+02:00'); // Sunday at 13:55
  const origGetStopArrivals = siriClient.getStopArrivals;

  try {
    // Mock SIRI: incoming vehicle terminating at Rodalies (1016) at 13:55
    siriClient.getStopArrivals = async (stopId) => {
      if (stopId === '1016') {
        return [{
          lineId: '1',
          lineName: 'Circular',
          directionName: 'Hospital - Rodalies',
          destination: 'Rodalies',
          vehicleId: '2680',
          departureTime: '13:55',
          expectedIso: '2026-09-13T13:55:00+02:00',
          aimedIso: '2026-09-13T13:50:00+02:00',
          minutesAway: 1,
          delayMins: 5,
          isRealTime: true
        }];
      }
      return [];
    };

    // 1. Check Stop 1016 (Rodalies)
    const d1016 = await tracker.getStopDepartures('1016', '1', '0', { dateObj: simDate, skipCache: true });
    assert(d1016 && d1016.departures && d1016.departures.length > 0, 'Stop 1016 should return departures');
    const dep1016 = d1016.departures[0];
    assert.strictEqual(dep1016.departureTime, '13:56', 'Stop 1016 departure time should be 13:56');
    assert.strictEqual(dep1016.scheduledTime, '13:51', 'Stop 1016 scheduled time should be 13:51');
    assert.strictEqual(dep1016.delayMins, 5, 'Stop 1016 delay should be 5 mins');
    assert.strictEqual(dep1016.isRegulating, true, 'Stop 1016 departure should be regulating');
    console.log('  ✓ Stop 1016 (Rodalies) departure correctly transitioned to 13:56 (+5 min delay)');

    // 2. Check Stop 1017 (Ronda Barceló, stop seq 2)
    const d1017 = await tracker.getStopDepartures('1017', '1', '0', { dateObj: simDate, skipCache: true });
    assert(d1017 && d1017.departures && d1017.departures.length > 0, 'Stop 1017 should return departures');
    const dep1017 = d1017.departures[0];

    assert.strictEqual(dep1017.departureTime, '13:57', 'Stop 1017 departure time should be 13:57 (13:56 + 67s)');
    assert.strictEqual(dep1017.scheduledTime, '13:52', 'Stop 1017 scheduled time should be 13:52 (13:51 + 67s)');
    assert.strictEqual(dep1017.minutesAway, 2, 'Stop 1017 minutes away should be 2 min');
    assert.strictEqual(dep1017.delayMins, 5, 'Stop 1017 delay should be 5 min');
    assert.strictEqual(dep1017.isRegulating, true, 'Stop 1017 should be marked isRegulating');
    assert.strictEqual(dep1017.isOriginRegulating, true, 'Stop 1017 should be marked isOriginRegulating');
    assert.strictEqual(dep1017.originTerminalName, 'Rodalies', 'Stop 1017 originTerminalName should be Rodalies');
    assert.strictEqual(dep1017.originDepartureTime, '13:56', 'Stop 1017 originDepartureTime should be 13:56');
    assert.strictEqual(dep1017.destination, 'Hospital de Mataró', 'Stop 1017 destination should be Hospital de Mataró');
    console.log('  ✓ Stop 1017 (Ronda Barceló) successfully receives projected 13:57 departure with regulation details');

    // 3. Check subsequent scheduled departures on Stop 1017 for UTC timezone offsets
    const dep1017_2 = d1017.departures[1];
    assert.strictEqual(dep1017_2.departureTime, '14:28', 'Departure 2 should be 14:28');
    assert.strictEqual(dep1017_2.scheduledTime, '14:28', 'Departure 2 scheduledTime should match departureTime (no UTC offset)');

    const dep1017_3 = d1017.departures[2];
    assert.strictEqual(dep1017_3.departureTime, '15:02', 'Departure 3 should be 15:02');
    assert.strictEqual(dep1017_3.scheduledTime, '15:02', 'Departure 3 scheduledTime must be 15:02 (no 13:02 UTC bug)');
    console.log('  ✓ Stop 1017 scheduled departures preserve Europe/Madrid time without UTC offsets');

    // 4. Check Stop 1018 (Pl. Doctor Fleming, stop seq 3)
    const d1018 = await tracker.getStopDepartures('1018', '1', '0', { dateObj: simDate, skipCache: true });
    const dep1018 = d1018.departures[0];
    assert.strictEqual(dep1018.departureTime, '13:59', 'Stop 1018 departure time should be 13:59 (13:56 + 156s)');
    assert.strictEqual(dep1018.minutesAway, 4, 'Stop 1018 minutes away should be 4 min');
    assert.strictEqual(dep1018.isOriginRegulating, true, 'Stop 1018 should be marked isOriginRegulating');
    console.log('  ✓ Stop 1018 (Pl. Doctor Fleming) successfully receives projected 13:59 departure');

    console.log('\n🎉 ALL DOWNSTREAM PROPAGATION REGRESSION TESTS PASSED 100%!');
  } finally {
    siriClient.getStopArrivals = origGetStopArrivals;
  }
}

runTest().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
