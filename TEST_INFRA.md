# E2E Test Infra: Mataró Bus Timetable & Synthesizer Verification

## Test Philosophy
- Opaque-box, requirement-driven testing. Derived directly from `ORIGINAL_REQUEST.md`.
- Verifies that no synthetic uniform intervals (e.g. constant 30-minute steps) exist.
- Validates authentic CTSA/Avanza timetable departures for lines 1–8 across Weekdays, Saturdays, and Sundays/Holidays.

## Feature Inventory
| # | Feature | Source (requirement) | Tier 1 | Tier 2 | Tier 3 |
|---|---------|---------------------|:------:|:------:|:------:|
| 1 | L1–L8 Weekday Departure Accuracy | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 2 | L1–L8 Saturday Departure Accuracy | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 3 | L1–L8 Sunday/Holiday Departure Accuracy | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 4 | Line 8 Afternoon-Only Constraint (14:04+) | ORIGINAL_REQUEST §R2, Acceptance Criteria | 5 | 5 | ✓ |
| 5 | Line 6 Sunday Afternoon-Only Constraint | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 6 | Stop-by-stop Run Times & Monotonicity | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ |
| 7 | Next Morning Resumption First Service | ORIGINAL_REQUEST §R3, Acceptance Criteria | 5 | 5 | ✓ |
| 8 | Universal Synthesizer Live-to-Scheduled Transition | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ |

## Test Architecture
- Test runner: `node test/mataro_timetable_accuracy_test.js` and `node test/verification_test.js`
- Test case tiers:
  - Tier 1: Feature Coverage (Exact non-uniform departure arrays for all 8 lines across all 3 day types).
  - Tier 2: Boundary & Corner Cases (Line 8 morning query returns next service at 14:04, late night midnight transitions, first/last trips).
  - Tier 3: Cross-Feature (Synthesizer live SIRI merge with schedule array, duplicate arrival suppression).
  - Tier 4: Real-World Scenarios (Full day simulation for passenger querying stop 100 at 06:00, 14:00, and 23:30).

## Pass Semantics
- All tests must exit with code 0.
- Standard deviation of inter-departure intervals for peak/off-peak schedules must be non-zero (proving non-synthetic schedule).
- Line 8 Sunday departures must strictly match official array: `['14:04', '15:08', '16:12', '17:16', '18:20', '19:26', '20:32', '21:35']`.
