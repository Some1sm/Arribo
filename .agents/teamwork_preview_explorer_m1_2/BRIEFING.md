# BRIEFING — 2026-08-21T21:40:50Z

## Mission
Analyze schedule generation, stop travel time estimation, and delay evaluation across existing trackers and specify clean, robust core modules (`src/core/schedule/scheduleSynthesizer.js` and `src/core/schedule/delayEngine.js`) for Milestone 1.

## 🔒 My Identity
- Archetype: explorer
- Roles: read-only investigation, schedule & delay core module specification
- Working directory: h:/Coding/C10Data/.agents/teamwork_preview_explorer_m1_2
- Original parent: 633321af-26ca-42c6-a77f-2b04ce02263a
- Milestone: M1 (Schedule & Delay Core Modules)

## 🔒 Key Constraints
- Read-only investigation — do NOT implement directly in `src/` (report specs/designs in handoff.md)
- Adhere strictly to ORIGINAL_REQUEST.md and PROJECT.md requirements
- Ensure backward compatibility and clean unit-testable signatures

## Current Parent
- Conversation ID: 633321af-26ca-42c6-a77f-2b04ce02263a
- Updated: 2026-08-21T21:40:50Z

## Investigation State
- **Explored paths**:
  - `src/corridorTracker.js` (lines 330-409, 411-625, 680-770, 877-1008)
  - `src/mataroTracker.js` (lines 600-750, 750-980)
  - `src/maresmeTracker.js` (lines 734-824, 1100-1250)
  - `src/sagalesTracker.js` (lines 450-597)
  - `src/ambTracker.js` (lines 700-830)
  - `src/rodaliesTracker.js` (lines 450-540)
  - `src/cataloniaTracker.js` (lines 380-480, 610-670)
  - `src/geoUtils.js`, `src/timeUtils.js`
  - Survey handoffs (`teamwork_preview_explorer_survey_1`, `survey_2`)
  - Test suites (`test/verification_test.js`, `test/e2e_multiline_test.js`)
- **Key findings**:
  - Stop travel time estimation is implemented with ad-hoc speed and dwell parameters across 5 trackers; standardizing into `estimateStopTravelTimes` unifies urban bus, interurban bus, and rail modes with zero loss of fidelity.
  - Departure synthesis and overnight first-service generation share identical structure (`isToday: false`, `isFirstOfDay: true`, `isNextService: true`, `delayBadgeText: '🌅 1r Servei del matí'`).
  - Delay evaluation has minor discrepancies (`on_time` vs `ontime` vs `on-time`, `delayMinutes` vs `delayMins`, `Puntual` vs `A l'hora (Puntual)`). Canonical `computeDelayStatus` guarantees dual-compatibility fields (`delayMinutes` + `delayMins`, `isRealTime` + `isRealtime`) and uniform enum (`'on_time' | 'delayed' | 'early' | 'scheduled' | 'passed' | 'estimated'`).
- **Unexplored areas**: None for M1-2.

## Key Decisions Made
- Fully specified `src/core/schedule/scheduleSynthesizer.js` with `estimateStopTravelTimes`, `synthesizeDeparturesFromBaseTimes`, `synthesizeHeadwayDepartures`, `generateMorningFirstService`, `interpolateStopArrivals`, `getTravelTimeToStop`, and `getTravelTimeBetween`.
- Fully specified `src/core/schedule/delayEngine.js` with `computeDelayStatus`, `findClosestScheduledTime`, `formatCountdownStatus`, and `standardizeDeparture`.
- Established pure, side-effect-free function signatures with comprehensive parameter defaulting, circular midnight wrap-around handling, and 100% backward compatibility for all legacy consumers.

## Artifact Index
- `DISPATCH.md` — Inbound message log
- `BRIEFING.md` — Situational awareness
- `progress.md` — Liveness and task checklist
- `handoff.md` — Authoritative 5-component specification report
