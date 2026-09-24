/**
 * stop_passed_estimation_test.js
 *
 * THE REGRESSION TEST FOR "ARRIVES NOW HERE, BUT 2 MIN AWAY AT THE PREVIOUS STOP".
 *
 * A rider on L8 saw the board at La Coma (stop 1139) claim the next bus was 3 min
 * early and ARRIVING NOW, while the previous stop, Pl. Fiveller (stop 1138),
 * showed the same bus as "En ruta, coming in 2 mins". A bus cannot be arriving at
 * La Coma while still two minutes short of Fiveller, which it must pass to get
 * there. The two boards also disagreed about the KIND of data: real-time at one,
 * estimated at the other.
 *
 * Cause: estimateArrivalsForStop decided "has this bus passed this stop?" from the
 * bus's NEAREST stop index, using `<=`. The nearest stop is the one a bus is
 * approaching OR the one it just left, so a nearest-stop index cannot tell those
 * apart. A bus that had just left Fiveller, while Fiveller was still its closest
 * stop, passed the guard -- and the distance to the stop was then measured with
 * an UNSIGNED polyline call, i.e. backwards, to a stop already served. The result
 * was a confident, plausible-looking "2 min". SIRI itself was right: its
 * StopMonitoring correctly omitted that bus from Fiveller, because it had passed.
 *
 * Observed on the real code path, one bus, one instant:
 *   La Coma    1139 -> 0 min "Imminent", isRealTime: true
 *   Pl.Fiveller 1138 -> 2 min, isEstimated: true, "En ruta (Bus #2677)"
 *
 * These fixtures are positions on the REAL L8 direction 12 polyline, expressed as
 * metres along the route, so the suite is deterministic and needs no live feed.
 * Pl. Fiveller sits ~1782m and La Coma ~2086m along that direction.
 */

'use strict';

const mataroTracker = require('../src/mataroTracker');
const mataroSiriClient = require('../src/mataroSiriClient');
const flightRecorder = require('../src/flightRecorder');
const geoEngine = require('../src/core/geo/geoEngine');

let passed = 0;
const failed = [];

function check(cond, msg) {
  if (cond) { passed++; return; }
  failed.push(msg);
}

// Keep the suite offline: no live SIRI fetch, and no live fleet.
mataroSiriClient.circuitOpenUntil = Date.now() + 600000;

// estimateArrivalsForStop takes its vehicles from getLineDetails() FIRST, and
// only falls back to the flight recorder / vehicleHistory when that returns
// none. The in-memory fleet holds timetable ghosts for L8 at almost any hour,
// so a test bus recorded into the recorder alone would be discarded before the
// code under test ever saw it -- and every "must not be offered" assertion
// would then pass vacuously. Point the fleet at the recorder, which this suite
// fully controls, so the ONLY buses in play are the ones placed below. The
// estimator's own logic (nearest-stop resolution, signed along-route progress,
// ETA assembly) runs completely unmodified.
mataroTracker.getLineDetails = async (lineId) => ({
  activeBuses: flightRecorder.getLineVehicles(`L${lineId}`)
});

const TEST_BUS = 'TESTBUS_PASSED_STOP';

function routeFor(lineId, dirId) {
  const list = mataroTracker.routesData[String(lineId)] || [];
  return list.find(r => String(r.id) === String(dirId));
}

function polylineOf(route) {
  return (route.coords || []).map(c => ({ lat: parseFloat(c.Latitude), lon: parseFloat(c.Longitude) }));
}

// Along-route metres of a stop, measured from the start of the direction.
function stopAlong(coords, stop) {
  const lat = stop.latitude !== undefined ? parseFloat(stop.latitude) : stop.lat;
  const lon = stop.longitude !== undefined ? parseFloat(stop.longitude) : stop.lon;
  return geoEngine.calculatePolylineDistanceBetween(coords, coords[0].lat, coords[0].lon, lat, lon);
}

