/**
 * Interface strings: Catalan (default), Spanish, English.
 * Exposes window.ArriboI18n.
 *
 * Static text stays in the HTML in Catalan. An element marked
 * data-i18n="key" (or data-i18n-placeholder / -title / -aria-label) keeps its
 * original Catalan text and takes the Spanish or English entry from STRINGS,
 * so the dictionary needs no Catalan for static text and switching back to
 * Catalan restores the HTML exactly. Text built in JavaScript uses t(key, vars),
 * which needs a Catalan entry too. A missing entry falls back to Catalan, then
 * to the key. Changing language fires "arribo:lang" so pages can redraw.
 */
(function (global) {
  'use strict';

  const LANGS = ['ca', 'es', 'en'];
  const LABELS = { ca: 'CA', es: 'ES', en: 'EN' };
  const STORAGE_KEY = 'arribo_lang';
  const AUTO_DETECT = false;

  const STRINGS = {
    ca: {
      'lang.label': 'Idioma',
      'list.and': 'i',
      'hero.eyebrow.multi': 'Xarxa en directe • {ops}',
      'hero.title.trains': 'Quin bus o tren vols seguir?',
      'hero.title.lines': 'Quina línia vols seguir?',
      'hero.subtitle.buses': '{n} línies de {buses} amb GPS en directe',
      'hero.subtitle.trains': ', i els trens de {trains} al mapa de la xarxa i a la vista de cada línia.',
      'header.pill.multi': 'Catalunya',
      'title.trains': 'Arribo! | Busos i trens en temps real',
      'title.lines': 'Arribo! | Transport públic en temps real',
      'filter.allLines': 'Totes les línies ({n})',
      'common.directions': '{n} sentits',
      'common.inService': 'En servei',
      'common.train': 'Tren',
      'picker.allNetworks': 'Totes les xarxes',
      'picker.headerTitle': 'Explorador de línies',
      'picker.headerSubtitle': '{n} línies de {m} operadors: {ops}',
      'picker.headerSearch': '🔍 Cerca per línia o operador (ex: L1, R1, S2, FGC)...',
      'picker.allLines': 'Totes les línies',
      'picker.noLines': 'Cap línia trobada',
      'picker.noLinesHint': 'Prova amb un altre codi o nom de línia.',
      'landing.linesOne': '{n} línia',
      'landing.linesMany': '{n} línies',
      'landing.stopsOne': '{n} parada',
      'landing.stopsMany': '{n} parades',
      'landing.noResults': 'Cap línia ni parada trobada',
      'landing.noResultsHint': 'No hi ha cap resultat per a "{q}". Prova amb el codi o el nom d\'una línia, o amb el nom d\'una parada.',
      'landing.stopsFound': 'Parades trobades',
      'landing.followLine': 'Fes clic per seguir la línia {code} en directe',
      'landing.seeArrivals': 'Veure arribades a {stop}',
      'landing.codeLabel': 'Codi: #{code}',
      'landing.favCode': 'Codi #{code}',
      'landing.favRemove': 'Treure de preferides',
      'landing.favLoading': 'Carregant arribades en directe...'
    },
    es: {
      'lang.label': 'Idioma',
      'list.and': 'y',
      'hero.eyebrow.single': 'Red urbana • Mataró Bus • Telemetría en tiempo real',
      'hero.title.single': '¿Qué autobús de Mataró quieres seguir?',
      'hero.subtitle.single': 'Busca entre las 8 líneas de Mataró Bus Urbà con GPS en directo, horarios reales y tiempos de espera exactos.',
      'hero.search': 'Busca por línea (ej.: L1, L2, L3, 5, 8) o parada (ej.: Hospital, Rodalies, Tereses)...',
      'hero.planner': 'Cómo llegar',
      'hero.nearby': 'Paradas cercanas',
      'hero.zones': 'Elige zona / barrio',
      'landing.networkMap': 'Mapa de toda la red',
      'landing.favorites': 'Mis paradas favoritas',
      'hero.eyebrow.multi': 'Red en directo • {ops}',
      'hero.title.trains': '¿Qué bus o tren quieres seguir?',
      'hero.title.lines': '¿Qué línea quieres seguir?',
      'hero.subtitle.buses': '{n} líneas de {buses} con GPS en directo',
      'hero.subtitle.trains': ', y los trenes de {trains} en el mapa de la red y en la vista de cada línea.',
      'header.pill.multi': 'Cataluña',
      'title.trains': 'Arribo! | Buses y trenes en tiempo real',
      'title.lines': 'Arribo! | Transporte público en tiempo real',
      'filter.allLines': 'Todas las líneas ({n})',
      'beacon.live': 'En directo',
      'landing.searchClear': 'Borrar búsqueda',
      'hero.plannerTitle': 'Cómo llegar: planifica tu ruta entre dos paradas',
      'hero.nearbyTitle': 'Encuentra las paradas más cercanas con GPS o por barrio',
      'hero.zonesTitle': 'Elige un barrio o zona clave de Mataró',
      'landing.favCountZero': '0 paradas',
      'landing.networkMapLabel': 'Mapa en directo de toda la red',
      'landing.nearbyHeading': 'Paradas cercanas',
      'landing.changeZone': 'Cambiar zona',
      'landing.nearbyClose': 'Cerrar paradas cercanas',
      'common.closeWindow': 'Cerrar ventana',
      'common.close': 'Cerrar',
      'picker.badge': 'Mataró Bus Urbà',
      'picker.title': 'Explorador de líneas de Mataró',
      'picker.subtitle': 'Acceso instantáneo a las 8 líneas de la red urbana (L1 a L8)',
      'picker.search': '🔍 Busca por línea (ej.: L1, L2, L3, 5, 8)...',
      'disruptions.badge': '⚠️ Incidencias en directo',
      'disruptions.title': 'Avisos de servicio y desvíos',
      'disruptions.subtitle': 'Cortes de tráfico, obras y afectaciones oficiales en la red de autobuses',
      'zones.badge': '🏙️ Barrios y zonas de Mataró',
      'zones.title': 'Elige tu zona o barrio',
      'zones.subtitle': 'Consulta al instante las paradas más cercanas y los próximos autobuses',
      'planner.modalTitle': 'Cómo llegar en Mataró',
      'planner.modalSubtitle': 'Busca el mejor trayecto directo o con transbordo entre dos paradas',
      'common.directions': '{n} sentidos',
      'common.inService': 'En servicio',
      'common.train': 'Tren',
      'picker.allNetworks': 'Todas las redes',
      'picker.headerTitle': 'Explorador de líneas',
      'picker.headerSubtitle': '{n} líneas de {m} operadores: {ops}',
      'picker.headerSearch': '🔍 Busca por línea u operador (ej.: L1, R1, S2, FGC)...',
      'picker.allLines': 'Todas las líneas',
      'picker.noLines': 'No se ha encontrado ninguna línea',
      'picker.noLinesHint': 'Prueba con otro código o nombre de línea.',
      'landing.linesOne': '{n} línea',
      'landing.linesMany': '{n} líneas',
      'landing.stopsOne': '{n} parada',
      'landing.stopsMany': '{n} paradas',
      'landing.noResults': 'No se ha encontrado ninguna línea ni parada',
      'landing.noResultsHint': 'No hay resultados para "{q}". Prueba con el código o el nombre de una línea, o con el nombre de una parada.',
      'landing.stopsFound': 'Paradas encontradas',
      'landing.followLine': 'Haz clic para seguir la línea {code} en directo',
      'landing.seeArrivals': 'Ver llegadas a {stop}',
      'landing.codeLabel': 'Código: #{code}',
      'landing.favCode': 'Código #{code}',
      'landing.favRemove': 'Quitar de favoritas',
      'landing.favLoading': 'Cargando llegadas en directo...'
    },
    en: {
      'lang.label': 'Language',
      'list.and': 'and',
      'hero.eyebrow.single': 'Urban network • Mataró Bus • Live telemetry',
      'hero.title.single': 'Which Mataró bus do you want to follow?',
      'hero.subtitle.single': 'Search the 8 Mataró Bus Urbà lines with live GPS, real timetables and exact waiting times.',
      'hero.search': 'Search by line (e.g. L1, L2, L3, 5, 8) or stop (e.g. Hospital, Rodalies, Tereses)...',
      'hero.planner': 'Get there',
      'hero.nearby': 'Nearby stops',
      'hero.zones': 'Pick an area',
      'landing.networkMap': 'Whole network map',
      'landing.favorites': 'My favourite stops',
      'hero.eyebrow.multi': 'Live network • {ops}',
      'hero.title.trains': 'Which bus or train do you want to follow?',
      'hero.title.lines': 'Which line do you want to follow?',
      'hero.subtitle.buses': '{n} {buses} lines with live GPS',
      'hero.subtitle.trains': ', and {trains} trains on the network map and in each line’s view.',
      'header.pill.multi': 'Catalonia',
      'title.trains': 'Arribo! | Live buses and trains',
      'title.lines': 'Arribo! | Live public transport',
      'filter.allLines': 'All lines ({n})',
      'beacon.live': 'Live',
      'landing.searchClear': 'Clear search',
      'hero.plannerTitle': 'Get there: plan your route between two stops',
      'hero.nearbyTitle': 'Find the nearest stops by GPS or by neighbourhood',
      'hero.zonesTitle': 'Pick a key neighbourhood or area of Mataró',
      'landing.favCountZero': '0 stops',
      'landing.networkMapLabel': 'Live map of the whole network',
      'landing.nearbyHeading': 'Nearby stops',
      'landing.changeZone': 'Change area',
      'landing.nearbyClose': 'Close nearby stops',
      'common.closeWindow': 'Close window',
      'common.close': 'Close',
      'picker.badge': 'Mataró Bus Urbà',
      'picker.title': 'Mataró line explorer',
      'picker.subtitle': 'Instant access to the 8 lines of the urban network (L1 to L8)',
      'picker.search': '🔍 Search by line (e.g. L1, L2, L3, 5, 8)...',
      'disruptions.badge': '⚠️ Live incidents',
      'disruptions.title': 'Service alerts and diversions',
      'disruptions.subtitle': 'Road closures, roadworks and official disruptions on the bus network',
      'zones.badge': '🏙️ Mataró neighbourhoods and areas',
      'zones.title': 'Pick your area or neighbourhood',
      'zones.subtitle': 'Instantly see the nearest stops and the next buses',
      'planner.modalTitle': 'Get around Mataró',
      'planner.modalSubtitle': 'Find the best direct or one-transfer journey between two stops',
      'common.directions': '{n} directions',
      'common.inService': 'In service',
      'common.train': 'Train',
      'picker.allNetworks': 'All networks',
      'picker.headerTitle': 'Line explorer',
      'picker.headerSubtitle': '{n} lines from {m} operators: {ops}',
      'picker.headerSearch': '🔍 Search by line or operator (e.g. L1, R1, S2, FGC)...',
      'picker.allLines': 'All lines',
      'picker.noLines': 'No lines found',
      'picker.noLinesHint': 'Try another line code or name.',
      'landing.linesOne': '{n} line',
      'landing.linesMany': '{n} lines',
      'landing.stopsOne': '{n} stop',
      'landing.stopsMany': '{n} stops',
      'landing.noResults': 'No lines or stops found',
      'landing.noResultsHint': 'No results for "{q}". Try a line code or name, or a stop name.',
      'landing.stopsFound': 'Stops found',
      'landing.followLine': 'Click to follow line {code} live',
      'landing.seeArrivals': 'See arrivals at {stop}',
      'landing.codeLabel': 'Code: #{code}',
      'landing.favCode': 'Code #{code}',
      'landing.favRemove': 'Remove from favourites',
      'landing.favLoading': 'Loading live arrivals...'
    }
  };

  function initialLang() {
    try {
      const saved = global.localStorage?.getItem(STORAGE_KEY);
      if (LANGS.includes(saved)) return saved;
    } catch { /* storage unavailable: default */ }
    // Only part of the interface is translated so far, so the browser language
    // is not used yet (it would mix languages on one screen): Catalan until the
    // visitor picks another. Set AUTO_DETECT once every screen has its strings.
    if (AUTO_DETECT) {
      for (const l of global.navigator?.languages || [global.navigator?.language || '']) {
        const base = String(l || '').toLowerCase().split('-')[0];
        if (LANGS.includes(base)) return base;
      }
    }
    return 'ca';
  }

  let lang = initialLang();

  // [data attribute holding the key, element property it fills]
  const TARGETS = [
    ['i18n', 'textContent'],
    ['i18nPlaceholder', 'placeholder'],
    ['i18nTitle', 'title'],
    ['i18nAriaLabel', 'aria-label']
  ];

  const I18n = {
    langs: LANGS,
    get lang() { return lang; },

    /** The string for key in the current language, with {name} filled from vars. */
    t(key, vars) {
      const s = STRINGS[lang]?.[key] ?? STRINGS.ca[key] ?? key;
      return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : s;
    },

    /** "a", "a i b", "a, b i c" in the current language. */
    list(items) {
      const xs = items.filter(Boolean);
      if (xs.length <= 1) return xs[0] || '';
      return `${xs.slice(0, -1).join(', ')} ${I18n.t('list.and')} ${xs[xs.length - 1]}`;
    },

    /** Fills every marked element under root; Catalan restores the original HTML text. */
    apply(root = global.document) {
      if (!root) return;
      for (const [attr, prop] of TARGETS) {
        const sel = `[data-${attr.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}]`;
        root.querySelectorAll(sel).forEach(el => {
          const key = el.dataset[attr];
          const read = () => (prop === 'aria-label' ? el.getAttribute('aria-label') : el[prop]);
          const write = v => { if (prop === 'aria-label') el.setAttribute('aria-label', v); else el[prop] = v; };
          const origKey = `${attr}Ca`;
          if (el.dataset[origKey] === undefined) el.dataset[origKey] = read() ?? '';
          const value = lang === 'ca' ? el.dataset[origKey] : (STRINGS[lang]?.[key] ?? el.dataset[origKey]);
          if (read() !== value) write(value);
        });
      }
      if (global.document) global.document.documentElement.lang = lang;
    },

    setLang(next) {
      if (!LANGS.includes(next) || next === lang) return;
      lang = next;
      try { global.localStorage?.setItem(STORAGE_KEY, next); } catch { /* keep it for this page only */ }
      I18n.apply();
      I18n.mountPickers();
      global.document?.dispatchEvent(new CustomEvent('arribo:lang', { detail: { lang } }));
    },

    /** Fills every <select data-lang-picker> with the languages and wires it. */
    mountPickers() {
      global.document?.querySelectorAll('select[data-lang-picker]').forEach(sel => {
        if (!sel.options.length) {
          sel.innerHTML = LANGS.map(l => `<option value="${l}">${LABELS[l]}</option>`).join('');
          sel.addEventListener('change', () => I18n.setLang(sel.value));
        }
        sel.value = lang;
        sel.setAttribute('aria-label', I18n.t('lang.label'));
        sel.title = I18n.t('lang.label');
      });
    }
  };

  global.ArriboI18n = I18n;
  const start = () => { I18n.apply(); I18n.mountPickers(); };
  if (global.document?.readyState === 'loading') global.document.addEventListener('DOMContentLoaded', start);
  else start();
})(window);
