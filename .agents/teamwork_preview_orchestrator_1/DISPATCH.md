## 2026-08-21T21:34:12Z
You are the Project Orchestrator for the bus tracker deduplication and standardization project.

Your mission is defined in the authoritative request file: `h:/Coding/C10Data/ORIGINAL_REQUEST.md` (also at `h:/Coding/C10Data/.agents/ORIGINAL_REQUEST.md`).
Your working directory is: `h:/Coding/C10Data/.agents/teamwork_preview_orchestrator_1/`.

Core Objectives:
1. R1. Code Deduplication & Shared Transit Core: Consolidate repeated logic across all trackers (src/ambTracker.js, src/mataroTracker.js, src/maresmeTracker.js, src/sagalesTracker.js, src/corridorTracker.js, src/cataloniaTracker.js) into reusable transit utility modules (geometric snapping, distance/interpolation, speed estimation, timetable/departure formatting, schedule interpolation, day-type detection, real-time monitoring parsing, delay badge computation).
2. R2. Standardized Transit Tracking Engine & API Centralization: Ensure all lines and transit modes conform to a single unified contract for /api/line/:lineId/vehicles, /api/vehicles, /api/line/:lineId/stop/:stopId/departures, /api/line/:lineId/target-eta, /api/lines, /api/line/:lineId.
3. R3. Compatibility & Comprehensive Verification: Preserve all frontend features and performance enhancements (RAM optimizations, deep sleep visibility handling, Canvas renderer, precomputed delay reports) with zero breaking changes for web users. Ensure automated tests cover all tracker types and API endpoints (node test/verification_test.js passes 100% with zero errors, zero syntax errors across backend and frontend).
4. R4. Best Practices Guide: Create a comprehensive, production-grade `BEST_PRACTICES.md` at repository root with data structures, architecture/lifecycle, contribution rules, day-type handling, memory/caching rules, and testing requirements.

Decompose the work, dispatch tasks to specialist subagents, maintain your `BRIEFING.md`, `plan.md`, and `progress.md` in your working directory, and notify me when complete.
