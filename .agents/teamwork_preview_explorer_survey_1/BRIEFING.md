# BRIEFING — 2026-08-21T21:37:00Z

## Mission
Survey all transit tracker implementations in `src/` to identify logic duplication, operator-specific nuances, and recommend a modular shared transit core and standardized tracker interface.

## 🔒 My Identity
- Archetype: Explorer / Surveyor
- Roles: Trackers & Logic Duplication Surveyor
- Working directory: h:/Coding/C10Data/.agents/teamwork_preview_explorer_survey_1
- Original parent: 633321af-26ca-42c6-a77f-2b04ce02263a
- Milestone: Tracker & Logic Duplication Survey

## 🔒 Key Constraints
- Read-only investigation — do NOT implement / modify source code directly
- Follow 5-Component Handoff Protocol
- Keep reports self-contained and evidence-backed with exact line numbers

## Current Parent
- Conversation ID: 633321af-26ca-42c6-a77f-2b04ce02263a
- Updated: 2026-08-21T21:37:00Z

## Investigation State
- **Explored paths**:
  - `ORIGINAL_REQUEST.md`, `ARCHITECTURE.md`, `package.json`, `server.js`
  - `src/corridorTracker.js` (C-10 Corridor Tracker, 1127 lines)
  - `src/mataroTracker.js` (Mataró Bus Urbà L1-L8, 1041 lines)
  - `src/mataroSiriClient.js` (Avanza Mataró SIRI SOAP client, 276 lines)
  - `src/maresmeTracker.js` (Moventis / Casas Maresme, 1274 lines)
  - `src/sagalesTracker.js` (Sagalés Live Telemetry & Timetable, 597 lines)
  - `src/ambTracker.js` (AMB Mobilitat Bus Tracker, 846 lines)
  - `src/rodaliesTracker.js` (Rodalies de Catalunya Train Tracker, 565 lines)
  - `src/cataloniaTracker.js` (Catalonia GTFS / Mou-te Tracker, 707 lines)
  - `src/cataloniaIndexer.js` (GTFS indexer & SQLite shape loader, 453 lines)
  - `src/mouteClient.js` (Generalitat Mou-te client, 95 lines)
  - `src/moventisClient.js` (Moventis Official API client, 231 lines)
  - `src/geoUtils.js` (Haversine distance, bearing, interpolation, 83 lines)
  - `src/timeUtils.js` (Timezone formatting, seconds math, UTC conversions, 162 lines)
  - `src/flightRecorder.js` & `src/historyDb.js` (Fleet state, delay logs, SQLite rollups)
  - `src/ingestionDaemon.js`, `src/routeCacheService.js`, `src/reportCacheService.js`
  - `test/verification_test.js`, `test/e2e_multiline_test.js`
- **Key findings**:
  - Extensive cross-tracker duplication in geometric snapping (vector dot product projection), polyline distance accumulation, dead-reckoning speed/progress estimation.
  - Duplicated schedule math: cumulative distance travelSec calculations `(cumDist / speed) + (stopIdx * dwellSec)` copied across Mataró, Sagalés, AMB, Maresme, Rodalies.
  - Duplicated calendar & day-type evaluations (`getDateComponents`, `isServiceActiveOnDate`) between `corridorTracker.js` and `cataloniaTracker.js`.
  - Duplicated departure normalization and delay badge computation (`delayStatus`, `delayBadgeText`, `comparisonText`) with slightly divergent casing/strings.
  - Duplicated `both` direction handling logic with identical sets of checks and deduplications.
- **Unexplored areas**: None for tracker survey scope.

## Key Decisions Made
- Fully cataloged all geometric, time/calendar, delay, and API routines.
- Designed comprehensive modular transit core architecture (`src/core/` or `src/utils/`) and unified `BaseTracker` contract.

## Artifact Index
- DISPATCH.md — incoming dispatch log
- BRIEFING.md — persistent working memory
- progress.md — liveness and execution heartbeat
- handoff.md — final comprehensive handoff report
