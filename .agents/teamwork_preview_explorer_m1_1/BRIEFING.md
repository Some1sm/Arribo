# BRIEFING — 2026-08-21T21:42:00Z

## Mission
Design exact implementation specifications for Milestone 1: Geo, Time & Calendar Core Modules (`src/core/geo/geoEngine.js`, `src/core/time/timeEngine.js`, `src/core/time/calendarEngine.js`, and backward compatibility re-export bridges in `src/geoUtils.js` and `src/timeUtils.js`).

## 🔒 My Identity
- Archetype: explorer
- Roles: Explorer, Investigator, Synthesizer
- Working directory: h:/Coding/C10Data/.agents/teamwork_preview_explorer_m1_1/
- Original parent: 633321af-26ca-42c6-a77f-2b04ce02263a
- Milestone: Milestone 1 - Geo, Time & Calendar Core Modules

## 🔒 Key Constraints
- Read-only investigation — do NOT implement directly in `src/` (report designs and specifications in handoff).
- Strictly adhere to user requirements in `ORIGINAL_REQUEST.md` and `PROJECT.md`.
- Examine existing implementations in `src/geoUtils.js`, `src/timeUtils.js`, `src/mataroTracker.js`, `src/sagalesTracker.js`, `src/corridorTracker.js`, `src/cataloniaTracker.js`.
- Provide concrete mathematical & algorithmic specifications, edge-case handling, function signatures, export formats, and unit test specifications.

## Current Parent
- Conversation ID: 633321af-26ca-42c6-a77f-2b04ce02263a
- Updated: 2026-08-21T21:42:00Z

## Investigation State
- **Explored paths**: `ORIGINAL_REQUEST.md`, `PROJECT.md`, `src/geoUtils.js`, `src/timeUtils.js`, `src/mataroTracker.js`, `src/sagalesTracker.js`, `src/corridorTracker.js`, `src/cataloniaTracker.js`, `src/maresmeTracker.js`, `src/ambTracker.js`, `src/c10StaticData.js`, `test/verification_test.js`, `test/e2e_multiline_test.js`.
- **Key findings**:
  - `src/mataroTracker.js` contains full dot-product projection (`snapPointToPolyline`), dead-reckoning (`extrapolatePolylinePosition`), and along-route distance accumulation.
  - `src/sagalesTracker.js` has embedded Google `decodePolyline` routine.
  - `src/corridorTracker.js` and `src/cataloniaTracker.js` duplicate date component decomposition and GTFS calendar/calendar_dates validation.
  - `src/timeUtils.js` requires strict null/invalid/epoch/0001 protection for `formatTimeToTimezone`.
  - 12+ files import `geoUtils.js` and `timeUtils.js`; re-export facades are essential for zero-breaking migration.
- **Unexplored areas**: Milestone 2 and Milestone 3 implementations (outside M1-1 scope).

## Key Decisions Made
- Designed pure modular functions for `src/core/geo/geoEngine.js`, `src/core/time/timeEngine.js`, and `src/core/time/calendarEngine.js`.
- Added transparent coordinate normalization in `geoEngine.js` supporting `{lat, lon}`, `{lat, lng}`, `{Latitude, Longitude}`, and `[lat, lon]`.
- Implemented backward compatibility bridge facades in `src/geoUtils.js` and `src/timeUtils.js`.
- Provided complete code implementations and test specifications in `handoff.md`.

## Artifact Index
- `h:/Coding/C10Data/.agents/teamwork_preview_explorer_m1_1/DISPATCH.md` — Dispatch log
- `h:/Coding/C10Data/.agents/teamwork_preview_explorer_m1_1/progress.md` — Progress tracker and liveness heartbeat
- `h:/Coding/C10Data/.agents/teamwork_preview_explorer_m1_1/BRIEFING.md` — Situational awareness
- `h:/Coding/C10Data/.agents/teamwork_preview_explorer_m1_1/handoff.md` — Complete implementation specifications & verification method
