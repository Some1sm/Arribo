## 2026-08-22T11:46:16Z
You are Worker 3 (Milestone 3: Instant Startup & Warm Snapshot Catalog).
Your working directory is: h:\Coding\C10Data\.agents\worker_m3_startup_snapshots
Authoritative requirements: h:\Coding\C10Data\.agents\ORIGINAL_REQUEST.md
Project plan: h:\Coding\C10Data\PROJECT.md
Test infrastructure: h:\Coding\C10Data\TEST_INFRA.md, h:\Coding\C10Data\TEST_READY.md
Survey reports & preceding handoffs to read:
- h:\Coding\C10Data\.agents\explorer_survey_web_ipc_tests\handoff.md
- h:\Coding\C10Data\.agents\worker_m1_worker_bridge\handoff.md
- h:\Coding\C10Data\.agents\worker_m2_sqlite_analytics\handoff.md
- h:\Coding\C10Data\.agents\test_writer_m4_benchmark\handoff.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

File Write Boundaries (You exclusively own):
- `src/maresmeTracker.js`
- `src/corridorTracker.js`
- `src/core/TrackerRegistry.js`
- `server.js`

Mission & Implementation Tasks:
1. Eliminate Heavy Synchronous File Reads on `require()` / Constructor:
   - In `src/maresmeTracker.js`: Defer synchronous `fs.readFileSync` / `JSON.parse` of `data/cache/maresme_cache.json` (73MB). Load on-demand / lazily or asynchronously.
   - In `src/corridorTracker.js`: Defer synchronous `fs.readFileSync` of `data/atm_gtfs/calendar_dates.txt` (31.7MB). Load on-demand / lazily or asynchronously.
2. Fast Warm Snapshot Catalog for `GET /api/lines`:
   - In `src/core/TrackerRegistry.js` (or warm snapshot loader): provide instant in-memory line catalog resolution from local snapshots (`data/snapshots/routes_*.json` or cached lines) on boot in <2ms.
   - Ensure `GET /api/lines` returns the full transit lines catalog in <50ms (target <10ms) on a cold container/process start without awaiting remote tracker network calls.
3. Express Server Instant Boot & Worker Integration in `server.js`:
   - Refactor `server.js` so that `app.listen(PORT, ...)` is called immediately upon launch with zero event-loop blocking (<100ms startup).
   - Initialize `WorkerBridge` to spawn the background worker asynchronously in the background.
   - Wire `WorkerBridge` status and health to `/api/health`.
   - Wire graceful shutdown (`SIGINT`, `SIGTERM`) to trigger `workerBridge.stop()`.
4. Verification & Benchmarking:
   - Run `node test/syntax_check.js` (must pass with 0 errors).
   - Run `node test/startup_benchmark.js` (must pass 100% of benchmarks: startup <100ms, cold /api/lines <50ms, cold / <500ms, concurrent load p95 < 25ms, p99 < 50ms, 0 errors).
   - Run `node test/verification_test.js`.
   - Run `node test/m3_smoke_test.js`.

Write your completion report to `h:\Coding\C10Data\.agents\worker_m3_startup_snapshots\handoff.md` and use send_message when done.
