# Plan: Bus Tracker Deduplication, Standardization & Best Practices

## Objective
Consolidate duplicated logic across all bus trackers (AMB, Mataró, Moventis/Maresme, Sagalés, Corridor, Catalonia) into reusable core transit modules, standardize tracking engine and server API endpoints, ensure 100% test passing and zero breaking changes for web users, and author an authoritative BEST_PRACTICES.md.

## Phases
1. **Phase 0: Comprehensive Survey**
   - Explorer 1 (Survey Codebase & Trackers): Map tracker implementations, duplicate geometric/time/schedule routines, state handling.
   - Explorer 2 (Survey APIs & Frontend): Map Express routes, schemas, client data contracts (app.js, map.js, RAM optimizations, deep sleep handling).
   - Explorer 3 (Survey Test Harness & Verification): Map `test/verification_test.js`, test cases, edge cases, node execution environment.
2. **Phase 1: Project Scope & Architecture Formulation (PROJECT.md & TEST_INFRA.md)**
   - Formulate unified transit utility modules (geometry, timetable, schedule interpolation, day-type, real-time vehicle parsing, delay badge).
   - Define interface contracts, code layout, and milestone decomposition.
3. **Phase 2: Milestone Execution (Iterative Cycles)**
   - M1: Shared Transit Core Utilities (`src/utils/` or `src/core/`).
   - M2: Refactor & Standardize Trackers with Centralized Engine / Dispatcher.
   - M3: API Centralization & Server Route Harmonization (`server.js`).
   - M4: Frontend Compatibility & Full Verification (`node test/verification_test.js`).
   - M5: Authoritative `BEST_PRACTICES.md`.
4. **Phase 3: E2E Dual-Track Testing & Adversarial Verification**
   - Independent test pass (Tiers 1-4).
   - Reviewer, Challenger, and Forensic Auditor verification.
5. **Phase 4: Final Synthesis & Human Reporting**
