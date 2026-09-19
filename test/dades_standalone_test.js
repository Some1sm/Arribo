const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bridge = require('../src/core/WorkerBridge');
bridge.start = () => {};

let appServer;

(async () => {
  console.log('🧪 Running Dades / Observatori Standalone Page & Route Tests...');

  // 1. Verify dades.html markup & structure
  const dadesHtmlPath = path.join(__dirname, '..', 'public', 'dades.html');
  assert.ok(fs.existsSync(dadesHtmlPath), 'public/dades.html must exist');
  const dadesHtml = fs.readFileSync(dadesHtmlPath, 'utf8');

  assert.ok(dadesHtml.includes('observatori.js'), 'dades.html must include observatori.js');
  assert.ok(dadesHtml.includes('id="journalism-timeframe-tabs"'), 'dades.html must contain timeframe tabs');
  assert.ok(dadesHtml.includes('id="journalism-content-container"'), 'dades.html must contain content container');
  assert.ok(dadesHtml.includes('id="journalism-termometre-container"'), 'dades.html must contain termometre container');
  assert.ok(dadesHtml.includes('id="journalism-incidents-container"'), 'dades.html must contain incidents container');
  assert.ok(dadesHtml.includes('href="/api/analytics/export/csv"'), 'dades.html must contain CSV export button');
  assert.ok(dadesHtml.includes('id="journalism-search-input"'), 'dades.html must contain search input');
  assert.ok(dadesHtml.includes('href="/"'), 'dades.html must have back link to main page');
  console.log('  ✓ 1. public/dades.html structural markup verified.');

  // 2. Verify index.html navigation and modal removal
  const indexHtmlPath = path.join(__dirname, '..', 'public', 'index.html');
  const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  assert.ok(indexHtml.includes('href="/dades"'), 'index.html must link to /dades');
  assert.ok(!indexHtml.includes('id="journalism-modal-backdrop"'), 'index.html must not contain old modal backdrop');
  console.log('  ✓ 2. public/index.html navigation & modal extraction verified.');

  // 3. Verify Service Worker shell assets
  const swPath = path.join(__dirname, '..', 'public', 'sw.js');
  const swCode = fs.readFileSync(swPath, 'utf8');
  assert.ok(swCode.includes("'/dades'"), 'sw.js must cache /dades');
  assert.ok(swCode.includes("'/observatori'"), 'sw.js must cache /observatori');
  assert.ok(swCode.includes("'/dades.html'"), 'sw.js must cache /dades.html');
  assert.ok(swCode.includes("'observatori'"), 'sw.js must cache observatori');
  console.log('  ✓ 3. public/sw.js static cache assets verified.');

  // 4. Verify HTTP Server Routes and Anti-Cache Headers
  appServer = require('../server').listen(0, '127.0.0.1');
  await new Promise(resolve => appServer.once('listening', resolve));
  const port = appServer.address().port;

  for (const route of ['/dades', '/observatori', '/analytics']) {
    const res = await fetch(`http://127.0.0.1:${port}${route}`);
    assert.equal(res.status, 200, `${route} should return 200 OK`);
    assert.ok(res.headers.get('content-type')?.includes('text/html'), `${route} should return text/html`);
    const cacheControl = res.headers.get('cache-control') || '';
    assert.ok(cacheControl.includes('no-store'), `${route} must specify no-store cache control`);
    const body = await res.text();
    assert.ok(body.includes('journalism-timeframe-tabs'), `${route} body must be dades.html`);
    console.log(`  ✓ 4. GET ${route} -> 200 text/html (Cache-Control: ${cacheControl})`);
  }

  // 5. Verify observatori.js syntax and key functional declarations
  const obsPath = path.join(__dirname, '..', 'public', 'js', 'observatori.js');
  assert.ok(fs.existsSync(obsPath), 'observatori.js must exist');
  const obsCode = fs.readFileSync(obsPath, 'utf8');
  assert.ok(obsCode.includes('class ObservatoriApp'), 'observatori.js must define ObservatoriApp');
  assert.ok(obsCode.includes('renderJournalismReport'), 'observatori.js must have renderJournalismReport');
  assert.ok(obsCode.includes('renderStopHeatmap'), 'observatori.js must have renderStopHeatmap');
  assert.ok(obsCode.includes('renderTermometreScorecard'), 'observatori.js must have renderTermometreScorecard');
  assert.ok(obsCode.includes('renderDelayIncidentsView'), 'observatori.js must have renderDelayIncidentsView');
  assert.ok(obsCode.includes('initObservatoriTableScrolls'), 'observatori.js must have initObservatoriTableScrolls');
  assert.ok(obsCode.includes('initUrlState'), 'observatori.js must have initUrlState');
  assert.ok(obsCode.includes('updateUrl'), 'observatori.js must have updateUrl');
  console.log('  ✓ 5. public/js/observatori.js components & deep-linking handlers verified.');

  console.log('\n🎉 ALL DADES / OBSERVATORI STANDALONE TESTS PASSED!\n');
})().catch(err => {
  console.error('❌ Dades test failed:', err);
  process.exitCode = 1;
}).finally(async () => {
  if (appServer) {
    await new Promise(resolve => appServer.close(resolve));
  }
});
