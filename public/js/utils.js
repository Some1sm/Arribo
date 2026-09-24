/**
 * Shared Client Utilities for Arribo! Transit Platform
 * Exposes window.TransitUtils for zero-dependency browser consumption.
 */
(function(global) {
  'use strict';

  const THEME_STORAGE_KEY = 'arribo_theme';
  const LEGACY_THEME_KEYS = ['bad_amb_theme', 'transit-theme'];

  const TransitUtils = {
    THEME_STORAGE_KEY,

    freshness(item, now = Date.now(), offline = global.navigator?.onLine === false) {
      const f = item?.freshness;
      const source = f?.source || (item?.isRealTime ? 'live' : item?.isEstimated ? 'position' : 'timetable');
      const fetched = f?.fetchedAt;
      const observed = f?.observedAt;
      const valid = t => Number.isFinite(t) && t > 0 && t <= now + 60000;
      const timestamp = valid(fetched) ? (valid(observed) ? Math.min(fetched, observed) : fetched) : null;
      const age = timestamp === null ? null : Math.max(0, now - timestamp);
      const stale = source !== 'timetable' && (offline || age === null || age > 60000 || f?.fallback === true);
      const ageText = age === null ? 'actualització desconeguda' : age < 60000 ? `fa ${Math.floor(age / 1000)} s` : `fa ${Math.floor(age / 60000)} min`;
      const label = source === 'timetable' ? 'Horari programat' : stale ? 'Última previsió coneguda' : source === 'position' ? 'Estimació de posició' : 'En directe';
      return { source, stale, age, label: `${offline ? 'Sense connexió · ' : ''}${label}${source === 'timetable' ? '' : ` · ${ageText}`}` };
    },

    /**
     * HTML-escapes an upstream/user-derived string so it can never break out of
     * its element context when interpolated into innerHTML templates.
     * @param {*} value
     * @returns {string}
     */
    esc(value) {
      if (value === null || value === undefined) return '';
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },

    /**
     * Picks black or white text for a saturated line-colour chip.
     *
     * Line chips are white-on-brand by convention, but several Mataró line
     * colours are far too light for that: L7 cyan measured 1.19:1, L5 green
     * 1.64:1 and L6 amber 1.66:1 against #fff. The previous inline guard only
     * special-cased two exact yellows, so every other pale line stayed
     * illegible. This compares real WCAG relative luminance for both inks and
     * returns whichever actually wins, so the chip stays brand-coloured while
     * the label stays readable in either theme.
     *
     * Returns null for anything that is not a literal hex (getLineColor can
     * return `var(--brand-primary)`), so callers can keep their own fallback
     * rather than silently getting black on an unknown colour.
     */
    chipTextColor(bg) {
      if (typeof bg !== 'string') return null;
      const hex = bg.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
      if (!hex) return null;
      let h = hex[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      const channel = i => {
        const v = parseInt(h.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      const lum = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
      // Contrast against white vs against black, same +0.05 floor as WCAG.
      const onWhite = 1.05 / (lum + 0.05);
      const onBlack = (lum + 0.05) / 0.05;
      return onBlack >= onWhite ? '#000' : '#fff';
    },

    /**
     * Shows which published timetable grid is loaded, in the page header.
     *
     * The operator runs a genuinely different grid in summer. The file that
     * used to ship here held a MIXTURE of the two — L1/L2/L4/L6/L8 were winter
     * outbound and summer inbound — so a rider saw correct times one way and
     * wrong times back, and nothing on screen said why. Putting the season in
     * the header makes that class of mistake visible in the product rather than
     * only in a server log.
     *
     * When the server cannot vouch for the date (`seasonKnown: false`) the pill
     * is marked unverified rather than shown as authoritative: outside the
     * period the data covers we are guessing, and saying so is the point.
     *
     * Best-effort by design. A failed fetch leaves the pill hidden; this is
     * provenance, not something the page can fail to render without.
     *
     * @param {string} [id='header-season-pill'] element id of the pill
     * @returns {Promise<{season:string, known:boolean}|null>}
     */
    async showSeasonPill(id = 'header-season-pill') {
      const pill = document.getElementById(id);
      if (!pill) return null;
      try {
        const res = await fetch('/api/health', { headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        const data = await res.json();
        const schedule = data?.schedule;
        if (!schedule?.season) return null;

        const known = schedule.seasonKnown !== false;
        const label = schedule.season === 'summer' ? 'Estiu' : 'Hivern';
        pill.textContent = known ? label : `${label}?`;
        pill.hidden = false;
        // The tooltip carries the provenance: which grid, chosen how, and
        // whether the server considers the date covered.
        pill.title = [
          `Horari en vigor: ${label}`,
          `Font: ${schedule.seasonSource || 'desconeguda'}`,
          known ? null : 'Fora del període cobert per les dades: horari no verificat'
        ].filter(Boolean).join(' · ');
        if (!known) pill.classList.add('is-unverified');
        return { season: schedule.season, known };
      } catch {
        return null;
      }
    },

    /**
     * Haversine distance formula between two GPS coordinate points in metres.
     * @param {number} lat1
     * @param {number} lon1
     * @param {number} lat2
     * @param {number} lon2
     * @returns {number} Distance in meters
     */
    calcDistMeters(lat1, lon1, lat2, lon2) {
      if (typeof lat1 !== 'number' || typeof lon1 !== 'number' ||
          typeof lat2 !== 'number' || typeof lon2 !== 'number') {
        return NaN;
      }
      const R = 6371000;
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLon / 2) * Math.sin(dLon / 2);
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    },
    /**
     * Parses 'HH:MM' string to seconds since midnight.
     * @param {string} timeStr
     * @returns {number}
     */
    timeStringToSeconds(timeStr) {
      if (!timeStr || typeof timeStr !== 'string' || !timeStr.includes(':')) return 0;
      const [h, m] = timeStr.split(':').map(Number);
      return (isNaN(h) || isNaN(m)) ? 0 : (h * 3600 + m * 60);
    },

    /**
     * Strips seconds from a time string (e.g. '11:53:00' -> '11:53').
     * @param {string} timeStr
     * @returns {string}
     */
    formatTimeHHMM(timeStr) {
      if (!timeStr || typeof timeStr !== 'string') return timeStr || '--:--';
      return timeStr.replace(/^(\d{1,2}:\d{2}):\d{2}$/, '$1');
    },

    /**
     * Creates a debounced function that delays invoking fn until after
     * delayMs milliseconds have elapsed since the last time it was invoked.
     * @param {Function} fn
     * @param {number} delayMs
     * @returns {Function}
     */
    debounce(fn, delayMs = 250) {
      let timer = null;
      return function(...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          fn.apply(this, args);
        }, delayMs);
      };
    },

    /**
     * Reads the current theme preference from unified localStorage,
     * migrating legacy keys if necessary, or falling back to system preference.
     * @returns {'light'|'dark'}
     */
    getStoredTheme() {
      try {
        const stored = localStorage.getItem(THEME_STORAGE_KEY);
        if (stored === 'light' || stored === 'dark') return stored;
        for (const legacyKey of LEGACY_THEME_KEYS) {
          const legacy = localStorage.getItem(legacyKey);
          if (legacy === 'light' || legacy === 'dark') {
            try { localStorage.setItem(THEME_STORAGE_KEY, legacy); } catch {}
            return legacy;
          }
        }
      } catch {}
      if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
        return 'light';
      }
      return 'dark';
    },

    /**
     * Sets and persists the theme preference uniformly across all pages.
     * @param {'light'|'dark'} theme
     */
    setStoredTheme(theme) {
      if (theme !== 'light' && theme !== 'dark') return;
      try {
        localStorage.setItem(THEME_STORAGE_KEY, theme);
        for (const legacyKey of LEGACY_THEME_KEYS) {
          localStorage.setItem(legacyKey, theme);
        }
      } catch {}
      if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.setAttribute('data-theme', theme);
      }
    }
  };

  // Prevent external tampering
  global.TransitUtils = Object.freeze(TransitUtils);
})(typeof window !== 'undefined' ? window : globalThis);
