const path = require('path');
const fs = require('fs');

let DatabaseSync;
try {
  DatabaseSync = require('node:sqlite').DatabaseSync;
} catch (e) {
  DatabaseSync = null;
}

class HistoryDatabase {
  constructor() {
    this.dbPath = path.join(__dirname, '..', 'data', 'transit_history.db');
    this.db = null;
    this.init();
  }

  init() {
    const dataDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    if (DatabaseSync) {
      try {
        this.db = new DatabaseSync(this.dbPath);
        this.db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA synchronous = NORMAL;

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

  getLineDelayStats(lineCode, hoursBack = 24) {
    if (!this.db) return { totalSamples: 0, avgDelayMins: 0, maxDelayMins: 0, onTimePct: 100, latePct: 0 };
    try {
      const cutoff = Date.now() - hoursBack * 3600 * 1000;
      const codeUpper = String(lineCode).toUpperCase();
      const stmt = this.db.prepare(`
        SELECT 
          COUNT(*) as totalSamples,
          AVG(delay_mins) as avgDelayMins,
          MAX(delay_mins) as maxDelayMins,
          SUM(CASE WHEN delay_mins <= 3 THEN 1 ELSE 0 END) as onTimeCount,
          SUM(CASE WHEN delay_mins > 3 AND delay_mins <= 8 THEN 1 ELSE 0 END) as moderateLateCount,
          SUM(CASE WHEN delay_mins > 8 THEN 1 ELSE 0 END) as severeLateCount
        FROM delay_logs
        WHERE line_code = ? AND timestamp >= ?
      `);
      const row = stmt.get(codeUpper, cutoff);
      if (!row || !row.totalSamples) {
        return { totalSamples: 0, avgDelayMins: 0, maxDelayMins: 0, onTimePct: 100, latePct: 0, moderateLatePct: 0, severeLatePct: 0 };
      }

      const total = row.totalSamples || 1;
      return {
        totalSamples: row.totalSamples,
        avgDelayMins: Math.round((row.avgDelayMins || 0) * 10) / 10,
        maxDelayMins: row.maxDelayMins || 0,
        onTimePct: Math.round((row.onTimeCount / total) * 100),
        moderateLatePct: Math.round((row.moderateLateCount / total) * 100),
        severeLatePct: Math.round((row.severeLateCount / total) * 100),
        latePct: Math.round(((row.moderateLateCount + row.severeLateCount) / total) * 100)
      };
    } catch (e) {
      console.error('[HistoryDB] getLineDelayStats error:', e.message);
      return { totalSamples: 0, avgDelayMins: 0, maxDelayMins: 0, onTimePct: 100, latePct: 0 };
    }
  }

  getJournalismReport(hoursBack = 24) {
    if (!this.db) return { summary: {}, rankingMostDelayed: [], rankingBestPunctuality: [], agencyStats: [] };
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

      // 2. Ranking of Most Delayed Lines
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
        HAVING sampleCount >= 3
        ORDER BY avgDelay DESC
        LIMIT 15
      `);
      const rankingMostDelayed = delayedStmt.all(cutoff).map(r => ({
        ...r,
        avgDelay: Math.round((r.avgDelay || 0) * 10) / 10
      }));

      // 3. Ranking of Most Punctual Lines
      const punctualStmt = this.db.prepare(`
        SELECT 
          line_code as lineCode,
          agency,
          COUNT(*) as sampleCount,
          AVG(delay_mins) as avgDelay,
          ROUND((SUM(CASE WHEN delay_mins <= 3 THEN 1.0 ELSE 0.0 END) / COUNT(*)) * 100, 1) as onTimePercentage
        FROM delay_logs
        WHERE timestamp >= ?
        GROUP BY line_code
        HAVING sampleCount >= 3
        ORDER BY onTimePercentage DESC, avgDelay ASC
        LIMIT 15
      `);
      const rankingBestPunctuality = punctualStmt.all(cutoff).map(r => ({
        ...r,
        avgDelay: Math.round((r.avgDelay || 0) * 10) / 10
      }));

      // 4. Operator / Agency Breakdown
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
        HAVING totalSamples >= 5
        ORDER BY avgDelay DESC
      `);
      const agencyStats = agencyStmt.all(cutoff).map(a => ({
        ...a,
        avgDelay: Math.round((a.avgDelay || 0) * 10) / 10
      }));

      return {
        summary: {
          totalRecordedArrivals: totalArrivals,
          monitoredLinesCount: sum.monitoredLinesCount || 0,
          networkAvgDelay: Math.round((sum.networkAvgDelay || 0) * 10) / 10,
          networkMaxDelay: sum.networkMaxDelay || 0,
          networkPunctualityPct: totalArrivals > 0 ? Math.round((sum.totalOnTime / totalArrivals) * 100) : 100,
          hoursAnalyzed: hoursBack
        },
        rankingMostDelayed,
        rankingBestPunctuality,
        agencyStats
      };
    } catch (e) {
      console.error('[HistoryDB] getJournalismReport error:', e.message);
      return { summary: {}, rankingMostDelayed: [], rankingBestPunctuality: [], agencyStats: [] };
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

  pruneOldRecords(daysRetention = 7) {
    if (!this.db) return;
    try {
      const cutoff = Date.now() - daysRetention * 86400 * 1000;
      this.db.prepare(`DELETE FROM vehicle_snapshots WHERE timestamp < ?`).run(cutoff);
      this.db.prepare(`DELETE FROM delay_logs WHERE timestamp < ?`).run(cutoff);
      console.log(`[HistoryDB] Pruned records older than ${daysRetention} days.`);
    } catch (e) {
      // Ignore
    }
  }
}

module.exports = new HistoryDatabase();
