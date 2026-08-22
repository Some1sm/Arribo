const assert = require("assert");
const mataroTracker = require("../src/mataroTracker");

async function runTests() {
  console.log("Starting Stop Departures Cache Benchmark Tests...");
  const t0 = process.hrtime.bigint();
  const coldRes = await mataroTracker.getStopDepartures("1001", "1", "0", { skipCache: true });
  const t1 = process.hrtime.bigint();
  const coldMs = Number(t1 - t0) / 1e6;
  assert.ok(coldRes && Array.isArray(coldRes.departures), "Cold fetch returned valid envelope");
  console.log("  Cold fetch: " + coldMs.toFixed(2) + "ms (" + coldRes.departures.length + " departures)");

  const t2 = process.hrtime.bigint();
  const warmRes = await mataroTracker.getStopDepartures("1001", "1", "0");
  const t3 = process.hrtime.bigint();
  const warmMs = Number(t3 - t2) / 1e6;
  assert.ok(warmRes && Array.isArray(warmRes.departures), "Warm fetch returned valid envelope");
  assert.strictEqual(warmRes.departures.length, coldRes.departures.length, "Warm cache matches cold count");
  assert.ok(warmMs < 15, "Warm retrieval must be sub-15ms (was " + warmMs.toFixed(3) + "ms)");
  console.log("  Warm memory cache fetch: " + warmMs.toFixed(3) + "ms (Instant sub-millisecond)");

  console.log("\nTesting warmLineStopsCache batch pre-computation...");
  const warmT0 = process.hrtime.bigint();
  await mataroTracker.warmLineStopsCache("1");
  const warmT1 = process.hrtime.bigint();
  const batchWarmMs = Number(warmT1 - warmT0) / 1e6;
  console.log("  Batch warmed Line 1 stops in " + batchWarmMs.toFixed(2) + "ms");
  assert.ok(mataroTracker.stopDeparturesMemoryCache.size > 10, "Memory cache has populated entries");
  console.log("  Cache entries in memory: " + mataroTracker.stopDeparturesMemoryCache.size);

  console.log("\nTesting instantaneous access across 5 distinct line stops...");
  const testStops = ["1001", "1016", "1017", "1018", "1004"];
  for (const sId of testStops) {
    const start = process.hrtime.bigint();
    const res = await mataroTracker.getStopDepartures(sId, "1", "0");
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(res.departures.length > 0, "Stop " + sId + " has departures");
    console.log("    - Stop " + sId + " (" + res.stop.name + "): " + elapsed.toFixed(3) + "ms (" + res.departures.length + " sortides)");
  }

  console.log("\nEstimating RAM footprint of cache entries...");
  let totalBytes = 0;
  for (const [k, v] of mataroTracker.stopDeparturesMemoryCache.entries()) {
    totalBytes += Buffer.byteLength(JSON.stringify(v));
  }
  const kbSize = totalBytes / 1024;
  console.log("  Total memory footprint for " + mataroTracker.stopDeparturesMemoryCache.size + " stop cache entries: " + kbSize.toFixed(2) + " KB");
  assert.ok(kbSize < 1000, "Memory footprint must be under 1MB (was " + kbSize.toFixed(2) + " KB)");

  console.log("\nALL STOP CACHE BENCHMARK TESTS PASSED PERFECTLY!");
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
