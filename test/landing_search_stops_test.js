const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

console.log('🧪 Testing Landing Main Search Stop Results & Dropdown Integration...');

// 1. Verify index.html contains landing-search-results-dropdown inside landing-hero-search-wrapper
const indexPath = path.join(__dirname, '../public/index.html');
const indexHtml = fs.readFileSync(indexPath, 'utf8');

assert(
  indexHtml.includes('id="landing-hero-search-input"'),
  'index.html must have #landing-hero-search-input'
);
assert(
  indexHtml.includes('id="landing-search-results-dropdown"'),
  'index.html must have #landing-search-results-dropdown'
);
assert(
  indexHtml.includes('class="search-results-dropdown landing-search-results-dropdown"'),
  'landing-search-results-dropdown must use the search-results-dropdown class'
);
console.log('   ✓ index.html structure verified with hero search input and dropdown.');

// 2. Verify style.css rules
const cssPath = path.join(__dirname, '../public/css/style.css');
const cssContent = fs.readFileSync(cssPath, 'utf8');

assert(
  cssContent.includes('.landing-search-results-dropdown'),
  'style.css must have .landing-search-results-dropdown rule'
);
assert(
  /\.landing-hero-card\s*\{[^}]*overflow:\s*visible/m.test(cssContent),
  '.landing-hero-card must have overflow: visible to allow dropdown display'
);
console.log('   ✓ style.css rules verified (.landing-search-results-dropdown and overflow: visible).');

// 3. Verify app.js implementation logic
const appJsPath = path.join(__dirname, '../public/js/app.js');
const appJsContent = fs.readFileSync(appJsPath, 'utf8');

assert(
  appJsContent.includes('landing-search-results-dropdown'),
  'app.js must reference landing-search-results-dropdown'
);
assert(
  appJsContent.includes('/api/search/stops?q='),
  'app.js must query /api/search/stops?q= in landing search'
);
assert(
  appJsContent.includes('landing-stop-card'),
  'app.js must render and delegate clicks on landing-stop-card'
);
assert(
  appJsContent.includes('Parades trobades'),
  'app.js must have a Parades trobades section for matching stops'
);
console.log('   ✓ app.js integration verified: stop queries, dropdown rendering, stop cards and delegation.');

// 4. Verify API response contract for "ample" search
const trackerRegistry = require('../src/core/TrackerRegistry');
const mataroTracker = require('../src/mataroTracker');
trackerRegistry.registerTracker('mataro', mataroTracker);

const results = trackerRegistry.searchStopsAndLines('ample', 10);
assert(Array.isArray(results), 'searchStopsAndLines must return an array');
assert(results.length > 0, 'searchStopsAndLines("ample") must return at least 1 result');
const stopResult = results.find(r => r.type === 'stop' && r.stopName.toLowerCase().includes('ample'));
assert(stopResult, 'searchStopsAndLines("ample") must find stop named Ample');
assert.equal(stopResult.code, '1028');
assert(stopResult.lineCode, 'stop result must include lineCode');
assert(stopResult.lineColor, 'stop result must include lineColor');
console.log(`   ✓ Search API contract verified: found "${stopResult.stopName}" (#${stopResult.code}) on ${stopResult.lineCode}.`);

console.log('\n🎉 ALL LANDING SEARCH STOP RESULTS TESTS PASSED PERFECTLY!\n');
