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
  assert.ok(obsCode.includes('stop-heatmap-wrapper'), 'observatori.js must wrap stop-heatmap with stop-heatmap-wrapper');
  assert.ok(obsCode.includes('is-scrolled-vertical'), 'observatori.js must handle vertical scroll state');
  assert.ok(obsCode.includes('initUrlState'), 'observatori.js must have initUrlState');
  assert.ok(obsCode.includes('updateUrl'), 'observatori.js must have updateUrl');
  assert.ok(obsCode.includes('openStopHourlyDrilldown'), 'observatori.js must have openStopHourlyDrilldown');
  assert.ok(obsCode.includes('openHourSummaryDrilldown'), 'observatori.js must have openHourSummaryDrilldown');
  assert.ok(obsCode.includes('closeStopHourlyDrilldown'), 'observatori.js must have closeStopHourlyDrilldown');
  assert.ok(obsCode.includes('observatori-rank-num'), 'observatori.js must display ranking numbers');
  assert.ok(obsCode.includes('observatori-group-by-line'), 'observatori.js must have group-by-line toggle');
  assert.ok(obsCode.includes('observatori-group-header-row'), 'observatori.js must render group header rows');
  assert.ok(obsCode.includes('overallRank'), 'observatori.js must track overallRank');
  assert.ok(!obsCode.includes('Agrupat per línia'), 'observatori.js must NOT append dynamic group suffix to subtitle (prevents layout shift)');

  const appPath = path.join(__dirname, '..', 'public', 'js', 'app.js');
  const appCode = fs.readFileSync(appPath, 'utf8');
  assert.ok(!appCode.includes('Agrupat per línia'), 'app.js must NOT append dynamic group suffix to subtitle');
  assert.ok(appCode.includes("target.id === 'observatori-group-by-line'"), 'app.js must handle group-by-line change event');
  console.log('  ✓ 5. public/js/observatori.js & app.js components, stable subtitles & handlers verified.');

  // 6. Verify stop heatmap sticky headers and CSS scroll container
  const cssPath = path.join(__dirname, '..', 'public', 'css', 'style.css');
  assert.ok(fs.existsSync(cssPath), 'style.css must exist');
  const cssCode = fs.readFileSync(cssPath, 'utf8');
  assert.ok(cssCode.includes('.stop-heatmap-wrapper'), 'style.css must define .stop-heatmap-wrapper');
  assert.ok(cssCode.includes('.stop-heatmap thead th'), 'style.css must style .stop-heatmap thead th');
  assert.ok(cssCode.includes('position: sticky'), 'style.css must use sticky positioning');
  assert.ok(cssCode.includes('top: 0'), 'style.css must pin headers at top: 0');
  assert.ok(cssCode.includes('.observatori-rank-num'), 'style.css must style .observatori-rank-num');
  assert.ok(cssCode.includes('.observatori-group-toggle'), 'style.css must style .observatori-group-toggle');
  assert.ok(cssCode.includes('.observatori-group-toggle:has(input[type="checkbox"]:checked)'), 'style.css must style active group toggle pill');
  assert.ok(cssCode.includes('.observatori-group-header-row'), 'style.css must style .observatori-group-header-row');
  assert.ok(cssCode.includes('.incident-view-mode-tabs-container'), 'style.css must define .incident-view-mode-tabs-container');
  assert.ok(cssCode.includes('.incident-view-mode-tab'), 'style.css must define .incident-view-mode-tab');
  assert.ok(cssCode.includes('flex: 1 1 0;'), 'incident-view-mode-tab must use flex: 1 1 0 for equal distribution');
  assert.ok(cssCode.includes('.incident-tab-title'), 'style.css must define .incident-tab-title');
  assert.ok(cssCode.includes('.incident-tab-meta'), 'style.css must define .incident-tab-meta');
  assert.ok(obsCode.includes('incident-tab-title'), 'observatori.js must wrap titles in incident-tab-title');
  assert.ok(obsCode.includes('incident-tab-meta'), 'observatori.js must wrap badges in incident-tab-meta');
  assert.ok(appCode.includes('incident-view-mode-tabs-container'), 'app.js must use incident-view-mode-tabs-container');
  assert.ok(appCode.includes('incident-tab-title'), 'app.js must wrap titles in incident-tab-title');
  assert.ok(appCode.includes("closest('[data-incident-tab]')"), 'app.js must handle data-incident-tab click events');
  console.log('  ✓ 6. public/css/style.css sticky headers, rank badges, incident view mode full-width tabs & group rows verified.');

  // 7. Verify service worker and HTML asset version alignment
  const versionMatch = swCode.match(/const VERSION = '([^']+)';/);
  assert.ok(versionMatch, 'sw.js must define VERSION');
  const currentVersion = versionMatch[1];
  for (const page of ['index.html', 'dades.html', 'plan.html']) {
    const pageHtml = fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8');
    assert.ok(pageHtml.includes(`style.css?v=${currentVersion}`), `${page} must include style.css?v=${currentVersion}`);
  }
  console.log(`  ✓ 7. Service worker and HTML asset versions aligned at v${currentVersion}.`);

  console.log('\n🎉 ALL DADES / OBSERVATORI STANDALONE TESTS PASSED!\n');
})().catch(err => {
  console.error('❌ Dades test failed:', err);
  process.exitCode = 1;
}).finally(async () => {
  if (appServer) {
    await new Promise(resolve => appServer.close(resolve));
  }
});
