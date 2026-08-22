const fs = require('fs');
const path = require('path');

class ReportCacheService {
  constructor() {
    this.reportsDir = path.join(__dirname, '..', 'data', 'reports');
    this.maxRetentionPerTimeframe = 2; // Keep at most 2 report files per timeframe (24h, 48h, 7d)
    this.supportedHours = [24, 48, 168];
    this.cachedReports = new Map();
    this.isGenerating = false;
    this.ipcCallback = null;
    // Injectable database handle (set via setDatabase). The main process never
    // sets this, so it never touches SQLite.
    this._db = null;
    this.init();
  }

  setDatabase(db) {
    this._db = db || null;
  }

  setIpcCallback(callback) {
    this.ipcCallback = typeof callback === 'function' ? callback : null;
  }

  emitIpc(type, payload) {
    try {
      if (typeof process.send === 'function') {
        process.send({ type, payload });
      }
    } catch (e) {
      // IPC channel disconnected
    }
    if (this.ipcCallback) {
      try {
        this.ipcCallback(type, payload);
      } catch (e) {
        // Callback error
      }
    }
  }

  updateMemoryCache(timeframeHours, report) {
    if (!report) return;
    const canonicalHours = this.normalizeHours(timeframeHours);
    this.cachedReports.set(String(canonicalHours), report);
    console.log(`[ReportCacheService] ⚡ Memory cache updated via IPC for ${canonicalHours}h report`);
  }

  init() {
    try {
      if (!fs.existsSync(this.reportsDir)) {
        fs.mkdirSync(this.reportsDir, { recursive: true });
        console.log(`[ReportCacheService] Created reports directory: ${this.reportsDir}`);
      }

      // Load newest reports from disk for each timeframe
      this.loadLatestFromDisk();
      this.pruneOldReports();
    } catch (e) {
      console.error('[ReportCacheService] Init error:', e.message);
    }
  }

  normalizeHours(hours) {
    const num = parseInt(hours || '24', 10);
    if (num <= 36) return 24;
    if (num <= 96) return 48;
    return 168;
  }

  loadLatestFromDisk() {
    try {
      this.supportedHours.forEach(h => {
        const files = this.getReportFilesForHours(h);
        if (files.length > 0) {
          const latestFile = files[0];
          try {
            const data = JSON.parse(fs.readFileSync(latestFile.fullPath, 'utf8'));
            if (data && data.summary) {
              this.cachedReports.set(String(h), data);
              console.log(`[ReportCacheService] ⚡ Loaded pre-generated ${h}h report from disk (${latestFile.filename}, generated at ${data.meta?.generatedAt || 'unknown'})`);
            }
          } catch (err) {
            console.error(`[ReportCacheService] Error reading ${latestFile.filename}:`, err.message);
          }
        }
      });
    } catch (e) {
      console.error('[ReportCacheService] Error loading reports from disk:', e.message);
    }
  }

