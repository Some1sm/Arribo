/**
 * test/mataro_line8_regulation_false_positive_test.js
 *
 * Regression test verifying that in-transit vehicles on Line 8 far away from the origin
 * terminal (e.g. vehicle 2664 50 min away from Ronda Barceló and 33 min before origin departure)
 * are NEVER falsely tagged as 'Regulant a Galícia' or marked as in origin regulation.
 */

const assert = require('assert');
const tracker = require('../src/mataroTracker');
const siriClient = require('../src/mataroSiriClient');

async function runTest() {
  console.log('🧪 Running Line 8 False Origin Regulation Regression Test...');

  const origSiri = siriClient.getStopArrivals;
  const simDate = new Date('2026-09-13T14:12:00+02:00'); // Sunday at 14:12

  try {
    // 1. User bug scenario: Stop 1057 (Ronda Barceló), vehicle 2664 en route ~2.5km from Galícia
    // Departure at 15:02 (50 min away), scheduled origin departure at 14:45 (33 min away)
    siriClient.getStopArrivals = async (stopId, lineRef) => {
      if (stopId === '1057') {
        return [{
          lineId: '8',
          lineName: 'Rodalies - Galícia',
          destination: 'Rodalies',
          directionId: '0',
          vehicleId: '2664',
          departureTime: '15:02',
          scheduledTime: '15:00',
          expectedIso: '2026-09-13T15:02:00+02:00',
          aimedIso: '2026-09-13T15:00:00+02:00',
          minutesAway: 50,
          delayMins: 2,
          isRealTime: true,
          busCoords: { lat: 41.535, lon: 2.440 } // ~2.5km away from Galícia terminal
        }];
      }
      return [];
    };

    const res = await tracker.getStopDepartures('1057', '8', '0', { targetDate: simDate, skipCache: true });
    const dep2664 = (res.departures || []).find(d => String(d.vehicleId) === '2664');

    assert.ok(dep2664, 'Vehicle 2664 must be present in departures');
    assert.strictEqual(dep2664.isRegulating, false, 'Vehicle 2664 must NOT be marked as regulating');
    assert.strictEqual(dep2664.isOriginRegulating, false, 'Vehicle 2664 must NOT have isOriginRegulating=true');
    assert.strictEqual(dep2664.originTerminalName, null, 'Vehicle 2664 originTerminalName must be null');
    assert.strictEqual(dep2664.delayStatus, 'delayed', 'Vehicle 2664 delayStatus must be "delayed"');
    assert.strictEqual(dep2664.delayBadgeText, '+2 min retard', 'Vehicle 2664 delayBadgeText must show delay badge');
    if (dep2664.statusText) {
      assert.ok(!dep2664.statusText.includes('Regulant a Galícia'), 'statusText must not say Regulant a Galícia');
    }
    console.log('  ✓ Scenario 1 Passed: In-transit bus 33m before origin departure is NOT marked as regulating at Galícia.');

    // 2. Legitimate turnaround scenario: Bus actually at Galícia terminal within 5 min of departure
    const turnaroundDate = new Date('2026-09-13T14:41:00+02:00'); // 4 min before 14:45 departure
    siriClient.getStopArrivals = async (stopId, lineRef) => {
      if (stopId === '1057') {
        return [{
          lineId: '8',
          lineName: 'Rodalies - Galícia',
          destination: 'Rodalies',
          directionId: '0',
          vehicleId: '2664',
          departureTime: '15:02',
          scheduledTime: '15:00',
          expectedIso: '2026-09-13T15:02:00+02:00',
          aimedIso: '2026-09-13T15:00:00+02:00',
          minutesAway: 21,
          delayMins: 2,
          isRealTime: true,
          busCoords: { lat: 41.5478, lon: 2.4273 } // At Galícia terminal (stop 1132)
        }];
      }
      return [];
    };

    const resTurnaround = await tracker.getStopDepartures('1057', '8', '0', { targetDate: turnaroundDate, skipCache: true });
    const depTurnaround = (resTurnaround.departures || []).find(d => String(d.vehicleId) === '2664');

    assert.ok(depTurnaround, 'Vehicle 2664 must be present during legitimate turnaround');
    assert.strictEqual(depTurnaround.isOriginRegulating, true, 'Vehicle 2664 must be in origin regulation when at terminal within 5m');
    assert.strictEqual(depTurnaround.originTerminalName, 'Galícia', 'originTerminalName must be Galícia');
    console.log('  ✓ Scenario 2 Passed: Bus physically stationed at Galícia terminal within 5m correctly tags origin regulation.');

  } finally {
    siriClient.getStopArrivals = origSiri;
  }

  console.log('🎉 ALL LINE 8 ORIGIN REGULATION TESTS PASSED 100%!\n');
}

runTest().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
