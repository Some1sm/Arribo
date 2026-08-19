const crypto = require('crypto');

class MouTeClient {
  constructor() {
    this.baseUrl = 'https://mou-te.gencat.cat/MouteAPI/rest/';
    this.cache = new Map(); // key -> { data, timestamp }
    this.cacheTTL = 30 * 1000; // 30 seconds fresh cache
    this.staleTTL = 120 * 1000; // 2 minutes stale fallback
  }

  getAuthHeader() {
    const timestamp = Date.now().toString();
    const substr = timestamp.substring(0, 7);
    return crypto.createHash('md5').update('mouteapi' + substr).digest('hex');
  }

  async fetchWithAuth(endpoint, useCache = true) {
    const cacheKey = endpoint;
    const now = Date.now();

    if (useCache && this.cache.has(cacheKey)) {
      const entry = this.cache.get(cacheKey);
      if (now - entry.timestamp < this.cacheTTL) {
        return entry.data;
      }
    }

    const at = this.getAuthHeader();
    const url = `${this.baseUrl}${endpoint}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2500); // 2.5s fast timeout

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

      const text = await res.text();
      if (!text || text.trim().length === 0) {
        return null;
      }

      const data = JSON.parse(text);
      if (useCache) {
        this.cache.set(cacheKey, { data, timestamp: now });
      }
      return data;
    } catch (err) {
      // Return cached entry if available even if stale
      if (this.cache.has(cacheKey)) {
        return this.cache.get(cacheKey).data;
      }
      return null;
    }
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
