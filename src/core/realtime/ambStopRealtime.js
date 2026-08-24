/**
 * ambStopRealtime — Shared bridge to the AMB Mobilitat v2 stop realtime API.
 *
 * The AMB app tracks buses of ANY operator inside the 36 metropolitan
 * municipalities — including interurban lines that merely pass through
 * (C-10, e11.1, e11.2, N80...). This service lets any tracker:
 *
 *   1. resolve its own stops to nearby AMB stop codes (catalog cached on
 *      disk for 7 days, proximity-matched and memoised);
 *   2. fetch realtime arrivals for an AMB code (30 s cache, fails soft);
 *   3. merge those arrivals into a departures board via greedy nearest-
 *      entry replacement (a delayed realtime bus REPLACES its scheduled
 *      trip instead of duplicating it) with real delay computation.
 *
 * Realtime is strictly filtered by normalized line code, so unrelated
 * lines sharing a physical stop can never leak into a board.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // rebuild weekly
const REALTIME_TTL_MS = 30000;
const RT_TIMEOUT_MS = 5000;
const MAX_PROXIMITY_M = 150;
const MAX_REPLACE_DIFF_MIN = 40; // nearest-entry replacement cap

function normalizeLineCode(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

class AmbStopRealtimeService {
  constructor() {
    this._apiKey = process.env.AMB_API_KEY || '28EbLJtP0A6CtrWeXp6zE1zy3kp4RzmnaA2sy8JM';
    this._catalog = null;
    this._catalogLoadedAt = 0;
    this._catalogPromise = null;
    this._codeCache = new Map();   // "lat,lon" -> { codAMB, dist } | null
    this._rtCache = new Map();     // codAMB -> { timestamp, times }
    this._fetchBackend = null;     // (ambCode) => Promise<times>; routes upstream calls to the worker
    this._inflight = new Map();    // ambCode -> Promise<times> (single-flight dedupe)
  }

  /**
   * Route ALL upstream realtime fetches through the given executor.
   * The main process installs one that asks the worker over IPC — so the
   * worker is the ONLY caller of the AMB API, and its continuous sweep
   * keeps results warm. Leave unset (worker process / tests) for direct
   * upstream access.
   */
  setFetchBackend(fn) {
    this._fetchBackend = typeof fn === 'function' ? fn : null;
  }

  _catalogPath() {
    const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data');
    return path.join(dataDir, 'cache', 'amb_stops_catalog.json');
  }

  /**
   * Loads the AMB stop catalog from disk (≤7 days old) or downloads it
   * fresh (~5800 stops across ~58 pages). Never throws.
   */
  async getCatalog() {
    if (this._catalog && Date.now() - this._catalogLoadedAt < CATALOG_TTL_MS) return this._catalog;
    try {
      const st = fs.statSync(this._catalogPath());
      if (Date.now() - st.mtimeMs < CATALOG_TTL_MS) {
        const j = JSON.parse(fs.readFileSync(this._catalogPath(), 'utf8'));
        if (Array.isArray(j.stops) && j.stops.length > 0) {
          this._catalog = j.stops;
          this._catalogLoadedAt = Date.now();
          return this._catalog;
        }
      }
    } catch (_) { /* fall through to download */ }

    if (!this._catalogPromise) {
      this._catalogPromise = this._downloadCatalog().catch(() => null).finally(() => { this._catalogPromise = null; });
    }
    const downloaded = await this._catalogPromise;
    if (downloaded && downloaded.length > 0) {
      this._catalog = downloaded;
      this._catalogLoadedAt = Date.now();
      try {
        fs.mkdirSync(path.dirname(this._catalogPath()), { recursive: true });
        fs.writeFileSync(this._catalogPath(), JSON.stringify({ builtAt: new Date().toISOString(), count: downloaded.length, stops: downloaded }));
      } catch (_) { /* cache write is best-effort */ }
      return this._catalog;
    }
    return this._catalog || [];
  }

  async _downloadCatalog() {
    let url = 'https://api.ambmobilitat.cat/v2/bus/stops?pageSize=200';
    const seen = new Map();
    let pages = 0;
    while (url && pages < 60) {
      const raw = await this._httpsGet(url.replace('{&pageSize}', '&pageSize=200'));
      if (!raw) break;
      let j;
      try { j = JSON.parse(raw); } catch (_) { break; }
      for (const s of j._embedded?.stops || []) {
        const d = s.document;
        if (!seen.has(d.codAMB)) seen.set(d.codAMB, d);
      }
      pages++;
      let next = j._links?.next?.href || null;
      if (next && !next.startsWith('http')) next = new URL(next, 'https://api.ambmobilitat.cat').href;
      url = next;
    }
    return [...seen.values()].map(d => ({
      codAMB: String(d.codAMB),
      name: String(d.name || ''),
      lat: Number(d.utmx),
      lon: Number(d.utmy)
    })).filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  }

  _httpsGet(url) {
    return new Promise((resolve) => {
      const req = https.request(url, {
        method: 'GET',
        headers: { 'x-api-key': this._apiKey, 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        timeout: 10000
      }, (res) => {
        if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  /**
   * Nearest AMB catalog stop to (lat, lon), memoised per rounded coordinate.
   * Returns { codAMB, distMeters } or null beyond MAX_PROXIMITY_M.
   */
  async resolveAmbCode(lat, lon, maxDistMeters = MAX_PROXIMITY_M) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (this._codeCache.has(key)) return this._codeCache.get(key);

    let result = null;
    try {
      const catalog = await this.getCatalog();
      const latRad = lat * Math.PI / 180;
      let best = null;
      for (const s of catalog) {
        const dLat = (s.lat - lat) * 111320;
        const dLon = (s.lon - lon) * 111320 * Math.cos(latRad);
        if (Math.abs(dLat) > maxDistMeters || Math.abs(dLon) > maxDistMeters) continue;
        const dist = Math.hypot(dLat, dLon);
        if (dist <= maxDistMeters && (!best || dist < best.dist)) best = { codAMB: s.codAMB, dist };
      }
      result = best;
    } catch (_) { result = null; }
    this._codeCache.set(key, result);
    return result;
  }

  /**
   * Realtime arrivals for an AMB stop code.
   * - 30 s memory cache per code
   * - single-flight: concurrent callers share one in-flight request
   * - with a backend installed (main process), upstream is only ever hit by
   *   the worker — which also sweeps these codes every 2 min, keeping them warm
   */
  fetchRealtime(ambStopCode) {
    const now = Date.now();
    const cached = this._rtCache.get(ambStopCode);
    if (cached && now - cached.timestamp < REALTIME_TTL_MS) return Promise.resolve(cached.times);

    // Single-flight: join an already-running request for this code
    const existing = this._inflight.get(ambStopCode);
    if (existing) return existing;

    const job = new Promise((resolve) => {
      const finish = (times) => {
        this._rtCache.set(ambStopCode, { timestamp: now, times });
        resolve(times);
      };
      if (this._fetchBackend) {
        Promise.resolve(this._fetchBackend(ambStopCode))
          .then((times) => finish(Array.isArray(times) ? times : []))
          .catch(() => finish([]));
        return;
      }
      const req = https.request({
        hostname: 'api.ambmobilitat.cat',
        path: `/v2/bus/stops/${encodeURIComponent(ambStopCode)}/realtimes`,
        method: 'GET',
        headers: {
          'x-api-key': this._apiKey,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json'
        },
        timeout: RT_TIMEOUT_MS
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          let times = [];
          try {
            const j = JSON.parse(data);
            times = (res.statusCode === 200 && Array.isArray(j?.times)) ? j.times : [];
          } catch (_) {}
          finish(times);
        });
      });
      req.on('timeout', () => { req.destroy(); finish([]); });
      req.on('error', () => finish([]));
      req.end();
    }).finally(() => { this._inflight.delete(ambStopCode); });
    this._inflight.set(ambStopCode, job);
    return job;
  }

  /**
   * Generic merge of AMB realtime entries into a departures board.
   *
   * @param {Array} departures       Existing board entries (mutated).
   * @param {Object} opts
   *   stopLat / stopLon          - tracker stop coordinates
   *   wantedLineCodes            - array of acceptable line codes (any casing)
   *   directionMatches(destStr)  - predicate filtering by destination text
   *   badgePrefix                - e.g. '🔴 Temps real (AMB)'
   *   computeDelay(departures[i], arrMs) - optional per-entry delay updater
   * @returns {Array} same board reference
   */
  async mergeLineRealtime(departures, opts = {}) {
    try {
      const { stopLat, stopLon, wantedLineCodes = [], directionMatches, badgePrefix = '🔴 Temps real (AMB)', computeDelay } = opts;
      const wanted = new Set(wantedLineCodes.map(normalizeLineCode).filter(Boolean));
      if (wanted.size === 0) return departures;

      const ambCode = await this.resolveAmbCode(stopLat, stopLon);
      if (!ambCode) return departures;

      const times = await this.fetchRealtime(ambCode.codAMB);
      const matching = times.filter(t => wanted.has(normalizeLineCode(t.lineCode)) &&
        (!directionMatches || directionMatches(String(t.destination || ''))));
      if (matching.length === 0) return departures;

      const now = Date.now();
      // Greedy nearest-entry replacement pool
      const pool = departures.filter(d =>
        d.isToday !== false &&
        Number.isFinite(d.minutesAway) &&
        !/(AMB)/.test(d.delayBadgeText || '') &&
        d.departureTime !== '--:--'
      );
      const matched = new Set();

      matching.sort((a, b) => Number(a.time) - Number(b.time));
      for (const t of matching) {
        const arrMs = Number(t.time) > 1e11 ? Number(t.time) : now + Number(t.arrivalTime || 0) * 1000;
        if (!Number.isFinite(arrMs) || arrMs < now - 5 * 60000) continue;
        const diffMin = Math.max(0, Math.round((arrMs - now) / 60000));

        let clockStr = null;
        try {
          clockStr = new Intl.DateTimeFormat('ca-ES', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: process.env.TZ || 'Europe/Madrid' }).format(new Date(arrMs)).replace(/\u200e/g, '').trim();
        } catch (_) {}
        if (!clockStr || !/^\d{1,2}:\d{2}$/.test(clockStr)) continue;

        // Nearest unmatched candidate within the cap
        let best = null;
        for (const cand of pool) {
          if (matched.has(cand)) continue;
          const d = Math.abs((cand.minutesAway || 0) - diffMin);
          if (d <= MAX_REPLACE_DIFF_MIN && (!best || d < best.d)) best = { cand, d };
        }

        if (best) {
          matched.add(best.cand);
          const existing = best.cand;
          existing.expectedIso = new Date(arrMs).toISOString();
          existing.departureTime = clockStr;
          existing.minutesAway = diffMin;
          existing.isRealTime = true;
          existing.delayBadgeText = badgePrefix;
          if (typeof computeDelay === 'function') computeDelay(existing, arrMs);
          existing.formattedStatus = diffMin === 0 ? 'Imminent' : `${diffMin} min`;
        } else {
          departures.push({
            tripId: t.tripId || null,
            destination: t.destination || '',
            departureTime: clockStr,
            expectedIso: new Date(arrMs).toISOString(),
            aimedIso: new Date(arrMs).toISOString(),
            minutesAway: diffMin,
            isRealTime: true,
            isToday: true,
            delayMinutes: 0,
            delayStatus: 'on_time',
            delayBadgeText: badgePrefix,
            comparisonText: `${badgePrefix} (${clockStr})`,
            formattedStatus: diffMin === 0 ? 'Imminent' : `${diffMin} min`
          });
        }
      }
      departures.sort((a, b) => (a.minutesAway ?? Infinity) - (b.minutesAway ?? Infinity));
    } catch (_) { /* realtime is best-effort */ }
    return departures;
  }
}

module.exports = new AmbStopRealtimeService();
