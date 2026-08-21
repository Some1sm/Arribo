# E2E Test Infra: Bus Tracker Deduplication & Standardization

## Test Philosophy
- Requirement-driven, multi-tier verification covering all 7 transit operators (C-10, Mataró L1-L8, AMB 243 lines, Moventis Maresme 11 lines, Sagalés, Catalonia Mou-te 1,610 routes, Rodalies).
- Zero breaking changes for frontend consumers (`public/js/app.js`, `public/js/map.js`).
- Methodology: 4-Tier Verification (Feature Coverage, Boundary/Corner, Cross-Feature Combinations, Real-World Scenarios) + Platform-Independent Recursive Syntax Checks.

## Feature Inventory
| # | Feature | Source (requirement) | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|---------|---------------------|:------:|:------:|:------:|:------:|
| 1 | Geometric & Polyline Math | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ |
| 2 | Timezone & Calendar Math | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ |
| 3 | Schedule Interpolation & Delay Engine | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ |
| 4 | BaseTracker & Tracker Registry | ORIGINAL_REQUEST §R1 | 5 | 5 | ✓ | ✓ |
| 5 | Live Vehicles API (`/api/line/:lineId/vehicles`, `/api/vehicles`) | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ | ✓ |
| 6 | Stop Departures API (`/api/line/:lineId/stop/:stopId/departures`) | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ | ✓ |
| 7 | Target ETA API (`/api/line/:lineId/target-eta`) | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ | ✓ |
| 8 | Lines Catalog & Route Details (`/api/lines`, `/api/line/:lineId`) | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ | ✓ |
| 9 | Delay Analytics & Journalism (`/api/retards/*`, `/api/analytics/*`) | ORIGINAL_REQUEST §R2 | 5 | 5 | ✓ | ✓ |
| 10 | Frontend Contracts & Performance Safeguards | ORIGINAL_REQUEST §R3 | 5 | 5 | ✓ | ✓ |

## Test Architecture
- **Test Runner**: Node.js native (`node test/verification_test.js`, `npm test`).
- **Pass/Fail Semantics**: 100% assertions pass with zero errors, process exit code 0.
- **Syntax Validator**: Recursive `vm.Script` compiler validating all 28+ JS files across backend, frontend, and tests.

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Full 24-hour day schedule lifecycle & morning first-service rollover | F2, F3, F6, F7 | High |
| 2 | Multi-operator rapid switching with 8-entry LRU route cache | F4, F8, F10 | Medium |
| 3 | Inactive tab deep-sleep pause and rapid wake-up batch refresh | F5, F7, F10 | Medium |
| 4 | High-density multi-vehicle tracking with HTML5 Canvas renderer & smooth glider | F1, F5, F10 | High |
| 5 | Journalism report generation across 125,000+ delay logs | F9, F10 | Medium |

## Coverage Thresholds
- Tier 1: ≥5 test cases per feature (50+ assertions).
- Tier 2: ≥5 boundary/corner test cases per feature (50+ assertions).
- Tier 3: Pairwise cross-feature interactions across all 7 operators.
- Tier 4: ≥5 realistic end-to-end user scenarios.