  getReportFilesForHours(hours) {
    try {
      if (!fs.existsSync(this.reportsDir)) return [];
      const prefix = `journalism_report_${hours}h_`;
      const files = fs.readdirSync(this.reportsDir)
        .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
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

  getAllReportFiles() {
    try {
      if (!fs.existsSync(this.reportsDir)) return [];
      return fs.readdirSync(this.reportsDir)
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
        .sort((a, b) => b.mtime - a.mtime);
    } catch (e) {
      return [];
    }
  }

  pruneOldReports() {
    try {
      // 1. Prune per supported timeframe (keep max 2 for 24h, max 2 for 48h, max 2 for 168h)
      this.supportedHours.forEach(h => {
        const files = this.getReportFilesForHours(h);
        if (files.length > this.maxRetentionPerTimeframe) {
          const toDelete = files.slice(this.maxRetentionPerTimeframe);
          toDelete.forEach(f => {
            try {
              fs.unlinkSync(f.fullPath);
              console.log(`[ReportCacheService] 🧹 Pruned old ${h}h report file: ${f.filename} (keeping max ${this.maxRetentionPerTimeframe})`);
            } catch (err) {
              console.error(`[ReportCacheService] Error pruning ${f.filename}:`, err.message);
            }
          });
        }
      });

      // 2. Clean up any un-prefixed legacy report files
      if (fs.existsSync(this.reportsDir)) {
        const allFiles = fs.readdirSync(this.reportsDir);
        allFiles.forEach(f => {
          if (f.startsWith('journalism_report_') && !f.includes('h_') && f.endsWith('.json')) {
            try {
              fs.unlinkSync(path.join(this.reportsDir, f));
            } catch (e) {}
          }
        });
      }
    } catch (e) {
      console.error('[ReportCacheService] Pruning error:', e.message);
    }
  }

  async generateAndSaveReport(hours = 24, allLinesCatalog = []) {
    const canonicalHours = this.normalizeHours(hours);
    const startTime = Date.now();

    // Fail loudly BEFORE the catch-all below: without a DB handle this process
    // must never fall through to serving an empty skeleton report.
    if (!this._db) {
      throw new Error('Report database unavailable in this process');
    }

    try {
      // Resolve catalog if a function was passed
      const catalog = typeof allLinesCatalog === 'function' ? allLinesCatalog() : allLinesCatalog;

      console.log(`[ReportCacheService] 📊 Generating fresh ${canonicalHours}h Journalism Report (catalog lines: ${catalog?.length || 0})...`);
      const report = this._db.getJournalismReport(canonicalHours, catalog || []);

      const now = Date.now();
      const meta = {
        generatedAt: new Date(now).toISOString(),
        generatedTimestamp: now,
        expiresAt: new Date(now + 30 * 60 * 1000).toISOString(),
        generationDurationMs: Date.now() - startTime,
        updateIntervalMinutes: 30,
        timeframeHours: canonicalHours,
        isCached: true
      };

      const fullReport = {
        ...report,
        meta
      };

      // Save to disk with timeframe prefix
      const targetFilename = `journalism_report_${canonicalHours}h_${now}.json`;
      const targetPath = path.join(this.reportsDir, targetFilename);
      fs.writeFileSync(targetPath, JSON.stringify(fullReport, null, 2), 'utf8');
      console.log(`[ReportCacheService] 💾 Saved ${canonicalHours}h report to ${targetFilename} (${Math.round(Date.now() - startTime)}ms).`);

      // Update in-memory cache
      this.cachedReports.set(String(canonicalHours), fullReport);

      // Notify master/bridge via IPC
      this.emitIpc('REPORT_CACHE_UPDATE', {
        timeframeHours: canonicalHours,
        report: fullReport,
        generatedAt: now
      });

      // Keep max 2 reports per timeframe on storage
      this.pruneOldReports();

      return fullReport;
    } catch (e) {
      console.error(`[ReportCacheService] Error generating ${canonicalHours}h report:`, e.message);
      return this.cachedReports.get(String(canonicalHours)) || { summary: {}, rankingMostDelayed: [], rankingBestPunctuality: [], rankingWorstStops: [], agencyStats: [] };
    }
  }

  async generateAllReports(allLinesCatalog = []) {
    if (this.isGenerating) return;
    this.isGenerating = true;
    try {
      console.log('[ReportCacheService] 🔄 Starting batch generation for all timeframes (24h, 48h, 7d/168h)...');
      for (const h of this.supportedHours) {
        await this.generateAndSaveReport(h, allLinesCatalog);
      }
      console.log('[ReportCacheService] ✅ Batch report generation completed for all timeframes.');
    } catch (e) {
      console.error('[ReportCacheService] Batch generation error:', e.message);
    } finally {
      this.isGenerating = false;
    }
  }

  async getLatestReport(hours = 24, allLinesCatalogSupplier = null, options = {}) {
    const canonicalHours = this.normalizeHours(hours);
    const cached = this.cachedReports.get(String(canonicalHours));

    // Strictly serve the pre-generated report from memory cache (instant < 1ms)
    if (cached) {
      return cached;
    }

    // Default: do NOT generate on a miss. This keeps the main process away from
    // SQLite entirely; callers treat null as "ask the worker via RPC". Only an
    // explicit { allowGenerate: true } triggers generation (throws if no db).
    if (options.allowGenerate !== true) {
      return null;
    }

    // Cold boot fallback before the background daemon creates the first report
    const catalog = typeof allLinesCatalogSupplier === 'function' ? allLinesCatalogSupplier() : allLinesCatalogSupplier;
    return await this.generateAndSaveReport(canonicalHours, catalog);
  }
}

module.exports = new ReportCacheService();
