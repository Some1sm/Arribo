'use strict';

const assert = require('node:assert/strict');
const bridge = require('../src/core/WorkerBridge');
bridge.start = () => {};
const tracker = require('../src/mataroTracker');
const streetGeocoder = require('../src/core/geo/streetGeocoder');

let appServer;
const originalPlan = tracker.planJourney;
const originalSearchStreets = streetGeocoder.searchStreets;

(async () => {
  const captured = [];
  let geocoderCalls = 0;

  tracker.planJourney = async (origin, destination) => {
    captured.push({ origin, destination });
    return { success: true, itineraries: [] };
  };

  streetGeocoder.searchStreets = async () => {
    geocoderCalls++;
    return [];
  };

  appServer = require('../server').listen(0, '127.0.0.1');
  await new Promise(resolve => appServer.once('listening', resolve));
  const port = appServer.address().port;

  // Case 1: from=rodalies&to=hospital%20de%20mataro
  captured.length = 0;
  geocoderCalls = 0;
  const res1 = await fetch(`http://127.0.0.1:${port}/api/mataro/plan?from=rodalies&to=hospital%20de%20mataro`);
  assert.equal(res1.status, 200);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].origin, 'Rodalies');
  assert.equal(captured[0].destination, 'Hospital de Mataró');
  assert.equal(geocoderCalls, 0);

  // Case 2: from=PL.%20TERESES&to=Hospital%20de%20Matar%C3%B3
  captured.length = 0;
  geocoderCalls = 0;
  const res2 = await fetch(`http://127.0.0.1:${port}/api/mataro/plan?from=PL.%20TERESES&to=Hospital%20de%20Matar%C3%B3`);
  assert.equal(res2.status, 200);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].origin, 'Pl. Tereses');
  assert.equal(captured[0].destination, 'Hospital de Mataró');

  // Case 3: from=Carrer%20Inventat%20123&to=1001
  captured.length = 0;
  geocoderCalls = 0;
  const res3 = await fetch(`http://127.0.0.1:${port}/api/mataro/plan?from=Carrer%20Inventat%20123&to=1001`);
  assert.equal(res3.status, 200);
  assert.equal(captured.length, 1);
  assert.equal(geocoderCalls, 1);
  assert.equal(captured[0].destination, '1001');

  console.log('✅ PLANNER STOP NAME TEST PASSED');
  process.exit(0);
})().catch(error => {
  console.error(error);
  process.exit(1);
}).finally(async () => {
  tracker.planJourney = originalPlan;
  streetGeocoder.searchStreets = originalSearchStreets;
  if (appServer?.listening) await new Promise(resolve => appServer.close(resolve));
});
