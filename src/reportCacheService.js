const fs = require('fs');
const path = require('path');
const historyDb = require('./historyDb');

class ReportCacheService {
  constructor() {
    this.reportsDir = path.join(__dirname, '..', 'data', 'reports');
    this.maxRetention = 2; // Keep at most 2 report files on storage
    this.cachedReport = null;
    this.isGenerating = false;
    this.init();
  }

  init() {
    try {
      if (!fs.existsSync(this.reportsDir)) {
        fs.mkdirSync(this.reportsDir, { recursive: true });
        console.log(`[ReportCacheService] Created reports directory: ${this.reportsDir}`);
      }

      // Load newest report from disk if available
      this.loadLatestFromDisk();
      this.pruneOldReports();
    } catch (e) {
      console.error('[ReportCacheService] Init error:', e.message);
    }
  }

  loadLatestFromDisk() {
    try {
      const files = this.getReportFilesList();
      if (files.length > 0) {
        const latestFile = files[0];
        const fullPath = path.join(this.reportsDir, latestFile.filename);
        const data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        if (data && data.summary) {
          this.cachedReport = data;
          console.log(`[ReportCacheService] ⚡ Loaded pre-generated report from disk (${latestFile.filename}, generated at ${data.meta?.generatedAt || 'unknown'})`);
        }
      }
    } catch (e) {
      console.error('[ReportCacheService] Error loading latest report from disk:', e.message);
    }
  }

  getReportFilesList() {
    try {
      if (!fs.existsSync(this.reportsDir)) return [];
      const files = fs.readdirSync(this.reportsDir)
        .filter(f => f.startsWith('journalism_report_') && f.endsWith('.json'))
        .map(f => {
          const fullPath = path.join(this.reportsDir, f);
          const stat = fs.statSync(fullPath);
          return {
            filename: f,
            fullPath,
            mtime: stat.mtimeMs,
            sizeBytes: stat.size
          };
        })
        .sort((a, b) => b.mtime - a.mtime); // Newest first

      return files;
    } catch (e) {
      return [];
    }
  }

  pruneOldReports() {
    try {
      const files = this.getReportFilesList();
      if (files.length > this.maxRetention) {
        const toDelete = files.slice(this.maxRetention);
        toDelete.forEach(f => {
          try {
            fs.unlinkSync(f.fullPath);
            console.log(`[ReportCacheService] 🧹 Pruned old report file: ${f.filename} (keeping max ${this.maxRetention})`);
          } catch (err) {
            console.error(`[ReportCacheService] Error pruning ${f.filename}:`, err.message);
          }
        });
      }
    } catch (e) {
      console.error('[ReportCacheService] Pruning error:', e.message);
    }
  }

  async generateAndSaveReport(hours = 24, allLinesCatalog = []) {
    if (this.isGenerating) {
      // If already generating, return the existing cached report
      return this.cachedReport;
    }
    this.isGenerating = true;
    const startTime = Date.now();

    try {
      // Resolve catalog if a function was passed
      const catalog = typeof allLinesCatalog === 'function' ? allLinesCatalog() : allLinesCatalog;

      console.log(`[ReportCacheService] 📊 Generating fresh 30-min Journalism Report (hours: ${hours}, catalog lines: ${catalog?.length || 0})...`);
      const report = historyDb.getJournalismReport(hours, catalog || []);

      const now = Date.now();
      const meta = {
        generatedAt: new Date(now).toISOString(),
        generatedTimestamp: now,
        expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
        generationDurationMs: Date.now() - startTime,
        updateIntervalMinutes: 30,
        isCached: true
      };

      const fullReport = {
        ...report,
        meta
      };

      // Save to disk
      const targetFilename = `journalism_report_${now}.json`;
      const targetPath = path.join(this.reportsDir, targetFilename);
      fs.writeFileSync(targetPath, JSON.stringify(fullReport, null, 2), 'utf8');
      console.log(`[ReportCacheService] 💾 Saved report to ${targetFilename} (${Math.round(Date.now() - startTime)}ms).`);

      // Update in-memory cache
      this.cachedReport = fullReport;

      // Keep max 2 reports on storage
      this.pruneOldReports();

      return fullReport;
    } catch (e) {
      console.error('[ReportCacheService] Error generating report:', e.message);
      return this.cachedReport || { summary: {}, rankingMostDelayed: [], rankingBestPunctuality: [], rankingWorstStops: [], agencyStats: [] };
    } finally {
      this.isGenerating = false;
    }
  }

  async getLatestReport(hours = 24, allLinesCatalogSupplier = null, forceRefresh = false) {
    // If we have a cached report and don't require force refresh, return immediately (< 1ms)!
    if (!forceRefresh && this.cachedReport) {
      return this.cachedReport;
    }

    // Otherwise generate now
    const catalog = typeof allLinesCatalogSupplier === 'function' ? allLinesCatalogSupplier() : allLinesCatalogSupplier;
    return await this.generateAndSaveReport(hours, catalog);
  }
}

module.exports = new ReportCacheService();
