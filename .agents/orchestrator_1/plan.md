# Orchestrator Execution Plan

## Objective
Satisfy R1, R2, R3, R4 from ORIGINAL_REQUEST.md:
1. Eliminate synthetic 30-minute / headway schedule intervals in Mataró Bus (Lines 1-8), Maresme, Sagalés, AMB, Catalonia trackers.
2. Integrate authoritative timetables and per-stop passing schedules (Feiners, Dissabtes, Diumenges i Festius).
3. Enhance Universal Timetable Synthesizer (`src/core/schedule/scheduleSynthesizer.js`) to support exact departures and real-time transition.
4. Comprehensive verification & test suite pass (100% across verification_test.js, core_transit_modules_test.js, m3_smoke_test.js, and new schedule accuracy tests).

## Phases & Strategy
- **Phase 0: Survey & Spec Mining**
  - Spawn 3 parallel Explorers / Spec Miners:
    - Explorer 1 (Codebase & Trackers Architecture): Map trackers (mataro, maresme, sagales, amb, catalonia), API endpoints, and naive headway patterns.
    - Explorer 2 (Authoritative Timetable Data & Stop Run Times): Map official GTFS/timetable sources, exact trip matrices for Mataró Bus lines 1-8 across calendar days, run time calculations.
    - Explorer 3 (Universal Synthesizer & Test Suite Analysis): Map scheduleSynthesizer.js, test suites (verification_test.js, core_transit_modules_test.js, m3_smoke_test.js), and edge cases.
- **Phase 1: Architecture & Decomposition (PROJECT.md)**
  - Synthesize survey reports into `PROJECT.md` with Feature Inventory, Milestones, and Interface Contracts.
  - Establish Dual Track (Implementation & E2E Testing).
- **Phase 2: Milestone Iteration Loop**
  - M1: Authoritative Timetable Data Model & Mataró Lines 1-8 Stop Profiles.
  - M2: Universal Schedule Synthesizer Refactor (exact scheduledDepartures, SIRI/GPS real-time transition).
  - M3: Operator Trackers Audit & Integration (Mataró, Maresme, Sagalés, AMB, Catalonia).
  - M4: Comprehensive Test Suite & Verification (100% test pass, regression prevention, dedicated accuracy tests).
- **Phase 3: Final Verification & Adversarial Coverage Hardening**
  - Challenger + Auditor validation.
  - Final synthesis & User reporting.
