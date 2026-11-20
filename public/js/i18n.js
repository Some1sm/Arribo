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
      'filter.allLines': 'Totes les línies ({n})'
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
      'filter.allLines': 'Todas las líneas ({n})'
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
      'filter.allLines': 'All lines ({n})'
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
