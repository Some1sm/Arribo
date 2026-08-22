/**
 * osrmClient.js — Public OSRM demo-server road-route client with disk cache.
 *
 * Purpose: when a transit line has NO GTFS shape at all (and shapes.db has no
 * sibling covering its stops), we still want a road-following polyline instead
 * of straight stop-to-stop chords. The public OSRM demo server
 * (router.project-osrm.org) provides that for free.
 *
 * Design notes:
 *  - Roads do not change, so responses are cached on disk forever
 *    (data/cache/osrm_routes/<sha1(stop signature)>.json) and memoised in a
 *    module-level Map on top of that.
 *  - OSRM expects LON,LAT pairs in its request path; GeoJSON responses are
 *    [lon,lat] too. We accept/emit [lat,lon] (Leaflet order) everywhere else.
 *  - Any failure (network error, timeout, non-Ok code, malformed body) returns
 *    null so the caller can fall back to straight segments. A warn is logged
 *    at most once per process to avoid log spam from repeated polling.
 */
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const OSRM_HOST = 'router.project-osrm.org';
const DEFAULT_TIMEOUT_MS = 10000;

// Disk cache lives under <projectRoot>/data/cache/osrm_routes.
// __dirname = src/core/geo → three levels up is the project root.
const CACHE_DIR = path.join(__dirname, '..', '..', '..', 'data', 'cache', 'osrm_routes');

// In-memory memo: cacheKey -> [[lat,lon]] | null (null = known failure, avoids
// re-hitting the network with a 10s timeout on every request after an outage).
const memo = new Map();
const MEMO_MAX = 500;

// Warn-once flag: log the fallback notice only the first time the service fails.
let _osrmWarned = false;

/**
 * Build the rounded stop signature used for cache keys.
 * @param {Array<{lat:number, lon:number}>} stops
 * @returns {string}
 */
function stopSignature(stops) {
  return stops.map(s => `${Number(s.lat).toFixed(5)},${Number(s.lon).toFixed(5)}`).join(';');
}

/**
 * Read a cached route from disk. Returns [[lat,lon]] or null.
 * @param {string} cacheFile absolute path to cache JSON
 */
function readDiskCache(cacheFile) {
  try {
    if (!fs.existsSync(cacheFile)) return null;
    const raw = fs.readFileSync(cacheFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 1 &&
        parsed.every(p => Array.isArray(p) && p.length === 2 &&
          Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
      return parsed;
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Persist a route to the disk cache. Best-effort — never throws.
 * @param {string} cacheFile absolute path
 * @param {Array<[number,number]>} coords
 */
function writeDiskCache(cacheFile, coords) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(coords), 'utf8');
  } catch (_) {
    // Cache write failure is non-fatal; the in-memory memo still covers us.
  }
}

/**
 * Fetch a road-following route through the ordered stop list from the public
 * OSRM demo server.
 *
 * @param {Array<{lat:number, lon:number}>} stops ordered stops (>= 2 required)
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000] request timeout
 * @returns {Promise<Array<[number,number]>|null>} [[lat,lon], ...] or null on any failure
 */
async function fetchRoadRoute(stops, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  if (!Array.isArray(stops) || stops.length < 2) return null;
  for (const s of stops) {
    if (!s || !Number.isFinite(Number(s.lat)) || !Number.isFinite(Number(s.lon))) return null;
  }

  const sig = stopSignature(stops);

  // 1. In-memory memo (covers both successes and known failures).
  if (memo.has(sig)) return memo.get(sig);

  // 2. Disk cache (roads never change — cache forever).
  const cacheKey = crypto.createHash('sha1').update(sig).digest('hex');
  const cacheFile = path.join(CACHE_DIR, `${cacheKey}.json`);
  const cached = readDiskCache(cacheFile);
  if (cached) {
    memoSet(sig, cached);
    return cached;
  }

  // 3. Network: OSRM wants LON,LAT order in the request path.
  const coordPath = stops.map(s => `${Number(s.lon).toFixed(6)},${Number(s.lat).toFixed(6)}`).join(';');
  const url = `https://${OSRM_HOST}/route/v1/driving/${coordPath}?overview=full&geometries=geojson&continue_straight=default`;

  const coords = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let req;
    try {
      req = https.get(url, {
        timeout: timeoutMs,
        // The OSRM demo server answers 403 to requests without a User-Agent
        // (Node's default is empty) — always identify ourselves.
        headers: { 'User-Agent': 'arribo-transit/1.0 (transit geometry resolver)' }
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume(); // drain socket
          finish(null);
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 20 * 1024 * 1024) { // 20 MB sanity cap
            req.destroy();
            finish(null);
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (body && body.code === 'Ok' && body.routes && body.routes[0] &&
                body.routes[0].geometry && Array.isArray(body.routes[0].geometry.coordinates)) {
              // GeoJSON is [lon,lat] → emit [lat,lon].
              const out = body.routes[0].geometry.coordinates
                .filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
                .map(p => [p[1], p[0]]);
              finish(out.length > 1 ? out : null);
            } else {
              finish(null);
            }
          } catch (_) {
            finish(null);
          }
        });
        res.on('error', () => finish(null));
      });
    } catch (_) {
      finish(null);
      return;
    }

    req.on('timeout', () => {
      req.destroy(); // abort cleanly → triggers 'error' with ECONNRESET-ish
      finish(null);
    });
    req.on('error', () => finish(null));
  });

  if (coords && coords.length > 1) {
    writeDiskCache(cacheFile, coords);
    memoSet(sig, coords);
    return coords;
  }

  if (!_osrmWarned) {
    _osrmWarned = true;
    console.warn('[OSRM] route service unavailable — falling back to straight segments');
  }
  memoSet(sig, null);
  return null;
}

function memoSet(key, value) {
  memo.set(key, value);
  if (memo.size > MEMO_MAX) {
    memo.delete(memo.keys().next().value);
  }
}

module.exports = { fetchRoadRoute, stopSignature };
