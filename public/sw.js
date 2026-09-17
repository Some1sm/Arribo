// Service Worker for Arribo! Mataró Bus (PWA & Offline Shell Support)
const CACHE_NAME = 'arribo-mataro-cache-v8';

const STATIC_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/plan',
  '/plan.html',
  '/css/style.css',
  '/js/utils.js',
  '/js/app.js',
  '/js/plan.js',
  '/js/map.js',
  '/manifest.webmanifest'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_SHELL_ASSETS).catch((err) => {
        console.warn('[SW] Pre-cache warning:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Never intercept real-time live telemetry, dynamic vehicle streams or the
  // SSE fleet channel (streams must bypass the SW entirely).
  if (url.pathname.includes('/vehicles') || url.pathname.includes('/target-eta') || url.pathname.includes('/nearby') || url.pathname === '/api/fleet/events') {
    return;
  }

  // Cacheable static datasets: Network-First with Cache Fallback. Must be
  // matched BEFORE the generic API passthrough below.
  if (url.pathname.startsWith('/api/lines') || url.pathname.startsWith('/api/search/stops')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // All other API responses are dynamic and must never be cached as static
  // assets: pass through to the network without opening a cache entry.
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // HTML pages & navigation: Network-first to guarantee latest app shell online, cache fallback offline
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html') || url.pathname === '/plan') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // API Route Caching Strategy: Network-First with Cache Fallback for lines & static datasets
  // (handled above, before the generic API passthrough)

  // Static Assets Strategy: Stale-While-Revalidate with strict query-param version matching
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
