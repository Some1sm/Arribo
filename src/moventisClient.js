const fs = require('fs');
const path = require('path');
const timeUtils = require('./timeUtils');

/**
 * Moventis Official API Client
 * Connects directly to Moventis public endpoints:
 * - Line catalog (/moventis/es/lines)
 * - Trajectories & stops (/api/json/GetTrayectos/{idLinea}/{date})
 * - Complete stop timetables (/api/json/GetParadas/{idLinea}/{idTrayecto}/{date}/0)
 * - Live SAE GPS real-time departures (/api/json/GetTiemposParada/ca/{idParada}/{idLinea}/0)
 */
class MoventisClient {
  constructor() {
    this.baseUrl = 'https://www.moventis.es';
    this.agencyTimezone = 'Europe/Madrid';
    this.cacheDir = path.join(__dirname, '..', 'data', 'cache');
    this.cachePath = path.join(this.cacheDir, 'moventis_lines.json');
    this.linesCache = null;
    this.trayectosCache = new Map();
    this.paradasCache = new Map();
    this.rtCache = new Map();
    // Pluggable transport: server.js proxies via WorkerBridge in main process.
    this._httpBackend = null;

    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Install alternative transport. fn(req) must resolve to { status, bodyText }.
   */
  setHttpBackend(fn) {
    this._httpBackend = typeof fn === 'function' ? fn : null;
  }

  getTodayDateStr() {
    const netNow = timeUtils.getNetworkTime(this.agencyTimezone);
    const y = String(netNow.year);
    const m = String(netNow.month + 1).padStart(2, '0');
    const d = String(netNow.day).padStart(2, '0');
    return `${y}${m}${d}`;
  }

  async fetchWithTimeout(url, timeoutMs = 8000) {
    // Pluggable transport: server.js proxies via WorkerBridge in main process.
    if (typeof this._httpBackend === 'function') {
      const r = await this._httpBackend({ kind: 'moventis', url, options: {}, timeoutMs });
      if (!r || typeof r.status !== 'number' || typeof r.bodyText !== 'string') {
        throw new Error(`Moventis proxy malformed response for ${url}`);
      }
      if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status} for ${url}`);
      return JSON.parse(r.bodyText);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest'
        }
      });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  async getAllLines() {
    if (this.linesCache && this.linesCache.length > 0) {
      return this.linesCache;
    }

    // Try reading disk cache if fresh (<24h)
    if (fs.existsSync(this.cachePath)) {
      try {
        const stats = fs.statSync(this.cachePath);
        if (Date.now() - stats.mtimeMs < 24 * 3600 * 1000) {
          const raw = fs.readFileSync(this.cachePath, 'utf8');
          this.linesCache = JSON.parse(raw);
          return this.linesCache;
        }
      } catch (e) {
        // Continue to network fetch
      }
    }

    try {
      const url = `${this.baseUrl}/moventis/es/lines`;
      const data = await this.fetchWithTimeout(url, 10000);
      if (Array.isArray(data)) {
        const uniqueMap = new Map();
        data.forEach(l => {
          if (l.ID_LINEA && !uniqueMap.has(String(l.ID_LINEA))) {
            uniqueMap.set(String(l.ID_LINEA), {
              id: String(l.ID_LINEA),
              nid: String(l.nid || ''),
              code: String(l.COD_LINEA || '').replace(/^\./, '').trim(),
              name: String(l.DESC_LINEA || '').trim(),
              color: l.COLOR || '#009485',
              textColor: l.TEXT_COLOR || '#FFFFFF',
              zonaId: String(l.ID_ZONA || ''),
              subzonaId: String(l.ID_SUBZONA || ''),
              brandId: String(l.MARCA || ''),
              realTimeEnabled: l.TREAL === 'S',
              agency: 'Moventis'
            });
          }
        });

        this.linesCache = Array.from(uniqueMap.values());
        fs.writeFileSync(this.cachePath, JSON.stringify(this.linesCache, null, 2), 'utf8');
        return this.linesCache;
      }
    } catch (e) {
      if (fs.existsSync(this.cachePath)) {
        try {
          const raw = fs.readFileSync(this.cachePath, 'utf8');
          this.linesCache = JSON.parse(raw);
          return this.linesCache;
        } catch (readErr) {}
      }
    }

    return this.linesCache || [];
  }

  async getLineTrayectos(moventisLineId, dateStr = null) {
    const dStr = dateStr || this.getTodayDateStr();
    const cacheKey = `${moventisLineId}_${dStr}`;
    const cached = this.trayectosCache.get(cacheKey);
    if (cached) {
      return cached.data;
    }

    const diskFile = path.join(this.cacheDir, `moventis_tray_${cacheKey}.json`);
    if (fs.existsSync(diskFile)) {
      try {
        const raw = fs.readFileSync(diskFile, 'utf8');
        const data = JSON.parse(raw);
        this.trayectosCache.set(cacheKey, { ts: Date.now(), data });
        return data;
      } catch (e) {}
    }

    try {
      const url = `${this.baseUrl}/api/json/GetTrayectos/${moventisLineId}/${dStr}`;
      const data = await this.fetchWithTimeout(url, 8000);
      if (Array.isArray(data)) {
        this.trayectosCache.set(cacheKey, { ts: Date.now(), data });
        try { fs.writeFileSync(diskFile, JSON.stringify(data), 'utf8'); } catch (e) {}
        return data;
      }
    } catch (e) {
      // Fallback
    }

    return [];
  }

  async getParadasTimetable(moventisLineId, trayectoId, dateStr = null) {
    const dStr = dateStr || this.getTodayDateStr();
    const cacheKey = `${moventisLineId}_${trayectoId}_${dStr}`;
    const cached = this.paradasCache.get(cacheKey);
    if (cached) {
      return cached.data;
    }

    const diskFile = path.join(this.cacheDir, `moventis_sched_${cacheKey}.json`);
    if (fs.existsSync(diskFile)) {
      try {
        const raw = fs.readFileSync(diskFile, 'utf8');
        const data = JSON.parse(raw);
        this.paradasCache.set(cacheKey, { ts: Date.now(), data });
        return data;
      } catch (e) {}
    }

    try {
      const url = `${this.baseUrl}/api/json/GetParadas/${moventisLineId}/${trayectoId}/${dStr}/0`;
      const data = await this.fetchWithTimeout(url, 8000);
      if (Array.isArray(data)) {
        this.paradasCache.set(cacheKey, { ts: Date.now(), data });
        try { fs.writeFileSync(diskFile, JSON.stringify(data), 'utf8'); } catch (e) {}
        return data;
      }
    } catch (e) {
      // Fallback
    }

    return [];
  }

  async getRealtimeStopETAs(stopId, moventisLineId = '0') {
    const cacheKey = `${stopId}_${moventisLineId}`;
    const cached = this.rtCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 10000) {
      return cached.data;
    }

    // Single-flight: concurrent callers share ONE upstream request
    this._rtInflight = this._rtInflight || new Map();
    const inflight = this._rtInflight.get(cacheKey);
    if (inflight) return inflight;

    const job = (async () => {
      try {
        const url = `${this.baseUrl}/api/json/GetTiemposParada/ca/${stopId}/${moventisLineId}/0`;
        const data = await this.fetchWithTimeout(url, 5000);
        if (Array.isArray(data)) {
          this.rtCache.set(cacheKey, { ts: Date.now(), data });
          return data;
        }
      } catch (e) {
        // Fallback: serve last known data if fresh enough
        const stale = this.rtCache.get(cacheKey);
        if (stale && Date.now() - stale.ts < 60000) return stale.data;
      } finally {
        this._rtInflight.delete(cacheKey);
      }
      return [];
    })();
    this._rtInflight.set(cacheKey, job);
    return job;
  }

  parseRealtimeMinutes(minutosStr) {
    if (!minutosStr || typeof minutosStr !== 'string') return null;
    // Format 1: "11 min 32.3997471 s" or "03 min 42.4777507 s"
    const matchMinSec = minutosStr.match(/(\d+)\s*min\s*([\d.]+)\s*s/i);
    if (matchMinSec) {
      const m = parseInt(matchMinSec[1], 10);
      const s = parseFloat(matchMinSec[2]);
      return m + (s / 60);
    }

    // Format 2: "57' 00''"
    const matchQuote = minutosStr.match(/(\d+)'\s*(\d+)''/);
    if (matchQuote) {
      const m = parseInt(matchQuote[1], 10);
      const s = parseInt(matchQuote[2], 10);
      return m + (s / 60);
    }

    // Format 3: pure number
    const num = parseFloat(minutosStr);
    return isNaN(num) ? null : num;
  }
}

module.exports = new MoventisClient();
