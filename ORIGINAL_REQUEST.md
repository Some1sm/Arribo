# Original User Request

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
