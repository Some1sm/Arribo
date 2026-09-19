const net = require('node:net');

const csp = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline' https://unpkg.com/leaflet@1.9.4/dist/leaflet.css https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://*.basemaps.cartocdn.com https://unpkg.com/leaflet@1.9.4/dist/images/",
  "connect-src 'self'",
  "worker-src 'self'",
  "media-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'"
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', csp);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}

function trustedProxies(value = '') {
  return value.split(',').map(part => part.trim()).filter(Boolean).map(entry => {
    const [address, prefix, extra] = entry.split('/');
    const version = net.isIP(address);
    if (!version || extra !== undefined || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)))) {
      throw new Error('TRUSTED_PROXIES must contain IP addresses or CIDRs');
    }
    return entry;
  });
}

function createApiLimiter({
  now = Date.now,
  windowMs = 60000,
  limit = 120,
  analyticsLimit = Number(process.env.RATE_LIMIT_ANALYTICS_MAX) || (process.env.BENCHMARK_MODE === 'true' ? 120 : 12),
  maxClients = 10000
} = {}) {
  const clients = new Map();
  let lastSweep = 0;
  return (req, res, next) => {
    // Mounted at /api, Express rewires req.path/url to mount-relative paths;
    // prefer the absolute originalUrl so classification works either way.
    const pathname = String(req.originalUrl || req.url || req.path || '').split('?')[0];
    if (!['GET', 'HEAD'].includes(req.method) || /^\/(api\/)?health\/?$/i.test(pathname)) return next();
    const time = now();
    if (time - lastSweep >= windowMs || clients.size >= maxClients) {
      for (const [key, state] of clients) if (state.until <= time) clients.delete(key);
      lastSweep = time;
    }
    let key = req.ip || req.socket.remoteAddress || 'unknown';
    if (key.startsWith('::ffff:') && net.isIP(key.slice(7)) === 4) key = key.slice(7);
    if (net.isIP(key) === 6) key = new URL(`http://[${key}]/`).hostname;
    let state = clients.get(key);
    const reject = until => {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((until - time) / 1000))));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(429).json({ success: false, error: 'Too many requests; retry shortly.' });
    };
    if (!state || state.until <= time) {
      if (!state && clients.size >= maxClients) return reject(time + windowMs);
      state = { until: time + windowMs, total: 0, analytics: 0 };
      clients.set(key, state);
    }
    const analytics = /^\/(api\/)?(analytics|retards)(\/|$)/i.test(pathname);
    if (state.total >= limit || (analytics && state.analytics >= analyticsLimit)) return reject(state.until);
    state.total++;
    if (analytics) state.analytics++;
    next();
  };
}

module.exports = { securityHeaders, createApiLimiter, trustedProxies };
