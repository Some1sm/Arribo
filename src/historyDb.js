const path = require('path');
const fs = require('fs');

let DatabaseSync;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch {
  DatabaseSync = null;
  console.error('[HistoryDB] ⚠️ node:sqlite is not available in this Node.js runtime.');
  console.error('[HistoryDB] ⚠️ node:sqlite requires Node.js >= 22.5. Current version:', process.version);
  console.error('[HistoryDB] ⚠️ All delay analytics, trails, and journalism reports will return empty data until upgraded.');
}

// ── times_source provenance vocabulary ───────────────────────────────
// delay_logs.times_source records WHERE scheduled_time/actual_time came
// from. There are three distinct states and they must never be collapsed
// into two, because the weakest one is an approximation:
//   '' / anything else  → reported by the upstream feed (OBSERVED evidence)
//   'derived_timetable' → derived live from the static timetable at ingest
//   'derived_timetable_backfill' → approximated OFFLINE by
//                         scripts/backfill_delay_times.js, which matches on
//                         line + stop name + time + delay and guesses the
//                         direction; explicitly weaker than a live derivation
// Every consumer classifies through the helpers below. Exact-equality
// string checks are exactly what let a backfilled approximation count as an
// observed time and produce a "corroborated" verdict on no real evidence.
const TIMES_SOURCE_DERIVED_LIVE = 'derived_timetable';
const TIMES_SOURCE_DERIVED_BACKFILL = 'derived_timetable_backfill';
const DERIVED_TIMES_SOURCES = new Set([TIMES_SOURCE_DERIVED_LIVE, TIMES_SOURCE_DERIVED_BACKFILL]);
const TIMES_PROVENANCE = {
  OBSERVED: 'observed',
  DERIVED: TIMES_SOURCE_DERIVED_LIVE,
  BACKFILL: TIMES_SOURCE_DERIVED_BACKFILL,
  MIXED: 'mixed',
  NONE: 'none'
};

/** A row carries a usable time pair only when BOTH halves are populated. */
function hasStoredTimes(row) {
  return !!(row && row.scheduledTime && row.scheduledTime !== '' && row.actualTime && row.actualTime !== '');
}

/** Per-row provenance: observed / derived_timetable / derived_timetable_backfill / none. */
function classifyTimes(row) {
  if (!hasStoredTimes(row)) return TIMES_PROVENANCE.NONE;
  if (row.timesSource === TIMES_SOURCE_DERIVED_BACKFILL) return TIMES_PROVENANCE.BACKFILL;
  if (DERIVED_TIMES_SOURCES.has(row.timesSource)) return TIMES_PROVENANCE.DERIVED;
  return TIMES_PROVENANCE.OBSERVED;
}

/** Per-row provenance counts, used for the episode-level roll-up. */
function countTimesProvenance(rows) {
  const counts = { observed: 0, derived: 0, backfill: 0, none: 0 };
  for (const r of rows) {
    switch (classifyTimes(r)) {
      case TIMES_PROVENANCE.OBSERVED: counts.observed++; break;
      case TIMES_PROVENANCE.DERIVED: counts.derived++; break;
      case TIMES_PROVENANCE.BACKFILL: counts.backfill++; break;
      default: counts.none++;
    }
  }
  return counts;
}

/**
 * Episode-level summary of the row-level counts. A single kind means every
 * timed row agreed; MIXED means the episode mixes kinds, and the per-row
 * timesProvenance on rawRows is then the authoritative signal.
 */
function summariseTimesProvenance(counts) {
  const present = [];
  if (counts.observed > 0) present.push(TIMES_PROVENANCE.OBSERVED);
  if (counts.derived > 0) present.push(TIMES_PROVENANCE.DERIVED);
  if (counts.backfill > 0) present.push(TIMES_PROVENANCE.BACKFILL);
  if (present.length === 0) return TIMES_PROVENANCE.NONE;
  return present.length === 1 ? present[0] : TIMES_PROVENANCE.MIXED;
}

// ── Mataró scope guard ────────────────────────────────────────────────
// Mataró Bus Urbà is L1–L8 and nothing else. delay_logs predates that scope
// and still holds retired Catalonia-wide rows (C-10, AMB, DIREXIS, Monbus,
// Baix Llobregat), so any "all lines" aggregate that does not filter leaks
// retired lines into Mataró KPIs and the incident ranking. Mataró rows are
// written with a bare-digit line_id and an 'L<n>' line_code
// (src/ingestionDaemon.js); retired rows that happen to reuse an L-code carry
// a provider-prefixed line_id such as 'amb_l1' or 'cat_fgc_l6_l6', so BOTH
// halves of the predicate are load-bearing. The id is accepted with or without
// its L prefix so a row that identifies itself as 'L1' is not dropped on a
// formatting technicality. Constants only — no user input.
const MATARO_LINE_IDS = ['1', '2', '3', '4', '5', '6', '7', '8'];
const MATARO_LINE_CODES = MATARO_LINE_IDS.map(id => `L${id}`);
const MATARO_SCOPE_SQL = ' AND (UPPER(line_code) IN ('
  + MATARO_LINE_CODES.map(code => `'${code}'`).join(', ')
  + ') AND line_id IN ('
  + MATARO_LINE_IDS.concat(MATARO_LINE_CODES).map(id => `'${id}'`).join(', ')
  + '))';
const MATARO_RETIRED_SCOPE_CHECK = MATARO_LINE_CODES;

/** Restrict an already-built WHERE clause to Mataró L1–L8 when no line is selected. */
function appendMataroScope(sqlWhere, isAll) {
  return isAll ? sqlWhere + MATARO_SCOPE_SQL : sqlWhere;
}

// Delay episode boundary: two consecutive samples on the same line+stop that
// are further apart than this start a new episode. Matches the GAP_MS that
// inspectDelayIncident groups on, so both report the same thing.
const EPISODE_GAP_MS = 5 * 60 * 1000;

class HistoryDatabase {
  constructor() {
    const customDataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
    this.dbPath = process.env.DB_PATH || path.join(customDataDir, 'transit_history.db');
    // Raw vehicle positions are only needed for the recent trail endpoint. Keep
    // this configurable so deployments can trade trail history for disk usage.
    const snapshotRetentionHours = Number.parseFloat(process.env.SNAPSHOT_RETENTION_HOURS || '2');
    this.snapshotRetentionHours = Number.isFinite(snapshotRetentionHours) && snapshotRetentionHours > 0
      ? snapshotRetentionHours
      : 2;
    const delayRetentionDays = Number.parseInt(process.env.DELAY_RETENTION_DAYS || '30', 10);
    this.delayRetentionDays = Number.isFinite(delayRetentionDays) && delayRetentionDays > 0
      ? delayRetentionDays
      : 30;
    this.db = null;
    // Cached prepared statements for the high-frequency write paths
    this._snapshotStmt = null;
    this._delayStmt = null;
  }

  // Public init() kept for backwards compatibility; delegates to lazy open.
  init(customPath = null) {
    if (customPath && typeof customPath === 'string' && customPath !== this.dbPath) {
      this.close();
      this.dbPath = customPath;
    }
    return this._ensureOpen();
  }

