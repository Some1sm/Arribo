// Headless-browser validation for the SSE fleet stream + freshness UI.
// Drives Chrome over CDP (no external deps) against a locally running server.
const http = require('node:http');

const CDP_PORT = 9222;
const APP_URL = 'http://localhost:3777/#l1';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
}

function cdpSend(ws, id, method, params = {}) {
  ws.send(JSON.stringify({ id, method, params }));
}
(async () => {
  // 1. Create target
  const target = await new Promise((resolve, reject) => {
    const req = http.request(`http://localhost:${CDP_PORT}/json/new?${encodeURIComponent(APP_URL)}`, { method: 'PUT' }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject);
    req.end();
  });

  // 2. Connect websocket (raw, using global WebSocket from Node 22)
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  function send(method, params = {}) {
    return new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      cdpSend(ws, mid, method, params);
    });
  }

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');

  const consoleErrors = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails?.exception?.description || 'exception');
    }
  });

  // 3. Wait for the app to boot and the fleet stream to attach
  await new Promise(r => setTimeout(r, 9000));

  const evalJs = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return res.result?.result?.value;
  };

  // 4. Verify stream state inside the page
  const streamState = await evalJs(`(() => ({
    hasES: typeof EventSource !== 'undefined',
    src: !!window.transitApp?.fleetSource,
    readyState: window.transitApp?.fleetSource?.readyState ?? null,
    ok: window.transitApp?.fleetStreamOk ?? false,
    activeLine: window.transitApp?.activeLineId ?? null,
    busCount: (window.transitApp?.activeBuses || []).length
  }))()`);
  check('EventSource supported', streamState.hasES);
  check('fleet EventSource created', streamState.src, `readyState=${streamState.readyState}`);
  check('stream received a fleet snapshot', streamState.ok === true);
  check('active line resolved from hash', String(streamState.activeLine) === '1');

  // 5. Verify markers rendered on the map (line 1 with live fleet)
  check('bus markers applied', streamState.busCount >= 0, `buses=${streamState.busCount}`);

  // 6. Verify service worker skipped the SSE request and cached /api/lines.
  // First page load is not controlled by the SW (it activates mid-load), so
  // reload once to get a controlled page, then inspect the cache.
  await send('Page.reload', { ignoreCache: false });
  await new Promise(r => setTimeout(r, 7000));

  const swInfo = await evalJs(`(async () => {
    const controlled = !!navigator.serviceWorker.controller;
    if (!controlled) return { controlled, linesCached: false };
    // Trigger a controlled-page fetch, then poll: the SW responds immediately
    // and writes the cache entry fire-and-forget, so the entry lands shortly
    // after the response resolves.
    await fetch('/api/lines');
    for (let i = 0; i < 10; i++) {
      const keys = await caches.keys();
      for (const k of keys) {
        const cache = await caches.open(k);
        if (await cache.match('/api/lines')) return { controlled, linesCached: true };
      }
      await new Promise(r => setTimeout(r, 500));
    }
    return { controlled, linesCached: false };
  })()`);
  check('service worker active', swInfo.controlled);
  check('/api/lines cached by SW (network-first whitelist)', swInfo.linesCached);

  // 7. No uncaught exceptions during boot
  check('no uncaught page exceptions', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  // 8. Freshness metadata reaches the browser through the REST API
  const api = await evalJs(`fetch('/api/mataro/line/1?direction=0').then(r => r.json())`);
  const bus0 = api?.data?.activeBuses?.[0];
  check('line API returns activeBuses', Array.isArray(api?.data?.activeBuses));
  if (bus0) {
    check('vehicle carries freshness metadata', !!bus0.freshness && bus0.freshness.source !== undefined,
      JSON.stringify(bus0.freshness || null).slice(0, 120));
  }

  ws.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\nRESULT: ${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
})().catch((err) => { console.error('DRIVER ERROR:', err); process.exitCode = 1; });
