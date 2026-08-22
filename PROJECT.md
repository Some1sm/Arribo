# Project: Mataró Bus Authoritative Timetable Integration & Universal Schedule Synthesizer

## Architecture
The transit intelligence engine provides unified multi-operator bus and rail schedules across Catalonia. The architecture consists of:
1. **Core Schedule Engine (`src/core/schedule/`)**:
   - `scheduleSynthesizer.js`: Compiles passing timetables from base origin departure matrices, calculates stop travel times, and merges live telemetry with scheduled departures.
   - `delayEngine.js`: Enforces canonical delay status, midnight rollover, and API contract standardization.
   - `calendarEngine.js`: Resolves active service profiles across Weekdays, Saturdays, and Sundays/Holidays.
2. **Operator Trackers (`src/`)**:
   - `mataroTracker.js`: Urban transit for Mataró Bus lines 1–8 (CTSA/Avanza).
   - `maresmeTracker.js`, `corridorTracker.js`, `sagalesTracker.js`, `ambTracker.js`, `cataloniaTracker.js`, `rodaliesTracker.js`: Interurban and regional operators.
3. **Static Datasets (`data/cities/mataro/`, `src/data/`)**:
   - Authoritative timetable matrices, stop sequences, and route geometries.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Mataró Bus Lines 1–8 Authoritative Departure Matrices | Exact CTSA/Avanza timetable trips per line, direction, and calendar day (Feiners, Dissabtes, Diumenges i Festius). | M1 | ORIGINAL_REQUEST §R2 |
| F2 | Stop-by-stop Cumulative Run Times | Accurate run times based on route distance and topography for all lines. | M1 | ORIGINAL_REQUEST §R2 |
| F3 | Line 8 & Line 6 Weekend Constraints | Afternoon-only schedule logic (e.g. Line 8 weekend start at 14:04, Line 6 Sunday start at 14:00). | M1 | ORIGINAL_REQUEST §R2 |
| F4 | Universal Schedule Synthesizer Enhancement | Native `scheduledDepartures: string[]` input, SIRI/GPS merging, and next-morning resumption. | M2 | ORIGINAL_REQUEST §R3 |
| F5 | Elimination of 30-Minute/Headway Loops in Mataró Tracker | Remove `depSec += headwaySec` loops and wire exact schedule synthesizer. | M3 | ORIGINAL_REQUEST §R1 |
| F6 | Interurban & Operator Trackers Audit | Verify non-synthetic departure handling in Maresme, Sagalés, AMB, and Catalonia trackers. | M3 | ORIGINAL_REQUEST §R1 |
| F7 | Dedicated Timetable Accuracy Test Suite | Assert non-uniform headway sequences, exact first/last trip times, and boundary conditions. | M4 | ORIGINAL_REQUEST §R4 |
| F8 | Regression Prevention & 100% Test Pass | Full pass across verification_test.js, core_transit_modules_test.js, m3_smoke_test.js, and API endpoints. | M4 | ORIGINAL_REQUEST §R4 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Authoritative Timetable Ingestion | Ingest `mataro_authoritative_schedules.json` into static data module with run times & direction mapping | none | PLANNED |
| M2 | Universal Schedule Synthesizer Enhancement | Refactor `src/core/schedule/scheduleSynthesizer.js` to support exact departures & live merging | none | PLANNED |
| M3 | Mataró Tracker & Operator Integration | Integrate authoritative timetables into `mataroTracker.js`, remove headway loops, audit all trackers | M1, M2 | PLANNED |
| M4 | E2E Testing Suite & Regression Verification | Implement `test/mataro_timetable_accuracy_test.js`, integrate with `test/verification_test.js`, pass 100% | M3 | PLANNED |
| M5 | Final Milestone: Challenger & Forensic Audit | Adversarial verification, forensic integrity audit, 100% test coverage validation | M4 | PLANNED |

## Interface Contracts
### `src/core/schedule/scheduleSynthesizer.js`
- `compileStopDepartures(options)`:
  - Input: `{ baseDeparturesToday: string[], baseDeparturesTomorrow: string[], stopTravelSec: number, liveDepartures: Array, limit: number, serviceStartSec: number, serviceEndSec: number, dateObj: Date }`
  - Output: `Array<{ time: string, isRealTime: boolean, isToday: boolean, isNextService?: boolean, isFirstOfDay?: boolean, delayMinutes?: number, delayMins?: number, delayStatus?: string, badgeText?: string, ... }>`
- `synthesizeDeparturesFromBaseTimes(baseDepartureTimes, stopTravelSec, options)`:
  - Invariant: Exact non-uniform passing times calculated as `originTime + stopTravelSec`.

### `src/mataroTracker.js`
- `getStopDepartures(lineId, stopId, directionId, options)`:
  - Must return authentic scheduled trips when no live bus is approaching, with non-uniform intervals reflecting official timetable.
- `getTargetStopETA(lineId, targetStopId, userStopId, directionId)`:
  - Must use exact official timetable departures for next trip and next morning resumption.

## Code Layout
- `src/core/schedule/scheduleSynthesizer.js`: Schedule synthesis engine.
- `src/core/schedule/delayEngine.js`: Delay and schema standardization.
- `src/data/mataro_schedules.json`: Official CTSA/Avanza timetable dataset for Mataró Bus lines 1–8.
- `src/mataroTracker.js`: Mataró Bus tracker implementation.
- `test/mataro_timetable_accuracy_test.js`: Dedicated timetable accuracy verification suite.
- `test/verification_test.js`: Master verification test runner.
