## 2026-08-21T21:38:56Z
You are Explorer M1-3 for Milestone 1: BaseTracker & TrackerRegistry.
Your working directory is: h:/Coding/C10Data/.agents/teamwork_preview_explorer_m1_3/
You MUST first read the authoritative user request at: h:/Coding/C10Data/ORIGINAL_REQUEST.md and the project scope at: h:/Coding/C10Data/PROJECT.md.

Task:
1. Examine tracker lifecycle, polymorphic line resolution, and `direction === 'both'` handling in `server.js` and all existing trackers.
2. Design the exact implementation specifications for:
   - `src/core/BaseTracker.js`:
     - Abstract base class with template methods: `fetchLiveVehicles(lineId)`, `fetchStopArrivals(stopId, lineId, direction)`, `getRawLineData(lineId, direction)`.
     - Common implementations: `getLineDetails(lineId, direction)` with automatic `handleBothDirections(lineId)`, `deduplicateBuses(buses)`, `buildCheckpoints(stops, activeBuses)`, `buildServiceStatus(calendarInfo, departures)`.
   - `src/core/TrackerRegistry.js`:
     - Centralized registry for all transit providers (AMB, Mataró, Moventis/Maresme, Sagalés, Rodalies, Catalonia Mou-te, C-10).
     - Method `getTrackerForLine(lineId)` returning the appropriate tracker instance, clean line code, and agency info.
     - Method `getAllLines()` aggregating lines across all registered trackers.
3. Recommend clean, extensible class definitions adhering to best practices and preserving existing consumer interfaces.
4. Record progress in `progress.md` and write your findings to `handoff.md` in your working directory.
5. Use send_message to report when done.