// Put the test bus at a chosen point along the route. It is ingested into the
// flight recorder (the fleet source wired up above) and into the tracker's own
// vehicle history, so it is found no matter which of the two the estimator
// reaches for. Ingesting the same id again overwrites the previous position,
// which is what makes the re-placement between cases reliable.
function placeBus(lineId, coords, table, alongMeters, dirId) {
  const p = geoEngine.pointAtDistance(coords, table, alongMeters);
  const snap = {
    vehicleId: TEST_BUS,
    lineId: String(lineId),
    lineCode: `L${lineId}`,
    agency: 'Mataró Bus (Avanza)',
    direction: String(dirId),
    directionName: 'Galícia',
    lat: p.lat,
    lon: p.lon,
    bearing: p.bearing || 0,
    speedKmh: 18,
    delayMins: 0,
    isRealTime: true,
    isEstimated: false,
    observedAt: Date.now(),
    lastSeen: Date.now()
  };
  flightRecorder.ingestVehicle(snap);
  mataroTracker.recordVehicleState(snap);
  return snap;
}

function placeBusAt(coords, table, alongMeters, dirId) {
  return placeBus('8', coords, table, alongMeters, dirId);
}

async function estimateAt(stopId, lineId = '8') {
  const rows = await mataroTracker.estimateArrivalsForStop(stopId, lineId, [], { skipSiri: true, skipCache: true });
  return rows.find(r => r.vehicleId === TEST_BUS) || null;
}

