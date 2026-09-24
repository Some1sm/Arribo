// Arribo shell versions stay isolated until the user accepts an update.
const CACHE_NAME = 'arribo-mataro-cache-v43';
const DATA_CACHE = `${CACHE_NAME}-data`;
const VERSION = '6.6.6';
const STATIC_SHELL_ASSETS = ['/', '/index.html', '/plan', '/plan.html', '/dades', '/dades.html', '/observatori', '/manifest.webmanifest',
  `/css/style.css?v=${VERSION}`, ...['utils', 'storage', 'requests', 'stopFeatures', 'journeys', 'journeyControls', 'pwa', 'app', 'plan', 'map', 'networkMap', 'observatori'].map(name => `/js/${name}.js?v=${VERSION}`)];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_SHELL_ASSETS)));
});
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('arribo-mataro-cache-') && ![CACHE_NAME, DATA_CACHE].includes(key)).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
const offline = () => new Response('Sense connexió', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  const staticData = url.pathname === '/api/lines' || (url.pathname === '/api/search/stops' && [...url.searchParams.keys()].every(key => key === 'q') && url.searchParams.has('q'));
  if (staticData) {
    event.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      try {
        const response = await fetch(request);
        if (response.ok) {
          const headers = new Headers(response.headers);
          headers.set('X-Arribo-Cached-At', String(Date.now()));
          const copy = new Response(await response.clone().arrayBuffer(), { status: response.status, headers });
          await cache.delete(request);
          await cache.put(request, copy);
          const keys = await cache.keys();
          await Promise.all(keys.slice(0, Math.max(0, keys.length - 32)).map(key => cache.delete(key)));
        }
        return response;
      } catch (_) {
        const cached = await cache.match(request);
        return cached && Date.now() - Number(cached.headers.get('X-Arribo-Cached-At')) < 86400000 ? cached : offline();
      }
    })());
    return;
  }
  if (url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => {
      const planner = ['/plan', '/plan.html', '/com-anar-hi', '/itinerari', '/rutes'].includes(url.pathname);
      const dades = ['/dades', '/dades.html', '/observatori', '/analytics'].includes(url.pathname);
      const cache = await caches.open(CACHE_NAME);
      return await cache.match(planner ? '/plan.html' : (dades ? '/dades.html' : '/index.html')) || offline();
    }));
    return;
  }
  if (STATIC_SHELL_ASSETS.includes(url.pathname + url.search)) {
    event.respondWith(caches.open(CACHE_NAME).then(async cache => await cache.match(request) || fetch(request).catch(offline)));
  }
});
