# Original User Request

> Historical document — may not match the current code. See README.md, AGENTS.md, OPERATIONS.md.

## 2026-08-21T21:33:52Z

Refactor and deduplicate the codebase across all bus trackers (AMB Metrobús/NitBus, Mataró Bus, Moventis/Maresme, Sagalés, Catalonia Mou-te GTFS/SIRI), standardizing bus telemetry and ETA tracking under a unified internal engine and clean API, and generate an authoritative developer best practices guide.

Working directory: h:/Coding/C10Data
Integrity mode: development

## Requirements

### R1. Code Deduplication & Shared Transit Core
Consolidate repeated logic across all trackers (src/ambTracker.js, src/mataroTracker.js, src/maresmeTracker.js, src/sagalesTracker.js, src/corridorTracker.js, src/cataloniaTracker.js) into reusable transit utility modules:
- Standardize geometric snapping, polyline distances, interpolation, and speed estimation.
- Unify timetable generation, departure formatting, schedule interpolation, and day-type detection (weekday, saturday, sunday).
- Consolidate real-time vehicle monitoring parsing and delay badge computation.

### R2. Standardized Transit Tracking Engine & API Centralization
Ensure all lines and transit modes conform to a single unified contract for:
- Live vehicles (/api/line/:lineId/vehicles and /api/vehicles).
- Stop departures and full daily timetables (/api/line/:lineId/stop/:stopId/departures).
- Target ETA and line status (/api/line/:lineId/target-eta).
- Route geometries and stops catalog (/api/lines, /api/line/:lineId).

### R3. Maintain Compatibility & Comprehensive Verification
Preserve all existing frontend features and performance enhancements (such as RAM optimizations, deep sleep visibility handling, Canvas renderer, precomputed delay reports) with zero breaking changes for web users. Ensure automated tests cover all tracker types and API endpoints.

### R4. Best Practices Guide (BEST_PRACTICES.md)
Create a comprehensive, production-grade BEST_PRACTICES.md document detailing:
- Standard transit data structures (Vehicle, Stop, Departure, ServiceStatus).
- Architecture and lifecycle of a tracker module.
- Rules for adding new agencies, bus lines, or data sources.
- Day-type handling, timezone standards, and timetable generation rules.
- Memory management, caching, and testing requirements for future developers and AI agents.

## Acceptance Criteria

### Architecture & Deduplication
- [ ] No duplicated geometric, time, or schedule generator routines duplicated across individual tracker files.
- [ ] Centralized tracker registry or unified dispatcher handling all transit operators consistently.

