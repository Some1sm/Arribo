# Original User Request

## 2026-08-22T11:28:45Z

Isolate background ingestion and heavy SQLite analytics into a dedicated Node.js background worker process/thread, eliminating all event-loop blocking on Docker container startup so the web application loads instantly (<100ms).

Working directory: h:\Coding\C10Data
Integrity mode: development

## Requirements

### R1. Background Ingestion & Analytics Worker Isolation
Move ingestionDaemon.js, reportCacheService.js heavy batch aggregations, and periodic catalog synchronizations into a standalone background worker (e.g. worker_threads or dedicated child process). The main Express HTTP process must remain 100% dedicated to serving web clients with zero event-loop starvation.

### R2. Instant Web Server Startup (<100ms)
The Express HTTP web server must start listening immediately upon launch, serving the landing page (/), static assets, and /api/lines from warm local snapshots in <50ms without waiting for worker boot, external GTFS syncs, or database report generation.

### R3. Shared State & Cache Communication
Provide a lightweight shared cache or IPC synchronization mechanism so the web server can read active vehicle positions, delay rankings, and journalism reports updated by the background worker with sub-millisecond read access.

## Acceptance Criteria

### Startup & First-Load Latency
- [ ] Fresh process/container boot serves GET /api/lines in under 50ms.
- [ ] First visit to / loads in <500ms immediately after a restart without hanging or 30–60s delays.
- [ ] Heavy SQLite queries (24h/48h/168h delay reports) execute in the background worker without causing latency spikes on the HTTP server.

### System Verification & Tests
- [ ] node test/syntax_check.js passes with 0 errors.
- [ ] node test/verification_test.js passes 100%.
- [ ] node test/m3_smoke_test.js passes all end-to-end endpoint tests.
- [ ] Automated boot benchmark proves <100ms startup responsiveness under concurrent load.
