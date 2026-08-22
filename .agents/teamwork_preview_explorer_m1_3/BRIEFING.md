# BRIEFING — 2026-08-21T21:40:30Z

## Mission
Design exact implementation specifications for `BaseTracker.js` and `TrackerRegistry.js` for Milestone 1, examining lifecycle, polymorphic line resolution, and direction='both' across existing trackers.

## 🔒 My Identity
- Archetype: explorer
- Roles: read-only investigation, codebase synthesis, architectural design specification
- Working directory: h:/Coding/C10Data/.agents/teamwork_preview_explorer_m1_3/
- Original parent: 633321af-26ca-42c6-a77f-2b04ce02263a
- Milestone: Milestone 1 - BaseTracker & TrackerRegistry

## 🔒 Key Constraints
- Read-only investigation — do NOT implement / modify application source code directly
- Adhere strictly to project architecture in PROJECT.md and ORIGINAL_REQUEST.md
- Produce 5-component handoff report with exact class design, template methods, common implementations, and registry resolution logic

## Current Parent
- Conversation ID: 633321af-26ca-42c6-a77f-2b04ce02263a
- Updated: not yet

## Investigation State
- **Explored paths**: `ORIGINAL_REQUEST.md`, `PROJECT.md`, `server.js`, `src/corridorTracker.js`, `src/mataroTracker.js`, `src/maresmeTracker.js`, `src/sagalesTracker.js`, `src/ambTracker.js`, `src/rodaliesTracker.js`, `src/cataloniaTracker.js`, `test/verification_test.js`, `test/e2e_multiline_test.js`, Survey handoffs 1, 2, 3.
- **Key findings**:
  1. Tracker lifecycle consists of lazy/eager async initialization (`init()`), real-time caching with 10-15s TTL, and graceful fallback to schedules.
  2. Polymorphic line resolution in `server.js` follows a 7-stage hierarchy (C-10 -> Mataró L1..L8 -> Maresme -> Rodalies -> AMB -> Sagalés -> Catalonia GTFS fallback).
  3. `direction === 'both'` is duplicated across all 7 trackers with minor variants; all require merging stops, coordinates, secondary styling (`#38bdf8`), and bus deduplication.
  4. Bus deduplication must strictly prioritize real GPS over dead-reckoning estimations and deduplicate by vehicle ID or proximity coordinates.
  5. Checkpoints and ServiceStatus generation follow standard patterns that can be completely centralized in `BaseTracker.js`.
  6. `TrackerRegistry.js` provides centralized dispatching, multi-provider line deduplication (4-tier), and universal stop/line search.
- **Unexplored areas**: None for M1-3 scope. Ready to draft comprehensive handoff specifications.

## Key Decisions Made
- Designed complete specifications and method signatures for `BaseTracker` and `TrackerRegistry`.
- Standardized dual-property schemas (`isRealTime`/`isRealtime`, `delayMins`/`delayMinutes`, `lat`/`lon` + `coords: {lat, lon}`) to guarantee 100% backward compatibility.
- Formulated clean code templates ready for Milestone 1 implementation.

## Artifact Index
- DISPATCH.md — Initial dispatch log
- BRIEFING.md — Situational awareness
- progress.md — Liveness & task progress
- handoff.md — Final 5-component handoff report
