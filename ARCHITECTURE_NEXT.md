# ARCHITECTURE_NEXT.md — Future Multi-Provider Architecture

> Architectural design note and roadmap for modular timetable providers and multi-town readiness in Arribo!

---

## 1. Context and Current Boundaries

As established in [`AGENTS.md §1`](file:///h:/Coding/Arribo!/AGENTS.md):
- **Current Scope:** Arribo! serves strictly **Mataró Bus Urbà (Lines L1–L8)** with 153 indexed stops.
- `TrackerRegistry` registers only Mataró. No other transit providers or municipalities are currently active.
- Current authoritative timetable: `maresme.net` per-trip matrix with seasonal provenance (`mataro_schedules.seasons.json`).

The introduction of ATM GTFS (Phase 9.2) demonstrates 98.5% per-trip agreement with the official Maresme grid, validating GTFS as a viable alternative timetable provider and opening the door to multi-operator scaling.

---

## 2. The `TimetableProvider` Interface

To decouple transit routing and timetable synthesis from operator-specific file formats, all timetable consumers (`transitRouter`, `journeyTimeline`, `mataroTracker`, `tripMatcher`, `ingestionDaemon`) will interface with a unified, swappable contract:

```typescript
interface TimetableProvider {
  /**
   * Unique identifier of the provider (e.g. 'maresme_scraped', 'atm_gtfs').
   */
  readonly id: string;

  /**
   * Human-readable label and data source provenance.
   */
  readonly metadata: {
    agency: string;
    version: string;
    validityWindow: { from: string; to: string | null };
    season: 'winter' | 'summer' | 'unverified';
  };

  /**
   * Returns all trips serving a specific stop for a line, direction, and day type.
   * Delivers exact published departure times (in seconds from midnight Europe/Madrid).
   */
  getTripsServingStop(
    lineId: string,
    stopId: string,
    dayType: 'weekday' | 'saturday' | 'sunday',
    options?: { season?: string }
  ): Array<{
    tripIndex: number;
    tripId?: string;
    departureSec: number;
    departureTime: string; // "HH:MM"
    isFirstOfDay?: boolean;
    isLastOfDay?: boolean;
  }>;

  /**
   * Computes the operational service window for a line on a given day type.
   * Window spans from (first departure - 15m) to (last departure + trip duration + 20m).
   */
  getServiceWindow(
    lineId: string,
    dayType: 'weekday' | 'saturday' | 'sunday',
    season?: string
  ): {
    startSec: number;
    endSec: number;
    overnightRollover: boolean;
  };

  /**
   * Retrieves directional schedule metadata, terminal layovers, and stop sequence.
   */
  getDirectionSchedule(
    lineId: string,
    directionId: string,
    dayType: 'weekday' | 'saturday' | 'sunday',
    season?: string
  ): {
    dirId: string;
    directionName: string;
    originStop: { id: string; name: string };
    terminalStop: { id: string; name: string };
    stops: Array<{ id: string; name: string; lat: number; lon: number }>;
    firstTrip: string;
    lastTrip: string;
    departures: string[];
    afternoonOnly: boolean;
  } | null;

  /**
   * Retrieves the exact published arrival time for a specific trip and stop index.
   */
  getTripStopTime(
    lineId: string,
    directionId: string,
    dayType: 'weekday' | 'saturday' | 'sunday',
    tripIndex: number,
    stopIndex: number,
    season?: string
  ): number | null;
}
```

---

## 3. Provider Implementations

### 3.1 `MaresmeProvider` (Production Default)
- **Data Origin:** `https://maresme.net/matarobus/{hivern,estiu}/` via `scripts/scrape_maresme_timetables.js`.
- **Characteristics:**
  - Season-scoped (`mataro_schedules.seasons.json`).
  - Authoritative contractual reference for Mataró Bus Urbà riders.
  - Zero extrapolation: each cell reflects published times.
- **Status:** Active in production.

### 3.2 `GtfsProvider` (Secondary & Multi-Town Foundation)
- **Data Origin:** ATM Generalitat GTFS Static Feed (`data/atm_gtfs/`) via `scripts/gtfs_import.js`.
- **Characteristics:**
  - Standard GTFS schema (`agency`, `routes`, `trips`, `stop_times`, `calendar`, `calendar_dates`).
  - Streamed line-by-line using `node:readline` (< 3 seconds for 220 MB `stop_times.txt`).
  - Enables importing other ATM operators (TMB, Tusgsal, Sagalés, Moventis, Soler i Sauret).
- **Status:** Fully validated with 98.5% network agreement on Mataró.

---

## 4. Multi-Town Expansion Strategy

1. **Town Isolation:**
   Each town operates under an independent `BaseTracker` instance configured with its local `TimetableProvider` and `SiriClient`.
2. **Telemetry Invariant:**
   A town must only be registered in `TrackerRegistry` if:
   - A verified static timetable provider exists.
   - An active real-time vehicle telemetry channel (SIRI-Lite, SIRI-VM, or GTFS-RT) is confirmed with upstream credentials or open public endpoints.
   - Local holiday and service calendar dates are verified in `src/data/holidays.json`.
3. **Pending Operator Decision:**
   Before registering a second town, the system requires confirmation from the user regarding:
   - Target municipality (e.g. Maresme coastal corridor, Granollers, Sabadell/Terrassa).
   - Upstream real-time API availability (SIRI endpoint or GTFS-RT feed URL).
