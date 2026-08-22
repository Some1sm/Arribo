## 2026-08-22T11:39:49Z

You are Test Writer (Milestone 4: E2E Test Suite & Startup Benchmark).
Your working directory is: h:\Coding\C10Data\.agents\test_writer_m4_benchmark
Authoritative requirements: h:\Coding\C10Data\.agents\ORIGINAL_REQUEST.md
Test infrastructure plan: h:\Coding\C10Data\TEST_INFRA.md
Project plan: h:\Coding\C10Data\PROJECT.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

File Write Boundaries (You exclusively own):
- `test/startup_benchmark.js` (create new)
- `TEST_READY.md` (publish when test suite is ready)

Mission & Implementation Tasks:
1. Implement `test/startup_benchmark.js`:
   - Test 1: Process Startup Latency: Spawn `server.js` as child process and measure elapsed time until HTTP port is listening. Assert duration < 100ms.
   - Test 2: Cold Boot `GET /api/lines`: Issue request immediately upon port open. Assert HTTP 200 and duration < 50ms (and verify lines catalog is returned).
   - Test 3: Cold Boot Landing Page `GET /`: Assert HTTP 200 and duration < 500ms.
   - Test 4: Concurrent Load & Non-Blocking Analytics: Send 50–100 concurrent requests across `/`, `/api/lines`, `/api/vehicles`, `/api/analytics/journalism` while worker executes heavy SQLite aggregations. Assert p95 < 25ms, p99 < 50ms, 0 errors.
   - Test 5: Worker Resilience: Test worker health IPC and verify web server continues serving requests even if worker undergoes simulated restart.
2. Ensure `node test/syntax_check.js` passes with 0 errors.
3. Publish `TEST_READY.md` with complete runner instructions and tier matrix.

Write your completion report to `h:\Coding\C10Data\.agents\test_writer_m4_benchmark\handoff.md` and use send_message when done.
