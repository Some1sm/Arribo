const assert = require('node:assert/strict');
const client = require('../src/mataroSiriClient');
const OriginalDate = Date;
const originalSoap = client.callSoap;
const now = Date.parse('2026-09-17T21:55:00Z');
const visit = (id, expected, recordedAt = '') => `<MonitoredStopVisit><LineRef>1</LineRef><VehicleRef>${id}</VehicleRef><ExpectedArrivalTime>${expected}</ExpectedArrivalTime><AimedArrivalTime>${expected}</AimedArrivalTime>${recordedAt ? `<RecordedAtTime>${recordedAt}</RecordedAtTime>` : ''}</MonitoredStopVisit>`;

(async () => {
  global.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  client.setRpcBackend(null);
  client.cache.clear();
  client.circuitOpenUntil = 0;

  // Live fetch: two arrivals, one with a valid observation, one with a stale one
  client.callSoap = async () => [
    visit('fresh', '2026-09-17T22:00:00Z', '2026-09-17T21:54:40Z'),
    visit('stale-observed', '2026-09-17T22:01:00Z', '2026-09-17T20:00:00Z'),
    visit('no-observed', '2026-09-17T22:02:00Z')
  ].join('');
  const arrivals = await client.getStopArrivals('2002', '1');
  assert.equal(arrivals.length, 3);
  const fresh = arrivals.find(a => a.vehicleId === 'fresh');
  assert.equal(fresh.freshness.source, 'live');
  assert.equal(fresh.freshness.fetchedAt, now);
  assert.equal(fresh.freshness.observedAt, Date.parse('2026-09-17T21:54:40Z'));
  assert.equal(arrivals.find(a => a.vehicleId === 'stale-observed').freshness.observedAt, null);
  assert.equal(arrivals.find(a => a.vehicleId === 'no-observed').freshness.observedAt, null);

  // Cached hit preserves metadata untouched
  const cached = await client.getStopArrivals('2002', '1');
  assert.equal(cached.find(a => a.vehicleId === 'fresh').freshness.fetchedAt, now);
  assert.equal(cached.find(a => a.vehicleId === 'fresh').freshness.fallback, undefined);

  // Upstream failure: fallback flags staleness but keeps original metadata
  client.cache.get('stop_2002_1').ts = now - 120000;
  client.callSoap = async () => { throw new Error('upstream 503'); };
  const fallback = await client.getStopArrivals('2002', '1');
  assert.equal(fallback.length, 3);
  const fallbackFresh = fallback.find(a => a.vehicleId === 'fresh');
  assert.equal(fallbackFresh.freshness.fallback, true);
  assert.equal(fallbackFresh.freshness.fetchedAt, now);
  assert.equal(fallbackFresh.freshness.source, 'live');
  assert.equal(fallbackFresh.isRealTime, false);

  // Empty successful upstream response is a success, not an error: it does not revive old cache
  client.cache.get('stop_2002_1').ts = now - 120000;
  client.callSoap = async () => '';
  const empty = await client.getStopArrivals('2002', '1');
  assert.deepEqual(empty, []);
  console.log('PASS: freshness metadata survives cache, flags fallback, and empty responses win over stale data');
})().finally(() => {
  global.Date = OriginalDate;
  client.callSoap = originalSoap;
}).catch(error => { console.error(error); process.exitCode = 1; });
