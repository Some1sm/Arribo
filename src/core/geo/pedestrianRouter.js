const geo = require('./geoEngine');

class PedestrianRouter {
  constructor({ url = process.env.ORS_BASE_URL, key = process.env.ORS_API_KEY, timeoutMs = 2500, maxEntries = 256 } = {}) {
    this.url = url;
    this.key = key;
    this.timeoutMs = timeoutMs;
    this.maxEntries = maxEntries;
    this.cache = new Map();
    this.pending = new Map();
    this.active = 0;
  }

  async route(from, to, speed = 80, budget = { remaining: 12 }) {
    const valid = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;
    if (!valid(from) || !valid(to) || !Number.isFinite(speed) || speed <= 0) throw new Error('Invalid walking parameters');
    const distance = geo.calculateDistanceMeters(...from, ...to);
    const fallback = { distanceMeters: Math.round(distance), durationSeconds: Math.ceil(distance / speed * 60), polyline: [from, to], source: 'approximate', approximate: true };
    if (!this.url || distance < 1) return fallback;
    const cacheKey = JSON.stringify(['foot-walking', from, to]);
    const cached = this.cache.get(cacheKey);
    let result;
    if (cached && cached.expires > Date.now()) result = cached.value;
    else if (this.pending.has(cacheKey)) result = await this.pending.get(cacheKey);
    else {
      if (budget.remaining <= 0 || this.active >= 3) return fallback;
      budget.remaining--;
      this.active++;
      const task = this.fetchRoute(from, to).catch(() => null);
      this.pending.set(cacheKey, task);
      try {
        result = await task;
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, { value: result, expires: Date.now() + (result ? 3600000 : 15000) });
        while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
      } finally { this.pending.delete(cacheKey); this.active--; }
    }
    return result ? { ...result, durationSeconds: Math.max(result.durationSeconds, Math.ceil(result.distanceMeters / speed * 60)) } : fallback;
  }

  async fetchRoute(from, to) {
    const base = new URL(this.url);
    if (!['https:', 'http:'].includes(base.protocol)) throw new Error('Invalid ORS URL');
    const response = await fetch(`${base.href.replace(/\/$/, '')}/v2/directions/foot-walking/geojson`, {
      method: 'POST', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'Content-Type': 'application/json', ...(this.key ? { Authorization: this.key } : {}) },
      body: JSON.stringify({ coordinates: [[from[1], from[0]], [to[1], to[0]]] })
    });
    if (!response.ok) throw new Error('Walking provider unavailable');
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 262144) throw new Error('Walking response too large');
      chunks.push(chunk);
    }
    const feature = JSON.parse(Buffer.concat(chunks).toString()).features?.[0];
    const summary = feature?.properties?.summary;
    const coords = feature?.geometry?.coordinates;
    if (feature?.geometry?.type !== 'LineString' || !Array.isArray(coords) || coords.length < 2 ||
        !coords.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90) ||
        !Number.isFinite(summary?.distance) || summary.distance < 0 || !Number.isFinite(summary?.duration) || summary.duration < 0) throw new Error('Invalid walking response');
    return { distanceMeters: Math.ceil(summary.distance), durationSeconds: Math.ceil(summary.duration), polyline: coords.map(p => [p[1], p[0]]), source: 'openrouteservice', approximate: false };
  }
}
module.exports = new PedestrianRouter();
module.exports.PedestrianRouter = PedestrianRouter;
