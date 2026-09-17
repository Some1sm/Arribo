const assert = require('node:assert/strict');
const http = require('node:http');
const bridge = require('../src/core/WorkerBridge');
bridge.start = () => {};
const tracker = require('../src/mataroTracker');
const walking = require('../src/core/geo/pedestrianRouter');
const schedules = require('../src/data/mataroSchedules');
const timeline = require('../src/core/schedule/journeyTimeline');
let appServer;
let provider;
const original = { plan: tracker.planJourney, schedule: schedules.getDirectionSchedule, now: Date.now };
(async () => {
  Date.now = () => Date.parse('2026-09-17T08:00:00Z');
  let calls = 0;
  provider = http.createServer((req, res) => {
    assert.equal(req.url, '/v2/directions/foot-walking/geojson');
    assert.equal(req.method, 'POST');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      calls++;
      const coordinates = JSON.parse(body).coordinates;
      assert.deepEqual(coordinates, [[2.44, 41.54], [2.441, 41.541]]);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ features: [{ geometry: { type: 'LineString', coordinates }, properties: { summary: { distance: 300, duration: 240 } } }] }));
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  walking.url = `http://127.0.0.1:${provider.address().port}`;
  schedules.getDirectionSchedule = () => ({ departures: ['10:03', '10:10'], stopTravelSecMap: { a: 0, b: 600 } });
  tracker.planJourney = async (from, to, options) => {
    assert.equal(options.preference, 'least_walking');
    return { success: true, itineraries: await timeline.evaluate([{
      walkToFirstStop: { from: [41.54, 2.44], to: [41.541, 2.441] },
      legs: [{ lineId: '1', direction: '0', fromStop: { id: 'a' }, toStop: { id: 'b' }, durationMinutes: 10 }]
    }], null, options) };
  };
  appServer = require('../server').listen(0, '127.0.0.1');
  await new Promise(resolve => appServer.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${appServer.address().port}/api/plan?from=1001&to=1002&preference=least_walking&walkingSpeed=60`);
  assert.equal(response.status, 200);
  const itinerary = (await response.json()).itineraries[0];
  assert.equal(itinerary.walkToFirstStop.source, 'openrouteservice');
  assert.equal(itinerary.walkToFirstStop.durationSeconds, 300);
  assert.deepEqual(itinerary.walkToFirstStop.polyline[0], [41.54, 2.44]);
  assert.equal(itinerary.legs[0].boardAt, '2026-09-17T08:10:00.000Z');
  assert.equal(itinerary.arrivalAt, '2026-09-17T08:20:00.000Z');
  assert.equal(itinerary.totalDurationMinutes, 20);
  await walking.route([41.54, 2.44], [41.541, 2.441]);
  assert.equal(calls, 1);
  const fallback = await new walking.PedestrianRouter({ url: '' }).route([41.54, 2.44], [41.541, 2.441]);
  assert.equal(fallback.approximate, true);
  assert.throws(() => timeline.requestedInstant({ departureDate: '2026-03-29', departureTime: '02:30' }));
  console.log('PASS: planner HTTP → timeline → ORS foot-walking, geometry, catchable departure, total arrival, cache and fallback');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  tracker.planJourney = original.plan;
  schedules.getDirectionSchedule = original.schedule;
  Date.now = original.now;
  if (appServer) await new Promise(resolve => appServer.close(resolve));
  if (provider) await new Promise(resolve => provider.close(resolve));
});
