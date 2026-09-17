const assert = require('node:assert/strict');
const client = require('../src/mataroSiriClient');
const OriginalDate = Date;
const originalSoap = client.callSoap;
const now = Date.parse('2026-09-17T21:55:00Z');
const visit = (id, expected, aimed = expected) => `<MonitoredStopVisit><LineRef>1</LineRef><VehicleRef>${id}</VehicleRef><ExpectedArrivalTime>${expected}</ExpectedArrivalTime><AimedArrivalTime>${aimed}</AimedArrivalTime></MonitoredStopVisit>`;

(async () => {
  global.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  client.setRpcBackend(null);
  client.cache.clear();
  client.callSoap = async () => [
    visit('year-one', '0001-01-01T00:00:00Z'),
    visit('epoch', '1970-01-01T00:00:00Z'),
    visit('invalid', 'not-a-date'),
    visit('empty', ''),
    visit('midnight', '2026-09-17T22:00:00Z'),
    visit('future', '2026-09-17T22:05:00Z')
  ].join('');
  const arrivals = await client.getStopArrivals('1001', '1');
  assert.deepEqual(arrivals.map(arrival => arrival.vehicleId).sort(), ['future', 'midnight']);
  assert.equal(arrivals.find(arrival => arrival.vehicleId === 'midnight').departureTime, '00:00');
  assert.equal(arrivals.find(arrival => arrival.vehicleId === 'future').departureTime, '00:05');
  for (const arrival of arrivals) {
    assert(Number.isFinite(Date.parse(arrival.expectedIso)));
    assert(Date.parse(arrival.expectedIso) >= now);
  }
  console.log('PASS: invalid/year-one/epoch timestamps rejected; genuine Madrid midnight preserved');
})().finally(() => {
  global.Date = OriginalDate;
  client.callSoap = originalSoap;
}).catch(error => { console.error(error); process.exitCode = 1; });
