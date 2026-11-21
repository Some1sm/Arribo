const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function loadI18nAndUtils(opts = {}) {
  const listeners = new Map();
  const elements = new Map();
  const staticEls = opts.staticEls || [];

  function makeEl(id) {
    return {
      id,
      hidden: true,
      textContent: '',
      title: '',
      dataset: {},
      classList: {
        _set: new Set(),
        toggle(cls, force) {
          if (force) this._set.add(cls);
          else this._set.delete(cls);
        },
        contains(cls) {
          return this._set.has(cls);
        }
      },
      setAttribute() {},
      removeAttribute() {},
      querySelectorAll() { return []; },
      addEventListener() {}
    };
  }

  const documentObj = {
    readyState: opts.readyState || 'complete',
    documentElement: { lang: 'ca', setAttribute() {} },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl(id));
      return elements.get(id);
    },
    querySelectorAll(sel) {
      if (sel === '[data-i18n]') return staticEls;
      return [];
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(ev) {
      for (const fn of listeners.get(ev.type) || []) fn(ev);
    }
  };

  let fetchCalls = 0;
  const mockSchedule = {
    season: 'summer',
    seasonSource: 'calendar',
    seasonUntil: '2026-09-10'
  };

  const storageMap = new Map();
  if (opts.storedLang) storageMap.set('arribo_lang', opts.storedLang);

  const sandbox = {
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    Object,
    Map,
    Set,
    RegExp,
    Intl,
    URLSearchParams,
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    localStorage: {
      _m: storageMap,
      getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
      setItem(k, v) { this._m.set(k, String(v)); }
    },
    navigator: {
      languages: opts.languages !== undefined ? opts.languages : ['ca-ES'],
      language: opts.language !== undefined ? opts.language : 'ca-ES'
    },
    location: { search: opts.search || '' },
    document: documentObj,
    fetch: async () => {
      fetchCalls++;
      return {
        ok: true,
        json: async () => ({ schedule: mockSchedule })
      };
    }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  if (!opts.i18nOnly) {
    vm.runInContext(read('public/js/utils.js'), sandbox, { filename: 'public/js/utils.js' });
  }
  vm.runInContext(read('public/js/i18n.js'), sandbox, { filename: 'public/js/i18n.js' });

  return {
    sandbox,
    documentObj,
    getFetchCalls: () => fetchCalls,
    setMockSchedule(next) { Object.assign(mockSchedule, next); }
  };
}

