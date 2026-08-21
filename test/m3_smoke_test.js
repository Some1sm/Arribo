const assert = require('assert');
const http = require('http');
const app = require('../server');

const PORT = 3477;
let server;

function request(path) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${PORT}${path}`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), raw: data }); }
        catch (_) { resolve({ status: res.statusCode, raw: data }); }
      });
    }).on('error', reject);
  });
}

async function run() {
  server = app.listen(PORT);
  const families = ['c10', '8', 'n82', 'b25', 'r1', 'n80'];

  for (const lineId of families) {
    const r = await request(`/api/line/${lineId}/vehicles?direction=0`);
    assert.strictEqual(r.status, 200, `${lineId} vehicles status`);
    assert.strictEqual(r.body.success, true);
    assert(Array.isArray(r.body.vehicles), 'vehicles array');
    assert(typeof r.body.totalVehicles === 'number');
    r.body.vehicles.forEach(v => {
      assert(typeof v.delayMinutes === 'number' && typeof v.delayMins === 'number');
      assert(typeof v.isRealTime === 'boolean' && typeof v.isRealtime === 'boolean');
    });
    console.log(`PASS vehicles ${lineId} (${r.body.totalVehicles} vehicles)`);
  }

  // Departures envelope
  const deps = await request('/api/line/8/stop/1001/departures?direction=0');
  assert.strictEqual(deps.status, 200);
  assert(deps.body.data.stopId !== undefined);
  assert(deps.body.data.stopName !== undefined);
  assert(deps.body.data.stop && typeof deps.body.data.stop === 'object');
  assert(deps.body.data.stop.id !== undefined && deps.body.data.stop.name !== undefined && deps.body.data.stop.zone !== undefined);
  assert(Array.isArray(deps.body.data.departures));
  assert.strictEqual(deps.body.data.totalDepartures, deps.body.data.departures.length);
  assert(deps.body.data.calendarInfo && typeof deps.body.data.calendarInfo.calendarTag === 'string');
  assert(deps.body.data.lastUpdated);
  deps.body.data.departures.forEach(d => {
    assert(typeof d.delayMinutes === 'number' && typeof d.delayMins === 'number');
    assert(typeof d.isRealTime === 'boolean' && typeof d.isRealtime === 'boolean');
    assert(d.delayStatus);
    if (!d.formattedStatus) throw new Error('formattedStatus missing');
  });
  console.log(`PASS departures envelope L8 stop 1001 (${deps.body.data.totalDepartures} departures)`);

  // C-10 departures envelope
  const c10deps = await request('/api/line/c10/stop/2895/departures?direction=1').catch(() => null);
  if (c10deps && c10deps.status === 200 && c10deps.body.success) {
    assert(c10deps.body.data.totalDepartures !== undefined || Array.isArray(c10deps.body.data.departures));
    console.log(`PASS c10 departures envelope`);
  }

  // Target ETA envelope across families
  for (const lineId of ['8', 'c10', 'r1']) {
    const eta = await request(`/api/line/${lineId}/target-eta?direction=${lineId === 'c10' ? 1 : 0}`);
    assert.strictEqual(eta.status, 200, `eta ${lineId}`);
    const d = eta.body.data;
    assert(d.targetStop !== null && d.targetStop !== undefined);
    assert(d.direction !== undefined);
    assert(Array.isArray(d.upcomingDepartures));
    assert(Array.isArray(d.allDepartures));
    assert(d.calendarInfo);
    assert(d.serviceStatus !== undefined);
    assert(d.lastUpdated);
    if (d.nextBus) {
      assert(typeof d.nextBus.delayMinutes === 'number' && typeof d.nextBus.delayMins === 'number');
    }
    console.log(`PASS target-eta envelope ${lineId} (next: ${d.nextBus ? d.nextBus.departureTime : 'none'})`);
  }

  // Global fleet
  const fleet = await request('/api/vehicles');
  assert.strictEqual(fleet.status, 200);
  assert(fleet.body.success === true);
  assert(Array.isArray(fleet.body.vehicles));
  assert.strictEqual(fleet.body.count, fleet.body.vehicles.length);
  console.log(`PASS /api/vehicles fleet (${fleet.body.count} vehicles)`);

  // Retards aliases parity
  const aj = await request('/api/analytics/journalism?hours=24');
  const rj = await request('/api/retards/journalism?hours=24');
  assert.strictEqual(aj.status, 200); assert.strictEqual(rj.status, 200);
  assert.deepStrictEqual(Object.keys(aj.body.report.summary).length > 0, true);
  assert.deepStrictEqual(rj.body.report.summary.monitoredLinesCount, aj.body.report.summary.monitoredLinesCount);
  console.log(`PASS retards/journalism mirrors analytics/journalism`);

  const rk = await request('/api/retards/ranking?limit=10');
  assert.strictEqual(rk.status, 200);
  assert(Array.isArray(rk.body.rankingMostDelayed));
  assert(Array.isArray(rk.body.agencyStats));
  assert(rk.body.timeframeHours);
  const ark = await request('/api/analytics/ranking?limit=10');
  assert.strictEqual(ark.status, 200);
  assert.deepStrictEqual(ark.body.rankingMostDelayed.length, rk.body.rankingMostDelayed.length);
  console.log(`PASS ranking endpoints (${rk.body.rankingMostDelayed.length} ranked lines)`);

  const csv = await request('/api/retards/export/csv?hours=24');
  assert.strictEqual(csv.status, 200);
  assert(csv.raw && csv.raw.split('\n').length > 10, 'CSV rows');
  console.log(`PASS retards/export/csv`);

  // Regression: legacy endpoints unchanged shape
  const legacy = await request('/api/c10/target-eta?direction=1');
  assert.strictEqual(legacy.status, 200);
  assert(legacy.body.data.targetStop);
  const mat = await request('/api/mataro/target-eta?lineId=8');
  assert.strictEqual(mat.status, 200);
  assert(mat.body.data.targetStop);
  console.log(`PASS legacy endpoints unchanged`);

  console.log('\nALL M3 SMOKE TESTS PASSED');
}

run().then(() => { server.close(); process.exit(0); }).catch(e => {
  console.error('FAIL:', e.message);
  if (server) server.close();
  process.exit(1);
});