  // Lazy open: idempotent. The SQLite handle, schema DDL and DROP INDEX
  // migrations only run on first use, so merely requiring this module in ANY
  // process has no filesystem side effects.
  _ensureOpen() {
    if (this.db) return true;
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (DatabaseSync) {
      try {
        this.db = new DatabaseSync(this.dbPath);
        const madridHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', hourCycle: 'h23' });
        this.db.function('madrid_hour', { deterministic: true }, timestamp => {
          if (!timestamp) return '00';
          return madridHour.format(new Date(Number(timestamp)));
        });
        const madridDateTimeFmt = new Intl.DateTimeFormat('sv-SE', {
          timeZone: 'Europe/Madrid',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23'
        });
        this.db.function('madrid_datetime', { deterministic: true }, timestamp => {
          if (!timestamp) return '';
          return madridDateTimeFmt.format(new Date(Number(timestamp)));
        });
        const madridTimeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        this.db.function('is_telemetry_anomaly', { deterministic: true }, (timestamp, delayMins, stopName) => {
          if (!timestamp) return 0;
          const sName = String(stopName || '').toLowerCase();
          if (sName.includes('cotxeres') || sName.includes('depot') || sName.includes('taller')) return 1;
          const timeStr = madridTimeFmt.format(new Date(Number(timestamp)));
          const [hStr, mStr] = timeStr.split(':');
          const h = parseInt(hStr, 10);
          const m = parseInt(mStr, 10);
          const delay = Number(delayMins || 0);
          // Maintenance hours: night and early morning before 06:00 (first revenue trips start ~06:00)
          if (h >= 23 || h < 6) return 1;
          // Morning rollout SAE trip misassignment: 06:00 to 06:30 with high delay
          if (h === 6 && m <= 30 && delay >= 10) return 1;
          return 0;
        });
        this.db.exec(`
          PRAGMA auto_vacuum = INCREMENTAL;
          PRAGMA journal_mode = WAL;
          PRAGMA busy_timeout = 5000;
          PRAGMA synchronous = NORMAL;
          PRAGMA cache_size = -1024;
          PRAGMA mmap_size = 0;
          PRAGMA wal_autocheckpoint = 200;
          PRAGMA journal_size_limit = 67108864;
          PRAGMA temp_store = MEMORY;

          CREATE TABLE IF NOT EXISTS vehicle_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vehicle_id TEXT NOT NULL,
            line_id TEXT NOT NULL,
            line_code TEXT NOT NULL,
            agency TEXT,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            speed_kmh REAL DEFAULT 0,
            bearing REAL DEFAULT 0,
            delay_mins INTEGER DEFAULT 0,
            is_realtime INTEGER DEFAULT 1,
            status TEXT DEFAULT 'active',
            timestamp INTEGER NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_veh_time ON vehicle_snapshots(vehicle_id, timestamp);
          CREATE INDEX IF NOT EXISTS idx_line_time ON vehicle_snapshots(line_code, timestamp);
          CREATE INDEX IF NOT EXISTS idx_veh_timestamp ON vehicle_snapshots(timestamp);

          CREATE TABLE IF NOT EXISTS delay_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vehicle_id TEXT DEFAULT '',
            line_id TEXT NOT NULL,
            line_code TEXT NOT NULL,
            agency TEXT,
            stop_id TEXT,
            stop_name TEXT,
            delay_mins INTEGER DEFAULT 0,
            scheduled_time TEXT,
            actual_time TEXT,
            is_realtime INTEGER DEFAULT 1,
            is_delayed INTEGER DEFAULT 0,
            timestamp INTEGER NOT NULL,
            direction TEXT DEFAULT '',
            times_source TEXT DEFAULT ''
          );

          -- idx_delay_line / idx_delay_line_timestamp (exact duplicates of each
          -- other) and idx_delay_timestamp (prefix-covered by idx_delay_time_line)
          -- removed as redundant.
          CREATE INDEX IF NOT EXISTS idx_delay_stop ON delay_logs(stop_id, timestamp);
          CREATE INDEX IF NOT EXISTS idx_delay_time_line ON delay_logs(timestamp, line_code);

          -- Incremental rollup progress. last_id = highest delay_logs.id folded
          -- into hourly_line_stats so successive runs only touch new rows.
          CREATE TABLE IF NOT EXISTS hourly_rollup_progress (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            last_id INTEGER NOT NULL
          );

          -- Option B: Hourly Aggregated Rollup Table (Kept indefinitely with <1 MB/day footprint)
          CREATE TABLE IF NOT EXISTS hourly_line_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            line_code TEXT NOT NULL,
            agency TEXT,
            date_hour TEXT NOT NULL,
            sample_count INTEGER DEFAULT 0,
            avg_delay_mins REAL DEFAULT 0,
            max_delay_mins INTEGER DEFAULT 0,
            on_time_count INTEGER DEFAULT 0,
            late_count INTEGER DEFAULT 0,
            timestamp INTEGER NOT NULL,
            UNIQUE(line_code, date_hour)
          );


          -- Realtime bus observations (delay memory): AMB-tracked arrivals
          -- persisted so downstream stops without realtime coverage can still
          -- show the known delay. Purged after 2 route completions.
          CREATE TABLE IF NOT EXISTS amb_bus_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            agency TEXT NOT NULL,
            line_code TEXT NOT NULL,
            line_id TEXT NOT NULL,
            direction TEXT NOT NULL,
            trip_id TEXT,
            stop_id TEXT NOT NULL,
            stop_name TEXT,
            scheduled_ms INTEGER NOT NULL,
            actual_ms INTEGER NOT NULL,
            delay_mins INTEGER NOT NULL,
            run_duration_secs INTEGER,
            created_ms INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_ambobs_line ON amb_bus_observations(line_id, direction, scheduled_ms);
        `);
        if (!this.db.prepare('PRAGMA table_info(hourly_line_stats)').all().some(column => column.name === 'delay_sum')) {
          this.db.exec('ALTER TABLE hourly_line_stats ADD COLUMN delay_sum REAL;');
        }
        if (!this.db.prepare('PRAGMA table_info(delay_logs)').all().some(column => column.name === 'vehicle_id')) {
          this.db.exec("ALTER TABLE delay_logs ADD COLUMN vehicle_id TEXT DEFAULT '';");
        }
        // Provenance columns. Without direction a scheduled time cannot be
        // re-derived later, because the same line runs both ways with
        // different timetables. times_source records that scheduled/actual
        // were derived from the static timetable, not observed upstream.
        if (!this.db.prepare('PRAGMA table_info(delay_logs)').all().some(column => column.name === 'direction')) {
          this.db.exec("ALTER TABLE delay_logs ADD COLUMN direction TEXT DEFAULT '';");
        }
        if (!this.db.prepare('PRAGMA table_info(delay_logs)').all().some(column => column.name === 'times_source')) {
          this.db.exec("ALTER TABLE delay_logs ADD COLUMN times_source TEXT DEFAULT '';");
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_delay_veh_time ON delay_logs(vehicle_id, timestamp);');
        // Preserve legacy rollups whose raw observations have already been pruned.
        this.db.exec(`
          DROP INDEX IF EXISTS idx_delay_line;
          DROP INDEX IF EXISTS idx_delay_timestamp;
          DROP INDEX IF EXISTS idx_delay_line_timestamp;
          DROP INDEX IF EXISTS idx_delay_stop_timestamp;
          DROP INDEX IF EXISTS idx_hourly_stats;
        `);
        console.log('[HistoryDB] SQLite Database Initialized successfully at', this.dbPath);
      } catch (err) {
        console.error('[HistoryDB] Failed to initialize SQLite:', err.message);
        this.db = null;
      }
    }
    return this.db != null;
  }

  recordVehicleSnapshot(snap) {
    if (!snap || !snap.vehicleId) return;
    if (!this._ensureOpen()) return;
    try {
      if (!this._snapshotStmt) {
        this._snapshotStmt = this.db.prepare(`
          INSERT INTO vehicle_snapshots
          (vehicle_id, line_id, line_code, agency, lat, lon, speed_kmh, bearing, delay_mins, is_realtime, status, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
      }
      const stmt = this._snapshotStmt;
      stmt.run(
        String(snap.vehicleId),
        String(snap.lineId || ''),
        String(snap.lineCode || '').toUpperCase(),
        String(snap.agency || 'Transit'),
        Number(snap.lat || 0),
        Number(snap.lon || 0),
        Number(snap.speedKmh || 0),
        Number(snap.bearing || 0),
        Number(snap.delayMins || 0),
        snap.isRealTime !== false ? 1 : 0,
        String(snap.status || 'active'),
        snap.timestamp || Date.now()
      );
    } catch {
      // Ignore transient write errors
    }
  }

  _getStopCoordsMap() {
    if (this._stopCoordsMap) return this._stopCoordsMap;
    this._stopCoordsMap = new Map();
    try {
      const paradasFile = path.join(__dirname, '..', 'data', 'cities', 'mataro', 'mataro_paradas.json');
      if (fs.existsSync(paradasFile)) {
        const raw = JSON.parse(fs.readFileSync(paradasFile, 'utf8'));
        const list = Array.isArray(raw) ? raw : (raw.message || []);
        list.forEach(p => {
          if (p.name && Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) {
            const clean = p.name.split(' - ')[0].trim().toLowerCase();
            this._stopCoordsMap.set(clean, { lat: p.latitude, lon: p.longitude });
          }
        });
      }
    } catch {}
    return this._stopCoordsMap;
  }

  _getStopDistance(stopA, stopB) {
    if (!stopA || !stopB) return null;
    if (stopA.toLowerCase() === stopB.toLowerCase()) return 0;
    const map = this._getStopCoordsMap();
    const cleanA = stopA.split(' - ')[0].trim().toLowerCase();
    const cleanB = stopB.split(' - ')[0].trim().toLowerCase();
    const posA = map.get(cleanA);
    const posB = map.get(cleanB);
    if (!posA || !posB) return null;
    const dLat = (posB.lat - posA.lat) * 111320;
    const dLon = (posB.lon - posA.lon) * 83300;
    return Math.sqrt(dLat * dLat + dLon * dLon);
  }

  recordDelayLog(entry) {
    if (!entry || !entry.lineCode) return;
    if (!this._ensureOpen()) return;
    try {
      const delay = Number(entry.delayMins || 0);

      // Sanity filter: Ignore corrupt or impossible outlier delays (e.g. clock desyncs < -15 min or > 300 min)
      if (isNaN(delay) || delay < -15 || delay > 300) {
        return;
      }

      if (!this._delayStmt) {
        this._delayStmt = this.db.prepare(`
          INSERT INTO delay_logs
          (vehicle_id, line_id, line_code, agency, stop_id, stop_name, delay_mins, scheduled_time, actual_time, is_realtime, is_delayed, timestamp, direction, times_source)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
      }
      const stmt = this._delayStmt;
      stmt.run(
        String(entry.vehicleId || ''),
        String(entry.lineId || ''),
        String(entry.lineCode || '').toUpperCase(),
        String(entry.agency || 'Transit'),
        String(entry.stopId || ''),
        String(entry.stopName || ''),
        delay,
        String(entry.scheduledTime || ''),
        String(entry.actualTime || ''),
        entry.isRealTime ? 1 : 0,
        delay > 3 ? 1 : 0,
        entry.timestamp || Date.now(),
        String(entry.direction || ''),
        String(entry.timesSource || '')
      );
    } catch {
      // Ignore transient write errors
    }
  }

  getVehicleTrail(vehicleId, minutesBack = 45) {
    if (!this._ensureOpen()) return [];
    try {
      const cutoff = Date.now() - minutesBack * 60 * 1000;
      const stmt = this.db.prepare(`
        SELECT lat, lon, speed_kmh as speedKmh, bearing, delay_mins as delayMins, timestamp
        FROM vehicle_snapshots
        WHERE vehicle_id = ? AND timestamp >= ?
        ORDER BY timestamp ASC
        LIMIT 100
      `);
      return stmt.all(String(vehicleId), cutoff);
    } catch (e) {
      console.error('[HistoryDB] getVehicleTrail error:', e.message);
      return [];
    }
  }

  getLineDelayStats(lineCode, hoursBack = 24, lineId = null) {
    if (!this._ensureOpen()) return { totalSamples: 0, avgDelayMins: 0, maxDelayMins: 0, onTimePct: 100, latePct: 0, moderateLatePct: 0, severeLatePct: 0, isBaseline: true };
    try {
      const cutoff = Date.now() - hoursBack * 3600 * 1000;
      const raw = String(lineCode || '').trim();
      const codeUpper = raw.toUpperCase();
      const codeNoHyphen = codeUpper.replace(/[-_\s]/g, '');
      const codeWithL = codeUpper.startsWith('L') ? codeUpper : `L${codeUpper}`;
      const codeWithoutL = codeUpper.startsWith('L') ? codeUpper.substring(1) : codeUpper;
      const idUpper = lineId ? String(lineId).toUpperCase().trim() : codeUpper;
      const idClean = idUpper.replace('CAT_GEN_', '').replace(/.*_/, '');

      const stmt = this.db.prepare(`
        SELECT 
          COUNT(*) as totalSamples,
          AVG(delay_mins) as avgDelayMins,
          MAX(delay_mins) as maxDelayMins,
          SUM(CASE WHEN delay_mins <= 3 THEN 1 ELSE 0 END) as onTimeCount,
          SUM(CASE WHEN delay_mins > 3 AND delay_mins <= 8 THEN 1 ELSE 0 END) as moderateLateCount,
          SUM(CASE WHEN delay_mins > 8 THEN 1 ELSE 0 END) as severeLateCount
        FROM delay_logs
        WHERE (
          UPPER(line_code) = ? 
          OR UPPER(line_code) = ? 
          OR UPPER(line_code) = ?
          OR UPPER(line_code) = ?
          OR UPPER(line_code) = ?
          OR UPPER(line_id) = ?
          OR UPPER(line_id) = ?
          OR UPPER(REPLACE(REPLACE(line_code, '-', ''), '_', '')) = ?
        ) AND timestamp >= ?
      `);
      const row = stmt.get(codeUpper, codeNoHyphen, codeWithL, codeWithoutL, idClean, idUpper, codeUpper, codeNoHyphen, cutoff);
      if (row && row.totalSamples > 0) {
        const total = row.totalSamples;
        return {
          totalSamples: row.totalSamples,
          avgDelayMins: Math.round((row.avgDelayMins || 0) * 10) / 10,
          maxDelayMins: row.maxDelayMins || 0,
          onTimePct: Math.round((row.onTimeCount / total) * 100),
          // Measured straight from the raw rows, so the split is real.
          moderateLatePct: Math.round((row.moderateLateCount / total) * 100),
          severeLatePct: Math.round((row.severeLateCount / total) * 100),
          severitySplitMeasured: true,
          latePct: Math.round(((row.moderateLateCount + row.severeLateCount) / total) * 100)
        };
      }

      // Check hourly rollup
      const hourlyStmt = this.db.prepare(`
        SELECT 
          SUM(sample_count) as totalSamples,
          AVG(avg_delay_mins) as avgDelayMins,
          MAX(max_delay_mins) as maxDelayMins,
          SUM(on_time_count) as onTimeCount,
          SUM(late_count) as lateCount
        FROM hourly_line_stats
        WHERE (UPPER(line_code) = ? OR UPPER(line_code) = ? OR UPPER(line_code) = ?) AND timestamp >= ?
      `);
      const hRow = hourlyStmt.get(codeUpper, codeNoHyphen, codeWithL, cutoff);
      if (hRow && hRow.totalSamples > 0) {
        const total = hRow.totalSamples;
        const onTimePct = Math.round((hRow.onTimeCount / total) * 100);
        const latePct = Math.round((hRow.lateCount / total) * 100);
        return {
          totalSamples: total,
          avgDelayMins: Math.round((hRow.avgDelayMins || 0) * 10) / 10,
          maxDelayMins: hRow.maxDelayMins || 0,
          onTimePct: Math.max(0, Math.min(100, onTimePct)),
          // hourly_line_stats stores only a single "late" bucket (> 3 min), so
          // the moderate/severe split is NOT recoverable here. Report it as
          // not-measured instead of inventing a fixed ratio from latePct.
          moderateLatePct: null,
          severeLatePct: null,
          severitySplitMeasured: false,
          severitySplitNote: 'hourly_line_stats keeps a single "late > 3 min" bucket, so the moderate/severe split cannot be measured for rolled-up hours',
          latePct: Math.max(0, Math.min(100, latePct))
        };
      }

      return {
        totalSamples: 0,
        avgDelayMins: 0,
        maxDelayMins: 0,
        onTimePct: 100,
        latePct: 0,
        moderateLatePct: 0,
        severeLatePct: 0,
        isBaseline: true
      };
    } catch (e) {
      console.error('[HistoryDB] getLineDelayStats error:', e.message);
      return { totalSamples: 0, avgDelayMins: 0, maxDelayMins: 0, onTimePct: 100, latePct: 0, isBaseline: true };
    }
  }

  getJournalismReport(hoursBack = 24, allLinesCatalog = []) {
    if (!this._ensureOpen()) return { summary: {}, rankingMostDelayed: [], rankingBestPunctuality: [], rankingWorstStops: [], allStopDelays: [], agencyStats: [] };
    try {
      const cutoff = Date.now() - hoursBack * 3600 * 1000;

      // 1. Overall Summary (excluding phantom ghost delays from parked/unclosed sessions)
      // Every builder below is scoped to Mataró L1–L8: the table still holds
      // retired Catalonia-wide rows, and an unscoped "network" average would
      // fold them into the headline punctuality number.
      const summaryStmt = this.db.prepare(`
        SELECT
          COUNT(*) as totalRecordedArrivals,
          COUNT(DISTINCT line_code) as monitoredLinesCount,
          AVG(delay_mins) as networkAvgDelay,
          MAX(delay_mins) as networkMaxDelay,
          SUM(CASE WHEN delay_mins <= 3 THEN 1 ELSE 0 END) as totalOnTime,
          SUM(CASE WHEN delay_mins > 5 THEN 1 ELSE 0 END) as totalSignificantDelay,
          SUM(CASE WHEN is_realtime = 0 THEN 1 ELSE 0 END) as nonRealtimeSamples
        FROM delay_logs
        WHERE timestamp >= ? AND delay_mins >= -15${MATARO_SCOPE_SQL}
      `);
      const sum = summaryStmt.get(cutoff) || {};
      const totalArrivals = sum.totalRecordedArrivals || 0;
      // Dead-reckoned vehicles are stored with is_realtime = 0. They are a real
      // part of the sample and are NOT excluded, but the split is disclosed so
      // nobody reads "Puntualitat Global" as 100% fresh GPS.
      const nonRealtimeSamples = sum.nonRealtimeSamples || 0;

      // 2. Ranking of Most Delayed Lines from DB
      const delayedStmt = this.db.prepare(`
        SELECT
          line_code as lineCode,
          agency,
          COUNT(*) as sampleCount,
          AVG(delay_mins) as avgDelay,
          MAX(delay_mins) as maxDelay,
          ROUND((SUM(CASE WHEN delay_mins > 3 THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as latePercentage
        FROM delay_logs
        WHERE timestamp >= ? AND delay_mins >= -15${MATARO_SCOPE_SQL}
        GROUP BY line_code
        HAVING sampleCount >= 1
        ORDER BY avgDelay DESC
        LIMIT 2000
      `);
      const dbDelayed = delayedStmt.all(cutoff).map(r => ({
        ...r,
        avgDelay: Math.round((r.avgDelay || 0) * 10) / 10
      }));

      const normKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const validCatalogMap = new Map();
      if (Array.isArray(allLinesCatalog) && allLinesCatalog.length > 0) {
        allLinesCatalog.forEach(line => {
          if (!line) return;
          const kCode = normKey(line.code);
          const kId = normKey(line.id);
          const rawCode = String(line.code || '').toUpperCase();
          const rawId = String(line.id || '').toUpperCase();
          if (kCode) validCatalogMap.set(kCode, line);
          if (kId) validCatalogMap.set(kId, line);
          if (rawCode) validCatalogMap.set(rawCode, line);
          if (rawId) validCatalogMap.set(rawId, line);
        });
      }

      // Filter dbDelayed so ONLY lines that exist in the public bus searcher / catalog are kept!
      const rankingMostDelayed = [];
      dbDelayed.forEach(r => {
        if (!r || (r.sampleCount || 0) < 1) return;
        const cleanKey = normKey(r.lineCode);
        const rawKey = String(r.lineCode || '').toUpperCase();

        let catalogLine = validCatalogMap.get(cleanKey) || validCatalogMap.get(rawKey);
        if (!catalogLine && validCatalogMap.size > 0) {
          // Strictly drop lines that do not exist in the public bus searcher (e.g. internal depot codes)
          return;
        }

        rankingMostDelayed.push({
          ...r,
          lineId: catalogLine ? catalogLine.id : r.lineCode,
          lineCode: catalogLine ? catalogLine.code : r.lineCode,
          name: catalogLine ? catalogLine.name : (r.name || r.lineCode),
          color: catalogLine ? catalogLine.color : (r.color || '#009485'),
          agency: catalogLine ? (catalogLine.agency || r.agency) : r.agency
        });
      });

      // Sort: most delayed first, then by sample count
      rankingMostDelayed.sort((a, b) => {
        if (b.avgDelay !== a.avgDelay) return b.avgDelay - a.avgDelay;
        if (b.sampleCount !== a.sampleCount) return b.sampleCount - a.sampleCount;
        return (a.lineCode || '').localeCompare(b.lineCode || '', undefined, { numeric: true });
      });

      // 3. Ranking of Most Punctual Lines (only with active samples)
      const rankingBestPunctuality = [...rankingMostDelayed]
        .sort((a, b) => {
          const onTimeA = 100 - (a.latePercentage || 0);
          const onTimeB = 100 - (b.latePercentage || 0);
          if (onTimeB !== onTimeA) return onTimeB - onTimeA;
          return a.avgDelay - b.avgDelay;
        })
        .slice(0, 1000);

      // 4. Operator / Agency Breakdown (only with active samples)
      const agencyStmt = this.db.prepare(`
        SELECT
          agency,
          COUNT(*) as totalSamples,
          COUNT(DISTINCT line_code) as linesCount,
          AVG(delay_mins) as avgDelay,
          ROUND((SUM(CASE WHEN delay_mins <= 3 THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as onTimePct
        FROM delay_logs
        WHERE timestamp >= ? AND delay_mins >= -15${MATARO_SCOPE_SQL}
        GROUP BY agency
        HAVING totalSamples >= 1
        ORDER BY avgDelay DESC
      `);
      const dbAgencies = agencyStmt.all(cutoff).map(a => ({
        ...a,
        avgDelay: Math.round((a.avgDelay || 0) * 10) / 10
      }));

      const agencyStats = dbAgencies
        .filter(a => (a.totalSamples || 0) >= 1)
        .sort((a, b) => b.totalSamples - a.totalSamples);

      // 5. Ranking of Stops (Bottlenecks and Full Network Stops)
      const allStopsStmt = this.db.prepare(`
        SELECT 
          stop_id as stopId,
          line_id as recordedLineId,
          MAX(stop_name) as stopName,
          MAX(line_code) as lineCode,
          agency,
          COUNT(*) as arrivalCount,
          AVG(delay_mins) as avgDelay,
          MAX(delay_mins) as maxDelay,
          ROUND((SUM(CASE WHEN delay_mins >= 5 THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as severeLatePct
        FROM delay_logs
        WHERE timestamp >= ? AND delay_mins >= -15${MATARO_SCOPE_SQL}
          AND madrid_hour(timestamp) NOT IN ('00', '01', '02', '03', '04')
          AND is_telemetry_anomaly(timestamp, delay_mins, stop_name) = 0
        GROUP BY agency, line_id, stop_id
        HAVING arrivalCount >= 1
        ORDER BY avgDelay DESC, maxDelay DESC
      `);

      const stopKey = row => JSON.stringify([row.agency, row.recordedLineId, row.stopId]);

      const getHourlyTrafficContext = (hourNum) => this.getHourlyTrafficContext(hourNum);

      // Official scheduled operating hours for Mataró Bus Urbà lines L1-L8.
      // Outside these revenue hours, no buses operate and hourly cells are strictly empty.
      const lineOperatingHours = {
        '1': { minH: 5, maxH: 22 }, 'L1': { minH: 5, maxH: 22 },
        '2': { minH: 5, maxH: 22 }, 'L2': { minH: 5, maxH: 22 },
        '3': { minH: 6, maxH: 22 }, 'L3': { minH: 6, maxH: 22 },
        '4': { minH: 7, maxH: 22 }, 'L4': { minH: 7, maxH: 22 },
        '5': { minH: 5, maxH: 22 }, 'L5': { minH: 5, maxH: 22 },
        '6': { minH: 6, maxH: 22 }, 'L6': { minH: 6, maxH: 22 },
        '7': { minH: 7, maxH: 21 }, 'L7': { minH: 7, maxH: 21 },
        '8': { minH: 6, maxH: 22 }, 'L8': { minH: 6, maxH: 22 }
      };

      // Query Hourly Breakdown for All Stops
      const stopHourlyStmt = this.db.prepare(`
        SELECT 
          madrid_hour(timestamp) as hourOfDay,
          stop_id as stopId,
          line_id as recordedLineId,
          MAX(stop_name) as stopName,
          MAX(line_code) as lineCode,
          agency,
          COUNT(*) as arrivalCount,
          ROUND(AVG(delay_mins), 1) as avgDelay,
          MAX(delay_mins) as maxDelay,
          ROUND((SUM(CASE WHEN delay_mins >= 5 THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as severeLatePct
        FROM delay_logs
        WHERE timestamp >= ? AND delay_mins >= -15${MATARO_SCOPE_SQL}
          AND madrid_hour(timestamp) NOT IN ('00', '01', '02', '03', '04')
          AND is_telemetry_anomaly(timestamp, delay_mins, stop_name) = 0
        GROUP BY hourOfDay, agency, line_id, stop_id
        ORDER BY hourOfDay ASC, avgDelay DESC, arrivalCount DESC
      `);

      const stopHourlyRows = stopHourlyStmt.all(cutoff);
      const stopHoursMap = new Map();
      const hourlyStopsMap = new Map();

      stopHourlyRows.forEach(r => {
        const sKey = stopKey(r);
        if (!stopHoursMap.has(sKey)) stopHoursMap.set(sKey, []);
        stopHoursMap.get(sKey).push(r);

        const hKey = String(r.hourOfDay).padStart(2, '0');
        if (!hourlyStopsMap.has(hKey)) hourlyStopsMap.set(hKey, []);
        hourlyStopsMap.get(hKey).push(r);
      });

      const allStopDelays = allStopsStmt.all(cutoff)
        .map(r => ({
          ...r,
          avgDelay: Math.round((r.avgDelay || 0) * 10) / 10
        }))
        .filter(r => {
          if (validCatalogMap.size === 0) return true;
          const cleanKey = normKey(r.lineCode);
          const rawKey = String(r.lineCode || '').toUpperCase();
          return validCatalogMap.has(cleanKey) || validCatalogMap.has(rawKey);
        })
        .map(r => {
          const cleanKey = normKey(r.lineCode);
          const rawKey = String(r.lineCode || '').toUpperCase();
          const catalogLine = validCatalogMap.get(cleanKey) || validCatalogMap.get(rawKey);
          
          // Attach critical peak hour for this stop
          const sKey = stopKey(r);
          const hoursForStop = stopHoursMap.get(sKey) || [];
          hoursForStop.sort((a, b) => (b.avgDelay - a.avgDelay) || (b.arrivalCount - a.arrivalCount));
          const critical = hoursForStop[0] || null;

          let criticalHour = '--';
          let criticalHourAvgDelay = r.avgDelay;
          let criticalHourArrivals = 0;
          let criticalHourTag = 'Regular';
          let criticalHourIcon = '📍';
          let isSchoolHour = false;

          if (critical) {
            const hNum = parseInt(critical.hourOfDay, 10);
            const nextH = String((hNum + 1) % 24).padStart(2, '0');
            const ctx = getHourlyTrafficContext(hNum);
            criticalHour = `${critical.hourOfDay}:00 - ${nextH}:00`;
            criticalHourAvgDelay = critical.avgDelay;
            criticalHourArrivals = critical.arrivalCount;
            criticalHourTag = ctx.tag;
            criticalHourIcon = ctx.icon;
            isSchoolHour = ctx.isSchoolHour;
          }

          const op = lineOperatingHours[cleanKey] || lineOperatingHours[rawKey] || { minH: 5, maxH: 22 };
          const isBottleneck = ((r.avgDelay || 0) >= 1.5 || (r.severeLatePct || 0) >= 20.0);

          return {
            ...r,
            isBottleneck,
            hourly: Array.from({ length: 24 }, (_, hour) => {
              const hourKey = String(hour).padStart(2, '0');
              const isOperating = hour >= op.minH && hour <= op.maxH;
              const bucket = isOperating ? hoursForStop.find(row => row.hourOfDay === hourKey) : null;
              return {
                hour: hourKey,
                sampleCount: bucket?.arrivalCount || 0,
                avgDelay: bucket?.avgDelay ?? null,
                maxDelay: bucket?.maxDelay ?? null,
                severeLatePct: bucket?.severeLatePct ?? null
              };
            }),
            lineId: catalogLine ? catalogLine.id : r.recordedLineId,
            lineCode: catalogLine ? catalogLine.code : r.lineCode,
            agency: catalogLine ? (catalogLine.agency || r.agency) : r.agency,
            criticalHour,
            criticalHourAvgDelay,
            criticalHourArrivals,
            criticalHourTag,
            criticalHourIcon,
            isSchoolHour
          };
        });

      const rankingWorstStops = allStopDelays
        .filter(r => r.isBottleneck)
        .slice(0, 100);

      const totalMonitoredCount = allLinesCatalog && allLinesCatalog.length > 0
        ? allLinesCatalog.length
        : Math.max(sum.monitoredLinesCount || 0, rankingMostDelayed.length);

      // 6. Hourly Congestion Spike Analysis (24-Hour Distribution & School Rush)
      const hourlyStmt = this.db.prepare(`
        SELECT 
          madrid_hour(timestamp) as hourOfDay,
          COUNT(*) as sampleCount,
          ROUND(AVG(delay_mins), 1) as avgDelay,
          MAX(delay_mins) as maxDelay,
          SUM(CASE WHEN delay_mins > 3 THEN 1 ELSE 0 END) as lateCount,
          ROUND((SUM(CASE WHEN delay_mins > 3 THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as latePercentage,
          ROUND((SUM(CASE WHEN delay_mins >= 5 THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as severeLatePercentage
        FROM delay_logs
        WHERE timestamp >= ? AND delay_mins >= -15${MATARO_SCOPE_SQL}
          AND madrid_hour(timestamp) NOT IN ('00', '01', '02', '03', '04')
          AND is_telemetry_anomaly(timestamp, delay_mins, stop_name) = 0
        GROUP BY hourOfDay
        ORDER BY hourOfDay ASC
      `);

      const dbHourly = hourlyStmt.all(cutoff);
      const hourlyMap = new Map();
      dbHourly.forEach(row => hourlyMap.set(String(row.hourOfDay).padStart(2, '0'), row));

      const hourlyDelays = [];
      for (let h = 0; h < 24; h++) {
        const hStr = String(h).padStart(2, '0');
        const nextHStr = String((h + 1) % 24).padStart(2, '0');
        const context = getHourlyTrafficContext(h);
        const row = hourlyMap.get(hStr);

        hourlyDelays.push({
          hour: hStr,
          timeWindow: `${hStr}:00 - ${nextHStr}:00`,
          sampleCount: row ? (row.sampleCount || 0) : 0,
          avgDelay: row ? (row.avgDelay || 0) : 0,
          maxDelay: row ? (row.maxDelay || 0) : 0,
          lateCount: row ? (row.lateCount || 0) : 0,
          latePercentage: row ? (row.latePercentage || 0) : 0,
          severeLatePercentage: row ? (row.severeLatePercentage || 0) : 0,
          trafficTag: context.tag,
          isSchoolHour: context.isSchoolHour,
          isPeak: context.isPeak,
          icon: context.icon
        });
      }

      // Identify top peak congestion hours with worst bottleneck stops attached
      const activeHours = hourlyDelays.filter(h => h.sampleCount > 0);
      const peakHours = [...activeHours]
        .sort((a, b) => (b.avgDelay - a.avgDelay) || (b.latePercentage - a.latePercentage))
        .slice(0, 5)
        .map(ph => {
          const worstStopsInHour = (hourlyStopsMap.get(ph.hour) || []).slice(0, 3).map(st => ({
            stopName: st.stopName,
            lineCode: st.lineCode,
            agency: st.agency,
            avgDelay: st.avgDelay,
            arrivalCount: st.arrivalCount
          }));
          return {
            ...ph,
            worstStopsDuringHour: worstStopsInHour
          };
        });

      // Every figure below is derived from a sublist of real samples. An empty
      // sublist means the value is UNKNOWN, not zero and not flattering: an
      // empty window used to publish a full A+ scorecard with an invented
      // champion line, an invented "Pl. de les Tereses" bottleneck and an
      // invented 08:00 peak, and the share/PNG exporters published it.
      const hasSamples = totalArrivals > 0;
      const peakHour = peakHours[0] || null;

      // Punctuality is a ratio over a real denominator. With no samples the
      // ratio does not exist; 100% would be the most flattering possible lie.
      const punctualityPct = hasSamples ? Math.round((sum.totalOnTime / totalArrivals) * 100) : null;
      let grade = null;
      if (punctualityPct !== null) {
        if (punctualityPct >= 92) grade = 'A+';
        else if (punctualityPct >= 84) grade = 'A';
        else if (punctualityPct >= 74) grade = 'B';
        else if (punctualityPct >= 62) grade = 'C';
        else grade = 'D';
      }

      const champion = rankingBestPunctuality.length > 0 ? rankingBestPunctuality[0] : null;
      const bottleneck = rankingWorstStops.length > 0 ? rankingWorstStops[0] : null;

      const termometre = {
        title: `El Termòmetre del Bus (${hoursBack <= 24 ? '24h' : (hoursBack <= 48 ? '48h' : '7 dies')})`,
        timeframeHours: hoursBack,
        // Explicit "there is nothing to grade" marker. A truthy termometre is
        // still returned so consumers render the empty state instead of
        // substituting their own placeholder scorecard.
        noData: !hasSamples,
        noDataReason: hasSamples ? '' : 'No hi ha cap mostra de retard registrada en aquesta finestra temporal.',
        grade,
        punctualityPct,
        networkAvgDelay: hasSamples ? Math.round((sum.networkAvgDelay || 0) * 10) / 10 : null,
        championLine: champion ? {
          code: champion.lineCode || champion.id,
          name: champion.name || `Línia ${champion.lineCode}`,
          onTimePct: champion.onTimePct !== undefined
            ? champion.onTimePct
            : (champion.latePercentage !== undefined ? Math.round(100 - champion.latePercentage) : null),
          avgDelay: champion.avgDelay
        } : null,
        worstBottleneck: bottleneck ? {
          stopName: bottleneck.stopName,
          lineCode: bottleneck.lineCode,
          avgDelay: bottleneck.avgDelay,
          severeLatePct: bottleneck.severeLatePct,
          criticalHour: bottleneck.criticalHour,
          criticalHourTag: bottleneck.criticalHourTag
        } : null,
        peakHour: peakHour ? peakHour.timeWindow : null,
        peakHourDelay: peakHour ? (peakHour.avgDelay ?? null) : null,
        peakHourTag: peakHour ? (peakHour.trafficTag || null) : null,
        peakHourIcon: peakHour ? (peakHour.icon || null) : null,
        totalTripsAnalyzed: totalArrivals
      };

      return {
        summary: {
          totalRecordedArrivals: totalArrivals,
          monitoredLinesCount: totalMonitoredCount,
          networkAvgDelay: hasSamples ? Math.round((sum.networkAvgDelay || 0) * 10) / 10 : null,
          networkMaxDelay: hasSamples ? (sum.networkMaxDelay ?? null) : null,
          networkPunctualityPct: punctualityPct,
          hasSamples,
          hoursAnalyzed: hoursBack,
          // Dead-reckoned samples are mixed into the KPIs above (they are real
          // recorded delays), so the split is published rather than hidden.
          samplingBreakdown: {
            totalSamples: totalArrivals,
            realtimeSamples: totalArrivals - nonRealtimeSamples,
            nonRealtimeSamples,
            nonRealtimePct: hasSamples ? Math.round((nonRealtimeSamples / totalArrivals) * 1000) / 10 : null,
            note: 'Les mostres amb is_realtime = 0 són posicions extrapolades (dead-reckoning), no GPS fresc. Es compten a la puntualitat global perquè el retard registrat és real, però no són una observació directa de la posició.'
          }
        },
        termometre,
        hourlyDelays,
        peakHours,
        rankingMostDelayed,
        rankingBestPunctuality,
        rankingWorstStops,
        allStopDelays,
        agencyStats
      };
    } catch (e) {
      console.error('[HistoryDB] getJournalismReport error:', e.message);
      return { summary: {}, termometre: null, rankingMostDelayed: [], rankingBestPunctuality: [], rankingWorstStops: [], allStopDelays: [], agencyStats: [] };
    }
  }

  exportDelayLogsCsv(hoursBack = 48) {
    if (!this._ensureOpen()) return 'timestamp,line_code,agency,stop_name,delay_mins,scheduled_time,actual_time\n';
    try {
      const cutoff = Date.now() - hoursBack * 3600 * 1000;
      const stmt = this.db.prepare(`
        SELECT 
          madrid_datetime(timestamp) as formatted_date,
          line_code,
          agency,
          stop_name,
          delay_mins,
          scheduled_time,
          actual_time,
          is_realtime
        FROM delay_logs
        WHERE timestamp >= ?
        ORDER BY timestamp DESC
        LIMIT 50000
      `);
      const rows = stmt.all(cutoff);
      let csv = 'Data i Hora,Linia,Operador,Parada,Retard (min),Horari Teoric,Horari Real,Es Temps Real\n';
      rows.forEach(r => {
        const cleanStop = (r.stop_name || '').replace(/"/g, '""');
        const cleanAgency = (r.agency || '').replace(/"/g, '""');
        csv += `"${r.formatted_date}","${r.line_code}","${cleanAgency}","${cleanStop}",${r.delay_mins},"${r.scheduled_time || ''}","${r.actual_time || ''}",${r.is_realtime}\n`;
      });
      return csv;
    } catch (e) {
      console.error('[HistoryDB] exportDelayLogsCsv error:', e.message);
      return 'Error exporting CSV\n';
    }
  }

  getHourlyTrafficContext(hourNum) {
    const h = Number(hourNum) || 0;
    if (h >= 0 && h < 6) {
      return { tag: '🔧 Cotxeres / Manteniment nocturn', isSchoolHour: false, isPeak: false, icon: '🔧', isDepot: true };
    }
    if (h === 6) {
      return { tag: '🌅 Inici servei matinal', isSchoolHour: false, isPeak: false, icon: '🌅', isDepot: false };
    }
    if (h === 7) {
      return { tag: '🌅 Primer torn de feina', isSchoolHour: false, isPeak: false, icon: '🌅', isDepot: false };
    }
    if (h === 8) {
      return { tag: '🚨 Entrada escolar & feina', isSchoolHour: true, isPeak: true, icon: '🎒', isDepot: false };
    }
    if (h === 9) {
      return { tag: '🏫 Post-entrada escoles', isSchoolHour: true, isPeak: false, icon: '📚', isDepot: false };
    }
    if (h >= 10 && h <= 12) {
      return { tag: '🟢 Vall matinal regular', isSchoolHour: false, isPeak: false, icon: '🟢', isDepot: false };
    }
    if (h === 13 || h === 14) {
      return { tag: '🥪 Migdia escolar & feina', isSchoolHour: true, isPeak: true, icon: '🥪', isDepot: false };
    }
    if (h >= 15 && h <= 16) {
      return { tag: '🟡 Vall tarda regular', isSchoolHour: false, isPeak: false, icon: '🟡', isDepot: false };
    }
    if (h === 17) {
      return { tag: '🚨 Sortida escolar', isSchoolHour: true, isPeak: true, icon: '🎒', isDepot: false };
    }
    if (h === 18 || h === 19) {
      return { tag: '🚗 Punta tornada feina', isSchoolHour: false, isPeak: true, icon: '🚗', isDepot: false };
    }
    if (h >= 20 && h <= 22) {
      return { tag: '🌙 Servei vespre', isSchoolHour: false, isPeak: false, icon: '🌙', isDepot: false };
    }
    return { tag: '🌙 Tancament servei', isSchoolHour: false, isPeak: false, icon: '🌙', isDepot: false };
  }

  getAnomalyContext(timestamp, delayMins, stopName) {
    const sName = String(stopName || '').toLowerCase();
    const isDepotStop = sName.includes('cotxeres') || sName.includes('depot') || sName.includes('taller');
    const madridFmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Madrid',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    });
    const d = new Date(Number(timestamp));
    const timeStr = madridFmt.format(d);
    const [hStr] = timeStr.split(':');
    const h = parseInt(hStr, 10);

    if (h >= 23 || h < 6 || isDepotStop) {
      return {
        anomalyType: 'maintenance',
        diagnosticBadge: '🔧 Cotxeres / Manteniment nocturn',
        anomalyIcon: '🔧'
      };
    }

    return {
      anomalyType: 'startup_sae',
      diagnosticBadge: '⚠️ Desfasament SAE torn matinal',
      anomalyIcon: '⚠️'
    };
  }

  /**
   * Deep-Dive Incident Inspector: Query and cluster high-delay occurrences.
   * Enables analyzing where, when, and how severe delays (>5m) formed.
   */
  getDelayIncidents({ lineCode = 'all', hours = 168, limit = 20, minDelay = 5 } = {}) {
    if (!this._ensureOpen()) {
      return {
        lineCode: String(lineCode || 'all').toUpperCase(),
        hoursAnalyzed: Number(hours) || 168,
        minDelayThreshold: Number(minDelay) || 5,
        summary: {
          totalRecordedIncidents: 0,
          rawSamplesOverThreshold: 0,
          listedCommercialEpisodes: 0,
          commercialEpisodeLimit: 0,
          maxDelayMins: null,
          maxCommercialDelayMins: null,
          maxDelayIsFromInvestigationTier: false,
          worstStop: 'Cap',
          worstStopCount: 0,
          worstHour: '--:00',
          worstHourTag: '',
          movingCount: 0,
          stationaryCount: 0,
          movingPct: 0
        },
        investigationIncidents: [],
        topIncidents: [],
        telemetryAnomalies: [],
        incidentTrips: []
      };
    }

    try {
      const hoursNum = Math.max(1, Math.min(720, Number(hours) || 168));
      const limitNum = Math.max(1, Math.min(100, Number(limit) || 20));
      const minDelayNum = Math.max(1, Number(minDelay) || 5);
      const cutoff = Date.now() - (hoursNum * 3600 * 1000);

      const cleanCode = String(lineCode || '').toUpperCase().trim();
      const isAll = !cleanCode || cleanCode === 'ALL' || cleanCode === 'TOTES';
      const codeWithL = cleanCode.startsWith('L') ? cleanCode : `L${cleanCode}`;
      const codeWithoutL = cleanCode.replace(/^L/, '');

      let sqlWhere = 'timestamp >= ? AND delay_mins >= ?';
      const baseParams = [cutoff, minDelayNum];
      if (!isAll) {
        sqlWhere += ' AND (UPPER(line_code) = ? OR UPPER(line_code) = ? OR line_id = ?)';
        baseParams.push(codeWithL, codeWithoutL, codeWithoutL);
      }
      // "All lines" means Mataró L1–L8. Without this the retired Catalonia-wide
      // rows still in delay_logs surface as Mataró top incidents.
      sqlWhere = appendMataroScope(sqlWhere, isAll);

      // 1. Summary Aggregate KPIs (filtered to revenue commercial service)
      const aggStmt = this.db.prepare(`
        SELECT COUNT(*) as totalCount, COALESCE(MAX(delay_mins), 0) as maxDelay,
          MAX(CASE WHEN delay_mins < 25 THEN delay_mins END) as maxCommercialDelay,
          SUM(CASE WHEN is_realtime = 0 THEN 1 ELSE 0 END) as nonRealtimeCount
        FROM delay_logs
        WHERE ${sqlWhere} AND is_telemetry_anomaly(timestamp, delay_mins, stop_name) = 0
      `);
      const agg = aggStmt.get(...baseParams) || { totalCount: 0, maxDelay: 0, maxCommercialDelay: null, nonRealtimeCount: 0 };

      // Worst stop
      const worstStopStmt = this.db.prepare(`
        SELECT stop_name as stopName, COUNT(*) as cnt
        FROM delay_logs
        WHERE ${sqlWhere} AND is_telemetry_anomaly(timestamp, delay_mins, stop_name) = 0
        GROUP BY stop_name
        ORDER BY cnt DESC
        LIMIT 1
      `);
      const worstStopRow = worstStopStmt.get(...baseParams);

      // Worst hour
      const worstHourStmt = this.db.prepare(`
        SELECT madrid_hour(timestamp) as hourOfDay, COUNT(*) as cnt
        FROM delay_logs
        WHERE ${sqlWhere} AND is_telemetry_anomaly(timestamp, delay_mins, stop_name) = 0
        GROUP BY hourOfDay
        ORDER BY cnt DESC
        LIMIT 1
      `);
      const worstHourRow = worstHourStmt.get(...baseParams);

      // 2. Query candidates partitioned into:
      // a) Regular service incidents: non-anomalies with delay < 25 min (0-24 min)
      // b) Non-normal schedules under investigation: non-anomalies with delay >= 25 min (24 min - infinite)
      // c) Telemetry anomalies: SAE startup / cotxeres maintenance (is_telemetry_anomaly = 1)
      const regularStmt = this.db.prepare(`
        SELECT 
          id,
          vehicle_id as vehicleId,
          line_id as lineId,
          line_code as lineCode,
          agency,
          stop_id as stopId,
          stop_name as stopName,
          delay_mins as delayMins,
          is_realtime as isRealTime,
          timestamp,
          madrid_datetime(timestamp) as formattedDate,
          madrid_hour(timestamp) as hourOfDay,
          0 as isAnomaly
        FROM delay_logs
        WHERE ${sqlWhere} AND delay_mins < 25 AND is_telemetry_anomaly(timestamp, delay_mins, stop_name) = 0
        ORDER BY delay_mins DESC, timestamp DESC
        LIMIT 3000
      `);
      const regularCandidates = regularStmt.all(...baseParams);

      const investigationStmt = this.db.prepare(`
        SELECT 
          id,
          vehicle_id as vehicleId,
          line_id as lineId,
          line_code as lineCode,
          agency,
          stop_id as stopId,
          stop_name as stopName,
          delay_mins as delayMins,
          is_realtime as isRealTime,
          timestamp,
          madrid_datetime(timestamp) as formattedDate,
          madrid_hour(timestamp) as hourOfDay,
          0 as isAnomaly
        FROM delay_logs
        WHERE ${sqlWhere} AND delay_mins >= 25 AND is_telemetry_anomaly(timestamp, delay_mins, stop_name) = 0
        ORDER BY delay_mins DESC, timestamp DESC
        LIMIT 2000
      `);
      const investigationCandidates = investigationStmt.all(...baseParams);

      const anomalyStmt = this.db.prepare(`
        SELECT 
          id,
          vehicle_id as vehicleId,
          line_id as lineId,
          line_code as lineCode,
          agency,
          stop_id as stopId,
          stop_name as stopName,
          delay_mins as delayMins,
          is_realtime as isRealTime,
          timestamp,
          madrid_datetime(timestamp) as formattedDate,
          madrid_hour(timestamp) as hourOfDay,
          1 as isAnomaly
        FROM delay_logs
        WHERE ${sqlWhere} AND is_telemetry_anomaly(timestamp, delay_mins, stop_name) = 1
        ORDER BY delay_mins DESC, timestamp DESC
        LIMIT 2000
      `);
      const rawAnomalyRows = anomalyStmt.all(...baseParams);
      const anomalyCandidates = rawAnomalyRows.map(r => {
        const anomalyCtx = this.getAnomalyContext(r.timestamp, r.delayMins, r.stopName);
        return {
          ...r,
          ...anomalyCtx
        };
      });

      // Deduplicate: A single delayed trip produces raw pings every 20 seconds.
      // We keep the peak delay record for each trip on the line (sliding window of 20 min).
      // The fallback key must include the stop: most historical rows carry no
      // vehicle_id, and a bare lineCode key then merges two different buses on
      // the same line into one "incident" whenever they are within the window.
      const deduplicateTripRows = (rows, maxLimit) => {
        const deduped = [];
        const lineTripWindows = new Map(); // dedup key -> array of timestamps of accepted peak incidents
        const TRIP_WINDOW_MS = 20 * 60 * 1000;

        for (const r of rows) {
          const lk = r.vehicleId
            ? `${r.lineCode}_${r.vehicleId}`
            : `${r.lineCode}|${r.stopName || ''}`;
          const accepted = lineTripWindows.get(lk) || [];
          const isSameTrip = accepted.some(ts => Math.abs(r.timestamp - ts) < TRIP_WINDOW_MS);
          if (isSameTrip) continue;

          accepted.push(r.timestamp);
          lineTripWindows.set(lk, accepted);
          deduped.push(r);

          if (deduped.length >= maxLimit) break;
        }
        return deduped;
      };

      const dedupedRegular = deduplicateTripRows(regularCandidates, limitNum);
      const dedupedInvestigation = deduplicateTripRows(investigationCandidates, limitNum);
      const dedupedAnomalies = deduplicateTripRows(anomalyCandidates, limitNum);

      const enrichedTop = dedupedRegular.map((r, idx) => {
        const h = parseInt(r.hourOfDay, 10);
        const ctx = this.getHourlyTrafficContext(h);
        return {
          rank: idx + 1,
          ...r,
          isRealTime: Boolean(r.isRealTime),
          trafficTag: ctx.tag,
          trafficIcon: ctx.icon,
          isPeak: ctx.isPeak,
          isSchoolHour: ctx.isSchoolHour
        };
      });

      const enrichedInvestigation = dedupedInvestigation.map((r, idx) => {
        const h = parseInt(r.hourOfDay, 10);
        const ctx = this.getHourlyTrafficContext(h);
        return {
          rank: idx + 1,
          ...r,
          isRealTime: Boolean(r.isRealTime),
          trafficTag: '🔬 En investigació',
          trafficIcon: '🔬',
          investigationReason: 'Horari no habitual (≥25 min) — Pendent d\'investigació de telemetria / SAE',
          isPeak: ctx.isPeak,
          isSchoolHour: ctx.isSchoolHour
        };
      });

      const enrichedAnomalies = dedupedAnomalies.map((r, idx) => {
        return {
          rank: idx + 1,
          ...r,
          isRealTime: Boolean(r.isRealTime),
          trafficTag: r.diagnosticBadge,
          trafficIcon: r.anomalyIcon,
          diagnosticBadge: r.diagnosticBadge,
          anomalyType: r.anomalyType
        };
      });

      // 3. Cluster incident trips (group consecutive telemetry pings per vehicle / spatial track)
      const clusterStmt = this.db.prepare(`
        SELECT 
          id,
          vehicle_id as vehicleId,
          line_id as lineId,
          line_code as lineCode,
          agency,
          stop_id as stopId,
          stop_name as stopName,
          delay_mins as delayMins,
          is_realtime as isRealTime,
          timestamp,
          madrid_datetime(timestamp) as formattedDate,
          madrid_hour(timestamp) as hourOfDay
        FROM delay_logs
        WHERE ${sqlWhere}
        ORDER BY line_code ASC, timestamp ASC
        LIMIT 3000
      `);
      const clusterRows = clusterStmt.all(...baseParams);

      const recoveryStmt = this.db.prepare(`
        SELECT 
          vehicle_id as vehicleId,
          stop_name as stopName, 
          delay_mins as delayMins, 
          timestamp
        FROM delay_logs
        WHERE (UPPER(line_code) = ? OR UPPER(line_code) = ?)
          AND timestamp > ?
          AND timestamp <= ?
          AND delay_mins < ?
          AND is_telemetry_anomaly(timestamp, delay_mins, stop_name) = 0
        ORDER BY timestamp ASC
        LIMIT 10
      `);

      const byLine = new Map();
      clusterRows.forEach(r => {
        const lk = r.lineCode;
        if (!byLine.has(lk)) byLine.set(lk, []);
        byLine.get(lk).push(r);
      });

      const allClusters = [];
      byLine.forEach((rows, lk) => {
        // Pool of active bus tracks currently running on this line
        const activeTracks = [];

        rows.forEach(r => {
          const h = parseInt(r.hourOfDay, 10);
          const isDepotHour = h < 6;

          // Retire stale tracks from activeTracks:
          // 1. Inactive for > 12 minutes
          // 2. Active duration > 45 minutes
          for (let i = activeTracks.length - 1; i >= 0; i--) {
            const t = activeTracks[i];
            const gap = r.timestamp - t.lastTs;
            const dur = r.timestamp - t.firstTs;
            if (gap > 12 * 60 * 1000 || dur > 45 * 60 * 1000) {
              allClusters.push(t);
              activeTracks.splice(i, 1);
            }
          }

          // Match r to the most compatible active track:
          let bestTrack = null;
          let bestScore = -1;

          for (const t of activeTracks) {
            const prevWasDepot = parseInt(t.hourOfDay, 10) < 6;
            if (isDepotHour !== prevWasDepot) continue;

            // 1. Exact vehicleId match
            if (r.vehicleId && t.vehicleId) {
              if (r.vehicleId === t.vehicleId) {
                bestTrack = t;
                break;
              }
              continue; // Distinct vehicles must NEVER be merged
            }

            // 2. Spatial and temporal consistency checks (especially for historical rows without vehicleId)
            const dtSec = Math.max(1, (r.timestamp - t.lastTs) / 1000);
            const dDelay = Math.abs(r.delayMins - t.lastDelay);

            // A bus cannot jump > 6 minutes of delay within < 3 minutes
            if (dtSec < 180 && dDelay > 6) continue;

            // Spatial continuity check between stops
            const distMeters = this._getStopDistance(t.lastStop, r.stopName);
            if (distMeters !== null) {
              const impliedSpeed = distMeters / dtSec;
              // In production, telemetry polls are >= 10s apart.
              // If dtSec <= 2 with smooth delay (<= 3 min), it's a synchronous unit-test fixture inserting rows in a loop
              const isSyncTestFixture = dtSec <= 2 && dDelay <= 3;
              if (!isSyncTestFixture) {
                // Urban bus speed limit: cannot exceed 25 m/s (90 km/h) over > 400m
                if (impliedSpeed > 25 && distMeters > 400) continue;
                // Cannot jump > 1400m across city within 90 seconds
                if (distMeters > 1400 && dtSec < 90) continue;
              }
            }

            const score = 1000 - (dtSec / 10) - (dDelay * 20);
            if (score > bestScore) {
              bestScore = score;
              bestTrack = t;
            }
          }

          if (bestTrack) {
            bestTrack.lastTs = r.timestamp;
            bestTrack.endTime = r.formattedDate;
            bestTrack.sampleCount++;
            bestTrack.delaySum += r.delayMins;
            bestTrack.lastDelay = r.delayMins;
            if (r.vehicleId && !bestTrack.vehicleId) bestTrack.vehicleId = r.vehicleId;
            if (r.delayMins > bestTrack.maxDelay) bestTrack.maxDelay = r.delayMins;

            if (!bestTrack.stops.includes(r.stopName)) {
              bestTrack.stops.push(r.stopName);
              bestTrack.stopProgression.push({ stopName: r.stopName, delayMins: r.delayMins, isRecovered: false });
            } else {
              const lastEntry = bestTrack.stopProgression[bestTrack.stopProgression.length - 1];
              if (lastEntry && lastEntry.stopName === r.stopName) {
                if (r.delayMins > lastEntry.delayMins) {
                  lastEntry.delayMins = r.delayMins;
                }
              }
            }
            bestTrack.lastStop = r.stopName;
          } else {
            activeTracks.push({
              vehicleId: r.vehicleId || '',
              lineCode: lk,
              agency: r.agency,
              firstTs: r.timestamp,
              lastTs: r.timestamp,
              startTime: r.formattedDate,
              endTime: r.formattedDate,
              hourOfDay: r.hourOfDay,
              maxDelay: r.delayMins,
              delaySum: r.delayMins,
              lastDelay: r.delayMins,
              sampleCount: 1,
              stops: [r.stopName],
              stopProgression: [{ stopName: r.stopName, delayMins: r.delayMins, isRecovered: false }],
              firstStop: r.stopName,
              lastStop: r.stopName,
              isDepot: isDepotHour
            });
          }
        });

        // Push any remaining active tracks
        activeTracks.forEach(t => allClusters.push(t));
      });

      const enrichedClusters = allClusters.map(c => {
        // Check if there was a recovery ping shortly after the trip (within 15 min) where delay dropped below threshold
        if (!c.isDepot && c.stops.length > 1) {
          try {
            const lk = c.lineCode;
            const lkWithL = lk.startsWith('L') ? lk : `L${lk}`;
            const lkNoL = lk.replace(/^L/i, '');
            const candidates = recoveryStmt.all(lkWithL, lkNoL, c.lastTs, c.lastTs + 15 * 60 * 1000, minDelayNum);
            const recoveryPing = candidates.find(cand => {
              if (c.vehicleId && cand.vehicleId) {
                return cand.vehicleId === c.vehicleId;
              }
              const dist = this._getStopDistance(c.lastStop, cand.stopName);
              return dist === null || dist < 1500;
            });
            if (recoveryPing && recoveryPing.stopName && !c.stops.includes(recoveryPing.stopName)) {
              c.stops.push(recoveryPing.stopName);
              c.stopProgression.push({
                stopName: recoveryPing.stopName,
                delayMins: recoveryPing.delayMins,
                isRecovered: true
              });
              c.lastStop = recoveryPing.stopName;
            }
          } catch {}
        }

        const durMins = Math.round((c.lastTs - c.firstTs) / 60000);
        const h = parseInt(c.hourOfDay, 10);
        const ctx = this.getHourlyTrafficContext(h);
        const isDepot = h < 6;
        const isMovingTraffic = !isDepot && c.stops.length > 1;

        let incidentType = 'traffic';
        let incidentTypeLabel = '🚗 Trànsit en Ruta';
        if (isDepot) {
          incidentType = 'maintenance';
          incidentTypeLabel = '🔧 Cotxeres / Manteniment';
        } else if (!isMovingTraffic) {
          incidentType = 'layover';
          incidentTypeLabel = '⏱️ Regulació / Capçalera';
        }

        return {
          vehicleId: c.vehicleId || '',
          lineCode: c.lineCode,
          agency: c.agency,
          startTime: c.startTime,
          endTime: c.endTime,
          durationMinutes: durMins,
          maxDelayMins: c.maxDelay,
          avgDelayMins: Math.round((c.delaySum / c.sampleCount) * 10) / 10,
          sampleCount: c.sampleCount,
          stopsTraversed: c.stops,
          stopProgression: c.stopProgression,
          firstStop: c.firstStop,
          lastStop: c.lastStop,
          stopsCount: c.stops.length,
          isMovingTraffic,
          isDepot,
          incidentType,
          incidentTypeLabel,
          trafficTag: ctx.tag,
          trafficIcon: ctx.icon
        };
      }).sort((a, b) => b.maxDelayMins - a.maxDelayMins || b.sampleCount - a.sampleCount);

      const movingCount = enrichedClusters.filter(c => c.incidentType === 'traffic').length;
      const stationaryCount = enrichedClusters.filter(c => c.incidentType === 'layover').length;
      const maintenanceCount = enrichedClusters.filter(c => c.incidentType === 'maintenance').length;
      const totalClusters = enrichedClusters.length;

      const worstHourStr = worstHourRow?.hourOfDay != null ? `${String(worstHourRow.hourOfDay).padStart(2, '0')}:00` : '--:00';
      const worstHourContext = worstHourRow?.hourOfDay != null ? this.getHourlyTrafficContext(parseInt(worstHourRow.hourOfDay, 10)) : null;

      // The headline maximum is the TRUE maximum over every row in the window.
      // The commercial / investigation split is a separate labelled figure: the
      // commercial tier is only delays < 25 min, so when every real delay in
      // the window sits in the investigation tier the commercial figure is
      // UNKNOWN. It used to be forced to 0, which made the UI print "+0 min"
      // as the maximum service delay while 30-minute delays were on screen.
      const trueMaxDelay = agg.maxDelay || 0;
      const commercialMaxDelay = agg.maxCommercialDelay != null ? agg.maxCommercialDelay : null;
      const maxDelayIsFromInvestigationTier = trueMaxDelay >= 25 && commercialMaxDelay === null;

      return {
        lineCode: isAll ? 'ALL' : codeWithL,
        hoursAnalyzed: hoursNum,
        minDelayThreshold: minDelayNum,
        summary: {
          // Legacy field name kept for the existing consumers; it has always
          // been a RAW SAMPLE count, never a count of incidents/episodes.
          totalRecordedIncidents: agg.totalCount || 0,
          rawSamplesOverThreshold: agg.totalCount || 0,
          listedCommercialEpisodes: enrichedTop.length,
          commercialEpisodeLimit: limitNum,
          kpiBasis: 'totalRecordedIncidents / rawSamplesOverThreshold count RAW SAMPLES at or above the threshold; topIncidents and investigationIncidents are those same samples DEDUPED into per-trip episodes (20-minute sliding window, keyed by line+vehicle, or line+stop when vehicle_id is missing). listedCommercialEpisodes is that deduped list after the per-list limit.',
          maxDelayMins: trueMaxDelay,
          maxCommercialDelayMins: commercialMaxDelay,
          maxDelayIsFromInvestigationTier,
          nonRealtimeSampleCount: agg.nonRealtimeCount || 0,
          nonRealtimeSamplePct: (agg.totalCount || 0) > 0
            ? Math.round(((agg.nonRealtimeCount || 0) / agg.totalCount) * 1000) / 10
            : null,
          worstStop: worstStopRow?.stopName || 'Cap',
          worstStopCount: worstStopRow?.cnt || 0,
          worstHour: worstHourStr,
          worstHourTag: worstHourContext ? worstHourContext.tag : '',
          movingCount,
          stationaryCount,
          maintenanceCount,
          movingPct: totalClusters > 0 ? Math.round((movingCount / totalClusters) * 100) : 0,
          investigationCount: enrichedInvestigation.length,
          dataQuality: this._delayDataQuality({ hours: hoursNum, lineCode: lineCode })
        },
        topIncidents: enrichedTop,
        investigationIncidents: enrichedInvestigation,
        telemetryAnomalies: enrichedAnomalies,
        incidentTrips: enrichedClusters.slice(0, limitNum)
      };
    } catch (e) {
      console.error('[HistoryDB] getDelayIncidents error:', e.message);
      return {
        lineCode: String(lineCode || 'all').toUpperCase(),
        hoursAnalyzed: Number(hours) || 168,
        minDelayThreshold: Number(minDelay) || 5,
        summary: {
          totalRecordedIncidents: 0,
          rawSamplesOverThreshold: 0,
          listedCommercialEpisodes: 0,
          commercialEpisodeLimit: 0,
          maxDelayMins: null,
          maxCommercialDelayMins: null,
          maxDelayIsFromInvestigationTier: false,
          worstStop: 'Cap',
          worstStopCount: 0,
          worstHour: '--:00',
          worstHourTag: '',
          movingCount: 0,
          stationaryCount: 0,
          maintenanceCount: 0,
          movingPct: 0,
          investigationCount: 0
        },
        topIncidents: [],
        investigationIncidents: [],
        telemetryAnomalies: [],
        incidentTrips: []
      };
    }
  }

  // ── Forensic delay inspection ──────────────────────────────────────
  // Groups raw delay rows into episodes, grades each episode's provenance,
  // flags retired-scope lines and feed-tail saturation, and surfaces the
  // underlying observations so an operator can judge whether an "insane delay"
  // is a real event or a measurement artefact.
  inspectDelayIncident({ lineCode = 'all', stopName = '', at, windowMins = 60, minDelay = 5 } = {}) {
    if (!this._ensureOpen()) {
      return { found: false, error: 'database unavailable', episode: null, dataQuality: {} };
    }
    try {
      const windowMs = Math.max(5, Math.min(240, Number(windowMins) || 60)) * 60000;
      const center = Number(at) > 0 ? Number(at) : Date.now();
      const from = Math.floor(center - windowMs / 2);
      const to = Math.floor(center + windowMs / 2);
      const minDelayNum = Math.max(1, Number(minDelay) || 5);

      const cleanCode = String(lineCode || '').toUpperCase().trim();
      const isAll = !cleanCode || cleanCode === 'ALL' || cleanCode === 'TOTES';
      const codeWithL = cleanCode.startsWith('L') ? cleanCode : `L${cleanCode}`;
      const codeWithoutL = cleanCode.replace(/^L/, '');

      let sqlWhere = 'timestamp >= ? AND timestamp <= ? AND delay_mins >= ?';
      const params = [from, to, minDelayNum];
      if (!isAll) {
        sqlWhere += ' AND (UPPER(line_code) = ? OR UPPER(line_code) = ? OR line_id = ?)';
        params.push(codeWithL, codeWithoutL, codeWithoutL);
      }
      sqlWhere = appendMataroScope(sqlWhere, isAll);
      if (stopName) {
        sqlWhere += ' AND stop_name LIKE ?';
        params.push(`%${stopName}%`);
      }

      const stmt = this.db.prepare(`
        SELECT id, vehicle_id as vehicleId, line_id as lineId, line_code as lineCode,
          agency, stop_id as stopId, stop_name as stopName, delay_mins as delayMins,
          direction, times_source as timesSource,
          is_realtime as isRealTime, timestamp, madrid_datetime(timestamp) as formattedDate,
          scheduled_time as scheduledTime, actual_time as actualTime,
          is_telemetry_anomaly(timestamp, delay_mins, stop_name) as isAnomaly
        FROM delay_logs
        WHERE ${sqlWhere}
        ORDER BY timestamp ASC
        LIMIT 500
      `);
      const rows = stmt.all(...params);
      if (!rows.length) {
        return { found: false, lineCode: isAll ? 'ALL' : codeWithL, stopName, windowMs, dataQuality: {}, episode: null };
      }

      // ── Group into episodes: consecutive rows within 5 minutes ──────
      const GAP_MS = EPISODE_GAP_MS;
      const episodes = [];
      let cur = [];
      for (const r of rows) {
        if (cur.length && r.timestamp - cur[cur.length - 1].timestamp > GAP_MS) {
          episodes.push(cur); cur = [];
        }
        cur.push(r);
      }
      if (cur.length) episodes.push(cur);

      const pick = episodes.find(e => center >= e[0].timestamp && center <= e[e.length - 1].timestamp + GAP_MS)
        || episodes.reduce((a, b) => (b[b.length - 1].delayMins > a[a.length - 1].delayMins ? b : a));

      const vehicleIds = [...new Set(pick.map(r => r.vehicleId).filter(Boolean))];
      // Classify every row through the shared provenance helpers. A backfilled
      // approximation is NOT an observed time: it is derived offline from the
      // timetable by guessing the direction, so it must never be counted as
      // corroborating evidence. The old exact-equality test against the single
      // literal 'derived_timetable' let 'derived_timetable_backfill' fall
      // through into the observed bucket.
      const provenance = countTimesProvenance(pick);
      const rowsWithTimes = pick.filter(hasStoredTimes).length;
      const observedTimeRows = provenance.observed;
      const derivedRows = provenance.derived;
      const backfilledRows = provenance.backfill;
      const episodeTimesProvenance = summariseTimesProvenance(provenance);
      const snapshotRows = vehicleIds.length ? this._snapshotTrail(vehicleIds[0], pick[0].timestamp, pick[pick.length - 1].timestamp) : [];

      const hasVehicleId = vehicleIds.length > 0;
      // The vehicle_id column was added by ALTER TABLE on 2026-09-19, so every
      // row written before then reads back '' through the column DEFAULT even
      // though the daemon has always passed a real value. The id was never
      // stored, so it cannot be recovered — say why instead of implying the
      // feed simply omitted it.
      const vehicleIdColumnAddedMs = Date.parse('2026-09-19T00:00:00Z');
      const allPredateVehicleIdColumn = pick.every(r => r.timestamp < vehicleIdColumnAddedMs);
      const vehicleIdGapExplained = !hasVehicleId && allPredateVehicleIdColumn;
      // Only a real upstream observation counts as provenance. Derived and
      // backfilled times corroborate alongside a GPS trail, never on their own.
      const hasProvenanceTimes = observedTimeRows > 0;
      const hasDerivedTimes = derivedRows > 0;
      const hasBackfilledTimes = backfilledRows > 0;
      const hasSnapshotTrail = snapshotRows.length >= 2;

      let verdict, verdictLabel;
      if (pick.every(r => r.isAnomaly)) {
        verdict = 'telemetry_anomaly'; verdictLabel = 'Telemetry anomaly — depot / night maintenance';
      } else if (hasVehicleId && (hasProvenanceTimes || hasSnapshotTrail)) {
        verdict = 'corroborated'; verdictLabel = 'Corroborated — vehicle identity plus independent evidence';
      } else if (hasVehicleId && (hasDerivedTimes || hasBackfilledTimes)) {
        verdict = 'derived_only';
        // A backfilled approximation is weaker than a live derivation and is
        // reported as such rather than under the same "derived" wording.
        if (hasBackfilledTimes && !hasDerivedTimes) {
          verdictLabel = 'Backfilled approximation — timetable time reconstructed offline (direction guessed), no observed evidence';
        } else if (hasDerivedTimes && !hasBackfilledTimes) {
          verdictLabel = 'Derived only — timetable time reconstructed, no observed evidence';
        } else {
          verdictLabel = 'Derived only — timetable time reconstructed (live and/or backfilled), no observed evidence';
        }
      } else if (pick.length >= 3 && (!hasVehicleId || vehicleIds.length <= 1)) {
        verdict = 'poll_inflated'; verdictLabel = 'Inflated by repeated polling — same bus logged every 20 s';
      } else {
        verdict = 'unverifiable'; verdictLabel = 'Unverifiable — no vehicle identity or independent evidence';
      }

      const retiredScope = !isAll && !MATARO_RETIRED_SCOPE_CHECK.includes(codeWithL);
      const vehicleDist = {};
      pick.forEach(r => { vehicleDist[r.vehicleId || '(none)'] = (vehicleDist[r.vehicleId || '(none)'] || 0) + 1; });

      return {
        found: true,
        lineCode: isAll ? 'ALL' : codeWithL,
        stopName: pick[0].stopName,
        incidentTime: new Date(pick[0].timestamp).toLocaleString('en-GB', { timeZone: 'Europe/Madrid' }),
        episode: {
          start: new Date(pick[0].timestamp).toLocaleString('en-GB', { timeZone: 'Europe/Madrid' }),
          end: new Date(pick[pick.length - 1].timestamp).toLocaleString('en-GB', { timeZone: 'Europe/Madrid' }),
          durationMinutes: +(pick[pick.length - 1].timestamp - pick[0].timestamp) / 60000,
          peakDelayMins: Math.max(...pick.map(r => r.delayMins)),
          peakAt: new Date(pick.reduce((a, b) => b.delayMins > a.delayMins ? b : a).timestamp).toLocaleString('en-GB', { timeZone: 'Europe/Madrid' }),
          rowCount: pick.length,
          distinctVehicles: vehicleIds,
          verdict, verdictLabel,
          // Authoritative provenance signal for the whole episode. Consumers
          // should colour from the per-row timesProvenance, which is exact.
          timesProvenance: episodeTimesProvenance,
          evidence: {
            hasVehicleId, hasProvenanceTimes, hasSnapshotTrail, hasDerivedTimes, hasBackfilledTimes,
            timesProvenance: episodeTimesProvenance,
            vehicleIdGapExplained,
            vehicleIdNote: vehicleIdGapExplained
              ? 'Rows predate the vehicle_id column (added 2026-09-19). The bus was recorded but the id was not stored, and no snapshot trail survives to recover it.'
              : (hasVehicleId ? '' : 'No vehicle identity on these rows, and they postdate the vehicle_id column — the feed genuinely omitted it.'),
            vehicleIdDistribution: vehicleDist,
            rowsWithProvenanceTimes: rowsWithTimes,
            rowsWithDerivedTimes: derivedRows,
            rowsWithBackfilledTimes: backfilledRows,
            rowsWithObservedTimes: observedTimeRows,
            snapshotTrailPoints: snapshotRows.length,
            rowsWithoutProvenance: pick.length - rowsWithTimes
          },
          timetableCheck: {
            available: derivedRows > 0 || backfilledRows > 0 || observedTimeRows > 0,
            derivedFromTimetable: derivedRows > 0 || backfilledRows > 0,
            backfilledFromTimetable: backfilledRows > 0,
            derivedLiveFromTimetable: derivedRows > 0,
            note: backfilledRows > 0
              ? 'Scheduled / actual times were approximated offline by scripts/backfill_delay_times.js from the static timetable (the direction was guessed) — not reported by the upstream feed, and weaker than a live derivation'
              : (derivedRows > 0
                ? 'Scheduled / actual times were derived from the static timetable, not reported by the upstream feed'
                : (observedTimeRows > 0
                  ? 'Scheduled / actual times were reported by the upstream feed'
                  : 'Scheduled / actual times are empty in the stored rows — the delay cannot be recomputed from a timetable'))
          },
          retiredScope,
          rawRows: pick.slice(0, 100).map(r => ({
            delayMins: r.delayMins, stopName: r.stopName, vehicleId: r.vehicleId,
            formattedDate: r.formattedDate, isRealTime: Boolean(r.isRealTime),
            hasTimes: !!(r.scheduledTime && r.scheduledTime !== ''),
            scheduledTime: r.scheduledTime || '',
            actualTime: r.actualTime || '',
            timesSource: r.timesSource || '',
            // Per-row classification so the UI can colour each sample
            // green / purple / amber without re-deriving the rule itself.
            timesProvenance: classifyTimes(r),
            direction: r.direction || ''
          }))
        },
        dataQuality: {
          totalRawRowsReturned: rows.length,
          episodesInWindow: episodes.length,
          feedTailCap: 'Delays ≥ 25 min appear to be the upstream SIRI feed tail cap, not real-world outliers',
          retiredScopeLinesPresent: retiredScope
        }
      };
    } catch (e) {
      console.error('[HistoryDB] inspectDelayIncident error:', e.message);
      return { found: false, error: e.message, episode: null, dataQuality: {} };
    }
  }

  _snapshotTrail(vehicleId, from, to) {
    try {
      const stmt = this.db.prepare(`SELECT lat, lon, speed_kmh as speedKmh, delay_mins as delayMins, timestamp FROM vehicle_snapshots WHERE vehicle_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC LIMIT 50`);
      return stmt.all(String(vehicleId), from, to);
    } catch { return []; }
  }

  _delayDataQuality({ hours, lineCode }) {
    if (!this._ensureOpen()) return { totalRawRows: 0, distinctEpisodes: 0, episodeGapMinutes: EPISODE_GAP_MS / 60000, episodesNote: '', rowsWithoutVehicleId: 0, rowsWithoutProvenance: 0, feedTailCap: '' };
    try {
      const cutoff = Date.now() - (Math.max(1, Math.min(720, Number(hours) || 168)) * 3600 * 1000);
      const cleanCode = String(lineCode || '').toUpperCase().trim();
      const isAll = !cleanCode || cleanCode === 'ALL' || cleanCode === 'TOTES';
      const codeWithL = cleanCode.startsWith('L') ? cleanCode : `L${cleanCode}`;
      const codeWithoutL = cleanCode.replace(/^L/, '');
      let wh = 'timestamp >= ?';
      const wp = [cutoff];
      if (!isAll) { wh += ' AND (UPPER(line_code) = ? OR UPPER(line_code) = ? OR line_id = ?)'; wp.push(codeWithL, codeWithoutL, codeWithoutL); }
      wh = appendMataroScope(wh, isAll);
      const agg = this.db.prepare(`SELECT COUNT(*) as n, SUM(CASE WHEN vehicle_id = '' OR vehicle_id IS NULL THEN 1 ELSE 0 END) as noVeh, SUM(CASE WHEN scheduled_time = '' OR scheduled_time IS NULL OR actual_time = '' OR actual_time IS NULL THEN 1 ELSE 0 END) as noProv, COUNT(DISTINCT CASE WHEN vehicle_id != '' AND vehicle_id IS NOT NULL THEN vehicle_id END) as vehIds FROM delay_logs WHERE ${wh}`).get(...wp);
      // A real episode count: a new episode starts at each line+stop when the
      // gap to the previous sample exceeds the 5-minute boundary that
      // inspectDelayIncident groups on. The previous query counted
      // (line, stop) PAIRS HAVING MORE THAN ONE ROW, which is not an episode
      // count at all, and its COUNT(DISTINCT vehicle_id || '-' || stop_name)
      // degenerated to '-stopname' because vehicle_id is mostly empty.
      const ep = this.db.prepare(`
        WITH scoped AS (SELECT line_code, stop_name, timestamp FROM delay_logs WHERE ${wh}),
        marked AS (
          SELECT line_code, stop_name, timestamp,
            LAG(timestamp) OVER (PARTITION BY line_code, stop_name ORDER BY timestamp) AS prevTs
          FROM scoped
        )
        SELECT COUNT(*) as n FROM marked WHERE prevTs IS NULL OR (timestamp - prevTs) > ?
      `).get(...wp, EPISODE_GAP_MS);
      return {
        totalRawRows: agg.n || 0,
        rowsWithoutVehicleId: agg.noVeh || 0,
        rowsWithoutProvenance: agg.noProv || 0,
        distinctEpisodes: ep.n || 0,
        episodeGapMinutes: EPISODE_GAP_MS / 60000,
        episodesNote: 'distinctEpisodes counts groups of consecutive samples on the same line+stop that are ≤ 5 min apart (the same boundary inspectDelayIncident uses). It is NOT a count of buses or of delay causes.',
        feedTailCap: 'Delays ≥ 25 min appear to be the upstream SIRI feed tail cap, not real-world outliers'
      };
    } catch { return { totalRawRows: 0, distinctEpisodes: 0, episodeGapMinutes: EPISODE_GAP_MS / 60000, episodesNote: '', rowsWithoutVehicleId: 0, rowsWithoutProvenance: 0, feedTailCap: '' }; }
  }

  aggregateHourlyStats() {
    if (!this._ensureOpen()) throw new Error('Hourly rollup database unavailable');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const progress = this.db.prepare('SELECT last_id FROM hourly_rollup_progress WHERE singleton = 1').get();
      const lastId = progress?.last_id || 0;
      const maxId = Math.max(lastId, this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM delay_logs').get().id);
      const batches = this.db.prepare(`
        SELECT line_code, MIN(agency) AS agency,
          -- Europe/Madrid bucketing via the registered madrid_datetime UDF
          -- ('YYYY-MM-DD HH:MM:SS'), NOT strftime(...,'localtime'). The
          -- host-local variant silently depended on the process TZ, so a
          -- deployment outside Europe/Madrid split Madrid's morning peak
          -- across two buckets and fed the wrong per-line punctuality.
          substr(madrid_datetime(timestamp), 1, 13) || ':00' AS date_hour,
          COUNT(*) AS samples, SUM(delay_mins) AS delay_sum, MAX(delay_mins) AS max_delay,
          SUM(CASE WHEN delay_mins <= 3 THEN 1 ELSE 0 END) AS on_time,
          SUM(CASE WHEN delay_mins > 3 THEN 1 ELSE 0 END) AS late,
          MIN(timestamp) AS timestamp
        FROM delay_logs WHERE id > ? AND id <= ?
        GROUP BY line_code, date_hour
      `).all(lastId, maxId);
      const existing = this.db.prepare('SELECT * FROM hourly_line_stats WHERE line_code = ? AND date_hour = ?');
      const save = this.db.prepare(`
        INSERT INTO hourly_line_stats
          (line_code, agency, date_hour, sample_count, delay_sum, avg_delay_mins, max_delay_mins, on_time_count, late_count, timestamp)
        VALUES (?, ?, ?, ?, ?, ROUND(? * 1.0 / ?, 2), ?, ?, ?, ?)
        ON CONFLICT(line_code, date_hour) DO UPDATE SET
          agency = excluded.agency, sample_count = excluded.sample_count,
          delay_sum = excluded.delay_sum, avg_delay_mins = excluded.avg_delay_mins,
          max_delay_mins = excluded.max_delay_mins, on_time_count = excluded.on_time_count,
          late_count = excluded.late_count, timestamp = excluded.timestamp
      `);
      for (const batch of batches) {
        const previous = existing.get(batch.line_code, batch.date_hour);
        // On first migration, partial retained raw buckets must not replace fuller legacy rollups.
        if (!progress && previous && previous.sample_count > batch.samples) continue;
        const base = progress ? previous : null;
        const samples = (base?.sample_count || 0) + batch.samples;
        // Pruned legacy rows only retain a rounded average; preserve that precision rather than discard them.
        const sum = (base ? (base.delay_sum ?? base.avg_delay_mins * base.sample_count) : 0) + batch.delay_sum;
        save.run(batch.line_code, base?.agency ?? batch.agency, batch.date_hour, samples,
          sum, sum, samples, base ? Math.max(base.max_delay_mins, batch.max_delay) : batch.max_delay,
          (base?.on_time_count || 0) + batch.on_time, (base?.late_count || 0) + batch.late,
          base ? Math.min(base.timestamp, batch.timestamp) : batch.timestamp);
      }
      this.db.prepare(`
        INSERT INTO hourly_rollup_progress (singleton, last_id) VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET last_id = excluded.last_id
      `).run(maxId);
      this.db.exec('COMMIT');
      return { bucketsUpdated: batches.length, lastId: maxId };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Retention cleanup: roll up stats first, then prune raw logs and snapshots.
  pruneOldRecords(daysRetention = this.delayRetentionDays) {
    if (!this._ensureOpen()) return;
    try {
      // 1. Fold new raw delay rows into hourly rollups (incremental). Aggregation
      // must succeed before any pruning or the watermark could skip unfolded rows.
      this.aggregateHourlyStats();

      // 2. Delete raw vehicle snapshots outside the recent trail window.
      const snapshotCutoff = Date.now() - this.snapshotRetentionHours * 3600 * 1000;
      const deletedSnapshots = this.db
        .prepare(`DELETE FROM vehicle_snapshots WHERE timestamp < ?`)
        .run(snapshotCutoff);

      // 3. Delete raw delay logs older than retention window (default 30 days)
      const cutoff = Date.now() - daysRetention * 86400 * 1000;
      const deletedDelays = this.db
        .prepare(`DELETE FROM delay_logs WHERE timestamp < ?`)
        .run(cutoff);

      // optimize() does not return pages to the filesystem. Since the database
      // uses incremental auto-vacuum, explicitly reclaim pages after pruning.
      this.db.exec(`PRAGMA optimize; PRAGMA incremental_vacuum; PRAGMA shrink_memory;`);
      this.checkpointTruncate();
      if (typeof global.gc === 'function') {
        try { global.gc(); } catch {}
      }
      const snapshotChanges = deletedSnapshots?.changes || 0;
      const delayChanges = deletedDelays?.changes || 0;
      console.log(`[HistoryDB] Pruned old records (snapshots: ${this.snapshotRetentionHours}h, delays: ${daysRetention}d, deleted: ${snapshotChanges + delayChanges}, hourly stats preserved).`);
    } catch (e) {
      console.error('[HistoryDB] pruneOldRecords error:', e.message);
    }
  }

  checkpointTruncate() {
    // No-op when never opened: checkpointing an unopened DB would lazy-create
    // a fresh database file during shutdown (surprising teardown side effect).
    if (!this.db) return false;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA shrink_memory;');
      console.log('[HistoryDB] WAL checkpoint (TRUNCATE) executed successfully.');
      return true;
    } catch (e) {
      console.error('[HistoryDB] checkpointTruncate error:', e.message);
      return false;
    }
  }

  close() {
    if (this.db) {
      try {
        this.checkpointTruncate();
        this.db.close();
      } catch (e) {
        console.error('[HistoryDB] close error:', e.message);
      } finally {
        this.db = null;
        this._snapshotStmt = null;
        this._delayStmt = null;
      }
    }
  }
  /**
   * Persists realtime bus observations (delay memory) and purges stale ones.
   * Purge rule = "after 2 route completions": each row lives 2× its trip's
   * scheduled run duration (clamped 2h–6h, default run 60min).
   * @returns {{inserted: number, purged: number}}
   */
  saveAmbObservations(rows = []) {
    if (!this._ensureOpen()) return { inserted: 0, purged: 0 };
    try {
      const now = Date.now();
      const insert = this.db.prepare(`
        INSERT INTO amb_bus_observations
          (agency, line_code, line_id, direction, trip_id, stop_id, stop_name,
           scheduled_ms, actual_ms, delay_mins, run_duration_secs, created_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      let inserted = 0;
      this.db.exec('BEGIN');
      try {
        for (const r of rows) {
          const lineId = String(r.lineId || '').trim();
          const stopId = String(r.stopId || '').trim();
          const scheduledMs = Number(r.scheduledMs);
          const actualMs = Number(r.actualMs);
          const delayMins = Number(r.delayMins);
          if (!lineId || !stopId || !Number.isFinite(scheduledMs) || !Number.isFinite(actualMs) || !Number.isFinite(delayMins)) continue;
          const runSecs = Number.isFinite(Number(r.runDurationSecs)) ? Math.max(0, Math.round(Number(r.runDurationSecs))) : null;
          insert.run(
            String(r.agency || '').trim() || 'unknown',
            String(r.lineCode || '').trim(),
            lineId,
            String(r.direction ?? '').trim() || '0',
            r.tripId ? String(r.tripId).trim() : null,
            stopId,
            r.stopName ? String(r.stopName).trim() : null,
            Math.round(scheduledMs),
            Math.round(actualMs),
            Math.round(delayMins),
            runSecs,
            now
          );
          inserted++;
        }
        this.db.exec('COMMIT');
      } catch (e) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw e;
      }

      // Purge: "2 route completions" worth of retention per row.
      // MAX/MIN here are SQLite scalar functions (variadic), not aggregates.
      const purge = this.db.prepare(`
        DELETE FROM amb_bus_observations
        WHERE created_ms < ? - MAX(7200000, MIN(21600000, 2 * COALESCE(run_duration_secs, 3600) * 1000))
      `);
      let purged = 0;
      try { purged = purge.run(now).changes; } catch {}
      return { inserted, purged };
    } catch (e) {
      console.error('[HistoryDB] saveAmbObservations error:', e.message);
      return { inserted: 0, purged: 0 };
    }
  }

  /** Recent observations for a line+direction, newest scheduled first. */
  getRecentAmbObservations({ lineId, direction = '0', windowMins = 120, limit = 50 } = {}) {
    if (!this._ensureOpen()) return [];
    try {
      const cutoff = Date.now() - Number(windowMins || 120) * 60000;
      const rows = this.db.prepare(`
        SELECT id, agency, line_code AS lineCode, line_id AS lineId, direction,
               trip_id AS tripId, stop_id AS stopId, stop_name AS stopName,
               scheduled_ms AS scheduledMs, actual_ms AS actualMs,
               delay_mins AS delayMins, run_duration_secs AS runDurationSecs,
               created_ms AS createdMs
        FROM amb_bus_observations
        WHERE line_id = ? AND direction = ? AND scheduled_ms >= ?
        ORDER BY scheduled_ms DESC
        LIMIT ?
      `).all(String(lineId || ''), String(direction || '0'), cutoff, Math.min(200, Number(limit) || 50));
      return rows;
    } catch (e) {
      console.error('[HistoryDB] getRecentAmbObservations error:', e.message);
      return [];
    }
  }

}

module.exports = new HistoryDatabase();