function extractStringsTable(i18nSrc) {
  const sandbox = {
    window: {},
    document: {
      readyState: 'complete',
      documentElement: { lang: 'ca' },
      querySelectorAll: () => [],
      addEventListener: () => {},
      dispatchEvent: () => {}
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { languages: ['ca'], language: 'ca' },
    location: { search: '' },
    URLSearchParams,
    CustomEvent: class CustomEvent { constructor(t, i) { this.type = t; this.detail = i?.detail; } }
  };
  sandbox.window = sandbox;
  // Expose STRINGS and AUTO_DETECT for inspection
  const instrumented = i18nSrc.replace(
    'global.ArriboI18n =',
    'global.__STRINGS = STRINGS; global.__AUTO_DETECT = AUTO_DETECT; global.ArriboI18n ='
  );
  vm.createContext(sandbox);
  vm.runInContext(instrumented, sandbox, { filename: 'public/js/i18n.js' });
  return { STRINGS: sandbox.__STRINGS, AUTO_DETECT: sandbox.__AUTO_DETECT };
}

function placeholders(str) {
  return [...String(str).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map(m => m[1]).sort();
}

async function run() {
  const i18nSrc = read('public/js/i18n.js');
  const { STRINGS, AUTO_DETECT } = extractStringsTable(i18nSrc);

  // 1. AUTO_DETECT must now be enabled
  assert.equal(AUTO_DETECT, true, 'AUTO_DETECT must be true');

  // 2. Static keys across index.html, dades.html, and plan.html must exist in es and en
  const htmlFiles = [
    { rel: 'public/index.html', minKeys: 90 },
    { rel: 'public/dades.html', minKeys: 30 },
    { rel: 'public/plan.html', minKeys: 40 }
  ];
  const allStaticKeys = new Set();
  const missingStatic = [];
  for (const { rel, minKeys } of htmlFiles) {
    const html = read(rel);
    const keys = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map(m => m[1]);
    assert.ok(keys.length >= minKeys, `Expected >=${minKeys} static data-i18n keys in ${rel}, found ${keys.length}`);
    for (const key of new Set(keys)) {
      allStaticKeys.add(key);
      if (!(key in STRINGS.es)) missingStatic.push(`${rel}:es:${key}`);
      if (!(key in STRINGS.en)) missingStatic.push(`${rel}:en:${key}`);
    }
  }
  assert.deepEqual(missingStatic, [], `Missing static HTML keys: ${missingStatic.join(', ')}`);

  // 2b. Verify index.html stop modal specifically has static data-i18n keys covered
  const indexHtml = read('public/index.html');
  const stopModalStart = indexHtml.indexOf('id="stop-modal-backdrop"');
  const stopModalEnd = indexHtml.indexOf('id="disruptions-modal-backdrop"', stopModalStart);
  assert.ok(stopModalStart > 0 && stopModalEnd > stopModalStart, 'Stop modal section not found in public/index.html');
  const stopModalHtml = indexHtml.slice(stopModalStart, stopModalEnd);
  const stopModalKeys = [...stopModalHtml.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map(m => m[1]);
  for (const requiredKey of [
    'modal.prevStopTitle',
    'modal.prevStop',
    'modal.nextStopTitle',
    'modal.nextStop',
    'modal.stopBadge',
    'modal.arrivalsHeading',
    'modal.setTarget',
    'modal.setTargetTitle',
    'modal.alarmTitle',
    'modal.alarmOff'
  ]) {
    assert.ok(stopModalKeys.includes(requiredKey), `Stop modal in index.html must include ${requiredKey}`);
    assert.ok(requiredKey in STRINGS.es, `STRINGS.es missing ${requiredKey}`);
    assert.ok(requiredKey in STRINGS.en, `STRINGS.en missing ${requiredKey}`);
  }

  // 3. JS keys across all app/planner/map/shared scripts must exist in ca, es, and en
  const jsFiles = [
    'public/js/app.js',
    'public/js/networkMap.js',
    'public/js/plan.js',
    'public/js/map.js',
    'public/js/utils.js',
    'public/js/journeyControls.js',
    'public/js/stopFeatures.js',
    'public/js/pwa.js',
    'public/js/operators.js'
  ];
  const jsKeyRegex = /\b(?:this\.t|mapT|netT|ArriboI18n\??\.t|t)\(\s*['"]([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)['"]/g;
  const foundJsKeys = new Set();
  for (const rel of jsFiles) {
    const src = read(rel);
    for (const m of src.matchAll(jsKeyRegex)) {
      foundJsKeys.add(m[1]);
    }
  }
  assert.ok(foundJsKeys.size >= 250, `Expected >=250 JS i18n keys across app/planner/shared scripts, found ${foundJsKeys.size}`);
  const missingJs = [];
  for (const key of foundJsKeys) {
    for (const lang of ['ca', 'es', 'en']) {
      if (!(key in STRINGS[lang])) missingJs.push(`${lang}:${key}`);
    }
  }
  assert.deepEqual(missingJs, [], `Missing JS i18n keys: ${missingJs.join(', ')}`);

  // 4. Placeholder parity across all languages for every key in STRINGS
  const allKeys = new Set([...Object.keys(STRINGS.ca), ...Object.keys(STRINGS.es), ...Object.keys(STRINGS.en)]);
  const placeholderMismatches = [];
  for (const key of allKeys) {
    const langsPresent = ['ca', 'es', 'en'].filter(l => key in STRINGS[l]);
    const refLang = langsPresent[0];
    const refPh = placeholders(STRINGS[refLang][key]);
    for (const l of langsPresent.slice(1)) {
      const ph = placeholders(STRINGS[l][key]);
      if (JSON.stringify(ph) !== JSON.stringify(refPh)) {
        placeholderMismatches.push(`${key}: ${refLang}=${JSON.stringify(refPh)} vs ${l}=${JSON.stringify(ph)}`);
      }
    }
  }
  assert.deepEqual(placeholderMismatches, [], `Placeholder mismatches:\n${placeholderMismatches.join('\n')}`);

  // 5. Semantic fidelity checks
  // 5a. Timetable-only keys must NEVER be called "estimated"/"estimat"/"estimado"
  for (const key of [
    'util.fresh.timetable',
    'map.popup.speedTimetable',
    'map.popup.sourceGhost',
    'plan.statusScheduled',
    'plan.theoretical',
    'plan.officialSched',
    'plan.legTimetable',
    'plan.guideSourceOfficial',
    'tier.timetable'
  ]) {
    for (const lang of ['ca', 'es', 'en']) {
      const val = STRINGS[lang][key].toLowerCase();
      assert.ok(
        !/\b(estimat|estimada|estimado|estimated)\b/.test(val),
        `Timetable key ${lang}.${key} must not say estimated: "${STRINGS[lang][key]}"`
      );
    }
  }
  // 5b. Approximate walk keys must explicitly carry an approximate marker in all 3 languages
  const approxPattern = /aprox|approx/i;
  for (const key of [
    'map.itin.walkOriginApprox',
    'map.itin.walkTransferApprox',
    'map.itin.walkDestApprox',
    'map.itin.walkPinMetaApprox',
    'plan.approxWalkPrefix',
    'plan.walkMetaApprox',
    'plan.transferWalkToApprox',
    'plan.guideWalkFirstDetailsApprox',
    'plan.guideTransferDescApprox',
    'plan.guideDestDescApprox'
  ]) {
    for (const lang of ['ca', 'es', 'en']) {
      assert.match(STRINGS[lang][key], approxPattern, `Approximate walk key ${lang}.${key} must stay marked approximate`);
    }
  }

  // 6. Asset version sync: sw.js VERSION equals every ?v= in the three pages
  // (any version; a literal here would fail on every bump).
  const swSrc = read('public/sw.js');
  const swVer = swSrc.match(/const VERSION = '([^']+)';/)?.[1];
  assert.ok(/^\d+\.\d+\.\d+$/.test(swVer || ''), `sw.js VERSION missing or malformed: ${swVer}`);
  for (const htmlFile of ['public/index.html', 'public/dades.html', 'public/plan.html']) {
    const html = read(htmlFile);
    const versions = [...html.matchAll(/\?v=([0-9.]+)/g)].map(m => m[1]);
    assert.ok(versions.length > 0, `No ?v= assets found in ${htmlFile}`);
    for (const v of versions) {
      assert.equal(v, swVer, `${htmlFile} has mismatched ?v=${v} (expected ${swVer})`);
    }
  }

  // 7. AUTO_DETECT language precedence & zero-flash synchronous application
  const detectCases = [
    // Stored visitor choice always wins over browser languages
    { name: 'stored ca beats en-GB', storedLang: 'ca', languages: ['en-GB', 'es-ES'], expected: 'ca' },
    { name: 'stored es beats ca-ES', storedLang: 'es', languages: ['ca-ES', 'en-US'], expected: 'es' },
    { name: 'stored en beats ca-ES', storedLang: 'en', languages: ['ca-ES'], expected: 'en' },
    // Browser languages when no stored choice
    { name: 'ca-ES detects ca', languages: ['ca-ES', 'es-ES'], expected: 'ca' },
    { name: 'es-ES detects es', languages: ['es-ES', 'en-GB'], expected: 'es' },
    { name: 'en-GB detects en', languages: ['en-GB', 'es-ES'], expected: 'en' },
    { name: 'first supported wins (fr -> es -> en)', languages: ['fr-FR', 'es-MX', 'en-US'], expected: 'es' },
    { name: 'first supported wins (de -> en_GB)', languages: ['de-DE', 'en_GB'], expected: 'en' },
    { name: 'unsupported languages fall back to ca', languages: ['fr-FR', 'de-DE', 'ja'], expected: 'ca' },
    { name: 'empty navigator.languages falls back to navigator.language', languages: [], language: 'en-US', expected: 'en' }
  ];
  for (const tc of detectCases) {
    const sampleEl = { dataset: { i18n: 'modal.stopBadge' }, textContent: 'Detalls de parada' };
    const env = loadI18nAndUtils({
      i18nOnly: true,
      readyState: 'loading',
      storedLang: tc.storedLang,
      languages: tc.languages,
      language: tc.language || (tc.languages?.[0] || ''),
      staticEls: [sampleEl]
    });
    assert.equal(env.sandbox.ArriboI18n.lang, tc.expected, `Detection failed for case: ${tc.name}`);
    assert.equal(env.documentObj.documentElement.lang, tc.expected, `<html lang> mismatch for case: ${tc.name}`);
    // Synchronous application before DOMContentLoaded prevents wrong-language flash
    if (tc.expected === 'es') assert.equal(sampleEl.textContent, STRINGS.es['modal.stopBadge']);
    if (tc.expected === 'en') assert.equal(sampleEl.textContent, STRINGS.en['modal.stopBadge']);
    if (tc.expected === 'ca') assert.equal(sampleEl.textContent, 'Detalls de parada');
  }

  // 8. Runtime tests for TransitUtils.freshness() and showSeasonPill() (including seasonSource localization)
  const env = loadI18nAndUtils();
  const { TransitUtils, ArriboI18n } = env.sandbox;

  const expectations = {
    ca: {
      live: 'En directe · fa 12 s',
      position: 'Estimació de posició · fa 15 s',
      timetable: 'Horari programat',
      staleMin: 'Última previsió coneguda · fa 3 min',
      offline: 'Sense connexió · Última previsió coneguda · fa 12 s',
      seasonSummer: 'Estiu',
      seasonWinter: 'Hivern',
      seasonSrcCal: 'calendari',
      seasonSrcNoSummer: "per defecte (cap període d'estiu cobreix avui)",
      seasonSrcNotice: "avís de l'operador (horari especial)",
      seasonSrcWindow: 'calendari de temporada (2026)'
    },
    es: {
      live: 'En directo · hace 12 s',
      position: 'Estimación de posición · hace 15 s',
      timetable: 'Horario programado',
      staleMin: 'Última previsión conocida · hace 3 min',
      offline: 'Sin conexión · Última previsión conocida · hace 12 s',
      seasonSummer: 'Verano',
      seasonWinter: 'Invierno',
      seasonSrcCal: 'calendario',
      seasonSrcNoSummer: 'por defecto (ningún periodo de verano cubre hoy)',
      seasonSrcNotice: 'aviso del operador (horari especial)',
      seasonSrcWindow: 'calendario de temporada (2026)'
    },
    en: {
      live: 'Live · 12 s ago',
      position: 'Estimated position · 15 s ago',
      timetable: 'Scheduled timetable',
      staleMin: 'Last known forecast · 3 min ago',
      offline: 'Offline · Last known forecast · 12 s ago',
      seasonSummer: 'Summer',
      seasonWinter: 'Winter',
      seasonSrcCal: 'calendar',
      seasonSrcNoSummer: 'default (no summer window covers today)',
      seasonSrcNotice: 'operator notice (horari especial)',
      seasonSrcWindow: 'season calendar (2026)'
    }
  };

  // Trigger showSeasonPill once
  await TransitUtils.showSeasonPill('header-season-pill');
  assert.equal(env.getFetchCalls(), 1, 'showSeasonPill should fetch /api/health once');

  const now = 1760000000000;
  for (const lang of ['ca', 'es', 'en']) {
    ArriboI18n.setLang(lang);
    const exp = expectations[lang];

    const fLive = TransitUtils.freshness({ isRealTime: true, freshness: { fetchedAt: now - 12000 } }, now, false);
    assert.equal(fLive.source, 'live');
    assert.equal(fLive.stale, false);
    assert.equal(fLive.label, exp.live);

    const fPos = TransitUtils.freshness({ isEstimated: true, freshness: { fetchedAt: now - 15000 } }, now, false);
    assert.equal(fPos.source, 'position');
    assert.equal(fPos.stale, false);
    assert.equal(fPos.label, exp.position);

    const fSched = TransitUtils.freshness({ isRealTime: false, isEstimated: false }, now, false);
    assert.equal(fSched.source, 'timetable');
    assert.equal(fSched.stale, false);
    assert.equal(fSched.label, exp.timetable);
    assert.ok(!/estimat|estimado|estimated/i.test(fSched.label), `Timetable freshness label in ${lang} must not say estimated`);

    const fStaleMin = TransitUtils.freshness({ isRealTime: true, freshness: { fetchedAt: now - 180000 } }, now, false);
    assert.equal(fStaleMin.stale, true);
    assert.equal(fStaleMin.label, exp.staleMin);

    const fOff = TransitUtils.freshness({ isRealTime: true, freshness: { fetchedAt: now - 12000 } }, now, true);
    assert.equal(fOff.stale, true);
    assert.equal(fOff.label, exp.offline);

    // Season pill redrew automatically on arribo:lang without refetching
    const pill = env.documentObj.getElementById('header-season-pill');
    assert.equal(pill.hidden, false);
    assert.equal(pill.textContent, exp.seasonSummer);
    assert.ok(pill.title.includes(exp.seasonSrcCal), `Season tooltip in ${lang} should localize calendar source: ${pill.title}`);
  }
  assert.equal(env.getFetchCalls(), 1, 'Language switching must NOT refetch /api/health for season pill');

  // Verify default (no summer window covers this date) localization
  env.setMockSchedule({ season: 'winter', seasonSource: 'default (no summer window covers this date)', seasonKnown: true });
  await TransitUtils.showSeasonPill('header-season-pill');
  for (const lang of ['ca', 'es', 'en']) {
    ArriboI18n.setLang(lang);
    const pill = env.documentObj.getElementById('header-season-pill');
    assert.equal(pill.textContent, expectations[lang].seasonWinter);
    assert.ok(
      pill.title.includes(expectations[lang].seasonSrcNoSummer),
      `Season tooltip in ${lang} should localize default-no-summer source, got: ${pill.title}`
    );
  }

  // Verify notice, window, and unknown raw fallback sources
  env.setMockSchedule({ season: 'summer', seasonSource: 'notice (horari especial)', seasonKnown: true });
  await TransitUtils.showSeasonPill('header-season-pill');
  for (const lang of ['ca', 'es', 'en']) {
    ArriboI18n.setLang(lang);
    const pill = env.documentObj.getElementById('header-season-pill');
    assert.ok(pill.title.includes(expectations[lang].seasonSrcNotice), `Notice source in ${lang}: ${pill.title}`);
  }

  env.setMockSchedule({ season: 'summer', seasonSource: 'summer window 2026', seasonKnown: true });
  await TransitUtils.showSeasonPill('header-season-pill');
  for (const lang of ['ca', 'es', 'en']) {
    ArriboI18n.setLang(lang);
    const pill = env.documentObj.getElementById('header-season-pill');
    assert.ok(pill.title.includes(expectations[lang].seasonSrcWindow), `Window source in ${lang}: ${pill.title}`);
  }

  env.setMockSchedule({ season: 'winter', seasonSource: 'custom-unknown-source', seasonKnown: false });
  await TransitUtils.showSeasonPill('header-season-pill');
  for (const lang of ['ca', 'es', 'en']) {
    ArriboI18n.setLang(lang);
    const pill = env.documentObj.getElementById('header-season-pill');
    assert.equal(pill.textContent, `${expectations[lang].seasonWinter}?`);
    assert.ok(pill.title.includes('custom-unknown-source'), `Unknown source must fall back to raw text in ${lang}: ${pill.title}`);
  }

  // 9. Data-quality tier keys and operators.js runtime rules
  for (const key of [
    'tier.measured',
    'tier.predicted',
    'tier.timetable',
    'tier.method.gps',
    'tier.method.operator_delay',
    'tier.method.operator_prediction',
    'tier.noRealtime',
    'tier.groupMeasured',
    'tier.groupPredicted',
    'tier.groupTimetable',
    'tier.predictedNote'
  ]) {
    for (const lang of ['ca', 'es', 'en']) {
      assert.ok(key in STRINGS[lang] && STRINGS[lang][key].length > 0, `Missing ${lang}.${key}`);
    }
  }

  // Verify dades.html carries Mataró Bus measured/gps data-i18n attributes
  const dadesHtml = read('public/dades.html');
  assert.ok(dadesHtml.includes('data-i18n="tier.measured"'), 'dades.html must show Mataró Bus tier.measured badge');
  assert.ok(dadesHtml.includes('data-i18n="tier.method.gps"'), 'dades.html must show Mataró Bus tier.method.gps explanation');

  async function runOperatorsScenario(operatorsPayload) {
    const listeners = new Map();
    const elements = new Map();
    function makeEl(id) {
      return {
        id,
        hidden: true,
        innerHTML: '',
        textContent: '',
        title: '',
        dataset: {},
        classList: {
          _set: new Set(),
          toggle(cls, force) { if (force) this._set.add(cls); else this._set.delete(cls); },
          contains(cls) { return this._set.has(cls); }
        },
        setAttribute() {},
        removeAttribute() {},
        querySelectorAll() { return []; },
        addEventListener() {}
      };
    }
    const documentObj = {
      readyState: 'complete',
      hidden: false,
      title: '',
      body: { dataset: {} },
      documentElement: { lang: 'ca', setAttribute() {} },
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeEl(id));
        return elements.get(id);
      },
      querySelectorAll() { return []; },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(ev) {
        for (const fn of listeners.get(ev.type) || []) fn(ev);
      }
    };
    const sandbox = {
      console, Date, Math, Number, String, Array, Object, Map, Set, RegExp, Intl, URL, URLSearchParams,
      CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
      localStorage: { getItem: () => null, setItem: () => {} },
      navigator: { languages: ['ca-ES'], language: 'ca-ES' },
      location: { search: '', href: 'http://localhost:3000/dades.html' },
      history: { replaceState() {} },
      setInterval: () => 0,
      clearInterval: () => {},
      document: documentObj,
      fetch: async (url) => {
        if (String(url).startsWith('/api/analytics/operators')) {
          return { ok: true, json: async () => ({ operators: operatorsPayload, generatedAt: 1760000000000 }) };
        }
        return { ok: true, json: async () => ({ lines: [], operators: [] }) };
      }
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(read('public/js/utils.js'), sandbox, { filename: 'public/js/utils.js' });
    vm.runInContext(read('public/js/i18n.js'), sandbox, { filename: 'public/js/i18n.js' });
    vm.runInContext(read('public/js/operators.js'), sandbox, { filename: 'public/js/operators.js' });
    await new Promise(r => setImmediate(r));
    return {
      sandbox,
      body: documentObj.getElementById('operators-body'),
      section: documentObj.getElementById('operators-section')
    };
  }

  const baseOp = {
    visits: 42,
    trips: 12,
    onTimeMaxMins: 5,
    onTimePct: 88,
    avgDelay: 2.1,
    maxDelay: 11,
    buckets: { early: 2, onTime: 35, late15: 5, late30: 0, late60: 0, lateOver60: 0 },
    lines: [{ line: 'R1', avgDelay: 2.1, onTimePct: 88, maxDelay: 11, visits: 42 }],
    worstStations: [{ station: 'Mataró', avgDelay: 2.4, visits: 20 }],
    source: 'GTFS-RT',
    feed: { vehiclesNow: 8, fetchAgeSec: 12 }
  };

  // 9a. Missing tier/method works cleanly and renders nothing for tier/method
  {
    const res = await runOperatorsScenario([{ ...baseOp, id: 'renfe_rodalies', name: 'Rodalies de Catalunya' }]);
    assert.equal(res.section.hidden, false);
    assert.ok(!res.body.innerHTML.includes('data-tier='), 'Missing tier must render no tier badge');
    assert.ok(!res.body.innerHTML.includes('data-method='), 'Missing method must render no method line');
    assert.ok(res.body.innerHTML.includes('class="op-kpis"'), 'KPIs must still render when tier/method absent');
  }

  // 9b. Measured operators show localized tier badge + method explanation and redraw on arribo:lang
  const unesc = s => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  {
    const res = await runOperatorsScenario([
      { ...baseOp, id: 'renfe_rodalies', name: 'Rodalies de Catalunya', tier: 'measured', method: 'operator_delay' },
      { ...baseOp, id: 'fgc', name: 'FGC', tier: 'measured', method: 'operator_prediction' }
    ]);
    assert.equal(res.body.classList.contains('op-grid-grouped'), false, 'Same-tier measured ops stay in standard grid');
    for (const lang of ['ca', 'es', 'en']) {
      res.sandbox.ArriboI18n.setLang(lang);
      const html = res.body.innerHTML;
      const text = unesc(html);
      assert.ok(text.includes(STRINGS[lang]['tier.measured']), `Missing measured badge in ${lang}`);
      assert.ok(text.includes(STRINGS[lang]['tier.method.operator_delay']), `Missing operator_delay method in ${lang}`);
      assert.ok(text.includes(STRINGS[lang]['tier.method.operator_prediction']), `Missing operator_prediction method in ${lang}`);
      assert.ok(html.includes('class="op-kpis"'), `Measured ops must show KPIs in ${lang}`);
    }
  }

  // 9c. Timetable-tier operator shows NO punctuality numbers at all (even if payload includes stats)
  {
    const res = await runOperatorsScenario([
      { ...baseOp, id: 'regional_tt', name: 'Regional Bus', tier: 'timetable', source: 'Static GTFS' }
    ]);
    assert.equal(res.section.hidden, false, 'Timetable-only operator must still display section');
    for (const lang of ['ca', 'es', 'en']) {
      res.sandbox.ArriboI18n.setLang(lang);
      const html = res.body.innerHTML;
      assert.ok(html.includes(STRINGS[lang]['tier.timetable']), `Missing timetable badge in ${lang}`);
      assert.ok(html.includes(STRINGS[lang]['tier.noRealtime']), `Missing no-realtime text in ${lang}`);
      assert.ok(!html.includes('class="op-kpis"'), `Timetable tier must NOT render KPIs in ${lang}`);
      assert.ok(!html.includes('class="op-bar"'), `Timetable tier must NOT render bucket bar in ${lang}`);
      assert.ok(!html.includes('class="op-table"'), `Timetable tier must NOT render lines table in ${lang}`);
      assert.ok(!html.includes('class="op-stations"'), `Timetable tier must NOT render worst stations in ${lang}`);
      assert.ok(!html.includes('88%') && !html.includes('88 %'), `Timetable tier must NOT leak onTimePct in ${lang}`);
      assert.ok(!html.includes(STRINGS[lang]['ops.realtimeForecast']), `Timetable tier must NOT show realtimeForecast chip in ${lang}`);
    }
  }

  // 9d. Predicted operator is separated into its own tier group and never mixed with measured ones
  {
    const res = await runOperatorsScenario([
      { ...baseOp, id: 'renfe_rodalies', name: 'Rodalies de Catalunya', tier: 'measured', method: 'operator_delay' },
      { ...baseOp, id: 'pred_rail', name: 'Predicted Rail', tier: 'predicted', method: 'operator_prediction' }
    ]);
    assert.equal(res.body.classList.contains('op-grid-grouped'), true, 'Mixed measured+predicted must enable grouped layout');
    for (const lang of ['ca', 'es', 'en']) {
      res.sandbox.ArriboI18n.setLang(lang);
      const html = res.body.innerHTML;
      const mStart = html.indexOf('data-tier-group="measured"');
      const pStart = html.indexOf('data-tier-group="predicted"');
      assert.ok(mStart >= 0 && pStart > mStart, `Measured and predicted must be in separate tier groups in ${lang}`);
      const measuredBlock = html.slice(mStart, pStart);
      const predictedBlock = html.slice(pStart);
      assert.ok(measuredBlock.includes('Rodalies de Catalunya') && !measuredBlock.includes('Predicted Rail'), 'Measured group must only contain measured ops');
      assert.ok(predictedBlock.includes('Predicted Rail') && !predictedBlock.includes('Rodalies de Catalunya'), 'Predicted group must only contain predicted ops');
      assert.ok(predictedBlock.includes(STRINGS[lang]['tier.predicted']), `Predicted group must show predicted badge in ${lang}`);
      assert.ok(predictedBlock.includes(STRINGS[lang]['tier.predictedNote']), `Predicted group must show separation note in ${lang}`);
    }
  }

  console.log(`i18n_plan_test: OK (${allStaticKeys.size} static keys across 3 HTML files, ${foundJsKeys.size} JS keys, ${allKeys.size} total STRINGS, ${detectCases.length} auto-detect cases, 4 operator tier scenarios checked)`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
