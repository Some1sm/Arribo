// One-off CDP smoke check for the passenger-reliability upgrades (Chrome DevTools Protocol, no deps).
// Drives the locally running test server: main page boot, planner search, saved journeys, SW registration.
const http = require('node:http');
const APP_URL = 'http://localhost:3000/plan?from=Rodalies&to=Hospital';
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
}
(async () => {
  const target = await new Promise((resolve, reject) => {
    const req = http.request(`http://localhost:9222/json/new?${encodeURIComponent(APP_URL)}`, { method: 'PUT' }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject); req.end();
  });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } });
  const send = (method, params = {}) => new Promise(resolve => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  const consoleErrors = [];
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params.exceptionDetails?.exception?.description || 'exception');
  });
  await new Promise(r => setTimeout(r, 6000));
  const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  const state = await evaluate(`(() => ({
    planner: !!window.planApp,
    store: !!window.TransitStore, journeys: !!window.TransitJourneys, pwa: !!window.TransitPwa,
    library: !!document.getElementById('journey-library'),
    sw: navigator.serviceWorker.controller ? 'controlled' : (navigator.serviceWorker.getRegistration() ? 'registering' : 'none')
  }))()`);
  check('planner app booted', state.planner);
  check('TransitStore loaded', state.store);
  check('TransitJourneys loaded', state.journeys);
  check('TransitPwa loaded', state.pwa);
  check('journey library section rendered', state.library);
  check('service worker registered', state.sw === 'controlled' || state.sw === 'registering', `state=${state.sw}`);
  const search = await evaluate(`(async () => {
    document.getElementById('page-planner-origin').value = 'Hospital de Mataró';
    document.getElementById('page-planner-dest').value = 'Pl. de les Tereses';
    await window.planApp.runSearch();
    const cards = document.querySelectorAll('.planner-itinerary-card');
    return { count: cards.length, first: document.querySelector('.planner-card-header')?.textContent?.slice(0, 80) || '', url: location.search };
  })()`);
  check('planner search renders itineraries', search.count > 0, `count=${search.count}`);
  check('itinerary card has duration header', /min/.test(search.first || ''), (search.first || '').trim());
  const saved = await evaluate(`(async () => {
    document.querySelector('#journey-library [data-save]').click();
    const saved = window.TransitJourneys.listSaved();
    if (!saved.length) return { saved: 0 };
    document.querySelector('#journey-library [data-journey]').click();
    await new Promise(r => setTimeout(r, 1500));
    return { saved: saved.length, label: saved[0].label, repeated: !!window.planApp.lastSearchUrl, originValue: document.getElementById('page-planner-origin').value };
  })()`);
  check('saved journey persists and repeats search', saved.saved === 1 && saved.repeated, `label=${saved.label || 'none'}, origin=${saved.originValue || ''}`);
  check('no page exceptions', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 200));
  const failedCount = results.filter(r => !r.ok).length;
  console.log(`\nRESULT: ${results.length - failedCount} passed, ${failedCount} failed`);
  process.exitCode = failedCount ? 1 : 0;
  ws.close(); process.exit(process.exitCode);
})().catch(err => { console.error(err); process.exit(1); });
