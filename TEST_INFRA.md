# E2E Test Infra: Background Worker Isolation & Instant Startup

## Test Philosophy
- Requirement-driven, opaque-box and performance verification derived directly from `ORIGINAL_REQUEST.md`.
- Verifies instant web server startup (<100ms), fast warm snapshot responses (<50ms GET /api/lines), sub-millisecond in-memory cache reads, and zero event-loop starvation under heavy background worker load.

## Feature Inventory
| # | Feature | Source (requirement) | Tier 1 | Tier 2 | Tier 3 |
|---|---------|---------------------|:------:|:------:|:------:|
| 1 | Instant HTTP Startup (<100ms) | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 2 | Warm Snapshot GET /api/lines (<50ms) | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 3 | Fast Landing Page GET / (<500ms) | ORIGINAL_REQUEST §Acceptance Criteria | 5 | 5 | ✓ |
| 4 | Non-blocking Heavy SQLite Journalism Analytics | ORIGINAL_REQUEST §R1, §Acceptance Criteria | 5 | 5 | ✓ |
| 5 | Worker IPC State Hydration (Fleet, Reports, Disruptions) | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |
| 6 | Worker Auto-Restart on Crash & Exponential Backoff | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 7 | Graceful Shutdown & WAL Checkpoint Truncation | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ |
| 8 | Full Regression Pass across All Test Suites | ORIGINAL_REQUEST §Acceptance Criteria | 5 | 5 | ✓ |

## Test Architecture
- **Test Runners**:
  - `node test/syntax_check.js`: Zero syntax errors across all JS files.
  - `node test/verification_test.js`: Core domain accuracy & verification suite.
  - `node test/m3_smoke_test.js`: End-to-end API and multi-provider endpoints suite.
  - `node test/startup_benchmark.js`: Dedicated startup latency, first-load latency, and concurrent load stress benchmark.
- **Test Case Tiers**:
  - Tier 1: Feature Coverage (Process boot latency, cold GET /api/lines, cold GET /, IPC update delivery).
  - Tier 2: Boundary & Corner Cases (Cold start with missing snapshot, worker crash/restart under load, SQLite concurrency timeout).
  - Tier 3: Cross-Feature Interactions (Concurrent HTTP requests while worker executes heavy 168h report generation).
  - Tier 4: Real-World Workload Scenarios (100 concurrent requests during background polling burst; p95 < 25ms, p99 < 50ms, 0 errors).

## Acceptance Criteria Thresholds
- Cold process boot HTTP listen: `< 100ms`.
- Cold `GET /api/lines`: `< 50ms` (status 200).
- Cold `GET /`: `< 500ms` (status 200).
- Heavy SQLite queries executed on worker with `0ms` event loop freeze on web server.
- All test suites pass with code 0.

