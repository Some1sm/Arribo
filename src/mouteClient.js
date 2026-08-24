const crypto = require('crypto');

class MouTeClient {
  constructor() {
    this.baseUrl = 'https://mou-te.gencat.cat/MouteAPI/rest/';
    this.cache = new Map(); // key -> { data, timestamp }
    this._inflight = new Map();  // cacheKey -> gate Promise (single-flight)
    this._releaseMap = new Map(); // cacheKey -> release fn
    this.cacheTTL = 30 * 1000; // 30 seconds fresh cache
    this.staleTTL = 120 * 1000; // 2 minutes stale fallback
    // Pluggable transport: server.js proxies via WorkerBridge in main process.
    this._httpBackend = null;
    // Circuit breaker state (protects upstream from retry storms)
    this._failStreak = 0;
    this._circuitOpenUntil = 0;
    this._breakerThreshold = 3;      // consecutive failures before opening
    this._breakerCooldownMs = 120000; // 2 min full backoff, then half-open
  }

  /**
   * Install alternative transport. fn(req) must resolve to { status, bodyText }.
   */
  setHttpBackend(fn) {
    this._httpBackend = typeof fn === 'function' ? fn : null;
  }

  getAuthHeader() {
    const timestamp = Date.now().toString();
    const substr = timestamp.substring(0, 7);
    return crypto.createHash('md5').update('mouteapi' + substr).digest('hex');
  }

  async fetchWithAuth(endpoint, useCache = true) {
    const cacheKey = endpoint;
    const now = Date.now();

    // Circuit breaker: after repeated upstream failures, fail fast WITHOUT
    // touching the network for BREAKER_COOLDOWN_MS so we never flood the
    // provider while it is unhealthy (e.g. 502 storms).
    if (now < this._circuitOpenUntil) {
      throw new Error(`Mou-te circuit open (cooldown until ${new Date(this._circuitOpenUntil).toISOString()})`);
    }

    if (useCache && this.cache.has(cacheKey)) {
      const entry = this.cache.get(cacheKey);
      if (now - entry.timestamp < this.cacheTTL) {
        return entry.data;
      }
    }

    // Single-flight: N concurrent callers of the same endpoint share ONE
    // upstream request. The LEADER performs the fetch; FOLLOWERS wait for
    // the leader to settle, then serve the freshly-cached result.
    let leaderGate = null;
    let isLeader = false;
    if (useCache) {
      leaderGate = this._inflight.get(cacheKey);
      if (!leaderGate) {
        isLeader = true;
        let releaseFn;
        leaderGate = new Promise((res) => { releaseFn = res; });
        this._inflight.set(cacheKey, leaderGate);
        this._releaseMap.set(cacheKey, releaseFn);
      }
    }

    if (!isLeader && useCache && leaderGate) {
      await leaderGate.catch(() => {});
      const entry = this.cache.get(cacheKey);
      if (entry && Date.now() - entry.timestamp < this.staleTTL) {
        return entry.data;
      }
      throw new Error(`Mou-te request failed (single-flight follower): ${endpoint}`);
    }

    try {
      const result = await this._fetchAndCache(endpoint, cacheKey, now);
      this._failStreak = 0; // upstream healthy again
      return result;
    } catch (err) {
      // Serve cached entry only while it is within the stale window (staleTTL)
      const entry = this.cache.get(cacheKey);
      if (entry && Date.now() - entry.timestamp < this.staleTTL) {
        return entry.data;
      }
      // Trip the breaker after consecutive failures to stop retry storms.
      this._failStreak = (this._failStreak || 0) + 1;
      if (this._failStreak >= this._breakerThreshold) {
        this._circuitOpenUntil = Date.now() + this._breakerCooldownMs;
        console.warn(`[MouTeClient] ⚠️ ${this._failStreak}x consecutive failures — circuit OPEN for ${this._breakerCooldownMs / 1000}s`);
      }
      throw err;
    } finally {
      if (useCache && isLeader) {
        const releaseFn = this._releaseMap?.get(cacheKey);
        this._inflight.delete(cacheKey);
        this._releaseMap?.delete(cacheKey);
        releaseFn?.();
      }
    }
  }

  async _fetchAndCache(endpoint, cacheKey, startedAt) {
    const at = this.getAuthHeader();
    const url = `${this.baseUrl}${endpoint}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout

    let text;
    let statusText = 'OK';
    if (typeof this._httpBackend === 'function') {
      // Pluggable transport: server.js proxies upstream via WorkerBridge IPC.
      // Auth + UA headers MUST be forwarded (worker has no client state).
      const r = await this._httpBackend({
        kind: 'moute',
        url,
        options: {
          headers: {
            'AT': at,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*'
          }
        },
        timeoutMs: 5000
      });
      clearTimeout(timeoutId);
      if (!r || typeof r.status !== 'number' || typeof r.bodyText !== 'string') {
        throw new Error(`Mou-te proxy malformed response for ${endpoint}`);
      }
      if (r.status < 200 || r.status >= 300) {
        throw new Error(`Mou-te API HTTP ${r.status}: ${r.statusText || statusText}`);
      }
      text = r.bodyText;
    } else {
      const res = await fetch(url, {
        headers: {
          'AT': at,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`Mou-te API HTTP ${res.status}: ${res.statusText}`);
      }
      text = await res.text();
    }

    if (!text || text.trim().length === 0) {
      return null;
    }

    const data = JSON.parse(text);
    this.cache.set(cacheKey, { data, timestamp: startedAt });
    // Opportunistic sweep: evict entries past staleTTL once the map grows large
    if (this.cache.size > 2000) {
      const cutoff = Date.now() - this.staleTTL;
      for (const [key, e] of this.cache) {
        if (e.timestamp < cutoff) this.cache.delete(key);
      }
    }
    return data;
  }

  async getNextDepartures(stopId, useRealTime = true, language = 'ca_ES') {
    const endpoint = `infrastructure/nextdeparturesNEW?paradaId=${stopId}&useRealTime=${useRealTime}&language=${language}`;
    const data = await this.fetchWithAuth(endpoint);
    return data;
  }

  async getStopLines(stopId, language = 'ca_ES') {
    const endpoint = `infrastructure/stop/linesNEW?paradaId=${stopId}&language=${language}`;
    const data = await this.fetchWithAuth(endpoint);
    return data;
  }

  async getLineDetails(lineId, useRealTime = true, language = 'ca_ES') {
    const endpoint = `infrastructure/line/detailsNEW?lineId=${lineId}&useRealTime=${useRealTime}&language=${language}`;
    const data = await this.fetchWithAuth(endpoint);
    return data;
  }

  async getLineAlerts(lineId, language = 'ca_ES') {
    const endpoint = `alerts/lineNEW?lineId=${lineId}&language=${language}`;
    const data = await this.fetchWithAuth(endpoint);
    return data;
  }
}

module.exports = new MouTeClient();