### API & Functional Verification
- [ ] node test/verification_test.js passes 100% with zero errors.
- [ ] All API endpoints (/api/line/:lineId/target-eta, /api/line/:lineId/stop/:stopId/departures, /api/line/:lineId/vehicles, /api/retards/*) return uniform, validated JSON schemas across all supported lines (C-10, Mataró 1-8, AMB M27/B24/etc., Catalonia e11.1/e13/etc.).
- [ ] Zero syntax errors across all backend and frontend files (public/js/app.js, public/js/map.js).

### Documentation Deliverable
- [ ] BEST_PRACTICES.md is created at repository root with complete code examples, architecture diagrams/tables, and contribution rules.

## 2026-08-24T20:15:15Z

Investigar, localizar y extraer las coordenadas GPS telemáticas en tiempo real directo del autobús interurbano C-10 (operado por Empresa Casas / Moventis) a través de APIs de Moventis, AMB, Generalitat de Catalunya (Mou-te / GTFS-RT) o ingeniería inversa de las apps móviles oficiales de transporte.

Working directory: H:\Coding\C10Data

## Requirements

### R1. Reverse Engineering & Discovery of Direct Vehicle GPS Feed
Localizar el endpoint / feed de telemetría directo (REST, WebSocket, MQTT, SIRI o GTFS-RT protobuf) utilizado por los sistemas de Moventis, Casas o Generalitat para transmitir la posición de los vehículos de la línea C-10.

### R2. Direct Real-Time Telemetry Extractor
Implementar un módulo de extracción que consulte dicho endpoint y entregue las coordenadas GPS reales (latitud, longitud, velocidad, rumbo, matrícula o calca) del autobús C-10 en circulación, sin depender exclusivamente de estimación teórica.

## Acceptance Criteria

### Real GPS Verification
- [ ] El extractor entrega coordenadas reales devueltas directamente por el upstream del operador / administración.
- [ ] Verificación programática con respuesta JSON estructurada conteniendo `latitude`, `longitude`, `timestamp` y `vehicleId`.

## 2026-09-07T16:09:55Z

Requested team: Full multi-agent team (Architecture, backend deduplication, frontend cleanup, and adversarial verification working in parallel)

Comprehensive codebase review, consistency audit, and deep deduplication pass across Arribo! (Catalonia Transit Platform) following recent extensive multi-feature additions and updates.

Working directory: h:/Coding/Arribo!
Integrity mode: development

## Requirements

### R1. Deep Deduplication & Dead Code Pruning
Thoroughly inspect the repository to identify and eliminate duplicated algorithms, redundant helper methods, unused variables, and orphaned code paths across `src/core/`, `src/`, `server.js`, and `public/js/`. Ensure all transit calculations (geo distance, polyline snapping, timezone/calendar conversions, delay badges) use the canonical engines in `src/core/` rather than inline reimplementations.

### R2. Architectural & Schema Consistency Audit
Verify that REST API endpoints, IPC messages, and internal data structures maintain project-wide domain invariants:
- Read-only main process (zero direct SQLite access in `server.js`; all database interactions proxied through `WorkerBridge.historyQuery`).
- Strict dual-compatibility schemas (`lat`/`latitude`, `lon`/`longitude`, `delayMins`/`delayMinutes`).
- Strict `Europe/Madrid` timezone handling across all operations.

### R3. Frontend Cohesion & Style Deduplication
Audit `public/js/app.js`, `public/js/plan.js`, `public/js/map.js`, `public/index.html`, and `public/css/style.css`:
- Remove redundant or duplicated CSS rules, orphaned selectors, and conflicting styling tokens.
- Deduplicate shared utility functions between client scripts.
- Ensure event delegation patterns are cleanly implemented without duplicate event listeners.

### R4. Comprehensive Automated Verification & Zero Regressions
Execute all automated test suites across the repository to verify that the deduplication pass introduces zero functional regressions and leaves the platform completely green across all 7 transit operators.

## Verification Resources
The following test suites must be executed and pass with 0 errors:
- `node test/syntax_check.js` (AST validation across all 80+ JavaScript files)
- `node test/core_transit_modules_test.js` (Core transit engines unit tests)
- `node test/transit_router_test.js` (Journey planner & routing tests, all 10 tests)
- `node test/mataro_timetable_accuracy_test.js` (489 timetable & e2e assertions)
- `node test/verification_test.js` (End-to-end multi-provider verification)

## Acceptance Criteria

### Code Hygiene & Deduplication
- [ ] Redundant and duplicated code blocks across `src/core/`, `src/`, `server.js`, and `public/` are eliminated.
- [ ] No dead code, debug statements, or orphaned legacy functions remain.
- [ ] CSS stylesheets and DOM templates have zero redundant declarations or unused styles.

### Architectural Invariants
- [ ] Main process remains strictly read-only with no direct SQLite connection.
- [ ] All API responses adhere to canonical schemas with 0 unhandled promise rejections.
- [ ] Timezone and calendar operations strictly enforce `Europe/Madrid`.

### Verification & Stability
- [ ] All 5 verification test commands execute cleanly with 100% passing checks and 0 failures.
- [ ] Server boot latency and memory usage remain within standard benchmarks.

## 2026-09-21T18:40:59Z

This is a single self-contained fix; keep it small and focused.

Normalize the visual layout and card heights of upcoming departure entries ("Properes sortides") in Arribo!, eliminating redundant duplicate pills and inconsistent wrapping while preserving all regulation, timing, and destination information in a compact, balanced design.

Working directory: h:\Coding\Arribo!
Integrity mode: development

## Requirements

### R1. Consistent Card Height & Visual Cadence
Standardize `.departure-item` cards so that all entries (live, theoretical/scheduled, and regulating/layover) share a consistent, balanced vertical footprint. Prevent regulating entries from ballooning in height compared to adjacent scheduled or live entries.

### R2. De-duplicate Status Badges & Streamline Regulation Headers
Eliminate redundant duplicate badges on departure cards (specifically resolving the stacked duplicate "🅿️ A la parada" pills in the status column and duplicate tags in the time row). Render a single clear status badge in the header row alongside the departure time and tag.

### R3. Information Preservation via Streamlined Subtext & Tooltips
Preserve all detailed telemetry information (exact layover duration, arrival time at terminal, origin terminal name, scheduled departure time, and delay context) in a clean, non-wrapping single-line subtext format, backed by comprehensive title tooltips for complete accessibility and full context on hover/tap.

### R4. Dual-Renderer Synchronization & Invariant Compliance
Ensure both departure renderers in `public/js/app.js` (`renderUpcomingDepartures` and `renderDeparturesList`) are updated consistently. Preserve interactive click-to-locate map behavior (`clickable-bus-dep`), vehicle tracking IDs, and shell cache alignment rules (bump version if modifying client assets).

## Acceptance Criteria

### Visual Consistency & Layout
- [ ] All departure cards maintain a consistent vertical baseline without excessive height variance between regulating and regular departures.
- [ ] No duplicated status badges or stacked identical pills appear on any single departure card (e.g. no stacked identical "🅿️ A la parada" badges).
- [ ] Departure time, destination, and countdown remain prominently visible at a glance.

### Information Completeness
- [ ] All terminal layover and regulation details (arrival at capçalera, layover origin, scheduled departure, and countdown) remain accessible to the user via streamlined subtext and native tooltips.
- [ ] Delay status, punctuality badges, and scheduled comparison times for non-regulating departures remain intact and accurate.

### Verification Resources & Test Suites
- [ ] `npm run test:syntax` passes with 0 errors across all files.
- [ ] `node scripts/docs_check.js` passes with 0 errors.
- [ ] `npm test` passes completely with zero regressions.
- [ ] `npm run test:full` passes all unit, integration, and performance benchmarks.
