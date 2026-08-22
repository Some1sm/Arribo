const path = require('path');
const fs = require('fs');

let DatabaseSync;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (e) {
  DatabaseSync = null;
  console.error('[HistoryDB] ⚠️ node:sqlite is not available in this Node.js runtime.');
  console.error('[HistoryDB] ⚠️ node:sqlite requires Node.js >= 22.5. Current version:', process.version);
  console.error('[HistoryDB] ⚠️ All delay analytics, trails, and journalism reports will return empty data until upgraded.');
}

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
    this.init();
  }

  init() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (DatabaseSync) {
      try {
        this.db = new DatabaseSync(this.dbPath);
        this.db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA busy_timeout = 5000;
          PRAGMA synchronous = NORMAL;
          PRAGMA cache_size = -2048;
          PRAGMA wal_autocheckpoint = 200;
          PRAGMA temp_store = MEMORY;
          PRAGMA auto_vacuum = INCREMENTAL;

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
            timestamp INTEGER NOT NULL
          );

          CREATE INDEX IF NOT EXISTS idx_delay_line ON delay_logs(line_code, timestamp);
          CREATE INDEX IF NOT EXISTS idx_delay_stop ON delay_logs(stop_id, timestamp);
          CREATE INDEX IF NOT EXISTS idx_delay_timestamp ON delay_logs(timestamp);
          CREATE INDEX IF NOT EXISTS idx_delay_time_line ON delay_logs(timestamp, line_code);
          CREATE INDEX IF NOT EXISTS idx_delay_line_timestamp ON delay_logs(line_code, timestamp);
          CREATE INDEX IF NOT EXISTS idx_delay_stop_timestamp ON delay_logs(stop_id, timestamp);

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

          CREATE INDEX IF NOT EXISTS idx_hourly_stats ON hourly_line_stats(line_code, date_hour);
        `);
        console.log('[HistoryDB] SQLite Database Initialized successfully at', this.dbPath);
      } catch (err) {
        console.error('[HistoryDB] Failed to initialize SQLite:', err.message);
        this.db = null;
      }
    }
  }

  recordVehicleSnapshot(snap) {
    if (!this.db || !snap || !snap.vehicleId) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO vehicle_snapshots 
        (vehicle_id, line_id, line_code, agency, lat, lon, speed_kmh, bearing, delay_mins, is_realtime, status, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
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
    } catch (e) {
      // Ignore transient write errors
    }
  }

  recordDelayLog(entry) {
    if (!this.db || !entry || !entry.lineCode) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO delay_logs
        (line_id, line_code, agency, stop_id, stop_name, delay_mins, scheduled_time, actual_time, is_realtime, is_delayed, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const delay = Number(entry.delayMins || 0);
      stmt.run(
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
        entry.timestamp || Date.now()
      );
    } catch (e) {
      // Ignore transient write errors
    }
  }

  getVehicleTrail(vehicleId, minutesBack = 45) {
    if (!this.db) return [];
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
    if (!this.db) return { totalSamples: 0, avgDelayMins: 0, maxDelayMins: 0, onTimePct: 100, latePct: 0, moderateLatePct: 0, severeLatePct: 0, isBaseline: true };
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
          moderateLatePct: Math.round((row.moderateLateCount / total) * 100),
          severeLatePct: Math.round((row.severeLateCount / total) * 100),
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
          moderateLatePct: Math.round(latePct * 0.7),
          severeLatePct: Math.round(latePct * 0.3),
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
    if (!this.db) return { summary: {}, rankingMostDelayed: [], rankingBestPunctuality: [], rankingWorstStops: [], agencyStats: [] };
    try {
      const cutoff = Date.now() - hoursBack * 3600 * 1000;

      // 1. Overall Summary
      const summaryStmt = this.db.prepare(`
        SELECT 
          COUNT(*) as totalRecordedArrivals,
          COUNT(DISTINCT line_code) as monitoredLinesCount,
          AVG(delay_mins) as networkAvgDelay,
          MAX(delay_mins) as networkMaxDelay,
          SUM(CASE WHEN delay_mins <= 3 THEN 1 ELSE 0 END) as totalOnTime,
          SUM(CASE WHEN delay_mins > 5 THEN 1 ELSE 0 END) as totalSignificantDelay
        FROM delay_logs
        WHERE timestamp >= ?
      `);
      const sum = summaryStmt.get(cutoff) || {};
      const totalArrivals = sum.totalRecordedArrivals || 0;

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
        WHERE timestamp >= ?
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
        WHERE timestamp >= ?
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

      // 5. Ranking of Worst Stops (Bottlenecks)
      const worstStopsStmt = this.db.prepare(`
        SELECT 
          stop_name as stopName,
          line_code as lineCode,
          agency,
          COUNT(*) as arrivalCount,
          AVG(delay_mins) as avgDelay,
          MAX(delay_mins) as maxDelay,
          ROUND((SUM(CASE WHEN delay_mins >= 5 THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as severeLatePct
        FROM delay_logs
        WHERE timestamp >= ?
        GROUP BY stop_name, line_code, agency
        HAVING arrivalCount >= 1
        ORDER BY avgDelay DESC, maxDelay DESC
        LIMIT 500
      `);
      const rankingWorstStops = worstStopsStmt.all(cutoff)
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
          return {
            ...r,
            lineId: catalogLine ? catalogLine.id : r.lineCode,
            lineCode: catalogLine ? catalogLine.code : r.lineCode,
            agency: catalogLine ? (catalogLine.agency || r.agency) : r.agency
          };
        });

      const totalMonitoredCount = allLinesCatalog && allLinesCatalog.length > 0
        ? allLinesCatalog.length
        : Math.max(sum.monitoredLinesCount || 0, rankingMostDelayed.length);

      return {
        summary: {
          totalRecordedArrivals: totalArrivals,
          monitoredLinesCount: totalMonitoredCount,
          networkAvgDelay: Math.round((sum.networkAvgDelay || 0) * 10) / 10,
          networkMaxDelay: sum.networkMaxDelay || 0,
          networkPunctualityPct: totalArrivals > 0 ? Math.round((sum.totalOnTime / totalArrivals) * 100) : 100,
          hoursAnalyzed: hoursBack
        },
        rankingMostDelayed,
        rankingBestPunctuality,
        rankingWorstStops,
        agencyStats
      };
    } catch (e) {
      console.error('[HistoryDB] getJournalismReport error:', e.message);
      return { summary: {}, rankingMostDelayed: [], rankingBestPunctuality: [], rankingWorstStops: [], agencyStats: [] };
    }
  }

  exportDelayLogsCsv(hoursBack = 48) {
    if (!this.db) return 'timestamp,line_code,agency,stop_name,delay_mins,scheduled_time,actual_time\n';
    try {
      const cutoff = Date.now() - hoursBack * 3600 * 1000;
      const stmt = this.db.prepare(`
        SELECT 
          datetime(timestamp / 1000, 'unixepoch', 'localtime') as formatted_date,
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

  // Option B: Aggregate raw delay logs into persistent hourly rollups
  aggregateHourlyStats(hoursBack = 48) {
    if (!this.db) return;
    try {
      const cutoff = Date.now() - hoursBack * 3600 * 1000;
      const stmt = this.db.prepare(`
        INSERT INTO hourly_line_stats (line_code, agency, date_hour, sample_count, avg_delay_mins, max_delay_mins, on_time_count, late_count, timestamp)
        SELECT 
          line_code,
          agency,
          strftime('%Y-%m-%d %H:00', datetime(timestamp / 1000, 'unixepoch', 'localtime')) as date_hour,
          COUNT(*) as sample_count,
          ROUND(AVG(delay_mins), 2) as avg_delay_mins,
          MAX(delay_mins) as max_delay_mins,
          SUM(CASE WHEN delay_mins <= 3 THEN 1 ELSE 0 END) as on_time_count,
          SUM(CASE WHEN delay_mins > 3 THEN 1 ELSE 0 END) as late_count,
          MIN(timestamp) as timestamp
        FROM delay_logs
        WHERE timestamp >= ?
        GROUP BY line_code, agency, date_hour
        ON CONFLICT(line_code, date_hour) DO UPDATE SET
          sample_count = excluded.sample_count,
          avg_delay_mins = excluded.avg_delay_mins,
          max_delay_mins = excluded.max_delay_mins,
          on_time_count = excluded.on_time_count,
          late_count = excluded.late_count,
          timestamp = excluded.timestamp
      `);
      stmt.run(cutoff);
    } catch (e) {
      console.error('[HistoryDB] aggregateHourlyStats error:', e.message);
    }
  }

  // Retention cleanup: roll up stats first, then prune raw logs and snapshots.
  pruneOldRecords(daysRetention = this.delayRetentionDays) {
    if (!this.db) return;
    try {
      // 1. Ensure all historical data is aggregated into hourly rollups first
      this.aggregateHourlyStats(daysRetention * 24);

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
      this.db.exec(`PRAGMA optimize; PRAGMA incremental_vacuum;`);
      const snapshotChanges = deletedSnapshots?.changes || 0;
      const delayChanges = deletedDelays?.changes || 0;
      console.log(`[HistoryDB] Pruned old records (snapshots: ${this.snapshotRetentionHours}h, delays: ${daysRetention}d, deleted: ${snapshotChanges + delayChanges}, hourly stats preserved).`);
    } catch (e) {
      console.error('[HistoryDB] pruneOldRecords error:', e.message);
    }
  }

  checkpointTruncate() {
    if (!this.db) return false;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
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
      }
    }
  }
}

module.exports = new HistoryDatabase();
