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
            try { localStorage.setItem(THEME_STORAGE_KEY, legacy); } catch (_) {}
            return legacy;
          }
        }
      } catch (_) {}
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
      } catch (_) {}
      if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.setAttribute('data-theme', theme);
      }
    }
  };

  // Prevent external tampering
  global.TransitUtils = Object.freeze(TransitUtils);
})(typeof window !== 'undefined' ? window : globalThis);