(async function run() {
  const route = routeFor('8', '12');
  if (!route) {
    console.error('FATAL: L8 direction 12 not found in tracker route data');
    process.exit(1);
  }
  const coords = polylineOf(route);
  const table = geoEngine.buildPolylineDistanceTable(coords);
  const total = Math.round(table.total);

  const fiveller = route.stops.find(s => String(s.id) === '1138');
  const laComa = route.stops.find(s => String(s.id) === '1139');
  const FIV = Math.round(stopAlong(coords, fiveller));
  const COM = Math.round(stopAlong(coords, laComa));

  console.log(`L8 dir 12 route: ${total}m, ${coords.length} vertices`);
  console.log(`  Pl. Fiveller 1138 at ${FIV}m, La Coma 1139 at ${COM}m (gap ${COM - FIV}m)\n`);

  // -- 1. A bus genuinely still approaching must KEEP being offered ---------
  placeBusAt(coords, table, FIV - 582, route.id);
  let fiv = await estimateAt('1138');
  let com = await estimateAt('1139');
  check(fiv !== null, 'a bus 582m short of Fiveller must still be offered at Fiveller');
  check(com !== null, 'a bus 582m short of Fiveller must still be offered at La Coma');
  if (fiv && com) {
    check(fiv.minutesAway > 0 && fiv.minutesAway <= 5, `Fiveller ETA should be a few minutes, got ${fiv.minutesAway}`);
    check(com.minutesAway >= fiv.minutesAway, 'La Coma is further on, so its ETA must not be shorter than Fiveller\'s');
  }

  // -- 2. A bus standing AT a stop still reads as imminent -------------------
  placeBusAt(coords, table, FIV, route.id);
  fiv = await estimateAt('1138');
  check(fiv !== null, 'a bus at Fiveller must be offered at Fiveller (the "bus is here" case)');
  if (fiv) {
    check(fiv.minutesAway === 0, `a bus at Fiveller should be imminent, got ${fiv.minutesAway} min`);
    check(fiv.formattedStatus === 'Imminent', `expected "Imminent", got "${fiv.formattedStatus}"`);
  }

  // -- 3. THE DEFECT: a bus already past the stop must be dropped -----------
  placeBusAt(coords, table, FIV + 118, route.id);
  fiv = await estimateAt('1138');
  com = await estimateAt('1139');
  check(fiv === null, `a bus 118m PAST Fiveller must not be offered at Fiveller, got ${fiv ? fiv.minutesAway + ' min "' + fiv.formattedStatus + '"' : 'nothing'}`);
  check(com !== null, 'the same bus is still short of La Coma and must be offered there');
  if (com) {
    check(com.minutesAway >= 0, 'minutesAway must never be negative');
  }

  // -- 4. A bus at La Coma is long past Fiveller -----------------------------
  placeBusAt(coords, table, COM, route.id);
  fiv = await estimateAt('1138');
  com = await estimateAt('1139');
  check(fiv === null, 'a bus at La Coma must not be offered at Fiveller');
  check(com !== null && com.minutesAway === 0, 'a bus at La Coma should be imminent there');

  // -- 5. Well past both ----------------------------------------------------
  placeBusAt(coords, table, COM + 314, route.id);
  check(await estimateAt('1138') === null, 'a bus 314m past La Coma must not appear at Fiveller');
  check(await estimateAt('1139') === null, 'a bus 314m past La Coma must not appear at La Coma');

  // -- 6. Generalise: no stop on any direction may offer a bus beyond it ----
  // Sweeps every stop of the reported direction plus L1 direction 11, so the
  // defect cannot simply reappear on another line.
  //
  // The control run matters as much as the sweep. Without it a fixture whose
  // bus never reaches the estimator at all would report zero violations and
  // look like a pass, which is exactly the failure this suite first hit. The
  // control places the SAME bus 150m BEFORE each stop and requires it to be
  // offered; only then is its absence 150m afterwards meaningful.
  const PAST = 150;
  let swept = 0, violations = 0, controls = 0, controlFailures = 0;
  for (const [lineId, dirId] of [['8', '12'], ['1', '11']]) {
    const r = routeFor(lineId, dirId);
    if (!r) continue;
    const c = polylineOf(r);
    if (c.length < 2) continue;
    const t = geoEngine.buildPolylineDistanceTable(c);
    const lineTotal = t.total;

    for (const s of (r.stops || [])) {
      const at = stopAlong(c, s);
      // Skip the head, where there is no room to sit before the stop, and the
      // tail, where the bus would clamp to the terminus and legitimately still
      // be offered the final stop.
      if (at - PAST < 0 || at + PAST > lineTotal - 60) continue;

      // Control: the bus is short of this stop, so it MUST be offered here.
      placeBus(lineId, c, t, at - PAST, dirId);
      const offeredBefore = await estimateAt(s.id, lineId);
      controls++;
      if (!offeredBefore) {
        controlFailures++;
        failed.push(`CONTROL: L${lineId} dir ${dirId} stop ${s.id} (${s.name}) offered nothing for a bus ${PAST}m before it -- the fixture is not reaching the estimator`);
        continue; // absence 150m later would prove nothing
      }

      // The real assertion: the same bus, now past the stop, must be gone.
      placeBus(lineId, c, t, at + PAST, dirId);
      const offeredAfter = await estimateAt(s.id, lineId);
      swept++;
      if (offeredAfter) {
        violations++;
        failed.push(`L${lineId} dir ${dirId} stop ${s.id} (${s.name}): bus ${PAST}m past it was still offered at ${offeredAfter.minutesAway} min`);
      }
      check(offeredAfter === null || offeredAfter.minutesAway >= 0, `L${lineId} stop ${s.id}: minutesAway must never be negative`);
    }
  }
  console.log(`  swept ${swept} stop positions across L8 dir12 and L1 dir11, ${violations} violation(s)`);
  console.log(`  controls: ${controls} runs, ${controlFailures} failed (a control failure invalidates its sweep)\n`);

  console.log('=======================================================');
  if (failed.length === 0) {
    console.log('Total Passed Assertions:', passed);
    console.log('Total Failures Detected: 0');
    console.log('=======================================================');
    console.log('\n🎉 ALL STOP-PASSED-STOP ESTIMATION TESTS PASSED!\n');
    process.exit(0);
  }
  console.log('Total Passed Assertions:', passed);
  console.log('Total Failures Detected:', failed.length);
  console.log('=======================================================');
  for (const f of failed) console.log('  ✗ ' + f);
  console.log('\n❌ STOP-PASSED-STOP ESTIMATION TESTS FAILED\n');
  process.exit(1);
})().catch(err => {
  console.error('FATAL', err);
  process.exit(1);
});
